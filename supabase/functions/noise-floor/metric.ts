// The arithmetic that turns a pile of replayed prompts into a noise floor.
//
// #65 wants to know whether swapping the rulebook changes the analyst's
// answer. It cannot know that until we know how often the analyst changes its
// own answer with nothing swapped at all. The request carries no seed, and on
// this model temperature/top_p/top_k are not accepted parameters, so two
// identical POSTs are two independent samples: every difference #65 would see
// is a mixture of "the rulebook did something" and "the model did not repeat
// itself", and nothing in the response decomposes it. This file is the half of
// that measurement that has no I/O in it.
//
// ZERO IMPORTS, on purpose, and the constraint is load-bearing rather than
// tidy. The Deno edge function and vitest both read this file directly: the
// function needs it inside a bundle that must not drag `analyze` in, and the
// test needs it without a Deno runtime to fake. `_shared/episodes.ts` is a leaf
// for the same reason and says so; this is the same rule applied to a second
// file. The moment this imports anything, one of the two readers loses it.
//
// WHAT THIS MODULE REFUSES TO DO is more important than what it computes.
// `analyze`'s `normalizeAnalysis` never fails: an unreadable signal becomes
// "WAIT" and an unreadable confidence becomes 0. That is right for a user who
// asked for a plan and must be shown something, and catastrophic for a
// measurement, because a broken response then lands as "a WAIT at confidence
// 0" and is indistinguishable from a considered stand-aside. A harness that
// read only the normalised object would score every parse failure as
// agreement-with-WAIT and report a floor BELOW the truth — and a floor that is
// too low is the direction that lets #65 wave a real rulebook regression
// through as noise. So nothing here is ever coerced: a value that is absent
// reads as absent, a cell that is not a measurement is dropped from both the
// numerator and the denominator, and a population the harness admits it
// mishandled gets a refusal instead of a rate.
//
// 45 of the 48 stored rows are the ones at risk. Web search and structured
// output cannot be combined, so those 45 received their field contract as
// prose in the prompt and nothing enforced it.

// ---------------------------------------------------------------------------
// Cell classification — the four-class failure taxonomy, before normalisation
// ---------------------------------------------------------------------------

// Why a cell might not be a measurement.
//
// Everything that is not "ok" leaves BOTH the numerator and the denominator of
// the disagreement rate. The classes are kept apart rather than collapsed to a
// single "bad" because the pre-registration's instrument condition is stated
// per class — it aborts the write-up if the failure rate crosses 5%, and "5% of
// what" only means something if the classes are counted separately.
export type CellStatus =
  | "ok"
  | "http_error"
  | "parse_failed"
  | "missing_keys"
  | "refusal"
  | "truncated"
  | "timeout"
  | "pause_exhausted"
  | "aborted";

