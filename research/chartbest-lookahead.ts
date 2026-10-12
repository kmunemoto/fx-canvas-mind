// #318 (docs §8.113 20 (b) 〔段0〜段2〕): the look-ahead checks of the items — the cut, the poison and the
// presence poison. No follow here (stage 0 runs them); the follow's checks are chartbest-lookfollow.ts.
//
// cut: at every signal of an item and pair (an s0 item over 3,000: 3,000 by mulberry32 seed 318, no repeats),
// 300 evenly spaced bars, the 10 bars before every gap (open-to-open over 5 minutes) and the 2 bars before
// every τ (New York 17:00) and the item's own day bound (SQ-23; these two kinds together capped at 3,000 by
// seed 320), the item is computed again on the bars cut at that bar: from S0 (an s0 item) or from its L_c
// window with the S0 indices (a finite one). The decision (direction or none) and E must equal the whole
// series'. The arrays of the whole run are never cut and compared: the cut series is computed afresh.
// poison: 100 signals and 100 bars without a signal (seed 319): every later bar's prices moved ±777.7 pips in
// turn (bid, ask, OHLC; the mids re-derived), the whole series computed again: the decision and E at T equal.
// presence: the same 100 signals; (i) the 8 bars opening in [T, T + 35 min] deleted, (ii) every bar from T to
// the next Sunday 22:00 UTC deleted; the whole series computed again; equal.
// The sampler: mulberry32 (trend-stats.ts's) and Fisher–Yates (trend-stats.ts shuffle), the first N taken —
// copied here so stage 0 loads no outcome code.

import { type PairBars, keepBars, viewOf, withSides } from "./chartbest-bars.ts";
import { type Dir, POISON_PIPS, type Period, SAMPLE, SEED, STEP } from "./chartbest-const.ts";
import { type ItemDef, eOf, eventsOf, firstDetermined } from "./chartbest-events.ts";
import { nyMidnightsBetween, tausBetween } from "./chartbest-time.ts";
import type { Probe } from "./chartbest-measures.ts";

// trend-stats.ts's mulberry32 and shuffle
export const mulberry32 = (seed: number) => {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};
export const shuffle = <T>(a: T[], rnd: () => number) => {
  for (let i = a.length - 1; i >= 1; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const x = a[i];
    a[i] = a[j];
    a[j] = x;
  }
};
export const sampleOf = <T>(xs: T[], n: number, seed: number): T[] => {
  if (xs.length <= n) return [...xs];
  const a = [...xs];
  shuffle(a, mulberry32(seed));
  return a.slice(0, n);
};

const newProbe = (): Probe => ({ compared: 0, mismatched: 0, examples: [] });
const bad = (p: Probe, what: string) => {
  p.mismatched++;
  if (p.examples.length < 10) p.examples.push(what);
};
const iso = (t: number) => new Date(t).toISOString().slice(0, 16);

// the decision at each bar of the whole series: bar → direction
export interface Decisions {
  dir: Map<number, Dir>;
  first: { buy: number; sell: number };
}
export const decisionsOf = (def: ItemDef, pb: PairBars, plant: string): Decisions => {
  const ev = eventsOf(def, pb, { plant, params: {} });
  return { dir: new Map(ev.cands.map((c) => [c.i, c.dir])), first: ev.first };
};
// the decision at bar i of the item computed on `v` (a series whose bar i is its newest or a later one)
const decisionAt = (def: ItemDef, v: ReturnType<typeof viewOf>, i: number, plant: string, first?: { buy: number; sell: number }): Dir | 0 => {
  const ev = eventsOf(def, v, { plant, params: {} }, first);
  const c = ev.cands.find((x) => x.i === i);
  return c ? c.dir : 0;
};

// the cut points of an item and pair (SQ-23 day bounds: τ for every item, New York's midnight for breedon)
export const cutPoints = (def: ItemDef, pb: PairBars, d: Decisions, p: Period): number[] => {
  const sig = [...d.dir.keys()].sort((a, b) => a - b);
  const sigPts = def.window.kind === "s0" && sig.length > SAMPLE.cutMax ? sampleOf(sig, SAMPLE.cutMax, SEED.cut) : sig;
  const even: number[] = [];
  for (let j = 0; j < SAMPLE.cutEven; j++) even.push(Math.min(pb.n - 1, Math.floor(((j + 0.5) * pb.n) / SAMPLE.cutEven)));
  const extra = new Set<number>();
  for (let k = 1; k < pb.n; k++) {
    if (pb.t[k] - pb.t[k - 1] > STEP) for (let j = Math.max(0, k - SAMPLE.gapBefore); j < k; j++) extra.add(j);
  }
  const bounds = [...tausBetween(p.s0, p.end), ...(def.id.startsWith("breedon") ? nyMidnightsBetween(p.s0, p.end) : [])];
  let ptr = 0;
  for (const b of bounds.sort((x, y) => x - y)) {
    while (ptr < pb.n && pb.t[ptr] < b) ptr++;
    for (let j = Math.max(0, ptr - SAMPLE.dayBefore); j < ptr; j++) extra.add(j);
  }
  const ex = [...extra].sort((a, b) => a - b);
  const exPts = ex.length > SAMPLE.gapPts ? sampleOf(ex, SAMPLE.gapPts, SEED.gaps) : ex;
  return [...new Set([...sigPts, ...even, ...exPts])].sort((a, b) => a - b);
};

