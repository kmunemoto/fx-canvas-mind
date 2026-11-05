// #395 (docs §8.138): a sharp rise or fall of the 1-hour bar on the chart — on
// unless switched off, the 1-hour chart only, the forming bar too (src/lib/spike.ts,
// the email's code)
import { describe, it, expect, vi, afterEach } from "vitest";
import { render as rtlRender, screen, fireEvent, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";
import { LocaleProvider } from "@/lib/i18n";

vi.mock("@/lib/supabase", () => ({ supabase: {} }));

import PriceChart from "../components/PriceChart";
import { getChartPrefs, resetChartPrefsCache } from "../lib/chartPrefs";
import { spikeChartMarks } from "../lib/spike";

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
    expect(ups[0].querySelector("title")!.textContent).toBe("急騰: 始値 150.000 → 高値 150.500（+0.500）。ふだんの1時間の値幅 0.125（前の確定足120本の高値−安値の平均）の4.0倍");
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
    // the rise's words over the bar's high, the fall's under its low
    const up = screen.getByTestId("chart-spike-up");
    const down = screen.getByTestId("chart-spike-down");
    const yOf = (g: Element) => Number(g.querySelector("text")!.getAttribute("y"));
    expect(yOf(up)).toBeLessThan(yOf(down));
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

  it("is locked on a plan without the indicators", () => {
    render(<PriceChart candles={candlesOf(200)} pair="USD/JPY" indicatorsLocked />);
    expect(screen.queryByTestId("chart-spike")).toBeNull();
  });

  it("speaks English", () => {
    render(<PriceChart candles={candlesOf(200)} pair="USD/JPY" />, "en");
    expect(screen.getByTestId("chart-overlay-name-spike").textContent).toBe("Sharp rise / fall (1 hour)");
    expect(screen.getByTestId("chart-spike-up").querySelector("text")!.textContent).toBe("Rise 4.0×");
  });
});
