// #371 (docs §8.124): the parts of research/flowz.ts that read no file.
//
//   * the 1-hour MACD emails (v6, 95%: _shared/macd-level.ts decideZoneOnWindow) found on a pair's closed
//     1-hour mid bars, those whose close a read of the sweep (0, 3 and 5 minutes after it) can mail;
//   * the big trend at each: A, the 1-hour bar's close against the 1-hour EMA200 there; B, the newest 4-hour
//     bar closed by the email's close against the 4-hour EMA200 there (emaSeries: TradingView's);
//   * each email followed the owner's way (§8.102's main row: ownerhold-trades follow) and by the email's
//     guide (stop 13, TP 4 pips, the first reached on the 1-minute bars, both in one bar a loss);
//   * the numbers §8.124 asks for, the halves, the choice of A or B, the month bootstrap and the random drop.
//
// Every random draw comes from mulberry32 with the seed §8.124 names, drawn in the order written below, so
// research/flowz-check.py can draw the same numbers.

import { decideZoneOnWindow, LEVEL_WINDOW } from "../supabase/functions/_shared/macd-level.ts";
import { isPossiblyClosed } from "../supabase/functions/_shared/market-hours.ts";
import { emaSeries } from "../supabase/functions/analyze/indicators.ts";
import { lowerBound } from "./money-data.ts";
import { type Book, type Path, follow, lastEnded, pipsOf } from "./ownerhold-trades.ts";
import { HOUR, MINUTE } from "./lib.ts";

// ---- the emails -------------------------------------------------------------------------------

// a closed 1-hour (or 4-hour) bar: its open (ms) and its mid close as the chart rounds it
export interface Bar {
  t: number;
  close: number;
}

export type Side = "BUY" | "SELL";
export type Flow = "up" | "down" | "none";

export interface Mail {
  pair: string;
  // the bar's open and close (T), ms
  open: number;
  T: number;
  side: Side;
  dir: 1 | -1;
  // the email's entry: the bar's mid close
  E: number;
  // what fired: the MACD line, the pane's top and bottom
  m: number;
  top: number;
  bottom: number;
  // the index of the bar in the pair's 1-hour bars
  i: number;
}

// the sweep reads the 1-hour chart 0, 3 and 5 minutes after the close (indicators.ts gmoIntervalsDue), a second in
export const READ_AFTER_MIN: readonly number[] = [0, 3, 5];
export const mailedAt = (T: number): boolean => READ_AFTER_MIN.some((m) => !isPossiblyClosed(T + m * MINUTE + 1000));

// The emails of one pair whose bar closed in [fromT, toT): each closed bar with LEVEL_WINDOW bars up to it judged
// on those bars alone, as the sweep judges it at its close
export const mailsOf = (pair: string, bars: readonly Bar[], fromT: number, toT: number): { mails: Mail[]; judged: number; notMailed: number } => {
  const mails: Mail[] = [];
  let judged = 0;
  let notMailed = 0;
  for (let i = LEVEL_WINDOW - 1; i < bars.length; i++) {
    const T = bars[i].t + HOUR;
    if (T < fromT || T >= toT) continue;
    judged++;
    const d = decideZoneOnWindow(bars, i);
    if (d === null) continue;
    if (!mailedAt(T)) {
      notMailed++;
      continue;
    }
    mails.push({ pair, open: bars[i].t, T, side: d.side, dir: d.side === "BUY" ? 1 : -1, E: bars[i].close, m: d.m, top: d.top, bottom: d.bottom, i });
  }
  return { mails, judged, notMailed };
};

// ---- the big trend ----------------------------------------------------------------------------

export const FLOW_EMA = 200;

const flowOf = (close: number, ema: number | null): Flow => (ema === null ? "none" : close > ema ? "up" : close < ema ? "down" : "none");

// A: the email's own 1-hour bar against the 1-hour EMA200 there (from the first bar given)
export const flowsA = (bars1h: readonly Bar[]): Flow[] => {
  const ema = emaSeries(bars1h.map((b) => b.close), FLOW_EMA);
  return bars1h.map((b, i) => flowOf(b.close, ema[i]));
};

// B: the newest 4-hour bar closed by T (its open + 4 hours at or before T) against the 4-hour EMA200 there
// (t4: the 4-hour bars' opens)
export const flowB = (t4: ArrayLike<number>, bars4h: readonly Bar[], ema4h: ReadonlyArray<number | null>, T: number): Flow => {
  // the 4-hour bars opened at or before T − 4 hours
  const j = lowerBound(t4, T - 4 * HOUR + 1) - 1;
  return j < 0 ? "none" : flowOf(bars4h[j].close, ema4h[j]);
};

// with the trend (順向き), against it (逆向き), or not decided (決めない)
export type Lean = "with" | "against" | "none";
export const leanOf = (dir: 1 | -1, f: Flow): Lean => (f === "none" ? "none" : (f === "up") === (dir === 1) ? "with" : "against");

// ---- one email followed -----------------------------------------------------------------------

