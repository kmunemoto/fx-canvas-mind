// #318 (docs §8.113 8, 9, 10, 14, 16): the numbers. Pure.
//
// v = e ÷ 2. Δ = Σ_s (n_s ÷ N)(mean_s of the signals' v − mean_s of the blind's v), over the strata holding a
// signal with e and a blind row with e (a signal whose stratum has no blind e is dropped and counted).
// The influence of a signal i of stratum s: (d_i − Δ) ÷ N, d_i = v_i − the blind mean of s; of a blind row j
// of a used stratum: −(n_s ÷ N)(v_j − the blind mean) ÷ m_s. Summed by cluster (the week wk(T), the 4-week
// block), SE = √(C ÷ (C − 1) × Σ S_g²), C the clusters receiving a term (SQ-04). The candidates: (week,
// C_w − 1), (4 weeks, C_4 − 1) when C_4 ≥ 10 (SQ-03), (the shift's SD, C_w − 1) for the chart group; the
// widest half t(0.975, df) × SE is used (ties: week, 4 weeks, shift). t = Δ ÷ SE (none when C < 2, N = 0 or
// SE = 0). Sums run oldest first; standard deviations in two passes.
//
// The planted errors acting here (20 (f)): "noBlind", "seNoBlindTerm", "signalTermStratumMean".

import { tQuantile } from "./money-stats.ts";
import { clusterRate } from "./lib.ts";
import { MIN_BLOCKS, ZERO } from "./chartbest-const.ts";
import { wk } from "./chartbest-time.ts";

// ---- Student's t (money-stats.ts's tQuantile; the same incomplete beta for the distribution) ---------------

const LANCZOS = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
const lgamma = (x: number): number => {
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
  const y = x - 1;
  let a = LANCZOS[0];
  const t = y + 7.5;
  for (let i = 1; i < 9; i++) a += LANCZOS[i] / (y + i);
  return 0.5 * Math.log(2 * Math.PI) + (y + 0.5) * Math.log(t) - t + Math.log(a);
};
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
// T(t, df), the distribution function
export const tcdf = (t: number, df: number): number => {
  const p = 0.5 * ibeta(df / 2, 0.5, df / (df + t * t));
  return t >= 0 ? 1 - p : p;
};
// the p quantile (p over 0.5): money-stats.ts tQuantile
export const tq = (p: number, df: number): number => tQuantile(p, df);
// the one-sided p of t (14): 1 − T(t, df); no t: 1
export const pOneSided = (t: number | null, df: number): number => (t === null ? 1 : 1 - tcdf(t, df));

// ---- sums and spreads ---------------------------------------------------------------------------------------

export const sumOldest = (xs: ArrayLike<number>): number => {
  let s = 0;
  for (let k = 0; k < xs.length; k++) s += xs[k];
  return s;
};
export const meanOf = (xs: ArrayLike<number>): number => sumOldest(xs) / xs.length;
// the sample standard deviation, two passes (null under 2 values)
export const sdOf = (xs: ArrayLike<number>): number | null => {
  if (xs.length < 2) return null;
  const m = meanOf(xs);
  let s = 0;
  for (let k = 0; k < xs.length; k++) s += (xs[k] - m) * (xs[k] - m);
  return Math.sqrt(s / (xs.length - 1));
};

// ---- Δ and its influence -------------------------------------------------------------------------------------

export interface Obs {
  // the stratum, the week wk(T), the 4-week block, v = e ÷ 2
  s: number;
  week: number;
  block: number;
  v: number;
}
export type SeKind = "week" | "4w" | "shift";
export interface SeCand {
  kind: SeKind;
  se: number;
  C: number;
  df: number;
  half: number;
}
export interface Inf {
  week: Map<number, number>;
  block: Map<number, number>;
}
export interface Est {
  est: number | null;
  N: number;
  strata: number;
  dropped: number;
  cands: SeCand[];
  use: SeKind | null;
  t: number | null;
  lo: number | null;
  hi: number | null;
  lb: number | null;
  inf: Inf;
}
export const emptyEst = (dropped = 0): Est => ({ est: null, N: 0, strata: 0, dropped, cands: [], use: null, t: null, lo: null, hi: null, lb: null, inf: { week: new Map(), block: new Map() } });

