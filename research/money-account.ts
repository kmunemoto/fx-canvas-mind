// #188: the account research/money.ts runs the trades through (docs §8.99
// 口座・量・受け付け・証拠金・ロスカット・追証・一つの5分足の中の順番・上限),
// part 2 of its three: one engine for the 25 cells and the told rows, the
// numbers of each run, E* and the account's own identities. Research only:
// nothing in the app reads this.
//
// THE ACCOUNT (§8.99, fixed before any data; names as interface.md §2–§4):
//   * a yen account; the trades of research/money-trades.ts (a Book: each
//     trade's path on the union grid G of 5-minute closes) taken one email
//     after another. No deposit, withdrawal, swap or fee.
//   * every 5-minute bar B of G (it opens at s, ends at g = s + 5 min) in the
//     order ① a call's deadline (everything closed at its pair's first open
//     at or after it) → ② the emails at T == s, admitted in the broker's order
//     (USD/JPY, EUR/JPY, …; a buy before a sell) on the state at s → ③ the
//     exits inside B (a cap's slot free only after B) → ④ the loss-cut on the
//     exit side's closes, then the cure of an open call → ⑤ at Rakuten's NY
//     close, the call on mids → ⑥ the equity and margin recorded.
//   * sizing: F10k (10,000 units always) or FF k% (k × the equity at T over
//     13 pips in yen at T, floored to 1,000; under 1,000 not taken); the
//     emails of one close sized on the same equity.
//   * admission, in this order of reasons: an open call; the cap (C0 none, T1
//     one open, T3 three, P1 one a pair, J2 two yen buys and two yen sells);
//     under 1,000 units; the margin after the order over the equity.
//   * margin: per pair the larger of its buys' and its sells' units × mid
//     (MAX), 4% (25×) or 10% (10×), at each g's mids; a dollar pair's in yen at
//     USD/JPY's mid there. The loss-cut: the equity on the exit side's closes
//     under 50% of it → everything out at those closes. The call (25× only):
//     at each NY close the equity on mids under the margin → a call of the
//     shortfall C; cured once the positions held at the close are closed so
//     that their margin at the close's prices falls by C or more (strict: all
//     of them); else at its deadline everything out.
//   * F10k cells take every email but the cap's skips (no margin, call or
//     loss-cut admission) and give E*, the account the path needed (§8.99
//     見出し): the largest of the order term (the margin after an order less
//     the P/L by then, at T), the NY close term (the margin less the P/L on
//     mids), the loss-cut term (half the margin less the P/L on the exit side,
//     at each g) and the P/L's most negative; split into the P/L lost by then
//     and the margin then.
//
// THE LEDGER (interface.md §4.3; where it leaves a choice, as
// research/money-check.py writes it too): one row an event in the order
// processed; `g` the event's time (an email's T; a late order's fill, T + 5
// minutes, after that bar's own exits; an exit's x; a deadline's bar open; a
// call's judged g), balance the realised, equity and margin right after it on
// the closes of that time. A skip has no price, and units only once the
// sizing came to them (the call and the cap are judged first). Thirds: 4,000,
// 3,000 and 3,000 at 10,000 units; a k% order dealt out 1,000 at a time to
// TP1, TP2, TP3 in turn (the larger parts first).
//
// THE ENGINE runs on a Tape (the clock G, Rakuten's NY closes and the legs:
// each trade with its marks, worst prices, mids and USD/JPY on G, from
// bookOf) and a list of Orders (one email: its legs, 1 or the 3 of thirds).
// Part 3 (the orders, the thinning, the weeks rearranged) builds its own
// Orders and Tapes and calls runAccount the same way.

import { DAY, HOUR, WEEK, WEEK_OFFSET } from "./lib.ts";
import { FINE, upperBound } from "./money-data.ts";
import { type Check, type Exit, SL, type Signal, type Study, type Variant, bookOf, iso, newCheck, tally } from "./money-trades.ts";
import { medianOf, weekOf } from "./money-stats.ts";

// ---- the cells and the told rows (interface.md §3) -------------------------------------------

export const SIZINGS = ["F10k", "FF025", "FF05", "FF1", "FF2"] as const;
export type Sizing = (typeof SIZINGS)[number];
export const CAPS = ["C0", "T1", "T3", "P1", "J2"] as const;
export type Cap = (typeof CAPS)[number];
// k a fraction (FF), null: 10,000 units always (F10k)
export const KOF: Record<Sizing, number | null> = { F10k: null, FF025: 0.0025, FF05: 0.005, FF1: 0.01, FF2: 0.02 };
export const CELLS: string[] = SIZINGS.flatMap((s) => CAPS.map((c) => `${s}_${c}`));
export type Row = "p12" | "late" | "nights" | "thirds" | "net" | "rakuten" | "x10" | "lcworst" | "strict" | "nomargin" | "zero" | "turtle";
// each told row on the cells it is told on (interface.md §3): key row_<row>_<cell>
export const ROWS: Array<[Row, string]> = [
  ["p12", "F10k_C0"], ["p12", "FF1_C0"],
  ["late", "F10k_C0"], ["late", "FF1_C0"],
  ["nights", "F10k_C0"], ["nights", "FF1_C0"],
  ["thirds", "F10k_C0"], ["thirds", "FF1_C0"],
  ["net", "F10k_C0"], ["net", "FF1_C0"],
  ["rakuten", "F10k_C0"], ["rakuten", "FF1_C0"],
  ["x10", "FF1_C0"], ["x10", "FF05_C0"],
  ["lcworst", "F10k_C0"], ["lcworst", "FF1_C0"],
  ["strict", "FF1_C0"],
  ["nomargin", "FF1_C0"],
  ["zero", "F10k_C0"], ["zero", "FF1_C0"],
  ["turtle", "FF1_C0"], ["turtle", "FF05_C0"],
];
export const rowKey = (row: Row, cell: string) => `row_${row}_${cell}`;
// the start of the k% cells (§8.99 口座: the app's old default, not the owner's)
export const START = 1_000_000;
// the units a dollar or yen trade may hold (§8.99 確かめ: 1,000 to 5,000,000)
const LOT = 1000;
const MAX_UNITS = 5_000_000;
const RATE = { 25: 0.04, 10: 0.1 } as const;

// one run's settings
export interface RunSpec {
  key: string;
  // k a fraction; null: 10,000 units always
  k: number | null;
  cap: Cap;
  // margin rate (0.04: 25×, 0.10: 10×) and whether calls are made (25× only)
  rate: number;
  calls: boolean;
  losscut: number;
  // the account's rules (margin admission, the loss-cut, calls) on; off for
  // the F10k cells (all taken but the cap's skips) and the nomargin row
  rules: boolean;
  start: number;
  // units floored to 1,000 (off only for the tiny-k identity)
  floor: boolean;
  row: Row | "";
  variant: Variant;
  set: "CALL9" | "P12";
  thirds: boolean;
  net: boolean;
  lcworst: boolean;
  strict: boolean;
  turtle: boolean;
  // the zero row's δ: yen a trade at 10,000 units (F10k), or R (FF); null off
  zero: number | null;
  nights: boolean;
  // E*'s terms recorded (the F10k cells)
  estar: boolean;
  plant: string;
}

// a cell's or a told row's settings (interface.md §3); `zero` the δ the zero
// row needs (from the trades), set by the caller
export const specOf = (key: string, plant = "", zero: { yen: number; r: number } | null = null): RunSpec => {
  const m = /^(?:row_([a-z0-9]+)_)?(F10k|FF025|FF05|FF1|FF2)_(C0|T1|T3|P1|J2)$/.exec(key);
  if (!m) throw new Error(`${key} is not a cell or a told row`);
  const row = (m[1] ?? "") as Row | "";
  const sizing = m[2] as Sizing;
  const k = KOF[sizing];
  const f10k = k === null;
  const spec: RunSpec = {
    key,
    k,
    cap: m[3] as Cap,
    rate: row === "x10" ? RATE[10] : RATE[25],
    calls: row !== "x10",
    losscut: 0.5,
    rules: !f10k && row !== "nomargin",
    start: f10k ? 0 : START,
    floor: true,
    row,
    variant: row === "late" ? "late" : row === "rakuten" ? "rakuten" : "main",
    set: row === "p12" ? "P12" : "CALL9",
    thirds: row === "thirds",
    net: row === "net",
    lcworst: row === "lcworst",
    strict: row === "strict",
    turtle: row === "turtle",
    zero: null,
    nights: row === "nights",
    estar: f10k,
    plant,
  };
  if (row === "zero") {
    if (!zero) throw new Error("the zero row needs its δ");
    spec.zero = f10k ? zero.yen : zero.r;
  }
  return spec;
};

