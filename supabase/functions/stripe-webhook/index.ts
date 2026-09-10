import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@13.6.0?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// This endpoint is the only thing in the system that can move an account off
// `free`, and until now every way it could fail was silent. A payment went
// through, the plan never moved, Stripe was told 200 so it never retried, and
// nothing anywhere recorded that it had happened. The user's experience of the
// bug was "I paid and it still says free"; the log's experience of it was
// nothing at all.
//
// Nothing here runs today — the Stripe account was closed as a prohibited
// business, so no delivery has arrived since May and none will until a
// processor is wired up again. That is exactly why it was worth fixing now:
// there is no traffic to endanger, and every one of these faults would
// otherwise be discovered by the first paying customer.
//
// The API version pinned where the Stripe client is constructed (inside the
// handler, further down) is deliberately NOT touched. The endpoint is
// registered in the dashboard at a much newer version, and the body of every
// event this file reads is assembled by the ENDPOINT's version, not by this
// one — so changing either half moves field positions on the other. Stripe's
// documentation is unreachable from the environment this was fixed in, so the
// choice was between recording the mismatch and guessing at it. It is recorded
// in docs/PAYMENTS_SETUP.md §1.7 and stays UNVERIFIED until somebody opens one
// real delivery in the dashboard and reads it. src/test/payments.test.ts pins
// the literal across all three payment functions so that a bump has to be a
// deliberate act rather than a side effect of tidying.
const JSON_HEADERS = { "Content-Type": "application/json" };

// The secrets without which this function cannot do anything at all, checked
// per request before the first one of them is USED.
//
// The previous shape of these four reads was
//
//   const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, ...);
//   const WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET")!;
//   const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
//
// at module scope, and the `!` there is a TYPE assertion with no runtime
// meaning whatsoever: `Deno.env.get` still returns `undefined`, and the value
// travels on. Two distinct failures came out of that, and both of them are the
// exact failure `buildPriceMap` below was moved per-request to avoid — the
// reasoning was applied to the three price secrets and not to the four sitting
// beside them.
//
//   * `createClient(undefined, undefined)` THROWS at module load
//     ("supabaseUrl is required."). A module that throws while loading answers
//     every delivery with a bare 500 carrying no body and no reason, which is
//     the least diagnosable outcome available.
//
//   * A missing STRIPE_WEBHOOK_SECRET was worse than undiagnosable, it was
//     MISdiagnosed. `constructEventAsync(body, signature, undefined)` throws,
//     the catch below reports that as `signature_verification_failed`, and
//     that path answers 400 — so an operator who has simply not set the secret
//     yet is told "this request is not from Stripe", and Stripe, being told
//     400, never retries. Setting a secret is the single most fixable
//     condition there is; it belongs on the retry side of the line, and the
//     400 must stay reserved for a body that genuinely will not verify.
//
// Names only in the response and the log. The values are secrets and never
// appear anywhere.
const REQUIRED_ENV_VARS: ReadonlyArray<string> = [
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
];

function missingEnvVars(names: ReadonlyArray<string>): string[] {
  return names.filter((name) => (Deno.env.get(name) ?? "").trim() === "");
}

// The metadata key that says which account bought the subscription.
//
// This one key was the reason a completed checkout never upgraded anybody.
// create-checkout wrote `supabase_user_id`; this file read `user_id`. The read
// was `undefined` on every single delivery, so `if (userId && ...)` skipped the
// whole branch, `profiles.plan` and `stripe_subscription_id` were never
// written, and the handler still returned 200. Two halves of one feature, one
// typo apart, with no test and no log line between them.
//
// `supabase_user_id` is the surviving spelling because the WRITER already sends
// it: any Stripe customer or session created before this fix carries that key,
// and one of those sessions can still complete after it. Renaming the writer to
// `user_id` instead would have been the same amount of work and would have
// orphaned every object already out there.
const USER_ID_METADATA_KEY = "supabase_user_id";

// ...and the reader still accepts the old spelling. Not out of symmetry — the
// writer never emits it, so this tolerance is one-way and cannot drift back
// into a second convention. It is here because a checkout session can be
// created by something that is not create-checkout: a payment link made by hand
// in the dashboard, a support agent's session, an older deploy. Accepting both
// costs one `??` and closes an entire class of "paid but not upgraded".
const LEGACY_USER_ID_METADATA_KEY = "user_id";

