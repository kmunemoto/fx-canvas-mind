// #108: what every signal the rule fired actually did afterwards.
//
// The request: 「作って」, to the proposal after #107 — "for every alert,
// record whether the target or the stop was reached first, and show the
// real win rate and expectancy over the coming months". The past-chart
// studies (#103, §8.21) say the rule loses about 0.12 R a trade after the
// spread; this is how the claim gets checked on prices nobody had seen when
// it was made.
//
// Every signal on the app's seven pairs and four alert timeframes is
// recorded (signal_events), not only the ones somebody follows: at ~50 a
// month across the pairs the record can say something within a few months,
// where one pair alone (~7 a month) would take years.
//
// HOW A SIGNAL IS SETTLED, fixed before any live result was seen:
//
//   * Entry: the close of the signal bar on the side a trade fills on — the
//     ask for a BUY, the bid for a SELL. (The email arrives a few minutes
//     later; nobody can fill at an earlier price, and a later one is not
//     knowable here.)
//   * Stop and target: the levels the email printed (0.8 ATR and 1.5x that
//     from the mid close), read on the side a position closes on — the bid
//     for a BUY, the ask for a SELL. A bar that opens beyond the stop fills
//     at its open; one that opens beyond the target is credited the target
//     only.
//   * A bar that reached both levels is counted as a loss ("ambiguous"): the
//     order inside the bar is not in the candle, and the conservative
//     reading is the one that cannot flatter the rule.
//   * No level within 48 bars: closed at the market at the 48th bar's close
//     ("expired"), the same horizon the studies used.
//   * R is the result over the planned risk (entry to stop on the mid), so
//     +1.5R is a clean win, -1R a clean loss, and the spread shows up as
//     slightly less and slightly more.
//
// Deno-free on purpose: src/test/signal-record.test.ts imports it.

import type { QuoteCandle } from "../track-outcomes/quotes.ts";
import { HORIZON_BARS } from "../analyze/rsisar.ts";
import { STEP_MS } from "./logic.ts";

export type EventOutcome = "win" | "loss" | "ambiguous" | "expired" | "no_data";

export interface OpenEvent {
  id: string;
  pair: string;
  interval: string;
  // the open of the signal bar, ISO
  bar_time: string;
  side: "BUY" | "SELL";
  // the emailed plan, on the mid
  entry: number;
  stop: number;
  target: number;
  // the tradeable price at the signal bar's close, when it was known
  fill: number | null;
}

export interface Settlement {
  outcome: EventOutcome;
  fill: number | null;
  exit_price: number | null;
  exit_at: string | null;
  bars: number | null;
  r: number | null;
}

