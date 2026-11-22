// deno test research/allstocks-scan/judge_test.ts
// Made-up prices only (a seeded random walk); no Yahoo answer is used or stored.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { stockBarsOf, type StockBar } from "../../supabase/functions/signal-alerts/stocks.ts";
import { closeZonesAt, fadeCloseEntryAt } from "../../supabase/functions/_shared/macd-fade.ts";
import { judgeLastSession, marketDate } from "./judge.ts";
import { fakeAnswer, weekdays } from "./fake.ts";

const NOW = Date.parse("2026-11-22T07:00:00Z"); // a Sunday, after both markets' Friday sessions

const barsOf = (sym: string, body: unknown, now = NOW): StockBar[] => {
  const got = stockBarsOf(sym, body, now);
  assert(got !== null, "stockBarsOf read the made-up answer");
  return got.bars;
};

// An independent recount: the bars of the given UTC window, each judged on the closed bars up to it
const recount = (bars: StockBar[], fromMs: number, toMs: number, skip: Set<number> = new Set()) => {
  const closed = bars.filter((b) => b.closed);
  const closes = closed.map((b) => b.close);
  const out: { open: string; side: string }[] = [];
  let n = 0;
  closed.forEach((b, k) => {
    if (b.open_ms < fromMs || b.open_ms >= toMs || skip.has(b.open_ms)) return;
    n++;
    if (k + 1 < 600) return;
    const e = fadeCloseEntryAt(closes.slice(0, k + 1));
    if (e) out.push({ open: new Date(b.open_ms).toISOString(), side: e.side });
  });
  return { n, out };
};

const US_DAYS = weekdays("2026-09-21", "2026-11-20"); // 45 weekdays, 1,170 bars
const JP_DAYS = weekdays("2026-09-21", "2026-11-20"); // 45 weekdays, 1,035 bars

// the first seed (deterministic) whose last US session has at least one entry
const usSeed = (() => {
  for (let s = 1; s < 400; s++) {
    if (judgeLastSession("XYZ", barsOf("XYZ", fakeAnswer("XYZ", US_DAYS, s))).signals.length > 0) return s;
  }
  throw new Error("no seed with an entry");
})();
const jpSeed = (() => {
  for (let s = 1; s < 400; s++) {
    if (judgeLastSession("9999.T", barsOf("9999.T", fakeAnswer("9999.T", JP_DAYS, s))).signals.length > 0) return s;
  }
  throw new Error("no seed with an entry");
})();

Deno.test("US: the last session's 26 bars are judged, and the entries equal a recount on Friday's UTC window", () => {
  const bars = barsOf("XYZ", fakeAnswer("XYZ", US_DAYS, usSeed));
  const j = judgeLastSession("XYZ", bars);
  assertEquals(j.day, "2026-11-20");
  assertEquals(j.sessionBars, 26);
  assertEquals(j.shortBars, 0);
  const want = recount(bars, Date.parse("2026-11-20T14:30:00Z"), Date.parse("2026-11-20T21:00:00Z"));
  assertEquals(want.n, 26);
  assert(want.out.length > 0);
  assertEquals(j.signals, want.out);
});

Deno.test("Tokyo: 22 bars judged (the 11:30 lunch bar is in the closes but never judged), entries equal a recount", () => {
  const bars = barsOf("9999.T", fakeAnswer("9999.T", JP_DAYS, jpSeed));
  const j = judgeLastSession("9999.T", bars);
  assertEquals(j.day, "2026-11-20");
  assertEquals(j.sessionBars, 22);
  const lunch = Date.parse("2026-11-20T02:30:00Z");
  assert(bars.some((b) => b.open_ms === lunch && b.closed), "the lunch bar is there and closed");
  const want = recount(bars, Date.parse("2026-11-20T00:00:00Z"), Date.parse("2026-11-20T06:30:00Z"), new Set([lunch]));
  assertEquals(want.n, 22);
  assertEquals(j.signals, want.out);
  assert(!j.signals.some((s) => s.open === new Date(lunch).toISOString()));
});

Deno.test("no look-ahead: changing every close after a bar never changes that bar's entry", () => {
  for (const [sym, days, seed] of [["XYZ", US_DAYS, usSeed], ["9999.T", JP_DAYS, jpSeed]] as const) {
    const base = barsOf(sym, fakeAnswer(sym, days, seed));
    const j0 = judgeLastSession(sym, base);
    const closed = base.filter((b) => b.closed);
    const day = j0.day!;
    const idx = closed.map((b, k) => ({ b, k })).filter(({ b }) => marketDate(sym, b.open_ms) === day).map(({ k }) => k);
    for (const k of idx) {
      const moved = judgeLastSession(sym, barsOf(sym, fakeAnswer(sym, days, seed, { from: k + 1, by: 1.37 })));
      const at = new Date(closed[k].open_ms).toISOString();
      const upTo = (s: { open: string }[]) => s.filter((x) => x.open <= at);
      assertEquals(upTo(moved.signals), upTo(j0.signals), `${sym} bar ${at}`);
    }
  }
});

Deno.test("fewer than 600 closed bars: no entry, every session bar counted short, no zone", () => {
  const days = weekdays("2026-10-26", "2026-11-20"); // 20 weekdays: 460 Tokyo bars
  const j = judgeLastSession("9999.T", barsOf("9999.T", fakeAnswer("9999.T", days, 7)));
  assertEquals(j.sessionBars, 22);
  assertEquals(j.shortBars, 22);
  assertEquals(j.signals, []);
  assertEquals(j.zone, null);
});

Deno.test("during the session: only the bars closed by then are judged", () => {
  const now = Date.parse("2026-11-20T15:07:00Z"); // New York 10:07: the 9:30 and 9:45 bars have closed
  const body = fakeAnswer("XYZ", US_DAYS, usSeed);
  // Yahoo's price time while the session trades: now
  (body.chart.result[0].meta as Record<string, unknown>).regularMarketTime = now / 1000;
  const j = judgeLastSession("XYZ", barsOf("XYZ", body, now));
  assertEquals(j.sessionBars, 2);
});

Deno.test("the zone at the newest closed bar is closeZonesAt's, with the 96% side", () => {
  for (const [sym, days, seed] of [["XYZ", US_DAYS, usSeed], ["9999.T", JP_DAYS, jpSeed]] as const) {
    for (let s = seed; s < seed + 30; s++) {
      const bars = barsOf(sym, fakeAnswer(sym, days, s));
      const j = judgeLastSession(sym, bars);
      const zs = closeZonesAt(bars.filter((b) => b.closed).map((b) => b.close))!;
      const { m, top, bottom } = zs.z;
      const side = m > 0 && top > 0 && m >= 0.96 * top ? "SELL" : m < 0 && bottom < 0 && m <= 0.96 * bottom ? "BUY" : null;
      assertEquals(j.zone?.side ?? null, side, `${sym} seed ${s}`);
      // a fresh entry at the newest bar is always in the zone on its side
      const last = j.signals.at(-1);
      const newest = bars.filter((b) => b.closed).at(-1)!;
      if (last && last.open === new Date(newest.open_ms).toISOString()) assertEquals(j.zone?.side, last.side);
    }
  }
});

Deno.test("market dates: New York's and Tokyo's own", () => {
  assertEquals(marketDate("XYZ", Date.parse("2026-11-21T01:00:00Z")), "2026-11-20");
  assertEquals(marketDate("9999.T", Date.parse("2026-11-20T15:30:00Z")), "2026-11-21");
});
