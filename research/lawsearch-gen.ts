// 法則探し (docs §8.136, research/lawsearch-spec.md 14.1): the synthetic prices of the study, written as GMO's day
// files and read back through the same loadTf as real data (analog's walkfiles path). A new function that widens
// trend-data's walk5; walk5 itself is not changed. Builder A of research/lawsearch-design.md 4.2.
//
// The walk (fixed now, and never changed after the trial seeds 901-920 set the strengths, spec 14.1 決めた後は変えない):
//   * one minute at a time on GMO's week (trend-data walkOpen: Sunday 22:00 UTC to Friday 21:00 UTC in the US summer,
//     22:00 UTC otherwise; 12/25 and 1/1 shut), from GenSpec.fromMs while t + 1 min <= GenSpec.toMs;
//   * the move of a minute is a t-distribution with 4 degrees of freedom divided by sqrt 2 (variance 1), made from a
//     normal z and chi-squared_4 as z / sqrt(chi2_4 / 4), the normals by mulberry32 and Box-Muller (walk5's form);
//   * the pairs share a dollar move U and a yen move Y (spec 14.1, decided values, not measured correlations);
//   * the size of a minute is GEN_MINUTE_PIPS × GEN_HOUR_MULT[UTC hour] × exp(x_D), x_D = 0.9 x_{D-1} + 0.15 eps_D,
//     one x for the five pairs, updated when the GMO day (gmoDayKey) changes;
//   * after a closure each pair's mid jumps by three 15-minute moves (walk5's jump, no hour factor);
//   * the mid is kept in price units and rounded to GMO's tick (0.1 pip) at every minute end; the spread is the
//     median of research/ledger/spread-hours-h1.csv for the pair, New York season and UTC 15-minute slot, or its p90
//     on one slot in ten (a draw per slot and pair); Bid = mid − floor(spread ÷ 2) ticks, Ask = Bid + spread;
//   * 5-minute bars are made from the minutes, then trend-data's coarsen makes the 15-minute and 1-hour bars.
//
// The effects of spec 14.2 (their own formulas, written here apart from the study's) push the minute moves after the
// bar that gives the signal has closed; nothing before the close is changed. Their strengths are GEN_STRENGTH, null
// until the trial seeds 901-920 set them (14.3): a formal effect run refuses until then.

import { coarsen, keysFor, walkOpen } from "./trend-data.ts";
import { type Bars, emptyBars } from "./trend-labels.ts";
import { gmoDayKey } from "./ownerhold-data.ts";
import { GMO_INTERVALS, GMO_SYMBOLS } from "../supabase/functions/track-outcomes/quotes.ts";
import { nyOffsetMs } from "../supabase/functions/_shared/market-hours.ts";
import { CSV_HEADER, SEASONS, SLOTS, type Season, avoidKey, hhmm, seasonOf, slotOf } from "./spreadhours-lib.ts";
import { HOUR, MINUTE } from "./lib.ts";
import { END, MID_DIGITS, PAIRS, POINTS_PER_PRICE, S0, SPREAD_H1_SHA256 } from "./lawsearch-const.ts";
import { SET_SEEDS, TRIAL_SEEDS } from "./lawsearch-rules.ts";
import type { GenGroup, GenManifest, GenSpec, Pair, TfKey } from "./lawsearch-types.ts";

export const GEN_VERSION = "lawsearch-gen 1";

// spec 14.1 始値 (lawsearch-bars.ts imports this one for the synthetic band of spec 15)
export const GEN_START: Readonly<Record<Pair, number>> = { "USD/JPY": 110.0, "EUR/JPY": 125.0, "AUD/JPY": 80.0, "EUR/USD": 1.1, "AUD/USD": 0.7 };
// spec 14.1 1分の動きの大きさ: 1.0 pip on the yen pairs, 0.6 pip on the dollar pairs
export const GEN_MINUTE_PIPS: Readonly<Record<Pair, number>> = { "USD/JPY": 1.0, "EUR/JPY": 1.0, "AUD/JPY": 1.0, "EUR/USD": 0.6, "AUD/USD": 0.6 };
// spec 14.1: the UTC hour's factor, 00-06 0.8, 07-15 1.2, 16-20 1.0, 21-23 0.6
export const GEN_HOUR_MULT: readonly number[] = [
  0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8,
  1.2, 1.2, 1.2, 1.2, 1.2, 1.2, 1.2, 1.2, 1.2,
  1.0, 1.0, 1.0, 1.0, 1.0,
  0.6, 0.6, 0.6,
];
// spec 14.3: the effects' amounts, in units of the pair's GEN_MINUTE_PIPS per minute (D, H, E15, E1h, EF) or of
// GEN_MINUTE_PIPS × sqrt 5 (Q's jitter). Written after the trial seeds 901-920, before any formal effect run; null
// until then, and a formal effect run refuses while its amount is null.
export const GEN_STRENGTH: Readonly<Record<GenGroup, number | null>> = {
  N: null,
  R: null,
  D: null,
  H: null,
  E15: null,
  E1h: null,
  EF: null,
  Q: null,
  O: null,
  C: null,
};

const GROUPS: readonly GenGroup[] = ["N", "R", "D", "H", "E15", "E1h", "EF", "Q", "O", "C"];
const EFFECTS: readonly GenGroup[] = ["D", "H", "E15", "E1h", "EF", "Q"];
// the trial's smoke runs may carry a provisional amount on these sets only (lawsearch-design.md 4.2)
const SMOKE_EFFECTS: readonly GenGroup[] = ["D", "H", "E15", "EF"];

