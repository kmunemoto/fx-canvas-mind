// The arithmetic behind research/strength.ts (#174): the currency-strength
// meter, its signals, the yardstick and the pick and call. Kept apart from the
// downloading so the vitest suite can check it (src/test/strength.test.ts).
// Deno-free on purpose. The measure itself is fixed in research/strength.ts's
// header; nothing here chooses anything.

// ---- the currencies and the pairs --------------------------------------------------

// the order ties go by (research/strength.ts: JPY, USD, EUR, GBP, AUD, NZD,
// CAD, CHF)
export const CURRENCIES = ["JPY", "USD", "EUR", "GBP", "AUD", "NZD", "CAD", "CHF"] as const;
export const NC = CURRENCIES.length;
// the seven yen crosses the meter is worked from: CROSSES[c − 1] is
// CURRENCIES[c] against the yen
export const CROSSES = CURRENCIES.slice(1).map((c) => `${c}/JPY`);
// A+B, the pairs traded (research/widetp.ts's eleven)
export const TRADED = ["USD/JPY", "EUR/JPY", "GBP/JPY", "AUD/JPY", "NZD/JPY", "CAD/JPY", "CHF/JPY", "EUR/USD", "GBP/USD", "AUD/USD", "NZD/USD"];
// a pair's base and quote, as indices into CURRENCIES
export const legsOf = (pair: string): [number, number] => {
  const [a, b] = pair.split("/");
  const ia = CURRENCIES.indexOf(a as (typeof CURRENCIES)[number]);
  const ib = CURRENCIES.indexOf(b as (typeof CURRENCIES)[number]);
  if (ia < 0 || ib < 0 || ia === ib) throw new Error(`${pair} is not a pair of the eight`);
  return [ia, ib];
};

// ---- the grid ----------------------------------------------------------------------

// the open times every series has, joined by time (each sorted, ascending)
export const gridOf = (series: ArrayLike<number>[]): number[] => {
  if (!series.length) return [];
  const count = new Map<number, number>();
  for (const s of series) {
    let last = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < s.length; i++) {
      const t = s[i];
      if (!(t > last)) throw new Error("a series' times are not strictly ascending");
      last = t;
      count.set(t, (count.get(t) ?? 0) + 1);
    }
  }
  const out: number[] = [];
  for (const [t, n] of count) if (n === series.length) out.push(t);
  return out.sort((x, y) => x - y);
};

// ---- the meter ---------------------------------------------------------------------

// v[c][k]: the log of CURRENCIES[c]'s yen value at G bar k (v[0], the yen, 0)
export type Values = Float64Array[];

// the eight strengths at k over L bars into `out` (r_c less the eight's mean);
// false where k − L is before the first bar
export const strengthAt = (v: Values, k: number, L: number, out: Float64Array): boolean => {
  if (k - L < 0 || k >= v[0].length) return false;
  let mean = 0;
  for (let c = 0; c < NC; c++) {
    const r = v[c][k] - v[c][k - L];
    out[c] = r;
    mean += r;
  }
  mean /= NC;
  for (let c = 0; c < NC; c++) out[c] -= mean;
  return true;
};

// ranks 1 (the strongest) to 8; an exact tie goes to the earlier currency
export const ranksOf = (s: ArrayLike<number>, out = new Int8Array(NC)): Int8Array => {
  for (let c = 0; c < NC; c++) {
    let r = 1;
    for (let d = 0; d < NC; d++) {
      if (d === c) continue;
      if (s[d] > s[c] || (s[d] === s[c] && d < c)) r++;
    }
    out[c] = r;
  }
  return out;
};
// exact ties among the eight at one close (told: none expected)
export const tiesOf = (s: ArrayLike<number>): number => {
  let n = 0;
  for (let c = 0; c < NC; c++) for (let d = c + 1; d < NC; d++) if (s[c] === s[d]) n++;
  return n;
};

// every G bar's ranks over L bars, [k * NC + c]; 0 where not known
export const ranksFor = (v: Values, L: number): Int8Array => {
  const nG = v[0].length;
  const out = new Int8Array(nG * NC);
  const s = new Float64Array(NC);
  const r = new Int8Array(NC);
  for (let k = L; k < nG; k++) {
    strengthAt(v, k, L, s);
    ranksOf(s, r);
    out.set(r, k * NC);
  }
  return out;
};

