// #378 (docs §8.125): hand examples of research/pbz-lib.ts, each with the answer worked out by hand.
// deno run research/pbz-hand.ts — exits 1 on the first example that does not hold.

import { type Mark, type PbBar, type PbMail, type Row, bootstrap, candidateAt, mailsOf, marksAtSlow, oppositeOf, pushMark, rankOf, readsOf, testsAt, tradeOf } from "./pbz-lib.ts";
import { mulberry32 } from "./flowz-lib.ts";
import type { M1 } from "./ownerhold-data.ts";
import { makeBook } from "./ownerhold-trades.ts";
import { HOUR, MINUTE } from "./lib.ts";

let failed = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
};
const T0 = Date.UTC(2024, 2, 4, 0); // Mon 2024-03-04 00:00 UTC
const barsOf = (hl: Array<[number, number]>, t0 = T0): PbBar[] => hl.map(([hi, lo], i) => ({ t: t0 + i * HOUR, hi, lo, close: (hi + lo) / 2 }));
const flat = (n: number): Array<[number, number]> => Array.from({ length: n }, () => [10, 9]);
const brief = (ms: PbMail[]) => ms.map((m) => [m.cand, m.k, m.side, m.mark.i]);
const inM = (final: Mark[], m: PbMail) => final.some((x) => x.i === m.mark.i && x.kind === m.mark.kind);

// 1-minute bars (USD/JPY) for some hours of a hand series: [hour index, minute, bid high, bid low, bid close]; the
// bid open is the close, the ask the bid + 0.01
const minutesOf = (bars: PbBar[], rows: Array<[number, number, number, number, number]>): M1 => {
  const t = rows.map(([i, mi]) => bars[i].t + mi * MINUTE);
  const f = (k: number, add = 0) => new Float64Array(rows.map((r) => r[k] + add));
  return { pair: "USD/JPY", n: rows.length, t: new Float64Array(t), bo: f(4), bh: f(2), bl: f(3), bc: f(4), ao: f(4, 0.01), ah: f(2, 0.01), al: f(3, 0.01), ac: f(4, 0.01) };
};

// 1. the two tests: strictly above the 10 before, at least the later ones; the right edge; too few bars before
{
  // bar 10: high 12 over the ten highs of 10 before it; later highs 11, 12 (equal), 9 ...
  const b = barsOf([...flat(10), [12, 9.5], [11, 9.5], [12, 9.5], [9, 8]]);
  check("peak: above the 10 before and equal to a later high", candidateAt(b, 10, 13), "peak");
  check("not a peak: equal to the highest of the 10 before (bar 12: the 10 before hold bar 10's 12)", candidateAt(b, 12, 13), null);
  const c = barsOf([...flat(10), [12, 9.5], [12.5, 9.5]]);
  check("not a peak: a later high above it", candidateAt(c, 10, 11), null);
  check("the right edge: bar 11 with no later bar, against the 10 before only", candidateAt(c, 11, 11), "peak");
  check("the right edge: bar 10 judged with the bars up to 10 only", candidateAt(c, 10, 10), "peak");
  check("too few bars before: bar 9", candidateAt(barsOf([...flat(9), [12, 9.5]]), 9, 9), null);
  // bottoms: strictly under the 10 lows before, at most the later lows
  const d = barsOf([...flat(10), [10, 8], [10, 8], [10, 8.5]]);
  check("bottom: under the 10 before, equal to a later low", candidateAt(d, 10, 12), "bottom");
  check("not a bottom: equal to the lowest of the 10 before", candidateAt(d, 11, 12), null);
  // an outside bar: both tests pass, counted a peak
  const e = barsOf([...flat(10), [12, 7]]);
  check("both tests pass", testsAt(e, 10, 10), { peak: true, bottom: true });
  check("both: a peak", candidateAt(e, 10, 10), "peak");
  // the bars are counted by their place, not by the clock: a 3-hour hole between bars 4 and 5 changes nothing
  const holed = b.map((x, i) => ({ ...x, t: x.t + (i >= 5 ? 3 * HOUR : 0) }));
  check("a weekday hole: counted by place", [candidateAt(holed, 10, 13), candidateAt(holed, 12, 13)], ["peak", null]);
}

