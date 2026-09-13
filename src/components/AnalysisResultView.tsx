import { useMemo, useState } from "react";
import type { AnalysisMode, AnalysisResult, EntryCheck, Position, PositionReview, RuleFit, Rulebook, TechnicalData } from "@/lib/types";
import DirectionHero from "./DirectionHero";
import PriceChart, { type ChartOverlay } from "./PriceChart";
import MarketContextCard from "./MarketContextCard";
import RuleFitPanel from "./RuleFitPanel";
import HeldPositionCard from "./HeldPositionCard";
import ChangeSinceLastCard from "./ChangeSinceLastCard";
import { EntryRegistration } from "./EntryRegistration";
import Disclosure from "./Disclosure";
import { AlertTriangle, ChevronDown, ChevronUp, Compass, FileText, ListChecks, Target, TrendingUp } from "lucide-react";
import { useT } from "@/lib/i18n";
import { isInference } from "@/lib/inference";
import { toPips } from "@/lib/candleTime";
import { visibleWarnings, waitReasonOf } from "@/lib/warnings";
import { hasMarketContext } from "@/lib/marketContext";
import { registrationFor } from "@/lib/positions";
import type { Dict } from "@/lib/i18n/locales";

interface Props {
  result: AnalysisResult;
  techData?: TechnicalData | null;
  pair: string;
  interval: string;
  // The entry gate's verdict, from the response beside `analysis`
  entryCheck?: EntryCheck | null;
  // Needed to find the server's own sentences in the warnings list
  analysisMode?: AnalysisMode | null;
  ruleFit?: RuleFit | null;
  rulebook?: Rulebook | null;
  // Where confidence has actually landed in this reader's own record. Threaded
  // from Index so the gauge can say it without fetching anything itself.
  confidenceObserved?: { lo: number; hi: number; n: number } | null;
  // The held-position review made on this run, and the row's id so the
  // reader can register an entry on it. Both from the analyze response.
  positionReview?: PositionReview | null;
  analysisId?: string | null;
  // The reader's open positions, so a plan already registered shows as such
  // and the held card can offer the close form.
  positions?: Position[];
  onPositionsChanged?: () => void;
}

// Bullets shown before the reader asks for the rest. The factors are
// evidence, and evidence at full weight above the fold is what made the
// screen a wall of numbers.
const PREVIEW_FACTORS = 3;

