// #188: the bars research/money.ts reads (docs §8.99 データと期間), and the
// settings it runs with. Three sources, one shape:
//   * GMO's files (research/.cache, fetched where missing, eight at a time),
//     as research/stop2n.ts reads them: only on GitHub's runners, which can
//     reach GMO;
//   * SYNTHETIC=1: stop2n.ts's seeded walk on 5 minutes (copied), every pair
//     independent, the coarser bars built from it; DUMPDIR writes it out as
//     GMO's files are, for research/money-check.py;
//   * FIXTURE=<dir>: only that folder's gmo/ files (a hand example's), never
//     the network.
// The weekend's bars are left out as #182 does (WEEKEND=inside: a bar out only
// when it lies wholly inside the closure), the only way §8.99 reads them.

import { GMO_INTERVALS, GMO_SYMBOLS, dateKeys, jstDayKey, jstYearKey, klineUrl, mergeSides, parseKlines, type QuoteCandle } from "../supabase/functions/track-outcomes/quotes.ts";
import { barInsideClosure, isMarketClosed } from "../supabase/functions/_shared/market-hours.ts";
import type { Candle } from "../supabase/functions/analyze/indicators.ts";
import { barOpenMs } from "../supabase/functions/analyze/state.ts";
import { LIVE_STEP_MS } from "../supabase/functions/live-chart/logic.ts";
import { HOUR, MINUTE, aggregate } from "./lib.ts";

export const FINE = 5 * MINUTE;
export type Tf = "5min" | "4h" | "1day";
export type Synth = "path" | "wicks" | "drift" | "against";

// ---- the settings ------------------------------------------------------------------------

export interface Config {
  start: string;
  split: string;
  end: string;
  startMs: number;
  // the first half: signals closed before this
  splitMs: number;
  // END: nothing at or after it is read
  now: number;
  synthetic: boolean;
  synth: Synth;
  seed: number;
  // pips a 5-minute bar the walks move a signal's prices ("drift" its way,
  // "against" the other; 0 on every other run)
  drift: number;
  dumpdir: string;
  // a hand example's folder ("" when not one)
  fixture: string;
  out: string;
  cache: string;
  // "old": the stop 30 and TP1 20 (§8.99 再現), the three means only
  levels: "new" | "old";
  // a planted error's name (interface.md §8), "" none
  plant: string;
  // the weeks rearranged: how many of each kind (§8.99 区間・幅: 1,000; 0 none),
  // and the thinning's draws (200); a test may ask for fewer
  boot: number;
  thin: number;
}

const env = (k: string): string => Deno.env.get(k) ?? "";
const timeOf = (s: string): number => {
  const x = s.includes("T") ? s : s.replace(" ", "T");
  return Date.parse(/[zZ]$|[+-]\d\d:\d\d$/.test(x) ? x : x.length <= 10 ? `${x}T00:00:00Z` : `${x}Z`);
};

export const configFromEnv = (): Config => {
  const fixture = env("FIXTURE");
  // a fixture names its own period (fixture.json start, end)
  let fx: { start?: string; end?: string } = {};
  if (fixture) fx = JSON.parse(Deno.readTextFileSync(`${fixture}/fixture.json`));
  const start = fx.start || env("START") || "2024-01-01";
  const split = env("SPLIT") || "2025-05-19";
  const end = fx.end || env("END") || "2026-10-02T21:00:00Z";
  const synthetic = Boolean(env("SYNTHETIC"));
  const synthIn = env("SYNTH");
  const synth: Synth = synthIn === "path" || synthIn === "drift" || synthIn === "against" ? synthIn : "wicks";
  const drifting = synthetic && (synth === "drift" || synth === "against");
  const levels = env("LEVELS") || "new";
  if (levels !== "new" && levels !== "old") throw new Error(`LEVELS ${levels} is neither new nor old`);
  const cfg: Config = {
    start,
    split,
    end,
    startMs: timeOf(start),
    splitMs: timeOf(split),
    now: timeOf(end),
    synthetic,
    synth,
    seed: Number(env("SEED") || 7),
    // §8.99 作り物の値動き: 0.10 pip a 5-minute bar
    drift: drifting ? (synth === "against" ? -1 : 1) * Number(env("DRIFT") || 0.1) : 0,
    dumpdir: env("DUMPDIR"),
    fixture,
    out: env("OUTDIR") || "research/out",
    cache: "research/.cache",
    levels,
    plant: env("PLANT"),
    boot: Number(env("BOOT") || 1000),
    thin: Number(env("THIN") || 200),
  };
  if (![cfg.boot, cfg.thin].every((x) => Number.isInteger(x) && x >= 0)) throw new Error(`BOOT ${cfg.boot} or THIN ${cfg.thin} is not a count`);
  if (![cfg.startMs, cfg.splitMs, cfg.now].every(Number.isFinite)) throw new Error(`START ${start}, SPLIT ${split} or END ${end} is not a time`);
  if (cfg.dumpdir && !synthetic) throw new Error("DUMPDIR is for the walks only");
  if (fixture && synthetic) throw new Error("FIXTURE and SYNTHETIC are two different runs");
  return cfg;
};

