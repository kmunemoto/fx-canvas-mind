// #205 (docs §8.102, the second real run): why GMO day files kept by the
// study itself are judged not whole, and what GMO answers for a past day now.
// Read only; no measured number of the study. Prints, per interval:
//   - the kept files: without responsetime, answered before the key's day end
//     (dayFileEnd: the key's day at 22:00 UTC), at or after it;
//   - for those answered before: how long before (hours, quantiles) and whether
//     the file is cut short: the minutes from its last bar's end to the day end
//     (0 in US winter, 60 in US summer when the day rolls at 06:00 JST; more is
//     a file that stops early), against the same for the files judged whole;
//   - live reads of a few past days (twice each): HTTP status, GMO's status and
//     messages, responsetime, the bars, the last bar's time, the cache headers.
//
//   deno run --allow-net=forex-api.coin.z.com --allow-read=research/.cache research/gmo-cache-diag.ts

import { GMO_SYMBOLS, dateKeys, klineUrl } from "../supabase/functions/track-outcomes/quotes.ts";
import { dayFileEnd } from "./ownerhold-data.ts";

const CACHE = "research/.cache";
const PAIRS = ["USD/JPY", "EUR/JPY", "AUD/JPY", "EUR/USD", "AUD/USD"];
const IVS: Array<[string, number]> = [["1min", 60_000], ["5min", 300_000], ["15min", 900_000]];
const START = Date.parse(Deno.env.get("START") ?? "2024-01-01T00:00:00Z");
const END = Date.parse(Deno.env.get("END") ?? "2026-10-03T00:00:00Z");
const keys = dateKeys(START - 3 * 86_400_000, END, "day");

const q = (xs: number[], p: number) => (xs.length ? xs[Math.min(xs.length - 1, Math.floor(p * xs.length))] : NaN);
const qs = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return `n ${s.length}${s.length ? `, min ${s[0].toFixed(2)}, p10 ${q(s, 0.1).toFixed(2)}, median ${q(s, 0.5).toFixed(2)}, p90 ${q(s, 0.9).toFixed(2)}, max ${s[s.length - 1].toFixed(2)}` : ""}`;
};
// the minutes from the last bar's end to the key's day end, bucketed
const bucket = (m: number | null) => (m === null ? "no bars" : m === 0 ? "0" : m === 60 ? "60" : m < 0 ? "<0" : m < 60 ? "1-59" : m <= 24 * 60 ? "61-1440" : ">1440");

for (const [iv, step] of IVS) {
  const c = { missing: 0, noTime: 0, before: 0, whole: 0 };
  const lagBefore: number[] = [];
  const gaps: Record<string, Record<string, number>> = { before: {}, whole: {} };
  const examples: string[] = [];
  for (const pair of PAIRS) {
    for (const side of ["bid", "ask"]) {
      for (const key of keys) {
        let body: { status?: unknown; data?: unknown; responsetime?: unknown };
        try {
          body = JSON.parse(await Deno.readTextFile(`${CACHE}/${GMO_SYMBOLS[pair]}/${iv}/${side}/${key}.json`));
        } catch {
          c.missing++;
          continue;
        }
        const at = Date.parse(String(body.responsetime ?? ""));
        const data = Array.isArray(body.data) ? (body.data as Array<{ openTime?: unknown }>) : [];
        const last = data.length ? Number(data[data.length - 1].openTime) : NaN;
        const gap = Number.isFinite(last) ? Math.round((dayFileEnd(key) - (last + step)) / 60_000) : null;
        if (!Number.isFinite(at)) {
          c.noTime++;
          continue;
        }
        const kind = at >= dayFileEnd(key) ? "whole" : "before";
        c[kind]++;
        gaps[kind][bucket(gap)] = (gaps[kind][bucket(gap)] ?? 0) + 1;
        if (kind === "before") {
          lagBefore.push((dayFileEnd(key) - at) / 3_600_000);
          if (examples.length < 8 && (examples.length < 4 || (gap !== null && gap !== 0 && gap !== 60)))
            examples.push(`${pair} ${side} ${key}: answered ${String(body.responsetime)}, status ${String(body.status)}, bars ${data.length}, last bar ${Number.isFinite(last) ? new Date(last).toISOString() : "-"}, minutes to the day end ${gap}`);
        }
      }
    }
  }
  console.log(`== ${iv}: kept ${c.noTime + c.before + c.whole} (without responsetime ${c.noTime}, answered before the day end ${c.before}, at or after it ${c.whole}), not kept ${c.missing}`);
  console.log(`   hours answered before the day end: ${qs(lagBefore)}`);
  console.log(`   minutes from the last bar to the day end: answered before ${JSON.stringify(gaps.before)}; at or after ${JSON.stringify(gaps.whole)}`);
  for (const e of examples) console.log(`   e.g. ${e}`);
}

// live reads: a few past days of USD/JPY's 1-minute bids, twice each
console.log(`== live reads (now ${new Date().toISOString()})`);
for (const key of ["20240102", "20250514", "20260820", "20260930"]) {
  for (let k = 0; k < 2; k++) {
    try {
      const r = await fetch(klineUrl("USD_JPY", "bid", "1min", key), { signal: AbortSignal.timeout(30_000) });
      const text = await r.text();
      let b: { status?: unknown; data?: unknown; responsetime?: unknown; messages?: unknown } = {};
      try {
        b = JSON.parse(text);
      } catch {
        b = {};
      }
      const data = Array.isArray(b.data) ? (b.data as Array<{ openTime?: unknown }>) : [];
      const last = data.length ? Number(data[data.length - 1].openTime) : NaN;
      const h = ["age", "cache-control", "x-cache", "date", "last-modified", "etag"].map((n) => `${n}=${r.headers.get(n) ?? "-"}`).join(" ");
      console.log(`   ${key} #${k + 1}: HTTP ${r.status}, status ${String(b.status)}, messages ${JSON.stringify(b.messages ?? null)}, responsetime ${String(b.responsetime)}, bars ${data.length}, last bar ${Number.isFinite(last) ? new Date(last).toISOString() : "-"}, day end ${new Date(dayFileEnd(key)).toISOString()}; ${h}`);
    } catch (e) {
      console.log(`   ${key} #${k + 1}: ${String(e)}`);
    }
    await new Promise((res) => setTimeout(res, 1500));
  }
}
