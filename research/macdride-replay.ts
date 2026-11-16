// The owner (2026-11-16): 「やっぱりメール 90% に届いた時点で送って」, then, asked which email, 「1通目90%触れ・2通目95%」,
// and, shown the numbers (docs §8.154), 「90%触れ→95%に変える」. The MACD ride v10 (research/macdride10-spec.md, on
// research/macdride-spec.md, v9's): for the five pairs and gold, email 1 the moment (a minute's read) the line, worked
// out with the forming 1-hour bar's high so far (low so far) as its close, touches 90% of the pane's top (bottom), the
// bar before having closed outside the band; email 2 the moment it touches 95%. This is the replay of
// research/macdride10-spec.md section 9: the code the function runs (supabase/functions/_shared/macd-ride.ts:
// rideStateZpOf, rideHit, rideCloseStep, rideTouch, rideCatchUp) driven minute by minute over the five pairs' bars as
// the function's section 4 does it, with the rides and each bar's decision kept in memory.
//
// A read of a bar after each of its minutes has ended, at that minute's end (m1.t[k] + 1 minute), the bar's last minute
// included: first the reaches (each ride entered before the read whose side's extreme so far touches 95%: out at that
// minute's close on the leaving side, as research/macd90m-spec.md "Following it"), then, while the bar has no decision,
// the decision (rideHit: 90% on a side its Zp is not at, the top first; already when the same line is at 95% too; the
// step from the rides as they stand after the reaches: in opens a ride, at, skip, quiet; a minute ride is followed from
// the next minute). At each 1-hour close: the catch-up of the rides held (a minute ride's entry bar too, at that bar's
// own close), then the tail (the bar's decision from its final high and low, when no read made one; its ride followed
// from the next bar's first minute). A decision only in a bar whose close is in [START, END) (research/macd90m.ts's
// gate); the reaches, the worst against and the catch-up go on through the last bar and minute loaded, and a ride still
// open there is valued at that bar (the study's "open").
//
// Two readings of the bar's extremes so far:
//   R1  the highest of the 1-minute mid highs so far (each round_chart((bid high + ask high) / 2, d)) and the lowest of
//       the mid lows, a read's price the minute's close, every minute read: the study's reading (research/macd90m.ts
//       reads each minute's own; the line rises with the price, so the extreme so far first touches in the minute the
//       study's does, and is that minute's own then). The closed bar's high and low that the tail and the catch-up read
//       are what R1 ended the hour with (an hour with no minute read has none: no touch). Under R1 the rows must be
//       research/macd90m.ts's "moment" rows with way C at REACH = 0.95 (docs §8.154): all of them, the 14 columns of
//       each, its summary's moment groups (entries, already, every number of C) and its span and reach; and the tail
//       and the catch-up must find nothing. Any difference: the first 20 are printed and the run stops.
//   R2  round_chart((the highest bid high so far + the highest ask high so far) / 2, d), and the lows likewise: what
//       GMO's forming 1-hour bar gives, which is what the function reads each minute; the closed bars as the chart
//       draws them (live-chart historyRead) for the tail and the catch-up; and the function's week
//       (research/macdride10-spec.md section 4, "unwatched moments"): no read whose moment is in the weekend gate
//       (isPossiblyClosed), no close judged there (no catch-up, no tail), and no minute read in a bar whose state no
//       judged close wrote (the week's first hour: decided by its close's tail, its rides reached by that close's
//       catch-up). Never under R1's high nor over its low, so a touch can come earlier, on another side, or in a bar
//       R1 has no decision in. Keyed by pair and bar, R2's decisions and trades are held against R1's and the
//       differences counted and printed, and so is how many of R1's decisions fall in the hours the function does not
//       watch. Its numbers (research/macdride10-spec.md section 8's list) are the measurement of the function's own
//       reading and week.
//
// Not replayed (research/macdride10-spec.md sections 9 and 10): missed runs, the minutes before a close is judged, the
// seconds between a minute's end and a run's read (the function prices email 1 and email 2 at its read, the replay at
// the minute's close), GMO's forming bar against its own minutes. Gold and the shares are not measured.
//
//   MODE=real       GMO's 1-hour and 1-minute files (research/.cache, fetched when missing: the loaders
//                   research/macd90m.ts uses) and the study's rows: STUDY/rows.csv and STUDY/summary.json, written by
//                   research/macd90m.ts MODE=real with REACH=0.95, which the workflow runs first (that file exports
//                   nothing, so its rows are read from its files, not made in this process). Writes OUT/rows-R1.csv;
//                   when R1 equals the study, OUT/{rows-R2.csv,r2-vs-r1.csv,summary.json}, and prints the numbers (R1's
//                   held against docs §8.154's as printed there: said, not stopped on).
//   MODE=synthetic  the same on seeded walks, and the walks' checks (research/macdride10-spec.md section 9 "Walks").
//                   For each seed of SEEDS, OUT/walk<seed> must be what `MODE=walkfiles REACH=0.95 SEEDS=<seed>
//                   OUT=<OUT>/walk<seed> research/macd90m.ts` left: the walk as GMO's files (gmo/) and the study's rows
//                   on it. R1 must equal the study's moment rows and its summary's numbers, its tail and catch-up find
//                   nothing; the walk's 1-hour bars are its 1-minute bars'. Then, on the walk as it is, with its bid and
//                   ask moved apart (movedApart) and with that and the 1-minute bars of some hours taken out or cut
//                   short (withHoles): R2's extremes never inside R1's, and R2 earlier than R1 somewhere once they are
//                   moved apart (never while they are one); R2's tail decides and its catch-up reaches only in a bar its
//                   minute reads did not see whole; a minute ride whose entry bar's chart extreme touches 95% after its
//                   reads is reached by that bar's close (section 4 A.3); an hour with no minute read is decided by the
//                   tail iff its chart extreme touches 90% on a side its Zp is not at, and R1 decides nothing in an hour
//                   with no 1-minute bar; the lone reading (R2 with no minute read) decides the same bars as R2, on R2's
//                   side unless both sides touched (then the top), already wherever R2's decision on that side is,
//                   every reach late and out at the close it is found at; what each decision did is said again from
//                   the rows (stepsByRule). Each walk must also hold something of each: reached, already, skipped,
//                   rides reached in their entry bar, R2's tail and catch-up in the week's first hours, in the hours
//                   taken out, and in an entry bar cut short.
//   MODE=print      the summary the real run wrote.
//
// Nothing here sends an email or writes a table; the numbers are the replay's only.

import { historyRead } from "../supabase/functions/live-chart/logic.ts";
import type { QuoteCandle } from "../supabase/functions/track-outcomes/quotes.ts";
import { LEVEL_WINDOW } from "../supabase/functions/_shared/macd-level.ts";
import { isPossiblyClosed } from "../supabase/functions/_shared/market-hours.ts";
import {
  atShare,
  RIDE_CATCHUP_BARS,
  RIDE_IN_SHARE,
  RIDE_OUT_SHARE,
  RIDE_TOUCH_TAG,
  type RideBar,
  rideCatchUp,
  rideCloseStep,
  rideHit,
  type RideHit,
  type RideRow,
  type RideSide,
  type RideState,
  rideStateZpOf,
  type RideStep,
  rideTouch,
  rideTouchAt,
  type RideZone,
  rideZoneAt,
  type RideZoneSide,
  shareOf,
} from "../supabase/functions/_shared/macd-ride.ts";
import { type LoadStats, loadM1, type M1, newLoadStats, type Source } from "./ownerhold-data.ts";
import { loadTf, quotesOf } from "./trend-data.ts";
import { weekendOutOf } from "./trend-labels.ts";
import { lowerBound } from "./money-data.ts";
import { mean, median, mulberry32 } from "./flowz-lib.ts";
import { HOUR, MINUTE } from "./lib.ts";
import { dataOf, decimalsOf, iso, P, type PairData, PAIRS } from "./macd90.ts";

const env = (k: string, d: string) => Deno.env.get(k) ?? d;
const MODE = env("MODE", "synthetic");
const START_DEFAULT = "2024-01-01T00:00:00Z";
const END_DEFAULT = "2026-11-10T21:00:00Z";
const LOAD_FROM_DEFAULT = "2023-10-01T00:00:00Z";
const START = Date.parse(env("START", START_DEFAULT));
const END = Date.parse(env("END", END_DEFAULT));
const LOAD_FROM = Date.parse(env("LOAD_FROM", LOAD_FROM_DEFAULT));
const OUT = env("OUT", "research/out/macdride");
// where research/macd90m.ts MODE=real (REACH=0.95) wrote its rows.csv and summary.json
const STUDY = env("STUDY", "research/out/macd90m");
const W = LEVEL_WINDOW;

type Reading = "R1" | "R2";
const READINGS: Record<Reading, string> = {
  R1: "the highest of the 1-minute mid highs so far and the lowest of the mid lows, every minute read: the study's reading",
  R2: "the mid of the highest bid high and the highest ask high so far, and of the lows: GMO's forming 1-hour bar, with the function's week (no read in the weekend gate, none in the week's first hour): the function's reading",
};

// a mid as the chart rounds it (research/macd90m.ts hiOf / loOf; live-chart's GMO mid)
const midOf = (bid: number, ask: number, dec: number) => Number(((bid + ask) / 2).toFixed(dec));

// ---- one pair's bars ----------------------------------------------------------------------------------

// the state and Zp of a bar (research/macdride10-spec.md section 1): what a close writes for the bar then forming
type StateZp = { state: RideState; zp: RideZone };

interface PairIn {
  // the 1-hour bars as the study reads them (research/macd90.ts dataOf: the chart's mid close, the bid and ask closes)
  d: PairData;
  m1: M1;
  // the closed 1-hour bars' high and low as the chart draws them (historyRead), by d's index
  ch: number[];
  cl: number[];
  // the 1-minute bars of each 1-hour bar: [k0[j], k1[j])
  k0: number[];
  k1: number[];
  dec: number;
  // each bar's state and Zp from the 599 closes before it (rideStateZpOf; null before bar W - 1 or on a close that is no
  // number). The closes are never moved here (movedApart moves the minutes' highs and lows), so the walks share them.
  sz: Array<StateZp | null>;
  // The function's week (research/macdride10-spec.md section 4 "unwatched moments"; R2 only). judged[j]: bar j's close
  // is judged, its moment outside the weekend gate (isPossiblyClosed): the catch-up and the tail run there. stated[j]:
  // bar j's state was written by a judged close, that of the bar before it at bar j's open (section 4 A.2 writes the
  // state of open(i) + 1 hour). Not so for the week's first hour, whose bar before is Friday's last (closed in the
  // gate, and not the hour before); nor for a bar the chart has after a missing hour (counted with them).
  judged: boolean[];
  stated: boolean[];
}

