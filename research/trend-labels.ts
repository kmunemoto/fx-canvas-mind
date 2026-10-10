// #250 (docs §8.106): the live chart's Dow line at a moment, read the way
// research/dow-hit.ts reads it — the code moved here from dow-hit.ts so that
// research/trend.ts reads the very same line. §8.94's run of dow-hit
// (37134324269, WEEKEND=inside) matched the chart's own reading
// (fetchDowQuotes -> splitBars -> dowOf) at 49,795 moments with none
// different. dow-hit.ts imports these; its synthetic output is the same
// byte for byte as before the move (§8.106 11, sha256 of its JSON).
//
// Nothing here reads the environment: what dow-hit took from its own
// constants (the weekend rule, the data's end, the kept files' folder, the
// checks' sample) is handed in.

import type { Candle } from "../supabase/functions/analyze/indicators.ts";
import { GMO_INTERVALS, type Fetcher, jstDayKey, jstYearKey, type QuoteCandle } from "../supabase/functions/track-outcomes/quotes.ts";
import { barInsideClosure, isMarketClosed, isPossiblyClosed } from "../supabase/functions/_shared/market-hours.ts";
import { atrSeriesOf } from "../supabase/functions/analyze/state.ts";
import { dowTheory } from "../supabase/functions/_shared/dow.ts";
import { DOW_BARS, LIVE_STEP_MS, dowOf, fetchDowQuotes, splitBars } from "../supabase/functions/live-chart/logic.ts";
import { DAY, HOUR, MINUTE, iso } from "./lib.ts";

export type Tf = "5min" | "15min" | "1h" | "4h";
export const FINE = 5 * MINUTE;
// the chart shows a new state a minute or so after the close (its poll)
export const LAG = 60_000;
export const GAP = 30 * MINUTE;
export const WINDOW = DOW_BARS;
// #250 (§8.106 6): stage 0's labels, research/ledger/trend-labels.csv (run 37947773957, 9,510 rows). Stages 1
// and 2 compute nothing when the file's sha256 is another (trend.yml checks the file against it on every push)
export const TREND_LABELS_SHA256 = "897b76cfdf2d0acd0a7337f802efbfd095f3570aeaec8d8dec614bd5ad73b64a";
// #250 stage 1 (docs §8.106, 段1の結果): research/ledger/trend-choice.json, committed by run 38031410727; stage 2 refuses to run unless the file hashes to this
export const TREND_CHOICE_SHA256 = "db4b2078ea55bb8bf64e41002c53b4fe3b38d3c09add3d91a25ffba81038b7c6";
const JST = 9 * HOUR;

// day-file walk of fetchRecentQuotes (analyze/price-source.ts), sized for
// DOW_BARS + 1 bars: how many calendar days back it may look
export const spanDays = (tf: Tf): number => {
  const perDay = Math.max(1, Math.floor(DAY / LIVE_STEP_MS[tf]));
  const openDays = Math.ceil((WINDOW + 1) / perDay);
  return Math.ceil((openDays * 7) / 5) + 2;
};
// the oldest file key that walk (or fetchYearQuotes) reads at nowMs, as a number
export const oldestKey = (tf: Tf, nowMs: number): number =>
  tf === "4h" ? Number(jstYearKey(nowMs)) - 1 : Number(jstDayKey(nowMs - (spanDays(tf) + 1) * DAY));
export const jstDay = (ms: number) => Math.floor((ms + JST) / DAY);

// ---- bars ----------------------------------------------------------------------------

