// #392 (docs §8.135): the owner's video's similar-past forecast on the chart
// — the grey dotted centre, the green top and the red bottom, filled between,
// from the newest closed candle's close to H bars past it, kept on screen to
// the right of the newest bar — drawn from the same code the measurement
// computes with (supabase/functions/_shared/analog-forecast.ts); off until
// switched on.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render as rtlRender, screen, fireEvent, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";
import { LocaleProvider } from "@/lib/i18n";

vi.mock("@/lib/supabase", () => ({ supabase: {} }));

import PriceChart from "../components/PriceChart";
import { CHART_PREFS_KEY, getChartPrefs, resetChartPrefsCache } from "../lib/chartPrefs";
import { ANALOG, analogForecast } from "../lib/analogForecast";

const render = (ui: ReactElement, locale: "ja" | "en" = "ja"): RenderResult =>
  rtlRender(<LocaleProvider initial={locale}>{ui}</LocaleProvider>);

afterEach(() => {
  localStorage.clear();
  resetChartPrefsCache();
});

const switchOn = () => {
  localStorage.setItem(CHART_PREFS_KEY, JSON.stringify({ overlays: { analog: true } }));
  resetChartPrefsCache();
};

// a seeded walk of 15-minute candles (the chart's own shape)
const candlesOf = (n: number, seed = 5) => {
  let s = seed >>> 0;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const t0 = Date.UTC(2026, 8, 1);
  let v = 150;
  return Array.from({ length: n }, (_, i) => {
    const o = v;
    v = Number((v * (1 + (rnd() - 0.5) * 0.003)).toFixed(3));
    const hi = Number((Math.max(o, v) + rnd() * 0.05).toFixed(3));
    const lo = Number((Math.min(o, v) - rnd() * 0.05).toFixed(3));
    return { datetime: new Date(t0 + i * 15 * 60_000).toISOString().slice(0, 19).replace("T", " "), open: o, high: hi, low: lo, close: v };
  });
};
// the path's points ("M x,y L x,y …")
const pointsOf = (d: string) => d.replace(/^M/, "").split(" L").map((p) => p.split(",").map(Number));

