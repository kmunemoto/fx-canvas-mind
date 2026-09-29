// #161: which buy and sell signals are good, as the owner reads a signal —
// "the price then went far enough that Stoch reached the other side" — and
// whether anything at the signal tells them apart. The owner (2026-09-29),
// circling ULTRA's Sell ☆ on a USD/JPY 4-hour chart in a rising market:
// 「赤丸で囲ったsellとかさ、結局その後にstochの20を下回ってないからダメよ」;
// asked how to use it, chose: measure the signals by it, look for a condition
// at the signal that tells the good ones apart, and put one in only if it is
// clearly better (else leave the emails as they are).
//
// THE MEASURE, fixed before any data was read:
//   * a SELL is good when, after its bar, a 4-hour bar closes with Stoch's
//     %K (14, 1, 3) under 20 before the email's stop (10 pips over the bar's
//     mid close) is reached; a BUY mirrored (%K over 80, the stop 10 pips
//     under). The stop is followed on 5-minute bid/ask (a sell's on the ask,
//     a buy's on the bid); a stop inside the bar whose close brings %K there
//     came first (the close is known last). Neither within 30 bars (five
//     days): open, and left out of the rate.
//   * the signals: the emails' own, as #159 (Q-Trend's BUY/SELL and its
//     STRONG ones, ULTRA's Buy/Sell; GMO's pairs, 4-hour bars, 2024-01-01 on,
//     only those the sweep mails), and every close either way (the coin).
//   * against chance: how near %K already is to 20 (80) and how wide the
//     14 bars it reads are set how easily it gets there before a fixed stop,
//     whatever comes next (on a random walk a buy with %K already over 80
//     was "good" 45% of the time, the emails 30%). So each signal is set
//     against every close either way (the coin) that started from the same
//     place — the same side, %K in the same tenth (a sell's counted from
//     100), the 14 bars' high to low in the same band of pips — and what is
//     compared is how far it came out over that ("over chance"). The rate
//     itself is told too.
//   * the conditions at the signal's bar (a buy's; a sell's mirrored): #159's
//     Stoch, BLSH and MACD, and the trend two ways — Q-Trend's (the signal
//     with its trend, against it, either) and Dow theory's (dow.ts, as the
//     chart reads it: with = up or turning up for a buy, against = down or
//     turning down, either). 4 × 7 × 5 × 7 × 3 × 3 = 8,820 patterns.
//
// THE CHOICE, fixed before any data was read (the measure over chance
// was put in after the first random-walk run, before any real data):
//   * chosen on the first half (before SPLIT) only: among the patterns with
//     at least MIN_TRAIN settled signals there (the emails now left out), the
//     one whose margin over chance is highest at the low end of its interval;
//   * put in only if on the second half the low end of its margin is over
//     the emails' margin now (either signal, no condition) — clearly better;
//   * otherwise the emails stay as they are.
//
// On two random walks (12 pairs each, 2025-01-06 on, split 2025-11-03) it
// kept the emails both times; the patterns' margins against the emails' came
// out −0.12 and −0.06 points on average, and 1.9% and 0% cleared them at the
// low end. The rate alone (before the margin over chance) put one in on the
// first of them.
//
// THE RESULT (2026-09-29, docs §8.73): kept. On GMO's 14 pairs with the
// history, 4-hour bars: the emails' signals reached %K 20 (80) before the
// stop 29.8% and 34.9% of the time (first, second half), every close either
// way 30.0% and 33.9%; over chance −1.7 and +0.5 points. ULTRA's 21.4% and
// 24.6% (+1.7, +3.4), Q-Trend's 32.7% and 38.9% (−3.3, −0.7). ULTRA's sells
// while Dow theory read up (the circled kind) 23.7% of 856, while it read
// down 27.5% of 131. The first half chose ULTRA's signals with, for a buy,
// %K at or under 20, BLSH and MACD's histogram rising and against Q-Trend
// (a sell's mirrored): +6.5 there; +2.2 (−3.0 to +7.3, 202 signals, 7% of
// the emails') on the second half, against the emails' +0.5.

import { GMO_INTERVALS, GMO_SYMBOLS, dateKeys, jstDayKey, jstYearKey, klineUrl, mergeSides, parseKlines, type QuoteCandle } from "../supabase/functions/track-outcomes/quotes.ts";
import { isMarketClosed, isPossiblyClosed } from "../supabase/functions/_shared/market-hours.ts";
import type { Candle } from "../supabase/functions/analyze/indicators.ts";
import { barOpenMs } from "../supabase/functions/analyze/state.ts";
import { CHART_BARS, LIVE_STEP_MS, historyRead } from "../supabase/functions/live-chart/logic.ts";
import { QT_DEFAULTS, anchoredStart, barStepMs, qTrend } from "../supabase/functions/_shared/qtrend.ts";
import { ultra, ultraLevels } from "../supabase/functions/_shared/ultra.ts";
import { blsh } from "../supabase/functions/_shared/blsh.ts";
import { macd } from "../supabase/functions/_shared/macd.ts";
import { STOCH_DEFAULTS, stochastic } from "../supabase/functions/_shared/stochastic.ts";
import { dowTheory, type DowState } from "../supabase/functions/_shared/dow.ts";
import { INDICATOR_PAIRS, indicatorIntervalsFor, indicatorSignals, ultraUnit } from "../supabase/functions/signal-alerts/indicators.ts";
import { DAY, HOUR, MINUTE, WEEK, WEEK_OFFSET, aggregate, clusterRate, iso } from "./lib.ts";

