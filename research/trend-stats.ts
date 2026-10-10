// #250 (docs §8.106 段1の作り): the pieces stage 1 and stage 2 compute with, Deno-free.
//
//   * the follow of one email on GMO's 5-minute bars (段1の作り 2; tf-winrate.ts follow, the same steps)
//   * the stratified difference δ, its influence-function standard error clustered by week and by four
//     weeks, the interval and t (段1の作り 3)
//   * the random removals and their line (段1の作り 4)
//   * the hand-made checks of these pieces (段1の作り 7: followHand, deltaHand)
//
// Planted errors (段1の作り 8, the walks only) are set with setPlant and change these pieces where the
// check that must catch them looks.

import { DAY, DAY_OFFSET, MINUTE, WEEK, WEEK_OFFSET } from "./lib.ts";
import { tQuantile } from "./money-stats.ts";

let PLANT = "";
export const setPlant = (p: string) => {
  PLANT = p;
};

export const weekOf = (t: number) => Math.floor((t - WEEK_OFFSET) / WEEK);
export const dayOf = (t: number) => Math.floor((t - DAY_OFFSET) / DAY);
export const TRACK = 1_440;
export const SIDES = ["BUY", "SELL"] as const;
// a stratum: the pair (its place in PAIRS) and the side (段1の作り 3: 10, the pairs' order × BUY, SELL)
export const stratumOf = (pi: number, buy: boolean): number => (PLANT === "noSideStratum" ? pi * 2 : pi * 2 + (buy ? 0 : 1));

// ---- the follow ---------------------------------------------------------------------------------

export type Kind = "tp" | "sl" | "amb" | "open";
export interface Fine {
  n: number;
  t: Float64Array;
  bo: Float64Array;
  bh: Float64Array;
  bl: Float64Array;
  bc: Float64Array;
  ao: Float64Array;
  ah: Float64Array;
  al: Float64Array;
  ac: Float64Array;
}
export const lowerBound = (xs: ArrayLike<number>, v: number): number => {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (xs[m] < v) lo = m + 1;
    else hi = m;
  }
  return lo;
};

// out at `tp` or `sl` from bar `from` on, on the side the trade leaves on (BUY the bid, SELL the ask): a bar
// opening past a level fills at its open (the stop first), one reaching both is the stop ("amb"); still open
// after TRACK bars, out at the last bar's close. null: the data ends before TRACK bars (tf-winrate's follow)
export const follow = (f: Fine, from: number, buy: boolean, sl: number, tp: number): { kind: Kind; exit: number; bars: number } | null => {
  const last = from + TRACK - 1;
  if (from < 0 || last > f.n - 1) return null;
  // planted: the exits read on the side the trade fills on (BUY the ask)
  const bidSide = PLANT === "exitSideSwap" ? !buy : buy;
  const o = bidSide ? f.bo : f.ao;
  const h = bidSide ? f.bh : f.ah;
  const l = bidSide ? f.bl : f.al;
  for (let j = from; j <= last; j++) {
    if (buy ? o[j] <= sl : o[j] >= sl) return { kind: "sl", exit: o[j], bars: j - from + 1 };
    if (buy ? o[j] >= tp : o[j] <= tp) return { kind: "tp", exit: o[j], bars: j - from + 1 };
    const hitTp = buy ? h[j] >= tp : l[j] <= tp;
    const hitSl = buy ? l[j] <= sl : h[j] >= sl;
    if (hitTp && hitSl) return { kind: "amb", exit: sl, bars: j - from + 1 };
    if (hitSl) return { kind: "sl", exit: sl, bars: j - from + 1 };
    if (hitTp) return { kind: "tp", exit: tp, bars: j - from + 1 };
  }
  return { kind: "open", exit: bidSide ? f.bc[last] : f.ac[last], bars: TRACK };
};

