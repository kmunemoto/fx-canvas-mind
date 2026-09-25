// "A big move, then a reversal candle": the timing the GainzAlgo V2 Alpha
// video appears to use, as far as the chart can tell it (#106).
//
// The request: 「これって15分足ですが、タイミングをどうやって決めてると思う？」
// then 「やってみて」 — test the guess on past charts, and test the app's own
// RSI + Parabolic SAR rule with the target at twice the stop, the ratio the
// video's labels use.
//
// What the video shows (read off its TP/SL labels, gold, 15min): every
// target is exactly twice the stop distance, the stop distance varies with
// how violent the bar was (1.6 to 3.0), and the SELL labels sit on tops
// after a run-up, the BUY labels on bottoms after a drop. GainzAlgo's own
// logic is not published. The three rules below are standard readings of
// "stretched, then turned", written BEFORE any data was read and not tuned:
//
//   SELL on the bar whose close is below its open AND below the previous
//   bar's low (a reversal close), when price was stretched up just before:
//     rev_high20   — one of the last three bars made the 20-bar high
//     rev_rsi70    — RSI(14) was at or above 70 on one of the three bars
//                    before this one
//     rev_stretch  — the highest high of the last three bars was at least
//                    2 ATR above the 20-bar average
//   BUY is the mirror image of each. The test suite turns charts upside
//   down to pin that, and checks that no rule reads a later bar.
//
// Deno-free on purpose: src/test/reversal.test.ts imports it.

import type { Candle } from "../supabase/functions/analyze/indicators.ts";
import type { QuoteCandle } from "../supabase/functions/track-outcomes/quotes.ts";
import { atrSeriesOf } from "../supabase/functions/analyze/state.ts";
import { bundleOf, crossDown, crossUp, type Bundle, type Series } from "./indicator-series.ts";
import { labelAt, type LabelSpec, type Side } from "./lib.ts";

export type Dir = 1 | -1;

export interface RevCtx {
  c: Candle[];
  b: Bundle;
  atr: Array<number | null>;
}

export const revCtxOf = (candles: Candle[]): RevCtx => ({ c: candles, b: bundleOf(candles), atr: atrSeriesOf(candles) });

const v = (s: Series | Array<number | null>, i: number): number | null => (i >= 0 && i < s.length ? s[i] : null);

// Closed against the move: below its open and below the previous bar's low
// for a SELL; above its open and above the previous bar's high for a BUY.
export const reversalClose = (c: Candle[], i: number, d: Dir): boolean => {
  if (i < 1) return false;
  const bar = c[i];
  const prev = c[i - 1];
  return d === -1 ? bar.close < bar.open && bar.close < prev.low : bar.close > bar.open && bar.close > prev.high;
};

// Price was stretched the way the signal fades: up before a SELL (d = -1),
// down before a BUY (d = 1).
type Stretch = (x: RevCtx, i: number, d: Dir) => boolean;

const madeExtreme: Stretch = (x, i, d) => {
  for (let j = i - 2; j <= i; j++) {
    const edge = v(d === -1 ? x.b.dc.high : x.b.dc.low, j);
    if (edge === null || j < 0) continue;
    if (d === -1 ? x.c[j].high >= edge : x.c[j].low <= edge) return true;
  }
  return false;
};

const rsiExtreme: Stretch = (x, i, d) => {
  for (let j = i - 3; j <= i - 1; j++) {
    const r = v(x.b.rsi, j);
    if (r !== null && (d === -1 ? r >= 70 : r <= 30)) return true;
  }
  return false;
};

const farFromAverage: Stretch = (x, i, d) => {
  const avg = v(x.b.bb.middle, i);
  const a = v(x.atr, i);
  if (avg === null || a === null || !(a > 0) || i < 2) return false;
  let ext = d === -1 ? -Infinity : Infinity;
  for (let j = i - 2; j <= i; j++) ext = d === -1 ? Math.max(ext, x.c[j].high) : Math.min(ext, x.c[j].low);
  return d === -1 ? ext - avg >= 2 * a : avg - ext >= 2 * a;
};

export interface RevRule {
  id: string;
  ja: string;
  at: (x: RevCtx, i: number) => 0 | Dir;
}

const fade = (stretch: Stretch) => (x: RevCtx, i: number): 0 | Dir => {
  const sell = stretch(x, i, -1) && reversalClose(x.c, i, -1);
  const buy = stretch(x, i, 1) && reversalClose(x.c, i, 1);
  return sell && !buy ? -1 : buy && !sell ? 1 : 0;
};

export const REVERSALS: readonly RevRule[] = [
  {
    id: "rev_high20",
    ja: "直近3本で20本高値（安値）を付けたあと、反転足（前の足の安値（高値）を割って陰線（陽線）で確定）",
    at: fade(madeExtreme),
  },
  {
    id: "rev_rsi70",
    ja: "直前3本のどれかで RSI が70以上（30以下）だったあと、反転足",
    at: fade(rsiExtreme),
  },
  {
    id: "rev_stretch",
    ja: "直近3本の高値（安値）が20本平均から2ATR以上離れたあと、反転足",
    at: fade(farFromAverage),
  },
];

