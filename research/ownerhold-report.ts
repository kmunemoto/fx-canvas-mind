// #205 (docs §8.102): the numbers ownerhold.ts reports — the per-email view's
// win rate and pips, ③'s main number (each pair's buys and sells weighted
// equally) and its interval, the accounts' lines, and the counts beside them.

import { MINUTE, WEEK } from "./lib.ts";
import { clustered, intervalOf, lowEnd, medianOf, quantile, weekOf } from "./money-stats.ts";
import { type M1, PAIRS, isUsdPair } from "./ownerhold-data.ts";
import type { AccountOut, Fate, TradeRec } from "./ownerhold-account.ts";
import { type Book, NO_CUT, type Path, lastEnded, pipsOf, rangeExt } from "./ownerhold-trades.ts";
import { lowerBound, upperBound } from "./money-data.ts";

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
  // the same in yen (the per-trade yen's rule: a dollar pair's at USD/JPY's mid at the TP bar's end, or END)
  maeYen: { tp: Q; notTp: Q };
  // the trades taken at the market and on the limit: each's win rate and per trade
  byEntry: { market: Sub; limit: Sub };
}
export interface Sub {
  n: number;
  tp: number;
  winRate: number | null;
  pips: number | null;
  yen: number | null;
}
const subOf = (xs: Array<{ tp: boolean; pips: number; yen: number }>): Sub => {
  const n = xs.length;
  const tp = xs.filter((x) => x.tp).length;
  return { n, tp, winRate: n ? tp / n : null, pips: n ? xs.reduce((s, x) => s + x.pips, 0) / n : null, yen: n ? xs.reduce((s, x) => s + x.yen, 0) / n : null };
};
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

// the per-email view whole, by half (the signal's T before the split or not) and by pair
export interface PerEmailSplit {
  all: PerEmail;
  first: PerEmail;
  second: PerEmail;
  byPair: Record<string, PerEmail>;
}
export const perEmailSplitOf = (ems: EmailLike[], Ts: number[], paths: Path[], books: Book[], usdjpy: M1, endMs: number, split: number): PerEmailSplit => {
  const part = (keep: (i: number) => boolean) => {
    const ix = ems.map((_e, i) => i).filter(keep);
    return perEmailOf(ix.map((i) => ems[i]), ix.map((i) => paths[i]), books, usdjpy, endMs);
  };
  return {
    all: perEmailOf(ems, paths, books, usdjpy, endMs),
    first: part((i) => Ts[i] < split),
    second: part((i) => Ts[i] >= split),
    byPair: Object.fromEntries(PAIRS.map((pair, pi) => [pair, part((i) => ems[i].pi === pi)])),
  };
};