// ---- GMO's files (as research/stop2n.ts) -------------------------------------------------

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

const sound = (body: unknown): boolean => {
  if (typeof body !== "object" || body === null) return false;
  const b = body as { status?: unknown; data?: unknown };
  return (b.status === 0 || b.status === 404) && Array.isArray(b.data);
};

export interface Loaded {
  quotes: QuoteCandle[];
  requests: number;
  cached: number;
  failed: number;
}

// #182's weekend rule: a bar out only when it lies wholly inside the closure
const weekendOut = (openMs: number, stepMs: number): boolean => barInsideClosure(openMs, stepMs);

// a seeded random walk on 5 minutes (stop2n.ts's synthetic5, copied): "path"
// (100 small steps, the high and low the path's own; "drift" and "against"
// walk the same, the signals' prices moved later) or "wicks"
const synthetic5 = (cfg: Config, pair: string, fromMs: number): QuoteCandle[] => {
  let seed = [...pair].reduce((a, ch) => (Math.imul(a, 31) + ch.charCodeAt(0)) | 0, cfg.seed);
  const rnd = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const jpy = pair.includes("JPY");
  const scale = jpy ? 0.07 : 0.0007;
  const wick = jpy ? 0.02 : 0.0002;
  const spread = jpy ? 0.004 : 0.00004;
  const bars: QuoteCandle[] = [];
  let px = jpy ? 150 : 1.2;
  for (let ms = Math.floor(fromMs / FINE) * FINE; ms + FINE <= cfg.now; ms += FINE) {
    if (isMarketClosed(ms)) continue;
    const o = px;
    let h: number;
    let l: number;
    if (cfg.synth !== "wicks") {
      h = o;
      l = o;
      for (let k = 0; k < 100; k++) {
        px += (rnd() - 0.5) * (scale / 10);
        if (px > h) h = px;
        if (px < l) l = px;
      }
    } else {
      px = o + (rnd() - 0.5) * scale;
      h = Math.max(o, px) + rnd() * wick;
      l = Math.min(o, px) - rnd() * wick;
    }
    const dt = new Date(ms).toISOString();
    const bid = { datetime: dt, open: o, high: h, low: l, close: px };
    bars.push({ datetime: dt, bid, ask: { ...bid, open: o + spread, high: h + spread, low: l + spread, close: px + spread } });
  }
  return bars;
};

