import { describe, it, expect, vi, afterEach } from "vitest";
import { render as rtlRender, screen, fireEvent, waitFor, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";
import { LocaleProvider } from "@/lib/i18n";

vi.mock("@/lib/supabase", () => ({ supabase: {} }));

import PriceChart from "../components/PriceChart";
import LiveChart from "../components/LiveChart";
import { CHART_PREFS_KEY, resetChartPrefsCache } from "../lib/chartPrefs";
import { normalizeLiveRead, type LiveRead } from "../lib/liveChart";
import { liveRead } from "../../supabase/functions/live-chart/logic";
import type { QuoteCandle } from "../../supabase/functions/track-outcomes/quotes";
import type { NumericCandle } from "../lib/types";
import { emaLine } from "../lib/emaLines";
import { cloudSide, crosses, dmi, histColors, ichimoku, macd, pineEma, pineRma, trendLines } from "../lib/trendTools";

const render = (ui: ReactElement): RenderResult => rtlRender(<LocaleProvider initial="ja">{ui}</LocaleProvider>);

// the series the reference values were computed on, independently, in
// Python, from TradingView's formulas (the same series as #145's)
const N = 520;
const bars = Array.from({ length: N }, (_, i) => {
  const base = 100 + 4 * Math.sin(i / 37) + 0.012 * i + 0.6 * Math.sin(i * 1.7) + 0.25 * Math.cos(i * 0.61);
  const open = base + 0.15 * Math.sin(i * 2.3);
  const close = base;
  return {
    datetime: String(i),
    open,
    high: Math.max(open, close) + 0.2 + 0.1 * Math.abs(Math.sin(i * 0.9)),
    low: Math.min(open, close) - 0.2 - 0.1 * Math.abs(Math.cos(i * 1.1)),
    close,
  };
});
const closes = bars.map((b) => b.close);
const close = (a: number | null, b: number) => {
  expect(a).not.toBeNull();
  expect(a as number).toBeCloseTo(b, 10);
};

describe("#150 the trend tools, as TradingView computes them", () => {
  it("Pine's averages start as the simple average of their first values, and wait for them", () => {
    expect(pineEma([null, null, 1, 2, 3, 4], 3)).toEqual([null, null, null, null, 2, 3]);
    expect(pineRma([1, 2, 3, 6], 3)).toEqual([null, null, 2, (6 + 2 * 2) / 3]);
  });

  it("MACD 12 26 9: EMA 12 − EMA 26, its 9-bar EMA, and the difference", () => {
    const m = macd(closes);
    expect(m.macd.findIndex((v) => v !== null)).toBe(25);
    expect(m.signal.findIndex((v) => v !== null)).toBe(33);
    const ref: Record<number, [number, number, number]> = {
      40: [0.6213077437126628, 0.6729487179131011, -0.05164097420043823],
      100: [-0.38268972626097764, -0.2904765567766341, -0.09221316948434355],
      400: [-0.34058269315234213, -0.4179282534221994, 0.07734556026985728],
      519: [0.5120288172612675, 0.5516956002516629, -0.03966678299039539],
    };
    for (const [i, [a, b, c]] of Object.entries(ref)) {
      close(m.macd[+i], a);
      close(m.signal[+i], b);
      close(m.hist[+i], c);
    }
    // the histogram's four colours: over 0 growing / shrinking, under 0 falling / rising
    expect(histColors([0.1, 0.2, 0.15, -0.1, -0.2, -0.15])).toEqual(["#26A69A", "#26A69A", "#B2DFDB", "#FF5252", "#FF5252", "#FFCDD2"]);
  });

  it("ADX and DMI 14 14: Wilder's averages of the directional moves over the true range", () => {
    const d = dmi(bars);
    expect(d.plus.findIndex((v) => v !== null)).toBe(14);
    expect(d.adx.findIndex((v) => v !== null)).toBe(27);
    const ref: Record<number, [number, number, number]> = {
      40: [33.71391187333962, 28.181853026431618, 16.8399159700517],
      260: [40.46658432075952, 21.572716037953914, 22.384014196706726],
      519: [33.346663370223816, 28.936147117518686, 8.59100157356874],
    };
    for (const [i, [p, m, a]] of Object.entries(ref)) {
      close(d.plus[+i], p);
      close(d.minus[+i], m);
      close(d.adx[+i], a);
    }
  });

  it("Ichimoku 9 26 52: the lines, the cloud drawn 25 bars ahead and the close drawn 25 bars back", () => {
    const k = ichimoku(bars);
    expect(k.spanB.findIndex((v) => v !== null)).toBe(76);
    const ref: Record<number, [number, number, number | null, number | null, number | null]> = {
      40: [103.63315152169771, 102.89521194243093, null, null, 104.30761546483204],
      100: [103.25679868181362, 103.6614747750631, 104.70780780402248, 103.69476297248173, 100.18413342285027],
      400: [100.8752213986794, 101.19476487297848, 102.77862823482832, 104.2682840382081, 101.51549213856772],
      519: [110.1389319054067, 109.60235147265905, 107.8266640955481, 106.00772398230806, null],
    };
    for (const [i, vals] of Object.entries(ref)) {
      const got = [k.conversion[+i], k.base[+i], k.spanA[+i], k.spanB[+i], k.lagging[+i]];
      vals.forEach((v, j) => (v === null ? expect(got[j]).toBeNull() : close(got[j], v)));
    }
    expect(cloudSide(105, 103, 104)).toBe("above");
    expect(cloudSide(103.5, 103, 104)).toBe("inside");
    expect(cloudSide(102, 104, 103)).toBe("below");
    expect(cloudSide(102, null, 103)).toBeNull();
  });

  it("the golden and dead crosses of EMA 50 and EMA 200, on closed bars", () => {
    expect(crosses(emaLine(closes, 50), emaLine(closes, 200), 518)).toEqual([
      { i: 242, side: "GC" },
      { i: 368, side: "DC" },
      { i: 461, side: "GC" },
    ]);
    // none on a bar still forming
    expect(crosses(emaLine(closes, 50), emaLine(closes, 200), 460).map((c) => c.i)).toEqual([242, 368]);
  });

  it("the trend lines through the latest two rising lows and falling highs, to the close that broke them", () => {
    const t = trendLines(bars, 518);
    expect(t.up).toMatchObject({ a: 457, b: 509, brokenAt: null });
    expect(t.up!.pa).toBeCloseTo(103.682485634748, 10);
    expect(t.up!.pb).toBeCloseTo(108.74237440348337, 10);
    expect(t.down).toMatchObject({ a: 389, b: 400, brokenAt: 422 });
    expect(t.down!.pa).toBeCloseTo(102.13821292207462, 10);
    expect(t.down!.pb).toBeCloseTo(101.95258958193965, 10);
  });
});

const past = bars.slice(0, 400);
const shown = bars.slice(400);

describe("#150 on the chart", () => {
  afterEach(() => {
    localStorage.clear();
    resetChartPrefsCache();
  });

  it("draws the trend lines and the golden and dead crosses; Ichimoku, MACD and ADX are listed, off until switched on", () => {
    render(<PriceChart candles={shown} pair="USD/JPY" zoneShiftHistory={{ bars: past, status: "ready" }} formingLast />);
    expect(screen.getByTestId("chart-group-trend").contains(screen.getByTestId("chart-overlay-name-autoTrend"))).toBe(true);
    expect(screen.getByTestId("chart-group-trend").contains(screen.getByTestId("chart-overlay-name-ichimoku"))).toBe(true);
    expect(screen.getByTestId("chart-group-oscillator").contains(screen.getByTestId("chart-overlay-name-macd"))).toBe(true);
    expect(screen.getByTestId("chart-group-oscillator").contains(screen.getByTestId("chart-overlay-name-adx"))).toBe(true);
    // the up line runs on (not broken); the down line broke on bar 422 (the chart's 22nd)
    expect(screen.getByTestId("chart-trendline-up")).toBeTruthy();
    expect(screen.queryByTestId("chart-trendline-up-break")).toBeNull();
    expect(screen.getByTestId("chart-trendline-down-break").textContent).toBe("抜け");
    // the golden cross on bar 461 (the DC on 368 is before the chart)
    expect(screen.getAllByTestId("chart-macross-GC")).toHaveLength(1);
    expect(screen.queryByTestId("chart-macross-DC")).toBeNull();
    for (const id of ["chart-ichimoku", "chart-macd", "chart-adx"]) expect(screen.queryByTestId(id)).toBeNull();
    // the notes under the chart
    expect(screen.getByTestId("chart-autotrend-legend").textContent).toContain("割れ");
    expect(screen.getByTestId("chart-macross-legend").textContent).toContain("ゴールデンクロス");
  });

  it("Ichimoku, switched on: its cloud and lines, and where the close stands against the cloud", () => {
    render(<PriceChart candles={shown} pair="USD/JPY" zoneShiftHistory={{ bars: past, status: "ready" }} formingLast />);
    fireEvent.click(screen.getByTestId("chart-toggle-ichimoku"));
    expect(screen.getByTestId("chart-ichimoku")).toBeTruthy();
    for (const k of ["conversion", "base", "spanA", "spanB", "lagging"]) expect(screen.getByTestId(`chart-ichimoku-${k}`)).toBeTruthy();
    expect(screen.queryByTestId("chart-ichimoku-cloud-up") ?? screen.queryByTestId("chart-ichimoku-cloud-down")).toBeTruthy();
    // the newest bar (519): close against spans 107.83 / 106.01
    const side = cloudSide(bars[519].close, 107.8266640955481, 106.00772398230806)!;
    expect(screen.getByTestId("chart-legend-ichimoku").textContent).toBe(`一目均衡表: ${{ above: "雲の上（上昇優勢）", inside: "雲の中", below: "雲の下（下落優勢）" }[side]}`);
    expect(screen.getByTestId("chart-ichimoku-legend").textContent).toContain("雲");
  });

  it("MACD and ADX, switched on: their strips as TradingView draws them", () => {
    render(<PriceChart candles={shown} pair="USD/JPY" zoneShiftHistory={{ bars: past, status: "ready" }} formingLast />);
    fireEvent.click(screen.getByTestId("chart-toggle-macd"));
    fireEvent.click(screen.getByTestId("chart-toggle-adx"));
    const macdStrip = screen.getByTestId("chart-macd");
    expect(macdStrip.querySelector("[data-line='MACD']")!.getAttribute("stroke")).toBe("#2962FF");
    expect(macdStrip.querySelector("[data-line='Signal']")!.getAttribute("stroke")).toBe("#FF6D00");
    expect(screen.getByTestId("chart-macd-histogram").querySelectorAll("rect").length).toBe(120);
    expect(screen.getByTestId("chart-macd-reading").textContent).toMatch(/^MACD 12 26 9 Hist -?\d/);
    const adxStrip = screen.getByTestId("chart-adx");
    expect(adxStrip.querySelector("[data-line='ADX']")!.getAttribute("stroke")).toBe("#F50057");
    expect(adxStrip.textContent).toContain("25");
    expect(screen.getByTestId("chart-adx-reading").textContent).toMatch(/^ADX 14 14 ADX \d+\.\d \+DI \d+\.\d −DI \d+\.\d$/);
    const saved = JSON.parse(localStorage.getItem(CHART_PREFS_KEY)!);
    expect([saved.macd, saved.adx]).toEqual([true, true]);
  });

  it("is locked without a plan", () => {
    localStorage.setItem(CHART_PREFS_KEY, JSON.stringify({ macd: true, adx: true, overlays: { ichimoku: true } }));
    resetChartPrefsCache();
    render(<PriceChart candles={shown} pair="USD/JPY" zoneShiftHistory={{ bars: past, status: "ready" }} indicatorsLocked />);
    for (const k of ["autoTrend", "maCross", "ichimoku", "macd", "adx"]) expect(screen.getByTestId(`chart-lock-${k}`)).toBeTruthy();
    for (const id of ["chart-trendlines", "chart-macross", "chart-ichimoku", "chart-macd", "chart-adx"]) expect(screen.queryByTestId(id)).toBeNull();
  });
});

describe("#150 the live chart reads the bars before its own for them", () => {
  afterEach(() => {
    localStorage.clear();
    resetChartPrefsCache();
  });
  it("with only the golden and dead crosses on", async () => {
    localStorage.setItem(
      CHART_PREFS_KEY,
      JSON.stringify({ blsh: false, macd: false, adx: false, overlays: { zoneShift: false, gainzPro: false, ema50: false, ema200: false, ma3: false, qTrend: false, qtBlsh: false, autoTrend: false, maCross: true, ichimoku: false } }),
    );
    resetChartPrefsCache();
    const M15 = 15 * 60_000;
    const T0 = Date.parse("2026-09-01T00:00:00Z");
    const quotes: QuoteCandle[] = bars.slice(0, 260).map((c, i) => {
      const iso = new Date(T0 + i * M15).toISOString();
      const side = (d: number) => ({ datetime: iso, open: c.open + d, high: c.high + d, low: c.low + d, close: c.close + d });
      return { datetime: iso, bid: side(-0.002), ask: side(0.002) };
    });
    const readFor = (pair: string, interval: string): LiveRead => {
      const r = normalizeLiveRead(liveRead(pair, interval, quotes, T0 + 259 * M15 + 60_000))!;
      return { ...r, pair, interval, nextClose: new Date(Date.now() + 600_000).toISOString() };
    };
    const loadHistory = vi.fn(async (): Promise<NumericCandle[]> => []);
    render(<LiveChart defaultInterval="15min" loadBars={async (p, i) => readFor(p, i)} loadTicks={async () => ({})} loadHistory={loadHistory} loadDow={async () => []} />);
    await waitFor(() => expect(loadHistory).toHaveBeenCalledWith("USD/JPY", "15min"));
  });
});
