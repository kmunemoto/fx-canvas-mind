// 法則探し (docs §8.136, research/lawsearch-spec.md): stage 0's decisions (spec 9, 4.6), builder D
// (research/lawsearch-design.md 7.1). Counts only: nothing here reads a trade's price or a measure. Spec 9 asks that
// stage 0's program import no trade or measure code, so this module imports neither lawsearch-trade.ts,
// lawsearch-stats.ts nor lawsearch-select.ts (the CI job checks `deno info research/lawsearch-stage0.ts`). "No trade"
// and "no blind stratum" are decided from bar times alone (entryExitIndex, stratumOf of lawsearch-bars.ts).
//
// The counting ranges (spec 9, 15 数が合う; lawsearch-dump.md 7):
//   * first half: ① (r1, r1w) only for T < SPLIT; ①b (always T < SPLIT); ②–⑥, counted, no trade and no blind for the
//     half's signals (Classified.half = 1); f_none and both by the half's T/X rule (Classified.half);
//   * second half: the same with T ≥ SPLIT for ① (spec 9: those go into the second half's totals) and half = 2;
//   * the whole read range: every ① (r1All), r1w, r1b; adds up: emitted = r1All + r1w + r1b + Σ_halves (r2 … r6,
//     counted).

import { tQuantile } from "./money-stats.ts";
import { N_BARS, PAIRS, SPLIT, wk } from "./lawsearch-const.ts";
import { FIXED_B_GROUPS, FIXED_E_GROUPS, FLOOR_SIGNALS, FLOOR_WEEKS, HALF_WEEKS, MARK_PASS_MIN, OVERLAP_SHARE, REASONS, STATUS } from "./lawsearch-rules.ts";
import { entryExitIndex, stratumOf } from "./lawsearch-bars.ts";
import type { Stage0Half, Stage0Row, TfKey, TfSet, TrialKind, TrialSignals } from "./lawsearch-types.ts";

const RI = Object.fromEntries(REASONS.map((r, k) => [r, k])) as Record<string, number>;
const ST_EMIT = STATUS.indexOf("emit");
const ST_F_NONE = STATUS.indexOf("f_none");
const ST_BOTH = STATUS.indexOf("both");
const HALF_CODE = { first: 1, second: 2 } as const;
// spec 9 K = 6 at stage 0 (three per timeframe)
const K_STAGE0 = 6;

// ---- the counted lists ------------------------------------------------------------------------------------------

// A trial's counted signals of one half in 21.5's row order (T ascending, then pair, then buy before sell)
export interface SigList {
  pi: Int8Array;
  T: Float64Array;
  d: Int8Array;
}

// (T, pi, d) row order of three parallel arrays: the permutation that sorts them (stable)
const rowOrder = (pi: ArrayLike<number>, T: ArrayLike<number>, d: ArrayLike<number>): number[] => {
  const idx = Array.from({ length: T.length }, (_, k) => k);
  idx.sort((a, b) => T[a] - T[b] || pi[a] - pi[b] || (d[a] === 1 ? 0 : 1) - (d[b] === 1 ? 0 : 1) || a - b);
  return idx;
};

export const sigListOf = (pi: ArrayLike<number>, T: ArrayLike<number>, d: ArrayLike<number>): SigList => {
  const o = rowOrder(pi, T, d);
  return { pi: Int8Array.from(o, (k) => pi[k]), T: Float64Array.from(o, (k) => T[k]), d: Int8Array.from(o, (k) => d[k]) };
};

export function countedList(sig: TrialSignals, half: "first" | "second"): SigList {
  const want = HALF_CODE[half];
  const pi: number[] = [];
  const T: number[] = [];
  const d: number[] = [];
  for (const c of sig.pairs) {
    for (let r = 0; r < c.n; r++) {
      if (c.reason[r] !== RI.counted || c.half[r] !== want) continue;
      pi.push(c.pi);
      T.push(c.T[r]);
      d.push(c.d[r]);
    }
  }
  return sigListOf(pi, T, d);
}

// ---- the blind strata (8.1, 8.2: a counted signal's stratum always has its blind row, by construction) -----------

// The strata of the half's passing bars (②–⑥ passed) that have an entry bar, both directions
export function blindStrataOf(tf: TfSet, passing: Uint8Array[]): Set<number> {
  const out = new Set<number>();
  tf.pairs.forEach((s, pi) => {
    const p = passing[pi];
    if (!p || p.length !== s.n) throw new Error(`blindStrataOf: pair ${pi} has ${s.n} bars, passing ${p?.length}`);
    for (let i = 0; i < s.n; i++) {
      if (p[i] !== 1) continue;
      const T = s.T[i];
      if (entryExitIndex(s, T, T + N_BARS * tf.step) === null) continue;
      out.add(stratumOf(pi, 1, T));
      out.add(stratumOf(pi, -1, T));
    }
  });
  return out;
}

