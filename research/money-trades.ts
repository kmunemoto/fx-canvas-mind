// #188: the trades research/money.ts holds (docs §8.99 取引), part 1 of its
// three: which emails are trades, how each is followed, and the prices the
// account (the other parts) marks them on. Research only: nothing in the app
// reads this.
//
// THE TRADES (§8.99, fixed before any data):
//   * the set is research/stop2n.ts's "either" trades of CALL9, exactly: the
//     emails' signals (Q-Trend and ULTRA on 4 hours, mailed when a read 0, 4
//     or 6 minutes after the close may fall while the market is open), on the
//     bars the sweep judges, the two indicators' signal of one bar and side
//     one trade, 120 four-hour bars after the signal bar in the data, and
//     every exclusion stop2n.ts's recordAt makes (N and A over 0, and each of
//     its 15 rules followed to its end) — so #187's 3,958 trades again. Those
//     rules are followed here only to keep the same trades (and, LEVELS=old,
//     for #187's now, the stop 30 and TP1 20, §8.99 再現). C3 (TRY/JPY, ZAR/JPY,
//     MXN/JPY) by the same rules, for the 12-pair row only;
//   * the levels from the signal bar's mid close (the chart's, rounded), the
//     email's: the stop 13 pips, TP1/2/3 4, 10 and 16 (ULTRA_PAIRS, checked);
//   * in at the close T (a buy at the ask, a sell at the bid), followed on the
//     5-minute bars of its exit side: out at the level a bar reaches (both:
//     the stop; a bar opening past one: at that open), or at the close of the
//     30th 4-hour bar; x, the exit's time, is the end of the 5-minute bar it
//     went out in;
//   * the variants (interface.md §2): main (out whole at TP1), tp2, tp3, late
//     (tf-winrate.ts's: in at the first 5-minute bar's close, not in where its
//     exit-side close is already at a level — "passed" —, followed from the
//     next bar) and rakuten (in and out again on GMO's mid ± half Rakuten's
//     advertised spread, §8.99's schedule; GMO's own where §8.99 says GMO).
//     On the walks' "drift" and "against", a signal's prices are moved its
//     way (or against it) DRIFT pips a 5-minute bar from its first bar, as
//     stop2n.ts moves them (marks and exits both; a coin's not).
//
// THE API (for research/money.ts and its account):
//   loadStudy(cfg)          → Study: reads the bars (GMO's cache, the walks or
//                             a fixture), finds the signals, keeps #187's set,
//                             follows every variant; the coin (every judged
//                             close both ways, main levels) on the new levels
//   bookOf(study, variant, set) → Book: one variant's trades on a pair set's
//                             union grid G ("CALL9": the 9 pairs' bars; "P12":
//                             and C3's), each with its path on G; what the
//                             account is run on. A Book holds:
//       grid.g              G, every end (open + 5 min) of a 5-minute bar of
//                             a pair in play, sorted; grid.mid[p][k] pair p's
//                             mid close at g[k] (its last bar ending at or
//                             before g[k]: forward-filled), grid.own[p][k] 1
//                             where it has a bar ending at g[k]; grid.usd: the
//                             index of USD/JPY in grid.pairs (the conversion)
//       trades              Held: a Trade with gi0..giX (its g in (t0, x]),
//                             mark[k] its exit-side close at g[gi0 + k] (moved
//                             as its prices are; its pair's last close where it
//                             has no bar at that g: `stale` counts those),
//                             worst[k] the bar's worst exit-side price against
//                             it there (the stale close where no bar), shift[k]
//                             the walks' move there (null on other runs: add it
//                             to a mid to mark the trade's mid). A passed late
//                             trade has no path (hold 0). At g = x the trade is
//                             out at exitPx; mark there is its bar's close.
//       ny                  Rakuten's NY closes τ within G (21:55 UTC, 20:55
//                             in US summer time; Monday to Friday) with the grid
//                             index judged at (g == τ, or the last g before it:
//                             `exact` false) and the call's deadline (the next
//                             weekday 09:00 UTC; a Friday's the Monday's)
//       giAt(ms)            the index of the last g at or before ms (−1: none)
//       openAt(t, ms)       a forced close: t's exit-side open (moved) of its
//                             pair's first 5-minute bar opening at or after ms
//   statsOf(trades, …)      the trade-level numbers money.json's `trades` holds
//   concurrencyOf(grid, trades) the counts of trades open together on G

import type { QuoteCandle } from "../supabase/functions/track-outcomes/quotes.ts";
import { isPossiblyClosed, nyOffsetMs } from "../supabase/functions/_shared/market-hours.ts";
import type { Candle } from "../supabase/functions/analyze/indicators.ts";
import { barOpenMs } from "../supabase/functions/analyze/state.ts";
import { CHART_BARS, LIVE_PAIRS, LIVE_STEP_MS, historyRead } from "../supabase/functions/live-chart/logic.ts";
import { QT_DEFAULTS, anchoredStart, barStepMs, qTrend } from "../supabase/functions/_shared/qtrend.ts";
import { ULTRA_PAIRS, ultra } from "../supabase/functions/_shared/ultra.ts";
import { pineAtr } from "../supabase/functions/_shared/pine.ts";
import { indicatorSignals, ultraUnit } from "../supabase/functions/signal-alerts/indicators.ts";
import { DAY, HOUR, MINUTE } from "./lib.ts";
import { type Config, FINE, type Fine, lowerBound, makeLoader, toFine, upperBound } from "./money-data.ts";
import { clustered, highEnd, intervalOf, lowEnd, medianOf, quantile, weekOf } from "./money-stats.ts";

// ---- what is fixed (§8.99) ----------------------------------------------------------------

// #187's nine (the call's pairs), in §8.99's order (the gates' order)
export const CALL9 = ["USD/JPY", "EUR/JPY", "GBP/JPY", "AUD/JPY", "NZD/JPY", "CAD/JPY", "CHF/JPY", "EUR/USD", "AUD/USD"];
// low-priced: the 12-pair row only
export const C3 = ["TRY/JPY", "ZAR/JPY", "MXN/JPY"];
export type PairSet = "CALL9" | "P12";
// the order the account takes one bar's emails in: the broker's list
// (LIVE_PAIRS), the pairs in play only
export const admissionOrder = (set: PairSet): string[] => (LIVE_PAIRS as readonly string[]).filter((p) => CALL9.includes(p) || (set === "P12" && C3.includes(p)));
const ADMIT_RANK = new Map(admissionOrder("P12").map((p, k) => [p, k]));
// #187's numbers this run must hold on the data (§8.99 確かめ): the trades,
// each pair's (CALL9 order) and each half's; LEVELS=old, now's means
export const WANT = { n: 3958, perPair: [434, 447, 433, 433, 447, 435, 447, 437, 445], halves: [2049, 1909], old: [-0.6018, -0.8298, -0.7117], coin: 75186 };
// the email's levels (#192): the stop 13 pips, TP1/2/3 4, 10 and 16
export const SL = 13;
export const TPS = [4, 10, 16] as const;
if (ULTRA_PAIRS.sl !== SL || ULTRA_PAIRS.tp1 !== TPS[0] || ULTRA_PAIRS.tp2 !== TPS[1] || ULTRA_PAIRS.tp3 !== TPS[2]) throw new Error("ULTRA_PAIRS is not 13 and 4/10/16: the email has moved (§8.99 fixes them)");
// the levels before #192 (#187's now), for LEVELS=old
const OLD = { sl: 30, tp: 20 };
const TF = "4h";
// every trade with its 120 four-hour bars in the data (#187's)
const NEED = 120;
// out at the close of this 4-hour bar after the signal's, at the latest
const LIMIT = 30;
// when the sweep reads a 4-hour chart, minutes after its close (#171): a
// signal is mailed if one of them falls while the market may be open
const READ_AFTER = [0, 4, 6];
const mailed = (closeMs: number): boolean => READ_AFTER.some((m) => !isPossiblyClosed(closeMs + m * MINUTE));
// the sweep's window (signal-alerts HISTORY_BARS, anchoredStart's)
const WINDOW = 600;
// bars checked against indicatorSignals besides every bar with a signal
const CHECK_EVERY = 13;
export const iso = (ms: number) => new Date(ms).toISOString();

