// #318 (docs §8.113 7, 8): the follow of a trade (tf-winrate's `follow`) and the blind table.
//
// 7: levels from E (the signal bar's rounded mid close): stop E − d·13·pip, target E + d·n·pip (n 10 the main,
// 4 the email's), in that order in doubles (ultraLevels with ULTRA_PAIRS). Entry at the signal bar's close
// (BUY the ask, SELL the bid). Followed from the first bar opening at or after T on the side it leaves on
// (BUY the bid, SELL the ask), up to 1,440 bars, comparisons with equality: an open past the stop is the
// stop at the open; else an open past the target is the target at the open; else both reached in a bar is
// the stop (amb); else the one reached, at its level. Not resolved in 1,440 bars: out at the 1,440th close.
// pips: BUY (exit − fill) ÷ pip, SELL the reverse. y: 1 the target, 0 the stop or amb, none when open.
// 8: the mirror is the same bar's other direction (its entry the other side's close, its levels from E the
// other way). The blind table of a half: every bar whose T passes ① (the period only), ②, ③, ④ for that
// half, both directions × TP4 and TP10; e of the BUY row = y10(BUY) − y10(SELL) when both are resolved,
// the SELL row's e the negative. A signal's trade is its row's; its mirror the other direction of the row.
//
// The planted errors acting here (20 (f)): "followFromSignalBar", "followLate1", "ambAsTp", "buyExitAsk",
// "usdPip001", "entryMid", "mirrorSameDir", "stage1FollowH2".

import { ULTRA_PAIRS, ultraLevels } from "../supabase/functions/_shared/ultra.ts";
import type { PairBars } from "./chartbest-bars.ts";
import { type Dir, type Half, type Period, STEP, TP_MAIL, TP_MAIN, TRACK } from "./chartbest-const.ts";
import { type Holes, classify } from "./chartbest-events.ts";
import { block4, seasonOf, wk } from "./chartbest-time.ts";

export type Kind = "tp" | "sl" | "amb" | "open";
export const KIND_LETTER: Record<Kind, string> = { tp: "t", sl: "s", amb: "a", open: "o" };
export const KIND_CODE: Record<Kind, number> = { tp: 1, sl: 2, amb: 3, open: 4 };
export const CODE_KIND: Kind[] = ["open", "tp", "sl", "amb", "open"];

export interface Sides {
  n: number;
  t: Float64Array;
  bo: Float64Array;
  bh: Float64Array;
  bl: Float64Array;
  bc: Float64Array;
  ao: Float64Array;
  ah: Float64Array;
  al: Float64Array;
  ac: Float64Array;
}
export interface Fol {
  kind: Kind;
  exit: number;
  // bars from `from` to the exit bar (1-based), and the exit bar's index
  bars: number;
  at: number;
}

// what the follows read: the newest close of a bar any follow read (h1Only), and a hook for the plants
export interface FollowCtx {
  plant: string;
  // bars closing after this may not be read (stage 1: SPLIT); a read past it is recorded
  readEnd: number;
  maxReadClose: number;
  pastReadEnd: number;
}
export const newFollowCtx = (plant: string, readEnd: number): FollowCtx => ({ plant, readEnd, maxReadClose: -Infinity, pastReadEnd: 0 });

// tf-winrate's follow (TRACK bars), on the side the trade leaves on; null when the data ends first
export const follow = (f: Sides, from: number, buy: boolean, sl: number, tp: number, ctx: FollowCtx): Fol | null => {
  // the plant "followLate1" starts one bar late; its window is cut at the data's end, so its run completes and the
  // checks that should catch it (lookahead.followFirst) speak instead of a crash on the last rows
  const last = ctx.plant === "followLate1" ? Math.min(from + TRACK - 1, f.n - 1) : from + TRACK - 1;
  if (from < 0 || last > f.n - 1) return null;
  // a SELL leaves on the ask, a BUY on the bid (the plant "buyExitAsk" takes the BUY out on the ask too)
  const exitAsk = !buy || ctx.plant === "buyExitAsk";
  const o = exitAsk ? f.ao : f.bo;
  const h = exitAsk ? f.ah : f.bh;
  const l = exitAsk ? f.al : f.bl;
  const done = (j: number, kind: Kind, exit: number): Fol => {
    const close = f.t[j] + STEP;
    if (close > ctx.maxReadClose) ctx.maxReadClose = close;
    if (close > ctx.readEnd) ctx.pastReadEnd++;
    return { kind, exit, bars: j - from + 1, at: j };
  };
  for (let j = from; j <= last; j++) {
    if (buy ? o[j] <= sl : o[j] >= sl) return done(j, "sl", o[j]);
    if (buy ? o[j] >= tp : o[j] <= tp) return done(j, "tp", o[j]);
    const hitTp = buy ? h[j] >= tp : l[j] <= tp;
    const hitSl = buy ? l[j] <= sl : h[j] >= sl;
    if (hitTp && hitSl) return ctx.plant === "ambAsTp" ? done(j, "tp", tp) : done(j, "amb", sl);
    if (hitSl) return done(j, "sl", sl);
    if (hitTp) return done(j, "tp", tp);
  }
  return done(last, "open", exitAsk ? f.ac[last] : f.bc[last]);
};