const ms = (iso: string) => Date.parse(iso.includes("T") ? (iso.endsWith("Z") || /[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`) : `${iso.replace(" ", "T")}Z`);

// The tradeable price at a bar's close, and the spread then
export const fillAt = (
  quotes: QuoteCandle[],
  barTime: string,
  side: "BUY" | "SELL",
): { fill: number; spread: number } | null => {
  const t = ms(barTime);
  const q = quotes.find((x) => ms(x.datetime) === t);
  if (!q) return null;
  return { fill: side === "BUY" ? q.ask.close : q.bid.close, spread: q.ask.close - q.bid.close };
};

// The event's result, or null while it is still open. `quotes` may include
// the forming bar; only closed bars are read.
export const settleEvent = (ev: OpenEvent, quotes: QuoteCandle[], nowMs: number): Settlement | null => {
  const step = STEP_MS[ev.interval];
  if (step === undefined) return null;
  const closed = quotes.filter((q) => {
    const t = ms(q.datetime);
    return Number.isFinite(t) && t + step <= nowMs;
  });
  const t0 = ms(ev.bar_time);
  const i = closed.findIndex((q) => ms(q.datetime) === t0);
  const none: Settlement = { outcome: "no_data", fill: ev.fill, exit_price: null, exit_at: null, bars: null, r: null };
  if (i < 0) {
    // The window starts after the signal bar: it has slid out of what this
    // feed will ever be asked for again, so it can never be settled.
    if (closed.length > 0 && ms(closed[0].datetime) > t0) return none;
    return null;
  }
  const buy = ev.side === "BUY";
  const dir = buy ? 1 : -1;
  const fill = ev.fill ?? (buy ? closed[i].ask.close : closed[i].bid.close);
  const risk = Math.abs(ev.entry - ev.stop);
  if (!(risk > 0) || !Number.isFinite(fill)) return none;
  const R = (exit: number) => Number((((exit - fill) * dir) / risk).toFixed(4));
  const closeIso = (q: QuoteCandle) => new Date(ms(q.datetime) + step).toISOString();

  const last = Math.min(closed.length - 1, i + HORIZON_BARS);
  for (let j = i + 1; j <= last; j++) {
    const q = closed[j];
    const x = buy ? q.bid : q.ask;
    const tp = buy ? x.high >= ev.target : x.low <= ev.target;
    const sl = buy ? x.low <= ev.stop : x.high >= ev.stop;
    if (!tp && !sl) continue;
    if (sl) {
      const exit = buy ? Math.min(ev.stop, x.open) : Math.max(ev.stop, x.open);
      return { outcome: tp ? "ambiguous" : "loss", fill, exit_price: exit, exit_at: closeIso(q), bars: j - i, r: R(exit) };
    }
    return { outcome: "win", fill, exit_price: ev.target, exit_at: closeIso(q), bars: j - i, r: R(ev.target) };
  }
  if (i + HORIZON_BARS <= closed.length - 1) {
    const q = closed[i + HORIZON_BARS];
    const exit = buy ? q.bid.close : q.ask.close;
    return { outcome: "expired", fill, exit_price: exit, exit_at: closeIso(q), bars: HORIZON_BARS, r: R(exit) };
  }
  return null;
};

// ---- the record, summed up -----------------------------------------------------------

export interface EventRow {
  outcome: string | null;
  r: number | null;
}

export interface Summary {
  // settled with a result
  n: number;
  wins: number;
  // clean losses and bars that reached both levels
  losses: number;
  expired: number;
  // not settled yet
  open: number;
  winRate: number | null;
  meanR: number | null;
  // half-width of a 95% interval on meanR; null below MIN_FOR_INTERVAL
  ciR: number | null;
  sumR: number;
}

export const MIN_FOR_INTERVAL = 10;

export const summarize = (rows: EventRow[]): Summary => {
  const done = rows.filter((x) => x.outcome !== null && x.outcome !== "no_data" && typeof x.r === "number" && Number.isFinite(x.r));
  const n = done.length;
  const rs = done.map((x) => x.r as number);
  const sumR = rs.reduce((a, b) => a + b, 0);
  const meanR = n > 0 ? sumR / n : null;
  let ciR: number | null = null;
  if (n >= MIN_FOR_INTERVAL && meanR !== null) {
    const v = rs.reduce((a, b) => a + (b - meanR) ** 2, 0) / (n - 1);
    ciR = 1.96 * Math.sqrt(v / n);
  }
  const wins = done.filter((x) => x.outcome === "win").length;
  return {
    n,
    wins,
    losses: done.filter((x) => x.outcome === "loss" || x.outcome === "ambiguous").length,
    expired: done.filter((x) => x.outcome === "expired").length,
    open: rows.filter((x) => x.outcome === null).length,
    winRate: n > 0 ? wins / n : null,
    meanR,
    ciR,
    sumR: Number(sumR.toFixed(4)),
  };
};

// What the past charts said the same rule would do (§8.21, the app's exit,
// all timeframes, 2025-07 to 2026-09, spread paid): the yardstick the live
// record is read against.
export const BACKTEST = { period: "2025-07〜2026-09", n: 1255, winRate: 0.35, meanR: -0.125, breakeven: 0.4 };
