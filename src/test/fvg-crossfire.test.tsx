import { describe, it, expect, afterEach } from "vitest";
import { render as rtlRender, screen, fireEvent, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";
import { LocaleProvider } from "@/lib/i18n";
import PriceChart from "../components/PriceChart";
import { CHART_PREFS_KEY, resetChartPrefsCache } from "../lib/chartPrefs";
import { fvgCrossfire, starText, tradingDay } from "../lib/fvgCrossfire";

const render = (ui: ReactElement): RenderResult => rtlRender(<LocaleProvider initial="ja">{ui}</LocaleProvider>);

// A bullish gap (bars 0–2), a bearish gap printed over it (bars 5–7: the
// crossfire zone), a bullish gap over that zone (bars 10–12: the flip),
// a retest of the flipped zone (bar 14), and a close through it (bar 16).
const OHLC: Array<[number, number, number, number]> = [
  [99.9, 100.0, 99.8, 99.95],
  [99.95, 100.8, 99.9, 100.7],
  [100.7, 101.0, 100.5, 100.9], // bullish gap [100.0, 100.5]
  [100.9, 101.2, 100.8, 101.1],
  [101.1, 101.3, 100.9, 101.0],
  [101.0, 101.1, 100.4, 100.7],
  [100.7, 100.75, 99.9, 100.0],
  [100.0, 100.1, 99.7, 99.8], // bearish gap [100.1, 100.4] over it: zone [100.1, 100.4]
  [99.8, 99.9, 99.6, 99.7],
  [99.7, 99.95, 99.6, 99.9],
  [99.9, 100.2, 99.85, 100.15], // back into the zone: a retest ▼
  [100.15, 100.6, 100.1, 100.35],
  [100.35, 100.7, 100.3, 100.6], // bullish gap [100.2, 100.3] over the zone: the flip
  [100.6, 100.8, 100.5, 100.7],
  [100.7, 100.75, 100.28, 100.5], // back into the flipped zone: a retest ▲
  [100.5, 100.6, 100.4, 100.55],
  [100.55, 100.6, 100.1, 100.15], // a close under its bottom: finished
];
const at = (start: string, rows = OHLC) =>
  rows.map(([open, high, low, close], i) => ({
    datetime: new Date(Date.parse(start) + i * 15 * 60_000).toISOString().slice(0, 19).replace("T", " "),
    open, high, low, close,
  }));
// a Wednesday, well inside one trading day
const bars = at("2026-09-23T10:00:00Z");

describe("#121 FVG Crossfire (a port of FluxChart's open-source code)", () => {
  it("makes a zone only where an opposite gap prints over an unfilled one, in the newer gap's direction, with the funnel from the older", () => {
    const r = fvgCrossfire(bars.slice(0, 10));
    expect(r.segments).toHaveLength(1);
    const z = r.segments[0];
    expect(z).toMatchObject({ dir: -1, top: 100.4, bottom: 100.1, from: 6, to: null, flips: 1, active: true, done: false });
    expect(z.funnel).toEqual({ dir: 1, topBar: 2, top: 100.5, bottomBar: 0, bottom: 100.0 });
    // a gap that meets nothing is never drawn
    expect(fvgCrossfire(bars.slice(0, 7)).segments).toHaveLength(0);
  });

  it("flips on an opposite gap over the zone, narrowing to the overlap, freezing the old state and counting the flip", () => {
    const r = fvgCrossfire(bars.slice(0, 16));
    expect(r.segments).toHaveLength(2);
    const [old, now] = r.segments;
    expect(old).toMatchObject({ dir: -1, from: 6, to: 11, active: false, done: false, retests: [10] });
    expect(now).toMatchObject({ dir: 1, top: 100.3, bottom: 100.2, from: 11, to: null, flips: 2, active: true, retests: [14] });
    expect(now.chainId).toBe(old.chainId);
    // the zone is newer than the gap that flipped it: no flip before bar 12 closes
    expect(fvgCrossfire(bars.slice(0, 13), 11).segments).toHaveLength(1);
  });

  it("finishes the whole chain when a close goes through the far side, keeping it faded without arrows", () => {
    const r = fvgCrossfire(bars);
    expect(r.segments.every((s) => s.done && !s.active && s.retests.length === 0)).toBe(true);
    expect(r.segments[1].to).toBe(16);
    expect(r.segments[0].to).toBe(11);
  });

  it("finds no gap on the candles beside a session break (TradingView's forex day starts at 17:00 New York)", () => {
    // the bullish gap's third candle opens at 21:00 UTC — 17:00 in New York in September
    expect(tradingDay(Date.parse("2026-09-23T21:00:00Z"))).toBe(tradingDay(Date.parse("2026-09-23T20:45:00Z")) + 1);
    expect(tradingDay(Date.parse("2026-01-14T22:00:00Z"))).toBe(tradingDay(Date.parse("2026-01-14T21:45:00Z")) + 1);
    // so the first bullish gap is never found: the bearish gap (bar 7) waits
    // as a base instead, and the only zone is the bullish one printed over
    // it at bar 12, grown from the bearish gap
    const r = fvgCrossfire(at("2026-09-23T20:30:00Z"));
    expect(r.segments).toHaveLength(1);
    expect(r.segments[0]).toMatchObject({ dir: 1, top: 100.3, bottom: 100.2, flips: 1 });
    expect(r.segments[0].funnel).toMatchObject({ dir: -1, top: 100.4, bottom: 100.1 });
  });

  it("counts in stars up to four, then a number", () => {
    expect([1, 2, 4, 5, 9].map(starText)).toEqual(["★", "★★", "★★★★", "5 ★", "9 ★"]);
  });
});

describe("#121 FVG Crossfire on the chart", () => {
  afterEach(() => {
    localStorage.clear();
    resetChartPrefsCache();
  });

  it("is on in the list (#123: with the volume profile, as one), draws the zones, the funnel, the live zone's stars and the arrows, and is switched off by its eye", () => {
    render(<PriceChart candles={bars.slice(0, 16)} pair="USD/JPY" />);
    expect(screen.getByTestId("chart-overlay-name-fvgProfile").textContent).toBe("FVG Crossfire + Volume Profile");
    expect(screen.getByTestId("chart-toggle-fvgProfile").getAttribute("aria-pressed")).toBe("true");
    const zones = screen.getAllByTestId("chart-fvgcf-zone");
    expect(zones.map((z) => [z.getAttribute("data-dir"), z.getAttribute("data-live")])).toEqual([["bear", "0"], ["bull", "1"]]);
    expect(screen.getAllByTestId("chart-fvgcf-funnel")).toHaveLength(1);
    expect(screen.getByTestId("chart-fvgcf-stars").textContent).toBe("★★");
    expect(screen.getAllByTestId("chart-fvgcf-retest-bear")).toHaveLength(1);
    expect(screen.getAllByTestId("chart-fvgcf-retest-bull")).toHaveLength(1);
    expect(screen.getByTestId("chart-fvgprofile-legend").textContent).toContain("MPL 2.0");

    fireEvent.click(screen.getByTestId("chart-toggle-fvgProfile"));
    expect(screen.queryByTestId("chart-fvgcf")).toBeNull();
    expect(JSON.parse(localStorage.getItem(CHART_PREFS_KEY)!).overlays.fvgProfile).toBe(false);
  });

  it("marks nothing on the candle still forming", () => {
    // the flipping gap's candle (12) still forming: the zone has not flipped
    render(<PriceChart candles={bars.slice(0, 13)} pair="USD/JPY" formingLast />);
    expect(screen.getAllByTestId("chart-fvgcf-zone")).toHaveLength(1);
    expect(screen.getByTestId("chart-fvgcf-stars").textContent).toBe("★");
  });
});
