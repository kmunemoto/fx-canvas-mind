// The arithmetic behind research/bigflow.ts (#142): which indicator reads the
// big flow of a chart best. Kept apart from the downloading so the vitest
// suite can check it (src/test/bigflow.test.ts). Deno-free on purpose.
//
// The request: 「ストキャスってようは今のチャートの大きさ流れが読めないんですよ。
// チャートの大きな流れを読むのに一番適しているインジケーターを探してきて」.
//
// "The big flow", made measurable (fixed before any data was read):
//
//   * THE ANSWER KEY is the chart's swings as seen afterwards: a zigzag on
//     the closes that turns when the close comes back K × ATR(14) from the
//     leg's extreme (ATR on the bar that confirms the turn). Every bar
//     between two turns belongs to that leg: up from a low to the next high,
//     down from a high to the next low. Before the first turn and after the
//     last one (a leg still running) nothing is known, and those bars are not
//     scored. The chart shows 120 bars (live-chart CHART_BARS); K = 6 makes
//     a leg of the order of that on a random walk (primary), K = 3 and 12
//     are the smaller and the larger waves (reported, not used to choose).
//   * A READING is what an indicator says on a closed bar, from that bar and
//     the ones before only: up (+1), down (−1) or neither (0: in the cloud,
//     no Dow trend, ADX weak, not yet computed).
//   * THE SCORE is the share of scored bars read right, a "neither" counting
//     half (as a coin would). Every indicator is scored on the same bars.
//
// Indicators take their standard settings (TradingView's defaults, or the
// app's own for the ones on its chart); none is tuned.

import { emaSeries, rsiSeries, type Candle } from "../supabase/functions/analyze/indicators.ts";
import { adxSeries } from "../supabase/functions/analyze/state.ts";
import { dowTheory } from "../supabase/functions/_shared/dow.ts";
import { STOCH_DEFAULTS, stochastic } from "../src/lib/stochastic.ts";
import { pineAtr, supertrend } from "../src/lib/supertrend.ts";
import { utBot } from "../src/lib/utBot.ts";
import { kalmanSupertrend } from "../src/lib/kalmanSupertrend.ts";
import { zoneShift } from "../src/lib/zoneShift.ts";
import { ichimokuSeries, macdSeries, psarSeries, rciSeries, smaSeries, type Series } from "./indicator-series.ts";

export type Reading = Int8Array;

// ---- the answer key ---------------------------------------------------------------

export interface Zigzag {
  // +1 / −1: the leg the bar belongs to; 0: not known (before the first
  // turn, after the last)
  label: Int8Array;
  // the turns, oldest first: `top` a high (the leg before it went up)
  pivots: Array<{ i: number; top: boolean }>;
}

export const zigzag = (close: ReadonlyArray<number>, atr: ReadonlyArray<number | null>, k: number): Zigzag => {
  const n = close.length;
  const label = new Int8Array(n);
  const pivots: Zigzag["pivots"] = [];
  let dir = 0;
  let hi = Number.NaN, hiI = -1, lo = Number.NaN, loI = -1;
  let ext = Number.NaN, extI = -1;
  for (let i = 0; i < n; i++) {
    const a = atr[i];
    const c = close[i];
    if (dir === 0) {
      if (hiI < 0 || c > hi) {
        hi = c;
        hiI = i;
      }
      if (loI < 0 || c < lo) {
        lo = c;
        loI = i;
      }
      if (a === null || !(a > 0)) continue;
      const th = k * a;
      if (c - lo >= th && loI < i) {
        pivots.push({ i: loI, top: false });
        dir = 1;
        ext = c;
        extI = i;
      } else if (hi - c >= th && hiI < i) {
        pivots.push({ i: hiI, top: true });
        dir = -1;
        ext = c;
        extI = i;
      }
      continue;
    }
    if (dir === 1 ? c > ext : c < ext) {
      ext = c;
      extI = i;
      continue;
    }
    if (a === null || !(a > 0)) continue;
    if (Math.abs(ext - c) >= k * a) {
      pivots.push({ i: extI, top: dir === 1 });
      dir = -dir;
      ext = c;
      extI = i;
    }
  }
  for (let p = 1; p < pivots.length; p++) {
    const d = pivots[p].top ? 1 : -1;
    for (let i = pivots[p - 1].i + 1; i <= pivots[p].i; i++) label[i] = d;
  }
  return { label, pivots };
};

