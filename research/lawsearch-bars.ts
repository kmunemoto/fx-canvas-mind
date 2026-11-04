// 法則探し (docs §8.136, research/lawsearch-spec.md 2, 7, 15): the bars of the study. Builder A of
// research/lawsearch-design.md 4.1.
//
//   * the GMO day files read through trend-data's loadTf (both sides by mergeSides, the weekend's bars thrown away by
//     barInsideClosure), with spec 2's value forms checked on the raw files first (21.5 ファイルの形と値の読み方) and
//     the counts of spec 2 and 15 (捨てた数, 同じ始まりの行の数, 数にできない行, Ask < Bid by year);
//   * the mid (Number(((bid + ask) / 2).toFixed(d)), as the chart's historyRead), the points (1 point = 0.1 pip),
//     the bar numbers from S0 with gaps closed up, the higher timeframe (coarsen on GMO's grid, both sides first),
//     the day D(t) (21:00 UTC, a Saturday moved to the Friday), the seasons, GMO's holidays, the strata's id;
//   * spec 7's entry and exit bars from bar times alone (the trade module and stage 0 both use them);
//   * the series edits of spec 15's checks (cut, poison, presence), each making new series.
//
// Nothing here reads the environment; a planted error (spec 16) is a `plant` argument.

import { coarsen, keysFor, loadTf } from "./trend-data.ts";
import { type Bars, emptyBars, weekendOutOf } from "./trend-labels.ts";
import { type Source, newLoadStats, sound } from "./ownerhold-data.ts";
import { GMO_INTERVALS, GMO_SYMBOLS, parseKlines } from "../supabase/functions/track-outcomes/quotes.ts";
import { nyOffsetMs } from "../supabase/functions/_shared/market-hours.ts";
import { DAY, HOUR } from "./lib.ts";
import { HIGHER, MID_DIGITS, PAIRS, POINTS_PER_PRICE, STEP } from "./lawsearch-const.ts";
import { ASK_LT_BID_MAX, POINT_TOL, PRICE_BAND, SYN_BAND } from "./lawsearch-rules.ts";
import { GEN_START } from "./lawsearch-gen.ts";
import type { Dir, EntryExit, LoadPurpose, LoadReport, Pair, SeasonGroup, Series, SeriesKey, TfKey, TfSet, Universe } from "./lawsearch-types.ts";

// spec 2 / 15: a stop of the run (the value forms, an off-tick raw price, the data checks that must be 0)
export const stop = (what: string): never => {
  throw new Error("STOP: " + what);
};

const STEP_OF_KEY: Readonly<Record<SeriesKey, number>> = { m15: STEP.m15, h1: STEP.h1, h4: HIGHER.h1 };
const TF_NAME: Readonly<Record<TfKey, "15min" | "1h">> = { m15: "15min", h1: "1h" };
const pairIndex = (pair: Pair): number => {
  const pi = (PAIRS as readonly string[]).indexOf(pair);
  if (pi < 0) throw new Error(`not one of the five pairs: ${pair}`);
  return pi;
};

// ---- spec 2: the value forms (21.5 ファイルの形と値の読み方) ------------------------------------------------------

export interface ScanOut {
  // data's elements, the rows kept (every value of the right form and finite), the rows dropped as 数にできない行,
  // and the values of the wrong form that parseKlines would read as finite numbers ("<where> #k <name> <JSON>")
  elements: number;
  kept: number;
  unparseable: number;
  stops: string[];
}

const NAMES = ["openTime", "open", "high", "low", "close"] as const;
const DIGITS_ONLY = /^[0-9]+$/;
const DECIMAL_FORM = /^[0-9]*\.?[0-9]*$/;
const HAS_DIGIT = /[0-9]/;
// parseKlines' num(): a JSON number as it is, a string by Number(), anything else NaN; NaN when not finite
const klineNum = (v: unknown): number => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : NaN;
};