// ---- the checks ----------------------------------------------------------------------------

export const newCheck = () => ({ compared: 0, mismatched: 0, examples: [] as string[] });
export type Check = ReturnType<typeof newCheck>;
export const tally = (c: Check, ok: boolean, example: () => string) => {
  c.compared++;
  if (!ok) {
    c.mismatched++;
    if (c.examples.length < 10) c.examples.push(example());
  }
};

// ---- the types -------------------------------------------------------------------------------

export type Side = "BUY" | "SELL";
export type Exit = "tp" | "sl" | "amb" | "time";
export type Variant = "main" | "tp2" | "tp3" | "late" | "rakuten";
export const VARIANTS: Variant[] = ["main", "tp2", "tp3", "late", "rakuten"];

// one pair's bars
export interface PairData {
  pair: string;
  group: "CALL9" | "C3";
  // a pip (0.01 on a yen pair, 0.0001 on a dollar pair) and the chart's decimals
  unit: number;
  digits: number;
  // a dollar pair: its yen at USD/JPY's mid
  usd: boolean;
  // GMO's 5-minute bars, and the same with Rakuten's advertised spread about
  // GMO's mid (each bar's bid and ask; GMO's own where §8.99 keeps GMO's)
  fine: Fine;
  rak: Fine;
  // the 4-hour bars: open times, the chart's candles (mid, rounded), GMO's quotes
  times: Float64Array;
  step: number;
  candles: Candle[];
  qs: QuoteCandle[];
  failed: number;
}

// one email: a pair, a bar and a side (or, rules "coin", the yardstick's entry)
export interface Signal {
  id: string;
  pair: string;
  group: "CALL9" | "C3";
  // the signal bar's open and close (T: the email's close)
  barOpen: number;
  T: number;
  side: Side;
  dir: 1 | -1;
  rules: "qtrend" | "ultra" | "qtrend+ultra" | "coin";
  // the bar's index among its pair's 4-hour bars
  i: number;
  half: 0 | 1;
  week: number;
  // the bar's mid close (the chart's: the levels are from it), and GMO's bid and ask closes
  close: number;
  bidClose: number;
  askClose: number;
  // #187's now (the stop 30, TP1 20) on it, pips (LEVELS=old); null in a fixture
  oldPips: number | null;
}

// one signal followed one way
export interface Trade {
  sig: Signal;
  variant: Variant;
  pd: PairData;
  // the bars it is followed on (pd.fine, or pd.rak for "rakuten")
  book: Fine;
  fill: number;
  sl: number;
  tp: number;
  // held after t0 (T; late: its fill bar's open), filled at entryG (T; late: that bar's end)
  t0: number;
  entryG: number;
  exit: Exit | "passed";
  // its pair's first 5-minute bar at or after T, and the bar it went out in (−1: passed)
  f0: number;
  fx: number;
  exitOpen: number;
  x: number;
  exitPx: number;
  pips: number;
  atOpen: boolean;
  // the walks' move, price a 5-minute bar: bar f's prices moved mu × (f − f0 + 1)
  mu: number;
  // half the spread paid at the entry, pips
  h: number;
  // (t0, x]: the calendar time, the weekends (Sunday 21:00 UTC) and Rakuten's
  // NY closes passed (t0 < τ < x: held through it; a trade out in the bar
  // ending at τ is out by it), and the swap days (a Wednesday's close 3)
  calMs: number;
  weekend: number;
  nightsNy: number;
  swapDays: number;
}

// a trade with its path on a grid
export interface Held extends Trade {
  pi: number;
  gi0: number;
  giX: number;
  hold: number;
  mark: Float64Array;
  worst: Float64Array;
  shift: Float64Array | null;
  stale: number;
}

export interface Grid {
  set: PairSet;
  pairs: string[];
  g: Float64Array;
  // per pair (as `pairs`): the index of its last 5-minute bar ending at or
  // before each g (−1: none yet), 1 where that bar ends at g, its mid close
  last: Int32Array[];
  own: Uint8Array[];
  mid: Float64Array[];
  usd: number;
}

export interface NyClose {
  tau: number;
  // the call's deadline: the next weekday after τ's UTC date, 09:00 UTC
  deadline: number;
}

export interface Book {
  set: PairSet;
  variant: Variant;
  grid: Grid;
  trades: Held[];
  ny: Array<NyClose & { gi: number; exact: boolean }>;
  giAt: (ms: number) => number;
  openAt: (t: Held, ms: number) => { f: number; at: number; px: number } | null;
}

export interface Study {
  cfg: Config;
  pairs: Map<string, PairData>;
  // CALL9's and C3's, by T, then the admission order, a buy before a sell
  signals: Signal[];
  // each variant's trades, in `signals`' order (empty with LEVELS=old)
  trades: Record<Variant, Trade[]>;
  coin: Trade[];
  grids: Partial<Record<PairSet, Grid>>;
  ny: NyClose[];
  checks: Record<string, Check>;
  failedReads: number;
  // the closes judged and the signals found, per pair; those #187's
  // exclusions left out (no N or A; a rule not followed to its end)
  cover: Array<{ pair: string; bars: number; judged: number; signals: number; trades: number; noNA: number; unheld: number; failed: number }>;
}

// ---- Rakuten's advertised spread (§8.99 説明用の行 楽天の広告のスプレッド) ---------------

