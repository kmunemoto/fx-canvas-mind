// 法則探し (docs §8.136, research/lawsearch-spec.md): the rule constants the modules share, beyond the frozen dates,
// pairs and sha256 of research/lawsearch-const.ts (which is not edited). Values only, each with the spec's place;
// no function. Every value here is the spec's; none was chosen from data (none has been read).

import { MINUTE } from "./lib.ts";
import type { CandStatus, ReasonCode, TfKey } from "./lawsearch-types.ts";

// ---- codes ---------------------------------------------------------------------------------------------------

// Classified.reason and the dumps' reason column use these indices (lawsearch-dump.md 7)
export const REASONS: readonly ReasonCode[] = ["counted", "f_none", "both", "r1", "r1w", "r1b", "r2", "r3", "r4", "r5", "r6"];
// Candidates.status
export const STATUS: readonly CandStatus[] = ["emit", "f_none", "both"];

// ---- the trial (spec 19 step 3) --------------------------------------------------------------------------------

// the twelve trials of the small trial, in table order
export const TRIAL_STEP3: readonly string[] = [
  "m15.E04.F00",
  "m15.E04.F01",
  "m15.E26.F00",
  "m15.E26.F01",
  "m15.S01",
  "m15.B06",
  "h1.E04.F00",
  "h1.E04.F01",
  "h1.E26.F00",
  "h1.E26.F01",
  "h1.S01",
  "h1.B06",
];

// ---- spec 2, 6 -------------------------------------------------------------------------------------------------

// 6 ③: a hole is this many adjacent open slots without the pair's bar; the window is [s_{i−9}, T_i); a slot is
// open when at least this many of the five pairs have a bar
export const HOLE_MIN_SLOTS: Readonly<Record<TfKey, number>> = { m15: 2, h1: 1 };
export const R3_BACK = 9;
export const OPEN_MIN_PAIRS = 3;
// 2 / 6 ②: the three minutes ② looks at (T, T + 1 min, T + 3 min)
export const R2_MINUTES: readonly number[] = [0, 1, 3];
// 8.8: the late entry's delay
export const LATE_MS = 15 * MINUTE;
// 15: the price bands (real data) and the synthetic band (times the walk's start)
export const PRICE_BAND: Readonly<Record<string, readonly [number, number]>> = {
  "USD/JPY": [100, 200],
  "EUR/JPY": [100, 220],
  "AUD/JPY": [60, 140],
  "EUR/USD": [0.85, 1.45],
  "AUD/USD": [0.5, 0.9],
};
export const SYN_BAND: readonly [number, number] = [0.25, 2.5];
// 15: Ask < Bid rows at most this share per pair, timeframe and year
export const ASK_LT_BID_MAX = 0.001;
// 2: a raw side value farther than this from a whole number of points stops the run
export const POINT_TOL = 1e-6;

// ---- spec 4, 5 -------------------------------------------------------------------------------------------------

// 4.3: the S rows and their F
export const S_OF_F: Readonly<Record<string, string>> = { S01: "F01", S02: "F02", S03: "F05", S04: "F07" };
// 4.2: the F with a direction
export const DIRECTIONAL_F: readonly string[] = ["F01", "F01r", "F02", "F02r", "F05", "F05r", "F07", "F07r"];
// 4.2: the F order of the table
export const F_ORDER: readonly string[] = ["F00", "F01", "F01r", "F02", "F02r", "F03", "F03r", "F04", "F04r", "F05", "F05r", "F06", "F06b", "F07", "F07r"];
// 9: the fixed overlap groups (besides "the 15 trials of one E are one group")
export const FIXED_E_GROUPS: ReadonlyArray<readonly string[]> = [
  ["E01", "E02", "E03", "E04", "E05", "E06"],
  ["E07", "E08", "E09"],
  ["E10", "E11"],
  ["E13", "E14", "E15"],
  ["E16", "E17", "E18"],
  ["E19", "E20", "E21"],
  ["E22", "E23"],
  ["E24", "E25", "E31"],
  ["E26", "E27"],
  ["E38", "E39"],
];
export const FIXED_B_GROUPS: ReadonlyArray<readonly string[]> = [["B07", "B10", "B03"], ["B13", "B14"], ["B01", "B02"]];

// ---- spec 1, 8, 9, 10, 11, 13 ----------------------------------------------------------------------------------

// 1: the 4-week blocks' w0 and the halves' weeks; 11 C6's two parts of the second half
export const W0 = { first: 2817, second: 2889 } as const;
export const HALF_WEEKS = { first: 72, second: 76 } as const;
export const C6_PARTS: readonly (readonly [number, number])[] = [[2889, 2926], [2927, 2964]];
// 8.5: |x| < 1e−12 is 0 (8's numbers only); the 4-week candidate needs this many blocks
export const ZERO = 1e-12;
export const FOUR_WEEK_MIN_C = 10;
// 9: the floor
export const FLOOR_SIGNALS = 300;
export const FLOOR_WEEKS = 30;
// 9: the overlap share, and the mark (通る最小の差 at or above the suspicion line)
export const OVERLAP_SHARE = 0.5;
export const MARK_PASS_MIN = 8;
// 10: chosen per timeframe; 11: the family's one-sided level; 10 説明: BH's q
export const PER_TF = 3;
export const ALPHA = 0.025;
export const BH_Q = 0.1;
// 11 C2 / C3: a direction or pair is looked at with at least this many counted signals; C3 needs this many pairs
export const C_MIN_N = 30;
export const C3_MIN_PAIRS = 3;
// 13: rows with at least minN counted signals; the lines
export const SUSPECT = { minN: 100, delta: 8, a: 10, plFrac: 0.15, late: 4 } as const;
// 22: the owner's answers (question 4 chosen by Claude, 22 4)
export const QUESTIONS = { q1: 8, q2: "b", q3: "a", q4: "a", q5: "a" } as const;

