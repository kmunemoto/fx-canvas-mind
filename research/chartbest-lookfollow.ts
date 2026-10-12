// #318 (docs §8.113 20 (b) 追う足〔段1・段2〕, h1Only〔段1〕): the follow's own look-ahead checks.
//
// 100 signals per item and pair (mulberry32 seed 319; stage 1 the first half's counted signals, stage 2 the
// chosen items' second-half ones), their record fixed (T, direction, E, the entry, the levels); the follow
// called again for the signal and its mirror:
// (i) every bar closed by T (the newest 300, the signal bar included) moved ±777.7 pips in turn, both sides,
//     OHLC: not one outcome may change (y4, y10, the kind, amb, open, pips);
// (ii) the first bar after T moved +777.7 or −777.7 pips (in turn by signal), both sides: every trade decides
//     at that bar's open (a BUY at its target on +, its stop on −; a SELL the reverse), and its pips change.
// h1Only: stage 1 followed nothing whose T is at or after SPLIT and read no bar closing after SPLIT.

import { type PairBars, withSides } from "./chartbest-bars.ts";
import { type Dir, POISON_PIPS, SAMPLE, SEED, TP_MAIL, TP_MAIN } from "./chartbest-const.ts";
import type { SigRec } from "./chartbest-events.ts";
import { type FollowCtx, type Trade, newFollowCtx, tradeOf } from "./chartbest-follow.ts";
import { sampleOf } from "./chartbest-lookahead.ts";
import type { Probe } from "./chartbest-measures.ts";

const newProbe = (): Probe => ({ compared: 0, mismatched: 0, examples: [] });
const bad = (p: Probe, what: string) => {
  p.mismatched++;
  if (p.examples.length < 10) p.examples.push(what);
};
const iso = (t: number) => new Date(t).toISOString().slice(0, 16);

const four = (pb: PairBars, i: number, dir: Dir, ctx: FollowCtx): Array<Trade | null> => {
  const other: Dir = dir === 1 ? -1 : 1;
  return [tradeOf(pb, i, dir, TP_MAIL, i + 1, ctx), tradeOf(pb, i, dir, TP_MAIN, i + 1, ctx), tradeOf(pb, i, other, TP_MAIL, i + 1, ctx), tradeOf(pb, i, other, TP_MAIN, i + 1, ctx)];
};
const same = (a: Trade | null, b: Trade | null): boolean => !!a && !!b && a.kind === b.kind && a.y === b.y && a.pips === b.pips && a.bars === b.bars;

// the signals followed: 100 per item and pair
export const followSample = (recs: SigRec[], pi: number): SigRec[] => sampleOf(recs.filter((r) => r.pi === pi), SAMPLE.follow, SEED.poison);

export const followFixedCheck = (pb: PairBars, sigs: SigRec[], plant: string): Probe => {
  const pr = newProbe();
  for (const s of sigs) {
    const ctx0 = newFollowCtx(plant, Infinity);
    const base = four(pb, s.i, s.dir, ctx0);
    const q = withSides(pb, (x) => {
      for (let k = s.i, m = 0; k >= 0 && m < 300; k--, m++) {
        const d = (m % 2 === 0 ? 1 : -1) * POISON_PIPS * pb.unit;
        for (const key of ["bo", "bh", "bl", "bc", "ao", "ah", "al", "ac"] as const) x[key][k] += d;
      }
    });
    // the record fixed: E and the entry from the bars as they were
    const got = [s.dir, s.dir, -s.dir as Dir, -s.dir as Dir].map((d, j) => {
      const fixed: PairBars = { ...q, mc: pb.mc, ac: Float64Array.from(q.ac), bc: Float64Array.from(q.bc) };
      fixed.ac[s.i] = pb.ac[s.i];
      fixed.bc[s.i] = pb.bc[s.i];
      return tradeOf(fixed, s.i, d, j % 2 === 0 ? TP_MAIL : TP_MAIN, s.i + 1, newFollowCtx(plant, Infinity), pb.mc[s.i]);
    });
    pr.compared++;
    if (!base.every((b, j) => same(b, got[j]))) bad(pr, `${pb.pair} ${iso(pb.t[s.i])}: an outcome changed with the bars before T poisoned`);
  }
  return pr;
};

export const followFirstCheck = (pb: PairBars, sigs: SigRec[], plant: string): Probe => {
  const pr = newProbe();
  sigs.forEach((s, n) => {
    if (s.i + 1 >= pb.n) return;
    const sign = n % 2 === 0 ? 1 : -1;
    const base = four(pb, s.i, s.dir, newFollowCtx(plant, Infinity));
    const q = withSides(pb, (x) => {
      const d = sign * POISON_PIPS * pb.unit;
      for (const key of ["bo", "bh", "bl", "bc", "ao", "ah", "al", "ac"] as const) x[key][s.i + 1] += d;
    });
    const fixed: PairBars = { ...q, mc: pb.mc, ac: pb.ac, bc: pb.bc };
    const dirs: Dir[] = [s.dir, s.dir, -s.dir as Dir, -s.dir as Dir];
    pr.compared++;
    dirs.forEach((d, j) => {
      const got = tradeOf(fixed, s.i, d, j % 2 === 0 ? TP_MAIL : TP_MAIN, s.i + 1, newFollowCtx(plant, Infinity), pb.mc[s.i]);
      // decided at bar i + 1's open: a BUY wins on +, a SELL on −
      const want = (d === 1) === (sign === 1) ? "tp" : "sl";
      if (!got || got.kind !== want || got.at !== s.i + 1 || got.pips === base[j]?.pips) bad(pr, `${pb.pair} ${iso(pb.t[s.i])} ${d === 1 ? "BUY" : "SELL"} TP${j % 2 === 0 ? 4 : 10}: ${got ? `${got.kind} at ${got.at - s.i} pips ${got.pips}` : "none"} (want ${want} at 1)`);
    });
  });
  return pr;
};

// h1Only: the first half's follows read nothing past SPLIT, and no followed T is at or after it
export const h1OnlyCheck = (maxReadClose: number, pastReadEnd: number, followedT: number[], split: number): Probe => {
  const pr = newProbe();
  pr.compared = followedT.length + 1;
  if (maxReadClose > split || pastReadEnd > 0) bad(pr, `a bar closing ${iso(maxReadClose)} read (${pastReadEnd} reads past SPLIT)`);
  for (const T of followedT) if (T >= split) bad(pr, `a trade at ${iso(T)} followed in stage 1`);
  return pr;
};
