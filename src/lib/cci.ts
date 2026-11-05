// #396: the Commodity Channel Index, as TradingView's built-in "Commodity
// Channel Index" computes it (its settings: Length 20, Source hlc3; its
// smoothing line is off by default and not drawn here):
//
//   tp  = (high + low + close) / 3
//   cci = (tp − SMA(tp, 20)) / (0.015 × the mean absolute deviation of the
//         20 tp from that SMA)            (Pine's ta.dev)
//
// Lines at +100, 0 and −100, the band between them shaded. A window whose
// typical prices are all equal has no value.
//
// How far the price has gone from its recent average, scaled by its usual
// distance from it: past +100 or −100 is read as overbought or oversold, but
// in a strong trend it stays there. Shown on the chart only, no signal is
// judged on it.

export interface CciParams {
  length: number;
}

export const CCI_DEFAULTS: CciParams = { length: 20 };
export const CCI_LEVELS = { upper: 100, middle: 0, lower: -100 };

export const cci = (
  candles: ReadonlyArray<{ high: number; low: number; close: number }>,
  params: CciParams = CCI_DEFAULTS,
): Array<number | null> => {
  const n = Math.max(1, Math.round(params.length));
  const tp = candles.map((c) => (c.high + c.low + c.close) / 3);
  return candles.map((_, i) => {
    if (i < n - 1) return null;
    let sum = 0;
    for (let j = i - n + 1; j <= i; j++) sum += tp[j];
    const mean = sum / n;
    let dev = 0;
    for (let j = i - n + 1; j <= i; j++) dev += Math.abs(tp[j] - mean);
    dev /= n;
    if (!(dev > 0) || !Number.isFinite(tp[i])) return null;
    return (tp[i] - mean) / (0.015 * dev);
  });
};