// The model's own answer, read out of the RAW parsed JSON.
//
// Every field is nullable and null means ABSENT OR UNREADABLE, never a default.
// `confidence: null` is not 0 and `signal: null` is not "WAIT"; those two
// coercions are exactly what `normalizeAnalysis` does and exactly what this
// measurement cannot survive.
export interface RawAnswer {
  signal: string | null;
  confidence: number | null;
  stop: number | null;
  tp1: number | null;
  fundamental_score: number | null;
  // Which of the caller-supplied `required` keys the object did not carry.
  // Empty on an "ok" cell by construction.
  missingRequiredKeys: string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// A string is a string. `normalizeAnalysis` would happily take a number here
// and stringify it; we do not, because a signal that arrived as a number is a
// contract violation and reading it as one hides it from the failure rate the
// pre-registration asks for.
const readString = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

// A number is a finite number. Not a numeric string: `"62"` is what a prose
// contract produces when it drifts, and silently parsing it to 62 would report
// a compliant response that never happened. Not NaN or Infinity either, since
// both would poison every mean downstream without ever announcing themselves.
const readNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const readRaw = (
  record: Record<string, unknown>,
  missingRequiredKeys: string[],
): RawAnswer => ({
  signal: readString(record["signal"]),
  confidence: readNumber(record["confidence"]),
  // The schema calls these stop_loss and take_profit_1. They are named `stop`
  // and `tp1` here to match `entry_check.proposed_stop` / `proposed_tp1`, which
  // is what the stored side of any later comparison is called.
  stop: readNumber(record["stop_loss"]),
  tp1: readNumber(record["take_profit_1"]),
  fundamental_score: readNumber(record["fundamental_score"]),
  missingRequiredKeys,
});

// The taxonomy, applied BEFORE any normalisation.
//
// ORDER IS THE WHOLE POINT and it is stop_reason first, parse second.
// `stop_reason: "max_tokens"` means the model was cut off mid-answer, and a
// JSON object cut off mid-answer can still parse — an array closed early, an
// object whose last complete member happened to land on a brace. Such a cell
// parses, carries a signal, and reads as a perfectly good disagreement with its
// own replicate. Checking `parsed` first and only then asking why the turn
// ended would score it. So: `max_tokens` is "truncated" whatever the body says,
// and "ok" is returned only for a turn that ended `end_turn`, parsed to a
// record, and carried every one of the caller's required keys.
//
// An unrecognised or absent stop_reason lands in "parse_failed" rather than
// anywhere near "ok". That class reads as "no complete answer object was
// obtained from this response", which is true of `tool_use`, of a stop_sequence
// cut, and of a null: the alternative — inventing a tenth status, or letting an
// unknown reason fall through to the parse check — either breaks the enum the
// migration's `status` column is written against, or lets a future stop_reason
// score as a measurement by default. Defaulting to "not a measurement" is the
// direction that cannot bias the floor downwards.
//
// `raw` comes back non-null for exactly two statuses, "ok" and "missing_keys".
// Those are the two where the model delivered a complete, well-formed object
// and the fields in it are genuinely its answer — #64 prints the raw fields of
// a missing-keys cell to show whether the missing key came with a different
// answer or only with a different shape. A truncated body's fields are an
// artefact of where the token budget ran out rather than of what the model
// decided, so handing them back would rebuild the "reads as disagreement"
// mistake this ordering exists to prevent.
export function classifyCell(input: {
  httpStatus: number;
  stopReason: string | null;
  parsed: unknown;
  requiredKeys: readonly string[];
}): { status: CellStatus; raw: RawAnswer | null } {
  const { httpStatus, stopReason, parsed, requiredKeys } = input;

  // An empty list is not a lenient check, it is no check: every parsed record
  // would satisfy it, "missing_keys" would never fire again, and the class the
  // pre-registration names as the most likely failure on the 45 prose-contract
  // rows would read as a measured zero. The list arrives as a parameter so this
  // file can stay a leaf, which is exactly what makes it possible to lose it on
  // the way in, so the loss is caught here rather than reported as a clean run.
  if (requiredKeys.length === 0) {
    throw new RangeError("classifyCell: requiredKeys is empty; a check of no keys is not a check");
  }

  // Non-2xx first: a 4xx body is an error envelope, and its `stop_reason` (if
  // it has one at all) describes nothing that happened to a turn.
  if (!(httpStatus >= 200 && httpStatus < 300)) {
    return { status: "http_error", raw: null };
  }

  if (stopReason === "refusal") {
    // `stop_details` is read by the caller in this branch and in no other. It
    // is null on every other stop_reason, and a reader that pulls it
    // unconditionally records a null as "no details" rather than as "not that
    // kind of ending".
    return { status: "refusal", raw: null };
  }
  if (stopReason === "max_tokens") return { status: "truncated", raw: null };
  if (stopReason === "pause_turn") {
    // A `pause_turn` reaching classification means the bounded continuation
    // loop gave up rather than that a pause occurred — the loop echoes
    // `content` back and re-asks, so an intermediate pause never gets here.
    return { status: "pause_exhausted", raw: null };
  }
  if (stopReason !== "end_turn") return { status: "parse_failed", raw: null };

  if (!isRecord(parsed)) return { status: "parse_failed", raw: null };

  // `required` in JSON Schema is about the member EXISTING, not about it being
  // non-null or well-typed, so that is what is checked here and nothing more.
  // `{"signal": null}` satisfies `required` and is caught later by
  // publishedProxy returning null for a row it cannot project — one check for
  // "the object had the right shape" and a separate one for "the values were
  // readable", because folding them together would report a type violation as
  // a missing key and mislead whoever reads the failure table.
  const missing = requiredKeys.filter(
    (key) => !Object.prototype.hasOwnProperty.call(parsed, key),
  );
  if (missing.length > 0) {
    return { status: "missing_keys", raw: readRaw(parsed, missing) };
  }

  return { status: "ok", raw: readRaw(parsed, []) };
}

// ---------------------------------------------------------------------------
// The projection: published_proxy
// ---------------------------------------------------------------------------

// The confidence floor, duplicated from `MIN_CONFIDENCE` in
// `supabase/functions/analyze/index.ts`. Cited by symbol name and not by line
// number, because that file is edited by #65 and every line number in it will
// move.
//
// Duplicated rather than imported for the same reason `shape.ts` duplicates the
// request constants: importing from `analyze/index.ts` drags the entire
// analyzer — Deno APIs, database calls, the price fetcher — into a bundle that
// must be able to run with none of them, and into a vitest file that has no
// Deno runtime. The duplication is pinned by a test that reads `analyze`'s
// source as text, so a change there fails loudly here rather than forking in
// silence.
//
// THE COMPARISON IS STRICT. `analyze` computes `confidence < MIN_CONFIDENCE`,
// so a confidence of exactly 60 PUBLISHES. This is not a detail: measured
// against the 48 stored rows on 2026-09-09, the smallest downward jitter that
// flips any row at all is 3 points, and it is 3 rather than 2 precisely because
// 60 is on the publishing side. An implementation that used `<=` would report
// the flip table one column to the left and overstate how fragile the corpus is.
export const MIN_CONFIDENCE = 60;

// The published_proxy: the confidence floor ONLY, applied to the model's own
// signal. "traded" for a BUY or a SELL that clears the floor, "waited" for
// anything the floor stops or that the model itself called WAIT.
//
// THIS IS NOT "WHAT THE USER IS SHOWN", and the write-up must not say it is.
// Measured on the 48 stored rows, the real entry gate fired on 26 of them: 21
// `low_confidence`, 4 `market_closed`, 1 `poor_rr`. So 5 of 48 — 10.4% — were
// published or withheld by a branch this projection does not model at all, and
// 10.4% is larger than the entire 8.8% break-even the go/no-go turns on.
//
// Modelling the whole gate instead was REJECTED, twice over. Reproducing it
// would fold ATR, price and geometry noise into the number, and #64 exists to
// isolate model noise; and `isPossiblyClosed(Date.now())` reads the
// REPLAY clock, not the clock the row was written under, so a run over a
// weekend would force WAIT on 100% of rows in both arms and print a flawless,
// meaningless 0%. Keeping the projection pure and stating plainly what it omits
// is the honest version.
//
// #65 MUST CALL THIS SAME FUNCTION. The floor only gates #65 if #65's McNemar
// cells are computed by the identical projection; if #65 wants the full
// published decision, #64 has to be re-run against the full gate.
//
// Returns null when the cell cannot be projected: an absent confidence, a
// confidence outside the contract, an absent signal, or a signal outside the
// schema's BUY/SELL/WAIT enum. The signal is checked BEFORE the floor
// deliberately — otherwise a garbage signal arriving with a low confidence
// would be laundered into a clean "waited", which is `normalizeAnalysis`'s
// coercion wearing a different hat.
//
// The confidence is held to the schema's own declaration, `{type: "integer",
// description: "0-100"}`, and the range check is the same hat again. `analyze`
// runs the field through `clampInt(source.confidence, 0, 100, 0)`, so in
// production a 0.64 becomes 1 and a 6200 becomes 100 and neither leaves a
// trace. Inheriting that here would be worse than losing the row: a model that
// answered on a 0-1 scale would have BOTH its replicates rounded to the same
// side of the floor and score as a clean agreement, which is the direction that
// sinks the floor and lets #65 wave a real regression through. A confidence
// this function cannot read is a cell it declines to project, and `report`
// counts it in `rowsUnprojectable` where somebody can see it.
export function publishedProxy(raw: RawAnswer): "traded" | "waited" | null {
  const signal = raw.signal;
  if (signal !== "BUY" && signal !== "SELL" && signal !== "WAIT") return null;
  const confidence = raw.confidence;
  if (confidence === null) return null;
  if (!Number.isInteger(confidence) || confidence < 0 || confidence > 100) return null;
  if (confidence < MIN_CONFIDENCE) return "waited";
  return signal === "WAIT" ? "waited" : "traded";
}

// ---------------------------------------------------------------------------
// Disagreement, per row and pooled
// ---------------------------------------------------------------------------

const choose2 = (n: number): number => (n * (n - 1)) / 2;

// disagree_i = [ C(N,2) − Σ_c C(n_c,2) ] / C(N,2)
//
// The share of unordered replicate PAIRS within one row that landed on
// different decisions. At N=2 it collapses to the indicator "were the two
// different", which is the form the headline is reported in; the general form
// is written out anyway so that an N=3 run does not need a second function and
// a second chance to define agreement differently.
//
// Returns null below two replicates. A one-replicate row contributes no pair,
// and the alternative — returning 0 — would enter it as a measured agreement.
// That is the same "a read that failed is not zero" rule the promotion gate
// applies to its episode count, and it matters more here: rows lose replicates
// through transport failure, and the rows that need retries are not a random
// sample of rows.
export function disagreeRow(
  decisions: ReadonlyArray<"traded" | "waited">,
): number | null {
  const n = decisions.length;
  if (n < 2) return null;

  let traded = 0;
  for (const d of decisions) if (d === "traded") traded += 1;
  const waited = n - traded;

  const pairs = choose2(n);
  const concordant = choose2(traded) + choose2(waited);
  return (pairs - concordant) / pairs;
}

// The pooled rate: an UNWEIGHTED mean over rows, every row weight 1.
//
// Pooling pairs instead — summing numerators and denominators across rows —
// was rejected. #65's McNemar unit is the row, so the floor has to be an
// estimate of the same unit or it does not gate anything. And a pair-pooled
// mean lets a row that happened to get three replicates outweigh one that got
// two, which is worse than merely arbitrary: replicates get added by retrying,
// retries happen to rows that failed, and rows that fail are not the stable
// ones. The weighting would tilt towards the noisy rows and inflate the floor.
//
// `k` is the sum of the per-row disagreement scores, which is an integer count
// of disagreeing rows at N=2 and a fraction at N>=3. Zero rows returns NaN
// rather than 0: the mean of no rows is not zero, and zero is precisely the
// number a reader would take for "no disagreement was found".
export function poolRate(
  rows: ReadonlyArray<number>,
): { n: number; k: number; rate: number } {
  let k = 0;
  for (const value of rows) {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      // A NaN or an out-of-range score would average silently into a plausible
      // looking rate. disagreeRow's null is the caller's signal to drop a row;
      // it is not something to pass through here.
      throw new RangeError(`poolRate: per-row score out of [0,1]: ${value}`);
    }
    k += value;
  }
  const n = rows.length;
  return { n, k, rate: n === 0 ? Number.NaN : k / n };
}

