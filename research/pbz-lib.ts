// #378 (docs §8.125): the parts of research/pbz.ts that read no file.
//
//   * Rakuten's ピークボトム (peak / bottom, term 10) on a pair's closed 1-hour bars (GMO's bid highs and lows), as
//     the chart shows it with the bars up to a close k: M_k (a bar's later bars only those up to k);
//   * the emails: A, a mark on the bar exactly 10 bars back is in M_k; B, M_k's newest mark is on bar k itself and is
//     of the other kind than M_{k−1}'s newest (or M_{k−1} has none); C, the same as B judged minute by minute while
//     bar k forms (its high and low so far from the 1-minute bid bars), at the first minute it holds;
//   * each email followed the owner's way and by the guide (flowz-lib's ownerOf and guideOf, §8.124), and the trade
//     the other way round (the owner's way only);
//   * the numbers §8.125 asks for, the halves, the choice of A, B or C, the month bootstrap.
//
// Every random draw comes from mulberry32 with the seed §8.125 names, drawn in the order written below, so
// research/pbz-check.py can draw the same numbers.

import { isPossiblyClosed } from "../supabase/functions/_shared/market-hours.ts";
import type { M1 } from "./ownerhold-data.ts";
import type { Book } from "./ownerhold-trades.ts";
import { lowerBound } from "./money-data.ts";
import { type Guide, type Mail, type Owner, guideOf, mailedAt, mean, median, mulberry32, ownerOf } from "./flowz-lib.ts";
import { DAY, HOUR, MINUTE } from "./lib.ts";

// ---- the marks ----------------------------------------------------------------------------------

export const TERM = 10;

// a closed 1-hour bar: its open (ms), its bid high and low (the marks), its mid close as the chart rounds it (E)
export interface PbBar {
  t: number;
  hi: number;
  lo: number;
  close: number;
}

export type Kind = "peak" | "bottom";

export interface Mark {
  // the bar's index in the pair's bars
  i: number;
  kind: Kind;
  // the bar's high (a peak) or low (a bottom), as the bar stood when the mark was read
  price: number;
}

// a bar's high and low, the last bar (k) read from `last` when given (C: bar k as it stands so far)
const hiOf = (bars: readonly PbBar[], x: number, k: number, last?: PbBar) => (last && x === k ? last.hi : bars[x].hi);
const loOf = (bars: readonly PbBar[], x: number, k: number, last?: PbBar) => (last && x === k ? last.lo : bars[x].lo);

// Bar j's two tests when the bars up to k are known: the 10 bars before it and the bars after it up to k (at most
// 10); both false when j has fewer than 10 bars before it. `last` stands in for bar k (C's forming bar).
export const testsAt = (bars: readonly PbBar[], j: number, k: number, last?: PbBar): { peak: boolean; bottom: boolean } => {
  if (j < TERM || j > k) return { peak: false, bottom: false };
  let pp = -Infinity;
  let pb = Infinity;
  for (let x = j - TERM; x < j; x++) {
    const h = hiOf(bars, x, k, last);
    const l = loOf(bars, x, k, last);
    if (h > pp) pp = h;
    if (l < pb) pb = l;
  }
  let fp = -Infinity;
  let fb = Infinity;
  for (let x = j + 1; x <= Math.min(j + TERM, k); x++) {
    const h = hiOf(bars, x, k, last);
    const l = loOf(bars, x, k, last);
    if (h > fp) fp = h;
    if (l < fb) fb = l;
  }
  // with no later bar, fp = −∞ and fb = +∞: only the earlier bars count
  const hj = hiOf(bars, j, k, last);
  const lj = loOf(bars, j, k, last);
  return { peak: hj > pp && hj >= fp, bottom: lj < pb && lj <= fb };
};

// Bar j as a candidate when the bars up to k are known; a bar both a peak and a bottom candidate is a peak
export const candidateAt = (bars: readonly PbBar[], j: number, k: number, last?: PbBar): Kind | null => {
  const t = testsAt(bars, j, k, last);
  return t.peak ? "peak" : t.bottom ? "bottom" : null;
};

