// v42 (research/allstocks-prod-spec.md section 9, "Dry run"): the "stocks" run of the REAL
// supabase/functions/signal-alerts/index.ts in a fake world with 50 made-up shares, both markets (25 US, 25 Tokyo),
// through one Tokyo session and one US session of made-up bars on one UTC day (Tuesday 2026-11-24, New York on winter
// time), with a new module instance every minute (as the docs say the every-minute runs usually start, OPS:3656) and
// once with one instance throughout. Checked: the reads per share against spec 3.5's counts (406 a US share and 362 a
// Tokyo one a weekday on new instances; on one warm instance a US share once a close, 26, and a Tokyo share about 330),
// the budget's leftovers (none at production's 530 ms a read with 25 shares due; at a slower read, no share left in two
// runs in a row on new instances), and one daily note a share a day (in one request a run).
//
// Made-up everything: the symbols (DRA … DRY, 9R00.T … 9R24.T), the users, the bars and their prices, and a Yahoo that
// answers with the newest 40 bars only (fewer than the rule's 600, so no entry and no mail: the dry run counts reads,
// leftovers and notes, not signals; the signals are src/test/stockmacd-alerts.test.tsx's). Tokyo's prices come 15
// minutes late here, as production's did on 1-hour reads (docs §8.141); New York's on time. Nothing reaches a network.
// v43: and the Tokyo session with 4063.T among the shares, read on its 1-hour chart (`60m`) only in the half hour after
// each of its 1-hour closes, the budget holding.
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { CLOSES, STOCK_RUN_BUDGET_MS, localOf, stockBarEnd } from "../../supabase/functions/signal-alerts/stocks";

type Row = Record<string, unknown>;
type Handler = (req: Request) => Promise<Response>;
type Summary = Record<string, unknown> & { reads?: Array<Record<string, unknown>> };

const MIN = 60_000;
const H = 60 * MIN;
const SB = "https://sb.test";
const DAY = Date.UTC(2026, 10, 24);
const US = Array.from({ length: 25 }, (_, k) => `DR${String.fromCharCode(65 + k)}`);
const JP = Array.from({ length: 25 }, (_, k) => `9R${String(k).padStart(2, "0")}.T`);
const SHARES = [...US, ...JP];
const isJp = (s: string) => s.endsWith(".T");

// the regular session's bar opens of each market on the days the answers reach (Thu 11/19 … Tue 11/24; the weekend has
// none), made from the market's own hours (New York 9:30 … 15:45 local, Tokyo 9:00 … 11:15 and 12:30 … 15:15)
const opensOf = (jp: boolean): number[] => {
  const out: number[] = [];
  for (let day = DAY - 5 * 24 * H; day <= DAY; day += 24 * H) {
    for (let t = day; t < day + 24 * H; t += 15 * MIN) {
      const l = localOf(jp ? "9R00.T" : "DRA", t);
      if (l.wd < 1 || l.wd > 5) continue;
      const ok = jp ? (l.min >= 9 * 60 && l.min <= 11 * 60 + 15) || (l.min >= 12 * 60 + 30 && l.min <= 15 * 60 + 15) : l.min >= 9 * 60 + 30 && l.min <= 15 * 60 + 45;
      if (ok) out.push(t);
    }
  }
  return out;
};
const OPENS = { us: opensOf(false), jp: opensOf(true) };
// v43: 4063.T's 1-hour bar opens on the same days (Tokyo 9:00 … 15:00 JST on the hour, the bar stamped 12:00 trading
// 12:30-13:00, as docs §8.141 reports Yahoo's 1-hour answer)
const HOUR_OPENS = [...new Set(OPENS.jp.map((t) => Math.floor(t / H) * H))].sort((a, b) => a - b);

const world = {
  subs: [] as Row[],
  stocks: [] as Row[],
  // the notes' writes, each with the run it came in
  writes: [] as Array<{ run: number; body: Row[] }>,
  yahoo: [] as string[],
  // v43: each Yahoo read as "symbol interval range"
  charts: [] as string[],
  unrouted: [] as string[],
  delayMs: 530,
  run: 0,
};
let clock = 0;
let ids = 0;

