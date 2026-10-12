// #318 (docs §8.113 18 C1): donchian-A20 and donchian-A55, pure functions over a pair's mid bars.
//
// Always-hold type, from S0 on (the direction goes back to the last breakout); warm-up n bars; ※600; values
// are the rounded mids (doubles). n = 20 (A20), 55 (A55). HH = the highest high of bars i − n … i − 1, LL the
// lowest low of the same n bars (bar i is not in them). The target s (0 at first; SQ-01: 0 is a value from
// bar 0, so bar 0 is the first determined bar): at each bar i ≥ n, C[i] > HH and s ≠ +1 → s = +1; C[i] < LL
// and s ≠ −1 → s = −1; else s stays. A signal: the bar where s changed (0 → ±1 included). C = HH or C = LL
// is no breakout (strict). Checked against research/bigflow-lib.ts donchianState (20 (b)).
//
// The planted errors acting here (20 (f)): "hhIncludesI" (HH and LL over i − n + 1 … i), "formingBar" (the
// breakout judged on the next bar's close where it exists), "dropAdverse1h" (a signal dropped when the mid
// moves 13 pips against it by T + 60 minutes). And set O's answer-knowing version (SQ-11): each signal's
// direction re-set from the mid close of the newest bar closed by T + 60 minutes against E (equal: none).

import type { BarsView } from "./chartbest-bars.ts";
import { type Dir, PAIRS, SL, STEP, SPEC } from "./chartbest-const.ts";
import type { ItemCtx, ItemDef, ItemOut } from "./chartbest-events.ts";

// The target s at every bar of the view (the view starts at S0), by monotone deques: O(n)
export const donchianTarget = (v: BarsView, n: number, plant = ""): Int8Array => {
  const N = v.n;
  const s = new Int8Array(N);
  if (!SPEC.donchianTargetFromBar0) throw new Error("SQ-01: only the target from bar 0 is built");
  const hi: number[] = [];
  const lo: number[] = [];
  let hHead = 0;
  let lHead = 0;
  const incl = plant === "hhIncludesI";
  const forming = plant === "formingBar";
  let cur = 0;
  const push = (k: number) => {
    while (hi.length > hHead && v.mh[hi[hi.length - 1]] <= v.mh[k]) hi.pop();
    hi.push(k);
    while (lo.length > lHead && v.ml[lo[lo.length - 1]] >= v.ml[k]) lo.pop();
    lo.push(k);
  };
  for (let i = 0; i < N; i++) {
    if (incl) push(i);
    if (i >= n) {
      // the window: i − n … i − 1 (or i − n + 1 … i under the plant)
      const lowest = incl ? i - n + 1 : i - n;
      while (hi[hHead] < lowest) hHead++;
      while (lo[lHead] < lowest) lHead++;
      const HH = v.mh[hi[hHead]];
      const LL = v.ml[lo[lHead]];
      const c = forming && i + 1 < N ? v.mc[i + 1] : v.mc[i];
      if (c > HH && cur !== 1) cur = 1;
      else if (c < LL && cur !== -1) cur = -1;
    }
    s[i] = cur;
    if (!incl) push(i);
  }
  return s;
};

// the newest bar closed by T + 60 minutes (bar i itself when none after it is)
const newestBy60 = (v: BarsView, k: number): number => {
  const T = v.t[k] + STEP;
  let j = k;
  while (j + 1 < v.n && v.t[j + 1] + STEP <= T + 60 * 60_000) j++;
  return j;
};

export const donchianOut = (v: BarsView, n: number, ctx: ItemCtx, answerKnowing: boolean): ItemOut => {
  const target = donchianTarget(v, n, ctx.plant);
  const buy = new Int8Array(v.n);
  const sell = new Int8Array(v.n);
  for (let k = 0; k < v.n; k++) {
    buy[k] = target[k] === 1 ? 1 : 0;
    sell[k] = target[k] === -1 ? 1 : 0;
  }
  let after: ItemOut["after"];
  if (answerKnowing) {
    after = (k: number): Dir | 0 => {
      const j = newestBy60(v, k);
      const dm = v.mc[j] - v.mc[k];
      return j === k || dm === 0 ? 0 : dm > 0 ? 1 : -1;
    };
  } else if (ctx.plant === "dropAdverse1h") {
    after = (k: number, dir: Dir): Dir | 0 => {
      const E = v.mc[k];
      const T = v.t[k] + STEP;
      const pip = v.unit;
      for (let j = k + 1; j < v.n && v.t[j] + STEP <= T + 60 * 60_000; j++) {
        if (dir === 1 && v.ml[j] <= E - SL * pip) return 0;
        if (dir === -1 && v.mh[j] >= E + SL * pip) return 0;
      }
      return dir;
    };
  }
  return { buy, sell, target, after };
};

// SQ-37: C[i] within one tick of HH or LL (bars i − n … i − 1), the line the flipped run can see on the other side
export const donchianTie = (v: BarsView, i: number, n: number): boolean => {
  if (i < n) return false;
  const tick = v.unit / 10;
  let hh = -Infinity;
  let ll = Infinity;
  for (let j = i - n; j < i; j++) {
    if (v.mh[j] > hh) hh = v.mh[j];
    if (v.ml[j] < ll) ll = v.ml[j];
  }
  const c = v.mc[i];
  return Math.abs(Math.round((c - hh) / tick)) <= 1 || Math.abs(Math.round((c - ll) / tick)) <= 1;
};

const def = (id: "donchian-A20" | "donchian-A55", order: number, n: number, answerKnowing = false): ItemDef => ({
  id,
  order,
  group: "chart",
  candidate: "C1",
  pairs: PAIRS,
  kind: "always",
  window: { kind: "s0" },
  warmup: n,
  mark600: true,
  bothDirs: true,
  symmetric: true,
  symmetricWhy: "HH ↔ LL under the flip (the mids flip with the bars, C > HH becomes C′ < LL′)",
  flipTie: (v, i) => donchianTie(v, i, n),
  compute: (v, ctx) => donchianOut(v, ctx.params.n ?? n, ctx, answerKnowing),
});

export const ITEM_DONCHIAN_A20 = def("donchian-A20", 0, 20);
export const ITEM_DONCHIAN_A55 = def("donchian-A55", 1, 55);
// set O (SQ-11): donchian-A20 that knows the next hour
export const ITEM_DONCHIAN_A20_ANSWER = def("donchian-A20", 0, 20, true);
