// #151: the indicator of the owner's video (「このインジケーター追加して どんな
// インジケーターか調べて内容を実装して。動画の数値を設定して。」) — "ULTRA EN"
// by F-INVEST on TradingView, its table headed "ULTRA_V1.2".
//
// It is invite-only: F-INVEST has no published script (its profile lists
// none; the script is handed out through Telegram), so its code cannot be
// read. What is here is what the video shows, and where the video does not
// say, this app's choice (marked so):
//
//   * the settings, as the video sets them: the RSI strategy on (RSI 14,
//     overbought 70, oversold 30, trade mode "Trend-f…"), the MACD strategy
//     off (12, 26, 9 — not built), a Heikin Ashi MACD section (not built:
//     whether it was on cannot be seen), SL 10, TP1 5, TP2 10, TP3 15 in
//     price (the video is gold at about $4,300: TP1 4322.154 under an entry
//     of 4327.154, the stop at 4337.154)
//   * where its marks fall on the video's chart: a Sell a few bars after a
//     top as the price turns down, a Buy on the first rise off a bottom —
//     RSI leaving the overbought zone (crossing under 70) and leaving the
//     oversold zone (crossing over 30), Pine's ta.crossunder / ta.crossover
//     (this app's reading of "trend-following": the turn is waited for, not
//     faded at the extreme)
//   * each signal enters at its bar's close, with the stop and three
//     targets at those distances; ★TP1, ★TP2, ★TP3 where each is reached
//   * the table: how many signals reached TP1, TP2, TP3 and the stop, over
//     TOTAL = TP1 + SL (in the video 489 + 133 = 622, and it went to 490 and
//     623 as TP1 was reached), each as a share of TOTAL; WIN RATE is TP1's
//
// This app's choices, not the video's: a signal is followed from the bar
// after it on closed bars, until its stop or TP3; a bar that reaches both
// the stop and a target counts the stop (as every record in this app); a
// stop after TP1 ends the trade and is not counted again (TOTAL is TP1 +
// SL in the video); each signal is followed on its own, whatever came
// before it. On a currency pair the same numbers are pips (10 pips, 5/10/15
// pips): $10 on gold taken as a currency's price would be ten yen on USD/JPY.
// #166: on a currency pair the stop is 30 pips (ULTRA_PAIRS below); gold
// keeps the video's $10.
//
// Shown on the chart, and #155: the email alerts (signal-alerts) judge on
// its signals too, from this same code (moved here from src/lib/ultra.ts,
// which re-exports it). No record is kept of them. #157: the video's
// 79–80% is on gold; on GMO's FX pairs, spread paid, TP1 came before the
// stop 61–64% of the time on 5-minute to 4-hour bars (docs §8.69).

import { pineRma, type Series } from "./pine.ts";

type Bar = { high: number; low: number; close: number };

export const ULTRA_DEFAULTS = { rsiLength: 14, overbought: 70, oversold: 30, sl: 10, tp1: 5, tp2: 10, tp3: 15 };
export type UltraParams = typeof ULTRA_DEFAULTS;

// #166: the stop on a currency pair. The owner (2026-09-29), shown the stops
// 10 to 100 pips measured on the emails' 4-hour signals (docs §8.77), chose
// 30 pips (「2で」). The signals themselves do not depend on it; gold, not
// measured, keeps the video's $10.
export const ULTRA_PAIRS: UltraParams = { ...ULTRA_DEFAULTS, sl: 30 };
// the settings a chart's levels are drawn and mailed at
export const ultraParamsFor = (gold: boolean): UltraParams => (gold ? ULTRA_DEFAULTS : ULTRA_PAIRS);

// the video's colours: a green entry and Buy, a red stop and Sell, blue targets
export const ULTRA_COLORS = { buy: "#43A047", sell: "#F4511E", entry: "#4CAF50", sl: "#E53935", tp: "#2962FF" };

// Pine's ta.rsi: Wilder's averages (ta.rma, seeded with the simple average)
// of the rises and the falls, 100 when nothing fell, 0 when nothing rose
export const pineRsi = (closes: ReadonlyArray<number>, n: number): Series => {
  const up: Series = closes.map((c, i) => (i === 0 ? null : Math.max(c - closes[i - 1], 0)));
  const down: Series = closes.map((c, i) => (i === 0 ? null : Math.max(closes[i - 1] - c, 0)));
  const u = pineRma(up, n);
  const d = pineRma(down, n);
  return u.map((a, i) => {
    const b = d[i];
    if (a === null || b === null) return null;
    if (b === 0) return 100;
    if (a === 0) return 0;
    return 100 - 100 / (1 + a / b);
  });
};

