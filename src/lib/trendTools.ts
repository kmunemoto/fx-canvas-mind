// #150: the trend tools the owner listed that the chart did not have yet
// (「まだ追加していないやつ追加して」, after a note naming Dow theory, trend
// lines, moving averages with their golden and dead crosses, Ichimoku,
// MACD and ADX): TradingView's built-ins, as their Pine code computes them,
// and the trend lines and crosses read mechanically from closed bars.
//
// Kept from Pine: an EMA or Wilder's average (ta.rma) starts as the simple
// average of its first values and waits until it has them; a highest or
// lowest waits for its full length; anything computed from nothing is
// nothing.
//
// Shown on the chart only: no signal, alert or record is judged on them,
// and none has been measured on past data.

// #155: Pine's averages moved to supabase/functions/_shared/pine.ts, shared
// with the functions
import { pineEma, pineRma, type Series } from "../../supabase/functions/_shared/pine";
export { pineEma, pineRma };
export type { Series };

type Bar = { high: number; low: number; close: number };

// ---- MACD (TradingView's built-in: 12, 26, 9; both averages EMAs) ----------

export const MACD_DEFAULTS = { fast: 12, slow: 26, signal: 9 };

export interface MacdRead {
  macd: Series;
  signal: Series;
  hist: Series;
}

export const macd = (closes: ReadonlyArray<number>, o = MACD_DEFAULTS): MacdRead => {
  const fast = pineEma(closes, o.fast);
  const slow = pineEma(closes, o.slow);
  const line: Series = closes.map((_, i) => (fast[i] === null || slow[i] === null ? null : (fast[i] as number) - (slow[i] as number)));
  const signal = pineEma(line, o.signal);
  return { macd: line, signal, hist: line.map((v, i) => (v === null || signal[i] === null ? null : v - (signal[i] as number))) };
};

// TradingView's four histogram colours: over 0 rising / falling, under 0
// rising / falling (against the bar before)
export const MACD_COLORS = { line: "#2962FF", signal: "#FF6D00", upGrow: "#26A69A", upFall: "#B2DFDB", downGrow: "#FFCDD2", downFall: "#FF5252" };
export const histColors = (hist: Series): Array<string | null> =>
  hist.map((h, i) => {
    if (h === null) return null;
    const prev = i > 0 ? hist[i - 1] : null;
    if (h >= 0) return prev !== null && prev > h ? MACD_COLORS.upFall : MACD_COLORS.upGrow;
    return prev !== null && prev < h ? MACD_COLORS.downGrow : MACD_COLORS.downFall;
  });

// ---- DMI / ADX (TradingView's "Directional Movement Index": 14, 14) -----------

export const ADX_DEFAULTS = { di: 14, adx: 14 };
// the level the owner's note gives for a trend being there
export const ADX_TREND_LEVEL = 25;
export const ADX_COLORS = { adx: "#F50057", plus: "#2962FF", minus: "#FF6D00" };

export interface DmiRead {
  plus: Series;
  minus: Series;
  adx: Series;
}

export const dmi = (bars: ReadonlyArray<Bar>, o = ADX_DEFAULTS): DmiRead => {
  const n = bars.length;
  const plusDM: Series = new Array(n).fill(null);
  const minusDM: Series = new Array(n).fill(null);
  // ta.tr (not ta.tr(true)): nothing on the first bar
  const tr: Series = new Array(n).fill(null);
  for (let i = 1; i < n; i++) {
    const up = bars[i].high - bars[i - 1].high;
    const down = bars[i - 1].low - bars[i].low;
    plusDM[i] = up > down && up > 0 ? up : 0;
    minusDM[i] = down > up && down > 0 ? down : 0;
    tr[i] = Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - bars[i - 1].close), Math.abs(bars[i].low - bars[i - 1].close));
  }
  const trur = pineRma(tr, o.di);
  const pSm = pineRma(plusDM, o.di);
  const mSm = pineRma(minusDM, o.di);
  // fixnan: a value that cannot be had keeps the last one
  const fixnan = (xs: Series): Series => {
    let last: number | null = null;
    return xs.map((v) => {
      if (v !== null && Number.isFinite(v)) last = v;
      return last;
    });
  };
  const plus = fixnan(trur.map((t, i) => (t === null || pSm[i] === null ? null : (100 * (pSm[i] as number)) / t)));
  const minus = fixnan(trur.map((t, i) => (t === null || mSm[i] === null ? null : (100 * (mSm[i] as number)) / t)));
  const dx: Series = plus.map((p, i) => {
    const m = minus[i];
    if (p === null || m === null) return null;
    const sum = p + m;
    return Math.abs(p - m) / (sum === 0 ? 1 : sum);
  });
  return { plus, minus, adx: pineRma(dx, o.adx).map((v) => (v === null ? null : 100 * v)) };
};

// ---- Ichimoku (TradingView's built-in: 9, 26, 52, displacement 26) -------------

export const ICHIMOKU_DEFAULTS = { conversion: 9, base: 26, span2: 52, displacement: 26 };
export const ICHIMOKU_COLORS = { conversion: "#2962FF", base: "#B71C1C", lagging: "#43A047", spanA: "#A5D6A7", spanB: "#EF9A9A", cloudUp: "#43A047", cloudDown: "#F44336" };

