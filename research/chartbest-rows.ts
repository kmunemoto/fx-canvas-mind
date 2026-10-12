// #318 (docs §8.113 8, 9, 10, 12, 14): the rows of a half — each source's signals with their trades from the
// blind table, and Δ, a, Δ_late, W/PL, the blind-weighted W1/PL1, Δ by direction and by pair, the
// non-overlapping Δ (SQ-19), per week, the week shift; the blind's own rows (by direction, and pair ×
// direction). Pure: computed from the bars, the signals and the blind table only.

import type { PairBars } from "./chartbest-bars.ts";
import { indexAt } from "./chartbest-bars.ts";
import { type Dir, type Half, type Layer, PAIRS, type Period, STEP, TP_MAIN, dirName } from "./chartbest-const.ts";
import { WEEK as WEEK_MS } from "./lib.ts";
import type { SigRec } from "./chartbest-events.ts";
import { type BlindPair, type BlindTable, type Kind, rowE, rowKind } from "./chartbest-follow.ts";
import { type Est, type Obs, type ShiftSummary, type WinPl, aOf, deltaOf, emptyEst, meanOf, shiftSummary, winPlOf } from "./chartbest-stats.ts";
import { stratumOf } from "./chartbest-strata.ts";
import { block4, seasonOf, wk } from "./chartbest-time.ts";

// ---- a signal's trades ----------------------------------------------------------------------------------------

export interface SigTrade {
  src: string;
  pi: number;
  i: number;
  T: number;
  dir: Dir;
  half: Half;
  // its row of the blind table
  r: number;
  e: number | null;
  k4: Kind;
  k10: Kind;
  p4: number;
  p10: number;
  // the mirror's pips
  mp4: number;
  mp10: number;
  // the TP10 trade's exit bar
  at10: number;
  // Δ_late: the next bar (opening at T) and its e (null when it is not in the half's table)
  lateT: number | null;
  eLate: number | null;
  nextOk: boolean;
}
const keyOf = (dir: Dir, tp: 4 | 10) => `${dir === 1 ? "b" : "s"}${tp}` as "b4" | "s4" | "b10" | "s10";

export const pairTable = (bt: BlindTable, pi: number): BlindPair => {
  const bp = bt.pairs.find((x) => x.pi === pi);
  if (!bp) throw new Error(`blind table ${bt.half}: no pair ${pi}`);
  return bp;
};

export const tradesOf = (recs: SigRec[], half: Half, bt: BlindTable, bars: PairBars[]): SigTrade[] => {
  const out: SigTrade[] = [];
  for (const s of recs) {
    if (s.reason !== "counted" || s.half !== half) continue;
    const bp = pairTable(bt, s.pi);
    const r = bp.rowOfK[s.i];
    if (r < 0) throw new Error(`${s.src} ${PAIRS[s.pi]} bar ${s.i}: a counted signal not in the blind table`);
    const pb = bars[s.pi];
    const other: Dir = s.dir === 1 ? -1 : 1;
    const nextOk = s.i + 1 < pb.n && pb.t[s.i + 1] === s.T && bp.rowOfK[s.i + 1] >= 0;
    const rl = nextOk ? bp.rowOfK[s.i + 1] : -1;
    out.push({
      src: s.src, pi: s.pi, i: s.i, T: s.T, dir: s.dir, half, r,
      e: rowE(bp, r, s.dir),
      k4: rowKind(bp, r, keyOf(s.dir, 4)), k10: rowKind(bp, r, keyOf(s.dir, 10)),
      p4: bp.pips[keyOf(s.dir, 4)][r], p10: bp.pips[keyOf(s.dir, 10)][r],
      mp4: bp.pips[keyOf(other, 4)][r], mp10: bp.pips[keyOf(other, 10)][r],
      at10: bp.at[keyOf(s.dir, 10)][r],
      lateT: nextOk ? s.T + STEP : null,
      eLate: nextOk ? rowE(bp, rl, s.dir) : null,
      nextOk,
    });
  }
  return out;
};

// ---- observations -------------------------------------------------------------------------------------------

