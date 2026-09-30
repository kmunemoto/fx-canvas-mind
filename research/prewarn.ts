// #171-5: an email before a 4-hour bar closes. The owner (2026-09-30), on an
// email that came four minutes after its close: 「4分後じゃ遅いじゃないです
// か？一瞬で届く様にはならない？」, then, shown three ways (read a minute after
// the close, read right after it, and a warning some minutes before it):
// 「試してみて、1〜3すべてやるのもあり？」. The first two are done (#171,
// docs §8.81). The third: some minutes before the close, 「このままだとサイン
// が出ます」 — the bar, closed at the price then, would give the signal. Told
// to the owner: a warning comes before the close, but it is wrong when the
// price goes back before the close. What is measured here, before anything
// is built: how often a warning turns into the signal, how many signals get
// one, how much earlier it comes, and what a trade entered on it would have
// made. The owner decides from the numbers (how many minutes before, which
// indicator, what to send when a warning does not come true).
//
// THE MEASURE, fixed before any warning was looked at on the data (the data
// is §8.83's, whose signals and trades at the close have been seen; no
// warning's):
//   * the data: GMO's pairs, 4-hour bars and 5-minute bid/ask, START
//     2024-01-01 to END 2026-09-29 14:16:25 UTC (§8.83's, so its numbers come
//     out again: check h), the halves split at 2025-05-19 (told, for how
//     steady each number is). One run on the data.
//   * the 4-hour charts only: the owner's emails are 4-hour Q-Trend and
//     ULTRA (signal_alert_subscriptions, 2026-09-30: those two, 4h, 37
//     pairs, one user).
//   * the pairs: A+B (the yen majors and the dollar pairs, eleven, as §8.83)
//     first; C (TRY/JPY, ZAR/JPY, MXN/JPY) told apart; all. The pairs GMO
//     added in #153 have no 4-hour history, and Twelve Data's pairs no
//     5-minute: not measured.
//   * the bars: those the email judges (the sweep's 600-bar window, its
//     anchored start) whose close the sweep reads while the market is open
//     (#171's reads 0, 4 and 6 minutes after it), closed between START and
//     END.
//   * a check at t, before the bar's close T: the bar as it stood at t —
//     its open the chart's; its close the mid of the 5-minute bar ending at
//     t (its bid and ask closes averaged, rounded as the chart rounds);
//     its high and low the 5-minute mids' extremes so far (neither
//     indicator reads the forming bar's high or low: Q-Trend's ε is the
//     bar before's ATR). Judged with the email's own rules on the closed
//     bars before it and this bar, from the email's start: the signal the
//     email would send were the bar to close at t's price. No check where
//     the 5-minute bar ending at t is not in GMO's data (the market shut or
//     no price).
//   * the leads X: 5, 10, 15, 30, 60 and 120 minutes before the close.
//   * two ways to warn, each told for each X:
//       - "once": one check at T − X; a warning for each indicator and side
//         it gives.
//       - "watch": a check every 5 minutes from T − X to T − 5 (the data's
//         step; a sweep would look every minute); a warning for an
//         indicator and side at the first check that gives it. For X = 5
//         the two are one.
//     Each indicator's warnings apart, and "either": the two together, one
//     warning a bar and side (as §8.83's "either": one trade a bar and
//     side).
//   * for each: the warnings, and of them those whose indicator gave the
//     same signal at the close (hits), and those it gave the other way (by
//     the email's rules this is 0 for each indicator alone: Q-Trend's side
//     before the bar and ULTRA's RSI before it are fixed for the bar, and
//     each side needs its own; under "either" it counts the two indicators
//     disagreeing; so a miss is a bar with no signal at the close); the
//     share that hit ("当たり"), by week and by four weeks with intervals as
//     §8.83's (t(C − 1), clusters by week or four weeks); the signals at the
//     close on the bars checked, and the share warned ("拾えた"), with the
//     same intervals; warnings a week (the group's pairs together, over the
//     weeks — from Sunday 21:00 UTC — with a bar judged and mailed); how
//     long before the close (watch: the hits' median).
//   * the price: on a hit, the entry at the warning (the ask for a buy, the
//     bid for a sell, at the 5-minute bar ending at t) against the email's
//     (at the close): the pips gained by entering at the warning (mean,
//     interval and median). A hit is
//     a warning the price then went on to make a signal of, so on the hits
//     alone the warning's entry is ahead by construction (a walk shows it:
//     +0.1 to +4.8 pips, the leads 5 to 120 minutes, on a first try of this
//     program on a walk, USD/JPY and EUR/USD); the misses carry the other
//     side. What acting on the warnings makes is every warning's trade,
//     hits and misses, against the email's.
//   * the trade: one entered at the warning at that price, with the email's
//     exit (#173: TP1 20 pips and the stop 30, from the mid at t; out at
//     whichever a 5-minute bar reaches first; both in one bar, the stop; a
//     bar opening past one, at that open; by the close of the 30th 4-hour
//     bar after the signal's bar, at that close), as §8.83's. Pips a trade:
//     on every warning, on the hits, on the misses; the email's own trade
//     (entered at the close) on the signals; on the hits, the warning's
//     trade less the email's on the same signal; pips a week of every
//     warning's trades and of the email's (the group's pairs together, the
//     weeks as above).
//   * printed: A+B, C and all for the whole period; the halves for A+B
//     (C's and all's are in the JSON); each pair's bars judged, signals,
//     checks at the leads and the leads with no price.
//   * nothing here is a call: no rule is picked or judged better. The
//     numbers are shown to the owner, who decides.
//   * checks, every one 0 differ on the walks and on the data before any
//     number is read:
//       (a) the signals at the close against indicatorSignals, on every
//           13th bar and every bar with a signal;
//       (p0) the 5-minute bar ending at the close: its mid close, rounded,
//            against the 4-hour bar's close;
//       (p1) a check's signals (worked from the bar before's state: the
//            line, its last side, ε, RSI's averages, the 200-close range)
//            against indicatorSignals on the bars with the forming bar
//            last (which never sees the bar's own close or anything after
//            t), at every check of every 13th bar and at every check that
//            gives a signal;
//       (p2) the same worked at the close's price against the signals at
//            the close, on every bar;
//       (p3) at every check, the price, the bid and the ask again from
//            the 5-minute bars cut at t (only those opening before it, the
//            last ending at t), against those used, and each warning's
//            fill against them; the trades followed from the first
//            5-minute bar opening at or after the entry (a program reading
//            the 5-minute bar after t for the price, or for the fill, fails
//            it: tried on a walk, 195,623 and 22,540 of about 222,000
//            differ);
//       (d) the trades' time-out closes against the 4-hour bar's own;
//       (g) no GMO read failed;
//       (h) §8.83's T20 again: the email's trades (A+B, either, those with
//           120 bars in the data), each half's trades and pips a trade to
//           two places (−1.35 of 2,416 and −1.27 of 2,216); on the run
//           fixed above only (START, SPLIT, END and every pair).
//
// ON RANDOM WALKS (SYNTHETIC=1, "path": 100 small steps a 5-minute bar, no
// rule gains), seeds 7 .. 16, the 21 pairs, before any data is read
// (research/prewarn-seeds.py, which takes these ten runs only): every check
// 0 differ ((d) and (h) have nothing to compare on a walk: its trades end
// at a level within 30 bars); the share of hits and the share of signals
// warned, the seeds and all the pairs together, higher at 5 minutes than at
// 30 and at 30 than at 120 (either, once); for each design and lead, every
// warning's trade less the email's (either, all the pairs, the seeds
// together) within ±0.3 pips a trade and within three standard errors (the
// ten seeds' own differences' spread): on a walk neither entry gains. Else
// the program is looked into before the data. (First fixed as ±0.3 alone,
// said to be about three standard errors; the review before the data found
// it 2.3 to 8.3 by row, so the three standard errors were added.)
//
// THE WALKS' RESULTS (the program as of 5b3144e, ten runs, research/
// prewarn-seeds.py): every check 0 differ (the signals 165,209 compared, at
// the close's price 933,030, the forming bar 3,393,396, the price and the
// fill cut at t 23,408,489, where following starts 750,926; the time-out
// closes none). Either, all the pairs, the seeds together:
//   * once, 5 / 30 / 120 minutes: hit 93.1% / 84.1% / 70.5%, warned 91.9% /
//     77.8% / 47.0%: higher nearer the close.
//   * every warning's trade less the email's (the email's −0.61 pips a
//     trade): +0.03 to +0.13 by design and lead, 0.8 to 2.1 standard errors
//     each; within ±0.3 and three standard errors on every row. Every row
//     above 0: the rows share their bars, so they move together; whether
//     the walk gives the warnings a small edge is not looked into further.
//   * the same on A+B (told): +0.03 to +0.14, 0.6 to 1.3 standard errors.
// A first ten runs (the program before the review's fixes) gave the same
// numbers, with fewer checks.
//
// NOT MEASURED: the other timeframes; the pairs above; the time a warning
// email takes to arrive, and to be acted on; swap; slippage; a sweep's
// minute steps (the data's are 5 minutes); on the walks, the time-out
// closes (check d: none there; a reviewer's walk made to time out gave
// 8,639, 0 differ, as the reviewer reported; not run again here).

