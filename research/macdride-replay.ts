// The owner (2026-11-12): 「MACD 90%→96%: 足の確定で入ると 96% まで行く メールをこれに変更、なので、一つのペアで2回
// メールを送る」 (#397, docs §8.150). The MACD email becomes a ride (research/macdride-spec.md): email 1 at the close of
// the 1-hour bar at which the line came into the 90% band, email 2 when the line reaches 96%. This is the replay of that
// file's section 9: the code the function runs (supabase/functions/_shared/macd-ride.ts: rideEntryAt, rideCloseStep,
// rideStateOf, rideTouch, rideCatchUp) driven over the five pairs' bars as the function would, with the rides kept in
// memory. At each 1-hour bar's close: the catch-up of the rides held, then the entry (in: a ride is opened; at; skip;
// quiet). Through the 1-minute bars of the next hour: the touch against that hour's state, with the hour's high and low
// so far. A touch ends the ride at that minute: out at the minute's close on the leaving side (research/macd90m-spec.md
// "Following it"), so its pips and minutes are the study's kind. A ride the catch-up finds is out at that bar's close.
//
// Two readings of "the hour's high and low so far":
//   R1  the highest of the 1-minute mid highs so far (each round_chart((bid high + ask high) / 2, d)) and the lowest of
//       the mid lows: the study's reading (research/macd90m.ts reads each minute's own; the line rises with the price,
//       so the highest so far touches in the minute the study's does). Under R1 every entry must be the study's way C
//       "close" row (docs §8.149): the same entries, already rows, skipped rows, and each trade's result, moment out,
//       price out, pips, worst against, minutes and share; and the catch-up must find nothing. Any difference: the
//       first 20 are printed and the run stops.
//   R2  round_chart((the highest bid high so far + the highest ask high so far) / 2, d), and the lows likewise: what
//       GMO's forming 1-hour bar gives, which is what the function reads each minute. Never under R1's high nor over
//       its low, so a ride of the same entry is reached in the same minute or an earlier one, and a ride that ends in
//       an earlier bar can let in an entry R1 skipped. Its numbers are the measurement of the function's own reading.
//
// What a close's catch-up reads as the closed bars' highs and lows: under R1, what R1 ended each hour with (so it can
// find nothing the minutes did not: asserted); under R2, the chart's own closed 1-hour bars (live-chart historyRead,
// GMO's 1-hour files), as the function's catch-up does. Where GMO's 1-hour bar and its 1-minute bars of the same hour
// agree that is what R2 ended the hour with, and the catch-up finds nothing; how many hours differ is counted and
// printed, and so is every ride the catch-up found.
//
// Not replayed (research/macdride-spec.md section 10): the function sees a touch when a run reads it and prices
// email 2 then; the hours it does not run; a bar judged again by a later run. Gold and the shares are not measured.
//
//   MODE=real       GMO's 1-hour and 1-minute files (research/.cache, fetched when missing: the loaders
//                   research/macd90m.ts uses) and the study's rows: STUDY/rows.csv and STUDY/summary.json, written by
//                   research/macd90m.ts MODE=real, which the workflow runs first (that file exports nothing, so its
//                   rows are read from its files, not made in this process). Writes OUT/rows-R1.csv; when R1 equals the
//                   study, OUT/{rows-R2.csv,r2-vs-r1.csv,summary.json}, and prints the numbers.
//   MODE=synthetic  the same on seeded walks. For each seed of SEEDS, OUT/walk<seed> must be what
//                   `MODE=walkfiles SEEDS=<seed> OUT=<OUT>/walk<seed> research/macd90m.ts` left: the walk as GMO's files
//                   (gmo/) and the study's rows on it. And the checks: R1 equals the study's rows and its summary's
//                   numbers; the catch-up finds nothing under R1; the walk's 1-hour bars are its 1-minute bars' (so
//                   nothing under R2 either); no ride of the same entry is reached later under R2; and, with no minute
//                   read at all, the catch-up alone reaches every ride of R2 in the same bar. A walk's bid and ask keep
//                   one spread, so R2 is R1 on it: the last three are held again on the walk with its bid and ask
//                   moved apart (movedApart), where R2 must differ from R1 somewhere; and once more with the 1-minute
//                   bars of some hours taken out (withHoles), where R2's rides must be seen by the close's catch-up
//                   in the bar the catch-up alone sees them in. What each close did is also said again from the rows
//                   (stepsByRule), under every reading.
//   MODE=print      the summary the real run wrote.
//
// Nothing here sends an email or writes a table; the numbers are the replay's only.

