import type { TimeInterval } from "@/lib/types";
import type { LoadingStage } from "@/lib/types";
import { Loader2, Zap, Info } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";
import { useT } from "@/lib/i18n";

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

const INTERVALS: TimeInterval[] = ["15min", "1h", "4h", "1day"];

const ControlBar = ({
  interval,
  onIntervalChange,
  onAnalyze,
  loading,
  loadingStage,
  remaining,
  includeFundamental,
  onIncludeFundamentalChange,
}: Props) => {
  const t = useT();
  return (
  <div className="glass rounded-xl border border-border p-4 space-y-4">
    <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-4">
      <div className="flex items-center gap-1 bg-secondary rounded-lg p-1 overflow-x-auto">
        {INTERVALS.map((value) => (
          <button
            key={value}
            onClick={() => onIntervalChange(value)}
            className={`px-3 py-1.5 rounded-md text-sm font-medium transition-all whitespace-nowrap ${
              interval === value
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {t.control.intervals[value]}
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
            {t.control.stages[loadingStage] || t.control.analyzing}
          </>
        ) : (
          <>
            <Zap className="h-4 w-4" />
            {t.control.analyze}
          </>
        )}
      </button>

      {remaining !== null && (
        <span className="text-xs text-muted-foreground flex items-center gap-1 font-mono">
          {t.control.remainingToday(remaining)}
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
            {t.control.includeFundamental}
          </Label>
          <TooltipProvider delayDuration={200}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="text-muted-foreground hover:text-foreground transition-colors"
                  aria-label={t.control.fundamentalHelp}
                >
                  <Info className="h-3.5 w-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-xs">
                <p className="text-xs">{t.control.tooltipOn}</p>
                <p className="text-xs mt-1">{t.control.tooltipOff}</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
        <p className="text-[11px] text-muted-foreground mt-1 leading-relaxed">
          {includeFundamental ? t.control.fundamentalOn : t.control.fundamentalOff}
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
};

export default ControlBar;