// ---------------------------------------------------------------------------
// Intervals
// ---------------------------------------------------------------------------

// z for a two-sided 95% interval. Written out rather than computed, because the
// only thing that could compute it here is an inverse normal CDF this module
// would otherwise have no use for.
const Z_95 = 1.959963984540054;

// Wilson score interval.
//
// WALD IS DELIBERATELY NOT IMPLEMENTED AND NOT EXPORTED. At 0/48 Wald returns
// [0.0%, 0.0%] — it writes "we observed nothing" as "we measured that there is
// nothing", which is the one inference this repository refuses everywhere else.
// The absence is pinned by a test on the module surface so that nobody adds it
// back as a convenience.
//
// Wilson is chosen over Wald for not degenerating at the boundary, and 0/48 is
// a genuinely likely outcome: 47 of the 48 stored rows sit 3 or more points
// from the floor. The rows are not exchangeable — each has its own p_i, so the
// count is Poisson-binomial rather than binomial — but that variance,
// Σp_i(1−p_i) = n·p̄ − Σp_i², is at most n·p̄(1−p̄) by Jensen, so it is bounded
// by the binomial variance Wilson assumes and Wilson errs conservative.
export function wilson(
  k: number,
  n: number,
  z: number = Z_95,
): { lo: number; hi: number } {
  if (!Number.isFinite(n) || n <= 0) {
    throw new RangeError(`wilson: n must be positive, got ${n}`);
  }
  if (!Number.isFinite(k) || k < 0 || k > n) {
    throw new RangeError(`wilson: k must lie in [0, n], got ${k} of ${n}`);
  }
  const z2 = z * z;
  const denominator = n + z2;
  const centre = (k + z2 / 2) / denominator;
  const half = (z / denominator) * Math.sqrt((k * (n - k)) / n + z2 / 4);
  // Clamped only against floating point drift; the interval is analytically
  // inside [0,1].
  return {
    lo: Math.max(0, centre - half),
    hi: Math.min(1, centre + half),
  };
}