// a pair's state from the ranks at one bar: +1 when its base is among the
// top `top` and its quote among the bottom `top`, −1 the mirror, else 0;
// null where the ranks are not known
export const rankState = (ranks: Int8Array, k: number, a: number, b: number, top: number): -1 | 0 | 1 | null => {
  if (k < 0) return null;
  const ra = ranks[k * NC + a];
  const rb = ranks[k * NC + b];
  if (ra === 0 || rb === 0) return null;
  const low = NC + 1 - top;
  if (ra <= top && rb >= low) return 1;
  if (ra >= low && rb <= top) return -1;
  return 0;
};

// M: the sign of s_A − s_B over L bars (the pair's own momentum as the
// meter sees it); null where not known
export const momentumState = (v: Values, k: number, L: number, a: number, b: number): -1 | 0 | 1 | null => {
  if (k - L < 0) return null;
  const d = v[a][k] - v[a][k - L] - (v[b][k] - v[b][k - L]);
  return d > 0 ? 1 : d < 0 ? -1 : 0;
};

// ---- the signals -------------------------------------------------------------------

export type StateFn = (p: number, k: number) => -1 | 0 | 1 | null;
export interface Fire {
  p: number;
  k: number;
  side: 1 | -1;
}
// once on entering: at k the state is not 0 and differs from the state at
// k − 1 (both known), and a fire may be taken there (`ok`: in the period,
// mailed, the pair's own bar)
export const firesOf = (state: StateFn, nPairs: number, nG: number, ok: (p: number, k: number) => boolean): Fire[] => {
  const out: Fire[] = [];
  for (let p = 0; p < nPairs; p++) {
    let prev = state(p, 0);
    for (let k = 1; k < nG; k++) {
      const now = state(p, k);
      if (now !== null && prev !== null && now !== 0 && now !== prev && ok(p, k)) out.push({ p, k, side: now });
      prev = now;
    }
  }
  return out;
};

// ---- the coin and the yardstick -----------------------------------------------------

// the coin at each pair's G bars, [p * nG + k]
export interface Table {
  nG: number;
  nPairs: number;
  // a fire may be taken here: in the period, mailed, the pair's own bar
  ok: Uint8Array;
  // the trades' pips; NaN where there is no trade (its 30 bars not in the data)
  buy: Float64Array;
  sell: Float64Array;
  // the first half's trades whose 30 bars end before SPLIT (the pick's)
  pickable: Uint8Array;
  // by bar: the half (0, 1; −1 outside the period) and the week
  half: Int8Array;
  week: Int32Array;
}
export const newTable = (nG: number, nPairs: number): Table => ({
  nG,
  nPairs,
  ok: new Uint8Array(nG * nPairs),
  buy: new Float64Array(nG * nPairs).fill(Number.NaN),
  sell: new Float64Array(nG * nPairs).fill(Number.NaN),
  pickable: new Uint8Array(nG * nPairs),
  half: new Int8Array(nG).fill(-1),
  week: new Int32Array(nG),
});
// e: the trade's pips less the mean of the coin's two at the same close
export const edgeOf = (buy: number, sell: number, side: 1 | -1): number => (side === 1 ? buy - sell : sell - buy) / 2;

// ---- the numbers kept: sums by week and by four weeks ------------------------------

