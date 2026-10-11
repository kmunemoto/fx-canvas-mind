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
// #108: the sweep also reads every one of the app's seven pairs (#175: the
// four yen pairs among them, logic.ts ALERT_PAIRS; #177: and EUR/USD;
// #178: and AUD/USD) on every alert timeframe, followed or not, records
// each signal once in signal_events and settles the open ones against the
// bars that came after (record.ts). The app shows that record beside the
// alerts.
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
// 'qtrend' or 'ultra' (#275: or 'macdx', the MACD peak-and-valley rule on the
// 5-minute chart of GMO's pairs). Not recorded or settled (signal_events is
// the two rules' record).
//
// #291: a fourth caller, pg_cron every minute with {"mode": "gold-ticks"}:
// Swissquote's gold price every few seconds all minute, recorded into
// public.gold_tick_bars (gold's 1-minute bars, the chart's too), and the
// minute that closed judged by the owner's video's way, mailed to the charts
// subscribed with rule = 'sweepx' (gold's 1-minute chart). Not recorded or
// settled either.

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
import { isPossiblyClosed, isPossiblyClosedFor } from "../_shared/market-hours.ts";
import {
  ALERT_TWELVE_CAP,
  INDICATOR_INTERVALS,
  INDICATOR_PAIRS,
  INDICATOR_RULES,
  MACDX_INTERVALS,
  MACDX_PAIRS,
  STALE_RETRY_MS,
  STALE_TRIES,
  TWELVE_ALERT_INTERVALS,
  TWELVE_READS_PER_RUN,
  TWELVE_RETRY_MS,
  gmoIntervalsDue,
  hourCloseOf,
  indicatorIntervalsFor,
  indicatorRuleId,
  indicatorSignals,
  isGmoChartPair,
  isIndicatorChartFor,
  isIndicatorRule,
  keepableKlines,
  klineFileEnded,
  klineFileKey,
  klineFileOf,
  klinePreloadDays,
  latestCloseMs,
  macdxSignals,
  SWEEPX_INTERVALS,
  SWEEPX_PAIRS,
  isSweepxChart,
  sweepxSignals,
  renderIndicatorMail,
  staleForClose,
  startWaitMs,
  twelveChartDue,
  twelveCloseDue,
  twelvePhase,
  twelveReadDue,
  type IndicatorRule,
  type IndicatorSignal,
  type KlineFile,
} from "./indicators.ts";
import {
  GOLD,
  GOLD_BARS,
  GOLD_QUOTE_URL,
  HISTORY_BARS,
  LIVE_STEP_MS,
  TWELVE_1MIN_BARS,
  fetchLiveQuotes,
  historyOfBars,
  historyRead,
  isTwelvePair,
  parseSwissquote,
  parseTickMinutes,
  parseTwelveData,
  tickMinuteCandles,
  twelveDataUrl,
  type Tick,
} from "../live-chart/logic.ts";
import { GOLD_TICK_EVERY_MS, goldSeedRows, goldTickPlan, judgesWhileShut, nextTickAt } from "./gold-minutes.ts";
import { SWEEPX } from "../_shared/sweep-cross.ts";
import { GMO_INTERVALS, GMO_SYMBOLS, jstDayKey, jstYearKey } from "../track-outcomes/quotes.ts";
import { barOpenMs } from "../analyze/state.ts";
import type { Candle } from "../analyze/indicators.ts";

