import type { TechnicalData } from "@/lib/types";
import { BarChart3 } from "lucide-react";

interface Props {
  data: TechnicalData;
}

const Indicator = ({ label, value, warn }: { label: string; value: string; warn?: boolean }) => (
  <div className="flex items-center justify-between py-1.5 border-b border-border/50 last:border-0">
    <span className="text-xs text-muted-foreground">{label}</span>
    <span className={`text-xs font-mono font-medium ${warn ? "text-warning" : "text-foreground"}`}>
      {value}
    </span>
  </div>
);

const TechnicalDataCard = ({ data }: Props) => {
  const rsiNum = parseFloat(data.rsi);
  const rsiWarn = !isNaN(rsiNum) && (rsiNum > 70 || rsiNum < 30);
  const rsiNote = !isNaN(rsiNum) ? (rsiNum > 70 ? " (買われすぎ)" : rsiNum < 30 ? " (売られすぎ)" : "") : "";

  return (
    <div className="glass rounded-xl border border-border p-4 space-y-3 border-glow">
      <div className="flex items-center gap-2 text-primary">
        <BarChart3 className="h-4 w-4" />
        <h3 className="text-sm font-semibold">取得データサマリー</h3>
      </div>

      <div className="grid grid-cols-3 gap-3 mb-3">
        <div className="text-center">
          <p className="text-[10px] text-muted-foreground">現在レート</p>
          <p className="text-sm font-mono font-bold text-foreground">{data.price}</p>
        </div>
        <div className="text-center">
          <p className="text-[10px] text-muted-foreground">SMA20</p>
          <p className="text-sm font-mono font-bold text-foreground">{data.sma20}</p>
        </div>
        <div className="text-center">
          <p className="text-[10px] text-muted-foreground">ATR(14)</p>
          <p className="text-sm font-mono font-bold text-foreground">{data.atr}</p>
        </div>
      </div>

      <div className="space-y-0">
        <Indicator label="RSI(14)" value={`${data.rsi}${rsiNote}`} warn={rsiWarn} />
        <Indicator label="MACD" value={data.macd} />
        <Indicator label="MACD Signal" value={data.macdSignal} />
        <Indicator label="MACD Hist" value={data.macdHist} />
        <Indicator label="BB Upper" value={data.bbUpper} />
        <Indicator label="BB Middle" value={data.bbMiddle} />
        <Indicator label="BB Lower" value={data.bbLower} />
        <Indicator label="SMA50" value={data.sma50} />
        <Indicator label="SMA200" value={data.sma200} />
        <Indicator label="一目 転換線" value={data.tenkan} />
        <Indicator label="一目 基準線" value={data.kijun} />
        <Indicator label="一目 先行A" value={data.spanA} />
        <Indicator label="一目 先行B" value={data.spanB} />
        <Indicator label="Stoch %K" value={data.slowK} />
        <Indicator label="Stoch %D" value={data.slowD} />
        <Indicator label="ADX(14)" value={data.adx} />
      </div>
    </div>
  );
};

export default TechnicalDataCard;