// Whatever came out of that metadata still has to look like a profile id
// before it is used as one.
//
// `user_id` is about as generic a metadata key as exists, and the whole reason
// the legacy spelling is tolerated is that the session may have been created by
// something outside this codebase — a dashboard payment link, a support tool, a
// CRM. Those are exactly the places that put a CRM record id, an internal
// integer, or an email address in a field called `user_id`. Feeding one of
// those straight into `.eq("id", value)` does not fail politely: `profiles.id`
// is a uuid, PostgREST rejects a non-uuid comparison outright (22P02, invalid
// input syntax), the write comes back as an error, and the handler answers 5xx.
// That means three days of Stripe backoff spent on an input that cannot ever
// succeed — while the same session was carrying a perfectly good customer id
// that the code refused to fall back to, because the garbage value was truthy.
//
// So the metadata is a HINT that has to pass a shape check, and the
// authoritative link stays `stripe_customer_id`, which Stripe itself issued and
// create-checkout itself stored. A value that is not a uuid is logged and
// dropped, and the customer-id route below carries the delivery instead.
const PROFILE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function profileIdOrNull(value: unknown): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return PROFILE_ID_PATTERN.test(trimmed) ? trimmed : null;
}

// Subscription states from which no plan may ever be granted.
//
// This is the guard for the hazard that returning 5xx creates. Asking Stripe to
// retry is right — a payment that silently never applied is the fault this file
// exists to fix — but a retry can land up to three days later, and until now
// nothing in the `customer.subscription.updated` branch asked whether the
// subscription was still alive by the time the retry arrived. The sequence is
// short and entirely reachable:
//
//   1. a renewal fires `updated`, the write fails (or a price secret is not set
//      yet), the handler answers 500, and Stripe starts retrying;
//   2. the user cancels; `deleted` arrives, succeeds, and sets the row to the
//      unpaid plan with no subscription id;
//   3. a retry of step 1 lands, matches the same customer, and writes the paid
//      plan back.
//
// The user then holds a paid plan with no subscription, and the only event that
// could have taken it away has already been consumed. Before the 5xx change
// this was unreachable, because step 1 returned 200 and nothing was ever
// retried — so the fix for one silent failure opened a louder one.
//
// The mitigation is to stop trusting the event's own snapshot of the
// subscription and re-read the subscription from Stripe, then refuse to grant
// anything on one that has reached a terminal state. A retry three days late
// then reads `canceled` and does nothing, instead of resurrecting a plan.
//
// Rejected: a ledger of processed event ids. Both events in that sequence are
// genuinely new, so a dedupe table waves them both through and only makes the
// hazard look handled. Also rejected: requiring the profile's recorded
// `stripe_subscription_id` to equal this subscription's id. It would close a
// second, narrower ordering hazard as well (see docs/PAYMENTS_SETUP.md §1.15),
// but it silently ignores every legitimate update for a subscription this app
// never recorded — a dashboard-created one, for instance — and that is a policy
// choice for the owner rather than a defect fix.
//
// Note what is deliberately NOT in this set: `past_due`, `unpaid` and
// `incomplete`. Dunning is Stripe's business, and a subscription still being
// collected on must not lose its plan halfway through. `incomplete` — a first
// payment that has not confirmed yet — is the one genuinely unsettled case, and
// it is recorded as UNVERIFIED in docs/PAYMENTS_SETUP.md §1.14 rather than
// guessed at from an environment that cannot reach Stripe's documentation.
const TERMINAL_SUBSCRIPTION_STATUSES: ReadonlySet<string> = new Set([
  "canceled",
  "incomplete_expired",
]);

// Which secret carries which plan's price id. The plan strings are constrained
// by the profiles_plan_check constraint to free/light/standard/pro; a fourth
// value would be rejected by the database, so this list is the whole vocabulary.
const PRICE_ENV_VARS: ReadonlyArray<readonly [string, string]> = [
  ["STRIPE_PRICE_LIGHT", "light"],
  ["STRIPE_PRICE_STANDARD", "standard"],
  ["STRIPE_PRICE_PRO", "pro"],
];

interface PriceMap {
  plans: Map<string, string>;
  // Names only — never values. The values are secrets.
  missing: string[];
}