// One candidate onto the list (in place): the same kind as the last kept, the higher peak or the lower bottom stays
// (a tie keeps the older); the other kind is added.
export const pushMark = (list: Mark[], c: Mark): void => {
  const last = list.length ? list[list.length - 1] : null;
  if (last === null || last.kind !== c.kind) {
    list.push(c);
    return;
  }
  if (c.kind === "peak" ? c.price > last.price : c.price < last.price) list[list.length - 1] = c;
};

const markOf = (bars: readonly PbBar[], j: number, kind: Kind, k: number, last?: PbBar): Mark => ({
  i: j,
  kind,
  price: kind === "peak" ? hiOf(bars, j, k, last) : loOf(bars, j, k, last),
});

// M_k from scratch: every bar from the first, its candidacy with the bars up to k (the slow reference)
export const marksAtSlow = (bars: readonly PbBar[], k: number, last?: PbBar): Mark[] => {
  const list: Mark[] = [];
  for (let j = 0; j <= k; j++) {
    const kind = candidateAt(bars, j, k, last);
    if (kind) pushMark(list, markOf(bars, j, kind, k, last));
  }
  return list;
};

// The fold of the candidates j in [from, k] (judged with the bars up to k, bar k read from `last` when given) onto
// a list holding only `base` (the last mark of the fixed part, or none): M's tail
const tailOf = (bars: readonly PbBar[], base: Mark | null, from: number, k: number, last?: PbBar): Mark[] => {
  const tail: Mark[] = base ? [base] : [];
  for (let j = Math.max(0, from); j <= k; j++) {
    const kind = candidateAt(bars, j, k, last);
    if (kind) pushMark(tail, markOf(bars, j, kind, k, last));
  }
  return tail;
};

// What the emails read of M_k, for every k: its newest mark, and whether the bar k − TERM holds a mark in it. Built
// the fast way: the candidates whose 10 later bars are all there (j ≤ k − TERM) never change, so they are folded
// once into `fixed`; the up to TERM newer ones (j > k − TERM, judged with the bars up to k) are folded onto a copy
// of its last mark each k. The fold only ever replaces or adds at the end, so the copy's last mark and the ones
// added after it are all M_k's tail holds.
export interface Read {
  newest: Mark | null;
  // the mark on bar k − TERM is in M_k
  fixedHere: boolean;
  // the last mark of the fixed part after bar k (the candidates j ≤ k − TERM folded)
  fixedLast: Mark | null;
}

export const readsOf = (bars: readonly PbBar[]): { reads: Read[]; final: Mark[] } => {
  const fixed: Mark[] = [];
  const reads: Read[] = [];
  let tail: Mark[] = [];
  for (let k = 0; k < bars.length; k++) {
    const jf = k - TERM;
    if (jf >= 0) {
      const kind = candidateAt(bars, jf, k);
      if (kind) pushMark(fixed, markOf(bars, jf, kind, k));
    }
    const base = fixed.length ? fixed[fixed.length - 1] : null;
    tail = tailOf(bars, base, jf + 1, k);
    const newest = tail.length ? tail[tail.length - 1] : null;
    reads.push({ newest, fixedHere: jf >= 0 && tail.some((m) => m.i === jf), fixedLast: base });
  }
  // M at the last bar: the fixed marks with the tail's in place of the last fixed one
  const final = fixed.length ? [...fixed.slice(0, -1), ...tail] : [...tail];
  return { reads, final };
};

// ---- the emails ---------------------------------------------------------------------------------

export type Cand = "A" | "B" | "C";
export const CANDS: readonly Cand[] = ["A", "B", "C"];

export interface PbMail {
  cand: Cand;
  pair: string;
  // the bar k: its index and open (ms)
  k: number;
  open: number;
  // the email's time: A and B bar k's close, C the close of the minute it fired in
  T: number;
  side: "BUY" | "SELL";
  dir: 1 | -1;
  // the email's entry: A and B bar k's mid close (the chart's rounding), C that minute's mid close rounded alike
  E: number;
  // the mark it is about (A bar k − 10's, B and C bar k's) and its bar's open
  mark: Mark;
  markOpen: number;
  // the mark's bar was both a peak and a bottom candidate when the email was decided (then a peak, a SELL)
  both: boolean;
  // bar k opened 24 hours or more after the bar before it (the first bar after a weekend or a holiday)
  weekFirst: boolean;
}

