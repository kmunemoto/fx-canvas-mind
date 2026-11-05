// #318 (docs §8.113 19, 20 (g)): the TS runner of the hand examples (research/chartbest/hand.json). Each case is
// run through the program's own functions — the items and the event framework, the time and the season, the
// chart's rounding and the points, the follow and the blind table, Δ and its SE, the shift, the selection, Holm,
// the groups and the floor, the suspicious lines and the sentences — and compared with the answer written by
// hand in the file. A planted error of hook "hand" (20 (f), CB_PLANT) must make at least one of its named cases
// fail. Never reads a price: every bar here is made up in the file.
// SQ-I2: every layout a case leaves to its runner (bar times, the signal bar's bid / ask, spreads, fillers, the
// follow length, the period, the made-up rows of the selection and the sentences, …) is read from the case or from
// hand.json's "conventions"; this runner carries no layout value of its own (a value given nowhere fails the case).

import type { QuoteCandle } from "../supabase/functions/track-outcomes/quotes.ts";
import { type PairBars, digitsOf, indexAt, midOf, pairBarsFromSides, pairBarsOf, pipOf, pointsOf } from "./chartbest-bars.ts";
import { type Dir, type Group, type Half, ITEM_TABLE, PAIRS, type Pair, type Period, STEP, TP_MAIL, TP_MAIN, dirName } from "./chartbest-const.ts";
import { type Holes, type ItemDef, type ItemOut, type Named, classify, eOf, eventsOf, holeOverlaps, holesOf } from "./chartbest-events.ts";
import { ITEM_DONCHIAN_A20, donchianTarget } from "./chartbest-donchian-lib.ts";
import { ITEM_BREEDON_1, ITEM_BREEDON_2 } from "./chartbest-breedon-lib.ts";
import { type BlindPair, type BlindTable, CODE_KIND, KIND_CODE, type Kind, NO_E, blindTableOf, newFollowCtx, tradeOf } from "./chartbest-follow.ts";
import { type Est, type Inf, type Obs, type SeCand, type SeKind, type WinPl, deltaOf, finish, pickSe, tq, winPlOf } from "./chartbest-stats.ts";
import { stratumOf } from "./chartbest-strata.ts";
import { SEASON_NAMES, block4, seasonOf, sent, wk } from "./chartbest-time.ts";
import { type Row, type SigTrade, blindObsOf, rowOf } from "./chartbest-rows.ts";
import { chooseStage1, groupCount, holmOf, itemCount, p95Of, stage2Of, suspectOfRow, suspiciousOf } from "./chartbest-select.ts";
import { floorOf, groupsOf } from "./chartbest-count.ts";
import { type HoldFacts, type HoldRowFacts, ROWS4, fmt, holdRangeText, holdText, holdVerdictOf, isoMin, stage2Text } from "./chartbest-text.ts";
import { type OhCall, cappedCallsOf, deadlineAtOf, holdSigsOf, pOfSig } from "./chartbest-hold.ts";
import type { LateSig } from "./chartbest-measures.ts";

export interface HandCase {
  id: string;
  kind: string;
  [k: string]: unknown;
}
// hand.json's "conventions": group name → its layout values (each group's "usedBy" names the kinds that read it)
export type HandConventions = Record<string, Record<string, unknown>>;
export interface HandDoc {
  version: number;
  conventions?: HandConventions;
  cases: HandCase[];
}
export interface HandResult {
  ok: boolean;
  detail?: string[];
}

// ---- the layout (SQ-I2) ---------------------------------------------------------------------------------------

type Rec = Record<string, unknown>;
// A layout value: the subcase's or the case's own field of that name, else the group's in hand.json's conventions.
// The runner has no fallback: a value given nowhere is the case's error (the case fails with it).
interface Layout {
  get: <T>(c: HandCase, group: string, key: string, sub?: Rec) => T;
}
const layoutOf = (cv: HandConventions): Layout => ({
  get: <T>(c: HandCase, group: string, key: string, sub?: Rec): T => {
    for (const src of [sub, c as Rec, cv[group]]) if (src && src[key] !== undefined) return src[key] as T;
    throw new Error(`no layout value ${group}.${key} (neither the case nor hand.json's conventions give it)`);
  },
});
// a value of a per-pair table of the conventions
const perPair = (m: Record<string, number>, pair: string, what: string): number => {
  const v = m[pair];
  if (v === undefined) throw new Error(`no ${what} for ${pair} in hand.json's conventions`);
  return v;
};
// a period of the conventions' "periods" group (dates as ISO strings, w0 the weeks of START and SPLIT)
const periodOfLayout = (c: HandCase, L: Layout, name: string): Period => {
  const all = L.get<Record<string, { S0: string; START: string; SPLIT: string; END: string; w0: Record<Half, number> }>>(c, "periods", "periods");
  const q = all[name];
  if (!q) throw new Error(`no period ${name} in hand.json's conventions`);
  return { name: name as Period["name"], s0: ms(q.S0), start: ms(q.START), split: ms(q.SPLIT), end: ms(q.END), w0: { H1: q.w0.H1, H2: q.w0.H2 } };
};

// ---- helpers ---------------------------------------------------------------------------------------------------

const ms = (iso: string): number => {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) throw new Error(`not a time: ${iso}`);
  return t;
};
const iso = (t: number): string => new Date(t).toISOString().replace(".000Z", "Z");
const near = (a: number | null | undefined, b: number, tol = 1e-9): boolean => a !== null && a !== undefined && Math.abs(a - b) <= tol;
const piOf = (pair: string): number => {
  const pi = PAIRS.indexOf(pair as Pair);
  if (pi < 0) throw new Error(`not one of the five pairs: ${pair}`);
  return pi;
};
const dirOf = (d: unknown): Dir => {
  if (d === "BUY") return 1;
  if (d === "SELL") return -1;
  throw new Error(`not a direction: ${String(d)}`);
};
type Ohlc = [number, number, number, number];

// a pair's bars from mid OHLC rows (bid = mid − h, ask = mid + h, the chart's mid re-derived; h: midBars.halfSpread)
const barsFromMids = (pair: Pair, times: number[], mids: Ohlc[], h: number): PairBars => {
  const n = times.length;
  const F = (f: (k: number) => number) => Float64Array.from({ length: n }, (_, k) => f(k));
  return pairBarsFromSides(pair, piOf(pair), {
    t: Float64Array.from(times),
    bo: F((k) => mids[k][0] - h), bh: F((k) => mids[k][1] - h), bl: F((k) => mids[k][2] - h), bc: F((k) => mids[k][3] - h),
    ao: F((k) => mids[k][0] + h), ah: F((k) => mids[k][1] + h), al: F((k) => mids[k][2] + h), ac: F((k) => mids[k][3] + h),
  });
};
// a pair's bars from bid OHLC rows and the ask's distance per bar
const barsFromBids = (pair: Pair, times: number[], bids: Ohlc[], spreads: number[]): PairBars => {
  const n = times.length;
  const F = (f: (k: number) => number) => Float64Array.from({ length: n }, (_, k) => f(k));
  return pairBarsFromSides(pair, piOf(pair), {
    t: Float64Array.from(times),
    bo: F((k) => bids[k][0]), bh: F((k) => bids[k][1]), bl: F((k) => bids[k][2]), bc: F((k) => bids[k][3]),
    ao: F((k) => bids[k][0] + spreads[k]), ah: F((k) => bids[k][1] + spreads[k]), al: F((k) => bids[k][2] + spreads[k]), ac: F((k) => bids[k][3] + spreads[k]),
  });
};
const flatBars = (pair: Pair, times: number[], mid: number, h: number): PairBars => barsFromMids(pair, times, times.map(() => [mid, mid, mid, mid] as Ohlc), h);
// the half spread of a pair's mid bars (conventions.midBars)
const halfSpreadOf = (c: HandCase, L: Layout, pair: string): number => perPair(L.get<Record<string, number>>(c, "midBars", "halfSpread"), pair, "midBars.halfSpread");
// a pair without any bar
const noBars = (pair: Pair): PairBars => barsFromMids(pair, [], [], 0);
// the five pairs' bars of a world that holds one pair only
const worldOf = (pb: PairBars): PairBars[] => PAIRS.map((pair, pi) => (pi === pb.pi ? pb : noBars(pair)));
const noHoles = (): Holes => ({ byPair: PAIRS.map(() => new Float64Array(0)), openSlots: 0 });
const ctxOf = (plant: string, params: Record<string, number> = {}) => ({ plant, params });
// 3: an item's group (the table's)
const groupOf = (id: string): Group => {
  const r = ITEM_TABLE.find((x) => x.id === id);
  if (!r) throw new Error(`${id}: not one of the 59 items`);
  return r.group;
};