// ---- the candidates -----------------------------------------------------------------

export interface Candidate {
  id: string;
  ja: string;
  // on TradingView as a built-in, or on this app's chart
  where: "tv" | "app" | "tv+app";
}

export const CANDIDATES: readonly Candidate[] = [
  { id: "sma25", ja: "終値が単純移動平均(25)の上か下か", where: "tv" },
  { id: "sma75", ja: "終値が単純移動平均(75)の上か下か", where: "tv" },
  { id: "sma200", ja: "終値が単純移動平均(200)の上か下か", where: "tv" },
  { id: "ema50", ja: "終値が指数移動平均(50)の上か下か", where: "tv" },
  { id: "ema200", ja: "終値が指数移動平均(200)の上か下か", where: "tv" },
  { id: "sma75_slope", ja: "単純移動平均(75)の傾き（＝終値が75本前より上か）", where: "tv" },
  { id: "sma200_slope", ja: "単純移動平均(200)の傾き（＝終値が200本前より上か）", where: "tv" },
  { id: "cross_25_75", ja: "移動平均25と75の並び（ゴールデンクロス中か）", where: "tv" },
  { id: "cross_50_200", ja: "移動平均50と200の並び", where: "tv" },
  { id: "perfect_order", ja: "パーフェクトオーダー（25・75・200 が順に並んだときだけ）", where: "tv" },
  { id: "macd_zero", ja: "MACD(12,26) が0の上か下か", where: "tv" },
  { id: "macd_signal", ja: "MACD がシグナル(9)の上か下か", where: "tv" },
  { id: "dmi", ja: "DMI(14) の +DI と −DI のどちらが上か", where: "tv" },
  { id: "adx25", ja: "DMI の向き、ただし ADX(14) が25以上のときだけ", where: "tv" },
  { id: "ichimoku_cloud", ja: "一目均衡表: 終値が雲の上か下か（雲の中は無し）", where: "tv" },
  { id: "ichimoku_kijun", ja: "一目均衡表: 終値が基準線の上か下か", where: "tv" },
  { id: "ichimoku_chikou", ja: "一目均衡表: 遅行スパン（終値が26本前より上か）", where: "tv" },
  { id: "psar", ja: "パラボリックSAR(0.02, 0.2) の向き", where: "tv+app" },
  { id: "supertrend", ja: "SuperTrend(10, 3) の向き", where: "tv+app" },
  { id: "utbot", ja: "UT Bot(1, 10) の向き", where: "app" },
  { id: "spectra", ja: "SPECTRA型（カルマン・スーパートレンド）の向き", where: "app" },
  { id: "zoneshift", ja: "Zone Shift(100) の向き", where: "app" },
  { id: "dow", ja: "ダウ理論（アプリの判定）の上昇・下降トレンド", where: "app" },
  { id: "donchian20", ja: "ドンチャン・チャネル(20): 最後にどちらへ抜けたか", where: "tv" },
  { id: "donchian55", ja: "ドンチャン・チャネル(55): 最後にどちらへ抜けたか", where: "tv" },
  { id: "aroon", ja: "アルーン(14): Up と Down のどちらが上か", where: "tv" },
  { id: "vortex", ja: "ボルテックス(14): VI+ と VI− のどちらが上か", where: "tv" },
  { id: "linreg100", ja: "線形回帰(100) の傾き", where: "tv" },
  { id: "rci52", ja: "RCI(52)（長期RCI）が0の上か下か", where: "tv" },
  { id: "rsi", ja: "RSI(14) が50の上か下か", where: "tv+app" },
  { id: "stoch", ja: "ストキャス(14,1,3) の %K が50の上か下か（アプリの設定）", where: "tv+app" },
];