// Built one entry at a time, because the object literal this replaces collapsed
// when the secrets were absent:
//
//   const PRICE_TO_PLAN = {
//     [Deno.env.get("STRIPE_PRICE_LIGHT") || ""]: "light",
//     [Deno.env.get("STRIPE_PRICE_STANDARD") || ""]: "standard",
//     [Deno.env.get("STRIPE_PRICE_PRO") || ""]: "pro",
//   };
//
// With all three unset, the three computed keys are the SAME empty string, so
// the map held exactly one entry — "" -> "pro", whichever line was written last
// — and no real price id ever matched it. Partially set was worse than not set
// at all: two plans resolved correctly and the third silently shared the ""
// key, which looks like a working map right up until one customer buys the
// wrong tier.
//
// Unset vars are skipped instead of being mapped, and their NAMES are carried
// out so a failing request can say which secret is absent instead of leaving
// the operator to guess. A Map rather than a plain object, so that a price id
// that happens to spell `constructor` or `toString` cannot resolve to something
// off the prototype chain.
function buildPriceMap(): PriceMap {
  const plans = new Map<string, string>();
  const missing: string[] = [];
  for (const [envVar, plan] of PRICE_ENV_VARS) {
    const priceId = (Deno.env.get(envVar) ?? "").trim();
    if (priceId === "") {
      missing.push(envVar);
      continue;
    }
    plans.set(priceId, plan);
  }
  return { plans, missing };
}

// Stripe expands some fields into objects depending on the request; take the id
// either way rather than assuming the string form.
function idOf(value: string | { id: string } | null | undefined): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && typeof value.id === "string") return value.id;
  return null;
}

// One log line per delivery, whatever happens, carrying the event id.
//
// Stripe's dashboard identifies a delivery by `evt_...` and nothing else, so
// without the id in the log there is no way to get from "this delivery failed"
// to "here is what the function did about it". The old handler logged the event
// TYPE only, which is the one field that is already visible in the dashboard.
//
// On idempotency, honestly: these writes need no dedupe table. Every one of
// them is an absolute assignment (plan := light, stripe_subscription_id := sub_…
// or null) keyed on a stable identifier, so replaying THE SAME delivery produces
// the same row state as the first attempt — which is what makes returning 5xx
// and letting Stripe retry safe in the first place. That is a narrower claim
// than it first reads as, and the difference matters: the dangerous replay is
// not the same event twice, it is an OLD event landing on top of newer state,
// and a ledger of event ids has nothing to say about that because every event
// involved is genuinely new. The re-read of the subscription in the two
// granting branches is what actually addresses it; the remaining case is
// recorded in docs/PAYMENTS_SETUP.md §1.15. Recording the outcome per event is
// what makes such a sequence readable afterwards; a ledger would only have made
// it look handled.
function logOutcome(event: Stripe.Event, outcome: string, detail: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event_id: event.id, type: event.type, outcome, ...detail }));
}

// 200: Stripe stops. Only for deliveries that are genuinely finished.
function accept(event: Stripe.Event, outcome: string, detail: Record<string, unknown> = {}): Response {
  logOutcome(event, outcome, detail);
  return new Response(JSON.stringify({ received: true, outcome }), { status: 200, headers: JSON_HEADERS });
}

// 5xx: Stripe retries, with backoff, for about three days.
//
// This is the fix for the worst of the silent failures. The old handler did
// `if (error) console.error(...)` and then returned `{ received: true }` — so a
// failed database write ended with the payment collected, the plan unmoved, and
// Stripe convinced it had delivered successfully. There was no second chance
// and no durable record; the console line aged out.
//
// Retrying is only worth asking for when a retry could plausibly land, so this
// is reserved for transient or fixable conditions: the database refused the
// write, a secret is missing (someone can set it inside the retry window), or
// the profile row has not been linked yet. A signature failure is emphatically
// NOT one of these — see the 400 below. Neither is a price id that the map is
// fully configured to answer for and simply does not recognise; that one is
// split out at its call sites, because no retry can teach the map a price it
// was never given.
//
// The two detail arguments are not decoration. `detail` goes to the log and
// nowhere else; `publicDetail` is the only thing allowed into the response
// body, because Stripe STORES response bodies against the delivery and shows
// them in its dashboard. Postgres error text routinely quotes the offending
// value, so returning `error.message` — which this did — exported row content
// into a third party's UI for no diagnostic gain that the log line did not
// already provide. Environment variable NAMES are the deliberate exception:
// they are not secrets, they are the single most useful thing an operator
// staring at a failed delivery can be told, and telling them is the whole point
// of the price-map fix.
function retryable(
  event: Stripe.Event,
  outcome: string,
  detail: Record<string, unknown> = {},
  publicDetail: Record<string, unknown> = {},
): Response {
  console.error(JSON.stringify({ event_id: event.id, type: event.type, outcome, ...detail, ...publicDetail }));
  return new Response(JSON.stringify({ error: outcome, ...publicDetail }), { status: 500, headers: JSON_HEADERS });
}