// 2. the alternation: the same kind keeps the higher peak / the lower bottom, a tie the older; the other kind added
{
  const L: Mark[] = [];
  pushMark(L, { i: 1, kind: "peak", price: 10 });
  pushMark(L, { i: 2, kind: "peak", price: 10 });
  check("two peaks of the same price: the older stays", L.map((m) => m.i), [1]);
  pushMark(L, { i: 3, kind: "peak", price: 11 });
  check("a higher peak replaces it", L.map((m) => m.i), [3]);
  pushMark(L, { i: 4, kind: "bottom", price: 8 });
  pushMark(L, { i: 5, kind: "bottom", price: 8.5 });
  check("a higher bottom after a bottom: dropped", L.map((m) => m.i), [3, 4]);
  pushMark(L, { i: 6, kind: "bottom", price: 7 });
  check("a lower bottom replaces it", L.map((m) => m.i), [3, 6]);
}

// 3. M_k on a hand series, and the emails A, B and C (worked out by hand in the comments)
//   0..9 flat (high 10, low 9); 10 peak 12; 11..15 falling to the low 7 at 15; 16..20 rising; 21 peak 13; 22..24 at 12
const S: Array<[number, number]> = [
  ...flat(10),
  [12, 9.5], [11, 9], [10.5, 8.5], [10, 8], [9.5, 7.5], [9, 7], [9.5, 7.5], [10, 8], [10.5, 8.5], [11, 9], [11.5, 9.5], [13, 10], [12, 10], [12, 10], [12, 10],
];
{
  const b = barsOf(S);
  const { reads, final } = readsOf(b);
  check("M at the last bar: peak 10, bottom 15, peak 21", final.map((m) => [m.i, m.kind, m.price]), [[10, "peak", 12], [15, "bottom", 7], [21, "peak", 13]]);
  check("M at the last bar from scratch is the same", marksAtSlow(b, 24), final);
  check("M_9: no mark (no bar has 10 before it)", reads[9].newest, null);
  check("M_10: the provisional peak on 10", reads[10].newest, { i: 10, kind: "peak", price: 12 });
  // at 12 the low 8.5 is under the 10 lows before (9): a provisional bottom; at 13 it moves to 13 (8), and so on
  check("M_12: a provisional bottom on 12", reads[12].newest, { i: 12, kind: "bottom", price: 8.5 });
  check("M_13: the bottom moved to 13", reads[13].newest, { i: 13, kind: "bottom", price: 8 });
  check("M_15..20: the bottom on 15", [15, 16, 17, 18, 19, 20].map((k) => reads[k].newest?.i), [15, 15, 15, 15, 15, 15]);
  check("M_20 holds the mark on bar 10 (= 20 − 10)", reads[20].fixedHere, true);
  check("M_19 does not fire A (bar 9 holds no mark)", reads[19].fixedHere, false);
  check("the fixed part's last mark after 20: the peak on 10", reads[20].fixedLast, { i: 10, kind: "peak", price: 12 });
  for (const k of [10, 12, 13, 20, 21, 24]) check(`M_${k} fast = from scratch`, reads[k].newest, marksAtSlow(b, k).at(-1) ?? null);

  // the emails on a Monday, without 1-minute bars: B on 10 (SELL), B on 12 (BUY), A on 20 (SELL, the mark on 10),
  // B on 21 (SELL)
  const out = mailsOf("USD/JPY", b, reads, null, T0, T0 + 100 * HOUR);
  check("emails: B 10 SELL, B 12 BUY, A 20 SELL (mark 10), B 21 SELL (mark 21)", brief(out.mails), [["B", 10, "SELL", 10], ["B", 12, "BUY", 12], ["A", 20, "SELL", 10], ["B", 21, "SELL", 21]]);
  check("no B when the bottom moves (13, 14, 15)", out.mails.filter((m) => [13, 14, 15].includes(m.k)).length, 0);
  check("E is bar k's mid close; T its close", [out.mails[0].E, out.mails[0].T], [b[10].close, b[10].t + HOUR]);
  check("which marks stay at the last bar: 10 yes, 12 no (moved to 15), 10 yes, 21 yes", out.mails.map((m) => inM(final, m)), [true, false, true, true]);
  check("the A email carries the mark's bar open", out.mails[2].markOpen, b[10].t);

  // C, with 1-minute bars inside bars 10, 12 and 13 (consistent with the hourly highs and lows):
  //   bar 10 [12, 9.5]: minute 0 high 10.0 (not over the 10 highs before, 10), minute 1 high 11 → a peak on 10:
  //     C SELL at minute 1's close, E its mid close (10.8 + 10.81) / 2 = 10.805; minute 2 reaches 12 (no second C)
  //   bar 12 [10.5, 8.5]: minute 0 low 9.2 (not under 9), minute 1 low 8.9 → a bottom on 12, M_11's newest a peak:
  //     C BUY at minute 1's close (9.0 + 9.01) / 2 = 9.005, the mark's price the low so far 8.9
  //   bar 13 [10, 8]: minute 0 low 8.2 under the 10 lows before (8.5) → a bottom on 13, but M_12's newest is a
  //     bottom too: no C (the bottom moved)
  const m1 = minutesOf(b, [
    [10, 0, 10.0, 9.6, 9.9], [10, 1, 11.0, 9.5, 10.8], [10, 2, 12.0, 9.7, 11.5],
    [12, 0, 10.4, 9.2, 9.5], [12, 1, 10.5, 8.9, 9.0], [12, 2, 10.0, 8.5, 8.6],
    [13, 0, 9.8, 8.2, 8.4], [13, 1, 10.0, 8.0, 8.1],
  ]);
  const o2 = mailsOf("USD/JPY", b, reads, m1, T0, T0 + 100 * HOUR);
  const cs = o2.mails.filter((m) => m.cand === "C");
  check("C: SELL on 10 and BUY on 12, none on 13", brief(cs), [["C", 10, "SELL", 10], ["C", 12, "BUY", 12]]);
  check("C: at the close of the minute it fired in", cs.map((m) => (m.T - b[m.k].t) / MINUTE), [2, 2]);
  check("C: E the minute's mid close, rounded to 3", cs.map((m) => m.E), [10.805, 9.005]);
  check("C: the mark's price as the bar stood then", cs.map((m) => m.mark.price), [11, 8.9]);
  check("C: the hourly highs and lows agree with the minutes (3 bars seen), none vanished", [o2.cBarDiff, o2.cBarsSeen, o2.cVanished], [0, 3, 0]);
  check("C: B and A as before", brief(o2.mails.filter((m) => m.cand !== "C")), brief(out.mails));

  // the same series from Friday 08:00 UTC: bar 10 closes Fri 19:00 (mailed); 12 closes Fri 21:00 (closed: the
  // earliest close); 20 and 21 close on Saturday (closed)
  const fri = barsOf(S, Date.UTC(2024, 2, 8, 8));
  const o3 = mailsOf("USD/JPY", fri, readsOf(fri).reads, null, fri[0].t, fri[0].t + 100 * HOUR);
  check("Friday: only B on 10 mailed; closed A 1, B 2", [brief(o3.mails), o3.closed], [[["B", 10, "SELL", 10]], { A: 0 + 1, B: 2, C: 0 }]);
  check("emails before the period's start are not counted", mailsOf("USD/JPY", b, reads, null, b[13].t + HOUR, T0 + 100 * HOUR).mails.map((m) => m.k), [20, 21]);
  // a gap of a day or more before bar 12: its emails are the first after a gap
  const gapped = b.map((x, i) => ({ ...x, t: x.t + (i >= 12 ? 49 * HOUR : 0) }));
  const o4 = mailsOf("USD/JPY", gapped, readsOf(gapped).reads, null, T0, T0 + 200 * HOUR);
  check("the first bar after a 49-hour gap is marked", o4.mails.map((m) => [m.k, m.weekFirst]), [[10, false], [12, true], [20, false], [21, false]]);
}

