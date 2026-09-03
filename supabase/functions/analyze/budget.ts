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
