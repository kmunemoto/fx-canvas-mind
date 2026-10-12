// #318 (docs §8.113 5, 6): the event framework every item shares, the window's holes and the reasons a
// signal is left out. Pure.
//
// 5: an item gives, per direction, a condition at each bar (1 true, 0 false 「成り立たない」, −1 none 「無し」).
// A signal is the rise: true at i and false at i − 1 (strictly: none at i − 1 gives no signal), never at the
// bar where the condition was first not none after S0 (per direction; not per name). Named items rise per
// name (a name absent at i − 1 is false). Then the item's own retained rules (置6; none in the trial), then a
// bar with both directions left gives neither (counted). One signal per (item, pair, direction, T).
// 6: the reasons, in order, the first that applies: ① T outside the period or the warm-up short, ② not sent
// (T, T + 1 and T + 3 minutes all isPossiblyClosed), ③ a hole of the window overlapping [t[i − 9], T), ④ the
// 1,440th bar of the follow not closed by its half's end. The rest are counted (⑤ is decided later).

import type { BarsView, PairBars } from "./chartbest-bars.ts";
import { type Dir, type Group, type Half, type Pair, PAIRS, type Period, STEP, TRACK } from "./chartbest-const.ts";
import { gmoWeekOpen, sent } from "./chartbest-time.ts";

export type Tri = Int8Array;
export interface ItemCtx {
  plant: string;
  // the hand examples' shortened parameters (C1's n = 3)
  params: Record<string, number>;
}
// a named item's conditions at a bar: name → 1 / 0 (a name missing is false)
export type Named = Array<Map<string, number> | null>;
export interface ItemOut {
  buy: Tri;
  sell: Tri;
  // named items: per bar and direction (when given, buy/sell are ignored)
  namedBuy?: Named;
  namedSell?: Named;
  // always-hold items: the target (donchianState is checked against it)
  target?: Int8Array;
  // marks a signal carries (counted at stage 0): e.g. "shiftedWeek"
  marks?: (k: number, dir: Dir) => string[];
  // step ③ (置6, and the planted errors that act there): drop a candidate, or give it another direction
  // (0: none); k is the view's index
  after?: (k: number, dir: Dir) => Dir | 0;
}
export type ItemKind = "condition" | "named" | "always";
export interface ItemDef {
  id: string;
  order: number;
  group: Group;
  candidate: string;
  pairs: readonly Pair[];
  kind: ItemKind;
  // 18: decided by a finite window of L_c bars, or from S0 on
  window: { kind: "finite"; L: number } | { kind: "s0" };
  // 6 ①: a signal needs an S0 index at least this
  warmup: number;
  // 5: ※600
  mark600: boolean;
  // C2 applies (both directions are signalled)
  bothDirs: boolean;
  // 20 (e) 裏返し (SQ-28): the flip maps its signals one to one with the direction reversed
  symmetric: boolean;
  symmetricWhy: string;
  // SQ-37 (the flip only): bar i's decision lay within one tick of its line (the flipped run can decide it the other
  // way, by the half-tick mids of SQ-02); used to sort the flip's differing signals, never the run's signals
  flipTie?: (v: BarsView, i: number) => boolean;
  compute(v: BarsView, ctx: ItemCtx): ItemOut;
}

export interface Cand {
  src: string;
  pi: number;
  // the S0 index of the signal bar, and T its close
  i: number;
  T: number;
  dir: Dir;
  marks: string[];
}
export interface EventsOut {
  cands: Cand[];
  bothSuppressed: number;
  // the T of each bar whose both directions were dropped
  suppressedT: number[];
  firstSkipped: number;
  nullPrevSkipped: number;
  // the first S0 index whose condition is not none, per direction (−1: never)
  first: { buy: number; sell: number };
}

// the first index (S0) with a condition other than none
export const firstDetermined = (tri: Tri, base: number): number => {
  for (let k = 0; k < tri.length; k++) if (tri[k] !== -1) return base + k;
  return -1;
};