export interface BlindObs {
  // stratum → the blind observations with e, in (pair, T) order
  byS: Map<number, Obs[]>;
  mean: Map<number, number>;
}
export const blindObsOf = (bt: BlindTable, layer: Layer, p: Period, plant = ""): BlindObs => {
  const byS = new Map<number, Obs[]>();
  for (const bp of bt.pairs) {
    for (let r = 0; r < bp.n; r++) {
      for (const dir of [1, -1] as const) {
        const e = rowE(bp, r, dir);
        if (e === null) continue;
        const T = bp.T[r];
        const s = stratumOf(layer, bp.pi, dir, T, plant);
        const o: Obs = { s, week: wk(T), block: block4(T, bt.half, p), v: e / 2 };
        const l = byS.get(s);
        if (l) l.push(o);
        else byS.set(s, [o]);
      }
    }
  }
  const mean = new Map<number, number>();
  for (const [s, l] of byS) mean.set(s, meanOf(l.map((x) => x.v)));
  return { byS, mean };
};
const sigObs = (tr: SigTrade[], layer: Layer, half: Half, p: Period, plant: string, late = false): Obs[] => {
  const out: Obs[] = [];
  for (const x of tr) {
    const e = late ? x.eLate : x.e;
    if (e === null) continue;
    const T = late ? x.lateT! : x.T;
    out.push({ s: stratumOf(layer, x.pi, x.dir, T, plant), week: wk(x.T), block: block4(x.T, half, p), v: e / 2 });
  }
  return out;
};

// the point Δ alone (the shifts)
const deltaPoint = (sig: Obs[], blind: BlindObs): number | null => {
  const byS = new Map<number, number[]>();
  for (const x of sig) {
    if (!blind.mean.has(x.s)) continue;
    const l = byS.get(x.s);
    if (l) l.push(x.v);
    else byS.set(x.s, [x.v]);
  }
  let N = 0;
  for (const l of byS.values()) N += l.length;
  if (N === 0) return null;
  let d = 0;
  for (const s of [...byS.keys()].sort((a, b) => a - b)) {
    const l = byS.get(s)!;
    d += (l.length / N) * (meanOf(l) - blind.mean.get(s)!);
  }
  return d;
};

// ---- the week shift (8, 10) -----------------------------------------------------------------------------------

export interface ShiftOut {
  delta: ShiftSummary;
  late: ShiftSummary;
}
// every signal moves k weeks along W_h (a ring), keeping its place in the week; its trade is the blind row
// of the bar at T′ (dropped when absent), its stratum from T′ (Δ_late: the bar after, its stratum from T′+5)
export const shiftOf = (tr: SigTrade[], bt: BlindTable, bars: PairBars[], blind: BlindObs, half: Half, p: Period, plant: string, real: { delta: number | null; late: number | null }): ShiftOut => {
  const W = bt.weeks;
  const pos = new Map(W.map((w, j) => [w, j]));
  const ks: number[] = [];
  const dD: Array<number | null> = [];
  const dL: Array<number | null> = [];
  const drop: number[] = [];
  const dropL: number[] = [];
  const cross: number[] = [];
  const crossL: number[] = [];
  for (let k = 1; k <= W.length - 1; k++) {
    const obs: Obs[] = [];
    const obsL: Obs[] = [];
    let dropped = 0;
    let droppedL = 0;
    let sc = 0;
    let scL = 0;
    for (const x of tr) {
      const w = wk(x.T);
      const j = pos.get(w);
      if (j === undefined) throw new Error(`shift: the week ${w} of a signal holds no blind bar`);
      const jj = plant === "shiftNoRing" ? j + k : (j + k) % W.length;
      if (jj >= W.length) {
        dropped++;
        droppedL++;
        continue;
      }
      const T2 = x.T + (W[jj] - w) * WEEK_MS;
      const pb = bars[x.pi];
      const bp = pairTable(bt, x.pi);
      const k2 = indexAt(pb.t, T2 - STEP);
      const r2 = k2 >= 0 ? bp.rowOfK[k2] : -1;
      if (r2 < 0) {
        dropped++;
      } else {
        if (seasonOf(T2, plant) !== seasonOf(x.T, plant)) sc++;
        const e = rowE(bp, r2, x.dir);
        if (e !== null) obs.push({ s: stratumOf("chart", x.pi, x.dir, T2, plant), week: wk(T2), block: block4(T2, half, p), v: e / 2 });
      }
      // Δ_late: the bar opening at T′ (the shifted bar's next)
      const k3 = indexAt(pb.t, T2);
      const r3 = k3 >= 0 && r2 >= 0 ? bp.rowOfK[k3] : -1;
      if (r3 < 0) droppedL++;
      else {
        if (seasonOf(T2 + STEP, plant) !== seasonOf(x.T + STEP, plant)) scL++;
        const e = rowE(bp, r3, x.dir);
        if (e !== null) obsL.push({ s: stratumOf("chart", x.pi, x.dir, T2 + STEP, plant), week: wk(T2), block: block4(T2, half, p), v: e / 2 });
      }
    }
    ks.push(k);
    dD.push(deltaPoint(obs, blind));
    dL.push(deltaPointLate(obsL, blind));
    drop.push(dropped);
    dropL.push(droppedL);
    cross.push(sc);
    crossL.push(scL);
  }
  return { delta: shiftSummary(ks, dD, drop, cross, real.delta), late: shiftSummary(ks, dL, dropL, crossL, real.late) };
};
const deltaPointLate = deltaPoint;