const pairInOf = (d: PairData, qs: QuoteCandle[], m1: M1): PairIn => {
  const byT = new Map(historyRead(d.pair, "1h", qs, END).candles.map((c) => [Date.parse(c.datetime.replace(" ", "T") + "Z"), c]));
  const ch: number[] = [];
  const cl: number[] = [];
  for (let j = 0; j < d.n; j++) {
    const c = byT.get(d.t[j]);
    if (!c || c.close !== d.mid[j]) throw new Error(`${d.pair} ${iso(d.t[j])}: the chart's bar is not the study's`);
    ch.push(c.high);
    cl.push(c.low);
  }
  const sz = d.t.map((_, j) => (j >= W - 1 ? rideStateZpOf(d.mid.slice(j - (W - 1), j)) : null));
  const judged = d.t.map((t) => !isPossiblyClosed(t + HOUR));
  const stated = d.t.map((t, j) => j > 0 && judged[j - 1] && d.t[j - 1] + HOUR === t);
  return { d, m1, ch, cl, k0: d.t.map((t) => lowerBound(m1.t, t)), k1: d.t.map((t) => lowerBound(m1.t, t + HOUR)), dec: decimalsOf(d.pair), sz, judged, stated };
};

// GMO's 1-hour bars against its 1-minute bars of the same hour (the hours opened from START on, where the 1-minute
// bars begin): the hours with no 1-minute bar, and those whose chart high (low) is not the mid of the highest bid high
// and the highest ask high of its minutes (R2 at the hour's end). The 1-minute bars in no 1-hour bar are counted too.
const chartAgainstMinutes = (a: PairIn) => {
  const { d, m1, dec } = a;
  let hours = 0;
  let noMinute = 0;
  let highOther = 0;
  let lowOther = 0;
  let inside = 0;
  for (let j = 0; j < d.n; j++) {
    inside += a.k1[j] - a.k0[j];
    if (d.t[j] < START) continue;
    hours++;
    if (a.k1[j] === a.k0[j]) {
      noMinute++;
      continue;
    }
    let bh = -Infinity;
    let ah = -Infinity;
    let bl = Infinity;
    let al = Infinity;
    for (let k = a.k0[j]; k < a.k1[j]; k++) {
      if (m1.bh[k] > bh) bh = m1.bh[k];
      if (m1.ah[k] > ah) ah = m1.ah[k];
      if (m1.bl[k] < bl) bl = m1.bl[k];
      if (m1.al[k] < al) al = m1.al[k];
    }
    if (midOf(bh, ah, dec) !== a.ch[j]) highOther++;
    if (midOf(bl, al, dec) !== a.cl[j]) lowOther++;
  }
  return { hours, noMinute, highOther, lowOther, minutesOutside: m1.n - inside };
};
type ChartCheck = ReturnType<typeof chartAgainstMinutes>;

// R2's extremes so far against R1's, at every minute of every bar (research/macdride10-spec.md section 9 "Walks",
// moved prices): `under`, the minutes at which R2's high is under R1's or its low over R1's (never: the rounding of a
// mid is monotone and each minute's bid and ask are under the highest so far); `apart`, those at which they differ
const extremesOf = (a: PairIn) => {
  const { m1, dec } = a;
  let under = 0;
  let apart = 0;
  for (let j = 0; j < a.d.n; j++) {
    let h1 = NaN;
    let l1 = NaN;
    let bh = -Infinity;
    let ah = -Infinity;
    let bl = Infinity;
    let al = Infinity;
    for (let k = a.k0[j]; k < a.k1[j]; k++) {
      const x = midOf(m1.bh[k], m1.ah[k], dec);
      const y = midOf(m1.bl[k], m1.al[k], dec);
      if (!(h1 >= x)) h1 = x;
      if (!(l1 <= y)) l1 = y;
      if (m1.bh[k] > bh) bh = m1.bh[k];
      if (m1.ah[k] > ah) ah = m1.ah[k];
      if (m1.bl[k] < bl) bl = m1.bl[k];
      if (m1.al[k] < al) al = m1.al[k];
      const h2 = midOf(bh, ah, dec);
      const l2 = midOf(bl, al, dec);
      if (h2 < h1 || l2 > l1) under++;
      if (h2 !== h1 || l2 !== l1) apart++;
    }
  }
  return { under, apart };
};
type Extremes = ReturnType<typeof extremesOf>;

// A walk's bid and ask move as one (one spread), so an hour's highest bid high and highest ask high fall in the same
// minute and R2's extremes are R1's. For R2's own way to be checked on a walk: the same walk with the two moved apart,
// about four in ten of the minutes' ask highs raised and as many of their bid lows lowered by 0.5 to 8 pips (the ask
// stays over the bid; no close moves, so the 1-hour closes, the states and Zp stay; R1's mid high and low move too, so
// R1's decisions on it are not the study's), and the chart's 1-hour high and low redrawn from these minutes as GMO's
// 1-hour bar of them would be. No study's rows exist for it: R1 on it is held against nothing but R2.
const movedApart = (a: PairIn, seed: number): PairIn => {
  const { m1, dec } = a;
  const rnd = mulberry32(seed);
  const pip = dec === 3 ? 0.01 : 0.0001;
  const ah = Float64Array.from(m1.ah);
  const bl = Float64Array.from(m1.bl);
  for (let k = 0; k < m1.n; k++) {
    if (rnd() < 0.4) ah[k] = Number((ah[k] + pip * (0.5 + 7.5 * rnd())).toFixed(dec));
    if (rnd() < 0.4) bl[k] = Number((bl[k] - pip * (0.5 + 7.5 * rnd())).toFixed(dec));
  }
  const ch = [...a.ch];
  const cl = [...a.cl];
  for (let j = 0; j < a.d.n; j++) {
    if (a.k1[j] === a.k0[j]) continue;
    let hb = -Infinity;
    let ha = -Infinity;
    let lb = Infinity;
    let la = Infinity;
    for (let k = a.k0[j]; k < a.k1[j]; k++) {
      if (m1.bh[k] > hb) hb = m1.bh[k];
      if (ah[k] > ha) ha = ah[k];
      if (bl[k] < lb) lb = bl[k];
      if (m1.al[k] < la) la = m1.al[k];
    }
    ch[j] = midOf(hb, ha, dec);
    cl[j] = midOf(lb, la, dec);
  }
  return { ...a, m1: { ...m1, ah, bl }, ch, cl };
};

// GMO's 1-minute files can lack what its 1-hour file holds. A walk again with the 1-minute bars of about one hour in
// twelve taken out and its 1-hour bars as they were: such an hour has no minute read, so under R2 (and the lone
// reading) its close's tail decides it from the chart's bar and its close's catch-up sees a ride touched in it; R1,
// like the study, reads nothing there. And, of about one other hour in four, the last 3 to 30 minutes taken out (a
// second draw, so that the whole hours are those of the draw above): the chart's bar then holds prices no minute read
// held, as GMO's do on the real files (chartAgainstMinutes), so a close's catch-up can find a minute ride in its own
// entry bar (research/macdride10-spec.md section 4 A.3), and the tail a bar whose minutes did not touch.
const withHoles = (a: PairIn, seed: number): PairIn => {
  const { d, m1 } = a;
  const rnd = mulberry32(seed);
  const cut = mulberry32(seed + 7);
  const keep: number[] = [];
  for (let j = 0; j < d.n; j++) {
    if (a.k1[j] === a.k0[j] || rnd() < 1 / 12) continue;
    const end = cut() < 1 / 4 ? Math.min(a.k1[j], a.k0[j] + 30 + Math.floor(28 * cut())) : a.k1[j];
    for (let k = a.k0[j]; k < end; k++) keep.push(k);
  }
  const pick = (xs: Float64Array) => Float64Array.from(keep, (k) => xs[k]);
  const m: M1 = { pair: m1.pair, n: keep.length, t: pick(m1.t), bo: pick(m1.bo), bh: pick(m1.bh), bl: pick(m1.bl), bc: pick(m1.bc), ao: pick(m1.ao), ah: pick(m1.ah), al: pick(m1.al), ac: pick(m1.ac) };
  return { ...a, m1: m, k0: d.t.map((t) => lowerBound(m.t, t)), k1: d.t.map((t) => lowerBound(m.t, t + HOUR)) };
};

// ---- the replay of one pair ----------------------------------------------------------------------------

// how a ride ended (or stands at the last bar loaded): the study's numbers of a way C trade
interface Out {
  result: "reached" | "open";
  // the open of the bar it was reached in (the ride's reached_bar); null while open
  bar: number | null;
  T: number;
  exit: number;
  pips: number;
  mae: number;
  minutes: number;
  share: number;
  // found by a close's catch-up, not at a minute's read (the function's `late`): out at the close it ran at
  late: boolean;
}
// research/macdride10-spec.md section 3's `source`: a minute's read, or the tail (the read of the bar's close)
type Made = "minute" | "close";
// a bar's decision (research/macdride10-spec.md section 1.1; at most one a bar), and what it did
interface Row {
  pair: string;
  i: number;
  open: number;
  // the decision's moment: a minute's read (that minute's end), or the tail's (the bar's close)
  T0: number;
  source: Made;
  side: RideSide;
  zside: RideZoneSide;
  // the price paid: a minute's ask close for a BUY and bid close for a SELL, the tail's the bar's (on every row, as the
  // study's)
  entry: number;
  // the extreme the decision was made with, the line's share there, and whether it was at 95% there too
  x: number;
  share0: number;
  already: boolean;
  step: RideStep;
  // skip and quiet: the entry bar of the ride that made it so
  by: number | null;
  // step "in": the ride
  out: Out | null;
}
// a ride in memory: what public.macd_rides would hold of it (RideRow), and what the study's numbers need
interface Held extends RideRow {
  row: Row;
  zside: RideZoneSide;
  // the entry in whole points, the worst against it so far in whole points, the first 1-minute bar followed
  pe: number;
  worst: number;
  kFrom: number;
}

interface Opts {
  reading: Reading;
  // false: no minute is read (the lone reading: every decision a close's tail, every reach a close's catch-up)
  minutes: boolean;
}
interface Replay {
  rows: Row[];
  // rides the catch-up found; of them in a bar older than the newest closed one, and in the ride's own entry bar
  caught: number;
  caughtOlder: number;
  caughtEntryBar: number;
  // decisions the tail made
  tails: number;
  // bars from W - 1 on with no state (a close that is no number)
  stateless: number;
  // the function's week (R2 and the lone reading), over the bars whose close is in [START, END): the bars whose state
  // no judged close wrote (no minute read; of them, `unstatedGap`, those with no hour in the weekend gate from the bar
  // before's close to their open: after a missing hour, not the week's first), the closes not judged (no catch-up, no
  // tail), and the minutes of bars with a state whose read is in the weekend gate
  week: { unstated: number; unstatedGap: number; unjudged: number; gateMinutes: number };
  // decisions in the bar opened an hour before START (its close is START: in the gate, but it has no minutes, so only
  // a tail can decide it, from the chart's bar under R2; R1 and the study cannot)
  beforeStart: number;
  // per bar: 1 when it has 1-minute bars and every one of them was read
  whole: Uint8Array;
}

