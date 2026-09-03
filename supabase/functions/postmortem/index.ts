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
// Callers: pg_cron every 15 minutes with the shared sweep token, and an
// admin with their JWT (to run it by hand, with `force` to skip the waits).

import { parseCandles, type Candle } from "../analyze/indicators.ts";
import { parseRules, type Rule } from "../analyze/rules.ts";
import { EVAL_INTERVAL, type Evaluation } from "../track-outcomes/evaluate.ts";
import { MIN_AFTER_BARS, afterWindowMs, computeFacts, isPostmortemDue, type PostmortemFacts, type PostmortemRow } from "./facts.ts";
import {
  CONSOLIDATION_SCHEMA,
  DIAGNOSIS_SCHEMA,
  buildConsolidationPrompt,
  buildDiagnosisPrompt,
  parseConsolidation,
  parseDiagnosis,
  summarizeRecord,
  type LessonRow,
  type PlanSummary,
} from "./prompt.ts";

const POSTMORTEM_VERSION = "postmortem-v1-2026-09-03T15:00:00Z";
const SCHEMA_VERSION = 1;
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
const START_CONSOLIDATION_BEFORE_MS = 95_000;
const LLM_TIMEOUT_MS = 45_000;
const RECENT_LESSONS = 60;
const RECENT_ROWS = 300;
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
    const readRows = async (path: string): Promise<JsonRecord[]> => {
      const res = await rest(path);
      if (!res.ok) {
        console.error("read failed:", path.split("?")[0], res.status, (await res.text().catch(() => "")).slice(0, 200));
        return [];
      }
      const rows = await res.json().catch(() => null);
      return Array.isArray(rows) ? rows.filter(isRecord) : [];
    };

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

    // ---- settled plans without a diagnosis --------------------------------
    const select = [
      "id", "user_id", "pair", "interval", "mode", "signal", "confidence", "thesis",
      "entry_point", "stop_loss", "take_profit_1", "take_profit_2", "take_profit_3",
      "price_at_signal", "created_at", "closed_at", "outcome", "evaluation",
      "entry_check", "context", "shadow", "result",
    ].join(",");
    const idFilter = options.ids.length > 0 ? `&id=in.(${options.ids.map(encodeURIComponent).join(",")})` : "";
    const retryFilter = [
      "or=(postmortem.is.null",
      `and(postmortem->>status.eq.failed,postmortem->>attempts.lt.${MAX_ATTEMPTS})`,
      `and(postmortem->>status.eq.done,postmortem->>thin.eq.true,postmortem->>revisions.lt.${MAX_REVISIONS}))`,
    ].join(",");
    const candidates = await readRows(
      `analyses?outcome=in.(win,loss,untriggered,expired,ambiguous)&signal=in.(BUY,SELL)&${retryFilter}${idFilter}&select=${select}&order=closed_at.asc.nullsfirst&limit=40`,
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
      if (!options.force) {
        if (!isPostmortemDue(row, nowMs)) continue;
        // A revision waits for the whole after-window, not just the first
        // couple of bars that made the original diagnosis thin
        const closed = row.closed_at ? Date.parse(row.closed_at) : NaN;
        if (isRevision && (!Number.isFinite(closed) || nowMs - closed < afterWindowMs(row.interval))) continue;
      }
      rows.push({ row, raw: r });
    }
    const due = rows.slice(0, options.limit);

    // ---- model ---------------------------------------------------------
    const anthropicHeaders = {
      "content-type": "application/json",
      "x-api-key": anthropicKey,
      "anthropic-version": "2023-06-01",
    };
    let effortEnabled = true;
    const askModel = async (system: string, user: string, schema: unknown, maxTokens: number): Promise<unknown> => {
      for (let attempt = 0; attempt < 2; attempt++) {
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
          signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
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
      const prev = isRecord(raw.postmortem) ? numberOrNull(raw.postmortem.attempts) ?? 0 : 0;
      await patchRows(`analyses?id=eq.${encodeURIComponent(row.id)}`, {
        postmortem: { schema: SCHEMA_VERSION, version: POSTMORTEM_VERSION, status: "failed", error, attempts: prev + 1, checked_at: nowIso },
      });
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
        });
      } catch (err) {
        await markFailed(row, raw, `facts: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }

      const ev = row.evaluation;
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
        shadow: raw.shadow === true,
      };

      const prompt = buildDiagnosisPrompt(plan, facts);
      let answer: unknown = null;
      try {
        answer = await askModel(prompt.system, prompt.user, DIAGNOSIS_SCHEMA, 2500);
      } catch (err) {
        await markFailed(row, raw, `model: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      const diagnosis = parseDiagnosis(answer, facts.hints);
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
        revisions: (numberOrNull(priorDoc?.revisions) ?? 0) + (priorDoc?.status === "done" ? 1 : 0),
        cause: diagnosis.cause,
        secondary_causes: diagnosis.secondary_causes,
        avoidable: diagnosis.avoidable,
        confidence: diagnosis.confidence,
        verdict: { ja: diagnosis.verdict_ja, en: diagnosis.verdict_en },
        evidence: { ja: diagnosis.evidence_ja, en: diagnosis.evidence_en },
        lesson: { ja: diagnosis.lesson_ja, en: diagnosis.lesson_en },
        scope: diagnosis.scope,
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
    let rulebook: { version: number; rules: number } | null = null;
    if ((newLessons > 0 || options.consolidate) && elapsed() < START_CONSOLIDATION_BEFORE_MS) {
      const lessonRows = await readRows(
        `lessons?select=cause,outcome,interval,signal,mode,order_type,lesson_ja,lesson_en,confidence,avoidable,shadow,created_at&order=created_at.desc&limit=${RECENT_LESSONS}`,
      );
      const lessons: LessonRow[] = lessonRows.map((l) => ({
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
        created_at: String(l.created_at ?? ""),
      }));
      const recordRows = await readRows(
        `analyses?select=outcome,signal,shadow,rejection:entry_check->>rejection,filled_at:evaluation->>filled_at&order=created_at.desc&limit=${RECENT_ROWS}`,
      );
      const stats = summarizeRecord(
        recordRows.map((r) => ({
          outcome: String(r.outcome ?? ""),
          signal: String(r.signal ?? ""),
          shadow: r.shadow === true,
          rejection: strOrNull(r.rejection),
          filled: typeof r.filled_at === "string" && r.filled_at.length > 0,
        })),
        lessons,
      );

      const [current] = await readRows("rulebook?id=eq.1&select=version,rules,history,updated_at");
      const previousRules: Rule[] = current ? parseRules(current.rules) : [];
      const previousVersion = current ? numberOrNull(current.version) ?? 0 : 0;

      if (lessons.length > 0) {
        const prompt = buildConsolidationPrompt(previousRules, lessons, stats);
        let answer: unknown = null;
        try {
          answer = await askModel(prompt.system, prompt.user, CONSOLIDATION_SCHEMA, 4000);
        } catch (err) {
          errors.push(`rulebook: model ${err instanceof Error ? err.message : String(err)}`);
        }
        const consolidated = parseConsolidation(answer, previousRules, nowIso);
        if (!consolidated) {
          errors.push("rulebook: no usable answer");
        } else {
          const history = Array.isArray(current?.history) ? current.history : [];
          const nextHistory = previousRules.length > 0
            ? [...history.slice(-(HISTORY_KEEP - 1)), { version: previousVersion, rules: previousRules, updated_at: current?.updated_at ?? null }]
            : history;
          const n = await patchRows("rulebook?id=eq.1", {
            version: previousVersion + 1,
            rules: consolidated.rules,
            summary: { ja: consolidated.summary_ja, en: consolidated.summary_en },
            stats,
            history: nextHistory,
            updated_at: nowIso,
          });
          if (n > 0) rulebook = { version: previousVersion + 1, rules: consolidated.rules.length };
          else errors.push("rulebook: not written");
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
