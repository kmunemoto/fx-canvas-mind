// #291 (docs §8.112): gold's 1-minute bars made from Swissquote's prices all
// day long — when the "gold-ticks" run reads them, when it judges the minute
// that has closed, and the one-time fill of the minutes before the recording
// began from Twelve Data's 1-minute bars.
//
// The owner (2026-10-11), asked where gold's 1-minute bars should come from
// (Twelve Data's free key allows 800 reads a day; reading gold's 1-minute bars
// after every close takes some 1,380): 「Swissquoteで、チャートもそろえる」. So
// pg_cron starts the signal-alerts function every minute with {"mode":
// "gold-ticks"}; the run reads Swissquote's gold price every GOLD_TICK_EVERY_MS
// until GOLD_TICK_STOP_MS before the next minute (the next run's), and each
// price open now (younger than GOLD_QUOTE_STALE_MS, as the live chart takes
// it) goes into public.gold_tick_bars, a row a minute (record_gold_tick). The
// live chart's ticker records gold's price there too, every two seconds
// while a chart is open (#147). GOLD_JUDGE_AFTER_MS after a minute has
// closed, the run judges it for the gold 1-minute email, on the prices
// recorded by then; gold's 1-minute chart draws the same minutes
// (live-chart/logic.ts isGoldMinute).
//
// Deno-free: src/test/gold-minutes.test.ts imports it.

import type { Candle } from "../analyze/indicators.ts";
import { barOpenMs } from "../analyze/state.ts";
import { GOLD_QUOTE_STALE_MS } from "../live-chart/logic.ts";

const MIN = 60_000;

// How often the run reads Swissquote's gold price (the live chart's ticker
// reads it every two seconds while a chart is open)
export const GOLD_TICK_EVERY_MS = 3_000;
// The run reads no more from this long before the next minute begins: the
// next minute's run reads from then
export const GOLD_TICK_STOP_MS = 1_500;
// How long after a minute has closed it is judged for the email: the run's
// first reads of the new minute have been recorded by then, and a price
// stamped within the minute that closed, read late, with them
export const GOLD_JUDGE_AFTER_MS = 5_000;

export interface GoldTickPlan {
  // the minute the run is for (its start, ms)
  minuteStart: number;
  // no read is begun from this time on
  stopAt: number;
  // the minute before it, the one that has closed, is judged from this time on
  judgeAt: number;
}

// The run started at `startMs`: the minute it is in
export const goldTickPlan = (startMs: number): GoldTickPlan => {
  const minuteStart = Math.floor(startMs / MIN) * MIN;
  return { minuteStart, stopAt: minuteStart + MIN - GOLD_TICK_STOP_MS, judgeAt: minuteStart + GOLD_JUDGE_AFTER_MS };
};

// When the next read is begun, the last one having begun at `lastAt`: a
// read late by more than the gap is followed at once, not twice as fast
export const nextTickAt = (lastAt: number, nowMs: number): number => Math.max(nowMs, lastAt + GOLD_TICK_EVERY_MS);

// The recorded minutes that have closed by `nowMs` (oldest first, as read)
export const closedMinutes = <T extends { minute: string }>(minutes: ReadonlyArray<T>, nowMs: number): T[] =>
  minutes.filter((m) => Date.parse(m.minute) + MIN <= nowMs);

// ---- the fill of the minutes before the recording began -------------------------------------
//
// Once, by hand, through the run {"mode": "gold-seed"}: Twelve Data's newest
// 1-minute bars, those before the first minute recorded from Swissquote's
// prices (`firstRecorded`, the oldest 'swissquote' row; null when there is
// none), and none that has not ended GOLD_QUOTE_STALE_MS before now (a
// minute Swissquote may still be recording). A minute already in the table
// is left as it is; a minute Twelve Data gave twice, its first.
export interface SeedRow {
  minute: string;
  open: number;
  high: number;
  low: number;
  close: number;
  first_at: string;
  last_at: string;
  samples: number;
  source: "twelvedata";
}
export const goldSeedRows = (bars: ReadonlyArray<Candle>, nowMs: number, firstRecorded: number | null): SeedRow[] => {
  const out: SeedRow[] = [];
  const seen = new Set<number>();
  for (const b of bars) {
    const open = barOpenMs(b.datetime);
    if (!Number.isFinite(open) || open % MIN !== 0 || seen.has(open)) continue;
    if (open + MIN > nowMs - GOLD_QUOTE_STALE_MS) continue;
    if (firstRecorded !== null && open >= firstRecorded) continue;
    if (![b.open, b.high, b.low, b.close].every((v) => Number.isFinite(v) && v > 0) || b.high < b.low) continue;
    seen.add(open);
    const at = new Date(open).toISOString();
    out.push({ minute: at, open: b.open, high: b.high, low: b.low, close: b.close, first_at: at, last_at: at, samples: 0, source: "twelvedata" });
  }
  return out;
};
