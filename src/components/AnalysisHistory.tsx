import type { HistoryEntry } from "@/lib/types";
import { Clock } from "lucide-react";

interface Props {
  history: HistoryEntry[];
}

const signalColor = (s: string) =>
  s === "BUY" ? "text-success" : s === "SELL" ? "text-destructive" : "text-warning";

const AnalysisHistory = ({ history }: Props) => {
  if (history.length === 0) return null;

  return (
    <div className="glass rounded-xl border border-border p-4 space-y-3">
      <div className="flex items-center gap-2 text-primary">
        <Clock className="h-4 w-4" />
        <h3 className="text-sm font-semibold">分析履歴</h3>
      </div>
      <div className="space-y-2">
        {history.map((entry, i) => (
          <div key={i} className="flex items-center justify-between text-xs py-1.5 border-b border-border/50 last:border-0">
            <span className="font-mono text-muted-foreground">{entry.timestamp}</span>
            <span className="text-muted-foreground">{entry.pair} {entry.interval}</span>
            <span className={`font-bold font-mono ${signalColor(entry.signal)}`}>
              {entry.signal} {entry.confidence}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
};

export default AnalysisHistory;
