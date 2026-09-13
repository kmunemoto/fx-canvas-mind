import type { AnalysisRecord, Position } from "@/lib/types";
import { useLocale } from "@/lib/i18n";
import { formatJst, priceDecimals } from "@/lib/candleTime";
import { displayVerdict, latestVerdictFor, reviewFailReason } from "@/lib/positions";
import { ClosePositionForm } from "./EntryRegistration";
import { Briefcase } from "lucide-react";

// Every position the reader has registered and not closed, with the newest
// verdict the history page holds for it. An absent verdict is labelled by
// what was looked at: "no analysis since registration" only when the page
// reaches back that far, otherwise how many rows it examined — the page is
// the last forty rows, and a gap in it is not a gap in the record.

interface Props {
  positions: Position[];
  history: AnalysisRecord[];
  onClosed: (position: Position) => void;
}

const VERDICT_CLASS = {
  hold: "text-success",
  caution: "text-warning",
  exit_condition_met: "text-destructive",
  undecidable: "text-muted-foreground",
} as const;

const OpenPositionsStrip = ({ positions, history, onClosed }: Props) => {
  const { t } = useLocale();
  const p = t.position;
  const open = positions.filter((x) => x.status === "open");
  if (open.length === 0) return null;

  return (
    <div className="glass rounded-xl border border-border p-3 space-y-2" data-testid="open-positions">
      <div className="flex items-center gap-2 text-primary">
        <Briefcase className="h-4 w-4" aria-hidden="true" />
        <h3 className="text-sm font-semibold">{p.openTitle}</h3>
        <span className="text-[10px] text-muted-foreground">{open.length}</span>
      </div>
      <ul className="space-y-2">
        {open.map((pos) => {
          const decimals = priceDecimals(pos.pair);
          const dir = t.direction[pos.direction];
          const latest = latestVerdictFor(pos, history);
          // A verdict older than a later registration on the same pair was
          // made for a different set of positions.
          const stale = latest.kind === "found" &&
            positions.some((q) => q.pair === pos.pair && q.id !== pos.id && q.status === "open" && q.created_at > latest.record.created_at);
          return (
            <li key={pos.id} className="rounded-lg border border-border/60 bg-background/40 p-2 text-xs space-y-1" data-testid="open-position">
              <div className="flex flex-wrap items-center gap-2 font-mono">
                <span className={`font-bold ${pos.direction === "BUY" ? "text-success" : "text-destructive"}`}>
                  {dir.word} ({dir.gloss})
                </span>
                <span>{pos.pair}</span>
                <span>@{pos.entry_price.toFixed(decimals)}</span>
                <span className="text-muted-foreground">SL {pos.stop_loss.toFixed(decimals)}</span>
                <span className="text-muted-foreground">TP1 {pos.take_profit_1.toFixed(decimals)}</span>
                <span className="text-muted-foreground">{pos.interval}</span>
                <span className="text-muted-foreground">
                  {p.openedAt} {formatJst(pos.opened_at, t.intlLocale)}
                  {pos.opened_at_source === "registered" ? ` (${p.openedAtRegistered})` : ""}
                </span>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p data-testid="latest-verdict">
                  <span className="text-[10px] text-muted-foreground mr-1.5">{p.latestVerdict}</span>
                  {latest.kind === "found" && (
                    <>
                      <span className={`font-semibold ${VERDICT_CLASS[displayVerdict(latest.review)]}`}>
                        {p.verdicts[displayVerdict(latest.review)]}
                      </span>
                      <span className="text-[10px] text-muted-foreground ml-1.5">
                        {p.verdictAt(formatJst(latest.record.created_at, t.intlLocale))}
                        {stale ? ` · ${p.verdictStale}` : ""}
                        {/* A verdict that was never produced must not stand
                            here as the analyst's word for "I could not
                            judge" — the reason travels with it. */}
                        {latest.review.verdict === null
                          ? ` · ${p.analystUnavailable(p.failReasons[reviewFailReason(latest.review)])}`
                          : ""}
                      </span>
                    </>
                  )}
                  {/* An analysis that ran and did not cover this position, or
                      could not read the positions at all, is not an absence
                      of analysis. */}
                  {latest.kind === "not_covered" && (
                    <span className="text-muted-foreground">
                      {p.verdictNotCovered}
                      <span className="text-[10px] ml-1.5">{p.verdictAt(formatJst(latest.record.created_at, t.intlLocale))}</span>
                    </span>
                  )}
                  {latest.kind === "lookup_failed" && (
                    <span className="text-warning">
                      {p.verdictLookupFailed}
                      <span className="text-[10px] ml-1.5">{p.verdictAt(formatJst(latest.record.created_at, t.intlLocale))}</span>
                    </span>
                  )}
                  {latest.kind === "none" && (
                    <span className="text-muted-foreground">
                      {latest.conclusive ? p.noVerdictSinceRegistration : p.noVerdictInRecent(latest.examined)}
                    </span>
                  )}
                </p>
                <ClosePositionForm position={pos} onClosed={onClosed} />
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
};

export default OpenPositionsStrip;
