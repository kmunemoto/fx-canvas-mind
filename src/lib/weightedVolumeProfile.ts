// This file is subject to the terms of the Mozilla Public License 2.0 at
// https://mozilla.org/MPL/2.0/ — it is a TypeScript port of the open-source
// Pine Script "Weighted Volume Profile | Flux Charts" © fluxchart
// (TradingView script o8fvRI5E, version 2.0), whose code is under that
// licence.
//
// #122: the owner asked for it ("次はこれを追加して、コードも公開されてるよ").
// The port follows the published code at its default settings:
//
//   * The price range of the analysed candles (the newest 200, or all the
//     chart has) is cut into 30 rows from its high to its low.
//   * Each candle adds its weight to every row its wick range touches —
//     all of it to each row, not shared out — as bullish weight when it
//     closed above its open, bearish otherwise.
//   * Weighting "Normal" (the default): every candle counts the same.
//     "Recent" and "Past" (0.85 of the weight scaled by 1/(i+1), or by
//     (i+1)/N, plus 0.15) are kept for completeness.
//   * Each row is drawn as a bar, bullish then bearish, from the first
//     analysed candle rightwards ("Align To: Left"), 1 to 50 candles long
//     in proportion to its total (least to most); a third of a row's height
//     is left as the gap between rows.
//   * The Point Of Control: the row with the most in it (the lowest such
//     row on a tie, as the original's loop leaves it), drawn as a yellow
//     line from the end of its bar to the right edge.
//
// THE ONE DIFFERENCE: the original weighs each candle by its volume. GMO's
// FX candles (and Twelve Data's, the live chart's fallback) carry none, so
// here every candle weighs 1: a row's total is how many candles traded
// through it — the time price spent there, a TPO-style profile — not volume.
//
// Shown on the chart only: no signal, alert or record is judged on it.

export type VolumeWeighting = "Normal" | "Recent" | "Past";

export const WVP_DEFAULTS = {
  analyzeBars: 200,
  rowCount: 30,
  weighting: "Normal" as VolumeWeighting,
  maxRowSize: 50,
  weightImpact: 0.85,
};

type Bar = { open: number; high: number; low: number; close: number };

export interface ProfileRow {
  top: number;
  bottom: number;
  bull: number;
  bear: number;
  total: number;
  // the bar indices its bar spans: bullish part [start, start + bullSize],
  // bearish part after it, ending at `end`
  start: number;
  bullSize: number;
  bearSize: number;
  end: number;
}

export interface VolumeProfile {
  rows: ProfileRow[];
  // the gap left between rows, in price
  gap: number;
  // the row with the most in it, and its middle price
  poc: { row: number; price: number } | null;
  from: number;
  to: number;
}

export const weightOf = (weighting: VolumeWeighting, i: number, analyzeBars: number, impact = WVP_DEFAULTS.weightImpact): number => {
  if (weighting === "Recent") return impact / (i + 1) + (1 - impact);
  if (weighting === "Past") return impact * ((i + 1) / analyzeBars) + (1 - impact);
  return 1;
};

// `bars` oldest first; the profile is of the newest `analyzeBars` of them
export const weightedVolumeProfile = (bars: ReadonlyArray<Bar>, opts: Partial<typeof WVP_DEFAULTS> = {}): VolumeProfile | null => {
  const o = { ...WVP_DEFAULTS, ...opts };
  const n = bars.length;
  if (n === 0 || o.rowCount < 1) return null;
  const last = n - 1;
  const span = Math.min(o.analyzeBars, n);
  let top = -Infinity;
  let bottom = Infinity;
  for (let i = 0; i < span; i++) {
    top = Math.max(top, bars[last - i].high);
    bottom = Math.min(bottom, bars[last - i].low);
  }
  if (!(top > bottom)) return null;
  const step = (top - bottom) / o.rowCount;
  const gap = o.rowCount < 100 ? step / 3 : 0;
  const rows: ProfileRow[] = Array.from({ length: o.rowCount }, (_, x) => ({
    top: top - step * x,
    bottom: top - step * x - step,
    bull: 0, bear: 0, total: 0, start: 0, bullSize: 0, bearSize: 0, end: 0,
  }));
  // the original reads bars 0..analyzeBars from the newest, both ends in
  for (let i = 0; i <= Math.min(o.analyzeBars, last); i++) {
    const b = bars[last - i];
    const w = weightOf(o.weighting, i, o.analyzeBars, o.weightImpact);
    for (const row of rows) {
      if (b.low > row.top || b.high < row.bottom) continue;
      if (b.close > b.open) row.bull += w;
      else row.bear += w;
      row.total += w;
    }
  }
  let max = 0;
  let min = rows[0].total;
  let poc = -1;
  rows.forEach((r, k) => {
    max = Math.max(max, r.total);
    if (r.total === max) poc = k;
    min = Math.min(min, r.total);
  });
  const start = last - span + 1;
  for (const r of rows) {
    const size = max === min ? o.maxRowSize : 1 + ((r.total - min) * (o.maxRowSize - 1)) / (max - min);
    r.start = start;
    r.bullSize = r.total > 0 ? Math.round((r.bull / r.total) * size) : 0;
    r.bearSize = r.total > 0 ? Math.round((r.bear / r.total) * size) : 0;
    r.end = start + r.bullSize + r.bearSize;
  }
  return {
    rows,
    gap,
    poc: poc >= 0 && max > 0 ? { row: poc, price: (rows[poc].top + rows[poc].bottom) / 2 } : null,
    from: start,
    to: last,
  };
};
