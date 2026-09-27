import { describe, it, expect, afterEach } from "vitest";
import { render as rtlRender, screen, fireEvent, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";
import { LocaleProvider } from "@/lib/i18n";
import PriceChart from "../components/PriceChart";
import { UT_DEFAULTS, utBot } from "../lib/utBot";
import { CHART_PREFS_KEY, resetChartPrefsCache } from "../lib/chartPrefs";

const render = (ui: ReactElement): RenderResult => rtlRender(<LocaleProvider initial="ja">{ui}</LocaleProvider>);

const M15 = 15 * 60_000;
const T0 = Date.parse("2026-09-01T00:00:00Z");
const stamp = (i: number) => new Date(T0 + i * M15).toISOString().slice(0, 19).replace("T", " ");
const walk = (n: number, seed = 17) => {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  let p = 150;
  return Array.from({ length: n }, (_, i) => {
    const open = p;
    p += (rnd() - 0.5) * 0.3;
    return { datetime: stamp(i), open, close: p, high: Math.max(open, p) + rnd() * 0.08, low: Math.min(open, p) - rnd() * 0.08 };
  });
};

describe("#137 UT Bot Alerts (a port of QuantNomad's open-source Pine code)", () => {
  it("has the original's defaults", () => {
    expect(UT_DEFAULTS).toEqual({ keyValue: 1, atrPeriod: 10 });
  });

  it("trails the close by Key Value × ATR, restarts on the other side when crossed, and marks the crossings", () => {
    // worked by hand with ATR 1, Key Value 1 (the loss is each bar's true range)
    const bars = [
      { high: 11, low: 9, close: 10 }, // 10 − 2 = 8
      { high: 11, low: 10, close: 10.5 }, // above: max(8, 10.5 − 1) = 9.5
      { high: 10.6, low: 8.5, close: 9 }, // crosses under 9.5: 9 + 2.1 = 11.1, Sell
      { high: 9.5, low: 8, close: 8.2 }, // below: min(11.1, 8.2 + 1.5) = 9.7
      { high: 10.5, low: 8.2, close: 10.2 }, // crosses over 9.7: 10.2 − 2.3 = 7.9, Buy
    ];
    const r = utBot(bars, { keyValue: 1, atrPeriod: 1 });
    [8, 9.5, 11.1, 9.7, 7.9].forEach((v, i) => expect(r.stop[i]).toBeCloseTo(v, 9));
    expect(r.side).toEqual([1, 1, -1, -1, 1]);
    expect(r.signals).toEqual([
      { i: 2, side: "SELL" },
      { i: 4, side: "BUY" },
    ]);
    // the bar still forming: neither painted nor marked
    const closed = utBot(bars, { keyValue: 1, atrPeriod: 1 }, 3);
    expect(closed.side[4]).toBeNull();
    expect(closed.signals.map((s) => s.i)).toEqual([2]);
  });

  it("has no stop until the ATR has its bars, and a signal on every change of side", () => {
    const r = utBot(walk(2000));
    expect(r.stop.slice(0, 9).every((v) => v === null)).toBe(true);
    expect(r.stop[9]).not.toBeNull();
    let changes = 0;
    for (let i = 10; i < r.side.length; i++) if (r.side[i] !== null && r.side[i - 1] !== null && r.side[i] !== r.side[i - 1]) changes++;
    expect(r.signals.length).toBe(changes);
    // while above, the stop only rises; while below, it only falls
    for (let i = 11; i < r.stop.length; i++) {
      if (r.side[i] === 1 && r.side[i - 1] === 1) expect(r.stop[i]!).toBeGreaterThanOrEqual(r.stop[i - 1]!);
      if (r.side[i] === -1 && r.side[i - 1] === -1) expect(r.stop[i]!).toBeLessThanOrEqual(r.stop[i - 1]!);
    }
  });
});

describe("#137 UT Bot on the chart", () => {
  afterEach(() => {
    localStorage.clear();
    resetChartPrefsCache();
  });

  it("is listed off; on, a Buy/Sell label on every crossing on screen, the candles in its colours, and its note", () => {
    const c = walk(160);
    render(<PriceChart candles={c} pair="USD/JPY" interactive={false} />);
    expect(screen.getByTestId("chart-overlay-name-utBot").textContent).toBe("UT Bot 1 10");
    expect(screen.getByTestId("chart-toggle-utBot").getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByTestId("chart-utbot")).toBeNull();
    const before = [...screen.getByTestId("chart-candles").querySelectorAll("rect")].map((r) => r.getAttribute("fill"));
    fireEvent.click(screen.getByTestId("chart-toggle-utBot"));
    const r = utBot(c);
    const buys = screen.queryAllByTestId("chart-utbot-signal-BUY");
    const sells = screen.queryAllByTestId("chart-utbot-signal-SELL");
    expect(buys.length + sells.length).toBe(r.signals.length);
    expect(buys.every((g) => g.querySelector("text")?.textContent === "Buy")).toBe(true);
    expect(sells.every((g) => g.querySelector("text")?.textContent === "Sell")).toBe(true);
    // a candle closing above the stop green, below it red, whatever its own direction
    const fills = [...screen.getByTestId("chart-candles").querySelectorAll("rect")].map((x) => x.getAttribute("fill"));
    const i = r.side.findIndex((s, k) => s === 1 && c[k].close < c[k].open);
    expect(i).toBeGreaterThan(-1);
    expect(before[i]).toBe("hsl(var(--destructive))");
    expect(fills[i]).toBe("hsl(var(--success))");
    expect(screen.getByTestId("chart-utbot-legend").textContent).toContain("QuantNomad");
    expect(JSON.parse(localStorage.getItem(CHART_PREFS_KEY)!).overlays.utBot).toBe(true);
  });
});
