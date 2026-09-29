// #145: "Buy Low Sell High Composite" (short title BLSH) by zacmcc, a port of
// its open-source Pine code (TradingView, https://www.tradingview.com/script/
// turEX2Ly-Buy-Low-Sell-High-Composite/, Pine v3) — the other indicator in
// the video the owner sent, under the chart there as "BLSH". Its author:
// "Combines RSI, EMA difference, and MacD into a single indicator".
//
//   each part scaled to −1…+1 by normalize(v, lo, hi) = −1 + 2(v − lo)/(hi − lo):
//     RSI(14) between 25 and 75;
//     EMA(5) − EMA(35) between ±2 × ATR(9) ("Elliot Wave" in the code);
//     the MACD histogram (EMA 12 − EMA 26, less its 9-bar simple average)
//       between ±2 × ATR(9);
//     MFI(14) between 25 and 75
//   the composite = their sum, drawn ÷ 4 as an area: green above 0, red at
//   or under it
//   the line = the MACD signal line scaled the same way, one colour while
//   MACD is at or over its signal and another while under
//
// Changed, and said on the chart:
//   * MFI needs volume and GMO's FX bars have none: each bar counts as one
//     (as the Volume Profile of #122 does), so the MFI here is the share of
//     the last 14 bars' typical prices on bars that rose.
//   * Pine v3's rsi(up, down) divides by zero when no bar fell; that is 100
//     here (both zero, 50), as the standard MFI has it.
//   * The line's colours are the video's (yellow at or over the signal,
//     blue under it; the original's lime and red), and its crossover dots
//     are not drawn (the video shows none).
//
// Kept from Pine: EMAs start as the simple average of their first closes,
// RSI and ATR are Wilder's averages seeded the same way, and anything
// computed from nothing is nothing.
//
// Shown on the chart. #158: moved here from src/lib/blsh.ts (which
// re-exports it) unchanged, so the email alerts can read it as the chart does.

import { ema, pineAtr, sma } from "./pine.ts";

type Bar = { high: number; low: number; close: number };
type Series = Array<number | null>;

export const BLSH_DEFAULTS = {
  atr: 9,
  rsi: 14,
  emaFast: 5,
  emaSlow: 35,
  macdFast: 12,
  macdSlow: 26,
  macdSignal: 9,
  mfi: 14,
};

export interface BlshRead {
  // the composite ÷ 4 (−1…+1): green over 0, red at or under
  composite: Series;
  // the MACD signal line, scaled
  line: Series;
  // MACD at or over its signal (the line's first colour)
  lineUp: Array<boolean | null>;
  // the four parts, scaled, for the checks
  parts: { rsi: Series; emaDiff: Series; macdHist: Series; mfi: Series };
}

export const normalize = (v: number, lo: number, hi: number): number => {
  const range = hi - lo === 0 ? 0.0001 : hi - lo;
  return -1 + ((v - lo) / range) * 2;
};

// Pine's ta.rsi: Wilder's averages of the rises and falls, seeded with their
// simple average; 100 when nothing fell, 0 when nothing rose
export const pineRsi = (xs: ReadonlyArray<number>, n: number): Series => {
  const out: Series = xs.map(() => null);
  let up = 0;
  let down = 0;
  for (let i = 1; i < xs.length; i++) {
    const ch = xs[i] - xs[i - 1];
    const u = Math.max(ch, 0);
    const d = Math.max(-ch, 0);
    if (i <= n) {
      up += u / n;
      down += d / n;
      if (i < n) continue;
    } else {
      up = (up * (n - 1) + u) / n;
      down = (down * (n - 1) + d) / n;
    }
    out[i] = down === 0 ? 100 : up === 0 ? 0 : 100 - 100 / (1 + up / down);
  }
  return out;
};