import { GMO_INTERVALS, GMO_SYMBOLS, dateKeys, jstDayKey, jstYearKey, klineUrl, mergeSides, parseKlines, type QuoteCandle } from "../supabase/functions/track-outcomes/quotes.ts";
import { isMarketClosed, isPossiblyClosed } from "../supabase/functions/_shared/market-hours.ts";
import type { Candle } from "../supabase/functions/analyze/indicators.ts";
import { barOpenMs } from "../supabase/functions/analyze/state.ts";
import { CHART_BARS, LIVE_STEP_MS, historyRead } from "../supabase/functions/live-chart/logic.ts";
import { QT_DEFAULTS, anchoredStart, barStepMs, qTrend } from "../supabase/functions/_shared/qtrend.ts";
import { ULTRA_DEFAULTS, ULTRA_PAIRS, pineRsi, ultra } from "../supabase/functions/_shared/ultra.ts";
import { pineAtr, pineRma } from "../supabase/functions/_shared/pine.ts";
import { INDICATOR_PAIRS, indicatorIntervalsFor, indicatorSignals, ultraUnit } from "../supabase/functions/signal-alerts/indicators.ts";
import { DAY, HOUR, MINUTE, WEEK, WEEK_OFFSET, aggregate, iso } from "./lib.ts";

const ALL_PAIRS = INDICATOR_PAIRS.filter((p) => indicatorIntervalsFor(p).includes("5min"));
const PAIRS = (Deno.env.get("PAIRS") || ALL_PAIRS.join(",")).split(",").map((s) => s.trim()).filter(Boolean);
const START = Deno.env.get("START") || "2024-01-01";
const SPLIT = Deno.env.get("SPLIT") || "2025-05-19";
// §8.83's end (the #165 run's)
const END = Deno.env.get("END") || "2026-09-29T14:16:25Z";
const START_MS = Date.parse(`${START}T00:00:00Z`);
const SPLIT_MS = Date.parse(`${SPLIT}T00:00:00Z`);
const END_ISO = END.includes("T") ? END : END.replace(" ", "T");
const NOW = Date.parse(/[zZ]$|[+-]\d\d:\d\d$/.test(END_ISO) ? END_ISO : `${END_ISO}Z`);
if (!Number.isFinite(NOW)) throw new Error(`END ${END} is not a time`);
const SYNTHETIC = Boolean(Deno.env.get("SYNTHETIC"));
const SEED = Number(Deno.env.get("SEED") || 7);
// the walks' 5-minute bars: "path" (100 small steps, the high and low the
// path's own) or "wicks" (#162's)
const SYNTH = Deno.env.get("SYNTH") === "wicks" ? "wicks" : "path";
const CACHE = "research/.cache";
const OUT = Deno.env.get("OUTDIR") || "research/out";
const FINE = 5 * MINUTE;
// the sweep's window (signal-alerts HISTORY_BARS, anchoredStart's)
const WINDOW = 600;
const TF = "4h";
const STEP = LIVE_STEP_MS[TF];
// #171: the sweep reads a 4-hour chart 0, 4 and 6 minutes after its close
const READ_AFTER = [0, 4, 6];
const mailed = (closeMs: number): boolean => READ_AFTER.some((m) => !isPossiblyClosed(closeMs + m * MINUTE));
const CHECK_EVERY = 13;

const AB = ["USD/JPY", "EUR/JPY", "GBP/JPY", "AUD/JPY", "NZD/JPY", "CAD/JPY", "CHF/JPY", "EUR/USD", "GBP/USD", "AUD/USD", "NZD/USD"];
const C_PAIRS = ["TRY/JPY", "ZAR/JPY", "MXN/JPY", "HUF/JPY", "SEK/JPY"];
for (const p of [...AB, ...C_PAIRS]) if (!GMO_SYMBOLS[p] || !ALL_PAIRS.includes(p)) throw new Error(`${p} is not one of GMO's pairs here`);
const groupOf = (pair: string) => (AB.includes(pair) ? "AB" : C_PAIRS.includes(pair) ? "C" : "D");

