// #117: the Stochastic oscillator, as TradingView's built-in "Stochastic"
// draws it (its help article 43000502332, "Stochastic (STOCH)"):
//
//   raw  = 100 × (close − lowest low) / (highest high − lowest low)
//          over the last `%K length` bars
//   %K   = SMA(raw, %K smoothing)
//   %D   = SMA(%K, %D smoothing)
//
// Defaults 14, 1, 3 (TradingView's), drawn with lines at 80, 50 and 20 and
// the band between 20 and 80 shaded. A window whose high and low are equal
// has no value (Pine divides by zero to na), and an average over a window
// with a missing value is missing too, as Pine's ta.sma is.
//
// Shown on the chart only: no signal is judged on it.

export interface StochParams {
  kLength: number;
  kSmoothing: number;
  dSmoothing: number;
}

export const STOCH_DEFAULTS: StochParams = { kLength: 14, kSmoothing: 1, dSmoothing: 3 };
export const STOCH_MAX = 100;
export const STOCH_LEVELS = { upper: 80, middle: 50, lower: 20 };

const whole = (v: unknown, fallback: number): number => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? Math.min(STOCH_MAX, Math.max(1, Math.round(n))) : fallback;
};

// Anything stored or typed, as lengths the calculation can use
export const normalizeStochParams = (v: unknown): StochParams => {
  const r = v !== null && typeof v === "object" ? (v as Record<string, unknown>) : {};
  return {
    kLength: whole(r.kLength, STOCH_DEFAULTS.kLength),
    kSmoothing: whole(r.kSmoothing, STOCH_DEFAULTS.kSmoothing),
    dSmoothing: whole(r.dSmoothing, STOCH_DEFAULTS.dSmoothing),
  };
};

const sma = (xs: Array<number | null>, n: number): Array<number | null> =>
  xs.map((_, i) => {
    if (i < n - 1) return null;
    let sum = 0;
    for (let j = i - n + 1; j <= i; j++) {
      const v = xs[j];
      if (v === null) return null;
      sum += v;
    }
    return sum / n;
  });

export const stochastic = (
  candles: ReadonlyArray<{ high: number; low: number; close: number }>,
  params: StochParams = STOCH_DEFAULTS,
): { k: Array<number | null>; d: Array<number | null> } => {
  const p = normalizeStochParams(params);
  const raw = candles.map((c, i) => {
    if (i < p.kLength - 1) return null;
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - p.kLength + 1; j <= i; j++) {
      hh = Math.max(hh, candles[j].high);
      ll = Math.min(ll, candles[j].low);
    }
    const range = hh - ll;
    if (!Number.isFinite(range) || range <= 0 || !Number.isFinite(c.close)) return null;
    return (100 * (c.close - ll)) / range;
  });
  const k = sma(raw, p.kSmoothing);
  return { k, d: sma(k, p.dSmoothing) };
};
