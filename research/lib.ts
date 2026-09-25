// The arithmetic behind research/tendencies.ts, kept apart from the fetching
// so the vitest suite can check it without a network (src/test/research.test.ts).
//
// Three jobs:
//   1. turn GMO's 15-minute bid/ask bars into the coarser rungs the app
//      trades on, the same way every time;
//   2. say what a plan opened at each closed bar would have done — priced on
//      the side of the book it would really have been filled on, and settled
//      the way track-outcomes settles it;
//   3. count, with intervals that do not pretend overlapping trades are
//      independent, and fit the one model the report uses.
//
// Deno-free on purpose.

import type { Candle } from "../supabase/functions/analyze/indicators.ts";
import type { QuoteCandle } from "../supabase/functions/track-outcomes/quotes.ts";

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
export const WEEK = 7 * DAY;
// The FX day rolls at 21:00 UTC in northern summer and 22:00 in winter; one
// fixed boundary is used so a day is always 24 hours. A day bar therefore
// holds an hour of the previous session half the year, which moves nothing a
// trend word is computed from.
export const DAY_OFFSET = 21 * HOUR;
// 1970-01-04 was a Sunday: weeks start Sunday 21:00 UTC, the week's open.
export const WEEK_OFFSET = 3 * DAY + 21 * HOUR;

export const iso = (ms: number): string => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
const openMs = (q: { datetime: string }): number =>
  Date.parse(q.datetime.includes("T") ? (q.datetime.endsWith("Z") ? q.datetime : `${q.datetime}Z`) : `${q.datetime.replace(" ", "T")}Z`);

// ---- 1. rungs -----------------------------------------------------------------

/**
 * Group bars into periods of `periodMs` whose boundaries sit at `offsetMs`
 * past a multiple of the period. A group is stamped with its boundary, not
 * with its first bar, so "open + period" is always when it closed. Groups
 * that had not closed by `nowMs` are dropped: a forming bar is not a bar.
 */
export const aggregate = (bars: QuoteCandle[], periodMs: number, offsetMs: number, nowMs: number): QuoteCandle[] => {
  const out: QuoteCandle[] = [];
  let key = Number.NaN;
  let cur: QuoteCandle | null = null;
  const merge = (a: Candle, b: Candle): Candle => ({
    datetime: a.datetime,
    open: a.open,
    high: Math.max(a.high, b.high),
    low: Math.min(a.low, b.low),
    close: b.close,
  });
  for (const q of bars) {
    const ms = openMs(q);
    const k = Math.floor((ms - offsetMs) / periodMs);
    if (k !== key) {
      if (cur) out.push(cur);
      key = k;
      const stamp = iso(k * periodMs + offsetMs);
      cur = { datetime: stamp, bid: { ...q.bid, datetime: stamp }, ask: { ...q.ask, datetime: stamp } };
    } else if (cur) {
      cur = { datetime: cur.datetime, bid: merge(cur.bid, q.bid), ask: merge(cur.ask, q.ask) };
    }
  }
  if (cur) out.push(cur);
  return out.filter((q) => openMs(q) + periodMs <= nowMs);
};

// The same reduction as analyze/price-source.ts midCandle.
export const mid = (q: QuoteCandle): Candle => ({
  datetime: q.datetime.slice(0, 19).replace("T", " "),
  open: (q.bid.open + q.ask.open) / 2,
  high: (q.bid.high + q.ask.high) / 2,
  low: (q.bid.low + q.ask.low) / 2,
  close: (q.bid.close + q.ask.close) / 2,
});

// ---- 2. what a plan opened here would have done -------------------------------

export type Side = "BUY" | "SELL";
export type Outcome = "win" | "loss" | "ambiguous" | "expired" | "open";

export interface LabelSpec {
  // Stop distance in ATR of the entry rung
  stopAtr: number;
  // Target distance as a multiple of the stop distance
  rr: number;
  // Bars of the entry rung to wait for a resolution
  horizon: number;
}

export interface Label {
  outcome: Outcome;
  bars: number | null;
}

