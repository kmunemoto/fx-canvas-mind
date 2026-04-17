import type { TimeInterval } from "@/lib/types";
import type { LoadingStage } from "@/lib/types";
import { Loader2, Zap } from "lucide-react";

interface Props {
  interval: TimeInterval;
  onIntervalChange: (i: TimeInterval) => void;
  onAnalyze: () => void;
  loading: boolean;
  loadingStage: LoadingStage;
  remaining: number | null;
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

const ControlBar = ({ interval, onIntervalChange, onAnalyze, loading, loadingStage, remaining }: Props) => (
  <div className="glass rounded-xl border border-border p-4 flex flex-col sm:flex-row items-stretch sm:items-center gap-4">
    <div className="flex items-center gap-1 bg-secondary rounded-lg p-1">
      {INTERVALS.map((opt) => (
        <button
          key={opt.value}
          onClick={() => onIntervalChange(opt.value)}
          className={`px-3 py-1.5 rounded-md text-sm font-medium transition-all ${
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
);

export default ControlBar;