describe("#392 the similar-past forecast on the chart", () => {
  it("is off until switched on, and listed on the chart", () => {
    const candles = candlesOf(400);
    expect(getChartPrefs().overlays.analog).toBe(false);
    render(<PriceChart candles={candles} pair="USD/JPY" />);
    expect(screen.queryByTestId("chart-analog")).toBeNull();
    expect(screen.getByTestId("chart-overlay-name-analog").textContent).toBe("似た相場の予測（20本先）");
    fireEvent.click(screen.getByTestId("chart-toggle-analog"));
    expect(getChartPrefs().overlays.analog).toBe(true);
    expect(screen.getByTestId("chart-analog")).toBeTruthy();
  });

  it("draws the forecast of the newest closed candle, H bars to its right, its numbers as the code's", () => {
    switchOn();
    const candles = candlesOf(400);
    const f = analogForecast(candles.map((c) => c.close))!;
    expect(f).not.toBeNull();
    render(<PriceChart candles={candles} pair="USD/JPY" />);
    const g = screen.getByTestId("chart-analog");
    const mid = pointsOf(screen.getByTestId("chart-analog-mid").getAttribute("d")!);
    const up = pointsOf(screen.getByTestId("chart-analog-up").getAttribute("d")!);
    const lo = pointsOf(screen.getByTestId("chart-analog-down").getAttribute("d")!);
    expect(mid).toHaveLength(ANALOG.horizon + 1);
    expect(up).toHaveLength(ANALOG.horizon + 1);
    expect(lo).toHaveLength(ANALOG.horizon + 1);
    // all three start at the newest close; the slots step evenly to the right
    expect(mid[0]).toEqual(up[0]);
    expect(mid[0]).toEqual(lo[0]);
    const step = mid[1][0] - mid[0][0];
    expect(step).toBeGreaterThan(0);
    for (let h = 1; h <= ANALOG.horizon; h++) {
      expect(mid[h][0] - mid[h - 1][0]).toBeCloseTo(step, 0);
      // higher prices are higher up (smaller y): top ≤ centre ≤ bottom on screen
      expect(up[h][1]).toBeLessThanOrEqual(mid[h][1] + 1e-9);
      expect(mid[h][1]).toBeLessThanOrEqual(lo[h][1] + 1e-9);
    }
    // the newest candle's slot is the anchor's: the forecast reaches past it, inside the plot
    const svg = screen.getByTestId("chart-price");
    const width = Number(svg.getAttribute("viewBox")!.split(" ")[2]);
    expect(mid[ANALOG.horizon][0]).toBeLessThan(width);
    const title = g.querySelector("title")?.textContent ?? "";
    expect(title).toContain(`灰色（中心） ${f.mid[ANALOG.horizon].toFixed(3)}`);
    expect(title).toContain(`緑（上） ${f.up[ANALOG.horizon].toFixed(3)}`);
    expect(title).toContain(`赤（下） ${f.lo[ANALOG.horizon].toFixed(3)}`);
    expect(title).toContain("似ていた場所 10か所");
    expect(title).toContain("探した足 400本");
    expect(screen.getByTestId("chart-analog-legend").textContent).toContain("いま探した足は400本です（決まりの1,500本より少ない）。");
  });

  it("does not read a forming candle: the forecast starts at the one before it", () => {
    switchOn();
    const candles = candlesOf(401);
    const f = analogForecast(candles.slice(0, 400).map((c) => c.close))!;
    render(<PriceChart candles={candles} pair="USD/JPY" formingLast />);
    const title = screen.getByTestId("chart-analog").querySelector("title")?.textContent ?? "";
    expect(title).toContain(`灰色（中心） ${f.mid[ANALOG.horizon].toFixed(3)}`);
  });

  it("draws nothing with too few bars, and says why", () => {
    switchOn();
    render(<PriceChart candles={candlesOf(60)} pair="USD/JPY" />);
    expect(screen.queryByTestId("chart-analog")).toBeNull();
    expect(screen.getByTestId("chart-analog-legend").textContent).toContain("似た場所を10か所探せないため、描いていません。");
  });

  it("waits for the deep history while it loads, then searches it with the candles", () => {
    switchOn();
    const all = candlesOf(1700);
    const past = all.slice(0, 1300);
    const candles = all.slice(1300);
    const { rerender } = render(<PriceChart candles={candles} pair="USD/JPY" deepHistory={{ bars: null, status: "loading" }} />);
    expect(screen.queryByTestId("chart-analog")).toBeNull();
    expect(screen.getByTestId("chart-analog-legend").textContent).toContain("読み込み中");
    rerender(
      <LocaleProvider initial="ja">
        <PriceChart candles={candles} pair="USD/JPY" deepHistory={{ bars: past, status: "ready" }} />
      </LocaleProvider>,
    );
    const f = analogForecast(all.map((c) => c.close))!;
    const title = screen.getByTestId("chart-analog").querySelector("title")?.textContent ?? "";
    expect(title).toContain(`灰色（中心） ${f.mid[ANALOG.horizon].toFixed(3)}`);
    expect(title).toContain("探した足 1,500本");
    expect(screen.getByTestId("chart-analog-legend").textContent).not.toContain("より少ない");
  });

  it("speaks English", () => {
    switchOn();
    render(<PriceChart candles={candlesOf(400)} pair="USD/JPY" />, "en");
    expect(screen.getByTestId("chart-overlay-name-analog").textContent).toBe("Similar-past forecast (20 bars ahead)");
    expect(screen.getByTestId("chart-analog").querySelector("title")?.textContent).toContain("10 similar places");
  });
});