// ---- the legs and the tape -------------------------------------------------------------------

// one trade as the account sees it: its path on the run's clock
export interface Leg {
  id: string;
  sig: Signal;
  pair: string;
  // its pair's index on the clock's pairs; a dollar pair (yen at USD/JPY); a yen pair (J2)
  pi: number;
  usd: boolean;
  jpy: boolean;
  dir: 1 | -1;
  unit: number;
  T: number;
  // the last g at or before T (the state the email is judged on)
  giT: number;
  // held at g[gi0..giX] ((t0, x]); out at exitPx at g[giX]
  gi0: number;
  giX: number;
  hold: number;
  entryG: number;
  fill: number;
  exitPx: number;
  exit: Exit | "passed";
  pips: number;
  // on g[gi0 + j]: the exit side's close, its bar's worst, the pair's mid
  // (moved as the walks move the trade) and USD/JPY's mid (dollar pairs; null on yen pairs)
  mark: Float64Array;
  worst: Float64Array;
  mid: Float64Array;
  conv: Float64Array | null;
  // at T (giT): the exit side's close (a late trade, not yet in: its fill), the mid, USD/JPY
  markT: number;
  midT: number;
  convT: number;
  // the forced close at a deadline: its exit side's open of its pair's first bar at or after ms
  openAt: (ms: number) => { at: number; px: number } | null;
}

export interface Tape {
  set: "CALL9" | "P12";
  variant: Variant;
  g: Float64Array;
  pairs: string[];
  // 1 where the pair (as `pairs`) has its own bar ending at g (the rest carried forward)
  own: Uint8Array[];
  usd: number;
  // USD/JPY's mid at each g (null: not on the clock)
  usdMid: Float64Array | null;
  ny: Array<{ tau: number; gi: number; exact: boolean; deadline: number }>;
  // in the signals' order: by T, then the broker's order, a buy before a sell
  legs: Leg[];
}

const tapeCache = new WeakMap<Study, Map<string, Tape>>();
// a variant's legs on a pair set's clock (made once)
export const tapeOf = (study: Study, variant: Variant, set: "CALL9" | "P12"): Tape => {
  const key = `${variant}|${set}`;
  let cache = tapeCache.get(study);
  if (!cache) tapeCache.set(study, (cache = new Map()));
  const hit = cache.get(key);
  if (hit) return hit;
  const book = bookOf(study, variant, set);
  const grid = book.grid;
  const G = grid.g;
  const U = grid.usd;
  const legs: Leg[] = book.trades.map((t) => {
    const usd = t.pd.usd;
    if (usd && U < 0) throw new Error(`${t.sig.id}: a dollar pair without USD/JPY on the clock`);
    const giT = upperBound(G, t.sig.T) - 1;
    const buy = t.sig.dir === 1;
    const passed = t.exit === "passed";
    const hold = t.hold;
    const mid = new Float64Array(hold);
    const conv = usd ? new Float64Array(hold) : null;
    for (let j = 0; j < hold; j++) {
      const gi = t.gi0 + j;
      mid[j] = grid.mid[t.pi][gi] + (t.shift ? t.shift[j] : 0);
      if (conv) conv[j] = grid.mid[U][gi];
    }
    const f = giT >= 0 ? grid.last[t.pi][giT] : -1;
    const markT = t.variant === "late" || f < 0 ? t.fill : buy ? t.book.bc[f] : t.book.ac[f];
    return {
      id: t.sig.id,
      sig: t.sig,
      pair: t.sig.pair,
      pi: t.pi,
      usd,
      jpy: t.sig.pair.includes("JPY"),
      dir: t.sig.dir,
      unit: t.pd.unit,
      T: t.sig.T,
      giT,
      gi0: passed ? -1 : t.gi0,
      giX: passed ? -1 : t.giX,
      hold,
      entryG: t.entryG,
      fill: t.fill,
      exitPx: t.exitPx,
      exit: t.exit,
      pips: t.pips,
      mark: t.mark,
      worst: t.worst,
      mid,
      conv,
      markT,
      midT: giT >= 0 ? grid.mid[t.pi][giT] : Number.NaN,
      convT: usd ? (giT >= 0 ? grid.mid[U][giT] : Number.NaN) : 1,
      openAt: (ms: number) => {
        const o = book.openAt(t, ms);
        return o ? { at: o.at, px: o.px } : null;
      },
    };
  });
  const tape: Tape = { set, variant, g: G, pairs: grid.pairs, own: grid.own, usd: U, usdMid: U >= 0 ? grid.mid[U] : null, ny: book.ny, legs };
  cache.set(key, tape);
  return tape;
};

// one email as the account takes it: its legs (one; thirds' three, TP1 first)
export interface Order {
  id: string;
  sig: Signal;
  T: number;
  legs: Leg[];
}

// the run's emails: each signal of the set once, its legs from the variant's
// tape (thirds: main, tp2, tp3), the nights' left out on that row; part 3
// passes its own (another order, some left out)
export const ordersOf = (study: Study, spec: RunSpec): Order[] => {
  const main = tapeOf(study, spec.variant, spec.set).legs;
  const more = spec.thirds ? [tapeOf(study, "tp2", spec.set).legs, tapeOf(study, "tp3", spec.set).legs] : [];
  const out: Order[] = [];
  for (let j = 0; j < main.length; j++) {
    const L = main[j];
    if (spec.nights && [16, 20].includes(new Date(L.T).getUTCHours())) continue;
    const legs = [L, ...more.map((m) => m[j])];
    if (legs.some((x) => x.id !== L.id)) throw new Error(`${L.id}: thirds' legs out of step`);
    out.push({ id: L.id, sig: L.sig, T: L.T, legs });
  }
  return out;
};

// ---- one run -----------------------------------------------------------------------------------

// one position: a leg held in some units (each of thirds' legs its own)
export interface Pos {
  leg: Leg;
  order: Order;
  // the ledger's id (thirds: the email's id with #1, #2, #3) and the leg's
  // number (0: the only leg); one position a trade counts against a cap
  id: string;
  part: number;
  units0: number;
  units: number;
  // the ledger's seq of its entry and of its last close; the bar (index of G) it came in at
  openSeq: number;
  closeSeq: number;
  openBar: number;
  // the zero row: the whole δ in yen for units0, added as the trade is held
  shift: number;
  // its closes: the units, price, USD/JPY, yen, why, when (g), at which g's
  // closes it was counted, the bar it was closed in and the ledger's seq
  closes: Array<{ units: number; px: number; conv: number; pnl: number; kind: string; g: number; gi: number; bar: number; seq: number }>;
  // the AS netting closed some of it
  netted: boolean;
}

// a ledger row (interface.md §4.3): seq,g,kind,id,units,px,pnl_yen,balance,equity,margin,reason
export type LedgerRow = [number, number, string, string, number | null, number | null, number | null, number, number, number, string];

export interface Call {
  tau: number;
  g: number;
  gi: number;
  C: number;
  equity: number;
  margin: number;
  deadline: number;
  // the positions held at the close, their units and value then (units × mid in yen)
  held: Array<{ pos: Pos; units: number; value: number }>;
  outcome: "open" | "cured" | "deadline";
  at: number | null;
}

export interface EstarTerm {
  name: "order" | "nyclose" | "losscut" | "negative";
  value: number;
  g: number | null;
  // the P/L lost by then (−P/L) and the margin part of the term then
  lost: number;
  margin: number;
}

export interface Entry {
  seq: number;
  id: string;
  T: number;
  // trades open with it in (itself too), of its pair, yen ones its way
  open: number;
  pairOpen: number;
  jpyWay: number;
  jpyBuy: number;
  jpySell: number;
  marginAfter: number;
  equity: number;
  // the latest time a sizing input came from (the marks, USD/JPY)
  inputAt: number;
  units: number;
  inCall: boolean;
  // a late order a level passed before its fill: taken, never in
  passed: boolean;
}

