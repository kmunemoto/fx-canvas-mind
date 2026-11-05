// #396: Williams %R, as TradingView's built-in "Williams Percent Range"
// computes it (its settings: Length 14, Source close):
//
//   %R = 100 × (close − the highest high of the 14 bars)
//            / (the highest high − the lowest low of the 14 bars)
//
// 0 = the close at the 14 bars' highest high, −100 at their lowest low.
// Lines at −20, −50 and −80, the band between −20 and −80 shaded. A window
// with no range (its highest high equal to its lowest low) has no value.
//
// Where the close sits in its recent range, like the stochastic's %K turned
// to run from −100 to 0: above −20 is read as overbought and under −80 as
// oversold, but in a strong trend it can stay there. Shown on the chart only,
// no signal is judged on it.

export interface WillRParams {
  length: number;
}

export const WILLR_DEFAULTS: WillRParams = { length: 14 };
export const WILLR_LEVELS = { upper: -20, middle: -50, lower: -80 };

export const williamsR = (
  candles: ReadonlyArray<{ high: number; low: number; close: number }>,
  params: WillRParams = WILLR_DEFAULTS,
): Array<number | null> => {
  const n = Math.max(1, Math.round(params.length));
  return candles.map((c, i) => {
    if (i < n - 1) return null;
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = i - n + 1; j <= i; j++) {
      hi = Math.max(hi, candles[j].high);
      lo = Math.min(lo, candles[j].low);
    }
    // a window with a price that is not a finite number has no value either
    if (!Number.isFinite(hi) || !Number.isFinite(lo) || !(hi - lo > 0) || !Number.isFinite(c.close)) return null;
    return (100 * (c.close - hi)) / (hi - lo);
  });
};