const replayPair = (a: PairIn, o: Opts): Replay => {
  const { d, m1, dec } = a;
  // R2 and the lone reading go by the function's week (research/macdride10-spec.md section 9 R2); R1 by the study's
  const week = o.reading === "R2";
  const rows: Row[] = [];
  // the rides held: at most one a side
  const held: Held[] = [];
  // the closed bars as a close's catch-up and tail read them. R1: the high and low R1 ended each hour with (NaN where
  // no minute was read: no touch). R2: the chart's own.
  const bars: RideBar[] = d.t.map((t, j) => ({ t, high: o.reading === "R1" ? NaN : a.ch[j], low: o.reading === "R1" ? NaN : a.cl[j], close: d.mid[j] }));
  const whole = new Uint8Array(d.n);
  let caught = 0;
  let caughtOlder = 0;
  let caughtEntryBar = 0;
  let tails = 0;
  let stateless = 0;
  const wk = { unstated: 0, unstatedGap: 0, unjudged: 0, gateMinutes: 0 };

  const against = (h: Held, k: number) => {
    const adv = h.side === "BUY" ? h.pe - P(m1.bl[k], dec) : P(m1.ah[k], dec) - h.pe;
    if (adv > h.worst) h.worst = adv;
  };
  const settle = (h: Held, result: "reached" | "open", bar: number | null, T: number, exit: number, share: number, late: boolean) => {
    const pts = h.side === "BUY" ? P(exit, dec) - h.pe : h.pe - P(exit, dec);
    if (result === "reached") {
      h.status = "reached";
      h.reachedBar = bar;
    }
    h.row.out = { result, bar, T, exit, pips: pts / 10, mae: h.worst / 10, minutes: (T - h.row.T0) / MINUTE, share, late };
  };
  // bar j's decision (research/macdride10-spec.md section 1.1) from a hit, with the rides as they stand after this
  // read's reaches (or this close's catch-up): the held ones and those reached in this bar or by this close (a ride
  // reached in an earlier bar neither skips nor quiets; none can have been entered in a later bar yet)
  const decide = (j: number, hit: RideHit, T0: number, source: Made, entry: number, kFrom: number, reachedHere: Held[]) => {
    const barOpen = d.t[j];
    const s = rideCloseStep(hit, barOpen, [...held, ...reachedHere]);
    if (s.step === null || (s.step === "at" || s.step === "quiet") !== hit.already) throw new Error(`${d.pair} ${iso(barOpen)}: a step that is not the hit's`);
    const row: Row = {
      pair: d.pair,
      i: j,
      open: barOpen,
      T0,
      source,
      side: hit.side,
      zside: hit.zside,
      entry,
      x: hit.x,
      share0: hit.share0,
      already: hit.already,
      step: s.step,
      by: s.by === null ? null : s.by.entryBar,
      out: null,
    };
    rows.push(row);
    if (s.step !== "in") return;
    if (s.own !== null || held.some((h) => h.side === hit.side)) throw new Error(`${d.pair} ${iso(barOpen)}: a second ride of a side`);
    held.push({ side: hit.side, entryBar: barOpen, status: "open", reachedBar: null, row, zside: hit.zside, pe: P(entry, dec), worst: 0, kFrom });
  };

  // the 1-minute bars passed so far: [0, kp)
  let kp = 0;
  for (let j = W - 1; j < d.n; j++) {
    const barOpen = d.t[j];
    const T = barOpen + HOUR;
    // a decision only in a bar whose close is in [START, END) (research/macd90m.ts's gate, every reading). Spec question
    // (research/macdride10-spec.md section 9): the bar opened at START - 1 hour closes at START, so it is in the gate,
    // though it is an hour before START with no minutes loaded; the gate is kept as written (counted: beforeStart)
    const inGate = T >= START && T < END;
    const sz = a.sz[j];
    if (sz === null) stateless++;
    // the rides reached in this bar, or by this close's catch-up (the rows the step reads beside those held)
    const reachedHere: Held[] = [];
    let decided = false;

    // a 1-minute bar in no 1-hour bar has no line to be read with: it counts for the worst against a trade only (as in
    // the study)
    for (let k = kp; k < a.k0[j]; k++) for (const h of held) if (k >= h.kFrom) against(h, k);
    // whether bar j's minutes are read (R2: only when a judged close wrote its state; the lone reading: never)
    const reads = o.minutes && sz !== null && (!week || a.stated[j]);
    if (week && inGate && !a.stated[j]) {
      wk.unstated++;
      // after a missing hour: no hour from the bar before's close to this bar's open is in the weekend gate
      let gap = j > 0;
      for (let t = j > 0 ? d.t[j - 1] + HOUR : barOpen; gap && t <= barOpen; t += HOUR) if (isPossiblyClosed(t)) gap = false;
      if (gap) wk.unstatedGap++;
    }
    let all = a.k1[j] > a.k0[j];
    let hi = NaN;
    let lo = NaN;
    let bh = -Infinity;
    let ah = -Infinity;
    let bl = Infinity;
    let al = Infinity;
    for (let k = a.k0[j]; k < a.k1[j]; k++) {
      // the extremes so far: every minute of the bar is in them, read or not (GMO's forming bar holds every price)
      if (o.reading === "R1") {
        const h1 = midOf(m1.bh[k], m1.ah[k], dec);
        const l1 = midOf(m1.bl[k], m1.al[k], dec);
        if (!(hi >= h1)) hi = h1;
        if (!(lo <= l1)) lo = l1;
      } else {
        if (m1.bh[k] > bh) bh = m1.bh[k];
        if (m1.ah[k] > ah) ah = m1.ah[k];
        if (m1.bl[k] < bl) bl = m1.bl[k];
        if (m1.al[k] < al) al = m1.al[k];
        hi = midOf(bh, ah, dec);
        lo = midOf(bl, al, dec);
      }
      // every ride held counts this minute against it (one opened at this read is pushed after it: from the next)
      for (const h of held) against(h, k);
      const at = m1.t[k] + MINUTE;
      if (!reads || sz === null) {
        all = false;
        continue;
      }
      if (week && isPossiblyClosed(at)) {
        if (inGate) wk.gateMinutes++;
        all = false;
        continue;
      }
      // reaches first (research/macdride10-spec.md section 4 B.3): each ride entered before this read
      for (let q = 0; q < held.length;) {
        const h = held[q];
        const touch = rideTouch(sz.state, h.zside, hi, lo);
        if (touch === null) {
          q++;
          continue;
        }
        settle(h, "reached", barOpen, at, h.side === "BUY" ? m1.bc[k] : m1.ac[k], touch.share, false);
        held.splice(q, 1);
        reachedHere.push(h);
      }
      // then the decision (B.4), while the bar has none
      if (decided || !inGate) continue;
      const hit = rideHit(sz.state, sz.zp, hi, lo);
      if (hit === null) continue;
      decided = true;
      decide(j, hit, at, "minute", hit.side === "BUY" ? m1.ac[k] : m1.bc[k], k + 1, reachedHere);
    }
    kp = a.k1[j];
    if (all) whole[j] = 1;
    if (o.reading === "R1" && a.k1[j] > a.k0[j]) {
      bars[j].high = hi;
      bars[j].low = lo;
    }

    // ---- the close of bar j (R2: only outside the weekend gate): the catch-up of the rides held (the function's 600
    // closed bars in hand; a minute ride's entry bar too, at its own close: section 4 A.3), then the tail (A.4)
    if (week && !a.judged[j]) {
      if (inGate) wk.unjudged++;
      continue;
    }
    if (held.length > 0) {
      const hand = bars.slice(j + 1 - W, j + 1);
      for (let q = 0; q < held.length;) {
        const h = held[q];
        const c = rideCatchUp(hand, h.zside, h.entryBar, RIDE_CATCHUP_BARS, h.row.source === "minute" ? {} : null);
        if (c === null) {
          q++;
          continue;
        }
        caught++;
        if (!c.newest) caughtOlder++;
        if (c.bar === h.entryBar) caughtEntryBar++;
        settle(h, "reached", c.bar, T, h.side === "BUY" ? d.bc[j] : d.ac[j], c.share, true);
        held.splice(q, 1);
        reachedHere.push(h);
      }
    }
    if (decided || !inGate || sz === null) continue;
    const hit = rideHit(sz.state, sz.zp, bars[j].high, bars[j].low);
    if (hit === null) continue;
    tails++;
    decide(j, hit, T, "close", hit.side === "BUY" ? d.ac[j] : d.bc[j], j + 1 < d.n ? a.k0[j + 1] : m1.n, reachedHere);
  }
  // the rides still held at the last bar loaded: valued at its close (the study's "open")
  const last = d.n - 1;
  const zl = last >= W - 1 ? rideZoneAt(d.mid.slice(last + 1 - W, last + 1)) : null;
  for (const h of held) settle(h, "open", null, d.t[last] + HOUR, h.side === "BUY" ? d.bc[last] : d.ac[last], zl === null ? NaN : shareOf(zl, h.zside), false);
  return { rows, caught, caughtOlder, caughtEntryBar, tails, stateless, week: wk, beforeStart: rows.filter((r) => r.open < START).length, whole };
};

// ---- the numbers --------------------------------------------------------------------------------------

// the value at rank ceil(0.9 n) of the values in ascending order (research/macd90m-spec.md)
const p90 = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor((9 * s.length + 9) / 10) - 1];
};
// research/macd90m.ts's group C, field for field (so that R1's can be held against the study's summary), and `zero`
// (reached at 0 pips: research/macdride10-spec.md section 8's list), which the study's has not
const cStats = (rs: Row[]) => {
  const taken = rs.filter((r) => r.out !== null).map((r) => r.out as Out);
  const reached = taken.filter((w) => w.result === "reached");
  const open = taken.filter((w) => w.result === "open");
  let pipsSum = 0;
  for (const w of reached) pipsSum += w.pips;
  let openPipsSum = 0;
  for (const w of open) openPipsSum += w.pips;
  const maxOf = (xs: number[]) => (xs.length ? Math.max(...xs) : null);
  return {
    reached: reached.length,
    open: open.length,
    skipped: rs.filter((r) => r.step === "skip").length,
    plus: reached.filter((w) => w.pips > 0).length,
    minus: reached.filter((w) => w.pips < 0).length,
    zero: reached.filter((w) => w.pips === 0).length,
    pipsSum: reached.length ? pipsSum : null,
    pipsMean: mean(reached.map((w) => w.pips)),
    pipsMedian: median(reached.map((w) => w.pips)),
    pipsMin: reached.length ? Math.min(...reached.map((w) => w.pips)) : null,
    maeMedian: median(reached.map((w) => w.mae)),
    maeP90: p90(reached.map((w) => w.mae)),
    maeMax: maxOf(reached.map((w) => w.mae)),
    minutesMedian: median(reached.map((w) => w.minutes)),
    minutesP90: p90(reached.map((w) => w.minutes)),
    minutesMax: maxOf(reached.map((w) => w.minutes)),
    within60: reached.filter((w) => w.minutes <= 60).length,
    within1440: reached.filter((w) => w.minutes <= 1440).length,
    within10080: reached.filter((w) => w.minutes <= 10080).length,
    openPipsSum: open.length ? openPipsSum : null,
    openPipsWorst: open.length ? Math.min(...open.map((w) => w.pips)) : null,
    openMaeMax: maxOf(open.map((w) => w.mae)),
    openMinutesMax: maxOf(open.map((w) => w.minutes)),
  };
};
type CStats = ReturnType<typeof cStats>;

