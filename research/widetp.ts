// #172: the email's TP1 wider. The owner (2026-09-30), on the currency
// pairs' targets (TP1 5, TP2 10, TP3 15 pips; the stop 30 since #166):
// 「利確幅、狭すぎる」. Measured before anything is changed: a signal's trade
// taken off at a wider TP1 (10 to 90 pips, or a multiple of the 4-hour
// bar's range), the stop kept at 30, against the email's exit now. The owner
// decides on the numbers.
//
// THE MEASURE, fixed before any of these rules' results were read (the data
// is §8.77's, whose TP1-5 rules' numbers have been seen; no other target's
// on the currency pairs):
//   * the data: GMO's pairs, 4-hour bars, START 2024-01-01 to END 2026-09-29
//     14:16:25 UTC (the end of #165's run 36581316006, read from its log, so
//     that its numbers come out again: check h; §8.77 was written from the
//     run before it, which ended 14:09:47 with the same 4-hour bars closed and
//     printed the same numbers), the first half before SPLIT 2025-05-19. One
//     run on the data.
//   * the signals, the coin (every close either way), the entry (the signal
//     bar's close, a buy at the ask, a sell at the bid) and the 5-minute
//     bid/ask a trade is followed on (a buy's bid, a sell's ask): as #165
//     (research/widestop.ts). The sweep reads a 4-hour chart 0, 4 and 6
//     minutes after its close (#171).
//   * the rules: TP1 T pips from the signal bar's mid close, or k × ATR(14)
//     of the signal bar (pineAtr on the bars from the email's own start,
//     anchoredStart: a number the email could compute), and the stop 30 pips
//     from it; out at whichever a 5-minute bar reaches first (both in one
//     bar: the stop; a bar opening past one: at that open), or at the close
//     of the L-th 4-hour bar. now: T5 S30 L30, the email's when this was
//     fixed. #173 (the same day, before this was run on the data): the owner
//     set the email's targets to 20, 40 and 60 pips (the stop 30) without
//     waiting for these numbers — the email's exit is now the candidate T20
//     S30 L30. now here stays T5, the email's before #173, as fixed.
//       - the candidates (PICKS, ten, L30): T 10, 15, 20, 30, 45, 60, 90;
//         k 0.5, 1, 2.
//       - told only: T 5 to 90 at L120 (four weeks). The email says five days.
//       - for the checks only: T5 S10 L30, T5 none L30 and L120 (#164's).
//       - TP2 and TP3 taken as 2T and 3T (2k, 3k), the video's 5:10:15; for
//         the signals, how often each is reached (a trade out at it, the stop
//         30, L30) is told. The call is on TP1 alone, as every study here.
//   * every rule on the same trades: those whose 120 bars are in the data.
//   * the pairs the pick and the call are on, A+B, eleven, named before any
//     result: the yen majors (USD/JPY, EUR/JPY, GBP/JPY, AUD/JPY, NZD/JPY,
//     CAD/JPY, CHF/JPY) and the dollar pairs (EUR/USD, GBP/USD, AUD/USD,
//     NZD/USD). C (TRY/JPY, ZAR/JPY, MXN/JPY; HUF/JPY and SEK/JPY have no
//     4-hour history before 2026-05) is told apart: a pip is about 0.3% of
//     TRY/JPY's price against 0.005% to 0.02% on A+B, so a number of pips is
//     another thing there (§8.78 saw most of C's trades not end in five days;
//     no target's result on C has been seen). This leaves C out of the call
//     where #165 had all fourteen: said so in the report. The pairs GMO added
//     in #153 have no 4-hour history: not measured.
//   * the pick: on the first half of A+B's emails' signals (either), less the
//     trades whose 30 bars reach past SPLIT (they would read second-half
//     prices), the candidate with the highest t of "rule less now": its mean
//     over its standard error, the larger of the errors by week and by four
//     weeks. The mean alone would pick the widest, noisiest rule most often,
//     the one the call can least tell. Ties: the earlier in the order above.
//   * called clearly better: the pick's pips a trade over now's on the second
//     half, and the low end of "pick less now" over 0: the lower of the
//     intervals by week and by four weeks, each its mean less t(C − 1) × its
//     standard error, C the weeks (or four-week blocks) holding trades (so
//     2.11 rather than 1.96 for 18 blocks). Every interval here is so.
//   * a second road, for the owner reading the table: every candidate's
//     second-half "less now" with a Bonferroni interval (one-sided 2.5% / K,
//     K the candidates; the lower of by week and by four weeks); a rule not
//     picked is told "above 0 after the correction" only when that low end
//     is. The two roads together say "clearly" falsely at most about 5% of
//     the time.
//   * told, not called on: C and all the pairs; each side; Q-Trend, ULTRA,
//     STRONG; the coin; L120; how each went out (tp, sl, amb, time; the
//     time-outs' pips); TP1 first, tp / (tp + sl + amb), with the time-outs
//     beside it and the break-even 30 / (30 + T) (the spread left out); how
//     soon TP1 came (within the first 5-minute bar, 15 minutes, an hour, 4
//     hours, a day of the market's 5-minute bars); days held; TP2 and TP3
//     reached; the chart's own count for each T (ultra.ts followTrade: the
//     4-hour mid bars, no spread, no limit, both in one bar the stop, TOTAL =
//     TP1 + SL); the stop filled 0.5 and 1 pip worse; each pair; each pair
//     left out; the pairs weighted alike.
//   * checks, every one 0 differ on every walk and on the data before any
//     result is read:
//       (a) the signals against indicatorSignals, on every 13th bar and on
//           every bar with a signal;
//       (a2) the email's close, stop and three targets against the ones
//            here: close ∓ 30 pips, and close ± ULTRA_PAIRS' targets (5, 10
//            and 15 when fixed; 20, 40 and 60 since #173: T20's levels);
//       (a3) Q-Trend's ε in the email against ATR(14) of the bar before from
//            the same start: the ATR series here is the email's;
//       (a4) on the same bars, the bar's own ATR(14) (the ATR rules' unit)
//            against it computed again on the bars from the email's start;
//       (b) T5 S10 L30 against #164's now, T5 none against #164's hold;
//       (c1) a trade out at TP1 or the limit under a stop, the same under the
//            next wider (T5: 10, 30, none);
//       (c2) the stop 30, a target and the next wider, the pips and the ATR
//            ones together in the order of the trade's own distances (L30;
//            L120, the pips ones): out at the stop or the limit under the
//            narrower, the same under the wider (both in one bar: the same
//            pips and bars, out at the stop or both); out at TP1 under the
//            wider, at TP1 under the narrower no later; the wider never out
//            sooner;
//       (c3) out within 30 bars, the same within 120; timed out at 30 bars,
//            out later within 120;
//       (d) the exits at a close against the 4-hour bar's own;
//       (e) no trade without its ATR, and no signal without its TP2 and TP3;
//       (f) the reads at 0, 4 and 6 minutes mail the bars those at 4 and 6
//           did;
//       (g) no GMO read failed;
//       (h) #165's numbers again: all the pairs' signals (either), T5 S10
//           L30, T5 S30 L30, T5 S30 L120, T5 none L30 and L120, each half's
//           trades and pips a trade to two places, as §8.77.
//
// ON RANDOM WALKS (21 pairs, SYNTHETIC=1), before any data is read:
//   * "path" (#165's: 100 small steps a 5-minute bar; no rule gains), seeds
//     7 .. 56: every check 0 differ; the call fires on at most 3 of the 50
//     (at a nominal 2.5% more than 3 come by chance 3.6% of the time; and
//     at twice that rate, 5%, 3 or fewer still come 76% of the time: this
//     gate is loose); the Bonferroni road on at most 3 of the 50; each
//     candidate's z of "less now" on the halves (100, by week and by four
//     weeks) near a standard normal: one whose low end is over 0 on 7 or more
//     of the 100 (nominal 2.5 of 100; 7 or more by chance 1.3%), or whose z
//     has an sd over 1.25, is left out of the candidates before the data
//     (told). The coin: TP1 first at L120 within 2 points of 29.8 / (30 + T)
//     for T5 to T30, and at L30 of the mean of 29.8 / (30 + k·ATR) for A0.5
//     and A1 (the levels on the mid close, the exit on the bid or ask, 0.2
//     pip off it); "less now" within ±0.3 pips for every rule with the
//     stop 30, the seeds and halves together (the stop filled at its level
//     while the step crossing it went a little past, about 0.1 pip, gives a
//     wider target a small edge: expected, and told).
//   * "wicks" (#162's walks: a wick filled on and the price coming back, so
//     a narrow target gains), seeds 7 .. 16: told.
//   * "drift" (added: the path walk, and after a signal's bar its exit
//     prices moved 0.05 pip a 5-minute bar its way, the coin's not: a wider
//     target really gains), seeds 7 .. 16: the call must fire on at least 9
//     of the 10, else the program is looked into before the data.
//   * the power, from the path runs (research/widetp-seeds.py): 0.5, 1 or 2
//     pips a trade added to one candidate (T20, T45 or A1): how often it is
//     picked, and called.
//   * what the walks cannot show: pairs moving together (the walks' are
//     independent), the spread varying by the hour, the weekend gaps.
//
// THE WALKS' RESULTS (the program as of de9efd4, ULTRA_PAIRS' targets 20, 40
// and 60; 70 runs: path 7 .. 56, wicks and drift 7 .. 16;
// research/widetp-seeds.py on their JSON. A first batch, before the review's
// fixes of 59446aa, gave the same numbers but the break-even told; the batch
// at 59446aa stopped on 39 runs at the assertion that the email's targets
// were 5, 10 and 15 once #173 moved them, and was run again whole):
//   * every check 0 differ on all 70 (signals 1,151,693 compared, the levels
//     717,092, the ATR series 1,151,693, the target nest 219,471,372, the
//     reads 6,531,210, ...).
//   * path: the call on 0 of the 50, the Bonferroni road on 0. Each
//     candidate's low end over 0 on 0 to 3 of its 100 halves, z's sd 0.96 to
//     1.11 by week and 1.00 to 1.18 by four weeks, the means -0.23 to -0.06
//     by week (-0.26 to -0.07 by four weeks): no candidate left out. The coin: TP1 first 84.9% for T5 (29.8 / 35.0 =
//     85.1%), 74.4 (74.5), 66.2 (66.2), 59.6 (59.6), 49.7 (49.7); A0.5 72.8
//     (72.9), A1 57.6 (57.6). "less now" +0.025 (T10) to +0.166 (T90 L120),
//     within ±0.3 and wider higher, as expected. The picks spread over all
//     ten (T10 10 times, T90 8, ... T20 and A1 twice).
//   * wicks: the call on 0 of 10; every wider target less than now (-0.07 to
//     -0.42 pips a trade), as the walk is built.
//   * drift: the call on 10 of 10 (the gate 9), T90 picked every time, every
//     candidate on the Bonferroni road.
//   * the power on the path runs, a gain added to one candidate (picked; then
//     called): T20 +0.5 pip 35 of 50, 3; +1 48, 23; +2 50, 49. T45 +0.5 23,
//     3; +1 39, 6; +2 50, 30. A1 +0.5 32, 2; +1 48, 20; +2 50, 48. So a gain
//     under a pip a trade is seldom called at the walks' noise, which is not
//     the data's: the data's own intervals are told with the result.
//
// THE RESULT (2026-09-30, docs §8.83, run 36738170786 at 75c56c4): every
// check 0 differ, (h) §8.77's five numbers again to two places, no GMO read
// failed. A+B, the emails' signals (either), 4-hour bars, pips a trade, the
// first half and the second (2,416 and 2,216 trades):
//   * now T5 −0.48 and −1.20; T10 −0.90 and −1.10; T15 −1.15 and −1.29; T20
//     −1.35 and −1.27; T30 −1.77 and −0.96; T45 −1.41 and −0.58; T60 −1.82
//     and −0.91; T90 −2.91 and −0.85; A0.5 −1.66 and −1.24; A1 −2.53 and
//     −1.18; A2 −3.47 and −1.36. TP1 first just under the break-even for
//     every one (T5 84.7% against 85.7%, T20 58.3% against 60.0%, the whole
//     period).
//   * the pick: every candidate's t below 0 on the first half; T45 the
//     least (t −1.07). On the second half −0.58 against now −1.20; the
//     difference +0.62 (−1.33 to +2.57; by four weeks −1.73 to +2.97): not
//     clearly better. The Bonferroni road: no candidate.
//   * T20, the email's exit since #173, less now: −0.88 and −0.07; the
//     whole period −0.49 (−1.24 to +0.26; by four weeks −1.33 to +0.35).
//   * told: the pick's second-half "less now" on ULTRA's signals alone
//     +3.34 (+0.41 to +6.27; by four weeks −0.23 to +6.91; 671 trades),
//     STRONG's +4.09 (+0.47 to +7.71; by four weeks −0.06 to +8.25; 493),
//     Q-Trend's −0.31; each pair −3.98 (EUR/USD) to +5.26 (USD/JPY): told
//     only, one cut of many. The coin on A+B: now and the candidates (L30)
//     −1.23 to −1.84 on the halves.
//
// NOT MEASURED: the other timeframes (ULTRA_PAIRS is one set for every
// timeframe and currency pair, so a change reaches them too); the pairs
// without 4-hour history, and Twelve Data's; swap; slippage (but for the stop
// filled worse, above); the time from a close to an order.

