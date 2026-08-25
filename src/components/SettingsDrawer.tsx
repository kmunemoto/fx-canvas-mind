import { useEffect, useState } from "react";
import { X, Loader2, AlertCircle } from "lucide-react";
import { toast } from "sonner";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/lib/supabase";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { isAdminEmail, resolvePlanName } from "@/lib/admin";
import { loadCancellation, saveCancellation, type CancellationInfo } from "@/lib/cancellation";
import type { AppSettings } from "@/lib/types";

interface Props {
  open: boolean;
  onClose: () => void;
  settings: AppSettings;
  onSettingsChange: (s: AppSettings) => void;
}

const PAIRS = ["USD/JPY", "EUR/USD", "GBP/USD", "EUR/JPY", "GBP/JPY", "AUD/USD", "AUD/JPY"];
const PAID_PLANS = ["light", "standard", "pro"];

const SettingsDrawer = ({ open, onClose, settings, onSettingsChange }: Props) => {
  const { user, profile } = useAuth();
  const navigate = useNavigate();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const [cancellation, setCancellation] = useState<CancellationInfo | null>(null);

  useEffect(() => {
    if (open) setCancellation(loadCancellation(user?.id));
  }, [open, user?.id]);

  if (!open) return null;

  const updateSettings = (newSettings: AppSettings) => {
    onSettingsChange(newSettings);
    toast.success("設定を保存しました");
  };

  const isAdmin = isAdminEmail(user?.email);
  const planRaw = (profile?.plan || "free").toLowerCase();
  // The cancel flow needs a real Stripe customer, so a plan granted without a
  // subscription (an admin account) has nothing to cancel
  const isPaid = PAID_PLANS.includes(planRaw) && !!profile?.stripe_customer_id;
  const planName = resolvePlanName(user?.email, profile?.plan);
  const nextBilling = profile?.next_billing_date || "—";
  const isCancelPending = !!cancellation;

  const handleCancel = async () => {
    setCanceling(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("ログインが必要です");

      const res = await fetch(
        "https://endcqzewujdvimdlazhj.supabase.co/functions/v1/cancel-subscription",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer " + session.access_token,
          },
        },
      );
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || "解約に失敗しました");

      const info: CancellationInfo = {
        userId: session.user.id,
        canceledAt: new Date().toISOString(),
        cancelDate: data.cancel_date ?? null,
        cancelDateFormatted: data.cancel_date_formatted ?? null,
      };
      saveCancellation(info);
      setCancellation(info);

      toast.success("解約手続きが完了しました", {
        description: data.cancel_date_formatted
          ? `${data.cancel_date_formatted} までご利用いただけます`
          : undefined,
      });
      setConfirmOpen(false);
    } catch (err: any) {
      toast.error("エラー", { description: err.message });
    } finally {
      setCanceling(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-background/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-sm glass border-l border-border p-6 space-y-6 overflow-y-auto">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-foreground">設定</h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-accent text-muted-foreground">
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Plan info */}
        <div className="p-4 rounded-lg bg-secondary border border-border space-y-3">
          <h3 className="text-sm font-semibold text-foreground">プラン情報</h3>
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">現在のプラン</span>
            <span className="text-sm font-semibold text-primary">{planName}</span>
          </div>
          {isAdmin && (
            <p className="text-xs text-muted-foreground">
              管理者アカウントのため、サブスクリプションなしで全機能を無制限にご利用いただけます。
            </p>
          )}
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">
              {isCancelPending ? "解約予定日" : "次回更新日"}
            </span>
            <span className="text-sm text-foreground">
              {isCancelPending ? cancellation?.cancelDateFormatted ?? nextBilling : nextBilling}
            </span>
          </div>

          {isCancelPending && (
            <div className="flex items-start gap-2 text-xs text-muted-foreground border-t border-border pt-2">
              <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0 text-muted-foreground" />
              <span>
                解約予定（{cancellation?.cancelDateFormatted ?? nextBilling} まで利用可能）
              </span>
            </div>
          )}

          <div className="pt-1">
            {isPaid ? (
              <button
                onClick={() => setConfirmOpen(true)}
                disabled={isCancelPending}
                className="w-full px-4 py-2 rounded-lg border border-border bg-transparent text-muted-foreground text-xs font-medium hover:bg-accent hover:text-foreground transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isCancelPending ? "解約手続き済み" : "プランを解約する"}
              </button>
            ) : (
              <button
                onClick={() => {
                  onClose();
                  navigate("/pricing");
                }}
                className="w-full px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-semibold hover:opacity-90 transition-opacity"
              >
                プランをアップグレード
              </button>
            )}
          </div>
        </div>

        <div className="space-y-4">
          <div>
            <label className="text-sm text-muted-foreground">取引通貨ペア</label>
            <select
              value={settings.currencyPair}
              onChange={(e) => updateSettings({ ...settings, currencyPair: e.target.value })}
              className="w-full mt-1 px-3 py-2 bg-secondary rounded-lg border border-border text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
            >
              {PAIRS.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-sm text-muted-foreground">損切り幅 (pips)</label>
              <input
                type="number"
                value={settings.defaultStopLossPips}
                onChange={(e) => updateSettings({ ...settings, defaultStopLossPips: +e.target.value })}
                className="w-full mt-1 px-3 py-2 bg-secondary rounded-lg border border-border text-sm font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
            <div>
              <label className="text-sm text-muted-foreground">利確幅 (pips)</label>
              <input
                type="number"
                value={settings.defaultTakeProfitPips}
                onChange={(e) => updateSettings({ ...settings, defaultTakeProfitPips: +e.target.value })}
                className="w-full mt-1 px-3 py-2 bg-secondary rounded-lg border border-border text-sm font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
          </div>
        </div>
      </div>

      <Dialog open={confirmOpen} onOpenChange={(v) => !canceling && setConfirmOpen(v)}>
        <DialogContent className="bg-card border-border">
          <DialogHeader>
            <DialogTitle className="text-foreground">プランを解約しますか？</DialogTitle>
            <DialogDescription className="text-muted-foreground pt-2 space-y-2">
              <span className="block">
                {planName}プランを解約します。期間終了日までは現在のプランを引き続きご利用いただけます。
              </span>
              <span className="block text-destructive">
                期間終了後は自動的にFreeプランへ切り替わります。
              </span>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-2">
            <Button
              variant="ghost"
              onClick={() => setConfirmOpen(false)}
              disabled={canceling}
              className="text-muted-foreground hover:text-foreground"
            >
              キャンセル
            </Button>
            <Button
              variant="destructive"
              onClick={handleCancel}
              disabled={canceling}
            >
              {canceling ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  処理中...
                </>
              ) : (
                "解約する"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default SettingsDrawer;
