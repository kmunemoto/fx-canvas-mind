import { describe, it, expect, vi, afterEach } from "vitest";
import { render as rtlRender, screen, fireEvent, waitFor, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";
import { LocaleProvider } from "@/lib/i18n";

vi.mock("@/lib/supabase", () => ({ supabase: {} }));

import PriceChart from "../components/PriceChart";
import LiveChart from "../components/LiveChart";
import { CHART_PREFS_KEY, resetChartPrefsCache } from "../lib/chartPrefs";
import { historyBefore, normalizeHistory, normalizeLiveRead, type LiveRead } from "../lib/liveChart";
import { ZS_DEFAULTS, ema, hma, sma, wma, zoneShift } from "../lib/zoneShift";
import { HISTORY_BARS, historyRead, liveRead } from "../../supabase/functions/live-chart/logic";
import type { QuoteCandle } from "../../supabase/functions/track-outcomes/quotes";

const render = (ui: ReactElement): RenderResult => rtlRender(<LocaleProvider initial="ja">{ui}</LocaleProvider>);

type Bar = { open: number; high: number; low: number; close: number };
// Flat at 100 (range 1), a jump to 110 (an uptrend), a dip under the level
// and back (a retest), another within five candles (none), then a crash
// to 90 (a downtrend) — read with Length 44 (HMA 4) and a 3-candle range
// average so a short series has a band
const scenario = (): Bar[] => {
  const bars: Bar[] = [];
  const flat = (c: number, n: number) => {
    for (let k = 0; k < n; k++) bars.push({ open: c, high: c + 0.5, low: c - 0.5, close: c });
  };
  flat(100, 50); // 0..49
  bars.push({ open: 100, high: 110.5, low: 109, close: 110 }); // 50: the jump
  flat(110, 6); // 51..56
  bars.push({ open: 110, high: 110.2, low: 108.5, close: 108.8 }); // 57: a close under the level
  bars.push({ open: 108.8, high: 110.2, low: 108.7, close: 110 }); // 58: back over it: a retest
  bars.push({ open: 110, high: 110.1, low: 108.6, close: 108.7 }); // 59
  bars.push({ open: 108.7, high: 110.1, low: 108.6, close: 110 }); // 60: back over, within five: none
  flat(110, 3); // 61..63
  bars.push({ open: 110, high: 91, low: 89, close: 90 }); // 64: the crash
  flat(90, 3); // 65..67
  return bars;
};
const SHORT = { length: 44, rangeLength: 3 };

describe("#124 Zone Shift (a port of ChartPrime's open-source code): Pine's averages", () => {
  it("SMA and WMA are nothing until their window is full, or while it holds nothing", () => {
    expect(sma([1, 2, 3, 4], 2)).toEqual([null, 1.5, 2.5, 3.5]);
    expect(sma([1, null, 3, 4], 2)).toEqual([null, null, null, 3.5]);
    // weights 3 (the newest), 2, 1
    expect(wma([1, 2, 3], 3)).toEqual([null, null, (1 * 1 + 2 * 2 + 3 * 3) / 6]);
  });

  it("EMA starts as the simple average of its first values, then weighs each new one 2/(n+1)", () => {
    expect(ema([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
    expect(ema([1, 2], 3)).toEqual([null, null]);
  });

  it("HMA = WMA(2·WMA(n/2) − WMA(n), ⌊√n⌋): on a straight line, the line itself", () => {
    expect(hma([1, 2, 3, 4, 5, 6], 4).map((v) => (v === null ? null : Number(v.toFixed(10))))).toEqual([null, null, null, null, 5, 6]);
  });
});

describe("#124 Zone Shift: the band, the trend, the level and the retests", () => {
  it("has the published defaults: Length 100 (HMA 60), a 200-candle range average, retests more than 5 candles apart", () => {
    expect(ZS_DEFAULTS).toEqual({ length: 100, rangeLength: 200, retestGap: 5 });
    const flat = Array.from({ length: 230 }, () => ({ open: 100, high: 100.5, low: 99.5, close: 100 }));
    const r = zoneShift(flat);
    // the midline from the 100th candle (EMA 100), the band from the 200th
    expect(r.mid[98]).toBeNull();
    expect(r.mid[99]).toBe(100);
    expect(r.top[198]).toBeNull();
    expect(r.top[199]).toBe(101);
    expect(r.bot[199]).toBe(99);
    // down until the first uptrend, as the original starts
    expect(r.up.every((u) => u === false)).toBe(true);
  });

  it("turns up when a closed low crosses above the top line, and marks the level at that low", () => {
    const r = zoneShift(scenario(), undefined, SHORT);
    expect(r.mid[42]).toBeNull();
    expect(r.mid[43]).toBe(100);
    expect([r.top[49], r.bot[49]]).toEqual([101, 99]);
    expect(r.up[49]).toBe(false);
    expect(r.up[50]).toBe(true);
    expect(r.level[49]).toBeNull();
    // shown from the candle it first appears on
    expect(r.level[50]).toBe(109);
    expect(r.up.slice(50, 64).every(Boolean)).toBe(true);
  });

  it("marks a retest where the close crosses back over the level, but not again within five candles", () => {
    const r = zoneShift(scenario(), undefined, SHORT);
    expect(r.retests[0]).toEqual({ i: 58, up: true });
    expect(r.retests.some((x) => x.i === 60)).toBe(false);
  });

  it("turns down when a closed high crosses below the bottom line; the level breaks there and restarts at that high", () => {
    const r = zoneShift(scenario(), undefined, SHORT);
    expect(r.up[63]).toBe(true);
    expect(r.up[64]).toBe(false);
    expect(r.level[63]).toBe(109);
    expect(r.level[64]).toBeNull();
    expect(r.level[65]).toBe(91);
    // as the published code reads it: the crash is also a close under the
    // old level (trendStart[1]) after one over the new — a retest, six after the last
    expect(r.retests[1]).toEqual({ i: 64, up: false });
  });

  it("judges nothing on the candle still forming, but draws the band on it", () => {
    const bars = scenario().slice(0, 51);
    const r = zoneShift(bars, 49, SHORT);
    expect(r.up[50]).toBe(false);
    expect(r.level[50]).toBeNull();
    expect(r.mid[50]).not.toBeNull();
    expect(r.lastClosed).toBe(49);
  });
});

// A chart of 15-minute candles, oldest first
const M15 = 15 * 60_000;
const T0 = Date.parse("2026-09-21T00:00:00Z");
const series = (n: number, startMs = T0) =>
  Array.from({ length: n }, (_, i) => {
    const open = 150 + Math.sin(i / 9) * 0.6;
    const close = 150 + Math.sin((i + 1) / 9) * 0.6;
    return {
      datetime: new Date(startMs + i * M15).toISOString().slice(0, 19).replace("T", " "),
      open,
      close,
      high: Math.max(open, close) + 0.03,
      low: Math.min(open, close) - 0.03,
    };
  });

const candleFills = () => [...document.querySelectorAll("g[data-testid='chart-candles'] rect")].map((r) => r.getAttribute("fill"));

describe("#124 Zone Shift on the chart", () => {
  afterEach(() => {
    localStorage.clear();
    resetChartPrefsCache();
  });

  it("is not listed on a chart of its own 121 candles (too few for the 200-candle average) without history", () => {
    render(<PriceChart candles={series(121)} pair="USD/JPY" />);
    expect(screen.queryByTestId("chart-overlay-name-zoneShift")).toBeNull();
    expect(screen.queryByTestId("chart-zoneshift")).toBeNull();
  });

  it("is on with the history: the band, the candles in its trend's colours and a legend with the count; off by its eye", () => {
    const all = series(601);
    const past = all.slice(0, 480);
    const candles = all.slice(480);
    render(<PriceChart candles={candles} pair="USD/JPY" zoneShiftHistory={{ bars: past, status: "ready" }} />);
    expect(screen.getByTestId("chart-overlay-name-zoneShift").textContent).toBe("Zone Shift 100");
    expect(screen.getByTestId("chart-toggle-zoneShift").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("chart-zoneshift-top")).toBeTruthy();
    expect(screen.getByTestId("chart-zoneshift-bot")).toBeTruthy();
    expect(screen.getByTestId("chart-zoneshift-mid")).toBeTruthy();
    // every candle in lime or blue, as the trend at it
    const r = zoneShift(all);
    const want = candles.map((_, i) => (r.up[480 + i] ? "#00E676" : "#2962FF"));
    expect(candleFills()).toEqual(want);
    expect(screen.getByTestId("chart-zoneshift-legend").textContent).toContain("計算に使った足: 601本");
    expect(screen.getByTestId("chart-zoneshift-legend").textContent).toContain("MPL 2.0");

    fireEvent.click(screen.getByTestId("chart-toggle-zoneShift"));
    expect(screen.queryByTestId("chart-zoneshift")).toBeNull();
    expect(new Set(candleFills())).toEqual(new Set(["hsl(var(--success))", "hsl(var(--destructive))"]));
    expect(JSON.parse(localStorage.getItem(CHART_PREFS_KEY)!).overlays.zoneShift).toBe(false);
  });

  it("draws nothing and says why while the history is loading or could not be read (never every candle blue)", () => {
    const { unmount } = render(<PriceChart candles={series(121)} pair="USD/JPY" zoneShiftHistory={{ bars: null, status: "loading" }} />);
    expect(screen.getByTestId("chart-overlay-name-zoneShift")).toBeTruthy();
    expect(screen.queryByTestId("chart-zoneshift")).toBeNull();
    expect(candleFills()).not.toContain("#2962FF");
    expect(screen.getByTestId("chart-zoneshift-legend").textContent).toContain("読み込み中");
    unmount();
    render(<PriceChart candles={series(121)} pair="USD/JPY" zoneShiftHistory={{ bars: null, status: "error" }} />);
    expect(screen.getByTestId("chart-zoneshift-legend").textContent).toContain("過去の足を読めなかった");
  });

  it("marks the retests with a diamond under the candle (up) or over it (down)", () => {
    // 600 flat candles, then the scenario's jump, dip and crash, read with the defaults
    const flat = Array.from({ length: 600 }, () => ({ open: 100, high: 100.5, low: 99.5, close: 100 }));
    const all = [...flat, ...scenario().slice(50)].map((b, i) => ({ ...b, datetime: new Date(T0 + i * M15).toISOString().slice(0, 19).replace("T", " ") }));
    const r = zoneShift(all);
    expect(r.retests.map((x) => [x.i - 600, x.up])).toEqual([[8, true], [14, false]]);
    render(<PriceChart candles={all.slice(600)} pair="USD/JPY" zoneShiftHistory={{ bars: all.slice(0, 600), status: "ready" }} />);
    const upMark = screen.getByTestId("chart-zoneshift-retest-up");
    const downMark = screen.getByTestId("chart-zoneshift-retest-down");
    expect(upMark.getAttribute("fill")).toBe("#00E676");
    expect(downMark.getAttribute("fill")).toBe("#2962FF");
    // the level: dashed from the jump's low
    expect(screen.getByTestId("chart-zoneshift-level")).toBeTruthy();
  });
});

// ---- the live chart: the history read while it is on --------------------------------

const quotes = (n: number): QuoteCandle[] =>
  series(n).map((c, i) => {
    const iso = new Date(T0 + i * M15).toISOString();
    const side = (d: number) => ({ datetime: iso, open: c.open + d, high: c.high + d, low: c.low + d, close: c.close + d });
    return { datetime: iso, bid: side(-0.002), ask: side(0.002) };
  });

describe("#124 the live chart's history", () => {
  afterEach(() => {
    localStorage.clear();
    resetChartPrefsCache();
  });

  const NOW = T0 + 259 * M15 + 60_000;
  const readFor = (pair: string, interval: string): LiveRead => {
    const r = normalizeLiveRead(liveRead(pair, interval, quotes(260), NOW))!;
    return { ...r, pair, interval, nextClose: new Date(Date.now() + 600_000).toISOString() };
  };
  const historyFor = () => normalizeHistory(historyRead("USD/JPY", "15min", quotes(260), NOW))!;

  it("the function sends the closed bars only, rounded as the chart's, HISTORY_BARS deep", () => {
    expect(HISTORY_BARS).toBe(600);
    const h = historyRead("USD/JPY", "15min", quotes(260), NOW);
    // the 260th bar is forming
    expect(h.candles).toHaveLength(259);
    expect(h.candles.every((c) => Number(c.close.toFixed(3)) === c.close)).toBe(true);
  });

  it("is joined to the chart by its first candle, and dropped when it ends before the chart begins", () => {
    const h = historyFor();
    const read = readFor("USD/JPY", "15min");
    const past = historyBefore(h, read.candles)!;
    expect(past).toHaveLength(259 - 120);
    expect(past[past.length - 1].datetime < read.candles[0].datetime).toBe(true);
    expect(historyBefore(h.slice(0, 100), read.candles)).toBeNull();
    expect(normalizeHistory({ candles: [{ datetime: "x", open: 1, high: 1, low: 1 }] })).toBeNull();
  });

  it("is read once for the pair and timeframe while Zone Shift is on, and Zone Shift is drawn over it", async () => {
    const loadBars = vi.fn(async (pair: string, interval: string) => readFor(pair, interval));
    const loadHistory = vi.fn(async () => historyFor());
    render(<LiveChart defaultInterval="15min" loadBars={loadBars} loadTicks={async () => ({})} loadHistory={loadHistory} />);
    await waitFor(() => expect(screen.getByTestId("chart-zoneshift")).toBeTruthy());
    expect(loadHistory).toHaveBeenCalledTimes(1);
    expect(loadHistory).toHaveBeenCalledWith("USD/JPY", "15min");
    expect(screen.getByTestId("chart-zoneshift-legend").textContent).toContain("計算に使った足: 260本");
  });

  it("is not read while Zone Shift is off", async () => {
    localStorage.setItem(CHART_PREFS_KEY, JSON.stringify({ overlays: { zoneShift: false } }));
    const loadBars = vi.fn(async (pair: string, interval: string) => readFor(pair, interval));
    const loadHistory = vi.fn(async () => historyFor());
    render(<LiveChart defaultInterval="15min" loadBars={loadBars} loadTicks={async () => ({})} loadHistory={loadHistory} />);
    await waitFor(() => expect(screen.getByTestId("chart-candles")).toBeTruthy());
    await waitFor(() => expect(loadBars).toHaveBeenCalled());
    expect(loadHistory).not.toHaveBeenCalled();
    expect(screen.getByTestId("chart-toggle-zoneShift").getAttribute("aria-pressed")).toBe("false");
  });

  it("says so when the history cannot be read, and does not ask again until the next read", async () => {
    const loadBars = vi.fn(async (pair: string, interval: string) => readFor(pair, interval));
    const loadHistory = vi.fn(async () => {
      throw new Error("feed_unavailable");
    });
    render(<LiveChart defaultInterval="15min" loadBars={loadBars} loadTicks={async () => ({})} loadHistory={loadHistory} />);
    await waitFor(() => expect(screen.getByTestId("chart-zoneshift-legend").textContent).toContain("過去の足を読めなかった"));
    await new Promise((r) => setTimeout(r, 50));
    expect(loadHistory).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("chart-zoneshift")).toBeNull();
  });
});
