import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@14.21.0?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// The metadata key that tells stripe-webhook which account bought this.
//
// This side was always right; the webhook read `user_id` and got `undefined` on
// every delivery, so a completed checkout upgraded nobody and returned 200 while
// doing it. The key is named as a constant on both sides now, and src/test/
// payments.test.ts pins that the two strings are identical — because the failure
// mode of this pair is total (no upgrade ever) and completely silent, and the
// only thing that ever stood between them was two people typing.
//
// `supabase_user_id` is the spelling that survived, since it is what this file
// has always sent: every Stripe customer and session created before the fix
// carries it, and one of those sessions can still complete after it.
const USER_ID_METADATA_KEY = "supabase_user_id";

// Where a buyer is returned to when Stripe is finished with them.
//
// The old fallback was the Lovable preview domain this app was first built on.
// The live site is fx-tactical.jp and that host no longer serves this app, so a
// checkout that fell back would have dropped a paying customer on a dead domain
// at the exact moment they needed to see their payment had worked.
//
// The fallback has almost certainly never fired: src/pages/Pricing.tsx sends
// window.location.origin on every call. It is corrected rather than deleted
// because a fallback nothing exercises is a fallback nobody notices has rotted,
// which is precisely what happened to the last one.
//
// Rejected: refusing the request when returnUrl is absent. It is defensible —
// guessing where to send a paying customer is a guess — but there is exactly one
// right answer for this app, and failing a sale over a missing optional field
// trades a cosmetically wrong redirect for no purchase at all. A returnUrl that
// is PRESENT and malformed is refused (below): that is a caller sending
// something wrong rather than sending nothing, and it must not reach Stripe as
// a redirect target.
//
// Also rejected, deliberately: restricting the accepted origin to this constant
// plus localhost. Any absolute http(s) URL is still accepted, so an
// authenticated caller can be redirected to a host of their own choosing after
// paying — which is worth noticing, but the harm lands only on the caller who
// chose it, and an allowlist would silently break every preview deploy, staging
// host and future custom domain the day one appears. A guard that fails a real
// sale to prevent someone redirecting themselves is the wrong trade.
const FALLBACK_SITE_ORIGIN = "https://fx-tactical.jp";

type ReturnBase = { ok: true; base: URL } | { ok: false; detail: string };

function resolveReturnBase(returnUrl: unknown): ReturnBase {
  const raw = typeof returnUrl === "string" ? returnUrl.trim() : "";
  const source = raw === "" ? FALLBACK_SITE_ORIGIN : raw;
  let base: URL;
  try {
    base = new URL(source);
  } catch {
    return { ok: false, detail: "returnUrl must be an absolute URL" };
  }
  if (base.protocol !== "https:" && base.protocol !== "http:") {
    return { ok: false, detail: "returnUrl must use http or https" };
  }
  return { ok: true, base };
}

// The outcome goes in as a query PARAMETER rather than by string concatenation.
// The old code built `${returnUrl}?checkout=success`, which yields a second "?"
// — and a `checkout` value the frontend cannot read — for any returnUrl that
// already carries a query string. window.location.origin never does, so this
// was another fault waiting for its first different caller.
function checkoutReturnUrl(base: URL, outcome: "success" | "cancel"): string {
  const url = new URL(base.toString());
  url.searchParams.set("checkout", outcome);
  return url.toString();
}

// Which plan the caller may ask for, and which secret holds its price.
//
// A Set membership test and an explicit list, rather than an index, because the
// thing this replaces was a plain object literal indexed by a value taken
// straight off the request body:
//
//   const PRICE_MAP: Record<string, string | undefined> = { light: …, standard: …, pro: … };
//   const priceId = PRICE_MAP[plan];
//   if (!priceId) return 400;
//
// `PRICE_MAP["constructor"]` is not undefined. It is `Object`, inherited off the
// prototype chain, and it is truthy — so `{"plan":"constructor"}` (or
// `toString`, `valueOf`, `hasOwnProperty`, `__proto__`) walks straight past the
// guard that exists to reject exactly that, creates a real Stripe customer and
// writes to `profiles` on the way, and only falls over at
// `line_items: [{ price: <Function> }]`. The caller then gets a 500 carrying a
// Stripe error message instead of the 400 that was written for them.
//
// stripe-webhook fixed the same hazard in the same week, for the same reason
// (it uses a Map for its price ids), and this file kept the object literal.
// There was no argument for the asymmetry; there was just a second file.
//
// `SELLABLE_PLANS` is a Set, so `has("constructor")` is false, and no lookup
// ever touches a prototype. The list of plans is also the list the database
// will accept: profiles_plan_check constrains `plan` to free/light/standard/pro,
// so anything outside it could not be granted even if a checkout succeeded.
//
// Unset secrets are skipped rather than mapped to `undefined`, so a plan whose
// price id was never configured is reported as a configuration fault naming the
// secret, not as "無効なプラン" — which would send the operator looking at the
// frontend for a bug that is in the dashboard.
const PRICE_ENV_VARS: ReadonlyArray<readonly [string, string]> = [
  ["light", "STRIPE_PRICE_LIGHT"],
  ["standard", "STRIPE_PRICE_STANDARD"],
  ["pro", "STRIPE_PRICE_PRO"],
];

const SELLABLE_PLANS: ReadonlySet<string> = new Set(PRICE_ENV_VARS.map(([plan]) => plan));

function priceIdForPlan(plan: string): { ok: true; priceId: string } | { ok: false; envVar: string } {
  const entry = PRICE_ENV_VARS.find(([name]) => name === plan)!;
  const priceId = (Deno.env.get(entry[1]) ?? "").trim();
  return priceId === "" ? { ok: false, envVar: entry[1] } : { ok: true, priceId };
}