// ---- the cases -------------------------------------------------------------------------------------------------

type Runner = (c: HandCase, plant: string, bad: string[], L: Layout) => void | Promise<void>;

// 19 C1: donchian with n shortened, the target against bigflow-lib's donchianState (20 (b)), the signals
const runC1: Runner = async (c, plant, bad, L) => {
  const pair = c.pair as Pair;
  const rows = c.bars as Ohlc[];
  const t0 = ms(c.start as string);
  const pb = barsFromMids(pair, rows.map((_, k) => t0 + k * STEP), rows, halfSpreadOf(c, L, pair));
  const n = c.n as number;
  const ex = c.expect as { signals: Array<[number, string]>; target: number[] };
  const target = Array.from(donchianTarget(pb, n, plant));
  if (target.join(",") !== ex.target.join(",")) bad.push(`target ${target.join(",")} (want ${ex.target.join(",")})`);
  const lib = await import("./" + "bigflow-lib.ts") as { donchianState: (c: Array<{ high: number; low: number; close: number }>, n: number) => Int8Array };
  const ds = Array.from(lib.donchianState(Array.from({ length: pb.n }, (_, k) => ({ high: pb.mh[k], low: pb.ml[k], close: pb.mc[k] })), n));
  if (ds.join(",") !== ex.target.join(",")) bad.push(`donchianState ${ds.join(",")} (want ${ex.target.join(",")})`);
  const ev = eventsOf(ITEM_DONCHIAN_A20, pb, ctxOf(plant, { n }));
  const got = ev.cands.map((x) => `${x.i}:${dirName(x.dir)}`).join(",");
  const want = ex.signals.map(([i, d]) => `${i}:${d}`).join(",");
  if (got !== want) bad.push(`signals ${got || "none"} (want ${want || "none"})`);
};

// 19 K1 / 18 K1: breedon-1 and breedon-2 on the case's pair's bars at the listed opens (flat: conventions.k1)
const runK1: Runner = (c, plant, bad, L) => {
  const pair = c.pair as Pair;
  const times = (c.bars as string[]).map(ms);
  const pb = flatBars(pair, times, L.get<number>(c, "k1", "flatMid"), halfSpreadOf(c, L, pair));
  const ex = c.expect as Record<string, Array<[string, string, string[]]>>;
  for (const def of [ITEM_BREEDON_1, ITEM_BREEDON_2]) {
    const ev = eventsOf(def, pb, ctxOf(plant));
    const got = ev.cands.map((x) => `${iso(x.T)} ${dirName(x.dir)} [${x.marks.join(";")}]`).join(", ");
    const want = (ex[def.id] ?? []).map(([T, d, m]) => `${T} ${d} [${m.join(";")}]`).join(", ");
    if (got !== want) bad.push(`${def.id}: ${got || "none"} (want ${want || "none"})`);
  }
};

// 20 (g) 時刻: the switch dates; breedon's T and the season group at T, and the shifted-week mark
const runDst: Runner = (c, plant, bad, L) => {
  const pair = L.get<Pair>(c, "dst", "pair");
  const days = c.days as Array<[string, string, string, string]>;
  const times = [ms(c.context as string)];
  for (const [d] of days) for (const hm of L.get<string[]>(c, "dst", "barTimes")) times.push(ms(`${d}T${hm}:00Z`));
  const pb = flatBars(pair, times, L.get<number>(c, "dst", "flatMid"), halfSpreadOf(c, L, pair));
  const s1 = eventsOf(ITEM_BREEDON_1, pb, ctxOf(plant)).cands;
  const s2 = eventsOf(ITEM_BREEDON_2, pb, ctxOf(plant)).cands;
  if (s1.length !== days.length || s2.length !== days.length) bad.push(`signals ${s1.length}/${s2.length} (want ${days.length} each)`);
  days.forEach(([d, T1, T2, season], j) => {
    const a = s1[j];
    const b = s2[j];
    if (!a || iso(a.T) !== T1 || a.dir !== -1) bad.push(`${d} breedon-1 ${a ? iso(a.T) : "none"} (want ${T1} SELL)`);
    if (!b || iso(b.T) !== T2 || b.dir !== 1) bad.push(`${d} breedon-2 ${b ? iso(b.T) : "none"} (want ${T2} BUY)`);
    for (const [x, T] of [[a, T1], [b, T2]] as const) {
      const got = SEASON_NAMES[seasonOf(ms(T), plant)];
      if (got !== season) bad.push(`${d} season at ${T}: ${got} (want ${season})`);
      if (x && x.marks.includes("shiftedWeek") !== (season === "SW")) bad.push(`${d} mark at ${T}: ${x.marks.join(";") || "none"}`);
    }
  });
};

// 2: the chart's mid of one bar through the chart's own read (historyRead), and midOf
const runRound: Runner = (c, _plant, bad, L) => {
  const pair = c.pair as Pair;
  const d = digitsOf(pair);
  const t = ms(L.get<string>(c, "round", "at"));
  const readAt = ms(L.get<string>(c, "round", "readAt"));
  const side = (v: number) => ({ datetime: new Date(t).toISOString(), open: v, high: v, low: v, close: v });
  const q: QuoteCandle[] = [{ datetime: new Date(t).toISOString(), bid: side(c.bid as number), ask: side(c.ask as number) }];
  const pb = pairBarsOf(pair, piOf(pair), q, readAt);
  const got = pb.mc[0].toFixed(d);
  const got2 = midOf(c.bid as number, c.ask as number, d).toFixed(d);
  if (got !== c.expect) bad.push(`chart mid ${got} (want ${c.expect})`);
  if (got2 !== c.expect) bad.push(`midOf ${got2} (want ${c.expect})`);
};
const runPoints: Runner = (c, _plant, bad) => {
  for (const [pair, v, want] of c.items as Array<[string, number, number]>) {
    const got = pointsOf(v, pair);
    if (got !== want) bad.push(`${pair} ${v}: ${got} (want ${want})`);
  }
};

// 7: one trade through tradeOf (the follow the blind table uses), from the bar after the signal bar; the layout
// (conventions.follow, or the case's / subcase's own fields)
interface FollowExpect {
  kind: Kind | null;
  pips?: number;
  bars?: number;
}
const tpOf = (tp: unknown): 4 | 10 => {
  if (tp === 4) return TP_MAIL;
  if (tp === 10) return TP_MAIN;
  throw new Error(`tp ${String(tp)}: 4 or 10`);
};
const followOne = (c: HandCase, sub: Rec | undefined, plant: string, L: Layout): string | null => {
  const spec = sub ?? (c as Rec);
  const pair = c.pair as Pair;
  const get = <T>(key: string): T => L.get<T>(c, "follow", key, sub);
  const t0 = ms(get<string>("signalAt"));
  const tf = ms(get<string>("followAt"));
  if (!(tf > t0)) throw new Error("followAt must be after signalAt");
  const sb = get<number>("signalBid");
  const sa = get<number>("signalAsk");
  const spread = get<number>("spread");
  const filler = get<Ohlc>("filler");
  const count = get<number>("count");
  const tail = get<Ohlc[]>("tail");
  const after = get<Ohlc[]>("after");
  const rows: Ohlc[] = [...(spec.rows as Ohlc[])];
  while (rows.length < count - tail.length) rows.push(filler);
  rows.push(...tail, ...after);
  const times = [t0, ...rows.map((_, k) => tf + k * STEP)];
  const bids: Ohlc[] = [[sb, sb, sb, sb], ...rows];
  const spreads = [sa - sb, ...rows.map(() => spread)];
  const pb = barsFromBids(pair, times, bids, spreads);
  const dir = dirOf(c.dir);
  const tr = tradeOf(pb, 0, dir, tpOf(c.tp), 1, newFollowCtx(plant, Infinity), eOf(pb, 0, plant));
  const want = spec.expect as FollowExpect;
  if (want.kind === null) return tr === null ? null : `followed (${tr.kind}), want not followed`;
  if (!tr) return `not followed (want ${want.kind})`;
  const out: string[] = [];
  if (tr.kind !== want.kind) out.push(`kind ${tr.kind} (want ${want.kind})`);
  if (want.pips !== undefined && !near(tr.pips, want.pips, 1e-6)) out.push(`pips ${tr.pips} (want ${want.pips})`);
  if (want.bars !== undefined && tr.bars !== want.bars) out.push(`bars ${tr.bars} (want ${want.bars})`);
  return out.length ? out.join("; ") : null;
};
const runFollow: Runner = (c, plant, bad, L) => {
  const subs: Array<Rec | undefined> = (c.subcases as Rec[] | undefined) ?? [undefined];
  subs.forEach((s, j) => {
    const e = followOne(c, s, plant, L);
    if (e) bad.push(subs.length > 1 ? `#${j + 1}: ${e}` : e);
  });
};

