// postmortem — why a settled plan turned out the way it did, and what the
// analyzer should learn from it.
//
// For every plan the tracker has settled, once enough time has passed to see
// what price did next, this function:
//   1. fetches the bars from the signal onwards and computes the facts
//      (facts.ts): excursions, what happened after the settlement, and how
//      the same plan would have fared entered at the market, with a wider
//      stop, with a nearer target;
//   2. asks the model for a diagnosis — a cause, the evidence, and a one-line
//      lesson — constrained to those facts;
//   3. stores the diagnosis on the row and the lesson in public.lessons;
//   4. when there are new lessons, has the model rewrite the rulebook
//      (public.rulebook) that analyze puts in front of every new plan.
//
// DEPLOYING THIS FUNCTION: run `npm run bundle:postmortem` first and upload
// the resulting bundle.js as the entrypoint. It imports across four function
// directories (analyze, econ-calendar, track-outcomes and its own), and those
// ten files together are larger than the deploy API accepts in a single call
// — every attempt to send them raw fails part-way. The .ts files here remain
// the source of truth; the bundle is generated and gitignored.
//
// Callers: pg_cron every 15 minutes with the shared sweep token, and an
// admin with their JWT (to run it by hand, with `force` to skip the waits).

import { parseCandles, type Candle } from "../analyze/indicators.ts";
import { currenciesOf, type EconEvent } from "../econ-calendar/events.ts";
import { parseRules, type Rule } from "../analyze/rules.ts";
import { ENTRY_WINDOW_MS, EVAL_INTERVAL, type Evaluation } from "../track-outcomes/evaluate.ts";
import { MIN_AFTER_BARS, afterWindowMs, computeFacts, isPostmortemDue, type Cause, type PostmortemFacts, type PostmortemRow } from "./facts.ts";
import { marketHorizonEnd } from "../track-outcomes/waits.ts";
import { PLAN_CONTRACT } from "../_shared/contract.ts";
import { DECIDED_ROW_LIMIT, MIN_DECIDED_EPISODES, decidedRowsPath, promotionGate, type DecidedRow } from "./promotion.ts";
import { MAX_PLANS_ADMIN, MAX_PLANS_PER_RUN, isTargeted, parseIds, runLimit, unaccountedIds } from "./targeted.ts";
import {
  CONSOLIDATION_SCHEMA,
  EPISODE_DEFINITION_VERSION,
  MIN_NEW_LESSONS,
  buildConsolidationPrompt,
  buildDiagnosisPrompt,
  buildWaitDiagnosisPrompt,
  parseConsolidation,
  parseDiagnosis,
  revisionDue,
  summarizeRecord,
  fairShare,
  withClusters,
  type LessonRow,
  type PlanSummary,
  type RecordRow,
} from "./prompt.ts";

const POSTMORTEM_VERSION = "postmortem-v21-2026-09-08T09:00:00Z";
const SCHEMA_VERSION = 2;
const MODEL = "claude-opus-5";
const ADMIN_EMAILS = ["k.munemoto@kyoto-salute.com", "munekan2989@gmail.com"];

const MIN = 60_000;
const HOUR = 60 * MIN;
const SWEEP_COOLDOWN_MS = 10 * MIN;
const MAX_ATTEMPTS = 3;
// A diagnosis made on almost no aftermath is revisited once the full window
// of bars exists; this caps how often that happens.
const MAX_REVISIONS = 1;
// How much the live rulebook must have been measured over before a revision
// replaces it lives in promotion.ts now, counted in independent situations
// rather than in rows — see the header there for why ten rows and ten
// situations are not the same evidence.
// Supabase kills the worker at 150s; leave room to write results
const WALL_CLOCK_BUDGET_MS = 130_000;
const START_DIAGNOSIS_BEFORE_MS = 75_000;
// Sized for one plan: a diagnosis reads a single set of bars and answers
// about a single trade.
const LLM_TIMEOUT_MS = 45_000;
// A consolidation turn reads sixty lessons, three hundred plans and the
// whole rulebook, and rewrites the book. Sharing the diagnosis timeout made
// it time out on every single run: the loop was trying and never finishing,
// which reads exactly like the freeze it was supposed to end.
const MIN_CONSOLIDATION_MS = 45_000;
const MAX_CONSOLIDATION_MS = 110_000;
// Held back so a revision that did finish is still written down
const WRITE_RESERVE_MS = 10_000;
const RECENT_LESSONS = 60;
// The repair scan: how many recent done rows to check for a missing lesson,
// and how many to rebuild in one run. Rebuilding costs one insert each and no
// model call, so the cap is about keeping the run short, not about spend.
const REPAIR_SCAN = 200;
const REPAIR_PER_RUN = 20;
const RECENT_ROWS = 300;
// Rows fetched per row kept, so the round-robin across accounts has a pool
// deeper than the busiest account's recent output
const FAIR_FETCH_MULTIPLE = 3;
const HISTORY_KEEP = 20;
// Bars fetched ahead of the signal so the judge's window covers it
const PRE_SIGNAL_MS = 6 * HOUR;
const TWELVE_DATA = "https://api.twelvedata.com/time_series";

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
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const strOrNull = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value : null);

const strList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

const constantTimeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

// "YYYY-MM-DD HH:mm:ss" in UTC, the form Twelve Data's date filters take
const tdDate = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

const query = (params: Record<string, string>) =>
  Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");

const extractText = (value: unknown): string => {
  if (!isRecord(value) || !Array.isArray(value.content)) return "";
  const parts: string[] = [];
  for (const block of value.content) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("").trim();
};

