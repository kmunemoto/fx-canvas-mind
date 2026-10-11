// #291 (docs §8.112): gold's 1-minute bars made from Swissquote's prices all
// day long — when the "gold-ticks" run reads them, when it judges the minute
// that has closed, and the one-time fill of the minutes before the recording
// began from Twelve Data's 1-minute bars.
//
// The owner (2026-10-11), asked where gold's 1-minute bars should come from
// (Twelve Data's free key allows 800 reads a day; reading gold's 1-minute bars
// after every close takes some 1,380): 「Swissquoteで、チャートもそろえる」. So
// pg_cron calls the signal-alerts function every minute with {"mode":
// "gold-ticks"} (through the http extension, which waits for the answer and
// gives it up after 10 seconds: migration 20261011120100); the function
// answers at once and the run goes on in the background
// (EdgeRuntime.waitUntil), reading Swissquote's gold
// price every GOLD_TICK_EVERY_MS until GOLD_TICK_OVERLAP_MS past its minute
// (into the next run's), and each price open now (younger than
// GOLD_QUOTE_STALE_MS, as the live chart takes it, and stamped in a minute
// gold trades) goes into public.gold_tick_bars, a row a minute (record_gold_tick). The
// live chart's ticker records gold's price there too, every two seconds
// while a chart is open (#147). GOLD_JUDGE_AFTER_MS after a minute has
// closed, the run judges it for the gold 1-minute email, on the prices
// recorded by then; gold's 1-minute chart draws the same minutes
// (live-chart/logic.ts isGoldMinute).
//
// Deno-free: src/test/gold-minutes.test.ts imports it.

import type { Candle } from "../analyze/indicators.ts";
import { barOpenMs } from "../analyze/state.ts";
import { isPossiblyClosedFor } from "../_shared/market-hours.ts";
import { GOLD, GOLD_QUOTE_STALE_MS } from "../live-chart/logic.ts";

const MIN = 60_000;

// How often the run reads Swissquote's gold price (the live chart's ticker
// reads it every two seconds while a chart is open)
export const GOLD_TICK_EVERY_MS = 3_000;
// The run reads on this long past the end of its minute, beside the next
// minute's run: pg_cron starts every run at the minute (within 0.53 s on
// every run of 2026-10-08 to 10-11), and its call goes out at once — through
// the http extension, not pg_net, which sends no request while one it sent
// is open (measured 2026-10-11 on this project's pg_net 0.20.0: a request
// queued behind a 15-second one was sent when that one ended), so behind the
// minute's other jobs a run could begin up to their budgets late (90 to 130
// s). A run may still begin a few seconds late (a worker booting, the
// gateway); the two read together meanwhile, and no part of a minute goes
// unread. (Each run is its own worker, booted for its request — every
// request of 2026-10-09 booted one — so a run of 85 s is well inside the
// 150 s a worker may live)
export const GOLD_TICK_OVERLAP_MS = 25_000;
// A run started this close to a minute's end (pg_cron's clock a little
// ahead of the function's) is the next minute's, as the indicators' sweep
// takes it (indicators.ts startWaitMs)
export const GOLD_EARLY_START_MS = 2_000;
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

// The run started at `startMs`: the minute it is in (or the next one, in a
// minute's last GOLD_EARLY_START_MS)
export const goldTickPlan = (startMs: number): GoldTickPlan => {
  const minuteStart = Math.floor((startMs + GOLD_EARLY_START_MS) / MIN) * MIN;
  return { minuteStart, stopAt: minuteStart + MIN + GOLD_TICK_OVERLAP_MS, judgeAt: minuteStart + GOLD_JUDGE_AFTER_MS };
};

// While gold is shut (its daily hour, the week's end), the run for the
// minute at `minuteStart` judges only while the last minute gold traded may
// still be fresh (indicators.ts freshFor: two minutes): GOLD_JUDGE_AFTER_MS
// after that minute closed, and once more a minute later, as every minute
// is judged twice — the first run after gold shut may begin late, or not at
// all, and a run begun a minute late is the next minute's. The other minutes
// while gold is shut have no bar to judge.
export const judgesWhileShut = (minuteStart: number): boolean =>
  !isPossiblyClosedFor(GOLD, minuteStart - MIN) || !isPossiblyClosedFor(GOLD, minuteStart - 2 * MIN);

// When the next read is begun, the last one having begun at `lastAt`: a
// read late by more than the gap is followed at once, not twice as fast
export const nextTickAt = (lastAt: number, nowMs: number): number => Math.max(nowMs, lastAt + GOLD_TICK_EVERY_MS);

// The recorded minutes that have closed by `nowMs` (oldest first, as read)
export const closedMinutes = <T extends { minute: string }>(minutes: ReadonlyArray<T>, nowMs: number): T[] =>
  minutes.filter((m) => Date.parse(m.minute) + MIN <= nowMs);

// ---- the fill of the minutes before the recording began -------------------------------------
//
// Once, by hand, through the run {"mode": "gold-seed"}, while gold is shut
// and before the recording has begun — the run refuses once a 'swissquote'
// row is in the table: rows a chart's ticker recorded before the recording,
// hours apart, would end the fill, and the minutes between them and the
// recording would be drawn and judged as if they ran on (the third review,
// docs §8.112): Twelve Data's newest 1-minute bars, none that has not ended
// GOLD_QUOTE_STALE_MS before now (a minute Swissquote may still be
// recording). A minute already in the table is left as it is; a minute
// Twelve Data gave twice, its first.
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
export const goldSeedRows = (bars: ReadonlyArray<Candle>, nowMs: number): SeedRow[] => {
  const out: SeedRow[] = [];
  const seen = new Set<number>();
  for (const b of bars) {
    const open = barOpenMs(b.datetime);
    if (!Number.isFinite(open) || open % MIN !== 0 || seen.has(open)) continue;
    if (open + MIN > nowMs - GOLD_QUOTE_STALE_MS) continue;
    if (![b.open, b.high, b.low, b.close].every((v) => Number.isFinite(v) && v > 0) || b.high < b.low) continue;
    seen.add(open);
    const at = new Date(open).toISOString();
    out.push({ minute: at, open: b.open, high: b.high, low: b.low, close: b.close, first_at: at, last_at: at, samples: 0, source: "twelvedata" });
  }
  return out;
};