// 8: e of a blind-table row (the mirror), through blindTableOf on a one-row world (conventions.mirror)
const runMirror: Runner = (c, plant, bad, L) => {
  const get = <T>(key: string): T => L.get<T>(c, "mirror", key);
  const pair = get<Pair>("pair");
  const t0 = ms(get<string>("signalAt"));
  const tf = ms(get<string>("followAt"));
  if (!(tf > t0)) throw new Error("followAt must be after signalAt");
  const sb = get<number>("signalBid");
  const sa = get<number>("signalAsk");
  const spread = get<number>("spread");
  const filler = get<Ohlc>("filler");
  const count = get<number>("count");
  const p = periodOfLayout(c, L, get<string>("period"));
  const half = get<Half>("half");
  (c.worlds as Array<{ rows: Ohlc[]; e: number }>).forEach((w, j) => {
    const rows: Ohlc[] = [...w.rows];
    while (rows.length < count) rows.push(filler);
    const times = [t0, ...rows.map((_, k) => tf + k * STEP)];
    const pb = barsFromBids(pair, times, [[sb, sb, sb, sb], ...rows], [sa - sb, ...rows.map(() => spread)]);
    // 12: a half's table reads its own half only (the first half to SPLIT)
    const bt = blindTableOf([pb], noHoles(), half, p, plant, half === "H1" ? p.split : p.end);
    const bp = bt.pairs[0];
    if (bp.n !== 1) {
      bad.push(`world ${j + 1}: ${bp.n} blind rows (want 1)`);
      return;
    }
    const e = bp.eBuy[0] === NO_E ? null : bp.eBuy[0];
    if (e !== w.e) bad.push(`world ${j + 1}: e ${e} (want ${w.e}; BUY ${CODE_KIND[bp.kind.b10[0]]}, SELL ${CODE_KIND[bp.kind.s10[0]]})`);
  });
};

const runSent: Runner = (c, plant, bad) => {
  for (const [T, want] of c.items as Array<[string, boolean]>) if (sent(ms(T), plant) !== want) bad.push(`${T}: ${!want} (want ${want})`);
};

// 5: the event framework on a made-up item (always / condition / named) over flat bars (conventions.events)
interface EventSeq {
  type: "always" | "condition" | "named";
  target?: Array<number | null>;
  buy?: number[];
  sell?: number[];
  namedBuy?: string[][];
  expect: { signals: Array<[number, string]>; firstSkipped: number; nullPrevSkipped: number; bothSuppressed: number };
}
const fakeItem = (s: EventSeq): ItemDef => ({
  id: "hand-item", order: 0, group: "chart", candidate: "hand", pairs: PAIRS, kind: s.type,
  window: { kind: "s0" }, warmup: 0, mark600: false, bothDirs: true, symmetric: true, symmetricWhy: "",
  compute: (v): ItemOut => {
    const n = v.n;
    if (s.type === "always") {
      const tg = s.target!;
      return {
        buy: Int8Array.from(tg, (x) => (x === null ? -1 : x === 1 ? 1 : 0)),
        sell: Int8Array.from(tg, (x) => (x === null ? -1 : x === -1 ? 1 : 0)),
      };
    }
    if (s.type === "named") {
      const named: Named = s.namedBuy!.map((names) => new Map(names.map((x) => [x, 1])));
      return { buy: new Int8Array(n), sell: new Int8Array(n), namedBuy: named, namedSell: Array.from({ length: n }, () => new Map()) };
    }
    return { buy: Int8Array.from(s.buy!), sell: Int8Array.from(s.sell!) };
  },
});
const runEvents: Runner = (c, plant, bad, L) => {
  const pair = L.get<Pair>(c, "events", "pair");
  const t0 = ms(L.get<string>(c, "events", "start"));
  const mid = L.get<number>(c, "events", "flatMid");
  const h = halfSpreadOf(c, L, pair);
  (c.seqs as EventSeq[]).forEach((s, j) => {
    const n = s.target?.length ?? s.buy?.length ?? s.namedBuy!.length;
    const pb = flatBars(pair, Array.from({ length: n }, (_, k) => t0 + k * STEP), mid, h);
    const ev = eventsOf(fakeItem(s), pb, ctxOf(plant));
    const got = ev.cands.map((x) => `${x.i}:${dirName(x.dir)}`).join(",");
    const want = s.expect.signals.map(([i, d]) => `${i}:${d}`).join(",");
    const tag = (c.seqs as EventSeq[]).length > 1 ? `#${j + 1} ` : "";
    if (got !== want) bad.push(`${tag}signals ${got || "none"} (want ${want || "none"})`);
    if (ev.firstSkipped !== s.expect.firstSkipped) bad.push(`${tag}firstSkipped ${ev.firstSkipped} (want ${s.expect.firstSkipped})`);
    if (ev.nullPrevSkipped !== s.expect.nullPrevSkipped) bad.push(`${tag}nullPrevSkipped ${ev.nullPrevSkipped} (want ${s.expect.nullPrevSkipped})`);
    if (ev.bothSuppressed !== s.expect.bothSuppressed) bad.push(`${tag}bothSuppressed ${ev.bothSuppressed} (want ${s.expect.bothSuppressed})`);
  });
};

// 6 ③: the holes of five pairs' bars, and the overlap of a signal's window (conventions.hole)
const runHole: Runner = (c, _plant, bad, L) => {
  const a = ms(c.start as string);
  const b = ms(c.end as string);
  const missing = c.missing as Record<string, string[]>;
  const flat = L.get<Record<string, number>>(c, "hole", "flatMid");
  const bars = PAIRS.map((pair) => {
    const miss = new Set((missing[pair] ?? []).map(ms));
    const times: number[] = [];
    for (let t = a; t < b; t += STEP) if (!miss.has(t)) times.push(t);
    return flatBars(pair, times, perPair(flat, pair, "hole.flatMid"), halfSpreadOf(c, L, pair));
  });
  const p: Period = { ...periodOfLayout(c, L, L.get<string>(c, "hole", "period")), s0: a, end: b };
  // 5「温め…」 / 6 ①: the warm-up the case's signals have (conventions.hole.warmup; the run's recordsOf: i ≥ warmup)
  const warmup = L.get<number>(c, "hole", "warmup");
  const holes = holesOf(bars, p);
  const ex = c.expect as { holes: Record<string, Array<[string, string]>>; overlap: Array<[string, boolean]> };
  PAIRS.forEach((pair, pi) => {
    const h = holes.byPair[pi];
    const got: string[] = [];
    for (let k = 0; k < h.length; k += 2) got.push(`${iso(h[k])}-${iso(h[k + 1])}`);
    const want = (ex.holes[pair] ?? []).map(([x, y]) => `${x}-${y}`);
    if (got.join(",") !== want.join(",")) bad.push(`${pair} holes ${got.join(",") || "none"} (want ${want.join(",") || "none"})`);
  });
  const uj = bars[0];
  for (const [open, want] of ex.overlap) {
    const i = indexAt(uj.t, ms(open));
    if (i < 0) {
      bad.push(`no USD/JPY bar at ${open}`);
      continue;
    }
    const got = holeOverlaps(holes, 0, uj.t[Math.max(0, i - 9)], uj.t[i] + STEP);
    if (got !== want) bad.push(`overlap at ${open}: ${got} (want ${want})`);
    const cl = classify(uj, 0, i, i >= warmup, holes, p);
    if ((cl.reason === "r3") !== want) bad.push(`reason at ${open}: ${cl.reason}`);
  }
};