// MFI with every bar's volume 1: the typical price of the last `n` bars that
// rose over those that fell. Pine's `change(hlc3) <= 0 ? 0 : hlc3` is hlc3 on
// the first bar (no change: a comparison with nothing is false), so the
// first bar counts on both sides, as there.
export const unitMfi = (bars: ReadonlyArray<Bar>, n: number): Series => {
  const tp = bars.map((b) => (b.high + b.low + b.close) / 3);
  const pos = tp.map((v, i) => (i === 0 ? v : tp[i] - tp[i - 1] <= 0 ? 0 : v));
  const neg = tp.map((v, i) => (i === 0 ? v : tp[i] - tp[i - 1] >= 0 ? 0 : v));
  return tp.map((_, i) => {
    if (i < n - 1) return null;
    let p = 0;
    let q = 0;
    for (let k = i - n + 1; k <= i; k++) {
      p += pos[k];
      q += neg[k];
    }
    return q === 0 ? (p === 0 ? 50 : 100) : 100 - 100 / (1 + p / q);
  });
};

export const blsh = (bars: ReadonlyArray<Bar>, o = BLSH_DEFAULTS): BlshRead => {
  const close = bars.map((b) => b.close);
  const atr = pineAtr(bars, o.atr);
  const range = atr.map((a) => (a === null ? null : 2 * a));
  const rsi = pineRsi(close, o.rsi);
  const e5 = ema(close, o.emaFast);
  const e35 = ema(close, o.emaSlow);
  const e12 = ema(close, o.macdFast);
  const e26 = ema(close, o.macdSlow);
  const macd: Series = close.map((_, i) => (e12[i] === null || e26[i] === null ? null : (e12[i] as number) - (e26[i] as number)));
  const signal = sma(macd, o.macdSignal);
  const mfi = unitMfi(bars, o.mfi);
  const scaled = (v: number | null, i: number) => (v === null || range[i] === null ? null : normalize(v, -(range[i] as number), range[i] as number));
  const parts = {
    rsi: rsi.map((v) => (v === null ? null : normalize(v, 25, 75))),
    emaDiff: close.map((_, i) => scaled(e5[i] === null || e35[i] === null ? null : (e5[i] as number) - (e35[i] as number), i)),
    macdHist: close.map((_, i) => scaled(macd[i] === null || signal[i] === null ? null : (macd[i] as number) - (signal[i] as number), i)),
    mfi: mfi.map((v) => (v === null ? null : normalize(v, 25, 75))),
  };
  const composite: Series = close.map((_, i) => {
    const xs = [parts.emaDiff[i], parts.rsi[i], parts.macdHist[i], parts.mfi[i]];
    if (xs.some((v) => v === null)) return null;
    return normalize((xs as number[]).reduce((a, b) => a + b, 0), -4, 4);
  });
  return {
    composite,
    line: close.map((_, i) => scaled(signal[i], i)),
    lineUp: close.map((_, i) => (macd[i] === null || signal[i] === null ? null : (macd[i] as number) >= (signal[i] as number))),
    parts,
  };
};

// #145: the video's "triple confirmation" — enter when Q-Trend's signal, the
// BLSH line's colour and the BLSH area's colour agree: a buy while Q-Trend's
// last signal is a buy, the line up (MACD at or over its signal) and the
// area green (over 0); a sell mirrored (line down, area red). The video
// enters as soon as the last of the three agrees ("as soon as the histogram
// got red"), and a buy signal whose area stays red is its "fake entry": no
// mark. One mark per Q-Trend leg (from one signal to the next), on the first
// closed bar where all three agree.
export const tripleConfirm = (
  trend: ReadonlyArray<1 | -1 | 0 | null>,
  b: Pick<BlshRead, "composite" | "lineUp">,
  lastClosed: number,
): Array<{ i: number; side: "BUY" | "SELL" }> => {
  const out: Array<{ i: number; side: "BUY" | "SELL" }> = [];
  let leg: 1 | -1 | 0 = 0;
  let done = false;
  for (let i = 0; i <= lastClosed && i < trend.length; i++) {
    const t = trend[i];
    if (t === null) continue;
    if (t !== leg) {
      leg = t;
      done = false;
    }
    if (done || t === 0) continue;
    const c = b.composite[i];
    const up = b.lineUp[i];
    if (c === null || up === null || c === undefined || up === undefined) continue;
    if ((t === 1 && up && c > 0) || (t === -1 && !up && c <= 0)) {
      out.push({ i, side: t === 1 ? "BUY" : "SELL" });
      done = true;
    }
  }
  return out;
};
