// #113: the live chart's two reads (logic.ts says what they are).
//
//   {action: "bars", pair, interval} — the bars, both rules' signals and
//     their readings on the newest closed bar;
//   {action: "ticker"} — every live pair's bid and ask now;
//   {action: "history", pair, interval} — #124: HISTORY_BARS closed bars,
//     for an indicator that needs more than the chart draws (Zone Shift).
// #127: gold (XAU/USD) reads its bars from Twelve Data and its price from
// Swissquote (logic.ts, "gold").
//
// Signed-in users only, like the analysis. Both answers are kept for a few
// seconds in this instance, so several people watching one chart cost the
// public feed one read, not one each.

import {
  LIVE_INTERVALS,
  LIVE_PAIRS,
  TICKER_URL,
  fetchLiveQuotes,
  GOLD,
  GOLD_BARS,
  GOLD_QUOTE_URL,
  goldFresh,
  goldRead,
  HISTORY_BARS,
  historyOfBars,
  historyRead,
  intervalsFor,
  isGold,
  parseSwissquote,
  isLiveInterval,
  isLivePair,
  isMaintenance,
  liveRead,
  parseTicker,
  FALLBACK_TTL_MS,
  fallbackRead,
  parseTwelveData,
  twelveDataUrl,
} from "./logic.ts";
import type { Candle } from "../analyze/indicators.ts";
import { isPossiblyClosed, nextOpen } from "../_shared/market-hours.ts";
import type { Fetcher } from "../track-outcomes/quotes.ts";

const FUNCTION_VERSION = "live-chart-v5-2026-09-26T17:00:00Z";
// v3: Twelve Data fetches this instance may make in a minute for the
// fallback, so a person flipping through every pair and timeframe cannot
// spend the analysis's shared eight-a-minute key
const FALLBACK_FETCHES_PER_MIN = 3;