// One side of one day file, already JSON.parse'd and sound() (ownerhold-data), every element of data (spec 2):
//   * an element that is not an object (null, a string, a number, an array) is unparseable;
//   * openTime of the right form is a string of ASCII digits only; a price of the right form is a string of ASCII
//     digits with at most one "." and at least one digit; its Number() must be finite, else the row is unparseable;
//   * a value of the wrong form is read as parseKlines would: finite → a stop (the run stops); otherwise the row is
//     unparseable. Each value is checked on its own, so one row can give a stop and be unparseable.
export function scanBody(body: unknown, where: string): ScanOut {
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) throw new Error(`scanBody ${where}: data is not an array (the body was not sound)`);
  const out: ScanOut = { elements: data.length, kept: 0, unparseable: 0, stops: [] };
  for (let k = 0; k < data.length; k++) {
    const row = data[k];
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      out.unparseable++;
      continue;
    }
    let bad = false;
    for (const name of NAMES) {
      const v = (row as Record<string, unknown>)[name];
      const rightForm = typeof v === "string" && (name === "openTime" ? DIGITS_ONLY.test(v) : DECIMAL_FORM.test(v) && HAS_DIGIT.test(v));
      if (rightForm) {
        if (!Number.isFinite(Number(v))) bad = true;
        continue;
      }
      if (Number.isFinite(klineNum(v))) out.stops.push(`${where} #${k} ${name} ${JSON.stringify(v)}`);
      else bad = true;
    }
    if (bad) out.unparseable++;
    else out.kept++;
  }
  return out;
}

// ---- spec 2: mid and points ---------------------------------------------------------------------------------------

// plant midHalfEven: ties (the double's exact value halfway between two d-decimals) go to the even last digit.
// toFixed(f) is exact (the integer n nearest to x × 10^f, ECMA-262), and every price here (≥ 2^-3) has at most 55
// binary fraction digits, so toFixed(80) is the double's exact decimal value.
const halfEven = (v: number, d: number): number => {
  const ex = v.toFixed(80);
  const dot = ex.indexOf(".");
  const rest = ex.slice(dot + 1 + d);
  const lower = ex.slice(0, dot + 1 + d);
  if (!/^50*$/.test(rest)) return Number(v.toFixed(d));
  const last = Number(lower[lower.length - 1]);
  return last % 2 === 0 ? Number(lower) : Number(v.toFixed(d));
};

// spec 2 中値: (bid + ask) ÷ 2 as a double, its exact value rounded to d decimals, ties up (TS: Number(v.toFixed(d)),
// as the chart's historyRead); d = 3 on the yen pairs, 5 on the dollar pairs. Plant midHalfEven: ties to even.
export function midOf(bid: number, ask: number, pair: Pair, plant = ""): number {
  const d = MID_DIGITS(pair);
  const v = (bid + ask) / 2;
  return plant === "midHalfEven" ? halfEven(v, d) : Number(v.toFixed(d));
}

// spec 2 点: the rounded mid × 1,000 (yen) or × 100,000, to the nearest integer (Math.round). Plant pointsTrunc:
// Math.trunc.
export function pointsOf(v: number, pair: Pair, plant = ""): number {
  const x = v * POINTS_PER_PRICE(pair);
  return plant === "pointsTrunc" ? Math.trunc(x) : Math.round(x);
}

// spec 2: a raw Bid or Ask value in points; GMO's tick is 0.1 pip, so a value farther than 1e−6 from a whole number
// of points stops the run
export function rawPointsOf(v: number, pair: Pair): number {
  const x = v * POINTS_PER_PRICE(pair);
  const r = Math.round(x);
  if (!(Math.abs(x - r) <= POINT_TOL)) stop(`${pair}: the raw price ${v} is not a whole number of points (${x})`);
  return r;
}

// ---- spec 2: the calendar (pure functions of t) -------------------------------------------------------------------

const ymd = (ms: number): number => {
  const d = new Date(ms);
  return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
};

// spec 2 日: D(t) = the UTC date of t + 3 hours (gmoDayKey's, the day from 21:00 UTC), a Saturday moved to the Friday
// before (the winter Friday's 21:00-22:00 UTC is Friday's day, 反証 C8), as YYYYMMDD. Plant daySatSplit: no move.
export function dayOf(t: number, plant = ""): number {
  let ms = t + 3 * HOUR;
  if (plant !== "daySatSplit" && new Date(ms).getUTCDay() === 6) ms -= DAY;
  return ymd(ms);
}

// spec 2 季節: New York's summer as market-hours nyOffsetMs (−4 hours)
export function nySummer(t: number): boolean {
  return nyOffsetMs(t) === -4 * HOUR;
}

