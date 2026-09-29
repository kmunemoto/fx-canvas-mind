// #159: every pattern of the signals and the three (Stoch, BLSH, MACD), and
// the one that wins most. The owner (2026-09-29), after #158 (the three all
// the signal's way did not raise the win rate): 「全てのパターン試してみて勝率の
// 良い方法を採用して」; asked, chose the email's own stop and target kept
// (the win rate compared, not changed by moving them) and the 4-hour chart.
//
// THE PATTERNS, fixed before any data was read: a trigger, and one condition
// on each of the three at the entry bar (a buy's; a sell's mirrored):
//   triggers: Q-Trend's signals · its STRONG ones · ULTRA's · either (the
//     emails now) · none (the conditions alone: an entry on the bar they
//     all first hold, after a bar they did not)
//   Stoch (14, 1, 3): any · %K over %D · %K under %D · %K at or under 20 ·
//     %K at or over 80 · %K under 50 · %K over 50
//   BLSH: any · area green (over 0) · area red (at or under 0) · rising ·
//     falling (against the bar before)
//   MACD (12, 26, 9): any · histogram over 0 · under 0 · rising · falling ·
//     MACD line over 0 · under 0
// 5 × 7 × 5 × 7 = 1,225, less "none" with no condition: 1,224 patterns.
// The three read over the same bars as the signals (from anchoredStart), as
// the email would; checked on a sample against the window read alone.
//
// THE METHOD (#157's, research/tf-winrate.ts): GMO's pairs, 4-hour bars,
// 2024-01-01 on, the bars and closes the sweep mails; the email's levels
// (stop 10 pips, TP1 5 pips from the bar's mid close); entered at the close,
// spread paid; followed on 5-minute bid/ask for five days; a win is TP1
// before the stop, the rate over those settled, its 95% interval
// cluster-robust by week.
//
// THE CHOICE, fixed before any data was read (#132 chose on the whole period
// and did worse after, docs §8.45; #157 found the highest rate itself favours
// the fewest trades):
//   * chosen on the first half (before SPLIT) only: among the patterns with
//     at least MIN_TRAIN settled trades there, the one whose rate is highest
//     at the low end of its interval;
//   * adopted only if on the second half its rate is over the emails' now
//     (either trigger, no condition) and the low end of its interval is over
//     the rate of entering at every close either way (the coin);
//   * otherwise the emails stay as they are.
//
// THE RESULT (2026-09-29, docs §8.71): kept. On GMO's 14 pairs with the
// history (4-hour bars), the first half chose either signal with, for a buy,
// Stoch's %K under 50, BLSH rising and MACD's histogram rising (a sell's
// mirrored): 64.9% against the emails' 61.2% there; on the second half 64.7%
// (61.2–68.2%, 921 trades) against the emails' 63.2% and the coin's 61.4%, so
// the low end fell short of the coin. 279 of the 565 patterns kept were over
// the emails on the second half. On the random walk the same pattern once
// came out 3.4 points over the emails.

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
const MAX_HOLD = 5 * 288;
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
type Kind = "tp" | "sl" | "amb" | "open";
// out at `tp` or `sl` from 5-minute bar `from` on; null when the data ends
// before MAX_HOLD bars
const follow = (f: Fine, from: number, side: Side, sl: number, tp: number): { kind: Kind; exit: number; bars: number } | null => {
  const last = from + MAX_HOLD - 1;
  if (from < 0 || last > f.n - 1) return null;
  const buy = side === "BUY";
  const o = buy ? f.bo : f.ao;
  const h = buy ? f.bh : f.ah;
  const l = buy ? f.bl : f.al;
  for (let j = from; j <= last; j++) {
    if (buy ? o[j] <= sl : o[j] >= sl) return { kind: "sl", exit: o[j], bars: j - from + 1 };
    if (buy ? o[j] >= tp : o[j] <= tp) return { kind: "tp", exit: o[j], bars: j - from + 1 };
    const hitTp = buy ? h[j] >= tp : l[j] <= tp;
    const hitSl = buy ? l[j] <= sl : h[j] >= sl;
    if (hitTp && hitSl) return { kind: "amb", exit: sl, bars: j - from + 1 };
    if (hitSl) return { kind: "sl", exit: sl, bars: j - from + 1 };
    if (hitTp) return { kind: "tp", exit: tp, bars: j - from + 1 };
  }
  return { kind: "open", exit: buy ? f.bc[last] : f.ac[last], bars: MAX_HOLD };
};

// ---- the patterns ----------------------------------------------------------------------