// Lanczos log-gamma, g = 7, nine coefficients. Needed only as the normalising
// constant of the incomplete beta below.
const LANCZOS = [
  0.99999999999980993,
  676.5203681218851,
  -1259.1392167224028,
  771.32342877765313,
  -176.61502916214059,
  12.507343278686905,
  -0.13857109526572012,
  9.9843695780195716e-6,
  1.5056327351493116e-7,
];

const logGamma = (x: number): number => {
  if (x < 0.5) {
    // Reflection: Γ(x)Γ(1−x) = π / sin(πx). Not reachable from the callers
    // below (a and b are always >= 1 there) but written so the helper is not a
    // trap for the next caller.
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  }
  const z = x - 1;
  let series = LANCZOS[0];
  for (let i = 1; i < LANCZOS.length; i += 1) series += LANCZOS[i] / (z + i);
  const t = z + LANCZOS.length - 1.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(series);
};

// The continued fraction for the incomplete beta, evaluated by modified Lentz.
// This is the standard Numerical Recipes `betacf`; it is spelled out here
// because the module may not import anything, and because a statistics
// dependency inside a Deno edge-function bundle is a dependency the deploy
// verification would then have to vouch for.
const betaContinuedFraction = (a: number, b: number, x: number): number => {
  const MAX_ITERATIONS = 300;
  const EPSILON = 3e-16;
  const TINY = 1e-300;

  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < TINY) d = TINY;
  d = 1 / d;
  let h = d;

  for (let m = 1; m <= MAX_ITERATIONS; m += 1) {
    const m2 = 2 * m;
    let numerator = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + numerator * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + numerator / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    h *= d * c;

    numerator = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + numerator * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + numerator / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < EPSILON) break;
  }
  return h;
};

// The regularised incomplete beta I_x(a,b) = P(Beta(a,b) <= x), which is the
// Clopper-Pearson interval's CDF. The fraction converges fast on one side of
// x = (a+1)/(a+b+2) and slowly on the other, so the symmetry
// I_x(a,b) = 1 − I_{1−x}(b,a) is used to always evaluate on the fast side.
const regularisedIncompleteBeta = (x: number, a: number, b: number): number => {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(
    logGamma(a + b) - logGamma(a) - logGamma(b) +
      a * Math.log(x) + b * Math.log1p(-x),
  );
  return x < (a + 1) / (a + b + 2)
    ? (front * betaContinuedFraction(a, b, x)) / a
    : 1 - (front * betaContinuedFraction(b, a, 1 - x)) / b;
};

