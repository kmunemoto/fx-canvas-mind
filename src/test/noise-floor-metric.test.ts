import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import * as metric from "../../supabase/functions/noise-floor/metric";
import {
  MIN_CONFIDENCE,
  classifyCell,
  clopperPearson,
  disagreeRow,
  flipSensitivity,
  levelSpreadAtr,
  poolRate,
  publishedProxy,
  report,
  spreadStats,
  wilson,
  type RawAnswer,
  type ReportCell,
} from "../../supabase/functions/noise-floor/metric";

// ---------------------------------------------------------------------------
// The required-key list, taken verbatim from the analyzer rather than retyped
// ---------------------------------------------------------------------------

// `metric.ts` takes the required-key list as a parameter so it can stay a leaf
// with no imports, which means nothing inside it pins the list. This does:
// RESPONSE_SCHEMA's own `required` array is lifted out of
// `supabase/functions/analyze/index.ts` READ AS TEXT, by indentation rather
// than by line number, so that a key added to or removed from the analyzer
// fails here instead of quietly changing what "missing_keys" means.
//
// The two-space indent is what distinguishes the schema's top-level `required`
// from the two nested ones (`market_context_detail` at six spaces,
// `timeframe_alignment.items` at eight). Uniqueness is asserted rather than
// assumed, because a future third nested schema at the top level of the file
// would otherwise silently take this test's place.
const analyzeSrc = readFileSync("supabase/functions/analyze/index.ts", "utf8");
const topLevelRequired = [...analyzeSrc.matchAll(/\n {2}required: \[([\s\S]*?)\]/g)];
const REQUIRED_KEYS: string[] = [...topLevelRequired[0][1].matchAll(/"([^"]+)"/g)].map(
  (m) => m[1],
);

describe("the required-key list this measurement is scored against", () => {
  it("is the analyzer's own top-level `required`, and there is exactly one of it", () => {
    expect(topLevelRequired).toHaveLength(1);
  });

  it("has 20 keys — measured 2026-09-09 against the working tree", () => {
    // Written out rather than compared to a count alone: if a key is added and
    // another removed on the same commit, a bare length check would pass while
    // every stored cell's missing-key set changed meaning.
    expect(REQUIRED_KEYS).toEqual([
      "signal", "thesis", "confidence", "technical_score", "fundamental_score",
      "risk_level", "sentiment", "stop_loss", "take_profit_1",
      "take_profit_2", "take_profit_3", "risk_reward_ratio", "market_context",
      "market_context_detail", "timeframe_alignment",
      "key_factors", "support_levels", "resistance_levels", "analysis", "warnings",
    ]);
    expect(REQUIRED_KEYS).toHaveLength(20);
  });

  it("does not include rules_applied", () => {
    // The analyzer's comment says so and the reason matters to this
    // measurement: structured output does not bind when web search is on, and
    // 45 of the 48 stored rows searched, so `rules_applied` is absent far more
    // often than present. Scoring its absence as a missing key would report a
    // failure rate made almost entirely of a field nobody promised.
    expect(REQUIRED_KEYS).not.toContain("rules_applied");
  });
});

// A response body that satisfies every one of the 20 keys. Values are
// deliberately boring except `signal` and `confidence`, which the tests below
// vary.
const fullBody = (over: Record<string, unknown> = {}): Record<string, unknown> => {
  const body: Record<string, unknown> = {};
  for (const key of REQUIRED_KEYS) body[key] = "x";
  body.signal = "SELL";
  body.confidence = 64;
  body.stop_loss = 157.2;
  body.take_profit_1 = 155.8;
  body.fundamental_score = 50;
  return { ...body, ...over };
};

// ---------------------------------------------------------------------------
// 1. disagreeRow
// ---------------------------------------------------------------------------

