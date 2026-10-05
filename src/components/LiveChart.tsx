import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, LayoutGrid, LineChart, Radio } from "lucide-react";
import PriceChart, { type FullscreenMenu } from "./PriceChart";
import { useT } from "@/lib/i18n";
import { isGoldPair, parseUtcCandleTime, priceDecimals, toPips } from "@/lib/candleTime";
import { type ChartPrefs, getChartPrefs, setChartPrefs, useChartPrefs } from "@/lib/chartPrefs";
import { maNeedsDeep } from "@/lib/emaLines";
import type { NumericCandle } from "@/lib/types";
import {
  INTERVAL_STEP_MS,
  LIVE_INTERVALS,
  LIVE_PAIRS,
  LIVE_PAIR_GROUPS,
  TICK_MS,
  LiveChartError,
  barEndMs,
  dowTfsFor,
  fetchDow,
  fetchLiveBars,
  fetchLiveHistory,
  fetchLiveDeepHistory,
  fetchTicks,
  historyBefore,
  intervalsFor,
  isTwelveFx,
  ownFeed,
  tickLive,
  unjudgedOf,
  withRead,
  type DowTf,
  type LiveBars,
  type LiveRead,
  type Tick,
} from "@/lib/liveChart";

// #114: which rule's signals the chart shows; GA-style is the recommended
// view. #138: the chart opens on 4h, the owner's base timeframe (the
// analysis has used it since #111): the spread takes the smallest share of
// the stop there (src/lib/costs.ts) and entering at random lost least there
// (docs §8.45). It was the timeframe the GA rule did (slightly, within
// noise) better than random on in both periods — 1h (§8.27), then 15min
// (§8.45).
export type LiveView = "gainz" | "rsi_sar" | "both";
const VIEWS: LiveView[] = ["gainz", "rsi_sar", "both"];
export const BASE_INTERVAL = "4h";

// #141: a saved choice, if the chart still offers it
const savedPair = (p: string | null): string | null => (p && LIVE_PAIRS.includes(p) ? p : null);
const savedInterval = (iv: string | null, pair: string): string | null => (iv && intervalsFor(pair).includes(iv) ? iv : null);
const savedView = (v: string | null): LiveView | null => (v && (VIEWS as string[]).includes(v) ? (v as LiveView) : null);

// #181: each timeframe's length (INTERVAL_STEP_MS), 15 of them
const STEP_MS = INTERVAL_STEP_MS;
// Asked again this long after a bar closes, so the feed has it
const AFTER_CLOSE_MS = 4_000;
// Asked again this often while the feed cannot be read (GMO's maintenance,
// an outage) or while no bar is forming (the market is shut): never every
// few seconds for a whole weekend
const RETRY_MS = 60_000;
// #129: the Dow reading is asked for this often while it is on (the
// function reads each timeframe again only once a newer bar has closed)
const DOW_POLL_MS = 60_000;
// #176: a deep history read the function stopped short of, asked again
// after this long, this many times at most in all
const DEEP_RETRY_MS = 1_500;
const DEEP_TRIES = 6;
// a timeframe's length, to tell which are above the chart's
const DOW_STEP_MS: Record<string, number> = { "5min": 300_000, "15min": 900_000, "1h": 3_600_000, "4h": 14_400_000 };

interface Props {
  defaultInterval?: string;
  // Injected by tests; the app uses the real function
  loadBars?: (pair: string, interval: string) => Promise<LiveRead>;
  // #154: told the pair on screen
  loadTicks?: (pair?: string) => Promise<Record<string, Tick>>;
  loadHistory?: (pair: string, interval: string) => Promise<NumericCandle[]>;
  // #176: the deep history, for the Zero-lag TEMA
  loadDeepHistory?: (pair: string, interval: string) => Promise<{ bars: NumericCandle[]; complete: boolean }>;
  loadDow?: (pair: string) => Promise<DowTf[]>;
  // #140: the indicators are a paid feature: without them none is drawn or
  // read (Dow theory's timeframes, the history for Zone Shift and the Pro
  // score), and a tap on a locked one calls `onLockedIndicator`
  indicatorsAllowed?: boolean;
  onLockedIndicator?: () => void;
  // #201: "ma" — the moving averages' own chart: the candles and the three
  // lines only (their numbers, kinds and switches shared with the full
  // chart), no signals, strips, Dow or other indicator, its own pair and
  // timeframe (kept as `maLive`)
  mode?: "full" | "ma";
}

// #153, #181: the chosen pair's or timeframe's button brought into sight
// within its row, which scrolls sideways — the row alone: #201, the page
// is not scrolled to a chart below the first as it opens
const showInRow = (row: HTMLElement | null, testid: string) => {
  const el = row ? Array.from(row.querySelectorAll<HTMLElement>("button")).find((b) => b.getAttribute("data-testid") === testid) : undefined;
  if (!row || !el) return;
  const r = row.getBoundingClientRect();
  const b = el.getBoundingClientRect();
  if (b.left < r.left) row.scrollLeft -= r.left - b.left;
  else if (b.right > r.right) row.scrollLeft += b.right - r.right;
};