// ---- a row ------------------------------------------------------------------------------------------------------

export interface PointN {
  est: number | null;
  N: number;
  strata: number;
  dropped: number;
}
export interface Row {
  src: string;
  half: Half;
  layer: Layer;
  counted: number;
  // e present (signal and mirror resolved), the TP10 trade unresolved
  nE: number;
  unresolved: number;
  delta: Est;
  a: Est;
  late: Est;
  lateExcluded: number;
  w4: WinPl;
  w10: WinPl;
  blindW1: number | null;
  blindPl1: number | null;
  byDir: Record<"BUY" | "SELL", PointN>;
  byPair: Record<string, PointN>;
  nonOverlap: number | null;
  perWeek: number | null;
  shift: ShiftOut | null;
  suspicious: string[];
}

const pointOf = (e: Est): PointN => ({ est: e.est, N: e.N, strata: e.strata, dropped: e.dropped });

export interface RowOpts {
  plant: string;
  // the chart group's shift (items of the chart group, the emails in the chart layer)
  shift: boolean;
}
export const rowOf = (src: string, tr: SigTrade[], layer: Layer, half: Half, bt: BlindTable, bars: PairBars[], blind: BlindObs, p: Period, o: RowOpts): Row => {
  const plant = o.plant;
  const obs = sigObs(tr, layer, half, p, plant);
  const obsLate = sigObs(tr.filter((x) => x.nextOk), layer, half, p, plant, true);
  const blindOf = (s: number) => blind.byS.get(s) ?? [];
  const pre = deltaOf(obs, blindOf, { plant });
  const preLate = deltaOf(obsLate, blindOf, { plant });
  let shift: ShiftOut | null = null;
  let delta = pre;
  let late = preLate;
  if (o.shift && layer === "chart") {
    shift = shiftOf(tr, bt, bars, blind, half, p, plant, { delta: pre.est, late: preLate.est });
    const Cw = pre.cands.find((c) => c.kind === "week")?.C ?? 0;
    delta = deltaOf(obs, blindOf, { plant, shift: { sd: shift.delta.sd, Cw } });
    const CwL = preLate.cands.find((c) => c.kind === "week")?.C ?? 0;
    late = deltaOf(obsLate, blindOf, { plant, shift: { sd: shift.late.sd, Cw: CwL } });
  }
  const a = aOf(obs);
  const w4 = winPlOf(tr.map((x) => ({ T: x.T, kind: x.k4, pips: x.p4 })));
  const w10 = winPlOf(tr.map((x) => ({ T: x.T, kind: x.k10, pips: x.p10 })));
  // the blind-weighted W1 and PL1 (9): Σ_s (n_s ÷ N) × the stratum's blind W1 (resolved) and PL1
  const { blindW1, blindPl1 } = blindWeighted(obs, layer, bt, blind, plant);
  const byDir = {
    BUY: pointOf(deltaOf(sigObs(tr.filter((x) => x.dir === 1), layer, half, p, plant), blindOf, { plant })),
    SELL: pointOf(deltaOf(sigObs(tr.filter((x) => x.dir === -1), layer, half, p, plant), blindOf, { plant })),
  };
  const byPair: Record<string, PointN> = {};
  for (const [pi, pair] of PAIRS.entries()) {
    const sub = tr.filter((x) => x.pi === pi);
    if (!sub.length) continue;
    byPair[pair] = pointOf(deltaOf(sigObs(sub, layer, half, p, plant), blindOf, { plant }));
  }
  // SQ-19: the non-overlapping version, by the TP10 trade's exit (an open one until its 1,440th bar closes)
  const kept: SigTrade[] = [];
  const freeAt = new Map<string, number>();
  for (const x of tr) {
    const key = `${x.pi}|${x.dir}`;
    if ((freeAt.get(key) ?? -Infinity) > x.T) continue;
    kept.push(x);
    freeAt.set(key, bars[x.pi].t[x.at10] + STEP);
  }
  const nonOverlap = deltaOf(sigObs(kept, layer, half, p, plant), blindOf, { plant }).est;
  const nE = tr.filter((x) => x.e !== null).length;
  return {
    src, half, layer,
    counted: tr.length,
    nE,
    unresolved: tr.filter((x) => x.k10 === "open").length,
    delta, a, late,
    lateExcluded: tr.filter((x) => !x.nextOk).length,
    w4, w10, blindW1, blindPl1, byDir, byPair, nonOverlap,
    perWeek: bt.weeks.length ? tr.length / bt.weeks.length : null,
    shift,
    suspicious: [],
  };
};
const blindWeighted = (obs: Obs[], layer: Layer, bt: BlindTable, blind: BlindObs, plant: string): { blindW1: number | null; blindPl1: number | null } => {
  const n = new Map<number, number>();
  for (const x of obs) if (blind.byS.has(x.s)) n.set(x.s, (n.get(x.s) ?? 0) + 1);
  let N = 0;
  for (const v of n.values()) N += v;
  if (N === 0) return { blindW1: null, blindPl1: null };
  // the stratum's TP4 trades of the blind rows (the stratum's direction), resolved win share and mean pips
  const stats = new Map<number, { tp: number; res: number; pips: number[] }>();
  for (const bp of bt.pairs) {
    for (let r = 0; r < bp.n; r++) {
      for (const dir of [1, -1] as const) {
        const s = stratumOf(layer, bp.pi, dir, bp.T[r], plant);
        if (!n.has(s)) continue;
        const key = dir === 1 ? "b4" : "s4";
        const kind = rowKind(bp, r, key);
        const st = stats.get(s) ?? { tp: 0, res: 0, pips: [] };
        if (kind !== "open") st.res++;
        if (kind === "tp") st.tp++;
        st.pips.push(bp.pips[key][r]);
        stats.set(s, st);
      }
    }
  }
  let w = 0;
  let pl = 0;
  let wOk = true;
  for (const s of [...n.keys()].sort((a, b) => a - b)) {
    const st = stats.get(s)!;
    const wt = n.get(s)! / N;
    if (st.res === 0) wOk = false;
    else w += wt * (st.tp / st.res);
    pl += wt * meanOf(st.pips);
  }
  return { blindW1: wOk ? w : null, blindPl1: pl };
};

