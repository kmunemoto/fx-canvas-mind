import { describe, it, expect, afterEach, vi } from "vitest";
import { render as rtlRender, screen, fireEvent, waitFor, act, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";
import { LocaleProvider } from "@/lib/i18n";

vi.mock("@/lib/supabase", () => ({ supabase: {} }));

import PriceChart from "../components/PriceChart";
import LiveChart from "../components/LiveChart";
import { ZLT_ROUGH_BARS, ZLT_SETTLE_BARS, zlTemaCrosses } from "../lib/zlTema";
import { CHART_PREFS_KEY, resetChartPrefsCache } from "../lib/chartPrefs";
import { normalizeLiveRead, type LiveRead } from "../lib/liveChart";
import { liveRead } from "../../supabase/functions/live-chart/logic";
import type { QuoteCandle } from "../../supabase/functions/track-outcomes/quotes";

const render = (ui: ReactElement): RenderResult => rtlRender(<LocaleProvider initial="ja">{ui}</LocaleProvider>);

const M15 = 15 * 60_000;
const T0 = Date.parse("2026-08-01T00:00:00Z");
const stamp = (i: number) => new Date(T0 + i * M15).toISOString().slice(0, 19).replace("T", " ");
const walk = (n: number, seed = 23) => {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  let p = 150;
  return Array.from({ length: n }, (_, i) => {
    const open = p;
    p += (rnd() - 0.5) * 0.3;
    return { datetime: stamp(i), open, close: p, high: Math.max(open, p) + rnd() * 0.08, low: Math.min(open, p) - rnd() * 0.08 };
  });
};

const UP = "#2DD204";
const DOWN = "#D2042D";

afterEach(() => {
  localStorage.clear();
  resetChartPrefsCache();
});

describe("#176 the Zero-lag TEMA on the chart", () => {
  const all = walk(1450);
  const past = all.slice(0, 1330);
  const shown = all.slice(1330);

  it("is listed off; on, two lines, an L/S on every crossing on screen, the candles in its colours, and its note", () => {
    render(<PriceChart candles={shown} pair="USD/JPY" interactive={false} deepHistory={{ bars: past, status: "ready" }} />);
    expect(screen.getByTestId("chart-overlay-name-zlTema").textContent).toBe("Zero-lag TEMA 22 144");
    expect(screen.getByTestId("chart-toggle-zlTema").getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByTestId("chart-zltema")).toBeNull();
    fireEvent.click(screen.getByTestId("chart-toggle-zlTema"));
    expect(JSON.parse(localStorage.getItem(CHART_PREFS_KEY)!).overlays.zlTema).toBe(true);
    expect(screen.getByTestId("chart-zltema-slow").getAttribute("d")).toBeTruthy();
    expect(screen.queryByTestId("chart-zltema-fast-up") ?? screen.queryByTestId("chart-zltema-fast-down")).not.toBeNull();
    // the same crossings as the computation over the history and the candles
    const r = zlTemaCrosses(all.map((b) => b.close));
    const onChart = r.signals.filter((sg) => sg.i >= past.length).map((sg) => sg.i - past.length);
    const ls = screen.queryAllByTestId("chart-zltema-signal-BUY");
    const ss = screen.queryAllByTestId("chart-zltema-signal-SELL");
    expect(ls.length + ss.length).toBe(onChart.length);
    expect(onChart.length).toBeGreaterThan(0);
    expect(ls.every((g) => g.querySelector("text")?.textContent === "L")).toBe(true);
    expect(ss.every((g) => g.querySelector("text")?.textContent === "S")).toBe(true);
    expect(ls.concat(ss).every((g) => g.querySelector("title")?.textContent?.startsWith("Zero-lag TEMA の"))).toBe(true);
    // every candle in its green or red, by the fast line against the slow one
    const fills = [...screen.getByTestId("chart-candles").querySelectorAll("rect")].map((x) => x.getAttribute("fill"));
    fills.forEach((f, k) => expect(f).toBe(r.fast[past.length + k] > r.slow[past.length + k] ? UP : DOWN));
    const note = screen.getByTestId("chart-zltema-legend").textContent!;
    expect(note).toContain("loxx");
    expect(note).toContain("画面より前の足: 1,330本");
    expect(note).not.toContain("しか読めなかった");
  });

  it("while the bars before the chart are loading, nothing yet, and says so", () => {
    localStorage.setItem(CHART_PREFS_KEY, JSON.stringify({ overlays: { zlTema: true } }));
    resetChartPrefsCache();
    render(<PriceChart candles={shown} pair="USD/JPY" interactive={false} deepHistory={{ bars: null, status: "loading" }} />);
    expect(screen.queryByTestId("chart-zltema")).toBeNull();
    expect(screen.queryByTestId("chart-zltema-signals")).toBeNull();
    expect(screen.getByTestId("chart-zltema-legend").textContent).toContain("読み込み中");
  });

  it("with fewer bars before the chart than the slow line needs, draws them and says how far they may be from TradingView's", () => {
    localStorage.setItem(CHART_PREFS_KEY, JSON.stringify({ overlays: { zlTema: true } }));
    resetChartPrefsCache();
    // under ZLT_ROUGH_BARS: far; from it to ZLT_SETTLE_BARS: a little
    for (const [n, says] of [[300, "大きく"], [ZLT_ROUGH_BARS - 1, "大きく"], [ZLT_ROUGH_BARS, "少し"], [800, "少し"]] as const) {
      const view = render(<PriceChart candles={shown} pair="USD/JPY" interactive={false} deepHistory={{ bars: past.slice(-n), status: "ready" }} />);
      expect(screen.getByTestId("chart-zltema-slow")).toBeTruthy();
      const note = screen.getByTestId("chart-zltema-legend").textContent!;
      expect(note).toContain(`画面より前の足が${n.toLocaleString("ja-JP")}本しか読めなかったため、遅い線と L・S が TradingView と${says}ずれることがあります`);
      expect(note).toContain(`約${ZLT_SETTLE_BARS.toLocaleString("ja-JP")}本で同じになります`);
      view.unmount();
    }
  });

  it("with none before the chart: no mark on its second candle, and it says the lines may be far from TradingView's", () => {
    localStorage.setItem(CHART_PREFS_KEY, JSON.stringify({ overlays: { zlTema: true } }));
    resetChartPrefsCache();
    for (const deepHistory of [{ bars: [], status: "ready" as const }, undefined]) {
      for (let k = 0; k < 4; k++) {
        const candles = walk(120, 101 + k);
        const view = render(<PriceChart candles={candles} pair="USD/JPY" interactive={false} deepHistory={deepHistory} />);
        // the marks are those of the candles' own crossings from the third on
        const want = zlTemaCrosses(candles.map((c) => c.close)).signals;
        expect(want.every((sg) => sg.i >= 2)).toBe(true);
        expect(screen.queryAllByTestId(/chart-zltema-signal-/)).toHaveLength(want.length);
        expect(screen.getByTestId("chart-zltema-legend").textContent).toContain("画面より前の足を1本も読めなかったため、遅い線と L・S が TradingView と大きくずれることがあります");
        view.unmount();
      }
    }
  });

  it("the forming candle is neither painted nor marked", () => {
    localStorage.setItem(CHART_PREFS_KEY, JSON.stringify({ overlays: { zlTema: true } }));
    resetChartPrefsCache();
    render(<PriceChart candles={shown} pair="USD/JPY" interactive={false} formingLast deepHistory={{ bars: past, status: "ready" }} />);
    const fills = [...screen.getByTestId("chart-candles").querySelectorAll("rect")].map((x) => x.getAttribute("fill"));
    expect([UP, DOWN]).not.toContain(fills[fills.length - 1]);
    const last = shown.length - 1;
    const marked = [...screen.queryAllByTestId(/chart-zltema-signal-/)].length;
    const r = zlTemaCrosses(all.map((b) => b.close), undefined, all.length - 2);
    expect(marked).toBe(r.signals.filter((sg) => sg.i >= past.length && sg.i - past.length < last).length);
  });

  it("is one of the indicators locked without a plan", () => {
    localStorage.setItem(CHART_PREFS_KEY, JSON.stringify({ overlays: { zlTema: true } }));
    resetChartPrefsCache();
    render(<PriceChart candles={shown} pair="USD/JPY" interactive={false} deepHistory={{ bars: past, status: "ready" }} indicatorsLocked />);
    expect(screen.queryByTestId("chart-zltema")).toBeNull();
    expect(screen.queryByTestId("chart-zltema-signals")).toBeNull();
    expect(screen.getByTestId("chart-lock-zlTema")).toBeTruthy();
    expect(screen.queryByTestId("chart-toggle-zlTema")).toBeNull();
  });
});

describe("#176 the live chart reads the deep history while the Zero-lag TEMA is on", () => {
  const quotes: QuoteCandle[] = walk(260).map((b) => ({
    datetime: new Date(Date.parse(b.datetime.replace(" ", "T") + "Z")).toISOString(),
    bid: { ...b, datetime: b.datetime },
    ask: { ...b, datetime: b.datetime, open: b.open + 0.004, high: b.high + 0.004, low: b.low + 0.004, close: b.close + 0.004 },
  }));
  const readFor = (pair: string, interval: string): LiveRead => {
    const r = normalizeLiveRead(liveRead(pair, interval, quotes, T0 + 259 * M15 + 60_000))!;
    return { ...r, pair, interval, nextClose: new Date(Date.now() + 600_000).toISOString() };
  };
  // closed bars up to the newest closed one, as the function's answer (it
  // overlaps the chart's own; those before the chart's first candle are used)
  const deepBars = walk(1500, 41).map((b, i) => ({ ...b, datetime: new Date(T0 + (i - 1500 + 259) * M15).toISOString().slice(0, 19).replace("T", " ") }));

  it("not while it is off", async () => {
    const loadBars = vi.fn(async (p: string, i: string) => readFor(p, i));
    const loadDeepHistory = vi.fn(async () => ({ bars: deepBars, complete: true }));
    render(<LiveChart defaultInterval="15min" loadBars={loadBars} loadTicks={async () => ({})} loadHistory={async () => []} loadDeepHistory={loadDeepHistory} loadDow={async () => []} />);
    await waitFor(() => expect(loadBars).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 50));
    expect(loadDeepHistory).not.toHaveBeenCalled();
  });

  it("asks again while the function's read stopped short, then draws", async () => {
    localStorage.setItem(CHART_PREFS_KEY, JSON.stringify({ overlays: { zlTema: true } }));
    resetChartPrefsCache();
    const loadBars = vi.fn(async (p: string, i: string) => readFor(p, i));
    const answers = [
      { bars: deepBars.slice(-400), complete: false },
      { bars: deepBars, complete: true },
    ];
    const loadDeepHistory = vi.fn(async () => answers.shift() ?? { bars: deepBars, complete: true });
    render(<LiveChart defaultInterval="15min" loadBars={loadBars} loadTicks={async () => ({})} loadHistory={async () => []} loadDeepHistory={loadDeepHistory} loadDow={async () => []} />);
    await waitFor(() => expect(loadDeepHistory).toHaveBeenCalledWith("USD/JPY", "15min"));
    // the first answer stopped short: still loading, nothing drawn
    expect(screen.queryByTestId("chart-zltema")).toBeNull();
    await waitFor(() => expect(loadDeepHistory).toHaveBeenCalledTimes(2), { timeout: 4_000 });
    await waitFor(() => expect(screen.getByTestId("chart-zltema-slow")).toBeTruthy());
    const note = screen.getByTestId("chart-zltema-legend").textContent!;
    const before = Number(/画面より前の足: ([\d,]+)本/.exec(note)![1].replace(/,/g, ""));
    expect(before).toBeGreaterThanOrEqual(ZLT_SETTLE_BARS);
    expect(note).not.toContain("しか読めなかった");
  });

  const on = () => {
    localStorage.setItem(CHART_PREFS_KEY, JSON.stringify({ overlays: { zlTema: true } }));
    resetChartPrefsCache();
  };
  type Deep = { bars: typeof deepBars; complete: boolean };

  it("turned off while reading, another pair looked at, back and on again: reads again and draws (not 'loading' for good)", async () => {
    on();
    const loadBars = vi.fn(async (p: string, i: string) => readFor(p, i));
    let first: ((v: Deep) => void) | null = null;
    const loadDeepHistory = vi.fn((): Promise<Deep> => {
      if (!first) return new Promise<Deep>((r) => (first = r));
      return Promise.resolve({ bars: deepBars, complete: true });
    });
    render(<LiveChart defaultInterval="15min" loadBars={loadBars} loadTicks={async () => ({})} loadHistory={async () => []} loadDeepHistory={loadDeepHistory} loadDow={async () => []} />);
    await waitFor(() => expect(loadDeepHistory).toHaveBeenCalledWith("USD/JPY", "15min"));
    fireEvent.click(screen.getByTestId("chart-toggle-zlTema"));
    fireEvent.click(screen.getByTestId("live-pair-EUR/JPY"));
    await waitFor(() => expect(loadBars).toHaveBeenCalledWith("EUR/JPY", "15min"));
    // the USD/JPY read ends while EUR/JPY is on screen
    await act(async () => {
      first!({ bars: deepBars, complete: true });
      await new Promise((r) => setTimeout(r, 20));
    });
    fireEvent.click(screen.getByTestId("live-pair-USD/JPY"));
    await waitFor(() => expect(loadBars).toHaveBeenLastCalledWith("USD/JPY", "15min"));
    fireEvent.click(screen.getByTestId("chart-toggle-zlTema"));
    await waitFor(() => expect(screen.getByTestId("chart-zltema-slow")).toBeTruthy());
    expect(loadDeepHistory).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("chart-zltema-legend").textContent).not.toContain("読み込み中");
  });

  it("asks no more once the indicator is turned off, or the chart is left", async () => {
    for (const leave of ["off", "unmount"] as const) {
      on();
      const loadDeepHistory = vi.fn(async (): Promise<Deep> => ({ bars: deepBars.slice(-400), complete: false }));
      const view = render(<LiveChart defaultInterval="15min" loadBars={async (p, i) => readFor(p, i)} loadTicks={async () => ({})} loadHistory={async () => []} loadDeepHistory={loadDeepHistory} loadDow={async () => []} />);
      await waitFor(() => expect(loadDeepHistory).toHaveBeenCalledTimes(1));
      if (leave === "off") fireEvent.click(screen.getByTestId("chart-toggle-zlTema"));
      else view.unmount();
      // it would have asked again at 1.5 s and 3 s
      await new Promise((r) => setTimeout(r, 3_500));
      expect(loadDeepHistory).toHaveBeenCalledTimes(1);
      view.unmount();
      localStorage.clear();
      resetChartPrefsCache();
    }
  }, 12_000);

  it("a read that stopped short is read again on the next bar, drawn meanwhile, and kept if that read fails", async () => {
    for (const third of ["whole", "fails"] as const) {
      on();
      // each read of the bars a new one, the next close half a second away:
      // the chart reads its bars again some 5 s on
      const loadBars = vi.fn(async (p: string, i: string) => ({ ...readFor(p, i), at: new Date().toISOString(), nextClose: new Date(Date.now() + 500).toISOString() }));
      let release: (() => void) | null = null;
      const answers: Array<Deep | Error | "wait"> = [{ bars: deepBars.slice(-400), complete: false }, new Error("feed_unavailable"), "wait"];
      const loadDeepHistory = vi.fn(async (): Promise<Deep> => {
        const a = answers.shift() ?? { bars: deepBars, complete: true };
        if (a === "wait") {
          await new Promise<void>((r) => (release = r));
          if (third === "fails") throw new Error("feed_unavailable");
          return { bars: deepBars, complete: true };
        }
        if (a instanceof Error) throw a;
        return a;
      });
      const view = render(<LiveChart defaultInterval="15min" loadBars={loadBars} loadTicks={async () => ({})} loadHistory={async () => []} loadDeepHistory={loadDeepHistory} loadDow={async () => []} />);
      // short, then a failure: what it had is drawn, and it says so
      await waitFor(() => expect(screen.getByTestId("chart-zltema-legend").textContent).toContain("しか読めなかった"), { timeout: 4_000 });
      expect(loadDeepHistory).toHaveBeenCalledTimes(2);
      // the next bar: asked again; meanwhile the short read is still drawn
      await waitFor(() => expect(loadDeepHistory).toHaveBeenCalledTimes(3), { timeout: 8_000 });
      expect(screen.getByTestId("chart-zltema-slow")).toBeTruthy();
      expect(screen.getByTestId("chart-zltema-legend").textContent).toContain("しか読めなかった");
      await act(async () => {
        release!();
        await new Promise((r) => setTimeout(r, 20));
      });
      if (third === "whole") {
        await waitFor(() => expect(screen.getByTestId("chart-zltema-legend").textContent).not.toContain("しか読めなかった"));
      } else {
        // it failed: the short read stays drawn (not "could not be read")
        expect(screen.getByTestId("chart-zltema-slow")).toBeTruthy();
        expect(screen.getByTestId("chart-zltema-legend").textContent).toContain("しか読めなかった");
      }
      view.unmount();
      localStorage.clear();
      resetChartPrefsCache();
    }
  }, 30_000);
});