const at = (s: string) => Date.parse(s);
// in JST as §8.99 gives them; [start, end)
const RK_USDJPY_FROM = at("2025-03-06T07:10:00+09:00");
const RK_UNKNOWN = [at("2024-08-14T06:10:00+09:00"), at("2025-02-05T07:10:00+09:00")];
const RK_CAMPAIGN = [at("2026-07-13T07:00:00+09:00"), at("2026-08-08T05:55:00+09:00")];
const RK_NEW = at("2026-09-14T07:00:00+09:00");
// JST calendar days left at GMO's
const RK_EXCLUDED = new Set(["2024-11-11", "2024-11-28", "2026-06-19"]);
const RK_STANDARD: Record<string, number> = { "EUR/JPY": 0.5, "AUD/JPY": 0.6, "NZD/JPY": 1.2, "CAD/JPY": 1.7, "CHF/JPY": 1.8, "EUR/USD": 0.4, "AUD/USD": 0.9 };
const RK_CAMPAIGN_S: Record<string, number> = { "EUR/JPY": 0.4, "AUD/JPY": 0.5, "NZD/JPY": 0.7, "CAD/JPY": 0.6, "CHF/JPY": 0.8, "EUR/USD": 0.3, "AUD/USD": 0.4 };
const RK_NEW_S: Record<string, number> = { "EUR/JPY": 0.4, "AUD/JPY": 0.5, "NZD/JPY": 0.6, "CAD/JPY": 0.6, "CHF/JPY": 0.8, "EUR/USD": 0.3, "AUD/USD": 0.4 };
const JST = 9 * HOUR;
// Rakuten's advertised spread at `ms` (銭 on a yen pair, pips on a dollar
// pair: either way pips), or null where §8.99 keeps GMO's own: before
// 2025-03-06 07:10 JST on USD/JPY, the unknown months on the rest, GBP/JPY
// (advertised "-"), the three days, and the pairs §8.99 gives no schedule for (C3)
export const rakutenSpread = (pair: string, ms: number): number | null => {
  if (RK_EXCLUDED.has(new Date(ms + JST).toISOString().slice(0, 10))) return null;
  if (pair === "USD/JPY") {
    if (ms < RK_USDJPY_FROM) return null;
    const h = new Date(ms + JST).getUTCHours();
    return h >= 3 && h < 9 ? 3.8 : 0.2;
  }
  if (!(pair in RK_STANDARD)) return null;
  if (ms >= RK_UNKNOWN[0] && ms < RK_UNKNOWN[1]) return null;
  if (ms >= RK_NEW) return RK_NEW_S[pair];
  if (ms >= RK_CAMPAIGN[0] && ms < RK_CAMPAIGN[1]) return RK_CAMPAIGN_S[pair];
  return RK_STANDARD[pair];
};
// the 5-minute bars again at GMO's mid ± half Rakuten's spread, by each bar's
// open (each of the open, high, low and close: the bid's and the ask's halved)
const SIDES = [["bo", "ao"], ["bh", "ah"], ["bl", "al"], ["bc", "ac"]] as const;
const rakutenFine = (pair: string, f: Fine, unit: number): Fine => {
  const r: Fine = { n: f.n, t: f.t, bo: new Float64Array(f.n), bh: new Float64Array(f.n), bl: new Float64Array(f.n), bc: new Float64Array(f.n), ao: new Float64Array(f.n), ah: new Float64Array(f.n), al: new Float64Array(f.n), ac: new Float64Array(f.n) };
  for (let k = 0; k < f.n; k++) {
    const s = rakutenSpread(pair, f.t[k]);
    for (const [b, a] of SIDES) {
      if (s === null) {
        r[b][k] = f[b][k];
        r[a][k] = f[a][k];
      } else {
        const mid = (f[b][k] + f[a][k]) / 2;
        r[b][k] = mid - (s * unit) / 2;
        r[a][k] = mid + (s * unit) / 2;
      }
    }
  }
  return r;
};

// ---- following a trade (stop2n.ts tradeAt's walk) --------------------------------------------

interface Out {
  kind: Exit;
  f: number;
  px: number;
  atOpen: boolean;
}
// the 5-minute bars of `fine` from `from` on, through the end of 4-hour bar
// i + limit: out at a level (stop first), or at that bar's close; null where
// the data ends first (as tradeAt). Bar f's prices moved mu × (f − f0 + 1).
// `closes`: the time-out's close against the 4-hour bar's own (GMO's bars only)
const walk = (pd: PairData, fine: Fine, i: number, from: number, f0: number, buy: boolean, sl: number | null, tp: number, limit: number, mu: number, closes: Check | null): Out | null => {
  const o = buy ? fine.bo : fine.ao;
  const h5 = buy ? fine.bh : fine.ah;
  const l5 = buy ? fine.bl : fine.al;
  const c = buy ? fine.bc : fine.ac;
  let f = from;
  for (let j = i + 1; j <= i + limit; j++) {
    if (j >= pd.times.length) return null;
    const end = pd.times[j] + pd.step;
    while (f < fine.n && fine.t[f] < end) {
      const sh = mu * (f - f0 + 1);
      const of = o[f] + sh;
      const hf = h5[f] + sh;
      const lf = l5[f] + sh;
      if (sl !== null && (buy ? of <= sl : of >= sl)) return { kind: "sl", f, px: of, atOpen: true };
      if (buy ? of >= tp : of <= tp) return { kind: "tp", f, px: of, atOpen: true };
      const hitSl = sl !== null && (buy ? lf <= sl : hf >= sl);
      const hitTp = buy ? hf >= tp : lf <= tp;
      if (sl !== null && hitSl && hitTp) return { kind: "amb", f, px: sl, atOpen: false };
      if (sl !== null && hitSl) return { kind: "sl", f, px: sl, atOpen: false };
      if (hitTp) return { kind: "tp", f, px: tp, atOpen: false };
      f++;
    }
    if (f >= fine.n && fine.t[fine.n - 1] + FINE < end) return null;
    if (f === 0) return null;
    if (j === i + limit) {
      if (closes) {
        const own = buy ? pd.qs[j].bid.close : pd.qs[j].ask.close;
        tally(closes, Math.abs(c[f - 1] - own) <= pd.unit / 1000, () => `${pd.pair} ${iso(pd.times[j])} ${buy ? "BUY" : "SELL"} ${c[f - 1]}/${own}`);
      }
      return { kind: "time", f: f - 1, px: c[f - 1] + mu * (f - f0), atOpen: false };
    }
  }
  return null;
};

// #187's 15 rules (stop2n.ts RULES: TP1 20; the stop 30 pips, 2N, 2A, 1N,
// 3N, 1A, 3A and none, within 30 bars; the stopped ones within 120 too). A
// trade is #187's when every one of them is followed to its end.
type Stop187 = "pips" | "N" | "A" | "none";
const RULES_187: Array<{ stop: Stop187; k: number; limit: number }> = [
  { stop: "pips", k: 30, limit: 30 },
  { stop: "N", k: 2, limit: 30 },
  { stop: "A", k: 2, limit: 30 },
  { stop: "N", k: 1, limit: 30 },
  { stop: "N", k: 3, limit: 30 },
  { stop: "A", k: 1, limit: 30 },
  { stop: "A", k: 3, limit: 30 },
  { stop: "none", k: 0, limit: 30 },
  ...([["pips", 30], ["N", 2], ["A", 2], ["N", 1], ["N", 3], ["A", 1], ["A", 3]] as Array<[Stop187, number]>).map(([stop, k]) => ({ stop, k, limit: 120 })),
];
if (RULES_187.length !== 15) throw new Error("not #187's 15 rules");
const roundTo = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;

