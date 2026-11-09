// 法則探し (docs §8.136, research/lawsearch-spec.md): the decisions of stages 1 and 2 (spec 10, 11, 13), builder D
// (research/lawsearch-design.md 7.2). Pure functions of plain records (the hand examples A.2.20–A.2.23 and A.2.27 feed
// them directly). The labels are the exact strings of lawsearch-design.md 7.2 (A.2.20, A.2.23); the Python writes the
// same ones.
//
// The zero rule of 8.5 (|x| < 1e−12 is 0) applies to every comparison of a spec 8–11 number with 0 here (Δ, PL, the
// PL without one week, D_F, Δ_late's lower end, PL_late, the halves of C6, Δ's upper end).

import { tq, isZero } from "./lawsearch-stats.ts";
import { ALPHA, BH_Q, C3_MIN_PAIRS, C_MIN_N, PER_TF, SUSPECT } from "./lawsearch-rules.ts";
import type { SkipReason, Stage1Cand, Stage1Explain, Stage1Out, Stage2Cand, Stage2Row, SuspectRow, TfKey, TrialMeasures, ValueEst } from "./lawsearch-types.ts";

// x > 0 for a spec 8–11 number (null and |x| < 1e−12 are not > 0)
const pos = (x: number | null | undefined): boolean => x !== null && x !== undefined && Number.isFinite(x) && !isZero(x) && x > 0;
// x < 0 likewise
const neg = (x: number | null | undefined): boolean => x !== null && x !== undefined && Number.isFinite(x) && !isZero(x) && x < 0;

// ---- stage 1 (spec 10) ------------------------------------------------------------------------------------------

// 0 when the trial may be chosen, else the first of rules 1–6 it fails. Plants: noEx1Week (rule 4 without the PL that
// leaves out one week), noDF (rule 5 dropped).
export function failRuleOf(c: Stage1Cand, q4: "a" | "b", plant = ""): number {
  if (!c.passFloor || c.same) return 1;
  if (!c.checksOk) return 2;
  if (!c.hasT || !pos(c.delta)) return 3;
  if (!pos(c.pl) || (plant !== "noEx1Week" && !pos(c.plEx1w))) return 4;
  // rule 5 is the (E, F) trials' with a directional F (an S row is the F itself and has no D_F)
  if (plant !== "noDF" && !c.isS && c.directionalF && !pos(c.dF)) return 5;
  if (c.suspicious) {
    if (q4 === "b") return 6;
    if (c.suspiciousChecksPassed !== true) return 6;
  }
  return 0;
}

// 10 並べ方: LB descending, then n descending, then table order
const byLb = (a: Stage1Cand, b: Stage1Cand): number => {
  const la = a.lb as number;
  const lb = b.lb as number;
  if (la !== lb) return lb - la;
  if (a.n !== b.n) return b.n - a.n;
  return a.order - b.order;
};

// 10 選ぶ数: per timeframe, from the top, at most PER_TF, skipping (same overlap group; an (E, F) after its S_F; an S_F
// after an (E, F) of the same F name). Within one timeframe (spec 9: the two timeframes are separate groups; 10: three
// from each).
export function chooseStage1(cands: Stage1Cand[], q4: "a" | "b", plant = ""): Stage1Out {
  const failRule = new Map<string, number>();
  for (const c of cands) failRule.set(c.id, failRuleOf(c, q4, plant));
  const order: Record<TfKey, string[]> = { m15: [], h1: [] };
  const chosen: Record<TfKey, string[]> = { m15: [], h1: [] };
  const skipped: Stage1Out["skipped"] = [];
  for (const tf of ["m15", "h1"] as const) {
    const el = cands.filter((c) => c.tf === tf && failRule.get(c.id) === 0).sort(byLb);
    order[tf] = el.map((c) => c.id);
    const picked: Stage1Cand[] = [];
    for (const c of el) {
      if (picked.length >= PER_TF) break;
      let skip: { reason: SkipReason; by: string } | null = null;
      for (const p of picked) {
        if (p.group === c.group) skip = { reason: "same-group", by: p.id };
        else if (p.isS && !c.isS && c.f !== null && c.f === p.f) skip = { reason: "S-then-EF", by: p.id };
        else if (!p.isS && c.isS && p.f !== null && p.f === c.f) skip = { reason: "EF-then-S", by: p.id };
        if (skip) break;
      }
      if (skip) skipped.push({ id: c.id, ...skip });
      else picked.push(c);
    }
    chosen[tf] = picked.map((c) => c.id);
  }
  return { failRule, order, chosen, skipped, K_total: chosen.m15.length + chosen.h1.length };
}

