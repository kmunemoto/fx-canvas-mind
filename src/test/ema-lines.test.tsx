import { describe, it, expect, vi } from "vitest";
import { render as rtlRender, screen, fireEvent, waitFor, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";
import { LocaleProvider } from "@/lib/i18n";

vi.mock("@/lib/supabase", () => ({ supabase: {} }));

import PriceChart from "../components/PriceChart";
import LiveChart from "../components/LiveChart";
import { CHART_PREFS_KEY, getChartPrefs } from "../lib/chartPrefs";
import { EMA_LINES, emaLine } from "../lib/emaLines";
import { emaSeries } from "../../supabase/functions/analyze/indicators";
import { normalizeLiveRead, type LiveRead } from "../lib/liveChart";
import { liveRead } from "../../supabase/functions/live-chart/logic";
import type { QuoteCandle } from "../../supabase/functions/track-outcomes/quotes";
import type { NumericCandle } from "../lib/types";

const render = (ui: ReactElement): RenderResult => rtlRender(<LocaleProvider initial="ja">{ui}</LocaleProvider>);

const M15 = 15 * 60_000;
const T0 = Date.parse("2026-09-01T00:00:00Z");
const stamp = (i: number) => new Date(T0 + i * M15).toISOString().slice(0, 19).replace("T", " ");
const walk = (n: number, seed = 11, start = 0) => {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  let p = 150;
  return Array.from({ length: n }, (_, k) => {
    const open = p;
    p += (rnd() - 0.5) * 0.2;
    return { datetime: stamp(start + k), open, close: p, high: Math.max(open, p) + rnd() * 0.05, low: Math.min(open, p) - rnd() * 0.05 };
  });
};

// the y of each point of a path, in order
const ys = (d: string) => [...d.matchAll(/[ML][\d.]+,([\d.]+)/g)].map((m) => Number(m[1]));

describe("#143 the EMA lines", () => {
  it("are TradingView's EMA — the average of the first n closes, then 2 / (n + 1) of each — as #142 measured it", () => {
    const closes = walk(400).map((c) => c.close);
    for (const { length } of EMA_LINES) {
      const mine = emaLine(closes, length);
      const study = emaSeries(closes, length);
      expect(mine[length - 2]).toBeNull();
      expect(mine[length - 1]).toBeCloseTo(closes.slice(0, length).reduce((a, b) => a + b, 0) / length, 12);
      mine.forEach((v, i) => (v === null ? expect(study[i]).toBeNull() : expect(v).toBeCloseTo(study[i] as number, 12)));
    }
    expect(EMA_LINES.map((l) => l.length)).toEqual([50, 200]);
  });

  it("are on unless switched off, each listed with its line's colour, and switched off one by one", () => {
    expect(getChartPrefs().overlays.ema50).toBe(true);
    expect(getChartPrefs().overlays.ema200).toBe(true);
    render(<PriceChart candles={walk(300)} pair="USD/JPY" />);
    expect(screen.getByTestId("chart-overlay-name-ema50").textContent).toBe("EMA 50");
    expect(screen.getByTestId("chart-overlay-name-ema200").textContent).toBe("EMA 200");
    expect(screen.getByTestId("chart-swatch-ema50").getAttribute("style")).toContain("rgb(255, 152, 0)");
    expect(screen.getByTestId("chart-ema50-line").getAttribute("stroke")).toBe("#FF9800");
    expect(screen.getByTestId("chart-ema200-line").getAttribute("stroke")).toBe("#E040FB");
    expect(screen.getByTestId("chart-ema-legend").textContent).toContain("71.6%");
    expect(screen.getByTestId("chart-ema-legend").textContent).toContain("計算に使った足: 300本");

    fireEvent.click(screen.getByTestId("chart-toggle-ema200"));
    expect(screen.queryByTestId("chart-ema200-line")).toBeNull();
    expect(screen.getByTestId("chart-ema50-line")).toBeTruthy();
    expect(JSON.parse(localStorage.getItem(CHART_PREFS_KEY)!).overlays.ema200).toBe(false);
    fireEvent.click(screen.getByTestId("chart-toggle-ema50"));
    expect(screen.queryByTestId("chart-ema")).toBeNull();
    expect(screen.queryByTestId("chart-ema-legend")).toBeNull();
  });

  it("start where the average has its closes: EMA 200 is not drawn on a chart of 120 bars alone", () => {
    render(<PriceChart candles={walk(120)} pair="USD/JPY" />);
    expect(screen.getByTestId("chart-ema50-line")).toBeTruthy();
    expect(screen.queryByTestId("chart-ema200-line")).toBeNull();
  });

  it("over the bars before the chart's: drawn from the first candle once they are there, nothing while they load", () => {
    const all = walk(720);
    const past = all.slice(0, 600);
    const shown = all.slice(600);
    const { rerender } = render(<PriceChart candles={shown} pair="USD/JPY" zoneShiftHistory={{ bars: null, status: "loading" }} />);
    expect(screen.queryByTestId("chart-ema")).toBeNull();
    expect(screen.getByTestId("chart-ema-legend").textContent).toContain("読み込み中");

    rerender(
      <LocaleProvider initial="ja">
        <PriceChart candles={shown} pair="USD/JPY" zoneShiftHistory={{ bars: past, status: "ready" }} />
      </LocaleProvider>,
    );
    const d = screen.getByTestId("chart-ema200-line").getAttribute("d")!;
    // a point for every candle on the chart (none of them waits for 200)
    expect(ys(d)).toHaveLength(120);
    expect(screen.getByTestId("chart-ema-legend").textContent).toContain("計算に使った足: 720本");
  });

  it("are inside the price scale: a line far from the candles is fitted, not cut off", () => {
    // 250 bars flat at 100, then 120 bars at 110: EMA 200 sits well under
    // every candle on screen
    const bar = (i: number, p: number) => ({ datetime: stamp(i), open: p, high: p + 0.05, low: p - 0.05, close: p });
    const past = Array.from({ length: 250 }, (_, i) => bar(i, 100));
    const shown = Array.from({ length: 120 }, (_, i) => bar(250 + i, 110 + Math.sin(i / 4) * 0.2));
    render(<PriceChart candles={shown} pair="USD/JPY" zoneShiftHistory={{ bars: past, status: "ready" }} />);
    const svg = screen.getByTestId("chart-ema").closest("svg")!;
    const height = Number(svg.getAttribute("viewBox")!.split(" ")[3]);
    for (const k of ["chart-ema50-line", "chart-ema200-line"]) {
      const y = ys(screen.getByTestId(k).getAttribute("d")!);
      expect(Math.min(...y)).toBeGreaterThanOrEqual(0);
      expect(Math.max(...y)).toBeLessThanOrEqual(height);
    }
  });
});

const quotes = (n: number): QuoteCandle[] =>
  walk(n).map((c) => {
    const iso = new Date(Date.parse(c.datetime.replace(" ", "T") + "Z")).toISOString();
    const side = (d: number) => ({ datetime: iso, open: c.open + d, high: c.high + d, low: c.low + d, close: c.close + d });
    return { datetime: iso, bid: side(-0.002), ask: side(0.002) };
  });

describe("#143 the live chart reads the bars before its own for the EMA lines", () => {
  const NOW = T0 + 259 * M15 + 60_000;
  const readFor = (pair: string, interval: string): LiveRead => {
    const r = normalizeLiveRead(liveRead(pair, interval, quotes(260), NOW))!;
    return { ...r, pair, interval, nextClose: new Date(Date.now() + 600_000).toISOString() };
  };
  const chart = (loadHistory: (pair: string, interval: string) => Promise<NumericCandle[]>, allowed = true) => (
    <LiveChart
      defaultInterval="15min"
      loadBars={async (pair: string, interval: string) => readFor(pair, interval)}
      loadTicks={async () => ({})}
      loadHistory={loadHistory}
      loadDow={async () => []}
      indicatorsAllowed={allowed}
    />
  );

  it("with Zone Shift and the Pro-style score off, while an EMA line is on", async () => {
    localStorage.setItem(CHART_PREFS_KEY, JSON.stringify({ overlays: { zoneShift: false, gainzPro: false, ema50: false, ema200: true } }));
    const loadHistory = vi.fn(async (): Promise<NumericCandle[]> => []);
    render(chart(loadHistory));
    await waitFor(() => expect(loadHistory).toHaveBeenCalledWith("USD/JPY", "15min"));
  });

  it("not while the indicators are locked", async () => {
    const loadHistory = vi.fn(async (): Promise<NumericCandle[]> => []);
    render(chart(loadHistory, false));
    await waitFor(() => expect(screen.getByTestId("live-signals")).toBeTruthy());
    expect(loadHistory).not.toHaveBeenCalled();
    expect(screen.getByTestId("chart-lock-ema50")).toBeTruthy();
    expect(screen.getByTestId("chart-lock-ema200")).toBeTruthy();
    expect(screen.queryByTestId("chart-ema")).toBeNull();
  });
});