// the weekends, Rakuten's NY closes and the swap days in (t0, x)
const tausOf = (ny: NyClose[]) => {
  const taus = Float64Array.from(ny.map((c) => c.tau));
  // swap days to each close: a Wednesday's (UTC) three
  const cum = new Float64Array(taus.length + 1);
  for (let k = 0; k < taus.length; k++) cum[k + 1] = cum[k] + (new Date(taus[k]).getUTCDay() === 3 ? 3 : 1);
  return (t0: number, x: number) => {
    const a = upperBound(taus, t0);
    const b = lowerBound(taus, x);
    return { nights: Math.max(0, b - a), swap: Math.max(0, cum[b] - cum[a]) };
  };
};

// Rakuten's NY closes (§8.99 追証: 06:55 JST in US standard time, 05:55 in
// US summer time; the US rule as market-hours.ts nyOffsetMs), every weekday.
// `plantSummer` (the planted nysummer): the summer's at 21:55 UTC too
export const nyClosesBetween = (fromMs: number, toMs: number, plantSummer = false): NyClose[] => {
  const out: NyClose[] = [];
  for (let d = Math.floor(fromMs / DAY) * DAY; d <= toMs; d += DAY) {
    const wd = new Date(d).getUTCDay();
    if (wd === 0 || wd === 6) continue;
    const summer = !plantSummer && nyOffsetMs(d + 21 * HOUR) === -4 * HOUR;
    out.push({ tau: d + (summer ? 20 : 21) * HOUR + 55 * MINUTE, deadline: d + (wd === 5 ? 3 : 1) * DAY + 9 * HOUR });
  }
  return out;
};

// one signal followed one way (null where the data ends before it is out)
const follow = (cfg: Config, sig: Signal, pd: PairData, variant: Variant, mu: number, between: ReturnType<typeof tausOf>, closes: Check | null): Trade | null => {
  const buy = sig.side === "BUY";
  const dir = sig.dir;
  const unit = pd.unit;
  const fine = pd.fine;
  const sl = sig.close - dir * SL * unit;
  const k = variant === "tp2" ? 1 : variant === "tp3" ? 2 : 0;
  const tp = sig.close + dir * TPS[k] * unit;
  const f0 = lowerBound(fine.t, sig.T);
  if (f0 >= fine.n) return null;
  let book = fine;
  let fill = buy ? sig.askClose : sig.bidClose;
  let h = (sig.askClose - sig.bidClose) / 2 / unit;
  let t0 = sig.T;
  let from = f0;
  if (variant === "rakuten") {
    book = pd.rak;
    const s = rakutenSpread(pd.pair, sig.T);
    if (s !== null) {
      fill = (sig.askClose + sig.bidClose) / 2 + (dir * s * unit) / 2;
      h = s / 2;
    }
  }
  const base = { sig, variant, pd, book, sl, tp, f0, mu };
  if (variant === "late") {
    // five minutes late (tf-winrate.ts): the first 5-minute bar's close, the
    // email's levels as they are; not in where its exit side is already at one
    const e = f0;
    fill = (buy ? fine.ac[e] : fine.bc[e]) + mu;
    const now = (buy ? fine.bc[e] : fine.ac[e]) + mu;
    h = (fine.ac[e] - fine.bc[e]) / 2 / unit;
    t0 = fine.t[e];
    if (buy ? now >= tp || now <= sl : now <= tp || now >= sl) {
      return { ...base, fill, t0, entryG: t0 + FINE, exit: "passed", fx: -1, exitOpen: Number.NaN, x: Number.NaN, exitPx: Number.NaN, pips: Number.NaN, atOpen: false, h, calMs: Number.NaN, weekend: 0, nightsNy: 0, swapDays: 0 };
    }
    from = e + 1;
  }
  const out = walk(pd, book, sig.i, from, f0, buy, sl, tp, LIMIT, mu, variant === "rakuten" ? null : closes);
  if (!out) return null;
  let fx = out.f;
  // the planted error that lives in the following (interface.md §8): every
  // exit a 5-minute bar later, at the same price
  if (cfg.plant === "exitlate" && fx + 1 < book.n) fx++;
  const x = book.t[fx] + FINE;
  const span = between(t0, x);
  return { ...base, fill, t0, entryG: variant === "late" ? t0 + FINE : sig.T, exit: out.kind, fx, exitOpen: book.t[fx], x, exitPx: out.px, pips: (buy ? out.px - fill : fill - out.px) / unit, atOpen: out.atOpen, h, calMs: x - t0, weekend: weekOf(x) - weekOf(t0), nightsNy: span.nights, swapDays: span.swap };
};

// ---- the study --------------------------------------------------------------------------------

const csvSignals = async (dir: string): Promise<Array<Record<string, string>>> => {
  const lines = (await Deno.readTextFile(`${dir}/signals.csv`)).split("\n").filter((l) => l.trim());
  const head = lines[0].split(",");
  return lines.slice(1).map((l) => Object.fromEntries(l.split(",").map((v, k) => [head[k], v])));
};