// A bar read is good until its forming bar has moved on a little; the ticker
// for a couple of seconds
const BARS_TTL_MS = 20_000;
const TICKER_TTL_MS = 2_000;
// #124: the history is of closed bars, which do not change; the client
// joins it to the chart's newest bars itself
const HISTORY_TTL_MS = 10 * 60_000;
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
const historyCache = new Map<string, { at: number; body: unknown }>();
let tickerCache: { at: number; body: unknown } | null = null;
const authCache = new Map<string, number>();
const fallbackFetches: number[] = [];

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const twelveKey = Deno.env.get("TWELVE_DATA_API_KEY") ?? "";
    if (!supabaseUrl || !anonKey || !serviceKey) return json({ ok: false, error: "サーバー設定エラー" }, 500);
    const rest = (path: string, init: RequestInit = {}) =>
      fetch(`${supabaseUrl}/rest/v1/${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${serviceKey}`, apikey: serviceKey, "Content-Type": "application/json", ...(init.headers ?? {}) },
      });

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
    // v2: whether GMO said it is down for maintenance on any call below.
    // Once it has, the rest of the calls are not made: they would all say so.
    let maintenance = false;
    const fetcher: Fetcher = async (url) => {
      if (maintenance) return null;
      const got = await gmoFetcher(url);
      if (isMaintenance(got)) maintenance = true;
      return got;
    };
    // v3: the market's reopening, while it may be shut
    const reopens = isPossiblyClosed(nowMs) ? new Date(nextOpen(nowMs)).toISOString() : null;

    // v3: the last bars from Twelve Data, from the table while they are
    // fresh, fetched again when not (within this instance's allowance), and
    // stale ones rather than none
    const fallbackBars = async (
      pair: string,
      interval: string,
      // #127: gold's own rule for "fresh", and how many bars it reads
      fresh: (fetchedAtMs: number) => boolean = (t) => nowMs - t < FALLBACK_TTL_MS,
      outputsize?: number,
    ): Promise<{ bars: Candle[]; fetchedAt: string } | null> => {
      const key = `pair=eq.${encodeURIComponent(pair)}&interval=eq.${encodeURIComponent(interval)}`;
      const res = await rest(`live_chart_fallback?${key}&select=bars,fetched_at`);
      const rows = res.ok ? await res.json().catch(() => null) : null;
      const row = Array.isArray(rows) && rows.length > 0 ? rows[0] as { bars?: unknown; fetched_at?: unknown } : null;
      const stored = row && Array.isArray(row.bars) && typeof row.fetched_at === "string"
        ? { bars: row.bars as Candle[], fetchedAt: row.fetched_at }
        : null;
      if (stored && fresh(Date.parse(stored.fetchedAt))) return stored;
      while (fallbackFetches.length > 0 && nowMs - fallbackFetches[0] > 60_000) fallbackFetches.shift();
      if (!twelveKey || fallbackFetches.length >= FALLBACK_FETCHES_PER_MIN) return stored;
      fallbackFetches.push(nowMs);
      try {
        const r = await fetch(twelveDataUrl(pair, interval, twelveKey, outputsize), { signal: AbortSignal.timeout(10_000) });
        const bars = parseTwelveData(await r.json().catch(() => null), interval);
        if (!r.ok || !bars || bars.length < 60) return stored;
        const fetchedAt = new Date(nowMs).toISOString();
        const up = await rest("live_chart_fallback?on_conflict=pair,interval", {
          method: "POST",
          headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
          body: JSON.stringify({ pair, interval, bars, source: "twelvedata", fetched_at: fetchedAt }),
        });
        if (!up.ok) console.error("fallback store failed:", up.status, await up.text().catch(() => ""));
        return { bars, fetchedAt };
      } catch (err) {
        console.error("fallback fetch failed:", err);
        return stored;
      }
    };
    // #127: gold's bars, from the table while no bar has closed since
    const goldBars = (interval: string) =>
      fallbackBars(GOLD, interval, (t) => goldFresh(t, nowMs, interval, isPossiblyClosed(nowMs)), GOLD_BARS);
    const unavailable = () =>
      maintenance
        ? json({ ok: false, error: "maintenance", reopens, version: FUNCTION_VERSION }, 503)
        : json({ ok: false, error: "feed_unavailable", reopens, version: FUNCTION_VERSION }, 502);

    if (action === "ticker") {
      if (!tickerCache || nowMs - tickerCache.at > TICKER_TTL_MS) {
        // #127: gold's price from Swissquote, beside GMO's
        const goldQuote = async () => {
          try {
            const r = await fetch(GOLD_QUOTE_URL, { signal: AbortSignal.timeout(5_000) });
            return r.ok ? parseSwissquote(await r.json().catch(() => null), nowMs) : null;
          } catch {
            return null;
          }
        };
        const [raw, gold] = await Promise.all([fetcher(TICKER_URL), goldQuote()]);
        const ticks = { ...parseTicker(raw), ...(gold ? { [GOLD]: gold } : {}) };
        if (Object.keys(ticks).length === 0) return unavailable();
        tickerCache = { at: nowMs, body: { ok: true, version: FUNCTION_VERSION, at: new Date(nowMs).toISOString(), ticks } };
      }
      return json(tickerCache.body);
    }

    if (action === "bars") {
      const pair = body?.pair;
      const interval = body?.interval;
      if (!isLivePair(pair) || !isLiveInterval(interval) || !intervalsFor(pair).includes(interval)) {
        return json({ ok: false, error: "invalid_request", pairs: LIVE_PAIRS, intervals: LIVE_INTERVALS }, 400);
      }
      const key = `${pair}|${interval}`;
      const hit = barsCache.get(key);
      if (hit && nowMs - hit.at <= BARS_TTL_MS) {
        // a cached read whose forming bar has since closed is stale
        const next = (hit.body as { read?: { next_close?: string | null } }).read?.next_close;
        if (!next || Date.parse(next) > nowMs) return json(hit.body);
      }
      // #127: gold, from Twelve Data (GMO has none)
      if (isGold(pair)) {
        const fb = await goldBars(interval);
        if (!fb) return json({ ok: false, error: "feed_unavailable", reopens, version: FUNCTION_VERSION }, 502);
        const out = { ok: true, version: FUNCTION_VERSION, reopens, read: goldRead(fb.bars, interval, nowMs, fb.fetchedAt) };
        if (barsCache.size > 100) barsCache.clear();
        barsCache.set(key, { at: nowMs, body: out });
        return json(out);
      }
      const quotes = await fetchLiveQuotes(pair, interval, nowMs, nowMs + FETCH_BUDGET_MS, fetcher);
      if (!quotes || quotes.length === 0) {
        // v3: GMO cannot be read — the last bars from Twelve Data instead
        const fb = await fallbackBars(pair, interval);
        if (!fb) return unavailable();
        const read = fallbackRead(pair, interval, fb.bars, nowMs, {
          source: "twelvedata",
          feed: maintenance ? "maintenance" : "unavailable",
          fetchedAt: fb.fetchedAt,
        });
        // not cached here: the next read should try GMO again
        return json({ ok: true, version: FUNCTION_VERSION, reopens, read });
      }
      const out = { ok: true, version: FUNCTION_VERSION, reopens, read: liveRead(pair, interval, quotes, nowMs) };
      if (barsCache.size > 100) barsCache.clear();
      barsCache.set(key, { at: nowMs, body: out });
      return json(out);
    }

    // #124: the closed bars before the chart's, from GMO only (Twelve
    // Data's shared key is kept for the chart itself)
    if (action === "history") {
      const pair = body?.pair;
      const interval = body?.interval;
      if (!isLivePair(pair) || !isLiveInterval(interval) || !intervalsFor(pair).includes(interval)) {
        return json({ ok: false, error: "invalid_request", pairs: LIVE_PAIRS, intervals: LIVE_INTERVALS }, 400);
      }
      // #127: gold's history is the bars it already reads (GOLD_BARS deep)
      if (isGold(pair)) {
        const fb = await goldBars(interval);
        if (!fb) return json({ ok: false, error: "feed_unavailable", reopens, version: FUNCTION_VERSION }, 502);
        return json({ ok: true, version: FUNCTION_VERSION, history: historyOfBars(pair, interval, fb.bars, nowMs) });
      }
      const key = `${pair}|${interval}`;
      const hit = historyCache.get(key);
      if (hit && nowMs - hit.at <= HISTORY_TTL_MS) return json(hit.body);
      const quotes = await fetchLiveQuotes(pair, interval, nowMs, nowMs + FETCH_BUDGET_MS, fetcher, HISTORY_BARS + 1);
      if (!quotes || quotes.length === 0) return unavailable();
      const out = { ok: true, version: FUNCTION_VERSION, history: historyRead(pair, interval, quotes, nowMs) };
      if (historyCache.size > 50) historyCache.clear();
      historyCache.set(key, { at: nowMs, body: out });
      return json(out);
    }

    return json({ ok: false, error: "invalid_request" }, 400);
  } catch (err) {
    console.error("live-chart failed:", err);
    return json({ ok: false, error: "internal_error" }, 500);
  }
});
