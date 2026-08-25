import type { AnalysisResult, TechnicalData } from "@/lib/types";
import DirectionHero from "./DirectionHero";
import PriceChart from "./PriceChart";
import MarketContextCard from "./MarketContextCard";
import ScoreCard from "./ScoreCard";
import { AlertTriangle, Target, TrendingUp } from "lucide-react";

interface Props {
  result: AnalysisResult;
  techData?: TechnicalData | null;
  pair: string;
  interval: string;
}

const riskColor = (r: string) =>
  r === "LOW" ? "success" : r === "MEDIUM" ? "warning" : "destructive";
const riskLabel = (r: string) =>
  r === "LOW" ? "低" : r === "MEDIUM" ? "中" : "高";
const sentimentLabel = (s: string) =>
  s === "BULLISH" ? "強気" : s === "NEUTRAL" ? "中立" : "弱気";
const sentimentColor = (s: string) =>
  s === "BULLISH" ? "success" : s === "NEUTRAL" ? "warning" : "destructive";

// ATR relative to price, as a rough volatility gauge
const volatilityText = (tech?: TechnicalData | null) => {
  if (!tech) return null;
  const atr = Number(tech.atr);
  const price = Number(tech.price);
  if (!Number.isFinite(atr) || !Number.isFinite(price) || price === 0) return null;
  const pct = (atr / price) * 100;
  const label = pct < 0.15 ? "Low" : pct < 0.4 ? "Medium" : "High";
  return { pct: pct.toFixed(2), label };
};

const AnalysisResultView = ({ result, techData, pair, interval }: Props) => {
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
          <h3 className="text-sm font-semibold">トレードプラン</h3>
        </div>
        <div className="grid grid-cols-3 gap-3 text-sm font-mono">
          <div>
            <span className="text-[10px] text-muted-foreground">エントリー</span>
            <p className="text-primary font-semibold">{result.entry_point}</p>
          </div>
          <div>
            <span className="text-[10px] text-muted-foreground">損切り</span>
            <p className="text-destructive font-semibold">{result.stop_loss}</p>
          </div>
          <div>
            <span className="text-[10px] text-muted-foreground">R:R比</span>
            <p className="text-foreground font-semibold flex items-center gap-1">
              <TrendingUp className="h-3.5 w-3.5 text-primary" />
              {result.risk_reward_ratio}
            </p>
          </div>
          <div>
            <span className="text-[10px] text-muted-foreground">利確 TP1</span>
            <p className="text-success font-semibold">{result.take_profit_1}</p>
          </div>
          <div>
            <span className="text-[10px] text-muted-foreground">利確 TP2</span>
            <p className="text-success font-semibold">{result.take_profit_2}</p>
          </div>
          <div>
            <span className="text-[10px] text-muted-foreground">利確 TP3</span>
            <p className="text-success font-semibold">{result.take_profit_3 ?? "—"}</p>
          </div>
        </div>
      </div>

      {/* Score cards */}
      <div className="grid grid-cols-2 gap-3">
        <ScoreCard title="テクニカル" value={`${result.technical_score}/100`} score={result.technical_score} color="primary" />
        <ScoreCard title="ファンダメンタル" value={`${result.fundamental_score}/100`} score={result.fundamental_score} color="primary" />
        <ScoreCard
          title="リスク評価"
          value={riskLabel(result.risk_level)}
          color={riskColor(result.risk_level) as any}
        />
        {vol ? (
          <ScoreCard title="ボラティリティ" value={vol.label} subtitle={`ATR ${vol.pct}% / price`} color="primary" />
        ) : (
          <ScoreCard
            title="センチメント"
            value={sentimentLabel(result.sentiment)}
            color={sentimentColor(result.sentiment) as any}
          />
        )}
      </div>

      <MarketContextCard result={result} />

      {/* Key factors */}
      {keyFactors.length > 0 && (
        <div className="glass rounded-xl border border-border p-4 space-y-2">
          <h3 className="text-sm font-semibold text-foreground">判断の主要因</h3>
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
        <h3 className="text-sm font-semibold text-foreground">詳細分析</h3>
        <div className="text-sm text-muted-foreground whitespace-pre-wrap leading-relaxed">
          {result.analysis}
        </div>
      </div>

      {/* Warnings */}
      {warnings.length > 0 && (
        <div className="rounded-xl border border-warning/30 bg-warning/5 p-4 space-y-2">
          <div className="flex items-center gap-2 text-warning">
            <AlertTriangle className="h-4 w-4" />
            <h3 className="text-sm font-semibold">注意事項</h3>
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