const refuse = (what: string): never => {
  throw new Error("REFUSED: " + what);
};

// ---- spread-hours-h1.csv's values (spec 6 ⑥ / 14.1 スプレッド) ------------------------------------------------

export interface SpreadCell {
  // pips as written (2 decimals for the median, 1 for the p90) and the same in hundredths of a pip (exact integers)
  median: number;
  p90: number;
  medianHundredths: number;
  p90Hundredths: number;
}

// "12.30" → 1230, "0.6" → 60: a non-negative decimal with at most two decimals, read as hundredths without a double
const hundredthsOf = (text: string, at: string): number => {
  const m = /^([0-9]+)(?:\.([0-9]{1,2}))?$/.exec(text);
  if (!m) throw new Error(`${at}: ${JSON.stringify(text)} is not a decimal with at most two decimals`);
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
};

// spread-hours-h1.csv read for the generator: the same checks as spreadhours-lib parseSpreadHours (the header, 11
// cells, the five pairs, both seasons, slots 0-95 with their UTC text, avoid yes/no, no row twice, 960 rows), plus
// a median and a p90 on every row (the walk needs every cell)
export function parseSpreadValues(text: string): Map<string, SpreadCell> {
  const lines = text.split("\n").filter((l) => l !== "");
  if (lines[0] !== CSV_HEADER) throw new Error(`spread-hours-h1.csv: the header is ${JSON.stringify(lines[0])}`);
  const out = new Map<string, SpreadCell>();
  for (const [k, l] of lines.slice(1).entries()) {
    const c = l.split(",");
    const at = `spread-hours-h1.csv row ${k + 1}`;
    if (c.length !== 11) throw new Error(`${at}: ${c.length} cells`);
    const [pair, season, slotText, utc, , median, , p90, , , avoid] = c;
    const slot = Number(slotText);
    if (!(PAIRS as readonly string[]).includes(pair) || !(SEASONS as readonly string[]).includes(season) || !Number.isInteger(slot) || slot < 0 || slot >= SLOTS || utc !== hhmm(slot)) {
      throw new Error(`${at}: ${l}`);
    }
    if (avoid !== "yes" && avoid !== "no") throw new Error(`${at}: avoid ${avoid}`);
    const key = avoidKey(pair, season as Season, slot);
    if (out.has(key)) throw new Error(`${at}: ${key} twice`);
    const medianHundredths = hundredthsOf(median, `${at} median`);
    const p90Hundredths = hundredthsOf(p90, `${at} p90`);
    out.set(key, { median: Number(median), p90: Number(p90), medianHundredths, p90Hundredths });
  }
  if (out.size !== PAIRS.length * 2 * SLOTS) throw new Error(`spread-hours-h1.csv: ${out.size} rows, not ${PAIRS.length * 2 * SLOTS}`);
  return out;
}

// ---- the run's settings ------------------------------------------------------------------------------------------

const inRange = (x: number, r: readonly [number, number]): boolean => x >= r[0] && x <= r[1];

// set C (lawsearch-design.md 4.2, 10): the bars removed from the written files and the day files written empty
const C_DROP: GenSpec["drop"] = [
  { pair: "USD/JPY", tf: "m15", fromMs: Date.parse("2024-03-05T10:00:00Z"), toMs: Date.parse("2024-03-05T11:30:00Z") },
  { pair: "EUR/USD", tf: "h1", fromMs: Date.parse("2024-06-11T08:00:00Z"), toMs: Date.parse("2024-06-11T10:00:00Z") },
  { pair: "AUD/JPY", tf: "m15", fromMs: Date.parse("2025-08-13T13:15:00Z"), toMs: Date.parse("2025-08-13T13:45:00Z") },
  { pair: "EUR/JPY", tf: "m15", fromMs: Date.parse("2026-02-17T07:00:00Z"), toMs: Date.parse("2026-02-17T07:15:00Z") },
];
const C_EMPTY: GenSpec["emptyDays"] = [
  { pair: "AUD/USD", tf: "m15", key: "20240918" },
  { pair: "USD/JPY", tf: "h1", key: "20250911" },
];