export interface Agg {
  n: number;
  sum: number;
  weeks: Map<number, { n: number; s: number }>;
  blocks: Map<number, { n: number; s: number }>;
}
export const newAgg = (): Agg => ({ n: 0, sum: 0, weeks: new Map(), blocks: new Map() });
export const addTo = (a: Agg, week: number, x: number) => {
  a.n++;
  a.sum += x;
  for (const [m, key] of [[a.weeks, week], [a.blocks, Math.floor(week / 4)]] as const) {
    const w = m.get(key) ?? { n: 0, s: 0 };
    w.n++;
    w.s += x;
    m.set(key, w);
  }
};
export const mergeAggs = (xs: Array<Agg | undefined>): Agg => {
  const a = newAgg();
  for (const y of xs) {
    if (!y) continue;
    a.n += y.n;
    a.sum += y.sum;
    for (const by of ["weeks", "blocks"] as const) {
      for (const [key, g] of y[by]) {
        const w = a[by].get(key) ?? { n: 0, s: 0 };
        w.n += g.n;
        w.s += g.s;
        a[by].set(key, w);
      }
    }
  }
  return a;
};
export type By = "weeks" | "blocks";
// the mean and its standard error from the cluster sums (C / (C − 1), as
// research/widetp.ts statOf)
export const statOf = (a: Agg | undefined, by: By) => {
  if (!a || a.n === 0) return null;
  const m = a.sum / a.n;
  const C = a[by].size;
  let s = 0;
  for (const g of a[by].values()) s += (g.s - m * g.n) ** 2;
  const se = C > 1 ? Math.sqrt((C / (C - 1)) * s) / a.n : Number.NaN;
  return { m, se, C };
};
// the difference of two means with one standard error from both's cluster
// sums together (the same weeks shared): u_w = (S_Xw − m_X n_Xw) / N_X −
// (S_Yw − m_Y n_Yw) / N_Y
export const diffStatOf = (x: Agg | undefined, y: Agg | undefined, by: By) => {
  if (!x || !y || x.n === 0 || y.n === 0) return null;
  const mx = x.sum / x.n;
  const my = y.sum / y.n;
  const keys = new Set([...x[by].keys(), ...y[by].keys()]);
  let s = 0;
  for (const k of keys) {
    const gx = x[by].get(k);
    const gy = y[by].get(k);
    const u = (gx ? (gx.s - mx * gx.n) / x.n : 0) - (gy ? (gy.s - my * gy.n) / y.n : 0);
    s += u * u;
  }
  const C = keys.size;
  const se = C > 1 ? Math.sqrt((C / (C - 1)) * s) : Number.NaN;
  return { m: mx - my, se, C };
};

// ---- Student's t (as research/widetp.ts) ---------------------------------------------

const LANCZOS = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
const lgamma = (x: number): number => {
  if (x < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - lgamma(1 - x);
  const z = x - 1;
  let a = LANCZOS[0];
  const t = z + 7.5;
  for (let i = 1; i < 9; i++) a += LANCZOS[i] / (z + i);
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
};
const betacf = (a: number, b: number, x: number): number => {
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < 1e-300) d = 1e-300;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < 1e-300) d = 1e-300;
    c = 1 + aa / c;
    if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < 1e-300) d = 1e-300;
    c = 1 + aa / c;
    if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 3e-14) break;
  }
  return h;
};
const ibeta = (a: number, b: number, x: number): number => {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (bt * betacf(a, b, x)) / a : 1 - (bt * betacf(b, a, 1 - x)) / b;
};
export const tCdf = (t: number, df: number): number => {
  const x = df / (df + t * t);
  return t >= 0 ? 1 - 0.5 * ibeta(df / 2, 0.5, x) : 0.5 * ibeta(df / 2, 0.5, x);
};
const tqCache = new Map<string, number>();
export const tQuantile = (p: number, df: number): number => {
  const key = `${p}|${df}`;
  const hit = tqCache.get(key);
  if (hit !== undefined) return hit;
  let lo = 0;
  let hi = 1000;
  for (let k = 0; k < 200; k++) {
    const mid = (lo + hi) / 2;
    if (tCdf(mid, df) < p) lo = mid;
    else hi = mid;
  }
  const q = (lo + hi) / 2;
  tqCache.set(key, q);
  return q;
};

// ---- the pick and the call -----------------------------------------------------------