// 5: the signals of an item on a view of one pair's bars. `first`: the first determined bars from the whole
// series (a window starting after S0 cannot know them); without it, the view must start at S0.
export const eventsOf = (def: ItemDef, v: BarsView, ctx: ItemCtx, firstIn?: { buy: number; sell: number }): EventsOut => {
  const out = def.compute(v, ctx);
  if (!firstIn && v.base !== 0) throw new Error(`${def.id}: a window after S0 needs the first determined bars`);
  // a named item's condition per bar: none (null) or determined (any name true: 1)
  const triOf = (tri: Tri, named: Named | undefined): Tri => (named ? Int8Array.from(named, (m) => (m === null ? -1 : [...m.values()].some((x) => x === 1) ? 1 : 0)) : tri);
  const first = firstIn ?? { buy: firstDetermined(triOf(out.buy, out.namedBuy), 0), sell: firstDetermined(triOf(out.sell, out.namedSell), 0) };
  let firstSkipped = 0;
  let nullPrevSkipped = 0;
  const noRise = ctx.plant === "noRiseEdge";
  // ① the conditions, ② the rise
  const rise = (tri: Tri, named: Named | undefined, f: number): Uint8Array => {
    const r = new Uint8Array(v.n);
    for (let k = 1; k < v.n; k++) {
      const i = v.base + k;
      if (named) {
        const now = named[k];
        if (!now || ![...now.values()].some((x) => x === 1)) continue;
        // the first determined bar, and a bar whose bar i − 1 is none, give no signal (as the other types)
        if (i === f) {
          firstSkipped++;
          continue;
        }
        const prev = named[k - 1];
        if (prev === null) {
          nullPrevSkipped++;
          continue;
        }
        for (const [name, val] of now) {
          if (val !== 1) continue;
          const pv = prev?.get(name) ?? 0;
          if (pv === 0 || noRise) {
            r[k] = 1;
            break;
          }
        }
        continue;
      }
      if (tri[k] !== 1) continue;
      if (i === f) {
        firstSkipped++;
        continue;
      }
      if (tri[k - 1] === -1) {
        nullPrevSkipped++;
        continue;
      }
      // the plant "noRiseEdge" signals at every true bar, not at the rise alone (the hand examples catch it)
      if (tri[k - 1] === 0 || noRise) r[k] = 1;
    }
    // bar 0 of the whole series has no bar before it: never a signal (and it is the first determined bar
    // whenever its condition is not none)
    if (v.base === 0 && v.n > 0 && !named && tri[0] === 1) firstSkipped++;
    return r;
  };
  const rb = rise(out.buy, out.namedBuy, first.buy);
  const rs = rise(out.sell, out.namedSell, first.sell);
  // ③ the retained rules (and the plants acting there)
  const dirs = new Int8Array(v.n * 2);
  for (let k = 0; k < v.n; k++) {
    for (const [r, d] of [[rb, 1], [rs, -1]] as const) {
      if (!r[k]) continue;
      const nd = out.after ? out.after(k, d) : d;
      if (nd !== 0) dirs[k * 2 + (nd === 1 ? 0 : 1)] = 1;
    }
  }
  // ④ both directions at one bar: neither
  const cands: Cand[] = [];
  let bothSuppressed = 0;
  const suppressedT: number[] = [];
  for (let k = 0; k < v.n; k++) {
    const b = dirs[k * 2] === 1;
    const s = dirs[k * 2 + 1] === 1;
    if (b && s) {
      bothSuppressed++;
      suppressedT.push(v.t[k] + STEP);
      continue;
    }
    if (!b && !s) continue;
    const dir: Dir = b ? 1 : -1;
    cands.push({ src: def.id, pi: v.pi, i: v.base + k, T: v.t[k] + STEP, dir, marks: out.marks ? out.marks(k, dir) : [] });
  }
  return { cands, bothSuppressed, suppressedT, firstSkipped, nullPrevSkipped, first };
};

// ---- 6 ③: the window's holes ------------------------------------------------------------------------------

