// How the analyze function spends the worker's lifetime.
//
// Supabase kills the worker at 150s wall clock with no chance to respond: the
// client sees a bare 546 and the credit spent up front is never refunded. So
// the function keeps its own, shorter budget and stops itself.
//
// Production logs showed a full-mode turn (web search + Opus 5) hitting the
// budget at 135002ms, so the searching attempt gets only part of it and the
// rest is held back for a technical-only answer. A degraded result beats an
// error after the same wait.
//
// Deno-free on purpose: src/test/budget.test.ts imports this file directly.

export const WALL_CLOCK_BUDGET_MS = 135_000;
export const SEARCH_BUDGET_MS = 85_000;

// The GMO price overlay runs CONCURRENTLY with the Twelve Data fetch that stays
// the fallback, so its marginal cost is max(0, gmo - twelveData). This caps the
// tail: 250 hourly bars is ~11 day files at two requests each, measured at
// 150-400ms a hop, so 8s is roughly twice the expected worst case and still
// leaves the whole SEARCH_BUDGET_MS intact. A blown budget costs a label, never
// an analysis.
//
// Anchored where the fetch STARTS, not at the top of the request: five
// sequential round trips (auth, profile, quota, rulebook, calendar) precede it,
// and measuring from the start would silently hand the walk almost nothing on a
// slow tick.
export const PRICE_OVERLAY_BUDGET_MS = 8_000;

export interface AttemptPlan {
  // run: send the request with this timeout.
  // drop_search: abandon web search first, then run with the returned timeout.
  // out_of_time: nothing useful can still be done.
  action: "run" | "drop_search" | "out_of_time";
  timeoutMs: number;
}

export const planAttempt = (elapsedMs: number, searchEnabled: boolean): AttemptPlan => {
  const overall = WALL_CLOCK_BUDGET_MS - elapsedMs;
  if (overall <= 0) return { action: "out_of_time", timeoutMs: 0 };

  if (!searchEnabled) return { action: "run", timeoutMs: overall };

  const forSearch = SEARCH_BUDGET_MS - elapsedMs;
  if (forSearch <= 0) return { action: "drop_search", timeoutMs: overall };

  // Never let the search attempt run past the overall budget either.
  return { action: "run", timeoutMs: Math.min(forSearch, overall) };
};

// A searching turn that timed out can still be answered without search, as long
// as the overall budget has time left in it.
export const canRetryWithoutSearch = (elapsedMs: number, searchEnabled: boolean): boolean =>
  searchEnabled && WALL_CLOCK_BUDGET_MS - elapsedMs > 0;

// ---------------------------------------------------------------------------
// The held-position review (analyze/review.ts) runs BESIDE the main call, not
// after it, and it is never allowed to cost the analysis anything.
// ---------------------------------------------------------------------------

// What the save tail needs after the review is awaited: the history row (up
// to SAVE_ATTEMPTS hops with 400+800ms of backoff), the two prompt-record
// hops and the shadow hop, none of them individually timed. Same name and
// value as the write reserve every other long function keeps.
export const WRITE_RESERVE_MS = 10_000;

// The longest the response may wait for the review AFTER the main turn has
// returned. The review starts when the prompt is built, so on a technical run
// it has had the whole main turn (mean 31.7s, p99 42.6s at "medium") to
// finish before this timer even starts; the grace only matters when it is
// still running then. Treat the number as a measurement to be revisited from
// the review's own recorded elapsed_ms, never as a target.
export const REVIEW_GRACE_MS = 15_000;

// The review's own absolute deadline, fixed when it starts: it may never run
// past the point where the save tail could no longer fit, on any path.
export const reviewDeadlineMs = (elapsedMs: number): number =>
  Math.max(0, WALL_CLOCK_BUDGET_MS - elapsedMs - WRITE_RESERVE_MS);

// How long the response waits for a review that is still running once the
// main turn is done: the grace, but never past the deadline above.
export const planReviewWait = (elapsedMs: number): number =>
  Math.max(0, Math.min(REVIEW_GRACE_MS, reviewDeadlineMs(elapsedMs)));
