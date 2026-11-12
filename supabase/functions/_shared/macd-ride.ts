// #397 (docs §8.150): the MACD email as a ride. The owner (2026-11-12):
// 「MACD 90%→96%: 足の確定で入ると 96% まで行く メールをこれに変更、なので、
// 一つのペアで2回メールを送る」. Asked, the owner chose: email 1 at the close
// of the 1-hour bar at which the MACD line (blue) came into the 90% band of
// the pane's top or bottom (the bar before outside it), an entry with the
// flow (top = BUY, bottom = SELL); email 2 the moment the line reaches 96%
// of the same edge (「2通目で利確する感じ」); already at 96% at the entry bar's
// close, one notice and no entry (「知らせを1通だけ送る」); the line leaving
// the band before 96%, held until it gets there with no notice (「96%に届く
// まで持ち続ける」) and no new email 1 for that chart and side meanwhile; the
// 95% email of v8 stopped and replaced (「止めて入れ替える」); the five pairs,
// gold and the shares (「5ペア・金・株を全部変える」); the shares looked at
// each 1-hour bar's close (「1時間足の確定ごとに見る」). The rule as numbers:
// research/macdride-spec.md (on research/macd90-spec.md and
// research/macd90m-spec.md, whose way C it is; measured on the five pairs
// only, docs §8.149: of the 800 trades that reached 96%, 360 were at a
// profit and 429 at a loss, so email 2 reports the line, not a profit).
//
// This file is what the function (signal-alerts/indicators.ts and stocks.ts)
// and the replay (research/macdride-replay.ts) share, so that the two cannot
// differ: pure functions, no clock, no I/O. _shared/macd-level.ts is not
// changed (ZONE_PCT, ZONE_SHARE and the v8 rule stay as they are: research
// files and the old rule ids rest on them); the window and the pane are its
// (LEVEL_WINDOW 600 closed bars, ZONE_BARS 120, zoneAt).
//
// THE RULE (research/macdride-spec.md section 1). A chart's closed 1-hour
// bars oldest first, their closes as the chart draws them.
//   zone    { m, top, bottom }: the MACD line and the edges of the MACD pane
//           of the 120 bars ending at a bar (zoneAt), price units, unrounded
//   at s    on the top side:    top > 0 and m >= s * top
//           on the bottom side: bottom < 0 and m <= s * bottom
//           (equality is in; s is RIDE_IN_SHARE 0.90 or RIDE_OUT_SHARE 0.96)
//   Z, Zp   for a closed bar i with 600 closed bars up to it, r = macd(the
//           600 closes ending at i): Z(i) = zoneAt(r, 599), Zp(i) =
//           zoneAt(r, 598) (the bar before, judged in bar i's window)
//   entry   at bar i on a pane side S: Z(i) at 0.90 on S and Zp(i) not; the
//           trade side top -> BUY, bottom -> SELL; "already" when Z(i) is at
//           0.96 on S (a notice, no ride)
//   state   of a bar j, from the 599 closed closes before it: the two EMAs
//           and the signal line at the bar before j, and the pane's edges
//           over the 119 bars before j (and 0). With a price x as bar j's
//           close (A_n = 2 / (n + 1)):
//             f = A12 * x + (1 - A12) * e12    s = A26 * x + (1 - A26) * e26
//             m = f - s    g = A9 * m + (1 - A9) * sig    h = m - g
//             top = max(top119, m, g, h)    bottom = min(bottom119, m, g, h)
//           bit for bit what zoneAt reads at index 599 of the window rebuilt
//           with x (research/macd90m.ts prepare and liveZone; checked in
//           src/test/macd-ride.test.ts)
//   touch   of a ride on bar j: the line with x = the bar's high (a ride on
//           the top side) or low (the bottom side) is at 0.96 on that side
//   ride    one trade of one chart and trade side: opened at the close of its
//           entry bar, followed from the first moment of the next bar, ended
//           at the first touch (the pairs and gold) or the first later closed
//           bar whose Z is at 0.96 on its side (the shares). No other way
//           out. At most one open ride a chart and side.
// What a bar's close does with an entry (in, at, skip, quiet) is
// rideCloseStep below.

import { macd, MACD_DEFAULTS, type MacdRead } from "./macd.ts";
import { pineEma, type Series } from "./pine.ts";
import { LEVEL_WINDOW, ZONE_BARS, zoneAt } from "./macd-level.ts";

