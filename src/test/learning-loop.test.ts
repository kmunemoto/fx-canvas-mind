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
const promptSrc = readFileSync("supabase/functions/postmortem/prompt.ts", "utf8");
const analyzeSrc = readFileSync("supabase/functions/analyze/index.ts", "utf8");

describe("a plan that was shown is a plan that was kept", () => {
  it("does not report success when the history row did not land", () => {
    // The row IS the plan: unsaved, it never reaches the history, the tracker
    // never settles it, and it never becomes a lesson — while the user was
    // charged a credit for it.
    expect(analyzeSrc).toContain("SAVE_ATTEMPTS");
    expect(analyzeSrc).toContain('error_stage: "history_not_saved"');
    // the failure path goes through fail(), which is the only thing that
    // hands the credit back
    const save = analyzeSrc.slice(analyzeSrc.indexOf("Failed to save analysis history, giving up"), analyzeSrc.indexOf("const shadowable"));
    expect(save).toContain("return await fail(");
  });

  it("never writes a shadow row without the parent it shadows", () => {
    expect(analyzeSrc).toContain("const shadowable = savedId !== null && entryRejected");
  });

  it("keeps what was sent to the model, so the plan can be replayed", () => {
    // The prompt's market content is mostly candle blocks, and the event
    // block's forecast/previous are overwritten in econ_events as the week
    // runs: neither can be rebuilt from parts afterwards.
    // It goes to its own service-role-only table: analyses carries a
    // table-level select grant to authenticated, and the system prompt has
    // never been client-readable.
    expect(analyzeSrc).toContain("/rest/v1/analysis_prompts?on_conflict=analysis_id");
    expect(analyzeSrc).toContain("analysis_id: savedId,");
    expect(analyzeSrc).not.toContain("prompt: promptRecord");
    expect(analyzeSrc).toContain("quote_at_signal: quoteAtSignal");
    // Read back from the request, not from the string first built:
    // giveUpSearch() replaces the user turn when search is abandoned, so a
    // technical_fallback row would otherwise store a prompt never sent.
    expect(analyzeSrc).toContain("const sentTurn = messages[0];");
    expect(analyzeSrc).toContain("user: sentUserText,");
    // and the quote is only recorded when that feed actually priced the plan
    expect(analyzeSrc).toContain('const newestQuote = priceFeed === "gmo"');
  });
});

