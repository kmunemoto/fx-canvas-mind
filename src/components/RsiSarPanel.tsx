import { Activity } from "lucide-react";
import type { RsiSarSummary, RsiSarTrigger } from "@/lib/types";
import { useT } from "@/lib/i18n";
import { formatDistance, isGoldPair, priceDecimals } from "@/lib/candleTime";

interface Props {
  summary: RsiSarSummary | null;
  // The published signal. The next-close advice is shown on a WAIT only: on
  // a BUY or SELL the plan card already says what to do.
  signal: "BUY" | "SELL" | "WAIT";
  pair: string;
  // The live price the distances are measured from (the forming bar's)
  price: number | null;
}

// #104: the whole analysis, in one card. RSI(14) and the Parabolic SAR as the
// server read them on the entry timeframe's closed bars; whether the rule
// fired on the newest one; on a WAIT, the prices the next close has to reach
// for it to fire; how the rule did on this chart; and how it did when it was
// tested. Every number is the server's (analyze/rsisar.ts) — nothing here was
// written by the model.
const RsiSarPanel = ({ summary, signal, pair, price }: Props) => {
  const t = useT();
  const r = t.rsiSar;
  if (!summary) return null;
  const d = priceDecimals(pair);
  const fmt = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? "—" : v.toFixed(d));
  const from = price ?? summary.now?.close ?? null;
  const dist = (v: number | null) => {
    if (v === null || from === null) return "—";
    return formatDistance(pair, v - from, { signed: true, digits: 1 });
  };
  const intervals = t.control.intervals as Record<string, string>;
  const tfLabel = intervals[summary.tf] ?? summary.tf;
  const pct = (v: number | null) => (v === null ? 0 : Math.round(v * 100));
  const now = summary.now;
  const next = summary.next;

  const triggerText = (tr: RsiSarTrigger) => {
    if (tr.ready) {
      const parts = [r.ready[tr.side](fmt(tr.complete_close), dist(tr.complete_close))];
      if (tr.sar_on_side && tr.sar_level !== null) parts.push(r.holdSar[tr.side](fmt(tr.sar_level)));
      return parts.join(" ");
    }
    return r.notReady[tr.side](fmt(tr.rsi_close), dist(tr.rsi_close), fmt(tr.sar_level));
  };

  const ev = summary.evidence;
  const measured = ev.tf.measured ? ev.tf : ev.all;

  return (
    <div className="glass rounded-xl border border-border p-4 space-y-3" data-testid="rsi-sar-panel">
      <div className="flex items-center gap-2 text-primary">
        <Activity className="h-4 w-4" />
        <h3 className="text-sm font-semibold">{r.title}</h3>
        <span className="ml-auto px-1.5 py-0.5 rounded border border-border text-[10px] text-muted-foreground">{tfLabel}</span>
      </div>
      <p className="text-[11px] text-muted-foreground">{r.rule}</p>

      {!summary.ok || !now ? (
        <p className="text-xs text-muted-foreground" data-testid="rsi-sar-unavailable">{r.unavailable(summary.reason ?? "—")}</p>
      ) : (
        <>
          <div className="space-y-0.5" data-testid="rsi-sar-now">
            <p className="text-[10px] text-muted-foreground">{r.nowTitle}</p>
            <p className={`text-sm font-mono ${now.rsi !== null && (now.rsi <= 30 || now.rsi >= 70) ? "text-warning" : "text-foreground"}`}>
              {r.rsi(now.rsi_prev === null ? "—" : now.rsi_prev.toFixed(1), now.rsi === null ? "—" : now.rsi.toFixed(1))}
            </p>
            {now.sar !== null && now.sar_below !== null && (
              <p className={`text-sm font-mono ${now.sar_below ? "text-success" : "text-destructive"}`}>
                {r.sar(fmt(now.sar), now.sar_below)}
              </p>
            )}
            <p className="text-xs font-semibold" data-testid="rsi-sar-fired">
              {now.signal ? (
                <span className={now.signal === "BUY" ? "text-success" : "text-destructive"}>{r.fired(r.sides[now.signal])}</span>
              ) : (
                <span className="text-muted-foreground">{r.noSignal}</span>
              )}
            </p>
          </div>

          {signal === "WAIT" && next && (
            <div className="rounded-lg border border-primary/30 bg-primary/5 p-3 space-y-2" data-testid="rsi-sar-advice">
              <p className="text-xs font-semibold text-primary">{r.adviceTitle}</p>
              {[next.buy, next.sell].map((tr) => (
                <div key={tr.side} className="space-y-0.5" data-testid={`rsi-sar-trigger-${tr.side}`}>
                  <p className="text-xs">
                    <span className={`font-mono font-bold mr-1.5 ${tr.side === "BUY" ? "text-success" : "text-destructive"}`}>{r.sides[tr.side]}</span>
                    <span className="text-foreground">{triggerText(tr)}</span>
                  </p>
                  {tr.ready && tr.plan && (
                    <p className="text-[11px] font-mono text-muted-foreground" data-testid={`rsi-sar-plan-${tr.side}`}>
                      {r.plan(fmt(tr.plan.entry), fmt(tr.plan.stop), fmt(tr.plan.target))}
                    </p>
                  )}
                </div>
              ))}
              {next.close?.costly && (
                <p className="text-[11px] text-warning" data-testid="rsi-sar-costly-next">
                  {r.costlyNext((new Date(next.close.at).getUTCHours() + 9) % 24)}
                </p>
              )}
              <p className="text-[10px] text-muted-foreground">{r.adviceNote}</p>
            </div>
          )}

          <div className="space-y-0.5" data-testid="rsi-sar-window">
            <p className="text-[10px] text-muted-foreground">{r.windowTitle(summary.bars)}</p>
            <p className="text-xs font-mono">
              <span className="text-success">{r.tally(r.sides.BUY, summary.tally.BUY.n, summary.tally.BUY.wins, summary.tally.BUY.losses)}</span>
              <span className="text-muted-foreground"> / </span>
              <span className="text-destructive">{r.tally(r.sides.SELL, summary.tally.SELL.n, summary.tally.SELL.wins, summary.tally.SELL.losses)}</span>
            </p>
            <p className="text-[9px] text-muted-foreground">{r.method(summary.stop_atr, summary.reward_ratio, summary.horizon)}</p>
          </div>
        </>
      )}

      <div className="space-y-0.5 pt-2 border-t border-border/60" data-testid="rsi-sar-evidence">
        <p className="text-[10px] text-muted-foreground">{r.evidenceTitle}</p>
        {!ev.tf.measured && <p className="text-[11px] text-muted-foreground">{r.notMeasured(tfLabel)}</p>}
        {isGoldPair(pair) && <p className="text-[11px] text-warning" data-testid="rsi-sar-evidence-gold">{t.result.evidenceNotGold}</p>}
        {measured.win !== null && measured.winN !== null && (
          <p className="text-xs">{r.evidence(ev.period, ev.pairs, pct(measured.win), measured.winN, pct(ev.breakeven.win))}</p>
        )}
        {measured.hit !== null && measured.hitN !== null && (
          <p className="text-xs">{r.hit(pct(measured.hit), measured.hitN, pct(ev.blind.hit))}</p>
        )}
        <p className="text-[11px] text-warning">{r.belowBreakeven}</p>
      </div>
    </div>
  );
};

export default RsiSarPanel;
