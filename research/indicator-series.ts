// The indicators a trader times entries with, as causal series, and the
// textbook buy/sell rule each is used with (#102).
//
// Every series is aligned index-for-index with the candles it was computed
// from and reads nothing after its own bar: the value at bar i uses bars
// 0..i only. Where the app already computes an indicator, the series is
// built on the app's own arithmetic (analyze/indicators.ts, analyze/state.ts)
// or is checked against it in src/test/indicator-series.test.ts, so "RSI" in
// the study is the RSI the analysis prints.
//
// Parameters are the standard ones and were not tuned. Tuning them on the
// same history the winner is chosen from would hand the prize to whichever
// indicator has the most knobs.
//
// Each rule is written for the BUY side and its SELL side is the mirror
// image: a rule's SELL events on a chart are its BUY events on the chart
// turned upside down. The test suite pins that, so no indicator is helped or
// hurt by an asymmetry in how its two sides were written.

import { emaSeries, rsiSeries, type Candle } from "../supabase/functions/analyze/indicators.ts";
import { adxSeries } from "../supabase/functions/analyze/state.ts";

export type Series = Array<number | null>;

export const smaSeries = (values: number[], period: number): Series => {
  const out: Series = values.map(() => null);
  for (let i = period - 1; i < values.length; i++) {
    let s = 0;
    for (let j = i - period + 1; j <= i; j++) s += values[j];
    out[i] = s / period;
  }
  return out;
};

// MACD line and its signal line, the way indicators.macd computes the last
// pair: EMA12 - EMA26 from the 26th bar, signal = EMA9 of that line.
export const macdSeries = (closes: number[], fast = 12, slow = 26, signal = 9): { macd: Series; signal: Series } => {
  const f = emaSeries(closes, fast);
  const s = emaSeries(closes, slow);
  const line: Series = closes.map((_, i) => (f[i] !== null && s[i] !== null ? (f[i] as number) - (s[i] as number) : null));
  const start = slow - 1;
  const values = line.slice(start).filter((v): v is number => v !== null);
  const sig = emaSeries(values, signal);
  return { macd: line, signal: closes.map((_, i) => (i >= start ? sig[i - start] ?? null : null)) };
};

// Bollinger bands with the population deviation, as indicators.bollinger.
export const bollingerSeries = (closes: number[], period = 20, mult = 2): { upper: Series; middle: Series; lower: Series } => {
  const middle = smaSeries(closes, period);
  const upper: Series = closes.map(() => null);
  const lower: Series = closes.map(() => null);
  for (let i = period - 1; i < closes.length; i++) {
    const m = middle[i] as number;
    let v = 0;
    for (let j = i - period + 1; j <= i; j++) v += (closes[j] - m) ** 2;
    const sd = Math.sqrt(v / period);
    upper[i] = m + mult * sd;
    lower[i] = m - mult * sd;
  }
  return { upper, middle, lower };
};

// Slow stochastic %K and %D, as indicators.stochastic.
export const stochSeries = (candles: Candle[], kPeriod = 14, kSmooth = 3, dSmooth = 3): { k: Series; d: Series } => {
  const n = candles.length;
  const fast: Series = candles.map(() => null);
  for (let i = kPeriod - 1; i < n; i++) {
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - kPeriod + 1; j <= i; j++) {
      hh = Math.max(hh, candles[j].high);
      ll = Math.min(ll, candles[j].low);
    }
    fast[i] = hh === ll ? 50 : ((candles[i].close - ll) / (hh - ll)) * 100;
  }
  const avg = (src: Series, p: number): Series =>
    src.map((_, i) => {
      if (i < p - 1) return null;
      let s = 0;
      for (let j = i - p + 1; j <= i; j++) {
        const v = src[j];
        if (v === null) return null;
        s += v;
      }
      return s / p;
    });
  const k = avg(fast, kSmooth);
  return { k, d: avg(k, dSmooth) };
};

const midRange = (candles: Candle[], i: number, period: number): number | null => {
  if (i < period - 1) return null;
  let hh = -Infinity;
  let ll = Infinity;
  for (let j = i - period + 1; j <= i; j++) {
    hh = Math.max(hh, candles[j].high);
    ll = Math.min(ll, candles[j].low);
  }
  return (hh + ll) / 2;
};

