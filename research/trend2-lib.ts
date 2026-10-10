// #250 (docs §8.106 段2の作り): stage 2's own pieces — the numbers as the sentences write them (5「数の書き方の細部」),
// the four sentences of 12 の4 (all four filled from the same numbers every time, one then picked by its name), and
// each email's held value at H5 (7「1通ずつの持ち値」) with its look-ahead check (lookAheadHold).

import { MINUTE } from "./lib.ts";
import { type Book, type Cut, type Order, type Path, follow, lastEnded, valueAt } from "./ownerhold-trades.ts";
import { TRACK, lowerBound } from "./trend-stats.ts";

// ---- the numbers ------------------------------------------------------------------------------------------

// a sign on differences, interval ends and pips: "+" above 0 and at 0 (−0 too), toFixed's "-" below
export const signedFixed = (x: number, d: number): string => (!Number.isFinite(x) ? "-" : x >= 0 ? `+${(x === 0 ? 0 : x).toFixed(d)}` : x.toFixed(d));
// a share as a percentage (no sign), a share's difference as points (signed), pips (signed), t and the line
export const pctOf = (x: number): string => (Number.isFinite(x) ? (100 * x).toFixed(1) : "-");
export const ptsOf = (x: number): string => signedFixed(100 * x, 1);
export const pipsOf2 = (x: number): string => signedFixed(x, 2);
export const tOf = (x: number): string => (Number.isFinite(x) ? x.toFixed(2) : "-");

// ---- the sentences (12 の4) ----------------------------------------------------------------------------------

export interface Side3 {
  all: number;
  kept: number;
  out: number;
}
export interface SentenceIn {
  rule: string;
  weeks: number;
  // the raw means (all emails, both sides): W2, PL2, W1, PL1 (kept, all, out); B30 and v1d (all)
  W2: Side3;
  PL2: Side3;
  W1: Side3;
  PL1: Side3;
  B30all: number;
  V1Dall: number;
  // δ: W2 with its interval and t; the sides' W2 points; PL2, v1d and B30 (B30 left out − kept) with the left-out
  // and all emails of the strata used (kept − all = (N_out ÷ N_all) × δ)
  dW2: { d: number; lo: number; hi: number; t: number };
  dW2Buy: number;
  dW2Sell: number;
  dPL2: number;
  dV1D: { d: number; nOut: number; nAll: number };
  dB30: { d: number; nOut: number; nAll: number };
  // kept − all (W2, by stratum) and its interval
  keptMinusAll: { d: number; lo: number; hi: number };
  // emails a week: all, kept + unreadable (counts, divided by the weeks here)
  nAll: number;
  nKeptUnread: number;
  line: number;
  // the signs to look into that ④ hit (their names)
  triggers: string[];
}
export const SENTENCE_NAMES = ["adopt", "bad", "partBad", "cannot"] as const;
export type SentenceName = (typeof SENTENCE_NAMES)[number];

// 一部が悪い: the kinds 〈…〉 and the items（__）that missed, in the order 段2の作り 5 lists
export const partBadOf = (s: SentenceIn): { kinds: string[]; items: string[] } => {
  const items: string[] = [];
  const kinds: string[] = [];
  const pl = s.dPL2 < 0 || s.PL2.kept < s.PL2.all;
  if (s.dPL2 < 0) items.push(`δ_PL2 ${pipsOf2(s.dPL2)} pips`);
  if (s.PL2.kept < s.PL2.all) items.push(`残した PL2 ${pipsOf2(s.PL2.kept)}・全部 ${pipsOf2(s.PL2.all)} pips`);
  const tp4 = s.W1.kept < s.W1.all || s.PL1.kept < s.PL1.all;
  if (s.W1.kept < s.W1.all) items.push(`残した W1 ${pctOf(s.W1.kept)}%・全部 ${pctOf(s.W1.all)}%`);
  if (s.PL1.kept < s.PL1.all) items.push(`残した PL1 ${pipsOf2(s.PL1.kept)}・全部 ${pipsOf2(s.PL1.all)} pips`);
  const hold = s.dV1D.d < 0 || s.dB30.d < 0;
  if (s.dV1D.d < 0) items.push(`δ_v1d ${pipsOf2(s.dV1D.d)} pips`);
  if (s.dB30.d < 0) items.push(`δ_B30 ${ptsOf(s.dB30.d)}ポイント`);
  const side = !(s.dW2Buy > 0) || !(s.dW2Sell > 0);
  if (!(s.dW2Buy > 0)) items.push(`買いの δ_W2 ${ptsOf(s.dW2Buy)}ポイント`);
  if (!(s.dW2Sell > 0)) items.push(`売りの δ_W2 ${ptsOf(s.dW2Sell)}ポイント`);
  if (pl) kinds.push("1回あたりの損益");
  if (tp4) kinds.push("メールの利確4の数字");
  if (hold) kinds.push("損切りなしの1日後");
  if (side) kinds.push("買いか売りの片方");
  return { kinds, items };
};