const isAlready = (r: Row) => r.step === "at" || r.step === "quiet";
// entries and already as the study's group; the notices sent (at) and not sent (quiet), the decisions the tail made,
// the trades a close's catch-up ended, and those reached in their own entry bar, are the replay's own
const groupOf = (rs: Row[]) => ({
  entries: rs.length,
  already: rs.filter(isAlready).length,
  at: rs.filter((r) => r.step === "at").length,
  quiet: rs.filter((r) => r.step === "quiet").length,
  tails: rs.filter((r) => r.source === "close").length,
  late: rs.filter((r) => r.out !== null && r.out.late).length,
  inEntryBar: rs.filter((r) => r.out !== null && r.out.result === "reached" && r.out.bar === r.open).length,
  C: cStats(rs.filter((r) => !isAlready(r))),
});
type Group = ReturnType<typeof groupOf>;
type Groups = Record<string, Group>;

const groupsOf = (rs: Row[]): Groups => {
  const g: Groups = { all: groupOf(rs) };
  for (const p of PAIRS) g[p] = groupOf(rs.filter((r) => r.pair === p));
  for (const s of ["BUY", "SELL"]) g[s] = groupOf(rs.filter((r) => r.side === s));
  return g;
};

// research/macdride10-spec.md section 8's measured list (RIDE_MEASURED), of one group: trades; reached; at a profit, at
// a loss, at zero; the mean and median pips a trade (over those reached, as the study's); the worst; the largest loss
// on the way (median, max); held (median, max, minutes); open trades and their pips together; notices sent; quiet;
// skipped
const measuredOf = (g: Group) => ({
  trades: g.C.reached + g.C.open,
  reached: g.C.reached,
  plus: g.C.plus,
  minus: g.C.minus,
  zero: g.C.zero,
  pipsMean: g.C.pipsMean,
  pipsMedian: g.C.pipsMedian,
  worst: g.C.pipsMin,
  maeMedian: g.C.maeMedian,
  maeMax: g.C.maeMax,
  minutesMedian: g.C.minutesMedian,
  minutesMax: g.C.minutesMax,
  open: g.C.open,
  openPipsSum: g.C.openPipsSum,
  openPipsWorst: g.C.openPipsWorst,
  notices: g.at,
  quiet: g.quiet,
  skipped: g.C.skipped,
});
type Measured = ReturnType<typeof measuredOf>;

// by the decision's moment, then the pairs' order (the study's rows' order: its sums are made in it)
const pairIndex = (p: string) => PAIRS.indexOf(p as typeof PAIRS[number]);
const ordered = (all: Row[]): Row[] => [...all].sort((a, b) => a.T0 - b.T0 || pairIndex(a.pair) - pairIndex(b.pair));

// one decision a bar: a decision's key is its pair and bar
const keyOf = (r: Row) => `${r.pair}|${iso(r.open)}`;

// What each decision did, said again from the rows themselves and apart from rideCloseStep
// (research/macdride10-spec.md section 1.1, with the rides as they stood at the decision's moment: those entered
// before it): one that is not already is skipped exactly when such a ride of its pair and side is still held at its
// moment (open at the end, or out after its moment: one out at its very moment does not skip it, the study's T0 >= T);
// an already one is quiet exactly when such a ride was reached in its very bar by its moment. (A ride entered in a bar
// after the decision's cannot stand at its moment in the replay, which decides a bar before reading the next.) The
// first decision of a pair and side meets no ride, so the steps follow one from the other: every difference is
// returned. (The study's rows do not tell a notice sent from one not sent, and hold nothing of R2.)
const stepsByRule = (rows: Row[]): string[] => {
  const diffs: string[] = [];
  const rides = new Map<string, Row[]>();
  for (const r of rows) {
    if (r.out === null) continue;
    const k = `${r.pair}|${r.side}`;
    const xs = rides.get(k);
    if (xs) xs.push(r);
    else rides.set(k, [r]);
  }
  for (const r of rows) {
    const before = (rides.get(`${r.pair}|${r.side}`) ?? []).filter((x) => x.T0 < r.T0).map((x) => x.out as Out);
    const held = before.some((x) => x.result === "open" || x.T > r.T0);
    const reachedHere = before.some((x) => x.result === "reached" && x.bar === r.open && x.T <= r.T0);
    const want: RideStep = r.already ? (reachedHere ? "quiet" : "at") : held ? "skip" : "in";
    if (want !== r.step) diffs.push(`${r.pair} ${iso(r.T0)} ${r.side}: the decision did "${r.step}", the rule said on the rows gives "${want}"`);
  }
  return diffs;
};

// R1's decisions whose read the function would not make (research/macdride10-spec.md section 9 R2: "how many R1
// decisions fall in the hours the function does not watch"): in a bar whose state no judged close wrote (the week's
// first hour, or a bar after a missing hour), or at a read whose moment is in the weekend gate
const unwatchedOf = (a: PairIn, rs: Row[]) => {
  let noState = 0;
  let gate = 0;
  for (const r of rs) {
    if (!a.stated[r.i]) noState++;
    else if (isPossiblyClosed(r.T0)) gate++;
  }
  return { decisions: rs.length, noState, gate };
};
type Unwatched = ReturnType<typeof unwatchedOf>;

// ---- R2 against R1 ------------------------------------------------------------------------------------

// Keyed by pair and bar (one decision a bar): the bars decided under both readings or one only; of those under both,
// the moment, the side, already and the step; of the rides of a bar on the same side under both, when each was out.
const diffOf = (r1: Row[], r2: Row[]) => {
  const one = new Map(r1.map((r) => [keyOf(r), r]));
  const two = new Map(r2.map((r) => [keyOf(r), r]));
  if (one.size !== r1.length || two.size !== r2.length) throw new Error("two decisions at one bar of a pair");
  const keys = [...new Set([...one.keys(), ...two.keys()])].map((k) => ({ k, r: (one.get(k) ?? two.get(k)) as Row }));
  keys.sort((x, y) => x.r.open - y.r.open || pairIndex(x.r.pair) - pairIndex(y.r.pair));
  const steps: Record<string, number> = {};
  const d = {
    decisionsR1: r1.length,
    decisionsR2: r2.length,
    // bars decided under both readings, under R1 only, under R2 only
    both: 0,
    onlyR1: 0,
    onlyR2: 0,
    // of those under both: R2's moment earlier, later; another side; already under one reading only
    earlier: 0,
    later: 0,
    otherSide: 0,
    otherAlready: 0,
    // what the decision did, where it differs: "R1's step>R2's step"
    steps,
    tradesR1: r1.filter((r) => r.out !== null).length,
    tradesR2: r2.filter((r) => r.out !== null).length,
    // a ride of the bar on the same side under both readings: out at the same moment, earlier under R2, later
    tradesBoth: 0,
    outSame: 0,
    outEarlier: 0,
    outLater: 0,
    // a ride of the bar under one reading only (none, or one of the other side, under the other)
    tradesOnlyR1: 0,
    tradesOnlyR2: 0,
    // bars with no difference at all (the decision, and its ride's result, moment out and price out), and the rest
    same: 0,
    differ: 0,
  };
  const lines: string[] = [];
  const cells = (r: Row | undefined) =>
    r
      ? [iso(r.T0), r.source, r.side, r.step, String(r.entry), r.out ? r.out.result : "", r.out ? iso(r.out.T) : "", r.out ? String(r.out.pips) : "", r.out && r.out.late ? "1" : "0"]
      : ["", "", "", "", "", "", "", "", ""];
  for (const { k } of keys) {
    const a = one.get(k);
    const b = two.get(k);
    let other = false;
    if (a && b) {
      d.both++;
      if (b.T0 < a.T0) d.earlier++;
      else if (b.T0 > a.T0) d.later++;
      if (a.side !== b.side) d.otherSide++;
      if (a.already !== b.already) d.otherAlready++;
      if (a.step !== b.step) steps[`${a.step}>${b.step}`] = (steps[`${a.step}>${b.step}`] ?? 0) + 1;
      if (a.T0 !== b.T0 || a.side !== b.side || a.step !== b.step || a.entry !== b.entry || a.already !== b.already) other = true;
    } else if (a) {
      d.onlyR1++;
      other = true;
    } else {
      d.onlyR2++;
      other = true;
    }
    const x = a && a.out ? a.out : null;
    const y = b && b.out ? b.out : null;
    if (x && y && a && b && a.side === b.side) {
      d.tradesBoth++;
      if (y.T < x.T) d.outEarlier++;
      else if (y.T > x.T) d.outLater++;
      else d.outSame++;
      if (x.T !== y.T || x.result !== y.result || x.exit !== y.exit) other = true;
    } else {
      if (x) d.tradesOnlyR1++;
      if (y) d.tradesOnlyR2++;
    }
    if (!other) {
      d.same++;
      continue;
    }
    d.differ++;
    const r = (a ?? b) as Row;
    lines.push([r.pair, iso(r.open), ...cells(a), ...cells(b)].join(","));
  }
  return { d, lines };
};
type Diff = ReturnType<typeof diffOf>["d"];
const DIFF_CELLS = ["T0", "source", "side", "step", "entry", "result", "T", "pips", "late"];
const DIFF_HEAD = ["pair", "open", ...DIFF_CELLS.map((c) => `R1_${c}`), ...DIFF_CELLS.map((c) => `R2_${c}`)];

// ---- the study's rows (research/macd90m.ts way C, in at the moment the line touches 90%) ------------------

interface Study {
  meta: { start: string; end: string; loadFrom: string; reach: number };
  rows: Array<Record<string, string>>;
  groups: Record<string, { entries: number; already: number; C: Record<string, number | null> }>;
}

// the cells held against the study's, by its columns' names (research/macdride10-spec.md section 9 R1)
const CMP = ["pair", "open", "T0", "side", "entry", "share0", "already", "C_result", "C_T", "C_exit", "C_pips", "C_mae", "C_minutes", "C_share"];

const readStudy = async (dir: string): Promise<Study> => {
  const lines = (await Deno.readTextFile(`${dir}/rows.csv`)).split("\n").filter((l) => l.length > 0);
  const head = lines[0].split(",");
  for (const c of ["way", ...CMP]) if (!head.includes(c)) throw new Error(`${dir}/rows.csv has no column ${c}: not research/macd90m.ts's rows with way C`);
  const rows = lines.slice(1).map((l) => {
    const cells = l.split(",");
    if (cells.length !== head.length) throw new Error(`${dir}/rows.csv: a row of ${cells.length} cells under ${head.length} columns`);
    return Object.fromEntries(head.map((h, q) => [h, cells[q]]));
  });
  const s = JSON.parse(await Deno.readTextFile(`${dir}/summary.json`));
  return { meta: s.meta, rows: rows.filter((r) => r.way === "moment"), groups: s.ways.moment };
};

