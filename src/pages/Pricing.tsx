import { useState } from "react";
import { Check, Star, ArrowLeft, Loader2 } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/contexts/AuthContext";
import { isAdminEmail, resolvePlanName } from "@/lib/admin";
import { useNavigate } from "react-router-dom";
import { useToast } from "@/hooks/use-toast";

const PLANS = [
  {
    id: "light",
    name: "Light",
    price: "¥2,980",
    period: "/月",
    features: [
      "10回/日の分析",
      "USD/JPYのみ",
      "1時間足のみ",
    ],
    recommended: false,
  },
  {
    id: "standard",
    name: "Standard",
    price: "¥5,980",
    period: "/月",
    features: [
      "30回/日の分析",
      "全通貨ペア対応",
      "全時間足対応",
      "ファンダメンタル分析",
      "分析履歴保存",
    ],
    recommended: true,
  },
  {
    id: "pro",
    name: "Pro",
    price: "¥12,800",
    period: "/月",
    features: [
      "無制限の分析",
      "全機能",
      "アラート通知（予定）",
      "優先サポート",
    ],
    recommended: false,
  },
];

const Pricing = () => {
  const [loadingPlan, setLoadingPlan] = useState<string | null>(null);
  const { user, profile } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();

  const isAdmin = isAdminEmail(user?.email);
  const currentPlan = resolvePlanName(user?.email, profile?.plan);

  const handleSubscribe = async (planId: string) => {
    if (isAdmin) {
      toast({
        title: "管理者アカウントです",
        description: "サブスクリプションなしで全機能をご利用いただけます",
      });
      return;
    }

    setLoadingPlan(planId);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        toast({ title: "ログインが必要です", variant: "destructive" });
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
      toast({ title: "エラー", description: err.message, variant: "destructive" });
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
          ダッシュボードに戻る
        </button>

        <div className="text-center mb-12">
          <h1 className="text-3xl font-bold text-foreground mb-3">料金プラン</h1>
          <p className="text-muted-foreground">あなたのトレードスタイルに合ったプランをお選びください</p>
          {currentPlan !== "Free" && (
            <p className="text-sm text-primary mt-2">現在のプラン: {currentPlan}</p>
          )}
          {isAdmin && (
            <p className="text-sm text-muted-foreground mt-1">
              管理者アカウントのため、お申し込みなしで全機能を無制限にご利用いただけます
            </p>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {PLANS.map((plan) => (
            <div
              key={plan.id}
              className={`relative glass rounded-2xl border p-6 flex flex-col ${
                plan.recommended
                  ? "border-primary ring-2 ring-primary/20"
                  : "border-border"
              }`}
            >
              {plan.recommended && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2 flex items-center gap-1 px-3 py-1 rounded-full bg-primary text-primary-foreground text-xs font-semibold">
                  <Star className="h-3 w-3" />
                  おすすめ
                </div>
              )}

              <h2 className="text-xl font-bold text-foreground mb-1">{plan.name}</h2>
              <div className="flex items-baseline gap-1 mb-6">
                <span className="text-3xl font-bold text-foreground">{plan.price}</span>
                <span className="text-sm text-muted-foreground">{plan.period}</span>
              </div>

              <ul className="space-y-3 mb-8 flex-1">
                {plan.features.map((f) => (
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
                  "ご利用中"
                ) : (
                  "申し込む"
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
