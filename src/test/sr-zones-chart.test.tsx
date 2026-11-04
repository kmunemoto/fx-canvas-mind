// #393: the owner's ③ on the chart — the bands where the swings stopped again
// and again, on unless switched off, drawn from the first touch to the right
// with the price range and the count (src/lib/srZones.ts)
import { describe, it, expect, vi, afterEach } from "vitest";
import { render as rtlRender, screen, fireEvent, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";
import { LocaleProvider } from "@/lib/i18n";

vi.mock("@/lib/supabase", () => ({ supabase: {} }));

import PriceChart from "../components/PriceChart";
import { CHART_PREFS_KEY, getChartPrefs, resetChartPrefsCache } from "../lib/chartPrefs";

const render = (ui: ReactElement, locale: "ja" | "en" = "ja"): RenderResult =>
  rtlRender(<LocaleProvider initial={locale}>{ui}</LocaleProvider>);

afterEach(() => {
  localStorage.clear();
  resetChartPrefsCache();
});

// 1-hour candles: closes in straight steps between the turning points, each bar
// ±0.0004 around its close, so the four lows are 0.99950, 0.99980, 0.99970, 0.99960
const candlesOf = (points: number[], legBars = 5) => {
  const closes: number[] = [];
  for (let k = 0; k + 1 < points.length; k++) for (let j = 0; j < legBars; j++) closes.push(points[k] + ((points[k + 1] - points[k]) * j) / legBars);
  closes.push(points[points.length - 1]);
  const t0 = Date.UTC(2026, 8, 1);
  return closes.map((c, i) => ({
    datetime: new Date(t0 + i * 3_600_000).toISOString().slice(0, 19).replace("T", " "),
    open: c,
    high: Number((c + 0.0004).toFixed(5)),
    low: Number((c - 0.0004).toFixed(5)),
    close: Number(c.toFixed(5)),
  }));
};
const FOUR_LOWS = [1.005, 0.9999, 1.005, 1.0002, 1.008, 1.0001, 1.0065, 1.0, 1.0095, 1.004];

describe("#393 the horizontal zones on the chart", () => {
  it("is on until switched off, and listed on the chart", () => {
    expect(getChartPrefs().overlays.srZones).toBe(true);
    render(<PriceChart candles={candlesOf(FOUR_LOWS)} pair="EUR/USD" />);
    expect(screen.getByTestId("chart-overlay-name-srZones").textContent).toBe("水平の帯（何度も止まった所）");
    expect(screen.getAllByTestId("chart-srzone")).toHaveLength(1);
    fireEvent.click(screen.getByTestId("chart-toggle-srZones"));
    expect(getChartPrefs().overlays.srZones).toBe(false);
    expect(screen.queryByTestId("chart-srzones")).toBeNull();
  });

  it("draws the band of the four lows with its range and count, from the first touch to the right edge", () => {
    render(<PriceChart candles={candlesOf(FOUR_LOWS)} pair="EUR/USD" />);
    expect(screen.getByTestId("chart-srzone-label").textContent).toBe("0.99950〜0.99980（4回）");
    const title = screen.getByTestId("chart-srzone").querySelector("title")?.textContent ?? "";
    expect(title).toContain("水平の帯 0.99950〜0.99980: 山 0回・谷 4回");
    const rect = screen.getByTestId("chart-srzone").querySelector("rect")!;
    const svg = screen.getByTestId("chart-price");
    const width = Number(svg.getAttribute("viewBox")!.split(" ")[2]);
    // from the first touch, reaching the plot's right edge
    expect(Number(rect.getAttribute("x"))).toBeGreaterThan(0);
    expect(Number(rect.getAttribute("x")) + Number(rect.getAttribute("width"))).toBeLessThanOrEqual(width);
    expect(Number(rect.getAttribute("height"))).toBeGreaterThan(0);
    expect(screen.getByTestId("chart-srzones-legend").textContent).toContain("過去の検証はまだしていません");
  });

  it("does not read a forming candle", () => {
    // the fourth low is known 4 bars after bar 35: with the newest bar forming and
    // only 39 bars, the band has three lows
    const c = candlesOf(FOUR_LOWS).slice(0, 40);
    render(<PriceChart candles={c} pair="EUR/USD" formingLast />);
    expect(screen.getByTestId("chart-srzone-label").textContent).toContain("（3回）");
  });

  it("draws nothing when no three swings meet", () => {
    render(<PriceChart candles={candlesOf([1.005, 1.0, 1.007, 1.003, 1.009, 0.995, 1.004])} pair="EUR/USD" />);
    expect(screen.queryByTestId("chart-srzones")).toBeNull();
  });

  it("speaks English", () => {
    localStorage.setItem(CHART_PREFS_KEY, JSON.stringify({ overlays: { srZones: true } }));
    resetChartPrefsCache();
    render(<PriceChart candles={candlesOf(FOUR_LOWS)} pair="EUR/USD" />, "en");
    expect(screen.getByTestId("chart-overlay-name-srZones").textContent).toBe("Horizontal zones (where price stopped again and again)");
    expect(screen.getByTestId("chart-srzone-label").textContent).toBe("0.99950–0.99980 (4×)");
  });
});