// Yahoo's 15-minute answer at the clock (Tokyo's 15 minutes behind): the newest 40 bars opened by then, the one still
// forming 0.5 above its open, Yahoo's last trade then. v43: a `60m` read (4063.T's chart) the newest 40 of HOUR_OPENS,
// each closed at its own end (stockBarEnd: the 11:00 and 15:00 JST bars half an hour)
const yahooAnswer = (sym: string, interval: string | null = "15m") => {
  const jp = isJp(sym);
  const hourly = interval === "60m";
  const seen = clock - (jp ? 15 * MIN : 0);
  const opens = (hourly ? HOUR_OPENS : OPENS[jp ? "jp" : "us"]).filter((t) => t <= seen).slice(-40);
  const base = jp ? 2000 : 100;
  const ts: number[] = [];
  const q = { open: [] as number[], high: [] as number[], low: [] as number[], close: [] as number[], volume: [] as number[] };
  for (const t of opens) {
    const k = Math.round(t / (15 * MIN));
    const open = base + (k % 7);
    const close = (hourly ? stockBarEnd(sym, t) : t + 15 * MIN) <= seen ? base + ((k + 3) % 7) : open + 0.5;
    ts.push(t / 1000);
    q.open.push(open);
    q.high.push(Math.max(open, close) + 1);
    q.low.push(Math.min(open, close) - 1);
    q.close.push(close);
    q.volume.push(1000);
  }
  return { chart: { result: [{ meta: { symbol: sym, regularMarketPrice: q.close[q.close.length - 1] ?? base, regularMarketTime: Math.floor(seen / 1000) }, timestamp: ts, indicators: { quote: [q] } }] } };
};

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const method = init?.method ?? "GET";
  const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
  if (url.startsWith("https://query1.finance.yahoo.com/v8/finance/chart/")) {
    const sym = decodeURIComponent(new URL(url).pathname.split("/").pop()!);
    const q = new URL(url).searchParams;
    world.yahoo.push(sym);
    world.charts.push(`${sym} ${q.get("interval")} ${q.get("range")}`);
    clock += world.delayMs;
    return reply(yahooAnswer(sym, q.get("interval")));
  }
  const u = new URL(url);
  const table = u.pathname.slice("/rest/v1/".length);
  if (table === "rpc/track_outcomes_sweep_token") return reply("tok");
  if (table === "signal_alert_subscriptions" && method === "GET") {
    const after = u.searchParams.get("id");
    expect(u.searchParams.get("rule")).toBe("eq.stockmacd");
    expect(u.searchParams.get("interval")).toBe("eq.15min");
    const limit = Number(u.searchParams.get("limit"));
    const rows = world.subs.filter((r) => after === null || String(r.id) > after.slice(3)).sort((a, b) => (String(a.id) < String(b.id) ? -1 : 1));
    return reply(rows.slice(0, limit));
  }
  if (table === "signal_alert_stocks" && method === "GET") {
    const list = new Set((u.searchParams.get("pair") ?? "").replace(/^in\.\(|\)$/g, "").split(",").map((v) => v.replace(/^"|"$/g, "")));
    return reply(world.stocks.filter((r) => list.has(String(r.pair))).map((r) => ({ pair: r.pair, name: r.name ?? null, noted_at: r.noted_at ?? null })));
  }
  if (table === "signal_alert_stocks" && method === "POST") {
    // spec 4.2's one upsert (a plain insert would fail on a row already there, as PostgREST answers it: 409)
    expect(u.search).toBe("?on_conflict=pair");
    expect(new Headers(init?.headers).get("Prefer")).toBe("resolution=merge-duplicates,return=minimal");
    world.writes.push({ run: world.run, body });
    for (const x of body as Row[]) {
      const there = world.stocks.find((r) => r.pair === x.pair);
      if (there) Object.assign(there, x);
      else world.stocks.push({ name: null, ...x });
    }
    return new Response(null, { status: 201 });
  }
  world.unrouted.push(`${method} ${url.slice(0, 80)}`);
  return reply([]);
};

