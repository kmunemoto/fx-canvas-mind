import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Radio } from "lucide-react";
import PriceChart, { type FullscreenMenu } from "./PriceChart";
import { useT } from "@/lib/i18n";
import { parseUtcCandleTime, priceDecimals, toPips } from "@/lib/candleTime";
import {
  LIVE_INTERVALS,
  LIVE_PAIRS,
  TICK_MS,
  applyTick,
  LiveChartError,
  fetchLiveBars,
  fetchTicks,
  type LiveRead,
  type Tick,
} from "@/lib/liveChart";

// #114: which rule's signals the chart shows. GA-style on 1h is the
// recommended setting (docs §8.27): of the GA rule's three measured
// timeframes, the only one that did (slightly, within noise) better than
// entering at random in both periods. Not an edge: after the spread it lost.
export type LiveView = "gainz" | "rsi_sar" | "both";
const VIEWS: LiveView[] = ["gainz", "rsi_sar", "both"];
export const RECOMMENDED_INTERVAL = "1h";

const STEP_MS: Record<string, number> = { "1min": 60_000, "15min": 900_000, "1h": 3_600_000, "4h": 14_400_000, "1day": 86_400_000 };
// Asked again this long after a bar closes, so the feed has it
const AFTER_CLOSE_MS = 4_000;
// Asked again this often while the feed cannot be read (GMO's maintenance,
// an outage) or while no bar is forming (the market is shut): never every
// few seconds for a whole weekend
const RETRY_MS = 60_000;

interface Props {
  defaultInterval?: string;
  // Injected by tests; the app uses the real function
  loadBars?: (pair: string, interval: string) => Promise<LiveRead>;
  loadTicks?: () => Promise<Record<string, Tick>>;
}

// "19:15:07" in Japan time
const jstClock = (ms: number) => new Date(ms + 9 * 3_600_000).toISOString().slice(11, 19);
// "09-28 07:00" in Japan time
const jstDay = (ms: number) => new Date(ms + 9 * 3_600_000).toISOString().slice(5, 16).replace("T", " ");

