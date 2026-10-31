// #318 (docs §8.113 1, 2, 20 (a)): GMO's day files of 5-minute and 1-minute bars, both sides, read from a
// folder (a made-up set's, written by chartbest-gen.ts) with the same reader the real files would go
// through. What is left out is counted (20 (a)): a side alone, an ask closing under its bid (and the share
// per pair · interval · UTC year, SQ-29), a repeated time, a bar inside the weekend's closure; and what must
// be zero is counted too: files not read, OHLC contradictions, bars outside the price band.
//
// The real path (GMO's API) is written but refuses unless every gate of the rule has passed (§5.4 of the
// plan: never in step 2); a made-up run is started without --allow-net.

import { GMO_SYMBOLS, klineUrl, parseKlines, type QuoteCandle } from "../supabase/functions/track-outcomes/quotes.ts";
import { barInsideClosure } from "../supabase/functions/_shared/market-hours.ts";
import type { Candle } from "../supabase/functions/analyze/indicators.ts";
import { getJson, keysOf, sound, type M1 } from "./ownerhold-data.ts";
import { MINUTE } from "./lib.ts";
import { BANDS, CROSSED_MAX, MADEUP_BAND, type Pair, type Period, START_MID_TICKS, STEP } from "./chartbest-const.ts";
import { digitsOf } from "./chartbest-bars.ts";

export type Interval = "5min" | "1min";
export const STEP_OF: Record<Interval, number> = { "5min": STEP, "1min": MINUTE };

export interface LoadDiag {
  pair: Pair;
  interval: Interval;
  files: number;
  failed: number;
  oneSide: number;
  crossed: number;
  dup: number;
  ohlc: number;
  closure: number;
  band: number;
  // 18 C1「中値が NaN の足は、番号を付ける前に取り除いて数を出す」: bar times removed because a side's row there had
  // a price that is not a finite number (both sides having a row), plus rows whose openTime is not a number
  nan: number;
  kept: number;
  // SQ-29: rows read (bid rows, before any drop) and crossed rows, by the UTC year of the bar's open
  byYear: Record<string, { rows: number; crossed: number }>;
}
export const newDiag = (pair: Pair, interval: Interval): LoadDiag => ({ pair, interval, files: 0, failed: 0, oneSide: 0, crossed: 0, dup: 0, ohlc: 0, closure: 0, band: 0, nan: 0, kept: 0, byYear: {} });

// the rows of a day file that parseKlines (quotes.ts, which drops them without a count) leaves out because a value is
// not a finite number, by the same test: { t } when the openTime is a number (a price is not), { t: null } when not
const numOf = (v: unknown): number => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : NaN;
};
export const nonFiniteRows = (body: unknown): Array<{ t: number | null }> => {
  const data = typeof body === "object" && body !== null ? (body as { data?: unknown }).data : undefined;
  if (!Array.isArray(data)) return [];
  const out: Array<{ t: number | null }> = [];
  for (const row of data) {
    if (typeof row !== "object" || row === null) {
      out.push({ t: null });
      continue;
    }
    const r = row as Record<string, unknown>;
    const t = numOf(r.openTime);
    if (!Number.isFinite(t)) out.push({ t: null });
    else if (![r.open, r.high, r.low, r.close].map(numOf).every(Number.isFinite)) out.push({ t });
  }
  return out;
};

// the folder the day files are in: a made-up set's own (`dir/SYM/interval/side/YYYYMMDD.json`), or real
export interface Src {
  dir: string;
  real: boolean;
}

// §5.4: the gate of the real path, set only by the stage entries after every guard has passed
let realGate: string | null = null;
export const openRealGate = (why: string) => {
  realGate = why;
};
export const realAllowed = (): boolean => realGate !== null;

const readFile = async (src: Src, pair: Pair, interval: Interval, side: "bid" | "ask", key: string): Promise<unknown | null> => {
  const symbol = GMO_SYMBOLS[pair];
  const path = `${src.dir}/${symbol}/${interval}/${side}/${key}.json`;
  if (src.real) {
    if (!realAllowed()) throw new Error("the real GMO path is shut: the rule's gates have not passed (§8.113 22, plan §5.4)");
    try {
      const body = JSON.parse(await Deno.readTextFile(path));
      if (sound(body)) return body;
    } catch {
      // not kept: asked of GMO below
    }
    const r = await getJson(klineUrl(symbol, side, interval, key));
    if (r.status === 404) return { status: 0, data: [] };
    if (r.status === 0 || !sound(r.body)) return null;
    await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    await Deno.writeTextFile(path, JSON.stringify(r.body));
    return r.body;
  }
  try {
    const body = JSON.parse(await Deno.readTextFile(path));
    return sound(body) ? body : null;
  } catch {
    return null;
  }
};

