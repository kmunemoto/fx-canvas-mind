// Which snapshots may be used for which stage, and how a pair of raw answers
// becomes a pair of comparable verdicts.
//
// PURE, ZERO IMPORTS. Every rule that decides what may be measured lives here
// so that it can be exercised without a database, a model call or a Deno
// runtime — and so that the rules are readable in one place instead of being
// spread through a runner as `if` statements next to the code that spends money.
//
// ===========================================================================
// THE TWO STAGES, AND WHY THEY ARE NOT ONE
// ===========================================================================
//
// The candidate rulebook was written BY the postmortem FROM lessons derived
// from the very trades whose snapshots are sitting in public.analyses.
// Measured 2026-09-10 in production: `candidate->>'lessons_considered'` is 60,
// which is `RECENT_LESSONS` in supabase/functions/postmortem/index.ts — a cap
// on the newest lessons, not the whole table (there were 75 lessons at the
// freeze instant and 78 today). Of the 78 lessons, 60 are about analyses that
// also have a stored prompt in public.analysis_prompts. So the corpus a replay
// draws from and the corpus the candidate was fitted on are substantially the
// same rows.
//
// STAGE A — MATERIALITY. Replay a snapshot under both books and count how often
// the two answers differ. It touches no outcome, so no outcome can leak into
// it. What it can conclude is only this: whether swapping the book changes the
// analyst's answer more often than the analyst changes its own answer with
// nothing swapped. That is a SCREENING TEST. It says whether a forward
// evaluation is worth paying for. IT IS NOT A PERFORMANCE CLAIM AND MUST NEVER
// BE WRITTEN UP AS ONE: a book that changes every answer for the worse would
// score maximally material.
//
// STAGE B — PERFORMANCE. Score both arms against what the market actually did
// afterwards. Admissible ONLY on snapshots created strictly after the freeze,
// because for those the candidate is a prediction rather than a fit. On an
// older snapshot the candidate had already read the lesson written about that
// very trade, and any advantage it shows is the fit it was given, not skill.
// `eligibleForStage` below is that rule; the PostgREST filter in index.ts is
// the same rule again, and the trigger in the migration is a third time.
//
// THOSE THREE ALL SIT ON THE PATH THAT CREATES A RUN. The path that emits a
// number reads its row list out of the run header's `notes`, which the trigger
// deliberately does not watch, so index.ts asks this function a FOURTH time in
// report mode, over the rows about to be scored, before any outcome is read.
// Four locks, because this is the one door through which a meaningless number
// could walk out looking like evidence.

export type Stage = "materiality" | "performance";
export type Arm = "live" | "candidate";

// The projection metric.ts calls `published_proxy`: the confidence floor only,
// applied to the model's own signal. This module never computes it — the
// caller passes the result of `publishedProxy` from
// supabase/functions/noise-floor/metric.ts, so that #64's floor and #65's cells
// are produced by one function and not by two that could drift.
export type Verdict = "traded" | "waited";

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

export type Eligibility =
  | { ok: true }
  | { ok: false; reason: EligibilityRefusal };

export type EligibilityRefusal =
  // The snapshot predates the freeze. Stage B only.
  | "snapshot_predates_freeze"
  // The snapshot is outside the frozen population cut. Both stages: a row that
  // arrived after the cut would move the denominator mid-run.
  | "snapshot_after_population_cut"
  // A timestamp that will not parse. Never treated as "probably fine".
  | "timestamp_unreadable";

