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
// Shown on the chart, and #155: the email alerts (signal-alerts) judge on
// it too, from this same code (moved here from src/lib/qTrend.ts, which
// re-exports it). No record is kept of its signals.

import { pineAtr } from "./pine.ts";
import { followTrade, type UltraTrade } from "./ultra.ts";

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

// #148: where the line's computation starts. The line is built step by
// step from its first bar, so the same bars read from another first bar
// give another line, and other labels: on the gold 1-hour bars read on
// 2026-09-28, starting 1 to 48 hours later moved or removed a label in the
// chart's 120 bars in 44 of the 48 cases. The live chart reads the bars
// before its own again each time it is opened, from a first bar that moves
// with the clock — so a label seen live could be elsewhere after a reload.
// The owner: 「1は直して」.
//
// So the computation starts at a fixed time instead: the first bar at or
// after the earliest multiple of `period` bars' time (from 1970-01-01 UTC)
// that the bars read reach back to. Opened again, the chart starts there
// again and draws the same line and labels, until the bars read no longer
// reach it (once every period bars' time), when it moves to the next
// multiple. With fewer than `period` bars left before the chart's first
// bar there (a short history), it starts at the first bar read, as before.
//
// #155: "the bars read reach back to" is counted from the newest bar judged
// on: the bar ANCHOR_WINDOW − 1 closed bars before it (the first of the
// live chart's history when it is read then), not the first bar the page
// happens to hold. A chart left open keeps the history it read hours ago
// (it reads it again only once the chart has moved past it), so it began
// further back than the same chart opened now — and with a multiple in
// between, it drew other Q-Trend labels. The email alerts judge on the bars
// read at the close; counted this way, the chart left open, the chart
// opened again and the email start at the same bar.
export const ANCHOR_WINDOW = 600;
export const anchoredStart = (
  openTimes: ReadonlyArray<number>,
  stepMs: number,
  firstShown: number,
  period: number = QT_DEFAULTS.period,
  lastJudged: number = openTimes.length - 1,
  window: number = ANCHOR_WINDOW,
): number => {
  const t0 = openTimes[Math.max(0, Math.min(lastJudged, openTimes.length - 1) - (window - 1))];
  if (!(stepMs > 0) || !Number.isFinite(t0)) return 0;
  const grid = period * stepMs;
  const at = Math.ceil(t0 / grid) * grid;
  const s = openTimes.findIndex((t) => t >= at);
  return s >= 0 && s <= firstShown - period ? s : 0;
};

// the bars' length: the shortest gap between two of them (a weekend's is longer)
export const barStepMs = (openTimes: ReadonlyArray<number>): number => {
  let step = Infinity;
  for (let i = 1; i < openTimes.length; i++) {
    const d = openTimes[i] - openTimes[i - 1];
    if (Number.isFinite(d) && d > 0 && d < step) step = d;
  }
  return Number.isFinite(step) ? step : 0;
};

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
    const m: number | null = i > p ? mPrev : h !== null && l !== null ? (h + l) / 2 : null;
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

// #156: a stop and three targets for Q-Trend's signals, which have none of
// their own. The owner (「buy、sellの合図が出た時にtp出してくれないの？」), shown
// three ways measured on the 5-minute charts (docs §8.68: each lost 2.2 to
// 2.4 pips a trade on average, spread paid), chose ULTRA's numbers (「B」):
// each signal entered at its bar's close, the stop 10, TP1–TP3 5, 10 and 15
// (pips on a pair, dollars on gold), followed as ULTRA's are (ultra.ts
// followTrade). The chart draws the newest; the emails carry the same.
export const qTrendTrades = (
  bars: ReadonlyArray<Bar>,
  signals: QTrendRead["signals"],
  lastClosed: number,
  unit: number,
): UltraTrade[] => signals.filter((s) => s.i <= lastClosed).map((s) => followTrade(bars, s.i, s.side, lastClosed, unit));