export const perEmailOf = (ems: EmailLike[], paths: Path[], books: Book[], usdjpy: M1, endMs: number): PerEmail => {
  const out: PerEmail = { emails: ems.length, none: 0, market: 0, limitFilled: 0, unfilled: 0, filled: 0, tp: 0, held: 0, winRate: null, pips: null, yen: null, shifted: 0, noBar: 0, tpInFill: 0, fillGaps: { n: 0, pips: 0, byKind: {} }, tpGaps: { n: 0, pips: 0, byKind: {} }, tpWithin: {}, mae: { tp: qOf([]), notTp: qOf([]) }, maeYen: { tp: qOf([]), notTp: qOf([]) }, byEntry: { market: subOf([]), limit: subOf([]) } };
  let pipSum = 0;
  let yenSum = 0;
  const maeTp: number[] = [];
  const maeNo: number[] = [];
  const maeYTp: number[] = [];
  const maeYNo: number[] = [];
  const entries: { market: Array<{ tp: boolean; pips: number; yen: number }>; limit: Array<{ tp: boolean; pips: number; yen: number }> } = { market: [], limit: [] };
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
    // yen a pip: the pair's quote currency on 10,000, a dollar pair's at USD/JPY's mid then
    const yenPip = bk.unit * 10_000 * (isUsdPair(PAIRS[e.pi]) ? usdJpyAt(usdjpy, atMs) : 1);
    yenSum += pips * yenPip;
    entries[p.market ? "market" : "limit"].push({ tp: p.tpK >= 0, pips, yen: pips * yenPip });
    if (p.tpK >= 0) {
      out.tp++;
      maeTp.push(p.mae);
      maeYTp.push(p.mae * yenPip);
    } else {
      out.held++;
      maeNo.push(p.mae);
      maeYNo.push(p.mae * yenPip);
    }
  });
  out.winRate = out.filled ? out.tp / out.filled : null;
  out.pips = out.filled ? pipSum / out.filled : null;
  out.yen = out.filled ? yenSum / out.filled : null;
  for (const [k, v] of Object.entries(within)) out.tpWithin[k] = { ...v, share: v.of ? v.tp / v.of : null };
  out.mae = { tp: qOf(maeTp), notTp: qOf(maeNo) };
  out.maeYen = { tp: qOf(maeYTp), notTp: qOf(maeYNo) };
  out.byEntry = { market: subOf(entries.market), limit: subOf(entries.limit) };
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
  // Rakuten's US-dollar minus balance rule (not applied): the week's first closes judged, and where it would apply
  usdNeg: { judged: number; hits: Array<{ tau: string; ratio: number }> };
  // the decision rows' records in full (§8.102 出すもの、①の文): each loss-cut (when, the funds before and after),
  // each call (τ, D, how it ended and when, the limits cancelled, what was paid in, U after the notice's deposit)
  // and each deposit (when, how much, the total put in by then)
  detail?: {
    lcs: Array<{ at: string; naBefore: number; naAfter: number; closed: number; cancelled: number }>;
    calls: Array<{ tau: string; deadline: string; D: number; end: string; endAt: string; cancelled: number; deposits: number; credits: number; uAfterDeposit: number | null }>;
    deposits: Array<{ at: string; amount: number; total: number; why: string }>;
  };
  fates: Record<Fate, number>;
  fatesHalves: [Record<string, number>, Record<string, number>];
  winRate: number | null;
  outcomes: Record<string, number>;
  pips: number | null;
  yen: number | null;
  // the account path's own (§8.102: 口座の道筋の分は別の行で出す), when the books are given: by half (the
  // signal's T), by pair, by entry (market or limit), the worst against each trade (pips and yen) and the TPs
  // within 1 day, 1 week, 4 weeks of P (the trades whose P + h is by END) and by END
  path?: {
    byHalf: [Sub & { outcomes: Record<string, number> }, Sub & { outcomes: Record<string, number> }];
    byPair: Record<string, Sub & { outcomes: Record<string, number> }>;
    byEntry: { market: Sub; limit: Sub };
    mae: { tp: Q; notTp: Q };
    maeYen: { tp: Q; notTp: Q };
    tpWithin: Record<string, { of: number; tp: number; share: number | null }>;
  };
}

// what the account path's line needs beyond the account: the books its trades ran on, USD/JPY, each email's P, END
export interface PathCtx {
  books: Book[];
  usdjpy: M1;
  P: number[];
  end: number;
}

// The worst against an account trade, pips: its exit side's extreme from the bar it came in on (the first
// bar from t0) to the bar of its exit minute (a TP or a loss-cut: the whole bar, its order unknown), to the
// last bar before the deadline's minute and the deadline's price (closed at that minute's open), or to the
// last bar ended by END (still held); Rakuten's stop's bars counted, as the per-email view's
export const maeOfTrade = (t: TradeRec, bk: Book, end: number): number => {
  const m = bk.m;
  const buy = t.dir === 1;
  const a = lowerBound(m.t, t.t0);
  let b: number;
  let extra = buy ? Infinity : -Infinity;
  if (t.how === "held") b = lastEnded(m, end);
  else if (t.how === "deadline") {
    b = lowerBound(m.t, t.x) - 1;
    extra = t.exit;
  } else b = upperBound(m.t, t.x) - 1;
  let worst = extra;
  if (a <= b) worst = buy ? Math.min(worst, rangeExt(m.bl, bk.blMin, a, b, false, NO_CUT)) : Math.max(worst, rangeExt(m.ah, bk.ahMax, a, b, true, NO_CUT));
  if (!Number.isFinite(worst)) return 0;
  return Math.max(0, buy ? t.fill - worst : worst - t.fill) / bk.unit;
};

