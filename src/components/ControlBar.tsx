import type { TimeInterval } from "@/lib/types";
import type { LoadingStage } from "@/lib/types";
import { Loader2, Zap, Info } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";

interface Props {
  interval: TimeInterval;
  onIntervalChange: (i: TimeInterval) => void;
  onAnalyze: () => void;
  loading: boolean;
  loadingStage: LoadingStage;
  remaining: number | null;
  includeFundamental: boolean;
  onIncludeFundamentalChange: (v: boolean) => void;
}

const INTERVALS: { value: TimeInterval; label: string }[] = [
  { value: "15min", label: "15分足" },
  { value: "1h", label: "1時間足" },
  { value: "4h", label: "4時間足" },
  { value: "1day", label: "日足" },
];

const STAGE_LABELS: Record<LoadingStage, string> = {
  idle: "",
  fetching: "データ取得中...",
  analyzing: "AI分析中...",
  generating_judgment: "総合判断中...",
};

const ControlBar = ({
  interval,
  onIntervalChange,
  onAnalyze,
  loading,
  loadingStage,
  remaining,
  includeFundamental,
  onIncludeFundamentalChange,
}: Props) => (
  <div className="glass rounded-xl border border-border p-4 space-y-4">
    <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-4">
      <div className="flex items-center gap-1 bg-secondary rounded-lg p-1 overflow-x-auto">
        {INTERVALS.map((opt) => (
          <button
            key={opt.value}
            onClick={() => onIntervalChange(opt.value)}
            className={`px-3 py-1.5 rounded-md text-sm font-medium transition-all whitespace-nowrap ${
              interval === opt.value
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>

      <button
        onClick={onAnalyze}
        disabled={loading}
        className="flex-1 sm:flex-none px-8 py-3 rounded-xl bg-primary text-primary-foreground font-bold text-sm flex items-center justify-center gap-2 hover:opacity-90 transition-opacity disabled:opacity-50"
      >
        {loading ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" />
            {STAGE_LABELS[loadingStage] || "分析中..."}
          </>
        ) : (
          <>
            <Zap className="h-4 w-4" />
            分析開始
          </>
        )}
      </button>

      {remaining !== null && (
        <span className="text-xs text-muted-foreground flex items-center gap-1">
          本日の残り: <span className="font-mono font-semibold text-foreground">{remaining}回</span>
        </span>
      )}
    </div>

    <div className="flex items-start sm:items-center justify-between gap-3 pt-3 border-t border-border">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <Label
            htmlFor="include-fundamental"
            className="text-sm font-medium cursor-pointer"
          >
            経済ニュース・指標も考慮する
          </Label>
          <TooltipProvider delayDuration={200}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="text-muted-foreground hover:text-foreground transition-colors"
                  aria-label="詳細"
                >
                  <Info className="h-3.5 w-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-xs">
                <p className="text-xs">ON: 最新ニュース・経済指標を統合分析（精度向上・時間増）</p>
                <p className="text-xs mt-1">OFF: テクニカル指標のみで判断（高速・シンプル）</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
        <p className="text-[11px] text-muted-foreground mt-1 leading-relaxed">
          {includeFundamental
            ? "ONで最新ニュース・経済指標を統合分析（精度向上・時間増）"
            : "OFFでテクニカル指標のみで判断（高速・シンプル）"}
        </p>
      </div>
      <Switch
        id="include-fundamental"
        checked={includeFundamental}
        onCheckedChange={onIncludeFundamentalChange}
        disabled={loading}
      />
    </div>
  </div>
);

export default ControlBar;