// 1, 6 ④: the halves around SPLIT and the follow window crossing it (classify; conventions.half)
const runHalf: Runner = (c, plant, bad, L) => {
  const pair = L.get<Pair>(c, "half", "pair");
  const p = periodOfLayout(c, L, L.get<string>(c, "half", "period"));
  const times: number[] = [];
  for (let t = ms(c.from as string); t <= ms(c.to as string); t += STEP) times.push(t);
  const pb = flatBars(pair, times, L.get<number>(c, "half", "flatMid"), halfSpreadOf(c, L, pair));
  // the warm-up of the case's signals (conventions.half.warmup; the run's recordsOf: i ≥ warmup)
  const warmup = L.get<number>(c, "half", "warmup");
  for (const [open, reason, half] of c.expect as Array<[string, string, string | null]>) {
    const i = indexAt(pb.t, ms(open));
    const cl = classify(pb, piOf(pair), i, i >= warmup, noHoles(), p, plant);
    if (cl.reason !== reason || cl.half !== half) bad.push(`${open}: ${cl.reason} ${cl.half ?? "-"} (want ${reason} ${half ?? "-"})`);
  }
};

// 8: Δ and its SE from observations given by hand (stratum, week, block, v)
const estCheck = (e: Est, ex: Record<string, unknown>, bad: string[], tag = "") => {
  if (!near(e.est, ex.est as number, 1e-12)) bad.push(`${tag}Δ ${e.est} (want ${ex.est})`);
  for (const k of ["N", "strata", "dropped"] as const) if (ex[k] !== undefined && e[k] !== ex[k]) bad.push(`${tag}${k} ${e[k]} (want ${ex[k]})`);
  if (ex.use !== undefined && e.use !== ex.use) bad.push(`${tag}use ${e.use} (want ${ex.use})`);
  if (ex.kinds !== undefined && e.cands.map((x) => x.kind).join(",") !== (ex.kinds as string[]).join(",")) bad.push(`${tag}candidates ${e.cands.map((x) => x.kind).join(",")} (want ${(ex.kinds as string[]).join(",")})`);
  const used = e.cands.find((x) => x.kind === e.use);
  if (ex.se !== undefined && !near(used?.se, ex.se as number, 1e-12)) bad.push(`${tag}SE ${used?.se} (want ${ex.se})`);
  if (ex.C !== undefined && used?.C !== ex.C) bad.push(`${tag}C ${used?.C} (want ${ex.C})`);
  if (ex.df !== undefined && used?.df !== ex.df) bad.push(`${tag}df ${used?.df} (want ${ex.df})`);
};
const obsOf = (xs: Array<[number, number, number, number]>): Obs[] => xs.map(([s, week, block, v]) => ({ s, week, block, v }));
const blindOfObs = (bl: Obs[]) => (s: number) => bl.filter((x) => x.s === s);
const runDelta: Runner = (c, plant, bad) => {
  const e = deltaOf(obsOf(c.sig as Array<[number, number, number, number]>), blindOfObs(obsOf(c.blind as Array<[number, number, number, number]>)), { plant });
  estCheck(e, c.expect as Record<string, unknown>, bad);
};
// the same with the strata of real times (the chart layer: pair × direction × hour × season); blocks of
// conventions.deltaT's period and half
const runDeltaT: Runner = (c, plant, bad, L) => {
  const pi = piOf(c.pair as string);
  const dir = dirOf(c.dir);
  const layer = c.layer as Group;
  const p = periodOfLayout(c, L, L.get<string>(c, "deltaT", "period"));
  const half = L.get<Half>(c, "deltaT", "half");
  const mk = (xs: Array<[string, number]>): Obs[] => xs.map(([T, v]) => ({ s: stratumOf(layer, pi, dir, ms(T), plant), week: wk(ms(T)), block: block4(ms(T), half, p), v }));
  const sig = mk(c.sig as Array<[string, number]>);
  const bl = mk(c.blind as Array<[string, number]>);
  const e = deltaOf(sig, blindOfObs(bl), { plant });
  const ex = c.expect as Record<string, unknown>;
  estCheck(e, ex, bad);
  if (ex.blindPerStratum) {
    const used = [...new Set(sig.map((x) => x.s))].filter((s) => bl.some((b) => b.s === s)).sort((a, b) => a - b);
    const got = used.map((s) => bl.filter((b) => b.s === s).length);
    if (got.join(",") !== (ex.blindPerStratum as number[]).join(",")) bad.push(`blind rows per stratum ${got.join(",")} (want ${(ex.blindPerStratum as number[]).join(",")})`);
  }
  if (ex.seasons) {
    const got = (c.sig as Array<[string, number]>).map(([T]) => SEASON_NAMES[seasonOf(ms(T), plant)]);
    if (got.join(",") !== (ex.seasons as string[]).join(",")) bad.push(`seasons ${got.join(",")} (want ${(ex.seasons as string[]).join(",")})`);
  }
};
// one stratum; the values cycle through conventions.clusters' lists
const runClusters: Runner = (c, plant, bad, L) => {
  const s = L.get<number>(c, "clusters", "stratum");
  const sv = L.get<number[]>(c, "clusters", "sigVCycle");
  const bv = L.get<number[]>(c, "clusters", "blindVCycle");
  (c.sets as Array<{ weeks: number[]; blocks: number[]; kinds: string[]; C: number[] }>).forEach((st, j) => {
    const sig: Obs[] = st.weeks.map((w, k) => ({ s, week: w, block: st.blocks[k], v: sv[k % sv.length] }));
    const bl: Obs[] = st.weeks.map((w, k) => ({ s, week: w, block: st.blocks[k], v: bv[k % bv.length] }));
    const e = deltaOf(sig, blindOfObs(bl), { plant });
    const kinds = e.cands.map((x) => x.kind).join(",");
    const C = e.cands.map((x) => x.C).join(",");
    if (kinds !== st.kinds.join(",") || C !== st.C.join(",")) bad.push(`#${j + 1}: ${kinds} C ${C} (want ${st.kinds.join(",")} C ${st.C.join(",")})`);
  });
};

