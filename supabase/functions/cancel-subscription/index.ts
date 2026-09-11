import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@14.21.0?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY");
    if (!STRIPE_SECRET_KEY) throw new Error("STRIPE_SECRET_KEY is not configured");

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

    const { data: profile } = await supabase
      .from("profiles")
      .select("stripe_customer_id, plan")
      .eq("id", user.id)
      .single();

    if (!profile?.stripe_customer_id) {
      return new Response(JSON.stringify({ error: "Stripe顧客情報が見つかりません" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Pinned, and deliberately left alone — see the note on `current_period_end`
    // below, and docs/PAYMENTS_SETUP.md §1.7. src/test/payments.test.ts pins the
    // string across all three payment functions so that a bump cannot happen as
    // a side effect of tidying.
    const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2023-10-16" });

    // Everything the customer has, filtered here rather than by the API.
    //
    // The query used to be `status: "active"`, and that is not the same set as
    // "subscriptions this user is being billed for". A subscription in a trial
    // is `trialing`; one whose card just failed is `past_due`, and then
    // `unpaid`. A user in any of those states who pressed 解約 was told
    // 「有効なサブスクリプションが見つかりません」 — there is nothing to cancel — and
    // then kept being billed. Being told you have no subscription while your
    // card is still being charged is how a chargeback starts, and the frontend
    // surfaces it as a generic error toast, so nobody would have learned why.
    //
    // `incomplete` is deliberately not in the set: that is a subscription whose
    // very first payment has never confirmed, so there is no billing to stop,
    // and it expires on its own.
    //
    // The limit goes up with the filter. Asking for "all" statuses at limit 10
    // could have filled the page with long-dead cancelled subscriptions and
    // hidden the live one behind them.
    const CANCELABLE_STATUSES: ReadonlySet<string> = new Set([
      "active",
      "trialing",
      "past_due",
      "unpaid",
    ]);

    const subs = await stripe.subscriptions.list({
      customer: profile.stripe_customer_id,
      status: "all",
      limit: 100,
    });

    const cancelable = subs.data.filter((sub) => CANCELABLE_STATUSES.has(sub.status));

    if (cancelable.length === 0) {
      return new Response(JSON.stringify({ error: "有効なサブスクリプションが見つかりません" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // UNVERIFIED, and left exactly as it is on purpose.
    //
    // `updated.current_period_end` is read at the SUBSCRIPTION level. Under a
    // newer Stripe API version this field may have moved onto the subscription
    // ITEM instead, in which case `periodEnd` would be undefined and the user
    // would be told their cancellation takes effect on no date at all. Nobody
    // here can check: Stripe's documentation is unreachable from this
    // environment, and the account is closed, so there is no live response to
    // read either.
    //
    // Guessing was the one option that could make this worse — a defensive
    // `?? item.current_period_end` written against a shape nobody has seen would
    // look like a fix and be untestable. It stays as written, recorded as
    // UNVERIFIED in docs/PAYMENTS_SETUP.md §1.7, to be settled by looking at one
    // real API response the day a processor is connected. Note that the
    // cancellation itself succeeds regardless: only the date shown to the user
    // depends on this field.
    //
    // The loop mutates one subscription at a time, so a throw on the second one
    // leaves the first already set to cancel while the caller is told the whole
    // thing failed. That is left as it is on purpose: `cancel_at_period_end` is
    // an absolute assignment, so pressing 解約 again re-applies it to the first
    // and carries on to the rest. Nothing is double-cancelled and nothing is
    // charged twice; the worst case is one confusing error message followed by a
    // second attempt that works.
    let periodEnd: number | null = null;
    for (const sub of cancelable) {
      const updated = await stripe.subscriptions.update(sub.id, {
        cancel_at_period_end: true,
      });
      if (!periodEnd || updated.current_period_end > periodEnd) {
        periodEnd = updated.current_period_end;
      }
    }

    const cancelDateIso = periodEnd ? new Date(periodEnd * 1000).toISOString().split("T")[0] : null;
    const cancelDateFormatted = periodEnd
      ? new Date(periodEnd * 1000).toLocaleDateString("ja-JP", {
          timeZone: "Asia/Tokyo",
          year: "numeric",
          month: "long",
          day: "numeric",
        })
      : null;

    return new Response(
      JSON.stringify({
        success: true,
        message: "解約手続きが完了しました",
        cancel_date: cancelDateIso,
        cancel_date_formatted: cancelDateFormatted,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err: any) {
    console.error("Cancel subscription error:", err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
