import type { AnalysisResult, TechnicalData, AppSettings } from "@/lib/types";
import DirectionHero from "./DirectionHero";
import PriceChart from "./PriceChart";
import MarketContextCard from "./MarketContextCard";
import ScoreCard from "./ScoreCard";
import { AlertTriangle, Target, TrendingUp } from "lucide-react";
import { useT } from "@/lib/i18n";
import { canSizeInYen, positionSize } from "@/lib/position";
import type { Dict } from "@/lib/i18n/locales";

interface Props {
  result: AnalysisResult;
  techData?: TechnicalData | null;
  pair: string;
  interval: string;
  // Balance and risk appetite, for turning the plan's stop distance into a
  // size. Absent for a WAIT call, which has no levels to size against.
  settings?: AppSettings;
}

// The plan's own numbers arrive as display strings
const num = (v: string | undefined): number | null => {
  if (typeof v !== "string") return null;
  const n = Number(v.replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
};

const riskColor = (r: string) =>
  r === "LOW" ? "success" : r === "MEDIUM" ? "warning" : "destructive";
const sentimentColor = (s: string) =>
  s === "BULLISH" ? "success" : s === "NEUTRAL" ? "warning" : "destructive";

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

const AnalysisResultView = ({ result, techData, pair, interval, settings }: Props) => {
  const t = useT();
  // Size the trade off the plan's own stop distance, when there is a plan and
  // the pair's risk is denominated in the balance's currency
  const size = (() => {
    if (!settings || result.signal === "WAIT" || !canSizeInYen(pair)) return null;
    const entry = num(result.entry_point);
    const stop = num(result.stop_loss);
    if (entry === null || stop === null) return null;
    return positionSize({ balance: settings.accountBalance, riskPercent: settings.riskPercent, entry, stop, pair });
  })();
  const keyFactors = Array.isArray(result?.key_factors) ? result.key_factors : [];
  const warnings = Array.isArray(result?.warnings) ? result.warnings : [];
  const vol = volatilityText(techData);
  const candles = techData?.candles ?? [];

  return (
    <div className="space-y-4">
      <DirectionHero result={result} pair={pair} interval={interval} />

      {candles.length > 0 && (
        <PriceChart
          candles={candles}
          entry={result.entry_point}
          stopLoss={result.stop_loss}
          takeProfits={[result.take_profit_1, result.take_profit_2, result.take_profit_3]}
          pair={pair}
        />
      )}

      {/* Trade plan */}
      <div className="glass rounded-xl border border-border p-4 border-glow space-y-3">
        <div className="flex items-center gap-2 text-primary">
          <Target className="h-4 w-4" />
          <h3 className="text-sm font-semibold">{t.result.tradePlan}</h3>
        </div>
        <div className="grid grid-cols-3 gap-3 text-sm font-mono">
          <div>
            <span className="text-[10px] text-muted-foreground">{t.result.entry}</span>
            <p className="text-primary font-semibold">{result.entry_point}</p>
          </div>
          <div>
            <span className="text-[10px] text-muted-foreground">{t.result.stopLoss}</span>
            <p className="text-destructive font-semibold">{result.stop_loss}</p>
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

        {/* The market set the distance; this is the half the trader sets. */}
        {size !== null && (
          <div className="pt-2 border-t border-border/60" data-testid="position-size">
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="text-[11px] text-muted-foreground">{t.result.positionSize}</span>
              <span className="font-mono font-semibold text-foreground">
                {t.result.lots(size.lots, size.units)}
              </span>
            </div>
            <p className="text-[10px] text-muted-foreground mt-0.5">
              {t.result.riskLine(size.stopPips, size.riskAmount)}
            </p>
          </div>
        )}
        {size === null && settings && !canSizeInYen(pair) && (
          <p className="text-[10px] text-muted-foreground pt-2 border-t border-border/60">
            {t.result.noSizing(pair)}
          </p>
        )}
      </div>

      {/* Score cards */}
      <div className="grid grid-cols-2 gap-3">
        <ScoreCard title={t.result.technical} value={`${result.technical_score}/100`} score={result.technical_score} color="primary" />
        <ScoreCard title={t.result.fundamental} value={`${result.fundamental_score}/100`} score={result.fundamental_score} color="primary" />
        <ScoreCard
          title={t.result.risk}
          value={t.result.riskLevels[result.risk_level as keyof typeof t.result.riskLevels] ?? result.risk_level}
          color={riskColor(result.risk_level) as any}
        />
        {/* Sentiment is always shown: making it conditional on ATR being a
            number meant the model's sentiment was discarded on every normal
            run, and the card slot changed meaning between runs. */}
        <ScoreCard
          title={t.result.sentiment}
          value={t.result.sentiments[result.sentiment as keyof typeof t.result.sentiments] ?? result.sentiment}
          color={sentimentColor(result.sentiment) as any}
        />
        {vol && (
          <ScoreCard title={t.result.volatility} value={t.result.volatilityLevels[vol.level]} subtitle={`ATR ${vol.pct}% / price`} color="primary" />
        )}
      </div>

      <MarketContextCard result={result} />

      {/* Key factors */}
      {keyFactors.length > 0 && (
        <div className="glass rounded-xl border border-border p-4 space-y-2">
          <h3 className="text-sm font-semibold text-foreground">{t.result.keyFactors}</h3>
          <ul className="space-y-1">
            {keyFactors.map((f, i) => (
              <li key={i} className="text-sm text-muted-foreground flex items-start gap-2">
                <span className="text-primary mt-0.5">•</span> {f}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Detailed analysis */}
      <div className="glass rounded-xl border border-border p-4 space-y-2">
        <h3 className="text-sm font-semibold text-foreground">{t.result.detail}</h3>
        <div className="text-sm text-muted-foreground whitespace-pre-wrap leading-relaxed">
          {result.analysis}
        </div>
      </div>

      {/* Warnings */}
      {warnings.length > 0 && (
        <div className="rounded-xl border border-warning/30 bg-warning/5 p-4 space-y-2">
          <div className="flex items-center gap-2 text-warning">
            <AlertTriangle className="h-4 w-4" />
            <h3 className="text-sm font-semibold">{t.result.warnings}</h3>
          </div>
          <ul className="space-y-1">
            {warnings.map((w, i) => (
              <li key={i} className="text-sm text-warning/80">⚠ {w}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};

export default AnalysisResultView;
