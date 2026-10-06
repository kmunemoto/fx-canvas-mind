// #205: the first GMO 1-minute day file of each of the five pairs the
// owner's 15-minute ULTRA emails cover (docs §8.102, the look before the
// study: 「5ペアの Bid・Ask の1分足が両方そろう最初の日を、値段を計算しない
// 下見で決め、docs に書いて commit してから測る」). Read-only and reads no
// price: for each day it asks for, it counts the bars in GMO's answer, the
// way research/gotobi.ts found USD/JPY's (§8.96: 2023-10-27).
//
//   * the first weekday of each month from 2019-01 on, the bid side: the
//     first month whose file has bars;
//   * then each day from 50 days before that month to 7 days into it, both
//     sides: the first day with bars on both is the pair's first day; at
//     least 14 of the days scanned before it must have had no bid bar, or an
//     earlier file could have been missed (the run stops);
//   * and, told beside it, whether 2024-01-02 (the first weekday of the
//     study's START year) has bars on both sides.
//
//   deno run --allow-net=forex-api.coin.z.com research/min1-start.ts

import { GMO_SYMBOLS, klineUrl } from "../supabase/functions/track-outcomes/quotes.ts";

const PAIRS = ["USD/JPY", "EUR/JPY", "AUD/JPY", "EUR/USD", "AUD/USD"];
const DAY = 86_400_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const utcOf = (d: string) => Date.parse(`${d}T00:00:00Z`);
const dateOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const addDays = (d: string, n: number) => dateOf(utcOf(d) + n * DAY);
const weekday = (d: string) => new Date(utcOf(d)).getUTCDay();
const NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

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
const barsIn = async (pair: string, side: "bid" | "ask", date: string): Promise<number> => {
  const url = klineUrl(GMO_SYMBOLS[pair], side, "1min", date.replaceAll("-", ""));
  for (let attempt = 1; ; attempt++) {
    const text = await getText(url);
    if (text === null) return 0;
    try {
      const body = JSON.parse(text);
      if (body?.status === 0 && Array.isArray(body?.data)) return body.data.length;
    } catch {
      // read again
    }
    if (attempt >= 4) throw new Error(`GMO ${pair} ${side} ${date}: no usable answer: ${text.slice(0, 200)}`);
    await sleep(1000 * attempt);
  }
};

const firsts: Record<string, string> = {};
let failed = false;
for (const pair of PAIRS) {
  if (!GMO_SYMBOLS[pair]) throw new Error(`${pair}: not a GMO symbol`);
  console.log(`== ${pair}`);
  let firstMonth: string | null = null;
  for (let y = 2019; y <= 2026 && !firstMonth; y++) {
    for (let m = 1; m <= 12 && !firstMonth; m++) {
      const d = `${y}-${String(m).padStart(2, "0")}-01`;
      let probe = d;
      while (weekday(probe) === 0 || weekday(probe) === 6) probe = addDays(probe, 1);
      const n = await barsIn(pair, "bid", probe);
      console.log(`  probe ${probe}: bid bars ${n}`);
      if (n > 0) firstMonth = d;
    }
  }
  if (!firstMonth) {
    console.log(`  NO 1-MINUTE DAY FILE FOUND`);
    failed = true;
    continue;
  }
  const scanFrom = addDays(firstMonth, -50);
  let first: string | null = null;
  let firstBid: string | null = null;
  for (let d = scanFrom; utcOf(d) <= utcOf(firstMonth) + 7 * DAY && !first; d = addDays(d, 1)) {
    const b = await barsIn(pair, "bid", d);
    const a = b > 0 ? await barsIn(pair, "ask", d) : 0;
    if (b > 0 || a > 0) console.log(`  ${d} (${NAMES[weekday(d)]}): bid ${b} ask ${a}`);
    if (b > 0 && !firstBid) firstBid = d;
    if (b > 0 && a > 0) first = d;
  }
  if (!first) {
    console.log(`  NO FIRST DAY FOUND`);
    failed = true;
    continue;
  }
  // the days before the first bid bar (bid bars before the first day with both sides are told above)
  const empty = Math.round((utcOf(firstBid ?? first) - utcOf(scanFrom)) / DAY);
  console.log(`  days scanned before it with no bid bar: ${empty} (from ${scanFrom})`);
  if (empty < 14) {
    console.log(`  FEWER THAN 14 EMPTY DAYS BEFORE THE FIRST DAY: scan further back`);
    failed = true;
    continue;
  }
  const b0 = await barsIn(pair, "bid", "2024-01-02");
  const a0 = await barsIn(pair, "ask", "2024-01-02");
  console.log(`  2024-01-02 (${NAMES[weekday("2024-01-02")]}): bid ${b0} ask ${a0}`);
  firsts[pair] = first;
  console.log(`FIRST ${pair} 1-minute day file with both sides: ${first}`);
}

console.log(`\n== the five pairs' first days`);
for (const pair of PAIRS) console.log(`${pair.padEnd(8)} ${firsts[pair] ?? "-"}`);
const latest = Object.values(firsts).sort().at(-1);
console.log(`the latest of them: ${latest ?? "-"}`);
console.log(`requests: ${requests}`);
if (failed || Object.keys(firsts).length !== PAIRS.length) Deno.exit(1);
