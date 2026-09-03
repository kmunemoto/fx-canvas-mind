import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n";

interface Props {
  signal: "BUY" | "SELL" | "WAIT";
  confidence: number;
  // DirectionHero already names the direction; inside it the gauge shows the
  // score alone so LONG/BUY are not both on screen for the same thing.
  showSignalLabel?: boolean;
}

const ConfidenceGauge = ({ signal, confidence, showSignalLabel = true }: Props) => {
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
      <div className="relative w-48 h-48">
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
            className={`font-mono font-semibold text-foreground ${showSignalLabel ? "text-2xl mt-1" : "text-4xl"}`}
          >
            {animatedConfidence}%
          </span>
        </div>
      </div>
      <p className="text-xs text-muted-foreground mt-2">{t.direction.confidence}</p>
    </div>
  );
};

export default ConfidenceGauge;
