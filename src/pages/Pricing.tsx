import { useState } from "react";
import { Check, Star, ArrowLeft, Loader2 } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/contexts/AuthContext";
import { isAdminEmail, resolvePlanName } from "@/lib/admin";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useToast } from "@/hooks/use-toast";
import { useT } from "@/lib/i18n";

// Prices and ids stay here; the feature copy and the "/month" suffix come from
// the dictionary so they translate with everything else.
const PLANS = [
  { id: "light", name: "Light", price: "¥2,980", recommended: false },
  { id: "standard", name: "Standard", price: "¥5,980", recommended: true },
  { id: "pro", name: "Pro", price: "¥12,800", recommended: false },
] as const;

const Pricing = () => {
  const t = useT();
  const [loadingPlan, setLoadingPlan] = useState<string | null>(null);
  const { user, profile } = useAuth();
  const navigate = useNavigate();
  // The landing page's plan cards link here as /pricing?plan=standard, and a
  // fresh signup is redirected here carrying the plan it chose. Reading it
  // keeps that choice visible; without this the parameter would be one more
  // control that looks like it does something and does not.
  const [params] = useSearchParams();
  const chosen = params.get("plan");
  const { toast } = useToast();

  const isAdmin = isAdminEmail(user?.email);
  const currentPlan = resolvePlanName(user?.email, profile?.plan);

  const handleSubscribe = async (planId: string) => {
    if (isAdmin) {
      toast({
        title: t.pricing.adminToastTitle,
        description: t.pricing.adminToastBody,
      });
      return;
    }

    setLoadingPlan(planId);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        toast({ title: t.errors.loginRequired, variant: "destructive" });
        return;
      }

      const res = await fetch("https://endcqzewujdvimdlazhj.supabase.co/functions/v1/create-checkout", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + session.access_token,
        },
        body: JSON.stringify({
          plan: planId,
          userId: session.user.id,
          email: session.user.email,
          returnUrl: window.location.origin,
        }),
      });

      const data = await res.json();
      if (data.error) throw new Error(data.error);
      if (data.url) {
        window.location.href = data.url;
      }
    } catch (err: any) {
      toast({ title: t.common.error, description: err.message, variant: "destructive" });
    } finally {
      setLoadingPlan(null);
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <div className="container max-w-5xl mx-auto px-4 py-8">
        <button
          onClick={() => navigate("/")}
          className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors mb-8"
        >
          <ArrowLeft className="h-4 w-4" />
          {t.pricing.back}
        </button>

        <div className="text-center mb-12">
          <h1 className="text-3xl font-bold text-foreground mb-3">{t.pricing.title}</h1>
          <p className="text-muted-foreground">{t.pricing.subtitle}</p>
          {currentPlan !== "Free" && (
            <p className="text-sm text-primary mt-2">{t.pricing.current(currentPlan)}</p>
          )}
          {isAdmin && (
            <p className="text-sm text-muted-foreground mt-1">
              {t.pricing.adminNote}
            </p>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {PLANS.map((plan) => (
            <div
              key={plan.id}
              className={`relative glass rounded-2xl border p-6 flex flex-col ${
                chosen === plan.id
                  ? "border-primary ring-2 ring-primary"
                  : plan.recommended
                    ? "border-primary ring-2 ring-primary/20"
                    : "border-border"
              }`}
              data-testid={chosen === plan.id ? "chosen-plan" : undefined}
            >
              {plan.recommended && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2 flex items-center gap-1 px-3 py-1 rounded-full bg-primary text-primary-foreground text-xs font-semibold">
                  <Star className="h-3 w-3" />
                  {t.pricing.recommended}
                </div>
              )}

              <h2 className="text-xl font-bold text-foreground mb-1">{plan.name}</h2>
              <div className="flex items-baseline gap-1 mb-6">
                <span className="text-3xl font-bold text-foreground">{plan.price}</span>
                <span className="text-sm text-muted-foreground">{t.pricing.perMonth}</span>
              </div>

              <ul className="space-y-3 mb-8 flex-1">
                {t.pricing.features[plan.id].map((f) => (
                  <li key={f} className="flex items-start gap-2 text-sm text-foreground">
                    <Check className="h-4 w-4 text-primary mt-0.5 shrink-0" />
                    {f}
                  </li>
                ))}
              </ul>

              <button
                onClick={() => handleSubscribe(plan.id)}
                disabled={loadingPlan !== null || isAdmin}
                className={`w-full py-3 rounded-xl font-semibold text-sm flex items-center justify-center gap-2 transition-opacity disabled:opacity-50 ${
                  plan.recommended
                    ? "bg-primary text-primary-foreground hover:opacity-90"
                    : "bg-secondary text-foreground border border-border hover:bg-accent"
                }`}
              >
                {loadingPlan === plan.id ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : isAdmin ? (
                  t.pricing.inUse
                ) : (
                  t.pricing.subscribe
                )}
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default Pricing;
