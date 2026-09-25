// GMO's public 15-minute bid/ask history, fetched day by day and cached.
// Shared by the studies in this folder (tendencies.ts for #100,
// indicators.ts for #102) so both read exactly the same bars.
//
// Only GitHub's runners can reach GMO; the development container cannot.
// SYNTHETIC=1 swaps in a seeded random walk so the whole pipeline can be run
// anywhere. Its numbers mean nothing, which is the point: on a random walk
// every study here must find nothing.

import { GMO_SYMBOLS, dateKeys, jstDayKey, klineUrl, mergeSides, parseKlines, type QuoteCandle } from "../supabase/functions/track-outcomes/quotes.ts";
import { isMarketClosed } from "../supabase/functions/_shared/market-hours.ts";
import type { Candle } from "../supabase/functions/analyze/indicators.ts";
import { MINUTE } from "./lib.ts";

export interface FetchOptions {
  start: string;
  now: number;
  cache: string;
  concurrency?: number;
}

const cachePath = (cache: string, symbol: string, side: string, key: string) => `${cache}/${symbol}/15min/${side}/${key}.json`;

const readCache = async (path: string): Promise<unknown | undefined> => {
  try {
    return JSON.parse(await Deno.readTextFile(path));
  } catch {
    return undefined;
  }
};

const getJson = async (url: string): Promise<{ status: number; body: unknown }> => {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const r = await fetch(url);
      if (r.status === 404) return { status: 404, body: null };
      if (r.status === 429 || r.status >= 500) {
        await new Promise((res) => setTimeout(res, 500 * 2 ** attempt));
        continue;
      }
      return { status: r.status, body: await r.json() };
    } catch {
      await new Promise((res) => setTimeout(res, 500 * 2 ** attempt));
    }
  }
  return { status: 0, body: null };
};

// A seeded random walk with GMO's shape: 15-minute bars, the market's closed
// hours removed, a fixed spread. mulberry32 — the first version used
// `s * 1103515245` in plain doubles, which overflows 2^53 and hands back
// structured garbage in the low bits: the "random" walk trended and the
// study duly found tendencies in it.
export const synthetic = (pair: string, opts: FetchOptions): QuoteCandle[] => {
  let s = [...pair].reduce((a, ch) => (Math.imul(a, 31) + ch.charCodeAt(0)) | 0, 7);
  const rnd = () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out: QuoteCandle[] = [];
  let px = 150;
  for (let ms = Date.parse(`${opts.start}T00:00:00Z`); ms + 15 * MINUTE <= opts.now; ms += 15 * MINUTE) {
    if (isMarketClosed(ms)) continue;
    const o = px;
    px = o + (rnd() - 0.5) * 0.12;
    const h = Math.max(o, px) + rnd() * 0.03;
    const l = Math.min(o, px) - rnd() * 0.03;
    const dt = new Date(ms).toISOString().slice(0, 19).replace("T", " ");
    const bid = { datetime: dt, open: o, high: h, low: l, close: px };
    out.push({ datetime: dt, bid, ask: { ...bid, open: o + 0.004, high: h + 0.004, low: l + 0.004, close: px + 0.004 } });
  }
  return out;
};

export const fetchPair = async (
  pair: string,
  opts: FetchOptions,
): Promise<{ bars: QuoteCandle[]; requests: number; cached: number; failed: number }> => {
  if (Deno.env.get("SYNTHETIC")) return { bars: synthetic(pair, opts), requests: 0, cached: 0, failed: 0 };
  const symbol = GMO_SYMBOLS[pair];
  if (!symbol) throw new Error(`no GMO symbol for ${pair}`);
  const today = jstDayKey(opts.now);
  const keys = dateKeys(Date.parse(`${opts.start}T00:00:00Z`), opts.now, "day").filter((k) => k <= today);
  const bid: Array<{ t: number; c: Candle }> = [];
  const ask: typeof bid = [];
  let requests = 0;
  let cached = 0;
  let failed = 0;
  let cursor = 0;
  // The last three days are refetched every run: today's file is still
  // growing and the previous one only settles at the roll.
  const fresh = new Set(keys.slice(-3));
  const worker = async () => {
    while (cursor < keys.length) {
      const key = keys[cursor++];
      for (const side of ["bid", "ask"] as const) {
        const path = cachePath(opts.cache, symbol, side, key);
        let body = fresh.has(key) ? undefined : await readCache(path);
        if (body === undefined) {
          const r = await getJson(klineUrl(symbol, side, "15min", key));
          requests++;
          if (r.status === 0) {
            failed++;
            continue;
          }
          body = r.status === 404 ? { status: 404, data: [] } : r.body;
          await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
          await Deno.writeTextFile(path, JSON.stringify(body));
        } else {
          cached++;
        }
        (side === "bid" ? bid : ask).push(...parseKlines(body));
      }
    }
  };
  await Promise.all(Array.from({ length: opts.concurrency ?? 8 }, worker));
  bid.sort((a, b) => a.t - b.t);
  ask.sort((a, b) => a.t - b.t);
  const bars = mergeSides(bid, ask)
    .filter((q) => {
      const t = Date.parse(q.datetime);
      return Number.isFinite(t) && !isMarketClosed(t) && t + 15 * MINUTE <= opts.now;
    })
    .map((q) => ({ ...q, datetime: q.datetime.slice(0, 19).replace("T", " ") }));
  return { bars, requests, cached, failed };
};