export const OWNER_DELAY_MIN = 2;
export const OWNER_TP_PIPS = 10;
export const GUIDE_SL_PIPS = 13;
export const GUIDE_TP_PIPS = 4;

export interface Owner {
  filled: boolean;
  tp: boolean;
  held: boolean;
  // pips: out at TP, or held at END (null when not filled)
  pips: number | null;
  mae: number | null;
  // hours from the fill to TP (or END)
  hold: number | null;
  path: Path;
}

export const ownerOf = (bk: Book, mail: Mail, endMs: number): Owner => {
  const u = bk.unit;
  const path = follow(bk, { dir: mail.dir, E: mail.E, tp: mail.E + mail.dir * OWNER_TP_PIPS * u, P: mail.T + OWNER_DELAY_MIN * MINUTE }, { fill: "touch", endMs });
  const filled = !(path.none || path.fillK === -2);
  if (!filled) return { filled, tp: false, held: false, pips: null, mae: null, hold: null, path };
  const tp = path.tpK >= 0;
  const out = tp ? path.x + MINUTE : endMs;
  return { filled, tp, held: !tp, pips: pipsOf(path, mail.dir, u), mae: path.mae, hold: (out - path.t0) / HOUR, path };
};

export interface Guide {
  result: "tp" | "sl" | "held";
  pips: number;
  // the stop and the TP inside one 1-minute bar (counted as the stop)
  both: boolean;
}

// From the owner's fill (the same price and bar), the email's guide: the stop E ∓ 13 pips or TP E ± 4 pips, the
// first reached in the bars after the fill bar (a stopped bar not judged), at the level or the bar's open where the
// open is already past it; both in one bar: the stop; neither by END: the exit side's close of the last bar by END
export const guideOf = (bk: Book, mail: Mail, own: Owner, endMs: number): Guide | null => {
  if (!own.filled) return null;
  const m = bk.m;
  const u = bk.unit;
  const buy = mail.dir === 1;
  const p = own.path;
  const fill = p.fill;
  const sl = mail.E - mail.dir * GUIDE_SL_PIPS * u;
  const tp = mail.E + mail.dir * GUIDE_TP_PIPS * u;
  const from = p.fillK >= 0 ? p.fillK + 1 : lowerBound(m.t, p.P);
  const lastK = lastEnded(m, endMs);
  const pipsAt = (x: number) => (mail.dir * (x - fill)) / u;
  for (let k = from; k <= lastK; k++) {
    if (bk.skipMaint && bk.maint[k] === 1) continue;
    // the exit side: a BUY leaves on the bid, a SELL on the ask
    const o = buy ? m.bo[k] : m.ao[k];
    const hi = buy ? m.bh[k] : m.ah[k];
    const lo = buy ? m.bl[k] : m.al[k];
    if (buy ? o <= sl : o >= sl) return { result: "sl", pips: pipsAt(o), both: false };
    if (buy ? o >= tp : o <= tp) return { result: "tp", pips: pipsAt(o), both: false };
    const hitSl = buy ? lo <= sl : hi >= sl;
    const hitTp = buy ? hi >= tp : lo <= tp;
    if (hitSl) return { result: "sl", pips: pipsAt(sl), both: hitTp };
    if (hitTp) return { result: "tp", pips: pipsAt(tp), both: false };
  }
  const endPx = lastK >= 0 ? (buy ? m.bc[lastK] : m.ac[lastK]) : NaN;
  return { result: "held", pips: pipsAt(endPx), both: false };
};

// ---- the numbers ------------------------------------------------------------------------------

export interface Row {
  mail: Mail;
  half: 1 | 2;
  month: string;
  A: Lean;
  B: Lean;
  own: Owner;
  guide: Guide | null;
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
  guideTp: number;
  guideSl: number;
  guideHeld: number;
  guideBoth: number;
  guideWin: number | null;
  guidePipsMean: number | null;
}

// the median as the mean of the two middle values of an even count
export const median = (xs: readonly number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const h = s.length >> 1;
  return s.length % 2 === 1 ? s[h] : (s[h - 1] + s[h]) / 2;
};
// summed in the order given (the rows' order: by close, then by pair)
export const mean = (xs: readonly number[]): number | null => {
  if (xs.length === 0) return null;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
};