// v14 (#176): the code is v13's; the bars of the pairs read as gold is are
// read GOLD_BARS (1,400) at once, as the live chart's deep history needs
// them stored. The signals judge from anchoredStart, so the mails are the same.
// v15 (#177): EUR/USD again, for RSI + SAR and the GA-style rule (ALERT_PAIRS)
// and Q-Trend and ULTRA (the live chart's pairs).
// v16 (#178): and AUD/USD again, likewise.
// v17 (#180): USD/CAD again, for Q-Trend and ULTRA (the live chart's pairs),
// read from Twelve Data as before #175: 1-hour to daily only. Not for RSI +
// SAR and the GA-style rule, which read GMO's bars (as before #175).
// v18 (#181): the version only. The live chart's 15 timeframes are in the
// live-chart logic this reads (LIVE_STEP_MS, barEndMs); the emails' own
// lists (ALERT_INTERVALS, INDICATOR_INTERVALS) are as they were, and for
// their timeframes every bar closes where it did.
// v19 (#182): GMO's 4-hour bar stamped Sunday 20:00 UTC (the week's first two
// hours) is no longer thrown away (quotes.ts usableBars): the 4-hour charts
// are judged at Monday 00:00 UTC too, and every 4-hour reading runs on the
// bars with it. The other timeframes' bars are as they were.
// v20 (#192): Q-Trend's and ULTRA's stop and targets, on gold and the pairs
// both, at the second F-INVEST video's chart: the stop 13 and the targets 4,
// 10 and 16 (dollars on gold, pips on a pair; _shared/ultra.ts ULTRA_PAIRS and
// ULTRA_GOLD), and the emails' measured figures at them (indicators.ts). The
// signals and the rule ids are as they were.
// v21 (#211): the Japanese emails name the pair as 楽天FX does (ユーロ/円, in
// the subject and the body; _shared/pair-names.ts). The English emails, the
// signals, the rule ids and what is recorded (the pair's code) are as they were.
// v22 (#212): gold's Q-Trend and ULTRA on 15 minutes too (indicators.ts
// GOLD_ALERT_INTERVALS): its bars read from Twelve Data after each 15-minute
// close, as the hourly ones after theirs; a chart whose bars' phase this
// instance has not learned is looked at by its own grid when under an hour
// (twelveChartDue). The other Twelve Data pairs stay on 1 hour and up.
// v23 (#275): a third rule beside Q-Trend and ULTRA, the MACD peak-and-valley
// rule (indicators.ts macdxSignals; docs §8.109), mailed to the charts
// subscribed with rule = 'macdx': the 5-minute chart of GMO's currency pairs
// only. Judged on the same closed bars as ULTRA, with the code the rule was
// measured with (_shared/macd-extreme.ts). Q-Trend's and ULTRA's signals, the
// rule ids and what is recorded are as they were.
// v24 (#291): gold's price from Swissquote recorded all day (a fourth caller,
// pg_cron every minute with {"mode": "gold-ticks"}; gold-minutes.ts), the
// minutes before it filled once from Twelve Data ({"mode": "gold-seed"}), and
// a fourth rule, the owner's video's way (indicators.ts sweepxSignals; docs
// §8.112), judged by that run on the minutes recorded and mailed to the
// charts subscribed with rule = 'sweepx': gold's 1-minute chart only. The
// other rules' signals, ids and what is recorded are as they were.
const FUNCTION_VERSION = "signal-alerts-v24-2026-10-11T12:00:00Z";

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

// #155: a chart followed under Q-Trend, ULTRA, the MACD rule (#275) or the
// video's way (#291)
interface IndicatorSub {
  user_id: string;
  pair: string;
  interval: string;
  lang: string;
  rule: IndicatorRule;
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
// #291: the minute (its start, ms) this instance's "gold-ticks" run is
// reading, so a second call for the same minute does not read it twice (the
// next minute's run may begin while this one ends)
let goldTicksMinute: number | null = null;
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

    // One more Twelve Data read counted for the UTC day, unless the day's
    // count has reached `cap` (live-chart's own, the same table); counting
    // that fails lets the read go ahead
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