export const loadStudy = async (cfg: Config): Promise<Study> => {
  const { load, forget } = makeLoader(cfg);
  const checks = {
    signals: newCheck(), // (a) the signals against the emails' own function
    levels: newCheck(), // (a2) its close, stop and targets against 13 and 4/10/16
    closes: newCheck(), // (d) a time-out at the 4-hour bar's own close
    placement: newCheck(), // (s) each exit at its level, or past it at an open
    fixture: newCheck(), // a fixture's signals on its bars, and followed to their end
  };
  const fixtureRows = cfg.fixture ? await csvSignals(cfg.fixture) : [];
  const fixtureJson = cfg.fixture ? JSON.parse(await Deno.readTextFile(`${cfg.fixture}/fixture.json`)) as { pairs: string[]; digits?: Record<string, number> } : null;
  const pairsInPlay = fixtureJson ? fixtureJson.pairs : [...CALL9, ...C3];
  for (const p of pairsInPlay) if (!CALL9.includes(p) && !C3.includes(p)) throw new Error(`${p} is not one of §8.99's pairs`);
  const pairs = new Map<string, PairData>();
  const signals: Signal[] = [];
  const coinSigs: Signal[] = [];
  const cover: Study["cover"] = [];
  let failedReads = 0;
  const startYear = new Date(cfg.startMs).getUTCFullYear();
  const old = cfg.levels === "old";

  for (const pair of pairsInPlay) {
    const group = CALL9.includes(pair) ? "CALL9" : "C3";
    const unit = ultraUnit(pair);
    const fineGot = await load(pair, "5min", cfg.fixture ? 0 : cfg.startMs - 5 * DAY);
    const fine = toFine(fineGot.quotes);
    const step = LIVE_STEP_MS[TF];
    const got = await load(pair, TF, cfg.fixture ? 0 : Date.UTC(startYear - 1, 0, 1) - 9 * HOUR);
    const read = historyRead(pair, TF, got.quotes, cfg.now);
    const candles = read.candles;
    const digits = read.decimals;
    const byOpen = new Map(got.quotes.map((q) => [barOpenMs(q.datetime), q]));
    const n = candles.length;
    const times = new Float64Array(n);
    candles.forEach((c, i) => (times[i] = barOpenMs(c.datetime)));
    const qs = Array.from(times, (t) => byOpen.get(t)!);
    if (qs.some((q) => !q)) throw new Error(`${pair}: a chart bar without its quote`);
    const pd: PairData = { pair, group, unit, digits, usd: !pair.includes("JPY"), fine, rak: rakutenFine(pair, fine, unit), times, step, candles, qs, failed: fineGot.failed + got.failed };
    pairs.set(pair, pd);
    const sigOf = (i: number, side: Side, rules: Signal["rules"], oldPips: number | null): Signal => {
      const T = times[i] + step;
      return { id: `${pair}|${iso(T)}|${side}`, pair, group, barOpen: times[i], T, side, dir: side === "BUY" ? 1 : -1, rules, i, half: T < cfg.splitMs ? 0 : 1, week: weekOf(T), close: candles[i].close, bidClose: qs[i].bid.close, askClose: qs[i].ask.close, oldPips };
    };

    if (cfg.fixture) {
      // a hand example: its own table of signals, nothing generated, no gates
      if (fixtureJson?.digits && fixtureJson.digits[pair] !== undefined) tally(checks.fixture, fixtureJson.digits[pair] === digits, () => `${pair} digits ${fixtureJson.digits![pair]} / the chart's ${digits}`);
      const index = new Map(Array.from(times, (t, i) => [t, i]));
      let k = 0;
      for (const r of fixtureRows.filter((r) => r.pair === pair)) {
        const i = index.get(Date.parse(r.bar_open));
        tally(checks.fixture, i !== undefined && Date.parse(r.T) === Date.parse(r.bar_open) + step && (r.side === "BUY" || r.side === "SELL"), () => `${r.id}: no 4-hour bar at ${r.bar_open}, or T not its close`);
        if (i === undefined) continue;
        const s = sigOf(i, r.side as Side, r.rules as Signal["rules"], null);
        s.group = r.group === "C3" ? "C3" : "CALL9";
        signals.push(s);
        k++;
      }
      failedReads += pd.failed;
      forget(pair);
      cover.push({ pair, bars: n, judged: 0, signals: k, trades: k, noNA: 0, unheld: 0, failed: pd.failed });
      console.log(`${pair} (${group}) ${TF}: ${n} bars, 5-minute bars ${fine.n}; the fixture's signals ${k}`);
      continue;
    }

    // the daily bars (the chart's: mid, rounded, closed by END) and the
    // Turtles' N on them: only for #187's exclusions
    const dayGot = await load(pair, "1day", Date.UTC(startYear - 1, 0, 1) - 9 * HOUR);
    const days = historyRead(pair, "1day", dayGot.quotes, cfg.now).candles;
    const dTimes = new Float64Array(days.length);
    days.forEach((c, i) => (dTimes[i] = barOpenMs(c.datetime)));
    const nSeries = pineAtr(days, 20);
    pd.failed += dayGot.failed;
    failedReads += pd.failed;
    // the newest daily bar closed by T (its open + 24 hours at or before T)
    const nAt = (T: number): number => {
      const k = lowerBound(dTimes, T - DAY + 1) - 1;
      return k >= 0 ? nSeries[k] ?? Number.NaN : Number.NaN;
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
    // ATR(14) at each bar judged, on the bars from the bar's own start (A)
    const atrAt = new Float64Array(n).fill(Number.NaN);
    const found: Array<{ i: number; rule: "qtrend" | "ultra"; side: Side; strong: boolean }> = [];
    let seg: { s: number; from: number; to: number } | null = null;
    const flush = () => {
      if (!seg) return;
      const bars = candles.slice(seg.s, seg.to + 1);
      const qt = qTrend(bars, QT_DEFAULTS, bars.length - 1);
      for (const x of qt.signals) {
        const i = seg.s + x.i;
        if (i >= seg.from && i <= seg.to) found.push({ i, rule: "qtrend", side: x.side, strong: x.strong });
      }
      const ul = ultra(bars, bars.length - 1, unit);
      for (const tr of ul.trades) {
        const i = seg.s + tr.i;
        if (i >= seg.from && i <= seg.to) found.push({ i, rule: "ultra", side: tr.side, strong: false });
      }
      const atr = pineAtr(bars, QT_DEFAULTS.atrPeriod);
      for (let k = seg.from; k <= seg.to; k++) atrAt[k] = atr[k - seg.s] ?? Number.NaN;
      seg = null;
    };
    let judged = 0;
    for (let i = Math.max(0, lowerBound(times, cfg.startMs - step)); i < n; i++) {
      if (times[i] + step < cfg.startMs) continue;
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

    // (a), (a2): the signals and their levels against the emails' own
    // function, on every 13th bar and every bar with a signal (stop2n.ts's)
    const mine = new Map<number, string[]>();
    for (const s of found) mine.set(s.i, [...(mine.get(s.i) ?? []), `${s.rule}:${s.side}:${s.strong ? "S" : "-"}`]);
    const toCheck = new Set<number>(found.map((s) => s.i));
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
        const ok = x.close === c && x.sl === c - dir * SL * unit && x.tps !== null && x.tps[0] === c + dir * TPS[0] * unit && x.tps[1] === c + dir * TPS[1] * unit && x.tps[2] === c + dir * TPS[2] * unit;
        tally(checks.levels, ok, () => `${pair} ${iso(times[i])} ${x.rule} ${x.side} close ${x.close}/${c} sl ${x.sl} tps ${x.tps?.join("/")}`);
      }
    }

    // stop2n.ts's recordAt: is the trade at bar i one of #187's? (tradeAt's
    // own: closed from START, mailed, judged, 120 bars after it; then N and A
    // over 0 and each of the 15 rules followed to its end.) Its now's pips
    // (the stop 30, TP1 20) beside, or null when not kept.
    let noNA = 0;
    let unheld = 0;
    const kept187 = (i: number, side: Side, mu: number): number | null => {
      const T = times[i] + step;
      if (T < cfg.startMs || !mailed(T) || !judgedBar[i]) return null;
      if (i + NEED >= n) return null;
      const f0 = lowerBound(fine.t, T);
      if (f0 >= fine.n) return null;
      const buy = side === "BUY";
      const dir = buy ? 1 : -1;
      const close = candles[i].close;
      const tp = close + dir * OLD.tp * unit;
      const fill = buy ? qs[i].ask.close : qs[i].bid.close;
      let nowPips = Number.NaN;
      const N = nAt(T);
      const A = atrAt[i];
      for (const [k, r] of RULES_187.entries()) {
        const sl = r.stop === "none" ? null : r.stop === "pips" ? close - dir * r.k * unit : roundTo(close - dir * r.k * (r.stop === "N" ? N : A), digits);
        const out = walk(pd, fine, i, f0, f0, buy, sl, tp, r.limit, mu, checks.closes);
        if (!out) {
          unheld++;
          return null;
        }
        if (k === 0) {
          nowPips = (buy ? out.px - fill : fill - out.px) / unit;
          // after now, as recordAt: N and A over 0
          if (!(N > 0 && A > 0)) {
            noNA++;
            return null;
          }
        }
      }
      return nowPips;
    };

    // the trades: the signals of one bar and side as one trade (stop2n.ts's
    // either), those #187 kept; the walks move a signal's prices
    const bySide = new Map<string, { i: number; side: Side; rules: Set<string> }>();
    for (const s of found) {
      const key = `${s.i}:${s.side}`;
      const e = bySide.get(key) ?? { i: s.i, side: s.side, rules: new Set<string>() };
      e.rules.add(s.rule);
      bySide.set(key, e);
    }
    let trades = 0;
    for (const e of bySide.values()) {
      const mu = cfg.drift * (e.side === "BUY" ? 1 : -1) * unit;
      const nowPips = kept187(e.i, e.side, mu);
      if (nowPips === null) continue;
      const rules = e.rules.has("qtrend") && e.rules.has("ultra") ? "qtrend+ultra" : e.rules.has("qtrend") ? "qtrend" : "ultra";
      signals.push(sigOf(e.i, e.side, rules, nowPips));
      trades++;
    }
    // what #187's exclusions left out of the signals (the coin's apart)
    const tradesNoNA = noNA;
    const tradesUnheld = unheld;
    // the coin (§8.99 物差し): every judged close of CALL9 both ways, the
    // same exclusions (as stop2n.ts's coin), not moved by the walks
    if (!old && group === "CALL9") {
      for (let i = 0; i < n; i++) {
        for (const side of ["BUY", "SELL"] as const) {
          if (kept187(i, side, 0) !== null) coinSigs.push(sigOf(i, side, "coin", null));
        }
      }
    }
    forget(pair);
    cover.push({ pair, bars: n, judged, signals: found.length, trades, noNA: tradesNoNA, unheld: tradesUnheld, failed: pd.failed });
    console.log(`${pair} (${group}) ${TF}: ${n} bars, judged ${judged}, signals ${found.length}, trades ${trades}; GMO failed ${pd.failed}`);
  }

  // by T, then the broker's order, a buy before a sell
  const order = (a: Signal, b: Signal) => a.T - b.T || ADMIT_RANK.get(a.pair)! - ADMIT_RANK.get(b.pair)! || (a.side === b.side ? 0 : a.side === "BUY" ? -1 : 1);
  signals.sort(order);
  coinSigs.sort(order);
  const lastTime = cfg.now + 40 * DAY;
  const ny = nyClosesBetween(cfg.startMs - 7 * DAY, lastTime, cfg.plant === "nysummer");
  const between = tausOf(ny);
  const trades = Object.fromEntries(VARIANTS.map((v) => [v, [] as Trade[]])) as Record<Variant, Trade[]>;
  const coin: Trade[] = [];
  const grids: Study["grids"] = {};
  if (!old) {
    for (const v of VARIANTS) {
      for (const s of signals) {
        const pd = pairs.get(s.pair)!;
        const t = follow(cfg, s, pd, v, cfg.drift * s.dir * pd.unit, between, checks.closes);
        if (cfg.fixture) tally(checks.fixture, t !== null, () => `${s.id} ${v}: the fixture's bars end before it is out`);
        if (!t) throw new Error(`${s.id} ${v}: not followed to its end (a #187 trade should be)`);
        trades[v].push(t);
      }
    }
    // the planted +1 pip: the first trade's main (interface.md §8 pipplus)
    if (cfg.plant === "pipplus" && trades.main.length) {
      const t = trades.main[0];
      t.exitPx += t.sig.dir * t.pd.unit;
      t.pips += 1;
    }
    for (const s of coinSigs) {
      const t = follow(cfg, s, pairs.get(s.pair)!, "main", 0, between, checks.closes);
      if (!t) throw new Error(`${s.id} coin: not followed to its end`);
      coin.push(t);
    }
    // (s) each exit at its level: within a bar at the level's price; at an
    // open at or past it; a time-out at the bar's close (moved as its prices)
    for (const v of VARIANTS) {
      for (const t of trades[v]) {
        if (t.exit === "passed") continue;
        const buy = t.sig.dir === 1;
        const fx = t.fx;
        let ok: boolean;
        if (t.exit === "amb" || (t.exit === "sl" && !t.atOpen)) ok = t.exitPx === t.sl;
        else if (t.exit === "tp" && !t.atOpen) ok = t.exitPx === t.tp;
        else if (t.exit === "sl") ok = buy ? t.exitPx <= t.sl : t.exitPx >= t.sl;
        else if (t.exit === "tp") ok = buy ? t.exitPx >= t.tp : t.exitPx <= t.tp;
        else ok = Math.abs(t.exitPx - ((buy ? t.book.bc[fx] : t.book.ac[fx]) + t.mu * (fx - t.f0 + 1))) <= 1e-12;
        tally(checks.placement, ok, () => `${t.sig.id} ${v} ${t.exit} at ${t.exitPx} (sl ${t.sl}, tp ${t.tp})${t.atOpen ? " (open)" : ""}`);
      }
    }
    const inPlay = (set: PairSet) => [...pairs.values()].filter((p) => p.group === "CALL9" || set === "P12");
    grids.CALL9 = buildGrid("CALL9", inPlay("CALL9"), cfg.startMs, cfg.now);
    if ([...pairs.values()].some((p) => p.group === "C3")) grids.P12 = buildGrid("P12", inPlay("P12"), cfg.startMs, cfg.now);
  }
  return { cfg, pairs, signals, trades, coin, grids, ny, checks, failedReads, cover };
};