// How far from the zero line toward the pane's top (bottom) the line comes
// in (email 1) and where it is told (email 2), in percent (whole numbers:
// the rule ids say them) and as the shares held against (the doubles 0.9 and
// 0.96, research/macd90.ts ENTER and REACH)
export const RIDE_IN_PCT = 90;
export const RIDE_OUT_PCT = 96;
export const RIDE_IN_SHARE = RIDE_IN_PCT / 100;
export const RIDE_OUT_SHARE = RIDE_OUT_PCT / 100;

// The catch-up looks at the newest closed bars only (spec section 5 A.3 and
// section 6): a touch in a bar that has left them is never seen (section 10)
export const RIDE_CATCHUP_BARS = 100;
// A bar is judged by the catch-up of the pairs and gold only with this many
// bars before it among those in hand (599 - 120 = 479): with the 600 closes
// in hand and the newest 100 judged every bar has at least 500, and the EMAs
// read there were seeded at most 100 bars later than on the bar's own
// window. With 479 bars before it EMA 26's seed (the mean of the first 26
// closes) weighs (25/27)^453, some 7e-16, at the bar before, and
// (25/27)^335, some 6e-12, at the oldest bar of its pane, of how far that
// seed is from the EMA the bar's own window holds there; EMA 12's far less.
// On seeded walks the line and the pane's edges came out within 1e-12 of the
// price of the bar's own (src/test/macd-ride.test.ts).
export const RIDE_CATCHUP_MIN_BEFORE = LEVEL_WINDOW - 1 - ZONE_BARS;

const A12 = 2 / (MACD_DEFAULTS.fast + 1);
const A26 = 2 / (MACD_DEFAULTS.slow + 1);
const A9 = 2 / (MACD_DEFAULTS.signal + 1);

// The side of the pane a ride is on, and the trade it is: with the flow, the
// top a BUY and the bottom a SELL (the opposite of v8's emails)
export type RideZoneSide = "top" | "bottom";
export type RideSide = "BUY" | "SELL";
export const rideSideOf = (zside: RideZoneSide): RideSide => (zside === "top" ? "BUY" : "SELL");
export const rideZoneSideOf = (side: RideSide): RideZoneSide => (side === "BUY" ? "top" : "bottom");

// The middle of the three rule ids ("ride90to96of120"), and an id whole
// (spec section 2): `prefix` is "macdx" (the pairs and gold) or "stockmacd"
// (the shares), `mail` the email it is (in: email 1, at: the notice, out:
// email 2), `version` the number after "v". Built from the constants here
// so that no id is typed twice.
export const RIDE_RULE_TAG = `ride${RIDE_IN_PCT}to${RIDE_OUT_PCT}of${ZONE_BARS}`;
export type RideMail = "in" | "at" | "out";
export const rideRuleId = (prefix: string, mail: RideMail, version: number): string =>
  `${prefix}_${MACD_DEFAULTS.fast}_${MACD_DEFAULTS.slow}_${MACD_DEFAULTS.signal}_w${LEVEL_WINDOW}_1h_${RIDE_RULE_TAG}_${mail}_v${version}`;

// Where the line stands: the MACD line and the pane's edges (zoneAt's m, top
// and bottom; a ZoneRead is one)
export interface RideZone {
  m: number;
  top: number;
  bottom: number;
}

// At share s on a pane side (research/macd90.ts atShare, the same
// expression: the product held against as it comes, equality in)
export const atShare = (z: RideZone, zside: RideZoneSide, s: number): boolean =>
  zside === "top" ? z.top > 0 && z.m >= s * z.top : z.bottom < 0 && z.m <= s * z.bottom;

// The line's share of the way to the side's edge (m / top or m / bottom;
// research/macd90.ts shareOf). Not a number to judge with: atShare judges.
export const shareOf = (z: RideZone, zside: RideZoneSide): number => (zside === "top" ? z.m / z.top : z.m / z.bottom);

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

// The newest n of `closes`; null when there are fewer or one of them is no
// finite number
const newestOf = (closes: ReadonlyArray<number>, n: number): number[] | null => {
  if (closes.length < n) return null;
  const w = closes.slice(closes.length - n);
  for (const c of w) if (!isNum(c)) return null;
  return w;
};

// Z(i) and Zp(i) of the bar the newest of `closes` belongs to
const zonesOf = (closes: ReadonlyArray<number>): { z: RideZone; zp: RideZone } | null => {
  const w = newestOf(closes, LEVEL_WINDOW);
  if (w === null) return null;
  const r = macd(w);
  const a = zoneAt(r, LEVEL_WINDOW - 1);
  const b = zoneAt(r, LEVEL_WINDOW - 2);
  if (a === null || b === null) return null;
  return { z: { m: a.m, top: a.top, bottom: a.bottom }, zp: { m: b.m, top: b.top, bottom: b.bottom } };
};