/**
 * Open at the close of bar `t` at the price the book would have given (BUY
 * on the ask, SELL on the bid), stop `stopAtr` ATR away, target `rr` times
 * that, and walk the bars after it on the side the position would be closed
 * on (BUY on the bid, SELL on the ask) — exactly the sides track-outcomes
 * fills and settles on.
 *
 * A bar that reaches both is split with the finer bars when `sub` is given,
 * the way the tracker refines; still both inside one finer bar is
 * `ambiguous`, never guessed.
 */
export const labelAt = (
  bars: QuoteCandle[],
  t: number,
  atr: number,
  side: Side,
  spec: LabelSpec,
  intervalMs: number,
  sub: { bars: QuoteCandle[]; startOf: number[] } | null = null,
): Label => {
  const d = spec.stopAtr * atr;
  const buy = side === "BUY";
  const entry = buy ? bars[t].ask.close : bars[t].bid.close;
  const stop = buy ? entry - d : entry + d;
  const target = buy ? entry + spec.rr * d : entry - spec.rr * d;
  const hits = (q: QuoteCandle) => {
    const x = buy ? q.bid : q.ask;
    return {
      tp: buy ? x.high >= target : x.low <= target,
      sl: buy ? x.low <= stop : x.high >= stop,
    };
  };
  const last = Math.min(bars.length - 1, t + spec.horizon);
  for (let j = t + 1; j <= last; j++) {
    const h = hits(bars[j]);
    if (!h.tp && !h.sl) continue;
    if (h.tp && !h.sl) return { outcome: "win", bars: j - t };
    if (h.sl && !h.tp) return { outcome: "loss", bars: j - t };
    if (sub) {
      const from = sub.startOf[j];
      const endMs = openMs(bars[j]) + intervalMs;
      for (let k = from; k >= 0 && k < sub.bars.length && openMs(sub.bars[k]) < endMs; k++) {
        const s = hits(sub.bars[k]);
        if (s.tp && !s.sl) return { outcome: "win", bars: j - t };
        if (s.sl && !s.tp) return { outcome: "loss", bars: j - t };
        if (s.tp && s.sl) return { outcome: "ambiguous", bars: j - t };
      }
    }
    return { outcome: "ambiguous", bars: j - t };
  }
  return { outcome: t + spec.horizon <= bars.length - 1 ? "expired" : "open", bars: null };
};

// Where each coarse bar's finer bars begin, for labelAt's `sub`.
export const subStarts = (coarse: QuoteCandle[], fine: QuoteCandle[]): number[] => {
  const out: number[] = [];
  let k = 0;
  for (const c of coarse) {
    const ms = openMs(c);
    while (k < fine.length && openMs(fine[k]) < ms) k++;
    out.push(k < fine.length ? k : -1);
  }
  return out;
};

// ---- 3. counting --------------------------------------------------------------

export const wilson = (wins: number, n: number, z = 1.96): { lo: number; hi: number } | null => {
  if (n <= 0) return null;
  const p = wins / n;
  const d = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { lo: Math.max(0, (centre - margin) / d), hi: Math.min(1, (centre + margin) / d) };
};

/**
 * A win rate whose standard error respects that trades opened on the same
 * day (or week) are not independent: consecutive bars share most of their
 * future, so treating 96 fifteen-minute entries of one day as 96 draws would
 * make every interval about ten times too narrow.
 *
 * Cluster-robust (sandwich) variance of a ratio of sums, with the usual
 * C/(C-1) small-sample factor.
 */
export const clusterRate = (
  items: Array<{ cluster: string | number; win: boolean }>,
): { n: number; wins: number; p: number; se: number; clusters: number } | null => {
  if (items.length === 0) return null;
  const by = new Map<string | number, { n: number; w: number }>();
  let wins = 0;
  for (const it of items) {
    const c = by.get(it.cluster) ?? { n: 0, w: 0 };
    c.n++;
    if (it.win) {
      c.w++;
      wins++;
    }
    by.set(it.cluster, c);
  }
  const n = items.length;
  const p = wins / n;
  const C = by.size;
  if (C < 2) return { n, wins, p, se: Number.NaN, clusters: C };
  let s = 0;
  for (const c of by.values()) s += (c.w - p * c.n) ** 2;
  const se = Math.sqrt((C / (C - 1)) * s) / n;
  return { n, wins, p, se, clusters: C };
};