const TF: Tf = "4h";
const MIN_TRAIN = Number(Deno.env.get("MIN_TRAIN") || "150");
const TRIGGERS = ["qtrend", "strong", "ultra", "either", "none"] as const;
type Trigger = (typeof TRIGGERS)[number];
const S_NAMES = ["any", "%K>%D", "%K<%D", "%K<=20", "%K>=80", "%K<50", "%K>50"];
const L_NAMES = ["any", "green", "red", "rising", "falling"];
const M_NAMES = ["any", "hist>0", "hist<0", "hist rising", "hist falling", "line>0", "line<0"];
const N_PAT = S_NAMES.length * L_NAMES.length * M_NAMES.length;
const patOf = (s: number, l: number, m: number) => (s * L_NAMES.length + l) * M_NAMES.length + m;
const partsOf = (p: number) => ({ s: Math.floor(p / (L_NAMES.length * M_NAMES.length)), l: Math.floor(p / M_NAMES.length) % L_NAMES.length, m: p % M_NAMES.length });
const nameOf = (p: number) => {
  const { s, l, m } = partsOf(p);
  return `Stoch ${S_NAMES[s]} · BLSH ${L_NAMES[l]} · MACD ${M_NAMES[m]}`;
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
// every pattern's truth at bar i for one side, as a bitset over N_PAT
const holdsAt = (st: States, i: number, dir: number): Uint8Array => {
  const out = new Uint8Array(N_PAT);
  const sOk = S_NAMES.map((_, s) => stochOk(s, dir, st.k[i], st.d[i]));
  const lOk = L_NAMES.map((_, l) => blshOk(l, dir, st.c[i], st.cPrev[i]));
  const mOk = M_NAMES.map((_, m) => macdOk(m, dir, st.h[i], st.hPrev[i], st.line[i]));
  for (let s = 0; s < S_NAMES.length; s++) {
    if (!sOk[s]) continue;
    for (let l = 0; l < L_NAMES.length; l++) {
      if (!lOk[l]) continue;
      for (let m = 0; m < M_NAMES.length; m++) if (mOk[m]) out[patOf(s, l, m)] = 1;
    }
  }
  return out;
};

// one entry's outcome: settled (a win or not) or open, its pips, its week, its half
interface Outcome {
  t: number;
  week: number;
  first: boolean;
  settled: boolean;
  win: boolean;
  pips: number;
}
// per trigger × pattern × half: counts and, for the interval, per-week sums
interface Cell {
  n: number;
  settled: number;
  wins: number;
  pips: number;
  weeks: Map<number, { n: number; w: number }>;
}
const newCell = (): Cell => ({ n: 0, settled: 0, wins: 0, pips: 0, weeks: new Map() });
const cells: Record<Trigger, Array<[Cell, Cell]>> = Object.fromEntries(
  TRIGGERS.map((tr) => [tr, Array.from({ length: N_PAT }, () => [newCell(), newCell()] as [Cell, Cell])]),
) as Record<Trigger, Array<[Cell, Cell]>>;
const coin: [Cell, Cell] = [newCell(), newCell()];
const add = (c: Cell, o: Outcome) => {
  c.n++;
  c.pips += o.pips;
  if (!o.settled) return;
  c.settled++;
  if (o.win) c.wins++;
  const w = c.weeks.get(o.week) ?? { n: 0, w: 0 };
  w.n++;
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
const check = { compared: 0, mismatched: 0, examples: [] as string[] };
const stateCheck = { compared: 0, mismatched: 0, examples: [] as string[] };
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

  const st: States = { k: new Float64Array(n).fill(Number.NaN), d: new Float64Array(n).fill(Number.NaN), c: new Float64Array(n).fill(Number.NaN), cPrev: new Float64Array(n).fill(Number.NaN), h: new Float64Array(n).fill(Number.NaN), hPrev: new Float64Array(n).fill(Number.NaN), line: new Float64Array(n).fill(Number.NaN) };
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
    const r = threeOf(candles.slice(segOf[i], i + 1));
    const L = i - segOf[i];
    const same = (x: number, y: number | null | undefined) => (Number.isNaN(x) ? nz(y) !== nz(y) : x === y);
    stateCheck.compared++;
    if (!(same(st.k[i], r.k[L]) && same(st.d[i], r.d[L]) && same(st.c[i], r.c[L]) && same(st.cPrev[i], r.c[L - 1]) && same(st.h[i], r.h[L]) && same(st.hPrev[i], r.h[L - 1]) && same(st.line[i], r.line[L]))) {
      stateCheck.mismatched++;
      if (stateCheck.examples.length < 10) stateCheck.examples.push(`${pair} ${iso(times[i])}`);
    }
  }

  // what entering at bar i either way did (the email's levels)
  const outcomeAt = (i: number, side: Side): Outcome | null => {
    const T = times[i] + step;
    if (T < START_MS || !mailed(TF, T) || !judgedBar[i]) return null;
    const buy = side === "BUY";
    const lv = ultraLevels(side, candles[i].close, unit);
    const res = follow(fine, lowerBound(fine.t, T), side, lv.sl, lv.tps[0]);
    if (!res) return null;
    const fill = buy ? qs[i].ask.close : qs[i].bid.close;
    const pnl = buy ? res.exit - fill : fill - res.exit;
    return { t: T, week: weekOf(T), first: T < SPLIT_MS, settled: res.kind !== "open", win: res.kind === "tp", pips: pnl / unit };
  };
  const outBuy: Array<Outcome | null> = new Array(n).fill(null);
  const outSell: Array<Outcome | null> = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    outBuy[i] = outcomeAt(i, "BUY");
    outSell[i] = outcomeAt(i, "SELL");
  }
  // the coin: every close, either way
  for (let i = 0; i < n; i++) {
    for (const o of [outBuy[i], outSell[i]]) if (o) add(coin[o.first ? 0 : 1], o);
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
    for (const tr of trs) for (let p = 0; p < N_PAT; p++) if (h[p]) add(cells[tr][p][half], o);
    entries++;
  }
  // none: the bar the conditions all first hold (after a judged bar where they did not)
  for (const [dir, outs] of [[1, outBuy], [-1, outSell]] as Array<[number, Array<Outcome | null>]>) {
    let prev: Uint8Array | null = null;
    for (let i = 0; i < n; i++) {
      if (!judgedBar[i] || Number.isNaN(st.k[i])) {
        prev = null;
        continue;
      }
      const h = holdsAt(st, i, dir);
      const o = outs[i];
      if (prev && o) {
        const half = o.first ? 0 : 1;
        for (let p = 1; p < N_PAT; p++) if (h[p] && !prev[p]) add(cells.none[p][half], o);
      }
      prev = h;
    }
  }
  coverage.push({ pair, bars: n, first: n ? iso(times[0]) : null, last: n ? iso(times[n - 1]) : null, judged, signals: signals.length, entries, failed: fineGot.failed + got.failed });
  console.log(`${pair} ${TF}: ${n} bars, judged ${judged}, signals ${signals.length} (entered ${entries}); GMO failed ${fineGot.failed + got.failed}`);
}

