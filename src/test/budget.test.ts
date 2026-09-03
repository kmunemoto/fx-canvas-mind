import { describe, it, expect } from "vitest";
import {
  SEARCH_BUDGET_MS,
  WALL_CLOCK_BUDGET_MS,
  canRetryWithoutSearch,
  planAttempt,
} from "../../supabase/functions/analyze/budget";

describe("budget shape", () => {
  it("stays inside Supabase's 150s worker lifetime", () => {
    // Production logs: reason="WallClockTime" at exactly 150.0s from boot.
    expect(WALL_CLOCK_BUDGET_MS).toBeLessThan(150_000);
  });

  it("leaves real room for a technical-only answer after search is dropped", () => {
    const reserve = WALL_CLOCK_BUDGET_MS - SEARCH_BUDGET_MS;
    // A technical-only turn is the fast path, but it is not instant. If someone
    // raises SEARCH_BUDGET_MS the fallback quietly stops fitting, so pin it.
    expect(reserve).toBeGreaterThanOrEqual(30_000);
  });
});

describe("planAttempt", () => {
  it("gives a technical-only run the whole remaining budget", () => {
    expect(planAttempt(10_000, false)).toEqual({
      action: "run",
      timeoutMs: WALL_CLOCK_BUDGET_MS - 10_000,
    });
  });

  it("caps a searching run at the search budget", () => {
    expect(planAttempt(10_000, true)).toEqual({
      action: "run",
      timeoutMs: SEARCH_BUDGET_MS - 10_000,
    });
  });

  it("drops search once it has used its share, and hands the rest over", () => {
    const plan = planAttempt(SEARCH_BUDGET_MS + 1, true);
    expect(plan.action).toBe("drop_search");
    expect(plan.timeoutMs).toBeGreaterThan(0);
    expect(plan.timeoutMs).toBe(WALL_CLOCK_BUDGET_MS - SEARCH_BUDGET_MS - 1);
  });

  it("reports out of time once the overall budget is gone", () => {
    for (const elapsed of [WALL_CLOCK_BUDGET_MS, WALL_CLOCK_BUDGET_MS + 5_000]) {
      for (const searching of [true, false]) {
        expect(planAttempt(elapsed, searching).action).toBe("out_of_time");
      }
    }
  });

  it("never returns a non-positive timeout for a runnable attempt", () => {
    for (let elapsed = 0; elapsed < WALL_CLOCK_BUDGET_MS + 10_000; elapsed += 997) {
      for (const searching of [true, false]) {
        const plan = planAttempt(elapsed, searching);
        if (plan.action !== "out_of_time") {
          expect(plan.timeoutMs, `elapsed=${elapsed} searching=${searching}`).toBeGreaterThan(0);
        }
      }
    }
  });

  it("never lets a searching attempt outlive the overall budget", () => {
    for (let elapsed = 0; elapsed < WALL_CLOCK_BUDGET_MS; elapsed += 997) {
      const plan = planAttempt(elapsed, true);
      if (plan.action !== "out_of_time") {
        expect(elapsed + plan.timeoutMs).toBeLessThanOrEqual(WALL_CLOCK_BUDGET_MS);
      }
    }
  });
});

describe("canRetryWithoutSearch", () => {
  it("is true while searching and time remains — the whole point of the fallback", () => {
    expect(canRetryWithoutSearch(SEARCH_BUDGET_MS + 1, true)).toBe(true);
  });

  it("is false once the overall budget is spent", () => {
    expect(canRetryWithoutSearch(WALL_CLOCK_BUDGET_MS, true)).toBe(false);
  });

  it("is false when search was never on — there is nothing left to drop", () => {
    expect(canRetryWithoutSearch(1_000, false)).toBe(false);
  });
});
