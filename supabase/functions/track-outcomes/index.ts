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
  parseCandleTime,
  ENTRY_WINDOW_MS,
  EVAL_INTERVAL,
  EVAL_OUTPUTSIZE,
  REFINE_INTERVAL,
  hasFutureCandles,
  isDue,
  judgePlan,
  stampOnly,
  type Evaluation,
  type FineFetcher,
  type OpenRow,
} from "./evaluate.ts";
import { fetchQuotes, fetchQuoteWindow, supportsQuotes, type Fetcher, type QuoteCandle } from "./quotes.ts";
import { judgeWait, type WaitBar } from "./waits.ts";

const TRACKER_VERSION = "track-outcomes-v10-2026-09-05T03:30:00Z";
const USER_COOLDOWN_MS = 5 * 60 * 1000;
const SWEEP_COOLDOWN_MS = 10 * 60 * 1000;
const MAX_ROWS = 60;
// WAIT rows judged per sweep. Lower than MAX_ROWS: an open position needs
// looking at now, a call that declined to trade can wait a tick.
const MAX_WAIT_ROWS = 20;
// Market-data requests per run (series fetches + refinements together). The
// shared key allows 8 per minute; the rest is left for analyses running at
// the same moment. Anything beyond the budget waits for the next tick.
const MAX_REQUESTS = 5;

// Quotes come from a different provider (GMO Coin's public FX endpoint:
// keyless, no account, bid and ask served separately), so they do not spend
// the Twelve Data budget above. Two requests per date key per group, so
// the lookback is capped: a plan whose window is longer than this is judged
// on the mid feed, and says so in `price_basis`.
//
// The budget is shared between the coarse series and the refinements that
// split its ambiguous bars (fetchQuoteWindow), which must come from the same
// feed — until v10 refinements went to the mid feed and cost nothing here.
// The arithmetic, measured with dateKeys: the padded walk over a 48h
// lookback is 5 day keys = 10 requests, and over the 3-day cap 6 keys = 12.
// The old budget of 12 was sized for the coarse series alone; keeping it
// would leave a 48h group 2 requests (one refinement in the common case,
// none if it straddled the roll) and a group at the cap nothing, so its
// ambiguous bars would wait a tick each. At 20 a 48h group leaves 10 (five
// two-request refinements, or two four-request ones across a roll) and a
// capped group leaves 8. The endpoint is keyless and public and the sweep
// runs four times an hour, so the extra eight requests are not a quota
// concern.
const MAX_QUOTE_REQUESTS = 20;
const MAX_QUOTE_LOOKBACK_MS = 3 * 24 * 60 * 60 * 1000;
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

