// #318 (docs §8.113): the fixed numbers of the rule, in one place, with no logic.
//
// §8.113 1 (dates, pairs), 7 (the follow's levels and window), 8 (the halves, the weeks), 11 (the floor),
// 12 (K), 13 (the suspicious lines), 20 (b) (the seeds and sample sizes), 20 (e) (the made-up sets),
// the ledger files and their sha256 constants, the 59 items of 3 in their table order, and SPEC: the
// resolutions of the spec questions (scratchpad chartbest-impl/spec-questions.md, SQ-01 … SQ-30) where the
// rule leaves a choice open, each named so it can be changed in one place.
//
// Step 2 of 22 (the trial, made-up data only) builds four items (donchian-A20/A55, breedon-1/2) and the two
// emails' measures; the other 55 rows of ITEM_TABLE are `implemented: false`, and every real-data mode
// refuses to run while any row is (§5.4 of the plan).

import { MINUTE } from "./lib.ts";

export const PAIRS = ["USD/JPY", "EUR/JPY", "AUD/JPY", "EUR/USD", "AUD/USD"] as const;
export type Pair = (typeof PAIRS)[number];
export type Half = "H1" | "H2";
export const HALVES: readonly Half[] = ["H1", "H2"];
// BUY 1, SELL −1; every list is sorted BUY first
export type Dir = 1 | -1;
export const DIRS: readonly Dir[] = [1, -1];
export const dirName = (d: Dir): "BUY" | "SELL" => (d === 1 ? "BUY" : "SELL");
export const dirIdx = (d: Dir): 0 | 1 => (d === 1 ? 0 : 1);
export type Group = "chart" | "cal";
export type Layer = Group;

// ---- 1. the dates -----------------------------------------------------------------------------------

export interface Period {
  name: "main" | "mini";
  s0: number;
  start: number;
  split: number;
  end: number;
  // w0 of each half's 4-week blocks (1): the week of START and of SPLIT
  w0: Record<Half, number>;
}
export const PERIOD: Period = {
  name: "main",
  s0: Date.UTC(2023, 9, 27),
  start: Date.UTC(2024, 0, 1),
  split: Date.UTC(2025, 4, 19),
  end: Date.UTC(2026, 9, 10),
  w0: { H1: 2817, H2: 2889 },
};
// development only: made-up runs of a few months (refused for sets, calib, plant-sum and every real mode)
export const MINI_PERIOD: Period = {
  name: "mini",
  s0: Date.UTC(2023, 9, 27),
  start: Date.UTC(2024, 0, 1),
  split: Date.UTC(2024, 1, 26),
  end: Date.UTC(2024, 3, 20),
  w0: { H1: 2817, H2: 2825 },
};
export const periodOf = (name: string): Period => {
  if (name === "main" || name === "") return PERIOD;
  if (name === "mini") return MINI_PERIOD;
  throw new Error(`CB_PERIOD ${name}: main or mini`);
};
// 17: R_cb, the first 00:00 UTC after the rule was merged (PR #208, merge c920d9e)
export const R_CB = Date.UTC(2026, 9, 13);

// ---- 7, 8, 11, 12, 13: the numbers -----------------------------------------------------------------

export const STEP = 5 * MINUTE;
// 7: the follow's window (bars) and its levels (pips from E)
export const TRACK = 1440;
export const SL = 13;
export const TP_MAIL = 4;
export const TP_MAIN = 10;
// 11: the floor, both halves
export const FLOOR = { n: 300, weeks: 30 } as const;
// 12: how many items each group sends to stage 2
export const K = { chart: 3, cal: 1 } as const;
// 14: one-sided, the whole family
export const ALPHA = 0.025;
// 8: |x| under this is 0 ("> 0" is not met, "≧ 0" is)
export const ZERO = 1e-12;
export const isPos = (x: number): boolean => Math.abs(x) >= ZERO && x > 0;
// 8: the 4-week candidate needs this many blocks
export const MIN_BLOCKS = 10;
// 13: the suspicious lines (points as values: 0.10 = 10 points), at least 100 resolved
export const SUSPECT = { minResolved: 100, delta: 0.10, a: 0.10, w2: 0.80, w1: 0.90, pl1: 1.0, pl2: 3.0, lateGap: 0.05 } as const;
// 9: fewer resolved than this: the win rate is not written (「数が少ない」)
export const FEW = 30;
// 11 (projections): a's standard deviation of one signal (§8.107), the marks' line, stage 3's weeks
export const A_SD = 0.47;
export const MARK_LINE = 0.10;
export const STAGE3_WEEKS = 26;
export const H2_WEEKS_EXPECTED = 72;
export const STAGE3_MIN = 100;
// 14 C2, C3: at least this many signals with e in a direction / a pair
export const C23_MIN = 30;

