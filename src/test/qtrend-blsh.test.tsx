import { describe, it, expect, vi } from "vitest";
import { render as rtlRender, screen, fireEvent, waitFor, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";
import { LocaleProvider } from "@/lib/i18n";

vi.mock("@/lib/supabase", () => ({ supabase: {} }));

import PriceChart from "../components/PriceChart";
import LiveChart from "../components/LiveChart";
import { CHART_PREFS_KEY } from "../lib/chartPrefs";
import { normalizeLiveRead, type LiveRead } from "../lib/liveChart";
import { liveRead } from "../../supabase/functions/live-chart/logic";
import type { QuoteCandle } from "../../supabase/functions/track-outcomes/quotes";
import type { NumericCandle } from "../lib/types";
import { qTrend } from "../lib/qTrend";
import { blsh, normalize, pineRsi, tripleConfirm, unitMfi } from "../lib/blsh";
import { placeEdgeLabels } from "../lib/edgeLabels";

// the series the reference values were computed on, independently, in
// Python, from the two Pine scripts as published (a slow wave, a trend and
// noise)
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

describe("#145 Q-Trend (tarasenko_), as its Pine code computes it", () => {
  const r = qTrend(bars);

  it("the trend line: the 200-bar middle, then a step of ATR(14) of the bar before each time the close breaks it", () => {
    const want: Record<number, number> = {
      199: 100.41959162820635,
      200: 101.3468484663741,
      201: 100.40961027348676,
      260: 105.97827251531413,
      333: 106.0748127019382,
      400: 101.47838540254843,
      519: 110.76194070277293,
    };
    for (const [i, v] of Object.entries(want)) expect(r.line[Number(i)]).toBeCloseTo(v, 9);
    expect(r.line[197]).toBeNull();
    const ls: Record<number, 1 | -1> = { 199: -1, 200: -1, 201: -1, 260: 1, 333: -1, 400: 1, 519: 1 };
    for (const [i, v] of Object.entries(ls)) expect(r.trend[Number(i)]).toBe(v);
  });

  it("BUY and SELL on the first break each way, STRONG when the bar opened in the range's end eighth in the last five", () => {
    expect(r.signals.map((s) => [s.i, s.side, s.strong])).toEqual([
      [199, "SELL", false], [208, "BUY", false], [280, "SELL", true], [289, "BUY", false], [291, "SELL", true],
      [293, "BUY", false], [295, "SELL", true], [297, "BUY", false], [302, "SELL", true], [308, "BUY", false],
      [313, "SELL", true], [389, "BUY", false], [395, "SELL", false], [400, "BUY", false], [402, "SELL", false],
      [411, "BUY", true], [417, "SELL", false], [419, "BUY", true],
    ]);
  });

  it("judges closed bars only: the forming bar has no line, colour or signal", () => {
    const f = qTrend(bars.slice(0, 209), undefined, 207);
    expect(f.line[208]).toBeNull();
    expect(f.trend[208]).toBeNull();
    expect(f.signals.some((s) => s.i === 208)).toBe(false);
    expect(qTrend(bars.slice(0, 209)).signals.at(-1)).toEqual({ i: 208, side: "BUY", strong: false });
  });
});

describe("#145 BLSH (Buy Low Sell High Composite, zacmcc), as its Pine code computes it", () => {
  const r = blsh(bars);

  it("scales each part to −1…+1 as the original's normalize", () => {
    expect(normalize(75, 25, 75)).toBe(1);
    expect(normalize(25, 25, 75)).toBe(-1);
    expect(normalize(50, 25, 75)).toBe(0);
    // a range of nothing is 0.0001
    expect(normalize(1, 1, 1)).toBe(-1);
    // the composite ÷ 4
    expect(normalize(2, -4, 4)).toBeCloseTo(0.5, 12);
  });

  it("the composite area and the MACD signal line", () => {
    const comp: Record<number, number | null> = { 33: null, 40: 0.22415915753913018, 100: -0.15655383366602227, 260: 0.45334908754368697, 519: 0.20344300210390442 };
    const line: Record<number, number> = { 33: 0.3918096733806873, 40: 0.3755186787730367, 100: -0.14714040375896753, 260: 0.43143304201353194, 519: 0.3046556286909259 };
    const up: Record<number, boolean> = { 33: false, 40: false, 100: false, 260: true, 519: false };
    for (const [i, v] of Object.entries(comp)) {
      if (v === null) expect(r.composite[Number(i)]).toBeNull();
      else expect(r.composite[Number(i)]).toBeCloseTo(v, 9);
    }
    for (const [i, v] of Object.entries(line)) expect(r.line[Number(i)]).toBeCloseTo(v, 9);
    for (const [i, v] of Object.entries(up)) expect(r.lineUp[Number(i)]).toBe(v);
    expect(r.composite.findIndex((v) => v !== null)).toBe(34);
  });

  it("Pine's RSI: 100 when nothing fell, 0 when nothing rose", () => {
    expect(pineRsi([1, 2, 3, 4], 3)[3]).toBe(100);
    expect(pineRsi([4, 3, 2, 1], 3)[3]).toBe(0);
    expect(pineRsi([1, 1, 1, 1], 3)[3]).toBe(100);
  });

  it("MFI with each bar's volume one: 100 when no bar fell, 50 when none moved", () => {
    const flat = Array.from({ length: 20 }, () => ({ high: 1, low: 1, close: 1 }));
    expect(unitMfi(flat, 14)[19]).toBe(50);
    const rising = Array.from({ length: 20 }, (_, i) => ({ high: i + 1, low: i, close: i + 0.5 }));
    expect(unitMfi(rising, 14)[19]).toBe(100);
    expect(unitMfi(rising, 14)[12]).toBeNull();
  });
});

describe("#145 the video's triple confirmation", () => {
  it("marks the first bar in each Q-Trend leg where the BLSH line and area agree with it", () => {
    const q = qTrend(bars);
    const b = blsh(bars);
    expect(tripleConfirm(q.trend, b, N - 1).map((s) => [s.i, s.side])).toEqual([
      [208, "BUY"], [306, "SELL"], [313, "SELL"], [398, "SELL"], [411, "BUY"], [419, "BUY"],
    ]);
  });

  it("waits for the last of the three, and a leg whose area never agrees is the video's fake entry: no mark", () => {
    const trend: Array<1 | -1 | 0 | null> = [0, 1, 1, 1, 1, -1, -1, -1, 1, 1];
    // bar 1: Q-Trend buy, line up, area red → wait; bar 3: area green → BUY.
    // bars 5-7: sell leg, area never red → nothing. bars 8-9: buy leg, line
    // down → nothing
    const composite = [null, -0.2, -0.1, 0.1, 0.2, 0.1, 0.2, 0.3, 0.4, 0.5];
    const lineUp = [null, true, true, true, true, false, false, false, false, false];
    expect(tripleConfirm(trend, { composite, lineUp }, 9)).toEqual([{ i: 3, side: "BUY" }]);
    // only closed bars
    expect(tripleConfirm(trend, { composite, lineUp }, 2)).toEqual([]);
  });
});

const render = (ui: ReactElement): RenderResult => rtlRender(<LocaleProvider initial="ja">{ui}</LocaleProvider>);
// the chart's 120 bars, and the 400 before them as its history
const past = bars.slice(0, 400);
const shown = bars.slice(400);

describe("#145 where the labels by a candle go", () => {
  // a plot from 13 to 274 px; labels 20 wide, 14 high, 6 from the candle
  const at = (key: string, x: number, highY: number, lowY: number, buy: boolean) => ({ key, x, highY, lowY, w: 20, h: 14, off: 6, buy });
  it("under the candle for a buy, over it for a sell, the other side when there is no room", () => {
    const got = placeEdgeLabels([at("b", 100, 100, 120, true), at("s", 200, 100, 120, false), at("top", 300, 15, 40, false), at("foot", 400, 240, 265, true)], 13, 274);
    expect(got.get("b")).toEqual({ top: 126, under: true });
    expect(got.get("s")).toEqual({ top: 80, under: false });
    expect(got.get("top")).toEqual({ top: 46, under: true });
    expect(got.get("foot")).toEqual({ top: 220, under: false });
  });
  it("a row further out when a label is in the way, and the other side of the candle, never onto it, when its own side is full", () => {
    const got = placeEdgeLabels([at("a", 100, 100, 120, true), at("b", 110, 100, 120, true), at("c", 400, 230, 250, true), at("d", 405, 230, 250, true)], 13, 274);
    expect(got.get("b")).toEqual({ top: 142, under: true });
    // c sits at 256–270 against the foot: d has no row under it
    expect(got.get("c")).toEqual({ top: 256, under: true });
    expect(got.get("d")).toEqual({ top: 210, under: false });
  });
});

describe("#145 on the chart", () => {
  it("draws Q-Trend's line, its signals and its colours on the candles, BLSH under the price, and the video's triple confirmation", () => {
    render(<PriceChart candles={shown} pair="USD/JPY" zoneShiftHistory={{ bars: past, status: "ready" }} />);
    // on unless switched off, listed where they belong
    expect(screen.getByTestId("chart-group-trend").contains(screen.getByTestId("chart-overlay-name-qTrend"))).toBe(true);
    expect(screen.getByTestId("chart-group-oscillator").contains(screen.getByTestId("chart-overlay-name-blsh"))).toBe(true);
    expect(screen.getByTestId("chart-group-signals").contains(screen.getByTestId("chart-overlay-name-qtBlsh"))).toBe(true);
    expect(screen.getAllByTestId("chart-qtrend-line").length).toBeGreaterThan(0);
    // bars 400 (BUY), 402 (SELL), 411 (STRONG BUY), 417 (SELL) and 419
    // (STRONG BUY) of the series are on the chart
    expect(screen.getAllByTestId("chart-qtrend-signal-BUY")).toHaveLength(1);
    expect(screen.getAllByTestId("chart-qtrend-signal-BUY-strong")).toHaveLength(2);
    expect(screen.getAllByTestId("chart-qtrend-signal-SELL")).toHaveLength(2);
    expect(screen.getAllByTestId("chart-qtrend-signal-BUY-strong")[0].querySelector("text")!.textContent).toBe("STRONG");
    // the triple confirmation: bars 411 and 419
    expect(screen.getAllByTestId("chart-qtblsh-signal-BUY")).toHaveLength(2);
    expect(screen.getAllByTestId("chart-qtblsh-signal-BUY")[0].querySelector("text")!.textContent).toBe("3✓ BUY");
    // BLSH: the area over and under 0, the line in its two colours
    expect(screen.getByTestId("chart-blsh-area-up").getAttribute("fill")).toBe("#16A34A");
    expect(screen.getByTestId("chart-blsh-area-down").getAttribute("fill")).toBe("#DC2626");
    const line = screen.getByTestId("chart-blsh").querySelector("[data-line='MACD']")!;
    const strokes = new Set([...line.querySelectorAll("path")].map((p) => p.getAttribute("stroke")));
    expect([...strokes].sort()).toEqual(["#2962FF", "#FFD600"]);
    expect(screen.getByTestId("chart-blsh-reading").textContent).toMatch(/^BLSH -?\d\.\d\d MACD -?\d\.\d\d$/);
    // the notes under the chart
    expect(screen.getByTestId("chart-qtblsh-legend").textContent).toContain("フェイク");
    expect(screen.getByTestId("chart-blsh-legend").textContent).toContain("1本=1");
  });

  it("the triple confirmation still works with Q-Trend's own drawing switched off, and each goes off by its eye", () => {
    render(<PriceChart candles={shown} pair="USD/JPY" zoneShiftHistory={{ bars: past, status: "ready" }} />);
    fireEvent.click(screen.getByTestId("chart-toggle-qTrend"));
    expect(screen.queryByTestId("chart-qtrend")).toBeNull();
    expect(screen.getAllByTestId("chart-qtblsh-signal-BUY")).toHaveLength(2);
    fireEvent.click(screen.getByTestId("chart-toggle-qtBlsh"));
    expect(screen.queryByTestId("chart-qtblsh")).toBeNull();
    fireEvent.click(screen.getByTestId("chart-toggle-blsh"));
    expect(screen.queryByTestId("chart-blsh")).toBeNull();
    const saved = JSON.parse(localStorage.getItem(CHART_PREFS_KEY)!);
    expect([saved.overlays.qTrend, saved.overlays.qtBlsh, saved.blsh]).toEqual([false, false, false]);
  });

  it("BLSH's tag and reading take the line's colour at the bar read; its yellow is deeper on the white background", () => {
    render(<PriceChart candles={shown} pair="USD/JPY" zoneShiftHistory={{ bars: past, status: "ready" }} />);
    const tag = screen.getByTestId("chart-blsh-tag-MACD");
    const fill = tag.querySelector("rect")!.getAttribute("fill");
    expect(tag.querySelector("text")!.getAttribute("fill")).toBe(fill === "#2962FF" ? "#fff" : "#131722");
    const macd = [...screen.getByTestId("chart-blsh-reading").querySelectorAll("tspan")].find((s) => s.textContent!.includes("MACD"))!;
    expect(macd.getAttribute("fill")).toBe(fill);
    fireEvent.click(screen.getByTestId("chart-theme-toggle"));
    const line = screen.getByTestId("chart-blsh").querySelector("[data-line='MACD']")!;
    expect(new Set([...line.querySelectorAll("path")].map((p) => p.getAttribute("stroke")))).toEqual(new Set(["#F2A900", "#2962FF"]));
  });

  it("keeps its labels inside the plot: a sell on the top bar goes under the candle", () => {
    // bar 402's SELL made the highest bar on the chart (its close and the
    // bar before, which decide the signal, unchanged)
    const top = Math.max(...shown.map((c) => c.high));
    const spiked = shown.map((c, k) => (k === 2 ? { ...c, high: top + 0.05 } : c));
    render(<PriceChart candles={spiked} pair="USD/JPY" zoneShiftHistory={{ bars: past, status: "ready" }} />);
    const sell = screen.getAllByTestId("chart-qtrend-signal-SELL")[0];
    const [, H] = sell.closest("svg")!.getAttribute("viewBox")!.split(" ").slice(2).map(Number);
    const tipY = Number(sell.querySelector("polygon")!.getAttribute("points")!.split(" ")[0].split(",")[1]);
    expect(Number(sell.querySelector("rect")!.getAttribute("y"))).toBeGreaterThan(tipY);
    const labels = [...document.querySelectorAll("[data-testid^='chart-qtrend-signal-'], [data-testid^='chart-qtblsh-signal-']")];
    expect(labels.length).toBeGreaterThan(3);
    const boxes = labels.map((g) => {
      const r = g.querySelector("rect")!;
      const [left, top, w, h] = ["x", "y", "width", "height"].map((k) => Number(r.getAttribute(k)));
      return { left, top, w, h };
    });
    for (const b of boxes) {
      expect(b.top).toBeGreaterThanOrEqual(13);
      expect(b.top + b.h).toBeLessThanOrEqual(H - 23);
    }
    // and none on another
    boxes.forEach((a, m) => boxes.slice(m + 1).forEach((b) => {
      const overlap = a.left < b.left + b.w && b.left < a.left + a.w && a.top < b.top + b.h && b.top < a.top + a.h;
      expect(overlap).toBe(false);
    }));
    // each Q-Trend label points at its candle from the side it sits on
    for (const g of labels.filter((l) => l.getAttribute("data-testid")!.startsWith("chart-qtrend-"))) {
      const [tip, base] = g.querySelector("polygon")!.getAttribute("points")!.split(" ").slice(0, 2).map((pt) => Number(pt.split(",")[1]));
      const r = g.querySelector("rect")!;
      const top = Number(r.getAttribute("y"));
      const bottom = top + Number(r.getAttribute("height"));
      expect(tip < base ? base === top && tip <= top : base === bottom && tip >= bottom).toBe(true);
    }
  });

  it("waits for the bars before the chart's (the line needs 200 closes), and is locked without a plan", () => {
    const { unmount } = render(<PriceChart candles={shown} pair="USD/JPY" zoneShiftHistory={{ bars: null, status: "loading" }} />);
    expect(screen.queryByTestId("chart-qtrend")).toBeNull();
    expect(screen.queryByTestId("chart-blsh")).toBeNull();
    unmount();
    render(<PriceChart candles={shown} pair="USD/JPY" zoneShiftHistory={{ bars: past, status: "ready" }} indicatorsLocked />);
    for (const k of ["qTrend", "qtBlsh", "blsh"]) expect(screen.getByTestId(`chart-lock-${k}`)).toBeTruthy();
    for (const id of ["chart-qtrend", "chart-qtblsh", "chart-blsh"]) expect(screen.queryByTestId(id)).toBeNull();
  });
});

const M15 = 15 * 60_000;
const T0 = Date.parse("2026-09-01T00:00:00Z");
const quotes = (n: number): QuoteCandle[] =>
  bars.slice(0, n).map((c, i) => {
    const iso = new Date(T0 + i * M15).toISOString();
    const side = (d: number) => ({ datetime: iso, open: c.open + d, high: c.high + d, low: c.low + d, close: c.close + d });
    return { datetime: iso, bid: side(-0.002), ask: side(0.002) };
  });

describe("#145 the live chart reads the bars before its own for them", () => {
  it("with only BLSH on", async () => {
    localStorage.setItem(
      CHART_PREFS_KEY,
      JSON.stringify({ blsh: true, overlays: { zoneShift: false, gainzPro: false, ema50: false, ema200: false, qTrend: false, qtBlsh: false } }),
    );
    const now = T0 + 259 * M15 + 60_000;
    const readFor = (pair: string, interval: string): LiveRead => {
      const r = normalizeLiveRead(liveRead(pair, interval, quotes(260), now))!;
      return { ...r, pair, interval, nextClose: new Date(Date.now() + 600_000).toISOString() };
    };
    const loadHistory = vi.fn(async (): Promise<NumericCandle[]> => []);
    render(<LiveChart defaultInterval="15min" loadBars={async (p, i) => readFor(p, i)} loadTicks={async () => ({})} loadHistory={loadHistory} loadDow={async () => []} />);
    await waitFor(() => expect(loadHistory).toHaveBeenCalledWith("USD/JPY", "15min"));
  });
});