// ---- the report ------------------------------------------------------------------------

const pct = (x: number | null) => (x === null ? "   -  " : `${(100 * x).toFixed(1).padStart(5)}%`);
const num = (x: number | null, d = 2) => (x === null ? "-" : x.toFixed(d));
const line = (label: string, c: Cell) => {
  const r = rateOf(c);
  return `${label.padEnd(58)} ${pct(r.p)} [${pct(r.lo)},${pct(r.hi)}] of ${String(c.settled).padStart(5)} (open ${c.n - c.settled})  pips/trade ${num(c.n ? c.pips / c.n : null)}`;
};
console.log(`\n#159 every pattern on ${TF}, ${START} .. ${iso(NOW)} (first half before ${SPLIT})${SYNTHETIC ? " — SYNTHETIC" : ""}; stop 10, TP1 5 pips; MIN_TRAIN ${MIN_TRAIN}`);
console.log(`signals against indicatorSignals: ${check.mismatched} of ${check.compared} differ${check.examples.length ? ": " + check.examples.join("; ") : ""}`);
console.log(`the three against the window read alone: ${stateCheck.mismatched} of ${stateCheck.compared} differ${stateCheck.examples.length ? ": " + stateCheck.examples.join("; ") : ""}`);
console.log(`GMO reads that failed: ${coverage.reduce((a, c) => a + c.failed, 0)}`);

const base = cells.either[0];
console.log("\n== the yardsticks (first half | second half)");
console.log(line("the emails now (either, any): first", base[0]));
console.log(line("the emails now (either, any): second", base[1]));
console.log(line("the coin (every close, either way): first", coin[0]));
console.log(line("the coin (every close, either way): second", coin[1]));

