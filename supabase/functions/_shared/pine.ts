// Pine Script's built-in averages, as TradingView computes them, shared by
// the chart (src/lib) and the functions (#155: the Q-Trend and ULTRA email
// alerts judge on the very same arithmetic the chart draws with). Moved here
// unchanged from src/lib/supertrend.ts (pineAtr, #136) and
// src/lib/trendTools.ts (pineEma, pineRma, #150), which re-export them.
//
// Deno-free and import-free: both sides import it.

type Bar = { high: number; low: number; close: number };

// Pine's atr(): Wilder's RMA of the true range, seeded with the simple
// average of the first `n` (the first bar's true range is its high − low)
export const pineAtr = (bars: ReadonlyArray<Bar>, n: number): Array<number | null> => {
  let prev: number | null = null;
  let sum = 0;
  return bars.map((b, i) => {
    const tr = i === 0
      ? b.high - b.low
      : Math.max(b.high - b.low, Math.abs(b.high - bars[i - 1].close), Math.abs(b.low - bars[i - 1].close));
    if (prev === null) {
      sum += tr;
      if (i < n - 1) return null;
      prev = sum / n;
      return prev;
    }
    prev = (tr + (n - 1) * prev) / n;
    return prev;
  });
};

export type Series = Array<number | null>;

// Pine's ta.ema over a series that may start with nothing: the simple
// average of the first `n` values, then alpha = 2 / (n + 1)
export const pineEma = (xs: ReadonlyArray<number | null>, n: number): Series => pineSmoothed(xs, n, 2 / (n + 1));

// Pine's ta.rma (Wilder's): the same with alpha = 1 / n
export const pineRma = (xs: ReadonlyArray<number | null>, n: number): Series => pineSmoothed(xs, n, 1 / n);

const pineSmoothed = (xs: ReadonlyArray<number | null>, n: number, alpha: number): Series => {
  const out: Series = new Array(xs.length).fill(null);
  let prev: number | null = null;
  for (let i = 0; i < xs.length; i++) {
    const v = xs[i];
    if (prev === null) {
      if (i < n - 1) continue;
      let s = 0;
      let ok = true;
      for (let k = i - n + 1; k <= i; k++) {
        const w = xs[k];
        if (w === null || w === undefined || !Number.isFinite(w)) {
          ok = false;
          break;
        }
        s += w;
      }
      if (!ok) continue;
      prev = s / n;
    } else if (v === null || v === undefined || !Number.isFinite(v)) {
      prev = null;
      continue;
    } else {
      prev = alpha * v + (1 - alpha) * prev;
    }
    out[i] = prev;
  }
  return out;
};

// #158: Zone Shift's own two (src/lib/zoneShift.ts, #124), moved here
// unchanged so BLSH (_shared/blsh.ts) computes as the chart always has.

// Pine's ta.sma: the mean of the last n values, nothing until there are n
// (or while any of them is nothing)
export const sma = (xs: ReadonlyArray<number | null>, n: number): Series => {
  const out: Series = new Array(xs.length).fill(null);
  for (let i = n - 1; i < xs.length; i++) {
    let s = 0;
    let ok = true;
    for (let k = 0; k < n; k++) {
      const v = xs[i - k];
      if (v === null) {
        ok = false;
        break;
      }
      s += v;
    }
    if (ok) out[i] = s / n;
  }
  return out;
};

// Pine's ta.ema: the simple average of the first n values, then
// alpha = 2 / (n + 1) of each new one
export const ema = (xs: ReadonlyArray<number>, n: number): Series => {
  const out: Series = new Array(xs.length).fill(null);
  if (xs.length < n) return out;
  const alpha = 2 / (n + 1);
  let prev = 0;
  for (let k = 0; k < n; k++) prev += xs[k];
  prev /= n;
  out[n - 1] = prev;
  for (let i = n; i < xs.length; i++) {
    prev = alpha * xs[i] + (1 - alpha) * prev;
    out[i] = prev;
  }
  return out;
};