const TFS = ["5min", "15min", "1h", "4h", "1day"] as const;
type Tf = (typeof TFS)[number];
const ALL_PAIRS = INDICATOR_PAIRS.filter((p) => indicatorIntervalsFor(p).includes("5min"));
const PAIRS = (Deno.env.get("PAIRS") || ALL_PAIRS.join(",")).split(",").map((s) => s.trim()).filter(Boolean);
const START = Deno.env.get("START") || "2024-01-01";
const SPLIT = Deno.env.get("SPLIT") || "2025-05-19";
const START_MS = Date.parse(`${START}T00:00:00Z`);
const SPLIT_MS = Date.parse(`${SPLIT}T00:00:00Z`);
const NOW = Date.now();
const SYNTHETIC = Boolean(Deno.env.get("SYNTHETIC"));
const CACHE = "research/.cache";
const OUT = "research/out";
const FINE = 5 * MINUTE;
// the sweep's window (signal-alerts HISTORY_BARS, anchoredStart's)
const WINDOW = 600;
// how long a signal is followed: 30 four-hour bars (five days)
const MAX_BARS = 30;
const KS = [1, 2, 3] as const;
// how far before START each timeframe is read, for the window of the first
// bar judged (600 bars: two days of 5-minute bars, a week of 15-minute, five
// weeks of hourly); the 4-hour and daily ones by their year files
const LEAD_DAYS: Record<Tf, number> = { "5min": 5, "15min": 12, "1h": 45, "4h": 0, "1day": 0 };
// a sample of every n-th bar for the blind entries (hashed, so no hour of
// the day is favoured), about the same number on each timeframe
const BLIND_EVERY: Record<Tf, number> = { "5min": 100, "15min": 33, "1h": 8, "4h": 2, "1day": 1 };
// when the sweep reads each chart, minutes after its close (signal-alerts
// indicators.ts gmoIntervalsDue): a signal is mailed if one of them falls
// while the market is open
const READ_AFTER: Record<Tf, number[]> = { "5min": [1, 3], "15min": [1, 3], "1h": [3, 5], "4h": [4, 6], "1day": [4, 6] };
const mailed = (tf: Tf, closeMs: number): boolean => READ_AFTER[tf].some((m) => !isPossiblyClosed(closeMs + m * MINUTE));
// bars checked against indicatorSignals, about 300 a pair on each
const CHECK_EVERY: Record<Tf, number> = { "5min": 661, "15min": 223, "1h": 53, "4h": 13, "1day": 3 };

// ---- GMO's files ---------------------------------------------------------------------

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

// GMO's answer with its bars (a day without any, a weekend's, is an empty
// list), or the 404 of a day it has no file for
const sound = (body: unknown): boolean => {
  if (typeof body !== "object" || body === null) return false;
  const b = body as { status?: unknown; data?: unknown };
  return (b.status === 0 || b.status === 404) && Array.isArray(b.data);
};

interface Loaded {
  quotes: QuoteCandle[];
  requests: number;
  cached: number;
  failed: number;
}

// a seeded random walk on 5 minutes (mulberry32, as research/gmo.ts), the
// other timeframes built from it: on it every timeframe must come out at the
// spread's cost, no better
const synthetic5 = (pair: string, fromMs: number): QuoteCandle[] => {
  let seed = [...pair].reduce((a, ch) => (Math.imul(a, 31) + ch.charCodeAt(0)) | 0, 7);
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
  for (let ms = Math.floor(fromMs / FINE) * FINE; ms + FINE <= NOW; ms += FINE) {
    if (isMarketClosed(ms)) continue;
    const o = px;
    px = o + (rnd() - 0.5) * scale;
    const h = Math.max(o, px) + rnd() * wick;
    const l = Math.min(o, px) - rnd() * wick;
    // stamped as GMO's are once parsed (quotes.ts parseKlines)
    const dt = new Date(ms).toISOString();
    const bid = { datetime: dt, open: o, high: h, low: l, close: px };
    bars.push({ datetime: dt, bid, ask: { ...bid, open: o + spread, high: h + spread, low: l + spread, close: px + spread } });
  }
  return bars;
};
const syntheticCache = new Map<string, QuoteCandle[]>();