// Z(i): where the line stands at a closed bar on its own window, the 600
// closed closes ending at it (oldest first; of more, the newest 600 are
// taken). Null on fewer than 600, on a close that is no finite number, or on
// a MACD with a gap.
export const rideZoneAt = (closes600: ReadonlyArray<number>): RideZone | null => zonesOf(closes600)?.z ?? null;

// An entry at a closed bar: the pane side the line came into the 90% band
// on, the trade it is, whether the line is already at 96% there (a notice,
// no ride), and Z(i) and Zp(i)
export interface RideEntry {
  zside: RideZoneSide;
  side: RideSide;
  already: boolean;
  z: RideZone;
  zp: RideZone;
}

// The entry at the bar the newest of `closes600` belongs to (the 600 closed
// closes ending at it, oldest first; of more, the newest 600 are taken):
// Z(i) at RIDE_IN_SHARE on a side and Zp(i) not. The two sides cannot both
// be (the top band is above zero, the bottom below). Null on fewer than 600
// closes, on a close that is no finite number, on a MACD with a gap, or when
// there is no entry.
export const rideEntryAt = (closes600: ReadonlyArray<number>): RideEntry | null => {
  const zs = zonesOf(closes600);
  if (zs === null) return null;
  const { z, zp } = zs;
  let zside: RideZoneSide | null = null;
  if (atShare(z, "top", RIDE_IN_SHARE) && !atShare(zp, "top", RIDE_IN_SHARE)) zside = "top";
  else if (atShare(z, "bottom", RIDE_IN_SHARE) && !atShare(zp, "bottom", RIDE_IN_SHARE)) zside = "bottom";
  if (zside === null) return null;
  return { zside, side: rideSideOf(zside), already: atShare(z, zside, RIDE_OUT_SHARE), z, zp };
};

// The state of a bar: all that is needed of the closed bars before it to
// know where the line stands with any price as its close. The fields are the
// columns of public.macd_ride_state (spec section 3).
export interface RideState {
  // EMA 12 and EMA 26 of the closes, and the signal line, at the bar before
  e12: number;
  e26: number;
  sig: number;
  // the highest and lowest of the MACD line, the signal line and the
  // histogram over the 119 bars before the bar, and 0
  top119: number;
  bottom119: number;
}

// The state of the bar at index k of the closes that `r`, `f` and `s` were
// worked out from (their MACD, EMA 12 and EMA 26): read at k - 1, the pane
// over k - 119 to k - 1. Null when there are not that many bars before k or
// one of the values is no number.
const stateBefore = (r: MacdRead, f: Series, s: Series, k: number): RideState | null => {
  const from = k - (ZONE_BARS - 1);
  if (from < 0 || k - 1 >= r.macd.length) return null;
  const e12 = f[k - 1];
  const e26 = s[k - 1];
  const sig = r.signal[k - 1];
  if (!isNum(e12) || !isNum(e26) || !isNum(sig)) return null;
  let top = 0;
  let bottom = 0;
  for (const xs of [r.macd, r.signal, r.hist]) {
    for (let j = from; j < k; j++) {
      const v = xs[j];
      if (!isNum(v)) return null;
      if (v > top) top = v;
      if (v < bottom) bottom = v;
    }
  }
  return { e12, e26, sig, top119: top, bottom119: bottom };
};

// The state of the bar that comes after `closes599`: the 599 closed closes
// before it, oldest first (of more, the newest 599 are taken). At a bar's
// close this is the state of the bar now forming; the study's `prepare` of
// that bar (research/macd90m.ts) bit for bit. Null on fewer than 599, or on a
// close that is no finite number (a gap).
export const rideStateOf = (closes599: ReadonlyArray<number>): RideState | null => {
  const w = newestOf(closes599, LEVEL_WINDOW - 1);
  if (w === null) return null;
  return stateBefore(macd(w), pineEma(w, MACD_DEFAULTS.fast), pineEma(w, MACD_DEFAULTS.slow), LEVEL_WINDOW - 1);
};

// A state read back (a row of public.macd_ride_state, or an instance's
// copy): its five numbers, or null when one of them is no finite number or
// an edge is on the wrong side of zero (the pane's edges hold 0). Nothing
// else of the row is kept.
export const rideStateFrom = (row: unknown): RideState | null => {
  if (typeof row !== "object" || row === null) return null;
  const { e12, e26, sig, top119, bottom119 } = row as Record<string, unknown>;
  if (!isNum(e12) || !isNum(e26) || !isNum(sig) || !isNum(top119) || !isNum(bottom119)) return null;
  if (top119 < 0 || bottom119 > 0) return null;
  return { e12, e26, sig, top119, bottom119 };
};