// Inverse of the above by bisection. I_x is strictly increasing in x on (0,1),
// so bisection cannot miss the root; 200 halvings of [0,1] is far past double
// precision and costs nothing at the scale this runs at (a handful of calls per
// report). Newton would be faster and would need a derivative and a guard
// against overshooting past 0 or 1 — speed nobody needs, bought with two more
// ways to be subtly wrong.
const invertRegularisedIncompleteBeta = (
  p: number,
  a: number,
  b: number,
): number => {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 200; i += 1) {
    const mid = (lo + hi) / 2;
    if (regularisedIncompleteBeta(mid, a, b) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
};

// Clopper-Pearson exact interval, printed beside Wilson.
//
// Implemented from the incomplete beta rather than pulled from a library
// because this file may not import anything. It is here as a check on Wilson at
// the boundary rather than as the headline: at 0/48 the two differ by about
// a hundredth of a percentage point (7.410% against 7.397%), which is the
// evidence for saying Wilson's approximation is not what decides the go/no-go.
//
// The degenerate ends are exact rather than inverted: at k = 0 there is no
// lower Beta to invert (a = 0) and the lower bound is 0; symmetrically at
// k = n the upper bound is 1.
export function clopperPearson(
  k: number,
  n: number,
  alpha = 0.05,
): { lo: number; hi: number } {
  if (!Number.isInteger(n) || n <= 0) {
    // An integer for the same reason k is one: this is a binomial tail sum, and
    // there is no binomial with 47.5 trials. Wilson's guard is looser because
    // Wilson is an approximation that degrades gracefully; the exact interval
    // would just return a number.
    throw new RangeError(`clopperPearson: n must be a positive integer, got ${n}`);
  }
  if (!Number.isInteger(k) || k < 0 || k > n) {
    // Unlike Wilson's guard this insists on an integer: the exact interval is
    // defined by a binomial tail sum and there is no such thing as a tail past
    // 1.5 successes. An N>=3 run produces fractional per-row scores, and the
    // caller must not hand their sum to an exact binomial method.
    throw new RangeError(`clopperPearson: k must be an integer in [0, n], got ${k}`);
  }
  return {
    lo: k === 0 ? 0 : invertRegularisedIncompleteBeta(alpha / 2, k, n - k + 1),
    hi: k === n ? 1 : invertRegularisedIncompleteBeta(1 - alpha / 2, k + 1, n - k),
  };
}

// ---------------------------------------------------------------------------
// The uncensored quantities: spread, flip sensitivity, level distance
// ---------------------------------------------------------------------------

// The confidence band production has never once visited, inclusive.
//
// Measured 2026-09-09 over the frozen population: zero of 48 stored confidences
// fall in [53, 61]; the distribution jumps from 52 straight to 62. That hole is
// why the binary rate is censored — a row has to move at least 3 points down or
// 8 points up before the floor notices — and it is why replicates landing IN the
// hole are counted and reported. If they do land there, the hole was an artefact
// of 48 draws rather than a property of the analyst, and the spread has to be
// put in front of the binary rate in the write-up.
const EMPTY_BAND_LO = 53;
const EMPTY_BAND_HI = 61;

// The spread thresholds the report counts rows against. 1..5 line up with the
// downward flip table's measured columns; 8 is there because 8 points is what
// the five rows at confidence 52 need before an upward WAIT->SELL flip becomes
// possible at all.
const SPREAD_THRESHOLDS = [1, 2, 3, 4, 5, 8] as const;

export interface SpreadStats {
  n: number;
  median: number;
  p90: number;
  max: number;
  inEmptyBand: number;
  rowsWithSpreadGte: Record<1 | 2 | 3 | 4 | 5 | 8, number>;
}

// Nearest-rank quantile: the smallest observed value at or above the requested
// fraction of the sorted sample.
//
// Chosen over linear interpolation for both the median and the p90, so that
// every quantile this module prints is a spread that some row actually had.
// With 48 rows and integer confidences, an interpolated median would routinely
// report a half-point spread that no replicate pair produced, and the first
// person to compare it against the flip table would be comparing against a
// value that cannot occur. Stated here so the convention is not "corrected"
// later into a different printed number.
const quantileNearestRank = (sorted: ReadonlyArray<number>, fraction: number): number =>
  sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))];

// Per-row max−min over the replicate confidences, plus the empty-band count.
//
// Rows with fewer than two replicates throw rather than contributing a spread
// of 0. A single observation has no spread; entering it as zero would report
// the most fragile rows — the ones that lost a replicate to a failure — as the
// most stable ones. Same reasoning as disagreeRow returning null, expressed as
// a throw because by the time spreadStats is called the caller has already been
// told to drop those rows and calling it anyway is a bug, not a data condition.
export function spreadStats(
  perRow: ReadonlyArray<ReadonlyArray<number>>,
): SpreadStats {
  if (perRow.length === 0) {
    throw new RangeError("spreadStats: no rows; the spread of no rows is not 0");
  }

  const spreads: number[] = [];
  let inEmptyBand = 0;

  for (const replicates of perRow) {
    if (replicates.length < 2) {
      throw new RangeError(
        `spreadStats: a row with ${replicates.length} replicate(s) has no spread`,
      );
    }
    let lo = Infinity;
    let hi = -Infinity;
    for (const c of replicates) {
      if (!Number.isFinite(c)) {
        throw new RangeError(`spreadStats: unreadable confidence ${c}`);
      }
      if (c < lo) lo = c;
      if (c > hi) hi = c;
      if (c >= EMPTY_BAND_LO && c <= EMPTY_BAND_HI) inEmptyBand += 1;
    }
    spreads.push(hi - lo);
  }

  const sorted = spreads.slice().sort((a, b) => a - b);
  const rowsWithSpreadGte = {} as Record<1 | 2 | 3 | 4 | 5 | 8, number>;
  for (const threshold of SPREAD_THRESHOLDS) {
    rowsWithSpreadGte[threshold] = spreads.filter((s) => s >= threshold).length;
  }

  return {
    n: spreads.length,
    median: quantileNearestRank(sorted, 0.5),
    p90: quantileNearestRank(sorted, 0.9),
    max: sorted[sorted.length - 1],
    inEmptyBand,
    rowsWithSpreadGte,
  };
}