// one email's trade at one TP (pips from E): entered at the signal bar's close (BUY the ask, SELL the bid),
// the levels from E, followed from C (T, or T + 15 minutes for a late signal)
export interface Trade {
  T: number;
  C: number;
  buy: boolean;
  E: number;
  unit: number;
  bidC: number;
  askC: number;
}
export const STOP = 13;
export const TPS = [4, 10, 16] as const;
export interface Res {
  kind: Kind;
  pips: number;
  bars: number;
}
export const tradeOf = (f: Fine, x: Trade, tpPips: number): Res | null => {
  // planted: a late signal followed from T
  const at = PLANT === "lateFromT" ? x.T : x.C;
  const from = lowerBound(f.t, at);
  const dir = x.buy ? 1 : -1;
  const sl = x.E - dir * STOP * x.unit;
  const tp = x.E + dir * tpPips * x.unit;
  const r = follow(f, from, x.buy, sl, tp);
  if (!r) return null;
  const fill = x.buy ? x.askC : x.bidC;
  return { kind: r.kind, pips: (x.buy ? r.exit - fill : fill - r.exit) / x.unit, bars: r.bars };
};

// ---- δ and its interval --------------------------------------------------------------------------

export interface Item {
  // the stratum (pair × side; any integer key)
  s: number;
  kept: boolean;
  y: number;
  // the week of T (weekOf)
  week: number;
}
export interface Delta {
  d: number;
  se: number;
  seWeek: number;
  se4: number;
  C: number;
  CWeek: number;
  C4: number;
  by: "week" | "4w";
  df: number;
  lo: number;
  hi: number;
  t: number;
  // the left-out and all (kept + left out) emails of the strata used; the left-out ones of strata left out
  nOut: number;
  nAll: number;
  outDropped: number;
  strata: number;
}

// 段1の作り 3 (§8.106 4 「広い方を使う」): the clustering whose interval is the wider — half-width t(0.975, C − 1) ×
// the standard error — the week's on a tie, and the week's alone when there are fewer than 10 four-week blocks
export const pickSe = (seWeek: number, CWeek: number, se4: number, C4: number): { se: number; C: number; by: "week" | "4w" } => {
  if (C4 < 10 || !(se4 >= 0)) return { se: seWeek, C: CWeek, by: "week" };
  const hw = CWeek >= 2 ? tQuantile(0.975, CWeek - 1) * seWeek : Number.NaN;
  const h4 = tQuantile(0.975, C4 - 1) * se4;
  return h4 > hw || !Number.isFinite(hw) ? { se: se4, C: C4, by: "4w" } : { se: seWeek, C: CWeek, by: "week" };
};

const seOf = (m: Map<number, number>): number => {
  const C = m.size;
  if (C < 2) return Number.NaN;
  let v = 0;
  for (const x of m.values()) v += x * x;
  return Math.sqrt((C / (C - 1)) * v);
};

