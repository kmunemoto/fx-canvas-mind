// #182: GMO's bars around the weekend, against the two ways of throwing a
// weekend bar away (docs §8.93).
//
// Read-only: GMO's public klines, nothing written anywhere. Run on GitHub's
// runners (the development container cannot reach GMO). For every pair the
// app reads from GMO and ten weekends (both daylight-saving seasons and the
// weekends the clocks change), the Bid bars stamped from Friday 18:00 to
// Monday 02:00 UTC are listed for the timeframes the old read keeps with
// usableBars (1, 5 and 15 minutes and 1 hour from the day files, 4 hours and
// a day from the year files), and each is tested two ways:
//   old — usableBars today: thrown away when its stamp is inside
//         isMarketClosed (Saturday, Friday from 22:00, Sunday before 21:00);
//   new — barFullyClosed: thrown away only when the market was shut for the
//         whole of it.
// Printed: per timeframe, how many bars each way throws away, every bar the
// new way keeps that the old way threw away (with its prices), the last bar
// before each weekend and the first after it, and, for each 4-hour bar kept
// anew, the 1-hour bars of the same four hours put together (open of the
// first, highest high, lowest low, close of the last) against it.
//
//   deno run --allow-net=forex-api.coin.z.com research/weekend-bars.ts

import { barFullyClosed, isMarketClosed } from "../supabase/functions/_shared/market-hours.ts";
import { LIVE_PAIRS, NO_KLINE_FILE, isTwelvePair } from "../supabase/functions/live-chart/logic.ts";
import { GMO_SYMBOLS, klineUrl, parseKlines } from "../supabase/functions/track-outcomes/quotes.ts";
import type { Candle } from "../supabase/functions/analyze/indicators.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let requests = 0;
let failed = 0;
let missing = 0;
// GMO's 404 is a file with no bars; 80 ms apart
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

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const at = (ms: number) => `${DAYS[new Date(ms).getUTCDay()]} ${iso(ms).slice(11)}`;
// the JST day a file is named for, "YYYYMMDD"
const key = (ms: number) => new Date(ms + 9 * HOUR).toISOString().slice(0, 10).replaceAll("-", "");

// Saturdays (UTC dates): both seasons, and the weekends the clocks change
// (Europe 2025-10-26 and 2026-03-29, New York 2025-11-02 and 2026-03-08)
const SATURDAYS = [
  "2025-10-25", "2025-11-01", "2025-12-13", "2026-01-17", "2026-02-21",
  "2026-03-07", "2026-03-28", "2026-05-16", "2026-07-18", "2026-09-26",
];
const DAY_TFS: Array<[string, number]> = [["1min", MIN], ["5min", 5 * MIN], ["15min", 15 * MIN], ["1hour", HOUR]];
const YEAR_TFS: Array<[string, number]> = [["4hour", 4 * HOUR], ["1day", DAY]];
const PAIRS = LIVE_PAIRS.filter((p) => !isTwelvePair(p) && GMO_SYMBOLS[p] !== undefined);

type Bar = { t: number; c: Candle };
const read = async (sym: string, tf: string, k: string): Promise<Bar[]> => {
  const got = await fetcher(klineUrl(sym, "bid", tf, k));
  if (got === NO_KLINE_FILE || got === null) return [];
  return parseKlines(got);
};

interface Tally {
  inWindow: number;
  oldDrop: number;
  newDrop: number;
  keptAnew: string[];
  edges: Map<string, number>;
}
const tallies = new Map<string, Tally>();
const tally = (tf: string): Tally => {
  let t = tallies.get(tf);
  if (!t) tallies.set(tf, (t = { inWindow: 0, oldDrop: 0, newDrop: 0, keptAnew: [], edges: new Map() }));
  return t;
};
const fourHourChecks: string[] = [];
const edge = (t: Tally, label: string) => t.edges.set(label, (t.edges.get(label) ?? 0) + 1);

