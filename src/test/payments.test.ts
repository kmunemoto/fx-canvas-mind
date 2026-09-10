import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// None of these three functions can run today: the Stripe account was closed as
// a prohibited business, so the payment path has had no traffic since May and
// will have none until a processor is wired up again. That is exactly why they
// need pinning here rather than watching in production — there is no production
// to watch. Every defect below was found by reading, and every one of them
// failed silently: a payment collected, a plan that never moved, and a 200
// handed back to the processor so nothing was ever retried or flagged.
//
// These read the deployed sources as text, the way src/test/learning-loop.test.ts
// does, because the faults were never in logic a unit test could reach. They
// were in a key spelled two ways across two files, in a fallback nobody
// exercised, and in a status code — none of which any amount of mocking would
// have caught.
const webhookSrc = readFileSync("supabase/functions/stripe-webhook/index.ts", "utf8");
const checkoutSrc = readFileSync("supabase/functions/create-checkout/index.ts", "utf8");
const cancelSrc = readFileSync("supabase/functions/cancel-subscription/index.ts", "utf8");

const PAYMENT_SOURCES: ReadonlyArray<readonly [string, string]> = [
  ["stripe-webhook", webhookSrc],
  ["create-checkout", checkoutSrc],
  ["cancel-subscription", cancelSrc],
];