// 4. a B decided on an outside bar (both: a peak, SELL) whose bar is a bottom in M at the last bar; and C on it
{
  // bar 10 [12, 7] is both (a peak, B SELL); bar 11 [13, 8] puts a higher high after it: bar 10 is then a bottom
  // (its low 7 under the 10 before and at most the later 8), and bar 11 a peak. M_11's newest is a peak, as M_10's:
  // no B on 11.
  const b = barsOf([...flat(10), [12, 7], [13, 8]]);
  const { reads, final } = readsOf(b);
  const out = mailsOf("USD/JPY", b, reads, null, T0, T0 + 100 * HOUR);
  check("both: B SELL on 10, decided both; none on 11", out.mails.map((m) => [m.cand, m.k, m.side, m.both]), [["B", 10, "SELL", true]]);
  check("M at the last bar: a bottom on 10, a peak on 11", final.map((m) => [m.i, m.kind]), [[10, "bottom"], [11, "peak"]]);
  check("the B's mark (a peak on 10) is not in M at the end; the same bar is, of the other kind", [inM(final, out.mails[0]), final.some((x) => x.i === 10 && x.kind === "bottom")], [false, true]);
  // C on bar 10: minute 0 [9.8, 7] — the low first: a bottom (BUY); minute 1 reaches 12: both, a peak. At the close
  // bar 10 is a peak: the C's bottom vanished.
  const m1 = minutesOf(b, [[10, 0, 9.8, 7.0, 7.5], [10, 1, 12.0, 7.2, 11.0]]);
  const o2 = mailsOf("USD/JPY", b, reads, m1, T0, T0 + 100 * HOUR);
  check("C BUY on 10 at minute 0, then vanished; B SELL at the close", [o2.mails.map((m) => [m.cand, m.side]), o2.cVanished], [[["B", "SELL"], ["C", "BUY"]], 1]);
}

