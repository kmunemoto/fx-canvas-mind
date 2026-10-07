// #206 (②, the look before the rule): how far back GMO's 15-minute and 5-minute day files go for the five
// pairs of the owner's 15-minute ULTRA emails — whether data from before 2024 (which no study in this repo has
// read: every one since #100 starts at 2024-01) could serve as data not yet seen. Read-only and reads no price:
// for each day it asks for, it counts the bars in GMO's answer (as research/min1-start.ts did for the 1-minute
// files, docs §8.102: 2023-10-27).
//
//   * the first weekday of each month from FROM_YEAR (2010) on, the bid side: the first month whose file has bars;
//   * then each day from 50 days before that month to 7 days into it, both sides: the first day with bars on both
//     is the pair's first day; at least 14 of the days scanned before it must have had no bid bar, or an earlier
//     file could have been missed (the run stops);
//   * and, beside it, the bars on both sides of the first weekday of each year from that year to 2024 (whether
//     the files run on without long holes is not judged here; only counts are told).
//
//   INTERVALS=15min,5min deno run --allow-net=forex-api.coin.z.com --allow-env research/gmo-start.ts

import { GMO_SYMBOLS, klineUrl } from "../supabase/functions/track-outcomes/quotes.ts";

const PAIRS = ["USD/JPY", "EUR/JPY", "AUD/JPY", "EUR/USD", "AUD/USD"];
const INTERVALS = (Deno.env.get("INTERVALS") ?? "15min,5min").split(",");
const FROM_YEAR = Number(Deno.env.get("FROM_YEAR") ?? "2010");
const DAY = 86_400_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const utcOf = (d: string) => Date.parse(`${d}T00:00:00Z`);
const dateOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const addDays = (d: string, n: number) => dateOf(utcOf(d) + n * DAY);
const weekday = (d: string) => new Date(utcOf(d)).getUTCDay();
const NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const firstWeekday = (d: string) => {
  let x = d;
  while (weekday(x) === 0 || weekday(x) === 6) x = addDays(x, 1);
  return x;
};

let requests = 0;
const getText = async (url: string): Promise<string | null> => {
  for (let attempt = 1; ; attempt++) {
    await sleep(80);
    requests++;
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (r.status === 404) {
        await r.body?.cancel();
        return null;
      }
      if (r.ok) return await r.text();
      await r.body?.cancel();
      if (attempt >= 4) throw new Error(`${url}: HTTP ${r.status} after ${attempt} tries`);
    } catch (e) {
      if (attempt >= 4) throw e;
    }
    await sleep(1000 * attempt);
  }
};

/** how many bars GMO's day file holds (0 for a 404); a maintenance or broken answer is read again, then the run stops */
const barsIn = async (pair: string, side: "bid" | "ask", interval: string, date: string): Promise<number> => {
  const url = klineUrl(GMO_SYMBOLS[pair], side, interval, date.replaceAll("-", ""));
  for (let attempt = 1; ; attempt++) {
    const text = await getText(url);
    if (text === null) return 0;
    try {
      const body = JSON.parse(text);
      if (body?.status === 0 && Array.isArray(body?.data)) return body.data.length;
    } catch {
      // read again
    }
    if (attempt >= 4) throw new Error(`GMO ${pair} ${interval} ${side} ${date}: no usable answer: ${text.slice(0, 200)}`);
    await sleep(1000 * attempt);
  }
};

let failed = false;
const firsts: Record<string, string> = {};
for (const interval of INTERVALS) {
  for (const pair of PAIRS) {
    if (!GMO_SYMBOLS[pair]) throw new Error(`${pair}: not a GMO symbol`);
    console.log(`== ${interval} ${pair}`);
    let firstMonth: string | null = null;
    for (let y = FROM_YEAR; y <= 2026 && !firstMonth; y++) {
      for (let m = 1; m <= 12 && !firstMonth; m++) {
        const probe = firstWeekday(`${y}-${String(m).padStart(2, "0")}-01`);
        const n = await barsIn(pair, "bid", interval, probe);
        if (n > 0 || m === 1) console.log(`  probe ${probe}: bid bars ${n}`);
        if (n > 0) firstMonth = `${y}-${String(m).padStart(2, "0")}-01`;
      }
    }
    if (!firstMonth) {
      console.log(`  NO DAY FILE FOUND`);
      failed = true;
      continue;
    }
    const scanFrom = addDays(firstMonth, -50);
    let first: string | null = null;
    let firstBid: string | null = null;
    for (let d = scanFrom; utcOf(d) <= utcOf(firstMonth) + 7 * DAY && !first; d = addDays(d, 1)) {
      const b = await barsIn(pair, "bid", interval, d);
      const a = b > 0 ? await barsIn(pair, "ask", interval, d) : 0;
      if (b > 0 || a > 0) console.log(`  ${d} (${NAMES[weekday(d)]}): bid ${b} ask ${a}`);
      if (b > 0 && !firstBid) firstBid = d;
      if (b > 0 && a > 0) first = d;
    }
    if (!first) {
      console.log(`  NO FIRST DAY FOUND`);
      failed = true;
      continue;
    }
    const empty = Math.round((utcOf(firstBid ?? first) - utcOf(scanFrom)) / DAY);
    console.log(`  days scanned before it with no bid bar: ${empty} (from ${scanFrom})`);
    if (empty < 14) {
      console.log(`  FEWER THAN 14 EMPTY DAYS BEFORE THE FIRST DAY: scan further back`);
      failed = true;
      continue;
    }
    firsts[`${interval} ${pair}`] = first;
    console.log(`FIRST ${interval} ${pair} day file with both sides: ${first}`);
    // the first weekday of each year from then on: the bars on both sides (counts only)
    for (let y = Number(first.slice(0, 4)) + 1; y <= 2024; y++) {
      const d = firstWeekday(`${y}-01-02`);
      console.log(`  ${d} (${NAMES[weekday(d)]}): bid ${await barsIn(pair, "bid", interval, d)} ask ${await barsIn(pair, "ask", interval, d)}`);
    }
  }
}

console.log(`\n== the first days`);
for (const k of Object.keys(firsts)) console.log(`${k.padEnd(16)} ${firsts[k]}`);
console.log(`requests: ${requests}`);
if (failed || Object.keys(firsts).length !== PAIRS.length * INTERVALS.length) Deno.exit(1);