// a replay row as the study's cells (its csvOf's formats)
const studyCells = (r: Row): Record<string, string> => {
  const c = r.step === "skip"
    ? ["skipped", "", "", "", "", "", ""]
    : r.out
    ? [r.out.result, iso(r.out.T), String(r.out.exit), String(r.out.pips), String(r.out.mae), String(r.out.minutes), String(r.out.share)]
    : ["", "", "", "", "", "", ""];
  const cells = [r.pair, iso(r.open), iso(r.T0), r.side, String(r.entry), String(r.share0), isAlready(r) ? "1" : "0", ...c];
  return Object.fromEntries(CMP.map((h, q) => [h, cells[q]]));
};

// every difference between the replay's rows and the study's: an entry on one side only, or a cell (keyed by pair and
// bar: one decision a bar, as the study's one moment entry a bar)
const againstStudy = (rows: Row[], study: Study): { diffs: string[]; cells: number } => {
  const diffs: string[] = [];
  const mine = new Map(rows.map((r) => [keyOf(r), r]));
  if (mine.size !== rows.length) diffs.push("the replay holds two decisions at one bar of a pair");
  const seen = new Set<string>();
  let cells = 0;
  const show = (v: string) => (v === "" ? "(empty)" : v);
  for (const s of study.rows) {
    const key = `${s.pair}|${s.open}`;
    if (seen.has(key)) diffs.push(`${s.pair} ${s.open}: two rows of the study's at one bar`);
    seen.add(key);
    const r = mine.get(key);
    if (!r) {
      diffs.push(`${s.pair} ${s.open} ${s.T0} ${s.side}: an entry of the study's (${s.already === "1" ? "already" : s.C_result}), none in the replay`);
      continue;
    }
    const c = studyCells(r);
    for (const h of CMP) {
      cells++;
      if (c[h] !== s[h]) diffs.push(`${s.pair} ${s.open} ${s.T0} ${s.side} ${h}: the study ${show(s[h])}, the replay ${show(c[h])}`);
    }
  }
  for (const r of rows) if (!seen.has(keyOf(r))) diffs.push(`${r.pair} ${iso(r.open)} ${iso(r.T0)} ${r.side}: a decision of the replay's (${r.step}, ${r.source}), none in the study`);
  return { diffs, cells };
};

// R1's groups against the study's summary (all, each pair, BUY, SELL: entries, already, and every number of C)
const againstStudyGroups = (mine: Groups, study: Study): { diffs: string[]; numbers: number } => {
  const diffs: string[] = [];
  let numbers = 0;
  for (const [k, g] of Object.entries(study.groups)) {
    const m = mine[k];
    if (!m) {
      diffs.push(`summary ${k}: a group of the study's, none in the replay`);
      continue;
    }
    const pairs: Array<[string, number | null, number | null | undefined]> = [["entries", g.entries, m.entries], ["already", g.already, m.already]];
    for (const [f, v] of Object.entries(g.C)) pairs.push([`C.${f}`, v, (m.C as Record<string, number | null>)[f]]);
    for (const [f, theirs, ours] of pairs) {
      numbers++;
      if (theirs !== ours) diffs.push(`summary ${k} ${f}: the study ${theirs}, the replay ${ours}`);
    }
  }
  return { diffs, numbers };
};

// ---- docs §8.154's numbers ------------------------------------------------------------------------------

// What research/macdride10-spec.md quotes as measured (docs §8.154; GitHub Actions run 43789251553: the study's moment
// entry with way C at 95%), as printed there. The real run on the study's own span says whether R1 (the study's rows)
// still comes to them; it does not stop on it (R1 against the study's own rows is what stops it).
const DOCS_8154: Array<[string, (g: Groups) => string, string]> = [
  ["touches of 90% (entries)", (g) => String(g.all.entries), "2538"],
  ["already", (g) => String(g.all.already), "707"],
  ["skipped", (g) => String(g.all.C.skipped), "557"],
  ["trades", (g) => String(g.all.C.reached + g.all.C.open), "1274"],
  ["reached", (g) => String(g.all.C.reached), "1271"],
  ["plus", (g) => String(g.all.C.plus), "882"],
  ["minus", (g) => String(g.all.C.minus), "384"],
  ["zero", (g) => String(g.all.C.zero), "5"],
  ["pips a trade", (g) => fmt(g.all.C.pipsMean), "-0.03"],
  ["median pips", (g) => fmt(g.all.C.pipsMedian), "3.10"],
  ["pips sum", (g) => fmt(g.all.C.pipsSum, 1), "-42.1"],
  ["worst pips", (g) => fmt(g.all.C.pipsMin, 1), "-541.6"],
  ["largest loss on the way, median", (g) => fmt(g.all.C.maeMedian, 1), "7.3"],
  ["largest loss on the way, p90", (g) => fmt(g.all.C.maeP90, 1), "73.5"],
  ["largest loss on the way, max", (g) => fmt(g.all.C.maeMax, 1), "712.0"],
  ["minutes held, median", (g) => fmt(g.all.C.minutesMedian, 0), "38"],
  ["minutes held, p90", (g) => fmt(g.all.C.minutesP90, 0), "5075"],
  ["minutes held, max", (g) => fmt(g.all.C.minutesMax, 0), "29220"],
  ["reached within 1 hour", (g) => String(g.all.C.within60), "862"],
  ["reached within 1 day", (g) => String(g.all.C.within1440), "1087"],
  ["reached within 1 week", (g) => String(g.all.C.within10080), "1196"],
  ["open", (g) => String(g.all.C.open), "3"],
  ["open pips together", (g) => fmt(g.all.C.openPipsSum, 1), "-247.1"],
  ["open pips, the worst", (g) => fmt(g.all.C.openPipsWorst, 1), "-99.3"],
  ...([["USD/JPY", "245", "1.94"], ["EUR/JPY", "283", "1.54"], ["AUD/JPY", "248", "-2.19"], ["EUR/USD", "235", "-0.58"], ["AUD/USD", "260", "-1.06"], ["BUY", "660", "4.17"], ["SELL", "611", "-4.57"]] as const).flatMap(
    ([k, reached, pips]): Array<[string, (g: Groups) => string, string]> => [
      [`${k} reached`, (g) => (g[k] ? String(g[k].C.reached) : "-"), reached],
      [`${k} pips a trade`, (g) => (g[k] ? fmt(g[k].C.pipsMean) : "-"), pips],
    ],
  ),
];
const docsCheck = (g: Groups) => {
  const other = DOCS_8154.filter(([, f, want]) => f(g) !== want).map(([name, f, want]) => `${name}: docs §8.154 ${want}, here ${f(g)}`);
  return { same: other.length === 0, compared: DOCS_8154.length, other };
};

// ---- the rows and the summary ----------------------------------------------------------------------------

const HEAD = ["pair", "open", "T0", "source", "side", "entry", "x", "share0", "already", "step", "by", "result", "reached_bar", "T", "exit", "pips", "mae", "minutes", "share", "late"];
const csvOf = (rs: Row[]): string =>
  [
    HEAD.join(","),
    ...rs.map((r) =>
      [
        r.pair,
        iso(r.open),
        iso(r.T0),
        r.source,
        r.side,
        String(r.entry),
        String(r.x),
        String(r.share0),
        r.already ? "1" : "0",
        r.step,
        r.by === null ? "" : iso(r.by),
        ...(r.out
          ? [r.out.result, r.out.bar === null ? "" : iso(r.out.bar), iso(r.out.T), String(r.out.exit), String(r.out.pips), String(r.out.mae), String(r.out.minutes), String(r.out.share), r.out.late ? "1" : "0"]
          : ["", "", "", "", "", "", "", "", ""]),
      ].join(",")
    ),
  ].join("\n") + "\n";

interface PairRun {
  pair: string;
  bars: number;
  minutes: number;
  chart: ChartCheck;
  r1: Replay;
  r2: Replay;
  // R1's decisions in the hours the function does not watch
  unwatched: Unwatched;
  // the walks only: the pair's bars (kept for the checks), the lone reading (R2 with no minute read), and R2's
  // extremes against R1's at every minute
  a: PairIn | null;
  lone: Replay | null;
  extremes: Extremes | null;
}

const runPair = (a: PairIn, walk: boolean): PairRun => {
  const r1 = replayPair(a, { reading: "R1", minutes: true });
  return {
    pair: a.d.pair,
    bars: a.d.n,
    minutes: a.m1.n,
    chart: chartAgainstMinutes(a),
    r1,
    r2: replayPair(a, { reading: "R2", minutes: true }),
    unwatched: unwatchedOf(a, r1.rows),
    a: walk ? a : null,
    lone: walk ? replayPair(a, { reading: "R2", minutes: false }) : null,
    extremes: walk ? extremesOf(a) : null,
  };
};

const sumOf = (xs: number[]) => xs.reduce((s, x) => s + x, 0);

const summaryOf = (runs: PairRun[], studyDir: string, compared: { rows: number; cells: number; numbers: number } | null, docs: ReturnType<typeof docsCheck> | null) => {
  const r1 = ordered(runs.flatMap((p) => p.r1.rows));
  const r2 = ordered(runs.flatMap((p) => p.r2.rows));
  const diff: Record<string, Diff> = { all: diffOf(r1, r2).d };
  for (const p of runs) diff[p.pair] = diffOf(p.r1.rows, p.r2.rows).d;
  const g1 = groupsOf(r1);
  const g2 = groupsOf(r2);
  return {
    meta: { start: iso(START), end: iso(END), loadFrom: iso(LOAD_FROM), rule: RIDE_TOUCH_TAG, shareIn: RIDE_IN_SHARE, shareOut: RIDE_OUT_SHARE, study: studyDir, readings: READINGS },
    pairs: runs.map((p) => ({ pair: p.pair, bars: p.bars, minutes: p.minutes, decisionsR1: p.r1.rows.length, decisionsR2: p.r2.rows.length, chart: p.chart, unwatched: p.unwatched, week: p.r2.week })),
    r1: {
      // null: not held against the study (never written so in the real run: it stops before)
      equalsStudy: compared,
      caught: sumOf(runs.map((p) => p.r1.caught)),
      tails: sumOf(runs.map((p) => p.r1.tails)),
      stateless: sumOf(runs.map((p) => p.r1.stateless)),
      // R1's decisions whose read the function would not make
      unwatched: { decisions: r1.length, noState: sumOf(runs.map((p) => p.unwatched.noState)), gate: sumOf(runs.map((p) => p.unwatched.gate)) },
      measured: measuredOf(g1.all),
      groups: g1,
    },
    r2: {
      caught: sumOf(runs.map((p) => p.r2.caught)),
      caughtOlder: sumOf(runs.map((p) => p.r2.caughtOlder)),
      caughtEntryBar: sumOf(runs.map((p) => p.r2.caughtEntryBar)),
      tails: sumOf(runs.map((p) => p.r2.tails)),
      stateless: sumOf(runs.map((p) => p.r2.stateless)),
      week: {
        unstated: sumOf(runs.map((p) => p.r2.week.unstated)),
        unstatedGap: sumOf(runs.map((p) => p.r2.week.unstatedGap)),
        unjudged: sumOf(runs.map((p) => p.r2.week.unjudged)),
        gateMinutes: sumOf(runs.map((p) => p.r2.week.gateMinutes)),
      },
      beforeStart: sumOf(runs.map((p) => p.r2.beforeStart)),
      measured: measuredOf(g2.all),
      groups: g2,
    },
    r2AgainstR1: diff,
    docs8154: docs,
  };
};
type Summary = ReturnType<typeof summaryOf>;

