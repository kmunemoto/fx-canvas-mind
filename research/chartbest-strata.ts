// #318 (docs §8.113 8): the strata, and the blind table's bars without their outcomes (stage 0 counts with
// them and must not load the follow). Pure.
//
// The chart group's stratum: pair × direction × T's UTC hour × the season group at T; the calendar group's:
// pair × direction (the time itself is the effect looked for). Ids: chart ((pi·2 + d)·24 + hour)·4 + season,
// calendar pi·2 + d, with d 0 for BUY and 1 for SELL.
// The planted errors acting here (20 (f)): "stratumNoHour", "stratumNoSeason", "londonDstAsNy" (the season).

import { type Dir, type Half, type Layer, type Period, STEP, dirIdx } from "./chartbest-const.ts";
import { type Holes, classify } from "./chartbest-events.ts";
import { seasonOf } from "./chartbest-time.ts";

export const stratumOf = (layer: Layer, pi: number, dir: Dir, T: number, plant = ""): number => {
  const d = dirIdx(dir);
  if (layer === "cal") return pi * 2 + d;
  const hour = plant === "stratumNoHour" ? 0 : new Date(T).getUTCHours();
  const season = plant === "stratumNoSeason" ? 0 : seasonOf(T, plant);
  return ((pi * 2 + d) * 24 + hour) * 4 + season;
};
// the parts of a chart stratum id (for the dumps and the hand examples)
export const stratumParts = (s: number) => ({ season: s % 4, hour: Math.floor(s / 4) % 24, d: Math.floor(s / 96) % 2, pi: Math.floor(s / 192) });

// the bars of the blind table of a half: every bar whose T passes ① (the period only), ②, ③ and ④ for that
// half; per pair the bar indices, in time order
export const blindBarsOf = (bars: ReadonlyArray<{ t: Float64Array; n: number }>, holes: Holes, half: Half, p: Period, plant = ""): number[][] =>
  bars.map((pb, pi) => {
    const out: number[] = [];
    for (let k = 0; k < pb.n; k++) {
      const c = classify(pb, pi, k, true, holes, p, plant);
      if (c.reason === "counted" && c.half === half) out.push(k);
    }
    return out;
  });
// the strata (of a layer) holding at least one blind bar, both directions
export const blindStrataOf = (bars: ReadonlyArray<{ t: Float64Array }>, rows: number[][], layer: Layer, plant = ""): Set<number> => {
  const out = new Set<number>();
  rows.forEach((ks, pi) => {
    for (const k of ks) {
      const T = bars[pi].t[k] + STEP;
      out.add(stratumOf(layer, pi, 1, T, plant));
      out.add(stratumOf(layer, pi, -1, T, plant));
    }
  });
  return out;
};
