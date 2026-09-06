import type { TechnicalData } from "@/lib/types";
import { BarChart3 } from "lucide-react";
import { useT } from "@/lib/i18n";

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
  const t = useT();
  const rsiNum = parseFloat(data.rsi);
  const rsiWarn = !isNaN(rsiNum) && (rsiNum > 70 || rsiNum < 30);
  const rsiNote = !isNaN(rsiNum)
    ? rsiNum > 70
      ? t.technical.overbought
      : rsiNum < 30
        ? t.technical.oversold
        : ""
    : "";

  return (
    <div className="glass rounded-xl border border-border p-4 space-y-3 border-glow">
      <div className="flex items-center gap-2 text-primary">
        <BarChart3 className="h-4 w-4" />
        <h3 className="text-sm font-semibold">{t.technical.title}</h3>
      </div>

      <div className="grid grid-cols-3 gap-3 mb-3">
        <div className="text-center">
          <p className="text-[10px] text-muted-foreground">{t.technical.currentRate}</p>
          <p className="text-sm font-mono font-bold text-foreground">{data.price}</p>
          {data.barClosed === false && (
            <p className="text-[9px] text-warning">{t.technical.forming}</p>
          )}
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
        <Indicator label={t.technical.tenkan} value={data.tenkan} />
        <Indicator label={t.technical.kijun} value={data.kijun} />
        <Indicator label={t.technical.spanA} value={data.spanA} />
        <Indicator label={t.technical.spanB} value={data.spanB} />
        {data.cloudNowTop && <Indicator label={`${t.technical.cloudNow} 上`} value={data.cloudNowTop} />}
        {data.cloudNowBottom && <Indicator label={`${t.technical.cloudNow} 下`} value={data.cloudNowBottom} />}
        <Indicator label="Stoch %K" value={data.slowK} />
        <Indicator label="Stoch %D" value={data.slowD} />
        <Indicator label="ADX(14)" value={data.adx} />
      </div>

      {/* Which side of the cloud price is on — the one it is IN, not the one
          drawn 26 bars ahead. The panel used to show only the forward pair,
          so a reader checking "price is below the cloud" checked it against
          numbers price has not reached yet. */}
      {data.cloudSide && (
        <p className="text-[10px] text-muted-foreground" data-testid="cloud-side">
          {t.technical.cloudSides[data.cloudSide]}
        </p>
      )}
    </div>
  );
};

export default TechnicalDataCard;