// Where the line stands with x as the close of the state's bar: zoneAt at
// index 599 of the window rebuilt with x, bit for bit (the same expressions
// in the same order as pineEma's and macd()'s)
export const rideLineAt = (state: RideState, x: number): RideZone => {
  const f = A12 * x + (1 - A12) * state.e12;
  const s = A26 * x + (1 - A26) * state.e26;
  const m = f - s;
  const g = A9 * m + (1 - A9) * state.sig;
  const h = m - g;
  let top = state.top119;
  let bottom = state.bottom119;
  for (const v of [m, g, h]) {
    if (v > top) top = v;
    if (v < bottom) bottom = v;
  }
  return { m, top, bottom };
};

// A touch: the line and the pane's edges where it touched, and the line's
// share of the way to the ride's edge there
export interface RideTouch extends RideZone {
  share: number;
}

// The touch of a ride on the pane side `zside` on the state's bar, from the
// bar's high and low (so far, while it forms): the line with x = the high
// (top side) or the low (bottom side) at RIDE_OUT_SHARE on that side. Null
// when it does not touch, or the price is no finite number.
export const rideTouch = (state: RideState, zside: RideZoneSide, high: number, low: number): RideTouch | null => {
  const x = zside === "top" ? high : low;
  if (!isNum(x)) return null;
  const z = rideLineAt(state, x);
  return atShare(z, zside, RIDE_OUT_SHARE) ? { m: z.m, top: z.top, bottom: z.bottom, share: shareOf(z, zside) } : null;
};

// A ride as rideCloseStep reads it (a row of public.macd_rides, its times as
// milliseconds): the trade side, the entry bar's open, and where it stands
// (reachedBar: the open of the bar it was reached in, null while open)
export interface RideRow {
  side: RideSide;
  entryBar: number;
  status: "open" | "reached";
  reachedBar: number | null;
}

// What a bar's close does:
//   in     email 1: the ride of this bar and side is opened (and, when its
//          row is already there, mailed to those who have no email 1 yet)
//   at     the notice: the line came in and is already at 96%; no ride
//   skip   an entry while another ride of the side is held: nothing mailed
//   quiet  a notice not sent: a ride of the side was reached in this very bar
//          and its email 2 says the same
//   null   no entry at the bar
export type RideStep = "in" | "at" | "skip" | "quiet";
export interface RideCloseStep {
  step: RideStep | null;
  // the entry's trade side and pane side (null without an entry)
  side: RideSide | null;
  zside: RideZoneSide | null;
  // the ride row of this very bar and side, when there is one (the bar is
  // being judged again): with "in" nothing new is opened
  own: RideRow | null;
  // skip and quiet: the ride that made it so
  by: RideRow | null;
}

// What the close of the bar opened at `barOpen` (ms) does, from the entry at
// it (rideEntryAt's, null for none) and the chart's ride rows (both sides,
// any order, as they stand once this close's catch-up is done: a ride
// reached there counts as reached in its reachedBar). Spec section 1:
//   an entry that is not already is skipped when another ride of the side
//   with an entry bar before this one is open, or was reached in a bar after
//   this one (reachedBar > barOpen); a ride reached in this bar or earlier
//   does not skip it (the study's T0 >= T, research/macd90m-spec.md way C);
//   an already entry is quiet when a ride of the side was reached in this
//   very bar (reachedBar = barOpen), a notice otherwise.
// Judging a bar again gives the same step: the bar's own row (same entry
// bar and side) skips nothing, open or reached, so the step is still "in"
// and the caller mails those who have no row yet; a ride of the other side
// changes nothing. The own row is also the bar's FIRST decision, and it
// stands: while it is there the step is "in" even when a later read of the
// bar gives a close at which the line is already at 96% (a feed that moved
// a just-closed bar's close across the line would otherwise add the notice
// "no entry is sent" to an email 1 already out). A reached row without its
// reachedBar is held to be over: it neither skips nor quiets.
// For that the rows given must hold, of the chart: every open ride, every
// ride reached in this bar or a later one WHATEVER ITS ENTRY BAR (a ride held
// for weeks and reached a minute after this close still skips this bar when
// it is judged again, and one reached in this bar still quiets its notice),
// and the bar's own. A ride reached in a bar before this one is never read.
export const rideCloseStep = (entry: RideEntry | null, barOpen: number, rows: ReadonlyArray<RideRow>): RideCloseStep => {
  if (entry === null) return { step: null, side: null, zside: null, own: null, by: null };
  const { side, zside } = entry;
  const mine = rows.filter((r) => r.side === side);
  const own = mine.find((r) => r.entryBar === barOpen) ?? null;
  if (own !== null) return { step: "in", side, zside, own, by: null };
  if (entry.already) {
    const by = mine.find((r) => r.status === "reached" && r.reachedBar === barOpen) ?? null;
    return { step: by === null ? "at" : "quiet", side, zside, own, by };
  }
  const by = mine.find((r) => r.entryBar < barOpen && (r.status === "open" || (r.reachedBar !== null && r.reachedBar > barOpen))) ?? null;
  return { step: by === null ? "in" : "skip", side, zside, own, by };
};

