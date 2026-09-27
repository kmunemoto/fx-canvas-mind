import { describe, it, expect, vi, afterEach } from "vitest";
import { render as rtlRender, screen, fireEvent, waitFor, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";
import { LocaleProvider } from "@/lib/i18n";

vi.mock("@/lib/supabase", () => ({ supabase: {} }));

import PriceChart from "../components/PriceChart";
import LiveChart from "../components/LiveChart";
import { CHART_PREFS_KEY, resetChartPrefsCache } from "../lib/chartPrefs";
import { gainzPro } from "../lib/gainzPro";
import { normalizeLiveRead, type LiveRead } from "../lib/liveChart";
import { liveRead } from "../../supabase/functions/live-chart/logic";
import type { QuoteCandle } from "../../supabase/functions/track-outcomes/quotes";

const render = (ui: ReactElement): RenderResult => rtlRender(<LocaleProvider initial="ja">{ui}</LocaleProvider>);

const M15 = 15 * 60_000;
const T0 = Date.parse("2026-09-01T00:00:00Z");
const stamp = (i: number) => new Date(T0 + i * M15).toISOString().slice(0, 19).replace("T", " ");
// #131: a seeded random walk as 15-minute candles
const walk = (n: number, seed = 11) => {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  let p = 150;
  return Array.from({ length: n }, (_, i) => {
    const open = p;
    p += 0.002 + (rnd() - 0.5) * 0.12;
    const close = p;
    return { datetime: stamp(i), open, close, high: Math.max(open, close) + rnd() * 0.04, low: Math.min(open, close) - rnd() * 0.04 };
  });
};

describe("#131 the Pro-style score on the chart", () => {
  afterEach(() => {
    localStorage.clear();
    resetChartPrefsCache();
  });

  it("is listed off; on, a P on every signal's bar and its legend with the measured numbers", () => {
    const bars = walk(700);
    const expected = gainzPro(bars).signals;
    expect(expected.length).toBeGreaterThan(0);
    render(<PriceChart candles={bars} pair="USD/JPY" interactive={false} />);
    expect(screen.getByTestId("chart-overlay-name-gainzPro").textContent).toBe("Pro型（点数）");
    expect(screen.getByTestId("chart-toggle-gainzPro").getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByTestId("chart-gainzpro-legend")).toBeNull();
    fireEvent.click(screen.getByTestId("chart-toggle-gainzPro"));
    const drawn = [...screen.queryAllByTestId("chart-gainzpro-signal-BUY"), ...screen.queryAllByTestId("chart-gainzpro-signal-SELL")];
    expect(drawn).toHaveLength(expected.length);
    expect(screen.queryAllByTestId("chart-gainzpro-signal-BUY")).toHaveLength(expected.filter((s) => s.side === "BUY").length);
    const legend = screen.getByTestId("chart-gainzpro-legend").textContent!;
    expect(legend).toContain("独自に式にしたもの");
    expect(legend).toContain("43,665回・勝率29.3%");
    expect(legend).toContain("計算に使った足: 700本");
  });

  it("marks nothing on the candle still forming", () => {
    const bars = walk(700);
    const last = gainzPro(bars).signals.at(-1)!;
    const upTo = bars.slice(0, last.i + 1);
    localStorage.setItem(CHART_PREFS_KEY, JSON.stringify({ overlays: { gainzPro: true } }));
    const { unmount } = render(<PriceChart candles={upTo} pair="USD/JPY" interactive={false} />);
    const closedCount = screen.queryAllByTestId(`chart-gainzpro-signal-${last.side}`).length;
    unmount();
    render(<PriceChart candles={upTo} pair="USD/JPY" interactive={false} formingLast />);
    expect(screen.queryAllByTestId(`chart-gainzpro-signal-${last.side}`)).toHaveLength(closedCount - 1);
  });

  it("is not listed on a chart too short to score", () => {
    render(<PriceChart candles={walk(120)} pair="USD/JPY" />);
    expect(screen.queryByTestId("chart-overlay-name-gainzPro")).toBeNull();
  });
});

const quotes = (n: number): QuoteCandle[] =>
  walk(n).map((c) => {
    const iso = new Date(Date.parse(c.datetime.replace(" ", "T") + "Z")).toISOString();
    const side = (d: number) => ({ datetime: iso, open: c.open + d, high: c.high + d, low: c.low + d, close: c.close + d });
    return { datetime: iso, bid: side(-0.002), ask: side(0.002) };
  });

describe("#131 the live chart reads the history for it", () => {
  afterEach(() => {
    localStorage.clear();
    resetChartPrefsCache();
  });

  const NOW = T0 + 259 * M15 + 60_000;
  const readFor = (pair: string, interval: string): LiveRead => {
    const r = normalizeLiveRead(liveRead(pair, interval, quotes(260), NOW))!;
    return { ...r, pair, interval, nextClose: new Date(Date.now() + 600_000).toISOString() };
  };

  it("reads the earlier bars while the Pro-style score is on, Zone Shift off", async () => {
    localStorage.setItem(CHART_PREFS_KEY, JSON.stringify({ overlays: { zoneShift: false, gainzPro: true } }));
    const loadBars = vi.fn(async (pair: string, interval: string) => readFor(pair, interval));
    const loadHistory = vi.fn(async () => []);
    render(<LiveChart defaultInterval="15min" loadBars={loadBars} loadTicks={async () => ({})} loadHistory={loadHistory} loadDow={async () => []} />);
    await waitFor(() => expect(loadHistory).toHaveBeenCalledWith("USD/JPY", "15min"));
    expect(screen.getByTestId("chart-toggle-gainzPro").getAttribute("aria-pressed")).toBe("true");
  });
});
