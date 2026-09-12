import type { LevelTouch, ReferenceOutcome, ReviewMechanical } from "@/lib/types";
import { useLocale } from "@/lib/i18n";
import { formatCandleLabel, formatJst, priceDecimals } from "@/lib/candleTime";

// The server's measured facts about a plan, rendered so that each number
// says what it was measured on. Shared by the held-position card and the
// change card; the only difference between the two is whether the P&L is a
// position's or a hypothetical fill's, and that is a label here, never a
// different number.
//
// Asymmetric on purpose (docs/OPERATIONS.md §2.3): a stop touch on the mid
// is conclusive for the exit side; a NON-touch on the mid is a fact on the
// mid only, and so is a TP1 touch, so both carry the "mid only" note. "Not
// measured" is its own state and is never rendered as "none".

interface Props {
  facts: ReviewMechanical;
  pair: string;
  // The feed the plan itself was priced on, when known and different from
  // the feed the touches were measured on.
  planFeed?: "twelve_data" | "gmo" | null;
  outcome?: ReferenceOutcome | null;
}

const Row = ({ label, value, cls = "" }: { label: string; value: string; cls?: string }) => (
  <div className="flex items-baseline justify-between gap-3 py-0.5">
    <span className="text-muted-foreground shrink-0">{label}</span>
    <span className={`font-mono text-right ${cls}`}>{value}</span>
  </div>
);

const ReviewFacts = ({ facts, pair, planFeed = null, outcome = null }: Props) => {
  const { t } = useLocale();
  const f = t.position.facts;
  const decimals = priceDecimals(pair);
  const price = (v: number) => v.toFixed(decimals);
  const signed = (v: number | null) => (v === null ? "—" : `${v > 0 ? "+" : ""}${v}`);
  const r = (v: number | null) => (v === null ? "" : ` (${v > 0 ? "+" : ""}${v}R)`);

  const touchText = (touch: LevelTouch, side: "stop" | "tp1"): string => {
    if (touch.measured === false) return f.notMeasured[touch.reason];
    if (touch.touched === true) {
      const base = f.touched(formatCandleLabel(touch.at, t.intlLocale), !touch.bar_closed);
      return side === "tp1" ? `${base} · ${f.midOnly}` : base;
    }
    const base = f.notTouched(formatCandleLabel(touch.as_of, t.intlLocale), touch.bars_examined);
    return side === "stop" ? `${base} · ${f.midOnly}` : base;
  };
  const touchCls = (touch: LevelTouch, side: "stop" | "tp1"): string => {
    if (touch.measured === false) return "text-muted-foreground";
    if (touch.touched === false) return "text-foreground";
    return side === "stop" ? "text-destructive font-semibold" : "text-success";
  };

  const trackerText = (() => {
    if (!outcome) return f.trackerPending;
    const word = (t.history.outcomes as Record<string, string>)[outcome.outcome] ?? outcome.outcome;
    const basis = f.trackerBasis[outcome.price_basis ?? "none"];
    const at = outcome.closed_at ? ` · ${formatJst(outcome.closed_at, t.intlLocale)}` : "";
    return `${word} (${basis}${at})`;
  })();

  const beyond = (v: number | null) => (v !== null && v < 0 ? ` · ${f.beyond}` : "");

  return (
    <div className="rounded-md border border-border/60 bg-background/40 p-2 text-xs space-y-0.5" data-testid="review-facts">
      <p className="text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
        {f.title} · {f.feed[facts.feed]}
      </p>
      <Row label={f.price} value={price(facts.price)} />
      <Row
        label={facts.subject === "held" ? f.open : f.hypothetical}
        value={`${signed(facts.move_pips)} pips${r(facts.move_r)}`}
        cls={facts.move_pips !== null && facts.move_pips < 0 ? "text-destructive" : "text-success"}
      />
      <Row label={f.toStop} value={`${signed(facts.to_stop_pips)} pips${beyond(facts.to_stop_pips)}`} />
      <Row label={f.toTp1} value={`${signed(facts.to_tp1_pips)} pips${beyond(facts.to_tp1_pips)}`} />
      <Row label={f.stopTouch} value={touchText(facts.stop_touch, "stop")} cls={touchCls(facts.stop_touch, "stop")} />
      <Row label={f.tp1Touch} value={touchText(facts.tp1_touch, "tp1")} cls={touchCls(facts.tp1_touch, "tp1")} />
      <Row label={f.tracker} value={trackerText} cls="text-muted-foreground" />
      {planFeed !== null && planFeed !== facts.feed && (
        <p className="text-[10px] text-warning pt-1" data-testid="feed-differs">{f.feedDiffers}</p>
      )}
      <p className="text-[10px] text-muted-foreground pt-1">{f.basisNote}</p>
    </div>
  );
};

export default ReviewFacts;