// Two-sided p-value of a z statistic
export const pTwo = (z: number): number => 2 * (1 - normCdf(Math.abs(z)));
export const pOne = (z: number): number => 1 - normCdf(z);

// Abramowitz–Stegun 7.1.26 via erf; ample for p-values in a report.
export const normCdf = (x: number): number => {
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t *
    Math.exp(-(x * x) / 2);
  return x >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
};

// Holm's step-down adjustment: the adjusted p-value of each input, same order.
export const holm = (ps: number[]): number[] => {
  const order = ps.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);
  const out = new Array<number>(ps.length).fill(1);
  let running = 0;
  order.forEach(({ p, i }, rank) => {
    running = Math.max(running, Math.min(1, (ps.length - rank) * p));
    out[i] = running;
  });
  return out;
};

// ---- the model ------------------------------------------------------------------
// L2-regularised logistic regression on one-hot features, fitted by Newton's
// method. Rows are lists of active column indices (a feature that is missing
// simply activates nothing). Small enough — a few dozen columns — that the
// dense Hessian is cheap and the fit is exact, not a learning-rate guess.

export const fitLogistic = (
  rows: number[][],
  y: number[],
  columns: number,
  lambda = 1,
  iterations = 12,
): number[] => {
  // w[0] is the intercept; column c is w[c + 1]
  const k = columns + 1;
  const w = new Array<number>(k).fill(0);
  for (let it = 0; it < iterations; it++) {
    const g = new Array<number>(k).fill(0);
    const H: number[][] = Array.from({ length: k }, () => new Array<number>(k).fill(0));
    for (let r = 0; r < rows.length; r++) {
      const idx = [0, ...rows[r].map((c) => c + 1)];
      let z = 0;
      for (const j of idx) z += w[j];
      const p = 1 / (1 + Math.exp(-z));
      const e = p - y[r];
      const v = p * (1 - p);
      for (const a of idx) {
        g[a] += e;
        for (const b of idx) H[a][b] += v;
      }
    }
    for (let j = 1; j < k; j++) {
      g[j] += lambda * w[j];
      H[j][j] += lambda;
    }
    H[0][0] += 1e-9;
    const step = solve(H, g);
    if (step === null) break;
    let moved = 0;
    for (let j = 0; j < k; j++) {
      w[j] -= step[j];
      moved = Math.max(moved, Math.abs(step[j]));
    }
    if (moved < 1e-7) break;
  }
  return w;
};

export const predict = (w: number[], row: number[]): number => {
  let z = w[0];
  for (const c of row) z += w[c + 1];
  return 1 / (1 + Math.exp(-z));
};

// Gaussian elimination with partial pivoting; null when singular.
export const solve = (A: number[][], b: number[]): number[] | null => {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-12) return null;
    [M[col], M[piv]] = [M[piv], M[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col] / M[col][col];
      if (f === 0) continue;
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
};

// Area under the ROC curve by ranks (ties averaged).
export const auc = (scores: number[], y: number[]): number | null => {
  const pos = y.filter((v) => v === 1).length;
  const neg = y.length - pos;
  if (pos === 0 || neg === 0) return null;
  const order = scores.map((s, i) => ({ s, i })).sort((a, b) => a.s - b.s);
  const rank = new Array<number>(scores.length);
  for (let i = 0; i < order.length;) {
    let j = i;
    while (j + 1 < order.length && order[j + 1].s === order[i].s) j++;
    const r = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) rank[order[k].i] = r;
    i = j + 1;
  }
  let sum = 0;
  for (let i = 0; i < y.length; i++) if (y[i] === 1) sum += rank[i];
  return (sum - (pos * (pos + 1)) / 2) / (pos * neg);
};