export const statsOf = (rows: readonly Row[]): Stats => {
  const f = rows.filter((r) => r.own.filled);
  const pips = f.map((r) => r.own.pips as number);
  const held = f.filter((r) => r.own.held);
  const g = f.map((r) => r.guide as Guide);
  const tp = f.filter((r) => r.own.tp).length;
  const gTp = g.filter((x) => x.result === "tp").length;
  return {
    mails: rows.length,
    filled: f.length,
    unfilled: rows.length - f.length,
    tp,
    held: held.length,
    win: f.length ? (100 * tp) / f.length : null,
    pipsMean: mean(pips),
    pipsMedian: median(pips),
    maeMedian: median(f.map((r) => r.own.mae as number)),
    maeMax: f.length ? Math.max(...f.map((r) => r.own.mae as number)) : null,
    holdMedian: median(f.map((r) => r.own.hold as number)),
    holdMax: f.length ? Math.max(...f.map((r) => r.own.hold as number)) : null,
    heldPipsSum: held.reduce((s, r) => s + (r.own.pips as number), 0),
    heldPipsMin: held.length ? Math.min(...held.map((r) => r.own.pips as number)) : null,
    guideTp: gTp,
    guideSl: g.filter((x) => x.result === "sl").length,
    guideHeld: g.filter((x) => x.result === "held").length,
    guideBoth: g.filter((x) => x.both).length,
    guideWin: g.length ? (100 * gTp) / g.length : null,
    guidePipsMean: mean(g.map((x) => x.pips)),
  };
};

export type Cand = "A" | "B";
export const leanOfRow = (r: Row, c: Cand): Lean => (c === "A" ? r.A : r.B);

// the owner's way, pips a filled trade: those with the trend less all decided (with + against)
export const gapOf = (rows: readonly Row[], c: Cand): number | null => {
  const decided = rows.filter((r) => leanOfRow(r, c) !== "none" && r.own.filled);
  const withT = decided.filter((r) => leanOfRow(r, c) === "with");
  const a = mean(withT.map((r) => r.own.pips as number));
  const b = mean(decided.map((r) => r.own.pips as number));
  return a === null || b === null ? null : a - b;
};

// mulberry32, a float in [0, 1)
export const mulberry32 = (seed: number) => {
  let a = seed | 0;
  return (): number => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

export const DRAWS = 10_000;
export const BOOT_SEED = 371;
export const DROP_SEED = 3710;

// The months (UTC) of the decided rows, resampled with replacement DRAWS times: each draw picks as many months as
// there are, floor(r() × M) each in turn; the gap of the draw's rows (a month picked twice counted twice). The
// 95% range: the 250th and the 9,750th of the sorted gaps (1-based); a draw without a filled trade on either side
// is left out and counted.
export const bootstrap = (rows: readonly Row[], c: Cand, draws = DRAWS, seed = BOOT_SEED): { lo: number; hi: number; empty: number; months: number } => {
  const decided = rows.filter((r) => leanOfRow(r, c) !== "none");
  const months = [...new Set(decided.map((r) => r.month))].sort();
  const byMonth = new Map(months.map((mo) => [mo, decided.filter((r) => r.month === mo)]));
  const r = mulberry32(seed);
  const gaps: number[] = [];
  let empty = 0;
  for (let d = 0; d < draws; d++) {
    const pick: Row[] = [];
    for (let j = 0; j < months.length; j++) pick.push(...(byMonth.get(months[Math.floor(r() * months.length)]) as Row[]));
    const g = gapOf(pick, c);
    if (g === null) empty++;
    else gaps.push(g);
  }
  gaps.sort((x, y) => x - y);
  const at = (q: number) => gaps[Math.min(gaps.length - 1, Math.max(0, Math.round(q * gaps.length) - 1))];
  return { lo: at(0.025), hi: at(0.975), empty, months: months.length };
};

// The random drop: from the decided rows (N), as many as are against the trend (k) dropped at random, DRAWS
// times (a partial Fisher–Yates on 0..N−1, fresh each draw: for j < k, swap j with j + floor(r() × (N − j)));
// the mean pips of the filled trades left. The line: the 9,500th of the sorted means (1-based). `above`: how many
// of the draws' means are greater than the mean of those with the trend (written, not judged on).
export const randomDrop = (rows: readonly Row[], c: Cand, draws = DRAWS, seed = DROP_SEED): { line: number; above: number; k: number; n: number } => {
  const decided = rows.filter((r) => leanOfRow(r, c) !== "none");
  const k = decided.filter((r) => leanOfRow(r, c) === "against").length;
  const n = decided.length;
  const r = mulberry32(seed);
  const means: number[] = [];
  const idx = new Array<number>(n);
  for (let d = 0; d < draws; d++) {
    for (let j = 0; j < n; j++) idx[j] = j;
    for (let j = 0; j < k; j++) {
      const s = j + Math.floor(r() * (n - j));
      const t = idx[j];
      idx[j] = idx[s];
      idx[s] = t;
    }
    // the rows kept in their own order (by close, then by pair)
    const kept = idx.slice(k).sort((x, y) => x - y).map((j) => decided[j]).filter((x) => x.own.filled);
    const mm = mean(kept.map((x) => x.own.pips as number));
    means.push(mm === null ? NaN : mm);
  }
  const sorted = means.filter(Number.isFinite).sort((x, y) => x - y);
  const line = sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(0.95 * sorted.length) - 1))] : NaN;
  const observed = mean(decided.filter((x) => leanOfRow(x, c) === "with" && x.own.filled).map((x) => x.own.pips as number));
  return { line, above: observed === null ? 0 : sorted.filter((v) => v > observed).length, k, n };
};
