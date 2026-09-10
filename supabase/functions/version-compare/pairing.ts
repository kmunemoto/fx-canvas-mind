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
// ===========================================================================
// THE THIRD ARM, AND WHY THE FLOOR IS NO LONGER A BORROWED CONSTANT
// ===========================================================================
//
// "more often than the analyst changes its own answer with nothing swapped"
// needs a number for the second half of that sentence. Until now it was a
// constant carried over from #64: 10/48, 20.83%. That number was measured by
// replaying the STORED prompt bytes, whose rules block was rendered RANKED and
// carried a per-rule marker computed against the market of that minute. This
// harness cannot render the candidate's rules with those markers, so BOTH of
// its arms are re-rendered WITHOUT them — which means the rate stage A
// measures and the floor it was compared against came from two different
// prompt shapes. docs/VERSION_COMPARISON.md 5 already recorded that the
// unranked floor was UNVERIFIED and plausibly HIGHER, and that both directions
// of that error push toward promoting a rulebook.
//
// So the floor is measured instead of assumed, on the same rows, the same
// rendering and the same day, by replaying the frozen LIVE book a second time:
//
//   arm 'live'      — the frozen live book, re-rendered unranked (the reference)
//   arm 'candidate' — the frozen candidate book, re-rendered unranked
//   arm 'live_b'    — the frozen LIVE book AGAIN, byte-identical to 'live'
//
// Per row that yields two binary observations:
//
//   D_cand(i) = 1 if candidate disagrees with live on row i
//   D_ctrl(i) = 1 if live_b    disagrees with live on row i
//
// D_ctrl is one book's self-disagreement under THIS rendering. It is the
// floor. The question stage A now answers is:
//
//   does swapping the rulebook change the answer MORE than merely resampling
//   the same rulebook does?
//
// THE TWO OBSERVATIONS ARE PAIRED — same row, same market, same question — so
// the test is McNemar on the pair, and the discordant counts are defined once,
// here, in the names of the fields that carry them:
//
//   b = rows where the CONTROL disagreed and the candidate did not
//   c = rows where the CANDIDATE disagreed and the control did not
//
// c > b is the material direction. An inverted b and c reverses the verdict,
// which is why the orientation is a named field rather than a positional
// argument and why src/test/version-compare.test.ts pins it with a case that
// would fail if the two were swapped.
//
// THE STRUCTURAL ASYMMETRY, STATED RATHER THAN LEFT TO BE ASSUMED: the arm
// 'live' appears in BOTH comparisons, so D_cand and D_ctrl are correlated
// through a shared arm — a row on which the live arm happened to answer
// unusually raises the chance of both disagreements at once. That correlation
// is exactly what pairing accounts for, and it is why the two rates must never
// be compared as if they were two independent samples. It also means the
// discordant rate is LOWER than two independent Bernoulli draws would give,
// which is the direction that makes the sample-size arithmetic in mcnemar.ts
// conservative rather than optimistic. See `nullDiscordantRate` there.
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

// 'live_b' is the CONTROL: the same frozen live book, sent again as a
// byte-identical request. It is a third arm and not a second run of the first
// one, because it has to be claimed, budgeted and paired like any other cell —
// a control that lived outside the cell table could not be shown to have asked
// the same question.
export type Arm = "live" | "candidate" | "live_b";

// The order cells are created in, and the ONE place the arm count lives. Every
// piece of arithmetic that used to say `rows * 2` says `rows * ARM_COUNT`
// instead, so adding or removing an arm cannot leave a budget, an
// `expected_cells` or a progress line behind on the old number.
export const ARMS: readonly Arm[] = ["live", "candidate", "live_b"];
export const ARM_COUNT = ARMS.length;

// Which pairs of arms must send the SAME rules block and which must send
// different ones. 'live' and 'live_b' are the same book by construction — if
// their rules digests differ, the control is not a control and the floor it
// measures is not a floor. Every other pair must differ, or the cell that
// carries it is not a comparison.
export const armsShareTheSameBook = (a: Arm, b: Arm): boolean =>
  (a === "live" || a === "live_b") && (b === "live" || b === "live_b");