// Ichimoku: tenkan and kijun where they are computed, and the cloud standing
// AT each bar — the spans computed 26 bars earlier (indicators.cloudAt).
export const ichimokuSeries = (candles: Candle[], shift = 26): { tenkan: Series; kijun: Series; cloudTop: Series; cloudBottom: Series } => {
  const tenkan = candles.map((_, i) => midRange(candles, i, 9));
  const kijun = candles.map((_, i) => midRange(candles, i, 26));
  const spanB = candles.map((_, i) => midRange(candles, i, 52));
  const spanA: Series = candles.map((_, i) => (tenkan[i] !== null && kijun[i] !== null ? ((tenkan[i] as number) + (kijun[i] as number)) / 2 : null));
  const at = (src: Series, i: number) => (i - shift >= 0 ? src[i - shift] : null);
  const cloudTop: Series = candles.map((_, i) => {
    const a = at(spanA, i);
    const b = at(spanB, i);
    return a === null || b === null ? null : Math.max(a, b);
  });
  const cloudBottom: Series = candles.map((_, i) => {
    const a = at(spanA, i);
    const b = at(spanB, i);
    return a === null || b === null ? null : Math.min(a, b);
  });
  return { tenkan, kijun, cloudTop, cloudBottom };
};

// Wilder's Parabolic SAR. `long[i]` is the side the SAR puts price on after
// bar i closes; a flip is a change of that side.
export const psarSeries = (candles: Candle[], step = 0.02, max = 0.2): { sar: Series; long: Array<boolean | null> } => {
  const n = candles.length;
  const sar: Series = candles.map(() => null);
  const long: Array<boolean | null> = candles.map(() => null);
  if (n < 3) return { sar, long };
  let up = candles[1].close > candles[0].close;
  let s = up ? candles[0].low : candles[0].high;
  let ep = up ? candles[1].high : candles[1].low;
  let af = step;
  sar[1] = s;
  long[1] = up;
  for (let i = 2; i < n; i++) {
    const c = candles[i];
    let next = s + af * (ep - s);
    if (up) {
      next = Math.min(next, candles[i - 1].low, candles[i - 2].low);
      if (c.low < next) {
        up = false;
        next = ep;
        ep = c.low;
        af = step;
      } else if (c.high > ep) {
        ep = c.high;
        af = Math.min(af + step, max);
      }
    } else {
      next = Math.max(next, candles[i - 1].high, candles[i - 2].high);
      if (c.high > next) {
        up = true;
        next = ep;
        ep = c.high;
        af = step;
      } else if (c.low < ep) {
        ep = c.low;
        af = Math.min(af + step, max);
      }
    }
    s = next;
    sar[i] = s;
    long[i] = up;
  }
  return { sar, long };
};

// Lambert's CCI on the typical price.
export const cciSeries = (candles: Candle[], period = 20): Series => {
  const tp = candles.map((c) => (c.high + c.low + c.close) / 3);
  const m = smaSeries(tp, period);
  return candles.map((_, i) => {
    const mean = m[i];
    if (mean === null) return null;
    let md = 0;
    for (let j = i - period + 1; j <= i; j++) md += Math.abs(tp[j] - mean);
    md /= period;
    return md === 0 ? null : (tp[i] - mean) / (0.015 * md);
  });
};

// Highest high and lowest low of the last `period` bars, this one included.
export const donchianSeries = (candles: Candle[], period = 20): { high: Series; low: Series } => {
  const high: Series = candles.map(() => null);
  const low: Series = candles.map(() => null);
  for (let i = period - 1; i < candles.length; i++) {
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      hh = Math.max(hh, candles[j].high);
      ll = Math.min(ll, candles[j].low);
    }
    high[i] = hh;
    low[i] = ll;
  }
  return { high, low };
};

// RCI (rank correlation index): Spearman's correlation between the order of
// the bars in time (newest first) and the order of their closes (highest
// first), times 100. +100 is a window in which every close was higher than
// the one before. Ties in price take the average of their ranks.
export const rciSeries = (closes: number[], period = 9): Series => {
  const out: Series = closes.map(() => null);
  const denom = period * (period * period - 1);
  for (let i = period - 1; i < closes.length; i++) {
    const w = closes.slice(i - period + 1, i + 1);
    let sum = 0;
    for (let a = 0; a < period; a++) {
      // time rank: newest (a = period - 1) is 1
      const timeRank = period - a;
      let higher = 0;
      let equal = 0;
      for (let b = 0; b < period; b++) {
        if (w[b] > w[a]) higher++;
        else if (w[b] === w[a]) equal++;
      }
      const priceRank = higher + (equal + 1) / 2;
      sum += (timeRank - priceRank) ** 2;
    }
    out[i] = (1 - (6 * sum) / denom) * 100;
  }
  return out;
};

// ---- the rules -------------------------------------------------------------

export interface Bundle {
  close: number[];
  rsi: Series;
  macd: { macd: Series; signal: Series };
  sma: Record<5 | 25 | 50 | 75 | 200, Series>;
  bb: { upper: Series; middle: Series; lower: Series };
  stoch: { k: Series; d: Series };
  ichi: ReturnType<typeof ichimokuSeries>;
  psar: ReturnType<typeof psarSeries>;
  dmi: { plus: Series; minus: Series; adx: Series };
  cci: Series;
  dc: { high: Series; low: Series };
  rci: Series;
}

