// #113: the live chart's two reads (logic.ts says what they are).
//
//   {action: "bars", pair, interval} — the bars, both rules' signals and
//     their readings on the newest closed bar;
//   {action: "ticker"} — every live pair's bid and ask now.
//
// Signed-in users only, like the analysis. Both answers are kept for a few
// seconds in this instance, so several people watching one chart cost the
// public feed one read, not one each.

import {
  LIVE_INTERVALS,
  LIVE_PAIRS,
  TICKER_URL,
  fetchLiveQuotes,
  isLiveInterval,
  isLivePair,
  isMaintenance,
  liveRead,
  parseTicker,
} from "./logic.ts";
import type { Fetcher } from "../track-outcomes/quotes.ts";

const FUNCTION_VERSION = "live-chart-v2-2026-09-26T01:00:00Z";

// A bar read is good until its forming bar has moved on a little; the ticker
// for a couple of seconds
const BARS_TTL_MS = 20_000;
const TICKER_TTL_MS = 2_000;
const AUTH_TTL_MS = 60_000;
const FETCH_BUDGET_MS = 20_000;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const gmoFetcher: Fetcher = async (url) => {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    if (!r.ok) {
      await r.body?.cancel();
      return null;
    }
    return await r.json().catch(() => null);
  } catch {
    return null;
  }
};

const barsCache = new Map<string, { at: number; body: unknown }>();
let tickerCache: { at: number; body: unknown } | null = null;
const authCache = new Map<string, number>();

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    if (!supabaseUrl || !anonKey) return json({ ok: false, error: "サーバー設定エラー" }, 500);

    const auth = req.headers.get("Authorization");
    if (!auth?.startsWith("Bearer ")) return json({ ok: false, error: "認証が必要です" }, 401);
    const nowMs = Date.now();
    const known = authCache.get(auth);
    if (known === undefined || known < nowMs) {
      const res = await fetch(`${supabaseUrl}/auth/v1/user`, { headers: { Authorization: auth, apikey: anonKey } });
      const user = res.ok ? await res.json().catch(() => null) : null;
      if (!user || typeof user.id !== "string") return json({ ok: false, error: "認証に失敗しました" }, 401);
      if (authCache.size > 500) authCache.clear();
      authCache.set(auth, nowMs + AUTH_TTL_MS);
    }

    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    const action = typeof body?.action === "string" ? body.action : "bars";
    // v2: whether GMO said it is down for maintenance on any call below
    let maintenance = false;
    const fetcher: Fetcher = async (url) => {
      const got = await gmoFetcher(url);
      if (isMaintenance(got)) maintenance = true;
      return got;
    };
    const unavailable = () =>
      maintenance
        ? json({ ok: false, error: "maintenance", version: FUNCTION_VERSION }, 503)
        : json({ ok: false, error: "feed_unavailable", version: FUNCTION_VERSION }, 502);

    if (action === "ticker") {
      if (!tickerCache || nowMs - tickerCache.at > TICKER_TTL_MS) {
        const raw = await fetcher(TICKER_URL);
        const ticks = parseTicker(raw);
        if (Object.keys(ticks).length === 0) return unavailable();
        tickerCache = { at: nowMs, body: { ok: true, version: FUNCTION_VERSION, at: new Date(nowMs).toISOString(), ticks } };
      }
      return json(tickerCache.body);
    }

    if (action === "bars") {
      const pair = body?.pair;
      const interval = body?.interval;
      if (!isLivePair(pair) || !isLiveInterval(interval)) {
        return json({ ok: false, error: "invalid_request", pairs: LIVE_PAIRS, intervals: LIVE_INTERVALS }, 400);
      }
      const key = `${pair}|${interval}`;
      const hit = barsCache.get(key);
      if (hit && nowMs - hit.at <= BARS_TTL_MS) {
        // a cached read whose forming bar has since closed is stale
        const next = (hit.body as { read?: { next_close?: string | null } }).read?.next_close;
        if (!next || Date.parse(next) > nowMs) return json(hit.body);
      }
      const quotes = await fetchLiveQuotes(pair, interval, nowMs, nowMs + FETCH_BUDGET_MS, fetcher);
      if (!quotes || quotes.length === 0) return unavailable();
      const out = { ok: true, version: FUNCTION_VERSION, read: liveRead(pair, interval, quotes, nowMs) };
      if (barsCache.size > 100) barsCache.clear();
      barsCache.set(key, { at: nowMs, body: out });
      return json(out);
    }

    return json({ ok: false, error: "invalid_request" }, 400);
  } catch (err) {
    console.error("live-chart failed:", err);
    return json({ ok: false, error: "internal_error" }, 500);
  }
});
