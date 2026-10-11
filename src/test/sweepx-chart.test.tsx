// #291 (docs §8.112): the owner's video's way on the moving averages' own
// chart — BUY under the cross bar (SELL over it), the boxes to the second
// target and to the stop, the last wave's low (high) that was taken — drawn
// from the same code the gold 1-minute email decides with
// (supabase/functions/_shared/sweep-cross.ts), and on that chart only.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render as rtlRender, screen, fireEvent, within, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";
import { LocaleProvider } from "@/lib/i18n";

vi.mock("@/lib/supabase", () => ({ supabase: {} }));

import PriceChart from "../components/PriceChart";
import { getChartPrefs, resetChartPrefsCache } from "../lib/chartPrefs";
import { sweepCrossMarks, sweepCrossNewest, type SweepMark } from "../lib/sweepCross";
import type { NumericCandle } from "../lib/types";

const render = (ui: ReactElement, locale: "ja" | "en" = "ja"): RenderResult =>
  rtlRender(<LocaleProvider initial={locale}>{ui}</LocaleProvider>);

afterEach(() => {
  localStorage.clear();
  resetChartPrefsCache();
});

// 1-minute gold bars along straight legs ([to, bars] each, from `start`): each
// bar opens at the last close, its wicks half a dollar beyond its body
const M1 = 60_000;
const T0 = Date.parse("2026-10-05T00:00:00Z");
const stamp = (i: number) => new Date(T0 + i * M1).toISOString().slice(0, 19).replace("T", " ");
const legs = (start: number, parts: Array<[number, number]>): NumericCandle[] => {
  const closes: number[] = [];
  let prev = start;
  for (const [to, n] of parts) {
    for (let k = 1; k <= n; k++) closes.push(prev + ((to - prev) * k) / n);
    prev = to;
  }
  return closes.map((close, i) => {
    const open = i > 0 ? closes[i - 1] : close;
    return { datetime: stamp(i), open, high: Math.max(open, close) + 0.5, low: Math.min(open, close) - 0.5, close };
  });
};
// the video's shape: flat, down to 1990, up to 2010, down to 1985 (below the
// trough: the low taken), up to 2005
const videoShape = (flat: number) => legs(2000, [[2000, flat], [1990, 80], [2010, 100], [1985, 100], [2005, 120]]);
// the same upside down: the high taken, a SELL
const mirrored = (bars: NumericCandle[]) =>
  bars.map((c) => ({ ...c, open: 4000 - c.open, high: 4000 - c.low, low: 4000 - c.high, close: 4000 - c.close }));
// the one mark on these bars, as the module decides it (the chart's own test of it is sweep-cross.test.ts)
const onlyMark = (bars: NumericCandle[]): SweepMark => {
  const marks = sweepCrossMarks(bars, 0.1, 0);
  expect(marks).toHaveLength(1);
  return marks[0];
};
const titleOf = (g: HTMLElement) => g.querySelector("title")?.textContent ?? "";
const num = (el: Element, a: string) => Number(el.getAttribute(a));

