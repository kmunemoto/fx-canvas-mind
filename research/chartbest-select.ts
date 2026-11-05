// #318 (docs §8.113 10, 12, 13, 14, 15, 16): the suspicious signals, stage 1's choice and its descriptive
// counts, stage 2's Holm, C1–C5, judgments, the promotion to stage 3, D_U / D_M / D_AB, MDE and the count of
// intervals seen. Pure.
//
// The planted errors acting here (20 (f)): "selectByPoint", "ignoreGroups", "noHolm".

import { C23_MIN, type Group, ITEM_TABLE, K, MARK_LINE, PAIRS, SPEC, SUSPECT, srcOrder } from "./chartbest-const.ts";
import type { BlindRow, Row } from "./chartbest-rows.ts";
import { ITEMS } from "./chartbest-items.ts";
import { type Est, type WinPl, diffOf, gt0, lt0, mdeOf, passMinOf, pOneSided, simLb, tq, usedCand } from "./chartbest-stats.ts";

// ---- 13: the suspicious signals ------------------------------------------------------------------------------

const pctPrinted = (w: number | null): string | null => (w === null ? null : (100 * w).toFixed(1));
const zeroHundred = (w: WinPl): boolean =>
  [w.wRes, w.wAll].some((x) => {
    const s = pctPrinted(x);
    return s === "0.0" || s === "100.0";
  });
export interface SuspectIn {
  delta: number | null;
  a: number | null;
  late: number | null;
  w4: WinPl;
  w10: WinPl;
  // the blind's rows: the Δ conditions are not applied (SQ-16)
  blind?: boolean;
}
// the names of the conditions a row hits; none under 100 resolved (SQ-31: the TP10 trades)
export const suspiciousOf = (r: SuspectIn): string[] => {
  const resolved = SPEC.suspectResolvedBy === "tp10" ? r.w10.resolved : r.w4.resolved;
  if (resolved < SUSPECT.minResolved) return [];
  const out: string[] = [];
  if (!r.blind && r.delta !== null && Math.abs(r.delta) >= SUSPECT.delta) out.push("delta");
  if (r.a !== null && Math.abs(r.a) >= SUSPECT.a) out.push("a");
  if (r.w10.wRes !== null && r.w10.wRes >= SUSPECT.w2) out.push("w2");
  if (r.w4.wRes !== null && r.w4.wRes >= SUSPECT.w1) out.push("w1");
  if (r.w4.pl !== null && r.w4.pl >= SUSPECT.pl1) out.push("pl1");
  if (r.w10.pl !== null && r.w10.pl >= SUSPECT.pl2) out.push("pl2");
  if (zeroHundred(r.w4) || zeroHundred(r.w10)) out.push("zeroHundred");
  if (!r.blind && r.delta !== null && r.late !== null && Math.abs(r.delta - r.late) >= SUSPECT.lateGap) out.push("lateGap");
  return out;
};
export const suspectOfRow = (row: Row): string[] => suspiciousOf({ delta: row.delta.est, a: row.a.est, late: row.late.est, w4: row.w4, w10: row.w10 });
export const suspectOfBlind = (b: BlindRow): string[] => suspiciousOf({ delta: null, a: b.a.est, late: null, w4: b.w4, w10: b.w10, blind: true });

// ---- 12: stage 1 ----------------------------------------------------------------------------------------------

// 21: an item not eligible is counted under the first reason of this order
export const NOT_ELIGIBLE_ORDER = ["suspicious", "noT", "nonPositive"] as const;
export type NotEligible = (typeof NOT_ELIGIBLE_ORDER)[number];
export interface Rank {
  src: string;
  lb: number;
  nE: number;
  order: number;
}
export interface Stage1 {
  eligible: string[];
  notEligible: Record<string, NotEligible>;
  ranking: Rank[];
  chosen: Record<Group, string[]>;
  kTotal: number;
  // the groups of the floor-passing items with LB > 0 (kama-A and kama-B one item)
  lbPositive: Record<Group, { items: number; groups: number }>;
  // the shift's counts per k: items and groups with Δ_k − t·SE > 0, their mean and 95% point; the chance low end
  // 10: over the shifts k that gave any chart item a Δ_k (k of them)
  shift95: { items: { mean: number | null; p95: number | null }; groups: { mean: number | null; p95: number | null }; k: number };
  chanceLb: number | null;
  // a yardstick (blind, ULTRA, MACD) hit a suspicious line: everything stops (13)
  yardstickHits: string[];
  stopped: boolean;
}
export const groupOfItem = (id: string): Group => ITEM_TABLE.find((r) => r.id === id)!.group;
// the 95% point of 12 and 10: the sorted value at floor(0.95 × (n − 1))
export const p95Of = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(0.95 * (s.length - 1))];
};
const meanN = (xs: number[]): number | null => {
  if (!xs.length) return null;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
};
// kama-A and kama-B count as one item (12)
export const itemCount = (ids: string[]): number => {
  const seen = new Set<string>();
  for (const id of ids) seen.add(id === "kama-B" ? "kama-A" : id);
  return seen.size;
};
export const groupCount = (ids: string[], groups: Record<string, string>): number => new Set(ids.map((id) => groups[id] ?? id)).size;

