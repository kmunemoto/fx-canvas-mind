import type { Position, PositionReview, PreviousReference, ReviewChange } from "@/lib/types";
import { useLocale } from "@/lib/i18n";
import { formatJst, priceDecimals } from "@/lib/candleTime";
import ReviewFacts from "./ReviewFacts";
import { EntryRegistration } from "./EntryRegistration";
import { GitCompareArrows } from "lucide-react";

// 前回からの変化. What moved between the previous run on this pair and
// timeframe and this one, said by decider: the ANALYST's direction on each
// side (proposed_signal, which the gate's rewrite to WAIT does not touch),
// then whether the server declined to publish either, then — as its own
// labelled clause, never folded into the headline — the model's reading of
// the previous thesis.
//
// The distinction the owner asked for ("new-entry conditions worsened" vs
// "the previous SELL's basis broke") is therefore two separate lines: the
// gate's measurement on the fresh plan, and the thesis chip. Neither is
// allowed to stand in for the other.

interface Props {
  review: PositionReview;
  previous: PreviousReference;
  change: ReviewChange;
  pair: string;
  // A held position exists on this pair, so the "register the previous
  // plan" button is not offered.
  heldExists: boolean;
  onRegistered?: (position: Position) => void;
}

const ChangeSinceLastCard = ({ review, previous, change, pair, heldExists, onRegistered }: Props) => {
  const { t } = useLocale();
  const p = t.position;
  const decimals = priceDecimals(pair);
  const g = t.history.gate;

  const word = (s: "BUY" | "SELL" | "WAIT" | null): string => {
    if (s === null) return "—";
    const d = t.direction[s];
    return s === "WAIT" ? d.word : `${d.word} (${d.gloss})`;
  };
  const reasonLabel = (rejection: string | null): string =>
    rejection !== null && rejection in g.reasons ? g.reasons[rejection as keyof typeof g.reasons] : rejection ?? "—";

  const { previous: prev, current: cur } = change;
  const headline = p.changeHeader(
    `${p.withConfidence(word(prev.signal), prev.confidence)} (${formatJst(prev.at, t.intlLocale)})`,
    p.withConfidence(word(cur.signal), cur.confidence),
  );

  const kindLine = (() => {
    switch (change.kind) {
      case "same_call":
        return cur.analyst_direction === "WAIT" ? p.kinds.sameWait : p.kinds.sameTrade(word(cur.analyst_direction));
      case "reversed":
        return p.kinds.reversed(word(prev.analyst_direction), word(cur.analyst_direction));
      case "trade_to_wait":
        return p.kinds.tradeToWait;
      case "wait_to_trade":
        return p.kinds.waitToTrade(word(cur.analyst_direction));
      default:
        return p.kinds.unclear;
    }
  })();
  const clauses: string[] = [];
  if (cur.decided_by === "server") clauses.push(p.refusedNow(reasonLabel(cur.rejection)));
  if (prev.decided_by === "server") clauses.push(p.refusedThen(reasonLabel(prev.rejection)));

  // The gate's own measurement on the fresh plan, or the honest blank.
  const gateLine = change.current_gate_rr !== null
    ? p.gateRr(change.current_gate_rr)
    : cur.analyst_direction === "WAIT" ? p.gateNone : null;

  const thesisLabel = change.thesis_of === "held" ? p.thesis.heldLabel : p.thesis.previousLabel;
  const thesisStatus = change.thesis_status;
  const facts = review.mechanical && review.mechanical.subject === "previous" ? review.mechanical : null;
  const stopReached = (facts?.stop_touch.measured && facts.stop_touch.touched) || previous.outcome?.outcome === "loss";
  const stopBasis = facts?.stop_touch.measured && facts.stop_touch.touched
    ? p.facts.feed[facts.feed]
    : p.facts.trackerBasis[previous.outcome?.price_basis ?? "none"];
  const analyst = review.analyst;
  const showAnalystText = change.thesis_of === "previous" && analyst?.status === "ok";
  const canRegister = !heldExists && onRegistered !== undefined && previous.levels !== null && previous.levels.published;

  return (
    <div className="glass rounded-xl border border-border p-4 space-y-2 text-xs" data-testid="change-card">
      <div className="flex items-center gap-2 text-primary">
        <GitCompareArrows className="h-4 w-4" aria-hidden="true" />
        <h3 className="text-sm font-semibold">{p.changeTitle}</h3>
      </div>
      <p className="font-mono text-foreground" data-testid="change-headline">{headline}</p>
      {stopReached && (
        <p className="text-destructive font-semibold" data-testid="stop-reached">{p.stopReached(stopBasis)}</p>
      )}
      <p className="text-foreground" data-testid="change-kind">{kindLine}</p>
      {clauses.map((c, i) => <p key={i} className="text-warning" data-testid="change-clause">{c}</p>)}
      {gateLine && <p className="text-muted-foreground font-mono" data-testid="gate-line">{gateLine}</p>}
      <p data-testid="change-thesis">
        <span className="text-[10px] text-muted-foreground mr-1.5">{thesisLabel} · {p.thesis.byAnalyst}</span>
        <span className={
          thesisStatus === "intact" ? "text-success" : thesisStatus === "weakened" ? "text-warning" : thesisStatus === "broken" ? "text-destructive" : "text-muted-foreground"
        }>
          {thesisStatus ? p.thesis.status[thesisStatus] : p.thesis.unavailable}
        </span>
      </p>
      {/* `levels === null` has two causes and they are different events: the
          analyst stood aside (no levels to name), or the levels were not all
          recorded — which happens on a plan the SERVER refused as incoherent,
          where the analyst did name a direction. Printing 見送り there would
          fold a server refusal into an analyst WAIT, the one conflation this
          card exists to prevent. */}
      {previous.analyst_direction === "WAIT" && (
        <p className="text-muted-foreground" data-testid="previous-wait">{p.previousWasWait}</p>
      )}
      {previous.analyst_direction !== "WAIT" && previous.levels === null && (
        <p className="text-muted-foreground" data-testid="levels-unrecorded">{p.previousLevelsUnrecorded}</p>
      )}
      {previous.levels !== null && !previous.levels.published && (
        <p className="text-muted-foreground" data-testid="levels-refused">{p.previousLevelsRefused}</p>
      )}
      {facts && <ReviewFacts facts={facts} pair={pair} planFeed={previous.feed} outcome={previous.outcome} />}
      {showAnalystText && analyst && analyst.what_changed.length > 0 && (
        <div>
          <p className="text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">{p.whatChanged}</p>
          <ul className="space-y-0.5">
            {analyst.what_changed.map((w, i) => <li key={i} className="text-muted-foreground">• {w}</li>)}
          </ul>
        </div>
      )}
      {showAnalystText && analyst && analyst.reasons.length > 0 && (
        <div>
          <p className="text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">{p.reasons}</p>
          <ul className="space-y-0.5">
            {analyst.reasons.map((w, i) => <li key={i} className="text-muted-foreground">• {w}</li>)}
          </ul>
        </div>
      )}
      {canRegister && previous.levels && (
        <div className="pt-1">
          <EntryRegistration
            analysisId={previous.analysis_id}
            pair={pair}
            defaultPrice={previous.levels.entry.toFixed(decimals)}
            label={p.registerPrevious}
            onRegistered={(pos) => onRegistered?.(pos)}
            compact
          />
        </div>
      )}
      <p className="text-[10px] text-muted-foreground border-t border-border/60 pt-2">{p.noiseNote}</p>
    </div>
  );
};

export default ChangeSinceLastCard;
