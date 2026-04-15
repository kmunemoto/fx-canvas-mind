import { useEffect, useState } from "react";

interface Props {
  signal: "BUY" | "SELL" | "WAIT";
  confidence: number;
}

const ConfidenceGauge = ({ signal, confidence }: Props) => {
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

  const signalLabel =
    signal === "BUY" ? "BUY" : signal === "SELL" ? "SELL" : "WAIT";

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
          <span
            className="text-3xl font-bold font-mono tracking-wider"
            style={{ color: signalColor }}
          >
            {signalLabel}
          </span>
          <span className="text-2xl font-mono font-semibold text-foreground mt-1">
            {animatedConfidence}%
          </span>
        </div>
      </div>
      <p className="text-xs text-muted-foreground mt-2">確信度スコア</p>
    </div>
  );
};

export default ConfidenceGauge;