export interface MailsOut {
  mails: PbMail[];
  // fired on a time no read can mail (A and B: mailedAt; C: the minute's close + 1 s inside the closure)
  closed: Record<Cand, number>;
  // closed, by the half of the time it fired at (1 or 2), for the tables
  closedTimes: Array<{ cand: Cand; T: number }>;
  // C: sent, and its mark on bar k gone (or of the other kind) when bar k closed
  cVanished: number;
  // bars whose 1-minute bid bars give another high or low than the 1-hour file's (bars closed in the period)
  cBarDiff: number;
  cBarsSeen: number;
}

const sideOf = (kind: Kind): { side: "BUY" | "SELL"; dir: 1 | -1 } => (kind === "bottom" ? { side: "BUY", dir: 1 } : { side: "SELL", dir: -1 });

// the chart's rounding (live-chart historyRead: Number(v.toFixed(d))): 3 decimals for the yen pairs, else 5
export const decimalsOf = (pair: string): number => (pair.includes("JPY") ? 3 : 5);
const rounded = (v: number, d: number) => Number(v.toFixed(d));

// The A, B and C emails of one pair whose time is in [fromT, toT). m1: the pair's 1-minute bars (C reads them).
// Per bar: A, then B, then C.
export const mailsOf = (pair: string, bars: readonly PbBar[], reads: readonly Read[], m1: M1 | null, fromT: number, toT: number): MailsOut => {
  const mails: PbMail[] = [];
  const closed: Record<Cand, number> = { A: 0, B: 0, C: 0 };
  const closedTimes: Array<{ cand: Cand; T: number }> = [];
  let cVanished = 0;
  let cBarDiff = 0;
  let cBarsSeen = 0;
  const d = decimalsOf(pair);
  for (let k = 0; k < bars.length; k++) {
    const Tk = bars[k].t + HOUR;
    const weekFirst = k > 0 && bars[k].t - bars[k - 1].t >= DAY;
    const prev = k > 0 ? reads[k - 1].newest : null;
    const fired: PbMail[] = [];
    const emit = (cand: Cand, T: number, E: number, mark: Mark, both: boolean) => {
      if (T < fromT || T >= toT) return;
      const ok = cand === "C" ? !isPossiblyClosed(T + 1000) : mailedAt(T);
      if (!ok) {
        closed[cand]++;
        closedTimes.push({ cand, T });
        return;
      }
      fired.push({ cand, pair, k, open: bars[k].t, T, ...sideOf(mark.kind), E, mark, markOpen: bars[mark.i].t, both, weekFirst });
    };
    // A: the mark on bar k − 10 in M_k
    const r = reads[k];
    if (r.fixedHere) {
      const j = k - TERM;
      const kind = candidateAt(bars, j, k) as Kind;
      const t = testsAt(bars, j, k);
      emit("A", Tk, bars[k].close, markOf(bars, j, kind, k), t.peak && t.bottom);
    }
    // B: M_k's newest on bar k, of the other kind than M_{k−1}'s newest
    if (r.newest && r.newest.i === k && (prev === null || prev.kind !== r.newest.kind)) {
      const t = testsAt(bars, k, k);
      emit("B", Tk, bars[k].close, r.newest, t.peak && t.bottom);
    }
    // C: minute by minute while bar k forms (only the minutes read: the 1-minute bars inside bar k)
    if (m1 && Tk >= fromT && bars[k].t < toT) {
      const a = lowerBound(m1.t, bars[k].t);
      const b = lowerBound(m1.t, bars[k].t + HOUR);
      if (b > a) {
        const base = k > 0 ? reads[k - 1].fixedLast : null;
        let hi = -Infinity;
        let lo = Infinity;
        let firedC = false;
        for (let q = a; q < b; q++) {
          const moved = m1.bh[q] > hi || m1.bl[q] < lo;
          if (m1.bh[q] > hi) hi = m1.bh[q];
          if (m1.bl[q] < lo) lo = m1.bl[q];
          // M changes only when bar k's high or low moves
          if (firedC || !moved) continue;
          const last: PbBar = { t: bars[k].t, hi, lo, close: NaN };
          const tail = tailOf(bars, base, k - TERM, k, last);
          const newest = tail.length ? tail[tail.length - 1] : null;
          if (newest && newest.i === k && (prev === null || prev.kind !== newest.kind)) {
            firedC = true;
            const t = testsAt(bars, k, k, last);
            const T = m1.t[q] + MINUTE;
            const before = mails.length + fired.length;
            emit("C", T, rounded((m1.bc[q] + m1.ac[q]) / 2, d), newest, t.peak && t.bottom);
            const sent = mails.length + fired.length > before;
            // at the close: is bar k still marked, of that kind?
            if (sent && !(r.newest && r.newest.i === k && r.newest.kind === newest.kind)) cVanished++;
          }
        }
        if (Tk >= fromT && Tk < toT) {
          cBarsSeen++;
          if (hi !== bars[k].hi || lo !== bars[k].lo) cBarDiff++;
        }
      }
    }
    mails.push(...fired);
  }
  return { mails, closed, closedTimes, cVanished, cBarDiff, cBarsSeen };
};

