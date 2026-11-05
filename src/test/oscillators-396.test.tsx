// #396: the overbought / oversold gauges the chart did not have — CCI and Williams %R as TradingView's built-ins
// compute them, and the moving-average deviation rate — as strips under the price, off until switched on, locked
// with the other indicators
import { describe, it, expect, vi, afterEach } from "vitest";
import { render as rtlRender, screen, fireEvent, type RenderResult } from "@testing-library/react";
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
    // the deviation's reading is in percent; the other two have no unit
    expect(screen.getByTestId("chart-madev-reading").textContent).toMatch(/^乖離率 SMA 25 -?\d+\.\d{3}%$/);
    expect(screen.getByTestId("chart-cci-reading").textContent).toMatch(/^CCI 20 -?\d+\.\d$/);
    expect(screen.getByTestId("chart-willr-reading").textContent).toMatch(/^Williams %R 14 -?\d+\.\d$/);
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
    expect(screen.queryByTestId("chart-cci")).toBeNull();
    expect(screen.queryByTestId("chart-overlay-name-cci")).toBeNull();
  });

  it("speaks English", () => {
    localStorage.setItem("sextant.chart.prefs.v1", JSON.stringify({ cci: true, willR: true, maDev: true }));
    resetChartPrefsCache();
    render(<PriceChart candles={walk(200)} pair="USD/JPY" />, "en");
    expect(screen.getByTestId("chart-overlay-name-maDev").textContent).toBe("MA deviation SMA 25");
    expect(screen.getByTestId("chart-willr-legend").textContent).toContain("Above −20 is commonly read as overbought");
    expect(screen.getByTestId("chart-madev-legend").textContent).toContain("no fixed lines are drawn");
  });
});