const load = async (pair: string, tf: Tf, fromMs: number): Promise<Loaded> => {
  const step = LIVE_STEP_MS[tf];
  if (SYNTHETIC) {
    let fine = syntheticCache.get(pair);
    if (!fine) {
      fine = synthetic5(pair, Date.UTC(new Date(START_MS).getUTCFullYear() - 1, 0, 1));
      syntheticCache.set(pair, fine);
    }
    // GMO's 4-hour and daily bars start at its trading day's roll (21:00 UTC
    // in summer); the walk's are put there too
    const offset = tf === "4h" || tf === "1day" ? 21 * HOUR : 0;
    const quotes = tf === "5min"
      ? fine
      : aggregate(fine, step, offset, NOW)
        .filter((q) => !isMarketClosed(barOpenMs(q.datetime)))
        .map((q) => {
          const dt = new Date(barOpenMs(q.datetime)).toISOString();
          return { datetime: dt, bid: { ...q.bid, datetime: dt }, ask: { ...q.ask, datetime: dt } };
        });
    return { quotes: quotes.filter((q) => barOpenMs(q.datetime) >= fromMs), requests: 0, cached: 0, failed: 0 };
  }
  const symbol = GMO_SYMBOLS[pair];
  const spec = GMO_INTERVALS[tf];
  if (!symbol || !spec) throw new Error(`no GMO file for ${pair} ${tf}`);
  let keys: string[];
  let fresh: Set<string>;
  if (spec.key === "day") {
    const today = jstDayKey(NOW);
    keys = dateKeys(fromMs, NOW, "day").filter((k) => k <= today);
    fresh = new Set(keys.slice(-3));
  } else {
    // a year's file grows until the year ends: read every one again
    keys = [];
    for (let y = Number(jstYearKey(fromMs)); y <= Number(jstYearKey(NOW)); y++) keys.push(String(y));
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
        const path = `${CACHE}/${symbol}/${spec.name}/${side}/${key}.json`;
        let body: unknown;
        if (!fresh.has(key)) {
          try {
            body = JSON.parse(await Deno.readTextFile(path));
          } catch {
            body = undefined;
          }
          // a file kept by another study with an error in it is read again
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
  // the bars the sweep keeps (quotes.ts usableBars), closed by now
  const quotes = mergeSides(bid, ask)
    .filter((q) => {
      const t = Date.parse(q.datetime);
      return Number.isFinite(t) && t >= fromMs && !isMarketClosed(t) && t + step <= NOW;
    });
  return { quotes, requests, cached, failed };
};

// ---- the 5-minute bars trades are followed on ------------------------------------------

interface Fine {
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
const toFine = (qs: QuoteCandle[]): Fine => {
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
// the first index at or after `ms`
const lowerBound = (xs: ArrayLike<number>, ms: number): number => {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (xs[m] < ms) lo = m + 1;
    else hi = m;
  }
  return lo;
};

type Side = "BUY" | "SELL";

// ---- the patterns ----------------------------------------------------------------------

const TF: Tf = "4h";
const MIN_TRAIN = Number(Deno.env.get("MIN_TRAIN") || "150");
const TRIGGERS = ["qtrend", "strong", "ultra", "either"] as const;
type Trigger = (typeof TRIGGERS)[number];
const S_NAMES = ["any", "%K>%D", "%K<%D", "%K<=20", "%K>=80", "%K<50", "%K>50"];
const L_NAMES = ["any", "green", "red", "rising", "falling"];
const M_NAMES = ["any", "hist>0", "hist<0", "hist rising", "hist falling", "line>0", "line<0"];
// the trend: Q-Trend's and Dow theory's, the signal with it or against it
const Q_NAMES = ["any", "with", "against"];
const D_NAMES = ["any", "with", "against"];
const NS = [S_NAMES.length, L_NAMES.length, M_NAMES.length, Q_NAMES.length, D_NAMES.length];
const N_PAT = NS.reduce((a, b) => a * b, 1);
const patOf = (s: number, l: number, m: number, q: number, dw: number) => (((s * NS[1] + l) * NS[2] + m) * NS[3] + q) * NS[4] + dw;
const partsOf = (p: number) => {
  const dw = p % NS[4];
  const q = Math.floor(p / NS[4]) % NS[3];
  const m = Math.floor(p / (NS[4] * NS[3])) % NS[2];
  const l = Math.floor(p / (NS[4] * NS[3] * NS[2])) % NS[1];
  const s = Math.floor(p / (NS[4] * NS[3] * NS[2] * NS[1]));
  return { s, l, m, q, dw };
};
const nameOf = (p: number) => {
  const { s, l, m, q, dw } = partsOf(p);
  return `Stoch ${S_NAMES[s]} · BLSH ${L_NAMES[l]} · MACD ${M_NAMES[m]} · Q-Trend ${Q_NAMES[q]} · Dow ${D_NAMES[dw]}`;
};

// the three at each bar (NaN: not there yet)
interface States {
  k: Float64Array;
  d: Float64Array;
  c: Float64Array;
  cPrev: Float64Array;
  h: Float64Array;
  hPrev: Float64Array;
  line: Float64Array;
  // Q-Trend's trend (1, −1, 0; NaN before it has one) and Dow theory's state
  q: Float64Array;
  dow: Array<DowState>;
}
const nz = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? Number.NaN : v);
// whether condition (s, l, m) holds at bar i for a buy (dir 1) or a sell (dir −1)
const stochOk = (s: number, dir: number, k: number, d: number): boolean => {
  if (s === 0) return true;
  if (Number.isNaN(k) || Number.isNaN(d)) return false;
  const kk = dir === 1 ? k : 100 - k;
  const dd = dir === 1 ? d : 100 - d;
  switch (s) {
    case 1: return kk > dd;
    case 2: return kk < dd;
    case 3: return kk <= 20;
    case 4: return kk >= 80;
    case 5: return kk < 50;
    default: return kk > 50;
  }
};
const blshOk = (l: number, dir: number, c: number, cp: number): boolean => {
  if (l === 0) return true;
  if (Number.isNaN(c)) return false;
  switch (l) {
    case 1: return dir === 1 ? c > 0 : c <= 0;
    case 2: return dir === 1 ? c <= 0 : c > 0;
    case 3: return !Number.isNaN(cp) && (dir === 1 ? c > cp : c < cp);
    default: return !Number.isNaN(cp) && (dir === 1 ? c < cp : c > cp);
  }
};
const macdOk = (m: number, dir: number, h: number, hp: number, line: number): boolean => {
  if (m === 0) return true;
  switch (m) {
    case 1: return !Number.isNaN(h) && (dir === 1 ? h > 0 : h < 0);
    case 2: return !Number.isNaN(h) && (dir === 1 ? h < 0 : h > 0);
    case 3: return !Number.isNaN(h) && !Number.isNaN(hp) && (dir === 1 ? h > hp : h < hp);
    case 4: return !Number.isNaN(h) && !Number.isNaN(hp) && (dir === 1 ? h < hp : h > hp);
    case 5: return !Number.isNaN(line) && (dir === 1 ? line > 0 : line < 0);
    default: return !Number.isNaN(line) && (dir === 1 ? line < 0 : line > 0);
  }
};
// the signal with Q-Trend's trend (1) or against it (2)
const qtOk = (q: number, dir: number, t: number): boolean => (q === 0 ? true : Number.isNaN(t) || t === 0 ? false : q === 1 ? t === dir : t === -dir);
// the signal with Dow theory's trend (up or turning up, for a buy) or against it
const dowOk = (dw: number, dir: number, state: DowState): boolean => {
  if (dw === 0) return true;
  const up = state === "up" || state === "toUp";
  const down = state === "down" || state === "toDown";
  const withIt = dir === 1 ? up : down;
  const against = dir === 1 ? down : up;
  return dw === 1 ? withIt : against;
};
// every pattern's truth at bar i for one side, as a bitset over N_PAT
const holdsAt = (st: States, i: number, dir: number): Uint8Array => {
  const out = new Uint8Array(N_PAT);
  const sOk = S_NAMES.map((_, s) => stochOk(s, dir, st.k[i], st.d[i]));
  const lOk = L_NAMES.map((_, l) => blshOk(l, dir, st.c[i], st.cPrev[i]));
  const mOk = M_NAMES.map((_, m) => macdOk(m, dir, st.h[i], st.hPrev[i], st.line[i]));
  const qOk = Q_NAMES.map((_, q) => qtOk(q, dir, st.q[i]));
  const dOk = D_NAMES.map((_, dw) => dowOk(dw, dir, st.dow[i]));
  for (let s = 0; s < NS[0]; s++) {
    if (!sOk[s]) continue;
    for (let l = 0; l < NS[1]; l++) {
      if (!lOk[l]) continue;
      for (let m = 0; m < NS[2]; m++) {
        if (!mOk[m]) continue;
        for (let q = 0; q < NS[3]; q++) {
          if (!qOk[q]) continue;
          for (let dw = 0; dw < NS[4]; dw++) if (dOk[dw]) out[patOf(s, l, m, q, dw)] = 1;
        }
      }
    }
  }
  return out;
};

// one signal's outcome: settled (good or not) or open, its week, its half
interface Outcome {
  t: number;
  week: number;
  first: boolean;
  settled: boolean;
  win: boolean;
  pips: number;
  // where it started: side, %K's tenth, the 14 bars' range band (the chance it is set against)
  bucket: string;
}
// per trigger × pattern × half: counts, the chance summed, and per-week sums
interface Cell {
  n: number;
  settled: number;
  wins: number;
  exp: number;
  pips: number;
  weeks: Map<number, { n: number; w: number; e: number }>;
}
const newCell = (): Cell => ({ n: 0, settled: 0, wins: 0, exp: 0, pips: 0, weeks: new Map() });
// the 14 bars' high to low, in pips: the bands' upper edges
const R_EDGES = [10, 20, 30, 45, 70, 100, 150];
// every close either way, good or not, by where it started (both halves)
const chance = new Map<string, { n: number; w: number }>();
const tally = (key: string, win: boolean) => {
  const c = chance.get(key) ?? { n: 0, w: 0 };
  c.n++;
  if (win) c.w++;
  chance.set(key, c);
};
// the chance for a start: its own place, or with fewer than 50 closes
// there, the same side and tenth, or the side
const MIN_CHANCE = 50;
const chanceOf = (bucket: string): number => {
  const parts = bucket.split("|");
  for (const key of [bucket, parts.slice(0, 2).join("|"), parts[0]]) {
    const c = chance.get(key);
    if (c && c.n >= MIN_CHANCE) return c.w / c.n;
  }
  return 0;
};
const cells: Record<Trigger, Array<[Cell, Cell]>> = Object.fromEntries(
  TRIGGERS.map((tr) => [tr, Array.from({ length: N_PAT }, () => [newCell(), newCell()] as [Cell, Cell])]),
) as Record<Trigger, Array<[Cell, Cell]>>;
const coin: [Cell, Cell] = [newCell(), newCell()];
const add = (c: Cell, o: Outcome) => {
  c.n++;
  c.pips += o.pips;
  if (!o.settled) return;
  const e = chanceOf(o.bucket);
  c.settled++;
  c.exp += e;
  if (o.win) c.wins++;
  const w = c.weeks.get(o.week) ?? { n: 0, w: 0, e: 0 };
  w.n++;
  w.e += e;
  if (o.win) w.w++;
  c.weeks.set(o.week, w);
};
// the rate and its 95% interval, cluster-robust by week (research/lib.ts clusterRate's arithmetic)
const rateOf = (c: Cell) => {
  if (c.settled === 0) return { p: null as number | null, lo: null as number | null, hi: null as number | null };
  const p = c.wins / c.settled;
  const C = c.weeks.size;
  let s = 0;
  for (const g of c.weeks.values()) s += (g.w - p * g.n) ** 2;
  const se = C > 1 ? Math.sqrt((C / (C - 1)) * s) / c.settled : Number.NaN;
  return { p, lo: Number.isFinite(se) ? p - 1.96 * se : null, hi: Number.isFinite(se) ? p + 1.96 * se : null };
};
// the margin over chance (the rate less the chance of the same starts) and
// its 95% interval, cluster-robust by week
const overOf = (c: Cell) => {
  if (c.settled === 0) return { p: null as number | null, lo: null as number | null, hi: null as number | null };
  const x = (c.wins - c.exp) / c.settled;
  const C = c.weeks.size;
  let s = 0;
  for (const g of c.weeks.values()) s += (g.w - g.e - x * g.n) ** 2;
  const se = C > 1 ? Math.sqrt((C / (C - 1)) * s) / c.settled : Number.NaN;
  return { p: x, lo: Number.isFinite(se) ? x - 1.96 * se : null, hi: Number.isFinite(se) ? x + 1.96 * se : null };
};

interface Cover {
  pair: string;
  bars: number;
  first: string | null;
  last: string | null;
  judged: number;
  signals: number;
  entries: number;
  failed: number;
}
const coverage: Cover[] = [];
// what is added once the chance table has every pair's closes
const pendingCoin: Outcome[] = [];
const pendingSignals: Array<{ trs: Trigger[]; h: Uint8Array; o: Outcome; half: 0 | 1; dowKey: string }> = [];
const check = { compared: 0, mismatched: 0, examples: [] as string[] };
const stateCheck = { compared: 0, mismatched: 0, examples: [] as string[] };
// Dow theory read on the whole history against it read up to the bar alone
// (nothing it says at a bar may come from later bars), and Stoch's %K read on
// the whole history against the window's
const dowCheck = { compared: 0, mismatched: 0, examples: [] as string[] };
const kCheck = { compared: 0, mismatched: 0, examples: [] as string[] };
// the circled kind: each rule's signals by Dow theory's reading at the
// signal (with, against, neither), per side and half — told, not chosen on
const byDow = new Map<string, [Cell, Cell]>();
const dowCell = (key: string) => {
  let c = byDow.get(key);
  if (!c) {
    c = [newCell(), newCell()];
    byDow.set(key, c);
  }
  return c;
};
const weekOf = (t: number) => Math.floor((t - WEEK_OFFSET) / WEEK);

for (const pair of PAIRS) {
  const unit = ultraUnit(pair);
  const fineGot = await load(pair, "5min", START_MS - LEAD_DAYS["5min"] * DAY);
  const fine = toFine(fineGot.quotes);
  const step = LIVE_STEP_MS[TF];
  const got = await load(pair, TF, Date.UTC(new Date(START_MS).getUTCFullYear() - 1, 0, 1) - 9 * HOUR);
  const candles = historyRead(pair, TF, got.quotes, NOW).candles;
  const byOpen = new Map(got.quotes.map((q) => [barOpenMs(q.datetime), q]));
  const n = candles.length;
  const times = new Float64Array(n);
  candles.forEach((c, i) => (times[i] = barOpenMs(c.datetime)));
  const qs = Array.from(times, (t) => byOpen.get(t)!);
  if (qs.some((q) => !q)) throw new Error(`${pair}: a chart bar without its quote`);

  // the sweep's window and start, as #157's
  const anchorOf = (i: number): { ws: number; s: number } | null => {
    if (i < WINDOW - 1) return null;
    const ws = i - WINDOW + 1;
    const w = times.subarray(ws, i + 1) as unknown as number[];
    const last = i - ws;
    const firstShown = Math.max(0, last - (CHART_BARS - 1));
    return { ws, s: ws + anchoredStart(w, barStepMs(w.slice(firstShown)), firstShown, QT_DEFAULTS.period, last) };
  };

  // Dow theory as the chart reads it, on the whole history (checked below
  // against a read that stops at the bar)
  const dowAll = dowTheory(candles).states;
  // Stoch's %K on every bar, for what came after each signal
  const kAll = stochastic(candles, STOCH_DEFAULTS).k;
  const st: States = { k: new Float64Array(n).fill(Number.NaN), d: new Float64Array(n).fill(Number.NaN), c: new Float64Array(n).fill(Number.NaN), cPrev: new Float64Array(n).fill(Number.NaN), h: new Float64Array(n).fill(Number.NaN), hPrev: new Float64Array(n).fill(Number.NaN), line: new Float64Array(n).fill(Number.NaN), q: new Float64Array(n).fill(Number.NaN), dow: dowAll };
  const segOf = new Int32Array(n).fill(-1);
  const judgedBar = new Uint8Array(n);
  const signals: Array<{ i: number; rule: "qtrend" | "ultra"; side: Side; strong: boolean }> = [];
  const threeOf = (bars: Candle[]) => {
    const s = stochastic(bars, STOCH_DEFAULTS);
    const b = blsh(bars);
    const m = macd(bars.map((x) => x.close));
    return { k: s.k, d: s.d, c: b.composite, h: m.hist, line: m.macd };
  };
  let seg: { s: number; from: number; to: number } | null = null;
  const flush = () => {
    if (!seg) return;
    const bars = candles.slice(seg.s, seg.to + 1);
    const qt = qTrend(bars, QT_DEFAULTS, bars.length - 1);
    for (let at = seg.from; at <= seg.to; at++) {
      const v = qt.trend[at - seg.s];
      st.q[at] = v === null || v === undefined ? Number.NaN : v;
    }
    for (const x of qt.signals) {
      const at = seg.s + x.i;
      if (at >= seg.from && at <= seg.to) signals.push({ i: at, rule: "qtrend", side: x.side, strong: x.strong });
    }
    const ul = ultra(bars, bars.length - 1, unit);
    for (const tr of ul.trades) {
      const at = seg.s + tr.i;
      if (at >= seg.from && at <= seg.to) signals.push({ i: at, rule: "ultra", side: tr.side, strong: false });
    }
    const r = threeOf(bars);
    for (let at = seg.from; at <= seg.to; at++) {
      const j = at - seg.s;
      st.k[at] = nz(r.k[j]);
      st.d[at] = nz(r.d[j]);
      st.c[at] = nz(r.c[j]);
      st.cPrev[at] = j > 0 ? nz(r.c[j - 1]) : Number.NaN;
      st.h[at] = nz(r.h[j]);
      st.hPrev[at] = j > 0 ? nz(r.h[j - 1]) : Number.NaN;
      st.line[at] = nz(r.line[j]);
      segOf[at] = seg.s;
    }
    seg = null;
  };
  const i0 = lowerBound(times, START_MS - step);
  let judged = 0;
  for (let i = Math.max(0, i0); i < n; i++) {
    if (times[i] + step < START_MS) continue;
    const a = anchorOf(i);
    if (!a) {
      flush();
      continue;
    }
    judged++;
    judgedBar[i] = 1;
    if (seg && seg.s === a.s && seg.to === i - 1) seg.to = i;
    else {
      flush();
      seg = { s: a.s, from: i, to: i };
    }
  }
  flush();

  // the checks: the signals against the emails' own function, the three
  // against the window read alone
  const mine = new Map<number, string[]>();
  for (const s of signals) mine.set(s.i, [...(mine.get(s.i) ?? []), `${s.rule}:${s.side}:${s.strong ? "S" : "-"}`]);
  for (let i = 0; i < n; i += CHECK_EVERY[TF]) {
    if (!judgedBar[i]) continue;
    const a = anchorOf(i)!;
    const theirs = indicatorSignals(pair, TF, candles.slice(a.ws, i + 1), times[i] + step + 60_000, 120_000)
      .filter((x) => Date.parse(x.barTime) === times[i])
      .map((x) => `${x.rule}:${x.side}:${x.strong ? "S" : "-"}`)
      .sort()
      .join(",");
    const ours = (mine.get(i) ?? []).sort().join(",");
    check.compared++;
    if (theirs !== ours) {
      check.mismatched++;
      if (check.examples.length < 10) check.examples.push(`${pair} ${iso(times[i])} mine=${ours || "-"} theirs=${theirs || "-"}`);
    }
    // Dow theory stopped at the bar says what the whole read says there
    dowCheck.compared++;
    const dowHere = dowTheory(candles.slice(0, i + 1)).states[i];
    if (dowHere !== dowAll[i]) {
      dowCheck.mismatched++;
      if (dowCheck.examples.length < 10) dowCheck.examples.push(`${pair} ${iso(times[i])} ${dowHere}/${dowAll[i]}`);
    }
    // %K on the whole history is the window's (it looks back 14 bars)
    kCheck.compared++;
    if (!(Number.isNaN(st.k[i]) || st.k[i] === nz(kAll[i]))) {
      kCheck.mismatched++;
      if (kCheck.examples.length < 10) kCheck.examples.push(`${pair} ${iso(times[i])} ${st.k[i]}/${kAll[i]}`);
    }
    const r = threeOf(candles.slice(segOf[i], i + 1));
    const L = i - segOf[i];
    const same = (x: number, y: number | null | undefined) => (Number.isNaN(x) ? nz(y) !== nz(y) : x === y);
    stateCheck.compared++;
    if (!(same(st.k[i], r.k[L]) && same(st.d[i], r.d[L]) && same(st.c[i], r.c[L]) && same(st.cPrev[i], r.c[L - 1]) && same(st.h[i], r.h[L]) && same(st.hPrev[i], r.h[L - 1]) && same(st.line[i], r.line[L]))) {
      stateCheck.mismatched++;
      if (stateCheck.examples.length < 10) stateCheck.examples.push(`${pair} ${iso(times[i])}`);
    }
  }

  // where a signal at bar i starts from: its side, %K's tenth (a sell's
  // counted from 100) and the band of the 14 bars' high to low, in pips
  const startOf = (i: number, side: Side): string => {
    const k = nz(kAll[i]);
    if (Number.isNaN(k) || i < STOCH_DEFAULTS.kLength - 1) return `${side}|na`;
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = i - STOCH_DEFAULTS.kLength + 1; j <= i; j++) {
      hi = Math.max(hi, candles[j].high);
      lo = Math.min(lo, candles[j].low);
    }
    const kk = side === "BUY" ? k : 100 - k;
    const r = R_EDGES.findIndex((e) => (hi - lo) / unit < e);
    return `${side}|k${Math.min(9, Math.floor(kk / 10))}|r${r === -1 ? R_EDGES.length : r}`;
  };
  // what came after a signal at bar i: good (%K to 20 for a sell, 80 for a
  // buy, on a bar's close) or the stop first; null when not a signal the
  // sweep would mail, or when the data ends before either is known
  const outcomeAt = (i: number, side: Side): Outcome | null => {
    const T = times[i] + step;
    if (T < START_MS || !mailed(TF, T) || !judgedBar[i]) return null;
    const buy = side === "BUY";
    const lv = ultraLevels(side, candles[i].close, unit);
    let f = lowerBound(fine.t, T);
    if (f >= fine.n) return null;
    const bucket = startOf(i, side);
    const settle = (good: boolean): Outcome => ({ t: T, week: weekOf(T), first: T < SPLIT_MS, settled: true, win: good, pips: 0, bucket });
    for (let j = i + 1; j <= i + MAX_BARS; j++) {
      if (j >= n) return null;
      const end = times[j] + step;
      // the 5-minute bars up to bar j's close: the stop
      while (f < fine.n && fine.t[f] < end) {
        if (buy ? fine.bl[f] <= lv.sl : fine.ah[f] >= lv.sl) return settle(false);
        f++;
      }
      if (f >= fine.n && fine.t[fine.n - 1] + FINE < end) return null;
      // then the close: %K there
      const k = nz(kAll[j]);
      if (!Number.isNaN(k) && (buy ? k > 80 : k < 20)) return settle(true);
    }
    return { t: T, week: weekOf(T), first: T < SPLIT_MS, settled: false, win: false, pips: 0, bucket };
  };
  const outBuy: Array<Outcome | null> = new Array(n).fill(null);
  const outSell: Array<Outcome | null> = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    outBuy[i] = outcomeAt(i, "BUY");
    outSell[i] = outcomeAt(i, "SELL");
  }
  // the coin: every close, either way — the chance table now, its cells
  // once every pair's closes are in the table
  for (let i = 0; i < n; i++) {
    for (const o of [outBuy[i], outSell[i]]) {
      if (!o) continue;
      if (o.settled) {
        tally(o.bucket, o.win);
        const parts = o.bucket.split("|");
        tally(parts.slice(0, 2).join("|"), o.win);
        tally(parts[0], o.win);
      }
      pendingCoin.push(o);
    }
  }
  // triggered: each signal under every pattern that holds on its bar
  const holdCache = new Map<string, Uint8Array>();
  const holds = (i: number, dir: number) => {
    const key = `${i}:${dir}`;
    let h = holdCache.get(key);
    if (!h) {
      h = holdsAt(st, i, dir);
      holdCache.set(key, h);
    }
    return h;
  };
  let entries = 0;
  // one entry per bar and side for "either" (Q-Trend and ULTRA on the same bar and side are one email each, but one trade here)
  const eitherSeen = new Set<string>();
  for (const sg of signals) {
    const o = sg.side === "BUY" ? outBuy[sg.i] : outSell[sg.i];
    if (!o) continue;
    const h = holds(sg.i, sg.side === "BUY" ? 1 : -1);
    const half = o.first ? 0 : 1;
    const trs: Trigger[] = sg.rule === "qtrend" ? (sg.strong ? ["qtrend", "strong"] : ["qtrend"]) : ["ultra"];
    const ek = `${sg.i}:${sg.side}`;
    if (!eitherSeen.has(ek)) {
      eitherSeen.add(ek);
      trs.push("either");
    }
    const dw = dowOk(1, sg.side === "BUY" ? 1 : -1, st.dow[sg.i]) ? "with" : dowOk(2, sg.side === "BUY" ? 1 : -1, st.dow[sg.i]) ? "against" : "neither";
    pendingSignals.push({ trs, h, o, half, dowKey: `${sg.rule} ${sg.side} Dow ${dw}` });
    entries++;
  }
  coverage.push({ pair, bars: n, first: n ? iso(times[0]) : null, last: n ? iso(times[n - 1]) : null, judged, signals: signals.length, entries, failed: fineGot.failed + got.failed });
  console.log(`${pair} ${TF}: ${n} bars, judged ${judged}, signals ${signals.length} (entered ${entries}); GMO failed ${fineGot.failed + got.failed}`);
}

