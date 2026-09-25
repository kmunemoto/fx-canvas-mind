import type { TechnicalData } from "@/lib/types";
import { BarChart3 } from "lucide-react";
import { useT } from "@/lib/i18n";

interface Props {
  data: TechnicalData;
}

const Row = ({ label, value, tone }: { label: string; value: string; tone?: "warn" | "buy" | "sell" }) => (
  <div className="flex items-center justify-between py-1.5 border-b border-border/50 last:border-0">
    <span className="text-xs text-muted-foreground">{label}</span>
    <span
      className={`text-xs font-mono font-medium ${
        tone === "warn" ? "text-warning" : tone === "buy" ? "text-success" : tone === "sell" ? "text-destructive" : "text-foreground"
      }`}
    >
      {value}
    </span>
  </div>
);

// #104: the numbers the analysis actually uses and nothing else — the rate,
// RSI(14) and the Parabolic SAR it decides on, and the ATR the stop and target
// are measured in. The eighteen-row table of averages, bands, the cloud,
// MACD, the stochastic and ADX went with the analysis that read them.
const TechnicalDataCard = ({ data }: Props) => {
  const t = useT();
  const now = data.rsiSar?.now ?? null;
  const rsi = now?.rsi ?? null;
  const rsiNote = rsi === null ? "" : rsi >= 70 ? t.technical.overbought : rsi <= 30 ? t.technical.oversold : "";
  const decimals = data.price.includes(".") ? data.price.split(".")[1].length : 3;

  return (
    <div className="glass rounded-xl border border-border p-4 space-y-3" data-testid="technical-data-card">
      <div className="flex items-center gap-2 text-primary">
        <BarChart3 className="h-4 w-4" />
        <h3 className="text-sm font-semibold">{t.technical.title}</h3>
      </div>

      <div className="text-center">
        <p className="text-[10px] text-muted-foreground">{t.technical.currentRate}</p>
        <p className="text-sm font-mono font-bold text-foreground">{data.price}</p>
        {data.barClosed === false && <p className="text-[9px] text-warning">{t.technical.forming}</p>}
      </div>

      <div className="space-y-0">
        <Row
          label="RSI(14)"
          value={rsi === null ? "—" : `${rsi.toFixed(1)}${rsiNote}`}
          tone={rsi !== null && (rsi >= 70 || rsi <= 30) ? "warn" : undefined}
        />
        <Row
          label={t.technical.sar}
          value={now?.sar === null || now?.sar === undefined || now.sar_below === null
            ? "—"
            : `${now.sar.toFixed(decimals)} ${t.technical.sarSide(now.sar_below)}`}
          tone={now?.sar_below === true ? "buy" : now?.sar_below === false ? "sell" : undefined}
        />
        <Row label={t.technical.atr} value={data.atr} />
      </div>
      <p className="text-[9px] text-muted-foreground">{t.technical.closedNote}</p>
    </div>
  );
};

export default TechnicalDataCard;