import { historyRead } from "../supabase/functions/live-chart/logic.ts";
import type { QuoteCandle } from "../supabase/functions/track-outcomes/quotes.ts";
import { LEVEL_WINDOW } from "../supabase/functions/_shared/macd-level.ts";
import {
  RIDE_IN_SHARE,
  RIDE_OUT_SHARE,
  RIDE_RULE_TAG,
  type RideBar,
  rideCatchUp,
  rideCloseStep,
  rideEntryAt,
  type RideRow,
  type RideSide,
  rideStateOf,
  type RideStep,
  rideTouch,
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
// where research/macd90m.ts MODE=real wrote its rows.csv and summary.json
const STUDY = env("STUDY", "research/out/macd90m");
const W = LEVEL_WINDOW;

type Reading = "R1" | "R2";
const READINGS: Record<Reading, string> = {
  R1: "the highest of the 1-minute mid highs so far and the lowest of the mid lows: the study's reading",
  R2: "the mid of the highest bid high and the highest ask high so far, and of the lows: GMO's forming 1-hour bar, the function's reading",
};

// ---- one pair's bars ----------------------------------------------------------------------------------

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
  return { d, m1, ch, cl, k0: d.t.map((t) => lowerBound(m1.t, t)), k1: d.t.map((t) => lowerBound(m1.t, t + HOUR)), dec: decimalsOf(d.pair) };
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
    if (Number(((bh + ah) / 2).toFixed(dec)) !== a.ch[j]) highOther++;
    if (Number(((bl + al) / 2).toFixed(dec)) !== a.cl[j]) lowOther++;
  }
  return { hours, noMinute, highOther, lowOther, minutesOutside: m1.n - inside };
};
type ChartCheck = ReturnType<typeof chartAgainstMinutes>;

// A walk's bid and ask move as one (one spread), so an hour's highest bid high and highest ask high fall in the same
// minute and R2 reads what R1 reads. For R2's own way to be checked on a walk: the same walk with the two moved apart,
// about four in ten of the minutes' ask highs raised and as many of their bid lows lowered by 0.5 to 8 pips (the ask
// stays over the bid; no close moves, so the 1-hour closes and the entries stay), and the chart's 1-hour high and low
// redrawn from these minutes as GMO's 1-hour bar of them would be. No study's rows exist for it: R1 on it is held
// against nothing but R2. (With these sizes both seeded walks of the workflow hold rides reached earlier under R2 and
// an entry R1 skipped and R2 took.)
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
    ch[j] = Number(((hb + ha) / 2).toFixed(dec));
    cl[j] = Number(((lb + la) / 2).toFixed(dec));
  }
  return { ...a, m1: { ...m1, ah, bl }, ch, cl };
};