import { GMO_INTERVALS, GMO_SYMBOLS, dateKeys, jstDayKey, jstYearKey, klineUrl, mergeSides, parseKlines, type QuoteCandle } from "../supabase/functions/track-outcomes/quotes.ts";
import { isMarketClosed, isPossiblyClosed } from "../supabase/functions/_shared/market-hours.ts";
import type { Candle } from "../supabase/functions/analyze/indicators.ts";
import { barOpenMs } from "../supabase/functions/analyze/state.ts";
import { CHART_BARS, LIVE_STEP_MS, historyRead } from "../supabase/functions/live-chart/logic.ts";
import { QT_DEFAULTS, anchoredStart, barStepMs, qTrend } from "../supabase/functions/_shared/qtrend.ts";
import { ULTRA_PAIRS, followTrade, ultra, ultraLevels } from "../supabase/functions/_shared/ultra.ts";
import { pineAtr } from "../supabase/functions/_shared/pine.ts";
import { INDICATOR_PAIRS, indicatorIntervalsFor, indicatorSignals, ultraUnit } from "../supabase/functions/signal-alerts/indicators.ts";
import { DAY, HOUR, MINUTE, WEEK, WEEK_OFFSET, aggregate, iso } from "./lib.ts";

const TFS = ["5min", "15min", "1h", "4h", "1day"] as const;
type Tf = (typeof TFS)[number];
const ALL_PAIRS = INDICATOR_PAIRS.filter((p) => indicatorIntervalsFor(p).includes("5min"));
const PAIRS = (Deno.env.get("PAIRS") || ALL_PAIRS.join(",")).split(",").map((s) => s.trim()).filter(Boolean);
const START = Deno.env.get("START") || "2024-01-01";
const SPLIT = Deno.env.get("SPLIT") || "2025-05-19";
// the #165 run's end (its log: "2024-01-01 .. 2026-09-29 14:16:25")
const END = Deno.env.get("END") || "2026-09-29T14:16:25Z";
const START_MS = Date.parse(`${START}T00:00:00Z`);
const SPLIT_MS = Date.parse(`${SPLIT}T00:00:00Z`);
const END_ISO = END.includes("T") ? END : END.replace(" ", "T");
const NOW = Date.parse(/[zZ]$|[+-]\d\d:\d\d$/.test(END_ISO) ? END_ISO : `${END_ISO}Z`);
if (!Number.isFinite(NOW)) throw new Error(`END ${END} is not a time`);
const SYNTHETIC = Boolean(Deno.env.get("SYNTHETIC"));
const SEED = Number(Deno.env.get("SEED") || 7);
// the walks' 5-minute bars: "wicks" (#162's), "path" (#165's: 100 small steps,
// the high and low the path's own), or "drift" (the path, and a signal's
// exit prices moved its way: a wider target gains)
const SYNTH_IN = Deno.env.get("SYNTH");
const SYNTH = SYNTH_IN === "path" || SYNTH_IN === "drift" ? SYNTH_IN : "wicks";
// "drift": pips a 5-minute bar, a signal's way, from its first 5-minute bar
const DRIFT = 0.05;
const DRIFTING = SYNTHETIC && SYNTH === "drift";
const CACHE = "research/.cache";
const OUT = Deno.env.get("OUTDIR") || "research/out";
const FINE = 5 * MINUTE;
// the sweep's window (signal-alerts HISTORY_BARS, anchoredStart's)
const WINDOW = 600;
const LEAD_DAYS: Record<Tf, number> = { "5min": 5, "15min": 12, "1h": 45, "4h": 0, "1day": 0 };
// when the sweep reads each chart, minutes after its close (#171,
// signal-alerts indicators.ts gmoIntervalsDue): a signal is mailed if one of
// them falls while the market is open. Before #171: the old ones (check f).
const READ_AFTER: Record<Tf, number[]> = { "5min": [0, 1, 3], "15min": [0, 1, 3], "1h": [0, 3, 5], "4h": [0, 4, 6], "1day": [0, 4, 6] };
const READ_AFTER_OLD: Record<Tf, number[]> = { "5min": [1, 3], "15min": [1, 3], "1h": [3, 5], "4h": [4, 6], "1day": [4, 6] };
const mailed = (tf: Tf, closeMs: number): boolean => READ_AFTER[tf].some((m) => !isPossiblyClosed(closeMs + m * MINUTE));
const mailedOld = (tf: Tf, closeMs: number): boolean => READ_AFTER_OLD[tf].some((m) => !isPossiblyClosed(closeMs + m * MINUTE));
// bars checked against indicatorSignals besides every bar with a signal
const CHECK_EVERY = 13;