// ---- every signal and close, set against the chance of its start -----------------------

for (const o of pendingCoin) add(coin[o.first ? 0 : 1], o);
for (const x of pendingSignals) {
  for (const tr of x.trs) for (let p = 0; p < N_PAT; p++) if (x.h[p]) add(cells[tr][p][x.half], x.o);
  add(dowCell(x.dowKey)[x.half], x.o);
}

// ---- the report ------------------------------------------------------------------------

const pct = (x: number | null) => (x === null ? "   -  " : `${(100 * x).toFixed(1).padStart(5)}%`);
const num = (x: number | null, d = 2) => (x === null ? "-" : x.toFixed(d));
const pts = (x: number | null) => (x === null ? "   -  " : `${x >= 0 ? "+" : "−"}${(100 * Math.abs(x)).toFixed(1).padStart(4)}`);
const line = (label: string, c: Cell) => {
  const r = rateOf(c);
  const o = overOf(c);
  return `${label.padEnd(58)} ${pct(r.p)} of ${String(c.settled).padStart(5)} (open ${c.n - c.settled}); over chance ${pts(o.p)} [${pts(o.lo)},${pts(o.hi)}]`;
};
const checkLine = (what: string, c: { compared: number; mismatched: number; examples: string[] }) =>
  `${what}: ${c.mismatched} of ${c.compared} differ${c.examples.length ? ": " + c.examples.join("; ") : ""}`;
