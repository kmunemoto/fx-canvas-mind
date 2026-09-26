import { describe, it, expect, afterEach } from "vitest";
import { render as rtlRender, screen, fireEvent, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";
import { LocaleProvider } from "@/lib/i18n";
import PriceChart from "../components/PriceChart";
import { STOCH_DEFAULTS, normalizeStochParams, stochastic } from "../lib/stochastic";
import { CHART_PREFS_KEY, resetChartPrefsCache } from "../lib/chartPrefs";
import { stochSeries } from "../../research/indicator-series";

const render = (ui: ReactElement): RenderResult => rtlRender(<LocaleProvider initial="ja">{ui}</LocaleProvider>);

// A random walk with no two bars alike, so no window is flat
const walk = (n: number, seed = 7) => {
  let s = seed;
  const rnd = () => {
    s = (s + 0x6d2b79f5) | 0;
    let x = Math.imul(s ^ (s >>> 15), 1 | s);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
  let p = 150;
  return Array.from({ length: n }, (_, i) => {
    const o = p;
    p = o + (rnd() - 0.5) * 0.3;
    return {
      datetime: new Date(Date.parse("2026-09-01T00:00:00Z") + i * 3_600_000).toISOString().slice(0, 19).replace("T", " "),
      open: o,
      high: Math.max(o, p) + 0.01 + rnd() * 0.05,
      low: Math.min(o, p) - 0.01 - rnd() * 0.05,
      close: p,
    };
  });
};

describe("#117 the stochastic (TradingView's Stochastic: %K length 14, %K smoothing 1, %D smoothing 3)", () => {
  it("is where the close sits in the window's range, %K smoothed, and %D the average of %K", () => {
    const c = [
      { high: 10, low: 8, close: 9 },
      { high: 11, low: 9, close: 10 },
      { high: 12, low: 10, close: 11 },
      { high: 12, low: 11, close: 11.5 },
      { high: 11, low: 10, close: 10 },
    ];
    const { k, d } = stochastic(c, { kLength: 3, kSmoothing: 1, dSmoothing: 2 });
    expect(k.slice(0, 2)).toEqual([null, null]);
    expect(k[2]).toBeCloseTo(75, 10); // (11 − 8) / (12 − 8)
    expect(k[3]).toBeCloseTo(250 / 3, 10); // (11.5 − 9) / (12 − 9)
    expect(k[4]).toBeCloseTo(0, 10); // the close is the window's low
    expect(d.slice(0, 3)).toEqual([null, null, null]);
    expect(d[3]).toBeCloseTo((75 + 250 / 3) / 2, 10);
    expect(d[4]).toBeCloseTo(250 / 6, 10);
  });

  it("has no value over a flat window, and an average over a missing value is missing (as Pine's na)", () => {
    const flat = Array.from({ length: 6 }, () => ({ high: 1, low: 1, close: 1 }));
    const { k, d } = stochastic([...flat, { high: 2, low: 1, close: 2 }, { high: 2, low: 1.5, close: 1.5 }], { kLength: 3, kSmoothing: 2, dSmoothing: 1 });
    expect(k.slice(0, 7).every((v) => v === null)).toBe(true);
    expect(k[7]).toBeCloseTo((100 + 50) / 2, 10);
    expect(d[7]).toBeCloseTo(k[7] as number, 10);
  });

  it("agrees with the research's own slow stochastic (14, 3, 3) and with its fast one at TradingView's defaults", () => {
    const c = walk(300);
    const mine = stochastic(c, { kLength: 14, kSmoothing: 3, dSmoothing: 3 });
    const theirs = stochSeries(c, 14, 3, 3);
    mine.k.forEach((v, i) => (v === null ? expect(theirs.k[i]).toBeNull() : expect(v).toBeCloseTo(theirs.k[i] as number, 9)));
    mine.d.forEach((v, i) => (v === null ? expect(theirs.d[i]).toBeNull() : expect(v).toBeCloseTo(theirs.d[i] as number, 9)));
    const fast = stochastic(c);
    const ref = stochSeries(c, 14, 1, 3);
    expect(fast.k.filter((v) => v !== null)).toHaveLength(300 - 13);
    fast.k.forEach((v, i) => (v === null ? expect(ref.k[i]).toBeNull() : expect(v).toBeCloseTo(ref.k[i] as number, 9)));
    fast.d.forEach((v, i) => (v === null ? expect(ref.d[i]).toBeNull() : expect(v).toBeCloseTo(ref.d[i] as number, 9)));
  });

  it("takes only whole lengths from 1 to 100", () => {
    expect(normalizeStochParams({ kLength: 0, kSmoothing: "2", dSmoothing: 3.6 })).toEqual({ kLength: 1, kSmoothing: 2, dSmoothing: 4 });
    expect(normalizeStochParams({ kLength: 1e6 })).toEqual({ ...STOCH_DEFAULTS, kLength: 100 });
    expect(normalizeStochParams(null)).toEqual(STOCH_DEFAULTS);
  });
});

describe("#117 the stochastic on the chart", () => {
  afterEach(() => {
    localStorage.clear();
    resetChartPrefsCache();
  });

  const lastOf = (xs: Array<number | null>) => [...xs].reverse().find((v): v is number => v !== null)!;

  it("draws %K and %D under the price with 80/50/20 and the band between 20 and 80, and says the newest reading", () => {
    const c = walk(120);
    render(<PriceChart candles={c} pair="USD/JPY" />);
    const strip = screen.getByTestId("chart-stoch");
    expect(strip.querySelector("[data-line='%K']")?.getAttribute("stroke")).toBe("#2962FF");
    expect(strip.querySelector("[data-line='%D']")?.getAttribute("stroke")).toBe("#FF6D00");
    const levels = [...strip.querySelectorAll("text")].map((t) => t.textContent).filter((x) => /^\d+$/.test(x ?? ""));
    expect(levels).toEqual(["80", "50", "20"]);
    expect(screen.getByTestId("chart-stoch-band")).toBeTruthy();
    const { k, d } = stochastic(c);
    expect(screen.getByTestId("chart-stoch-reading").textContent).toBe(`Stoch 14 1 3 %K ${lastOf(k).toFixed(1)} %D ${lastOf(d).toFixed(1)}`);
    // #119: its switch is the eye beside its name in the chart's list; the
    // settings say it is shown only
    expect(screen.getByTestId("chart-overlay-name-stoch").textContent).toBe("ストキャス 14 1 3");
    fireEvent.click(screen.getByTestId("chart-stoch-settings"));
    expect(screen.getByTestId("chart-stoch-form").textContent).toContain("サインの判定には使っていません");
  });

  it("is switched off and on, and the choice is kept for the next chart", () => {
    const c = walk(120);
    const { unmount } = render(<PriceChart candles={c} pair="USD/JPY" />);
    fireEvent.click(screen.getByTestId("chart-toggle-stoch"));
    expect(screen.queryByTestId("chart-stoch")).toBeNull();
    expect(screen.getByTestId("chart-toggle-stoch").getAttribute("aria-pressed")).toBe("false");
    expect(JSON.parse(localStorage.getItem(CHART_PREFS_KEY)!).stoch).toBe(false);
    unmount();
    resetChartPrefsCache();
    render(<PriceChart candles={c} pair="USD/JPY" />);
    expect(screen.queryByTestId("chart-stoch")).toBeNull();
    fireEvent.click(screen.getByTestId("chart-toggle-stoch"));
    expect(screen.getByTestId("chart-stoch")).toBeTruthy();
  });

  it("takes its three lengths from the settings, and goes back to 14, 1, 3", () => {
    const c = walk(120);
    render(<PriceChart candles={c} pair="USD/JPY" />);
    fireEvent.click(screen.getByTestId("chart-stoch-settings"));
    fireEvent.change(screen.getByTestId("chart-stoch-kLength"), { target: { value: "5" } });
    fireEvent.change(screen.getByTestId("chart-stoch-kSmoothing"), { target: { value: "3" } });
    const { k, d } = stochastic(c, { kLength: 5, kSmoothing: 3, dSmoothing: 3 });
    expect(screen.getByTestId("chart-stoch-reading").textContent).toBe(`Stoch 5 3 3 %K ${lastOf(k).toFixed(1)} %D ${lastOf(d).toFixed(1)}`);
    expect(screen.getByTestId("chart-overlay-name-stoch").textContent).toBe("ストキャス 5 3 3");
    // a length that is not one is not taken
    fireEvent.change(screen.getByTestId("chart-stoch-dSmoothing"), { target: { value: "0" } });
    expect(screen.getByTestId("chart-overlay-name-stoch").textContent).toBe("ストキャス 5 3 3");
    fireEvent.click(screen.getByTestId("chart-stoch-reset"));
    expect(screen.getByTestId("chart-overlay-name-stoch").textContent).toBe("ストキャス 14 1 3");
  });

  it("switches the RSI strip too, where the chart has one", () => {
    const c = walk(60);
    const rsi = c.map((_, i) => (i < 14 ? null : 30 + (i % 40)));
    const { unmount } = render(<PriceChart candles={c} pair="USD/JPY" rsi={rsi} />);
    expect(screen.getByTestId("chart-rsi")).toBeTruthy();
    fireEvent.click(screen.getByTestId("chart-toggle-rsi"));
    expect(screen.queryByTestId("chart-rsi")).toBeNull();
    expect(screen.getByTestId("chart-stoch")).toBeTruthy();
    unmount();
    // no RSI on this chart: no switch for it
    render(<PriceChart candles={c} pair="USD/JPY" />);
    expect(screen.queryByTestId("chart-toggle-rsi")).toBeNull();
  });

  it("follows the zoom: the reading is of the last bar on screen", () => {
    const c = walk(120);
    render(<PriceChart candles={c} pair="USD/JPY" />);
    const svg = screen.getByTestId("chart-price");
    Object.defineProperty(svg, "getBoundingClientRect", {
      value: () => ({ left: 0, top: 0, width: 660, height: 300, right: 660, bottom: 300, x: 0, y: 0, toJSON: () => ({}) }),
    });
    // Ctrl + wheel at the left edge: the first bar stays, 100 of 120 on screen
    fireEvent.wheel(svg, { deltaY: -100, ctrlKey: true, clientX: 0 });
    expect(screen.getByTestId("chart-zoom-count").textContent).toBe("100/120本");
    const { k, d } = stochastic(c);
    expect(screen.getByTestId("chart-stoch-reading").textContent).toBe(`Stoch 14 1 3 %K ${(k[99] as number).toFixed(1)} %D ${(d[99] as number).toFixed(1)}`);
  });
});
