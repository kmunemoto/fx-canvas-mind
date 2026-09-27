// #135: Bollinger Bands %b, as TradingView's built-in "Bollinger Bands %b"
// draws it (its help article 43000501971, and its settings: Length 20,
// Source close, StdDev 2):
//
//   bands = SMA(close, 20) ± 2 × the standard deviation of those closes
//   %b    = (close − lower band) / (upper band − lower band)
//
// The deviation is the population one (divided by the length), as Pine's
// ta.stdev is by default. 1 is the upper band, 0.5 the middle, 0 the lower;
// it goes past them when the close is outside the bands. A window whose
// closes are all equal has no bands and no value.
//
// Where the close sits in its recent spread, like the stochastic: shown on
// the chart only, no signal is judged on it.

export interface PercentBParams {
  length: number;
  mult: number;
}

export const PCTB_DEFAULTS: PercentBParams = { length: 20, mult: 2 };
export const PCTB_LEVELS = { upper: 1, middle: 0.5, lower: 0 };

export const percentB = (
  candles: ReadonlyArray<{ close: number }>,
  params: PercentBParams = PCTB_DEFAULTS,
): Array<number | null> => {
  const n = Math.max(1, Math.round(params.length));
  return candles.map((c, i) => {
    if (i < n - 1) return null;
    let sum = 0;
    for (let j = i - n + 1; j <= i; j++) sum += candles[j].close;
    const mean = sum / n;
    let v = 0;
    for (let j = i - n + 1; j <= i; j++) v += (candles[j].close - mean) ** 2;
    const width = 2 * params.mult * Math.sqrt(v / n);
    if (!(width > 0) || !Number.isFinite(c.close)) return null;
    return (c.close - (mean - params.mult * Math.sqrt(v / n))) / width;
  });
};