console.log(`\n#161 good signals by Stoch on ${TF}, ${START} .. ${iso(NOW)} (first half before ${SPLIT})${SYNTHETIC ? " — SYNTHETIC" : ""}; a sell good at %K < 20, a buy at %K > 80, before a 10-pip stop, within ${MAX_BARS} bars; MIN_TRAIN ${MIN_TRAIN}`);
console.log(checkLine("signals against indicatorSignals", check));
console.log(checkLine("the three against the window read alone", stateCheck));
console.log(checkLine("Dow theory against its read up to the bar", dowCheck));
console.log(checkLine("%K on the whole history against the window's", kCheck));
console.log(`GMO reads that failed: ${coverage.reduce((a, c) => a + c.failed, 0)}`);

const base = cells.either[0];
console.log("\n== the yardsticks (first half | second half)");
console.log(line("the emails now (either, any): first", base[0]));
console.log(line("the emails now (either, any): second", base[1]));
for (const tr of ["qtrend", "strong", "ultra"] as const) {
  console.log(line(`${tr}, any: first`, cells[tr][0][0]));
  console.log(line(`${tr}, any: second`, cells[tr][0][1]));
}
console.log(line("the coin (every close, either way): first", coin[0]));
console.log(line("the coin (every close, either way): second", coin[1]));