interface WriteResult {
  ok: boolean;
  outcome: string;
  detail: Record<string, unknown>;
}

type Supabase = ReturnType<typeof createClient>;

// Every write goes through here so that no caller can forget to look at the
// result — forgetting to look was the bug.
//
// `.select("id")` is what makes "the update succeeded" mean something. Postgres
// reports an UPDATE that matched zero rows as a success, so a write aimed at a
// profile that does not carry this customer id yet would otherwise be
// indistinguishable from one that upgraded somebody. Asking for the rows back
// costs nothing and turns that into a fact the caller can act on.
//
// `rows` travels out with every result and every caller puts it in its log
// line, because more than one row is also a fact worth having: nothing in the
// schema stops two profiles carrying the same `stripe_customer_id` — the column
// has an index, not a unique constraint — and if that ever happens, one payment
// upgrades both of them. That cannot be fixed from this file (it wants a
// constraint, and migrations are out of scope here), so the least this can do is
// make it visible in the log instead of counting it as an ordinary success.
async function writeProfile(
  supabase: Supabase,
  match: { column: string; value: string },
  patch: Record<string, unknown>,
): Promise<WriteResult> {
  const { data, error } = await supabase
    .from("profiles")
    .update(patch)
    .eq(match.column, match.value)
    .select("id");

  if (error) {
    return { ok: false, outcome: "db_update_failed", detail: { db_error: error.message, matched_on: match.column } };
  }
  const rows = data?.length ?? 0;
  if (rows === 0) {
    return { ok: false, outcome: "no_profile_matched", detail: { matched_on: match.column } };
  }
  return { ok: true, outcome: "profile_updated", detail: { rows, matched_on: match.column } };
}