// the walk's bars as GMO's files hold them ({status: 0, data: [{openTime,
// open, high, low, close}]}, a side a file), a file a UTC day (5 minutes) or
// a UTC year (4 hours, a day): what research/money-check.py reads
const dump = async (cfg: Config, pair: string, tf: Tf, quotes: QuoteCandle[]) => {
  const files = new Map<string, Record<"bid" | "ask", Array<Record<string, string>>>>();
  for (const q of quotes) {
    const t = barOpenMs(q.datetime);
    const key = tf === "5min" ? new Date(t).toISOString().slice(0, 10).replaceAll("-", "") : new Date(t).toISOString().slice(0, 4);
    let f = files.get(key);
    if (!f) files.set(key, (f = { bid: [], ask: [] }));
    for (const side of ["bid", "ask"] as const) {
      const c = q[side];
      f[side].push({ openTime: String(t), open: String(c.open), high: String(c.high), low: String(c.low), close: String(c.close) });
    }
  }
  const spec = GMO_INTERVALS[tf];
  for (const [key, f] of files) {
    for (const side of ["bid", "ask"] as const) {
      const dir = `${cfg.dumpdir}/${GMO_SYMBOLS[pair]}/${spec.name}/${side}`;
      await Deno.mkdir(dir, { recursive: true });
      await Deno.writeTextFile(`${dir}/${key}.json`, JSON.stringify({ status: 0, data: f[side] }));
    }
  }
};

// a fixture's files: every file under <dir>/gmo/<SYMBOL>/<interval>/<side>/,
// whatever its key (nothing fetched; a side missing is a failed read)
const fixtureQuotes = async (cfg: Config, pair: string, tf: Tf): Promise<{ bid: Array<{ t: number; c: Candle }>; ask: Array<{ t: number; c: Candle }>; failed: number }> => {
  const spec = GMO_INTERVALS[tf];
  const out = { bid: [] as Array<{ t: number; c: Candle }>, ask: [] as Array<{ t: number; c: Candle }>, failed: 0 };
  for (const side of ["bid", "ask"] as const) {
    const dir = `${cfg.fixture}/gmo/${GMO_SYMBOLS[pair]}/${spec.name}/${side}`;
    let names: string[] = [];
    try {
      for await (const e of Deno.readDir(dir)) if (e.isFile && e.name.endsWith(".json")) names.push(e.name);
    } catch {
      names = [];
    }
    names.sort();
    for (const name of names) {
      const body = JSON.parse(await Deno.readTextFile(`${dir}/${name}`));
      if (!sound(body)) {
        out.failed++;
        continue;
      }
      out[side].push(...parseKlines(body));
    }
  }
  out.bid.sort((a, b) => a.t - b.t);
  out.ask.sort((a, b) => a.t - b.t);
  return out;
};