    // #155: each fresh signal of Q-Trend, ULTRA (#275: the MACD rule; #291:
    // the video's way) to each of `subs` following its chart under its rule,
    // once (the claim's unique key); what happened, counted into `counts`
    const mailerFor = (subs: IndicatorSub[], counts: Record<string, number>) => {
      const access = new Map<string, { allowed: boolean; email: string | null }>();
      return async (sigs: IndicatorSignal[]) => {
        for (const sig of sigs) {
          for (const sub of subs.filter((x) => x.pair === sig.pair && x.interval === sig.interval && x.rule === sig.rule)) {
            let who = access.get(sub.user_id);
            if (!who) {
              const [plan, email] = await Promise.all([planOf(sub.user_id), userEmail(sub.user_id)]);
              who = { allowed: alertsAllowed(plan, email), email };
              access.set(sub.user_id, who);
            }
            if (!who.allowed) {
              counts.not_allowed = (counts.not_allowed ?? 0) + 1;
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
              counts.duplicate = (counts.duplicate ?? 0) + 1;
              continue;
            }
            const lang: Lang = isLang(sub.lang) ? sub.lang : "ja";
            const outcome = await deliver(id, who.email, renderIndicatorMail(sig, lang));
            counts[outcome] = (counts[outcome] ?? 0) + 1;
          }
        }
      };
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
      // #171: a bar that closed at this minute is read from a second after it
      // (indicators.ts startWaitMs), and this run's clock is taken then — it
      // shadows the request's, which this run may have waited past
      const wait = startWaitMs(Date.now());
      if (wait > 0) await sleep(wait);
      const nowMs = Date.now();
      const summary: JsonRecord = { ok: true, mode: "indicators", version: FUNCTION_VERSION, email_configured: emailConfigured };
      if (isPossiblyClosed(nowMs)) return { ...summary, skipped: "market_closed" };
      const minute = new Date(nowMs).getUTCMinutes();
      // GMO's files kept past two months are not needed again (the hourly
      // chart reaches back some 40 days)
      if (new Date(nowMs).getUTCHours() === 3 && minute === 7) {
        const res = await rest(`gmo_kline_files?fetched_at=lt.${encodeURIComponent(new Date(nowMs - 60 * 24 * 60 * MIN).toISOString())}`, { method: "DELETE" });
        if (!res.ok) console.error("kline purge failed:", res.status, await res.text().catch(() => ""));
      }
      // (#291: not the video's way, 'sweepx': gold's 1-minute chart is judged by
      // the "gold-ticks" run on the minutes it records, and read here it would
      // be a Twelve Data chart read every minute)
      const subs: IndicatorSub[] = (await readRows("signal_alert_subscriptions?rule=in.(qtrend,ultra,macdx)&select=user_id,pair,interval,lang,rule"))
        .filter((r) => typeof r.user_id === "string" && isIndicatorRule(r.rule) && r.rule !== "sweepx" && isIndicatorChartFor(r.rule, r.pair, r.interval) && typeof r.lang === "string")
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
      // Twelve Data's by where their own bars close (#212: twelveChartDue; a
      // chart whose bars this instance has not seen, by its own UTC grid under
      // an hour, else in the first half hour of every hour)
      const twelveCharts = followed.filter((c) =>
        isTwelvePair(c.pair) && twelveChartDue(c.interval, nowMs, twelvePhaseOf.get(`${c.pair}|${c.interval}`))
      ).sort((a, b) => order(a.interval) - order(b.interval));
      const deadline = Date.now() + FETCH_BUDGET_MS;
      const reads: JsonRecord[] = [];
      const fired: IndicatorSignal[] = [];
      const files = { memory: 0, table: 0, ended: 0, live: 0, stale: 0 };

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
      // still being written from GMO — #171: for a chart whose bars close at
      // `closeMs`, read again while GMO made its answer before that close and
      // the answer holds the bar (indicators.ts staleForClose), STALE_TRIES
      // times at most; past them the read fails, and a later run reads it
      const chartFetcher = (closeMs: number, stepMs: number): Fetcher => async (url) => {
        const f = klineFileOf(url);
        if (!f || !klineFileEnded(f.date, nowMs)) {
          files.live++;
          for (let tries = 1; ; tries++) {
            const got = await paced(url);
            if (got === null || maintenance || !staleForClose(got, closeMs, stepMs)) return got;
            files.stale++;
            if (tries >= STALE_TRIES || Date.now() + STALE_RETRY_MS > deadline) return null;
            await sleep(STALE_RETRY_MS);
          }
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
      // Each fresh signal to each follower of its chart, once (the claim's
      // unique key)
      const counts: Record<string, number> = { sent: 0, failed: 0, not_configured: 0, duplicate: 0, not_allowed: 0 };
      const mailSignals = mailerFor(subs, counts);
      // #171: a chart's signals are mailed as soon as it is judged, before
      // the other charts due are read
      const judge = async (pair: string, interval: string, closed: Candle[], newest: number) => {
        // #275: the MACD peak-and-valley rule beside Q-Trend's and ULTRA's. Its
        // failure must never cost the other two their emails
        const sigs = indicatorSignals(pair, interval, closed, nowMs);
        try {
          sigs.push(...macdxSignals(pair, interval, closed, nowMs));
        } catch (err) {
          console.error("macdx failed:", pair, interval, err);
        }
        judgedBar.set(`${pair}|${interval}`, newest);
        fired.push(...sigs);
        const read = {
          pair,
          interval,
          bars: closed.length,
          newest: new Date(newest).toISOString(),
          signals: sigs.map((x) => `${x.rule}:${x.side}${x.strong ? "!" : ""}`),
          // #171: how long after the bar closed it was judged, ms
          judged_after_ms: Date.now() - (newest + (LIVE_STEP_MS[interval] ?? 0)),
        };
        if (sigs.length > 0) await mailSignals(sigs);
        return read;
      };

      // Twelve Data's first: a few reads at most, which GMO's many would
      // otherwise leave no time for
      let twelveLeft = TWELVE_READS_PER_RUN;
      const twelveKey = Deno.env.get("TWELVE_DATA_API_KEY") ?? "";
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
        reads.push({ ...(await judge(c.pair, c.interval, closed, expected)), twelve: true });
      }
      // #171: the 4-hour and daily charts' newest closed bar this hour (its
      // open), once the first of them read tells (hourCloseOf); null when
      // none closed this hour
      const yearNewest = new Map<string, number | null>();
      for (const c of gmoCharts) {
        const key = `${c.pair}|${c.interval}`;
        const step = LIVE_STEP_MS[c.interval];
        const spec = GMO_INTERVALS[c.interval];
        // on the day-keyed charts (5 min to 1 hour, on the UTC grid) the
        // newest closed bar is known before reading; on the others once a
        // pair of the timeframe was read this run
        let expected = spec.key === "day" ? Math.floor(nowMs / step) * step - step : null;
        if (spec.key === "year" && yearNewest.has(c.interval)) {
          const e = yearNewest.get(c.interval) as number | null;
          if (e === null) {
            reads.push({ pair: c.pair, interval: c.interval, skipped: "no_close" });
            continue;
          }
          expected = e;
        }
        if (expected !== null && judgedBar.get(key) === expected) {
          reads.push({ pair: c.pair, interval: c.interval, skipped: "judged" });
          continue;
        }
        if (Date.now() > deadline || maintenance) {
          reads.push({ pair: c.pair, interval: c.interval, skipped: maintenance ? "maintenance" : "deadline" });
          continue;
        }
        await preload(c.pair, c.interval);
        // the chart's history read (the chart's own function), rounded as
        // drawn; #171: not from an answer GMO made before the close it is for
        const fetcher = chartFetcher(latestCloseMs(c.interval, nowMs), step);
        const quotes = await fetchLiveQuotes(c.pair, c.interval, nowMs, deadline, fetcher, HISTORY_BARS + 1);
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
        if (spec.key === "year" && expected === null) {
          const said = hourCloseOf(newest, c.interval, nowMs);
          if (said === "unknown") {
            reads.push({ pair: c.pair, interval: c.interval, skipped: "unknown", newest: Number.isFinite(newest) ? new Date(newest).toISOString() : null });
            continue;
          }
          yearNewest.set(c.interval, said === "closed" ? newest : null);
          if (said === "none") {
            reads.push({ pair: c.pair, interval: c.interval, skipped: "no_close", newest: new Date(newest).toISOString() });
            continue;
          }
          expected = newest;
        }
        if (expected !== null && newest !== expected) {
          reads.push({ pair: c.pair, interval: c.interval, skipped: "not_yet", newest: Number.isFinite(newest) ? new Date(newest).toISOString() : null });
          continue;
        }
        if (judgedBar.get(key) === newest) {
          reads.push({ pair: c.pair, interval: c.interval, skipped: "judged" });
          continue;
        }
        reads.push(await judge(c.pair, c.interval, closed, newest));
      }

      summary.reads = reads;
      summary.files = files;
      summary.twelve_reads = TWELVE_READS_PER_RUN - twelveLeft;
      summary.signals = fired.length;
      if (fired.length === 0) return summary;
      return { ...summary, ...counts };
    };

    // ---- #291: gold's 1-minute bars, recorded all day (gold-minutes.ts) -------------------
    //
    // Every minute (pg_cron), in the background: Swissquote's gold price every
    // GOLD_TICK_EVERY_MS until GOLD_TICK_OVERLAP_MS past the minute, each one
    // open now and stamped in a minute gold trades recorded into
    // public.gold_tick_bars. While gold is shut (the FX weekend at its
    // widest, gold's daily hour) nothing is read; a quote left standing
    // (older than GOLD_QUOTE_STALE_MS: a break the hours above do not know,
    // a holiday, the first reads after a reopening) is not recorded.
    const goldQuote = async (): Promise<Tick | null> => {
      try {
        const r = await fetch(GOLD_QUOTE_URL, { signal: AbortSignal.timeout(GOLD_TICK_EVERY_MS - 500) });
        if (!r.ok) {
          await r.body?.cancel();
          return null;
        }
        return parseSwissquote(await r.json().catch(() => null), Date.now());
      } catch {
        return null;
      }
    };
    // #291: the minutes just closed, judged for the gold 1-minute email
    // (indicators.ts sweepxSignals) on the minutes recorded by now, rounded as
    // the chart's history is (historyOfBars): the bars the chart draws its
    // marks on. Only when somebody follows the chart
    const goldJudge = async (): Promise<JsonRecord> => {
      try {
        const subs: IndicatorSub[] = (await readRows("signal_alert_subscriptions?rule=eq.sweepx&select=user_id,pair,interval,lang,rule"))
          .filter((r) => typeof r.user_id === "string" && r.rule === "sweepx" && isSweepxChart(r.pair, r.interval) && typeof r.lang === "string")
          .map((r) => ({ user_id: r.user_id as string, pair: r.pair as string, interval: r.interval as string, lang: r.lang as string, rule: "sweepx" as const }));
        if (subs.length === 0) return { subscriptions: 0 };
        // the window, and the few newest bars that may still be fresh beyond it
        const res = await rest("rpc/gold_tick_minutes", { method: "POST", body: JSON.stringify({ p_count: SWEEPX.window + 4 }) });
        if (!res.ok) {
          console.error("gold minutes read failed:", res.status, await res.text().catch(() => ""));
          return { subscriptions: subs.length, error: "read_failed" };
        }
        const minutes = parseTickMinutes(await res.json().catch(() => null));
        const now = Date.now();
        const closed = historyOfBars(GOLD, "1min", tickMinuteCandles(minutes), now, new Date(now).toISOString()).candles;
        const sigs = sweepxSignals(GOLD, "1min", closed, now);
        const counts: Record<string, number> = {};
        if (sigs.length > 0) await mailerFor(subs, counts)(sigs);
        return {
          subscriptions: subs.length,
          bars: closed.length,
          newest: closed.length > 0 ? closed[closed.length - 1].datetime : null,
          signals: sigs.map((s) => `${s.side}@${s.barTime}`),
          // how long after the bar closed it was judged, ms
          judged_after_ms: closed.length > 0 ? now - (barOpenMs(closed[closed.length - 1].datetime) + MIN) : null,
          ...counts,
        };
      } catch (err) {
        console.error("gold judge failed:", err);
        return { error: "failed" };
      }
    };
    const goldTicks = async (): Promise<JsonRecord> => {
      const started = Date.now();
      const plan = goldTickPlan(started);
      const summary: JsonRecord = {
        ok: true,
        mode: "gold-ticks",
        version: FUNCTION_VERSION,
        minute: new Date(plan.minuteStart).toISOString(),
        started: new Date(started).toISOString(),
      };
      // a second call for the minute this instance is already reading
      if (goldTicksMinute === plan.minuteStart) return { ...summary, skipped: "busy" };
      if (isPossiblyClosedFor(GOLD, plan.minuteStart)) {
        // the last minute before gold shut (its daily hour, the week's end)
        // is judged still, GOLD_JUDGE_AFTER_MS after it closed (the run
        // before this one may still be recording its last prices) and a
        // minute later, as every minute is (judgesWhileShut); the others
        // while it is shut have no bar
        if (!judgesWhileShut(plan.minuteStart)) return { ...summary, skipped: "market_closed" };
        await sleep(plan.judgeAt - Date.now());
        return { ...summary, skipped: "market_closed", judged: await goldJudge() };
      }
      goldTicksMinute = plan.minuteStart;
      const tally = { reads: 0, recorded: 0, stale: 0, shut: 0, failed: 0, record_failed: 0 };
      // the judge runs beside the reads (its mails may take seconds), not
      // between them
      let judging: Promise<JsonRecord> | null = null;
      try {
        let lastAt = Number.NEGATIVE_INFINITY;
        for (;;) {
          const at = nextTickAt(lastAt, Date.now());
          // the minute that closed, once its last prices are in
          if (judging === null && plan.judgeAt <= at) {
            await sleep(plan.judgeAt - Date.now());
            judging = goldJudge();
          }
          if (at >= plan.stopAt) break;
          await sleep(at - Date.now());
          lastAt = at;
          tally.reads++;
          const tick = await goldQuote();
          if (!tick) {
            tally.failed++;
            continue;
          }
          if (!tick.open || !tick.time) {
            tally.stale++;
            continue;
          }
          // (a price stamped while gold is shut makes no bar)
          if (isPossiblyClosedFor(GOLD, Date.parse(tick.time))) {
            tally.shut++;
            continue;
          }
          try {
            const rec = await rest("rpc/record_gold_tick", { method: "POST", body: JSON.stringify({ p_at: tick.time, p_mid: tick.mid }) });
            const said = await rec.text().catch(() => "");
            if (rec.ok) tally.recorded++;
            else {
              tally.record_failed++;
              console.error("gold tick record failed:", rec.status, said);
            }
          } catch (err) {
            tally.record_failed++;
            console.error("gold tick record failed:", err);
          }
        }
        if (judging === null) {
          await sleep(plan.judgeAt - Date.now());
          judging = goldJudge();
        }
      } finally {
        if (goldTicksMinute === plan.minuteStart) goldTicksMinute = null;
      }
      return { ...summary, ...tally, ended: new Date().toISOString(), judged: await judging };
    };
    // Once, by hand: the minutes before the recording began, from Twelve
    // Data's newest 1-minute bars (gold-minutes.ts goldSeedRows), within the
    // day's reads. A minute already in the table is left as it is.
    const goldSeed = async (): Promise<JsonRecord> => {
      const summary: JsonRecord = { ok: true, mode: "gold-seed", version: FUNCTION_VERSION };
      const twelveKey = Deno.env.get("TWELVE_DATA_API_KEY") ?? "";
      if (!twelveKey) return { ...summary, ok: false, error: "no_key" };
      const first = await readRows("gold_tick_bars?source=eq.swissquote&select=minute&order=minute.asc&limit=1");
      const firstRecorded = first.length > 0 && typeof first[0].minute === "string" ? Date.parse(first[0].minute) : null;
      if (!(await takeTwelveRead(ALERT_TWELVE_CAP))) return { ...summary, ok: false, error: "day_spent" };
      let bars: Candle[] | null = null;
      try {
        const r = await fetch(twelveDataUrl(GOLD, "1min", twelveKey, TWELVE_1MIN_BARS), { signal: AbortSignal.timeout(20_000) });
        bars = r.ok ? parseTwelveData(await r.json().catch(() => null), "1min") : null;
        if (!r.ok) await r.body?.cancel();
      } catch (err) {
        console.error("twelve data read failed:", err);
      }
      if (!bars) return { ...summary, ok: false, error: "twelve_unavailable" };
      const rows = goldSeedRows(bars, Date.now(), firstRecorded);
      const out: JsonRecord = {
        ...summary,
        read: bars.length,
        first_recorded: firstRecorded === null ? null : new Date(firstRecorded).toISOString(),
        rows: rows.length,
      };
      if (rows.length === 0) return { ...out, inserted: 0 };
      const res = await rest("gold_tick_bars?on_conflict=minute&select=minute", {
        method: "POST",
        headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
        body: JSON.stringify(rows),
      });
      const got = res.ok ? await res.json().catch(() => null) : null;
      if (!res.ok) {
        console.error("gold seed store failed:", res.status, await res.text().catch(() => ""));
        return { ...out, ok: false, error: "store_failed", status: res.status };
      }
      return { ...out, inserted: Array.isArray(got) ? got.length : null, from: rows[0].minute, to: rows[rows.length - 1].minute };
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
      // #291: every minute, gold's price from Swissquote all minute long — in
      // the background (EdgeRuntime.waitUntil), the request answered at once:
      // the job's call (the http extension) waits for the answer and gives it
      // up after 10 seconds, and this run takes the minute and more. Its
      // summary goes to the function's log
      if (body.mode === "gold-ticks") {
        const runtime = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
        if (typeof runtime?.waitUntil !== "function") {
          return json({ ok: false, mode: "gold-ticks", version: FUNCTION_VERSION, error: "no_background" }, 500);
        }
        runtime.waitUntil(
          goldTicks().then(
            (s) => console.log(JSON.stringify(s)),
            (err) => console.error("gold ticks failed:", err),
          ),
        );
        return json({ ok: true, mode: "gold-ticks", version: FUNCTION_VERSION, background: true, at: new Date().toISOString() });
      }
      // #291: once, by hand: the minutes before that recording began
      if (body.mode === "gold-seed") return json(await goldSeed());
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
      // (#175: of the pairs still read; another pair's is left as it is)
      const openEvents = (await readRows("signal_events?outcome=is.null&select=id,pair,interval,bar_time,side,entry,stop,target,fill"))
        .filter((r) => typeof r.id === "string" && typeof r.bar_time === "string" && (r.side === "BUY" || r.side === "SELL") && isAlertPair(r.pair))
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
      // actually sent. #175: both on the pairs still read (ALERT_PAIRS) only.
      const since = encodeURIComponent(new Date(nowMs - RECORD_DAYS * 24 * 60 * MIN).toISOString());
      const [events, mine] = await Promise.all([
        readRows(`signal_events?closed_at=gte.${since}&select=pair,interval,costly,outcome,r,rule&limit=20000`),
        readRows(`signal_alerts?user_id=eq.${uid}&kind=eq.signal&status=eq.sent&created_at=gte.${since}&select=pair,rule,event:signal_events(outcome,r)&limit=20000`),
      ]).then((rs) => rs.map((xs) => xs.filter((x) => isAlertPair(x.pair))));
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
        // those read from Twelve Data on 1 hour and up (#212: gold on 15
        // minutes too)
        indicator: {
          rules: INDICATOR_RULES,
          pairs: INDICATOR_PAIRS,
          intervals: INDICATOR_INTERVALS,
          limited: Object.fromEntries(INDICATOR_PAIRS.filter((p) => isTwelvePair(p)).map((p) => [p, indicatorIntervalsFor(p)])),
          limited_intervals: TWELVE_ALERT_INTERVALS,
          // #275: the MACD peak-and-valley rule's charts: GMO's currency pairs on 5 minutes
          macdx: { pairs: MACDX_PAIRS, intervals: MACDX_INTERVALS },
          // #291: the video's way's: gold's 1-minute chart
          sweepx: { pairs: SWEEPX_PAIRS, intervals: SWEEPX_INTERVALS },
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
      const chartOk = indicator ? isIndicatorChartFor(body.rule, body.pair, body.interval) : isAlertPair(body.pair) && isAlertInterval(body.interval);
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
      if (!charts.every((c) => isIndicatorChartFor(rule, c.pair, c.interval))) return json({ ok: false, error: "invalid_request" }, 400);
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
