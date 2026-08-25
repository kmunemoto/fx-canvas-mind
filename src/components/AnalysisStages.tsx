import { useEffect, useState } from "react";
import { Lock } from "lucide-react";

interface Props {
  active: boolean;
}

const STAGES = ["STRUCTURE", "LEVELS", "TREND", "PRICES", "PLAN"];
// Seconds into the run at which each stage lights up. The last stage stays
// "running" until the response actually arrives — this is presentation only,
// the single API call does all the work server-side.
const STAGE_AT = [0, 5, 11, 18, 26];

const AnalysisStages = ({ active }: Props) => {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!active) {
      setElapsed(0);
      return;
    }
    const id = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(id);
  }, [active]);

  if (!active) return null;

  const currentIdx = STAGE_AT.filter((t) => elapsed >= t).length - 1;

  return (
    <div className="glass rounded-xl border border-border p-6 border-glow space-y-5">
      <div className="flex items-center justify-center gap-2">
        <Lock className="h-3.5 w-3.5 text-primary animate-pulse" />
        <span className="text-xs font-mono tracking-widest text-primary">
          SIGNAL ANALYSIS IN PROGRESS
        </span>
      </div>

      <div className="flex items-center justify-between relative px-2">
        <div className="absolute left-6 right-6 top-[7px] h-px bg-border" />
        {STAGES.map((label, i) => {
          const done = i < currentIdx;
          const current = i === currentIdx;
          return (
            <div key={label} className="relative flex flex-col items-center gap-2 z-10">
              <div
                className={`w-3.5 h-3.5 rounded-full border-2 transition-all duration-500 ${
                  done
                    ? "bg-primary border-primary"
                    : current
                      ? "bg-primary/30 border-primary animate-pulse"
                      : "bg-secondary border-border"
                }`}
                style={done || current ? { boxShadow: "0 0 8px hsl(var(--primary) / 0.6)" } : undefined}
              />
              <span
                className={`text-[9px] font-mono tracking-wider ${
                  done || current ? "text-primary" : "text-muted-foreground"
                }`}
              >
                {label}
              </span>
            </div>
          );
        })}
      </div>

      <p className="text-center text-xs text-muted-foreground">
        マルチタイムフレームの構造・レベル・トレンドを解析しています…
        <span className="font-mono ml-1">{elapsed}s</span>
      </p>
    </div>
  );
};

export default AnalysisStages;
