// #188: the intervals research/money.ts gives its means (docs §8.99 区間・幅
// 「1回あたり: #187 と同じ作り」), copied from research/stop2n.ts: the mean,
// its standard error clustered by week (Sunday 21:00 UTC) and by four weeks,
// each with Student's t at C − 1 degrees of freedom; the lower of the two low
// ends and the higher of the two high ends. Deno-free; no state.

import { WEEK, WEEK_OFFSET } from "./lib.ts";

// ---- Student's t (as stop2n.ts) ---------------------------------------------------------

const LANCZOS = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
const lgamma = (x: number): number => {
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
  const y = x - 1;
  let a = LANCZOS[0];
  const t = y + 7.5;
  for (let i = 1; i < 9; i++) a += LANCZOS[i] / (y + i);
  return 0.5 * Math.log(2 * Math.PI) + (y + 0.5) * Math.log(t) - t + Math.log(a);
};
// the regularized incomplete beta, by its continued fraction (Lentz)
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
const tCdf = (t: number, df: number): number => {
  const p = 0.5 * ibeta(df / 2, 0.5, df / (df + t * t));
  return t >= 0 ? 1 - p : p;
};
const tqCache = new Map<string, number>();
// the p quantile (p over 0.5) of Student's t with df degrees of freedom
export const tQuantile = (p: number, df: number): number => {
  if (!(df >= 1) || !(p > 0.5 && p < 1)) return Number.NaN;
  const key = `${p}:${df}`;
  const hit = tqCache.get(key);
  if (hit !== undefined) return hit;
  let lo = 0;
  let hi = 1;
  while (tCdf(hi, df) < p) hi *= 2;
  for (let k = 0; k < 200 && hi - lo > 1e-12; k++) {
    const mid = (lo + hi) / 2;
    if (tCdf(mid, df) < p) lo = mid;
    else hi = mid;
  }
  const q = (lo + hi) / 2;
  tqCache.set(key, q);
  return q;
};
// against the printed tables, before anything is computed with it
for (const [p, df, want] of [[0.975, 1, 12.706], [0.975, 2, 4.303], [0.975, 10, 2.228], [0.975, 17, 2.110], [0.995, 10, 3.169], [0.95, 5, 2.015], [0.9975, 17, 3.222], [0.975, 1e6, 1.960]]) {
  const got = tQuantile(p, df);
  if (!(Math.abs(got - want) < 1e-3)) throw new Error(`t(${p}, ${df}) came out ${got}, the table's ${want}`);
}

// ---- the mean and its interval, clustered by week and by four weeks ---------------------

export const weekOf = (t: number) => Math.floor((t - WEEK_OFFSET) / WEEK);

// the sums a mean and its clustered standard error are made of
export interface Clustered {
  n: number;
  sum: number;
  weeks: Map<number, { n: number; s: number }>;
  blocks: Map<number, { n: number; s: number }>;
}
// values with the week each belongs to (a trade's: the week of its signal's close T)
export const clustered = (xs: ReadonlyArray<{ x: number; week: number }>): Clustered => {
  const a: Clustered = { n: 0, sum: 0, weeks: new Map(), blocks: new Map() };
  for (const { x, week } of xs) {
    a.n++;
    a.sum += x;
    for (const [m, k] of [[a.weeks, week], [a.blocks, Math.floor(week / 4)]] as const) {
      const w = m.get(k) ?? { n: 0, s: 0 };
      w.n++;
      w.s += x;
      m.set(k, w);
    }
  }
  return a;
};
export type By = "weeks" | "blocks";
// the mean, its standard error (cluster-robust by week, or by four weeks)
// and the clusters (stop2n.ts statOf)
export const statOf = (a: Clustered, by: By = "weeks") => {
  if (a.n === 0) return null;
  const m = a.sum / a.n;
  const C = a[by].size;
  let s = 0;
  for (const g of a[by].values()) s += (g.s - m * g.n) ** 2;
  const se = C > 1 ? Math.sqrt((C / (C - 1)) * s) / a.n : Number.NaN;
  return { m, se, C };
};
// the mean and its interval, t(C − 1) at `p` a side
export const intervalOf = (a: Clustered, by: By = "weeks", p = 0.975) => {
  const st = statOf(a, by);
  if (!st) return { m: null as number | null, lo: null as number | null, hi: null as number | null, C: 0 };
  const q = st.C > 1 ? tQuantile(p, st.C - 1) : Number.NaN;
  const w = q * st.se;
  return Number.isFinite(w) ? { m: st.m, lo: st.m - w, hi: st.m + w, C: st.C } : { m: st.m, lo: null, hi: null, C: st.C };
};
// the lower of the low ends by week and by four weeks, the higher of the high ends
export const lowEnd = (a: Clustered, p = 0.975): number | null => {
  const los = (["weeks", "blocks"] as const).map((by) => intervalOf(a, by, p).lo);
  return los.some((x) => x === null) ? null : Math.min(...(los as number[]));
};
export const highEnd = (a: Clustered, p = 0.975): number | null => {
  const his = (["weeks", "blocks"] as const).map((by) => intervalOf(a, by, p).hi);
  return his.some((x) => x === null) ? null : Math.max(...(his as number[]));
};

// ---- the order statistics (as stop2n.ts) ----------------------------------------------

export const medianOf = (xs: ArrayLike<number>): number | null => {
  if (!xs.length) return null;
  const s = Array.from(xs).sort((x, y) => x - y);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
// the q point: the sorted value at floor(q × (n − 1))
export const quantile = (xs: ArrayLike<number>, q: number): number | null => {
  if (!xs.length) return null;
  const s = Array.from(xs).sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))];
};
