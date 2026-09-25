// The state of the chart at a bar, in coarse words, computed the same way in
// the research that measured what each state was followed by and in the
// analysis that looks the current state up.
//
// Why one file for both (#100). A tendency measured on one definition of
// "RSI under 30" and served on another is a tendency about nothing: the two
// drift apart one refactor at a time and nobody notices, because both still
// print a plausible word. So research/tendencies.ts imports this file to
// label history, and analyze/index.ts imports it to label the present, and
// src/test/state.test.ts pins that the per-bar series and the last-bar
// reading agree.
//
// Every value at bar t is computed from bars 0..t and nothing after — the
// research would be measuring the future otherwise — and the test suite runs
// the prefix-equals-full check on every feature.
//
// The bins are coarse on purpose. With about 65,000 fifteen-minute bars over
// 2.7 years, a feature with twenty levels has cells too small to say
// anything; three to five levels each is what the sample can bear.
//
// Deno-free on purpose: the vitest suite and the research script (Deno) both
// import it directly.

import { rangeOf, rsiSeries, type Candle } from "./indicators.ts";
import { PIVOT_BARS, pivots } from "./structure.ts";

export const OWN_FEATURES = [
  "ma50",
  "slope50",
  "ma200",
  "mom",
  "rsi",
  "adx",
  "di",
  "bb",
  "vol",
  "session",
  "dow",
  "struct",
  "pos20",
  "streak",
  "bar",
] as const;
export type OwnFeature = (typeof OWN_FEATURES)[number];
// The next rung up and the one above it, as trend words
export const HTF_FEATURES = ["h1", "h2"] as const;
export type HtfFeature = (typeof HTF_FEATURES)[number];
export type Feature = OwnFeature | HtfFeature;
export const FEATURES: readonly Feature[] = [...OWN_FEATURES, ...HTF_FEATURES];

// Every level each feature can take, in display order. The research counts
// over these and the runtime can only ever produce these.
export const LEVELS: Record<Feature, readonly string[]> = {
  ma50: ["above", "below"],
  slope50: ["up", "flat", "down"],
  ma200: ["above", "below"],
  mom: ["strong_down", "down", "flat", "up", "strong_up"],
  rsi: ["lt30", "30_45", "45_55", "55_70", "gt70"],
  adx: ["weak", "mid", "strong"],
  di: ["plus", "minus"],
  bb: ["below", "low", "mid", "high", "above"],
  vol: ["quiet", "normal", "hot"],
  session: ["tokyo", "london", "overlap", "ny", "rollover"],
  dow: ["mon", "tue", "wed", "thu", "fri"],
  struct: ["up", "down", "mixed"],
  pos20: ["bottom", "middle", "top"],
  streak: ["down3", "none", "up3"],
  bar: ["big_down", "down", "small", "up", "big_up"],
  h1: ["up", "mixed", "down"],
  h2: ["up", "mixed", "down"],
};

export type StateRow = Record<Feature, string | null>;
export type OwnRow = Record<OwnFeature, string | null>;

// Thresholds, named so the research report and the prompt can quote them.
export const SLOPE_BARS = 10;
export const SLOPE_FLAT_ATR = 0.3;
export const MOM_BARS = 20;
export const MOM_STRONG_ATR = 3;
export const MOM_FLAT_ATR = 1;
export const ADX_WEAK = 20;
export const ADX_STRONG = 30;
export const VOL_QUIET = 0.8;
export const VOL_HOT = 1.25;
export const STRUCT_TOL_ATR = 0.25;
export const STREAK_BARS = 3;
export const BAR_SMALL_ATR = 0.3;
export const BAR_BIG_ATR = 1;
export const ATR_PERIOD = 14;
export const ATR_LONG_PERIOD = 100;

// "YYYY-MM-DD HH:mm:ss" (Twelve Data, midCandle) or ISO, always UTC.
export const barOpenMs = (datetime: string): number =>
  Date.parse(datetime.includes("T") ? (datetime.endsWith("Z") ? datetime : `${datetime}Z`) : `${datetime.replace(" ", "T")}Z`);

