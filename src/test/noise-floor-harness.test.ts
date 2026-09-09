import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// The harness itself, read as text.
//
// Everything in noise-floor/index.ts that is worth pinning is a REFUSAL, and a
// refusal cannot be exercised from vitest: the file is Deno, its first act is a
// vault lookup, and its second is a POST to an API that charges for it. What
// can be checked without Deno is that the refusals are still WRITTEN — that the
// default is still the free path, that the cap is still a cap and not a clamp,
// that the abort classes still include the ones that took the live app down on
// 2026-09-08, and that nothing about the token can reach a log.
//
// This is the learning-loop.test.ts pattern and it is here for the same reason
// that file gives: the failures these guard against were never in logic a unit
// test covers. They were in whether the guard is reached at all, and in one
// case (the cron minute set) in a constant that has to agree with a production
// cron schedule no test can see.
const index = readFileSync("supabase/functions/noise-floor/index.ts", "utf8");
const shape = readFileSync("supabase/functions/noise-floor/shape.ts", "utf8");
const surgery = readFileSync("supabase/functions/noise-floor/prompt-surgery.ts", "utf8");
const metric = readFileSync("supabase/functions/noise-floor/metric.ts", "utf8");

// Comment text only: the house rule forbids a model identifier in a comment,
// and permits one as data in a request body or read from a database column.
// Both line and block comments, because the file is mostly block comments.
const commentsOf = (src: string): string => {
  const out: string[] = [];
  const block = /\/\*[\s\S]*?\*\//g;
  const line = /(^|[^:"'`\\])\/\/[^\n]*/g;
  let m: RegExpExecArray | null;
  while ((m = block.exec(src)) !== null) out.push(m[0]);
  while ((m = line.exec(src)) !== null) out.push(m[0]);
  return out.join("\n");
};

// The inverse: everything that is not a comment. The file's own header names
// the things it must never do — ADMIN_EMAILS, /functions/v1/analyze — so a
// "does not contain" assertion against the raw text would be answered by the
// prose that promises not to do it.
const codeOf = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");

const indexCode = codeOf(index);

describe("the free path is the default and the only default", () => {
  it("treats anything but a literal false as a dry run", () => {
    // A body that forgets the field, misspells it, sends the string "false",
    // or is not JSON at all must land on the free path. `!== false` is the
    // whole of that guarantee and it is one character away from `=== true`,
    // which would flip the default the other way.
    expect(index).toContain("const dryRun = body.dry_run !== false;");
    expect(index).not.toContain("body.dry_run === true");
    // and an unparseable body becomes an empty object rather than throwing
    // past the default
    expect(index).toContain("const bodyRaw = await req.json().catch(() => null);");
    expect(index).toContain("const body: JsonRecord = isRecord(bodyRaw) ? bodyRaw : {};");
  });

  it("cannot create a spending run without a completed dry run and two budgets", () => {
    expect(index).toContain('return refuse("dry_run_id is required to create a run that calls the model")');
    expect(index).toContain('return refuse("budget_input_tokens is required and must be a positive integer")');
    expect(index).toContain('return refuse("budget_output_tokens is required and must be a positive integer")');
    expect(index).toContain('if (dryDetail.complete !== true)');
  });

  it("refuses a budget larger than the dry run that was supposed to size it", () => {
    // The check that was missing entirely: "integer" and "> 0" were the only
    // conditions on the number that is the last control before the shared key.
    expect(index).toContain("const dryMeasuredInput = numberOrNull(dryDetail.measured_input_tokens);");
    expect(index).toContain("const dryBoundOutput = numberOrNull(dryDetail.bound_output_tokens);");
    expect(index).toContain("if (budgetIn > inputCeiling)");
    expect(index).toContain("if (budgetOut > outputCeiling)");
    // both measured numbers appear in the refusal, so a refused operator is
    // told what he was compared against
    expect(index).toContain("exceeds ${BUDGET_SLACK}x the dry run's measured ");
    expect(index).toContain("exceeds ${BUDGET_SLACK}x the dry run's bound ");
  });

  it("spends a dry_run_id once", () => {
    // Two POSTs of one creation body used to make two running runs over one
    // population, each inside its own budget.
    expect(index).toContain("notes->>dry_run_id=eq.${dryRunIdIn}");
    expect(index).toContain("dry_run_id has already been spent by run ");
  });
});

describe("the caps are caps, not clamps", () => {
  it("refuses max_cells above the ceiling rather than silently lowering it", () => {
    expect(index).toContain("const MAX_CELLS_CAP = 4;");
    expect(index).toContain("return refuse(`max_cells must be an integer between 1 and ${MAX_CELLS_CAP}`)");
    // a clamp would let a caller ask for 40 and read the answer as though 40
    // had run
    expect(index).not.toMatch(/Math\.min\([^)]*MAX_CELLS_CAP/);
  });

  it("keeps reps inside the pre-registered range", () => {
    expect(index).toContain("const MIN_REPS = 2;");
    expect(index).toContain("const MAX_REPS = 3;");
    expect(index).toContain("return refuse(`reps must be an integer between ${MIN_REPS} and ${MAX_REPS}`)");
  });

  it("cannot widen a resumed run's per-invocation cap", () => {
    expect(index).toContain("const runMaxCells = Math.min(maxCells, numberOrNull(runNotes.max_cells) ?? maxCells);");
  });

  it("refuses a body that names both a run and a row list", () => {
    // Resuming took its ids from the header and ignored the body's, so an
    // operator narrowing a stalled run to a few rows was spending on all of
    // them with nothing in the response saying so.
    expect(index).toContain("run_id is mutually exclusive with analysis_ids");
    expect(index).toContain("run_id is mutually exclusive with arm and reps");
  });
});

describe("the abort classes", () => {
  it("stops the run on every class that means the key will not work", () => {
    // 401/403/429 and a credit-balance 400 are the measured precedent
    // (2026-09-08, six consecutive failures on the shared key, user-visible).
    expect(index).toContain('outcome.abortReason = "http_401"');
    expect(index).toContain('outcome.abortReason = "http_403"');
    expect(index).toContain("outcome.abortReason = `http_429 retry_after=");
    expect(index).toContain("/credit balance is too low/i.test(outcome.errorMessage)");
    expect(index).toContain('outcome.abortReason = "credit_balance_too_low"');
    // 402 is the billing status proper; the substring above is one observed
    // shape of the same fact, not the only one.
    expect(index).toContain('outcome.abortReason = "http_402_billing"');
    // 529 overloaded and every other 5xx: documented as retryable, and this
    // harness's rule is abort-never-retry.
    expect(index).toContain("else if (res.status >= 500)");
    expect(index).toContain("outcome.abortReason = `http_${res.status}`");
  });

  it("never retries a call", () => {
    // A per-cell retry is what would have compounded 2026-09-08. There is no
    // backoff, no attempt counter over transport failures, and the only loop
    // around the fetch is the bounded pause_turn continuation.
    expect(index).not.toMatch(/backoff|retryAfterMs|for \(let retry/i);
    expect(index).toContain("const PAUSE_ATTEMPTS = 5;");
  });

  it("stops the whole run on the first model mismatch instead of buying the rest", () => {
    // It used to be a cell status only. report() drops a row whose cells all
    // failed, with emitted:true, so a mid-run model change quietly shrank the
    // population and a wholesale one spent every call first.
    expect(index).toContain("errorSlice = `model_mismatch:${outcome.responseModel}`");
    expect(index).toContain("outcome.abortReason = errorSlice;");
  });

  it("gives the count_tokens loop the same classes, though it is free", () => {
    // Free is not harmless when the resource is a shared key.
    expect(index).toContain("dryAborted = `count_tokens_http_${res.status}`");
    expect(index).toContain("if (res.status === 401 || res.status === 403 || res.status === 429 || res.status >= 500)");
  });
});

describe("spend that could not be measured is not zero", () => {
  it("keeps a null usage null rather than folding it to a count", () => {
    expect(index).toContain("value === null ? current : (current ?? 0) + value");
  });

  it("charges a bound for a finished cell that reported no usage", () => {
    // A call aborted mid-generation bills for what the server produced and
    // reports no usage, so `?? 0` in the tally made the token budget blind to
    // the class of spend most likely to happen.
    expect(index).toContain("unmeasured += 1;");
    expect(index).toContain("boundInput += unmeasuredCellInputBound;");
    expect(index).toContain("boundOutput += MAX_TOKENS;");
  });

  it("compares the budget against measured plus bound", () => {
    expect(index).toContain("if (t.spentInput + t.boundInput >= budgetInput) return \"budget_input_exhausted\";");
    expect(index).toContain("if (t.spentOutput + t.boundOutput >= budgetOutput) return \"budget_output_exhausted\";");
  });

  it("leaves the two stored columns a measurement", () => {
    // The bound is reported beside spent_*, never inside it: the migration
    // says those columns are measured from usage, and a guess written into
    // them makes every later reading of this run's cost a guess.
    expect(index).toContain("spent_input_tokens: totals.spentInput,");
    expect(index).toContain("bound_input_tokens_unmeasured: totals.boundInput,");
    expect(index).not.toMatch(/spent_input_tokens:\s*totals\.(spentInput \+|boundInput)/);
  });

  it("checks the budget between pause continuations, not only between cells", () => {
    // max_cells counts cells; one cell could make five billed calls.
    expect(index).toContain('outcome.abortReason = "budget_crossed_mid_cell"');
    expect(index).toContain("headroom: { input: number; output: number }");
  });
});

describe("the cron minutes", () => {
  // MEASURED against cron.job on 2026-09-09: track-outcomes 3,18,33,48;
  // postmortem 8,23,38,53; econ-calendar 13. purge-cron-history (0 3 * * *)
  // calls no function and is deliberately excluded.
  const expected = [3, 8, 13, 18, 23, 33, 38, 48, 53];

  it("is the union of the three jobs that fire an edge function", () => {
    expect(index).toContain(`const CRON_MINUTES = new Set([${expected.join(", ")}]);`);
  });

  it("has no two consecutive minutes, which is what makes one sleep enough", () => {
    // waitOutCronMinute sleeps to the top of the next minute exactly once. A
    // run of two guarded minutes would need a loop, so this property is load
    // bearing rather than incidental, and a fifth cron job could break it.
    for (let i = 1; i < expected.length; i++) {
      expect(expected[i] - expected[i - 1]).toBeGreaterThan(1);
    }
    expect(expected).toHaveLength(9);
  });

  it("waits a guarded minute out instead of returning from inside it", () => {
    // The chain block asks about status, cells remaining, budget and hops —
    // never about whether this hop did any work. A hop that broke out of a
    // guarded minute therefore fired the next one immediately, and a
    // do-nothing hop costs about a second, so one guarded minute consumed the
    // entire hop budget in a burst of invocations aimed at exactly the minute
    // the guard exists to avoid.
    expect(index).toContain("const waitOutCronMinute = async (): Promise<boolean> => {");
    expect(index).toContain("if (wait > msLeftForWork()) return false;");
    expect(index).toContain("if (!(await waitOutCronMinute())) {");
    // and the hop budget is sized for one refused hop per guarded minute
    expect(index).toContain("const USABLE_MINUTES_PER_HOUR = 51;");
    expect(index).toContain("(MINUTES_PER_HOUR / USABLE_MINUTES_PER_HOUR)");
  });

  it("guards the free counting loop too", () => {
    const dryLoop = index.slice(
      index.indexOf("for (const row of population) {"),
      index.indexOf("const rowsCounted ="),
    );
    expect(dryLoop).toContain("await waitOutCronMinute()");
    expect(dryLoop).toContain("await spaceCalls();");
  });
});

describe("nothing about the token, the prompt or the body can be logged", () => {
  it("logs only a status, an id, a table name or a bounded slice", () => {
    const logs = index.match(/console\.(log|error|warn)\([\s\S]*?\);/g) ?? [];
    expect(logs.length).toBeGreaterThan(0);
    for (const call of logs) {
      expect(call).not.toContain("sweepToken");
      expect(call).not.toContain("expectedToken");
      expect(call).not.toContain("anthropicKey");
      expect(call).not.toContain("serviceRoleKey");
      expect(call).not.toContain("prepared.body");
      expect(call).not.toContain("countBody");
      expect(call).not.toContain("row.system");
      expect(call).not.toContain("row.user");
      expect(call).not.toContain("anthropicHeaders");
      expect(call).not.toContain("raw");
    }
  });

  it("reads the vault secret through a path that never logs a body", () => {
    // readRowsOrNull logs a 200-char slice of a failed response. The token RPC
    // is called through rest() directly, so the one helper that can print a
    // body never sees the secret.
    expect(index).toContain(
      'const tokenRes = await rest("rpc/track_outcomes_sweep_token", { method: "POST", body: "{}" });',
    );
    expect(index).not.toContain('readRowsOrNull("rpc/track_outcomes_sweep_token');
  });

  it("compares the token in constant time and refuses an empty expected value", () => {
    // A vault secret that failed to decrypt comes back as "", and a comparison
    // that let that through would authenticate every caller sending an empty
    // header.
    expect(index).toContain("expectedToken.length === 0 ||");
    expect(index).toContain("!constantTimeEqual(sweepToken, expectedToken)");
  });

  it("stores digests of the prompt and never the prompt", () => {
    expect(index).toContain("system_sha256: shapeFacts.systemSha,");
    expect(index).toContain("user_sha256: shapeFacts.userSha,");
    expect(index).not.toMatch(/system:\s*(row|cell\.row)\.system,\s*$/m);
  });
});

describe("there is one authorisation branch and it is the token", () => {
  it("has no admin-email array and no JWT branch", () => {
    // A fifth copy of ADMIN_EMAILS — the list already lives in analyze,
    // postmortem, econ-calendar and src/lib/admin.ts — is four too many
    // already, and this is the function that spends money.
    expect(indexCode).not.toContain("ADMIN_EMAILS");
    expect(indexCode).not.toContain("/auth/v1/user");
    expect(indexCode).not.toContain("SUPABASE_ANON_KEY");
  });

  it("uses exactly the house error vocabulary", () => {
    const strings = [...index.matchAll(/error: "([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(strings)).toEqual(
      new Set([
        "認証が必要です",
        "認証に失敗しました",
        "サーバー設定エラー",
        "サーバーエラーが発生しました",
        "リクエスト形式が不正です",
      ]),
    );
    // and no vocabulary from a function that has an admin branch
    expect(index).not.toContain("権限がありません");
  });

  it("ends every structured response in a version", () => {
    // The two flat 500s are the house's own shape (`{ ok, error }`, copied from
    // the sweep functions); everything this function says about a RUN carries
    // the version that produced it, so a row in noise_runs and the response
    // that wrote it can be matched afterwards.
    const returns = indexCode.match(/return json\(\{[\s\S]*?\}(, \d{3})?\);/g) ?? [];
    const structured = returns.filter((r) => r.includes("mode:"));
    expect(structured.length).toBeGreaterThan(5);
    for (const r of structured) {
      expect(r).toContain("version");
    }
    const flat = returns.filter((r) => !r.includes("mode:"));
    expect(flat.every((r) => /error: "(サーバー設定エラー|サーバーエラーが発生しました|認証(が必要です|に失敗しました))"/.test(r))).toBe(true);
  });
});

describe("a read that failed is not an empty table", () => {
  it("returns null for an unparseable 200 as well as for a non-2xx", () => {
    // This was the one `?? []` in the file, in effect: a 200 whose body would
    // not parse came back as [], and [] from `analyses` in report mode makes
    // every cell unstratifiable, which moves the preview rows into core,
    // enlarges the denominator and LOWERS the Wilson upper bound.
    expect(index).toContain('console.error("read unparseable:"');
    expect(index).toContain('console.error("patch unparseable:"');
    expect(index).toContain('console.error("insert unparseable:"');
    expect(index).not.toMatch(/Array\.isArray\(rows\) \? rows\.filter\(isRecord\) : \[\]/);
  });

  it("refuses to report a run whose cells could not all be stratified", () => {
    expect(index).toContain('refusal: "stratum_unknown_for_some_cells"');
  });
});

describe("the report gate keys on the frozen population, not on a mutable integer", () => {
  it("recomputes the expectation from the frozen id list", () => {
    expect(index).toContain("const expectedFromPopulation = frozenIds.length * reps;");
    expect(index).toContain("expectedCells: expectedFromPopulation,");
    expect(index).toContain('refusal: "expected_cells_disagrees_with_frozen_population"');
  });

  it("refuses a cell for a row the population does not contain", () => {
    expect(index).toContain('refusal: "cells_outside_frozen_population"');
  });

  it("proves the two replicates of a row sent the same request", () => {
    // The migration says of the two digests: "the bytes that went on the wire.
    // Two replicates of one row must match." Until this check nothing read
    // them. The bias has a direction — a later, more constrained build agrees
    // with itself more often and the pooled rate comes out LOW — which is the
    // one direction #65 cannot survive.
    expect(index).toContain('refusal: "replicates_of_a_row_sent_different_requests"');
    expect(index).toContain("cell.system_sha256,");
    expect(index).toContain("cell.user_sha256,");
    // and the cheap half: refuse to BUY a cell that disagrees with its sibling
    expect(index).toContain('error_slice: "request_disagrees_with_sibling_replicate"');
  });
});

describe("a partial run cannot read as a complete one", () => {
  it("marks done only when the cells are accounted for", () => {
    // `pending` excludes claimed cells, so a worker killed between the claim
    // and the finishing write left a run with an empty pending list that used
    // to be stamped 'done' — after which the documented repair silently did
    // nothing, because a resume returns early on any status but 'running'.
    const doneWrites = [...index.matchAll(/status: "done"/g)];
    expect(doneWrites.length).toBe(2);
    expect(index).toContain("if (totals.completed + totals.failed >= expectedCells) {");
    expect(index).toContain("errors.push(`unfinished_cells_block_done:${totals.unfinished}`);");
  });

  it("never re-claims an abandoned cell", () => {
    // A cell claimed and abandoned may have been paid for; re-running it would
    // bill twice for one replicate while the record showed one.
    expect(index).toContain("resolution=ignore-duplicates,return=representation");
    expect(index).not.toMatch(/status=eq\.claimed.*claimed_at/s);
  });

  it("writes every status change from 'running' conditionally", () => {
    // Unconditional, the budget abort would overwrite an operator's 'paused'.
    expect(index).toContain("`noise_runs?id=eq.${runId}&status=eq.running`,\n        { status: \"aborted\", abort_reason: reason },");
    expect(index).toContain("noise_runs?id=eq.${runId}&status=eq.running&chain_hops=eq.${hops}");
  });
});

describe("two workers cannot be on one run", () => {
  it("takes a lease before spending and hands it back before chaining", () => {
    expect(index).toContain("notes->>lease_until=lt.${encodeURIComponent(nowIso)}");
    expect(index).toContain('skipped = "locked";');
    expect(index).toContain("await releaseLease();");
  });

  it("does not report a handoff it did not make", () => {
    expect(index).toContain("errors.push(`chain_handoff_status:${handoff.status}`)");
    expect(index).toContain("} else {\n                chained = true;\n              }");
  });
});

describe("the cell floor is above the measured length of a call", () => {
  it("does not start a cell it cannot finish", () => {
    // MEASURED 2026-09-09 over all 48 joined rows, as
    // analyses.created_at - analysis_prompts.sent_at (an upper bound on model
    // time): min 39.1 s, p50 56.0 s, p90 66.1 s, max 71.8 s, 0 of 48 above
    // 80 s. The old floor of 25 s sat below the measured MINIMUM, so a cell
    // started near it bought a billed, aborted generation — and because a
    // finished cell is never re-claimed, that replicate was lost and its row
    // left the denominator. The rows lost that way are the slow ones.
    expect(index).toContain("const MIN_CELL_START_MS = 80_000;");
    expect(index).toContain("if (left < MIN_CELL_START_MS) break;");
    // and the hop budget is sized from the same constant, so raising one
    // cannot strand a run on the other
    expect(index).toContain("Math.floor((WALL_CLOCK_BUDGET_MS - WRITE_RESERVE_MS) / MIN_CELL_START_MS)");
  });

  it("keeps the wall clock inside the platform's, with a write reserve", () => {
    expect(index).toContain("const WALL_CLOCK_BUDGET_MS = 130_000;");
    expect(index).toContain("const WRITE_RESERVE_MS = 10_000;");
    expect(index).toContain("const LLM_TIMEOUT_MS = 100_000;");
    expect(index).toContain("const MIN_CALL_SPACING_MS = 2_000;");
  });

  it("reads the response body inside the try that catches the abort", () => {
    // AbortSignal.timeout aborts the response STREAM: headers can arrive and
    // the signal then fire during res.text(). Unguarded, that throw escaped
    // the cell loop into the outer catch, leaving the cell claimed forever,
    // its billed usage unwritten, and a chained run stopped with no reason.
    const call = index.slice(index.indexOf("const callModel = async"), index.indexOf("const nominalShape ="));
    const tryStart = call.indexOf("try {");
    const catchStart = call.indexOf("} catch (err) {", tryStart);
    expect(call.slice(tryStart, catchStart)).toContain("raw = await res.text();");
  });
});

describe("blast radius", () => {
  it("writes to its own two tables and nothing else", () => {
    const writes = [...indexCode.matchAll(/(?:patchRows|insertRows)\(\s*`?"?([a-z_]+)/g)].map((m) => m[1]);
    expect(new Set(writes)).toEqual(new Set(["noise_runs", "noise_cells"]));
  });

  it("never calls analyze and never touches quota", () => {
    expect(indexCode).not.toContain("/functions/v1/analyze");
    expect(indexCode).not.toContain("consume_analysis_quota");
    expect(indexCode).not.toContain("release_analysis_quota");
    expect(indexCode).not.toMatch(/(patchRows|insertRows)\([\s\S]{0,20}(analyses|lessons|rulebook)/);
  });

  it("only ever self-POSTs, and only to itself", () => {
    const posts = [...indexCode.matchAll(/\/functions\/v1\/[a-z-]+/g)].map((m) => m[0]);
    expect(new Set(posts)).toEqual(new Set(["/functions/v1/noise-floor"]));
  });

  it("reaches api.anthropic.com at exactly two endpoints, both below the token gate", () => {
    const endpoints = [...indexCode.matchAll(/https:\/\/api\.anthropic\.com[a-z0-9/_]*/g)].map((m) => m[0]);
    expect(new Set(endpoints)).toEqual(
      new Set([
        "https://api.anthropic.com/v1/messages",
        "https://api.anthropic.com/v1/messages/count_tokens",
      ]),
    );
    const gate = indexCode.indexOf('const sweepToken = req.headers.get("x-sweep-token");');
    expect(gate).toBeGreaterThan(0);
    for (const endpoint of endpoints) {
      expect(indexCode.indexOf(endpoint)).toBeGreaterThan(gate);
    }
  });
});

describe("no model identifier appears in a comment", () => {
  // The house rule: never a marketing name or a version in a comment, a doc, a
  // commit message or a PR body. An API model id as DATA in a request body, or
  // read from a database column, is fine — which is why this looks at comment
  // text only, and why index.ts reads the model from `row.model` rather than
  // naming one.
  const forbidden = [
    /claude[-\s]?[a-z]*[-\s]?\d/i,
    /\bopus\b/i,
    /\bsonnet\b/i,
    /\bhaiku\b/i,
    /\bgpt\b/i,
    /\bgemini\b/i,
  ];

  for (const [name, src] of [
    ["index.ts", index],
    ["shape.ts", shape],
    ["prompt-surgery.ts", surgery],
    ["metric.ts", metric],
  ] as const) {
    it(`holds for ${name}`, () => {
      const comments = commentsOf(src);
      expect(comments.length).toBeGreaterThan(500);
      for (const pattern of forbidden) {
        expect(comments).not.toMatch(pattern);
      }
    });
  }

  it("takes the model from the stored column rather than naming one", () => {
    expect(index).toContain("model: row.model");
    expect(index).toContain("outcome.responseModel !== cell.row.model");
  });
});