// The run's GenSpec from the environment (GEN, SEED, FLIP, STRENGTH). Throws "REFUSED: …" for any setting the
// design does not allow:
//   * a formal set accepts only its seeds (SET_SEEDS; N also 1101-1500, spec 11's new N seeds for κ; R the N seeds,
//     spec 14.2 "N と同じ run"); an effect set refuses a formal seed while GEN_STRENGTH is null, and STRENGTH is never
//     taken on a formal seed;
//   * the smoke seeds (TRIAL_SEEDS.smoke) take STRENGTH, marked provisional, on D, H, E15 and EF only;
//   * C takes only TRIAL_SEEDS.holes; FLIP=1 only on SET_SEEDS.flip (set N) and on the smoke seeds;
//   * the trial seeds 901-920 (14.3's strength runs) are not designed yet and refuse.
export function genSpecOf(env: { GEN?: string; SEED?: string; FLIP?: string; STRENGTH?: string }): GenSpec {
  const group = env.GEN as GenGroup;
  if (!GROUPS.includes(group)) refuse(`GEN ${JSON.stringify(env.GEN)} is not one of ${GROUPS.join(" ")}`);
  if (env.SEED === undefined || !/^[0-9]+$/.test(env.SEED)) refuse(`SEED ${JSON.stringify(env.SEED)} is not a whole number`);
  const seed = Number(env.SEED);
  let flip = false;
  if (env.FLIP === "1") flip = true;
  else if (env.FLIP !== undefined && env.FLIP !== "" && env.FLIP !== "0") refuse(`FLIP ${JSON.stringify(env.FLIP)} is not 0 or 1`);
  const hasStrength = env.STRENGTH !== undefined && env.STRENGTH !== "";
  let strength: number | null = null;
  let strengthNote = "";
  let drop: GenSpec["drop"] = [];
  let emptyDays: GenSpec["emptyDays"] = [];
  if (inRange(seed, SET_SEEDS.trialCalib)) refuse(`seed ${seed}: the strength runs on 901-920 (spec 14.3) are step 4 and not designed yet`);
  if (inRange(seed, TRIAL_SEEDS.smoke)) {
    if (!SMOKE_EFFECTS.includes(group)) refuse(`smoke seed ${seed}: only ${SMOKE_EFFECTS.join(" ")} (GEN ${group})`);
    if (!hasStrength) refuse(`smoke seed ${seed}: STRENGTH is needed`);
    const v = Number(env.STRENGTH);
    if (!Number.isFinite(v) || !(v > 0)) refuse(`STRENGTH ${JSON.stringify(env.STRENGTH)} is not a positive number`);
    strength = v;
    strengthNote = "provisional";
  } else {
    if (hasStrength) refuse(`STRENGTH is taken on the smoke seeds only (seed ${seed})`);
    if (group === "C") {
      if (!inRange(seed, TRIAL_SEEDS.holes)) refuse(`C takes only seed ${TRIAL_SEEDS.holes[0]} (seed ${seed})`);
      drop = C_DROP.map((x) => ({ ...x }));
      emptyDays = C_EMPTY.map((x) => ({ ...x }));
    } else {
      const ranges: ReadonlyArray<readonly [number, number]> = group === "N"
        ? [SET_SEEDS.N, SET_SEEDS.calibKappa]
        : group === "R"
        ? [SET_SEEDS.N]
        : group === "O"
        ? [SET_SEEDS.O]
        : [SET_SEEDS[group as "D" | "H" | "E15" | "E1h" | "EF" | "Q"]];
      if (!ranges.some((r) => inRange(seed, r))) refuse(`${group} does not take seed ${seed} (${ranges.map((r) => `${r[0]}-${r[1]}`).join(", ")})`);
      if (EFFECTS.includes(group)) {
        strength = GEN_STRENGTH[group];
        if (strength === null) refuse(`${group}: the effect's strength is not written yet (spec 14.3: the trial seeds 901-920 first)`);
      }
    }
  }
  if (flip && !((group === "N" && inRange(seed, SET_SEEDS.flip)) || inRange(seed, TRIAL_SEEDS.smoke))) {
    refuse(`FLIP=1 is taken on N ${SET_SEEDS.flip[0]}-${SET_SEEDS.flip[1]} and the smoke seeds only (${group} ${seed})`);
  }
  return { group, seed, flip, fromMs: S0, toMs: END, strength, strengthNote, drop, emptyDays };
}

// ---- random streams (mulberry32 as trend-data's rng, Box-Muller as walk5's gauss) --------------------------------

const mulberry32 = (seed: number) => {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};
interface Stream {
  uniform: () => number;
  gauss: () => number;
  // spec 14.1: t with 4 degrees of freedom ÷ sqrt 2, from z and four more normals of the same stream
  shock: () => number;
}
const streamOf = (seed: number): Stream => {
  const uniform = mulberry32(seed);
  let spare: number | null = null;
  const gauss = () => {
    if (spare !== null) {
      const v = spare;
      spare = null;
      return v;
    }
    let u = 0;
    while (u === 0) u = uniform();
    const v = uniform();
    const r = Math.sqrt(-2 * Math.log(u));
    spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  };
  const shock = () => {
    const z = gauss();
    const n1 = gauss();
    const n2 = gauss();
    const n3 = gauss();
    const n4 = gauss();
    return z / Math.sqrt((n1 * n1 + n2 * n2 + n3 * n3 + n4 * n4) / 4) / Math.SQRT2;
  };
  return { uniform, gauss, shock };
};

// ---- the walk -----------------------------------------------------------------------------------------------------

const M5 = 5 * MINUTE;
const M15 = 15 * MINUTE;
// spec 14.2: the effects' pushes last N = 8 bars of open minutes
const PUSH_E15 = 8 * 15;
const PUSH_1H = 8 * 60;

interface Push {
  left: number;
  amount: number;
}

// One pair's 5-minute bars in ticks (integers), before they become a Bars
interface Ticks {
  n: number;
  t: Float64Array;
  mo: Float64Array;
  mh: Float64Array;
  ml: Float64Array;
  mc: Float64Array;
  sp: Float64Array;
}

