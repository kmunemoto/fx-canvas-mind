// #318 (docs §8.113 19, 20 (g)): the TS runner of the hand examples (research/chartbest/hand.json). Each case is
// run through the program's own functions — the items and the event framework, the time and the season, the
// chart's rounding and the points, the follow and the blind table, Δ and its SE, the shift, the selection, Holm,
// the groups and the floor, the suspicious lines and the sentences — and compared with the answer written by
// hand in the file. A planted error of hook "hand" (20 (f), CB_PLANT) must make at least one of its named cases
// fail. Never reads a price: every bar here is made up in the file.

import type { QuoteCandle } from "../supabase/functions/track-outcomes/quotes.ts";
import { type PairBars, digitsOf, indexAt, midOf, pairBarsFromSides, pairBarsOf, pipOf, pointsOf } from "./chartbest-bars.ts";
import { type Dir, type Group, type Half, MINI_PERIOD, PAIRS, type Pair, type Period, STEP, TP_MAIL, TP_MAIN, dirName } from "./chartbest-const.ts";
import { type Holes, type ItemDef, type ItemOut, type Named, classify, eOf, eventsOf, holeOverlaps, holesOf } from "./chartbest-events.ts";
import { ITEM_DONCHIAN_A20, donchianTarget } from "./chartbest-donchian-lib.ts";
import { ITEM_BREEDON_1, ITEM_BREEDON_2 } from "./chartbest-breedon-lib.ts";
import { type BlindPair, type BlindTable, CODE_KIND, KIND_CODE, type Kind, NO_E, blindTableOf, newFollowCtx, tradeOf } from "./chartbest-follow.ts";
import { type Est, type Inf, type Obs, type SeCand, type SeKind, type WinPl, deltaOf, finish, pickSe, tq, winPlOf } from "./chartbest-stats.ts";
import { stratumOf } from "./chartbest-strata.ts";
import { SEASON_NAMES, block4, seasonOf, sent, wk } from "./chartbest-time.ts";
import { type Row, type SigTrade, blindObsOf, rowOf, shiftOf } from "./chartbest-rows.ts";
import { chooseStage1, groupCount, holmOf, itemCount, p95Of, stage2Of, suspectOfRow, suspiciousOf } from "./chartbest-select.ts";
import { floorOf, groupsOf } from "./chartbest-count.ts";
import { fmt, stage2Text } from "./chartbest-text.ts";

export interface HandCase {
  id: string;
  kind: string;
  [k: string]: unknown;
}
export interface HandResult {
  ok: boolean;
  detail?: string[];
}

// ---- helpers ---------------------------------------------------------------------------------------------------

const ms = (iso: string): number => Date.parse(iso);
const iso = (t: number): string => new Date(t).toISOString().replace(".000Z", "Z");
const near = (a: number | null | undefined, b: number, tol = 1e-9): boolean => a !== null && a !== undefined && Math.abs(a - b) <= tol;
const piOf = (pair: string): number => PAIRS.indexOf(pair as Pair);
type Ohlc = [number, number, number, number];

