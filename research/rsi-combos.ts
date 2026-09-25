// RSI and one other indicator: which partner makes RSI's calls come true
// more often? (#103)
//
// The request: 「rsiと何を組み合わせて分析するのが一番チャートの上がり下がり、
// 反発などが当たっているかたくさんの過去のチャートから調べてください」 — and
// explicitly NOT all indicators at once.
//
// Two RSI signals are the base, one for each thing the request names:
//
//   * bounce (反発): RSI(14) back up through 30 is a buy, back down through
//     70 is a sell. This was the best single rule in #102.
//   * trend (上がり下がり): RSI(14) up through 50 is a buy, down through 50
//     a sell.
//
// Each partner adds ONE condition that must hold on the signal bar. It is
// the condition that partner is textbook-paired with RSI for, fixed before
// any data was read:
//
//   * a trend partner confirms the direction (price above the 200-bar
//     average, MACD above its signal, above the cloud, ...), so a bounce is
//     only bought in an uptrend;
//   * an oscillator partner confirms the extreme (the stochastic, CCI or
//     RCI was oversold in the last three bars, price touched the lower
//     Bollinger band or made a 20-bar low), so a bounce is only bought when
//     a second gauge agrees it was stretched;
//   * ADX says whether there is a trend at all: bounces in a range (ADX
//     under 20), crosses of 50 in a strong trend going the same way.
//
// Every condition is written for a BUY and mirrored for a SELL; the test
// suite turns charts upside down to pin that. None reads a later bar.

import type { Candle } from "../supabase/functions/analyze/indicators.ts";
import { bundleOf, crossDown, crossUp, type Bundle, type Series } from "./indicator-series.ts";

export type Dir = 1 | -1;
export type Trend = "up" | "down";

export interface Ctx {
  b: Bundle;
  high: number[];
  low: number[];
  // The trend of the next timeframe up, as of this bar's close: its last
  // closed bar above ("up") or below ("down") its own 50-bar average
  htf: Array<Trend | null>;
}

export const ctxOf = (candles: Candle[], htf: Array<Trend | null>): Ctx => ({
  b: bundleOf(candles),
  high: candles.map((c) => c.high),
  low: candles.map((c) => c.low),
  htf,
});

export interface Base {
  id: "bounce" | "trend";
  ja: string;
  at: (c: Ctx, i: number) => 0 | Dir;
}

export const BASES: readonly Base[] = [
  {
    id: "bounce",
    ja: "RSIの反発（30を下から上に抜けたら買い、70を上から下に抜けたら売り）",
    at: (c, i) => (crossUp(c.b.rsi, 30, i) ? 1 : crossDown(c.b.rsi, 70, i) ? -1 : 0),
  },
  {
    id: "trend",
    ja: "RSIの50越え（50を上に抜けたら買い、下に抜けたら売り）",
    at: (c, i) => (crossUp(c.b.rsi, 50, i) ? 1 : crossDown(c.b.rsi, 50, i) ? -1 : 0),
  },
];

const v = (s: Series, i: number): number | null => (i >= 0 && i < s.length ? s[i] : null);
// a is on the signal's side of b: above it for a buy, below it for a sell
const beyond = (a: Series | number[], b: Series | number, i: number, d: Dir): boolean => {
  const x = v(a as Series, i);
  const y = typeof b === "number" ? b : v(b, i);
  return x !== null && y !== null && (d === 1 ? x > y : x < y);
};
// true on this bar or either of the two before it
const within3 = (f: (j: number) => boolean, i: number) => f(i) || f(i - 1) || f(i - 2);
const below = (s: Series, level: number, j: number, d: Dir) => {
  const x = v(s, j);
  return x !== null && (d === 1 ? x < level : x > 100 - level);
};

export interface Partner {
  id: string;
  indicator: string;
  // what the partner must say, for each base
  bounce: { ja: string; ok: (c: Ctx, i: number, d: Dir) => boolean };
  trend: { ja: string; ok: (c: Ctx, i: number, d: Dir) => boolean };
}

