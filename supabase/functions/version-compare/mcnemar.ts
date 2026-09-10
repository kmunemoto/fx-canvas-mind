// The paired test #65 ends on, and the arithmetic that says whether it can be
// run yet.
//
// PURE, ZERO IMPORTS. Everything here is arithmetic on integers the caller has
// already counted, so vitest can exercise it with no Deno runtime and no
// database, and so that nothing in it can reach a table by accident.
//
// TWO THINGS LIVE HERE AND THEY ARE NOT THE SAME QUESTION:
//
//   * `mcnemarExact` — given b and c, is the difference between the two arms
//     bigger than chance? This is a PERFORMANCE claim and it may only be fed
//     cells scored against outcomes that were unknown when the candidate was
//     frozen. See pairing.ts for the eligibility rule that guards it.
//
//   * `requiredPairs` — given the measured same-version noise floor, how many
//     paired rows does that test need before it can say anything at all? This
//     is the number that decides whether it is worth replaying anything today.
//
// The sample-size formula is NOT invented here. It is the one pre-registered in
// docs/NOISE_FLOOR_PREREGISTRATION.md §4 and used there to derive the table of
// required n against p0. It is reproduced rather than imported because that
// document is prose; the test in src/test/version-compare.test.ts pins this
// implementation against the document's published rows, so a change to either
// fails loudly instead of forking.

// ---------------------------------------------------------------------------
// The pre-registered design constants
// ---------------------------------------------------------------------------

// Two-sided alpha = 0.05, power = 0.80. WRITTEN OUT rather than derived from an
// inverse normal CDF, and the alternative was rejected on purpose: implementing
// a probit here would invite a caller to pass an alpha the pre-registration
// never fixed, and the whole value of a pre-registered design is that alpha and
// power are promises made before the data, not parameters.
//
// Both figures are the ones docs/NOISE_FLOOR_PREREGISTRATION.md §4 states and
// computes its table from.
export const Z_ALPHA_2 = 1.959964;
export const Z_BETA = 0.841621;

// The effect the design is powered to detect: a 20-point difference in the
// discordant-pair split. Also a promise, also from §4.
export const DELTA = 0.20;

// The exact-test floor at zero noise, from §4. At p0 = 0 the normal
// approximation below degenerates (psi goes to 1, the sqrt term vanishes, and n
// falls to 20) because every discordant pair lands on one side and the test
// becomes a sign test. §4 solves that case exactly instead: a two-sided exact
// binomial test at alpha = 0.05 can reject only from m >= 6 discordant pairs
// (2 * 0.5^6 = 0.03125 <= 0.05; m = 5 gives 0.0625), and the smallest n with
// P(Bin(n, 0.20) >= 6) >= 0.80 is 39 (power 0.8200; n = 38 gives 0.7996).
export const EXACT_PAIRS_AT_ZERO_NOISE = 39;

// ---------------------------------------------------------------------------
// The exact binomial McNemar test
// ---------------------------------------------------------------------------

export interface McnemarResult {
  // live right & candidate wrong.
  b: number;
  // live wrong & candidate right.
  c: number;
  // b + c. The only pairs the test can see: a pair where both arms were right,
  // or both wrong, carries no information about which arm is better and is
  // correctly ignored rather than counted as a tie in favour of the incumbent.
  discordant: number;
  // Exact two-sided p against the null that a discordant pair is equally likely
  // to fall either way. Never a chi-square with or without continuity
  // correction: at the discordant counts this harness can realistically reach
  // (single digits for weeks) the approximation is not close, and it is
  // anti-conservative in exactly the region where a wrong answer would promote
  // a rulebook.
  pValue: number;
  // Which way the discordant pairs lean. "tied" when b === c, INCLUDING when
  // both are zero — a run with no discordant pairs has no direction, and
  // calling that "live" would hand the incumbent a win it never earned.
  direction: "candidate_better" | "live_better" | "tied";
  // pValue <= 0.05. Reported as a field rather than left to the caller so that
  // the threshold is stated in one place and cannot drift between the function
  // and its write-up.
  significant: boolean;
  // Set when the numbers are real but the test cannot reject at ANY split,
  // because m < 6 makes the smallest attainable two-sided p equal to 2*0.5^m,
  // which is above 0.05. This is the difference between "we tested and found
  // nothing" and "no test was possible", and the two must never be printed the
  // same way.
  underpowered: boolean;
}

// The most discordant pairs the exact test will accept. 0.5^m underflows to
// zero below about m = 1075, and this harness deals in dozens; a value in the
// thousands means the caller counted something other than discordant pairs.
const MAX_DISCORDANT = 1000;

const isCount = (value: number): boolean =>
  Number.isInteger(value) && value >= 0 && Number.isFinite(value);

// The smallest m at which a two-sided exact binomial test can reach 0.05:
// 2 * 0.5^6 = 0.03125, while m = 5 gives 2 * 0.5^5 = 0.0625.
const MIN_REJECTABLE_DISCORDANT = 6;

