// track-outcomes — judges open trade plans against actual price data.
//
// Two callers:
//  * the app, right after login, with the user's JWT (judges that user's
//    plans);
//  * pg_cron every 15 minutes, with the shared sweep token (judges every
//    user's plans that are due), so outcomes resolve without anyone opening
//    the app.
//
// Judgement lives in evaluate.ts: a plan is only a trade once price reaches
// the entry; after that TP1 before SL is a win and SL first a loss. Candles
// are requested in UTC and a series dated in the future is refused rather
// than judged, which is what went wrong in the first version.

import { parseCandles, type Candle } from "../analyze/indicators.ts";
import {
  EVAL_INTERVAL,
  EVAL_OUTPUTSIZE,
  REFINE_INTERVAL,
  hasFutureCandles,
  isDue,
  judgePlan,
  type Evaluation,
  type FineFetcher,
  type OpenRow,
} from "./evaluate.ts";

const TRACKER_VERSION = "track-outcomes-v2-2026-09-03T09:00:00Z";
const USER_COOLDOWN_MS = 5 * 60 * 1000;
const SWEEP_COOLDOWN_MS = 10 * 60 * 1000;
const MAX_ROWS = 60;
// Market-data requests per run: one per pair+interval group plus a few
// refinements, kept inside the shared API key's per-minute budget
const MAX_GROUPS = 4;
const MAX_REFINEMENTS = 4;
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

const constantTimeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

// "YYYY-MM-DD HH:mm:ss" in UTC, the form Twelve Data's date filters take
const tdDate = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

