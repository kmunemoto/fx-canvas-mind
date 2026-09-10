import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@13.6.0?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, { apiVersion: "2023-10-16" });
const WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET")!;
const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

const PRICE_TO_PLAN: Record<string, string> = {
  [Deno.env.get("STRIPE_PRICE_LIGHT") || ""]: "light",
  [Deno.env.get("STRIPE_PRICE_STANDARD") || ""]: "standard",
  [Deno.env.get("STRIPE_PRICE_PRO") || ""]: "pro",
};

serve(async (req) => {
  const body = await req.text();
  const sig = req.headers.get("stripe-signature")!;
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(body, sig, WEBHOOK_SECRET);
  } catch (err: any) {
    console.error("Webhook signature failed:", err.message);
    return new Response("Webhook signature failed: " + err.message, { status: 400 });
  }
  
  console.log("Event type:", event.type);
  
  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;
    const userId = session.metadata?.user_id;
    if (userId && session.subscription) {
      const sub = await stripe.subscriptions.retrieve(session.subscription as string);
      const priceId = sub.items.data[0].price.id;
      const plan = PRICE_TO_PLAN[priceId] || "free";
      const { error } = await supabase.from("profiles").update({
        plan,
        stripe_customer_id: session.customer as string,
        stripe_subscription_id: session.subscription as string
      }).eq("id", userId);
      if (error) console.error("DB update error:", error);
      else console.log("Updated user", userId, "to plan", plan);
    }
  }
  
  if (event.type === "customer.subscription.deleted") {
    const sub = event.data.object as Stripe.Subscription;
    await supabase.from("profiles").update({ 
      plan: "free", 
      stripe_subscription_id: null 
    }).eq("stripe_customer_id", sub.customer as string);
  }
  
  if (event.type === "customer.subscription.updated") {
    const sub = event.data.object as Stripe.Subscription;
    const priceId = sub.items.data[0].price.id;
    const plan = PRICE_TO_PLAN[priceId] || "free";
    await supabase.from("profiles").update({ plan }).eq("stripe_customer_id", sub.customer as string);
  }
  
  return new Response(JSON.stringify({ received: true }), { 
    headers: { "Content-Type": "application/json" } 
  });
});