// the generator's own E04 (spec 14.2 E15): Wilder's RSI14 on the 15-minute mid closes, seeded by the mean of the
// first 14 changes; BUY when the previous value ≤ 30 < the value, SELL when the previous ≥ 70 > the value
class OwnRsi {
  n = 0;
  prev = NaN;
  sumUp = 0;
  sumDn = 0;
  U = NaN;
  D = NaN;
  prevRsi = NaN;
  readonly alpha = 1 / 14;
  readonly oneMinus = 1 - 1 / 14;
  next(c: number): 0 | 1 | -1 {
    let sig: 0 | 1 | -1 = 0;
    if (this.n >= 1) {
      const ch = c - this.prev;
      const up = ch > 0 ? ch : 0;
      const dn = ch < 0 ? -ch : 0;
      if (this.n <= 14) {
        this.sumUp += up;
        this.sumDn += dn;
        if (this.n === 14) {
          this.U = this.sumUp / 14;
          this.D = this.sumDn / 14;
        }
      } else {
        this.U = this.alpha * up + this.oneMinus * this.U;
        this.D = this.alpha * dn + this.oneMinus * this.D;
      }
      if (this.n >= 14) {
        const rsi = this.D === 0 ? 100 : this.U === 0 ? 0 : 100 - 100 / (1 + this.U / this.D);
        if (Number.isFinite(this.prevRsi)) {
          if (this.prevRsi <= 30 && rsi > 30) sig = 1;
          else if (this.prevRsi >= 70 && rsi < 70) sig = -1;
        }
        this.prevRsi = rsi;
      }
    }
    this.prev = c;
    this.n++;
    return sig;
  }
}

// the generator's own E37 (spec 14.2 E1h): parabolic SAR (0.02, 0.2) on its 1-hour mid bars (spec 3.2's form); a
// change of long is the signal (+1 to long, −1 to short)
class OwnSar {
  n = 0;
  h0 = NaN;
  l0 = NaN;
  c0 = NaN;
  h1 = NaN;
  l1 = NaN;
  up = false;
  s = NaN;
  ep = NaN;
  af = 0.02;
  next(H: number, L: number, C: number): 0 | 1 | -1 {
    let sig: 0 | 1 | -1 = 0;
    if (this.n === 0) {
      this.h0 = H;
      this.l0 = L;
      this.c0 = C;
    } else if (this.n === 1) {
      this.up = C > this.c0;
      this.s = this.up ? this.l0 : this.h0;
      this.ep = this.up ? H : L;
      this.af = 0.02;
      this.h1 = H;
      this.l1 = L;
    } else {
      const was = this.up;
      let nx = this.s + this.af * (this.ep - this.s);
      if (this.up) {
        nx = Math.min(nx, this.l1, this.l0);
        if (L < nx) {
          this.up = false;
          nx = this.ep;
          this.ep = L;
          this.af = 0.02;
        } else if (H > this.ep) {
          this.ep = H;
          this.af = Math.min(this.af + 0.02, 0.2);
        }
      } else {
        nx = Math.max(nx, this.h1, this.h0);
        if (H > nx) {
          this.up = true;
          nx = this.ep;
          this.ep = H;
          this.af = 0.02;
        } else if (L < this.ep) {
          this.ep = L;
          this.af = Math.min(this.af + 0.02, 0.2);
        }
      }
      this.s = nx;
      if (this.up !== was) sig = this.up ? 1 : -1;
      // bar i−2 and i−1 for the next bar
      this.h0 = this.h1;
      this.l0 = this.l1;
      this.h1 = H;
      this.l1 = L;
    }
    this.n++;
    return sig;
  }
}

// the generator's own EMA200 (spec 14.2 EF) of the 1-hour mid closes: seeded by the mean of the first 200 closes
class OwnEma {
  n = 0;
  sum = 0;
  ema = NaN;
  readonly alpha = 2 / 201;
  readonly oneMinus = 1 - 2 / 201;
  next(c: number): number {
    if (this.n < 200) {
      this.sum += c;
      if (this.n === 199) this.ema = this.sum / 200;
    } else {
      this.ema = this.alpha * c + this.oneMinus * this.ema;
    }
    this.n++;
    return this.ema;
  }
}

const symOf = (pair: Pair): string => GMO_SYMBOLS[pair];

