import type { AnalysisResult } from "@/lib/types";
import { Compass } from "lucide-react";
import { useT } from "@/lib/i18n";
import { isInference } from "@/lib/inference";

interface Props {
  result: AnalysisResult;
}

const ROWS: { key: keyof NonNullable<AnalysisResult["market_context_detail"]>; label: string }[] = [
  { key: "mode", label: "Market Mode" },
  { key: "structure", label: "Structure" },
  // Kept visible rather than hidden — it is what the model said — but never
  // again in the same register as the computed rows. See INFERRED_ROWS.
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

// Rows that are claims about who is trading and why, not readings of price.
// The app has no order book, so no amount of confidence makes these
// observations. They render in a quieter register with a chip.
const INFERRED_ROWS: readonly string[] = ["smart_money"];

const MarketContextCard = ({ result }: Props) => {
  const t = useT();
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
            const inferred = INFERRED_ROWS.includes(key);
            return (
              <div key={key} className="flex items-center justify-between py-1.5 border-b border-border/50 last:border-0">
                <span className="text-xs text-muted-foreground">
                  {label}
                  {inferred && (
                    <span className="ml-1.5 rounded border border-warning/40 bg-warning/10 px-1 py-0.5 text-[9px] text-warning">
                      {t.result.inferenceChip}
                    </span>
                  )}
                </span>
                {/* Dropping smart_money from the schema's `required` list
                    changed nothing on screen: the model still emits it and
                    this card still painted it red or green in the same
                    register as Direction and Structure, which are computed.
                    The colour is what made it read as measured, so the colour
                    goes with the chip. */}
                <span className={`text-xs font-medium ${inferred ? "text-muted-foreground" : valueColor(key, value)}`}>
                  {value}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {result.market_context && (
        <div className="rounded-lg bg-secondary/60 border border-border p-3">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Summary</p>
          <p className="text-xs text-foreground leading-relaxed">{result.market_context}</p>
          {isInference(result.market_context) && (
            <p className="text-[10px] text-muted-foreground pt-1">{t.result.inferenceNote}</p>
          )}
        </div>
      )}

      {(supports.length > 0 || resistances.length > 0 ||
        (result.stop_hunt_zone && result.stop_hunt_zone !== "Not detected")) && (
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
          {/* A bare price range in the same visual register as Support and
              Resistance, which are levels price actually traded at. This one
              is a guess about where other people's orders are, and the app
              has never seen an order. It is labelled here rather than by the
              lexicon, because the string itself is just numbers. */}
          {result.stop_hunt_zone && result.stop_hunt_zone !== "Not detected" && (
            <div className="flex items-start justify-between text-xs gap-2">
              <span className="text-muted-foreground">
                Stop Hunt Zone
                <span className="ml-1.5 rounded border border-warning/40 bg-warning/10 px-1 py-0.5 text-[9px] text-warning">
                  {t.result.inferenceChip}
                </span>
              </span>
              <span className="font-mono text-muted-foreground">{result.stop_hunt_zone}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default MarketContextCard;
