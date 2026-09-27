import { describe, it, expect, vi, afterEach } from "vitest";
import { render as rtlRender, screen, fireEvent, waitFor, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";
import { LocaleProvider } from "@/lib/i18n";

vi.mock("@/lib/supabase", () => ({ supabase: {} }));

import PriceChart from "../components/PriceChart";
import LiveChart from "../components/LiveChart";
import { CHART_PREFS_KEY, resetChartPrefsCache } from "../lib/chartPrefs";
import { normalizeLiveRead, type LiveRead } from "../lib/liveChart";
import { liveRead } from "../../supabase/functions/live-chart/logic";
import type { QuoteCandle } from "../../supabase/functions/track-outcomes/quotes";

const render = (ui: ReactElement): RenderResult => rtlRender(<LocaleProvider initial="ja">{ui}</LocaleProvider>);

const M15 = 15 * 60_000;
const T0 = Date.parse("2026-09-01T00:00:00Z");
const stamp = (i: number) => new Date(T0 + i * M15).toISOString().slice(0, 19).replace("T", " ");
const walk = (n: number, seed = 7) => {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  let p = 150;
  return Array.from({ length: n }, (_, i) => {
    const open = p;
    p += (rnd() - 0.5) * 0.2;
    return { datetime: stamp(i), open, close: p, high: Math.max(open, p) + rnd() * 0.05, low: Math.min(open, p) - rnd() * 0.05 };
  });
};

// every indicator switched on in this browser
const ALL_ON = {
  stoch: true,
  pctB: true,
  rci: true,
  overlays: { kalman: true, supertrend: true, utBot: true, fvgProfile: true, zoneShift: true, dow: true, gainzPro: true, ema50: true, ema200: true },
};
const LOCKED = ["kalman", "supertrend", "utBot", "fvgProfile", "stoch", "pctB", "rci", "ema50", "ema200"];

describe("#140 the indicators are a paid feature", () => {
  afterEach(() => {
    localStorage.clear();
    resetChartPrefsCache();
  });

  it("locked, every indicator is listed with a lock, none is drawn whatever was saved, and a tap leads to the plan", () => {
    localStorage.setItem(CHART_PREFS_KEY, JSON.stringify(ALL_ON));
    const onLocked = vi.fn();
    render(<PriceChart candles={walk(300)} pair="USD/JPY" indicatorsLocked onLockedIndicator={onLocked} />);
    for (const k of LOCKED) {
      expect(screen.getByTestId(`chart-lock-${k}`)).toBeTruthy();
      expect(screen.queryByTestId(`chart-toggle-${k}`)).toBeNull();
    }
    for (const id of ["chart-stoch", "chart-pctb", "chart-rci", "chart-kalman", "chart-supertrend", "chart-utbot", "chart-fvgcf", "chart-fvgprofile-legend", "chart-zoneshift", "chart-stoch-settings", "chart-ema", "chart-ema-legend"]) {
      expect(screen.queryByTestId(id)).toBeNull();
    }
    fireEvent.click(screen.getByTestId("chart-lock-supertrend"));
    expect(onLocked).toHaveBeenCalledTimes(1);
    // the choice saved in this browser is kept for when a plan unlocks it
    expect(JSON.parse(localStorage.getItem(CHART_PREFS_KEY)!).overlays.supertrend).toBe(true);
  });

  it("unlocked, the same browser's choices are drawn again", () => {
    localStorage.setItem(CHART_PREFS_KEY, JSON.stringify(ALL_ON));
    render(<PriceChart candles={walk(300)} pair="USD/JPY" />);
    expect(screen.queryByTestId("chart-lock-stoch")).toBeNull();
    expect(screen.getByTestId("chart-stoch")).toBeTruthy();
    expect(screen.getByTestId("chart-pctb")).toBeTruthy();
    expect(screen.getByTestId("chart-supertrend")).toBeTruthy();
    expect(screen.getByTestId("chart-fvgprofile-legend")).toBeTruthy();
    expect(screen.getByTestId("chart-ema200-line")).toBeTruthy();
  });

  it("keeps the signals and what they are made of free: the rule's RSI and the SAR stay switchable", () => {
    const c = walk(300);
    render(
      <PriceChart
        candles={c}
        pair="USD/JPY"
        rsi={c.map((_, i) => (i < 20 ? null : 50 + Math.sin(i / 5) * 30))}
        sar={c.map((x) => x.low - 0.1)}
        sarBelow={c.map(() => true)}
        sarStyle="both"
        indicatorsLocked
      />,
    );
    expect(screen.getByTestId("chart-toggle-rsi")).toBeTruthy();
    expect(screen.getByTestId("chart-toggle-sarDots")).toBeTruthy();
    expect(screen.getByTestId("chart-toggle-sarCloud")).toBeTruthy();
    expect(screen.getByTestId("chart-rsi")).toBeTruthy();
  });
});

const quotes = (n: number): QuoteCandle[] =>
  walk(n).map((c) => {
    const iso = new Date(Date.parse(c.datetime.replace(" ", "T") + "Z")).toISOString();
    const side = (d: number) => ({ datetime: iso, open: c.open + d, high: c.high + d, low: c.low + d, close: c.close + d });
    return { datetime: iso, bid: side(-0.002), ask: side(0.002) };
  });

describe("#140 the live chart without the indicators", () => {
  afterEach(() => {
    localStorage.clear();
    resetChartPrefsCache();
  });

  const NOW = T0 + 259 * M15 + 60_000;
  const readFor = (pair: string, interval: string): LiveRead => {
    const r = normalizeLiveRead(liveRead(pair, interval, quotes(260), NOW))!;
    return { ...r, pair, interval, nextClose: new Date(Date.now() + 600_000).toISOString() };
  };

  it("reads neither Dow theory nor the history, and passes a tap on a lock on", async () => {
    localStorage.setItem(CHART_PREFS_KEY, JSON.stringify(ALL_ON));
    const loadBars = vi.fn(async (pair: string, interval: string) => readFor(pair, interval));
    const loadHistory = vi.fn(async () => []);
    const loadDow = vi.fn(async () => []);
    const onLocked = vi.fn();
    render(
      <LiveChart
        defaultInterval="15min"
        loadBars={loadBars}
        loadTicks={async () => ({})}
        loadHistory={loadHistory}
        loadDow={loadDow}
        indicatorsAllowed={false}
        onLockedIndicator={onLocked}
      />,
    );
    await waitFor(() => expect(screen.getByTestId("live-signals")).toBeTruthy());
    expect(loadDow).not.toHaveBeenCalled();
    expect(loadHistory).not.toHaveBeenCalled();
    expect(screen.queryByTestId("live-dow")).toBeNull();
    fireEvent.click(screen.getByTestId("chart-lock-dow"));
    expect(onLocked).toHaveBeenCalledTimes(1);
  });

  it("with them, reads both as before", async () => {
    localStorage.setItem(CHART_PREFS_KEY, JSON.stringify(ALL_ON));
    const loadHistory = vi.fn(async () => []);
    const loadDow = vi.fn(async () => []);
    render(
      <LiveChart
        defaultInterval="15min"
        loadBars={async (pair: string, interval: string) => readFor(pair, interval)}
        loadTicks={async () => ({})}
        loadHistory={loadHistory}
        loadDow={loadDow}
      />,
    );
    await waitFor(() => expect(loadDow).toHaveBeenCalledWith("USD/JPY"));
    await waitFor(() => expect(loadHistory).toHaveBeenCalledWith("USD/JPY", "15min"));
  });
});
