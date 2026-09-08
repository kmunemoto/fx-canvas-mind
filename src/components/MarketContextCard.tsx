import type { AnalysisResult } from "@/lib/types";
import { useT } from "@/lib/i18n";
import { isInference } from "@/lib/inference";
import type { Dict } from "@/lib/i18n/locales";
import { hasMarketContext, stopHuntOf } from "@/lib/marketContext";

interface Props {
  result: AnalysisResult;
}

// Row key on the server document → label key in the dictionary. The labels
// were English literals until the owner read "Market Mode" and "Smart Money"
// in the middle of a Japanese screen; the VALUES stay the server's fixed
// English terms, as its prompt says they may.
const ROWS: { key: keyof NonNullable<AnalysisResult["market_context_detail"]>; label: keyof Dict["context"] }[] = [
  { key: "mode", label: "mode" },
  { key: "structure", label: "structure" },
  // Kept visible rather than hidden — it is what the model said — but never
  // again in the same register as the computed rows. See INFERRED_ROWS.
  { key: "smart_money", label: "smartMoney" },
  { key: "strength", label: "strength" },
  { key: "session", label: "session" },
  { key: "direction", label: "direction" },
  { key: "continuity", label: "continuity" },
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

// The body of the "market context and levels" disclosure. It is content, not
// a card: the caller owns the frame and the title.
const MarketContextCard = ({ result }: Props) => {
  const t = useT();
  const c = t.context;
  const detail = result.market_context_detail;
  const supports = Array.isArray(result.support_levels) ? result.support_levels : [];
  const resistances = Array.isArray(result.resistance_levels) ? result.resistance_levels : [];
  const stopHunt = stopHuntOf(result);

  if (!hasMarketContext(result)) return null;

  return (
    <div className="space-y-3" data-testid="market-context">
      {detail && (
        <div className="space-y-0">
          {ROWS.map(({ key, label }) => {
            const value = typeof detail[key] === "string" ? detail[key] : "";
            if (!value) return null;
            const inferred = INFERRED_ROWS.includes(key);
            return (
              <div key={key} className="flex items-center justify-between py-1.5 border-b border-border/50 last:border-0">
                <span className="text-xs text-muted-foreground">
                  {c[label]}
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
          <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">{c.summary}</p>
          <p className="text-xs text-foreground leading-relaxed">{result.market_context}</p>
          {isInference(result.market_context) && (
            <p className="text-[10px] text-muted-foreground pt-1">{t.result.inferenceNote}</p>
          )}
        </div>
      )}

      {(supports.length > 0 || resistances.length > 0 || stopHunt) && (
        <div className="space-y-1.5 pt-1">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wider">{c.levels}</p>
          {resistances.length > 0 && (
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">{c.resistance}</span>
              <span className="font-mono text-destructive">{resistances.slice(0, 3).join(" / ")}</span>
            </div>
          )}
          {supports.length > 0 && (
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">{c.support}</span>
              <span className="font-mono text-success">{supports.slice(0, 3).join(" / ")}</span>
            </div>
          )}
          {/* A bare price range in the same visual register as Support and
              Resistance, which are levels price actually traded at. This one
              is a guess about where other people's orders are, and the app
              has never seen an order. It is labelled here rather than by the
              lexicon, because the string itself is just numbers. */}
          {stopHunt && (
            <div className="flex items-start justify-between text-xs gap-2">
              <span className="text-muted-foreground">
                {c.stopHunt}
                <span className="ml-1.5 rounded border border-warning/40 bg-warning/10 px-1 py-0.5 text-[9px] text-warning">
                  {t.result.inferenceChip}
                </span>
              </span>
              <span className="font-mono text-muted-foreground">{stopHunt}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default MarketContextCard;