// the last Sunday of a UTC month (0-based month)
const lastSunday = (y: number, m: number): number => {
  const last = new Date(Date.UTC(y, m + 1, 0));
  return last.getUTCDate() - last.getUTCDay();
};
// spec 2 季節: London's summer, [last Sunday of March 01:00 UTC, last Sunday of October 01:00 UTC) of t's UTC year
export function londonSummer(t: number): boolean {
  const y = new Date(t).getUTCFullYear();
  const start = Date.UTC(y, 2, lastSunday(y, 2), 1);
  const end = Date.UTC(y, 9, lastSunday(y, 9), 1);
  return t >= start && t < end;
}

// spec 2 / 21.5 層の並び: 0 both winter, 1 both summer, 2 New York only summer, 3 London only summer
export function seasonGroupOf(t: number): SeasonGroup {
  const ny = nySummer(t);
  const lon = londonSummer(t);
  return ny ? (lon ? 1 : 2) : lon ? 3 : 0;
}

// spec 2 GMO の休み: the 24 hours [the day before 21:00, the day 21:00) UTC of 12/25 and 1/1, i.e. the UTC date of
// t + 3 hours is 12-25 or 01-01 (D(t)'s Saturday rule is not applied)
export function isGmoHoliday(t: number): boolean {
  const d = new Date(t + 3 * HOUR);
  const m = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  return (m === 12 && day === 25) || (m === 1 && day === 1);
}

// the UTC hour 0-23
export function hourOf(t: number): number {
  return Math.floor((((t % DAY) + DAY) % DAY) / HOUR);
}

// spec 8.2 / lawsearch-design.md 2.2: ((pi × 2 + (d === 1 ? 0 : 1)) × 24 + hour) × 4 + season; ascending ids are
// 21.5's stratum order
export function stratumOf(pi: number, d: Dir, t: number): number {
  return ((pi * 2 + (d === 1 ? 0 : 1)) * 24 + hourOf(t)) * 4 + seasonGroupOf(t);
}

// ---- spec 2: series -----------------------------------------------------------------------------------------------

// A Series from loadTf's (or coarsen's) Bars: T = s + step, the rounded mid, the points (the raw ones checked on the
// tick), D(s), fileKey = Bars.key
export function seriesOf(pair: Pair, key: SeriesKey, b: Bars, plant = ""): Series {
  const pi = pairIndex(pair);
  const step = STEP_OF_KEY[key];
  if (!step) throw new Error(`seriesOf: key ${key}`);
  const n = b.n;
  const f = () => new Float64Array(n);
  const p = () => new Int32Array(n);
  const s: Series = {
    pair, pi, key, step, n,
    s: f(), T: f(),
    bo: f(), bh: f(), bl: f(), bc: f(), ao: f(), ah: f(), al: f(), ac: f(),
    O: f(), H: f(), L: f(), C: f(),
    Po: p(), Ph: p(), Pl: p(), Pc: p(), Bo: p(), Bh: p(), Bl: p(), Bc: p(), Ao: p(), Ah: p(), Al: p(), Ac: p(),
    day: p(), fileKey: p(),
  };
  // the day changes only on whole hours (21:00 UTC), so it is looked up once per hour
  let dayHour = NaN;
  let dayVal = 0;
  for (let i = 0; i < n; i++) {
    const t = b.t[i];
    s.s[i] = t;
    s.T[i] = t + step;
    s.bo[i] = b.bo[i];
    s.bh[i] = b.bh[i];
    s.bl[i] = b.bl[i];
    s.bc[i] = b.bc[i];
    s.ao[i] = b.ao[i];
    s.ah[i] = b.ah[i];
    s.al[i] = b.al[i];
    s.ac[i] = b.ac[i];
    s.O[i] = midOf(b.bo[i], b.ao[i], pair, plant);
    s.H[i] = midOf(b.bh[i], b.ah[i], pair, plant);
    s.L[i] = midOf(b.bl[i], b.al[i], pair, plant);
    s.C[i] = midOf(b.bc[i], b.ac[i], pair, plant);
    s.Po[i] = pointsOf(s.O[i], pair, plant);
    s.Ph[i] = pointsOf(s.H[i], pair, plant);
    s.Pl[i] = pointsOf(s.L[i], pair, plant);
    s.Pc[i] = pointsOf(s.C[i], pair, plant);
    s.Bo[i] = rawPointsOf(b.bo[i], pair);
    s.Bh[i] = rawPointsOf(b.bh[i], pair);
    s.Bl[i] = rawPointsOf(b.bl[i], pair);
    s.Bc[i] = rawPointsOf(b.bc[i], pair);
    s.Ao[i] = rawPointsOf(b.ao[i], pair);
    s.Ah[i] = rawPointsOf(b.ah[i], pair);
    s.Al[i] = rawPointsOf(b.al[i], pair);
    s.Ac[i] = rawPointsOf(b.ac[i], pair);
    if (Math.floor(t / HOUR) !== dayHour) {
      dayHour = Math.floor(t / HOUR);
      dayVal = dayOf(t, plant);
    }
    s.day[i] = dayVal;
    s.fileKey[i] = b.key[i];
  }
  return s;
}