// ---- #107: the conditions write-ups attribute to GainzAlgo V2 [Alpha] ------------
//
// The request, after reading how the Suite is described: 「やってみて」 — test
// the logic third-party analyses of the V2 [Alpha] script report, as
// written. GainzAlgo publishes none of it; the reports agree on four
// conditions for a BUY, on the bar's close (a SELL is the mirror):
//
//   1. a bullish engulfing bar: the previous bar closed down, this one
//      closes up and above the previous bar's open;
//   2. a "stable" bar (Candle Stability Index): a large body;
//   3. RSI(14) not yet stretched the other way (RSI Index);
//   4. price fell over the last bars (Candle Delta Length): the close is
//      below the close 10 bars ago.
//
// The reports differ on two numbers, so both readings are fixed here before
// any data was read, and the study picks one on its first period:
//
//   gz_atr80    body at least 0.7 ATR(14), RSI below 80 — the reading the
//               analyses quote with numbers
//   gz_range80  body at least 0.7 of the bar's own range (the "body against
//               the wicks" description of the stability index), RSI below 80
//   gz_atr50    body at least 0.7 ATR, RSI below 50 (the stricter RSI reading)

export const engulfing = (c: Candle[], i: number, d: Dir): boolean => {
  if (i < 1) return false;
  const a = c[i - 1];
  const b = c[i];
  return d === 1
    ? a.close < a.open && b.close > b.open && b.close > a.open
    : a.close > a.open && b.close < b.open && b.close < a.open;
};

const bodyOverAtr = (x: RevCtx, i: number, k: number): boolean => {
  const a = v(x.atr, i);
  return a !== null && a > 0 && Math.abs(x.c[i].close - x.c[i].open) >= k * a;
};

const bodyOverRange = (x: RevCtx, i: number, k: number): boolean => {
  const r = x.c[i].high - x.c[i].low;
  return r > 0 && Math.abs(x.c[i].close - x.c[i].open) / r >= k;
};

// RSI not yet stretched the way the trade goes: below `level` for a BUY,
// above 100 - level for a SELL
const rsiRoom = (x: RevCtx, i: number, d: Dir, level: number): boolean => {
  const r = v(x.b.rsi, i);
  return r !== null && (d === 1 ? r < level : r > 100 - level);
};

// The move the signal fades: lower than `n` bars ago before a BUY
const movedAgainst = (c: Candle[], i: number, d: Dir, n: number): boolean =>
  i >= n && (d === 1 ? c[i].close < c[i - n].close : c[i].close > c[i - n].close);

const gainz = (stable: (x: RevCtx, i: number) => boolean, rsiLevel: number) => (x: RevCtx, i: number): 0 | Dir => {
  const ok = (d: Dir) => engulfing(x.c, i, d) && stable(x, i) && rsiRoom(x, i, d, rsiLevel) && movedAgainst(x.c, i, d, 10);
  const buy = ok(1);
  const sell = ok(-1);
  return buy && !sell ? 1 : sell && !buy ? -1 : 0;
};

export const GAINZ: readonly RevRule[] = [
  {
    id: "gz_atr80",
    ja: "包み足 ＋ 実体が ATR の0.7倍以上 ＋ RSI 80未満（売りは20超）＋ 終値が10本前より安い（売りは高い）",
    at: gainz((x, i) => bodyOverAtr(x, i, 0.7), 80),
  },
  {
    id: "gz_range80",
    ja: "包み足 ＋ 実体が足の高安の0.7以上 ＋ RSI 80未満 ＋ 10本前より安い",
    at: gainz((x, i) => bodyOverRange(x, i, 0.7), 80),
  },
  {
    id: "gz_atr50",
    ja: "包み足 ＋ 実体が ATR の0.7倍以上 ＋ RSI 50未満（売りは50超）＋ 10本前より安い",
    at: gainz((x, i) => bodyOverAtr(x, i, 0.7), 50),
  },
];

// The app's rule since #104, as the #103 study read it (rsi-combos.ts bounce
// + psar; src/test/rsisar.test.ts pins the app's rule to the same bars).
export const rsiSarAt = (x: RevCtx, i: number): 0 | Dir => {
  const long = x.b.psar.long[i];
  if (crossUp(x.b.rsi, 30, i) && long === true) return 1;
  if (crossDown(x.b.rsi, 70, i) && long === false) return -1;
  return 0;
};

// ---- what a trade opened here earned, in R ------------------------------------

// R is the stop distance. A win earns the target multiple, a loss -1. A
// trade still open at the horizon is closed there, at the price the book
// would have given (a BUY sells on the bid, a SELL buys on the ask), so the
// expectancy counts every trade rather than only the ones that resolved.
// A bar that reached both levels and could not be split is counted as a
// loss: the conservative reading, and rare once the finer bars are used.
export interface TradeR {
  outcome: "win" | "loss" | "ambiguous" | "expired";
  r: number;
}

export const tradeR = (
  bars: QuoteCandle[],
  t: number,
  atr: number,
  side: Side,
  spec: LabelSpec,
  intervalMs: number,
  sub: { bars: QuoteCandle[]; startOf: number[] } | null = null,
): TradeR | null => {
  const l = labelAt(bars, t, atr, side, spec, intervalMs, sub);
  if (l.outcome === "win") return { outcome: "win", r: spec.rr };
  if (l.outcome === "loss") return { outcome: "loss", r: -1 };
  if (l.outcome === "ambiguous") return { outcome: "ambiguous", r: -1 };
  if (l.outcome === "open") return null;
  const buy = side === "BUY";
  const entry = buy ? bars[t].ask.close : bars[t].bid.close;
  const last = bars[t + spec.horizon];
  const exit = buy ? last.bid.close : last.ask.close;
  const d = spec.stopAtr * atr;
  return { outcome: "expired", r: ((exit - entry) * (buy ? 1 : -1)) / d };
};
