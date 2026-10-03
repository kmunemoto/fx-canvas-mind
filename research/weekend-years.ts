// #182: every weekend in GMO's 4-hour and daily year files, against the two
// ways of throwing a weekend bar away (docs §8.93). research/weekend-bars.ts
// looked at ten weekends on every timeframe; this looks at all of them, on
// the two timeframes read from year files, Bid and Ask.
//
// Read-only: GMO's public klines, nothing written anywhere. Run on GitHub's
// runners (the development container cannot reach GMO). For every pair the
// app reads from GMO, the 2023 to 2026 files of 4-hour and daily bars, Bid and
// Ask, and every bar in them tested two ways:
//   old — thrown away when its stamp is inside isMarketClosed (Saturday,
//         Friday from 22:00, Sunday before 21:00 UTC);
//   new — barFullyClosed: thrown away only when the market was shut for the
//         whole of it.
// Printed: per timeframe and side, the bars, how many each way throws away,
// the bars the new way keeps that the old threw away counted by weekday and
// hour (UTC), any the new way throws away that the old kept, and, for the
// 4-hour bars kept anew, whether the same stamp is on both sides and the next
// bar opens 4 hours later. Every bar kept anew other than the 4-hour one
// stamped Sunday 20:00 is printed in full, with the bars either side of it.
//
//   deno run --allow-net=forex-api.coin.z.com research/weekend-years.ts

import { barFullyClosed, isMarketClosed } from "../supabase/functions/_shared/market-hours.ts";
import { LIVE_PAIRS, NO_KLINE_FILE, isTwelvePair } from "../supabase/functions/live-chart/logic.ts";
import { GMO_SYMBOLS, klineUrl, parseKlines } from "../supabase/functions/track-outcomes/quotes.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let requests = 0;
let failed = 0;
let missing = 0;
const fetcher = async (url: string): Promise<unknown> => {
  await sleep(80);
  requests++;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (r.status === 404) {
      missing++;
      await r.body?.cancel();
      return NO_KLINE_FILE;
    }
    if (!r.ok) {
      failed++;
      await r.body?.cancel();
      return null;
    }
    return await r.json();
  } catch {
    failed++;
    return null;
  }
};

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const at = (ms: number) => `${DAYS[new Date(ms).getUTCDay()]} ${new Date(ms).toISOString().slice(11, 16)}`;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");
const PAIRS = LIVE_PAIRS.filter((p) => !isTwelvePair(p) && GMO_SYMBOLS[p] !== undefined);
const YEARS = ["2023", "2024", "2025", "2026"];
const TFS: Array<[string, number]> = [["4hour", 4 * HOUR], ["1day", DAY]];

console.log(`now ${iso(Date.now())} UTC; pairs ${PAIRS.length}: ${PAIRS.join(" ")}`);
const lines: string[] = [];
// per timeframe and side: the stamps each pair keeps anew
const keptBy = new Map<string, Map<string, Set<number>>>();
// the bars kept anew other than the 4-hour Sunday 20:00 ones, in full
const odd: string[] = [];
for (const [tf, len] of TFS) {
  for (const side of ["bid", "ask"] as const) {
    let bars = 0;
    let oldDrop = 0;
    let newDrop = 0;
    const keptAnew = new Map<string, number>();
    const droppedNewOnly: string[] = [];
    const stamps = new Map<string, Set<number>>();
    for (const pair of PAIRS) {
      const sym = GMO_SYMBOLS[pair];
      const all: number[] = [];
      const rows = new Map<number, { open: number; high: number; low: number; close: number }>();
      for (const y of YEARS) {
        const got = await fetcher(klineUrl(sym, side, tf, y));
        if (got === NO_KLINE_FILE || got === null) continue;
        for (const b of parseKlines(got)) {
          all.push(b.t);
          rows.set(b.t, b.c);
        }
      }
      const ts = [...new Set(all)].sort((a, b) => a - b);
      const anew = new Set<number>();
      for (let i = 0; i < ts.length; i++) {
        const t = ts[i];
        bars++;
        const o = isMarketClosed(t);
        const n = barFullyClosed(t, len);
        if (o) oldDrop++;
        if (n) newDrop++;
        if (n && !o) droppedNewOnly.push(`${pair} ${iso(t)}`);
        if (o && !n) {
          anew.add(t);
          // anything but the 4-hour bar holding the week's first two hours,
          // shown with the bars either side of it
          const day = new Date(t).getUTCDay();
          if (!(tf === "4hour" && day === 0 && new Date(t).getUTCHours() === 20)) {
            const show = (x: number | undefined) => {
              if (x === undefined) return "none";
              const b = rows.get(x)!;
              return `${iso(x)} (${at(x)}) o ${b.open} h ${b.high} l ${b.low} c ${b.close}`;
            };
            odd.push(`${tf} ${side} ${pair}: ${show(t)}; before ${show(ts[i - 1])}; after ${show(ts[i + 1])}`);
          }
          const k = at(t);
          keptAnew.set(k, (keptAnew.get(k) ?? 0) + 1);
          // the next bar, and how far after
          const next = ts[i + 1];
          if (tf === "4hour" && next !== undefined && next - t !== 4 * HOUR) {
            const g = `${k} then a gap of ${(next - t) / HOUR}h`;
            keptAnew.set(g, (keptAnew.get(g) ?? 0) + 1);
          }
        }
      }
      stamps.set(pair, anew);
      if (ts.length) lines.push(`${tf} ${side} ${pair}: ${ts.length} bars ${iso(ts[0])} to ${iso(ts[ts.length - 1])}, kept anew ${anew.size}`);
    }
    console.log(`${tf} ${side}: ${bars} bars; thrown away old ${oldDrop}, new ${newDrop}; dropped by new only ${droppedNewOnly.length}`);
    for (const [k, n] of [...keptAnew.entries()].sort()) console.log(`  kept anew at ${k}: ${n}`);
    for (const d of droppedNewOnly.slice(0, 20)) console.log(`  DROPPED BY NEW ONLY ${d}`);
    keptBy.set(`${tf}-${side}`, stamps);
  }
}
// the same stamps kept anew on both sides (mergeSides pairs a bar only when both have it)
for (const [tf] of TFS) {
  const bid = keptBy.get(`${tf}-bid`) ?? new Map<string, Set<number>>();
  const ask = keptBy.get(`${tf}-ask`) ?? new Map<string, Set<number>>();
  let both = 0;
  let onlyOne = 0;
  for (const pair of PAIRS) {
    const b = bid.get(pair) ?? new Set();
    const a = ask.get(pair) ?? new Set();
    for (const t of b) (a.has(t) ? both++ : onlyOne++);
    for (const t of a) if (!b.has(t)) onlyOne++;
  }
  console.log(`${tf}: kept anew on both sides ${both}, on one side only ${onlyOne}`);
}
console.log("");
console.log("kept anew, other than the 4-hour bar stamped Sunday 20:00:");
for (const l of odd) console.log(`  ${l}`);
console.log("");
for (const l of lines) console.log(l);
console.log("");
console.log(`requests ${requests}, 404 ${missing}, failed ${failed}`);