// #113: five pairs, live. The bars and both rules' signals come from the
// live-chart function when a bar closes; in between, the price every few
// seconds moves the bar still forming. Signals are judged on closed bars
// only — the forming bar never makes or unmakes one.
const LiveChart = ({ defaultInterval, loadBars = fetchLiveBars, loadTicks = fetchTicks }: Props) => {
  const t = useT();
  const l = t.live;
  const [pair, setPair] = useState<string>(LIVE_PAIRS[0]);
  const [interval, setIntervalTf] = useState<string>(
    defaultInterval && LIVE_INTERVALS.includes(defaultInterval) ? defaultInterval : RECOMMENDED_INTERVAL,
  );
  const [view, setView] = useState<LiveView>("gainz");
  const [read, setRead] = useState<LiveRead | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reopens, setReopens] = useState<string | null>(null);
  const [ticks, setTicks] = useState<Record<string, Tick>>({});
  const [tickError, setTickError] = useState<string | null>(null);
  const [tickAt, setTickAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // the newest signal seen per rule, so a new one can be pointed out
  const seen = useRef<{ key: string; initial: boolean }>({ key: "", initial: true });
  const [fresh, setFresh] = useState<string | null>(null);
  // what is on screen now: a read for a chart the user has left is dropped
  const current = useRef({ pair, interval });
  current.current = { pair, interval };

  const load = useCallback(async (p: string, iv: string) => {
    try {
      const r = await loadBars(p, iv);
      if (current.current.pair !== p || current.current.interval !== iv) return;
      // A signal on the newest closed bar that was not there on the last
      // read of this same chart is new: say so once
      const newest = [r.latest.rsiSar, r.latest.gainz].filter((m): m is NonNullable<typeof m> => m !== null && m.barsAgo === 0);
      const key = `${p}|${iv}|${newest.map((m) => `${m.rule}:${m.side}:${m.datetime}`).join(",")}`;
      if (!seen.current.initial && newest.length > 0 && key !== seen.current.key) {
        setFresh(newest.map((m) => `${m.rule === "gainz" ? l.ruleGa : l.ruleRsiSar} ${l.sides[m.side]}`).join(" / "));
      }
      seen.current = { key, initial: false };
      setRead(r);
      setReopens(r.reopens);
      setError(null);
    } catch (err) {
      if (current.current.pair !== p || current.current.interval !== iv) return;
      setError(err instanceof Error ? err.message : "error");
      if (err instanceof LiveChartError) setReopens(err.reopens);
    }
  }, [loadBars, l]);

  // The bars: now, on a new pair or timeframe, and again when each bar closes
  useEffect(() => {
    setRead(null);
    setFresh(null);
    seen.current = { key: "", initial: true };
    void load(pair, interval);
  }, [pair, interval, load]);

  useEffect(() => {
    if (!read?.nextClose) return;
    const due = Date.parse(read.nextClose) + AFTER_CLOSE_MS - Date.now();
    // a close already past means no bar is forming (the market is shut):
    // look again once a minute, not every few seconds
    const wait = due <= 0 ? RETRY_MS : Math.min(Math.max(due, 5_000), 3_600_000);
    const id = window.setTimeout(() => void load(pair, interval), wait);
    return () => window.clearTimeout(id);
  }, [read, pair, interval, load]);

  // A read that failed is tried again, once a minute
  useEffect(() => {
    if (!error) return;
    const id = window.setTimeout(() => void load(pair, interval), RETRY_MS);
    return () => window.clearTimeout(id);
  }, [error, pair, interval, load]);

  // The price, every few seconds while the page is on screen
  useEffect(() => {
    let stop = false;
    // while GMO is down for maintenance, ask once a minute, not every 5 s
    let quietUntil = 0;
    const tick = async () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      if (Date.now() < quietUntil) return;
      try {
        const got = await loadTicks();
        if (stop) return;
        setTicks(got);
        setTickAt(Date.now());
        setTickError(null);
      } catch (err) {
        // the chart keeps its last price; the "updated" time says how old it is
        const code = err instanceof Error ? err.message : "error";
        if (code === "maintenance") quietUntil = Date.now() + RETRY_MS;
        if (!stop) setTickError(code);
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), TICK_MS);
    const clock = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => {
      stop = true;
      window.clearInterval(id);
      window.clearInterval(clock);
    };
  }, [loadTicks]);

  // v3: GMO cannot be read, so the bars are Twelve Data's last ones and no
  // price moves them
  const fallback = read?.source === "twelvedata";
  const tick = fallback ? null : ticks[pair] ?? null;
  const step = STEP_MS[interval] ?? 60_000;
  // the forming bar, when the read has one: the last candle opened one step
  // before the next close
  const formingOpen = (() => {
    if (!read?.nextClose || read.candles.length === 0) return null;
    const open = Date.parse(read.nextClose) - step;
    const last = parseUtcCandleTime(read.candles[read.candles.length - 1].datetime);
    return last === open ? open : null;
  })();
  const tickMs = tick?.time ? Date.parse(tick.time) : tickAt;
  const candles = read && tick && tick.open && tickMs !== null ? applyTick(read.candles, tick.mid, formingOpen, tickMs, step) : read?.candles ?? [];
  const d = priceDecimals(pair);
  const intervals = t.control.intervals as Record<string, string>;
  const sideText = (s: "BUY" | "SELL" | null) => (s === null ? l.none : l.sides[s]);
  // #114: the signals of the rule on screen, and the newest of them
  const marks = read ? read.marks.filter((m) => view === "both" || m.rule === view) : [];
  const latest = (() => {
    if (!read) return null;
    const own = [read.latest.gainz, read.latest.rsiSar].filter((m): m is NonNullable<typeof m> => m !== null && (view === "both" || m.rule === view));
    return own.sort((a, b) => (a.datetime < b.datetime ? 1 : -1))[0] ?? null;
  })();
  const nextCloseMs = read?.nextClose ? Date.parse(read.nextClose) : null;
  const remain = nextCloseMs !== null ? Math.max(0, Math.round((nextCloseMs - now) / 1000)) : null;
  const remainText = remain === null ? "—" : remain >= 3600
    ? `${Math.floor(remain / 3600)}:${String(Math.floor((remain % 3600) / 60)).padStart(2, "0")}:${String(remain % 60).padStart(2, "0")}`
    : `${Math.floor(remain / 60)}:${String(remain % 60).padStart(2, "0")}`;

  // #116: the tabs, the price and a new signal's notice — in the card, and
  // over the chart in full screen, so the pair and timeframe can be changed
  // without leaving it
  const tabs = () => {
    const row = "flex flex-wrap items-center gap-1";
    return (
    <>
      <div className={row} role="tablist" aria-label={l.pairsLabel} data-testid="live-pairs">
        {LIVE_PAIRS.map((p) => {
          const tk = ticks[p];
          return (
            <button
              key={p}
              type="button"
              role="tab"
              aria-selected={p === pair}
              onClick={() => setPair(p)}
              data-testid={`live-pair-${p}`}
              className={`px-2 py-1 rounded border text-[11px] font-mono ${
                p === pair ? "border-primary/60 bg-primary/10 text-primary" : "border-border text-muted-foreground"
              }`}
            >
              {p}
              {tk ? <span className="ml-1 text-foreground">{tk.mid.toFixed(priceDecimals(p))}</span> : null}
            </button>
          );
        })}
      </div>
      <div className={row} role="tablist" aria-label={l.intervalsLabel} data-testid="live-intervals">
        {LIVE_INTERVALS.map((iv) => (
          <button
            key={iv}
            type="button"
            role="tab"
            aria-selected={iv === interval}
            onClick={() => setIntervalTf(iv)}
            data-testid={`live-interval-${iv}`}
            className={`px-2 py-0.5 rounded border text-[11px] ${
              iv === interval ? "border-primary/60 bg-primary/10 text-primary" : "border-border text-muted-foreground"
            }`}
          >
            {intervals[iv] ?? iv}
          </button>
        ))}
      </div>

      <div className={row} role="tablist" aria-label={l.viewLabel} data-testid="live-views">
        {VIEWS.map((v) => (
          <button
            key={v}
            type="button"
            role="tab"
            aria-selected={v === view}
            onClick={() => setView(v)}
            data-testid={`live-view-${v}`}
            className={`px-2 py-0.5 rounded border text-[11px] ${
              v === view ? "border-primary/60 bg-primary/10 text-primary" : "border-border text-muted-foreground"
            }`}
          >
            {l.views[v]}
          </button>
        ))}
      </div>
    </>
    );
  };
  // #118: full screen's two sheets, as TradingView's app has them — the
  // pairs with their prices, and the timeframes with which signals to show
  const sheetRow = (on: boolean) =>
    `flex w-full items-center gap-3 rounded-lg px-2 py-2.5 text-left ${on ? "bg-primary/10" : "hover:bg-muted/40"}`;
  const symbolMenu: FullscreenMenu = {
    label: pair.replace("/", ""),
    title: l.pairsLabel,
    render: (close) => (
      <ul className="divide-y divide-border" data-testid="live-sheet-pairs">
        {LIVE_PAIRS.map((p) => {
          const tk = ticks[p];
          return (
            <li key={p}>
              <button
                type="button"
                aria-pressed={p === pair}
                onClick={() => {
                  setPair(p);
                  close();
                }}
                data-testid={`live-sheet-pair-${p}`}
                className={sheetRow(p === pair)}
              >
                <span className="flex-1 min-w-0">
                  <span className="block text-base font-semibold">{p.replace("/", "")}</span>
                  <span className="block text-xs text-muted-foreground truncate">{l.pairNames[p] ?? p}</span>
                </span>
                <span className="font-mono text-sm">{tk ? tk.mid.toFixed(priceDecimals(p)) : ""}</span>
                <Check className={`h-5 w-5 ${p === pair ? "text-primary" : "invisible"}`} />
              </button>
            </li>
          );
        })}
      </ul>
    ),
  };
  const intervalMenu: FullscreenMenu = {
    label: l.intervalShort[interval] ?? interval,
    title: l.intervalsLabel,
    render: (close) => (
      <div className="space-y-4">
        <div className="grid grid-cols-3 gap-2" data-testid="live-sheet-intervals">
          {LIVE_INTERVALS.map((iv) => (
            <button
              key={iv}
              type="button"
              aria-pressed={iv === interval}
              onClick={() => {
                setIntervalTf(iv);
                close();
              }}
              data-testid={`live-sheet-interval-${iv}`}
              className={`rounded-lg border px-2 py-2.5 text-sm ${iv === interval ? "border-primary/60 bg-primary/10 text-primary" : "border-border"}`}
            >
              {intervals[iv] ?? iv}
            </button>
          ))}
        </div>
        <section className="space-y-2">
          <h4 className="text-xs text-muted-foreground">{l.viewLabel}</h4>
          <div className="grid grid-cols-3 gap-2">
            {VIEWS.map((v) => (
              <button
                key={v}
                type="button"
                aria-pressed={v === view}
                onClick={() => {
                  setView(v);
                  close();
                }}
                data-testid={`live-sheet-view-${v}`}
                className={`rounded-lg border px-2 py-2.5 text-sm ${v === view ? "border-primary/60 bg-primary/10 text-primary" : "border-border"}`}
              >
                {l.views[v]}
              </button>
            ))}
          </div>
          {view === "gainz" && <p className="text-[11px] text-muted-foreground">{l.recommended}</p>}
        </section>
      </div>
    ),
  };
  const priceLine = tick ? (
    <p className="text-xs font-mono" data-testid="live-price">
      {l.bidAsk(tick.bid.toFixed(d), tick.ask.toFixed(d), toPips(pair, tick.ask - tick.bid).toFixed(1))}
      {!tick.open && <span className="ml-2 text-warning" data-testid="live-closed">{l.closed}</span>}
    </p>
  ) : null;
  const freshLine = fresh && (
    <p className="text-xs font-semibold text-primary" data-testid="live-fresh">{l.fresh(fresh)}</p>
  );

  return (
    <div className="glass rounded-xl border border-border p-4 space-y-3" data-testid="live-chart">
      <div className="flex items-center gap-2">
        <Radio className="h-4 w-4 text-primary" />
        <h3 className="text-sm font-semibold text-foreground">{l.title}</h3>
        <span className="ml-auto text-[10px] text-muted-foreground font-mono" data-testid="live-updated">
          {tickError === "maintenance" ? l.maintenanceShort : tickAt !== null ? l.updated(jstClock(tickAt)) : l.connecting}
        </span>
      </div>

      {tabs()}
      {view === "gainz" && <p className="text-[10px] text-muted-foreground" data-testid="live-recommended">{l.recommended}</p>}

      {priceLine}

      {freshLine}

      {fallback && read && (
        <p className="text-[11px] text-warning" data-testid="live-fallback">
          {l.fallback(read.feed === "maintenance", read.fetchedAt ? jstDay(Date.parse(read.fetchedAt)) : "—")}
        </p>
      )}
      {reopens && (
        <p className="text-[11px] text-muted-foreground" data-testid="live-reopens">{l.reopens(jstDay(Date.parse(reopens)))}</p>
      )}

      {error && !read ? (
        error === "maintenance" ? (
          <p className="text-xs text-warning" data-testid="live-maintenance">{l.maintenance}</p>
        ) : (
          <p className="text-xs text-destructive" data-testid="live-error">{l.error}</p>
        )
      ) : !read ? (
        <p className="text-xs text-muted-foreground" data-testid="live-loading">{l.loading}</p>
      ) : null}
      {/* #116: always here, bars or not, so a chart open in full screen
          stays open while the next pair or timeframe loads */}
      <PriceChart
        candles={read ? candles : []}
        pair={pair}
        marks={marks}
        // the GA view is the clean chart the reference draws: candles
        // and the rule's labels, no RSI strip or SAR dots
        rsi={view === "gainz" ? undefined : read?.rsi}
        sar={read?.sar}
        sarBelow={read?.sarBelow}
        // #115: the scalping indicator's drawing — each signal's
        // position box with an × where it settled, and the SAR as a band
        // (in the GA view, the band only: the rule does not read it)
        positions
        sarStyle={view === "gainz" ? "cloud" : "both"}
        gaStyle={view === "gainz" ? "filled" : "outline"}
        signalLegend={view === "gainz" ? l.gaLegend : l.rsiSarLegend}
        heading={`${pair} · ${intervals[interval] ?? interval}`}
        seriesKey={`${pair}|${interval}`}
        emptyText={error === "maintenance" ? l.maintenance : error ? l.error : l.loading}
        fullscreenMenus={{ symbol: symbolMenu, interval: intervalMenu }}
        fullscreenStatus={
          priceLine || freshLine ? (
            <>
              {priceLine}
              {freshLine}
            </>
          ) : undefined
        }
      />
      {read && (
        <>
          {latest && (
            <div className="rounded-lg border border-border p-2 space-y-0.5" data-testid="live-latest">
              <p className="text-[10px] text-muted-foreground">{l.latestTitle(latest.rule === "gainz" ? l.ruleGa : l.ruleRsiSar)}</p>
              <p className="text-xs">
                <span className={`font-bold mr-2 ${latest.side === "BUY" ? "text-success" : "text-destructive"}`}>{latest.side}</span>
                <span className="font-mono text-muted-foreground">{jstDay(parseUtcCandleTime(latest.datetime) + step)}</span>
              </p>
              {latest.entry !== null && latest.target !== null && latest.stop !== null && (
                <p className="text-[11px] font-mono" data-testid="live-latest-plan">
                  {l.latestPlan(latest.entry.toFixed(d), latest.target.toFixed(d), latest.stop.toFixed(d))}
                </p>
              )}
              <p className="text-[11px] text-muted-foreground" data-testid="live-latest-outcome">{l.outcome[latest.outcome]}</p>
            </div>
          )}
          <div className="space-y-0.5 text-xs" data-testid="live-signals">
            <p>
              <span className="text-muted-foreground">{l.ruleRsiSar}: </span>
              <span className={read.now.rsiSar === "BUY" ? "text-success" : read.now.rsiSar === "SELL" ? "text-destructive" : "text-muted-foreground"}>
                {sideText(read.now.rsiSar)}
              </span>
            </p>
            <p>
              <span className="text-muted-foreground">{l.ruleGa}: </span>
              <span className={read.now.gainz === "BUY" ? "text-success" : read.now.gainz === "SELL" ? "text-destructive" : "text-muted-foreground"}>
                {sideText(read.now.gainz)}
              </span>
            </p>
            {nextCloseMs !== null && nextCloseMs > now && (
              <p className="text-muted-foreground font-mono" data-testid="live-next-close">{l.nextClose(jstClock(nextCloseMs).slice(0, 5), remainText)}</p>
            )}
          </div>
          <p className="text-[10px] text-muted-foreground">{l.note}</p>
        </>
      )}
    </div>
  );
};

export default LiveChart;