// δ = Σ_s (n_out,s / N_out)(mean kept_s − mean out_s) × sign (B30: sign −1, left out minus kept); a stratum
// without a kept or a left-out email is not used. w0: the half's first week (the four-week blocks' origin)
export const deltaOf = (items: ReadonlyArray<Item>, w0: number, sign: 1 | -1 = 1): Delta => {
  const acc = new Map<number, { nK: number; sK: number; nO: number; sO: number }>();
  for (const it of items) {
    let a = acc.get(it.s);
    if (!a) acc.set(it.s, (a = { nK: 0, sK: 0, nO: 0, sO: 0 }));
    if (it.kept) {
      a.nK++;
      a.sK += it.y;
    } else {
      a.nO++;
      a.sO += it.y;
    }
  }
  let NO = 0;
  let NA = 0;
  let outDropped = 0;
  let strata = 0;
  for (const a of acc.values()) {
    if (a.nK > 0 && a.nO > 0) {
      NO += a.nO;
      NA += a.nK + a.nO;
      strata++;
    } else outDropped += a.nO;
  }
  const nan = Number.NaN;
  if (NO === 0) return { d: nan, se: nan, seWeek: nan, se4: nan, C: 0, CWeek: 0, C4: 0, by: "week", df: nan, lo: nan, hi: nan, t: nan, nOut: 0, nAll: 0, outDropped, strata: 0 };
  let d = 0;
  for (const a of acc.values()) if (a.nK > 0 && a.nO > 0) d += (a.nO / NO) * (a.sK / a.nK - a.sO / a.nO);
  d *= sign;
  const wk = new Map<number, number>();
  const bk = new Map<number, number>();
  for (const it of items) {
    const a = acc.get(it.s)!;
    if (!(a.nK > 0 && a.nO > 0)) continue;
    let psi: number;
    if (it.kept) psi = ((a.nO / NO) * (it.y - a.sK / a.nK)) / a.nK;
    // planted: the left-out means taken as known (their error left out of the interval)
    else psi = PLANT === "noMeanError" ? 0 : -(it.y - a.sO / a.nO) / NO;
    psi *= sign;
    wk.set(it.week, (wk.get(it.week) ?? 0) + psi);
    const b = Math.floor((it.week - w0) / 4);
    bk.set(b, (bk.get(b) ?? 0) + psi);
  }
  const seWeek = seOf(wk);
  const se4 = seOf(bk);
  const p = pickSe(seWeek, wk.size, se4, bk.size);
  const df = p.C - 1;
  const q = df >= 1 ? tQuantile(0.975, df) : nan;
  return {
    d,
    se: p.se,
    seWeek,
    se4,
    C: p.C,
    CWeek: wk.size,
    C4: bk.size,
    by: p.by,
    df,
    lo: d - q * p.se,
    hi: d + q * p.se,
    t: p.se > 0 && Number.isFinite(p.se) ? d / p.se : nan,
    nOut: NO,
    nAll: NA,
    outDropped,
    strata,
  };
};

// ---- the random removals (段1の作り 4) -------------------------------------------------------------

// mulberry32 (trend-data.ts rng)
export const mulberry32 = (seed: number) => {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};
export const shuffle = <T>(a: T[], rnd: () => number) => {
  for (let i = a.length - 1; i >= 1; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const x = a[i];
    a[i] = a[j];
    a[j] = x;
  }
};
// 段1の作り 4: the seed of a kind's 500 removals
export const removalSeed = (walk: number, half: 1 | 2, cand: number, kind: number) => 250_000 + 10_000 * walk + 1_000 * half + 100 * cand + kind;
export const KINDS = ["pairSideDay", "pairSideWeek", "allPairsSideDay", "allPairsSideWeek"] as const;
export const PER_KIND = 500;

// a compared email of the removals: its stratum (pair × side), side (0 BUY, 1 SELL), pair's place, day and week;
// the emails in T order (on time before late)
export interface REm {
  s: number;
  side: number;
  pi: number;
  day: number;
  week: number;
}

interface Index {
  // per stratum: its blocks ascending, and each block's emails (indexes, in the emails' order)
  blocks: number[][];
  members: Array<Map<number, number[]>>;
  // per side: the blocks of any pair ascending
  sideBlocks: number[][];
}
const indexOf = (ems: ReadonlyArray<REm>, byWeek: boolean, nPairs: number): Index => {
  const nS = nPairs * 2;
  const members: Array<Map<number, number[]>> = Array.from({ length: nS }, () => new Map());
  const side: Array<Set<number>> = [new Set(), new Set()];
  ems.forEach((e, i) => {
    const b = byWeek ? e.week : e.day;
    const m = members[e.s];
    const l = m.get(b);
    if (l) l.push(i);
    else m.set(b, [i]);
    side[e.side].add(b);
  });
  return {
    blocks: members.map((m) => [...m.keys()].sort((a, b) => a - b)),
    members,
    sideBlocks: side.map((x) => [...x].sort((a, b) => a - b)),
  };
};

