// #186: does buying USD/JPY at 23:00 JST the evening before a gotobi day and
// selling at the 9:55 JST fixing still pay, on GMO's 1-minute bid/ask bars,
// after the Kobe University paper's period (docs §8.95, design §8.96)?
//
// Read-only: GMO FX's public klines and the Cabinet Office's holiday list;
// prints to the job log and writes its tables to research/out (an artifact).
// Runs on GitHub's runners (the development container reaches neither).
//
//   MODE=prepare    the holiday list checked, the calendars counted (Kobe's
//                   2007-01 to 2020-01 too), and GMO's first 1-minute day file
//                   found by reading which files exist and how many bars they
//                   hold — no price is computed (§8.96: the first day is fixed
//                   in docs before the study reads prices)
//   MODE=synthetic  the made-up checks of §8.96: the bars' handling ①–⑨, the
//                   calendar's hand-made days, and the statistics on made-up
//                   daily results (power table)
//   MODE=real       the study; FIRST (the first GMO day file, from prepare,
//                   committed in docs) and END (the last trade day) required
//
//   deno run --allow-net=forex-api.coin.z.com,www8.cao.go.jp --allow-read=. \
//     --allow-write=research/.cache,research/out --allow-env research/gotobi.ts

import { klineUrl, parseKlines } from "../supabase/functions/track-outcomes/quotes.ts";
import {
  addDays,
  addFile,
  autocorr1,
  buildCalendar,
  type Calendar,
  checkHolidays,
  DAY,
  dateOf,
  decide,
  entryAt,
  excludedWhy,
  exitAt,
  HOUR,
  hourEntryAt,
  joinSides,
  legs,
  matchedCi,
  matchedDiff,
  mean,
  milli,
  MIN,
  parseHolidayCsv,
  pathStats,
  quantile,
  rng,
  type Row,
  type SideBars,
  tMeanCi,
  tQuantile,
  type Trade,
  tradeDay,
  usable,
  utcOf,
  variance,
  weekday,
  WEEKDAY_NAMES,
  welchCi,
  wilsonCi,
} from "./gotobi-lib.ts";

const MODE = Deno.env.get("MODE") ?? "synthetic";
const OUT = "research/out";
const CACHE = "research/.cache/gotobi";
const HOLIDAY_URL = "https://www8.cao.go.jp/chosei/shukujitsu/syukujitsu.csv";
// the Kobe paper's sizes, before the spread, in sen (§8.95)
const KOBE_DIFF = 9;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sen = (milliYen: number) => milliYen / 10;
const fmt = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "-");
const pctf = (x: number) => `${(x * 100).toFixed(1)}%`;
const ci = (c: { lo: number; hi: number }, d = 2) => `[${fmt(c.lo, d)}, ${fmt(c.hi, d)}]`;
await Deno.mkdir(OUT, { recursive: true });

// ---- the network, read again three times, then stop ---------------------------------------
let requests = 0;
const getBytes = async (url: string): Promise<{ status: number; bytes: Uint8Array }> => {
  for (let attempt = 1; ; attempt++) {
    await sleep(80);
    requests++;
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (r.status === 404) {
        await r.body?.cancel();
        return { status: 404, bytes: new Uint8Array() };
      }
      if (r.ok) return { status: r.status, bytes: new Uint8Array(await r.arrayBuffer()) };
      await r.body?.cancel();
      if (attempt >= 4) throw new Error(`${url}: HTTP ${r.status} after ${attempt} tries`);
    } catch (e) {
      if (attempt >= 4) throw e;
    }
    await sleep(1000 * attempt);
  }
};

const sha256 = async (bytes: Uint8Array) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)))].map((b) => b.toString(16).padStart(2, "0")).join("");

// ---- holidays ------------------------------------------------------------------------------
const readHolidays = async () => {
  const local = Deno.env.get("HOLIDAYS_FILE");
  const bytes = local ? await Deno.readFile(local) : (await getBytes(HOLIDAY_URL)).bytes;
  const text = local ? new TextDecoder().decode(bytes) : new TextDecoder("shift_jis").decode(bytes);
  const list = parseHolidayCsv(text);
  const hash = await sha256(bytes);
  await Deno.writeFile(`${OUT}/syukujitsu.csv`, bytes);
  await Deno.writeTextFile(`${OUT}/syukujitsu.txt`, `source ${local ?? HOLIDAY_URL}\nrows ${list.rows}\nsha256 ${hash}\n`);
  return { list, hash, source: local ?? HOLIDAY_URL };
};

/** the calendar years from one date to another */
const yearsOf = (from: string, to: string) => {
  const out: number[] = [];
  for (let y = Number(from.slice(0, 4)); y <= Number(to.slice(0, 4)); y++) out.push(y);
  return out;
};

// ---- GMO's day files ---------------------------------------------------------------------
/** a GMO kline answer that can be used and kept: status 0 and a data list (a maintenance answer is status 5) */
const goodBody = (text: string): boolean => {
  try {
    const b = JSON.parse(text);
    return b?.status === 0 && Array.isArray(b?.data);
  } catch {
    return false;
  }
};
/** a day file's text, "null" for a 404; an answer that is not usable is read again, three times, then the run stops */
const fetchDayFile = async (side: "bid" | "ask", date: string): Promise<string> => {
  for (let attempt = 1; ; attempt++) {
    const r = await getBytes(klineUrl("USD_JPY", side, "1min", compact(date)));
    const text = r.status === 404 ? "null" : new TextDecoder().decode(r.bytes);
    if (text === "null" || goodBody(text)) return text;
    if (attempt >= 4) throw new Error(`GMO ${side} ${date}: no usable answer after ${attempt} tries: ${text.slice(0, 200)}`);
    await sleep(1000 * attempt);
  }
};

type Rows = Array<{ t: number; o: number; h: number; l: number; c: number }>;
const fileKeyOf = (t: number) => dateOf(Math.floor((t + 3 * HOUR) / DAY) * DAY); // GMO's day starts 06:00 JST
const compact = (date: string) => date.replaceAll("-", "");

/** a day file's rows (prices in 0.001 yen), null when GMO has none (404); cached on disk */
const readDayFile = async (side: "bid" | "ask", date: string, useCache: boolean): Promise<{ rows: Rows | null; hash: string }> => {
  const path = `${CACHE}/${side}/${compact(date)}.json`;
  let text: string | null = null;
  if (useCache) {
    try {
      text = await Deno.readTextFile(path);
    } catch {
      text = null;
    }
    // a file an older run kept that is not usable (cut short): read it again
    if (text !== null && text !== "null" && !goodBody(text)) text = null;
  }
  if (text === null) {
    text = await fetchDayFile(side, date);
    if (useCache) {
      await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
      await Deno.writeTextFile(path, text);
    }
  }
  const hash = await sha256(new TextEncoder().encode(text));
  if (text === "null") return { rows: null, hash };
  const body = JSON.parse(text);
  if (body?.status !== 0) throw new Error(`GMO ${side} ${date}: status ${body?.status}`);
  const rows = parseKlines(body).map((b) => ({ t: b.t, o: milli(b.c.open), h: milli(b.c.high), l: milli(b.c.low), c: milli(b.c.close) }));
  return { rows, hash };
};