export const ONE_SIDE = 0.025;
// the low end: the lower of by week and by four weeks, each the mean less
// t(C − 1) × its standard error at one side `alpha`; null when either has
// fewer than two clusters
export const lowEndOf = (a: Agg | undefined, alpha = ONE_SIDE): number | null => {
  let low: number | null = null;
  for (const by of ["weeks", "blocks"] as const) {
    const st = statOf(a, by);
    if (!st || !(st.C > 1) || !Number.isFinite(st.se)) return null;
    const lo = st.m - tQuantile(1 - alpha, st.C - 1) * st.se;
    low = low === null ? lo : Math.min(low, lo);
  }
  return low;
};
// t for the pick: the mean over the larger of the two standard errors
export const tOf = (a: Agg | undefined): number | null => {
  const w = statOf(a, "weeks");
  const b = statOf(a, "blocks");
  if (!w || !b || !Number.isFinite(w.se) || !Number.isFinite(b.se)) return null;
  const se = Math.max(w.se, b.se);
  return se > 0 ? w.m / se : null;
};
// the lowest number of weeks holding the pick's second-half trades for a
// call (research/strength.ts: "cannot say" below it)
export const MIN_WEEKS = 30;
export interface Verdict {
  pick: number | null;
  t: Array<number | null>;
  called: boolean;
  low: number | null;
  weeks: number;
  // each candidate's second-half low end at one side 2.5% / K, and whether
  // it is above 0
  bonfLow: Array<number | null>;
  bonf: boolean[];
}
// `first[c]`: candidate c's pickable first-half e; `second[c]`: its
// second-half e. The pick: the highest t (ties: the earlier); the call: its
// second-half mean and low end above 0, in 30 weeks or more
export const verdictOf = (first: Agg[], second: Agg[]): Verdict => {
  const K = first.length;
  const t = first.map((a) => tOf(a));
  let pick: number | null = null;
  for (let c = 0; c < K; c++) {
    const tc = t[c];
    if (tc === null) continue;
    if (pick === null || tc > (t[pick] as number)) pick = c;
  }
  const bonfLow = second.map((a) => lowEndOf(a, ONE_SIDE / K));
  const bonf = second.map((a, c) => a.n > 0 && a.sum / a.n > 0 && (bonfLow[c] ?? -1) > 0);
  if (pick === null) return { pick, t, called: false, low: null, weeks: 0, bonfLow, bonf };
  const s = second[pick];
  const low = lowEndOf(s);
  const weeks = s.weeks.size;
  const called = s.n > 0 && s.sum / s.n > 0 && low !== null && low > 0 && weeks >= MIN_WEEKS;
  return { pick, t, called, low, weeks, bonfLow, bonf };
};

// the trades of a set of fires on the coin: e by half, the first half's
// only where pickable
export const edgesOf = (fires: Fire[], table: Table): { first: Agg; second: Agg; all: Agg; n: number } => {
  const first = newAgg();
  const second = newAgg();
  const all = newAgg();
  let n = 0;
  for (const f of fires) {
    const at = f.p * table.nG + f.k;
    const b = table.buy[at];
    const s = table.sell[at];
    if (Number.isNaN(b) || Number.isNaN(s)) continue;
    const e = edgeOf(b, s, f.side);
    const h = table.half[f.k];
    const w = table.week[f.k];
    n++;
    addTo(all, w, e);
    if (h === 1) addTo(second, w, e);
    else if (h === 0 && table.pickable[at]) addTo(first, w, e);
  }
  return { first, second, all, n };
};

// ---- the placebos ---------------------------------------------------------------------

// mulberry32, as the walks here
export const rng = (seed: number) => {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};
// a made-up meter: the eight currencies' values independent Gaussian walks,
// a step a G bar (the yen's too: a placebo holds nothing fixed)
export const placeboValues = (seed: number, nG: number): Values => {
  const r = rng(Math.imul(seed, 2654435761) ^ 0x5bd1e995);
  const gauss = () => {
    let u = 0;
    while (u === 0) u = r();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
  };
  const v: Values = Array.from({ length: NC }, () => new Float64Array(nG));
  for (let c = 0; c < NC; c++) for (let k = 1; k < nG; k++) v[c][k] = v[c][k - 1] + gauss();
  return v;
};

// the rank rule's fires on the traded pairs, from the ranks at each bar
// (`lag`: the ranks of that many bars before, the stale meter)
export const rankFires = (ranks: Int8Array, pairs: Array<[number, number]>, table: Table, top: number, lag = 0): Fire[] =>
  firesOf((p, k) => rankState(ranks, k - lag, pairs[p][0], pairs[p][1], top), pairs.length, table.nG, (p, k) => table.ok[p * table.nG + k] === 1);

// the whole pick and call on a meter: the candidates' L's, top two
export const verdictOn = (v: Values, Ls: number[], pairs: Array<[number, number]>, table: Table, top = 2): Verdict => {
  const first: Agg[] = [];
  const second: Agg[] = [];
  for (const L of Ls) {
    const x = edgesOf(rankFires(ranksFor(v, L), pairs, table, top), table);
    first.push(x.first);
    second.push(x.second);
  }
  return verdictOf(first, second);
};

// ---- the rank IC ------------------------------------------------------------------------

// Spearman's correlation across the eight (no ties among them: ranksOf
// breaks any)
export const spearman = (x: ArrayLike<number>, y: ArrayLike<number>): number => {
  const rx = ranksOf(x);
  const ry = ranksOf(y);
  let d2 = 0;
  for (let c = 0; c < NC; c++) d2 += (rx[c] - ry[c]) ** 2;
  return 1 - (6 * d2) / (NC * (NC * NC - 1));
};