// ---- one email followed -------------------------------------------------------------------------

// flowz-lib's Mail for its ownerOf and guideOf (the MACD fields unused: 0)
const asMail = (m: PbMail, dir: 1 | -1): Mail => ({ pair: m.pair, open: m.open, T: m.T, side: dir === 1 ? "BUY" : "SELL", dir, E: m.E, m: 0, top: 0, bottom: 0, i: m.k });

export interface Trade {
  own: Owner;
  guide: Guide | null;
}

export const tradeOf = (bk: Book, m: PbMail, endMs: number): Trade => {
  const mail = asMail(m, m.dir);
  const own = ownerOf(bk, mail, endMs);
  return { own, guide: guideOf(bk, mail, own, endMs) };
};

// the same email the other way round: the owner's way only
export const oppositeOf = (bk: Book, m: PbMail, endMs: number): Owner => ownerOf(bk, asMail(m, m.dir === 1 ? -1 : 1), endMs);

// the email (and the other way) cut at SPLIT: the first half's trades as known then (stage 1)
export const cutOf = (bk: Book, m: PbMail, splitMs: number): { own: Owner; opp: Owner } => ({
  own: ownerOf(bk, asMail(m, m.dir), splitMs),
  opp: ownerOf(bk, asMail(m, m.dir === 1 ? -1 : 1), splitMs),
});

// ---- the numbers --------------------------------------------------------------------------------

export interface Row {
  mail: PbMail;
  half: 1 | 2;
  month: string;
  trade: Trade;
  opp: Owner;
  // the first half's rows: the email and the other way followed to SPLIT (null in the second half)
  cut: { own: Owner; opp: Owner } | null;
  // M_END holds the email's mark (the same bar and kind); or the same bar of the other kind
  stays: boolean;
  otherKind: boolean;
}

export interface Stats {
  mails: number;
  filled: number;
  unfilled: number;
  tp: number;
  held: number;
  // TP / filled, %
  win: number | null;
  pipsMean: number | null;
  pipsMedian: number | null;
  maeMedian: number | null;
  maeMax: number | null;
  holdMedian: number | null;
  holdMax: number | null;
  // the trades held at END: their pips summed, and the worst
  heldPipsSum: number;
  heldPipsMin: number | null;
}

export interface GuideStats {
  guideTp: number;
  guideSl: number;
  guideHeld: number;
  guideBoth: number;
  guideWin: number | null;
  guidePipsMean: number | null;
}

// the owner's way over a list of trades in the rows' order (as flowz-lib's statsOf)
export const ownerStats = (xs: readonly Owner[]): Stats => {
  const f = xs.filter((o) => o.filled);
  const pips = f.map((o) => o.pips as number);
  const held = f.filter((o) => o.held);
  const tp = f.filter((o) => o.tp).length;
  return {
    mails: xs.length,
    filled: f.length,
    unfilled: xs.length - f.length,
    tp,
    held: held.length,
    win: f.length ? (100 * tp) / f.length : null,
    pipsMean: mean(pips),
    pipsMedian: median(pips),
    maeMedian: median(f.map((o) => o.mae as number)),
    maeMax: f.length ? Math.max(...f.map((o) => o.mae as number)) : null,
    holdMedian: median(f.map((o) => o.hold as number)),
    holdMax: f.length ? Math.max(...f.map((o) => o.hold as number)) : null,
    heldPipsSum: held.reduce((s, o) => s + (o.pips as number), 0),
    heldPipsMin: held.length ? Math.min(...held.map((o) => o.pips as number)) : null,
  };
};