// ---- spec 9's numbers of one half -------------------------------------------------------------------------------

export function stage0Half(sig: TrialSignals, half: "first" | "second", tf: TfSet, blindStrata: Set<number>): Stage0Half {
  if (sig.tf !== tf.tf) throw new Error(`stage0Half: ${sig.trial.id} is ${sig.tf}, the bars ${tf.tf}`);
  const want = HALF_CODE[half];
  const byPairDir = new Array<number>(PAIRS.length * 2).fill(0);
  const byReason = new Array<number>(REASONS.length).fill(0);
  const weeks = new Set<number>();
  let counted = 0;
  let noTrade = 0;
  let noBlind = 0;
  let fNone = 0;
  let both = 0;
  for (const c of sig.pairs) {
    const s = tf.pairs[c.pi];
    for (let r = 0; r < c.n; r++) {
      const T = c.T[r];
      const st = c.status[r];
      const reason = c.reason[r];
      if (st === ST_F_NONE || st === ST_BOTH) {
        if (c.half[r] !== want) continue;
        if (st === ST_F_NONE) fNone++;
        else both++;
        byReason[reason]++;
        continue;
      }
      if (st !== ST_EMIT) throw new Error(`stage0Half: ${sig.trial.id} status ${st}`);
      if (reason === RI.r1 || reason === RI.r1w || reason === RI.r1b) {
        // ① and ①b: one count over the whole read range; per half by T against SPLIT (spec 9)
        if ((T < SPLIT) === (half === "first")) byReason[reason]++;
        continue;
      }
      if (c.half[r] !== want) continue;
      byReason[reason]++;
      if (reason !== RI.counted) continue;
      counted++;
      const d = c.d[r] as 1 | -1;
      byPairDir[c.pi * 2 + (d === 1 ? 0 : 1)]++;
      weeks.add(wk(T));
      if (entryExitIndex(s, T, c.X[r]) === null) noTrade++;
      else if (!blindStrata.has(stratumOf(c.pi, d, T))) noBlind++;
    }
  }
  return { counted, weeks: weeks.size, byPairDir, byReason, noBlind, noTrade, fNone, both, perWeek: counted / HALF_WEEKS[half] };
}

// ---- the floor, same trials, overlap groups ---------------------------------------------------------------------

// spec 9 床: ≥ 300 counted signals and ≥ 30 weeks with one, in both halves
export function floorPass(r: { first: Pick<Stage0Half, "counted" | "weeks">; second: Pick<Stage0Half, "counted" | "weeks"> }): boolean {
  return r.first.counted >= FLOOR_SIGNALS && r.first.weeks >= FLOOR_WEEKS && r.second.counted >= FLOOR_SIGNALS && r.second.weeks >= FLOOR_WEEKS;
}

const listKey = (l: SigList): string => {
  const o = rowOrder(l.pi, l.T, l.d);
  return o.map((k) => `${l.T[k]}:${l.pi[k]}:${l.d[k]}`).join(",");
};

// spec 4.6 同じ試し: the first-half counted sets (pair, T, d) compared within one timeframe; a trial with no signal is
// not compared; the name given is the earliest trial in table order with the same set (null: none)
export function sameTrials(rows: ReadonlyArray<{ id: string; tf: TfKey; order: number; list: SigList }>): Map<string, string | null> {
  const out = new Map<string, string | null>();
  const first = new Map<string, { id: string; order: number }>();
  const byOrder = [...rows].sort((a, b) => a.order - b.order);
  for (const r of byOrder) {
    if (r.list.T.length === 0) {
      out.set(r.id, null);
      continue;
    }
    const key = `${r.tf}|${listKey(r.list)}`;
    const hit = first.get(key);
    if (hit) out.set(r.id, hit.id);
    else {
      first.set(key, { id: r.id, order: r.order });
      out.set(r.id, null);
    }
  }
  return out;
}

// the T of one (pair, direction) of a list, ascending
const byPd = (l: SigList): Map<number, Float64Array> => {
  const m = new Map<number, number[]>();
  for (let k = 0; k < l.T.length; k++) {
    const key = l.pi[k] * 2 + (l.d[k] === 1 ? 0 : 1);
    let a = m.get(key);
    if (!a) m.set(key, (a = []));
    a.push(l.T[k]);
  }
  const out = new Map<number, Float64Array>();
  for (const [k, a] of m) out.set(k, Float64Array.from(a).sort());
  return out;
};