const parseJsonText = (text: string): unknown => {
  const cleaned = text.replace(/```json\n?|```\n?/g, "").trim();
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

type Scope = { kind: "sweep" } | { kind: "admin"; email: string };

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const startedAt = Date.now();
  const elapsed = () => Date.now() - startedAt;
  // What a consolidation turn may spend: everything left of the wall clock,
  // less the reserve for writing the result, and never more than one turn
  // can usefully use.
  const consolidationBudget = () =>
    Math.min(MAX_CONSOLIDATION_MS, WALL_CLOCK_BUDGET_MS - elapsed() - WRITE_RESERVE_MS);

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const twelveDataKey = Deno.env.get("TWELVE_DATA_API_KEY");
    const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");

    if (!supabaseUrl || !supabaseAnonKey || !serviceRoleKey || !twelveDataKey || !anthropicKey) {
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
    // One place that turns a stored diagnosis into a lessons row, so the
    // repair path below writes exactly what the diagnosis path writes. Every
    // field comes from the diagnosis document or the analyses row, which is
    // why a lesson lost to a failed insert can be recovered later without
    // asking the model anything a second time.
    const writeLesson = async (
      id: string,
      raw: JsonRecord,
      doc: JsonRecord,
      row: { pair: string; interval: string; signal: string; outcome: string; created_at: string; closed_at?: string | null },
    ): Promise<boolean> => {
      const lesson = isRecord(doc.lesson) ? doc.lesson : {};
      const scope = strOrNull(doc.scope);
      const ev = isRecord(raw.evaluation) ? raw.evaluation : null;
      const res = await rest("lessons?on_conflict=analysis_id", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({
          analysis_id: id,
          user_id: strOrNull(raw.user_id),
          plan_contract: strOrNull(raw.plan_contract),
          pair: row.pair,
          interval: row.interval,
          signal: row.signal,
          mode: strOrNull(raw.mode),
          order_type: strOrNull(ev?.order_type),
          outcome: row.outcome,
          cause: strOrNull(doc.cause),
          secondary_causes: Array.isArray(doc.secondary_causes) ? doc.secondary_causes : [],
          avoidable: doc.avoidable === true,
          confidence: numberOrNull(doc.confidence),
          lesson_ja: strOrNull(lesson.ja) ?? "",
          lesson_en: strOrNull(lesson.en) ?? "",
          scope: scope ? { text: scope } : null,
          shadow: raw.shadow === true,
          rule_blamed: strOrNull(doc.rule_blamed),
          rule_credited: strOrNull(doc.rule_credited),
          // When the plan was made: what "same situation" is judged on
          analysis_created_at: row.created_at,
          // How much aftermath the diagnosis actually rested on, and which
          // build wrote it. Both come off the stored document, so the repair
          // path rebuilds the same numbers with no model call.
          //
          // AFTER_WAIT_MS (facts.ts) is 1h on a 15min plan and 8h on a daily
          // one, so a diagnosis is written very soon after settlement BY
          // DESIGN, and postmortem.facts has always recorded how many bars
          // that was. The lesson did not, and the rulebook editor reads
          // lessons — so an eight-bar reading and a ninety-five-bar reading
          // arrived indistinguishable, both stating a confidence in the 70s.
          // Measured 2026-09-07: of four losses re-diagnosed at 48-95 bars,
          // two changed the cause outright and one kept the cause but flipped
          // avoidable; the fourth has nothing on record either way. Row
          // 1b003cf3 was direction_wrong with max_favorable_r 0 — "never once
          // in profit" — and at 48 bars was chased_move with max_favorable_r
          // 7: the direction was right and price reached TP1 23 bars later.
          // (Written up first as "three of four", which the stored causes do
          // not support. The four were also re-read by a build that had
          // changed the cause vocabulary, so depth and that change are not
          // separated. Both caveats travel with the number wherever it is
          // cited.)
          // This column is the depth, and nothing else: what it is worth is
          // a judgement to be made FROM the record, not inside the writer.
          bars_after_settlement: numberOrNull(
            (isRecord(doc.facts) ? doc.facts : {}).bars_after_settlement,
          ),
          postmortem_version: strOrNull(doc.version),
          // ...and when it settled, which is the OTHER half of that judgement.
          // The episode rule lets a plan made more than CLUSTER_REOPEN_MS
          // after the previous one closed start a fresh episode; without this
          // the escape read null on every lesson ever written and the rule
          // degenerated to the 24h window alone, fusing separate decisions and
          // understating every rule's support. Null on a plan that had not
          // settled — an open position never opens the escape.
          plan_closed_at: row.closed_at ?? null,
        }),
      });
      if (!res.ok) {
        console.error("lesson insert failed:", id, res.status, (await res.text().catch(() => "")).slice(0, 200));
        return false;
      }
      await res.text().catch(() => {});
      return true;
    };

    const patchRows = async (path: string, body: JsonRecord): Promise<number> => {
      const res = await rest(path, {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify(body),
      });
      const rows = res.ok ? await res.json().catch(() => null) : null;
      if (!res.ok) console.error("patch failed:", path.split("?")[0], res.status, (await res.text().catch(() => "")).slice(0, 200));
      return Array.isArray(rows) ? rows.length : 0;
    };
    // null when the read itself failed, as opposed to nothing being there —
    // the difference between "no rulebook yet" and "could not reach it"
    const readRowsOrNull = async (path: string): Promise<JsonRecord[] | null> => {
      const res = await rest(path);
      if (!res.ok) {
        console.error("read failed:", path.split("?")[0], res.status, (await res.text().catch(() => "")).slice(0, 200));
        return null;
      }
      const rows = await res.json().catch(() => null);
      return Array.isArray(rows) ? rows.filter(isRecord) : [];
    };
    const readRows = async (path: string): Promise<JsonRecord[]> => (await readRowsOrNull(path)) ?? [];

    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const bodyRaw = await req.json().catch(() => null);
    const body: JsonRecord = isRecord(bodyRaw) ? bodyRaw : {};

    // Options for a hand-run (either caller is trusted): run on specific
    // rows, skip the after-settlement wait, force a rulebook rewrite.
    //
    // Read BEFORE the auth block, not after it, because whether this request
    // names rows decides how the sweep cooldown below treats it — and the
    // body is already in hand at this point. Nothing here grants anything:
    // the token or the admin JWT is still checked below, and every option is
    // only acted on once it has been.
    const options = { force: false, ids: [] as string[], consolidate: false, promote: false, limit: MAX_PLANS_PER_RUN };
    options.force = body.force === true;
    options.consolidate = body.consolidate === true;
    // Escape hatch: promote a revision the decided-trade gate is holding.
    options.promote = body.promote === true;
    // Parsed, not sliced: every entry the caller sent comes back either as an
    // id the run will query for or as a line saying why it will not, and the
    // truncation that used to happen silently HERE is one of those lines
    // (targeted.ts). Nothing is dropped between the request and the answer.
    const parsedIds = parseIds(body.ids);
    options.ids = parsedIds.ids;
    // Naming four rows and diagnosing three of them was request 1035
    // (2026-09-07): the ids bound was MAX_PLANS_ADMIN while the limit stayed
    // at the cron's default of three, and the fourth row went nowhere. The
    // ids themselves say how many now (targeted.ts).
    options.limit = runLimit(options.ids.length, numberOrNull(body.limit));
    // A run aimed at named rows: an operator action, not a schedule. The
    // predicate itself lives in targeted.ts so the shapes that must NOT count
    // as naming a row — a blank string, a list of numbers, a string where a
    // list belongs — are settled in one tested place rather than by a length
    // test here.
    const targeted = isTargeted(parsedIds);

    // ---- who is asking -------------------------------------------------
    let scope: Scope;
    const sweepToken = req.headers.get("x-sweep-token");
    if (sweepToken) {
      const tokenRes = await rest("rpc/track_outcomes_sweep_token", { method: "POST", body: "{}" });
      const expected = tokenRes.ok ? await tokenRes.json().catch(() => null) : null;
      if (typeof expected !== "string" || expected.length === 0 || !constantTimeEqual(sweepToken, expected)) {
        return json({ ok: false, error: "認証に失敗しました" }, 401);
      }
      // The cooldown paces the CRON, and nothing else. A run that names rows
      // is neither paced by it nor allowed to spend it:
      //   * it must not WAIT on it — request 1033 at 12:39:45Z named four rows
      //     and returned {"diagnosed":0,"skipped":"cooldown"} 1m45s after the
      //     12:38 sweep had claimed the slot, so the ids filter below (whose
      //     own comment says named rows are re-diagnosed whatever their state)
      //     was never even reached;
      //   * it must not CLAIM it — the 12:48 targeted run took the slot and
      //     made the 12:53 scheduled sweep a no-op. Ten minutes of the queue's
      //     own progress, spent by a request that was not the queue.
      // Authentication is unchanged either way: the token was verified above.
      //
      // Known and accepted: the slot was also the only thing serializing two
      // runs, so a targeted run started inside a sweep's ~2-minute window can
      // diagnose a row the sweep is also diagnosing. Both read the row before
      // either writes, so the loser's model turn is thrown away and the
      // `attempts` / `revisions` counters on it lose an increment. That is the
      // price of the exemption and it is the smaller price: a per-row claim
      // would make a named row refusable, and naming a row is precisely the
      // instruction to diagnose it whatever its state. The admin-JWT path has
      // never claimed the slot either, so this window is not new — it is now
      // reachable by the token as well.
      if (!targeted) {
        const cutoff = encodeURIComponent(new Date(nowMs - SWEEP_COOLDOWN_MS).toISOString());
        const claimed = await patchRows(
          `postmortem_state?id=eq.1&or=(last_run_at.is.null,last_run_at.lt.${cutoff})`,
          { last_run_at: nowIso },
        );
        if (claimed === 0) {
          return json({ ok: true, mode: "sweep", diagnosed: 0, skipped: "cooldown", version: POSTMORTEM_VERSION });
        }
      }
      scope = { kind: "sweep" };
    } else {
      const authHeader = req.headers.get("Authorization");
      if (!authHeader?.startsWith("Bearer ")) {
        return json({ ok: false, error: "認証が必要です" }, 401);
      }
      const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
        headers: { Authorization: authHeader, apikey: supabaseAnonKey },
      });
      const userData = userRes.ok ? await userRes.json().catch(() => null) : null;
      const email = isRecord(userData) && typeof userData.email === "string" ? userData.email.toLowerCase() : null;
      if (!email || !ADMIN_EMAILS.includes(email)) {
        return json({ ok: false, error: "権限がありません" }, 403);
      }
      scope = { kind: "admin", email };
    }

    // ---- the rulebook, by version -------------------------------------------
    // Every plan records the rulebook version it was made under; the current
    // rules and the kept history say which rules that version held, so the
    // diagnosis can name the rule at fault and the consolidation can score
    // each rule on what its plans then did
    const rulebookRows = await readRowsOrNull("rulebook?id=eq.1&select=version,rules,history,updated_at,candidate");
    // A rulebook that could not be read is not an empty one: never rewrite
    // it from nothing on the strength of a failed request
    const rulebookUnavailable = rulebookRows === null;
    const current = rulebookRows?.[0];
    const rulesByVersion = new Map<number, Rule[]>();
    if (current) {
      rulesByVersion.set(numberOrNull(current.version) ?? 0, parseRules(current.rules));
      for (const h of Array.isArray(current.history) ? current.history : []) {
        if (!isRecord(h)) continue;
        const hv = numberOrNull(h.version);
        if (hv !== null && !rulesByVersion.has(hv)) rulesByVersion.set(hv, parseRules(h.rules));
      }
    }
    const currentRules = current ? parseRules(current.rules) : [];

    // ---- settled plans without a diagnosis --------------------------------
    const select = [
      "id", "user_id", "pair", "interval", "mode", "signal", "confidence", "thesis",
      "entry_point", "stop_loss", "take_profit_1", "take_profit_2", "take_profit_3",
      "price_at_signal", "created_at", "closed_at", "outcome", "evaluation",
      "entry_check", "context", "shadow", "result", "postmortem", "rulebook_version",
      // Which levers the diagnosis may recommend moving depends on it: under
      // market_v1 the analyst never chose the entry price, so a lesson about
      // where to enter is a lesson nobody can follow.
      "plan_contract",
    ].join(",");
    // Never diagnosed; failed and still retryable; or diagnosed and not yet
    // revisited — EVERY done row, not only the ones flagged thin.
    // `thin` was a guess at which diagnoses were unreliable, and the guess
    // does not survive contact with the record: re-reading four losses at
    // 48-95 bars changed the cause outright on two of them and flipped
    // avoidable on a third, and a reading at nine bars is not obviously safer
    // than one at eight. So the cut is dropped
    // and depth is given to every row once, MAX_REVISIONS still being 1.
    // (That measurement is confounded — the same run also changed the cause
    // vocabulary — which is why this ships as a revisit of everything rather
    // than as a conclusion; see docs/POSTMORTEM_DEPTH_PREREGISTRATION.md.)
    //
    // A revisit that failed (no data, model down) is retried a few times and
    // then left alone, without touching the diagnosis it was revisiting.
    const revisitRetryable = `or(postmortem->>revisit_attempts.is.null,postmortem->>revisit_attempts.lt.${MAX_ATTEMPTS})`;
    // The same null-tolerant pair, and for the same reason. `revisions` is
    // ABSENT from every document written before the counter existed, and in
    // PostgREST `postmortem->>revisions.lt.1` on an absent key compares
    // against SQL NULL: the result is NULL, not true, so the row does not
    // match. Those rows used to be carried by the `thin.is.null` branch that
    // is folded away just above; without this pair the revisit would silently
    // match nothing and the whole change would be inert.
    const revisionsLeft = `or(postmortem->>revisions.is.null,postmortem->>revisions.lt.${MAX_REVISIONS})`;
    const retryFilter = [
      "or=(postmortem.is.null",
      `and(postmortem->>status.eq.failed,postmortem->>attempts.lt.${MAX_ATTEMPTS})`,
      `and(postmortem->>status.eq.done,${revisionsLeft},${revisitRetryable}))`,
    ].join(",");
    // Named rows are re-diagnosed whatever their state: that is what naming
    // them is for
    const rowFilter = options.ids.length > 0
      ? `id=in.(${options.ids.map(encodeURIComponent).join(",")})`
      : retryFilter;
    // Read so that a query that FAILED stays distinguishable from a query that
    // came back empty. For the cron the two are the same thing — an empty page
    // means nothing to do either way — but for a targeted run the difference is
    // the whole answer: an empty page reported per id says "no plan with this
    // id", and saying that about a row the operator is looking straight at, on
    // the strength of a 400 nobody read, is a worse failure than the silence
    // this accounting replaced. The run already draws exactly this distinction
    // for the rulebook and for the repair pass; the candidate queries were the
    // one place that did not.
    const candidatesOrNull = await readRowsOrNull(
      `analyses?outcome=in.(win,loss,untriggered,expired,ambiguous)&signal=in.(BUY,SELL)&${rowFilter}&select=${select}&order=closed_at.asc.nullsfirst&limit=40`,
    );
    const candidates = candidatesOrNull ?? [];

    // `wait` is set only on a call that declined to trade: `row` then holds
    // the hypothetical trade stored at the call, so the facts machinery can
    // measure it, while `raw` still holds the real row (signal WAIT, outcome
    // skipped) that the lesson is filed under.
    const rows: Array<{
      row: PostmortemRow;
      raw: JsonRecord;
      wait: { plan: JsonRecord; check: JsonRecord; untilMs: number; hint: Cause } | null;
    }> = [];
    for (const r of candidates) {
      if (r.signal !== "BUY" && r.signal !== "SELL") continue;
      const entry = numberOrNull(r.entry_point);
      const sl = numberOrNull(r.stop_loss);
      const tp1 = numberOrNull(r.take_profit_1);
      if (entry === null || sl === null || tp1 === null) continue;
      const row: PostmortemRow = {
        id: String(r.id),
        pair: String(r.pair),
        interval: String(r.interval),
        signal: r.signal,
        entry_point: entry,
        stop_loss: sl,
        take_profit_1: tp1,
        take_profit_2: numberOrNull(r.take_profit_2),
        take_profit_3: numberOrNull(r.take_profit_3),
        created_at: String(r.created_at),
        price_at_signal: numberOrNull(r.price_at_signal),
        evaluation: isRecord(r.evaluation) ? (r.evaluation as unknown as Evaluation) : null,
        outcome: String(r.outcome),
        closed_at: strOrNull(r.closed_at),
      };
      const prior = isRecord(r.postmortem) ? r.postmortem : null;
      const isRevision = prior?.status === "done";
      if (!options.force && options.ids.length === 0) {
        if (!isPostmortemDue(row, nowMs)) continue;
        // A revision waits for the whole after-window, not just the first
        // couple of bars that made the original diagnosis thin
        const closed = row.closed_at ? Date.parse(row.closed_at) : NaN;
        if (isRevision && (!Number.isFinite(closed) || nowMs - closed < afterWindowMs(row.interval))) continue;
      }
      rows.push({ row, raw: r, wait: null });
    }

    // ---- calls that declined to trade --------------------------------------
    // A WAIT never appeared in the query above: it is filtered out twice over
    // (outcome skipped, signal WAIT), and the null-level guard would have
    // dropped it anyway. So the one prediction that costs nothing to make was
    // also the one prediction never reviewed — while every diagnosed row
    // pushed the rules toward trading less.
    //
    // What is diagnosed is the trade the call declined: fixed at the moment
    // of the call, stored in wait_plan, and already resolved by the tracker.
    // Appended AFTER the trades so the run's limit spends itself on settled
    // positions first; at 3 plans a run and 96 runs a day the queue drains
    // either way.
    // The verdict filter belongs in SQL. 'no_call' and 'unknown' are terminal
    // by construction — the tracker never revisits them — so such a row is
    // never diagnosed, never gets a postmortem document, and therefore
    // matches this query forever. Ordered oldest first, forty of them would
    // fill the page permanently and every gradeable WAIT behind them,
    // including every 'missed', would never be seen again.
    // Which WAIT rows already have a shadow of the refused plan being
    // diagnosed in their place.
    const shadowRows = await readRows(
      `analyses?shadow=is.true&shadow_of=not.is.null&select=shadow_of&limit=500`,
    );
    const shadowParents = new Set(
      shadowRows.map((x) => strOrNull(x.shadow_of)).filter((v): v is string => v !== null),
    );

    const waitCandidatesOrNull = await readRowsOrNull(
      `analyses?outcome=eq.skipped&signal=eq.WAIT&wait_plan=not.is.null&shadow=is.false` +
        `&wait_check->>verdict=in.(missed,correct)&${rowFilter}` +
        `&select=${select},wait_plan,wait_check&order=created_at.asc&limit=40`,
    );
    const waitCandidates = waitCandidatesOrNull ?? [];
    for (const r of waitCandidates) {
      const plan = isRecord(r.wait_plan) ? r.wait_plan : null;
      const check = isRecord(r.wait_check) ? r.wait_check : null;
      if (!plan || !check) continue;
      // Only a settled verdict is worth a diagnosis. 'pending' has not been
      // measured, and 'unknown' / 'no_call' never can be — a diagnosis of an
      // unmeasurable call would be the model filling in what the data does
      // not contain.
      const verdict = strOrNull(check.verdict);
      if (verdict !== "missed" && verdict !== "correct") continue;
      const direction = strOrNull(plan.direction);
      if (direction !== "BUY" && direction !== "SELL") continue;
      // A plan the gate refused for fillability is already tracked as a
      // shadow row and diagnosed as a trade. Diagnosing the WAIT parent too
      // would draw two lessons from one market situation, and the revision
      // cadence counts raw lessons — so three refusals in a day would trip a
      // rulebook rewrite that the same three would not have tripped before.
      if (shadowParents.has(String(r.id))) continue;
      const entry = numberOrNull(plan.entry);
      const stop = numberOrNull(plan.stop);
      const target = numberOrNull(plan.target);
      if (entry === null || stop === null || target === null) continue;
      // The hypothetical trade, in the shape the facts machinery reads. Its
      // outcome is what the tracker already decided about it — not a claim
      // that any position was held.
      const row: PostmortemRow = {
        id: String(r.id),
        pair: String(r.pair),
        interval: String(r.interval),
        signal: direction,
        entry_point: entry,
        stop_loss: stop,
        take_profit_1: target,
        take_profit_2: null,
        take_profit_3: null,
        created_at: String(r.created_at),
        price_at_signal: entry,
        evaluation: null,
        outcome: verdict === "missed" ? "win" : "loss",
        closed_at: strOrNull(check.at) ?? strOrNull(check.checked_at),
      };
      const prior = isRecord(r.postmortem) ? r.postmortem : null;
      const isRevision = prior?.status === "done";
      if (!options.force && options.ids.length === 0) {
        if (!isPostmortemDue(row, nowMs)) continue;
        const closed = row.closed_at ? Date.parse(row.closed_at) : NaN;
        if (isRevision && (!Number.isFinite(closed) || nowMs - closed < afterWindowMs(row.interval))) continue;
      }
      // The end of the window the verdict was actually decided in — the same
      // market-time horizon judgeWait walked. Everything the diagnosis is
      // allowed to see stops here.
      const decidedMs = Date.parse(strOrNull(plan.decided_at) ?? String(r.created_at));
      const untilMs = marketHorizonEnd(
        Number.isFinite(decidedMs) ? decidedMs : Date.parse(String(r.created_at)),
        ENTRY_WINDOW_MS[String(r.interval)] ?? 48 * 60 * 60 * 1000,
      );
      rows.push({
        row,
        raw: r,
        wait: { plan, check, untilMs, hint: verdict === "missed" ? "wait_missed_trade" : "good_wait" },
      });
    }

    const due = rows.slice(0, options.limit);

    // ---- the calendar over the window under review -----------------------
    // One read for the whole run: an abnormal bar is then attributable to a
    // scheduled release instead of being guessed at from its shape
    let calendar: EconEvent[] = [];
    if (due.length > 0) {
      const oldest = due.reduce((min, d) => {
        const t = Date.parse(d.row.created_at);
        return Number.isFinite(t) ? Math.min(min, t) : min;
      }, nowMs);
      const pairs = new Set(due.flatMap((d) => currenciesOf(d.row.pair)));
      const countries = [...pairs, "All"];
      const rows = await readRows(
        `econ_events?select=id,event_at,country,title,impact,forecast,previous,all_day,source` +
        `&event_at=gte.${encodeURIComponent(new Date(oldest - 6 * HOUR).toISOString())}` +
        `&event_at=lte.${encodeURIComponent(nowIso)}` +
        `&country=in.(${countries.map(encodeURIComponent).join(",")})&order=event_at.asc&limit=200`,
      );
      calendar = rows as unknown as EconEvent[];
    }

    // ---- model ---------------------------------------------------------
    const anthropicHeaders = {
      "content-type": "application/json",
      "x-api-key": anthropicKey,
      "anthropic-version": "2023-06-01",
    };
    let effortEnabled = true;
    const askModel = async (
      system: string,
      user: string,
      schema: unknown,
      maxTokens: number,
      timeoutMs = LLM_TIMEOUT_MS,
    ): Promise<unknown> => {
      // A deadline for the whole call, not a fresh timeout per attempt: the
      // retry below must not be able to spend the budget twice and outlive
      // the worker.
      const deadline = Date.now() + timeoutMs;
      for (let attempt = 0; attempt < 2; attempt++) {
        const left = deadline - Date.now();
        if (left <= 0) throw new Error("ran out of time before the retry");
        const request: JsonRecord = {
          model: MODEL,
          max_tokens: maxTokens,
          system,
          messages: [{ role: "user", content: user }],
          output_config: effortEnabled
            ? { format: { type: "json_schema", schema }, effort: "medium" }
            : { format: { type: "json_schema", schema } },
        };
        const res = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: anthropicHeaders,
          body: JSON.stringify(request),
          signal: AbortSignal.timeout(left),
        });
        const raw = await res.text();
        const parsed = (() => {
          try {
            return JSON.parse(raw);
          } catch {
            return null;
          }
        })();
        if (!res.ok) {
          const message = isRecord(parsed) && isRecord(parsed.error) && typeof parsed.error.message === "string"
            ? parsed.error.message
            : "";
          if (effortEnabled && /output_config|effort/i.test(message)) {
            console.warn("output_config.effort rejected; retrying without it");
            effortEnabled = false;
            continue;
          }
          console.error("model request failed:", res.status, raw.slice(0, 300));
          return null;
        }
        return parseJsonText(extractText(parsed));
      }
      return null;
    };

    // ---- market data -----------------------------------------------------
    const fetchSeries = async (row: PostmortemRow, evalInterval: string): Promise<Candle[] | null> => {
      const createdMs = Date.parse(row.created_at);
      const qs = query({
        symbol: row.pair,
        interval: evalInterval,
        start_date: tdDate(createdMs - PRE_SIGNAL_MS),
        outputsize: "5000",
        timezone: "UTC",
        apikey: twelveDataKey,
      });
      try {
        const res = await fetch(`${TWELVE_DATA}?${qs}`);
        const parsed = await res.json().catch(() => null);
        if (!res.ok || !isRecord(parsed) || parsed.status === "error") {
          console.error("market data error:", res.status, isRecord(parsed) ? String(parsed.message ?? "").slice(0, 200) : "");
          return null;
        }
        const candles = parseCandles(parsed.values);
        return candles.length > 0 ? candles : null;
      } catch (err) {
        console.error("market data fetch failed:", err instanceof Error ? err.message : String(err));
        return null;
      }
    };

    // ---- diagnoses -------------------------------------------------------
    const diagnosed: Array<{ id: string; cause: string; outcome: string; shadow: boolean }> = [];
    const errors: string[] = [];
    let newLessons = 0;

    // Every named id is accounted for, before a single diagnosis is
    // attempted. An id can fall out of the run in several ways and only one of
    // them used to say so: the loop's own `deferred (time budget)` line. The
    // rest were silent, which is how request 1035 (2026-09-07) reported
    // `{"candidates":4,"due":4,"diagnosed":3,"errors":[]}` — a fourth row
    // dropped by the limit, and, when it was re-run on its own, diagnosed
    // differently. Naming a row is a question; a question deserves an answer
    // even when the answer is "not this run".
    //
    // Worded like the deferred line — `<id>: <what happened>` — so one reader
    // and one grep cover all of them.
    //
    // Entries rejected before the query ran (not a plan id, past
    // MAX_PLANS_ADMIN) are answered for too, so `requested_ids` in the summary
    // reconciles against `diagnosed` plus `errors` whatever the caller sent.
    errors.push(...parsedIds.rejected);
    if (options.ids.length > 0) {
      // One extra read, targeted runs only, to tell "there is no such row"
      // from "the row is there and neither candidate query wants it". Without
      // it both came out as "no settled plan with this id" — and on
      // 2026-09-07 the table held ten ungradeable WAITs and one unsettled
      // trade against two gradeable WAITs, so the misleading branch was the
      // likely one. The ids reaching here are uuid-shaped (targeted.ts), so
      // this probe cannot fail the way the candidate queries could.
      const presentRows = await readRowsOrNull(
        `analyses?select=id&id=in.(${options.ids.map(encodeURIComponent).join(",")})&limit=${MAX_PLANS_ADMIN}`,
      );
      errors.push(...unaccountedIds(
        options.ids,
        {
          due: new Set(due.map((d) => d.row.id)),
          queued: new Set(rows.map((d) => d.row.id)),
          fetched: new Set(
            [...candidates, ...waitCandidates].map((r) => strOrNull(r.id)).filter((v): v is string => v !== null),
          ),
          present: presentRows === null
            ? null
            : new Set(presentRows.map((r) => strOrNull(r.id)).filter((v): v is string => v !== null)),
          unavailable: candidatesOrNull === null || waitCandidatesOrNull === null,
        },
        options.limit,
      ));
    }

    const markFailed = async (row: PostmortemRow, raw: JsonRecord, error: string) => {
      const prior = isRecord(raw.postmortem) ? raw.postmortem : null;
      if (prior?.status === "done") {
        // A revisit that failed: the diagnosis it was going to refine stays
        // as it is; only the failed attempt is noted on it
        const attempts = (numberOrNull(prior.revisit_attempts) ?? 0) + 1;
        await patchRows(`analyses?id=eq.${encodeURIComponent(row.id)}`, {
          postmortem: { ...prior, revisit_attempts: attempts, revisit: { status: "failed", error, checked_at: nowIso } },
        });
      } else {
        const prev = prior ? numberOrNull(prior.attempts) ?? 0 : 0;
        await patchRows(`analyses?id=eq.${encodeURIComponent(row.id)}`, {
          postmortem: { schema: SCHEMA_VERSION, version: POSTMORTEM_VERSION, status: "failed", error, attempts: prev + 1, checked_at: nowIso },
        });
      }
      errors.push(`${row.id}: ${error}`);
    };

    for (const { row, raw, wait } of due) {
      if (elapsed() > START_DIAGNOSIS_BEFORE_MS) {
        errors.push(`${row.id}: deferred (time budget)`);
        continue;
      }
      const evalInterval = EVAL_INTERVAL[row.interval] ?? "1h";
      const candles = await fetchSeries(row, evalInterval);
      if (!candles) {
        await markFailed(row, raw, "no_data");
        continue;
      }

      const result = isRecord(raw.result) ? raw.result : {};
      const mcd = isRecord(result.market_context_detail) ? result.market_context_detail : null;
      const context = isRecord(raw.context) ? raw.context : null;
      const contextEntry = context && isRecord(context.entry) ? context.entry : null;
      const entryCheck = isRecord(raw.entry_check) ? raw.entry_check : null;

      let facts: PostmortemFacts;
      try {
        facts = await computeFacts(row, candles, evalInterval, nowMs, {
          declaredMode: mcd && typeof mcd.mode === "string" ? mcd.mode : null,
          adx: contextEntry ? numberOrNull(contextEntry.adx) : null,
          atr: (contextEntry ? numberOrNull(contextEntry.atr) : null) ?? (entryCheck ? numberOrNull(entryCheck.atr) : null),
          momentum: entryCheck ? entryCheck.momentum === true : null,
          events: calendar,
          contract: strOrNull(raw.plan_contract),
          wait: wait ? { untilMs: wait.untilMs, hint: wait.hint } : null,
        });
      } catch (err) {
        await markFailed(row, raw, `facts: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }

      const ev = row.evaluation;
      const planVersion = numberOrNull(raw.rulebook_version);
      // The rules the plan was actually shown (the prompt has a character
      // budget); older plans without that record get the whole version
      const versionRules = planVersion === null ? [] : rulesByVersion.get(planVersion) ?? [];
      const shownIds = context && Array.isArray(context.rules_shown)
        ? new Set(context.rules_shown.filter((v): v is string => typeof v === "string"))
        : null;
      const rulesInForce = shownIds ? versionRules.filter((r) => shownIds.has(r.id)) : versionRules;
      const plan: PlanSummary = {
        id: row.id,
        pair: row.pair,
        interval: row.interval,
        signal: row.signal,
        mode: strOrNull(raw.mode),
        confidence: numberOrNull(raw.confidence),
        thesis: strOrNull(raw.thesis),
        entry: row.entry_point,
        stop_loss: row.stop_loss,
        take_profit_1: row.take_profit_1,
        take_profit_2: row.take_profit_2,
        take_profit_3: row.take_profit_3,
        price_at_signal: row.price_at_signal,
        created_at: row.created_at,
        outcome: row.outcome,
        reason: ev?.reason ?? null,
        filled_at: ev?.filled_at ?? null,
        resolved_at: ev?.resolved_at ?? row.closed_at,
        mfe_r: ev?.mfe_r ?? null,
        mae_r: ev?.mae_r ?? null,
        tps_hit: Array.isArray(ev?.tps_hit) ? ev.tps_hit : [],
        key_factors: strList(result.key_factors),
        warnings: strList(result.warnings),
        analysis: typeof result.analysis === "string" ? result.analysis : "",
        market_context_detail: mcd,
        timeframe_alignment: Array.isArray(result.timeframe_alignment) ? result.timeframe_alignment : [],
        entry_check: entryCheck,
        context,
        contract: strOrNull(raw.plan_contract),
        shadow: raw.shadow === true,
        rules_in_force: rulesInForce.map((r) => ({ id: r.id, text_ja: r.text_ja })),
      };

      // A WAIT is graded on one question — was declining right? — and its
      // facts describe a trade that was never taken, so the prompt has to say
      // so or the lessons come out as position management.
      const prompt = wait
        ? buildWaitDiagnosisPrompt({ ...plan, signal: "WAIT", wait_plan: wait.plan, wait_check: wait.check }, facts)
        : buildDiagnosisPrompt(plan, facts);
      let answer: unknown = null;
      try {
        answer = await askModel(prompt.system, prompt.user, prompt.schema, 2500);
      } catch (err) {
        await markFailed(row, raw, `model: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      // The deterministic hint stands when the model's cause is not one of
      // ours — so on a WAIT it has to be a WAIT cause. facts.hints are built
      // from the trade taxonomy and would otherwise file "direction_wrong"
      // against a call that never entered.
      const diagnosis = parseDiagnosis(
        answer,
        wait ? [wait.hint] : facts.hints,
        rulesInForce.map((r) => r.id),
        strOrNull(raw.plan_contract),
        wait ? "WAIT" : row.signal,
        // For the three causes the model may not simply assert: the parser
        // checks direction_wrong / stop_too_tight / target_too_far against the
        // same arithmetic the deterministic hint used, so deleting the loss
        // branch's fallback cannot be undone by the model repeating what it
        // used to say.
        facts,
      );
      if (!diagnosis) {
        await markFailed(row, raw, "no_diagnosis");
        continue;
      }

      const priorDoc = isRecord(raw.postmortem) ? raw.postmortem : null;
      // What the earlier reading of this same row had said. Until now `stored`
      // went straight over the row and the earlier diagnosis was gone: twenty
      // of the thirty-two lessons in the table rest on eight bars or fewer
      // (counted in production 2026-09-08), MAX_REVISIONS is 1, and this
      // revisit is therefore the only occasion there will ever be to record
      // what the shallow reading claimed. Without it the question "did depth
      // change the answer" is unanswerable after the fact, because the
      // before-half has been overwritten. Six rows are already past saving:
      // they spent their revision before this field existed, and three of
      // those are WAITs that spent it on the permanent-thin bug fixed below.
      const priorTrail = Array.isArray(priorDoc?.prior) ? priorDoc.prior : [];
      const priorFacts = isRecord(priorDoc?.facts) ? priorDoc.facts : null;
      const priorLesson = isRecord(priorDoc?.lesson) ? priorDoc.lesson : null;
      // Enumerated field by field rather than spread: a snapshot carrying its
      // own `prior`, or the whole `facts` object, squares the document on
      // every revision, and these are already 8-10 KB apiece. What survives is
      // what a later reader needs to answer whether the shallow reading said
      // something else — the verdict and evidence prose are not part of that.
      // Capped the way the rulebook caps its history.
      const prior = priorDoc?.status === "done"
        ? [...priorTrail.slice(-(HISTORY_KEEP - 1)), {
          version: strOrNull(priorDoc.version),
          created_at: strOrNull(priorDoc.created_at),
          cause: strOrNull(priorDoc.cause),
          secondary_causes: Array.isArray(priorDoc.secondary_causes) ? priorDoc.secondary_causes : [],
          // `=== true` would file a document that never stated avoidable as
          // one that stated false, and the comparison this snapshot exists to
          // make would then count a flip that was never measured. Every other
          // field here keeps "absent" distinguishable for the same reason.
          avoidable: typeof priorDoc.avoidable === "boolean" ? priorDoc.avoidable : null,
          confidence: numberOrNull(priorDoc.confidence),
          rule_blamed: strOrNull(priorDoc.rule_blamed),
          rule_credited: strOrNull(priorDoc.rule_credited),
          lesson: { ja: strOrNull(priorLesson?.ja), en: strOrNull(priorLesson?.en) },
          // Lifted out of facts so the depth of the earlier reading travels
          // without the object it came from
          bars_after_settlement: numberOrNull(priorFacts?.bars_after_settlement),
          thin: typeof priorDoc.thin === "boolean" ? priorDoc.thin : null,
        }]
        : priorTrail;
      const stored = {
        schema: SCHEMA_VERSION,
        version: POSTMORTEM_VERSION,
        status: "done",
        model: MODEL,
        // Few bars after the settlement: the diagnosis rests on very little.
        // NOT false on a WAIT but null: facts.ts short-circuits the aftermath
        // of a call that never traded to an empty array on purpose, so
        // bars_after_settlement is 0 by construction and `thin` was
        // permanently true — reporting "shallow" about a measurement that was
        // never taken. false would be the opposite lie, asserting depth that
        // was equally never measured; null is the only value that says the
        // question does not apply here. Safe to introduce now because the
        // `thin.is.null` branch of retryFilter — which used to mean "written
        // by a build too old to record thinness" — is gone in this same
        // deploy, so a null no longer pulls the row into a revisit.
        thin: wait ? null : facts.bars_after_settlement < MIN_AFTER_BARS,
        // Only the automatic revisit spends the one revision each diagnosis
        // gets; a hand-run by id does not
        revisions: (numberOrNull(priorDoc?.revisions) ?? 0) + (priorDoc?.status === "done" && options.ids.length === 0 ? 1 : 0),
        // Every reading this row has had before this one, oldest first
        prior,
        cause: diagnosis.cause,
        secondary_causes: diagnosis.secondary_causes,
        avoidable: diagnosis.avoidable,
        confidence: diagnosis.confidence,
        verdict: { ja: diagnosis.verdict_ja, en: diagnosis.verdict_en },
        evidence: { ja: diagnosis.evidence_ja, en: diagnosis.evidence_en },
        lesson: { ja: diagnosis.lesson_ja, en: diagnosis.lesson_en },
        scope: diagnosis.scope,
        rule_blamed: diagnosis.rule_blamed,
        rule_credited: diagnosis.rule_credited,
        rulebook_version: planVersion,
        // What was diagnosed. On a WAIT the facts below measure a trade that
        // was never taken, and a reader who assumes otherwise reads a
        // position that never existed.
        subject: wait ? "wait" : "trade",
        wait_plan: wait ? wait.plan : undefined,
        facts,
        created_at: nowIso,
      };
      // The lesson goes in FIRST. Marking the diagnosis done and then failing
      // to write the lesson stranded the row for good: a done row that has
      // spent its revision matches no branch of retryFilter, and the
      // consolidation that rewrites the rulebook reads the lessons table, so
      // that plan's experience never reached the rules again. The reverse order is safe —
      // a lesson without the done marker is re-diagnosed next run and the
      // insert is idempotent on analysis_id.
      // Filed under what the row actually is: signal WAIT, outcome skipped.
      // `row` above carries the hypothetical trade's direction and outcome,
      // and filing a lesson under those would put a win in the record for a
      // trade nobody took.
      const lessonOk = await writeLesson(
        row.id,
        raw,
        stored,
        wait ? { ...row, signal: "WAIT", outcome: "skipped" } : row,
      );
      if (lessonOk) newLessons++;
      else errors.push(`${row.id}: lesson not written, left for the repair pass`);

      // The diagnosis is stored either way. Skipping the done marker on a
      // failed insert put the row straight back at the head of the queue —
      // it is ordered by closed_at and nothing incremented attempts — so the
      // same plan would be re-diagnosed, at the price of a model call, on
      // every sweep forever, starving every plan behind it. The repair pass
      // below rebuilds the lesson from this stored document with no model
      // call, which is the cheap half of the work and the only half that
      // failed.
      const written = await patchRows(`analyses?id=eq.${encodeURIComponent(row.id)}`, { postmortem: stored });
      if (written === 0) {
        errors.push(`${row.id}: not written`);
        continue;
      }
      diagnosed.push({
        id: row.id,
        cause: diagnosis.cause,
        outcome: wait ? "skipped" : row.outcome,
        shadow: raw.shadow === true,
      });
    }

    // ---- repair: lessons that do not match the diagnosis on the row --------
    // Before the ordering was fixed, a failed lesson insert left a row marked
    // done with no lesson, and retryFilter cannot see such a row again (a done
    // row that has spent its revision matches none of its branches). The
    // diagnosis itself is on the row, so the lesson can be rebuilt from it
    // with no model call — this recovers the rows already stranded, and covers
    // any future insert that fails after the diagnosis has been stored.
    //
    // A lesson that EXISTS but was projected from a diagnosis since rewritten
    // is the same failure wearing different clothes, and the pass could not
    // see it because it only ever looked for absence. Analysis 321bccaa was
    // carrying a v16 lesson under a v17 diagnosis: the rulebook editor reads
    // the lessons table, so it was being shown a cause and a lesson text that
    // no longer exist anywhere on the row they claim to summarize. The
    // revisit shipping in this build makes that the common case rather than
    // the exception, because every done row is about to be re-diagnosed once.
    // Rewriting is a pure re-projection through the same writeLesson: the
    // diagnosis is not touched and the model is not asked anything.
    let repaired = 0;
    let restated = 0;
    try {
      // Ids first. The documents are 8-10 KB apiece (the whole facts object,
      // plus a 60-point path on the evaluation), and in the common case none
      // of them is needed at all — fetching 200 of those every sweep to
      // compute a set difference is megabytes of JSON thrown away 96 times a
      // day. The version rides along with the id because PostgREST can alias
      // a JSON path in select: one short string per row answers "which build
      // wrote this" without fetching the document it came from.
      const doneIdRows = (await readRowsOrNull(
        // Ordered by created_at, not closed_at: a WAIT row's closed_at is
        // always NULL (its settlement time lives inside wait_check), so
        // nullslast sorted every WAIT behind every diagnosed trade and a
        // stranded WAIT lesson could never be repaired.
        `analyses?select=id,doc_version:postmortem->>version&postmortem->>status=eq.done&order=created_at.desc&limit=${REPAIR_SCAN}`,
      )) ?? [];
      const docVersion = new Map<string, string | null>();
      for (const r of doneIdRows) {
        const id = String(r.id ?? "");
        if (id) docVersion.set(id, strOrNull(r.doc_version));
      }
      const ids = [...docVersion.keys()];
      if (ids.length > 0) {
        const haveLessons = await readRowsOrNull(
          `lessons?select=analysis_id,postmortem_version&analysis_id=in.(${ids.map(encodeURIComponent).join(",")})`,
        );
        // A read that failed is not proof that no lesson exists. Treating it
        // as an empty set would upsert over rows that are already there and
        // report them as recoveries.
        if (haveLessons === null) {
          errors.push("repair: lessons unavailable, skipped");
          throw new Error("skip repair");
        }
        const lessonVersion = new Map<string, string | null>();
        for (const l of haveLessons) {
          const id = String(l.analysis_id ?? "");
          if (id) lessonVersion.set(id, strOrNull(l.postmortem_version));
        }
        const missingIds = ids.filter((id) => !lessonVersion.has(id));
        // Written by a build other than the one whose diagnosis is on the row.
        // A lesson from before the column existed reads null here and is
        // rewritten too, which is the only way it ever acquires a version.
        const staleIds = ids.filter((id) =>
          lessonVersion.has(id) && lessonVersion.get(id) !== docVersion.get(id)
        );
        // Absences first: a row with no lesson at all is invisible to the
        // rulebook editor, where a stale one is merely wrong.
        const repairIds = [...missingIds, ...staleIds].slice(0, REPAIR_PER_RUN);
        const stale = new Set(staleIds);
        const missing = repairIds.length === 0 ? [] : (await readRowsOrNull(
          `analyses?select=id,user_id,pair,interval,signal,mode,outcome,shadow,plan_contract,created_at,closed_at,evaluation,postmortem` +
            `&id=in.(${repairIds.map(encodeURIComponent).join(",")})`,
        )) ?? [];
        for (const raw of missing.slice(0, REPAIR_PER_RUN)) {
          const doc = isRecord(raw.postmortem) ? raw.postmortem : null;
          const id = strOrNull(raw.id);
          // A diagnosis with no lesson text is nothing to rebuild from
          const lesson = doc && isRecord(doc.lesson) ? doc.lesson : null;
          if (!id || !doc || !lesson || (!strOrNull(lesson.ja) && !strOrNull(lesson.en))) continue;
          const ok = await writeLesson(id, raw, doc, {
            pair: String(raw.pair ?? ""),
            interval: String(raw.interval ?? ""),
            signal: String(raw.signal ?? ""),
            outcome: String(raw.outcome ?? ""),
            created_at: String(raw.created_at ?? nowIso),
            // Rebuilt lessons carry the settlement time too, or the repair
            // path would quietly write the very rows whose missing
            // plan_closed_at this build exists to stop.
            closed_at: strOrNull(raw.closed_at),
          });
          if (ok) {
            if (stale.has(id)) restated++;
            else repaired++;
            newLessons++;
          } else {
            errors.push(`${id}: lesson repair failed`);
          }
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message !== "skip repair") errors.push(`repair: ${message}`);
    }

    // ---- rulebook ----------------------------------------------------------
    // Rewritten only when enough new lessons have gathered since the current
    // version (or a day has passed with at least one), so that each version
    // stays in force long enough for the plans made under it to settle and
    // be scored against it. A hand-run with `consolidate` skips the wait.
    //
    // Whether this run happened to write a lesson is NOT part of that
    // decision, though it used to be, and that is how the rulebook froze:
    // this branch was gated on `newLessons > 0`, so once the diagnosis
    // backlog cleared, every tick had nothing new to write and skipped the
    // revision — while lessons that had already accumulated sat unconsolidated
    // indefinitely. Measured: seventeen hours and seven lessons past due,
    // across roughly seventy ticks, none of which even looked. `revisionDue`
    // below already asks the only question that matters — how much has
    // gathered since the version in force — so ask it every time.
    let rulebook: JsonRecord | null = null;
    // Set when a candidate that had been waiting is promoted; reported even
    // when no new revision is written this run, so a promotion is never silent.
    let promotedCandidate: JsonRecord | null = null;
    // How many accounts the shared rulebook is actually being learned from.
    // Reported because "one" and "many" are different systems, and the
    // difference is invisible in the rules themselves.
    let lessonContributors = 0;
    let recordContributors = 0;
    if (rulebookUnavailable) {
      errors.push("rulebook: unavailable, not revised");
    } else if (consolidationBudget() < MIN_CONSOLIDATION_MS) {
      // The other half of the freeze: running out of clock here was silent,
      // and it got likelier the more there was to learn from, because each
      // diagnosis ahead of it costs a model call. Say so, so a rulebook that
      // is not moving can be told from one that has nothing to do. The gate
      // is the budget itself, so it defers exactly when what is left is too
      // little to finish in rather than at a threshold guessed separately.
      rulebook = {
        version: current ? numberOrNull(current.version) ?? 0 : 0,
        revised: false,
        reason: "deferred_time_budget",
        elapsed_ms: elapsed(),
        budget_ms: consolidationBudget(),
      };
      errors.push(`rulebook: deferred (time budget, ${elapsed()}ms elapsed)`);
    } else {
      // plan_closed_at is in this list for one reason: without it the episode
      // rule's reopen escape cannot fire. It read a settlement time that was
      // never selected, off a column that did not exist, so every lesson
      // arrived with closed_at null and separate decisions inside a day were
      // counted as one. A rule's support is a count of episodes, and support 0
      // is what drops a rule.
      // bars_after_settlement and postmortem_version are on the end for the
      // same kind of reason as plan_closed_at is on the list at all: a column
      // that is written and never selected is a column nobody reads. The
      // editor is being handed how deep the aftermath under each lesson was.
      const lessonSelect = "analysis_id,user_id,plan_contract,pair,cause,outcome,interval,signal,mode,order_type,lesson_ja,lesson_en,confidence,avoidable,shadow,scope,created_at,analysis_created_at,plan_closed_at,rule_blamed,rule_credited,bars_after_settlement,postmortem_version";
      // Over-fetched so the round-robin has something to choose from: taking
      // the newest RECENT_LESSONS and only then sharing them out would already
      // have thrown away every account the busiest one outran.
      // `?? []` here was the whole of a silent stop. readRowsOrNull returns
      // null when the read FAILED, and coercing that to an empty array made an
      // unreachable lessons table indistinguishable from an empty one: the
      // run reported reason "no_lessons", pushed nothing onto `errors`, and
      // the loop stood still while nineteen lessons sat in the table. The
      // first thing to trip it would have been this build's own new column —
      // PostgREST rejects a select naming a column that does not exist, so
      // deploying before the migration lands takes out the whole learning
      // path and calls it an absence of lessons. The two reads either side of
      // this one already keep the distinction; this was the one that did not.
      const lessonPoolOrNull = await readRowsOrNull(
        `lessons?select=${lessonSelect}&order=created_at.desc&limit=${RECENT_LESSONS * FAIR_FETCH_MULTIPLE}`,
      );
      const lessonsUnavailable = lessonPoolOrNull === null;
      const lessonPool = lessonPoolOrNull ?? [];
      if (lessonsUnavailable) errors.push("rulebook: lessons unavailable, not revised");
      const lessonRows = fairShare(lessonPool, (l) => strOrNull(l.user_id) ?? "", RECENT_LESSONS);
      lessonContributors = new Set(lessonPool.map((l) => strOrNull(l.user_id) ?? "")).size;
      // The lessons the current rules cite stay in evidence even once they
      // are older than the recent window, so a rule's support cannot decay
      // just because time passed. If they cannot be read this run, the
      // rulebook is left alone rather than rewritten on partial evidence.
      const recentIds = new Set(lessonRows.map((l) => String(l.analysis_id ?? "")));
      const citedOlder = [...new Set(currentRules.flatMap((r) => r.supported_by))].filter((id) => id && !recentIds.has(id));
      let evidenceComplete = true;
      if (citedOlder.length > 0) {
        const older = await readRowsOrNull(
          `lessons?select=${lessonSelect}&analysis_id=in.(${citedOlder.map(encodeURIComponent).join(",")})&limit=${RECENT_LESSONS}`,
        );
        if (older === null) evidenceComplete = false;
        else lessonRows.push(...older);
      }
      const lessons: LessonRow[] = withClusters(lessonRows.map((l) => ({
        analysis_id: String(l.analysis_id ?? ""),
        user_id: strOrNull(l.user_id),
        contract: strOrNull(l.plan_contract),
        pair: String(l.pair ?? ""),
        cause: String(l.cause ?? "inconclusive"),
        outcome: String(l.outcome ?? ""),
        interval: String(l.interval ?? ""),
        signal: String(l.signal ?? ""),
        mode: strOrNull(l.mode),
        order_type: strOrNull(l.order_type),
        lesson_ja: String(l.lesson_ja ?? ""),
        lesson_en: String(l.lesson_en ?? ""),
        confidence: numberOrNull(l.confidence),
        avoidable: typeof l.avoidable === "boolean" ? l.avoidable : null,
        shadow: l.shadow === true,
        scope: isRecord(l.scope) ? strOrNull(l.scope.text) : null,
        created_at: String(l.created_at ?? ""),
        plan_created_at: strOrNull(l.analysis_created_at),
        plan_closed_at: strOrNull(l.plan_closed_at),
        rule_blamed: strOrNull(l.rule_blamed),
        rule_credited: strOrNull(l.rule_credited),
        bars_after_settlement: numberOrNull(l.bars_after_settlement),
        postmortem_version: strOrNull(l.postmortem_version),
      })));

      const previousRules: Rule[] = current ? parseRules(current.rules) : [];
      // Which definition of "one situation" the LIVE rules' support was
      // counted under. A rulebook written before the stamp existed carries no
      // number, and that absence is the answer rather than a gap: definition
      // 1, the four divergent implementations. Recorded on the history entry
      // when these rules are archived, because `support` is an episode count,
      // it is the number that decides whether a rule survives, and a v8 rule
      // reading support 2 is otherwise indistinguishable from a v9 rule
      // reading support 2 counted a different way.
      const liveEpisodeDefinition = numberOrNull(
        (isRecord(current?.stats) ? current.stats : {}).episode_definition_version,
      ) ?? 1;
      const previousVersion = current ? numberOrNull(current.version) ?? 0 : 0;
      const updatedAt = current ? strOrNull(current.updated_at) : null;
      const priorCandidate = current && isRecord(current.candidate) ? current.candidate : null;
      // Paced against the last revision WRITTEN, promoted or not. Pacing
      // against updated_at instead would leave a blocked promotion asking the
      // model for a fresh candidate on every sweep, and would never let the
      // "new lessons since" counter reset.
      const lastRevisionAt = strOrNull(priorCandidate?.created_at) ?? updatedAt;

      // How much evidence the live version has actually gathered. Read once
      // and shared by both the promotion of a stored candidate and the gate on
      // a freshly written one.
      //
      // A read that fails is NOT zero decided trades: coercing it to zero
      // demotes a revision that had earned promotion and reports the coercion
      // as a measured fact.
      const decidedRows = previousVersion > 0
        ? await readRowsOrNull(decidedRowsPath(previousVersion))
        : [];
      // Counted in independent situations. The rows carry pair, direction and
      // both timestamps because that is what deciding "same situation" needs;
      // the old `select=id` gave every row the identical episode id, so the
      // count would have been one forever however large the population grew.
      const gate = promotionGate(
        previousVersion,
        decidedRows === null ? null : decidedRows.map((r): DecidedRow => ({
          pair: String(r.pair ?? ""),
          signal: String(r.signal ?? ""),
          created_at: String(r.created_at ?? ""),
          closed_at: strOrNull(r.closed_at),
        })),
      );
      const decidedEpisodes = gate.episodes;
      const measured = gate.measured;
      if (gate.unplaceable > 0) {
        // Rows came back, and not one of them said which situation it was.
        // That is the `select=id` failure recurring, and it reads as a real
        // count unless it is named.
        errors.push(`rulebook: ${gate.unplaceable} decided rows carry no situation, count refused`);
      } else if (decidedEpisodes === null) errors.push("rulebook: decided count unavailable");
      // A truncated read is a lower bound, not a wrong number (see
      // DECIDED_ROW_LIMIT), but a gate running on a bound should say so.
      if (gate.truncated) {
        errors.push(`rulebook: decided population truncated at ${DECIDED_ROW_LIMIT}, episodes are a lower bound`);
      }

      // A candidate that has been waiting is promoted as its own act, with no
      // model call and without waiting for the next revision to be due. Left
      // inside the revision branch it was unreachable: writing a candidate
      // resets the lessons-since counter, so `due` is false on the very next
      // run and the stored candidate could never be read again.
      if (priorCandidate && (measured || options.promote) && !rulebookUnavailable) {
        const candidateRules = parseRules(priorCandidate.rules);
        if (candidateRules.length === 0) {
          errors.push("rulebook: stored candidate has no usable rules");
        } else {
          const history = Array.isArray(current?.history) ? current.history : [];
          const nextHistory = previousRules.length > 0
            ? [...history.slice(-(HISTORY_KEEP - 1)), {
              version: previousVersion,
              rules: previousRules,
              updated_at: updatedAt,
              episode_definition_version: liveEpisodeDefinition,
            }]
            : history;
          const summary = isRecord(priorCandidate.summary) ? priorCandidate.summary : {};
          const n = await patchRows(`rulebook?id=eq.1&version=eq.${previousVersion}`, {
            version: previousVersion + 1,
            rules: candidateRules,
            summary,
            stats: {
              ...(isRecord(current?.stats) ? current.stats : {}),
              changes: isRecord(priorCandidate.changes) ? priorCandidate.changes : {},
              lessons_considered: numberOrNull(priorCandidate.lessons_considered) ?? 0,
              // The stamp travels with the candidate, not with today's build.
              // These rules' support was counted when the candidate was
              // WRITTEN, possibly runs ago and possibly under a different
              // definition; stamping the promotion with the current constant
              // would label definition-1 numbers as definition 2, which is
              // exactly the confusion the stamp exists to prevent. A candidate
              // stored before the stamp existed is definition 1.
              episode_definition_version: numberOrNull(priorCandidate.episode_definition_version) ?? 1,
              promoted_from_candidate: true,
            },
            history: nextHistory,
            updated_at: new Date().toISOString(),
            candidate: null,
          });
          if (n > 0) {
            promotedCandidate = {
              version: previousVersion + 1,
              revised: true,
              promoted: true,
              from_candidate: true,
              rules: candidateRules.length,
              decided_episodes_under_previous: decidedEpisodes,
              episode_definition_version: gate.episode_definition_version,
              decided_population_truncated: gate.truncated,
              forced: options.promote && !measured,
            };
            console.log("rulebook candidate promoted", { version: previousVersion + 1 });
          } else errors.push("rulebook: candidate not promoted (version changed underneath)");
        }
      }
      const lastRevisionMs = lastRevisionAt ? Date.parse(lastRevisionAt) : NaN;
      const sinceVersion = lessons.filter((l) => {
        const t = Date.parse(l.created_at);
        return !Number.isFinite(lastRevisionMs) || (Number.isFinite(t) && t > lastRevisionMs);
      }).length;
      const due = options.consolidate || revisionDue(sinceVersion, lastRevisionAt, nowMs);

      if (lessonsUnavailable) {
        // Checked before the emptiness test, because an unreadable table is
        // empty by that test and the two mean opposite things.
        rulebook = { version: previousVersion, revised: false, reason: "lessons_unavailable" };
      } else if (lessons.length === 0) {
        rulebook = { version: previousVersion, revised: false, reason: "no_lessons" };
      } else if (!evidenceComplete) {
        errors.push("rulebook: cited lessons unavailable, not revised");
        rulebook = { version: previousVersion, revised: false, reason: "evidence_unavailable" };
      } else if (!due) {
        rulebook = {
          version: previousVersion,
          revised: false,
          reason: "waiting",
          lessons_since_version: sinceVersion,
          lessons_needed: Math.max(0, MIN_NEW_LESSONS - sinceVersion),
        };
      } else {
        // plan_contract and the WAIT verdict are read here for the same
        // reason: without the first the two entry eras pool into one win
        // rate, and without the second the only call that can never be wrong
        // is also the only call nobody counts.
        const recordPool = await readRows(
          `analyses?select=id,user_id,pair,signal,created_at,closed_at,outcome,shadow,preview,rejection:entry_check->>rejection,filled_at:evaluation->>filled_at,fill_price:evaluation->>fill_price,entry_point,stop_loss,take_profit_1,outcome_price,rulebook_version,plan_contract,wait_verdict:wait_check->>verdict,wait_scorer:wait_check->>scorer&order=created_at.desc&limit=${RECENT_ROWS * FAIR_FETCH_MULTIPLE}`,
        );
        const recordRows = fairShare(recordPool, (r) => strOrNull(r.user_id) ?? "", RECENT_ROWS);
        recordContributors = new Set(recordPool.map((r) => strOrNull(r.user_id) ?? "")).size;
        const record: RecordRow[] = recordRows.map((r) => ({
          id: strOrNull(r.id) ?? undefined,
          user_id: strOrNull(r.user_id),
          pair: String(r.pair ?? ""),
          signal: String(r.signal ?? ""),
          created_at: String(r.created_at ?? ""),
          closed_at: strOrNull(r.closed_at),
          outcome: String(r.outcome ?? ""),
          shadow: r.shadow === true,
          // Selected so that summarizeRecord can leave weekend previews out of
          // the episode scan. It could not before: the column was not read, so
          // a preview row sat between two real plans and moved a boundary on
          // this side of the loop while performance_stats, which filters them
          // out before clustering, never saw it. One rule, two populations.
          preview: r.preview === true,
          rejection: strOrNull(r.rejection),
          filled: typeof r.filled_at === "string" && r.filled_at.length > 0,
          entry: numberOrNull(r.entry_point),
          stop: numberOrNull(r.stop_loss),
          tp1: numberOrNull(r.take_profit_1),
          fill_price: numberOrNull(r.fill_price),
          outcome_price: numberOrNull(r.outcome_price),
          rulebook_version: numberOrNull(r.rulebook_version),
          contract: strOrNull(r.plan_contract),
          wait_verdict: strOrNull(r.wait_verdict),
          wait_scorer: numberOrNull(r.wait_scorer),
        }));
        const stats = summarizeRecord(record, lessons);

        const prompt = buildConsolidationPrompt(previousRules, lessons, stats);
        let answer: unknown = null;
        try {
          answer = await askModel(prompt.system, prompt.user, CONSOLIDATION_SCHEMA, 4000, consolidationBudget());
        } catch (err) {
          errors.push(`rulebook: model ${err instanceof Error ? err.message : String(err)}`);
        }
        // The contract the emitted rules are TESTED against, not the stamp they
        // receive. parseConsolidation derives each rule's stamp with stampFor
        // from that rule's own cause and its own text, on both the emit and the
        // restore path; a rule the analyst cannot carry out here comes back
        // with contract null and stays out of every prompt
        // (analyze/rules.ts inForce) however enthusiastically it was re-emitted.
        const consolidated = parseConsolidation(answer, previousRules, nowIso, lessons, PLAN_CONTRACT);
        if (!consolidated) {
          errors.push("rulebook: no usable answer");
        } else {
          const history = Array.isArray(current?.history) ? current.history : [];
          const nextHistory = previousRules.length > 0
            ? [...history.slice(-(HISTORY_KEEP - 1)), {
              version: previousVersion,
              rules: previousRules,
              updated_at: updatedAt,
              episode_definition_version: liveEpisodeDefinition,
            }]
            : history;
          // Stamped now, after this run's lessons were written, so they are
          // not counted as new again by the next run; and written only over
          // the version that was read, so a concurrent rewrite is not lost
          const stampIso = new Date().toISOString();
          // Writing a revision and putting it in front of the analyst are two
          // different acts. Versions 6, 7 and 8 were each replaced before a
          // single trade under them closed, so no version was ever measured
          // and no comparison between two of them was possible. The revision
          // is still written every time experience calls for one; it waits in
          // `candidate` until the live version has enough decided trades to
          // have been worth measuring.
          // A candidate promoted moments ago already moved the version out
          // from under the optimistic guard below, so this run writes nothing
          // more; the fresh revision becomes next run's candidate.
          const promote = (measured || options.promote) && promotedCandidate === null;
          if (promote) {
            const n = await patchRows(`rulebook?id=eq.1&version=eq.${previousVersion}`, {
              version: previousVersion + 1,
              rules: consolidated.rules,
              summary: { ja: consolidated.summary_ja, en: consolidated.summary_en },
              stats: { ...stats, changes: consolidated.changes, lessons_considered: lessons.length },
              history: nextHistory,
              updated_at: stampIso,
              candidate: null,
            });
            if (n > 0) {
              rulebook = {
                version: previousVersion + 1,
                revised: true,
                promoted: true,
                rules: consolidated.rules.length,
                changes: consolidated.changes,
                decided_episodes_under_previous: decidedEpisodes,
                episode_definition_version: gate.episode_definition_version,
                decided_population_truncated: gate.truncated,
                forced: options.promote && !measured,
              };
              console.log("rulebook revised", { version: previousVersion + 1, changes: consolidated.changes });
            } else errors.push("rulebook: not written (version changed underneath, or write failed)");
          } else {
            // Held back. The candidate is replaced each time rather than
            // queued, so what is waiting is always the freshest reading of
            // the evidence.
            const n = await patchRows(`rulebook?id=eq.1&version=eq.${previousVersion}`, {
              candidate: {
                base_version: previousVersion,
                rules: consolidated.rules,
                summary: { ja: consolidated.summary_ja, en: consolidated.summary_en },
                changes: consolidated.changes,
                lessons_considered: lessons.length,
                // Stamped where the counting happened. A candidate can wait
                // several runs before it is promoted, and the promotion copies
                // its rules through without recounting them, so the definition
                // has to be recorded here or it is lost by the time anyone can
                // ask which one produced these support numbers.
                episode_definition_version: EPISODE_DEFINITION_VERSION,
                created_at: stampIso,
              },
            });
            if (n > 0) {
              rulebook = {
                version: previousVersion,
                revised: false,
                promoted: false,
                reason: "candidate_held",
                candidate_rules: consolidated.rules.length,
                changes: consolidated.changes,
                // Episodes, not rows, and named so: ten plans on one pair in
                // one afternoon are one reading restated ten times, and the
                // old key counted those as ten measurements.
                decided_episodes_under_version: decidedEpisodes,
                decided_needed: gate.needed,
                episode_definition_version: gate.episode_definition_version,
                decided_population_truncated: gate.truncated,
              };
              console.log("rulebook candidate held", {
                base: previousVersion,
                episodes: decidedEpisodes,
                needed: MIN_DECIDED_EPISODES,
              });
            } else errors.push("rulebook: candidate not written (version changed underneath, or write failed)");
          }
        }
      }
    }

    const summary = {
      ok: true,
      mode: scope.kind,
      // Two queries feed one queue now, so one number cannot describe both:
      // `candidates` counted only the settled trades, and a run that
      // diagnosed three WAITs reported finding nothing to work on.
      candidates: candidates.length + waitCandidates.length,
      trade_candidates: candidates.length,
      wait_candidates: waitCandidates.length,
      due: rows.length,
      // Whether this run was aimed at named rows. It is the difference
      // between a scheduled sweep and an operator action — the cooldown, the
      // limit and the state row below all treat the two differently — and a
      // reader of last_result could not otherwise tell them apart.
      targeted,
      // How many ids the caller SENT, not how many survived parsing: request
      // 1035 was only noticeable at all by counting the response against what
      // had been sent, and a count that has already dropped the rejected ids
      // cannot be counted against anything. `requested_ids` equals the ids on
      // `results` plus the ids on `errors`, always.
      requested_ids: parsedIds.requested,
      diagnosed: diagnosed.length,
      lessons: newLessons,
      lessons_repaired: repaired,
      // Rewritten because the lesson was a projection of a diagnosis that has
      // since been replaced, as opposed to never having landed at all. Kept
      // apart because they say different things about the run.
      lessons_restated: restated,
      lesson_contributors: lessonContributors,
      record_contributors: recordContributors,
      rulebook: rulebook ?? promotedCandidate,
      promoted: promotedCandidate,
      results: diagnosed,
      errors,
      elapsedMs: elapsed(),
      version: POSTMORTEM_VERSION,
    };
    // The state row is the CRON's record of itself: loop_health reads
    // last_run_at and last_result->>diagnosed off it to say whether the sweep
    // is alive. A targeted run is not the sweep — it did not claim the slot
    // above and it does not report as one here, or an operator diagnosing two
    // named rows would show up as the schedule's last word on the queue.
    if (scope.kind === "sweep" && !targeted) {
      await patchRows("postmortem_state?id=eq.1", { last_result: { ...summary, at: nowIso } });
    }
    if (elapsed() > WALL_CLOCK_BUDGET_MS) console.warn("postmortem ran long", { elapsedMs: elapsed() });
    return json(summary);
  } catch (err) {
    console.error("postmortem error:", err);
    return json({ ok: false, error: "サーバーエラーが発生しました" }, 500);
  }
});