// yen a pip of an account trade: a dollar pair's at USD/JPY's mid as the trade table's yen (a TP or a
// deadline by its minute's start, a loss-cut by its end, one still held at END)
const yenPipOf = (t: TradeRec, unit: number, usdjpy: M1, end: number): number => {
  if (!isUsdPair(PAIRS[t.pi])) return unit * 10_000;
  const at = t.how === "held" ? end : t.how === "lc" ? t.x + MINUTE : t.x;
  return unit * 10_000 * usdJpyAt(usdjpy, at);
};

const pipsOfTrade = (t: TradeRec, unit: number) => (t.dir * (t.exit - t.fill)) / unit;

const isoOf = (ms: number) => (Number.isFinite(ms) ? new Date(ms).toISOString() : "-");

export const accountLineOf = (a: AccountOut, start: number, Ts: number[], split: number, units: number[], pc?: PathCtx, detail = false): AccountLine => {
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
  let path: AccountLine["path"];
  if (pc) {
    type Row = { tp: boolean; pips: number; yen: number; how: string };
    const rows: Row[] = a.trades.map((t) => ({ tp: t.how === "tp", pips: pipsOfTrade(t, units[t.pi]), yen: t.yen, how: t.how }));
    const withOut = (xs: Row[]) => {
      const outcomes: Record<string, number> = {};
      for (const x of xs) outcomes[x.how] = (outcomes[x.how] ?? 0) + 1;
      return { ...subOf(xs), outcomes };
    };
    const maeP = { tp: [] as number[], notTp: [] as number[] };
    const maeY = { tp: [] as number[], notTp: [] as number[] };
    const within: Record<string, { of: number; tp: number }> = { "1d": { of: 0, tp: 0 }, "1w": { of: 0, tp: 0 }, "4w": { of: 0, tp: 0 }, end: { of: 0, tp: 0 } };
    const hs: Array<[string, number]> = [["1d", DAY_MS], ["1w", WEEK], ["4w", 4 * WEEK]];
    for (const t of a.trades) {
      const bk = pc.books[t.pi];
      const mae = maeOfTrade(t, bk, pc.end);
      const k = t.how === "tp" ? "tp" : "notTp";
      maeP[k].push(mae);
      maeY[k].push(mae * yenPipOf(t, bk.unit, pc.usdjpy, pc.end));
      const P = pc.P[t.sig];
      for (const [name, h] of hs) {
        if (P + h > pc.end) continue;
        within[name].of++;
        if (t.how === "tp" && t.x + MINUTE <= P + h) within[name].tp++;
      }
      within.end.of++;
      if (t.how === "tp") within.end.tp++;
    }
    path = {
      byHalf: [withOut(rows.filter((_r, k) => Ts[a.trades[k].sig] < split)), withOut(rows.filter((_r, k) => Ts[a.trades[k].sig] >= split))],
      byPair: Object.fromEntries(PAIRS.map((pair, pi) => [pair, withOut(rows.filter((_r, k) => a.trades[k].pi === pi))])),
      byEntry: { market: subOf(rows.filter((_r, k) => a.trades[k].market)), limit: subOf(rows.filter((_r, k) => !a.trades[k].market)) },
      mae: { tp: qOf(maeP.tp), notTp: qOf(maeP.notTp) },
      maeYen: { tp: qOf(maeY.tp), notTp: qOf(maeY.notTp) },
      tpWithin: Object.fromEntries(Object.entries(within).map(([k2, v]) => [k2, { ...v, share: v.of ? v.tp / v.of : null }])),
    };
  }
  return {
    path,
    usdNeg: { judged: a.usdNegJudged, hits: a.usdNeg.map((h) => ({ tau: isoOf(h.tau), ratio: h.ratio })) },
    detail: detail
      ? {
        lcs: a.lcs.map((l) => ({ at: isoOf(l.at), naBefore: l.naBefore, naAfter: l.naAfter, closed: l.closed, cancelled: l.cancelled })),
        calls: a.calls.map((c) => ({ tau: isoOf(c.tau), deadline: isoOf(c.deadline), D: c.D, end: c.end, endAt: isoOf(c.endAt), cancelled: c.cancelled, deposits: c.deposits, credits: c.credits, uAfterDeposit: c.uAfterDeposit })),
        deposits: a.deposits.map((d) => ({ at: isoOf(d.at), amount: d.amount, total: d.total, why: d.why })),
      }
      : undefined,
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