// the number of a's signals with a b signal of the same pair and direction within `step` (|ΔT| ≤ step)
export const overlapCount = (a: SigList, b: SigList, step: number): number => {
  const bm = byPd(b);
  let hit = 0;
  for (let k = 0; k < a.T.length; k++) {
    const arr = bm.get(a.pi[k] * 2 + (a.d[k] === 1 ? 0 : 1));
    if (!arr) continue;
    const T = a.T[k];
    // the first b with T_b ≥ T − step
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] < T - step) lo = mid + 1;
      else hi = mid;
    }
    if (lo < arr.length && Math.abs(arr[lo] - T) <= step) hit++;
  }
  return hit;
};

// spec 9 重なり: the share of a's first-half counted signals with a b signal (same pair and direction, |ΔT| ≤ one bar)
export function overlapShare(a: SigList, b: SigList, step: number): number {
  return a.T.length === 0 ? 0 : overlapCount(a, b, step) / a.T.length;
}

// the fixed group index of an E or a B (spec 9 決まった組), or −1
const fixedOf = (ids: ReadonlyArray<readonly string[]>, x: string | null): number => (x === null ? -1 : ids.findIndex((g) => g.includes(x)));

// spec 9 重なりの組: union of the fixed links (the 15 trials of one E, FIXED_E_GROUPS, FIXED_B_GROUPS) and of the
// overlap links (max(share A→B, B→A) ≥ OVERLAP_SHARE) between floor-passing EF and B trials of one timeframe. Only
// floor-passing trials are grouped (a trial under the floor has no measures: A.2.18's not_grouped). An S row (and an
// R row) is a group of its own and never a link (21.5). The group's name is its first trial in table order. A trial
// that is not grouped is absent from the map.
export function overlapGroups(
  rows: ReadonlyArray<{ id: string; tf: TfKey; order: number; kind: TrialKind; e: string | null; b: string | null; floor: boolean; list: SigList }>,
  step: Record<TfKey, number>,
): Map<string, string> {
  const out = new Map<string, string>();
  const sorted = [...rows].sort((a, b) => a.order - b.order);
  for (const tf of ["m15", "h1"] as const) {
    const linkable = sorted.filter((r) => r.tf === tf && r.floor && (r.kind === "EF" || r.kind === "B"));
    const parent = linkable.map((_, k) => k);
    const find = (k: number): number => {
      while (parent[k] !== k) k = parent[k] = parent[parent[k]];
      return k;
    };
    // the root is always the smaller index (the earlier trial in table order)
    const union = (a: number, b: number) => {
      const ra = find(a);
      const rb = find(b);
      if (ra < rb) parent[rb] = ra;
      else if (rb < ra) parent[ra] = rb;
    };
    const fixedKey = (r: (typeof linkable)[number]): string[] => {
      const keys: string[] = [];
      if (r.kind === "EF" && r.e !== null) {
        keys.push(`E:${r.e}`);
        const g = fixedOf(FIXED_E_GROUPS, r.e);
        if (g >= 0) keys.push(`EG:${g}`);
      }
      if (r.kind === "B") {
        const g = fixedOf(FIXED_B_GROUPS, r.b);
        if (g >= 0) keys.push(`BG:${g}`);
      }
      return keys;
    };
    const firstOfKey = new Map<string, number>();
    linkable.forEach((r, k) => {
      for (const key of fixedKey(r)) {
        const f = firstOfKey.get(key);
        if (f === undefined) firstOfKey.set(key, k);
        else union(f, k);
      }
    });
    for (let a = 0; a < linkable.length; a++) {
      for (let b = a + 1; b < linkable.length; b++) {
        if (find(a) === find(b)) continue;
        const A = linkable[a].list;
        const B = linkable[b].list;
        const share = Math.max(overlapShare(A, B, step[tf]), overlapShare(B, A, step[tf]));
        if (share >= OVERLAP_SHARE) union(a, b);
      }
    }
    linkable.forEach((r, k) => out.set(r.id, linkable[find(k)].id));
    for (const r of sorted) if (r.tf === tf && r.floor && r.kind !== "EF" && r.kind !== "B") out.set(r.id, r.id);
  }
  return out;
}

// ---- spec 9 見分けられる大きさの見込み ---------------------------------------------------------------------------