// the labels of a skip (lawsearch-design.md 7.2; <by> is the chosen trial's name as the caller gives it)
export function skipText(reason: SkipReason, by: string): string {
  if (reason === "same-group") return `同じ重なりの組（${by}）`;
  if (reason === "S-then-EF") return `選んだ ${by} と同じ F の (E, F)`;
  return `選んだ ${by} と同じ F の S`;
}

// 21.5 参考の BH: the largest k with p_(k) ≤ k × q ÷ m (p ascending; m = the number of p)
export function bhCount(ps: readonly number[], q: number): number {
  const s = [...ps].sort((a, b) => a - b);
  const m = s.length;
  let best = 0;
  for (let k = 1; k <= m; k++) if (s[k - 1] <= (k * q) / m) best = k;
  return best;
}

// 10 説明として出すもの (the trial's part): trials with LB > 0 and their groups, LB > 0 and PL > 0, and the reference
// BH (q = 0.10) over pIut (the first half's max(p_Δ, p_PL), κ not applied, of every trial measured at stage 1). The
// trials counted are those measured at stage 1 (floor passed, not a same trial).
export function stage1Explain(cands: Stage1Cand[], pIut: Map<string, number>): Stage1Explain {
  const measured = cands.filter((c) => c.passFloor && !c.same);
  const lbPos = measured.filter((c) => pos(c.lb));
  return {
    lbPos: lbPos.length,
    lbPosGroups: new Set(lbPos.map((c) => `${c.tf}|${c.group}`)).size,
    lbAndPlPos: lbPos.filter((c) => pos(c.pl)).length,
    bhM: pIut.size,
    bhPass: bhCount([...pIut.values()], BH_Q),
  };
}

// ---- spec 13 ------------------------------------------------------------------------------------------------------

// spec 13's lines on one row of measures (only rows with ≥ 100 counted signals are looked at)
export function suspectOf(m: TrialMeasures): Omit<SuspectRow, "checks" | "checksPassed"> {
  const looked = m.counted >= SUSPECT.minN;
  const d = m.delta.value;
  const a = m.a.value;
  const pl = m.pl.value;
  const late = m.deltaLate.value;
  const M = m.extras.M;
  const w = m.extras.wRate;
  const hitDelta = looked && d !== null && Math.abs(d) >= SUSPECT.delta;
  const hitA = looked && a !== null && Math.abs(a) >= SUSPECT.a;
  const hitPl = looked && pl !== null && M !== null && pl >= SUSPECT.plFrac * M;
  const hitLate = looked && d !== null && late !== null && Math.abs(d - late) >= SUSPECT.late;
  const hitW = looked && w !== null && (w === 0 || w === 1);
  return { id: m.trial, half: m.half, looked, hitDelta, hitA, hitPl, hitLate, hitW, hit: hitDelta || hitA || hitPl || hitLate || hitW };
}

// ---- stage 2 (spec 11) ------------------------------------------------------------------------------------------

// What stage 2 reads besides Stage2Cand (lawsearch-design.md 7.2 does not carry them; the program fills them):
//   deltaLate  Δ_late's point (plant c4PointOnly reads it);
//   deltaEst   Δ's ValueEst after κ (the MDE and the simultaneous lower end of 11 use its candidates);
//   dF         D_F's ValueEst (its uncorrected two-sided 95% interval; null for a trial without a directional F).
export interface Stage2Extra {
  deltaLate?: number | null;
  deltaEst?: ValueEst | null;
  dF?: ValueEst | null;
}
export type Stage2In = Stage2Cand & Stage2Extra;

