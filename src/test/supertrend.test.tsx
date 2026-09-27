import { describe, it, expect, afterEach } from "vitest";
import { render as rtlRender, screen, fireEvent, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";
import { LocaleProvider } from "@/lib/i18n";
import PriceChart from "../components/PriceChart";
import { ST_DEFAULTS, pineAtr, supertrend } from "../lib/supertrend";
import { CHART_PREFS_KEY, resetChartPrefsCache } from "../lib/chartPrefs";

const render = (ui: ReactElement): RenderResult => rtlRender(<LocaleProvider initial="ja">{ui}</LocaleProvider>);

const M15 = 15 * 60_000;
const T0 = Date.parse("2026-09-01T00:00:00Z");
const stamp = (i: number) => new Date(T0 + i * M15).toISOString().slice(0, 19).replace("T", " ");
const walk = (n: number, seed = 3) => {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  let p = 150;
  return Array.from({ length: n }, (_, i) => {
    const open = p;
    p += (rnd() - 0.5) * 0.3;
    return { datetime: stamp(i), open, close: p, high: Math.max(open, p) + rnd() * 0.08, low: Math.min(open, p) - rnd() * 0.08 };
  });
};

describe("#136 SuperTrend (a port of KivancOzbilgic's open-source Pine code)", () => {
  it("has the original's defaults and Pine's atr(): an RMA seeded with the first average", () => {
    expect(ST_DEFAULTS).toEqual({ period: 10, multiplier: 3 });
    // true ranges 2, 2, 4.5 (the first bar's is its high − low)
    const bars = [
      { high: 11, low: 9, close: 10 },
      { high: 12, low: 10, close: 11.5 },
      { high: 11, low: 7, close: 7.5 },
    ];
    const a = pineAtr(bars, 2);
    expect(a[0]).toBeNull();
    expect(a[1]).toBeCloseTo(2, 12);
    expect(a[2]).toBeCloseTo((4.5 + 2) / 2, 12);
  });

  it("holds each band, turns where a close crosses the other band, and marks the turn on the line", () => {
    // worked by hand with ATR 1, multiplier 1 (the ATR is each bar's true range)
    const bars = [
      { high: 11, low: 9, close: 10 }, // up 8, dn 12
      { high: 12, low: 10, close: 11.5 }, // up held at max(9, 8) = 9, dn held at 12
      { high: 11, low: 7, close: 7.5 }, // closes under 9: down, on dn 12
      { high: 8, low: 6, close: 7 }, // dn 9
      { high: 10.5, low: 8, close: 10 }, // closes over 9: up, on up max(5.75, 5)
    ];
    const r = supertrend(bars, { period: 1, multiplier: 1 });
    expect(r.trend).toEqual([1, 1, -1, -1, 1]);
    expect(r.line).toEqual([8, 9, 12, 9, 5.75]);
    expect(r.signals).toEqual([
      { i: 2, side: "SELL", price: 12 },
      { i: 4, side: "BUY", price: 5.75 },
    ]);
    // the bar still forming: neither drawn nor marked
    const closed = supertrend(bars, { period: 1, multiplier: 1 }, 3);
    expect(closed.line[4]).toBeNull();
    expect(closed.signals.map((s) => s.i)).toEqual([2]);
  });

  it("only rises while up and only falls while down, and draws nothing until the ATR has its bars", () => {
    const r = supertrend(walk(2000));
    expect(r.line.slice(0, 9).every((v) => v === null)).toBe(true);
    expect(r.line[9]).not.toBeNull();
    for (let i = 10; i < r.line.length; i++) {
      if (r.trend[i] !== r.trend[i - 1]) continue;
      if (r.trend[i] === 1) expect(r.line[i]!).toBeGreaterThanOrEqual(r.line[i - 1]!);
      else expect(r.line[i]!).toBeLessThanOrEqual(r.line[i - 1]!);
    }
    expect(r.signals.length).toBeGreaterThan(10);
  });
});

describe("#136 SuperTrend on the chart", () => {
  afterEach(() => {
    localStorage.clear();
    resetChartPrefsCache();
  });

  it("is listed off; on, its line, its fill, a Buy/Sell label on every turn on screen, and its note", () => {
    const c = walk(160);
    render(<PriceChart candles={c} pair="USD/JPY" interactive={false} />);
    expect(screen.getByTestId("chart-overlay-name-supertrend").textContent).toBe("SuperTrend 10 3");
    expect(screen.getByTestId("chart-toggle-supertrend").getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByTestId("chart-supertrend")).toBeNull();
    fireEvent.click(screen.getByTestId("chart-toggle-supertrend"));
    const r = supertrend(c);
    expect(screen.getAllByTestId("chart-supertrend-line").length).toBeGreaterThan(0);
    expect(screen.getByTestId("chart-supertrend-fill")).toBeTruthy();
    const drawn = [...screen.queryAllByTestId("chart-supertrend-signal-BUY"), ...screen.queryAllByTestId("chart-supertrend-signal-SELL")];
    expect(drawn).toHaveLength(r.signals.length);
    expect(screen.queryAllByTestId("chart-supertrend-signal-BUY").every((g) => g.querySelector("text")?.textContent === "Buy")).toBe(true);
    expect(screen.queryAllByTestId("chart-supertrend-signal-SELL").every((g) => g.querySelector("text")?.textContent === "Sell")).toBe(true);
    expect(screen.getByTestId("chart-supertrend-legend").textContent).toContain("KivancOzbilgic");
    expect(JSON.parse(localStorage.getItem(CHART_PREFS_KEY)!).overlays.supertrend).toBe(true);
  });

  it("marks nothing on the candle still forming", () => {
    const c = walk(160);
    const last = supertrend(c).signals.at(-1)!;
    const upTo = c.slice(0, last.i + 1);
    localStorage.setItem(CHART_PREFS_KEY, JSON.stringify({ overlays: { supertrend: true } }));
    const { unmount } = render(<PriceChart candles={upTo} pair="USD/JPY" interactive={false} />);
    const closedCount = screen.queryAllByTestId(`chart-supertrend-signal-${last.side}`).length;
    unmount();
    render(<PriceChart candles={upTo} pair="USD/JPY" interactive={false} formingLast />);
    expect(screen.queryAllByTestId(`chart-supertrend-signal-${last.side}`)).toHaveLength(closedCount - 1);
  });
});
