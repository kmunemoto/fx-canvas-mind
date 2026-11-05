// #395 (docs §8.138): a sharp rise or fall of the 1-hour bar on the chart — on
// unless switched off, the 1-hour chart only, the forming bar too (src/lib/spike.ts,
// the email's code)
import { describe, it, expect, vi, afterEach } from "vitest";
import { render as rtlRender, screen, fireEvent, waitFor, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";
import { LocaleProvider } from "@/lib/i18n";

vi.mock("@/lib/supabase", () => ({ supabase: {} }));

import PriceChart from "../components/PriceChart";
import LiveChart from "../components/LiveChart";
import { CHART_PREFS_KEY, getChartPrefs, resetChartPrefsCache } from "../lib/chartPrefs";
import { normalizeHistory, normalizeLiveRead, type LiveRead } from "../lib/liveChart";
import { spikeChartMarks } from "../lib/spike";
import { historyRead, liveRead } from "../../supabase/functions/live-chart/logic";
import type { QuoteCandle } from "../../supabase/functions/track-outcomes/quotes";

const render = (ui: ReactElement, locale: "ja" | "en" = "ja"): RenderResult =>
  rtlRender(<LocaleProvider initial={locale}>{ui}</LocaleProvider>);

afterEach(() => {
  localStorage.clear();
  resetChartPrefsCache();
});

// `n` bars `stepMin` minutes apart, each 0.125 high to low around 150 (R = 0.125);
// bar `at` rises to 150.5 (4 R) and bar `fall` falls to 149.5
const candlesOf = (n: number, stepMin = 60, at = n - 5, fall = -1) => {
  const t0 = Date.UTC(2026, 9, 1);
  return Array.from({ length: n }, (_, i) => ({
    datetime: new Date(t0 + i * stepMin * 60_000).toISOString().slice(0, 19).replace("T", " "),
    open: 150,
    high: i === at ? 150.5 : 150.0625,
    low: i === fall ? 149.5 : 149.9375,
    close: i === at ? 150.4 : i === fall ? 149.6 : 150,
  }));
};

describe("#395 the sharp rise and fall on the chart", () => {
  it("is on until switched off, listed, and marks the rise on the 1-hour chart with its multiple", () => {
    expect(getChartPrefs().overlays.spike).toBe(true);
    render(<PriceChart candles={candlesOf(200)} pair="USD/JPY" />);
    expect(screen.getByTestId("chart-overlay-name-spike").textContent).toBe("急騰・急落（1時間足）");
    const ups = screen.getAllByTestId("chart-spike-up");
    expect(ups).toHaveLength(1);
    expect(ups[0].querySelector("text")!.textContent).toBe("急騰 4.0倍");
    // in pips, as the email says it
    expect(ups[0].querySelector("title")!.textContent).toBe("急騰: 始値 150.000 → 高値 150.500（+50.0pips）。ふだんの1時間の値幅 12.5pips（前の確定足120本の高値−安値の平均）の4.0倍");
    expect(screen.queryByTestId("chart-spike-down")).toBeNull();
    expect(screen.getByTestId("chart-spike-legend").textContent).toContain("測っていません");
    fireEvent.click(screen.getByTestId("chart-toggle-spike"));
    expect(getChartPrefs().overlays.spike).toBe(false);
    expect(screen.queryByTestId("chart-spike")).toBeNull();
  });

  it("marks a fall under the bar, and the forming bar as 「途中」", () => {
    render(<PriceChart candles={candlesOf(200, 60, 199, 190)} pair="USD/JPY" formingLast />);
    expect(screen.getByTestId("chart-spike-down").querySelector("text")!.textContent).toBe("急落 4.0倍");
    // the fall widened the usual range of the bars after it: (119 × 0.125 + 0.5625) / 120, 0.5 of it 3.9 times
    expect(screen.getByTestId("chart-spike-up").querySelector("text")!.textContent).toBe("急騰 3.9倍（途中）");
    // the rise's triangle over the bar's high and its words over the triangle; the fall's
    // triangle under the bar's low and its words under it — clear of each other even on
    // the highest and lowest bars on screen (the room above and below is widened)
    const up = screen.getByTestId("chart-spike-up");
    const down = screen.getByTestId("chart-spike-down");
    const triY = (g: Element) => g.querySelector("polygon")!.getAttribute("points")!.trim().split(/\s+/).map((pt) => Number(pt.split(",")[1]));
    const words = (g: Element) => {
      const t = g.querySelector("text")!;
      const y = Number(t.getAttribute("y"));
      const fs = Number(t.getAttribute("font-size"));
      return { top: y - 0.8 * fs, bottom: y + 0.25 * fs };
    };
    expect(words(up).bottom).toBeLessThanOrEqual(Math.min(...triY(up)));
    expect(words(down).top).toBeGreaterThanOrEqual(Math.max(...triY(down)));
    // the bars' high and low (the candles' wicks) against the triangles
    const wickOf = (i: number) => screen.getByTestId("chart-candles").querySelectorAll("line")[i];
    const upWick = wickOf(199);
    const downWick = wickOf(190);
    const ys = (l: Element) => [Number(l.getAttribute("y1")), Number(l.getAttribute("y2"))];
    expect(Math.max(...triY(up))).toBeLessThanOrEqual(Math.min(...ys(upWick)));
    expect(Math.min(...triY(down))).toBeGreaterThanOrEqual(Math.max(...ys(downWick)));
  });

  it("reads the bars before the chart's (the history handed to it) for the 120 before a bar", () => {
    // the rise at bar 30 of 130 on screen: only 30 bars before it on the chart
    const all = candlesOf(280, 60, 180);
    const past = all.slice(0, 150);
    const shown = all.slice(150);
    render(<PriceChart candles={shown} pair="USD/JPY" />);
    expect(screen.queryByTestId("chart-spike-up")).toBeNull();
  });

  it("with the history handed to it, marks that bar", () => {
    const all = candlesOf(280, 60, 180);
    render(<PriceChart candles={all.slice(150)} pair="USD/JPY" zoneShiftHistory={{ bars: all.slice(0, 150), status: "ready" }} />);
    expect(screen.getAllByTestId("chart-spike-up")).toHaveLength(1);
    expect(screen.getByTestId("chart-spike-label").textContent).toBe("急騰 4.0倍");
  });

  it("draws nothing on another timeframe, and says it is the 1-hour chart's", () => {
    render(<PriceChart candles={candlesOf(200, 5)} pair="USD/JPY" />);
    expect(screen.queryByTestId("chart-spike")).toBeNull();
    expect(screen.getByTestId("chart-spike-legend").textContent).toContain("1時間足のチャートで出します");
  });

  it("needs 120 bars before the bar (the history before the candles counts)", () => {
    // the rise at bar 130: 70 bars into the candles, 130 bars into the history and the candles
    const c = candlesOf(200, 60, 130);
    expect(spikeChartMarks([], c.slice(60))).toHaveLength(0);
    expect(spikeChartMarks(c.slice(0, 60), c.slice(60)).map((m) => m.i)).toEqual([70]);
    // 100 bars before it only: none
    expect(spikeChartMarks([], candlesOf(200, 60, 100))).toHaveLength(0);
  });

  it("is locked on a plan without the indicators: listed with the lock, no marks", () => {
    render(<PriceChart candles={candlesOf(200)} pair="USD/JPY" indicatorsLocked />);
    expect(screen.queryByTestId("chart-spike")).toBeNull();
    expect(screen.getByTestId("chart-lock-spike")).toBeTruthy();
    expect(screen.queryByTestId("chart-toggle-spike")).toBeNull();
  });

  it("speaks English: the list, the words, the title and the note", () => {
    render(<PriceChart candles={candlesOf(200)} pair="USD/JPY" />, "en");
    expect(screen.getByTestId("chart-overlay-name-spike").textContent).toBe("Sharp rise / fall (1 hour)");
    const up = screen.getByTestId("chart-spike-up");
    expect(up.querySelector("text")!.textContent).toBe("Rise 4.0×");
    expect(up.querySelector("title")!.textContent).toBe("Sharp rise: open 150.000 → high 150.500 (+50.0pips), 4.0 times the usual hourly range 12.5pips (the mean high − low of the 120 closed bars before it)");
    expect(screen.getByTestId("chart-spike-legend").textContent).toContain("has not been measured");
  });

  it("on gold, says the move and the range in dollars", () => {
    const gold = candlesOf(200).map((c) => ({ ...c, open: c.open * 27, high: c.high * 27, low: c.low * 27, close: c.close * 27 }));
    render(<PriceChart candles={gold} pair="XAU/USD" />);
    expect(screen.getByTestId("chart-spike-up").querySelector("title")!.textContent).toContain("（+$13.50）。ふだんの1時間の値幅 $3.38");
  });
});

// The live chart on the 1-hour timeframe, with every other indicator off: it reads the
// bars before its own (it holds 120 closed and the one forming), so a closed bar is marked
describe("#395 the live chart reads the history the marks need", () => {
  afterEach(() => {
    localStorage.clear();
    resetChartPrefsCache();
  });
  const H = 3_600_000;
  const T0 = Date.parse("2026-09-21T00:00:00Z");
  const N = 260;
  const SPIKE_AT = 230;
  const quotes = (): QuoteCandle[] =>
    Array.from({ length: N }, (_, i) => {
      const b = i === SPIKE_AT ? { open: 150, high: 150.4, low: 149.95, close: 150.02 } : { open: 150, high: 150.05, low: 149.95, close: 150 };
      const iso = new Date(T0 + i * H).toISOString();
      const side = (d: number) => ({ datetime: iso, open: b.open + d, high: b.high + d, low: b.low + d, close: b.close + d });
      return { datetime: iso, bid: side(-0.002), ask: side(0.002) };
    });
  const NOW = T0 + (N - 1) * H + 60_000;
  const readFor = (pair: string, interval: string): LiveRead => {
    const r = normalizeLiveRead(liveRead(pair, interval, quotes(), NOW))!;
    return { ...r, pair, interval, nextClose: new Date(Date.now() + 600_000).toISOString() };
  };
  const OFF = {
    blsh: false, macd: false, adx: false,
    overlays: { zoneShift: false, gainzPro: false, ema50: false, ema200: false, ma3: false, qTrend: false, qtBlsh: false, autoTrend: false, maCross: false, ichimoku: false, ultra: false, emaReturn: false, zlTema: false, amdPo3: false, analog: false, spike: true },
  };

  it("reads the history while the sharp rise and fall is on, and marks the closed bar", async () => {
    localStorage.setItem(CHART_PREFS_KEY, JSON.stringify(OFF));
    const loadBars = vi.fn(async (pair: string, interval: string) => readFor(pair, interval));
    const loadHistory = vi.fn(async () => normalizeHistory(historyRead("USD/JPY", "1h", quotes(), NOW))!);
    render(<LiveChart defaultInterval="1h" loadBars={loadBars} loadTicks={async () => ({})} loadHistory={loadHistory} loadDeepHistory={async () => ({ bars: [], complete: true })} loadDow={async () => []} />);
    await waitFor(() => expect(loadHistory).toHaveBeenCalled());
    await waitFor(() => expect(screen.getAllByTestId("chart-spike-label").map((e) => e.textContent)).toEqual(["急騰 4.0倍"]));
  });

  it("does not read it for the sharp rise and fall on another timeframe", async () => {
    localStorage.setItem(CHART_PREFS_KEY, JSON.stringify(OFF));
    const loadBars = vi.fn(async (pair: string, interval: string) => readFor(pair, interval));
    const loadHistory = vi.fn(async () => normalizeHistory(historyRead("USD/JPY", "1h", quotes(), NOW))!);
    render(<LiveChart defaultInterval="15min" loadBars={loadBars} loadTicks={async () => ({})} loadHistory={loadHistory} loadDeepHistory={async () => ({ bars: [], complete: true })} loadDow={async () => []} />);
    await waitFor(() => expect(loadBars).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 200));
    expect(loadHistory).not.toHaveBeenCalled();
  });
});