// ---- the union grid G and the paths on it ----------------------------------------------------------

// every end of a 5-minute bar of a pair in play, from START to END; each
// pair's last bar at each g, whether it ends there, and its mid close
const buildGrid = (set: PairSet, pds: PairData[], fromMs: number, toMs: number): Grid => {
  const order = admissionOrder(set).filter((p) => pds.some((d) => d.pair === p));
  const byPair = order.map((p) => pds.find((d) => d.pair === p)!);
  const ends: number[] = [];
  for (const d of byPair) for (let k = 0; k < d.fine.n; k++) {
    const g = d.fine.t[k] + FINE;
    if (g >= fromMs && g <= toMs) ends.push(g);
  }
  const sorted = Float64Array.from(ends).sort();
  let m = 0;
  for (let k = 0; k < sorted.length; k++) if (k === 0 || sorted[k] !== sorted[k - 1]) sorted[m++] = sorted[k];
  const g = sorted.slice(0, m);
  const last: Int32Array[] = [];
  const own: Uint8Array[] = [];
  const mid: Float64Array[] = [];
  for (const d of byPair) {
    const L = new Int32Array(g.length);
    const O = new Uint8Array(g.length);
    const M = new Float64Array(g.length);
    let f = -1;
    for (let k = 0; k < g.length; k++) {
      while (f + 1 < d.fine.n && d.fine.t[f + 1] + FINE <= g[k]) f++;
      L[k] = f;
      O[k] = f >= 0 && d.fine.t[f] + FINE === g[k] ? 1 : 0;
      M[k] = f >= 0 ? (d.fine.bc[f] + d.fine.ac[f]) / 2 : Number.NaN;
    }
    last.push(L);
    own.push(O);
    mid.push(M);
  }
  return { set, pairs: order, g, last, own, mid, usd: order.indexOf("USD/JPY") };
};