console.log("\n== the circled kind: each rule's signals by Dow theory at the signal (told, not chosen on)");
for (const key of [...byDow.keys()].sort()) {
  const [a, b] = byDow.get(key)!;
  const both = newCell();
  for (const c of [a, b]) {
    both.n += c.n;
    both.settled += c.settled;
    both.wins += c.wins;
    both.exp += c.exp;
    for (const [w, g] of c.weeks) {
      const was = both.weeks.get(w) ?? { n: 0, w: 0, e: 0 };
      both.weeks.set(w, { n: was.n + g.n, w: was.w + g.w, e: was.e + g.e });
    }
  }
  console.log(line(key, both));
}

// every pattern with enough signals in the first half, ranked by the low
// end of its margin over chance there (its rates told beside)
const all: Array<{ tr: Trigger; p: number; train: ReturnType<typeof overOf>; test: ReturnType<typeof overOf>; rate: [number | null, number | null]; nTrain: number; nTest: number }> = [];
for (const tr of TRIGGERS) {
  for (let p = 0; p < N_PAT; p++) {
    if (tr === "either" && p === 0) continue;
    const [a, b] = cells[tr][p];
    if (a.settled < MIN_TRAIN) continue;
    all.push({ tr, p, train: overOf(a), test: overOf(b), rate: [rateOf(a).p, rateOf(b).p], nTrain: a.settled, nTest: b.settled });
  }
}
all.sort((x, y) => (y.train.lo ?? -1) - (x.train.lo ?? -1));
const tested = TRIGGERS.length * N_PAT - 1;
console.log(`\n== ${all.length} of ${tested} patterns have ${MIN_TRAIN}+ settled signals in the first half; the top 25 by the low end there, and their second half`);
const row = (x: (typeof all)[number]) =>
  `${`${x.tr.padEnd(6)} ${nameOf(x.p)}`.padEnd(104)} first ${pct(x.rate[0])} over ${pts(x.train.p)} [${pts(x.train.lo)}] of ${String(x.nTrain).padStart(5)}  → second ${pct(x.rate[1])} over ${pts(x.test.p)} [${pts(x.test.lo)},${pts(x.test.hi)}] of ${String(x.nTest).padStart(5)}`;
