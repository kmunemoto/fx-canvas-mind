import { useState } from "react";
import { X, Loader2 } from "lucide-react";
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
  const { profile } = useAuth();
  const navigate = useNavigate();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  if (!open) return null;

  const updateSettings = (newSettings: AppSettings) => {
    onSettingsChange(newSettings);
    toast.success("設定を保存しました");
  };

  const planRaw = (profile?.plan || "free").toLowerCase();
  const isPaid = PAID_PLANS.includes(planRaw);
  const planName = profile?.plan
    ? profile.plan.charAt(0).toUpperCase() + profile.plan.slice(1).toLowerCase()
    : "Free";
  const nextBilling = profile?.next_billing_date || "—";
  const cancelPending = (profile as any)?.cancel_at_period_end === true;

  const handleCancelSubscription = async () => {
    setCancelling(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        toast.error("ログインが必要です");
        return;
      }

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

      toast.success(data.message || "解約を受け付けました");
      setConfirmOpen(false);
      onClose();
    } catch (err: any) {
      toast.error(err.message || "解約に失敗しました");
    } finally {
      setCancelling(false);
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
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">
              {cancelPending ? "解約予定日" : "次回更新日"}
            </span>
            <span className="text-sm text-foreground">{nextBilling}</span>
          </div>

          {cancelPending && isPaid && (
            <p className="text-xs text-muted-foreground border-t border-border pt-2">
              解約予約済み。期間終了日まで現在のプランをご利用いただけます。
            </p>
          )}

          <div className="pt-2">
            {isPaid ? (
              <button
                onClick={() => setConfirmOpen(true)}
                disabled={cancelPending}
                className="w-full px-4 py-2 rounded-lg border border-destructive/50 text-destructive text-sm font-medium hover:bg-destructive/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {cancelPending ? "解約手続き済み" : "プランを解約する"}
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

      <Dialog open={confirmOpen} onOpenChange={(v) => !cancelling && setConfirmOpen(v)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>プランを解約しますか？</DialogTitle>
            <DialogDescription className="space-y-2 pt-2">
              <span className="block">
                {planName}プランを解約します。期間終了日（{nextBilling}）までは現在のプランを引き続きご利用いただけます。
              </span>
              <span className="block text-destructive">
                期間終了後は自動的にFreeプランへ切り替わります。
              </span>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              onClick={() => setConfirmOpen(false)}
              disabled={cancelling}
            >
              キャンセル
            </Button>
            <Button
              variant="destructive"
              onClick={handleCancelSubscription}
              disabled={cancelling}
            >
              {cancelling ? (
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
