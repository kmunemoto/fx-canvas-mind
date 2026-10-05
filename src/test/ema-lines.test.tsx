import { describe, it, expect, vi, afterEach } from "vitest";
import { render as rtlRender, screen, fireEvent, waitFor, within, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";
import { LocaleProvider } from "@/lib/i18n";

vi.mock("@/lib/supabase", () => ({ supabase: {} }));

import PriceChart from "../components/PriceChart";
import LiveChart from "../components/LiveChart";
import { CHART_PREFS_KEY, chartPrefsFrom, getChartPrefs, resetChartPrefsCache, setChartPrefs } from "../lib/chartPrefs";
import { MA_DEEP_FROM, MA_DEFAULTS, MA_MAX, MA_SLOTS, crossPair, emaLine, maNeedsDeep, maShortfall, maValues, measuredMa, normalizeMaLines } from "../lib/emaLines";
import { sma } from "../lib/zoneShift";
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

// the y of each point of a path, in order (and the x)
const ys = (d: string) => [...d.matchAll(/[ML][\d.]+,([\d.]+)/g)].map((m) => Number(m[1]));
const xs = (d: string) => [...d.matchAll(/[ML]([\d.]+),[\d.]+/g)].map((m) => Number(m[1]));

describe("#143 the EMA lines", () => {
  it("are TradingView's EMA — the average of the first n closes, then 2 / (n + 1) of each — as #142 measured it", () => {
    const closes = walk(400).map((c) => c.close);
    for (const { period: length } of MA_DEFAULTS) {
      const mine = emaLine(closes, length);
      const study = emaSeries(closes, length);
      expect(mine[length - 2]).toBeNull();
      expect(mine[length - 1]).toBeCloseTo(closes.slice(0, length).reduce((a, b) => a + b, 0) / length, 12);
      mine.forEach((v, i) => (v === null ? expect(study[i]).toBeNull() : expect(v).toBeCloseTo(study[i] as number, 12)));
    }
    // #200: three lines, EMA 50, 200 and 20 until set otherwise
    expect(MA_DEFAULTS.map((l) => `${l.type} ${l.period}`)).toEqual(["EMA 50", "EMA 200", "EMA 20"]);
  });

  it("are on unless switched off, each listed with its line's colour, and switched off one by one", () => {
    expect(getChartPrefs().overlays.ema50).toBe(true);
    expect(getChartPrefs().overlays.ema200).toBe(true);
    expect(getChartPrefs().overlays.ma3).toBe(true);
    render(<PriceChart candles={walk(300)} pair="USD/JPY" />);
    expect(screen.getByTestId("chart-overlay-name-ema50").textContent).toBe("EMA 50");
    expect(screen.getByTestId("chart-overlay-name-ema200").textContent).toBe("EMA 200");
    expect(screen.getByTestId("chart-overlay-name-ma3").textContent).toBe("EMA 20");
    expect(screen.getByTestId("chart-ma3-line").getAttribute("stroke")).toBe("#00BCD4");
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
    fireEvent.click(screen.getByTestId("chart-toggle-ma3"));
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
    localStorage.setItem(CHART_PREFS_KEY, JSON.stringify({ overlays: { zoneShift: false, gainzPro: false, ema50: false, ema200: true, ma3: false } }));
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
    // #200: the third too, and no gear for their numbers while locked
    expect(screen.getByTestId("chart-lock-ma3")).toBeTruthy();
    for (const k of ["ema50", "ema200", "ma3"]) expect(screen.queryByTestId(`chart-settings-${k}`)).toBeNull();
    expect(screen.queryByTestId("chart-ema")).toBeNull();
  });
});

// #200: the owner's 「移動平均線を設定できる様にして 数字選んで」「3つほしい」
describe("#200 three moving averages, each at the number chosen", () => {
  afterEach(() => {
    localStorage.clear();
    resetChartPrefsCache();
  });
  const SMA25 = { period: 25, type: "SMA" as const };

  it("keep each line's number (a whole number from 1 to 500) and kind; anything else is that line's default", () => {
    expect(normalizeMaLines(undefined)).toEqual(MA_DEFAULTS);
    expect(normalizeMaLines([SMA25])).toEqual([SMA25, MA_DEFAULTS[1], MA_DEFAULTS[2]]);
    expect(normalizeMaLines([{ period: 0, type: "EMA" }, { period: MA_MAX + 1, type: "WMA" }, { period: 2.5 }])).toEqual(MA_DEFAULTS);
    expect(normalizeMaLines([{ period: "50" }, null, { period: MA_MAX, type: "SMA" }])).toEqual([MA_DEFAULTS[0], MA_DEFAULTS[1], { period: MA_MAX, type: "SMA" }]);
    // what was saved before #200 (no numbers, no third switch): the three
    // defaults, the third on, the other switches as they were
    const old = chartPrefsFrom({ overlays: { ema50: true, ema200: false } });
    expect(old.maLines).toEqual(MA_DEFAULTS);
    expect(old.overlays).toMatchObject({ ema50: true, ema200: false, ma3: true });
    // kept in this browser (and so with the account, #141) and read back
    const chosen = [SMA25, { period: 75, type: "SMA" as const }, { period: 5, type: "EMA" as const }];
    setChartPrefs({ maLines: chosen });
    expect(JSON.parse(localStorage.getItem(CHART_PREFS_KEY)!).maLines).toEqual(chosen);
    resetChartPrefsCache();
    expect(getChartPrefs().maLines).toEqual(chosen);
  });

  it("are TradingView's SMA (the mean of the last n closes) when SMA is chosen", () => {
    const closes = walk(120).map((c) => c.close);
    const mine = maValues(closes, SMA25);
    expect(mine[23]).toBeNull();
    expect(mine[24]).toBeCloseTo(closes.slice(0, 25).reduce((a, b) => a + b, 0) / 25, 12);
    expect(mine[119]).toBeCloseTo(closes.slice(95).reduce((a, b) => a + b, 0) / 25, 12);
    expect(maValues(closes, { period: 20, type: "EMA" })).toEqual(emaLine(closes, 20));
  });

  it("say which of them #142 measured: SMA 25, 75, 200 and EMA 50, 200 only", () => {
    for (const l of [SMA25, { period: 75, type: "SMA" }, { period: 200, type: "SMA" }, { period: 50, type: "EMA" }, { period: 200, type: "EMA" }] as const) expect(measuredMa(l)).toBe(true);
    for (const l of [{ period: 20, type: "EMA" }, { period: 50, type: "SMA" }, { period: 25, type: "EMA" }] as const) expect(measuredMa(l)).toBe(false);
  });

  it("from a line's gear: a number from the buttons or typed, EMA or SMA, each line on its own, the line drawn at it", () => {
    const candles = walk(300);
    const closes = candles.map((c) => c.close);
    render(<PriceChart candles={candles} pair="USD/JPY" />);
    expect(screen.queryByTestId("chart-ma-form")).toBeNull();
    for (const k of ["ema50", "ema200", "ma3"]) expect(screen.getByTestId(`chart-settings-${k}`)).toBeTruthy();
    fireEvent.click(screen.getByTestId("chart-settings-ma3"));
    expect(screen.getByTestId("chart-settings-ma3").getAttribute("aria-expanded")).toBe("true");
    const form = screen.getByTestId("chart-ma-form");
    expect(form.textContent).toContain("線1");
    expect(form.textContent).toContain("1〜500 の整数");
    // line 1: 25 from the buttons, then SMA
    fireEvent.click(screen.getByTestId("chart-ma-1-preset-25"));
    expect(screen.getByTestId("chart-ma-1-preset-25").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("chart-overlay-name-ema50").textContent).toBe("EMA 25");
    fireEvent.click(screen.getByTestId("chart-ma-1-type-SMA"));
    expect(screen.getByTestId("chart-overlay-name-ema50").textContent).toBe("SMA 25");
    expect(screen.getByTestId("chart-legend-ema50").textContent).toBe(`SMA 25 ${(maValues(closes, SMA25)[299] as number).toFixed(3)}`);
    // line 3: 13 typed (not a button); a number out of range is not taken
    fireEvent.change(screen.getByTestId("chart-ma-3-period"), { target: { value: "13" } });
    expect(screen.getByTestId("chart-overlay-name-ma3").textContent).toBe("EMA 13");
    expect(screen.getByTestId("chart-legend-ma3").textContent).toBe(`EMA 13 ${(emaLine(closes, 13)[299] as number).toFixed(3)}`);
    for (const v of ["0", "501", "2.5", ""]) {
      fireEvent.change(screen.getByTestId("chart-ma-3-period"), { target: { value: v } });
      expect(screen.getByTestId("chart-overlay-name-ma3").textContent).toBe("EMA 13");
    }
    // line 2 untouched; all kept
    expect(screen.getByTestId("chart-overlay-name-ema200").textContent).toBe("EMA 200");
    expect(JSON.parse(localStorage.getItem(CHART_PREFS_KEY)!).maLines).toEqual([SMA25, MA_DEFAULTS[1], { period: 13, type: "EMA" }]);
    // the note says what was not measured
    fireEvent.click(screen.getByTestId("chart-info-ema50"));
    expect(screen.getByTestId("chart-info-text-ema50").textContent).toContain("SMA 25（オレンジ）・EMA 200（紫）・EMA 13（水色）");
    expect(screen.getByTestId("chart-info-text-ema50").textContent).toContain("EMA 13 は測っていません");
    // and back to EMA 50, 200, 20
    fireEvent.click(screen.getByTestId("chart-ma-reset"));
    expect(MA_SLOTS.map((s) => screen.getByTestId(`chart-overlay-name-${s.key}`).textContent)).toEqual(["EMA 50", "EMA 200", "EMA 20"]);
  });

  it("the golden and dead crosses follow lines 1 and 2, the shorter as the fast one; none when they are the same line", () => {
    // down for 420 bars, then up: the short line crosses the long one from
    // below once, on the chart (its bars are 400 to 519)
    const bar = (i: number, p: number) => ({ datetime: stamp(i), open: p, high: p + 0.05, low: p - 0.05, close: p });
    const all = Array.from({ length: 520 }, (_, i) => bar(i, i < 420 ? 150 - i * 0.01 : 145.8 + (i - 420) * 0.03));
    const past = all.slice(0, 400);
    const shown = all.slice(400);
    localStorage.setItem(CHART_PREFS_KEY, JSON.stringify({ maLines: [{ period: 50, type: "EMA" }, { period: 20, type: "SMA" }, { period: 5, type: "EMA" }] }));
    expect(crossPair(getChartPrefs().maLines)).toEqual({ fast: { period: 20, type: "SMA" }, slow: { period: 50, type: "EMA" }, samePeriod: false });
    const { unmount } = render(<PriceChart candles={shown} pair="USD/JPY" zoneShiftHistory={{ bars: past, status: "ready" }} formingLast />);
    expect(screen.getByTestId("chart-overlay-name-maCross").textContent).toBe("GC・DC（SMA 20×EMA 50）");
    expect(screen.getByTestId("chart-macross-legend").textContent).toContain("短い方（SMA 20）が長い方（EMA 50）");
    // the crossing is where SMA 20 went above EMA 50
    const closes = all.map((c) => c.close);
    const f = maValues(closes, { period: 20, type: "SMA" });
    const s = maValues(closes, { period: 50, type: "EMA" });
    const at = f.findIndex((v, i) => i > 0 && v !== null && s[i] !== null && f[i - 1] !== null && s[i - 1] !== null && (f[i - 1] as number) <= (s[i - 1] as number) && v > (s[i] as number));
    expect(at).toBeGreaterThanOrEqual(420);
    expect(at).toBeLessThan(519);
    expect(screen.getAllByTestId("chart-macross-GC")).toHaveLength(1);
    expect(screen.getByTestId("chart-macross-GC").querySelector("title")!.textContent).toBe("ゴールデンクロス（SMA 20 が EMA 50 を上に抜けた）");
    // drawn on that bar, at the fast line (line 2, SMA 20): where both lines' paths have it
    const dot = screen.getByTestId("chart-macross-GC").querySelector("circle")!;
    const line2 = screen.getByTestId("chart-ema200-line").getAttribute("d")!;
    expect(xs(line2)).toHaveLength(120);
    expect(Number(dot.getAttribute("cx"))).toBeCloseTo(xs(line2)[at - 400], 1);
    expect(Number(dot.getAttribute("cy"))).toBeCloseTo(ys(line2)[at - 400], 1);
    expect(xs(screen.getByTestId("chart-ema50-line").getAttribute("d")!)[at - 400]).toBeCloseTo(xs(line2)[at - 400], 1);
    expect(screen.queryByTestId("chart-macross-DC")).toBeNull();
    unmount();
    // lines 1 and 2 the same: no crosses, and the note says why
    setChartPrefs({ maLines: [{ period: 50, type: "EMA" }, { period: 50, type: "EMA" }, MA_DEFAULTS[2]] });
    render(<PriceChart candles={shown} pair="USD/JPY" zoneShiftHistory={{ bars: past, status: "ready" }} formingLast />);
    expect(screen.queryByTestId("chart-macross-GC")).toBeNull();
    expect(screen.queryByTestId("chart-macross-DC")).toBeNull();
    expect(screen.getByTestId("chart-macross-legend").textContent).toContain("同じ移動平均なので、交差はありません");
  });

  it("of one length and two kinds, the EMA is the fast line whichever of lines 1 and 2 it is: the same marks either way", () => {
    // a wave: the EMA turns before the SMA of the same length, so they cross
    const bar = (i: number, p: number) => ({ datetime: stamp(i), open: p, high: p + 0.05, low: p - 0.05, close: p });
    const all = Array.from({ length: 520 }, (_, i) => bar(i, 150 + Math.sin(i / 12)));
    const past = all.slice(0, 400);
    const shown = all.slice(400);
    const EMA50 = { period: 50, type: "EMA" as const };
    const SMA50 = { period: 50, type: "SMA" as const };
    expect(crossPair([SMA50, EMA50, MA_DEFAULTS[2]])).toEqual({ fast: EMA50, slow: SMA50, samePeriod: true });
    expect(crossPair([EMA50, SMA50, MA_DEFAULTS[2]])).toEqual({ fast: EMA50, slow: SMA50, samePeriod: true });
    const closes = all.map((c) => c.close);
    const e = maValues(closes, EMA50);
    const m = maValues(closes, SMA50);
    const want: string[] = [];
    for (let i = 400; i < 519; i++) {
      const [a, b, pa, pb] = [e[i], m[i], e[i - 1], m[i - 1]] as number[];
      if (a > b && pa <= pb) want.push(`GC@${i - 400}`);
      else if (a < b && pa >= pb) want.push(`DC@${i - 400}`);
    }
    expect(want.length).toBeGreaterThanOrEqual(2);
    const marks = (lines: typeof MA_DEFAULTS) => {
      localStorage.clear();
      resetChartPrefsCache();
      setChartPrefs({ maLines: [...lines] });
      const { unmount } = render(<PriceChart candles={shown} pair="USD/JPY" zoneShiftHistory={{ bars: past, status: "ready" }} formingLast />);
      const got = ["GC", "DC"].flatMap((side) =>
        screen.queryAllByTestId(`chart-macross-${side}`).map((g) => ({ side, x: Number(g.querySelector("circle")!.getAttribute("cx")) })),
      );
      // each mark's bar, from the x of the EMA's own line
      const ema = screen.getByTestId(lines[0].type === "EMA" ? "chart-ema50-line" : "chart-ema200-line").getAttribute("d")!;
      // (the path's points are to a tenth of a pixel)
      const near = (x: number) => xs(ema).reduce((best, v, k, a) => (Math.abs(v - x) < Math.abs(a[best] - x) ? k : best), 0);
      for (const g of got) expect(Math.abs(xs(ema)[near(g.x)] - g.x)).toBeLessThan(0.06);
      const at = got.map((g) => `${g.side}@${near(g.x)}`).sort();
      const note = (fireEvent.click(screen.getByTestId("chart-info-maCross")), screen.getByTestId("chart-info-text-maCross").textContent!);
      unmount();
      return { at, note };
    };
    const a = marks([EMA50, SMA50, MA_DEFAULTS[2]]);
    const b = marks([SMA50, EMA50, MA_DEFAULTS[2]]);
    expect(a.at).toEqual([...want].sort());
    expect(b.at).toEqual(a.at);
    for (const { note } of [a, b]) {
      expect(note).toContain("先に動く EMA（EMA 50）を速い方、SMA 50 を遅い方");
      expect(note).not.toContain("短い方");
    }
  });

  it("a number can be cleared and typed again: the box shows what is typed, the line keeps its number until it is one", () => {
    render(<PriceChart candles={walk(300)} pair="USD/JPY" />);
    fireEvent.click(screen.getByTestId("chart-settings-ma3"));
    const box = screen.getByTestId("chart-ma-3-period") as HTMLInputElement;
    fireEvent.change(box, { target: { value: "" } });
    expect(box.value).toBe("");
    expect(box.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByTestId("chart-overlay-name-ma3").textContent).toBe("EMA 20");
    fireEvent.change(box, { target: { value: "3" } });
    expect(box.value).toBe("3");
    expect(screen.getByTestId("chart-overlay-name-ma3").textContent).toBe("EMA 3");
    fireEvent.change(box, { target: { value: "35" } });
    expect(box.getAttribute("aria-invalid")).toBe("false");
    expect(screen.getByTestId("chart-overlay-name-ma3").textContent).toBe("EMA 35");
    // out of range: shown as typed, not taken, and the saved number back on leaving
    fireEvent.change(box, { target: { value: "501" } });
    expect(box.value).toBe("501");
    expect(box.getAttribute("aria-invalid")).toBe("true");
    expect(getChartPrefs().maLines[2]).toEqual({ period: 35, type: "EMA" });
    fireEvent.blur(box);
    expect(box.value).toBe("35");
  });

  it("the gear brings the numbers into view: the first number is focused, on the card and in full screen", () => {
    render(<PriceChart candles={walk(120)} pair="USD/JPY" />);
    fireEvent.click(screen.getByTestId("chart-settings-ema200"));
    expect(document.activeElement).toBe(screen.getByTestId("chart-ma-1-period"));
    // pressed again: closed
    fireEvent.click(screen.getByTestId("chart-settings-ema200"));
    expect(screen.queryByTestId("chart-ma-form")).toBeNull();
    fireEvent.click(screen.getByTestId("chart-fullscreen"));
    const overlay = screen.getByTestId("chart-fullscreen-overlay");
    fireEvent.click(within(overlay).getByTestId("chart-sheet-settings-open"));
    (document.activeElement as HTMLElement | null)?.blur();
    const gear = within(overlay).getByTestId("chart-settings-ma3");
    // the form is always in the sheet: no open or closed to say
    expect(gear.getAttribute("aria-expanded")).toBeNull();
    fireEvent.click(gear);
    expect(document.activeElement).toBe(within(overlay).getByTestId("chart-ma-1-period"));
  });

  it("locked: no numbers in full screen's sheet either, and the note does not point to a gear that is not there", () => {
    render(<PriceChart candles={walk(300)} pair="USD/JPY" indicatorsLocked />);
    fireEvent.click(screen.getByTestId("chart-fullscreen"));
    const overlay = screen.getByTestId("chart-fullscreen-overlay");
    fireEvent.click(within(overlay).getByTestId("chart-sheet-settings-open"));
    expect(within(overlay).queryByTestId("chart-ma-form")).toBeNull();
    expect(within(overlay).getByTestId("chart-sheet-lock-ma3")).toBeTruthy();
    fireEvent.click(within(overlay).getByTestId("chart-info-ma3"));
    const note = within(overlay).getByTestId("chart-info-text-ma3").textContent!;
    expect(note).toContain("インジケーターを使えるプランで各線の ⚙ から選べます");
    expect(note).not.toContain("各線の ⚙ で選べます");
  });

  it("locked: switching a free item keeps the indicators saved on (they come back with a plan)", () => {
    localStorage.setItem(CHART_PREFS_KEY, JSON.stringify({ overlays: { ema50: true, ema200: true, ma3: true, maCross: true, sarDots: true } }));
    const candles = walk(300);
    render(<PriceChart candles={candles} pair="USD/JPY" sar={candles.map((c) => c.low - 0.1)} sarBelow={candles.map(() => true)} indicatorsLocked />);
    fireEvent.click(screen.getByTestId("chart-toggle-sarDots"));
    const saved = JSON.parse(localStorage.getItem(CHART_PREFS_KEY)!).overlays;
    expect(saved.sarDots).toBe(false);
    expect(saved).toMatchObject({ ema50: true, ema200: true, ma3: true, maCross: true });
  });

  it("a line longer than MA_DEEP_FROM needs the deep history (as do the crosses of one); the defaults do not", () => {
    const on = { ema50: true, ema200: true, ma3: true, maCross: true };
    expect(maNeedsDeep(on, MA_DEFAULTS)).toBe(false);
    expect(maNeedsDeep(on, [MA_DEFAULTS[0], MA_DEFAULTS[1], { period: MA_DEEP_FROM + 1, type: "SMA" }])).toBe(true);
    expect(maNeedsDeep({ ...on, ma3: false }, [MA_DEFAULTS[0], MA_DEFAULTS[1], { period: 300, type: "SMA" }])).toBe(false);
    // lines 1 and 2 off, their crosses on
    expect(maNeedsDeep({ maCross: true }, [MA_DEFAULTS[0], { period: 300, type: "EMA" }, MA_DEFAULTS[2]])).toBe(true);
    expect(maNeedsDeep({}, [MA_DEFAULTS[0], { period: 300, type: "EMA" }, MA_DEFAULTS[2]])).toBe(false);
  });

  it("says what a line cannot do with the bars there are: none, starting within the chart, or not yet TradingView's", () => {
    expect(maShortfall({ period: 200, type: "EMA" }, 0, 120)).toBe("none");
    expect(maShortfall({ period: 150, type: "SMA" }, 100, 220)).toBe("late");
    // EMA 300 over the 601 bars every chart reads: its start still ~13% of it
    expect(maShortfall({ period: 300, type: "EMA" }, 480, 601)).toBe("rough");
    expect(maShortfall({ period: 300, type: "SMA" }, 480, 601)).toBeNull();
    // the first defaults over the same bars: nothing to say
    for (const l of MA_DEFAULTS) expect(maShortfall(l, 480, 601)).toBeNull();
    // on the chart, in the note
    setChartPrefs({ maLines: [{ period: 150, type: "SMA" }, MA_DEFAULTS[1], { period: 300, type: "EMA" }] });
    const all = walk(220);
    render(<PriceChart candles={all.slice(100)} pair="USD/JPY" zoneShiftHistory={{ bars: all.slice(0, 100), status: "ready" }} />);
    fireEvent.click(screen.getByTestId("chart-info-ema50"));
    const note = screen.getByTestId("chart-info-text-ema50").textContent!;
    expect(note).toContain("SMA 150は画面より前の足が足りないため、画面の途中から引いています。");
    expect(note).toContain("EMA 200は画面より前の足が足りないため、画面の途中から引いています。");
    expect(note).toContain("EMA 300は300本の足が要りますが、計算に使えた足が220本のため引けません。");
    expect(screen.queryByTestId("chart-ma3-line")).toBeNull();
  });

  it("the live chart reads the bars before its own with the third line alone on (none with it off too)", async () => {
    const off = { zoneShift: false, gainzPro: false, ema50: false, ema200: false, qTrend: false, qtBlsh: false, autoTrend: false, maCross: false, ichimoku: false, ultra: false, zlTema: false };
    const NOW = T0 + 259 * M15 + 60_000;
    const readFor = (pair: string, interval: string): LiveRead => {
      const r = normalizeLiveRead(liveRead(pair, interval, quotes(260), NOW))!;
      return { ...r, pair, interval, nextClose: new Date(Date.now() + 600_000).toISOString() };
    };
    for (const ma3 of [true, false]) {
      localStorage.clear();
      resetChartPrefsCache();
      localStorage.setItem(CHART_PREFS_KEY, JSON.stringify({ overlays: { ...off, ma3 }, blsh: false, macd: false, adx: false }));
      const loadBars = vi.fn(async (pair: string, interval: string) => readFor(pair, interval));
      const loadHistory = vi.fn(async (): Promise<NumericCandle[]> => []);
      const { unmount } = render(
        <LiveChart defaultInterval="15min" loadBars={loadBars} loadTicks={async () => ({})} loadHistory={loadHistory} loadDow={async () => []} indicatorsAllowed />,
      );
      await waitFor(() => expect(loadBars).toHaveBeenCalled());
      if (ma3) await waitFor(() => expect(loadHistory).toHaveBeenCalledWith("USD/JPY", "15min"));
      else {
        await new Promise((r) => setTimeout(r, 50));
        expect(loadHistory).not.toHaveBeenCalled();
      }
      unmount();
    }
  });

  it("the live chart reads the deep history while a line longer than MA_DEEP_FROM is on, and the line is computed over it", async () => {
    const NOW = T0 + 259 * M15 + 60_000;
    const readFor = (pair: string, interval: string): LiveRead => {
      const r = normalizeLiveRead(liveRead(pair, interval, quotes(260), NOW))!;
      return { ...r, pair, interval, nextClose: new Date(Date.now() + 600_000).toISOString() };
    };
    for (const period of [MA_DEEP_FROM, MA_DEEP_FROM + 100]) {
      localStorage.clear();
      resetChartPrefsCache();
      localStorage.setItem(CHART_PREFS_KEY, JSON.stringify({ maLines: [MA_DEFAULTS[0], MA_DEFAULTS[1], { period, type: "SMA" }] }));
      const loadBars = vi.fn(async (pair: string, interval: string) => readFor(pair, interval));
      const loadDeepHistory = vi.fn(async () => ({ bars: [] as NumericCandle[], complete: true }));
      const { unmount } = render(
        <LiveChart defaultInterval="15min" loadBars={loadBars} loadTicks={async () => ({})} loadHistory={async () => []} loadDeepHistory={loadDeepHistory} loadDow={async () => []} indicatorsAllowed />,
      );
      await waitFor(() => expect(loadBars).toHaveBeenCalled());
      if (period > MA_DEEP_FROM) await waitFor(() => expect(loadDeepHistory).toHaveBeenCalledWith("USD/JPY", "15min"));
      else {
        await new Promise((r) => setTimeout(r, 50));
        expect(loadDeepHistory).not.toHaveBeenCalled();
      }
      unmount();
    }
  });

  it("over the deep history once it is there; the history every chart reads meanwhile, and the note says which", () => {
    setChartPrefs({ maLines: [MA_DEFAULTS[0], MA_DEFAULTS[1], { period: 300, type: "EMA" }] });
    const all = walk(1400);
    const shown = all.slice(1280);
    const common = all.slice(800, 1280);
    const deep = all.slice(0, 1280);
    const { rerender } = render(
      <PriceChart candles={shown} pair="USD/JPY" zoneShiftHistory={{ bars: common, status: "ready" }} deepHistory={{ bars: null, status: "loading" }} />,
    );
    fireEvent.click(screen.getByTestId("chart-info-ma3"));
    let note = screen.getByTestId("chart-info-text-ma3").textContent!;
    expect(note).toContain("画面より前の足を深く読み込み中です");
    expect(note).toContain("計算に使った足: 600本");
    expect(note).toContain("EMA 300は計算に使えた足が少ないため、TradingView の値と少しずれることがあります。");
    const closes = (bars: ReadonlyArray<{ close: number }>) => [...bars, ...shown].map((c) => c.close);
    const legend = () => Number(screen.getByTestId("chart-legend-ma3").textContent!.split(" ").pop());
    expect(legend()).toBeCloseTo(maValues(closes(common), { period: 300, type: "EMA" }).at(-1) as number, 3);
    rerender(
      <LocaleProvider initial="ja">
        <PriceChart candles={shown} pair="USD/JPY" zoneShiftHistory={{ bars: common, status: "ready" }} deepHistory={{ bars: deep, status: "ready" }} />
      </LocaleProvider>,
    );
    note = screen.getByTestId("chart-info-text-ma3").textContent!;
    expect(note).toContain("計算に使った足: 1400本");
    expect(note).not.toContain("少しずれる");
    expect(note).not.toContain("深く読み込み中");
    expect(legend()).toBeCloseTo(maValues(closes(deep), { period: 300, type: "EMA" }).at(-1) as number, 3);
    // and the deep read failed: drawn over the common one, said so
    rerender(
      <LocaleProvider initial="ja">
        <PriceChart candles={shown} pair="USD/JPY" zoneShiftHistory={{ bars: common, status: "ready" }} deepHistory={{ bars: null, status: "error" }} />
      </LocaleProvider>,
    );
    expect(screen.getByTestId("chart-info-text-ma3").textContent).toContain("深く読めなかったため、ふだん読む足で引いています");
  });

  it("in full screen, the numbers are in the settings sheet", () => {
    render(<PriceChart candles={walk(120)} pair="USD/JPY" />);
    fireEvent.click(screen.getByTestId("chart-fullscreen"));
    const overlay = screen.getByTestId("chart-fullscreen-overlay");
    fireEvent.click(within(overlay).getByTestId("chart-sheet-settings-open"));
    fireEvent.click(within(overlay).getByTestId("chart-ma-2-preset-100"));
    expect(getChartPrefs().maLines[1]).toEqual({ period: 100, type: "EMA" });
    expect(within(overlay).getByTestId("chart-overlay-name-ema200").textContent).toBe("EMA 100");
  });
});
