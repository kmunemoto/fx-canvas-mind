import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Bell, Loader2, Mail } from "lucide-react";
import { toast } from "sonner";
import { useLocale } from "@/lib/i18n";
import { priceDecimals } from "@/lib/candleTime";
import { isStock, stockName, type StockHit } from "@/lib/stocks";
import StockPicker from "@/components/StockPicker";
import {
  ALERT_RULES,
  AlertRequestError,
  callSignalAlerts,
  indicatorChartOffered,
  isFollowing,
  isIndicatorAlertRule,
  type AlertRow,
  type AlertRule,
  type AlertSettings,
  type RecordSummary,
} from "@/lib/signalAlerts";

interface Props {
  // Injected by tests; the app uses the real function
  call?: (body: Record<string, unknown>) => Promise<AlertSettings>;
  // v42: the stock MACD tab's search (StockPicker); injected by tests, the app uses the live chart's
  loadSearch?: (q: string) => Promise<StockHit[]>;
}

const fmtR = (v: number) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(2)}R`;
const pct = (v: number) => `${Math.round(v * 100)}%`;
// Below this many settled signals the numbers are read as noise (a 95%
// interval on a win rate near 35% is still about ±17 points at 30)
const ENOUGH = 30;

// v42 (research/allstocks-prod-spec.md 3.1, 4.1): the function's STOCKMACD_CAP, used for the refusal's toast only when
// the status on screen sends no cap (a v41 server's); a v42 status sends it
const STOCKMACD_CAP_FALLBACK = 50;
// v42 (6.4 stockmacdStale): "2026-11-14", the date in Japan time of a time
const jstDate = (iso: string) => new Date(Date.parse(iso) + 9 * 3_600_000).toISOString().slice(0, 10);

// "09-25 19:15" in Japan time, which is how the rest of the app writes times
const jst = (iso: string) => {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  return new Date(ms + 9 * 3_600_000).toISOString().slice(5, 16).replace("T", " ");
};

// #105: which charts email the RSI + Parabolic SAR signal, and what was sent.
// The server decides who may follow a chart (#139: every paid plan, and the
// admins) and holds the
// only copy of the choice; this card asks it and shows the answer.
// #155: and Q-Trend's and ULTRA's signals, on every pair of the live chart
// (a row to follow a timeframe on all of them at once).
// #275: and the MACD peak-and-valley rule's, on its own charts (the server
// sends them: GMO's currency pairs, 5 minutes; #324: 1 hour from v25;
// #345: and gold's 1 hour from v27).
// #291: and the owner's video's way (liquidity sweep + EMA cross), on its own
// chart (gold's 1-minute).
// v42 (research/allstocks-prod-spec.md 3.3, 6.3): the stock MACD email on any share
// Yahoo's search finds, at most 50 for all users together: the count of the shares
// followed, the search (StockPicker), the refusals by their code, and each own
// share's row with its stored name and notes.
const SignalAlertSettings = ({ call = callSignalAlerts, loadSearch }: Props) => {
  const { t, locale } = useLocale();
  const a = t.alerts;
  const [settings, setSettings] = useState<AlertSettings | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  // #112: which rule's grid and record are on screen
  const [rule, setRule] = useState<AlertRule>("rsi_sar");

  const load = useCallback(async () => {
    setLoadError(false);
    try {
      setSettings(await call({ action: "status" }));
    } catch {
      setLoadError(true);
    }
  }, [call]);

  useEffect(() => {
    void load();
  }, [load]);

  // v42 (research/allstocks-prod-spec.md 6.3): a refused save says why by its code under the stock MACD (every other
  // rule's saveFailed, as before); after stock_cap_full the status is read again, so that the count line and the full
  // message match the cap (callSignalAlerts keeps only the code, and the old status would stay on screen)
  const saveRefused = async (err: unknown, onRule: AlertRule) => {
    const code = err instanceof AlertRequestError ? err.code : null;
    if (onRule !== "stockmacd") {
      toast.error(a.saveFailed);
      return;
    }
    if (code === "stock_cap_full") {
      toast.error(a.stockmacdCapRefused(settings?.indicator?.stockmacd?.cap ?? STOCKMACD_CAP_FALLBACK));
      await load();
    } else if (code === "stock_not_found") toast.error(a.stockmacdNotFound);
    else if (code === "stock_check_unavailable") toast.error(a.stockmacdCheckFailed);
    else toast.error(a.saveFailed);
  };

  const toggle = async (pair: string, interval: string, on: boolean) => {
    const key = `${rule}|${pair}|${interval}`;
    const onRule = rule;
    setBusy(key);
    try {
      setSettings(await call({ action: "set", pair, interval, on, rule: onRule, lang: locale }));
    } catch (err) {
      await saveRefused(err, onRule);
    } finally {
      setBusy(null);
    }
  };

  // #155: a timeframe across every pair offered, at once
  const toggleMany = async (charts: Array<{ pair: string; interval: string }>, on: boolean, key: string) => {
    const onRule = rule;
    setBusy(key);
    try {
      setSettings(await call({ action: "set_many", rule: onRule, on, charts, lang: locale }));
    } catch (err) {
      await saveRefused(err, onRule);
    } finally {
      setBusy(null);
    }
  };

  // v42 (6.3): a share picked in the stock MACD tab's search, ticked on its one chart, with the words typed when the
  // hit was shown (the function confirms a share nobody follows yet by Yahoo's search with them)
  const pickStock = async (hit: StockHit, q: string) => {
    setBusy(`stockmacd|${hit.symbol}|15min`);
    try {
      setSettings(await call({ action: "set", pair: hit.symbol, interval: "15min", on: true, rule: "stockmacd", lang: locale, q }));
    } catch (err) {
      await saveRefused(err, "stockmacd");
    } finally {
      setBusy(null);
    }
  };

  const sendTest = async () => {
    setBusy("test");
    try {
      const next = await call({ action: "test", lang: locale });
      setSettings(next);
      if (next.test === "sent") toast.success(a.testSent);
      else if (next.test === "not_configured") toast.warning(a.testNotConfigured);
      else toast.error(a.testFailed);
    } catch (err) {
      toast.error(err instanceof AlertRequestError && err.code === "test_cooldown" ? a.testCooldown : a.testFailed);
    } finally {
      setBusy(null);
    }
  };

  const rowLabel = (r: AlertRow) => {
    if (r.kind === "test") return a.testRow;
    const tf = r.interval ? a.intervals[r.interval] ?? r.interval : "";
    // #395: a sharp rise or fall is kept as BUY or SELL only for the table's
    // check; it is said as what it is, not as a side to trade
    // #397: the MACD ride's second email and its notice are not entries: said as what they are
    // v10: at the row's own exit level (v9 96%, v10 95%), read from its id
    if (r.ride === "out" && r.side && r.rideOutPct !== null)
      return `${r.pair ?? ""} ${tf} ${a.rideOut[r.side](r.rideOutPct)}`.trim() + (a.ruleTag[r.rule] ?? "");
    if (r.ride === "at" && r.rideOutPct !== null)
      return `${r.pair ?? ""} ${tf} ${a.rideAt(r.rideOutPct)}`.trim() + (a.ruleTag[r.rule] ?? "");
    if (r.rule === "spike") return `${r.pair ?? ""} ${tf} ${r.side === "BUY" ? a.spikeUp : r.side === "SELL" ? a.spikeDown : ""}`.trim();
    // the MACD fade (research/macdfade1h-prod-spec.md section 5): its one email is an entry, its side in its colour,
    // tagged as the fade, a share's as the stock MACD's fade (so it does not read like a v9 share email 1, whose side
    // was the other way round)
    if (r.fade !== null) return `${r.pair ?? ""} ${tf} ${r.side ? a.sides[r.side] : ""}`.trim() + (a.ruleTagFade[r.rule] ?? "");
    // #397: a row of the MACD rules that is not a ride's (the 95% email's, stopped when the ride took its place, and
    // older ones) keeps its side, its colour and its plan line, under a tag that does not call it the ride: that
    // email had a stop and a target, and its side was the other way round
    const tag = (r.rule === "macdx" || r.rule === "stockmacd") && r.ride === null ? a.ruleTagEarlier[r.rule] ?? "" : a.ruleTag[r.rule] ?? "";
    return `${r.pair ?? ""} ${tf} ${r.side ? a.sides[r.side] : ""}`.trim() + (r.strong ? a.strongTag : "") + tag;
  };
  const statusLabel = (r: AlertRow) =>
    r.status === "skipped" && r.skipReason ? a.skipReasons[r.skipReason] ?? a.status.skipped : a.status[r.status];
  const resultLabel = (r: AlertRow) => {
    if (r.kind !== "signal" || !r.result) return null;
    const o = r.result.outcome;
    if (o === null) return { text: a.pendingResult, cls: "text-muted-foreground" };
    const text = r.result.r === null ? a.outcome[o] : `${a.outcome[o]} ${fmtR(r.result.r)}`;
    return { text, cls: o === "win" ? "text-success" : o === "expired" || o === "no_data" ? "text-muted-foreground" : "text-destructive" };
  };
  const summaryBlock = (label: string, sm: RecordSummary, testid: string) => (
    <div className="space-y-0.5" data-testid={testid}>
      <p className="text-[11px] text-foreground">{label}</p>
      {sm.n === 0 ? (
        <p className="text-[11px] text-muted-foreground">{a.record.none}</p>
      ) : (
        <>
          <p className="text-[11px] font-mono">{a.record.line(sm.n, sm.wins, sm.losses, sm.expired)}</p>
          {sm.winRate !== null && sm.meanR !== null && (
            <p className={`text-[11px] font-mono ${sm.meanR >= 0 ? "text-success" : "text-destructive"}`}>
              {a.record.stats(pct(sm.winRate), fmtR(sm.meanR))}
              {sm.ciR !== null && a.record.ci(sm.ciR.toFixed(2) + "R")}
            </p>
          )}
        </>
      )}
      {sm.open > 0 && <p className="text-[10px] text-muted-foreground">{a.record.open(sm.open)}</p>}
    </div>
  );
  const statusClass = (r: AlertRow) =>
    r.status === "sent" ? "text-success" : r.status === "failed" ? "text-destructive" : "text-muted-foreground";

  return (
    <div className="p-4 rounded-lg bg-secondary border border-border space-y-3" data-testid="signal-alerts">
      <div className="flex items-center gap-2">
        <Bell className="h-4 w-4 text-primary" />
        <h3 className="text-sm font-semibold text-foreground">{a.title}</h3>
      </div>

      {!settings ? (
        loadError ? (
          <p className="text-xs text-destructive" data-testid="signal-alerts-error">{a.loadFailed}</p>
        ) : (
          <p className="text-xs text-muted-foreground flex items-center gap-1.5">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {a.loading}
          </p>
        )
      ) : (
        <>
          <p className="text-xs text-muted-foreground">{settings.email ? a.intro(settings.email) : a.introNoEmail}</p>
          {!settings.allowed && (
            <p className="text-xs text-warning" data-testid="signal-alerts-pro-only">{a.proOnly}</p>
          )}
          {!settings.emailConfigured && (
            <p className="text-xs text-warning flex items-start gap-1.5" data-testid="signal-alerts-not-configured">
              <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              <span>{a.notConfigured}</span>
            </p>
          )}

          <div className="flex flex-wrap items-center gap-1" role="tablist" aria-label={a.ruleTabsLabel} data-testid="signal-alerts-rules">
            {ALERT_RULES.map((k) => (
              <button
                key={k}
                type="button"
                role="tab"
                aria-selected={rule === k}
                onClick={() => setRule(k)}
                data-testid={`signal-alerts-rule-${k}`}
                className={`px-2 py-0.5 rounded border text-[11px] ${
                  rule === k ? "border-primary/60 bg-primary/10 text-primary" : "border-border text-muted-foreground"
                }`}
              >
                {a.ruleTabs[k]}
              </button>
            ))}
          </div>
          {rule === "gainz" && <p className="text-[11px] text-muted-foreground" data-testid="signal-alerts-gainz-intro">{a.gainzIntro}</p>}
          {isIndicatorAlertRule(rule) && (
            <p className="text-[11px] text-muted-foreground" data-testid="signal-alerts-indicator-intro">{a.indicatorIntro[rule]}</p>
          )}

          {isIndicatorAlertRule(rule) ? (
            settings.indicator ? (
              (() => {
                // #275: the MACD rule has its own charts; the other two share the live chart's
                // (#291: and the video's way has its own, gold's 1-minute).
                // A server that does not send them (older than v23, v24 for the video's way,
                // or not yet deployed) has nothing to tick: say so rather than draw an empty table
                // (#387: and the EMA 20 / 200 way has its own, the six's 15 minutes)
                // (#391: and the MACD email on shares has its own: v41 the 22 shares' 15 minutes; v42 the 22 and the
                // user's own shares beyond them, so a v42 server always sends rows and the block's absence alone says
                // "not available")
                // (#395: and a sharp rise or fall has its own, the six's 1 hour)
                const ind = rule === "macdx" ? settings.indicator.macdx : rule === "sweepx" ? settings.indicator.sweepx : rule === "emarm" ? settings.indicator.emarm : rule === "stockmacd" ? settings.indicator.stockmacd : rule === "spike" ? settings.indicator.spike : settings.indicator;
                if (!ind || ind.pairs.length === 0) {
                  return <p className="text-xs text-warning" data-testid={`signal-alerts-${rule}-unavailable`}>{a.macdxUnavailable}</p>;
                }
                const offered = (iv: string) => ind.pairs.filter((p) => indicatorChartOffered(settings, p, iv, rule));
                // v42 (research/allstocks-prod-spec.md 6.3): the stock MACD's own block (its cap, count and own shares)
                const stock = rule === "stockmacd" ? settings.indicator.stockmacd : null;
                const allLabel = stock ? a.stockmacdAllRow : a.allPairs;
                return (
                  <>
                  {/* v42 (6.3): above the grid, from a v42 server only (one that sends the cap): the shares followed by all
                      users together against the cap, or that the count could not be read (no guess), and the search */}
                  {stock && stock.cap !== null && (
                    <div className="space-y-1.5" data-testid="stockmacd-head">
                      {stock.followed !== null ? (
                        <>
                          <p className="text-[11px] text-foreground" data-testid="stockmacd-count">{a.stockmacdCount(stock.followed, stock.cap)}</p>
                          {stock.followed >= stock.cap && (
                            <p className="text-[11px] text-warning" data-testid="stockmacd-full">{a.stockmacdFull(stock.cap)}</p>
                          )}
                        </>
                      ) : (
                        <p className="text-[11px] text-muted-foreground" data-testid="stockmacd-count-unread">{a.stockmacdCountUnread}</p>
                      )}
                      <StockPicker onPick={(hit, q) => void pickStock(hit, q)} disabled={busy !== null || !settings.allowed} loadSearch={loadSearch} />
                    </div>
                  )}
                  <table className="w-full text-xs" data-testid="signal-alerts-grid">
                    <thead>
                      <tr className="text-muted-foreground">
                        <th className="text-left font-normal py-1">{stock ? a.stockmacdHeader : a.pairHeader}</th>
                        {ind.intervals.map((iv) => (
                          <th key={iv} className="font-normal py-1 text-center">{a.intervals[iv] ?? iv}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {/* (#291: not for a rule offered on one chart) */}
                      {ind.pairs.length > 1 && (
                      <tr className="border-t border-border/50" data-testid="signal-alerts-all-row">
                        <td className="py-1 text-foreground font-semibold">{allLabel}</td>
                        {ind.intervals.map((iv) => {
                          const pairs = offered(iv);
                          const n = pairs.filter((p) => isFollowing(settings, p, iv, rule)).length;
                          const all = pairs.length > 0 && n === pairs.length;
                          const disabled = busy !== null || (!all && !settings.allowed) || pairs.length === 0;
                          return (
                            <td key={iv} className="py-1 text-center">
                              <input
                                type="checkbox"
                                checked={all}
                                ref={(el) => {
                                  if (el) el.indeterminate = n > 0 && !all;
                                }}
                                disabled={disabled}
                                onChange={() => void toggleMany(pairs.map((pair) => ({ pair, interval: iv })), !all, `${rule}|all|${iv}`)}
                                aria-label={`${allLabel} ${a.intervals[iv] ?? iv} ${a.ruleTabs[rule]}`}
                                data-testid={`signal-alert-${rule}-all-${iv}`}
                                className="h-4 w-4 accent-primary disabled:opacity-40"
                              />
                            </td>
                          );
                        })}
                      </tr>
                      )}
                      {ind.pairs.map((pair) => {
                        // #391: a share named beside its symbol (v42: a share beyond the 22 by the name stored from
                        // Yahoo's search, sent in `shares`; the 22 by the app's own names)
                        const share = stock?.shares[pair] ?? null;
                        const name = isStock(pair) ? share?.name ?? stockName(pair, locale) : null;
                        // signal-alerts v43: a share whose emails are judged on another chart than the column's (4063.T:
                        // 1-hour bars); its tick in the column stays its follow
                        const charts = stock?.charts ?? {};
                        const judgedOn = Object.prototype.hasOwnProperty.call(charts, pair) ? charts[pair] : null;
                        const otherChart = judgedOn !== null && !ind.intervals.includes(judgedOn) ? judgedOn : null;
                        return (
                        <tr key={pair} className="border-t border-border/50">
                          <td className="py-1 font-mono text-foreground">
                            {pair}
                            {name && <span className="ml-1 font-sans text-muted-foreground">{name}</span>}
                            {otherChart && (
                              <span className="block font-sans text-[10px] text-muted-foreground" data-testid={`stockmacd-chart-${pair}`}>{a.stockmacdChartNote(otherChart)}</span>
                            )}
                            {/* v42 (2.3, 6.3): what the app read of the share from Yahoo, when it says the share is not
                                judged as it should be: the newest bar more than 7 days old, fewer than 600 bars */}
                            {share?.stale && share.lastBarAt !== null && (
                              <span className="block font-sans text-[10px] text-warning" data-testid={`stockmacd-stale-${pair}`}>{a.stockmacdStale(jstDate(share.lastBarAt))}</span>
                            )}
                            {share && share.bars !== null && share.bars < 600 && (
                              <span className="block font-sans text-[10px] text-warning" data-testid={`stockmacd-short-${pair}`}>{a.stockmacdShortBars(share.bars, judgedOn ?? ind.intervals[0])}</span>
                            )}
                          </td>
                          {ind.intervals.map((iv) => {
                            if (!indicatorChartOffered(settings, pair, iv, rule)) {
                              // v41 per pair (research/macdfade15min-prod-spec.md section 5): the MACD fade's "—" is a
                              // pair on its other timeframe, not a symbol GMO Coin does not carry
                              return (
                                <td key={iv} className="py-1 text-center text-muted-foreground" title={rule === "macdx" ? a.macdxOtherChart : a.indicatorHourOnly} data-testid={`signal-alert-${rule}-${pair}-${iv}-none`}>
                                  —
                                </td>
                              );
                            }
                            const on = isFollowing(settings, pair, iv, rule);
                            const disabled = busy !== null || (!on && !settings.allowed);
                            return (
                              <td key={iv} className="py-1 text-center">
                                <input
                                  type="checkbox"
                                  checked={on}
                                  disabled={disabled}
                                  onChange={() => void toggle(pair, iv, !on)}
                                  aria-label={`${pair} ${a.intervals[iv] ?? iv} ${a.ruleTabs[rule]}`}
                                  data-testid={`signal-alert-${rule}-${pair}-${iv}`}
                                  className="h-4 w-4 accent-primary disabled:opacity-40"
                                />
                              </td>
                            );
                          })}
                        </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  </>
                );
              })()
            ) : (
              <p className="text-xs text-destructive" data-testid="signal-alerts-error">{a.loadFailed}</p>
            )
          ) : (
          <table className="w-full text-xs" data-testid="signal-alerts-grid">
            <thead>
              <tr className="text-muted-foreground">
                <th className="text-left font-normal py-1">{a.pairHeader}</th>
                {settings.intervals.map((iv) => (
                  <th key={iv} className="font-normal py-1 text-center">{a.intervals[iv] ?? iv}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {settings.pairs.map((pair) => (
                <tr key={pair} className="border-t border-border/50">
                  <td className="py-1 font-mono text-foreground">{pair}</td>
                  {settings.intervals.map((iv) => {
                    const on = isFollowing(settings, pair, iv, rule);
                    // A lapsed plan can still untick, never tick
                    const disabled = busy !== null || (!on && !settings.allowed);
                    return (
                      <td key={iv} className="py-1 text-center">
                        <input
                          type="checkbox"
                          checked={on}
                          disabled={disabled}
                          onChange={() => void toggle(pair, iv, !on)}
                          aria-label={`${pair} ${a.intervals[iv] ?? iv} ${a.ruleTabs[rule]}`}
                          data-testid={rule === "gainz" ? `signal-alert-gainz-${pair}-${iv}` : `signal-alert-${pair}-${iv}`}
                          className="h-4 w-4 accent-primary disabled:opacity-40"
                        />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          )}

          <ul className="space-y-1 text-[11px] text-muted-foreground list-disc pl-4" data-testid="signal-alerts-notes">
            {(rule === "macdx" ? a.macdxNotes : rule === "sweepx" ? a.sweepxNotes : rule === "amdpo3" ? a.amdpo3Notes : rule === "emarm" ? a.emarmNotes : rule === "stockmacd" ? a.stockmacdNotes : rule === "spike" ? a.spikeNotes : isIndicatorAlertRule(rule) ? a.indicatorNotes : rule === "gainz" ? a.gainzNotes : a.notes).map((n) => <li key={n}>{n}</li>)}
          </ul>

          <button
            onClick={() => void sendTest()}
            disabled={busy !== null || !settings.allowed}
            className="w-full px-3 py-2 rounded-lg border border-border text-xs font-medium text-foreground hover:bg-accent transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-1.5"
            data-testid="signal-alerts-test"
          >
            {busy === "test" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Mail className="h-3.5 w-3.5" />}
            {a.test}
          </button>

          {(() => {
            // #112: the record of the rule on screen
            const perf = settings.performance;
            // (#155: Q-Trend's and ULTRA's signals are not recorded)
            const record = perf && !isIndicatorAlertRule(rule) ? (rule === "gainz" ? perf.gainz : perf) : null;
            if (!record) return null;
            return (
              <div className="space-y-1.5 pt-1 border-t border-border/60" data-testid="signal-alerts-record">
                <p className="text-[11px] font-semibold text-foreground">{a.record.titleFor(a.ruleTabs[rule])}</p>
                {summaryBlock(a.record.mine, record.mine, "signal-alerts-record-mine")}
                {summaryBlock(a.record.all, record.all, "signal-alerts-record-all")}
                {record.backtest && (
                  <p className="text-[10px] text-muted-foreground">
                    {a.record.backtest(
                      record.backtest.period,
                      pct(record.backtest.winRate),
                      fmtR(record.backtest.meanR),
                      pct(record.backtest.breakeven),
                    )}
                  </p>
                )}
                {record.all.n < ENOUGH && (
                  <p className="text-[10px] text-warning" data-testid="signal-alerts-record-small">{a.record.small}</p>
                )}
                <p className="text-[10px] text-muted-foreground">{rule === "gainz" ? a.record.rNoteGainz : a.record.rNote}</p>
                <p className="text-[10px] text-muted-foreground">{a.record.method}</p>
              </div>
            );
          })()}

          <div className="space-y-1 pt-1 border-t border-border/60" data-testid="signal-alerts-recent">
            <p className="text-[11px] text-muted-foreground">{a.recentTitle}</p>
            {settings.alerts.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">{a.none}</p>
            ) : (
              settings.alerts.slice(0, 10).map((r) => {
                const d = r.pair ? priceDecimals(r.pair) : 3;
                const fmt = (v: number | null) => (v === null ? "—" : v.toFixed(d));
                return (
                  <div key={r.id} className="text-[11px] py-0.5" data-testid="signal-alert-row">
                    <div className="flex items-center gap-2 whitespace-nowrap">
                      <span className="font-mono text-muted-foreground">{jst(r.closedAt ?? r.createdAt)}</span>
                      <span className={r.rule === "spike" || r.ride === "out" || r.ride === "at" ? "text-foreground" : r.side === "BUY" ? "text-success" : r.side === "SELL" ? "text-destructive" : "text-foreground"}>
                        {rowLabel(r)}
                      </span>
                    </div>
                    <p className={statusClass(r)}>{statusLabel(r)}</p>
                    {(() => {
                      const res = resultLabel(r);
                      return res ? <p className={`font-mono ${res.cls}`} data-testid="signal-alert-result">{res.text}</p> : null;
                    })()}
                    {/* #397: email 2's two prices: the first email's, and the one when it was seen */}
                    {r.kind === "signal" && r.ride === "out" && (r.entry !== null || r.target !== null) && (
                      <p className="font-mono text-muted-foreground" data-testid="signal-alert-ride-prices">{a.ridePrices(fmt(r.entry), fmt(r.target))}</p>
                    )}
                    {/* the MACD fade: the price in only; no price is shown as a take-profit or a stop */}
                    {r.kind === "signal" && r.fade !== null && r.entry !== null && (
                      <p className="font-mono text-muted-foreground" data-testid="signal-alert-fade-plan">{a.fadePlan(fmt(r.entry))}</p>
                    )}
                    {r.kind === "signal" && r.fade === null && r.entry !== null && r.stop !== null && (
                      <p className="font-mono text-muted-foreground">{a.plan(fmt(r.entry), fmt(r.stop), fmt(r.target))}</p>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </>
      )}
    </div>
  );
};

export default SignalAlertSettings;
