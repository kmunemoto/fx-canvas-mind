// This file is subject to the terms of the Mozilla Public License 2.0 at
// https://mozilla.org/MPL/2.0/ — it is a TypeScript port of the open-source
// Pine Script "Q-Trend" © tarasenko_ (TradingView script 2vRdxyjm, Pine v5),
// whose code is under that licence.
//
// #145: one of the two indicators in the video the owner sent ("この動画と
// 同じ仕組みのインジケーターを入れたい"), at the original's defaults, which
// the video says it uses ("default setting"):
//
//   * TL (the trend line) starts as the middle of the highest and lowest
//     close of the last 200 bars; from the 201st bar on it only moves when
//     the close breaks it by ε = ATR(14) of the bar before × 1 — up by ε
//     when the close is over TL + ε, down by ε when under TL − ε (one step
//     a bar).
//   * A break up is a BUY, down a SELL — only the first of a run (the last
//     signal is remembered). It is STRONG when, on that bar or one of the
//     four before, the bar opened in the lowest eighth of the 200-bar range
//     (a buy; the highest eighth for a sell).
//   * The line and the candles take the last signal's colour: green after
//     a buy, red otherwise (red before the first, as the original).
//
// Kept from Pine: `ta.atr` is Wilder's RMA seeded with the simple average of
// the first 14 true ranges; `ta.highest`/`ta.lowest` are nothing until 200
// bars; a comparison with nothing is false. The original's "Type A" signal
// mode (its default) only: there a break is `crossover(...) or close >
// TL + ε`, which is `close > TL + ε`. Its EMA smoothing of the source is off
// by default and not ported.
//
// Judged on closed bars only: the forming bar gets no line, colour or
// signal. TradingView starts the line at its chart's first bars; here it
// starts 200 bars into what the chart reads (the live chart reads 600 closed
// bars before its own), so the line can sit a little apart from
// TradingView's until the price pushes both the same way.
//
// Shown on the chart only: no signal, alert or record is judged on it.

import { pineAtr } from "./supertrend";

export interface QTrendParams {
  period: number;
  atrPeriod: number;
  mult: number;
}

export const QT_DEFAULTS: QTrendParams = { period: 200, atrPeriod: 14, mult: 1 };

type Bar = { open: number; high: number; low: number; close: number };

export interface QTrendRead {
  // the trend line, closed bars only
  line: Array<number | null>;
  // the last signal at each closed bar: 1 a buy, −1 a sell, 0 none yet;
  // null on the forming bar
  trend: Array<1 | -1 | 0 | null>;
  signals: Array<{ i: number; side: "BUY" | "SELL"; strong: boolean }>;
}

// the highest and lowest of the last `n` values, nothing until there are n
const extremes = (xs: ReadonlyArray<number>, n: number) => {
  const hi: Array<number | null> = xs.map(() => null);
  const lo: Array<number | null> = xs.map(() => null);
  for (let i = n - 1; i < xs.length; i++) {
    let h = -Infinity;
    let l = Infinity;
    for (let k = i - n + 1; k <= i; k++) {
      if (xs[k] > h) h = xs[k];
      if (xs[k] < l) l = xs[k];
    }
    hi[i] = h;
    lo[i] = l;
  }
  return { hi, lo };
};

// `lastClosed`: the index of the newest closed bar
export const qTrend = (bars: ReadonlyArray<Bar>, params: QTrendParams = QT_DEFAULTS, lastClosed: number = bars.length - 1): QTrendRead => {
  const n = bars.length;
  const p = Math.max(1, Math.round(params.period));
  const src = bars.map((b) => b.close);
  const atr = pineAtr(bars, Math.max(1, Math.round(params.atrPeriod)));
  const { hi, lo } = extremes(src, p);
  const line: QTrendRead["line"] = new Array(n).fill(null);
  const trend: QTrendRead["trend"] = new Array(n).fill(null);
  const signals: QTrendRead["signals"] = [];
  const sb: boolean[] = [];
  const ss: boolean[] = [];
  let mPrev: number | null = null;
  let lsPrev: 1 | -1 | 0 = 0;
  const end = Math.min(lastClosed, n - 1);
  for (let i = 0; i <= end; i++) {
    const h = hi[i];
    const l = lo[i];
    const d = h !== null && l !== null ? h - l : null;
    // m = (h + l) / 2; m := bar_index > p ? m[1] : m
    const m = i > p ? mPrev : h !== null && l !== null ? (h + l) / 2 : null;
    // ta.atr(atr_p)[1]
    const a = i > 0 ? atr[i - 1] : null;
    const eps = a === null ? null : params.mult * a;
    const up = m !== null && eps !== null && src[i] > m + eps;
    const down = m !== null && eps !== null && src[i] < m - eps;
    const o = bars[i].open;
    sb.push(h !== null && l !== null && d !== null && o < l + d / 8 && o >= l);
    ss.push(h !== null && l !== null && d !== null && o > h - d / 8 && o <= h);
    const recent = (xs: boolean[]) => xs.slice(-5).some(Boolean);
    // m := (up or down) and m != m[1] ? m : up ? m + ε : down ? m − ε : nz(m[1], m)
    const moved = m !== null && mPrev !== null && m !== mPrev;
    let next: number | null;
    if ((up || down) && moved) next = m;
    else if (up) next = (m as number) + (eps as number);
    else if (down) next = (m as number) - (eps as number);
    else next = mPrev ?? m;
    const ls: 1 | -1 | 0 = up ? 1 : down ? -1 : lsPrev;
    if (up && lsPrev !== 1) signals.push({ i, side: "BUY", strong: recent(sb) });
    if (down && lsPrev !== -1) signals.push({ i, side: "SELL", strong: recent(ss) });
    line[i] = next;
    trend[i] = ls;
    mPrev = next;
    lsPrev = ls;
  }
  return { line, trend, signals };
};
