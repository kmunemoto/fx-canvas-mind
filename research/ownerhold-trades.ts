// #205 (docs §8.102 持ち方 O): one email's order followed on GMO's 1-minute
// bars, on its own (取引ごとの見方: no account, nothing else in the way).
//
//   * The order goes at P. Inside Rakuten's daily stop [τ, τ+15 min) P moves
//     to the stop's end. At the open of the 1-minute bar starting at P, a
//     price already better than E (a BUY's ask open at or under E, a SELL's
//     bid open at or over E) is taken at the market, at that open; otherwise a
//     limit sits at E. No bar at P: the price rule at P (the close of the last
//     bar ended by P) decides, and a limit is followed from the next bar.
//   * The limit fills in the first bar after it is placed (P's own bar
//     included) whose ask low (BUY) is at or under E, or whose bid high (SELL)
//     is at or over E, at E or that bar's open where the open is better. Never
//     cancelled here.
//   * TP2 (E ± 10 pips), placed with it (IFD), for a market entry too: the
//     first bar after the entry bar whose bid high (BUY) or ask low (SELL)
//     reaches it, at TP or the bar's open where better. The entry bar's own
//     reach is counted apart, not taken. No stop, no time limit.
//   * Bars inside Rakuten's stop are not judged (no order, fill or TP); a
//     row that judges them is the supplementary one.
//
// Every read of a price goes through Px, which can rewrite the bars after a
// cut (確かめ: a decision taken at a time must not move when everything
// after it is rewritten — §8.102 先読みの確かめ).

import { MINUTE } from "./lib.ts";
import { lowerBound, upperBound } from "./money-data.ts";
import { MAINT, type M1, unitOf } from "./ownerhold-data.ts";

const B = 512;

export interface Book {
  pair: string;
  unit: number;
  m: M1;
  // 1 where the bar is inside Rakuten's stop (not judged on the main rows)
  maint: Uint8Array;
  // the stop's windows' starts (τ), sorted
  taus: Float64Array;
  // whether the stop is kept (true: the main rows) or judged through
  skipMaint: boolean;
  // the judged bars' highs and lows (a stopped bar's left out as −∞/+∞), by side, and their blocks' extremes
  jbh: Float64Array;
  jal: Float64Array;
  jbhMax: Float64Array;
  jalMin: Float64Array;
  // every bar's bid low and ask high, and their blocks', for the worst against a trade
  blMin: Float64Array;
  ahMax: Float64Array;
}

const blocksOf = (xs: Float64Array, max: boolean) => {
  const nb = Math.ceil(xs.length / B);
  const out = new Float64Array(nb);
  for (let b = 0; b < nb; b++) {
    let v = max ? -Infinity : Infinity;
    const end = Math.min(xs.length, (b + 1) * B);
    for (let j = b * B; j < end; j++) v = max ? Math.max(v, xs[j]) : Math.min(v, xs[j]);
    out[b] = v;
  }
  return out;
};

// the stop a time is in: its τ, or null
export const maintOf = (taus: Float64Array, ms: number): number | null => {
  const k = upperBound(taus, ms) - 1;
  return k >= 0 && ms < taus[k] + MAINT ? taus[k] : null;
};

export const makeBook = (m: M1, taus: Float64Array, skipMaint: boolean): Book => {
  const maint = new Uint8Array(m.n);
  for (let k = 0; k < m.n; k++) maint[k] = maintOf(taus, m.t[k]) !== null ? 1 : 0;
  const jbh = new Float64Array(m.n);
  const jal = new Float64Array(m.n);
  for (let k = 0; k < m.n; k++) {
    const out = skipMaint && maint[k] === 1;
    jbh[k] = out ? -Infinity : m.bh[k];
    jal[k] = out ? Infinity : m.al[k];
  }
  return { pair: m.pair, unit: unitOf(m.pair), m, maint, taus, skipMaint, jbh, jal, jbhMax: blocksOf(jbh, true), jalMin: blocksOf(jal, false), blMin: blocksOf(m.bl, false), ahMax: blocksOf(m.ah, true) };
};

