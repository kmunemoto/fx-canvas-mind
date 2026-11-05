// #396: the moving-average deviation rate (移動平均乖離率), a gauge common on
// Japanese charts:
//
//   (close − SMA(close, 25)) ÷ SMA(close, 25) × 100     (%)
//
// 25 bars, a number Japanese charts often use. A line at 0 only: how far is
// "too far" changes with the pair and the timeframe (not measured here), so
// no fixed overbought or oversold lines are drawn. A window whose average is
// not a finite number above zero has no value.
//
// How far the close is from its average, in percent: shown on the chart
// only, no signal is judged on it.

export interface MaDevParams {
  length: number;
}

export const MADEV_DEFAULTS: MaDevParams = { length: 25 };

export const maDeviation = (
  candles: ReadonlyArray<{ close: number }>,
  params: MaDevParams = MADEV_DEFAULTS,
): Array<number | null> => {
  const n = Math.max(1, Math.round(params.length));
  return candles.map((c, i) => {
    if (i < n - 1) return null;
    let sum = 0;
    for (let j = i - n + 1; j <= i; j++) sum += candles[j].close;
    const mean = sum / n;
    if (!Number.isFinite(mean) || !(mean > 0) || !Number.isFinite(c.close)) return null;
    return ((c.close - mean) / mean) * 100;
  });
};
