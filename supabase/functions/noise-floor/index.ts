// noise-floor — how often does the analyst disagree with itself when nothing
// was changed at all?
//
// #65 wants to know whether swapping the rulebook changes the answer. It
// cannot know that until this number exists: the request carries no seed, and
// temperature/top_p/top_k are not sent (shape.ts says why), so two identical
// POSTs are two independent samples and every difference #65 sees is a mixture
// it cannot decompose. This function replays the prompts already stored in
// public.analysis_prompts, twice each, and writes what came back.
//
// WHAT IT MUST NEVER DO, because it is pointed at production's own key and
// production's own tables:
//   * never write to analyses, lessons or rulebook — analysis_prompts is
//     read-only to it, and the only tables it writes are its own two;
//   * never call /functions/v1/analyze — that spends a user's analysis quota
//     and creates an analyses row, which is exactly the forbidden thing
//     scripts/check.ts does and the reason this is an edge function rather
//     than a copy of that script;
//   * never consume or release quota, and never touch the market-data key.
//
// WHAT IT SPENDS. Every /v1/messages call here is billed against the same
// ANTHROPIC_API_KEY that a live user's analysis and the postmortem sweep run
// on. On 2026-09-08, between 07:14:46Z and 07:23:02Z, six consecutive calls on
// that key failed with a credit-balance error, and they surfaced to a user as
// a visible error in the live app. That is the blast radius of this function
// getting its cost controls wrong, and it is why the controls below are
// refusals rather than warnings: dry_run defaults to TRUE, a live run cannot
// be created without a completed dry run and two token budgets, max_cells is
// capped server-side, the spend is measured from usage on every response
// rather than counted in calls, and a 401/403/429 or a credit-balance 400
// stops the whole run instead of being retried.
//
// Callers: an operator, by hand, from SQL. NEVER pg_cron — there is no job for
// this function and there must not be one (docs/OPERATIONS.md). See the
// invocation shape there; the token is read from the vault inside the SQL and
// its value is never written down.

import {
  classifyCell,
  publishedProxy,
  report,
  type CellStatus,
  type RawAnswer,
  type ReportCell,
  type Stratum,
} from "./metric.ts";
import {
  ARMS,
  MAX_TOKENS,
  RESPONSE_SCHEMA,
  SHAPE_REFUSAL_PREFIX,
  buildReplayRequest,
  replayHeaders,
  replayShape,
  type Arm,
  type ReplayBody,
  type RowClass,
} from "./shape.ts";
import {
  LOCALE,
  classifyRow,
  detectSchemaEra,
  fallbackTransform,
  isRefusal,
  type ClassifiedRow,
} from "./prompt-surgery.ts";

const FUNCTION_VERSION = "noise-floor-v2-2026-09-09T20:00:00Z";

// The platform kills the worker at 150 s with no chance to respond, which is
// the same limit analyze/budget.ts is written against. Stop at 130 s and keep
// 10 s of that back for the writes: a cell claimed and then abandoned is a
// paid call whose answer nobody has, so the reserve exists to make the PATCH
// that records the answer the one thing that cannot run out of time.
const WALL_CLOCK_BUDGET_MS = 130_000;
const WRITE_RESERVE_MS = 10_000;
// One replay turn. Longer than postmortem's 45 s because a stored analyst
// prompt is ~14k characters and answers into a 20-key object at max_tokens
// 8000, and shorter than the wall clock so that a hung call still leaves time
// to write the timeout down.
const LLM_TIMEOUT_MS = 100_000;
// Below this there is no point starting a cell: the claim would commit, the
// call would be aborted part-way, and a call aborted part-way still bills for
// the tokens the server had already generated. Better to leave the cell
// unclaimed for the next hop than to buy a timeout.
//
// MEASURED, and the measurement is why this is 80 s and not the 25 s it was
// first written as. `analyses.created_at - analysis_prompts.sent_at` over all
// 48 joined rows on 2026-09-09 — the fetch-to-write span, an UPPER bound on
// model time and the closest thing the stored record has to "how long one of
// these calls takes": min 39.1 s, p50 56.0 s, p90 66.1 s, max 71.8 s, 11 of 48
// above 62 s and 0 of 48 above 80 s. A floor of 25 s therefore sat below the
// measured MINIMUM: every cell started with 25-39 s left was a claim, a billed
// generation, and an abort — and because a claimed-and-finished cell is never
// re-claimed (see the pending set below), that replicate is lost for good and
// its row leaves the denominator. The rows lost that way are the SLOW ones,
// which is a non-random deletion from a 48-row population.
//
// The cost of the fix is stated rather than hidden: at 130 s of wall clock
// minus the 10 s write reserve, a floor of 80 s means one cell per invocation
// in the common case even when max_cells is 2, so a run needs about twice the
// hops. max_chain_hops is sized from this same constant at creation, so the two
// cannot drift apart.
const MIN_CELL_START_MS = 80_000;
// Strictly serial, and never closer together than this. Not a rate-limit
// guess: the point is that a replay must never be queued alongside a live
// user's analyse turn on the shared key, and back-to-back calls are how a
// harness turns into a load test.
//
// MEASURED FROM THE END OF THE PREVIOUS CALL, NOT ITS START, and the difference
// is the whole finding of 2026-09-09. The first version stamped `lastCallAt`
// before dispatching, so the two seconds were counted from the moment a call
// BEGAN. A replay call runs about 30 s, so two seconds had almost always
// elapsed by the time it returned and the next one went out immediately.
// Measured from the run that was interrupted, consecutive cells:
//   05:04:36.181 finished -> 05:04:36.297 started   0.1 s apart
//   05:05:42.393 finished -> 05:05:42.737 started   0.3 s apart
//   05:06:13.019 finished -> 05:06:14.033 started   1.0 s apart
// That is not "strictly serial with a gap"; that is one continuously occupied
// edge worker for forty minutes. At 05:08 a user's analyse request reached the
// gateway while a replay cell was in flight (05:07:47 -> 05:08:18) and the
// postmortem sweep had just fired (05:08:01), and it got no worker at all: no
// invocation was logged for it, and the browser showed the "could not connect"
// branch. The analyses either side of it succeeded, so nothing was broken --
// the harness simply took the seat.
//
// Twenty seconds against a ~30 s call is a duty cycle of about 60% inside an
// invocation, and the wall-clock floor below then admits one cell per hop. The
// number is a judgement, not a measurement: what IS measured is that two
// seconds was, in practice, zero.
const MIN_CALL_SPACING_MS = 20_000;

// Cells one invocation may spend on, and the ceiling the request cannot raise.
// Four is what fits inside the wall clock with the spacing above and a call
// that runs long; the cap is enforced here rather than trusted from the body.
const DEFAULT_MAX_CELLS = 2;
const MAX_CELLS_CAP = 4;
// Replicates per row. Two is the pre-registered design; three is allowed
// because disagree_i is defined for it, and the metric module refuses to put a
// Wilson interval on a non-binary score rather than faking one. More than
// three multiplies the bill without changing the estimand.
const MIN_REPS = 2;
const MAX_REPS = 3;
// An explicit analysis_ids list is a subset of a population measured at 48
// rows on 2026-09-09; a list longer than the whole population is a caller
// error, not a bigger experiment.
const MAX_EXPLICIT_IDS = 48;
// Tripwires, not policies. Both sit far above today's measured 48 rows and 96
// cells; a read that comes back exactly at the limit is a read that may have
// been truncated, and a truncated population is a moved denominator. Refuse
// rather than proceed on a page.
const POPULATION_READ_LIMIT = 200;
const CELL_READ_LIMIT = 1000;
// PostgREST takes the ids in the URL; 50 uuids is ~1.9 kB of query string,
// which is comfortably inside every proxy in the path.
const ID_CHUNK = 50;
// max_chain_hops at creation = ceil(expected / cells-a-hop-can-really-start),
// inflated for the refused cron minutes, plus this.
const CHAIN_HOP_SLACK = 2;
// Of the sixty minutes in an hour, nine are refused by the cron guard below,
// and a hop that lands in one waits the minute out rather than spending itself
// (see the cell loop). One refused hop per guarded minute is therefore the
// worst case, and hop budgets are inflated by 60/51 to pay for them.
const USABLE_MINUTES_PER_HOUR = 51;
const MINUTES_PER_HOUR = 60;
// Slept off the end of a guarded minute before looking at the clock again. The
// guard reads a whole-minute value, so waking a beat after the boundary is what
// keeps a rounding error from reading the same refused minute twice.
const CRON_EXIT_MARGIN_MS = 1_500;
// How long one invocation holds the run. Longer than the 130 s wall clock so a
// worker killed at the platform's 150 s cannot leave the lease looking free
// while its last call is still in flight; short enough that an operator whose
// worker died is not locked out for more than one hop's worth of wall clock.
const LEASE_MS = 165_000;
// The lease value a run is created with: already expired, so the first
// invocation acquires it, and never null — a null would need an `or=` filter
// with a quoted timestamp, and a simple `lt.` comparison on an always-present
// ISO-8601 UTC string is the filter this file can be sure it has spelled right.
const LEASE_EPOCH = "1970-01-01T00:00:00.000Z";
// The most a live run's budgets may exceed what its dry run measured and
// bounded. Not 1.0, and the reason is specific rather than defensive: the dry
// run counts ONE call per cell, while a paused turn makes up to PAUSE_ATTEMPTS
// calls per cell and each continuation resends a longer conversation, so a
// ceiling of exactly the dry figure would make the search_on arm unfundable.
// Two is the smallest round number above one that still turns the failure this
// check exists for -- an operator typing 7680000 where 768000 was meant -- into
// a refusal rather than an authorisation.
const BUDGET_SLACK = 2;
// How long to wait on the self-POST that hands the run to the next hop. The
// child has been delivered and is running by then; see the chain block below
// for what this does and does not guarantee.
const CHAIN_HANDOFF_MS = 5_000;
// Production's own bounded pause_turn loop, same ceiling.
const PAUSE_ATTEMPTS = 5;

// The UTC minutes this function refuses to start a cell in.
//
// MEASURED, not copied from a design note. `select jobid, jobname, schedule,
// active from cron.job` on 2026-09-09 returned four active jobs:
//
//   1  track-outcomes-sweep   3,18,33,48 * * * *   -> /functions/v1/track-outcomes
//   4  postmortem-sweep       8,23,38,53 * * * *   -> /functions/v1/postmortem
//   5  econ-calendar-sync     13 * * * *           -> /functions/v1/econ-calendar
//   3  purge-cron-history     0 3 * * *            -> a DELETE inside the database
//
// The nine minutes below are the union of the first three, which are the three
// that fire an edge function. postmortem is the one that matters most: it
// shares this exact ANTHROPIC_API_KEY, and the credit exhaustion of 2026-09-08
// hit analyze and postmortem together. The other two share the worker pool and
// the database.
//
// purge-cron-history is deliberately NOT in the set. It runs once a day at
// 03:00 UTC, calls no function, and deletes rows from cron.job_run_details
// that nothing here reads. Adding minute 0 would refuse 24 slots a day to dodge
// one daily delete, and a refused slot costs a whole minute of an invocation's
// wall clock (see the cell loop, which waits a guarded minute out).
//
// NO TWO OF THESE NINE MINUTES ARE CONSECUTIVE, and the cell loop depends on
// it: waiting once to the top of the next minute is enough to leave the guarded
// minute, and a set with a run of two would need a loop instead of one sleep.
// The test file pins that property so a fifth cron job cannot break it quietly.
// The migrations that created these jobs are 20260903090000 (superseded by
// 20260903100000 under the same jobname), 20260903100500, 20260903150000 and
// 20260903190000 — but docs/OPERATIONS.md §5 is right that the schedule is
// changed with cron.alter_job and not with a migration, so the database is the
// authority and the database is what was read.
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

const numberOrNull = (value: unknown): number | null => {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
};

// An integer or nothing. Used on the two columns typed `integer` in the
// migration: a fractional confidence is a contract violation, and rounding it
// here would be exactly the coercion metric.ts exists to prevent.
const intOrNull = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) ? value : null;

const constantTimeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

// Every id this function puts into a PostgREST path goes through here first.
// Two reasons and the second is the one that matters: a malformed id would
// produce a filter that quietly matches nothing (and "nothing" would read as
// "the run has no cells"), and an id containing a comma or a parenthesis would
// change the shape of an `in.(...)` list. There is no path where a
// non-uuid is a recoverable input.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (value: unknown): value is string =>
  typeof value === "string" && UUID_RE.test(value);