// One kind's removals, each handed to `use` as out[i] (1: left out): per stratum `target[s]` left out,
// whole blocks taken in the shuffled order while they fit, the block that would pass the target shuffled and
// cut there (段1の作り 4). Returns how many removals missed a stratum's target (randomCounts).
export const removals = (ems: ReadonlyArray<REm>, nPairs: number, target: ReadonlyArray<number>, kind: number, seed: number, use: (out: Uint8Array) => void, count = PER_KIND): number => {
  const byWeek = kind === 2 || kind === 4;
  const allPairs = kind === 3 || kind === 4;
  const ix = indexOf(ems, byWeek, nPairs);
  const rnd = mulberry32(seed);
  const out = new Uint8Array(ems.length);
  const got = new Int32Array(nPairs * 2);
  let missed = 0;
  const take = (s: number, order: number[], need: number) => {
    for (const b of order) {
      if (need === 0) return;
      const idx = ix.members[s].get(b);
      if (!idx) continue;
      if (idx.length <= need) {
        for (const i of idx) out[i] = 1;
        need -= idx.length;
      } else {
        const a = idx.slice();
        shuffle(a, rnd);
        for (let k = 0; k < need; k++) out[a[k]] = 1;
        return;
      }
    }
  };
  for (let r = 0; r < count; r++) {
    out.fill(0);
    if (PLANT === "randomTotal") {
      // planted: the removals matched to the whole number left out, not each stratum's
      const all = [...new Set(ems.map((e) => (byWeek ? e.week : e.day)))].sort((a, b) => a - b);
      shuffle(all, rnd);
      let need = target.reduce((x, y) => x + y, 0);
      for (const b of all) {
        for (let i = 0; i < ems.length && need > 0; i++) {
          if ((byWeek ? ems[i].week : ems[i].day) !== b) continue;
          out[i] = 1;
          need--;
        }
        if (need === 0) break;
      }
    } else if (!allPairs) {
      for (let s = 0; s < nPairs * 2; s++) {
        const order = ix.blocks[s].slice();
        shuffle(order, rnd);
        take(s, order, target[s]);
      }
    } else {
      for (let side = 0; side < 2; side++) {
        const order = ix.sideBlocks[side].slice();
        shuffle(order, rnd);
        for (let pi = 0; pi < nPairs; pi++) take(pi * 2 + side, order, target[pi * 2 + side]);
      }
    }
    got.fill(0);
    for (let i = 0; i < ems.length; i++) if (out[i]) got[ems[i].s]++;
    let ok = true;
    for (let s = 0; s < nPairs * 2; s++) if (got[s] !== target[s]) ok = false;
    if (!ok) missed++;
    use(out);
  }
  return missed;
};

export interface Line {
  // each kind's 97.5% point (the 488th of 500 from the bottom), the highest of them, the removals whose
  // standard error was not over 0 (their t counted as −∞), and the removals that missed a target
  kinds: number[];
  line: number;
  noSe: number;
  missed: number;
  // each kind's t, ascending (for the Python's comparison)
  ts: number[][];
}
export const lineOf = (
  ems: ReadonlyArray<REm>,
  nPairs: number,
  target: ReadonlyArray<number>,
  // the W2 item of email i (null: not decided)
  w2: ReadonlyArray<{ y: number } | null>,
  w0: number,
  seedOf: (kind: number) => number,
): Line => {
  const kinds: number[] = [];
  const ts: number[][] = [];
  let noSe = 0;
  let missed = 0;
  for (let k = 1; k <= 4; k++) {
    const t: number[] = [];
    missed += removals(ems, nPairs, target, k, seedOf(k), (out) => {
      const items: Item[] = [];
      for (let i = 0; i < ems.length; i++) {
        const y = w2[i];
        if (y) items.push({ s: ems[i].s, kept: out[i] === 0, y: y.y, week: ems[i].week });
      }
      const d = deltaOf(items, w0);
      if (Number.isFinite(d.t)) t.push(d.t);
      else {
        noSe++;
        t.push(-Infinity);
      }
    });
    t.sort((a, b) => a - b);
    ts.push(t);
    kinds.push(t[Math.ceil(0.975 * PER_KIND) - 1]);
  }
  return { kinds, line: Math.max(...kinds), noSe, missed, ts };
};