// =================================================================================================
if (MODE === "prepare") {
  const { list, hash, source } = await readHolidays();
  console.log(`holidays: ${source} rows ${list.rows} sha256 ${hash}`);
  const years = [];
  for (let y = 2007; y <= 2026; y++) years.push(y);
  // the known days now; the 16-21 a year rule (§8.96) for the measured years, once the first day is known
  // (Kobe's years are only counted: 2011 has 15, no substitute holiday that year; 2019 has 22)
  const problems = checkHolidays(list, []);
  for (const y of years) console.log(`  ${y}: ${[...list.days.keys()].filter((d) => d.startsWith(`${y}-`)).length} holidays`);
  if (problems.length) {
    console.log(`HOLIDAY LIST PROBLEMS: ${problems.join("; ")}`);
    Deno.exit(1);
  }
  // Kobe's period, the calendar only
  const kobe = buildCalendar("2007-01-01", "2020-01-31", list.days);
  const kg = kobe.days.filter((d) => d.kind === "gotobi").length;
  const kc = kobe.days.filter((d) => d.kind === "control").length;
  const ka = kobe.days.filter((d) => d.kind === "ambiguous").length;
  let monFri = 0;
  for (let d = "2007-01-01"; utcOf(d) <= utcOf("2020-01-31"); d = addDays(d, 1)) if (weekday(d) >= 1 && weekday(d) <= 5) monFri++;
  console.log(`Kobe's period 2007-01-01..2020-01-31 by this calendar: gotobi ${kg} (paper 900); not gotobi Mon-Fri days ${monFri - kg} of ${monFri} Mon-Fri days, holidays and 12/31-1/3 included (paper 2,513); of them business days ${kc + ka} (control ${kc}, ambiguous ${ka})`);
  // GMO's first 1-minute day file: the first of each month, then each day of the month before it
  const has = async (side: "bid" | "ask", date: string) => {
    const text = await fetchDayFile(side, date);
    return text === "null" ? 0 : JSON.parse(text).data.length as number;
  };
  let firstMonth: string | null = null;
  for (let y = 2019; y <= 2026 && !firstMonth; y++) {
    for (let m = 1; m <= 12 && !firstMonth; m++) {
      const d = `${y}-${String(m).padStart(2, "0")}-01`;
      // a weekday near the first, so a weekend is not taken for no data
      let probe = d;
      while (weekday(probe) === 0 || weekday(probe) === 6) probe = addDays(probe, 1);
      const n = await has("bid", probe);
      console.log(`  probe ${probe}: bid bars ${n}`);
      if (n > 0) firstMonth = d;
    }
  }
  if (!firstMonth) throw new Error("no 1-minute day file found");
  let first: string | null = null;
  const scanFrom = addDays(firstMonth, -40);
  for (let d = scanFrom; utcOf(d) <= utcOf(firstMonth) + 7 * DAY && !first; d = addDays(d, 1)) {
    const b = await has("bid", d);
    const a = b > 0 ? await has("ask", d) : 0;
    if (b > 0 || a > 0) console.log(`  ${d} (${WEEKDAY_NAMES[weekday(d)]}): bid ${b} ask ${a}`);
    if (b > 0 && a > 0) first = d;
  }
  console.log(`FIRST GMO 1-minute day file with both sides: ${first}`);
  if (!first) {
    console.log("NO FIRST DAY FOUND");
    Deno.exit(1);
  }
  // the days scanned before it read no bid bar: at least 14 of them, or an earlier file could have been missed
  const zeros = Math.round((utcOf(first) - utcOf(scanFrom)) / DAY);
  console.log(`  days scanned before it with no bid bar: ${zeros} (from ${scanFrom})`);
  if (zeros < 14) {
    console.log("FEWER THAN 14 EMPTY DAYS BEFORE THE FIRST DAY: scan further back");
    Deno.exit(1);
  }
  {
    const end = Deno.env.get("END") ?? "2026-10-02";
    const measured = yearsOf(first, end);
    const p2 = checkHolidays(list, measured);
    console.log(`holiday list, the measured years ${measured.join(", ")}: ${p2.length ? "PROBLEMS " + p2.join("; ") : "16 to 21 each, known days present"}`);
    const cal = buildCalendar(addDays(first, 1), end, list.days);
    reportCalendar(cal, list.days);
    if (p2.length) Deno.exit(1);
  }
  console.log(`requests ${requests}`);
}

function reportCalendar(cal: Calendar, holidays: Map<string, string>) {
  const main = cal.days.filter((d) => d.weekday !== 1 && d.kind !== "ambiguous");
  const byW = (kind: string) => [2, 3, 4, 5].map((w) => main.filter((d) => d.kind === kind && d.weekday === w).length);
  console.log(`calendar ${cal.days[0]?.date}..${cal.days.at(-1)?.date}: business days ${cal.days.length}; gotobi ${cal.days.filter((d) => d.kind === "gotobi").length} (Mondays ${cal.days.filter((d) => d.kind === "gotobi" && d.weekday === 1).length}), ambiguous ${cal.days.filter((d) => d.kind === "ambiguous").length}`);
  console.log(`  main (Tue-Fri): gotobi Tue/Wed/Thu/Fri ${byW("gotobi").join("/")}; control ${byW("control").join("/")}`);
  for (const x of cal.dropped) {
    const k = cal.days.find((d) => d.date === x.ambiguous)?.kind;
    console.log(`  no gotobi day for ${x.nominal} (${x.reason}); ${k === "ambiguous" ? `ambiguous ${x.ambiguous}` : `no ambiguous day (${x.ambiguous} is ${k ?? "outside the range"})`}`);
  }
  console.log(`  Mondays out of the main: gotobi ${cal.days.filter((d) => d.kind === "gotobi" && d.weekday === 1).length}, control ${cal.days.filter((d) => d.kind === "control" && d.weekday === 1).length}`);
  for (const d of cal.days.filter((d) => d.kind === "ambiguous")) console.log(`  ambiguous ${d.date} (${WEEKDAY_NAMES[d.weekday]})`);
  const g = main.filter((d) => d.kind === "gotobi");
  if (g.length) console.log(`  halves split at ${g[Math.floor(g.length / 2)].date} (the first gotobi day of the second half; ${Math.floor(g.length / 2)} before it)`);
  const hs = [...holidays.keys()].filter((d) => utcOf(d) >= utcOf(cal.days[0]?.date ?? "2100-01-01") && utcOf(d) <= utcOf(cal.days.at(-1)?.date ?? "1900-01-01"));
  console.log(`  holidays in it: ${hs.length}`);
}

// =================================================================================================
// made-up bars: GMO's week (Sunday 22:00 UTC to Friday 21:00 UTC), one bar a minute, both sides
interface Bump {
  from: number;
  to: number;
  by: number; // 0.001 yen
}
const makeFiles = (
  from: string,
  to: string,
  bumps: Bump[],
  opts: { spreadAt?: (t: number) => number; drop?: (t: number) => boolean; spikes?: Array<{ t: number; part: "hlc" | "all"; by: number }>; split?: number } = {},
) => {
  const base = 150_000;
  const files = new Map<string, { bid: Rows; ask: Rows }>();
  const spread = opts.spreadAt ?? ((t: number) => (((t / MIN) % 1440) === 14 * 60 ? 10 : 2)); // 1.0 sen at 14:00 UTC, else 0.2
  for (let t = utcOf(from) - DAY; t < utcOf(to) + DAY; t += MIN) {
    const w = new Date(t).getUTCDay();
    const hm = (t % DAY) / MIN;
    const open = (w >= 1 && w <= 4) || (w === 5 && hm < 21 * 60) || (w === 0 && hm >= 22 * 60);
    if (!open || opts.drop?.(t)) continue;
    let mid = base;
    for (const b of bumps) if (t >= b.from && t <= b.to) mid += b.by;
    const s = spread(t);
    let hi = 0;
    let lo = 0;
    let cl = 0;
    let op = 0;
    for (const sp of opts.spikes ?? []) {
      if (sp.t !== t) continue;
      hi += Math.max(sp.by, 0);
      lo += Math.min(sp.by, 0);
      cl += sp.by;
      if (sp.part === "all") op += sp.by;
    }
    const bo = mid - s / 2 + op;
    const bc = mid - s / 2 + cl;
    const row = (o: number, c: number, h: number, l: number) => ({ t, o, h: Math.max(o, c, h), l: Math.min(o, c, l), c });
    const bid = row(bo, bc, mid - s / 2 + hi, mid - s / 2 + lo);
    const ask = row(bo + s, bc + s, mid + s / 2 + hi, mid + s / 2 + lo);
    // the day file: GMO's day from `split` UTC (21:00 by default), or one file for all
    const key = opts.split === -1 ? "all" : dateOf(Math.floor((t + (24 * HOUR - (opts.split ?? 21) * HOUR)) / DAY) * DAY);
    if (!files.has(key)) files.set(key, { bid: [], ask: [] });
    files.get(key)!.bid.push(bid);
    files.get(key)!.ask.push(ask);
  }
  return files;
};
const loadFiles = (files: Map<string, { bid: Rows; ask: Rows }>, duplicate = false) => {
  const bid: SideBars = new Map();
  const ask: SideBars = new Map();
  for (const f of files.values()) {
    addFile(bid, f.bid);
    addFile(ask, f.ask);
    if (duplicate) {
      addFile(bid, f.bid);
      addFile(ask, f.ask);
    }
  }
  return { bid, ask, bars: joinSides(bid, ask) };
};