// the email's exit (#166, #173)
if (ULTRA_PAIRS.sl !== 30 || ULTRA_PAIRS.tp1 !== 20) throw new Error("ULTRA_PAIRS is not TP1 20, stop 30: the email's exit has moved");
const TP = ULTRA_PAIRS.tp1;
const SL = ULTRA_PAIRS.sl;
const LIMIT = 30;
// §8.83's trades: those with 120 bars in the data (check h)
const REPRO_NEED = 120;
// the RSI's settings the email judges ULTRA on (ultra.ts's defaults)
const RSI_N = ULTRA_DEFAULTS.rsiLength;
const OVERSOLD = ULTRA_DEFAULTS.oversold;
const OVERBOUGHT = ULTRA_DEFAULTS.overbought;

const LEADS = [5, 10, 15, 30, 60, 120];
const MAX_STEPS = Math.max(...LEADS) / 5;
const DESIGNS = ["once", "watch"] as const;
type Design = (typeof DESIGNS)[number];
const RULES = ["qtrend", "ultra"] as const;
type Rule = (typeof RULES)[number];
type Side = "BUY" | "SELL";
const SHOWN = ["either", "qtrend", "ultra"] as const;

// ---- Student's t, for the intervals (as research/widetp.ts) ------------------------------

const LANCZOS = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
const lgamma = (x: number): number => {
  if (x < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - lgamma(1 - x);
  const z = x - 1;
  let a = LANCZOS[0];
  const t = z + 7.5;
  for (let i = 1; i < 9; i++) a += LANCZOS[i] / (z + i);
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
};
const betacf = (a: number, b: number, x: number): number => {
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < 1e-300) d = 1e-300;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < 1e-300) d = 1e-300;
    c = 1 + aa / c;
    if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < 1e-300) d = 1e-300;
    c = 1 + aa / c;
    if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 3e-14) break;
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
  const x = df / (df + t * t);
  return t >= 0 ? 1 - 0.5 * ibeta(df / 2, 0.5, x) : 0.5 * ibeta(df / 2, 0.5, x);
};
const tqCache = new Map<string, number>();
const tQuantile = (p: number, df: number): number => {
  const key = `${p}|${df}`;
  const hit = tqCache.get(key);
  if (hit !== undefined) return hit;
  let lo = 0;
  let hi = 1000;
  for (let k = 0; k < 200; k++) {
    const mid = (lo + hi) / 2;
    if (tCdf(mid, df) < p) lo = mid;
    else hi = mid;
  }
  const q = (lo + hi) / 2;
  tqCache.set(key, q);
  return q;
};
for (const [p, df, want] of [[0.975, 1, 12.706], [0.975, 2, 4.303], [0.975, 10, 2.228], [0.975, 17, 2.110], [0.975, 1e6, 1.960]]) {
  const got = tQuantile(p, df);
  if (Math.abs(got - want) > 0.0015) throw new Error(`t(${p}, ${df}) = ${got}, not ${want}`);
}

// ---- GMO's files (as research/widetp.ts) -----------------------------------------------

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
  failed: number;
}

// a seeded random walk on 5 minutes (as research/widetp.ts)
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
    if (SYNTH === "path") {
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

const load = async (pair: string, tf: "5min" | "4h", fromMs: number): Promise<Loaded> => {
  const step = LIVE_STEP_MS[tf];
  if (SYNTHETIC) {
    let fine = syntheticCache.get(pair);
    if (!fine) {
      fine = synthetic5(pair, Date.UTC(new Date(START_MS).getUTCFullYear() - 1, 0, 1));
      syntheticCache.set(pair, fine);
    }
    const quotes = tf === "5min"
      ? fine
      : aggregate(fine, step, 21 * HOUR, NOW)
        .filter((q) => !isMarketClosed(barOpenMs(q.datetime)))
        .map((q) => {
          const dt = new Date(barOpenMs(q.datetime)).toISOString();
          return { datetime: dt, bid: { ...q.bid, datetime: dt }, ask: { ...q.ask, datetime: dt } };
        });
    return { quotes: quotes.filter((q) => barOpenMs(q.datetime) >= fromMs), failed: 0 };
  }
  const symbol = GMO_SYMBOLS[pair];
  const spec = GMO_INTERVALS[tf];
  if (!symbol || !spec) throw new Error(`no GMO file for ${pair} ${tf}`);
  // as research/widetp.ts: the 5-minute bars in day files (the last three
  // read again), the 4-hour in year files (read again)
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
          body = r.status === 404 ? { status: 404, data: [] } : r.body;
          if (r.status === 0 || !sound(body)) {
            failed++;
            continue;
          }
          await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
          await Deno.writeTextFile(path, JSON.stringify(body));
        }
        (side === "bid" ? bid : ask).push(...parseKlines(body));
      }
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  bid.sort((a, b) => a.t - b.t);
  ask.sort((a, b) => a.t - b.t);
  const quotes = mergeSides(bid, ask).filter((q) => {
    const t = Date.parse(q.datetime);
    return Number.isFinite(t) && t >= fromMs && !isMarketClosed(t) && t + step <= NOW;
  });
  return { quotes, failed };
};

// ---- the 5-minute bars (as research/widetp.ts) ---------------------------------------

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
// the chart's rounding (live-chart logic.ts decimalsOf and round)
const decimalsOf = (pair: string) => (pair.toUpperCase().includes("JPY") ? 3 : 5);
const roundTo = (v: number, d: number): number => Number(v.toFixed(d));

// ---- the numbers kept ------------------------------------------------------------------