// ---- causal series ----------------------------------------------------------

const wilderAtrSeries = (candles: Candle[], period: number): Array<number | null> => {
  const out: Array<number | null> = candles.map(() => null);
  if (candles.length < period + 1) return out;
  const tr = (i: number) => {
    const c = candles[i];
    const pc = candles[i - 1].close;
    return Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc));
  };
  let avg = 0;
  for (let i = 1; i <= period; i++) avg += tr(i);
  avg /= period;
  out[period] = avg;
  for (let i = period + 1; i < candles.length; i++) {
    avg = (avg * (period - 1) + tr(i)) / period;
    out[i] = avg;
  }
  return out;
};

export const atrSeriesOf = (candles: Candle[], period = ATR_PERIOD) => wilderAtrSeries(candles, period);

const smaOf = (values: number[], period: number): Array<number | null> => {
  const out: Array<number | null> = values.map(() => null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
};

// Wilder ADX with its two DI lines at every bar. The same arithmetic as
// indicators.adx, whose single value is the last element here — the test
// suite pins that, so the ADX the prompt prints and the ADX the state was
// binned on cannot disagree.
export const adxSeries = (
  candles: Candle[],
  period = 14,
): Array<{ adx: number | null; plusDI: number | null; minusDI: number | null }> => {
  const out = candles.map(() => ({ adx: null as number | null, plusDI: null as number | null, minusDI: null as number | null }));
  if (candles.length < period + 1) return out;
  const tr: number[] = [];
  const plusDM: number[] = [];
  const minusDM: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const p = candles[i - 1];
    tr.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
    const up = c.high - p.high;
    const down = p.low - c.low;
    plusDM.push(up > down && up > 0 ? up : 0);
    minusDM.push(down > up && down > 0 ? down : 0);
  }
  let trSum = 0;
  let plusSum = 0;
  let minusSum = 0;
  for (let i = 0; i < period; i++) {
    trSum += tr[i];
    plusSum += plusDM[i];
    minusSum += minusDM[i];
  }
  // dx[k] belongs to candle index period + k
  const dxAt = () => {
    if (trSum === 0) return { dx: 0, p: 0, m: 0 };
    const p = (plusSum / trSum) * 100;
    const m = (minusSum / trSum) * 100;
    const s = p + m;
    return { dx: s === 0 ? 0 : (Math.abs(p - m) / s) * 100, p, m };
  };
  const dxs: number[] = [];
  const first = dxAt();
  dxs.push(first.dx);
  out[period].plusDI = first.p;
  out[period].minusDI = first.m;
  let adxv: number | null = null;
  for (let i = period; i < tr.length; i++) {
    trSum = trSum - trSum / period + tr[i];
    plusSum = plusSum - plusSum / period + plusDM[i];
    minusSum = minusSum - minusSum / period + minusDM[i];
    const d = dxAt();
    dxs.push(d.dx);
    const idx = i + 1;
    out[idx].plusDI = d.p;
    out[idx].minusDI = d.m;
    if (dxs.length === period) {
      adxv = dxs.reduce((a, b) => a + b, 0) / period;
      out[idx].adx = adxv;
    } else if (adxv !== null) {
      adxv = (adxv * (period - 1) + d.dx) / period;
      out[idx].adx = adxv;
    }
  }
  return out;
};

// The trend word a higher rung contributes: price on which side of its
// 50-bar average, and that average sloping the same way.
export const trendSeries = (candles: Candle[]): Array<string | null> => {
  const closes = candles.map((c) => c.close);
  const sma50 = smaOf(closes, 50);
  const atr = wilderAtrSeries(candles, ATR_PERIOD);
  return candles.map((c, i) => {
    const m = sma50[i];
    const then = i >= SLOPE_BARS ? sma50[i - SLOPE_BARS] : null;
    const a = atr[i];
    if (m === null || then === null || a === null || a <= 0) return null;
    const slope = (m - then) / a;
    if (c.close > m && slope > SLOPE_FLAT_ATR) return "up";
    if (c.close < m && slope < -SLOPE_FLAT_ATR) return "down";
    return "mixed";
  });
};