// Holm (one-sided, 2.5% over the family of K): p ascending; ties by min(t_Δ, t_PL) descending (delta: t_Δ), then n
// descending, then table order; p = 1 ties by n, then table order. Pass while p_(k) ≤ 0.025 ÷ (K − k + 1). Plants:
// noHolm (each p ≤ 0.025 on its own), iutOneLeg (the IUT p is p_Δ).
export function holm(cands: Stage2Cand[], K: number, which: "iut" | "delta", plant = ""): Map<string, { rank: number; pass: boolean; p: number }> {
  const rows = cands.map((c) => {
    const p = which === "delta" || plant === "iutOneLeg" ? c.pDelta : Math.max(c.pDelta, c.pPl);
    const t = which === "delta" || plant === "iutOneLeg" ? c.tDelta : c.tDelta === null || c.tPl === null ? null : Math.min(c.tDelta, c.tPl);
    return { c, p, t };
  });
  rows.sort((a, b) => {
    if (a.p !== b.p) return a.p - b.p;
    if (a.p !== 1) {
      const ta = a.t ?? -Infinity;
      const tb = b.t ?? -Infinity;
      if (ta !== tb) return tb - ta;
    }
    if (a.c.n !== b.c.n) return b.c.n - a.c.n;
    return a.c.order - b.c.order;
  });
  const out = new Map<string, { rank: number; pass: boolean; p: number }>();
  let going = true;
  rows.forEach((r, k) => {
    const rank = k + 1;
    let pass: boolean;
    if (plant === "noHolm") pass = r.p <= ALPHA;
    else {
      pass = going && r.p <= ALPHA / (K - rank + 1);
      if (!pass) going = false;
    }
    out.set(r.c.id, { rank, pass, p: r.p });
  });
  return out;
}

// the Holm threshold of rank k in a family of K
export const holmThreshold = (K: number, rank: number): number => ALPHA / (K - rank + 1);

// C1 … C7 (spec 11). C2 / C3 look at directions and pairs with ≥ 30 counted signals (a direction or pair under it is
// not looked at; none looked at: met). C3 applies with ≥ 3 such pairs (fewer: met). Plants: c4PointOnly (C4 = Δ_late's
// point > 0 and PL_late > 0), noEx1Week (C7 dropped).
export function conditionsOf(c: Stage2In, holmPass: boolean, q4: "a" | "b", plant = ""): [boolean, boolean, boolean, boolean, boolean, boolean, boolean] {
  const C1 = holmPass;
  let C2 = true;
  for (let k = 0; k < 2; k++) if (c.countedByDir[k] >= C_MIN_N && !pos(c.deltaByDir[k])) C2 = false;
  let q = 0;
  let up = 0;
  c.countedByPair.forEach((n, k) => {
    if (n < C_MIN_N) return;
    q++;
    if (pos(c.deltaByPair[k])) up++;
  });
  const C3 = q < C3_MIN_PAIRS || 2 * up > q;
  let C4: boolean;
  if (plant === "c4PointOnly") {
    if (c.deltaLate === undefined) throw new Error(`conditionsOf: ${c.id} has no Δ_late point (plant c4PointOnly)`);
    C4 = pos(c.deltaLate) && pos(c.plLate);
  } else C4 = pos(c.lateLb) && pos(c.plLate);
  const C5 = !c.suspicious || (q4 === "a" && c.suspiciousChecksPassed === true);
  const C6 = pos(c.c6[0]) && pos(c.c6[1]);
  const C7 = plant === "noEx1Week" ? true : pos(c.plEx1w);
  return [C1, C2, C3, C4, C5, C6, C7];
}

