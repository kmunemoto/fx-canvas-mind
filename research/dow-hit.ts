// #179: how often the live chart's Dow line is right while it is shown
// (docs §8.90). The owner, on a screenshot of the chart whose line read
// "ダウ 4H 下降 · 1H 下降 · 15M 上昇の兆し · 5M 上昇": 「赤丸のダウの予想の的中率
// は？」, then 「はかります」.
//
// THE METHOD, fixed before any real data was read (docs §8.90; the draft was
// reviewed from three sides — statistics, faithfulness to the chart, and
// pitfalls — and their findings went in before this was written):
//
//   * Pairs: the 14 GMO pairs the chart shows (LIVE_PAIRS without the ones
//     read from Twelve Data and gold). HUF/JPY and SEK/JPY have GMO data from
//     2026-05 only: the verdicts are taken on the other 12, those two shown
//     apart. Timeframes: the line's own, 5min, 15min, 1h and 4h. From
//     2024-01-01 to the newest closed bar; halves split at 2025-07-01.
//   * The label is what the chart shows: _shared/dow.ts dowTheory over the
//     closed bars live-chart reads (fetchDowQuotes: the newest DOW_BARS + 1
//     usable bars of the day files it walks, or of this and last JST year's
//     files for 4h; splitBars; unrounded mids), the state of the newest one.
//     Fewer than 300 closed bars: not counted. Checked against
//     fetchDowQuotes -> splitBars -> dowOf themselves on a sample of moments
//     (a fetcher serving the files kept here): no mismatch is the condition
//     for reading the numbers.
//   * When: at every 5-minute close C, each timeframe's line is the state of
//     its newest bar closed by C (start + length <= C) — what is on the
//     screen then, so counted in proportion to the time it is shown. Also
//     the first 5 minutes of each new state ("onset"), entered at C (an upper
//     bound: the chart shows a new state 0–90 seconds late) and at the next
//     5-minute close ("late").
//   * Outcomes, followed on GMO's 5-minute bars from C:
//       O1 (the verdict): bands ATR(14) of the timeframe (Wilder, to its
//          newest closed bar) above and below the mid close at C; the side
//          the line points to reached first = 1, the other = 0, both inside
//          one 5-minute bar = 0.5; neither within 48 of the timeframe's bars
//          (as 5-minute bars of open market) = not counted.
//       O2: the mid 12 of the timeframe's bars later against C's: up/down,
//          equal = 0.5.
//       O3 (traded, spread paid): in at C on the book side (BUY the ask,
//          SELL the bid), stop and target 1 ATR away, followed on bid/ask; a
//          bar opening past a level fills at its open, one reaching both is
//          the stop; still open after 48 bars, out at the last price. Win
//          rate over the resolved, R a trade (ATR = 1R) over all. Shown for
//          the 12, and apart for the majors, TRY/ZAR/MXN and HUF/SEK.
//   * Blind ("ランダム"): the same outcome at every 5-minute close of the
//     same pair, timeframe, half, direction and UTC hour. A label's
//     expectation is its cell's rate; lift = mean(outcome − expectation).
//     95% intervals cluster by calendar week (common to all pairs) and carry
//     the error of the cell rates (influence function); on 4h also by four
//     weeks, the wider used.
//   * Zero point: 20 runs of a walk with no effect (14 correlated pairs,
//     volatility regimes, jumps, weekends) through all of this; where their
//     mean lift is off 0, it is the zero; where their intervals miss 0 far
//     from 5% of the time, their spread is the interval.
//   * Verdicts (no ranking): "can predict" for one of the 24 cells — the
//     four states × four timeframes, and all four aligned up / down × four
//     timeframes — only when O1's lift is above the zero, its interval
//     clear, in both halves, on the 12 pairs. "Can win" only when O3's R a
//     trade itself has its interval above 0 in both halves. The smallest
//     difference each could find (about twice the half-width) is printed. A
//     rate of 65% or more anywhere is checked for look-ahead before it is
//     reported.
//   * Described, never used for a verdict: each label against the next
//     higher timeframe's direction; the owner's mixed line (4H and 1H the
//     same trend, 15M and 5M both the other way) on 1h; the age of the state.
//   * Left out and counted: a close whose next 5-minute bar opens 30 minutes
//     or more later; ATR under 4 price ticks; a gap of 30 minutes or more
//     that the market's hours do not explain inside the label's window or
//     the 5-minute bars followed; a sample whose follow runs past the data.
//   * Data: GMO's bid/ask klines (5min, 15min, 1hour day files; 4hour year
//     files) as the chart reads them. Kept files are used, the last ten days
//     and every year file are read again, and a file next to an unexplained
//     gap is read again once. Holes and failed reads are printed first.
//
// SETTLED WHILE WRITING THIS, before any real data was read (docs §8.90):
//   * "late" enters at the close of the next 5-minute bar and measures from
//     there: its bands sit around that close (the same ATR), followed from
//     the bar after it — what entering then would have met.
//   * A stamp missing from nearly every pair at once (80% or more of the
//     pairs that have data around it) is GMO's own closure — a holiday, or
//     the feed itself down — when the chart had no bar either, not a file
//     read badly here: it is not counted as a hole. Only holes of one pair
//     are. The dates are printed.
//   * "Far from 5%": the null intervals miss 0 more than 10% of the time on
//     a timeframe (twice the nominal); then that timeframe's interval is the
//     wider of its own and the walks' spread. The zero's own error (the
//     spread over √20) is always added.
//   * A price tick is read off the data (the most decimals GMO's prices of
//     the pair carry); the walks use the chart's decimals.
//   * Look-ahead yardsticks reported beside the verdicts: a label that knows
//     the answer (the band O1 reached first; it must score ~100%), and the
//     Dow state one bar ahead; what one bar of look-ahead adds is its lift
//     less the plain label's, printed too.
//   * After the review (still before any real data): the chart check takes
//     only moments whose bars all closed by the data's end — the files, read
//     after it, hold the bar forming then, which the bars here leave out, so
//     the last moments would differ for that alone (none of them counted:
//     their follow runs past the data). The walks' miss rate is printed by
//     label as well as by timeframe; every rate of 65% or more is listed,
//     those under 100 samples marked. A kept day file stopping less than 30
//     minutes before its day's end is not found (no hole next to it); the
//     last ten days are always read again.
//
// MODE=real reads GMO; MODE=null|momentum|meanrev runs a seeded walk
// (SEEDS=1,2,...) instead; MODE=report reads the JSON the others left in
// REPORT_DIR and prints the verdicts.

import type { Candle } from "../supabase/functions/analyze/indicators.ts";
import {
  GMO_INTERVALS,
  GMO_SYMBOLS,
  type Fetcher,
  jstDayKey,
  jstYearKey,
  klineUrl,
  mergeSides,
  parseKlines,
  type QuoteCandle,
} from "../supabase/functions/track-outcomes/quotes.ts";
import { isMarketClosed, isPossiblyClosed } from "../supabase/functions/_shared/market-hours.ts";
import { atrSeriesOf } from "../supabase/functions/analyze/state.ts";
import { dowTheory } from "../supabase/functions/_shared/dow.ts";
import { DOW_BARS, LIVE_PAIRS, LIVE_STEP_MS, dowOf, fetchDowQuotes, isTwelvePair, splitBars } from "../supabase/functions/live-chart/logic.ts";
import { DAY, HOUR, MINUTE, WEEK, WEEK_OFFSET, iso } from "./lib.ts";

const TFS = ["5min", "15min", "1h", "4h"] as const;
type Tf = (typeof TFS)[number];
const NT = TFS.length;
const FINE = 5 * MINUTE;
// the chart shows a new state a minute or so after the close (its poll)
const LAG = 60_000;
const HBARS = 48;
const NDIR = 12;
const ATR_TICKS = 4;
const GAP = 30 * MINUTE;
const WINDOW = DOW_BARS;
const JST = 9 * HOUR;

const MODE = Deno.env.get("MODE") || "real";
const SYNTH = MODE === "null" || MODE === "momentum" || MODE === "meanrev";
if (!SYNTH && MODE !== "real" && MODE !== "report") throw new Error(`unknown MODE ${MODE}`);
const SEEDS = (Deno.env.get("SEEDS") || "1").split(",").map((s) => Number(s.trim())).filter((x) => Number.isFinite(x));
const DEFAULT_PAIRS = LIVE_PAIRS.filter((p) => GMO_SYMBOLS[p] !== undefined && !isTwelvePair(p));
const PAIRS = (Deno.env.get("PAIRS") || DEFAULT_PAIRS.join(",")).split(",").map((s) => s.trim()).filter(Boolean);
const START = Deno.env.get("START") || "2024-01-01";
const SPLIT = Deno.env.get("SPLIT") || "2025-07-01";
const START_MS = Date.parse(`${START}T00:00:00Z`);
const SPLIT_MS = Date.parse(`${SPLIT}T00:00:00Z`);
const END_ENV = Deno.env.get("END");
const NOW = END_ENV ? Date.parse(END_ENV.includes("T") ? END_ENV : `${END_ENV}T00:00:00Z`) : Date.now();
const CACHE = "research/.cache";
const OUT = Deno.env.get("OUTDIR") || "research/out";
const REPORT_DIR = Deno.env.get("REPORT_DIR") || "research/in";
// live-path checks a pair and timeframe, drawn evenly (the special moments come on top)
const CHECKS = Number(Deno.env.get("CHECKS") || "300");
// look-ahead checks on the walks: cut points
const PERTURB = Number(Deno.env.get("PERTURB") || "20");

// HUF/JPY and SEK/JPY: GMO from 2026-05 only
const LATE = new Set(["HUF/JPY", "SEK/JPY"]);
const TZM = new Set(["TRY/JPY", "ZAR/JPY", "MXN/JPY"]);
const GROUPS = ["12", "HS", "MAJ", "TZM"] as const;
const NG = GROUPS.length;
const mainGroup = (pair: string) => (LATE.has(pair) ? 1 : 0);
const tradedGroup = (pair: string) => (LATE.has(pair) ? 1 : TZM.has(pair) ? 3 : 2);
const chartDecimals = (pair: string) => (pair.includes("JPY") ? 3 : 5);

// day-file walk of fetchRecentQuotes (analyze/price-source.ts), sized for
// DOW_BARS + 1 bars: how many calendar days back it may look
const spanDays = (tf: Tf): number => {
  const perDay = Math.max(1, Math.floor(DAY / LIVE_STEP_MS[tf]));
  const openDays = Math.ceil((WINDOW + 1) / perDay);
  return Math.ceil((openDays * 7) / 5) + 2;
};
// the oldest file key that walk (or fetchYearQuotes) reads at nowMs, as a number
const oldestKey = (tf: Tf, nowMs: number): number =>
  tf === "4h" ? Number(jstYearKey(nowMs)) - 1 : Number(jstDayKey(nowMs - (spanDays(tf) + 1) * DAY));
const jstDay = (ms: number) => Math.floor((ms + JST) / DAY);