describe("the rulebook can actually be revised", () => {
  it("does not require this run to have written a lesson", () => {
    // revisionDue() already asks the only question that matters — how much has
    // gathered since the version in force. Anything ANDed in front of it is a
    // second, weaker gate that can close forever.
    const gate = index.slice(index.indexOf("let rulebook: JsonRecord | null = null;"), index.indexOf("const lessonSelect"));
    expect(gate).not.toMatch(/newLessons > 0/);
    expect(index).toContain("revisionDue(sinceVersion, lastRevisionAt, nowMs)");
    // ...and the clock it is paced against is the last revision WRITTEN, not
    // the last one promoted. Pacing on updated_at once promotion can be held
    // back would ask the model for a fresh candidate on every sweep and never
    // let the "since" counter reset.
    expect(index).toContain('const lastRevisionAt = strOrNull(priorCandidate?.created_at) ?? updatedAt;');
  });

  it("writes the lesson before calling the diagnosis done", () => {
    // The reverse order stranded the plan for good: a done row with
    // thin:false matches no branch of retryFilter, and the consolidation that
    // rewrites the rules reads the lessons table, so that plan's experience
    // never reached the rules again.
    const lessonWrite = index.indexOf("const lessonOk = await writeLesson(");
    const markDone = index.indexOf("{ postmortem: stored }");
    expect(lessonWrite).toBeGreaterThan(-1);
    expect(markDone).toBeGreaterThan(-1);
    expect(lessonWrite).toBeLessThan(markDone);
    // A failed insert does NOT hold back the done marker: leaving the row
    // undiagnosed put it straight back at the head of a queue ordered by
    // closed_at, with nothing incrementing attempts, so the same plan burned a
    // model call every sweep and starved everything behind it. The repair pass
    // rebuilds the lesson from the stored diagnosis instead.
    expect(index).toContain("left for the repair pass");
  });

  it("rebuilds a lesson that never landed, without asking the model again", () => {
    // Everything a lessons row needs is in the stored diagnosis and the
    // analyses row, so the rows already stranded can be recovered for the
    // price of an insert.
    expect(index).toContain("postmortem->>status=eq.done");
    expect(index).toContain("lessons?select=analysis_id&analysis_id=in.");
    expect(index).toContain("lessons_repaired");
    const repair = index.slice(index.indexOf("---- repair:"), index.indexOf("---- rulebook"));
    expect(repair).not.toMatch(/askModel/);
  });

  it("does not put a revision in front of the analyst until the live one was measured", () => {
    // Versions 6, 7 and 8 were each replaced before a single trade under them
    // closed. Experience still flows into a candidate on the old cadence;
    // only the swap waits.
    expect(index).toContain("MIN_DECIDED_PER_VERSION");
    expect(index).toContain("outcome=in.(win,loss,expired)&shadow=is.false");
    expect(index).toContain('reason: "candidate_held"');
    expect(index).toContain("decided_needed");
    // the held revision is stored, not thrown away
    const held = index.slice(index.indexOf('reason: "candidate_held"') - 2000, index.indexOf('reason: "candidate_held"'));
    expect(held).toContain("candidate: {");
    expect(held).toContain("base_version: previousVersion");
  });

  it("mints the row id so a retried save cannot write the plan twice", () => {
    // The retry re-POSTs one fixed body, and a dropped response after a
    // committed INSERT would otherwise create a second, independent plan that
    // the tracker settles twice and the record counts twice.
    expect(analyzeSrc).toContain("const analysisId = crypto.randomUUID();");
    expect(analyzeSrc).toContain("id: analysisId,");
    expect(analyzeSrc).toContain("resolution=merge-duplicates");
    // success is the status, not the shape of the body
    expect(analyzeSrc).toContain("if (historyRes.ok) savedId = analysisId;");
    expect(analyzeSrc).not.toContain('saveError = "no id returned"');
  });

  it("can actually promote a candidate it held", () => {
    // Writing a candidate resets the lessons-since counter, so the revision
    // branch is not due on the next run — a promotion evaluated only inside
    // that branch could never be reached, and the column was write-only.
    expect(index).toContain("if (priorCandidate && (measured || options.promote) && !rulebookUnavailable)");
    expect(index).toContain("promoted_from_candidate: true");
    expect(index).toContain("promotedCandidate");
  });

  it("does not hold the first rulebook back forever", () => {
    // Version 0 is an empty book: no rules to measure, and no cohort that
    // could ever exist, because no plan can be made under rules that do not
    // exist.
    expect(index).toContain("const measured = previousVersion === 0 ||");
  });

  it("does not read a failed count as zero decided trades", () => {
    expect(index).toContain("const decidedUnderVersion = decidedRows === null ? null : decidedRows.length;");
    expect(index).toContain('errors.push("rulebook: decided count unavailable")');
  });

  it("does not read a failed lessons lookup as no lessons", () => {
    expect(index).toContain('errors.push("repair: lessons unavailable, skipped")');
    // and fetches the heavy documents only for the rows that need rebuilding
    expect(index).toContain("analyses?select=id&postmortem->>status=eq.done");
    expect(index).toContain("const missingIds = ids.filter((id) => !have.has(id));");
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

// A rule's contract used to be whatever PLAN_CONTRACT the running build held,
// so the field recorded which era was current when the editor happened to run.
// Production proved it: rulebook v7 stamped four rules market_v1 while all 21
// analyses and all 17 lessons were entry_chosen_v1, and one of those rules told
// the analyst where to enter under a contract that fills at the market.
//
// Source pins, because the failure is a single word in an object literal and
// no unit test can see it come back.
describe("a rule's contract says what the rule can do, not when it was written", () => {
  it("derives every stamp through stampFor", () => {
    expect(promptSrc).toContain("export const stampFor = (");
    // Both paths: the re-emitted rule and the restored one. A restore that
    // inherits its stamp is how a dead build's endorsement survives forever.
    const derived = promptSrc.match(/contract: stampFor\(/g) ?? [];
    expect(derived).toHaveLength(2);
  });

  it("never assigns the writing contract straight onto a rule", () => {
    // The exact defect: `contract,` as shorthand for the function argument in
    // the emit-loop object literal.
    expect(promptSrc).not.toMatch(/^\s{6}contract,$/m);
    // ...and the restore path must not spread a stored stamp forward either
    expect(promptSrc).not.toMatch(/rules\.push\(\{ \.\.\.rule, support, supported_by: cited \}\)/);
  });

  it("still asks the question with the live contract", () => {
    expect(index).toContain("parseConsolidation(answer, previousRules, nowIso, lessons, PLAN_CONTRACT)");
    // The old comment claimed emitting a rule WAS the endorsement. It is not:
    // the parser decides, from the rule itself.
    expect(index).not.toContain("Stamped with the contract the editor was writing for");
  });

  it("does not file a plan under a rulebook version whose rules it never saw", () => {
    const writes = analyzeSrc.match(/rulebook_version: rulebookVersion === null \? null : \(rulesShown\.length > 0 \? rulebookVersion : 0\),/g) ?? [];
    expect(writes).toHaveLength(2);
    expect(analyzeSrc).toContain("rulebook_version_read: rulebookVersion,");
  });
});

// A WAIT was filtered out of the review queue twice over — outcome skipped,
// signal WAIT — so the one prediction that costs nothing to make was also the
// one never reviewed, while every diagnosed row pushed the rules toward
// trading less.
describe("standing aside is reviewed like anything else", () => {
  const postmortemSrc = index;

  it("asks for the calls that declined to trade, and only the settled ones", () => {
    expect(postmortemSrc).toContain("analyses?outcome=eq.skipped&signal=eq.WAIT&wait_plan=not.is.null");
    // 'pending' has not been measured and 'unknown' / 'no_call' never can be:
    // diagnosing one would be the model filling in what the data lacks
    expect(postmortemSrc).toContain('if (verdict !== "missed" && verdict !== "correct") continue;');
  });

  it("diagnoses the trade that was declined, and says it was never taken", () => {
    expect(postmortemSrc).toContain("buildWaitDiagnosisPrompt(");
    expect(promptSrc).toContain("WAIT_DIAGNOSIS_SYSTEM_PROMPT");
    expect(promptSrc).toContain("このトレードは実行されていません");
  });

  it("files the lesson under what the row is, not under the hypothetical trade", () => {
    // `row` carries the declined trade's direction and outcome so the facts
    // machinery can measure it. Filing the lesson under those would put a win
    // in the record for a trade nobody took.
    expect(postmortemSrc).toContain('wait ? { ...row, signal: "WAIT", outcome: "skipped" } : row,');
    expect(postmortemSrc).toContain('outcome: wait ? "skipped" : row.outcome,');
    expect(postmortemSrc).toContain('subject: wait ? "wait" : "trade",');
  });

  it("keeps the over-caution evidence citable and the confirmation not", () => {
    // wait_missed_trade is the only cause in the taxonomy that pushes toward
    // trading MORE. If it could not support a rule, the loop could still only
    // push one way.
    expect(promptSrc).toContain('"good_call", "good_wait"');
    expect(promptSrc).not.toMatch(/UNCITABLE_CAUSES[^;]*wait_missed_trade/);
  });

  it("never falls back to a trade cause on a call that never entered", () => {
    // parseDiagnosis uses the deterministic hint when the model's cause is
    // not one of ours, and facts.hints are built from the trade taxonomy
    expect(postmortemSrc).toContain("wait ? [waitHint] : facts.hints");
    expect(postmortemSrc).toContain('wait ? "WAIT" : row.signal,');
  });
});