// Hex sha256 of a string, over its UTF-8 bytes. The only thing this function
// ever records about a prompt: noise_cells stores digests and never text,
// because 20260905161000_replay_inputs_are_server_side.sql moved the system
// prompt off a table with a client-readable grant and echoing it into a second
// table for debugging convenience would rebuild that exposure. The digests are
// enough to prove two replicates sent identical bytes, which is the only thing
// the measurement needs of them.
const sha256Hex = async (text: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Sums a usage counter across the continuations of one paused turn. Null stays
// null while nothing has been reported, because a cell that never got a usage
// block has an UNKNOWN cost, not a zero one.
const addUsage = (current: number | null, value: number | null): number | null =>
  value === null ? current : (current ?? 0) + value;

// Bounded, and bounded everywhere it is used. 200 characters of an error is
// enough to tell a 429 from a schema complaint; a whole body is a prompt, a
// header or a token waiting to be printed into a log nobody reads until it is
// too late.
const slice200 = (value: unknown): string =>
  (value instanceof Error ? value.message : String(value ?? "")).slice(0, 200);

// ---------------------------------------------------------------------------
// Reading the model's answer
// ---------------------------------------------------------------------------
//
// Both duplicated from analyze/index.ts (extractAnthropicText and
// parseAnalysisJson) for the reason shape.ts and metric.ts give for their own
// duplications: importing from analyze drags the whole analyzer — Deno APIs,
// database calls, the price fetcher — into this bundle. They are also the two
// functions this measurement depends on being IDENTICAL to production's, since
// a replay that reads the answer differently from the way production read it
// would report a parse difference as a model difference.

const extractAnthropicText = (value: unknown): string => {
  if (!isRecord(value)) return "";
  const content = value.content;
  if (typeof content === "string") return content.trim();
  // Server-tool failures arrive HTTP 200 with `content` as an OBJECT rather
  // than a list. Indexing it would throw inside the cell loop; returning ""
  // lands the cell in parse_failed, which is what it is.
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
// Types local to the harness
// ---------------------------------------------------------------------------

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
  rep: number;
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
  // usage.server_tool_use.web_search_requests. Web search is billed PER
  // REQUEST, not per token, so on the search_on arm there is a line on the bill
  // that neither token budget can see. There is no column for it, so it is
  // surfaced on the response the same way an unexpected cache_creation count
  // is: said out loud rather than folded into a number whose name would then be
  // a lie. The limitation is written down in docs/OPERATIONS.md as well,
  // because "the ceiling does not cover this arm" is an operator's decision to
  // make and not a thing to discover from an invoice.
  webSearchRequests: number | null;
  errorMessage: string;
  // Set when this response means the run stops: a credit-balance 400, or any
  // 401 / 403 / 429. Never a retry — see the call site.
  abortReason: string | null;
  // The bounded pause_turn loop ran out of attempts.
  pauseExhausted: boolean;
  // How many continuations the pause loop made. The design requires it to be
  // recorded, and there is no column for it (noise_cells is not this task's to
  // alter), so it is written into error_slice as a `note:` prefix when it is
  // non-zero and surfaced on the response. It should be 0 on every cell of the
  // primary arm — search_free sends no `tools` and pause_turn is a server-tool
  // signal — which is exactly why the count is the thing that would prove it.
  pauseContinuations: number;
  // The call itself never completed (transport or AbortSignal.timeout).
  transportError: string | null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const startedAt = Date.now();
  const elapsed = () => Date.now() - startedAt;
  // What is left of the wall clock after the write reserve is taken out.
  const msLeftForWork = () => WALL_CLOCK_BUDGET_MS - elapsed() - WRITE_RESERVE_MS;

  const errors: string[] = [];

  // Wait a guarded cron minute OUT rather than returning from inside it.
  //
  // This is the repair for the worst behaviour this harness had. The guard used
  // to break the loop having done nothing, execution fell through to the chain
  // block, and the chain block — which asks about status, remaining cells,
  // budget and hops, but never about whether this hop did any work — fired the
  // next hop immediately. A do-nothing hop costs about ten PostgREST round
  // trips, so the chain turned over roughly once a second for the rest of that
  // minute: fifty to a hundred hops, which is the ENTIRE hop budget of the
  // pre-registered run (96 cells at 2 a hop plus slack), spent inside the one
  // minute the guard exists to keep this function out of. The guard's own
  // purpose was inverted — a burst of edge-function invocations and megabytes
  // of PostgREST traffic aimed precisely at the minute track-outcomes or
  // postmortem is running — and the run then stopped for good with most of its
  // cells unclaimed.
  //
  // Waiting makes a refused minute cost wall clock instead of hops, which is
  // what the max_chain_hops arithmetic at creation always assumed it cost. It
  // returns true when the caller may proceed. One sleep is enough because no
  // two guarded minutes are consecutive (see CRON_MINUTES).
  // THE WINDOW, NOT THE INSTANT. Asking only whether the CURRENT minute is
  // guarded was the second half of the 2026-09-09 finding. A cell takes about
  // 30 s and is budgeted 80 s, so a cell that starts at :07:47 is still holding
  // the worker at :08:01 when the postmortem sweep fires -- and that is exactly
  // what happened: no cell STARTED inside minute 8 (the guard did wait the
  // minute out, 05:08:18 -> 05:09:02, so the old guard was working as written),
  // yet a cell was in flight right through it, and the analyse request that
  // arrived at 05:08 got no worker.
  //
  // So the question a cell must ask is not "is this minute guarded" but "does
  // any minute I could still be running in belong to a cron job". The window is
  // [now, now + MIN_CELL_START_MS], the same budget the wall-clock guard uses,
  // which keeps the two from disagreeing about how long a cell can take.
  //
  // The loop runs at most a few times: one sleep clears the current minute, and
  // because no two guarded minutes are consecutive the window can need at most
  // one more nudge. It is bounded anyway rather than trusted to terminate.
  const windowIsClear = (fromMs: number): boolean => {
    const firstMinute = Math.floor(fromMs / 60_000);
    const lastMinute = Math.floor((fromMs + MIN_CELL_START_MS) / 60_000);
    for (let m = firstMinute; m <= lastMinute; m++) {
      if (CRON_MINUTES.has(new Date(m * 60_000).getUTCMinutes())) return false;
    }
    return true;
  };
  const waitOutCronMinute = async (): Promise<boolean> => {
    for (let attempt = 0; attempt < 4; attempt++) {
      if (windowIsClear(Date.now())) return true;
      const wait = 60_000 - (Date.now() % 60_000) + CRON_EXIT_MARGIN_MS;
      // Never sleep past the wall clock: an invocation that overran would be
      // killed by the platform mid-write, which is the one thing the write
      // reserve exists to prevent.
      if (wait > msLeftForWork()) return false;
      await sleep(wait);
    }
    return windowIsClear(Date.now());
  };

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
    // No SUPABASE_ANON_KEY, and its absence is the point: the other three sweep
    // functions read it only to call /auth/v1/user for their admin-JWT branch,
    // and this function has no such branch (see the gate below).
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

    // null when the READ ITSELF failed, as opposed to nothing being there. The
    // difference decides everything downstream: "this run has no cells yet"
    // and "the cells table could not be reached" produce the same empty list
    // and opposite correct actions — the first says claim and spend, the
    // second says stop. Every call site below treats null as an abort of the
    // whole invocation. There is no `?? []` in this file.
    //
    // A 200 WHOSE BODY WILL NOT PARSE IS A FAILED READ, not an empty table, and
    // that used to be the one place in this file where the rule above was
    // broken. A truncated or proxy-mangled body would have come back as `[]`,
    // and `[]` from `analyses` in report mode makes every cell unstratifiable —
    // which silently moves the 4 preview rows into `core`, enlarges the
    // denominator the go/no-go turns on, and LOWERS the Wilson upper bound.
    // That is the direction that lets a failing run read as passable, so the
    // parse failure is now indistinguishable from the transport failure it is.
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
      // Same rule as the read: with Prefer: return=representation a 200 is an
      // array or it is a write this function cannot claim to have seen land.
      // Callers read zero rows as "the conditional filter did not match", and a
      // filter that did not match is not the same fact as a body that did not
      // parse.
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
      // And again: zero rows back from resolution=ignore-duplicates means the
      // claim was already taken, which the cell loop acts on by NOT spending.
      // An unparseable body read as zero rows would look like the same thing
      // and skip a cell that was never claimed at all.
      const rows = await res.json().catch(() => null);
      if (!Array.isArray(rows)) {
        console.error("insert unparseable:", path.split("?")[0], res.status);
        return null;
      }
      return rows.filter(isRecord);
    };

    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();

    // ---- the request body ------------------------------------------------
    // Parsed BEFORE the auth block (house pattern, postmortem/index.ts). It
    // grants nothing: the token is still checked below and every field is only
    // acted on after it has been.
    const bodyRaw = await req.json().catch(() => null);
    const body: JsonRecord = isRecord(bodyRaw) ? bodyRaw : {};

    // ---- who is asking ---------------------------------------------------
    // ONE BRANCH. The other three sweep functions accept either the shared
    // token or an admin's JWT; this one takes the token and nothing else, and
    // an absent or wrong token is a flat 401.
    //
    // Two reasons, both about the fact that this function spends money on the
    // shared Anthropic key. A JWT branch would need a fifth copy of
    // ADMIN_EMAILS — the array already lives in analyze/index.ts,
    // postmortem/index.ts, econ-calendar/index.ts and src/lib/admin.ts, and a
    // fifth copy of a list that decides who may spend is four too many
    // already. And an operator holding an admin JWT is the browser session of
    // somebody who is, at that moment, using the app; the caller this function
    // is designed for is a SQL statement that reads the token out of the vault
    // (docs/OPERATIONS.md §5), which is a deliberate act at a psql prompt and
    // not a stray fetch from a logged-in tab.
    //
    // Nothing about the token is logged, returned, or written anywhere.
    const sweepToken = req.headers.get("x-sweep-token");
    if (!sweepToken) {
      return json({ ok: false, error: "認証が必要です" }, 401);
    }
    const tokenRes = await rest("rpc/track_outcomes_sweep_token", { method: "POST", body: "{}" });
    const expectedToken = tokenRes.ok ? await tokenRes.json().catch(() => null) : null;
    // An empty expected value is a mismatch, not a match. A vault secret that
    // failed to decrypt comes back as "" and a comparison that let that through
    // would authenticate every caller who sent an empty header.
    if (
      typeof expectedToken !== "string" ||
      expectedToken.length === 0 ||
      !constantTimeEqual(sweepToken, expectedToken)
    ) {
      return json({ ok: false, error: "認証に失敗しました" }, 401);
    }

    // ---- the request contract -------------------------------------------
    // `error` carries the house's own 400 string (analyze/index.ts uses the
    // same one), so a caller reading this response sees the shape every other
    // function in the repo answers a bad request with; `errors` carries the
    // English detail, which only ever reaches an operator at a psql prompt.
    const refuse = (detail: string) =>
      json({
        ok: false,
        error: "リクエスト形式が不正です",
        mode: "refused",
        errors: [detail],
        elapsedMs: elapsed(),
        version: FUNCTION_VERSION,
      }, 400);

    // dry_run DEFAULTS TO TRUE, and that default is a cost control rather than
    // a convenience: a body that forgets the field, a body that misspells it,
    // and a body that is not JSON at all all land on the free path. Only an
    // explicit `false` can reach /v1/messages.
    const dryRun = body.dry_run !== false;
    const reportRunId = body.report_run_id;
    const runIdIn = body.run_id;
    const dryRunIdIn = body.dry_run_id;
    const chain = body.chain === true;

    if (reportRunId !== undefined && !isUuid(reportRunId)) return refuse("report_run_id must be a uuid");
    if (runIdIn !== undefined && !isUuid(runIdIn)) return refuse("run_id must be a uuid");
    if (dryRunIdIn !== undefined && !isUuid(dryRunIdIn)) return refuse("dry_run_id must be a uuid");

    const armIn = body.arm === undefined ? "search_free" : body.arm;
    if (typeof armIn !== "string" || !ARMS.includes(armIn as Arm)) {
      return refuse(`arm must be one of ${ARMS.join(", ")}`);
    }
    const arm = armIn as Arm;

    const repsIn = body.reps === undefined ? MIN_REPS : numberOrNull(body.reps);
    if (repsIn === null || !Number.isInteger(repsIn) || repsIn < MIN_REPS || repsIn > MAX_REPS) {
      return refuse(`reps must be an integer between ${MIN_REPS} and ${MAX_REPS}`);
    }
    const repsRequested = repsIn;

    // Capped here and not trusted from the body. Silently clamping would let a
    // caller ask for 40 and read the answer as though 40 had run.
    const maxCellsIn = body.max_cells === undefined ? DEFAULT_MAX_CELLS : numberOrNull(body.max_cells);
    if (maxCellsIn === null || !Number.isInteger(maxCellsIn) || maxCellsIn < 1 || maxCellsIn > MAX_CELLS_CAP) {
      return refuse(`max_cells must be an integer between 1 and ${MAX_CELLS_CAP}`);
    }
    const maxCells = maxCellsIn;

    let explicitIds: string[] | null = null;
    if (body.analysis_ids !== undefined && body.analysis_ids !== null) {
      if (!Array.isArray(body.analysis_ids)) return refuse("analysis_ids must be an array of uuids");
      const seen = new Set<string>();
      for (const value of body.analysis_ids) {
        if (!isUuid(value)) return refuse("analysis_ids contains a value that is not a uuid");
        seen.add(value.toLowerCase());
      }
      if (seen.size === 0) return refuse("analysis_ids was given but empty; omit it to use the whole population");
      if (seen.size > MAX_EXPLICIT_IDS) return refuse(`analysis_ids may name at most ${MAX_EXPLICIT_IDS} rows`);
      explicitIds = [...seen];
    }

    // run_id resumes an existing run and carries its own arm and reps on the
    // header; accepting arm/reps beside it would let the two disagree, and the
    // one that lost would be invisible in the record.
    if (runIdIn !== undefined && (body.arm !== undefined || body.reps !== undefined)) {
      return refuse("run_id is mutually exclusive with arm and reps");
    }
    // And with analysis_ids, for the same reason and a worse consequence. The
    // row set is fixed at creation and written into notes.population.ids; a
    // resume takes its ids from there and never looked at the body's. An
    // operator re-POSTing a stalled run with a SHORT analysis_ids list — the
    // obvious way to try to finish a few rows — was therefore silently claiming
    // and spending on the whole remaining population, with nothing in the
    // response saying the list had been ignored. An attempt to narrow a run
    // must not widen it.
    if (runIdIn !== undefined && body.analysis_ids !== undefined) {
      return refuse("run_id is mutually exclusive with analysis_ids; the row set is fixed at creation");
    }

    // ---- helpers over the two tables -------------------------------------

    const readRun = async (id: string): Promise<JsonRecord | null | "read_failed"> => {
      const rows = await readRowsOrNull(`noise_runs?id=eq.${id}&select=*`);
      if (rows === null) return "read_failed";
      return rows[0] ?? null;
    };

    // The frozen population, by id, in the order the run declared. Reading by
    // id rather than by timestamp on every hop is what makes a resumed run the
    // same experiment as the one that was created: the id list is written into
    // notes at creation, so nothing the table does afterwards — new rows, a
    // cascade delete — can move the denominator without this refusing.
    const readPopulationByIds = async (
      ids: readonly string[],
      frozenAtIso: string,
    ): Promise<PopulationRow[] | null> => {
      const prompts = new Map<string, JsonRecord>();
      for (let i = 0; i < ids.length; i += ID_CHUNK) {
        const chunk = ids.slice(i, i + ID_CHUNK);
        const rows = await readRowsOrNull(
          // Named columns rather than `select=*`. Every hop reads the whole
          // frozen population and that is DELIBERATE — a row that has become
          // unreadable is a reason to refuse the run, not to quietly measure 47
          // rows and report the rate over 48 (see the loop below) — but there
          // is no reason to move any column the harness does not use. The
          // volume is real: the 48 systems and users together are 652,739
          // characters, measured, and this read happens once per hop.
          `analysis_prompts?analysis_id=in.(${chunk.join(",")})` +
            `&created_at=lte.${encodeURIComponent(frozenAtIso)}` +
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
        // Every one of these is a refusal rather than a skip. The population
        // was declared before the first billable call and the stopping rule
        // forbids adding or dropping rows once it was; a row that has become
        // unreadable is a reason to stop the run and say so, not a reason to
        // quietly measure 47 rows and report the rate over 48.
        if (!prompt) {
          errors.push(`population_row_missing:${id}`);
          return null;
        }
        if (!analysis) {
          errors.push(`population_analysis_missing:${id}`);
          return null;
        }
        const system = prompt.system;
        const user = prompt["user"];
        const model = prompt.model;
        if (typeof system !== "string" || system.length === 0) {
          errors.push(`population_system_missing:${id}`);
          return null;
        }
        if (typeof user !== "string" || user.length === 0) {
          errors.push(`population_user_missing:${id}`);
          return null;
        }
        if (typeof model !== "string" || model.length === 0) {
          errors.push(`population_model_missing:${id}`);
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

    // The population at the freeze, used only when a run is created. Ordered
    // deterministically so the id list, and therefore its digest, does not
    // depend on how PostgREST felt about the page.
    const readFrozenIds = async (frozenAtIso: string): Promise<string[] | null> => {
      const rows = await readRowsOrNull(
        `analysis_prompts?created_at=lte.${encodeURIComponent(frozenAtIso)}` +
          `&select=analysis_id,created_at&order=created_at.asc,analysis_id.asc&limit=${POPULATION_READ_LIMIT}`,
      );
      if (rows === null) {
        errors.push("read_failed:analysis_prompts");
        return null;
      }
      if (rows.length >= POPULATION_READ_LIMIT) {
        errors.push(`population_read_truncated_at:${POPULATION_READ_LIMIT}`);
        return null;
      }
      const ids: string[] = [];
      for (const row of rows) {
        if (isUuid(row.analysis_id)) ids.push(row.analysis_id.toLowerCase());
      }
      return ids;
    };

    // ---- the run header's counters, recomputed rather than incremented ----
    //
    // completed_cells, failed_cells and the two spend counters are all derived
    // here from the cells themselves and written as absolute values. The
    // migration's noise_runs_cells_accounted_check names the hazard exactly:
    // an increment can be applied twice — by a stale claim re-run, by a chained
    // hop that re-commits the batch before it — and a double increment opens
    // the reporting gate while ok cells are still missing, which biases the
    // published rate downward, which is the one direction #65 cannot survive.
    // A recomputation cannot double-count: it is a count of rows that exist.
    // It also cannot exceed expected_cells, because a cell is only ever claimed
    // for a (row, rep) pair drawn from the frozen population, so the constraint
    // holds by construction rather than by care.
    //
    // The spend it can UNDER-report is bounded and visible: a cell that was
    // claimed, called, and never patched (a worker killed between the two)
    // keeps status 'claimed' and contributes no usage. That is why the write
    // reserve exists, and why `unfinished` is on the response.
    interface RunTotals {
      completed: number;
      failed: number;
      unfinished: number;
      spentInput: number;
      spentOutput: number;
      // Cells that finished with no usage block at all, and the worst-case cost
      // of them. See tallyCells for why these are separate numbers rather than
      // being folded into spent*.
      unmeasured: number;
      boundInput: number;
      boundOutput: number;
      cells: JsonRecord[];
    }

    // The largest per-row input count the dry run measured, carried onto the
    // live run's notes at creation and read back here. It is the price of the
    // one call a cell makes, so it is the right bound to charge a cell whose
    // usage never came back. Zero when a run predates this field, and a zero
    // bound is visible in the response as unmeasured_cells with no bound beside
    // it rather than as a silent nothing.
    let unmeasuredCellInputBound = 0;

    const readCells = async (runId: string, select: string): Promise<JsonRecord[] | null> => {
      const rows = await readRowsOrNull(
        `noise_cells?run_id=eq.${runId}&select=${select}&order=analysis_id.asc,rep.asc&limit=${CELL_READ_LIMIT}`,
      );
      if (rows === null) {
        errors.push("read_failed:noise_cells");
        return null;
      }
      if (rows.length >= CELL_READ_LIMIT) {
        errors.push(`cell_read_truncated_at:${CELL_READ_LIMIT}`);
        return null;
      }
      return rows;
    };

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
        // SPEND THAT COULD NOT BE MEASURED IS NOT ZERO, and the columns are not
        // allowed to say it was.
        //
        // addUsage keeps null when no usage block ever arrived, and usagePatch
        // writes that null through, exactly as intended: a cell that timed out
        // has an UNKNOWN cost, not a zero one. But the tally below then read
        // those nulls as zeros, and the token budget is computed from the
        // tally. The consequence was that the one control the operator
        // authorises in advance could not see the class of spend most likely to
        // happen: a call aborted mid-generation bills for everything the server
        // had produced, reports no usage to the client, and moved spent_* by
        // nothing at all. A run that timed out consistently could spend its
        // whole population while spent_input_tokens = spent_output_tokens = 0
        // and the response said ok.
        //
        // The two columns stay a MEASUREMENT — that is what the migration says
        // they are, and writing a guess into them would make every later reading
        // of this run's cost a guess. The bound lives beside them instead, and
        // budgetCrossed below compares measured + bound. So the record keeps
        // what was observed, and the control acts on what might have been spent.
        const measuredInput = numberOrNull(cell.input_tokens);
        const measuredOutput = numberOrNull(cell.output_tokens);
        if (status !== "claimed" && measuredInput === null && measuredOutput === null) {
          unmeasured += 1;
          boundInput += unmeasuredCellInputBound;
          // The exact ceiling: one call cannot produce more than max_tokens of
          // output, and this harness sends exactly one call per cell on the
          // arms that cannot pause.
          boundOutput += MAX_TOKENS;
        }
        // cache_read is on the input side of the bill. cache_creation has no
        // column because this harness sends no cache_control (shape.ts, and
        // the test that pins it), so a non-zero creation count would mean the
        // body on the wire was not the body shape.ts built; the cell loop
        // reports that on `errors` rather than folding it into a column whose
        // name would then be a lie.
        spentInput += (numberOrNull(cell.input_tokens) ?? 0) + (numberOrNull(cell.cache_read_input_tokens) ?? 0);
        spentOutput += numberOrNull(cell.output_tokens) ?? 0;
      }
      return { completed, failed, unfinished, spentInput, spentOutput, unmeasured, boundInput, boundOutput, cells };
    };

    const reconcile = async (runId: string): Promise<RunTotals | null> => {
      // analysis_id and rep are selected because the live path builds its
      // claimed set out of these same rows. Without them every id read as
      // undefined, the claimed set came out empty, and an invocation late in a
      // run walked the entire finished population issuing a doomed INSERT per
      // cell before it reached a fresh one — safe (the unique key answered
      // "taken" every time and nothing was spent twice) but quadratic in the
      // length of the run. The four request-shape columns come along so the
      // cell loop can compare a new cell against its sibling BEFORE paying for
      // it; see the digest check there.
      const cells = await readCells(
        runId,
        "analysis_id,rep,status,input_tokens,output_tokens,cache_read_input_tokens," +
          "system_sha256,user_sha256,effort,max_tokens,tools_present,schema_in_prompt,shape",
      );
      if (cells === null) return null;
      const totals = tallyCells(cells);
      const patched = await patchRows(`noise_runs?id=eq.${runId}`, {
        completed_cells: totals.completed,
        failed_cells: totals.failed,
        spent_input_tokens: totals.spentInput,
        spent_output_tokens: totals.spentOutput,
      });
      if (patched === null) {
        errors.push("patch_failed:noise_runs_totals");
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
        errors.push("read_failed:noise_runs");
        return json({ ok: false, mode: "report", errors, elapsedMs: elapsed(), version: FUNCTION_VERSION }, 500);
      }
      if (run === null) return refuse("report_run_id names no run");

      const reps = numberOrNull(run.reps) ?? 0;
      const reportNotes = isRecord(run.notes) ? run.notes : {};
      unmeasuredCellInputBound = numberOrNull(reportNotes.unmeasured_cell_input_bound) ?? 0;

      // THE FROZEN POPULATION, not the counter. The completeness gate inside
      // report() keys on expected_cells, and expected_cells is a mutable
      // integer column: anything that lowered it — a hand UPDATE on a stalled
      // run, a future path that recomputed it — would let both of report()'s
      // `<` comparisons pass over a fraction of the run and emit a rate LABELLED
      // as the 48-row pooled estimand over however many rows happened to be
      // finished. The pre-registration's 「間引かない」 would be violated with
      // emitted:true and nothing in the output saying so.
      //
      // The id list written at creation is the population, it is digested, and
      // it is what the budgets were sized against. So the expectation handed to
      // report() is recomputed from it here, the column is only cross-checked,
      // and a disagreement between the two is a refusal rather than a choice.
      const reportPopulation = isRecord(reportNotes.population) ? reportNotes.population : {};
      const frozenIds = Array.isArray(reportPopulation.ids)
        ? reportPopulation.ids.filter(isUuid).map((id) => id.toLowerCase())
        : [];
      if (frozenIds.length === 0 || reps <= 0) {
        return refuse("the run header carries no frozen population or no reps; it cannot be reported");
      }
      const expectedFromPopulation = frozenIds.length * reps;
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

      // The six request facts are selected as well as read. They were written
      // on every cell and, until now, read by nothing — while the migration
      // says of the two digests "the bytes that went on the wire; two
      // replicates of one row must match" and this file's own sha256 comment
      // claims they "are enough to prove two replicates sent identical bytes".
      // Nothing performed that proof. See the disagreement check below for the
      // sequence that makes it necessary.
      const cells = await readCells(
        reportRunId,
        "analysis_id,rep,status,shape,schema_era,raw_signal,raw_confidence,raw_stop,raw_tp1," +
          "raw_fundamental_score,missing_required_keys,input_tokens,output_tokens,cache_read_input_tokens," +
          "system_sha256,user_sha256,effort,max_tokens,tools_present,schema_in_prompt",
      );
      if (cells === null) {
        return json({ ok: false, mode: "report", errors, elapsedMs: elapsed(), version: FUNCTION_VERSION }, 500);
      }
      const totals = tallyCells(cells);

      // A cell for a row the frozen population does not contain is not this
      // experiment's cell, and pooling it would report a rate over a set nobody
      // declared.
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

      // TWO REPLICATES OF A ROW MUST HAVE SENT THE SAME REQUEST, and this is
      // where that is checked rather than asserted.
      //
      // prepareRow rebuilds the body from the stored prompt FRESH on every
      // invocation, and a row's two replicates routinely land in different
      // invocations: a hop boundary can fall between them, the wall clock cuts
      // mid-row, a guarded minute cuts mid-row, max_cells may be odd. The full
      // run is dozens of chained invocations over several hours. Between rep 1
      // and rep 2, shape.ts or prompt-surgery.ts can be redeployed, or the
      // stored text edited — analysis_prompts has no update trigger, and
      // created_at <= frozen_at pins the ROW SET, not the bytes.
      //
      // Two different requests pooled as two replicates of one is not a neutral
      // error. If the second build raises the effort, or moves the schema into
      // output_config, or changes the surgery, the later rows agree with
      // themselves MORE often and the pooled rate comes out LOW — the one
      // direction #65 cannot survive, because a floor that is too low lets #65
      // read real rulebook damage as noise.
      const factsByRow = new Map<string, string>();
      const factDisagreements = new Set<string>();
      for (const cell of cells) {
        if (cell.status === "claimed") continue;
        const analysisId = typeof cell.analysis_id === "string" ? cell.analysis_id.toLowerCase() : "";
        // A cell aborted before a request existed carries a placeholder shape
        // and an empty effort by design (see the cell loop), so it is not
        // evidence about any request and is not compared with one.
        if (cell.status === "aborted" && cell.effort === "") continue;
        const facts = [
          cell.system_sha256,
          cell.user_sha256,
          cell.effort,
          cell.max_tokens,
          cell.tools_present,
          cell.schema_in_prompt,
          cell.shape,
        ].join("|");
        const seen = factsByRow.get(analysisId);
        if (seen === undefined) factsByRow.set(analysisId, facts);
        else if (seen !== facts) factDisagreements.add(analysisId);
      }
      if (factDisagreements.size > 0) {
        errors.push(`request_disagreement_rows:${factDisagreements.size}`);
        return json({
          ok: false,
          mode: "report",
          run_id: reportRunId,
          report: { emitted: false, refusal: "replicates_of_a_row_sent_different_requests" },
          errors,
          elapsedMs: elapsed(),
          version: FUNCTION_VERSION,
        }, 409);
      }

      // The stratum is not stored on the cell, so it is rebuilt here from the
      // two facts that define it: analyses.preview, and the schema era already
      // recorded on the cell. Measured 2026-09-09 over the 48 joined rows:
      // preview = 4, v48 = 4, and their intersection is EMPTY — which is why
      // core is 40 and why the pre-registration insists both n=48 and n=40 are
      // printed (0/40 has a Wilson upper of 8.76% against an 8.8% break-even).
      // preview is tested first so the three strata stay a partition if a
      // future row ever manages to be both.
      const ids = [...new Set(cells.map((c) => (typeof c.analysis_id === "string" ? c.analysis_id.toLowerCase() : "")))]
        .filter(isUuid);
      const previewById = new Map<string, boolean>();
      for (let i = 0; i < ids.length; i += ID_CHUNK) {
        const rows = await readRowsOrNull(`analyses?id=in.(${ids.slice(i, i + ID_CHUNK).join(",")})&select=id,preview`);
        if (rows === null) {
          errors.push("read_failed:analyses");
          return json({ ok: false, mode: "report", errors, elapsedMs: elapsed(), version: FUNCTION_VERSION }, 500);
        }
        for (const row of rows) {
          if (typeof row.id === "string") previewById.set(row.id.toLowerCase(), row.preview === true);
        }
      }

      // 'claimed' IS NOT A CellStatus. metric.ts's vocabulary is the nine
      // finished values, and a claimed cell is a cell nobody has answered yet.
      // It is counted and surfaced as unfinished, and it is not handed to
      // report() and not coerced into anything — least of all into a failure,
      // which would let the completeness gate open over a run still in flight.
      // While any remain, completed + failed < expected and report() refuses
      // by itself; the count is on the response so the operator can see how
      // many and why.
      const reportCells: ReportCell[] = [];
      let unstratified = 0;
      for (const cell of cells) {
        const status = typeof cell.status === "string" ? cell.status : "";
        if (status === "claimed") continue;
        const analysisId = typeof cell.analysis_id === "string" ? cell.analysis_id.toLowerCase() : "";
        const preview = previewById.get(analysisId);
        if (preview === undefined) unstratified += 1;
        const stratum: Stratum = preview === true
          ? "preview"
          : cell.schema_era === "v48"
            ? "v48"
            : "core";
        const raw: RawAnswer | null = status === "ok" || status === "missing_keys"
          ? {
            signal: typeof cell.raw_signal === "string" ? cell.raw_signal : null,
            confidence: numberOrNull(cell.raw_confidence),
            stop: numberOrNull(cell.raw_stop),
            tp1: numberOrNull(cell.raw_tp1),
            fundamental_score: numberOrNull(cell.raw_fundamental_score),
            missingRequiredKeys: Array.isArray(cell.missing_required_keys)
              ? cell.missing_required_keys.filter((k): k is string => typeof k === "string")
              : [],
          }
          : null;
        reportCells.push({
          analysisId,
          rep: numberOrNull(cell.rep) ?? 0,
          status: status as CellStatus,
          raw,
          stratum,
          shape: typeof cell.shape === "string" ? cell.shape : "",
        });
      }
      // A cell whose row could not be read is a cell whose stratum was GUESSED,
      // and the guess is always `core` — the stratum the go/no-go turns on.
      // This used to be one string on an ok:true response printed beside a
      // rate. It is a refusal now, for the same reason the read_failed branch a
      // few lines up is one: 4 preview rows silently reclassified as core make
      // the denominator 44 instead of 40, and a larger denominator gives a
      // LOWER Wilson upper bound — 0/44 against the pre-registered 0/40 = 8.76%
      // on an 8.8% break-even. That is precisely the direction that makes a
      // failing go/no-go read as passable, so it must not be survivable.
      if (unstratified > 0) {
        errors.push(`stratum_unknown_cells:${unstratified}`);
        return json({
          ok: false,
          mode: "report",
          run_id: reportRunId,
          report: { emitted: false, refusal: "stratum_unknown_for_some_cells" },
          errors,
          elapsedMs: elapsed(),
          version: FUNCTION_VERSION,
        }, 409);
      }

      const rendered = report({
        // From the frozen id list, never from the column. See above.
        expectedCells: expectedFromPopulation,
        completedCells: totals.completed,
        failedCells: totals.failed,
        reps,
        cells: reportCells,
      });

      return json({
        ok: true,
        mode: "report",
        run_id: reportRunId,
        arm: run.arm,
        reps,
        expected_cells: expectedFromPopulation,
        completed_cells: totals.completed,
        failed_cells: totals.failed,
        unfinished_cells: totals.unfinished,
        spent_input_tokens: totals.spentInput,
        spent_output_tokens: totals.spentOutput,
        // Measured spend and unmeasurable spend are two numbers, printed as
        // two numbers. See tallyCells.
        unmeasured_cells: totals.unmeasured,
        bound_input_tokens_unmeasured: totals.boundInput,
        bound_output_tokens_unmeasured: totals.boundOutput,
        status: run.status,
        abort_reason: run.abort_reason ?? null,
        report: rendered,
        errors,
        elapsedMs: elapsed(),
        version: FUNCTION_VERSION,
      });
    }

    // =====================================================================
    // Shared setup for the dry and live paths
    // =====================================================================

    const requiredKeys = RESPONSE_SCHEMA.required as readonly string[];
    const anthropicHeaders = replayHeaders(anthropicKey);

    // Every outbound call to api.anthropic.com goes through this, on BOTH
    // paths. It used to live inside the live path only, which left the dry run
    // — 48 back-to-back count_tokens POSTs carrying 652,739 characters of
    // prompt, measured — firing as fast as the socket returned, possibly into
    // the same minute as the postmortem sweep on the same key. count_tokens is
    // not billed, so that was never a spend finding; it is a shared-key finding,
    // and the stated blast radius of this whole function is the shared key. Free
    // is not the same as harmless when the resource is shared.
    //
    // KNOWN LIMIT, stated rather than left to be discovered: lastCallAt is a
    // local of this handler. Spacing is therefore honoured WITHIN an invocation
    // and not across the boundary between a chain hop and its child, whose
    // first call can follow its parent's last by a fraction of a second. The
    // run-level lease below is what stops two workers from calling at the same
    // time; nothing makes the gap between two consecutive workers 2 s.
    // When the previous call FINISHED, not when it started. See
    // MIN_CALL_SPACING_MS for the measurement that forced this distinction.
    let lastCallEndedAt = 0;
    const spaceCalls = async () => {
      const since = Date.now() - lastCallEndedAt;
      if (lastCallEndedAt > 0 && since < MIN_CALL_SPACING_MS) {
        await sleep(MIN_CALL_SPACING_MS - since);
      }
    };
    // Called on every path out of a model call -- success, error, or throw --
    // because a call that failed still occupied the worker and still has to be
    // paid for in quiet time before the next one.
    const markCallEnded = () => {
      lastCallEndedAt = Date.now();
    };

    // Everything about one row that has to be settled before a request can be
    // built: which class it is, which shape that implies, which bytes go out,
    // and the digests of those bytes.
    interface PreparedRow {
      rowClass: RowClass;
      body: ReplayBody;
      systemSha: string;
      userSha: string;
      schemaEra: string;
      schemaInPrompt: boolean;
      shape: string;
    }

    // `rowArm` is passed in rather than closed over. A resumed hop takes its
    // arm from the RUN HEADER, never from the body — run_id is mutually
    // exclusive with `arm`, so the body's arm on a resume is the default
    // "search_free", and a fallback_surgery run continued by a hop that read
    // the default would send half its cells in the wrong shape and pool them
    // together as one arm.
    const prepareRow = async (row: PopulationRow, rowArm: Arm): Promise<PreparedRow | string> => {
      const classified = classifyRow({ user: row.user, system: row.system, mode: row.mode });
      if (isRefusal(classified)) return `row_refused:${classified.code}`;
      const typed: ClassifiedRow = classified;
      // already_fallback has no RowClass: the surgery has nothing to do to it
      // and the primary arm has no shape for it. Measured 2026-09-09, zero
      // technical_fallback rows have ever been written, so this refuses
      // nothing today and would refuse loudly the first time one appeared.
      if (typed.promptClass === "already_fallback") return "row_refused:already_fallback";
      const rowClass: RowClass = typed.promptClass;

      // The era is recomputed WITH the digest of the schema suffix, which is a
      // third hash over that slice alone — not either of the two whole-string
      // digests the cell carries. Handing one of those to detectSchemaEra
      // matches no entry and demotes the whole corpus to 'unknown'.
      const suffixSha = typed.schemaSuffix === null ? null : await sha256Hex(typed.schemaSuffix);
      const schemaEra = detectSchemaEra(typed.schemaSuffix, suffixSha);

      let userToSend = row.user;
      if (rowArm === "fallback_surgery") {
        const transformed = fallbackTransform(typed);
        if (isRefusal(transformed)) return `surgery_refused:${transformed.code}`;
        userToSend = transformed.user;
      }

      let body: ReplayBody;
      let shape: string;
      try {
        shape = replayShape({ arm: rowArm, rowClass });
        body = buildReplayRequest({ arm: rowArm, rowClass, model: row.model, system: row.system, user: userToSend });
      } catch (err) {
        const message = slice200(err);
        return message.startsWith(SHAPE_REFUSAL_PREFIX) ? message : `shape_error:${message}`;
      }

      // BOTH digests are taken from the BUILT BODY, which is the thing that
      // goes on the wire. The user digest used to be taken from `userToSend`,
      // the string handed to the builder, which is identical today because
      // buildReplayRequest copies both through — but the two were not sourced
      // symmetrically, and the report-mode check that now proves two replicates
      // sent the same bytes is only as good as the bytes these hash.
      const sentUser = body.messages[0]?.content ?? userToSend;
      const [systemSha, userSha] = await Promise.all([sha256Hex(body.system), sha256Hex(sentUser)]);
      return {
        rowClass,
        body,
        systemSha,
        userSha,
        schemaEra,
        // Asked of the bytes actually going out rather than derived from the
        // arm, because "what was sent" is the thing the column claims to say.
        schemaInPrompt: userToSend.includes(LOCALE[typed.locale].schemaMarker),
        shape,
      };
    };

    // =====================================================================
    // DRY RUN — count_tokens only, never /v1/messages
    // =====================================================================
    if (dryRun) {
      let runId: string;
      let frozenAt: string;
      let ids: string[];
      let notes: JsonRecord;
      // A resumed dry run keeps the arm and reps it was created with. The body
      // cannot restate them (run_id is mutually exclusive with both), so the
      // defaults would silently re-count a fallback_surgery run as search_free
      // and multiply the per-cell figure by the wrong reps.
      let dryArm: Arm = arm;
      let dryReps = repsRequested;

      if (isUuid(runIdIn)) {
        // Resuming a dry run that ran out of wall clock. Free to redo, but
        // redoing it as a NEW run would leave two dry runs over the same
        // population and let a later live run cite whichever one it liked.
        const existing = await readRun(runIdIn);
        if (existing === "read_failed") {
          errors.push("read_failed:noise_runs");
          return json({ ok: false, mode: "dry", errors, elapsedMs: elapsed(), version: FUNCTION_VERSION }, 500);
        }
        if (existing === null) return refuse("run_id names no run");
        if (existing.status !== "dry") return refuse("run_id names a run that is not a dry run");
        runId = runIdIn;
        frozenAt = typeof existing.population_frozen_at === "string" ? existing.population_frozen_at : "";
        notes = isRecord(existing.notes) ? existing.notes : {};
        const population = isRecord(notes.population) ? notes.population : {};
        ids = Array.isArray(population.ids) ? population.ids.filter(isUuid) : [];
        if (ids.length === 0 || frozenAt.length === 0) return refuse("the run header carries no frozen population");
        if (typeof existing.arm !== "string" || !ARMS.includes(existing.arm as Arm)) {
          return refuse("the run header carries no recognised arm");
        }
        dryArm = existing.arm as Arm;
        const headerReps = numberOrNull(existing.reps);
        if (headerReps === null || !Number.isInteger(headerReps)) return refuse("the run header carries no reps");
        dryReps = headerReps;
      } else {
        // POPULATION FREEZE. The cut is taken here, once, and written on the
        // header; every later hop of every run built on this one selects rows
        // created at or before it. Measured 2026-09-09: analysis_prompts held
        // 48 rows and had gained 22 in the trailing 24 hours (the migration
        // measured 23 a few hours earlier — the window moves, the order of
        // magnitude does not). A denominator moving by roughly half its own
        // size per day means an operator who reran until the answer looked
        // right would be choosing the answer, and nothing in the stored rows
        // would record that he had.
        frozenAt = nowIso;
        const frozen = await readFrozenIds(frozenAt);
        if (frozen === null) {
          return json({ ok: false, mode: "dry", errors, elapsedMs: elapsed(), version: FUNCTION_VERSION }, 500);
        }
        if (explicitIds === null) {
          ids = frozen;
        } else {
          const inPopulation = new Set(frozen);
          // Never silently dropped: a named row outside the frozen population
          // is a caller error about which experiment this is.
          const missing = explicitIds.filter((id) => !inPopulation.has(id));
          if (missing.length > 0) return refuse(`analysis_ids names rows outside the frozen population: ${missing.length}`);
          ids = frozen.filter((id) => inPopulation.has(id) && explicitIds!.includes(id));
        }
        if (ids.length === 0) return refuse("the frozen population is empty");

        const inserted = await insertRows("noise_runs", {
          population_frozen_at: frozenAt,
          arm: dryArm,
          reps: dryReps,
          expected_cells: ids.length * dryReps,
          // NOT NULL on both, and a dry run's honest budget is zero: it may not
          // spend, and the columns say what this run is allowed to spend rather
          // than what some later run might be.
          budget_input_tokens: 0,
          budget_output_tokens: 0,
          status: "dry",
          chain: false,
          chain_hops: 0,
          max_chain_hops: 0,
          version: FUNCTION_VERSION,
          notes: {
            population: { count: ids.length, sha256: await sha256Hex(ids.join(",")), ids, frozen_at: frozenAt },
            max_cells: maxCells,
            dry: { complete: false, rows_total: ids.length, per_row: [] },
          },
        });
        if (inserted === null || !isUuid(inserted[0]?.id)) {
          errors.push("insert_failed:noise_runs");
          return json({ ok: false, mode: "dry", errors, elapsedMs: elapsed(), version: FUNCTION_VERSION }, 500);
        }
        runId = inserted[0].id as string;
        notes = isRecord(inserted[0].notes) ? (inserted[0].notes as JsonRecord) : {};
      }

      const population = await readPopulationByIds(ids, frozenAt);
      if (population === null) {
        return json({ ok: false, mode: "dry", run_id: runId, errors, elapsedMs: elapsed(), version: FUNCTION_VERSION }, 500);
      }

      const dryNotes = isRecord(notes.dry) ? notes.dry : {};
      const perRow = new Map<string, number>();
      if (Array.isArray(dryNotes.per_row)) {
        for (const entry of dryNotes.per_row) {
          if (isRecord(entry) && typeof entry.analysis_id === "string") {
            const tokens = numberOrNull(entry.input_tokens);
            if (tokens !== null) perRow.set(entry.analysis_id.toLowerCase(), tokens);
          }
        }
      }

      // ONE count per ROW, not per cell, and the difference is not a shortcut.
      // Both replicates of a row send byte-identical strings — that is what the
      // two sha256 columns exist to prove — so a second count over the same
      // bytes measures nothing and spends wall clock this invocation may not
      // have. The per-cell figure is the row's count multiplied by reps, and
      // the multiplication is stated here rather than implied.
      let drySkipped: string | null = null;
      let dryAborted: string | null = null;
      for (const row of population) {
        if (perRow.has(row.analysisId)) continue;
        if (msLeftForWork() < 5_000) break;
        // THE SAME THREE CONTROLS THE LIVE PATH HAS. The dry run had none of
        // them, on the reasoning that count_tokens costs nothing — but the file
        // header's controls exist because the KEY is shared, not because the
        // calls are billed. A burst of 48 rejections against a rate-limited or
        // dead key is worse than one, and a 429 raised here lands on the same
        // limit a live user's analyse turn is drawing from.
        if (!(await waitOutCronMinute())) {
          drySkipped = "cron_minute";
          break;
        }
        const prepared = await prepareRow(row, dryArm);
        if (typeof prepared === "string") {
          errors.push(`${prepared}:${row.analysisId}`);
          continue;
        }
        // The same body minus max_tokens. output_config stays: the point of a
        // dry run is to count the tokens of the body that will ACTUALLY be
        // sent, and dropping a field to make the endpoint happy would produce
        // a number for a request nobody is going to make. If count_tokens
        // refuses the field, this run says so — for free, before a single
        // billable call — which is the cheapest possible place to find out.
        const countBody: JsonRecord = { ...prepared.body };
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
            // THE SAME ABORT CLASSES, and they stop the counting loop for the
            // same reason they stop the cell loop: a key that answered 401, 403
            // or 429 once will answer the next 47 requests the same way, and
            // hammering a shared rate limit is the thing that makes a live
            // user's analyse turn fail. The dry run is resumable by run_id, so
            // stopping costs nothing but a second POST.
            if (res.status === 401 || res.status === 403 || res.status === 429 || res.status >= 500) {
              dryAborted = `count_tokens_http_${res.status}`;
              break;
            }
            continue;
          }
          const counted = isRecord(parsed) ? numberOrNull(parsed.input_tokens) : null;
          if (counted === null) {
            errors.push(`count_tokens_unreadable:${row.analysisId}`);
            continue;
          }
          perRow.set(row.analysisId, counted);
        } catch (err) {
          // Same rule as the billable path: the quiet period is owed from the
          // end of the call, and a call that threw still held the socket.
          markCallEnded();
          errors.push(`count_tokens_failed:${slice200(err)}`);
        }
      }

      const rowsCounted = population.filter((row) => perRow.has(row.analysisId)).length;
      const complete = rowsCounted === population.length;
      const measuredInputTokens = population.reduce(
        (sum, row) => sum + (perRow.get(row.analysisId) ?? 0) * dryReps,
        0,
      );
      // A BOUND, and labelled one everywhere it is written. count_tokens
      // counts INPUT only; output is billed at the output rate for whatever
      // adaptive thinking produces, up to max_tokens. What can be measured
      // before the run is the input, exactly, and the output's ceiling. An
      // estimate reported as a measurement is how a cost note becomes a
      // surprise.
      const boundOutputTokens = MAX_TOKENS * population.length * dryReps;

      const patched = await patchRows(`noise_runs?id=eq.${runId}`, {
        notes: {
          ...notes,
          dry: {
            complete,
            rows_total: population.length,
            rows_counted: rowsCounted,
            reps: dryReps,
            measured_input_tokens: measuredInputTokens,
            bound_output_tokens: boundOutputTokens,
            per_row: population
              .filter((row) => perRow.has(row.analysisId))
              .map((row) => ({ analysis_id: row.analysisId, input_tokens: perRow.get(row.analysisId) })),
          },
        },
      });
      if (patched === null) errors.push("patch_failed:noise_runs_notes");
      if (dryAborted !== null) errors.push(dryAborted);

      console.log("noise-floor dry run", {
        run_id: runId,
        rows_counted: rowsCounted,
        complete,
        skipped: drySkipped ?? "",
        errors: errors.length,
      });

      return json({
        ok: complete && errors.length === 0,
        mode: "dry",
        run_id: runId,
        arm: dryArm,
        reps: dryReps,
        expected_cells: population.length * dryReps,
        completed_cells: 0,
        failed_cells: 0,
        unfinished_cells: 0,
        cells_this_invocation: 0,
        spent_input_tokens: 0,
        spent_output_tokens: 0,
        rows_counted: rowsCounted,
        rows_total: population.length,
        measured_input_tokens: measuredInputTokens,
        bound_output_tokens: boundOutputTokens,
        status: "dry",
        abort_reason: dryAborted,
        skipped: drySkipped,
        chained: false,
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
        errors.push("read_failed:noise_runs");
        return json({ ok: false, mode: "run", errors, elapsedMs: elapsed(), version: FUNCTION_VERSION }, 500);
      }
      if (existing === null) return refuse("run_id names no run");
      if (existing.status === "dry") return refuse("run_id names a dry run; create a live run with dry_run_id");
      run = existing;
    } else {
      // THERE IS NO RUN WITHOUT A DRY RUN FIRST. The dry run is free, it is
      // the only thing that produces a measured input-token figure, and the
      // two budgets below are meant to be chosen from that figure — so a live
      // run created without one would be a run whose cost nobody had looked at.
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
        errors.push("read_failed:noise_runs");
        return json({ ok: false, mode: "run", errors, elapsedMs: elapsed(), version: FUNCTION_VERSION }, 500);
      }
      if (dry === null) return refuse("dry_run_id names no run");
      if (dry.status !== "dry") return refuse("dry_run_id does not name a dry run");
      const dryNotes = isRecord(dry.notes) ? dry.notes : {};
      const dryDetail = isRecord(dryNotes.dry) ? dryNotes.dry : {};
      if (dryDetail.complete !== true) return refuse("the dry run did not finish counting its population");
      if (dry.arm !== arm) return refuse("the dry run was over a different arm");
      // reps too, and not out of tidiness: the operator chose the two budgets
      // from bound_output_tokens = max_tokens x rows x reps, so a live run at a
      // different reps is a run against a bound that was never computed for it.
      if ((numberOrNull(dry.reps) ?? 0) !== repsRequested) return refuse("the dry run was over a different reps");

      // THE BUDGETS ARE COMPARED WITH THE DRY RUN THAT EXISTS TO SIZE THEM.
      // Until now the only checks on them were "integer" and "> 0", while the
      // two numbers they are supposed to be chosen from — measured_input_tokens
      // and bound_output_tokens — were sitting in the same notes object this
      // code already reads for `complete`, `arm` and `reps`. docs/OPERATIONS.md
      // says the operator picks the budgets from them; nothing made him.
      // One extra zero in a psql heredoc authorised an order of magnitude, and
      // the budget is the LAST control between this function and the key that
      // took the live app down on 2026-09-08. Both measured numbers go into the
      // refusal text, so an operator who is refused is told what he was compared
      // against rather than left to guess.
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

      // ONE LIVE RUN PER DRY RUN. Every check above this line interrogates the
      // DRY run, and not one of them is consumed by being used: two POSTs with
      // the same body pass all of them twice and create two `running` runs, each
      // with its own run_id, so the (run_id, analysis_id, rep) claim — which
      // correctly stops two INVOCATIONS of one run — does not collide. Each run
      // is inside its own budget, so budgetCrossed never objects. The operator
      // authorised one budget and paid two, on the key whose exhaustion is
      // user-visible.
      //
      // This is not a hypothetical sequence. The documented invocation
      // (docs/OPERATIONS.md §5.2) is `select net.http_post(...)`, which is
      // asynchronous: it returns a request id immediately and the body only
      // appears in net._http_response when the function finishes, up to 130 s
      // later. That 130-second window in which the operator has no evidence the
      // run exists is exactly the window in which the statement gets run again.
      //
      // LIMIT, stated because it cannot be closed from here: this is a read
      // followed by a write, so two POSTs landing inside the same few hundred
      // milliseconds can both read "none" and both insert. The durable form is a
      // partial unique index on (notes->>'dry_run_id') where status in
      // ('running','paused'), which belongs in a migration; the migration for
      // these tables is written and unapplied, so the index is a follow-up
      // rather than something this file can do. The check below closes the
      // human-timescale repeat, which is the one the operator's SQL prompt
      // actually produces.
      const alreadySpent = await readRowsOrNull(
        `noise_runs?status=in.(running,paused,done,aborted)` +
          `&notes->>dry_run_id=eq.${dryRunIdIn}&select=id,status&limit=5`,
      );
      if (alreadySpent === null) {
        errors.push("read_failed:noise_runs");
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
      const dryFrozenAt = typeof dry.population_frozen_at === "string" ? dry.population_frozen_at : "";
      if (dryIds.length === 0 || dryFrozenAt.length === 0) return refuse("the dry run carries no frozen population");

      // The live run INHERITS the freeze rather than taking a new one. A new
      // cut would be a different population — 22 rows arrived in the trailing
      // 24 hours, measured — and "the same population" is the whole of what
      // makes the dry run's number the cost of THIS run.
      //
      // A named subset of the dry run's rows is allowed, and that is how the
      // pilot is meant to be fired: the dry run measured every one of those
      // rows' input tokens, which is the thing a dry run exists to establish,
      // and the row set actually run is written into this run's own notes so
      // nothing has to be inferred from the dry run later. Rows the dry run
      // never counted are refused outright.
      let ids = dryIds;
      if (explicitIds !== null) {
        const inDry = new Set(dryIds);
        const missing = explicitIds.filter((id) => !inDry.has(id));
        if (missing.length > 0) return refuse("analysis_ids names rows the dry run did not cover");
        ids = dryIds.filter((id) => explicitIds!.includes(id));
      }
      const sha = await sha256Hex(ids.join(","));
      // On the whole-population path the digest must be there AND match. An
      // absent digest read as "no check to do" would let a hand-edited notes
      // blob choose the population the budgets were never sized for.
      if (explicitIds === null && dryPopulation.sha256 !== sha) {
        return refuse("the dry run's population digest does not match its id list");
      }

      const expected = ids.length * repsRequested;

      // The worst-case input cost of ONE call, taken from the dry run's own
      // per-row counts. It is what a cell whose usage never came back is
      // charged as a bound (see tallyCells). The MAXIMUM rather than the mean,
      // because a bound that is sometimes below the truth is not a bound.
      let maxRowInput = 0;
      if (Array.isArray(dryDetail.per_row)) {
        for (const entry of dryDetail.per_row) {
          if (!isRecord(entry)) continue;
          const tokens = numberOrNull(entry.input_tokens);
          if (tokens !== null && tokens > maxRowInput) maxRowInput = tokens;
        }
      }

      // HOPS, sized from what a hop can really do rather than from max_cells.
      // MIN_CELL_START_MS is now above the measured p90 of a call, so at 130 s
      // of wall clock less the 10 s write reserve a hop starts one cell in the
      // common case whatever max_cells says. Sizing the budget on max_cells
      // would have halved it, and a run that runs out of hops stops with cells
      // unclaimed. Both numbers come from the constants above, so raising the
      // cell floor cannot silently strand a run.
      const cellsPerHop = Math.max(
        1,
        Math.min(maxCells, Math.floor((WALL_CLOCK_BUDGET_MS - WRITE_RESERVE_MS) / MIN_CELL_START_MS)),
      );
      // Nine of sixty minutes are refused, and a hop that lands in one now waits
      // it out instead of spending itself — so at most one hop per guarded
      // minute is lost, which is the arithmetic 60/51 pays for.
      const maxChainHops =
        Math.ceil((expected / cellsPerHop) * (MINUTES_PER_HOUR / USABLE_MINUTES_PER_HOUR)) + CHAIN_HOP_SLACK;

      const inserted = await insertRows("noise_runs", {
        population_frozen_at: dryFrozenAt,
        arm,
        reps: repsRequested,
        expected_cells: expected,
        budget_input_tokens: budgetIn,
        budget_output_tokens: budgetOut,
        status: "running",
        chain,
        chain_hops: 0,
        // Enough hops to finish, computed above. A run that exhausts its hops
        // stops VISIBLY with cells remaining — the reporting gate stays shut
        // and the operator re-POSTs with run_id, or raises max_chain_hops with
        // one UPDATE. Stopping early is the safe direction; a chain that
        // refuses to end is not.
        max_chain_hops: maxChainHops,
        version: FUNCTION_VERSION,
        notes: {
          population: { count: ids.length, sha256: sha, ids, frozen_at: dryFrozenAt },
          max_cells: maxCells,
          dry_run_id: dryRunIdIn,
          // Already expired, so the first invocation takes it. See the lease
          // block below for what it is for.
          lease_until: LEASE_EPOCH,
          unmeasured_cell_input_bound: maxRowInput,
          budget_ceilings: { input: inputCeiling, output: outputCeiling },
        },
      });
      if (inserted === null || !isUuid(inserted[0]?.id)) {
        errors.push("insert_failed:noise_runs");
        return json({ ok: false, mode: "run", errors, elapsedMs: elapsed(), version: FUNCTION_VERSION }, 500);
      }
      run = inserted[0];
    }

    const runId = String(run.id);
    const reps = numberOrNull(run.reps) ?? 0;
    const runArm = typeof run.arm === "string" ? (run.arm as Arm) : arm;
    const expectedCells = numberOrNull(run.expected_cells) ?? 0;
    const budgetInput = numberOrNull(run.budget_input_tokens) ?? 0;
    const budgetOutput = numberOrNull(run.budget_output_tokens) ?? 0;
    const runNotes = isRecord(run.notes) ? run.notes : {};
    const runPopulation = isRecord(runNotes.population) ? runNotes.population : {};
    const runIds = Array.isArray(runPopulation.ids) ? runPopulation.ids.filter(isUuid) : [];
    const frozenAt = typeof run.population_frozen_at === "string" ? run.population_frozen_at : "";
    // The cap in force for this run's hops is the one recorded at creation, so
    // a resumed hop cannot quietly widen it by asking for a bigger max_cells.
    const runMaxCells = Math.min(maxCells, numberOrNull(runNotes.max_cells) ?? maxCells);
    unmeasuredCellInputBound = numberOrNull(runNotes.unmeasured_cell_input_bound) ?? 0;

    let status = typeof run.status === "string" ? run.status : "running";
    let abortReason = typeof run.abort_reason === "string" ? run.abort_reason : null;
    let skipped: string | null = null;
    let cellsThisInvocation = 0;
    let chained = false;

    const summarize = (totals: RunTotals | null, ok: boolean) => ({
      ok,
      mode: "run",
      run_id: runId,
      arm: runArm,
      reps,
      expected_cells: expectedCells,
      completed_cells: totals?.completed ?? 0,
      failed_cells: totals?.failed ?? 0,
      unfinished_cells: totals?.unfinished ?? 0,
      cells_this_invocation: cellsThisInvocation,
      spent_input_tokens: totals?.spentInput ?? 0,
      spent_output_tokens: totals?.spentOutput ?? 0,
      // What was billed but could not be observed, and its worst case. Two
      // numbers, not folded into the two above. See tallyCells.
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

    // THE KILL SWITCH, read before anything is spent. An operator stops a
    // chained run with one UPDATE to 'paused' and the next hop sees it here.
    if (status === "paused") {
      skipped = "paused";
      const totals = await reconcile(runId);
      return json(summarize(totals, true));
    }
    if (status !== "running") {
      const totals = await reconcile(runId);
      return json(summarize(totals, true));
    }

    if (runIds.length === 0 || frozenAt.length === 0) {
      errors.push("run_population_missing");
      return json(summarize(null, false), 500);
    }

    const population = await readPopulationByIds(runIds, frozenAt);
    if (population === null) return json(summarize(null, false), 500);

    let totals = await reconcile(runId);
    if (totals === null) return json(summarize(null, false), 500);

    // The claimed set. A cell that already exists — finished or still claimed —
    // belongs to some other invocation, and this one does not touch it. There
    // is deliberately NO re-claim of a stale claimed cell: the counters above
    // are recomputed from rows, so a re-claim would be safe for the arithmetic,
    // but a cell claimed and abandoned is a cell whose model call may have been
    // paid for and whose answer is gone, and re-running it silently would spend
    // twice for one replicate while the record showed one. A stalled run stays
    // visibly stalled, the reporting gate stays shut, and an operator who wants
    // it retried deletes that row by hand (docs/OPERATIONS.md).
    const claimed = new Set<string>();
    for (const cell of totals.cells) {
      if (typeof cell.analysis_id === "string" && numberOrNull(cell.rep) !== null) {
        claimed.add(`${cell.analysis_id.toLowerCase()}#${cell.rep}`);
      }
    }
    const pending: PendingCell[] = [];
    for (const row of population) {
      for (let rep = 1; rep <= reps; rep++) {
        if (!claimed.has(`${row.analysisId}#${rep}`)) pending.push({ row, rep });
      }
    }

    // What the row's already-claimed replicate said it sent. The cell loop
    // compares a freshly built request against it and refuses to buy a cell
    // that would not be a replicate of its sibling. Report mode makes the same
    // comparison over the finished run; this one is the cheap, early half of
    // it, and it is the half that saves the money.
    const siblingFacts = new Map<string, string>();
    for (const cell of totals.cells) {
      if (typeof cell.analysis_id !== "string") continue;
      if (cell.status === "aborted" && cell.effort === "") continue;
      if (typeof cell.system_sha256 !== "string") continue;
      siblingFacts.set(
        cell.analysis_id.toLowerCase(),
        [
          cell.system_sha256,
          cell.user_sha256,
          cell.effort,
          cell.max_tokens,
          cell.tools_present,
          cell.schema_in_prompt,
          cell.shape,
        ].join("|"),
      );
    }

    if (pending.length === 0) {
      // Nothing left to CLAIM is not the same fact as nothing left to FINISH.
      // `pending` excludes cells that are already claimed, so a run whose last
      // cells were claimed by a worker that then died reaches here with an
      // empty pending list and used to be marked `done` — a partial run
      // readable as a complete one, which is the exact thing the two-table
      // design exists to prevent, and the negation of the status vocabulary
      // docs/OPERATIONS.md publishes. No false rate escaped (report() gates on
      // the counts, not on the status), but the operator's progress query said
      // finished, and the documented repair — delete the stale cell, re-POST
      // with run_id — then hit the `status !== "running"` early return and did
      // nothing at all.
      //
      // So it is gated on the same arithmetic as its sibling at the close-out
      // below: done means the cells are accounted for.
      if (totals.completed + totals.failed >= expectedCells) {
        const patched = await patchRows(`noise_runs?id=eq.${runId}&status=eq.running`, { status: "done" });
        if (patched === null) errors.push("patch_failed:noise_runs_done");
        else if (patched.length > 0) status = "done";
      } else {
        errors.push(`unfinished_cells_block_done:${totals.unfinished}`);
      }
      return json(summarize(totals, true));
    }

    // ---- the run-level lease ---------------------------------------------
    //
    // The pre-registration and docs/OPERATIONS.md both say this harness is
    // strictly serial and never concurrent. Until this block that was true
    // inside one invocation and nowhere else: MIN_CALL_SPACING_MS is enforced
    // against `lastCallAt`, a local of this handler, so an operator POSTing
    // run_id while a chain hop is in flight — or POSTing again because
    // net._http_response is still empty 130 s later — put two workers on the
    // shared Anthropic key with no spacing between them at all. The per-cell
    // claim stops them paying twice for one replicate, which is correctness,
    // not concurrency; it does not stop two simultaneous calls, and a 429
    // raised by them aborts this run AND is visible to a live user.
    //
    // The lease is one conditional PATCH, the same idiom the chain hop uses:
    // the row is matched on a lease that has expired, so exactly one of two
    // racing workers gets a row back. It lives in notes because the column it
    // would prefer does not exist and the migration is not this task's to
    // change. Zero rows back means somebody else holds the run, and this
    // invocation returns having spent nothing.
    //
    // WHAT WAS AND WAS NOT VERIFIED. The comparison's semantics were checked
    // against production on 2026-09-09: `notes->>'lease_until'` on the epoch
    // value below is < now (true), an absent key yields NULL, and a comparison
    // against NULL is NULL — which is why the second attempt below exists. The
    // PostgREST spelling of the filter could not be exercised end to end from
    // where this was written (no egress to the REST endpoint), so if it is
    // wrong the first invocation answers 500 with patch_failed:noise_runs_lease
    // and NOTHING IS SPENT. That is the correct direction to be wrong in, and
    // docs/OPERATIONS.md names the symptom so it is diagnosed rather than
    // puzzled over.
    const leaseUntil = new Date(Date.now() + LEASE_MS).toISOString();
    const leased = await patchRows(
      `noise_runs?id=eq.${runId}&status=eq.running` +
        `&notes->>lease_until=lt.${encodeURIComponent(nowIso)}`,
      { notes: { ...runNotes, lease_until: leaseUntil } },
    );
    if (leased === null) {
      errors.push("patch_failed:noise_runs_lease");
      return json(summarize(totals, false), 500);
    }
    // A run created before the lease field existed carries no lease_until at
    // all, and `->>` on an absent key is NULL, which no comparison matches — so
    // without this second attempt such a run would read as permanently locked.
    // It is a separate simple filter rather than an `or=(...)` because an `or`
    // needs the ISO timestamp quoted against its own dots and colons, and a
    // filter this file cannot be sure it spelled right fails closed on a path
    // where failing closed means the harness never runs at all.
    let acquired = leased.length > 0;
    if (!acquired) {
      const legacy = await patchRows(
        `noise_runs?id=eq.${runId}&status=eq.running&notes->>lease_until=is.null`,
        { notes: { ...runNotes, lease_until: leaseUntil } },
      );
      if (legacy === null) {
        errors.push("patch_failed:noise_runs_lease");
        return json(summarize(totals, false), 500);
      }
      acquired = legacy.length > 0;
    }
    if (!acquired) {
      // Held by another worker, or by a worker that died less than LEASE_MS
      // ago. Either way the safe answer is to spend nothing and say so: a run
      // that is one hop behind is recoverable, two concurrent calls on the
      // shared key are not.
      skipped = "locked";
      return json(summarize(totals, true));
    }
    // Handing the lease back before the chain fires, so the child is not locked
    // out by its own parent. The one path that returns between here and there
    // is a reconcile failure inside the cell loop, and leaving the lease held
    // for its remaining seconds is the right behaviour there: a run whose
    // counters could not be written is a run nothing should be spending on.
    const releaseLease = async () => {
      const released = await patchRows(`noise_runs?id=eq.${runId}`, {
        notes: { ...runNotes, lease_until: LEASE_EPOCH },
      });
      if (released === null) errors.push("patch_failed:noise_runs_lease_release");
    };

    // ---- budget, checked before the first call and after every response ----
    // MEASURED SPEND PLUS THE BOUND ON THE SPEND THAT COULD NOT BE MEASURED.
    // The columns keep the measurement (tallyCells says why); the control has
    // to act on the worst case, or a run whose calls all time out passes every
    // budget check ever made while billing the full population.
    const budgetCrossed = (t: RunTotals): string | null => {
      if (t.spentInput + t.boundInput >= budgetInput) return "budget_input_exhausted";
      if (t.spentOutput + t.boundOutput >= budgetOutput) return "budget_output_exhausted";
      return null;
    };
    const stopForBudget = async (reason: string) => {
      abortReason = reason;
      status = "aborted";
      // Conditional on 'running', like every other status write in this file.
      // Unconditional, it would overwrite the kill switch: an operator who
      // paused a run mid-cell and then saw the budget cross would find his
      // 'paused' silently rewritten to 'aborted', and the two mean different
      // things to the resume recipe in docs/OPERATIONS.md.
      const patched = await patchRows(
        `noise_runs?id=eq.${runId}&status=eq.running`,
        { status: "aborted", abort_reason: reason },
      );
      if (patched === null) errors.push("patch_failed:noise_runs_abort");
      skipped = "budget";
    };

    const crossed = budgetCrossed(totals);
    if (crossed) {
      await stopForBudget(crossed);
      // Handed back on the way out. The run is aborted and nothing should be
      // spending on it, but an operator who raises the budget and sets the
      // status back to 'running' should not then wait out a lease held by an
      // invocation that did nothing.
      await releaseLease();
      return json(summarize(totals, true));
    }

    // ---- the model call ---------------------------------------------------
    //
    // `headroom` is what is left of each budget before this cell starts. The
    // pause loop consults it between continuations, because max_cells counts
    // CELLS and the loop below can make up to PAUSE_ATTEMPTS billed calls
    // inside one of them, each resending a conversation that has grown by every
    // prior assistant block. At max_cells 4 the per-invocation ceiling the
    // design states as "4" was up to 20 billed calls with no budget check
    // between them. Reachable only on the search_on arm — shape.ts attaches
    // `tools` on that arm alone, and pause_turn is a server-tool signal — but a
    // funded path with a cost control that does not apply to it is a funded
    // path with no cost control.
    const callModel = async (
      body: ReplayBody,
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
      let messages: unknown[] = [...body.messages];

      for (let attempt = 0; attempt < PAUSE_ATTEMPTS; attempt++) {
        const left = deadline - Date.now();
        if (left <= 0) {
          outcome.transportError = "deadline";
          return outcome;
        }
        // SERIAL, ALWAYS, and never closer together than MIN_CALL_SPACING_MS.
        // The pause continuations count: they are calls on the same shared key
        // as a live user's analysis.
        await spaceCalls();

        // Both declared out here and initialised, so that the narrow try below
        // is the only thing the compiler has to reason about.
        let res: Response | null = null;
        let raw = "";
        // THE BODY READ IS INSIDE THE TRY, and it was the one unguarded body
        // read in this file while the other five all carry a .catch(). It
        // matters because AbortSignal.timeout aborts the response STREAM, not
        // just the connect: headers can arrive and the signal then fire during
        // res.text(), which rejects. A truncated body from the proxy does the
        // same. Unguarded, that throw escaped callModel, escaped the cell loop
        // and landed in the outer catch as a generic 500 — leaving the cell
        // 'claimed' forever (a claimed cell is never re-claimed, by design), so
        // its row could never get its pair and report() refused the WHOLE run
        // as partial until an operator deleted the row by hand; leaving the
        // billed usage of that call unwritten, so the header under-reported the
        // spend; and skipping both the reconcile and the chain block, so a
        // chained run stopped dead with no abort_reason. Inside the try it is
        // an ordinary transport failure and the cell lands as 'timeout'.
        try {
          res = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: anthropicHeaders,
            body: JSON.stringify({ ...body, messages }),
            signal: AbortSignal.timeout(Math.max(1_000, deadline - Date.now())),
          });
          outcome.httpStatus = res.status;
          outcome.requestId = res.headers.get("request-id");
          raw = await res.text();
          markCallEnded();
        } catch (err) {
          // The call is over whether or not it answered, and the quiet period
          // is owed from here either way: a failed call held the worker and
          // drew on the shared key exactly like a successful one.
          markCallEnded();
          // AbortSignal.timeout rejects with TimeoutError; anything else is a
          // transport failure. Neither is retried here: a retry inside the cell
          // would spend again on a key whose failures are user-visible, and the
          // cell is allowed to land as 'timeout' and be excluded from both the
          // numerator and the denominator.
          outcome.transportError = err instanceof DOMException && err.name === "TimeoutError"
            ? "timeout"
            : slice200(err);
          return outcome;
        }
        if (res === null) {
          // Unreachable: the try either assigns res or returns. Written as a
          // refusal rather than a `!` because a non-null assertion here would
          // be a claim about control flow that a later edit could quietly make
          // false, and the cost of being wrong is an exception in the cell loop.
          outcome.transportError = "no_response";
          return outcome;
        }

        const parsed = (() => {
          try {
            return JSON.parse(raw);
          } catch {
            return null;
          }
        })();
        outcome.parsed = parsed;

        if (!res.ok) {
          outcome.errorMessage = isRecord(parsed) && isRecord(parsed.error) && typeof parsed.error.message === "string"
            ? parsed.error.message
            : "";
          // ABORT, NEVER RETRY. A 401 or 403 means the key is not going to
          // work on the next call either; a 429 means a replay is competing
          // with a live analyse turn for the same rate limit, and backing off
          // and trying again is precisely the thing that makes the user's call
          // fail; and a credit-balance 400 is what took analyze and postmortem
          // down together on 2026-09-08, visible to the user in the live app.
          // `retry-after` and the anthropic-ratelimit-* headers are read for
          // the record only — nothing here waits on them.
          if (res.status === 401) outcome.abortReason = "http_401";
          else if (res.status === 403) outcome.abortReason = "http_403";
          else if (res.status === 429) {
            outcome.abortReason = `http_429 retry_after=${res.headers.get("retry-after") ?? "?"} ` +
              `remaining=${res.headers.get("anthropic-ratelimit-requests-remaining") ?? "?"}`;
          } else if (res.status === 400 && /credit balance is too low/i.test(outcome.errorMessage)) {
            outcome.abortReason = "credit_balance_too_low";
          } else if (res.status === 402) {
            // The billing status proper. The 400-with-a-substring above is the
            // shape observed on 2026-09-08; it is not the only shape the API
            // uses for the same fact, and matching only the observed one leaves
            // the run marching through its whole population against a key that
            // cannot pay for it.
            outcome.abortReason = "http_402_billing";
          } else if (res.status >= 500) {
            // 529 overloaded, and every other 5xx. Documented as retryable, and
            // this harness's rule is abort-never-retry — an overloaded shared
            // key is the paradigm case for it, because the same key is failing
            // for the live analyse path at that moment, and that path consumes
            // a user's quota BEFORE it calls the model. Marching on at 2 s
            // spacing would be a load test aimed at an outage.
            outcome.abortReason = `http_${res.status}`;
          }
          return outcome;
        }

        if (!isRecord(parsed)) {
          outcome.errorMessage = "response was not an object";
          return outcome;
        }

        outcome.stopReason = typeof parsed.stop_reason === "string" ? parsed.stop_reason : null;
        outcome.stopDetails = parsed.stop_details ?? null;
        outcome.responseModel = typeof parsed.model === "string" ? parsed.model : null;
        // ACCUMULATED ACROSS THE PAUSE LOOP, not overwritten by the last
        // response. Every continuation of a paused turn is its own billed
        // call, and a cell that paused four times and answered on the fifth
        // would otherwise record the fifth response's usage as the whole cost
        // of the cell. The header's spend is recomputed from these columns, so
        // an overwrite here is money the budget never sees. A null stays null
        // when no usage was ever reported: absent is not zero.
        if (isRecord(parsed.usage)) {
          outcome.inputTokens = addUsage(outcome.inputTokens, numberOrNull(parsed.usage.input_tokens));
          outcome.outputTokens = addUsage(outcome.outputTokens, numberOrNull(parsed.usage.output_tokens));
          outcome.cacheReadTokens = addUsage(
            outcome.cacheReadTokens,
            numberOrNull(parsed.usage.cache_read_input_tokens),
          );
          outcome.cacheCreationTokens = addUsage(
            outcome.cacheCreationTokens,
            numberOrNull(parsed.usage.cache_creation_input_tokens),
          );
          if (isRecord(parsed.usage.server_tool_use)) {
            outcome.webSearchRequests = addUsage(
              outcome.webSearchRequests,
              numberOrNull(parsed.usage.server_tool_use.web_search_requests),
            );
          }
        }

        // Production's own continuation: echo the assistant content back and
        // re-ask. A server-tool failure arrives HTTP 200 with `content` as an
        // OBJECT rather than a list, so the shape is checked before it is
        // indexed; that response falls through and is classified on its
        // stop_reason like any other.
        if (parsed.stop_reason === "pause_turn" && Array.isArray(parsed.content)) {
          // The budget, asked BETWEEN continuations. reconcile only runs after
          // a whole cell, so without this the loop could spend four more billed
          // calls past a budget that had already been crossed.
          if ((outcome.inputTokens ?? 0) >= headroom.input || (outcome.outputTokens ?? 0) >= headroom.output) {
            outcome.abortReason = "budget_crossed_mid_cell";
            return outcome;
          }
          messages = [...messages, { role: "assistant", content: parsed.content }];
          outcome.pauseContinuations += 1;
          if (attempt === PAUSE_ATTEMPTS - 1) outcome.pauseExhausted = true;
          continue;
        }
        return outcome;
      }
      outcome.pauseExhausted = true;
      return outcome;
    };

    // The shape an arm sends on a search-derived row, which is every arm's
    // own primary shape. Used only to fill the NOT NULL column on a cell that
    // was refused before a request existed; replayShape refuses an arm it does
    // not know, and a cell that cannot even be labelled falls back to the
    // primary arm's shape rather than failing the claim — losing the claim
    // would lose the evidence that the row was refused at all.
    const nominalShape = (a: Arm): string => {
      try {
        return replayShape({ arm: a, rowClass: "search_derived" });
      } catch {
        return "search_free_inline";
      }
    };

    // The claim. Returns the new cell's id, "taken" when another invocation
    // owns it, or null when the write itself failed.
    const claimCell = async (
      cell: PendingCell,
      shapeFacts: {
        shape: string;
        effort: string;
        maxTokens: number;
        toolsPresent: boolean;
        schemaInPrompt: boolean;
        schemaEra: string;
        systemSha: string;
        userSha: string;
      },
    ): Promise<string | "taken" | null> => {
      const rows = await insertRows(
        "noise_cells?on_conflict=run_id,analysis_id,rep",
        {
          run_id: runId,
          analysis_id: cell.row.analysisId,
          rep: cell.rep,
          // status is left to the column default of 'claimed'. Naming one of
          // the nine finished values here would be naming a lie about a cell
          // nobody has answered yet, and the only one of the nine that reads
          // as data is 'ok'.
          shape: shapeFacts.shape,
          effort: shapeFacts.effort,
          max_tokens: shapeFacts.maxTokens,
          tools_present: shapeFacts.toolsPresent,
          schema_in_prompt: shapeFacts.schemaInPrompt,
          schema_era: shapeFacts.schemaEra,
          system_sha256: shapeFacts.systemSha,
          user_sha256: shapeFacts.userSha,
        },
        "resolution=ignore-duplicates,return=representation",
      );
      if (rows === null) return null;
      if (rows.length === 0) return "taken";
      const id = rows[0].id;
      return typeof id === "string" ? id : null;
    };

    // ---- the cell loop ----------------------------------------------------
    for (const cell of pending) {
      if (cellsThisInvocation >= runMaxCells) break;

      // CRON-MINUTE GUARD, asked again before every cell because an invocation
      // spans minutes. It WAITS the minute out rather than returning from
      // inside it — see waitOutCronMinute for the burst that behaviour caused
      // and why waiting is what the hop arithmetic always assumed happened.
      const wasGuardedMinute = !windowIsClear(Date.now());
      if (!(await waitOutCronMinute())) {
        if (cellsThisInvocation === 0) skipped = "cron_minute";
        break;
      }
      // The wait succeeded but ate most of the invocation's clock, which is the
      // ordinary case for a hop that started early in a guarded minute. Say
      // "cron_minute" rather than let the wall-clock guard below report nothing
      // at all: an operator reading a hop that did no work is owed the reason.
      if (wasGuardedMinute && cellsThisInvocation === 0 && msLeftForWork() < MIN_CELL_START_MS) {
        skipped = "cron_minute";
        break;
      }

      // WALL CLOCK. Stop starting cells when what is left cannot fit one.
      const left = msLeftForWork();
      if (left < MIN_CELL_START_MS) break;
      const callTimeout = Math.min(LLM_TIMEOUT_MS, left);

      const prepared = await prepareRow(cell.row, runArm);
      if (typeof prepared === "string") {
        // A row that cannot be classified, transformed or built is not sent —
        // but it is still CLAIMED and closed, because expected_cells counts it
        // and a run that can never reach expected can never be reported. It
        // lands as 'aborted' with the reason in error_slice: see the write
        // below for why that status carries three different meanings and why
        // none of them is 'ok'.
        // `shape` is NOT NULL and checked against three values, so a row that
        // never reached a shape still has to write one. What goes in is the
        // ARM's nominal shape, and it is not evidence about a request: `status`
        // is 'aborted' and `error_slice` says no request was made. `effort` is
        // written empty for the same reason — there was no output_config,
        // and inventing "low" would put a request that never happened into the
        // one column a reader would use to check what did.
        const claimedRow = await claimCell(cell, {
          shape: nominalShape(runArm),
          effort: "",
          maxTokens: MAX_TOKENS,
          toolsPresent: false,
          schemaInPrompt: false,
          schemaEra: "unknown",
          systemSha: await sha256Hex(cell.row.system),
          userSha: await sha256Hex(cell.row.user),
        });
        if (claimedRow === null) {
          errors.push(`claim_failed:${cell.row.analysisId}#${cell.rep}`);
          break;
        }
        if (claimedRow === "taken") continue;
        const patched = await patchRows(`noise_cells?id=eq.${claimedRow}`, {
          status: "aborted",
          finished_at: new Date().toISOString(),
          error_slice: prepared.slice(0, 200),
        });
        if (patched === null) errors.push(`patch_failed:cell:${cell.row.analysisId}#${cell.rep}`);
        errors.push(`${prepared}:${cell.row.analysisId}`);
        cellsThisInvocation += 1;
        continue;
      }

      const shapeFacts = {
        shape: prepared.shape,
        effort: prepared.body.output_config.effort,
        maxTokens: prepared.body.max_tokens,
        toolsPresent: "tools" in prepared.body,
        schemaInPrompt: prepared.schemaInPrompt,
        schemaEra: prepared.schemaEra,
        systemSha: prepared.systemSha,
        userSha: prepared.userSha,
      };

      // A REPLICATE THAT WOULD NOT BE A REPLICATE IS NOT BOUGHT.
      //
      // prepareRow rebuilds the request from the stored prompt fresh on every
      // invocation, and a row's two reps routinely land in different
      // invocations hours apart. If shape.ts or prompt-surgery.ts was
      // redeployed between them, or the stored text was edited, the second cell
      // is a different request pooled as a replicate of the first — and the
      // bias has a direction: a later build that constrains the output more
      // agrees with itself more often, so the pooled rate comes out LOW, which
      // is the one direction #65 cannot survive. Report mode refuses such a run
      // afterwards; this check refuses to pay for it in the first place, and
      // the cell lands 'aborted' with the reason so the row is visibly excluded
      // rather than silently mixed.
      const sibling = siblingFacts.get(cell.row.analysisId);
      const theseFacts = [
        shapeFacts.systemSha,
        shapeFacts.userSha,
        shapeFacts.effort,
        shapeFacts.maxTokens,
        shapeFacts.toolsPresent,
        shapeFacts.schemaInPrompt,
        shapeFacts.shape,
      ].join("|");
      if (sibling !== undefined && sibling !== theseFacts) {
        const claimedRow = await claimCell(cell, shapeFacts);
        if (claimedRow === null) {
          errors.push(`claim_failed:${cell.row.analysisId}#${cell.rep}`);
          break;
        }
        if (claimedRow === "taken") continue;
        const patched = await patchRows(`noise_cells?id=eq.${claimedRow}`, {
          status: "aborted",
          finished_at: new Date().toISOString(),
          error_slice: "request_disagrees_with_sibling_replicate",
        });
        if (patched === null) errors.push(`patch_failed:cell:${cell.row.analysisId}#${cell.rep}`);
        errors.push(`request_disagrees_with_sibling:${cell.row.analysisId}`);
        cellsThisInvocation += 1;
        continue;
      }

      // CLAIM BEFORE SPENDING. The insert commits before the model call, so a
      // worker killed at the wall clock leaves a row saying "this replicate was
      // started and never answered" instead of a silent gap that a later report
      // would read as a complete run. Zero rows back from
      // resolution=ignore-duplicates means the (run_id, analysis_id, rep)
      // unique key already had a row: another invocation owns this cell and
      // this one must not spend on it.
      const cellId = await claimCell(cell, shapeFacts);
      if (cellId === null) {
        errors.push(`claim_failed:${cell.row.analysisId}#${cell.rep}`);
        break;
      }
      if (cellId === "taken") continue;

      // What is left of each budget before this cell. The pause loop consults
      // it between its continuations; on the arms that cannot pause it is never
      // read, and on the arm that can it is the only thing between one cell and
      // five billed calls.
      const outcome = await callModel(prepared.body, callTimeout, {
        input: Math.max(0, budgetInput - (totals.spentInput + totals.boundInput)),
        output: Math.max(0, budgetOutput - (totals.spentOutput + totals.boundOutput)),
      });
      cellsThisInvocation += 1;

      // The four columns of the bill, written on the cell whatever the status.
      // The header's spend is recomputed from these, so a response that
      // arrived and was unusable still costs what it cost.
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
        // Impossible while this file sends no cache_control; if it happens, the
        // body on the wire was not the body shape.ts built, and the header's
        // spend under-reports by this much. Said out loud rather than folded
        // into the cache_read column.
        errors.push(`cache_creation_tokens:${outcome.cacheCreationTokens}`);
      }
      if ((outcome.webSearchRequests ?? 0) > 0) {
        // Billed per request, and no token budget bounds it. See the field's
        // comment on CallOutcome.
        errors.push(`web_search_requests:${outcome.webSearchRequests}`);
      }
      if (outcome.pauseContinuations > 0) {
        // Surfaced here as well as on the cell, because on a cell that did not
        // end 'ok' the error_slice is spent on the reason it did not.
        errors.push(`pause_continuations:${cell.row.analysisId}#${cell.rep}:${outcome.pauseContinuations}`);
      }

      let cellStatus: CellStatus;
      let raw: RawAnswer | null = null;
      let errorSlice: string | null = null;
      let rulesApplied: unknown = null;

      if (outcome.transportError !== null) {
        // "deadline" is this cell's own budget running out between pause
        // continuations, which is the same fact as the socket timing out: no
        // answer arrived in the time allowed. Both land as 'timeout' so the
        // pre-registration's four-class failure table counts them where they
        // belong; only a genuine transport failure is 'http_error'.
        cellStatus = outcome.transportError === "timeout" || outcome.transportError === "deadline"
          ? "timeout"
          : "http_error";
        errorSlice = outcome.transportError.slice(0, 200);
      } else if (outcome.pauseExhausted) {
        cellStatus = "pause_exhausted";
      } else {
        const answer = parseAnalysisJson(extractAnthropicText(outcome.parsed));
        const classified = classifyCell({
          httpStatus: outcome.httpStatus,
          stopReason: outcome.stopReason,
          parsed: answer,
          requiredKeys,
        });
        cellStatus = classified.status;
        raw = classified.raw;
        if (isRecord(answer) && Array.isArray(answer.rules_applied)) rulesApplied = answer.rules_applied;
        if (outcome.httpStatus < 200 || outcome.httpStatus >= 300) {
          errorSlice = `${outcome.httpStatus}:${outcome.errorMessage}`.slice(0, 200);
        }
      }

      // Three facts that mean "this cell is not a measurement" and that the
      // nine-value vocabulary has no separate word for. All three land as
      // 'aborted' with the reason in error_slice, and none of them is allowed
      // to land as 'ok':
      //
      //   * the row could not be classified or its request could not be built
      //     (handled above);
      //   * the server answered from a different model than the row's stored
      //     one, which would count a server-side model change as analyst noise;
      //   * the answer will not fit the columns: raw_confidence is an integer
      //     column and the ok check constraint requires both it and raw_signal
      //     to be non-null. Rounding a fractional confidence is exactly the
      //     coercion metric.ts exists to prevent, so the cell says it could not
      //     be stored instead of storing something the model did not say;
      //   * the answer carried all 20 keys but put a value outside the contract
      //     in one of the two the metric reads.
      const rawConfidence = intOrNull(raw?.confidence);
      if (cellStatus === "ok" && outcome.responseModel !== null && outcome.responseModel !== cell.row.model) {
        cellStatus = "aborted";
        errorSlice = `model_mismatch:${outcome.responseModel}`.slice(0, 200);
        raw = null;
        // AND IT STOPS THE RUN. This used to be a cell status only, and the
        // comment beside it claimed that one such cell "makes report() refuse
        // the whole run rather than drop a row quietly" — which was false as
        // written. report() treats a row whose cells all failed as
        // rowsAllCellsFailed and drops it from the denominator with
        // emitted:true, so a model change PARTWAY through a multi-hour run
        // silently shrank the population, and a change affecting every row
        // spent all 96 billable calls before report() refused for having no
        // admitted rows at all.
        //
        // Measured 2026-09-09: the stored model column holds one value on 48 of
        // 48 rows and it is an alias with no date suffix, while nothing in this
        // repo has ever read `response.model` back — analyze stores the
        // REQUEST's value. So the equality this check rests on has never been
        // observed to hold. Aborting means the pilot discovers it at one call
        // instead of the full run discovering it at ninety-six, the
        // pre-registration's §9 trip-wire actually fires, and the decision about
        // what to do next — accept a resolved snapshot, or stop — belongs to the
        // operator, who now has the returned identifier in abort_reason to
        // decide with. The dry run cannot see this: count_tokens echoes no
        // model, so there is no free check.
        outcome.abortReason = errorSlice;
      } else if (cellStatus === "ok" && (raw === null || raw.signal === null || rawConfidence === null)) {
        cellStatus = "aborted";
        errorSlice = "unstorable_raw:signal_or_confidence_not_a_storable_value";
        raw = null;
      } else if (cellStatus === "ok" && raw !== null && publishedProxy(raw) === null) {
        // All 20 keys present, so classifyCell said ok — but the signal is not
        // one of the three enum values, or the confidence is outside 0-100.
        // Left as 'ok' it would be counted in completed_cells and reported as
        // 100% instrument health, and only dropped much later as an
        // unprojectable row. The pre-registration reads its instrument
        // condition (§4: refuse to conclude at >=5% failure) straight off those
        // rates, so an out-of-contract answer has to be visible AS a failure.
        // The same projection the metric uses is the one asked here, rather
        // than a second copy of the enum that could drift from it.
        cellStatus = "aborted";
        errorSlice = "out_of_contract:signal_or_confidence_outside_the_response_contract";
        raw = null;
      } else if (cellStatus === "ok" && outcome.pauseContinuations > 0) {
        // Not a failure, and not stored anywhere else: there is no column for
        // the continuation count and the design requires it to be recorded.
        // A `note:` prefix so a reader cannot mistake it for an error slice.
        errorSlice = `note:pause_continuations=${outcome.pauseContinuations}`;
      }

      const finished: JsonRecord = {
        ...usagePatch,
        status: cellStatus,
        error_slice: errorSlice,
        // stop_details is read in the refusal branch and in no other. Null on
        // every other stop_reason, and a reader that pulled it unconditionally
        // would record a null as "no details" rather than as "not that kind of
        // ending".
        stop_details: cellStatus === "refusal" ? outcome.stopDetails ?? null : null,
        raw_signal: raw?.signal ?? null,
        raw_confidence: cellStatus === "aborted" ? null : intOrNull(raw?.confidence),
        raw_stop: raw?.stop ?? null,
        raw_tp1: raw?.tp1 ?? null,
        raw_fundamental_score: intOrNull(raw?.fundamental_score),
        missing_required_keys: raw?.missingRequiredKeys ?? null,
        rules_applied: rulesApplied,
      };
      const wrote = await patchRows(`noise_cells?id=eq.${cellId}`, finished);
      if (wrote === null) {
        // The call was paid for and its answer could not be written down. Stop
        // rather than spend on the next cell: whatever refused this write —
        // most likely noise_cells_ok_is_answered_check, which is a bug in this
        // writer by construction — will refuse the next one too, and the run
        // would spend its whole budget leaving nothing but claimed rows. The
        // cell stays 'claimed', which is visible, and the gate stays shut.
        errors.push(`patch_failed:cell:${cell.row.analysisId}#${cell.rep}`);
        break;
      }

      // Logged: status, request id, a bounded error slice. Never a body, never
      // a prompt, never a header, never the token.
      console.log("noise-floor cell", {
        run_id: runId,
        status: cellStatus,
        http_status: outcome.httpStatus,
        request_id: outcome.requestId ?? "",
        error: errorSlice ?? "",
      });

      // The spend, measured from usage and written to the header after EVERY
      // response. A call count cannot bound spend at max_tokens 8000 with
      // thinking billed as output.
      const after = await reconcile(runId);
      if (after === null) return json(summarize(totals, false), 500);
      totals = after;

      if (outcome.abortReason !== null) {
        abortReason = outcome.abortReason.slice(0, 200);
        status = "aborted";
        const patched = await patchRows(`noise_runs?id=eq.${runId}`, {
          status: "aborted",
          abort_reason: abortReason,
        });
        if (patched === null) errors.push("patch_failed:noise_runs_abort");
        console.error("noise-floor aborted", { run_id: runId, abort_reason: abortReason });
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

    // Before the chain fires, or the child would be refused by its own parent's
    // lease.
    await releaseLease();

    if (status === "running" && totals.completed + totals.failed >= expectedCells) {
      const patched = await patchRows(`noise_runs?id=eq.${runId}&status=eq.running`, { status: "done" });
      if (patched === null) errors.push("patch_failed:noise_runs_done");
      else if (patched.length > 0) status = "done";
    }

    // CHAINING. Re-read the header rather than trusting what this invocation
    // remembers: the kill switch is an UPDATE somebody else made while this
    // was running, and the whole point of reading it here is to see it.
    if (chain && status === "running") {
      const fresh = await readRun(runId);
      if (fresh === "read_failed" || fresh === null) {
        errors.push("read_failed:noise_runs_chain");
      } else {
        const freshStatus = typeof fresh.status === "string" ? fresh.status : "";
        const hops = numberOrNull(fresh.chain_hops) ?? 0;
        const maxHops = numberOrNull(fresh.max_chain_hops) ?? 0;
        const remaining = expectedCells - (totals.completed + totals.failed + totals.unfinished);
        // The same "measured plus bound" arithmetic budgetCrossed uses. A chain
        // whose hops all time out would otherwise see two zeros here and keep
        // hopping through the whole population.
        const budgetLeft = budgetCrossed(totals) === null;
        if (freshStatus === "running" && remaining > 0 && budgetLeft && hops < maxHops) {
          // The increment and the authorisation are ONE conditional UPDATE:
          // the row is matched on the hop count this invocation just read, so
          // two invocations that both decide to fire cannot both match, and
          // exactly one gets a row back. An advisory lock was the alternative
          // and it dies with the worker, which is the moment it would be needed.
          const authorised = await patchRows(
            `noise_runs?id=eq.${runId}&status=eq.running&chain_hops=eq.${hops}`,
            { chain_hops: hops + 1 },
          );
          if (authorised === null) errors.push("patch_failed:noise_runs_chain_hop");
          else if (authorised.length > 0) {
            try {
              // The token goes back out on the same header it arrived on, read
              // from the RPC above and never logged. The wait is short on
              // purpose: the child has been delivered and is running by the
              // time this returns, and holding this worker open for the child's
              // full 130 s would nest the chain instead of extending it. If the
              // platform does cancel a child whose caller disconnected, the run
              // stops with cells remaining and the reporting gate stays shut —
              // visible, and one more POST away from resuming.
              const handoff = await fetch(`${supabaseUrl}/functions/v1/noise-floor`, {
                method: "POST",
                headers: { "Content-Type": "application/json", "x-sweep-token": expectedToken },
                body: JSON.stringify({
                  run_id: runId,
                  dry_run: false,
                  chain: true,
                  max_cells: runMaxCells,
                }),
                signal: AbortSignal.timeout(CHAIN_HANDOFF_MS),
              });
              // THE RESPONSE IS INSPECTED. It was discarded before, so a
              // handoff that was rejected outright still reported chained:true
              // and still spent a hop — and there is a live way for it to be
              // rejected: this self-POST carries the sweep token and no
              // Authorization header, so if the platform's verify_jwt default
              // is in force for this function the gateway answers 401 before
              // the handler runs. Status only, never the body: the body of a
              // response from this same function is this function's own
              // summary, and there is no reason to copy it into an error list.
              if (!handoff.ok) {
                errors.push(`chain_handoff_status:${handoff.status}`);
              } else {
                chained = true;
              }
            } catch (err) {
              // A handoff that timed out is the expected case, not a failure:
              // the child has been delivered and is running.
              if (err instanceof DOMException && err.name === "TimeoutError") {
                chained = true;
              } else {
                errors.push(`chain_handoff:${slice200(err)}`);
              }
            }
          }
        }
      }
    }

    return json(summarize(totals, true));
  } catch (err) {
    console.error("noise-floor error:", slice200(err));
    return json({ ok: false, error: "サーバーエラーが発生しました" }, 500);
  }
});
