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
import { EVAL_INTERVAL, type Evaluation } from "../track-outcomes/evaluate.ts";
import { MIN_AFTER_BARS, afterWindowMs, computeFacts, isPostmortemDue, type PostmortemFacts, type PostmortemRow } from "./facts.ts";
import { PLAN_CONTRACT } from "../_shared/contract.ts";
import {
  CONSOLIDATION_SCHEMA,
  MIN_NEW_LESSONS,
  buildConsolidationPrompt,
  buildDiagnosisPrompt,
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

const POSTMORTEM_VERSION = "postmortem-v10-2026-09-05T11:20:00Z";
const SCHEMA_VERSION = 2;
const MODEL = "claude-opus-5";
const ADMIN_EMAILS = ["k.munemoto@kyoto-salute.com", "munekan2989@gmail.com"];

const MIN = 60_000;
const HOUR = 60 * MIN;
const SWEEP_COOLDOWN_MS = 10 * MIN;
// Diagnoses per run: each one is a market-data request and a model turn
const MAX_PLANS_PER_RUN = 3;
const MAX_PLANS_ADMIN = 6;
const MAX_ATTEMPTS = 3;
// A diagnosis made on almost no aftermath is revisited once the full window
// of bars exists; this caps how often that happens.
const MAX_REVISIONS = 1;
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

    // ---- who is asking -------------------------------------------------
    let scope: Scope;
    const sweepToken = req.headers.get("x-sweep-token");
    if (sweepToken) {
      const tokenRes = await rest("rpc/track_outcomes_sweep_token", { method: "POST", body: "{}" });
      const expected = tokenRes.ok ? await tokenRes.json().catch(() => null) : null;
      if (typeof expected !== "string" || expected.length === 0 || !constantTimeEqual(sweepToken, expected)) {
        return json({ ok: false, error: "認証に失敗しました" }, 401);
      }
      const cutoff = encodeURIComponent(new Date(nowMs - SWEEP_COOLDOWN_MS).toISOString());
      const claimed = await patchRows(
        `postmortem_state?id=eq.1&or=(last_run_at.is.null,last_run_at.lt.${cutoff})`,
        { last_run_at: nowIso },
      );
      if (claimed === 0) {
        return json({ ok: true, mode: "sweep", diagnosed: 0, skipped: "cooldown", version: POSTMORTEM_VERSION });
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

    // Options for a hand-run (either caller is trusted): run on specific
    // rows, skip the after-settlement wait, force a rulebook rewrite
    const options = { force: false, ids: [] as string[], consolidate: false, limit: MAX_PLANS_PER_RUN };
    options.force = body.force === true;
    options.consolidate = body.consolidate === true;
    options.ids = strList(body.ids).slice(0, MAX_PLANS_ADMIN);
    const limit = numberOrNull(body.limit);
    if (limit !== null) options.limit = Math.max(1, Math.min(MAX_PLANS_ADMIN, Math.round(limit)));

    // ---- the rulebook, by version -------------------------------------------
    // Every plan records the rulebook version it was made under; the current
    // rules and the kept history say which rules that version held, so the
    // diagnosis can name the rule at fault and the consolidation can score
    // each rule on what its plans then did
    const rulebookRows = await readRowsOrNull("rulebook?id=eq.1&select=version,rules,history,updated_at");
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
    // Never diagnosed; failed and still retryable; diagnosed on too little
    // aftermath (thin) and not yet revisited; or diagnosed by a version that
    // did not record whether it was thin (the first one), which would
    // otherwise never be looked at again
    // A revisit that failed (no data, model down) is retried a few times and
    // then left alone, without touching the diagnosis it was revisiting
    const revisitRetryable = `or(postmortem->>revisit_attempts.is.null,postmortem->>revisit_attempts.lt.${MAX_ATTEMPTS})`;
    const retryFilter = [
      "or=(postmortem.is.null",
      `and(postmortem->>status.eq.failed,postmortem->>attempts.lt.${MAX_ATTEMPTS})`,
      `and(postmortem->>status.eq.done,postmortem->>thin.eq.true,postmortem->>revisions.lt.${MAX_REVISIONS},${revisitRetryable})`,
      `and(postmortem->>status.eq.done,postmortem->>thin.is.null,${revisitRetryable}))`,
    ].join(",");
    // Named rows are re-diagnosed whatever their state: that is what naming
    // them is for
    const rowFilter = options.ids.length > 0
      ? `id=in.(${options.ids.map(encodeURIComponent).join(",")})`
      : retryFilter;
    const candidates = await readRows(
      `analyses?outcome=in.(win,loss,untriggered,expired,ambiguous)&signal=in.(BUY,SELL)&${rowFilter}&select=${select}&order=closed_at.asc.nullsfirst&limit=40`,
    );

    const rows: Array<{ row: PostmortemRow; raw: JsonRecord }> = [];
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
      rows.push({ row, raw: r });
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

    for (const { row, raw } of due) {
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

      const prompt = buildDiagnosisPrompt(plan, facts);
      let answer: unknown = null;
      try {
        answer = await askModel(prompt.system, prompt.user, prompt.schema, 2500);
      } catch (err) {
        await markFailed(row, raw, `model: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      const diagnosis = parseDiagnosis(answer, facts.hints, rulesInForce.map((r) => r.id), strOrNull(raw.plan_contract));
      if (!diagnosis) {
        await markFailed(row, raw, "no_diagnosis");
        continue;
      }

      const priorDoc = isRecord(raw.postmortem) ? raw.postmortem : null;
      const stored = {
        schema: SCHEMA_VERSION,
        version: POSTMORTEM_VERSION,
        status: "done",
        model: MODEL,
        // Few bars after the settlement: revisit once the window fills out
        thin: facts.bars_after_settlement < MIN_AFTER_BARS,
        // Only the automatic revisit spends the one revision a thin
        // diagnosis gets; a hand-run by id does not
        revisions: (numberOrNull(priorDoc?.revisions) ?? 0) + (priorDoc?.status === "done" && options.ids.length === 0 ? 1 : 0),
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
        facts,
        created_at: nowIso,
      };
      const written = await patchRows(`analyses?id=eq.${encodeURIComponent(row.id)}`, { postmortem: stored });
      if (written === 0) {
        errors.push(`${row.id}: not written`);
        continue;
      }

      const lessonRes = await rest("lessons?on_conflict=analysis_id", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({
          analysis_id: row.id,
          user_id: strOrNull(raw.user_id),
          plan_contract: strOrNull(raw.plan_contract),
          pair: row.pair,
          interval: row.interval,
          signal: row.signal,
          mode: strOrNull(raw.mode),
          order_type: ev?.order_type ?? null,
          outcome: row.outcome,
          cause: diagnosis.cause,
          secondary_causes: diagnosis.secondary_causes,
          avoidable: diagnosis.avoidable,
          confidence: diagnosis.confidence,
          lesson_ja: diagnosis.lesson_ja,
          lesson_en: diagnosis.lesson_en,
          scope: diagnosis.scope ? { text: diagnosis.scope } : null,
          shadow: raw.shadow === true,
          rule_blamed: diagnosis.rule_blamed,
          rule_credited: diagnosis.rule_credited,
          // When the plan was made: what "same situation" is judged on
          analysis_created_at: row.created_at,
        }),
      });
      if (!lessonRes.ok) {
        errors.push(`${row.id}: lesson not written (${lessonRes.status}: ${(await lessonRes.text().catch(() => "")).slice(0, 120)})`);
      } else {
        await lessonRes.text().catch(() => {});
        newLessons++;
      }
      diagnosed.push({ id: row.id, cause: diagnosis.cause, outcome: row.outcome, shadow: raw.shadow === true });
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
      const lessonSelect = "analysis_id,user_id,plan_contract,pair,cause,outcome,interval,signal,mode,order_type,lesson_ja,lesson_en,confidence,avoidable,shadow,scope,created_at,analysis_created_at,rule_blamed,rule_credited";
      // Over-fetched so the round-robin has something to choose from: taking
      // the newest RECENT_LESSONS and only then sharing them out would already
      // have thrown away every account the busiest one outran.
      const lessonPool = (await readRowsOrNull(
        `lessons?select=${lessonSelect}&order=created_at.desc&limit=${RECENT_LESSONS * FAIR_FETCH_MULTIPLE}`,
      )) ?? [];
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
        rule_blamed: strOrNull(l.rule_blamed),
        rule_credited: strOrNull(l.rule_credited),
      })));

      const previousRules: Rule[] = current ? parseRules(current.rules) : [];
      const previousVersion = current ? numberOrNull(current.version) ?? 0 : 0;
      const updatedAt = current ? strOrNull(current.updated_at) : null;
      const updatedMs = updatedAt ? Date.parse(updatedAt) : NaN;
      const sinceVersion = lessons.filter((l) => {
        const t = Date.parse(l.created_at);
        return !Number.isFinite(updatedMs) || (Number.isFinite(t) && t > updatedMs);
      }).length;
      const due = options.consolidate || revisionDue(sinceVersion, updatedAt, nowMs);

      if (lessons.length === 0) {
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
          `analyses?select=id,user_id,pair,signal,created_at,closed_at,outcome,shadow,rejection:entry_check->>rejection,filled_at:evaluation->>filled_at,fill_price:evaluation->>fill_price,entry_point,stop_loss,take_profit_1,outcome_price,rulebook_version,plan_contract,wait_verdict:wait_check->>verdict&order=created_at.desc&limit=${RECENT_ROWS * FAIR_FETCH_MULTIPLE}`,
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
            ? [...history.slice(-(HISTORY_KEEP - 1)), { version: previousVersion, rules: previousRules, updated_at: updatedAt }]
            : history;
          // Stamped now, after this run's lessons were written, so they are
          // not counted as new again by the next run; and written only over
          // the version that was read, so a concurrent rewrite is not lost
          const stampIso = new Date().toISOString();
          const n = await patchRows(`rulebook?id=eq.1&version=eq.${previousVersion}`, {
            version: previousVersion + 1,
            rules: consolidated.rules,
            summary: { ja: consolidated.summary_ja, en: consolidated.summary_en },
            stats: { ...stats, changes: consolidated.changes, lessons_considered: lessons.length },
            history: nextHistory,
            updated_at: stampIso,
          });
          if (n > 0) {
            rulebook = { version: previousVersion + 1, revised: true, rules: consolidated.rules.length, changes: consolidated.changes };
            console.log("rulebook revised", { version: previousVersion + 1, changes: consolidated.changes });
          } else errors.push("rulebook: not written (version changed underneath, or write failed)");
        }
      }
    }

    const summary = {
      ok: true,
      mode: scope.kind,
      candidates: candidates.length,
      due: rows.length,
      diagnosed: diagnosed.length,
      lessons: newLessons,
      lesson_contributors: lessonContributors,
      record_contributors: recordContributors,
      rulebook,
      results: diagnosed,
      errors,
      elapsedMs: elapsed(),
      version: POSTMORTEM_VERSION,
    };
    if (scope.kind === "sweep") {
      await patchRows("postmortem_state?id=eq.1", { last_result: { ...summary, at: nowIso } });
    }
    if (elapsed() > WALL_CLOCK_BUDGET_MS) console.warn("postmortem ran long", { elapsedMs: elapsed() });
    return json(summary);
  } catch (err) {
    console.error("postmortem error:", err);
    return json({ ok: false, error: "サーバーエラーが発生しました" }, 500);
  }
});