// se = 50 × √(g ÷ n2); passMin = t(1 − 0.025 ÷ K, df) × se; mde = (t(1 − 0.025 ÷ K, df) + t(0.80, df)) × se;
// mark = passMin ≥ 8 (the suspicion line, 13)
export function mdeOf(g: number, n2: number, df: number, K: number): { se: number; passMin: number; mde: number; mark: boolean } {
  const se = 50 * Math.sqrt(g / n2);
  const tTop = tQuantile(1 - 0.025 / K, df);
  const passMin = tTop * se;
  const mde = (tTop + tQuantile(0.8, df)) * se;
  return { se, passMin, mde, mark: passMin >= MARK_PASS_MIN };
}

// g = (the mean used SE of the N runs ÷ (50 ÷ √n1))²
export function gOf(meanUsedSe: number, n1: number): number {
  const x = meanUsedSe / (50 / Math.sqrt(n1));
  return x * x;
}

// spec 9 PL の見込み: se = sd × √(g ÷ n2); the top of Holm's ladder = t(1 − 0.025 ÷ K, df) × se
export function plEstimate(sdPips: number, g: number, n2: number, df: number, K: number): { se: number; topHolm: number } {
  const se = sdPips * Math.sqrt(g / n2);
  return { se, topHolm: tQuantile(1 - 0.025 / K, df) * se };
}

// spec 9 段3の数の見込み: n2 × 52 ÷ 76
export function stage3Estimate(n2: number): number {
  return (n2 * 52) / 76;
}

// ---- stage 0 ---------------------------------------------------------------------------------------------------

// Every trial's row of spec 9 (input order is kept; the callers pass table order). g and gDf: spec 9's g and its df
// per trial id (from the N runs, step 4); a trial without g has the six MDE fields null (lawsearch-dump.md 7).
export function stage0(
  sigs: TrialSignals[],
  tf: Record<TfKey, TfSet>,
  passing: Record<TfKey, { first: Uint8Array[]; second: Uint8Array[] }>,
  g: Record<string, number>,
  gDf: Record<string, number>,
): Stage0Row[] {
  const strata: Record<TfKey, { first: Set<number>; second: Set<number> }> = {
    m15: { first: blindStrataOf(tf.m15, passing.m15.first), second: blindStrataOf(tf.m15, passing.m15.second) },
    h1: { first: blindStrataOf(tf.h1, passing.h1.first), second: blindStrataOf(tf.h1, passing.h1.second) },
  };
  const base = sigs.map((sig) => {
    const t = tf[sig.tf];
    const first = stage0Half(sig, "first", t, strata[sig.tf].first);
    const second = stage0Half(sig, "second", t, strata[sig.tf].second);
    let emitted = 0;
    let r1All = 0;
    let r1b = 0;
    let r1w = 0;
    let halves = 0;
    for (const c of sig.pairs) {
      for (let r = 0; r < c.n; r++) {
        if (c.status[r] !== ST_EMIT) continue;
        emitted++;
        const reason = c.reason[r];
        if (reason === RI.r1) r1All++;
        else if (reason === RI.r1w) r1w++;
        else if (reason === RI.r1b) r1b++;
        else if (c.half[r] === 1 || c.half[r] === 2) halves++;
      }
    }
    const list = countedList(sig, "first");
    return { sig, first, second, emitted, r1All, r1b, r1w, addsUp: emitted === r1All + r1w + r1b + halves, floor: floorPass({ first, second }), list };
  });
  const same = sameTrials(base.map((b) => ({ id: b.sig.trial.id, tf: b.sig.tf, order: b.sig.trial.order, list: b.list })));
  const groups = overlapGroups(
    base.map((b) => ({ id: b.sig.trial.id, tf: b.sig.tf, order: b.sig.trial.order, kind: b.sig.trial.kind, e: b.sig.trial.e, b: b.sig.trial.b, floor: b.floor, list: b.list })),
    { m15: tf.m15.step, h1: tf.h1.step },
  );
  return base.map((b) => {
    const id = b.sig.trial.id;
    const gi = Object.hasOwn(g, id) ? g[id] : null;
    const df = gi !== null && Object.hasOwn(gDf, id) ? gDf[id] : null;
    const m = gi !== null && df !== null ? mdeOf(gi, b.second.counted, df, K_STAGE0) : null;
    return {
      trial: id,
      tf: b.sig.tf,
      order: b.sig.trial.order,
      first: b.first,
      second: b.second,
      r1All: b.r1All,
      r1b: b.r1b,
      r1w: b.r1w,
      emitted: b.emitted,
      addsUp: b.addsUp,
      floor: b.floor,
      sameAs: same.get(id) ?? null,
      group: groups.get(id) ?? "",
      g: m ? gi : null,
      df: m ? df : null,
      passMin: m ? m.passMin : null,
      mde: m ? m.mde : null,
      mark: m ? m.mark : null,
      stage3Estimate: m ? stage3Estimate(b.second.counted) : null,
    };
  });
}