if (MODE === "synthetic") {
  const { list, hash, source } = await readHolidays();
  console.log(`holidays: ${source} rows ${list.rows} sha256 ${hash}`);
  const results: Array<{ name: string; ok: boolean; note: string }> = [];
  const check = (name: string, ok: boolean, note = "") => {
    results.push({ name, ok, note });
    console.log(`${ok ? "PASS" : "FAIL"} ${name}${note ? ` — ${note}` : ""}`);
  };

  // ---- the calendar's hand-made days ----
  const cal = buildCalendar("2023-10-30", "2026-10-02", list.days);
  const kindOf = (d: string) => cal.days.find((x) => x.date === d)?.kind ?? "not a business day";
  const expect: Array<[string, string]> = [
    ["2023-11-02", "ambiguous"], ["2023-11-03", "not a business day"],
    ["2024-02-22", "ambiguous"], ["2024-02-23", "not a business day"],
    ["2024-05-02", "ambiguous"], ["2024-05-03", "not a business day"],
    ["2024-12-30", "gotobi"],
    ["2024-07-12", "gotobi"], ["2025-05-02", "gotobi"], ["2025-09-12", "gotobi"], ["2026-07-17", "gotobi"],
    ["2026-03-19", "ambiguous"], ["2026-05-01", "ambiguous"],
    ["2025-11-25", "gotobi"], ["2024-03-01", "control"],
  ];
  for (const [d, k] of expect) check(`calendar ${d} is ${k}`, kindOf(d) === k, `got ${kindOf(d)}`);
  check("calendar 2025-01-05 gives no gotobi day", cal.dropped.some((x) => x.nominal === "2025-01-05"), "");
  check("calendar 2024-02 has no gotobi day for the 30th or the 29th", !cal.days.some((x) => x.date === "2024-02-29" && x.kind === "gotobi"));
  check("2025-09-12 trade times", new Date(entryAt("2025-09-12")).toISOString() === "2025-09-11T14:00:00.000Z" && new Date(exitAt("2025-09-12")).toISOString() === "2025-09-12T00:55:00.000Z");
  check("2024-03-01 enters 2024-02-29 23:00 JST", new Date(entryAt("2024-03-01")).toISOString() === "2024-02-29T14:00:00.000Z");
  // every Mon-Fri day exactly once: gotobi, control or ambiguous in the calendar, or left out with a reason
  const placed = new Map<string, number>();
  for (const d of cal.days) placed.set(d.date, (placed.get(d.date) ?? 0) + 1);
  let wrong = 0;
  let leftOut = 0;
  for (let d = "2023-10-30"; utcOf(d) <= utcOf("2026-10-02"); d = addDays(d, 1)) {
    if (weekday(d) === 0 || weekday(d) === 6) {
      if (placed.has(d)) wrong++;
      continue;
    }
    const n = placed.get(d) ?? 0;
    const reason = excludedWhy(d, list.days);
    if (n + (reason ? 1 : 0) !== 1) wrong++;
    if (reason) leftOut++;
  }
  check("every Mon-Fri day in exactly one of gotobi / control / ambiguous / left out with a reason", wrong === 0 && cal.days.every((d) => ["gotobi", "control", "ambiguous"].includes(d.kind)), `${cal.days.length} in the calendar, ${leftOut} left out, ${wrong} wrong`);
  // ⑨ the hourly table's times
  check("⑨ hourly entries: 0-9 on the day, 22 and 23 the evening before",
    new Date(hourEntryAt("2025-09-12", 0)).toISOString() === "2025-09-11T15:00:00.000Z" &&
      new Date(hourEntryAt("2025-09-12", 9)).toISOString() === "2025-09-12T00:00:00.000Z" &&
      new Date(hourEntryAt("2025-09-12", 22)).toISOString() === "2025-09-11T13:00:00.000Z" &&
      new Date(hourEntryAt("2025-09-12", 23)).toISOString() === "2025-09-11T14:00:00.000Z");

  // ---- the bars' handling, on three months of made-up bars ----
  const span = buildCalendar("2025-07-01", "2025-09-30", list.days);
  const mainDays = span.days.filter((d) => d.weekday !== 1 && d.kind !== "ambiguous");
  const gotobiDays = mainDays.filter((d) => d.kind === "gotobi").map((d) => d.date);
  const run = (files: Map<string, { bid: Rows; ask: Rows }>, duplicate = false) => {
    const { bid, ask, bars } = loadFiles(files, duplicate);
    const out = new Map<string, Trade>();
    for (const d of mainDays) {
      const r = tradeDay(d.date, bars, bid, ask, () => false);
      if (r.ok) out.set(d.date, r.trade);
    }
    return out;
  };
  const all = (m: Map<string, Trade>, f: (t: Trade) => boolean, days = mainDays.map((d) => d.date)) => days.every((d) => m.has(d) && f(m.get(d)!));
  const isG = (d: string) => gotobiDays.includes(d);
  const window = (d: string, shift = 0): Bump => ({ from: entryAt(d) + MIN + shift, to: exitAt(d) + shift, by: 50 });
  // ①
  const t1 = run(makeFiles("2025-07-01", "2025-09-30", []));
  check("① flat mid: every trade -0.6 sen, paid 0.6, no win", all(t1, (t) => t.pl === -6 && t.paid === 6), `${t1.size} trades`);
  // ②
  const t2 = run(makeFiles("2025-07-01", "2025-09-30", gotobiDays.map((d) => window(d))));
  check("② +5 sen on gotobi windows: gotobi +4.4, others -0.6", all(t2, (t) => t.pl === (isG(t.date) ? 44 : -6)));
  // ③ the next business day
  const after = buildCalendar("2025-07-01", "2025-10-31", list.days).days.map((y) => y.date);
  const next = gotobiDays.map((d) => after.find((x) => x > d)!);
  const t3 = run(makeFiles("2025-07-01", "2025-09-30", next.map((d) => window(d))));
  check("③ the bump on the next business day: gotobi -0.6", all(t3, (t) => t.pl === -6, gotobiDays));
  // ④ one day before
  const t4 = run(makeFiles("2025-07-01", "2025-09-30", gotobiDays.map((d) => window(d, -DAY))));
  check("④ the window a day early: gotobi -0.6", all(t4, (t) => t.pl === -6, gotobiDays));
  // ⑤ the window read as UTC: only JST 10:00-18:55 is bumped (a UTC reading sells at 09:55 UTC, inside it)
  const t5 = run(makeFiles("2025-07-01", "2025-09-30", gotobiDays.map((d) => ({ from: utcOf(d) + HOUR, to: utcOf(d) + 9 * HOUR + 55 * MIN, by: 50 }))));
  check("⑤ JST 10:00-18:55 bumped: gotobi -0.6", all(t5, (t) => t.pl === -6, gotobiDays));
  // ⑥ spikes
  const spikesOff = gotobiDays.flatMap((d) => [
    { t: entryAt(d) - MIN, part: "hlc" as const, by: 300 },
    { t: exitAt(d), part: "hlc" as const, by: 300 },
    { t: exitAt(d) + 5 * MIN, part: "all" as const, by: 300 },
  ]);
  const t6a = run(makeFiles("2025-07-01", "2025-09-30", [], { spikes: spikesOff }));
  check("⑥ spikes in the 22:59 bar and after the 9:55 open: unchanged", all(t6a, (t) => t.pl === -6));
  const t6b = run(makeFiles("2025-07-01", "2025-09-30", gotobiDays.map((d) => ({ from: entryAt(d) + MIN, to: exitAt(d), by: 30 })), { spikes: gotobiDays.map((d) => ({ t: entryAt(d), part: "hlc" as const, by: 30 })) }));
  check("⑥ a move after the 23:00 open: shows", all(t6b, (t) => t.pl === (isG(t.date) ? 24 : -6)));
  // ⑦ bars before 23:00 removed
  const t7 = run(makeFiles("2025-07-01", "2025-09-30", [], { drop: (t) => ((t % DAY) / MIN) >= 13 * 60 + 50 && ((t % DAY) / MIN) < 14 * 60 }));
  check("⑦ bars 22:50-22:59 removed: entry still 14:00 UTC", all(t7, (t) => (t.entryT % DAY) === 14 * HOUR && t.pl === -6));
  // ⑧ the files split differently, and duplicated
  const a8 = run(makeFiles("2025-07-01", "2025-09-30", gotobiDays.map((d) => window(d)), { split: 21 }));
  const b8 = run(makeFiles("2025-07-01", "2025-09-30", gotobiDays.map((d) => window(d)), { split: 22 }));
  const c8 = run(makeFiles("2025-07-01", "2025-09-30", gotobiDays.map((d) => window(d)), { split: -1 }), true);
  const same = (x: Map<string, Trade>, y: Map<string, Trade>) => x.size === y.size && [...x].every(([k, v]) => y.get(k)?.pl === v.pl);
  check("⑧ files split at 21:00 / 22:00 UTC / one file twice: the same", same(a8, b8) && same(a8, c8), `${a8.size}/${b8.size}/${c8.size}`);
  // fallbacks
  const target = gotobiDays[0];
  const tf1 = run(makeFiles("2025-07-01", "2025-09-30", [], { drop: (t) => t === exitAt(target) }));
  check("a missing 9:55 bar: sold at 9:56 (late 1)", tf1.get(target)?.exitLate === 1 && tf1.get(target)?.pl === -6);
  const tf2 = run(makeFiles("2025-07-01", "2025-09-30", [], { drop: (t) => t >= exitAt(target) && t < exitAt(target) + 60 * MIN }));
  check("no bar 9:55-10:54: no trade", !tf2.has(target));
  const tf3 = run(makeFiles("2025-07-01", "2025-09-30", [], { drop: (t) => t === entryAt(target) }));
  check("a missing 23:00 bar: bought at 23:01", tf3.get(target)?.entryT === entryAt(target) + MIN);
  // the spread's sides: the mid flat, asymmetric spreads
  const t9 = run(makeFiles("2025-07-01", "2025-09-30", [], { spreadAt: (t) => (((t / MIN) % 1440) === 14 * 60 ? 10 : ((t / MIN) % 1440) === 55 ? 2 : 4) }));
  check("the right sides: buy at the 23:00 ask, sell at the 9:55 bid", all(t9, (t) => t.pl === -6 && t.spreadIn === 10 && t.spreadOut === 2));

  // ---- the statistics, on made-up daily results ----
  const FIRST = Deno.env.get("FIRST") || "2023-10-27";
  const END = Deno.env.get("END") || "2026-10-02";
  const scal = buildCalendar(addDays(FIRST, 1), END, list.days).days.filter((d) => d.weekday !== 1 && d.kind !== "ambiguous");
  const nG = scal.filter((d) => d.kind === "gotobi").length;
  const nC = scal.length - nG;
  const friG = scal.filter((d) => d.kind === "gotobi" && d.weekday === 5).length / nG;
  const friC = scal.filter((d) => d.kind === "control" && d.weekday === 5).length / nC;
  console.log(`made-up results on the calendar ${FIRST}..${END}: gotobi ${nG}, control ${nC}; Friday share ${pctf(friG)} / ${pctf(friC)}`);
  const REPS = Number(Deno.env.get("BOOT") ?? "2000");
  const COST = 6; // the spread paid in the made-up results, in tenths of a sen (0.6 sen)
  // the jumps' variance: 4 a year (of 250 days) of 200-500 sen, E[J^2] = (500^3 - 200^3) / (3 x 300)
  const JUMP_VAR = (4 / 250) * ((500 ** 3 - 200 ** 3) / 900);
  // total: the whole noise scaled so its standard deviation is sigma (as built, sigma is the part before the jumps)
  const simulate = (seed: number, sigma: number, effect: (d: { kind: string; weekday: number }) => number, rough = true, total = false): Row[] => {
    const k = total ? sigma / Math.sqrt(sigma * sigma + JUMP_VAR) : 1;
    const r = rng(seed);
    const gauss = () => {
      const u = Math.max(r(), 1e-12);
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
    };
    // volatility in clusters (log AR(1) by day), scaled to unit mean square, and rare jumps
    const lv: number[] = [];
    let x = 0;
    for (let i = 0; i < scal.length; i++) {
      x = 0.97 * x + 0.25 * gauss();
      lv.push(rough ? x : 0);
    }
    const v = lv.map((z) => Math.exp(z));
    const norm = Math.sqrt(mean(v.map((z) => z * z)));
    return scal.map((d, i) => {
      let noise = sigma * (v[i] / norm) * gauss();
      if (rough && r() < 4 / 250) noise += (r() < 0.5 ? -1 : 1) * (200 + 300 * r());
      const y = -COST / 10 + effect(d) + k * noise;
      return { date: d.date, month: d.date.slice(0, 7), w: d.weekday, kind: d.kind as "gotobi" | "control", x: y };
    });
  };
  const sims = (_name: string, n: number, sigma: number, effect: (d: { kind: string; weekday: number }) => number, seed0: number, total = false) => {
    const out = [];
    for (let i = 0; i < n; i++) {
      const v = decide(simulate(seed0 + i, sigma, effect, true, total), REPS, 1_000_000 + seed0 + i, KOBE_DIFF);
      if (v) out.push(v);
    }
    return out;
  };
  const t0 = Date.now();
  const nulls = sims("null", Number(Deno.env.get("NULLS") ?? "1000"), 60, () => 0, 10_000);
  const truth = -COST / 10;
  const share = (xs: boolean[]) => xs.filter(Boolean).length / xs.length;
  // 'candidate' at most 2.5%, give or take the made-up runs' own noise: 3 standard errors, as the 2.9-7.1% band
  const candLine = (n: number) => 0.025 + 3 * Math.sqrt((0.025 * 0.975) / n);
  const cand0 = share(nulls.map((v) => v.candidate));
  check(`no effect: 'candidate' at most 2.5% (+3 se of ${nulls.length} runs: ${pctf(candLine(nulls.length))})`, cand0 <= candLine(nulls.length), pctf(cand0));
  // the t intervals are checked; the bootstraps' coverage is shown only (§8.96: narrower than 95% when the
  // volatility comes in spells, with 36 months; they only ever lower the low end and raise the high end used)
  const coverage = (vs: typeof nulls, label: string, checked: boolean) => {
    for (const k of ["t", "days", "months"] as const) {
      const dOut = share(vs.map((v) => v.matchedCis[k].lo > 0 || v.matchedCis[k].hi < 0));
      const gOut = share(vs.map((v) => v.gotobiCis[k].lo > truth || v.gotobiCis[k].hi < truth));
      if (checked && k === "t") {
        check(`${label}: the t interval of the matched difference leaves out 0 in 2.9-7.1%`, dOut >= 0.029 && dOut <= 0.071, pctf(dOut));
        check(`${label}: the t interval of the gotobi mean leaves out the truth in 2.9-7.1%`, gOut >= 0.029 && gOut <= 0.071, pctf(gOut));
      } else {
        console.log(`  (shown) ${label}: the ${k} interval leaves out the truth: matched difference ${pctf(dOut)}, gotobi mean ${pctf(gOut)}`);
      }
    }
  };
  coverage(nulls, "no effect", true);
  console.log(`  (${nulls.length} runs, ${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  // the same without the spells and the jumps (plain normal noise): where the bootstraps' code can be seen near 5%
  const plain = [];
  for (let i = 0; i < nulls.length; i++) {
    const v = decide(simulate(10_000 + i, 60, () => 0, false), REPS, 1_000_000 + 10_000 + i, KOBE_DIFF);
    if (v) plain.push(v);
  }
  coverage(plain, "no effect, plain normal noise", false);
  const N2 = Number(Deno.env.get("NEFFECT") ?? "200");
  const up = sims("all +3", N2, 60, () => 3, 20_000);
  check(`all days +3: 'candidate' at most 2.5% (+3 se of ${up.length} runs: ${pctf(candLine(up.length))})`, share(up.map((v) => v.candidate)) <= candLine(up.length), pctf(share(up.map((v) => v.candidate))));
  // Friday +10 on the null runs' own seeds, as many runs: at 200 runs the ±1 below is only ~1.8 standard errors
  const fri = sims("Friday +10", nulls.length, 60, (d) => (d.weekday === 5 ? 10 : 0), 10_000);
  check(`Friday +10: 'candidate' at most 2.5% (+3 se of ${fri.length} runs: ${pctf(candLine(fri.length))})`, share(fri.map((v) => v.candidate)) <= candLine(fri.length), pctf(share(fri.map((v) => v.candidate))));
  // paired: the same seed with and without an effect, so the noise cancels and the estimators' answer is exact
  const pointOf = (rows: Row[]) => {
    const g = rows.filter((x) => x.kind === "gotobi");
    const c = rows.filter((x) => x.kind === "control");
    return { matched: matchedDiff(g, c)!.diff, plain: mean(g.map((x) => x.x)) - mean(c.map((x) => x.x)) };
  };
  const paired = (effect: (d: { kind: string; weekday: number }) => number, want: { matched: number; plain: number }) => {
    let worst = 0;
    for (let i = 0; i < 200; i++) {
      const a = pointOf(simulate(10_000 + i, 60, () => 0));
      const b = pointOf(simulate(10_000 + i, 60, effect));
      worst = Math.max(worst, Math.abs(b.matched - a.matched - want.matched), Math.abs(b.plain - a.plain - want.plain));
    }
    return worst;
  };
  const pf = paired((d) => (d.weekday === 5 ? 10 : 0), { matched: 0, plain: (friG - friC) * 10 });
  check("paired, Friday +10: matched moves by exactly 0, plain by exactly the Friday shares' difference x10", pf < 1e-9, `largest miss ${pf.toExponential(1)}`);
  for (const eff of [5, 10, 20]) {
    const pe = paired((d) => (d.kind === "gotobi" ? eff : 0), { matched: eff, plain: eff });
    check(`paired, gotobi +${eff}: both differences move by exactly ${eff}`, pe < 1e-9, `largest miss ${pe.toExponential(1)}`);
  }
  const pk = paired((d) => (d.kind === "gotobi" ? 8.3 : -0.7), { matched: 9, plain: 9 });
  check("paired, Kobe's shape: both differences move by exactly 9", pk < 1e-9, `largest miss ${pk.toExponential(1)}`);
  const mFri = mean(fri.map((v) => v.matched));
  const pFri = mean(fri.map((v) => v.plain));
  check("Friday +10: matched difference 0±1", Math.abs(mFri) <= 1, fmt(mFri));
  check(`Friday +10: plain difference (${fmt(friG - friC, 3)}×10)±1`, Math.abs(pFri - (friG - friC) * 10) <= 1, fmt(pFri));
  // the standard deviation of a made-up day's result, within a run, averaged over 200 runs
  const sdOf = (sigma: number, total: boolean) =>
    mean(Array.from({ length: 200 }, (_, i) => Math.sqrt(variance(simulate(90_000 + i, sigma, () => 0, true, total).map((r) => r.x)))));
  for (const total of [false, true]) {
    console.log(total
      ? "power table B, the whole noise (spells and jumps) scaled to the sd named (share of runs reading 'candidate'; mean matched estimate):"
      : "power table A, as §8.96 built it: sigma is the part before the jumps (share of runs reading 'candidate'; mean matched estimate):");
    console.log("  sigma (sd measured) | +5 | +10 | +20 | Kobe (+8.3 / -0.7)");
    for (const sigma of [50, 60, 70]) {
      const cells: string[] = [];
      const tag = `${total ? "B" : "A"} sigma ${sigma}`;
      for (const [i, eff] of [5, 10, 20].entries()) {
        const s = sims(`+${eff}`, N2, sigma, (d) => (d.kind === "gotobi" ? eff : 0), 40_000 + sigma * 1000 + i * 300 + (total ? 500_000 : 0), total);
        const m = mean(s.map((v) => v.matched));
        check(`${tag}, +${eff}: matched estimate within ±2`, Math.abs(m - eff) <= 2, fmt(m));
        cells.push(`${pctf(share(s.map((v) => v.candidate)))} (${fmt(m, 1)})`);
      }
      const k = sims("Kobe", N2, sigma, (d) => (d.kind === "gotobi" ? 8.3 : -0.7), 50_000 + sigma * 1000 + (total ? 500_000 : 0), total);
      const km = mean(k.map((v) => v.matched));
      check(`${tag}, Kobe's shape: matched estimate within ±2 of 9.0`, Math.abs(km - 9) <= 2, fmt(km));
      cells.push(`${pctf(share(k.map((v) => v.candidate)))} (${fmt(km, 1)})`);
      console.log(`  ${sigma} (${fmt(sdOf(sigma, total), 1)}) | ${cells.join(" | ")}`);
    }
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length} checks, ${failed.length} failed${failed.length ? ": " + failed.map((f) => f.name).join("; ") : ""}`);
  if (failed.length) Deno.exit(1);
}

// =================================================================================================
if (MODE === "real") {
  const FIRST = Deno.env.get("FIRST");
  const END = Deno.env.get("END");
  if (!FIRST || !END) throw new Error("FIRST and END are required (docs §8.96)");
  const { list, hash, source } = await readHolidays();
  console.log(`holidays: ${source} rows ${list.rows} sha256 ${hash}`);
  const problems = checkHolidays(list, yearsOf(FIRST, END));
  if (problems.length) throw new Error(`holiday list: ${problems.join("; ")}`);
  const cal = buildCalendar(addDays(FIRST, 1), END, list.days);
  reportCalendar(cal, list.days);

  // the day files, FIRST to END
  const bid: SideBars = new Map();
  const ask: SideBars = new Map();
  const missing = new Set<string>();
  const weekend404: string[] = [];
  const fileLines: string[] = ["date\tside\tbars\tsha256"];
  for (let d = FIRST; utcOf(d) <= utcOf(END); d = addDays(d, 1)) {
    for (const side of ["bid", "ask"] as const) {
      const f = await readDayFile(side, d, true);
      fileLines.push(`${d}\t${side}\t${f.rows?.length ?? "404"}\t${f.hash}`);
      if (!f.rows) {
        // a Saturday or Sunday file holds no bar a trade uses (GMO's week ends Friday 21:00/22:00 UTC)
        if (weekday(d) === 0 || weekday(d) === 6) weekend404.push(`${side}|${d}`);
        else missing.add(`${side}|${d}`);
        continue;
      }
      addFile(side === "bid" ? bid : ask, f.rows);
    }
  }
  await Deno.writeTextFile(`${OUT}/gotobi-files.tsv`, fileLines.join("\n") + "\n");
  const bars = joinSides(bid, ask);
  const missingAt = (t: number) => missing.has(`bid|${fileKeyOf(t)}`) || missing.has(`ask|${fileKeyOf(t)}`);
  console.log(`bars: bid ${bid.size}, ask ${ask.size}, both ${bars.size}; Monday-Friday day files missing (404): ${[...missing].join(" ") || "none"}; Saturday/Sunday 404s: ${weekend404.length}; requests ${requests}`);

  // gaps inside trading hours (Monday 08:00 JST to Saturday 05:00 JST) over the files read, before any result
  let gaps = 0;
  const gapDays = new Map<string, number>();
  for (let t = utcOf(FIRST) - 3 * HOUR; t < utcOf(END) + 21 * HOUR; t += MIN) {
    const w = new Date(t).getUTCDay();
    const hm = (t % DAY) / MIN;
    const open = (w >= 1 && w <= 4) || (w === 5 && hm < 20 * 60) || (w === 0 && hm >= 23 * 60);
    if (!open || bars.has(t)) continue;
    gaps++;
    const k = fileKeyOf(t);
    gapDays.set(k, (gapDays.get(k) ?? 0) + 1);
  }
  const bigGaps = [...gapDays].filter(([, n]) => n >= 30).sort();
  console.log(`minute bars missing in trading hours (Mon 08:00 JST to Sat 05:00 JST): ${gaps}; days missing 30+: ${bigGaps.map(([d, n]) => `${d}:${n}`).join(" ") || "none"}`);

  // holidays Monday to Thursday (their 23:00 JST is a trade's entry): is there a bar?
  const hs = [...list.days.keys()].filter((d) => utcOf(d) >= utcOf(FIRST) && utcOf(d) <= utcOf(END) && weekday(d) >= 1 && weekday(d) <= 4).sort();
  console.log(`Monday-Thursday holidays with a usable 23:00 JST bar: ${hs.filter((d) => usable(bars, utcOf(d) + 14 * HOUR)).length} of ${hs.length} (without: ${hs.filter((d) => !usable(bars, utcOf(d) + 14 * HOUR)).join(" ") || "none"})`);

  // the trades: every Monday-Friday day, in one of the calendar's kinds or left out with a reason
  type Done = { day: (typeof cal.days)[number]; trade: Trade };
  const byDate = new Map(cal.days.map((d) => [d.date, d]));
  const done: Done[] = [];
  const excluded: Array<{ date: string; kind: string; leg: string; reason: string }> = [];
  const csv: string[] = ["date,weekday,kind,why,entry_utc,buy,exit_utc,sell,exit_late_min,pl_sen,pl_mid_sen,spread_in_sen,spread_out_sen,mae_sen"];
  for (let d = addDays(FIRST, 1); utcOf(d) <= utcOf(END); d = addDays(d, 1)) {
    const wd = weekday(d);
    if (wd === 0 || wd === 6) continue;
    const day = byDate.get(d);
    if (!day) {
      csv.push(`${d},${WEEKDAY_NAMES[wd]},not a business day,${excludedWhy(d, list.days) ?? "?"},,,,,,,,,,`);
      continue;
    }
    if (day.kind === "ambiguous") {
      csv.push(`${day.date},${WEEKDAY_NAMES[day.weekday]},ambiguous,,,,,,,,,,,`);
      continue;
    }
    if (day.weekday === 1) {
      csv.push(`${day.date},${WEEKDAY_NAMES[day.weekday]},${day.kind},Monday (out of the main),,,,,,,,,,`);
      continue;
    }
    const r = tradeDay(day.date, bars, bid, ask, missingAt);
    if (!r.ok) {
      excluded.push({ date: day.date, kind: day.kind, leg: r.leg, reason: r.reason });
      csv.push(`${day.date},${WEEKDAY_NAMES[day.weekday]},${day.kind},${r.leg}: ${r.reason},,,,,,,,,,`);
      continue;
    }
    const t = r.trade;
    done.push({ day, trade: t });
    csv.push([day.date, WEEKDAY_NAMES[day.weekday], day.kind, day.why ?? "", new Date(t.entryT).toISOString(), (t.buy / 1000).toFixed(3),
      new Date(t.exitT).toISOString(), (t.sell / 1000).toFixed(3), t.exitLate, fmt(sen(t.pl), 1), fmt(sen(t.plMid), 2), fmt(sen(t.spreadIn), 1), fmt(sen(t.spreadOut), 1), fmt(sen(t.mae), 1)].join(","));
  }
  await Deno.writeTextFile(`${OUT}/gotobi-days.csv`, csv.join("\n") + "\n");
  console.log(`main trades: gotobi ${done.filter((x) => x.day.kind === "gotobi").length}, control ${done.filter((x) => x.day.kind === "control").length}; left out ${excluded.length}`);
  for (const kind of ["gotobi", "control"]) {
    for (const reason of ["market shut", "gap", "one side or ask below bid", "no file"]) {
      const xs = excluded.filter((e) => e.kind === kind && e.reason === reason);
      console.log(`  out, ${kind}, ${reason}: ${xs.length}${xs.length ? ` (${xs.map((e) => `${e.date} ${e.leg}`).join(", ")})` : ""}`);
    }
  }
  const late = done.filter((x) => x.trade.exitLate > 0);
  console.log(`sold after 9:55 (no usable 9:55 bar): ${late.length} (${late.map((x) => `${x.day.date}+${x.trade.exitLate}m`).join(" ") || "none"})`);

  // every group's win rate of 65% or more, description tables included (look-ahead to be checked before reporting)
  const winList: string[] = [];
  const noteRate = (label: string, xs: number[]) => {
    if (xs.length && xs.filter((z) => z > 0).length / xs.length >= 0.65) winList.push(`${label}: ${pctf(xs.filter((z) => z > 0).length / xs.length)} of ${xs.length}${xs.length < 100 ? " (fewer than 100)" : ""}`);
  };
  const plOf = (xs: Done[]) => xs.map((x) => sen(x.trade.pl));
  const rowsOf = (xs: Done[], f: (x: Done) => number): Row[] =>
    xs.map((x) => ({ date: x.day.date, month: x.day.date.slice(0, 7), w: x.day.weekday, kind: x.day.kind as "gotobi" | "control", x: f(x) }));
  /** the gotobi mean and the matched difference with their t intervals, for a description line */
  const brief = (rows: Row[]) => {
    const g = rows.filter((r) => r.kind === "gotobi").map((r) => r.x);
    const c = rows.filter((r) => r.kind === "control").map((r) => r.x);
    const m = matchedDiff(rows.filter((r) => r.kind === "gotobi"), rows.filter((r) => r.kind === "control"));
    return `gotobi ${g.length} mean ${fmt(g.length ? mean(g) : NaN)} ${g.length > 2 ? ci(tMeanCi(g)) : "-"}, control ${c.length} mean ${fmt(c.length ? mean(c) : NaN)} ${c.length > 2 ? ci(tMeanCi(c)) : "-"}, matched difference ${fmt(m?.diff ?? NaN)} ${m ? ci(matchedCi(m)) : "-"}`;
  };
  const describe = (label: string, xs: Done[]) => {
    const pl = plOf(xs);
    noteRate(label, pl);
    if (pl.length < 2) {
      console.log(`${label}: n ${pl.length}`);
      return;
    }
    const wins = pl.filter((v) => v > 0);
    const losses = pl.filter((v) => v <= 0);
    const zero = pl.filter((v) => v === 0).length;
    const w = wilsonCi(wins.length, pl.length);
    const avgWin = wins.length ? mean(wins) : 0;
    const avgLoss = losses.length ? mean(losses) : 0;
    const be = avgWin - avgLoss > 0 ? -avgLoss / (avgWin - avgLoss) : NaN;
    const path = pathStats(pl);
    const worst = xs.reduce((a, b) => (b.trade.pl < a.trade.pl ? b : a));
    const maeWorst = xs.reduce((a, b) => (b.trade.mae < a.trade.mae ? b : a));
    console.log(`${label}: n ${pl.length}, won ${wins.length} (${pctf(wins.length / pl.length)} ${ci({ lo: w.lo * 100, hi: w.hi * 100 }, 1)}%, zero ${zero}); per trade mean ${fmt(mean(pl))} sen ${ci(tMeanCi(pl))}, median ${fmt(quantile(pl, 0.5))}; ` +
      `5/25/75/95% ${[0.05, 0.25, 0.75, 0.95].map((q) => fmt(quantile(pl, q), 1)).join("/")}; avg win ${fmt(avgWin)} avg loss ${fmt(avgLoss)} break-even win rate ${pctf(be)}; ` +
      `per 10,000 units ${fmt(mean(pl) * 100, 0)} yen; paid spread median ${fmt(quantile(xs.map((x) => sen(x.trade.paid)), 0.5))} (23:00 ${fmt(quantile(xs.map((x) => sen(x.trade.spreadIn)), 0.5))}, 9:55 ${fmt(quantile(xs.map((x) => sen(x.trade.spreadOut)), 0.5))}); ` +
      `cumulative ${fmt(pl.reduce((a, b) => a + b, 0), 1)} sen, max drawdown ${fmt(path.maxDrawdown, 1)}, longest losing run ${path.longestLosing}, worst ${fmt(sen(worst.trade.pl), 1)} (${worst.day.date}); ` +
      `adverse move median ${fmt(quantile(xs.map((x) => sen(x.trade.mae)), 0.5), 1)} worst ${fmt(sen(maeWorst.trade.mae), 1)} (${maeWorst.day.date} ${new Date(maeWorst.trade.maeAt).toISOString().slice(11, 16)} UTC; mid ${fmt(quantile(xs.map((x) => sen(x.trade.maeMid)), 0.5), 1)}, leaving out 05-07 JST ${fmt(quantile(xs.map((x) => sen(x.trade.maeNoRoll)), 0.5), 1)}); ` +
      `mid to mid ${fmt(mean(xs.map((x) => sen(x.trade.plMid))))} sen, less a fixed 2 sen ${fmt(mean(xs.map((x) => sen(x.trade.plMid))) - 2)}`);
  };
  const G = done.filter((x) => x.day.kind === "gotobi");
  const C = done.filter((x) => x.day.kind === "control");
  console.log("\n== the main trade (buy 23:00 JST the evening before at the ask, sell 9:55 JST at the bid), Tue-Fri");
  describe("gotobi", G);
  describe("control", C);
  const v = decide(rowsOf(done, (x) => sen(x.trade.pl)), 10_000, 186, KOBE_DIFF);
  if (v) {
    console.log(`gotobi mean ${fmt(v.gotobiMean)} sen: t ${ci(v.gotobiCis.t)} days ${ci(v.gotobiCis.days)} months ${ci(v.gotobiCis.months)} -> lowest low ${fmt(v.gotobiLow)}`);
    console.log(`weekday-matched difference ${fmt(v.matched)} sen: t ${ci(v.matchedCis.t)} days ${ci(v.matchedCis.days)} months ${ci(v.matchedCis.months)} -> lowest low ${fmt(v.matchedLow)}, highest high ${fmt(v.matchedHigh)}`);
    console.log("  (the days and months bootstraps came out narrower than 95% on the made-up results, §8.96; the decision takes the lowest low and the highest high)");
    const wc = welchCi(plOf(G), plOf(C));
    console.log(`plain difference (Kobe's way, not weekday-matched) ${fmt(wc.diff)} sen ${ci(wc)}`);
    console.log(`smallest difference findable (2.8 x the widest interval's se): ${fmt(v.minDetectable)} sen`);
    console.log(`VERDICT: ${v.candidate ? "(a) a candidate" : v.reading === "b" ? "(b) Kobe's size (+9 sen) not seen in this period" : "(c) too few to decide"}`);
    console.log(`  if the extra cost a trade (Rakuten's spread, slippage) is below ${fmt(v.gotobiLow)} sen, the gotobi mean stays above 0 at the interval's low end`);
  }
  console.log(`standard deviation of a day's result: gotobi ${fmt(Math.sqrt(variance(plOf(G))))}, control ${fmt(Math.sqrt(variance(plOf(C))))} sen (the power tables of §8.96 are by this)`);

  console.log(`\n== description (not used to decide; each interval is a single 95% interval unless named)`);
  // sold at 9:55 exactly
  const onTime = done.filter((x) => x.trade.exitLate === 0);
  describe("gotobi, sold at 9:55 exactly", onTime.filter((x) => x.day.kind === "gotobi"));
  describe("control, sold at 9:55 exactly", onTime.filter((x) => x.day.kind === "control"));
  console.log(`sold at 9:55 exactly: ${brief(rowsOf(onTime, (x) => sen(x.trade.pl)))}`);
  // weekday cells
  console.log("by weekday, 4 rows looked at (gotobi n / mean | control n / mean | difference and its Welch interval):");
  for (const w of [2, 3, 4, 5]) {
    const g = plOf(G.filter((x) => x.day.weekday === w));
    const c = plOf(C.filter((x) => x.day.weekday === w));
    noteRate(`${WEEKDAY_NAMES[w]} gotobi`, g);
    noteRate(`${WEEKDAY_NAMES[w]} control`, c);
    const wc = g.length > 1 && c.length > 1 ? welchCi(g, c) : null;
    console.log(`  ${WEEKDAY_NAMES[w]}: ${g.length} / ${fmt(g.length ? mean(g) : NaN)} | ${c.length} / ${fmt(c.length ? mean(c) : NaN)} | ${fmt(wc?.diff ?? NaN)} ${wc ? ci(wc) : "-"}`);
  }
  // halves and years
  const mainG = cal.days.filter((d) => d.kind === "gotobi" && d.weekday !== 1);
  const split = mainG[Math.floor(mainG.length / 2)]?.date ?? END;
  for (const [name, part] of [["first half", (d: string) => d < split], ["second half", (d: string) => d >= split]] as const) {
    const sub = done.filter((x) => part(x.day.date));
    noteRate(`${name} gotobi`, plOf(sub.filter((x) => x.day.kind === "gotobi")));
    noteRate(`${name} control`, plOf(sub.filter((x) => x.day.kind === "control")));
    console.log(`${name} (split ${split}): ${brief(rowsOf(sub, (x) => sen(x.trade.pl)))}`);
  }
  for (const y of [...new Set(done.map((x) => x.day.date.slice(0, 4)))].sort()) {
    const sub = done.filter((x) => x.day.date.startsWith(y));
    const g = plOf(sub.filter((x) => x.day.kind === "gotobi"));
    const c = plOf(sub.filter((x) => x.day.kind === "control"));
    noteRate(`${y} gotobi`, g);
    noteRate(`${y} control`, c);
    console.log(`  ${y}: gotobi won ${g.length ? pctf(g.filter((z) => z > 0).length / g.length) : "-"}, control won ${c.length ? pctf(c.filter((z) => z > 0).length / c.length) : "-"}; ${brief(rowsOf(sub, (x) => sen(x.trade.pl)))}`);
  }
  // the hourly table (Kobe's table 11): a single 95% interval and Bonferroni over its 12 rows
  const bonf = (xs: number[], k: number) => {
    const m = mean(xs);
    const se = Math.sqrt(variance(xs) / xs.length);
    const q = tQuantile(1 - 0.025 / k, xs.length - 1);
    return { lo: m - q * se, hi: m + q * se };
  };
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  console.log("entry hour (JST) -> 9:55, 12 rows looked at: gotobi n / mean / cumulative / 95% / Bonferroni | control n / mean / cumulative / 95% | paid spread median (gotobi; half the entry spread + half the 9:55 spread)");
  for (const h of [22, 23, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9]) {
    const gx: number[] = [];
    const cx: number[] = [];
    const sp: number[] = [];
    for (const x of [...G, ...C]) {
      const at = hourEntryAt(x.day.date, h);
      const p = legs(bars, at, exitAt(x.day.date), "buy");
      if (p === null) continue;
      (x.day.kind === "gotobi" ? gx : cx).push(sen(p));
      if (x.day.kind === "gotobi") {
        const b = usable(bars, at)!;
        const e = usable(bars, exitAt(x.day.date))!;
        sp.push(sen((b.ao - b.bo) / 2 + (e.ao - e.bo) / 2));
      }
    }
    noteRate(`hour ${h} gotobi`, gx);
    noteRate(`hour ${h} control`, cx);
    console.log(`  ${String(h).padStart(2)}:00${h === 6 || h === 7 ? " (day roll)" : ""} | ${gx.length} / ${fmt(gx.length ? mean(gx) : NaN)} / ${fmt(sum(gx), 0)} / ${gx.length > 2 ? ci(tMeanCi(gx)) : "-"} / ${gx.length > 2 ? ci(bonf(gx, 12)) : "-"} | ${cx.length} / ${fmt(cx.length ? mean(cx) : NaN)} / ${fmt(sum(cx), 0)} / ${cx.length > 2 ? ci(tMeanCi(cx)) : "-"} | ${fmt(sp.length ? quantile(sp, 0.5) : NaN)}`);
  }
  console.log("Kobe's trade B (sell 9:55 at the bid, buy back at h:00 JST at the ask), 12 rows looked at: gotobi n / mean / 95% / Bonferroni | control n / mean / 95%");
  for (let h = 11; h <= 22; h++) {
    const gx: number[] = [];
    const cx: number[] = [];
    for (const x of [...G, ...C]) {
      const p = legs(bars, exitAt(x.day.date), utcOf(x.day.date) + (h - 9) * HOUR, "sell");
      if (p !== null) (x.day.kind === "gotobi" ? gx : cx).push(sen(p));
    }
    noteRate(`trade B ${h}:00 gotobi`, gx);
    noteRate(`trade B ${h}:00 control`, cx);
    console.log(`  ${h}:00 | ${gx.length} / ${fmt(gx.length ? mean(gx) : NaN)} / ${gx.length > 2 ? ci(tMeanCi(gx)) : "-"} / ${gx.length > 2 ? ci(bonf(gx, 12)) : "-"} | ${cx.length} / ${fmt(cx.length ? mean(cx) : NaN)} / ${cx.length > 2 ? ci(tMeanCi(cx)) : "-"}`);
  }
  // Friday gotobi only
  const fg = plOf(G.filter((x) => x.day.weekday === 5));
  const fc = plOf(C.filter((x) => x.day.weekday === 5));
  noteRate("Friday gotobi", fg);
  noteRate("Friday control", fc);
  if (fg.length > 2 && fc.length > 2) console.log(`Friday gotobi only: ${fg.length}, won ${pctf(fg.filter((z) => z > 0).length / fg.length)}, mean ${fmt(mean(fg))} ${ci(tMeanCi(fg))} vs Friday control ${fc.length} mean ${fmt(mean(fc))}: difference ${ci(welchCi(fg, fc))}`);
  // Mondays, bought at 08:00 JST (Sunday 23:00 UTC), alone and added to the main as a fifth weekday
  const monRows: Row[] = [];
  for (const d of cal.days.filter((x) => x.weekday === 1 && x.kind !== "ambiguous")) {
    const p = legs(bars, utcOf(d.date) - HOUR, exitAt(d.date), "buy");
    if (p !== null) monRows.push({ date: d.date, month: d.date.slice(0, 7), w: 1, kind: d.kind as "gotobi" | "control", x: sen(p) });
  }
  const mg = monRows.filter((r) => r.kind === "gotobi").map((r) => r.x);
  const mc = monRows.filter((r) => r.kind === "control").map((r) => r.x);
  noteRate("Monday gotobi", mg);
  noteRate("Monday control", mc);
  console.log(`Mondays alone (bought 08:00 JST): gotobi ${mg.length} mean ${fmt(mg.length ? mean(mg) : NaN)} ${mg.length > 2 ? ci(tMeanCi(mg)) : "-"}; control ${mc.length} mean ${fmt(mc.length ? mean(mc) : NaN)} ${mc.length > 2 ? ci(tMeanCi(mc)) : "-"}`);
  console.log(`with the Mondays added (Mon-Fri, five weekday cells): ${brief([...rowsOf(done, (x) => sen(x.trade.pl)), ...monRows])}`);
  // the month's last business day left out of the control (the month's end from a calendar to the end of END's month)
  const endY = Number(END.slice(0, 4));
  const endM = Number(END.slice(5, 7));
  const monthEnd = dateOf(Date.UTC(endY, endM, 0));
  const lastBiz = new Set<string>();
  const byMonth = new Map<string, string>();
  for (const d of buildCalendar(addDays(FIRST, 1), monthEnd, list.days).days) byMonth.set(d.date.slice(0, 7), d.date);
  for (const d of byMonth.values()) lastBiz.add(d);
  const cNoEnd = done.filter((x) => !(x.day.kind === "control" && lastBiz.has(x.day.date)));
  noteRate("control without month-end", plOf(cNoEnd.filter((x) => x.day.kind === "control")));
  console.log(`control without the month's last business day (${done.filter((x) => x.day.kind === "control" && lastBiz.has(x.day.date)).length} left out): ${brief(rowsOf(cNoEnd, (x) => sen(x.trade.pl)))}`);
  // fake gotobi: the business day after each gotobi day
  const nextOf = new Set<string>();
  for (const d of cal.days.filter((x) => x.kind === "gotobi")) {
    const i = cal.days.findIndex((x) => x.date === d.date);
    if (cal.days[i + 1]) nextOf.add(cal.days[i + 1].date);
  }
  const fake = C.map((x) => ({ ...x, day: { ...x.day, kind: (nextOf.has(x.day.date) ? "gotobi" : "control") as "gotobi" | "control" } }));
  noteRate("fake gotobi", plOf(fake.filter((x) => x.day.kind === "gotobi")));
  console.log(`fake gotobi (the business day after, among the control days; expected near 0): ${brief(rowsOf(fake as Done[], (x) => sen(x.trade.pl)))}`);
  // a minute late
  const lateRows: Done[] = [];
  for (const x of done) {
    const p = legs(bars, entryAt(x.day.date) + MIN, exitAt(x.day.date) + MIN, "buy");
    if (p !== null) lateRows.push({ day: x.day, trade: { ...x.trade, pl: p } });
  }
  noteRate("a minute late gotobi", plOf(lateRows.filter((x) => x.day.kind === "gotobi")));
  noteRate("a minute late control", plOf(lateRows.filter((x) => x.day.kind === "control")));
  console.log(`a minute late (23:01 -> 9:56): ${brief(rowsOf(lateRows, (x) => sen(x.trade.pl)))}`);
  // spreads by US daylight saving (second Sunday of March to first Sunday of November, by the date)
  const usDst = (date: string) => {
    const y = Number(date.slice(0, 4));
    const marchSecondSun = (() => { let d = `${y}-03-01`; let n = 0; while (true) { if (weekday(d) === 0 && ++n === 2) return d; d = addDays(d, 1); } })();
    const novFirstSun = (() => { let d = `${y}-11-01`; while (weekday(d) !== 0) d = addDays(d, 1); return d; })();
    return date >= marchSecondSun && date < novFirstSun;
  };
  for (const [name, f] of [["US summer time", (d: string) => usDst(d)], ["US winter time", (d: string) => !usDst(d)]] as const) {
    const xs = done.filter((x) => f(x.day.date));
    if (xs.length) console.log(`${name}: 23:00 spread median ${fmt(quantile(xs.map((x) => sen(x.trade.spreadIn)), 0.5))} p95 ${fmt(quantile(xs.map((x) => sen(x.trade.spreadIn)), 0.95))}; 9:55 median ${fmt(quantile(xs.map((x) => sen(x.trade.spreadOut)), 0.5))} p95 ${fmt(quantile(xs.map((x) => sen(x.trade.spreadOut)), 0.95))}`);
  }
  // extremes, trimmed, interventions, year-end, spreads, autocorrelation
  for (const [name, xs] of [["gotobi", G], ["control", C]] as const) {
    const s = [...xs].sort((a, b) => b.trade.pl - a.trade.pl);
    console.log(`${name} best 5: ${s.slice(0, 5).map((x) => `${x.day.date} ${fmt(sen(x.trade.pl), 1)}`).join(", ")}; worst 5: ${s.slice(-5).map((x) => `${x.day.date} ${fmt(sen(x.trade.pl), 1)}`).join(", ")}`);
    const pl = plOf(xs).sort((a, b) => a - b);
    const k = Math.ceil(pl.length * 0.01);
    if (pl.length > 2 * k) console.log(`  ${name} mean leaving out the top and bottom 1% (${k} each): ${fmt(mean(pl.slice(k, pl.length - k)))}`);
  }
  // the Ministry of Finance's published intervention days (2024; later years not checked here)
  const INTERVENTIONS = ["2024-04-29", "2024-05-01", "2024-07-11", "2024-07-12"];
  const entryDate = (x: Done) => dateOf(Math.floor((x.trade.entryT + 9 * HOUR) / DAY) * DAY);
  const touches = (x: Done) => INTERVENTIONS.some((d) => d === entryDate(x) || d === x.day.date);
  const noInt = done.filter((x) => !touches(x));
  noteRate("without intervention days gotobi", plOf(noInt.filter((x) => x.day.kind === "gotobi")));
  noteRate("without intervention days control", plOf(noInt.filter((x) => x.day.kind === "control")));
  console.log(`leaving out trades touching the 2024 intervention days (${done.filter(touches).map((x) => x.day.date).join(" ") || "none"}): ${brief(rowsOf(noInt, (x) => sen(x.trade.pl)))}`);
  const inYearEnd = (date: string) => { const md = date.slice(5); return (md >= "12-24" && md <= "12-27") || md >= "12-30" || md <= "01-05"; };
  const ye = done.filter((x) => inYearEnd(x.day.date) || inYearEnd(entryDate(x)));
  console.log(`year-end trades, entering or leaving 12/24-12/27 or 12/30-1/5 (kept): ${ye.map((x) => `${x.day.date} ${x.day.kind} ${fmt(sen(x.trade.pl), 1)}`).join(", ") || "none"}`);
  const sp = [...done].sort((a, b) => b.trade.paid - a.trade.paid).slice(0, 10);
  console.log(`largest spreads paid: ${sp.map((x) => `${x.day.date} ${fmt(sen(x.trade.paid), 1)}`).join(", ")}`);
  for (const [name, xs] of [["gotobi", G], ["control", C], ["all", done]] as const) {
    const pl = plOf([...xs].sort((a, b) => a.day.date.localeCompare(b.day.date)));
    console.log(`autocorrelation lag 1 (${name}): ${fmt(autocorr1(pl), 3)}, of the squares ${fmt(autocorr1(pl.map((z) => z * z)), 3)}`);
  }
  console.log(`\nwin rates of 65% or more (look-ahead to be checked before reporting): ${winList.length ? "\n  " + winList.join("\n  ") : "none"}`);
  const midG = G.length ? mean(G.map((x) => sen(x.trade.plMid))) : 0;
  if (midG >= 17) console.log(`LOOK-AHEAD CHECK NEEDED: gotobi mid-to-mid ${fmt(midG)} sen is 17 or more`);
  console.log(`requests ${requests}`);
}
