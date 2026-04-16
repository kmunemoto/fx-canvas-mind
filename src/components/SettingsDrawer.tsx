import { useState } from "react";
import { X, Eye, EyeOff, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/contexts/AuthContext";
import { Badge } from "@/components/ui/badge";
import type { AppSettings } from "@/lib/types";
interface Props {
  open: boolean;
  onClose: () => void;
  settings: AppSettings;
  onSettingsChange: (s: AppSettings) => void;
}

const PAIRS = ["USD/JPY", "EUR/USD", "GBP/USD", "EUR/JPY", "GBP/JPY", "AUD/USD", "AUD/JPY"];

const SettingsDrawer = ({ open, onClose, settings, onSettingsChange }: Props) => {
  const [showTwelve, setShowTwelve] = useState(false);
  const [showAnthropic, setShowAnthropic] = useState(false);
  const { profile } = useAuth();

  if (!open) return null;

  const updateSettings = (newSettings: AppSettings) => {
    onSettingsChange(newSettings);
    toast.success("設定を保存しました");
  };

  const KeyStatus = ({ hasKey }: { hasKey: boolean }) =>
    hasKey ? (
      <span className="inline-flex items-center gap-1 text-xs text-green-500">
        <CheckCircle2 className="h-3 w-3" /> 設定済み
      </span>
    ) : (
      <span className="text-xs text-destructive">未設定</span>
    );

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

        <div className="space-y-4">
          <div>
            <div className="flex items-center justify-between">
              <label className="text-sm text-muted-foreground">Twelve Data APIキー</label>
              <KeyStatus hasKey={!!settings.twelveDataApiKey} />
            </div>
            <div className="relative mt-1">
              <input
                type={showTwelve ? "text" : "password"}
                value={settings.twelveDataApiKey}
                onChange={(e) => updateSettings({ ...settings, twelveDataApiKey: e.target.value })}
                placeholder="APIキーを入力..."
                className="w-full px-3 py-2 pr-10 bg-secondary rounded-lg border border-border text-sm font-mono text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              />
              <button
                type="button"
                onClick={() => setShowTwelve(!showTwelve)}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground"
              >
                {showTwelve ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              twelvedata.com で無料取得（800回/日）
            </p>
          </div>

          <div>
            <div className="flex items-center justify-between">
              <label className="text-sm text-muted-foreground">Anthropic APIキー</label>
              <KeyStatus hasKey={!!settings.anthropicApiKey} />
            </div>
            <div className="relative mt-1">
              <input
                type={showAnthropic ? "text" : "password"}
                value={settings.anthropicApiKey}
                onChange={(e) => updateSettings({ ...settings, anthropicApiKey: e.target.value })}
                placeholder="sk-ant-..."
                className="w-full px-3 py-2 pr-10 bg-secondary rounded-lg border border-border text-sm font-mono text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              />
              <button
                type="button"
                onClick={() => setShowAnthropic(!showAnthropic)}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground"
              >
                {showAnthropic ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              console.anthropic.com で取得
            </p>
          </div>

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
    </div>
  );
};

export default SettingsDrawer;
