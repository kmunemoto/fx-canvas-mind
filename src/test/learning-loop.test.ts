import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { PLAN_CONTRACT } from "../../supabase/functions/_shared/contract";
import { CURRENT_CONTRACT, LEGACY_CONTRACT } from "../lib/outcomeStats";
import { LEGACY_PLAN_CONTRACT } from "../../supabase/functions/_shared/contract";

// The loop is three layers — judge, diagnose, consolidate — and only the
// third one can stall without anything going red. It did: the rulebook sat on
// one version for seventeen hours with seven lessons past due while every
// fifteen-minute tick reported success, because consolidation was gated on
// "did THIS run write a lesson". Once the diagnosis backlog cleared, no run
// ever wrote one again, so no run ever looked.
//
// These read the deployed sources rather than a fixture, because the failure
// was never in the logic that the unit tests cover — it was in the condition
// that decides whether that logic is reached at all.
const index = readFileSync("supabase/functions/postmortem/index.ts", "utf8");

describe("the rulebook can actually be revised", () => {
  it("does not require this run to have written a lesson", () => {
    // revisionDue() already asks the only question that matters — how much has
    // gathered since the version in force. Anything ANDed in front of it is a
    // second, weaker gate that can close forever.
    const gate = index.slice(index.indexOf("let rulebook: JsonRecord | null = null;"), index.indexOf("const lessonSelect"));
    expect(gate).not.toMatch(/newLessons > 0/);
    expect(index).toContain("revisionDue(sinceVersion, updatedAt, nowMs)");
  });

  it("records the run that ran out of clock instead of skipping in silence", () => {
    // This is the half that gets likelier the more there is to learn from:
    // every diagnosis ahead of the consolidation costs a model call.
    expect(index).toContain('reason: "deferred_time_budget"');
    expect(index).toMatch(/errors\.push\(`rulebook: deferred/);
  });

  it("learns from every account, weighted by situation rather than by volume", () => {
    // Over-fetch then round-robin: taking the newest N and only then sharing
    // them out would already have dropped every account the busiest outran.
    expect(index).toContain("RECENT_LESSONS * FAIR_FETCH_MULTIPLE");
    expect(index).toContain("RECENT_ROWS * FAIR_FETCH_MULTIPLE");
    expect(index).toMatch(/fairShare\(lessonPool,/);
    expect(index).toMatch(/fairShare\(recordPool,/);
    // No user filter anywhere: one shared rulebook, everyone's results
    expect(index).not.toMatch(/lessons\?[^`]*user_id=eq\./);
    expect(index).not.toMatch(/analyses\?[^`]*user_id=eq\./);
    // How many accounts it actually drew on, reported rather than assumed
    expect(index).toContain("lesson_contributors: lessonContributors");
    expect(index).toContain("record_contributors: recordContributors");
  });

  it("stamps the rules it writes with the contract they were written for", () => {
    expect(index).toContain("parseConsolidation(answer, previousRules, nowIso, lessons, PLAN_CONTRACT)");
  });
});

describe("the client and the functions agree on which contract is live", () => {
  it("names the same two contracts on both sides", () => {
    // A drift here is silent and total: the client would hold back every rule
    // the prompt shows, or show every rule the prompt holds back.
    expect(CURRENT_CONTRACT).toBe(PLAN_CONTRACT);
    expect(LEGACY_CONTRACT).toBe(LEGACY_PLAN_CONTRACT);
  });
});

// The gate coming off exposed the layer underneath: consolidation now ran on
// every tick and timed out on every tick, because it borrowed the timeout
// sized for diagnosing ONE plan. A run that always tries and never finishes
// looks, from the rulebook, exactly like the freeze that was just fixed.
describe("consolidation is given enough clock to finish", () => {
  it("does not reuse the single-plan diagnosis timeout", () => {
    const call = index.slice(index.indexOf("buildConsolidationPrompt"), index.indexOf("parseConsolidation("));
    expect(call).toMatch(/askModel\([^)]*CONSOLIDATION_SCHEMA[^)]*consolidationBudget\(\)\)/);
    // The diagnosis call keeps the short one — it reads one trade.
    const diagnosis = index.slice(index.indexOf("DIAGNOSIS_SCHEMA, 2500"), index.indexOf("DIAGNOSIS_SCHEMA, 2500") + 40);
    expect(diagnosis).not.toContain("consolidationBudget");
  });

  it("spends only what is left of the wall clock, keeping the write reserve", () => {
    expect(index).toContain(
      "Math.min(MAX_CONSOLIDATION_MS, WALL_CLOCK_BUDGET_MS - elapsed() - WRITE_RESERVE_MS)",
    );
    // Defers on the budget itself, not on a threshold guessed alongside it:
    // a separate constant can drift out of step with the budget and either
    // start a call that cannot finish or refuse one that could.
    expect(index).toContain("consolidationBudget() < MIN_CONSOLIDATION_MS");
    expect(index).not.toContain("START_CONSOLIDATION_BEFORE_MS");
  });

  it("caps the whole call, so the retry cannot spend the budget twice", () => {
    // askModel retries once when the API rejects output_config.effort. With a
    // per-attempt timeout that retry can outlive the worker, and the worker
    // dying takes the diagnoses written after it down too.
    const ask = index.slice(index.indexOf("const askModel = async"), index.indexOf("// ---- market data"));
    expect(ask).toContain("const deadline = Date.now() + timeoutMs;");
    expect(ask).toContain("AbortSignal.timeout(left)");
    expect(ask).not.toContain("AbortSignal.timeout(LLM_TIMEOUT_MS)");
  });
});
