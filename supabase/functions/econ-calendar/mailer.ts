// #370: one morning's run of the big-events mail (docs §8.123), apart from Deno so that
// src/test/econ-mailer.test.ts can drive it against a fake database.
//
// Nothing is decided on a read that failed: when the subscriptions, the day's log or the calendar cannot be
// read, or the calendar holds nothing, or someone's address or plan cannot be looked up, nothing is claimed and
// the next hourly run of the morning tries again. A row is the claim (one per person and Japanese morning); a
// row whose send failed is claimed again by a later run of the same morning. The answer is counts only — no
// address and no user id — and so is every log line (an HTTP status and PostgREST's error code at most).

import type { EconEvent, Impact } from "./events.ts";
import { buildDigest, renderDigestMail } from "./digest.ts";
import { alertsAllowed, isLang, type Lang, type Mail, type SendResult } from "../signal-alerts/logic.ts";
import { isMacdhChart } from "../signal-alerts/indicators.ts";

// Resend allows two requests a second
export const SEND_GAP_MS = 600;
// a "429 rate limit" (not a quota) is sent once more after this
export const RETRY_429_MS = 1_500;

export interface MailerDeps {
  // PostgREST with the service role; the path is relative to /rest/v1/
  rest: (path: string, init?: RequestInit) => Promise<Response>;
  // someone's address (GoTrue's admin API): ok false when it could not be looked up, email null when there is none
  emailOf: (userId: string) => Promise<{ ok: boolean; email: string | null }>;
  send: (to: string, mail: Mail) => Promise<SendResult>;
  // RESEND_API_KEY is set
  configured: boolean;
  sleep: (ms: number) => Promise<void>;
  clock: () => number;
}

type JsonRecord = Record<string, unknown>;

// the provider's refusal, or null when it took the mail (read without leaning on the union's narrowing, which
// the app's type check, without strictNullChecks, does not do)
const refusalOf = (r: SendResult): string | null => (r.ok ? null : (r as { ok: false; error: string }).error);
const isRecord = (v: unknown): v is JsonRecord => typeof v === "object" && v !== null && !Array.isArray(v);

const IMPACTS: readonly string[] = ["High", "Medium", "Low", "Holiday"];

// A stored row back into the shape the digest reads
export const eventOfRow = (r: JsonRecord): EconEvent | null => {
  if (typeof r.id !== "string" || typeof r.event_at !== "string" || typeof r.country !== "string" || typeof r.title !== "string") {
    return null;
  }
  if (!Number.isFinite(Date.parse(r.event_at))) return null;
  return {
    id: r.id,
    event_at: r.event_at,
    country: r.country,
    title: r.title,
    impact: typeof r.impact === "string" && IMPACTS.includes(r.impact) ? (r.impact as Impact) : "Low",
    forecast: typeof r.forecast === "string" ? r.forecast : null,
    previous: typeof r.previous === "string" ? r.previous : null,
    all_day: r.all_day === true,
    source: typeof r.source === "string" ? r.source : "forexfactory",
  };
};

// What a failed request may leave in the log: its status and PostgREST's error code, nothing of the row
const failure = async (what: string, res: Response) => {
  const body = await res.json().catch(() => null);
  const code = isRecord(body) && typeof body.code === "string" ? ` ${body.code}` : "";
  console.error(`digest: ${what} failed: ${res.status}${code}`);
};

const readRows = async (deps: MailerDeps, what: string, path: string): Promise<JsonRecord[] | null> => {
  const res = await deps.rest(path);
  if (!res.ok) {
    await failure(what, res);
    return null;
  }
  const rows = await res.json().catch(() => null);
  return Array.isArray(rows) ? rows.filter(isRecord) : null;
};