function fmt(v: number | null, k = 2): string {
  return v === null ? "-" : v.toFixed(k);
}
const printC = (c: CStats) =>
  `held until reached: reached ${c.reached} (plus ${c.plus}, minus ${c.minus}, zero ${c.zero}) open ${c.open} skipped ${c.skipped} | pips sum ${fmt(c.pipsSum, 1)} mean ${fmt(c.pipsMean)} median ${fmt(c.pipsMedian)} min ${fmt(c.pipsMin, 1)} | mae median ${fmt(c.maeMedian, 1)} p90 ${fmt(c.maeP90, 1)} max ${fmt(c.maeMax, 1)} | minutes median ${fmt(c.minutesMedian, 0)} p90 ${fmt(c.minutesP90, 0)} max ${fmt(c.minutesMax, 0)} | within 1h ${c.within60} 1d ${c.within1440} 1w ${c.within10080} | open pips sum ${fmt(c.openPipsSum, 1)} worst ${fmt(c.openPipsWorst, 1)} mae max ${fmt(c.openMaeMax, 1)} minutes max ${fmt(c.openMinutesMax, 0)}`;
const printGroups = (gs: Groups) => {
  for (const [k, g] of Object.entries(gs)) {
    console.log(
      `${k.padEnd(8)} decisions ${g.entries} (by the tail ${g.tails}) already ${g.already} (notices ${g.at}, not sent ${g.quiet}) | trades ${g.C.reached + g.C.open}, of them reached in their entry bar ${g.inEntryBar}, seen by a close's catch-up ${g.late}`,
    );
    console.log(`  ${printC(g.C)}`);
  }
};
// research/macdride10-spec.md section 8's list, R2 beside R1
const printMeasured = (m1: Measured, m2: Measured) => {
  console.log("== the measured list (research/macdride10-spec.md section 8), all pairs: R2 (the function's reading and week) | R1 (the study's)");
  for (const k of Object.keys(m2) as Array<keyof Measured>) {
    const show = (v: number | null) => (v === null ? "-" : Number.isInteger(v) ? String(v) : v.toFixed(2));
    console.log(`  ${k.padEnd(14)} ${show(m2[k]).padStart(10)} | ${show(m1[k])}`);
  }
};
const printDiff = (k: string, d: Diff) => {
  const steps = Object.entries(d.steps).map(([s, n]) => `${s} ${n}`).join(", ");
  console.log(
    `${k.padEnd(8)} decisions R2 ${d.decisionsR2} (R1 ${d.decisionsR1}): bars under both ${d.both} (R2 earlier ${d.earlier}, later ${d.later}; another side ${d.otherSide}; already under one only ${d.otherAlready}; steps that differ (R1>R2): ${steps === "" ? "none" : steps}), under R1 only ${d.onlyR1}, under R2 only ${d.onlyR2} | trades R2 ${d.tradesR2} (R1 ${d.tradesR1}): a ride of the bar and side under both ${d.tradesBoth} (out at the same moment ${d.outSame}, earlier under R2 ${d.outEarlier}, later ${d.outLater}), under R2 only ${d.tradesOnlyR2}, under R1 only ${d.tradesOnlyR1} | bars that differ at all ${d.differ}, the same ${d.same}`,
  );
};
const printSummary = (s: Summary) => {
  console.log(`meta ${JSON.stringify(s.meta)}`);
  console.log(`pairs ${JSON.stringify(s.pairs.map((p) => ({ pair: p.pair, bars: p.bars, minutes: p.minutes, decisionsR1: p.decisionsR1, decisionsR2: p.decisionsR2 })))}`);
  console.log("== GMO's 1-hour bars against its 1-minute bars of the same hour (from START on)");
  for (const p of s.pairs) {
    console.log(`${p.pair.padEnd(8)} hours ${p.chart.hours}: with no 1-minute bar ${p.chart.noMinute}; chart high not the minutes' ${p.chart.highOther}, chart low not the minutes' ${p.chart.lowOther}; 1-minute bars in no 1-hour bar ${p.chart.minutesOutside}`);
  }
  console.log(`== R1 (${s.meta.readings.R1})`);
  console.log(
    s.r1.equalsStudy
      ? `R1 equals the study's moment rows with way C (${s.meta.study}): ${s.r1.equalsStudy.rows} rows, ${s.r1.equalsStudy.cells} cells, ${s.r1.equalsStudy.numbers} numbers of its summary; the catch-up found ${s.r1.caught}, the tail decided ${s.r1.tails}`
      : "R1 was not held against the study",
  );
  if (s.docs8154) console.log(s.docs8154.same ? `R1's numbers are docs §8.154's (${s.docs8154.compared} compared)` : `R1's numbers are NOT docs §8.154's: ${s.docs8154.other.join("; ")}`);
  console.log(`R1's decisions the function does not watch: ${s.r1.unwatched.noState + s.r1.unwatched.gate} of ${s.r1.unwatched.decisions} (in an hour whose state no judged close wrote, the week's first: ${s.r1.unwatched.noState}; read in the weekend gate: ${s.r1.unwatched.gate})`);
  printGroups(s.r1.groups);
  console.log(`== R2 (${s.meta.readings.R2})`);
  console.log(
    `the function's week, hours closing in [START, END): with no state written (no minute read) ${s.r2.week.unstated} (of them after a missing hour, not the week's first: ${s.r2.week.unstatedGap}), closes not judged ${s.r2.week.unjudged}, minutes not read in the weekend gate ${s.r2.week.gateMinutes} | decisions by the tail ${s.r2.tails} (in the bar opened an hour before START: ${s.r2.beforeStart}) | rides a close's catch-up found ${s.r2.caught} (in a bar older than the newest ${s.r2.caughtOlder}, in the ride's own entry bar ${s.r2.caughtEntryBar}) | hours without a state ${s.r2.stateless}`,
  );
  printGroups(s.r2.groups);
  printMeasured(s.r1.measured, s.r2.measured);
  console.log("== R2 against R1, keyed by pair and bar");
  for (const [k, d] of Object.entries(s.r2AgainstR1)) printDiff(k, d);
};

// ---- loading ------------------------------------------------------------------------------------------

// research/macd90m.ts's loadFiles, pair by pair; each pair replayed as it is read (its 1-minute bars are not kept
// outside the walks). `walkSeed` (the walks): the lone reading is run too, and the whole again on the walk with its bid
// and ask moved apart, and on that with the 1-minute bars of some hours taken out.
const runFiles = async (src: Source, walkSeed: number | null): Promise<{ runs: PairRun[]; st: LoadStats; apart: PairRun[]; holes: PairRun[] }> => {
  const st = newLoadStats();
  const runs: PairRun[] = [];
  const apart: PairRun[] = [];
  const holes: PairRun[] = [];
  const weekend = weekendOutOf("inside");
  for (const pair of PAIRS) {
    const h = await loadTf(src, pair, "1h", LOAD_FROM, END, st, weekend);
    const qs = quotesOf(h.bars);
    const d = dataOf(pair, qs);
    const m1 = await loadM1(src, pair, START, END, st);
    console.log(`${pair}: 1h ${h.bars.n} chart ${d.n} (from ${d.n ? iso(d.t[0]) : "-"}), 1min ${m1.n}`);
    if (st.failed) continue;
    const a = pairInOf(d, qs, m1);
    runs.push(runPair(a, walkSeed !== null));
    if (walkSeed === null) continue;
    const b = movedApart(a, walkSeed * 100 + runs.length);
    apart.push(runPair(b, true));
    holes.push(runPair(withHoles(b, walkSeed * 100 + 50 + runs.length), true));
  }
  return { runs, st, apart, holes };
};

const stopOnFailedFiles = (st: LoadStats) => {
  console.log(`files ${st.files} requests ${st.requests} cached ${st.cached} partial ${st.partial} failed ${st.failed} ${st.failedExamples.join("; ")}`);
  if (st.failed) {
    console.log("some files could not be read: stop");
    Deno.exit(1);
  }
};

// R1 against the study: the rows, the summary's numbers, the span and the reach, and the tail and the catch-up
const r1AgainstStudy = (runs: PairRun[], study: Study) => {
  const diffs: string[] = [];
  const meta = { start: iso(START), end: iso(END), loadFrom: iso(LOAD_FROM) };
  for (const k of ["start", "end", "loadFrom"] as const) if (study.meta[k] !== meta[k]) diffs.push(`the study's rows are of another span: its ${k} ${study.meta[k]}, here ${meta[k]}`);
  if (study.meta.reach !== RIDE_OUT_SHARE) diffs.push(`the study's rows are of another reach: its ${study.meta.reach}, here RIDE_OUT_SHARE ${RIDE_OUT_SHARE} (run research/macd90m.ts with REACH=0.95)`);
  const r1 = ordered(runs.flatMap((p) => p.r1.rows));
  const rowsCheck = againstStudy(r1, study);
  diffs.push(...rowsCheck.diffs);
  const groupsCheck = againstStudyGroups(groupsOf(r1), study);
  diffs.push(...groupsCheck.diffs);
  for (const p of runs) {
    if (p.r1.caught) diffs.push(`${p.pair}: the catch-up found ${p.r1.caught} rides under R1, ${p.r1.caughtOlder} of them in a bar older than the newest closed one, ${p.r1.caughtEntryBar} in the entry bar (every minute was read: it must find none)`);
    if (p.r1.tails) diffs.push(`${p.pair}: the tail decided ${p.r1.tails} bars under R1 (every minute was read: it must find none)`);
    for (const r of p.r1.rows) if (r.out && r.out.late) diffs.push(`${p.pair} ${iso(r.T0)} ${r.side}: under R1 seen by the catch-up in the bar opened ${r.out.bar === null ? "-" : iso(r.out.bar)}`);
  }
  return { diffs, compared: { rows: study.rows.length, cells: rowsCheck.cells, numbers: groupsCheck.numbers } };
};

const printDiffs = (what: string, diffs: string[]) => {
  console.log(`${what}: ${diffs.length} differences${diffs.length > 20 ? " (the first 20)" : ""}`);
  for (const x of diffs.slice(0, 20)) console.log(`  ${x}`);
};

// ---- the checks on a walk --------------------------------------------------------------------------------