const sign = (x: number | null | undefined): number => (x === null || x === undefined || !Number.isFinite(x) || x === 0 ? 0 : x > 0 ? 1 : -1);
const vs = (a: Series | number[], b: Series | number[]): Reading => {
  const out = new Int8Array(a.length);
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    out[i] = x === null || y === null ? 0 : sign((x as number) - (y as number));
  }
  return out;
};
const fromSeries = (s: ArrayLike<number | null>, level = 0): Reading => {
  const out = new Int8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s[i] === null ? 0 : sign((s[i] as number) - level);
  return out;
};
const lagged = (close: number[], n: number): Series => close.map((_, i) => (i >= n ? close[i - n] : null));

// the last breakout of the previous `n` bars' channel, held until the other
export const donchianState = (c: ReadonlyArray<Candle>, n: number): Reading => {
  const out = new Int8Array(c.length);
  let s = 0;
  for (let i = n; i < c.length; i++) {
    let hh = -Infinity, ll = Infinity;
    for (let j = i - n; j < i; j++) {
      if (c[j].high > hh) hh = c[j].high;
      if (c[j].low < ll) ll = c[j].low;
    }
    if (c[i].close > hh) s = 1;
    else if (c[i].close < ll) s = -1;
    out[i] = s;
  }
  return out;
};

// TradingView's Aroon: 100 × (length + offset of the highest high (lowest
// low) among the last length + 1 bars) / length; the newest bar wins a tie
export const aroon = (c: ReadonlyArray<Candle>, n = 14): { up: Series; down: Series } => {
  const up: Series = c.map(() => null);
  const down: Series = c.map(() => null);
  for (let i = n; i < c.length; i++) {
    let hi = i, lo = i;
    for (let j = i - 1; j >= i - n; j--) {
      if (c[j].high > c[hi].high) hi = j;
      if (c[j].low < c[lo].low) lo = j;
    }
    up[i] = (100 * (n - (i - hi))) / n;
    down[i] = (100 * (n - (i - lo))) / n;
  }
  return { up, down };
};

// TradingView's Vortex: the sums of |high − previous low| and |low −
// previous high| over `n` bars, each over the sum of the true range
export const vortex = (c: ReadonlyArray<Candle>, n = 14): { plus: Series; minus: Series } => {
  const plus: Series = c.map(() => null);
  const minus: Series = c.map(() => null);
  for (let i = n; i < c.length; i++) {
    let vp = 0, vm = 0, tr = 0;
    for (let j = i - n + 1; j <= i; j++) {
      vp += Math.abs(c[j].high - c[j - 1].low);
      vm += Math.abs(c[j].low - c[j - 1].high);
      tr += Math.max(c[j].high - c[j].low, Math.abs(c[j].high - c[j - 1].close), Math.abs(c[j].low - c[j - 1].close));
    }
    if (tr > 0) {
      plus[i] = vp / tr;
      minus[i] = vm / tr;
    }
  }
  return { plus, minus };
};

// the least-squares slope of the last `n` closes against time
export const linregSlope = (close: ReadonlyArray<number>, n = 100): Series => {
  const out: Series = close.map(() => null);
  const xm = (n - 1) / 2;
  let sxx = 0;
  for (let x = 0; x < n; x++) sxx += (x - xm) ** 2;
  for (let i = n - 1; i < close.length; i++) {
    let ym = 0;
    for (let j = 0; j < n; j++) ym += close[i - n + 1 + j];
    ym /= n;
    let sxy = 0;
    for (let j = 0; j < n; j++) sxy += (j - xm) * (close[i - n + 1 + j] - ym);
    out[i] = sxy / sxx;
  }
  return out;
};