// calendar weeks from Sunday 21:00 UTC, counted from START's
const W0 = Math.floor((START_MS - WEEK_OFFSET) / WEEK);
const NW = Math.max(1, Math.floor((NOW - WEEK_OFFSET) / WEEK) - W0 + 1);
const weekOf = (ms: number) => Math.floor((ms - WEEK_OFFSET) / WEEK) - W0;

// ---- bars ----------------------------------------------------------------------------

interface Bars {
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
  // the key of the file the bar is read from (a day YYYYMMDD or a year YYYY)
  key: Int32Array;
}
const emptyBars = (n: number): Bars => ({
  n,
  t: new Float64Array(n),
  bo: new Float64Array(n),
  bh: new Float64Array(n),
  bl: new Float64Array(n),
  bc: new Float64Array(n),
  ao: new Float64Array(n),
  ah: new Float64Array(n),
  al: new Float64Array(n),
  ac: new Float64Array(n),
  key: new Int32Array(n),
});
const fromQuotes = (qs: QuoteCandle[], keyOf: (t: number) => number): Bars => {
  const b = emptyBars(qs.length);
  qs.forEach((q, i) => {
    const t = Date.parse(q.datetime);
    b.t[i] = t;
    b.bo[i] = q.bid.open;
    b.bh[i] = q.bid.high;
    b.bl[i] = q.bid.low;
    b.bc[i] = q.bid.close;
    b.ao[i] = q.ask.open;
    b.ah[i] = q.ask.high;
    b.al[i] = q.ask.low;
    b.ac[i] = q.ask.close;
    b.key[i] = keyOf(t);
  });
  return b;
};
const sliceBars = (b: Bars, from: number, to: number): Bars => ({
  n: to - from,
  t: b.t.slice(from, to),
  bo: b.bo.slice(from, to),
  bh: b.bh.slice(from, to),
  bl: b.bl.slice(from, to),
  bc: b.bc.slice(from, to),
  ao: b.ao.slice(from, to),
  ah: b.ah.slice(from, to),
  al: b.al.slice(from, to),
  ac: b.ac.slice(from, to),
  key: b.key.slice(from, to),
});
const pickBars = (b: Bars, idx: number[]): Bars => {
  const out = emptyBars(idx.length);
  idx.forEach((i, j) => {
    out.t[j] = b.t[i];
    out.bo[j] = b.bo[i];
    out.bh[j] = b.bh[i];
    out.bl[j] = b.bl[i];
    out.bc[j] = b.bc[i];
    out.ao[j] = b.ao[i];
    out.ah[j] = b.ah[i];
    out.al[j] = b.al[i];
    out.ac[j] = b.ac[i];
    out.key[j] = b.key[i];
  });
  return out;
};
// the same arithmetic as analyze/price-source.ts midCandle
const midClose = (b: Bars, i: number) => (b.bc[i] + b.ac[i]) / 2;
const midHigh = (b: Bars, i: number) => (b.bh[i] + b.ah[i]) / 2;
const midLow = (b: Bars, i: number) => (b.bl[i] + b.al[i]) / 2;

// a bar stamped s belongs in GMO's file and is kept by the chart: not
// stamped while the market is shut (usableBars), and with some of its time
// certainly open
const shouldExist = (s: number, step: number): boolean => {
  if (isMarketClosed(s)) return false;
  for (let m = s; m < s + step; m += FINE) if (!isPossiblyClosed(m)) return true;
  return false;
};
// a hole of GAP or more between bar i and i+1 that neither the market's
// hours nor GMO's own closures (`holes`) explain
const unexplainedGap = (b: Bars, i: number, step: number, holes: Set<number> | null): boolean => {
  const from = b.t[i] + step;
  const to = b.t[i + 1];
  if (to - from < GAP) return false;
  let missing = 0;
  for (let s = from; s < to; s += step) if (shouldExist(s, step) && !(holes !== null && holes.has(s))) missing += step;
  return missing >= GAP;
};
// prefix sums of the holes after each bar
const gapPrefix = (b: Bars, step: number, holes: Set<number> | null): Int32Array => {
  const p = new Int32Array(b.n + 1);
  for (let i = 0; i < b.n; i++) p[i + 1] = p[i] + (i + 1 < b.n && unexplainedGap(b, i, step, holes) ? 1 : 0);
  return p;
};
// any hole between bar lo and bar hi
const holeIn = (p: Int32Array, lo: number, hi: number): boolean => hi > lo && p[hi] - p[lo] > 0;

const lowerBound = (xs: ArrayLike<number>, v: number): number => {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (xs[m] < v) lo = m + 1;
    else hi = m;
  }
  return lo;
};
const hashStr = (s: string) => [...s].reduce((a, ch) => (Math.imul(a, 31) + ch.charCodeAt(0)) | 0, 7);

// The stamps of a timeframe missing from nearly every pair that has data
// around them: GMO's own closures
const commonMissing = (series: Bars[], step: number): Set<number> => {
  let lo = Infinity;
  let hi = -Infinity;
  for (const b of series) {
    if (b.n === 0) continue;
    lo = Math.min(lo, b.t[0]);
    hi = Math.max(hi, b.t[b.n - 1]);
  }
  const out = new Set<number>();
  if (!(hi >= lo)) return out;
  const n = Math.round((hi - lo) / step) + 1;
  const cover = new Uint8Array(n);
  const miss = new Uint8Array(n);
  for (const b of series) {
    if (b.n === 0) continue;
    const present = new Uint8Array(n);
    for (let i = 0; i < b.n; i++) {
      const j = Math.round((b.t[i] - lo) / step);
      if (j >= 0 && j < n) present[j] = 1;
    }
    const j0 = Math.round((b.t[0] - lo) / step);
    const j1 = Math.round((b.t[b.n - 1] - lo) / step);
    for (let j = j0; j <= j1; j++) {
      cover[j]++;
      if (!present[j]) miss[j]++;
    }
  }
  for (let j = 0; j < n; j++) {
    if (cover[j] < 5 || miss[j] < 0.8 * cover[j]) continue;
    const s = lo + j * step;
    if (shouldExist(s, step)) out.add(s);
  }
  return out;
};

// ---- GMO's files ---------------------------------------------------------------------

