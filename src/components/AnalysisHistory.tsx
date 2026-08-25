import type { AnalysisRecord } from "@/lib/types";
import { Clock, TrendingUp } from "lucide-react";

interface Props {
  records: AnalysisRecord[];
}

const signalColor = (s: string) =>
  s === "BUY" ? "text-success" : s === "SELL" ? "text-destructive" : "text-warning";

const OUTCOME_BADGE: Record<string, { label: string; cls: string }> = {
  win: { label: "WIN", cls: "bg-success/15 text-success border-success/40" },
  loss: { label: "LOSS", cls: "bg-destructive/15 text-destructive border-destructive/40" },
  pending: { label: "進行中", cls: "bg-secondary text-muted-foreground border-border" },
  expired: { label: "期限切れ", cls: "bg-secondary text-muted-foreground border-border" },
  skipped: { label: "—", cls: "bg-secondary text-muted-foreground border-border" },
};

const formatTime = (iso: string) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("ja-JP", {
    timeZone: "Asia/Tokyo",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
};

// Signal history backed by the analyses table; wins/losses are judged
// server-side against actual price data, not self-reported
const AnalysisHistory = ({ records }: Props) => {
  const safe = Array.isArray(records) ? records : [];
  if (safe.length === 0) return null;

  const closed = safe.filter((r) => r.outcome === "win" || r.outcome === "loss");
  const wins = closed.filter((r) => r.outcome === "win").length;
  const winRate = closed.length > 0 ? Math.round((wins / closed.length) * 100) : null;

  return (
    <div className="glass rounded-xl border border-border p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-primary">
          <Clock className="h-4 w-4" />
          <h3 className="text-sm font-semibold">シグナル履歴</h3>
        </div>
        {winRate !== null && (
          <div className="flex items-center gap-1.5 text-xs">
            <TrendingUp className="h-3.5 w-3.5 text-primary" />
            <span className="text-muted-foreground">勝率</span>
            <span className={`font-mono font-bold ${winRate >= 50 ? "text-success" : "text-destructive"}`}>
              {winRate}%
            </span>
            <span className="text-muted-foreground font-mono">({wins}/{closed.length})</span>
          </div>
        )}
      </div>

      <div className="space-y-2">
        {safe.map((r) => {
          const badge = OUTCOME_BADGE[r.outcome] ?? OUTCOME_BADGE.pending;
          return (
            <div key={r.id} className="flex items-center gap-2 text-xs py-1.5 border-b border-border/50 last:border-0">
              <span className="font-mono text-muted-foreground shrink-0">{formatTime(r.created_at)}</span>
              <span className="text-muted-foreground truncate">{r.pair} {r.interval}</span>
              <span className={`font-bold font-mono ml-auto shrink-0 ${signalColor(r.signal)}`}>
                {r.signal}{r.confidence !== null ? ` ${r.confidence}%` : ""}
              </span>
              <span className={`shrink-0 px-1.5 py-0.5 rounded border text-[10px] font-semibold ${badge.cls}`}>
                {badge.label}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default AnalysisHistory;