const yearOf = (t: number): string => String(new Date(t).getUTCFullYear());
const ohlcBad = (c: Candle): boolean => !(c.high >= Math.max(c.open, c.close) && c.low <= Math.min(c.open, c.close) && c.high >= c.low);
export const bandOf = (pair: Pair, madeUp: boolean): readonly [number, number] => {
  if (!madeUp) return BANDS[pair];
  const mid = START_MID_TICKS[pair] / 10 ** digitsOf(pair);
  return [MADEUP_BAND[0] * mid, MADEUP_BAND[1] * mid];
};
const outOfBand = (c: Candle, b: readonly [number, number]): boolean =>
  [c.open, c.high, c.low, c.close].some((v) => !(v >= b[0] && v <= b[1]));

// One pair's bars of one interval, opened at or after S0 and closed by END, both sides, oldest first
export const loadBars = async (src: Src, pair: Pair, interval: Interval, period: Period, madeUp: boolean): Promise<{ quotes: QuoteCandle[]; diag: LoadDiag }> => {
  const diag = newDiag(pair, interval);
  const step = STEP_OF[interval];
  const band = bandOf(pair, madeUp);
  const { keys } = keysOf(period.s0, period.end);
  const bid = new Map<number, Candle>();
  const ask = new Map<number, Candle>();
  // the times of a side's rows with a price that is not a finite number (spec-nan-count: counted, then dropped)
  const nanAt = { bid: new Set<number>(), ask: new Set<number>() };
  const rowsSeen = new Map<number, boolean>();
  for (const key of keys) {
    for (const side of ["bid", "ask"] as const) {
      const body = await readFile(src, pair, interval, side, key);
      if (body === null) {
        diag.failed++;
        continue;
      }
      diag.files++;
      const m = side === "bid" ? bid : ask;
      for (const r of parseKlines(body)) {
        if (m.has(r.t) || nanAt[side].has(r.t)) {
          diag.dup++;
          continue;
        }
        m.set(r.t, r.c);
        if (side === "bid") rowsSeen.set(r.t, true);
      }
      for (const r of nonFiniteRows(body)) {
        if (r.t === null) diag.nan++;
        else if (m.has(r.t) || nanAt[side].has(r.t)) diag.dup++;
        else nanAt[side].add(r.t);
      }
    }
  }
  for (const t of rowsSeen.keys()) {
    const y = yearOf(t);
    (diag.byYear[y] ??= { rows: 0, crossed: 0 }).rows++;
  }
  const times = [...new Set([...bid.keys(), ...ask.keys(), ...nanAt.bid, ...nanAt.ask])].sort((a, b) => a - b);
  const quotes: QuoteCandle[] = [];
  for (const t of times) {
    const b = bid.get(t);
    const a = ask.get(t);
    // a side with no row at all: one side; both sides with a row, one of them not finite: NaN (before any number)
    if (!(b || nanAt.bid.has(t)) || !(a || nanAt.ask.has(t))) {
      diag.oneSide++;
      continue;
    }
    if (!b || !a) {
      diag.nan++;
      continue;
    }
    if (a.close < b.close) {
      diag.crossed++;
      (diag.byYear[yearOf(t)] ??= { rows: 0, crossed: 0 }).crossed++;
      continue;
    }
    if (t < period.s0 || t + step > period.end) continue;
    if (barInsideClosure(t, step)) {
      diag.closure++;
      continue;
    }
    if (ohlcBad(b) || ohlcBad(a)) diag.ohlc++;
    if (outOfBand(b, band) || outOfBand(a, band)) diag.band++;
    quotes.push({ datetime: b.datetime, bid: b, ask: a });
  }
  diag.kept = quotes.length;
  return { quotes, diag };
};