// Is the customer id we have on file still a customer of the account we are
// talking to?
//
// Every `stripe_customer_id` in `profiles` was issued by the Stripe account that
// has since been closed as a prohibited business. On the day a processor is
// wired up again — a new Stripe account, or a different provider entirely —
// every one of those stored ids is a stranger to it. The old code passed the
// stored id straight into `checkout.sessions.create`, which fails with
// `resource_missing`, which the catch at the bottom turns into a bare 500. There
// is no way out of that for the user: every retry reuses the same dead id and
// fails identically, forever, and nothing in the code or the runbook said to
// clear the column.
//
// So the id is verified before it is used, and an id the processor does not
// recognise is treated exactly like no id at all: a fresh customer is created
// and the column is overwritten. A customer that was deleted in the dashboard
// comes back as an object with `deleted: true` rather than as an error, so both
// shapes are handled. Any other error is rethrown — a network failure or a bad
// key must not be silently laundered into "create a duplicate customer".
async function usableCustomerId(stripe: Stripe, candidate: string): Promise<string | null> {
  try {
    const customer = await stripe.customers.retrieve(candidate);
    if ((customer as { deleted?: boolean }).deleted) return null;
    return customer.id;
  } catch (err) {
    if ((err as { code?: string }).code === "resource_missing") return null;
    throw err;
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY");
    if (!STRIPE_SECRET_KEY) {
      throw new Error("STRIPE_SECRET_KEY is not configured");
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "認証が必要です" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(supabaseUrl, supabaseKey);
    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);

    if (authError || !user) {
      return new Response(JSON.stringify({ error: "認証に失敗しました" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { plan, returnUrl } = await req.json();

    const returnBase = resolveReturnBase(returnUrl);
    if (!returnBase.ok) {
      return new Response(JSON.stringify({ error: "戻り先URLが不正です", detail: returnBase.detail }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (typeof plan !== "string" || !SELLABLE_PLANS.has(plan)) {
      return new Response(JSON.stringify({ error: `無効なプラン: ${plan}` }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const price = priceIdForPlan(plan);
    if (!price.ok) {
      // Distinct from "無効なプラン" on purpose: the caller asked for something
      // this app sells and the deployment has no price id for it. Naming the
      // secret is what stops that being debugged from the wrong end. The name is
      // safe to return; the value never is.
      console.error(JSON.stringify({ outcome: "missing_price_env", plan, missing_price_env: price.envVar }));
      return new Response(JSON.stringify({ error: "プランの価格設定がされていません", missing_price_env: price.envVar }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Pinned, and deliberately left alone. All three payment functions pin this
    // version while the webhook endpoint is registered in the dashboard at a
    // much newer one; that mismatch is real, recorded in
    // docs/PAYMENTS_SETUP.md §1.7, and must be settled by reading an actual
    // Stripe response rather than by guessing from here — Stripe's docs are not
    // reachable from this environment. src/test/payments.test.ts pins the string
    // so a bump has to be deliberate.
    const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2023-10-16" });

    // The profile row has to exist before any money moves, and the read that
    // proves it used to be `const { data: profile } = await ...` with the error
    // destructured away entirely.
    //
    // That mattered more than it looks. If there is no row for this user, the
    // checkout still went ahead and the payment still completed — and then
    // stripe-webhook, matching on an id that is not in the table, found zero rows
    // and answered 5xx, and spent three days retrying a write that could never
    // land. Money collected, plan never granted, and the only trace in a log
    // that ages out. The trigger on auth.users makes a missing row unlikely; it
    // does not make it impossible, and "unlikely" is not a reason to charge
    // somebody first and find out afterwards.
    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("stripe_customer_id")
      .eq("id", user.id)
      .single();

    if (profileError || !profile) {
      console.error(JSON.stringify({
        outcome: "profile_not_readable",
        user_id: user.id,
        db_error: profileError?.message ?? null,
      }));
      return new Response(JSON.stringify({ error: "アカウント情報を読み取れませんでした" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let customerId: string | null = profile.stripe_customer_id ?? null;
    if (customerId) customerId = await usableCustomerId(stripe, customerId);

    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        metadata: { [USER_ID_METADATA_KEY]: user.id },
      });
      customerId = customer.id;

      // The result of this write used to be discarded outright — no `error`, no
      // `data`, not even an assignment. A failure here leaves a live Stripe
      // customer that no profile points at, and the next attempt takes the same
      // branch and creates a SECOND one; subscription events then key on
      // whichever customer id eventually landed and the other one's events find
      // no profile at all.
      //
      // It is logged rather than fatal, and that is a deliberate choice rather
      // than laziness: the session created below carries the user id in its
      // metadata, so stripe-webhook can still find the right row and write the
      // customer id back itself when the checkout completes. Failing the request
      // here would guarantee the duplicate customer it is trying to prevent,
      // because the user's only recourse is to press the button again.
      const { error: linkError } = await supabase
        .from("profiles")
        .update({ stripe_customer_id: customerId })
        .eq("id", user.id)
        .select("id");

      if (linkError) {
        console.error(JSON.stringify({
          outcome: "customer_link_write_failed",
          user_id: user.id,
          db_error: linkError.message,
        }));
      }
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      line_items: [{ price: price.priceId, quantity: 1 }],
      mode: "subscription",
      success_url: checkoutReturnUrl(returnBase.base, "success"),
      cancel_url: checkoutReturnUrl(returnBase.base, "cancel"),
      metadata: { [USER_ID_METADATA_KEY]: user.id, plan },
    });

    return new Response(JSON.stringify({ url: session.url }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
  } catch (err: any) {
    console.error("Checkout error:", err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
