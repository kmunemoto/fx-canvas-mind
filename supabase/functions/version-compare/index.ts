// version-compare — is the CANDIDATE rulebook better than the LIVE one?
//
// This is #65. It is built on top of #64 (supabase/functions/noise-floor), and
// almost everything expensive here is that function's, reused rather than
// rewritten: the replay request shape (shape.ts), the seam surgery that swaps a
// rulebook into a stored prompt (prompt-surgery.ts), the verdict extraction and
// the confidence intervals (metric.ts), and the runner's whole discipline —
// lease, wall clock, cron-minute guard, end-based call spacing, dry run,
// budgets. Read noise-floor/index.ts first; the comments there explain WHY each
// of those exists and they are cited here by name rather than restated.
//
// WHAT IS NEW HERE, AND IT IS ONLY TWO THINGS.
//
// (1) THE CANDIDATE IS FROZEN BEFORE IT IS MEASURED.
//     `public.rulebook.candidate` is rewritten by the postmortem sweep every
//     few hours (measured 2026-09-10: 4 rules, base_version 8, created
//     05:53:53Z, with 5 superseded generations behind it). A run that named
//     "the candidate" would measure a different object on its last hop than on
//     its first. So `action: "freeze"` copies one generation — and the live
//     book at the same instant — into public.rulebook_candidate_freezes, which
//     is append-only by trigger, and a run names a freeze id.
//
// (2) THERE ARE TWO STAGES AND THEY ANSWER DIFFERENT QUESTIONS.
//
//     STAGE A, 'materiality'. Replay each stored snapshot twice: once with the
//     frozen LIVE book spliced in, once with the frozen CANDIDATE book. Count
//     how often the two answers differ. NO OUTCOME IS READ, so no outcome can
//     leak. The result is compared against #64's same-version noise floor
//     (10/48, 20.83%, Wilson [11.73%, 34.26%]). This is a SCREENING TEST: it
//     says whether the change is big enough to be worth a forward evaluation.
//     IT IS NOT A PERFORMANCE CLAIM. A book that changed every answer for the
//     worse would score maximally material.
//
//     STAGE B, 'performance'. Score both arms against what the market did, and
//     run an exact McNemar on the discordant pairs. Admissible only on
//     snapshots created strictly AFTER the freeze — because the candidate was
//     written from lessons about the older ones. Measured 2026-09-10: of the 78
//     lessons in the table, 60 are about analyses that also have a stored
//     prompt, and `candidate->>'lessons_considered'` is 60. Scoring the
//     candidate on those rows would be scoring it on its own training set.
//     The filter is `created_at=gt.<frozen_at>` IN THE QUERY (see
//     readEligibleIds), it is repeated as a trigger in the migration, and
//     pairing.ts states it a third time as a pure function.
//
// WHAT IT SPENDS. Every /v1/messages call is billed against the same
// ANTHROPIC_API_KEY that a live user's analysis and the postmortem sweep run
// on, and on 2026-09-08 six consecutive calls on that key failed with a credit
// error in a way a user could see. All of noise-floor's controls are therefore
// here unchanged and as refusals rather than warnings: dry_run defaults to
// TRUE, a live run cannot exist without a completed dry run and two budgets
// sized from it, max_cells is capped server-side, spend is measured from
// `usage` on every response, and a 401/403/429 or a credit-balance 400 stops
// the run instead of being retried.
//
// Callers: an operator, by hand, from SQL. NEVER pg_cron. The token is read
// from the vault inside that SQL and its value is never written down here.

import {
  classifyCell,
  publishedProxy,
  wilson,
  type CellStatus,
  type RawAnswer,
} from "../noise-floor/metric.ts";
import {
  MAX_TOKENS,
  RESPONSE_SCHEMA,
  SHAPE_REFUSAL_PREFIX,
  buildReplayRequest,
  replayHeaders,
  replayShape,
  type ReplayBody,
  type RowClass,
} from "../noise-floor/shape.ts";
import {
  LOCALE,
  classifyRow,
  isRefusal,
  locateRulesBlock,
  spliceRulesBlock,
  type ClassifiedRow,
  type SurgeryLocale,
} from "../noise-floor/prompt-surgery.ts";
import {
  MAX_PROMPT_RULES,
  parseRules,
  promptCharBudget,
  renderLearnedRules,
  type Rule,
} from "../analyze/rules.ts";
import { PLAN_CONTRACT } from "../_shared/contract.ts";
import {
  DELTA,
  mcnemarExact,
  pairsStillNeeded,
  requiredPairs,
} from "./mcnemar.ts";
import {
  eligibleForStage,
  pairVerdicts,
  screenMateriality,
  smallestMaterialCount,
  tallyMateriality,
  tallyPerformance,
  truthFor,
  type Arm,
  type ScoredTruth,
  type Stage,
  type Verdict,
  type VerdictPair,
} from "./pairing.ts";

const FUNCTION_VERSION = "version-compare-v1-2026-09-10T18:00:00Z";

// #64's measured same-version disagreement rate and its Wilson 95% interval,
// from docs/NOISE_FLOOR_PREREGISTRATION.md §12.2 (10 of 48 rows,
// noise_runs/noise_cells, arm search_free, N=2).
//
// COPIED AS NUMBERS, NOT RE-DERIVED FROM THE TABLES, and the reason is that
// this is the pre-registered comparator: recomputing it from noise_cells on
// every report would let a later noise run — a different arm, a wider
// population, a partial run — silently move the bar this function is measured
// against. The bar was set on 2026-09-09 and it is written down. If a better
// floor is measured, somebody edits these three lines and says so.
const NOISE_FLOOR_K = 10;
const NOISE_FLOOR_N = 48;
const NOISE_FLOOR_RATE = NOISE_FLOOR_K / NOISE_FLOOR_N;

// Every one of the following is noise-floor's, for noise-floor's stated
// reasons. They are not re-argued here; see that file.
const WALL_CLOCK_BUDGET_MS = 130_000;
const WRITE_RESERVE_MS = 10_000;
const LLM_TIMEOUT_MS = 100_000;
// 80 s, from the measured fetch-to-write span over the stored corpus (min 39 s,
// p90 66 s, max 72 s). A cell started with less than this buys a timeout.
const MIN_CELL_START_MS = 80_000;
// FROM THE END OF THE PREVIOUS CALL. This is the constant that exists because a
// previous harness took an edge worker for forty minutes and a real user's
// analysis got no worker at all. Nothing here may reintroduce that.
const MIN_CALL_SPACING_MS = 20_000;
const DEFAULT_MAX_CELLS = 2;
const MAX_CELLS_CAP = 4;
const POPULATION_READ_LIMIT = 400;
const CELL_READ_LIMIT = 2000;
const ID_CHUNK = 50;
const CHAIN_HOP_SLACK = 2;
const USABLE_MINUTES_PER_HOUR = 51;
const MINUTES_PER_HOUR = 60;
const CRON_EXIT_MARGIN_MS = 1_500;
const LEASE_MS = 165_000;
const LEASE_EPOCH = "1970-01-01T00:00:00.000Z";
const BUDGET_SLACK = 2;
const CHAIN_HANDOFF_MS = 5_000;
const PAUSE_ATTEMPTS = 5;
// A run may not name more rows than this. Twice the 200-odd rows the corpus
// could plausibly hold before somebody re-thinks the design, and a tripwire
// rather than a policy.
const MAX_EXPLICIT_IDS = 200;

// The UTC minutes this function refuses to START a cell in, and refuses to be
// still running in: the union of the three pg_cron jobs that fire an edge
// function (track-outcomes 3,18,33,48; postmortem 8,23,38,53; econ-calendar
// 13). postmortem matters most — it shares this exact API key. No two of these
// are consecutive, which is what lets one sleep clear a guarded minute.
const CRON_MINUTES = new Set([3, 8, 13, 18, 23, 33, 38, 48, 53]);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-sweep-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const numberOrNull = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const intOrNull = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) ? value : null;

const strOrNull = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const constantTimeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (value: unknown): value is string =>
  typeof value === "string" && UUID_RE.test(value);

const sha256Hex = async (text: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const addUsage = (current: number | null, value: number | null): number | null =>
  value === null ? current : (current ?? 0) + value;

const slice200 = (value: unknown): string =>
  (value instanceof Error ? value.message : String(value ?? "")).slice(0, 200);

// Both duplicated from analyze/index.ts, for the reason metric.ts and shape.ts
// give for their own duplications, and additionally because this measurement
// depends on reading the answer EXACTLY as production reads it: a replay that
// parsed differently would report a parse difference as a rulebook difference.
const extractAnthropicText = (value: unknown): string => {
  if (!isRecord(value)) return "";
  const content = value.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const textParts: string[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      textParts.push(block);
      continue;
    }
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
      textParts.push(block.text);
    }
  }
  return textParts.join("").trim();
};