// spec 11 判定, the first that applies: 1 C1–C7 all met; 2 Δ's upper end < 0; 3 C1 met (another failed); 4 C1 failed
// but the Δ-only Holm passed; 5 otherwise
export function verdictOf(C: readonly boolean[], deltaUb: number | null, holmDeltaPass: boolean): 1 | 2 | 3 | 4 | 5 {
  if (C.every((x) => x)) return 1;
  if (neg(deltaUb)) return 2;
  if (C[0]) return 3;
  if (holmDeltaPass) return 4;
  return 5;
}

// the exact labels (lawsearch-design.md 7.2); failed: the condition numbers (1–7) verdict 3 names
export function verdictLabel(v: 1 | 2 | 3 | 4 | 5, failed: number[], q2: "a" | "b"): string {
  if (v === 1) {
    if (q2 === "b") return "後半で確かめられた（問2 は (b) なので「法則の候補」。段3を待つ）";
    throw new Error("verdictLabel: no label is fixed for verdict 1 under question 2 (a)");
  }
  if (v === 2) return "悪い";
  if (v === 3) return `一部（満たさなかった条件: ${failed.map((k) => `C${k}`).join("・")}）`;
  if (v === 4) return "向きだけ";
  return "言えない";
}

// spec 11 文: D_F's lower end ≤ 0
export const NO_UPLIFT_TEXT = "合図 E を足した分の上積みは言えない（F だけの行と区別できない）";

// 11 MDE = (t(1 − 0.025 ÷ K, df) + t(0.80, df)) × se, with the se and df of the candidate p_Δ used (κ applied)
export function mdeStage2(e: ValueEst, K: number): number | null {
  if (!e.hasT || e.useP === null) return null;
  const c = e.cands.find((x) => x.kind === e.useP);
  if (!c || c.se === null || c.t === null) return null;
  return (tq(1 - ALPHA / K, c.df) + tq(0.8, c.df)) * c.se;
}

// 11 同時の下の端 (Bonferroni): Δ − the widest t(1 − 0.025 ÷ K, df) × se of the used candidates (8.5)
export function simLowerOf(e: ValueEst, K: number): number | null {
  if (!e.hasT || e.value === null) return null;
  let w = -Infinity;
  for (const c of e.cands) {
    if (c.se === null || c.t === null) return null;
    const h = tq(1 - ALPHA / K, c.df) * c.se;
    if (h > w) w = h;
  }
  return e.value - w;
}

// One stage-2 row with the label and D_F's sentence (lawsearch-dump.md 8 stage2.csv)
export interface Stage2RowX extends Stage2Row {
  label: string;
  dFLo: number | null;
  dFHi: number | null;
  // D_F's lower end ≤ 0 (null: no directional F)
  noUplift: boolean | null;
}

// Every chosen trial's row (input order kept; the caller passes table order)
export function stage2Rows(cands: Stage2In[], K: number, q2: "a" | "b", q4: "a" | "b", plant = ""): Stage2RowX[] {
  const hi = holm(cands, K, "iut", plant);
  const hd = holm(cands, K, "delta", plant);
  return cands.map((c) => {
    const a = hi.get(c.id)!;
    const b = hd.get(c.id)!;
    const C = conditionsOf(c, a.pass, q4, plant);
    const verdict = verdictOf(C, c.deltaUb, b.pass);
    const failed = verdict === 3 ? C.map((x, k) => (x ? 0 : k + 1)).filter((k) => k > 0) : [];
    const dF = c.dF ?? null;
    return {
      id: c.id,
      pIut: a.p,
      holmRank: a.rank,
      holmPass: a.pass,
      holmDeltaRank: b.rank,
      holmDeltaPass: b.pass,
      C,
      verdict,
      failed,
      mde: c.deltaEst ? mdeStage2(c.deltaEst, K) : null,
      simLb: c.deltaEst ? simLowerOf(c.deltaEst, K) : null,
      label: verdictLabel(verdict, failed, q2),
      dFLo: dF ? dF.lb : null,
      dFHi: dF ? dF.ub : null,
      noUplift: dF ? dF.lb === null || !pos(dF.lb) : null,
    };
  });
}