// one pair's bars of one timeframe from `fromMs`, closed by END (load); a
// walk's bars let go once its pair is read (forget)
export const makeLoader = (cfg: Config) => {
  const syntheticCache = new Map<string, QuoteCandle[]>();
  const forget = (pair: string) => syntheticCache.delete(pair);
  const load = async (pair: string, tf: Tf, fromMs: number): Promise<Loaded> => {
    const step = LIVE_STEP_MS[tf];
    if (cfg.synthetic) {
      let fine = syntheticCache.get(pair);
      if (!fine) {
        fine = synthetic5(cfg, pair, Date.UTC(new Date(cfg.startMs).getUTCFullYear() - 1, 0, 1));
        syntheticCache.set(pair, fine);
      }
      // the 4-hour bars on GMO's grid (00:00, 04:00, … UTC, §8.93; stop2n.ts
      // put the walks' at 21:00 + 4k hours), so a walk has closes at 16:00 and
      // 20:00 UTC (§8.99's nights; USD/JPY's 3.8 at 05:00 JST); the days at 21:00
      const offset = tf === "1day" ? 21 * HOUR : 0;
      const quotes = (tf === "5min"
        ? fine
        : aggregate(fine, step, offset, cfg.now)
          .filter((q) => !weekendOut(barOpenMs(q.datetime), step))
          .map((q) => {
            const dt = new Date(barOpenMs(q.datetime)).toISOString();
            return { datetime: dt, bid: { ...q.bid, datetime: dt }, ask: { ...q.ask, datetime: dt } };
          })).filter((q) => barOpenMs(q.datetime) >= fromMs);
      if (cfg.dumpdir) await dump(cfg, pair, tf, quotes);
      return { quotes, requests: 0, cached: 0, failed: 0 };
    }
    const symbol = GMO_SYMBOLS[pair];
    const spec = GMO_INTERVALS[tf];
    if (!symbol || !spec) throw new Error(`no GMO file for ${pair} ${tf}`);
    const keep = (q: QuoteCandle) => {
      const t = Date.parse(q.datetime);
      return Number.isFinite(t) && t >= fromMs && !weekendOut(t, step) && t + step <= cfg.now;
    };
    if (cfg.fixture) {
      const got = await fixtureQuotes(cfg, pair, tf);
      return { quotes: mergeSides(got.bid, got.ask).filter(keep), requests: 0, cached: 0, failed: got.failed };
    }
    let keys: string[];
    let fresh: Set<string>;
    if (spec.key === "day") {
      const today = jstDayKey(cfg.now);
      keys = dateKeys(fromMs, cfg.now, "day").filter((k) => k <= today);
      fresh = new Set(keys.slice(-3));
    } else {
      keys = [];
      for (let y = Number(jstYearKey(fromMs)); y <= Number(jstYearKey(cfg.now)); y++) keys.push(String(y));
      fresh = new Set(keys);
    }
    const bid: Array<{ t: number; c: Candle }> = [];
    const ask: typeof bid = [];
    let requests = 0;
    let cached = 0;
    let failed = 0;
    let cursor = 0;
    const worker = async () => {
      while (cursor < keys.length) {
        const key = keys[cursor++];
        for (const side of ["bid", "ask"] as const) {
          const path = `${cfg.cache}/${symbol}/${spec.name}/${side}/${key}.json`;
          let body: unknown;
          if (!fresh.has(key)) {
            try {
              body = JSON.parse(await Deno.readTextFile(path));
            } catch {
              body = undefined;
            }
            if (body !== undefined && !sound(body)) body = undefined;
          }
          if (body === undefined) {
            const r = await getJson(klineUrl(symbol, side, spec.name, key));
            requests++;
            body = r.status === 404 ? { status: 404, data: [] } : r.body;
            if (r.status === 0 || !sound(body)) {
              failed++;
              continue;
            }
            await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
            await Deno.writeTextFile(path, JSON.stringify(body));
          } else {
            cached++;
          }
          (side === "bid" ? bid : ask).push(...parseKlines(body));
        }
      }
    };
    await Promise.all(Array.from({ length: 8 }, worker));
    bid.sort((a, b) => a.t - b.t);
    ask.sort((a, b) => a.t - b.t);
    return { quotes: mergeSides(bid, ask).filter(keep), requests, cached, failed };
  };
  return { load, forget };
};

// ---- the 5-minute bars, as arrays ----------------------------------------------------------

// a pair's 5-minute bars: the open times, and the bid's and the ask's open,
// high, low and close
export interface Fine {
  n: number;
  t: Float64Array;
  bo: Float64Array;
  bh: Float64Array;
  bl: Float64Array;
  bc: Float64Array;
  ao: Float64Array;
  ah: Float64Array;
  al: Float64Array;
  ac: Float64Array;
}
export const toFine = (qs: QuoteCandle[]): Fine => {
  const n = qs.length;
  const f: Fine = { n, t: new Float64Array(n), bo: new Float64Array(n), bh: new Float64Array(n), bl: new Float64Array(n), bc: new Float64Array(n), ao: new Float64Array(n), ah: new Float64Array(n), al: new Float64Array(n), ac: new Float64Array(n) };
  qs.forEach((q, i) => {
    f.t[i] = barOpenMs(q.datetime);
    f.bo[i] = q.bid.open;
    f.bh[i] = q.bid.high;
    f.bl[i] = q.bid.low;
    f.bc[i] = q.bid.close;
    f.ao[i] = q.ask.open;
    f.ah[i] = q.ask.high;
    f.al[i] = q.ask.low;
    f.ac[i] = q.ask.close;
  });
  return f;
};
// the first index whose value is at or after `ms`
export const lowerBound = (xs: ArrayLike<number>, ms: number): number => {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (xs[m] < ms) lo = m + 1;
    else hi = m;
  }
  return lo;
};
// the first index whose value is after `ms`
export const upperBound = (xs: ArrayLike<number>, ms: number): number => {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (xs[m] <= ms) lo = m + 1;
    else hi = m;
  }
  return lo;
};
