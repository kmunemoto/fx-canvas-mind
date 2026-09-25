// The exits behind research/exits.ts (#110): the SAR as a trailing stop, and
// a chandelier stop, kept apart from the fetching so the vitest suite can
// check them (src/test/exits.test.ts).
//
// Deno-free on purpose.

import type { Candle } from "../supabase/functions/analyze/indicators.ts";
import type { QuoteCandle } from "../supabase/functions/track-outcomes/quotes.ts";
import { mid, type Side } from "./lib.ts";

// ---- the SAR as a stop ------------------------------------------------------------------

// The stop the SAR puts in during each bar, and the side it is on then —
// BEFORE the bar is checked against it. psarSeries (indicator-series.ts)
// reports the side AFTER each bar; the two agree except on the bar that
// flips (src/test/exits.test.ts pins that).
export const sarStops = (candles: Candle[], step = 0.02, max = 0.2): { level: Array<number | null>; long: Array<boolean | null> } => {
  const n = candles.length;
  const level: Array<number | null> = candles.map(() => null);
  const long: Array<boolean | null> = candles.map(() => null);
  if (n < 3) return { level, long };
  let up = candles[1].close > candles[0].close;
  let s = up ? candles[0].low : candles[0].high;
  let ep = up ? candles[1].high : candles[1].low;
  let af = step;
  for (let i = 2; i < n; i++) {
    const c = candles[i];
    let next = s + af * (ep - s);
    next = up ? Math.min(next, candles[i - 1].low, candles[i - 2].low) : Math.max(next, candles[i - 1].high, candles[i - 2].high);
    level[i] = next;
    long[i] = up;
    if (up) {
      if (c.low < next) {
        up = false;
        next = ep;
        ep = c.low;
        af = step;
      } else if (c.high > ep) {
        ep = c.high;
        af = Math.min(af + step, max);
      }
    } else {
      if (c.high > next) {
        up = true;
        next = ep;
        ep = c.high;
        af = step;
      } else if (c.low < ep) {
        ep = c.low;
        af = Math.min(af + step, max);
      }
    }
    s = next;
  }
  return { level, long };
};

export interface Exit {
  // result in ATR of the entry bar
  atr: number;
  bars: number;
  // the initial risk in ATR (entry to the first stop)
  risk: number;
}

// Out at the stop in effect for each bar after entry; `stopAt(j, highSince,
// lowSince)` gives that stop from what was known before bar j.
const trail = (
  bars: QuoteCandle[],
  t: number,
  side: Side,
  atr: number,
  maxBars: number,
  stopAt: (j: number, highSince: number, lowSince: number) => number | null,
): Exit | null => {
  const buy = side === "BUY";
  const fill = buy ? bars[t].ask.close : bars[t].bid.close;
  let hi = -Infinity;
  let lo = Infinity;
  let first: number | null = null;
  const last = Math.min(bars.length - 1, t + maxBars);
  for (let j = t + 1; j <= last; j++) {
    const stop = stopAt(j, hi, lo);
    if (stop === null) return null;
    if (first === null) first = stop;
    const x = buy ? bars[j].bid : bars[j].ask;
    const hit = buy ? x.low <= stop : x.high >= stop;
    if (hit) {
      const exit = buy ? Math.min(stop, x.open) : Math.max(stop, x.open);
      return { atr: ((exit - fill) * (buy ? 1 : -1)) / atr, bars: j - t, risk: (Math.abs(fill - first) / atr) };
    }
    const m = mid(bars[j]);
    hi = Math.max(hi, m.high);
    lo = Math.min(lo, m.low);
  }
  // Still open when the history ends: valued at the last close rather than
  // dropped. Dropping it would drop the trades that are running — exactly
  // the ones a trailing exit exists for — and keep only those already stopped.
  if (last <= t) return null;
  const q = bars[last];
  const exit = buy ? q.bid.close : q.ask.close;
  return { atr: ((exit - fill) * (buy ? 1 : -1)) / atr, bars: last - t, risk: first === null ? 0 : Math.abs(fill - first) / atr };
};

export const MAX_HOLD = 500;

// Stay in until price trades through the SAR. Needs the SAR on the
// position's side for the bar after entry; null where it is not.
export const sarExit = (
  bars: QuoteCandle[],
  stops: { level: Array<number | null>; long: Array<boolean | null> },
  t: number,
  side: Side,
  atr: number,
  maxBars = MAX_HOLD,
): Exit | null => {
  const want = side === "BUY";
  if (stops.long[t + 1] !== want) return null;
  let done = false;
  return trail(bars, t, side, atr, maxBars, (j) => {
    if (done) return null;
    const l = stops.level[j];
    // The SAR flips the bar price trades through it, which is the exit, so
    // it is on the position's side for every bar the position is open
    if (l === null || stops.long[j] !== want) {
      done = true;
      return null;
    }
    return l;
  });
};

export const chandelierExit = (bars: QuoteCandle[], t: number, side: Side, atr: number, k = 3, maxBars = MAX_HOLD): Exit | null => {
  const buy = side === "BUY";
  const m0 = mid(bars[t]);
  let stop = buy ? m0.close - k * atr : m0.close + k * atr;
  return trail(bars, t, side, atr, maxBars, (_j, hi, lo) => {
    if (buy && Number.isFinite(hi)) stop = Math.max(stop, hi - k * atr);
    if (!buy && Number.isFinite(lo)) stop = Math.min(stop, lo + k * atr);
    return stop;
  });
};