// The comments in these files quote the broken lines they replace — the whole
// point of the house style is that the next reader learns what went wrong — so
// a scan for "does this code still do X" has to look at code only. Otherwise a
// comment saying `|| "free"` was removed would itself fail the test that checks
// `|| "free"` was removed.
//
// The trailing-comment rule requires whitespace before the slashes, so the "//"
// inside an import URL (preceded by a colon) survives, which is what the
// lovable.app check below needs.
const stripComments = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "")
    .replace(/[ \t]+\/\/[^"'`]*$/gm, "");

const webhook = stripComments(webhookSrc);
const checkout = stripComments(checkoutSrc);

describe("the buyer's id survives the trip through Stripe", () => {
  it("names the metadata key with one constant, spelled the same on both sides", () => {
    // The original bug in one line: create-checkout wrote `supabase_user_id`,
    // stripe-webhook read `user_id`. Neither file was wrong on its own. The
    // read was `undefined` on every delivery, so the branch that grants the
    // plan was skipped entirely and the handler still answered 200 — a paying
    // customer stayed on `free` forever with nothing logged anywhere.
    const declared = (src: string) => src.match(/const USER_ID_METADATA_KEY = "([^"]+)";/)?.[1] ?? null;

    const writerKey = declared(checkout);
    const readerKey = declared(webhook);

    expect(writerKey).not.toBeNull();
    expect(readerKey).toBe(writerKey);
    // and the surviving spelling is the one the writer has always sent, so that
    // Stripe objects created before the fix still resolve
    expect(writerKey).toBe("supabase_user_id");
  });

  it("writes that key through the constant, so the two cannot drift apart again", () => {
    // Both the customer and the session carry it. A literal in either place is
    // a second source of truth, and a second source of truth is how this broke.
    expect(checkout).toContain("metadata: { [USER_ID_METADATA_KEY]: user.id }");
    expect(checkout).toContain("metadata: { [USER_ID_METADATA_KEY]: user.id, plan }");
    expect(checkout).not.toMatch(/metadata:\s*\{\s*supabase_user_id\s*:/);
    expect(checkout).not.toMatch(/metadata:\s*\{\s*user_id\s*:/);
  });

  it("reads the key defensively, preferring the current spelling", () => {
    // The tolerance is one-way on purpose: the writer emits only the constant,
    // so accepting the old spelling cannot let a second convention creep back.
    // It exists because a checkout session can be created outside
    // create-checkout — a dashboard payment link, an older deploy — and those
    // may carry `user_id`.
    expect(webhook).toContain('const LEGACY_USER_ID_METADATA_KEY = "user_id"');
    expect(webhook).toMatch(
      /metadata\[USER_ID_METADATA_KEY\]\s*\?\?\s*metadata\[LEGACY_USER_ID_METADATA_KEY\]/,
    );
    // the current spelling is read first, not as the fallback
    expect(webhook).not.toMatch(
      /metadata\[LEGACY_USER_ID_METADATA_KEY\]\s*\?\?\s*metadata\[USER_ID_METADATA_KEY\]/,
    );
  });
});

describe("nothing downgrades a paying account except an ended subscription", () => {
  it("assigns \"free\" in exactly one place, the subscription-deleted branch", () => {
    // `PRICE_TO_PLAN[priceId] || "free"` ran in two branches, one of which —
    // customer.subscription.updated — fires on renewals, price changes and
    // payment-method changes. A price id the map could not answer for (a secret
    // not set, a test-mode id in live, one character off) rewrote every paying
    // customer to `free` at billing time, and logged it as a success.
    const assignments = [...webhook.matchAll(/plan:\s*"free"/g)];
    expect(assignments).toHaveLength(1);
    // and that assignment is the only mention of the word in the executable
    // source at all — the two `|| "free"` fallbacks this replaces were not
    // written as `plan: "free"`, so counting the assignment form alone would
    // have passed happily on the broken file.
    expect([...webhook.matchAll(/"free"/g)]).toHaveLength(1);

    const deletedBranch = webhook.indexOf('if (event.type === "customer.subscription.deleted")');
    const updatedBranch = webhook.indexOf('if (event.type === "customer.subscription.updated")');
    expect(deletedBranch).toBeGreaterThan(-1);
    expect(updatedBranch).toBeGreaterThan(deletedBranch);

    const at = assignments[0].index ?? -1;
    expect(at).toBeGreaterThan(deletedBranch);
    expect(at).toBeLessThan(updatedBranch);
  });

  it("never defaults an unknown price id to a plan", () => {
    // Not `|| "free"`, not `?? "free"`, and not a default of any other plan
    // either: an unrecognised price means "I do not know", and the only correct
    // answer to not knowing is to leave the row exactly as it is.
    expect(webhook).not.toMatch(/\|\|\s*"free"/);
    expect(webhook).not.toMatch(/\?\?\s*"free"/);
    expect(webhook).not.toMatch(/plans\.get\([^)]*\)\s*(\|\||\?\?)/);
  });

  it("leaves the row untouched when the price is unknown, in both granting branches", () => {
    // Both branches that can write a plan have to refuse BEFORE they write.
    for (const marker of [
      'if (event.type === "checkout.session.completed")',
      'if (event.type === "customer.subscription.updated")',
    ]) {
      const branch = webhook.slice(webhook.indexOf(marker));
      const guard = branch.indexOf("return unknownPrice(priceId);");
      const write = branch.indexOf("await writeProfile(");
      expect(`${marker} guard`).toBe(guard > -1 ? `${marker} guard` : "missing");
      expect(write).toBeGreaterThan(guard);
    }
  });

  it("only asks Stripe to retry an unknown price when a secret is actually missing", () => {
    // The first version of this fix answered 5xx for every unrecognised price,
    // and that is worse than the bug it replaced. When the map is COMPLETE and
    // the price is simply not one of ours — archived, grandfathered, a second
    // product, an add-on line item — no retry can ever succeed, so every
    // delivery for that subscription fails for the full three-day backoff, on
    // every renewal, forever. Stripe disables an endpoint that keeps failing,
    // and a disabled endpoint stops every grant AND every revocation for
    // everybody: a strictly larger blast radius than the `|| "free"` line the
    // branch replaced. A missing secret is the opposite — someone can set it
    // inside the retry window — so that one, and only that one, gets the 5xx.
    const helper = webhook.slice(
      webhook.indexOf("const unknownPrice ="),
      webhook.indexOf('if (event.type === "checkout.session.completed")'),
    );
    expect(helper).toContain("if (missing.length > 0)");
    const retry = helper.indexOf('return retryable(event, "unknown_price_id"');
    const give = helper.indexOf('return accept(event, "unknown_price_id_not_retryable"');
    expect(retry).toBeGreaterThan(-1);
    expect(give).toBeGreaterThan(retry);
    // and the retryable one says which secret was missing, so the operator is
    // not left guessing
    expect(webhook).toContain("missing_price_env: missing");
  });
});

describe("a retry that lands three days late cannot resurrect a cancelled plan", () => {
  // This is the hazard the 5xx fix created rather than one it inherited.
  // Returning 500 is right, but it means a delivery can be applied up to three
  // days after it was made, and nothing asked whether the subscription it
  // describes was still alive by then:
  //
  //   1. a renewal `updated` fails, 500, Stripe starts retrying;
  //   2. the user cancels, `deleted` lands, the row goes to the unpaid plan;
  //   3. the step-1 retry lands and writes the paid plan back.
  //
  // The user then holds a paid plan with no subscription, and the only event
  // that could revoke it has already been consumed. Before the 5xx change this
  // was unreachable, because step 1 answered 200 and nothing was ever retried.
  it("re-reads the subscription instead of trusting the event's snapshot", () => {
    const updatedBranch = webhook.slice(webhook.indexOf('if (event.type === "customer.subscription.updated")'));
    const retrieve = updatedBranch.indexOf("await stripe.subscriptions.retrieve(snapshot.id)");
    const priceRead = updatedBranch.indexOf("sub.items.data[0]?.price?.id");
    expect(retrieve).toBeGreaterThan(-1);
    // the price is read off the retrieved object, not off event.data.object —
    // which also reads it at the SDK's pinned version rather than at the
    // endpoint's much newer one (see §1.7)
    expect(priceRead).toBeGreaterThan(retrieve);
    expect(updatedBranch).not.toMatch(/snapshot\.items/);
  });

  it("refuses to grant a plan on a subscription in a terminal state", () => {
    expect(webhook).toContain("const TERMINAL_SUBSCRIPTION_STATUSES");
    expect(webhook).toContain('"incomplete_expired"');
    // both branches that can write a paid plan check it; the deleted branch
    // does not need to, since ending is the whole point of that event
    const checks = [...webhook.matchAll(/TERMINAL_SUBSCRIPTION_STATUSES\.has\(sub\.status\)/g)];
    expect(checks).toHaveLength(2);
    for (const marker of [
      'if (event.type === "checkout.session.completed")',
      'if (event.type === "customer.subscription.updated")',
    ]) {
      const branch = webhook.slice(webhook.indexOf(marker));
      const check = branch.indexOf("TERMINAL_SUBSCRIPTION_STATUSES.has(sub.status)");
      const write = branch.indexOf("await writeProfile(");
      expect(check).toBeGreaterThan(-1);
      expect(write).toBeGreaterThan(check);
    }
  });

  it("keeps dunning states out of that set, so a failing card does not lose the plan", () => {
    const set = webhook.slice(
      webhook.indexOf("const TERMINAL_SUBSCRIPTION_STATUSES"),
      webhook.indexOf("const PRICE_ENV_VARS"),
    );
    for (const status of ["past_due", "unpaid", "trialing"]) {
      expect(`${status}: ${set.includes(`"${status}"`)}`).toBe(`${status}: false`);
    }
  });
});

describe("the price map cannot collapse into a single empty key", () => {
  it("is not an object literal keyed on possibly-empty env reads", () => {
    // The literal it replaces was:
    //   { [Deno.env.get("STRIPE_PRICE_LIGHT") || ""]: "light", ... }
    // With the secrets unset, all three computed keys are the same empty
    // string, so the map held one entry — "" -> "pro" — and no real price id
    // matched it. Partially set was worse: two plans resolved and the third
    // silently shared the "" key.
    expect(webhook).not.toMatch(/\[\s*Deno\.env\.get\([^)]*\)\s*\|\|\s*""\s*\]/);
    expect(webhook).not.toMatch(/\[\s*Deno\.env\.get\(/);
    expect(webhook).not.toContain("const PRICE_TO_PLAN");
  });

  it("builds the map one set variable at a time and remembers which were absent", () => {
    expect(webhook).toContain("function buildPriceMap()");
    expect(webhook).toContain("new Map<string, string>()");
    expect(webhook).toMatch(/if \(priceId === ""\) \{\s*missing\.push\(envVar\);/);
    // names of missing secrets are collected; values are never logged
    expect(webhook).toContain("missing: string[]");
  });

  it("does not throw at module load when a secret is absent", () => {
    // Throwing on load makes every delivery a bare 500 with no body and no
    // reason — the operator sees "failed" in the dashboard and has nothing to
    // act on. The map is read per request so the failure can name the secret,
    // and so that setting it takes effect without waiting for a cold start.
    //
    // This used to slice out `buildPriceMap` alone and check that ONE function
    // for `throw`, which is a much smaller claim than the name of the test: a
    // genuine module-scope `throw` inserted anywhere else in the file passed it
    // happily. And the file did in fact throw at load, three lines above the
    // map: `createClient(Deno.env.get("SUPABASE_URL")!, ...)` throws
    // "supabaseUrl is required." when the variable is unset, because that `!` is
    // a type assertion with no runtime meaning. The whole module scope is
    // checked now, and the clients are built inside the handler.
    const moduleScope = webhook.slice(0, webhook.indexOf("serve(async (req)"));
    expect(moduleScope).not.toContain("throw");
    expect(moduleScope).not.toContain("createClient(");
    expect(moduleScope).not.toContain("new Stripe(");
    expect(moduleScope).not.toMatch(/Deno\.env\.get\([^)]*\)\s*!/);
    expect(webhook).toContain("const { plans, missing } = buildPriceMap();");
  });
});

describe("a failure reaches Stripe as a failure", () => {
  it("returns 5xx when the database write fails, so the delivery is retried", () => {
    // The old handler did `if (error) console.error(...)` and returned
    // `{ received: true }`. Stripe treated that as delivered and never retried:
    // the payment was collected, the plan never moved, and the only trace was a
    // console line that aged out.
    expect(webhook).not.toMatch(/if \(error\) console\.error/);

    const retryable = webhook.slice(
      webhook.indexOf("function retryable("),
      webhook.indexOf("interface WriteResult"),
    );
    expect(retryable).toContain("status: 500");

    // every write result is inspected, and every failed one becomes a retry
    const inspected = [...webhook.matchAll(/if \(!result\.ok\) return retryable\(/g)];
    expect(inspected.length).toBeGreaterThanOrEqual(2);
    expect(webhook).toContain('outcome: "db_update_failed"');
  });

  it("returns 400 for a bad signature, and only for that", () => {
    // A body that does not verify will not verify on the fifth attempt either:
    // it is either not from Stripe, or the signing secret belongs to a
    // different endpoint. Retrying spends three days of backoff on something
    // that cannot succeed and buries the retries that could.
    // Anchored on the price-map build rather than on "the next `try {`": the
    // old end anchor would silently shrink the window under test the moment
    // anyone nested a try block inside the catch.
    const verification = webhook.slice(
      webhook.indexOf("constructEventAsync"),
      webhook.indexOf("const { plans, missing } = buildPriceMap();"),
    );
    expect(verification).toContain("status: 400");
    expect(verification).toContain("signature_verification_failed");

    // 400 appears exactly once in the whole file: the two cases must not merge
    expect([...webhook.matchAll(/status: 400/g)]).toHaveLength(1);
    expect(verification).not.toContain("status: 500");
  });

  it("only tells Stripe \"received\" from the one place that means it", () => {
    const received = [...webhook.matchAll(/received:\s*true/g)];
    expect(received).toHaveLength(1);
    const accept = webhook.slice(webhook.indexOf("function accept("), webhook.indexOf("function retryable("));
    expect(accept).toContain("received: true");
    expect(accept).toContain("status: 200");
  });

  it("does not let an exception after verification vanish into a bare 500", () => {
    expect(webhook).toContain('return retryable(event, "handler_threw"');
  });

  it("counts an update that matched no profile row as a failure, not a success", () => {
    // Postgres reports an UPDATE matching zero rows as success, so a write
    // aimed at a profile that is not linked to this customer yet looked exactly
    // like one that upgraded somebody.
    expect(webhook).toContain('.select("id")');
    expect(webhook).toContain('outcome: "no_profile_matched"');
    // ...except on a downgrade, where nothing is left granted and the routine
    // cause (the profile is gone) cannot be fixed by retrying
    const deleted = webhook.slice(
      webhook.indexOf('if (event.type === "customer.subscription.deleted")'),
      webhook.indexOf('if (event.type === "customer.subscription.updated")'),
    );
    expect(deleted).toContain('return accept(event, "downgrade_matched_no_profile")');
  });
});

describe("a delivery can be traced from the dashboard to a log line", () => {
  it("records the event id and what was done about it", () => {
    // Stripe identifies a delivery by `evt_...` and nothing else. The old
    // handler logged the event TYPE, which is the one field already visible in
    // the dashboard, so a failed delivery could not be matched to anything here.
    expect(webhook).toContain("event_id: event.id");
    expect(webhook).toContain("function logOutcome(");
    for (const outcome of ["plan_granted", "plan_updated", "plan_revoked", "ignored_event_type"]) {
      expect(webhook).toContain(outcome);
    }
  });

  it("routes every profile write through the one function that checks the result", () => {
    // This replaces an assertion that counted increment patterns (`plan: plan +`,
    // `+= 1`) and found none. It passed on the fixed file, on the broken file,
    // and on any file that does not contain an increment — it guarded against a
    // shape nobody has ever written here, which is not a regression guard at
    // all. The claim worth pinning is the one the idempotency argument actually
    // rests on: there is exactly ONE place that touches `profiles`, it assigns
    // absolute values, and it hands back a result that every caller inspects.
    // Replaying the same delivery therefore lands the same row state, and no
    // future branch can write a plan without looking at whether it worked.
    const writes = [...webhook.matchAll(/\.from\("profiles"\)/g)];
    expect(writes).toHaveLength(1);
    const only = writes[0].index ?? -1;
    expect(only).toBeGreaterThan(webhook.indexOf("async function writeProfile("));
    expect(only).toBeLessThan(webhook.indexOf("serve(async (req)"));
  });
});

describe("the checkout sends people back to a domain that exists", () => {
  it("has no lovable.app URL left anywhere in the payment path", () => {
    // The old fallback pointed at the preview domain the app was first built
    // on; the live site is fx-tactical.jp. The frontend always sends returnUrl,
    // so the fallback never fired — which is exactly how it went stale
    // unnoticed. Checked against the raw sources, comments included.
    for (const [name, src] of PAYMENT_SOURCES) {
      expect(`${name}: ${/lovable\.app/i.test(src)}`).toBe(`${name}: false`);
    }
  });

  it("falls back to the live origin and refuses a malformed returnUrl", () => {
    expect(checkout).toContain('const FALLBACK_SITE_ORIGIN = "https://fx-tactical.jp"');
    // no string-concatenated fallback survives
    expect(checkout).not.toMatch(/returnUrl\s*\|\|/);
    // an absent returnUrl is a fallback, but a present-and-broken one is a 400:
    // that is a caller sending something wrong, and it must not reach Stripe as
    // a redirect target
    expect(checkout).toContain("returnUrl must use http or https");
    expect(checkout).toMatch(/if \(!returnBase\.ok\)[\s\S]{0,200}status: 400/);
  });

  it("appends the outcome as a query parameter instead of a second question mark", () => {
    // `${returnUrl}?checkout=success` produces "…?a=b?checkout=success" for any
    // returnUrl that already carries a query string.
    expect(checkout).toContain('url.searchParams.set("checkout", outcome)');
    expect(checkout).toContain('success_url: checkoutReturnUrl(returnBase.base, "success")');
    expect(checkout).toContain('cancel_url: checkoutReturnUrl(returnBase.base, "cancel")');
    expect(checkout).not.toMatch(/\?checkout=(success|cancel)`/);
  });
});

describe("the pinned Stripe API version stays pinned", () => {
  it("is exactly 2023-10-16 in all three functions", () => {
    // The webhook endpoint is registered in the dashboard at a much newer
    // version, and the body of every event the webhook reads is assembled by
    // the ENDPOINT's version rather than by this one — so moving either half
    // moves field positions on the other. Stripe's documentation is unreachable
    // from the environment these fixes were made in, and the account is closed,
    // so there is no live response to check against either.
    //
    // This guard is not an endorsement of the mismatch. It exists so that
    // bumping the version is a deliberate act taken with a real delivery open
    // in the dashboard, and never a side effect of tidying up. Whoever settles
    // it should also settle `current_period_end` in cancel-subscription, which
    // is recorded as UNVERIFIED for the same reason.
    for (const [name, src] of PAYMENT_SOURCES) {
      const pinned = [...src.matchAll(/apiVersion:\s*"([^"]+)"/g)].map((m) => m[1]);
      expect(`${name}: ${pinned.length}`).not.toBe(`${name}: 0`);
      for (const version of pinned) {
        expect(`${name}: ${version}`).toBe(`${name}: 2023-10-16`);
      }
    }
  });

  it("still records the unverified period-end read rather than guessing at it", () => {
    expect(cancelSrc).toContain("UNVERIFIED");
    expect(cancelSrc).toContain("updated.current_period_end");
  });
});

describe("an unconfigured deployment says so instead of blaming Stripe", () => {
  it("checks the required secrets before the signature, and answers 5xx for a missing one", () => {
    // A missing STRIPE_WEBHOOK_SECRET was not merely undiagnosable, it was
    // MISdiagnosed. `constructEventAsync(body, signature, undefined)` throws,
    // the catch reports that as `signature_verification_failed`, and that path
    // answers 400 — so an operator who has simply not set the secret yet was
    // told "this request is not from Stripe", and Stripe, told 400, never
    // retried. Setting a secret is the most fixable condition there is; it
    // belongs on the retry side of the line.
    expect(webhook).toContain("const REQUIRED_ENV_VARS");
    for (const name of [
      "STRIPE_SECRET_KEY",
      "STRIPE_WEBHOOK_SECRET",
      "SUPABASE_URL",
      "SUPABASE_SERVICE_ROLE_KEY",
    ]) {
      expect(webhook).toContain(`"${name}"`);
    }
    const check = webhook.indexOf("missingEnvVars(REQUIRED_ENV_VARS)");
    const verify = webhook.indexOf("constructEventAsync");
    expect(check).toBeGreaterThan(-1);
    expect(verify).toBeGreaterThan(check);
    expect(webhook).toContain('outcome: "missing_required_env"');
    // 400 is still spent on exactly one thing, and this is not it
    expect([...webhook.matchAll(/status: 400/g)]).toHaveLength(1);
  });

  it("names the missing secrets and never their values", () => {
    const preflight = webhook.slice(
      webhook.indexOf("const missingSecrets ="),
      webhook.indexOf("const stripe = new Stripe("),
    );
    // the log line and the body both carry the NAMES that came back from the
    // filter, and nothing reads a value anywhere in between
    expect(preflight).toContain("missing: missingSecrets");
    expect(preflight).not.toContain("Deno.env.get(");
    // and the filter itself only ever returns names it was given
    const filter = webhook.slice(
      webhook.indexOf("function missingEnvVars("),
      webhook.indexOf("const USER_ID_METADATA_KEY"),
    );
    expect(filter).toContain("names.filter(");
  });
});

describe("metadata is a hint, not an identifier", () => {
  it("requires the metadata user id to look like a profile id before using it", () => {
    // `user_id` is about as generic a metadata key as exists, and the reason the
    // legacy spelling is tolerated at all is that the session may have been made
    // by something outside this codebase — a payment link, a support tool, a
    // CRM — which are exactly the places that put a CRM record id or an email in
    // a field called `user_id`. `.eq("id", "<not a uuid>")` is rejected by
    // PostgREST outright (22P02), the write comes back as an error, and the
    // handler answers 5xx: three days of backoff on an input that can never
    // succeed, while the same session carried a perfectly good customer id the
    // code refused to fall back to because the garbage value was truthy.
    expect(webhook).toContain("const PROFILE_ID_PATTERN");
    expect(webhook).toContain("function profileIdOrNull(");
    expect(webhook).toMatch(/const userId = profileIdOrNull\(rawUserId\);/);
    // the raw metadata read still prefers the current spelling and still
    // tolerates the legacy one — the shape check is on top of that, not instead
    expect(webhook).toMatch(
      /const rawUserId = metadata\[USER_ID_METADATA_KEY\] \?\? metadata\[LEGACY_USER_ID_METADATA_KEY\]/,
    );
    // and a rejected value is said out loud rather than swallowed
    expect(webhook).toContain('outcome: "metadata_user_id_not_a_profile_id"');
  });

  it("still falls back to the customer id, which is the authoritative link", () => {
    const completed = webhook.slice(
      webhook.indexOf('if (event.type === "checkout.session.completed")'),
      webhook.indexOf('if (event.type === "customer.subscription.deleted")'),
    );
    expect(completed).toContain('{ column: "stripe_customer_id", value: customerId! }');
  });
});

describe("what Stripe is told back does not carry row content", () => {
  it("keeps database error text in the log and out of the response body", () => {
    // Stripe stores response bodies against the delivery and shows them in its
    // dashboard. Postgres error text routinely quotes the offending value, so
    // returning `error.message` exported row content into a third party's UI for
    // no diagnostic gain the log line did not already give.
    const fn = webhook.slice(
      webhook.indexOf("function retryable("),
      webhook.indexOf("interface WriteResult"),
    );
    expect(fn).toContain("publicDetail");
    // the log gets everything...
    expect(fn).toMatch(/console\.error\(JSON\.stringify\(\{[^}]*\.\.\.detail, \.\.\.publicDetail/);
    // ...the body gets only what was explicitly marked safe to publish
    expect(fn).toMatch(/JSON\.stringify\(\{ error: outcome, \.\.\.publicDetail \}\)/);
    expect(fn).not.toMatch(/JSON\.stringify\(\{ error: outcome, \.\.\.detail/);
    // db_error is passed as private detail everywhere it appears
    expect(webhook).toContain("db_error: error.message");
    expect(webhook).not.toMatch(/publicDetail[^;]*db_error/);
  });
});

describe("create-checkout does not resolve a plan off the prototype chain", () => {
  it("tests membership instead of indexing an object literal", () => {
    // `PRICE_MAP["constructor"]` is `Object`, inherited, and truthy — so
    // `{"plan":"constructor"}` walked past the guard written to reject exactly
    // that, created a real Stripe customer and wrote to `profiles` on the way,
    // and only fell over at `line_items: [{ price: <Function> }]`. The webhook
    // fixed this hazard deliberately with a Map; this file kept the literal.
    expect(checkout).not.toMatch(/const PRICE_MAP/);
    expect(checkout).not.toMatch(/PRICE_MAP\[plan\]/);
    expect(checkout).toContain("const SELLABLE_PLANS: ReadonlySet<string>");
    expect(checkout).toMatch(/!SELLABLE_PLANS\.has\(plan\)/);
    // and the plan has to be a string at all before it is looked up
    expect(checkout).toContain('typeof plan !== "string"');
  });

  it("distinguishes an unsellable plan from a price id nobody configured", () => {
    // Reporting a missing STRIPE_PRICE_* as 「無効なプラン」 sends the operator
    // looking at the frontend for a fault that is in the dashboard.
    expect(checkout).toContain("function priceIdForPlan(");
    expect(checkout).toContain("missing_price_env: price.envVar");
    expect(checkout).toMatch(/if \(!price\.ok\)[\s\S]{0,600}status: 500/);
  });
});

describe("create-checkout looks at the writes it makes", () => {
  it("refuses to start a checkout it cannot attribute to a profile row", () => {
    // The read used to destructure the error away entirely. With no row for this
    // user the checkout still went ahead and the payment still completed — and
    // then stripe-webhook, matching an id that is not in the table, found zero
    // rows, answered 5xx, and retried a write that could never land for three
    // days. Money collected, plan never granted.
    expect(checkout).toMatch(/const \{ data: profile, error: profileError \} = await supabase/);
    expect(checkout).toMatch(/if \(profileError \|\| !profile\)[\s\S]{0,400}status: 500/);
  });

  it("notices when the customer id fails to persist", () => {
    // Discarding this write leaves a live Stripe customer no profile points at,
    // and the next attempt creates a second one. It is logged rather than fatal
    // on purpose: the session carries the user id in its metadata, so the
    // webhook can write the customer id back itself, whereas failing here would
    // guarantee the duplicate customer it is trying to prevent.
    expect(checkout).toMatch(/const \{ error: linkError \} = await supabase/);
    expect(checkout).toContain('outcome: "customer_link_write_failed"');
  });

  it("does not hand a dead customer id to a processor that never issued it", () => {
    // Every stored stripe_customer_id belongs to the account that was closed. On
    // the day a processor is wired up again, every one of them is a stranger to
    // it: `checkout.sessions.create` fails with `resource_missing`, the catch
    // turns that into a bare 500, and every retry reuses the same dead id and
    // fails identically, forever. Nothing said to clear the column.
    expect(checkout).toContain("async function usableCustomerId(");
    expect(checkout).toContain('"resource_missing"');
    expect(checkout).toContain("deleted?: boolean");
    expect(checkout).toMatch(/if \(customerId\) customerId = await usableCustomerId\(stripe, customerId\);/);
    // anything that is not "this processor does not know that id" is rethrown,
    // so a network failure cannot be laundered into a duplicate customer
    const fn = checkout.slice(
      checkout.indexOf("async function usableCustomerId("),
      checkout.indexOf("serve(async (req)"),
    );
    expect(fn).toContain("throw err;");
  });
});

describe("a user who wants to cancel can cancel", () => {
  it("does not restrict cancellation to subscriptions Stripe calls active", () => {
    // `status: "active"` is not the same set as "subscriptions this user is
    // being billed for". A trial is `trialing`; a failing card is `past_due` and
    // then `unpaid`. Anyone in those states who pressed 解約 was told there was
    // nothing to cancel — and kept being charged. That is a chargeback in
    // waiting, and the UI shows it as a generic error toast.
    expect(cancelSrc).not.toMatch(/status: "active",/);
    expect(cancelSrc).toContain("const CANCELABLE_STATUSES");
    for (const status of ["active", "trialing", "past_due", "unpaid"]) {
      expect(`${status}: ${cancelSrc.includes(`"${status}"`)}`).toBe(`${status}: true`);
    }
    // the loop cancels the filtered set, not the raw page
    expect(cancelSrc).toContain("for (const sub of cancelable)");
    expect(cancelSrc).toMatch(/if \(cancelable\.length === 0\)/);
  });
});