export interface Run {
  spec: RunSpec;
  tape: Tape;
  ledger: LedgerRow[];
  // every position closed (in the order closed); those left open at the end
  closed: Pos[];
  leftOpen: number;
  // at each g (⑥): the equity on the exit side, the margin, the realised
  // balance, the equity with every position at its bar's worst at once, and
  // the positions' value in yen (both sides: the leverage used)
  E: Float64Array;
  M: Float64Array;
  B: Float64Array;
  W: Float64Array;
  gross: Float64Array;
  entries: Entry[];
  skipped: Record<"call" | "cap" | "lot" | "margin" | "passed", number>;
  firstLot: number | null;
  calls: Call[];
  callsWhileOpen: number;
  losscuts: Array<{ g: number; equity: number; margin: number; balance: number; positions: number; after: number }>;
  deadlines: Array<{ g: number; deadline: number; balance: number; positions: number; after: number }>;
  shortfalls: Array<{ g: number; balance: number }>;
  // every NY close judged: its g index, the ledger's seq then, the margin
  nyLog: Array<{ gi: number; seq: number; margin: number }>;
  // emails used whole to close the other side (net); marks carried forward
  // (a pair, or USD/JPY, without its own bar at that g)
  netOnly: number;
  stale: number;
  staleUsd: number;
  // what E*'s rerun looks for: margin skips, loss-cuts, calls, and the
  // equity under 0 with nothing open (the last term's)
  happened: number;
  negatives: number;
  estar: EstarTerm[] | null;
}

const LOT_EPS = 1e-9;

