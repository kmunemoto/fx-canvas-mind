// #188: the weeks rearranged (docs §8.99 区間・幅 「口座の数字の幅」), part 3 of
// research/money.ts with research/money-extras.ts: one run's path cut into its
// weeks and laid down again in another order, as a new clock and new legs the
// account (research/money-account.ts runAccount) runs on as it runs on the
// path itself. Research only: nothing in the app reads this.
//
// THE RULES (§8.99, fixed before any data):
//   * the weeks start Sunday 21:00 UTC; the original length is from the first
//     entry's week to the last exit's week (L weeks);
//   * a week placed at position j brings the trades that entered in it (by
//     their close T), each with its own 5-minute path, its times moved by the
//     difference d between where it is placed and where it was;
//   * a trade still open at its week's end goes on along its own path to its
//     own exit (the next placed week's prices are never used for it);
//   * the account's clock — the 5-minute closes, Rakuten's NY closes and the
//     calls' deadlines — is the placed week's own (its times moved by d); a
//     trade carried in from another week is valued at the time the clock
//     shows less its own d (its own pair's last bar at or before then, as
//     everywhere else);
//   * each position's margin at its own mid (and USD/JPY) at its own time,
//     per pair the larger of the buys' and the sells' (MAX), as on the path;
//   * the sizing, the caps, the margin, the calls, the loss-cut and E* again
//     on each new path (runAccount), not the weeks' P/L moved about.
// WHERE §8.99 LEAVES A CHOICE (each told in the report):
//   * a week is the closes g of G with g − 5 minutes in it (a bar counted by
//     its open, as summarize's worst week); a NY close by weekOf(τ); a trade
//     by weekOf(T);
//   * the trades of the week placed last may run past its end: the clock then
//     goes on with that week's own following closes (moved by its d), until
//     the last of them is out (the same for any trade whose exit falls after
//     the last close); no email comes in there;
//   * mulberry32 seeded 188 (interface.md §2), drawn once for every cell: the
//     1,000 one-week rearrangements first (L draws each), then the 1,000
//     four-week ones (a block's start each, circular, cut to L weeks).

import { WEEK, WEEK_OFFSET } from "./lib.ts";
import { FINE, lowerBound, upperBound } from "./money-data.ts";
import { weekOf } from "./money-stats.ts";
import type { Leg, Order, Tape } from "./money-account.ts";

export const weekStart = (w: number) => w * WEEK + WEEK_OFFSET;

// mulberry32 (the generator the walks use, money-data.ts synthetic5): a seeded
// uniform number in [0, 1), the same sequence on every machine
export const mulberry32 = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// ---- the run cut into its weeks ------------------------------------------------------------

export interface Weeks {
  // the first week (weekOf) and their number, L
  first: number;
  L: number;
  // week i's closes on the tape's clock: indices [from[i], to[i])
  from: Int32Array;
  to: Int32Array;
  // the emails that came in in week i, in the run's order
  orders: Order[][];
  // the NY closes of week i (the tape's, τ in it)
  ny: Array<Tape["ny"]>;
}

// the weeks from the first entry's to the last exit's (one leg an order: the
// cells §8.99 rearranges take each email whole at TP1)
export const weeksOf = (tape: Tape, orders: Order[]): Weeks => {
  const G = tape.g;
  if (!orders.length) throw new Error("no emails to rearrange");
  if (orders.some((o) => o.legs.length !== 1 || o.legs[0].exit === "passed")) throw new Error("the weeks are rearranged for one leg an email, every one in");
  const first = weekOf(orders[0].T);
  const lastX = orders.reduce((a, o) => Math.max(a, G[o.legs[0].giX]), -Infinity);
  const L = weekOf(lastX - FINE) - first + 1;
  const from = new Int32Array(L);
  const to = new Int32Array(L);
  for (let i = 0; i < L; i++) {
    from[i] = upperBound(G, weekStart(first + i));
    to[i] = upperBound(G, weekStart(first + i + 1));
  }
  const byWeek: Order[][] = Array.from({ length: L }, () => []);
  for (const o of orders) byWeek[weekOf(o.T) - first].push(o);
  const ny: Array<Tape["ny"]> = Array.from({ length: L }, () => []);
  for (const c of tape.ny) {
    const i = weekOf(c.tau) - first;
    if (i >= 0 && i < L) ny[i].push(c);
  }
  return { first, L, from, to, orders: byWeek, ny };
};

// ---- one rearrangement ---------------------------------------------------------------------

