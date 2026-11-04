// #394: the owner's ① ② ④ on the chart — on unless switched off, drawn from
// the closed candles on screen (src/lib/trendGuide.ts)
import { describe, it, expect, vi, afterEach } from "vitest";
import { render as rtlRender, screen, fireEvent, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";
import { LocaleProvider } from "@/lib/i18n";

vi.mock("@/lib/supabase", () => ({ supabase: {} }));

import PriceChart from "../components/PriceChart";
import { getChartPrefs, resetChartPrefsCache } from "../lib/chartPrefs";

const render = (ui: ReactElement, locale: "ja" | "en" = "ja"): RenderResult =>
  rtlRender(<LocaleProvider initial={locale}>{ui}</LocaleProvider>);

afterEach(() => {
  localStorage.clear();
  resetChartPrefsCache();
});

// 1-hour candles: closes in straight steps between the turning points (5 bars a
// leg), each bar ±0.0004 around its close
const candlesOf = (points: number[], legBars = 5) => {
  const closes: number[] = [];
  for (let k = 0; k + 1 < points.length; k++) for (let j = 0; j < legBars; j++) closes.push(points[k] + ((points[k + 1] - points[k]) * j) / legBars);
  closes.push(points[points.length - 1]);
  const t0 = Date.UTC(2026, 8, 1);
  return closes.map((c, i) => ({
    datetime: new Date(t0 + i * 3_600_000).toISOString().slice(0, 19).replace("T", " "),
    open: c, high: c + 0.0004, low: c - 0.0004, close: c,
  }));
};
const DOWN = [1.0, 1.02, 1.01, 1.016, 1.006, 1.012, 1.002, 1.009, 0.997, 1.005, 0.994, 1.0005, 0.985, 1.008];

describe("#394 the owner's ① ② ④ on the chart", () => {
  it("is on until switched off, and listed on the chart", () => {
    expect(getChartPrefs().overlays.trendGuide).toBe(true);
    render(<PriceChart candles={candlesOf(DOWN)} pair="EUR/USD" />);
    expect(screen.getByTestId("chart-overlay-name-trendGuide").textContent).toBe("トレンドライン①②と④（自動）");
    expect(screen.getByTestId("chart-trendguide")).toBeTruthy();
    fireEvent.click(screen.getByTestId("chart-toggle-trendGuide"));
    expect(getChartPrefs().overlays.trendGuide).toBe(false);
    expect(screen.queryByTestId("chart-trendguide")).toBeNull();
  });

  it("draws ①, ②, their breaks and ④ waiting for the next higher low", () => {
    render(<PriceChart candles={candlesOf(DOWN)} pair="EUR/USD" />);
    expect(screen.getByTestId("chart-trendguide-main-num").textContent).toBe("①");
    expect(screen.getByTestId("chart-trendguide-steep-num").textContent).toBe("②");
    expect(screen.getByTestId("chart-trendguide-main-break").textContent).toBe("①を上抜け");
    expect(screen.getByTestId("chart-trendguide-steep-break").textContent).toBe("②を上抜け");
    expect(screen.queryByTestId("chart-trendguide-counter")).toBeNull();
    expect(screen.getByTestId("chart-trendguide-extreme").textContent).toBe("④ 安値 0.98460（上昇の線は次の押し安値から）");
    // ① reaches the plot's right edge
    const line = screen.getByTestId("chart-trendguide-main").querySelector("line")!;
    const svg = screen.getByTestId("chart-price");
    const width = Number(svg.getAttribute("viewBox")!.split(" ")[2]);
    expect(Number(line.getAttribute("x2"))).toBeGreaterThan(width * 0.8);
    expect(screen.getByTestId("chart-trendguide-legend").textContent).toContain("過去の検証はまだしていません");
  });

  it("draws ④'s rising line once a higher low is confirmed", () => {
    render(<PriceChart candles={candlesOf([...DOWN, 0.995, 1.004])} pair="EUR/USD" />);
    expect(screen.getByTestId("chart-trendguide-counter-num").textContent).toBe("④");
    expect(screen.getByTestId("chart-trendguide-extreme").textContent).toBe("④ 安値 0.98460");
  });

  it("mirrors an up move", () => {
    render(<PriceChart candles={candlesOf(DOWN.map((v) => 2 - v))} pair="EUR/USD" />);
    expect(screen.getByTestId("chart-trendguide-main-break").textContent).toBe("①を下抜け");
    expect(screen.getByTestId("chart-trendguide-extreme").textContent).toBe("④ 高値 1.01540（下降の線は次の戻り高値から）");
  });

  it("speaks English", () => {
    render(<PriceChart candles={candlesOf(DOWN)} pair="EUR/USD" />, "en");
    expect(screen.getByTestId("chart-overlay-name-trendGuide").textContent).toBe("Trend lines ① ② and ④ (automatic)");
    expect(screen.getByTestId("chart-trendguide-main-break").textContent).toBe("① broken up");
  });
});
