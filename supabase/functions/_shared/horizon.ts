// THE PERIOD A PLAN IS A PROPOSAL TO CAPTURE.
//
// THE COMPLAINT THIS ANSWERS. A SELL never said which period of price movement
// it was proposing to capture. The timeframe dropdown reads like a horizon and
// is not one: under market_v1 the instruction is the same on every rung —
// "enter at the price of this moment, or stand aside" — and the forming bar is
// an input, so a 1day pick can change its mind inside an hour.
//
// AND THE THING THAT MAKES THAT WORSE, WHICH IS WHY THIS FILE EXISTS AT ALL:
// the horizon was never missing. It was decided FOUR times, per interval, in
// four unrelated files, disagreeing by up to 40x, and declared to nobody:
//
//   econ-calendar/events.ts  HORIZON_MS       1h -> 12 hours   (what the model is told to look ahead)
//   track-outcomes/evaluate  ENTRY_WINDOW_MS  1h -> 48 hours   (unfilled-entry validity; the WAIT window)
//   track-outcomes/evaluate  EXPIRY_DAYS      1h -> 20 market days (~28 calendar)
//   analyze/entry.ts         MAX_STOP_ATR     1.0 ATR of ONE entry bar
//
// So a fifth number would have made it worse. This file adds none: the table
// below is HORIZON_MS read in the unit the trade is actually measured in.
//
// WHY BARS. Measured over the 53 settled trades in production (2026-09-14),
// holding time in ENTRY BARS is roughly interval-independent while wall-clock
// duration varies ~74x:
//
//   interval   n   median   p75    p90     max
//   15min     12   1.05     3.91   26.87   31.51
//   1h        25   1.67     3.42    9.08   19.07
//   4h        10   1.26     3.56    7.39    8.52
//   1day       6   2.82     3.04    3.70    4.32
//
// A declaration written in hours is four unrelated numbers. Written in bars it
// is one statement. It is also the unit _shared/conditional-wait.ts already
// uses for `expires_bars`, so the declaration and the later measurement of it
// are never in different units.
//
// AND IT IS NOT A CUTOFF. This is the load-bearing decision, and it is
// measured rather than preferred. Truncating scoring at the declared bar count
// would have discarded, of those same 53 settled trades:
//
//   at  6 bars — 11 trades (21%), 4 of them wins
//   at 12 bars —  3 trades  (6%), 2 of them wins
//   at 24 bars —  2 trades  (4%), BOTH wins
//
// The long tail is where the winners are. So a plan past its declared period
// keeps being scored to settlement, and whether it settled inside the period
// is recorded BESIDE the win or loss rather than instead of it. A 31-bar
// winner is a win that reads `within: false`, and that is the intended
// reading, not an exception.
//
// Deno-free on purpose: src/test/horizon.test.ts imports this file.

// The period a plan of each timeframe is a proposal to capture, in bars of
// that timeframe.
//
// NO NUMBER IS INTRODUCED HERE. These are econ-calendar's HORIZON_MS divided
// by each interval's own bar length: 6h/15min = 24, 12h/1h = 12, 48h/4h = 12,
// 120h/1day = 5. events.ts now derives HORIZON_MS back from this table, and
// src/test/horizon.test.ts pins all four products, so the identity cannot be
// broken silently in either direction.
//
// Against the measured p90 above: 12 covers 1h (9.08) and 4h (7.39), 5 covers
// 1day (3.70), and 24 sits just under 15min's 26.87 — a p90 computed from
// twelve trades, which is the weakest of the four and is named as such rather
// than defended. The point of stamping it on the row is that it becomes a
// number that can be argued with and replaced WITHOUT re-grading a single
// plan already issued; today it is none of those things.
export const PLAN_HORIZON_BARS: Record<string, number> = {
  "15min": 24,
  "1h": 12,
  "4h": 12,
  "1day": 5,
};

// One entry-timeframe bar, in milliseconds.
export const ENTRY_BAR_MS: Record<string, number> = {
  "15min": 15 * 60_000,
  "1h": 60 * 60_000,
  "4h": 4 * 60 * 60_000,
  "1day": 24 * 60 * 60_000,
};

// Which table produced the number on this row. One value is reachable today;
// the field exists from day one so that when the analyst is allowed to name
// its own period, a reader can tell a declaration from a default without the
// stored shape changing under them.
export type HorizonSource = "interval_table_v1" | "model";

export interface PlanHorizon {
  version: 1;
  bars: number;
  interval: string;
  source: HorizonSource;
  // One bar of the entry timeframe, so the bar count can be read back without
  // trusting that some other file still holds the same map.
  bar_ms: number;
  // The instant the period was measured from. priced_at, never created_at:
  // created_at is stamped after the model turn, the gate, the open-plan query
  // and the history write — 30 to 120 seconds later — and this project has
  // already paid for that difference twice in the tracker.
  declared_at: string;
  // Where the period ends in MARKET time, frozen here rather than recomputed
  // later from a constant. Accurate to within HORIZON_STEP_MS (30 minutes),
  // which is why every string that renders it says "about".
  ends_at: string;
  // Does the economic calendar's lookahead actually cover this period? The
  // calendar is spent in WALL clock (a release is scheduled in wall clock)
  // while this window is walked in MARKET time, so on a Friday they diverge by
  // up to the weekend. Recorded per row rather than asserted away.
  calendar_covers_horizon: boolean;
}