// Percent-encoded query string (a space becomes %20, not the form-style "+")
const query = (params: Record<string, string>) =>
  Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");

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
    // PATCH that reports whether it matched anything, so a cooldown can be
    // claimed atomically and an outcome counted only when it was written
    const patchRows = async (path: string, body: JsonRecord): Promise<number> => {
      const res = await rest(path, {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify(body),
      });
      const rows = res.ok ? await res.json().catch(() => null) : null;
      if (!res.ok) await res.text().catch(() => {});
      return Array.isArray(rows) ? rows.length : 0;
    };
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

      // Claim the global cooldown in one conditional update: two ticks
      // arriving together cannot both pass
      const cutoff = encodeURIComponent(new Date(nowMs - SWEEP_COOLDOWN_MS).toISOString());
      const claimed = await patchRows(
        `tracker_state?id=eq.1&or=(last_sweep_at.is.null,last_sweep_at.lt.${cutoff})`,
        { last_sweep_at: nowIso },
      );
      if (claimed === 0) {
        return json({ ok: true, mode: "sweep", updated: 0, skipped: "cooldown", version: TRACKER_VERSION });
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
      if (!userRes.ok) {
        return json({ ok: false, error: "認証に失敗しました" }, 401);
      }
      const userData = await userRes.json();
      const userId = isRecord(userData) && typeof userData.id === "string" ? userData.id : null;
      if (!userId) {
        return json({ ok: false, error: "認証に失敗しました" }, 401);
      }

      // Per-user cooldown, claimed the same way: each call can trigger
      // several market-data fetches against a shared API key
      const cutoff = encodeURIComponent(new Date(nowMs - USER_COOLDOWN_MS).toISOString());
      const claimed = await patchRows(
        `profiles?id=eq.${encodeURIComponent(userId)}&or=(last_tracked_at.is.null,last_tracked_at.lt.${cutoff})`,
        { last_tracked_at: nowIso },
      );
      if (claimed === 0) {
        return json({ ok: true, mode: "user", updated: 0, skipped: "cooldown", version: TRACKER_VERSION });
      }
      scope = { kind: "user", userId };
    }

    // ---- open plans that are due a look ----------------------------------
    // Stalest first (never-checked rows ahead of everything), so a backlog
    // larger than one page still gets through over successive ticks
    const select = "id,pair,interval,signal,entry_point,stop_loss,take_profit_1,take_profit_2,take_profit_3,created_at,price_at_signal,evaluation";
    const ownerFilter = scope.kind === "user" ? `user_id=eq.${encodeURIComponent(scope.userId)}&` : "";
    const listRes = await rest(
      `analyses?${ownerFilter}outcome=eq.pending&select=${select}&order=evaluation->>checked_at.asc.nullsfirst,created_at.asc&limit=${MAX_ROWS}`,
    );
    if (!listRes.ok) {
      await listRes.text().catch(() => {});
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

    // No early return when nothing is due. The WAIT pass further down is the
    // only thing that scores a call which declined to trade, and returning
    // here would have skipped it on every tick with no open position ready
    // for a look — which is most of them.
    const due = rows.filter((row) => isDue(row, nowMs));

    // One price fetch per pair+evaluation interval
    const groups = new Map<string, OpenRow[]>();
    for (const row of due) {
      const key = `${row.pair}|${EVAL_INTERVAL[row.interval] ?? "1h"}`;
      const list = groups.get(key) ?? [];
      list.push(row);
      groups.set(key, list);
    }

    let requests = 0;
    const fetchSeries = async (params: Record<string, string>): Promise<Candle[] | null> => {
      if (requests >= MAX_REQUESTS) return null;
      requests++;
      const qs = query({ ...params, timezone: "UTC", apikey: twelveDataKey });
      try {
        const res = await fetch(`${TWELVE_DATA}?${qs}`);
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

    let checked = 0;
    let updated = 0;
    let deferred = 0;
    let groupCount = 0;
    const errors: string[] = [];
    const resolved: Array<{ id: string; outcome: string }> = [];

    // One URL of the quote feed, on the quote budget. Shared by the coarse
    // series and the refinements so the two draw on the same count. A
    // refusal for budget is recorded so a walk cut short by it can be told
    // from a provider that answered with nothing.
    let quoteRequests = 0;
    let quoteStarved = false;
    const quoteFetcher: Fetcher = async (url) => {
      if (quoteRequests >= MAX_QUOTE_REQUESTS) {
        quoteStarved = true;
        return null;
      }
      quoteRequests++;
      const r = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!r.ok) return null;
      return await r.json().catch(() => null);
    };

    // Finer bars for one ambiguous coarse bar, from the SAME feed the coarse
    // series came from — `basis` is that feed. Bid/ask sub-bars for a bid/ask
    // series, mid sub-bars for a mid series, never mixed: a stop grazed on
    // the bid by less than the spread is invisible on the mid, so mid
    // sub-bars under a quotes series show no touch where the bid made one
    // and the judge writes feed_conflict for a bar the bid really did decide.
    // If the same-basis fetch fails the plan waits for another attempt; it is
    // not decided on the other feed.
    let refinements = 0;
    let quoteRefinements = 0;
    const fetchFine: FineFetcher = async (pair, fromMs, toMs, interval, basis) => {
      if (basis === "quotes") {
        // The cheapest window is two requests; with less than that left the
        // walk cannot even start, so wait a tick at no cost to the plan
        if (MAX_QUOTE_REQUESTS - quoteRequests < 2) return "deferred";
        quoteStarved = false;
        try {
          const res = await fetchQuoteWindow(pair, interval, fromMs, toMs, nowMs, quoteFetcher);
          // The walk needed a further key (a bar before or across the roll)
          // and the budget refused it: the feed did not fail, this run did.
          // Inside the maybe-shut hour the gap is zero whatever was found, so
          // there an empty result is the tell.
          if (quoteStarved && (!res || res.missing.length > 0 || res.bars.length === 0)) return "deferred";
          // Counted once the feed has answered: a walk the budget cut short
          // is reported under `deferred`, not here
          quoteRefinements++;
          if (!res || res.bars.length === 0) {
            errors.push(`${pair}|${interval}: quotes fine no_data`);
            return null;
          }
          if (res.missing.length > 0) {
            errors.push(`${pair}|${interval}: quotes fine incomplete (${res.missing.join(",")})`);
            return null;
          }
          return { basis: "quotes", bars: res.bars };
        } catch (err) {
          // The throw may have landed on the last request the budget allowed
          // while the next was refused: still this run's shortfall, not the
          // feed's
          if (quoteStarved) return "deferred";
          quoteRefinements++;
          errors.push(`${pair}|${interval}: quotes fine ${err instanceof Error ? err.message : String(err)}`);
          return null;
        }
      }
      if (requests >= MAX_REQUESTS) return "deferred"; // a later tick, at no cost to the plan
      refinements++;
      const bars = await fetchSeries({
        symbol: pair,
        interval,
        start_date: tdDate(fromMs),
        end_date: tdDate(toMs),
        outputsize: "200",
      });
      return bars === null ? null : { basis: "mid", bars };
    };

    // Bid and ask for a group, when the window is short enough to be worth
    // the requests. A failure here is never fatal: the plan is judged on the
    // mid feed exactly as it was before.
    let quoteGroups = 0;
    let quoteEmptyKeys = 0;
    const fetchQuotesFor = async (pair: string, evalInterval: string, fromMs: number): Promise<QuoteCandle[] | null> => {
      if (!supportsQuotes(pair, evalInterval)) return null;
      if (quoteRequests >= MAX_QUOTE_REQUESTS) return null;
      if (nowMs - fromMs > MAX_QUOTE_LOOKBACK_MS) return null;
      try {
        quoteStarved = false;
        const res = await fetchQuotes(pair, evalInterval, fromMs, nowMs, nowMs, quoteFetcher);
        // The walk goes oldest key first, so a budget that runs out mid-walk
        // refuses the NEWEST keys — the current trading day — and a series
        // short of its last three bars still passes the coverage check
        // (MAX_GAP_INTERVALS). Judged on it, a touch in those bars waits a
        // tick and a plan made in them has no signal bar. Fall back to the
        // mid feed for this group instead, as for any incomplete series.
        if (quoteStarved) {
          errors.push(`${pair}|${evalInterval}: quotes deferred (request budget)`);
          return null;
        }
        if (!res || res.bars.length === 0) return null;
        // A gap in the two-sided series would be judged as "price never got
        // there"; fall back rather than invent a verdict from partial data.
        // `missing` now measures the hole in open market rather than counting
        // date keys that came back empty — the provider's newest trading day
        // has no file until the trading-day roll (see jstDayKey in quotes.ts),
        // and treating that as a failure silently sent every judgement back to
        // the mid feed.
        if (res.missing.length > 0) {
          errors.push(`${pair}|${evalInterval}: quotes incomplete (${res.missing.join(",")})`);
          return null;
        }
        if (res.empty.length > 0) quoteEmptyKeys += res.empty.length;
        quoteGroups++;
        return res.bars;
      } catch (err) {
        errors.push(`${pair}|${evalInterval}: quotes ${err instanceof Error ? err.message : String(err)}`);
        return null;
      }
    };


    const writeRow = async (row: OpenRow, patch: JsonRecord): Promise<boolean> => {
      const n = await patchRows(`analyses?id=eq.${encodeURIComponent(row.id)}&outcome=eq.pending`, patch);
      if (n === 0) errors.push(`${row.id}: not updated`);
      return n > 0;
    };

    for (const [key, groupRows] of groups) {
      if (requests >= MAX_REQUESTS) {
        deferred += groupRows.length;
        errors.push(`${key}: deferred (request budget)`);
        continue;
      }
      groupCount++;

      const [pair, evalInterval] = key.split("|");
      const candles = await fetchSeries({
        symbol: pair,
        interval: evalInterval,
        outputsize: String(EVAL_OUTPUTSIZE[evalInterval] ?? 1500),
      });

      let refusal: string | null = null;
      if (!candles || candles.length === 0) {
        refusal = "no_data";
      } else if (hasFutureCandles(candles, nowMs)) {
        // Judging against mis-dated bars is how the first tracker went wrong;
        // leave the rows alone and say so
        console.error("market data dated in the future, refusing to judge:", key, candles[candles.length - 1].datetime);
        refusal = "future_candles";
      }
      if (refusal !== null || !candles) {
        errors.push(`${key}: ${refusal ?? "no_data"}`);
        // Stamp the rows so the same group is not re-fetched every tick
        for (const row of groupRows) {
          await writeRow(row, { evaluation: stampOnly(row, evalInterval, nowMs, refusal ?? "no_data") });
        }
        continue;
      }

      // Two-sided bars for the whole group, when they can cover every plan in
      // it. A partial window would read as "price never got there", so the
      // oldest plan decides: if it reaches back too far, the group is judged
      // on the mid feed as before.
      const oldestMs = groupRows.reduce((min, r) => {
        const t = Date.parse(r.created_at);
        return Number.isFinite(t) ? Math.min(min, t) : min;
      }, nowMs);
      const quotes = await fetchQuotesFor(pair, evalInterval, oldestMs);

      for (const row of groupRows) {
        const judgement = await judgePlan(row, candles, evalInterval, nowMs, fetchFine, quotes ?? undefined);
        const patch: JsonRecord = judgement.resolution
          ? {
            outcome: judgement.resolution,
            outcome_price: judgement.outcome_price,
            closed_at: judgement.closed_at,
            evaluation: judgement.evaluation,
          }
          : { evaluation: judgement.evaluation };

        if (!(await writeRow(row, patch))) continue;
        checked++;
        if (judgement.evaluation.refine_pending) deferred++;
        if (judgement.resolution) {
          updated++;
          resolved.push({ id: row.id, outcome: judgement.resolution });
        }
      }
    }

    // ---- and the calls that declined to trade ----------------------------
    //
    // A WAIT is a prediction too, and it used to be the only one never
    // checked. Scored here against the smallest trade the entry gate would
    // itself have allowed, so no threshold is invented for the purpose. This
    // runs after the trades and only on whatever request budget is left: a
    // WAIT keeps until the next tick, an open position does not.
    let waitsChecked = 0;
    let waitsMissed = 0;
    if (scope.kind === "sweep" && requests < MAX_REQUESTS) {
      const waitRes = await rest(
        "analyses?outcome=eq.skipped&or=(wait_check.is.null,wait_check->>verdict.eq.pending)" +
          `&select=id,pair,interval,created_at,price_at_signal,context&order=created_at.asc&limit=${MAX_WAIT_ROWS}`,
      );
      const waitRaw = waitRes.ok ? await waitRes.json().catch(() => null) : null;
      const waitRows = Array.isArray(waitRaw) ? waitRaw.filter(isRecord) : [];
      // One price fetch per pair+interval, same as the trade path
      const waitGroups = new Map<string, JsonRecord[]>();
      for (const row of waitRows) {
        const pair = typeof row.pair === "string" ? row.pair : "";
        const interval = typeof row.interval === "string" ? row.interval : "";
        if (!pair || !interval) continue;
        const key = `${pair}|${EVAL_INTERVAL[interval] ?? interval}`;
        const list = waitGroups.get(key);
        if (list) list.push(row);
        else waitGroups.set(key, [row]);
      }
      for (const [key, groupRows] of waitGroups) {
        if (requests >= MAX_REQUESTS) {
          errors.push(`${key}: waits deferred (request budget)`);
          break;
        }
        const [pair, evalInterval] = key.split("|");
        const candles = await fetchSeries({
          symbol: pair,
          interval: evalInterval,
          outputsize: String(EVAL_OUTPUTSIZE[evalInterval] ?? 1500),
        });
        if (!candles || candles.length === 0 || hasFutureCandles(candles, nowMs)) {
          errors.push(`${key}: waits no_data`);
          continue;
        }
        const bars: WaitBar[] = candles
          .map((c) => ({ t: parseCandleTime(c.datetime), high: c.high, low: c.low }))
          .filter((b) => Number.isFinite(b.t));
        for (const row of groupRows) {
          const signalMs = Date.parse(String(row.created_at ?? ""));
          if (!Number.isFinite(signalMs)) continue;
          const entrySnap = isRecord(row.context) && isRecord(row.context.entry) ? row.context.entry : null;
          const check = judgeWait(
            {
              price: numberOrNull(row.price_at_signal) ?? (entrySnap ? numberOrNull(entrySnap.price) : null),
              atr: entrySnap ? numberOrNull(entrySnap.atr) : null,
              signalMs,
              horizonMs: ENTRY_WINDOW_MS[String(row.interval)] ?? 48 * 60 * 60 * 1000,
            },
            bars,
            nowMs,
          );
          const n = await patchRows(
            `analyses?id=eq.${encodeURIComponent(String(row.id))}&outcome=eq.skipped`,
            { wait_check: check },
          );
          if (n > 0) {
            waitsChecked++;
            if (check.verdict === "missed") waitsMissed++;
          }
        }
      }
    }

    const summary = {
      ok: true,
      mode: scope.kind,
      open: rows.length,
      due: due.length,
      groups: groupCount,
      requests,
      quote_requests: quoteRequests,
      quote_groups: quoteGroups,
      quote_empty_keys: quoteEmptyKeys,
      refinements,
      quote_refinements: quoteRefinements,
      checked,
      updated,
      deferred,
      resolved,
      waits_checked: waitsChecked,
      waits_missed: waitsMissed,
      errors,
      version: TRACKER_VERSION,
    };

    if (scope.kind === "sweep") {
      await patchRows("tracker_state?id=eq.1", { last_sweep_result: { ...summary, at: nowIso } });
    }

    return json(summary);
  } catch (err) {
    console.error("track-outcomes error:", err);
    return json({ ok: false, error: "サーバーエラーが発生しました" }, 500);
  }
});