// Rakuten's advertised spread instead of GMO's (§8.99 rakutenFine): each of a
// bar's four prices at GMO's mid ± half Rakuten's spread at the bar's open,
// GMO's own where §8.99's table has none
export const rakutenM1 = (m: M1, spreadAt: (pair: string, ms: number) => number | null): { m: M1; applied: number } => {
  const unit = unitOf(m.pair);
  const r: M1 = { pair: m.pair, n: m.n, t: m.t, bo: new Float64Array(m.n), bh: new Float64Array(m.n), bl: new Float64Array(m.n), bc: new Float64Array(m.n), ao: new Float64Array(m.n), ah: new Float64Array(m.n), al: new Float64Array(m.n), ac: new Float64Array(m.n) };
  let applied = 0;
  const sides = [["bo", "ao"], ["bh", "ah"], ["bl", "al"], ["bc", "ac"]] as const;
  for (let k = 0; k < m.n; k++) {
    const s = spreadAt(m.pair, m.t[k]);
    if (s !== null) applied++;
    for (const [b, a] of sides) {
      if (s === null) {
        r[b][k] = m[b][k];
        r[a][k] = m[a][k];
      } else {
        const mid = (m[b][k] + m[a][k]) / 2;
        r[b][k] = mid - (s * unit) / 2;
        r[a][k] = mid + (s * unit) / 2;
      }
    }
  }
  return { m: r, applied };
};

// ---- the prices, read with or without a cut --------------------------------------------------

// No cut: every bar as it is. A cut at bar K: K's open as it is, its high,
// low and close as they are only when `full`, everything later moved by
// `poison` (the rewritten future).
export interface Cut {
  k: number;
  full: boolean;
  poison: number;
}
export const NO_CUT: Cut = { k: Infinity, full: true, poison: 0 };

// the first bar at or after `from` whose value in `xs` (blocks `bx`) is at
// least `v` (high = true) or at most `v`; -1 for none
const firstReach = (xs: Float64Array, bx: Float64Array, from: number, v: number, high: boolean, cut: Cut): number => {
  const n = xs.length;
  const hit = (x: number) => (high ? x >= v : x <= v);
  const at = (j: number) => (j < cut.k || (j === cut.k && cut.full) ? xs[j] : xs[j] + cut.poison);
  let j = from;
  while (j < n) {
    const b = Math.floor(j / B);
    const start = b * B;
    const end = Math.min(n, start + B);
    if (j === start && end - 1 < cut.k) {
      // the whole block before the cut
      if (!hit(bx[b])) {
        j = end;
        continue;
      }
    } else if (j === start && start > cut.k) {
      if (!hit(bx[b] + cut.poison)) {
        j = end;
        continue;
      }
    }
    for (; j < end; j++) if (hit(at(j))) return j;
  }
  return -1;
};

// the lowest (high = false) or highest value of `xs` over [a, b]
const rangeExt = (xs: Float64Array, bx: Float64Array, a: number, b: number, high: boolean, cut: Cut): number => {
  let v = high ? -Infinity : Infinity;
  const take = (x: number) => (v = high ? Math.max(v, x) : Math.min(v, x));
  const at = (j: number) => (j < cut.k || (j === cut.k && cut.full) ? xs[j] : xs[j] + cut.poison);
  let j = a;
  while (j <= b) {
    const blk = Math.floor(j / B);
    const start = blk * B;
    const end = Math.min(xs.length, start + B);
    if (j === start && end - 1 <= b && end - 1 < cut.k) {
      take(bx[blk]);
      j = end;
      continue;
    }
    for (; j < end && j <= b; j++) take(at(j));
  }
  return v;
};

const px = (xs: Float64Array, j: number, cut: Cut, open = false) => (j < cut.k || (j === cut.k && (cut.full || open)) ? xs[j] : xs[j] + cut.poison);

// the index of the last bar ended by `ms` (-1 for none)
export const lastEnded = (m: M1, ms: number): number => upperBound(m.t, ms - MINUTE) - 1;

// ---- one order --------------------------------------------------------------------------------

export type Fill = "touch" | "through" | "exact";

export interface Order {
  dir: 1 | -1;
  E: number;
  tp: number;
  // when the email's order would go (before the stop moves it)
  P: number;
}

export interface Path {
  // when the order went (moved past Rakuten's stop), whether it moved, and whether a bar starts then
  P: number;
  shifted: boolean;
  noBar: boolean;
  // nothing at all: P at or past END (or past the data)
  none: boolean;
  // taken at the market at P (already better than E)
  market: boolean;
  // the entry bar (-1: at P without a bar; -2: not filled by END), its open (or P), the price, a better open taken
  fillK: number;
  t0: number;
  fill: number;
  fillGap: boolean;
  // the TP bar (-1: not by END), its open, the price, a better open taken; the entry bar reaching TP (not taken)
  tpK: number;
  x: number;
  exit: number;
  tpGap: boolean;
  tpInFill: boolean;
  // the worst against it, pips, from the entry bar to the TP bar or END (NaN when not filled)
  mae: number;
  // still held at END: the exit side's close of the last bar ended by END
  endPx: number;
}

