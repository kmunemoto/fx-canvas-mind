// Keeps public.econ_events in step with the published calendar.
//
// One HTTP call per week fetched, an upsert, and nothing else — the parsing
// and every judgement about what an event means live in events.ts, where the
// vitest suite can reach them.
//
// Callers: pg_cron every hour with the shared sweep token, and an admin with
// their JWT (to backfill by hand). Forex Factory publishes no `actual`, so
// this function never claims to know what a release printed.

import { parseEvents, type EconEvent } from "./events.ts";

const FUNCTION_VERSION = "econ-calendar-v1-2026-09-03T19:00:00Z";
const ADMIN_EMAILS = ["k.munemoto@kyoto-salute.com", "munekan2989@gmail.com"];

const FEEDS: Record<string, string> = {
  this_week: "https://nfs.faireconomy.media/ff_calendar_thisweek.json",
  next_week: "https://nfs.faireconomy.media/ff_calendar_nextweek.json",
};
// The publisher asks for a real client string and rate-limits hard; hourly is
// far inside it, but a failed fetch must never be retried in a tight loop
const USER_AGENT = "Mozilla/5.0 (compatible; fx-canvas-mind/1.0; +https://fx-canvas-mind.lovable.app)";
const MIN = 60_000;
const SWEEP_COOLDOWN_MS = 30 * MIN;
const FETCH_TIMEOUT_MS = 20_000;
// Events older than this are dropped: the post-mortem only ever looks back
// over a plan's own life
const KEEP_PAST_DAYS = 45;

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

const constantTimeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const startedAt = Date.now();
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !supabaseAnonKey || !serviceRoleKey) {
      return json({ ok: false, error: "サーバー設定エラー" }, 500);
    }

    const serviceHeaders = {
      Authorization: `Bearer ${serviceRoleKey}`,
      apikey: serviceRoleKey,
      "Content-Type": "application/json",
    };
    const rest = (path: string, init: RequestInit = {}) =>
      fetch(`${supabaseUrl}/rest/v1/${path}`, { ...init, headers: { ...serviceHeaders, ...(init.headers ?? {}) } });
    const patchRows = async (path: string, body: JsonRecord): Promise<number> => {
      const res = await rest(path, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(body) });
      const rows = res.ok ? await res.json().catch(() => null) : null;
      if (!res.ok) console.error("patch failed:", path.split("?")[0], res.status);
      return Array.isArray(rows) ? rows.length : 0;
    };

    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const bodyRaw = await req.json().catch(() => null);
    const body: JsonRecord = isRecord(bodyRaw) ? bodyRaw : {};

    // ---- who is asking ---------------------------------------------------
    let mode: "sweep" | "admin";
    const sweepToken = req.headers.get("x-sweep-token");
    if (sweepToken) {
      const tokenRes = await rest("rpc/track_outcomes_sweep_token", { method: "POST", body: "{}" });
      const expected = tokenRes.ok ? await tokenRes.json().catch(() => null) : null;
      if (typeof expected !== "string" || expected.length === 0 || !constantTimeEqual(sweepToken, expected)) {
        return json({ ok: false, error: "認証に失敗しました" }, 401);
      }
      const cutoff = encodeURIComponent(new Date(nowMs - SWEEP_COOLDOWN_MS).toISOString());
      const claimed = await patchRows(
        `econ_calendar_state?id=eq.1&or=(last_run_at.is.null,last_run_at.lt.${cutoff})`,
        { last_run_at: nowIso },
      );
      if (claimed === 0) {
        return json({ ok: true, mode: "sweep", skipped: "cooldown", version: FUNCTION_VERSION });
      }
      mode = "sweep";
    } else {
      const authHeader = req.headers.get("Authorization");
      if (!authHeader?.startsWith("Bearer ")) return json({ ok: false, error: "認証が必要です" }, 401);
      const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
        headers: { Authorization: authHeader, apikey: supabaseAnonKey },
      });
      const userData = userRes.ok ? await userRes.json().catch(() => null) : null;
      const email = isRecord(userData) && typeof userData.email === "string" ? userData.email.toLowerCase() : null;
      if (!email || !ADMIN_EMAILS.includes(email)) return json({ ok: false, error: "権限がありません" }, 403);
      mode = "admin";
    }

    const weeks = body.weeks === "this" ? ["this_week"] : Object.keys(FEEDS);

    // ---- fetch -----------------------------------------------------------
    const events: EconEvent[] = [];
    const errors: string[] = [];
    const seen = new Set<string>();
    for (const week of weeks) {
      try {
        const res = await fetch(FEEDS[week], {
          headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        const text = await res.text();
        if (!res.ok) {
          errors.push(`${week}: HTTP ${res.status}`);
          continue;
        }
        // A rate-limited response comes back as HTML, not JSON: keep whatever
        // is already stored rather than wiping it
        let parsedBody: unknown = null;
        try {
          parsedBody = JSON.parse(text);
        } catch {
          errors.push(`${week}: not JSON (rate limited?)`);
          continue;
        }
        const parsed = parseEvents(parsedBody);
        if (parsed.length === 0) {
          errors.push(`${week}: no events`);
          continue;
        }
        for (const e of parsed) {
          if (seen.has(e.id)) continue;
          seen.add(e.id);
          events.push(e);
        }
      } catch (err) {
        errors.push(`${week}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // ---- store -----------------------------------------------------------
    let upserted = 0;
    if (events.length > 0) {
      const res = await rest("econ_events?on_conflict=id", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify(events.map((e) => ({ ...e, fetched_at: nowIso }))),
      });
      if (!res.ok) {
        errors.push(`upsert: ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
      } else {
        await res.text().catch(() => {});
        upserted = events.length;
      }
    }

    // Old events are of no use to anything that runs from here on
    const cutoff = encodeURIComponent(new Date(nowMs - KEEP_PAST_DAYS * 24 * 60 * MIN).toISOString());
    await rest(`econ_events?event_at=lt.${cutoff}`, { method: "DELETE", headers: { Prefer: "return=minimal" } })
      .then((r) => r.text().catch(() => {}))
      .catch(() => {});

    const summary = {
      ok: errors.length === 0 || upserted > 0,
      mode,
      weeks,
      fetched: events.length,
      upserted,
      errors,
      elapsedMs: Date.now() - startedAt,
      version: FUNCTION_VERSION,
    };
    if (mode === "sweep") await patchRows("econ_calendar_state?id=eq.1", { last_result: { ...summary, at: nowIso } });
    return json(summary);
  } catch (err) {
    console.error("econ-calendar error:", err);
    return json({ ok: false, error: "サーバーエラーが発生しました" }, 500);
  }
});