export const bundleOf = (candles: Candle[]): Bundle => {
  const close = candles.map((c) => c.close);
  const dmi = adxSeries(candles);
  return {
    close,
    rsi: rsiSeries(close, 14),
    macd: macdSeries(close),
    sma: { 5: smaSeries(close, 5), 25: smaSeries(close, 25), 50: smaSeries(close, 50), 75: smaSeries(close, 75), 200: smaSeries(close, 200) },
    bb: bollingerSeries(close),
    stoch: stochSeries(candles),
    ichi: ichimokuSeries(candles),
    psar: psarSeries(candles),
    dmi: { plus: dmi.map((d) => d.plusDI), minus: dmi.map((d) => d.minusDI), adx: dmi.map((d) => d.adx) },
    cci: cciSeries(candles),
    dc: donchianSeries(candles),
    rci: rciSeries(close, 9),
  };
};

type Line = Series | number;
const at = (x: Line, i: number): number | null => (typeof x === "number" ? x : i >= 0 && i < x.length ? x[i] : null);

// a crossed above b at bar i: at or below it on the bar before, above it now
export const crossUp = (a: Line, b: Line, i: number): boolean => {
  const a0 = at(a, i - 1), a1 = at(a, i), b0 = at(b, i - 1), b1 = at(b, i);
  return a0 !== null && a1 !== null && b0 !== null && b1 !== null && a0 <= b0 && a1 > b1;
};
// the exact mirror of crossUp
export const crossDown = (a: Line, b: Line, i: number): boolean => {
  const a0 = at(a, i - 1), a1 = at(a, i), b0 = at(b, i - 1), b1 = at(b, i);
  return a0 !== null && a1 !== null && b0 !== null && b1 !== null && a0 >= b0 && a1 < b1;
};

export interface Rule {
  id: string;
  // The indicator the rule belongs to; the study's answer is one of these
  indicator: string;
  // What the rule does, in the words the report uses
  ja: string;
  buy: (b: Bundle, i: number) => boolean;
  sell: (b: Bundle, i: number) => boolean;
}