// ---------------------------------------------------------------------------
// The order a row's three arms are SENT in, and why it is not the order they
// are declared in
// ---------------------------------------------------------------------------
//
// THE PROBLEM THIS SOLVES IS A TIME CONFOUND, NOT A BYTE ONE. `live` and
// `live_b` are byte-identical by construction (index.ts hands the control arm
// the same rendered string, not a second render). What is NOT identical is
// WHEN each comparison is made. A chained run buys about one billable cell per
// hop, so the three cells of a row land at three separate instants. Sent in
// the declared order, every row would measure D_cand across one interval and
// D_ctrl across two — the control comparison always the wider-spaced of the
// pair, on every row, never the other way round.
//
// Any drift in the serving path over that window — routing, load, a rolling
// deployment — would then inflate D_ctrl relative to D_cand SYSTEMATICALLY.
// The direction is the conservative one (a bigger floor makes `material`
// harder to reach and asks for more rows), but a bias that is always present
// and never randomised is not something a floor measurement should carry, and
// it would land in the payload under the label "THE MEASURED FLOOR".
//
// So the order is a permutation of the three arms chosen per row. Over the six
// orderings of three arms the expected separation is the same for both
// comparisons: relabelling 'candidate' and 'live_b' maps the set of six onto
// itself, and both lags are symmetric in that relabelling, so their sums over
// the six orders are equal (8 and 8 — the test writes them out). A per-row
// draw therefore cancels a linear drift instead of accumulating it.
//
// DETERMINISTIC, NOT RANDOM, and that is not a compromise — it is required.
// The three cells of a row are claimed across separate invocations hours
// apart, and each invocation rebuilds the pending list from scratch. An order
// drawn from a random source would differ between hops, which is harmless for
// the cells already bought but makes the run's behaviour unreproducible from
// its record. Hashing (run_id, analysis_id) gives one order per row that every
// hop of that run agrees on and that a reader can recompute from the two ids
// the cell table already stores.
//
// The permutations are WRITTEN OUT rather than generated, for the reason the
// critical values in mcnemar.ts are: a reader checking that both lags sum to
// the same number should be able to do it by looking, not by running a
// factorial.
export const ARM_ORDERS: readonly (readonly Arm[])[] = [
  ["live", "candidate", "live_b"],
  ["live", "live_b", "candidate"],
  ["candidate", "live", "live_b"],
  ["candidate", "live_b", "live"],
  ["live_b", "live", "candidate"],
  ["live_b", "candidate", "live"],
];

// FNV-1a, 32-bit. Chosen because it is four lines of integer arithmetic with
// no imports — this module reaches nothing — and because the only property
// needed is that it spreads two hex ids across six buckets without caring
// which. It is NOT a cryptographic choice and nothing security-bearing rests
// on it: an adversary who could pick analysis ids could at most choose the
// order their own row's arms are sent in, which changes no measurement.
const fnv1a32 = (text: string): number => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
};

// The '#' is a separator, not decoration: without it the pair
// (run "ab", row "c") and the pair (run "a", row "bc") would hash alike, and
// two different rows of one run could then be forced to share an order by an
// id chosen to collide. It costs one character.
export function armOrderForRow(runId: string, analysisId: string): readonly Arm[] {
  return ARM_ORDERS[fnv1a32(`${runId}#${analysisId}`) % ARM_ORDERS.length];
}

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
// The three arms of one row, and the two paired observations they yield
// ---------------------------------------------------------------------------

export interface ArmTriad {
  analysisId: string;
  live: Verdict;
  candidate: Verdict;
  liveB: Verdict;
  // D_cand: the candidate arm landed on a different published decision from
  // the live arm.
  candidateDisagrees: boolean;
  // D_ctrl: the SECOND LIVE arm landed on a different published decision from
  // the first one. Same book, same bytes, different sample. This is the floor.
  controlDisagrees: boolean;
}

// ALL THREE ARMS OR NOTHING, for `pairVerdicts`'s reason carried one arm
// further. A row whose control arm failed is not a row where the analyst
// agreed with itself; it is a row with no control, and entering it as
// agreement would push the measured floor DOWN — which makes the candidate's
// disagreement look larger by comparison, which is the direction that promotes
// a rulebook. Transport and parse failures do not strike rows at random, so
// the rows lost this way are disproportionately the unstable ones and the bias
// is not a wash.
export function tripleVerdicts(input: {
  analysisId: string;
  live: Verdict | null;
  candidate: Verdict | null;
  liveB: Verdict | null;
}): ArmTriad | null {
  if (input.live === null || input.candidate === null || input.liveB === null) return null;
  return {
    analysisId: input.analysisId,
    live: input.live,
    candidate: input.candidate,
    liveB: input.liveB,
    candidateDisagrees: input.candidate !== input.live,
    controlDisagrees: input.liveB !== input.live,
  };
}

export interface ControlTally {
  // Rows on which all three arms produced a projectable verdict.
  rows: number;
  // The two raw counts. Each is a count over `rows`, so the two rates share a
  // denominator and are directly comparable — which they are NOT if one of
  // them is quietly measured over a different set of rows.
  candidateDisagreements: number;
  controlDisagreements: number;
  candidateRate: number;
  // THE MEASURED FLOOR. Same rows, same rendering, same day.
  controlRate: number;

  // The paired 2x2 over the two disagreement indicators. `b` and `c` are the
  // only cells the exact test can see; the concordant two are reported because
  // a reader cannot reconstruct them from b, c and the rates alone.
  bothDisagree: number;
  neitherDisagrees: number;
  // b — THE CONTROL disagreed and the candidate did NOT.
  b: number;
  // c — THE CANDIDATE disagreed and the control did NOT. c > b is the material
  // direction: swapping the book moved the answer on rows where resampling the
  // same book did not.
  c: number;
}