// An hour with no minute read is decided by the tail iff its chart extreme touches 90% on a side its Zp is not at
// (research/macdride10-spec.md section 9 "Walks", holes): rideHit on the closed bar as the chart draws it, the
// decision's side, already and moment the tail's. `noRead(j)`: the reading reads no minute of bar j. Held only where
// the function judges the bar's close: one in the weekend gate has no tail (section 4 "unwatched moments"), and there
// the reading must decide nothing. Returns the hours held and those of them decided.
const tailIff = (a: PairIn, rs: Row[], noRead: (j: number) => boolean, name: string, bad: (msg: string) => void) => {
  const by = new Map(rs.map((r) => [r.i, r]));
  let hours = 0;
  let decided = 0;
  for (let j = W - 1; j < a.d.n; j++) {
    const T = a.d.t[j] + HOUR;
    if (T < START || T >= END || !noRead(j)) continue;
    const r = by.get(j);
    if (!a.judged[j]) {
      if (r) bad(`${a.d.pair} ${iso(a.d.t[j])} ${name}: a decision in an hour with no minute read whose close is not judged`);
      continue;
    }
    const sz = a.sz[j];
    const hit = sz === null ? null : rideHit(sz.state, sz.zp, a.ch[j], a.cl[j]);
    hours++;
    if ((hit === null) !== (r === undefined)) {
      bad(`${a.d.pair} ${iso(a.d.t[j])} ${name}: an hour with no minute read, the chart's bar ${hit ? "hits" : "does not hit"} 90%, the reading ${r ? `decided ${r.step} (${r.source})` : "decided nothing"}`);
      continue;
    }
    if (!hit || !r) continue;
    decided++;
    if (r.source !== "close" || r.T0 !== T || r.zside !== hit.zside || r.already !== hit.already || r.x !== hit.x) bad(`${a.d.pair} ${iso(a.d.t[j])} ${name}: the tail's decision is not the chart bar's hit`);
  }
  return { hours, decided };
};

// The lone reading (no minute read) against R2 (research/macdride10-spec.md section 9 "Walks"): the same bars decided
// (any step), on R2's side unless both sides touched 90% in the bar (then the top side), already wherever R2's decision
// on that side is; every reach late, out at the close it is found at. Both go by the function's week, so this is held
// on the bars whose close is judged: a bar closing in the weekend gate has no tail, so the lone reading decides nothing
// there while R2's minutes before the gate can (spec question: section 9 does not say; such bars are counted). A
// touch in such a bar is found at the next close judged (the week's first), so "the close it is found at" is the first
// close judged from the reach's bar on.
const loneAgainstR2 = (a: PairIn, r2: Replay, lone: Replay, bad: (msg: string) => void) => {
  const { d } = a;
  const two = new Map(r2.rows.map((r) => [r.i, r]));
  const one = new Map(lone.rows.map((r) => [r.i, r]));
  let compared = 0;
  let r2Unjudged = 0;
  for (let j = W - 1; j < d.n; j++) {
    const T = d.t[j] + HOUR;
    if (T < START || T >= END) continue;
    const b = two.get(j);
    const x = one.get(j);
    if (!a.judged[j]) {
      if (x) bad(`${d.pair} ${iso(d.t[j])}: the lone reading decided a bar whose close is not judged`);
      if (b) r2Unjudged++;
      continue;
    }
    compared++;
    if (!b !== !x) {
      bad(`${d.pair} ${iso(d.t[j])}: the lone reading ${x ? `decided ${x.step}` : "decided nothing"}, R2 ${b ? `decided ${b.step} (${b.source})` : "nothing"}`);
      continue;
    }
    if (!b || !x) continue;
    const sz = a.sz[j] as StateZp;
    const touched = (zs: RideZoneSide) => !atShare(sz.zp, zs, RIDE_IN_SHARE) && rideTouchAt(sz.state, zs, zs === "top" ? a.ch[j] : a.cl[j], RIDE_IN_SHARE) !== null;
    const want: RideZoneSide = touched("top") && touched("bottom") ? "top" : b.zside;
    if (x.zside !== want) bad(`${d.pair} ${iso(d.t[j])}: the lone reading on the ${x.zside} side, R2 on the ${b.zside}, want ${want}`);
    if (x.zside === b.zside && b.already && !x.already) bad(`${d.pair} ${iso(d.t[j])}: R2 already on the ${b.zside} side, the lone reading not`);
    if (x.source !== "close" || x.T0 !== T) bad(`${d.pair} ${iso(d.t[j])}: a lone decision not at the bar's close`);
  }
  // the first close judged from each bar on
  const nextJudged = new Array<number>(d.n).fill(NaN);
  for (let j = d.n - 1, c = NaN; j >= 0; j--) {
    if (a.judged[j]) c = d.t[j] + HOUR;
    nextJudged[j] = c;
  }
  const index = new Map(d.t.map((t, j) => [t, j]));
  let reached = 0;
  for (const x of lone.rows) {
    if (!x.out || x.out.result !== "reached") continue;
    reached++;
    const o = x.out;
    const jb = o.bar === null ? undefined : index.get(o.bar);
    if (!o.late) bad(`${d.pair} ${iso(x.T0)}: the lone reading reached a ride not late`);
    if (jb === undefined || o.T !== nextJudged[jb]) bad(`${d.pair} ${iso(x.T0)}: the lone reading's ride reached in ${o.bar === null ? "-" : iso(o.bar)} is out at ${iso(o.T)}, not at the close it is found at`);
    if (!(o.share >= RIDE_OUT_SHARE)) bad(`${d.pair} ${iso(x.T0)}: the catch-up's share ${o.share} is under 95%`);
  }
  return { compared, r2Unjudged, reached };
};

// What must hold between the readings of one pair on a walk. `whole`: its 1-hour bars are made of its 1-minute bars,
// none taken out. `oneSpread`: the walk as written (its bid and ask move as one).
const checkReadings = (p: PairRun, whole: boolean, oneSpread: boolean, bad: (msg: string) => void) => {
  const a = p.a as PairIn;
  const lone = p.lone as Replay;
  const ex = p.extremes as Extremes;
  // the chart's high and low are then what R2 ends each hour with
  if (whole && (p.chart.noMinute || p.chart.highOther || p.chart.lowOther || p.chart.minutesOutside)) bad(`${p.pair}: the walk's 1-hour bars are not its 1-minute bars' (${JSON.stringify(p.chart)})`);
  // R1 reads every minute and its closed bars are what it read: its tail and catch-up find nothing on any walk
  if (p.r1.caught) bad(`${p.pair}: the catch-up found ${p.r1.caught} rides under R1`);
  if (p.r1.tails) bad(`${p.pair}: the tail decided ${p.r1.tails} bars under R1`);
  if (p.r1.stateless || p.r2.stateless) bad(`${p.pair}: hours without a state`);
  for (const [name, rs] of [["R1", p.r1.rows], ["R2", p.r2.rows], ["the lone reading", lone.rows]] as Array<[string, Row[]]>) {
    const g = groupOf(rs);
    if (g.C.reached + g.C.open + g.C.skipped + g.already !== g.entries || g.at + g.quiet !== g.already || g.C.plus + g.C.minus + g.C.zero !== g.C.reached) bad(`${p.pair} ${name}: the counts do not add up`);
    for (const x of stepsByRule(rs)) bad(`${name}: ${x}`);
  }
  // R2's tail decides and its catch-up reaches only in a bar R2's minute reads did not see whole: one with a minute it
  // did not read, or whose chart bar holds more than its minutes (an hour cut short by withHoles). Elsewhere the chart's
  // bar is what R2's reads ended the hour with, and its last minute was read.
  const index = new Map(a.d.t.map((t, j) => [t, j]));
  const seen = (j: number) => {
    if (!p.r2.whole[j]) return false;
    let bh = -Infinity;
    let ah = -Infinity;
    let bl = Infinity;
    let al = Infinity;
    for (let k = a.k0[j]; k < a.k1[j]; k++) {
      if (a.m1.bh[k] > bh) bh = a.m1.bh[k];
      if (a.m1.ah[k] > ah) ah = a.m1.ah[k];
      if (a.m1.bl[k] < bl) bl = a.m1.bl[k];
      if (a.m1.al[k] < al) al = a.m1.al[k];
    }
    return midOf(bh, ah, a.dec) === a.ch[j] && midOf(bl, al, a.dec) === a.cl[j];
  };
  for (const r of p.r2.rows) {
    if (r.source === "close" && seen(r.i)) bad(`${p.pair} ${iso(r.open)}: R2's tail decided a bar its minute reads saw whole`);
    const jb = r.out && r.out.late && r.out.bar !== null ? index.get(r.out.bar) : undefined;
    if (jb !== undefined && seen(jb)) bad(`${p.pair} ${iso(r.T0)}: R2's catch-up reached a ride in ${iso(a.d.t[jb])}, a bar its minute reads saw whole`);
  }
  // a minute ride not reached by a read in its entry bar, whose entry bar's chart extreme (the closed bar as the chart
  // draws it) touches 95% on its side: reached by that bar's close's catch-up, late, in its entry bar, out at that
  // close (research/macdride10-spec.md section 4 A.3; section 7's "a minute ride whose entry bar's last moments touch
  // 95% after the last minute's read"), when that close is judged
  for (const r of p.r2.rows) {
    if (r.step !== "in" || r.source !== "minute" || !a.judged[r.i]) continue;
    const o = r.out as Out;
    if (o.result === "reached" && !o.late && o.bar === r.open) continue;
    const sz = a.sz[r.i] as StateZp;
    const touch = rideTouch(sz.state, r.zside, a.ch[r.i], a.cl[r.i]);
    const caughtThere = o.result === "reached" && o.late && o.bar === r.open && o.T === r.open + HOUR;
    if ((touch !== null) !== caughtThere) bad(`${p.pair} ${iso(r.T0)}: a minute ride whose entry bar's chart extreme ${touch ? "touches" : "does not touch"} 95%, ${caughtThere ? "reached by the catch-up in that bar" : `out ${o.result} at ${iso(o.T)}`}`);
  }
  // moved prices: R2's high never under R1's, its low never over
  if (ex.under) bad(`${p.pair}: R2's extremes inside R1's at ${ex.under} minutes`);
  // the same extremes and fewer reads: R2 is never earlier than R1 (a decision of a bar, or the ride of a bar and side)
  if (oneSpread && ex.apart === 0) {
    const d = diffOf(p.r1.rows, p.r2.rows).d;
    if (d.earlier || d.outEarlier) bad(`${p.pair}: with R1's extremes R2 decided earlier in ${d.earlier} bars and was out earlier in ${d.outEarlier} rides`);
  }
  // the hours with no minute read (R2: none in the hour, or no state; the lone reading: every hour)
  tailIff(a, p.r2.rows, (j) => a.k1[j] === a.k0[j] || !a.stated[j], "R2", bad);
  tailIff(a, lone.rows, () => true, "the lone reading", bad);
  // R1, like the study, decides nothing in an hour with no 1-minute bar
  for (const r of p.r1.rows) if (a.k1[r.i] === a.k0[r.i]) bad(`${p.pair} ${iso(r.open)}: R1 decided an hour with no 1-minute bar`);
  return loneAgainstR2(a, p.r2, lone, bad);
};

