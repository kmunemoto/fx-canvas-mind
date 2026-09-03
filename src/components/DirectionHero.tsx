import type { AnalysisResult } from "@/lib/types";
import ConfidenceGauge from "./ConfidenceGauge";
import { useT } from "@/lib/i18n";

interface Props {
  result: AnalysisResult;
  pair: string;
  interval: string;
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

const DirectionHero = ({ result, pair, interval }: Props) => {
  const t = useT();
  const color = DIRECTION_COLOR[result.signal] ?? DIRECTION_COLOR.WAIT;
  const dir = t.direction[result.signal] ?? t.direction.WAIT;
  const alignment = Array.isArray(result.timeframe_alignment) ? result.timeframe_alignment : [];

  return (
    <div className="glass rounded-xl border border-border p-5 border-glow">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0 flex-1">
          <p className="text-[10px] text-muted-foreground uppercase tracking-widest">{t.direction.label}</p>
          {/* SHORT and LONG are the trader idiom and stay, but the plain-language
              gloss sits right beside them: reading SHORT as "buy" is the one
              mistake on this screen that costs real money. */}
          <div className="flex items-baseline gap-2 flex-wrap">
            <p
              className="text-4xl font-black font-mono tracking-tight leading-tight"
              style={{ color, textShadow: `0 0 24px ${color}` }}
            >
              {dir.word}
            </p>
            <p className="text-xl font-bold leading-tight" style={{ color }}>
              {dir.gloss}
            </p>
          </div>
          {result.thesis && (
            <p className="text-sm text-foreground mt-1 leading-snug">{result.thesis}</p>
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
        <div className="shrink-0 scale-[0.72] origin-right -my-6">
          <ConfidenceGauge signal={result.signal} confidence={result.confidence} showSignalLabel={false} />
        </div>
      </div>
    </div>
  );
};

export default DirectionHero;
