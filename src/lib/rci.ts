// #135: the Rank Correlation Index, as TradingView's built-in "RCI" computes
// it (its help article 43000765570, and its settings: Source close, RCI
// Length 10, smoothing SMA 14):
//
//   1. rank the last `length` closes in ascending order (the lowest 0, the
//      highest length − 1), closes that are equal sharing the mean of their
//      positions;
//   2. the correlation between those ranks and the bars' order in time,
//      times 100.
//
// +100: every close higher than the one before; −100: every one lower; near
// 0: no consistent direction. Drawn with lines at +80, 0 and −80 and a
// yellow SMA of it. A window whose closes are all equal has no value.
//
// How steadily the price has moved over the window, not a forecast: shown
// on the chart only, no signal is judged on it.

export interface RciParams {
  length: number;
  // the SMA drawn over it
  smoothing: number;
}

export const RCI_DEFAULTS: RciParams = { length: 10, smoothing: 14 };
export const RCI_LEVELS = { upper: 80, middle: 0, lower: -80 };

// the Pearson correlation of the average ranks with 0 … n − 1, × 100
const rciOfWindow = (w: number[]): number | null => {
  const n = w.length;
  const ranks = w.map((v) => {
    let below = 0;
    let equal = 0;
    for (const u of w) {
      if (u < v) below++;
      else if (u === v) equal++;
    }
    // positions below … below + equal − 1, averaged
    return below + (equal - 1) / 2;
  });
  const mt = (n - 1) / 2;
  const mr = ranks.reduce((s, r) => s + r, 0) / n;
  let num = 0;
  let vt = 0;
  let vr = 0;
  for (let i = 0; i < n; i++) {
    num += (i - mt) * (ranks[i] - mr);
    vt += (i - mt) ** 2;
    vr += (ranks[i] - mr) ** 2;
  }
  return vt > 0 && vr > 0 ? (100 * num) / Math.sqrt(vt * vr) : null;
};

const smaOf = (xs: Array<number | null>, n: number): Array<number | null> =>
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

export const rci = (
  candles: ReadonlyArray<{ close: number }>,
  params: RciParams = RCI_DEFAULTS,
): { rci: Array<number | null>; ma: Array<number | null> } => {
  const n = Math.max(2, Math.round(params.length));
  const closes = candles.map((c) => c.close);
  const out = closes.map((_, i) => (i < n - 1 ? null : rciOfWindow(closes.slice(i - n + 1, i + 1))));
  return { rci: out, ma: smaOf(out, Math.max(1, Math.round(params.smoothing))) };
};