export const PARTNERS: readonly Partner[] = [
  {
    id: "ma200",
    indicator: "移動平均線",
    bounce: { ja: "価格が200本移動平均より上（売りは下）", ok: (c, i, d) => beyond(c.b.close, c.b.sma[200], i, d) },
    trend: { ja: "価格が200本移動平均より上（売りは下）", ok: (c, i, d) => beyond(c.b.close, c.b.sma[200], i, d) },
  },
  {
    id: "macd",
    indicator: "MACD",
    bounce: { ja: "MACDがシグナル線より上（売りは下）", ok: (c, i, d) => beyond(c.b.macd.macd, c.b.macd.signal, i, d) },
    trend: { ja: "MACDがシグナル線より上（売りは下）", ok: (c, i, d) => beyond(c.b.macd.macd, c.b.macd.signal, i, d) },
  },
  {
    id: "bollinger",
    indicator: "ボリンジャーバンド",
    bounce: {
      ja: "直近3本で安値が-2σに届いた（売りは高値が+2σ）",
      ok: (c, i, d) =>
        within3((j) => {
          const band = v(d === 1 ? c.b.bb.lower : c.b.bb.upper, j);
          const x = d === 1 ? c.low[j] : c.high[j];
          return band !== null && x !== undefined && (d === 1 ? x <= band : x >= band);
        }, i),
    },
    trend: { ja: "終値がミドルバンドより上（売りは下）", ok: (c, i, d) => beyond(c.b.close, c.b.bb.middle, i, d) },
  },
  {
    id: "stochastic",
    indicator: "ストキャスティクス",
    bounce: { ja: "直近3本で%Dが20未満（売りは80超）", ok: (c, i, d) => within3((j) => below(c.b.stoch.d, 20, j, d), i) },
    trend: { ja: "%Kが%Dより上（売りは下）", ok: (c, i, d) => beyond(c.b.stoch.k, c.b.stoch.d, i, d) },
  },
  {
    id: "ichimoku",
    indicator: "一目均衡表",
    bounce: { ja: "価格が雲より上（売りは雲より下）", ok: (c, i, d) => beyond(c.b.close, d === 1 ? c.b.ichi.cloudTop : c.b.ichi.cloudBottom, i, d) },
    trend: { ja: "価格が雲より上（売りは雲より下）", ok: (c, i, d) => beyond(c.b.close, d === 1 ? c.b.ichi.cloudTop : c.b.ichi.cloudBottom, i, d) },
  },
  {
    id: "psar",
    indicator: "パラボリックSAR",
    bounce: { ja: "SARが価格の下（売りは上）", ok: (c, i, d) => c.b.psar.long[i] === (d === 1) },
    trend: { ja: "SARが価格の下（売りは上）", ok: (c, i, d) => c.b.psar.long[i] === (d === 1) },
  },
  {
    id: "adx",
    indicator: "ADX/DMI",
    bounce: {
      ja: "ADXが20未満（トレンドが弱いレンジ）",
      ok: (c, i) => {
        const a = v(c.b.dmi.adx, i);
        return a !== null && a < 20;
      },
    },
    trend: {
      ja: "ADXが25超で+DIが-DIより上（売りは下）",
      ok: (c, i, d) => {
        const a = v(c.b.dmi.adx, i);
        return a !== null && a > 25 && beyond(c.b.dmi.plus, c.b.dmi.minus, i, d);
      },
    },
  },
  {
    id: "cci",
    indicator: "CCI",
    bounce: { ja: "直近3本でCCIが-100未満（売りは+100超）", ok: (c, i, d) => within3((j) => beyond(c.b.cci, d === 1 ? -100 : 100, j, (-d) as Dir), i) },
    trend: { ja: "CCIが0より上（売りは下）", ok: (c, i, d) => beyond(c.b.cci, 0, i, d) },
  },
  {
    id: "donchian",
    indicator: "ドンチャン・チャネル",
    bounce: {
      ja: "直近3本で20本安値を付けた（売りは20本高値）",
      ok: (c, i, d) =>
        within3((j) => {
          const edge = v(d === 1 ? c.b.dc.low : c.b.dc.high, j);
          const x = d === 1 ? c.low[j] : c.high[j];
          return edge !== null && x !== undefined && (d === 1 ? x <= edge : x >= edge);
        }, i),
    },
    trend: {
      ja: "終値が20本の高安の中心より上（売りは下）",
      ok: (c, i, d) => {
        const h = v(c.b.dc.high, i);
        const l = v(c.b.dc.low, i);
        return h !== null && l !== null && beyond(c.b.close, (h + l) / 2, i, d);
      },
    },
  },
  {
    id: "rci",
    indicator: "RCI",
    bounce: { ja: "直近3本でRCI(9)が-80未満（売りは+80超）", ok: (c, i, d) => within3((j) => beyond(c.b.rci, d === 1 ? -80 : 80, j, (-d) as Dir), i) },
    trend: { ja: "RCI(9)が0より上（売りは下）", ok: (c, i, d) => beyond(c.b.rci, 0, i, d) },
  },
  {
    id: "higher_tf",
    indicator: "上位足のトレンド",
    bounce: { ja: "一つ上の時間足が50本移動平均より上（売りは下）", ok: (c, i, d) => c.htf[i] === (d === 1 ? "up" : "down") },
    trend: { ja: "一つ上の時間足が50本移動平均より上（売りは下）", ok: (c, i, d) => c.htf[i] === (d === 1 ? "up" : "down") },
  },
];

// The higher timeframe's trend word for each of its bars: close above or
// below its own 50-bar simple average.
export const htfTrend = (higher: Candle[]): Array<Trend | null> =>
  higher.map((c, i) => {
    if (i < 49) return null;
    let s = 0;
    for (let j = i - 49; j <= i; j++) s += higher[j].close;
    const avg = s / 50;
    return c.close > avg ? "up" : c.close < avg ? "down" : null;
  });