// ---- 20 (b): the look-ahead checks -----------------------------------------------------------------

export const POISON_PIPS = 777.7;
export const SEED = { cut: 318, poison: 319, gaps: 320 } as const;
export const SAMPLE = { cutEven: 300, cutMax: 3000, gapPts: 3000, poisonSigs: 100, poisonBars: 100, follow: 100, gapBefore: 10, dayBefore: 2 } as const;

// ---- 20 (e): the made-up sets ------------------------------------------------------------------------

const range = (a: number, b: number): number[] => Array.from({ length: b - a + 1 }, (_, k) => a + k);
export const SETS: Record<string, readonly number[]> = {
  N: range(101, 150),
  D: range(201, 230),
  H: range(301, 330),
  E: range(601, 610),
  E3: range(611, 620),
  Q: range(701, 710),
  O: range(801, 804),
  FLIP: range(101, 105),
  TRIAL: range(901, 920),
};
export type SetName = "N" | "D" | "H" | "E" | "E3" | "Q" | "O";
// 20 (e) 強さ: each set's amount, set from the trial seeds 901–920 and written to docs before the formal seeds
// run (SQ-28); null until then, and a formal-seed run of a set whose amount is null is refused
export const AMOUNTS: Record<"D" | "H" | "E" | "E3" | "Q", number | null> = { D: null, H: null, E: null, E3: null, Q: null };
// SQ-12: Q's item, named in docs with its amount; null until calibrated (the trial calibrates on SPEC.qItemTrial)
export const Q_ITEM: string | null = null;
// 20 (e) 共通: the first mid of each pair, in ticks (0.001 on the yen pairs, 0.00001 on the dollar pairs)
export const START_MID_TICKS: Record<Pair, number> = { "USD/JPY": 110000, "EUR/JPY": 125000, "AUD/JPY": 80000, "EUR/USD": 110000, "AUD/USD": 70000 };
// 20 (e) 共通: one minute's move (ticks) and the UTC hour's factor; while GMO is shut, 0.6
export const SIGMA_TICKS = { jpy: 10, usd: 6 } as const;
export const hourFactor = (h: number): number => (h <= 6 ? 0.8 : h <= 15 ? 1.2 : h <= 20 ? 1.0 : 0.6);
export const SHUT_FACTOR = 0.6;
// 20 (e) 共通: the share of 15-minute slots whose spread is the table's p90
export const P90_SHARE = 0.1;
// the made-up rates of the owner's way (ownerhold.ts walks, ownerhold-check.py SYNTH_RATES)
export const SYNTH_RATES = { US: 5.25, JP: 0.1, XM: 3.75, AU: 4.35 } as const;
// 20 (a): the real price bands (made-up: 0.25–2.5 × START_MID)
export const BANDS: Record<Pair, readonly [number, number]> = {
  "USD/JPY": [100, 200],
  "EUR/JPY": [100, 220],
  "AUD/JPY": [60, 140],
  "EUR/USD": [0.85, 1.45],
  "AUD/USD": [0.50, 0.90],
};
export const MADEUP_BAND = [0.25, 2.5] as const;
// 20 (a): Ask < Bid rows, per pair · interval · UTC year (SQ-29)
export const CROSSED_MAX = 0.001;

// ---- the ledger ------------------------------------------------------------------------------------