// one run of the account over the tape's clock (the order ①–⑥ above)
export const runAccount = (tape: Tape, orders: Order[], spec: RunSpec): Run => {
  const G = tape.g;
  const n = G.length;
  const P = tape.pairs.length;
  const plant = spec.plant;
  const start = spec.start;
  const ledger: LedgerRow[] = [];
  const run: Run = {
    spec, tape, ledger, closed: [], leftOpen: 0,
    E: new Float64Array(n), M: new Float64Array(n), B: new Float64Array(n), W: new Float64Array(n), gross: new Float64Array(n),
    entries: [], skipped: { call: 0, cap: 0, lot: 0, margin: 0, passed: 0 }, firstLot: null,
    calls: [], callsWhileOpen: 0, losscuts: [], deadlines: [], shortfalls: [], nyLog: [], netOnly: 0, stale: 0, staleUsd: 0, happened: 0, negatives: 0,
    estar: spec.estar ? (["order", "nyclose", "losscut", "negative"] as const).map((name) => ({ name, value: -Infinity, g: null, lost: 0, margin: 0 })) : null,
  };
  let seq = 0;
  let balance = start;
  let open: Pos[] = [];
  let call: Call | null = null;

  // E*'s terms: the largest of each, where, and its two parts
  const term = (j: number, value: number, g: number, pl: number, margin: number) => {
    const t = run.estar![j];
    if (value > t.value) Object.assign(t, { value, g, lost: -pl, margin });
  };
  // a leg's index on its path for g[gi] (gi in gi0..giX)
  const at = (L: Leg, gi: number) => Math.min(Math.max(gi - L.gi0, 0), L.hold - 1);
  // a leg's price at g[gi]: the exit side's close (0), its bar's worst (1) or
  // the mid (2); before its first g, at T (a late trade not yet in: its fill)
  const pxAt = (L: Leg, gi: number, how: 0 | 1 | 2) => (gi < L.gi0 ? (how === 2 ? L.midT : L.markT) : how === 0 ? L.mark[at(L, gi)] : how === 1 ? L.worst[at(L, gi)] : L.mid[at(L, gi)]);
  // USD/JPY for a leg at g[gi] (1 on a yen pair)
  const convAt = (L: Leg, gi: number) => (!L.conv ? 1 : gi < L.gi0 ? L.convT : L.conv[at(L, gi)]);
  // the zero row: the share of a trade's δ held by g[gi] (the grid bars since
  // its entry over its own, §8.99 損益ゼロ)
  const fracAt = (L: Leg, gi: number) => (gi < L.gi0 ? 0 : Math.min(1, (gi - L.gi0 + 1) / L.hold));
  // the yen of `units` of p closed (or marked) at px, USD/JPY conv, at g[gi]
  // (the planted usdentry: a dollar pair at T's USD/JPY)
  const yenOf = (p: Pos, units: number, px: number, conv: number, gi: number) => {
    const L = p.leg;
    let v = units * L.dir * (px - L.fill) * (plant === "usdentry" ? L.convT : conv);
    if (p.shift !== 0) v += p.shift * (units / p.units0) * fracAt(L, gi);
    return v;
  };
  const plAt = (p: Pos, gi: number, how: 0 | 1 | 2) => yenOf(p, p.units, pxAt(p.leg, gi, how), convAt(p.leg, gi), gi);
  const equityAt = (gi: number, how: 0 | 1 | 2): number => {
    let e = balance;
    for (const p of open) e += plAt(p, gi, how);
    return e;
  };
  // a position's value in yen at g[gi] (units × mid × USD/JPY); the planted
  // marginentry keeps it at the entry's
  const valueOf = (p: Pos, gi: number): number => (plant === "marginentry" ? p.units * p.leg.midT * p.leg.convT : p.units * pxAt(p.leg, gi, 2) * convAt(p.leg, gi));
  // the margin of some values: per pair the larger of the buys' and the
  // sells' (MAX; the planted hedgesum adds them), at the run's rate
  const longV = new Float64Array(P);
  const shortV = new Float64Array(P);
  const marginOf = (xs: Array<{ pi: number; dir: number; value: number }>): number => {
    longV.fill(0);
    shortV.fill(0);
    for (const x of xs) (x.dir > 0 ? longV : shortV)[x.pi] += x.value;
    let m = 0;
    for (let q = 0; q < P; q++) m += plant === "hedgesum" ? longV[q] + shortV[q] : Math.max(longV[q], shortV[q]);
    return spec.rate * m;
  };
  const marginAt = (gi: number, extra: Array<{ pi: number; dir: number; value: number }> = []): number => marginOf([...open.map((p) => ({ pi: p.leg.pi, dir: p.leg.dir, value: valueOf(p, gi) })), ...extra]);
  // one ledger row; the equity and margin after it, on the closes of g[gi]
  const row = (g: number, kind: string, id: string, units: number | null, px: number | null, pnl: number | null, gi: number, reason = "") => {
    ledger.push([++seq, g, kind, id, units, px, pnl, balance, equityAt(gi, 0), marginAt(gi), reason]);
  };
  // `units` of p out at px (USD/JPY conv), counted on g[gi]'s closes
  const closePos = (p: Pos, units: number, px: number, conv: number, kind: string, g: number, gi: number) => {
    const pnl = yenOf(p, units, px, conv, gi);
    balance += pnl;
    p.units -= units;
    if (p.units <= 0) open = open.filter((q) => q !== p);
    row(g, "exit", p.id, units, px, pnl, gi, kind);
    p.closes.push({ units, px, conv: plant === "usdentry" ? p.leg.convT : conv, pnl, kind, g, gi, bar: curBar, seq });
    if (p.units <= 0) {
      p.closeSeq = seq;
      run.closed.push(p);
    }
  };
  const shortfall = (g: number, gi: number) => {
    if (balance >= 0) return;
    run.shortfalls.push({ g, balance });
    row(g, "shortfall", "", null, null, -balance, gi);
  };
  const giAt = (ms: number) => upperBound(G, ms) - 1;
  // the trades a cap counts (one position a trade); the planted slotearly
  // frees the slot of a trade going out in this bar already
  const counted = (k: number) => open.filter((p) => p.part <= 1 && !(plant === "slotearly" && p.leg.giX === k));

  // an order's positions (one a leg with units) opened, each with its enter
  // row at `at` (T; a late one's fill) on the closes of the bar it is in by
  const newPositions = (o: Order, split: number[], k: number, at = o.T): Pos[] => {
    const out: Pos[] = [];
    o.legs.forEach((leg, j) => {
      if (!(split[j] > 0)) return;
      // the zero row: the whole δ in yen for these units (F10k: yen a 10,000
      // units; k%: R, 13 pips in yen at T)
      const shift = spec.zero === null ? 0 : spec.k === null ? (spec.zero * split[j]) / 10_000 : spec.zero * split[j] * SL * leg.unit * leg.convT;
      const p: Pos = { leg, order: o, id: spec.thirds ? `${o.id}#${j + 1}` : o.id, part: spec.thirds ? j + 1 : 0, units0: split[j], units: split[j], openSeq: 0, closeSeq: 0, openBar: k, shift, closes: [], netted: false };
      open.push(p);
      row(at, "enter", p.id, split[j], leg.fill, null, at === o.T ? k - 1 : k);
      p.openSeq = seq;
      out.push(p);
    });
    return out;
  };
  // late orders taken, not yet in (their first bar not yet closed)
  const lateQ: Array<{ o: Order; split: number[] }> = [];

  let oi = 0;
  let ni = 0;
  let curBar = 0;
  let wasNegative = false;
  for (let k = 0; k < n; k++) {
    // nothing open, no call, no late order waiting: the account stands still
    // until the next email's bar or NY close; the closes between are recorded
    // at once (the same as going through ①–⑥ for each: none of them acts)
    if (!open.length && !call && !lateQ.length) {
      while (ni < tape.ny.length && tape.ny[ni].gi < k) ni++;
      const next = Math.min(oi < orders.length ? upperBound(G, orders[oi].T) : n, ni < tape.ny.length ? tape.ny[ni].gi : n);
      if (next > k) {
        if (spec.estar) {
          term(2, -(balance - start), G[k], balance - start, 0);
          term(3, -(balance - start), G[k], balance - start, 0);
        }
        const negative = balance < 0;
        if (negative && !wasNegative) run.negatives++;
        wasNegative = negative;
        run.E.fill(balance, k, next);
        run.W.fill(balance, k, next);
        run.B.fill(balance, k, next);
        k = next - 1;
        continue;
      }
    }
    const g = G[k];
    const s = g - FINE;
    curBar = k;
    // the state at s: the closes of the last bar ending at or before it
    const gs = k - 1;

    // ① a call not cured by its deadline: everything out at its pair's
    // first open at or after it
    if (call && call.deadline <= s) {
      const c = call;
      run.deadlines.push({ g: s, deadline: c.deadline, balance, positions: open.length, after: Number.NaN });
      row(s, "deadline", "", null, null, null, gs);
      for (const p of [...open]) {
        const o = p.leg.openAt(c.deadline);
        if (!o) throw new Error(`${p.id}: no bar after the deadline ${iso(c.deadline)}`);
        closePos(p, p.units, o.px, convAt(p.leg, giAt(o.at)), "deadline", s, gs);
      }
      c.outcome = "deadline";
      c.at = s;
      call = null;
      run.deadlines[run.deadlines.length - 1].after = balance;
      shortfall(s, gs);
    }

    // ② the emails at T == s (any T before g not yet taken: the same where
    // the bar opening at T is on the clock), judged on the state at s
    while (oi < orders.length && orders[oi].T < g) {
      const T = orders[oi].T;
      let oj = oi;
      while (oj < orders.length && orders[oj].T === T) oj++;
      const group = orders.slice(oi, oj);
      oi = oj;
      // the equity at T: every email of the close is sized and judged on it
      const eqT = equityAt(gs, 0);
      let sizeOn = eqT;
      let inputAt = gs >= 0 ? G[gs] : -Infinity;
      if (plant === "sizefuture") {
        // planted: the equity 4 hours on (a look-ahead)
        const gf = giAt(T + 4 * HOUR);
        sizeOn = balance;
        for (const p of open) sizeOn += plAt(p, Math.min(gf, p.leg.giX), 0);
        inputAt = G[gf];
      }
      if (spec.turtle) {
        // §8.95's Turtles as §8.99 reads them: m steps of 10% of the start
        // below it, the sizing on min(equity, start × 0.8^m)
        const m = Math.floor((start - sizeOn) / (0.1 * start));
        if (m >= 1) sizeOn = Math.min(sizeOn, start * 0.8 ** m);
      }
      // late orders taken in this close: not in until their first bar's
      // close, they hold their slot and margin for the close's later emails
      // (none judged again, a passed one's included)
      const pendingNow: Array<{ leg: Leg; units: number }> = [];
      for (const o of group) {
        const L = o.legs[0];
        inputAt = Math.max(inputAt, L.giT >= 0 ? G[L.giT] : -Infinity);
        // the units: 10,000, or k% of the equity over 13 pips in yen at T,
        // in 1,000s (a hair over the floor's edge kept: 1e-9 of a lot; the
        // planted roundlot rounds them instead)
        let units: number;
        if (spec.k === null) units = 10_000;
        else {
          const raw = (spec.k * sizeOn) / (SL * L.unit * L.convT);
          units = !spec.floor ? raw : plant === "roundlot" ? Math.round(raw / LOT) * LOT : Math.floor(raw / LOT + LOT_EPS) * LOT;
        }
        // the AS netting (net): the pair's other side closed oldest first at
        // this email's price, even in a call; the rest is the order
        let rest = units;
        if (spec.net && units >= LOT) {
          for (const p of [...open]) {
            if (rest <= 0) break;
            if (p.leg.pi !== L.pi || p.leg.dir === L.dir) continue;
            const q = Math.min(rest, p.units);
            p.netted = true;
            closePos(p, q, L.fill, L.convT, "net", T, gs);
            rest -= q;
          }
          if (rest <= 0) {
            run.netOnly++;
            continue;
          }
        }
        // the cap: the trades open (this close's earlier ones in, the late ones not yet filled too)
        const cnt = counted(k);
        const nOpen = cnt.length + pendingNow.length;
        const nPair = cnt.filter((p) => p.leg.pi === L.pi).length + pendingNow.filter((x) => x.leg.pi === L.pi).length;
        const nJpyWay = cnt.filter((p) => p.leg.jpy && p.leg.dir === L.dir).length + pendingNow.filter((x) => x.leg.jpy && x.leg.dir === L.dir).length;
        const capFull = spec.cap === "T1" ? nOpen >= 1 : spec.cap === "T3" ? nOpen >= 3 : spec.cap === "P1" ? nPair >= 1 : spec.cap === "J2" ? L.jpy && nJpyWay >= 2 : false;
        // the legs' units (thirds: 1,000s dealt TP1 first); the margin after the order at T's mids
        const split = spec.thirds ? splitThirds(rest, spec.k === null) : [rest];
        const items = o.legs.map((leg, j) => ({ pi: leg.pi, dir: leg.dir, value: split[j] * leg.midT * leg.convT })).filter((x) => x.value > 0);
        const pendingItems = pendingNow.map((x) => ({ pi: x.leg.pi, dir: x.leg.dir, value: x.units * x.leg.midT * x.leg.convT }));
        const marginAfter = marginAt(gs, [...pendingItems, ...items]);
        let why: "" | "call" | "cap" | "lot" | "margin" = "";
        if (call) why = "call";
        else if (capFull) why = "cap";
        else if (spec.k !== null && spec.floor && !(rest >= LOT)) why = "lot";
        else if (spec.rules && marginAfter > eqT) why = "margin";
        if (why) {
          run.skipped[why]++;
          if (why === "lot" && run.firstLot === null) run.firstLot = T;
          if (why === "margin") run.happened++;
          // at T on the state at s; the units only where the sizing came to
          // them (§8.99's order: the call and the cap come before it); no price
          row(T, "skip", o.id, why === "call" || why === "cap" ? null : rest, null, null, gs, why);
          continue;
        }
        if (spec.estar) term(0, marginAfter - (eqT - start), T, eqT - start, marginAfter);
        const late = L.entryG !== L.T;
        if (!late) newPositions(o, split, k);
        const now = open.filter((p) => p.part <= 1 && p.order !== o);
        run.entries.push({
          // the ledger's seq of its (last) enter row; a late one's not yet written
          seq: late ? -1 : seq,
          id: o.id,
          T,
          open: now.length + pendingNow.length + 1,
          pairOpen: now.filter((p) => p.leg.pi === L.pi).length + pendingNow.filter((x) => x.leg.pi === L.pi).length + 1,
          jpyWay: L.jpy ? now.filter((p) => p.leg.jpy && p.leg.dir === L.dir).length + pendingNow.filter((x) => x.leg.jpy && x.leg.dir === L.dir).length + 1 : 0,
          jpyBuy: now.filter((p) => p.leg.jpy && p.leg.dir === 1).length + pendingNow.filter((x) => x.leg.jpy && x.leg.dir === 1).length + (L.jpy && L.dir === 1 ? 1 : 0),
          jpySell: now.filter((p) => p.leg.jpy && p.leg.dir === -1).length + pendingNow.filter((x) => x.leg.jpy && x.leg.dir === -1).length + (L.jpy && L.dir === -1 ? 1 : 0),
          marginAfter,
          equity: eqT,
          inputAt,
          units: rest,
          inCall: call !== null,
          passed: L.exit === "passed",
        });
        if (late) {
          // five minutes late: in at its first bar's close, after that bar's
          // own exits (or not in: a level passed first)
          pendingNow.push({ leg: L, units: rest });
          lateQ.push({ o, split });
        }
      }
    }

    // ③ the exits inside the bar, in the order the trades were taken
    for (const p of [...open]) if (p.leg.giX === k) closePos(p, p.units, p.leg.exitPx, convAt(p.leg, k), p.leg.exit, g, k);
    // then the late orders in at this bar's close (T + 5 minutes), in the order taken
    while (lateQ.length && lateQ[0].o.legs[0].entryG <= g) {
      const { o, split } = lateQ.shift()!;
      const L = o.legs[0];
      if (L.exit === "passed") {
        run.skipped.passed++;
        row(L.entryG, "skip", o.id, split[0], null, null, k, "passed");
      } else newPositions(o, split, k, L.entryG);
    }

    // ④ the loss-cut on the exit side's closes (lcworst: every position at its
    // bar's worst at once), then the cure of an open call
    const how = spec.lcworst ? 1 : 0;
    const eq = equityAt(k, how);
    const mg = open.length ? marginAt(k) : 0;
    if (spec.estar) {
      term(2, spec.losscut * mg - (eq - start), g, eq - start, spec.losscut * mg);
      // the P/L's most negative on the exit side's closes (lcworst moves only
      // the loss-cut term to the worst, interface.md §3)
      const pl = (how === 0 ? eq : equityAt(k, 0)) - start;
      term(3, -pl, g, pl, 0);
    }
    // the planted skipgaplc: no loss-cut on the first bar after a weekend
    const afterGap = k > 0 && G[k] - G[k - 1] > 12 * HOUR;
    if (open.length && spec.rules && eq < spec.losscut * mg && !(plant === "skipgaplc" && afterGap)) {
      run.happened++;
      run.losscuts.push({ g, equity: eq, margin: mg, balance, positions: open.length, after: Number.NaN });
      row(g, "losscut", "", null, null, null, k);
      for (const p of [...open]) closePos(p, p.units, pxAt(p.leg, k, how), convAt(p.leg, k), "losscut", g, k);
      run.losscuts[run.losscuts.length - 1].after = balance;
      shortfall(g, k);
    }
    // nothing open and the account under 0 (what E*'s last term guards)
    const negative = !open.length && balance < 0;
    if (negative && !wasNegative) run.negatives++;
    wasNegative = negative;
    if (call) {
      const c = call;
      let cured: boolean;
      if (spec.strict) cured = c.held.every((h) => h.pos.units <= 0);
      // the planted curemove: cured once the equity is back over the margin (a price move)
      else if (plant === "curemove") cured = equityAt(k, 0) >= marginAt(k);
      else {
        // the margin of the positions held at the close, at its prices, with
        // what is left of them now: cured once it fell by C (MAX: closing the
        // smaller side of a hedge frees nothing)
        const before = marginOf(c.held.map((h) => ({ pi: h.pos.leg.pi, dir: h.pos.leg.dir, value: h.value })));
        const after = marginOf(c.held.map((h) => ({ pi: h.pos.leg.pi, dir: h.pos.leg.dir, value: (h.value * Math.max(0, h.pos.units)) / h.units })));
        cured = before - after + 1e-9 >= c.C;
      }
      if (cured) {
        c.outcome = "cured";
        c.at = g;
        call = null;
        row(g, "cure", "", null, null, null, k);
      }
    }

    // ⑤ Rakuten's NY close (or the last g before it): the call, on mids
    while (ni < tape.ny.length && tape.ny[ni].gi < k) ni++;
    while (ni < tape.ny.length && tape.ny[ni].gi === k) {
      const c = tape.ny[ni++];
      const m = open.length ? marginAt(k) : 0;
      // the planted callexitside: judged on the exit side's closes
      const e = equityAt(k, plant === "callexitside" ? 0 : 2);
      run.nyLog.push({ gi: k, seq, margin: m });
      if (spec.estar) term(1, m - (e - start), g, e - start, m);
      if (!(spec.rules && spec.calls && m > 0 && e < m)) continue;
      if (call) {
        // a second close before the first call's deadline (only where the
        // clock has no bar between the two): the first call stands
        run.callsWhileOpen++;
        continue;
      }
      run.happened++;
      call = { tau: c.tau, g, gi: k, C: m - e, equity: e, margin: m, deadline: c.deadline, held: open.map((p) => ({ pos: p, units: p.units, value: valueOf(p, k) })), outcome: "open", at: null };
      run.calls.push(call);
      row(g, "call", "", null, null, call.C, k);
    }

    // ⑥ the account at g
    let e = balance;
    let w = balance;
    let v = 0;
    for (const p of open) {
      e += plAt(p, k, 0);
      w += plAt(p, k, 1);
      v += valueOf(p, k);
      if (!tape.own[p.leg.pi][k]) run.stale++;
      if (p.leg.usd && !tape.own[tape.usd][k]) run.staleUsd++;
    }
    run.E[k] = e;
    run.W[k] = w;
    run.B[k] = balance;
    run.M[k] = open.length ? marginAt(k) : 0;
    run.gross[k] = v;
  }
  run.leftOpen = open.length + lateQ.length;
  run.happened += run.negatives;
  return run;
};

