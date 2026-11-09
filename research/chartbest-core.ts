// #318 (docs §8.113 2, 5, 6, 10): a run's bars and every source's signals (the items and the two emails),
// before any outcome. Stage 0 reads only this (no follow).

import type { QuoteCandle } from "../supabase/functions/track-outcomes/quotes.ts";
import type { M1 } from "./ownerhold-data.ts";
import { type PairBars, pairBarsOf } from "./chartbest-bars.ts";
import { type Dir, type MeasureId, PAIRS, type Period, STEP, srcOrder } from "./chartbest-const.ts";
import { type Holes, type ItemDef, type SigRec, eventsOf, holesOf, recordsOf, sigOrder } from "./chartbest-events.ts";
import { type LoadDiag, type Src, loadBars, minuteWithoutFive } from "./chartbest-data.ts";
import { type LateSig, macdCands, ultraCands } from "./chartbest-measures.ts";

export interface Prefilter {
  bothSuppressed: number;
  firstSkipped: number;
  nullPrevSkipped: number;
  late: number;
}
export interface SourceSigs {
  src: string;
  measure: MeasureId | null;
  def: ItemDef | null;
  // every candidate, classified (all pairs, the dumps' order)
  recs: SigRec[];
  prefilter: Prefilter[];
  // the T of each both-direction suppression (stage 0 splits them by half)
  suppressedT: number[];
  late: LateSig[];
}
export interface RunBars {
  period: Period;
  bars: PairBars[];
  quotes: QuoteCandle[][] | null;
  m1: M1[] | null;
  holes: Holes;
  diags: LoadDiag[];
  // 20 (a): 5-minute slots with a minute bar but no 5-minute bar (full runs)
  minuteNoFive: number | null;
}

// the bars of a run from a folder of day files (5-minute; 1-minute too in full runs)
export const loadRun = async (src: Src, period: Period, madeUp: boolean, minutes: boolean, keepQuotes: boolean): Promise<RunBars> => {
  const bars: PairBars[] = [];
  const quotes: QuoteCandle[][] = [];
  const m1s: M1[] = [];
  const diags: LoadDiag[] = [];
  let minuteNoFive: number | null = minutes ? 0 : null;
  for (const [pi, pair] of PAIRS.entries()) {
    const five = await loadBars(src, pair, "5min", period, madeUp);
    diags.push(five.diag);
    const pb = pairBarsOf(pair, pi, five.quotes, period.end);
    bars.push(pb);
    if (keepQuotes) quotes.push(five.quotes);
    if (minutes) {
      const one = await loadBars(src, pair, "1min", period, madeUp);
      diags.push(one.diag);
      const { m1Of } = await import("./chartbest-data.ts");
      const m = m1Of(pair, one.quotes);
      m1s.push(m);
      minuteNoFive = (minuteNoFive ?? 0) + minuteWithoutFive(m.t, pb.t);
    }
  }
  return { period, bars, quotes: keepQuotes ? quotes : null, m1: minutes ? m1s : null, holes: holesOf(bars, period), diags, minuteNoFive };
};

export const ITEM_CTX = (plant: string) => ({ plant, params: {} as Record<string, number> });

// the signals of one item on every pair it is defined for
export const itemSigs = (def: ItemDef, rb: RunBars, plant: string): SourceSigs => {
  const recs: SigRec[] = [];
  const prefilter: Prefilter[] = PAIRS.map(() => ({ bothSuppressed: 0, firstSkipped: 0, nullPrevSkipped: 0, late: 0 }));
  const suppressedT: number[] = [];
  for (const pb of rb.bars) {
    if (!def.pairs.includes(pb.pair)) continue;
    const ev = eventsOf(def, pb, ITEM_CTX(plant));
    prefilter[pb.pi] = { bothSuppressed: ev.bothSuppressed, firstSkipped: ev.firstSkipped, nullPrevSkipped: ev.nullPrevSkipped, late: 0 };
    for (const T of ev.suppressedT) suppressedT.push(T);
    recs.push(...recordsOf(pb, ev.cands, def.warmup, rb.holes, rb.period, plant));
  }
  recs.sort(sigOrder(srcOrder));
  return { src: def.id, measure: null, def, recs, prefilter, suppressedT, late: [] };
};

// the two emails' signals (warm-up 0; a bar under 599 never signals)
export const measureSigs = (id: MeasureId, rb: RunBars, plant: string): SourceSigs & { raw: Array<ReturnType<typeof ultraCands> | ReturnType<typeof macdCands>> } => {
  const recs: SigRec[] = [];
  const prefilter: Prefilter[] = PAIRS.map(() => ({ bothSuppressed: 0, firstSkipped: 0, nullPrevSkipped: 0, late: 0 }));
  const late: LateSig[] = [];
  const raw: Array<ReturnType<typeof ultraCands> | ReturnType<typeof macdCands>> = [];
  for (const pb of rb.bars) {
    const m = id === "ultra5" ? ultraCands(pb) : macdCands(pb);
    raw.push(m);
    prefilter[pb.pi].late = m.late.length;
    late.push(...m.late);
    recs.push(...recordsOf(pb, m.cands, 0, rb.holes, rb.period, plant));
  }
  recs.sort(sigOrder(srcOrder));
  return { src: id, measure: id, def: null, recs, prefilter, suppressedT: [], late, raw };
};

export const dirOf = (side: "BUY" | "SELL"): Dir => (side === "BUY" ? 1 : -1);
export const closeOf = (pb: PairBars, i: number): number => pb.t[i] + STEP;