export const mailDigests = async (deps: MailerDeps, day: string, nowMs: number): Promise<JsonRecord> => {
  const stop = (error: string) => ({ due: true, day, error });

  // who gets it: everyone with a MACD email subscription (the mails signal-alerts sends: macdx on the
  // charts it follows, isMacdhChart; #384: the 15-minute chart from signal-alerts v31, the 1-hour one
  // before); their currencies come from every pair they follow
  const subs = await readRows(deps, "subscriptions read", "signal_alert_subscriptions?select=user_id,pair,interval,rule,lang&order=pair.asc");
  if (subs === null) return stop("subscriptions_unread");
  const people = new Map<string, { pairs: string[]; lang: Lang | null; macdx: boolean }>();
  for (const r of subs) {
    if (typeof r.user_id !== "string" || typeof r.pair !== "string") continue;
    const p = people.get(r.user_id) ?? { pairs: [], lang: null, macdx: false };
    if (!p.pairs.includes(r.pair)) p.pairs.push(r.pair);
    if (r.rule === "macdx" && isMacdhChart(r.pair, r.interval)) {
      p.macdx = true;
      if (p.lang === null && isLang(r.lang)) p.lang = r.lang;
    }
    people.set(r.user_id, p);
  }
  const recipients = [...people.entries()].filter(([, p]) => p.macdx);
  if (recipients.length === 0) return { due: true, day, recipients: 0 };

  // the morning's rows: a failed send is tried again, anything else is done
  const log = await readRows(deps, "log read", `econ_digest_mails?digest_day=eq.${encodeURIComponent(day)}&select=user_id,status`);
  if (log === null) return stop("log_unread");
  const statusOf = new Map(log.filter((r) => typeof r.user_id === "string").map((r) => [r.user_id as string, String(r.status)]));
  const pending = recipients.filter(([userId]) => !statusOf.has(userId) || statusOf.get(userId) === "failed");
  const counts: Record<string, number> = {
    sent: 0, failed: 0, not_configured: 0, skipped: 0, lookup_failed: 0, claim_failed: 0, claimed_elsewhere: 0, retried: 0,
  };
  const result: JsonRecord = { due: true, day, recipients: recipients.length, already: recipients.length - pending.length };
  if (pending.length === 0) return result;

  // the calendar: the rows of the newest fetch only (a rescheduled event leaves its old row behind)
  const newest = await readRows(deps, "events read", "econ_events?select=fetched_at&order=fetched_at.desc&limit=1");
  if (newest === null) return stop("events_unread");
  const fetchedIso = newest.length > 0 && typeof newest[0].fetched_at === "string" ? newest[0].fetched_at : null;
  if (fetchedIso === null) return stop("events_empty");
  const stored = await readRows(
    deps,
    "events read",
    `econ_events?fetched_at=eq.${encodeURIComponent(fetchedIso)}` +
      "&select=id,event_at,country,title,impact,forecast,previous,all_day,source&order=event_at.asc&limit=2000",
  );
  if (stored === null) return stop("events_unread");
  const feed = stored.map(eventOfRow).filter((e): e is EconEvent => e !== null);
  if (feed.length === 0) return stop("events_empty");
  const fetchedAt = Date.parse(fetchedIso);

  let sendNextAt = 0;
  let soonEvents: number | null = null;
  for (const [userId, person] of pending) {
    const user = await deps.emailOf(userId);
    const plans = user.ok ? await readRows(deps, "profile read", `profiles?id=eq.${encodeURIComponent(userId)}&select=plan`) : null;
    if (!user.ok || plans === null) {
      counts.lookup_failed++;
      continue;
    }
    const plan = plans.length > 0 && typeof plans[0].plan === "string" ? plans[0].plan : null;
    const allowed = alertsAllowed(plan, user.email);
    const lang: Lang = person.lang ?? "ja";
    const d = buildDigest({ events: feed, pairs: person.pairs, nowMs, day, fetchedAt });
    soonEvents = soonEvents ?? d.soon.length;
    const row = {
      window_from: new Date(d.from).toISOString(),
      window_to: new Date(d.to).toISOString(),
      soon_events: d.soon.length,
      later_events: d.later.length,
      event_ids: [...d.soon, ...d.later].map((i) => i.event.id),
      lang,
      status: allowed ? "pending" : "skipped",
      error: allowed ? null : "plan",
      provider_id: null,
      sent_at: null,
    };
    // the claim: a new row, or (a failed send) the failed row taken back while it is still failed
    const again = statusOf.get(userId) === "failed";
    const claim = again
      ? await deps.rest(
        `econ_digest_mails?user_id=eq.${encodeURIComponent(userId)}&digest_day=eq.${encodeURIComponent(day)}&status=eq.failed`,
        { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(row) },
      )
      : await deps.rest("econ_digest_mails?on_conflict=user_id,digest_day", {
        method: "POST",
        headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
        body: JSON.stringify({ user_id: userId, digest_day: day, ...row }),
      });
    if (!claim.ok) {
      await failure("claim", claim);
      counts.claim_failed++;
      continue;
    }
    const claimed = await claim.json().catch(() => null);
    const id = Array.isArray(claimed) && claimed.length > 0 && isRecord(claimed[0]) && typeof claimed[0].id === "string" ? claimed[0].id : null;
    if (id === null) {
      counts.claimed_elsewhere++;
      continue;
    }
    if (again) counts.retried++;
    const patch = async (body: JsonRecord) => {
      const res = await deps.rest(`econ_digest_mails?id=eq.${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) });
      if (!res.ok) await failure("record", res);
      else await res.text().catch(() => "");
    };
    if (!allowed) {
      counts.skipped++;
      continue;
    }
    if (!deps.configured) {
      await patch({ status: "not_configured" });
      counts.not_configured++;
      continue;
    }
    if (user.email === null) {
      await patch({ status: "failed", error: "no_email" });
      counts.failed++;
      continue;
    }
    const to = user.email;
    const mail = renderDigestMail(d, lang, nowMs);
    const sendOnce = async () => {
      const at = Math.max(deps.clock(), sendNextAt);
      sendNextAt = at + SEND_GAP_MS;
      await deps.sleep(at - deps.clock());
      return await deps.send(to, mail);
    };
    let sent = await sendOnce();
    const first = refusalOf(sent);
    if (first !== null && first.startsWith("429") && !/quota/i.test(first)) {
      await deps.sleep(RETRY_429_MS);
      sent = await sendOnce();
    }
    const refused = refusalOf(sent);
    if (refused === null) {
      await patch({ status: "sent", provider_id: (sent as { ok: true; id: string }).id, sent_at: new Date(deps.clock()).toISOString(), error: null });
      counts.sent++;
    } else {
      // sendMail has already taken any address out of the provider's answer
      console.error("digest: send failed:", refused);
      await patch({ status: "failed", error: refused });
      counts.failed++;
    }
  }
  return { ...result, ...counts, feedEvents: feed.length, soonEvents };
};