export interface ChooseIn {
  // the floor-passing items' rows in their own layer (H1)
  rows: Row[];
  groups: Record<string, string>;
  checksOk: boolean;
  plant: string;
  // the sets that count the suspicious signal without stopping (SQ-25)
  countsOnly: boolean;
  // the yardsticks' suspicious hits (blind direction rows, emails' rows)
  yardstickHits: string[];
}
// 12: eligible (floor, every check, t, Δ > 0, no suspicious hit), ranked by LB (ties: nE, table order), the
// first K of each group not sharing an overlap group with one already chosen
export const chooseStage1 = (o: ChooseIn): Stage1 => {
  const notEligible: Record<string, NotEligible> = {};
  const eligible: Row[] = [];
  for (const r of o.rows) {
    const sus = r.suspicious.length > 0 && !o.countsOnly;
    if (sus) notEligible[r.src] = "suspicious";
    else if (r.delta.t === null || r.delta.lb === null) notEligible[r.src] = "noT";
    else if (!gt0(r.delta.est)) notEligible[r.src] = "nonPositive";
    else eligible.push(r);
  }
  const key = (r: Row): number => (o.plant === "selectByPoint" ? r.delta.est! : r.delta.lb!);
  const ranked = [...eligible].sort((a, b) => key(b) - key(a) || b.nE - a.nE || srcOrder(a.src) - srcOrder(b.src));
  const chosen: Record<Group, string[]> = { chart: [], cal: [] };
  const usedGroups = new Set<string>();
  if (o.checksOk) {
    for (const r of ranked) {
      const g = groupOfItem(r.src);
      if (chosen[g].length >= K[g]) continue;
      const og = o.plant === "ignoreGroups" ? r.src : (o.groups[r.src] ?? r.src);
      if (usedGroups.has(og)) continue;
      chosen[g].push(r.src);
      usedGroups.add(og);
    }
  }
  const lbPositive = {} as Stage1["lbPositive"];
  for (const g of ["chart", "cal"] as const) {
    const ids = o.rows.filter((r) => groupOfItem(r.src) === g && gt0(r.delta.lb)).map((r) => r.src);
    lbPositive[g] = { items: itemCount(ids), groups: groupCount(ids, o.groups) };
  }
  // 10, 12: the shift — per k, the chart items whose Δ_k − t(0.975, df)·SE > 0 (SE and df the item's own), and
  // the largest Δ_k − t·SE; the 95% points over k
  const chart = o.rows.filter((r) => groupOfItem(r.src) === "chart" && r.shift);
  const K_ = Math.max(0, ...chart.map((r) => r.shift!.delta.k.length));
  const perItems: number[] = [];
  const perGroups: number[] = [];
  const maxLb: number[] = [];
  for (let j = 0; j < K_; j++) {
    const pos: string[] = [];
    let best: number | null = null;
    for (const r of chart) {
      const d = r.shift!.delta.delta[j];
      const c = usedCand(r.delta);
      if (d === null || d === undefined || !c || r.delta.t === null) continue;
      const lb = d - c.half;
      if (best === null || lb > best) best = lb;
      if (gt0(lb)) pos.push(r.src);
    }
    // a shift that gave no item a Δ_k is not a draw
    if (best === null) continue;
    perItems.push(itemCount(pos));
    perGroups.push(groupCount(pos, o.groups));
    if (best !== null) maxLb.push(best);
  }
  const stopped = o.yardstickHits.length > 0 && !o.countsOnly;
  const kTotal = chosen.chart.length + chosen.cal.length;
  return {
    eligible: eligible.map((r) => r.src),
    notEligible,
    ranking: ranked.map((r) => ({ src: r.src, lb: r.delta.lb!, nE: r.nE, order: srcOrder(r.src) })),
    chosen: stopped ? { chart: [], cal: [] } : chosen,
    kTotal: stopped ? 0 : kTotal,
    lbPositive,
    shift95: { items: { mean: meanN(perItems), p95: p95Of(perItems) }, groups: { mean: meanN(perGroups), p95: p95Of(perGroups) }, k: perItems.length },
    chanceLb: p95Of(maxLb),
    yardstickHits: o.yardstickHits,
    stopped,
  };
};