export const cutCheck = (def: ItemDef, pb: PairBars, d: Decisions, p: Period, plant: string): Probe => {
  const pr = newProbe();
  for (const i of cutPoints(def, pb, d, p)) {
    const want = d.dir.get(i) ?? 0;
    let got: Dir | 0;
    let E: number;
    if (def.window.kind === "s0") {
      const v = viewOf(pb, 0, i);
      got = decisionAt(def, v, i, plant);
      E = eOf(v, i, plant);
    } else {
      const v = viewOf(pb, Math.max(0, i - def.window.L + 1), i);
      got = decisionAt(def, v, i, plant, d.first);
      E = eOf(v, i - v.base, plant);
    }
    pr.compared++;
    if (got !== want) bad(pr, `${pb.pair} ${iso(pb.t[i])} whole=${want} cut=${got}`);
    else if (want !== 0 && E !== eOf(pb, i, plant)) bad(pr, `${pb.pair} ${iso(pb.t[i])} E whole=${eOf(pb, i, plant)} cut=${E}`);
  }
  return pr;
};

// every bar after i moved ±777.7 pips in turn (+ on the first), both sides, OHLC
export const poisonAfter = (pb: PairBars, i: number): PairBars =>
  withSides(pb, (q) => {
    const pip = pb.unit;
    for (let k = i + 1; k < pb.n; k++) {
      const d = ((k - i) % 2 === 1 ? 1 : -1) * POISON_PIPS * pip;
      for (const key of ["bo", "bh", "bl", "bc", "ao", "ah", "al", "ac"] as const) q[key][k] += d;
    }
  });

export const poisonPoints = (pb: PairBars, d: Decisions): { sigs: number[]; bars: number[] } => {
  const sig = [...d.dir.keys()].sort((a, b) => a - b);
  const free: number[] = [];
  for (let k = 0; k < pb.n; k++) if (!d.dir.has(k)) free.push(k);
  return { sigs: sampleOf(sig, SAMPLE.poisonSigs, SEED.poison), bars: sampleOf(free, SAMPLE.poisonBars, SEED.poison) };
};

export const poisonCheck = (def: ItemDef, pb: PairBars, d: Decisions, plant: string): Probe => {
  const pr = newProbe();
  const pts = poisonPoints(pb, d);
  for (const i of [...pts.sigs, ...pts.bars]) {
    const q = poisonAfter(pb, i);
    const got = decisionAt(def, q, i, plant);
    const want = d.dir.get(i) ?? 0;
    pr.compared++;
    if (got !== want) bad(pr, `${pb.pair} ${iso(pb.t[i])} whole=${want} poisoned=${got}`);
    else if (want !== 0 && eOf(q, i, plant) !== eOf(pb, i, plant)) bad(pr, `${pb.pair} ${iso(pb.t[i])} E whole=${eOf(pb, i, plant)} poisoned=${eOf(q, i, plant)}`);
  }
  return pr;
};

// the next Sunday 22:00 UTC after t
export const nextSunday22 = (t: number): number => {
  const d = new Date(t);
  const days = (7 - d.getUTCDay()) % 7;
  let s = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + days, 22);
  if (s <= t) s += 7 * 24 * 3_600_000;
  return s;
};

export const presenceCheck = (def: ItemDef, pb: PairBars, d: Decisions, which: 1 | 2, plant: string): Probe => {
  const pr = newProbe();
  const { sigs } = poisonPoints(pb, d);
  for (const i of sigs) {
    const T = pb.t[i] + STEP;
    const end = which === 1 ? T + 35 * 60_000 : nextSunday22(T) - 1;
    const q = keepBars(pb, (k) => !(pb.t[k] >= T && pb.t[k] <= end));
    const got = decisionAt(def, q, i, plant);
    const want = d.dir.get(i) ?? 0;
    pr.compared++;
    if (got !== want) bad(pr, `${pb.pair} ${iso(pb.t[i])} whole=${want} deleted(${which})=${got}`);
    else if (want !== 0 && eOf(q, i, plant) !== eOf(pb, i, plant)) bad(pr, `${pb.pair} ${iso(pb.t[i])} E changed (${which})`);
  }
  return pr;
};

export const mergeProbes = (ps: Probe[]): Probe => {
  const out = newProbe();
  for (const p of ps) {
    out.compared += p.compared;
    out.mismatched += p.mismatched;
    for (const e of p.examples) if (out.examples.length < 10) out.examples.push(e);
  }
  return out;
};
export { firstDetermined };