// The walk of all five pairs (they share U, Y and the day's factor, so they are made together). The 5-minute bars
// are on GMO's grid (start = floor(t ÷ 5 min) × 5 min); the 15-minute and 1-hour bars are trend-data's coarsen of
// them. effectSignals counts the effect's own signals per pair (E15, E1h: "<SYM>.buy" / "<SYM>.sell"; EF: the
// EMA200 side's changes, "<SYM>.up" / "<SYM>.down").
export function generate(spec: GenSpec, spread: Map<string, SpreadCell>): { bars: Record<Pair, { m5: Bars; m15: Bars; h1: Bars }>; effectSignals: Record<string, number> } {
  if (!GROUPS.includes(spec.group)) throw new Error(`generate: group ${spec.group}`);
  if (!(spec.fromMs % MINUTE === 0) || !(spec.toMs > spec.fromMs)) throw new Error(`generate: period ${spec.fromMs}..${spec.toMs}`);
  const effect = EFFECTS.includes(spec.group);
  const s = effect ? spec.strength : null;
  if (effect && (s === null || !Number.isFinite(s))) throw new Error(`generate: ${spec.group} without a strength`);
  const strength = s ?? 0;
  const P = PAIRS.length;
  const pairs = PAIRS as readonly Pair[];
  const scale = pairs.map((p) => POINTS_PER_PRICE(p));
  const pipSize = pairs.map((p) => (p.endsWith("JPY") ? 0.01 : 0.0001));
  const mpips = pairs.map((p) => GEN_MINUTE_PIPS[p]);
  const mid = pairs.map((p) => GEN_START[p]);
  const seed = spec.seed;
  const own = pairs.map((_, pi) => streamOf(seed * 1009 + pi * 7919 + 14001));
  const sU = streamOf(seed * 1009 + 14101);
  const sY = streamOf(seed * 1009 + 14201);
  const sDay = streamOf(seed * 1009 + 14301);
  const sWide = streamOf(seed * 1009 + 14401);
  const sQ = streamOf(seed * 1009 + 14501);

  // the spread's ticks per pair, season (summer 0, winter 1) and slot: the median and the p90
  const cellTicks = (h: number) => Math.floor((h + 5) / 10);
  const medT: Int32Array[] = [];
  const p90T: Int32Array[] = [];
  for (const pair of pairs) {
    const m = new Int32Array(2 * SLOTS);
    const q = new Int32Array(2 * SLOTS);
    for (const [si, season] of SEASONS.entries()) {
      for (let slot = 0; slot < SLOTS; slot++) {
        const cell = spread.get(avoidKey(pair, season, slot));
        if (!cell) throw new Error(`generate: no spread cell ${avoidKey(pair, season, slot)}`);
        m[si * SLOTS + slot] = cellTicks(cell.medianHundredths);
        q[si * SLOTS + slot] = cellTicks(cell.p90Hundredths);
      }
    }
    medT.push(m);
    p90T.push(q);
  }

  const cap = Math.ceil((spec.toMs - spec.fromMs) / M5) + 1;
  const tk: Ticks[] = pairs.map(() => ({ n: 0, t: new Float64Array(cap), mo: new Float64Array(cap), mh: new Float64Array(cap), ml: new Float64Array(cap), mc: new Float64Array(cap), sp: new Float64Array(cap) }));
  const effectSignals: Record<string, number> = {};
  const count = (key: string) => {
    effectSignals[key] = (effectSignals[key] ?? 0) + 1;
  };
  const pushes: Push[][] = pairs.map(() => []);
  const rsi = spec.group === "E15" ? pairs.map(() => new OwnRsi()) : null;
  const sar = spec.group === "E1h" ? pairs.map(() => new OwnSar()) : null;
  const ema = spec.group === "EF" ? pairs.map(() => new OwnEma()) : null;
  const efSide = new Int8Array(P);

  // the current 5-minute bar and 1-hour bar of each pair, in ticks
  let cur5 = NaN;
  const o5 = new Float64Array(P), h5 = new Float64Array(P), l5 = new Float64Array(P), c5 = new Float64Array(P), sp5 = new Float64Array(P);
  let curH = NaN;
  const hh = new Float64Array(P), hl = new Float64Array(P);
  const spreadT = new Float64Array(P);
  let curSlot = NaN;
  // per UTC hour: walkOpen, the GMO day, the hour's factor, New York's local hour, the season's row (all constant
  // within an hour: their rules change on whole hours)
  let hourKey = NaN;
  let hourOpen = false;
  let hourDay = "";
  let hourMult = 0;
  let nyHour = 0;
  let seasonRow = 0;
  let lastDay = "";
  let x = 0;
  let dayFactor = 1;
  let shut = false;
  const tick = (pi: number) => Math.floor(mid[pi] * scale[pi] + 0.5);
  const close5 = () => {
    if (!Number.isFinite(cur5)) return;
    for (let pi = 0; pi < P; pi++) {
      const b = tk[pi];
      const k = b.n++;
      b.t[k] = cur5 * M5;
      b.mo[k] = o5[pi];
      b.mh[k] = h5[pi];
      b.ml[k] = l5[pi];
      b.mc[k] = c5[pi];
      b.sp[k] = sp5[pi];
    }
  };

  for (let t = spec.fromMs; t + MINUTE <= spec.toMs; t += MINUTE) {
    const hk = Math.floor(t / HOUR);
    if (hk !== hourKey) {
      hourKey = hk;
      hourOpen = walkOpen(t);
      hourDay = gmoDayKey(t);
      hourMult = GEN_HOUR_MULT[new Date(t).getUTCHours()];
      nyHour = new Date(t + nyOffsetMs(t)).getUTCHours();
      seasonRow = seasonOf(t) === "summer" ? 0 : 1;
    }
    if (!hourOpen) {
      shut = true;
      continue;
    }
    // after a closure: the jump (walk5's: three 15-minute moves, no hour factor)
    if (shut) {
      for (let pi = 0; pi < P; pi++) mid[pi] += 3 * mpips[pi] * Math.sqrt(15) * own[pi].gauss() * pipSize[pi];
      shut = false;
    }
    if (hourDay !== lastDay) {
      x = 0.9 * x + 0.15 * sDay.gauss();
      dayFactor = Math.exp(x);
      lastDay = hourDay;
    }
    const sk = Math.floor(t / M15);
    if (sk !== curSlot) {
      curSlot = sk;
      const slot = slotOf(t);
      for (let pi = 0; pi < P; pi++) {
        const u = sWide.uniform();
        spreadT[pi] = u < 0.1 ? p90T[pi][seasonRow * SLOTS + slot] : medT[pi][seasonRow * SLOTS + slot];
      }
    }
    const b5 = Math.floor(t / M5);
    if (b5 !== cur5) {
      close5();
      cur5 = b5;
      for (let pi = 0; pi < P; pi++) {
        const v = tick(pi);
        o5[pi] = v;
        h5[pi] = v;
        l5[pi] = v;
        c5[pi] = v;
        sp5[pi] = spreadT[pi];
      }
    }
    if (hk !== curH) {
      curH = hk;
      for (let pi = 0; pi < P; pi++) {
        const v = tick(pi);
        hh[pi] = v;
        hl[pi] = v;
      }
    }
    // the minute's moves
    const eU = sU.shock();
    const eY = sY.shock();
    for (let pi = 0; pi < P; pi++) {
      const e = own[pi].shock();
      const comb = pi === 0 ? 0.5 * eU - 0.5 * eY + Math.SQRT1_2 * e : pi <= 2 ? -0.6 * eY + 0.8 * e : -0.6 * eU + 0.8 * e;
      let push = 0;
      if (spec.group === "D") push += strength * mpips[pi];
      else if (spec.group === "H" && pi === 3) {
        if (nyHour >= 3 && nyHour < 9) push -= strength * mpips[pi];
        else if (nyHour >= 11 && nyHour < 15) push += strength * mpips[pi];
      }
      const ps = pushes[pi];
      if (ps.length) {
        for (const q of ps) {
          push += q.amount;
          q.left--;
        }
        if (ps.some((q) => q.left <= 0)) pushes[pi] = ps.filter((q) => q.left > 0);
      }
      mid[pi] += (comb * mpips[pi] * hourMult * dayFactor + push) * pipSize[pi];
      const v = tick(pi);
      if (v > h5[pi]) h5[pi] = v;
      if (v < l5[pi]) l5[pi] = v;
      c5[pi] = v;
      if (v > hh[pi]) hh[pi] = v;
      if (v < hl[pi]) hl[pi] = v;
    }
    // the closes at the minute's end: the effects' signals (their pushes start with the next open minute)
    const te = t + MINUTE;
    if (rsi && te % M15 === 0) {
      for (let pi = 0; pi < P; pi++) {
        const d = rsi[pi].next(c5[pi]);
        if (d !== 0) {
          pushes[pi].push({ left: PUSH_E15, amount: d * strength * mpips[pi] });
          count(`${symOf(pairs[pi])}.${d === 1 ? "buy" : "sell"}`);
        }
      }
    }
    if (te % HOUR === 0 && (sar || ema)) {
      for (let pi = 0; pi < P; pi++) {
        if (sar) {
          const d = sar[pi].next(hh[pi], hl[pi], c5[pi]);
          if (d !== 0) {
            pushes[pi].push({ left: PUSH_1H, amount: d * strength * mpips[pi] });
            count(`${symOf(pairs[pi])}.${d === 1 ? "buy" : "sell"}`);
          }
        }
        if (ema) {
          const e = ema[pi].next(c5[pi]);
          if (Number.isFinite(e)) {
            const side = c5[pi] > e ? 1 : c5[pi] < e ? -1 : 0;
            if (side !== 0) {
              pushes[pi].push({ left: PUSH_1H, amount: side * strength * mpips[pi] });
              if (side !== efSide[pi]) {
                count(`${symOf(pairs[pi])}.${side === 1 ? "up" : "down"}`);
                efSide[pi] = side;
              }
            }
          }
        }
      }
    }
  }
  close5();

  // Q (spec 14.2): the last 5-minute close of each 15-minute bar and the next 15-minute bar's first 5-minute open get
  // the same jitter J (both sides; high and low widened to hold it); the next 5-minute close is the walk's own.
  // One draw per boundary and pair (boundaries in time order, pairs in PAIRS order).
  if (spec.group === "Q") {
    const n = tk[0].n;
    for (let k = 0; k + 1 < n; k++) {
      if (Math.floor(tk[0].t[k] / M15) === Math.floor(tk[0].t[k + 1] / M15)) continue;
      for (let pi = 0; pi < P; pi++) {
        const b = tk[pi];
        const J = Math.round(strength * mpips[pi] * Math.sqrt(5) * sQ.gauss() * 10);
        if (J === 0) continue;
        b.mc[k] += J;
        if (b.mc[k] > b.mh[k]) b.mh[k] = b.mc[k];
        if (b.mc[k] < b.ml[k]) b.ml[k] = b.mc[k];
        b.mo[k + 1] += J;
        if (b.mo[k + 1] > b.mh[k + 1]) b.mh[k + 1] = b.mo[k + 1];
        if (b.mo[k + 1] < b.ml[k + 1]) b.ml[k + 1] = b.mo[k + 1];
      }
    }
  }

  // Bid and Ask in ticks, then the flip (14.2 裏返し: about the pair's start S in ticks, Bid' = 2S − Ask, Ask' =
  // 2S − Bid, high' from low), then the Bars (ticks ÷ scale) and the coarser bars
  const bars = {} as Record<Pair, { m5: Bars; m15: Bars; h1: Bars }>;
  // the GMO day key changes on whole hours (21:00 UTC), so it is looked up once per hour
  let keyHour = NaN;
  let keyNum = 0;
  const keyOf = (t: number) => {
    const h = Math.floor(t / HOUR);
    if (h !== keyHour) {
      keyHour = h;
      keyNum = Number(gmoDayKey(t));
    }
    return keyNum;
  };
  for (let pi = 0; pi < P; pi++) {
    const pair = pairs[pi];
    const b = tk[pi];
    const out = emptyBars(b.n);
    const S = Math.round(GEN_START[pair] * scale[pi]);
    const sc = scale[pi];
    for (let k = 0; k < b.n; k++) {
      const sp = b.sp[k];
      const half = Math.floor(sp / 2);
      let bo = b.mo[k] - half, bh = b.mh[k] - half, bl = b.ml[k] - half, bc = b.mc[k] - half;
      let ao = bo + sp, ah = bh + sp, al = bl + sp, ac = bc + sp;
      if (spec.flip) {
        [bo, bh, bl, bc, ao, ah, al, ac] = [2 * S - ao, 2 * S - al, 2 * S - ah, 2 * S - ac, 2 * S - bo, 2 * S - bl, 2 * S - bh, 2 * S - bc];
      }
      if (!(bl > 0)) throw new Error(`${pair} seed ${spec.seed}: the walk reached 0 at ${new Date(b.t[k]).toISOString()}`);
      out.t[k] = b.t[k];
      out.bo[k] = bo / sc;
      out.bh[k] = bh / sc;
      out.bl[k] = bl / sc;
      out.bc[k] = bc / sc;
      out.ao[k] = ao / sc;
      out.ah[k] = ah / sc;
      out.al[k] = al / sc;
      out.ac[k] = ac / sc;
      out.key[k] = keyOf(b.t[k]);
    }
    bars[pair] = { m5: out, m15: coarsen(out, "15min"), h1: coarsen(out, "1h") };
  }
  return { bars, effectSignals };
}