type Scope = { kind: "sweep" } | { kind: "user"; userId: string };

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const twelveDataKey = Deno.env.get("TWELVE_DATA_API_KEY");

    if (!supabaseUrl || !supabaseAnonKey || !serviceRoleKey || !twelveDataKey) {
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
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();

    // ---- who is asking -------------------------------------------------
    let scope: Scope;
    const sweepToken = req.headers.get("x-sweep-token");
    if (sweepToken) {
      const tokenRes = await rest("rpc/track_outcomes_sweep_token", { method: "POST", body: "{}" });
      const expected = tokenRes.ok ? await tokenRes.json().catch(() => null) : null;
      if (typeof expected !== "string" || expected.length === 0 || !constantTimeEqual(sweepToken, expected)) {
        return json({ ok: false, error: "認証に失敗しました" }, 401);
      }

      const stateRes = await rest("tracker_state?id=eq.1&select=last_sweep_at", {
        headers: { Accept: "application/vnd.pgrst.object+json" },
      });
      const stateRaw = stateRes.ok ? await stateRes.json().catch(() => null) : null;
      const lastSweep = isRecord(stateRaw) && typeof stateRaw.last_sweep_at === "string"
        ? Date.parse(stateRaw.last_sweep_at)
        : NaN;
      if (Number.isFinite(lastSweep) && nowMs - lastSweep < SWEEP_COOLDOWN_MS) {
        return json({ ok: true, mode: "sweep", updated: 0, skipped: "cooldown", version: TRACKER_VERSION });
      }
      await rest("tracker_state?id=eq.1", {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ last_sweep_at: nowIso }),
      }).then((r) => r.text()).catch(() => {});
      scope = { kind: "sweep" };
    } else {
      const authHeader = req.headers.get("Authorization");
      if (!authHeader?.startsWith("Bearer ")) {
        return json({ ok: false, error: "認証が必要です" }, 401);
      }
      const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
        headers: { Authorization: authHeader, apikey: supabaseAnonKey },
      });
      if (!userRes.ok) {
        return json({ ok: false, error: "認証に失敗しました" }, 401);
      }
      const userData = await userRes.json();
      const userId = isRecord(userData) && typeof userData.id === "string" ? userData.id : null;
      if (!userId) {
        return json({ ok: false, error: "認証に失敗しました" }, 401);
      }

      // Per-user cooldown: each call can trigger several market-data fetches
      // against a shared API key
      const trackedRes = await rest(
        `profiles?id=eq.${encodeURIComponent(userId)}&select=last_tracked_at`,
        { headers: { Accept: "application/vnd.pgrst.object+json" } },
      );
      if (trackedRes.ok) {
        const trackedRaw = await trackedRes.json().catch(() => null);
        const lastTracked = isRecord(trackedRaw) && typeof trackedRaw.last_tracked_at === "string"
          ? Date.parse(trackedRaw.last_tracked_at)
          : NaN;
        if (Number.isFinite(lastTracked) && nowMs - lastTracked < USER_COOLDOWN_MS) {
          return json({ ok: true, mode: "user", updated: 0, skipped: "cooldown", version: TRACKER_VERSION });
        }
      }
      await rest(`profiles?id=eq.${encodeURIComponent(userId)}`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ last_tracked_at: nowIso }),
      }).then((r) => r.text()).catch(() => {});
      scope = { kind: "user", userId };
    }

    // ---- open plans that are due a look ----------------------------------
    const select = "id,pair,interval,signal,entry_point,stop_loss,take_profit_1,take_profit_2,take_profit_3,created_at,price_at_signal,evaluation";
    const ownerFilter = scope.kind === "user" ? `user_id=eq.${encodeURIComponent(scope.userId)}&` : "";
    const listRes = await rest(
      `analyses?${ownerFilter}outcome=eq.pending&select=${select}&order=created_at.asc&limit=${MAX_ROWS}`,
    );
    if (!listRes.ok) {
      return json({ ok: false, error: "履歴の取得に失敗しました" }, 500);
    }

    const rowsRaw = await listRes.json();
    const rows: OpenRow[] = [];
    if (Array.isArray(rowsRaw)) {
      for (const r of rowsRaw) {
        if (!isRecord(r)) continue;
        if (r.signal !== "BUY" && r.signal !== "SELL") continue;
        const entry = numberOrNull(r.entry_point);
        const sl = numberOrNull(r.stop_loss);
        const tp1 = numberOrNull(r.take_profit_1);
        if (entry === null || sl === null || tp1 === null) continue;
        rows.push({
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
        });
      }
    }

    const due = rows.filter((row) => isDue(row, nowMs));
    if (due.length === 0) {
      return json({ ok: true, mode: scope.kind, open: rows.length, due: 0, checked: 0, updated: 0, version: TRACKER_VERSION });
    }

    // One price fetch per pair+evaluation interval
    const groups = new Map<string, OpenRow[]>();
    for (const row of due) {
      const key = `${row.pair}|${EVAL_INTERVAL[row.interval] ?? "1h"}`;
      const list = groups.get(key) ?? [];
      list.push(row);
      groups.set(key, list);
    }

    const fetchSeries = async (params: Record<string, string>): Promise<Candle[] | null> => {
      const qs = new URLSearchParams({ ...params, timezone: "UTC", apikey: twelveDataKey });
      try {
        const res = await fetch(`${TWELVE_DATA}?${qs.toString()}`);
        const parsed = await res.json().catch(() => null);
        if (!res.ok || !isRecord(parsed) || parsed.status === "error") {
          console.error("market data error:", res.status, isRecord(parsed) ? String(parsed.message ?? "").slice(0, 200) : "");
          return null;
        }
        return parseCandles(parsed.values);
      } catch (err) {
        console.error("market data fetch failed:", err instanceof Error ? err.message : String(err));
        return null;
      }
    };

    let refinements = 0;
    const fetchFine: FineFetcher = async (pair, fromMs, toMs) => {
      if (refinements >= MAX_REFINEMENTS) return null;
      refinements++;
      return await fetchSeries({
        symbol: pair,
        interval: REFINE_INTERVAL,
        start_date: tdDate(fromMs),
        end_date: tdDate(toMs),
        outputsize: "200",
      });
    };

    let checked = 0;
    let updated = 0;
    let groupCount = 0;
    const errors: string[] = [];
    const resolved: Array<{ id: string; outcome: string }> = [];

    for (const [key, groupRows] of groups) {
      if (groupCount >= MAX_GROUPS) break;
      groupCount++;

      const [pair, evalInterval] = key.split("|");
      const candles = await fetchSeries({
        symbol: pair,
        interval: evalInterval,
        outputsize: String(EVAL_OUTPUTSIZE[evalInterval] ?? 1500),
      });
      if (!candles || candles.length === 0) {
        errors.push(`${key}: no data`);
        continue;
      }
      if (hasFutureCandles(candles, nowMs)) {
        // Judging against mis-dated bars is how the first tracker went wrong;
        // leave the rows alone and say so
        console.error("market data dated in the future, refusing to judge:", key, candles[candles.length - 1].datetime);
        errors.push(`${key}: candles dated in the future`);
        continue;
      }

      for (const row of groupRows) {
        const judgement = await judgePlan(row, candles, evalInterval, nowMs, fetchFine);
        const patch: JsonRecord = judgement.resolution
          ? {
            outcome: judgement.resolution,
            outcome_price: judgement.outcome_price,
            closed_at: judgement.closed_at,
            evaluation: judgement.evaluation,
          }
          : { evaluation: judgement.evaluation };

        const updateRes = await rest(
          `analyses?id=eq.${encodeURIComponent(row.id)}&outcome=eq.pending`,
          { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(patch) },
        );
        await updateRes.text();
        if (!updateRes.ok) {
          errors.push(`${row.id}: update failed (${updateRes.status})`);
          continue;
        }
        checked++;
        if (judgement.resolution) {
          updated++;
          resolved.push({ id: row.id, outcome: judgement.resolution });
        }
      }
    }

    const summary = {
      ok: true,
      mode: scope.kind,
      open: rows.length,
      due: due.length,
      groups: groupCount,
      refinements,
      checked,
      updated,
      resolved,
      errors,
      version: TRACKER_VERSION,
    };

    if (scope.kind === "sweep") {
      await rest("tracker_state?id=eq.1", {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ last_sweep_result: { ...summary, at: nowIso } }),
      }).then((r) => r.text()).catch(() => {});
    }

    return json(summary);
  } catch (err) {
    console.error("track-outcomes error:", err);
    return json({ ok: false, error: "サーバーエラーが発生しました" }, 500);
  }
});
