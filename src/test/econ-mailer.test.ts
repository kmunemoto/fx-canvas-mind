import { describe, it, expect, vi } from "vitest";
import { mailDigests, eventOfRow, type MailerDeps } from "../../supabase/functions/econ-calendar/mailer.ts";
import type { SendResult } from "../../supabase/functions/signal-alerts/logic.ts";

// #370: one morning's run of the big-events mail (docs §8.123) against a fake database

const NOW = Date.parse("2026-10-21T21:13:00Z"); // Thu 22 Oct 06:13 JST
const DAY = "2026-10-22";
const OWNER = "user-owner";
const OTHER = "user-other";
const FETCHED = "2026-10-21T21:13:00.399+00:00";
const OLDER = "2026-10-21T20:13:00.120+00:00";

type Row = Record<string, unknown>;
interface Db {
  subs: Row[];
  mails: Row[];
  events: Row[];
  plans: Record<string, string | null>;
  emails: Record<string, string | null>;
  // which reads or writes answer 500
  fail: Set<string>;
  lookupFail: boolean;
  sendResults: SendResult[];
  nextId: number;
}

const ev = (country: string, at: string, title: string, impact: string, fetched_at = FETCHED): Row => ({
  id: `${country}|${at}|${title}`.toLowerCase(),
  event_at: at,
  country,
  title,
  impact,
  forecast: null,
  previous: null,
  all_day: false,
  source: "forexfactory",
  fetched_at,
});