// ---- the files ----------------------------------------------------------------------------------------------------

// ticks as GMO's decimal text with the pair's digits ("150102" → "150.102"; exact, no double arithmetic)
const decOf = (ticks: number, digits: number): string => {
  if (!Number.isInteger(ticks) || ticks <= 0) throw new Error(`decOf: ${ticks}`);
  const s = String(ticks).padStart(digits + 1, "0");
  return `${s.slice(0, s.length - digits)}.${s.slice(s.length - digits)}`;
};

const pool = async <T>(items: T[], n: number, f: (x: T) => Promise<void>) => {
  let cursor = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (cursor < items.length) await f(items[cursor++]);
  }));
};

// One pair and timeframe written as GMO's day files under dir (<dir>/<SYM>/<15min|1hour>/<bid|ask>/<key>.json), as
// trend-data writeWalk does: every key a read of [fromMs, toMs) opens (keysFor) and every key the bars are filed
// under (Bars.key, the GMO day), {"status":0,"data":[…]} per side, an empty list for a day without bars; the keys of
// emptyKeys are written empty. Returns the number of files written.
export async function writeTf(dir: string, pair: Pair, tf: TfKey, bars: Bars, fromMs: number, toMs: number, emptyKeys: ReadonlySet<string>): Promise<number> {
  const tfName = tf === "m15" ? "15min" : "1h";
  const symbol = GMO_SYMBOLS[pair];
  const interval = GMO_INTERVALS[tfName].name;
  const sc = POINTS_PER_PRICE(pair);
  const dg = MID_DIGITS(pair);
  const ticksOf = (v: number) => {
    const r = Math.round(v * sc);
    if (!(Math.abs(v * sc - r) < 1e-6)) throw new Error(`writeTf ${pair}: ${v} is not on the tick grid`);
    return r;
  };
  const files = new Map<string, { bid: unknown[]; ask: unknown[] }>();
  for (let i = 0; i < bars.n; i++) {
    const key = String(bars.key[i]);
    let d = files.get(key);
    if (!d) files.set(key, (d = { bid: [], ask: [] }));
    const ot = String(bars.t[i]);
    d.bid.push({ openTime: ot, open: decOf(ticksOf(bars.bo[i]), dg), high: decOf(ticksOf(bars.bh[i]), dg), low: decOf(ticksOf(bars.bl[i]), dg), close: decOf(ticksOf(bars.bc[i]), dg) });
    d.ask.push({ openTime: ot, open: decOf(ticksOf(bars.ao[i]), dg), high: decOf(ticksOf(bars.ah[i]), dg), low: decOf(ticksOf(bars.al[i]), dg), close: decOf(ticksOf(bars.ac[i]), dg) });
  }
  const { keys } = keysFor(tfName, fromMs, toMs);
  const all = [...new Set([...keys, ...files.keys()])];
  for (const side of ["bid", "ask"] as const) await Deno.mkdir(`${dir}/${symbol}/${interval}/${side}`, { recursive: true });
  let written = 0;
  await pool(all, 16, async (key) => {
    const d = emptyKeys.has(key) ? { bid: [], ask: [] } : files.get(key) ?? { bid: [], ask: [] };
    for (const side of ["bid", "ask"] as const) {
      await Deno.writeTextFile(`${dir}/${symbol}/${interval}/${side}/${key}.json`, JSON.stringify({ status: 0, data: d[side] }));
      written++;
    }
  });
  return written;
}