describe("disagreeRow", () => {
  it("collapses to the indicator at N=2", () => {
    expect(disagreeRow(["traded", "waited"])).toBe(1);
    expect(disagreeRow(["waited", "traded"])).toBe(1);
    expect(disagreeRow(["traded", "traded"])).toBe(0);
    expect(disagreeRow(["waited", "waited"])).toBe(0);
  });

  it("is the share of discordant pairs at N=3", () => {
    // C(3,2) = 3 pairs; a 2/1 split leaves one concordant pair.
    expect(disagreeRow(["traded", "traded", "waited"])).toBeCloseTo(2 / 3, 12);
    expect(disagreeRow(["waited", "traded", "waited"])).toBeCloseTo(2 / 3, 12);
    expect(disagreeRow(["traded", "traded", "traded"])).toBe(0);
    expect(disagreeRow(["waited", "waited", "waited"])).toBe(0);
  });

  it("returns null below two replicates, and never 0", () => {
    // A one-replicate row contributes no pair. Returning 0 would enter it as a
    // measured agreement, and rows lose replicates by failing — which is not a
    // random sample of rows.
    expect(disagreeRow(["traded"])).toBeNull();
    expect(disagreeRow([])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. poolRate
// ---------------------------------------------------------------------------

describe("poolRate", () => {
  it("weights every row 1 — three replicates do not outweigh two", () => {
    const threeReplicates = disagreeRow(["traded", "traded", "waited"]);
    const twoReplicates = disagreeRow(["traded", "waited"]);
    const pooled = poolRate([threeReplicates as number, twoReplicates as number]);

    expect(pooled.n).toBe(2);
    expect(pooled.k).toBeCloseTo(2 / 3 + 1, 12);
    expect(pooled.rate).toBeCloseTo(5 / 6, 12);

    // What pooling PAIRS instead would have produced: (2 + 1) discordant pairs
    // over (3 + 1) pairs = 0.75. Pinned as the rejected alternative, because
    // the two differ only on rows that got extra replicates, and rows get
    // extra replicates by being retried after a failure.
    expect(pooled.rate).not.toBeCloseTo(0.75, 6);
  });

  it("returns NaN over zero rows rather than 0", () => {
    expect(Number.isNaN(poolRate([]).rate)).toBe(true);
  });

  it("throws rather than averaging a score that is not a rate", () => {
    expect(() => poolRate([0.5, Number.NaN])).toThrow(RangeError);
    expect(() => poolRate([1.5])).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// 3. wilson
// ---------------------------------------------------------------------------

describe("wilson", () => {
  it("pins the four boundary intervals the go/no-go is read off", () => {
    // 0/48 is the only result on 48 rows that clears the pre-registered 9%
    // upper bound; 1/48 already fails it. The numbers are why "anything but a
    // perfect run fails the primary condition" is a statement about arithmetic
    // and not a stance.
    const zero48 = wilson(0, 48);
    expect(zero48.lo).toBeCloseTo(0, 12);
    expect(zero48.hi).toBeCloseTo(0.07410, 5);
    expect(wilson(1, 48).hi).toBeCloseTo(0.10899, 5);

    // 40 rows is what stratifying preview-4 and v48-4 out of 48 leaves, and
    // its upper bound at zero sits on the 8.8% break-even rather than under it.
    // This single number can invert the go/no-go, which is why both n are
    // always printed.
    expect(wilson(0, 40).hi).toBeCloseTo(0.08762, 5);

    // 25 = the rows that publish today; 3 = the technical stratum.
    expect(wilson(0, 25).hi).toBeCloseTo(0.13319, 5);
    expect(wilson(0, 3).hi).toBeCloseTo(0.56150, 5);
  });

  it("does not degenerate at either boundary", () => {
    expect(wilson(0, 48).hi).toBeGreaterThan(0);
    expect(wilson(48, 48).lo).toBeLessThan(1);
  });

  it("refuses a denominator of zero and a k outside [0, n]", () => {
    expect(() => wilson(0, 0)).toThrow(RangeError);
    expect(() => wilson(49, 48)).toThrow(RangeError);
    expect(() => wilson(-1, 48)).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// 4. clopperPearson
// ---------------------------------------------------------------------------

describe("clopperPearson", () => {
  it("agrees with Wilson to a hundredth of a point at the boundary", () => {
    // The exact interval at 0/48 has the closed form 1 - (alpha/2)^(1/n); the
    // implementation reaches it through the regularised incomplete beta, so
    // this pins the continued fraction and the bisection, not just the answer.
    const exact = clopperPearson(0, 48);
    expect(exact.lo).toBe(0);
    expect(exact.hi).toBeCloseTo(0.07397, 5);

    // 7.410% against 7.397%. Wilson's approximation is not what decides the
    // go/no-go, and this is the evidence for saying so.
    expect(Math.abs(wilson(0, 48).hi - exact.hi)).toBeLessThan(0.0002);
  });

  it("reproduces the closed form at both degenerate ends", () => {
    expect(clopperPearson(0, 48).hi).toBeCloseTo(1 - Math.pow(0.025, 1 / 48), 10);
    expect(clopperPearson(48, 48).lo).toBeCloseTo(Math.pow(0.025, 1 / 48), 10);
    expect(clopperPearson(48, 48).hi).toBe(1);
  });

  it("brackets the point estimate away from the boundary", () => {
    const mid = clopperPearson(5, 48);
    expect(mid.lo).toBeLessThan(5 / 48);
    expect(mid.hi).toBeGreaterThan(5 / 48);
    // Exact is wider than Wilson away from the boundary; both are printed.
    expect(mid.hi).toBeGreaterThan(wilson(5, 48).hi);
  });

  it("refuses a fractional k, and a fractional n with it", () => {
    // An N>=3 run makes the per-row score fractional, and there is no binomial
    // tail past 1.5 successes. The report drops the intervals in that case
    // rather than letting a sum of fractions through.
    expect(() => clopperPearson(1.5, 48)).toThrow(RangeError);
    // Same reason on the other side: there is no binomial with 47.5 trials.
    // Wilson's guard is looser because Wilson is an approximation that degrades
    // gracefully; the exact interval would simply return a number.
    expect(() => clopperPearson(1, 47.5)).toThrow(RangeError);
    expect(() => clopperPearson(0, 0)).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// 5. the module surface — Wald is absent on purpose
// ---------------------------------------------------------------------------

describe("module surface", () => {
  it("exports exactly the eleven runtime symbols the design names", () => {
    expect(Object.keys(metric).sort()).toEqual([
      "MIN_CONFIDENCE",
      "classifyCell",
      "clopperPearson",
      "disagreeRow",
      "flipSensitivity",
      "levelSpreadAtr",
      "poolRate",
      "publishedProxy",
      "report",
      "spreadStats",
      "wilson",
    ]);
  });

  it("does not export a Wald interval", () => {
    // Wald at 0/48 is [0.0%, 0.0%]: it writes "we observed nothing" as "we
    // measured that there is nothing". Its absence is pinned rather than left
    // to taste, because it is the one interval a helpful hand would add back as
    // a convenience, and 0/48 is the outcome the design considers likely.
    expect(Object.keys(metric).some((k) => /wald/i.test(k))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. publishedProxy — the strict floor
// ---------------------------------------------------------------------------

const raw = (over: Partial<RawAnswer> = {}): RawAnswer => ({
  signal: "SELL",
  confidence: 64,
  stop: 157.2,
  tp1: 155.8,
  fundamental_score: 50,
  missingRequiredKeys: [],
  ...over,
});

describe("publishedProxy", () => {
  it("publishes a confidence of exactly 60 — the floor is strict", () => {
    // `analyze` computes `confidence < MIN_CONFIDENCE`, so 60 is on the
    // publishing side. This is the off-by-one that moves the whole flip table
    // one column: with `<=` the smallest downward jitter that flips any stored
    // row would read as 2 points instead of the measured 3.
    expect(MIN_CONFIDENCE).toBe(60);
    expect(publishedProxy(raw({ signal: "SELL", confidence: 60 }))).toBe("traded");
    expect(publishedProxy(raw({ signal: "SELL", confidence: 59 }))).toBe("waited");
    expect(publishedProxy(raw({ signal: "BUY", confidence: 60 }))).toBe("traded");
  });

  it("calls the model's own WAIT a wait however confident it was", () => {
    expect(publishedProxy(raw({ signal: "WAIT", confidence: 95 }))).toBe("waited");
    expect(publishedProxy(raw({ signal: "WAIT", confidence: 10 }))).toBe("waited");
  });

  it("returns null rather than coercing an unreadable cell", () => {
    // These are the exact two coercions `normalizeAnalysis` performs — an
    // unreadable signal becomes "WAIT", an unreadable confidence becomes 0 —
    // and a harness that inherited them would score every broken response as
    // agreement-with-WAIT and report a floor below the truth.
    expect(publishedProxy(raw({ confidence: null }))).toBeNull();
    expect(publishedProxy(raw({ signal: null }))).toBeNull();
    // Out of the schema's enum. Checked before the floor deliberately: a
    // garbage signal arriving with a low confidence must not be laundered into
    // a clean "waited".
    expect(publishedProxy(raw({ signal: "sell", confidence: 20 }))).toBeNull();
    expect(publishedProxy(raw({ signal: "SHORT", confidence: 90 }))).toBeNull();
  });

  it("refuses a confidence the schema never allowed, instead of clamping it", () => {
    // RESPONSE_SCHEMA declares `confidence: {type: "integer", description:
    // "0-100"}`, and `analyze` enforces that with
    // `clampInt(source.confidence, 0, 100, 0)` — Math.round after a clamp, no
    // trace left behind. Inheriting that here is the worst of the coercions,
    // not the mildest: a model answering on a 0-1 scale has BOTH replicates
    // rounded to the same side of the floor and scores as a clean agreement,
    // and every such row would push the measured floor down.
    expect(publishedProxy(raw({ confidence: 0.64 }))).toBeNull();
    expect(publishedProxy(raw({ confidence: 64.5 }))).toBeNull();
    expect(publishedProxy(raw({ confidence: 6400 }))).toBeNull();
    expect(publishedProxy(raw({ confidence: -1 }))).toBeNull();
    // The ends of the declared range are inside it.
    expect(publishedProxy(raw({ signal: "SELL", confidence: 100 }))).toBe("traded");
    expect(publishedProxy(raw({ signal: "SELL", confidence: 0 }))).toBe("waited");
  });
});

// ---------------------------------------------------------------------------
// 7. flipSensitivity against the 48 stored confidences
// ---------------------------------------------------------------------------

// The confidences of the frozen population, re-measured against production on
// 2026-09-09. Inlined as a dated literal because the population is frozen by
// design and a test that re-queried it would drift with the table.
//
// The confidence lives on `public.analyses.entry_check->>'confidence'` — a
// top-level jsonb column, NOT under `context` — and it equals the row's
// `analyses.confidence` on 48 of 48.
//
//   select string_agg((a.entry_check->>'confidence'), ', '
//                     order by (a.entry_check->>'confidence')::int, a.created_at)
//   from public.analysis_prompts p
//   join public.analyses a on a.id = p.analysis_id;
//
// 48 rows; range 38..68; 25 at or above the floor; ZERO in the 53..61 band.
const STORED_CONFIDENCES_2026_09_09 = [
  38, 40, 42, 42, 42, 42, 45, 45, 45, 45, 45, 45, 45, 45, 45, 45, 48, 48,
  52, 52, 52, 52, 52, 62, 63, 63, 63, 63, 64, 64, 64, 64, 64, 64, 64, 65,
  66, 66, 66, 66, 66, 66, 66, 66, 66, 68, 68, 68,
];

describe("flipSensitivity", () => {
  it("reproduces the population it is a literal of", () => {
    expect(STORED_CONFIDENCES_2026_09_09).toHaveLength(48);
    expect(STORED_CONFIDENCES_2026_09_09.filter((c) => c >= MIN_CONFIDENCE)).toHaveLength(25);
    // The empty band. Nothing production has ever returned sits in 53..61,
    // which is why the binary rate is censored and the spread is the headline.
    expect(STORED_CONFIDENCES_2026_09_09.filter((c) => c >= 53 && c <= 61)).toHaveLength(0);
  });

  it("matches the downward flip histogram measured on 2026-09-09", () => {
    // Re-measured directly in SQL under the STRICT floor, not derived from the
    // literal above:
    //
    //   with c as (select (a.entry_check->>'confidence')::int as conf
    //              from public.analysis_prompts p
    //              join public.analyses a on a.id = p.analysis_id),
    //        d as (select generate_series(0,10) as d)
    //   select d.d, count(*) filter (where c.conf >= 60 and c.conf - d.d < 60)
    //   from d cross join c group by d.d order by d.d;
    //
    // d:      0  1  2  3  4  5   6   7   8
    // flips:  0  0  0  1  5  12  13  22  22
    //
    // Nothing moves until 3 points, and 3 rather than 2 is a consequence of the
    // floor being strict: the single row at confidence 62 is the nearest to it,
    // at a distance of 2, and 62 - 2 = 60 still publishes.
    expect(flipSensitivity(STORED_CONFIDENCES_2026_09_09, 0)).toBe(0);
    expect(flipSensitivity(STORED_CONFIDENCES_2026_09_09, 1)).toBe(0);
    expect(flipSensitivity(STORED_CONFIDENCES_2026_09_09, 2)).toBe(0);
    expect(flipSensitivity(STORED_CONFIDENCES_2026_09_09, 3)).toBe(1);
    expect(flipSensitivity(STORED_CONFIDENCES_2026_09_09, 4)).toBe(5);
    expect(flipSensitivity(STORED_CONFIDENCES_2026_09_09, 5)).toBe(12);
    expect(flipSensitivity(STORED_CONFIDENCES_2026_09_09, 6)).toBe(13);
    expect(flipSensitivity(STORED_CONFIDENCES_2026_09_09, 7)).toBe(22);
    expect(flipSensitivity(STORED_CONFIDENCES_2026_09_09, 8)).toBe(22);
  });

  it("counts downward flips only", () => {
    // Measured on the same population: no upward flip is possible below 8
    // points, and at 8 exactly five rows move — the five sitting at 52. The
    // asymmetry is the finding, so it is not folded into one function.
    const belowFloor = STORED_CONFIDENCES_2026_09_09.filter((c) => c < MIN_CONFIDENCE);
    expect(belowFloor).toHaveLength(23);
    expect(belowFloor.filter((c) => c + 7 >= MIN_CONFIDENCE)).toHaveLength(0);
    expect(belowFloor.filter((c) => c + 8 >= MIN_CONFIDENCE)).toHaveLength(5);
    // flipSensitivity itself sees none of that: it answers about the published
    // side of the floor only.
    expect(flipSensitivity(belowFloor, 8)).toBe(0);
  });

  it("refuses a negative or unreadable jitter", () => {
    expect(() => flipSensitivity([64], -1)).toThrow(RangeError);
    expect(() => flipSensitivity([Number.NaN], 3)).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// 8. classifyCell
// ---------------------------------------------------------------------------

describe("classifyCell", () => {
  const call = (over: Partial<Parameters<typeof classifyCell>[0]>) =>
    classifyCell({
      httpStatus: 200,
      stopReason: "end_turn",
      parsed: fullBody(),
      requiredKeys: REQUIRED_KEYS,
      ...over,
    });

  it("scores a complete end_turn answer as the only ok", () => {
    const result = call({});
    expect(result.status).toBe("ok");
    expect(result.raw?.signal).toBe("SELL");
    expect(result.raw?.confidence).toBe(64);
    expect(result.raw?.missingRequiredKeys).toEqual([]);
  });

  it("calls max_tokens truncated even when the JSON parses", () => {
    // A body cut off at the token limit can still parse — an array closed
    // early, an object whose last complete member landed on a brace — and it
    // then reads as a perfectly good disagreement with its own replicate.
    // stop_reason is therefore checked BEFORE the parse, not after.
    const result = call({ stopReason: "max_tokens" });
    expect(result.status).toBe("truncated");
    expect(result.status).not.toBe("ok");
    // No fields handed back: a truncated body's values say where the budget ran
    // out, not what the model decided.
    expect(result.raw).toBeNull();
  });

  it("routes a refusal to its own class and hands back no fields", () => {
    // `stop_details` is the column the caller fills in THIS branch and no
    // other; classifyCell has no input for it at all, which is the structural
    // guarantee that a null there means "not that kind of ending" rather than
    // "that kind of ending with no details".
    const result = call({ stopReason: "refusal", parsed: null });
    expect(result.status).toBe("refusal");
    expect(result.raw).toBeNull();
  });

  it("does not coerce the raw answer of a missing-keys cell", () => {
    const missingWarnings = fullBody();
    delete missingWarnings.warnings;
    const result = call({ parsed: missingWarnings });

    expect(result.status).toBe("missing_keys");
    expect(result.raw?.missingRequiredKeys).toEqual(["warnings"]);
    // The two coercions that would silently sink the floor.
    expect(result.raw?.signal).toBe("SELL");
    expect(result.raw?.signal).not.toBe("WAIT");
    expect(result.raw?.confidence).toBe(64);
    expect(result.raw?.confidence).not.toBe(0);
  });

  it("reads an absent confidence as absent, never as 0", () => {
    const noConfidence = fullBody();
    delete noConfidence.confidence;
    const result = call({ parsed: noConfidence });

    expect(result.status).toBe("missing_keys");
    expect(result.raw?.missingRequiredKeys).toEqual(["confidence"]);
    expect(result.raw?.confidence).toBeNull();
    expect(publishedProxy(result.raw as RawAnswer)).toBeNull();
  });

  it("does not read a numeric string as a number", () => {
    // A prose field contract drifts into `"64"` long before it drifts into a
    // missing key, and parsing it would report a compliant response that never
    // happened. 45 of the 48 rows have only a prose contract.
    const stringy = call({ parsed: fullBody({ confidence: "64" }) });
    expect(stringy.status).toBe("ok");
    expect(stringy.raw?.confidence).toBeNull();
    expect(publishedProxy(stringy.raw as RawAnswer)).toBeNull();
  });

  it("treats a present-but-null required key as present", () => {
    // JSON Schema's `required` is about the member existing. The null value is
    // caught downstream by publishedProxy, so a type violation is reported as a
    // type violation and not as a missing key.
    const nulled = call({ parsed: fullBody({ signal: null }) });
    expect(nulled.status).toBe("ok");
    expect(nulled.raw?.missingRequiredKeys).toEqual([]);
    expect(publishedProxy(nulled.raw as RawAnswer)).toBeNull();
  });

  it("puts every other ending outside the measurement", () => {
    expect(call({ httpStatus: 500 }).status).toBe("http_error");
    expect(call({ httpStatus: 429 }).status).toBe("http_error");
    expect(call({ stopReason: "pause_turn" }).status).toBe("pause_exhausted");
    // An unrecognised or absent stop_reason defaults to "not a measurement".
    expect(call({ stopReason: "tool_use" }).status).toBe("parse_failed");
    expect(call({ stopReason: null }).status).toBe("parse_failed");
    expect(call({ parsed: "SELL" }).status).toBe("parse_failed");
    expect(call({ parsed: [fullBody()] }).status).toBe("parse_failed");
    expect(call({ parsed: null }).status).toBe("parse_failed");
    for (const bad of ["http_error", "pause_exhausted", "parse_failed"]) {
      expect(bad).not.toBe("ok");
    }
  });

  it("throws rather than scoring every response against an empty key list", () => {
    // The list arrives as a parameter so `metric.ts` can stay a leaf with no
    // imports, and that is exactly what makes it losable on the way in. An
    // empty list is not a lenient check but no check: every parsed record would
    // pass it, `missing_keys` would never fire again, and the failure class the
    // pre-registration names as the likeliest on the 45 prose-contract rows
    // would be reported as a measured zero.
    expect(() => call({ requiredKeys: [] })).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// 9. report — what it refuses to print
// ---------------------------------------------------------------------------

const cell = (
  analysisId: string,
  rep: number,
  over: Partial<ReportCell> = {},
): ReportCell => ({
  analysisId,
  rep,
  status: "ok",
  raw: raw(),
  stratum: "core",
  shape: "search_free_inline",
  ...over,
});

describe("report", () => {
  it("refuses a rate while the run is still in flight", () => {
    const result = report({
      expectedCells: 96,
      completedCells: 6,
      failedCells: 0,
      reps: 2,
      cells: [cell("a", 1), cell("a", 2), cell("b", 1), cell("b", 2)],
    });
    // A rate over the cells that happen to have finished is a rate whose
    // stopping time was chosen by whoever looked.
    expect(result.emitted).toBe(false);
    expect(result.refusal).toBe("run_incomplete");
    expect(result.pooled48).toBeNull();
    expect(result.core40).toBeNull();
    expect(result.spread).toBeNull();
  });

  it("refuses a row that has fewer than reps ok cells", () => {
    const result = report({
      expectedCells: 6,
      completedCells: 5,
      failedCells: 1,
      reps: 2,
      cells: [
        cell("a", 1), cell("a", 2),
        cell("b", 1), cell("b", 2),
        // One replicate landed, the other did not. The stopping rule says a
        // failing row is dropped on BOTH replicates, so a one-sided row can
        // only come from the rule not being followed.
        cell("c", 1), cell("c", 2, { status: "http_error", raw: null }),
      ],
    });
    expect(result.emitted).toBe(false);
    expect(result.refusal).toBe("partial_row");
    expect(result.pooled48).toBeNull();
    // The counts still come back, so the operator sees how many rather than
    // only that something was wrong.
    expect(result.exclusions.rowsPartial).toBe(1);
    expect(result.exclusions.rowsSeen).toBe(3);
    expect(result.failureRates.http_error).toBeCloseTo(1 / 6, 12);
  });

  it("excludes — and does not refuse — a row whose every replicate failed", () => {
    // This IS what the stopping rule prescribes: drop the row on both
    // replicates and report the count.
    const result = report({
      expectedCells: 6,
      completedCells: 4,
      failedCells: 2,
      reps: 2,
      cells: [
        cell("a", 1), cell("a", 2),
        cell("b", 1), cell("b", 2, { raw: raw({ confidence: 45 }) }),
        cell("c", 1, { status: "timeout", raw: null }),
        cell("c", 2, { status: "timeout", raw: null }),
      ],
    });
    expect(result.emitted).toBe(true);
    expect(result.refusal).toBeUndefined();
    expect(result.exclusions.rowsAllCellsFailed).toBe(1);
    expect(result.exclusions.rowsAdmitted).toBe(2);
    expect(result.pooled48?.n).toBe(2);
    // Row b split 64 (traded) against 45 (waited); row a agreed.
    expect(result.pooled48?.k).toBe(1);
    expect(result.pooled48?.rate).toBeCloseTo(0.5, 12);
    expect(result.pooled48?.wilson).not.toBeNull();
  });

  it("refuses a duplicated cell", () => {
    const result = report({
      expectedCells: 2,
      completedCells: 2,
      failedCells: 0,
      reps: 2,
      cells: [cell("a", 1), cell("a", 1)],
    });
    expect(result.emitted).toBe(false);
    expect(result.refusal).toBe("duplicate_cell");
  });

  it("refuses a row whose cells disagree about the shape or the stratum they were", () => {
    const shapeSplit = report({
      expectedCells: 2, completedCells: 2, failedCells: 0, reps: 2,
      cells: [cell("a", 1), cell("a", 2, { shape: "structured" })],
    });
    expect(shapeSplit.refusal).toBe("shape_disagreement");

    const stratumSplit = report({
      expectedCells: 2, completedCells: 2, failedCells: 0, reps: 2,
      cells: [cell("a", 1), cell("a", 2, { stratum: "v48" })],
    });
    expect(stratumSplit.refusal).toBe("stratum_disagreement");
  });

  it("refuses when nothing survives, rather than printing 0%", () => {
    const result = report({
      expectedCells: 2,
      completedCells: 0,
      failedCells: 2,
      reps: 2,
      cells: [
        cell("a", 1, { status: "aborted", raw: null }),
        cell("a", 2, { status: "aborted", raw: null }),
      ],
    });
    expect(result.emitted).toBe(false);
    expect(result.refusal).toBe("no_admitted_rows");
    expect(result.failureRates.aborted).toBe(1);
    expect(result.failureRates.ok).toBe(0);
  });

  it("excludes a full row it cannot project, and says so", () => {
    const result = report({
      expectedCells: 4, completedCells: 4, failedCells: 0, reps: 2,
      cells: [
        cell("a", 1), cell("a", 2),
        // All 20 keys present — status ok — but a confidence that is not a
        // number. A model-output fact, not a harness bug, so it excludes.
        cell("b", 1), cell("b", 2, { raw: raw({ confidence: null }) }),
      ],
    });
    expect(result.emitted).toBe(true);
    expect(result.exclusions.rowsUnprojectable).toBe(1);
    expect(result.exclusions.rowsAdmitted).toBe(1);
  });

  it("prints the core stratum beside the pool, and every status at its rate", () => {
    const result = report({
      expectedCells: 6, completedCells: 6, failedCells: 0, reps: 2,
      cells: [
        cell("a", 1), cell("a", 2, { raw: raw({ confidence: 45 }) }),
        cell("b", 1, { stratum: "v48" }), cell("b", 2, { stratum: "v48" }),
        cell("c", 1, { stratum: "preview" }), cell("c", 2, { stratum: "preview" }),
      ],
    });
    expect(result.emitted).toBe(true);
    expect(result.pooled48?.n).toBe(3);
    expect(result.pooled48?.k).toBe(1);
    // Stratifying the two 4-row strata out is what turns 48 into 40, and 0/40's
    // Wilson upper sits on the break-even rather than under it.
    expect(result.core40?.n).toBe(1);
    expect(result.core40?.k).toBe(1);
    expect(result.byShape?.search_free_inline.n).toBe(3);
    // Every one of the nine statuses is a key even at zero: an absent key reads
    // as "not measured", a zero reads as "measured, and it did not happen".
    expect(Object.keys(result.failureRates).sort()).toEqual([
      "aborted", "http_error", "missing_keys", "ok", "parse_failed",
      "pause_exhausted", "refusal", "timeout", "truncated",
    ]);
    expect(result.failureRates.ok).toBe(1);
    expect(result.failureRates.truncated).toBe(0);
  });

  it("drops the intervals when the per-row score stops being binary", () => {
    // N=3 makes disagree_i fractional, and Wilson and Clopper-Pearson are
    // interval estimators for a binomial count. The pre-registration's answer
    // there is a row-level bootstrap reported as a secondary; faking an
    // interval in the meantime is not this function's job.
    const result = report({
      expectedCells: 3, completedCells: 3, failedCells: 0, reps: 3,
      cells: [
        cell("a", 1),
        cell("a", 2),
        cell("a", 3, { raw: raw({ confidence: 45 }) }),
      ],
    });
    expect(result.emitted).toBe(true);
    expect(result.pooled48?.k).toBeCloseTo(2 / 3, 12);
    expect(result.pooled48?.wilson).toBeNull();
    expect(result.pooled48?.clopperPearson).toBeNull();
  });

  it("drops them on fractional scores that happen to sum to a whole number", () => {
    // The trap the previous line does not catch. At N=4 a row splitting 3-1
    // scores exactly (6 - 3 - 0)/6 = 0.5, so two such rows sum to exactly 1 and
    // an "is the total an integer" test would wave them through — printing a
    // binomial interval for "1 disagreeing row of 2" when neither row was
    // binary and neither disagreement was whole. Whether an interval may be
    // printed is a property of the per-row scores, not of their sum.
    const four = (id: string): ReportCell[] => [
      cell(id, 1), cell(id, 2), cell(id, 3),
      cell(id, 4, { raw: raw({ confidence: 45 }) }),
    ];
    const result = report({
      expectedCells: 8, completedCells: 8, failedCells: 0, reps: 4,
      cells: [...four("a"), ...four("b")],
    });
    expect(result.emitted).toBe(true);
    expect(result.pooled48?.k).toBe(1);
    expect(result.pooled48?.n).toBe(2);
    expect(result.pooled48?.wilson).toBeNull();
    expect(result.pooled48?.clopperPearson).toBeNull();
  });

  it("refuses a cell list shorter than the run the header describes", () => {
    // The completeness gate reads the header, and the header can be telling the
    // truth about a population larger than the one handed in: a PostgREST page
    // limit, a filter that dropped one status, a read that raced the header.
    // Every one of those arrives as a plausible rate over whatever survived,
    // with the run marked finished. Two rows of a 48-row run are two rows.
    const result = report({
      expectedCells: 96,
      completedCells: 96,
      failedCells: 0,
      reps: 2,
      cells: [cell("a", 1), cell("a", 2), cell("b", 1), cell("b", 2)],
    });
    expect(result.emitted).toBe(false);
    expect(result.refusal).toBe("cells_missing");
    expect(result.pooled48).toBeNull();
  });

  it("refuses an ok cell that carries no answer", () => {
    // `classifyCell` returns a non-null `raw` for exactly "ok" and
    // "missing_keys", so this combination cannot come from the taxonomy — it is
    // a harness fault. It refuses rather than excluding because the exclusion
    // path is for facts about the model's output: a systematic null here would
    // quietly drop every row and print a rate over whichever escaped the bug.
    const result = report({
      expectedCells: 4, completedCells: 4, failedCells: 0, reps: 2,
      cells: [cell("a", 1), cell("a", 2), cell("b", 1), cell("b", 2, { raw: null })],
    });
    expect(result.emitted).toBe(false);
    expect(result.refusal).toBe("ok_cell_without_raw");
  });

  it("throws on a reps below 2 instead of admitting one-replicate rows", () => {
    // At reps=1 every single-replicate row would satisfy `okCells.length ===
    // reps` — the row with no pair walking in through the gate built to keep it
    // out. The request contract caps reps at 2..3, so arriving here with 1 is a
    // bug and not a data condition.
    expect(() => report({
      expectedCells: 1, completedCells: 1, failedCells: 0, reps: 1,
      cells: [cell("a", 1)],
    })).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// 10. spreadStats
// ---------------------------------------------------------------------------

describe("spreadStats", () => {
  it("counts replicates landing in the 53-61 band, inclusive at both ends", () => {
    // Production has never returned a confidence in this band — zero of 48,
    // measured. If a replicate lands there, the hole was an artefact of 48
    // draws rather than a property of the analyst, and the spread has to go in
    // front of the binary rate in the write-up.
    const stats = spreadStats([
      [52, 62], // both outside: neither 52 nor 62 is in the band
      [53, 61], // both inside, at the two boundaries
      [61, 70], // one inside
    ]);
    expect(stats.inEmptyBand).toBe(3);
  });

  it("reports per-row max-min, and quantiles that some row actually had", () => {
    const stats = spreadStats([
      [64, 64], [64, 65], [60, 63], [50, 58], [45, 66],
    ]);
    expect(stats.n).toBe(5);
    expect(stats.max).toBe(21);
    // Nearest-rank, not interpolated: every quantile printed is an observed
    // spread. Sorted spreads are [0, 1, 3, 8, 21].
    expect(stats.median).toBe(3);
    expect(stats.p90).toBe(21);
    expect(stats.rowsWithSpreadGte[1]).toBe(4);
    expect(stats.rowsWithSpreadGte[3]).toBe(3);
    expect(stats.rowsWithSpreadGte[8]).toBe(2);
  });

  it("throws rather than calling a single replicate a spread of 0", () => {
    // A row that lost a replicate is the least stable kind of row; entering it
    // at zero spread would report it as the most stable.
    expect(() => spreadStats([[64]])).toThrow(RangeError);
    expect(() => spreadStats([])).toThrow(RangeError);
    expect(() => spreadStats([[64, Number.NaN]])).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// 11. levelSpreadAtr
// ---------------------------------------------------------------------------

describe("levelSpreadAtr", () => {
  it("divides the level distance by the row's own ATR", () => {
    expect(levelSpreadAtr(157.2, 157.0, 0.4)).toBeCloseTo(0.5, 12);
    // Order does not matter; it is a distance.
    expect(levelSpreadAtr(157.0, 157.2, 0.4)).toBeCloseTo(0.5, 12);
    // The measured extremes of entry_check.atr over the frozen population on
    // 2026-09-09 — min 0.04086612743522493, max 1.187892033252061, present and
    // positive on 48 of 48:
    //
    //   select min((a.entry_check->>'atr')::numeric),
    //          max((a.entry_check->>'atr')::numeric)
    //   from public.analysis_prompts p
    //   join public.analyses a on a.id = p.analysis_id;
    //
    // The same 0.2 gap is 4.89 ATR on the first row and 0.17 on the second, a
    // factor of 29.07. That is why a pips figure would mostly report which
    // timeframes happened to be in the sample.
    expect(levelSpreadAtr(157.2, 157.0, 0.04086612743522493)).toBeCloseTo(4.89403, 4);
    expect(levelSpreadAtr(157.2, 157.0, 1.187892033252061)).toBeCloseTo(0.168365, 5);
  });

  it("throws on a zero or negative ATR rather than returning Infinity", () => {
    // Infinity would flow into a mean and turn the whole level-distance table
    // into Infinity with no sign of which row did it; 0 would claim the two
    // levels were identical. An ATR that is not positive is a broken row.
    expect(() => levelSpreadAtr(157.2, 157.0, 0)).toThrow(RangeError);
    expect(() => levelSpreadAtr(157.2, 157.0, -0.4)).toThrow(RangeError);
    expect(() => levelSpreadAtr(157.2, 157.0, Number.NaN)).toThrow(RangeError);
    expect(() => levelSpreadAtr(Number.NaN, 157.0, 0.4)).toThrow(RangeError);
  });
});