const addTo = (m: Map<number, number>, k: number, x: number) => m.set(k, (m.get(k) ?? 0) + x);
// SE from cluster sums: √(C ÷ (C − 1) × Σ S_g²), clusters in ascending order
export const seOf = (sums: Map<number, number>): { se: number; C: number } => {
  const keys = [...sums.keys()].sort((a, b) => a - b);
  const C = keys.length;
  if (C < 2) return { se: Number.NaN, C };
  let s = 0;
  for (const k of keys) s += sums.get(k)! * sums.get(k)!;
  return { se: Math.sqrt((C / (C - 1)) * s), C };
};
const candOf = (kind: SeKind, se: number, C: number): SeCand | null => {
  const df = C - 1;
  if (!(df >= 1) || !Number.isFinite(se)) return null;
  return { kind, se, C, df, half: tq(0.975, df) * se };
};
// the candidates from the influence sums (and the shift's SD for the chart group)
export const candidatesOf = (inf: Inf, shift?: { sd: number | null; Cw: number }): SeCand[] => {
  const out: SeCand[] = [];
  const w = seOf(inf.week);
  const cw = candOf("week", w.se, w.C);
  if (cw) out.push(cw);
  const b = seOf(inf.block);
  // SQ-03: fewer than 10 blocks drops the 4-week candidate only
  if (b.C >= MIN_BLOCKS) {
    const c4 = candOf("4w", b.se, b.C);
    if (c4) out.push(c4);
  }
  if (shift && shift.sd !== null) {
    const cs = candOf("shift", shift.sd, w.C);
    if (cs) out.push(cs);
  }
  return out;
};
// the widest half; ties: week, 4 weeks, shift (the candidates come in that order)
export const pickSe = (c: SeCand[]): SeCand | null => {
  let best: SeCand | null = null;
  for (const x of c) if (!best || x.half > best.half) best = x;
  return best;
};
// t, the interval and its low end from the estimate and the candidate used
export const finish = (e: Est, shift?: { sd: number | null; Cw: number }): Est => {
  e.cands = candidatesOf(e.inf, shift);
  const use = pickSe(e.cands);
  e.use = use ? use.kind : null;
  if (e.est === null || !use || e.N === 0 || !(use.se > 0)) return e;
  e.t = e.est / use.se;
  e.lo = e.est - use.half;
  e.hi = e.est + use.half;
  e.lb = e.lo;
  return e;
};
export const usedCand = (e: Est): SeCand | null => e.cands.find((c) => c.kind === e.use) ?? null;

export interface DeltaOpts {
  plant?: string;
  // the chart group's shift SD (the candidate (SD_shift, C_w − 1))
  shift?: { sd: number | null; Cw: number };
}
// Δ over the strata of `sig` (signals with e, in their order), against the blind observations of each stratum
export const deltaOf = (sig: Obs[], blindOf: (s: number) => Obs[], o: DeltaOpts = {}): Est => {
  const plant = o.plant ?? "";
  const byS = new Map<number, Obs[]>();
  for (const x of sig) {
    const l = byS.get(x.s);
    if (l) l.push(x);
    else byS.set(x.s, [x]);
  }
  const strata = [...byS.keys()].sort((a, b) => a - b);
  let dropped = 0;
  const used: Array<{ s: number; xs: Obs[]; bs: Obs[]; bm: number; sm: number }> = [];
  for (const s of strata) {
    const xs = byS.get(s)!;
    const bs = blindOf(s);
    if (bs.length === 0) {
      dropped += xs.length;
      continue;
    }
    used.push({ s, xs, bs, bm: meanOf(bs.map((b) => b.v)), sm: meanOf(xs.map((x) => x.v)) });
  }
  let N = 0;
  for (const u of used) N += u.xs.length;
  if (N === 0) return emptyEst(dropped);
  let est = 0;
  for (const u of used) est += (u.xs.length / N) * (plant === "noBlind" ? u.sm : u.sm - u.bm);
  const inf: Inf = { week: new Map(), block: new Map() };
  for (const u of used) {
    for (const x of u.xs) {
      const term = plant === "signalTermStratumMean" ? (x.v - u.sm) / N : (x.v - (plant === "noBlind" ? 0 : u.bm) - est) / N;
      addTo(inf.week, x.week, term);
      addTo(inf.block, x.block, term);
    }
    if (plant === "seNoBlindTerm" || plant === "noBlind") continue;
    const w = u.xs.length / N;
    for (const b of u.bs) {
      const term = (-w * (b.v - u.bm)) / u.bs.length;
      addTo(inf.week, b.week, term);
      addTo(inf.block, b.block, term);
    }
  }
  return finish({ est, N, strata: used.length, dropped, cands: [], use: null, t: null, lo: null, hi: null, lb: null, inf }, o.shift);
};

// 8: the unaligned a: the mean of v over the signals with e; influence (v_i − mean) ÷ N; week and 4 weeks
export const aOf = (sig: Obs[]): Est => {
  const N = sig.length;
  if (N === 0) return emptyEst();
  const m = meanOf(sig.map((x) => x.v));
  const inf: Inf = { week: new Map(), block: new Map() };
  for (const x of sig) {
    addTo(inf.week, x.week, (x.v - m) / N);
    addTo(inf.block, x.block, (x.v - m) / N);
  }
  return finish({ est: m, N, strata: 1, dropped: 0, cands: [], use: null, t: null, lo: null, hi: null, lb: null, inf });
};