// GMO's 1-minute files can lack what its 1-hour file holds. A walk again with the 1-minute bars of about one hour in
// twelve taken out and its 1-hour bars as they were: a touch in such an hour is in no minute read, and under R2 the
// catch-up of that hour's close finds it in the chart's bar (R1, like the study, reads nothing there).
const withHoles = (a: PairIn, seed: number): PairIn => {
  const { d, m1 } = a;
  const rnd = mulberry32(seed);
  const keep: number[] = [];
  for (let j = 0; j < d.n; j++) {
    if (a.k1[j] === a.k0[j] || rnd() < 1 / 12) continue;
    for (let k = a.k0[j]; k < a.k1[j]; k++) keep.push(k);
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
  // found by a close's catch-up, not in a minute (the function's `late`): out at that bar's close
  late: boolean;
}
// one entry: a bar's close at which the line came into the 90% band, and what the close did with it
interface Row {
  pair: string;
  i: number;
  open: number;
  T0: number;
  side: RideSide;
  zside: RideZoneSide;
  // the price paid: the bar's ask close for a BUY, its bid close for a SELL (on every row, as the study's)
  entry: number;
  share0: number;
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
  // false: no minute is read for a touch (the catch-up alone; the walks' check of it)
  minutes: boolean;
}
interface Replay {
  rows: Row[];
  // rides the catch-up found, and those of them found in a bar older than the newest closed one
  caught: number;
  caughtOlder: number;
  // hours followed whose state could not be made (a close that is no number)
  stateless: number;
}

const replayPair = (a: PairIn, o: Opts): Replay => {
  const { d, m1, dec } = a;
  const rows: Row[] = [];
  // the rides held: at most one a side
  const held: Held[] = [];
  // the closed bars as a close's catch-up reads them. R1: the high and low R1 ended each followed hour with (NaN where
  // no minute was read: no touch). R2: the chart's own.
  const bars: RideBar[] = d.t.map((t, j) => ({ t, high: o.reading === "R1" ? NaN : a.ch[j], low: o.reading === "R1" ? NaN : a.cl[j], close: d.mid[j] }));
  let caught = 0;
  let caughtOlder = 0;
  let stateless = 0;

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

  // the 1-minute bars read so far: [0, kp)
  let kp = 0;
  for (let j = W - 1; j < d.n; j++) {
    const barOpen = d.t[j];
    // the rides reached in this bar, or by this close's catch-up (the rows the close step reads beside those held)
    const reachedHere: Held[] = [];

    // ---- through bar j's minutes: the rides opened at an earlier close
    if (held.length > 0) {
      // a 1-minute bar in no 1-hour bar has no line to be read with: it counts for the worst against a trade only
      // (as in the study; a ride is followed from the first minute of the bar after its entry bar)
      for (let k = kp; k < a.k0[j]; k++) for (const h of held) if (k >= h.kFrom) against(h, k);
      const state = o.minutes ? rideStateOf(d.mid.slice(j - (W - 1), j)) : null;
      if (o.minutes && state === null) stateless++;
      let hi = NaN;
      let lo = NaN;
      let bh = -Infinity;
      let ah = -Infinity;
      let bl = Infinity;
      let al = Infinity;
      let whole = true;
      for (let k = a.k0[j]; k < a.k1[j]; k++) {
        if (o.reading === "R1") {
          const h1 = Number(((m1.bh[k] + m1.ah[k]) / 2).toFixed(dec));
          const l1 = Number(((m1.bl[k] + m1.al[k]) / 2).toFixed(dec));
          if (!(hi >= h1)) hi = h1;
          if (!(lo <= l1)) lo = l1;
        } else {
          if (m1.bh[k] > bh) bh = m1.bh[k];
          if (m1.ah[k] > ah) ah = m1.ah[k];
          if (m1.bl[k] < bl) bl = m1.bl[k];
          if (m1.al[k] < al) al = m1.al[k];
          hi = Number(((bh + ah) / 2).toFixed(dec));
          lo = Number(((bl + al) / 2).toFixed(dec));
        }
        for (let q = 0; q < held.length;) {
          const h = held[q];
          against(h, k);
          const touch = state === null ? null : rideTouch(state, h.zside, hi, lo);
          if (touch === null) {
            q++;
            continue;
          }
          settle(h, "reached", barOpen, m1.t[k] + MINUTE, h.side === "BUY" ? m1.bc[k] : m1.ac[k], touch.share, false);
          held.splice(q, 1);
          reachedHere.push(h);
        }
        if (held.length === 0) {
          whole = false;
          break;
        }
      }
      if (o.reading === "R1" && whole) {
        bars[j].high = hi;
        bars[j].low = lo;
      }
    }
    kp = a.k1[j];

    // ---- the close of bar j: the catch-up of the rides held (the function's 600 closed bars in hand), then the entry
    const T = barOpen + HOUR;
    if (held.length > 0) {
      const hand = bars.slice(j + 1 - W, j + 1);
      for (let q = 0; q < held.length;) {
        const h = held[q];
        const c = rideCatchUp(hand, h.zside, h.entryBar);
        if (c === null) {
          q++;
          continue;
        }
        caught++;
        if (!c.newest) caughtOlder++;
        settle(h, "reached", c.bar, T, h.side === "BUY" ? d.bc[j] : d.ac[j], c.share, true);
        held.splice(q, 1);
        reachedHere.push(h);
      }
    }
    if (T < START || T >= END) continue;
    const entry = rideEntryAt(d.mid.slice(j + 1 - W, j + 1));
    const s = rideCloseStep(entry, barOpen, [...held, ...reachedHere]);
    if (entry === null || s.step === null) continue;
    const row: Row = {
      pair: d.pair,
      i: j,
      open: barOpen,
      T0: T,
      side: entry.side,
      zside: entry.zside,
      entry: entry.side === "BUY" ? d.ac[j] : d.bc[j],
      share0: shareOf(entry.z, entry.zside),
      step: s.step,
      by: s.by === null ? null : s.by.entryBar,
      out: null,
    };
    rows.push(row);
    if (s.step !== "in") continue;
    if (s.own !== null || held.some((h) => h.side === entry.side)) throw new Error(`${d.pair} ${iso(barOpen)}: a second ride of a side`);
    held.push({ side: entry.side, entryBar: barOpen, status: "open", reachedBar: null, row, zside: entry.zside, pe: P(row.entry, dec), worst: 0, kFrom: j + 1 < d.n ? a.k0[j + 1] : m1.n });
  }
  // the rides still held at the last bar loaded: valued at its close (the study's "open")
  const last = d.n - 1;
  const zl = last >= W - 1 ? rideZoneAt(d.mid.slice(last + 1 - W, last + 1)) : null;
  for (const h of held) settle(h, "open", null, d.t[last] + HOUR, h.side === "BUY" ? d.bc[last] : d.ac[last], zl === null ? NaN : shareOf(zl, h.zside), false);
  return { rows, caught, caughtOlder, stateless };
};

// ---- the numbers --------------------------------------------------------------------------------------

// the value at rank ceil(0.9 n) of the values in ascending order (research/macd90m-spec.md)
const p90 = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor((9 * s.length + 9) / 10) - 1];
};
// research/macd90m.ts's group C, field for field (so that R1's can be held against the study's summary)
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
// entries and already as the study's group; the notices sent (at) and not sent (quiet: a ride of the side was reached
// in that very bar), and the trades the catch-up ended, are the replay's own
const groupOf = (rs: Row[]) => ({
  entries: rs.length,
  already: rs.filter(isAlready).length,
  at: rs.filter((r) => r.step === "at").length,
  quiet: rs.filter((r) => r.step === "quiet").length,
  late: rs.filter((r) => r.out !== null && r.out.late).length,
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

// by the entry moment, then the pairs' order (the study's rows' order: its sums are made in it)
const ordered = (all: Row[]): Row[] => [...all].sort((a, b) => a.T0 - b.T0 || PAIRS.indexOf(a.pair as typeof PAIRS[number]) - PAIRS.indexOf(b.pair as typeof PAIRS[number]));

const keyOf = (r: Row) => `${r.pair}|${iso(r.T0)}`;

// What each close did, said again from the rows themselves and apart from rideCloseStep (research/macdride-spec.md
// section 1): an entry that is not already is skipped exactly when a ride of its pair and side with an earlier entry
// bar is still held at its close (open at the end, or reached in a later bar: one reached in this bar or earlier does
// not skip it); an already entry is quiet exactly when a ride of its pair and side was reached in its very bar. The
// first entry of a pair and side meets no ride, so the steps follow one from the other: every difference is returned.
// (The study's rows do not tell a notice sent from one not sent, and hold nothing of R2.)
const stepsByRule = (rows: Row[]): string[] => {
  const diffs: string[] = [];
  const rides = new Map<string, Row[]>();
  for (const r of rows) {
    if (r.out === null) continue;
    const k = `${r.pair}|${r.side}`;
    rides.set(k, [...(rides.get(k) ?? []), r]);
  }
  for (const r of rows) {
    const mine = (rides.get(`${r.pair}|${r.side}`) ?? []).map((x) => ({ open: x.open, out: x.out as Out }));
    const held = mine.some((x) => x.open < r.open && (x.out.result === "open" || (x.out.bar !== null && x.out.bar > r.open)));
    const reachedHere = mine.some((x) => x.out.result === "reached" && x.out.bar === r.open);
    const want: RideStep = isAlready(r) ? (reachedHere ? "quiet" : "at") : held ? "skip" : "in";
    if (want !== r.step) diffs.push(`${r.pair} ${iso(r.T0)} ${r.side}: the close did "${r.step}", the rule said on the rows gives "${want}"`);
  }
  return diffs;
};

// ---- R2 against R1 ------------------------------------------------------------------------------------

// The entries are the same bars under both readings (they come from the closes); what a close did with one, and how
// its ride ended, can differ.
const diffOf = (r1: Row[], r2: Row[]) => {
  const one = new Map(r1.map((r) => [keyOf(r), r]));
  if (one.size !== r1.length || r1.length !== r2.length) throw new Error("the two readings do not hold the same entries");
  const steps: Record<string, number> = {};
  let both = 0;
  let sameMinute = 0;
  let earlier = 0;
  let later = 0;
  let onlyR1 = 0;
  let onlyR2 = 0;
  let differ = 0;
  const lines: string[] = [];
  for (const b of r2) {
    const a = one.get(keyOf(b));
    if (!a || a.side !== b.side || a.entry !== b.entry) throw new Error(`${keyOf(b)}: an entry of R2's that is not R1's`);
    let other = false;
    if (a.step !== b.step) {
      const k = `${a.step}>${b.step}`;
      steps[k] = (steps[k] ?? 0) + 1;
      other = true;
    }
    if (a.out && b.out) {
      both++;
      if (b.out.T < a.out.T) earlier++;
      else if (b.out.T > a.out.T) later++;
      else sameMinute++;
      if (a.out.T !== b.out.T || a.out.result !== b.out.result || a.out.exit !== b.out.exit) other = true;
    } else if (a.out) onlyR1++;
    else if (b.out) onlyR2++;
    if (!other) continue;
    differ++;
    const cells = (r: Row) => [r.step, r.out ? r.out.result : "", r.out ? iso(r.out.T) : "", r.out ? String(r.out.pips) : ""];
    lines.push([b.pair, iso(b.open), iso(b.T0), b.side, ...cells(a), ...cells(b), b.out && b.out.late ? "1" : "0"].join(","));
  }
  return {
    d: {
      entries: r2.length,
      tradesR1: r1.filter((r) => r.out !== null).length,
      tradesR2: r2.filter((r) => r.out !== null).length,
      // a trade under both readings: reached (or still open) at the same moment, at an earlier one under R2, a later one
      both,
      sameMinute,
      earlier,
      later,
      // a trade under one reading only (skipped under the other)
      onlyR1,
      onlyR2,
      // what the close did, where it differs: "R1's step>R2's step"
      steps,
      // entries with any difference (the step, or the trade's result, moment out or price out)
      differ,
    },
    lines,
  };
};
type Diff = ReturnType<typeof diffOf>["d"];
const DIFF_HEAD = ["pair", "open", "T0", "side", "R1_step", "R1_result", "R1_T", "R1_pips", "R2_step", "R2_result", "R2_T", "R2_pips", "R2_late"];

// ---- the study's rows (research/macd90m.ts way C, in at the bar's close) ----------------------------------

interface Study {
  meta: { start: string; end: string; loadFrom: string };
  rows: Array<Record<string, string>>;
  groups: Record<string, { entries: number; already: number; C: Record<string, number | null> }>;
}

// the cells held against the study's, by its columns' names
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
  return { meta: s.meta, rows: rows.filter((r) => r.way === "close"), groups: s.ways.close };
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

// every difference between the replay's rows and the study's: an entry on one side only, or a cell
const againstStudy = (rows: Row[], study: Study): { diffs: string[]; cells: number } => {
  const diffs: string[] = [];
  const mine = new Map(rows.map((r) => [keyOf(r), r]));
  if (mine.size !== rows.length) diffs.push("the replay holds two entries at one bar of a pair");
  const seen = new Set<string>();
  let cells = 0;
  const show = (v: string) => (v === "" ? "(empty)" : v);
  for (const s of study.rows) {
    const key = `${s.pair}|${s.T0}`;
    if (seen.has(key)) diffs.push(`${s.pair} ${s.T0}: two rows of the study's at one bar`);
    seen.add(key);
    const r = mine.get(key);
    if (!r) {
      diffs.push(`${s.pair} ${s.T0} ${s.side}: an entry of the study's (${s.already === "1" ? "already" : s.C_result}), none in the replay`);
      continue;
    }
    const c = studyCells(r);
    for (const h of CMP) {
      cells++;
      if (c[h] !== s[h]) diffs.push(`${s.pair} ${s.T0} ${s.side} ${h}: the study ${show(s[h])}, the replay ${show(c[h])}`);
    }
  }
  for (const r of rows) if (!seen.has(keyOf(r))) diffs.push(`${r.pair} ${iso(r.T0)} ${r.side}: an entry of the replay's (${r.step}), none in the study`);
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

// ---- docs §8.149's numbers ------------------------------------------------------------------------------

// What research/macdride-spec.md quotes as measured (docs §8.149; GitHub Actions run 43134981457), as printed there.
// The real run on the study's own span says whether R1 (the study's rows) still comes to them; it does not stop on it.
const DOCS_8149: Array<[string, (g: Group) => string, string]> = [
  ["entries", (g) => String(g.entries), "1581"],
  ["already", (g) => String(g.already), "750"],
  ["skipped", (g) => String(g.C.skipped), "30"],
  ["reached", (g) => String(g.C.reached), "800"],
  ["open", (g) => String(g.C.open), "1"],
  ["plus", (g) => String(g.C.plus), "360"],
  ["minus", (g) => String(g.C.minus), "429"],
  ["pips a trade", (g) => fmt(g.C.pipsMean), "0.43"],
  ["pips sum", (g) => fmt(g.C.pipsSum, 1), "343.3"],
  ["worst pips", (g) => fmt(g.C.pipsMin, 1), "-323.6"],
  ["largest loss on the way", (g) => fmt(g.C.maeMax, 1), "558.8"],
  ["longest minutes", (g) => fmt(g.C.minutesMax, 0), "40141"],
  ["open pips", (g) => fmt(g.C.openPipsSum, 1), "-6.1"],
];
const docsCheck = (g: Group) => {
  const other = DOCS_8149.filter(([, f, want]) => f(g) !== want).map(([name, f, want]) => `${name}: docs §8.149 ${want}, here ${f(g)}`);
  return { same: other.length === 0, compared: DOCS_8149.length, other };
};

// ---- the rows and the summary ----------------------------------------------------------------------------

const HEAD = ["pair", "open", "T0", "side", "entry", "share0", "step", "by", "result", "reached_bar", "T", "exit", "pips", "mae", "minutes", "share", "late"];
const csvOf = (rs: Row[]): string =>
  [
    HEAD.join(","),
    ...rs.map((r) =>
      [
        r.pair,
        iso(r.open),
        iso(r.T0),
        r.side,
        String(r.entry),
        String(r.share0),
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
  // the walks' check: R2's bars with no minute read, the catch-up alone
  lone: Replay | null;
}

const runPair = (a: PairIn, alone: boolean): PairRun => ({
  pair: a.d.pair,
  bars: a.d.n,
  minutes: a.m1.n,
  chart: chartAgainstMinutes(a),
  r1: replayPair(a, { reading: "R1", minutes: true }),
  r2: replayPair(a, { reading: "R2", minutes: true }),
  lone: alone ? replayPair(a, { reading: "R2", minutes: false }) : null,
});

const sumOf = (xs: number[]) => xs.reduce((s, x) => s + x, 0);

const summaryOf = (runs: PairRun[], studyDir: string, compared: { rows: number; cells: number; numbers: number } | null, docs: ReturnType<typeof docsCheck> | null) => {
  const r1 = ordered(runs.flatMap((p) => p.r1.rows));
  const r2 = ordered(runs.flatMap((p) => p.r2.rows));
  const diff: Record<string, Diff> = { all: diffOf(r1, r2).d };
  for (const p of runs) diff[p.pair] = diffOf(p.r1.rows, p.r2.rows).d;
  return {
    meta: { start: iso(START), end: iso(END), loadFrom: iso(LOAD_FROM), rule: RIDE_RULE_TAG, shareIn: RIDE_IN_SHARE, shareOut: RIDE_OUT_SHARE, study: studyDir, readings: READINGS },
    pairs: runs.map((p) => ({ pair: p.pair, bars: p.bars, minutes: p.minutes, entries: p.r1.rows.length, chart: p.chart })),
    r1: {
      // null: not held against the study (never written so: the run stops before)
      equalsStudy: compared,
      caught: sumOf(runs.map((p) => p.r1.caught)),
      stateless: sumOf(runs.map((p) => p.r1.stateless)),
      groups: groupsOf(r1),
    },
    r2: {
      caught: sumOf(runs.map((p) => p.r2.caught)),
      caughtOlder: sumOf(runs.map((p) => p.r2.caughtOlder)),
      stateless: sumOf(runs.map((p) => p.r2.stateless)),
      groups: groupsOf(r2),
    },
    r2AgainstR1: diff,
    docs8149: docs,
  };
};
type Summary = ReturnType<typeof summaryOf>;

function fmt(v: number | null, k = 2): string {
  return v === null ? "-" : v.toFixed(k);
}
const printC = (c: CStats) =>
  `held until reached: reached ${c.reached} (plus ${c.plus}, minus ${c.minus}) open ${c.open} skipped ${c.skipped} | pips sum ${fmt(c.pipsSum, 1)} mean ${fmt(c.pipsMean)} median ${fmt(c.pipsMedian)} min ${fmt(c.pipsMin, 1)} | mae median ${fmt(c.maeMedian, 1)} p90 ${fmt(c.maeP90, 1)} max ${fmt(c.maeMax, 1)} | minutes median ${fmt(c.minutesMedian, 0)} p90 ${fmt(c.minutesP90, 0)} max ${fmt(c.minutesMax, 0)} | within 1h ${c.within60} 1d ${c.within1440} 1w ${c.within10080} | open pips sum ${fmt(c.openPipsSum, 1)} worst ${fmt(c.openPipsWorst, 1)} mae max ${fmt(c.openMaeMax, 1)} minutes max ${fmt(c.openMinutesMax, 0)}`;
const printGroups = (gs: Groups) => {
  for (const [k, g] of Object.entries(gs)) {
    console.log(`${k.padEnd(8)} entries ${g.entries} already ${g.already} (notices ${g.at}, not sent ${g.quiet}: a ride of the side reached in that bar) | trades ${g.C.reached + g.C.open}, of them seen by a close's catch-up ${g.late}`);
    console.log(`  ${printC(g.C)}`);
  }
};
const printDiff = (k: string, d: Diff) => {
  const steps = Object.entries(d.steps).map(([s, n]) => `${s} ${n}`).join(", ");
  console.log(
    `${k.padEnd(8)} trades R2 ${d.tradesR2} (R1 ${d.tradesR1}) | a trade under both ${d.both}: out at the same moment ${d.sameMinute}, earlier under R2 ${d.earlier}, later under R2 ${d.later} | a trade under R2 only ${d.onlyR2}, under R1 only ${d.onlyR1} | steps that differ (R1>R2): ${steps === "" ? "none" : steps} | entries that differ at all ${d.differ} of ${d.entries}`,
  );
};
const printSummary = (s: Summary) => {
  console.log(`meta ${JSON.stringify(s.meta)}`);
  console.log(`pairs ${JSON.stringify(s.pairs.map((p) => ({ pair: p.pair, bars: p.bars, minutes: p.minutes, entries: p.entries })))}`);
  console.log("== GMO's 1-hour bars against its 1-minute bars of the same hour (from START on)");
  for (const p of s.pairs) {
    console.log(`${p.pair.padEnd(8)} hours ${p.chart.hours}: with no 1-minute bar ${p.chart.noMinute}; chart high not the minutes' ${p.chart.highOther}, chart low not the minutes' ${p.chart.lowOther}; 1-minute bars in no 1-hour bar ${p.chart.minutesOutside}`);
  }
  console.log(`== R1 (${s.meta.readings.R1})`);
  console.log(
    s.r1.equalsStudy
      ? `R1 equals the study's way C rows (${s.meta.study}): ${s.r1.equalsStudy.rows} rows, ${s.r1.equalsStudy.cells} cells, ${s.r1.equalsStudy.numbers} numbers of its summary; the catch-up found ${s.r1.caught}`
      : "R1 was not held against the study",
  );
  if (s.docs8149) console.log(s.docs8149.same ? `R1's numbers are docs §8.149's (${s.docs8149.compared} compared)` : `R1's numbers are NOT docs §8.149's: ${s.docs8149.other.join("; ")}`);
  printGroups(s.r1.groups);
  console.log(`== R2 (${s.meta.readings.R2})`);
  console.log(`rides a close's catch-up found (the chart's 1-hour bar touched where its minutes had not): ${s.r2.caught}, of them in a bar older than the newest ${s.r2.caughtOlder}; hours followed without a state: ${s.r2.stateless}`);
  printGroups(s.r2.groups);
  console.log("== R2 against R1 (the same entries; what the close did with each, and when its ride was out)");
  for (const [k, d] of Object.entries(s.r2AgainstR1)) printDiff(k, d);
};

// ---- loading ------------------------------------------------------------------------------------------

// research/macd90m.ts's loadFiles, pair by pair; each pair replayed as it is read (its 1-minute bars are not kept).
// `walkSeed` (the walks): the catch-up alone is run too, and the whole again on the walk with its bid and ask moved
// apart, and on that with the 1-minute bars of some hours taken out.
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

// R1 against the study: the rows, the summary's numbers, the span, and the catch-up
const r1AgainstStudy = (runs: PairRun[], study: Study) => {
  const diffs: string[] = [];
  const meta = { start: iso(START), end: iso(END), loadFrom: iso(LOAD_FROM) };
  for (const k of ["start", "end", "loadFrom"] as const) if (study.meta[k] !== meta[k]) diffs.push(`the study's rows are of another span: its ${k} ${study.meta[k]}, here ${meta[k]}`);
  const r1 = ordered(runs.flatMap((p) => p.r1.rows));
  const rowsCheck = againstStudy(r1, study);
  diffs.push(...rowsCheck.diffs);
  const groupsCheck = againstStudyGroups(groupsOf(r1), study);
  diffs.push(...groupsCheck.diffs);
  for (const p of runs) {
    if (p.r1.caught) diffs.push(`${p.pair}: the catch-up found ${p.r1.caught} rides under R1, ${p.r1.caughtOlder} of them in a bar older than the newest closed one (every minute was read: it must find none)`);
    for (const r of p.r1.rows) if (r.out && r.out.late) diffs.push(`${p.pair} ${iso(r.T0)} ${r.side}: under R1 seen by the catch-up in the bar opened ${r.out.bar === null ? "-" : iso(r.out.bar)}`);
  }
  return { diffs, compared: { rows: study.rows.length, cells: rowsCheck.cells, numbers: groupsCheck.numbers } };
};

const printDiffs = (what: string, diffs: string[]) => {
  console.log(`${what}: ${diffs.length} differences${diffs.length > 20 ? " (the first 20)" : ""}`);
  for (const x of diffs.slice(0, 20)) console.log(`  ${x}`);
};

// ---- the checks on a walk --------------------------------------------------------------------------------

// What must hold between the readings of one pair on a walk. `whole`: its 1-hour bars are made of its 1-minute bars,
// none taken out.
const checkReadings = (p: PairRun, whole: boolean, bad: (msg: string) => void) => {
  // the chart's high and low are then what R2 ends each hour with, so a close's catch-up finds nothing the minutes did
  // not, under R2 as under R1 (R1's catch-up reads what R1 read: it finds nothing on any walk)
  if (whole && (p.chart.noMinute || p.chart.highOther || p.chart.lowOther || p.chart.minutesOutside)) bad(`${p.pair}: the walk's 1-hour bars are not its 1-minute bars' (${JSON.stringify(p.chart)})`);
  if (p.r1.caught) bad(`${p.pair}: the catch-up found ${p.r1.caught} rides under R1`);
  if (whole && p.r2.caught) bad(`${p.pair}: the catch-up found ${p.r2.caught} rides under R2`);
  if (p.r1.stateless || p.r2.stateless) bad(`${p.pair}: hours followed without a state`);
  for (const [name, rs] of [["R1", p.r1.rows], ["R2", p.r2.rows], ["the catch-up alone", p.lone ? p.lone.rows : []]] as Array<[string, Row[]]>) {
    const g = groupOf(rs);
    if (g.C.reached + g.C.open + g.C.skipped + g.already !== g.entries || g.at + g.quiet !== g.already) bad(`${p.pair} ${name}: the counts do not add up`);
    for (const x of stepsByRule(rs)) bad(`${name}: ${x}`);
  }
  // R2's high is never under R1's and its low never over: a ride of the same entry is not reached later
  const one = new Map(p.r1.rows.map((r) => [keyOf(r), r]));
  for (const b of p.r2.rows) {
    const a = one.get(keyOf(b));
    if (a && a.out && b.out && b.out.T > a.out.T) bad(`${p.pair} ${iso(b.T0)}: out later under R2 (${iso(b.out.T)}) than under R1 (${iso(a.out.T)})`);
  }
  // no minute read at all: the catch-up alone, at each close, reaches every ride of R2 in the bar R2 reached it in (so
  // every close does the same with its entry); each is out at that bar's close and said to be late
  const c = p.lone;
  if (c === null) {
    bad(`${p.pair}: the catch-up alone was not run`);
    return;
  }
  if (c.rows.length !== p.r2.rows.length) bad(`${p.pair}: the catch-up alone holds ${c.rows.length} entries, R2 ${p.r2.rows.length}`);
  if (c.caughtOlder) bad(`${p.pair}: the catch-up alone found ${c.caughtOlder} rides in a bar older than the newest`);
  const two = new Map(p.r2.rows.map((r) => [keyOf(r), r]));
  for (const x of c.rows) {
    const b = two.get(keyOf(x));
    if (!b || b.step !== x.step || (b.out === null) !== (x.out === null)) {
      bad(`${p.pair} ${iso(x.T0)}: the catch-up alone ${x.step}, R2 ${b ? b.step : "no entry"}`);
      continue;
    }
    if (!b.out || !x.out) continue;
    if (b.out.result !== x.out.result || b.out.bar !== x.out.bar) bad(`${p.pair} ${iso(x.T0)}: the catch-up alone ${x.out.result} in ${x.out.bar === null ? "-" : iso(x.out.bar)}, R2 ${b.out.result} in ${b.out.bar === null ? "-" : iso(b.out.bar)}`);
    if (x.out.result !== "reached") continue;
    if (!(x.out.late && x.out.bar !== null && x.out.T === x.out.bar + HOUR)) bad(`${p.pair} ${iso(x.T0)}: the catch-up alone is out at ${iso(x.out.T)}, not at the close of the bar it was reached in`);
    if (!(x.out.share >= RIDE_OUT_SHARE)) bad(`${p.pair} ${iso(x.T0)}: the catch-up's share ${x.out.share} is under 96%`);
  }
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
    console.log(`  make them first: MODE=walkfiles SEEDS=${seed} OUT=${dir} deno run --allow-read=. --allow-write=research/out --allow-env research/macd90m.ts`);
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
  await Deno.mkdir(`${dir}/replay`, { recursive: true });
  const rowsOf = (ps: PairRun[], reading: Reading) => ordered(ps.flatMap((p) => (reading === "R1" ? p.r1.rows : p.r2.rows)));
  await Deno.writeTextFile(`${dir}/replay/rows-R1.csv`, csvOf(rowsOf(runs, "R1")));
  await Deno.writeTextFile(`${dir}/replay/rows-R2.csv`, csvOf(rowsOf(runs, "R2")));
  await Deno.writeTextFile(`${dir}/replay/summary.json`, JSON.stringify(s, null, 1));
  await Deno.writeTextFile(`${dir}/replay/apart-rows-R1.csv`, csvOf(rowsOf(apart, "R1")));
  await Deno.writeTextFile(`${dir}/replay/apart-rows-R2.csv`, csvOf(rowsOf(apart, "R2")));
  await Deno.writeTextFile(`${dir}/replay/apart-r2-vs-r1.csv`, [DIFF_HEAD.join(","), ...diffOf(rowsOf(apart, "R1"), rowsOf(apart, "R2")).lines].join("\n") + "\n");

  // the walk gives the checks something to hold: trades reached, already entries, skipped entries
  const g1 = s.r1.groups.all;
  if (g1.C.reached === 0 || g1.already === 0 || g1.C.skipped === 0) bad(`the walk has no reached trade, no already entry or no skipped entry (reached ${g1.C.reached}, already ${g1.already}, skipped ${g1.C.skipped}): too little compared`);
  for (const p of runs) checkReadings(p, true, bad);
  const lone = sumOf(runs.map((p) => (p.lone ? p.lone.caught : 0)));
  if (lone === 0) bad("the catch-up alone reached no ride: its check compared nothing");

  // the same walk with its bid and ask moved apart: R2 is no longer R1 (or the checks of R2 held nothing of its own)
  for (const p of apart) checkReadings(p, true, bad);
  const da = sa.r2AgainstR1.all;
  if (da.earlier === 0) bad("bid and ask moved apart: no ride was reached earlier under R2 than under R1: R2's own way was not checked");
  const loneApart = sumOf(apart.map((p) => (p.lone ? p.lone.caught : 0)));

  // and with the 1-minute bars of some hours taken out: under R2 the close's catch-up sees the rides touched in them,
  // each in the bar the catch-up alone sees it in
  for (const p of holes) checkReadings(p, false, bad);
  const sh = summaryOf(holes, dir, null, null);
  const noMinute = sumOf(holes.map((p) => p.chart.noMinute));
  if (sh.r2.caught === 0) bad("hours without 1-minute bars: the catch-up found no ride under R2: its part in R2 was not checked");

  console.log(`walk seed ${seed}: R1 against the study: ${eq.compared.rows} rows, ${eq.compared.cells} cells, ${eq.compared.numbers} numbers of its summary, ${eq.diffs.length} differences; the catch-up alone reached ${lone} rides, each in R2's bar`);
  printSummary(s);
  console.log(`== walk seed ${seed} with its bid and ask moved apart (no study's rows for it: R2 against R1 only); the catch-up alone reached ${loneApart} rides, each in R2's bar`);
  console.log(`R1 all   ${printC(sa.r1.groups.all.C)}`);
  console.log(`R2 all   ${printC(sa.r2.groups.all.C)}`);
  for (const [k, d] of Object.entries(sa.r2AgainstR1)) printDiff(k, d);
  console.log(`== walk seed ${seed}, bid and ask moved apart and the 1-minute bars of ${noMinute} hours taken out: under R2 a close's catch-up found ${sh.r2.caught} rides (${sh.r2.caughtOlder} in a bar older than the newest), under R1 ${sh.r1.caught}`);
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
    // what each close did, said again from the rows (the notices not sent, and all of R2, are in no row of the study's)
    const rule = [...stepsByRule(r1).map((x) => `R1: ${x}`), ...stepsByRule(r2).map((x) => `R2: ${x}`)];
    if (rule.length) {
      printDiffs("THE STEPS ARE NOT THE RULE'S ON THE REPLAY'S OWN ROWS", rule);
      Deno.exit(1);
    }
    const s = summaryOf(runs, STUDY, eq.compared, own ? docsCheck(groupOf(r1)) : null);
    await Deno.writeTextFile(`${OUT}/rows-R2.csv`, csvOf(r2));
    await Deno.writeTextFile(`${OUT}/r2-vs-r1.csv`, [DIFF_HEAD.join(","), ...diffOf(r1, r2).lines].join("\n") + "\n");
    await Deno.writeTextFile(`${OUT}/summary.json`, JSON.stringify(s, null, 1));
    console.log(`written: ${r1.length} rows a reading`);
    printSummary(s);
  } else if (MODE === "print") {
    printSummary(JSON.parse(await Deno.readTextFile(`${OUT}/summary.json`)));
  } else {
    console.log(`MODE ${MODE}: not one of real, synthetic, print`);
    Deno.exit(1);
  }
}