// 5. an A whose mark is replaced later (a higher peak with no bottom between), and A and B on the same bar
{
  // bar 10 peak 12; bars 11..20 [11.5, 9.2] (no new high, no new low); bar 21 [12.5, 9.3] a higher peak: it replaces
  // the peak on 10, which A mailed at 20
  const b = barsOf([...flat(10), [12, 9.5], ...Array.from({ length: 10 }, (): [number, number] => [11.5, 9.2]), [12.5, 9.3]]);
  const { reads, final } = readsOf(b);
  const out = mailsOf("USD/JPY", b, reads, null, T0, T0 + 100 * HOUR);
  check("B on 10, A on 20 (mark 10), no B on 21 (a peak after a peak)", brief(out.mails), [["B", 10, "SELL", 10], ["A", 20, "SELL", 10]]);
  check("M at the end: the peak on 21 only; A's mark gone", [final.map((m) => m.i), inM(final, out.mails[1])], [[21], false]);
  // bar 10 peak 12; bars 11..19 [11, 9.1]; bar 20 [10, 8.5] a new low (under 9.1): at 20, A for the peak on 10 and
  // B for the bottom on 20
  const c = barsOf([...flat(10), [12, 9.5], ...Array.from({ length: 9 }, (): [number, number] => [11, 9.1]), [10, 8.5]]);
  const o2 = mailsOf("USD/JPY", c, readsOf(c).reads, null, T0, T0 + 100 * HOUR);
  check("A SELL and B BUY on the same bar 20", brief(o2.mails), [["B", 10, "SELL", 10], ["A", 20, "SELL", 10], ["B", 20, "BUY", 20]]);
}