export const CANDIDATES = {
  path: "research/ledger/chartbest-candidates.json",
  sha256: "710814487a58f0228e70b2f7f15eae9d878b52701cf7f72d3a5ceb3bfffc5436",
} as const;
// written by hand in later steps (11, 12, 14); an empty constant: not yet
export const LEDGER = {
  counts: { path: "research/ledger/chartbest-counts.json", sha256: "" },
  choice: { path: "research/ledger/chartbest-choice.json", sha256: "" },
  stage2: { path: "research/ledger/chartbest-stage2.json", sha256: "" },
} as const;
export const SPREAD_HOURS = { path: "research/ledger/spread-hours.csv", sha256: "2b325574297a9891bc4760717ab3f6e3891d073725b01b46b0faa7b89605bb93" } as const;

// ---- SPEC: the spec questions' resolutions ---------------------------------------------------------

export const SPEC = {
  // SQ-01: the donchian target is 0 (defined) from bar 0; the first determined bar is bar 0
  donchianTargetFromBar0: true,
  // SQ-02: the flip compares the blind table exactly except the two kinds of counted exceptions
  flipExceptions: "halfTickE+exactTouch",
  // SQ-37: a symmetric item's signals inside a stretch whose onset is a one-tick tie are counted apart ("strict": none)
  flipItemTies: "tieOnsetExcepted" as "tieOnsetExcepted" | "strict",
  // SQ-03: fewer than 10 four-week blocks drops the 4-week candidate only (the shift stays)
  fewBlocksDropsOnly4w: true,
  // SQ-04: C counts the clusters that receive a term of the sum (used strata)
  clustersFromUsedStrata: true,
  // SQ-05: stage 0's "no blind" counts signals whose stratum has no blind-table bar
  stage0NoBlindByRows: true,
  // SQ-06: the reproduction 20 (c) is rehearsed on made-up files (macdx walk, ownerhold synthetic)
  reproOnMadeUp: "rehearse",
  // SQ-08: the owner-hold sentence conventions
  holdTextVersion: 1,
  // SQ-09: a made-up minute: one latent step, O = the previous written mid, C = this one
  minuteBar: "oneStepOC",
  // SQ-10: light runs for the sets (5-minute files only, no look-ahead, no owner's way)
  lightRuns: true,
  // SQ-11: set O re-sets donchian-A20's direction from the newest bar closed by T + 60 min; equal: none
  answerKnowing: "newestBy+60m,equal=none",
  // SQ-12: Q is calibrated on this item in the trial
  qItemTrial: "donchian-A20",
  // SQ-15: 13's 0% / 100% as printed (one decimal)
  zeroHundredPrinted: true,
  // SQ-16: the blind's whole-half rows for 13 are its BUY row and its SELL row (Δ conditions not applied)
  blindSuspectRows: "byDirection",
  // SQ-17: the rows of いつも添える文
  alwaysRows: "items+emails+blindByDirection",
  // SQ-18: the projection's df: the kind most chosen in N's first halves, C from the real second half
  projectionDf: "modeKindRealH2C",
  // SQ-19: the non-overlapping version by the TP10 trade's exit
  nonOverlap: "tp10Exit",
  // SQ-20: W_h = the weeks holding blind-table bars of the half
  weeksOfHalf: "blindBars",
  // SQ-21: the wide-spread slot of the instant T
  wideSlotOf: "T",
  // SQ-22: a late ULTRA signal is outside the measure's 全部の合図
  lateOutsideAll: true,
  // SQ-23: the cut points before τ (NY 17:00) and the item's own day bounds
  cutDayBounds: "tau+own",
  // SQ-25: only H counts the suspicious signal without stopping
  suspicionCountsOnly: ["H"] as readonly string[],
  // SQ-26: D's tooth on the first half
  dToothHalf: "H1",
  // SQ-27: the second-half account selects by T
  h2AccountBy: "T",
  // SQ-29: crossed rows per pair · interval · UTC year, over rows read
  crossedShareBy: "pairIntervalUtcYear",
  // SQ-30
  shiftRank: "strictBelow+1",
  winPlInterval: "tfWinrate1.96",
  medianOf: "moneyStats",
  names: "ids",
  holdPctDigits: 2,
  calibStat: "mean",
  genStreams: 1,
  // SQ-31: 13's "100 resolved" counts the row's TP10 trades
  suspectResolvedBy: "tp10",
  // SQ-32: the minus sign of the sentences
  minusSign: "\u2212",
  // SQ-33: the sentences' unfixed words
  textVersion: 1,
} as const;

// ---- 3: the 59 items in their table order ------------------------------------------------------------