export interface IchimokuRead {
  conversion: Series;
  base: Series;
  // the leading spans where they are drawn: each bar's value is the one
  // computed displacement − 1 bars before it (Pine's offset)
  spanA: Series;
  spanB: Series;
  // the lagging span where it is drawn: each bar's value is the close
  // displacement − 1 bars after it
  lagging: Series;
}

const donchian = (bars: ReadonlyArray<Bar>, n: number): Series =>
  bars.map((_, i) => {
    if (i < n - 1) return null;
    let hi = -Infinity;
    let lo = Infinity;
    for (let k = i - n + 1; k <= i; k++) {
      if (bars[k].high > hi) hi = bars[k].high;
      if (bars[k].low < lo) lo = bars[k].low;
    }
    return (hi + lo) / 2;
  });

export const ichimoku = (bars: ReadonlyArray<Bar>, o = ICHIMOKU_DEFAULTS): IchimokuRead => {
  const n = bars.length;
  const conversion = donchian(bars, o.conversion);
  const base = donchian(bars, o.base);
  const lead1: Series = conversion.map((c, i) => (c === null || base[i] === null ? null : (c + (base[i] as number)) / 2));
  const lead2 = donchian(bars, o.span2);
  const shift = o.displacement - 1;
  return {
    conversion,
    base,
    spanA: bars.map((_, i) => (i - shift >= 0 ? lead1[i - shift] : null)),
    spanB: bars.map((_, i) => (i - shift >= 0 ? lead2[i - shift] : null)),
    lagging: bars.map((_, i) => (i + shift < n ? bars[i + shift].close : null)),
  };
};

// where a close stands against the cloud drawn on its bar
export const cloudSide = (close: number, a: number | null, b: number | null): "above" | "inside" | "below" | null => {
  if (a === null || b === null) return null;
  if (close > Math.max(a, b)) return "above";
  if (close < Math.min(a, b)) return "below";
  return "inside";
};

// ---- golden and dead crosses ------------------------------------------------------

// Where the fast line crosses the slow one (Pine's ta.crossover /
// ta.crossunder), on closed bars only
export const crosses = (fast: Series, slow: Series, lastClosed: number): Array<{ i: number; side: "GC" | "DC" }> => {
  const out: Array<{ i: number; side: "GC" | "DC" }> = [];
  for (let i = 1; i <= lastClosed && i < fast.length; i++) {
    const [a, b, pa, pb] = [fast[i], slow[i], fast[i - 1], slow[i - 1]];
    if (a === null || b === null || pa === null || pb === null) continue;
    if (a > b && pa <= pb) out.push({ i, side: "GC" });
    else if (a < b && pa >= pb) out.push({ i, side: "DC" });
  }
  return out;
};

// ---- trend lines ------------------------------------------------------------------------
//
// The owner's note: rising, the line through the lows; falling, through
// the highs; a clear break of it is a sign the flow is changing. Read
// mechanically: swing lows and highs as Dow theory's (a low with no lower
// low `pivot` bars either side, known `pivot` bars later), the up line
// through the latest two swing lows in a row where the second is higher,
// the down line through the latest two swing highs in a row where the
// second is lower, each drawn on to the right until a close goes through
// it ("clear": a close, not a wick) — that bar is its break.

export const TREND_PIVOT = 4;

export interface TrendLine {
  // the two swings it runs through
  a: number;
  pa: number;
  b: number;
  pb: number;
  // the first close through it after the second swing, if any
  brokenAt: number | null;
}

export const lineAt = (l: TrendLine, i: number): number => l.pa + ((l.pb - l.pa) * (i - l.a)) / (l.b - l.a);

export const trendLines = (bars: ReadonlyArray<Bar>, lastClosed: number, pivot = TREND_PIVOT): { up: TrendLine | null; down: TrendLine | null } => {
  const lows: number[] = [];
  const highs: number[] = [];
  for (let p = pivot; p + pivot <= lastClosed && p + pivot < bars.length; p++) {
    let isH = true;
    let isL = true;
    for (let k = p - pivot; k <= p + pivot; k++) {
      if (k === p) continue;
      if (k < p ? bars[k].high >= bars[p].high : bars[k].high > bars[p].high) isH = false;
      if (k < p ? bars[k].low <= bars[p].low : bars[k].low < bars[p].low) isL = false;
    }
    if (isH) highs.push(p);
    if (isL) lows.push(p);
  }
  const latest = (swings: number[], price: (i: number) => number, rising: boolean): TrendLine | null => {
    for (let k = swings.length - 1; k >= 1; k--) {
      const [a, b] = [swings[k - 1], swings[k]];
      const [pa, pb] = [price(a), price(b)];
      if (rising ? pb > pa : pb < pa) {
        const line: TrendLine = { a, pa, b, pb, brokenAt: null };
        for (let t = b + 1; t <= lastClosed && t < bars.length; t++) {
          const v = lineAt(line, t);
          if (rising ? bars[t].close < v : bars[t].close > v) {
            line.brokenAt = t;
            break;
          }
        }
        return line;
      }
    }
    return null;
  };
  return {
    up: latest(lows, (i) => bars[i].low, true),
    down: latest(highs, (i) => bars[i].high, false),
  };
};