// the hand examples of groups 3 and 4: the mid given as decimal strings ([o, h, l, c] per bar) with each bar's start;
// both raw sides are the mid, fileKey −1
export function seriesFromMid(pair: Pair, key: SeriesKey, s: ArrayLike<number>, mid: ReadonlyArray<readonly string[]>, plant = ""): Series {
  if (s.length !== mid.length) throw new Error(`seriesFromMid: ${s.length} starts, ${mid.length} bars`);
  const b = emptyBars(mid.length);
  for (let i = 0; i < mid.length; i++) {
    const row = mid[i];
    if (row.length !== 4) throw new Error(`seriesFromMid: bar ${i} has ${row.length} values`);
    const [o, h, l, c] = row.map((x) => Number(x));
    if (![o, h, l, c].every(Number.isFinite)) throw new Error(`seriesFromMid: bar ${i}: ${row.join(" ")}`);
    if (i > 0 && !(s[i] > s[i - 1])) throw new Error(`seriesFromMid: the starts are not ascending at bar ${i}`);
    b.t[i] = s[i];
    b.bo[i] = b.ao[i] = o;
    b.bh[i] = b.ah[i] = h;
    b.bl[i] = b.al[i] = l;
    b.bc[i] = b.ac[i] = c;
    b.key[i] = -1;
  }
  return seriesOf(pair, key, b, plant);
}

// the raw sides of a Series as a Bars (key −1 unless kept)
const barsOfSeries = (x: Series, keepKey: boolean): Bars => {
  const b = emptyBars(x.n);
  b.t.set(x.s);
  b.bo.set(x.bo);
  b.bh.set(x.bh);
  b.bl.set(x.bl);
  b.bc.set(x.bc);
  b.ao.set(x.ao);
  b.ah.set(x.ah);
  b.al.set(x.al);
  b.ac.set(x.ac);
  if (keepKey) b.key.set(x.fileKey);
  else b.key.fill(-1);
  return b;
};

// spec 2 上位足: the higher bars made from the base series on GMO's grid (trend-data coarsen: start = floor(t ÷
// length) × length; open the first bar's, close the last's, high and low the max and min; each side first), then
// the mid and points as spec 2. Index 0 is the first higher bar of the base series (the base starts at S0, so this
// is "S0 からの通し"). fileKey −1.
export function coarsenSeries(base: Series, key: SeriesKey, plant = ""): Series {
  const tf = key === "h1" ? "1h" : key === "h4" ? "4h" : null;
  if (!tf || !(STEP_OF_KEY[key] > base.step)) throw new Error(`coarsenSeries: ${base.key} → ${key}`);
  const out = seriesOf(base.pair, key, coarsen(barsOfSeries(base, false), tf), plant);
  out.fileKey.fill(-1);
  return out;
}

// spec 2 上位足: g(i) = the last higher bar g whose grid slot has ended by T_i (s_g + step_g ≤ T_i), −1 when none;
// the clock decides even when base bars are missing. Plant htfOpen: the last higher bar with s_g ≤ s_i (it may
// still be forming).
export function htfIndex(base: Series, htf: Series, plant = ""): Int32Array {
  const g = new Int32Array(base.n);
  let k = -1;
  if (plant === "htfOpen") {
    for (let i = 0; i < base.n; i++) {
      while (k + 1 < htf.n && htf.s[k + 1] <= base.s[i]) k++;
      g[i] = k;
    }
  } else {
    for (let i = 0; i < base.n; i++) {
      while (k + 1 < htf.n && htf.s[k + 1] + htf.step <= base.T[i]) k++;
      g[i] = k;
    }
  }
  return g;
}