// the number of g in (t0, x]
export const holdOn = (grid: Grid, t0: number, x: number): number => upperBound(grid.g, x) - upperBound(grid.g, t0);

// a study's books, made once each
const bookCache = new WeakMap<Study, Map<string, Book>>();
export const bookOf = (study: Study, variant: Variant, set: PairSet): Book => {
  const key = `${variant}|${set}`;
  let cache = bookCache.get(study);
  if (!cache) bookCache.set(study, (cache = new Map()));
  const hit = cache.get(key);
  if (hit) return hit;
  const grid = study.grids[set];
  if (!grid) throw new Error(`no grid for ${set}`);
  const pis = new Map(grid.pairs.map((p, k) => [p, k]));
  const drifting = study.cfg.drift !== 0;
  const held: Held[] = [];
  for (const t of study.trades[variant]) {
    const pi = pis.get(t.sig.pair);
    if (pi === undefined) continue;
    if (t.exit === "passed") {
      held.push({ ...t, pi, gi0: -1, giX: -1, hold: 0, mark: new Float64Array(0), worst: new Float64Array(0), shift: null, stale: 0 });
      continue;
    }
    const gi0 = upperBound(grid.g, t.t0);
    const giX = lowerBound(grid.g, t.x);
    if (grid.g[giX] !== t.x) throw new Error(`${t.sig.id} ${variant}: its exit ${iso(t.x)} is not on G`);
    const hold = giX - gi0 + 1;
    const mark = new Float64Array(hold);
    const worst = new Float64Array(hold);
    const shift = drifting ? new Float64Array(hold) : null;
    const buy = t.sig.dir === 1;
    const c = buy ? t.book.bc : t.book.ac;
    const w = buy ? t.book.bl : t.book.ah;
    let stale = 0;
    for (let k = 0; k < hold; k++) {
      const gi = gi0 + k;
      const f = grid.last[pi][gi];
      const sh = t.mu * Math.max(0, f - t.f0 + 1);
      mark[k] = f >= 0 ? c[f] + sh : Number.NaN;
      if (grid.own[pi][gi]) worst[k] = w[f] + sh;
      else {
        worst[k] = mark[k];
        stale++;
      }
      if (shift) shift[k] = sh;
    }
    held.push({ ...t, pi, gi0, giX, hold, mark, worst, shift, stale });
  }
  const giAt = (ms: number) => upperBound(grid.g, ms) - 1;
  const book: Book = {
    set,
    variant,
    grid,
    trades: held,
    ny: study.ny.filter((c) => c.tau >= grid.g[0] && c.tau <= grid.g[grid.g.length - 1]).map((c) => {
      const gi = giAt(c.tau);
      return { ...c, gi, exact: gi >= 0 && grid.g[gi] === c.tau };
    }),
    giAt,
    openAt: (t: Held, ms: number) => {
      const f = lowerBound(t.book.t, ms);
      if (f >= t.book.n) return null;
      const o = t.sig.dir === 1 ? t.book.bo : t.book.ao;
      return { f, at: t.book.t[f], px: o[f] + t.mu * Math.max(0, f - t.f0 + 1) };
    },
  };
  cache.set(key, book);
  return book;
};

// ---- the trade-level numbers (§8.99 出すもの 取引ごと) ---------------------------------------

// yen a trade at 10,000 units: a dollar pair's at USD/JPY's mid at its exit
// (the planted usdentry: at T)
export const yenOf = (grid: Grid, t: Trade, plant = ""): number => {
  const px = (t.exitPx - t.fill) * t.sig.dir * 10_000;
  if (!t.pd.usd) return px;
  const gi = upperBound(grid.g, plant === "usdentry" ? t.sig.T : t.x) - 1;
  return px * grid.mid[grid.usd][gi];
};

const intervalPair = (xs: Array<{ x: number; week: number }>) => {
  const a = clustered(xs);
  const w = intervalOf(a, "weeks");
  const b = intervalOf(a, "blocks");
  return { m: w.m, week: [w.lo, w.hi], four: [b.lo, b.hi], C: w.C, C4: b.C, low: lowEnd(a), high: highEnd(a) };
};
const rnd = (x: number | null) => (x === null || !Number.isFinite(x) ? null : x);

// the numbers of a set of trades (passed late trades counted apart)
export const statsOf = (all: Trade[], grid: Grid, plant = "") => {
  const ts = all.filter((t) => t.exit !== "passed");
  const n = ts.length;
  const count = (k: Exit) => ts.filter((t) => t.exit === k).length;
  const tp = count("tp");
  const sl = count("sl");
  const amb = count("amb");
  const time = count("time");
  const pips = ts.map((t) => ({ x: t.pips, week: t.sig.week }));
  const yen = ts.map((t) => ({ x: yenOf(grid, t, plant), week: t.sig.week }));
  const p = intervalPair(pips);
  const y = intervalPair(yen);
  const first = ts.reduce((a, t) => Math.min(a, t.sig.T), Infinity);
  const lastX = ts.reduce((a, t) => Math.max(a, t.x), -Infinity);
  // a year: 365.25 days over the time from the first entry to the last exit
  const perYear = n ? (n * 365.25 * DAY) / (lastX - first) : Number.NaN;
  const wins = ts.filter((t) => t.pips > 0);
  const losses = ts.filter((t) => !(t.pips > 0));
  const worst = ts.reduce((a, t) => Math.min(a, t.pips), Infinity);
  // out at an open beyond the stop (the gap past it)
  const gaps = ts.filter((t) => t.exit === "sl" && t.atOpen && (t.sig.dir === 1 ? t.exitPx < t.sl : t.exitPx > t.sl));
  const holds = ts.map((t) => holdOn(grid, t.t0, t.x));
  const cal = ts.map((t) => t.calMs);
  const timed = ts.filter((t) => t.exit === "time");
  const swap = ts.reduce((a, t) => a + t.swapDays, 0);
  return {
    n,
    passed: all.length - n,
    tp,
    sl,
    amb,
    time,
    win_all: n ? tp / n : null,
    win_resolved: tp + sl + amb ? tp / (tp + sl + amb) : null,
    time_share: n ? time / n : null,
    time_mean: timed.length ? timed.reduce((a, t) => a + t.pips, 0) / timed.length : null,
    mean_pips: rnd(p.m),
    ci_week: p.week.map(rnd),
    ci_4wk: p.four.map(rnd),
    low_end: rnd(p.low),
    high_end: rnd(p.high),
    clusters: [p.C, p.C4],
    median_pips: medianOf(ts.map((t) => t.pips)),
    mean_r: n ? ts.reduce((a, t) => a + t.pips / SL, 0) / n : null,
    mean_yen: rnd(y.m),
    yen_ci_week: y.week.map(rnd),
    yen_ci_4wk: y.four.map(rnd),
    yen_low_end: rnd(y.low),
    yen_high_end: rnd(y.high),
    per_year: rnd(perYear),
    yen_year: y.m === null ? null : rnd(y.m * perYear),
    yen_year_low: y.low === null ? null : rnd(y.low * perYear),
    yen_year_high: y.high === null ? null : rnd(y.high * perYear),
    avg_win: wins.length ? wins.reduce((a, t) => a + t.pips, 0) / wins.length : null,
    avg_loss: losses.length ? losses.reduce((a, t) => a + t.pips, 0) / losses.length : null,
    worst_pips: Number.isFinite(worst) ? worst : null,
    worst_r: Number.isFinite(worst) ? worst / SL : null,
    gap_n: gaps.length,
    gap_mean: gaps.length ? gaps.reduce((a, t) => a + t.pips, 0) / gaps.length : null,
    spread_median: medianOf(ts.map((t) => 2 * t.h)),
    hold_grid: { median: medianOf(holds), p95: quantile(holds, 0.95), max: holds.length ? holds.reduce((a, b) => Math.max(a, b), 0) : null, sum: holds.reduce((a, b) => a + b, 0) },
    cal_ms: { median: medianOf(cal), p95: quantile(cal, 0.95), max: cal.length ? cal.reduce((a, b) => Math.max(a, b), 0) : null },
    weekend: { trades: ts.filter((t) => t.weekend > 0).length, total: ts.reduce((a, t) => a + t.weekend, 0) },
    ny: { trades: ts.filter((t) => t.nightsNy > 0).length, total: ts.reduce((a, t) => a + t.nightsNy, 0), swap_days: swap, swap_days_mean: n ? swap / n : null },
    // the swap a day at 10,000 units that would move the yen a trade by ¥100
    // (1 pip on a yen pair at 10,000 units)
    swap_for_100: swap > 0 ? (100 * n) / swap : null,
  };
};
export type TradeStats = ReturnType<typeof statsOf>;

