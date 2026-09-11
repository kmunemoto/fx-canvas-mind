import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n";

interface Props {
  signal: "BUY" | "SELL" | "WAIT";
  confidence: number;
  // DirectionHero already names the direction; inside it the gauge shows the
  // score alone so LONG/BUY are not both on screen for the same thing.
  showSignalLabel?: boolean;
  // Where this number has actually landed, from confidence_calibration()'s
  // span.traded. The ring is drawn on 0..100 and always will be — rescaling it
  // to the observed range would blow an eight-point spread out to a full
  // circle and manufacture a resolution the measured AUC does not support
  // (docs/CONFIDENCE_CALIBRATION.md 6-2). Saying the range instead is the
  // honest half. Absent for a reader with no settled trades of their own, and
  // then nothing is drawn — a range with no evidence behind it is not a range.
  observed?: { lo: number; hi: number; n: number } | null;
}

const ConfidenceGauge = ({ signal, confidence, showSignalLabel = true, observed = null }: Props) => {
  const t = useT();
  const [animatedConfidence, setAnimatedConfidence] = useState(0);

  useEffect(() => {
    const timer = setTimeout(() => setAnimatedConfidence(confidence), 100);
    return () => clearTimeout(timer);
  }, [confidence]);

  const circumference = 2 * Math.PI * 45;
  const offset = circumference - (animatedConfidence / 100) * circumference;

  const signalColor =
    signal === "BUY"
      ? "hsl(var(--success))"
      : signal === "SELL"
        ? "hsl(var(--destructive))"
        : "hsl(var(--warning))";

  // The gauge shows the same LONG/SHORT wording as the hero, never BUY/SELL,
  // so one direction never appears under two different names.
  const direction = t.direction[signal] ?? t.direction.WAIT;

  return (
    <div className="flex flex-col items-center">
      {/* A fixed 192px ring left a 390px phone with ~150px for the direction
          and the thesis beside it, so both wrapped to a column of scraps.
          The ring shrinks with the viewport instead. */}
      <div className="relative w-28 h-28 sm:w-32 sm:h-32 md:w-36 md:h-36">
        <svg className="w-full h-full -rotate-90" viewBox="0 0 100 100">
          <circle
            cx="50" cy="50" r="45"
            fill="none"
            stroke="hsl(var(--secondary))"
            strokeWidth="6"
          />
          <circle
            cx="50" cy="50" r="45"
            fill="none"
            stroke={signalColor}
            strokeWidth="6"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            className="transition-all duration-1500 ease-out"
            style={{ filter: `drop-shadow(0 0 6px ${signalColor})` }}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          {showSignalLabel && (
            <>
              <span
                className="text-3xl font-bold font-mono tracking-wider"
                style={{ color: signalColor }}
              >
                {direction.word}
              </span>
              <span className="text-xs font-semibold" style={{ color: signalColor }}>
                {direction.gloss}
              </span>
            </>
          )}
          <span
            className={`font-mono font-semibold text-foreground ${
              showSignalLabel ? "text-xl sm:text-2xl mt-1" : "text-2xl sm:text-3xl md:text-4xl"
            }`}
          >
            {animatedConfidence}%
          </span>
        </div>
      </div>
      <p className="text-[10px] sm:text-xs text-muted-foreground mt-1.5 sm:mt-2">{t.direction.confidence}</p>
      {observed && observed.n > 0 && (
        <p
          className="text-[9px] sm:text-[10px] text-muted-foreground/80 mt-0.5 text-center leading-snug"
          data-testid="confidence-observed-range"
        >
          {t.direction.confidenceObserved(observed.lo, observed.hi, observed.n)}
        </p>
      )}
    </div>
  );
};

export default ConfidenceGauge;