// NaN over zero rows, never 0, for `tallyMateriality`'s reason: the rate of no
// rows is not zero, and zero is precisely the number a reader would take for
// "the analyst never disagreed with itself" — i.e. a perfect instrument.
export function tallyAgainstControl(rows: ReadonlyArray<ArmTriad>): ControlTally {
  let candidateDisagreements = 0;
  let controlDisagreements = 0;
  let bothDisagree = 0;
  let neitherDisagrees = 0;
  let b = 0;
  let c = 0;
  for (const row of rows) {
    if (row.candidateDisagrees) candidateDisagreements += 1;
    if (row.controlDisagrees) controlDisagreements += 1;
    if (row.candidateDisagrees && row.controlDisagrees) bothDisagree += 1;
    else if (!row.candidateDisagrees && !row.controlDisagrees) neitherDisagrees += 1;
    else if (row.controlDisagrees) b += 1;
    else c += 1;
  }
  return {
    rows: rows.length,
    candidateDisagreements,
    controlDisagreements,
    candidateRate: rows.length === 0 ? Number.NaN : candidateDisagreements / rows.length,
    controlRate: rows.length === 0 ? Number.NaN : controlDisagreements / rows.length,
    bothDisagree,
    neitherDisagrees,
    b,
    c,
  };
}

// The control arm scored the way stage B scores the candidate: a
// `VerdictPair` whose second member is the SECOND LIVE ARM rather than the
// candidate. Feeding these to `tallyPerformance` gives the discordant counts a
// book earns against ITSELF under the same truth, which is the only honest
// yardstick for stage B's own b and c.
//
// The field is still called `candidate` because it is the same VerdictPair the
// rest of the file uses and a parallel type would be a second thing to keep in
// step. Every caller labels it in the payload.
export function controlPairs(rows: ReadonlyArray<ArmTriad>): VerdictPair[] {
  return rows.map((row) => ({
    analysisId: row.analysisId,
    live: row.live,
    candidate: row.liveB,
    disagree: row.controlDisagrees,
  }));
}

export function candidatePairs(rows: ReadonlyArray<ArmTriad>): VerdictPair[] {
  return rows.map((row) => ({
    analysisId: row.analysisId,
    live: row.live,
    candidate: row.candidate,
    disagree: row.candidateDisagrees,
  }));
}

// ---------------------------------------------------------------------------
// The verdict: is the swap bigger than the resample?
// ---------------------------------------------------------------------------

export type ControlScreenVerdict =
  // The candidate disagreed with live on strictly more rows than the control
  // did, by more than the exact paired test attributes to chance. The change
  // is material; a forward evaluation is worth paying for. IT STILL SAYS
  // NOTHING ABOUT WHICH BOOK IS BETTER.
  | "material"
  // Not distinguishable from resampling the same book. The honest report is
  // "swapping the book did not move the answer more than asking twice does",
  // NOT "the two books are the same".
  | "indistinguishable"
  // Significant in the WRONG DIRECTION: one book disagreed with itself on more
  // rows than the other book disagreed with it. That is not a finding about
  // the candidate — it is a reason to look at the instrument, because a book
  // cannot be more stable against a different book than against itself.
  | "control_exceeds_candidate_investigate";

// THE ORIENTATION LIVES HERE AND NOWHERE ELSE, and it is `c > b`.
//
// `significant` and `underpowered` are taken from `mcnemarExact` rather than
// recomputed, so the 0.05 threshold and the m < 6 rule are each stated in one
// place. An underpowered run is `indistinguishable` and never `material`: no
// split of fewer than six discordant rows can reach 0.05, and a screen that
// fired on one would be firing on arithmetic that could not have said no.
export function screenAgainstControl(input: {
  b: number;
  c: number;
  significant: boolean;
  underpowered: boolean;
}): ControlScreenVerdict {
  if (!Number.isInteger(input.b) || !Number.isInteger(input.c) || input.b < 0 || input.c < 0) {
    throw new RangeError(
      `screenAgainstControl: b and c must be non-negative integers, got ${input.b} and ${input.c}`,
    );
  }
  if (input.underpowered || !input.significant) return "indistinguishable";
  return input.c > input.b ? "material" : "control_exceeds_candidate_investigate";
}

// ---------------------------------------------------------------------------
// The SUPERSEDED stage A screen, kept as a secondary reference only
// ---------------------------------------------------------------------------
//
// This is the interval-overlap screen against #64's borrowed 20.83%. IT NO
// LONGER DECIDES ANYTHING. The verdict comes from `screenAgainstControl`
// above, over a floor measured on the same rows and the same rendering.
//
// It is kept, and still emitted, for one reason: a reader who has seen the old
// design needs to be able to see what it would have said, and a number that
// quietly disappears is a number nobody can check. Everywhere it is printed it
// carries the label that it was measured on a DIFFERENT PROMPT RENDERING —
// ranked, with per-rule fit markers — from the one both arms of this run use.
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
