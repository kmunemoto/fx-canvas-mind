// #205 (docs §8.102): the numbers ownerhold.ts reports — the per-email view's
// win rate and pips, ③'s main number (each pair's buys and sells weighted
// equally) and its interval, the accounts' lines, and the counts beside them.

import { MINUTE, WEEK } from "./lib.ts";
import { clustered, intervalOf, lowEnd, medianOf, quantile, weekOf } from "./money-stats.ts";
import { type M1, PAIRS, isUsdPair } from "./ownerhold-data.ts";
import type { AccountOut, Fate, TradeRec } from "./ownerhold-account.ts";
import { type Book, type Path, lastEnded, pipsOf } from "./ownerhold-trades.ts";

export const DAY_MS = 24 * 60 * MINUTE;

// USD/JPY's mid at a time (the price rule: the last bar ended by then)
export const usdJpyAt = (u: M1, ms: number): number => {
  const j = lastEnded(u, ms);
  return j < 0 ? NaN : (u.bc[j] + u.ac[j]) / 2;
};

// ---- ③ ---------------------------------------------------------------------------------------

export interface DRow {
  pi: number;
  dir: 1 | -1;
  T: number;
  d: number;
}

export interface Third {
  n: number;
  // the main number (pips), its interval's low ends by weeks and by 4 weeks, and L (the lower)
  main: number | null;
  loWeeks: number | null;
  loBlocks: number | null;
  L: number | null;
  // every email weighted alike
  plain: number | null;
  plainL: number | null;
  // the ten cells' sizes (pair × side) and means
  cells: Array<{ pair: string; side: string; n: number; mean: number | null }>;
}

const cellOf = (r: { pi: number; dir: number }) => r.pi * 2 + (r.dir === 1 ? 0 : 1);

// §8.102 ③: each d weighted by N ÷ (10 × its pair-and-side's count), the mean of
// those (= each pair's buy mean and sell mean, then the five pairs, all alike),
// its t(C−1) 95% interval clustered by T's week and by 4 weeks, L the lower low end.
// `how`: "main"; the planted "weekCells" (each week × pair × side a cell weighted
// alike) and "plain" (every email alike) answer the same way for 確かめ A.
export const thirdOf = (rows: DRow[], how: "main" | "weekCells" | "plain" = "main"): Third => {
  const N = rows.length;
  const count = new Float64Array(10);
  const sum = new Float64Array(10);
  for (const r of rows) {
    count[cellOf(r)]++;
    sum[cellOf(r)] += r.d;
  }
  const cells = Array.from({ length: 10 }, (_, c) => ({ pair: PAIRS[c >> 1], side: c % 2 === 0 ? "BUY" : "SELL", n: count[c], mean: count[c] ? sum[c] / count[c] : null }));
  const plainAgg = clustered(rows.map((r) => ({ x: r.d, week: weekOf(r.T) })));
  const plain = N ? plainAgg.sum / N : null;
  const plainL = N ? lowEnd(plainAgg) : null;
  const empty: Third = { n: N, main: null, loWeeks: null, loBlocks: null, L: null, plain, plainL, cells };
  if (!N) return empty;
  let xs: Array<{ x: number; week: number }>;
  if (how === "plain") xs = rows.map((r) => ({ x: r.d, week: weekOf(r.T) }));
  else if (how === "main") {
    if (Array.from(count).some((c) => c === 0)) return empty;
    xs = rows.map((r) => ({ x: (N / (10 * count[cellOf(r)])) * r.d, week: weekOf(r.T) }));
  } else {
    const cc = new Map<string, number>();
    for (const r of rows) {
      const k = `${weekOf(r.T)}:${cellOf(r)}`;
      cc.set(k, (cc.get(k) ?? 0) + 1);
    }
    const C = cc.size;
    xs = rows.map((r) => ({ x: (N / (C * cc.get(`${weekOf(r.T)}:${cellOf(r)}`)!)) * r.d, week: weekOf(r.T) }));
  }
  const agg = clustered(xs);
  const w = intervalOf(agg, "weeks").lo;
  const b = intervalOf(agg, "blocks").lo;
  return { ...empty, main: agg.sum / agg.n, loWeeks: w, loBlocks: b, L: lowEnd(agg) };
};

// ---- the per-email view ------------------------------------------------------------------------

