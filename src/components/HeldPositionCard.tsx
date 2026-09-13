import type { HeldReference, Position, PositionReview } from "@/lib/types";
import { useLocale } from "@/lib/i18n";
import { formatCandleLabel, formatJst, priceDecimals } from "@/lib/candleTime";
import { displayVerdict, isTradeSignal, reviewFailReason } from "@/lib/positions";
import ReviewFacts from "./ReviewFacts";
import { ClosePositionForm } from "./EntryRegistration";
import { Briefcase } from "lucide-react";

// The card the owner asked for: 保有中専用. It sits ABOVE the new-entry call
// whenever a position is registered on this pair, so a reader who holds a
// SELL and sees WAIT below is never left to guess what WAIT means for them.
//
// Rendered whenever a held reference exists, whatever the review's status: a
// review that timed out still shows the position, the measured facts it got
// to, and an honest "the model's verdict could not be obtained" — because the
// card being ABSENT is the exact confusion this exists to remove.
//
// The verdict word is the server's derivation (review.verdict). Under it the
// source line says who decided: a measured fact, the model, or nobody.

interface Props {
  review: PositionReview;
  held: HeldReference;
  pair: string;
  // This run's timeframe, to say when it differs from the plan's
  interval: string;
  // The fresh new-entry call, named in the sentence that says what it is not
  freshSignal: "BUY" | "SELL" | "WAIT";
  // The reader's own row, for the close form. Absent when the page has not
  // loaded positions.
  position?: Position | null;
  onClosed?: (position: Position) => void;
  // The row `close_position` returned, when the reader closed this position
  // from this card. The verdict above it was made while the position was
  // open and stays on screen — relabelled, because it is no longer an
  // answer to "what about the position I hold".
  closed?: Position | null;
}

const VERDICT_CLASS = {
  hold: "text-success",
  caution: "text-warning",
  exit_condition_met: "text-destructive",
  undecidable: "text-muted-foreground",
} as const;

