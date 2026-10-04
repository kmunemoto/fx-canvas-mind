// #187: the stop at 2N. The owner (2026-10-04) chose three of §8.95's
// candidates to measure one by one; this is the second: 「損切りを値幅の2倍に」
// (the Turtles' stop, 2N, in place of the email's fixed 30 pips), on the
// email's signals now, the same trades compared: the win rate, the pips a
// trade and the largest fall. Research only: nothing in the app reads this.
//
// THE MEASURE is docs §8.97, fixed before any data is read (and revised,
// still before it, after an independent review: 982605b); in short:
//   * GMO's pairs, 4-hour bars (the email's signals: Q-Trend and ULTRA, the
//     sweep's reads 0, 4 and 6 minutes after a close), 5-minute bid/ask the
//     trades are followed on, and daily bars (21:00 UTC) for N. START
//     2024-01-01 to END 2026-10-02 21:00 UTC (fixed), the first half before
//     SPLIT 2025-05-19. WEEKEND=stamp (#182's old weekend rule) is for §8.83's
//     numbers again only, and then nothing else is printed.
//   * the entry: the signal bar's close, a buy at the ask, a sell at the bid;
//     the levels from the bar's rounded mid close, as the email's. TP1 20
//     pips (the email's), the whole trade out at it.
//   * the stops: now 30 pips (the email's, not rounded); 2N: twice the
//     Turtles' N, the 20-day Wilder average of the true range of the chart's
//     daily bars (mid, rounded to its digits: pineAtr(days, 20), from the
//     first daily bar read), of the newest daily bar closed by the signal's
//     close T (its open + 24 hours at or before T); 2A: twice the signal
//     bar's 4-hour ATR(14) (the email's own, from its start). The N and A
//     stops' prices rounded to the chart's digits (Math.round). Told: 1N, 3N,
//     1A, 3A, none.
//   * out at whichever a 5-minute bar reaches first (both in one bar: the
//     stop; a bar opening past one: at that open), or at the close of the
//     30th 4-hour bar; 120 bars told. Every rule on the same trades: those
//     whose 120 bars are in the data (and with N and A).
//   * the call, on the email's signals (either) of CALL (the nine pairs the
//     email sends now with 4-hour history from 2024 and not low-priced): for
//     2N and for 2A, "rule less now" a trade; clearly better if both halves'
//     means are over 0 and the whole period's low end (Bonferroni over the
//     two: t at 0.9875 a side, by week and by four weeks each with its own
//     t(C − 1), the lower) is over 0; clearly worse the mirror; else
//     undecided. Beside it the smallest difference it could find, and
//     whether the rule itself is over 0 (the same interval).
//   * told: the win rate (TP1 first of ALL the same trades, beside the
//     coin's at the same stop, and the pips over 0; TP1 first of those ended
//     apart, it rises with a wider stop with no edge at all), the share TP1
//     comes first with no edge and no time-outs (the mean of S/(S+20), not a
//     break-even), the most a trade went against it, the fall counted at
//     the exits, R, the nights held, the stop filled 0.5 and 1 pip worse,
//     A+B, C, each pair, each signal; the told tables with their number of
//     looks and Bonferroni beside each 95%.
//
// NOT MEASURED: swap (the nights only); slippage (but the stop filled
// worse); Rakuten FX's spread; the other timeframes; HUF/JPY, SEK/JPY (no
// 4-hour history before 2026-05), Twelve Data's pairs and gold; the
// Turtles' sizing, entries and exits; the account's fall with the trades
// open together (#188).

import { GMO_INTERVALS, GMO_SYMBOLS, dateKeys, jstDayKey, jstYearKey, klineUrl, mergeSides, parseKlines, type QuoteCandle } from "../supabase/functions/track-outcomes/quotes.ts";
import { barInsideClosure, isMarketClosed, isPossiblyClosed } from "../supabase/functions/_shared/market-hours.ts";
import type { Candle } from "../supabase/functions/analyze/indicators.ts";
import { barOpenMs } from "../supabase/functions/analyze/state.ts";
import { CHART_BARS, LIVE_STEP_MS, historyRead } from "../supabase/functions/live-chart/logic.ts";
import { QT_DEFAULTS, anchoredStart, barStepMs, qTrend } from "../supabase/functions/_shared/qtrend.ts";
import { ULTRA_PAIRS, ultra } from "../supabase/functions/_shared/ultra.ts";
import { pineAtr } from "../supabase/functions/_shared/pine.ts";
import { indicatorSignals, ultraUnit } from "../supabase/functions/signal-alerts/indicators.ts";
import { DAY, GMO_STUDY_PAIRS, HOUR, MINUTE, WEEK, WEEK_OFFSET, aggregate, iso } from "./lib.ts";

const TFS = ["5min", "15min", "1h", "4h", "1day"] as const;
type Tf = (typeof TFS)[number];
const ALL_PAIRS = GMO_STUDY_PAIRS;
// the call's nine: the yen majors and the dollar pairs the email sends now
const CALL = ["USD/JPY", "EUR/JPY", "GBP/JPY", "AUD/JPY", "NZD/JPY", "CAD/JPY", "CHF/JPY", "EUR/USD", "AUD/USD"];
// §8.83's A+B (the call's nine and GBP/USD, NZD/USD, no longer in the app)
const AB = [...CALL, "GBP/USD", "NZD/USD"];
// low-priced: a pip is another thing there
const C_PAIRS = ["TRY/JPY", "ZAR/JPY", "MXN/JPY"];
const PAIRS = (Deno.env.get("PAIRS") || [...AB, ...C_PAIRS].join(",")).split(",").map((s) => s.trim()).filter(Boolean);
for (const p of [...AB, ...C_PAIRS]) if (!GMO_SYMBOLS[p] || !ALL_PAIRS.includes(p)) throw new Error(`${p} is not one of GMO's pairs here`);
const groupOf = (pair: string) => (CALL.includes(pair) ? "CALL" : AB.includes(pair) ? "AB" : C_PAIRS.includes(pair) ? "C" : "D");
const START = Deno.env.get("START") || "2024-01-01";
const SPLIT = Deno.env.get("SPLIT") || "2025-05-19";
const END = Deno.env.get("END") || "2026-10-02T21:00:00Z";
const START_MS = Date.parse(`${START}T00:00:00Z`);
const SPLIT_MS = Date.parse(`${SPLIT}T00:00:00Z`);
const END_ISO = END.includes("T") ? END : END.replace(" ", "T");
const NOW = Date.parse(/[zZ]$|[+-]\d\d:\d\d$/.test(END_ISO) ? END_ISO : `${END_ISO}Z`);
if (!Number.isFinite(NOW)) throw new Error(`END ${END} is not a time`);
const SYNTHETIC = Boolean(Deno.env.get("SYNTHETIC"));
const SEED = Number(Deno.env.get("SEED") || 7);
// the walks' 5-minute bars: "wicks" (#162's), "path" (#165's: 100 small steps,
// the high and low the path's own), "drift" (the path, and a signal's prices
// moved its way, from its first 5-minute bar) or "against" (the same, moved
// against it)
const SYNTH_IN = Deno.env.get("SYNTH");
const SYNTH = SYNTH_IN === "path" || SYNTH_IN === "drift" || SYNTH_IN === "against" ? SYNTH_IN : "wicks";
// "drift" and "against": pips a 5-minute bar
const DRIFT = Number(Deno.env.get("DRIFT") || 0.05);
const DRIFTING = SYNTHETIC && (SYNTH === "drift" || SYNTH === "against");
const DRIFT_SIGN = SYNTH === "against" ? -1 : 1;
// a deliberate look-ahead, for the walks only: N of the daily bar holding the
// signal's close (check n2, and the independent check, must catch it)
const LOOKAHEAD = Boolean(Deno.env.get("LOOKAHEAD"));
if (LOOKAHEAD && !SYNTHETIC) throw new Error("LOOKAHEAD is for the walks only");
// the walks' bars written out as GMO's files are (for research/stop2n-check.py
// to be tried on before the data), into this folder
const DUMPDIR = Deno.env.get("DUMPDIR") || "";
if (DUMPDIR && !SYNTHETIC) throw new Error("DUMPDIR is for the walks only");
// the weekend's bars: "inside" (#182 on: a bar out only when it lies wholly
// inside the closure, barInsideClosure), or "stamp" (before #182: out when
// it opens inside it), as tf-winrate's. "stamp" is for §8.83's numbers again
// only: the candidates are not printed then.
const WEEKEND = Deno.env.get("WEEKEND") || "inside";
if (WEEKEND !== "inside" && WEEKEND !== "stamp") throw new Error(`WEEKEND ${WEEKEND} is neither inside nor stamp`);
const REPRO = WEEKEND === "stamp";
const weekendOut = (openMs: number, stepMs: number): boolean => (WEEKEND === "stamp" ? isMarketClosed(openMs) : barInsideClosure(openMs, stepMs));
// §8.83's numbers (A+B, the emails' signals either, T20 S30 L30, the halves)
// and the run they are from
const REPRO_END = "2026-09-29T14:16:25Z";
const REPRO_ROWS: Array<[number, number]> = [[-1.35, 2416], [-1.27, 2216]];
const CACHE = "research/.cache";
const OUT = Deno.env.get("OUTDIR") || "research/out";
const FINE = 5 * MINUTE;
// the sweep's window (signal-alerts HISTORY_BARS, anchoredStart's)
const WINDOW = 600;
const LEAD_DAYS: Record<Tf, number> = { "5min": 5, "15min": 12, "1h": 45, "4h": 0, "1day": 0 };
// when the sweep reads a 4-hour chart, minutes after its close (#171): a
// signal is mailed if one of them falls while the market may be open
const READ_AFTER: Record<Tf, number[]> = { "5min": [0, 1, 3], "15min": [0, 1, 3], "1h": [0, 3, 5], "4h": [0, 4, 6], "1day": [0, 4, 6] };
const mailed = (tf: Tf, closeMs: number): boolean => READ_AFTER[tf].some((m) => !isPossiblyClosed(closeMs + m * MINUTE));
// bars checked against indicatorSignals besides every bar with a signal
const CHECK_EVERY = 13;
// the email's levels (ULTRA_PAIRS, #166 and #173)
if (ULTRA_PAIRS.sl !== 30 || ULTRA_PAIRS.tp1 !== 20 || ULTRA_PAIRS.tp2 !== 40 || ULTRA_PAIRS.tp3 !== 60) throw new Error("ULTRA_PAIRS is not 30 and 20/40/60: the email has moved");

