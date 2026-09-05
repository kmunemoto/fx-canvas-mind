import type { AnalysisRecord, Counterfactual, NumericCandle } from "@/lib/types";
import { useLocale } from "@/lib/i18n";
import { formatJst, priceDecimals, toPips } from "@/lib/candleTime";
import { CURRENT_CONTRACT, contractKey, isRejected } from "@/lib/outcomeStats";
import PriceChart, { type ChartMarker } from "./PriceChart";

interface Props {
  record: AnalysisRecord;
  // The refused plan tracked in the shadows, when this row is a refusal
  shadow?: AnalysisRecord | null;
}

const Row = ({ label, value, className = "", mono = true }: { label: string; value: string; className?: string; mono?: boolean }) => (
  <div className="flex items-baseline justify-between gap-3 py-0.5">
    <span className="text-muted-foreground shrink-0">{label}</span>
    <span className={`${mono ? "font-mono" : ""} text-right ${className}`}>{value}</span>
  </div>
);

const Heading = ({ children }: { children: string }) => (
  <h4 className="text-[10px] font-semibold tracking-wider text-primary uppercase mb-1">{children}</h4>
);

// "Plan vs. actual" for one history row: the levels the AI called, what price
// then did, the bars it was judged on with the fill and settlement marked —
// and, once the post-mortem has run, why it went the way it did
const OutcomeDetail = ({ record, shadow = null }: Props) => {
  const { t, locale } = useLocale();
  const d = t.history.detail;
  const g = t.history.gate;
  const pm = t.history.postmortem;
  const w = t.history.wait;
  const ev = record.evaluation;
  const decimals = priceDecimals(record.pair);
  // A WAIT call carries no trade plan, so there is nothing to judge
  const tracked = record.signal !== "WAIT" && record.outcome !== "skipped";
  const rejected = isRejected(record);
  const settled = tracked && record.outcome !== "pending";

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
      case "ambiguous": {
        // The recorded site says what actually happened; `reason` can only
        // ever be incoherent / no_data / null, which collapses four different
        // situations into one sentence.
        const site = ev?.ambiguity?.site;
        if (site && site in d.ambiguitySite) return d.ambiguitySite[site as keyof typeof d.ambiguitySite];
        if (ev?.reason === "incoherent") return d.reasons.incoherent;
        if (ev?.reason === "no_data") return d.reasons.no_data;
        return ev?.possible_fill ? d.possibleFill : d.summary.ambiguous;
      }
      case "untriggered":
        return ev?.reason && ev.reason in d.reasons ? d.reasons[ev.reason] : t.history.outcomes.untriggered;
      case "skipped":
        return rejected ? g.rejectedSummary : d.summary.skipped;
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

  // --- the gate: a refused plan and what became of it in the shadows ------
  const check = record.entry_check ?? null;
  const rejectionLabel = check?.rejection && check.rejection in g.reasons ? g.reasons[check.rejection] : null;
  const shadowVerdict = (() => {
    if (!shadow) return null;
    switch (shadow.outcome) {
      case "untriggered":
        return { text: g.gateRight, cls: "text-success" };
      case "win":
        return { text: g.gateWrong, cls: "text-destructive" };
      case "loss":
        return { text: g.gateSaved, cls: "text-success" };
      case "pending":
        return { text: g.gateOpen, cls: "text-muted-foreground" };
      default:
        return { text: t.history.outcomes[shadow.outcome] ?? shadow.outcome, cls: "text-muted-foreground" };
    }
  })();

  // --- standing aside, reviewed -------------------------------------------
  // A WAIT carries no plan, so nothing above this line has anything to judge.
  // What is judged instead is the smallest trade the entry gate would itself
  // have allowed from the price at the moment of the call.
  const wait = !tracked ? record.wait_check ?? null : null;
  const waitVerdictClass = wait?.verdict === "missed"
    ? "text-warning"
    : wait?.verdict === "correct" ? "text-success" : "text-muted-foreground";
  const waitDecided = wait?.verdict === "missed" || wait?.verdict === "correct";

  // --- the post-mortem ----------------------------------------------------
  const post = record.postmortem ?? null;
  const diagnosed = post?.status === "done" && typeof post.cause === "string";
  const pick = (v: { ja: string; en: string } | undefined) => (v ? (locale === "ja" ? v.ja || v.en : v.en || v.ja) : "");
  const pickList = (v: { ja: string[]; en: string[] } | undefined) =>
    v ? (locale === "ja" ? (v.ja.length > 0 ? v.ja : v.en) : v.en.length > 0 ? v.en : v.ja) : [];
  const causeLabel = (c: string | undefined) => (c && c in pm.causes ? pm.causes[c as keyof typeof pm.causes] : c ?? "");
  const facts = diagnosed ? post?.facts ?? null : null;
  const cfLabel = (c: Counterfactual | null | undefined) => {
    if (!c) return null;
    const key = c.resolution ?? "open";
    return key in pm.cfResult ? pm.cfResult[key as keyof typeof pm.cfResult] : key;
  };
  const counterfactuals: Array<{ label: string; value: string; cls: string }> = [];
  if (facts) {
    // Under market_v1 the analyst never chose the entry, so a better price
    // that was on offer is a measurement of how extended the entry was, not a
    // move that could have been made. The green is what makes the row read as
    // advice, so it is withheld — the number still shows.
    const add = (label: string, c: Counterfactual | null | undefined, neverRemedy = false) => {
      const v = cfLabel(c);
      if (v === null) return;
      // A variant that "wins" but the gate would refuse is not a remedy;
      // its risk/reward is shown so the reader can see why
      const parts = [v];
      if (typeof c?.rr === "number" && Number.isFinite(c.rr)) parts.push(pm.cfRr(c.rr));
      if (c?.viable === false && c?.resolution === "win") parts.push(pm.cfNotViable);
      counterfactuals.push({
        label,
        value: parts.join(" · "),
        cls: c?.resolution === "win" && c?.viable !== false && !neverRemedy
          ? "text-success"
          : c?.resolution === "loss" ? "text-destructive" : "text-muted-foreground",
      });
    };
    add(pm.cfMarket, facts.counterfactual?.market_entry);
    add(pm.cfMarketSameRisk, facts.counterfactual?.market_entry_same_risk);
    add(pm.cfPullback, facts.counterfactual?.limit_pullback, contractKey(record) === CURRENT_CONTRACT);
    add(pm.cfStop15, facts.counterfactual?.stop_x1_5);
    add(pm.cfStop2, facts.counterfactual?.stop_x2);
    add(pm.cfTpHalf, facts.counterfactual?.tp_half);
  }
  const postTitle = record.outcome === "win" ? pm.titleWin : pm.title;
  const thin = post?.status === "done" && post.thin === true;
  const revised = post?.status === "done" && typeof post.revisions === "number" && post.revisions > 0;

  return (
    <div className="mt-2 rounded-lg border border-border/60 bg-background/40 p-3 space-y-3 text-xs" data-testid="outcome-detail">
      {record.thesis && <p className="text-muted-foreground">{record.thesis}</p>}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3">
        <section>
          <Heading>{d.plan}</Heading>
          <Row label={t.direction.label} value={`${dir.word} (${dir.gloss})`} className={`font-bold ${dirClass}`} />
          {tracked && (
            <>
              <Row label={d.entry} value={price(record.entry_point)} />
              <Row label={d.stopLoss} value={price(record.stop_loss)} className="text-destructive" />
              <Row label={d.takeProfit1} value={price(record.take_profit_1)} className="text-success" />
              <Row label={d.priceAtSignal} value={price(record.price_at_signal ?? ev?.price_at_signal)} />
              {ev && <Row label={d.orderTypeLabel} value={d.orderType[orderType]} className="text-muted-foreground" mono={false} />}
              {/* Which book priced the plan, and which one scored it. These were
                  written and read by nothing until now, so a plan priced on one
                  feed and filled on another looked identical to one where both
                  agreed. */}
              {check?.price_feed && (
                <Row label={d.priceFeedLabel} value={d.priceFeed[check.price_feed]} className="text-muted-foreground" mono={false} />
              )}
              {check?.repaired && <p className="text-muted-foreground mt-1">{g.repaired}</p>}
            </>
          )}
        </section>

        <section>
          <Heading>{d.actual}</Heading>
          <p className={`font-semibold mb-1 ${outcomeClass}`}>{summary}</p>
          {tracked && (
            <>
              {ev?.price_basis && (
                <Row label={d.priceBasisLabel} value={d.priceBasis[ev.price_basis]} className="text-muted-foreground" mono={false} />
              )}
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

      {/* a plan the gate refused: what was proposed, why it was refused,
          and what the market then did with it */}
      {rejected && check && (
        <section className="rounded-md border border-warning/40 bg-warning/5 p-2 space-y-1" data-testid="gate-detail">
          <Heading>{g.rejectedTitle}</Heading>
          {rejectionLabel && <p className="text-warning font-semibold">{rejectionLabel}</p>}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6">
            <div>
              <Row label={g.proposed} value={check.proposed_signal} className={check.proposed_signal === "BUY" ? "text-success" : "text-destructive"} />
              <Row label={d.entry} value={price(check.proposed_entry)} />
              <Row label={d.stopLoss} value={price(check.proposed_stop)} className="text-destructive" />
              <Row label={d.takeProfit1} value={price(check.proposed_tp1)} className="text-success" />
            </div>
            <div>
              {typeof check.distance_atr === "number" && <Row label={g.distance} value={`${check.distance_atr} ATR`} />}
              {typeof check.risk_reward === "number" && <Row label={g.riskReward} value={`1:${check.risk_reward}`} />}
              {shadow && shadowVerdict && (
                <>
                  <Row label={g.shadowResult} value={t.history.outcomes[shadow.outcome] ?? shadow.outcome} mono={false} />
                  <p className={`font-semibold ${shadowVerdict.cls}`}>{shadowVerdict.text}</p>
                </>
              )}
            </div>
          </div>
        </section>
      )}

      {/* the call that declined to trade, and what the market then did */}
      {wait && (
        <section
          className={`rounded-md border p-2 space-y-1 ${
            wait.verdict === "missed" ? "border-warning/40 bg-warning/5" : "border-border/60 bg-background/60"
          }`}
          data-testid="wait-detail"
        >
          <Heading>{w.title}</Heading>
          <p className={`font-semibold ${waitVerdictClass}`}>{w.verdicts[wait.verdict] ?? wait.verdict}</p>
          {waitDecided && (
            <>
              {wait.direction && (
                <p className="text-muted-foreground">{w.direction(t.direction[wait.direction].word)}</p>
              )}
              <Row label={d.priceAtSignal} value={price(wait.price ?? record.price_at_signal)} />
              {typeof wait.risk === "number" && typeof wait.reward === "number" && (
                <p className="text-muted-foreground">
                  <span className="font-semibold">{w.basis}: </span>
                  {w.basisNote(pips(wait.risk, null), pips(wait.reward, null))}
                </p>
              )}
              {wait.at && <Row label={w.reachedAt} value={when(wait.at)} />}
              <p className="text-[10px] text-muted-foreground font-mono">
                {w.barsExamined(wait.bars_examined)} · {w.horizon(Math.round(wait.horizon_ms / 3_600_000))}
              </p>
            </>
          )}
          <p className="text-[10px] text-muted-foreground">{w.note}</p>
        </section>
      )}

      {/* why it went the way it did */}
      {settled && (
        <section className="rounded-md border border-border/60 bg-background/60 p-2 space-y-1" data-testid="postmortem">
          <Heading>{postTitle}</Heading>
          {diagnosed && post ? (
            <>
              <div className="flex flex-wrap items-center gap-1.5">
                <span className={`px-1.5 py-0.5 rounded border text-[10px] font-semibold ${
                  post.cause === "good_call" ? "bg-success/15 text-success border-success/40" : "bg-warning/15 text-warning border-warning/40"
                }`}>
                  {causeLabel(post.cause)}
                </span>
                {(post.secondary_causes ?? []).map((c) => (
                  <span key={c} className="px-1.5 py-0.5 rounded border border-border text-[10px] text-muted-foreground">
                    {causeLabel(c)}
                  </span>
                ))}
                {typeof post.confidence === "number" && (
                  <span className="text-[10px] text-muted-foreground font-mono">{pm.confidence(post.confidence)}</span>
                )}
              </div>
              <p className="text-foreground">{pick(post.verdict)}</p>
              {pickList(post.evidence).length > 0 && (
                <ul className="list-disc pl-4 text-muted-foreground space-y-0.5">
                  {pickList(post.evidence).map((e, i) => <li key={i}>{e}</li>)}
                </ul>
              )}
              {counterfactuals.length > 0 && (
                <div className="pt-1">
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wider">{pm.counterfactual}</p>
                  {counterfactuals.map((c) => (
                    <Row key={c.label} label={c.label} value={c.value} className={`font-semibold ${c.cls}`} />
                  ))}
                  {facts?.after?.reached_tp1 && (
                    <p className="text-muted-foreground">{pm.afterTp1(facts.after.reached_tp1.bars)}</p>
                  )}
                  {typeof facts?.after?.beyond_sl_r === "number" && facts.after.beyond_sl_r >= 1 && (
                    <p className="text-muted-foreground">{pm.beyondSl(facts.after.beyond_sl_r)}</p>
                  )}
                  {typeof facts?.early_adverse_r === "number" && facts.early_adverse_r >= 0.5 && (
                    <p className="text-muted-foreground">{pm.earlyAdverse(facts.early_adverse_r)}</p>
                  )}
                  {facts?.abnormal_bar?.event && (
                    <p className="text-muted-foreground">
                      {pm.eventBar(facts.abnormal_bar.event.country, facts.abnormal_bar.event.title)}
                    </p>
                  )}
                </div>
              )}
              {(post.rule_blamed || post.rule_credited) && (
                <p className="text-[10px] text-muted-foreground font-mono">
                  {post.rule_blamed ? pm.ruleBlamed(post.rule_blamed) : pm.ruleCredited(post.rule_credited as string)}
                </p>
              )}
              {pick(post.lesson) && (
                <p className="rounded bg-primary/10 border border-primary/30 px-2 py-1 text-foreground">
                  <span className="text-primary font-semibold mr-1">{pm.lesson}:</span>
                  {pick(post.lesson)}
                </p>
              )}
              <p className="text-[10px] text-muted-foreground">
                {post.avoidable ? pm.avoidable : pm.unavoidable}
                {thin && !revised ? ` · ${pm.thinNote}` : thin && revised ? ` · ${pm.thinFinalNote}` : revised ? ` · ${pm.revisedNote}` : ""}
              </p>
            </>
          ) : (
            <p className="text-muted-foreground">{post?.status === "failed" ? pm.failed : pm.pending}</p>
          )}
        </section>
      )}

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
          {ev.refined ? ` · ${d.refined(ev.ambiguity?.at_interval ?? null)}` : ""}
        </p>
      )}
    </div>
  );
};

export default OutcomeDetail;