// every pattern with enough trades in the first half, ranked by the low end there
const all: Array<{ tr: Trigger; p: number; train: ReturnType<typeof rateOf>; test: ReturnType<typeof rateOf>; nTrain: number; nTest: number }> = [];
for (const tr of TRIGGERS) {
  for (let p = 0; p < N_PAT; p++) {
    if (tr === "none" && p === 0) continue;
    const [a, b] = cells[tr][p];
    if (a.settled < MIN_TRAIN) continue;
    all.push({ tr, p, train: rateOf(a), test: rateOf(b), nTrain: a.settled, nTest: b.settled });
  }
}
all.sort((x, y) => (y.train.lo ?? -1) - (x.train.lo ?? -1));
const tested = TRIGGERS.length * N_PAT - 1;
console.log(`\n== ${all.length} of ${tested} patterns have ${MIN_TRAIN}+ settled trades in the first half; the top 25 by the low end there, and their second half`);
for (const x of all.slice(0, 25)) {
  console.log(`${`${x.tr.padEnd(6)} ${nameOf(x.p)}`.padEnd(70)} first ${pct(x.train.p)} [${pct(x.train.lo)}] of ${String(x.nTrain).padStart(5)}  → second ${pct(x.test.p)} [${pct(x.test.lo)},${pct(x.test.hi)}] of ${String(x.nTest).padStart(5)}`);
}
console.log("\n== the best in each trigger (by the low end in the first half)");
for (const tr of TRIGGERS) {
  const x = all.find((y) => y.tr === tr);
  if (x) console.log(`${`${tr.padEnd(6)} ${nameOf(x.p)}`.padEnd(70)} first ${pct(x.train.p)} [${pct(x.train.lo)}] of ${x.nTrain}  → second ${pct(x.test.p)} [${pct(x.test.lo)},${pct(x.test.hi)}] of ${x.nTest}`);
}
const baseTest = rateOf(base[1]);
const coinTest = rateOf(coin[1]);
const beatTrain = all.filter((x) => (x.train.p ?? 0) > (rateOf(base[0]).p ?? 1)).length;
const beatTest = all.filter((x) => (x.test.p ?? 0) > (baseTest.p ?? 1)).length;
console.log(`\npatterns over the emails now: first half ${beatTrain} of ${all.length}; second half ${beatTest} of ${all.length}`);
// how far chance alone carries: over every pattern kept, the second half
// against the coin (on a random walk the mean is about 0 and a few per cent
// clear it at the low end)
const withTest = all.filter((x) => x.test.p !== null && coinTest.p !== null);
const meanExcess = withTest.reduce((a, x) => a + ((x.test.p as number) - (coinTest.p as number)), 0) / Math.max(1, withTest.length);
const clear = withTest.filter((x) => x.test.lo !== null && (x.test.lo as number) > (coinTest.p as number)).length;
console.log(`second half against the coin, all ${withTest.length} kept: mean ${num(100 * meanExcess, 2)} points; low end over the coin ${clear} (${num((100 * clear) / Math.max(1, withTest.length), 1)}%)`);

// THE CHOICE
const chosen = all[0];
let decision = "keep the emails as they are";
if (chosen && !(chosen.tr === "either" && chosen.p === 0)) {
  const over = chosen.test.p !== null && baseTest.p !== null && chosen.test.p > baseTest.p;
  const overCoin = chosen.test.lo !== null && coinTest.p !== null && chosen.test.lo > coinTest.p;
  if (over && overCoin) decision = `ADOPT: ${chosen.tr} · ${nameOf(chosen.p)}`;
  console.log(`\n== THE CHOICE: ${chosen.tr} · ${nameOf(chosen.p)}; second half ${pct(chosen.test.p)} [${pct(chosen.test.lo)}, ${pct(chosen.test.hi)}] of ${chosen.nTest} against the emails now ${pct(baseTest.p)} (over: ${over}) and the coin ${pct(coinTest.p)} (low end over: ${overCoin}) → ${decision}`);
} else {
  console.log(`\n== THE CHOICE: the emails now themselves ranked first → ${decision}`);
}

await Deno.mkdir(OUT, { recursive: true });
await Deno.writeTextFile(`${OUT}/patterns.json`, JSON.stringify({ start: START, split: SPLIT, now: iso(NOW), synthetic: SYNTHETIC, minTrain: MIN_TRAIN, coverage, check, stateCheck, base: [rateOf(base[0]), rateOf(base[1])], coin: [rateOf(coin[0]), rateOf(coin[1])], ranked: all.slice(0, 200).map((x) => ({ ...x, name: nameOf(x.p) })), chosen: chosen ? { ...chosen, name: nameOf(chosen.p) } : null, decision }, null, 1));
