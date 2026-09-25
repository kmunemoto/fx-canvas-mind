import { Sparkles } from "lucide-react";
import type { GainzSummary } from "@/lib/types";
import { useT } from "@/lib/i18n";
import { priceDecimals } from "@/lib/candleTime";

interface Props {
  summary: GainzSummary | null;
  pair: string;
}

// #112: the GainzAlgo V2 Alpha-style rule, beside the RSI/SAR card. It is
// shown, never used: the published signal is still RSI/SAR's. Every number
// is the server's (analyze/gainz.ts).
const GainzPanel = ({ summary, pair }: Props) => {
  const t = useT();
  const g = t.gainz;
  if (!summary) return null;
  const d = priceDecimals(pair);
  const intervals = t.control.intervals as Record<string, string>;
  const tfLabel = intervals[summary.tf] ?? summary.tf;
  const pct = (v: number | null) => (v === null ? 0 : Math.round(v * 100));
  const now = summary.now;
  const ev = summary.evidence;
  const measured = ev.tf.measured ? ev.tf : ev.all.measured ? ev.all : null;
  const fmt = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? "—" : v.toFixed(d));

  return (
    <div className="glass rounded-xl border border-border p-4 space-y-3" data-testid="gainz-panel">
      <div className="flex items-center gap-2 text-primary">
        <Sparkles className="h-4 w-4" />
        <h3 className="text-sm font-semibold">{g.title}</h3>
        <span className="ml-auto px-1.5 py-0.5 rounded border border-border text-[10px] text-muted-foreground">{tfLabel}</span>
      </div>
      <p className="text-[11px] text-muted-foreground">{g.rule}</p>
      <p className="text-[10px] text-muted-foreground">{g.origin}</p>

      {!summary.ok || !now ? (
        <p className="text-xs text-muted-foreground" data-testid="gainz-unavailable">{g.unavailable(summary.reason ?? "—")}</p>
      ) : (
        <>
          <div className="space-y-0.5" data-testid="gainz-now">
            <p className="text-xs font-semibold" data-testid="gainz-fired">
              {now.signal ? (
                <span className={now.signal === "BUY" ? "text-success" : "text-destructive"}>{g.fired(g.sides[now.signal])}</span>
              ) : (
                <span className="text-muted-foreground">{g.noSignal}</span>
              )}
            </p>
            {now.signal && now.plan && (
              <p className="text-[11px] font-mono text-muted-foreground" data-testid="gainz-plan">
                {g.plan(fmt(now.plan.entry), fmt(now.plan.stop), fmt(now.plan.target))}
              </p>
            )}
          </div>

          <div className="space-y-0.5" data-testid="gainz-window">
            <p className="text-[10px] text-muted-foreground">{g.windowTitle(summary.bars)}</p>
            <p className="text-xs font-mono">
              <span className="text-success">{g.tally(g.sides.BUY, summary.tally.BUY.n, summary.tally.BUY.wins, summary.tally.BUY.losses)}</span>
              <span className="text-muted-foreground"> / </span>
              <span className="text-destructive">{g.tally(g.sides.SELL, summary.tally.SELL.n, summary.tally.SELL.wins, summary.tally.SELL.losses)}</span>
            </p>
            <p className="text-[9px] text-muted-foreground">{g.method(summary.stop_atr, summary.reward_ratio, summary.horizon)}</p>
          </div>
        </>
      )}

      <div className="space-y-0.5 pt-2 border-t border-border/60" data-testid="gainz-evidence">
        <p className="text-[10px] text-muted-foreground">{g.evidenceTitle}</p>
        {measured === null ? (
          <p className="text-[11px] text-muted-foreground">{g.notMeasuredAll}</p>
        ) : (
          <>
            {!ev.tf.measured && <p className="text-[11px] text-muted-foreground">{g.notMeasured(tfLabel)}</p>}
            {measured.win !== null && measured.n !== null && measured.meanR !== null && (
              <p className="text-xs">{g.evidence(ev.period, ev.pairs, pct(measured.win), measured.n, pct(ev.breakeven), measured.meanR.toFixed(2))}</p>
            )}
            {measured.meanR !== null && <p className="text-[11px] text-warning">{g.verdict(measured.meanR)}</p>}
          </>
        )}
      </div>
    </div>
  );
};

export default GainzPanel;