// 6. one email the other way round (the owner's way), on hand-made 1-minute bars (USD/JPY, a pip 0.01)
{
  // a SELL at E = 150.000 closed at T: minutes from T; the ask is the bid + 0.002
  const T = Date.UTC(2024, 2, 4, 10);
  const rows: Array<[number, number, number, number, number]> = [
    [0, 149.990, 149.995, 149.985, 149.990],
    [1, 149.990, 149.992, 149.988, 149.990],
    [2, 149.995, 150.001, 149.990, 149.995],
    [3, 149.990, 149.990, 149.880, 149.900],
    [4, 149.900, 149.910, 149.890, 149.900],
  ];
  const f = (k: number) => new Float64Array(rows.map((r) => r[k]));
  const m: M1 = { pair: "USD/JPY", n: rows.length, t: new Float64Array(rows.map((r) => T + r[0] * MINUTE)), bo: f(1), bh: f(2), bl: f(3), bc: f(4), ao: f(1).map((v) => v + 0.002), ah: f(2).map((v) => v + 0.002), al: f(3).map((v) => v + 0.002), ac: f(4).map((v) => v + 0.002) };
  const bk = makeBook(m, new Float64Array(0), true);
  const mail: PbMail = { cand: "A", pair: "USD/JPY", k: 0, open: T - HOUR, T, side: "SELL", dir: -1, E: 150, mark: { i: 0, kind: "peak", price: 150.1 }, markOpen: T - 11 * HOUR, both: false, weekFirst: false };
  const END = T + 10 * MINUTE;
  const tr = tradeOf(bk, mail, END);
  check("the email: the SELL limit filled at E in P's bar, TP 10 in the next bar", [tr.own.filled, tr.own.path.market, tr.own.tp, Number((tr.own.pips as number).toFixed(6))], [true, false, true, 10]);
  // the other way: a BUY at E 150; at P the ask open 149.997 is already under E: taken at the market, 149.997.
  // Its TP 150.100 (the bid) is not reached by END: held, valued at the bid close of the last bar ended by END
  // (bar 4, 149.900): −9.7 pips. The worst against it from the fill bar on: the bid low 149.880 → 11.7 pips. Held
  // from the fill bar's start (T + 2 min) to END: 8 minutes.
  const opp = oppositeOf(bk, mail, END);
  check("the other way: a BUY taken at the market at 149.997", [opp.filled, opp.path.market, Number(opp.path.fill.toFixed(3))], [true, true, 149.997]);
  check("the other way: held at END, −9.7 pips, MAE 11.7, 8 minutes", [opp.tp, opp.held, Number((opp.pips as number).toFixed(6)), Number((opp.mae as number).toFixed(6)), Number((opp.hold as number).toFixed(6))], [false, true, -9.7, 11.7, Number((8 / 60).toFixed(6))]);
}

// 7. mulberry32(378) (the draws the Python draws too), the ranks, and the bootstrap with one month
{
  const r = mulberry32(378);
  // computed apart, in Python (32-bit integer arithmetic)
  check("mulberry32(378): first three", [r(), r(), r()].map((x) => Number(x.toFixed(12))), [0.803763129516, 0.512714281911, 0.841980014928]);
  // floor(q × C + 0.5) within [1, C]: 0.025 × 9,940 = 248.5 → 249 (Python's round would give 248); C ≤ 19 → 1
  check("ranks", [rankOf(0.025, 9940), rankOf(0.975, 9980), rankOf(0.025, 19), rankOf(0.975, 19), rankOf(0.025, 20), rankOf(0.975, 1)], [249, 9731, 1, 19, 1, 1]);
  const own = (pips: number) => ({ filled: true, tp: pips === 10, held: pips !== 10, pips, mae: 0, hold: 1, path: {} as never });
  const row = (sig: number, opp: number): Row => ({ mail: { T: T0 } as PbMail, half: 2, month: "2025-06", trade: { own: own(sig), guide: null }, opp: own(opp), cut: null, stays: true, otherKind: false });
  const b = bootstrap([row(10, -5), row(-20, 10), row(10, 10)], 50, 378);
  // the emails' mean (10 − 20 + 10) / 3 = 0; the other way's (−5 + 10 + 10) / 3 = 5; the gap −5 in every draw
  check("one month: every draw the same", [b.gapLo, b.gapHi, b.ownLo, b.ownHi, b.kept, b.empty, b.months], [-5, -5, 0, 0, 50, 0, 1]);
  check("no row: no range, no draw", [bootstrap([], 50, 378).gapLo, bootstrap([], 50, 378).kept], [null, 0]);
}

console.log(failed === 0 ? "ALL HAND EXAMPLES HOLD" : `${failed} HAND EXAMPLES FAILED`);
if (failed) Deno.exit(1);