// ---- the hand-made checks (段1の作り 7) -------------------------------------------------------------

const fineOf = (rows: Array<[number, number, number, number, number]>, spread: number, t0: number): Fine => {
  const n = rows.length;
  const f: Fine = { n, t: new Float64Array(n), bo: new Float64Array(n), bh: new Float64Array(n), bl: new Float64Array(n), bc: new Float64Array(n), ao: new Float64Array(n), ah: new Float64Array(n), al: new Float64Array(n), ac: new Float64Array(n) };
  rows.forEach(([o, h, l, c], i) => {
    f.t[i] = t0 + i * 5 * MINUTE;
    f.bo[i] = o;
    f.bh[i] = h;
    f.bl[i] = l;
    f.bc[i] = c;
    f.ao[i] = o + spread;
    f.ah[i] = h + spread;
    f.al[i] = l + spread;
    f.ac[i] = c + spread;
  });
  return f;
};

// followHand: hand-made 5-minute bars (bid OHLC; the ask 0.5 pip above), USD/JPY-like (1 pip 0.01), E 150.000,
// the fill 150.005 (BUY, the ask) or 149.995 (SELL, the bid); TP10 and the stop 13
export const followHand = (): { n: number; bad: string[] } => {
  const T0 = Date.UTC(2025, 0, 6, 1, 0);
  const sp = 0.005;
  const flat = (k: number): Array<[number, number, number, number, number]> => Array.from({ length: k }, () => [150.0, 150.02, 149.98, 150.0, 0]);
  const buy: Trade = { T: T0, C: T0, buy: true, E: 150.0, unit: 0.01, bidC: 149.995, askC: 150.005 };
  const sell: Trade = { ...buy, buy: false };
  const r = (x: number) => Math.round(x * 1e6) / 1e6;
  const cases: Array<[string, Fine, Trade, number, Kind, number]> = [];
  const mk = (head: Array<[number, number, number, number, number]>) => fineOf([...head, ...flat(TRACK + 5 - head.length)], sp, T0);
  // BUY: TP 150.100 on the bid, the stop 149.870
  cases.push(["BUY TP first", mk([[150.0, 150.05, 149.95, 150.02, 0], [150.02, 150.11, 149.99, 150.08, 0]]), buy, 10, "tp", 9.5]);
  cases.push(["BUY stop first", mk([[150.0, 150.05, 149.95, 150.02, 0], [150.02, 150.05, 149.86, 149.9, 0]]), buy, 10, "sl", -13.5]);
  cases.push(["BUY both in one bar", mk([[150.0, 150.12, 149.86, 150.0, 0]]), buy, 10, "amb", -13.5]);
  cases.push(["BUY opens past the stop", mk([[150.0, 150.05, 149.95, 150.02, 0], [149.8, 149.85, 149.75, 149.8, 0]]), buy, 10, "sl", -20.5]);
  cases.push(["BUY opens past TP", mk([[150.0, 150.05, 149.95, 150.02, 0], [150.2, 150.25, 150.15, 150.2, 0]]), buy, 10, "tp", 19.5]);
  // the ask reaches TP 150.100 (bid 150.096) but the bid does not: no TP for a BUY
  cases.push(["BUY: the ask alone at TP", mk([[150.0, 150.096, 149.95, 150.0, 0]]), buy, 10, "open", -0.5]);
  // SELL: TP 149.900 on the ask (the bid 0.5 pip under), the stop 150.130
  cases.push(["SELL TP first", mk([[150.0, 150.05, 149.95, 150.0, 0], [150.0, 150.02, 149.89, 149.9, 0]]), sell, 10, "tp", 9.5]);
  cases.push(["SELL stop first", mk([[150.0, 150.05, 149.95, 150.0, 0], [150.0, 150.13, 149.95, 150.1, 0]]), sell, 10, "sl", -13.5]);
  cases.push(["SELL opens past the stop", mk([[150.0, 150.05, 149.95, 150.0, 0], [150.3, 150.35, 150.25, 150.3, 0]]), sell, 10, "sl", -31]);
  cases.push(["SELL opens past TP", mk([[150.0, 150.05, 149.95, 150.0, 0], [149.7, 149.75, 149.65, 149.7, 0]]), sell, 10, "tp", 29]);
  cases.push(["BUY TP4", mk([[150.0, 150.045, 149.95, 150.02, 0]]), buy, 4, "tp", 3.5]);
  cases.push(["BUY TP16 open, out at the last close", mk([[150.0, 150.05, 149.95, 150.03, 0]]), buy, 16, "open", -0.5]);
  cases.push(["BUY TP16 after passing TP10", mk([[150.0, 150.05, 149.95, 150.02, 0], [150.02, 150.12, 150.0, 150.1, 0], [150.1, 150.17, 150.05, 150.15, 0]]), buy, 16, "tp", 15.5]);
  // undecided: out at the 1,440th bar's own close; exactly 1,440 bars are enough, and a 1,441st is not read
  const lastRow: [number, number, number, number, number] = [150.0, 150.04, 149.98, 150.03, 0];
  cases.push(["BUY undecided, exactly 1,440 bars: out at the 1,440th close", fineOf([...flat(TRACK - 1), lastRow], sp, T0), buy, 10, "open", 2.5]);
  cases.push(["BUY undecided: the 1,441st bar is not read", fineOf([...flat(TRACK - 1), lastRow, [150.0, 150.07, 149.98, 150.06, 0]], sp, T0), buy, 10, "open", 2.5]);
  // late: C = T + 15 minutes; the stop is touched before C, TP after it
  const late: Trade = { ...buy, C: T0 + 15 * MINUTE };
  cases.push(["late BUY followed from C", mk([[150.0, 150.05, 149.86, 149.9, 0], [149.9, 149.95, 149.88, 149.92, 0], [149.92, 149.98, 149.9, 149.95, 0], [149.95, 150.11, 149.9, 150.1, 0]]), late, 10, "tp", 9.5]);
  // a dollar pair's stop met exactly on the tick: E 1.16427, the stop E − 13 pips is the double 1.1629699999999998;
  // a bid low of 1.16297 does not reach it (the levels and the comparison as ultraLevels and tf-winrate's follow)
  const usd: Trade = { T: T0, C: T0, buy: true, E: 1.16427, unit: 0.0001, bidC: 1.16425, askC: 1.16429 };
  const usdRows = (low: number): Array<[number, number, number, number, number]> => [[1.1643, 1.1645, low, 1.1642, 0], ...Array.from({ length: TRACK + 4 }, (): [number, number, number, number, number] => [1.1643, 1.1645, 1.164, 1.1643, 0])];
  cases.push(["BUY 1.16427: a bid low of 1.16297 is not the stop", fineOf(usdRows(1.16297), 0.00004, T0), usd, 10, "open", (1.1643 - 1.16429) / 0.0001]);
  cases.push(["BUY 1.16427: a bid low of 1.16296 is", fineOf(usdRows(1.16296), 0.00004, T0), usd, 10, "sl", (1.16427 - 13 * 0.0001 - 1.16429) / 0.0001]);
  const bad: string[] = [];
  for (const [name, f, x, tpp, kind, pips] of cases) {
    const got = tradeOf(f, x, tpp);
    if (!got || got.kind !== kind || r(got.pips) !== r(pips)) bad.push(`${name}: ${got ? `${got.kind} ${r(got.pips)}` : "null"} (want ${kind} ${pips})`);
  }
  // the data ending before TRACK bars: not followed
  if (tradeOf(fineOf(flat(TRACK - 1), sp, T0), buy, 10) !== null) bad.push("1,439 bars: followed (want null)");
  return { n: cases.length + 1, bad };
};