// trades open together at each g of G (§8.99 同時に持っていた数): counted
// apart from hold_grid (two pointers over the trades' starts and ends), so
// Σ hold_grid = Σ the counts is a check of the two
export const concurrencyOf = (grid: Grid, ts: Trade[]) => {
  const open = ts.filter((t) => t.exit !== "passed");
  const starts = Float64Array.from(open.map((t) => t.t0)).sort();
  const ends = Float64Array.from(open.map((t) => t.x)).sort();
  const G = grid.g;
  const P = grid.pairs.length;
  const pi = new Map(grid.pairs.map((p, k) => [p, k]));
  // per pair and side, and the yen pairs' buys and sells: +1 at gi0, −1 after giX
  const diff = (len: number) => new Int32Array(len + 1);
  const pairBuy = Array.from({ length: P }, () => diff(G.length));
  const pairSell = Array.from({ length: P }, () => diff(G.length));
  for (const t of open) {
    const a = upperBound(G, t.t0);
    const b = upperBound(G, t.x);
    const arr = t.sig.dir === 1 ? pairBuy[pi.get(t.sig.pair)!] : pairSell[pi.get(t.sig.pair)!];
    arr[a]++;
    arr[b]--;
  }
  const first = open.reduce((a, t) => Math.min(a, t.t0), Infinity);
  const lastX = open.reduce((a, t) => Math.max(a, t.x), -Infinity);
  const lo = upperBound(G, first);
  const hi = upperBound(G, lastX);
  let s0 = 0;
  let e0 = 0;
  let sum = 0;
  let sumSpan = 0;
  let max = 0;
  let maxAt = 0;
  const atLeast = [0, 0, 0];
  let jpyMax = 0;
  let hedgeTime = 0;
  const pairMax = new Array(P).fill(0);
  const curB = new Int32Array(P);
  const curS = new Int32Array(P);
  for (let k = 0; k < G.length; k++) {
    // open at g: started before g, not out before g (t0 < g ≤ x)
    while (s0 < starts.length && starts[s0] < G[k]) s0++;
    while (e0 < ends.length && ends[e0] < G[k]) e0++;
    const c = s0 - e0;
    sum += c;
    let jb = 0;
    let js = 0;
    let hedged = false;
    for (let p = 0; p < P; p++) {
      curB[p] += pairBuy[p][k];
      curS[p] += pairSell[p][k];
      if (grid.pairs[p].includes("JPY")) {
        jb += curB[p];
        js += curS[p];
      }
      if (curB[p] + curS[p] > pairMax[p]) pairMax[p] = curB[p] + curS[p];
      if (curB[p] > 0 && curS[p] > 0) hedged = true;
    }
    if (k < lo || k >= hi) continue;
    sumSpan += c;
    if (c > max) {
      max = c;
      maxAt = G[k];
    }
    if (c >= 1) atLeast[0]++;
    if (c >= 3) atLeast[1]++;
    if (c >= 5) atLeast[2]++;
    jpyMax = Math.max(jpyMax, jb, js);
    if (hedged) hedgeTime++;
  }
  const span = hi - lo;
  // a trade entered with the other side of its pair open (or entered at the
  // same close): the hedges
  let hedges = 0;
  for (const t of open) {
    if (open.some((u) => u !== t && u.sig.pair === t.sig.pair && u.sig.dir !== t.sig.dir && (u.sig.T === t.sig.T || (u.t0 < t.sig.T && u.x > t.sig.T)))) hedges++;
  }
  // one close's emails: how many, and the most yen ones one way
  const byT = new Map<number, { n: number; jb: number; js: number }>();
  for (const t of open) {
    const e = byT.get(t.sig.T) ?? { n: 0, jb: 0, js: 0 };
    e.n++;
    if (t.sig.pair.includes("JPY")) t.sig.dir === 1 ? e.jb++ : e.js++;
    byT.set(t.sig.T, e);
  }
  const perBar: Record<number, number> = {};
  let sameBarJpy = 0;
  for (const e of byT.values()) {
    perBar[e.n] = (perBar[e.n] ?? 0) + 1;
    sameBarJpy = Math.max(sameBarJpy, e.jb, e.js);
  }
  return {
    span_g: span,
    sum_all_g: sum,
    max,
    max_at: max ? iso(maxAt) : null,
    share_1: span ? atLeast[0] / span : null,
    share_3: span ? atLeast[1] / span : null,
    share_5: span ? atLeast[2] / span : null,
    mean: span ? sumSpan / span : null,
    jpy_same_way_max: jpyMax,
    pair_max: Object.fromEntries(grid.pairs.map((p, k) => [p, pairMax[k]])),
    hedges,
    hedge_time_share: span ? hedgeTime / span : null,
    emails_per_bar: perBar,
    same_bar_jpy_way_max: sameBarJpy,
  };
};
