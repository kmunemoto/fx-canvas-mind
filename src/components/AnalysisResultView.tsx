import type { AnalysisResult } from "@/lib/types";
import ConfidenceGauge from "./ConfidenceGauge";
import ScoreCard from "./ScoreCard";
import { AlertTriangle, Target, TrendingUp } from "lucide-react";

interface Props {
  result: AnalysisResult;
}

const riskColor = (r: string) =>
  r === "LOW" ? "success" : r === "MEDIUM" ? "warning" : "destructive";
const riskLabel = (r: string) =>
  r === "LOW" ? "低" : r === "MEDIUM" ? "中" : "高";
const sentimentLabel = (s: string) =>
  s === "BULLISH" ? "強気" : s === "NEUTRAL" ? "中立" : "弱気";
const sentimentColor = (s: string) =>
  s === "BULLISH" ? "success" : s === "NEUTRAL" ? "warning" : "destructive";

const AnalysisResultView = ({ result }: Props) => (
  <div className="space-y-6">
    {/* Signal gauge */}
    <div className="glass rounded-xl border border-border p-6 flex justify-center border-glow">
      <ConfidenceGauge signal={result.signal} confidence={result.confidence} />
    </div>

    {/* Score cards */}
    <div className="grid grid-cols-2 gap-3">
      <ScoreCard title="テクニカル" value={`${result.technical_score}/100`} color="primary" />
      <ScoreCard title="ファンダメンタル" value={`${result.fundamental_score}/100`} color="primary" />
      <ScoreCard
        title="リスク評価"
        value={riskLabel(result.risk_level)}
        color={riskColor(result.risk_level) as any}
      />
      <ScoreCard
        title="市場センチメント"
        value={sentimentLabel(result.sentiment)}
        color={sentimentColor(result.sentiment) as any}
      />
    </div>

    {/* Recommended action */}
    <div className="glass rounded-xl border border-border p-4 border-glow space-y-3">
      <div className="flex items-center gap-2 text-primary">
        <Target className="h-4 w-4" />
        <h3 className="text-sm font-semibold">推奨アクション</h3>
      </div>
      <div className="grid grid-cols-2 gap-3 text-sm font-mono">
        <div>
          <span className="text-xs text-muted-foreground">エントリー</span>
          <p className="text-foreground">{result.entry_point}</p>
        </div>
        <div>
          <span className="text-xs text-muted-foreground">損切り</span>
          <p className="text-destructive">{result.stop_loss}</p>
        </div>
        <div>
          <span className="text-xs text-muted-foreground">利確①</span>
          <p className="text-success">{result.take_profit_1}</p>
        </div>
        <div>
          <span className="text-xs text-muted-foreground">利確②</span>
          <p className="text-success">{result.take_profit_2}</p>
        </div>
      </div>
      <div className="flex items-center gap-2 pt-2 border-t border-border">
        <TrendingUp className="h-4 w-4 text-primary" />
        <span className="text-sm text-muted-foreground">リスクリワード比:</span>
        <span className="text-sm font-mono font-semibold text-foreground">{result.risk_reward_ratio}</span>
      </div>
    </div>

    {/* Key factors */}
    {result.key_factors.length > 0 && (
      <div className="glass rounded-xl border border-border p-4 space-y-2">
        <h3 className="text-sm font-semibold text-foreground">判断の主要因</h3>
        <ul className="space-y-1">
          {result.key_factors.map((f, i) => (
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
    {result.warnings.length > 0 && (
      <div className="rounded-xl border border-warning/30 bg-warning/5 p-4 space-y-2">
        <div className="flex items-center gap-2 text-warning">
          <AlertTriangle className="h-4 w-4" />
          <h3 className="text-sm font-semibold">注意事項</h3>
        </div>
        <ul className="space-y-1">
          {result.warnings.map((w, i) => (
            <li key={i} className="text-sm text-warning/80">⚠ {w}</li>
          ))}
        </ul>
      </div>
    )}
  </div>
);

export default AnalysisResultView;