// "19:15:07" in Japan time
const jstClock = (ms: number) => new Date(ms + 9 * 3_600_000).toISOString().slice(11, 19);
// "09-28 07:00" in Japan time
const jstDay = (ms: number) => new Date(ms + 9 * 3_600_000).toISOString().slice(5, 16).replace("T", " ");

// #113: five pairs, live. The bars and both rules' signals come from the
// live-chart function when a bar closes; in between, the price every few
// seconds moves the bar still forming. Signals are judged on closed bars
// only — the forming bar never makes or unmakes one.
const LiveChart = ({
  defaultInterval,
  loadBars = fetchLiveBars,
  loadTicks = fetchTicks,
  loadHistory = fetchLiveHistory,
  loadDeepHistory = fetchLiveDeepHistory,
  loadDow = fetchDow,
  indicatorsAllowed = true,
  onLockedIndicator,
  mode = "full",
}: Props) => {
  const t = useT();
  const l = t.live;
  const maMode = mode === "ma";
  // where its pair and timeframe are kept
  const keptOf = (p: ChartPrefs) => (maMode ? p.maLive : p.live);
  // #141: the pair, timeframe and signals chosen last (kept with the chart's
  // other settings, in this browser and with the account), each only if the
  // chart still offers it; a timeframe given by the page comes first
  const [pair, setPairOnly] = useState<string>(() => savedPair(keptOf(getChartPrefs()).pair) ?? LIVE_PAIRS[0]);
  const [interval, setIntervalTf] = useState<string>(() =>
    defaultInterval && LIVE_INTERVALS.includes(defaultInterval)
      ? defaultInterval
      : savedInterval(keptOf(getChartPrefs()).interval, savedPair(keptOf(getChartPrefs()).pair) ?? LIVE_PAIRS[0]) ?? BASE_INTERVAL,
  );
  const [view, setViewOnly] = useState<LiveView>(() => savedView(keptOf(getChartPrefs()).view) ?? "gainz");
  // what is chosen on the chart is kept
  const choose = (next: { pair?: string; interval?: string; view?: LiveView }) => {
    const p = next.pair ?? pair;
    // #127: a timeframe the pair does not have becomes the base one (#146:
    // every pair has every timeframe now; a saved one from elsewhere may not)
    const want = next.interval ?? interval;
    const iv = intervalsFor(p).includes(want) ? want : BASE_INTERVAL;
    const v = next.view ?? view;
    setPairOnly(p);
    setIntervalTf(iv);
    setViewOnly(v);
    setChartPrefs(maMode ? { maLive: { pair: p, interval: iv, view: null } } : { live: { pair: p, interval: iv, view: v } });
  };
  const setPair = (p: string) => choose({ pair: p });
  const chooseInterval = (iv: string) => choose({ interval: iv });
  // #153: the grouped list of every pair, and the row keeps the chosen pair
  // in sight (with 22 of them, #154: 37, #175: 18, #177: 19, #178: 20, #180:
  // 21, it may be far along the row; below)
  const [gridOpen, setGridOpen] = useState(false);
  const pairRowRef = useRef<HTMLDivElement>(null);
  // #181: the timeframes too, 15 of them, in one row that scrolls sideways
  const intervalRowRef = useRef<HTMLDivElement>(null);
  const setView = (v: LiveView) => choose({ view: v });
  // and the account's, when it arrives after the chart opened (or another
  // chart changes them), is shown
  const livePrefs = keptOf(useChartPrefs());
  const liveKey = `${livePrefs.pair}|${livePrefs.interval}|${livePrefs.view}`;
  const seenLiveKey = useRef(liveKey);
  useEffect(() => {
    if (seenLiveKey.current === liveKey) return;
    seenLiveKey.current = liveKey;
    const p = savedPair(livePrefs.pair) ?? pair;
    setPairOnly(p);
    setIntervalTf(savedInterval(livePrefs.interval, p) ?? (intervalsFor(p).includes(interval) ? interval : BASE_INTERVAL));
    setViewOnly(savedView(livePrefs.view) ?? view);
    // only a change in what is kept moves the chart
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveKey]);
  const [read, setRead] = useState<LiveRead | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reopens, setReopens] = useState<string | null>(null);
  const [ticks, setTicks] = useState<Record<string, Tick>>({});
  // #153: the row's chosen pair kept in sight; #154: again once the prices
  // are in, which widen every button, so a saved pair far along the row is
  // still in sight when the chart opens on it
  const pricesIn = Object.keys(ticks).length > 0;
  useEffect(() => showInRow(pairRowRef.current, `live-pair-${pair}`), [pair, pricesIn]);
  useEffect(() => showInRow(intervalRowRef.current, `live-interval-${interval}`), [interval]);
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
      if (!maMode && !seen.current.initial && newest.length > 0 && key !== seen.current.key) {
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
  }, [loadBars, l, maMode]);

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

  // The price, every few seconds while the page is on screen (#154: of the
  // pair on screen too, when the function reads it apart from the others)
  const tickNow = useRef<(() => void) | null>(null);
  useEffect(() => {
    let stop = false;
    // while GMO is down for maintenance, ask once a minute, not every 5 s
    let quietUntil = 0;
    // #154: an answer older than one already shown is dropped (asked for the
    // pair before, it may lack the new one's price)
    let asked = 0;
    let shown = 0;
    const tick = async () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      if (Date.now() < quietUntil) return;
      const mine = ++asked;
      try {
        const got = await loadTicks(current.current.pair);
        if (stop || mine < shown) return;
        shown = mine;
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
    tickNow.current = () => void tick();
    const id = window.setInterval(() => void tick(), TICK_MS);
    const clock = window.setInterval(() => setNow(Date.now()), 1_000);
    // #147: back on screen, the price now, not up to a tick later
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        setNow(Date.now());
        void tick();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stop = true;
      tickNow.current = null;
      window.clearInterval(id);
      window.clearInterval(clock);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [loadTicks]);
  // #154: another pair's price at once, not up to a tick later (the first
  // pair's is asked for as the chart opens, above)
  const tickedPair = useRef(pair);
  useEffect(() => {
    if (tickedPair.current === pair) return;
    tickedPair.current = pair;
    tickNow.current?.();
  }, [pair]);

  // #147: back on screen after a bar closed, the bars again at once (the
  // browser may have held the timer while the page was hidden)
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible" || !read?.nextClose) return;
      const due = Date.parse(read.nextClose) + AFTER_CLOSE_MS;
      if (Date.now() >= due && Date.now() - Date.parse(read.at) > AFTER_CLOSE_MS) void load(pair, interval);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [read, pair, interval, load]);

  // #124: the closed bars before the chart's, for Zone Shift's 200-bar
  // average — read while it is on, again for another pair or timeframe or
  // when the chart has moved past them, and once more on the next read
  // after one failed (never in a loop). GMO's only: not joined to Twelve
  // Data's bars.
  const chartPrefs = useChartPrefs();
  const overlays = chartPrefs.overlays;
  const zoneShiftOn = overlays.zoneShift;
  // #131: the Pro-style score reads the same history, #143: the EMA lines
  // (#200: the three moving averages),
  // and #145: Q-Trend (200 closes before its line) and BLSH (#140: none of
  // them while the indicators are locked)
  // #150: and the trend tools (their averages and ranges settle on it)
  // (#201: the moving averages' own chart, for its three lines only)
  const maSwitches = { ema50: overlays.ema50, ema200: overlays.ema200, ma3: overlays.ma3 };
  const historyOn =
    indicatorsAllowed &&
    (maMode
      ? overlays.ema50 || overlays.ema200 || overlays.ma3
      : zoneShiftOn || overlays.gainzPro || overlays.ema50 || overlays.ema200 || overlays.ma3 || overlays.qTrend || overlays.qtBlsh || chartPrefs.blsh ||
        overlays.autoTrend || overlays.maCross || overlays.ichimoku || chartPrefs.macd || chartPrefs.adx || overlays.ultra);
  const [history, setHistory] = useState<{ key: string; readAt: string; bars: NumericCandle[] | null; status: "loading" | "ready" | "error" } | null>(null);
  const historyKey = `${pair}|${interval}`;
  // (#127: or gold's own Twelve Data bars; #154: or a pair's GMO does not serve)
  const gmoRead = read && ownFeed(read) ? read : null;
  useEffect(() => {
    if (!historyOn || !gmoRead) return;
    const h = history;
    const fresh = h && h.key === historyKey && (h.status === "loading" || h.readAt === gmoRead.at || (h.status === "ready" && historyBefore(h.bars, gmoRead.candles) !== null));
    if (fresh) return;
    const readAt = gmoRead.at;
    setHistory({ key: historyKey, readAt, bars: h?.key === historyKey ? h.bars : null, status: "loading" });
    loadHistory(pair, interval).then(
      (bars) => {
        if (current.current.pair !== pair || current.current.interval !== interval) return;
        setHistory({ key: historyKey, readAt, bars, status: "ready" });
      },
      () => {
        if (current.current.pair !== pair || current.current.interval !== interval) return;
        setHistory({ key: historyKey, readAt, bars: null, status: "error" });
      },
    );
  }, [historyOn, gmoRead, history, historyKey, pair, interval, loadHistory]);

  // #176: the Zero-lag TEMA's deep history (live-chart's `deep`), read
  // while it is on, as the history above is; a read the function stopped
  // short (it keeps what it read, so the next goes on) is asked again
  // after DEEP_RETRY_MS, DEEP_TRIES times at most. Read again on the next
  // bar after one that failed or stopped short (`complete` false), and once
  // the chart has moved past it. The reading under way is called off when
  // the indicator is turned off, on another pair or timeframe, and when
  // the chart is left; "loading" is only believed while it goes on.
  // #200: and while a moving average on (or one of the crosses', when on)
  // is longer than MA_DEEP_FROM, or the history above is too few bars for
  // it (an EMA needs about three times its length; GMO's daily history is
  // this year's and last year's files only) — unless the deep read for this
  // pair and timeframe came back whole with no more bars than the history
  // above (GMO's weekly and monthly: that history is every bar there is).
  // Decided here, once, and told to the chart (`deepForMa`)
  const commonBefore = gmoRead && history?.key === historyKey ? historyBefore(history.bars, gmoRead.candles) : null;
  const [deepHistory, setDeepHistory] = useState<{
    key: string;
    readAt: string;
    bars: NumericCandle[] | null;
    status: "loading" | "ready" | "error";
    complete: boolean;
  } | null>(null);
  const deepNoMore =
    commonBefore !== null &&
    gmoRead !== null &&
    deepHistory?.key === historyKey &&
    deepHistory.status === "ready" &&
    deepHistory.complete &&
    // (still joined to the chart: one it has moved past is read again)
    (historyBefore(deepHistory.bars, gmoRead.candles)?.length ?? Infinity) <= commonBefore.length;
  const maDeep =
    indicatorsAllowed &&
    !deepNoMore &&
    maNeedsDeep(maMode ? maSwitches : overlays, chartPrefs.maLines, commonBefore && gmoRead ? { before: commonBefore.length, total: commonBefore.length + gmoRead.candles.length } : null);
  const deepOn = indicatorsAllowed && ((!maMode && overlays.zlTema) || maDeep);
  const deepRun = useRef<{ key: string; off: boolean } | null>(null);
  useEffect(() => () => {
    if (deepRun.current) deepRun.current.off = true;
  }, [deepOn, historyKey]);
  useEffect(() => {
    if (!deepOn || !gmoRead) return;
    const h = deepHistory;
    const live = deepRun.current !== null && !deepRun.current.off && deepRun.current.key === historyKey;
    const fresh = h && h.key === historyKey && (
      h.status === "loading"
        ? live
        : h.readAt === gmoRead.at || (h.status === "ready" && h.complete && historyBefore(h.bars, gmoRead.candles) !== null)
    );
    if (fresh) return;
    const readAt = gmoRead.at;
    if (deepRun.current) deepRun.current.off = true;
    const run = { key: historyKey, off: false };
    deepRun.current = run;
    const on = () => !run.off && current.current.pair === pair && current.current.interval === interval;
    // bars a read that stopped short brought, still joined to the chart:
    // drawn while they are read again, and kept if that read fails
    const kept = h?.key === historyKey && historyBefore(h.bars, gmoRead.candles) !== null ? h.bars : null;
    setDeepHistory({ key: historyKey, readAt, bars: kept, status: "loading", complete: false });
    void (async () => {
      let last: { bars: NumericCandle[]; complete: boolean } | null = null;
      for (let tries = 1; ; tries++) {
        try {
          last = await loadDeepHistory(pair, interval);
        } catch {
          if (!on()) return;
          // what an earlier try (or read) brought is shown; nothing at all
          // is an error
          const got = last ? last.bars : kept;
          setDeepHistory({ key: historyKey, readAt, bars: got, status: got ? "ready" : "error", complete: false });
          return;
        }
        if (!on()) return;
        if (last.complete || tries >= DEEP_TRIES) break;
        await new Promise((r) => setTimeout(r, DEEP_RETRY_MS));
        if (!on()) return;
      }
      setDeepHistory({ key: historyKey, readAt, bars: last.bars, status: "ready", complete: last.complete });
    })();
  }, [deepOn, gmoRead, deepHistory, historyKey, pair, interval, loadDeepHistory]);

  // #129: Dow theory on 4h, 1h, 15min and 5min for the pair on screen —
  // read while it is on, now and once a minute while the page is on
  // screen. A read that fails keeps the last one of the same pair.
  const dowOn = indicatorsAllowed && !maMode && overlays.dow;
  const [dowRead, setDowRead] = useState<{ pair: string; tfs: DowTf[]; status: "loading" | "ready" | "error" } | null>(null);
  useEffect(() => {
    if (!dowOn) return;
    let stop = false;
    const get = async () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      try {
        const tfs = await loadDow(pair);
        if (!stop) setDowRead({ pair, tfs, status: "ready" });
      } catch {
        if (!stop) setDowRead((r) => (r && r.pair === pair && r.tfs.length > 0 ? r : { pair, tfs: [], status: "error" }));
      }
    };
    setDowRead((r) => (r && r.pair === pair ? r : { pair, tfs: [], status: "loading" }));
    void get();
    const id = window.setInterval(() => void get(), DOW_POLL_MS);
    return () => {
      stop = true;
      window.clearInterval(id);
    };
  }, [dowOn, pair, loadDow]);
  const dowNow = dowRead && dowRead.pair === pair ? dowRead : null;
  // for the chart: its own timeframe's reading, and those above it
  const dowChart = useMemo(() => {
    const own = STEP_MS[interval] ?? 0;
    const tfs = dowNow?.tfs ?? [];
    return {
      current: tfs.find((d) => d.tf === interval) ?? null,
      higher: tfs.filter((d) => (DOW_STEP_MS[d.tf] ?? 0) > own),
      status: dowNow?.status ?? ("loading" as const),
    };
  }, [dowNow, interval]);

  // v3: GMO cannot be read, so the bars are Twelve Data's last ones and no
  // price moves them
  // (#127: not gold, whose bars are always Twelve Data's and move with its
  // price; #154: nor a pair GMO does not serve)
  const fallback = read !== null && !ownFeed(read);
  const tick = fallback ? null : ticks[pair] ?? null;
  const step = STEP_MS[interval] ?? 60_000;
  // #181: a bar's close from its open (a month's by the calendar)
  const endOf = useCallback((open: number) => barEndMs(interval, open), [interval]);
  // the forming bar, when the read has one: the last candle opened one step
  // before the next close (#181: or, as the function now says, at
  // `formingOpen`: a month is not one length)
  const formingOpen = (() => {
    if (!read?.nextClose || read.candles.length === 0) return null;
    const last = parseUtcCandleTime(read.candles[read.candles.length - 1].datetime);
    const open = read.formingOpen ?? Date.parse(read.nextClose) - step;
    return last === open ? open : null;
  })();
  const tickMs = tick?.time ? Date.parse(tick.time) : tickAt;
  // #147: the bars the prices have made on top of the read — the forming
  // bar's high and low kept, the next bar started as soon as its time comes
  // (tickLive, withRead)
  const chartKey = `${pair}|${interval}`;
  const [live, setLive] = useState<{ key: string; bars: LiveBars } | null>(null);
  useEffect(() => {
    if (!read) return;
    setLive((prev) => ({ key: chartKey, bars: withRead(read.candles, formingOpen, prev && prev.key === chartKey ? prev.bars : null) }));
    // formingOpen is the read's own
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [read]);
  useEffect(() => {
    if (!tick || !tick.open || tickMs === null) return;
    setLive((prev) => (prev && prev.key === chartKey ? { ...prev, bars: tickLive(prev.bars, tick.mid, tickMs, step, endOf) } : prev));
  }, [tick, tickMs, chartKey, step, endOf]);
  const shown: LiveBars | null = read ? (live && live.key === chartKey ? live.bars : { candles: read.candles, formingOpen }) : null;
  const candles = shown?.candles ?? [];
  const d = priceDecimals(pair);
  const intervals = t.control.intervals as Record<string, string>;
  // #124: what Zone Shift is computed over besides the chart's candles
  // (joined by the chart's first candle only, so the price moving the
  // forming one does not make it anew)
  const firstCandle = candles[0] ?? null;
  const zoneShiftHistory = useMemo(() => {
    const past = gmoRead && firstCandle && history?.key === historyKey ? historyBefore(history.bars, [firstCandle]) : null;
    if (past) return { bars: past, status: "ready" as const };
    return { bars: null, status: history?.key === historyKey && history.status === "error" ? ("error" as const) : ("loading" as const) };
  }, [gmoRead, firstCandle, history, historyKey]);
  // #176: the same for the Zero-lag TEMA, from its deep history (bars
  // kept while a short read is read again are drawn meanwhile)
  const zltHistory = useMemo(() => {
    const past = gmoRead && firstCandle && deepHistory?.key === historyKey ? historyBefore(deepHistory.bars, [firstCandle]) : null;
    if (past && deepHistory?.status !== "error") return { bars: past, status: "ready" as const };
    return { bars: null, status: deepHistory?.key === historyKey && deepHistory.status === "error" ? ("error" as const) : ("loading" as const) };
  }, [gmoRead, firstCandle, deepHistory, historyKey]);
  const sideText = (s: "BUY" | "SELL" | null) => (s === null ? l.none : l.sides[s]);
  // #114: the signals of the rule on screen, and the newest of them
  // (#201: none on the moving averages' own chart)
  const marks = read && !maMode ? read.marks.filter((m) => view === "both" || m.rule === view) : [];
  const latest = (() => {
    if (!read || maMode) return null;
    const own = [read.latest.gainz, read.latest.rsiSar].filter((m): m is NonNullable<typeof m> => m !== null && (view === "both" || m.rule === view));
    return own.sort((a, b) => (a.datetime < b.datetime ? 1 : -1))[0] ?? null;
  })();
  // #147: the bar forming on screen, which may be one the prices started
  const nextCloseMs = shown?.formingOpen != null ? endOf(shown.formingOpen) : read?.nextClose ? Date.parse(read.nextClose) : null;
  const remain = nextCloseMs !== null ? Math.max(0, Math.round((nextCloseMs - now) / 1000)) : null;
  const hms = (sec: number) => `${Math.floor(sec / 3600)}:${String(Math.floor((sec % 3600) / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;
  // #181: a week's and a month's bars close days away: the days said apart
  const remainText = remain === null ? "—" : remain >= 86_400
    ? l.remainDays(Math.floor(remain / 86_400), hms(remain % 86_400))
    : remain >= 3600
    ? hms(remain)
    : `${Math.floor(remain / 60)}:${String(remain % 60).padStart(2, "0")}`;

  // #116: the tabs, the price and a new signal's notice — in the card, and
  // over the chart in full screen, so the pair and timeframe can be changed
  // without leaving it
  const tabs = () => {
    const row = "flex flex-wrap items-center gap-1";
    return (
    <>
      {/* #144: the pairs in one row that scrolls sideways, so the chart sits higher.
          #153: with the broker's 21 pairs, a button before it opens them all
          at once, grouped, as the broker's own picker has them */}
      <div className="-mx-1 flex items-center gap-1 px-1">
      <button
        type="button"
        aria-expanded={gridOpen}
        aria-label={l.pairGrid}
        title={l.pairGrid}
        onClick={() => setGridOpen((v) => !v)}
        data-testid="live-pair-grid-open"
        className={`shrink-0 rounded border p-1 ${gridOpen ? "border-primary/60 bg-primary/10 text-primary" : "border-border text-muted-foreground"}`}
      >
        <LayoutGrid className="h-4 w-4" />
      </button>
      <div ref={pairRowRef} className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto pb-0.5" role="tablist" aria-label={l.pairsLabel} data-testid="live-pairs">
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
              className={`shrink-0 whitespace-nowrap px-2 py-1 rounded border text-[11px] font-mono ${
                p === pair ? "border-primary/60 bg-primary/10 text-primary" : "border-border text-muted-foreground"
              }`}
            >
              {p}
              {tk ? <span className="ml-1 text-foreground">{tk.mid.toFixed(priceDecimals(p))}</span> : null}
            </button>
          );
        })}
      </div>
      </div>
      {gridOpen && (
        <div className="space-y-2 rounded-lg border border-border p-2" data-testid="live-pair-grid">
          {LIVE_PAIR_GROUPS.map((g) => (
            <section key={g.key} className="space-y-1" data-testid={`live-pair-group-${g.key}`}>
              <h4 className="text-[11px] font-semibold text-muted-foreground">{l.pairGroups[g.key] ?? g.key}</h4>
              <div className="grid grid-cols-3 gap-1 sm:grid-cols-4">
                {g.pairs.map((p) => {
                  const tk = ticks[p];
                  return (
                    <button
                      key={p}
                      type="button"
                      aria-pressed={p === pair}
                      onClick={() => {
                        setPair(p);
                        setGridOpen(false);
                      }}
                      data-testid={`live-grid-pair-${p}`}
                      className={`rounded border px-1 py-1 text-left ${
                        p === pair ? "border-primary/60 bg-primary/10 text-primary" : "border-border"
                      }`}
                    >
                      <span className="block truncate text-[11px] font-semibold">{l.pairShort[p] ?? l.pairNames[p] ?? p}</span>
                      <span className="flex items-baseline justify-between gap-1 font-mono text-[10px] text-muted-foreground">
                        <span>{p}</span>
                        <span className="text-foreground">{tk ? tk.mid.toFixed(priceDecimals(p)) : ""}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>
          ))}
          <p className="text-[10px] text-muted-foreground" data-testid="live-pair-grid-note">{l.pairGridNote}</p>
        </div>
      )}
      {/* #181: the broker's 15 timeframes in one row that scrolls sideways, as the pairs do */}
      <div ref={intervalRowRef} className="-mx-1 flex items-center gap-1 overflow-x-auto px-1 pb-0.5" role="tablist" aria-label={l.intervalsLabel} data-testid="live-intervals">
        {intervalsFor(pair).map((iv) => (
          <button
            key={iv}
            type="button"
            role="tab"
            aria-selected={iv === interval}
            onClick={() => chooseInterval(iv)}
            data-testid={`live-interval-${iv}`}
            className={`shrink-0 whitespace-nowrap px-2 py-0.5 rounded border text-[11px] ${
              iv === interval ? "border-primary/60 bg-primary/10 text-primary" : "border-border text-muted-foreground"
            }`}
          >
            {intervals[iv] ?? iv}
          </button>
        ))}
      </div>

      {!maMode && (
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
      )}
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
    // #153: grouped as the card's list is (FX, then the commodities)
    render: (close) => (
      <div className="space-y-3" data-testid="live-sheet-pairs">
      {LIVE_PAIR_GROUPS.map((g) => (
      <section key={g.key} data-testid={`live-sheet-group-${g.key}`}>
      <h4 className="px-2 pb-1 text-xs font-semibold text-muted-foreground">{l.pairGroups[g.key] ?? g.key}</h4>
      <ul className="divide-y divide-border">
        {g.pairs.map((p) => {
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
      </section>
      ))}
      </div>
    ),
  };
  const intervalMenu: FullscreenMenu = {
    label: l.intervalShort[interval] ?? interval,
    title: l.intervalsLabel,
    render: (close) => (
      <div className="space-y-4">
        {/* #181: four to a row, as the broker's menu has its 15 timeframes */}
        <div className="grid grid-cols-4 gap-2" data-testid="live-sheet-intervals">
          {intervalsFor(pair).map((iv) => (
            <button
              key={iv}
              type="button"
              aria-pressed={iv === interval}
              onClick={() => {
                chooseInterval(iv);
                close();
              }}
              data-testid={`live-sheet-interval-${iv}`}
              className={`rounded-lg border px-2 py-2.5 text-sm ${iv === interval ? "border-primary/60 bg-primary/10 text-primary" : "border-border"}`}
            >
              {intervals[iv] ?? iv}
            </button>
          ))}
        </div>
        {!maMode && (
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
        )}
      </div>
    ),
  };
  const priceLine = tick ? (
    <p className="text-xs font-mono" data-testid="live-price">
      {isGoldPair(pair)
        ? l.bidAskUsd(tick.bid.toFixed(d), tick.ask.toFixed(d), (tick.ask - tick.bid).toFixed(2))
        : l.bidAsk(tick.bid.toFixed(d), tick.ask.toFixed(d), toPips(pair, tick.ask - tick.bid).toFixed(1))}
      {!tick.open && <span className="ml-2 text-warning" data-testid="live-closed">{l.closed}</span>}
    </p>
  ) : null;
  const freshLine = fresh && (
    <p className="text-xs font-semibold text-primary" data-testid="live-fresh">{l.fresh(fresh)}</p>
  );
  // #129: each timeframe's Dow state, in the chart's colours
  const dowTone = (s: DowTf["state"]) =>
    s === "up" ? "text-success" : s === "down" ? "text-destructive" : s === "none" ? "text-muted-foreground" : "text-warning";
  const dowOf = (tf: string) => dowNow?.tfs.find((d) => d.tf === tf) ?? null;
  // one line over the chart in full screen
  const dowLine = dowOn && dowNow && dowNow.tfs.length > 0 ? (
    <p className="text-[11px] font-mono" data-testid="live-dow-compact">
      <span className="text-muted-foreground">{l.dowCompact} </span>
      {dowTfsFor(pair).map((tf, k) => {
        const d = dowOf(tf);
        return (
          <span key={tf}>
            {k > 0 ? <span className="text-muted-foreground"> · </span> : null}
            <span className="text-muted-foreground">{t.chart.dowTfShort[tf] ?? tf} </span>
            <span className={d ? dowTone(d.state) : "text-muted-foreground"}>{d ? l.dowShort[d.state] : "—"}</span>
          </span>
        );
      })}
    </p>
  ) : null;
  const dowPanel = dowOn ? (
    <div className="rounded-lg border border-border p-2 space-y-0.5" data-testid="live-dow">
      <p className="text-[10px] text-muted-foreground">{l.dowTitle(dowTfsFor(pair).map((tf) => l.dowTfNames[tf] ?? tf).join("・"))}</p>
      {dowNow && dowNow.tfs.length > 0
        ? dowTfsFor(pair).map((tf) => {
          const d = dowOf(tf);
          const since = d?.since ? parseUtcCandleTime(d.since) + (DOW_STEP_MS[tf] ?? 0) : null;
          return (
            <p key={tf} className={`text-xs flex flex-wrap items-baseline gap-x-2 ${tf === interval ? "font-semibold" : ""}`} data-testid={`live-dow-${tf}`}>
              <span className="w-10 shrink-0 text-muted-foreground">{l.dowTfNames[tf] ?? tf}</span>
              {d ? (
                <>
                  <span className={dowTone(d.state)} data-testid={`live-dow-state-${tf}`}>{l.dowStates[d.state]}</span>
                  {d.key && (
                    <span className="font-mono text-[11px] text-muted-foreground">
                      {l.dowKey(d.key.kind, d.key.price.toFixed(priceDecimals(pair)), d.state === "toDown" || d.state === "toUp")}
                    </span>
                  )}
                  {since !== null && Number.isFinite(since) && (
                    <span className="font-mono text-[10px] text-muted-foreground">{l.dowSince(jstDay(since))}</span>
                  )}
                </>
              ) : (
                <span className="text-muted-foreground">{l.dowTfError}</span>
              )}
            </p>
          );
        })
        : (
          <p className="text-xs text-muted-foreground" data-testid="live-dow-status">
            {dowNow?.status === "error" ? l.dowError : l.dowLoading}
          </p>
        )}
      <p className="text-[10px] text-muted-foreground">{l.dowHint}</p>
    </div>
  ) : null;

  return (
    <div className="glass rounded-xl border border-border p-4 space-y-3" data-testid={maMode ? "ma-chart" : "live-chart"}>
      <div className="flex items-center gap-2">
        {maMode ? <LineChart className="h-4 w-4 text-primary" /> : <Radio className="h-4 w-4 text-primary" />}
        <h3 className="text-sm font-semibold text-foreground">{maMode ? l.maTitle : l.title}</h3>
        <span className="ml-auto text-[10px] text-muted-foreground font-mono" data-testid="live-updated">
          {tickError === "maintenance" ? l.maintenanceShort : tickAt !== null ? l.updated(jstClock(tickAt)) : l.connecting}
        </span>
      </div>

      {tabs()}

      {priceLine}

      {freshLine}

      {fallback && read && (
        <p className="text-[11px] text-warning" data-testid="live-fallback">
          {l.fallback(read.feed === "maintenance", read.fetchedAt ? jstDay(Date.parse(read.fetchedAt)) : "—")}
        </p>
      )}
      {/* #146, #147: gold's bars could not be read again (the day's Twelve
          Data reads for this timeframe spent, or Twelve Data not answering):
          from when they are made from Swissquote's prices. #154: a pair's
          GMO does not serve, the same */}
      {read && read.source === "twelvedata" && ownFeed(read) && (read.limited || read.ticksFrom) && (
        <p className="text-[11px] text-warning" data-testid="live-ticks-limited">
          {l.fromTicks(
            l.pairShort[pair] ?? pair,
            intervals[interval] ?? interval,
            read.limited,
            read.ticksFrom ? jstDay(Date.parse(read.ticksFrom)) : null,
            read.feed !== "gold",
          )}
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
        // and the rule's labels, no RSI strip or SAR dots (#201: and the
        // moving averages' own chart, none of the signals' drawing)
        rsi={view === "gainz" || maMode ? undefined : read?.rsi}
        sar={maMode ? undefined : read?.sar}
        sarBelow={maMode ? undefined : read?.sarBelow}
        // #115: the scalping indicator's drawing — each signal's
        // position box with an × where it settled, and the SAR as a band
        // (in the GA view, the band only: the rule does not read it)
        positions={!maMode}
        sarStyle={view === "gainz" ? "cloud" : "both"}
        gaStyle={view === "gainz" ? "filled" : "outline"}
        signalLegend={maMode ? undefined : view === "gainz" ? l.gaLegend : l.rsiSarLegend}
        heading={`${pair} · ${intervals[interval] ?? interval}`}
        seriesKey={`${pair}|${interval}`}
        // #119: the newest candle is still forming while a close is due
        formingLast={shown?.formingOpen != null}
        // #149: indicators judge on the feed's bars only, not on those the
        // prices made since the last read
        unjudged={read ? unjudgedOf(read.candles.length, formingOpen !== null, candles.length) : 0}
        signalName={maMode ? undefined : l.signalNames[view]}
        emptyText={error === "maintenance" ? l.maintenance : error ? l.error : l.loading}
        zoneShiftHistory={zoneShiftHistory}
        deepHistory={zltHistory}
        deepForMa={maDeep}
        maOnly={maMode}
        dow={maMode ? undefined : dowChart}
        indicatorsLocked={!indicatorsAllowed}
        onLockedIndicator={onLockedIndicator}
        fullscreenMenus={{ symbol: symbolMenu, interval: intervalMenu }}
        // #201: the live chart alone opens on a phone turned sideways (two
        // would open over each other, and the page's scroll lock be left on)
        landscapeFullscreen={!maMode}
        // #160: lines drawn by hand, kept per pair (on every timeframe;
        // #201: on the full chart only)
        drawable={!maMode}
        fullscreenStatus={
          priceLine || freshLine || dowLine ? (
            <>
              {priceLine}
              {freshLine}
              {dowLine}
            </>
          ) : undefined
        }
      />
      {/* #201: the moving averages' own chart says when the bar closes and what it is */}
      {read && maMode && (
        <div className="space-y-0.5 text-xs" data-testid="ma-chart-info">
          {nextCloseMs !== null && nextCloseMs > now && (
            <p className="text-muted-foreground font-mono" data-testid="live-next-close">
              {l.nextClose(nextCloseMs - now >= 86_400_000 ? jstDay(nextCloseMs) : jstClock(nextCloseMs).slice(0, 5), remainText)}
            </p>
          )}
          <p className="text-[10px] text-muted-foreground" data-testid="ma-chart-note">{l.maNote(indicatorsAllowed)}</p>
        </div>
      )}
      {read && !maMode && (
        <>
          {latest && (
            <div className="rounded-lg border border-border p-2 space-y-0.5" data-testid="live-latest">
              <p className="text-[10px] text-muted-foreground">{l.latestTitle(latest.rule === "gainz" ? l.ruleGa : l.ruleRsiSar)}</p>
              <p className="text-xs">
                <span className={`font-bold mr-2 ${latest.side === "BUY" ? "text-success" : "text-destructive"}`}>{latest.side}</span>
                <span className="font-mono text-muted-foreground">{jstDay(endOf(parseUtcCandleTime(latest.datetime)))}</span>
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
              <p className="text-muted-foreground font-mono" data-testid="live-next-close">
                {/* #181: a close on another day says which (a week's, a month's, and the daily's across midnight) */}
                {l.nextClose(nextCloseMs - now >= 86_400_000 ? jstDay(nextCloseMs) : jstClock(nextCloseMs).slice(0, 5), remainText)}
              </p>
            )}
          </div>
          {dowPanel}
          {/* #144: said under the chart, folded */}
          {view === "gainz" && (
            <details data-testid="live-recommended-fold">
              <summary className="cursor-pointer text-[11px] text-muted-foreground hover:text-foreground">{l.recommendedTitle}</summary>
              <p className="pt-1 text-[10px] text-muted-foreground" data-testid="live-recommended">{l.recommended}</p>
            </details>
          )}
          <p className="text-[10px] text-muted-foreground" data-testid="live-note">{isGoldPair(pair) ? l.goldNote : isTwelveFx(pair) ? l.twelveNote : l.note}</p>
        </>
      )}
    </div>
  );
};

export default LiveChart;