// One timeframe of the five pairs with its higher timeframe (m15 → 1 hour, h1 → 4 hours) and g of each pair
export function tfSetOf(tf: TfKey, pairs: Series[], plant = ""): TfSet {
  if (pairs.length !== PAIRS.length) throw new Error(`tfSetOf: ${pairs.length} pairs`);
  pairs.forEach((p, pi) => {
    if (p.pi !== pi || p.key !== tf) throw new Error(`tfSetOf ${tf}: pair ${pi} is ${p.pair} ${p.key}`);
  });
  const htfKey: SeriesKey = tf === "m15" ? "h1" : "h4";
  const htf = pairs.map((p) => coarsenSeries(p, htfKey, plant));
  const g = pairs.map((p, pi) => htfIndex(p, htf[pi], plant));
  return { tf, step: STEP[tf], htfStep: HIGHER[tf], pairs, htf, g };
}

// ---- spec 7 (times only; the trade module and stage 0 both use it) -----------------------------------------------

// the first index with xs[k] ≥ v (xs ascending)
const lowerBound = (xs: ArrayLike<number>, n: number, v: number): number => {
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (xs[m] < v) lo = m + 1;
    else hi = m;
  }
  return lo;
};
// the first index with xs[k] > v (xs ascending)
const upperBound = (xs: ArrayLike<number>, n: number, v: number): number => {
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (xs[m] <= v) lo = m + 1;
    else hi = m;
  }
  return lo;
};

// spec 7: j = the first bar whose start is ≥ T and < X (null: no trade can be made); x = the bar that closes exactly
// at X, else the last bar with start ≥ s_j and close ≤ X (subst). Bars are in start order, so the bar closing at X,
// when it exists, is the last bar with close ≤ X.
export function entryExitIndex(s: Series, T: number, X: number): EntryExit | null {
  const j = lowerBound(s.s, s.n, T);
  if (j >= s.n || !(s.s[j] < X)) return null;
  const x = upperBound(s.T, s.n, X) - 1;
  if (x < j) return null;
  return { j, x, subst: s.T[x] !== X };
}

// ---- loading (spec 2, 15) -----------------------------------------------------------------------------------------

export interface LoadOpts {
  purpose: LoadPurpose;
  band: "real" | "syn";
  plant: string;
}

// The STOP of a load with value stops carries the load's report (the counts are made before the stop, so the caller
// can print them): reportOfStop(e) gives it back, null for any other error
const REPORT = Symbol("lawsearch load report");
export function reportOfStop(e: unknown): LoadReport | null {
  return (e instanceof Error && (e as Error & { [REPORT]?: LoadReport })[REPORT]) || null;
}

const bandOf = (pair: Pair, band: "real" | "syn"): readonly [number, number] =>
  band === "real" ? PRICE_BAND[pair] : [SYN_BAND[0] * GEN_START[pair], SYN_BAND[1] * GEN_START[pair]];

