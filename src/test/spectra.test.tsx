import { describe, it, expect, afterEach } from "vitest";
import { render as rtlRender, screen, fireEvent, within, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";
import { LocaleProvider } from "@/lib/i18n";
import PriceChart from "../components/PriceChart";
import { CHART_PREFS_KEY, resetChartPrefsCache } from "../lib/chartPrefs";
import { KST_DEFAULTS, kalman, kalmanSupertrend, wilderRsi } from "../lib/kalmanSupertrend";
import { wilderRsi as serverRsi } from "../../supabase/functions/analyze/rsisar";
import type { ChartSignalMark } from "../lib/types";

const render = (ui: ReactElement): RenderResult => rtlRender(<LocaleProvider initial="ja">{ui}</LocaleProvider>);

const walk = (n: number, seed = 5) => {
  let s = seed;
  const rnd = () => {
    s = (s + 0x6d2b79f5) | 0;
    let x = Math.imul(s ^ (s >>> 15), 1 | s);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
  let p = 150;
  return Array.from({ length: n }, (_, i) => {
    const o = p;
    p = o + (rnd() - 0.5) * 0.3;
    return {
      datetime: new Date(Date.parse("2026-09-01T00:00:00Z") + i * 3_600_000).toISOString().slice(0, 19).replace("T", " "),
      open: o,
      high: Math.max(o, p) + 0.01 + rnd() * 0.05,
      low: Math.min(o, p) - 0.01 - rnd() * 0.05,
      close: p,
    };
  });
};

// down for 40 bars, then up for 40: one turn up, where RSI is well above 50
const vee = () =>
  Array.from({ length: 80 }, (_, i) => {
    const mid = i < 40 ? 150 - i * 0.1 : 146 + (i - 40) * 0.1;
    const o = i < 40 ? mid + 0.05 : mid - 0.05;
    const c = i < 40 ? mid - 0.05 : mid + 0.05;
    return { datetime: `2026-09-0${1 + Math.floor(i / 24)} ${String(i % 24).padStart(2, "0")}:00:00`, open: o, high: Math.max(o, c) + 0.02, low: Math.min(o, c) - 0.02, close: c };
  });

describe("#119 the SPECTRA-style line (Kalman-smoothed Supertrend with an RSI filter)", () => {
  it("smooths as a Kalman filter whose gain settles where Q/R puts it (0.01/0.1: about 0.27, a 6-bar EMA)", () => {
    const xs = kalman([0, ...Array.from({ length: 60 }, () => 1)], KST_DEFAULTS.q, KST_DEFAULTS.r);
    // once settled, what is left of the gap shrinks by 1 − K a bar
    const ratio = (1 - xs[60]) / (1 - xs[59]);
    const s = (0.01 + Math.sqrt(0.01 ** 2 + 4 * 0.01 * 0.1)) / 2;
    expect(1 - ratio).toBeCloseTo(s / (s + 0.1), 6);
    expect(1 - ratio).toBeCloseTo(0.27, 2);
  });

  it("reads RSI as the server's Wilder RSI does", () => {
    const closes = walk(200).map((c) => c.close);
    const mine = wilderRsi(closes, 14);
    const theirs = serverRsi(closes, 14).rsi;
    mine.forEach((v, i) => (v === null ? expect(theirs[i]).toBeNull() : expect(v).toBeCloseTo(theirs[i] as number, 9)));
  });

  it("turns up once after a fall and a rise, and keeps its line under price while up", () => {
    const bars = vee();
    const r = kalmanSupertrend(bars);
    const ups = r.flips.filter((f) => f.side === "BUY");
    expect(ups).toHaveLength(1);
    expect(ups[0].i).toBeGreaterThan(40);
    // it turns a few bars into the rise, while RSI (Wilder's, slow to
    // forget 40 falling bars) is still under 50: the filter holds it back
    expect(ups[0].rsi as number).toBeLessThan(50);
    expect(ups[0].passed).toBe(false);
    // the first bars are the ATR still filling: not drawn
    expect(r.line.slice(0, KST_DEFAULTS.atrLength).every((v) => v === null)).toBe(true);
    for (let i = ups[0].i; i < bars.length; i++) {
      expect(r.trend[i]).toBe(1);
      expect(r.line[i] as number).toBeLessThan(bars[i].close);
    }
  });

  it("marks a turn only when RSI is on its side of 50", () => {
    // a random walk's turns come after moves RSI agrees with; the V's turn
    // up comes before RSI has left 40 falling bars behind
    const flips = [...kalmanSupertrend(walk(600, 9)).flips, ...kalmanSupertrend(vee()).flips];
    expect(flips.length).toBeGreaterThan(5);
    for (const f of flips) expect(f.passed).toBe(f.rsi !== null && (f.side === "BUY" ? f.rsi > 50 : f.rsi < 50));
    expect(flips.some((f) => f.passed)).toBe(true);
    expect(flips.some((f) => !f.passed)).toBe(true);
  });

  it("marks no turn on a bar still forming", () => {
    const bars = vee();
    const turn = kalmanSupertrend(bars).flips.find((f) => f.side === "BUY")!.i;
    const cut = bars.slice(0, turn + 1);
    expect(kalmanSupertrend(cut).flips.some((f) => f.i === turn)).toBe(true);
    expect(kalmanSupertrend(cut, KST_DEFAULTS, turn - 1).flips.some((f) => f.i === turn)).toBe(false);
  });
});

describe("#119 switching what the chart draws, from the list at its top left", () => {
  afterEach(() => {
    localStorage.clear();
    resetChartPrefsCache();
    document.body.style.overflow = "";
  });

  const c = walk(120);
  const sar = c.map((_, i) => (i < 2 ? null : i % 9 < 5 ? c[i].low - 0.1 : c[i].high + 0.1));
  const sarBelow = c.map((_, i) => (i < 2 ? null : i % 9 < 5));
  const mark = (i: number, side: "BUY" | "SELL", outcome: ChartSignalMark["outcome"]): ChartSignalMark => ({
    datetime: c[i].datetime, barsAgo: 119 - i, side, rule: "gainz", level: null,
    entry: c[i].close, stop: c[i].close - (side === "BUY" ? 0.2 : -0.2), target: c[i].close + (side === "BUY" ? 0.4 : -0.4),
    stop_atr: 1, outcome, bars: outcome === "open" ? null : 5, mfe_r: null,
  });
  const chart = () => (
    <PriceChart candles={c} pair="USD/JPY" marks={[mark(60, "BUY", "win"), mark(100, "SELL", "loss")]} sar={sar} sarBelow={sarBelow} sarStyle="both" positions />
  );

  it("lists only what this chart draws, the SPECTRA-style line off until switched on", () => {
    render(chart());
    const names = [...screen.getByTestId("chart-overlay-list").querySelectorAll("[data-testid^='chart-overlay-name-']")].map((e) => e.textContent);
    expect(names).toEqual(["売買サイン", "建玉の箱", "SAR の帯", "パラボリックSAR", "SPECTRA型 10 3", "ストキャス 14 1 3"]);
    expect(screen.getByTestId("chart-toggle-kalman").getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByTestId("chart-kalman")).toBeNull();

    fireEvent.click(screen.getByTestId("chart-toggle-kalman"));
    expect(screen.getByTestId("chart-kalman").querySelectorAll("[data-testid='chart-kalman-line']").length).toBeGreaterThan(0);
    expect(screen.getByTestId("chart-kalman-cloud")).toBeTruthy();
    expect(screen.getByTestId("chart-kalman-legend").textContent).toContain("ランダムに入った場合と差がありませんでした");
    expect(JSON.parse(localStorage.getItem(CHART_PREFS_KEY)!).overlays.kalman).toBe(true);
  });

  it("hides and shows the signals, the position boxes, the SAR band and the SAR dots one by one", () => {
    render(chart());
    const count = (prefix: string) => document.querySelectorAll(`g[data-testid^='${prefix}']`).length;
    const labels = () => document.querySelectorAll("g[data-rule]").length;
    expect(labels()).toBe(2);
    fireEvent.click(screen.getByTestId("chart-toggle-signals"));
    expect(labels()).toBe(0);
    expect(screen.getByTestId("chart-overlay-name-signals").className).toContain("line-through");

    expect(count("chart-position-")).toBe(2);
    fireEvent.click(screen.getByTestId("chart-toggle-positions"));
    expect(count("chart-position-")).toBe(0);
    expect(document.querySelectorAll("[data-testid='chart-signal-line']").length).toBe(0);

    expect(screen.getByTestId("chart-cloud")).toBeTruthy();
    fireEvent.click(screen.getByTestId("chart-toggle-sarCloud"));
    expect(screen.queryByTestId("chart-cloud")).toBeNull();

    expect(screen.getByTestId("chart-sar")).toBeTruthy();
    fireEvent.click(screen.getByTestId("chart-toggle-sarDots"));
    expect(screen.queryByTestId("chart-sar")).toBeNull();

    fireEvent.click(screen.getByTestId("chart-toggle-signals"));
    expect(labels()).toBe(2);
  });

  it("folds the list to one button that says how many are on", () => {
    render(chart());
    fireEvent.click(screen.getByTestId("chart-overlay-fold"));
    expect(screen.queryByTestId("chart-overlay-name-signals")).toBeNull();
    expect(screen.getByTestId("chart-overlay-fold").textContent).toBe("インジケーター 5/6");
    fireEvent.click(screen.getByTestId("chart-overlay-fold"));
    expect(screen.getByTestId("chart-overlay-name-signals")).toBeTruthy();
  });

  it("offers the same switches in full screen's settings sheet", () => {
    render(chart());
    fireEvent.click(screen.getByTestId("chart-fullscreen"));
    const overlay = screen.getByTestId("chart-fullscreen-overlay");
    fireEvent.click(within(overlay).getByTestId("chart-sheet-settings-open"));
    fireEvent.click(within(overlay).getByTestId("chart-sheet-kalman"));
    expect(within(overlay).getByTestId("chart-kalman")).toBeTruthy();
    expect(within(overlay).getByTestId("chart-sheet-kalman").getAttribute("aria-pressed")).toBe("true");
    // the list is on the chart in full screen too
    expect(within(overlay).getByTestId("chart-toggle-kalman").getAttribute("aria-pressed")).toBe("true");
  });
});
