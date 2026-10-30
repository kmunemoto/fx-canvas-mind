// #387 (docs §8.130): the owner's video's EMA 20 / 200 way on the chart — the
// two EMAs, BUY under the entry bar (SELL over it), the diagonal and
// horizontal necklines, the return move, the boxes to the first target and
// the stop, and the setup still forming with what it waits for — drawn from
// the same code the 15-minute email decides with
// (supabase/functions/_shared/ema-return.ts); off until switched on.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render as rtlRender, screen, fireEvent, within, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";
import { LocaleProvider } from "@/lib/i18n";

vi.mock("@/lib/supabase", () => ({ supabase: {} }));

import PriceChart from "../components/PriceChart";
import { CHART_PREFS_KEY, getChartPrefs, resetChartPrefsCache } from "../lib/chartPrefs";
import { emaReturnMarks, emaReturnNewest, type ErBar } from "../lib/emaReturn";
import { buyCase, mirror, toCandles } from "./ema-return-case";

const render = (ui: ReactElement, locale: "ja" | "en" = "ja"): RenderResult =>
  rtlRender(<LocaleProvider initial={locale}>{ui}</LocaleProvider>);

afterEach(() => {
  localStorage.clear();
  resetChartPrefsCache();
});

const switchOn = () => {
  localStorage.setItem(CHART_PREFS_KEY, JSON.stringify({ overlays: { emaReturn: true } }));
  resetChartPrefsCache();
};
const titleOf = (g: Element) => g.querySelector("title")?.textContent ?? "";
const num = (el: Element, a: string) => Number(el.getAttribute(a));
// a few flat bars after the entry, at its close
const after = (bars: ErBar[], n: number): ErBar[] => {
  const c = bars[bars.length - 1].c;
  return [...bars, ...Array.from({ length: n }, () => ({ o: c, h: c + 0.02, l: c - 0.02, c }))];
};