// thirds' units (§8.99 利確1・2・3に分ける): 10,000 units 4,000, 3,000 and
// 3,000; a k% order's whole, decided first, dealt out 1,000 at a time to
// TP1, TP2, TP3, TP1, … (the larger parts first: 10,000 so comes out 4, 3, 3)
export const splitThirds = (units: number, fixed: boolean): number[] => {
  if (fixed) return [4000, 3000, 3000];
  const lots = Math.round(units / LOT);
  return [0, 1, 2].map((j) => (Math.floor(lots / 3) + (j < lots % 3 ? 1 : 0)) * LOT);
};

// ---- another order of one close's emails (§8.99 順番の幅) -----------------------------------

// the emails of each close in the order of sha256(`${r}|${pair}|${side}|${T_iso}`)
// as hex strings, ascending (interface.md §2); the closes stay in time order
export const hashOrder = async (orders: Order[], r: number): Promise<Order[]> => {
  const keys = new Map<Order, string>();
  for (const o of orders) {
    const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${r}|${o.sig.pair}|${o.sig.side}|${new Date(o.T).toISOString()}`)));
    keys.set(o, Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(""));
  }
  return [...orders].sort((a, b) => a.T - b.T || (keys.get(a)! < keys.get(b)! ? -1 : keys.get(a)! > keys.get(b)! ? 1 : 0));
};

// ---- the numbers of a run (§8.99 出すもの ますごと; interface.md §4.4) -------------------------

const dayOf = (t: number) => Math.floor((t - 21 * HOUR) / DAY);
const isoOrNull = (t: number | null) => (t === null || !Number.isFinite(t) ? null : iso(t));

// the largest fall of xs over the clock's indices from..to (the peak from
// `peaks`, by default xs itself), in yen and against the account then
// (`base` + the peak); its peak, trough and the time it was made up (null: not)
const fallOf = (G: Float64Array, xs: Float64Array, from: number, to: number, base: number, start: number, keep: (k: number) => boolean = () => true, peaks: Float64Array = xs) => {
  let peak = start;
  let peakAt = from >= 0 ? G[from] : Number.NaN;
  let dd = 0;
  let pct = 0;
  let at = { peak: peakAt, trough: Number.NaN, peakV: start };
  let open = false;
  let recovered: number | null = null;
  for (let k = Math.max(from, 0); k <= to; k++) {
    if (!keep(k)) continue;
    if (peaks[k] > peak) {
      peak = peaks[k];
      peakAt = G[k];
    }
    const d = peak - xs[k];
    if (d > dd) {
      dd = d;
      at = { peak: peakAt, trough: G[k], peakV: peak };
      open = true;
      recovered = null;
    }
    if (open && recovered === null && xs[k] >= at.peakV) recovered = G[k];
    const den = base + peak;
    if (den > 0 && d / den > pct) pct = d / den;
  }
  return { yen: dd, pct, peak: isoOrNull(at.peak), trough: isoOrNull(at.trough), recovered: dd > 0 ? isoOrNull(recovered) ?? "not made up" : null };
};

// one run's numbers: the account (from `start`: the k% cells' 1,000,000; the
// F10k cells' 0, their ratios against their own E*), the trades it took
export const summarize = (run: Run, splitMs: number) => {
  const { spec, tape } = run;
  const G = tape.g;
  const n = G.length;
  const f10k = spec.k === null;
  const start = spec.start;
  // E* and its terms (F10k)
  let estar: { value: number; set_by: string; g: string | null; lost: number; margin: number; terms: Array<{ name: string; value: number; g: string | null; lost: number; margin: number }> } | null = null;
  if (run.estar) {
    const best = run.estar.reduce((a, t) => (t.value > a.value ? t : a));
    estar = { value: best.value, set_by: best.name, g: isoOrNull(best.g), lost: best.lost, margin: best.margin, terms: run.estar.map((t) => ({ name: t.name, value: t.value, g: isoOrNull(t.g), lost: t.lost, margin: t.margin })) };
  }
  // the account the ratios are on: the F10k cells' own E*
  const base = f10k ? (estar?.value ?? 0) : 0;
  // the orders in (a late one a level passed before its fill was never in)
  const ins = run.entries.filter((e) => !e.passed);
  const taken = ins.length;
  const firstT = taken ? ins[0].T : null;
  const lastX = run.closed.reduce((a, p) => Math.max(a, ...p.closes.map((c) => c.g)), -Infinity);
  // the span: the closes of G from the last before the first entry to the last exit
  const k0 = firstT === null ? 0 : Math.max(0, upperBound(G, firstT) - 1);
  const k1 = Number.isFinite(lastX) ? upperBound(G, lastX) - 1 : n - 1;
  const span = Math.max(0, k1 - k0 + 1);
  const finalB = n ? run.B[n - 1] : start;
  const finalE = n ? run.E[n - 1] : start;

  // the falls: on every 5-minute close with the open P/L; on the 4-hour
  // closes only; on the exits only (the realised balance); and with every
  // position at its bar's worst at once (the peak from the closes: an upper limit)
  const four = (k: number) => G[k] % (4 * HOUR) === 0;
  const dd5 = fallOf(G, run.E, k0, k1, base, start);
  const dd4 = fallOf(G, run.E, k0, k1, base, start, four);
  const ddX = fallOf(G, run.B, k0, k1, base, start);
  const ddW = fallOf(G, run.W, k0, k1, base, start, undefined, run.E);
  let belowStart = 0;
  for (let k = k0; k <= k1; k++) belowStart = Math.max(belowStart, start - run.E[k]);

  // the worst week (Sunday 21:00 UTC) and day (21:00 UTC): the equity at the
  // end of each less the end of the one before (a bar counted by its open)
  const worstOf = (key: (t: number) => number) => {
    let prev = start;
    let cur = Number.NaN;
    let curKey = Number.NaN;
    let worst = { yen: 0, pct: 0, from: null as string | null };
    const close = () => {
      if (Number.isNaN(curKey)) return;
      const d = cur - prev;
      if (d < worst.yen) worst = { yen: d, pct: base + prev > 0 ? d / (base + prev) : Number.NaN, from: iso(key === weekOf ? curKey * WEEK + WEEK_OFFSET : curKey * DAY + 21 * HOUR) };
      prev = cur;
    };
    for (let k = k0; k <= k1; k++) {
      const w = key(G[k] - FINE);
      if (w !== curKey) {
        close();
        curKey = w;
      }
      cur = run.E[k];
    }
    close();
    return worst;
  };
  const worstWeek = worstOf(weekOf);
  const worstDay = worstOf(dayOf);

  // the longest time under the peak (the 5-minute closes), and the share of the span under it
  let peak = start;
  let peakAt = k0 < n ? G[k0] : 0;
  let longest = { ms: 0, from: null as string | null, to: null as string | null, made_up: true };
  let under = 0;
  for (let k = k0; k <= k1; k++) {
    if (run.E[k] >= peak) {
      const ms = G[k] - peakAt;
      if (ms > longest.ms && k > k0 && run.E[k - 1] < peak) longest = { ms, from: iso(peakAt), to: iso(G[k]), made_up: true };
      peak = run.E[k];
      peakAt = G[k];
    } else under++;
  }
  if (k1 >= k0 && run.E[k1] < peak && G[k1] - peakAt > longest.ms) longest = { ms: G[k1] - peakAt, from: iso(peakAt), to: iso(G[k1]), made_up: false };
  const wholeMs = k1 >= k0 ? G[k1] - G[k0] : 0;

  // margin over equity at each close of the span, the leverage used (the
  // positions' value in yen, both sides, over the equity)
  const ratios: number[] = [];
  let over08 = 0;
  let ratioMax = 0;
  let levMax = 0;
  for (let k = k0; k <= k1; k++) {
    const eq = base + run.E[k];
    if (run.M[k] > 0) {
      const r = run.M[k] / eq;
      ratios.push(r);
      ratioMax = Math.max(ratioMax, r);
      if (r > 0.8) over08++;
      levMax = Math.max(levMax, run.gross[k] / eq);
    }
  }

  // the halves and the calendar years: the equity at the end of each
  const eqBefore = (ms: number) => {
    const k = upperBound(G, ms - 1) - 1;
    return k >= 0 ? run.E[k] : start;
  };
  const atSplit = eqBefore(splitMs);
  const years: Record<string, number> = {};
  if (n) {
    for (let y = new Date(G[0]).getUTCFullYear(); y <= new Date(G[n - 1]).getUTCFullYear(); y++) {
      const a = eqBefore(Date.UTC(y, 0, 1));
      const b = eqBefore(Date.UTC(y + 1, 0, 1));
      years[String(y)] = b - a;
    }
  }
  const spanYears = firstT !== null && Number.isFinite(lastX) ? (lastX - firstT) / (365.25 * DAY) : Number.NaN;

  // the trades it took: each email's positions together (thirds' legs one
  // trade); TP1 first counted on the TP1 leg; one netted by the other side's
  // email (any of it) is "net", in the count, never a win
  const byOrder = new Map<string, Pos[]>();
  for (const p of run.closed) byOrder.set(p.order.id, [...(byOrder.get(p.order.id) ?? []), p]);
  let tp = 0;
  let sl = 0;
  let amb = 0;
  let pipsSum = 0;
  let yenSum = 0;
  let kinds: Record<string, number> = {};
  for (const ps of byOrder.values()) {
    const first = ps.find((p) => p.part <= 1)!;
    const kind = ps.some((p) => p.netted) ? "net" : first.closes[first.closes.length - 1].kind;
    kinds[kind] = (kinds[kind] ?? 0) + 1;
    if (kind === "tp") tp++;
    if (kind === "sl") sl++;
    if (kind === "amb") amb++;
    // pips weighted by units (thirds: 0.4, 0.3, 0.3 of 10,000), the yen in all
    let u = 0;
    let pu = 0;
    for (const p of ps) {
      u += p.units0;
      for (const c of p.closes) {
        pu += (c.units * p.leg.dir * (c.px - p.leg.fill)) / p.leg.unit;
        yenSum += c.pnl;
      }
    }
    pipsSum += u > 0 ? pu / u : 0;
  }
  const nT = byOrder.size;
  kinds = Object.fromEntries(Object.entries(kinds).sort());
  const opens = ins.map((e) => e.open);

  return {
    key: spec.key,
    row: spec.row || null,
    sizing: f10k ? "F10k" : `FF ${(100 * spec.k!).toFixed(2)}%`,
    cap: spec.cap,
    course: spec.rate === 0.1 ? "10x" : "25x",
    rules: spec.rules,
    start,
    final_balance: finalB,
    final_equity: finalE,
    total_yen: finalE - start,
    final_pct: f10k ? null : (finalE - start) / start,
    halves_yen: [atSplit - start, finalE - atSplit],
    years_yen: years,
    a_year: f10k ? (spanYears > 0 ? (finalE - start) / spanYears : null) : spanYears > 0 && finalE > 0 ? (finalE / start) ** (1 / spanYears) - 1 : null,
    mdd_yen: dd5.yen,
    mdd_pct: dd5.pct,
    mdd: dd5,
    mdd_4h: dd4,
    mdd_exits: ddX,
    mdd_worst: ddW,
    below_start_max: belowStart,
    worst_week_yen: worstWeek.yen,
    worst_week: worstWeek,
    worst_day_yen: worstDay.yen,
    worst_day: worstDay,
    under_peak: { longest_ms: longest.ms, longest_from: longest.from, longest_to: longest.to, made_up: longest.made_up, longest_share: wholeMs > 0 ? longest.ms / wholeMs : null, share_of_closes: span ? under / span : null },
    taken,
    skipped: run.skipped,
    first_lot_skip: isoOrNull(run.firstLot),
    net_only: run.netOnly,
    concurrency: { at_entry_max: opens.length ? Math.max(...opens) : 0, at_entry_median: medianOf(opens), jpy_one_way_max: ins.reduce((a, e) => Math.max(a, e.jpyBuy, e.jpySell), 0) },
    margin_ratio: { max: ratios.length ? ratioMax : null, median: medianOf(ratios), share_over_08: span ? over08 / span : null, leverage_max: ratios.length ? levMax : null },
    calls: run.calls.length,
    cures: run.calls.filter((c) => c.outcome === "cured").length,
    deadlines: run.deadlines.length,
    losscuts: run.losscuts.length,
    call_list: run.calls.map((c) => ({ tau: iso(c.tau), judged_at: iso(c.g), C: c.C, equity_mid: c.equity, margin: c.margin, deadline: iso(c.deadline), outcome: c.outcome, at: isoOrNull(c.at) })),
    losscut_list: run.losscuts.map((l) => ({ g: iso(l.g), equity: l.equity, margin: l.margin, positions: l.positions, balance_after: l.after })),
    deadline_list: run.deadlines.map((d) => ({ g: iso(d.g), deadline: iso(d.deadline), positions: d.positions, balance_after: d.after })),
    calls_while_open: run.callsWhileOpen,
    shortfall_yen: run.shortfalls.reduce((a, x) => Math.max(a, -x.balance), 0),
    shortfall_list: run.shortfalls.map((x) => ({ g: iso(x.g), balance: x.balance })),
    trades: nT,
    exits: kinds,
    win_all: nT ? tp / nT : null,
    win_resolved: tp + sl + amb ? tp / (tp + sl + amb) : null,
    mean_pips: nT ? pipsSum / nT : null,
    mean_r: nT ? pipsSum / nT / SL : null,
    mean_yen: nT ? yenSum / nT : null,
    stale_marks: run.stale,
    stale_usdjpy: run.staleUsd,
    left_open: run.leftOpen,
    estar,
    estar_note: f10k ? "the account the path needed (looking back over this period); the F10k cell's ratios are against it; no call, loss-cut or shortfall on this path with an account of E* or more" : null,
  };
};
export type Summary = ReturnType<typeof summarize>;

// ---- the ledger file (interface.md §4.3) --------------------------------------------------------

export const ledgerCsv = (run: Run): string => {
  const cell = (x: number | string | null) => (x === null ? "" : String(x));
  const lines = run.ledger.map((r) => [r[0], iso(r[1]), r[2], r[3], cell(r[4]), cell(r[5]), cell(r[6]), r[7], r[8], r[9], r[10]].map(cell).join(","));
  return ["seq,g,kind,id,units,px,pnl_yen,balance,equity,margin,reason", ...lines].join("\n") + "\n";
};

// ---- the account's own identities (§8.99 確かめ 口座の式) ---------------------------------------

// 1e-6 yen, or 1e-12 of the amount where it is larger than 1,000,000 (the
// drift walks' accounts grow far past it; a sum's rounding grows with it)
const tolY = (x: number) => 1e-6 * Math.max(1, Math.abs(x) / 1e6);

// the checks of one run (each named as in money.json's checks); `drifting`:
// a drift walk, where the units may pass 5,000,000 (the walk's, not a fault)
export const runChecks = (run: Run, checks: Record<string, Check>, drifting: boolean) => {
  const { spec, tape } = run;
  const G = tape.g;
  const n = G.length;
  const key = spec.key;
  const ck = (name: string) => (checks[name] ??= newCheck());

  // (A1) the final balance = the start + every close's yen (1e-6 yen), and the
  // ledger's exit rows add up to it as well
  const fromCloses = run.closed.reduce((a, p) => a + p.closes.reduce((b, c) => b + c.pnl, 0), 0);
  const fromLedger = run.ledger.reduce((a, r) => a + (r[2] === "exit" ? r[6]! : 0), 0);
  const finalB = n ? run.B[n - 1] : spec.start;
  tally(ck("acct_balance"), Math.abs(finalB - spec.start - fromCloses) <= tolY(finalB) && Math.abs(finalB - spec.start - fromLedger) <= tolY(finalB), () => `${key}: final ${finalB}, start + Σ closes ${spec.start + fromCloses}, + Σ ledger ${spec.start + fromLedger}`);

  // (A2) the balance and the equity again at every g, by another loop: each
  // close's yen from its price (units × dir × (price − fill) × USD/JPY), each
  // position open at the end of a bar on its own marks; against ⑥'s record
  const bal = new Float64Array(n);
  const eq = new Float64Array(n);
  for (const p of run.closed) {
    const L = p.leg;
    let units = p.units0;
    let from = p.openBar;
    for (const c of p.closes) {
      // the close's yen, again
      const conv = spec.plant === "usdentry" ? L.convT : c.conv;
      let y = c.units * L.dir * (c.px - L.fill) * conv;
      if (p.shift !== 0) y += p.shift * (c.units / p.units0) * (c.gi < L.gi0 ? 0 : Math.min(1, (c.gi - L.gi0 + 1) / L.hold));
      bal[c.bar] += y;
      // held through the bars before this close's (at their closes)
      for (let k = from; k < c.bar; k++) eq[k] += markYen(p, units, k, spec.plant);
      units -= c.units;
      from = c.bar;
    }
  }
  // the largest miss over the tolerance there (1e-6 yen, or 1e-12 of the amount)
  let b = spec.start;
  let worstB = 0;
  let worstE = 0;
  let worstAt = -1;
  for (let k = 0; k < n; k++) {
    b += bal[k];
    const dB = Math.abs(b - run.B[k]) / tolY(run.B[k]);
    const dE = Math.abs(b + eq[k] - run.E[k]) / tolY(run.E[k]);
    if (dB > worstB) worstB = dB;
    if (dE > worstE) {
      worstE = dE;
      worstAt = k;
    }
  }
  tally(ck("acct_reloop"), worstB <= 1 && worstE <= 1 && run.leftOpen === 0, () => `${key}: balance off by ${worstB} tolerances, equity by ${worstE}${worstAt >= 0 ? ` (at ${iso(G[worstAt])})` : ""}; left open ${run.leftOpen}`);

  // (A3) a close at a bar's close (a time-out, a loss-cut) is at its mark
  // there; a close at a level is the trade's own exit price
  for (const p of run.closed) {
    for (const c of p.closes) {
      const L = p.leg;
      let ok = true;
      if (c.kind === "time") ok = c.px === L.mark[L.hold - 1] && c.gi === L.giX;
      else if (c.kind === "losscut") ok = c.px === (spec.lcworst ? L.worst : L.mark)[Math.min(Math.max(c.gi - L.gi0, 0), L.hold - 1)];
      else if (c.kind === "tp" || c.kind === "sl" || c.kind === "amb") ok = c.px === L.exitPx && c.gi === L.giX;
      tally(ck("acct_mark_at_exit"), ok, () => `${key} ${p.id} ${c.kind} at ${c.px} (mark ${L.mark[Math.min(Math.max(c.gi - L.gi0, 0), L.hold - 1)]}, exit ${L.exitPx})`);
    }
  }

  // (A3b) thirds: each part out at its own exit has the pips of the trade
  // out whole at TP1, TP2 or TP3 (§8.99 確かめ, 1e-6)
  if (spec.thirds) {
    for (const p of run.closed) {
      const c = p.closes[p.closes.length - 1];
      if (c.kind !== p.leg.exit) continue;
      const pips = (p.leg.dir * (c.px - p.leg.fill)) / p.leg.unit;
      tally(ck("acct_thirds_pips"), Math.abs(pips - p.leg.pips) <= 1e-6, () => `${key} ${p.id}: ${pips} pips, the whole-at-TP${p.part} trade's ${p.leg.pips}`);
    }
  }

  // (A4) every entry: its sizing inputs from T or before; the cap kept; the
  // margin after it within the equity (the account's rules on); not in a call;
  // its units in 1,000s from 1,000 to 5,000,000 (F10k: 10,000)
  for (const e of run.entries) {
    tally(ck("acct_inputs_time"), e.inputAt <= e.T, () => `${key} ${e.id}: sized on ${iso(e.inputAt)}, after T ${iso(e.T)}`);
    const capOk = spec.cap === "T1" ? e.open <= 1 : spec.cap === "T3" ? e.open <= 3 : spec.cap === "P1" ? e.pairOpen <= 1 : spec.cap === "J2" ? e.jpyWay <= 2 : true;
    tally(ck("acct_caps"), capOk, () => `${key} ${e.id}: ${e.open} open (its pair ${e.pairOpen}, yen its way ${e.jpyWay}) under ${spec.cap}`);
    if (spec.rules) tally(ck("acct_margin_order"), e.marginAfter <= e.equity, () => `${key} ${e.id}: margin after ${e.marginAfter} over the equity ${e.equity}`);
    tally(ck("acct_no_entry_in_call"), !e.inCall, () => `${key} ${e.id}: in during a call`);
    if (spec.floor) {
      const inLots = Number.isInteger(e.units / LOT) && e.units >= LOT && (drifting || e.units <= MAX_UNITS);
      tally(ck("acct_units"), inLots && (spec.k !== null || e.units === 10_000), () => `${key} ${e.id}: ${e.units} units`);
    }
  }

  // (A5) after a loss-cut or a deadline nothing is open (the ledger's units by id)
  const held = new Map<string, number>();
  let forced = false;
  const flatAfterForced = () => {
    if (!forced) return;
    const left = [...held.values()].reduce((a, u) => a + u, 0);
    tally(ck("acct_flat_after"), left === 0, () => `${key}: ${left} units still open after a loss-cut or deadline`);
    forced = false;
  };
  for (const r of run.ledger) {
    if (r[2] !== "exit" && r[2] !== "shortfall") flatAfterForced();
    if (r[2] === "losscut" || r[2] === "deadline") forced = true;
    if (r[2] === "enter") held.set(r[3], (held.get(r[3]) ?? 0) + r[4]!);
    if (r[2] === "exit") {
      const u = (held.get(r[3]) ?? 0) - r[4]!;
      if (u <= 1e-9) held.delete(r[3]);
      else held.set(r[3], u);
    }
  }
  flatAfterForced();

  // (A6) the fall on the 5-minute closes is at least the 4-hour closes' one
  const s = summarize(run, 0);
  tally(ck("acct_mdd"), s.mdd_yen >= s.mdd_4h.yen - 1e-9, () => `${key}: 5-minute fall ${s.mdd_yen} under the 4-hour ${s.mdd_4h.yen}`);

  // (A7) the margin again, from the positions the ledger had open, at each
  // entry (after it) and at each NY close: per pair the larger side (MAX)
  const units = (p: Pos, q: number) => (p.openSeq <= q && (p.closeSeq === 0 || p.closeSeq > q) ? p.units0 - p.closes.filter((c) => c.seq <= q).reduce((a, c) => a + c.units, 0) : 0);
  const marginAgain = (q: number, gi: number, ps: Iterable<Pos>): number => {
    const sides = new Map<string, [number, number]>();
    for (const p of ps) {
      const u = units(p, q);
      if (!(u > 0)) continue;
      const L = p.leg;
      const j = gi - L.gi0;
      const v = spec.plant === "marginentry" ? u * L.midT * L.convT : j < 0 ? u * L.midT * L.convT : u * L.mid[Math.min(j, L.hold - 1)] * (L.conv ? L.conv[Math.min(j, L.hold - 1)] : 1);
      const x = sides.get(L.pair) ?? [0, 0];
      x[L.dir > 0 ? 0 : 1] += v;
      sides.set(L.pair, x);
    }
    let m = 0;
    for (const [l, r] of sides.values()) m += spec.plant === "hedgesum" ? l + r : Math.max(l, r);
    return spec.rate * m;
  };
  // the questions in the ledger's order, the positions swept in and out by
  // their seqs (at each entry, on the state it was judged on: the last g at
  // or before its T; a late order is judged at T but in only at T + 5
  // minutes, its margin then not a position's: compared at the NY closes only)
  const asks = [
    ...run.entries.filter((e) => e.seq >= 0).map((e) => ({ q: e.seq, gi: upperBound(G, e.T) - 1, want: e.marginAfter, what: e.id })),
    ...run.nyLog.map((x) => ({ q: x.seq, gi: x.gi, want: x.margin, what: `NY close at ${iso(G[x.gi])}` })),
  ].sort((a, b) => a.q - b.q);
  const byOpen = [...run.closed].sort((a, b) => a.openSeq - b.openSeq);
  const byClose = [...run.closed].sort((a, b) => a.closeSeq - b.closeSeq);
  const active = new Set<Pos>();
  let i = 0;
  let j = 0;
  for (const x of asks) {
    while (i < byOpen.length && byOpen[i].openSeq <= x.q) active.add(byOpen[i++]);
    while (j < byClose.length && byClose[j].closeSeq <= x.q) active.delete(byClose[j++]);
    const m = marginAgain(x.q, x.gi, active);
    tally(ck("acct_margin_reloop"), Math.abs(m - x.want) <= 1e-6 * Math.max(1, m), () => `${key} ${x.what}: margin ${x.want}, again ${m}`);
  }
};