// How many rows a DOWNWARD jitter of d points would flip from published to
// withheld: rows that clear the floor today and would not clear it after
// losing d.
//
// Downward only, and that asymmetry is the finding rather than an omission. The
// floor is strict, so the same arithmetic upward needs the row to reach 60
// exactly; measured over the frozen 48 on 2026-09-09 the smallest upward
// excursion that flips anything is 8 points, and it flips the five rows sitting
// at 52. Reporting one function for both directions would hide that the corpus
// is roughly three times easier to knock down than to lift up.
//
// d is not required to be an integer even though every stored confidence is
// one: the function is also used against measured replicate spreads, and a mean
// spread is not integral.
export function flipSensitivity(
  confidences: ReadonlyArray<number>,
  d: number,
): number {
  if (!Number.isFinite(d) || d < 0) {
    throw new RangeError(`flipSensitivity: d must be a non-negative number, got ${d}`);
  }
  let flipped = 0;
  for (const c of confidences) {
    if (!Number.isFinite(c)) {
      throw new RangeError(`flipSensitivity: unreadable confidence ${c}`);
    }
    if (c >= MIN_CONFIDENCE && c - d < MIN_CONFIDENCE) flipped += 1;
  }
  return flipped;
}

// |a − b| / atr — the distance between two replicates' stop or first target,
// in units of the row's own volatility.
//
// ATR rather than pips. Measured over the frozen population on 2026-09-09,
// `entry_check.atr` is present and positive on 48 of 48 and spans 0.0408661 to
// 1.1878920 — a factor of 29.07 across the corpus, and a factor of 7.29 between
// the four per-interval means (15min 0.156147 over 15 rows, 1h 0.293003 over
// 16, 4h 0.633365 over 9, 1day 1.138663 over 8). A spread reported in pips
// would therefore be mostly a report of which timeframes happened to be in the
// sample. Every threshold in the entry gate is already denominated in ATR, so
// this is also the unit the downstream decision is taken in.
//
// A zero or negative ATR throws. Returning Infinity would flow into a mean and
// turn the whole level-distance table into Infinity with no indication of which
// row did it; returning 0 would report two identical levels. Neither is true,
// and an ATR that is not positive is a broken row, not a wide one.
export function levelSpreadAtr(a: number, b: number, atr: number): number {
  if (!Number.isFinite(atr) || atr <= 0) {
    throw new RangeError(`levelSpreadAtr: atr must be positive and finite, got ${atr}`);
  }
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    throw new RangeError(`levelSpreadAtr: levels must be finite, got ${a} and ${b}`);
  }
  return Math.abs(a - b) / atr;
}

// ---------------------------------------------------------------------------
// The report, and what it refuses to print
// ---------------------------------------------------------------------------

export type Stratum = "preview" | "v48" | "core";

export interface ReportCell {
  analysisId: string;
  rep: number;
  status: CellStatus;
  raw: RawAnswer | null;
  stratum: Stratum;
  shape: string;
}

// Why a report declined to print a rate. Machine-readable snake_case, the same
// vocabulary the run header's `abort_reason` and the response's `skipped` use;
// the numbers behind each one are in `exclusions`, so the code stays stable
// while the counts vary.
export type ReportRefusal =
  | "run_incomplete"
  | "cells_missing"
  | "duplicate_cell"
  | "partial_row"
  | "excess_replicates"
  | "stratum_disagreement"
  | "shape_disagreement"
  | "ok_cell_without_raw"
  | "no_admitted_rows";

export interface RateReport {
  n: number;
  k: number;
  rate: number;
  // Null when the per-row scores are not binary — an N>=3 run makes
  // disagree_i fractional, and Wilson and Clopper-Pearson are both interval
  // estimators for a binomial COUNT. The pre-registration's answer for that
  // case is a row-level bootstrap reported as a secondary, with the N=2 result
  // staying the headline; it is not this function's job to fake an interval in
  // the meantime.
  wilson: { lo: number; hi: number } | null;
  clopperPearson: { lo: number; hi: number } | null;
}