// a blind table of one pair written by hand (conventions.table): rows (bar open, e of BUY, the BUY TP4 leg's kind
// and pips when the case gives them; every other leg is conventions.table.legs)
interface TableLayout {
  pair: Pair;
  mid: number;
  h: number;
  legs: { kind: Kind; pips: number; bars: number };
  p: Period;
  half: Half;
  layer: Group;
}
const tableOf = (c: HandCase, L: Layout): TableLayout => {
  const get = <T>(key: string): T => L.get<T>(c, "table", key);
  const pair = get<Pair>("pair");
  return { pair, mid: get<number>("mid"), h: halfSpreadOf(c, L, pair), legs: get<TableLayout["legs"]>("legs"), p: periodOfLayout(c, L, get<string>("period")), half: get<Half>("half"), layer: get<Group>("layer") };
};
const manualTable = (rows: Array<{ open: number; eBuy: number; k4?: Kind; p4?: number }>, tl: TableLayout): { bt: BlindTable; pb: PairBars } => {
  const sorted = [...rows].sort((a, b) => a.open - b.open);
  const pb = flatBars(tl.pair, sorted.map((r) => r.open), tl.mid, tl.h);
  const n = sorted.length;
  const legKind = () => new Uint8Array(n).fill(KIND_CODE[tl.legs.kind]);
  const legPips = () => new Float64Array(n).fill(tl.legs.pips);
  const legBars = () => new Uint16Array(n).fill(tl.legs.bars);
  const idx = () => Int32Array.from(sorted.map((_, k) => k));
  const bp: BlindPair = {
    pi: pb.pi, n, k: idx(), T: Float64Array.from(sorted.map((r) => r.open + STEP)), E: Float64Array.from(sorted.map(() => tl.mid)),
    hour: Uint8Array.from(sorted.map((r) => new Date(r.open + STEP).getUTCHours())), season: Uint8Array.from(sorted.map((r) => seasonOf(r.open + STEP))),
    week: Int32Array.from(sorted.map((r) => wk(r.open + STEP))), block: Int32Array.from(sorted.map((r) => block4(r.open + STEP, tl.half, tl.p))),
    kind: { b4: Uint8Array.from(sorted.map((r) => KIND_CODE[r.k4 ?? tl.legs.kind])), s4: legKind(), b10: legKind(), s10: legKind() },
    pips: { b4: Float64Array.from(sorted.map((r) => r.p4 ?? tl.legs.pips)), s4: legPips(), b10: legPips(), s10: legPips() },
    bars: { b4: legBars(), s4: legBars(), b10: legBars(), s10: legBars() },
    at: { b4: idx(), s4: idx(), b10: idx(), s10: idx() },
    eBuy: Int8Array.from(sorted.map((r) => r.eBuy)), rowOfK: idx(),
  };
  const weeks = [...new Set(Array.from(bp.week))].sort((a, b) => a - b);
  return { bt: { half: tl.half, pairs: [bp], weeks, maxReadClose: -Infinity, pastReadEnd: 0 }, pb };
};
// a signal's trade at a row of a manual table
const sigTradeAt = (bt: BlindTable, pb: PairBars, T: number, dir: Dir): SigTrade => {
  const bp = bt.pairs[0];
  const k = indexAt(pb.t, T - STEP);
  if (k < 0) throw new Error(`hand: no row at ${iso(T)}`);
  const r = bp.rowOfK[k];
  const e = bp.eBuy[r] === NO_E ? null : dir === 1 ? bp.eBuy[r] : -bp.eBuy[r];
  const key4 = dir === 1 ? "b4" : "s4";
  const key10 = dir === 1 ? "b10" : "s10";
  return {
    src: "hand", pi: bp.pi, i: k, T, dir, half: bt.half, r, e,
    k4: CODE_KIND[bp.kind[key4][r]], k10: CODE_KIND[bp.kind[key10][r]], p4: bp.pips[key4][r], p10: bp.pips[key10][r],
    mp4: 0, mp10: 0, at10: bp.at[key10][r], lateT: null, eLate: null, nextOk: false,
  };
};

// 8, 10: the week shift on a manual blind table, through the run's own row (rowOf with the chart group's shift): the
// real Δ it computes from the case's signals is checked against expect.real (an answer, 20 (g) 週ずらし) and is the one
// it ranks among the shifts (rowOf hands it to shiftOf)
const runShift: Runner = (c, plant, bad, L) => {
  const tl = tableOf(c, L);
  const rows = (c.rows as Array<[string, number]>).map(([open, e]) => ({ open: ms(open), eBuy: e }));
  const { bt, pb } = manualTable(rows, tl);
  const tr = (c.signals as Array<[string, string]>).map(([T, d]) => sigTradeAt(bt, pb, ms(T), dirOf(d)));
  const blind = blindObsOf(bt, tl.layer, tl.p, plant);
  const ex = c.expect as { k: number[]; delta: number[]; dropped: number[]; sd: number; mean: number; rank: number; real: number };
  if (tl.layer !== "chart") throw new Error(`the week shift is the chart group's (conventions.table.layer ${tl.layer})`);
  const row = rowOf("hand", tr, tl.layer, tl.half, bt, worldOf(pb), blind, tl.p, { plant, shift: true });
  if (!near(row.delta.est, ex.real, 1e-12)) bad.push(`real Δ ${row.delta.est} (want ${ex.real})`);
  if (!row.shift) throw new Error("rowOf made no shift for the chart layer");
  const sh = row.shift.delta;
  if (sh.k.join(",") !== ex.k.join(",")) bad.push(`k ${sh.k.join(",")} (want ${ex.k.join(",")})`);
  if (sh.delta.length !== ex.delta.length || sh.delta.some((d, j) => !near(d, ex.delta[j], 1e-12))) bad.push(`Δ_k ${sh.delta.join(",")} (want ${ex.delta.join(",")})`);
  if (sh.dropped.join(",") !== ex.dropped.join(",")) bad.push(`dropped ${sh.dropped.join(",")} (want ${ex.dropped.join(",")})`);
  if (!near(sh.sd, ex.sd, 1e-12)) bad.push(`SD ${sh.sd} (want ${ex.sd})`);
  if (!near(sh.mean, ex.mean, 1e-12)) bad.push(`mean ${sh.mean} (want ${ex.mean})`);
  if (sh.rank !== ex.rank) bad.push(`rank ${sh.rank} (want ${ex.rank})`);
};

// 8: the SE chosen among candidates given by their half-widths (conventions.sepick)
const runSePick: Runner = (c, _plant, bad, L) => {
  const C = L.get<number>(c, "sepick", "C");
  const df = L.get<number>(c, "sepick", "df");
  const sePerHalf = L.get<number>(c, "sepick", "sePerHalf");
  for (const [cands, want] of c.items as Array<[Array<[string, number]>, string]>) {
    const cs: SeCand[] = cands.map(([kind, half]) => ({ kind: kind as SeKind, se: half * sePerHalf, C, df, half }));
    const got = pickSe(cs)?.kind;
    if (got !== want) bad.push(`${cands.map(([k, h]) => `${k} ${h}`).join(" / ")}: ${got} (want ${want})`);
  }
};
const runTq: Runner = (c, _plant, bad) => {
  for (const [df, want] of c.items as Array<[number, number]>) {
    const got = tq(0.975, df);
    if (!near(got, want, c.tol as number)) bad.push(`df ${df}: ${got} (want ${want})`);
  }
};
const runLbCount: Runner = (c, _plant, bad) => {
  const ids = c.ids as string[];
  const ex = c.expect as { items: number; groups: number };
  const ni = itemCount(ids);
  const ng = groupCount(ids, c.groups as Record<string, string>);
  if (ni !== ex.items || ng !== ex.groups) bad.push(`items ${ni}, groups ${ng} (want ${ex.items}, ${ex.groups})`);
  for (const [xs, want] of c.p95 as Array<[number[], number]>) if (p95Of(xs) !== want) bad.push(`95% point of ${xs.length} values: ${p95Of(xs)} (want ${want})`);
};

