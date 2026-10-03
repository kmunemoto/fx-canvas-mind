import { describe, it, expect, vi, afterEach } from "vitest";
import { render as rtlRender, screen, fireEvent, waitFor, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";
import { LocaleProvider } from "@/lib/i18n";

vi.mock("@/lib/supabase", () => ({ supabase: {} }));

import PriceChart from "../components/PriceChart";
import LiveChart from "../components/LiveChart";
import { CHART_PREFS_KEY, CHART_PREFS_DEFAULTS, resetChartPrefsCache } from "../lib/chartPrefs";
import { normalizeLiveRead, type LiveRead } from "../lib/liveChart";
import { liveRead } from "../../supabase/functions/live-chart/logic";
import type { QuoteCandle } from "../../supabase/functions/track-outcomes/quotes";
import type { NumericCandle } from "../lib/types";
import { ULTRA_DEFAULTS, ULTRA_GOLD, ULTRA_PAIRS, pctOf, pineRsi, ultra, ultraParamsFor, type UltraTrade } from "../lib/ultra";

const render = (ui: ReactElement): RenderResult => rtlRender(<LocaleProvider initial="ja">{ui}</LocaleProvider>);

// the series the reference values were computed on, independently, in
// Python: a Park–Miller walk in whole cents (exact in doubles in both
// languages), rising and falling by turns every 30 bars
const barsOf = (n: number, seed: number, start: number, scale: number, drift: number, amp: number, wick: number) => {
  let s = seed;
  let c = start;
  const rnd = () => (s = (s * 16807) % 2147483647);
  const out: Array<{ open: number; high: number; low: number; close: number }> = [];
  for (let i = 0; i < n; i++) {
    const o = c;
    const step = (rnd() % (2 * amp + 1)) - amp + (Math.floor(i / 30) % 2 === 0 ? drift : -drift);
    c = o + step;
    const hi = Math.max(o, c) + (rnd() % wick);
    const lo = Math.min(o, c) - (rnd() % wick);
    out.push({ open: o / scale, high: hi / scale, low: lo / scale, close: c / scale });
  }
  return out;
};
// gold near $4,300, and USD/JPY near 150
const gold = barsOf(400, 20260928, 430000, 100, 40, 300, 150);
const fx = barsOf(400, 777, 1500000, 10000, 30, 200, 200);

type Row = [number, "BUY" | "SELL", number, number, number[], Array<number | null>, number | null, "TP1" | "SL" | null, number | null];
const rowOf = (tr: UltraTrade): Row => [tr.i, tr.side, tr.entry, tr.sl, tr.tps, tr.tpAt, tr.slAt, tr.result, tr.end];
const same = (got: Row[], want: Row[]) => {
  expect(got.length).toBe(want.length);
  got.forEach((g, k) => {
    const w = want[k];
    expect([g[0], g[1], g[5], g[6], g[7], g[8]]).toEqual([w[0], w[1], w[5], w[6], w[7], w[8]]);
    for (const [a, b] of [[g[2], w[2]], [g[3], w[3]], ...g[4].map((v, j) => [v, w[4][j]])]) expect(a).toBeCloseTo(b, 10);
  });
};

describe("#151 ULTRA: the video's settings", () => {
  it("RSI 14, 70 and 30; a stop of 10 and targets of 5, 10 and 15", () => {
    expect(ULTRA_DEFAULTS).toEqual({ rsiLength: 14, overbought: 70, oversold: 30, sl: 10, tp1: 5, tp2: 10, tp3: 15 });
  });

  it("#166/#168/#173: a currency pair's stop 30 pips and targets 20, 40 and 60; gold's targets $30, $60 and $90 with the video's $10 stop", () => {
    expect(ULTRA_PAIRS).toEqual({ rsiLength: 14, overbought: 70, oversold: 30, sl: 30, tp1: 20, tp2: 40, tp3: 60 });
    expect(ULTRA_GOLD).toEqual({ rsiLength: 14, overbought: 70, oversold: 30, sl: 10, tp1: 30, tp2: 60, tp3: 90 });
    expect(ultraParamsFor(true)).toBe(ULTRA_GOLD);
    expect(ultraParamsFor(false)).toBe(ULTRA_PAIRS);
  });

  it("Pine's ta.rsi: Wilder's averages from the simple average of the first 14 changes; 100 with no fall, 0 with no rise", () => {
    const r = pineRsi(gold.map((b) => b.close), 14);
    expect(r[13]).toBeNull();
    for (const [i, v] of [[14, 53.34133653461402], [15, 50.82265301932622], [60, 38.086796166635644], [200, 55.04948966329585], [398, 59.070259691598345]] as const) {
      expect(r[i]).toBeCloseTo(v, 10);
    }
    const rising = Array.from({ length: 20 }, (_, i) => 100 + i);
    expect(pineRsi(rising, 14)[19]).toBe(100);
    expect(pineRsi([...rising].reverse(), 14)[19]).toBe(0);
  });
});

describe("#151 ULTRA: its signals, targets and tally", () => {
  it("gold: a Sell where RSI crosses back under 70, a Buy where it crosses back over 30, in dollars (as the Python reference)", () => {
    const r = ultra(gold, gold.length - 2, 1);
    same(r.trades.map(rowOf), [
      [111, "BUY", 4294.3, 4284.3, [4299.3, 4304.3, 4309.3], [141, null, null], 169, "TP1", 169],
      [114, "BUY", 4290.23, 4280.23, [4295.23, 4300.23, 4305.23], [129, 141, null], 221, "TP1", 221],
      [170, "BUY", 4284.09, 4274.09, [4289.09, 4294.09, 4299.09], [175, 184, null], 227, "TP1", 227],
      [228, "BUY", 4277.09, 4267.09, [4282.09, 4287.09, 4292.09], [233, null, null], 247, "TP1", 247],
      [230, "BUY", 4277.51, 4267.51, [4282.51, 4287.51, 4292.51], [234, null, null], 247, "TP1", 247],
      [247, "BUY", 4271.65, 4261.65, [4276.65, 4281.65, 4286.65], [253, 259, 260], null, "TP1", 260],
      [263, "SELL", 4287.66, 4297.66, [4282.66, 4277.66, 4272.66], [null, null, null], 270, "SL", 270],
      [271, "SELL", 4294.91, 4304.91, [4289.91, 4284.91, 4279.91], [273, 281, 288], null, "TP1", 288],
      [304, "BUY", 4265.1, 4255.1, [4270.1, 4275.1, 4280.1], [308, 326, null], 357, "TP1", 357],
      [358, "BUY", 4257.39, 4247.39, [4262.39, 4267.39, 4272.39], [363, 367, 370], null, "TP1", 370],
    ]);
    // TOTAL = TP1 + SL, as the video's table (489 + 133 = 622)
    expect(r.stats).toEqual({ tp1: 9, tp2: 6, tp3: 3, sl: 1, total: 10 });
    // each signal's RSI crossed its level
    for (const tr of r.trades) {
      const [p, c] = [r.rsi[tr.i - 1] as number, r.rsi[tr.i] as number];
      if (tr.side === "BUY") expect(p <= 30 && c > 30).toBe(true);
      else expect(p >= 70 && c < 70).toBe(true);
    }
  });

  // #168: the same signals at gold's targets. The expected rows were counted
  // again independently (a Python count from the rules above, which gives the
  // rows of the test before it at 5, 10 and 15 exactly)
  it("gold at $30, $60 and $90: the same signals, most stopped before TP1; one still open, not counted", () => {
    const r = ultra(gold, gold.length - 2, 1, ULTRA_GOLD);
    same(r.trades.map(rowOf), [
      [111, "BUY", 4294.3, 4284.3, [4324.3, 4354.3, 4384.3], [null, null, null], 169, "SL", 169],
      [114, "BUY", 4290.23, 4280.23, [4320.23, 4350.23, 4380.23], [null, null, null], 221, "SL", 221],
      [170, "BUY", 4284.09, 4274.09, [4314.09, 4344.09, 4374.09], [null, null, null], 227, "SL", 227],
      [228, "BUY", 4277.09, 4267.09, [4307.09, 4337.09, 4367.09], [null, null, null], 247, "SL", 247],
      [230, "BUY", 4277.51, 4267.51, [4307.51, 4337.51, 4367.51], [null, null, null], 247, "SL", 247],
      [247, "BUY", 4271.65, 4261.65, [4301.65, 4331.65, 4361.65], [null, null, null], 303, "SL", 303],
      [263, "SELL", 4287.66, 4297.66, [4257.66, 4227.66, 4197.66], [null, null, null], 270, "SL", 270],
      [271, "SELL", 4294.91, 4304.91, [4264.91, 4234.91, 4204.91], [295, null, null], null, "TP1", null],
      [304, "BUY", 4265.1, 4255.1, [4295.1, 4325.1, 4355.1], [null, null, null], 357, "SL", 357],
      [358, "BUY", 4257.39, 4247.39, [4287.39, 4317.39, 4347.39], [null, null, null], null, null, null],
    ]);
    expect(r.stats).toEqual({ tp1: 1, tp2: 0, tp3: 0, sl: 8, total: 9 });
  });

  it("a currency pair: the same numbers in pips (USD/JPY: 0.10 and 0.05, 0.10, 0.15); still open at the end: not counted", () => {
    const r = ultra(fx, fx.length - 1, 0.01);
    expect(r.stats).toEqual({ tp1: 5, tp2: 4, tp3: 4, sl: 16, total: 21 });
    expect(r.trades).toHaveLength(23);
    same(r.trades.slice(0, 2).map(rowOf), [
      [20, "SELL", 150.0705, 150.1705, [150.0205, 149.97050000000002, 149.9205], [null, null, null], 31, "SL", 31],
      [38, "SELL", 150.1543, 150.2543, [150.1043, 150.0543, 150.0043], [45, null, null], 86, "TP1", 86],
    ]);
    same(r.trades.slice(-2).map(rowOf), [
      [386, "SELL", 149.737, 149.837, [149.68699999999998, 149.637, 149.587], [null, null, null], null, null, null],
      [391, "SELL", 149.7491, 149.8491, [149.6991, 149.6491, 149.5991], [null, null, null], null, null, null],
    ]);
  });

  // 16 bars falling by 1 (RSI 0), then a rise of 6: RSI 31.58 — a Buy at 91,
  // its stop at 81 and targets at 96, 101 and 106
  const fall = Array.from({ length: 16 }, (_, k) => 100 - k);
  const barsFrom = (closes: number[], extra: Record<number, Partial<{ high: number; low: number }>> = {}) =>
    closes.map((c, i) => {
      const o = i > 0 ? closes[i - 1] : c;
      return { open: o, high: Math.max(o, c) + 0.2, low: Math.min(o, c) - 0.2, close: c, ...extra[i] };
    });

  it("a bar that reaches both the stop and a target counts the stop", () => {
    const b = barsFrom([...fall, 91, 90], { 17: { high: 97, low: 80 } });
    const r = ultra(b, b.length - 1, 1);
    expect(r.rsi[16]).toBeCloseTo(31.578947368421055, 10);
    same(r.trades.map(rowOf), [[16, "BUY", 91, 81, [96, 101, 106], [null, null, null], 17, "SL", 17]]);
    expect(r.stats).toEqual({ tp1: 0, tp2: 0, tp3: 0, sl: 1, total: 1 });
  });

  it("the stop after TP1 ends the trade and is not counted as a stop", () => {
    const b = barsFrom([...fall, 91, 96, 82], { 18: { low: 80 } });
    const r = ultra(b, b.length - 1, 1);
    same(r.trades.map(rowOf), [[16, "BUY", 91, 81, [96, 101, 106], [17, null, null], 18, "TP1", 18]]);
    expect(r.stats).toEqual({ tp1: 1, tp2: 0, tp3: 0, sl: 0, total: 1 });
    expect(pctOf(r.stats.tp1, r.stats.total)).toBe(100);
  });

  it("TP1 and TP2 on one bar, TP3 on the next, where the trade ends", () => {
    const b = barsFrom([...fall, 91, 101, 106], { 17: { high: 102 }, 18: { high: 107 } });
    const r = ultra(b, b.length - 1, 1);
    same(r.trades.map(rowOf), [[16, "BUY", 91, 81, [96, 101, 106], [17, 17, 18], null, "TP1", 18]]);
    expect(r.stats).toEqual({ tp1: 1, tp2: 1, tp3: 1, sl: 0, total: 1 });
  });

  it("closed bars only: the forming bar neither signals nor reaches a target", () => {
    const b = barsFrom([...fall, 92, 97]);
    const r = ultra(b, b.length - 2, 1);
    same(r.trades.map(rowOf), [[16, "BUY", 92, 82, [97, 102, 107], [null, null, null], null, null, null]]);
    expect(r.stats.total).toBe(0);
    expect(ultra(b, 15, 1).trades).toEqual([]);
  });

  it("the table's shares as the video rounds them (489 of 622: 79%; 133: 21%)", () => {
    expect([pctOf(489, 622), pctOf(313, 622), pctOf(232, 622), pctOf(133, 622)]).toEqual([79, 50, 37, 21]);
    expect(pctOf(0, 0)).toBeNull();
  });
});

// on the chart: gold 1-minute bars from a time the anchored start keeps
// (a multiple of 200 minutes), the last 120 shown, the newest forming
const M1 = 60_000;
const T0 = 200 * M1 * 149213;
const dated = gold.map((b, i) => ({ ...b, datetime: new Date(T0 + i * M1).toISOString().replace("T", " ").slice(0, 19) }));
const past = dated.slice(0, 280);
const shown = dated.slice(280);

describe("#151 ULTRA on the chart", () => {
  afterEach(() => {
    localStorage.clear();
    resetChartPrefsCache();
  });

  it("is on unless switched off, listed with the signals, named with its numbers ($ on gold, pips on a pair)", () => {
    expect(CHART_PREFS_DEFAULTS.overlays.ultra).toBe(true);
    const { unmount } = render(<PriceChart candles={shown} pair="XAU/USD" zoneShiftHistory={{ bars: past, status: "ready" }} formingLast />);
    expect(screen.getByTestId("chart-group-signals").contains(screen.getByTestId("chart-overlay-name-ultra"))).toBe(true);
    // #168: gold's targets $30, $60 and $90
    expect(screen.getByTestId("chart-overlay-name-ultra").textContent).toBe("ULTRA（RSI 14・SL $10・TP $30/60/90）");
    unmount();
    render(<PriceChart candles={shown.map((b) => ({ ...b }))} pair="USD/JPY" zoneShiftHistory={{ bars: past, status: "ready" }} formingLast />);
    expect(screen.getByTestId("chart-overlay-name-ultra").textContent).toBe("ULTRA（RSI 14・SL 30・TP 20/40/60 pips）");
  });

  it("draws the signals on screen, ★TP1–3 where reached, the newest signal's box, and the tally of all the bars read", () => {
    // ULTRA alone (#156: Q-Trend's open trade has tags and room of its own)
    localStorage.setItem(CHART_PREFS_KEY, JSON.stringify({ overlays: { qTrend: false } }));
    resetChartPrefsCache();
    render(<PriceChart candles={shown} pair="XAU/USD" zoneShiftHistory={{ bars: past, status: "ready" }} formingLast />);
    // the Buys on bars 304 and 358 (the chart starts at 280)
    expect(screen.getAllByTestId("chart-ultra-signal-BUY")).toHaveLength(2);
    expect(screen.queryByTestId("chart-ultra-signal-SELL")).toBeNull();
    const first = screen.getAllByTestId("chart-ultra-signal-BUY")[0];
    expect(first.querySelector("text")!.textContent).toBe("Buy ☆");
    // #168: gold's targets $30, $60 and $90 (the trades as counted in "gold at
    // $30, $60 and $90" above)
    expect(first.querySelector("title")!.textContent).toBe("ULTRA 買い: エントリー 4265.10・損切り 4255.10・TP1 4295.10・TP2 4325.10・TP3 4355.10");
    // on screen: TP1 on 295 (the sell of 271); the stops of 247 (on 303) and 304 (on 357)
    expect(screen.getAllByTestId("chart-ultra-hit-TP1")).toHaveLength(1);
    expect(screen.queryByTestId("chart-ultra-hit-TP2")).toBeNull();
    expect(screen.queryByTestId("chart-ultra-hit-TP3")).toBeNull();
    expect(screen.getAllByTestId("chart-ultra-hit-SL")).toHaveLength(2);
    // the newest signal (358): a buy neither stopped nor at TP1 yet — its box open, with its prices
    const box = screen.getByTestId("chart-ultra-box");
    expect([box.getAttribute("data-side"), box.getAttribute("data-open")]).toEqual(["BUY", "true"]);
    expect(box.querySelector("title")!.textContent).toBe("ULTRA 買い: エントリー 4257.39・損切り 4247.39・TP1 4287.39・TP2 4317.39・TP3 4347.39");
    // the entry and TP1 lie among the bars shown (4253.73–4288.25); TP3 lies
    // above every bar read (4311.22), so above the chart whatever it draws
    const tag = (k: string) => screen.getByTestId(`chart-ultra-tag-${k}`).textContent;
    expect(tag("entry")).toBe("Entry 4257.39");
    expect(tag("tp1")).toBe("TP1 4287.39");
    expect(tag("tp3")).toBe("TP3 4347.39 ↑");
    // the stop and TP2 lie past the bars shown and the room the chart leaves
    // around them (4253.73–4288.25, padded 16% of it: 4248.21–4293.77): at
    // the edges, with arrows
    expect(tag("sl")).toBe("SL 4247.39 ↓");
    expect(tag("tp2")).toBe("TP2 4317.39 ↑");
    // the table: every signal from bar 0, the ones before the chart too
    expect(screen.getByTestId("chart-ultra-row-tp1").textContent).toBe("TP1 1 11%");
    expect(screen.getByTestId("chart-ultra-row-tp2").textContent).toBe("TP2 0 0%");
    expect(screen.getByTestId("chart-ultra-row-tp3").textContent).toBe("TP3 0 0%");
    expect(screen.getByTestId("chart-ultra-row-sl").textContent).toBe("損切り 8 89%");
    expect(screen.getByTestId("chart-ultra-total").textContent).toBe("合計 9");
    expect(screen.getByTestId("chart-ultra-winrate").textContent).toBe("勝率 11%");
    // #152: the tally is a row above the chart, not over it
    const table = screen.getByTestId("chart-ultra-table");
    expect(table.closest("svg")).toBeNull();
    expect(table.compareDocumentPosition(screen.getByTestId("chart-candles")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // the newest signal is open: its prices sit in room left right of the newest candle
    const bodies = screen.getByTestId("chart-candles").querySelectorAll("rect");
    const lastBody = bodies[bodies.length - 1];
    const newestRight = Number(lastBody.getAttribute("x")) + Number(lastBody.getAttribute("width"));
    for (const k of ["entry", "sl", "tp1", "tp2", "tp3"]) {
      expect(Number(screen.getByTestId(`chart-ultra-tag-${k}`).querySelector("rect")!.getAttribute("x"))).toBeGreaterThan(newestRight);
    }
    const note = screen.getByTestId("chart-ultra-legend").textContent!;
    for (const part of ["ULTRA EN", "F-INVEST", "コードは読めず", "損切り30 pips・TP1 20 pips で測ると", "約60%", "4時間足 60.8%", "TP1 30・TP2 60・TP3 90 ドル", "金は Dukascopy の値", "4時間足 20.8%", "損益ゼロには25%より上、スプレッドの分さらに上が要ります", "金以外の Twelve Data の銘柄は測っていません"]) {
      expect(note).toContain(part);
    }
    expect(note).not.toContain("このアプリでは測っていません");
    expect(note).not.toContain("金と Twelve Data の銘柄は測っていません");
  });

  it("a pair in pips: the newest signal still open, its box on to the right edge with its prices; × where stops came first", () => {
    const fxDated = fx.map((b, i) => ({ ...b, datetime: dated[i].datetime }));
    render(<PriceChart candles={fxDated.slice(280)} pair="USD/JPY" zoneShiftHistory={{ bars: fxDated.slice(0, 280), status: "ready" }} formingLast />);
    expect(screen.getAllByTestId("chart-ultra-signal-BUY")).toHaveLength(7);
    expect(screen.getAllByTestId("chart-ultra-signal-SELL")).toHaveLength(2);
    expect(screen.getAllByTestId("chart-ultra-signal-SELL")[0].querySelector("text")!.textContent).toBe("Sell ☆");
    // #166: a currency pair's stop is 30 pips (with 10: TP1 2, TP2 2, TP3 2,
    // SL 8); #173: its targets 20, 40 and 60 (with 5, 10 and 15: TP1 4, TP2 2,
    // TP3 2, SL 8). Counted again apart from this code, in Python, from the
    // rules ultra.ts states: the TP1s of the trades that went on to TP2 and
    // TP3 on screen were reached before bar 280, off it
    for (const [what, n] of [["TP1", 0], ["TP2", 2], ["TP3", 3], ["SL", 8]] as const) expect(screen.queryAllByTestId(`chart-ultra-hit-${what}`)).toHaveLength(n);
    // the sell on 391 at 149.7491: its stop 30 pips above, its targets 20, 40 and 60 below
    const box = screen.getByTestId("chart-ultra-box");
    expect([box.getAttribute("data-side"), box.getAttribute("data-open")]).toEqual(["SELL", "true"]);
    expect(screen.getByTestId("chart-ultra-tag-entry").textContent).toBe("Entry 149.749");
    // #166: 30 pips up, above the chart: tagged at its top edge; #173: TP1
    // inside the chart (its lowest low 149.5533, less the scale's margin),
    // TP2 and TP3 below it
    expect(screen.getByTestId("chart-ultra-tag-sl").textContent).toBe("SL 150.049 ↑");
    expect(screen.getByTestId("chart-ultra-tag-tp1").textContent).toBe("TP1 149.549");
    expect(screen.getByTestId("chart-ultra-tag-tp2").textContent).toBe("TP2 149.349 ↓");
    expect(screen.getByTestId("chart-ultra-tag-tp3").textContent).toBe("TP3 149.149 ↓");
    // #152: the prices sit in room left right of the newest candle, not over it
    const bodies = screen.getByTestId("chart-candles").querySelectorAll("rect");
    const lastBody = bodies[bodies.length - 1];
    const newestRight = Number(lastBody.getAttribute("x")) + Number(lastBody.getAttribute("width"));
    for (const k of ["entry", "sl", "tp1", "tp2", "tp3"]) {
      expect(Number(screen.getByTestId(`chart-ultra-tag-${k}`).querySelector("rect")!.getAttribute("x"))).toBeGreaterThan(newestRight);
    }
    // #173: 4, 4, 3 and 8 of 12 (the rest still open not counted; with the
    // targets 5, 10 and 15: 8, 6, 6 and 8 of 16; with a stop of 10 too: 5, 4,
    // 4 and 16 of 21)
    expect(screen.getByTestId("chart-ultra-row-tp1").textContent).toBe("TP1 4 33%");
    expect(screen.getByTestId("chart-ultra-row-tp2").textContent).toBe("TP2 4 33%");
    expect(screen.getByTestId("chart-ultra-row-sl").textContent).toBe("損切り 8 67%");
    expect(screen.getByTestId("chart-ultra-total").textContent).toBe("合計 12");
    expect(screen.getByTestId("chart-ultra-winrate").textContent).toBe("勝率 33%");
  });

  it("prices off the chart are tagged at its edge with an arrow, every tag inside the plot (a quiet 5-minute EUR/GBP)", () => {
    // 2026-09-29, on the owner's EUR/GBP 5-minute chart: a sell's stop 10
    // pips above the chart and its targets 5–15 below, and only "SL" showed
    // (the tags moved as one block, the Entry and TPs off the bottom). #166:
    // the stop 30 pips above; #173: the targets 20, 40 and 60 below
    let s = 3;
    const rnd = () => (s = (s * 16807) % 2147483647);
    let c = 85796;
    const quiet = Array.from({ length: 400 }, (_, i) => {
      const o = c;
      c = o + (rnd() % 7) - 3;
      const hi = Math.max(o, c) + (rnd() % 3);
      const lo = Math.min(o, c) - (rnd() % 3);
      return { datetime: dated[i].datetime, open: o / 100000, high: hi / 100000, low: lo / 100000, close: c / 100000 };
    });
    // ULTRA alone (#156: Q-Trend's open trade shares the column; tested with it)
    localStorage.setItem(CHART_PREFS_KEY, JSON.stringify({ overlays: { qTrend: false } }));
    resetChartPrefsCache();
    render(<PriceChart candles={quiet.slice(280)} pair="EUR/GBP" zoneShiftHistory={{ bars: quiet.slice(0, 280), status: "ready" }} formingLast />);
    const box = screen.getByTestId("chart-ultra-box");
    expect([box.getAttribute("data-side"), box.getAttribute("data-open")]).toEqual(["SELL", "true"]);
    const text = (k: string) => screen.getByTestId(`chart-ultra-tag-${k}`).textContent;
    // the chart shows 0.85762–0.85789; the entry on it, the stop above, the targets below
    expect(text("entry")).toBe("Entry 0.85784");
    expect(text("sl")).toBe("SL 0.86084 ↑");
    expect([text("tp1"), text("tp2"), text("tp3")]).toEqual(["TP1 0.85584 ↓", "TP2 0.85384 ↓", "TP3 0.85184 ↓"]);
    const clip = document.querySelector("clipPath rect")!;
    const top = Number(clip.getAttribute("y"));
    const bottom = top + Number(clip.getAttribute("height"));
    const rectOf = (k: string) => {
      const r = screen.getByTestId(`chart-ultra-tag-${k}`).querySelector("rect")!;
      const y0 = Number(r.getAttribute("y"));
      return { y0, y1: y0 + Number(r.getAttribute("height")) };
    };
    for (const k of ["sl", "entry", "tp1", "tp2", "tp3"]) {
      const { y0, y1 } = rectOf(k);
      expect(y0).toBeGreaterThanOrEqual(top);
      expect(y1).toBeLessThanOrEqual(bottom);
    }
    // in price order, top to bottom, none over another
    const order = ["sl", "entry", "tp1", "tp2", "tp3"].map(rectOf);
    for (let k = 1; k < order.length; k++) expect(order[k].y0).toBeGreaterThanOrEqual(order[k - 1].y1);
    // the stop at the top edge, the targets at the bottom
    expect(order[0].y0 - top).toBeLessThan(3);
    expect(bottom - order[4].y1).toBeLessThan(3);
  });

  it("#173: a level at or below zero is no price — HUF/JPY (about 0.49 yen), a sell's TP3 60 pips (0.60) below", () => {
    // the newest signal a sell on 320 at 0.49075, still open (counted apart
    // in Python): its stop 0.79075, its targets 0.29075, 0.09075 and −0.10925
    const huf = barsOf(400, 4, 48800, 100000, 3, 20, 20).map((b, i) => ({ ...b, datetime: dated[i].datetime }));
    render(<PriceChart candles={huf.slice(280)} pair="HUF/JPY" zoneShiftHistory={{ bars: huf.slice(0, 280), status: "ready" }} formingLast />);
    const box = screen.getByTestId("chart-ultra-box");
    expect([box.getAttribute("data-side"), box.getAttribute("data-open")]).toEqual(["SELL", "true"]);
    expect(screen.getByTestId("chart-ultra-tag-entry").textContent).toBe("Entry 0.491");
    expect(screen.getByTestId("chart-ultra-tag-sl").textContent).toBe("SL 0.791 ↑");
    expect(screen.getByTestId("chart-ultra-tag-tp1").textContent).toBe("TP1 0.291 ↓");
    expect(screen.getByTestId("chart-ultra-tag-tp2").textContent).toBe("TP2 0.091 ↓");
    expect(screen.queryByTestId("chart-ultra-tag-tp3")).toBeNull();
    expect(box.querySelector("title")!.textContent).toBe("ULTRA 売り: エントリー 0.491・損切り 0.791・TP1 0.291・TP2 0.091・TP3 —");
    // no price below zero anywhere on the chart's tags (Q-Trend's too)
    for (const g of document.querySelectorAll("[data-testid^='chart-ultra-tag-'], [data-testid^='chart-qtrend-tag-']")) expect(g.textContent).not.toMatch(/-\d/);
  });

  it("the forming bar is not judged: its reach of TP1 is neither marked nor counted", () => {
    // #168: gold's TP1 is $30 above the Buy's close of 92
    const closes = [...Array.from({ length: 16 }, (_, k) => 100 - k), 92, 122];
    const b = closes.map((c, i) => {
      const o = i > 0 ? closes[i - 1] : c;
      return { datetime: new Date(T0 + i * M1).toISOString().replace("T", " ").slice(0, 19), open: o, high: Math.max(o, c) + 0.2, low: Math.min(o, c) - 0.2, close: c };
    });
    render(<PriceChart candles={b} pair="XAU/USD" formingLast />);
    expect(screen.getAllByTestId("chart-ultra-signal-BUY")).toHaveLength(1);
    expect(screen.queryByTestId("chart-ultra-hit-TP1")).toBeNull();
    expect(screen.getByTestId("chart-ultra-total").textContent).toBe("合計 0");
    expect(screen.getByTestId("chart-ultra-winrate").textContent).toBe("勝率 —");
  });

  it("switched off: nothing drawn, and remembered", () => {
    render(<PriceChart candles={shown} pair="XAU/USD" zoneShiftHistory={{ bars: past, status: "ready" }} formingLast />);
    fireEvent.click(screen.getByTestId("chart-toggle-ultra"));
    for (const id of ["chart-ultra", "chart-ultra-table", "chart-ultra-legend"]) expect(screen.queryByTestId(id)).toBeNull();
    expect(JSON.parse(localStorage.getItem(CHART_PREFS_KEY)!).overlays.ultra).toBe(false);
  });

  it("is locked without a plan", () => {
    render(<PriceChart candles={shown} pair="XAU/USD" zoneShiftHistory={{ bars: past, status: "ready" }} indicatorsLocked />);
    expect(screen.getByTestId("chart-lock-ultra")).toBeTruthy();
    for (const id of ["chart-ultra", "chart-ultra-table"]) expect(screen.queryByTestId(id)).toBeNull();
  });
});

describe("#151 the live chart reads the bars before its own for ULTRA", () => {
  afterEach(() => {
    localStorage.clear();
    resetChartPrefsCache();
  });
  it("with only ULTRA on", async () => {
    localStorage.setItem(
      CHART_PREFS_KEY,
      JSON.stringify({ blsh: false, macd: false, adx: false, overlays: { zoneShift: false, gainzPro: false, ema50: false, ema200: false, qTrend: false, qtBlsh: false, autoTrend: false, maCross: false, ichimoku: false, ultra: true } }),
    );
    resetChartPrefsCache();
    const M15 = 15 * 60_000;
    const S0 = Date.parse("2026-09-01T00:00:00Z");
    const quotes: QuoteCandle[] = fx.slice(0, 260).map((c, i) => {
      const iso = new Date(S0 + i * M15).toISOString();
      const side = (d: number) => ({ datetime: iso, open: c.open + d, high: c.high + d, low: c.low + d, close: c.close + d });
      return { datetime: iso, bid: side(-0.002), ask: side(0.002) };
    });
    const readFor = (pair: string, interval: string): LiveRead => {
      const r = normalizeLiveRead(liveRead(pair, interval, quotes, S0 + 259 * M15 + 60_000))!;
      return { ...r, pair, interval, nextClose: new Date(Date.now() + 600_000).toISOString() };
    };
    const loadHistory = vi.fn(async (): Promise<NumericCandle[]> => []);
    render(<LiveChart defaultInterval="15min" loadBars={async (p, i) => readFor(p, i)} loadTicks={async () => ({})} loadHistory={loadHistory} loadDow={async () => []} />);
    await waitFor(() => expect(loadHistory).toHaveBeenCalledWith("USD/JPY", "15min"));
  });
});
