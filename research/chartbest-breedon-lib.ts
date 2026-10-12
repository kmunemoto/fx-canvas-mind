// #318 (docs §8.113 18 K1): breedon-1 and breedon-2, pure functions over EUR/USD's bars.
//
// Condition type (by the clock); a finite window of 2 bars (bar i − 1 is a bar not judged: false); warm-up 0;
// no price is used, only the time and whether the bar is there. America/New_York's clock, the New York date D
// Monday to Friday. breedon-1: the 5-minute bar opening at 02:55 New York (07:55 UTC in winter, 06:55 in
// summer) is there → SELL at its close (03:00 New York). breedon-2: the bar opening at 10:55 → BUY at 11:00.
// No bar → no signal that day (counted, with the dates; never moved to the next bar). Holidays too, when the
// bar is there. Mark: the days New York is on summer time and London on winter time (the shifted weeks) are
// counted. Not symmetric under the flip: the side is fixed by the clock.

import type { BarsView, PairBars } from "./chartbest-bars.ts";
import { type Dir, type Half, type Period, STEP } from "./chartbest-const.ts";
import type { ItemDef, ItemOut } from "./chartbest-events.ts";
import { nyLocal, nyToUtc, seasonOf } from "./chartbest-time.ts";

export type BreedonWhich = 1 | 2;
// the local time of the bar's open, and the signal's direction
export const BREEDON: Record<BreedonWhich, { hour: number; minute: number; dir: Dir }> = {
  1: { hour: 2, minute: 55, dir: -1 },
  2: { hour: 10, minute: 55, dir: 1 },
};

// is bar k the expected bar of a New York weekday?
export const breedonCond = (t: number, which: BreedonWhich): boolean => {
  const ny = nyLocal(t);
  const w = BREEDON[which];
  return ny.weekday >= 1 && ny.weekday <= 5 && ny.hour === w.hour && ny.minute === w.minute;
};

export const breedonOut = (v: BarsView, which: BreedonWhich, plant = ""): ItemOut => {
  const w = BREEDON[which];
  const on = new Int8Array(v.n);
  const off = new Int8Array(v.n);
  for (let k = 0; k < v.n; k++) on[k] = breedonCond(v.t[k], which) ? 1 : 0;
  return {
    buy: w.dir === 1 ? on : off,
    sell: w.dir === 1 ? off : on,
    marks: (k: number) => (seasonOf(v.t[k] + STEP, plant) === 2 ? ["shiftedWeek"] : []),
  };
};

const def = (which: BreedonWhich): ItemDef => ({
  id: `breedon-${which}`,
  order: which === 1 ? 52 : 53,
  group: "cal",
  candidate: "K1",
  pairs: ["EUR/USD"],
  kind: "condition",
  window: { kind: "finite", L: 2 },
  warmup: 0,
  mark600: false,
  bothDirs: false,
  symmetric: false,
  // 20 (e) 裏返し: the reason printed with the non-symmetric items (each item its own side and hour)
  symmetricWhy: which === 1
    ? "the side is fixed by the clock: the flip keeps a SELL at 03:00 New York a SELL"
    : "the side is fixed by the clock: the flip keeps a BUY at 11:00 New York a BUY",
  compute: (v, ctx) => breedonOut(v, which, ctx.plant),
});
export const ITEM_BREEDON_1 = def(1);
export const ITEM_BREEDON_2 = def(2);

// 11 / 18 「数を出す」: the New York weekdays whose expected bar is missing (by the half its T would be in),
// with their dates, and the shifted-week signals
export interface BreedonExtra {
  missing: Record<Half, string[]>;
}
export const breedonMissing = (pb: PairBars, which: BreedonWhich, p: Period): BreedonExtra => {
  const w = BREEDON[which];
  const have = new Set<number>();
  for (let k = 0; k < pb.n; k++) have.add(pb.t[k]);
  const out: BreedonExtra = { missing: { H1: [], H2: [] } };
  // every New York date from the day before START to END
  let date = nyLocal(p.start - 36 * 3_600_000).date;
  for (let g = 0; g < 2000; g++) {
    const open = nyToUtc(date, w.hour, w.minute);
    const T = open + STEP;
    if (T >= p.end) break;
    const wd = new Date(`${date}T12:00:00Z`).getUTCDay();
    if (T >= p.start && wd >= 1 && wd <= 5 && !have.has(open)) out.missing[T < p.split ? "H1" : "H2"].push(date);
    date = new Date(Date.parse(`${date}T12:00:00Z`) + 24 * 3_600_000).toISOString().slice(0, 10);
  }
  return out;
};