export interface ReportExclusions {
  rowsSeen: number;
  rowsAdmitted: number;
  // Every replicate of the row failed. A legitimate exclusion: the stopping
  // rule drops a transport-failed row on BOTH replicates and reports the count.
  rowsAllCellsFailed: number;
  // The row has some ok cells but not `reps` of them. This is the condition the
  // stopping rule says must never be created, so it refuses rather than
  // excludes; the count is still reported so the operator can see how many.
  rowsPartial: number;
  // A full set of ok cells, but at least one of them could not be projected —
  // all 20 keys present, and a signal or confidence that is not readable as
  // one. A model-output fact rather than a harness bug, so it excludes.
  rowsUnprojectable: number;
  cellsSeen: number;
  cellsOk: number;
}

export interface Report {
  emitted: boolean;
  refusal?: ReportRefusal;
  exclusions: ReportExclusions;
  // Share of ALL cells ending in each status. Every one of the nine keys is
  // present even at zero: an absent key reads as "not measured" and a zero
  // reads as "measured, and it did not happen", and here the second is true.
  failureRates: Record<CellStatus, number>;
  // The pooled estimate over every admitted row. Named for today's measured
  // population size; the field is the pool over whatever was admitted and does
  // not enforce 48.
  pooled48: RateReport | null;
  // The `core` stratum alone. Measured today, preview and v48 are disjoint
  // 4-row strata, leaving 40 in the middle, and 0/40 has a Wilson upper of
  // 8.76% against a break-even of 8.8% — one stratification away from
  // inverting the go/no-go. Both are printed, always, for that reason.
  core40: RateReport | null;
  byShape: Record<string, RateReport> | null;
  spread: SpreadStats | null;
}

const zeroFailureRates = (): Record<CellStatus, number> => ({
  ok: 0,
  http_error: 0,
  parse_failed: 0,
  missing_keys: 0,
  refusal: 0,
  truncated: 0,
  timeout: 0,
  pause_exhausted: 0,
  aborted: 0,
});

const rateReport = (rows: ReadonlyArray<number>): RateReport => {
  const { n, k, rate } = poolRate(rows);
  // Whether an interval may be printed is a property of the per-row SCORES, and
  // not of their sum. Asking `Number.isInteger(k)` looks like the same question
  // and is not: at N=4 a row that split 2-2 scores exactly 0.5, so two such rows
  // sum to exactly 1, and both intervals would then be computed as though a
  // binomial count of "1 disagreeing row out of 2" had been observed when no row
  // was ever binary. Wilson and Clopper-Pearson estimate a binomial COUNT, and
  // the count only exists when every row contributed a whole 0 or a whole 1.
  const binary = rows.every((value) => value === 0 || value === 1);
  return {
    n,
    k,
    rate,
    wilson: binary ? wilson(k, n) : null,
    clopperPearson: binary ? clopperPearson(k, n) : null,
  };
};