// the yen of `units` of p at the close of g[k] (the second loop's own mark)
const markYen = (p: Pos, units: number, k: number, plant: string): number => {
  const L = p.leg;
  const j = k - L.gi0;
  const px = j < 0 ? L.markT : L.mark[Math.min(j, L.hold - 1)];
  const conv = plant === "usdentry" || j < 0 ? L.convT : L.conv ? L.conv[Math.min(j, L.hold - 1)] : 1;
  let y = units * L.dir * (px - L.fill) * conv;
  if (p.shift !== 0) y += p.shift * (units / p.units0) * (j < 0 ? 0 : Math.min(1, (j + 1) / L.hold));
  return y;
};

// (A8) E* exactly (§8.99 確かめ): an account of E* × (1 + 1e-9) under the
// full rules (margin admission, the loss-cut, calls) goes the path's way —
// no margin skip, loss-cut or call, and never under 0 —, one of E* × (1 − 1e-6)
// does not (one of them at least happens)
export const estarCheck = (tape: Tape, orders: Order[], spec: RunSpec, value: number, checks: Record<string, Check>) => {
  const full = (start: number) => runAccount(tape, orders, { ...spec, key: `${spec.key} at ${start}`, rules: true, start, estar: false });
  const above = full(value * (1 + 1e-9));
  const below = full(value * (1 - 1e-6));
  tally((checks.acct_estar ??= newCheck()), value > 0 && above.happened === 0 && below.happened >= 1, () => `${spec.key}: E* ${value}: just above ${above.happened} happened (margin skips ${above.skipped.margin}, loss-cuts ${above.losscuts.length}, calls ${above.calls.length}, under 0 ${above.negatives}); just below ${below.happened}`);
  return { above: above.happened, below: below.happened, below_first: below.ledger.find((r) => r[2] === "losscut" || r[2] === "call" || (r[2] === "skip" && r[10] === "margin")) ?? null };
};