describe("#387 the video's EMA 20 / 200 way on the chart", () => {
  it("is off until switched on, and listed on the chart", () => {
    const { bars } = buyCase(undefined, 400);
    expect(getChartPrefs().overlays.emaReturn).toBe(false);
    render(<PriceChart candles={toCandles(after(bars, 5))} pair="USD/JPY" />);
    expect(screen.queryByTestId("chart-emareturn")).toBeNull();
    expect(screen.getByTestId("chart-overlay-name-emaReturn").textContent).toBe("EMAクロス＋リターンムーブ（EMA20×200）");
    fireEvent.click(screen.getByTestId("chart-toggle-emaReturn"));
    expect(getChartPrefs().overlays.emaReturn).toBe(true);
    expect(screen.getByTestId("chart-emareturn-BUY")).toBeTruthy();
  });

  it("draws a BUY on its 600 bars: the lines, the return move, the boxes, its numbers as the email's", () => {
    switchOn();
    const { bars, p, b, k } = buyCase(undefined, 400);
    expect(bars.length).toBeGreaterThanOrEqual(600);
    const at = bars.length - 1;
    const mail = emaReturnNewest(bars);
    expect(mail?.side).toBe("BUY");
    render(<PriceChart candles={toCandles(after(bars, 5))} pair="USD/JPY" />);
    const g = screen.getByTestId("chart-emareturn-BUY");
    expect(screen.getAllByTestId("chart-emareturn-BUY")).toHaveLength(1);
    expect(screen.queryByTestId("chart-emareturn-SELL")).toBeNull();
    expect(g.getAttribute("opacity")).toBe("1");
    const m = mail!;
    const f = (v: number) => v.toFixed(3);
    expect(titleOf(g)).toBe(
      `EMAクロス＋リターンムーブ 買い: エントリー ${f(m.entry)}・損切り ${f(m.stop)}・利確1 ${f(m.tp1)}・利確2 ${f(m.tp2!)}（利確1までと損切りまでの比 ${m.rr.toFixed(2)}、水平線 ${f(m.neck)}）`,
    );
    expect(m.entry).toBeCloseTo(p + 0.06, 9);
    // the target's box above the entry, the stop's below, meeting at it
    const tp = within(g).getByTestId("chart-emareturn-tp-box");
    const sl = within(g).getByTestId("chart-emareturn-sl-box");
    expect(num(tp, "y") + num(tp, "height")).toBeCloseTo(num(sl, "y"), 6);
    expect(num(tp, "height")).toBeGreaterThan(0);
    expect(num(sl, "height")).toBeGreaterThan(0);
    // the horizontal from B to the entry, level; the diagonal from A down to where it was broken
    const hz = within(g).getByTestId("chart-emareturn-horizontal");
    expect(num(hz, "y1")).toBe(num(hz, "y2"));
    expect(num(hz, "x1")).toBeLessThan(num(hz, "x2"));
    expect(num(hz, "x2")).toBeCloseTo(num(tp, "x"), 6);
    const dg = within(g).getByTestId("chart-emareturn-diagonal");
    expect(num(dg, "x1")).toBeLessThan(num(hz, "x1"));
    expect(num(dg, "y1")).toBeLessThan(num(dg, "y2"));
    // the return move's dot on the horizontal, the 3rd bar after the break (K+3), one before the entry
    const dot = within(g).getByTestId("chart-emareturn-retest");
    expect(num(dot, "cy")).toBeCloseTo(num(hz, "y1"), 6);
    expect(num(dot, "cx")).toBeLessThan(num(tp, "x"));
    expect(k + 3).toBe(at - 1);
    expect(b).toBeLessThan(k);
    // the two EMAs
    expect(screen.getByTestId("chart-emareturn-fast").getAttribute("d")).toMatch(/^M/);
    expect(screen.getByTestId("chart-emareturn-slow").getAttribute("d")).toMatch(/^M/);
    // the setup ended with the entry: none forming
    expect(screen.queryByTestId("chart-emareturn-state")).toBeNull();
  });

  it("draws a SELL over the entry bar when the prices are upside down: the target's box below, the stop's above", () => {
    switchOn();
    const { bars } = buyCase(undefined, 400);
    const down = mirror(bars);
    render(<PriceChart candles={toCandles(after(down, 5))} pair="USD/JPY" />);
    const g = screen.getByTestId("chart-emareturn-SELL");
    expect(screen.queryByTestId("chart-emareturn-BUY")).toBeNull();
    const tp = within(g).getByTestId("chart-emareturn-tp-box");
    const sl = within(g).getByTestId("chart-emareturn-sl-box");
    expect(num(sl, "y") + num(sl, "height")).toBeCloseTo(num(tp, "y"), 6);
    expect(titleOf(g)).toContain("EMAクロス＋リターンムーブ 売り: エントリー");
  });

  it("the setup forming at the newest closed bar: its lines so far and what it waits for", () => {
    switchOn();
    const { bars, t, b, k, p } = buyCase(undefined, 400);
    // after the touch, before B is known: A only, waiting for a swing high
    const lines0 = render(<PriceChart candles={toCandles(bars.slice(0, t + 2))} pair="USD/JPY" />);
    expect(screen.getByTestId("chart-emareturn-setup").getAttribute("data-phase")).toBe("lines");
    expect(screen.getByTestId("chart-emareturn-setup-a")).toBeTruthy();
    expect(screen.queryByTestId("chart-emareturn-setup-horizontal")).toBeNull();
    expect(screen.getByTestId("chart-emareturn-state").textContent).toContain("EMA200 に触れました。山ができるのを待っています");
    lines0.unmount();
    // B known (3 bars after it): both lines, waiting for the break
    const lines1 = render(<PriceChart candles={toCandles(bars.slice(0, b + 4))} pair="USD/JPY" />);
    expect(screen.getByTestId("chart-emareturn-setup-horizontal")).toBeTruthy();
    expect(screen.getByTestId("chart-emareturn-setup-diagonal")).toBeTruthy();
    expect(screen.getByTestId("chart-emareturn-state").textContent).toContain(`水平線 ${(p - 0.02).toFixed(3)} と斜めの線を終値で上に抜けるのを待っています`);
    lines1.unmount();
    // broken, the return move seen (K+3): waiting for the bar past its body
    render(<PriceChart candles={toCandles(bars.slice(0, k + 4))} pair="USD/JPY" />);
    expect(screen.getByTestId("chart-emareturn-setup").getAttribute("data-phase")).toBe("retest");
    expect(screen.getByTestId("chart-emareturn-setup-retest")).toBeTruthy();
    expect(screen.getByTestId("chart-emareturn-state").textContent).toContain("リターンムーブと、その足の実体を抜ける足を待っています");
    expect(screen.queryByTestId("chart-emareturn-BUY")).toBeNull();
  });

  it("judges closed bars only: the entry on the bar still forming is not marked", () => {
    switchOn();
    const { bars } = buyCase(undefined, 400);
    const forming = render(<PriceChart candles={toCandles(bars)} pair="USD/JPY" formingLast />);
    expect(screen.queryByTestId("chart-emareturn-BUY")).toBeNull();
    forming.unmount();
    render(<PriceChart candles={toCandles(bars)} pair="USD/JPY" />);
    expect(screen.getByTestId("chart-emareturn-BUY")).toBeTruthy();
  });

  it("over the history before the chart's bars, as the email's 600 closed bars", () => {
    switchOn();
    const { bars, x } = buyCase(undefined, 400);
    const cut = 450;
    expect(cut).toBeLessThan(x);
    const candles = toCandles(after(bars, 5));
    const history = { bars: candles.slice(0, cut), status: "ready" as const };
    render(<PriceChart candles={candles.slice(cut)} pair="USD/JPY" zoneShiftHistory={history} />);
    const g = screen.getByTestId("chart-emareturn-BUY");
    expect(g.getAttribute("opacity")).toBe("1");
    const mail = emaReturnNewest(bars)!;
    expect(titleOf(g)).toContain(`エントリー ${mail.entry.toFixed(3)}・損切り ${mail.stop.toFixed(3)}・利確1 ${mail.tp1.toFixed(3)}`);
  });

  it("with the history still loading, nothing; with too few bars, nothing and the note says why", () => {
    switchOn();
    const { bars } = buyCase(undefined, 400);
    const candles = toCandles(after(bars, 5));
    const loading = render(<PriceChart candles={candles.slice(450)} pair="USD/JPY" zoneShiftHistory={{ bars: null, status: "loading" }} />);
    expect(screen.queryByTestId("chart-emareturn")).toBeNull();
    expect(screen.getByTestId("chart-emareturn-legend").textContent).toContain("チャートより前の足を読み込み中");
    loading.unmount();
    render(<PriceChart candles={candles.slice(450)} pair="USD/JPY" />);
    expect(screen.queryByTestId("chart-emareturn-BUY")).toBeNull();
    expect(screen.getByTestId("chart-emareturn-legend").textContent).toContain("このチャートは足が500本に満たないため");
  });

  it("a mark judged on fewer bars than the email's 600 is drawn fainter, and its title and note say so", () => {
    switchOn();
    const { bars } = buyCase();
    expect(bars.length).toBeLessThan(600);
    expect(emaReturnNewest(bars)).toBeNull();
    const marks = emaReturnMarks(bars);
    expect(marks).toHaveLength(1);
    expect(marks[0].full).toBe(false);
    render(<PriceChart candles={toCandles(after(bars, 5))} pair="USD/JPY" />);
    const g = screen.getByTestId("chart-emareturn-BUY");
    expect(g.getAttribute("opacity")).toBe("0.55");
    expect(titleOf(g)).toContain("600本に満たない足で判断した印です");
    expect(screen.getByTestId("chart-emareturn-legend").textContent).toContain("薄く描いています（メールは600本の所だけ）");
  });

  it("locked without a plan: listed with 🔒, not drawn; not on the moving averages' chart", () => {
    switchOn();
    const { bars } = buyCase(undefined, 400);
    const onLocked = vi.fn();
    const locked = render(<PriceChart candles={toCandles(after(bars, 5))} pair="USD/JPY" indicatorsLocked onLockedIndicator={onLocked} />);
    expect(screen.queryByTestId("chart-emareturn")).toBeNull();
    fireEvent.click(screen.getByTestId("chart-lock-emaReturn"));
    expect(onLocked).toHaveBeenCalledTimes(1);
    locked.unmount();
    render(<PriceChart candles={toCandles(after(bars, 5))} pair="USD/JPY" maOnly />);
    expect(screen.queryByTestId("chart-emareturn")).toBeNull();
    expect(screen.queryByTestId("chart-overlay-name-emaReturn")).toBeNull();
  });

  it("says it in English too", () => {
    switchOn();
    const { bars, b } = buyCase(undefined, 400);
    const shown = render(<PriceChart candles={toCandles(after(bars, 5))} pair="USD/JPY" />, "en");
    const g = screen.getByTestId("chart-emareturn-BUY");
    const m = emaReturnNewest(bars)!;
    expect(titleOf(g)).toBe(
      `EMA cross + return move BUY: entry ${m.entry.toFixed(3)} · stop ${m.stop.toFixed(3)} · TP1 ${m.tp1.toFixed(3)} · TP2 ${m.tp2!.toFixed(3)} (TP1 to stop ${m.rr.toFixed(2)} : 1, horizontal ${m.neck.toFixed(3)})`,
    );
    expect(screen.getByTestId("chart-overlay-name-emaReturn").textContent).toBe("EMA cross + return move (EMA 20×200)");
    shown.unmount();
    render(<PriceChart candles={toCandles(bars.slice(0, b + 4))} pair="USD/JPY" />, "en");
    expect(screen.getByTestId("chart-emareturn-state").textContent).toContain("waiting for a close above the horizontal");
  });
});
