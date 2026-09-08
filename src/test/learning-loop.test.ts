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
// The gate on a candidate lives in its own file now: what it counts (episodes,
// not rows) is arithmetic worth testing without a database or a model call.
const promotionSrc = readFileSync("supabase/functions/postmortem/promotion.ts", "utf8");

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
    // The reverse order stranded the plan for good: a done row that has spent
    // its revision matches no branch of retryFilter, and the consolidation
    // that rewrites the rules reads the lessons table, so that plan's
    // experience never reached the rules again.
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
    expect(index).toContain("lessons?select=analysis_id,postmortem_version&analysis_id=in.");
    expect(index).toContain("lessons_repaired");
    const repair = index.slice(index.indexOf("---- repair:"), index.indexOf("---- rulebook"));
    expect(repair).not.toMatch(/askModel/);
  });

  it("rebuilds a lesson that no longer matches the diagnosis it claims to summarize", () => {
    // Absence was the only failure the pass could see. 321bccaa carried a v16
    // lesson under a v17 diagnosis: the editor reads the lessons table, so it
    // was shown a cause and a lesson text that no longer exist on the row. The
    // revisit makes that the common case rather than the exception.
    const repair = index.slice(index.indexOf("---- repair:"), index.indexOf("---- rulebook"));
    // The version travels with the id, so the comparison still costs one
    // short string per row and not the 8-10 KB document.
    expect(repair).toContain("select=id,doc_version:postmortem->>version");
    expect(repair).toMatch(/lessonVersion\.get\(id\) !== docVersion\.get\(id\)/);
    expect(repair).toContain("[...missingIds, ...staleIds].slice(0, REPAIR_PER_RUN)");
    // and it is still a re-projection: no model call, same writeLesson
    expect(repair).not.toMatch(/askModel/);
    expect(repair).toContain("await writeLesson(");
    // a failed read of the lessons table still aborts rather than reading as
    // an empty set — otherwise every row in the scan looks lessonless (never
    // stale: staleIds needs lessonVersion.has(id)) and the pass grinds through
    // the whole scan REPAIR_PER_RUN at a time on the strength of a 500
    expect(repair).toContain('errors.push("repair: lessons unavailable, skipped")');
    expect(repair).toContain('throw new Error("skip repair")');
    expect(repair).toContain("REPAIR_SCAN");
    expect(repair).toContain("REPAIR_PER_RUN");
  });

  it("does not put a revision in front of the analyst until the live one was measured", () => {
    // Versions 6, 7 and 8 were each replaced before a single trade under them
    // closed. Experience still flows into a candidate on the old cadence;
    // only the swap waits.
    expect(promotionSrc).toContain("MIN_DECIDED_EPISODES = 10");
    expect(promotionSrc).toContain("outcome=in.(win,loss,expired)&shadow=is.false");
    expect(index).toContain("const measured = gate.measured;");
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
    expect(promotionSrc).toContain("measured: version === 0 || episodes >= MIN_DECIDED_EPISODES,");
    expect(promotionSrc).toContain("measured: version === 0,");
  });

  it("does not read a failed count as zero decided trades", () => {
    // A failed read is unknown, not zero: coercing it to zero demotes a
    // revision that had earned promotion and reports the coercion as a fact.
    expect(index).toContain("decidedRows === null ? null : decidedRows.map(");
    expect(promotionSrc).toContain("episodes: null,");
    expect(index).toContain('errors.push("rulebook: decided count unavailable")');
  });

  it("does not read a failed lessons lookup as no lessons", () => {
    expect(index).toContain('errors.push("repair: lessons unavailable, skipped")');
    // and fetches the heavy documents only for the rows that need rebuilding
    expect(index).toContain("analyses?select=id,doc_version:postmortem->>version&postmortem->>status=eq.done");
    expect(index).toContain("const missingIds = ids.filter((id) => !lessonVersion.has(id));");
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
    // Named against the CURRENT constant. Under the old name this assertion
    // went vacuous the moment UNCITABLE_CAUSES was renamed to
    // NOT_RULE_EVIDENCE — the regex would have matched nothing and passed
    // whatever the list contained.
    expect(promptSrc).toMatch(/NOT_RULE_EVIDENCE: readonly string\[\]/);
    expect(promptSrc).not.toMatch(/NOT_RULE_EVIDENCE[^;]*wait_missed_trade/);
  });

  it("never falls back to a trade cause on a call that never entered", () => {
    // parseDiagnosis uses the deterministic hint when the model's cause is
    // not one of ours, and facts.hints are built from the trade taxonomy
    expect(postmortemSrc).toContain("wait ? [wait.hint] : facts.hints");
    expect(postmortemSrc).toContain('wait ? "WAIT" : row.signal,');
  });
});