export interface ItemRow {
  id: string;
  order: number;
  group: Group;
  // the candidate of 18 (C1 … C41, K1 … K3): items of one candidate are always one overlap group (11)
  candidate: string;
  implemented: boolean;
}
const CHART_IDS: Array<[string, string]> = [
  ["donchian-A20", "C1"], ["donchian-A55", "C1"], ["round-A", "C2"], ["round-B", "C2"], ["hs", "C3"],
  ["pivot-A", "C4"], ["pivot-B", "C4"], ["heikin-A", "C5"], ["heikin-B", "C5"], ["asia", "C6"],
  ["orb-lon", "C7"], ["orb-ny", "C7"], ["orb-tok", "C7"], ["noise", "C8"], ["td9", "C9"], ["td13", "C9"],
  ["star", "C10"], ["fib618", "C11"], ["flag", "C12"], ["nr7", "C13"], ["idnr4", "C13"], ["double7", "C14"],
  ["cci", "C15"], ["ibs", "C16"], ["bigmove", "C17"], ["outside3", "C18"], ["rsi2", "C19"], ["linreg", "C20"],
  ["vortex", "C21"], ["crsi", "C22"], ["ttm", "C23"], ["kama-A", "C24"], ["kama-B", "C24"], ["pinbar", "C25"],
  ["vr", "C26"], ["hurst", "C27"], ["pnf", "C28"], ["dualthrust", "C29"], ["cam-A", "C30"], ["cam-B", "C30"],
  ["renko", "C31"], ["tlb", "C32"], ["kagi", "C33"], ["soldiers", "C34"], ["fisher", "C35"], ["demarker", "C36"],
  ["psych", "C37"], ["knn", "C38"], ["logit", "C38"], ["kairi", "C39"], ["ob", "C40"], ["wyckoff", "C41"],
];
const CAL_IDS: Array<[string, string]> = [
  ["breedon-1", "K1"], ["breedon-2", "K1"], ["fix-A1", "K2"], ["fix-A2", "K2"], ["fix-B1", "K2"], ["fix-B2", "K2"], ["gap", "K3"],
];
// the items step 2 builds (22 の 2)
export const TRIAL_ITEMS: readonly string[] = ["donchian-A20", "donchian-A55", "breedon-1", "breedon-2"];
export const ITEM_TABLE: readonly ItemRow[] = [
  ...CHART_IDS.map(([id, candidate], order) => ({ id, order, group: "chart" as Group, candidate, implemented: TRIAL_ITEMS.includes(id) })),
  ...CAL_IDS.map(([id, candidate], k) => ({ id, order: CHART_IDS.length + k, group: "cal" as Group, candidate, implemented: TRIAL_ITEMS.includes(id) })),
];
export const orderOf = (id: string): number => {
  const r = ITEM_TABLE.find((x) => x.id === id);
  if (!r) throw new Error(`${id}: not one of the 59 items`);
  return r.order;
};
// 11: the ledger's ⑨ groups (always one group, among floor-passing items)
export const LEDGER_GROUPS: ReadonlyArray<readonly string[]> = [
  ["rsi2", "crsi", "double7"],
  ["vr", "hurst"],
  ["pinbar", "wyckoff", "round-A"],
  ["donchian-A20", "donchian-A55", "dualthrust", "orb-lon", "orb-ny", "orb-tok", "noise", "asia", "tlb", "kagi", "pnf", "flag"],
  ["heikin-A", "heikin-B", "renko"],
  ["fix-A2", "breedon-2"],
];
// 3: kama-A and kama-B are one item when counted (12, 21)
export const ALIASES: ReadonlyArray<readonly string[]> = [["kama-A", "kama-B"]];

// ---- the measures (10) ----------------------------------------------------------------------------

export const MEASURES = ["ultra5", "macdx5"] as const;
export type MeasureId = (typeof MEASURES)[number];
export const MEASURE_NAMES: Record<MeasureId, string> = { ultra5: "ULTRA 5分足", macdx5: "MACD の山・谷" };
// the order sources are listed in (dumps, sentences): the items in table order, then ULTRA, then MACD
export const srcOrder = (src: string): number =>
  src === "ultra5" ? 1000 : src === "macdx5" ? 1001 : orderOf(src);