// ---- 14: stage 2 -------------------------------------------------------------------------------------------------

export type Judgment = "confirmed" | "bad" | "partial" | "cannot";
export interface Stage2Item {
  src: string;
  group: Group;
  p: number;
  t: number | null;
  df: number | null;
  holmRank: number;
  holmPass: boolean;
  c1: boolean;
  // null: the condition does not apply to the item (14「C2・C3 を当てない項目は、そう書く」)
  c2: boolean | null;
  c3: boolean | null;
  c4: boolean;
  c5: boolean;
  c2Applied: boolean;
  c3Applied: boolean;
  c3q: number;
  c3pos: number;
  judgment: Judgment;
  // (イ) "i", (ロ) "ro", (ハ) "ha" for a partial one
  form: "i" | "ro" | "ha" | null;
  mde: number | null;
  passMin: number | null;
  simLb: number | null;
  dU: Est;
  dM: Est;
  dULb: number | null;
  dMLb: number | null;
  marks: string[];
}
export interface Stage2 {
  kTotal: number;
  items: Stage2Item[];
  promote: Record<Group, string | null>;
  dAB: Array<{ A: string; B: string; est: Est }>;
  intervalsSeen: IntervalsSeen;
}

// Holm, one-sided, the whole family: by p (ties: t larger, nE larger, table order); the k-th passes while
// p ≤ 0.025 ÷ (K − k + 1)
export interface HolmIn {
  src: string;
  p: number;
  t: number | null;
  nE: number;
}
export const holmOf = (xs: HolmIn[], plant = ""): Map<string, { rank: number; pass: boolean }> => {
  const order = [...xs].sort((a, b) => a.p - b.p || (b.t ?? -Infinity) - (a.t ?? -Infinity) || b.nE - a.nE || srcOrder(a.src) - srcOrder(b.src));
  const out = new Map<string, { rank: number; pass: boolean }>();
  const Kt = xs.length;
  let going = true;
  order.forEach((x, k) => {
    const pass = plant === "noHolm" ? x.p <= 0.025 : going && x.p <= 0.025 / (Kt - k);
    if (!pass) going = false;
    out.set(x.src, { rank: k + 1, pass });
  });
  return out;
};