const getJson = async (url: string): Promise<{ status: number; body: unknown }> => {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const r = await fetch(url);
      if (r.status === 404) {
        await r.body?.cancel();
        return { status: 404, body: null };
      }
      if (r.status === 429 || r.status >= 500) {
        await r.body?.cancel();
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
const cachePath = (symbol: string, interval: string, side: string, key: string) => `${CACHE}/${symbol}/${interval}/${side}/${key}.json`;

interface LoadStats {
  requests: number;
  cached: number;
  failed: number;
  refetched: number;
  failedKeys: string[];
  // bars whose file key is older than the bar before's
  keyOrder: number;
}
const newStats = (): LoadStats => ({ requests: 0, cached: 0, failed: 0, refetched: 0, failedKeys: [], keyOrder: 0 });

// The bars the chart keeps (quotes.ts usableBars: none stamped while the
// market is shut) of one pair and timeframe from `fromMs`, closed by the
// data's end, each with the key of the newest file it is in (the walk reads
// a bar if any file holding it is new enough)
const loadReal = async (pair: string, tf: Tf, fromMs: number, stats: LoadStats): Promise<Bars> => {
  const symbol = GMO_SYMBOLS[pair];
  const spec = GMO_INTERVALS[tf];
  if (!symbol || !spec) throw new Error(`no GMO file for ${pair} ${tf}`);
  const step = LIVE_STEP_MS[tf];
  const keys: string[] = [];
  if (spec.key === "day") {
    const today = jstDayKey(NOW);
    for (let ms = fromMs - DAY; jstDayKey(ms) <= today; ms += DAY) {
      const k = jstDayKey(ms);
      if (keys[keys.length - 1] !== k) keys.push(k);
    }
  } else {
    for (let y = Number(jstYearKey(fromMs)); y <= Number(jstYearKey(NOW)); y++) keys.push(String(y));
  }
  const freshFrom = jstDayKey(NOW - 10 * DAY);
  const bodies = new Map<string, { bid: unknown; ask: unknown }>();
  const fetched = new Set<string>();
  const read = async (key: string, force: boolean) => {
    const got: { bid: unknown; ask: unknown } = { bid: null, ask: null };
    for (const side of ["bid", "ask"] as const) {
      const path = cachePath(symbol, spec.name, side, key);
      let body: unknown;
      if (!force) {
        try {
          body = JSON.parse(await Deno.readTextFile(path));
        } catch {
          body = undefined;
        }
        if (body !== undefined && !sound(body)) body = undefined;
      }
      if (body === undefined) {
        const r = await getJson(klineUrl(symbol, side, spec.name, key));
        stats.requests++;
        body = r.status === 404 ? { status: 404, data: [] } : r.body;
        if (r.status === 0 || !sound(body)) {
          stats.failed++;
          stats.failedKeys.push(`${pair} ${tf} ${key} ${side}`);
          body = { status: 0, data: [] };
        } else {
          await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
          await Deno.writeTextFile(path, JSON.stringify(body));
        }
        fetched.add(key);
      } else {
        stats.cached++;
      }
      got[side] = body;
    }
    bodies.set(key, got);
  };
  let cursor = 0;
  const worker = async () => {
    while (cursor < keys.length) {
      const key = keys[cursor++];
      await read(key, spec.key === "year" || key >= freshFrom);
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));

  const build = (): Bars => {
    const bid: Array<{ t: number; c: Candle }> = [];
    const ask: typeof bid = [];
    const keyOfT = new Map<number, number>();
    for (const key of keys) {
      const b = bodies.get(key);
      if (!b) continue;
      const kn = Number(key);
      for (const x of parseKlines(b.bid)) {
        bid.push(x);
        const was = keyOfT.get(x.t);
        if (was === undefined || kn > was) keyOfT.set(x.t, kn);
      }
      ask.push(...parseKlines(b.ask));
    }
    // stable: of a bar two files hold, the older file's comes first, as in
    // the walk (which puts each older file in front)
    bid.sort((a, b) => a.t - b.t);
    ask.sort((a, b) => a.t - b.t);
    const qs = mergeSides(bid, ask).filter((q) => {
      const t = Date.parse(q.datetime);
      return Number.isFinite(t) && t >= fromMs && !isMarketClosed(t) && t + step <= NOW;
    });
    return fromQuotes(qs, (t) => keyOfT.get(t) ?? Number(spec.key === "year" ? jstYearKey(t) : jstDayKey(t)));
  };
  let bars = build();
  // a day file next to a hole the market's hours do not explain is read
  // again once (a file kept while its day was still running stops early)
  if (spec.key === "day") {
    const again = new Set<string>();
    for (let i = 0; i + 1 < bars.n; i++) {
      if (!unexplainedGap(bars, i, step, null)) continue;
      const a = bars.key[i];
      const b = bars.key[i + 1];
      for (const k of keys) if (Number(k) >= a && Number(k) <= b && !fetched.has(k)) again.add(k);
    }
    const list = [...again].slice(0, 400);
    for (const k of list) await read(k, true);
    stats.refetched += list.length;
    if (list.length > 0) bars = build();
  }
  for (let i = 1; i < bars.n; i++) if (bars.key[i] < bars.key[i - 1]) stats.keyOrder++;
  return bars;
};

// the most decimals the pair's prices carry (up to 6)
const decimalsIn = (b: Bars): number => {
  let d = 0;
  const every = Math.max(1, Math.floor(b.n / 2000));
  for (let i = 0; i < b.n; i += every) {
    for (const x of [b.bc[i], b.ac[i]]) {
      let e = d;
      while (e < 6 && Math.abs(x * 10 ** e - Math.round(x * 10 ** e)) > 1e-6) e++;
      d = Math.max(d, e);
    }
  }
  return d;
};

// ---- the walks (MODE null | momentum | meanrev) ------------------------------------------

const SYN: Record<string, { px: number; sd: number; spread: number }> = {
  "USD/JPY": { px: 150, sd: 0.025, spread: 0.003 },
  "EUR/JPY": { px: 170, sd: 0.03, spread: 0.005 },
  "GBP/JPY": { px: 200, sd: 0.04, spread: 0.008 },
  "AUD/JPY": { px: 100, sd: 0.025, spread: 0.006 },
  "EUR/USD": { px: 1.12, sd: 0.0002, spread: 0.00004 },
  "AUD/USD": { px: 0.66, sd: 0.00018, spread: 0.00006 },
  "MXN/JPY": { px: 8, sd: 0.004, spread: 0.003 },
  "NZD/JPY": { px: 88, sd: 0.025, spread: 0.008 },
  "ZAR/JPY": { px: 8.5, sd: 0.005, spread: 0.004 },
  "CAD/JPY": { px: 108, sd: 0.025, spread: 0.008 },
  "CHF/JPY": { px: 185, sd: 0.03, spread: 0.012 },
  "TRY/JPY": { px: 3.6, sd: 0.002, spread: 0.006 },
  "HUF/JPY": { px: 0.45, sd: 0.0004, spread: 0.006 },
  "SEK/JPY": { px: 15.9, sd: 0.008, spread: 0.008 },
};
const rng = (seed: number) => {
  let s = seed | 0;
  const u = () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const n = () => {
    const a = Math.max(u(), 1e-12);
    return Math.sqrt(-2 * Math.log(a)) * Math.cos(2 * Math.PI * u());
  };
  return { u, n };
};

// the open-market 5-minute grid and its common factor, once a seed
let grid: Float64Array = new Float64Array(0);
let factor: Float64Array = new Float64Array(0);
const gridFor = (seed: number, fromMs: number) => {
  const ts: number[] = [];
  for (let ms = Math.floor(fromMs / FINE) * FINE; ms + FINE <= NOW; ms += FINE) if (!isMarketClosed(ms)) ts.push(ms);
  grid = Float64Array.from(ts);
  const r = rng(seed * 7919 + 13);
  factor = new Float64Array(ts.length);
  for (let i = 0; i < ts.length; i++) factor[i] = r.n();
};
const synthFine = (pair: string, seed: number): Bars => {
  const p = SYN[pair] ?? { px: 100, sd: 0.025, spread: 0.005 };
  const g = grid;
  const f = factor;
  const r = rng(seed * 104729 + hashStr(pair));
  const lateFrom = LATE.has(pair) ? Date.parse("2026-05-18T00:00:00Z") : -Infinity;
  const i0 = lowerBound(g, lateFrom);
  const n = g.length - i0;
  const b = emptyBars(n);
  const sdLog = p.sd / p.px;
  let x = 0;
  let level = 0;
  let vol = 1;
  let regimeLeft = 0;
  let sign = 1;
  for (let k = 0; k < n; k++) {
    const gi = i0 + k;
    if (r.u() < 1 / 288) vol = Math.exp(0.5 * r.n());
    let ret = sdLog * vol * (Math.SQRT1_2 * f[gi] + Math.SQRT1_2 * r.n());
    if (r.u() < 1 / 3000) ret += (r.u() < 0.5 ? -4 : 4) * sdLog * vol;
    if (MODE === "momentum") {
      if (regimeLeft <= 0) {
        regimeLeft = Math.exp(Math.log(24) + r.u() * (Math.log(4000) - Math.log(24)));
        sign = r.u() < 0.5 ? -1 : 1;
      }
      regimeLeft--;
      ret += 0.08 * sdLog * sign;
    } else if (MODE === "meanrev") {
      level += 0.3 * sdLog * r.n();
      ret += -0.05 * (x - level);
    }
    const o = x;
    x = o + ret;
    const wick = () => Math.abs(r.n()) * 0.3 * sdLog * vol;
    const h = Math.max(o, x) + wick();
    const l = Math.min(o, x) - wick();
    const half = p.spread / 2;
    const m = (v: number) => p.px * Math.exp(v);
    b.t[k] = g[gi];
    b.bo[k] = m(o) - half;
    b.bh[k] = m(h) - half;
    b.bl[k] = m(l) - half;
    b.bc[k] = m(x) - half;
    b.ao[k] = m(o) + half;
    b.ah[k] = m(h) + half;
    b.al[k] = m(l) + half;
    b.ac[k] = m(x) + half;
    b.key[k] = Number(jstDayKey(g[gi]));
  }
  return b;
};
// coarser bars from the 5-minute ones, stamped at their start (GMO's 4-hour
// bars start at 0, 4, 8... UTC), those closed by the data's end: `raw` as a
// file would hold them, `usable` as the chart keeps them
const aggregateBars = (f: Bars, step: number, yearKey: boolean): { raw: Bars; usable: Bars } => {
  const idx: number[] = [];
  let last = Number.NaN;
  for (let i = 0; i < f.n; i++) {
    const k = Math.floor(f.t[i] / step);
    if (k !== last) {
      idx.push(i);
      last = k;
    }
  }
  const out = emptyBars(idx.length);
  idx.forEach((s, j) => {
    const e = j + 1 < idx.length ? idx[j + 1] - 1 : f.n - 1;
    const t = Math.floor(f.t[s] / step) * step;
    out.t[j] = t;
    out.bo[j] = f.bo[s];
    out.ao[j] = f.ao[s];
    out.bc[j] = f.bc[e];
    out.ac[j] = f.ac[e];
    let bh = -Infinity;
    let bl = Infinity;
    let ah = -Infinity;
    let al = Infinity;
    for (let i = s; i <= e; i++) {
      bh = Math.max(bh, f.bh[i]);
      bl = Math.min(bl, f.bl[i]);
      ah = Math.max(ah, f.ah[i]);
      al = Math.min(al, f.al[i]);
    }
    out.bh[j] = bh;
    out.bl[j] = bl;
    out.ah[j] = ah;
    out.al[j] = al;
    out.key[j] = Number(yearKey ? jstYearKey(t) : jstDayKey(t));
  });
  let m = out.n;
  while (m > 0 && out.t[m - 1] + step > NOW) m--;
  const raw = sliceBars(out, 0, m);
  const keep: number[] = [];
  for (let i = 0; i < raw.n; i++) if (!isMarketClosed(raw.t[i])) keep.push(i);
  return { raw, usable: pickBars(raw, keep) };
};

// ---- the label: what the chart's Dow line shows ------------------------------------------

const STATE_NAMES = ["none", "up", "down", "toUp", "toDown"] as const;
const STATE_CODE: Record<string, number> = { none: 0, up: 1, down: 2, toUp: 3, toDown: 4 };
// the side a state points to
const DIR_OF = [0, 1, -1, 1, -1];

interface Series {
  tf: Tf;
  step: number;
  bars: Bars;
  mids: Array<{ high: number; low: number; close: number }>;
  // Wilder ATR(14) of the mids at each bar (NaN before it has one)
  atr: Float64Array;
  gap: Int32Array;
}
const seriesOf = (tf: Tf, bars: Bars, holes: Set<number> | null): Series => {
  const step = LIVE_STEP_MS[tf];
  const mids = Array.from({ length: bars.n }, (_, i) => ({ high: midHigh(bars, i), low: midLow(bars, i), close: midClose(bars, i) }));
  const a = atrSeriesOf(mids as unknown as Candle[]);
  const atr = Float64Array.from(a, (v) => (v === null ? Number.NaN : v));
  return { tf, step, bars, mids, atr, gap: gapPrefix(bars, step, holes) };
};

interface Labels {
  // 0 none, 1 up, 2 down, 3 toUp, 4 toDown; -1 nothing to read
  state: Int8Array;
  // 1: fewer than DOW_BARS closed bars; 2: an unexplained hole among them
  excl: Uint8Array;
  // the newest closed bar and the window's first (-1 none)
  bar: Int32Array;
  first: Int32Array;
  // bars since the state began (-1: none)
  age: Int32Array;
}
const DOW_CALLS = { n: 0 };

// The line at each 5-minute close fineT[k] + 5min, for k0 <= k < k1, as
// fetchDowQuotes -> splitBars -> dowOf would read it a minute later
const labelsOf = (s: Series, fineT: Float64Array, k0 = 0, k1 = fineT.length): Labels => {
  const nf = fineT.length;
  const L: Labels = {
    state: new Int8Array(nf).fill(-1),
    excl: new Uint8Array(nf),
    bar: new Int32Array(nf).fill(-1),
    first: new Int32Array(nf).fill(-1),
    age: new Int32Array(nf).fill(-1),
  };
  const T = s.bars;
  if (k0 >= k1) return L;
  // the newest bar closed by the first close
  let i = lowerBound(T.t, fineT[k0] + FINE - s.step + 0.5) - 1;
  let lastStart = -2;
  let lastI = -2;
  let lastState = -1;
  let lastSince: number | null = null;
  let dayAt = Number.NaN;
  let okFrom = 0;
  for (let k = k0; k < k1; k++) {
    const C = fineT[k] + FINE;
    while (i + 1 < T.n && T.t[i + 1] + s.step <= C) i++;
    if (i < 0) continue;
    const nowMs = C + LAG;
    const d = jstDay(nowMs);
    if (d !== dayAt) {
      dayAt = d;
      okFrom = lowerBound(T.key, oldestKey(s.tf, nowMs));
    }
    // the newest DOW_BARS + 1 usable bars (t <= now + 60 s) of the files
    // read: the forming one among them when it has begun
    const forming = i + 1 < T.n && T.t[i + 1] <= C;
    const start = Math.max(forming ? i - (WINDOW - 1) : i - WINDOW, okFrom, 0);
    if (start > i) continue;
    if (start !== lastStart || i !== lastI) {
      const r = dowTheory(s.mids.slice(start, i + 1));
      DOW_CALLS.n++;
      lastStart = start;
      lastI = i;
      lastState = STATE_CODE[r.state];
      lastSince = r.since;
    }
    L.state[k] = lastState;
    L.bar[k] = i;
    L.first[k] = start;
    L.age[k] = lastSince === null ? -1 : i - start - lastSince;
    L.excl[k] = (i - start + 1 < WINDOW ? 1 : 0) | (holeIn(s.gap, start, i) ? 2 : 0);
  }
  return L;
};

// ---- the outcomes ------------------------------------------------------------------------

// the band reached first from the mid close of bar k: 1 the upper, 0 the
// lower, 2 both inside one bar, -1 neither within H bars
const firstTouch = (f: Bars, k: number, a: number, H: number): number => {
  const m0 = midClose(f, k);
  const up = m0 + a;
  const dn = m0 - a;
  const end = Math.min(f.n - 1, k + H);
  for (let j = k + 1; j <= end; j++) {
    const hi = midHigh(f, j) >= up;
    const lo = midLow(f, j) <= dn;
    if (hi && lo) return 2;
    if (hi) return 1;
    if (lo) return 0;
  }
  return -1;
};
// traded from bar k's close: R (ATR = 1) into tR, 1 target / -1 stop / 0 open into tW
let tR = 0;
let tW = 0;
const done = (r: number, w: number) => {
  tR = r;
  tW = w;
};
const trade = (f: Bars, k: number, a: number, H: number, buy: boolean): void => {
  const end = Math.min(f.n - 1, k + H);
  if (buy) {
    const e = f.ac[k];
    const stop = e - a;
    const tgt = e + a;
    for (let j = k + 1; j <= end; j++) {
      const o = f.bo[j];
      if (o <= stop) return done((o - e) / a, -1);
      if (o >= tgt) return done((o - e) / a, 1);
      if (f.bl[j] <= stop) return done((stop - e) / a, -1);
      if (f.bh[j] >= tgt) return done((tgt - e) / a, 1);
    }
    return done((f.bc[end] - e) / a, 0);
  }
  const e = f.bc[k];
  const stop = e + a;
  const tgt = e - a;
  for (let j = k + 1; j <= end; j++) {
    const o = f.ao[j];
    if (o >= stop) return done((e - o) / a, -1);
    if (o <= tgt) return done((e - o) / a, 1);
    if (f.ah[j] >= stop) return done((e - stop) / a, -1);
    if (f.al[j] <= tgt) return done((e - tgt) / a, 1);
  }
  return done((e - f.ac[end]) / a, 0);
};
const touchValue = (c: number) => (c === 1 ? 1 : c === 0 ? 0 : c === 2 ? 0.5 : Number.NaN);

const EX_BEFORE = 1;
const EX_NEXT = 2;
const EX_END = 4;
const EX_HOLE = 8;
const EX_ATR = 16;
const EX_NAMES: Array<[number, string]> = [
  [EX_NEXT, "next bar 30+ min later"],
  [EX_END, "follow past the data"],
  [EX_HOLE, "hole in the follow"],
  [EX_ATR, "ATR missing or < 4 ticks"],
];

interface Outs {
  ex: Uint8Array;
  touch: Int8Array;
  o1: Float64Array;
  o1L: Float64Array;
  o2: Float64Array;
  rB: Float64Array;
  rS: Float64Array;
  wB: Int8Array;
  wS: Int8Array;
  // spread over ATR at the closes counted, summed
  sprAtr: number;
}
const hOf = (s: Series) => (HBARS * s.step) / FINE;
const n2Of = (s: Series) => (NDIR * s.step) / FINE;

// every outcome at bar k for a timeframe's ATR a, written into o at k
const outcomeAt = (f: Bars, k: number, a: number, H: number, N2: number, o: Outs) => {
  const c = firstTouch(f, k, a, H);
  o.touch[k] = c;
  o.o1[k] = touchValue(c);
  o.o1L[k] = touchValue(firstTouch(f, k + 1, a, H));
  const m0 = midClose(f, k);
  const m2 = midClose(f, k + N2);
  o.o2[k] = m2 > m0 ? 1 : m2 < m0 ? 0 : 0.5;
  trade(f, k, a, H, true);
  o.rB[k] = tR;
  o.wB[k] = tW;
  trade(f, k, a, H, false);
  o.rS[k] = tR;
  o.wS[k] = tW;
};
const newOuts = (n: number): Outs => ({
  ex: new Uint8Array(n),
  touch: new Int8Array(n).fill(-1),
  o1: new Float64Array(n).fill(Number.NaN),
  o1L: new Float64Array(n).fill(Number.NaN),
  o2: new Float64Array(n).fill(Number.NaN),
  rB: new Float64Array(n).fill(Number.NaN),
  rS: new Float64Array(n).fill(Number.NaN),
  wB: new Int8Array(n),
  wS: new Int8Array(n),
  sprAtr: 0,
});
const outcomesOf = (s: Series, L: Labels, f: Bars, fineGap: Int32Array, tick: number): Outs => {
  const n = f.n;
  const o = newOuts(n);
  const H = hOf(s);
  const N2 = n2Of(s);
  for (let k = 0; k < n; k++) {
    const C = f.t[k] + FINE;
    const a = L.bar[k] >= 0 ? s.atr[L.bar[k]] : Number.NaN;
    let ex = 0;
    if (C < START_MS) ex = EX_BEFORE;
    else if (k + 1 >= n || f.t[k + 1] >= C + GAP) ex = EX_NEXT;
    else if (k + 1 + H > n - 1) ex = EX_END;
    else if (holeIn(fineGap, k, k + 1 + H)) ex = EX_HOLE;
    else if (!(a >= ATR_TICKS * tick)) ex = EX_ATR;
    o.ex[k] = ex;
    if (ex !== 0) continue;
    outcomeAt(f, k, a, H, N2, o);
    o.sprAtr += (f.ac[k] - f.bc[k]) / a;
  }
  return o;
};

// ---- what is counted: the combinations -----------------------------------------------

interface ComboDef {
  name: string;
  dir: 1 | -1;
}
const COMBOS: ComboDef[] = [];
const addCombo = (name: string, dir: number) => {
  COMBOS.push({ name, dir: dir > 0 ? 1 : -1 });
  return COMBOS.length - 1;
};
const LABEL_STATES = [1, 2, 3, 4];
const AGE_BUCKETS = ["0", "1-3", "4-12", "13+"];
const ageBucket = (a: number) => (a <= 0 ? 0 : a <= 3 ? 1 : a <= 12 ? 2 : 3);
const RELS = ["same", "opp", "none"];
const C_ST: number[] = [-1];
const C_ON: number[] = [-1];
const C_HI: number[][] = [[]];
const C_AGE: number[][] = [[]];
const C_DOW1: number[] = [-1];
for (const s of LABEL_STATES) C_ST[s] = addCombo(`st:${STATE_NAMES[s]}`, DIR_OF[s]);
const C_DIR_U = addCombo("dir:U", 1);
const C_DIR_D = addCombo("dir:D", -1);
const C_AL_UP = addCombo("al:up", 1);
const C_AL_DN = addCombo("al:down", -1);
for (const s of LABEL_STATES) C_ON[s] = addCombo(`on:${STATE_NAMES[s]}`, DIR_OF[s]);
const C_ALON_UP = addCombo("alon:up", 1);
const C_ALON_DN = addCombo("alon:down", -1);
for (const s of LABEL_STATES) C_HI[s] = RELS.map((r) => addCombo(`hi:${STATE_NAMES[s]}:${r}`, DIR_OF[s]));
const C_PB_UP = addCombo("pb:up", 1);
const C_PB_DN = addCombo("pb:down", -1);
for (const s of LABEL_STATES) C_AGE[s] = AGE_BUCKETS.map((b) => addCombo(`age:${STATE_NAMES[s]}:${b}`, DIR_OF[s]));
const C_LK_UP = addCombo("lk:perfect:up", 1);
const C_LK_DN = addCombo("lk:perfect:down", -1);
for (const s of LABEL_STATES) C_DOW1[s] = addCombo(`lk:dow1:${STATE_NAMES[s]}`, DIR_OF[s]);
const NC = COMBOS.length;
const OUTS = ["O1", "O1L", "O2", "R", "W"] as const;
const NO = OUTS.length;
const PRIMARY = ["st:up", "st:down", "st:toUp", "st:toDown", "al:up", "al:down"];
const YARDSTICKS = ["lk:perfect:up", "lk:perfect:down", "lk:dow1:up", "lk:dow1:down", "lk:dow1:toUp", "lk:dow1:toDown"];

// ---- the tally ---------------------------------------------------------------------------

const NKEYS = NG * NT * NC * 2 * NO;
const keyId = (g: number, ti: number, c: number, h: number, o: number) => (((g * NT + ti) * NC + c) * 2 + h) * NO + o;
const decodeKey = (id: number) => {
  const o = id % NO;
  let r = (id - o) / NO;
  const h = r % 2;
  r = (r - h) / 2;
  const c = r % NC;
  r = (r - c) / NC;
  const ti = r % NT;
  const g = (r - ti) / NT;
  return { g, ti, c, h, o };
};
// per key: labels counted, their outcomes and residuals summed; per key and
// week: residuals (A), labels (B), outcomes (Yw), and the blind's error (D)
let accN = new Float64Array(NKEYS);
let accY = new Float64Array(NKEYS);
let accR = new Float64Array(NKEYS);
let accA = new Float64Array(NKEYS * NW);
let accB = new Float64Array(NKEYS * NW);
let accYw = new Float64Array(NKEYS * NW);
let accD = new Float64Array(NKEYS * NW);
const resetTally = () => {
  accN = new Float64Array(NKEYS);
  accY = new Float64Array(NKEYS);
  accR = new Float64Array(NKEYS);
  accA = new Float64Array(NKEYS * NW);
  accB = new Float64Array(NKEYS * NW);
  accYw = new Float64Array(NKEYS * NW);
  accD = new Float64Array(NKEYS * NW);
};
// a pair and timeframe's labels by UTC hour, a key: their share of the blind cell
const nLc = new Float64Array(NKEYS * 24);
const touched = new Uint8Array(NKEYS);

const yOf = (o: number, up: boolean, k: number, out: Outs): number => {
  switch (o) {
    case 0:
      return up ? out.o1[k] : 1 - out.o1[k];
    case 1:
      return up ? out.o1L[k] : 1 - out.o1L[k];
    case 2:
      return up ? out.o2[k] : 1 - out.o2[k];
    case 3:
      return up ? out.rB[k] : out.rS[k];
    default: {
      const w = up ? out.wB[k] : out.wS[k];
      return w === 1 ? 1 : w === -1 ? 0 : Number.NaN;
    }
  }
};
// a blind cell: outcome, side (0 up, 1 down), half × 24 + UTC hour
const cellIx = (o: number, d: number, c: number) => (o * 2 + d) * 48 + c;

interface TfDiag {
  closes: number;
  excluded: Record<string, number>;
  samples: number;
  labelExcl: { short: number; hole: number; none: number };
  states: number[];
  o1Both: number;
  o1None: number;
  sprAtr: number;
}

// One pair and timeframe into the tally
const tally = (pair: string, ti: number, f: Bars, labels: Labels[], outs: Outs[], barFirst: Int8Array[], diag: TfDiag) => {
  const out = outs[ti];
  const L = labels[ti];
  const n = f.n;
  const S = new Float64Array(NO * 2 * 48);
  const N = new Float64Array(NO * 2 * 48);
  const cellOf = new Int16Array(n).fill(-1);
  const weekOfK = new Int32Array(n);
  for (let k = 0; k < n; k++) {
    if (out.ex[k] !== 0) continue;
    const C = f.t[k] + FINE;
    const w = weekOf(C);
    if (w < 0 || w >= NW) continue;
    const h = C < SPLIT_MS ? 0 : 1;
    cellOf[k] = h * 24 + Math.floor((C % DAY) / HOUR);
    weekOfK[k] = w;
  }
  // the blind: every close of the cell
  for (let k = 0; k < n; k++) {
    const c = cellOf[k];
    if (c < 0) continue;
    for (let o = 0; o < NO; o++) {
      for (let d = 0; d < 2; d++) {
        const y = yOf(o, d === 0, k, out);
        if (Number.isNaN(y)) continue;
        S[cellIx(o, d, c)] += y;
        N[cellIx(o, d, c)]++;
      }
    }
  }
  const M = new Float64Array(S.length);
  for (let i = 0; i < S.length; i++) M[i] = N[i] > 0 ? S[i] / N[i] : Number.NaN;
  const Rcw = new Float64Array(NO * 2 * 48 * NW);
  for (let k = 0; k < n; k++) {
    const c = cellOf[k];
    if (c < 0) continue;
    const w = weekOfK[k];
    for (let o = 0; o < NO; o++) {
      for (let d = 0; d < 2; d++) {
        const y = yOf(o, d === 0, k, out);
        if (Number.isNaN(y)) continue;
        const ci = cellIx(o, d, c);
        Rcw[ci * NW + w] += y - M[ci];
      }
    }
  }
  // the labels
  const gMain = mainGroup(pair);
  const gTraded = tradedGroup(pair);
  const valid = (tj: number, k: number) => labels[tj].state[k] >= 0 && labels[tj].excl[k] === 0;
  // all four lines up (1), down (-1), neither (0); NaN when one is unread
  const alignedRaw = (k: number): number => {
    let up = true;
    let dn = true;
    for (let tj = 0; tj < NT; tj++) {
      const s = labels[tj].state[k];
      if (s < 0) return Number.NaN;
      if (s !== 1) up = false;
      if (s !== 2) dn = false;
    }
    return up ? 1 : dn ? -1 : 0;
  };
  const aligned = (k: number): number => {
    for (let tj = 0; tj < NT; tj++) if (!valid(tj, k)) return 0;
    const a = alignedRaw(k);
    return Number.isNaN(a) ? 0 : a;
  };
  const combos: number[] = [];
  const keysTouched: number[] = [];
  for (let k = 0; k < n; k++) {
    const c = cellOf[k];
    if (c < 0) continue;
    diag.samples++;
    const h = c >= 24 ? 1 : 0;
    const hour = c % 24;
    const w = weekOfK[k];
    combos.length = 0;
    const tc = out.touch[k];
    if (tc === 1) combos.push(C_LK_UP);
    else if (tc === 0) combos.push(C_LK_DN);
    else if (tc === 2) diag.o1Both++;
    else diag.o1None++;
    const st = L.state[k];
    if (st < 0) diag.labelExcl.none++;
    else if (L.excl[k] & 1) diag.labelExcl.short++;
    else if (L.excl[k] & 2) diag.labelExcl.hole++;
    if (valid(ti, k)) {
      diag.states[st]++;
      if (st > 0) {
        combos.push(C_ST[st], DIR_OF[st] > 0 ? C_DIR_U : C_DIR_D);
        if (k > 0 && L.state[k - 1] >= 0 && L.state[k - 1] !== st) combos.push(C_ON[st]);
        if (ti + 1 < NT && valid(ti + 1, k)) {
          const hs = labels[ti + 1].state[k];
          const rel = hs === 1 || hs === 2 ? (DIR_OF[hs] === DIR_OF[st] ? 0 : 1) : 2;
          combos.push(C_HI[st][rel]);
        }
        combos.push(C_AGE[st][ageBucket(L.age[k])]);
        const nb = L.bar[k] + 1;
        if (nb < barFirst[ti].length && barFirst[ti][nb] > 0) combos.push(C_DOW1[barFirst[ti][nb]]);
      }
      const al = aligned(k);
      if (al !== 0) {
        combos.push(al > 0 ? C_AL_UP : C_AL_DN);
        if (k > 0) {
          const prev = alignedRaw(k - 1);
          if (!Number.isNaN(prev) && prev !== al) combos.push(al > 0 ? C_ALON_UP : C_ALON_DN);
        }
      }
      // the owner's mixed line: 4H and 1H the same trend, 15M and 5M both the other way
      if (ti === 2 && valid(0, k) && valid(1, k) && valid(3, k)) {
        const s4 = labels[3].state[k];
        const s15 = labels[1].state[k];
        const s5 = labels[0].state[k];
        if (s4 === 1 && st === 1 && DIR_OF[s15] === -1 && DIR_OF[s5] === -1) combos.push(C_PB_UP);
        if (s4 === 2 && st === 2 && DIR_OF[s15] === 1 && DIR_OF[s5] === 1) combos.push(C_PB_DN);
      }
    }
    for (const cx of combos) {
      const up = COMBOS[cx].dir > 0;
      const d = up ? 0 : 1;
      for (let o = 0; o < NO; o++) {
        const y = yOf(o, up, k, out);
        if (Number.isNaN(y)) continue;
        const r = y - M[cellIx(o, d, c)];
        const gs = o >= 3 && gTraded !== gMain ? 2 : 1;
        for (let gi = 0; gi < gs; gi++) {
          const id = keyId(gi === 0 ? gMain : gTraded, ti, cx, h, o);
          accN[id]++;
          accY[id] += y;
          accR[id] += r;
          accA[id * NW + w] += r;
          accB[id * NW + w]++;
          accYw[id * NW + w] += y;
          nLc[id * 24 + hour]++;
          if (!touched[id]) {
            touched[id] = 1;
            keysTouched.push(id);
          }
        }
      }
    }
  }
  // the blind's error, carried by each week: over the cells, the labels'
  // share of the cell times the cell's residuals that week
  for (const id of keysTouched) {
    const { c: cx, h, o } = decodeKey(id);
    const d = COMBOS[cx].dir > 0 ? 0 : 1;
    for (let hour = 0; hour < 24; hour++) {
      const m = nLc[id * 24 + hour];
      if (m === 0) continue;
      const ci = cellIx(o, d, h * 24 + hour);
      const share = m / N[ci];
      for (let w = 0; w < NW; w++) accD[id * NW + w] += share * Rcw[ci * NW + w];
      nLc[id * 24 + hour] = 0;
    }
    touched[id] = 0;
  }
};

interface KeyStat {
  g: string;
  tf: Tf;
  combo: string;
  half: "H1" | "H2" | "all";
  o: string;
  n: number;
  y: number;
  L: number;
  seL: number;
  seL4: number;
  seY: number;
  seY4: number;
  weeks: number;
}
// the lift and the mean of keys taken together, with intervals clustered
// by `block` weeks
const statOf = (ids: number[], block: number) => {
  let nL = 0;
  let sY = 0;
  let sR = 0;
  for (const id of ids) {
    nL += accN[id];
    sY += accY[id];
    sR += accR[id];
  }
  const L = sR / nL;
  const y = sY / nL;
  let vL = 0;
  let vY = 0;
  let cL = 0;
  let cY = 0;
  for (let w0 = 0; w0 < NW; w0 += block) {
    let A = 0;
    let B = 0;
    let D = 0;
    let Y = 0;
    for (let w = w0; w < Math.min(NW, w0 + block); w++) {
      for (const id of ids) {
        A += accA[id * NW + w];
        B += accB[id * NW + w];
        D += accD[id * NW + w];
        Y += accYw[id * NW + w];
      }
    }
    if (B > 0 || D !== 0) {
      const psi = A - L * B - D;
      vL += psi * psi;
      cL++;
    }
    if (B > 0) {
      const psi = Y - y * B;
      vY += psi * psi;
      cY++;
    }
  }
  return {
    n: nL,
    y,
    L,
    seL: cL > 1 ? Math.sqrt((cL / (cL - 1)) * vL) / nL : Number.NaN,
    seY: cY > 1 ? Math.sqrt((cY / (cY - 1)) * vY) / nL : Number.NaN,
    weeks: cY,
  };
};
const collect = (): KeyStat[] => {
  const out: KeyStat[] = [];
  for (let g = 0; g < NG; g++) {
    for (let ti = 0; ti < NT; ti++) {
      for (let c = 0; c < NC; c++) {
        for (let o = 0; o < NO; o++) {
          const halves: Array<["H1" | "H2" | "all", number[]]> = [
            ["H1", [keyId(g, ti, c, 0, o)]],
            ["H2", [keyId(g, ti, c, 1, o)]],
            ["all", [keyId(g, ti, c, 0, o), keyId(g, ti, c, 1, o)]],
          ];
          for (const [half, ids] of halves) {
            const ids2 = ids.filter((id) => accN[id] > 0);
            if (ids2.length === 0) continue;
            const s1 = statOf(ids2, 1);
            const s4 = statOf(ids2, 4);
            out.push({
              g: GROUPS[g],
              tf: TFS[ti],
              combo: COMBOS[c].name,
              half,
              o: OUTS[o],
              n: s1.n,
              y: s1.y,
              L: s1.L,
              seL: s1.seL,
              seL4: s4.seL,
              seY: s1.seY,
              seY4: s4.seY,
              weeks: s1.weeks,
            });
          }
        }
      }
    }
  }
  return out;
};

// ---- the chart's own reading, to check the labels against ------------------------------------

// from the files kept here (real)
const fileFetcher = (): Fetcher => {
  const memo = new Map<string, unknown>();
  return async (url: string) => {
    const u = new URL(url);
    const symbol = u.searchParams.get("symbol") ?? "";
    const side = (u.searchParams.get("priceType") ?? "").toLowerCase();
    const interval = u.searchParams.get("interval") ?? "";
    const date = u.searchParams.get("date") ?? "";
    const path = cachePath(symbol, interval, side, date);
    if (memo.has(path)) return memo.get(path) ?? null;
    let body: unknown = null;
    try {
      body = JSON.parse(await Deno.readTextFile(path));
    } catch {
      body = null;
    }
    memo.set(path, body);
    return body;
  };
};
// from a walk's bars, filed by their keys as GMO's would be
const walkFetcher = (raws: Bars[]): Fetcher => {
  const ranges = new Map<string, [number, number, Bars]>();
  TFS.forEach((tf, ti) => {
    const b = raws[ti];
    const name = GMO_INTERVALS[tf].name;
    for (let i = 0; i < b.n; i++) {
      const k = `${name}|${b.key[i]}`;
      const r = ranges.get(k);
      if (r) r[1] = i + 1;
      else ranges.set(k, [i, i + 1, b]);
    }
  });
  const memo = new Map<string, unknown>();
  return async (url: string) => {
    const u = new URL(url);
    const side = u.searchParams.get("priceType") ?? "";
    const key = `${u.searchParams.get("interval")}|${u.searchParams.get("date")}`;
    const mk = `${key}|${side}`;
    if (memo.has(mk)) return memo.get(mk) ?? null;
    const r = ranges.get(key);
    let body: unknown = null;
    if (r) {
      const [i0, i1, b] = r;
      const bid = side === "BID";
      const data = [];
      for (let i = i0; i < i1; i++) {
        data.push({
          openTime: String(b.t[i]),
          open: String(bid ? b.bo[i] : b.ao[i]),
          high: String(bid ? b.bh[i] : b.ah[i]),
          low: String(bid ? b.bl[i] : b.al[i]),
          close: String(bid ? b.bc[i] : b.ac[i]),
        });
      }
      body = { status: 0, data };
    }
    memo.set(mk, body);
    return body;
  };
};

// New Year and the clocks changing (US and EU): the days to check around
const specialDays = (): number[] => {
  const out: number[] = [];
  const sunday = (y: number, m: number, nth: number) => {
    const first = new Date(Date.UTC(y, m, 1)).getUTCDay();
    return Date.UTC(y, m, 1 + ((7 - first) % 7) + 7 * (nth - 1));
  };
  const lastSunday = (y: number, m: number) => {
    const last = new Date(Date.UTC(y, m + 1, 0));
    return Date.UTC(y, m, last.getUTCDate() - last.getUTCDay());
  };
  for (let y = new Date(START_MS).getUTCFullYear(); y <= new Date(NOW).getUTCFullYear(); y++) {
    out.push(Date.UTC(y, 0, 1), sunday(y, 2, 2), sunday(y, 10, 1), lastSunday(y, 2), lastSunday(y, 9));
  }
  return out.filter((t) => t >= START_MS && t < NOW);
};

interface LiveCheck {
  checked: number;
  mismatches: number;
  examples: string[];
}
const liveCheck = async (pair: string, s: Series, L: Labels, fine: Bars, fetcher: Fetcher): Promise<LiveCheck> => {
  const res: LiveCheck = { checked: 0, mismatches: 0, examples: [] };
  // only moments whose bars all closed by the data's end: the files read
  // after it hold the bar forming then, which the bars here leave out (those
  // moments are past the follow's end, never counted)
  const inRange = (k: number) => fine.t[k] + FINE >= START_MS && fine.t[k] + FINE + s.step <= NOW && L.state[k] >= 0;
  const cand: number[] = [];
  for (let k = 1; k < fine.n; k++) if (inRange(k)) cand.push(k);
  if (cand.length === 0) return res;
  const ks: number[] = [];
  const every = Math.max(1, Math.floor(cand.length / CHECKS));
  for (let j = Math.abs(hashStr(`${pair}|${s.tf}`)) % every; j < cand.length; j += every) ks.push(cand[j]);
  // the week's opens and every other reopening after an hour or more (up
  // to 100, spread out), and the two closes after each
  const opens = cand.filter((k) => fine.t[k] - fine.t[k - 1] >= HOUR);
  const step = Math.max(1, Math.ceil(opens.length / 100));
  for (let j = 0; j < opens.length; j += step) for (let d = 0; d < 3; d++) if (opens[j] + d < fine.n) ks.push(opens[j] + d);
  // New Year and the clocks changing: every hour for a day and a half from the first open after
  for (const day of specialDays()) {
    const k0 = lowerBound(fine.t, day);
    if (k0 >= fine.n) continue;
    for (let h = 0; h < 36; h++) {
      const k = lowerBound(fine.t, fine.t[k0] + h * HOUR);
      if (k < fine.n) ks.push(k);
    }
  }
  const T = s.bars;
  for (const k of [...new Set(ks)].sort((a, b) => a - b)) {
    if (!inRange(k)) continue;
    const C = fine.t[k] + FINE;
    const nowMs = C + LAG;
    const qs = await fetchDowQuotes(pair, s.tf, nowMs, Number.MAX_SAFE_INTEGER, fetcher);
    const closed = qs ? splitBars(qs, s.tf, nowMs).closed : [];
    const live = closed.length > 0 ? dowOf(pair, s.tf, closed).state : null;
    const mine = STATE_NAMES[L.state[k]];
    const myCount = L.bar[k] - L.first[k] + 1;
    const myFirst = iso(T.t[L.first[k]]);
    const myLast = iso(T.t[L.bar[k]]);
    const liveFirst = closed[0]?.datetime ?? null;
    const liveLast = closed[closed.length - 1]?.datetime ?? null;
    res.checked++;
    if (live !== mine || closed.length !== myCount || liveFirst !== myFirst || liveLast !== myLast) {
      res.mismatches++;
      if (res.examples.length < 8) {
        res.examples.push(`${pair} ${s.tf} at ${iso(nowMs)}: chart ${live} ${closed.length} bars ${liveFirst}..${liveLast}; here ${mine} ${myCount} bars ${myFirst}..${myLast}`);
      }
    }
  }
  return res;
};

// ---- the look-ahead checks (on the walks) ---------------------------------------------------

interface Perturb {
  futureChecked: number;
  futureMoved: number;
  pastChecked: number;
  pastMoved: number;
  examples: string[];
}
// Rewriting every bar after a close must not move the line or the ATR at
// it; rewriting every bar before it (and the close's own open, high and
// low) must not move its outcomes, given its ATR
const perturbCheck = (fine: Bars, ser: Series[], labels: Labels[], outs: Outs[], seed: number): Perturb => {
  const res: Perturb = { futureChecked: 0, futureMoved: 0, pastChecked: 0, pastMoved: 0, examples: [] };
  const r = rng(seed * 31 + 5);
  const cand: number[] = [];
  for (let k = 3; k < fine.n; k++) if (outs[NT - 1].ex[k] === 0 && labels.every((L) => L.state[k] >= 0)) cand.push(k);
  if (cand.length === 0) return res;
  const scale = (b: Bars, j: number, g: number) => {
    b.bo[j] *= g;
    b.bh[j] *= g;
    b.bl[j] *= g;
    b.bc[j] *= g;
    b.ao[j] *= g;
    b.ah[j] *= g;
    b.al[j] *= g;
    b.ac[j] *= g;
  };
  const eq = (x: number, y: number) => x === y || (Number.isNaN(x) && Number.isNaN(y));
  for (let p = 0; p < PERTURB; p++) {
    const K = cand[Math.floor(((p + 0.5) / PERTURB) * cand.length)];
    // the future rewritten
    const f2 = sliceBars(fine, 0, fine.n);
    let g = 1;
    for (let j = K + 1; j < f2.n; j++) {
      g *= Math.exp(0.003 * r.n());
      scale(f2, j, g);
    }
    TFS.forEach((tf, ti) => {
      const bars = tf === "5min" ? f2 : aggregateBars(f2, LIVE_STEP_MS[tf], tf === "4h").usable;
      const s2 = seriesOf(tf, bars, null);
      const L2 = labelsOf(s2, f2.t, K - 2, K + 1);
      const L = labels[ti];
      for (let k = K - 2; k <= K; k++) {
        res.futureChecked++;
        const same = L2.state[k] === L.state[k] && L2.age[k] === L.age[k] && L2.first[k] === L.first[k] && L2.bar[k] === L.bar[k] &&
          L2.excl[k] === L.excl[k] && eq(s2.atr[L2.bar[k]], ser[ti].atr[L.bar[k]]);
        if (!same) {
          res.futureMoved++;
          if (res.examples.length < 5) res.examples.push(`future ${tf} k=${k}: state ${L.state[k]}/${L2.state[k]} atr ${ser[ti].atr[L.bar[k]]}/${s2.atr[L2.bar[k]]}`);
        }
      }
    });
    // the past rewritten
    const f3 = sliceBars(fine, 0, fine.n);
    g = 1;
    for (let j = K - 1; j >= 0; j--) {
      g *= Math.exp(0.003 * r.n());
      scale(f3, j, g);
    }
    f3.bo[K] *= 1.002;
    f3.ao[K] *= 1.002;
    f3.bh[K] = Math.max(f3.bh[K] * 1.003, f3.bc[K], f3.bo[K]);
    f3.ah[K] = Math.max(f3.ah[K] * 1.003, f3.ac[K], f3.ao[K]);
    f3.bl[K] = Math.min(f3.bl[K] * 0.997, f3.bc[K], f3.bo[K]);
    f3.al[K] = Math.min(f3.al[K] * 0.997, f3.ac[K], f3.ao[K]);
    ser.forEach((s, ti) => {
      const a = s.atr[labels[ti].bar[K]];
      const o3 = newOuts(fine.n);
      outcomeAt(f3, K, a, hOf(s), n2Of(s), o3);
      const o = outs[ti];
      res.pastChecked++;
      const same = eq(o3.o1[K], o.o1[K]) && eq(o3.o1L[K], o.o1L[K]) && eq(o3.o2[K], o.o2[K]) && eq(o3.rB[K], o.rB[K]) &&
        eq(o3.rS[K], o.rS[K]) && o3.wB[K] === o.wB[K] && o3.wS[K] === o.wS[K];
      if (!same) {
        res.pastMoved++;
        if (res.examples.length < 5) res.examples.push(`past ${s.tf} k=${K}: o1 ${o.o1[K]}/${o3.o1[K]} rB ${o.rB[K]}/${o3.rB[K]}`);
      }
    });
  }
  return res;
};

// ---- one pair ----------------------------------------------------------------------------

interface PairDiag {
  pair: string;
  tick: number;
  holes: number[];
  tfs: TfDiag[];
  live: LiveCheck[];
}
const newTfDiag = (): TfDiag => ({
  closes: 0,
  excluded: {},
  samples: 0,
  labelExcl: { short: 0, hole: 0, none: 0 },
  states: [0, 0, 0, 0, 0],
  o1Both: 0,
  o1None: 0,
  sprAtr: 0,
});

const processPair = async (
  pair: string,
  usable: Bars[],
  holes: Array<Set<number> | null>,
  tick: number,
  fetcher: Fetcher,
  perturbSeed: number | null,
): Promise<{ diag: PairDiag; perturb: Perturb | null }> => {
  const ser = TFS.map((tf, ti) => seriesOf(tf, usable[ti], holes[ti]));
  const fine = usable[0];
  const labels = ser.map((s) => labelsOf(s, fine.t));
  const outs = ser.map((s, ti) => outcomesOf(s, labels[ti], fine, ser[0].gap, tick));
  // the line each bar shows once it closes (the yardstick one bar ahead)
  const barFirst = ser.map((s, ti) => {
    const bf = new Int8Array(s.bars.n).fill(-1);
    const L = labels[ti];
    for (let k = 0; k < fine.n; k++) if (L.bar[k] >= 0 && L.state[k] >= 0 && bf[L.bar[k]] === -1) bf[L.bar[k]] = L.state[k];
    return bf;
  });
  const diag: PairDiag = { pair, tick, holes: ser.map((s) => s.gap[s.bars.n]), tfs: [], live: [] };
  for (let ti = 0; ti < NT; ti++) {
    const d = newTfDiag();
    const out = outs[ti];
    for (let k = 0; k < fine.n; k++) {
      if (out.ex[k] === EX_BEFORE) continue;
      d.closes++;
      for (const [bit, name] of EX_NAMES) if (out.ex[k] === bit) d.excluded[name] = (d.excluded[name] ?? 0) + 1;
    }
    tally(pair, ti, fine, labels, outs, barFirst, d);
    d.sprAtr = out.sprAtr;
    diag.tfs.push(d);
  }
  for (let ti = 0; ti < NT; ti++) diag.live.push(await liveCheck(pair, ser[ti], labels[ti], fine, fetcher));
  const perturb = perturbSeed === null ? null : perturbCheck(fine, ser, labels, outs, perturbSeed);
  return { diag, perturb };
};

// ---- printing ----------------------------------------------------------------------------

const pct = (x: number) => (Number.isFinite(x) ? (100 * x).toFixed(1) : "-");
const pts = (x: number) => (Number.isFinite(x) ? `${x >= 0 ? "+" : ""}${(100 * x).toFixed(2)}` : "-");
const num = (x: number, d = 3) => (Number.isFinite(x) ? `${x >= 0 ? "+" : ""}${x.toFixed(d)}` : "-");
const seUse = (e: KeyStat) => (e.tf === "4h" ? Math.max(e.seL, e.seL4) : e.seL);
const seYUse = (e: KeyStat) => (e.tf === "4h" ? Math.max(e.seY, e.seY4) : e.seY);
const keyName = (e: { g: string; tf: string; combo: string; half: string; o: string }) => `${e.g}|${e.tf}|${e.combo}|${e.half}|${e.o}`;

const rowsFor = (keys: Map<string, KeyStat>, g: string, combos: string[], o: string, tfs: readonly Tf[] = TFS) => {
  const lines: string[] = [];
  for (const tf of tfs) {
    for (const combo of combos) {
      const parts: string[] = [];
      let any = false;
      for (const half of ["H1", "H2", "all"] as const) {
        const e = keys.get(keyName({ g, tf, combo, half, o }));
        if (!e) {
          parts.push(`${half} -`);
          continue;
        }
        any = true;
        if (o === "R") {
          const se = seYUse(e);
          parts.push(`${half} n=${e.n} R ${num(e.y)} [${num(e.y - 1.96 * se)}, ${num(e.y + 1.96 * se)}] lift ${num(e.L)}`);
        } else {
          const se = seUse(e);
          parts.push(`${half} n=${e.n} ${pct(e.y)}% blind ${pct(e.y - e.L)}% lift ${pts(e.L)} [${pts(e.L - 1.96 * se)}, ${pts(e.L + 1.96 * se)}]`);
        }
      }
      if (any) lines.push(`  ${tf.padEnd(5)} ${combo.padEnd(18)} ${parts.join(" | ")}`);
    }
  }
  return lines;
};

const printDiags = (diags: PairDiag[], perturb: Perturb | null, mode: string) => {
  console.log(`\n== data and checks (${mode}) ==`);
  let checked = 0;
  let mismatches = 0;
  for (const d of diags) {
    console.log(`${d.pair}: tick ${d.tick}; unexplained holes ${TFS.map((tf, ti) => `${tf} ${d.holes[ti]}`).join(", ")}`);
    TFS.forEach((tf, ti) => {
      const t = d.tfs[ti];
      const lv = d.live[ti];
      checked += lv.checked;
      mismatches += lv.mismatches;
      const shown = t.states.reduce((a, b) => a + b, 0);
      const share = t.states.map((x) => x / Math.max(1, shown));
      console.log(
        `  ${tf.padEnd(5)} closes ${t.closes}, out: ${Object.entries(t.excluded).map(([k, v]) => `${k} ${v}`).join("; ") || "none"}; ` +
          `counted ${t.samples} (label out: short ${t.labelExcl.short}, hole ${t.labelExcl.hole}, unread ${t.labelExcl.none}); ` +
          `shown none ${pct(share[0])}% up ${pct(share[1])}% down ${pct(share[2])}% toUp ${pct(share[3])}% toDown ${pct(share[4])}%; ` +
          `O1 both ${t.o1Both}, unresolved ${t.o1None} (${pct(t.o1None / Math.max(1, t.samples))}%); spread/ATR ${(t.sprAtr / Math.max(1, t.samples)).toFixed(3)}; ` +
          `chart check ${lv.checked}, mismatches ${lv.mismatches}`,
      );
      for (const ex of lv.examples) console.log(`    ${ex}`);
    });
  }
  console.log(`chart check in all: ${checked} moments, ${mismatches} mismatches`);
  if (perturb) {
    console.log(
      `look-ahead checks: future rewritten ${perturb.futureChecked}, moved ${perturb.futureMoved}; past rewritten ${perturb.pastChecked}, moved ${perturb.pastMoved}`,
    );
    for (const ex of perturb.examples) console.log(`  ${ex}`);
  }
};
const printResults = (keys: Map<string, KeyStat>) => {
  for (const g of ["12", "HS"]) {
    console.log(`\n== O1 first touch ±ATR (group ${g}) ==`);
    for (const l of rowsFor(keys, g, [...PRIMARY, "dir:U", "dir:D"], "O1")) console.log(l);
    console.log(`-- yardsticks (group ${g}) --`);
    for (const l of rowsFor(keys, g, YARDSTICKS, "O1")) console.log(l);
  }
  console.log(`\n== O3 R a trade ==`);
  for (const g of ["12", "MAJ", "TZM", "HS"]) {
    console.log(`-- ${g} --`);
    for (const l of rowsFor(keys, g, PRIMARY, "R")) console.log(l);
  }
};

// ---- the runs ----------------------------------------------------------------------------

const fromOf = (tf: Tf): number =>
  tf === "5min"
    ? START_MS - 6 * DAY
    : tf === "15min"
    ? START_MS - 12 * DAY
    : tf === "1h"
    ? START_MS - 45 * DAY
    : Date.UTC(new Date(START_MS).getUTCFullYear() - 1, 0, 1);

const writeRun = async (seed: number, diags: PairDiag[], perturb: Perturb | null, extra: Record<string, unknown>) => {
  const keys = collect();
  await Deno.mkdir(OUT, { recursive: true });
  const file = `${OUT}/dow-hit-${MODE}-${seed}.json`;
  await Deno.writeTextFile(
    file,
    JSON.stringify({ mode: MODE, seed, start: START, split: SPLIT, end: new Date(NOW).toISOString(), pairs: PAIRS, nw: NW, keys, diags, perturb, ...extra }),
  );
  printDiags(diags, perturb, MODE);
  printResults(new Map(keys.map((k) => [keyName(k), k])));
  console.log(`\nwritten ${file} (${keys.length} keys)`);
};

const runReal = async () => {
  console.log(`MODE real; pairs ${PAIRS.join(", ")}; ${START}..${new Date(NOW).toISOString()} split ${SPLIT}`);
  const loaded = new Map<string, Bars[]>();
  const stats = new Map<string, LoadStats>();
  for (const pair of PAIRS) {
    const st = newStats();
    const bars: Bars[] = [];
    for (const tf of TFS) bars.push(await loadReal(pair, tf, fromOf(tf), st));
    loaded.set(pair, bars);
    stats.set(pair, st);
    console.log(
      `loaded ${pair}: ${TFS.map((tf, ti) => `${tf} ${bars[ti].n}`).join(", ")}; requests ${st.requests}, cached ${st.cached}, failed ${st.failed}, ` +
        `re-read ${st.refetched}, key order ${st.keyOrder}`,
    );
    for (const f of st.failedKeys.slice(0, 10)) console.log(`  failed ${f}`);
  }
  const holes = TFS.map((tf, ti) => commonMissing(PAIRS.map((p) => loaded.get(p)![ti]), LIVE_STEP_MS[tf]));
  TFS.forEach((tf, ti) => {
    const days = new Map<string, number>();
    for (const s of holes[ti]) days.set(iso(s).slice(0, 10), (days.get(iso(s).slice(0, 10)) ?? 0) + 1);
    console.log(`GMO's own closures ${tf}: ${holes[ti].size} stamps on ${days.size} days: ${[...days].map(([d, n]) => `${d}(${n})`).join(" ")}`);
  });
  const diags: PairDiag[] = [];
  for (const pair of PAIRS) {
    const bars = loaded.get(pair)!;
    const tick = 10 ** -decimalsIn(bars[0]);
    const t0 = Date.now();
    const { diag } = await processPair(pair, bars, holes, tick, fileFetcher(), null);
    diags.push(diag);
    loaded.delete(pair);
    console.log(`done ${pair} in ${((Date.now() - t0) / 1000).toFixed(0)} s (dowTheory calls so far ${DOW_CALLS.n})`);
  }
  await writeRun(0, diags, null, { loader: Object.fromEntries(stats) });
};

const runSynth = async (seed: number) => {
  console.log(`MODE ${MODE} seed ${seed}; pairs ${PAIRS.join(", ")}; ${START}..${new Date(NOW).toISOString()} split ${SPLIT}`);
  resetTally();
  gridFor(seed, Date.UTC(new Date(START_MS).getUTCFullYear() - 1, 0, 1));
  const diags: PairDiag[] = [];
  let perturb: Perturb | null = null;
  for (const pair of PAIRS) {
    const t0 = Date.now();
    const fine = synthFine(pair, seed);
    const raws: Bars[] = [fine];
    const usable: Bars[] = [fine];
    for (const tf of TFS.slice(1)) {
      const a = aggregateBars(fine, LIVE_STEP_MS[tf], tf === "4h");
      raws.push(a.raw);
      usable.push(a.usable);
    }
    const tick = 10 ** -chartDecimals(pair);
    const r = await processPair(pair, usable, [null, null, null, null], tick, walkFetcher(raws), pair === PAIRS[0] ? seed : null);
    diags.push(r.diag);
    if (r.perturb) perturb = r.perturb;
    console.log(`done ${pair} in ${((Date.now() - t0) / 1000).toFixed(0)} s (dowTheory calls so far ${DOW_CALLS.n})`);
  }
  await writeRun(seed, diags, perturb, {});
};

// ---- MODE=report: the verdicts --------------------------------------------------------------

interface RunFile {
  mode: string;
  seed: number;
  start: string;
  split: string;
  end: string;
  pairs: string[];
  keys: KeyStat[];
  diags: PairDiag[];
  perturb: Perturb | null;
  loader?: Record<string, LoadStats>;
}
const readRuns = async (dir: string): Promise<RunFile[]> => {
  const out: RunFile[] = [];
  const walk = async (d: string) => {
    for await (const e of Deno.readDir(d)) {
      const p = `${d}/${e.name}`;
      if (e.isDirectory) await walk(p);
      else if (e.name.startsWith("dow-hit-") && e.name.endsWith(".json")) out.push(JSON.parse(await Deno.readTextFile(p)));
    }
  };
  await walk(dir);
  return out;
};
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const sd = (xs: number[]) => {
  if (xs.length < 2) return Number.NaN;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
};

const report = async () => {
  const runs = await readRuns(REPORT_DIR);
  const real = runs.find((r) => r.mode === "real");
  const nulls = runs.filter((r) => r.mode === "null");
  console.log(`report: real ${real ? `yes (${real.start}..${real.end}, split ${real.split})` : "no"}, null runs ${nulls.length} (seeds ${nulls.map((r) => r.seed).sort((a, b) => a - b).join(",")})`);
  for (const r of nulls) {
    if (r.perturb) console.log(`  walk ${r.seed}: look-ahead checks future ${r.perturb.futureChecked}/${r.perturb.futureMoved} moved, past ${r.perturb.pastChecked}/${r.perturb.pastMoved} moved`);
    const live = r.diags.flatMap((d) => d.live);
    console.log(`  walk ${r.seed}: chart check ${live.reduce((a, l) => a + l.checked, 0)} moments, ${live.reduce((a, l) => a + l.mismatches, 0)} mismatches`);
  }
  if (!real) return;
  // first what the data are and whether the labels are the chart's
  console.log(`\n== data diagnostics (real) ==`);
  if (real.loader) {
    for (const [pair, st] of Object.entries(real.loader)) {
      console.log(`  ${pair}: requests ${st.requests}, cached ${st.cached}, failed ${st.failed}, re-read ${st.refetched}, key order ${st.keyOrder}`);
    }
  }
  printDiags(real.diags, null, "real");

  const nullKeys = nulls.map((r) => new Map(r.keys.map((k) => [keyName(k), k])));
  const realKeys = new Map(real.keys.map((k) => [keyName(k), k]));
  // the walks: how often their intervals miss 0, a timeframe
  const coverage = new Map<string, number>();
  console.log(`\n== the walks with no effect: O1 lifts on the 24 (group 12) ==`);
  for (const tf of TFS) {
    let miss = 0;
    let all = 0;
    // and by label (described: the decision is the timeframe's)
    const byLabel: string[] = [];
    for (const combo of PRIMARY) {
      let m = 0;
      let a = 0;
      for (const nk of nullKeys) {
        for (const half of ["H1", "H2"]) {
          const e = nk.get(keyName({ g: "12", tf, combo, half, o: "O1" }));
          if (!e) continue;
          a++;
          if (Math.abs(e.L) > 1.96 * seUse(e)) m++;
        }
      }
      miss += m;
      all += a;
      byLabel.push(`${combo} ${m}/${a}`);
    }
    const cov = all > 0 ? miss / all : Number.NaN;
    coverage.set(tf, cov);
    console.log(`  ${tf}: intervals missing 0 in ${miss} of ${all} (${pct(cov)}%; nominal 5%)${cov > 0.1 ? " -> the walks' spread is used" : ""}`);
    console.log(`    by label: ${byLabel.join(", ")}`);
  }
  for (const tf of TFS) {
    console.log(
      `  zero ${tf}: ${
        PRIMARY.map((c) => {
          const ls = nullOf(nullKeys, keyName({ g: "12", tf, combo: c, half: "all", o: "O1" }));
          return `${c} ${pts(ls.length ? mean(ls) : Number.NaN)}±${pts(sd(ls))}`;
        }).join(", ")
      }`,
    );
  }
  const judged = (e: KeyStat) => {
    const ls = nullOf(nullKeys, keyName(e));
    const zero = ls.length > 0 ? mean(ls) : 0;
    const sdn = ls.length > 1 ? sd(ls) : 0;
    const wide = (coverage.get(e.tf) ?? 0) > 0.1;
    const se = wide ? Math.max(seUse(e), sdn) : seUse(e);
    const band = 1.96 * Math.sqrt(se * se + (ls.length > 1 ? (sdn * sdn) / ls.length : 0));
    return { zero, lo: e.L - zero - band, hi: e.L - zero + band, band };
  };

  console.log(`\n== verdicts: O1 on the 12 pairs (lift against the blind, less the walks' zero) ==`);
  const mdes = new Map<string, number[]>();
  for (const tf of TFS) {
    for (const combo of PRIMARY) {
      const parts: string[] = [];
      let up = true;
      let down = true;
      for (const half of ["H1", "H2"]) {
        const e = realKeys.get(keyName({ g: "12", tf, combo, half, o: "O1" }));
        if (!e) {
          parts.push(`${half} -`);
          up = false;
          down = false;
          continue;
        }
        const j = judged(e);
        if (!(j.lo > 0)) up = false;
        if (!(j.hi < 0)) down = false;
        const m = mdes.get(tf) ?? [];
        m.push(2 * j.band);
        mdes.set(tf, m);
        parts.push(`${half} n=${e.n} hit ${pct(e.y)}% blind ${pct(e.y - e.L)}% lift ${pts(e.L)} zero ${pts(j.zero)} -> [${pts(j.lo)}, ${pts(j.hi)}]`);
      }
      const v = up ? "CAN PREDICT" : down ? "wrong more often (not to be used reversed)" : "no";
      console.log(`  ${tf.padEnd(5)} ${combo.padEnd(9)} ${parts.join(" | ")} => ${v}`);
    }
  }
  for (const [tf, m] of mdes) {
    m.sort((a, b) => a - b);
    console.log(`  smallest lift findable on ${tf}: about ${pts(m[Math.floor(m.length / 2)])} pt (median of 2 × half-width)`);
  }

  console.log(`\n== verdicts: O3 traded, R a trade itself on the 12 pairs ==`);
  for (const tf of TFS) {
    for (const combo of PRIMARY) {
      const parts: string[] = [];
      let win = true;
      for (const half of ["H1", "H2"]) {
        const e = realKeys.get(keyName({ g: "12", tf, combo, half, o: "R" }));
        const w = realKeys.get(keyName({ g: "12", tf, combo, half, o: "W" }));
        if (!e) {
          parts.push(`${half} -`);
          win = false;
          continue;
        }
        const se = seYUse(e);
        if (!(e.y - 1.96 * se > 0)) win = false;
        parts.push(`${half} n=${e.n} R ${num(e.y)} [${num(e.y - 1.96 * se)}, ${num(e.y + 1.96 * se)}] win ${w ? pct(w.y) : "-"}% (blind ${w ? pct(w.y - w.L) : "-"}%)`);
      }
      console.log(`  ${tf.padEnd(5)} ${combo.padEnd(9)} ${parts.join(" | ")} => ${win ? "CAN WIN" : "no"}`);
    }
  }

  // look-ahead guard: every rate of 65% or more outside the yardsticks, the
  // largest first (under 100 samples marked: in the walks with no effect such
  // small cells reach 65% by chance)
  const high = real.keys
    .filter((e) => (e.o === "O1" || e.o === "O1L" || e.o === "O2" || e.o === "W") && !e.combo.startsWith("lk:") && e.y >= 0.65)
    .sort((a, b) => b.n - a.n);
  const big = high.filter((e) => e.n >= 100).length;
  console.log(`\n== rates of 65% or more (outside the yardsticks): ${high.length}, of them ${big} with 100 samples or more ==`);
  for (const e of high.slice(0, 80)) console.log(`  ${keyName(e)} n=${e.n} ${pct(e.y)}%${e.n < 100 ? " (small)" : ""}`);
  if (high.length > 80) console.log(`  ... ${high.length - 80} more, all smaller (in the JSON)`);

  console.log(`\n== look-ahead yardsticks (group 12, O1) ==`);
  for (const l of rowsFor(realKeys, "12", YARDSTICKS, "O1")) console.log(l);
  // what one bar of look-ahead adds over the plain label (the yardstick's lift less the label's)
  for (const tf of TFS) {
    const parts = LABEL_STATES.map((s) => {
      const name = STATE_NAMES[s];
      const a = realKeys.get(keyName({ g: "12", tf, combo: `lk:dow1:${name}`, half: "all", o: "O1" }));
      const b = realKeys.get(keyName({ g: "12", tf, combo: `st:${name}`, half: "all", o: "O1" }));
      return `${name} ${a && b ? pts(a.L - b.L) : "-"}`;
    });
    console.log(`  ${tf.padEnd(5)} one bar ahead adds (pt, all): ${parts.join(", ")}`);
  }
  console.log(`\n== O1, both sides pooled (group 12) ==`);
  for (const l of rowsFor(realKeys, "12", ["dir:U", "dir:D"], "O1")) console.log(l);
  console.log(`\n== O2: 12 bars later (group 12) ==`);
  for (const l of rowsFor(realKeys, "12", PRIMARY, "O2")) console.log(l);
  console.log(`\n== O3 by group: R a trade ==`);
  for (const g of ["MAJ", "TZM", "HS"]) {
    console.log(`-- ${g} --`);
    for (const l of rowsFor(realKeys, g, PRIMARY, "R")) console.log(l);
  }
  const onsets = ["on:up", "on:down", "on:toUp", "on:toDown", "alon:up", "alon:down"];
  console.log(`\n== the first 5 minutes of a new state, group 12: entered at the close (O1) ==`);
  for (const l of rowsFor(realKeys, "12", onsets, "O1")) console.log(l);
  console.log(`-- entered 5 minutes late (O1L) --`);
  for (const l of rowsFor(realKeys, "12", onsets, "O1L")) console.log(l);
  console.log(`\n== described: against the next higher timeframe (group 12, O1) ==`);
  const his = LABEL_STATES.flatMap((s) => RELS.map((r) => `hi:${STATE_NAMES[s]}:${r}`));
  for (const l of rowsFor(realKeys, "12", his, "O1", ["5min", "15min", "1h"])) console.log(l);
  console.log(`\n== described: the owner's mixed line, 4H and 1H's side on 1h (group 12) ==`);
  for (const o of ["O1", "O2", "R"]) for (const l of rowsFor(realKeys, "12", ["pb:up", "pb:down"], o, ["1h"])) console.log(`${o} ${l}`);
  console.log(`\n== described: by the state's age in bars (group 12, O1) ==`);
  const ages = LABEL_STATES.flatMap((s) => AGE_BUCKETS.map((b) => `age:${STATE_NAMES[s]}:${b}`));
  for (const l of rowsFor(realKeys, "12", ages, "O1")) console.log(l);
  console.log(`\n== HUF/JPY and SEK/JPY (group HS, O1) ==`);
  for (const l of rowsFor(realKeys, "HS", PRIMARY, "O1")) console.log(l);
};
const nullOf = (nullKeys: Array<Map<string, KeyStat>>, k: string) =>
  nullKeys.map((m) => m.get(k)?.L).filter((x): x is number => x !== undefined && Number.isFinite(x));

if (MODE === "report") await report();
else if (MODE === "real") await runReal();
else for (const seed of SEEDS) await runSynth(seed);
