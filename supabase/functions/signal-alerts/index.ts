// #105: mail the RSI + Parabolic SAR signal to the people who asked for it.
//
// Two callers:
//   * pg_cron at 2, 17, 32 and 47 past the hour, with the shared sweep token
//     (migrations/20260925120000_signal_alerts.sql): read every subscribed
//     pair and timeframe, and mail each fresh signal once per subscriber;
//   * the app, with the user's JWT: read the settings ("status"), follow or
//     unfollow a chart ("set"), send oneself a test ("test").
//
// The subscriptions and the sent log are written here only, with the service
// role: the tables grant the user SELECT on their own rows and nothing else,
// so the plan check below cannot be stepped around from the browser.
//
// Mail goes out through Resend when RESEND_API_KEY is set. Until it is, every
// signal is still detected and logged — status "not_configured" — and the
// app says that no email can be sent yet, rather than pretending it was.
//
// #108: the sweep also reads every one of the app's seven pairs on every
// alert timeframe, followed or not, records each signal once in
// signal_events and settles the open ones against the bars that came after
// (record.ts). The app shows that record beside the alerts.
//
// #112: a second rule beside RSI + SAR, the GA-style rule
// (analyze/gainz.ts). It is read on the same bars, recorded and settled the
// same way (signal_events.rule tells the two apart), and mailed only to the
// charts subscribed with rule = 'gainz'.
//
// #155: Q-Trend's and ULTRA's signals, on every pair of the live chart
// (indicators.ts): a third caller, pg_cron every minute with the same token
// and {"mode": "indicators"}. Judged on the bars the live chart holds, with
// the chart's own code, and mailed to the charts subscribed with rule =
// 'qtrend' or 'ultra'. Not recorded or settled (signal_events is the two
// rules' record).

import {
  ALERT_INTERVALS,
  ALERT_PAIRS,
  DEFAULT_FROM,
  alertsAllowed,
  checkPair,
  isAlertInterval,
  isAlertPair,
  isLang,
  mayHaveFreshClose,
  renderSignalMail,
  renderTestMail,
  RULE_ID,
  ruleIdOf,
  sendMail,
  type FiredSignal,
  type Lang,
} from "./logic.ts";
import { GA_RULE_ID, isRuleKey, type RuleKey } from "../analyze/gainz.ts";
import type { Fetcher, QuoteCandle } from "../track-outcomes/quotes.ts";
import { BACKTEST, GA_BACKTEST, fillAt, settleEvent, summarize, type EventRow, type OpenEvent } from "./record.ts";
import { isPossiblyClosed } from "../_shared/market-hours.ts";
import {
  ALERT_TWELVE_CAP,
  INDICATOR_INTERVALS,
  INDICATOR_PAIRS,
  INDICATOR_RULES,
  TWELVE_ALERT_INTERVALS,
  TWELVE_READS_PER_RUN,
  TWELVE_RETRY_MS,
  gmoIntervalsDue,
  indicatorIntervalsFor,
  indicatorRuleId,
  indicatorSignals,
  isGmoChartPair,
  isIndicatorChart,
  isIndicatorRule,
  keepableKlines,
  klineFileEnded,
  klineFileKey,
  klineFileOf,
  klinePreloadDays,
  renderIndicatorMail,
  twelveCloseDue,
  twelvePhase,
  twelveReadDue,
  type IndicatorRule,
  type IndicatorSignal,
  type KlineFile,
} from "./indicators.ts";
import {
  GOLD_BARS,
  HISTORY_BARS,
  LIVE_STEP_MS,
  fetchLiveQuotes,
  historyOfBars,
  historyRead,
  isTwelvePair,
  parseTwelveData,
  twelveDataUrl,
} from "../live-chart/logic.ts";
import { GMO_INTERVALS, GMO_SYMBOLS, jstDayKey, jstYearKey } from "../track-outcomes/quotes.ts";
import { barOpenMs } from "../analyze/state.ts";
import type { Candle } from "../analyze/indicators.ts";

const FUNCTION_VERSION = "signal-alerts-v9-2026-09-29T15:30:00Z";

const MIN = 60_000;
// What one sweep may spend on the feed before it stops starting new charts
const FETCH_BUDGET_MS = 90_000;
// One test email per user per this long
const TEST_COOLDOWN_MS = 5 * MIN;
const RECENT_ALERTS = 20;
// How far back the record shown in the app reaches
const RECORD_DAYS = 365;

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

const gmoFetcher: Fetcher = async (url) => {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) {
      await r.body?.cancel();
      return null;
    }
    return await r.json().catch(() => null);
  } catch {
    return null;
  }
};

interface Subscription {
  user_id: string;
  pair: string;
  interval: string;
  lang: string;
  rule: RuleKey;
}

