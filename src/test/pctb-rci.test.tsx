import { describe, it, expect, afterEach } from "vitest";
import { render as rtlRender, screen, fireEvent, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";
import { LocaleProvider } from "@/lib/i18n";
import PriceChart from "../components/PriceChart";
import { PCTB_DEFAULTS, PCTB_LEVELS, percentB } from "../lib/percentB";
import { RCI_DEFAULTS, RCI_LEVELS, rci } from "../lib/rci";
import { CHART_PREFS_KEY, getChartPrefs, resetChartPrefsCache } from "../lib/chartPrefs";
import { bollingerSeries, rciSeries } from "../../research/indicator-series";

const render = (ui: ReactElement): RenderResult => rtlRender(<LocaleProvider initial="ja">{ui}</LocaleProvider>);

const M15 = 15 * 60_000;
const T0 = Date.parse("2026-09-01T00:00:00Z");
const stamp = (i: number) => new Date(T0 + i * M15).toISOString().slice(0, 19).replace("T", " ");
// a seeded random walk, closes on a fine grid so none repeat
const walk = (n: number, seed = 5) => {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  let p = 150;
  return Array.from({ length: n }, (_, i) => {
    const open = p;
    p += (rnd() - 0.5) * 0.2 + rnd() * 1e-7;
    const close = p;
    return { datetime: stamp(i), open, close, high: Math.max(open, close) + rnd() * 0.05, low: Math.min(open, close) - rnd() * 0.05 };
  });
};

describe("#135 Bollinger %b, as TradingView's built-in", () => {
  it("is (close − lower band) / (upper − lower) of SMA(20) ± 2 population deviations", () => {
    expect(PCTB_DEFAULTS).toEqual({ length: 20, mult: 2 });
    expect(PCTB_LEVELS).toEqual({ upper: 1, middle: 0.5, lower: 0 });
    const c = walk(200);
    const mine = percentB(c);
    const bb = bollingerSeries(c.map((x) => x.close), 20, 2);
    expect(mine.slice(0, 19).every((v) => v === null)).toBe(true);
    for (let i = 19; i < c.length; i++) {
      const want = (c[i].close - bb.lower[i]!) / (bb.upper[i]! - bb.lower[i]!);
      expect(mine[i]).toBeCloseTo(want, 12);
    }
    // a hand-sized example: closes 1, 2, 3 → mean 2, deviation √(2/3)
    const sd = Math.sqrt(2 / 3);
    expect(percentB([{ close: 1 }, { close: 2 }, { close: 3 }], { length: 3, mult: 2 })[2]).toBeCloseTo((3 - (2 - 2 * sd)) / (4 * sd), 12);
  });

  it("goes past 1 and under 0 outside the bands, and has no value on a flat window", () => {
    const flat = Array.from({ length: 25 }, () => ({ close: 100 }));
    expect(percentB(flat).every((v) => v === null)).toBe(true);
    const jump = [...Array.from({ length: 19 }, (_, i) => ({ close: 100 + (i % 2) * 0.01 })), { close: 101 }];
    expect(percentB(jump)[19]!).toBeGreaterThan(1);
    const drop = [...Array.from({ length: 19 }, (_, i) => ({ close: 100 + (i % 2) * 0.01 })), { close: 99 }];
    expect(percentB(drop)[19]!).toBeLessThan(0);
  });
});

describe("#135 RCI, as TradingView's built-in", () => {
  it("correlates the closes' ranks (ties sharing their mean position) with the bars' order, × 100", () => {
    expect(RCI_DEFAULTS).toEqual({ length: 10, smoothing: 14 });
    expect(RCI_LEVELS).toEqual({ upper: 80, middle: 0, lower: -80 });
    // TradingView's help example: 10, 12, 15, 12 rank 0, 1.5, 3, 1.5
    const r = rci([10, 12, 15, 12].map((close) => ({ close })), { length: 4, smoothing: 1 }).rci;
    expect(r[3]).toBeCloseTo((100 * 3) / Math.sqrt(5 * 4.5), 9);
    const up = rci(Array.from({ length: 10 }, (_, i) => ({ close: 100 + i })), RCI_DEFAULTS).rci;
    expect(up[9]).toBeCloseTo(100, 9);
    const down = rci(Array.from({ length: 10 }, (_, i) => ({ close: 100 - i })), RCI_DEFAULTS).rci;
    expect(down[9]).toBeCloseTo(-100, 9);
    expect(rci(Array.from({ length: 10 }, () => ({ close: 100 })), RCI_DEFAULTS).rci[9]).toBeNull();
  });

  it("is Spearman's RCI where no close repeats, and its line is the 14-bar SMA of it", () => {
    const c = walk(200, 9);
    const { rci: mine, ma } = rci(c);
    const theirs = rciSeries(c.map((x) => x.close), 10);
    expect(mine.slice(0, 9).every((v) => v === null)).toBe(true);
    for (let i = 9; i < c.length; i++) expect(mine[i]).toBeCloseTo(theirs[i] as number, 9);
    expect(ma[21]).toBeNull();
    expect(ma[22]).toBeCloseTo(mine.slice(9, 23).reduce((s, v) => s + (v as number), 0) / 14, 9);
  });
});

describe("#135 %b and RCI on the chart", () => {
  afterEach(() => {
    localStorage.clear();
    resetChartPrefsCache();
  });

  const lastOf = (xs: Array<number | null>) => [...xs].reverse().find((v): v is number => v !== null)!;

  it("are listed off; switched on, each draws its strip with TradingView's lines, its reading and its note", () => {
    const c = walk(160);
    render(<PriceChart candles={c} pair="USD/JPY" />);
    expect(screen.getByTestId("chart-overlay-name-pctB").textContent).toBe("BB %b 20 2");
    expect(screen.getByTestId("chart-overlay-name-rci").textContent).toBe("RCI 10");
    expect(screen.getByTestId("chart-toggle-pctB").getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByTestId("chart-pctb")).toBeNull();
    expect(screen.queryByTestId("chart-rci")).toBeNull();

    fireEvent.click(screen.getByTestId("chart-toggle-pctB"));
    const pb = screen.getByTestId("chart-pctb");
    const pbLevels = [...pb.querySelectorAll("text")].map((t) => t.textContent).filter((x) => /^-?\d+\.\d\d$/.test(x ?? ""));
    expect(pbLevels.slice(0, 3)).toEqual(["1.00", "0.50", "0.00"]);
    expect(screen.getByTestId("chart-pctb-reading").textContent).toBe(`BB %b 20 2 ${lastOf(percentB(c)).toFixed(2)}`);
    expect(screen.getByTestId("chart-pctb-band-in")).toBeTruthy();
    expect(screen.getByTestId("chart-pctb-legend").textContent).toContain("バンドウォーク");
    expect(JSON.parse(localStorage.getItem(CHART_PREFS_KEY)!).pctB).toBe(true);

    fireEvent.click(screen.getByTestId("chart-toggle-rci"));
    const r = rci(c);
    const strip = screen.getByTestId("chart-rci");
    const levels = [...strip.querySelectorAll("text")].map((t) => t.textContent).filter((x) => /^-?\d+$/.test(x ?? ""));
    expect(levels).toEqual(["80", "0", "-80"]);
    expect(strip.querySelector("path[data-line='MA']")?.getAttribute("stroke")).toBe("#FDD835");
    expect(screen.getByTestId("chart-rci-reading").textContent).toBe(`RCI 10 ${lastOf(r.rci).toFixed(1)} MA ${lastOf(r.ma).toFixed(1)}`);
    expect(screen.getByTestId("chart-rci-legend").textContent).toContain("反転の合図ではありません");
    // the stochastic stays where it was
    expect(screen.getByTestId("chart-stoch")).toBeTruthy();
  });

  it("keeps them off for preferences saved before they existed", () => {
    localStorage.setItem(CHART_PREFS_KEY, JSON.stringify({ stoch: true, stochParams: { kLength: 14, kSmoothing: 1, dSmoothing: 3 } }));
    resetChartPrefsCache();
    expect(getChartPrefs().pctB).toBe(false);
    expect(getChartPrefs().rci).toBe(false);
  });
});
