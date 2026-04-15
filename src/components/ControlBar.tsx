import type { TimeInterval } from "@/lib/types";
import type { LoadingStage } from "@/lib/types";
import { Loader2, Zap } from "lucide-react";

interface Props {
  interval: TimeInterval;
  onIntervalChange: (i: TimeInterval) => void;
  onAnalyze: () => void;
  loading: boolean;
  loadingStage: LoadingStage;
}

const INTERVALS: { value: TimeInterval; label: string }[] = [
  { value: "15min", label: "15分足" },
  { value: "1h", label: "1時間足" },
  { value: "4h", label: "4時間足" },
];

const STAGE_LABELS: Record<LoadingStage, string> = {
  idle: "",
  fetching_batch1: "データ取得中 (1/2)...",
  fetching_batch2: "データ取得中 (2/2)...",
  analyzing_fundamental: "ファンダメンタル分析中...",
  generating_judgment: "総合判断中...",
};

const ControlBar = ({ interval, onIntervalChange, onAnalyze, loading, loadingStage }: Props) => (
  <div className="glass rounded-xl border border-border p-4 flex flex-col sm:flex-row items-stretch sm:items-center gap-4">
    {/* Interval selector */}
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

    {/* Analyze button */}
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
  </div>
);

export default ControlBar;