// every candidate's reading at every bar of one chart (all bars closed)
export const readingsOf = (c: Candle[]): Record<string, Reading> => {
  const close = c.map((b) => b.close);
  const sma = (n: number) => smaSeries(close, n);
  const s25 = sma(25), s50 = sma(50), s75 = sma(75), s200 = sma(200);
  const e50 = emaSeries(close, 50), e200 = emaSeries(close, 200);
  const macd = macdSeries(close);
  const dmi = adxSeries(c);
  const plus = dmi.map((d) => d.plusDI), minus = dmi.map((d) => d.minusDI);
  const ichi = ichimokuSeries(c);
  const psar = psarSeries(c);
  const st = supertrend(c);
  const ut = utBot(c);
  const ks = kalmanSupertrend(c);
  const zs = zoneShift(c);
  const dow = dowTheory(c).states;
  const ar = aroon(c, 14);
  const vx = vortex(c, 14);
  const out: Record<string, Reading> = {
    sma25: vs(close, s25),
    sma75: vs(close, s75),
    sma200: vs(close, s200),
    ema50: vs(close, e50),
    ema200: vs(close, e200),
    sma75_slope: vs(close, lagged(close, 75)),
    sma200_slope: vs(close, lagged(close, 200)),
    cross_25_75: vs(s25, s75),
    cross_50_200: vs(s50, s200),
    macd_zero: fromSeries(macd.macd),
    macd_signal: vs(macd.macd, macd.signal),
    dmi: vs(plus, minus),
    ichimoku_kijun: vs(close, ichi.kijun),
    ichimoku_chikou: vs(close, lagged(close, 26)),
    donchian20: donchianState(c, 20),
    donchian55: donchianState(c, 55),
    aroon: vs(ar.up, ar.down),
    vortex: vs(vx.plus, vx.minus),
    linreg100: fromSeries(linregSlope(close, 100)),
    rci52: fromSeries(rciSeries(close, 52)),
    rsi: fromSeries(rsiSeries(close, 14), 50),
    stoch: fromSeries(stochastic(c, STOCH_DEFAULTS).k, 50),
  };
  const po = new Int8Array(c.length);
  const adx = new Int8Array(c.length);
  const cloud = new Int8Array(c.length);
  const ps = new Int8Array(c.length);
  const stR = new Int8Array(c.length);
  const utR = new Int8Array(c.length);
  const ksR = new Int8Array(c.length);
  const zsR = new Int8Array(c.length);
  const dowR = new Int8Array(c.length);
  // Zone Shift starts "down" until its first uptrend: nothing is read
  // before the trend has turned once
  let zsStarted = false;
  for (let i = 0; i < c.length; i++) {
    const a = s25[i], b = s75[i], d = s200[i];
    po[i] = a === null || b === null || d === null ? 0 : a > b && b > d ? 1 : a < b && b < d ? -1 : 0;
    const x = dmi[i].adx;
    adx[i] = x !== null && x >= 25 ? out.dmi[i] : 0;
    const top = ichi.cloudTop[i], bot = ichi.cloudBottom[i];
    cloud[i] = top === null || bot === null ? 0 : close[i] > top ? 1 : close[i] < bot ? -1 : 0;
    ps[i] = psar.long[i] === null ? 0 : psar.long[i] ? 1 : -1;
    stR[i] = st.trend[i] ?? 0;
    utR[i] = ut.side[i] ?? 0;
    ksR[i] = ks.trend[i] ?? 0;
    if (i > 0 && zs.up[i] !== zs.up[i - 1]) zsStarted = true;
    zsR[i] = zsStarted ? (zs.up[i] ? 1 : -1) : 0;
    dowR[i] = dow[i] === "up" ? 1 : dow[i] === "down" ? -1 : 0;
  }
  Object.assign(out, {
    perfect_order: po,
    adx25: adx,
    ichimoku_cloud: cloud,
    psar: ps,
    supertrend: stR,
    utbot: utR,
    spectra: ksR,
    zoneshift: zsR,
    dow: dowR,
  });
  return out;
};

// ---- scoring ------------------------------------------------------------------------

// a reading against the answer key: right 1, wrong 0, "neither" a half
export const credit = (reading: number, label: number): number => (reading === 0 ? 0.5 : reading === label ? 1 : 0);