// The first pass at the WAIT diagnosis handed the model trade-shaped facts:
// windows that run past the graded horizon, counterfactuals re-judged over
// twenty days, and a deterministic hint from the trade taxonomy. All three
// can assert that the declined trade won, for a window the tracker never
// graded — the hindsight this phase removed, arriving back as "facts".
describe("a WAIT diagnosis sees only the window its verdict was decided in", () => {
  const factsSrc = readFileSync("supabase/functions/postmortem/facts.ts", "utf8");

  it("stops the life horizon at the end of the graded window", () => {
    expect(factsSrc).toContain("const wait = ctx.wait ?? null;");
    expect(factsSrc).toContain("? wait.untilMs");
    expect(index).toContain("marketHorizonEnd(");
  });

  it("computes no after-window and no counterfactuals for a WAIT", () => {
    expect(factsSrc).toContain("const after = !wait && Number.isFinite(resolvedMs)");
    expect(factsSrc).toContain("if (!wait && reference !== null && !filled && coherentAt(reference))");
  });

  it("never hands it a hint from the trade taxonomy", () => {
    expect(factsSrc).toContain("const hints: Cause[] = wait ? [wait.hint] : [];");
    expect(factsSrc).toContain("if (wait || hints.includes(c)) return;");
  });

  it("walks from the instant the plan was priced, not the insert", () => {
    const tracker = readFileSync("supabase/functions/track-outcomes/index.ts", "utf8");
    expect(tracker).toContain('const decidedMs = Date.parse(String(plan?.decided_at ?? ""));');
    expect(tracker).toContain("Number.isFinite(decidedMs) ? decidedMs : insertedMs");
  });
});