// The reporting gate.
//
// TWO REFUSALS, and they are refusals rather than warnings because a rate
// printed beside a caveat gets quoted without the caveat.
//
// The first is the pre-registered completeness gate: while
// completed + failed < expected the run is still in flight, and a rate computed
// over the cells that happen to have finished is a rate whose stopping time was
// chosen by whoever looked. That is the failure the frozen population and the
// "do not look at intermediate results" stopping rule exist to prevent, and it
// is the one that a helpful partial answer would reintroduce. It is asked of
// the run header and then again of the cell list, because the header can say
// "finished" about a population larger than the one that was handed in.
//
// The second is the partial row. The stopping rule says a row that fails
// transport is dropped on both replicates together and counted — so a row
// arriving here with one ok cell out of two cannot have come from the rule
// being followed. It is a harness bug or a mid-run read, and the honest
// response is to say the population was mishandled rather than to quietly drop
// the row and print a rate over the rest. The exclusion counts come back either
// way; the only difference is whether a number is printed beside them.
//
// Rows where every replicate failed are a different case and DO merely exclude:
// that is exactly what the stopping rule prescribes.
export function report(input: {
  expectedCells: number;
  completedCells: number;
  failedCells: number;
  reps: number;
  cells: ReadonlyArray<ReportCell>;
}): Report {
  const { expectedCells, completedCells, failedCells, reps, cells } = input;

  // Not a refusal but a throw: `reps` is the run's own declared design, capped
  // at 2..3 by the request contract, and a caller that reaches here with 1 is a
  // bug rather than a data condition. It matters because reps=1 would make
  // `okCells.length === reps` true for every single-replicate row, and a row
  // with one replicate is the thing every other guard in this file exists to
  // keep out of the numerator.
  if (!Number.isInteger(reps) || reps < 2) {
    throw new RangeError(`report: reps must be an integer of at least 2, got ${reps}`);
  }

  const failureRates = zeroFailureRates();
  const counts = zeroFailureRates();
  for (const cell of cells) counts[cell.status] += 1;
  for (const status of Object.keys(counts) as CellStatus[]) {
    failureRates[status] = cells.length === 0
      ? Number.NaN
      : counts[status] / cells.length;
  }

  const exclusions: ReportExclusions = {
    rowsSeen: 0,
    rowsAdmitted: 0,
    rowsAllCellsFailed: 0,
    rowsPartial: 0,
    rowsUnprojectable: 0,
    cellsSeen: cells.length,
    cellsOk: counts.ok,
  };

  const refuse = (refusal: ReportRefusal): Report => ({
    emitted: false,
    refusal,
    exclusions,
    failureRates,
    pooled48: null,
    core40: null,
    byShape: null,
    spread: null,
  });

  // Gate one. Checked before anything is grouped, because every count below it
  // is a count over a population that is not all there yet.
  if (completedCells + failedCells < expectedCells) return refuse("run_incomplete");

  // Gate one and a half: the run header says the run finished, and this checks
  // that the cells in front of the function are the run the header finished.
  // Nothing about a short list looks wrong from the inside — a PostgREST page
  // limit, a filter that dropped one status, a read that raced the header — and
  // in every one of those cases the rate comes out over whatever arrived, at
  // full confidence, with the completeness gate satisfied by a header that was
  // describing a larger population. A complete run has written at least
  // `expectedCells` cells (retries can only add), so fewer than that in hand
  // means the read is not the run.
  if (cells.length < expectedCells) return refuse("cells_missing");

  const byRow = new Map<string, ReportCell[]>();
  const seenCell = new Set<string>();
  for (const cell of cells) {
    const key = `${cell.analysisId}#${cell.rep}`;
    // The unique (run_id, analysis_id, rep) constraint should make this
    // impossible, but the reporter is handed rows, not the constraint. A
    // duplicated cell would double one row's weight inside its own pair count.
    if (seenCell.has(key)) return refuse("duplicate_cell");
    seenCell.add(key);
    const bucket = byRow.get(cell.analysisId);
    if (bucket) bucket.push(cell);
    else byRow.set(cell.analysisId, [cell]);
  }

  const pooledRows: number[] = [];
  const coreRows: number[] = [];
  const shapeRows = new Map<string, number[]>();
  const spreadRows: number[][] = [];
  let sawPartial = false;

  for (const rowCells of byRow.values()) {
    exclusions.rowsSeen += 1;

    const stratum = rowCells[0].stratum;
    const shape = rowCells[0].shape;
    // A row whose cells disagree about which stratum or which request shape
    // they were is a row that cannot be placed in either report. Recorded per
    // cell precisely so that this is checkable rather than inferred later.
    if (rowCells.some((c) => c.stratum !== stratum)) return refuse("stratum_disagreement");
    if (rowCells.some((c) => c.shape !== shape)) return refuse("shape_disagreement");

    const okCells = rowCells.filter((c) => c.status === "ok");
    if (okCells.length === 0) {
      exclusions.rowsAllCellsFailed += 1;
      continue;
    }
    if (okCells.length > reps) return refuse("excess_replicates");
    if (okCells.length < reps) {
      exclusions.rowsPartial += 1;
      // Keep counting so the operator gets the full exclusion picture rather
      // than the first offending row.
      sawPartial = true;
      continue;
    }

    const decisions: Array<"traded" | "waited"> = [];
    const confidences: number[] = [];
    let projectable = true;
    for (const cell of okCells) {
      const raw = cell.raw;
      // `classifyCell` returns a non-null `raw` for exactly "ok" and
      // "missing_keys", so an ok cell with no answer on it is a contradiction
      // in the taxonomy and therefore a harness fault. Refusing rather than
      // excluding, because the exclusion path is for facts about the model's
      // output; a systematic null here would quietly drop every row and print a
      // rate over whichever ones happened to escape the bug.
      if (raw === null) return refuse("ok_cell_without_raw");
      const decision = publishedProxy(raw);
      if (decision === null || raw.confidence === null) {
        projectable = false;
        break;
      }
      decisions.push(decision);
      confidences.push(raw.confidence);
    }
    if (!projectable) {
      exclusions.rowsUnprojectable += 1;
      continue;
    }

    const disagreement = disagreeRow(decisions);
    if (disagreement === null) {
      // Unreachable while reps >= 2, which the request contract enforces. Left
      // as an exclusion rather than a cast, because the alternative is a `!`
      // that turns a future reps=1 run into a silent 0.
      exclusions.rowsPartial += 1;
      sawPartial = true;
      continue;
    }

    exclusions.rowsAdmitted += 1;
    pooledRows.push(disagreement);
    if (stratum === "core") coreRows.push(disagreement);
    const shapeBucket = shapeRows.get(shape);
    if (shapeBucket) shapeBucket.push(disagreement);
    else shapeRows.set(shape, [disagreement]);
    spreadRows.push(confidences);
  }

  // Gate two, applied after the whole population has been walked so that
  // `exclusions` is complete when the refusal is returned.
  if (sawPartial) return refuse("partial_row");

  // A rate over zero rows is NaN, and NaN printed as a headline gets read as
  // 0. Say so instead.
  if (exclusions.rowsAdmitted === 0) return refuse("no_admitted_rows");

  const byShape: Record<string, RateReport> = {};
  for (const [shape, rows] of shapeRows) byShape[shape] = rateReport(rows);

  return {
    emitted: true,
    exclusions,
    failureRates,
    pooled48: rateReport(pooledRows),
    core40: coreRows.length === 0 ? null : rateReport(coreRows),
    byShape,
    spread: spreadStats(spreadRows),
  };
}