// ---- spec 15 ----------------------------------------------------------------------------------------------------

export const SEEDS = { cut: 318, poison: 319, poison1000: 419 } as const;
export const CUT_SAMPLE = 3000;
export const CUT_EVEN = 300;
export const CUT_GAP_BARS = 10;
export const CUT_DAY_BARS = 2;
export const CUT_HTF_BARS = 2;
// spec 23.2 (2026-11-05): stage 0 keeps this many of the higher-timeframe boundary targets per timeframe and pair,
// evenly picked in time order (the j-th is floor(j (n − 1) ÷ 299); all when n ≤ 300); stage 1's chosen trials are
// cut on every one of the first half at the end of stage 1, and stage 2 on every one of the second half
export const CUT_HTF_STAGE0 = 300;
export const POISON_N = 100;
export const POISON_1000 = 1000;
export const POISON_PIPS = 777.7;
export const FOLLOW_BACK = 300;

// ---- spec 14.2: the sets' seeds (inclusive) -------------------------------------------------------------------

export const SET_SEEDS = {
  trialCalib: [901, 920],
  N: [1001, 1100],
  calibKappa: [1101, 1500],
  D: [2001, 2030],
  H: [3001, 3030],
  E15: [4001, 4010],
  E1h: [4101, 4110],
  EF: [4201, 4210],
  Q: [5001, 5010],
  O: [6001, 6004],
  flip: [1001, 1005],
} as const;
// the small trial's own walks (lawsearch-design.md 9): outside every range above, never a formal run
export const TRIAL_SEEDS = { smoke: [7001, 7004], holes: [7101, 7101] } as const;

// ---- spec 16: the planted errors (LS_PLANT / --plant names; lawsearch-design.md 5) ---------------------------

export const PLANTS: readonly string[] = [
  "htfOpen",
  "entryAtSignalClose",
  "entryEarly",
  "exitLate",
  "noSubstituteExit",
  "reasonUsesFuture",
  "blindNoHour",
  "noBlind",
  "inflStratumMean",
  "midHalfEven",
  "pointsTrunc",
  "smaNewestFirst",
  "noRisingEdge",
  "noHolm",
  "iutOneLeg",
  "c4PointOnly",
  "noEx1Week",
  "noDF",
  "splitShift",
  "avoidFull",
  "secondHalfAll",
  "shiftNoWrap",
  "daySatSplit",
  // C3 (2026-11-05), run plants of design 8 on CMP-N 1001 / CMP-C 7101: a trial's second-half blind strata dropped
  // (stage 0's noBlind stop, D4); a blind row reported as hit at stage 1 (spec 13's stop, D10); a failing bar planted in
  // cut.chosen.first on the first chosen trial (the stop before stage 2, D8)
  "dropSecondStrata",
  "blindRowHit",
  "chosenCutFirstDiff",
  // C4c (2026-11-07), run plants on CMP-C 7101 (C4b's review, finding 1): a look-ahead in spec 5's per-bar loop that
  // carries state across bars and reads the series' end (on the last bar, a raw signal is dropped when the last row
  // emitted before it is exactly 3, or 5, bars back); the cut check must fail (lawsearch-events.ts candidatesOf)
  "lastBarStateG3",
  "lastBarStateG5",
  // C4d (2026-11-07), a run plant on CMP-C 7101 (C4c's review, M5/M6, the refuter's R1): the same kind of look-ahead
  // on B06's path: per direction, B06's raw signals counted from bar 0; on the series' last bar a raw B06 signal is
  // dropped when that count is odd; the cut check must fail on m15.B06 or h1.B06 (B06 is now cut on its prefix from
  // bar 0, no longer on a 291-bar window; lawsearch-events.ts candidatesOf, lawsearch-checks.ts cutGotAt)
  "carriedCountB06",
  // C4e (2026-11-08), run plants on CMP-C 7101: carriedCountS01 (the lead's G4 on C4d's review) is carriedCountB06's
  // look-ahead on S01's trials, so that a run plant reaches the S path; the cut check must fail on m15.S01 or h1.S01.
  // bufferReadE04 (the lead's G1; the reviewer's P5, the refuter's q1): on E04's trials a raw signal is dropped by the
  // next close read through the close array's memory block, not by index; the cut check must fail on an E04 trial
  // now that every check series holds its own bars only (lawsearch-bars.ts copyOf; lawsearch-events.ts candidatesOf)
  "carriedCountS01",
  "bufferReadE04",
  // C4f (2026-11-08), run plants (the lead's H4 on C4e's review: look-aheads kept where the checks used to read the main
  // run's objects; lawsearch-events.ts candidatesOf and reasonOf): seriesStashE04 (the next close's sign written into
  // the series' own fileKey: the universe detector stops the run, exit 6), trialStashE04 (the next closes kept on the
  // TrialDef object: the frozen TrialDef throws, exit 1) and avoidStashR3 (③ on the window after T, kept in the avoid
  // table: the read-only table throws, exit 1), each on CMP-C 7101; and (the lead's H8) chosenCutSecondDiff, a failing
  // bar planted in cut.chosen.second on the first chosen trial, on CMP-N 1001 (stage 2's numbers withheld, exit 3)
  "seriesStashE04",
  "trialStashE04",
  "avoidStashR3",
  "chosenCutSecondDiff",
];