// deltaHand: two strata of one pair, two weeks (docs 段1の作り 7). By hand: kept A 1,0 (week 0) 1 (week 1), left
// out A 1 (0) 0 (1); kept B 1 (1), left out B 0,1 (0) 0,0 (1). δ = (2/6)(2/3 − 1/2) + (4/6)(1 − 1/4) = 5/9. The
// influence values summed by week: −11/54 and +11/54, so the standard error √(2 × 2 × (11/54)²) = 11/27, t = 15/11;
// kept − all = (6/10) × 5/9 = 1/3; one block of four weeks (under 10: the week's). B30's sign: −5/9, the same error.
export const deltaHand = (): { n: number; bad: string[] } => {
  const A = stratumOf(0, true);
  const B = stratumOf(0, false);
  const it = (s: number, kept: boolean, y: number, week: number): Item => ({ s, kept, y, week });
  const items: Item[] = [
    it(A, true, 1, 0), it(A, true, 0, 0), it(A, true, 1, 1),
    it(A, false, 1, 0), it(A, false, 0, 1),
    it(B, true, 1, 1),
    it(B, false, 0, 0), it(B, false, 1, 0), it(B, false, 0, 1), it(B, false, 0, 1),
  ];
  const bad: string[] = [];
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-12;
  const d = deltaOf(items, 0);
  if (!near(d.d, 5 / 9)) bad.push(`δ ${d.d} (want 5/9)`);
  if (!near(d.se, 11 / 27)) bad.push(`standard error ${d.se} (want 11/27)`);
  if (!near(d.t, 15 / 11)) bad.push(`t ${d.t} (want 15/11)`);
  if (!near((d.nOut / d.nAll) * d.d, 1 / 3)) bad.push(`kept − all ${(d.nOut / d.nAll) * d.d} (want 1/3)`);
  if (d.by !== "week" || d.C !== 2 || d.C4 !== 1 || d.df !== 1) bad.push(`clusters ${d.by} C ${d.C} C4 ${d.C4} df ${d.df} (want week 2 1 1)`);
  const q1 = tQuantile(0.975, 1);
  if (!near(d.lo, 5 / 9 - q1 * (11 / 27)) || !near(d.hi, 5 / 9 + q1 * (11 / 27))) bad.push("the interval");
  const b30 = deltaOf(items, 0, -1);
  if (!near(b30.d, -5 / 9) || !near(b30.se, 11 / 27)) bad.push(`sign −1: δ ${b30.d}, error ${b30.se} (want −5/9, 11/27)`);
  // the clusters' choice
  // (the half-widths: t(0.975, 71) 1.9939, t(0.975, 17) 2.1098; 0.97 × 2.1098 = 2.0465 over 1.9939, 0.9 × 2.1098 = 1.8988 under)
  const picks: Array<[number, number, number, number, string]> = [[1, 30, 2, 9, "week"], [1, 30, 2, 10, "4w"], [2, 30, 1, 10, "week"], [1, 72, 0.97, 18, "4w"], [1, 72, 0.9, 18, "week"]];
  for (const [sw, cw, s4, c4, want] of picks) if (pickSe(sw, cw, s4, c4).by !== want) bad.push(`pickSe(${sw}, ${cw}, ${s4}, ${c4}) not ${want}`);
  // Student's t at the degrees of freedom the halves give (the printed tables, to 1e-6)
  for (const [df, want] of [[1, 12.7062047], [9, 2.2621572], [17, 2.1098156], [71, 1.9939434]]) {
    if (!(Math.abs(tQuantile(0.975, df) - want) < 1e-6)) bad.push(`t(0.975, ${df}) ${tQuantile(0.975, df)} (want ${want})`);
  }
  // mulberry32 against its first draws (the Python's are the same)
  const m = mulberry32(251101);
  const first = [m(), m(), m()].map((x) => x.toFixed(15)).join(" ");
  if (first !== "0.639131162315607 0.965791508089751 0.727509640622884") bad.push(`mulberry32(251101) ${first}`);
  return { n: 9, bad };
};