for (const x of all.slice(0, 25)) console.log(row(x));
console.log("\n== the best in each trigger (by the low end in the first half)");
for (const tr of TRIGGERS) {
  const x = all.find((y) => y.tr === tr);
  if (x) console.log(row(x));
}
const baseTrain = overOf(base[0]);
const baseTest = overOf(base[1]);
const beatTrain = all.filter((x) => (x.train.p ?? 0) > (baseTrain.p ?? 1)).length;
const beatTest = all.filter((x) => (x.test.p ?? 0) > (baseTest.p ?? 1)).length;
console.log(`\npatterns over the emails now: first half ${beatTrain} of ${all.length}; second half ${beatTest} of ${all.length}`);
// how far chance alone carries: every pattern kept, its second half's
// margin against the emails' now (on a random walk the mean is about 0)
const withTest = all.filter((x) => x.test.p !== null && baseTest.p !== null);
const meanExcess = withTest.reduce((a, x) => a + ((x.test.p as number) - (baseTest.p as number)), 0) / Math.max(1, withTest.length);
const clear = withTest.filter((x) => x.test.lo !== null && (x.test.lo as number) > (baseTest.p as number)).length;
console.log(`second half against the emails now (margins over chance), all ${withTest.length} kept: mean ${num(100 * meanExcess, 2)} points; low end over the emails ${clear} (${num((100 * clear) / Math.max(1, withTest.length), 1)}%)`);