console.log(`now ${iso(Date.now())} UTC; pairs ${PAIRS.length}: ${PAIRS.join(" ")}`);
for (const pair of PAIRS) {
  const sym = GMO_SYMBOLS[pair];
  const years: Record<string, Bar[]> = {};
  for (const [tf] of YEAR_TFS) years[tf] = [...(await read(sym, tf, "2025")), ...(await read(sym, tf, "2026"))];
  for (const sat of SATURDAYS) {
    const satMs = Date.parse(`${sat}T00:00:00Z`);
    const from = satMs - 6 * HOUR; // Friday 18:00 UTC
    const to = satMs + 2 * DAY + 2 * HOUR; // Monday 02:00 UTC
    // the JST days whose files hold Friday 18:00 to Monday 02:00 UTC
    const keys = [...new Set([from, satMs, satMs + DAY, satMs + 2 * DAY, to].map(key))];
    const hours: Bar[] = [];
    const lines: string[] = [];
    for (const [tf, len] of [...DAY_TFS, ...YEAR_TFS]) {
      let bars: Bar[];
      if (tf === "4hour" || tf === "1day") bars = years[tf];
      else {
        bars = [];
        for (const k of keys) bars.push(...(await read(sym, tf, k)));
      }
      const seen = new Set<number>();
      const win = bars.filter((b) => b.t >= from && b.t < to && !seen.has(b.t) && seen.add(b.t)).sort((a, b) => a.t - b.t);
      if (tf === "1hour") hours.push(...win);
      const t = tally(tf);
      let lastFri = Number.NaN;
      let firstSun = Number.NaN;
      for (const b of win) {
        t.inWindow++;
        const oldOut = isMarketClosed(b.t);
        const newOut = barFullyClosed(b.t, len);
        if (oldOut) t.oldDrop++;
        if (newOut) t.newDrop++;
        if (newOut && !oldOut) t.keptAnew.push(`${pair} ${iso(b.t)} DROPPED BY NEW ONLY`);
        if (oldOut && !newOut) {
          t.keptAnew.push(`${pair} ${iso(b.t)} (${at(b.t)}) o ${b.c.open} h ${b.c.high} l ${b.c.low} c ${b.c.close}`);
          if (tf === "4hour") {
            const inside = hours.filter((h) => h.t >= b.t && h.t < b.t + len);
            const made = inside.length
              ? { o: inside[0].c.open, h: Math.max(...inside.map((h) => h.c.high)), l: Math.min(...inside.map((h) => h.c.low)), c: inside[inside.length - 1].c.close }
              : null;
            const same = made && [made.o === b.c.open, made.h === b.c.high, made.l === b.c.low, made.c === b.c.close];
            fourHourChecks.push(
              `${pair} ${iso(b.t)}: 1h bars inside ${inside.map((h) => iso(h.t).slice(11)).join(",") || "none"}; ` +
                (made ? `made o ${made.o} h ${made.h} l ${made.l} c ${made.c}; same o/h/l/c ${same!.join("/")}` : "no 1h bars"),
            );
          }
        }
        const day = new Date(b.t).getUTCDay();
        if (day === 5 || (day === 6 && Number.isNaN(firstSun))) lastFri = b.t;
        if ((day === 0 || day === 1) && Number.isNaN(firstSun)) firstSun = b.t;
      }
      if (win.length) {
        edge(t, `last before ${Number.isFinite(lastFri) ? at(lastFri) : "none"} / first after ${Number.isFinite(firstSun) ? at(firstSun) : "none"}`);
        lines.push(`${tf.padEnd(6)} ${String(win.length).padStart(4)} last ${Number.isFinite(lastFri) ? at(lastFri) : "none     "} first ${Number.isFinite(firstSun) ? at(firstSun) : "none"}`);
      } else lines.push(`${tf.padEnd(6)} none`);
    }
    console.log(`${pair} weekend ${sat}: ${lines.join(" | ")}`);
  }
}

console.log("");
console.log("per timeframe (all pairs, all weekends; bars stamped Fri 18:00 to Mon 02:00 UTC)");
for (const [tf, t] of tallies) {
  console.log(`${tf}: ${t.inWindow} bars; thrown away old ${t.oldDrop}, new ${t.newDrop}; kept anew ${t.keptAnew.length}`);
  for (const [label, n] of [...t.edges.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${n} × ${label}`);
  for (const line of t.keptAnew.slice(0, 400)) console.log(`  kept anew: ${line}`);
}
console.log("");
console.log("4-hour bars kept anew against the 1-hour bars of the same four hours");
for (const line of fourHourChecks) console.log(`  ${line}`);
console.log("");
console.log(`requests ${requests}, 404 ${missing}, failed ${failed}`);