// ---- Student's t, for the intervals ---------------------------------------------------

const LANCZOS = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
const lgamma = (x: number): number => {
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
  const y = x - 1;
  let a = LANCZOS[0];
  const t = y + 7.5;
  for (let i = 1; i < 9; i++) a += LANCZOS[i] / (y + i);
  return 0.5 * Math.log(2 * Math.PI) + (y + 0.5) * Math.log(t) - t + Math.log(a);
};
// the regularized incomplete beta, by its continued fraction (Lentz)
const betacf = (a: number, b: number, x: number): number => {
  const TINY = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < TINY) d = TINY;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 500; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-15) break;
  }
  return h;
};
const ibeta = (a: number, b: number, x: number): number => {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (bt * betacf(a, b, x)) / a : 1 - (bt * betacf(b, a, 1 - x)) / b;
};
const tCdf = (t: number, df: number): number => {
  const p = 0.5 * ibeta(df / 2, 0.5, df / (df + t * t));
  return t >= 0 ? 1 - p : p;
};
const tqCache = new Map<string, number>();
// the p quantile (p over 0.5) of Student's t with df degrees of freedom
const tQuantile = (p: number, df: number): number => {
  if (!(df >= 1) || !(p > 0.5 && p < 1)) return Number.NaN;
  const key = `${p}:${df}`;
  const hit = tqCache.get(key);
  if (hit !== undefined) return hit;
  let lo = 0;
  let hi = 1;
  while (tCdf(hi, df) < p) hi *= 2;
  for (let k = 0; k < 200 && hi - lo > 1e-12; k++) {
    const mid = (lo + hi) / 2;
    if (tCdf(mid, df) < p) lo = mid;
    else hi = mid;
  }
  const q = (lo + hi) / 2;
  tqCache.set(key, q);
  return q;
};
// against the printed tables, before anything is computed with it
for (const [p, df, want] of [[0.975, 1, 12.706], [0.975, 2, 4.303], [0.975, 10, 2.228], [0.975, 17, 2.110], [0.995, 10, 3.169], [0.95, 5, 2.015], [0.9975, 17, 3.222], [0.975, 1e6, 1.960]]) {
  const got = tQuantile(p, df);
  if (!(Math.abs(got - want) < 1e-3)) throw new Error(`t(${p}, ${df}) came out ${got}, the table's ${want}`);
}

// ---- GMO's files (as research/widestop.ts) -----------------------------------------------

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

interface Loaded {
  quotes: QuoteCandle[];
  requests: number;
  cached: number;
  failed: number;
}

// a seeded random walk on 5 minutes (as research/widestop.ts)
const synthetic5 = (pair: string, fromMs: number): QuoteCandle[] => {
  let seed = [...pair].reduce((a, ch) => (Math.imul(a, 31) + ch.charCodeAt(0)) | 0, SEED);
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
    let h: number;
    let l: number;
    if (SYNTH !== "wicks") {
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
const syntheticCache = new Map<string, QuoteCandle[]>();

// the walk's bars as GMO's files hold them ({status: 0, data: [{openTime,
// open, high, low, close}]}, a side a file), a file a UTC day (5 minutes) or
// a UTC year (4 hours, a day): what research/stop2n-check.py reads
const dump = async (pair: string, tf: Tf, quotes: QuoteCandle[]) => {
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
      const dir = `${DUMPDIR}/${GMO_SYMBOLS[pair]}/${spec.name}/${side}`;
      await Deno.mkdir(dir, { recursive: true });
      await Deno.writeTextFile(`${dir}/${key}.json`, JSON.stringify({ status: 0, data: f[side] }));
    }
  }
};