export const RULES: readonly Rule[] = [
  {
    id: "rsi_30_70",
    indicator: "RSI",
    ja: "RSI(14) が30を下から上に抜けたら買い、70を上から下に抜けたら売り",
    buy: (b, i) => crossUp(b.rsi, 30, i),
    sell: (b, i) => crossDown(b.rsi, 70, i),
  },
  {
    id: "rsi_50",
    indicator: "RSI",
    ja: "RSI(14) が50を上に抜けたら買い、下に抜けたら売り",
    buy: (b, i) => crossUp(b.rsi, 50, i),
    sell: (b, i) => crossDown(b.rsi, 50, i),
  },
  {
    id: "macd_signal",
    indicator: "MACD",
    ja: "MACD(12,26,9) がシグナル線を上に抜けたら買い、下に抜けたら売り",
    buy: (b, i) => crossUp(b.macd.macd, b.macd.signal, i),
    sell: (b, i) => crossDown(b.macd.macd, b.macd.signal, i),
  },
  {
    id: "macd_zero",
    indicator: "MACD",
    ja: "MACD がゼロを上に抜けたら買い、下に抜けたら売り",
    buy: (b, i) => crossUp(b.macd.macd, 0, i),
    sell: (b, i) => crossDown(b.macd.macd, 0, i),
  },
  {
    id: "sma_5_25",
    indicator: "移動平均線",
    ja: "5本と25本の移動平均のゴールデンクロスで買い、デッドクロスで売り",
    buy: (b, i) => crossUp(b.sma[5], b.sma[25], i),
    sell: (b, i) => crossDown(b.sma[5], b.sma[25], i),
  },
  {
    id: "sma_25_75",
    indicator: "移動平均線",
    ja: "25本と75本の移動平均のゴールデンクロスで買い、デッドクロスで売り",
    buy: (b, i) => crossUp(b.sma[25], b.sma[75], i),
    sell: (b, i) => crossDown(b.sma[25], b.sma[75], i),
  },
  {
    id: "sma_50_200",
    indicator: "移動平均線",
    ja: "50本と200本の移動平均のゴールデンクロスで買い、デッドクロスで売り",
    buy: (b, i) => crossUp(b.sma[50], b.sma[200], i),
    sell: (b, i) => crossDown(b.sma[50], b.sma[200], i),
  },
  {
    id: "bb_return",
    indicator: "ボリンジャーバンド",
    ja: "終値が-2σの外から内に戻ったら買い、+2σの外から内に戻ったら売り",
    buy: (b, i) => crossUp(b.close, b.bb.lower, i),
    sell: (b, i) => crossDown(b.close, b.bb.upper, i),
  },
  {
    id: "bb_break",
    indicator: "ボリンジャーバンド",
    ja: "終値が+2σを上に抜けたら買い、-2σを下に抜けたら売り",
    buy: (b, i) => crossUp(b.close, b.bb.upper, i),
    sell: (b, i) => crossDown(b.close, b.bb.lower, i),
  },
  {
    id: "stoch_20_80",
    indicator: "ストキャスティクス",
    ja: "スローストキャスティクス(14,3,3) の%Kが%Dを20未満で上に抜けたら買い、80超で下に抜けたら売り",
    buy: (b, i) => crossUp(b.stoch.k, b.stoch.d, i) && (at(b.stoch.d, i) as number) < 20,
    sell: (b, i) => crossDown(b.stoch.k, b.stoch.d, i) && (at(b.stoch.d, i) as number) > 80,
  },
  {
    id: "ichimoku_tk",
    indicator: "一目均衡表",
    ja: "転換線が基準線を上に抜けたら買い、下に抜けたら売り",
    buy: (b, i) => crossUp(b.ichi.tenkan, b.ichi.kijun, i),
    sell: (b, i) => crossDown(b.ichi.tenkan, b.ichi.kijun, i),
  },
  {
    id: "ichimoku_cloud",
    indicator: "一目均衡表",
    ja: "終値が雲の上に抜けたら買い、雲の下に抜けたら売り",
    buy: (b, i) => crossUp(b.close, b.ichi.cloudTop, i),
    sell: (b, i) => crossDown(b.close, b.ichi.cloudBottom, i),
  },
  {
    id: "psar_flip",
    indicator: "パラボリックSAR",
    ja: "パラボリックSAR(0.02,0.2) が価格の下に転換したら買い、上に転換したら売り",
    buy: (b, i) => b.psar.long[i] === true && b.psar.long[i - 1] === false,
    sell: (b, i) => b.psar.long[i] === false && b.psar.long[i - 1] === true,
  },
  {
    id: "dmi_cross",
    indicator: "DMI",
    ja: "+DIが-DIを上に抜けたら買い、下に抜けたら売り (14)",
    buy: (b, i) => crossUp(b.dmi.plus, b.dmi.minus, i),
    sell: (b, i) => crossDown(b.dmi.plus, b.dmi.minus, i),
  },
  {
    id: "cci_100",
    indicator: "CCI",
    ja: "CCI(20) が+100を上に抜けたら買い、-100を下に抜けたら売り",
    buy: (b, i) => crossUp(b.cci, 100, i),
    sell: (b, i) => crossDown(b.cci, -100, i),
  },
  {
    id: "donchian_20",
    indicator: "ドンチャン・チャネル",
    ja: "終値が直前20本の高値を初めて上に抜けたら買い、安値を下に抜けたら売り",
    buy: (b, i) => crossUp(b.close, shifted(b.dc.high), i),
    sell: (b, i) => crossDown(b.close, shifted(b.dc.low), i),
  },
  {
    id: "rci_9",
    indicator: "RCI",
    ja: "RCI(9) が-80を下から上に抜けたら買い、+80を上から下に抜けたら売り",
    buy: (b, i) => crossUp(b.rci, -80, i),
    sell: (b, i) => crossDown(b.rci, 80, i),
  },
];

// The channel of the bars BEFORE this one, so that a close can break it.
// Memoised per series: the rules run once per bar.
const shiftedCache = new WeakMap<Series, Series>();
const shifted = (s: Series): Series => {
  let out = shiftedCache.get(s);
  if (!out) {
    out = s.map((_, i) => (i >= 1 ? s[i - 1] : null));
    shiftedCache.set(s, out);
  }
  return out;
};

// +1 at a bar where the rule says buy, -1 where it says sell, 0 elsewhere
// (and 0 on the impossible bar where it says both).
export const signalsOf = (candles: Candle[], rules: readonly Rule[] = RULES): Record<string, Int8Array> => {
  const b = bundleOf(candles);
  const out: Record<string, Int8Array> = {};
  for (const r of rules) {
    const s = new Int8Array(candles.length);
    for (let i = 1; i < candles.length; i++) {
      const buy = r.buy(b, i);
      const sell = r.sell(b, i);
      s[i] = buy && !sell ? 1 : sell && !buy ? -1 : 0;
    }
    out[r.id] = s;
  }
  return out;
};

// The chart turned upside down: every price negated, high and low swapped.
export const mirrored = (candles: Candle[]): Candle[] =>
  candles.map((c) => ({ datetime: c.datetime, open: -c.open, high: -c.low, low: -c.high, close: -c.close }));