// (A9) caps and margin off (the nomargin row): the run's yen is Σ units ×
// dir × (exit − fill) × USD/JPY's mid at the exit's g, every trade again
export const unitsIdentity = (run: Run, checks: Record<string, Check>) => {
  let sum = 0;
  for (const p of run.closed) {
    const L = p.leg;
    const conv = L.usd ? run.tape.usdMid![L.giX] : 1;
    sum += p.units0 * L.dir * (L.exitPx - L.fill) * (run.spec.plant === "usdentry" ? L.convT : conv);
  }
  const got = run.B[run.B.length - 1] - run.spec.start;
  tally((checks.acct_units_sum ??= newCheck()), Math.abs(got - sum) <= tolY(got) && run.closed.every((p) => p.closes.length === 1 && p.closes[0].kind === p.leg.exit), () => `${run.spec.key}: the run's yen ${got}, Σ units × dir × (exit − fill) × USD/JPY ${sum}`);
  return { yen: got, again: sum };
};

// (A10) k tiny (1e-6, no floor, no margin) from 1 yen: (final − 1) ÷ k is
// Σ R in yen (each trade's yen over its 13 pips in yen at T) to 1e-3
export const tinyKIdentity = (study: Study, checks: Record<string, Check>, plant: string) => {
  const spec: RunSpec = { ...specOf("FF1_C0", plant), key: "identity_tiny_k", k: 1e-6, start: 1, floor: false, rules: false, estar: false };
  const tape = tapeOf(study, "main", "CALL9");
  const run = runAccount(tape, ordersOf(study, spec), spec);
  let sumR = 0;
  for (const p of run.closed) {
    const L = p.leg;
    const conv = L.usd ? tape.usdMid![L.giX] : 1;
    sumR += (L.dir * (L.exitPx - L.fill) * conv) / (SL * L.unit * L.convT);
  }
  const got = (run.B[run.B.length - 1] - 1) / spec.k!;
  tally((checks.acct_tiny_k ??= newCheck()), Math.abs(got - sumR) <= 1e-3 * Math.max(1, Math.abs(sumR)), () => `(final − 1) ÷ k ${got}, Σ R in yen ${sumR}`);
  return { got, sum_r: sumR, trades: run.closed.length };
};