const load = async (pair: string, tf: Tf, fromMs: number): Promise<Loaded> => {
  const step = LIVE_STEP_MS[tf];
  if (SYNTHETIC) {
    let fine = syntheticCache.get(pair);
    if (!fine) {
      fine = synthetic5(pair, Date.UTC(new Date(START_MS).getUTCFullYear() - 1, 0, 1));
      syntheticCache.set(pair, fine);
    }
    const offset = tf === "4h" || tf === "1day" ? 21 * HOUR : 0;
    const quotes = (tf === "5min"
      ? fine
      : aggregate(fine, step, offset, NOW)
        .filter((q) => !weekendOut(barOpenMs(q.datetime), step))
        .map((q) => {
          const dt = new Date(barOpenMs(q.datetime)).toISOString();
          return { datetime: dt, bid: { ...q.bid, datetime: dt }, ask: { ...q.ask, datetime: dt } };
        })).filter((q) => barOpenMs(q.datetime) >= fromMs);
    if (DUMPDIR) await dump(pair, tf, quotes);
    return { quotes, requests: 0, cached: 0, failed: 0 };
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
  const quotes = mergeSides(bid, ask)
    .filter((q) => {
      const t = Date.parse(q.datetime);
      return Number.isFinite(t) && t >= fromMs && !weekendOut(t, step) && t + step <= NOW;
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


// ---- the rules -----------------------------------------------------------------------

const TF: Tf = "4h";
const TP1 = 20;
type Limit = 30 | 120;
// the stop: pips (k pips), N (k × the daily N), A (k × the signal bar's ATR(14)), none
type StopKind = "pips" | "N" | "A" | "none";
interface Rule {
  key: string;
  stop: StopKind;
  k: number;
  target: number;
  limit: Limit;
}
const rule = (target: number, stop: StopKind, k: number, limit: Limit): Rule => ({
  key: `T${target} S${stop === "pips" ? k : stop === "none" ? "none" : `${k}${stop}`} L${limit}`,
  stop,
  k,
  target,
  limit,
});
const NOW_R = rule(TP1, "pips", 30, 30);
const NOW_RULE = NOW_R.key;
const R2N = rule(TP1, "N", 2, 30);
const R2A = rule(TP1, "A", 2, 30);
// the two the call is on
const CANDIDATES = [R2N.key, R2A.key];
const TOLD_STOPS: Rule[] = [rule(TP1, "N", 1, 30), rule(TP1, "N", 3, 30), rule(TP1, "A", 1, 30), rule(TP1, "A", 3, 30), rule(TP1, "none", 0, 30)];
// every stop (none apart) within 120 bars: told, and the walks' check that
// each stop is where it should be (TP1 first of all at L120 against the mean
// of (S − h) / (S + 20))
const L30_STOPPED: Rule[] = [NOW_R, R2N, R2A, ...TOLD_STOPS].filter((r) => r.stop !== "none");
const L120: Rule[] = L30_STOPPED.map((r) => rule(TP1, r.stop, r.k, 120));
const RULES: Rule[] = [NOW_R, R2N, R2A, ...TOLD_STOPS, ...L120];
const RULE_KEYS = new Set(RULES.map((r) => r.key));
if (RULE_KEYS.size !== RULES.length) throw new Error("two rules with one key");
// TP2 and TP3 (40, 60) under now, 2N and 2A, followed for the signals only
const EXTRAS: Rule[] = [30, 2, 2].flatMap((k, j) => [40, 60].map((t) => rule(t, (["pips", "N", "A"] as const)[j], k, 30)));
const TP23 = new Map<string, [string, string]>([NOW_R, R2N, R2A].map((r, j) => [r.key, [EXTRAS[2 * j].key, EXTRAS[2 * j + 1].key]]));
// the stops' nest (L30, TP1 20), walked in the order of each trade's own widths
const NEST_L30 = [NOW_R, R2N, R2A, ...TOLD_STOPS].map((r) => r.key);
const LIMIT_PAIRS: Array<[string, string]> = L30_STOPPED.map((r, j) => [r.key, L120[j].key]);
// every rule on the trades whose 120 bars are in the data
const NEED = 120;
type Exit = "tp" | "sl" | "amb" | "time";
interface Trade {
  pips: number;
  exit: Exit;
  // four-hour bars and market 5-minute bars to the exit (the one it went out
  // in counted), the time from the entry to the end of that bar, and the
  // 5-minute bar it went out in (its open) and the price
  bars: number;
  f5: number;
  ms: number;
  at: number;
  px: number;
  // TP1's distance and the stop's, pips from the mid close (null: none), and
  // the stop's price
  tgt: number;
  stop: number | null;
  sl: number | null;
  // out at a 5-minute bar's open (past the level)
  atOpen: boolean;
  // the most it went against the trade, pips from the fill to the worst
  // price on the side it goes out on (a buy's bid low, a sell's ask high),
  // from the first 5-minute bar to the one it went out in: out at the stop,
  // to its exit price; out at TP1 within a bar, that bar's own too (the
  // order within it unknown: more, not less); out at an open, to the bar before
  mae: number;
  // half the spread paid at the entry, pips
  h: number;
  // nights held: 21:00 UTC passed between the entry and the exit's bar
  nights: number;
}
// the stop filled this much worse (sensitivity)
const SLIPS = [0.5, 1];
const P_CALL = 1 - 0.025 / CANDIDATES.length;

// ---- the numbers kept ------------------------------------------------------------------

interface Agg {
  n: number;
  sum: number;
  wins: number;
  winSum: number;
  lossSum: number;
  exits: Record<Exit, number>;
  exitSum: Record<Exit, number>;
  // Σ S / (S + TP1) over the trades with a stop S: the break-even share of
  // TP1 first, the spread left out
  be: number;
  beN: number;
  // Σ (S − h) / (S + TP1): the share of TP1 first a walk with no edge gives
  // with the spread, nothing timed out (the walks' check of the stops)
  th: number;
  // nights held, summed
  nights: number;
  stops: number[];
  held: number[];
  // the most against (pips; R; pips of the trades out at TP1)
  mae: number[];
  maeR: number[];
  maeWin: number[];
  weeks: Map<number, { n: number; s: number }>;
  blocks: Map<number, { n: number; s: number }>;
  all: number[];
}
const newAgg = (): Agg => ({ n: 0, sum: 0, wins: 0, winSum: 0, lossSum: 0, exits: { tp: 0, sl: 0, amb: 0, time: 0 }, exitSum: { tp: 0, sl: 0, amb: 0, time: 0 }, be: 0, beN: 0, th: 0, nights: 0, stops: [], held: [], mae: [], maeR: [], maeWin: [], weeks: new Map(), blocks: new Map(), all: [] });
const addTo = (a: Agg, week: number, x: number, t?: Trade, tails = false) => {
  a.n++;
  a.sum += x;
  if (tails) a.all.push(x);
  if (x > 0) {
    a.wins++;
    a.winSum += x;
  } else a.lossSum += x;
  if (t) {
    a.exits[t.exit]++;
    a.exitSum[t.exit] += x;
    a.nights += t.nights;
    if (t.stop !== null) {
      a.be += t.stop / (t.stop + t.tgt);
      a.th += (t.stop - t.h) / (t.stop + t.tgt);
      a.beN++;
      if (tails) {
        a.stops.push(t.stop);
        a.maeR.push(t.mae / t.stop);
      }
    }
    if (tails) {
      a.held.push(t.ms);
      a.mae.push(t.mae);
      if (t.exit === "tp") a.maeWin.push(t.mae);
    }
  }
  for (const [m, k] of [[a.weeks, week], [a.blocks, Math.floor(week / 4)]] as const) {
    const w = m.get(k) ?? { n: 0, s: 0 };
    w.n++;
    w.s += x;
    m.set(k, w);
  }
};
const mergeAgg = (xs: Array<Agg | undefined>): Agg | undefined => {
  const ys = xs.filter((x): x is Agg => Boolean(x));
  if (!ys.length) return undefined;
  const a = newAgg();
  for (const y of ys) {
    a.n += y.n;
    a.sum += y.sum;
    a.wins += y.wins;
    a.winSum += y.winSum;
    a.lossSum += y.lossSum;
    a.be += y.be;
    a.beN += y.beN;
    a.th += y.th;
    a.nights += y.nights;
    for (const k of Object.keys(a.exits) as Exit[]) {
      a.exits[k] += y.exits[k];
      a.exitSum[k] += y.exitSum[k];
    }
    a.stops = a.stops.concat(y.stops);
    a.held = a.held.concat(y.held);
    a.mae = a.mae.concat(y.mae);
    a.maeR = a.maeR.concat(y.maeR);
    a.maeWin = a.maeWin.concat(y.maeWin);
    a.all = a.all.concat(y.all);
    for (const by of ["weeks", "blocks"] as const) {
      for (const [k, g] of y[by]) {
        const w = a[by].get(k) ?? { n: 0, s: 0 };
        w.n += g.n;
        w.s += g.s;
        a[by].set(k, w);
      }
    }
  }
  return a;
};
type By = "weeks" | "blocks";
// the mean, its standard error (cluster-robust by week, or by four weeks)
// and the clusters
const statOf = (a: Agg | undefined, by: By = "weeks") => {
  if (!a || a.n === 0) return null;
  const m = a.sum / a.n;
  const C = a[by].size;
  let s = 0;
  for (const g of a[by].values()) s += (g.s - m * g.n) ** 2;
  const se = C > 1 ? Math.sqrt((C / (C - 1)) * s) / a.n : Number.NaN;
  return { m, se, C };
};
// the mean and its interval, t(C − 1) at `p` a side
const intervalOf = (a: Agg | undefined, by: By = "weeks", p = 0.975) => {
  const st = statOf(a, by);
  if (!st) return { m: null as number | null, lo: null as number | null, hi: null as number | null };
  const q = st.C > 1 ? tQuantile(p, st.C - 1) : Number.NaN;
  const w = q * st.se;
  return Number.isFinite(w) ? { m: st.m, lo: st.m - w, hi: st.m + w } : { m: st.m, lo: null, hi: null };
};
// the lower of the low ends by week and by four weeks, the higher of the high ends
const lowEnd = (a: Agg | undefined, p = 0.975): number | null => {
  const los = (["weeks", "blocks"] as const).map((by) => intervalOf(a, by, p).lo);
  return los.some((x) => x === null) ? null : Math.min(...(los as number[]));
};
const highEnd = (a: Agg | undefined, p = 0.975): number | null => {
  const his = (["weeks", "blocks"] as const).map((by) => intervalOf(a, by, p).hi);
  return his.some((x) => x === null) ? null : Math.max(...(his as number[]));
};
const tailOf = (a: Agg | undefined) => {
  if (!a || a.all.length === 0) return { worst: null as number | null, p5: null as number | null };
  const xs = [...a.all].sort((x, y) => x - y);
  return { worst: xs[0], p5: xs[Math.floor(0.05 * (xs.length - 1))] };
};
const medianOf = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((x, y) => x - y);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

// key → period (0 first half, 1 second) → series (a rule's key; a rule less
// now, its key and DIFF; R, R_ and its key; the stop filled worse, slipKey)
const groups = new Map<string, Array<Map<string, Agg>>>();
const aggOf = (key: string, period: 0 | 1, series: string) => {
  let g = groups.get(key);
  if (!g) {
    g = [new Map(), new Map()];
    groups.set(key, g);
  }
  let a = g[period].get(series);
  if (!a) {
    a = newAgg();
    g[period].set(series, a);
  }
  return a;
};
const aggAt = (key: string, period: 0 | 1, series: string) => groups.get(key)?.[period].get(series);
const aggFull = (key: string, series: string) => mergeAgg([aggAt(key, 0, series), aggAt(key, 1, series)]);
const DIFF = " − now";
const R_ = "R ";
const slipKey = (r: string, s: number) => `${r}${DIFF} slip ${s}`;

// the call's trades, for the fall counted at the exits: rule → [exit time
// (the end of the 5-minute bar it went out in), entry time, pair, pips, R]
const paths = new Map<string, Array<{ t: number; t0: number; pair: string; pips: number; r: number | null; half: 0 | 1 }>>();
// the call's signal trades, for the independent check after the run
const csvRows: string[] = [];

interface Cover {
  pair: string;
  group: string;
  bars: number;
  judged: number;
  signals: number;
  trades: number;
  failed: number;
  days: number;
  // the spread paid at the signals' entries, and the stops' widths at them,
  // medians (min, max) in pips
  spread: number | null;
  widths: Record<string, { med: number | null; min: number | null; max: number | null }>;
  // the daily bars by the weekday they open on (UTC), and those not opening at 21:00
  dayWeekdays: number[];
  dayOff21: number;
  noN: number;
  // the first daily bar read and those before START; the most hours from
  // N's daily bar's close to T, and the daily bars more than 72 hours old
  // when used (with a T they were used at)
  dayFirst: number | null;
  daysBefore: number;
  staleMax: number;
  stale: string[];
}
const coverage: Cover[] = [];
const newCheck = () => ({ compared: 0, mismatched: 0, examples: [] as string[] });
type Check = ReturnType<typeof newCheck>;
const tally = (c: Check, ok: boolean, example: () => string) => {
  c.compared++;
  if (!ok) {
    c.mismatched++;
    if (c.examples.length < 10) c.examples.push(example());
  }
};
const checks = {
  signals: newCheck(), // (a)
  levels: newCheck(), // (a2)
  eps: newCheck(), // (a3)
  atrSeries: newCheck(), // (a4)
  nAgain: newCheck(), // (n1) N by a loop of its own, every daily bar
  nClosed: newCheck(), // (n2) the daily bar N is from: closed by the signal's close, and the newest so
  nCut: newCheck(), // (n3) N again on the daily bars cut at that bar
  placement: newCheck(), // (s) each stop where it should be, and out at it
  stopNest: newCheck(), // (c1)
  limitNest: newCheck(), // (c3)
  closes: newCheck(), // (d)
  widths: newCheck(), // (e) a trade with its N and A, both over 0
  extras: newCheck(), // (e) a signal with its TP2 and TP3
};
const weekOf = (t: number) => Math.floor((t - WEEK_OFFSET) / WEEK);
const sameFull = (a: Trade, b: Trade) => a.pips === b.pips && a.exit === b.exit && a.bars === b.bars && a.f5 === b.f5 && a.ms === b.ms;
const slipOf = (t: Trade, s: number) => (t.exit === "sl" || t.exit === "amb" ? t.pips - s : t.pips);
const roundTo = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;
// the Turtles' N by a loop of its own (check n1): the true range (the first
// bar's its high less its low), its first 20 averaged, then (19 N + TR) / 20
const nByLoop = (days: ReadonlyArray<Candle>, n: number): Array<number | null> => {
  const out: Array<number | null> = [];
  let acc = 0;
  let cur: number | null = null;
  for (let i = 0; i < days.length; i++) {
    const d = days[i];
    const tr = i === 0 ? d.high - d.low : Math.max(d.high, days[i - 1].close) - Math.min(d.low, days[i - 1].close);
    if (cur === null) {
      acc += tr;
      if (i === n - 1) cur = acc / n;
      out.push(cur);
    } else {
      cur = ((n - 1) * cur + tr) / n;
      out.push(cur);
    }
  }
  return out;
};

for (const pair of PAIRS) {
  const unit = ultraUnit(pair);
  const grp = groupOf(pair);
  const fineGot = await load(pair, "5min", START_MS - LEAD_DAYS["5min"] * DAY);
  const fine = toFine(fineGot.quotes);
  const step = LIVE_STEP_MS[TF];
  const got = await load(pair, TF, Date.UTC(new Date(START_MS).getUTCFullYear() - 1, 0, 1) - 9 * HOUR);
  const read = historyRead(pair, TF, got.quotes, NOW);
  const candles = read.candles;
  const digits = read.decimals;
  const byOpen = new Map(got.quotes.map((q) => [barOpenMs(q.datetime), q]));
  const n = candles.length;
  const times = new Float64Array(n);
  candles.forEach((c, i) => (times[i] = barOpenMs(c.datetime)));
  const qs = Array.from(times, (t) => byOpen.get(t)!);
  if (qs.some((q) => !q)) throw new Error(`${pair}: a chart bar without its quote`);

  // the daily bars (the chart's: mid, rounded, closed by END) and N on them
  const dayGot = await load(pair, "1day", Date.UTC(new Date(START_MS).getUTCFullYear() - 1, 0, 1) - 9 * HOUR);
  const days = historyRead(pair, "1day", dayGot.quotes, NOW).candles;
  const dTimes = new Float64Array(days.length);
  days.forEach((c, i) => (dTimes[i] = barOpenMs(c.datetime)));
  const nSeries = pineAtr(days, 20);
  // (n1) the same N by a loop of its own
  const again = nByLoop(days, 20);
  for (let k = 0; k < days.length; k++) {
    const x = nSeries[k];
    const y = again[k];
    tally(checks.nAgain, x === null ? y === null : y !== null && Math.abs(x - y) <= 1e-12 * Math.max(1, Math.abs(x)), () => `${pair} ${iso(dTimes[k])} N ${x} / again ${y}`);
  }
  const dayWeekdays = [0, 0, 0, 0, 0, 0, 0];
  let dayOff21 = 0;
  for (const t of dTimes) {
    dayWeekdays[new Date(t).getUTCDay()]++;
    if (((t % DAY) + DAY) % DAY !== 21 * HOUR) dayOff21++;
  }
  // the daily bar whose N a trade entered at T uses: the newest whose open +
  // 24 hours is at or before T (LOOKAHEAD, the walks' test: the one holding T)
  const dayFor = (T: number): number => {
    const k = lowerBound(dTimes, T - DAY + 1) - 1;
    if (!LOOKAHEAD) return k;
    return k + 1 < days.length && dTimes[k + 1] <= T ? k + 1 : k;
  };

  // the sweep's window and start, as #157's
  const anchorOf = (i: number): { ws: number; s: number } | null => {
    if (i < WINDOW - 1) return null;
    const ws = i - WINDOW + 1;
    const w = times.subarray(ws, i + 1) as unknown as number[];
    const last = i - ws;
    const firstShown = Math.max(0, last - (CHART_BARS - 1));
    return { ws, s: ws + anchoredStart(w, barStepMs(w.slice(firstShown)), firstShown, QT_DEFAULTS.period, last) };
  };

  const judgedBar = new Uint8Array(n);
  // ATR(14) at each bar judged, and at the bar before it, on the bars from
  // the bar's own start (the email's)
  const atrAt = new Float64Array(n).fill(Number.NaN);
  const epsAt = new Float64Array(n).fill(Number.NaN);
  const signals: Array<{ i: number; rule: "qtrend" | "ultra"; side: Side; strong: boolean }> = [];
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
    const atr = pineAtr(bars, QT_DEFAULTS.atrPeriod);
    for (let k = seg.from; k <= seg.to; k++) {
      atrAt[k] = atr[k - seg.s] ?? Number.NaN;
      epsAt[k] = k - seg.s - 1 >= 0 ? atr[k - seg.s - 1] ?? Number.NaN : Number.NaN;
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

  // (a), (a2), (a3), (a4): the signals, their levels, ε and the bar's ATR
  // against the emails' own function, on every 13th bar and every bar with a signal
  const mine = new Map<number, string[]>();
  for (const s of signals) mine.set(s.i, [...(mine.get(s.i) ?? []), `${s.rule}:${s.side}:${s.strong ? "S" : "-"}`]);
  const toCheck = new Set<number>(signals.map((s) => s.i));
  for (let i = 0; i < n; i += CHECK_EVERY) toCheck.add(i);
  for (const i of [...toCheck].sort((x, y) => x - y)) {
    if (!judgedBar[i]) continue;
    const a = anchorOf(i)!;
    const xs = indicatorSignals(pair, TF, candles.slice(a.ws, i + 1), times[i] + step + 60_000, 120_000).filter((x) => Date.parse(x.barTime) === times[i]);
    const theirs = xs.map((x) => `${x.rule}:${x.side}:${x.strong ? "S" : "-"}`).sort().join(",");
    const ours = (mine.get(i) ?? []).sort().join(",");
    tally(checks.signals, theirs === ours, () => `${pair} ${iso(times[i])} mine=${ours || "-"} theirs=${theirs || "-"}`);
    const c = candles[i].close;
    for (const x of xs) {
      const dir = x.side === "BUY" ? 1 : -1;
      const ok = x.close === c && x.sl === c - dir * 30 * unit && x.tps !== null && x.tps[0] === c + dir * 20 * unit && x.tps[1] === c + dir * 40 * unit && x.tps[2] === c + dir * 60 * unit;
      tally(checks.levels, ok, () => `${pair} ${iso(times[i])} ${x.rule} ${x.side} close ${x.close}/${c} sl ${x.sl} tps ${x.tps?.join("/")}`);
      if (x.rule === "qtrend") {
        const e = epsAt[i];
        const okE = x.eps === null ? !Number.isFinite(e) : x.eps === QT_DEFAULTS.mult * e;
        tally(checks.eps, okE, () => `${pair} ${iso(times[i])} ε ${x.eps} / ATR before ${e}`);
      }
    }
    const own = pineAtr(candles.slice(a.s, i + 1), QT_DEFAULTS.atrPeriod).at(-1) ?? Number.NaN;
    tally(checks.atrSeries, Number.isFinite(own) && own === atrAt[i], () => `${pair} ${iso(times[i])} ATR ${atrAt[i]} / again ${own}`);
  }

  // a trade entered at bar i's close under rule r (A: the bar's ATR(14), N:
  // the daily N), followed on the 5-minute bid/ask (under "drift", a
  // signal's prices moved its way); null when not a signal the sweep would
  // mail, or when its 120 bars are not all in the data
  const tradeAt = (i: number, side: Side, r: Rule, A: number, N: number, drift: boolean): Trade | null => {
    const T = times[i] + step;
    if (T < START_MS || !mailed(TF, T) || !judgedBar[i]) return null;
    if (i + NEED >= n) return null;
    const buy = side === "BUY";
    const dir = buy ? 1 : -1;
    const close = candles[i].close;
    // as ultraLevels: entry + dir * target * unit
    const tp = close + dir * r.target * unit;
    const sl = r.stop === "none" ? null : r.stop === "pips" ? close - dir * r.k * unit : roundTo(close - dir * r.k * (r.stop === "N" ? N : A), digits);
    const stop = sl === null ? null : Math.abs(close - sl) / unit;
    const fill = buy ? qs[i].ask.close : qs[i].bid.close;
    const h = (qs[i].ask.close - qs[i].bid.close) / 2 / unit;
    const pipsOf = (exit: number) => (buy ? exit - fill : fill - exit) / unit;
    // pips against the trade at a price on its exit side
    const against = (px: number) => (buy ? fill - px : px - fill) / unit;
    const o = buy ? fine.bo : fine.ao;
    const h5 = buy ? fine.bh : fine.ah;
    const l5 = buy ? fine.bl : fine.al;
    const c = buy ? fine.bc : fine.ac;
    let f = lowerBound(fine.t, T);
    if (f >= fine.n) return null;
    const f0 = f;
    const mu = drift ? DRIFT_SIGN * dir * DRIFT * unit : 0;
    // 21:00 UTC passed between T and `at` (the open of the bar it went out in)
    const nightsTo = (at: number) => Math.floor((at - 21 * HOUR) / DAY) - Math.floor((T - 21 * HOUR) / DAY);
    // from the entry: its own exit-side price (the spread down)
    let mae = against(buy ? qs[i].bid.close : qs[i].ask.close);
    const out = (px: number, exit: Exit, bars: number, at: number, atOpen: boolean, worst: number): Trade => ({ pips: pipsOf(px), exit, bars, f5: at - f0 + 1, ms: fine.t[at] + FINE - T, at: fine.t[at], px, tgt: r.target, stop, sl, atOpen, mae: Math.max(mae, worst), h, nights: nightsTo(fine.t[at]) });
    for (let j = i + 1; j <= i + r.limit; j++) {
      const end = times[j] + step;
      const bars = j - i;
      while (f < fine.n && fine.t[f] < end) {
        const sh = mu * (f - f0 + 1);
        const of = o[f] + sh;
        const hf = h5[f] + sh;
        const lf = l5[f] + sh;
        if (sl !== null && (buy ? of <= sl : of >= sl)) return out(of, "sl", bars, f, true, against(of));
        if (buy ? of >= tp : of <= tp) return out(of, "tp", bars, f, true, -Infinity);
        const hitSl = sl !== null && (buy ? lf <= sl : hf >= sl);
        const hitTp = buy ? hf >= tp : lf <= tp;
        if (sl !== null && hitSl && hitTp) return out(sl, "amb", bars, f, false, against(sl));
        if (sl !== null && hitSl) return out(sl, "sl", bars, f, false, against(sl));
        const worst = against(buy ? lf : hf);
        if (hitTp) return out(tp, "tp", bars, f, false, worst);
        mae = Math.max(mae, worst);
        f++;
      }
      if (f >= fine.n && fine.t[fine.n - 1] + FINE < end) return null;
      if (f === 0) return null;
      if (j === i + r.limit) {
        // bar j's close (the last 5-minute bar's), where it is taken off at
        // the limit; against the 4-hour bar's own (unmoved)
        const closePx = c[f - 1];
        const own = buy ? qs[j].bid.close : qs[j].ask.close;
        tally(checks.closes, Math.abs(closePx - own) <= unit / 1000, () => `${pair} ${iso(times[j])} ${side} ${closePx}/${own}`);
        const px = closePx + mu * (f - f0);
        return { pips: pipsOf(px), exit: "time", bars, f5: f - f0, ms: fine.t[f - 1] + FINE - T, at: fine.t[f - 1], px, tgt: r.target, stop, sl, atOpen: false, mae, h, nights: nightsTo(fine.t[f - 1]) };
      }
    }
    return null;
  };

  let noN = 0;
  let staleMax = 0;
  const stale: string[] = [];
  const staleSeen = new Set<number>();
  const widthsAt: Record<string, number[]> = { [R2N.key]: [], [R2A.key]: [] };
  // every rule on one trade; null when the data does not hold it
  const recordAt = (i: number, side: Side, keys: string[], signal: boolean, either: boolean): Map<string, Trade> | null => {
    const drift = DRIFTING && signal;
    const T = times[i] + step;
    const tag = `${pair} ${iso(T)} ${side}`;
    const now = tradeAt(i, side, NOW_R, Number.NaN, Number.NaN, drift);
    if (!now) return null;
    // N of the newest daily bar closed by T
    const k = dayFor(T);
    const N = k >= 0 ? nSeries[k] ?? Number.NaN : Number.NaN;
    const A = atrAt[i];
    tally(checks.widths, N > 0 && A > 0, () => `${tag} N ${N} A ${A}`);
    if (!(N > 0 && A > 0)) {
      noN++;
      return null;
    }
    // (n2) that bar closed by T, and the next not
    if (signal || i % CHECK_EVERY === 0) {
      const closed = dTimes[k] + DAY <= T && (k + 1 >= days.length || dTimes[k + 1] + DAY > T);
      tally(checks.nClosed, closed, () => `${tag} N from the day of ${iso(dTimes[k])} (closes ${iso(dTimes[k] + DAY)})`);
      // (n3) N again, on the daily bars cut at it
      const cut = pineAtr(days.slice(0, k + 1), 20).at(-1) ?? null;
      tally(checks.nCut, cut !== null && cut === N, () => `${tag} N ${N} / on the bars cut ${cut}`);
    }
    const got = new Map<string, Trade>([[NOW_RULE, now]]);
    for (const r of RULES) {
      if (r.key === NOW_RULE) continue;
      const t = tradeAt(i, side, r, A, N, drift);
      if (!t) return null;
      got.set(r.key, t);
    }
    // N's daily bar's age at T
    const age = (T - (dTimes[k] + DAY)) / HOUR;
    if (age > staleMax) staleMax = age;
    if (age > 72 && !staleSeen.has(k)) {
      staleSeen.add(k);
      stale.push(`${iso(dTimes[k])} at ${iso(T)} (${age.toFixed(0)} h)`);
    }
    // (s) each stop's price: the mid close less k·N or k·A (a sell's plus),
    // within half a tick of it (the rounding); the stop 30's the email's;
    // out at the stop within a bar: at that price; at an open: past it
    {
      const dir = side === "BUY" ? 1 : -1;
      const close = candles[i].close;
      const tick = 10 ** -digits;
      for (const r of RULES) {
        const t = got.get(r.key)!;
        let ok = true;
        if (r.stop === "pips") ok = t.sl === close - dir * r.k * unit;
        else if (r.stop === "N" || r.stop === "A") {
          const raw = close - dir * r.k * (r.stop === "N" ? N : A);
          ok = t.sl !== null && Math.abs(t.sl - raw) <= tick / 2 + 1e-9 && Math.abs(Math.round(t.sl / tick) - t.sl / tick) < 1e-6;
        } else ok = t.sl === null;
        if (t.exit === "amb" || (t.exit === "sl" && !t.atOpen)) ok = ok && t.px === t.sl;
        if (t.exit === "sl" && t.atOpen) ok = ok && t.sl !== null && (dir > 0 ? t.px <= t.sl : t.px >= t.sl);
        tally(checks.placement, ok, () => `${tag} ${r.key} stop ${t.sl} (N ${N}, A ${A}, close ${close}) out ${t.exit} at ${t.px}${t.atOpen ? " (open)" : ""}`);
      }
    }
    if (signal) {
      let all = true;
      for (const r of EXTRAS) {
        const t = tradeAt(i, side, r, A, N, drift);
        if (t) got.set(r.key, t);
        else all = false;
      }
      tally(checks.extras, all, () => `${tag} a TP2 or TP3 not followed`);
    }
    // (c1) the stops in the order of this trade's widths: the wider never out
    // sooner; out at TP1 or the limit under the narrower, the same under the
    // wider; out at its stop under the wider, out at a stop (or both) under
    // the narrower. Two widths within 1e-9 pip: one width, not compared.
    const nest = NEST_L30.map((key) => got.get(key)!).sort((x, y) => (x.stop ?? Infinity) - (y.stop ?? Infinity));
    for (let q = 0; q + 1 < nest.length; q++) {
      const x = nest[q];
      const y = nest[q + 1];
      if ((y.stop ?? Infinity) - (x.stop ?? Infinity) <= 1e-9) continue;
      let ok = y.f5 >= x.f5;
      if (x.exit === "tp" || x.exit === "time") ok = ok && sameFull(x, y);
      if (y.exit === "sl" || y.exit === "amb") ok = ok && (x.exit === "sl" || x.exit === "amb");
      tally(checks.stopNest, ok, () => `${tag} stop ${x.stop} ${x.exit} ${x.pips} ${x.bars}/${x.f5} / stop ${y.stop} ${y.exit} ${y.pips} ${y.bars}/${y.f5}`);
    }
    // (c3) out within 30 bars: the same within 120; timed out at 30 bars: out later within 120
    for (const [k30, k120] of LIMIT_PAIRS) {
      const x = got.get(k30)!;
      const y = got.get(k120)!;
      const ok = x.exit === "time" ? y.bars > x.bars && y.f5 > x.f5 : sameFull(x, y);
      tally(checks.limitNest, ok, () => `${tag} ${k30} ${x.exit} ${x.pips} ${x.bars}/${x.f5} / ${k120} ${y.exit} ${y.pips} ${y.bars}/${y.f5}`);
    }

    const half: 0 | 1 = T < SPLIT_MS ? 0 : 1;
    const week = weekOf(T);
    for (const key of keys) {
      const full = [`${key}|${grp}`, `${key}|all`];
      if (grp === "CALL" || grp === "AB") full.push(`${key}|AB`);
      if (key === "either" || key === "coin") full.push(`${key}|pair ${pair}`);
      for (const kk of [...new Set(full)]) {
        const tails = !kk.startsWith("coin");
        for (const [rk, t] of got) {
          addTo(aggOf(kk, half, rk), week, t.pips, t, tails);
          if (t.stop !== null) addTo(aggOf(kk, half, R_ + rk), week, t.pips / t.stop);
          if (rk !== NOW_RULE && RULE_KEYS.has(rk)) addTo(aggOf(kk, half, rk + DIFF), week, t.pips - now.pips);
        }
        if (kk === "either|CALL" || kk === "either|all") {
          for (const s of SLIPS) for (const rk of CANDIDATES) addTo(aggOf(kk, half, slipKey(rk, s)), week, slipOf(got.get(rk)!, s) - slipOf(now, s));
        }
      }
    }
    if (either) for (const rk of [R2N.key, R2A.key]) widthsAt[rk].push(got.get(rk)!.stop!);
    if (either && grp === "CALL") {
      for (const [rk, t] of got) {
        if (!RULE_KEYS.has(rk)) continue;
        let p = paths.get(rk);
        if (!p) paths.set(rk, (p = []));
        p.push({ t: t.at + FINE, t0: T, pair, pips: t.pips, r: t.stop !== null ? t.pips / t.stop : null, half });
      }
      // the trade, for research/stop2n-check.py: it takes the pair, the bar,
      // the side and A only, and works the rest out again from GMO's files
      const cell = (t: Trade) => [t.sl ?? "", t.exit, t.at, t.px, t.pips].join(",");
      const dir = side === "BUY" ? 1 : -1;
      csvRows.push([pair, side, times[i], T, candles[i].close, side === "BUY" ? qs[i].ask.close : qs[i].bid.close, unit, digits, A, N, dTimes[k], candles[i].close + dir * TP1 * unit, cell(now), cell(got.get(R2N.key)!), cell(got.get(R2A.key)!)].join(","));
    }
    return got;
  };

  // the coin: every close either way
  for (let i = 0; i < n; i++) {
    for (const side of ["BUY", "SELL"] as const) recordAt(i, side, ["coin", `coin ${side}`], false, false);
  }
  // the signals: each rule's, and the emails' together (one trade a bar and side)
  let trades = 0;
  const eitherSeen = new Set<string>();
  const spreads: number[] = [];
  for (const sg of signals) {
    const keys = sg.rule === "qtrend" ? [`qtrend`, `qtrend ${sg.side}`, ...(sg.strong ? ["strong", `strong ${sg.side}`] : [])] : [`ultra`, `ultra ${sg.side}`];
    const ek = `${sg.i}:${sg.side}`;
    const first = !eitherSeen.has(ek);
    if (first) keys.push("either", `either ${sg.side}`);
    const got = recordAt(sg.i, sg.side, keys, true, first);
    if (!got || !first) continue;
    eitherSeen.add(ek);
    trades++;
    spreads.push((qs[sg.i].ask.close - qs[sg.i].bid.close) / unit);
  }
  const widths: Cover["widths"] = {};
  for (const [rk, xs] of Object.entries(widthsAt)) widths[rk] = { med: medianOf(xs), min: xs.length ? Math.min(...xs) : null, max: xs.length ? Math.max(...xs) : null };
  coverage.push({ pair, group: grp, bars: n, judged, signals: signals.length, trades, failed: fineGot.failed + got.failed + dayGot.failed, days: days.length, spread: medianOf(spreads), widths, dayWeekdays, dayOff21, noN, dayFirst: days.length ? dTimes[0] : null, daysBefore: lowerBound(dTimes, START_MS), staleMax, stale });
  console.log(`${pair} (${grp}) ${TF}: ${n} bars, judged ${judged}, signals ${signals.length} (trades ${trades}); daily bars ${days.length}; GMO failed ${fineGot.failed + got.failed + dayGot.failed}`);
}

// ---- the report ------------------------------------------------------------------------

const num = (x: number | null | undefined, d = 2) => (x === null || x === undefined || !Number.isFinite(x) ? "   -  " : `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(d)}`);
const pct = (a: number, b: number) => (b > 0 ? `${((100 * a) / b).toFixed(1)}%` : "-");
// the interval by week and by four weeks at `p` a side, and (K over 1) the
// Bonferroni one beside it: the lower low end and the higher high end
const ciText = (a: Agg | undefined, K = 1) => {
  const w = intervalOf(a, "weeks");
  const b = intervalOf(a, "blocks");
  const base = `[${num(w.lo)},${num(w.hi)}] (4 wk [${num(b.lo)},${num(b.hi)}])`;
  if (K <= 1) return base;
  const pb = 1 - 0.025 / K;
  return `${base} Bonferroni [${num(lowEnd(a, pb))},${num(highEnd(a, pb))}]`;
};
const checkLine = (what: string, c: Check) => `${what}: ${c.mismatched} of ${c.compared} differ${c.examples.length ? ": " + c.examples.join("; ") : ""}`;
const days = (ms: number | null) => (ms === null ? "-" : (ms / DAY).toFixed(2));
const periodAgg = (key: string, period: 0 | 1 | "full", series: string) => (period === "full" ? aggFull(key, series) : aggAt(key, period, series));
const quantile = (xs: number[], q: number): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))];
};

console.log(`\n#187 the stop at 2N on ${TF}, ${START} .. ${iso(NOW)} (first half before ${SPLIT}; weekend bars out by ${WEEKEND})${SYNTHETIC ? ` — SYNTHETIC (${SYNTH}${DRIFTING ? `, ${DRIFT_SIGN * DRIFT} pip a 5-minute bar the signal's way` : ""}${LOOKAHEAD ? ", LOOKAHEAD" : ""}), seed ${SEED}` : ""}; TP1 ${TP1} pips; now ${NOW_RULE}; the call on ${CANDIDATES.join(" and ")} against now, the email's signals (either) on CALL (${CALL.join(", ")})`);
console.log(checkLine("(a) signals against indicatorSignals", checks.signals));
console.log(checkLine("(a2) the email's close, stop and targets against the stop 30 and TP 20/40/60", checks.levels));
console.log(checkLine("(a3) Q-Trend's ε against ATR(14) of the bar before", checks.eps));
console.log(checkLine("(a4) the bar's ATR(14) against it computed again from the email's start", checks.atrSeries));
console.log(checkLine("(n1) N against a loop of its own, every daily bar", checks.nAgain));
console.log(checkLine("(n2) N's daily bar closed by the signal's close, and the newest so", checks.nClosed));
console.log(checkLine("(n3) N again on the daily bars cut at its bar", checks.nCut));
console.log(checkLine("(s) each stop at the mid close less k·N or k·A within half a tick (the stop 30 the email's), and out at it", checks.placement));
console.log(checkLine("(c1) the stops by each trade's widths: the wider never out sooner, the same when out at TP1 or the limit", checks.stopNest));
console.log(checkLine("(c3) out within 30 bars the same within 120, timed out at 30 out later", checks.limitNest));
console.log(checkLine("(d) exit closes against the 4-hour bar's own", checks.closes));
console.log(checkLine("(e) trades with N and A over 0", checks.widths));
console.log(checkLine("(e) signals with their TP2 and TP3", checks.extras));
const failedReads = coverage.reduce((a, c) => a + c.failed, 0);
console.log(`(g) GMO reads that failed (4 hours, 5 minutes, days; bid and ask): ${failedReads}`);
const staleAll = coverage.flatMap((c) => c.stale.map((x) => `${c.pair} ${x}`));
console.log(`(t) N's daily bar's age at T: the most ${Math.max(0, ...coverage.map((c) => c.staleMax)).toFixed(1)} hours; over 72 hours ${staleAll.length}${staleAll.length ? ` (to be explained before the results): ${staleAll.slice(0, 40).join("; ")}${staleAll.length > 40 ? ` … ${staleAll.length - 40} more` : ""}` : ""}`);
const allDiffer = Object.values(checks).reduce((a, c) => a + c.mismatched, 0) + failedReads;
console.log(allDiffer === 0 ? "EVERY CHECK 0 DIFFER" : `CHECKS DIFFER (${allDiffer}): the numbers below are not to be read`);

await Deno.mkdir(OUT, { recursive: true });
const tag = SYNTHETIC ? `-${SYNTH}-${SEED}${LOOKAHEAD ? "-lookahead" : ""}` : REPRO ? "-repro" : "";

// §8.83's numbers again: now's, A+B, the halves; nothing else told
if (REPRO) {
  const rows = [0, 1].map((p) => {
    const a = aggAt("either|AB", p as 0 | 1, NOW_RULE);
    return { n: a?.n ?? 0, m: a && a.n ? a.sum / a.n : null };
  });
  const forThis = iso(NOW) === iso(Date.parse(REPRO_END));
  const same = rows.every((r, p) => r.m !== null && r.n === REPRO_ROWS[p][1] && Number(r.m.toFixed(2)) === REPRO_ROWS[p][0]);
  console.log(`\n== §8.83 AGAIN (WEEKEND=stamp): A+B, the emails' signals (either), ${NOW_RULE}: first half ${num(rows[0].m)} of ${rows[0].n}, second half ${num(rows[1].m)} of ${rows[1].n}; §8.83's ${REPRO_ROWS.map(([m, n]) => `${num(m)} of ${n}`).join(", ")}: ${forThis ? (same ? "THE SAME" : "NOT THE SAME") : `not for this run (END is not ${REPRO_END})`}`);
  await Deno.writeTextFile(`${OUT}/stop2n${tag}.json`, JSON.stringify({ start: START, split: SPLIT, now: iso(NOW), weekend: WEEKEND, checks, failedReads, allDiffer, repro: { rows, want: REPRO_ROWS, forThis, same } }));
  if (allDiffer !== 0 || !forThis || !same) Deno.exit(1);
  Deno.exit(0);
}

// the fall counted at the exits: the trades in the order of their exits, one
// unit each; those out at one time added at once; the run of losses within
// one time by the entry, then the pair; the weeks by the exit
const fallOf = (rk: string, half: 0 | 1 | "full", by: "pips" | "r") => {
  const xs = (paths.get(rk) ?? [])
    .filter((x) => (half === "full" || x.half === half) && (by === "pips" || x.r !== null))
    .sort((a, b) => a.t - b.t || a.t0 - b.t0 || (a.pair < b.pair ? -1 : a.pair > b.pair ? 1 : 0));
  let cum = 0;
  let peak = 0;
  let peakT = xs[0]?.t ?? 0;
  let dd = 0;
  let from = 0;
  let to = 0;
  let run = 0;
  let longest = 0;
  const weeks = new Map<number, number>();
  for (let q = 0; q < xs.length;) {
    let e = q;
    while (e < xs.length && xs[e].t === xs[q].t) {
      const v = by === "pips" ? xs[e].pips : xs[e].r!;
      cum += v;
      run = v > 0 ? 0 : run + 1;
      longest = Math.max(longest, run);
      const w = weekOf(xs[e].t);
      weeks.set(w, (weeks.get(w) ?? 0) + v);
      e++;
    }
    const t = xs[q].t;
    if (cum > peak) {
      peak = cum;
      peakT = t;
    }
    if (cum - peak < dd) {
      dd = cum - peak;
      from = peakT;
      to = t;
    }
    q = e;
  }
  let worstWeek = 0;
  let worstWeekAt = 0;
  for (const [w, v] of weeks) if (v < worstWeek) {
    worstWeek = v;
    worstWeekAt = w;
  }
  return { n: xs.length, total: cum, dd, from, to, longest, worstWeek, worstWeekStart: worstWeekAt * WEEK + WEEK_OFFSET };
};

// THE CALL
const KEY = "either|CALL";
const Z80 = 0.8416212335729143;
const calls: Record<string, { m: [number | null, number | null]; full: number | null; lo: number | null; hi: number | null; better: boolean; worse: boolean; own: number | null; ownLo: number | null; positive: boolean; n: number; mde: number | null }> = {};
if (groups.has(KEY)) {
  console.log(`\n== THE CALL: CALL, the emails' signals (either), "rule less now" a trade; Bonferroni over ${CANDIDATES.length} (t at ${P_CALL} a side, by week and by four weeks each with its own t(C − 1); the lower low end, the higher high end)`);
  for (const key of CANDIDATES) {
    const d0 = aggAt(KEY, 0, key + DIFF);
    const d1 = aggAt(KEY, 1, key + DIFF);
    const dF = aggFull(KEY, key + DIFF);
    const m0 = d0 ? d0.sum / d0.n : null;
    const m1 = d1 ? d1.sum / d1.n : null;
    const lo = lowEnd(dF, P_CALL);
    const hi = highEnd(dF, P_CALL);
    const better = m0 !== null && m1 !== null && m0 > 0 && m1 > 0 && lo !== null && lo > 0;
    const worse = m0 !== null && m1 !== null && m0 < 0 && m1 < 0 && hi !== null && hi < 0;
    const own = aggFull(KEY, key);
    const ownLo = lowEnd(own, P_CALL);
    const positive = ownLo !== null && ownLo > 0;
    // the smallest difference it could find: (t + 0.84) × the standard
    // error, by week and by four weeks, the larger
    const mdes = (["weeks", "blocks"] as const).map((by) => {
      const st = statOf(dF, by);
      return st && st.C > 1 && Number.isFinite(st.se) ? (tQuantile(P_CALL, st.C - 1) + Z80) * st.se : Number.NaN;
    });
    const mde = mdes.every(Number.isFinite) ? Math.max(...mdes) : null;
    calls[key] = { m: [m0, m1], full: dF ? dF.sum / dF.n : null, lo, hi, better, worse, own: own ? own.sum / own.n : null, ownLo, positive, n: dF?.n ?? 0, mde };
    console.log(`  ${key}: less now, first half ${num(m0)} (${d0?.n ?? 0}), second half ${num(m1)} (${d1?.n ?? 0}); the whole period ${num(dF ? dF.sum / dF.n : null)} [${num(lo)},${num(hi)}] → ${better ? "CLEARLY BETTER" : worse ? "CLEARLY WORSE" : "undecided"}; the smallest difference it could find ${num(mde)} pips; the rule itself ${num(own ? own.sum / own.n : null)} a trade, low end ${num(ownLo)}${positive ? " (OVER 0)" : ""}`);
  }
}

// the owner's table: each rule's win rate (TP1 first of ALL its trades,
// beside the coin's at the same rule), its pips, the most against
const coinOf = (key: string) => `coin|${key.split("|").slice(1).join("|")}`;
const ownerLine = (key: string, period: 0 | 1 | "full", rk: string, K: number) => {
  const a = periodAgg(key, period, rk);
  if (!a || !a.n) return `  ${rk.padEnd(16)} no trades`;
  const d = rk === NOW_RULE ? undefined : periodAgg(key, period, rk + DIFF);
  const r = periodAgg(key, period, R_ + rk);
  const coin = key.startsWith("coin") ? undefined : periodAgg(coinOf(key), period, rk);
  const t = tailOf(a);
  const done = a.exits.tp + a.exits.sl + a.exits.amb;
  const tp23 = TP23.get(rk);
  const reach = (k: string | undefined) => {
    const x = k ? periodAgg(key, period, k) : undefined;
    return x ? pct(x.exits.tp, x.n) : null;
  };
  const wins = a.maeWin;
  return [
    `  ${rk.padEnd(16)} ${String(a.n).padStart(5)} trades. WIN RATE (TP1 first of all) ${pct(a.exits.tp, a.n)}${coin ? ` (the coin's ${pct(coin.exits.tp, coin.n)})` : ""}; pips over 0 ${pct(a.wins, a.n)}. ${num(a.sum / a.n)} pips a trade ${ciText(a, K)}${d ? `; less now ${num(d.sum / d.n)} ${ciText(d, K)}` : ""}`,
    `  ${"".padEnd(16)} TP1 first of those ended ${pct(a.exits.tp, done)} (time-outs left out: it rises with a wider stop with no edge at all); timed out ${pct(a.exits.time, a.n)} (those ${num(a.exits.time ? a.exitSum.time / a.exits.time : null, 1)} pips); TP1 first with no edge and nothing timed out (the mean of S/(S+20); not a break-even: the pips a trade answer that) ${pct(a.be, a.beN)}; out: tp ${pct(a.exits.tp, a.n)}, sl ${pct(a.exits.sl, a.n)}, both ${pct(a.exits.amb, a.n)}`,
    `  ${"".padEnd(16)} median ${num(medianOf(a.all), 1)}, avg win ${num(a.wins ? a.winSum / a.wins : null, 1)}, avg loss ${num(a.n - a.wins ? a.lossSum / (a.n - a.wins) : null, 1)}, worst ${num(t.worst, 1)}, worst 5% from ${num(t.p5, 1)}; the stop ${num(medianOf(a.stops), 1)} pips (median); held ${days(medianOf(a.held))} d (median), nights ${(a.nights / a.n).toFixed(2)} a trade${r ? `; R ${num(r.sum / r.n, 3)} ${ciText(r)}` : ""}${tp23 ? `; TP2 ${reach(tp23[0])}, TP3 ${reach(tp23[1])}` : ""}`,
    `  ${"".padEnd(16)} the most against: median ${num(medianOf(a.mae), 1)}, 95% ${num(quantile(a.mae, 0.95), 1)}, worst ${num(a.mae.length ? Math.max(...a.mae) : null, 1)} pips${a.maeR.length ? ` (R ${num(medianOf(a.maeR), 2)}, ${num(quantile(a.maeR, 0.95), 2)}, ${num(Math.max(...a.maeR), 2)})` : ""}; the wins at TP1 (${wins.length}): median ${num(medianOf(wins), 1)}, 95% ${num(quantile(wins, 0.95), 1)}, worst ${num(wins.length ? Math.max(...wins) : null, 1)}, 30 pips or more ${pct(wins.filter((x) => x >= 30).length, wins.length)}, 100 or more ${pct(wins.filter((x) => x >= 100).length, wins.length)}`,
  ].join("\n");
};
const OWNER_ROWS = RULES.map((r) => r.key);
for (const key of ["either|CALL", "either|AB", "either|C", "either|all", "coin|CALL"]) {
  if (!groups.has(key)) continue;
  // the intervals this table shows: each rule's own and its "less now", three periods
  const K = 3 * (OWNER_ROWS.length + OWNER_ROWS.length - 1);
  for (const period of ["full", 0, 1] as const) {
    console.log(`\n== THE TABLE: ${key}, ${period === "full" ? "the whole period" : period === 0 ? "first half" : "second half"} (95% intervals; told, ${K} looks in this table: Bonferroni over ${K} beside)${key === "either|AB" ? " — not §8.83's: the weekend rule (#182) and the period differ" : ""}`);
    for (const rk of OWNER_ROWS) console.log(ownerLine(key, period, rk, K));
  }
}

// the fall counted at the exits
const falls: Record<string, unknown> = {};
console.log(`\n== THE FALL COUNTED AT THE EXITS: CALL, the emails' signals (either), the trades in the order of their exits, one unit each. The loss carried while a trade is open is not in it, which is kind to a wide stop: read it with the most against above. Overlaps and pairs moving together not taken in either (#188)`);
for (const rk of OWNER_ROWS) {
  for (const half of ["full", 0, 1] as const) {
    const p = fallOf(rk, half, "pips");
    const r = rk.includes("Snone") ? null : fallOf(rk, half, "r");
    falls[`${rk}|${half}`] = { pips: p, r };
    console.log(`  ${rk.padEnd(16)} ${half === "full" ? "whole " : half === 0 ? "first " : "second"} ${p.n} trades: total ${num(p.total, 1)} pips, the largest fall ${num(p.dd, 1)} (${p.n ? `${iso(p.from)} to ${iso(p.to)}` : "-"}), longest run of losses ${p.longest}, worst week ${num(p.worstWeek, 1)} (from ${iso(p.worstWeekStart)})${r ? `; in R: total ${num(r.total, 2)}, the largest fall ${num(r.dd, 2)}, worst week ${num(r.worstWeek, 2)}` : ""}`);
  }
}

// told beside the call
const TOLD_CUTS = ["either BUY|CALL", "either SELL|CALL", "qtrend|CALL", "ultra|CALL", "strong|CALL", "either|AB", "either|C", "either|all", "coin|CALL", "coin|all"];
if (groups.has(KEY)) {
  const K = CANDIDATES.length * (SLIPS.length + TOLD_CUTS.length + CALL.length);
  console.log(`\n== TOLD, the whole period, "rule less now" (not called on; ${K} looks in this table: Bonferroni over ${K} beside each 95%; a cut that looks good is only a candidate, to be fixed beforehand and measured on the data from 2026-10-05)`);
  for (const key of CANDIDATES) {
    for (const s of SLIPS) {
      const d = aggFull(KEY, slipKey(key, s));
      console.log(`  ${key} the stop filled ${s} pip worse: ${num(d ? d.sum / d.n : null)} ${ciText(d, K)}`);
    }
    for (const k of TOLD_CUTS) {
      const d = aggFull(k, key + DIFF);
      const h = [0, 1].map((p) => aggAt(k, p as 0 | 1, key + DIFF));
      console.log(`  ${key} ${k.padEnd(16)} ${num(d ? d.sum / d.n : null)} ${ciText(d, K)} of ${d?.n ?? 0} (halves ${h.map((x) => num(x ? x.sum / x.n : null)).join(", ")})`);
    }
    const per = CALL.map((p) => ({ p, d: aggFull(`either|pair ${p}`, key + DIFF) })).filter((x) => x.d && x.d.n > 0) as Array<{ p: string; d: Agg }>;
    for (const x of per) console.log(`  ${key} ${x.p.padEnd(16)} ${num(x.d.sum / x.d.n)} ${ciText(x.d, K)} of ${x.d.n}`);
    if (per.length) console.log(`  ${key} the pairs weighted alike: ${num(per.reduce((a, x) => a + x.d.sum / x.d.n, 0) / per.length)} (${per.length} pairs)`);
    const nights = (k: string) => {
      const a = aggFull(KEY.replace("either", k), key);
      const b = aggFull(KEY.replace("either", k), NOW_RULE);
      return a && b ? `${(a.nights / a.n - b.nights / b.n).toFixed(2)}` : "-";
    };
    console.log(`  ${key} nights held, less now's (a trade): either ${nights("either")}, buys ${nights("either BUY")}, sells ${nights("either SELL")}`);
  }
}

// the walks' check of each stop: TP1 first of all the coin's trades within
// 120 bars against the mean of (S − h) / (S + 20) (on the walks within 2
// points; on the data told only)
const theory: Record<string, { first: number | null; want: number | null; n: number }> = {};
if (groups.has("coin|all")) {
  console.log(`\n== EACH STOP WHERE IT SHOULD BE (the coin, all pairs, within 120 bars): TP1 first of all its trades against the mean of (S − h)/(S + 20) (h: half the spread paid; the walks: within 2 points)`);
  for (const r of L120) {
    const a = aggFull("coin|all", r.key);
    const first = a && a.n ? a.exits.tp / a.n : null;
    const want = a && a.beN ? a.th / a.beN : null;
    theory[r.key] = { first, want, n: a?.n ?? 0 };
    const off = first !== null && want !== null ? 100 * (first - want) : null;
    console.log(`  ${r.key.padEnd(16)} ${pct(a?.exits.tp ?? 0, a?.n ?? 0)} against ${want === null ? "-" : `${(100 * want).toFixed(1)}%`} (${num(off, 1)} points; timed out ${pct(a?.exits.time ?? 0, a?.n ?? 0)}, of ${a?.n ?? 0})`);
  }
}

// win rates of 65% or more (TP1 first of all, or pips over 0), beside the
// coin's; and the look-ahead to check before reporting
const high: string[] = [];
let highElse = 0;
for (const [key, g] of groups) {
  if (key.startsWith("coin")) continue;
  const main = ["either|CALL", "either|AB", "either|C", "either|all"].includes(key);
  for (const period of ["full", 0, 1] as const) {
    for (const rk of OWNER_ROWS) {
      const a = period === "full" ? mergeAgg([g[0].get(rk), g[1].get(rk)]) : g[period].get(rk);
      if (!a || a.n === 0) continue;
      if (a.exits.tp / a.n >= 0.65 || a.wins / a.n >= 0.65) {
        if (!main) {
          highElse++;
          continue;
        }
        const c = periodAgg(coinOf(key), period, rk);
        high.push(`${key} ${period} ${rk}: TP1 first ${pct(a.exits.tp, a.n)} of all (the coin's ${c ? pct(c.exits.tp, c.n) : "-"}), pips over 0 ${pct(a.wins, a.n)} of ${a.n}${a.n < 100 ? " (fewer than 100)" : ""}; ${num(a.sum / a.n)} pips a trade`);
      }
    }
  }
}
console.log(`\n== win rates of 65% or more, the emails' signals (either) of CALL, A+B, C and all (${high.length}; and ${highElse} in the other cuts: each signal, buys, sells, each pair): a wide stop with TP1 20 clears it with no edge`);
for (const x of high) console.log(`  ${x}`);
const suspect: string[] = [];
for (const key of ["either|CALL", "either|AB", "either|C", "either|all"]) {
  if (!groups.has(key)) continue;
  for (const period of ["full", 0, 1] as const) {
    for (const rk of OWNER_ROWS) {
      const a = periodAgg(key, period, rk);
      const c = periodAgg(coinOf(key), period, rk);
      if (!a || !a.n || !c || !c.n) continue;
      const lead = 100 * (a.exits.tp / a.n - c.exits.tp / c.n);
      const m = a.sum / a.n;
      if (lead >= 3 || m > 2) suspect.push(`${key} ${period} ${rk}: TP1 first ${pct(a.exits.tp, a.n)} against the coin's ${pct(c.exits.tp, c.n)} (${num(lead, 1)} points), ${num(m)} pips a trade`);
    }
  }
}
for (const k of CANDIDATES) {
  if (calls[k]?.positive) suspect.push(`${k}: the rule itself over 0 (low end ${num(calls[k].ownLo)})`);
  if (calls[k]?.better) suspect.push(`${k}: clearly better`);
}
console.log(`\n== LOOK-AHEAD TO CHECK BEFORE REPORTING (${suspect.length}): a signal's TP1 first 3 points or more over the coin's at the same rule, over +2 pips a trade, "over 0" or "clearly better"`);
for (const x of suspect) console.log(`  ${x}`);

console.log(`\n== the pairs`);
for (const c of coverage) {
  console.log(`  ${c.pair.padEnd(8)} ${c.group}: ${c.trades} signal trades of ${c.signals} signals, ${c.judged} bars judged; spread paid ${num(c.spread, 1)} pips (median); daily bars ${c.days}, the first ${c.dayFirst === null ? "-" : iso(c.dayFirst)}, ${c.daysBefore} before START (by the weekday they open, Sun..Sat ${c.dayWeekdays.join("/")}; not opening at 21:00 UTC ${c.dayOff21}); N's daily bar at most ${c.staleMax.toFixed(1)} h old, over 72 h ${c.stale.length}; without N or A ${c.noN}; ${Object.entries(c.widths).map(([k, w]) => `${k} stop ${num(w.med, 1)} (${num(w.min, 1)} to ${num(w.max, 1)}) pips`).join("; ")}`);
}
const verdict = CANDIDATES.map((k) => `${k} ${calls[k]?.better ? "clearly better" : calls[k]?.worse ? "clearly worse" : "undecided"}`).join("; ");
console.log(`\nverdict: ${verdict}`);

// ---- the numbers out --------------------------------------------------------------------

const aggOut = (a: Agg | undefined) => {
  if (!a || !a.n) return null;
  const w = statOf(a, "weeks")!;
  const b = statOf(a, "blocks")!;
  return {
    n: a.n,
    m: w.m,
    se: Number.isFinite(w.se) ? w.se : null,
    se4: Number.isFinite(b.se) ? b.se : null,
    C: w.C,
    C4: b.C,
    wins: a.wins,
    exits: a.exits,
    exitSum: a.exitSum,
    be: a.be,
    th: a.th,
    beN: a.beN,
    nights: a.nights,
    stop: medianOf(a.stops),
    mae: a.mae.length ? { med: medianOf(a.mae), p95: quantile(a.mae, 0.95), worst: Math.max(...a.mae) } : null,
    maeWin: a.maeWin.length ? { n: a.maeWin.length, med: medianOf(a.maeWin), p95: quantile(a.maeWin, 0.95), worst: Math.max(...a.maeWin), over30: a.maeWin.filter((x) => x >= 30).length, over100: a.maeWin.filter((x) => x >= 100).length } : null,
    ...tailOf(a),
  };
};
const OUT_KEYS = ["either|CALL", "either|AB", "either|C", "either|all", "coin|CALL", "coin|all"];
await Deno.writeTextFile(
  `${OUT}/stop2n${tag}.json`,
  JSON.stringify({
    start: START,
    split: SPLIT,
    now: iso(NOW),
    weekend: WEEKEND,
    synthetic: SYNTHETIC,
    synth: SYNTH,
    seed: SEED,
    drift: DRIFTING ? DRIFT_SIGN * DRIFT : null,
    lookahead: LOOKAHEAD,
    nowRule: NOW_RULE,
    candidates: CANDIDATES,
    pCall: P_CALL,
    coverage,
    checks,
    failedReads,
    allDiffer,
    calls,
    verdict,
    theory,
    suspect,
    falls,
    // a group: [first half, second half, the whole period], each series's numbers
    groups: Object.fromEntries(OUT_KEYS.filter((k) => groups.has(k)).map((k) => {
      const series = new Set([...groups.get(k)![0].keys(), ...groups.get(k)![1].keys()]);
      return [k, [0, 1, "full"].map((p) => Object.fromEntries([...series].map((s) => [s, aggOut(periodAgg(k, p as 0 | 1 | "full", s))])))];
    })),
  }),
);
// the call's trades, for research/stop2n-check.py
const cols = (p: string) => ["sl", "exit", "at", "px", "pips"].map((c) => `${p}_${c}`);
await Deno.writeTextFile(`${OUT}/stop2n-trades${tag}.csv`, ["pair", "side", "bar", "t", "close", "fill", "unit", "digits", "A", "N", "day", "tp", ...cols("now"), ...cols("n2"), ...cols("a2")].join(",") + "\n" + csvRows.join("\n") + "\n");