// rows made up for the selection, Holm and the sentences (conventions.rows): Δ with its week candidate from
// influence sums on C = df + 1 clusters laid out by a pattern (two patterns are uncorrelated), a, Δ_late, W/PL
interface RowsLayout {
  N: number;
  counted: number;
  nE: number;
  unresolved: number;
  lateExcluded: number;
  resolved: number;
  blindW1: number;
  blindPl1: number;
  byPair: Row["byPair"];
  patterns: Record<string, number[]>;
  itemPattern: string;
  email: { a: [number, number]; w4: [number, number]; w10: [number, number] };
}
const rowsOf = (c: HandCase, L: Layout): RowsLayout => {
  const get = <T>(key: string): T => L.get<T>(c, "rows", key);
  return {
    N: get("N"), counted: get("counted"), nE: get("nE"), unresolved: get("unresolved"), lateExcluded: get("lateExcluded"), resolved: get("resolved"),
    blindW1: get("blindW1"), blindPl1: get("blindPl1"), byPair: get("byPair"), patterns: get("patterns"), itemPattern: get("itemPattern"), email: get("email"),
  };
};
const estOf = (est: number, se: number | null, df: number, pattern: string, R: RowsLayout): Est => {
  const inf: Inf = { week: new Map(), block: new Map() };
  if (se !== null) {
    const C = df + 1;
    const a = (se * Math.sqrt(C - 1)) / C;
    const f = R.patterns[pattern];
    if (!f) throw new Error(`no pattern ${pattern} in hand.json's conventions.rows`);
    for (let g = 0; g < C; g++) inf.week.set(g, a * f[g % f.length]);
  }
  return finish({ est, N: R.N, strata: 1, dropped: 0, cands: [], use: null, t: null, lo: null, hi: null, lb: null, inf });
};
// every trade resolved: n = resolved, tp = round(W × resolved), the W of all = the W of the resolved
const winOf = (wRes: number, pl: number, R: RowsLayout): WinPl => {
  const tp = Math.round(wRes * R.resolved);
  return { n: R.resolved, resolved: R.resolved, tp, sl: R.resolved - tp, amb: 0, open: 0, wAll: wRes, wRes, pl, wLo: null, wHi: null, plLo: null, plHi: null };
};
interface RowSpec {
  id: string;
  delta: [number, number | null];
  late: [number, number, number];
  a: [number, number];
  w4: [number, number];
  w10: [number, number];
  byDir?: Record<"BUY" | "SELL", [number, number]>;
  pattern?: string;
}
const lateOf = (x: [number, number, number], R: RowsLayout): Est => ({ ...estOf(x[0], null, 1, R.itemPattern, R), lo: x[1], hi: x[2] });
const rowFrom = (s: RowSpec, df: number, layer: Group, R: RowsLayout): Row => {
  const r: Row = {
    src: s.id, half: "H2", layer, counted: R.counted, nE: R.nE, unresolved: R.unresolved,
    delta: estOf(s.delta[0], s.delta[1], df, s.pattern ?? R.itemPattern, R), a: estOf(s.a[0], s.a[1], df, R.itemPattern, R), late: lateOf(s.late, R), lateExcluded: R.lateExcluded,
    w4: winOf(s.w4[0], s.w4[1], R), w10: winOf(s.w10[0], s.w10[1], R), blindW1: R.blindW1, blindPl1: R.blindPl1,
    byDir: {
      BUY: { est: s.byDir?.BUY[0] ?? null, N: s.byDir?.BUY[1] ?? 0, strata: 1, dropped: 0 },
      SELL: { est: s.byDir?.SELL[0] ?? null, N: s.byDir?.SELL[1] ?? 0, strata: 1, dropped: 0 },
    },
    byPair: { ...R.byPair }, nonOverlap: null, perWeek: null, shift: null, suspicious: [],
  };
  r.suspicious = suspectOfRow(r);
  return r;
};
// an email's rows (ULTRA 5分足 / MACD): Δ (est, se, pattern) as the case's group says, Δ_late one point, a and W/PL
// of conventions.rows.email; the chart and calendar layers are the same row
const emailRow = (id: string, est: number, se: number | null, df: number, pattern: string, R: RowsLayout): Record<Group, Row> => {
  const r = rowFrom({ id, delta: [est, se], late: [est, est, est], a: R.email.a, w4: R.email.w4, w10: R.email.w10, pattern }, df, "chart", R);
  return { chart: r, cal: { ...r, layer: "cal" } };
};

// 12: the choice of stage 1 (conventions.select: the t of a row with a low end, the rest of the row, the run's state)
const runSelect: Runner = (c, plant, bad, L) => {
  const R = rowsOf(c, L);
  const get = <T>(key: string): T => L.get<T>(c, "select", key);
  const tWhenLb = get<number>("tWhenLb");
  const fill = get<{ deltaSe: number; df: number; lateLoHi: [number, number]; a: [number, number]; w4: [number, number]; w10: [number, number] }>("fill");
  (c.sets as Array<{ rows: Array<[string, number, number | null, number, string[]]>; groups: Record<string, string>; expect: { chart: string[]; cal: string[]; notEligible: Record<string, string> } }>).forEach((st, j) => {
    const rows = st.rows.map(([id, est, lb, nE, sus]) => {
      const r = rowFrom({ id, delta: [est, fill.deltaSe], late: [est, fill.lateLoHi[0], fill.lateLoHi[1]], a: fill.a, w4: fill.w4, w10: fill.w10 }, fill.df, groupOf(id), R);
      r.delta = { ...r.delta, est, lb, t: lb === null ? null : tWhenLb, lo: lb };
      r.nE = nE;
      r.suspicious = sus;
      return r;
    });
    const s1 = chooseStage1({ rows, groups: st.groups, checksOk: get<boolean>("checksPass"), plant, countsOnly: get<boolean>("countsOnlySuspicion"), yardstickHits: get<string[]>("yardstickHits") });
    const got = `${s1.chosen.chart.join(",")} | ${s1.chosen.cal.join(",")}`;
    const want = `${st.expect.chart.join(",")} | ${st.expect.cal.join(",")}`;
    if (got !== want) bad.push(`#${j + 1}: ${got} (want ${want})`);
    const ne = JSON.stringify(Object.fromEntries(Object.entries(s1.notEligible).sort()));
    const wne = JSON.stringify(Object.fromEntries(Object.entries(st.expect.notEligible).sort()));
    if (ne !== wne) bad.push(`#${j + 1}: not eligible ${ne} (want ${wne})`);
  });
};
// 14: Holm
const runHolm: Runner = (c, plant, bad) => {
  (c.sets as Array<{ items: Array<[string, number, number | null, number]>; expect: Record<string, [number, boolean]> }>).forEach((st, j) => {
    const h = holmOf(st.items.map(([src, p, t, nE]) => ({ src, p, t, nE })), plant);
    for (const [src, [rank, pass]] of Object.entries(st.expect)) {
      const g = h.get(src);
      if (!g || g.rank !== rank || g.pass !== pass) bad.push(`#${j + 1} ${src}: ${g ? `${g.rank} ${g.pass}` : "none"} (want ${rank} ${pass})`);
    }
  });
};
// 11: the overlap groups among the floor-passing items (a pair without an overlap entry: conventions.groups)
const runGroups: Runner = (c, plant, bad, L) => {
  const ov = c.overlap as Record<string, number>;
  const missing = L.get<number>(c, "groups", "missingShare");
  const one = (k: string) => ov[k] ?? missing;
  const share = (a: string, b: string) => Math.max(one(`${a}>${b}`), one(`${b}>${a}`));
  (c.sets as Array<{ items: string[]; expect: Record<string, string> }>).forEach((st, j) => {
    const g = groupsOf(st.items, share, plant);
    const got = JSON.stringify(Object.fromEntries(Object.entries(g).sort()));
    const want = JSON.stringify(Object.fromEntries(Object.entries(st.expect).sort()));
    if (got !== want) bad.push(`#${j + 1}: ${got} (want ${want})`);
  });
};
const runFloor: Runner = (c, plant, bad) => {
  for (const [[n1, w1], [n2, w2], want] of c.items as Array<[[number, number], [number, number], boolean]>) {
    const got = floorOf({ counted: n1, weeks: w1 }, { counted: n2, weeks: w2 }, plant);
    if (got !== want) bad.push(`${n1}/${w1}, ${n2}/${w2}: ${got} (want ${want})`);
  }
};
// 13: the suspicious lines (conventions.suspect: the order of a W array, the other counts, Δ_late when null)
const runSuspect: Runner = (c, _plant, bad, L) => {
  const fields = L.get<string[]>(c, "suspect", "wFields");
  const counts = L.get<{ tp: number; sl: number; amb: number; open: number }>(c, "suspect", "otherCounts");
  const lateWhenNull = L.get<string>(c, "suspect", "lateWhenNull");
  const blindDefault = L.get<boolean>(c, "suspect", "blind");
  const wp = (x: number[]): WinPl => {
    const v = Object.fromEntries(fields.map((f, k) => [f, x[k]])) as Record<string, number>;
    return { n: v.resolved, resolved: v.resolved, ...counts, wRes: v.wRes, wAll: v.wAll, pl: v.pl, wLo: null, wHi: null, plLo: null, plHi: null };
  };
  const base = c.base as Record<string, unknown>;
  for (const [over, want] of c.items as Array<[Record<string, unknown>, string[]]>) {
    const x = { ...base, ...over } as Record<string, unknown>;
    const delta = x.delta as number;
    const late = (x.late ?? x[lateWhenNull]) as number;
    const got = suspiciousOf({ delta, a: x.a as number, late, w4: wp(x.w4 as number[]), w10: wp(x.w10 as number[]), blind: (x.blind ?? blindDefault) as boolean });
    if (got.join(",") !== want.join(",")) bad.push(`${JSON.stringify(over)}: ${got.join(",") || "none"} (want ${want.join(",") || "none"})`);
  }
};

