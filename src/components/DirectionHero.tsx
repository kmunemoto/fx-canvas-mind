import type { AnalysisResult, EntryCheck } from "@/lib/types";
import ConfidenceGauge from "./ConfidenceGauge";
import { useT } from "@/lib/i18n";
import { isInference } from "@/lib/inference";
import { waitReasonOf } from "@/lib/warnings";

interface Props {
  result: AnalysisResult;
  pair: string;
  interval: string;
  // The entry gate's verdict on this run. On a WAIT it says why — and who
  // decided — which used to reach the reader only as the first warning.
  entryCheck?: EntryCheck | null;
}

const DIRECTION_COLOR = {
  BUY: "hsl(var(--success))",
  SELL: "hsl(var(--destructive))",
  WAIT: "hsl(var(--warning))",
} as const;

const biasArrow = (bias: string) =>
  bias === "BULLISH" ? "↑" : bias === "BEARISH" ? "↓" : "→";
const biasColor = (bias: string) =>
  bias === "BULLISH" ? "text-success" : bias === "BEARISH" ? "text-destructive" : "text-warning";

const DirectionHero = ({ result, pair, interval, entryCheck }: Props) => {
  const t = useT();
  const color = DIRECTION_COLOR[result.signal] ?? DIRECTION_COLOR.WAIT;
  const dir = t.direction[result.signal] ?? t.direction.WAIT;
  const alignment = Array.isArray(result.timeframe_alignment) ? result.timeframe_alignment : [];

  // Read from the structure, never from the warning text: the same string
  // used to make a model WAIT read as a server override (outcomeStats.ts).
  const waitReason = waitReasonOf(result.signal, entryCheck);
  const reason = (() => {
    if (!waitReason || !entryCheck) return null;
    const g = t.history.gate;
    const w = t.result.waitReason;
    const { rejection } = waitReason;
    // The number the gate measured, without which "too tight" is a verdict
    // with no evidence — the server's sentence carried it and is dropped
    // from the warnings now that the reason is here
    const measured = (() => {
      const { risk_reward: rr, stop_atr, distance_atr, confidence, confidence_floor } = entryCheck;
      switch (rejection) {
        case "poor_rr":
        case "target_out_of_reach":
          return typeof rr === "number" ? `1:${rr}` : null;
        case "stop_too_tight":
          return typeof stop_atr === "number" ? w.atrMultiple(stop_atr) : null;
        case "too_far":
          return typeof distance_atr === "number" ? w.atrMultiple(distance_atr) : null;
        case "low_confidence":
          return typeof confidence === "number" && typeof confidence_floor === "number"
            ? w.confidence(confidence, confidence_floor)
            : null;
        default:
          return null;
      }
    })();
    if (waitReason.kind === "declined") {
      // A WAIT the model chose while the market was shut is explained by the
      // preview banner above this card; a line here would say it a second
      // time. The server's sentence still leaves the warnings (the banner
      // covers it), which is why the caller sees a reason even when this
      // renders nothing.
      if (rejection === "market_closed") return null;
      // The confidence floor is the one rejection stamped on a WAIT the model
      // chose itself; the gate's label for it describes an override, so it is
      // not reused here. One line: the sentence already names the decider.
      return {
        text: rejection === "low_confidence" ? w.ownLowConfidence : g.declinedSummary,
        measured,
        who: null,
      };
    }
    const labelled = rejection in g.reasons ? g.reasons[rejection as keyof typeof g.reasons] : null;
    const proposed = t.direction[waitReason.proposed];
    const refused = w.refused(proposed.word, proposed.gloss);
    return labelled
      ? { text: labelled, measured, who: refused }
      : { text: refused, measured, who: null };
  })();

  return (
    <div className="glass rounded-xl border border-border p-4 sm:p-5 border-glow">
      <div className="flex items-center justify-between gap-3 sm:gap-4">
        <div className="min-w-0 flex-1">
          <p className="text-[10px] text-muted-foreground uppercase tracking-widest">{t.direction.label}</p>
          {/* SHORT and LONG are the trader idiom and stay, but the plain-language
              gloss sits right beside them: reading SHORT as "buy" is the one
              mistake on this screen that costs real money. */}
          <div className="flex items-baseline gap-2 flex-wrap">
            <p
              className="text-3xl sm:text-4xl font-black font-mono tracking-tight leading-tight"
              style={{ color, textShadow: `0 0 24px ${color}` }}
            >
              {dir.word}
            </p>
            <p className="text-lg sm:text-xl font-bold leading-tight" style={{ color }}>
              {dir.gloss}
            </p>
          </div>
          {reason && (
            <div className="mt-1.5 leading-snug" data-testid="wait-reason">
              <p className="text-xs">
                <span className="text-[10px] text-muted-foreground mr-1.5">{t.result.waitReason.label}</span>
                <span className="text-warning">{reason.text}</span>
                {reason.measured && (
                  <span className="ml-1.5 font-mono text-[10px] text-muted-foreground" data-testid="wait-reason-measured">
                    {reason.measured}
                  </span>
                )}
              </p>
              {reason.who && <p className="text-[10px] text-muted-foreground mt-0.5">{reason.who}</p>}
            </div>
          )}
          {result.thesis && (
            <p className="text-sm text-foreground mt-1 leading-snug">
              {result.thesis}
              {/* The thesis is the largest prose on this screen and the only
                  prose that follows the row into the history list, so it is
                  the sentence most readers actually read — and it was the one
                  the tag did not touch. */}
              {isInference(result.thesis) && (
                <span className="ml-1.5 align-middle rounded border border-warning/40 bg-warning/10 px-1 py-0.5 text-[9px] text-warning">
                  {t.result.inferenceChip}
                </span>
              )}
            </p>
          )}
          <div className="flex items-center gap-2 mt-3 flex-wrap">
            <span className="px-2 py-0.5 rounded-md bg-secondary text-[11px] font-mono font-semibold text-foreground">
              {pair}
            </span>
            <span className="px-2 py-0.5 rounded-md bg-secondary text-[11px] font-mono text-muted-foreground">
              {interval}
            </span>
            {alignment.map((tf) => (
              <span
                key={tf.timeframe}
                title={tf.note}
                className="px-2 py-0.5 rounded-md bg-secondary text-[11px] font-mono"
              >
                <span className="text-muted-foreground">{tf.timeframe}</span>{" "}
                <span className={`font-bold ${biasColor(tf.bias)}`}>{biasArrow(tf.bias)}</span>
              </span>
            ))}
          </div>
        </div>
        <div className="shrink-0">
          <ConfidenceGauge signal={result.signal} confidence={result.confidence} showSignalLabel={false} />
        </div>
      </div>
    </div>
  );
};

export default DirectionHero;
