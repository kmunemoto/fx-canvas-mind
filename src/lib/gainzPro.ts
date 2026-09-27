// #131: a "Pro-style" confidence score, built from what GainzAlgo publishes
// about the Pro configuration of its invite-only Suite (the code itself is
// not public): pattern strength, volatility, momentum and trend turned into
// "weighted numeric scores" with "percentile-ranked volatility
// normalization", and a signal "only when the combined confidence score
// exceeds an adaptive threshold derived from recent market conditions".
// Its named parts (CSTA, SAMSM, CSMRM) come with no formula, so every number
// below is this app's own reading, fixed before any data was read:
//
//   * Structure (required): a down candle, then an up candle closing on the
//     bar (a buy); the mirror for a sell.
//   * Four parts, each measured on the bar that closed (a buy's; a sell's
//     are the mirror):
//       candle   — where it closed in its range × its body's share of the
//                  range (0 without the structure);
//       momentum — RSI(14)'s acceleration: its change on this bar minus its
//                  change on the bar before;
//       volatility — this bar's true range over ATR(14) the bar before;
//       trend    — EMA(50)'s change over 10 bars, in ATRs (for the pull-back
//                  reading: a buy scores in an uptrend).
//   * Each part becomes its percentile rank among its own previous WINDOW
//     values; the score is their plain mean (equal weights).
//   * The adaptive threshold: the score must rank at or above THRESHOLD among
//     the previous WINDOW scores of its side, on a bar with the structure.
//
// Shown on the chart only, off unless switched on: no signal, alert or
// record is judged on it.

export interface GainzProParams {
  rsiLength: number;
  atrLength: number;
  emaLength: number;
  slopeBars: number;
  // bars each part and the score are ranked against
  window: number;
  // the score's rank among the previous `window` scores, at or above which a
  // bar with the structure signals
  threshold: number;
  // the trend part in the score (off: the three reversal parts alone)
  trend: boolean;
}

// #132: a window of 50 won most often on the first period of every setting
// tried (research/tune.ts; docs §8.45). It was 100.
export const GP_DEFAULTS: GainzProParams = { rsiLength: 14, atrLength: 14, emaLength: 50, slopeBars: 10, window: 50, threshold: 0.95, trend: true };

type Bar = { open: number; high: number; low: number; close: number };
type Side = "BUY" | "SELL";

export interface GainzProSignal {
  i: number;
  side: Side;
  // the score (0–1) and its rank among the previous `window` scores
  score: number;
  rank: number;
}

export interface GainzProRead {
  // each side's score per bar (null until every part can be ranked)
  score: Record<Side, Array<number | null>>;
  signals: GainzProSignal[];
}

// Wilder's ATR; null until `n` true ranges
const atrOf = (bars: ReadonlyArray<Bar>, n: number): Array<number | null> => {
  let a = 0;
  return bars.map((b, i) => {
    const prev = i > 0 ? bars[i - 1].close : b.close;
    const tr = Math.max(b.high - b.low, Math.abs(b.high - prev), Math.abs(b.low - prev));
    a = i < n ? (a * i + tr) / (i + 1) : (a * (n - 1) + tr) / n;
    return i < n - 1 ? null : a;
  });
};

// Wilder's RSI of the closes; null until `n` changes
const rsiOf = (closes: number[], n: number): Array<number | null> => {
  const out: Array<number | null> = closes.map(() => null);
  let gain = 0;
  let loss = 0;
  for (let i = 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    const g = Math.max(ch, 0);
    const l = Math.max(-ch, 0);
    if (i <= n) {
      gain += g / n;
      loss += l / n;
      if (i < n) continue;
    } else {
      gain = (gain * (n - 1) + g) / n;
      loss = (loss * (n - 1) + l) / n;
    }
    out[i] = loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss);
  }
  return out;
};

// EMA seeded with the SMA of its first `n` values; null before
const emaOf = (xs: number[], n: number): Array<number | null> => {
  const out: Array<number | null> = xs.map(() => null);
  const k = 2 / (n + 1);
  let e = 0;
  for (let i = 0; i < xs.length; i++) {
    if (i < n - 1) {
      e += xs[i];
      continue;
    }
    e = i === n - 1 ? (e + xs[i]) / n : e + k * (xs[i] - e);
    out[i] = e;
  }
  return out;
};