export interface Bars {
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
export const emptyBars = (n: number): Bars => ({
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
export const fromQuotes = (qs: QuoteCandle[], keyOf: (t: number) => number): Bars => {
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
export const sliceBars = (b: Bars, from: number, to: number): Bars => ({
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
export const pickBars = (b: Bars, idx: number[]): Bars => {
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
export const midClose = (b: Bars, i: number) => (b.bc[i] + b.ac[i]) / 2;
export const midHigh = (b: Bars, i: number) => (b.bh[i] + b.ah[i]) / 2;
export const midLow = (b: Bars, i: number) => (b.bl[i] + b.al[i]) / 2;

export const lowerBound = (xs: ArrayLike<number>, v: number): number => {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (xs[m] < v) lo = m + 1;
    else hi = m;
  }
  return lo;
};
export const hashStr = (s: string) => [...s].reduce((a, ch) => (Math.imul(a, 31) + ch.charCodeAt(0)) | 0, 7);

// ---- the weekend and the holes --------------------------------------------------------------

// #182: which bars the weekend throws away, as the chart's usableBars.
// "inside" (the chart's since #182): a bar whose start and end are both inside
// isMarketClosed (market-hours.ts barInsideClosure). "stamp" (before #182): a
// bar whose open stamp is inside it, which threw away GMO's 4-hour bar
// stamped Sunday 20:00 UTC.
export type Weekend = "inside" | "stamp";
export type WeekendOut = (openMs: number, stepMs: number) => boolean;
export const weekendOutOf = (weekend: Weekend): WeekendOut => (openMs, stepMs) =>
  weekend === "stamp" ? isMarketClosed(openMs) : barInsideClosure(openMs, stepMs);

export interface Gaps {
  shouldExist: (s: number, step: number) => boolean;
  unexplainedGap: (b: Bars, i: number, step: number, holes: Set<number> | null) => boolean;
  gapPrefix: (b: Bars, step: number, holes: Set<number> | null) => Int32Array;
  commonMissing: (series: Bars[], step: number) => Set<number>;
}
export const gapsOf = (weekendOut: WeekendOut): Gaps => {
  // a bar stamped s belongs in GMO's file and is kept by the chart: not
  // thrown away for the weekend (usableBars), and with some of its time
  // certainly open
  const shouldExist = (s: number, step: number): boolean => {
    if (weekendOut(s, step)) return false;
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
  return { shouldExist, unexplainedGap, gapPrefix, commonMissing };
};
// any hole between bar lo and bar hi
export const holeIn = (p: Int32Array, lo: number, hi: number): boolean => hi > lo && p[hi] - p[lo] > 0;

// ---- the label: what the chart's Dow line shows ------------------------------------------

export const STATE_NAMES = ["none", "up", "down", "toUp", "toDown"] as const;
export const STATE_CODE: Record<string, number> = { none: 0, up: 1, down: 2, toUp: 3, toDown: 4 };
// the side a state points to
export const DIR_OF = [0, 1, -1, 1, -1];

export interface Series {
  tf: Tf;
  step: number;
  bars: Bars;
  mids: Array<{ high: number; low: number; close: number }>;
  // Wilder ATR(14) of the mids at each bar (NaN before it has one)
  atr: Float64Array;
  gap: Int32Array;
  // #250 (§8.106 1): whether the bars that should have closed between bar i's close and C leave a hole
  // as unexplainedGap's (GAP or more the market's hours and GMO's own closures do not explain); null:
  // not looked at (dow-hit, §8.90, as it was measured)
  trail: ((i: number, C: number) => boolean) | null;
}
export const seriesOf = (tf: Tf, bars: Bars, holes: Set<number> | null, gaps: Gaps, trailing = false): Series => {
  const step = LIVE_STEP_MS[tf];
  const mids = Array.from({ length: bars.n }, (_, i) => ({ high: midHigh(bars, i), low: midLow(bars, i), close: midClose(bars, i) }));
  const a = atrSeriesOf(mids as unknown as Candle[]);
  const atr = Float64Array.from(a, (v) => (v === null ? Number.NaN : v));
  const trail = (i: number, C: number): boolean => {
    let missing = 0;
    for (let s = bars.t[i] + step; s + step <= C; s += step) if (gaps.shouldExist(s, step) && !(holes !== null && holes.has(s))) missing += step;
    return missing >= GAP;
  };
  return { tf, step, bars, mids, atr, gap: gaps.gapPrefix(bars, step, holes), trail: trailing ? trail : null };
};

export interface Labels {
  // 0 none, 1 up, 2 down, 3 toUp, 4 toDown; -1 nothing to read
  state: Int8Array;
  // 1: fewer than DOW_BARS closed bars; 2: an unexplained hole among them (or, s.trail, after them by C)
  excl: Uint8Array;
  // the newest closed bar and the window's first (-1 none)
  bar: Int32Array;
  first: Int32Array;
  // bars since the state began (-1: none)
  age: Int32Array;
}
export const DOW_CALLS = { n: 0 };

// The line at each 5-minute close fineT[k] + 5min, for k0 <= k < k1, as
// fetchDowQuotes -> splitBars -> dowOf would read it a minute later
export const labelsOf = (s: Series, fineT: Float64Array, k0 = 0, k1 = fineT.length): Labels => {
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
    L.excl[k] = (i - start + 1 < WINDOW ? 1 : 0) | (holeIn(s.gap, start, i) || (s.trail !== null && s.trail(i, C)) ? 2 : 0);
  }
  return L;
};

// ---- the chart's own reading, to check the labels against ------------------------------------

// from the files kept in `cache` (real)
export const fileFetcher = (cachePath: (symbol: string, interval: string, side: string, key: string) => string): Fetcher => {
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
export const walkFetcher = (raws: Array<[Tf, Bars]>): Fetcher => {
  const ranges = new Map<string, [number, number, Bars]>();
  for (const [tf, b] of raws) {
    const name = GMO_INTERVALS[tf].name;
    for (let i = 0; i < b.n; i++) {
      const k = `${name}|${b.key[i]}`;
      const r = ranges.get(k);
      if (r) r[1] = i + 1;
      else ranges.set(k, [i, i + 1, b]);
    }
  }
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
export const specialDays = (startMs: number, nowMs: number): number[] => {
  const out: number[] = [];
  const sunday = (y: number, m: number, nth: number) => {
    const first = new Date(Date.UTC(y, m, 1)).getUTCDay();
    return Date.UTC(y, m, 1 + ((7 - first) % 7) + 7 * (nth - 1));
  };
  const lastSunday = (y: number, m: number) => {
    const last = new Date(Date.UTC(y, m + 1, 0));
    return Date.UTC(y, m, last.getUTCDate() - last.getUTCDay());
  };
  for (let y = new Date(startMs).getUTCFullYear(); y <= new Date(nowMs).getUTCFullYear(); y++) {
    out.push(Date.UTC(y, 0, 1), sunday(y, 2, 2), sunday(y, 10, 1), lastSunday(y, 2), lastSunday(y, 9));
  }
  return out.filter((t) => t >= startMs && t < nowMs);
};

// The chart's own reading at nowMs: its state, and how many closed bars it
// read, from which to which (null: it read none)
export interface ChartRead {
  state: string | null;
  count: number;
  first: string | null;
  last: string | null;
}
export const chartRead = async (pair: string, tf: Tf, nowMs: number, fetcher: Fetcher): Promise<ChartRead> => {
  const qs = await fetchDowQuotes(pair, tf, nowMs, Number.MAX_SAFE_INTEGER, fetcher);
  const closed = qs ? splitBars(qs, tf, nowMs).closed : [];
  return {
    state: closed.length > 0 ? dowOf(pair, tf, closed).state : null,
    count: closed.length,
    first: closed[0]?.datetime ?? null,
    last: closed[closed.length - 1]?.datetime ?? null,
  };
};

export interface LiveCheck {
  checked: number;
  mismatches: number;
  examples: string[];
}
export interface LiveCheckCfg {
  startMs: number;
  nowMs: number;
  // moments a pair and timeframe, drawn evenly (the special moments come on top)
  checks: number;
}
export const liveCheck = async (pair: string, s: Series, L: Labels, fine: Bars, fetcher: Fetcher, cfg: LiveCheckCfg): Promise<LiveCheck> => {
  const res: LiveCheck = { checked: 0, mismatches: 0, examples: [] };
  // only moments whose bars all closed by the data's end: the files read
  // after it hold the bar forming then, which the bars here leave out (those
  // moments are past the follow's end, never counted)
  const inRange = (k: number) => fine.t[k] + FINE >= cfg.startMs && fine.t[k] + FINE + s.step <= cfg.nowMs && L.state[k] >= 0;
  const cand: number[] = [];
  for (let k = 1; k < fine.n; k++) if (inRange(k)) cand.push(k);
  if (cand.length === 0) return res;
  const ks: number[] = [];
  const every = Math.max(1, Math.floor(cand.length / cfg.checks));
  for (let j = Math.abs(hashStr(`${pair}|${s.tf}`)) % every; j < cand.length; j += every) ks.push(cand[j]);
  // the week's opens and every other reopening after an hour or more (up
  // to 100, spread out), and the two closes after each
  const opens = cand.filter((k) => fine.t[k] - fine.t[k - 1] >= HOUR);
  const step = Math.max(1, Math.ceil(opens.length / 100));
  for (let j = 0; j < opens.length; j += step) for (let d = 0; d < 3; d++) if (opens[j] + d < fine.n) ks.push(opens[j] + d);
  // New Year and the clocks changing: every hour for a day and a half from the first open after
  for (const day of specialDays(cfg.startMs, cfg.nowMs)) {
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
    const c = await chartRead(pair, s.tf, nowMs, fetcher);
    const mine = STATE_NAMES[L.state[k]];
    const myCount = L.bar[k] - L.first[k] + 1;
    const myFirst = iso(T.t[L.first[k]]);
    const myLast = iso(T.t[L.bar[k]]);
    res.checked++;
    if (c.state !== mine || c.count !== myCount || c.first !== myFirst || c.last !== myLast) {
      res.mismatches++;
      if (res.examples.length < 8) {
        res.examples.push(`${pair} ${s.tf} at ${iso(nowMs)}: chart ${c.state} ${c.count} bars ${c.first}..${c.last}; here ${mine} ${myCount} bars ${myFirst}..${myLast}`);
      }
    }
  }
  return res;
};