// ---- #155: what the "indicators" sweep keeps between its runs ----------------------------
//
// GMO's ended files (indicators.ts "GMO's files, kept"): those this instance
// has read, by klineFileKey; the table keeps them across instances, and each
// chart's are read from it once an instance
const klineMemory = new Map<string, unknown>();
const KLINE_MEMORY_MAX = 6000;
const klinePreloaded = new Set<string>();
// each chart's newest closed bar judged (its open, ms), so one close is
// judged once an instance
const judgedBar = new Map<string, number>();
// when each Twelve Data chart was last read here (besides the stored row's
// time, which twelveReadDue goes by: this holds when storing it failed)
const twelveReadAt = new Map<string, number>();
// where each Twelve Data chart's bars start within their length
// (twelvePhase), learned from its bars; 0 until they are seen
const twelvePhaseOf = new Map<string, number>();
// GMO's public API a request at a time, a fifth of a second apart
let gmoNextAt = 0;
const GMO_GAP_MS = 200;
// a sweep that runs past the minute is not joined by the next one in the
// same instance (it would read the same charts again)
let indicatorSweepRunning = false;
// Resend allows two requests a second
let sendNextAt = 0;
const SEND_GAP_MS = 600;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !supabaseAnonKey || !serviceRoleKey) {
      return json({ ok: false, error: "サーバー設定エラー" }, 500);
    }
    const resendKey = Deno.env.get("RESEND_API_KEY") ?? "";
    const emailConfigured = resendKey.length > 0;
    const from = Deno.env.get("ALERT_FROM") || DEFAULT_FROM;

    const serviceHeaders = {
      Authorization: `Bearer ${serviceRoleKey}`,
      apikey: serviceRoleKey,
      "Content-Type": "application/json",
    };
    const rest = (path: string, init: RequestInit = {}) =>
      fetch(`${supabaseUrl}/rest/v1/${path}`, { ...init, headers: { ...serviceHeaders, ...(init.headers ?? {}) } });
    const readRows = async (path: string): Promise<JsonRecord[]> => {
      const res = await rest(path);
      const rows = res.ok ? await res.json().catch(() => null) : null;
      if (!res.ok) console.error("read failed:", path.split("?")[0], res.status);
      return Array.isArray(rows) ? rows.filter(isRecord) : [];
    };
    const patchRow = async (id: string, body: JsonRecord) => {
      const res = await rest(`signal_alerts?id=eq.${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) });
      if (!res.ok) console.error("patch failed:", res.status, await res.text().catch(() => ""));
    };
    // Inserts one alert row unless the same signal is already logged for the
    // same subscriber. The unique key is the claim: two overlapping sweeps
    // cannot both mail it.
    const claimRow = async (row: JsonRecord): Promise<string | null> => {
      const res = await rest("signal_alerts?on_conflict=user_id,kind,pair,interval,bar_time,side,rule", {
        method: "POST",
        headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
        body: JSON.stringify(row),
      });
      const rows = res.ok ? await res.json().catch(() => null) : null;
      if (!res.ok) console.error("insert failed:", res.status, await res.text().catch(() => ""));
      return Array.isArray(rows) && rows.length > 0 && isRecord(rows[0]) && typeof rows[0].id === "string" ? rows[0].id : null;
    };
    const userEmail = async (userId: string): Promise<string | null> => {
      const res = await fetch(`${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(userId)}`, { headers: serviceHeaders });
      const body = res.ok ? await res.json().catch(() => null) : null;
      return isRecord(body) && typeof body.email === "string" && body.email.length > 0 ? body.email : null;
    };
    // One row per signal, whoever follows the chart. The unique key makes a
    // second sweep that sees the same bar a no-op; either way the id comes back.
    const eventId = async (row: JsonRecord): Promise<string | null> => {
      const res = await rest("signal_events?on_conflict=pair,interval,bar_time,side,rule", {
        method: "POST",
        headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
        body: JSON.stringify(row),
      });
      const rows = res.ok ? await res.json().catch(() => null) : null;
      if (!res.ok) console.error("event insert failed:", res.status, await res.text().catch(() => ""));
      if (Array.isArray(rows) && rows.length > 0 && isRecord(rows[0]) && typeof rows[0].id === "string") return rows[0].id;
      const found = await readRows(
        `signal_events?pair=eq.${encodeURIComponent(String(row.pair))}&interval=eq.${encodeURIComponent(String(row.interval))}` +
          `&bar_time=eq.${encodeURIComponent(String(row.bar_time))}&side=eq.${encodeURIComponent(String(row.side))}` +
          `&rule=eq.${encodeURIComponent(String(row.rule))}&select=id`,
      );
      return found.length > 0 && typeof found[0].id === "string" ? found[0].id : null;
    };
    const planOf = async (userId: string): Promise<string | null> => {
      const rows = await readRows(`profiles?id=eq.${encodeURIComponent(userId)}&select=plan`);
      return rows.length > 0 && typeof rows[0].plan === "string" ? rows[0].plan : null;
    };
    // Mail one claimed row and record what happened to it
    const deliver = async (id: string, to: string | null, mail: ReturnType<typeof renderTestMail>): Promise<string> => {
      if (!emailConfigured) {
        await patchRow(id, { status: "not_configured" });
        return "not_configured";
      }
      if (!to) {
        await patchRow(id, { status: "failed", error: "no_email" });
        return "failed";
      }
      // #155: two a second at most (Resend's limit), once more after a
      // "429 rate limit"
      const send = async () => {
        const at = Math.max(Date.now(), sendNextAt);
        sendNextAt = at + SEND_GAP_MS;
        await sleep(at - Date.now());
        return await sendMail(resendKey, from, to, mail);
      };
      let sent = await send();
      if (!sent.ok && sent.error.startsWith("429") && !/quota/i.test(sent.error)) {
        await sleep(1_500);
        sent = await send();
      }
      if (sent.ok) {
        await patchRow(id, { status: "sent", provider_id: sent.id, sent_at: new Date().toISOString() });
        return "sent";
      }
      console.error("send failed:", sent.error);
      await patchRow(id, { status: "failed", error: sent.error });
      return "failed";
    };

    const nowMs = Date.now();
    const bodyRaw = await req.json().catch(() => null);
    const body: JsonRecord = isRecord(bodyRaw) ? bodyRaw : {};

    // ---- #155: Q-Trend's and ULTRA's signals (indicators.ts) --------------------------------
    //
    // The charts due at this minute that somebody follows: GMO's read with
    // its ended files kept, Twelve Data's from the bars the live chart keeps
    // (public.live_chart_fallback, read again here when no bar of this close
    // is in them, within the day's reads), each judged as the chart judges
    // it, each fresh signal mailed once per subscriber.
    const indicatorSweep = async (): Promise<JsonRecord> => {
      const summary: JsonRecord = { ok: true, mode: "indicators", version: FUNCTION_VERSION, email_configured: emailConfigured };
      if (isPossiblyClosed(nowMs)) return { ...summary, skipped: "market_closed" };
      const minute = new Date(nowMs).getUTCMinutes();
      // GMO's files kept past two months are not needed again (the hourly
      // chart reaches back some 40 days)
      if (new Date(nowMs).getUTCHours() === 3 && minute === 7) {
        const res = await rest(`gmo_kline_files?fetched_at=lt.${encodeURIComponent(new Date(nowMs - 60 * 24 * 60 * MIN).toISOString())}`, { method: "DELETE" });
        if (!res.ok) console.error("kline purge failed:", res.status, await res.text().catch(() => ""));
      }
      const subs = (await readRows("signal_alert_subscriptions?rule=in.(qtrend,ultra)&select=user_id,pair,interval,lang,rule"))
        .filter((r) => typeof r.user_id === "string" && isIndicatorRule(r.rule) && isIndicatorChart(r.pair, r.interval) && typeof r.lang === "string")
        .map((r) => ({ user_id: r.user_id as string, pair: r.pair as string, interval: r.interval as string, lang: r.lang as string, rule: r.rule as IndicatorRule }));
      summary.subscriptions = subs.length;
      if (subs.length === 0) return summary;

      // the charts followed, due now: GMO's by the minute, Twelve Data's by
      // their close; the quicker timeframes first
      const gmoDue = gmoIntervalsDue(nowMs);
      const followed = [...new Set(subs.map((x) => `${x.pair}|${x.interval}`))].map((k) => {
        const [pair, interval] = k.split("|");
        return { pair, interval };
      });
      const order = (iv: string) => (INDICATOR_INTERVALS as readonly string[]).indexOf(iv);
      const gmoCharts = followed.filter((c) => isGmoChartPair(c.pair) && gmoDue.includes(c.interval)).sort((a, b) => order(a.interval) - order(b.interval));
      // Twelve Data's by where their own bars close: a chart whose bars have
      // not been seen by this instance is looked at in the first half hour
      // of every hour, when its stored bars tell
      const anHourClosed = twelveCloseDue("1h", nowMs) !== null;
      const twelveCharts = followed.filter((c) => {
        if (!isTwelvePair(c.pair)) return false;
        const phase = twelvePhaseOf.get(`${c.pair}|${c.interval}`);
        return phase === undefined ? anHourClosed : twelveCloseDue(c.interval, nowMs, phase) !== null;
      }).sort((a, b) => order(a.interval) - order(b.interval));
      const deadline = Date.now() + FETCH_BUDGET_MS;
      const reads: JsonRecord[] = [];
      const fired: IndicatorSignal[] = [];
      const files = { memory: 0, table: 0, ended: 0, live: 0 };

      // GMO, a request at a time; once it says it is down for maintenance,
      // no more
      let maintenance = false;
      const paced = async (url: string) => {
        if (maintenance) return null;
        const at = Math.max(Date.now(), gmoNextAt);
        gmoNextAt = at + GMO_GAP_MS;
        await sleep(at - Date.now());
        const got = await gmoFetcher(url);
        if (typeof got === "object" && got !== null && (got as { status?: unknown }).status === 5) maintenance = true;
        return got;
      };
      const storeFile = async (f: KlineFile, body: unknown) => {
        const res = await rest("gmo_kline_files?on_conflict=symbol,price_type,interval,date_key", {
          method: "POST",
          headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
          body: JSON.stringify({ symbol: f.symbol, price_type: f.priceType, interval: f.interval, date_key: f.date, body }),
        });
        if (!res.ok) console.error("kline store failed:", res.status, await res.text().catch(() => ""));
      };
      // an ended file from this instance, else from GMO (and kept); a file
      // still being written from GMO
      const cachedFetcher: Fetcher = async (url) => {
        const f = klineFileOf(url);
        if (!f || !klineFileEnded(f.date, nowMs)) {
          files.live++;
          return await paced(url);
        }
        const k = klineFileKey(f);
        if (klineMemory.has(k)) {
          files.memory++;
          return klineMemory.get(k);
        }
        files.ended++;
        const body = await paced(url);
        if (keepableKlines(body)) {
          if (klineMemory.size >= KLINE_MEMORY_MAX) klineMemory.clear();
          klineMemory.set(k, body);
          await storeFile(f, body);
        }
        return body;
      };
      // a chart's kept files, from the table, once an instance
      const preload = async (pair: string, interval: string) => {
        const symbol = GMO_SYMBOLS[pair];
        const spec = GMO_INTERVALS[interval];
        if (!symbol || !spec) return;
        const key = `${symbol}|${spec.name}`;
        if (klinePreloaded.has(key)) return;
        const since = spec.key === "day"
          ? jstDayKey(nowMs - klinePreloadDays(interval, HISTORY_BARS + 1) * 24 * 60 * MIN)
          : String(Number(jstYearKey(nowMs)) - 1);
        const rows = await readRows(
          `gmo_kline_files?symbol=eq.${encodeURIComponent(symbol)}&interval=eq.${encodeURIComponent(spec.name)}&date_key=gte.${since}&select=price_type,date_key,body`,
        );
        for (const r of rows) {
          if (typeof r.price_type !== "string" || typeof r.date_key !== "string" || !keepableKlines(r.body)) continue;
          if (klineMemory.size >= KLINE_MEMORY_MAX) klineMemory.clear();
          klineMemory.set(klineFileKey({ symbol, priceType: r.price_type, interval: spec.name, date: r.date_key }), r.body);
          files.table++;
        }
        klinePreloaded.add(key);
      };
      const judge = (pair: string, interval: string, closed: Candle[], newest: number) => {
        const sigs = indicatorSignals(pair, interval, closed, nowMs);
        judgedBar.set(`${pair}|${interval}`, newest);
        fired.push(...sigs);
        return { pair, interval, bars: closed.length, newest: new Date(newest).toISOString(), signals: sigs.map((x) => `${x.rule}:${x.side}${x.strong ? "!" : ""}`) };
      };

      // Twelve Data's first: a few reads at most, which GMO's many would
      // otherwise leave no time for
      let twelveLeft = TWELVE_READS_PER_RUN;
      const twelveKey = Deno.env.get("TWELVE_DATA_API_KEY") ?? "";
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
      for (const c of twelveCharts) {
        const key = `${c.pair}|${c.interval}`;
        const step = LIVE_STEP_MS[c.interval];
        const learn = (bars: Candle[]) => {
          const phase = twelvePhase(bars, c.interval);
          if (phase !== null) twelvePhaseOf.set(key, phase);
        };
        const closeNow = () => twelveCloseDue(c.interval, nowMs, twelvePhaseOf.get(key) ?? 0);
        const known = twelvePhaseOf.has(key);
        let close = known ? closeNow() : null;
        if (known && judgedBar.get(key) === (close as number) - step) {
          reads.push({ pair: c.pair, interval: c.interval, skipped: "judged" });
          continue;
        }
        // the bars the live chart keeps (live-chart index.ts fallbackBars)
        const rows = await readRows(`live_chart_fallback?pair=eq.${encodeURIComponent(c.pair)}&interval=eq.${encodeURIComponent(c.interval)}&select=bars,fetched_at`);
        let stored = rows.length > 0 && Array.isArray(rows[0].bars) && typeof rows[0].fetched_at === "string"
          ? { bars: rows[0].bars as Candle[], fetchedAt: rows[0].fetched_at as string }
          : null;
        if (stored) learn(stored.bars);
        else if (!twelvePhaseOf.has(key)) twelvePhaseOf.set(key, 0);
        close = closeNow();
        // its bars close at another hour
        if (close === null) continue;
        let expected = close - step;
        if (judgedBar.get(key) === expected) {
          reads.push({ pair: c.pair, interval: c.interval, skipped: "judged" });
          continue;
        }
        const closedOfStored = (x: { bars: Candle[]; fetchedAt: string }) => historyOfBars(c.pair, c.interval, x.bars, nowMs, x.fetchedAt).candles;
        const hasClose = (x: { bars: Candle[]; fetchedAt: string } | null) => {
          if (!x) return false;
          const cl = closedOfStored(x);
          return cl.length > 0 && barOpenMs(cl[cl.length - 1].datetime) === expected;
        };
        if (!hasClose(stored)) {
          // read since the close (twice at most) and the bar was not there
          if (!twelveReadDue(close, stored ? Date.parse(stored.fetchedAt) : Number.NaN, nowMs)) {
            reads.push({ pair: c.pair, interval: c.interval, skipped: "not_yet" });
            continue;
          }
          if (!twelveKey || twelveLeft <= 0 || Date.now() > deadline || nowMs - (twelveReadAt.get(key) ?? 0) < TWELVE_RETRY_MS) {
            reads.push({ pair: c.pair, interval: c.interval, skipped: "waiting" });
            continue;
          }
          if (!(await takeTwelveRead(ALERT_TWELVE_CAP))) {
            reads.push({ pair: c.pair, interval: c.interval, error: "day_spent" });
            continue;
          }
          twelveLeft--;
          twelveReadAt.set(key, nowMs);
          try {
            const r = await fetch(twelveDataUrl(c.pair, c.interval, twelveKey, GOLD_BARS), { signal: AbortSignal.timeout(10_000) });
            const bars = parseTwelveData(await r.json().catch(() => null), c.interval);
            if (!r.ok || !bars || bars.length < 60) {
              reads.push({ pair: c.pair, interval: c.interval, error: "twelve_unavailable" });
              continue;
            }
            // as of the run's clock, as the live chart stamps its reads
            const fetchedAt = new Date(nowMs).toISOString();
            // kept for the chart as well, in its own shape
            const up = await rest("live_chart_fallback?on_conflict=pair,interval", {
              method: "POST",
              headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
              body: JSON.stringify({ pair: c.pair, interval: c.interval, bars, source: "twelvedata", fetched_at: fetchedAt }),
            });
            if (!up.ok) console.error("fallback store failed:", up.status, await up.text().catch(() => ""));
            stored = { bars, fetchedAt };
            learn(bars);
          } catch (err) {
            console.error("twelve data read failed:", err);
            reads.push({ pair: c.pair, interval: c.interval, error: "twelve_unavailable" });
            continue;
          }
          // the bars read may start at another hour than was assumed
          close = closeNow();
          if (close === null) continue;
          expected = close - step;
          if (!hasClose(stored)) {
            reads.push({ pair: c.pair, interval: c.interval, skipped: "not_yet" });
            continue;
          }
        }
        const closed = closedOfStored(stored!);
        reads.push({ ...judge(c.pair, c.interval, closed, expected), twelve: true });
      }
      for (const c of gmoCharts) {
        const key = `${c.pair}|${c.interval}`;
        const step = LIVE_STEP_MS[c.interval];
        const spec = GMO_INTERVALS[c.interval];
        // on the day-keyed charts (5 min to 1 hour, on the UTC grid) the
        // newest closed bar is known before reading
        const expected = spec.key === "day" ? Math.floor(nowMs / step) * step - step : null;
        if (expected !== null && judgedBar.get(key) === expected) {
          reads.push({ pair: c.pair, interval: c.interval, skipped: "judged" });
          continue;
        }
        if (Date.now() > deadline || maintenance) {
          reads.push({ pair: c.pair, interval: c.interval, skipped: maintenance ? "maintenance" : "deadline" });
          continue;
        }
        await preload(c.pair, c.interval);
        // the chart's history read (the chart's own function), rounded as drawn
        const quotes = await fetchLiveQuotes(c.pair, c.interval, nowMs, deadline, cachedFetcher, HISTORY_BARS + 1);
        if (!quotes || quotes.length === 0) {
          reads.push({ pair: c.pair, interval: c.interval, error: maintenance ? "maintenance" : "unavailable" });
          continue;
        }
        const closed = historyRead(c.pair, c.interval, quotes, nowMs).candles;
        const newest = closed.length > 0 ? barOpenMs(closed[closed.length - 1].datetime) : Number.NaN;
        // a read cut short is not the chart's history (a year-keyed read
        // holds what the chart's does, fewer than 600 on the daily chart)
        if (spec.key === "day" && closed.length < HISTORY_BARS) {
          reads.push({ pair: c.pair, interval: c.interval, error: "short", bars: closed.length });
          continue;
        }
        if (expected !== null && newest !== expected) {
          reads.push({ pair: c.pair, interval: c.interval, skipped: "not_yet", newest: Number.isFinite(newest) ? new Date(newest).toISOString() : null });
          continue;
        }
        if (judgedBar.get(key) === newest) {
          reads.push({ pair: c.pair, interval: c.interval, skipped: "judged" });
          continue;
        }
        reads.push(judge(c.pair, c.interval, closed, newest));
      }

      summary.reads = reads;
      summary.files = files;
      summary.twelve_reads = TWELVE_READS_PER_RUN - twelveLeft;
      summary.signals = fired.length;
      if (fired.length === 0) return summary;

      const counts: Record<string, number> = { sent: 0, failed: 0, not_configured: 0, duplicate: 0, not_allowed: 0 };
      const access = new Map<string, { allowed: boolean; email: string | null }>();
      for (const sig of fired) {
        for (const sub of subs.filter((x) => x.pair === sig.pair && x.interval === sig.interval && x.rule === sig.rule)) {
          let who = access.get(sub.user_id);
          if (!who) {
            const [plan, email] = await Promise.all([planOf(sub.user_id), userEmail(sub.user_id)]);
            who = { allowed: alertsAllowed(plan, email), email };
            access.set(sub.user_id, who);
          }
          if (!who.allowed) {
            counts.not_allowed++;
            continue;
          }
          const id = await claimRow({
            user_id: sub.user_id,
            kind: "signal",
            pair: sig.pair,
            interval: sig.interval,
            bar_time: sig.barTime,
            closed_at: sig.closedAt,
            side: sig.side,
            entry: sig.close,
            stop: sig.sl,
            target: sig.tps ? sig.tps[0] : null,
            rsi: sig.rsi,
            rsi_prev: sig.rsiPrev,
            sar: null,
            atr: sig.eps,
            rule: indicatorRuleId(sig.rule),
            strong: sig.rule === "qtrend" ? sig.strong : null,
            event_id: null,
            status: "pending",
          });
          if (id === null) {
            counts.duplicate++;
            continue;
          }
          const lang: Lang = isLang(sub.lang) ? sub.lang : "ja";
          const outcome = await deliver(id, who.email, renderIndicatorMail(sig, lang));
          counts[outcome] = (counts[outcome] ?? 0) + 1;
        }
      }
      return { ...summary, ...counts };
    };

    // ---- the sweep ---------------------------------------------------------------
    const sweepToken = req.headers.get("x-sweep-token");
    if (sweepToken) {
      const tokenRes = await rest("rpc/track_outcomes_sweep_token", { method: "POST", body: "{}" });
      const expected = tokenRes.ok ? await tokenRes.json().catch(() => null) : null;
      if (typeof expected !== "string" || expected.length === 0 || !constantTimeEqual(sweepToken, expected)) {
        return json({ ok: false, error: "認証に失敗しました" }, 401);
      }
      // #155: every minute, Q-Trend's and ULTRA's
      if (body.mode === "indicators") {
        if (indicatorSweepRunning) return json({ ok: true, mode: "indicators", version: FUNCTION_VERSION, skipped: "busy" });
        indicatorSweepRunning = true;
        try {
          return json(await indicatorSweep());
        } finally {
          indicatorSweepRunning = false;
        }
      }
      const summary: JsonRecord = { ok: true, mode: "sweep", version: FUNCTION_VERSION, email_configured: emailConfigured };
      // "Enter now" is not an available action while the market may be shut,
      // which is when analyze refuses too
      if (isPossiblyClosed(nowMs)) return json({ ...summary, skipped: "market_closed" });

      // (#155: its own two rules' only — Q-Trend's and ULTRA's are the
      // "indicators" sweep's, and a rule this sweep does not know is not
      // RSI + SAR)
      const subs: Subscription[] = (await readRows("signal_alert_subscriptions?rule=in.(rsi_sar,gainz)&select=user_id,pair,interval,lang,rule"))
        .filter((r) => typeof r.user_id === "string" && isAlertPair(r.pair) && isAlertInterval(r.interval) && typeof r.lang === "string" && isRuleKey(r.rule))
        .map((r) => ({
          user_id: r.user_id as string,
          pair: r.pair as string,
          interval: r.interval as string,
          lang: r.lang as string,
          rule: isRuleKey(r.rule) ? r.rule : "rsi_sar",
        }));
      summary.subscriptions = subs.length;

      // Every chart the app covers, followed or not (#108): the record needs
      // the rule's signals, not only the ones somebody asked to be told about
      const charts = ALERT_PAIRS.flatMap((pair) => ALERT_INTERVALS.map((interval) => ({ pair, interval })))
        .filter((c) => mayHaveFreshClose(c.interval, nowMs));
      const openEvents = (await readRows("signal_events?outcome=is.null&select=id,pair,interval,bar_time,side,entry,stop,target,fill"))
        .filter((r) => typeof r.id === "string" && typeof r.bar_time === "string" && (r.side === "BUY" || r.side === "SELL"))
        .map((r) => ({
          id: r.id as string,
          pair: String(r.pair),
          interval: String(r.interval),
          bar_time: r.bar_time as string,
          side: r.side as "BUY" | "SELL",
          entry: Number(r.entry),
          stop: Number(r.stop),
          target: Number(r.target),
          fill: typeof r.fill === "number" ? r.fill : null,
        } satisfies OpenEvent));
      const deadline = Date.now() + FETCH_BUDGET_MS;
      const reads: JsonRecord[] = [];
      const fired: Array<FiredSignal & { eventId: string | null }> = [];
      let recorded = 0;
      let settled = 0;
      // One chart at a time: two requests in flight is gentle on a public feed
      for (const c of charts) {
        if (Date.now() > deadline) {
          reads.push({ pair: c.pair, interval: c.interval, skipped: "deadline" });
          continue;
        }
        const r = await checkPair(c.pair, c.interval, nowMs, deadline, gmoFetcher);
        reads.push({
          pair: c.pair,
          interval: c.interval,
          bars: r.bars,
          ok: r.read?.ok ?? false,
          bar: r.read?.now?.datetime ?? null,
          rsi: r.read?.now ? Number(r.read.now.rsi.toFixed(1)) : null,
          signal: r.read?.now?.signal ?? null,
          ga: r.gainz?.now?.signal ?? null,
          fresh: r.signals.length,
        });
        const quotes: QuoteCandle[] = r.quotes;
        for (const sig of r.signals) {
          const f = fillAt(quotes, sig.barTime, sig.side);
          const id = await eventId({
            pair: sig.pair,
            interval: sig.interval,
            bar_time: sig.barTime,
            closed_at: sig.closedAt,
            side: sig.side,
            rule: ruleIdOf(sig.rule),
            entry: sig.entry,
            stop: sig.stop,
            target: sig.target,
            atr: sig.atr,
            rsi: sig.rsi,
            rsi_prev: sig.rsiPrev,
            sar: sig.sar,
            fill: f?.fill ?? null,
            spread: f?.spread ?? null,
            costly: sig.costly,
          });
          if (id) recorded++;
          fired.push({ ...sig, eventId: id });
        }
        // Settle what this chart's bars can settle
        for (const ev of openEvents.filter((e) => e.pair === c.pair && e.interval === c.interval)) {
          const done = settleEvent(ev, quotes, nowMs);
          if (!done) continue;
          const res = await rest(`signal_events?id=eq.${encodeURIComponent(ev.id)}`, {
            method: "PATCH",
            body: JSON.stringify({ ...done, settled_at: new Date().toISOString() }),
          });
          if (res.ok) settled++;
          else console.error("settle failed:", res.status, await res.text().catch(() => ""));
        }
      }
      summary.reads = reads;
      summary.signals = fired.length;
      summary.recorded = recorded;
      summary.settled = settled;
      summary.open = openEvents.length - settled;
      if (fired.length === 0 || subs.length === 0) return json(summary);

      const counts: Record<string, number> = { sent: 0, failed: 0, not_configured: 0, skipped: 0, duplicate: 0, not_allowed: 0 };
      const access = new Map<string, { allowed: boolean; email: string | null }>();
      for (const sig of fired) {
        for (const sub of subs.filter((s) => s.pair === sig.pair && s.interval === sig.interval && s.rule === sig.rule)) {
          let who = access.get(sub.user_id);
          if (!who) {
            const [plan, email] = await Promise.all([planOf(sub.user_id), userEmail(sub.user_id)]);
            who = { allowed: alertsAllowed(plan, email), email };
            access.set(sub.user_id, who);
          }
          // A subscription outlives a lapsed plan; it just stops mailing
          if (!who.allowed) {
            counts.not_allowed++;
            continue;
          }
          const id = await claimRow({
            user_id: sub.user_id,
            kind: "signal",
            pair: sig.pair,
            interval: sig.interval,
            bar_time: sig.barTime,
            closed_at: sig.closedAt,
            side: sig.side,
            entry: sig.entry,
            stop: sig.stop,
            target: sig.target,
            rsi: sig.rsi,
            rsi_prev: sig.rsiPrev,
            sar: sig.sar,
            atr: sig.atr,
            rule: ruleIdOf(sig.rule),
            event_id: sig.eventId,
            status: sig.costly ? "skipped" : "pending",
            skip_reason: sig.costly ? "costly_hours" : null,
          });
          if (id === null) {
            counts.duplicate++;
            continue;
          }
          // Logged, not mailed: the app would answer WAIT at this hour
          // (timing.ts), and an email saying "buy now" when the app says
          // "wait" is worse than no email
          if (sig.costly) {
            counts.skipped++;
            continue;
          }
          const lang: Lang = isLang(sub.lang) ? sub.lang : "ja";
          const outcome = await deliver(id, who.email, renderSignalMail(sig, lang));
          counts[outcome] = (counts[outcome] ?? 0) + 1;
        }
      }
      return json({ ...summary, ...counts });
    }

    // ---- the app -------------------------------------------------------------------
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) return json({ ok: false, error: "認証が必要です" }, 401);
    const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { Authorization: authHeader, apikey: supabaseAnonKey },
    });
    const userData = userRes.ok ? await userRes.json().catch(() => null) : null;
    if (!isRecord(userData) || typeof userData.id !== "string") return json({ ok: false, error: "認証に失敗しました" }, 401);
    const userId = userData.id;
    const email = typeof userData.email === "string" ? userData.email : null;
    const plan = await planOf(userId);
    const allowed = alertsAllowed(plan, email);
    const uid = encodeURIComponent(userId);

    const status = async () => {
      const [subs, alerts] = await Promise.all([
        readRows(`signal_alert_subscriptions?user_id=eq.${uid}&select=pair,interval,lang,rule&order=created_at.asc`),
        readRows(
          `signal_alerts?user_id=eq.${uid}&select=id,kind,pair,interval,bar_time,closed_at,side,entry,stop,target,rsi,rsi_prev,sar,rule,strong,status,skip_reason,error,created_at,sent_at,event:signal_events(outcome,r,bars,exit_at)&order=created_at.desc&limit=${RECENT_ALERTS}`,
        ),
      ]);
      // #108: the live record. "all" is every signal the rule fired outside
      // the hours it is not mailed in; "mine" is the alerts this user was
      // actually sent.
      const since = encodeURIComponent(new Date(nowMs - RECORD_DAYS * 24 * 60 * MIN).toISOString());
      const [events, mine] = await Promise.all([
        readRows(`signal_events?closed_at=gte.${since}&select=interval,costly,outcome,r,rule&limit=20000`),
        readRows(`signal_alerts?user_id=eq.${uid}&kind=eq.signal&status=eq.sent&created_at=gte.${since}&select=rule,event:signal_events(outcome,r)&limit=20000`),
      ]);
      const row = (x: JsonRecord): EventRow => ({
        outcome: typeof x.outcome === "string" ? x.outcome : null,
        r: typeof x.r === "number" ? x.r : null,
      });
      // #112: one record per rule. #132: a row counts only under the rule id
      // it was decided by, the current setting's — a row of an earlier
      // setting (RSI(14) 30/70, GA 0.5/50/5) belongs to neither record.
      const ofRule = (ga: boolean) => (x: JsonRecord) => x.rule === (ga ? GA_RULE_ID : RULE_ID);
      const recordOf = (ga: boolean, backtest: typeof BACKTEST) => {
        const own = events.filter(ofRule(ga));
        const mailed = own.filter((e) => e.costly !== true);
        return {
          mine: summarize(mine.filter(ofRule(ga)).map((m) => (isRecord(m.event) ? row(m.event) : { outcome: null, r: null }))),
          all: summarize(mailed.map(row)),
          costly: summarize(own.filter((e) => e.costly === true).map(row)),
          byTf: Object.fromEntries(ALERT_INTERVALS.map((iv) => [iv, summarize(mailed.filter((e) => e.interval === iv).map(row))])),
          backtest,
        };
      };
      const performance = {
        days: RECORD_DAYS,
        ...recordOf(false, BACKTEST),
        gainz: recordOf(true, GA_BACKTEST),
      };
      return {
        ok: true,
        version: FUNCTION_VERSION,
        allowed,
        email_configured: emailConfigured,
        email,
        pairs: ALERT_PAIRS,
        intervals: ALERT_INTERVALS,
        // #155: Q-Trend's and ULTRA's charts: every pair of the live chart,
        // those read from Twelve Data on 1 hour and up
        indicator: {
          rules: INDICATOR_RULES,
          pairs: INDICATOR_PAIRS,
          intervals: INDICATOR_INTERVALS,
          limited: Object.fromEntries(INDICATOR_PAIRS.filter((p) => isTwelvePair(p)).map((p) => [p, indicatorIntervalsFor(p)])),
          limited_intervals: TWELVE_ALERT_INTERVALS,
        },
        subscriptions: subs.map((s) => ({
          pair: s.pair,
          interval: s.interval,
          rule: isRuleKey(s.rule) || isIndicatorRule(s.rule) ? s.rule : "rsi_sar",
        })),
        performance,
        alerts,
      };
    };

    const action = typeof body.action === "string" ? body.action : "status";
    if (action === "status") return json(await status());

    if (action === "set") {
      // #155: Q-Trend's and ULTRA's on their own charts
      const indicator = isIndicatorRule(body.rule);
      const chartOk = indicator ? isIndicatorChart(body.pair, body.interval) : isAlertPair(body.pair) && isAlertInterval(body.interval);
      if (!chartOk || typeof body.pair !== "string" || typeof body.interval !== "string" || typeof body.on !== "boolean") {
        return json({ ok: false, error: "invalid_request" }, 400);
      }
      // #112: which rule's signals; absent means RSI + SAR, as before
      if (body.rule !== undefined && !isRuleKey(body.rule) && !indicator) return json({ ok: false, error: "invalid_request" }, 400);
      const rule: RuleKey | IndicatorRule = indicator ? (body.rule as IndicatorRule) : isRuleKey(body.rule) ? body.rule : "rsi_sar";
      if (body.on) {
        if (!allowed) return json({ ok: false, error: "plan_required" }, 403);
        const res = await rest("signal_alert_subscriptions?on_conflict=user_id,pair,interval,rule", {
          method: "POST",
          headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
          body: JSON.stringify({ user_id: userId, pair: body.pair, interval: body.interval, rule, lang: isLang(body.lang) ? body.lang : "ja" }),
        });
        if (!res.ok) {
          console.error("subscribe failed:", res.status, await res.text().catch(() => ""));
          return json({ ok: false, error: "save_failed" }, 500);
        }
      } else {
        // Always possible, plan or not: nobody should need a subscription to
        // stop receiving mail
        const res = await rest(
          `signal_alert_subscriptions?user_id=eq.${uid}&pair=eq.${encodeURIComponent(body.pair)}&interval=eq.${encodeURIComponent(body.interval)}&rule=eq.${rule}`,
          { method: "DELETE" },
        );
        if (!res.ok) {
          console.error("unsubscribe failed:", res.status, await res.text().catch(() => ""));
          return json({ ok: false, error: "save_failed" }, 500);
        }
      }
      return json(await status());
    }

    // #155: many of Q-Trend's or ULTRA's charts at once (a timeframe across
    // every pair, or a pair across its timeframes)
    if (action === "set_many") {
      if (!isIndicatorRule(body.rule) || typeof body.on !== "boolean" || !Array.isArray(body.charts) || body.charts.length === 0 || body.charts.length > 200) {
        return json({ ok: false, error: "invalid_request" }, 400);
      }
      const rule = body.rule;
      const charts = body.charts.map((c) => (isRecord(c) ? { pair: c.pair, interval: c.interval } : { pair: null, interval: null }));
      if (!charts.every((c) => isIndicatorChart(c.pair, c.interval))) return json({ ok: false, error: "invalid_request" }, 400);
      const list = charts as Array<{ pair: string; interval: string }>;
      if (body.on) {
        if (!allowed) return json({ ok: false, error: "plan_required" }, 403);
        const lang = isLang(body.lang) ? body.lang : "ja";
        const res = await rest("signal_alert_subscriptions?on_conflict=user_id,pair,interval,rule", {
          method: "POST",
          headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
          body: JSON.stringify(list.map((c) => ({ user_id: userId, pair: c.pair, interval: c.interval, rule, lang }))),
        });
        if (!res.ok) {
          console.error("subscribe failed:", res.status, await res.text().catch(() => ""));
          return json({ ok: false, error: "save_failed" }, 500);
        }
      } else {
        // by timeframe, the pairs in one request each
        for (const iv of [...new Set(list.map((c) => c.interval))]) {
          const pairs = list.filter((c) => c.interval === iv).map((c) => `"${c.pair}"`).join(",");
          const res = await rest(
            `signal_alert_subscriptions?user_id=eq.${uid}&rule=eq.${rule}&interval=eq.${encodeURIComponent(iv)}&pair=in.(${encodeURIComponent(pairs)})`,
            { method: "DELETE" },
          );
          if (!res.ok) {
            console.error("unsubscribe failed:", res.status, await res.text().catch(() => ""));
            return json({ ok: false, error: "save_failed" }, 500);
          }
        }
      }
      return json(await status());
    }

    if (action === "test") {
      if (!allowed) return json({ ok: false, error: "plan_required" }, 403);
      const since = encodeURIComponent(new Date(nowMs - TEST_COOLDOWN_MS).toISOString());
      const recent = await readRows(`signal_alerts?user_id=eq.${uid}&kind=eq.test&created_at=gt.${since}&select=id`);
      if (recent.length > 0) return json({ ok: false, error: "test_cooldown" }, 429);
      const res = await rest("signal_alerts", {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({ user_id: userId, kind: "test", status: "pending" }),
      });
      const rows = res.ok ? await res.json().catch(() => null) : null;
      const id = Array.isArray(rows) && isRecord(rows[0]) && typeof rows[0].id === "string" ? rows[0].id : null;
      if (!id) return json({ ok: false, error: "save_failed" }, 500);
      const subs = await readRows(`signal_alert_subscriptions?user_id=eq.${uid}&select=pair,interval,rule&order=created_at.asc`);
      const lang: Lang = isLang(body.lang) ? body.lang : "ja";
      const outcome = await deliver(
        id,
        email,
        renderTestMail(
          subs.map((s) => ({ pair: String(s.pair), interval: String(s.interval), rule: isRuleKey(s.rule) || isIndicatorRule(s.rule) ? s.rule : "rsi_sar" })),
          lang,
        ),
      );
      return json({ ...(await status()), test: outcome });
    }

    return json({ ok: false, error: "invalid_request" }, 400);
  } catch (err) {
    console.error("signal-alerts failed:", err);
    return json({ ok: false, error: "internal_error" }, 500);
  }
});
