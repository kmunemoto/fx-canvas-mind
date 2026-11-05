// #396: the overbought / oversold gauges the chart did not have — CCI and Williams %R as TradingView's built-ins
// compute them, and the moving-average deviation rate — as strips under the price, off until switched on, locked
// with the other indicators
import { describe, it, expect, vi, afterEach } from "vitest";
import { render as rtlRender, screen, fireEvent, cleanup, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";
import { LocaleProvider } from "@/lib/i18n";

vi.mock("@/lib/supabase", () => ({ supabase: {} }));

import PriceChart from "../components/PriceChart";
import { CCI_DEFAULTS, CCI_LEVELS, cci } from "../lib/cci";
import { WILLR_DEFAULTS, WILLR_LEVELS, williamsR } from "../lib/williamsR";
import { MADEV_DEFAULTS, maDeviation } from "../lib/maDeviation";
import { chartPrefsFrom, getChartPrefs, resetChartPrefsCache, CHART_PREFS_DEFAULTS } from "../lib/chartPrefs";
import { cciSeries } from "../../research/indicator-series";

const render = (ui: ReactElement, locale: "ja" | "en" = "ja"): RenderResult => rtlRender(<LocaleProvider initial={locale}>{ui}</LocaleProvider>);

afterEach(() => {
  localStorage.clear();
  resetChartPrefsCache();
});

const M15 = 15 * 60_000;
const T0 = Date.parse("2026-09-01T00:00:00Z");
const stamp = (i: number) => new Date(T0 + i * M15).toISOString().slice(0, 19).replace("T", " ");
// a seeded random walk
const walk = (n: number, seed = 7) => {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  let p = 150;
  return Array.from({ length: n }, (_, i) => {
    const open = p;
    p += (rnd() - 0.5) * 0.2;
    const close = p;
    return { datetime: stamp(i), open, close, high: Math.max(open, close) + rnd() * 0.05, low: Math.min(open, close) - rnd() * 0.05 };
  });
};

describe("#396 CCI, as TradingView's built-in", () => {
  it("is (tp − SMA(tp, 20)) / (0.015 × the mean absolute deviation) of the typical price", () => {
    expect(CCI_DEFAULTS).toEqual({ length: 20 });
    expect(CCI_LEVELS).toEqual({ upper: 100, middle: 0, lower: -100 });
    // a hand example: typical prices 1, 2, 3 → mean 2, mean absolute deviation 2/3, (3 − 2) / (0.015 × 2/3) = 100
    const hand = [1, 2, 3].map((v) => ({ high: v, low: v, close: v }));
    expect(cci(hand, { length: 3 })[2]).toBeCloseTo(100, 9);
    // the study's own CCI (research/indicator-series.ts, Lambert's on the typical price) on a random walk
    const c = walk(200);
    const mine = cci(c);
    const theirs = cciSeries(c, 20);
    expect(mine.slice(0, 19).every((v) => v === null)).toBe(true);
    for (let i = 19; i < c.length; i++) expect(mine[i]).toBeCloseTo(theirs[i] as number, 9);
    // a flat window has no value
    expect(cci(Array.from({ length: 25 }, () => ({ high: 1, low: 1, close: 1 })))[24]).toBeNull();
  });
});

describe("#396 Williams %R, as TradingView's built-in", () => {
  it("is 100 × (close − the highest high) / (the highest high − the lowest low) of the 14 bars", () => {
    expect(WILLR_DEFAULTS).toEqual({ length: 14 });
    expect(WILLR_LEVELS).toEqual({ upper: -20, middle: -50, lower: -80 });
    const bars = [
      { high: 10, low: 8, close: 9 },
      { high: 12, low: 9, close: 11 },
      { high: 11, low: 7, close: 9 },
    ];
    // highest 12, lowest 7: 100 × (9 − 12) / 5 = −60
    expect(williamsR(bars, { length: 3 })[2]).toBeCloseTo(-60, 12);
    expect(williamsR([...bars.slice(0, 2), { high: 12, low: 7, close: 12 }], { length: 3 })[2]).toBeCloseTo(0, 12);
    expect(williamsR([...bars.slice(0, 2), { high: 11, low: 7, close: 7 }], { length: 3 })[2]).toBeCloseTo(-100, 12);
    expect(williamsR(bars, { length: 3 }).slice(0, 2)).toEqual([null, null]);
    expect(williamsR(Array.from({ length: 14 }, () => ({ high: 5, low: 5, close: 5 })))[13]).toBeNull();
    // always between −100 and 0
    const w = williamsR(walk(300, 3)).filter((v): v is number => v !== null);
    expect(w.length).toBe(287);
    expect(w.every((v) => v <= 0 && v >= -100)).toBe(true);
    // every bar's own 14-bar window (written another way: each window cut out and read whole)
    const c = walk(300, 3);
    const mine = williamsR(c);
    for (let i = 13; i < c.length; i++) {
      const win = c.slice(i - 13, i + 1);
      const hh = Math.max(...win.map((b) => b.high));
      const ll = Math.min(...win.map((b) => b.low));
      expect(mine[i]).toBeCloseTo(((c[i].close - hh) / (hh - ll)) * 100, 9);
    }
    // a window with a price that is not a finite number has no value
    const odd = (k: "high" | "low", v: number) => bars.map((b, i) => (i === 0 ? { ...b, [k]: v } : b));
    expect(williamsR(odd("high", Infinity), { length: 3 })[2]).toBeNull();
    expect(williamsR(odd("low", -Infinity), { length: 3 })[2]).toBeNull();
    expect(williamsR(odd("high", NaN), { length: 3 })[2]).toBeNull();
  });
});

describe("#396 the moving-average deviation rate", () => {
  it("is (close − SMA(close, 25)) ÷ SMA × 100, in percent", () => {
    expect(MADEV_DEFAULTS).toEqual({ length: 25 });
    expect(maDeviation([100, 102, 104].map((close) => ({ close })), { length: 3 })[2]).toBeCloseTo((2 / 102) * 100, 12);
    const d = maDeviation(walk(100, 11));
    expect(d.slice(0, 24).every((v) => v === null)).toBe(true);
    expect(d[24]).not.toBeNull();
    expect(maDeviation([0, 0, 0].map((close) => ({ close })), { length: 3 })[2]).toBeNull();
    // every bar's own 25-bar simple average (written another way: each window cut out and summed)
    const c = walk(200, 11);
    const mine = maDeviation(c);
    for (let i = 24; i < c.length; i++) {
      const mean = c.slice(i - 24, i + 1).reduce((a, b) => a + b.close, 0) / 25;
      expect(mine[i]).toBeCloseTo(((c[i].close - mean) / mean) * 100, 9);
    }
    // a window with a close that is not a finite number has no value
    expect(maDeviation([Infinity, 102, 104].map((close) => ({ close })), { length: 3 })[2]).toBeNull();
    expect(maDeviation([NaN, 102, 104].map((close) => ({ close })), { length: 3 })[2]).toBeNull();
  });
});

describe("#396 on the chart", () => {
  it("is off until switched on, listed among the oscillators, and draws its strip with its note", () => {
    expect([CHART_PREFS_DEFAULTS.cci, CHART_PREFS_DEFAULTS.willR, CHART_PREFS_DEFAULTS.maDev]).toEqual([false, false, false]);
    expect(chartPrefsFrom({ cci: true, willR: "x" }).cci).toBe(true);
    expect(chartPrefsFrom({ cci: true, willR: "x" }).willR).toBe(false);
    render(<PriceChart candles={walk(200)} pair="USD/JPY" />);
    for (const [key, name, strip, legend] of [
      ["cci", "CCI 20", "chart-cci", "chart-cci-legend"],
      ["willR", "Williams %R 14", "chart-willr", "chart-willr-legend"],
      ["maDev", "乖離率 SMA 25", "chart-madev", "chart-madev-legend"],
    ] as const) {
      expect(screen.getByTestId(`chart-overlay-name-${key}`).textContent).toBe(name);
      expect(screen.queryByTestId(strip)).toBeNull();
      fireEvent.click(screen.getByTestId(`chart-toggle-${key}`));
      expect((getChartPrefs() as unknown as Record<string, boolean>)[key]).toBe(true);
      expect(screen.getByTestId(strip)).toBeTruthy();
      expect(screen.getByTestId(legend).textContent).toContain("表示のみで、サインの判定には使っていません");
    }
    expect(screen.getByTestId("chart-cci-legend").textContent).toContain("+100 より上で買われすぎ");
    expect(screen.getByTestId("chart-willr-legend").textContent).toContain("−20 より上で買われすぎ");
    expect(screen.getByTestId("chart-madev-legend").textContent).toContain("決まった線は引かず");
    // each strip reads its own series at the last bar (the deviation in percent, its tag to 3 decimals)
    const c = walk(200);
    const last = (vs: Array<number | null>) => vs[vs.length - 1] as number;
    expect(screen.getByTestId("chart-cci-reading").textContent).toBe(`CCI 20 ${last(cci(c)).toFixed(1)}`);
    expect(screen.getByTestId("chart-willr-reading").textContent).toBe(`Williams %R 14 ${last(williamsR(c)).toFixed(1)}`);
    expect(screen.getByTestId("chart-madev-reading").textContent).toBe(`乖離率 SMA 25 ${last(maDeviation(c)).toFixed(3)}%`);
    expect(screen.getByTestId("chart-cci-tag").textContent).toBe(last(cci(c)).toFixed(2));
    expect(screen.getByTestId("chart-willr-tag").textContent).toBe(last(williamsR(c)).toFixed(2));
    expect(screen.getByTestId("chart-madev-tag").textContent).toBe(last(maDeviation(c)).toFixed(3));
    // each note says it is shown only, and not tested on past data
    for (const id of ["chart-cci-legend", "chart-willr-legend", "chart-madev-legend"]) {
      expect(screen.getByTestId(id).textContent).toContain("表示のみで、サインの判定には使っていません。過去のデータでの検証はしていません。");
    }
    // switched off again
    fireEvent.click(screen.getByTestId("chart-toggle-cci"));
    expect(screen.queryByTestId("chart-cci")).toBeNull();
  });

  it("is locked on a plan without the indicators, and not on the moving averages' chart", () => {
    localStorage.setItem("sextant.chart.prefs.v1", JSON.stringify({ cci: true, willR: true, maDev: true }));
    resetChartPrefsCache();
    const { unmount } = render(<PriceChart candles={walk(200)} pair="USD/JPY" indicatorsLocked />);
    for (const key of ["cci", "willR", "maDev"]) {
      expect(screen.getByTestId(`chart-lock-${key}`)).toBeTruthy();
      expect(screen.queryByTestId(`chart-toggle-${key}`)).toBeNull();
    }
    expect(screen.queryByTestId("chart-cci")).toBeNull();
    expect(screen.queryByTestId("chart-willr")).toBeNull();
    expect(screen.queryByTestId("chart-madev")).toBeNull();
    unmount();
    render(<PriceChart candles={walk(200)} pair="USD/JPY" maOnly />);
    for (const [key, strip] of [["cci", "chart-cci"], ["willR", "chart-willr"], ["maDev", "chart-madev"]]) {
      expect(screen.queryByTestId(strip)).toBeNull();
      expect(screen.queryByTestId(`chart-overlay-name-${key}`)).toBeNull();
    }
  });

  it("speaks English", () => {
    localStorage.setItem("sextant.chart.prefs.v1", JSON.stringify({ cci: true, willR: true, maDev: true }));
    resetChartPrefsCache();
    render(<PriceChart candles={walk(200)} pair="USD/JPY" />, "en");
    expect(screen.getByTestId("chart-overlay-name-maDev").textContent).toBe("MA deviation SMA 25");
    expect(screen.getByTestId("chart-willr-legend").textContent).toContain("Above −20 is commonly read as overbought");
    expect(screen.getByTestId("chart-madev-legend").textContent).toContain("no fixed lines are drawn");
    for (const id of ["chart-cci-legend", "chart-willr-legend", "chart-madev-legend"]) {
      expect(screen.getByTestId(id).textContent).toContain("Shown only: no signal is judged on it. Not tested on past data.");
    }
    expect(screen.getByTestId("chart-madev-reading").textContent).toMatch(/^MA deviation SMA 25 -?\d+\.\d{3}%$/);
  });
});

// the strip's plot runs from y = 8 to its height less 6 (PriceChart's strip())
const plotOf = (strip: HTMLElement) => {
  const h = Number(strip.getAttribute("viewBox")!.split(" ")[3]);
  return { top: 8, bottom: h - 6 };
};
const levelY = (strip: HTMLElement) => [...strip.querySelectorAll(":scope > g > line")].map((l) => Number(l.getAttribute("y1")));
const pathYs = (strip: HTMLElement) =>
  [...strip.querySelectorAll("path")]
    .flatMap((p) => [...(p.getAttribute("d") ?? "").matchAll(/[ML][-\d.]+,([-\d.]+)/g)].map((m) => Number(m[1])));

describe("#396 the strips' scales", () => {
  it("%R from −100 at the foot to 0 at the top; CCI past ±100 with 10 to spare; the deviation even about 0", () => {
    localStorage.setItem("sextant.chart.prefs.v1", JSON.stringify({ cci: true, willR: true, maDev: true }));
    resetChartPrefsCache();
    // a walk that ends in a steady climb, so CCI goes past +100 and the deviation well above 0
    const c = walk(200, 5).map((b, i) => (i < 170 ? b : { ...b, open: b.open + (i - 170) * 0.03, close: b.close + (i - 169) * 0.03, high: b.high + (i - 169) * 0.03, low: b.low + (i - 170) * 0.03 }));
    render(<PriceChart candles={c} pair="USD/JPY" />);

    const wr = screen.getByTestId("chart-willr");
    const p = plotOf(wr);
    const expectY = (v: number) => p.top + ((0 - v) / 100) * (p.bottom - p.top);
    expect(levelY(wr)).toEqual([expectY(-20), expectY(-50), expectY(-80)]);
    expect(Math.min(...pathYs(wr))).toBeGreaterThanOrEqual(p.top - 0.05);
    expect(Math.max(...pathYs(wr))).toBeLessThanOrEqual(p.bottom + 0.05);

    const cc = screen.getByTestId("chart-cci");
    const q = plotOf(cc);
    const [y100, y0, yMinus100] = levelY(cc);
    const perUnit = (yMinus100 - y100) / 200;
    expect(y0).toBeCloseTo((y100 + yMinus100) / 2, 9);
    // the highest CCI on screen is over +100 (the climb), so the top is that value plus 10, not clipped at +100
    expect(cci(c).some((v) => v !== null && v > 110)).toBe(true);
    expect(Math.min(...pathYs(cc))).toBeCloseTo(q.top + 10 * perUnit, 1);
    expect(y100).toBeGreaterThan(q.top + 10 * perUnit + 1);

    const md = screen.getByTestId("chart-madev");
    const r = plotOf(md);
    const mid = (r.top + r.bottom) / 2;
    expect(levelY(md)).toEqual([mid]);
    // the farthest value on screen reaches 1 / 1.1 of the way from the 0 line to the edge
    const far = Math.max(...pathYs(md).map((y) => Math.abs(y - mid)));
    expect(far).toBeCloseTo((r.bottom - r.top) / 2 / 1.1, 1);
  });
});

// full screen: each strip switched on takes its share of the height from the price
let size = { w: 800, h: 600 };
class FakeResizeObserver {
  cb: (e: Array<{ contentRect: { width: number; height: number } }>) => void;
  constructor(cb: FakeResizeObserver["cb"]) {
    this.cb = cb;
  }
  observe() {
    this.cb([{ contentRect: { width: size.w, height: size.h } }]);
  }
  unobserve() {}
  disconnect() {}
}

describe("#396 in full screen", () => {
  it("each of the three takes room from the price, as the other strips do", () => {
    const realRO = globalThis.ResizeObserver;
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver;
    size = { w: 800, h: 600 };
    try {
      const priceH = (prefs: Record<string, boolean>) => {
        localStorage.setItem("sextant.chart.prefs.v1", JSON.stringify(prefs));
        resetChartPrefsCache();
        render(<PriceChart candles={walk(200)} pair="USD/JPY" />);
        fireEvent.click(screen.getByTestId("chart-fullscreen"));
        const h = Number(document.querySelector('svg[data-testid="chart-price"]')!.getAttribute("viewBox")!.split(" ")[3]);
        cleanup();
        return h;
      };
      const none = priceH({});
      const rci = priceH({ rci: true });
      expect(rci).toBeLessThan(none);
      for (const key of ["cci", "willR", "maDev"]) expect(priceH({ [key]: true })).toBe(rci);
      expect(priceH({ cci: true, willR: true, maDev: true })).toBeLessThan(rci);
    } finally {
      (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = realRO;
    }
    // six full-screen charts drawn: more than the default 5 seconds on a busy machine
  }, 30_000);
});