export interface Trade {
  kind: Kind;
  pips: number;
  bars: number;
  at: number;
  y: 0 | 1 | null;
}
export const yOf = (k: Kind): 0 | 1 | null => (k === "tp" ? 1 : k === "open" ? null : 0);

// the levels of a trade at E (ultraLevels: the stop 13, TP4 tps[0], TP10 tps[1])
export const levelsOf = (dir: Dir, E: number, pip: number) => ultraLevels(dir === 1 ? "BUY" : "SELL", E, pip, ULTRA_PAIRS);

// the trade of direction `dir` entered at bar i's close, followed from bar `from`, to TP4 or TP10
export const tradeOf = (f: PairBars, i: number, dir: Dir, tpPips: 4 | 10, from: number, ctx: FollowCtx, E = f.mc[i]): Trade | null => {
  const pip = ctx.plant === "usdPip001" ? 0.01 : f.unit;
  const lv = levelsOf(dir, E, pip);
  const tp = tpPips === TP_MAIL ? lv.tps[0] : lv.tps[1];
  const start = ctx.plant === "followFromSignalBar" ? i : ctx.plant === "followLate1" ? from + 1 : from;
  const fol = follow(f, start, dir === 1, lv.sl, tp, ctx);
  if (!fol) return null;
  const fill = ctx.plant === "entryMid" ? E : dir === 1 ? f.ac[i] : f.bc[i];
  const pips = (dir === 1 ? fol.exit - fill : fill - fol.exit) / pip;
  return { kind: fol.kind, pips, bars: fol.bars, at: fol.at, y: yOf(fol.kind) };
};

// ---- the blind table -----------------------------------------------------------------------------------------

export type TradeKey = "b4" | "s4" | "b10" | "s10";
export const TRADE_KEYS: readonly TradeKey[] = ["b4", "s4", "b10", "s10"];
export interface BlindPair {
  pi: number;
  n: number;
  // the bar index of each row (rows in T order)
  k: Int32Array;
  T: Float64Array;
  E: Float64Array;
  hour: Uint8Array;
  season: Uint8Array;
  week: Int32Array;
  block: Int32Array;
  kind: Record<TradeKey, Uint8Array>;
  pips: Record<TradeKey, Float64Array>;
  bars: Record<TradeKey, Uint16Array>;
  at: Record<TradeKey, Int32Array>;
  // y10(BUY) − y10(SELL): −1, 0, 1, or 2 when either is unresolved
  eBuy: Int8Array;
  // bar index → row, −1 when the bar is not in the table
  rowOfK: Int32Array;
}
export interface BlindTable {
  half: Half;
  pairs: BlindPair[];
  // W_h: the weeks holding blind bars, ascending (SQ-20)
  weeks: number[];
  maxReadClose: number;
  pastReadEnd: number;
}
export const NO_E = 2;

// the row's trade of a direction and TP: kind, pips, y
export const rowKind = (bp: BlindPair, r: number, key: TradeKey): Kind => CODE_KIND[bp.kind[key][r]];
export const rowY = (bp: BlindPair, r: number, key: TradeKey): 0 | 1 | null => yOf(rowKind(bp, r, key));
// e of a row in a direction (null: none)
export const rowE = (bp: BlindPair, r: number, dir: Dir): number | null => {
  const e = bp.eBuy[r];
  if (e === NO_E) return null;
  return dir === 1 ? e : -e;
};

