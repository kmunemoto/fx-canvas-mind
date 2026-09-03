import { useState } from "react";
import type { AnalysisRecord } from "@/lib/types";
import { ChevronDown, ChevronUp, Clock, TrendingUp } from "lucide-react";
import { useLocale } from "@/lib/i18n";
import { byConfidence, byMode, byTimeframe, tally, type OutcomeTally } from "@/lib/outcomeStats";
import { formatJst } from "@/lib/candleTime";
import OutcomeDetail from "./OutcomeDetail";

interface Props {
  records: AnalysisRecord[];
}

const signalColor = (s: string) =>
  s === "BUY" ? "text-success" : s === "SELL" ? "text-destructive" : "text-warning";

const OUTCOME_CLASS: Record<string, string> = {
  win: "bg-success/15 text-success border-success/40",
  loss: "bg-destructive/15 text-destructive border-destructive/40",
  pending: "bg-secondary text-muted-foreground border-border",
  expired: "bg-secondary text-muted-foreground border-border",
  skipped: "bg-secondary text-muted-foreground border-border",
  untriggered: "bg-warning/15 text-warning border-warning/40",
  ambiguous: "bg-secondary text-muted-foreground border-border",
};

type Breakdown = "timeframe" | "mode" | "confidence";

const parseBand = (key: string): [number, number | null] => {
  if (key.endsWith("+")) return [Number(key.slice(0, -1)), null];
  const [lo, hi] = key.split("-").map(Number);
  return [lo, Number.isFinite(hi) ? hi : null];
};

// Signal history backed by the analyses table. Wins and losses are judged
// server-side against actual price data, not self-reported; each row opens
// into the plan-vs-actual evidence behind its badge.
const AnalysisHistory = ({ records }: Props) => {
  const { t } = useLocale();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [breakdown, setBreakdown] = useState<Breakdown>("timeframe");

  const safe = Array.isArray(records) ? records : [];
  if (safe.length === 0) return null;

  const overall = tally("all", safe);
  const closed = overall.wins + overall.losses;
  const groups: OutcomeTally[] =
    breakdown === "timeframe" ? byTimeframe(safe) : breakdown === "mode" ? byMode(safe) : byConfidence(safe);

  const groupLabel = (key: string) => {
    if (breakdown === "timeframe") return key;
    if (breakdown === "mode") return t.history.modes[key as keyof typeof t.history.modes] ?? key;
    const [lo, hi] = parseBand(key);
    return t.history.stats.confidenceBand(lo, hi);
  };

  const breakdowns: Array<{ id: Breakdown; label: string }> = [
    { id: "timeframe", label: t.history.stats.byTimeframe },
    { id: "mode", label: t.history.stats.byMode },
    { id: "confidence", label: t.history.stats.byConfidence },
  ];

  return (
    <div className="glass rounded-xl border border-border p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-primary">
          <Clock className="h-4 w-4" />
          <h3 className="text-sm font-semibold">{t.history.title}</h3>
        </div>
        {overall.winRate !== null && (
          <div className="flex items-center gap-1.5 text-xs">
            <TrendingUp className="h-3.5 w-3.5 text-primary" />
            <span className="text-muted-foreground">{t.history.winRate}</span>
            <span className={`font-mono font-bold ${overall.winRate >= 50 ? "text-success" : "text-destructive"}`}>
              {overall.winRate}%
            </span>
            <span className="text-muted-foreground font-mono">({overall.wins}/{closed})</span>
          </div>
        )}
      </div>

      <p className="text-[10px] text-muted-foreground">{t.history.autoNote}</p>

      {/* breakdown of the record by timeframe / mode / confidence */}
      {overall.total > 0 && (
        <div className="rounded-lg border border-border/60 bg-background/30 p-2 space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">{t.history.stats.title}</span>
            <div className="flex gap-1" role="tablist">
              {breakdowns.map((b) => (
                <button
                  key={b.id}
                  type="button"
                  role="tab"
                  aria-selected={breakdown === b.id}
                  onClick={() => setBreakdown(b.id)}
                  className={`px-2 py-0.5 rounded text-[10px] border transition-colors ${
                    breakdown === b.id
                      ? "bg-primary/15 text-primary border-primary/40"
                      : "text-muted-foreground border-transparent hover:border-border"
                  }`}
                >
                  {b.label}
                </button>
              ))}
            </div>
          </div>
          {closed === 0 ? (
            <p className="text-[10px] text-muted-foreground">{t.history.stats.noClosed}</p>
          ) : (
            <table className="w-full text-[11px] font-mono">
              <thead>
                <tr className="text-muted-foreground text-[10px]">
                  <th className="text-left font-normal py-0.5">{t.history.stats.title}</th>
                  <th className="text-right font-normal">{t.history.stats.record}</th>
                  <th className="text-right font-normal">{t.history.winRate}</th>
                  <th className="text-right font-normal">{t.history.stats.untriggered}</th>
                  <th className="text-right font-normal">{t.history.stats.open}</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => (
                  <tr key={g.key} className="border-t border-border/40">
                    <td className="py-0.5 text-foreground">{groupLabel(g.key)}</td>
                    <td className="text-right">
                      <span className="text-success">{g.wins}</span>
                      <span className="text-muted-foreground">–</span>
                      <span className="text-destructive">{g.losses}</span>
                    </td>
                    <td className={`text-right font-bold ${g.winRate === null ? "text-muted-foreground" : g.winRate >= 50 ? "text-success" : "text-destructive"}`}>
                      {g.winRate === null ? "—" : `${g.winRate}%`}
                    </td>
                    <td className="text-right text-warning">{g.untriggered}</td>
                    <td className="text-right text-muted-foreground">{g.open}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="text-[10px] text-muted-foreground">{t.history.winRateNote}</p>
        </div>
      )}

      <div className="space-y-1">
        {safe.map((r) => {
          const badgeCls = OUTCOME_CLASS[r.outcome] ?? OUTCOME_CLASS.pending;
          const badgeLabel = t.history.outcomes[r.outcome] ?? t.history.outcomes.pending;
          const isOpen = expanded === r.id;
          return (
            <div key={r.id} className="border-b border-border/50 last:border-0">
              <button
                type="button"
                aria-expanded={isOpen}
                onClick={() => setExpanded(isOpen ? null : r.id)}
                className="w-full flex items-center gap-2 text-xs py-1.5 text-left hover:bg-secondary/40 rounded px-1 -mx-1 transition-colors"
              >
                <span className="font-mono text-muted-foreground shrink-0">{formatJst(r.created_at, t.intlLocale)}</span>
                <span className="text-muted-foreground truncate">{r.pair} {r.interval}</span>
                <span className={`font-bold font-mono ml-auto shrink-0 ${signalColor(r.signal)}`}>
                  {r.signal}{r.confidence !== null ? ` ${r.confidence}%` : ""}
                </span>
                <span className={`shrink-0 px-1.5 py-0.5 rounded border text-[10px] font-semibold ${badgeCls}`}>
                  {badgeLabel}
                </span>
                {isOpen
                  ? <ChevronUp className="h-3 w-3 text-muted-foreground shrink-0" aria-label={t.history.detail.collapse} />
                  : <ChevronDown className="h-3 w-3 text-muted-foreground shrink-0" aria-label={t.history.detail.expand} />}
              </button>
              {isOpen && <OutcomeDetail record={r} />}
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default AnalysisHistory;
