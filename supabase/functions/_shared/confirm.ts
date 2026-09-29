// #158: Stoch, BLSH and MACD as a check on each buy and sell signal.
//
// The owner (2026-09-29), with a CZK/JPY 4-hour chart of Q-Trend, ULTRA,
// Stoch, BLSH and MACD: 「buyとsellの判断はstochとblshとmacdを考慮して判断して
// 出す様にして」. Asked how, the owner chose: all three the same way as the
// signal (「3つとも同じ向き」), on both Q-Trend's and ULTRA's signals (the
// chart's marks and the emails), measured before it goes in
// (research/confirm.ts, docs §8.70).
//
// Measured, and not put in: on GMO's pairs since 2024 the signals the three
// agreed with did no better than the rest (4 hours: TP1 before the stop
// 61.1% against 62.3% for all of them; 5 and 15 minutes a point worse, past
// chance), ULTRA's never agreed on 4 hours, and blind entries where the
// three agreed did no better either. Shown the numbers, the owner chose
// 「入れない」. Used by the study only.
//
// A BUY stands only while, on its own (closed) bar:
//   * Stoch's %K is over its %D (14, 1, 3, TradingView's defaults),
//   * BLSH's area is green: its composite over 0 (the chart's colour rule),
//   * MACD is over its signal line: the histogram over 0 (12, 26, 9);
// a SELL mirrored: %K under %D, the area red (at or under 0), MACD under its
// signal. A value not there yet is not agreement.
//
// Read over the same bars the signals are judged on (from anchoredStart), as
// the chart and the email would have.
//
// Deno-free; only research/confirm.ts imports it.

import { blsh } from "./blsh.ts";
import { macd } from "./macd.ts";
import { STOCH_DEFAULTS, stochastic } from "./stochastic.ts";
import type { Series } from "./pine.ts";

type Bar = { high: number; low: number; close: number };

export interface ConfirmRead {
  k: Series;
  d: Series;
  composite: Series;
  hist: Series;
}

export const confirmRead = (bars: ReadonlyArray<Bar>): ConfirmRead => {
  const st = stochastic(bars, STOCH_DEFAULTS);
  const b = blsh(bars);
  const m = macd(bars.map((x) => x.close));
  return { k: st.k, d: st.d, composite: b.composite, hist: m.hist };
};

// Whether all three point the signal's way on bar `i`
export const confirms = (r: ConfirmRead, i: number, side: "BUY" | "SELL"): boolean => {
  const k = r.k[i];
  const d = r.d[i];
  const c = r.composite[i];
  const h = r.hist[i];
  if (k === null || k === undefined || d === null || d === undefined || c === null || c === undefined || h === null || h === undefined) return false;
  return side === "BUY" ? k > d && c > 0 && h > 0 : k < d && c <= 0 && h < 0;
};