// One loadTf call (pair, timeframe, [fromMs, toMs)) with spec 2's and 15's numbers:
//   1. the raw day files of keysFor (jstDayKey(fromMs − 1 day) … jstDayKey(toMs), oldest first), both sides: JSON
//      (JSON.parse), sound(), and scanBody's value forms (数にできない行 on both sides; value stops);
//   2. Ask < Bid by the UTC year of the Bid row's start, from parseKlines of the same bodies (only the keys whose two
//      sides were read, as loadTf), concatenated in key order and sorted stably by start; the last Ask row of a
//      start is the one compared (loadTf's map);
//   3. loadTf(…, weekendOutOf("inside")): 捨てた数 = diag.crossed, 同じ始まりの行の数 = diag.repeated;
//   4. Σ of 2's numerators must equal diag.crossed (a stop otherwise);
//   5. seriesOf, and spec 15's ohlcBad, dupStarts and bandBad.
// With value stops, the run stops after the counts (reportOfStop). Real data's fetch is not part of the trial.
export async function loadPairTf(src: Source, pair: Pair, tf: TfKey, fromMs: number, toMs: number, o: LoadOpts): Promise<{ series: Series; report: LoadReport }> {
  if (src.fetch) throw new Error("NOT BUILT: loadPairTf with fetch (real data is step 5)");
  const tfName = TF_NAME[tf];
  const symbol = GMO_SYMBOLS[pair];
  const interval = GMO_INTERVALS[tfName].name;
  const { keys } = keysFor(tfName, fromMs, toMs);
  const report: LoadReport = {
    purpose: o.purpose, pair, tf, fromMs, toMs, keys: [...keys],
    filesRead: 0, readFailures: 0, unparseableRows: 0, valueStops: [],
    droppedAskLtBid: 0, sameStartBidRows: 0, askLtBidByYear: [],
    bars: 0, first: NaN, last: NaN, ohlcBad: 0, dupStarts: 0, bandBad: 0,
  };
  type Row = ReturnType<typeof parseKlines>[number];
  const bid: Row[] = [];
  const ask: Row[] = [];
  for (const key of keys) {
    const bodies: Record<"bid" | "ask", unknown> = { bid: null, ask: null };
    for (const side of ["bid", "ask"] as const) {
      // lawsearch-dump.md 4: files_read counts every side file opened (2 per key), read or not
      report.filesRead++;
      let body: unknown = undefined;
      try {
        body = JSON.parse(await Deno.readTextFile(`${src.dir}/${symbol}/${interval}/${side}/${key}.json`));
      } catch {
        body = undefined;
      }
      if (body === undefined || !sound(body)) {
        report.readFailures++;
        continue;
      }
      const sc = scanBody(body, `${symbol} ${interval} ${side} ${key}`);
      report.unparseableRows += sc.unparseable;
      report.valueStops.push(...sc.stops);
      bodies[side] = body;
    }
    if (bodies.bid !== null && bodies.ask !== null) {
      for (const r of parseKlines(bodies.bid)) bid.push(r);
      for (const r of parseKlines(bodies.ask)) ask.push(r);
    }
  }
  bid.sort((a, b) => a.t - b.t);
  ask.sort((a, b) => a.t - b.t);
  const asks = new Map(ask.map((x) => [x.t, x.c]));
  const byYear = new Map<number, { num: number; den: number }>();
  for (const x of bid) {
    const a = asks.get(x.t);
    if (!a) continue;
    const year = new Date(x.t).getUTCFullYear();
    let y = byYear.get(year);
    if (!y) byYear.set(year, (y = { num: 0, den: 0 }));
    y.den++;
    if (a.close < x.c.close) y.num++;
  }
  report.askLtBidByYear = [...byYear.entries()].sort((a, b) => a[0] - b[0]).map(([year, v]) => ({ year, num: v.num, den: v.den }));

  const { bars, diag } = await loadTf(src, pair, tfName, fromMs, toMs, newLoadStats(), weekendOutOf("inside"));
  report.droppedAskLtBid = diag.crossed;
  report.sameStartBidRows = diag.repeated;
  const numSum = report.askLtBidByYear.reduce((a, y) => a + y.num, 0);
  if (numSum !== diag.crossed) stop(`${pair} ${tf}: Ask < Bid by year sums to ${numSum}, loadTf crossed ${diag.crossed}`);

  const withReport = (e: Error): Error => {
    (e as Error & { [REPORT]?: LoadReport })[REPORT] = report;
    return e;
  };
  let series: Series;
  try {
    series = seriesOf(pair, tf, bars, o.plant);
  } catch (e) {
    // an off-tick raw price (spec 2) stops the run; the counts made so far go with the stop
    throw e instanceof Error && e.message.startsWith("STOP:") ? withReport(e) : e;
  }
  report.bars = series.n;
  report.first = series.n ? series.s[0] : NaN;
  report.last = series.n ? series.s[series.n - 1] : NaN;
  const [lo, hi] = bandOf(pair, o.band);
  for (let i = 0; i < series.n; i++) {
    const side = (op: number, h: number, l: number, c: number) => l > Math.min(op, c) || h < Math.max(op, c) || l > h;
    if (side(series.bo[i], series.bh[i], series.bl[i], series.bc[i]) || side(series.ao[i], series.ah[i], series.al[i], series.ac[i])) report.ohlcBad++;
    if (i > 0 && !(series.s[i] > series.s[i - 1])) report.dupStarts++;
    const vals = [series.bo[i], series.bh[i], series.bl[i], series.bc[i], series.ao[i], series.ah[i], series.al[i], series.ac[i]];
    if (vals.some((v) => !(v >= lo && v <= hi))) report.bandBad++;
  }
  if (report.valueStops.length) {
    throw withReport(new Error(`STOP: ${pair} ${tf}: ${report.valueStops.length} values of the wrong form that parseKlines reads as numbers (spec 2), first ${report.valueStops[0]}`));
  }
  return { series, report };
}