serve(async (req) => {
  const body = await req.text();
  const signature = req.headers.get("stripe-signature");

  // Before anything is constructed or verified: is this deployment configured
  // at all? See the long note on REQUIRED_ENV_VARS. This has to run ahead of
  // `constructEventAsync`, because an absent signing secret makes that call
  // throw and the catch below would report a configuration fault as a forged
  // request, at 400, with no retry.
  const missingSecrets = missingEnvVars(REQUIRED_ENV_VARS);
  if (missingSecrets.length > 0) {
    console.error(JSON.stringify({
      event_id: null,
      type: null,
      outcome: "missing_required_env",
      missing: missingSecrets,
    }));
    return new Response(
      JSON.stringify({ error: "missing_required_env", missing: missingSecrets }),
      { status: 500, headers: JSON_HEADERS },
    );
  }

  // Constructed per request rather than at module load, for the same reason the
  // price map is: a client built from an absent variable throws, and a throw at
  // load time is a 500 with nothing in it. Building them here costs four env
  // lookups and means setting a secret takes effect on the next delivery rather
  // than on the next cold start.
  const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, { apiVersion: "2023-10-16" });
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      body,
      signature ?? "",
      Deno.env.get("STRIPE_WEBHOOK_SECRET")!,
    );
  } catch (err) {
    // 400, and it has to STAY 400 while everything below moved to 5xx. A body
    // that does not verify against the signing secret will not verify on the
    // fifth attempt either: either it is not from Stripe, or STRIPE_WEBHOOK_SECRET
    // belongs to a different endpoint. Asking Stripe to retry it would spend
    // three days of backoff on a request that cannot succeed and would bury the
    // real retries — the ones below — in the same failure count.
    //
    // The one case that used to be misfiled here — the secret not being set at
    // all — is caught above and answered 5xx, where it belongs.
    console.error(JSON.stringify({
      event_id: null,
      type: null,
      outcome: "signature_verification_failed",
      message: (err as Error).message,
    }));
    return new Response(
      JSON.stringify({ error: "signature_verification_failed", message: (err as Error).message }),
      { status: 400, headers: JSON_HEADERS },
    );
  }

  try {
    // Built per request, not once at module load. Throwing at load time would
    // make an unconfigured deployment answer every delivery with a bare 500
    // carrying no body and no reason — the operator would see "failed" in the
    // Stripe dashboard and have nothing to act on. Building it here costs three
    // env lookups, lets a failure name the missing secret, and means setting
    // that secret takes effect on the next request rather than the next cold
    // start.
    const { plans, missing } = buildPriceMap();

    // Two different situations wear the same name, and they need opposite
    // answers. This decides which one a `!plan` is.
    //
    // The first version of this fix returned 5xx for both, and that was wrong in
    // a way that is worse than the bug it replaced. When the map is COMPLETE and
    // the price is simply not one of ours — an archived price, a grandfathered
    // one, a second product, an add-on line item — no retry can ever succeed,
    // so every delivery for that subscription fails for the full three-day
    // backoff, forever, on every renewal. Stripe notifies on and eventually
    // DISABLES an endpoint that keeps failing, and a disabled endpoint stops
    // every grant and every revocation for everybody: a strictly larger blast
    // radius than the `|| "free"` line this whole branch replaced.
    //
    // When a price secret is genuinely absent, a retry is exactly right: an
    // operator can set it inside the window and the delivery lands.
    //
    // Either way the row is left alone, which is what the fix actually required.
    // The difference is only in what Stripe is asked to do about it.
    const unknownPrice = (priceId: string | null): Response => {
      const detail = { price_id: priceId };
      if (missing.length > 0) {
        return retryable(event, "unknown_price_id", detail, { missing_price_env: missing });
      }
      console.error(JSON.stringify({
        event_id: event.id,
        type: event.type,
        outcome: "unknown_price_id_not_retryable",
        ...detail,
      }));
      return accept(event, "unknown_price_id_not_retryable", detail);
    };

    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;
      const metadata = session.metadata ?? {};
      const rawUserId = metadata[USER_ID_METADATA_KEY] ?? metadata[LEGACY_USER_ID_METADATA_KEY] ?? null;
      const userId = profileIdOrNull(rawUserId);
      const customerId = idOf(session.customer);
      const subscriptionId = idOf(session.subscription);

      // A session carrying something in the metadata that is not a profile id is
      // not fatal — the customer id below is the authoritative link — but it is
      // worth saying out loud, because it means somebody is creating sessions
      // with a convention this file does not share.
      if (rawUserId && !userId) {
        console.error(JSON.stringify({
          event_id: event.id,
          type: event.type,
          outcome: "metadata_user_id_not_a_profile_id",
          metadata_keys: Object.keys(metadata),
        }));
      }

      // A completed session with no subscription is a one-off payment or a
      // setup-mode session. Nothing here grants a plan for those, and saying so
      // is better than falling through to the generic "ignored" at the bottom.
      if (!subscriptionId) return accept(event, "ignored_no_subscription");

      // Neither route to a profile row. Retryable rather than accepted: this is
      // the shape the original bug produced on every delivery, and it must be
      // loud enough that nobody has to notice it from a support ticket.
      if (!userId && !customerId) {
        return retryable(event, "unidentifiable_session", { metadata_keys: Object.keys(metadata) });
      }

      const sub = await stripe.subscriptions.retrieve(subscriptionId);

      // Never grant on a subscription that is already over. See
      // TERMINAL_SUBSCRIPTION_STATUSES: this is a retried or replayed delivery
      // landing after the subscription it describes has ended.
      if (TERMINAL_SUBSCRIPTION_STATUSES.has(sub.status)) {
        return accept(event, "ignored_subscription_not_live", { subscription_status: sub.status });
      }

      const priceId = sub.items.data[0]?.price?.id ?? null;
      const plan = priceId ? plans.get(priceId) : undefined;

      // An unrecognised price id NEVER writes a plan. See the long note in the
      // `customer.subscription.updated` branch below for why `|| "free"` was
      // the most dangerous line in this file.
      if (!plan) return unknownPrice(priceId);

      const patch: Record<string, unknown> = { plan, stripe_subscription_id: subscriptionId };
      // Only write the customer id when there is one. Writing `null` here would
      // erase a link that create-checkout had already established and leave the
      // subscription branches with nothing to match on later.
      if (customerId) patch.stripe_customer_id = customerId;

      // Match on the user id when the metadata carried one that looks like a
      // profile id, since that is exact. Fall back to the customer id — the same
      // key the other two branches use — so that a session created outside
      // create-checkout can still land.
      const match = userId
        ? { column: "id", value: userId }
        : { column: "stripe_customer_id", value: customerId! };

      const result = await writeProfile(supabase, match, patch);
      if (!result.ok) return retryable(event, result.outcome, { ...result.detail, plan });
      return accept(event, "plan_granted", { plan, ...result.detail });
    }

    if (event.type === "customer.subscription.deleted") {
      const sub = event.data.object as Stripe.Subscription;
      const customerId = idOf(sub.customer);
      if (!customerId) return retryable(event, "unidentifiable_subscription");

      // The ONLY place in this file that may write "free". A downgrade is a
      // consequence of a subscription actually ending, never of a lookup that
      // came back empty.
      const result = await writeProfile(
        supabase,
        { column: "stripe_customer_id", value: customerId },
        { plan: "free", stripe_subscription_id: null },
      );

      // Matching nothing here is not the same failure as matching nothing on a
      // purchase. Nobody is left holding a plan they stopped paying for: if no
      // profile carries this customer id, there is no row granting anything.
      // The routine cause is a profile that no longer exists, which no number
      // of retries will bring back — so this is logged loudly and accepted
      // rather than spending three days of backoff on it.
      if (!result.ok && result.outcome === "no_profile_matched") {
        console.error(JSON.stringify({
          event_id: event.id,
          type: event.type,
          outcome: "downgrade_matched_no_profile",
          customer_id: customerId,
        }));
        return accept(event, "downgrade_matched_no_profile");
      }
      if (!result.ok) return retryable(event, result.outcome);
      return accept(event, "plan_revoked", result.detail);
    }

    if (event.type === "customer.subscription.updated") {
      // Re-read rather than trusting `event.data.object`, for two reasons that
      // happen to want the same line.
      //
      // The first is staleness: this delivery may be a retry that has been
      // backing off for up to three days, and the snapshot in its body says what
      // was true when it was created, not what is true now. Acting on the
      // snapshot is how a cancelled subscription gets its plan handed back — see
      // TERMINAL_SUBSCRIPTION_STATUSES.
      //
      // The second is the version skew recorded in docs/PAYMENTS_SETUP.md §1.7.
      // The event body is assembled by the ENDPOINT's registered API version,
      // which is much newer than the SDK pinned here, so `items.data[0].price.id`
      // read off the body is read against a shape nobody has verified; if that
      // read comes back null, every renewal turns into an unknown price and no
      // plan change ever applies. A retrieved object comes back at the SDK's own
      // pinned version. That is a real reduction in exposure to the skew, and it
      // costs one API call and no guess about which version is right — which is
      // the part that must not be guessed at from here.
      const snapshot = event.data.object as Stripe.Subscription;
      const sub = await stripe.subscriptions.retrieve(snapshot.id);
      const customerId = idOf(sub.customer);
      if (!customerId) return retryable(event, "unidentifiable_subscription");

      if (TERMINAL_SUBSCRIPTION_STATUSES.has(sub.status)) {
        return accept(event, "ignored_subscription_not_live", { subscription_status: sub.status });
      }

      const priceId = sub.items.data[0]?.price?.id ?? null;
      const plan = priceId ? plans.get(priceId) : undefined;

      // The line this replaces was `const plan = PRICE_TO_PLAN[priceId] || "free"`,
      // and it was the single most destructive line in the payment path.
      //
      // `customer.subscription.updated` is not a rare event. It fires on a
      // price change, a payment-method change, a quantity change, a scheduled
      // cancellation, and on every renewal of the billing period. So the map
      // was consulted routinely, and any reason it failed to answer — a secret
      // not yet set on this deployment, a price id copied from test mode into
      // live, one character wrong — silently rewrote every paying customer to
      // `free` on their next renewal. The users would have watched their plan
      // evaporate at billing time, which is the worst possible moment, and the
      // logs would have shown a successful update.
      //
      // An unknown price id now means "I do not know what this is", and the
      // only correct response to not knowing is to leave the row alone. The
      // plan the user already has was written by something that did know.
      if (!plan) return unknownPrice(priceId);

      const result = await writeProfile(supabase, { column: "stripe_customer_id", value: customerId }, { plan });
      if (!result.ok) return retryable(event, result.outcome, { ...result.detail, plan });
      return accept(event, "plan_updated", { plan, ...result.detail });
    }

    // Everything else is genuinely uninteresting to this system, but it is
    // logged with its event id so a delivery in the dashboard can always be
    // matched to a line here — including the ones that did nothing.
    return accept(event, "ignored_event_type");
  } catch (err) {
    // Anything thrown after the signature verified — the subscriptions.retrieve
    // call, a shape that is not what this file expects — is a 5xx rather than
    // an uncaught throw. Same reasoning as the database failures: an exception
    // that Stripe never hears about is a payment that quietly never applied.
    return retryable(event, "handler_threw", { message: (err as Error).message });
  }
});