// per pair, hole intervals [a, b) as a flat list a0, b0, a1, b1, …
export interface Holes {
  byPair: Float64Array[];
  openSlots: number;
}
// A 5-minute slot is open inside GMO's week when at least 3 of the 5 pairs have a bar opening there; a run of
// 6 or more open slots without the pair's bar (a slot not open ends the run) is a hole of that pair
export const holesOf = (bars: ReadonlyArray<{ t: Float64Array; n: number }>, period: Period, minRun = 6): Holes => {
  const ptr = bars.map(() => 0);
  const runStart = bars.map(() => -1);
  const runLen = bars.map(() => 0);
  const holes: number[][] = bars.map(() => []);
  let openSlots = 0;
  const close = (p: number, lastSlot: number) => {
    if (runLen[p] >= minRun) holes[p].push(runStart[p], lastSlot + STEP);
    runLen[p] = 0;
    runStart[p] = -1;
  };
  const s0 = Math.ceil(period.s0 / STEP) * STEP;
  for (let s = s0; s < period.end; s += STEP) {
    const has = bars.map((b, p) => {
      while (ptr[p] < b.n && b.t[ptr[p]] < s) ptr[p]++;
      return ptr[p] < b.n && b.t[ptr[p]] === s;
    });
    const open = gmoWeekOpen(s) && has.filter(Boolean).length >= 3;
    if (open) openSlots++;
    for (let p = 0; p < bars.length; p++) {
      if (open && !has[p]) {
        if (runLen[p] === 0) runStart[p] = s;
        runLen[p]++;
      } else if (runLen[p] > 0) close(p, runStart[p] + (runLen[p] - 1) * STEP);
    }
  }
  for (let p = 0; p < bars.length; p++) if (runLen[p] > 0) close(p, runStart[p] + (runLen[p] - 1) * STEP);
  return { byPair: holes.map((h) => Float64Array.from(h)), openSlots };
};
// does a hole of the pair overlap [a, b)?
export const holeOverlaps = (holes: Holes, pi: number, a: number, b: number): boolean => {
  const h = holes.byPair[pi];
  for (let k = 0; k < h.length; k += 2) if (h[k] < b && h[k + 1] > a) return true;
  return false;
};

// ---- 6: the reasons ----------------------------------------------------------------------------------------

export type Reason = "counted" | "r1" | "r2" | "r3" | "r4";
export interface Classified {
  reason: Reason;
  half: Half | null;
  // the follow's first bar (the first opening at or after T) and its 1,440th
  from: number;
  last: number;
}
export interface ClassifyOpts {
  plant?: string;
}
// the half a T is in, and where that half's follow must have closed (the plants "splitShift1w" and
// "allowCrossSplit" move these, which hand.half must catch)
export const halfOf = (T: number, p: Period, plant = ""): { half: Half; end: number } => {
  const split = plant === "splitShift1w" ? p.split + 7 * 24 * 3_600_000 : p.split;
  if (T < split) return { half: "H1", end: plant === "allowCrossSplit" ? p.end : split };
  return { half: "H2", end: p.end };
};
// 6 ①〜④ for a bar i of the pair (warmOk: i reaches the item's warm-up)
export const classify = (pb: { t: Float64Array; n: number }, pi: number, i: number, warmOk: boolean, holes: Holes, p: Period, plant = ""): Classified => {
  const T = pb.t[i] + STEP;
  const from = i + 1;
  const last = from + TRACK - 1;
  if (T < p.start || T >= p.end || !warmOk) return { reason: "r1", half: null, from, last };
  if (!sent(T, plant)) return { reason: "r2", half: null, from, last };
  if (holeOverlaps(holes, pi, pb.t[Math.max(0, i - 9)], T)) return { reason: "r3", half: null, from, last };
  const h = halfOf(T, p, plant);
  if (last > pb.n - 1 || pb.t[last] + STEP > h.end) return { reason: "r4", half: null, from, last };
  return { reason: "counted", half: h.half, from, last };
};

export interface SigRec extends Cand {
  E: number;
  reason: Reason;
  half: Half | null;
  from: number;
  last: number;
}
// 6: E, the signal bar's rounded mid close (the plant "eNextBar" takes the next bar's, which the poison catches)
export const eOf = (v: { mc: Float64Array; n: number }, k: number, plant = ""): number => (plant === "eNextBar" && k + 1 < v.n ? v.mc[k + 1] : v.mc[k]);
export const recordsOf = (pb: PairBars, cands: Cand[], warmup: number, holes: Holes, p: Period, plant = ""): SigRec[] =>
  cands.map((c) => {
    const cl = classify(pb, pb.pi, c.i, c.i >= warmup, holes, p, plant);
    return { ...c, E: eOf(pb, c.i, plant), ...cl };
  });

// signals in the dumps' order: source order, pair order, T, BUY first
export const sigOrder = (srcOrd: (src: string) => number) => (a: Cand, b: Cand): number =>
  srcOrd(a.src) - srcOrd(b.src) || a.pi - b.pi || a.T - b.T || b.dir - a.dir;

export const pairIndex = (pair: Pair): number => PAIRS.indexOf(pair);
