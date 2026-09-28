// #113: the live chart's two reads (logic.ts says what they are).
//
//   {action: "bars", pair, interval} — the bars, both rules' signals and
//     their readings on the newest closed bar;
//   {action: "ticker", pair?} — every live pair's bid and ask now (#154:
//     the pair on screen's read again each time, see "the pairs' prices");
//   {action: "dow", pair} — #129: Dow theory on 4h, 1h, 15min and 5min;
//   {action: "history", pair, interval} — #124: HISTORY_BARS closed bars,
//     for an indicator that needs more than the chart draws (Zone Shift).
// #127: gold (XAU/USD) reads its bars from Twelve Data and its price from
// Swissquote (logic.ts, "gold"). #146: every pair on every timeframe, 1 and
// 5 minutes too; Twelve Data's reads counted per day (logic.ts, "Twelve
// Data's day"). #147: gold's price recorded a minute at a time, and its bars
// going on from it when Twelve Data cannot be read again (logic.ts, "gold
// between Twelve Data's reads"). #154: 15 more pairs, read as gold is
// (logic.ts, "the broker's pairs GMO does not serve"); the ticker is told
// the pair on screen.
//
// Signed-in users only, like the analysis. Both answers are kept for a few
// seconds in this instance, so several people watching one chart cost the
// public feed one read, not one each.

import {
  LIVE_INTERVALS,
  LIVE_PAIRS,
  TICKER_URL,
  fetchLiveQuotes,
  closedOf,
  dowOf,
  dowTfsFor,
  fetchDowQuotes,
  splitBars,
  LIVE_STEP_MS,
  GOLD,
  GOLD_BARS,
  GOLD_QUOTE_URL,
  goldFresh,
  twelveRead,
  TWELVE_FX_PAIRS,
  isTwelveFx,
  isTwelvePair,
  parseSwissquoteFx,
  swissquoteDue,
  swissquoteUrl,
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
  twelveCapFor,
  twelveDataUrl,
  extendWithTicks,
  parseTickMinutes,
  type Tick,
} from "./logic.ts";
import type { Candle } from "../analyze/indicators.ts";
import { barOpenMs } from "../analyze/state.ts";
import { isPossiblyClosed, isPossiblyClosedFor, nextOpen } from "../_shared/market-hours.ts";
import type { Fetcher } from "../track-outcomes/quotes.ts";

const FUNCTION_VERSION = "live-chart-v10-2026-09-29T03:30:00Z";
// v3: Twelve Data fetches this instance may make in a minute for the
// fallback, so a person flipping through every pair and timeframe cannot
// spend the analysis's shared eight-a-minute key. #146: five — gold's
// 1-minute chart and its Dow reading (5 and 15 minutes, 1 and 4 hours) can
// all be due in the same minute; the key allows eight.
const FALLBACK_FETCHES_PER_MIN = 5;
// #154: the minute's last two of those are left for a chart's bars: the
// Dow reading (four timeframes at once, on a pair just opened) does not
// take them, so the chart itself is not the one left waiting a minute
const DOW_ROOM = 2;

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

