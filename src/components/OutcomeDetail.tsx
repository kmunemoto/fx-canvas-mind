import type { AnalysisRecord, NumericCandle } from "@/lib/types";
import { useLocale } from "@/lib/i18n";
import { formatJst, priceDecimals, toPips } from "@/lib/candleTime";
import PriceChart, { type ChartMarker } from "./PriceChart";

interface Props {
  record: AnalysisRecord;
}

const Row = ({ label, value, className = "", mono = true }: { label: string; value: string; className?: string; mono?: boolean }) => (
  <div className="flex items-baseline justify-between gap-3 py-0.5">
    <span className="text-muted-foreground shrink-0">{label}</span>
    <span className={`${mono ? "font-mono" : ""} text-right ${className}`}>{value}</span>
  </div>
);

// "Plan vs. actual" for one history row: the levels the AI called, what price
// then did, and the bars it was judged on with the fill and settlement marked
const OutcomeDetail = ({ record }: Props) => {
  const { t } = useLocale();
  const d = t.history.detail;
  const ev = record.evaluation;
  const decimals = priceDecimals(record.pair);
  // A WAIT call carries no trade plan, so there is nothing to judge
  const tracked = record.signal !== "WAIT" && record.outcome !== "skipped";

  const price = (v: number | null | undefined) =>
    typeof v === "number" && Number.isFinite(v) ? v.toFixed(decimals) : "—";
  const pips = (v: number | null | undefined, r: number | null | undefined) => {
    if (typeof v !== "number" || !Number.isFinite(v)) return "—";
    const base = `${Math.round(toPips(record.pair, v))} ${d.pips}`;
    return typeof r === "number" && Number.isFinite(r) ? `${base} (${r.toFixed(1)}R)` : base;
  };
  const when = (iso: string | null | undefined) => (iso ? formatJst(iso, t.intlLocale) : "—");

  const dir = t.direction[record.signal];
  const dirClass = record.signal === "BUY" ? "text-success" : record.signal === "SELL" ? "text-destructive" : "text-warning";

  const outcomeClass =
    record.outcome === "win" ? "text-success" : record.outcome === "loss" ? "text-destructive" : "text-foreground";

  // The stored evidence is a jsonb document; read it defensively
  const tpsHitList = Array.isArray(ev?.tps_hit) ? ev.tps_hit : [];
  const orderType = ev?.order_type && ev.order_type in d.orderType ? ev.order_type : "unknown";
  const evalInterval = ev?.eval_interval ?? record.interval;
  const path = Array.isArray(ev?.path) ? ev.path : [];
  const compressed = ev ? path.length < (ev.bars_after_signal ?? 0) : false;

  const summary = (() => {
    switch (record.outcome) {
      case "win":
        return d.summary.win(price(record.take_profit_1));
      case "loss":
        return d.summary.loss(price(record.stop_loss));
      case "expired":
        return d.summary.expired(price(record.outcome_price));
      case "ambiguous":
        if (ev?.reason === "incoherent") return d.reasons.incoherent;
        if (ev?.reason === "no_data") return d.reasons.no_data;
        return ev?.possible_fill ? d.possibleFill : d.summary.ambiguous;
      case "untriggered":
        return ev?.reason && ev.reason in d.reasons ? d.reasons[ev.reason] : t.history.outcomes.untriggered;
      case "skipped":
        return d.summary.skipped;
      default:
        return d.summary.pending;
    }
  })();

  const candles: NumericCandle[] = path.map((p) => ({
    datetime: p.t,
    open: p.o,
    high: p.h,
    low: p.l,
    close: p.c,
  }));

  const markers: ChartMarker[] = [{ time: record.created_at, kind: "signal", label: d.markers.signal }];
  if (ev?.filled_at && orderType !== "market") {
    markers.push({ time: ev.filled_at, kind: "fill", label: d.markers.fill });
  }
  if (ev?.resolved_at && record.outcome !== "pending") {
    const kind: ChartMarker["kind"] = record.outcome === "win" ? "win" : record.outcome === "loss" ? "loss" : "end";
    markers.push({ time: ev.resolved_at, kind, label: d.markers[kind] });
  }

  const tpsHit = tpsHitList.length > 0 ? tpsHitList.map((n) => `TP${n}`).join(" / ") : d.none;
  const takeProfits = [record.take_profit_1, record.take_profit_2, record.take_profit_3].map((v) =>
    v !== null && v !== undefined ? String(v) : undefined
  );

  return (
    <div className="mt-2 rounded-lg border border-border/60 bg-background/40 p-3 space-y-3 text-xs" data-testid="outcome-detail">
      {record.thesis && <p className="text-muted-foreground">{record.thesis}</p>}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3">
        <section>
          <h4 className="text-[10px] font-semibold tracking-wider text-primary uppercase mb-1">{d.plan}</h4>
          <Row label={t.direction.label} value={`${dir.word} (${dir.gloss})`} className={`font-bold ${dirClass}`} />
          {tracked && (
            <>
              <Row label={d.entry} value={price(record.entry_point)} />
              <Row label={d.stopLoss} value={price(record.stop_loss)} className="text-destructive" />
              <Row label={d.takeProfit1} value={price(record.take_profit_1)} className="text-success" />
              <Row label={d.priceAtSignal} value={price(record.price_at_signal ?? ev?.price_at_signal)} />
              {ev && <Row label={d.orderTypeLabel} value={d.orderType[orderType]} className="text-muted-foreground" mono={false} />}
            </>
          )}
        </section>

        <section>
          <h4 className="text-[10px] font-semibold tracking-wider text-primary uppercase mb-1">{d.actual}</h4>
          <p className={`font-semibold mb-1 ${outcomeClass}`}>{summary}</p>
          {tracked && (
            <>
              {record.outcome === "pending" && ev?.refine_pending && (
                <p className="text-muted-foreground mb-1">{d.refinePending}</p>
              )}
              {record.outcome === "pending" && ev?.possible_fill && (
                <p className="text-muted-foreground mb-1">{d.possibleFill}</p>
              )}
              <Row label={d.filledAt} value={ev?.filled_at ? when(ev.filled_at) : d.notFilled} />
              <Row label={d.resolvedAt} value={when(ev?.resolved_at ?? record.closed_at)} />
              <Row label={d.mfe} value={pips(ev?.mfe, ev?.mfe_r)} className="text-success" />
              <Row label={d.mae} value={pips(ev?.mae, ev?.mae_r)} className="text-destructive" />
              <Row label={d.tpsHit} value={tpsHit} />
            </>
          )}
        </section>
      </div>

      {tracked && (candles.length > 0 ? (
        <PriceChart
          candles={candles}
          entry={record.entry_point !== null ? String(record.entry_point) : undefined}
          stopLoss={record.stop_loss !== null ? String(record.stop_loss) : undefined}
          takeProfits={takeProfits}
          pair={record.pair}
          markers={markers}
          heading={d.chartHeading}
          subtitle={compressed ? d.chartSubtitleCompressed(evalInterval, candles.length) : d.chartSubtitle(evalInterval, candles.length)}
        />
      ) : (
        <p className="text-muted-foreground">
          {record.outcome === "pending" ? d.noEvidence : d.legacyNoEvidence}
        </p>
      ))}

      {tracked && ev && (
        <p className="text-[10px] text-muted-foreground font-mono">
          {d.checkedAt} {when(ev.checked_at)} · {d.evalInterval} {evalInterval}
          {ev.refined ? ` · ${d.refined}` : ""}
        </p>
      )}
    </div>
  );
};

export default OutcomeDetail;