const ms = (iso: string): number | null => {
  if (typeof iso !== "string" || iso.length === 0) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

// STRICTLY AFTER, not at-or-after. A snapshot written in the same millisecond
// as the freeze is a snapshot whose position relative to the freeze cannot be
// established from the record, and the safe reading of "cannot establish" is
// "not admissible". The cost is at most a handful of rows; the cost of the
// other direction is a leaked row inside a forward-only claim.
//
// KNOWN PRECISION ASYMMETRY, and it fails in the safe direction. `Date.parse`
// resolves to the millisecond; Postgres compares `created_at` at the
// microsecond. A row written in the same millisecond as the freeze but a later
// microsecond therefore passes the PostgREST filter and fails this function —
// and index.ts turns any disagreement between the two into a refusal of the
// whole run, not a choice between them. So the residual is a run that refuses
// rather than a row that leaks, which is the only direction worth having.
export function eligibleForStage(input: {
  stage: Stage;
  snapshotCreatedAt: string;
  freezeFrozenAt: string;
  populationFrozenAt: string;
}): Eligibility {
  const snapshot = ms(input.snapshotCreatedAt);
  const freeze = ms(input.freezeFrozenAt);
  const cut = ms(input.populationFrozenAt);
  if (snapshot === null || freeze === null || cut === null) {
    return { ok: false, reason: "timestamp_unreadable" };
  }
  if (snapshot > cut) return { ok: false, reason: "snapshot_after_population_cut" };
  if (input.stage === "performance" && snapshot <= freeze) {
    return { ok: false, reason: "snapshot_predates_freeze" };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// A pair of answers
// ---------------------------------------------------------------------------

export interface VerdictPair {
  analysisId: string;
  live: Verdict;
  candidate: Verdict;
  // Whether the two arms landed on different published decisions. This is the
  // whole of stage A's numerator.
  disagree: boolean;
}

// Both arms or nothing. A row whose candidate arm failed and whose live arm
// succeeded is NOT a row where the two agreed — it is a row with no pair, and
// entering it as agreement is the same "a read that failed is not zero" mistake
// the rest of this repository refuses. Rows lost this way are lost to transport
// and parse failures, which do not strike rows at random, so the lost rows are
// disproportionately the unstable ones and counting them as agreement biases
// the disagreement rate DOWN — the direction that makes a real change look
// immaterial and cancels the forward evaluation that would have caught it.
export function pairVerdicts(input: {
  analysisId: string;
  live: Verdict | null;
  candidate: Verdict | null;
}): VerdictPair | null {
  if (input.live === null || input.candidate === null) return null;
  return {
    analysisId: input.analysisId,
    live: input.live,
    candidate: input.candidate,
    disagree: input.live !== input.candidate,
  };
}

export interface MaterialityTally {
  // Pairs where both arms produced a projectable verdict.
  pairs: number;
  // Of those, how many disagreed.
  disagreements: number;
  // NaN over zero pairs, never 0. The rate of no pairs is not zero, and zero is
  // precisely the number a reader would take for "the two books agreed".
  rate: number;
}

export function tallyMateriality(pairs: ReadonlyArray<VerdictPair>): MaterialityTally {
  let disagreements = 0;
  for (const pair of pairs) if (pair.disagree) disagreements += 1;
  return {
    pairs: pairs.length,
    disagreements,
    rate: pairs.length === 0 ? Number.NaN : disagreements / pairs.length,
  };
}

// ---------------------------------------------------------------------------
// The stage A screen
// ---------------------------------------------------------------------------

export type MaterialityVerdict =
  // The observed disagreement is clearly above anything the same-version noise
  // floor can explain. The change is material; a forward evaluation is worth
  // paying for. IT SAYS NOTHING ABOUT WHICH BOOK IS BETTER.
  | "material"
  // The two intervals overlap. Nothing has been shown either way, and the
  // honest report is "not distinguishable from the analyst disagreeing with
  // itself", NOT "the same".
  | "indistinguishable"
  // The observed disagreement is clearly BELOW the floor, which is not a
  // finding about the rulebook: two arms cannot agree more than one arm agrees
  // with itself unless something about the instrument changed between #64 and
  // this run. Reported as a refusal to interpret rather than as "immaterial".
  | "below_floor_investigate";

// The comparison is BETWEEN INTERVALS, not between an interval and a point.
//
// The floor is itself an estimate: 10/48, p-hat-0 = 20.83%, Wilson 95%
// [11.73%, 34.26%] (docs/NOISE_FLOOR_PREREGISTRATION.md §12.2). Comparing this
// run's interval against the floor's POINT estimate would treat 20.83% as
// known, and the width of that interval — twenty-two percentage points — is the
// dominant uncertainty in the whole exercise. So "material" requires this run's
// lower bound to clear the floor's UPPER bound, which is the conservative
// reading and the one that cannot promote a book on the strength of a noisy
// floor measurement.
//
// This function takes the bounds as arguments rather than computing them: the
// interval method is Wilson, it lives in
// supabase/functions/noise-floor/metric.ts, and there is exactly one
// implementation of it in this repository on purpose.
export function screenMateriality(input: {
  observedLo: number;
  observedHi: number;
  floorLo: number;
  floorHi: number;
}): MaterialityVerdict {
  const { observedLo, observedHi, floorLo, floorHi } = input;
  for (const value of [observedLo, observedHi, floorLo, floorHi]) {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new RangeError(`screenMateriality: bounds must lie in [0, 1], got ${value}`);
    }
  }
  if (observedLo > floorHi) return "material";
  if (observedHi < floorLo) return "below_floor_investigate";
  return "indistinguishable";
}

// HOW BIG A CHANGE STAGE A CAN ACTUALLY SEE AT THIS n.
//
// `material` needs this run's Wilson LOWER bound to clear the floor's UPPER
// bound, and the floor's upper bound is high — 34.26% — because the floor was
// itself measured on only 48 rows. The consequence is easy to state and easy to
// miss: at 78 rows the observed disagreement must reach 35/78, about 45%,
// before the screen can fire at all. A candidate that changes a fifth of the
// analyst's answers will read `indistinguishable`, and `indistinguishable` is
// then read as "the candidate does nothing" when what it means is "this screen
// cannot see a change this size".
//
// So the number is COMPUTED AND REPORTED alongside the verdict, rather than
// left for a reader to derive. The direction of the conservatism is right — a
// non-overlap rule cannot falsely promote a book — which makes this a power
// disclosure and not a correctness fix, and exactly the kind of thing that goes
// unsaid unless it is put in the payload.
//
// The interval method is passed in rather than imported: this module has zero
// imports on purpose, and there is exactly one Wilson implementation in this
// repository (noise-floor/metric.ts). Returns null when no attainable count
// could clear the bound at this n.
export function smallestMaterialCount(input: {
  pairs: number;
  floorHi: number;
  wilsonLo: (k: number, n: number) => number;
}): { count: number; rate: number } | null {
  const { pairs, floorHi, wilsonLo } = input;
  if (!Number.isInteger(pairs) || pairs <= 0) return null;
  if (!Number.isFinite(floorHi) || floorHi < 0 || floorHi > 1) {
    throw new RangeError(`smallestMaterialCount: floorHi must lie in [0, 1], got ${floorHi}`);
  }
  for (let k = 0; k <= pairs; k += 1) {
    if (wilsonLo(k, pairs) > floorHi) return { count: k, rate: k / pairs };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Stage B: what the market actually did
// ---------------------------------------------------------------------------

// Which decision the market vindicated, for one snapshot.
//
// "trade_was_right" and "wait_was_right" are the only two answers, because the
// arms only ever produce `traded` or `waited`. Null means the row cannot be
// scored, and null is common: measured 2026-09-10 over the 78 rows with stored
// prompts, `analyses.outcome` is win 21, loss 14, skipped 41, pending 2 — and
// of the 44 rows carrying a `wait_check`, its verdict is correct 24, missed 11,
// no_call 6, unknown 3.
export type Truth = "trade_was_right" | "wait_was_right";

// WHERE THE TRUTH CAME FROM. Recorded per row and reported, never pooled
// silently, because the two sources are different counterfactuals measured by
// different code:
//
//   'outcome'    — production actually took the trade, and it settled win or
//                  loss (supabase/functions/track-outcomes). "trade_was_right"
//                  means this specific plan, at the levels this specific plan
//                  chose, made money.
//
//   'wait_check' — production waited, and track-outcomes/waits.ts graded the
//                  wait against the direction the plan declared: verdict
//                  'correct' means waiting was right, 'missed' means a trade in
//                  the declared direction would have run to target first.
//
// THE APPROXIMATION THIS RESTS ON, STATED RATHER THAN BURIED: an arm's verdict
// is only `traded` or `waited`. It carries no levels. Scoring `traded` as right
// therefore assumes the arm would have proposed a trade close enough to
// production's to share its fate. That assumption is UNVERIFIED and is
// certainly wrong in some rows — a candidate rule that widens the stop is
// exactly the sort of change that would alter the outcome without altering the
// decision. It is written down in docs/VERSION_COMPARISON.md as a limitation of
// stage B, and it is the reason stage B is described there as the weakest link
// of the design rather than as its conclusion.
export type TruthSource = "outcome" | "wait_check";

export interface ScoredTruth {
  truth: Truth;
  source: TruthSource;
}

export function truthFor(input: {
  outcome: string | null;
  waitVerdict: string | null;
}): ScoredTruth | null {
  // The settled trade comes first. When both are present the outcome is the
  // stronger evidence — it is what happened to a position that existed, while
  // wait_check is a reconstruction — and letting the weaker source win on rows
  // that have both would mix two scorers on one row with nothing recording it.
  if (input.outcome === "win") return { truth: "trade_was_right", source: "outcome" };
  if (input.outcome === "loss") return { truth: "wait_was_right", source: "outcome" };
  if (input.waitVerdict === "missed") return { truth: "trade_was_right", source: "wait_check" };
  if (input.waitVerdict === "correct") return { truth: "wait_was_right", source: "wait_check" };
  // 'untriggered', 'pending', 'skipped' with no readable wait verdict,
  // 'no_call', 'unknown', and anything this vocabulary has not met yet. All of
  // them mean the market did not answer the question, which is not the same as
  // the market answering "wait".
  return null;
}

export const armWasRight = (verdict: Verdict, truth: Truth): boolean =>
  truth === "trade_was_right" ? verdict === "traded" : verdict === "waited";

export interface PerformanceTally {
  // Pairs that had both arms AND a readable truth.
  pairs: number;
  // The 2x2. `b` and `c` are the discordant cells the exact test consumes.
  bothRight: number;
  bothWrong: number;
  // live right, candidate wrong.
  b: number;
  // live wrong, candidate right.
  c: number;
  // How many scored pairs came from each source, so a report can say whether
  // the answer rests mostly on settled trades or mostly on reconstructed waits.
  fromOutcome: number;
  fromWaitCheck: number;
  // THE DISCORDANT CELLS SPLIT BY SOURCE, and not only their totals.
  //
  // The p-value is computed on pooled b and c. That pooling is only honest if
  // the two sources are interchangeable, and they are not: `outcome` exists
  // only on rows production TRADED and `wait_check` only on rows it WAITED, so
  // the source is correlated with the live arm's own verdict. A candidate that
  // shifts decisions systematically in one direction will therefore draw
  // almost all of its discordant pairs from one source, and the p-value would
  // then rest on that source's calibration rather than on the rulebook.
  //
  // Four integers make that visible and let a reader re-run the test inside
  // each source. Without them the pooled result cannot be checked at all — the
  // composition is not recoverable from b and c after the fact.
  bFromOutcome: number;
  cFromOutcome: number;
  bFromWaitCheck: number;
  cFromWaitCheck: number;
  // Pairs that had both arms but no readable truth. Reported, never dropped in
  // silence: a stage B run that replayed sixty rows and could score four of
  // them has not measured sixty rows.
  unscorable: number;
}

export function tallyPerformance(
  rows: ReadonlyArray<{ pair: VerdictPair; truth: ScoredTruth | null }>,
): PerformanceTally {
  const tally: PerformanceTally = {
    pairs: 0,
    bothRight: 0,
    bothWrong: 0,
    b: 0,
    c: 0,
    fromOutcome: 0,
    fromWaitCheck: 0,
    bFromOutcome: 0,
    cFromOutcome: 0,
    bFromWaitCheck: 0,
    cFromWaitCheck: 0,
    unscorable: 0,
  };
  for (const row of rows) {
    if (row.truth === null) {
      tally.unscorable += 1;
      continue;
    }
    tally.pairs += 1;
    const fromOutcome = row.truth.source === "outcome";
    if (fromOutcome) tally.fromOutcome += 1;
    else tally.fromWaitCheck += 1;

    const liveRight = armWasRight(row.pair.live, row.truth.truth);
    const candidateRight = armWasRight(row.pair.candidate, row.truth.truth);
    if (liveRight && candidateRight) tally.bothRight += 1;
    else if (!liveRight && !candidateRight) tally.bothWrong += 1;
    else if (liveRight) {
      tally.b += 1;
      if (fromOutcome) tally.bFromOutcome += 1;
      else tally.bFromWaitCheck += 1;
    } else {
      tally.c += 1;
      if (fromOutcome) tally.cFromOutcome += 1;
      else tally.cFromWaitCheck += 1;
    }
  }
  return tally;
}
