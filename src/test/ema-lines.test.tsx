import { describe, it, expect, vi, afterEach } from "vitest";
import { render as rtlRender, screen, fireEvent, waitFor, within, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";
import { LocaleProvider } from "@/lib/i18n";

vi.mock("@/lib/supabase", () => ({ supabase: {} }));

import PriceChart from "../components/PriceChart";
import LiveChart from "../components/LiveChart";
import { CHART_PREFS_KEY, chartPrefsFrom, getChartPrefs, resetChartPrefsCache, setChartPrefs } from "../lib/chartPrefs";
import { MA_DEFAULTS, MA_MAX, MA_SLOTS, crossPair, emaLine, maValues, measuredMa, normalizeMaLines } from "../lib/emaLines";
import { sma } from "../lib/zoneShift";
import { emaSeries } from "../../supabase/functions/analyze/indicators";
import { normalizeLiveRead, type LiveRead } from "../lib/liveChart";
import { liveRead } from "../../supabase/functions/live-chart/logic";
import type { QuoteCandle } from "../../supabase/functions/track-outcomes/quotes";
import type { NumericCandle } from "../lib/types";

const render = (ui: ReactElement): RenderResult => rtlRender(<LocaleProvider initial="ja">{ui}</LocaleProvider>);

const M15 = 15 * 60_000;
const T0 = Date.parse("2026-09-01T00:00:00Z");
const stamp = (i: number) => new Date(T0 + i * M15).toISOString().slice(0, 19).replace("T", " ");
const walk = (n: number, seed = 11, start = 0) => {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  let p = 150;
  return Array.from({ length: n }, (_, k) => {
    const open = p;
    p += (rnd() - 0.5) * 0.2;
    return { datetime: stamp(start + k), open, close: p, high: Math.max(open, p) + rnd() * 0.05, low: Math.min(open, p) - rnd() * 0.05 };
  });
};

// the y of each point of a path, in order
const ys = (d: string) => [...d.matchAll(/[ML][\d.]+,([\d.]+)/g)].map((m) => Number(m[1]));

describe("#143 the EMA lines", () => {
  it("are TradingView's EMA — the average of the first n closes, then 2 / (n + 1) of each — as #142 measured it", () => {
    const closes = walk(400).map((c) => c.close);
    for (const { period: length } of MA_DEFAULTS) {
      const mine = emaLine(closes, length);
      const study = emaSeries(closes, length);
      expect(mine[length - 2]).toBeNull();
      expect(mine[length - 1]).toBeCloseTo(closes.slice(0, length).reduce((a, b) => a + b, 0) / length, 12);
      mine.forEach((v, i) => (v === null ? expect(study[i]).toBeNull() : expect(v).toBeCloseTo(study[i] as number, 12)));
    }
    // #200: three lines, EMA 50, 200 and 20 until set otherwise
    expect(MA_DEFAULTS.map((l) => `${l.type} ${l.period}`)).toEqual(["EMA 50", "EMA 200", "EMA 20"]);
  });

  it("are on unless switched off, each listed with its line's colour, and switched off one by one", () => {
    expect(getChartPrefs().overlays.ema50).toBe(true);
    expect(getChartPrefs().overlays.ema200).toBe(true);
    expect(getChartPrefs().overlays.ma3).toBe(true);
    render(<PriceChart candles={walk(300)} pair="USD/JPY" />);
    expect(screen.getByTestId("chart-overlay-name-ema50").textContent).toBe("EMA 50");
    expect(screen.getByTestId("chart-overlay-name-ema200").textContent).toBe("EMA 200");
    expect(screen.getByTestId("chart-overlay-name-ma3").textContent).toBe("EMA 20");
    expect(screen.getByTestId("chart-ma3-line").getAttribute("stroke")).toBe("#00BCD4");
    expect(screen.getByTestId("chart-swatch-ema50").getAttribute("style")).toContain("rgb(255, 152, 0)");
    expect(screen.getByTestId("chart-ema50-line").getAttribute("stroke")).toBe("#FF9800");
    expect(screen.getByTestId("chart-ema200-line").getAttribute("stroke")).toBe("#E040FB");
    expect(screen.getByTestId("chart-ema-legend").textContent).toContain("71.6%");
    expect(screen.getByTestId("chart-ema-legend").textContent).toContain("計算に使った足: 300本");

    fireEvent.click(screen.getByTestId("chart-toggle-ema200"));
    expect(screen.queryByTestId("chart-ema200-line")).toBeNull();
    expect(screen.getByTestId("chart-ema50-line")).toBeTruthy();
    expect(JSON.parse(localStorage.getItem(CHART_PREFS_KEY)!).overlays.ema200).toBe(false);
    fireEvent.click(screen.getByTestId("chart-toggle-ema50"));
    fireEvent.click(screen.getByTestId("chart-toggle-ma3"));
    expect(screen.queryByTestId("chart-ema")).toBeNull();
    expect(screen.queryByTestId("chart-ema-legend")).toBeNull();
  });

  it("start where the average has its closes: EMA 200 is not drawn on a chart of 120 bars alone", () => {
    render(<PriceChart candles={walk(120)} pair="USD/JPY" />);
    expect(screen.getByTestId("chart-ema50-line")).toBeTruthy();
    expect(screen.queryByTestId("chart-ema200-line")).toBeNull();
  });

  it("over the bars before the chart's: drawn from the first candle once they are there, nothing while they load", () => {
    const all = walk(720);
    const past = all.slice(0, 600);
    const shown = all.slice(600);
    const { rerender } = render(<PriceChart candles={shown} pair="USD/JPY" zoneShiftHistory={{ bars: null, status: "loading" }} />);
    expect(screen.queryByTestId("chart-ema")).toBeNull();
    expect(screen.getByTestId("chart-ema-legend").textContent).toContain("読み込み中");

    rerender(
      <LocaleProvider initial="ja">
        <PriceChart candles={shown} pair="USD/JPY" zoneShiftHistory={{ bars: past, status: "ready" }} />
      </LocaleProvider>,
    );
    const d = screen.getByTestId("chart-ema200-line").getAttribute("d")!;
    // a point for every candle on the chart (none of them waits for 200)
    expect(ys(d)).toHaveLength(120);
    expect(screen.getByTestId("chart-ema-legend").textContent).toContain("計算に使った足: 720本");
  });

  it("are inside the price scale: a line far from the candles is fitted, not cut off", () => {
    // 250 bars flat at 100, then 120 bars at 110: EMA 200 sits well under
    // every candle on screen
    const bar = (i: number, p: number) => ({ datetime: stamp(i), open: p, high: p + 0.05, low: p - 0.05, close: p });
    const past = Array.from({ length: 250 }, (_, i) => bar(i, 100));
    const shown = Array.from({ length: 120 }, (_, i) => bar(250 + i, 110 + Math.sin(i / 4) * 0.2));
    render(<PriceChart candles={shown} pair="USD/JPY" zoneShiftHistory={{ bars: past, status: "ready" }} />);
    const svg = screen.getByTestId("chart-ema").closest("svg")!;
    const height = Number(svg.getAttribute("viewBox")!.split(" ")[3]);
    for (const k of ["chart-ema50-line", "chart-ema200-line"]) {
      const y = ys(screen.getByTestId(k).getAttribute("d")!);
      expect(Math.min(...y)).toBeGreaterThanOrEqual(0);
      expect(Math.max(...y)).toBeLessThanOrEqual(height);
    }
  });
});

const quotes = (n: number): QuoteCandle[] =>
  walk(n).map((c) => {
    const iso = new Date(Date.parse(c.datetime.replace(" ", "T") + "Z")).toISOString();
    const side = (d: number) => ({ datetime: iso, open: c.open + d, high: c.high + d, low: c.low + d, close: c.close + d });
    return { datetime: iso, bid: side(-0.002), ask: side(0.002) };
  });

describe("#143 the live chart reads the bars before its own for the EMA lines", () => {
  const NOW = T0 + 259 * M15 + 60_000;
  const readFor = (pair: string, interval: string): LiveRead => {
    const r = normalizeLiveRead(liveRead(pair, interval, quotes(260), NOW))!;
    return { ...r, pair, interval, nextClose: new Date(Date.now() + 600_000).toISOString() };
  };
  const chart = (loadHistory: (pair: string, interval: string) => Promise<NumericCandle[]>, allowed = true) => (
    <LiveChart
      defaultInterval="15min"
      loadBars={async (pair: string, interval: string) => readFor(pair, interval)}
      loadTicks={async () => ({})}
      loadHistory={loadHistory}
      loadDow={async () => []}
      indicatorsAllowed={allowed}
    />
  );

  it("with Zone Shift and the Pro-style score off, while an EMA line is on", async () => {
    localStorage.setItem(CHART_PREFS_KEY, JSON.stringify({ overlays: { zoneShift: false, gainzPro: false, ema50: false, ema200: true, ma3: false } }));
    const loadHistory = vi.fn(async (): Promise<NumericCandle[]> => []);
    render(chart(loadHistory));
    await waitFor(() => expect(loadHistory).toHaveBeenCalledWith("USD/JPY", "15min"));
  });

  it("not while the indicators are locked", async () => {
    const loadHistory = vi.fn(async (): Promise<NumericCandle[]> => []);
    render(chart(loadHistory, false));
    await waitFor(() => expect(screen.getByTestId("live-signals")).toBeTruthy());
    expect(loadHistory).not.toHaveBeenCalled();
    expect(screen.getByTestId("chart-lock-ema50")).toBeTruthy();
    expect(screen.getByTestId("chart-lock-ema200")).toBeTruthy();
    // #200: the third too, and no gear for their numbers while locked
    expect(screen.getByTestId("chart-lock-ma3")).toBeTruthy();
    for (const k of ["ema50", "ema200", "ma3"]) expect(screen.queryByTestId(`chart-settings-${k}`)).toBeNull();
    expect(screen.queryByTestId("chart-ema")).toBeNull();
  });
});

// #200: the owner's 「移動平均線を設定できる様にして 数字選んで」「3つほしい」
describe("#200 three moving averages, each at the number chosen", () => {
  afterEach(() => {
    localStorage.clear();
    resetChartPrefsCache();
  });
  const SMA25 = { period: 25, type: "SMA" as const };

  it("keep each line's number (a whole number from 1 to 500) and kind; anything else is that line's default", () => {
    expect(normalizeMaLines(undefined)).toEqual(MA_DEFAULTS);
    expect(normalizeMaLines([SMA25])).toEqual([SMA25, MA_DEFAULTS[1], MA_DEFAULTS[2]]);
    expect(normalizeMaLines([{ period: 0, type: "EMA" }, { period: MA_MAX + 1, type: "WMA" }, { period: 2.5 }])).toEqual(MA_DEFAULTS);
    expect(normalizeMaLines([{ period: "50" }, null, { period: MA_MAX, type: "SMA" }])).toEqual([MA_DEFAULTS[0], MA_DEFAULTS[1], { period: MA_MAX, type: "SMA" }]);
    // what was saved before #200 (no numbers, no third switch): the three
    // defaults, the third on, the other switches as they were
    const old = chartPrefsFrom({ overlays: { ema50: true, ema200: false } });
    expect(old.maLines).toEqual(MA_DEFAULTS);
    expect(old.overlays).toMatchObject({ ema50: true, ema200: false, ma3: true });
    // kept in this browser (and so with the account, #141) and read back
    const chosen = [SMA25, { period: 75, type: "SMA" as const }, { period: 5, type: "EMA" as const }];
    setChartPrefs({ maLines: chosen });
    expect(JSON.parse(localStorage.getItem(CHART_PREFS_KEY)!).maLines).toEqual(chosen);
    resetChartPrefsCache();
    expect(getChartPrefs().maLines).toEqual(chosen);
  });

  it("are TradingView's SMA (the mean of the last n closes) when SMA is chosen", () => {
    const closes = walk(120).map((c) => c.close);
    const mine = maValues(closes, SMA25);
    expect(mine[23]).toBeNull();
    expect(mine[24]).toBeCloseTo(closes.slice(0, 25).reduce((a, b) => a + b, 0) / 25, 12);
    expect(mine[119]).toBeCloseTo(closes.slice(95).reduce((a, b) => a + b, 0) / 25, 12);
    expect(maValues(closes, { period: 20, type: "EMA" })).toEqual(emaLine(closes, 20));
  });

  it("say which of them #142 measured: SMA 25, 75, 200 and EMA 50, 200 only", () => {
    for (const l of [SMA25, { period: 75, type: "SMA" }, { period: 200, type: "SMA" }, { period: 50, type: "EMA" }, { period: 200, type: "EMA" }] as const) expect(measuredMa(l)).toBe(true);
    for (const l of [{ period: 20, type: "EMA" }, { period: 50, type: "SMA" }, { period: 25, type: "EMA" }] as const) expect(measuredMa(l)).toBe(false);
  });

  it("from a line's gear: a number from the buttons or typed, EMA or SMA, each line on its own, the line drawn at it", () => {
    const candles = walk(300);
    const closes = candles.map((c) => c.close);
    render(<PriceChart candles={candles} pair="USD/JPY" />);
    expect(screen.queryByTestId("chart-ma-form")).toBeNull();
    for (const k of ["ema50", "ema200", "ma3"]) expect(screen.getByTestId(`chart-settings-${k}`)).toBeTruthy();
    fireEvent.click(screen.getByTestId("chart-settings-ma3"));
    expect(screen.getByTestId("chart-settings-ma3").getAttribute("aria-expanded")).toBe("true");
    const form = screen.getByTestId("chart-ma-form");
    expect(form.textContent).toContain("線1");
    expect(form.textContent).toContain("1〜500 の整数");
    // line 1: 25 from the buttons, then SMA
    fireEvent.click(screen.getByTestId("chart-ma-1-preset-25"));
    expect(screen.getByTestId("chart-ma-1-preset-25").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("chart-overlay-name-ema50").textContent).toBe("EMA 25");
    fireEvent.click(screen.getByTestId("chart-ma-1-type-SMA"));
    expect(screen.getByTestId("chart-overlay-name-ema50").textContent).toBe("SMA 25");
    expect(screen.getByTestId("chart-legend-ema50").textContent).toBe(`SMA 25 ${(maValues(closes, SMA25)[299] as number).toFixed(3)}`);
    // line 3: 13 typed (not a button); a number out of range is not taken
    fireEvent.change(screen.getByTestId("chart-ma-3-period"), { target: { value: "13" } });
    expect(screen.getByTestId("chart-overlay-name-ma3").textContent).toBe("EMA 13");
    expect(screen.getByTestId("chart-legend-ma3").textContent).toBe(`EMA 13 ${(emaLine(closes, 13)[299] as number).toFixed(3)}`);
    for (const v of ["0", "501", "2.5", ""]) {
      fireEvent.change(screen.getByTestId("chart-ma-3-period"), { target: { value: v } });
      expect(screen.getByTestId("chart-overlay-name-ma3").textContent).toBe("EMA 13");
    }
    // line 2 untouched; all kept
    expect(screen.getByTestId("chart-overlay-name-ema200").textContent).toBe("EMA 200");
    expect(JSON.parse(localStorage.getItem(CHART_PREFS_KEY)!).maLines).toEqual([SMA25, MA_DEFAULTS[1], { period: 13, type: "EMA" }]);
    // the note says what was not measured
    fireEvent.click(screen.getByTestId("chart-info-ema50"));
    expect(screen.getByTestId("chart-info-text-ema50").textContent).toContain("SMA 25（オレンジ）・EMA 200（紫）・EMA 13（水色）");
    expect(screen.getByTestId("chart-info-text-ema50").textContent).toContain("EMA 13 は測っていません");
    // and back to EMA 50, 200, 20
    fireEvent.click(screen.getByTestId("chart-ma-reset"));
    expect(MA_SLOTS.map((s) => screen.getByTestId(`chart-overlay-name-${s.key}`).textContent)).toEqual(["EMA 50", "EMA 200", "EMA 20"]);
  });

  it("the golden and dead crosses follow lines 1 and 2, the shorter as the fast one; none when they are the same line", () => {
    // down for 420 bars, then up: the short line crosses the long one from
    // below once, on the chart (its bars are 400 to 519)
    const bar = (i: number, p: number) => ({ datetime: stamp(i), open: p, high: p + 0.05, low: p - 0.05, close: p });
    const all = Array.from({ length: 520 }, (_, i) => bar(i, i < 420 ? 150 - i * 0.01 : 145.8 + (i - 420) * 0.03));
    const past = all.slice(0, 400);
    const shown = all.slice(400);
    localStorage.setItem(CHART_PREFS_KEY, JSON.stringify({ maLines: [{ period: 50, type: "EMA" }, { period: 20, type: "SMA" }, { period: 5, type: "EMA" }] }));
    expect(crossPair(getChartPrefs().maLines)).toEqual({ fast: { period: 20, type: "SMA" }, slow: { period: 50, type: "EMA" } });
    const { unmount } = render(<PriceChart candles={shown} pair="USD/JPY" zoneShiftHistory={{ bars: past, status: "ready" }} formingLast />);
    expect(screen.getByTestId("chart-overlay-name-maCross").textContent).toBe("GC・DC（SMA 20×EMA 50）");
    expect(screen.getByTestId("chart-macross-legend").textContent).toContain("短い方（SMA 20）が長い方（EMA 50）");
    // the crossing is where SMA 20 went above EMA 50
    const closes = all.map((c) => c.close);
    const f = maValues(closes, { period: 20, type: "SMA" });
    const s = maValues(closes, { period: 50, type: "EMA" });
    const at = f.findIndex((v, i) => i > 0 && v !== null && s[i] !== null && f[i - 1] !== null && s[i - 1] !== null && (f[i - 1] as number) <= (s[i - 1] as number) && v > (s[i] as number));
    expect(at).toBeGreaterThanOrEqual(420);
    expect(at).toBeLessThan(519);
    expect(screen.getAllByTestId("chart-macross-GC")).toHaveLength(1);
    expect(screen.getByTestId("chart-macross-GC").querySelector("title")!.textContent).toBe("ゴールデンクロス（SMA 20 が EMA 50 を上に抜けた）");
    expect(screen.queryByTestId("chart-macross-DC")).toBeNull();
    unmount();
    // lines 1 and 2 the same: no crosses, and the note says why
    setChartPrefs({ maLines: [{ period: 50, type: "EMA" }, { period: 50, type: "EMA" }, MA_DEFAULTS[2]] });
    render(<PriceChart candles={shown} pair="USD/JPY" zoneShiftHistory={{ bars: past, status: "ready" }} formingLast />);
    expect(screen.queryByTestId("chart-macross-GC")).toBeNull();
    expect(screen.queryByTestId("chart-macross-DC")).toBeNull();
    expect(screen.getByTestId("chart-macross-legend").textContent).toContain("同じ移動平均なので、交差はありません");
  });

  it("in full screen, the numbers are in the settings sheet", () => {
    render(<PriceChart candles={walk(120)} pair="USD/JPY" />);
    fireEvent.click(screen.getByTestId("chart-fullscreen"));
    const overlay = screen.getByTestId("chart-fullscreen-overlay");
    fireEvent.click(within(overlay).getByTestId("chart-sheet-settings-open"));
    fireEvent.click(within(overlay).getByTestId("chart-ma-2-preset-100"));
    expect(getChartPrefs().maLines[1]).toEqual({ period: 100, type: "EMA" });
    expect(within(overlay).getByTestId("chart-overlay-name-ema200").textContent).toBe("EMA 100");
  });
});