const parseAnalysisJson = (finalText: string): unknown => {
  const tagMatch = finalText.match(/<json>([\s\S]*?)<\/json>/);
  const source = tagMatch ? tagMatch[1] : finalText;
  const cleaned = source.replace(/```json\n?|```\n?/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const first = cleaned.indexOf("{");
    const last = cleaned.lastIndexOf("}");
    if (first !== -1 && last > first) {
      try {
        return JSON.parse(cleaned.slice(first, last + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
};

// ---------------------------------------------------------------------------
// Rendering a rulebook into a block that can be spliced
// ---------------------------------------------------------------------------
//
// BOTH ARMS ARE RE-RENDERED. The live arm does NOT keep the block the stored
// prompt carried, and that is the single most consequential design decision in
// this file, so it is argued here rather than left to be discovered.
//
// The stored blocks were all rendered RANKED (`fitNote` present in 48/48,
// measured for #64), which means each rule line carries a per-rule marker —
// 「・今の相場に該当」/「・今は別局面」/「・今との照合不可」 — that
// analyze/situation.ts computed by comparing THAT MINUTE's indicators against
// the footprints of the plans the rule came from. Those markers cannot be
// reproduced for a candidate rule: the candidate's rules cite different
// lessons, and re-computing any marker today would compare against today's
// market rather than the snapshot's.
//
// So there were three options and only one of them keeps the pairing:
//
//   * splice the candidate in beside the stored ranked live block — the two
//     arms would then differ in the rule list AND in whether the rules carry
//     situation markers at all. Two changes, one measurement, nothing
//     separable. Rejected.
//   * re-render the candidate ranked with every marker forced to
//     「照合不可」 — the candidate's rules would all say "cannot compare"
//     while the live rules said "fits now". A systematic difference in
//     confidence-bearing text between the arms, which is precisely a
//     confound. Rejected.
//   * re-render BOTH arms unranked, from the same renderer, with the same
//     contract and the same budget. The only thing that differs between the
//     two members of a pair is then the rule list. Taken.
//
// THE COST IS REAL AND IS NOT HIDDEN: neither arm is byte-identical to what
// production sent. Stage A therefore measures "does swapping the rule list
// change the answer, under an unranked rendering", not "would production have
// answered differently". #64's 20.83% floor was measured on the stored bytes,
// so comparing against it assumes the unranked rendering does not itself change
// how often the analyst disagrees with itself. THAT ASSUMPTION IS UNVERIFIED.
// Measuring it would mean a second noise-floor run against unranked prompts,
// which costs another 96 billable calls. docs/VERSION_COMPARISON.md says so in
// the owner's language.
//
// The renderer is production's own — analyze/rules.ts — imported, not copied.
// It is Deno-free by declaration and imports only situation.ts, which imports
// nothing; postmortem/index.ts already imports `parseRules` from it, so a
// cross-function relative import is the house pattern and not an innovation.
const renderBlock = (rules: Rule[], locale: SurgeryLocale): string =>
  renderLearnedRules(
    rules,
    locale,
    // The same contract filter production applies. A rule the analyst cannot
    // carry out under the contract in force is not shown to it in production
    // and must not be shown to it here, or the candidate would be measured on
    // instructions it would never actually receive.
    PLAN_CONTRACT,
    MAX_PROMPT_RULES,
    promptCharBudget(locale),
    // fits = null: unranked. See the argument above.
    null,
  );

interface PreparedArm {
  body: ReplayBody;
  systemSha: string;
  userSha: string;
  rulesSha: string;
  schemaEra: string;
  schemaInPrompt: boolean;
  shape: string;
  effort: string;
}

interface PopulationRow {
  analysisId: string;
  system: string;
  user: string;
  model: string;
  mode: string;
  preview: boolean;
  createdAt: string;
}

interface PendingCell {
  row: PopulationRow;
  arm: Arm;
}

interface CallOutcome {
  httpStatus: number;
  parsed: unknown;
  stopReason: string | null;
  stopDetails: unknown;
  requestId: string | null;
  responseModel: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  webSearchRequests: number | null;
  errorMessage: string;
  abortReason: string | null;
  pauseExhausted: boolean;
  pauseContinuations: number;
  transportError: string | null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const startedAt = Date.now();
  const elapsed = () => Date.now() - startedAt;
  const msLeftForWork = () => WALL_CLOCK_BUDGET_MS - elapsed() - WRITE_RESERVE_MS;

  const errors: string[] = [];

  // Copied from noise-floor including the window semantics: the question is not
  // "is this minute guarded" but "does any minute this cell could still be
  // running in belong to a cron job", because a cell that starts at :07:47 is
  // still holding the worker when the postmortem sweep fires at :08:01.
  const windowIsClear = (fromMs: number): boolean => {
    const firstMinute = Math.floor(fromMs / 60_000);
    const lastMinute = Math.floor((fromMs + MIN_CELL_START_MS) / 60_000);
    for (let m = firstMinute; m <= lastMinute; m++) {
      if (CRON_MINUTES.has(new Date(m * 60_000).getUTCMinutes())) return false;
    }
    return true;
  };
  // WAITS the minute out rather than returning from inside it. Returning is
  // what turned a guarded minute into a burst of do-nothing chain hops in #64.
  const waitOutCronMinute = async (): Promise<boolean> => {
    for (let attempt = 0; attempt < 4; attempt++) {
      if (windowIsClear(Date.now())) return true;
      const wait = 60_000 - (Date.now() % 60_000) + CRON_EXIT_MARGIN_MS;
      if (wait > msLeftForWork()) return false;
      await sleep(wait);
    }
    return windowIsClear(Date.now());
  };

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!supabaseUrl || !serviceRoleKey || !anthropicKey) {
      return json({ ok: false, error: "サーバー設定エラー" }, 500);
    }

    const serviceHeaders = {
      Authorization: `Bearer ${serviceRoleKey}`,
      apikey: serviceRoleKey,
      "Content-Type": "application/json",
    };
    const rest = (path: string, init: RequestInit = {}) =>
      fetch(`${supabaseUrl}/rest/v1/${path}`, {
        ...init,
        headers: { ...serviceHeaders, ...(init.headers ?? {}) },
      });

    // null means the READ ITSELF failed, which is a different fact from
    // "nothing is there" and produces the opposite correct action. A 200 whose
    // body will not parse is a failed read, not an empty table. There is no
    // `?? []` in this file.
    const readRowsOrNull = async (path: string): Promise<JsonRecord[] | null> => {
      const res = await rest(path);
      if (!res.ok) {
        console.error("read failed:", path.split("?")[0], res.status, slice200(await res.text().catch(() => "")));
        return null;
      }
      const rows = await res.json().catch(() => null);
      if (!Array.isArray(rows)) {
        console.error("read unparseable:", path.split("?")[0], res.status);
        return null;
      }
      return rows.filter(isRecord);
    };

    const patchRows = async (path: string, body: JsonRecord): Promise<JsonRecord[] | null> => {
      const res = await rest(path, {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        console.error("patch failed:", path.split("?")[0], res.status, slice200(await res.text().catch(() => "")));
        return null;
      }
      const rows = await res.json().catch(() => null);
      if (!Array.isArray(rows)) {
        console.error("patch unparseable:", path.split("?")[0], res.status);
        return null;
      }
      return rows.filter(isRecord);
    };

    const insertRows = async (
      path: string,
      body: JsonRecord,
      prefer = "return=representation",
    ): Promise<JsonRecord[] | null> => {
      const res = await rest(path, {
        method: "POST",
        headers: { Prefer: prefer },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        console.error("insert failed:", path.split("?")[0], res.status, slice200(await res.text().catch(() => "")));
        return null;
      }
      const rows = await res.json().catch(() => null);
      if (!Array.isArray(rows)) {
        console.error("insert unparseable:", path.split("?")[0], res.status);
        return null;
      }
      return rows.filter(isRecord);
    };

    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();

    // Parsed before the auth block (house pattern). It grants nothing: the
    // token is still checked below and no field is acted on until it has been.
    const bodyRaw = await req.json().catch(() => null);
    const body: JsonRecord = isRecord(bodyRaw) ? bodyRaw : {};

    // ---- who is asking ---------------------------------------------------
    // ONE BRANCH, exactly as noise-floor. No admin-JWT path, for noise-floor's
    // two stated reasons: a fifth copy of ADMIN_EMAILS is four too many, and
    // this function spends money on a shared key so the caller it is designed
    // for is a deliberate statement at a psql prompt, not a fetch from a
    // logged-in tab. Nothing about the token is logged, returned or stored.
    const sweepToken = req.headers.get("x-sweep-token");
    if (!sweepToken) {
      return json({ ok: false, error: "認証が必要です" }, 401);
    }
    const tokenRes = await rest("rpc/track_outcomes_sweep_token", { method: "POST", body: "{}" });
    const expectedToken = tokenRes.ok ? await tokenRes.json().catch(() => null) : null;
    if (
      typeof expectedToken !== "string" ||
      expectedToken.length === 0 ||
      !constantTimeEqual(sweepToken, expectedToken)
    ) {
      return json({ ok: false, error: "認証に失敗しました" }, 401);
    }

    // ---- the request contract --------------------------------------------
    const refuse = (detail: string) =>
      json({
        ok: false,
        error: "リクエスト形式が不正です",
        mode: "refused",
        errors: [detail],
        elapsedMs: elapsed(),
        version: FUNCTION_VERSION,
      }, 400);

    // DEFAULTS TO TRUE. A body that forgets the field, misspells it, or is not
    // JSON at all lands on the free path. Only an explicit `false` can reach
    // /v1/messages.
    const dryRun = body.dry_run !== false;
    const action = body.action;
    const reportRunId = body.report_run_id;
    const runIdIn = body.run_id;
    const dryRunIdIn = body.dry_run_id;
    const freezeIdIn = body.freeze_id;
    const chain = body.chain === true;

    if (reportRunId !== undefined && !isUuid(reportRunId)) return refuse("report_run_id must be a uuid");
    if (runIdIn !== undefined && !isUuid(runIdIn)) return refuse("run_id must be a uuid");
    if (dryRunIdIn !== undefined && !isUuid(dryRunIdIn)) return refuse("dry_run_id must be a uuid");
    if (freezeIdIn !== undefined && !isUuid(freezeIdIn)) return refuse("freeze_id must be a uuid");

    const stageIn = body.stage === undefined ? "materiality" : body.stage;
    if (stageIn !== "materiality" && stageIn !== "performance") {
      return refuse("stage must be 'materiality' or 'performance'");
    }
    const stage: Stage = stageIn;

    const maxCellsIn = body.max_cells === undefined ? DEFAULT_MAX_CELLS : numberOrNull(body.max_cells);
    if (maxCellsIn === null || !Number.isInteger(maxCellsIn) || maxCellsIn < 1 || maxCellsIn > MAX_CELLS_CAP) {
      return refuse(`max_cells must be an integer between 1 and ${MAX_CELLS_CAP}`);
    }
    const maxCells = maxCellsIn;

    // run_id resumes a run that carries its own stage and freeze on the header.
    // Accepting either beside it would let the two disagree and the loser would
    // be invisible in the record.
    if (runIdIn !== undefined && (body.stage !== undefined || body.freeze_id !== undefined)) {
      return refuse("run_id is mutually exclusive with stage and freeze_id");
    }

    // =====================================================================
    // Shared helpers over the three tables
    // =====================================================================

    const readFreeze = async (id: string): Promise<JsonRecord | null | "read_failed"> => {
      const rows = await readRowsOrNull(`rulebook_candidate_freezes?id=eq.${id}&select=*`);
      if (rows === null) return "read_failed";
      return rows[0] ?? null;
    };

    const readRun = async (id: string): Promise<JsonRecord | null | "read_failed"> => {
      const rows = await readRowsOrNull(`version_compare_runs?id=eq.${id}&select=*`);
      if (rows === null) return "read_failed";
      return rows[0] ?? null;
    };

    // =====================================================================
    // FREEZE MODE — copies the candidate, never calls the model
    // =====================================================================
    if (action === "freeze") {
      const rulebookRows = await readRowsOrNull("rulebook?select=version,rules,candidate&limit=2");
      if (rulebookRows === null) {
        errors.push("read_failed:rulebook");
        return json({ ok: false, mode: "freeze", errors, elapsedMs: elapsed(), version: FUNCTION_VERSION }, 500);
      }
      // The table holds one row by construction. Two would mean somebody added
      // a second book and every "the live rules" in this file would have become
      // ambiguous without anything saying so.
      if (rulebookRows.length !== 1) {
        return refuse(`public.rulebook holds ${rulebookRows.length} rows; this function assumes exactly 1`);
      }
      const book = rulebookRows[0];
      const liveVersion = intOrNull(book.version);
      if (liveVersion === null) return refuse("public.rulebook carries no integer version");

      const candidate = book.candidate;
      if (!isRecord(candidate)) return refuse("public.rulebook.candidate is absent or not an object");

      // parseRules is the analyzer's own defensive reader. Using it rather than
      // trusting the jsonb means a malformed rule is dropped the same way
      // production drops it, so the frozen book is the book the analyst would
      // actually have been shown.
      const liveRules = parseRules(book.rules);
      const candidateRules = parseRules(candidate.rules);
      if (liveRules.length === 0) return refuse("the live rulebook parsed to zero rules");
      if (candidateRules.length === 0) return refuse("the candidate parsed to zero rules");

      // THE ARMS MUST DIFFER, checked on the RENDERED BLOCKS and not only on
      // the arrays. A reordering, a support count that moved, a rule held back
      // by the contract filter — any of those changes the array without
      // changing a single character the analyst would read, and a run whose two
      // arms send identical system prompts is a run that spends the whole
      // budget measuring the noise floor again. Both locales are checked,
      // because the corpus carries both.
      const renderedJa = { live: renderBlock(liveRules, "ja"), candidate: renderBlock(candidateRules, "ja") };
      const renderedEn = { live: renderBlock(liveRules, "en"), candidate: renderBlock(candidateRules, "en") };
      if (renderedJa.live.length === 0 || renderedJa.candidate.length === 0) {
        return refuse(`under contract ${PLAN_CONTRACT} one of the two books renders to an empty ja block`);
      }
      // THE CONDITION IS ON JA ALONE, because the two digests this freeze is
      // IDENTIFIED BY are the ja digests, and `freeze_arms_differ` in the
      // migration is a check on those. A pair whose ja blocks collapse to the
      // same text but whose en blocks differ — reachable, because renderBlock
      // applies MAX_PROMPT_RULES and a per-locale character budget, so two
      // different rule arrays can render to one ja string — would otherwise
      // pass an `&&` here and then come back from Postgres as a 500 on a
      // constraint, for a condition this function has a clear refusal for. The
      // en case is reported so the operator is not left guessing which locale
      // collapsed.
      if (renderedJa.live === renderedJa.candidate) {
        return refuse(
          renderedEn.live === renderedEn.candidate
            ? "the candidate and the live book render to identical prompt blocks in both locales; " +
              "there is nothing here to measure"
            : "the candidate and the live book render to an identical ja prompt block (the en blocks differ); " +
              "a freeze is identified by its ja digests, so this pair cannot be stored as two arms",
        );
      }

      const [candidateSha, liveSha] = await Promise.all([
        sha256Hex(renderedJa.candidate),
        sha256Hex(renderedJa.live),
      ]);

      // An existing freeze of the same pair is HANDED BACK rather than
      // duplicated. Two ids for one object would let two runs report on
      // "different" freezes that are the same thing, and the operator would
      // have no way to tell from the ids that they were comparable.
      const existing = await readRowsOrNull(
        `rulebook_candidate_freezes?candidate_sha256=eq.${candidateSha}&live_sha256=eq.${liveSha}&select=*&limit=1`,
      );
      if (existing === null) {
        errors.push("read_failed:rulebook_candidate_freezes");
        return json({ ok: false, mode: "freeze", errors, elapsedMs: elapsed(), version: FUNCTION_VERSION }, 500);
      }
      if (existing.length > 0) {
        return json({
          ok: true,
          mode: "freeze",
          created: false,
          freeze_id: existing[0].id,
          frozen_at: existing[0].frozen_at,
          candidate_rule_count: existing[0].candidate_rule_count,
          live_rule_count: existing[0].live_rule_count,
          candidate_sha256: candidateSha,
          live_sha256: liveSha,
          note: "an identical freeze already exists; reusing it rather than creating a second id for one object",
          errors,
          elapsedMs: elapsed(),
          version: FUNCTION_VERSION,
        });
      }

      const inserted = await insertRows("rulebook_candidate_freezes", {
        frozen_at: nowIso,
        candidate_rules: candidate.rules ?? [],
        candidate_base_version: intOrNull(candidate.base_version) ?? liveVersion,
        candidate_created_at: strOrNull(candidate.created_at),
        candidate_lessons_considered: intOrNull(candidate.lessons_considered),
        live_rules: book.rules ?? [],
        live_version: liveVersion,
        candidate_sha256: candidateSha,
        live_sha256: liveSha,
        candidate_rule_count: candidateRules.length,
        live_rule_count: liveRules.length,
        version: FUNCTION_VERSION,
        notes: {
          // Recorded because it is the evidence for the whole two-stage design:
          // this is the postmortem's RECENT_LESSONS cap, and the lessons under
          // it are about the analyses a replay would draw from.
          lessons_considered: intOrNull(candidate.lessons_considered),
          superseded_generations: Array.isArray(candidate.superseded) ? candidate.superseded.length : null,
          contract: PLAN_CONTRACT,
          rendered_block_chars: {
            ja: { live: renderedJa.live.length, candidate: renderedJa.candidate.length },
            en: { live: renderedEn.live.length, candidate: renderedEn.candidate.length },
          },
        },
      });
      if (inserted === null || !isUuid(inserted[0]?.id)) {
        errors.push("insert_failed:rulebook_candidate_freezes");
        return json({ ok: false, mode: "freeze", errors, elapsedMs: elapsed(), version: FUNCTION_VERSION }, 500);
      }

      console.log("version-compare freeze", {
        freeze_id: inserted[0].id,
        live_version: liveVersion,
        candidate_rules: candidateRules.length,
        live_rules: liveRules.length,
      });

      return json({
        ok: true,
        mode: "freeze",
        created: true,
        freeze_id: inserted[0].id,
        frozen_at: nowIso,
        live_version: liveVersion,
        candidate_base_version: intOrNull(candidate.base_version),
        candidate_rule_count: candidateRules.length,
        live_rule_count: liveRules.length,
        candidate_sha256: candidateSha,
        live_sha256: liveSha,
        errors,
        elapsedMs: elapsed(),
        version: FUNCTION_VERSION,
      });
    }

    // =====================================================================
    // Reading a population
    // =====================================================================

    const readPopulationByIds = async (
      ids: readonly string[],
      cutIso: string,
    ): Promise<PopulationRow[] | null> => {
      const prompts = new Map<string, JsonRecord>();
      for (let i = 0; i < ids.length; i += ID_CHUNK) {
        const chunk = ids.slice(i, i + ID_CHUNK);
        const rows = await readRowsOrNull(
          `analysis_prompts?analysis_id=in.(${chunk.join(",")})` +
            `&created_at=lte.${encodeURIComponent(cutIso)}` +
            `&select=analysis_id,system,user,model,created_at`,
        );
        if (rows === null) {
          errors.push("read_failed:analysis_prompts");
          return null;
        }
        for (const row of rows) {
          if (typeof row.analysis_id === "string") prompts.set(row.analysis_id.toLowerCase(), row);
        }
      }

      const meta = new Map<string, JsonRecord>();
      for (let i = 0; i < ids.length; i += ID_CHUNK) {
        const chunk = ids.slice(i, i + ID_CHUNK);
        const rows = await readRowsOrNull(`analyses?id=in.(${chunk.join(",")})&select=id,mode,preview`);
        if (rows === null) {
          errors.push("read_failed:analyses");
          return null;
        }
        for (const row of rows) {
          if (typeof row.id === "string") meta.set(row.id.toLowerCase(), row);
        }
      }

      const out: PopulationRow[] = [];
      for (const id of ids) {
        const prompt = prompts.get(id);
        const analysis = meta.get(id);
        // Every one of these is a refusal and not a skip: the population was
        // declared before the first billable call, and a row that has become
        // unreadable is a reason to stop rather than a reason to measure fewer
        // rows and report the rate over the declared number.
        if (!prompt) {
          errors.push(`population_row_missing:${id}`);
          return null;
        }
        if (!analysis) {
          errors.push(`population_analysis_missing:${id}`);
          return null;
        }
        const system = strOrNull(prompt.system);
        const user = strOrNull(prompt["user"]);
        const model = strOrNull(prompt.model);
        if (system === null || user === null || model === null) {
          errors.push(`population_row_incomplete:${id}`);
          return null;
        }
        out.push({
          analysisId: id,
          system,
          user,
          model,
          mode: typeof analysis.mode === "string" ? analysis.mode : "",
          preview: analysis.preview === true,
          createdAt: typeof prompt.created_at === "string" ? prompt.created_at : "",
        });
      }
      return out;
    };

    // THE TIME-SERIES SPLIT, IN THE QUERY.
    //
    // For stage 'performance' the lower bound goes on the wire as
    // `created_at=gt.<frozen_at>`. It is not applied afterwards in TypeScript,
    // and that is the requirement rather than a preference: a filter applied
    // after the read is a filter a future refactor can drop while every test
    // still passes, and the row it would let through is a row the candidate was
    // fitted on. pairing.ts `eligibleForStage` states the same rule as a pure
    // function and the migration's trigger states it a third time; if the three
    // ever disagree, the run refuses rather than picking one.
    const readEligibleIds = async (
      runStage: Stage,
      cutIso: string,
      freezeFrozenAt: string,
    ): Promise<string[] | null> => {
      const lowerBound = runStage === "performance"
        ? `&created_at=gt.${encodeURIComponent(freezeFrozenAt)}`
        : "";
      const rows = await readRowsOrNull(
        `analysis_prompts?created_at=lte.${encodeURIComponent(cutIso)}${lowerBound}` +
          `&select=analysis_id,created_at&order=created_at.asc,analysis_id.asc&limit=${POPULATION_READ_LIMIT}`,
      );
      if (rows === null) {
        errors.push("read_failed:analysis_prompts");
        return null;
      }
      // A read that came back exactly at the limit may have been truncated, and
      // a truncated population is a moved denominator. Refuse rather than
      // proceed on a page.
      if (rows.length >= POPULATION_READ_LIMIT) {
        errors.push(`population_read_truncated_at:${POPULATION_READ_LIMIT}`);
        return null;
      }
      const ids: string[] = [];
      for (const row of rows) {
        if (!isUuid(row.analysis_id)) continue;
        // The query already did this. Asking the pure rule as well is how a
        // disagreement between the two becomes a refusal instead of a silent
        // choice — and it is cheap, because it is arithmetic on strings the
        // read already returned.
        const verdict = eligibleForStage({
          stage: runStage,
          snapshotCreatedAt: typeof row.created_at === "string" ? row.created_at : "",
          freezeFrozenAt,
          populationFrozenAt: cutIso,
        });
        if (!verdict.ok) {
          errors.push(`eligibility_disagreement:${row.analysis_id}:${verdict.reason}`);
          return null;
        }
        ids.push(row.analysis_id.toLowerCase());
      }
      return ids;
    };

    // =====================================================================
    // Building the two arms of one row
    // =====================================================================

    const anthropicHeaders = replayHeaders(anthropicKey);
    const requiredKeys = RESPONSE_SCHEMA.required as readonly string[];

    // SEEDED FROM THE HANDOFF, because otherwise the twenty seconds are a
    // promise this function keeps only within one invocation.
    //
    // A chained run does about one billable cell per hop —
    // floor((130s - 10s) / 80s) = 1 — so nearly every billable call IS an
    // invocation's first call, and a per-invocation local starting at zero
    // makes the spacing a no-op for exactly the calls that matter. The real gap
    // then becomes the hop latency: writes, reconcile, lease release, handoff,
    // and the child's own PostgREST round-trips, which is a few seconds, not
    // twenty, repeated once per cell on the key a live user's analysis draws
    // from. So the parent tells the child when its last call ENDED and the
    // child honours it.
    //
    // Validated rather than trusted: a value in the future, or absurdly old, is
    // ignored. Nothing here can be used to LENGTHEN the gap beyond one spacing
    // interval, and a caller who wanted no spacing could simply not chain.
    const handoffLastCallEnd = numberOrNull(body.last_call_ended_at);
    let lastCallEndedAt = handoffLastCallEnd !== null &&
        handoffLastCallEnd <= nowMs &&
        handoffLastCallEnd > nowMs - 600_000
      ? handoffLastCallEnd
      : 0;
    // Every outbound call to api.anthropic.com goes through this, on the free
    // path as well as the billable one: free is not the same as harmless when
    // the key is shared with a live user's analysis.
    const spaceCalls = async () => {
      const since = Date.now() - lastCallEndedAt;
      if (lastCallEndedAt > 0 && since < MIN_CALL_SPACING_MS) {
        await sleep(MIN_CALL_SPACING_MS - since);
      }
    };
    // Called on every path out of a call — success, error or throw — because a
    // call that failed still occupied the worker.
    const markCallEnded = () => {
      lastCallEndedAt = Date.now();
    };

    // The two blocks, rendered once per invocation from the frozen books and
    // then reused. Rendering them per cell would let a redeploy of rules.ts
    // between two cells of one pair change one arm and not the other, which is
    // exactly the disagreement the sibling check below refuses to pay for —
    // better not to create it.
    interface FrozenBooks {
      live: Rule[];
      candidate: Rule[];
      blocks: Record<SurgeryLocale, Record<Arm, string>>;
      shas: Record<SurgeryLocale, Record<Arm, string>>;
    }

    const loadFrozenBooks = async (freeze: JsonRecord): Promise<FrozenBooks | string> => {
      const live = parseRules(freeze.live_rules);
      const candidate = parseRules(freeze.candidate_rules);
      if (live.length === 0) return "freeze_live_rules_unreadable";
      if (candidate.length === 0) return "freeze_candidate_rules_unreadable";
      const blocks = {
        ja: { live: renderBlock(live, "ja"), candidate: renderBlock(candidate, "ja") },
        en: { live: renderBlock(live, "en"), candidate: renderBlock(candidate, "en") },
      };
      const shas = {
        ja: { live: await sha256Hex(blocks.ja.live), candidate: await sha256Hex(blocks.ja.candidate) },
        en: { live: await sha256Hex(blocks.en.live), candidate: await sha256Hex(blocks.en.candidate) },
      };
      return { live, candidate, blocks, shas };
    };

    // One row, one arm, all the way to a request body.
    //
    // The user turn is the stored one, byte for byte, on BOTH arms — the two
    // members of a pair must ask the same question about the same market — and
    // the system prompt is the stored one with the learned-rules block replaced
    // through spliceRulesBlock, which asserts that nothing before the seam
    // moved.
    const prepareArm = (
      row: PopulationRow,
      arm: Arm,
      books: FrozenBooks,
      classified: ClassifiedRow,
    ): Promise<PreparedArm | string> => {
      const locale = classified.locale;
      const block = books.blocks[locale][arm];
      if (block.length === 0) return Promise.resolve(`empty_block:${arm}:${locale}`);

      const spliced = spliceRulesBlock(row.system, block, locale);
      if (isRefusal(spliced)) return Promise.resolve(`splice_refused:${spliced.code}`);

      const rowClass: RowClass = classified.promptClass === "technical" ? "technical" : "search_derived";

      let bodyBuilt: ReplayBody;
      let shape: string;
      try {
        // The primary arm's shape, always. `search_free` drops `tools` and
        // changes nothing else, which is #64's measured arm and the only one
        // whose disagreement rate the 20.83% floor describes. Sending web
        // search here would add web drift to the rulebook difference and the
        // two could not be separated afterwards.
        shape = replayShape({ arm: "search_free", rowClass });
        bodyBuilt = buildReplayRequest({
          arm: "search_free",
          rowClass,
          model: row.model,
          system: spliced.system,
          user: row.user,
        });
      } catch (err) {
        const message = slice200(err);
        return Promise.resolve(message.startsWith(SHAPE_REFUSAL_PREFIX) ? message : `shape_error:${message}`);
      }
      const built = bodyBuilt;
      const builtShape = shape;

      // Digests from the BUILT BODY, which is the thing that goes on the wire.
      const sentUser = built.messages[0]?.content ?? row.user;
      return Promise.all([sha256Hex(built.system), sha256Hex(sentUser)]).then(([systemSha, userSha]) => ({
        body: built,
        systemSha,
        userSha,
        rulesSha: books.shas[locale][arm],
        schemaEra: classified.schemaEra,
        schemaInPrompt: row.user.includes(LOCALE[locale].schemaMarker),
        shape: builtShape,
        effort: built.output_config.effort,
      }));
    };

    // =====================================================================
    // Run totals, recomputed from the cells rather than incremented
    // =====================================================================

    interface RunTotals {
      completed: number;
      failed: number;
      unfinished: number;
      spentInput: number;
      spentOutput: number;
      unmeasured: number;
      boundInput: number;
      boundOutput: number;
      cells: JsonRecord[];
    }

    let unmeasuredCellInputBound = 0;

    const readCells = async (runId: string, select: string): Promise<JsonRecord[] | null> => {
      const rows = await readRowsOrNull(
        `version_compare_cells?run_id=eq.${runId}&select=${select}&order=analysis_id.asc,arm.asc&limit=${CELL_READ_LIMIT}`,
      );
      if (rows === null) {
        errors.push("read_failed:version_compare_cells");
        return null;
      }
      if (rows.length >= CELL_READ_LIMIT) {
        errors.push(`cell_read_truncated_at:${CELL_READ_LIMIT}`);
        return null;
      }
      return rows;
    };

    // A recomputation cannot double-count: it is a count of rows that exist.
    // The counters are what stands between a half-finished run and a published
    // rate, and an increment applied twice — by a stale claim, by a chained hop
    // that re-commits the batch before it — would open the reporting gate while
    // cells were still missing.
    const tallyCells = (cells: JsonRecord[]): RunTotals => {
      let completed = 0;
      let failed = 0;
      let unfinished = 0;
      let spentInput = 0;
      let spentOutput = 0;
      let unmeasured = 0;
      let boundInput = 0;
      let boundOutput = 0;
      for (const cell of cells) {
        const status = typeof cell.status === "string" ? cell.status : "";
        if (status === "ok") completed += 1;
        else if (status === "claimed") unfinished += 1;
        else failed += 1;
        // Spend that could not be measured is not zero. The columns keep the
        // measurement; the CONTROL acts on measured + bound, or a run whose
        // calls all time out passes every budget check while billing the whole
        // population.
        const measuredInput = numberOrNull(cell.input_tokens);
        const measuredOutput = numberOrNull(cell.output_tokens);
        if (status !== "claimed" && measuredInput === null && measuredOutput === null) {
          unmeasured += 1;
          boundInput += unmeasuredCellInputBound;
          boundOutput += MAX_TOKENS;
        }
        spentInput += (numberOrNull(cell.input_tokens) ?? 0) + (numberOrNull(cell.cache_read_input_tokens) ?? 0);
        spentOutput += numberOrNull(cell.output_tokens) ?? 0;
      }
      return { completed, failed, unfinished, spentInput, spentOutput, unmeasured, boundInput, boundOutput, cells };
    };

    const CELL_SELECT_FOR_RUN =
      "analysis_id,arm,status,input_tokens,output_tokens,cache_read_input_tokens," +
      "system_sha256,user_sha256,rules_sha256,effort,max_tokens,tools_present,schema_in_prompt,shape";

    const reconcile = async (runId: string): Promise<RunTotals | null> => {
      const cells = await readCells(runId, CELL_SELECT_FOR_RUN);
      if (cells === null) return null;
      const totals = tallyCells(cells);
      const patched = await patchRows(`version_compare_runs?id=eq.${runId}`, {
        completed_cells: totals.completed,
        failed_cells: totals.failed,
        spent_input_tokens: totals.spentInput,
        spent_output_tokens: totals.spentOutput,
      });
      if (patched === null) {
        errors.push("patch_failed:version_compare_runs_totals");
        return null;
      }
      return totals;
    };

    // =====================================================================
    // REPORT MODE — reads, never calls the model
    // =====================================================================
    if (isUuid(reportRunId)) {
      const run = await readRun(reportRunId);
      if (run === "read_failed") {
        errors.push("read_failed:version_compare_runs");
        return json({ ok: false, mode: "report", errors, elapsedMs: elapsed(), version: FUNCTION_VERSION }, 500);
      }
      if (run === null) return refuse("report_run_id names no run");

      const runStage = run.stage === "performance" ? "performance" : "materiality";
      const reportNotes = isRecord(run.notes) ? run.notes : {};
      unmeasuredCellInputBound = numberOrNull(reportNotes.unmeasured_cell_input_bound) ?? 0;

      // THE FROZEN POPULATION, not the counter column. expected_cells is a
      // mutable integer; the id list written at creation is the population, it
      // is digested, and it is what the budgets were sized against. A
      // disagreement between the two is a refusal, not a choice.
      const reportPopulation = isRecord(reportNotes.population) ? reportNotes.population : {};
      const frozenIds = Array.isArray(reportPopulation.ids)
        ? reportPopulation.ids.filter(isUuid).map((id) => id.toLowerCase())
        : [];
      if (frozenIds.length === 0) {
        return refuse("the run header carries no frozen population; it cannot be reported");
      }
      const expectedFromPopulation = frozenIds.length * 2;
      const expectedColumn = numberOrNull(run.expected_cells) ?? 0;
      if (expectedColumn !== expectedFromPopulation) {
        errors.push(`expected_cells_disagrees:column=${expectedColumn}:population=${expectedFromPopulation}`);
        return json({
          ok: false,
          mode: "report",
          run_id: reportRunId,
          report: { emitted: false, refusal: "expected_cells_disagrees_with_frozen_population" },
          errors,
          elapsedMs: elapsed(),
          version: FUNCTION_VERSION,
        }, 409);
      }

      const cells = await readCells(
        reportRunId,
        "analysis_id,arm,status,raw_signal,raw_confidence,input_tokens,output_tokens," +
          "cache_read_input_tokens,system_sha256,user_sha256,rules_sha256,effort,max_tokens," +
          "tools_present,schema_in_prompt,shape",
      );
      if (cells === null) {
        return json({ ok: false, mode: "report", errors, elapsedMs: elapsed(), version: FUNCTION_VERSION }, 500);
      }
      const totals = tallyCells(cells);

      const frozenSet = new Set(frozenIds);
      const strayIds = [...new Set(
        cells.map((c) => (typeof c.analysis_id === "string" ? c.analysis_id.toLowerCase() : "")),
      )].filter((id) => !frozenSet.has(id));
      if (strayIds.length > 0) {
        errors.push(`cells_outside_frozen_population:${strayIds.length}`);
        return json({
          ok: false,
          mode: "report",
          run_id: reportRunId,
          report: { emitted: false, refusal: "cells_outside_frozen_population" },
          errors,
          elapsedMs: elapsed(),
          version: FUNCTION_VERSION,
        }, 409);
      }

      // THE GATE. A partial run may not be reported as a complete one. The
      // rows still missing from a partial run are the ones that needed a retry,
      // which are the unstable ones, so a rate emitted early is biased toward
      // agreement — the direction that cancels a forward evaluation that should
      // have happened.
      if (totals.completed + totals.failed < expectedFromPopulation) {
        return json({
          ok: true,
          mode: "report",
          run_id: reportRunId,
          stage: runStage,
          report: {
            emitted: false,
            refusal: "run_incomplete",
            expected_cells: expectedFromPopulation,
            completed_cells: totals.completed,
            failed_cells: totals.failed,
            unfinished_cells: totals.unfinished,
          },
          errors,
          elapsedMs: elapsed(),
          version: FUNCTION_VERSION,
        });
      }

      // ---- assemble the pairs --------------------------------------------
      interface ArmCell {
        verdict: Verdict | null;
        status: string;
        facts: string;
        rulesSha: string;
        userSha: string;
      }
      const byRow = new Map<string, Partial<Record<Arm, ArmCell>>>();
      for (const cell of cells) {
        const analysisId = typeof cell.analysis_id === "string" ? cell.analysis_id.toLowerCase() : "";
        const arm = cell.arm === "candidate" ? "candidate" : cell.arm === "live" ? "live" : null;
        if (analysisId.length === 0 || arm === null) continue;
        const status = typeof cell.status === "string" ? cell.status : "";
        // The projection is metric.ts's `publishedProxy`, the same function
        // #64's floor was computed with. A second copy of the enum here could
        // drift from it, and then the floor would stop gating this comparison.
        const raw: RawAnswer = {
          signal: strOrNull(cell.raw_signal),
          confidence: intOrNull(cell.raw_confidence),
          stop: null,
          tp1: null,
          fundamental_score: null,
          missingRequiredKeys: [],
        };
        const entry = byRow.get(analysisId) ?? {};
        entry[arm] = {
          verdict: status === "ok" ? publishedProxy(raw) : null,
          status,
          facts: [cell.effort, cell.max_tokens, cell.tools_present, cell.schema_in_prompt, cell.shape].join("|"),
          rulesSha: typeof cell.rules_sha256 === "string" ? cell.rules_sha256 : "",
          userSha: typeof cell.user_sha256 === "string" ? cell.user_sha256 : "",
        };
        byRow.set(analysisId, entry);
      }

      // THE PAIRING PROOF, performed rather than asserted.
      //
      // The two arms of a row must have asked the same question (identical
      // user digest, identical request facts) and must have been given
      // DIFFERENT books (different rules digest). A pair that fails either test
      // is excluded and counted, because pooling it would report a request
      // difference, or no difference at all, as a rulebook effect.
      const badPairs: string[] = [];
      const pairs: VerdictPair[] = [];
      let bothArmsPresent = 0;
      let unprojectable = 0;
      for (const id of frozenIds) {
        const entry = byRow.get(id);
        const live = entry?.live;
        const candidate = entry?.candidate;
        if (!live || !candidate) continue;
        bothArmsPresent += 1;
        if (live.userSha !== candidate.userSha || live.facts !== candidate.facts) {
          badPairs.push(`${id}:request_differs`);
          continue;
        }
        if (live.rulesSha === candidate.rulesSha) {
          badPairs.push(`${id}:same_book_both_arms`);
          continue;
        }
        const pair = pairVerdicts({ analysisId: id, live: live.verdict, candidate: candidate.verdict });
        if (pair === null) {
          unprojectable += 1;
          continue;
        }
        pairs.push(pair);
      }
      if (badPairs.length > 0) errors.push(`unpaired_rows:${badPairs.length}`);

      const materiality = tallyMateriality(pairs);
      const floorCi = wilson(NOISE_FLOOR_K, NOISE_FLOOR_N);

      // Emitting nothing is the correct answer to zero pairs. The rate of no
      // pairs is NaN, not zero, and zero is the number a reader would take for
      // "the two books agreed".
      if (materiality.pairs === 0) {
        return json({
          ok: true,
          mode: "report",
          run_id: reportRunId,
          stage: runStage,
          report: { emitted: false, refusal: "no_projectable_pairs", rows_with_both_arms: bothArmsPresent, unprojectable },
          errors,
          elapsedMs: elapsed(),
          version: FUNCTION_VERSION,
        });
      }

      const observedCi = wilson(materiality.disagreements, materiality.pairs);
      const screen = screenMateriality({
        observedLo: observedCi.lo,
        observedHi: observedCi.hi,
        floorLo: floorCi.lo,
        floorHi: floorCi.hi,
      });

      const stageA = {
        // SAID IN THE PAYLOAD, not only in the docs. Anyone reading this JSON
        // is one copy-paste away from calling it a performance result.
        what_this_is:
          "a screening test on how often the two books disagree; it is NOT evidence that either book is better",
        pairs: materiality.pairs,
        disagreements: materiality.disagreements,
        rate: materiality.rate,
        wilson95: observedCi,
        noise_floor: {
          k: NOISE_FLOOR_K,
          n: NOISE_FLOOR_N,
          rate: NOISE_FLOOR_RATE,
          wilson95: floorCi,
          source: "docs/NOISE_FLOOR_PREREGISTRATION.md 12.2 (arm search_free, N=2)",
        },
        verdict: screen,
        // WHAT THIS SCREEN CAN SEE AT THIS n, stated rather than left to be
        // derived. `material` needs this run's lower bound to clear the floor's
        // upper bound of 34.26%, and that bound is high because the floor was
        // measured on 48 rows. At 78 pairs the observed disagreement has to
        // reach about 45% before the screen can fire at all — so
        // `indistinguishable` frequently means "a change this size is invisible
        // to this screen", not "the candidate does nothing".
        smallest_material_disagreement: smallestMaterialCount({
          pairs: materiality.pairs,
          floorHi: floorCi.hi,
          wilsonLo: (k, n) => wilson(k, n).lo,
        }),
        rows_with_both_arms: bothArmsPresent,
        rows_unprojectable: unprojectable,
        rows_excluded_from_pairing: badPairs.length,
      };

      // ---- stage B, and only stage B, looks at outcomes -------------------
      let stageB: JsonRecord | null = null;
      if (runStage === "performance") {
        const idsWithPairs = pairs.map((p) => p.analysisId);

        // =================================================================
        // THE SPLIT, RE-PROVED HERE, ON THE PATH THAT EMITS THE NUMBER.
        // =================================================================
        //
        // The three locks the brief asked for — the PostgREST filter in
        // readEligibleIds, the pure rule in pairing.ts, the trigger in the
        // migration — all sit on the CREATION path. None of them is consulted
        // again here, and this is the only place an outcome is ever read.
        //
        // What decides which rows get SCORED is `notes.population.ids`, and
        // `notes` is deliberately absent from the trigger's column list
        // (`before insert or update of stage, freeze_id, eligible_after,
        // population_frozen_at`), so a header whose id list was widened by a
        // later feature, or written by hand, reaches this block with the
        // trigger silent and every existing test passing. The rows it would
        // admit are exactly the rows the candidate was fitted on, and the
        // payload below would label them "the candidate had not read a lesson
        // about any of them".
        //
        // So the created_at of every row about to be scored is read again and
        // checked again, against the LATER of the run's declared bound and the
        // freeze's own instant — the later of the two, so that this check
        // stands even in a database where the trigger was never applied.
        // Anything that fails, or that cannot be established, refuses the whole
        // report. A stage B number is worth nothing if it might contain one
        // fitted row, and there is no partial version of this that is worth
        // emitting.
        const declaredBound = strOrNull(run.eligible_after);
        if (declaredBound === null) {
          return json({
            ok: false,
            mode: "report",
            run_id: reportRunId,
            stage: runStage,
            report: { emitted: false, refusal: "performance_run_without_eligible_after" },
            errors,
            elapsedMs: elapsed(),
            version: FUNCTION_VERSION,
          }, 409);
        }
        const freezeRows = await readRowsOrNull(
          `rulebook_candidate_freezes?id=eq.${run.freeze_id}&select=frozen_at&limit=1`,
        );
        if (freezeRows === null || freezeRows.length === 0) {
          errors.push("read_failed:rulebook_candidate_freezes");
          return json({ ok: false, mode: "report", errors, elapsedMs: elapsed(), version: FUNCTION_VERSION }, 500);
        }
        const freezeInstant = strOrNull(freezeRows[0].frozen_at);
        if (freezeInstant === null) {
          errors.push("freeze_carries_no_frozen_at");
          return json({ ok: false, mode: "report", errors, elapsedMs: elapsed(), version: FUNCTION_VERSION }, 500);
        }
        const boundMs = Math.max(Date.parse(declaredBound), Date.parse(freezeInstant));
        if (!Number.isFinite(boundMs)) {
          errors.push("eligibility_bound_unreadable");
          return json({ ok: false, mode: "report", errors, elapsedMs: elapsed(), version: FUNCTION_VERSION }, 500);
        }
        const effectiveBound = new Date(boundMs).toISOString();
        const populationCut = strOrNull(run.population_frozen_at) ?? nowIso;

        // OVER THE WHOLE DECLARED POPULATION, not merely the rows that
        // happened to pair. A header that names one pre-freeze row is a corrupt
        // header whether or not that particular row produced two usable arms,
        // and "it failed its candidate arm, so it did not leak" is luck rather
        // than a property. frozenIds is a superset of the scored rows, so this
        // is strictly the safer set to check.
        const stamps = new Map<string, string>();
        for (let i = 0; i < frozenIds.length; i += ID_CHUNK) {
          const chunk = frozenIds.slice(i, i + ID_CHUNK);
          if (chunk.length === 0) break;
          const rows = await readRowsOrNull(
            `analysis_prompts?analysis_id=in.(${chunk.join(",")})&select=analysis_id,created_at`,
          );
          if (rows === null) {
            errors.push("read_failed:analysis_prompts_split_recheck");
            return json({ ok: false, mode: "report", errors, elapsedMs: elapsed(), version: FUNCTION_VERSION }, 500);
          }
          for (const row of rows) {
            if (!isUuid(row.analysis_id)) continue;
            const createdAt = strOrNull(row.created_at);
            if (createdAt === null) continue;
            stamps.set(row.analysis_id.toLowerCase(), createdAt);
          }
        }
        // A row with no readable stamp is NOT given the benefit of the doubt.
        // "The record does not say when this snapshot was taken" and "this
        // snapshot is after the freeze" are different sentences.
        const ineligible: string[] = [];
        for (const id of frozenIds) {
          const createdAt = stamps.get(id);
          if (createdAt === undefined) {
            ineligible.push(`${id}:no_prompt_row`);
            continue;
          }
          const verdict = eligibleForStage({
            stage: "performance",
            snapshotCreatedAt: createdAt,
            freezeFrozenAt: effectiveBound,
            populationFrozenAt: populationCut,
          });
          if (!verdict.ok) ineligible.push(`${id}:${verdict.reason}`);
        }
        if (ineligible.length > 0) {
          errors.push(`stage_b_population_not_forward_only:${ineligible.length}`);
          console.error("version-compare refused a stage B report", {
            run_id: reportRunId,
            ineligible: ineligible.length,
            first: ineligible.slice(0, 5),
          });
          return json({
            ok: false,
            mode: "report",
            run_id: reportRunId,
            stage: runStage,
            report: {
              emitted: false,
              refusal: "stage_b_population_not_forward_only",
              detail:
                "at least one row about to be scored is not provably after the freeze; " +
                "scoring it would score the candidate on its own training set",
              ineligible_rows: ineligible.length,
              eligibility_bound: effectiveBound,
            },
            errors,
            elapsedMs: elapsed(),
            version: FUNCTION_VERSION,
          }, 409);
        }

        const outcomes = new Map<string, { outcome: string | null; waitVerdict: string | null }>();
        for (let i = 0; i < idsWithPairs.length; i += ID_CHUNK) {
          const chunk = idsWithPairs.slice(i, i + ID_CHUNK);
          if (chunk.length === 0) break;
          const rows = await readRowsOrNull(
            `analyses?id=in.(${chunk.join(",")})&select=id,outcome,wait_check`,
          );
          if (rows === null) {
            errors.push("read_failed:analyses_outcomes");
            return json({ ok: false, mode: "report", errors, elapsedMs: elapsed(), version: FUNCTION_VERSION }, 500);
          }
          for (const row of rows) {
            if (typeof row.id !== "string") continue;
            const waitCheck = isRecord(row.wait_check) ? row.wait_check : null;
            outcomes.set(row.id.toLowerCase(), {
              outcome: strOrNull(row.outcome),
              waitVerdict: waitCheck === null ? null : strOrNull(waitCheck.verdict),
            });
          }
        }

        const scored: Array<{ pair: VerdictPair; truth: ScoredTruth | null }> = pairs.map((pair) => {
          const row = outcomes.get(pair.analysisId);
          return {
            pair,
            truth: row === undefined ? null : truthFor({ outcome: row.outcome, waitVerdict: row.waitVerdict }),
          };
        });
        const performance = tallyPerformance(scored);
        const test = mcnemarExact(performance.b, performance.c);
        const need = requiredPairs(NOISE_FLOOR_RATE, DELTA);
        const reached = performance.pairs >= need.pairs;
        const freshConclusive = reached && !test.underpowered && test.significant;

        // WHERE THE DISCORDANT PAIRS CAME FROM, tested inside each source as
        // well as pooled.
        //
        // `outcome` exists only on rows production traded and `wait_check` only
        // on rows it waited, so the truth source is correlated with the live
        // arm's own verdict, and a candidate that shifts decisions one way will
        // draw its discordant pairs from one source. Pooled b and c cannot be
        // decomposed after the fact, so the decomposition is emitted. These two
        // tests are a SENSITIVITY CHECK, not two more chances to find a result:
        // the pre-registered test is the pooled one, and a reader who quotes
        // whichever of the three came out smallest has run three tests and
        // reported one.
        const bySource = {
          what_this_is:
            "a sensitivity decomposition, NOT a second and third test; the pre-registered test is the pooled one above",
          outcome: {
            pairs: performance.fromOutcome,
            b: performance.bFromOutcome,
            c: performance.cFromOutcome,
            mcnemar: mcnemarExact(performance.bFromOutcome, performance.cFromOutcome),
          },
          wait_check: {
            pairs: performance.fromWaitCheck,
            b: performance.bFromWaitCheck,
            c: performance.cFromWaitCheck,
            mcnemar: mcnemarExact(performance.bFromWaitCheck, performance.cFromWaitCheck),
          },
        };

        // ---- THE STOPPING RULE -------------------------------------------
        //
        // Report mode is free, reads only, and re-runnable, and the number of
        // SCORED pairs grows over time on a fixed population as outcomes settle
        // and wait checks are written. Without a rule an operator can call this
        // on day 3 (72 pairs, not conclusive), day 5 (78 pairs, p = 0.09) and
        // day 8 (84 pairs, p = 0.04) and publish the third — optional stopping
        // with no alpha spending, under which the nominal 5% is not 5%. #64
        // froze its parameters at the first billable call (§11 of its
        // pre-registration); this is the same discipline on the only degree of
        // freedom #65 has left, which is WHEN TO LOOK.
        //
        // The rule: looks below the pre-registered n are not tests and were
        // already incapable of being conclusive. THE FIRST LOOK AT WHICH THE
        // POPULATION REACHES n IS THE TEST, and it is sealed into the run
        // header. Every later look still reports its fresh numbers — they are
        // useful for watching the corpus grow — but they are marked post hoc
        // and they cannot become `conclusive`.
        //
        // Sealing is a conditional PATCH so two concurrent reports cannot seal
        // two different results; the loser re-reads and adopts the winner's.
        // If the seal cannot be written, nothing is quotable: a result that
        // was not recorded is a result that could be re-rolled.
        //
        // The seal is its OWN COLUMN, not a key inside `notes`. A PATCH of
        // `notes` rewrites the whole jsonb document, so sealing through it
        // would race the run lease that also lives there; and a column can be
        // made write-once by a trigger, which a key inside a document cannot.
        let seal = isRecord(run.stage_b_seal) ? run.stage_b_seal : null;
        let sealedNow = false;
        if (reached && seal === null) {
          const candidateSeal: JsonRecord = {
            sealed_at: nowIso,
            scored_pairs: performance.pairs,
            b: performance.b,
            c: performance.c,
            p_value: test.pValue,
            direction: test.direction,
            significant: test.significant,
            underpowered: test.underpowered,
            required_pairs: need.pairs,
            conclusive: freshConclusive,
            truth_from_settled_outcome: performance.fromOutcome,
            truth_from_wait_check: performance.fromWaitCheck,
          };
          const sealPatch = await patchRows(
            `version_compare_runs?id=eq.${reportRunId}&stage_b_seal=is.null`,
            { stage_b_seal: candidateSeal },
          );
          if (sealPatch === null) {
            errors.push("patch_failed:version_compare_runs_stage_b_seal");
          } else if (sealPatch.length > 0) {
            seal = candidateSeal;
            sealedNow = true;
          } else {
            // Somebody else sealed between the read and the write. Theirs is
            // the test; re-read it rather than reporting this invocation's.
            const reread = await readRun(reportRunId);
            seal = reread !== null && reread !== "read_failed" && isRecord(reread.stage_b_seal)
              ? reread.stage_b_seal
              : null;
            if (seal === null) errors.push("stage_b_seal_lost_between_write_and_read");
          }
        }

        stageB = {
          what_this_is:
            "an exact McNemar over snapshots created after the freeze; the candidate had not read a lesson about any of them",
          scored_pairs: performance.pairs,
          unscorable_pairs: performance.unscorable,
          both_right: performance.bothRight,
          both_wrong: performance.bothWrong,
          b_live_right_candidate_wrong: performance.b,
          c_live_wrong_candidate_right: performance.c,
          truth_from_settled_outcome: performance.fromOutcome,
          truth_from_wait_check: performance.fromWaitCheck,
          mcnemar: test,
          by_truth_source: bySource,
          design: {
            delta: need.delta,
            noise_rate_used: need.noiseRate,
            required_pairs: need.pairs,
            still_needed: pairsStillNeeded(need.pairs, performance.pairs),
            // WHAT THE DESIGN CAN AND CANNOT SEE, in the payload rather than
            // only in the doc. psi is the share of discordant pairs the
            // candidate must win for this n to have 80% power. A candidate that
            // is genuinely better by less than that will read `significant:
            // false`, and that is NOT evidence the candidate is no better.
            powered_for_discordant_share: need.psi,
            not_significant_means:
              "not better by the pre-registered margin at this n; it does NOT mean not better",
          },
          stopping_rule: {
            what_this_is:
              "the first look at which the population reached the pre-registered n is the test; later looks are post hoc",
            reached_required_pairs: reached,
            sealed: seal !== null,
            sealed_this_call: sealedNow,
            seal,
            post_hoc_recount: seal !== null && !sealedNow,
          },
          // The one sentence that decides whether any of the numbers above may
          // be quoted at all. It comes from the SEAL, never from this
          // invocation's recount, so that re-running the report cannot turn a
          // non-result into a result.
          conclusive: seal === null ? false : seal.conclusive === true,
        };
      }

      console.log("version-compare report", {
        run_id: reportRunId,
        stage: runStage,
        pairs: materiality.pairs,
        disagreements: materiality.disagreements,
        screen,
      });

      return json({
        ok: true,
        mode: "report",
        run_id: reportRunId,
        stage: runStage,
        freeze_id: run.freeze_id,
        eligible_after: run.eligible_after,
        report: {
          emitted: true,
          stage_a_materiality: stageA,
          stage_b_performance: stageB,
        },
        completed_cells: totals.completed,
        failed_cells: totals.failed,
        unfinished_cells: totals.unfinished,
        spent_input_tokens: totals.spentInput,
        spent_output_tokens: totals.spentOutput,
        errors,
        elapsedMs: elapsed(),
        version: FUNCTION_VERSION,
      });
    }

    // =====================================================================
    // DRY RUN — count_tokens only, never /v1/messages
    // =====================================================================
    if (dryRun) {
      let runId: string;
      let cutIso: string;
      let ids: string[];
      let notes: JsonRecord;
      let dryStage: Stage = stage;
      let freezeId: string;

      if (isUuid(runIdIn)) {
        const existing = await readRun(runIdIn);
        if (existing === "read_failed") {
          errors.push("read_failed:version_compare_runs");
          return json({ ok: false, mode: "dry", errors, elapsedMs: elapsed(), version: FUNCTION_VERSION }, 500);
        }
        if (existing === null) return refuse("run_id names no run");
        if (existing.status !== "dry") return refuse("run_id names a run that is not a dry run");
        runId = runIdIn;
        cutIso = typeof existing.population_frozen_at === "string" ? existing.population_frozen_at : "";
        notes = isRecord(existing.notes) ? existing.notes : {};
        const population = isRecord(notes.population) ? notes.population : {};
        ids = Array.isArray(population.ids) ? population.ids.filter(isUuid) : [];
        dryStage = existing.stage === "performance" ? "performance" : "materiality";
        if (!isUuid(existing.freeze_id)) return refuse("the run header carries no freeze_id");
        freezeId = existing.freeze_id;
        if (ids.length === 0 || cutIso.length === 0) return refuse("the run header carries no frozen population");
      } else {
        if (!isUuid(freezeIdIn)) return refuse("freeze_id is required; take one with action:'freeze' first");
        freezeId = freezeIdIn;
        // POPULATION FREEZE. Taken here, once, written on the header. The
        // table grew from 48 rows on 2026-09-09 to 78 on 2026-09-10, so the
        // denominator moves by roughly half its own size per day.
        cutIso = nowIso;
        const freeze = await readFreeze(freezeId);
        if (freeze === "read_failed") {
          errors.push("read_failed:rulebook_candidate_freezes");
          return json({ ok: false, mode: "dry", errors, elapsedMs: elapsed(), version: FUNCTION_VERSION }, 500);
        }
        if (freeze === null) return refuse("freeze_id names no freeze");
        const frozenAt = typeof freeze.frozen_at === "string" ? freeze.frozen_at : "";
        if (frozenAt.length === 0) return refuse("the freeze carries no frozen_at");

        const eligible = await readEligibleIds(dryStage, cutIso, frozenAt);
        if (eligible === null) {
          return json({ ok: false, mode: "dry", errors, elapsedMs: elapsed(), version: FUNCTION_VERSION }, 500);
        }
        if (eligible.length === 0) {
          // The expected answer on the day a freeze is taken, for stage B, and
          // it is a refusal rather than an empty run: stage B cannot conclude
          // anything today by construction, and creating a run that will sit at
          // zero cells would look like an experiment in progress.
          return refuse(
            dryStage === "performance"
              ? `no snapshot has been written since the freeze (${frozenAt}); stage 'performance' is forward-only ` +
                "and has nothing to replay yet"
              : "the frozen population is empty",
          );
        }
        if (eligible.length > MAX_EXPLICIT_IDS) {
          return refuse(`the eligible population is ${eligible.length} rows, above the ${MAX_EXPLICIT_IDS} tripwire`);
        }
        ids = eligible;

        const inserted = await insertRows("version_compare_runs", {
          freeze_id: freezeId,
          stage: dryStage,
          population_frozen_at: cutIso,
          eligible_after: dryStage === "performance" ? frozenAt : null,
          expected_cells: ids.length * 2,
          // A dry run may not spend, and the columns say what THIS run is
          // allowed to spend rather than what some later run might be.
          budget_input_tokens: 0,
          budget_output_tokens: 0,
          status: "dry",
          chain: false,
          chain_hops: 0,
          max_chain_hops: 0,
          version: FUNCTION_VERSION,
          notes: {
            population: { count: ids.length, sha256: await sha256Hex(ids.join(",")), ids, frozen_at: cutIso },
            max_cells: maxCells,
            eligible_after: dryStage === "performance" ? frozenAt : null,
            dry: { complete: false, rows_total: ids.length, per_row: [] },
          },
        });
        if (inserted === null || !isUuid(inserted[0]?.id)) {
          errors.push("insert_failed:version_compare_runs");
          return json({ ok: false, mode: "dry", errors, elapsedMs: elapsed(), version: FUNCTION_VERSION }, 500);
        }
        runId = inserted[0].id as string;
        notes = isRecord(inserted[0].notes) ? (inserted[0].notes as JsonRecord) : {};
      }

      const freeze = await readFreeze(freezeId);
      if (freeze === "read_failed" || freeze === null) {
        errors.push("read_failed:rulebook_candidate_freezes");
        return json({ ok: false, mode: "dry", run_id: runId, errors, elapsedMs: elapsed(), version: FUNCTION_VERSION }, 500);
      }
      const books = await loadFrozenBooks(freeze);
      if (typeof books === "string") return refuse(books);

      const population = await readPopulationByIds(ids, cutIso);
      if (population === null) {
        return json({ ok: false, mode: "dry", run_id: runId, errors, elapsedMs: elapsed(), version: FUNCTION_VERSION }, 500);
      }

      const dryNotes = isRecord(notes.dry) ? notes.dry : {};
      // Keyed `${analysisId}#${arm}`. Unlike #64 the two cells of a row are NOT
      // the same bytes — that is the whole point of the experiment — so each
      // arm is counted separately and the per-cell figure is not a
      // multiplication.
      const perCell = new Map<string, number>();
      if (Array.isArray(dryNotes.per_row)) {
        for (const entry of dryNotes.per_row) {
          if (isRecord(entry) && typeof entry.key === "string") {
            const tokens = numberOrNull(entry.input_tokens);
            if (tokens !== null) perCell.set(entry.key, tokens);
          }
        }
      }

      let drySkipped: string | null = null;
      let dryAborted: string | null = null;
      outer: for (const row of population) {
        const classified = classifyRow({ user: row.user, system: row.system, mode: row.mode });
        if (isRefusal(classified)) {
          errors.push(`row_refused:${classified.code}:${row.analysisId}`);
          continue;
        }
        if (classified.promptClass === "already_fallback") {
          errors.push(`row_refused:already_fallback:${row.analysisId}`);
          continue;
        }
        for (const arm of ["live", "candidate"] as const) {
          const key = `${row.analysisId}#${arm}`;
          if (perCell.has(key)) continue;
          if (msLeftForWork() < 5_000) break outer;
          // The same three controls the live path has. count_tokens is free,
          // but the KEY is shared and a burst of rejections against a
          // rate-limited key lands on the same limit a user's analysis draws
          // from.
          if (!(await waitOutCronMinute())) {
            drySkipped = "cron_minute";
            break outer;
          }
          const prepared = await prepareArm(row, arm, books, classified);
          if (typeof prepared === "string") {
            errors.push(`${prepared}:${row.analysisId}`);
            continue;
          }
          const countBody: JsonRecord = { ...prepared.body };
          // The body that will ACTUALLY be sent, minus the one field
          // count_tokens does not take. output_config stays: dropping a field
          // to make the endpoint happy produces a number for a request nobody
          // is going to make.
          delete countBody.max_tokens;
          try {
            await spaceCalls();
            const res = await fetch("https://api.anthropic.com/v1/messages/count_tokens", {
              method: "POST",
              headers: anthropicHeaders,
              body: JSON.stringify(countBody),
              signal: AbortSignal.timeout(Math.max(5_000, Math.min(30_000, msLeftForWork()))),
            });
            const parsed = await res.json().catch(() => null);
            markCallEnded();
            if (!res.ok) {
              const message = isRecord(parsed) && isRecord(parsed.error) ? slice200(parsed.error.message) : "";
              console.error("count_tokens failed:", res.status, res.headers.get("request-id") ?? "", message);
              errors.push(`count_tokens:${res.status}:${message}`);
              if (res.status === 401 || res.status === 403 || res.status === 429 || res.status >= 500) {
                dryAborted = `count_tokens_http_${res.status}`;
                break outer;
              }
              continue;
            }
            const counted = isRecord(parsed) ? numberOrNull(parsed.input_tokens) : null;
            if (counted === null) {
              errors.push(`count_tokens_unreadable:${key}`);
              continue;
            }
            perCell.set(key, counted);
          } catch (err) {
            markCallEnded();
            errors.push(`count_tokens_failed:${slice200(err)}`);
          }
        }
      }

      const expectedCellCount = population.length * 2;
      const cellsCounted = perCell.size;
      const complete = cellsCounted === expectedCellCount;
      let measuredInputTokens = 0;
      let largestCell = 0;
      for (const value of perCell.values()) {
        measuredInputTokens += value;
        if (value > largestCell) largestCell = value;
      }
      // A BOUND, and labelled one everywhere it is written. count_tokens counts
      // INPUT only; output is billed for whatever the model produces up to
      // max_tokens. An estimate reported as a measurement is how a cost note
      // becomes a surprise.
      const boundOutputTokens = MAX_TOKENS * expectedCellCount;

      const patched = await patchRows(`version_compare_runs?id=eq.${runId}`, {
        notes: {
          ...notes,
          unmeasured_cell_input_bound: largestCell,
          dry: {
            complete,
            rows_total: population.length,
            cells_total: expectedCellCount,
            cells_counted: cellsCounted,
            measured_input_tokens: measuredInputTokens,
            bound_output_tokens: boundOutputTokens,
            largest_cell_input_tokens: largestCell,
            per_row: [...perCell.entries()].map(([key, input_tokens]) => ({ key, input_tokens })),
          },
        },
      });
      if (patched === null) errors.push("patch_failed:version_compare_runs_notes");
      if (dryAborted !== null) errors.push(dryAborted);

      console.log("version-compare dry run", {
        run_id: runId,
        stage: dryStage,
        cells_counted: cellsCounted,
        complete,
        skipped: drySkipped ?? "",
        errors: errors.length,
      });

      return json({
        ok: complete && errors.length === 0,
        mode: "dry",
        run_id: runId,
        freeze_id: freezeId,
        stage: dryStage,
        expected_cells: expectedCellCount,
        cells_counted: cellsCounted,
        rows_total: population.length,
        measured_input_tokens: measuredInputTokens,
        bound_output_tokens: boundOutputTokens,
        largest_cell_input_tokens: largestCell,
        status: "dry",
        abort_reason: dryAborted,
        skipped: drySkipped,
        errors,
        elapsedMs: elapsed(),
        version: FUNCTION_VERSION,
      });
    }

    // =====================================================================
    // LIVE RUN — the only path that can reach /v1/messages
    // =====================================================================

    let run: JsonRecord;

    if (isUuid(runIdIn)) {
      const existing = await readRun(runIdIn);
      if (existing === "read_failed") {
        errors.push("read_failed:version_compare_runs");
        return json({ ok: false, mode: "run", errors, elapsedMs: elapsed(), version: FUNCTION_VERSION }, 500);
      }
      if (existing === null) return refuse("run_id names no run");
      if (existing.status === "dry") return refuse("run_id names a dry run; create a live run with dry_run_id");
      run = existing;
    } else {
      // THERE IS NO RUN WITHOUT A DRY RUN FIRST. The dry run is free, it is the
      // only thing that produces a measured input-token figure, and the two
      // budgets are meant to be chosen from it — so a live run created without
      // one would be a run whose cost nobody had looked at.
      if (!isUuid(dryRunIdIn)) {
        return refuse("dry_run_id is required to create a run that calls the model");
      }
      const budgetIn = numberOrNull(body.budget_input_tokens);
      const budgetOut = numberOrNull(body.budget_output_tokens);
      if (budgetIn === null || !Number.isInteger(budgetIn) || budgetIn <= 0) {
        return refuse("budget_input_tokens is required and must be a positive integer");
      }
      if (budgetOut === null || !Number.isInteger(budgetOut) || budgetOut <= 0) {
        return refuse("budget_output_tokens is required and must be a positive integer");
      }

      const dry = await readRun(dryRunIdIn);
      if (dry === "read_failed") {
        errors.push("read_failed:version_compare_runs");
        return json({ ok: false, mode: "run", errors, elapsedMs: elapsed(), version: FUNCTION_VERSION }, 500);
      }
      if (dry === null) return refuse("dry_run_id names no run");
      if (dry.status !== "dry") return refuse("dry_run_id does not name a dry run");
      const dryNotes = isRecord(dry.notes) ? dry.notes : {};
      const dryDetail = isRecord(dryNotes.dry) ? dryNotes.dry : {};
      // THIS GATE IS LOAD-BEARING FOR SPEND, not only for the budget numbers,
      // and the reason is not obvious from here.
      //
      // The two arms of a row are bought in SEPARATE HOPS. `prepareArm` can
      // fail for one arm and succeed for the other — spliceRulesBlock refuses a
      // block containing `$`, and the two arms carry different text — so a
      // candidate-arm failure discovered mid-run would orphan a live cell that
      // has already been paid for. It cannot happen today only because such a
      // failure leaves the dry run `complete: false` and this line refuses to
      // create the live run at all. Anything that relaxes this check re-opens a
      // paid half-pair.
      if (dryDetail.complete !== true) return refuse("the dry run did not finish counting its population");
      if (dry.stage !== stage) return refuse("the dry run was over a different stage");
      if (freezeIdIn !== undefined && dry.freeze_id !== freezeIdIn) {
        return refuse("the dry run was taken against a different freeze");
      }

      // THE BUDGETS ARE COMPARED WITH THE DRY RUN THAT EXISTS TO SIZE THEM.
      // One extra zero in a psql heredoc authorises an order of magnitude, and
      // the budget is the last control between this function and the key whose
      // exhaustion was user-visible on 2026-09-08. Both measured numbers go
      // into the refusal so an operator is told what he was compared against.
      const dryMeasuredInput = numberOrNull(dryDetail.measured_input_tokens);
      const dryBoundOutput = numberOrNull(dryDetail.bound_output_tokens);
      if (dryMeasuredInput === null || dryBoundOutput === null || dryMeasuredInput <= 0 || dryBoundOutput <= 0) {
        return refuse("the dry run recorded no measured_input_tokens / bound_output_tokens to size a budget from");
      }
      const inputCeiling = Math.ceil(dryMeasuredInput * BUDGET_SLACK);
      const outputCeiling = Math.ceil(dryBoundOutput * BUDGET_SLACK);
      if (budgetIn > inputCeiling) {
        return refuse(
          `budget_input_tokens ${budgetIn} exceeds ${BUDGET_SLACK}x the dry run's measured ` +
            `${dryMeasuredInput} (ceiling ${inputCeiling})`,
        );
      }
      if (budgetOut > outputCeiling) {
        return refuse(
          `budget_output_tokens ${budgetOut} exceeds ${BUDGET_SLACK}x the dry run's bound ` +
            `${dryBoundOutput} (ceiling ${outputCeiling})`,
        );
      }

      // ONE LIVE RUN PER DRY RUN. Every check above interrogates the DRY run
      // and none is consumed by being used, so two POSTs of the same body would
      // create two `running` runs, each inside its own budget, and the operator
      // would have authorised one budget and paid two. The documented
      // invocation is `select net.http_post(...)`, which returns before the run
      // exists — that window is exactly when the statement gets typed again.
      // The durable form is the partial unique index in the migration; this is
      // the human-timescale half.
      const alreadySpent = await readRowsOrNull(
        `version_compare_runs?status=in.(running,paused,done,aborted)` +
          `&notes->>dry_run_id=eq.${dryRunIdIn}&select=id,status&limit=5`,
      );
      if (alreadySpent === null) {
        errors.push("read_failed:version_compare_runs");
        return json({ ok: false, mode: "run", errors, elapsedMs: elapsed(), version: FUNCTION_VERSION }, 500);
      }
      if (alreadySpent.length > 0) {
        return refuse(
          `dry_run_id has already been spent by run ${String(alreadySpent[0].id)} ` +
            `(status ${String(alreadySpent[0].status)}); resume it with run_id or take a new dry run`,
        );
      }

      const dryPopulation = isRecord(dryNotes.population) ? dryNotes.population : {};
      const dryIds = Array.isArray(dryPopulation.ids) ? dryPopulation.ids.filter(isUuid) : [];
      const dryCut = typeof dry.population_frozen_at === "string" ? dry.population_frozen_at : "";
      if (dryIds.length === 0 || dryCut.length === 0) return refuse("the dry run carries no frozen population");

      // The live run INHERITS the freeze and the cut. Taking a new cut here
      // would silently widen the population the budgets were sized against.
      const expected = dryIds.length * 2;
      const cellsAHopCanStart = Math.max(
        1,
        Math.min(maxCells, Math.floor((WALL_CLOCK_BUDGET_MS - WRITE_RESERVE_MS) / MIN_CELL_START_MS)),
      );
      const maxHops = Math.ceil(
        (expected / cellsAHopCanStart) * (MINUTES_PER_HOUR / USABLE_MINUTES_PER_HOUR),
      ) + CHAIN_HOP_SLACK;

      const created = await insertRows("version_compare_runs", {
        freeze_id: dry.freeze_id,
        stage,
        population_frozen_at: dryCut,
        eligible_after: dry.eligible_after ?? null,
        expected_cells: expected,
        budget_input_tokens: budgetIn,
        budget_output_tokens: budgetOut,
        status: "running",
        chain: body.chain === true,
        chain_hops: 0,
        max_chain_hops: maxHops,
        version: FUNCTION_VERSION,
        notes: {
          dry_run_id: dryRunIdIn,
          population: dryPopulation,
          max_cells: maxCells,
          unmeasured_cell_input_bound: numberOrNull(dryDetail.largest_cell_input_tokens) ?? 0,
          // Already expired, so the first invocation acquires it, and never
          // null — a null needs an `is.null` filter rather than a simple `lt.`
          // comparison, and this file wants one spelling it can be sure of.
          lease_until: LEASE_EPOCH,
        },
      });
      if (created === null || !isUuid(created[0]?.id)) {
        errors.push("insert_failed:version_compare_runs");
        return json({ ok: false, mode: "run", errors, elapsedMs: elapsed(), version: FUNCTION_VERSION }, 500);
      }
      run = created[0];
    }

    const runId = run.id as string;
    const runStage: Stage = run.stage === "performance" ? "performance" : "materiality";
    const runNotes = isRecord(run.notes) ? run.notes : {};
    const runPopulation = isRecord(runNotes.population) ? runNotes.population : {};
    const runIds = Array.isArray(runPopulation.ids) ? runPopulation.ids.filter(isUuid).map((v) => v.toLowerCase()) : [];
    const cutIso = typeof run.population_frozen_at === "string" ? run.population_frozen_at : "";
    const expectedCells = numberOrNull(run.expected_cells) ?? 0;
    const budgetInput = numberOrNull(run.budget_input_tokens) ?? 0;
    const budgetOutput = numberOrNull(run.budget_output_tokens) ?? 0;
    const runMaxCells = Math.min(maxCells, numberOrNull(runNotes.max_cells) ?? maxCells);
    unmeasuredCellInputBound = numberOrNull(runNotes.unmeasured_cell_input_bound) ?? 0;

    let status = typeof run.status === "string" ? run.status : "";
    let abortReason: string | null = typeof run.abort_reason === "string" ? run.abort_reason : null;
    let skipped: string | null = null;
    let cellsThisInvocation = 0;
    let chained = false;

    const summarize = (totals: RunTotals | null, ok: boolean) => ({
      ok,
      mode: "run",
      run_id: runId,
      freeze_id: run.freeze_id,
      stage: runStage,
      expected_cells: expectedCells,
      completed_cells: totals?.completed ?? 0,
      failed_cells: totals?.failed ?? 0,
      unfinished_cells: totals?.unfinished ?? 0,
      cells_this_invocation: cellsThisInvocation,
      spent_input_tokens: totals?.spentInput ?? 0,
      spent_output_tokens: totals?.spentOutput ?? 0,
      unmeasured_cells: totals?.unmeasured ?? 0,
      bound_input_tokens_unmeasured: totals?.boundInput ?? 0,
      bound_output_tokens_unmeasured: totals?.boundOutput ?? 0,
      status,
      abort_reason: abortReason,
      skipped,
      chained,
      errors,
      elapsedMs: elapsed(),
      version: FUNCTION_VERSION,
    });

    // THE KILL SWITCH, read before anything is spent.
    if (status === "paused") {
      skipped = "paused";
      const totals = await reconcile(runId);
      return json(summarize(totals, true));
    }
    if (status !== "running") {
      const totals = await reconcile(runId);
      return json(summarize(totals, true));
    }

    if (runIds.length === 0 || cutIso.length === 0) {
      errors.push("run_population_missing");
      return json(summarize(null, false), 500);
    }

    const freezeRow = await readFreeze(String(run.freeze_id));
    if (freezeRow === "read_failed" || freezeRow === null) {
      errors.push("read_failed:rulebook_candidate_freezes");
      return json(summarize(null, false), 500);
    }
    const books = await loadFrozenBooks(freezeRow);
    if (typeof books === "string") {
      errors.push(books);
      return json(summarize(null, false), 500);
    }

    const population = await readPopulationByIds(runIds, cutIso);
    if (population === null) return json(summarize(null, false), 500);

    let totals = await reconcile(runId);
    if (totals === null) return json(summarize(null, false), 500);

    // A cell that already exists — finished or still claimed — belongs to some
    // other invocation. There is deliberately no re-claim of a stale cell: a
    // cell claimed and abandoned may already have been paid for, and re-running
    // it would spend twice while the record showed once. A stalled run stays
    // visibly stalled and the reporting gate stays shut.
    const claimed = new Set<string>();
    for (const cell of totals.cells) {
      if (typeof cell.analysis_id === "string" && typeof cell.arm === "string") {
        claimed.add(`${cell.analysis_id.toLowerCase()}#${cell.arm}`);
      }
    }
    const pending: PendingCell[] = [];
    for (const row of population) {
      for (const arm of ["live", "candidate"] as const) {
        if (!claimed.has(`${row.analysisId}#${arm}`)) pending.push({ row, arm });
      }
    }

    // What the row's OTHER arm said it sent. The two arms must agree on
    // everything except the book; this is the cheap half of the check that
    // report mode makes over the finished run, and it is the half that saves
    // the money.
    const siblingFacts = new Map<string, { userSha: string; facts: string; rulesSha: string }>();
    for (const cell of totals.cells) {
      if (typeof cell.analysis_id !== "string" || typeof cell.user_sha256 !== "string") continue;
      if (cell.status === "aborted" && cell.effort === "") continue;
      siblingFacts.set(`${cell.analysis_id.toLowerCase()}#${cell.arm}`, {
        userSha: cell.user_sha256,
        facts: [cell.effort, cell.max_tokens, cell.tools_present, cell.schema_in_prompt, cell.shape].join("|"),
        rulesSha: typeof cell.rules_sha256 === "string" ? cell.rules_sha256 : "",
      });
    }

    if (pending.length === 0) {
      // Nothing left to CLAIM is not the same fact as nothing left to FINISH.
      if (totals.completed + totals.failed >= expectedCells) {
        const patched = await patchRows(`version_compare_runs?id=eq.${runId}&status=eq.running`, { status: "done" });
        if (patched === null) errors.push("patch_failed:version_compare_runs_done");
        else if (patched.length > 0) status = "done";
      } else {
        errors.push(`unfinished_cells_block_done:${totals.unfinished}`);
      }
      return json(summarize(totals, true));
    }

    // ---- the run-level lease ---------------------------------------------
    // MIN_CALL_SPACING_MS is a local of this handler, so without a lease an
    // operator POSTing run_id while a chain hop is in flight puts two workers
    // on the shared key with no spacing at all. The per-cell claim stops them
    // paying twice for one cell; it does not stop two simultaneous calls.
    //
    // THE DRY PATH HAS NO LEASE, and that is a known gap rather than an
    // oversight. Two concurrent dry POSTs naming one run read the same
    // `notes.dry.per_row`, count the same cells, and both write notes back with
    // last-writer-wins — duplicated free calls and two unspaced count_tokens
    // streams on the shared key. It is free, it needs an operator to double-fire
    // one id, and noise-floor's dry path has the same shape. Left as it is and
    // written down in docs/VERSION_COMPARISON.md rather than fixed quietly.
    const leaseUntil = new Date(Date.now() + LEASE_MS).toISOString();
    const leased = await patchRows(
      `version_compare_runs?id=eq.${runId}&status=eq.running` +
        `&notes->>lease_until=lt.${encodeURIComponent(nowIso)}`,
      { notes: { ...runNotes, lease_until: leaseUntil } },
    );
    if (leased === null) {
      errors.push("patch_failed:version_compare_runs_lease");
      return json(summarize(totals, false), 500);
    }
    let acquired = leased.length > 0;
    if (!acquired) {
      // `->>` on an absent key is NULL and no comparison matches NULL, so a run
      // created without the field would read as permanently locked.
      const legacy = await patchRows(
        `version_compare_runs?id=eq.${runId}&status=eq.running&notes->>lease_until=is.null`,
        { notes: { ...runNotes, lease_until: leaseUntil } },
      );
      if (legacy === null) {
        errors.push("patch_failed:version_compare_runs_lease");
        return json(summarize(totals, false), 500);
      }
      acquired = legacy.length > 0;
    }
    if (!acquired) {
      skipped = "locked";
      return json(summarize(totals, true));
    }
    const releaseLease = async () => {
      const released = await patchRows(`version_compare_runs?id=eq.${runId}`, {
        notes: { ...runNotes, lease_until: LEASE_EPOCH },
      });
      if (released === null) errors.push("patch_failed:version_compare_runs_lease_release");
    };

    // ---- budget ----------------------------------------------------------
    // MEASURED SPEND PLUS THE BOUND ON THE SPEND THAT COULD NOT BE MEASURED. A
    // run whose calls all time out would otherwise pass every budget check ever
    // made while billing the full population.
    const budgetCrossed = (t: RunTotals): string | null => {
      if (t.spentInput + t.boundInput >= budgetInput) return "budget_input_exhausted";
      if (t.spentOutput + t.boundOutput >= budgetOutput) return "budget_output_exhausted";
      return null;
    };
    const stopForBudget = async (reason: string) => {
      abortReason = reason;
      status = "aborted";
      // Conditional on 'running' so it cannot overwrite an operator's 'paused'.
      const patched = await patchRows(
        `version_compare_runs?id=eq.${runId}&status=eq.running`,
        { status: "aborted", abort_reason: reason },
      );
      if (patched === null) errors.push("patch_failed:version_compare_runs_abort");
      skipped = "budget";
    };

    const crossed = budgetCrossed(totals);
    if (crossed) {
      await stopForBudget(crossed);
      await releaseLease();
      return json(summarize(totals, true));
    }

    // ---- the model call ---------------------------------------------------
    const callModel = async (
      requestBody: ReplayBody,
      timeoutMs: number,
      headroom: { input: number; output: number },
    ): Promise<CallOutcome> => {
      const outcome: CallOutcome = {
        httpStatus: 0,
        parsed: null,
        stopReason: null,
        stopDetails: null,
        requestId: null,
        responseModel: null,
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheCreationTokens: null,
        webSearchRequests: null,
        errorMessage: "",
        abortReason: null,
        pauseExhausted: false,
        pauseContinuations: 0,
        transportError: null,
      };
      const deadline = Date.now() + timeoutMs;
      let messages: unknown[] = [...requestBody.messages];
      let spentInput = 0;
      let spentOutput = 0;

      for (let attempt = 0; attempt < PAUSE_ATTEMPTS; attempt++) {
        if (deadline - Date.now() <= 0) {
          outcome.transportError = "deadline";
          return outcome;
        }
        // SERIAL, ALWAYS. A pause continuation is a call on the same shared key
        // as a live user's analysis.
        await spaceCalls();

        // MEASURED AFTER THE SLEEP, NOT BEFORE IT. `spaceCalls` can sleep up to
        // MIN_CALL_SPACING_MS, and a timeout computed before it would let the
        // fetch run for its full allowance starting twenty seconds late — past
        // the deadline, into the write reserve, and toward the platform's own
        // kill, which is the one way this worker dies holding a lease with
        // nothing recorded.
        const left = deadline - Date.now();
        if (left <= 0) {
          outcome.transportError = "deadline";
          return outcome;
        }

        let res: Response | null = null;
        let raw = "";
        try {
          res = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: anthropicHeaders,
            body: JSON.stringify({ ...requestBody, messages }),
            signal: AbortSignal.timeout(left),
          });
          // INSIDE THE TRY. AbortSignal.timeout aborts the response STREAM, not
          // just the connect, so headers can arrive and the signal fire during
          // res.text(); unguarded, that throw escapes and the cell is left
          // claimed with no record of what happened.
          raw = await res.text();
        } catch (err) {
          markCallEnded();
          outcome.transportError = err instanceof DOMException && err.name === "TimeoutError"
            ? "timeout"
            : slice200(err);
          return outcome;
        }
        markCallEnded();

        outcome.httpStatus = res.status;
        outcome.requestId = res.headers.get("request-id");
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = null;
        }
        outcome.parsed = parsed;

        if (isRecord(parsed)) {
          outcome.responseModel = strOrNull(parsed.model);
          outcome.stopReason = strOrNull(parsed.stop_reason);
          outcome.stopDetails = parsed.stop_details ?? null;
          const usage = isRecord(parsed.usage) ? parsed.usage : null;
          if (usage) {
            const inTok = numberOrNull(usage.input_tokens);
            const outTok = numberOrNull(usage.output_tokens);
            outcome.inputTokens = addUsage(outcome.inputTokens, inTok);
            outcome.outputTokens = addUsage(outcome.outputTokens, outTok);
            outcome.cacheReadTokens = addUsage(outcome.cacheReadTokens, numberOrNull(usage.cache_read_input_tokens));
            outcome.cacheCreationTokens = addUsage(
              outcome.cacheCreationTokens,
              numberOrNull(usage.cache_creation_input_tokens),
            );
            const serverTool = isRecord(usage.server_tool_use) ? usage.server_tool_use : null;
            if (serverTool) {
              outcome.webSearchRequests = addUsage(
                outcome.webSearchRequests,
                numberOrNull(serverTool.web_search_requests),
              );
            }
            spentInput += inTok ?? 0;
            spentOutput += outTok ?? 0;
          }
          if (isRecord(parsed.error)) outcome.errorMessage = slice200(parsed.error.message);
        }

        if (!res.ok) {
          // NEVER A RETRY. A key that answered 401, 403 or 429 once will answer
          // the next request the same way, and hammering a shared rate limit is
          // what makes a live user's analysis fail. A credit-balance 400 is the
          // failure of 2026-09-08 arriving again.
          const creditProblem = outcome.errorMessage.toLowerCase().includes("credit");
          if (res.status === 401 || res.status === 403 || res.status === 429 || creditProblem) {
            outcome.abortReason = `http_${res.status}:${outcome.errorMessage}`.slice(0, 200);
          }
          return outcome;
        }

        if (outcome.stopReason !== "pause_turn") return outcome;

        // A paused turn. Continue only while BOTH budgets still have room:
        // max_cells counts cells, and without this a single cell could make
        // PAUSE_ATTEMPTS billed calls with no budget check between them.
        if (spentInput >= headroom.input || spentOutput >= headroom.output) {
          outcome.abortReason = "budget_exhausted_mid_pause";
          return outcome;
        }
        const content = isRecord(parsed) ? parsed.content : null;
        if (!Array.isArray(content)) {
          outcome.pauseExhausted = true;
          return outcome;
        }
        messages = [...messages, { role: "assistant", content }];
        outcome.pauseContinuations += 1;
      }

      outcome.pauseExhausted = true;
      return outcome;
    };

    const claimCell = async (
      cell: PendingCell,
      facts: {
        shape: string;
        effort: string;
        maxTokens: number;
        toolsPresent: boolean;
        schemaInPrompt: boolean;
        schemaEra: string;
        systemSha: string;
        userSha: string;
        rulesSha: string;
      },
    ): Promise<string | "taken" | null> => {
      const rows = await insertRows(
        "version_compare_cells?on_conflict=run_id,analysis_id,arm",
        {
          run_id: runId,
          analysis_id: cell.row.analysisId,
          arm: cell.arm,
          shape: facts.shape,
          effort: facts.effort,
          max_tokens: facts.maxTokens,
          tools_present: facts.toolsPresent,
          schema_in_prompt: facts.schemaInPrompt,
          schema_era: facts.schemaEra,
          system_sha256: facts.systemSha,
          user_sha256: facts.userSha,
          rules_sha256: facts.rulesSha,
        },
        "resolution=ignore-duplicates,return=representation",
      );
      if (rows === null) return null;
      if (rows.length === 0) return "taken";
      const id = rows[0].id;
      return typeof id === "string" ? id : null;
    };

    const closeUnsent = async (cell: PendingCell, reason: string) => {
      const claimedRow = await claimCell(cell, {
        // `shape` is NOT NULL and checked, so a row that never reached a shape
        // still has to write one. What goes in is the nominal shape and it is
        // NOT evidence about a request: status is 'aborted' and error_slice
        // says no request was made. `effort` is written empty for the same
        // reason — inventing "low" would put a request that never happened into
        // the one column a reader would use to check what did.
        shape: "search_free_inline",
        effort: "",
        maxTokens: MAX_TOKENS,
        toolsPresent: false,
        schemaInPrompt: false,
        schemaEra: "unknown",
        systemSha: await sha256Hex(cell.row.system),
        userSha: await sha256Hex(cell.row.user),
        rulesSha: "",
      });
      if (claimedRow === null) return "claim_failed";
      if (claimedRow === "taken") return "taken";
      const patched = await patchRows(`version_compare_cells?id=eq.${claimedRow}`, {
        status: "aborted",
        finished_at: new Date().toISOString(),
        error_slice: reason.slice(0, 200),
      });
      if (patched === null) errors.push(`patch_failed:cell:${cell.row.analysisId}#${cell.arm}`);
      return "closed";
    };

    // ---- the cell loop ----------------------------------------------------
    for (const cell of pending) {
      if (cellsThisInvocation >= runMaxCells) break;

      // THE SPACING SLEEP HAPPENS HERE, BEFORE THE WALL CLOCK IS CONSULTED, and
      // not inside callModel where it used to be the only place.
      //
      // Two things depend on the order. The cron guard below reasons about the
      // window [now, now + 80s], so sleeping after it would slide the cell into
      // a minute the guard had just cleared. And `msLeftForWork()` is what
      // decides whether there is room for a call at all: a sleep taken after
      // that check spends time the check believed was available, so a cell
      // could start with the minimum 80 s, sleep 20, and be left with 60 for a
      // call the corpus says can take 72. Sleeping first makes both numbers
      // true. callModel still calls spaceCalls itself — it is the guarantee for
      // pause continuations, and by then this one has already elapsed.
      await spaceCalls();

      // CRON-MINUTE GUARD, asked again before every cell because an invocation
      // spans minutes, and it WAITS the minute out rather than returning from
      // inside it.
      const wasGuardedMinute = !windowIsClear(Date.now());
      if (!(await waitOutCronMinute())) {
        if (cellsThisInvocation === 0) skipped = "cron_minute";
        break;
      }
      if (wasGuardedMinute && cellsThisInvocation === 0 && msLeftForWork() < MIN_CELL_START_MS) {
        skipped = "cron_minute";
        break;
      }

      const left = msLeftForWork();
      if (left < MIN_CELL_START_MS) break;
      const callTimeout = Math.min(LLM_TIMEOUT_MS, left);

      const classified = classifyRow({ user: cell.row.user, system: cell.row.system, mode: cell.row.mode });
      if (isRefusal(classified)) {
        const outcomeOfClose = await closeUnsent(cell, `row_refused:${classified.code}`);
        if (outcomeOfClose === "claim_failed") {
          errors.push(`claim_failed:${cell.row.analysisId}#${cell.arm}`);
          break;
        }
        if (outcomeOfClose === "taken") continue;
        errors.push(`row_refused:${classified.code}:${cell.row.analysisId}`);
        cellsThisInvocation += 1;
        continue;
      }
      if (classified.promptClass === "already_fallback") {
        const outcomeOfClose = await closeUnsent(cell, "row_refused:already_fallback");
        if (outcomeOfClose === "claim_failed") {
          errors.push(`claim_failed:${cell.row.analysisId}#${cell.arm}`);
          break;
        }
        if (outcomeOfClose === "taken") continue;
        errors.push(`row_refused:already_fallback:${cell.row.analysisId}`);
        cellsThisInvocation += 1;
        continue;
      }

      // The seam is located before anything is spent, so that a system prompt
      // whose rules block cannot be found refuses for free rather than after a
      // billed call. spliceRulesBlock locates it again; that is a few
      // microseconds and one fewer thing to get wrong.
      const seam = locateRulesBlock(cell.row.system, classified.locale);
      if (isRefusal(seam)) {
        const outcomeOfClose = await closeUnsent(cell, `seam_refused:${seam.code}`);
        if (outcomeOfClose === "claim_failed") {
          errors.push(`claim_failed:${cell.row.analysisId}#${cell.arm}`);
          break;
        }
        if (outcomeOfClose === "taken") continue;
        errors.push(`seam_refused:${seam.code}:${cell.row.analysisId}`);
        cellsThisInvocation += 1;
        continue;
      }

      const prepared = await prepareArm(cell.row, cell.arm, books, classified);
      if (typeof prepared === "string") {
        const outcomeOfClose = await closeUnsent(cell, prepared);
        if (outcomeOfClose === "claim_failed") {
          errors.push(`claim_failed:${cell.row.analysisId}#${cell.arm}`);
          break;
        }
        if (outcomeOfClose === "taken") continue;
        errors.push(`${prepared}:${cell.row.analysisId}`);
        cellsThisInvocation += 1;
        continue;
      }

      const shapeFacts = {
        shape: prepared.shape,
        effort: prepared.effort,
        maxTokens: prepared.body.max_tokens,
        toolsPresent: "tools" in prepared.body,
        schemaInPrompt: prepared.schemaInPrompt,
        schemaEra: prepared.schemaEra,
        systemSha: prepared.systemSha,
        userSha: prepared.userSha,
        rulesSha: prepared.rulesSha,
      };

      // A CELL THAT WOULD NOT PAIR IS NOT BOUGHT.
      //
      // The two arms of a row routinely land in different invocations hours
      // apart. If rules.ts, shape.ts or prompt-surgery.ts was redeployed
      // between them, or the stored text was edited, the second cell asks a
      // different question and the pair is not a pair. The two failures have
      // opposite meanings and both are refused here rather than discovered in
      // report mode after the money is gone: a sibling that disagrees about the
      // USER TURN or the request facts is a broken pair, and a sibling that
      // agrees about the BOOK is not a comparison at all.
      const otherArm: Arm = cell.arm === "live" ? "candidate" : "live";
      const sibling = siblingFacts.get(`${cell.row.analysisId}#${otherArm}`);
      const theseFacts = [
        shapeFacts.effort,
        shapeFacts.maxTokens,
        shapeFacts.toolsPresent,
        shapeFacts.schemaInPrompt,
        shapeFacts.shape,
      ].join("|");
      if (sibling !== undefined) {
        const mismatch = sibling.userSha !== shapeFacts.userSha || sibling.facts !== theseFacts
          ? "request_disagrees_with_sibling_arm"
          : (sibling.rulesSha === shapeFacts.rulesSha ? "sibling_arm_carries_the_same_book" : null);
        if (mismatch !== null) {
          const outcomeOfClose = await closeUnsent(cell, mismatch);
          if (outcomeOfClose === "claim_failed") {
            errors.push(`claim_failed:${cell.row.analysisId}#${cell.arm}`);
            break;
          }
          if (outcomeOfClose === "taken") continue;
          errors.push(`${mismatch}:${cell.row.analysisId}`);
          cellsThisInvocation += 1;
          continue;
        }
      }

      // CLAIM BEFORE SPENDING. The insert commits before the model call, so a
      // worker killed at the wall clock leaves a row saying "this cell was
      // started and never answered" instead of a silent gap a later report
      // would read as a complete run.
      const cellId = await claimCell(cell, shapeFacts);
      if (cellId === null) {
        errors.push(`claim_failed:${cell.row.analysisId}#${cell.arm}`);
        break;
      }
      if (cellId === "taken") continue;

      const outcome = await callModel(prepared.body, callTimeout, {
        input: Math.max(0, budgetInput - (totals.spentInput + totals.boundInput)),
        output: Math.max(0, budgetOutput - (totals.spentOutput + totals.boundOutput)),
      });
      cellsThisInvocation += 1;

      const usagePatch: JsonRecord = {
        input_tokens: outcome.inputTokens,
        output_tokens: outcome.outputTokens,
        cache_read_input_tokens: outcome.cacheReadTokens,
        request_id: outcome.requestId,
        response_model: outcome.responseModel,
        http_status: outcome.httpStatus === 0 ? null : outcome.httpStatus,
        stop_reason: outcome.stopReason,
        finished_at: new Date().toISOString(),
      };
      if ((outcome.cacheCreationTokens ?? 0) > 0) {
        // Impossible while this file sends no cache_control; if it happens the
        // body on the wire was not the body shape.ts built.
        errors.push(`cache_creation_tokens:${outcome.cacheCreationTokens}`);
      }
      if ((outcome.webSearchRequests ?? 0) > 0) {
        // Billed per request; no token budget bounds it. This arm sends no
        // tools, so a non-zero count means the request was not what it claimed.
        errors.push(`web_search_requests:${outcome.webSearchRequests}`);
      }

      let cellStatus: CellStatus;
      let raw: RawAnswer | null = null;
      let errorSlice: string | null = null;
      let rulesApplied: unknown = null;

      if (outcome.transportError !== null) {
        cellStatus = outcome.transportError === "timeout" || outcome.transportError === "deadline"
          ? "timeout"
          : "http_error";
        errorSlice = outcome.transportError.slice(0, 200);
      } else if (outcome.pauseExhausted) {
        cellStatus = "pause_exhausted";
      } else {
        const answer = parseAnalysisJson(extractAnthropicText(outcome.parsed));
        const classifiedCell = classifyCell({
          httpStatus: outcome.httpStatus,
          stopReason: outcome.stopReason,
          parsed: answer,
          requiredKeys,
        });
        cellStatus = classifiedCell.status;
        raw = classifiedCell.raw;
        if (isRecord(answer) && Array.isArray(answer.rules_applied)) rulesApplied = answer.rules_applied;
        if (outcome.httpStatus < 200 || outcome.httpStatus >= 300) {
          errorSlice = `${outcome.httpStatus}:${outcome.errorMessage}`.slice(0, 200);
        }
      }

      // Three facts that mean "this cell is not a measurement" and that the
      // status vocabulary has no separate word for. None may land as 'ok'.
      const rawConfidence = intOrNull(raw?.confidence);
      if (cellStatus === "ok" && outcome.responseModel !== null && outcome.responseModel !== cell.row.model) {
        // AND IT STOPS THE RUN, for #64's reason: a model change partway
        // through a multi-hour run would otherwise shrink the population
        // silently, and a change affecting every row would spend the whole
        // budget before anything refused.
        cellStatus = "aborted";
        errorSlice = `model_mismatch:${outcome.responseModel}`.slice(0, 200);
        raw = null;
        outcome.abortReason = errorSlice;
      } else if (cellStatus === "ok" && (raw === null || raw.signal === null || rawConfidence === null)) {
        cellStatus = "aborted";
        errorSlice = "unstorable_raw:signal_or_confidence_not_a_storable_value";
        raw = null;
      } else if (cellStatus === "ok" && raw !== null && publishedProxy(raw) === null) {
        // All required keys present, so classifyCell said ok — but the signal
        // is outside the enum or the confidence outside 0-100. Left as 'ok' it
        // would count as instrument health and only be dropped much later as an
        // unprojectable row.
        cellStatus = "aborted";
        errorSlice = "out_of_contract:signal_or_confidence_outside_the_response_contract";
        raw = null;
      } else if (cellStatus === "ok" && outcome.pauseContinuations > 0) {
        errorSlice = `note:pause_continuations=${outcome.pauseContinuations}`;
      }

      const finished: JsonRecord = {
        ...usagePatch,
        status: cellStatus,
        error_slice: errorSlice,
        stop_details: cellStatus === "refusal" ? outcome.stopDetails ?? null : null,
        raw_signal: raw?.signal ?? null,
        raw_confidence: cellStatus === "aborted" ? null : intOrNull(raw?.confidence),
        raw_stop: raw?.stop ?? null,
        raw_tp1: raw?.tp1 ?? null,
        raw_fundamental_score: intOrNull(raw?.fundamental_score),
        missing_required_keys: raw?.missingRequiredKeys ?? null,
        rules_applied: rulesApplied,
      };
      const wrote = await patchRows(`version_compare_cells?id=eq.${cellId}`, finished);
      if (wrote === null) {
        // The call was paid for and its answer could not be written down.
        // Whatever refused this write will refuse the next one, and the run
        // would spend its whole budget leaving nothing but claimed rows.
        errors.push(`patch_failed:cell:${cell.row.analysisId}#${cell.arm}`);
        break;
      }

      // Logged: status, request id, a bounded error slice. Never a body, never
      // a prompt, never a header, never the token.
      console.log("version-compare cell", {
        run_id: runId,
        arm: cell.arm,
        status: cellStatus,
        http_status: outcome.httpStatus,
        request_id: outcome.requestId ?? "",
        error: errorSlice ?? "",
      });

      const after = await reconcile(runId);
      if (after === null) return json(summarize(totals, false), 500);
      totals = after;

      if (outcome.abortReason !== null) {
        abortReason = outcome.abortReason.slice(0, 200);
        status = "aborted";
        // CONDITIONAL ON 'running', for stopForBudget's reason: an operator who
        // set 'paused' while this cell was in flight has used the kill switch,
        // and an unconditional PATCH here would overwrite their answer with
        // this worker's. Both stops end the spending; only one of them is a
        // record of what the operator decided.
        const patched = await patchRows(`version_compare_runs?id=eq.${runId}&status=eq.running`, {
          status: "aborted",
          abort_reason: abortReason,
        });
        if (patched === null) errors.push("patch_failed:version_compare_runs_abort");
        else if (patched.length === 0) errors.push("abort_not_recorded:status_changed_under_us");
        console.error("version-compare aborted", { run_id: runId, abort_reason: abortReason });
        break;
      }

      const crossedNow = budgetCrossed(totals);
      if (crossedNow) {
        await stopForBudget(crossedNow);
        break;
      }
    }

    // ---- close the run out, or hand it to the next hop --------------------
    const finalTotals = await reconcile(runId);
    if (finalTotals !== null) totals = finalTotals;

    // Before the chain fires, or the child is refused by its own parent.
    await releaseLease();

    if (status === "running" && totals.completed + totals.failed >= expectedCells) {
      const patched = await patchRows(`version_compare_runs?id=eq.${runId}&status=eq.running`, { status: "done" });
      if (patched === null) errors.push("patch_failed:version_compare_runs_done");
      else if (patched.length > 0) status = "done";
    }

    // Re-read the header rather than trusting what this invocation remembers:
    // the kill switch is an UPDATE somebody else made while this was running.
    if (chain && status === "running") {
      const fresh = await readRun(runId);
      if (fresh === "read_failed" || fresh === null) {
        errors.push("read_failed:version_compare_runs_chain");
      } else {
        const freshStatus = typeof fresh.status === "string" ? fresh.status : "";
        const hops = numberOrNull(fresh.chain_hops) ?? 0;
        const maxHops = numberOrNull(fresh.max_chain_hops) ?? 0;
        const remaining = expectedCells - (totals.completed + totals.failed + totals.unfinished);
        const budgetLeft = budgetCrossed(totals) === null;
        if (freshStatus === "running" && remaining > 0 && budgetLeft && hops < maxHops) {
          // The increment and the authorisation are ONE conditional UPDATE, so
          // two invocations that both decide to fire cannot both match.
          const authorised = await patchRows(
            `version_compare_runs?id=eq.${runId}&status=eq.running&chain_hops=eq.${hops}`,
            { chain_hops: hops + 1 },
          );
          if (authorised === null) errors.push("patch_failed:version_compare_runs_chain_hop");
          else if (authorised.length > 0) {
            try {
              const handoff = await fetch(`${supabaseUrl}/functions/v1/version-compare`, {
                method: "POST",
                headers: { "Content-Type": "application/json", "x-sweep-token": expectedToken },
                body: JSON.stringify({
                  run_id: runId,
                  dry_run: false,
                  chain: true,
                  max_cells: runMaxCells,
                  // So the child's first call is spaced from THIS hop's last
                  // one. Without it MIN_CALL_SPACING_MS holds only inside an
                  // invocation, and a chained run makes about one call per
                  // invocation.
                  last_call_ended_at: lastCallEndedAt,
                }),
                signal: AbortSignal.timeout(CHAIN_HANDOFF_MS),
              });
              // Status only, never the body: the body is this function's own
              // summary. A handoff rejected outright must not report
              // chained:true and still spend a hop.
              if (!handoff.ok) errors.push(`chain_handoff_status:${handoff.status}`);
              else chained = true;
            } catch (err) {
              // A timeout is the expected case: the child has been delivered.
              if (err instanceof DOMException && err.name === "TimeoutError") chained = true;
              else errors.push(`chain_handoff:${slice200(err)}`);
            }
          }
        }
      }
    }

    return json(summarize(totals, true));
  } catch (err) {
    console.error("version-compare error:", slice200(err));
    return json({ ok: false, error: "サーバーエラーが発生しました" }, 500);
  }
});