export const guideStats = (xs: ReadonlyArray<Guide | null>): GuideStats => {
  const g = xs.filter((x): x is Guide => x !== null);
  const tp = g.filter((x) => x.result === "tp").length;
  return {
    guideTp: tp,
    guideSl: g.filter((x) => x.result === "sl").length,
    guideHeld: g.filter((x) => x.result === "held").length,
    guideBoth: g.filter((x) => x.both).length,
    guideWin: g.length ? (100 * tp) / g.length : null,
    guidePipsMean: mean(g.map((x) => x.pips)),
  };
};

// the mean pips of the filled trades (the owner's way), in the rows' order
export const meanOf = (xs: readonly Owner[]): number | null => mean(xs.filter((o) => o.filled).map((o) => o.pips as number));
export const meanOwn = (rows: readonly Row[]): number | null => meanOf(rows.map((r) => r.trade.own));
export const meanOpp = (rows: readonly Row[]): number | null => meanOf(rows.map((r) => r.opp));
const gapOf = (a: number | null, b: number | null) => (a === null || b === null ? null : a - b);
export const gapOwn = (rows: readonly Row[]): number | null => gapOf(meanOwn(rows), meanOpp(rows));
// the first half as known at SPLIT
export const meanCut = (rows: readonly Row[]): number | null => meanOf(rows.filter((r) => r.cut).map((r) => (r.cut as { own: Owner }).own));
export const gapCut = (rows: readonly Row[]): number | null =>
  gapOf(meanCut(rows), meanOf(rows.filter((r) => r.cut).map((r) => (r.cut as { opp: Owner }).opp)));

export const DRAWS = 10_000;
export const BOOT_SEED = 378;

// The rank of the q-th quantile among C sorted values, 1-based: floor(q × C + 0.5) (Math.round), within [1, C]
export const rankOf = (q: number, c: number): number => Math.min(c, Math.max(1, Math.round(q * c)));

// The months (UTC) of the rows, resampled with replacement DRAWS times: each draw picks as many months as there
// are, floor(r() × M) each in turn (0-based), and lays the picked months' rows out in the order picked (a month
// picked twice counted twice). Each draw: the gap (the emails' mean less the other way's) and the emails' mean; a
// draw with no filled trade on either side is left out of both and counted. The 95% range of each: its values
// sorted apart, the rankOf(0.025, C)-th and the rankOf(0.975, C)-th (C the draws left); none when C is 0.
export const bootstrap = (rows: readonly Row[], draws = DRAWS, seed = BOOT_SEED) => {
  const months = [...new Set(rows.map((r) => r.month))].sort();
  const byMonth = new Map(months.map((mo) => [mo, rows.filter((r) => r.month === mo)]));
  const r = mulberry32(seed);
  const gaps: number[] = [];
  const owns: number[] = [];
  let empty = 0;
  if (months.length > 0) {
    for (let d = 0; d < draws; d++) {
      const pick: Row[] = [];
      for (let j = 0; j < months.length; j++) pick.push(...(byMonth.get(months[Math.floor(r() * months.length)]) as Row[]));
      const a = meanOwn(pick);
      const b = meanOpp(pick);
      if (a === null || b === null) {
        empty++;
        continue;
      }
      gaps.push(a - b);
      owns.push(a);
    }
  }
  gaps.sort((x, y) => x - y);
  owns.sort((x, y) => x - y);
  const at = (xs: number[], q: number) => (xs.length ? xs[rankOf(q, xs.length) - 1] : null);
  return { gapLo: at(gaps, 0.025), gapHi: at(gaps, 0.975), ownLo: at(owns, 0.025), ownHi: at(owns, 0.975), kept: gaps.length, empty, months: months.length };
};