// The five pairs × two timeframes of one load (reports in pair order, m15 before h1), their TfSets, and spec 15's
// data problems
export async function loadUniverse(src: Source, fromMs: number, toMs: number, o: LoadOpts): Promise<Universe> {
  const load: LoadReport[] = [];
  const m15: Series[] = [];
  const h1: Series[] = [];
  for (const pair of PAIRS as readonly Pair[]) {
    for (const tf of ["m15", "h1"] as const) {
      const r = await loadPairTf(src, pair, tf, fromMs, toMs, o);
      load.push(r.report);
      (tf === "m15" ? m15 : h1).push(r.series);
    }
  }
  const u: Universe = { purpose: o.purpose, fromMs, toMs, m15: tfSetOf("m15", m15, o.plant), h1: tfSetOf("h1", h1, o.plant), load, problems: [] };
  u.problems = dataProblems(u);
  return u;
}

// spec 15 データ: one string per failed check (empty: every check passed)
export function dataProblems(u: Universe): string[] {
  const out: string[] = [];
  for (const r of u.load) {
    const at = `${r.purpose} ${r.pair} ${r.tf}`;
    if (r.readFailures > 0) out.push(`${at}: ${r.readFailures} read failures`);
    if (r.valueStops.length > 0) out.push(`${at}: ${r.valueStops.length} value stops`);
    if (r.ohlcBad > 0) out.push(`${at}: ${r.ohlcBad} bars with inconsistent open, high, low and close`);
    if (r.dupStarts > 0) out.push(`${at}: ${r.dupStarts} bars without a start of their own`);
    if (r.bandBad > 0) out.push(`${at}: ${r.bandBad} bars outside the price band`);
    for (const y of r.askLtBidByYear) if (y.den > 0 && y.num / y.den > ASK_LT_BID_MAX) out.push(`${at}: Ask < Bid on ${y.num} of ${y.den} rows in ${y.year}`);
  }
  for (const set of [u.m15, u.h1]) {
    for (const h of set.htf) {
      let dup = 0;
      for (let i = 1; i < h.n; i++) if (!(h.s[i] > h.s[i - 1])) dup++;
      if (dup > 0) out.push(`${u.purpose} ${h.pair} ${h.key} (higher bars of ${set.tf}): ${dup} bars without a start of their own`);
    }
  }
  return out;
}

// ---- series edits for the checks of spec 15 (new series; the input is never changed) ----------------------------

const FLOAT_KEYS = ["s", "T", "bo", "bh", "bl", "bc", "ao", "ah", "al", "ac", "O", "H", "L", "C"] as const;
const INT_KEYS = ["Po", "Ph", "Pl", "Pc", "Bo", "Bh", "Bl", "Bc", "Ao", "Ah", "Al", "Ac", "day", "fileKey"] as const;

// bars [from, to) of s as subarray views
const viewOf = (s: Series, from: number, to: number): Series => {
  const out = { pair: s.pair, pi: s.pi, key: s.key, step: s.step, n: to - from } as Series;
  for (const k of FLOAT_KEYS) out[k] = s[k].subarray(from, to);
  for (const k of INT_KEYS) out[k] = s[k].subarray(from, to);
  return out;
};

// spec 15 切り取り: the bars with T ≤ Tcut (a bar starting at Tcut is not in it), as views
export function prefixSeries(s: Series, Tcut: number): Series {
  return viewOf(s, 0, upperBound(s.T, s.n, Tcut));
}