// the pairs, by name (quotes.ts GMO_SYMBOLS)
const AB = ["USD/JPY", "EUR/JPY", "GBP/JPY", "AUD/JPY", "NZD/JPY", "CAD/JPY", "CHF/JPY", "EUR/USD", "GBP/USD", "AUD/USD", "NZD/USD"];
const C_PAIRS = ["TRY/JPY", "ZAR/JPY", "MXN/JPY", "HUF/JPY", "SEK/JPY"];
for (const p of [...AB, ...C_PAIRS]) if (!GMO_SYMBOLS[p] || !ALL_PAIRS.includes(p)) throw new Error(`${p} is not one of GMO's pairs here`);
const groupOf = (pair: string) => (AB.includes(pair) ? "AB" : C_PAIRS.includes(pair) ? "C" : "D");
// the stop is the email's (ULTRA_PAIRS, #166); its targets, since #173, T20's
if (ULTRA_PAIRS.sl !== 30) throw new Error("ULTRA_PAIRS' stop is not 30: every rule here has moved");

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
    if (SYNTH === "path" || SYNTH === "drift") {
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

const load = async (pair: string, tf: Tf, fromMs: number): Promise<Loaded> => {
  const step = LIVE_STEP_MS[tf];
  if (SYNTHETIC) {
    let fine = syntheticCache.get(pair);
    if (!fine) {
      fine = synthetic5(pair, Date.UTC(new Date(START_MS).getUTCFullYear() - 1, 0, 1));
      syntheticCache.set(pair, fine);
    }
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
const STOP = 30;
const T_GRID = [5, 10, 15, 20, 30, 45, 60, 90];
const K_GRID = [0.5, 1, 2];
type Limit = 30 | 120;
interface Rule {
  key: string;
  kind: "pips" | "atr";
  // pips, or times the signal bar's ATR(14)
  target: number;
  stop: number | null;
  limit: Limit;
}
const pipsRule = (target: number, stop: number | null, limit: Limit): Rule => ({ key: `T${target} S${stop ?? "none"} L${limit}`, kind: "pips", target, stop, limit });
const atrRule = (k: number, limit: Limit): Rule => ({ key: `A${k} S${STOP} L${limit}`, kind: "atr", target: k, stop: STOP, limit });
const RULES: Rule[] = [
  ...T_GRID.map((t) => pipsRule(t, STOP, 30)),
  ...K_GRID.map((k) => atrRule(k, 30)),
  ...T_GRID.map((t) => pipsRule(t, STOP, 120)),
  pipsRule(5, 10, 30),
  pipsRule(5, null, 30),
  pipsRule(5, null, 120),
];
const RULE_KEYS = new Set(RULES.map((r) => r.key));
if (RULE_KEYS.size !== RULES.length) throw new Error("two rules with one key");
const NOW_RULE = "T5 S30 L30";
const NOW_R = RULES.find((r) => r.key === NOW_RULE)!;
const REF_NOW = "T5 S10 L30";
const REF_HOLD30 = "T5 Snone L30";
const REF_HOLD120 = "T5 Snone L120";
// left out of the candidates after the walks, before the data (none yet)
const EXCLUDED: string[] = [];
const PICKS = [...T_GRID.filter((t) => t !== 5).map((t) => `T${t} S30 L30`), ...K_GRID.map((k) => `A${k} S30 L30`)].filter((k) => !EXCLUDED.includes(k));
for (const k of [NOW_RULE, REF_NOW, REF_HOLD30, REF_HOLD120, ...PICKS]) if (!RULE_KEYS.has(k)) throw new Error(`no rule ${k}`);
const L120_RULES = T_GRID.map((t) => `T${t} S30 L120`);
// TP2 and TP3 off the grid (2T, 3T; 2k, 3k), followed for the signals only
const EXTRAS: Rule[] = [...[40, 120, 135, 180, 270].map((t) => pipsRule(t, STOP, 30)), ...[1.5, 3, 4, 6].map((k) => atrRule(k, 30))];
const EXTRA_KEYS = new Set(EXTRAS.map((r) => r.key));
// a rule's TP2 and TP3, as rules of their own
const TP23 = new Map<string, [string, string]>();
for (const k of [NOW_RULE, ...PICKS]) {
  const r = RULES.find((x) => x.key === k)!;
  const at = (m: number) => (r.kind === "pips" ? `T${r.target * m} S30 L30` : `A${r.target * m} S30 L30`);
  TP23.set(k, [at(2), at(3)]);
  for (const x of TP23.get(k)!) if (!RULE_KEYS.has(x) && !EXTRA_KEYS.has(x)) throw new Error(`no rule ${x} for ${k}'s TP2 or TP3`);
}
// the chains the nesting checks walk, narrow to wide. (c2) within 30 bars
// walks every target with the stop 30, the pips and the ATR ones together, in
// the order of the trade's own distances (so an ATR level is held against the
// pips levels about it); within 120, the pips ones
const C1_CHAINS = [["T5 S10 L30", "T5 S30 L30", "T5 Snone L30"], ["T5 S30 L120", "T5 Snone L120"]];
// (by the rules' names, so a rule whose stop is not the one its name says is
// held against the others and shows)
const C2_L30 = [...RULES, ...EXTRAS].map((r) => r.key).filter((k) => k.endsWith(" S30 L30"));
const C2_CHAINS = [T_GRID.map((t) => `T${t} S30 L120`)];
const C3_PAIRS: Array<[string, string]> = [...T_GRID.map((t): [string, string] => [`T${t} S30 L30`, `T${t} S30 L120`]), ["T5 Snone L30", "T5 Snone L120"]];
for (const k of [...C1_CHAINS.flat(), ...C2_CHAINS.flat(), ...C3_PAIRS.flat()]) if (!RULE_KEYS.has(k) && !EXTRA_KEYS.has(k)) throw new Error(`no rule ${k} for a check`);
// every rule on the trades whose 120 bars are in the data
const NEED = 120;
type Exit = "tp" | "sl" | "amb" | "time";
interface Trade {
  pips: number;
  exit: Exit;
  // four-hour bars and market 5-minute bars to the exit (the one it went out
  // in counted), and the time from the entry to the end of that bar
  bars: number;
  f5: number;
  ms: number;
  // TP1's distance and the stop's, pips (the stop null: none)
  tgt: number;
  stop: number | null;
}
// TP1 reached within the first 5-minute bar, 15 minutes, an hour, 4 hours, a
// day (market 5-minute bars)
const FAST = [1, 3, 12, 48, 288];
// the stop filled this much worse (sensitivity)
const SLIPS = [0.5, 1];

// ---- the numbers kept ------------------------------------------------------------------

interface Agg {
  n: number;
  sum: number;
  wins: number;
  winSum: number;
  lossSum: number;
  bars: number;
  exits: Record<Exit, number>;
  exitSum: Record<Exit, number>;
  // Σ S / (S + TP1) over the trades with a stop S, and those trades: the
  // break-even share of TP1 first, the spread left out
  be: number;
  beN: number;
  fast: number[];
  msSum: number;
  held: number[];
  weeks: Map<number, { n: number; s: number }>;
  blocks: Map<number, { n: number; s: number }>;
  all: number[];
}
const newAgg = (): Agg => ({ n: 0, sum: 0, wins: 0, winSum: 0, lossSum: 0, bars: 0, exits: { tp: 0, sl: 0, amb: 0, time: 0 }, exitSum: { tp: 0, sl: 0, amb: 0, time: 0 }, be: 0, beN: 0, fast: FAST.map(() => 0), msSum: 0, held: [], weeks: new Map(), blocks: new Map(), all: [] });
const addTo = (a: Agg, week: number, pips: number, t?: Trade, tails = false) => {
  a.n++;
  a.sum += pips;
  if (tails) a.all.push(pips);
  if (pips > 0) {
    a.wins++;
    a.winSum += pips;
  } else a.lossSum += pips;
  if (t) {
    a.bars += t.bars;
    a.exits[t.exit]++;
    a.exitSum[t.exit] += pips;
    if (t.stop !== null) {
      a.be += t.stop / (t.stop + t.tgt);
      a.beN++;
    }
    a.msSum += t.ms;
    if (tails) a.held.push(t.ms);
    if (t.exit === "tp") {
      for (let q = 0; q < FAST.length; q++) if (t.f5 <= FAST[q]) a.fast[q]++;
    }
  }
  for (const [m, k] of [[a.weeks, week], [a.blocks, Math.floor(week / 4)]] as const) {
    const w = m.get(k) ?? { n: 0, s: 0 };
    w.n++;
    w.s += pips;
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
    a.bars += y.bars;
    a.be += y.be;
    a.beN += y.beN;
    a.msSum += y.msSum;
    for (const k of Object.keys(a.exits) as Exit[]) {
      a.exits[k] += y.exits[k];
      a.exitSum[k] += y.exitSum[k];
    }
    y.fast.forEach((v, q) => (a.fast[q] += v));
    a.held = a.held.concat(y.held);
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
// the lower of the low ends by week and by four weeks
const lowEnd = (a: Agg | undefined, p = 0.975): number | null => {
  const los = (["weeks", "blocks"] as const).map((by) => intervalOf(a, by, p).lo);
  return los.some((x) => x === null) ? null : Math.min(...(los as number[]));
};
const highEnd = (a: Agg | undefined, p = 0.975): number | null => {
  const his = (["weeks", "blocks"] as const).map((by) => intervalOf(a, by, p).hi);
  return his.some((x) => x === null) ? null : Math.max(...(his as number[]));
};
// the pick's measure: the mean over the larger standard error
const tOf = (a: Agg | undefined): number | null => {
  const w = statOf(a, "weeks");
  const b = statOf(a, "blocks");
  if (!w || !b || !Number.isFinite(w.se) || !Number.isFinite(b.se)) return null;
  const se = Math.max(w.se, b.se);
  return se > 0 ? w.m / se : null;
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

// key → period (0 first half, 1 second, 2 the first half for the pick) →
// series (a rule's key; a rule less now, its key and DIFF; that with the stop
// filled worse, and SLIP) → the numbers
const groups = new Map<string, Array<Map<string, Agg>>>();
const aggOf = (key: string, period: 0 | 1 | 2, series: string) => {
  let g = groups.get(key);
  if (!g) {
    g = [new Map(), new Map(), new Map()];
    groups.set(key, g);
  }
  let a = g[period].get(series);
  if (!a) {
    a = newAgg();
    g[period].set(series, a);
  }
  return a;
};
const aggAt = (key: string, period: 0 | 1 | 2, series: string) => groups.get(key)?.[period].get(series);
const aggFull = (key: string, series: string) => mergeAgg([aggAt(key, 0, series), aggAt(key, 1, series)]);
const DIFF = " − now";
const slipKey = (rule: string, s: number) => `${rule}${DIFF} slip ${s}`;

// the chart's own count (ultra.ts followTrade) per key, half and rule
const chart = new Map<string, { tp1: number; sl: number; open: number }>();
const chartOf = (key: string, half: 0 | 1, rule: string) => {
  const k = `${key}|${half}|${rule}`;
  let c = chart.get(k);
  if (!c) {
    c = { tp1: 0, sl: 0, open: 0 };
    chart.set(k, c);
  }
  return c;
};

interface Cover {
  pair: string;
  group: string;
  bars: number;
  judged: number;
  signals: number;
  trades: number;
  failed: number;
  // the spread paid at the signals' entries, and the 4-hour ATR(14) on the
  // first half's bars, medians, pips
  spread: number | null;
  atr: number | null;
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
  ref: newCheck(), // (b)
  stopNest: newCheck(), // (c1)
  targetNest: newCheck(), // (c2)
  limitNest: newCheck(), // (c3)
  closes: newCheck(), // (d)
  atr: newCheck(), // (e): a trade with its ATR
  extras: newCheck(), // (e): a signal with its TP2 and TP3
  reads: newCheck(), // (f)
};
const weekOf = (t: number) => Math.floor((t - WEEK_OFFSET) / WEEK);
const same = (a: Trade, b: Trade) => a.pips === b.pips && a.exit === b.exit && a.bars === b.bars;
const sameFull = (a: Trade, b: Trade) => same(a, b) && a.f5 === b.f5 && a.ms === b.ms;
const slipOf = (t: Trade, s: number) => (t.exit === "sl" || t.exit === "amb" ? t.pips - s : t.pips);

for (const pair of PAIRS) {
  const unit = ultraUnit(pair);
  const grp = groupOf(pair);
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

  // (f) the reads at 0, 4 and 6 minutes against those at 4 and 6
  for (let i = 0; i < n; i++) {
    if (!judgedBar[i]) continue;
    const T = times[i] + step;
    tally(checks.reads, mailed(TF, T) === mailedOld(TF, T), () => `${pair} ${iso(T)} now ${mailed(TF, T)} before ${mailedOld(TF, T)}`);
  }

  // (a), (a2), (a3): the signals, their levels and ε against the emails' own
  // function, on every 13th bar and on every bar with a signal
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
      const ok = x.close === c && x.sl === c - dir * 30 * unit && x.tps !== null && x.tps[0] === c + dir * ULTRA_PAIRS.tp1 * unit && x.tps[1] === c + dir * ULTRA_PAIRS.tp2 * unit && x.tps[2] === c + dir * ULTRA_PAIRS.tp3 * unit;
      tally(checks.levels, ok, () => `${pair} ${iso(times[i])} ${x.rule} ${x.side} close ${x.close}/${c} sl ${x.sl} tps ${x.tps?.join("/")}`);
      if (x.rule === "qtrend") {
        const e = epsAt[i];
        const okE = x.eps === null ? !Number.isFinite(e) : x.eps === QT_DEFAULTS.mult * e;
        tally(checks.eps, okE, () => `${pair} ${iso(times[i])} ε ${x.eps} / ATR before ${e}`);
      }
    }
    // (a4) the bar's own ATR(14), the ATR rules' unit, computed again on the
    // bars from the email's start to the bar
    const own = pineAtr(candles.slice(a.s, i + 1), QT_DEFAULTS.atrPeriod).at(-1) ?? Number.NaN;
    tally(checks.atrSeries, Number.isFinite(own) && own === atrAt[i], () => `${pair} ${iso(times[i])} ATR ${atrAt[i]} / again ${own}`);
  }

  // a trade entered at bar i's close under rule r (`a`: the bar's ATR),
  // followed on the 5-minute bid/ask (under "drift", a signal's prices moved
  // its way); null when not a signal the sweep would mail, or when its 120
  // bars are not all in the data
  const tradeAt = (i: number, side: Side, r: Rule, a: number, drift: boolean): Trade | null => {
    const T = times[i] + step;
    if (T < START_MS || !mailed(TF, T) || !judgedBar[i]) return null;
    if (i + NEED >= n) return null;
    const buy = side === "BUY";
    const dir = buy ? 1 : -1;
    const close = candles[i].close;
    // as ultraLevels: entry + dir * target * unit
    const tp = r.kind === "pips" ? close + dir * r.target * unit : close + dir * r.target * a;
    const tgt = r.kind === "pips" ? r.target : (r.target * a) / unit;
    const sl = r.stop === null ? null : close - dir * r.stop * unit;
    const fill = buy ? qs[i].ask.close : qs[i].bid.close;
    const pipsOf = (exit: number) => (buy ? exit - fill : fill - exit) / unit;
    const o = buy ? fine.bo : fine.ao;
    const h = buy ? fine.bh : fine.ah;
    const l = buy ? fine.bl : fine.al;
    const c = buy ? fine.bc : fine.ac;
    let f = lowerBound(fine.t, T);
    if (f >= fine.n) return null;
    const f0 = f;
    const mu = drift ? dir * DRIFT * unit : 0;
    const out = (pips: number, exit: Exit, bars: number, at: number): Trade => ({ pips, exit, bars, f5: at - f0 + 1, ms: fine.t[at] + FINE - T, tgt, stop: r.stop });
    for (let j = i + 1; j <= i + r.limit; j++) {
      const end = times[j] + step;
      const bars = j - i;
      while (f < fine.n && fine.t[f] < end) {
        const sh = mu * (f - f0 + 1);
        const of = o[f] + sh;
        const hf = h[f] + sh;
        const lf = l[f] + sh;
        if (sl !== null && (buy ? of <= sl : of >= sl)) return out(pipsOf(of), "sl", bars, f);
        if (buy ? of >= tp : of <= tp) return out(pipsOf(of), "tp", bars, f);
        const hitSl = sl !== null && (buy ? lf <= sl : hf >= sl);
        const hitTp = buy ? hf >= tp : lf <= tp;
        if (sl !== null && hitSl && hitTp) return out(pipsOf(sl), "amb", bars, f);
        if (sl !== null && hitSl) return out(pipsOf(sl), "sl", bars, f);
        if (hitTp) return out(pipsOf(tp), "tp", bars, f);
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
        return { pips: pipsOf(closePx + mu * (f - f0)), exit: "time", bars, f5: f - f0, ms: fine.t[f - 1] + FINE - T, tgt, stop: r.stop };
      }
    }
    return null;
  };

  // #164's own code (research/tphold.ts), for the check (b): now, and hold
  const refAt = (i: number, side: Side, rule: "now" | "hold", cap: number): Trade | null => {
    const T = times[i] + step;
    if (T < START_MS || !mailed(TF, T) || !judgedBar[i]) return null;
    if (i + NEED >= n) return null;
    const buy = side === "BUY";
    const lv = ultraLevels(side, candles[i].close, unit);
    const tp = lv.tps[0];
    const fill = buy ? qs[i].ask.close : qs[i].bid.close;
    const pipsOf = (exit: number) => (buy ? exit - fill : fill - exit) / unit;
    const o = buy ? fine.bo : fine.ao;
    const h = buy ? fine.bh : fine.ah;
    const l = buy ? fine.bl : fine.al;
    const c = buy ? fine.bc : fine.ac;
    const out = (pips: number, exit: Exit, bars: number): Trade => ({ pips, exit, bars, f5: 0, ms: 0, tgt: 5, stop: rule === "now" ? 10 : null });
    let f = lowerBound(fine.t, T);
    if (f >= fine.n) return null;
    for (let j = i + 1; j <= i + cap; j++) {
      if (j >= n) return null;
      const end = times[j] + step;
      const bars = j - i;
      while (f < fine.n && fine.t[f] < end) {
        if (rule === "now") {
          if (buy ? o[f] <= lv.sl : o[f] >= lv.sl) return out(pipsOf(o[f]), "sl", bars);
          if (buy ? o[f] >= tp : o[f] <= tp) return out(pipsOf(o[f]), "tp", bars);
          const hitSl = buy ? l[f] <= lv.sl : h[f] >= lv.sl;
          const hitTp = buy ? h[f] >= tp : l[f] <= tp;
          if (hitSl && hitTp) return out(pipsOf(lv.sl), "amb", bars);
          if (hitSl) return out(pipsOf(lv.sl), "sl", bars);
          if (hitTp) return out(pipsOf(tp), "tp", bars);
        } else {
          if (buy ? o[f] >= tp : o[f] <= tp) return out(pipsOf(o[f]), "tp", bars);
          if (buy ? h[f] >= tp : l[f] <= tp) return out(pipsOf(tp), "tp", bars);
        }
        f++;
      }
      if (f >= fine.n && fine.t[fine.n - 1] + FINE < end) return null;
      if (f === 0) return null;
      if (j === i + cap) return out(pipsOf(c[f - 1]), "time", bars);
    }
    return null;
  };

  // every rule on one trade; false when the data does not hold it
  const recordAt = (i: number, side: Side, keys: string[], signal: boolean): Map<string, Trade> | null => {
    const drift = DRIFTING && signal;
    const now = tradeAt(i, side, NOW_R, Number.NaN, drift);
    if (!now) return null;
    const T = times[i] + step;
    const tag = `${pair} ${iso(T)} ${side}`;
    const a = atrAt[i];
    tally(checks.atr, a > 0, () => `${tag} ATR ${a}`);
    if (!(a > 0)) return null;
    const got = new Map<string, Trade>([[NOW_RULE, now]]);
    for (const r of RULES) {
      if (r.key === NOW_RULE) continue;
      const t = tradeAt(i, side, r, a, drift);
      if (!t) return null;
      got.set(r.key, t);
    }
    if (signal) {
      let all = true;
      for (const r of EXTRAS) {
        const t = tradeAt(i, side, r, a, drift);
        if (t) got.set(r.key, t);
        else all = false;
      }
      tally(checks.extras, all, () => `${tag} a TP2 or TP3 not followed`);
    }
    // (b) against #164's own code (not under "drift": its prices are moved)
    if (!drift) {
      const refs: Array<[string, Trade | null]> = [[REF_NOW, refAt(i, side, "now", 30)], [REF_HOLD30, refAt(i, side, "hold", 30)], [REF_HOLD120, refAt(i, side, "hold", 120)]];
      for (const [key, ref] of refs) {
        const t = got.get(key)!;
        tally(checks.ref, ref !== null && same(ref, t), () => `${tag} ${key} ${t.exit} ${t.pips} ${t.bars} / #164 ${ref ? `${ref.exit} ${ref.pips} ${ref.bars}` : "none"}`);
      }
    }
    // (c1) a stop and the next wider: out at TP1 or the limit, the same
    for (const chain of C1_CHAINS) {
      for (let k = 0; k + 1 < chain.length; k++) {
        const x = got.get(chain[k])!;
        if (x.exit !== "tp" && x.exit !== "time") continue;
        const y = got.get(chain[k + 1])!;
        tally(checks.stopNest, sameFull(x, y), () => `${tag} ${chain[k]} ${x.exit} ${x.pips} ${x.bars} / ${chain[k + 1]} ${y.exit} ${y.pips} ${y.bars}`);
      }
    }
    // (c2) a target and the next wider, the stop 30: out at the stop or the
    // limit under the narrower, the same under the wider (both in one bar:
    // the same pips and bars, out at the stop or both); out at TP1 under the
    // wider, at TP1 under the narrower no later; the wider never out sooner.
    // Two levels less than 1e-9 pip apart are one level: not compared.
    const l30 = C2_L30.filter((k) => got.has(k)).sort((p, q) => got.get(p)!.tgt - got.get(q)!.tgt);
    for (const chain of [l30, ...C2_CHAINS.map((full) => full.filter((k) => got.has(k)))]) {
      for (let k = 0; k + 1 < chain.length; k++) {
        const x = got.get(chain[k])!;
        const y = got.get(chain[k + 1])!;
        if (y.tgt - x.tgt <= 1e-9) continue;
        let ok = y.f5 >= x.f5;
        if (x.exit === "sl" || x.exit === "time") ok = ok && sameFull(x, y);
        else if (x.exit === "amb") ok = ok && y.pips === x.pips && y.bars === x.bars && y.f5 === x.f5 && (y.exit === "sl" || y.exit === "amb");
        if (y.exit === "tp") ok = ok && x.exit === "tp" && x.bars <= y.bars;
        tally(checks.targetNest, ok, () => `${tag} ${chain[k]} ${x.exit} ${x.pips} ${x.bars}/${x.f5} / ${chain[k + 1]} ${y.exit} ${y.pips} ${y.bars}/${y.f5}`);
      }
    }
    // (c3) out within 30 bars: the same within 120; timed out at 30 bars:
    // out later within 120
    for (const [k30, k120] of C3_PAIRS) {
      const x = got.get(k30)!;
      const y = got.get(k120)!;
      const ok = x.exit === "time" ? y.bars > x.bars && y.f5 > x.f5 : sameFull(x, y);
      tally(checks.limitNest, ok, () => `${tag} ${k30} ${x.exit} ${x.pips} ${x.bars}/${x.f5} / ${k120} ${y.exit} ${y.pips} ${y.bars}/${y.f5}`);
    }

    const half = T < SPLIT_MS ? 0 : 1;
    // the first half for the pick: the trade's 30 bars all before SPLIT
    const pickable = half === 0 && times[i + 30] + step <= SPLIT_MS;
    const week = weekOf(T);
    for (const key of keys) {
      const full = [`${key}|${grp}`, `${key}|all`];
      if (key === "either") full.push(`either|pair ${pair}`);
      for (const k of full) {
        const tails = !k.startsWith("coin");
        const periods: Array<0 | 1 | 2> = pickable && k === "either|AB" ? [half, 2] : [half];
        for (const p of periods) {
          for (const [rk, t] of got) {
            addTo(aggOf(k, p, rk), week, t.pips, t, tails);
            if (rk !== NOW_RULE && RULE_KEYS.has(rk)) addTo(aggOf(k, p, rk + DIFF), week, t.pips - now.pips);
          }
          if (k === "either|AB" || k === "either|all") {
            for (const s of SLIPS) {
              for (const rk of PICKS) addTo(aggOf(k, p, slipKey(rk, s)), week, slipOf(got.get(rk)!, s) - slipOf(now, s));
            }
          }
        }
      }
    }
    return got;
  };

  // the coin: every close either way
  for (let i = 0; i < n; i++) {
    for (const side of ["BUY", "SELL"] as const) recordAt(i, side, ["coin", `coin ${side}`], false);
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
    const got = recordAt(sg.i, sg.side, keys, true);
    if (!got || !first) continue;
    eitherSeen.add(ek);
    trades++;
    spreads.push((qs[sg.i].ask.close - qs[sg.i].bid.close) / unit);
    // the chart's own count for each target (4-hour mid bars, no spread, no
    // limit, both in one bar the stop)
    const half = times[sg.i] + step < SPLIT_MS ? 0 : 1;
    for (const rk of [NOW_RULE, ...PICKS]) {
      const tgt = got.get(rk)!.tgt;
      const tr = followTrade(candles, sg.i, sg.side, n - 1, unit, { ...ULTRA_PAIRS, tp1: tgt, tp2: 2 * tgt, tp3: 3 * tgt });
      for (const k of [grp, "all"]) {
        const c = chartOf(k, half, rk);
        if (tr.result === "TP1") c.tp1++;
        else if (tr.result === "SL") c.sl++;
        else c.open++;
      }
    }
  }
  const atrs: number[] = [];
  for (let i = 0; i < n; i++) if (judgedBar[i] && times[i] + step < SPLIT_MS && atrAt[i] > 0) atrs.push(atrAt[i] / unit);
  coverage.push({ pair, group: grp, bars: n, judged, signals: signals.length, trades, failed: fineGot.failed + got.failed, spread: medianOf(spreads), atr: medianOf(atrs) });
  console.log(`${pair} (${grp}) ${TF}: ${n} bars, judged ${judged}, signals ${signals.length} (trades ${trades}); GMO failed ${fineGot.failed + got.failed}`);
}

// ---- the report ------------------------------------------------------------------------

const num = (x: number | null | undefined, d = 2) => (x === null || x === undefined || !Number.isFinite(x) ? "   -  " : `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(d)}`);
const pct = (a: number, b: number) => (b > 0 ? `${((100 * a) / b).toFixed(1)}%` : "-");
const ciText = (a: Agg | undefined) => {
  const w = intervalOf(a, "weeks");
  const b = intervalOf(a, "blocks");
  return `[${num(w.lo)},${num(w.hi)}] (4 wk [${num(b.lo)},${num(b.hi)}])`;
};
const checkLine = (what: string, c: Check) => `${what}: ${c.mismatched} of ${c.compared} differ${c.examples.length ? ": " + c.examples.join("; ") : ""}`;
const days = (ms: number | null) => (ms === null ? "-" : (ms / DAY).toFixed(1));
// a difference beyond the coin's (the same pairs and side), the two taken as
// independent (a rough interval)
const beyondCoin = (key: string, half: 0 | 1, series: string) => {
  const [sig, pairs] = key.split("|");
  const side = sig.endsWith("BUY") ? " BUY" : sig.endsWith("SELL") ? " SELL" : "";
  const g = statOf(aggAt(key, half, series), "blocks");
  const c = statOf(aggAt(`coin${side}|${pairs}`, half, series), "blocks");
  if (!g || !c || !Number.isFinite(g.se) || !Number.isFinite(c.se)) return null;
  const m = g.m - c.m;
  const q = tQuantile(0.975, Math.min(g.C, c.C) - 1);
  const se = Math.sqrt(g.se ** 2 + c.se ** 2);
  return { m, lo: m - q * se, hi: m + q * se };
};
const ruleText = (a: Agg | undefined, rule: string) => {
  if (!a || a.n === 0) return `  ${rule.padEnd(14)} no trades`;
  const t = tailOf(a);
  const out = (Object.keys(a.exits) as Exit[]).filter((k) => a.exits[k] > 0).map((k) => `${k} ${pct(a.exits[k], a.n)}`).join(" ");
  const done = a.exits.tp + a.exits.sl + a.exits.amb;
  return `  ${(rule + (rule === NOW_RULE ? " (now)" : "")).padEnd(20)} ${num(a.sum / a.n)} ${ciText(a)} pips/trade of ${String(a.n).padStart(5)}; won ${pct(a.wins, a.n)}, avg win ${num(a.wins ? a.winSum / a.wins : null, 1)}, avg loss ${num(a.n - a.wins ? a.lossSum / (a.n - a.wins) : null, 1)}, worst ${num(t.worst, 1)}, worst 5% from ${num(t.p5, 1)}; ${out}; TP1 first ${pct(a.exits.tp, done)} (break-even ${pct(a.be, a.beN)}), the time-outs ${num(a.exits.time ? a.exitSum.time / a.exits.time : null, 1)}; held ${days(a.msSum / a.n)} d on average`;
};
const ruleLine = (key: string, period: 0 | 1 | 2 | "full", rule: string) => {
  const a = period === "full" ? aggFull(key, rule) : aggAt(key, period, rule);
  const head = ruleText(a, rule);
  if (rule === NOW_RULE || !RULE_KEYS.has(rule)) return head;
  const d = period === "full" ? aggFull(key, rule + DIFF) : aggAt(key, period, rule + DIFF);
  if (!d) return head;
  const bc = !key.startsWith("coin") && period !== "full" && period !== 2 ? beyondCoin(key, period, rule + DIFF) : null;
  return `${head}\n  ${"".padEnd(20)} less now ${num(d.sum / d.n)} ${ciText(d)}${bc ? `; beyond the coin's ${num(bc.m)} [${num(bc.lo)},${num(bc.hi)}]` : ""}`;
};

console.log(`\n#172 the email's TP1 wider on ${TF}, ${START} .. ${iso(NOW)} (first half before ${SPLIT})${SYNTHETIC ? ` — SYNTHETIC (${SYNTH}${DRIFTING ? `, ${DRIFT} pip a 5-minute bar` : ""}), seed ${SEED}` : ""}; the stop ${STOP}; TP1 ${T_GRID.join(", ")} pips and ${K_GRID.join(", ")} × ATR(14); limits 30 and 120 bars; every rule on the trades with ${NEED} bars in the data; the pick and the call on A+B (${AB.length} pairs)`);
console.log(`candidates: ${PICKS.join(", ")}${EXCLUDED.length ? `; left out after the walks: ${EXCLUDED.join(", ")}` : ""}`);
console.log(checkLine("(a) signals against indicatorSignals", checks.signals));
console.log(checkLine(`(a2) the email's close, stop and targets against the stop 30 and TP ${ULTRA_PAIRS.tp1}/${ULTRA_PAIRS.tp2}/${ULTRA_PAIRS.tp3} (ULTRA_PAIRS)`, checks.levels));
console.log(checkLine("(a3) Q-Trend's ε against ATR(14) of the bar before", checks.eps));
console.log(checkLine("(a4) the bar's ATR(14) against it computed again from the email's start", checks.atrSeries));
console.log(checkLine(`(b) T5 S10 against #164's now, T5 none against #164's hold${DRIFTING ? " (the coin only: the signals' prices moved)" : ""}`, checks.ref));
console.log(checkLine("(c1) out at TP1 or the limit under a stop, the same under the next wider", checks.stopNest));
console.log(checkLine("(c2) a target and the next wider, the pips and ATR ones together", checks.targetNest));
console.log(checkLine("(c3) out within 30 bars the same within 120, timed out at 30 out later", checks.limitNest));
console.log(checkLine("(d) exit closes against the 4-hour bar's own", checks.closes));
console.log(checkLine("(e) trades with their ATR", checks.atr));
console.log(checkLine("(e) signals with their TP2 and TP3", checks.extras));
console.log(checkLine("(f) the bars mailed, reads at 0/4/6 against 4/6 minutes", checks.reads));
const failedReads = coverage.reduce((a, c) => a + c.failed, 0);
console.log(`(g) GMO reads that failed: ${failedReads}`);
const allDiffer = Object.values(checks).reduce((a, c) => a + c.mismatched, 0) + failedReads;

// (h) #165's numbers again
const H_ROWS: Array<[string, string, string]> = [["T5 S10 L30", "−1.28", "−1.07"], ["T5 S30 L30", "−0.61", "−0.99"], ["T5 S30 L120", "−0.62", "−1.08"], ["T5 Snone L30", "−0.33", "−0.80"], ["T5 Snone L120", "+0.25", "+0.06"]];
const H_N = [3001, 2762];
const hApplies = !SYNTHETIC && START === "2024-01-01" && SPLIT === "2025-05-19" && NOW === Date.parse("2026-09-29T14:16:25Z") && !Deno.env.get("PAIRS");
let hDiffer: number | null = null;
if (hApplies) {
  hDiffer = 0;
  const lines: string[] = [];
  for (const [rule, a0, a1] of H_ROWS) {
    const got = [0, 1].map((p) => aggAt("either|all", p as 0 | 1, rule));
    const ms = got.map((a) => (a ? num(a.sum / a.n) : "-"));
    const ns = got.map((a) => a?.n ?? 0);
    const ok = ms[0] === a0 && ms[1] === a1 && ns[0] === H_N[0] && ns[1] === H_N[1];
    if (!ok) hDiffer++;
    lines.push(`${rule} ${ms.join(" and ")} of ${ns.join(" and ")} (§8.77: ${a0} and ${a1} of ${H_N.join(" and ")})${ok ? "" : " DIFFERS"}`);
  }
  console.log(`(h) #165's numbers again, ${hDiffer} of ${H_ROWS.length} differ: ${lines.join("; ")}`);
} else console.log(`(h) #165's numbers again: not for this run`);
console.log(allDiffer + (hDiffer ?? 0) === 0 ? "EVERY CHECK 0 DIFFER" : `CHECKS DIFFER (${allDiffer + (hDiffer ?? 0)}): the numbers below are not to be read`);

// THE PICK, on the first half (the trades whose 30 bars end before SPLIT);
// THE CALL, on the second
const KEY = "either|AB";
let pick: string | null = null;
let verdict = "no signals";
let clearly = false;
const pickT: Record<string, { m: number | null; se: number | null; se4: number | null; t: number | null; rule: number | null; n: number }> = {};
if (groups.has(KEY)) {
  console.log(`\n== THE PICK: A+B, the emails' signals (either), first half less the trades reaching past ${SPLIT}; t of "rule less now" (its mean over the larger standard error, by week or by four weeks)`);
  const nowP = aggAt(KEY, 2, NOW_RULE);
  console.log(`  ${"now".padEnd(14)} ${num(nowP ? nowP.sum / nowP.n : null)} pips/trade of ${nowP?.n ?? 0}`);
  let best = -Infinity;
  for (const key of PICKS) {
    const d = aggAt(KEY, 2, key + DIFF);
    const r = aggAt(KEY, 2, key);
    const w = statOf(d, "weeks");
    const b = statOf(d, "blocks");
    const t = tOf(d);
    pickT[key] = { m: w?.m ?? null, se: w?.se ?? null, se4: b?.se ?? null, t, rule: r ? r.sum / r.n : null, n: d?.n ?? 0 };
    console.log(`  ${key.padEnd(14)} less now ${num(w?.m)} (se ${num(w?.se)} by week, ${num(b?.se)} by four weeks) t ${num(t)}; the rule ${num(r ? r.sum / r.n : null)}`);
    if (t !== null && t > best) {
      best = t;
      pick = key;
    }
  }
  if (pick) {
    const pm = aggAt(KEY, 1, pick);
    const nm = aggAt(KEY, 1, NOW_RULE);
    const d = aggAt(KEY, 1, pick + DIFF);
    const lo = lowEnd(d);
    const pmv = pm ? pm.sum / pm.n : null;
    const nmv = nm ? nm.sum / nm.n : null;
    clearly = pmv !== null && nmv !== null && pmv > nmv && lo !== null && lo > 0;
    const edge = pick === "T90 S30 L30" || pick === "A2 S30 L30" ? " (the grid's widest: a wider one was not measured)" : "";
    verdict = clearly ? `${pick} is clearly better than now for the emails' signals on A+B${edge}` : `${pick} is not clearly better than now for the emails' signals on A+B${edge}`;
    console.log(`  the pick: ${pick} (t ${num(best)})`);
    console.log(`\n== VERDICT: on the second half ${pick} ${num(pmv)} against now ${num(nmv)} (A+B, ${d?.n ?? 0} trades); the difference ${num(d ? d.sum / d.n : null)} ${ciText(d)}, its low end ${num(lo)} → ${verdict}`);
  }
}

// the second road: every candidate, Bonferroni
const K = PICKS.length;
const P_BONF = 1 - 0.025 / K;
const bonf: Record<string, { m: number | null; lo: number | null; hi: number | null; above: boolean }> = {};
if (groups.has(KEY)) {
  console.log(`\n== EVERY CANDIDATE, A+B second half, "rule less now" with a Bonferroni interval (K ${K}: t at ${P_BONF.toFixed(5)} a side; the lower of by week and by four weeks)`);
  for (const key of PICKS) {
    const d = aggAt(KEY, 1, key + DIFF);
    const lo = lowEnd(d, P_BONF);
    const hi = highEnd(d, P_BONF);
    const m = d ? d.sum / d.n : null;
    const above = lo !== null && lo > 0;
    bonf[key] = { m, lo, hi, above };
    console.log(`  ${key.padEnd(14)} ${num(m)} [${num(lo)},${num(hi)}]${above ? " — above 0 after the correction" : ""}${key === pick ? " (the pick)" : ""}`);
  }
}

// the owner's table: A+B, the emails' signals, the whole period (and each half)
const tpReach = (key: string, period: 0 | 1 | "full", rule: string, which: 0 | 1) => {
  const k = TP23.get(rule)?.[which];
  if (!k) return null;
  const a = period === "full" ? aggFull(key, k) : aggAt(key, period, k);
  return a ? pct(a.exits.tp, a.n) : null;
};
const ownerLine = (key: string, period: 0 | 1 | "full", rule: string) => {
  const a = period === "full" ? aggFull(key, rule) : aggAt(key, period, rule);
  if (!a || !a.n) return `  ${rule.padEnd(14)} no trades`;
  const d = rule === NOW_RULE ? undefined : period === "full" ? aggFull(key, rule + DIFF) : aggAt(key, period, rule + DIFF);
  const done = a.exits.tp + a.exits.sl + a.exits.amb;
  const [sig, pairs] = key.split("|");
  const halves = period === "full" ? [0, 1] as const : [period];
  const ch = { tp1: 0, sl: 0, open: 0 };
  if (sig === "either") {
    for (const h of halves) {
      const c = chart.get(`${pairs}|${h}|${rule}`);
      if (c) {
        ch.tp1 += c.tp1;
        ch.sl += c.sl;
        ch.open += c.open;
      }
    }
  }
  const tp2 = tpReach(key, period, rule, 0);
  const tp3 = tpReach(key, period, rule, 1);
  return [
    `  ${rule.padEnd(14)} ${String(a.n).padStart(5)} trades; ${num(a.sum / a.n)} ${ciText(a)} pips a trade${d ? `; less now ${num(d.sum / d.n)} ${ciText(d)}` : ""}`,
    `  ${"".padEnd(14)} TP1 first ${pct(a.exits.tp, done)} (break-even ${pct(a.be, a.beN)}); out: tp ${pct(a.exits.tp, a.n)}, sl ${pct(a.exits.sl + a.exits.amb, a.n)}, time ${pct(a.exits.time, a.n)} (those ${num(a.exits.time ? a.exitSum.time / a.exits.time : null, 1)} pips); TP1 within the first 5-minute bar ${pct(a.fast[0], a.n)}, 15 min ${pct(a.fast[1], a.n)}, an hour ${pct(a.fast[2], a.n)}, 4 hours ${pct(a.fast[3], a.n)}, a day ${pct(a.fast[4], a.n)}; held ${days(medianOf(a.held))} d (median)${tp2 ? `; TP2 ${tp2}, TP3 ${tp3}` : ""}${sig === "either" && TP23.has(rule) ? `; the chart's count: TP1 ${pct(ch.tp1, ch.tp1 + ch.sl)} (${ch.tp1} of ${ch.tp1 + ch.sl}, ${ch.open} open)` : ""}`,
  ].join("\n");
};
const OWNER_ROWS = [NOW_RULE, ...PICKS, ...L120_RULES];
for (const key of ["either|AB", "either|C", "either|all"]) {
  if (!groups.has(key)) continue;
  for (const period of ["full", 0, 1] as const) {
    console.log(`\n== THE TABLE: ${key}, ${period === "full" ? "the whole period" : period === 0 ? "first half" : "second half"}`);
    for (const rule of OWNER_ROWS) console.log(ownerLine(key, period, rule));
  }
}

// the sensitivities, on the pick
if (pick && groups.has(KEY)) {
  console.log(`\n== THE PICK (${pick}), second half, "less now" beside the call (told, not called on)`);
  for (const s of SLIPS) {
    const d = aggAt(KEY, 1, slipKey(pick, s));
    console.log(`  the stop filled ${s} pip worse: ${num(d ? d.sum / d.n : null)} ${ciText(d)}, low end ${num(lowEnd(d))}`);
  }
  for (const k of ["either BUY|AB", "either SELL|AB", "either|C", "either|all", "qtrend|AB", "ultra|AB", "strong|AB", "coin|AB"]) {
    const d = aggAt(k, 1, pick + DIFF);
    console.log(`  ${k.padEnd(16)} ${num(d ? d.sum / d.n : null)} ${ciText(d)} of ${d?.n ?? 0}`);
  }
  // each pair left out, and the pairs weighted alike
  const per = AB.map((p) => ({ p, d: aggAt(`either|pair ${p}`, 1, pick + DIFF) })).filter((x) => x.d && x.d.n > 0) as Array<{ p: string; d: Agg }>;
  const S = per.reduce((a, x) => a + x.d.sum, 0);
  const N = per.reduce((a, x) => a + x.d.n, 0);
  const lefts = per.map((x) => ({ p: x.p, m: (S - x.d.sum) / (N - x.d.n) }));
  lefts.sort((a, b) => a.m - b.m);
  if (lefts.length) console.log(`  a pair left out: ${num(lefts[0].m)} (without ${lefts[0].p}) to ${num(lefts[lefts.length - 1].m)} (without ${lefts[lefts.length - 1].p})`);
  if (per.length) console.log(`  the pairs weighted alike: ${num(per.reduce((a, x) => a + x.d.sum / x.d.n, 0) / per.length)} (${per.length} pairs)`);
  console.log(`  each pair: ${per.map((x) => `${x.p} ${num(x.d.sum / x.d.n)} of ${x.d.n}`).join(", ")}`);
}

// every candidate with the stop filled worse, second half
if (groups.has(KEY)) {
  console.log(`\n== EVERY CANDIDATE, A+B second half, "less now" with the stop filled worse (low end by week and four weeks)`);
  for (const key of PICKS) {
    console.log(`  ${key.padEnd(14)} ${SLIPS.map((s) => {
      const d = aggAt(KEY, 1, slipKey(key, s));
      return `${s} pip: ${num(d ? d.sum / d.n : null)} (low end ${num(lowEnd(d))})`;
    }).join("; ")}`);
  }
}

// every rule, each half, for the groups told
for (const key of ["either|AB", "either BUY|AB", "either SELL|AB", "either|C", "either|all", "coin|AB", "coin|all"]) {
  if (!groups.has(key)) continue;
  for (const half of [0, 1] as const) {
    console.log(`\n== ${key}, ${half === 0 ? "first" : "second"} half`);
    for (const r of RULES) console.log(ruleLine(key, half, r.key));
  }
}

console.log(`\n== the pairs`);
for (const c of coverage) console.log(`  ${c.pair.padEnd(8)} ${c.group}: ${c.trades} signal trades of ${c.signals} signals, ${c.judged} bars judged; spread paid ${num(c.spread, 1)} pips (median), 4-hour ATR(14) ${num(c.atr, 1)} pips (median, first half)`);
if (!SYNTHETIC) {
  const without = ALL_PAIRS.filter((p) => !coverage.some((c) => c.pair === p && c.judged > 0));
  console.log(`  not measured (no bar judged): ${without.join(", ") || "none"}`);
}
console.log(`\nverdict: ${verdict}`);

// ---- the numbers out, for the walks' summary (research/widetp-seeds.py) ---------------

const aggOut = (a: Agg | undefined) => {
  if (!a || !a.n) return null;
  const w = statOf(a, "weeks")!;
  const b = statOf(a, "blocks")!;
  return { n: a.n, m: w.m, se: Number.isFinite(w.se) ? w.se : null, se4: Number.isFinite(b.se) ? b.se : null, C: w.C, C4: b.C, wins: a.wins, exits: a.exits, exitSum: a.exitSum, be: a.be, beN: a.beN, fast: a.fast, bars: a.bars / a.n, ...tailOf(a) };
};
const OUT_KEYS = ["either|AB", "either|C", "either|all", "either BUY|AB", "either SELL|AB", "coin|AB", "coin|all"];
const seriesOut = (key: string, period: 0 | 1 | 2) => {
  const g = groups.get(key)?.[period];
  if (!g) return null;
  return Object.fromEntries([...g].map(([s, a]) => [s, aggOut(a)]));
};
await Deno.mkdir(OUT, { recursive: true });
await Deno.writeTextFile(
  `${OUT}/widetp${SYNTHETIC ? `-${SYNTH}-${SEED}` : ""}.json`,
  JSON.stringify({
    start: START,
    split: SPLIT,
    now: iso(NOW),
    synthetic: SYNTHETIC,
    synth: SYNTH,
    seed: SEED,
    drift: DRIFTING ? DRIFT : null,
    picks: PICKS,
    excluded: EXCLUDED,
    nowRule: NOW_RULE,
    coverage,
    checks,
    failedReads,
    allDiffer,
    hDiffer,
    pickT,
    pick,
    clearly,
    verdict,
    bonf,
    tStar: Object.fromEntries(
      OUT_KEYS.filter((k) => groups.has(k)).map((k) => [k, [0, 1, 2].map((p) => {
        const d = aggAt(k, p as 0 | 1 | 2, NOW_RULE);
        return d ? { C: statOf(d, "weeks")!.C, C4: statOf(d, "blocks")!.C } : null;
      })]),
    ),
    chart: Object.fromEntries(chart),
    groups: Object.fromEntries(OUT_KEYS.filter((k) => groups.has(k)).map((k) => [k, [0, 1, 2].map((p) => seriesOut(k, p as 0 | 1 | 2))])),
  }),
);