interface Agg {
  n: number;
  sum: number;
  xs: number[];
  weeks: Map<number, { n: number; s: number }>;
  blocks: Map<number, { n: number; s: number }>;
}
const newAgg = (): Agg => ({ n: 0, sum: 0, xs: [], weeks: new Map(), blocks: new Map() });
const addTo = (a: Agg, week: number, v: number) => {
  a.n++;
  a.sum += v;
  a.xs.push(v);
  for (const [m, k] of [[a.weeks, week], [a.blocks, Math.floor(week / 4)]] as const) {
    const w = m.get(k) ?? { n: 0, s: 0 };
    w.n++;
    w.s += v;
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
    a.xs = a.xs.concat(y.xs);
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
const statOf = (a: Agg | undefined, by: By = "weeks") => {
  if (!a || a.n === 0) return null;
  const m = a.sum / a.n;
  const C = a[by].size;
  let s = 0;
  for (const g of a[by].values()) s += (g.s - m * g.n) ** 2;
  const se = C > 1 ? Math.sqrt((C / (C - 1)) * s) / a.n : Number.NaN;
  return { m, se, C };
};
const intervalOf = (a: Agg | undefined, by: By = "weeks", p = 0.975) => {
  const st = statOf(a, by);
  if (!st) return { m: null as number | null, lo: null as number | null, hi: null as number | null };
  const q = st.C > 1 ? tQuantile(p, st.C - 1) : Number.NaN;
  const w = q * st.se;
  return Number.isFinite(w) ? { m: st.m, lo: st.m - w, hi: st.m + w } : { m: st.m, lo: null, hi: null };
};
const medianOf = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((x, y) => x - y);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

// group ("AB", "C", "all") → half (0, 1) → series → the numbers
const store = new Map<string, Agg>();
const aggOf = (group: string, half: 0 | 1, series: string): Agg => {
  const k = `${group}|${half}|${series}`;
  let a = store.get(k);
  if (!a) {
    a = newAgg();
    store.set(k, a);
  }
  return a;
};
const aggAt = (group: string, half: 0 | 1 | "full", series: string): Agg | undefined =>
  half === "full" ? mergeAgg([store.get(`${group}|0|${series}`), store.get(`${group}|1|${series}`)]) : store.get(`${group}|${half}|${series}`);
// the weeks with a bar judged, a group and half (warnings a week)
const weeksSeen = new Map<string, Set<number>>();
const seeWeek = (group: string, half: 0 | 1, week: number) => {
  const k = `${group}|${half}`;
  const s = weeksSeen.get(k) ?? new Set<number>();
  s.add(week);
  weeksSeen.set(k, s);
};
const weeksOf = (group: string, half: 0 | 1 | "full"): number => {
  if (half === "full") return new Set([...(weeksSeen.get(`${group}|0`) ?? []), ...(weeksSeen.get(`${group}|1`) ?? [])]).size;
  return weeksSeen.get(`${group}|${half}`)?.size ?? 0;
};

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
  closeMid: newCheck(), // (p0)
  partial: newCheck(), // (p1)
  atClose: newCheck(), // (p2)
  noAhead: newCheck(), // (p3): the price and the fill
  follow: newCheck(), // (p3): where following starts
  closes: newCheck(), // (d)
};
let failedReads = 0;
const weekOf = (t: number) => Math.floor((t - WEEK_OFFSET) / WEEK);
interface Seen {
  c: number;
  bid: number;
  ask: number;
}
interface Cover {
  pair: string;
  group: string;
  judged: number;
  signals: number;
  checks: number;
  noPrice: number;
}
const coverage: Cover[] = [];

// ---- the pairs -------------------------------------------------------------------------

for (const pair of PAIRS) {
  const unit = ultraUnit(pair);
  const grp = groupOf(pair);
  const groups = [grp, "all"];
  const dec = decimalsOf(pair);
  const fineGot = await load(pair, "5min", START_MS - 5 * DAY);
  const fine = toFine(fineGot.quotes);
  const got = await load(pair, TF, Date.UTC(new Date(START_MS).getUTCFullYear() - 1, 0, 1) - 9 * HOUR);
  failedReads += fineGot.failed + got.failed;
  const candles = historyRead(pair, TF, got.quotes, NOW).candles;
  const byOpen = new Map(got.quotes.map((q) => [barOpenMs(q.datetime), q]));
  const n = candles.length;
  const times = new Float64Array(n);
  candles.forEach((c, i) => (times[i] = barOpenMs(c.datetime)));
  const qs = Array.from(times, (t) => byOpen.get(t)!);
  if (qs.some((q) => !q)) throw new Error(`${pair}: a chart bar without its quote`);
  const closes = candles.map((c) => c.close);

  // the sweep's window and start (as research/widetp.ts)
  const anchorOf = (i: number): { ws: number; s: number } | null => {
    if (i < WINDOW - 1) return null;
    const ws = i - WINDOW + 1;
    const w = times.subarray(ws, i + 1) as unknown as number[];
    const last = i - ws;
    const firstShown = Math.max(0, last - (CHART_BARS - 1));
    return { ws, s: ws + anchoredStart(w, barStepMs(w.slice(firstShown)), firstShown, QT_DEFAULTS.period, last) };
  };

  // each bar judged: the state of the bar before, from the email's start
  // for this bar (the same computation run to the bar before)
  const judgedBar = new Uint8Array(n);
  const lineBefore = new Float64Array(n).fill(Number.NaN);
  const sideBefore = new Int8Array(n);
  const epsBefore = new Float64Array(n).fill(Number.NaN);
  const upBefore = new Float64Array(n).fill(Number.NaN);
  const downBefore = new Float64Array(n).fill(Number.NaN);
  const rsiBefore = new Float64Array(n).fill(Number.NaN);
  // the 200-close range over the 199 closes before the bar, and the four
  // bars before's "opened in the range's end eighth" (Q-Trend's STRONG)
  const hi199 = new Float64Array(n).fill(Number.NaN);
  const lo199 = new Float64Array(n).fill(Number.NaN);
  const sbBefore = new Uint8Array(n);
  const ssBefore = new Uint8Array(n);
  const signals: Array<{ i: number; rule: Rule; side: Side; strong: boolean }> = [];
  const P = QT_DEFAULTS.period;
  let seg: { s: number; from: number; to: number } | null = null;
  const flush = () => {
    if (!seg) return;
    const bars = candles.slice(seg.s, seg.to + 1);
    const qt = qTrend(bars, QT_DEFAULTS, bars.length - 1);
    for (const x of qt.signals) {
      const at = seg.s + x.i;
      if (at >= seg.from && at <= seg.to) signals.push({ i: at, rule: "qtrend", side: x.side, strong: x.strong });
    }
    const ul = ultra(bars, bars.length - 1, unit, ULTRA_PAIRS);
    for (const tr of ul.trades) {
      const at = seg.s + tr.i;
      if (at >= seg.from && at <= seg.to) signals.push({ i: at, rule: "ultra", side: tr.side, strong: false });
    }
    const atr = pineAtr(bars, QT_DEFAULTS.atrPeriod);
    // RSI's averages, as ultra.ts pineRsi works them
    const src = bars.map((b) => b.close);
    const ups = src.map((c, k) => (k === 0 ? null : Math.max(c - src[k - 1], 0)));
    const downs = src.map((c, k) => (k === 0 ? null : Math.max(src[k - 1] - c, 0)));
    const u = pineRma(ups, RSI_N);
    const d = pineRma(downs, RSI_N);
    const rsi = pineRsi(src, RSI_N);
    // Q-Trend's "opened in the lowest / highest eighth of the 200-close range"
    const sb = (k: number) => {
      let h = -Infinity;
      let l = Infinity;
      for (let q = k - P + 1; q <= k; q++) {
        if (src[q] > h) h = src[q];
        if (src[q] < l) l = src[q];
      }
      const dd = h - l;
      const o = bars[k].open;
      return { b: o < l + dd / 8 && o >= l, s: o > h - dd / 8 && o <= h };
    };
    for (let k = seg.from; k <= seg.to; k++) {
      const r = k - seg.s;
      // the judged bar has 200 closes and more before it from its start
      // (anchoredStart keeps P bars before the chart's first)
      if (r - 1 < P + 4) throw new Error(`${pair} ${iso(times[k])}: too few bars before (${r})`);
      lineBefore[k] = qt.line[r - 1] ?? Number.NaN;
      const tb = qt.trend[r - 1];
      sideBefore[k] = tb === 1 ? 1 : tb === -1 ? -1 : 0;
      epsBefore[k] = atr[r - 1] ?? Number.NaN;
      upBefore[k] = u[r - 1] ?? Number.NaN;
      downBefore[k] = d[r - 1] ?? Number.NaN;
      rsiBefore[k] = rsi[r - 1] ?? Number.NaN;
      let h = -Infinity;
      let l = Infinity;
      for (let q = r - P + 1; q <= r - 1; q++) {
        if (src[q] > h) h = src[q];
        if (src[q] < l) l = src[q];
      }
      hi199[k] = h;
      lo199[k] = l;
      let bflags = 0;
      let sflags = 0;
      for (let j = 1; j <= 4; j++) {
        const x = sb(r - j);
        if (x.b) bflags = 1;
        if (x.s) sflags = 1;
      }
      sbBefore[k] = bflags;
      ssBefore[k] = sflags;
    }
    seg = null;
  };
  let judged = 0;
  for (let i = 0; i < n; i++) {
    const T = times[i] + STEP;
    if (T < START_MS) continue;
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

  // a bar's signals were it to close at `c`, worked from the bar before's
  // state with the email's own rules (qtrend.ts qTrend's last step, ultra.ts
  // ultra's): checked against the email's function (p1, p2)
  const alpha = 1 / RSI_N;
  const fast = (k: number, c: number): Array<{ rule: Rule; side: Side; strong: boolean }> => {
    const out: Array<{ rule: Rule; side: Side; strong: boolean }> = [];
    const m = lineBefore[k];
    const a = epsBefore[k];
    const eps = QT_DEFAULTS.mult * a;
    const up = Number.isFinite(m) && Number.isFinite(a) && c > m + eps;
    const down = Number.isFinite(m) && Number.isFinite(a) && c < m - eps;
    const h = Math.max(hi199[k], c);
    const l = Math.min(lo199[k], c);
    const dd = h - l;
    const o = candles[k].open;
    const sbNow = o < l + dd / 8 && o >= l;
    const ssNow = o > h - dd / 8 && o <= h;
    const ls = sideBefore[k];
    if (up && ls !== 1) out.push({ rule: "qtrend", side: "BUY", strong: sbNow || sbBefore[k] === 1 });
    if (down && ls !== -1) out.push({ rule: "qtrend", side: "SELL", strong: ssNow || ssBefore[k] === 1 });
    const prev = closes[k - 1];
    const uu = upBefore[k];
    const dn = downBefore[k];
    const p = rsiBefore[k];
    if (Number.isFinite(uu) && Number.isFinite(dn) && Number.isFinite(p)) {
      const u2 = alpha * Math.max(c - prev, 0) + (1 - alpha) * uu;
      const d2 = alpha * Math.max(prev - c, 0) + (1 - alpha) * dn;
      const r = d2 === 0 ? 100 : u2 === 0 ? 0 : 100 - 100 / (1 + u2 / d2);
      const side = r > OVERSOLD && p <= OVERSOLD ? "BUY" : r < OVERBOUGHT && p >= OVERBOUGHT ? "SELL" : null;
      if (side) out.push({ rule: "ultra", side, strong: false });
    }
    return out;
  };
  const keyOf = (xs: Array<{ rule: Rule; side: Side; strong: boolean }>) => xs.map((x) => `${x.rule}:${x.side}:${x.strong ? "S" : "-"}`).sort().join(",");

  // (a) the signals at the close against the email's function; (p2) worked
  // at the close's price against them
  const atBar = new Map<number, Array<{ rule: Rule; side: Side; strong: boolean }>>();
  for (const s of signals) atBar.set(s.i, [...(atBar.get(s.i) ?? []), { rule: s.rule, side: s.side, strong: s.strong }]);
  const toCheck = new Set<number>(signals.map((s) => s.i));
  for (let i = 0; i < n; i += CHECK_EVERY) toCheck.add(i);
  for (const i of [...toCheck].sort((x, y) => x - y)) {
    if (!judgedBar[i]) continue;
    const a = anchorOf(i)!;
    const xs = indicatorSignals(pair, TF, candles.slice(a.ws, i + 1), times[i] + STEP + 60_000, 120_000).filter((x) => Date.parse(x.barTime) === times[i]);
    const theirs = xs.map((x) => `${x.rule}:${x.side}:${x.strong ? "S" : "-"}`).sort().join(",");
    tally(checks.signals, theirs === keyOf(atBar.get(i) ?? []), () => `${pair} ${iso(times[i])} mine=${keyOf(atBar.get(i) ?? []) || "-"} theirs=${theirs || "-"}`);
  }
  for (let i = 0; i < n; i++) {
    if (!judgedBar[i]) continue;
    const mine = keyOf(atBar.get(i) ?? []);
    const worked = keyOf(fast(i, closes[i]));
    tally(checks.atClose, mine === worked, () => `${pair} ${iso(times[i])} signals=${mine || "-"} worked=${worked || "-"}`);
  }

  // a trade from `fromMs` at `fill`, TP1 and the stop from `mid`, until the
  // close of bar i + LIMIT (as research/widetp.ts tradeAt)
  const follow = (i: number, side: Side, fill: number, mid: number, fromMs: number): number | null => {
    if (i + LIMIT >= n) return null;
    const buy = side === "BUY";
    const dir = buy ? 1 : -1;
    const tp = mid + dir * TP * unit;
    const sl = mid - dir * SL * unit;
    const pipsOf = (x: number) => (buy ? x - fill : fill - x) / unit;
    const o = buy ? fine.bo : fine.ao;
    const h = buy ? fine.bh : fine.ah;
    const l = buy ? fine.bl : fine.al;
    const c = buy ? fine.bc : fine.ac;
    const f0 = lowerBound(fine.t, fromMs);
    let f = f0;
    if (f >= fine.n) return null;
    // (p3) following starts at the first 5-minute bar opening at or after
    // the entry, and the one before it opened before
    tally(checks.follow, fine.t[f0] >= fromMs && (f0 === 0 || fine.t[f0 - 1] < fromMs), () => `${pair} ${iso(fromMs)} follows from ${iso(fine.t[f0])}`);
    const endMs = times[i + LIMIT] + STEP;
    while (f < fine.n && fine.t[f] < endMs) {
      if (buy ? o[f] <= sl : o[f] >= sl) return pipsOf(o[f]);
      if (buy ? o[f] >= tp : o[f] <= tp) return pipsOf(o[f]);
      const hitSl = buy ? l[f] <= sl : h[f] >= sl;
      const hitTp = buy ? h[f] >= tp : l[f] <= tp;
      if (hitSl) return pipsOf(sl);
      if (hitTp) return pipsOf(tp);
      f++;
    }
    if (f >= fine.n && fine.t[fine.n - 1] + FINE < endMs) return null;
    if (f === f0) return null;
    const closePx = c[f - 1];
    const own = buy ? qs[i + LIMIT].bid.close : qs[i + LIMIT].ask.close;
    tally(checks.closes, Math.abs(closePx - own) <= unit / 1000, () => `${pair} ${iso(times[i + LIMIT])} ${side} ${closePx}/${own}`);
    return pipsOf(closePx);
  };
  const emailTrade = (i: number, side: Side): number | null => {
    const buy = side === "BUY";
    return follow(i, side, buy ? qs[i].ask.close : qs[i].bid.close, closes[i], times[i] + STEP);
  };

  // (h) §8.83's T20: the email's trades, one a bar and side, those with 120
  // bars in the data
  if (grp === "AB") {
    const seen = new Set<string>();
    for (const s of signals) {
      const T = times[s.i] + STEP;
      if (!mailed(T) || s.i + REPRO_NEED >= n) continue;
      const k = `${s.i}:${s.side}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const p = emailTrade(s.i, s.side);
      if (p === null) continue;
      addTo(aggOf("repro", T < SPLIT_MS ? 0 : 1, "T20"), weekOf(T), p);
    }
  }

  // what a sweep at t has: the 5-minute bars opening before t, cut there
  // (a view, not the arrays past it), and the last of them if it ends at t
  const seenAt = (t: number): Seen | null => {
    const k = lowerBound(fine.t, t);
    const ts = fine.t.subarray(0, k);
    if (!ts.length || ts[ts.length - 1] + FINE !== t) return null;
    const bid = fine.bc.subarray(0, k)[k - 1];
    const ask = fine.ac.subarray(0, k)[k - 1];
    return { c: roundTo((bid + ask) / 2, dec), bid, ask };
  };

  // the checks before each close, and what they warn
  let nChecks = 0;
  let noPrice = 0;
  let nSignals = 0;
  const leadSteps = new Set(LEADS.map((x) => x / 5));
  for (let i = 0; i < n; i++) {
    if (!judgedBar[i]) continue;
    const T = times[i] + STEP;
    if (T > NOW || !mailed(T)) continue;
    const half: 0 | 1 = T < SPLIT_MS ? 0 : 1;
    const week = weekOf(T);
    for (const g of groups) seeWeek(g, half, week);
    // (p0) the 5-minute bar ending at the close
    const fz = lowerBound(fine.t, T - FINE);
    if (fz < fine.n && fine.t[fz] === T - FINE) {
      const mid = roundTo((fine.bc[fz] + fine.ac[fz]) / 2, dec);
      tally(checks.closeMid, mid === closes[i], () => `${pair} ${iso(times[i])} 5-minute mid ${mid} / close ${closes[i]}`);
    }
    // the checks: step m is t = T − 5m minutes
    const at: Array<{ t: number; fi: number; c: number; fires: Array<{ rule: Rule; side: Side; strong: boolean }>; seen: Seen | null } | null> = new Array(MAX_STEPS + 1).fill(null);
    const a = anchorOf(i)!;
    for (let m = 1; m <= MAX_STEPS; m++) {
      const t = T - m * FINE;
      const fi = lowerBound(fine.t, t - FINE);
      if (fi >= fine.n || fine.t[fi] !== t - FINE) {
        if (leadSteps.has(m)) noPrice++;
        continue;
      }
      const c = roundTo((fine.bc[fi] + fine.ac[fi]) / 2, dec);
      // (p3) the price again, from the 5-minute bars cut at t (only those
      // opening before t: what a sweep at t has)
      const seen = seenAt(t);
      tally(checks.noAhead, seen !== null && seen.c === c && seen.bid === fine.bc[fi] && seen.ask === fine.ac[fi], () => `${pair} ${iso(t)} used ${c} (${fine.bc[fi]}/${fine.ac[fi]}), seen ${seen ? `${seen.c} (${seen.bid}/${seen.ask})` : "none"}`);
      const fires = fast(i, c);
      at[m] = { t, fi, c, fires, seen };
      if (leadSteps.has(m)) nChecks++;
      // (p1) against the email's function with the forming bar last, at
      // every check that gives a signal and at every check of every 13th bar
      if (i % CHECK_EVERY === 0 || fires.length > 0) {
        const f0 = lowerBound(fine.t, times[i]);
        let hh = candles[i].open;
        let ll = candles[i].open;
        for (let q = f0; q <= fi; q++) {
          hh = Math.max(hh, (fine.bh[q] + fine.ah[q]) / 2);
          ll = Math.min(ll, (fine.bl[q] + fine.al[q]) / 2);
        }
        const forming = { datetime: candles[i].datetime, open: candles[i].open, high: roundTo(Math.max(hh, c), dec), low: roundTo(Math.min(ll, c), dec), close: c };
        const xs = indicatorSignals(pair, TF, [...candles.slice(a.ws, i), forming], T + 60_000, 120_000).filter((x) => Date.parse(x.barTime) === times[i]);
        const theirs = xs.map((x) => `${x.rule}:${x.side}:${x.strong ? "S" : "-"}`).sort().join(",");
        tally(checks.partial, theirs === keyOf(fires), () => `${pair} ${iso(times[i])} −${5 * m} min at ${c}: worked=${keyOf(fires) || "-"} theirs=${theirs || "-"}`);
      }
    }
    // the signals at the close
    const sigs = atBar.get(i) ?? [];
    nSignals += sigs.length;
    const sigSide = (rule: Rule | "either", side: Side) => sigs.some((s) => (rule === "either" || s.rule === rule) && s.side === side);
    // a warning's trade, by side and check (the same for every design and
    // lead that warns there)
    const wtCache = new Map<string, number | null>();
    const wtAt = (side: Side, m: number) => {
      const k = `${side}:${m}`;
      if (!wtCache.has(k)) {
        const ck = at[m]!;
        wtCache.set(k, follow(i, side, side === "BUY" ? fine.ac[ck.fi] : fine.bc[ck.fi], ck.c, ck.t));
      }
      return wtCache.get(k)!;
    };
    const etCache = new Map<Side, number | null>();
    const et = (side: Side) => {
      if (!etCache.has(side)) etCache.set(side, emailTrade(i, side));
      return etCache.get(side)!;
    };
    // the email's own trades on the signals (each indicator's; either one a side)
    for (const rule of SHOWN) {
      for (const side of ["BUY", "SELL"] as const) {
        if (!sigSide(rule, side)) continue;
        const p = et(side);
        if (p !== null) for (const g of groups) addTo(aggOf(g, half, `ET ${rule}`), week, p);
      }
    }
    for (const design of DESIGNS) {
      for (const X of LEADS) {
        const M = X / 5;
        // the checks this design makes, earliest first
        const steps = design === "once" ? [M] : Array.from({ length: M }, (_, k) => M - k);
        const made = steps.filter((m) => at[m] !== null);
        if (!made.length) continue;
        for (const rule of SHOWN) {
          const tag = `${rule} ${design} ${X}`;
          // warnings: the first check giving each side
          const warned = new Map<Side, number>();
          for (const m of made) {
            for (const f of at[m]!.fires) {
              if (rule !== "either" && f.rule !== rule) continue;
              if (!warned.has(f.side)) warned.set(f.side, m);
            }
          }
          for (const side of ["BUY", "SELL"] as const) {
            // the signals at the close on this bar: warned?
            if (sigSide(rule, side)) for (const g of groups) addTo(aggOf(g, half, `R ${tag}`), week, warned.has(side) ? 1 : 0);
          }
          for (const [side, m] of warned) {
            const hit = sigSide(rule, side);
            const other = sigSide(rule, side === "BUY" ? "SELL" : "BUY");
            const ck = at[m]!;
            const buy = side === "BUY";
            const fill = buy ? fine.ac[ck.fi] : fine.bc[ck.fi];
            tally(checks.noAhead, ck.seen !== null && fill === (buy ? ck.seen.ask : ck.seen.bid), () => `${pair} ${iso(ck.t)} ${side} fill ${fill}, seen ${ck.seen ? (buy ? ck.seen.ask : ck.seen.bid) : "none"}`);
            const wt = wtAt(side, m);
            for (const g of groups) {
              addTo(aggOf(g, half, `W ${tag}`), week, hit ? 1 : 0);
              addTo(aggOf(g, half, `O ${tag}`), week, other ? 1 : 0);
              if (hit) addTo(aggOf(g, half, `L ${tag}`), week, 5 * m);
              if (hit) addTo(aggOf(g, half, `G ${tag}`), week, (buy ? qs[i].ask.close - fill : fill - qs[i].bid.close) / unit);
              if (wt !== null) {
                addTo(aggOf(g, half, `WT ${tag}`), week, wt);
                addTo(aggOf(g, half, `${hit ? "WTH" : "WTM"} ${tag}`), week, wt);
                const e = hit ? et(side) : null;
                if (hit && e !== null) addTo(aggOf(g, half, `D ${tag}`), week, wt - e);
              }
            }
          }
        }
      }
    }
  }
  coverage.push({ pair, group: grp, judged, signals: nSignals, checks: nChecks, noPrice });
  console.log(`${pair} (${grp}) 4h: ${n} bars, judged ${judged}, signals ${nSignals}, checks at the leads ${nChecks} (no price ${noPrice}); GMO failed ${fineGot.failed + got.failed}`);
}

// ---- the report ------------------------------------------------------------------------

const num = (x: number | null | undefined, d = 2) => (x === null || x === undefined || !Number.isFinite(x) ? "   -  " : `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(d)}`);
const pctOf = (x: number | null | undefined) => (x === null || x === undefined || !Number.isFinite(x) ? "  -  " : `${(100 * x).toFixed(1)}%`);
const ci = (a: Agg | undefined, f: (x: number | null) => string) => {
  const w = intervalOf(a, "weeks");
  const b = intervalOf(a, "blocks");
  return `[${f(w.lo)},${f(w.hi)}] (4 wk [${f(b.lo)},${f(b.hi)}])`;
};
const checkLine = (what: string, c: Check) => `${what}: ${c.mismatched} of ${c.compared} differ${c.examples.length ? ": " + c.examples.join("; ") : ""}`;

console.log(`\n#171-5 warnings before the 4-hour close, ${START} .. ${iso(NOW)} (halves at ${SPLIT}); leads ${LEADS.join(", ")} minutes; the email's exit TP1 ${TP}, stop ${SL}, ${LIMIT} bars${SYNTHETIC ? `; SYNTHETIC ${SYNTH} seed ${SEED}` : ""}`);
console.log(`\n== CHECKS`);
console.log(checkLine("(a) the signals at the close against indicatorSignals", checks.signals));
console.log(checkLine("(p0) the 5-minute mid at the close against the bar's close", checks.closeMid));
console.log(checkLine("(p1) a check's signals, worked, against indicatorSignals with the forming bar", checks.partial));
console.log(checkLine("(p2) worked at the close's price against the signals at the close", checks.atClose));
console.log(checkLine("(p3) the price and the fill again from the 5-minute bars cut at the check", checks.noAhead));
console.log(checkLine("(p3) following starts at the first 5-minute bar at or after the entry", checks.follow));
console.log(checkLine("(d) time-out closes against the 4-hour bar's own", checks.closes));
console.log(`(g) GMO reads that failed: ${failedReads}`);
// (h) holds for the run fixed above only (as research/widetp.ts)
const hApplies = !SYNTHETIC && START === "2024-01-01" && SPLIT === "2025-05-19" && NOW === Date.parse("2026-09-29T14:16:25Z") && !Deno.env.get("PAIRS");
let hDiffer: number | null = null;
if (!SYNTHETIC && !hApplies) console.log("(h) does not apply: not the run fixed in the header");
if (hApplies) {
  const want = [{ m: "−1.35", n: 2416 }, { m: "−1.27", n: 2216 }];
  hDiffer = 0;
  const parts: string[] = [];
  for (const half of [0, 1] as const) {
    const a = aggAt("repro", half, "T20");
    const m = a ? num(a.sum / a.n) : "-";
    const ok = a !== undefined && m === want[half].m && a.n === want[half].n;
    if (!ok) hDiffer++;
    parts.push(`${half === 0 ? "first" : "second"} ${m} of ${a?.n ?? 0} (§8.83: ${want[half].m} of ${want[half].n})`);
  }
  console.log(`(h) §8.83's T20 again, ${hDiffer} of 2 differ: ${parts.join("; ")}`);
}
const allDiffer = Object.values(checks).reduce((s, c) => s + c.mismatched, 0) + failedReads + (hDiffer ?? 0);
console.log(allDiffer === 0 ? "EVERY CHECK 0 DIFFER" : `CHECKS DIFFER (${allDiffer}): the numbers below are not to be read`);

const line = (group: string, half: 0 | 1 | "full", rule: string, design: Design, X: number) => {
  const tag = `${rule} ${design} ${X}`;
  const W = aggAt(group, half, `W ${tag}`);
  const R = aggAt(group, half, `R ${tag}`);
  const O = aggAt(group, half, `O ${tag}`);
  const G = aggAt(group, half, `G ${tag}`);
  const L = aggAt(group, half, `L ${tag}`);
  const WT = aggAt(group, half, `WT ${tag}`);
  const WTH = aggAt(group, half, `WTH ${tag}`);
  const WTM = aggAt(group, half, `WTM ${tag}`);
  const D = aggAt(group, half, `D ${tag}`);
  const weeks = weeksOf(group, half);
  const mean = (a: Agg | undefined) => (a && a.n ? a.sum / a.n : null);
  return [
    `  ${String(X).padStart(3)} min: ${W?.n ?? 0} warnings (${num(weeks ? (W?.n ?? 0) / weeks : null, 1)} a week), hit ${pctOf(mean(W))} ${ci(W, pctOf)}, the other way ${pctOf(mean(O))}; signals ${R?.n ?? 0}, warned ${pctOf(mean(R))} ${ci(R, pctOf)}${design === "watch" ? `; the hits warned ${L ? medianOf(L.xs) : "-"} min before the close (median)` : ""}`,
    `           on a hit, entering at the warning gained ${num(mean(G))} pips ${ci(G, (x) => num(x))} (median ${num(G ? medianOf(G.xs) : null)}); the warning's trade ${num(mean(WT))} ${ci(WT, (x) => num(x))} of ${WT?.n ?? 0}, ${num(weeks && WT ? WT.sum / weeks : null, 1)} pips a week (hits ${num(mean(WTH))} of ${WTH?.n ?? 0}, misses ${num(mean(WTM))} of ${WTM?.n ?? 0}); on the hits, less the email's ${num(mean(D))} ${ci(D, (x) => num(x))} of ${D?.n ?? 0}`,
  ].join("\n");
};
for (const group of ["AB", "C", "all"]) {
  if (!weeksOf(group, "full")) continue;
  for (const rule of SHOWN) {
    const ET = aggAt(group, "full", `ET ${rule}`);
    const weeks = weeksOf(group, "full");
    for (const design of DESIGNS) {
      console.log(`\n== ${rule}|${group}, ${design}, the whole period (${weeks} weeks); the email's own trades ${num(ET && ET.n ? ET.sum / ET.n : null)} ${ci(ET, (x) => num(x))} of ${ET?.n ?? 0} (${num(ET ? ET.sum / weeks : null, 1)} pips a week)`);
      for (const X of LEADS) {
        if (design === "watch" && X === 5) continue;
        console.log(line(group, "full", rule, design, X));
      }
    }
  }
}
for (const group of ["AB"]) {
  for (const half of [0, 1] as const) {
    for (const rule of SHOWN) {
      for (const design of DESIGNS) {
        console.log(`\n== ${rule}|${group}, ${design}, ${half === 0 ? "first" : "second"} half (${weeksOf(group, half)} weeks)`);
        for (const X of LEADS) {
          if (design === "watch" && X === 5) continue;
          console.log(line(group, half, rule, design, X));
        }
      }
    }
  }
}
console.log(`\n== the pairs`);
for (const c of coverage) console.log(`  ${c.pair.padEnd(8)} ${c.group}: judged ${c.judged}, signals ${c.signals}, checks at the leads ${c.checks}, no price ${c.noPrice}`);
if (!SYNTHETIC) {
  const without = ALL_PAIRS.filter((p) => !coverage.some((c) => c.pair === p && c.judged > 0));
  console.log(`  not measured (no bar judged): ${without.join(", ") || "none"}`);
}

// ---- the numbers out, for the walks' summary --------------------------------------------

const aggOut = (a: Agg | undefined) => {
  if (!a || !a.n) return null;
  const w = statOf(a, "weeks")!;
  const b = statOf(a, "blocks")!;
  return { n: a.n, sum: a.sum, m: w.m, se: Number.isFinite(w.se) ? w.se : null, se4: Number.isFinite(b.se) ? b.se : null, C: w.C, C4: b.C };
};
await Deno.mkdir(OUT, { recursive: true });
await Deno.writeTextFile(
  `${OUT}/prewarn${SYNTHETIC ? `-${SYNTH}-${SEED}` : ""}.json`,
  JSON.stringify({
    start: START,
    split: SPLIT,
    now: iso(NOW),
    synthetic: SYNTHETIC,
    synth: SYNTH,
    seed: SEED,
    leads: LEADS,
    checks,
    failedReads,
    hDiffer,
    allDiffer,
    coverage,
    weeks: Object.fromEntries([...weeksSeen].map(([k, s]) => [k, s.size])),
    store: Object.fromEntries([...store].map(([k, a]) => [k, aggOut(a)])),
  }),
);