describe("v42 dry run: 50 made-up shares through a Tokyo and a US session (research/allstocks-prod-spec.md section 9)", () => {
  let captured: Handler | null = null;
  const realSetTimeout = globalThis.setTimeout;
  beforeAll(() => {
    vi.stubGlobal("Deno", {
      env: { get: (k: string) => ({ SUPABASE_URL: SB, SUPABASE_ANON_KEY: "anon", SUPABASE_SERVICE_ROLE_KEY: "svc", RESEND_API_KEY: "re_test" } as Record<string, string>)[k] },
      serve: (h: Handler) => {
        captured = h;
      },
    });
    vi.stubGlobal("fetch", fakeFetch);
    vi.stubGlobal("setTimeout", (fn: () => void, ms?: number) => {
      clock += Math.max(0, ms ?? 0);
      return realSetTimeout(fn, 0);
    });
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    const signal = AbortSignal as unknown as { timeout?: (ms: number) => AbortSignal };
    if (typeof signal.timeout !== "function") signal.timeout = () => new AbortController().signal;
  });
  afterAll(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const INDEX = "../../supabase/functions/signal-alerts/index.ts";
  const instance = async (): Promise<Handler> => {
    vi.resetModules();
    captured = null;
    await import(/* @vite-ignore */ INDEX);
    if (!captured) throw new Error("the function did not start");
    return captured;
  };
  const run = async (h: Handler, when: number): Promise<Summary> => {
    clock = when;
    world.run++;
    const res = await h(new Request("https://fn.test/signal-alerts", { method: "POST", headers: { "x-sweep-token": "tok", "Content-Type": "application/json" }, body: JSON.stringify({ mode: "stocks" }) }));
    expect(res.status).toBe(200);
    const s = JSON.parse(await res.text()) as Summary;
    // (v43 moved the five pairs' fade to 5-minute bars; the shares' run is v42's)
    expect(s).toMatchObject({ ok: true, mode: "stocks", version: "signal-alerts-v43-2026-11-27" });
    return s;
  };
  const reset = (delayMs: number, shares: string[] = SHARES) => {
    // one follower a share, a second one for every fifth share (60 rows), made-up users and ids
    world.subs = shares.flatMap((p, k) => [p, ...(k % 5 === 0 ? [p] : [])].map((pair, j) => ({
      id: `00000000-0000-4000-8000-${(++ids).toString(16).padStart(12, "0")}`, user_id: `dry-${k}-${j}`, pair, interval: "15min", lang: "ja", rule: "stockmacd",
    })));
    Object.assign(world, { stocks: [], writes: [], yahoo: [], charts: [], unrouted: [], delayMs, run: 0 });
  };
  // the minutes of the day the runs are made at (a second past each minute): the two markets' due windows with five
  // minutes on either side (Tokyo 00:10 to 07:05 UTC, New York 14:40 to 21:35), and every 20th minute of the rest of
  // the day (where nothing is due)
  const MINUTES = Array.from({ length: 24 * 60 }, (_, m) => m).filter((m) => (m >= 10 && m <= 7 * 60 + 5) || (m >= 14 * 60 + 40 && m <= 21 * 60 + 35) || m % 20 === 0);
  const at = (m: number) => DAY + m * MIN + 1_000;
  const hm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  const perShare = () => {
    const n = new Map<string, number>();
    for (const s of world.yahoo) n.set(s, (n.get(s) ?? 0) + 1);
    return n;
  };
  const notesPerShare = () => {
    const n = new Map<string, number>();
    for (const w of world.writes) for (const x of w.body) n.set(String(x.pair), (n.get(String(x.pair)) ?? 0) + 1);
    return n;
  };

  it("a new module instance every minute, 530 ms a read: 406 reads a US share and 362 a Tokyo one, none left for the budget, one note a share a day in one request a run", { timeout: 600_000 }, async () => {
    reset(530);
    const took: number[] = [];
    const readMinutes = new Map<string, number[]>();
    for (const m of MINUTES) {
      const s = await run(await instance(), at(m));
      expect(s).toMatchObject({ subscriptions: 60, shares: 50 });
      expect((s.reads ?? []).filter((r) => r.skipped === "budget"), hm(m)).toEqual([]);
      for (const r of s.reads ?? []) readMinutes.set(String(r.pair), [...(readMinutes.get(String(r.pair)) ?? []), m]);
      took.push(Number(s.took_ms));
    }
    const n = perShare();
    for (const p of US) expect(n.get(p), p).toBe(406);
    for (const p of JP) expect(n.get(p), p).toBe(362);
    // the windows: New York 9:45 to 16:30 local (14:45 to 21:30 UTC in winter), Tokyo 9:15 to 12:00 and 12:45 to 16:00
    // (00:15 to 03:00 and 03:45 to 07:00 UTC); one read a run while a close is due, nothing outside
    expect([readMinutes.get("DRA")![0], readMinutes.get("DRA")!.at(-1)].map(hm)).toEqual(["14:45", "21:30"]);
    expect(readMinutes.get("9R00.T")!.filter((m) => m < 3 * 60 + 30).map(hm).filter((_, k, a) => k === 0 || k === a.length - 1)).toEqual(["00:15", "03:00"]);
    expect(readMinutes.get("9R00.T")!.filter((m) => m > 3 * 60 + 30).map(hm).filter((_, k, a) => k === 0 || k === a.length - 1)).toEqual(["03:45", "07:00"]);
    // the two markets' windows do not overlap: a run reads 25 shares at most, about 13.25 s at 530 ms
    expect(Math.max(...took)).toBe(25 * 530);
    expect(Math.max(...took)).toBeLessThan(STOCK_RUN_BUDGET_MS);
    // one note a share a day, whatever the instance (the day is the table's), and at most one write a run
    expect([...notesPerShare().entries()].sort()).toEqual(SHARES.map((p) => [p, 1]).sort());
    expect(new Set(world.writes.map((w) => w.run)).size).toBe(world.writes.length);
    // a Tokyo share's note at the 9:15 close (its first read): the newest bar Yahoo gave (today's 9:00, still forming,
    // 15 minutes behind) and the closed bars' count
    const tokyoNote = world.writes.flatMap((w) => w.body).find((x) => x.pair === "9R00.T")!;
    expect(tokyoNote).toEqual({ pair: "9R00.T", last_bar_at: "2026-11-24T00:00:00.000Z", bars: 39, noted_at: new Date(at(15)).toISOString() });
    expect(world.unrouted).toEqual([]);
  });

  it("a new module instance every minute through the Tokyo session, 1,300 ms a read (25 due: 23 read a run): two left each run, never the same share in two runs in a row", { timeout: 600_000 }, async () => {
    reset(1_300);
    const left: string[][] = [];
    for (const m of MINUTES.filter((x) => x < 7 * 60 + 30)) {
      const s = await run(await instance(), at(m));
      const reads = s.reads ?? [];
      if (reads.length === 0) continue;
      left.push(reads.filter((r) => r.skipped === "budget").map((r) => String(r.pair)));
      // reads start at 0, 1.3, …, 28.6 s; the next would start at 29.9 s, with under 1 s of the budget left
      expect(reads.filter((r) => r.skipped === undefined)).toHaveLength(23);
      expect(Number(s.took_ms)).toBe(23 * 1_300);
    }
    expect(left).toHaveLength(362);
    expect(left.every((l) => l.length === 2)).toBe(true);
    for (let k = 1; k < left.length; k++) expect(left[k].filter((p) => left[k - 1].includes(p)), `runs ${k - 1} and ${k}`).toEqual([]);
    // so each Tokyo share is read in every run but the ones that leave it (the last two of the order on an even minute,
    // the first two on an odd one)
    const n = perShare();
    expect([...n.values()].reduce((a, b) => a + b, 0)).toBe(362 * 23);
    for (const p of JP) expect(n.get(p)!, p).toBeGreaterThanOrEqual(362 - 181);
    expect(new Set(left.flat())).toEqual(new Set([...JP.slice(0, 2), ...JP.slice(23)]));
    expect([...notesPerShare().entries()].sort()).toEqual(JP.map((p) => [p, 1]).sort());
  });

  it("one instance throughout, 530 ms a read: a US share read once a close (26), a Tokyo share 332 times (Yahoo 15 minutes behind: its close due is done only after 11:30 and 15:30); one note a share a day", { timeout: 600_000 }, async () => {
    reset(530);
    const h = await instance();
    for (const m of MINUTES) await run(h, at(m));
    const n = perShare();
    for (const p of US) expect(n.get(p), p).toBe(CLOSES.us.length);
    // 9:15 to 11:45 JST every minute (151: each close's bar comes 15 minutes later, when the next close is due, until
    // the 11:30 close's at 11:45) and 12:45 to 15:45 (181), as spec 3.5's "about 330"
    for (const p of JP) expect(n.get(p), p).toBe(151 + 181);
    expect([...notesPerShare().entries()].sort()).toEqual(SHARES.map((p) => [p, 1]).sort());
    expect(world.unrouted).toEqual([]);
  });

  // v43: 4063.T judged on its 1-hour bars (stocks.ts STOCKMACD_CHART_OF), followed by its '15min' rows as every share;
  // the 25 Tokyo shares here are 24 made-up ones and 4063.T (its bars made up too)
  const JP43 = [...JP.slice(0, 24), "4063.T"];
  const tokyoMinutes = MINUTES.filter((x) => x < 7 * 60 + 30);

  it("v43, a new module instance every minute through the Tokyo session, 530 ms a read: 4063.T read on `60m` over `1y` only in the half hour after each of its seven 1-hour closes (215 reads), the 15-minute shares as before (362), none left for the budget", { timeout: 600_000 }, async () => {
    reset(530, JP43);
    const readMinutes: number[] = [];
    for (const m of tokyoMinutes) {
      const s = await run(await instance(), at(m));
      expect(s).toMatchObject({ subscriptions: 30, shares: 25 });
      expect((s.reads ?? []).filter((r) => r.skipped === "budget"), hm(m)).toEqual([]);
      if ((s.reads ?? []).some((r) => r.pair === "4063.T")) readMinutes.push(m);
      expect(Number(s.took_ms)).toBeLessThan(STOCK_RUN_BUDGET_MS);
    }
    const n = perShare();
    expect(n.get("4063.T")).toBe(215);
    for (const p of JP43.slice(0, 24)) expect(n.get(p), p).toBe(362);
    // its windows: 10:00, 11:00 to 12:00, 13:00, 14:00, 15:00 to 16:00 JST (01:00, 02:00 to 03:00, 04:00, 05:00, 06:00 to
    // 07:00 UTC), each close's half hour
    const runs: string[] = [];
    for (const m of readMinutes) {
      const last = runs.at(-1);
      if (last && Number(last.split("-")[1]) === m - 1) runs[runs.length - 1] = `${last.split("-")[0]}-${m}`;
      else runs.push(`${m}-${m}`);
    }
    expect(runs.map((r) => r.split("-").map((x) => hm(Number(x))).join("–"))).toEqual(["01:00–01:30", "02:00–03:00", "04:00–04:30", "05:00–05:30", "06:00–07:00"]);
    expect(new Set(world.charts.filter((c) => c.startsWith("4063.T ")))).toEqual(new Set(["4063.T 60m 1y"]));
    expect(new Set(world.charts.filter((c) => !c.startsWith("4063.T ")).map((c) => c.split(" ").slice(1).join(" ")))).toEqual(new Set(["15m 60d"]));
    expect([...notesPerShare().entries()].sort()).toEqual(JP43.map((p) => [p, 1]).sort());
    expect(world.unrouted).toEqual([]);
  });

  it("v43, one instance throughout the Tokyo session: 4063.T read once a minute from each 1-hour close until its bar is in (15 minutes behind), 16 reads a close, 112 a day; the 15-minute shares as before (332)", { timeout: 600_000 }, async () => {
    reset(530, JP43);
    const h = await instance();
    for (const m of tokyoMinutes) await run(h, at(m));
    const n = perShare();
    expect(n.get("4063.T")).toBe(7 * 16);
    for (const p of JP43.slice(0, 24)) expect(n.get(p), p).toBe(151 + 181);
    expect(world.unrouted).toEqual([]);
  });
});