// ---- the blind's own rows (10; SQ-16) ------------------------------------------------------------------------

export interface BlindRow {
  key: string;
  a: Est;
  w4: WinPl;
  w10: WinPl;
  suspicious: string[];
}
// by direction (all pairs), and per pair × direction
export const blindRowsOf = (bt: BlindTable, p: Period): BlindRow[] => {
  const out: BlindRow[] = [];
  const mk = (key: string, pis: number[], dir: Dir): BlindRow => {
    const obs: Obs[] = [];
    const t4: Array<{ T: number; kind: Kind; pips: number }> = [];
    const t10: Array<{ T: number; kind: Kind; pips: number }> = [];
    for (const pi of pis) {
      const bp = pairTable(bt, pi);
      for (let r = 0; r < bp.n; r++) {
        const e = rowE(bp, r, dir);
        const T = bp.T[r];
        if (e !== null) obs.push({ s: 0, week: wk(T), block: block4(T, bt.half, p), v: e / 2 });
        const k4 = dir === 1 ? "b4" : "s4";
        const k10 = dir === 1 ? "b10" : "s10";
        t4.push({ T, kind: rowKind(bp, r, k4), pips: bp.pips[k4][r] });
        t10.push({ T, kind: rowKind(bp, r, k10), pips: bp.pips[k10][r] });
      }
    }
    return { key, a: obs.length ? aOf(obs) : emptyEst(), w4: winPlOf(t4), w10: winPlOf(t10), suspicious: [] };
  };
  const pis = bt.pairs.map((x) => x.pi);
  for (const dir of [1, -1] as const) out.push(mk(dirName(dir), pis, dir));
  for (const pi of pis) for (const dir of [1, -1] as const) out.push(mk(`${PAIRS[pi]} ${dirName(dir)}`, [pi], dir));
  return out;
};

export const TP10 = TP_MAIN;