// 21: the numbers' formatting
const runTextNumbers: Runner = (c, _plant, bad) => {
  for (const [f, v, want] of c.items as Array<[string, number, string]>) {
    const got = f === "pts" ? fmt.pts(v) : f === "pct" ? fmt.pct(v) : f === "pips" ? fmt.pips(v) : fmt.yen(v);
    if (got !== want) bad.push(`${f}(${v}): ${got} (want ${want})`);
  }
};
// 9: W (決着の中) and the blind-weighted W1 / PL1 of a row (rowOf on a manual table; conventions.winDenominator)
const runWinDenominator: Runner = (c, plant, bad, L) => {
  const get = <T>(key: string): T => L.get<T>(c, "winDenominator", key);
  const t0 = ms(get<string>("tradesFrom"));
  const pips = get<number>("tradePips");
  const w = winPlOf((c.trades as Kind[]).map((kind, k) => ({ T: t0 + k * STEP, kind, pips })));
  const ew = c.expectW as { n: number; resolved: number; wRes: number; wAll: number };
  if (w.n !== ew.n || w.resolved !== ew.resolved || !near(w.wRes, ew.wRes) || !near(w.wAll, ew.wAll)) bad.push(`W n ${w.n} resolved ${w.resolved} wRes ${w.wRes} wAll ${w.wAll}`);
  const tl = tableOf(c, L);
  const rowE = get<number>("rowE");
  const dir = dirOf(get<string>("signalDir"));
  const rows = (c.rows as Array<[string, Kind, number]>).map(([open, k4, p4]) => ({ open: ms(open), eBuy: rowE, k4, p4 }));
  const { bt, pb } = manualTable(rows, tl);
  const tr = (c.signals as string[]).map((T) => sigTradeAt(bt, pb, ms(T), dir));
  const blind = blindObsOf(bt, tl.layer, tl.p, plant);
  const r = rowOf("hand", tr, tl.layer, tl.half, bt, worldOf(pb), blind, tl.p, { plant, shift: false });
  const ex = c.expect as { blindW1: number; blindPl1: number };
  if (!near(r.blindW1, ex.blindW1, 1e-12) || !near(r.blindPl1, ex.blindPl1, 1e-12)) bad.push(`blind W1 ${r.blindW1}, PL1 ${r.blindPl1} (want ${ex.blindW1}, ${ex.blindPl1})`);
};

// 14, 21: a made-up second half → stage2Of → the sentences, compared by the fragments written by hand
interface TextExpect {
  judgments?: Record<string, string>;
  forms?: Record<string, string>;
  text?: Record<string, { contains?: string[]; absent?: string[]; startsWith?: string }>;
}
const checkText = (sent: Map<string, string>, ex: TextExpect["text"], bad: string[]) => {
  for (const [id, e] of Object.entries(ex ?? {})) {
    const s = sent.get(id);
    if (s === undefined) {
      bad.push(`${id}: no sentence`);
      continue;
    }
    for (const f of e.contains ?? []) if (!s.includes(f)) bad.push(`${id}: missing「${f.slice(0, 40)}…」`);
    for (const f of e.absent ?? []) if (s.includes(f)) bad.push(`${id}: has「${f.slice(0, 40)}…」`);
    if (e.startsWith && !s.startsWith(e.startsWith)) bad.push(`${id}: does not start「${e.startsWith.slice(0, 40)}…」`);
  }
};
const stage2World = (items: RowSpec[], df: number, ultra: Record<Group, Row>, macd: Record<Group, Row>, plant: string, m1: number, R: RowsLayout) => {
  const rows = items.map((s) => rowFrom(s, df, groupOf(s.id), R));
  const s2 = stage2Of({ rows, ultra, macd, plant });
  const sentences = new Map(stage2Text(s2, { kTotal: s2.kTotal, m1, rows: new Map(rows.map((r) => [r.src, r])), ultra: ultra.chart, macd: macd.chart, hold: new Map() }));
  return { rows, s2, sentences };
};
// the emails of a text / dab case (its group: Δ, its SE and its pattern; a scenario gives its own Δ)
const emailsOf = (c: HandCase, L: Layout, group: string, df: number, R: RowsLayout, ultraDelta?: number, macdDelta?: number) => {
  const est = L.get<number>(c, group, "emailDelta");
  const se = L.get<number | null>(c, group, "emailSe");
  const pattern = L.get<string>(c, group, "emailPattern");
  return { ultra: emailRow("ultra5", ultraDelta ?? est, se, df, pattern, R), macd: emailRow("macdx5", macdDelta ?? est, se, df, pattern, R) };
};
const runText: Runner = (c, plant, bad, L) => {
  const df = c.df as number;
  const m1 = c.m1 as number;
  const R = rowsOf(c, L);
  if (c.scenarios) {
    const item = L.get<Omit<RowSpec, "id">>(c, "text", "scenarioItem");
    for (const sc of c.scenarios as Array<{ item: string; ultra: number; macd: number; contains: string[] }>) {
      const spec: RowSpec = { ...item, id: sc.item };
      const em = emailsOf(c, L, "text", df, R, sc.ultra, sc.macd);
      const w = stage2World([spec], df, em.ultra, em.macd, plant, m1, R);
      const x = w.s2.items[0];
      if (x.judgment !== "confirmed") bad.push(`${sc.item}: ${x.judgment} (want confirmed)`);
      checkText(w.sentences, { [`s2.item.${sc.item}`]: { contains: sc.contains } }, bad);
    }
    return;
  }
  const em = emailsOf(c, L, "text", df, R);
  const w = stage2World(c.items as RowSpec[], df, em.ultra, em.macd, plant, m1, R);
  const ex = c.expect as TextExpect;
  for (const [id, j] of Object.entries(ex.judgments ?? {})) {
    const x = w.s2.items.find((y) => y.src === id);
    if (!x || x.judgment !== j) bad.push(`${id}: ${x?.judgment ?? "none"} (want ${j})`);
  }
  for (const [id, f] of Object.entries(ex.forms ?? {})) {
    const x = w.s2.items.find((y) => y.src === id);
    if (!x || x.form !== f) bad.push(`${id}: form ${x?.form ?? "none"} (want ${f})`);
  }
  checkText(w.sentences, ex.text, bad);
};
// 14, 20 (g): D_AB of two confirmed chart items, the promotion by the simultaneous low end, the sentence
// (conventions.dab: the items' other numbers and patterns, the emails, M_1)
const runDab: Runner = (c, plant, bad, L) => {
  const df = c.df as number;
  const R = rowsOf(c, L);
  const get = <T>(key: string): T => L.get<T>(c, "dab", key);
  const it = get<{ lateLo: number; lateHiAboveEst: number; a: [number, number]; w4: [number, number]; w10: [number, number] }>("item");
  const patterns = get<string[]>("patternByIndex");
  const specs: RowSpec[] = (c.items as Array<[string, number, number]>).map(([id, est, se], k) => {
    const pattern = patterns[k];
    if (pattern === undefined) throw new Error(`no pattern for item ${k + 1} in hand.json's conventions.dab`);
    return { id, delta: [est, se], late: [est, it.lateLo, est + it.lateHiAboveEst], a: it.a, w4: it.w4, w10: it.w10, pattern };
  });
  const em = emailsOf(c, L, "dab", df, R);
  const w = stage2World(specs, df, em.ultra, em.macd, plant, get<number>("m1"), R);
  const ex = c.expect as { promote: string; confirmed: string[]; se: number; contains: string[] };
  const conf = w.s2.items.filter((x) => x.judgment === "confirmed").map((x) => x.src);
  if (conf.join(",") !== ex.confirmed.join(",")) bad.push(`confirmed ${conf.join(",")} (want ${ex.confirmed.join(",")})`);
  if (w.s2.promote.chart !== ex.promote) bad.push(`promoted ${w.s2.promote.chart} (want ${ex.promote})`);
  const d = w.s2.dAB[0];
  const used = d?.est.cands.find((x) => x.kind === d.est.use);
  if (!d || !near(used?.se, ex.se, 1e-9)) bad.push(`D_AB SE ${used?.se} (want ${ex.se})`);
  checkText(w.sentences, { "s2.final": { contains: ex.contains } }, bad);
};