export interface UltraTrade {
  // the signal's bar, and which way
  i: number;
  side: "BUY" | "SELL";
  entry: number;
  sl: number;
  tps: [number, number, number];
  // the bar each target was first reached on, if it was
  tpAt: [number | null, number | null, number | null];
  // the bar the stop was reached on, if it was (before TP3)
  slAt: number | null;
  // the stop or TP1, whichever came first; null while neither has
  result: "TP1" | "SL" | null;
  // the bar the trade ended on (the stop or TP3); null while it is open
  end: number | null;
}

export interface UltraStats {
  tp1: number;
  tp2: number;
  tp3: number;
  sl: number;
  total: number;
}

export interface UltraRead {
  rsi: Series;
  trades: UltraTrade[];
  stats: UltraStats;
}

// The stop and the three targets of a signal entered at `entry`. `unit`:
// what one of the settings' numbers is in price — 1 on gold (the video's
// dollars), a pip on a currency pair
export const ultraLevels = (side: "BUY" | "SELL", entry: number, unit: number, o: UltraParams = ULTRA_DEFAULTS): { sl: number; tps: [number, number, number] } => {
  const dir = side === "BUY" ? 1 : -1;
  return {
    sl: entry - dir * o.sl * unit,
    tps: [entry + dir * o.tp1 * unit, entry + dir * o.tp2 * unit, entry + dir * o.tp3 * unit],
  };
};

// A signal on bar `i` entered at its close and followed on the closed bars
// after it, until its stop or TP3 (the rules above). #156: Q-Trend's
// signals are followed the same way (qtrend.ts qTrendTrades).
export const followTrade = (bars: ReadonlyArray<Bar>, i: number, side: "BUY" | "SELL", lastClosed: number, unit: number, o: UltraParams = ULTRA_DEFAULTS): UltraTrade => {
  const dir = side === "BUY" ? 1 : -1;
  const last = Math.min(lastClosed, bars.length - 1);
  const entry = bars[i].close;
  const trade: UltraTrade = { i, side, entry, ...ultraLevels(side, entry, unit, o), tpAt: [null, null, null], slAt: null, result: null, end: null };
  for (let t = i + 1; t <= last; t++) {
    const b = bars[t];
    const stopped = dir === 1 ? b.low <= trade.sl : b.high >= trade.sl;
    if (stopped) {
      trade.slAt = t;
      trade.end = t;
      if (trade.result === null) trade.result = "SL";
      break;
    }
    for (let k = 0; k < 3; k++) {
      if (trade.tpAt[k] === null && (dir === 1 ? b.high >= trade.tps[k] : b.low <= trade.tps[k])) trade.tpAt[k] = t;
    }
    if (trade.result === null && trade.tpAt[0] !== null) trade.result = "TP1";
    if (trade.tpAt[2] !== null) {
      trade.end = t;
      break;
    }
  }
  return trade;
};

export const ultra = (bars: ReadonlyArray<Bar>, lastClosed: number, unit: number, o: UltraParams = ULTRA_DEFAULTS): UltraRead => {
  const rsi = pineRsi(bars.map((b) => b.close), o.rsiLength);
  const last = Math.min(lastClosed, bars.length - 1);
  const trades: UltraTrade[] = [];
  for (let i = 1; i <= last; i++) {
    const [r, p] = [rsi[i], rsi[i - 1]];
    if (r === null || p === null) continue;
    const side = r > o.oversold && p <= o.oversold ? "BUY" : r < o.overbought && p >= o.overbought ? "SELL" : null;
    if (!side) continue;
    trades.push(followTrade(bars, i, side, last, unit, o));
  }
  const stats: UltraStats = { tp1: 0, tp2: 0, tp3: 0, sl: 0, total: 0 };
  for (const tr of trades) {
    if (tr.result === "SL") stats.sl++;
    if (tr.result === "TP1") stats.tp1++;
    if (tr.result === "TP1" && tr.tpAt[1] !== null) stats.tp2++;
    if (tr.result === "TP1" && tr.tpAt[2] !== null) stats.tp3++;
  }
  stats.total = stats.tp1 + stats.sl;
  return { rsi, trades, stats };
};

// a share of the table's TOTAL, as the video rounds it (489 of 622: 79%)
export const pctOf = (n: number, total: number): number | null => (total > 0 ? Math.round((100 * n) / total) : null);