// x's percentile rank among the `w` values before i (ties count half); null
// unless all of them and x are known
export const rankAmong = (xs: ReadonlyArray<number | null>, i: number, w: number): number | null => {
  const x = xs[i];
  if (x === null || i < w) return null;
  let below = 0;
  let equal = 0;
  for (let k = i - w; k < i; k++) {
    const v = xs[k];
    if (v === null) return null;
    if (v < x) below++;
    else if (v === x) equal++;
  }
  return (below + equal / 2) / w;
};

// `lastClosed`: the index of the newest closed bar — nothing is signalled on
// a bar still forming
export const gainzPro = (
  bars: ReadonlyArray<Bar>,
  params: GainzProParams = GP_DEFAULTS,
  lastClosed: number = bars.length - 1,
): GainzProRead => {
  const n = bars.length;
  const closes = bars.map((b) => b.close);
  const rsi = rsiOf(closes, params.rsiLength);
  const atr = atrOf(bars, params.atrLength);
  const ema = emaOf(closes, params.emaLength);
  const tr = bars.map((b, i) => {
    const prev = i > 0 ? bars[i - 1].close : b.close;
    return Math.max(b.high - b.low, Math.abs(b.high - prev), Math.abs(b.low - prev));
  });
  // the parts both sides share or mirror
  const vol: Array<number | null> = bars.map((_, i) => {
    const a = i > 0 ? atr[i - 1] : null;
    return a !== null && a > 0 ? tr[i] / a : null;
  });
  const accel: Array<number | null> = bars.map((_, i) => {
    const a = rsi[i], b = i > 0 ? rsi[i - 1] : null, c = i > 1 ? rsi[i - 2] : null;
    return a === null || b === null || c === null ? null : a - b - (b - c);
  });
  const slope: Array<number | null> = bars.map((_, i) => {
    const e = ema[i], p = i >= params.slopeBars ? ema[i - params.slopeBars] : null, a = atr[i];
    return e === null || p === null || a === null || !(a > 0) ? null : (e - p) / a;
  });
  const structure = (i: number, side: Side) => {
    if (i < 1) return false;
    const b = bars[i], p = bars[i - 1];
    return side === "BUY" ? p.close < p.open && b.close > b.open : p.close > p.open && b.close < b.open;
  };
  const candle = (i: number, side: Side): number => {
    const b = bars[i];
    const range = b.high - b.low;
    if (!(range > 0) || !structure(i, side)) return 0;
    return side === "BUY"
      ? ((b.close - b.low) / range) * ((b.close - b.open) / range)
      : ((b.high - b.close) / range) * ((b.open - b.close) / range);
  };
  const neg = (xs: Array<number | null>) => xs.map((v) => (v === null ? null : -v));
  const score: Record<Side, Array<number | null>> = { BUY: [], SELL: [] };
  const signals: GainzProSignal[] = [];
  for (const side of ["BUY", "SELL"] as const) {
    const parts: Array<Array<number | null>> = [
      bars.map((_, i) => candle(i, side)),
      side === "BUY" ? accel : neg(accel),
      vol,
      ...(params.trend ? [side === "BUY" ? slope : neg(slope)] : []),
    ];
    const s: Array<number | null> = new Array(n).fill(null);
    for (let i = 0; i < n; i++) {
      let sum = 0;
      let ok = true;
      for (const part of parts) {
        const r = rankAmong(part, i, params.window);
        if (r === null) {
          ok = false;
          break;
        }
        sum += r;
      }
      s[i] = ok ? sum / parts.length : null;
    }
    score[side] = s;
    for (let i = 0; i < n && i <= lastClosed; i++) {
      if (!structure(i, side)) continue;
      const rank = rankAmong(s, i, params.window);
      if (rank !== null && rank >= params.threshold) signals.push({ i, side, score: s[i] as number, rank });
    }
  }
  signals.sort((a, b) => a.i - b.i);
  return { score, signals };
};