// The plan's own numbers arrive as display strings
const num = (v: string | undefined): number | null => {
  if (typeof v !== "string") return null;
  const n = Number(v.replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
};

// ATR relative to price, as a rough volatility gauge
const volatilityText = (tech?: TechnicalData | null) => {
  if (!tech) return null;
  const atr = Number(tech.atr);
  const price = Number(tech.price);
  if (!Number.isFinite(atr) || !Number.isFinite(price) || price === 0) return null;
  const pct = (atr / price) * 100;
  const level: keyof Dict["result"]["volatilityLevels"] =
    pct < 0.15 ? "Low" : pct < 0.4 ? "Medium" : "High";
  return { pct: pct.toFixed(2), level };
};

const InferenceChip = ({ label }: { label: string }) => (
  <span className="ml-1.5 align-middle rounded border border-warning/40 bg-warning/10 px-1 py-0.5 text-[9px] text-warning">
    {label}
  </span>
);

const Chip = ({ children }: { children: string }) => (
  <span className="px-1.5 py-0.5 rounded border border-border text-[10px] font-mono text-muted-foreground">
    {children}
  </span>
);

// Ordered by the questions a trader asks, each at the weight of its answer:
// the call, the chart, the plan, the reasons, the cautions — and then, folded,
// the material the reasons were drawn from.
const AnalysisResultView = ({
  result, techData, pair, interval, entryCheck, analysisMode, ruleFit, rulebook,
  confidenceObserved = null, positionReview = null, analysisId = null, positions = [], onPositionsChanged,
}: Props) => {
  const t = useT();
  const [allFactors, setAllFactors] = useState(false);
  // The position closed from the card on this screen. The reload that follows
  // drops it from `positions`, which on its own is indistinguishable from
  // "not loaded" — so the row the RPC returned is what the card is told.
  const [closedHere, setClosedHere] = useState<Position | null>(null);
  const keyFactors = Array.isArray(result?.key_factors) ? result.key_factors : [];
  // Non-null whenever entry_check names a reason, even the one case the hero
  // draws nothing for (a model WAIT on a shut market, which the preview
  // banner in Index.tsx already explains): the server's sentence about it is
  // dropped from the warnings either way.
  const waitReason = waitReasonOf(result.signal, entryCheck);
  const warnings = visibleWarnings(
    Array.isArray(result?.warnings) ? result.warnings : [],
    { reasonShown: waitReason !== null, mode: analysisMode ?? null },
  );
  const vol = volatilityText(techData);
  const hasPlan = result.signal === "BUY" || result.signal === "SELL";

  // How far the stop and the first target sit from the entry, in the two
  // units a trader reads distance in. The prices alone say nothing about
  // whether a stop is wide or tight; 40 pips is one thing on a daily plan and
  // another on a 15-minute one, and the ATR multiple is what makes it one.
  const distance = (level: string | undefined): string | null => {
    const entry = num(result.entry_point);
    const target = num(level);
    if (entry === null || target === null) return null;
    const diff = Math.abs(entry - target);
    const atr = techData ? Number(techData.atr) : NaN;
    const atrMultiple = Number.isFinite(atr) && atr > 0 ? Number((diff / atr).toFixed(1)) : null;
    return t.result.distance(Math.round(toPips(pair, diff)), atrMultiple);
  };
  const stopDistance = hasPlan ? distance(result.stop_loss) : null;
  const tp1Distance = hasPlan ? distance(result.take_profit_1) : null;

  // The two registers, assembled here because only this component has both
  // halves: what the server measured, and what the model named.
  //
  // A support level the model quoted may well be right — nothing measured it,
  // and that is the entire difference the chart is drawing.
  const overlays = useMemo<ChartOverlay[]>(() => {
    const out: ChartOverlay[] = (techData?.levels ?? []).map((l) => ({
      label: l.label,
      value: l.value,
      register: "computed" as const,
    }));
    const cited = [
      ...(Array.isArray(result.support_levels) ? result.support_levels : []),
      ...(Array.isArray(result.resistance_levels) ? result.resistance_levels : []),
    ];
    for (const c of cited) {
      const v = Number(c);
      if (!Number.isFinite(v)) continue;
      // Skip one the server already measured: the same price drawn twice, in
      // two registers, says the measurement is in doubt when it is not.
      if (out.some((o) => o.register === "computed" && Math.abs(o.value - v) < 1e-9)) continue;
      out.push({ label: v.toString(), value: v, register: "cited" });
    }
    return out;
  }, [techData, result.support_levels, result.resistance_levels]);

  const candles = techData?.candles ?? [];
  const visibleFactors = allFactors ? keyFactors : keyFactors.slice(0, PREVIEW_FACTORS);
  const r = t.result.ratings;

  // The two references the review may carry. The held plan's card goes
  // FIRST — above the new-entry call — because a reader who holds a position
  // reads that before anything else; the change card follows the hero.
  const held = positionReview?.reference?.held ?? null;
  const previous = positionReview?.reference?.previous ?? null;
  const heldPosition = held ? positions.find((p) => p.id === held.position_id) ?? null : null;
  // What the reader has already done with THIS plan. A plan they entered and
  // have since closed is not an unregistered plan, and offering the button
  // again would let a second position open on the same row.
  const registration = registrationFor(analysisId, positions);

  return (
    <div className="space-y-4">
      {positionReview && held && (
        <HeldPositionCard
          review={positionReview}
          held={held}
          pair={pair}
          interval={interval}
          freshSignal={result.signal}
          position={heldPosition}
          closed={closedHere && held && closedHere.id === held.position_id ? closedHere : null}
          onClosed={onPositionsChanged
            ? (closedPosition) => {
              setClosedHere(closedPosition);
              onPositionsChanged();
            }
            : undefined}
        />
      )}

      <DirectionHero
        result={result}
        pair={pair}
        interval={interval}
        entryCheck={entryCheck}
        confidenceObserved={confidenceObserved}
      />

      {positionReview && previous && positionReview.change && (
        <ChangeSinceLastCard
          review={positionReview}
          previous={previous}
          change={positionReview.change}
          pair={pair}
          heldExists={held !== null}
          onRegistered={onPositionsChanged ? () => onPositionsChanged() : undefined}
        />
      )}

      {candles.length > 0 && (
        <PriceChart
          candles={candles}
          entry={result.entry_point}
          stopLoss={result.stop_loss}
          takeProfits={[result.take_profit_1, result.take_profit_2, result.take_profit_3]}
          pair={pair}
          overlays={overlays}
          band={techData?.cloudBand
            ? { top: techData.cloudBand.top, bottom: techData.cloudBand.bottom, label: "cloud" }
            : null}
        />
      )}

      {/* Trade plan — a WAIT has no levels, and a card of dashes is not a plan */}
      {hasPlan && (
        <div className="glass rounded-xl border border-border p-4 space-y-3" data-testid="trade-plan">
          <div className="flex items-center gap-2 text-primary">
            <Target className="h-4 w-4" />
            <h3 className="text-sm font-semibold">{t.result.tradePlan}</h3>
            {registration.state === "open" && (
              <span className="ml-auto px-1.5 py-0.5 rounded border border-primary/40 bg-primary/10 text-[10px] text-primary" data-testid="registered-chip">
                {t.position.registeredChip}
              </span>
            )}
            {registration.state === "closed" && (
              <span className="ml-auto px-1.5 py-0.5 rounded border border-border bg-secondary text-[10px] text-muted-foreground" data-testid="closed-already-chip">
                {t.position.closedAlready(
                  registration.position.close_price === null ? "—" : String(registration.position.close_price),
                  registration.position.closed_at ?? "—",
                )}
              </span>
            )}
          </div>
          <div className="grid grid-cols-3 gap-3 text-sm font-mono">
            <div>
              <span className="text-[10px] text-muted-foreground">{t.result.entry}</span>
              <p className="text-primary font-semibold">{result.entry_point}</p>
            </div>
            <div>
              <span className="text-[10px] text-muted-foreground">{t.result.stopLoss}</span>
              <p className="text-destructive font-semibold">{result.stop_loss}</p>
              {stopDistance && (
                <p className="text-[10px] text-muted-foreground" data-testid="stop-distance">{stopDistance}</p>
              )}
            </div>
            <div>
              <span className="text-[10px] text-muted-foreground">{t.result.riskReward}</span>
              <p className="text-foreground font-semibold flex items-center gap-1">
                <TrendingUp className="h-3.5 w-3.5 text-primary" />
                {result.risk_reward_ratio}
              </p>
            </div>
            <div>
              <span className="text-[10px] text-muted-foreground">{t.result.tp1}</span>
              <p className="text-success font-semibold">{result.take_profit_1}</p>
              {tp1Distance && (
                <p className="text-[10px] text-muted-foreground" data-testid="tp1-distance">{tp1Distance}</p>
              )}
            </div>
            <div>
              <span className="text-[10px] text-muted-foreground">{t.result.tp2}</span>
              <p className="text-success font-semibold">{result.take_profit_2}</p>
            </div>
            <div>
              <span className="text-[10px] text-muted-foreground">{t.result.tp3}</span>
              <p className="text-success font-semibold">{result.take_profit_3 ?? "—"}</p>
            </div>
          </div>
          {/* "I entered on this plan." Only when the row exists to point at,
              and not twice. */}
          {analysisId !== null && registration.state === "none" && onPositionsChanged && (
            <div className="pt-1">
              <EntryRegistration
                analysisId={analysisId}
                pair={pair}
                defaultPrice={result.entry_point}
                onRegistered={() => onPositionsChanged()}
              />
            </div>
          )}
        </div>
      )}

      {/* Evidence: the factors the call rests on, then the model's ratings of
          itself in one quiet row. Five cards with bars gave those ratings the
          weight of a measurement, and nothing calibrates them. */}
      <div className="glass rounded-xl border border-border p-4 space-y-2" data-testid="evidence">
        <div className="flex items-center gap-2 text-primary">
          <ListChecks className="h-4 w-4" />
          <h3 className="text-sm font-semibold">{t.result.evidence}</h3>
        </div>
        {keyFactors.length > 0 && (
          <ul className="space-y-1">
            {visibleFactors.map((f, i) => (
              <li key={i} className="text-sm text-muted-foreground flex items-start gap-2">
                <span className="text-primary mt-0.5">•</span>
                <span>
                  {f}
                  {isInference(f) && <InferenceChip label={t.result.inferenceChip} />}
                </span>
              </li>
            ))}
          </ul>
        )}
        {keyFactors.length > PREVIEW_FACTORS && (
          <button
            type="button"
            onClick={() => setAllFactors((v) => !v)}
            className="flex items-center gap-1 text-[11px] text-primary hover:underline"
          >
            {allFactors ? <ChevronUp className="h-3 w-3" aria-hidden="true" /> : <ChevronDown className="h-3 w-3" aria-hidden="true" />}
            {allFactors ? t.result.showLess : t.result.showAll(keyFactors.length)}
          </button>
        )}
        {/* Said once, under the claims it applies to, rather than in a
            disclaimer nobody reads. The tag is decided from the rendered
            text, so it does not depend on the model having cooperated —
            and it reaches the rows written before any of this existed. */}
        {keyFactors.some(isInference) && (
          <p className="text-[10px] text-muted-foreground pt-1" data-testid="inference-note">
            {t.result.inferenceNote}
          </p>
        )}
        <div
          className="flex flex-wrap items-center gap-1.5 pt-2 border-t border-border/60"
          data-testid="self-ratings"
        >
          <span className="text-[10px] text-muted-foreground">{r.label}</span>
          <Chip>{`${r.technical} ${result.technical_score}`}</Chip>
          <Chip>{`${r.fundamental} ${result.fundamental_score}`}</Chip>
          <Chip>{`${r.risk} ${t.result.riskLevels[result.risk_level as keyof typeof t.result.riskLevels] ?? result.risk_level}`}</Chip>
          {/* Sentiment is always shown: making it conditional on ATR being a
              number meant the model's sentiment was discarded on every normal
              run, and the slot changed meaning between runs. */}
          <Chip>{t.result.sentiments[result.sentiment as keyof typeof t.result.sentiments] ?? result.sentiment}</Chip>
          {vol && <Chip>{`${r.volatility} ${t.result.volatilityLevels[vol.level]}`}</Chip>}
        </div>
      </div>

      {/* Warnings, minus the disclaimer the footer already carries and minus
          the refusal sentence the hero already shows */}
      {warnings.length > 0 && (
        <div className="rounded-xl border border-warning/30 bg-warning/5 p-4 space-y-2" data-testid="warnings">
          <div className="flex items-center gap-2 text-warning">
            <AlertTriangle className="h-4 w-4" />
            <h3 className="text-sm font-semibold">{t.result.warnings}</h3>
          </div>
          <ul className="space-y-1">
            {warnings.map((w, i) => (
              <li key={i} className="text-sm text-warning/80">
                ⚠ {w}
                {/* This box is the app's own voice to a reader. A model
                    speculation rendered in it — "watch for a move to hunt the
                    stops resting above the swing high" — reads as the app
                    warning them of something it observed. */}
                {isInference(w) && <InferenceChip label={t.result.inferenceChip} />}
              </li>
            ))}
          </ul>
        </div>
      )}

      {result.analysis && (
        <Disclosure icon={<FileText className="h-4 w-4" />} title={t.result.detail} testId="detail">
          <div className="text-sm text-muted-foreground whitespace-pre-wrap leading-relaxed">
            {result.analysis}
          </div>
          {isInference(result.analysis) && (
            <p className="text-[10px] text-muted-foreground pt-2" data-testid="analysis-inference-note">
              {t.result.inferenceNote}
            </p>
          )}
        </Disclosure>
      )}

      {hasMarketContext(result) && (
        <Disclosure icon={<Compass className="h-4 w-4" />} title={t.result.marketContext} testId="market-context-disclosure">
          <MarketContextCard result={result} />
        </Disclosure>
      )}

      <RuleFitPanel ruleFit={ruleFit ?? null} rulebook={rulebook ?? null} />
    </div>
  );
};

export default AnalysisResultView;
