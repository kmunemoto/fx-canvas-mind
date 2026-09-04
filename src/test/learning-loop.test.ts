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