export const sentencesOf = (s: SentenceIn, plant = ""): Record<SentenceName, string> => {
  const raw3 = (w: Side3, p: Side3, col: keyof Side3) => `${pctOf(w[col])}%・${pipsOf2(p[col])} pips`;
  const kmaB30 = s.dB30.nAll > 0 ? -(s.dB30.nOut / s.dB30.nAll) * s.dB30.d : Number.NaN;
  const kmaV1D = s.dV1D.nAll > 0 ? (s.dV1D.nOut / s.dV1D.nAll) * s.dV1D.d : Number.NaN;
  const perWeek = (n: number) => (n / s.weeks).toFixed(0);
  // planted adoptDeltaW2: the adopt sentence's points take δ W2 in place of kept − all (the Python must catch it)
  const kma = plant === "adoptDeltaW2" ? s.dW2 : s.keptMinusAll;
  const adopt =
    `選ぶのに使っていない後半（${s.weeks.toFixed(1)}週）で、${s.rule}で残したメールは、利確10が先 ${raw3(s.W2, s.PL2, "kept")}でした。` +
    `全部のメールでは ${raw3(s.W2, s.PL2, "all")}、外したメールは ${raw3(s.W2, s.PL2, "out")}です。` +
    `ペアと向きをそろえると、受け取るメールの勝率は ${ptsOf(kma.d)}ポイント（95%の幅 ${ptsOf(kma.lo)}〜${ptsOf(kma.hi)}）。ランダムに同じ数を外した場合より良い結果でした。` +
    `メールは週 約${perWeek(s.nAll)}通から約${perWeek(s.nKeptUnread)}通になります。` +
    `損切りなしで持った場合も、1日後に −30 pips 以下の割合は ${pctOf(s.B30all)}% から ${pctOf(s.B30all + kmaB30)}% になり、1日後の平均は ${pipsOf2(s.V1Dall)} pips から ${pipsOf2(s.V1Dall + kmaV1D)} pips で、悪くなっていません。` +
    `これからのメールで8週たった所で、悪くなっていないかを1回だけ確かめます（良くなったことの確かめにはなりません）。そのあと、メールを変えるかを決めてもらいます。`;
  const over = Number.isFinite(s.dW2.t) && s.dW2.t > s.line;
  const reasons = [
    ...(s.W2.kept <= s.W2.all ? ["生の数で、残したメールの W2 が全部以下でした"] : []),
    ...(s.triggers.length ? [`調べる合図（${s.triggers.join("、")}）に当たりました`] : []),
  ];
  const randomLine = over
    ? `t は ${tOf(s.dW2.t)} で、ランダムの線 ${tOf(s.line)} を越えましたが、${reasons.length ? reasons.join("。また、") : "-"}。そのため、決めた条件を満たしません。`
    : "ランダムに同じ数を外した場合と区別できませんでした。";
  const far = Math.max(Math.abs(s.dW2.lo), Math.abs(s.dW2.hi));
  const cannot =
    `後半では、${s.rule}を付けても、勝率が上がるとは言えませんでした（残した ${raw3(s.W2, s.PL2, "kept")}、全部 ${raw3(s.W2, s.PL2, "all")}、外した ${raw3(s.W2, s.PL2, "out")}）。` +
    `${randomLine}差が無いという意味ではありません。${pctOf(far)}ポイントくらいの差は、この数では見分けられません。メールは今のままです。`;
  const bad = `後半では、外したメールの方が良い結果でした（差 ${ptsOf(s.dW2.d)}ポイント、95%の幅 ${ptsOf(s.dW2.lo)}〜${ptsOf(s.dW2.hi)}）。このルールは良いメールを外す側でした。使いません。`;
  const pb = partBadOf(s);
  const partBad = `勝率は上がりましたが、${pb.kinds.join("、")}が悪くなったので、使いません（${pb.items.join("、")}）。`;
  return { adopt, bad, partBad, cannot };
};

// ---- each email's held value at H5 (7) ----------------------------------------------------------------------

export type HoldKind = "tp" | "held" | "notFilled" | "never" | "late";
export interface Hold {
  // the moved P (the path's), H5 (the end of the 1,440th 5-minute bar from the first one starting at or after it;
  // NaN when the bars read stop before)
  P: number;
  H5: number;
  kind: HoldKind;
  // counted (filled by H5 and H5 by END): the value at H5 (the exit side, or the TP's), TP by H5, −30 or worse
  v: number | null;
  b30: boolean;
}
export const holdOf = (bk: Book, p: Path, dir: 1 | -1, f5t: ArrayLike<number>, end: number, plant = ""): Hold => {
  const k = lowerBound(f5t, p.P);
  const H5 = k + TRACK - 1 < f5t.length ? f5t[k + TRACK - 1] + 5 * MINUTE : Number.NaN;
  const out = (kind: HoldKind): Hold => ({ P: p.P, H5, kind, v: null, b30: false });
  if (!(H5 <= end)) return out("late");
  if (p.none || p.fillK === -2) return out("never");
  const filledBy = p.fillK >= 0 ? bk.m.t[p.fillK] + MINUTE <= H5 : p.t0 <= H5;
  if (!filledBy) return out("notFilled");
  // planted holdAhead: the value read a minute past H5 (lookAheadHold must catch it)
  const v = valueAt(bk, p, dir, plant === "holdAhead" ? H5 + MINUTE : H5).v;
  const tp = p.tpK >= 0 && p.x + MINUTE <= H5;
  return { P: p.P, H5, kind: tp ? "tp" : "held", v, b30: v <= -30 + 1e-9 };
};
// lookAheadHold: each counted email's value at H5 again with every 1-minute bar after the last one ended by H5 moved
// ±777.7 pips (the path followed on the cut prices, valued there)
export const holdLookAhead = (bk: Book, o: Order, dir: 1 | -1, h: Hold, end: number, plant = ""): { compared: number; moved: number } => {
  if (h.v === null) return { compared: 0, moved: 0 };
  let moved = 0;
  for (const poison of [777.7 * bk.unit, -777.7 * bk.unit]) {
    const c: Cut = { k: lastEnded(bk.m, h.H5), full: true, poison };
    const q = follow(bk, o, { fill: "touch", endMs: end }, c);
    const got = valueAt(bk, q, dir, plant === "holdAhead" ? h.H5 + MINUTE : h.H5, c).v;
    if (got !== h.v) moved++;
  }
  return { compared: 2, moved };
};