export interface FollowOpts {
  fill: Fill;
  endMs: number;
  // a planted error (確かめ A 仕込んだ誤り), "" for none
  plant?: string;
  // every order at the market at P (the "if taken at the market" view of the emails not taken)
  forceMarket?: boolean;
}

// one order followed to TP or END
export const follow = (bk: Book, o: Order, opts: FollowOpts, cut: Cut = NO_CUT): Path => {
  const m = bk.m;
  const u = bk.unit;
  const buy = o.dir === 1;
  let P = o.P;
  let shifted = false;
  if (bk.skipMaint) {
    const tau = maintOf(bk.taus, P);
    if (tau !== null) {
      P = tau + MAINT;
      shifted = true;
    }
  }
  const path: Path = { P, shifted, noBar: false, none: false, market: false, fillK: -2, t0: NaN, fill: NaN, fillGap: false, tpK: -1, x: NaN, exit: NaN, tpGap: false, tpInFill: false, mae: NaN, endPx: NaN };
  if (P >= opts.endMs || m.n === 0 || P >= m.t[m.n - 1] + MINUTE) {
    path.none = true;
    return path;
  }
  let k0 = lowerBound(m.t, P);
  const noBar = !(k0 < m.n && m.t[k0] === P);
  path.noBar = noBar;
  // the order's price at P: the bar's open, or the last close ended by P
  let now: number;
  if (!noBar) {
    // planted: the order judged on the next bar's open
    const kk = opts.plant === "orderNextOpen" && k0 + 1 < m.n ? k0 + 1 : k0;
    now = buy ? px(m.ao, kk, cut, kk === k0) : px(m.bo, kk, cut, kk === k0);
  }
  else {
    const j = lastEnded(m, P);
    if (j < 0) {
      path.none = true;
      return path;
    }
    now = buy ? px(m.ac, j, cut) : px(m.bc, j, cut);
  }
  const through = opts.fill === "through" ? 0.1 * u : 0;
  let fillK: number;
  if (opts.forceMarket || (buy ? now <= o.E : now >= o.E)) {
    path.market = true;
    path.fill = now;
    if (noBar) {
      fillK = -1;
      path.t0 = P;
    } else {
      fillK = k0;
      path.t0 = m.t[k0];
    }
  } else {
    // the limit, from P's bar (or the next bar after P)
    const from = k0;
    const k = buy ? firstReach(bk.jal, bk.jalMin, from, o.E - through, false, cut) : firstReach(bk.jbh, bk.jbhMax, from, o.E + through, true, cut);
    if (k < 0 || m.t[k] + MINUTE > opts.endMs) return path;
    fillK = k;
    path.t0 = m.t[k];
    const open = buy ? px(m.ao, k, cut, true) : px(m.bo, k, cut, true);
    if (opts.plant === "fillNextBar" && k + 1 < m.n) path.fill = buy ? px(m.ao, k + 1, cut) : px(m.bo, k + 1, cut);
    else if (opts.fill !== "exact" && (buy ? open < o.E : open > o.E)) {
      path.fill = open;
      path.fillGap = true;
    } else path.fill = o.E;
  }
  path.fillK = fillK;
  // TP: from the bar after the entry bar (after P when there was none)
  if (fillK >= 0) path.tpInFill = buy ? px(m.bh, fillK, cut) >= o.tp : px(m.al, fillK, cut) <= o.tp;
  const tpFrom = fillK >= 0 ? (opts.plant === "tpInFillBar" ? fillK : fillK + 1) : k0;
  const x = buy ? firstReach(bk.jbh, bk.jbhMax, tpFrom, o.tp, true, cut) : firstReach(bk.jal, bk.jalMin, tpFrom, o.tp, false, cut);
  const lastK = lastEnded(m, opts.endMs);
  if (x >= 0 && x <= lastK) {
    path.tpK = x;
    path.x = m.t[x];
    const open = buy ? px(m.bo, x, cut, true) : px(m.ao, x, cut, true);
    if (opts.fill !== "exact" && (buy ? open > o.tp : open < o.tp)) {
      path.exit = open;
      path.tpGap = true;
    } else path.exit = o.tp;
  } else {
    path.endPx = lastK >= 0 ? (buy ? px(m.bc, lastK, cut) : px(m.ac, lastK, cut)) : NaN;
  }
  // the worst against it, from the entry bar (the first bar after P) to the TP bar or the last bar by END
  const a = fillK >= 0 ? fillK : k0;
  const b = path.tpK >= 0 ? path.tpK : lastK;
  if (a <= b) {
    const worst = buy ? rangeExt(m.bl, bk.blMin, a, b, false, cut) : rangeExt(m.ah, bk.ahMax, a, b, true, cut);
    path.mae = Math.max(0, buy ? path.fill - worst : worst - path.fill) / u;
  } else path.mae = 0;
  return path;
};