const bin = (v: number, edges: number[], names: readonly string[]): string => {
  for (let i = 0; i < edges.length; i++) if (v < edges[i]) return names[i];
  return names[names.length - 1];
};

// Hours are of the CLOSE of the bar, which is when the decision is made.
const sessionOf = (hourUtc: number): string =>
  hourUtc < 7 ? "tokyo" : hourUtc < 12 ? "london" : hourUtc < 17 ? "overlap" : hourUtc < 21 ? "ny" : "rollover";
const DOW = ["mon", "mon", "tue", "wed", "thu", "fri", "fri"]; // Sun -> Mon (the week's open), Sat -> Fri

/**
 * The own-timeframe state at every bar, oldest first. `intervalMs` is the
 * bar length, used only to know when each bar closed (session, weekday).
 */
export const ownStateSeries = (candles: Candle[], intervalMs: number): OwnRow[] => {
  const n = candles.length;
  const closes = candles.map((c) => c.close);
  const sma20 = smaOf(closes, 20);
  const sma50 = smaOf(closes, 50);
  const sma200 = smaOf(closes, 200);
  const atr = wilderAtrSeries(candles, ATR_PERIOD);
  const atrLong = wilderAtrSeries(candles, ATR_LONG_PERIOD);
  const rsi = rsiSeries(closes, 14);
  const adx = adxSeries(candles, 14);
  const piv = pivots(candles);
  const highs = piv.filter((p) => p.kind === "high");
  const lows = piv.filter((p) => p.kind === "low");
  let hi = 0;
  let lo = 0;
  let streak = 0;

  const out: OwnRow[] = [];
  for (let t = 0; t < n; t++) {
    const c = candles[t];
    const a = atr[t];
    const usableAtr = a !== null && a > 0;
    // streak of closes in one direction, ending at t
    if (t > 0) {
      const d = c.close - candles[t - 1].close;
      streak = d > 0 ? (streak > 0 ? streak + 1 : 1) : d < 0 ? (streak < 0 ? streak - 1 : -1) : 0;
    }
    // pivots confirmed by bar t (a pivot at k is known at k + PIVOT_BARS)
    while (hi < highs.length && highs[hi].index + PIVOT_BARS <= t) hi++;
    while (lo < lows.length && lows[lo].index + PIVOT_BARS <= t) lo++;

    const closeMs = barOpenMs(c.datetime) + intervalMs;
    const closeDate = new Date(closeMs);

    const m20 = sma20[t];
    const m50 = sma50[t];
    const m50Then = t >= SLOPE_BARS ? sma50[t - SLOPE_BARS] : null;
    const m200 = sma200[t];
    const r = rsi[t];
    const x = adx[t];
    const range20 = t >= 19 ? rangeOf(candles.slice(t - 19, t + 1), 20) : null;
    let bbPct: number | null = null;
    if (m20 !== null && t >= 19) {
      let v = 0;
      for (let k = t - 19; k <= t; k++) v += (closes[k] - m20) ** 2;
      const sd = Math.sqrt(v / 20);
      bbPct = sd > 0 ? (c.close - (m20 - 2 * sd)) / (4 * sd) : null;
    }
    let struct: string | null = null;
    if (hi >= 2 && lo >= 2 && usableAtr) {
      const tol = STRUCT_TOL_ATR * (a as number);
      const hd = highs[hi - 1].price - highs[hi - 2].price;
      const ld = lows[lo - 1].price - lows[lo - 2].price;
      struct = hd > tol && ld > tol ? "up" : hd < -tol && ld < -tol ? "down" : "mixed";
    }

    out.push({
      ma50: m50 === null ? null : c.close > m50 ? "above" : "below",
      slope50: m50 === null || m50Then === null || !usableAtr
        ? null
        : (m50 - m50Then) / (a as number) > SLOPE_FLAT_ATR
          ? "up"
          : (m50 - m50Then) / (a as number) < -SLOPE_FLAT_ATR
            ? "down"
            : "flat",
      ma200: m200 === null ? null : c.close > m200 ? "above" : "below",
      mom: t < MOM_BARS || !usableAtr
        ? null
        : bin((c.close - closes[t - MOM_BARS]) / (a as number), [-MOM_STRONG_ATR, -MOM_FLAT_ATR, MOM_FLAT_ATR, MOM_STRONG_ATR], LEVELS.mom),
      rsi: r === null ? null : bin(r, [30, 45, 55, 70], LEVELS.rsi),
      adx: x.adx === null ? null : bin(x.adx, [ADX_WEAK, ADX_STRONG], LEVELS.adx),
      di: x.plusDI === null || x.minusDI === null ? null : x.plusDI >= x.minusDI ? "plus" : "minus",
      bb: bbPct === null ? null : bin(bbPct, [0, 0.2, 0.8, 1], LEVELS.bb),
      vol: !usableAtr || atrLong[t] === null || (atrLong[t] as number) <= 0
        ? null
        : bin((a as number) / (atrLong[t] as number), [VOL_QUIET, VOL_HOT], LEVELS.vol),
      session: Number.isFinite(closeMs) ? sessionOf(closeDate.getUTCHours()) : null,
      dow: Number.isFinite(closeMs) ? DOW[closeDate.getUTCDay()] : null,
      struct,
      pos20: range20 === null || range20.positionPct === null
        ? null
        : range20.positionPct < 100 / 3 ? "bottom" : range20.positionPct > 200 / 3 ? "top" : "middle",
      streak: t === 0 ? null : streak >= STREAK_BARS ? "up3" : streak <= -STREAK_BARS ? "down3" : "none",
      bar: !usableAtr
        ? null
        : bin((c.close - c.open) / (a as number), [-BAR_BIG_ATR, -BAR_SMALL_ATR, BAR_SMALL_ATR, BAR_BIG_ATR], LEVELS.bar),
    });
  }
  return out;
};