// The scoring windows this plan was ISSUED under, frozen onto the row.
//
// Not the horizon, and deliberately not merged with it: these are the
// tracker's outer bounds — when to stop waiting for an unfilled entry, and
// when to give up tracking altogether — and their values are untouched here.
// Freezing them is what later makes those tables changeable without silently
// re-grading plans already issued. The scorer reads them from live module
// constants today (track-outcomes/evaluate.ts), which is the same hazard
// waits.ts already fixed for itself by reading levels off the stored plan.
export interface ScoringWindows {
  version: 1;
  unfilled_entry_ms: number;
  wait_window_ms: number;
  give_up_days: number;
}

// The windows a row is actually SCORED under (#91 step 2).
//
// Before this, every scorer read the live module constants, so changing a
// table silently re-graded plans that had already been issued under the old
// one — a plan could become "expired" because the allowance shrank after it
// was made, and nothing on the row would say why. `scoring_windows` is frozen
// onto the row at issue precisely so that cannot happen; this is the reader
// that makes the freeze real.
//
// FIVE call sites read those tables and they are NOT independent:
//   track-outcomes/evaluate.ts  the unfilled-entry window and the give-up window
//   track-outcomes/index.ts     the WAIT scorer's horizon
//   postmortem/index.ts         the WAIT DIAGNOSIS window — deliberately the
//                               same horizon judgeWait walked, so freezing one
//                               without the other would have the scorer and
//                               the diagnosis reading one row through two
//                               different windows
//   postmortem/facts.ts         life_used_ratio's denominator
// One reader for all five, because two implementations of "which window" is
// how they come apart.
//
// The fallback is passed IN rather than imported, so this module stays free of
// the scorer's dependencies and each caller keeps using the table it already
// used. `source` is returned so a verdict can be audited later: without it
// there is no way to tell whether a row was judged on its own windows or on
// today's.
export interface ResolvedWindows {
  unfilled_entry_ms: number;
  wait_window_ms: number;
  give_up_days: number;
  source: "row" | "table";
}

const positive = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;

export const resolveScoringWindows = (
  stored: unknown,
  fallback: { unfilledEntryMs: number; waitWindowMs: number; giveUpDays: number },
): ResolvedWindows => {
  const table: ResolvedWindows = {
    unfilled_entry_ms: fallback.unfilledEntryMs,
    wait_window_ms: fallback.waitWindowMs,
    give_up_days: fallback.giveUpDays,
    source: "table",
  };
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return table;
  const w = stored as Record<string, unknown>;
  if (w.version !== 1) return table;
  const unfilled = positive(w.unfilled_entry_ms);
  const wait = positive(w.wait_window_ms);
  const giveUp = positive(w.give_up_days);
  // All three or none. A half-read object would score one leg on the row and
  // another on the table, which is the disagreement this reader exists to
  // prevent — and `source` would then be a lie whichever value it named.
  if (unfilled === null || wait === null || giveUp === null) return table;
  return {
    unfilled_entry_ms: unfilled,
    wait_window_ms: wait,
    give_up_days: giveUp,
    source: "row",
  };
};

export const horizonBars = (interval: string): number | null =>
  PLAN_HORIZON_BARS[interval] ?? null;

export const entryBarMs = (interval: string): number | null =>
  ENTRY_BAR_MS[interval] ?? null;

// The period in WALL-clock milliseconds. This is what the economic calendar
// spends, because a release is scheduled in wall clock.
export const horizonWallMs = (interval: string): number | null => {
  const bars = horizonBars(interval);
  const bar = entryBarMs(interval);
  return bars === null || bar === null ? null : bars * bar;
};

// Build the row's declaration. Returns null for an interval with no entry in
// the table rather than falling back to a default: a number nobody chose for
// this timeframe, stored as though somebody had, is exactly the kind of claim
// this file exists to stop.
export const buildPlanHorizon = (input: {
  interval: string;
  pricedAtIso: string;
  // marketHorizonEnd(fromMs, horizonMs) — injected so this file stays free of
  // the market calendar, and so the test can supply a stub.
  marketEnd: (fromMs: number, horizonMs: number) => number;
  // The wall-clock lookahead the calendar was actually read over, so the
  // divergence between the two clocks is measured rather than assumed.
  calendarLookaheadMs: number;
}): PlanHorizon | null => {
  const bars = horizonBars(input.interval);
  const bar = entryBarMs(input.interval);
  if (bars === null || bar === null) return null;
  const from = Date.parse(input.pricedAtIso);
  if (!Number.isFinite(from)) return null;

  const endsAt = input.marketEnd(from, bars * bar);
  if (!Number.isFinite(endsAt)) return null;

  return {
    version: 1,
    bars,
    interval: input.interval,
    source: "interval_table_v1",
    bar_ms: bar,
    declared_at: new Date(from).toISOString(),
    ends_at: new Date(endsAt).toISOString(),
    calendar_covers_horizon: from + input.calendarLookaheadMs >= endsAt,
  };
};