// 20 (c)'s rehearsal only (SQ-06, plan §1.1 readAllJsonLayout): research/macdx.ts MODE=walk keeps its walk as one file a
// side (dir/SYM/5min/side/all.json, GMO's shape). Its 5-minute bars read the way macdx.ts reads them (mergeSides: a time
// with both sides, an ask closing under its bid left out; opened at or after S0, closed by END, not inside the closure),
// so the chart and the measures are made from the very bars macdx.ts made its own from. Made-up files only.
export const loadAllJsonLayout = async (dir: string, pair: Pair, period: Period): Promise<{ quotes: QuoteCandle[]; diag: LoadDiag }> => {
  const diag = newDiag(pair, "5min");
  const symbol = GMO_SYMBOLS[pair];
  const side = async (s: "bid" | "ask") => {
    const body = JSON.parse(await Deno.readTextFile(`${dir}/${symbol}/5min/${s}/all.json`)) as unknown;
    if (!sound(body)) throw new Error(`${dir}/${symbol}/5min/${s}/all.json: not GMO's shape`);
    diag.files++;
    return parseKlines(body);
  };
  const bid = await side("bid");
  const ask = new Map((await side("ask")).map((x) => [x.t, x.c]));
  const seen = new Set<number>();
  const quotes: QuoteCandle[] = [];
  for (const b of bid.sort((x, y) => x.t - y.t)) {
    if (seen.has(b.t)) {
      diag.dup++;
      continue;
    }
    seen.add(b.t);
    const a = ask.get(b.t);
    if (!a) {
      diag.oneSide++;
      continue;
    }
    if (a.close < b.c.close) {
      diag.crossed++;
      continue;
    }
    if (b.t < period.s0 || b.t + STEP > period.end) continue;
    if (barInsideClosure(b.t, STEP)) {
      diag.closure++;
      continue;
    }
    quotes.push({ datetime: b.c.datetime, bid: b.c, ask: a });
  }
  diag.kept = quotes.length;
  return { quotes, diag };
};

// The 1-minute bars as ownerhold-data's M1 (the owner's way reads them)
export const m1Of = (pair: Pair, quotes: QuoteCandle[]): M1 => {
  const n = quotes.length;
  const F = () => new Float64Array(n);
  const m: M1 = { pair, n, t: F(), bo: F(), bh: F(), bl: F(), bc: F(), ao: F(), ah: F(), al: F(), ac: F() };
  quotes.forEach((q, k) => {
    m.t[k] = Date.parse(q.datetime);
    m.bo[k] = q.bid.open;
    m.bh[k] = q.bid.high;
    m.bl[k] = q.bid.low;
    m.bc[k] = q.bid.close;
    m.ao[k] = q.ask.open;
    m.ah[k] = q.ask.high;
    m.al[k] = q.ask.low;
    m.ac[k] = q.ask.close;
  });
  return m;
};

// 20 (a) (§8.111 B4): the 5-minute slots holding a 1-minute bar but no 5-minute bar
export const minuteWithoutFive = (m1Times: ArrayLike<number>, fiveTimes: ArrayLike<number>): number => {
  const five = new Set<number>();
  for (let k = 0; k < fiveTimes.length; k++) five.add(fiveTimes[k]);
  const missing = new Set<number>();
  for (let k = 0; k < m1Times.length; k++) {
    const slot = Math.floor(m1Times[k] / STEP) * STEP;
    if (!five.has(slot)) missing.add(slot);
  }
  return missing.size;
};

// 20 (a): the share of crossed rows per pair · interval · UTC year (SQ-29), the worst one
export const crossedWorst = (d: LoadDiag): { year: string; share: number } | null => {
  let worst: { year: string; share: number } | null = null;
  for (const [year, v] of Object.entries(d.byYear)) {
    const share = v.rows ? v.crossed / v.rows : 0;
    if (!worst || share > worst.share) worst = { year, share };
  }
  return worst;
};
export const crossedOk = (d: LoadDiag): boolean => (crossedWorst(d)?.share ?? 0) <= CROSSED_MAX;

// the log line of a read (20 (i))
export const readLine = (d: LoadDiag): string =>
  `read ${d.pair} ${d.interval} files=${d.files} failed=${d.failed} oneSide=${d.oneSide} crossed=${d.crossed} dup=${d.dup} ohlc=${d.ohlc} closure=${d.closure} band=${d.band} nan=${d.nan}`;

export const sha256Hex = async (bytes: Uint8Array): Promise<string> =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)))).map((b) => b.toString(16).padStart(2, "0")).join("");
export const fileSha = async (path: string): Promise<string> => sha256Hex(await Deno.readFile(path));
