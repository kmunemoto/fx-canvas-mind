// This file is subject to the terms of the Mozilla Public License 2.0 at
// https://mozilla.org/MPL/2.0/ — it is a TypeScript port of the open-source
// Pine Script "Zone Shift [ChartPrime]" © ChartPrime (TradingView script
// 8lfE3qMN, version 1.0), whose code is under that licence.
//
// #124: the owner asked for it ("これも追加して"). The port follows the
// published code at its default setting (Length 100):
//
//   * The midline: the average of EMA(close, 100) and HMA(close, 60). The
//     band: the midline ± the 200-bar average of high − low.
//   * On a closed candle: an uptrend begins when the low closes above the
//     top band having been under it the candle before (and the trend was
//     down); a downtrend when the high is under the bottom band having been
//     over it. The candle's low (high) where it began is the "trend
//     initiation level".
//   * A retest (⯁): in an uptrend, the close or the low crossing up through
//     that level; in a downtrend, the close or the high crossing down —
//     each more than 5 candles after the last one.
//   * Every candle is coloured by the trend at it (lime up, blue down —
//     down until the first uptrend, as the original starts).
//
// Pine's own rules, kept: EMA starts as the simple average of its first 100
// closes; WMA and SMA are nothing until their window is full, and so is
// anything computed from them; a comparison with nothing is false. The band
// is drawn on the forming candle too; the trend and the retests are judged
// on closed candles only.
//
// The 200-bar average needs 200 candles before the first band value, more
// than the chart shows; the live chart reads the closed candles before its
// own for it (the live-chart function's "history").
//
// Shown on the chart only: no signal, alert or record is judged on it.

export const ZS_DEFAULTS = {
  length: 100,
  // the range average's length, fixed in the original
  rangeLength: 200,
  // candles that must pass between two retests (more than this)
  retestGap: 5,
};

type Bar = { open: number; high: number; low: number; close: number };
type Series = Array<number | null>;

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

// Pine's ta.wma: weights n (the newest) down to 1
export const wma = (xs: ReadonlyArray<number | null>, n: number): Series => {
  const out: Series = new Array(xs.length).fill(null);
  const norm = (n * (n + 1)) / 2;
  for (let i = n - 1; i < xs.length; i++) {
    let s = 0;
    let ok = true;
    for (let k = 0; k < n; k++) {
      const v = xs[i - k];
      if (v === null) {
        ok = false;
        break;
      }
      s += v * (n - k);
    }
    if (ok) out[i] = s / norm;
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

// Pine's ta.hma: WMA(2·WMA(n/2) − WMA(n), ⌊√n⌋)
export const hma = (xs: ReadonlyArray<number>, n: number): Series => {
  const half = wma(xs, Math.floor(n / 2));
  const full = wma(xs, n);
  const diff: Series = xs.map((_, i) => (half[i] === null || full[i] === null ? null : 2 * (half[i] as number) - (full[i] as number)));
  return wma(diff, Math.floor(Math.sqrt(n)));
};

export interface ZoneShiftRead {
  mid: Series;
  top: Series;
  bot: Series;
  // the trend at each candle — the forming one keeps the last closed one's
  up: boolean[];
  // the trend initiation level as the original plots it: nothing on the
  // candle it moves (the line breaks there)
  level: Series;
  retests: Array<{ i: number; up: boolean }>;
  lastClosed: number;
}

// `bars` oldest first; candles after `lastClosed` are still forming
export const zoneShift = (
  bars: ReadonlyArray<Bar>,
  lastClosed: number = bars.length - 1,
  opts: Partial<typeof ZS_DEFAULTS> = {},
): ZoneShiftRead => {
  const o = { ...ZS_DEFAULTS, ...opts };
  const n = bars.length;
  const closes = bars.map((b) => b.close);
  const e = ema(closes, o.length);
  const h = hma(closes, o.length - 40);
  const dist = sma(bars.map((b) => b.high - b.low), o.rangeLength);
  const mid: Series = closes.map((_, i) => (e[i] === null || h[i] === null ? null : ((e[i] as number) + (h[i] as number)) / 2));
  const top: Series = mid.map((m, i) => (m === null || dist[i] === null ? null : m + (dist[i] as number)));
  const bot: Series = mid.map((m, i) => (m === null || dist[i] === null ? null : m - (dist[i] as number)));

  // a comparison with nothing is false
  const gt = (a: number | null, b: number | null) => a !== null && b !== null && a > b;
  const lt = (a: number | null, b: number | null) => a !== null && b !== null && a < b;

  const up: boolean[] = new Array(n).fill(false);
  const start: Series = new Array(n).fill(null);
  const retests: ZoneShiftRead["retests"] = [];
  let trend = false;
  let trendStart: number | null = null;
  // `var lastRetest = bar_index`: the first candle
  let lastRetest = 0;
  const closedEnd = Math.min(lastClosed, n - 1);
  for (let i = 0; i < n; i++) {
    const prevStart = i > 0 ? start[i - 1] : null;
    if (i <= closedEnd) {
      const b = bars[i];
      const p = i > 0 ? bars[i - 1] : null;
      if (gt(b.low, top[i]) && p !== null && lt(p.low, top[i - 1]) && !trend) {
        trend = true;
        trendStart = b.low;
      }
      if (lt(b.high, bot[i]) && p !== null && gt(p.high, bot[i - 1]) && trend) {
        trend = false;
        trendStart = b.high;
      }
      if (p !== null && i - lastRetest > o.retestGap) {
        if (trend && ((gt(b.close, trendStart) && lt(p.close, prevStart)) || (gt(b.low, trendStart) && lt(p.low, prevStart)))) {
          lastRetest = i;
          retests.push({ i, up: true });
        } else if (!trend && ((gt(p.close, trendStart) && lt(b.close, prevStart)) || (gt(p.high, trendStart) && lt(b.high, prevStart)))) {
          lastRetest = i;
          retests.push({ i, up: false });
        }
      }
    }
    up[i] = trend;
    start[i] = trendStart;
  }
  // `trendStart != trendStart[1] ? na : trendStart`: a comparison with
  // nothing is false, so the level shows from the candle it first appears on
  const level: Series = start.map((s, i) => (i > 0 && s !== null && start[i - 1] !== null && s !== start[i - 1] ? null : s));
  return { mid, top, bot, up, level, retests, lastClosed: closedEnd };
};