// the weeks laid down in `placement` (placement[j]: the week, 0..L−1, put at
// position j), the clock starting `shiftWeeks` weeks after the first week's
// own start (0 for the rearrangements; the check of the moved clock uses 1):
// the new tape and its emails, each carrying its week's move d
export const placedTape = (base: Tape, wk: Weeks, placement: ArrayLike<number>, shiftWeeks = 0): { tape: Tape; orders: Order[] } => {
  const Gb = base.g;
  const J = placement.length;
  const d = new Float64Array(J);
  for (let j = 0; j < J; j++) d[j] = (shiftWeeks + j - placement[j]) * WEEK;

  // the clock: the placed weeks' closes, moved; then, where some trade is out
  // only after the last of them, the last week's own following closes
  let needX = -Infinity;
  for (let j = 0; j < J; j++) for (const o of wk.orders[placement[j]]) needX = Math.max(needX, Gb[o.legs[0].giX] + d[j]);
  let n = 0;
  for (let j = 0; j < J; j++) n += wk.to[placement[j]] - wk.from[placement[j]];
  const last = placement[J - 1];
  const dl = d[J - 1];
  // the clock's last close so far (the last placed week with any)
  let lastG = -Infinity;
  for (let j = J - 1; j >= 0 && lastG === -Infinity; j--) if (wk.to[placement[j]] > wk.from[placement[j]]) lastG = Gb[wk.to[placement[j]] - 1] + d[j];
  const tailFrom = wk.to[last];
  const tailTo = needX > lastG ? Math.min(Gb.length, lowerBound(Gb, needX - dl) + 1) : tailFrom;
  n += tailTo - tailFrom;
  const g = new Float64Array(n);
  const src = new Int32Array(n);
  let k = 0;
  for (let j = 0; j <= J; j++) {
    const a = j < J ? wk.from[placement[j]] : tailFrom;
    const b = j < J ? wk.to[placement[j]] : tailTo;
    const dj = j < J ? d[j] : dl;
    for (let i = a; i < b; i++) {
      g[k] = Gb[i] + dj;
      src[k++] = i;
    }
  }
  const own = base.own.map((o) => {
    const x = new Uint8Array(n);
    for (let i = 0; i < n; i++) x[i] = o[src[i]];
    return x;
  });
  const usdMid = base.usdMid ? Float64Array.from(src, (i) => base.usdMid![i]) : null;

  // the NY closes: each placed week's own, moved, judged on the new clock
  // (g == τ, or the last close before it); the tail's from the base's
  const ny: Tape["ny"] = [];
  const nyAt = (c: Tape["ny"][number], dj: number) => {
    const tau = c.tau + dj;
    const gi = upperBound(g, tau) - 1;
    if (gi >= 0) ny.push({ tau, gi, exact: g[gi] === tau, deadline: c.deadline + dj });
  };
  for (let j = 0; j < J; j++) for (const c of wk.ny[placement[j]]) nyAt(c, d[j]);
  if (tailTo > tailFrom) for (const c of base.ny) if (c.gi >= tailFrom && c.gi < tailTo) nyAt(c, dl);

  // the emails and their legs, moved
  const orders: Order[] = [];
  const legs: Leg[] = [];
  for (let j = 0; j < J; j++) {
    const w = placement[j];
    for (const o of wk.orders[w]) {
      const L = moveLeg(o.legs[0], d[j], g, Gb, wk.to[w], j);
      legs.push(L);
      orders.push({ id: L.id, sig: o.sig, T: L.T, legs: [L] });
    }
  }
  return { tape: { set: base.set, variant: base.variant, g, pairs: base.pairs, own, usd: base.usd, usdMid, ny, legs }, orders };
};

// a leg moved by dj onto the clock g: its own prices at its own times (the
// clock's less dj). One out before its week's end (`weekEnd`, the index of
// G after its week) keeps its own path as it is.
const moveLeg = (L: Leg, dj: number, g: Float64Array, Gb: Float64Array, weekEnd: number, j: number): Leg => {
  const T = L.T + dj;
  const gi0 = upperBound(g, T);
  const x = Gb[L.giX] + dj;
  const giX = lowerBound(g, x);
  if (giX >= g.length) throw new Error(`${L.id} placed at ${j}: its exit ${new Date(x).toISOString()} is after the clock's end`);
  const hold = giX - gi0 + 1;
  let { mark, worst, mid, conv } = L;
  if (!(L.giX < weekEnd && hold === L.hold && g[giX] === x)) {
    // carried past its week: at each close of the clock, its own last bar at
    // or before (that time − dj); before its first close, as at T; after its
    // exit (an exit not on the clock: out at the next close), its exit bar's
    mark = new Float64Array(hold);
    worst = new Float64Array(hold);
    mid = new Float64Array(hold);
    conv = L.conv ? new Float64Array(hold) : null;
    for (let q = 0; q < hold; q++) {
      const t = g[gi0 + q] - dj;
      const gi = upperBound(Gb, t) - 1;
      if (gi < L.gi0) {
        mark[q] = L.markT;
        worst[q] = L.markT;
        mid[q] = L.midT;
        if (conv) conv[q] = L.convT;
        continue;
      }
      const s = Math.min(gi - L.gi0, L.hold - 1);
      mark[q] = L.mark[s];
      // a bar's worst only where its own bar ends there (else its last close)
      worst[q] = Gb[gi] === t && gi <= L.giX ? L.worst[s] : L.mark[s];
      mid[q] = L.mid[s];
      if (conv) conv[q] = L.conv![s];
    }
  }
  return {
    ...L,
    id: `${L.id}@${j}`,
    T,
    giT: gi0 - 1,
    gi0,
    giX,
    hold,
    entryG: L.entryG + dj,
    mark,
    worst,
    mid,
    conv,
    // a deadline on the new clock: its own pair's first open at or after
    // (that time − dj), told back on the new clock
    openAt: (ms: number) => {
      const o = L.openAt(ms - dj);
      return o ? { at: o.at + dj, px: o.px } : null;
    },
  };
};

// ---- the rearrangements (§8.99: 1-week and 4-week circular blocks) -----------------------------

// `count` rearrangements of each kind from one generator (seed 188), the same
// for every cell: the one-week ones first, then the four-week ones
export const rearrangements = (L: number, count: number, seed = 188): { w1: Int32Array[]; w4: Int32Array[] } => {
  const rnd = mulberry32(seed);
  const w1: Int32Array[] = [];
  const w4: Int32Array[] = [];
  for (let b = 0; b < count; b++) w1.push(Int32Array.from({ length: L }, () => Math.floor(rnd() * L)));
  for (let b = 0; b < count; b++) {
    const p = new Int32Array(L);
    for (let j = 0; j < L; j += 4) {
      const s = Math.floor(rnd() * L);
      for (let q = 0; q < 4 && j + q < L; q++) p[j + q] = (s + q) % L;
    }
    w4.push(p);
  }
  return { w1, w4 };
};