/**
 * For each entry bar, the value of the higher-rung series as of the entry
 * bar's CLOSE: the newest higher bar that had itself closed by then. A
 * higher bar still forming at that moment is not used — its close was not
 * known yet.
 */
export const alignHigher = <T>(
  entry: Candle[],
  entryMs: number,
  higher: Candle[],
  higherMs: number,
  values: T[],
): Array<T | null> => {
  const out: Array<T | null> = [];
  let j = -1;
  for (const c of entry) {
    const decisionMs = barOpenMs(c.datetime) + entryMs;
    while (j + 1 < higher.length && barOpenMs(higher[j + 1].datetime) + higherMs <= decisionMs) j++;
    out.push(j >= 0 ? values[j] ?? null : null);
  }
  return out;
};

/**
 * The full state row at every entry bar: the entry rung's own features and
 * the two higher rungs' trend words.
 */
export const stateSeries = (
  rungs: Array<{ candles: Candle[]; intervalMs: number }>,
): StateRow[] => {
  const [entry, h1, h2] = rungs;
  const own = ownStateSeries(entry.candles, entry.intervalMs);
  const t1 = h1 ? alignHigher(entry.candles, entry.intervalMs, h1.candles, h1.intervalMs, trendSeries(h1.candles)) : own.map(() => null);
  const t2 = h2 ? alignHigher(entry.candles, entry.intervalMs, h2.candles, h2.intervalMs, trendSeries(h2.candles)) : own.map(() => null);
  return own.map((row, i) => ({ ...row, h1: t1[i], h2: t2[i] }));
};

/**
 * The state now: the last CLOSED entry bar and the higher rungs as of its
 * close. Callers pass closed bars only (analyze trims the forming one); the
 * same function as the research, read at the last index.
 */
export const stateNow = (rungs: Array<{ candles: Candle[]; intervalMs: number }>): StateRow | null => {
  if (rungs.length === 0 || rungs[0].candles.length === 0) return null;
  const rows = stateSeries(rungs);
  return rows[rows.length - 1] ?? null;
};