export function mcnemarExact(b: number, c: number): McnemarResult {
  if (!isCount(b) || !isCount(c)) {
    // A refusal rather than a coercion. A fractional b is a caller that pooled
    // something it should not have, and rounding it here would turn that into
    // a published p-value.
    throw new RangeError(`mcnemarExact: b and c must be non-negative integers, got ${b} and ${c}`);
  }
  const m = b + c;
  if (m > MAX_DISCORDANT) {
    throw new RangeError(`mcnemarExact: ${m} discordant pairs is beyond this test's range`);
  }

  const direction: McnemarResult["direction"] = b === c
    ? "tied"
    : (c > b ? "candidate_better" : "live_better");

  if (m === 0) {
    // No discordant pairs at all. p = 1 is the honest value — every possible
    // outcome of a zero-trial binomial is this one — and `underpowered` says
    // that no amount of luck could have produced a rejection.
    return { b, c, discordant: 0, pValue: 1, direction, significant: false, underpowered: true };
  }

  // Exact two-sided p under Bin(m, 1/2).
  //
  // Computed as 2 * P(X <= min(b, c)) rather than 2 * P(X >= max(b, c)). The
  // two are equal for a symmetric binomial (P(X >= max) = P(X <= m - max) and
  // m - max = min), and the lower tail is the one that sums FEW terms whose
  // magnitudes RISE, which is the numerically well-behaved direction. The pmf
  // is stepped multiplicatively from 0.5^m so that no binomial coefficient is
  // ever formed: C(100, 50) is about 1e29 and forming it before multiplying by
  // 0.5^100 throws away significant digits for no reason.
  const lower = Math.min(b, c);
  let pmf = Math.pow(0.5, m);
  let tail = pmf;
  for (let k = 0; k < lower; k += 1) {
    pmf = pmf * (m - k) / (k + 1);
    tail += pmf;
  }
  const pValue = Math.min(1, 2 * tail);

  return {
    b,
    c,
    discordant: m,
    pValue,
    direction,
    significant: pValue <= 0.05,
    underpowered: m < MIN_REJECTABLE_DISCORDANT,
  };
}

// ---------------------------------------------------------------------------
// How many paired rows the test needs
// ---------------------------------------------------------------------------

export interface SampleSize {
  // The same-version disagreement rate the calculation was made at.
  noiseRate: number;
  delta: number;
  // psi and K are returned, not hidden, because they are what makes the number
  // checkable against docs/NOISE_FLOOR_PREREGISTRATION.md §4 by hand.
  psi: number;
  k: number;
  // The raw real-valued n before rounding.
  raw: number;
  // ceil(raw). This is the headline: paired rows required.
  pairs: number;
  // Set when the exact zero-noise case was used instead of the formula.
  exact: boolean;
}

// n = 4K^2 (delta + p0) / delta^2, with
//   psi = 1/2 + (delta/2) / (delta + p0)
//   K   = z_{alpha/2}/2 + z_beta * sqrt(psi (1 - psi))
//
// Noise does not BIAS a McNemar test — it is symmetric in b and c — it DILUTES
// it, so the pairs required grow with the noise rate. That is the entire reason
// #64 had to be measured before #65 could be designed, and the entire reason
// this function takes the measured floor as its argument rather than assuming
// a clean instrument.
export function requiredPairs(noiseRate: number, delta: number = DELTA): SampleSize {
  if (!Number.isFinite(noiseRate) || noiseRate < 0 || noiseRate >= 1) {
    throw new RangeError(`requiredPairs: noiseRate must lie in [0, 1), got ${noiseRate}`);
  }
  if (!Number.isFinite(delta) || delta <= 0 || delta >= 1) {
    throw new RangeError(`requiredPairs: delta must lie in (0, 1), got ${delta}`);
  }

  if (noiseRate === 0) {
    // The formula does not apply here; see EXACT_PAIRS_AT_ZERO_NOISE. Returning
    // the formula's 20 would understate the requirement by half, in the
    // direction that authorises a run that cannot conclude.
    return {
      noiseRate,
      delta,
      psi: 1,
      k: Number.NaN,
      raw: Number.NaN,
      pairs: EXACT_PAIRS_AT_ZERO_NOISE,
      exact: true,
    };
  }

  const psi = 0.5 + (delta / 2) / (delta + noiseRate);
  const k = Z_ALPHA_2 / 2 + Z_BETA * Math.sqrt(psi * (1 - psi));
  const raw = 4 * k * k * (delta + noiseRate) / (delta * delta);
  return { noiseRate, delta, psi, k, raw, pairs: Math.ceil(raw), exact: false };
}

// What is still missing. Separated from `requiredPairs` so that "the design
// needs 75" and "we are 27 short" are two statements a reader can check
// independently, and so that a caller cannot report the shortfall without
// having named the requirement it was measured against.
//
// `have` is PAIRS ADMITTED TO THE TEST, not rows replayed and not cells
// written: a pair whose either arm failed, or whose snapshot has no settled
// outcome, is not a pair this test can see. Feeding it the cell count would
// declare the requirement met while the test still had nothing to work with.
export function pairsStillNeeded(required: number, have: number): number {
  if (!isCount(required) || !isCount(have)) {
    throw new RangeError(`pairsStillNeeded: both arguments must be non-negative integers, got ${required} and ${have}`);
  }
  return Math.max(0, required - have);
}
