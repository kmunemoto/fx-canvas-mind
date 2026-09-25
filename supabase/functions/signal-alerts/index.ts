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

import {
  ALERT_INTERVALS,
  ALERT_PAIRS,
  DEFAULT_FROM,
  RULE_ID,
  alertsAllowed,
  checkPair,
  isAlertInterval,
  isAlertPair,
  isLang,
  mayHaveFreshClose,
  renderSignalMail,
  renderTestMail,
  sendMail,
  type FiredSignal,
  type Lang,
} from "./logic.ts";
import type { Fetcher, QuoteCandle } from "../track-outcomes/quotes.ts";
import { BACKTEST, fillAt, settleEvent, summarize, type EventRow, type OpenEvent } from "./record.ts";
import { isPossiblyClosed } from "../_shared/market-hours.ts";

const FUNCTION_VERSION = "signal-alerts-v3-2026-09-25T16:00:00Z";

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
}

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
      const res = await rest("signal_alerts?on_conflict=user_id,kind,pair,interval,bar_time,side", {
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
      const res = await rest("signal_events?on_conflict=pair,interval,bar_time,side", {
        method: "POST",
        headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
        body: JSON.stringify(row),
      });
      const rows = res.ok ? await res.json().catch(() => null) : null;
      if (!res.ok) console.error("event insert failed:", res.status, await res.text().catch(() => ""));
      if (Array.isArray(rows) && rows.length > 0 && isRecord(rows[0]) && typeof rows[0].id === "string") return rows[0].id;
      const found = await readRows(
        `signal_events?pair=eq.${encodeURIComponent(String(row.pair))}&interval=eq.${encodeURIComponent(String(row.interval))}` +
          `&bar_time=eq.${encodeURIComponent(String(row.bar_time))}&side=eq.${encodeURIComponent(String(row.side))}&select=id`,
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
      const sent = await sendMail(resendKey, from, to, mail);
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

    // ---- the sweep ---------------------------------------------------------------
    const sweepToken = req.headers.get("x-sweep-token");
    if (sweepToken) {
      const tokenRes = await rest("rpc/track_outcomes_sweep_token", { method: "POST", body: "{}" });
      const expected = tokenRes.ok ? await tokenRes.json().catch(() => null) : null;
      if (typeof expected !== "string" || expected.length === 0 || !constantTimeEqual(sweepToken, expected)) {
        return json({ ok: false, error: "認証に失敗しました" }, 401);
      }
      const summary: JsonRecord = { ok: true, mode: "sweep", version: FUNCTION_VERSION, email_configured: emailConfigured };
      // "Enter now" is not an available action while the market may be shut,
      // which is when analyze refuses too
      if (isPossiblyClosed(nowMs)) return json({ ...summary, skipped: "market_closed" });

      const subs = (await readRows("signal_alert_subscriptions?select=user_id,pair,interval,lang"))
        .filter((r): r is JsonRecord & Subscription =>
          typeof r.user_id === "string" && isAlertPair(r.pair) && isAlertInterval(r.interval) && typeof r.lang === "string"
        );
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
            rule: RULE_ID,
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
        for (const sub of subs.filter((s) => s.pair === sig.pair && s.interval === sig.interval)) {
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
            rule: RULE_ID,
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
        readRows(`signal_alert_subscriptions?user_id=eq.${uid}&select=pair,interval,lang&order=created_at.asc`),
        readRows(
          `signal_alerts?user_id=eq.${uid}&select=id,kind,pair,interval,bar_time,closed_at,side,entry,stop,target,rsi,rsi_prev,sar,status,skip_reason,error,created_at,sent_at,event:signal_events(outcome,r,bars,exit_at)&order=created_at.desc&limit=${RECENT_ALERTS}`,
        ),
      ]);
      // #108: the live record. "all" is every signal the rule fired outside
      // the hours it is not mailed in; "mine" is the alerts this user was
      // actually sent.
      const since = encodeURIComponent(new Date(nowMs - RECORD_DAYS * 24 * 60 * MIN).toISOString());
      const [events, mine] = await Promise.all([
        readRows(`signal_events?closed_at=gte.${since}&select=interval,costly,outcome,r&limit=20000`),
        readRows(`signal_alerts?user_id=eq.${uid}&kind=eq.signal&status=eq.sent&created_at=gte.${since}&select=event:signal_events(outcome,r)&limit=20000`),
      ]);
      const row = (x: JsonRecord): EventRow => ({
        outcome: typeof x.outcome === "string" ? x.outcome : null,
        r: typeof x.r === "number" ? x.r : null,
      });
      const mailed = events.filter((e) => e.costly !== true);
      const performance = {
        days: RECORD_DAYS,
        mine: summarize(mine.map((m) => (isRecord(m.event) ? row(m.event) : { outcome: null, r: null }))),
        all: summarize(mailed.map(row)),
        costly: summarize(events.filter((e) => e.costly === true).map(row)),
        byTf: Object.fromEntries(ALERT_INTERVALS.map((iv) => [iv, summarize(mailed.filter((e) => e.interval === iv).map(row))])),
        backtest: BACKTEST,
      };
      return {
        ok: true,
        version: FUNCTION_VERSION,
        allowed,
        email_configured: emailConfigured,
        email,
        pairs: ALERT_PAIRS,
        intervals: ALERT_INTERVALS,
        subscriptions: subs.map((s) => ({ pair: s.pair, interval: s.interval })),
        performance,
        alerts,
      };
    };

    const action = typeof body.action === "string" ? body.action : "status";
    if (action === "status") return json(await status());

    if (action === "set") {
      if (!isAlertPair(body.pair) || !isAlertInterval(body.interval) || typeof body.on !== "boolean") {
        return json({ ok: false, error: "invalid_request" }, 400);
      }
      if (body.on) {
        if (!allowed) return json({ ok: false, error: "plan_required" }, 403);
        const res = await rest("signal_alert_subscriptions?on_conflict=user_id,pair,interval", {
          method: "POST",
          headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
          body: JSON.stringify({ user_id: userId, pair: body.pair, interval: body.interval, lang: isLang(body.lang) ? body.lang : "ja" }),
        });
        if (!res.ok) {
          console.error("subscribe failed:", res.status, await res.text().catch(() => ""));
          return json({ ok: false, error: "save_failed" }, 500);
        }
      } else {
        // Always possible, plan or not: nobody should need a subscription to
        // stop receiving mail
        const res = await rest(
          `signal_alert_subscriptions?user_id=eq.${uid}&pair=eq.${encodeURIComponent(body.pair)}&interval=eq.${encodeURIComponent(body.interval)}`,
          { method: "DELETE" },
        );
        if (!res.ok) {
          console.error("unsubscribe failed:", res.status, await res.text().catch(() => ""));
          return json({ ok: false, error: "save_failed" }, 500);
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
      const subs = await readRows(`signal_alert_subscriptions?user_id=eq.${uid}&select=pair,interval&order=created_at.asc`);
      const lang: Lang = isLang(body.lang) ? body.lang : "ja";
      const outcome = await deliver(
        id,
        email,
        renderTestMail(subs.map((s) => ({ pair: String(s.pair), interval: String(s.interval) })), lang),
      );
      return json({ ...(await status()), test: outcome });
    }

    return json({ ok: false, error: "invalid_request" }, 400);
  } catch (err) {
    console.error("signal-alerts failed:", err);
    return json({ ok: false, error: "internal_error" }, 500);
  }
});
