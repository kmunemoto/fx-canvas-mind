import { describe, it, expect, afterEach } from "vitest";
import { render as rtlRender, screen, fireEvent, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";
import { LocaleProvider } from "@/lib/i18n";
import PriceChart from "../components/PriceChart";
import { CHART_PREFS_KEY, resetChartPrefsCache } from "../lib/chartPrefs";
import { WVP_DEFAULTS, weightOf, weightedVolumeProfile } from "../lib/weightedVolumeProfile";

const render = (ui: ReactElement): RenderResult => rtlRender(<LocaleProvider initial="ja">{ui}</LocaleProvider>);

// Four candles over 100–104, read in 4 rows of 1:
//   row 0 [103, 104], row 1 [102, 103], row 2 [101, 102], row 3 [100, 101]
const FOUR = [
  { open: 100, high: 104, low: 100, close: 103 }, // up, through every row
  { open: 102.8, high: 102.9, low: 101.2, close: 101.5 }, // down, rows 1–2
  { open: 102.2, high: 102.6, low: 102.1, close: 102.5 }, // up, row 1 only
  { open: 102, high: 102.1, low: 100.5, close: 100.8 }, // down, rows 1–3
];

const series = (count: number) =>
  Array.from({ length: count }, (_, i) => {
    const open = 100 + Math.sin(i / 5);
    const close = 100 + Math.sin((i + 1) / 5);
    return {
      datetime: new Date(Date.parse("2026-09-23T00:00:00Z") + i * 15 * 60_000).toISOString().slice(0, 19).replace("T", " "),
      open,
      high: Math.max(open, close) + 0.05,
      low: Math.min(open, close) - 0.05,
      close,
    };
  });

describe("#122 Weighted Volume Profile (a port of Flux Charts' open-source code)", () => {
  it("counts each candle into every row its range touches, as bullish or bearish, and sizes the bars 1 to 50 by the count", () => {
    const vp = weightedVolumeProfile(FOUR, { rowCount: 4 })!;
    expect(vp.rows.map((r) => [r.top, r.bottom])).toEqual([[104, 103], [103, 102], [102, 101], [101, 100]]);
    expect(vp.rows.map((r) => [r.bull, r.bear, r.total])).toEqual([[1, 0, 1], [2, 2, 4], [1, 2, 3], [1, 1, 2]]);
    // least (1) → 1 candle long, most (4) → 50; split by the bull/bear share and rounded
    expect(vp.rows.map((r) => [r.bullSize, r.bearSize, r.end])).toEqual([[1, 0, 1], [25, 25, 50], [11, 22, 33], [9, 9, 18]]);
    expect(vp.rows.every((r) => r.start === 0)).toBe(true);
    expect(vp.gap).toBeCloseTo(1 / 3);
    expect(vp.poc).toEqual({ row: 1, price: 102.5 });
    expect([vp.from, vp.to]).toEqual([0, 3]);
  });

  it("takes the lowest of the fullest rows as the point of control, and gives every row the full length when all are equal", () => {
    const vp = weightedVolumeProfile([{ open: 101, high: 104, low: 100, close: 100.5 }], { rowCount: 4 })!;
    expect(vp.rows.map((r) => r.total)).toEqual([1, 1, 1, 1]);
    expect(vp.rows.map((r) => r.bearSize)).toEqual([50, 50, 50, 50]);
    expect(vp.poc).toEqual({ row: 3, price: 100.5 });
  });

  it("ranges over the newest candles, reading one more past them as the original's loop does", () => {
    const four = weightedVolumeProfile(FOUR, { rowCount: 4, analyzeBars: 3 })!;
    const three = weightedVolumeProfile(FOUR.slice(1), { rowCount: 4, analyzeBars: 3 })!;
    // the range is the newest three's; the oldest candle (through all of it) adds 1 to every row
    expect(four.rows.map((r) => [r.top, r.bottom])).toEqual(three.rows.map((r) => [r.top, r.bottom]));
    expect(four.rows.map((r) => r.total)).toEqual(three.rows.map((r) => r.total + 1));
    expect([four.from, four.to]).toEqual([1, 3]);
  });

  it("weighs by distance from the newest candle as published for Recent and Past, and evenly by default", () => {
    expect(WVP_DEFAULTS).toMatchObject({ analyzeBars: 200, rowCount: 30, weighting: "Normal", maxRowSize: 50 });
    expect(weightOf("Normal", 50, 200)).toBe(1);
    expect(weightOf("Recent", 0, 200)).toBeCloseTo(1);
    // "the candlestick 50 candles back contributes ~17%"
    expect(weightOf("Recent", 50, 200)).toBeCloseTo(0.85 / 51 + 0.15);
    expect(weightOf("Past", 199, 200)).toBeCloseTo(1);
    expect(weightOf("Past", 0, 200)).toBeCloseTo(0.85 / 200 + 0.15);
    const past = weightedVolumeProfile(FOUR, { rowCount: 4, analyzeBars: 4, weighting: "Past" })!;
    expect(past.rows[1].total).toBeCloseTo(1 + 0.7875 + 0.575 + 0.3625);
    const recent = weightedVolumeProfile(FOUR, { rowCount: 4, weighting: "Recent" })!;
    expect(recent.rows[1].total).toBeCloseTo(1 + 0.575 + 0.85 / 3 + 0.15 + 0.3625);
  });

  it("has nothing to draw without candles or without a range", () => {
    expect(weightedVolumeProfile([])).toBeNull();
    expect(weightedVolumeProfile([{ open: 1, high: 1, low: 1, close: 1 }])).toBeNull();
  });
});

describe("#122 the Weighted Volume Profile on the chart", () => {
  afterEach(() => {
    localStorage.clear();
    resetChartPrefsCache();
  });

  it("is one indicator with FVG Crossfire (#123): one line in the list, one switch, one legend, the same colours", () => {
    const bars = series(80);
    render(<PriceChart candles={bars} pair="USD/JPY" />);
    expect(screen.queryByTestId("chart-overlay-name-volumeProfile")).toBeNull();
    expect(screen.queryByTestId("chart-overlay-name-fvgCrossfire")).toBeNull();
    expect(screen.getByTestId("chart-overlay-name-fvgProfile").textContent).toBe("FVG Crossfire + Volume Profile");
    expect(screen.getByTestId("chart-toggle-fvgProfile").getAttribute("aria-pressed")).toBe("true");

    const group = screen.getByTestId("chart-vp");
    // under the candles
    const candles = document.querySelector("g[data-testid='chart-candles']")!;
    expect(group.compareDocumentPosition(candles) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const vp = weightedVolumeProfile(bars)!;
    const rows = screen.getAllByTestId("chart-vp-row");
    expect(rows.filter((r) => r.getAttribute("data-side") === "bull")).toHaveLength(vp.rows.filter((r) => r.bullSize > 0).length);
    expect(rows.filter((r) => r.getAttribute("data-side") === "bear")).toHaveLength(vp.rows.filter((r) => r.bearSize > 0).length);
    expect(Number(screen.getByTestId("chart-vp-poc").getAttribute("data-price"))).toBeCloseTo(vp.poc!.price);
    expect(screen.getByTestId("chart-vp-poc").getAttribute("stroke")).toBe("#FFEB3B");
    // FVG Crossfire's green and red
    expect(rows.find((r) => r.getAttribute("data-side") === "bull")!.getAttribute("fill")).toBe("#0ecb81");
    expect(rows.find((r) => r.getAttribute("data-side") === "bear")!.getAttribute("fill")).toBe("#f6465d");

    const legends = screen.getAllByTestId("chart-fvgprofile-legend");
    expect(legends).toHaveLength(1);
    const legend = legends[0].textContent!;
    expect(legend).toContain("FVG Crossfire ＋ Weighted Volume Profile");
    expect(legend).toContain("MPL 2.0");
    expect(legend).toContain("【箱】");
    expect(legend).toContain("【左の横棒】直近80本（チャートにある全部。元は200本）");
    expect(legend).toContain("出来高がない");

    // one switch takes both off
    fireEvent.click(screen.getByTestId("chart-toggle-fvgProfile"));
    expect(screen.queryByTestId("chart-vp")).toBeNull();
    expect(screen.queryByTestId("chart-fvgcf")).toBeNull();
    expect(screen.queryByTestId("chart-fvgprofile-legend")).toBeNull();
    expect(JSON.parse(localStorage.getItem(CHART_PREFS_KEY)!).overlays.fvgProfile).toBe(false);
    fireEvent.click(screen.getByTestId("chart-toggle-fvgProfile"));
    expect(screen.getByTestId("chart-vp")).toBeTruthy();
  });

  it("keeps FVG Crossfire's own switch from before as the pair's", () => {
    localStorage.setItem(CHART_PREFS_KEY, JSON.stringify({ overlays: { fvgCrossfire: false } }));
    render(<PriceChart candles={series(80)} pair="USD/JPY" />);
    expect(screen.getByTestId("chart-toggle-fvgProfile").getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByTestId("chart-vp")).toBeNull();
  });

  it("reads the newest 200 when the chart has more, and draws the POC deeper yellow on the white background", () => {
    localStorage.setItem(CHART_PREFS_KEY, JSON.stringify({ theme: "light" }));
    render(<PriceChart candles={series(250)} pair="USD/JPY" />);
    const legend = screen.getByTestId("chart-fvgprofile-legend").textContent!;
    expect(legend).toContain("直近200本の値幅");
    expect(screen.getByTestId("chart-vp-poc").getAttribute("stroke")).toBe("#F2A900");
  });
});
