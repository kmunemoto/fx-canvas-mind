import { describe, it, expect, vi } from "vitest";
import { render as rtlRender, screen, fireEvent, waitFor, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";
import { LocaleProvider } from "@/lib/i18n";

vi.mock("@/lib/supabase", () => ({ supabase: {} }));

import PriceChart from "../components/PriceChart";
import LiveChart from "../components/LiveChart";
import { CHART_PREFS_KEY, resetChartPrefsCache } from "../lib/chartPrefs";
import { parseUtcCandleTime } from "../lib/candleTime";
import { normalizeLiveRead, type LiveRead } from "../lib/liveChart";
import { liveRead } from "../../supabase/functions/live-chart/logic";
import type { QuoteCandle } from "../../supabase/functions/track-outcomes/quotes";
import type { NumericCandle } from "../lib/types";
import { QT_DEFAULTS, anchoredStart, barStepMs, qTrend, qTrendTrades } from "../lib/qTrend";
import { ULTRA_PAIRS } from "../lib/ultra";
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

describe("#156 Q-Trend's stop and targets: ULTRA's numbers (the owner's choice, 「B」)", () => {
  // a unit of 0.5 in this series' price (as a pip): stop 5.0, targets 2.5, 5.0, 7.5
  // (at 0.1 every stop fell on the next bar: the bars here swing about 1.0)
  const u = 0.5;
  const r = qTrend(bars);
  // followed on its own here, by the rules written out: the stop first on a
  // bar that reaches both; each target's first bar; the end at the stop or TP3
  const follow = (i: number, side: "BUY" | "SELL", last: number) => {
    const d = side === "BUY" ? 1 : -1;
    const entry = bars[i].close;
    const sl = entry - d * 10 * u;
    const tps = [5, 10, 15].map((k) => entry + d * k * u);
    const tpAt: Array<number | null> = [null, null, null];
    let slAt: number | null = null;
    let end: number | null = null;
    for (let t = i + 1; t <= last && end === null; t++) {
      if (d === 1 ? bars[t].low <= sl : bars[t].high >= sl) {
        slAt = t;
        end = t;
        break;
      }
      tps.forEach((v, k) => {
        if (tpAt[k] === null && (d === 1 ? bars[t].high >= v : bars[t].low <= v)) tpAt[k] = t;
      });
      if (tpAt[2] !== null) end = t;
    }
    const result = tpAt[0] !== null && (slAt === null || tpAt[0] < slAt) ? "TP1" : slAt !== null ? "SL" : null;
    return { entry, sl, tps, tpAt, slAt, end, result };
  };

  it("each signal entered at its close, the stop 10 and the targets 5, 10 and 15 units away", () => {
    const trades = qTrendTrades(bars, r.signals, N - 1, u);
    expect(trades.map((t) => [t.i, t.side])).toEqual(r.signals.map((s) => [s.i, s.side]));
    for (const t of trades) {
      const d = t.side === "BUY" ? 1 : -1;
      expect(t.entry).toBe(bars[t.i].close);
      expect(t.sl).toBeCloseTo(t.entry - d * 5.0, 10);
      expect(t.tps[0]).toBeCloseTo(t.entry + d * 2.5, 10);
      expect(t.tps[1]).toBeCloseTo(t.entry + d * 5.0, 10);
      expect(t.tps[2]).toBeCloseTo(t.entry + d * 7.5, 10);
    }
    // #166: a currency pair's settings, the stop 30 units away; #173: the
    // targets 20, 40 and 60
    for (const t of qTrendTrades(bars, r.signals, N - 1, u, ULTRA_PAIRS)) {
      const d = t.side === "BUY" ? 1 : -1;
      expect(t.sl).toBeCloseTo(t.entry - d * 15.0, 10);
      expect(t.tps.map((v) => (v - t.entry) * d)).toEqual([10.0, 20.0, 30.0].map((x) => expect.closeTo(x, 10)));
    }
  });

  it("followed as ULTRA's are: each target's first bar, the stop (first on a bar reaching both), the end at the stop or TP3", () => {
    const trades = qTrendTrades(bars, r.signals, N - 1, u);
    let ended = 0;
    for (const t of trades) {
      const want = follow(t.i, t.side, N - 1);
      expect([t.tpAt, t.slAt, t.end, t.result]).toEqual([want.tpAt, want.slAt, want.end, want.result]);
      if (t.end !== null) ended++;
    }
    // the series has every kind: stops, TP1s, trades ended and some still open
    expect(ended).toBeGreaterThan(0);
    expect(trades.some((t) => t.end === null)).toBe(true);
    expect(trades.some((t) => t.result === "SL")).toBe(true);
    expect(trades.some((t) => t.result === "TP1")).toBe(true);
  });

  it("closed bars only: a signal after the last closed bar is not followed, and none is followed past it", () => {
    const last = 400;
    const trades = qTrendTrades(bars, r.signals, last, u);
    expect(trades.every((t) => t.i <= last)).toBe(true);
    expect(trades.length).toBe(r.signals.filter((s) => s.i <= last).length);
    for (const t of trades) {
      for (const v of [...t.tpAt, t.slAt, t.end]) if (v !== null) expect(v).toBeLessThanOrEqual(last);
      const want = follow(t.i, t.side, last);
      expect([t.tpAt, t.slAt, t.end]).toEqual([want.tpAt, want.slAt, want.end]);
    }
  });
});

describe("#156 on the chart: the newest Q-Trend signal's stop and targets", () => {
  // a quiet 5-minute EUR/GBP (moves of a pip or so): on it both the newest
  // Q-Trend signal (a sell) and ULTRA's (a sell) are still open
  const T5 = Date.UTC(2026, 8, 28, 0, 0, 0);
  let seed = 3;
  const rnd = () => (seed = (seed * 16807) % 2147483647);
  let c = 85796;
  const quiet = Array.from({ length: 400 }, (_, i) => {
    const o = c;
    c = o + (rnd() % 7) - 3;
    const hi = Math.max(o, c) + (rnd() % 3);
    const lo = Math.min(o, c) - (rnd() % 3);
    return { datetime: new Date(T5 + i * 300_000).toISOString().replace("T", " ").slice(0, 19), open: o / 100000, high: hi / 100000, low: lo / 100000, close: c / 100000 };
  });
  const show = () => render(<PriceChart candles={quiet.slice(280)} pair="EUR/GBP" zoneShiftHistory={{ bars: quiet.slice(0, 280), status: "ready" }} formingLast />);
  // the chart's own reading, done here apart: Q-Trend from its fixed start
  // (#148), closed bars only (the newest is forming), ULTRA's numbers in pips
  // (#166: a currency pair's, the stop 30)
  const want = (() => {
    const times = quiet.map((b) => parseUtcCandleTime(b.datetime));
    const last = quiet.length - 2;
    const from = anchoredStart(times, barStepMs(times.slice(280)), 280, QT_DEFAULTS.period, last);
    const bars = quiet.slice(from);
    const r = qTrend(bars, QT_DEFAULTS, last - from);
    return qTrendTrades(bars, r.signals, last - from, 0.0001, ULTRA_PAIRS).at(-1)!;
  })();
  const rectOf = (el: Element) => {
    const r = el.querySelector("rect")!;
    const y0 = Number(r.getAttribute("y"));
    return { x: Number(r.getAttribute("x")), y0, y1: y0 + Number(r.getAttribute("height")) };
  };

  it("its entry, stop and TP1–TP3 as ULTRA's numbers, dotted to the right edge, the tags \"Q\"-marked", () => {
    show();
    const plan = screen.getByTestId("chart-qtrend-plan");
    expect([plan.getAttribute("data-side"), plan.getAttribute("data-open")]).toEqual([want.side, "true"]);
    expect(want.end).toBeNull();
    const f = (v: number) => v.toFixed(5);
    const text = (k: string) => screen.getByTestId(`chart-qtrend-tag-${k}`).textContent!.replace(/ [↑↓]$/, "");
    expect(text("entry")).toBe(`Q Entry ${f(want.entry)}`);
    expect(text("sl")).toBe(`Q SL ${f(want.sl)}`);
    expect([text("tp1"), text("tp2"), text("tp3")]).toEqual(want.tps.map((v, k) => `Q TP${k + 1} ${f(v)}`));
    // a sell: the stop 30 pips above (#166), the targets 20, 40 and 60 below (#173)
    expect(want.side).toBe("SELL");
    expect(want.sl - want.entry).toBeCloseTo(0.003, 8);
    expect(want.tps.map((v) => want.entry - v)).toEqual([0.002, 0.004, 0.006].map((d) => expect.closeTo(d, 8)));
    expect(plan.querySelector("title")!.textContent).toBe(
      `Q-Trend 売り（損切り・利確は ULTRA と同じ数字）: エントリー ${f(want.entry)}・損切り ${f(want.sl)}・TP1 ${f(want.tps[0])}・TP2 ${f(want.tps[1])}・TP3 ${f(want.tps[2])}`,
    );
    // its lines are dotted (ULTRA's dashed)
    expect(screen.getByTestId("chart-qtrend-plan-sl").getAttribute("stroke-dasharray")).toBe("1 2");
  });

  it("its tags and ULTRA's in one column inside the plot: none over another, in price order", () => {
    show();
    expect(screen.getByTestId("chart-ultra-box").getAttribute("data-open")).toBe("true");
    const clip = document.querySelector("clipPath rect")!;
    const top = Number(clip.getAttribute("y"));
    const bottom = top + Number(clip.getAttribute("height"));
    const tags = [...document.querySelectorAll("[data-testid^='chart-qtrend-tag-'], [data-testid^='chart-ultra-tag-']")];
    expect(tags).toHaveLength(10);
    expect(tags.filter((g) => g.textContent!.startsWith("Q "))).toHaveLength(5);
    const boxes = tags.map((g) => ({ ...rectOf(g), label: g.textContent! })).sort((a, b) => a.y0 - b.y0);
    for (const b of boxes) {
      expect(b.y0).toBeGreaterThanOrEqual(top);
      expect(b.y1).toBeLessThanOrEqual(bottom);
    }
    for (let k = 1; k < boxes.length; k++) expect(boxes[k].y0).toBeGreaterThanOrEqual(boxes[k - 1].y1);
    // top to bottom by price (the higher price higher up)
    const price = (label: string) => Number(label.replace(/ [↑↓]$/, "").split(" ").at(-1));
    for (let k = 1; k < boxes.length; k++) expect(price(boxes[k].label)).toBeLessThanOrEqual(price(boxes[k - 1].label));
  });

  it("with ULTRA off, room is left right of the newest candle for its tags; switched off, nothing is drawn", () => {
    localStorage.setItem(CHART_PREFS_KEY, JSON.stringify({ overlays: { ultra: false } }));
    resetChartPrefsCache();
    const { unmount } = show();
    const bodies = screen.getByTestId("chart-candles").querySelectorAll("rect");
    const lastBody = bodies[bodies.length - 1];
    const newestRight = Number(lastBody.getAttribute("x")) + Number(lastBody.getAttribute("width"));
    for (const k of ["entry", "sl", "tp1", "tp2", "tp3"]) expect(rectOf(screen.getByTestId(`chart-qtrend-tag-${k}`)).x).toBeGreaterThan(newestRight);
    unmount();
    localStorage.setItem(CHART_PREFS_KEY, JSON.stringify({ overlays: { qTrend: false, ultra: false } }));
    resetChartPrefsCache();
    show();
    expect(screen.queryByTestId("chart-qtrend-plan")).toBeNull();
    expect(document.querySelector("[data-testid^='chart-qtrend-tag-']")).toBeNull();
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

describe("#148 where Q-Trend starts", () => {
  const H = 3_600_000;
  // a multiple of 200 hours from 1970-01-01 UTC
  const G = 200 * H * 2475;

  it("at the first bar at or after the earliest multiple of 200 bars' time the bars read reach back to", () => {
    const times = Array.from({ length: 600 }, (_, i) => G - 10 * H + i * H);
    expect(anchoredStart(times, H, 480)).toBe(10);
    // read from five bars later: the same bar
    expect(anchoredStart(times.slice(5), H, 475)).toBe(5);
    // read from past it: the next multiple, 200 hours on
    expect(anchoredStart(times.slice(11), H, 469)).toBe(199);
    // with fewer than 200 bars left before the chart's first there, the first bar read, as before
    expect(anchoredStart(times, H, 205)).toBe(0);
    // no times (or no length): the first bar read
    expect(anchoredStart([Number.NaN, Number.NaN], H, 1)).toBe(0);
    expect(anchoredStart(times, 0, 480)).toBe(0);
    // a weekend's gap: the first bar after the multiple
    const gap = [G - 30 * H, G - 29 * H, G + 20 * H, G + 21 * H, ...Array.from({ length: 400 }, (_, i) => G + (22 + i) * H)];
    expect(anchoredStart(gap, H, 300)).toBe(2);
  });

  it("reads the bars' length as the shortest gap between two", () => {
    expect(barStepMs([0, H, 2 * H, 50 * H, 51 * H])).toBe(H);
    expect(barStepMs([0])).toBe(0);
    expect(barStepMs([Number.NaN, Number.NaN])).toBe(0);
  });

  it("on the chart: the same Q-Trend and 3✓ labels whether the bars read before the chart begin a few bars earlier or later", () => {
    const stamp = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
    const timed = bars.map((b, i) => ({ ...b, datetime: stamp(G - 10 * H + i * H) }));
    const labels = () =>
      [...document.querySelectorAll("[data-testid^='chart-qtrend-signal-'], [data-testid^='chart-qtblsh-signal-']")].map(
        (g) => `${g.getAttribute("data-testid")}@${g.querySelector("rect")!.getAttribute("x")}`,
      );
    const a = render(<PriceChart candles={timed.slice(400)} pair="USD/JPY" zoneShiftHistory={{ bars: timed.slice(0, 400), status: "ready" }} />);
    const first = labels();
    a.unmount();
    render(<PriceChart candles={timed.slice(400)} pair="USD/JPY" zoneShiftHistory={{ bars: timed.slice(4, 400), status: "ready" }} />);
    expect(first.length).toBeGreaterThan(0);
    expect(labels()).toEqual(first);
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

  it("#149: judges nothing on the newest candles it is told to leave out (those the prices made after the last read)", () => {
    // bar 419's STRONG BUY is the second newest candle here
    const candles = bars.slice(400, 421);
    const view = render(<PriceChart candles={candles} pair="USD/JPY" zoneShiftHistory={{ bars: past, status: "ready" }} formingLast />);
    expect(screen.getAllByTestId("chart-qtrend-signal-BUY-strong")).toHaveLength(2);
    expect(screen.getAllByTestId("chart-qtblsh-signal-BUY")).toHaveLength(2);
    view.unmount();
    // the same candles, the second newest made by the prices since the read: not judged until the read brings it
    render(<PriceChart candles={candles} pair="USD/JPY" zoneShiftHistory={{ bars: past, status: "ready" }} formingLast unjudged={2} />);
    expect(screen.getAllByTestId("chart-qtrend-signal-BUY-strong")).toHaveLength(1);
    expect(screen.getAllByTestId("chart-qtblsh-signal-BUY")).toHaveLength(1);
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