const freshDb = (): Db => ({
  subs: ["AUD/JPY", "AUD/USD", "EUR/JPY", "EUR/USD", "USD/JPY", "XAU/USD"].map((pair) => ({ user_id: OWNER, pair, interval: "15min", rule: "macdx", lang: "ja" })),
  mails: [],
  events: [
    ev("AUD", "2026-10-21T23:00:00+00:00", "RBA Gov Bullock Speaks", "Low"),
    ev("USD", "2026-10-22T12:30:00+00:00", "CPI y/y", "High"),
    ev("JPY", "2026-10-22T23:30:00+00:00", "National Core CPI y/y", "Low"),
    // the same event at its old time, from an older fetch: not to be used
    ev("USD", "2026-10-22T10:00:00+00:00", "CPI y/y", "High", OLDER),
  ],
  plans: { [OWNER]: "light", [OTHER]: null },
  emails: { [OWNER]: "owner@example.test", [OTHER]: "other@example.test" },
  fail: new Set(),
  lookupFail: false,
  sendResults: [],
  nextId: 1,
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const boom = () => json({ code: "XX000", message: `failing row contains (${OWNER}, owner@example.test)` }, 500);

const fakeRest = (db: Db) => async (path: string, init: RequestInit = {}): Promise<Response> => {
  const method = init.method ?? "GET";
  const url = new URL(`http://db/${path}`);
  const table = url.pathname.slice(1);
  const q = url.searchParams;
  const eq = (k: string) => (q.get(k)?.startsWith("eq.") ? (q.get(k) as string).slice(3) : null);
  if (table === "signal_alert_subscriptions") return db.fail.has("subs") ? boom() : json(db.subs);
  if (table === "profiles") {
    if (db.fail.has("profile")) return boom();
    const id = eq("id") as string;
    return json(id in db.plans ? [{ plan: db.plans[id] }] : []);
  }
  if (table === "econ_events") {
    if (db.fail.has("events")) return boom();
    if (q.get("select") === "fetched_at") {
      const all = db.events.map((r) => r.fetched_at as string).sort().reverse();
      return json(all.length ? [{ fetched_at: all[0] }] : []);
    }
    const f = eq("fetched_at");
    return json(db.events.filter((r) => r.fetched_at === f).sort((a, b) => String(a.event_at).localeCompare(String(b.event_at))));
  }
  if (table === "econ_digest_mails") {
    if (method === "GET") {
      if (db.fail.has("log")) return boom();
      return json(db.mails.filter((r) => r.digest_day === eq("digest_day")).map((r) => ({ user_id: r.user_id, status: r.status })));
    }
    const body = JSON.parse(String(init.body)) as Row;
    if (method === "POST") {
      if (db.fail.has("claim")) return boom();
      expect(q.get("on_conflict")).toBe("user_id,digest_day");
      if (db.mails.some((r) => r.user_id === body.user_id && r.digest_day === body.digest_day)) return json([]);
      const row = { id: `row-${db.nextId++}`, ...body };
      db.mails.push(row);
      return json([row], 201);
    }
    if (method === "PATCH") {
      if (db.fail.has("patch")) return boom();
      const id = eq("id");
      if (id !== null) {
        const row = db.mails.find((r) => r.id === id);
        if (row) Object.assign(row, body);
        return new Response(null, { status: 204 });
      }
      const rows = db.mails.filter((r) => r.user_id === eq("user_id") && r.digest_day === eq("digest_day") && r.status === eq("status"));
      for (const r of rows) Object.assign(r, body);
      return json(rows);
    }
  }
  throw new Error(`unexpected ${method} ${path}`);
};

const run = async (db: Db, over: Partial<MailerDeps> = {}) => {
  const sent: Array<{ to: string; subject: string; text: string }> = [];
  const deps: MailerDeps = {
    rest: fakeRest(db),
    emailOf: async (id) => (db.lookupFail ? { ok: false, email: null } : { ok: true, email: db.emails[id] ?? null }),
    send: async (to, mail) => {
      sent.push({ to, subject: mail.subject, text: mail.text });
      return db.sendResults.shift() ?? { ok: true, id: `re_${sent.length}` };
    },
    configured: true,
    sleep: async () => {},
    clock: () => NOW,
    ...over,
  };
  const result = await mailDigests(deps, DAY, NOW);
  return { result, sent };
};

describe("mailDigests", () => {
  it("sends the owner one mail, records it, and sends nothing on the next run of the morning", async () => {
    const db = freshDb();
    const a = await run(db);
    expect(a.sent).toHaveLength(1);
    expect(a.sent[0].to).toBe("owner@example.test");
    expect(a.sent[0].subject).toBe("【Sextant】大きな予定 10/22（木）: 今日〜明日の朝 2件");
    expect(a.result).toMatchObject({ due: true, day: DAY, recipients: 1, already: 0, sent: 1, failed: 0, feedEvents: 3, soonEvents: 2 });
    expect(db.mails).toHaveLength(1);
    expect(db.mails[0]).toMatchObject({ user_id: OWNER, digest_day: DAY, status: "sent", provider_id: "re_1", soon_events: 2, later_events: 1, lang: "ja", error: null });
    // the newest fetch only: the CPI at its new time, not its old one
    expect(db.mails[0].event_ids).toEqual([
      "aud|2026-10-21t23:00:00+00:00|rba gov bullock speaks",
      "usd|2026-10-22t12:30:00+00:00|cpi y/y",
      "jpy|2026-10-22t23:30:00+00:00|national core cpi y/y",
    ]);
    const b = await run(db);
    expect(b.sent).toHaveLength(0);
    expect(b.result).toMatchObject({ recipients: 1, already: 1 });
  });

  it("answers counts only: no address and no user id, and logs none", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const db = freshDb();
      db.subs.push({ user_id: OTHER, pair: "USD/JPY", interval: "15min", rule: "macdx", lang: "en" });
      db.fail.add("claim");
      const r = await run(db);
      const said = JSON.stringify(r.result) + JSON.stringify(errors.mock.calls);
      for (const secret of [OWNER, OTHER, "owner@example.test", "other@example.test"]) expect(said).not.toContain(secret);
      expect(r.result).toMatchObject({ claim_failed: 2, sent: 0 });
      expect(errors.mock.calls.flat().join(" ")).toContain("claim failed: 500 XX000");
    } finally {
      errors.mockRestore();
    }
  });

  it("sends nothing and claims nothing when the calendar cannot be read; the next run sends", async () => {
    const db = freshDb();
    db.fail.add("events");
    const a = await run(db);
    expect(a.result).toMatchObject({ due: true, day: DAY, error: "events_unread" });
    expect(a.sent).toHaveLength(0);
    expect(db.mails).toHaveLength(0);
    db.fail.delete("events");
    const b = await run(db);
    expect(b.sent).toHaveLength(1);
  });

  it("sends nothing when the calendar holds nothing", async () => {
    const db = freshDb();
    db.events = [];
    const r = await run(db);
    expect(r.result).toMatchObject({ error: "events_empty" });
    expect(r.sent).toHaveLength(0);
    expect(db.mails).toHaveLength(0);
  });

  it("sends nothing when the subscriptions or the morning's log cannot be read", async () => {
    for (const what of ["subs", "log"]) {
      const db = freshDb();
      db.fail.add(what);
      const r = await run(db);
      expect(r.result).toMatchObject({ error: what === "subs" ? "subscriptions_unread" : "log_unread" });
      expect(r.sent).toHaveLength(0);
      expect(db.mails).toHaveLength(0);
    }
  });

  it("claims nothing when the address or the plan cannot be looked up, and the next run sends", async () => {
    const db = freshDb();
    db.lookupFail = true;
    const a = await run(db);
    expect(a.result).toMatchObject({ lookup_failed: 1, sent: 0 });
    expect(db.mails).toHaveLength(0);
    db.lookupFail = false;
    db.fail.add("profile");
    const b = await run(db);
    expect(b.result).toMatchObject({ lookup_failed: 1, sent: 0 });
    expect(db.mails).toHaveLength(0);
    db.fail.delete("profile");
    const c = await run(db);
    expect(c.result).toMatchObject({ sent: 1 });
  });

  it("a failed send is tried again on the next run of the morning, once", async () => {
    const db = freshDb();
    db.sendResults = [{ ok: false, error: "500 Internal Server Error" }];
    const a = await run(db);
    expect(a.result).toMatchObject({ failed: 1, sent: 0 });
    expect(db.mails[0]).toMatchObject({ status: "failed", error: "500 Internal Server Error" });
    const b = await run(db);
    expect(b.result).toMatchObject({ already: 0, retried: 1, sent: 1 });
    expect(db.mails).toHaveLength(1);
    expect(db.mails[0]).toMatchObject({ status: "sent", error: null, provider_id: "re_1" });
    const c = await run(db);
    expect(c.sent).toHaveLength(0);
  });

  it("a 429 is sent once more at once; a quota is not", async () => {
    const db = freshDb();
    db.sendResults = [{ ok: false, error: "429 rate limit exceeded" }];
    const a = await run(db);
    expect(a.sent).toHaveLength(2);
    expect(a.result).toMatchObject({ sent: 1 });
    const db2 = freshDb();
    db2.sendResults = [{ ok: false, error: "429 daily quota exceeded" }];
    const b = await run(db2);
    expect(b.sent).toHaveLength(1);
    expect(b.result).toMatchObject({ failed: 1 });
  });

  it("someone without a plan is recorded as skipped and not mailed", async () => {
    const db = freshDb();
    db.subs = [{ user_id: OTHER, pair: "USD/JPY", interval: "15min", rule: "macdx", lang: "ja" }];
    const r = await run(db);
    expect(r.sent).toHaveLength(0);
    expect(r.result).toMatchObject({ skipped: 1 });
    expect(db.mails[0]).toMatchObject({ status: "skipped", error: "plan" });
  });

  it("without RESEND_API_KEY the row says not_configured; without an address it says no_email", async () => {
    const db = freshDb();
    const a = await run(db, { configured: false });
    expect(a.sent).toHaveLength(0);
    expect(db.mails[0]).toMatchObject({ status: "not_configured" });
    const db2 = freshDb();
    db2.emails[OWNER] = null;
    db2.plans[OWNER] = "pro";
    const b = await run(db2);
    expect(b.sent).toHaveLength(0);
    expect(db2.mails[0]).toMatchObject({ status: "failed", error: "no_email" });
  });

  it("only a subscription the MACD email follows (#384: the 15-minute chart from signal-alerts v31) makes a recipient; the other pairs still give the currencies", async () => {
    const db = freshDb();
    db.subs = [
      { user_id: OWNER, pair: "USD/JPY", interval: "5min", rule: "macdx", lang: "ja" },
      // the 1-hour chart is no longer the MACD email's (v31), nor is a pair it does not follow
      { user_id: OWNER, pair: "USD/JPY", interval: "1h", rule: "macdx", lang: "ja" },
      { user_id: OWNER, pair: "HKD/JPY", interval: "15min", rule: "macdx", lang: "ja" },
      { user_id: OWNER, pair: "AUD/JPY", interval: "15min", rule: "ultra", lang: "ja" },
    ];
    const a = await run(db);
    expect(a.result).toMatchObject({ recipients: 0 });
    db.subs.push({ user_id: OWNER, pair: "EUR/USD", interval: "15min", rule: "macdx", lang: "ja" });
    const b = await run(db);
    expect(b.sent).toHaveLength(1);
    expect(b.sent[0].text).toContain("対象の通貨: 米ドル・円・ユーロ・豪ドル・中国");
  });

  it("someone else's claim made first is left alone", async () => {
    const db = freshDb();
    // a row written between the log read and the claim (another run)
    const rest = fakeRest(db);
    const r = await run(db, {
      rest: async (path, init) => {
        if (init?.method === "POST") db.mails.push({ id: "row-x", user_id: OWNER, digest_day: DAY, status: "pending" });
        return rest(path, init);
      },
    });
    expect(r.result).toMatchObject({ claimed_elsewhere: 1, sent: 0 });
  });
});

describe("eventOfRow", () => {
  it("reads a stored row, and refuses one without its keys or with an unreadable time", () => {
    expect(eventOfRow({ id: "x", event_at: "2026-10-22T12:30:00+00:00", country: "USD", title: "CPI y/y", impact: "Weird", forecast: 3, previous: "3.0%", all_day: true })).toEqual({
      id: "x", event_at: "2026-10-22T12:30:00+00:00", country: "USD", title: "CPI y/y", impact: "Low", forecast: null, previous: "3.0%", all_day: true, source: "forexfactory",
    });
    expect(eventOfRow({ id: "x", event_at: "not a time", country: "USD", title: "CPI y/y" })).toBeNull();
    expect(eventOfRow({ event_at: "2026-10-22T12:30:00+00:00", country: "USD", title: "CPI y/y" })).toBeNull();
  });
});