describe("#291 the video's way's marks on the moving averages' chart", () => {
  it("draws a BUY under the cross bar: its boxes to the second target (above) and to the stop (below), and the low taken", () => {
    const bars = videoShape(400);
    const m = onlyMark(bars);
    expect(m.side).toBe("BUY");
    expect(m.full).toBe(true);
    render(<PriceChart candles={bars.slice(0, m.at + 8)} pair="XAU/USD" maOnly />);
    const g = screen.getByTestId("chart-sweepx-BUY");
    expect(screen.getAllByTestId("chart-sweepx-BUY")).toHaveLength(1);
    expect(screen.queryByTestId("chart-sweepx-SELL")).toBeNull();
    expect(g.getAttribute("opacity")).toBe("1");
    // its numbers, as the email's (gold: two decimals)
    expect(titleOf(g)).toBe(
      `流動性狩り＋EMAクロス 買い: エントリー ${m.entry.toFixed(2)}・損切り ${m.sl.toFixed(2)}・利確1 ${m.tps[0].toFixed(2)}・利確2 ${m.tps[1].toFixed(2)}（割った前の安値 ${m.level.toFixed(2)}）`,
    );
    expect(m.tps[1] - m.entry).toBeCloseTo(2.0, 9);
    // the two boxes meet at the entry: the targets' above it, the stop's below
    const tp = within(g).getByTestId("chart-sweepx-tp-box");
    const sl = within(g).getByTestId("chart-sweepx-sl-box");
    expect(num(tp, "y") + num(tp, "height")).toBeCloseTo(num(sl, "y"), 6);
    expect(num(tp, "height")).toBeGreaterThan(0);
    expect(num(sl, "height")).toBeGreaterThan(0);
    expect(num(tp, "x")).toBe(num(sl, "x"));
    expect(num(tp, "width")).toBeGreaterThan(0);
    // the level taken, dashed from where it was made to where the leg went past it, and said
    const level = within(g).getByTestId("chart-sweepx-level");
    expect(num(level, "y1")).toBe(num(level, "y2"));
    expect(num(level, "x1")).toBeLessThan(num(level, "x2"));
    expect(within(g).getByTestId("chart-sweepx-taken").textContent).toBe("安値を割った");
    // listed among the signals, its note not speaking of fainter marks (none here)
    fireEvent.click(screen.getByTestId("chart-info-sweepx"));
    const note = screen.getByTestId("chart-info-text-sweepx").textContent!;
    expect(note).toContain("EMA20 が EMA80 を下から上に抜けた確定足");
    expect(note).toContain("金は1 pip を0.1ドルとして、1.5ドルと2.0ドル");
    expect(note).toContain("この決まりの勝率と1回あたりの損益は、まだ測っていません");
    expect(note).not.toContain("薄く描いています");
  });

  it("draws a SELL over the cross bar when the high was taken: the targets' box below the entry, the stop's above", () => {
    const bars = mirrored(videoShape(400));
    const m = onlyMark(bars);
    expect(m.side).toBe("SELL");
    render(<PriceChart candles={bars.slice(0, m.at + 8)} pair="XAU/USD" maOnly />);
    const g = screen.getByTestId("chart-sweepx-SELL");
    expect(screen.queryByTestId("chart-sweepx-BUY")).toBeNull();
    expect(titleOf(g)).toContain(`流動性狩り＋EMAクロス 売り: エントリー ${m.entry.toFixed(2)}・損切り ${m.sl.toFixed(2)}`);
    expect(titleOf(g)).toContain(`割った前の高値 ${m.level.toFixed(2)}`);
    const tp = within(g).getByTestId("chart-sweepx-tp-box");
    const sl = within(g).getByTestId("chart-sweepx-sl-box");
    expect(num(sl, "y") + num(sl, "height")).toBeCloseTo(num(tp, "y"), 6);
    expect(within(g).getByTestId("chart-sweepx-taken").textContent).toBe("高値を抜いた");
  });

  it("is not on the other chart, listed or drawn, though saved on; switched off here it is off and saved so", () => {
    const bars = videoShape(400);
    const m = onlyMark(bars);
    const shown = bars.slice(0, m.at + 8);
    expect(getChartPrefs().overlays.sweepx).toBe(true);
    const full = render(<PriceChart candles={shown} pair="XAU/USD" />);
    expect(screen.queryByTestId("chart-sweepx")).toBeNull();
    expect(screen.queryByTestId("chart-overlay-sweepx")).toBeNull();
    expect(getChartPrefs().overlays.sweepx).toBe(true);
    full.unmount();
    render(<PriceChart candles={shown} pair="XAU/USD" maOnly />);
    expect(screen.getByTestId("chart-sweepx")).toBeTruthy();
    fireEvent.click(screen.getByTestId("chart-toggle-sweepx"));
    expect(screen.queryByTestId("chart-sweepx")).toBeNull();
    expect(getChartPrefs().overlays.sweepx).toBe(false);
    fireEvent.click(screen.getByTestId("chart-toggle-sweepx"));
    expect(screen.getByTestId("chart-sweepx-BUY")).toBeTruthy();
    expect(getChartPrefs().overlays.sweepx).toBe(true);
  });

  it("judges closed bars only: the cross on the bar still forming (or not yet judged) is not marked", () => {
    const bars = videoShape(400);
    const m = onlyMark(bars);
    const upTo = bars.slice(0, m.at + 1);
    const forming = render(<PriceChart candles={upTo} pair="XAU/USD" maOnly formingLast />);
    expect(screen.queryByTestId("chart-sweepx-BUY")).toBeNull();
    forming.unmount();
    const unjudged = render(<PriceChart candles={upTo} pair="XAU/USD" maOnly unjudged={1} />);
    expect(screen.queryByTestId("chart-sweepx-BUY")).toBeNull();
    unjudged.unmount();
    // closed, it is
    render(<PriceChart candles={upTo} pair="XAU/USD" maOnly />);
    expect(screen.getByTestId("chart-sweepx-BUY")).toBeTruthy();
  });

  it("over the history before the chart's bars, as the email's 600 closed bars: the mark the email would send", () => {
    const bars = videoShape(400);
    const m = onlyMark(bars);
    const cut = 500;
    const history = { bars: bars.slice(0, cut), status: "ready" as const };
    render(<PriceChart candles={bars.slice(cut, m.at + 8)} pair="XAU/USD" maOnly zoneShiftHistory={history} />);
    const g = screen.getByTestId("chart-sweepx-BUY");
    const mail = sweepCrossNewest(bars.slice(0, m.at + 1), 0.1)!;
    expect(mail.side).toBe("BUY");
    expect(titleOf(g)).toContain(`エントリー ${mail.entry.toFixed(2)}・損切り ${mail.sl.toFixed(2)}・利確1 ${mail.tps[0].toFixed(2)}`);
    expect(g.getAttribute("opacity")).toBe("1");
    // the trough taken is in the history (to the left of the chart's first bar): its line still drawn
    expect(m.levelAt).toBeLessThan(cut);
    expect(within(g).getByTestId("chart-sweepx-level")).toBeTruthy();
  });

  it("with the history still loading, nothing; with no history and too few bars before it, nothing", () => {
    const bars = videoShape(400);
    const m = onlyMark(bars);
    const loading = render(
      <PriceChart candles={bars.slice(500, m.at + 8)} pair="XAU/USD" maOnly zoneShiftHistory={{ bars: null, status: "loading" }} />,
    );
    expect(screen.queryByTestId("chart-sweepx")).toBeNull();
    loading.unmount();
    // under 300 bars up to the cross (SWEEPX_MIN_WINDOW): not judged
    expect(m.at - 500 + 1).toBeLessThan(300);
    render(<PriceChart candles={bars.slice(500, m.at + 8)} pair="XAU/USD" maOnly />);
    expect(screen.queryByTestId("chart-sweepx-BUY")).toBeNull();
  });

  it("a mark judged on fewer bars than the email's 600 is drawn fainter, and its title and note say so", () => {
    // (the first fall from bar 250: its cross counted, the window's 241st bar or later)
    const bars = videoShape(250);
    const m = onlyMark(bars);
    expect(m.at).toBeLessThan(599);
    expect(m.full).toBe(false);
    // the email, which needs its 600, sends nothing there
    expect(sweepCrossNewest(bars.slice(0, m.at + 1), 0.1)).toBeNull();
    render(<PriceChart candles={bars.slice(0, m.at + 8)} pair="XAU/USD" maOnly />);
    const g = screen.getByTestId("chart-sweepx-BUY");
    expect(g.getAttribute("opacity")).toBe("0.55");
    expect(titleOf(g)).toContain("600本に満たない足で判断した印です");
    fireEvent.click(screen.getByTestId("chart-info-sweepx"));
    expect(screen.getByTestId("chart-info-text-sweepx").textContent).toContain("薄く描いています（メールは600本の所だけ）");
  });

  it("locked without a plan: listed with 🔒, not drawn", () => {
    const bars = videoShape(400);
    const m = onlyMark(bars);
    const onLocked = vi.fn();
    render(<PriceChart candles={bars.slice(0, m.at + 8)} pair="XAU/USD" maOnly indicatorsLocked onLockedIndicator={onLocked} />);
    expect(screen.queryByTestId("chart-sweepx")).toBeNull();
    fireEvent.click(screen.getByTestId("chart-lock-sweepx"));
    expect(onLocked).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("chart-sheet-locked-note").textContent).toContain("流動性狩り＋EMAクロスの印");
  });

  it("on a yen pair, a pip is 0.01 yen: the targets 0.15 and 0.20 yen away, the note saying so", () => {
    // the shape scaled to a yen pair's prices (150 yen, moves of a fifth of a yen)
    const bars = videoShape(400).map((c) => {
      const f = (v: number) => 150 + (v - 2000) / 50;
      return { ...c, open: f(c.open), high: f(c.high), low: f(c.low), close: f(c.close) };
    });
    const m = sweepCrossMarks(bars, 0.01, 0);
    expect(m).toHaveLength(1);
    render(<PriceChart candles={bars.slice(0, m[0].at + 8)} pair="USD/JPY" maOnly />);
    const g = screen.getByTestId("chart-sweepx-BUY");
    expect(titleOf(g)).toContain(`利確1 ${(m[0].entry + 0.15).toFixed(3)}・利確2 ${(m[0].entry + 0.2).toFixed(3)}`);
    fireEvent.click(screen.getByTestId("chart-info-sweepx"));
    expect(screen.getByTestId("chart-info-text-sweepx").textContent).toContain("円のペアは0.15円と0.20円");
  });

  it("says it in English too", () => {
    const bars = videoShape(400);
    const m = onlyMark(bars);
    render(<PriceChart candles={bars.slice(0, m.at + 8)} pair="XAU/USD" maOnly />, "en");
    const g = screen.getByTestId("chart-sweepx-BUY");
    expect(titleOf(g)).toBe(
      `Liquidity sweep + EMA cross BUY: entry ${m.entry.toFixed(2)}, stop ${m.sl.toFixed(2)}, TP1 ${m.tps[0].toFixed(2)}, TP2 ${m.tps[1].toFixed(2)} (the low taken ${m.level.toFixed(2)})`,
    );
    expect(within(g).getByTestId("chart-sweepx-taken").textContent).toBe("Low taken");
    expect(screen.getByTestId("chart-overlay-name-sweepx").textContent).toBe("Liquidity sweep + EMA cross (EMA 20×80)");
  });
});