// #153: room for every pair's every timeframe (#154: 37 × 6), so a cache
// is not emptied each time the chart moves to another pair
const CACHE_KEYS = 240;
const barsCache = new Map<string, { at: number; body: unknown }>();
const historyCache = new Map<string, { at: number; body: unknown }>();
// #129: each pair's and timeframe's closed bars for the Dow read, until a
// newer bar has closed (and not asked again within DOW_RETRY_MS of a read)
const dowCache = new Map<string, { at: number; closed: Candle[] }>();
const DOW_RETRY_MS = 30_000;
const DOW_SHUT_RETRY_MS = 5 * 60_000;
let tickerCache: { at: number; body: unknown } | null = null;
const authCache = new Map<string, number>();
const fallbackFetches: number[] = [];
// #154: the pairs' prices from Swissquote (logic.ts, "the broker's pairs GMO
// does not serve"). The pair on screen is read again with each ticker read,
// as gold is; the others a few at a time, each at most once a minute, so
// the pair list's prices stay near the market without fifteen requests
// every few seconds. `at` is the last try, `readAt` the last answer; a
// price not answered for SQ_KEEP_MS is left out.
const SQ_OTHERS_MS = 60_000;
const SQ_OTHERS_PER_READ = 3;
const SQ_KEEP_MS = 3 * 60_000;
const sqCache = new Map<string, { at: number; readAt: number; tick: Tick | null }>();

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

    // #146: one more Twelve Data read counted for the UTC day, unless the
    // day's count has reached `cap` (false). Counting that fails lets the
    // read go ahead: the chart is not taken down by its own bookkeeping.
    const takeTwelveRead = async (cap: number): Promise<boolean> => {
      try {
        const r = await rest("rpc/take_twelve_data_credit", { method: "POST", body: JSON.stringify({ p_cap: cap }) });
        if (!r.ok) {
          console.error("twelve data count failed:", r.status, await r.text().catch(() => ""));
          return true;
        }
        return (await r.json().catch(() => true)) !== false;
      } catch (err) {
        console.error("twelve data count failed:", err);
        return true;
      }
    };

    // v3: the last bars from Twelve Data, from the table while they are
    // fresh, fetched again when not (within this instance's allowance and,
    // #146, the day's for the timeframe), and stale ones rather than none
    // (#146: `limited` when it was the day's that stopped them)
    const fallbackBars = async (
      pair: string,
      interval: string,
      // #127: gold's own rule for "fresh", and how many bars it reads
      fresh: (fetchedAtMs: number) => boolean = (t) => nowMs - t < FALLBACK_TTL_MS,
      outputsize?: number,
      // #154: of the minute's allowance, how many to leave (DOW_ROOM)
      room = 0,
    ): Promise<{ bars: Candle[]; fetchedAt: string; limited?: boolean } | null> => {
      const key = `pair=eq.${encodeURIComponent(pair)}&interval=eq.${encodeURIComponent(interval)}`;
      const res = await rest(`live_chart_fallback?${key}&select=bars,fetched_at`);
      const rows = res.ok ? await res.json().catch(() => null) : null;
      const row = Array.isArray(rows) && rows.length > 0 ? rows[0] as { bars?: unknown; fetched_at?: unknown } : null;
      const stored = row && Array.isArray(row.bars) && typeof row.fetched_at === "string"
        ? { bars: row.bars as Candle[], fetchedAt: row.fetched_at }
        : null;
      if (stored && fresh(Date.parse(stored.fetchedAt))) return stored;
      while (fallbackFetches.length > 0 && nowMs - fallbackFetches[0] > 60_000) fallbackFetches.shift();
      if (!twelveKey || fallbackFetches.length >= FALLBACK_FETCHES_PER_MIN - room) return stored;
      // #154: the minute's slot is taken before the day's count is asked, so
      // reads made at once (the Dow reading's timeframes) cannot all pass
      // the check above together; given back when the day's cap says no
      fallbackFetches.push(nowMs);
      if (!(await takeTwelveRead(twelveCapFor(interval)))) {
        const k = fallbackFetches.lastIndexOf(nowMs);
        if (k >= 0) fallbackFetches.splice(k, 1);
        return stored ? { ...stored, limited: true } : null;
      }
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
    // #127: gold's bars, from the table while no bar has closed since.
    // #147: bars that could not be read again go on from the prices
    // recorded since they were read. #154: any pair's read as gold is (its
    // prices recorded in live_tick_bars; gold's in gold_tick_bars)
    const twelveBars = async (
      pair: string,
      interval: string,
      room = 0,
    ): Promise<{ bars: Candle[]; fetchedAt: string; limited?: boolean; ticksFrom?: string | null } | null> => {
      const fresh = (t: number) => goldFresh(t, nowMs, interval, isPossiblyClosed(nowMs));
      const fb = await fallbackBars(pair, interval, fresh, GOLD_BARS, room);
      if (!fb || fresh(Date.parse(fb.fetchedAt))) return fb;
      try {
        const from = new Date(Math.floor(Date.parse(fb.fetchedAt) / 60_000) * 60_000).toISOString();
        const cols = "select=minute,open,high,low,close,last_at&order=minute.asc&limit=5000";
        const res = await rest(
          isGold(pair)
            ? `gold_tick_bars?minute=gte.${encodeURIComponent(from)}&${cols}`
            : `live_tick_bars?pair=eq.${encodeURIComponent(pair)}&minute=gte.${encodeURIComponent(from)}&${cols}`,
        );
        if (!res.ok) return fb;
        const ext = extendWithTicks(fb.bars, interval, fb.fetchedAt, parseTickMinutes(await res.json().catch(() => null)));
        return { ...fb, ...ext };
      } catch (err) {
        console.error("ticks read failed:", pair, err);
        return fb;
      }
    };
    const unavailable = () =>
      maintenance
        ? json({ ok: false, error: "maintenance", reopens, version: FUNCTION_VERSION }, 503)
        : json({ ok: false, error: "feed_unavailable", reopens, version: FUNCTION_VERSION }, 502);

    if (action === "ticker") {
      // #154: the pair on screen, if it is one read from Swissquote
      const viewed = isLivePair(body?.pair) && isTwelveFx(body.pair) ? body.pair : null;
      const due = swissquoteDue(viewed, (p) => sqCache.get(p)?.at, nowMs, TICKER_TTL_MS, SQ_OTHERS_MS, SQ_OTHERS_PER_READ);
      // taken before the reads, so a read at the same moment does not ask again
      for (const p of due) sqCache.set(p, { readAt: 0, tick: null, ...sqCache.get(p), at: nowMs });
      const sqRead = Promise.all(due.map(async (p) => {
        try {
          const r = await fetch(swissquoteUrl(p), { signal: AbortSignal.timeout(5_000) });
          const tick = r.ok ? parseSwissquoteFx(await r.json().catch(() => null), nowMs) : null;
          if (!r.ok) await r.body?.cancel();
          if (!tick) return;
          sqCache.set(p, { at: nowMs, readAt: nowMs, tick });
          // the pair on screen's price kept, a minute at a time, for its bars
          // between Twelve Data's reads (as gold's, #147)
          if (p === viewed && tick.open && tick.time) {
            const rec = await rest("rpc/record_live_tick", { method: "POST", body: JSON.stringify({ p_pair: p, p_at: tick.time, p_mid: tick.mid }) });
            if (!rec.ok) console.error("tick record failed:", p, rec.status, await rec.text().catch(() => ""));
          }
        } catch (err) {
          console.error("swissquote read failed:", p, err);
        }
      }));
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
        // #147: gold's price kept, a minute at a time, for its bars between
        // Twelve Data's reads (only a price from a market trading now)
        if (gold && gold.open && gold.time) {
          try {
            const r = await rest("rpc/record_gold_tick", { method: "POST", body: JSON.stringify({ p_at: gold.time, p_mid: gold.mid }) });
            if (!r.ok) console.error("gold tick record failed:", r.status, await r.text().catch(() => ""));
          } catch (err) {
            console.error("gold tick record failed:", err);
          }
        }
        if (Object.keys(ticks).length > 0) {
          tickerCache = { at: nowMs, body: { ok: true, version: FUNCTION_VERSION, at: new Date(nowMs).toISOString(), ticks } };
        }
      }
      await sqRead;
      const fxTicks: Record<string, Tick> = {};
      for (const p of TWELVE_FX_PAIRS) {
        const hit = sqCache.get(p);
        if (hit?.tick && nowMs - hit.readAt <= SQ_KEEP_MS) fxTicks[p] = hit.tick;
      }
      // GMO's and gold's prices as before: none read (GMO's maintenance)
      // says so, unless the pair on screen is one Swissquote answered for
      const cached = tickerCache && nowMs - tickerCache.at <= TICKER_TTL_MS ? tickerCache.body as { ticks: Record<string, Tick> } : null;
      if (!cached && !(viewed && fxTicks[viewed])) return unavailable();
      return json({
        ok: true,
        version: FUNCTION_VERSION,
        at: new Date(nowMs).toISOString(),
        ticks: { ...(cached?.ticks ?? {}), ...fxTicks },
      });
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
      // #127: gold, from Twelve Data (GMO has none); #154: and the pairs GMO
      // does not serve
      if (isTwelvePair(pair)) {
        const fb = await twelveBars(pair, interval);
        if (!fb) return json({ ok: false, error: "feed_unavailable", reopens, version: FUNCTION_VERSION }, 502);
        const out = { ok: true, version: FUNCTION_VERSION, reopens, read: twelveRead(pair, fb.bars, interval, nowMs, fb.fetchedAt, fb.limited === true, fb.ticksFrom ?? null) };
        if (barsCache.size > CACHE_KEYS) barsCache.clear();
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
          limited: fb.limited === true,
        });
        // not cached here: the next read should try GMO again
        return json({ ok: true, version: FUNCTION_VERSION, reopens, read });
      }
      const out = { ok: true, version: FUNCTION_VERSION, reopens, read: liveRead(pair, interval, quotes, nowMs) };
      if (barsCache.size > CACHE_KEYS) barsCache.clear();
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
      // #127: gold's history is the bars it already reads (GOLD_BARS deep);
      // #154: so is each pair's read as gold is
      if (isTwelvePair(pair)) {
        const fb = await twelveBars(pair, interval);
        if (!fb) return json({ ok: false, error: "feed_unavailable", reopens, version: FUNCTION_VERSION }, 502);
        return json({ ok: true, version: FUNCTION_VERSION, history: historyOfBars(pair, interval, fb.bars, nowMs, fb.fetchedAt) });
      }
      const key = `${pair}|${interval}`;
      const hit = historyCache.get(key);
      if (hit && nowMs - hit.at <= HISTORY_TTL_MS) return json(hit.body);
      const quotes = await fetchLiveQuotes(pair, interval, nowMs, nowMs + FETCH_BUDGET_MS, fetcher, HISTORY_BARS + 1);
      if (!quotes || quotes.length === 0) return unavailable();
      const out = { ok: true, version: FUNCTION_VERSION, history: historyRead(pair, interval, quotes, nowMs) };
      if (historyCache.size > CACHE_KEYS) historyCache.clear();
      historyCache.set(key, { at: nowMs, body: out });
      return json(out);
    }

    // #129: Dow theory on four timeframes
    if (action === "dow") {
      const pair = body?.pair;
      if (!isLivePair(pair)) return json({ ok: false, error: "invalid_request", pairs: LIVE_PAIRS }, 400);
      const shut = isPossiblyClosedFor(pair, nowMs);
      // the timeframes at once (each within the same fetch budget)
      const out = await Promise.all(dowTfsFor(pair).map(async (tf) => {
        const key = `${pair}|${tf}`;
        const step = LIVE_STEP_MS[tf];
        const hit = dowCache.get(key);
        const newest = hit && hit.closed.length > 0 ? barOpenMs(hit.closed[hit.closed.length - 1].datetime) : NaN;
        // a newer bar has closed since this was read (and a while has
        // passed); while the market may be shut, every few minutes
        const stale = !hit || !Number.isFinite(newest) ||
          (shut ? nowMs - hit.at > DOW_SHUT_RETRY_MS : nowMs >= newest + 2 * step && nowMs - hit.at > DOW_RETRY_MS);
        let closed = hit?.closed ?? null;
        if (stale) {
          if (isTwelvePair(pair)) {
            // #154: within DOW_ROOM, so the chart's own bars come first
            const fb = await twelveBars(pair, tf, DOW_ROOM);
            closed = fb ? closedOf(fb.bars, tf, nowMs, fb.fetchedAt) : closed;
          } else {
            const quotes = await fetchDowQuotes(pair, tf, nowMs, nowMs + FETCH_BUDGET_MS, fetcher);
            closed = quotes && quotes.length > 0 ? splitBars(quotes, tf, nowMs).closed : closed;
          }
          if (closed) {
            if (dowCache.size > CACHE_KEYS) dowCache.clear();
            dowCache.set(key, { at: nowMs, closed });
          }
        }
        return closed && closed.length > 0 ? dowOf(pair, tf, closed) : { tf, error: "unavailable" };
      }));
      return json({ ok: true, version: FUNCTION_VERSION, at: new Date(nowMs).toISOString(), dow: out });
    }

    return json({ ok: false, error: "invalid_request" }, 400);
  } catch (err) {
    console.error("live-chart failed:", err);
    return json({ ok: false, error: "internal_error" }, 500);
  }
});