// 21 〈オーナーの持ち方の文〉 (§8.102 書く文 through SQ-08 / SQ-H1): one account's facts → holdText, and 21's range
// sentence → holdRangeText, each compared whole, character for character. The facts' times are ISO strings.
type HoldRowJson = Omit<HoldRowFacts, "lcAt" | "deadlineAt" | "cappedCalls"> & {
  lcAt: string[];
  deadlineAt: string[];
  cappedCalls: Array<{ tau: string; short: number; end: string }>;
};
const holdRowOf = (r: HoldRowJson): HoldRowFacts => ({
  ...r,
  lcAt: r.lcAt.map(ms),
  deadlineAt: r.deadlineAt.map(ms),
  cappedCalls: r.cappedCalls.map((x) => ({ tau: ms(x.tau), short: x.short, end: x.end })),
});
const holdFactsOf = (x: Rec): HoldFacts => {
  if (x.timedOut) return x as unknown as HoldFacts;
  const rows = x.rows as Record<string, HoldRowJson>;
  for (const k of ROWS4) if (!rows[k]) throw new Error(`facts.rows has no ${k}`);
  return { ...(x as unknown as HoldFacts), rows: Object.fromEntries(ROWS4.map((k) => [k, holdRowOf(rows[k])])) as HoldFacts["rows"] };
};
// where two sentences part (a short window of both)
const firstDiff = (got: string, want: string): string => {
  let k = 0;
  while (k < got.length && k < want.length && got[k] === want[k]) k++;
  const win = (s: string) => s.slice(Math.max(0, k - 12), k + 24);
  return `differs at ${k} (length ${got.length}, want ${want.length}): 「…${win(got)}…」 want 「…${win(want)}…」`;
};
const runHoldText: Runner = (c, _plant, bad) => {
  const f = holdFactsOf(c.facts as Rec);
  // ①②③ as the run derives them from its facts (holdVerdictOf, which factsOf uses): the case's facts.verdict must be
  // what its own numbers give (indep-06: the branches only the hand cases reach are the run's code too)
  if (!f.timedOut) {
    const v = holdVerdictOf(f);
    for (const k of ["one", "twoAccounts", "twoM", "three"] as const) if (v[k] !== f.verdict[k]) bad.push(`verdict.${k}: the facts give ${v[k]}, the case says ${f.verdict[k]}`);
  }
  const got = holdText(f);
  const want = (c.expect as { text: string }).text;
  if (got !== want) bad.push(firstDiff(got, want));
};
// §8.102 ①: a row's call records written by hand as research/ownerhold's (τ the NY close, the ending and its time, U after
// the notice's deposit, null when no notice's deposit came) → the calls the sentences list, through the functions
// factsOf uses (cappedCallsOf, deadlineAtOf), their times as the sentences write them (SQ-PF1: the call's τ)
const runHoldCalls: Runner = (c, _plant, bad) => {
  const calls: OhCall[] = (c.calls as Array<{ tau: string; end: string; endAt: string | null; uAfterDeposit: number | null }>).map((x) => ({
    tau: ms(x.tau), end: x.end, endAt: x.endAt === null ? NaN : ms(x.endAt), uAfterDeposit: x.uAfterDeposit,
  }));
  const ex = c.expect as { capped: Array<[string, number, string]>; deadlineAt: string[] };
  const got = cappedCallsOf(calls).map((x) => `${isoMin(x.tau)}・${x.short}・${x.end}`).join(" | ");
  const want = ex.capped.map(([at, short, end]) => `${at}・${short}・${end}`).join(" | ");
  if (got !== want) bad.push(`capped calls ${got || "none"} (want ${want || "none"})`);
  const gotD = deadlineAtOf(calls).map(isoMin).join(", ");
  if (gotD !== ex.deadlineAt.join(", ")) bad.push(`deadline close-outs ${gotD || "none"} (want ${ex.deadlineAt.join(", ") || "none"})`);
};
// §8.111 2・3 (with its review fix 2) and 9: one late ULTRA signal (window i + 1) put into the owner-hold list of the full
// account (holdSigsOf, the list a run makes; conventions.holdLate): listed only when a read at the next bar's close
// + 0, 1, 3 min is under 10 minutes after T and outside isPossiblyClosed; base = the next bar's close, P = base + 2 min
const runHoldLate: Runner = (c, _plant, bad, L) => {
  const pair = L.get<Pair>(c, "holdLate", "pair");
  const p = periodOfLayout(c, L, L.get<string>(c, "holdLate", "period"));
  (c.subcases as Rec[]).forEach((s, j) => {
    const tag = `${String(s.name ?? `#${j + 1}`)}: `;
    const pb = flatBars(pair, (s.opens as string[]).map(ms), L.get<number>(c, "holdLate", "flatMid", s), halfSpreadOf(c, L, pair));
    const i = s.i as number;
    if (!(i >= 0 && i < pb.n)) throw new Error(`${tag}bar ${i} is not one of the subcase's bars`);
    const late: LateSig = { pi: pb.pi, i, T: pb.t[i] + STEP, dir: dirOf(L.get<string>(c, "holdLate", "dir", s)) };
    const list = holdSigsOf([], [late], worldOf(pb), p.start, p.end);
    const ex = s.expect as { listed: boolean; T?: string; base?: string; P?: string };
    if (!ex.listed) {
      if (list.length) bad.push(`${tag}listed (base ${iso(list[0].base)}), want not listed`);
      return;
    }
    if (list.length !== 1) {
      bad.push(`${tag}${list.length} rows (want the late signal)`);
      return;
    }
    const r = list[0];
    const got = `T ${iso(r.T)} base ${iso(r.base)} P ${iso(pOfSig(r))} late ${r.late}`;
    const want = `T ${ex.T} base ${ex.base} P ${ex.P} late true`;
    if (got !== want) bad.push(`${tag}${got} (want ${want})`);
  });
};
const runHoldRange: Runner = (c, _plant, bad) => {
  const fs = (c.facts as Rec[]).map((x) => x as unknown as HoldFacts);
  const got = holdRangeText(fs) ?? "(none)";
  const want = (c.expect as { text: string }).text;
  if (got !== want) bad.push(firstDiff(got, want));
};

const RUNNERS: Record<string, Runner> = {
  c1: runC1, k1: runK1, dst: runDst, round: runRound, points: runPoints, follow: runFollow, mirror: runMirror, sent: runSent,
  events: runEvents, hole: runHole, half: runHalf, delta: runDelta, deltaT: runDeltaT, clusters: runClusters, shift: runShift,
  sepick: runSePick, tq: runTq, lbcount: runLbCount, select: runSelect, holm: runHolm, groups: runGroups, floor: runFloor,
  suspect: runSuspect, textNumbers: runTextNumbers, winDenominator: runWinDenominator, text: runText, dab: runDab,
  holdText: runHoldText, holdRange: runHoldRange, holdCalls: runHoldCalls, holdLate: runHoldLate,
};

// every case of hand.json with its conventions; a case that throws fails with the error's first line
export const runHand = async (doc: HandDoc, plant: string): Promise<Record<string, HandResult>> => {
  if (!doc.conventions || typeof doc.conventions !== "object") throw new Error("hand.json has no conventions (SQ-I2: the cases' layout is read from it)");
  const L = layoutOf(doc.conventions);
  const out: Record<string, HandResult> = {};
  for (const c of doc.cases) {
    const bad: string[] = [];
    const run = RUNNERS[c.kind];
    try {
      if (!run) throw new Error(`no runner for kind ${c.kind}`);
      await run(c, plant, bad, L);
    } catch (e) {
      bad.push(`error: ${(e instanceof Error ? e.message : String(e)).split("\n")[0]}`);
    }
    out[c.id] = bad.length ? { ok: false, detail: bad.slice(0, 8) } : { ok: true };
  }
  return out;
};
export const handPath = "research/chartbest/hand.json";