const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, "0")).join("");
const enc = new TextEncoder();
const byteCompare = (a: string, b: string): number => {
  const x = enc.encode(a);
  const y = enc.encode(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return x.length - y.length;
};

// lawsearch-dump.md 1: every file under gmoDir by its path relative to gmoDir ("/"), sorted by UTF-8 bytes, one line
// "<path>\t<sha256 hex>\n" each; the sha256 of that text. keep: every file's bytes are kept too (treeBytes)
const treeWalk = async (gmoDir: string, keep: Map<string, Uint8Array> | null): Promise<{ files: number; sha256: string }> => {
  const paths: string[] = [];
  const walk = async (rel: string) => {
    for await (const e of Deno.readDir(rel === "" ? gmoDir : `${gmoDir}/${rel}`)) {
      const p = rel === "" ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory) await walk(p);
      else if (e.isFile) paths.push(p);
      else throw new Error(`treeSha256: ${p} is neither a file nor a folder`);
    }
  };
  await walk("");
  paths.sort(byteCompare);
  const lines: string[] = new Array(paths.length);
  await pool(paths.map((p, i) => [p, i] as const), 16, async ([p, i]) => {
    const b = await Deno.readFile(`${gmoDir}/${p}`);
    if (keep !== null) keep.set(p, b);
    lines[i] = `${p}\t${hex(await crypto.subtle.digest("SHA-256", b))}\n`;
  });
  return { files: paths.length, sha256: hex(await crypto.subtle.digest("SHA-256", enc.encode(lines.join("")))) };
};
export const treeSha256 = (gmoDir: string): Promise<{ files: number; sha256: string }> => treeWalk(gmoDir, null);