export interface PerEmail {
  emails: number;
  none: number;
  market: number;
  limitFilled: number;
  unfilled: number;
  filled: number;
  tp: number;
  held: number;
  winRate: number | null;
  pips: number | null;
  yen: number | null;
  shifted: number;
  noBar: number;
  tpInFill: number;
  fillGaps: { n: number; pips: number; byKind: Record<string, { n: number; pips: number }> };
  tpGaps: { n: number; pips: number; byKind: Record<string, { n: number; pips: number }> };
  // the TPs within 1 day, 1 week, 4 weeks of P (of the emails whose P + h is by END), and by END
  tpWithin: Record<string, { of: number; tp: number; share: number | null }>;
  mae: { tp: Q; notTp: Q };
}
interface Q {
  n: number;
  median: number | null;
  p90: number | null;
  p99: number | null;
  max: number | null;
}
const qOf = (xs: number[]): Q => {
  const s = Float64Array.from(xs).sort();
  return { n: s.length, median: medianOf(s), p90: quantile(s, 0.9), p99: quantile(s, 0.99), max: s.length ? s[s.length - 1] : null };
};

// what came before a bar: the week's first, after Rakuten's stop, after a gap, or an ordinary minute
export const gapKind = (bk: Book, k: number): string => {
  const m = bk.m;
  if (k <= 0) return "weekStart";
  const prev = m.t[k - 1];
  if (m.t[k] - prev > 6 * 60 * MINUTE) return "weekStart";
  if (bk.maint[k - 1] === 1 || (m.t[k] - prev > MINUTE && bk.taus.some((tau) => tau >= prev && tau < m.t[k]))) return "afterStop";
  if (m.t[k] - prev > MINUTE) return "afterGap";
  return "ordinary";
};

export interface EmailLike {
  pi: number;
  dir: 1 | -1;
  E: number;
  tp: number;
}

export const perEmailOf = (ems: EmailLike[], paths: Path[], books: Book[], usdjpy: M1, endMs: number): PerEmail => {
  const out: PerEmail = { emails: ems.length, none: 0, market: 0, limitFilled: 0, unfilled: 0, filled: 0, tp: 0, held: 0, winRate: null, pips: null, yen: null, shifted: 0, noBar: 0, tpInFill: 0, fillGaps: { n: 0, pips: 0, byKind: {} }, tpGaps: { n: 0, pips: 0, byKind: {} }, tpWithin: {}, mae: { tp: qOf([]), notTp: qOf([]) } };
  let pipSum = 0;
  let yenSum = 0;
  const maeTp: number[] = [];
  const maeNo: number[] = [];
  const within: Record<string, { of: number; tp: number }> = { "1d": { of: 0, tp: 0 }, "1w": { of: 0, tp: 0 }, "4w": { of: 0, tp: 0 }, end: { of: 0, tp: 0 } };
  const hs: Array<[string, number]> = [["1d", DAY_MS], ["1w", WEEK], ["4w", 4 * WEEK]];
  ems.forEach((e, i) => {
    const p = paths[i];
    const bk = books[e.pi];
    if (p.shifted) out.shifted++;
    if (p.noBar) out.noBar++;
    if (p.none) {
      out.none++;
      return;
    }
    for (const [name, h] of hs) {
      if (p.P + h > endMs) continue;
      within[name].of++;
      if (p.tpK >= 0 && p.x + MINUTE <= p.P + h) within[name].tp++;
    }
    within.end.of++;
    if (p.tpK >= 0) within.end.tp++;
    if (p.fillK === -2) {
      out.unfilled++;
      return;
    }
    out.filled++;
    if (p.market) out.market++;
    else out.limitFilled++;
    if (p.tpInFill) out.tpInFill++;
    if (p.fillGap && p.fillK >= 0) {
      const g = (e.dir * (e.E - p.fill)) / bk.unit;
      const kind = gapKind(bk, p.fillK);
      out.fillGaps.n++;
      out.fillGaps.pips += g;
      const b = (out.fillGaps.byKind[kind] ??= { n: 0, pips: 0 });
      b.n++;
      b.pips += g;
    }
    if (p.tpGap) {
      const g = (e.dir * (p.exit - e.tp)) / bk.unit;
      const kind = gapKind(bk, p.tpK);
      out.tpGaps.n++;
      out.tpGaps.pips += g;
      const b = (out.tpGaps.byKind[kind] ??= { n: 0, pips: 0 });
      b.n++;
      b.pips += g;
    }
    const pips = pipsOf(p, e.dir, bk.unit)!;
    pipSum += pips;
    const atMs = p.tpK >= 0 ? p.x + MINUTE : endMs;
    const quote = pips * bk.unit * 10_000;
    yenSum += isUsdPair(PAIRS[e.pi]) ? quote * usdJpyAt(usdjpy, atMs) : quote;
    if (p.tpK >= 0) {
      out.tp++;
      maeTp.push(p.mae);
    } else {
      out.held++;
      maeNo.push(p.mae);
    }
  });
  out.winRate = out.filled ? out.tp / out.filled : null;
  out.pips = out.filled ? pipSum / out.filled : null;
  out.yen = out.filled ? yenSum / out.filled : null;
  for (const [k, v] of Object.entries(within)) out.tpWithin[k] = { ...v, share: v.of ? v.tp / v.of : null };
  out.mae = { tp: qOf(maeTp), notTp: qOf(maeNo) };
  return out;
};

