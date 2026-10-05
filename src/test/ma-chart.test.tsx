import { describe, it, expect, vi, afterEach } from "vitest";
import { render as rtlRender, screen, fireEvent, waitFor, within, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";
import { LocaleProvider } from "@/lib/i18n";

vi.mock("@/lib/supabase", () => ({ supabase: {} }));

import PriceChart from "../components/PriceChart";
import LiveChart from "../components/LiveChart";
import { CHART_PREFS_KEY, OVERLAY_DEFAULTS, chartPrefsFrom, getChartPrefs, resetChartPrefsCache, setChartPrefs } from "../lib/chartPrefs";
import { MA_DEEP_FROM, MA_DEFAULTS, maValues } from "../lib/emaLines";
import { normalizeLiveRead, type LiveRead } from "../lib/liveChart";
import { liveRead } from "../../supabase/functions/live-chart/logic";
import type { QuoteCandle } from "../../supabase/functions/track-outcomes/quotes";
import type { NumericCandle } from "../lib/types";

// #201: the owner's 「チャートに移動平均線を載せただけのシンプルなチャートも別で欲しい」 —
// under the live chart, its own pair and timeframe, the same three lines,
// locked without a plan (Light and up)

const render = (ui: ReactElement): RenderResult => rtlRender(<LocaleProvider initial="ja">{ui}</LocaleProvider>);

const M15 = 15 * 60_000;
const T0 = Date.parse("2026-09-01T00:00:00Z");
const stamp = (i: number) => new Date(T0 + i * M15).toISOString().slice(0, 19).replace("T", " ");
const walk = (n: number, seed = 11) => {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  let p = 150;
  return Array.from({ length: n }, (_, k) => {
    const open = p;
    p += (rnd() - 0.5) * 0.2;
    return { datetime: stamp(k), open, close: p, high: Math.max(open, p) + rnd() * 0.05, low: Math.min(open, p) - rnd() * 0.05 };
  });
};
const quotes = (n: number): QuoteCandle[] =>
  walk(n).map((c) => {
    const iso = new Date(Date.parse(c.datetime.replace(" ", "T") + "Z")).toISOString();
    const side = (d: number) => ({ datetime: iso, open: c.open + d, high: c.high + d, low: c.low + d, close: c.close + d });
    return { datetime: iso, bid: side(-0.002), ask: side(0.002) };
  });
const NOW = T0 + 259 * M15 + 60_000;
const read = normalizeLiveRead(liveRead("USD/JPY", "15min", quotes(260), NOW))!;
const readFor = (pair: string, interval: string): LiveRead => ({ ...read, pair, interval, nextClose: new Date(Date.now() + 600_000).toISOString() });
// and with a signal of each rule on it
const marked = (): LiveRead => {
  const n = read.candles.length;
  const at = (i: number, rule: string, side: "BUY" | "SELL") => {
    const e = read.candles[i].close;
    return { datetime: read.candles[i].datetime, barsAgo: n - 1 - i, side, rule, level: null, entry: e, stop: e - 0.1, target: e + 0.2, stop_atr: null, outcome: "open" as const, bars: null, mfe_r: null };
  };
  const ga = at(n - 4, "gainz", "BUY");
  const rs = at(n - 20, "rsi_sar", "SELL");
  return { ...readFor("USD/JPY", "15min"), marks: [rs, ga], latest: { rsiSar: rs, gainz: ga } };
};
// the bars before the chart's, joined to them (the history every chart reads)
const firstAt = (Date.parse(read.candles[0].datetime.replace(" ", "T") + "Z") - T0) / M15;
const before = (n: number): NumericCandle[] => [...walk(n, 31).map((c, k) => ({ ...c, datetime: stamp(firstAt - n + k) })), ...read.candles.slice(0, -1)];
// the switches listed (not the list, its fold or legend)
const LISTED = /^chart-overlay-(?!list$|fold$|legend$)[a-zA-Z0-9]+$/;

// every indicator, strip and drawing saved on
const ALL_ON = {
  rsi: true,
  stoch: true,
  pctB: true,
  rci: true,
  blsh: true,
  macd: true,
  adx: true,
  overlays: Object.fromEntries(Object.keys(OVERLAY_DEFAULTS).map((k) => [k, true])),
};
// what is drawn for each of the others
const OTHERS = [
  "chart-kalman",
  "chart-supertrend",
  "chart-utbot",
  "chart-zoneshift",
  "chart-qtrend",
  "chart-ichimoku",
  "chart-macross",
  "chart-ultra",
  "chart-zltema",
  "chart-trendlines",
  "chart-stoch-form",
  "chart-pctb-legend",
  "chart-rci-legend",
  "chart-blsh-legend",
  "chart-macd-legend",
  "chart-adx-legend",
  "chart-kalman-legend",
  "chart-qtrend-legend",
  "chart-ultra-legend",
  "chart-macross-legend",
];

afterEach(() => {
  localStorage.clear();
  resetChartPrefsCache();
});

describe("#201 the chart with the moving averages alone", () => {
  it("draws the three lines and nothing else of what is saved on, and lists the three only (the saved choices kept)", () => {
    localStorage.setItem(CHART_PREFS_KEY, JSON.stringify(ALL_ON));
    resetChartPrefsCache();
    const candles = walk(400);
    // the full chart draws the others (so their absence below is the switch's doing)
    const full = render(<PriceChart candles={candles} pair="USD/JPY" />);
    const drawnOnFull = OTHERS.filter((id) => screen.queryByTestId(id));
    expect(drawnOnFull.length).toBeGreaterThanOrEqual(10);
    full.unmount();

    render(<PriceChart candles={candles} pair="USD/JPY" maOnly />);
    for (const k of ["ema50", "ema200", "ma3"]) expect(screen.getByTestId(`chart-${k}-line`)).toBeTruthy();
    for (const id of drawnOnFull) expect(screen.queryByTestId(id)).toBeNull();
    const listed = within(screen.getByTestId("chart-overlay-list"))
      .queryAllByTestId(LISTED)
      .map((el) => el.getAttribute("data-testid"));
    expect(listed).toEqual(["chart-overlay-ema50", "chart-overlay-ema200", "chart-overlay-ma3"]);
    // the saved choices are as they were, for the full chart
    const kept = chartPrefsFrom(JSON.parse(localStorage.getItem(CHART_PREFS_KEY)!));
    expect(kept.stoch && kept.macd && kept.overlays.qTrend && kept.overlays.ultra && kept.overlays.zoneShift).toBe(true);
  });

  it("a line switched off here is off on every chart; the others saved on stay on", () => {
    localStorage.setItem(CHART_PREFS_KEY, JSON.stringify(ALL_ON));
    resetChartPrefsCache();
    render(<PriceChart candles={walk(300)} pair="USD/JPY" maOnly />);
    fireEvent.click(screen.getByTestId("chart-toggle-ema200"));
    expect(screen.queryByTestId("chart-ema200-line")).toBeNull();
    const kept = getChartPrefs();
    expect(kept.overlays.ema200).toBe(false);
    expect(kept.overlays.qTrend && kept.overlays.kalman && kept.overlays.ema50 && kept.overlays.ma3 && kept.stoch && kept.blsh).toBe(true);
  });

  it("the lines' numbers from their gear are the ones every chart draws", () => {
    render(<PriceChart candles={walk(300)} pair="USD/JPY" maOnly />);
    fireEvent.click(screen.getByTestId("chart-settings-ma3"));
    fireEvent.click(screen.getByTestId("chart-ma-3-type-SMA"));
    fireEvent.change(screen.getByTestId("chart-ma-3-period"), { target: { value: "30" } });
    expect(getChartPrefs().maLines[2]).toEqual({ period: 30, type: "SMA" });
    expect(screen.getByTestId("chart-overlay-name-ma3").textContent).toBe("SMA 30");
  });

  it("in full screen, the settings sheet has the three lines and their numbers, not the stochastic's", () => {
    render(<PriceChart candles={walk(300)} pair="USD/JPY" maOnly />);
    fireEvent.click(screen.getByTestId("chart-fullscreen"));
    fireEvent.click(screen.getByTestId("chart-sheet-settings-open"));
    const sheet = screen.getByTestId("chart-settings");
    const listed = within(sheet)
      .queryAllByTestId(LISTED)
      .map((el) => el.getAttribute("data-testid"));
    expect(listed).toEqual(["chart-overlay-ema50", "chart-overlay-ema200", "chart-overlay-ma3"]);
    expect(within(sheet).getByTestId("chart-ma-form")).toBeTruthy();
    expect(within(sheet).queryByTestId("chart-stoch-form")).toBeNull();
  });

  it("locked: the three listed with 🔒 and none drawn, nothing else listed", () => {
    const onLocked = vi.fn();
    render(<PriceChart candles={walk(300)} pair="USD/JPY" maOnly indicatorsLocked onLockedIndicator={onLocked} />);
    expect(screen.queryByTestId("chart-ema")).toBeNull();
    const listed = within(screen.getByTestId("chart-overlay-list"))
      .queryAllByTestId(LISTED)
      .map((el) => el.getAttribute("data-testid"));
    expect(listed).toEqual(["chart-overlay-ema50", "chart-overlay-ema200", "chart-overlay-ma3"]);
    for (const k of ["ema50", "ema200", "ma3"]) expect(screen.queryByTestId(`chart-settings-${k}`)).toBeNull();
    fireEvent.click(screen.getByTestId("chart-lock-ma3"));
    expect(onLocked).toHaveBeenCalledTimes(1);
  });
});

describe("#201 the moving averages' chart beside the live chart", () => {
  const chart = (mode: "full" | "ma", over: Partial<Parameters<typeof LiveChart>[0]> = {}) => (
    <LiveChart
      mode={mode}
      loadBars={async (pair: string, interval: string) => readFor(pair, interval)}
      loadTicks={async () => ({})}
      loadHistory={async () => before(580)}
      loadDow={async () => []}
      indicatorsAllowed
      {...over}
    />
  );

  it("is titled as its own, with no signals, views, notices of the signals or drawing tools", async () => {
    localStorage.setItem(CHART_PREFS_KEY, JSON.stringify(ALL_ON));
    resetChartPrefsCache();
    // the live chart draws the signals and says them (so their absence below is the mode's doing)
    const full = render(chart("full", { loadBars: async () => marked() }));
    await waitFor(() => expect(screen.getByTestId("live-signals")).toBeTruthy());
    expect(document.querySelectorAll("[data-rule]").length).toBeGreaterThan(0);
    for (const id of ["live-views", "live-latest", "live-note", "chart-draw-open", "chart-signal-legend"]) expect(screen.getByTestId(id)).toBeTruthy();
    full.unmount();
    render(chart("ma", { loadBars: async () => marked() }));
    const card = screen.getByTestId("ma-chart");
    expect(within(card).getByRole("heading").textContent).toBe("移動平均線チャート");
    await waitFor(() => expect(within(card).getByTestId("ma-chart-note")).toBeTruthy());
    expect(screen.getByTestId("ma-chart-note").textContent).toContain("上のリアルタイムチャートと共通");
    for (const id of ["live-views", "live-signals", "live-latest", "live-note", "live-dow", "live-recommended-fold", "chart-draw-open", "chart-signal-legend", "chart-position-legend", "chart-sar"]) {
      expect(screen.queryByTestId(id)).toBeNull();
    }
    expect(document.querySelectorAll("[data-rule]").length).toBe(0);
    // nor any other indicator saved on, and only the three listed
    for (const id of OTHERS) expect(screen.queryByTestId(id)).toBeNull();
    const listed = within(screen.getByTestId("chart-overlay-list"))
      .queryAllByTestId(LISTED)
      .map((el) => el.getAttribute("data-testid"));
    expect(listed).toEqual(["chart-overlay-ema50", "chart-overlay-ema200", "chart-overlay-ma3"]);
    expect(screen.queryAllByTestId(/^chart-(signal|position|marker|exit)-/)).toEqual([]);
    expect(screen.getByTestId("chart-ema50-line")).toBeTruthy();
    expect(screen.getByTestId("live-pairs")).toBeTruthy();
    expect(screen.getByTestId("live-intervals")).toBeTruthy();
  });

  it("keeps its own pair and timeframe: chosen on either chart, the other stays where it is", async () => {
    localStorage.setItem(CHART_PREFS_KEY, JSON.stringify({ live: { pair: "EUR/JPY", interval: "1h", view: "both" }, maLive: { pair: "GBP/JPY", interval: "4h", view: null } }));
    resetChartPrefsCache();
    const loads: string[] = [];
    const loadBars = (who: string) => async (pair: string, interval: string) => {
      loads.push(`${who} ${pair} ${interval}`);
      return readFor(pair, interval);
    };
    render(
      <>
        {chart("full", { loadBars: loadBars("full") })}
        {chart("ma", { loadBars: loadBars("ma") })}
      </>,
    );
    const full = screen.getByTestId("live-chart");
    const ma = screen.getByTestId("ma-chart");
    await waitFor(() => expect(loads).toEqual(expect.arrayContaining(["full EUR/JPY 1h", "ma GBP/JPY 4h"])));
    expect(within(full).getByTestId("live-pair-EUR/JPY").getAttribute("aria-selected")).toBe("true");
    expect(within(ma).getByTestId("live-pair-GBP/JPY").getAttribute("aria-selected")).toBe("true");

    fireEvent.click(within(ma).getByTestId("live-pair-AUD/JPY"));
    fireEvent.click(within(ma).getByTestId("live-interval-5min"));
    await waitFor(() => expect(loads).toContain("ma AUD/JPY 5min"));
    expect(getChartPrefs().maLive).toEqual({ pair: "AUD/JPY", interval: "5min", view: null });
    expect(getChartPrefs().live).toEqual({ pair: "EUR/JPY", interval: "1h", view: "both" });
    expect(within(full).getByTestId("live-pair-EUR/JPY").getAttribute("aria-selected")).toBe("true");
    expect(within(full).getByTestId("live-interval-1h").getAttribute("aria-selected")).toBe("true");
    expect(loads.filter((x) => x.startsWith("full ") && !x.startsWith("full EUR/JPY 1h"))).toEqual([]);

    fireEvent.click(within(full).getByTestId("live-pair-USD/JPY"));
    await waitFor(() => expect(loads).toContain("full USD/JPY 1h"));
    expect(getChartPrefs().maLive).toEqual({ pair: "AUD/JPY", interval: "5min", view: null });
    expect(within(ma).getByTestId("live-pair-AUD/JPY").getAttribute("aria-selected")).toBe("true");
    expect(within(ma).getByTestId("live-interval-5min").getAttribute("aria-selected")).toBe("true");
  });

  it("opens on the first pair and the base timeframe when nothing of its own is kept, whatever the live chart's", async () => {
    localStorage.setItem(CHART_PREFS_KEY, JSON.stringify({ live: { pair: "EUR/JPY", interval: "1h", view: "both" } }));
    resetChartPrefsCache();
    const loadBars = vi.fn(async (pair: string, interval: string) => readFor(pair, interval));
    render(chart("ma", { loadBars }));
    await waitFor(() => expect(loadBars).toHaveBeenCalled());
    // (#138: the base timeframe, 4h)
    expect(loadBars.mock.calls[0]).toEqual(["USD/JPY", "4h"]);
  });

  it("an account's pair and timeframe for it, arriving after it opened, are shown on it alone", async () => {
    const loads: string[] = [];
    const loadBars = (who: string) => async (pair: string, interval: string) => {
      loads.push(`${who} ${pair} ${interval}`);
      return readFor(pair, interval);
    };
    render(
      <>
        {chart("full", { loadBars: loadBars("full") })}
        {chart("ma", { loadBars: loadBars("ma") })}
      </>,
    );
    await waitFor(() => expect(loads).toEqual(expect.arrayContaining(["full USD/JPY 4h", "ma USD/JPY 4h"])));
    setChartPrefs({ maLive: { pair: "CHF/JPY", interval: "1day", view: null } });
    await waitFor(() => expect(loads).toContain("ma CHF/JPY 1day"));
    expect(loads.filter((x) => x.startsWith("full "))).toEqual(["full USD/JPY 4h"]);
  });

  it("shares the three lines with the live chart: a number changed on one is drawn on both", async () => {
    render(
      <>
        {chart("full", { defaultInterval: "15min" })}
        {chart("ma", { defaultInterval: "15min" })}
      </>,
    );
    const full = screen.getByTestId("live-chart");
    const ma = screen.getByTestId("ma-chart");
    await waitFor(() => expect(within(ma).getByTestId("chart-ma3-line")).toBeTruthy());
    await waitFor(() => expect(within(full).getByTestId("chart-ma3-line")).toBeTruthy());
    fireEvent.click(within(ma).getByTestId("chart-overlay-fold"));
    fireEvent.click(within(ma).getByTestId("chart-settings-ma3"));
    fireEvent.change(within(ma).getByTestId("chart-ma-3-period"), { target: { value: "30" } });
    const all = [...before(580).slice(0, -(read.candles.length - 1)), ...read.candles];
    const want = `EMA 30 ${(maValues(all.map((c) => c.close), { period: 30, type: "EMA" }).at(-1) as number).toFixed(3)}`;
    await waitFor(() => expect(within(ma).getByTestId("chart-legend-ma3").textContent).toBe(want));
    expect(within(full).getByTestId("chart-legend-ma3").textContent).toBe(want);
    // and switched off on the live chart, off on this one
    fireEvent.click(within(full).getByTestId("chart-overlay-fold"));
    fireEvent.click(within(full).getByTestId("chart-toggle-ma3"));
    await waitFor(() => expect(within(ma).queryByTestId("chart-ma3-line")).toBeNull());
  });

  it("reads the bars before its own for its lines alone: not for the others saved on, nor Dow theory", async () => {
    const off = { ema50: false, ema200: false, ma3: false };
    for (const linesOn of [true, false]) {
      localStorage.clear();
      localStorage.setItem(CHART_PREFS_KEY, JSON.stringify({ ...ALL_ON, overlays: { ...ALL_ON.overlays, ...(linesOn ? {} : off) } }));
      resetChartPrefsCache();
      const loadBars = vi.fn(async (pair: string, interval: string) => readFor(pair, interval));
      const loadHistory = vi.fn(async (): Promise<NumericCandle[]> => []);
      const loadDeepHistory = vi.fn(async () => ({ bars: [] as NumericCandle[], complete: true }));
      const loadDow = vi.fn(async () => []);
      const { unmount } = render(chart("ma", { defaultInterval: "15min", loadBars, loadHistory, loadDeepHistory, loadDow }));
      await waitFor(() => expect(loadBars).toHaveBeenCalled());
      if (linesOn) await waitFor(() => expect(loadHistory).toHaveBeenCalledWith("USD/JPY", "15min"));
      await new Promise((r) => setTimeout(r, 50));
      if (!linesOn) expect(loadHistory).not.toHaveBeenCalled();
      // (Zero-lag TEMA is saved on; its deep read is the full chart's)
      expect(loadDow).not.toHaveBeenCalled();
      if (!linesOn) expect(loadDeepHistory).not.toHaveBeenCalled();
      unmount();
    }
  });

  it("reads the deep history for a line longer than MA_DEEP_FROM, not for Zero-lag TEMA saved on", async () => {
    for (const period of [MA_DEEP_FROM, MA_DEEP_FROM + 100]) {
      localStorage.clear();
      localStorage.setItem(
        CHART_PREFS_KEY,
        JSON.stringify({ overlays: { zlTema: true }, maLines: [MA_DEFAULTS[0], MA_DEFAULTS[1], { period, type: "SMA" }] }),
      );
      resetChartPrefsCache();
      // enough bars before the chart's for the defaults' EMA 200
      const common = before(580);
      const loadBars = vi.fn(async (pair: string, interval: string) => readFor(pair, interval));
      const loadDeepHistory = vi.fn(async () => ({ bars: [] as NumericCandle[], complete: true }));
      const { unmount } = render(chart("ma", { defaultInterval: "15min", loadBars, loadHistory: async () => common, loadDeepHistory }));
      await waitFor(() => expect(screen.getByTestId("chart-ema200-line")).toBeTruthy());
      if (period > MA_DEEP_FROM) await waitFor(() => expect(loadDeepHistory).toHaveBeenCalledWith("USD/JPY", "15min"));
      else {
        await new Promise((r) => setTimeout(r, 50));
        expect(loadDeepHistory).not.toHaveBeenCalled();
      }
      unmount();
    }
  });

  it("not for the golden and dead crosses' lines (the live chart's): a long line 1 switched off is not read deep for here", async () => {
    for (const mode of ["full", "ma"] as const) {
      localStorage.clear();
      localStorage.setItem(
        CHART_PREFS_KEY,
        JSON.stringify({ overlays: { maCross: true, ema50: false }, maLines: [{ period: MA_DEEP_FROM + 100, type: "EMA" }, MA_DEFAULTS[1], MA_DEFAULTS[2]] }),
      );
      resetChartPrefsCache();
      const loadDeepHistory = vi.fn(async () => ({ bars: [] as NumericCandle[], complete: true }));
      const { unmount } = render(chart(mode, { defaultInterval: "15min", loadDeepHistory }));
      await waitFor(() => expect(screen.getByTestId("chart-ema200-line")).toBeTruthy());
      if (mode === "full") await waitFor(() => expect(loadDeepHistory).toHaveBeenCalledWith("USD/JPY", "15min"));
      else {
        await new Promise((r) => setTimeout(r, 50));
        expect(loadDeepHistory).not.toHaveBeenCalled();
      }
      unmount();
    }
  });

  it("locked: the candles, the three lines with 🔒, no bars read before its own, and the note says the plan", async () => {
    const loadHistory = vi.fn(async (): Promise<NumericCandle[]> => []);
    const onLocked = vi.fn();
    render(chart("ma", { indicatorsAllowed: false, loadHistory, onLockedIndicator: onLocked }));
    await waitFor(() => expect(screen.getByTestId("ma-chart-note")).toBeTruthy());
    expect(screen.getByTestId("ma-chart-note").textContent).toContain("Light 以上");
    expect(screen.getByTestId("chart-candles")).toBeTruthy();
    expect(screen.queryByTestId("chart-ema")).toBeNull();
    fireEvent.click(screen.getByTestId("chart-overlay-fold"));
    fireEvent.click(screen.getByTestId("chart-lock-ema50"));
    expect(onLocked).toHaveBeenCalledTimes(1);
    await new Promise((r) => setTimeout(r, 50));
    expect(loadHistory).not.toHaveBeenCalled();
  });

  it("says the same in English", async () => {
    rtlRender(
      <LocaleProvider initial="en">
        {chart("ma", { indicatorsAllowed: false })}
      </LocaleProvider>,
    );
    expect(within(screen.getByTestId("ma-chart")).getByRole("heading").textContent).toBe("Moving averages chart");
    await waitFor(() => expect(screen.getByTestId("ma-chart-note")).toBeTruthy());
    expect(screen.getByTestId("ma-chart-note").textContent).toContain("Light and up");
  });
});