// C4g (the lead's G1, from the C4g designer "harden"): treeSha256's walk and digest, keeping every file's bytes by its
// path relative to gmoDir. The program reads the run's files once, here (gate 3), checks this digest of exactly these
// bytes against the manifest, and builds the three stages' universes from them before any main-run code runs; the
// retrace (13 (iv)) reads them too. Nothing in the run reads a gmo file from the disk again.
export async function treeBytes(gmoDir: string): Promise<{ files: number; sha256: string; bytes: ReadonlyMap<string, Uint8Array> }> {
  const bytes = new Map<string, Uint8Array>();
  const r = await treeWalk(gmoDir, bytes);
  return { ...r, bytes };
}

// A run: <dir>/gmo/… (the 15-minute and 1-hour day files of the five pairs; no 5-minute, 4-hour or 1-minute files,
// which the trial reads none of) and <dir>/manifest.json. The folder must not hold a gmo folder already, and its path
// must not be under a .cache folder.
export async function writeRun(dir: string, spec: GenSpec): Promise<GenManifest> {
  const t0 = Date.now();
  if (dir.split("/").some((p) => p === ".cache")) refuse(`writeRun: ${dir} is under a .cache folder`);
  const gmo = `${dir}/gmo`;
  let exists = true;
  try {
    await Deno.stat(gmo);
  } catch (e) {
    // C4g (the audit of every catch around a Deno API): only "no such file" means no folder; a refused permission
    // stops the run (before C4g it read as "no folder", and the run would have written into an existing one)
    if (!(e instanceof Deno.errors.NotFound)) throw e;
    exists = false;
  }
  if (exists) refuse(`writeRun: ${gmo} exists already`);
  const raw = await Deno.readFile(new URL("./ledger/spread-hours-h1.csv", import.meta.url));
  const got = hex(await crypto.subtle.digest("SHA-256", raw));
  if (got !== SPREAD_H1_SHA256) throw new Error(`STOP: research/ledger/spread-hours-h1.csv: sha256 ${got}, not ${SPREAD_H1_SHA256}`);
  const spread = parseSpreadValues(new TextDecoder().decode(raw));
  const g = generate(spec, spread);
  let written = 0;
  for (const pair of PAIRS as readonly Pair[]) {
    for (const tf of ["m15", "h1"] as const) {
      let b = g.bars[pair][tf];
      const drops = spec.drop.filter((x) => x.pair === pair && x.tf === tf);
      if (drops.length) {
        const keep: number[] = [];
        for (let i = 0; i < b.n; i++) if (!drops.some((x) => b.t[i] >= x.fromMs && b.t[i] < x.toMs)) keep.push(i);
        const nb = emptyBars(keep.length);
        keep.forEach((i, j) => {
          nb.t[j] = b.t[i];
          nb.bo[j] = b.bo[i];
          nb.bh[j] = b.bh[i];
          nb.bl[j] = b.bl[i];
          nb.bc[j] = b.bc[i];
          nb.ao[j] = b.ao[i];
          nb.ah[j] = b.ah[i];
          nb.al[j] = b.al[i];
          nb.ac[j] = b.ac[i];
          nb.key[j] = b.key[i];
        });
        b = nb;
      }
      const empty = new Set(spec.emptyDays.filter((x) => x.pair === pair && x.tf === tf).map((x) => x.key));
      written += await writeTf(gmo, pair, tf, b, spec.fromMs, spec.toMs, empty);
    }
  }
  const tree = await treeSha256(gmo);
  if (tree.files !== written) throw new Error(`writeRun: ${written} files written, ${tree.files} found`);
  const manifest: GenManifest = {
    version: GEN_VERSION,
    spec: { group: spec.group, seed: spec.seed, flip: spec.flip, fromMs: spec.fromMs, toMs: spec.toMs, strength: spec.strength, strengthNote: spec.strengthNote, drop: spec.drop, emptyDays: spec.emptyDays },
    files: tree.files,
    treeSha256: tree.sha256,
    effectSignals: g.effectSignals,
    ms: Date.now() - t0,
  };
  await Deno.writeTextFile(`${dir}/manifest.json`, JSON.stringify(manifest));
  return manifest;
}