// A closed bar as the catch-up reads it: its open (ms) and its high, low and
// close as the chart draws them
export interface RideBar {
  t: number;
  high: number;
  low: number;
  close: number;
}

// The bar a catch-up found a ride reached in: its open (ms; the ride's
// reached_bar), its index in the bars given, whether it is the newest of
// them, the price read there (the bar's high or low; by the close, its
// close), and the line there (share: the ride's share1)
export interface RideCaught extends RideTouch {
  bar: number;
  index: number;
  newest: boolean;
  x: number;
}

const limitOk = (limit: number): boolean => Number.isInteger(limit) && limit > 0;

// The catch-up of the pairs and gold (spec section 5 A.3): among the newest
// `limit` of the closed bars in hand (oldest first), the first bar opened
// after `entryBar` (the ride's entry bar's open, ms) whose high (a ride on
// the top side) or low (the bottom side) touches. One macd() over the closes
// in hand (of more than 600, the newest 600): the state of the bar at index
// k is read at k - 1, the pane over k - 119 to k - 1. For the newest bar of
// 600 this is rideStateOf of the 599 before it bit for bit (the study's
// state); for an older bar the EMAs were seeded up to `limit` bars later than
// on its own window (a difference under 1e-12 of the price; spec section
// 10). A bar with fewer than RIDE_CATCHUP_MIN_BEFORE bars before it in hand
// is not judged. Null when no bar touches, or a close in hand is no finite
// number (nothing is judged then).
export const rideCatchUp = (
  bars: ReadonlyArray<RideBar>,
  zside: RideZoneSide,
  entryBar: number,
  limit: number = RIDE_CATCHUP_BARS,
): RideCaught | null => {
  if (!limitOk(limit)) return null;
  const off = Math.max(0, bars.length - LEVEL_WINDOW);
  const n = bars.length - off;
  const closes = newestOf(bars.slice(off).map((b) => b.close), n);
  if (closes === null) return null;
  const r = macd(closes);
  const f = pineEma(closes, MACD_DEFAULTS.fast);
  const s = pineEma(closes, MACD_DEFAULTS.slow);
  for (let k = Math.max(n - limit, RIDE_CATCHUP_MIN_BEFORE); k < n; k++) {
    const b = bars[off + k];
    if (!(b.t > entryBar)) continue;
    const state = stateBefore(r, f, s, k);
    if (state === null) continue;
    const touch = rideTouch(state, zside, b.high, b.low);
    if (touch !== null) return { ...touch, bar: b.t, index: off + k, newest: k === n - 1, x: zside === "top" ? b.high : b.low };
  }
  return null;
};

// The catch-up of the shares (spec section 6), judged at closes: among the
// newest `limit` of the closed bars in hand (oldest first), the first bar
// opened after `entryBar` whose Z, on its own 600 closed bars, is at
// RIDE_OUT_SHARE on the ride's side. A bar with fewer than 600 closed bars
// up to it in hand has no Z and is not judged. Null when there is none.
export const rideCatchUpByClose = (
  bars: ReadonlyArray<{ t: number; close: number }>,
  zside: RideZoneSide,
  entryBar: number,
  limit: number = RIDE_CATCHUP_BARS,
): RideCaught | null => {
  if (!limitOk(limit)) return null;
  const n = bars.length;
  const closes = bars.map((b) => b.close);
  for (let j = Math.max(n - limit, LEVEL_WINDOW - 1); j < n; j++) {
    const b = bars[j];
    if (!(b.t > entryBar)) continue;
    const z = rideZoneAt(closes.slice(j - LEVEL_WINDOW + 1, j + 1));
    if (z !== null && atShare(z, zside, RIDE_OUT_SHARE)) {
      return { m: z.m, top: z.top, bottom: z.bottom, share: shareOf(z, zside), bar: b.t, index: j, newest: j === n - 1, x: b.close };
    }
  }
  return null;
};