export interface Stage2In {
  // the chosen items' H2 rows (their own layer)
  rows: Row[];
  // the emails' H2 rows in each layer
  ultra: Record<Group, Row>;
  macd: Record<Group, Row>;
  plant: string;
  // the sets that only count the suspicious signal (SQ-25, SQ-34): C5 is not failed by it
  countsOnly?: boolean;
}
export const stage2Of = (o: Stage2In): Stage2 => {
  const kTotal = o.rows.length;
  const hin: HolmIn[] = o.rows.map((r) => {
    const c = usedCand(r.delta);
    return { src: r.src, p: c && r.delta.t !== null ? pOneSided(r.delta.t, c.df) : 1, t: r.delta.t, nE: r.nE };
  });
  const holm = holmOf(hin, o.plant);
  const items: Stage2Item[] = o.rows.map((r) => {
    const g = groupOfItem(r.src);
    const c = usedCand(r.delta);
    const h = holm.get(r.src)!;
    const both = ITEMS.get(r.src)?.bothDirs ?? false;
    // C2: each direction with at least 30 signals with e, its Δ > 0 (items signalling both directions)
    const dirs = (["BUY", "SELL"] as const).filter((d) => r.byDir[d].N >= C23_MIN);
    const c2 = both ? dirs.every((d) => gt0(r.byDir[d].est)) : null;
    // C3: q pairs with at least 30 signals with e; when q ≥ 3, more than half of them Δ > 0
    const qs = PAIRS.filter((p) => (r.byPair[p]?.N ?? 0) >= C23_MIN);
    const pos = qs.filter((p) => gt0(r.byPair[p].est)).length;
    const c3Applied = qs.length >= 3;
    const c3 = c3Applied ? pos > qs.length / 2 : null;
    const c4 = gt0(r.late.lo);
    const c5 = r.suspicious.length === 0 || (o.countsOnly ?? false);
    const c1 = h.pass;
    let judgment: Judgment;
    let form: Stage2Item["form"] = null;
    if (c1 && c2 !== false && c3 !== false && c4 && c5) judgment = "confirmed";
    else if (lt0(r.delta.hi)) judgment = "bad";
    else if (c1) {
      judgment = "partial";
      form = !c5 ? "ro" : !c4 ? "ha" : "i";
    } else judgment = "cannot";
    const dU = diffOf(r.delta, o.ultra[g].delta);
    const dM = diffOf(r.delta, o.macd[g].delta);
    const mde = mdeOf(r.delta, kTotal);
    const passMin = passMinOf(r.delta, kTotal);
    const marks: string[] = [];
    // 16: the 10-point marks
    if (passMin !== null && passMin >= MARK_LINE) marks.push("passMin");
    if (mde !== null && mde >= MARK_LINE) marks.push("mde");
    return {
      src: r.src, group: g, p: hin.find((x) => x.src === r.src)!.p, t: r.delta.t, df: c ? c.df : null,
      holmRank: h.rank, holmPass: h.pass, c1, c2, c3, c4, c5, c2Applied: both, c3Applied, c3q: qs.length, c3pos: pos,
      judgment, form, mde, passMin, simLb: simLb(r.delta, kTotal),
      dU, dM, dULb: simLb(dU, kTotal), dMLb: simLb(dM, kTotal), marks,
    };
  });
  // the promotion to stage 3 (per group, among the confirmed): the largest simultaneous low end; ties nE, table order
  const promote: Record<Group, string | null> = { chart: null, cal: null };
  for (const g of ["chart", "cal"] as const) {
    const conf = items.filter((x) => x.group === g && x.judgment === "confirmed");
    const best = [...conf].sort((a, b) => (b.simLb ?? -Infinity) - (a.simLb ?? -Infinity) || o.rows.find((r) => r.src === b.src)!.nE - o.rows.find((r) => r.src === a.src)!.nE || srcOrder(a.src) - srcOrder(b.src))[0];
    promote[g] = best ? best.src : null;
  }
  // D_AB: a group's other confirmed items against the promoted one
  const dAB: Stage2["dAB"] = [];
  for (const g of ["chart", "cal"] as const) {
    const A = promote[g];
    if (!A) continue;
    const ra = o.rows.find((r) => r.src === A)!;
    for (const x of items) {
      if (x.group !== g || x.judgment !== "confirmed" || x.src === A) continue;
      dAB.push({ A, B: x.src, est: diffOf(ra.delta, o.rows.find((r) => r.src === x.src)!.delta) });
    }
  }
  return { kTotal, items, promote, dAB, intervalsSeen: intervalsSeen2(kTotal, dAB.length) };
};

// 15: the 95% intervals printed from outcomes, itemised (SQ-34). Stage 1: each floor item's Δ and a (M_1 each),
// the emails' Δ and a in both layers (8), the blind's pair × direction a (10); W, PL and Δ_late are points.
// Stage 2: Holm's K_total Δ, C4's K_total Δ_late, and the descriptions: each item's a, W1/PL1/W2/PL2, D_U and
// D_M; each D_AB; the emails' Δ, a and Δ_late in both layers and their W1/PL1/W2/PL2 (10's 「候補と同じ物差し」);
// the blind's pair × direction a and W1/PL1/W2/PL2 (10 × 5).
export interface IntervalsSeen {
  [k: string]: number;
  total: number;
}
const withTotal = (o: Record<string, number>): IntervalsSeen => {
  let t = 0;
  for (const v of Object.values(o)) t += v;
  return { ...o, total: t };
};
export const intervalsSeen1 = (m1: number): IntervalsSeen => withTotal({ delta: m1, a: m1, measures: 2 * 2 * 2, blind: 10 });
export const intervalsSeen2 = (k: number, nDab: number): IntervalsSeen =>
  withTotal({ holm: k, late: k, a: k, winpl: 4 * k, dUdM: 2 * k, dAB: nDab, measures: 2 * 2 * 3 + 2 * 4, blind: 10 * 5 });

// the simultaneous t of K_total items (21: 「〈K_total〉個を同時に直した」)
export const tSim = (kTotal: number, df: number): number => tq(1 - 0.025 / kTotal, df);