export const blindTableOf = (bars: PairBars[], holes: Holes, half: Half, p: Period, plant: string, readEnd: number, seasonPlant = ""): BlindTable => {
  const ctx = newFollowCtx(plant === "stage1FollowH2" && half === "H1" ? "" : plant, readEnd);
  const weekSet = new Set<number>();
  const pairs: BlindPair[] = [];
  for (const pb of bars) {
    const rows: number[] = [];
    for (let k = 0; k < pb.n; k++) {
      const c = classify(pb, pb.pi, k, true, holes, p);
      if (c.reason === "counted" && c.half === half) rows.push(k);
    }
    const n = rows.length;
    const mk8 = () => new Uint8Array(n);
    const bp: BlindPair = {
      pi: pb.pi, n, k: Int32Array.from(rows), T: new Float64Array(n), E: new Float64Array(n), hour: mk8(), season: mk8(), week: new Int32Array(n), block: new Int32Array(n),
      kind: { b4: mk8(), s4: mk8(), b10: mk8(), s10: mk8() },
      pips: { b4: new Float64Array(n), s4: new Float64Array(n), b10: new Float64Array(n), s10: new Float64Array(n) },
      bars: { b4: new Uint16Array(n), s4: new Uint16Array(n), b10: new Uint16Array(n), s10: new Uint16Array(n) },
      at: { b4: new Int32Array(n), s4: new Int32Array(n), b10: new Int32Array(n), s10: new Int32Array(n) },
      eBuy: new Int8Array(n), rowOfK: new Int32Array(pb.n).fill(-1),
    };
    rows.forEach((k, r) => {
      const T = pb.t[k] + STEP;
      bp.rowOfK[k] = r;
      bp.T[r] = T;
      bp.E[r] = pb.mc[k];
      bp.hour[r] = new Date(T).getUTCHours();
      bp.season[r] = seasonOf(T, seasonPlant);
      bp.week[r] = wk(T);
      bp.block[r] = block4(T, half, p);
      weekSet.add(bp.week[r]);
      for (const key of TRADE_KEYS) {
        const dir: Dir = key[0] === "b" ? 1 : -1;
        const tr = tradeOf(pb, k, dir, key.endsWith("10") ? TP_MAIN : TP_MAIL, k + 1, ctx);
        if (!tr) throw new Error(`${pb.pair} bar ${k}: a blind row without its ${TRACK} bars`);
        bp.kind[key][r] = { tp: 1, sl: 2, amb: 3, open: 4 }[tr.kind];
        bp.pips[key][r] = tr.pips;
        bp.bars[key][r] = tr.bars;
        bp.at[key][r] = tr.at;
      }
      const yb = rowY(bp, r, "b10");
      const ys = rowY(bp, r, "s10");
      // the plant "mirrorSameDir": the mirror taken in the signal's own direction (e always 0)
      bp.eBuy[r] = yb === null || ys === null ? NO_E : plant === "mirrorSameDir" ? 0 : yb - ys;
    });
    pairs.push(bp);
  }
  // the plant "stage1FollowH2": stage 1 also follows the second half's bars (h1Only must catch it)
  if (plant === "stage1FollowH2" && half === "H1") {
    for (const pb of bars) {
      for (let k = 0; k < pb.n; k++) {
        const c = classify(pb, pb.pi, k, true, holes, p);
        if (c.reason === "counted" && c.half === "H2") {
          tradeOf(pb, k, 1, TP_MAIN, k + 1, ctx);
          break;
        }
      }
    }
  }
  return { half, pairs, weeks: [...weekSet].sort((a, b) => a - b), maxReadClose: ctx.maxReadClose, pastReadEnd: ctx.pastReadEnd };
};

// the row of a signal (pair, bar), or −1
export const rowOf = (bt: BlindTable, pi: number, k: number): number => {
  const bp = bt.pairs.find((x) => x.pi === pi);
  if (!bp || k < 0 || k >= bp.rowOfK.length) return -1;
  return bp.rowOfK[k];
};
export const pairOf = (bt: BlindTable, pi: number): BlindPair => {
  const bp = bt.pairs.find((x) => x.pi === pi);
  if (!bp) throw new Error(`blind table: no pair ${pi}`);
  return bp;
};
