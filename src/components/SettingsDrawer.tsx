import { X } from "lucide-react";
import type { AppSettings } from "@/lib/types";

interface Props {
  open: boolean;
  onClose: () => void;
  settings: AppSettings;
  onSettingsChange: (s: AppSettings) => void;
}

const PAIRS = ["USD/JPY", "EUR/USD", "GBP/USD", "EUR/JPY", "GBP/JPY", "AUD/USD", "AUD/JPY"];

const SettingsDrawer = ({ open, onClose, settings, onSettingsChange }: Props) => {
  if (!open) return null;

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
            <label className="text-sm text-muted-foreground">Anthropic APIキー</label>
            <input
              type="password"
              value={settings.apiKey}
              onChange={(e) => onSettingsChange({ ...settings, apiKey: e.target.value })}
              placeholder="sk-ant-..."
              className="w-full mt-1 px-3 py-2 bg-secondary rounded-lg border border-border text-sm font-mono text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
            />
            <p className="text-xs text-muted-foreground mt-1">
              console.anthropic.com で取得できます
            </p>
          </div>

          <div>
            <label className="text-sm text-muted-foreground">取引通貨ペア</label>
            <select
              value={settings.currencyPair}
              onChange={(e) => onSettingsChange({ ...settings, currencyPair: e.target.value })}
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
                onChange={(e) => onSettingsChange({ ...settings, defaultStopLossPips: +e.target.value })}
                className="w-full mt-1 px-3 py-2 bg-secondary rounded-lg border border-border text-sm font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
            <div>
              <label className="text-sm text-muted-foreground">利確幅 (pips)</label>
              <input
                type="number"
                value={settings.defaultTakeProfitPips}
                onChange={(e) => onSettingsChange({ ...settings, defaultTakeProfitPips: +e.target.value })}
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