// Ungradeable rows are permanent: the tracker never revisits no_call or
// unknown, so such a row never gets a diagnosis and matches the candidate
// query forever. Forty of them, ordered oldest first, would fill the page and
// hide every gradeable WAIT behind them.
describe("the WAIT queue cannot be blocked by rows that can never be graded", () => {
  it("filters the verdict in SQL, before the page is taken", () => {
    expect(index).toContain("&wait_check->>verdict=in.(missed,correct)&");
  });

  it("does not draw two lessons from one refusal", () => {
    // The refused plan is already tracked as a shadow and diagnosed as a
    // trade; diagnosing the WAIT parent too would double the revision clock
    expect(index).toContain("if (shadowParents.has(String(r.id))) continue;");
  });

  it("repairs a stranded WAIT lesson too", () => {
    // closed_at is always NULL on a WAIT, so nullslast sorted every one of
    // them behind every diagnosed trade
    expect(index).toContain("&order=created_at.desc&limit=${REPAIR_SCAN}");
    expect(index).not.toContain("closed_at.desc.nullslast");
  });

  it("reports both queues, so a WAIT-only run does not read as empty", () => {
    expect(index).toContain("candidates: candidates.length + waitCandidates.length,");
    expect(index).toContain("wait_candidates: waitCandidates.length,");
  });
});
// A diagnosis is written very soon after settlement by design (AFTER_WAIT_MS
// is 1h on a 15min plan, 8h on a daily one), and twenty of the thirty-two
// lessons in the table rest on eight bars or fewer (production, 2026-09-08). `thin` was our guess at
// which of those readings were unreliable; the guess is what is being dropped
// here, because a reading at nine bars is not obviously safer than one at
// eight. The one thing that must not happen is spending the single revision
// while overwriting what the shallow reading had said.
describe("every diagnosis is revisited once, and the reading it replaces is kept", () => {
  const built = (() => {
    const at = index.indexOf("const retryFilter = [");
    expect(at).toBeGreaterThan(-1);
    return index.slice(at, index.indexOf("].join(\",\");", at));
  })();

  it("no longer asks whether the diagnosis was flagged thin", () => {
    expect(built).not.toContain("thin.eq.true");
    expect(built).not.toContain("thin.is.null");
  });

  it("tolerates a missing revisions counter, or the revisit never fires at all", () => {
    // `revisions` is absent from every document written before the counter
    // existed. In PostgREST `postmortem->>revisions.lt.1` on an absent key is
    // a comparison against SQL NULL, which yields NULL and not true, so the
    // row does not match — and the `thin.is.null` branch that used to carry
    // those rows is gone. Without the is.null companion the change is inert.
    expect(index).toContain(
      "const revisionsLeft = `or(postmortem->>revisions.is.null,postmortem->>revisions.lt.${MAX_REVISIONS})`;",
    );
    expect(built).toContain("${revisionsLeft}");
    // the same shape the file already uses one line above, for the same reason
    expect(index).toContain(
      "const revisitRetryable = `or(postmortem->>revisit_attempts.is.null,postmortem->>revisit_attempts.lt.${MAX_ATTEMPTS})`;",
    );
  });

  it("builds a balanced or=(...) expression", () => {
    // Hand-built PostgREST. A misplaced parenthesis is a 400 that the sweep
    // swallows, and the run reports nothing to do.
    const MAX_ATTEMPTS = 3;
    const MAX_REVISIONS = 1;
    const revisitRetryable = `or(postmortem->>revisit_attempts.is.null,postmortem->>revisit_attempts.lt.${MAX_ATTEMPTS})`;
    const revisionsLeft = `or(postmortem->>revisions.is.null,postmortem->>revisions.lt.${MAX_REVISIONS})`;
    const filter = [
      "or=(postmortem.is.null",
      `and(postmortem->>status.eq.failed,postmortem->>attempts.lt.${MAX_ATTEMPTS})`,
      `and(postmortem->>status.eq.done,${revisionsLeft},${revisitRetryable}))`,
    ].join(",");
    // the literal this test rebuilt is the literal the function ships
    expect(index).toContain("`and(postmortem->>status.eq.done,${revisionsLeft},${revisitRetryable}))`");
    let depth = 0;
    for (const c of filter) {
      if (c === "(") depth++;
      else if (c === ")") depth--;
      expect(depth).toBeGreaterThanOrEqual(0);
    }
    expect(depth).toBe(0);
  });

  it("still refuses to spend the revision on a run that named the row", () => {
    // A hand-run by id is how a diagnosis is inspected; if it consumed the
    // one revision, looking at a row would be what stops it being revisited.
    expect(index).toContain(
      'revisions: (numberOrNull(priorDoc?.revisions) ?? 0) + (priorDoc?.status === "done" && options.ids.length === 0 ? 1 : 0),',
    );
  });

  it("carries the earlier reading forward instead of writing over it", () => {
    // MAX_REVISIONS is 1: this is the only occasion there will ever be to
    // record what the shallow reading claimed, and without it "did depth
    // change the answer" cannot be asked after the fact.
    const stored = index.slice(index.indexOf("const priorTrail ="), index.indexOf("      // The lesson goes in FIRST."));
    expect(stored).toContain("const prior = priorDoc?.status === \"done\"");
    // capped the way the rulebook caps its history, not with a new idiom
    expect(stored).toContain("priorTrail.slice(-(HISTORY_KEEP - 1))");
    // what a later reader needs to compare the two readings
    for (const field of [
      "version:", "created_at:", "cause:", "secondary_causes:", "avoidable:", "confidence:",
      "rule_blamed:", "rule_credited:", "lesson:", "bars_after_settlement:",
    ]) expect(stored).toContain(field);
    // ...and nothing that would square the document, which is already 8-10 KB
    const snapshot = stored.slice(stored.indexOf("priorTrail.slice("), stored.indexOf("        : priorTrail;"));
    expect(snapshot).not.toMatch(/\bfacts,/);
    expect(snapshot).not.toMatch(/\bprior:/);
    expect(index).toContain("        prior,");
  });

  it("does not call a WAIT shallow, having never measured its aftermath", () => {
    // facts.ts short-circuits the aftermath of a call that never traded to an
    // empty array on purpose, so bars_after_settlement is 0 by construction
    // and thin was permanently true — a claim about a measurement that was
    // never taken.
    expect(index).toContain("thin: wait ? null : facts.bars_after_settlement < MIN_AFTER_BARS,");
  });
});