// pips of a path: out at TP, or held at END (null when never filled)
export const pipsOf = (p: Path, dir: 1 | -1, unit: number): number | null => {
  if (p.none || p.fillK === -2) return null;
  const out = p.tpK >= 0 ? p.exit : p.endPx;
  return (dir * (out - p.fill)) / unit;
};

// The trade's value at `H` (1 day or 1 week after P; §8.102 比べるもの):
// the TP's pips if its bar ended by H, the exit side's close of the last bar
// ended by H if it was filled by then, 0 if not filled. `gap`: no bar ends at
// H itself (H falls in a time without prices).
export const valueAt = (bk: Book, p: Path, dir: 1 | -1, H: number, cut: Cut = NO_CUT): { v: number; gap: boolean } => {
  const m = bk.m;
  const j = lastEnded(m, H);
  const gap = !(j >= 0 && m.t[j] + MINUTE === H);
  if (p.none || p.fillK === -2) return { v: 0, gap };
  if (p.tpK >= 0 && p.x + MINUTE <= H) return { v: (dir * (p.exit - p.fill)) / bk.unit, gap };
  const filledBy = p.fillK >= 0 ? m.t[p.fillK] + MINUTE <= H : p.t0 <= H;
  if (!filledBy || j < 0) return { v: 0, gap };
  const close = dir === 1 ? px(m.bc, j, cut) : px(m.ac, j, cut);
  return { v: (dir * (close - p.fill)) / bk.unit, gap };
};

// ---- the look-ahead check of one path ---------------------------------------------------------

// Each decision of a path taken again with everything after it rewritten
// (both ways): the order at P (P's open), the fill (its bar), the TP (its
// bar), the worst against it and the end (the last bar by END), and the value
// at each horizon. Returns how many decisions were compared and which moved.
export const lookAhead = (bk: Book, o: Order, opts: FollowOpts, p: Path, horizons: number[]): { compared: number; moved: string[] } => {
  const moved: string[] = [];
  let compared = 0;
  if (p.none) return { compared, moved };
  const m = bk.m;
  const same = (a: number, b: number) => a === b || (Number.isNaN(a) && Number.isNaN(b));
  for (const poison of [777.7 * bk.unit, -777.7 * bk.unit]) {
    // the order at P
    const k0 = lowerBound(m.t, p.P);
    const atP: Cut = p.noBar ? { k: lastEnded(m, p.P), full: true, poison } : { k: k0, full: false, poison };
    const q0 = follow(bk, o, opts, atP);
    compared++;
    if (q0.market !== p.market || (p.market && !same(q0.fill, p.fill))) moved.push(`order ${poison > 0 ? "+" : "-"}`);
    // the fill
    if (p.fillK >= 0) {
      const q = follow(bk, o, opts, { k: p.fillK, full: true, poison });
      compared++;
      if (q.fillK !== p.fillK || !same(q.fill, p.fill)) moved.push(`fill ${poison > 0 ? "+" : "-"}`);
    }
    // the TP, and the worst against it up to it
    if (p.tpK >= 0) {
      const q = follow(bk, o, opts, { k: p.tpK, full: true, poison });
      compared++;
      if (q.tpK !== p.tpK || !same(q.exit, p.exit) || !same(q.mae, p.mae) || q.tpInFill !== p.tpInFill) moved.push(`tp ${poison > 0 ? "+" : "-"}`);
    }
    // the values at the horizons
    for (const H of horizons) {
      const j = lastEnded(m, H);
      const c: Cut = { k: j, full: true, poison };
      const q = follow(bk, o, opts, c);
      const a = valueAt(bk, q, o.dir, H, c);
      const b = valueAt(bk, p, o.dir, H);
      compared++;
      if (!same(a.v, b.v)) moved.push(`value ${poison > 0 ? "+" : "-"}`);
    }
  }
  return { compared, moved };
};