// bars from..to (both included) as views, for an item of finite length recomputed on a window
export function windowSeries(s: Series, from: number, to: number): Series {
  if (!(Number.isInteger(from) && Number.isInteger(to) && from >= 0 && to < s.n && from <= to + 1)) throw new Error(`windowSeries: ${from}..${to} of ${s.n}`);
  return viewOf(s, from, to + 1);
}

// spec 15 切り取り: every pair cut at Tcut, and the higher bars and g rebuilt from the cut bars (a higher bar still
// forming at Tcut is then as it was at Tcut)
export function cutTfSet(tf: TfSet, Tcut: number, plant = ""): TfSet {
  return tfSetOf(tf.tf, tf.pairs.map((p) => prefixSeries(p, Tcut)), plant);
}

// a copy of s with the raw sides of the listed bars moved by sign × pts points (sign by the bar's place in the list:
// +, −, +, …), and the mid and points made again
const shifted = (s: Series, idx: ArrayLike<number>, pips: number): Series => {
  const pts = Math.round(pips * 10);
  if (!(Math.abs(pips * 10 - pts) < 1e-9)) throw new Error(`poison: ${pips} pips is not a whole number of points`);
  const out = { pair: s.pair, pi: s.pi, key: s.key, step: s.step, n: s.n } as Series;
  for (const k of FLOAT_KEYS) out[k] = s[k].slice();
  for (const k of INT_KEYS) out[k] = s[k].slice();
  const mult = POINTS_PER_PRICE(s.pair);
  const raw = [["bo", "Bo"], ["bh", "Bh"], ["bl", "Bl"], ["bc", "Bc"], ["ao", "Ao"], ["ah", "Ah"], ["al", "Al"], ["ac", "Ac"]] as const;
  for (let q = 0; q < idx.length; q++) {
    const i = idx[q];
    if (!(Number.isInteger(i) && i >= 0 && i < s.n)) throw new Error(`poison: bar ${i} of ${s.n}`);
    const d = (q % 2 === 0 ? 1 : -1) * pts;
    for (const [v, P] of raw) {
      out[P][i] = s[P][i] + d;
      out[v][i] = out[P][i] / mult;
    }
    out.O[i] = midOf(out.bo[i], out.ao[i], s.pair);
    out.H[i] = midOf(out.bh[i], out.ah[i], s.pair);
    out.L[i] = midOf(out.bl[i], out.al[i], s.pair);
    out.C[i] = midOf(out.bc[i], out.ac[i], s.pair);
    out.Po[i] = pointsOf(out.O[i], s.pair);
    out.Ph[i] = pointsOf(out.H[i], s.pair);
    out.Pl[i] = pointsOf(out.L[i], s.pair);
    out.Pc[i] = pointsOf(out.C[i], s.pair);
  }
  return out;
};

// spec 15 毒: every bar with T > afterT gets +pips, −pips, … alternately (bar by bar, + first) on all 8 raw sides;
// the mid and points are made again. The raw values stay on the tick grid (the shift is a whole number of points).
export function poisonSeries(s: Series, afterT: number, pips: number): Series {
  const k0 = upperBound(s.T, s.n, afterT);
  const idx = new Int32Array(s.n - k0);
  for (let k = k0; k < s.n; k++) idx[k - k0] = k;
  return shifted(s, idx, pips);
}

// spec 15 追う足: the listed bars only, + for the first listed, − for the second, …
export function poisonBars(s: Series, idx: Int32Array, pips: number): Series {
  return shifted(s, idx, pips);
}

// spec 15 有無の毒: the bars with drop(k) false kept (new arrays), numbered again from 0
export function deleteBars(s: Series, drop: (k: number) => boolean): Series {
  const keep: number[] = [];
  for (let k = 0; k < s.n; k++) if (!drop(k)) keep.push(k);
  const out = { pair: s.pair, pi: s.pi, key: s.key, step: s.step, n: keep.length } as Series;
  for (const k of FLOAT_KEYS) {
    const a = new Float64Array(keep.length);
    keep.forEach((i, j) => (a[j] = s[k][i]));
    out[k] = a;
  }
  for (const k of INT_KEYS) {
    const a = new Int32Array(keep.length);
    keep.forEach((i, j) => (a[j] = s[k][i]));
    out[k] = a;
  }
  return out;
}