// directional changes of a reading (a "neither" in between is not a change)
export const flipsOf = (r: ArrayLike<number>, from: number, to: number): number => {
  let last = 0, flips = 0;
  for (let i = from; i <= to && i < r.length; i++) {
    const v = r[i];
    if (v === 0) continue;
    if (last !== 0 && v !== last) flips++;
    last = v;
  }
  return flips;
};

// For each leg that begins at or after `from`: the bars after its first bar
// until the reading first shows its direction (0: already on the first bar
// of the leg), or null when it never does before the leg ends
export const lagsOf = (r: ArrayLike<number>, z: Zigzag, from: number): Array<{ start: number; lag: number | null; length: number }> => {
  const out: Array<{ start: number; lag: number | null; length: number }> = [];
  for (let p = 1; p < z.pivots.length; p++) {
    const start = z.pivots[p - 1].i + 1;
    const end = z.pivots[p].i;
    if (start < from) continue;
    const d = z.pivots[p].top ? 1 : -1;
    let lag: number | null = null;
    for (let i = start; i <= end; i++) {
      if (r[i] === d) {
        lag = i - start;
        break;
      }
    }
    out.push({ start, lag, length: end - start + 1 });
  }
  return out;
};

// ---- the interval: clustered by calendar month ------------------------------------

// per cluster (month) and per timeframe: the sum of the scores and the count
export type Cells = Map<string, Map<string, { s: number; n: number }>>;

export const addCell = (cells: Cells, cluster: string, tf: string, s: number, n = 1) => {
  let m = cells.get(cluster);
  if (!m) cells.set(cluster, (m = new Map()));
  const c = m.get(tf) ?? { s: 0, n: 0 };
  c.s += s;
  c.n += n;
  m.set(tf, c);
};

// The mean over timeframes of each timeframe's share (each timeframe
// counts the same, however many bars it has), with its standard error
// clustered by month (the delta method); `minus` for a paired difference
// between two readings scored on the same bars
export const tfMean = (cells: Cells, tfs: readonly string[], minus?: Cells): { est: number; se: number; n: number } | null => {
  const clusters = new Set([...cells.keys(), ...(minus ? minus.keys() : [])]);
  const totals = (x: Cells) => {
    const t = new Map<string, { s: number; n: number }>();
    for (const m of x.values()) {
      for (const [tf, c] of m) {
        const a = t.get(tf) ?? { s: 0, n: 0 };
        a.s += c.s;
        a.n += c.n;
        t.set(tf, a);
      }
    }
    return t;
  };
  const A = totals(cells);
  const B = minus ? totals(minus) : null;
  const used = tfs.filter((tf) => (A.get(tf)?.n ?? 0) > 0 && (!B || (B.get(tf)?.n ?? 0) > 0));
  if (used.length === 0) return null;
  const share = (t: Map<string, { s: number; n: number }>, tf: string) => t.get(tf)!.s / t.get(tf)!.n;
  let est = 0;
  for (const tf of used) est += (share(A, tf) - (B ? share(B, tf) : 0)) / used.length;
  let v = 0;
  for (const k of clusters) {
    let u = 0;
    for (const tf of used) {
      const a = cells.get(k)?.get(tf);
      if (a) u += (a.s - share(A, tf) * a.n) / A.get(tf)!.n / used.length;
      if (B) {
        const b = minus!.get(k)?.get(tf);
        if (b) u -= (b.s - share(B, tf) * b.n) / B.get(tf)!.n / used.length;
      }
    }
    v += u * u;
  }
  const C = clusters.size;
  const n = used.reduce((s, tf) => s + A.get(tf)!.n, 0);
  return { est, se: C > 1 ? Math.sqrt((C / (C - 1)) * v) : Number.NaN, n };
};

// the chart turned upside down about `pivot`: every price p becomes
// 2·pivot − p, high and low swapped (prices stay positive)
export const flipped = (c: ReadonlyArray<Candle>, pivot: number): Candle[] =>
  c.map((b) => ({ datetime: b.datetime, open: 2 * pivot - b.open, high: 2 * pivot - b.low, low: 2 * pivot - b.high, close: 2 * pivot - b.close }));

export { pineAtr };