// THE CHOICE
const chosen = all[0];
let decision = "keep the emails as they are";
if (chosen) {
  const clearly = chosen.test.lo !== null && baseTest.p !== null && chosen.test.lo > baseTest.p;
  if (clearly) decision = `PUT IN: ${chosen.tr} · ${nameOf(chosen.p)}`;
  // what share of the emails' signals it keeps, each half
  const share = (h: 0 | 1) => (cells[chosen.tr][chosen.p][h].settled / Math.max(1, base[h].settled));
  console.log(`\n== THE CHOICE: ${chosen.tr} · ${nameOf(chosen.p)}; second half ${pct(chosen.rate[1])}, over chance ${pts(chosen.test.p)} [${pts(chosen.test.lo)}, ${pts(chosen.test.hi)}] of ${chosen.nTest} (${num(100 * share(1), 0)}% of the emails' signals) against the emails' margin now ${pts(baseTest.p)} (low end over: ${clearly}) → ${decision}`);
} else {
  console.log(`\n== THE CHOICE: no pattern had ${MIN_TRAIN} signals in the first half → ${decision}`);
}

await Deno.mkdir(OUT, { recursive: true });
await Deno.writeTextFile(`${OUT}/stochgood.json`, JSON.stringify({ start: START, split: SPLIT, now: iso(NOW), synthetic: SYNTHETIC, minTrain: MIN_TRAIN, coverage, check, stateCheck, dowCheck, kCheck, base: [rateOf(base[0]), rateOf(base[1]), overOf(base[0]), overOf(base[1])], coin: [rateOf(coin[0]), rateOf(coin[1]), overOf(coin[0]), overOf(coin[1])], byDow: Object.fromEntries([...byDow].map(([k, [a, b]]) => [k, [rateOf(a), rateOf(b), overOf(a), overOf(b)]])), chance: Object.fromEntries(chance), ranked: all.slice(0, 200).map((x) => ({ ...x, name: nameOf(x.p) })), chosen: chosen ? { ...chosen, name: nameOf(chosen.p) } : null, decision }, null, 1));