// ---- an account's lines ------------------------------------------------------------------------

export interface AccountLine {
  start: number;
  naEnd: number;
  inEnd: number;
  // A (first half), B (second half), S (whole): net assets' change less what was put in
  A: number;
  B: number;
  S: number;
  lcs: number;
  deadlines: number;
  // calls whose U stayed over 0 after the notice's deposit (the cap stopped it)
  capped: number;
  calls: number;
  callEnds: Record<string, number>;
  deposits: number;
  depositTotal: number;
  depositMax: number;
  reached50: number | null;
  reached100: number | null;
  maxDrawdown: number;
  maxHeld: number;
  maxHeldMargin: number;
  maxPending: number;
  fates: Record<Fate, number>;
  fatesHalves: [Record<string, number>, Record<string, number>];
  winRate: number | null;
  outcomes: Record<string, number>;
  pips: number | null;
  yen: number | null;
}

const pipsOfTrade = (t: TradeRec, unit: number) => (t.dir * (t.exit - t.fill)) / unit;

export const accountLineOf = (a: AccountOut, start: number, Ts: number[], split: number, units: number[]): AccountLine => {
  const A = a.naSplit - a.inSplit;
  const S = a.naEnd - a.inEnd;
  const fates = {} as Record<Fate, number>;
  const halves: [Record<string, number>, Record<string, number>] = [{}, {}];
  a.fates.forEach((f, i) => {
    fates[f] = (fates[f] ?? 0) + 1;
    const h = halves[Ts[i] < split ? 0 : 1];
    h[f] = (h[f] ?? 0) + 1;
  });
  const callEnds: Record<string, number> = {};
  for (const c of a.calls) callEnds[c.end] = (callEnds[c.end] ?? 0) + 1;
  const outcomes: Record<string, number> = {};
  let pips = 0;
  let yen = 0;
  for (const t of a.trades) {
    outcomes[t.how] = (outcomes[t.how] ?? 0) + 1;
    pips += pipsOfTrade(t, units[t.pi]);
    yen += t.yen;
  }
  const n = a.trades.length;
  return {
    start,
    naEnd: a.naEnd,
    inEnd: a.inEnd,
    A,
    B: S - A,
    S,
    lcs: a.lcs.length,
    deadlines: a.calls.filter((c) => c.end === "deadline").length,
    capped: a.calls.filter((c) => c.uAfterDeposit !== null && c.uAfterDeposit > 0).length,
    calls: a.calls.length,
    callEnds,
    deposits: a.deposits.length,
    depositTotal: a.deposits.reduce((s, d) => s + d.amount, 0),
    depositMax: a.deposits.reduce((s, d) => Math.max(s, d.amount), 0),
    reached50: a.deposits.find((d) => d.total >= 500_000)?.at ?? (start >= 500_000 ? -Infinity : null),
    reached100: a.deposits.find((d) => d.total >= 1_000_000 - 1e-6)?.at ?? null,
    maxDrawdown: a.maxDrawdown,
    maxHeld: a.maxHeld,
    maxHeldMargin: a.maxHeldMargin,
    maxPending: a.maxPending,
    fates,
    fatesHalves: halves,
    winRate: n ? (outcomes.tp ?? 0) / n : null,
    outcomes,
    pips: n ? pips / n : null,
    yen: n ? yen / n : null,
  };
};
