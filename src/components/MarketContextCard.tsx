import type { AnalysisResult } from "@/lib/types";
import { Compass } from "lucide-react";

interface Props {
  result: AnalysisResult;
}

const ROWS: { key: keyof NonNullable<AnalysisResult["market_context_detail"]>; label: string }[] = [
  { key: "mode", label: "Market Mode" },
  { key: "structure", label: "Structure" },
  { key: "smart_money", label: "Smart Money" },
  { key: "strength", label: "Strength" },
  { key: "session", label: "Session" },
  { key: "direction", label: "Direction" },
  { key: "continuity", label: "Continuity" },
];

const valueColor = (key: string, value: string) => {
  if (key === "direction") {
    return value === "Up" ? "text-success" : value === "Down" ? "text-destructive" : "text-warning";
  }
  if (key === "smart_money") {
    return value === "Accumulation" ? "text-success" : value === "Distribution" ? "text-destructive" : "text-foreground";
  }
  return "text-foreground";
};

const MarketContextCard = ({ result }: Props) => {
  const detail = result.market_context_detail;
  const supports = Array.isArray(result.support_levels) ? result.support_levels : [];
  const resistances = Array.isArray(result.resistance_levels) ? result.resistance_levels : [];

  if (!detail && !result.market_context && supports.length === 0) return null;

  return (
    <div className="glass rounded-xl border border-border p-4 space-y-3">
      <div className="flex items-center gap-2 text-primary">
        <Compass className="h-4 w-4" />
        <h3 className="text-sm font-semibold">Market Context</h3>
      </div>

      {detail && (
        <div className="space-y-0">
          {ROWS.map(({ key, label }) => {
            const value = typeof detail[key] === "string" ? detail[key] : "";
            if (!value) return null;
            return (
              <div key={key} className="flex items-center justify-between py-1.5 border-b border-border/50 last:border-0">
                <span className="text-xs text-muted-foreground">{label}</span>
                <span className={`text-xs font-medium ${valueColor(key, value)}`}>{value}</span>
              </div>
            );
          })}
        </div>
      )}

      {result.market_context && (
        <div className="rounded-lg bg-secondary/60 border border-border p-3">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Summary</p>
          <p className="text-xs text-foreground leading-relaxed">{result.market_context}</p>
        </div>
      )}

      {(supports.length > 0 || resistances.length > 0 || result.stop_hunt_zone) && (
        <div className="space-y-1.5 pt-1">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Key Technical Levels</p>
          {resistances.length > 0 && (
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">Resistance</span>
              <span className="font-mono text-destructive">{resistances.slice(0, 3).join(" / ")}</span>
            </div>
          )}
          {supports.length > 0 && (
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">Support</span>
              <span className="font-mono text-success">{supports.slice(0, 3).join(" / ")}</span>
            </div>
          )}
          {result.stop_hunt_zone && (
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">Stop Hunt Zone</span>
              <span className="font-mono text-foreground">{result.stop_hunt_zone}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default MarketContextCard;