const checkWalk = async (seed: number): Promise<number> => {
  let fail = 0;
  const bad = (msg: string) => {
    fail++;
    if (fail <= 30) console.log(`  CHECK FAILED: ${msg}`);
  };
  const dir = `${OUT}/walk${seed}`;
  let study: Study;
  try {
    study = await readStudy(dir);
  } catch (e) {
    console.log(`walk seed ${seed}: the study's rows are not in ${dir} (${e instanceof Error ? e.message : e})`);
    console.log(`  make them first: MODE=walkfiles REACH=0.95 SEEDS=${seed} OUT=${dir} deno run --allow-read=. --allow-write=research/out --allow-env research/macd90m.ts`);
    return 1;
  }
  const { runs, st, apart, holes } = await runFiles({ dir: `${dir}/gmo`, fetch: false }, seed);
  stopOnFailedFiles(st);

  // R1 is the study, row for row and number for number
  const eq = r1AgainstStudy(runs, study);
  if (eq.diffs.length) {
    printDiffs(`walk seed ${seed}: R1 against the study's rows`, eq.diffs);
    fail += eq.diffs.length;
  }
  const s = summaryOf(runs, dir, eq.diffs.length ? null : eq.compared, null);
  const sa = summaryOf(apart, dir, null, null);
  const sh = summaryOf(holes, dir, null, null);
  await Deno.mkdir(`${dir}/replay`, { recursive: true });
  const rowsOf = (ps: PairRun[], reading: Reading | "lone") => ordered(ps.flatMap((p) => (reading === "R1" ? p.r1.rows : reading === "R2" ? p.r2.rows : (p.lone as Replay).rows)));
  await Deno.writeTextFile(`${dir}/replay/rows-R1.csv`, csvOf(rowsOf(runs, "R1")));
  await Deno.writeTextFile(`${dir}/replay/rows-R2.csv`, csvOf(rowsOf(runs, "R2")));
  await Deno.writeTextFile(`${dir}/replay/rows-lone.csv`, csvOf(rowsOf(runs, "lone")));
  await Deno.writeTextFile(`${dir}/replay/r2-vs-r1.csv`, [DIFF_HEAD.join(","), ...diffOf(rowsOf(runs, "R1"), rowsOf(runs, "R2")).lines].join("\n") + "\n");
  await Deno.writeTextFile(`${dir}/replay/summary.json`, JSON.stringify(s, null, 1));
  await Deno.writeTextFile(`${dir}/replay/apart-rows-R1.csv`, csvOf(rowsOf(apart, "R1")));
  await Deno.writeTextFile(`${dir}/replay/apart-rows-R2.csv`, csvOf(rowsOf(apart, "R2")));
  await Deno.writeTextFile(`${dir}/replay/apart-r2-vs-r1.csv`, [DIFF_HEAD.join(","), ...diffOf(rowsOf(apart, "R1"), rowsOf(apart, "R2")).lines].join("\n") + "\n");
  await Deno.writeTextFile(`${dir}/replay/holes-rows-R2.csv`, csvOf(rowsOf(holes, "R2")));

  // the walk gives the checks something to hold: trades reached (also in their entry bar), already, skipped, quiet
  const g1 = s.r1.groups.all;
  if (g1.C.reached === 0 || g1.already === 0 || g1.C.skipped === 0 || g1.inEntryBar === 0) {
    bad(`the walk has no reached trade, no already decision, no skipped one or no ride reached in its entry bar (reached ${g1.C.reached}, already ${g1.already}, skipped ${g1.C.skipped}, in the entry bar ${g1.inEntryBar}): too little compared`);
  }
  const lone = { compared: 0, r2Unjudged: 0, reached: 0 };
  const add = (x: typeof lone) => {
    lone.compared += x.compared;
    lone.r2Unjudged += x.r2Unjudged;
    lone.reached += x.reached;
  };
  for (const p of runs) add(checkReadings(p, true, true, bad));
  // the walk as it is: R2's extremes are R1's (one spread), so R2 is never earlier than R1 there (held per pair where so)
  const plainApart = runs.map((p) => (p.extremes as Extremes).apart);
  // R2's own week: some decisions by the tail and some rides reached by the catch-up (the week's first hours)
  if (s.r2.tails === 0 || s.r2.caught === 0) bad(`the walk as it is: R2's tail decided ${s.r2.tails} bars and its catch-up reached ${s.r2.caught} rides: the week's part in R2 was not checked`);

  // the same walk with its bid and ask moved apart: R2's extremes are no longer R1's, and R2 is earlier somewhere
  for (const p of apart) add(checkReadings(p, true, false, bad));
  const da = sa.r2AgainstR1.all;
  const apartMinutes = sumOf(apart.map((p) => (p.extremes as Extremes).apart));
  if (apartMinutes === 0 || da.earlier + da.outEarlier === 0) bad(`bid and ask moved apart: R2's extremes differ from R1's at ${apartMinutes} minutes, R2 decided earlier in ${da.earlier} bars and was out earlier in ${da.outEarlier} rides: R2's own way was not checked`);

  // and with the 1-minute bars of some hours taken out: such an hour is decided by the tail, and a ride touched in it is
  // reached by the close's catch-up
  let holeTails = 0;
  let holeCaught = 0;
  for (const p of holes) {
    add(checkReadings(p, false, false, bad));
    const a = p.a as PairIn;
    const hole = (j: number) => a.k1[j] === a.k0[j] && a.d.t[j] >= START;
    holeTails += p.r2.rows.filter((r) => r.source === "close" && hole(r.i)).length;
    const index = new Map(a.d.t.map((t, j) => [t, j]));
    holeCaught += p.r2.rows.filter((r) => r.out && r.out.late && r.out.bar !== null && hole(index.get(r.out.bar) as number)).length;
  }
  const noMinute = sumOf(holes.map((p) => p.chart.noMinute));
  const cutShort = sumOf(holes.map((p) => p.chart.highOther + p.chart.lowOther));
  if (holeTails === 0 || holeCaught === 0) bad(`hours without 1-minute bars: R2's tail decided ${holeTails} of them and its catch-up reached ${holeCaught} rides in them: their part in R2 was not checked`);
  if (sh.r2.caughtEntryBar === 0) bad("hours cut short: no minute ride was reached by the catch-up in its own entry bar: section 4 A.3's part in R2 was not checked");
  if (lone.compared === 0 || lone.reached === 0) bad(`the lone reading: ${lone.compared} bars compared, ${lone.reached} rides reached: its check compared nothing`);

  console.log(
    `walk seed ${seed}: R1 against the study: ${eq.compared.rows} rows, ${eq.compared.cells} cells, ${eq.compared.numbers} numbers of its summary, ${eq.diffs.length} differences; the lone reading against R2: ${lone.compared} bars compared (all three walks), ${lone.reached} rides reached late; R2 decisions in a bar whose close is not judged (the lone reading cannot see them): ${lone.r2Unjudged}; on the walk as it is R2's extremes differ from R1's at ${sumOf(plainApart)} minutes (R2 never earlier than R1 held on ${plainApart.filter((n) => n === 0).length} of ${plainApart.length} pairs)`,
  );
  printSummary(s);
  console.log(`== walk seed ${seed} with its bid and ask moved apart (no study's rows for it: R2 against R1 only); R2's extremes differ from R1's at ${apartMinutes} minutes`);
  console.log(`R1 all   ${printC(sa.r1.groups.all.C)}`);
  console.log(`R2 all   ${printC(sa.r2.groups.all.C)}`);
  for (const [k, d] of Object.entries(sa.r2AgainstR1)) printDiff(k, d);
  console.log(
    `== walk seed ${seed}, bid and ask moved apart, the 1-minute bars of ${noMinute} hours taken out and others cut short (chart highs and lows not the minutes': ${cutShort}): R2's tail decided ${holeTails} of the hours taken out and its catch-up reached ${holeCaught} rides in them (in all: tail ${sh.r2.tails}, catch-up ${sh.r2.caught}, of them in a bar older than the newest ${sh.r2.caughtOlder}, in the ride's own entry bar ${sh.r2.caughtEntryBar}); under R1 tail ${sh.r1.tails}, catch-up ${sh.r1.caught}`,
  );
  console.log(`R1 all   ${printC(sh.r1.groups.all.C)}`);
  console.log(`R2 all   ${printC(sh.r2.groups.all.C)}`);
  printDiff("all", sh.r2AgainstR1.all);
  return fail;
};

// ---- main --------------------------------------------------------------------------------------------

if (import.meta.main) {
  if (MODE === "synthetic") {
    let fail = 0;
    for (const seed of env("SEEDS", "1,2").split(",").map(Number)) fail += await checkWalk(seed);
    console.log(fail === 0 ? "ALL REPLAY CHECKS PASSED" : `${fail} REPLAY CHECKS FAILED`);
    if (fail) Deno.exit(1);
  } else if (MODE === "real") {
    await Deno.mkdir(OUT, { recursive: true });
    const study = await readStudy(STUDY);
    const { runs, st } = await runFiles({ dir: "research/.cache", fetch: true }, null);
    stopOnFailedFiles(st);
    await Deno.writeTextFile(`${OUT}/rows-R1.csv`, csvOf(ordered(runs.flatMap((p) => p.r1.rows))));
    const eq = r1AgainstStudy(runs, study);
    if (eq.diffs.length) {
      printDiffs(`R1 DIFFERS FROM THE STUDY'S ROWS (${STUDY})`, eq.diffs);
      console.log("R2's numbers are not printed: the replay is not the study under the study's own reading");
      Deno.exit(1);
    }
    const own = iso(START) === START_DEFAULT && iso(END) === END_DEFAULT && iso(LOAD_FROM) === LOAD_FROM_DEFAULT;
    const r1 = ordered(runs.flatMap((p) => p.r1.rows));
    const r2 = ordered(runs.flatMap((p) => p.r2.rows));
    // what each decision did, said again from the rows (the notices not sent, and all of R2, are in no row of the
    // study's)
    const rule = [...stepsByRule(r1).map((x) => `R1: ${x}`), ...stepsByRule(r2).map((x) => `R2: ${x}`)];
    if (rule.length) {
      printDiffs("THE STEPS ARE NOT THE RULE'S ON THE REPLAY'S OWN ROWS", rule);
      Deno.exit(1);
    }
    const s = summaryOf(runs, STUDY, eq.compared, own ? docsCheck(groupsOf(r1)) : null);
    await Deno.writeTextFile(`${OUT}/rows-R2.csv`, csvOf(r2));
    await Deno.writeTextFile(`${OUT}/r2-vs-r1.csv`, [DIFF_HEAD.join(","), ...diffOf(r1, r2).lines].join("\n") + "\n");
    await Deno.writeTextFile(`${OUT}/summary.json`, JSON.stringify(s, null, 1));
    console.log(`written: R1 ${r1.length} decisions, R2 ${r2.length}`);
    printSummary(s);
  } else if (MODE === "print") {
    printSummary(JSON.parse(await Deno.readTextFile(`${OUT}/summary.json`)));
  } else {
    console.log(`MODE ${MODE}: not one of real, synthetic, print`);
    Deno.exit(1);
  }
}