const HeldPositionCard = ({ review, held, pair, interval, freshSignal, position = null, onClosed, closed = null }: Props) => {
  const { t } = useLocale();
  const p = t.position;
  const decimals = priceDecimals(pair);
  const price = (v: number) => v.toFixed(decimals);
  const verdict = displayVerdict(review);
  const dir = t.direction[held.direction];
  const analyst = review.analyst;
  const override = review.override_reason;

  const failReason = p.failReasons[reviewFailReason(review)];

  // Who decided the word above, in one line.
  const source = (() => {
    if (review.decided_by === "server" && override) {
      if (override.source === "mid_touch" && override.at) {
        return p.decidedByServerTouch(formatCandleLabel(override.at, t.intlLocale), p.facts.feed[override.feed ?? "twelve_data"], override.bar_closed === false);
      }
      if (override.source === "tracker") {
        const word = held.outcome ? ((t.history.outcomes as Record<string, string>)[held.outcome.outcome] ?? held.outcome.outcome) : "loss";
        return p.decidedByServerTracker(word, p.facts.trackerBasis[override.basis ?? "none"], override.at ? formatJst(override.at, t.intlLocale) : "—");
      }
      if (override.source === "analyst_incoherent") {
        const said = override.analyst;
        return p.decidedByIncoherent(
          said?.verdict ? p.verdicts[said.verdict] : "—",
          said?.thesis_status ? p.thesis.status[said.thesis_status] : "—",
        );
      }
    }
    if (review.decided_by === "analyst") return p.decidedByAnalyst;
    return p.analystUnavailable(failReason);
  })();

  const thesisStatus = analyst?.status === "ok" && analyst.thesis_status ? analyst.thesis_status : null;
  const reversed = isTradeSignal(freshSignal) && freshSignal !== held.direction;

  return (
    <div className="glass rounded-xl border border-primary/40 p-4 sm:p-5 space-y-3" data-testid="held-position-card">
      <div className="flex items-center gap-2 text-primary">
        <Briefcase className="h-4 w-4" aria-hidden="true" />
        <h3 className="text-sm font-semibold">{p.heldTitle}</h3>
        {closed && (
          <span className="ml-auto px-1.5 py-0.5 rounded border border-border bg-secondary text-[10px] text-muted-foreground" data-testid="closed-chip">
            {p.closedChip(
              closed.close_price === null ? "—" : closed.close_price.toFixed(decimals),
              closed.closed_at ? formatJst(closed.closed_at, t.intlLocale) : "—",
            )}
          </span>
        )}
      </div>
      <p className="text-[11px] text-muted-foreground">{p.heldSubtitle}</p>

      {/* the position itself, as registered */}
      <div className="flex flex-wrap items-center gap-2 text-xs font-mono">
        <span className={`font-bold ${held.direction === "BUY" ? "text-success" : "text-destructive"}`}>
          {dir.word} ({dir.gloss})
        </span>
        <span className="text-foreground">{pair}</span>
        <span className="text-foreground">@{price(held.entry)}</span>
        <span className="text-muted-foreground">SL {price(held.stop)}</span>
        <span className="text-muted-foreground">TP1 {price(held.tp1)}</span>
        <span className="text-muted-foreground">
          {p.openedAt} {formatJst(held.opened_at, t.intlLocale)}
          {held.opened_at_source === "registered" ? ` (${p.openedAtRegistered})` : ""}
        </span>
        <span className="text-muted-foreground">{p.planTimeframe} {held.interval}</span>
      </div>
      {held.interval !== interval && (
        <p className="text-[10px] text-muted-foreground">{p.intervalDiffers(held.interval, interval)}</p>
      )}
      {held.other_open_positions.count > 0 && (
        <p className="text-[10px] text-warning" data-testid="other-open">{p.otherOpen(held.other_open_positions.count)}</p>
      )}

      {/* the verdict word, and who decided it */}
      <div className={closed ? "opacity-70" : undefined}>
        {closed && (
          <p className="text-[10px] font-semibold tracking-wider text-muted-foreground uppercase" data-testid="verdict-before-close">
            {p.verdictBeforeClose}
          </p>
        )}
        <p className={`text-2xl sm:text-3xl font-black tracking-tight ${VERDICT_CLASS[verdict]}`} data-testid="held-verdict">
          {p.verdicts[verdict]}
        </p>
        {/* The gloss is the DEFINITION of the analyst's word, so it may
            only appear over a verdict that was actually produced. On a
            failed review the word below is the screen's own "we cannot
            say", and the source line under it gives the reason. */}
        {review.verdict !== null && (
          <p className="text-xs text-muted-foreground">{p.verdictGloss[verdict]}</p>
        )}
        <p className="text-[11px] mt-1" data-testid="verdict-source">{source}</p>
        {review.override_suppressed && (
          <p className="text-[10px] text-muted-foreground mt-0.5" data-testid="override-suppressed">
            {review.override_suppressed.reason === "settled_before_open"
              ? p.suppressed.settled_before_open(review.override_suppressed.closed_at ? formatJst(review.override_suppressed.closed_at, t.intlLocale) : "—")
              : review.override_suppressed.reason === "settled_before_registration"
                ? p.suppressed.settled_before_registration(review.override_suppressed.closed_at ? formatJst(review.override_suppressed.closed_at, t.intlLocale) : "—")
                : p.suppressed.registered_after_settlement}
          </p>
        )}
      </div>

      {review.mechanical && review.mechanical.subject === "held" && (
        <ReviewFacts
          facts={review.mechanical}
          pair={pair}
          planFeed={held.feed}
          outcome={held.outcome}
          planUnavailable={review.reference?.held_reason === "plan_row_missing"}
        />
      )}

      {/* the original plan's thesis, and the model's reading of it */}
      <div className="text-xs space-y-1">
        <p>
          <span className="text-[10px] text-muted-foreground mr-1.5">{p.thesis.heldLabel}</span>
          <span className="text-foreground">{held.thesis ?? "—"}</span>
        </p>
        <p data-testid="thesis-status">
          <span className="text-[10px] text-muted-foreground mr-1.5">{p.thesis.byAnalyst}</span>
          <span className={
            thesisStatus === "intact" ? "text-success" : thesisStatus === "weakened" ? "text-warning" : thesisStatus === "broken" ? "text-destructive" : "text-muted-foreground"
          }>
            {thesisStatus ? p.thesis.status[thesisStatus] : p.thesis.unavailable}
          </span>
        </p>
      </div>

      {analyst?.status === "ok" && (
        <div className="text-xs space-y-2">
          {analyst.what_changed.length > 0 && (
            <div>
              <p className="text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">{p.whatChanged}</p>
              <ul className="space-y-0.5">
                {analyst.what_changed.map((w, i) => <li key={i} className="text-muted-foreground">• {w}</li>)}
              </ul>
            </div>
          )}
          {analyst.reasons.length > 0 && (
            <div>
              <p className="text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">{p.reasons}</p>
              <ul className="space-y-0.5">
                {analyst.reasons.map((w, i) => <li key={i} className="text-muted-foreground">• {w}</li>)}
              </ul>
            </div>
          )}
          {analyst.watch && (
            <p>
              <span className="text-[10px] text-muted-foreground mr-1.5">{p.watch}</span>
              <span className="text-warning">{analyst.watch}</span>
            </p>
          )}
        </div>
      )}

      {/* the sentence this card exists for. Gone once the position is closed:
          there is nothing left for the call below to be mistaken for. */}
      {!closed && (
        <p className="text-[11px] text-foreground border-t border-border/60 pt-2" data-testid="not-an-instruction">
          {p.notAnInstruction(freshSignal)}
        </p>
      )}
      {reversed && !closed && (
        <p className="text-[11px] text-warning" data-testid="reversed-note">
          {p.reversedNote(held.direction, freshSignal)}
        </p>
      )}

      {position && onClosed && (
        <div className="pt-1">
          <ClosePositionForm position={position} onClosed={onClosed} />
        </div>
      )}
    </div>
  );
};

export default HeldPositionCard;