// 14: D = x − y (both on the same half and layer): the influence sums subtracted per cluster; week and 4 weeks
export const diffOf = (x: Est, y: Est): Est => {
  if (x.est === null || y.est === null) return emptyEst();
  const inf: Inf = { week: new Map(), block: new Map() };
  for (const key of ["week", "block"] as const) {
    for (const [g, v] of x.inf[key]) addTo(inf[key], g, v);
    for (const [g, v] of y.inf[key]) addTo(inf[key], g, -v);
  }
  return finish({ est: x.est - y.est, N: x.N + y.N, strata: 0, dropped: 0, cands: [], use: null, t: null, lo: null, hi: null, lb: null, inf });
};

// 14, 16: the simultaneous low end and the MDE with K_total
export const simLb = (e: Est, kTotal: number): number | null => {
  const c = usedCand(e);
  if (e.est === null || !c || kTotal < 1) return null;
  return e.est - tq(1 - 0.025 / kTotal, c.df) * c.se;
};
export const mdeOf = (e: Est, kTotal: number): number | null => {
  const c = usedCand(e);
  if (!c || kTotal < 1) return null;
  return (tq(1 - 0.025 / kTotal, c.df) + tq(0.80, c.df)) * c.se;
};
export const passMinOf = (e: Est, kTotal: number): number | null => {
  const c = usedCand(e);
  if (!c || kTotal < 1) return null;
  return tq(1 - 0.025 / kTotal, c.df) * c.se;
};

// 8 (0との比べ): |x| < 1e-12 is 0
export const gt0 = (x: number | null): boolean => x !== null && Math.abs(x) >= ZERO && x > 0;
export const lt0 = (x: number | null): boolean => x !== null && Math.abs(x) >= ZERO && x < 0;

// ---- 9: W and PL (tf-winrate's summarize: clusterRate and meanCi, 1.96, week clusters) --------------------------

export interface WinPl {
  n: number;
  resolved: number;
  tp: number;
  sl: number;
  amb: number;
  open: number;
  wAll: number | null;
  wRes: number | null;
  pl: number | null;
  wLo: number | null;
  wHi: number | null;
  plLo: number | null;
  plHi: number | null;
}
export const winPlOf = (trades: ReadonlyArray<{ T: number; kind: "tp" | "sl" | "amb" | "open"; pips: number }>): WinPl => {
  const n = trades.length;
  let tp = 0, sl = 0, amb = 0, open = 0;
  for (const x of trades) {
    if (x.kind === "tp") tp++;
    else if (x.kind === "sl") sl++;
    else if (x.kind === "amb") amb++;
    else open++;
  }
  const res = trades.filter((x) => x.kind !== "open");
  const cr = clusterRate(res.map((x) => ({ cluster: wk(x.T), win: x.kind === "tp" })));
  // meanCi (tf-winrate): the mean, its week-clustered SE (W/(W − 1)), ± 1.96 SE
  let pl: number | null = null, plLo: number | null = null, plHi: number | null = null;
  if (n > 0) {
    pl = sumOldest(trades.map((x) => x.pips)) / n;
    const by = new Map<number, { s: number; c: number }>();
    for (const x of trades) {
      const w = wk(x.T);
      const g = by.get(w) ?? { s: 0, c: 0 };
      g.s += x.pips;
      g.c++;
      by.set(w, g);
    }
    const W = by.size;
    let v = 0;
    for (const k of [...by.keys()].sort((a, b) => a - b)) {
      const g = by.get(k)!;
      v += (g.s - pl * g.c) ** 2;
    }
    const se = W > 1 ? Math.sqrt((v * W) / (W - 1)) / n : 0;
    plLo = pl - 1.96 * se;
    plHi = pl + 1.96 * se;
  }
  return {
    n, resolved: res.length, tp, sl, amb, open,
    wAll: n ? tp / n : null,
    wRes: cr ? cr.p : null,
    pl,
    wLo: cr && Number.isFinite(cr.se) ? cr.p - 1.96 * cr.se : null,
    wHi: cr && Number.isFinite(cr.se) ? cr.p + 1.96 * cr.se : null,
    plLo, plHi,
  };
};

// ---- the shift's summary (10) ----------------------------------------------------------------------------------

export interface ShiftSummary {
  k: number[];
  delta: Array<number | null>;
  dropped: number[];
  seasonCross: number[];
  sd: number | null;
  n: number;
  mean: number | null;
  q025: number | null;
  q975: number | null;
  // SQ-30: 1 + #{k : Δ_k < Δ}
  rank: number | null;
}
// money-stats quantile: the sorted value at floor(q × (n − 1))
export const quantileOf = (xs: number[], q: number): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))];
};
export const shiftSummary = (k: number[], delta: Array<number | null>, dropped: number[], seasonCross: number[], real: number | null): ShiftSummary => {
  const xs = delta.filter((x): x is number => x !== null);
  return {
    k, delta, dropped, seasonCross,
    sd: sdOf(xs), n: xs.length,
    mean: xs.length ? meanOf(xs) : null,
    q025: quantileOf(xs, 0.025),
    q975: quantileOf(xs, 0.975),
    rank: real === null ? null : 1 + xs.filter((x) => x < real).length,
  };
};