// a pair's bars from mid OHLC rows (bid = mid − h, ask = mid + h, the chart's mid re-derived)
const barsFromMids = (pair: Pair, times: number[], mids: Ohlc[]): PairBars => {
  const n = times.length;
  const h = pair.includes("JPY") ? 0.002 : 0.00002;
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
const flatBars = (pair: Pair, times: number[], mid: number): PairBars => barsFromMids(pair, times, times.map(() => [mid, mid, mid, mid] as Ohlc));
const noHoles = (): Holes => ({ byPair: PAIRS.map(() => new Float64Array(0)), openSlots: 0 });
const ctxOf = (plant: string, params: Record<string, number> = {}) => ({ plant, params });

// ---- the cases -------------------------------------------------------------------------------------------------

type Runner = (c: HandCase, plant: string, bad: string[]) => void | Promise<void>;

// 19 C1: donchian with n shortened, the target against bigflow-lib's donchianState (20 (b)), the signals
const runC1: Runner = async (c, plant, bad) => {
  const pair = c.pair as Pair;
  const rows = c.bars as Ohlc[];
  const t0 = ms(c.start as string);
  const pb = barsFromMids(pair, rows.map((_, k) => t0 + k * STEP), rows);
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

// 19 K1 / 18 K1: breedon-1 and breedon-2 on EUR/USD bars at the listed opens
const runK1: Runner = (c, plant, bad) => {
  const times = (c.bars as string[]).map(ms);
  const pb = flatBars("EUR/USD", times, 1.03);
  const ex = c.expect as Record<string, Array<[string, string, string[]]>>;
  for (const def of [ITEM_BREEDON_1, ITEM_BREEDON_2]) {
    const ev = eventsOf(def, pb, ctxOf(plant));
    const got = ev.cands.map((x) => `${iso(x.T)} ${dirName(x.dir)} [${x.marks.join(";")}]`).join(", ");
    const want = (ex[def.id] ?? []).map(([T, d, m]) => `${T} ${d} [${m.join(";")}]`).join(", ");
    if (got !== want) bad.push(`${def.id}: ${got || "none"} (want ${want || "none"})`);
  }
};

// 20 (g) 時刻: the switch dates; breedon's T and the season group at T, and the shifted-week mark
const runDst: Runner = (c, plant, bad) => {
  const days = c.days as Array<[string, string, string, string]>;
  const times = [ms(c.context as string)];
  for (const [d] of days) for (const hm of ["06:55", "07:55", "14:55", "15:55"]) times.push(ms(`${d}T${hm}:00Z`));
  const pb = flatBars("EUR/USD", times, 1.08);
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
const runRound: Runner = (c, _plant, bad) => {
  const pair = c.pair as Pair;
  const d = digitsOf(pair);
  const t = Date.UTC(2025, 0, 6, 1, 0);
  const side = (v: number) => ({ datetime: new Date(t).toISOString(), open: v, high: v, low: v, close: v });
  const q: QuoteCandle[] = [{ datetime: new Date(t).toISOString(), bid: side(c.bid as number), ask: side(c.ask as number) }];
  const pb = pairBarsOf(pair, piOf(pair), q, t + 2 * STEP);
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

// 7: one trade through tradeOf (the follow the blind table uses), from the bar after the signal bar
interface FollowSpec {
  rows: Ohlc[];
  count?: number;
  tail?: Ohlc[];
  after?: Ohlc[];
  expect: { kind: Kind | null; pips?: number; bars?: number };
}
const followOne = (c: HandCase, f: FollowSpec, plant: string): string | null => {
  const pair = c.pair as Pair;
  const jpy = pair.includes("JPY");
  const t0 = ms((c.signalAt as string | undefined) ?? "2025-01-06T01:00:00Z");
  const tf = c.followAt ? ms(c.followAt as string) : t0 + STEP;
  const sb = (c.signalBid as number | undefined) ?? 149.995;
  const sa = (c.signalAsk as number | undefined) ?? 150.005;
  const spread = (c.spread as number | undefined) ?? (jpy ? 0.005 : 0.00004);
  const filler = (c.filler as Ohlc | undefined) ?? (jpy ? [150.0, 150.02, 149.98, 150.0] : [1.1643, 1.1645, 1.164, 1.1643]);
  const count = f.count ?? 1441;
  const tail = f.tail ?? [];
  const rows: Ohlc[] = [...f.rows];
  while (rows.length < count - tail.length) rows.push(filler);
  rows.push(...tail, ...(f.after ?? []));
  const times = [t0, ...rows.map((_, k) => tf + k * STEP)];
  const bids: Ohlc[] = [[sb, sb, sb, sb], ...rows];
  const spreads = [sa - sb, ...rows.map(() => spread)];
  const pb = barsFromBids(pair, times, bids, spreads);
  const dir: Dir = c.dir === "BUY" ? 1 : -1;
  const tp = (c.tp as number) === 4 ? TP_MAIL : TP_MAIN;
  const tr = tradeOf(pb, 0, dir, tp, 1, newFollowCtx(plant, Infinity), eOf(pb, 0, plant));
  const want = f.expect;
  if (want.kind === null) return tr === null ? null : `followed (${tr.kind}), want not followed`;
  if (!tr) return `not followed (want ${want.kind})`;
  const out: string[] = [];
  if (tr.kind !== want.kind) out.push(`kind ${tr.kind} (want ${want.kind})`);
  if (want.pips !== undefined && !near(tr.pips, want.pips, 1e-6)) out.push(`pips ${tr.pips} (want ${want.pips})`);
  if (want.bars !== undefined && tr.bars !== want.bars) out.push(`bars ${tr.bars} (want ${want.bars})`);
  return out.length ? out.join("; ") : null;
};
const runFollow: Runner = (c, plant, bad) => {
  const subs = (c.subcases as FollowSpec[] | undefined) ?? [{ rows: c.rows as Ohlc[], count: c.count as number | undefined, tail: c.tail as Ohlc[] | undefined, after: c.after as Ohlc[] | undefined, expect: c.expect as FollowSpec["expect"] }];
  subs.forEach((s, j) => {
    const e = followOne(c, s, plant);
    if (e) bad.push(subs.length > 1 ? `#${j + 1}: ${e}` : e);
  });
};

// 8: e of a blind-table row (the mirror), through blindTableOf on a one-row world of the mini period's H1
const runMirror: Runner = (c, plant, bad) => {
  const t0 = Date.UTC(2024, 0, 8, 0, 0);
  (c.worlds as Array<{ rows: Ohlc[]; e: number }>).forEach((w, j) => {
    const rows: Ohlc[] = [...w.rows];
    while (rows.length < 1440) rows.push([150.0, 150.02, 149.98, 150.0]);
    const times = [t0, ...rows.map((_, k) => t0 + (k + 1) * STEP)];
    const pb = barsFromBids("USD/JPY", times, [[149.995, 149.995, 149.995, 149.995], ...rows], [0.01, ...rows.map(() => 0.005)]);
    const bt = blindTableOf([pb], noHoles(), "H1", MINI_PERIOD, plant, MINI_PERIOD.split);
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

// 5: the event framework on a made-up item (always / condition / named)
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
const runEvents: Runner = (c, plant, bad) => {
  (c.seqs as EventSeq[]).forEach((s, j) => {
    const n = s.target?.length ?? s.buy?.length ?? s.namedBuy!.length;
    const pb = flatBars("USD/JPY", Array.from({ length: n }, (_, k) => Date.UTC(2025, 0, 6, 1, 0) + k * STEP), 150);
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

// 6 ③: the holes of five pairs' bars, and the overlap of a signal's window
const runHole: Runner = (c, _plant, bad) => {
  const a = ms(c.start as string);
  const b = ms(c.end as string);
  const missing = c.missing as Record<string, string[]>;
  const bars = PAIRS.map((pair) => {
    const miss = new Set((missing[pair] ?? []).map(ms));
    const times: number[] = [];
    for (let t = a; t < b; t += STEP) if (!miss.has(t)) times.push(t);
    return flatBars(pair, times, pair.includes("JPY") ? 150 : 1.1);
  });
  const p: Period = { ...MINI_PERIOD, s0: a, end: b };
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
    const cl = classify(uj, 0, i, true, holes, p);
    if ((cl.reason === "r3") !== want) bad.push(`reason at ${open}: ${cl.reason}`);
  }
};

// 1, 6 ④: the halves around SPLIT and the follow window crossing it (classify on the mini period)
const runHalf: Runner = (c, plant, bad) => {
  const times: number[] = [];
  for (let t = ms(c.from as string); t <= ms(c.to as string); t += STEP) times.push(t);
  const pb = flatBars("USD/JPY", times, 150);
  for (const [open, reason, half] of c.expect as Array<[string, string, string | null]>) {
    const i = indexAt(pb.t, ms(open));
    const cl = classify(pb, 0, i, true, noHoles(), MINI_PERIOD, plant);
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
// the same with the strata of real times (the chart layer: pair × direction × hour × season)
const runDeltaT: Runner = (c, plant, bad) => {
  const pi = piOf(c.pair as string);
  const dir: Dir = c.dir === "BUY" ? 1 : -1;
  const layer = c.layer as Group;
  const mk = (xs: Array<[string, number]>): Obs[] => xs.map(([T, v]) => ({ s: stratumOf(layer, pi, dir, ms(T), plant), week: wk(ms(T)), block: block4(ms(T), "H1", MINI_PERIOD), v }));
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
const runClusters: Runner = (c, plant, bad) => {
  (c.sets as Array<{ weeks: number[]; blocks: number[]; kinds: string[]; C: number[] }>).forEach((st, j) => {
    const sig: Obs[] = st.weeks.map((w, k) => ({ s: 0, week: w, block: st.blocks[k], v: k % 2 === 0 ? 0.5 : 0 }));
    const bl: Obs[] = st.weeks.map((w, k) => ({ s: 0, week: w, block: st.blocks[k], v: k % 3 === 0 ? -0.5 : 0 }));
    const e = deltaOf(sig, blindOfObs(bl), { plant });
    const kinds = e.cands.map((x) => x.kind).join(",");
    const C = e.cands.map((x) => x.C).join(",");
    if (kinds !== st.kinds.join(",") || C !== st.C.join(",")) bad.push(`#${j + 1}: ${kinds} C ${C} (want ${st.kinds.join(",")} C ${st.C.join(",")})`);
  });
};

// a made-up blind table of one pair (USD/JPY) from rows (bar open, e of BUY, TP4 kind and pips of BUY)
const manualTable = (rows: Array<{ open: number; eBuy: number; k4?: Kind; p4?: number }>, half: Half, p: Period): { bt: BlindTable; pb: PairBars } => {
  const sorted = [...rows].sort((a, b) => a.open - b.open);
  const pb = flatBars("USD/JPY", sorted.map((r) => r.open), 150);
  const n = sorted.length;
  const u8 = () => new Uint8Array(n);
  const f64 = () => new Float64Array(n);
  const bp: BlindPair = {
    pi: 0, n, k: Int32Array.from(sorted.map((_, k) => k)), T: Float64Array.from(sorted.map((r) => r.open + STEP)), E: Float64Array.from(sorted.map(() => 150)),
    hour: Uint8Array.from(sorted.map((r) => new Date(r.open + STEP).getUTCHours())), season: Uint8Array.from(sorted.map((r) => seasonOf(r.open + STEP))),
    week: Int32Array.from(sorted.map((r) => wk(r.open + STEP))), block: Int32Array.from(sorted.map((r) => block4(r.open + STEP, half, p))),
    kind: { b4: Uint8Array.from(sorted.map((r) => KIND_CODE[r.k4 ?? "sl"])), s4: u8().fill(KIND_CODE.sl), b10: u8().fill(KIND_CODE.sl), s10: u8().fill(KIND_CODE.sl) },
    pips: { b4: Float64Array.from(sorted.map((r) => r.p4 ?? -13.5)), s4: f64().fill(-13.5), b10: f64().fill(-13.5), s10: f64().fill(-13.5) },
    bars: { b4: new Uint16Array(n).fill(1), s4: new Uint16Array(n).fill(1), b10: new Uint16Array(n).fill(1), s10: new Uint16Array(n).fill(1) },
    at: { b4: Int32Array.from(sorted.map((_, k) => k)), s4: Int32Array.from(sorted.map((_, k) => k)), b10: Int32Array.from(sorted.map((_, k) => k)), s10: Int32Array.from(sorted.map((_, k) => k)) },
    eBuy: Int8Array.from(sorted.map((r) => r.eBuy)), rowOfK: Int32Array.from(sorted.map((_, k) => k)),
  };
  const weeks = [...new Set(Array.from(bp.week))].sort((a, b) => a - b);
  return { bt: { half, pairs: [bp], weeks, maxReadClose: -Infinity, pastReadEnd: 0 }, pb };
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
    src: "hand", pi: 0, i: k, T, dir, half: bt.half, r, e,
    k4: CODE_KIND[bp.kind[key4][r]], k10: CODE_KIND[bp.kind[key10][r]], p4: bp.pips[key4][r], p10: bp.pips[key10][r],
    mp4: 0, mp10: 0, at10: bp.at[key10][r], lateT: null, eLate: null, nextOk: false,
  };
};

// 8, 10: the week shift on a manual blind table
const runShift: Runner = (c, plant, bad) => {
  const rows = (c.rows as Array<[string, number]>).map(([open, e]) => ({ open: ms(open), eBuy: e }));
  const { bt, pb } = manualTable(rows, "H1", MINI_PERIOD);
  const tr = (c.signals as Array<[string, string]>).map(([T, d]) => sigTradeAt(bt, pb, ms(T), d === "BUY" ? 1 : -1));
  const blind = blindObsOf(bt, "chart", MINI_PERIOD, plant);
  const ex = c.expect as { k: number[]; delta: number[]; dropped: number[]; sd: number; mean: number; rank: number; real: number };
  const sh = shiftOf(tr, bt, [pb, ...PAIRS.slice(1).map((p) => flatBars(p, [], 1))], blind, "H1", MINI_PERIOD, plant, { delta: ex.real, late: null }).delta;
  if (sh.k.join(",") !== ex.k.join(",")) bad.push(`k ${sh.k.join(",")} (want ${ex.k.join(",")})`);
  if (sh.delta.length !== ex.delta.length || sh.delta.some((d, j) => !near(d, ex.delta[j], 1e-12))) bad.push(`Δ_k ${sh.delta.join(",")} (want ${ex.delta.join(",")})`);
  if (sh.dropped.join(",") !== ex.dropped.join(",")) bad.push(`dropped ${sh.dropped.join(",")} (want ${ex.dropped.join(",")})`);
  if (!near(sh.sd, ex.sd, 1e-12)) bad.push(`SD ${sh.sd} (want ${ex.sd})`);
  if (!near(sh.mean, ex.mean, 1e-12)) bad.push(`mean ${sh.mean} (want ${ex.mean})`);
  if (sh.rank !== ex.rank) bad.push(`rank ${sh.rank} (want ${ex.rank})`);
};

const runSePick: Runner = (c, _plant, bad) => {
  for (const [cands, want] of c.items as Array<[Array<[string, number]>, string]>) {
    const cs: SeCand[] = cands.map(([kind, half]) => ({ kind: kind as SeKind, se: half, C: 20, df: 19, half }));
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

// rows made up for the selection, Holm and the sentences: Δ (with its candidates from influence sums on C
// clusters laid out so that two patterns are uncorrelated), a, Δ_late, W/PL
const C_PATTERN: Record<string, (g: number) => number> = { alt: (g) => (g % 2 === 0 ? 1 : -1), pairs: (g) => ((g >> 1) % 2 === 0 ? 1 : -1) };
const estOf = (est: number, se: number | null, df: number, pattern = "alt", N = 100): Est => {
  const inf: Inf = { week: new Map(), block: new Map() };
  if (se !== null) {
    const C = df + 1;
    const a = (se * Math.sqrt(C - 1)) / C;
    const f = C_PATTERN[pattern];
    for (let g = 0; g < C; g++) inf.week.set(g, a * f(g));
  }
  return finish({ est, N, strata: 1, dropped: 0, cands: [], use: null, t: null, lo: null, hi: null, lb: null, inf });
};
const winOf = (wRes: number, pl: number, resolved = 200): WinPl => ({ n: resolved, resolved, tp: Math.round(wRes * resolved), sl: resolved - Math.round(wRes * resolved), amb: 0, open: 0, wAll: wRes, wRes, pl, wLo: null, wHi: null, plLo: null, plHi: null });
interface RowSpec {
  id: string;
  delta: [number, number];
  late: [number, number, number];
  a: [number, number];
  w4: [number, number];
  w10: [number, number];
  byDir?: Record<"BUY" | "SELL", [number, number]>;
  pattern?: string;
}
const lateOf = (x: [number, number, number]): Est => ({ ...estOf(x[0], null, 1), lo: x[1], hi: x[2] });
const rowFrom = (s: RowSpec, df: number, layer: Group): Row => {
  const r: Row = {
    src: s.id, half: "H2", layer, counted: 100, nE: 100, unresolved: 0,
    delta: estOf(s.delta[0], s.delta[1], df, s.pattern ?? "alt"), a: estOf(s.a[0], s.a[1], df), late: lateOf(s.late), lateExcluded: 0,
    w4: winOf(s.w4[0], s.w4[1]), w10: winOf(s.w10[0], s.w10[1]), blindW1: 0.7, blindPl1: -1.0,
    byDir: {
      BUY: { est: s.byDir?.BUY[0] ?? null, N: s.byDir?.BUY[1] ?? 0, strata: 1, dropped: 0 },
      SELL: { est: s.byDir?.SELL[0] ?? null, N: s.byDir?.SELL[1] ?? 0, strata: 1, dropped: 0 },
    },
    byPair: {}, nonOverlap: null, perWeek: null, shift: null, suspicious: [],
  };
  r.suspicious = suspectOfRow(r);
  return r;
};
const groupOf = (id: string): Group => (["breedon-1", "breedon-2", "fix-A1", "fix-A2", "fix-B1", "fix-B2", "gap"].includes(id) ? "cal" : "chart");
const emailRow = (id: string, est: number, se: number | null, df: number, pattern: string): Record<Group, Row> => {
  const r = rowFrom({ id, delta: [est, 0], late: [est, est, est], a: [0, 0.01], w4: [0.7, -1.0], w10: [0.55, -0.5] }, df, "chart");
  r.delta = estOf(est, se, df, pattern);
  return { chart: r, cal: { ...r, layer: "cal" } };
};

// 12: the choice of stage 1
const runSelect: Runner = (c, plant, bad) => {
  (c.sets as Array<{ rows: Array<[string, number, number | null, number, string[]]>; groups: Record<string, string>; expect: { chart: string[]; cal: string[]; notEligible: Record<string, string> } }>).forEach((st, j) => {
    const rows = st.rows.map(([id, est, lb, nE, sus]) => {
      const r = rowFrom({ id, delta: [est, 0.01], late: [est, 0, 0], a: [0, 0.01], w4: [0.7, -1], w10: [0.5, -1] }, 20, groupOf(id));
      r.delta = { ...r.delta, est, lb, t: lb === null ? null : 3, lo: lb };
      r.nE = nE;
      r.suspicious = sus;
      return r;
    });
    const s1 = chooseStage1({ rows, groups: st.groups, checksOk: true, plant, countsOnly: false, yardstickHits: [] });
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
// 11: the overlap groups among the floor-passing items
const runGroups: Runner = (c, plant, bad) => {
  const ov = c.overlap as Record<string, number>;
  const share = (a: string, b: string) => Math.max(ov[`${a}>${b}`] ?? 0, ov[`${b}>${a}`] ?? 0);
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
// 13: the suspicious lines
const runSuspect: Runner = (c, _plant, bad) => {
  const base = c.base as { delta: number; a: number; late: number | null; w4: number[]; w10: number[] };
  const wp = (x: number[]): WinPl => ({ n: x[0], resolved: x[0], tp: 0, sl: 0, amb: 0, open: 0, wRes: x[1], wAll: x[2], pl: x[3], wLo: null, wHi: null, plLo: null, plHi: null });
  for (const [over, want] of c.items as Array<[Record<string, unknown>, string[]]>) {
    const x = { ...base, ...over } as typeof base & { blind?: boolean };
    const got = suspiciousOf({ delta: x.delta, a: x.a, late: x.late ?? x.delta, w4: wp(x.w4), w10: wp(x.w10), blind: x.blind });
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
// 9: W (決着の中) and the blind-weighted W1 / PL1 of a row (rowOf on a manual table)
const runWinDenominator: Runner = (c, plant, bad) => {
  const w = winPlOf((c.trades as Kind[]).map((kind, k) => ({ T: Date.UTC(2024, 0, 9) + k * STEP, kind, pips: 0 })));
  const ew = c.expectW as { n: number; resolved: number; wRes: number; wAll: number };
  if (w.n !== ew.n || w.resolved !== ew.resolved || !near(w.wRes, ew.wRes) || !near(w.wAll, ew.wAll)) bad.push(`W n ${w.n} resolved ${w.resolved} wRes ${w.wRes} wAll ${w.wAll}`);
  const rows = (c.rows as Array<[string, Kind, number]>).map(([open, k4, p4]) => ({ open: ms(open), eBuy: 0, k4, p4 }));
  const { bt, pb } = manualTable(rows, "H1", MINI_PERIOD);
  const tr = (c.signals as string[]).map((T) => sigTradeAt(bt, pb, ms(T), 1));
  const blind = blindObsOf(bt, "chart", MINI_PERIOD, plant);
  const bars = [pb, ...PAIRS.slice(1).map((p) => flatBars(p, [], 1))];
  const r = rowOf("hand", tr, "chart", "H1", bt, bars, blind, MINI_PERIOD, { plant, shift: false });
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
const stage2World = (items: RowSpec[], df: number, ultra: Record<Group, Row>, macd: Record<Group, Row>, plant: string, m1: number) => {
  const rows = items.map((s) => rowFrom(s, df, groupOf(s.id)));
  const s2 = stage2Of({ rows, ultra, macd, plant });
  const sentences = new Map(stage2Text(s2, { kTotal: s2.kTotal, m1, rows: new Map(rows.map((r) => [r.src, r])), ultra: ultra.chart, macd: macd.chart, hold: new Map() }));
  return { rows, s2, sentences };
};
const runText: Runner = (c, plant, bad) => {
  const df = c.df as number;
  const m1 = c.m1 as number;
  if (c.scenarios) {
    for (const sc of c.scenarios as Array<{ item: string; ultra: number; macd: number; contains: string[] }>) {
      const spec: RowSpec = { id: sc.item, delta: [0.08, 0.01], late: [0.08, 0.06, 0.1], a: [0.02, 0.01], w4: [0.7, -1.0], w10: [0.55, -0.5] };
      const w = stage2World([spec], df, emailRow("ultra5", sc.ultra, 0.01, df, "pairs"), emailRow("macdx5", sc.macd, 0.01, df, "pairs"), plant, m1);
      const x = w.s2.items[0];
      if (x.judgment !== "confirmed") bad.push(`${sc.item}: ${x.judgment} (want confirmed)`);
      checkText(w.sentences, { [`s2.item.${sc.item}`]: { contains: sc.contains } }, bad);
    }
    return;
  }
  const w = stage2World(c.items as RowSpec[], df, emailRow("ultra5", 0, 0.01, df, "pairs"), emailRow("macdx5", 0, 0.01, df, "pairs"), plant, m1);
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
const runDab: Runner = (c, plant, bad) => {
  const df = c.df as number;
  const specs: RowSpec[] = (c.items as Array<[string, number, number]>).map(([id, est, se], k) => ({
    id, delta: [est, se], late: [est, 0.0005, est + 0.01], a: [0.01, 0.01], w4: [0.7, -1.0], w10: [0.55, -0.5], pattern: k === 1 ? "pairs" : "alt",
  }));
  const none = emailRow("ultra5", 0, null, df, "alt");
  const w = stage2World(specs, df, none, emailRow("macdx5", 0, null, df, "alt"), plant, 10);
  const ex = c.expect as { promote: string; confirmed: string[]; se: number; contains: string[] };
  const conf = w.s2.items.filter((x) => x.judgment === "confirmed").map((x) => x.src);
  if (conf.join(",") !== ex.confirmed.join(",")) bad.push(`confirmed ${conf.join(",")} (want ${ex.confirmed.join(",")})`);
  if (w.s2.promote.chart !== ex.promote) bad.push(`promoted ${w.s2.promote.chart} (want ${ex.promote})`);
  const d = w.s2.dAB[0];
  const used = d?.est.cands.find((x) => x.kind === d.est.use);
  if (!d || !near(used?.se, ex.se, 1e-9)) bad.push(`D_AB SE ${used?.se} (want ${ex.se})`);
  checkText(w.sentences, { "s2.final": { contains: ex.contains } }, bad);
};

const RUNNERS: Record<string, Runner> = {
  c1: runC1, k1: runK1, dst: runDst, round: runRound, points: runPoints, follow: runFollow, mirror: runMirror, sent: runSent,
  events: runEvents, hole: runHole, half: runHalf, delta: runDelta, deltaT: runDeltaT, clusters: runClusters, shift: runShift,
  sepick: runSePick, tq: runTq, lbcount: runLbCount, select: runSelect, holm: runHolm, groups: runGroups, floor: runFloor,
  suspect: runSuspect, textNumbers: runTextNumbers, winDenominator: runWinDenominator, text: runText, dab: runDab,
};

// every case; a case that throws fails with the error's first line
export const runHand = async (cases: HandCase[], plant: string): Promise<Record<string, HandResult>> => {
  const out: Record<string, HandResult> = {};
  for (const c of cases) {
    const bad: string[] = [];
    const run = RUNNERS[c.kind];
    try {
      if (!run) throw new Error(`no runner for kind ${c.kind}`);
      await run(c, plant, bad);
    } catch (e) {
      bad.push(`error: ${(e instanceof Error ? e.message : String(e)).split("\n")[0]}`);
    }
    out[c.id] = bad.length ? { ok: false, detail: bad.slice(0, 8) } : { ok: true };
  }
  return out;
};
export const handPath = "research/chartbest/hand.json";
