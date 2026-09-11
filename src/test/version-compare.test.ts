import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  DELTA,
  EXACT_PAIRS_AT_ZERO_NOISE,
  Z_ALPHA_2,
  Z_BETA,
  mcnemarExact,
  nullDiscordantRate,
  pairsStillNeeded,
  requiredPairs,
} from "../../supabase/functions/version-compare/mcnemar";
import {
  ARM_ORDERS,
  ARMS,
  ARM_COUNT,
  armOrderForRow,
  armWasRight,
  armsShareTheSameBook,
  candidatePairs,
  controlPairs,
  eligibleForStage,
  pairVerdicts,
  screenAgainstControl,
  screenMateriality,
  tallyAgainstControl,
  tallyMateriality,
  smallestMaterialCount,
  tallyPerformance,
  tripleVerdicts,
  truthFor,
  type ArmTriad,
  type VerdictPair,
} from "../../supabase/functions/version-compare/pairing";
import { wilson } from "../../supabase/functions/noise-floor/metric";
import { spliceRulesBlock, LOCALE } from "../../supabase/functions/noise-floor/prompt-surgery";
import {
  MAX_PROMPT_RULES,
  promptCharBudget,
  renderLearnedRules,
  type Rule,
} from "../../supabase/functions/analyze/rules";
import { PLAN_CONTRACT } from "../../supabase/functions/_shared/contract";

const indexSrc = readFileSync("supabase/functions/version-compare/index.ts", "utf8");
const migrationSrc = readFileSync(
  "supabase/migrations/20260910180000_freeze_the_candidate_before_measuring_it.sql",
  "utf8",
);
// The migration that adds the control arm. A SECOND FILE and never an edit to
// the one above: 20260910180000 is applied to production, and a migration that
// has run is a record of what happened rather than a document to revise.
const controlMigrationSrc = readFileSync(
  "supabase/migrations/20260910200000_measure_the_floor_with_the_same_ruler.sql",
  "utf8",
);
const pairingSrc = readFileSync("supabase/functions/version-compare/pairing.ts", "utf8");
const mcnemarSrc = readFileSync("supabase/functions/version-compare/mcnemar.ts", "utf8");

// ---------------------------------------------------------------------------
// The exact binomial McNemar test
// ---------------------------------------------------------------------------

describe("mcnemarExact", () => {
  it("returns p = 1 with no direction when there are no discordant pairs", () => {
    const r = mcnemarExact(0, 0);
    expect(r.discordant).toBe(0);
    expect(r.pValue).toBe(1);
    // "tied", not "live_better". A run with no discordant pairs has no
    // direction, and handing the incumbent a default win is exactly the bias a
    // promotion gate must not have.
    expect(r.direction).toBe("tied");
    expect(r.significant).toBe(false);
    expect(r.underpowered).toBe(true);
  });

  it("is symmetric in b and c except for the direction it names", () => {
    const a = mcnemarExact(9, 2);
    const b = mcnemarExact(2, 9);
    expect(a.pValue).toBeCloseTo(b.pValue, 15);
    expect(a.direction).toBe("live_better");
    expect(b.direction).toBe("candidate_better");
  });

  it("reproduces the closed-form two-sided p for small m", () => {
    // m = 6, all on one side: 2 * 0.5^6 = 0.03125. This is the smallest m at
    // which a two-sided exact test can reach 0.05 at all, which is why
    // `underpowered` is defined at m < 6.
    const all6 = mcnemarExact(0, 6);
    expect(all6.pValue).toBeCloseTo(2 * Math.pow(0.5, 6), 15);
    expect(all6.significant).toBe(true);
    expect(all6.underpowered).toBe(false);

    // m = 5, all on one side: 2 * 0.5^5 = 0.0625, which does NOT reach 0.05.
    const all5 = mcnemarExact(0, 5);
    expect(all5.pValue).toBeCloseTo(0.0625, 15);
    expect(all5.significant).toBe(false);
    expect(all5.underpowered).toBe(true);

    // m = 10, b = 2: 2 * (C(10,0)+C(10,1)+C(10,2)) / 2^10 = 2 * 56/1024.
    expect(mcnemarExact(2, 8).pValue).toBeCloseTo(2 * 56 / 1024, 15);

    // An even split is as unsurprising as it gets: p is capped at 1.
    expect(mcnemarExact(5, 5).pValue).toBe(1);
  });

  it("stays accurate at a discordant count where a binomial coefficient would not fit comfortably", () => {
    // C(200, 100) is about 9e58. The implementation steps the pmf
    // multiplicatively from 0.5^m rather than forming any coefficient, so this
    // has to come out at a sane probability rather than NaN or Infinity.
    const r = mcnemarExact(80, 120);
    expect(Number.isFinite(r.pValue)).toBe(true);
    expect(r.pValue).toBeGreaterThan(0);
    expect(r.pValue).toBeLessThan(1);
    expect(r.direction).toBe("candidate_better");
  });

  it("refuses fractional or negative counts instead of rounding them", () => {
    // A fractional b means the caller pooled something it should not have.
    // Rounding here would turn that into a published p-value.
    expect(() => mcnemarExact(1.5, 2)).toThrow(RangeError);
    expect(() => mcnemarExact(-1, 2)).toThrow(RangeError);
    expect(() => mcnemarExact(2, Number.NaN)).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// The sample-size arithmetic, pinned to the pre-registration
// ---------------------------------------------------------------------------

describe("requiredPairs", () => {
  it("uses the alpha and power the pre-registration fixed, written out rather than derived", () => {
    // A probit implementation here would invite a caller to pass an alpha
    // nobody pre-registered, which is the whole thing a pre-registered design
    // exists to prevent.
    expect(Z_ALPHA_2).toBeCloseTo(1.959964, 6);
    expect(Z_BETA).toBeCloseTo(0.841621, 6);
    expect(DELTA).toBe(0.20);
  });

  it("reproduces docs/NOISE_FLOOR_PREREGISTRATION.md section 4 row for row", () => {
    // These are the published table's own numbers. If either this
    // implementation or that document moves, one of them is now wrong and this
    // test is where it is noticed.
    const rows: Array<[number, number, number, number]> = [
      // p0, psi, K, required n
      [0.05, 0.900000, 1.232468, 38],
      [0.10, 0.833333, 1.293636, 51],
      [0.20, 0.750000, 1.344415, 73],
      [0.30, 0.700000, 1.365661, 94],
      [0.50, 0.642857, 1.383251, 134],
    ];
    for (const [p0, psi, k, pairs] of rows) {
      const got = requiredPairs(p0);
      expect(got.psi).toBeCloseTo(psi, 6);
      expect(got.k).toBeCloseTo(k, 6);
      expect(got.pairs).toBe(pairs);
    }
  });

  it("says 75 paired rows at the measured noise floor of 10/48", () => {
    // Section 12.5 published psi = 0.744918, K = 1.346851, n = 74.07 -> 75,
    // computed from the ROUNDED rate 0.2083 that the write-up quotes.
    const asPublished = requiredPairs(0.2083);
    expect(asPublished.psi).toBeCloseTo(0.744918, 6);
    expect(asPublished.k).toBeCloseTo(1.346851, 6);
    expect(asPublished.raw).toBeCloseTo(74.07, 1);
    expect(asPublished.pairs).toBe(75);

    // The unrounded rate the cells actually give, 10/48 = 0.208333..., differs
    // from the published psi in the fifth decimal and lands on the same
    // requirement. Both are asserted so that nobody has to wonder later whether
    // the rounding chose the answer.
    const exactRate = requiredPairs(10 / 48);
    expect(exactRate.psi).toBeCloseTo(0.744898, 6);
    expect(exactRate.pairs).toBe(75);
    expect(exactRate.exact).toBe(false);
  });

  it("takes the exact answer at zero noise rather than the formula's 20", () => {
    // At p0 = 0 the normal approximation degenerates (psi -> 1, the sqrt term
    // vanishes) and would understate the requirement by half, in the direction
    // that authorises a run which cannot conclude.
    const got = requiredPairs(0);
    expect(got.exact).toBe(true);
    expect(got.pairs).toBe(EXACT_PAIRS_AT_ZERO_NOISE);
    expect(got.pairs).toBe(39);
  });

  it("grows with the noise rate, because noise dilutes a paired test rather than biasing it", () => {
    const rates = [0.05, 0.10, 0.20, 0.30, 0.50];
    const pairs = rates.map((r) => requiredPairs(r).pairs);
    for (let i = 1; i < pairs.length; i += 1) {
      expect(pairs[i]).toBeGreaterThan(pairs[i - 1]);
    }
  });

  it("refuses a rate or a delta outside its domain", () => {
    expect(() => requiredPairs(1)).toThrow(RangeError);
    expect(() => requiredPairs(-0.01)).toThrow(RangeError);
    expect(() => requiredPairs(0.2, 0)).toThrow(RangeError);
  });
});

describe("pairsStillNeeded", () => {
  it("never reports a negative shortfall and counts pairs, not cells", () => {
    expect(pairsStillNeeded(75, 0)).toBe(75);
    expect(pairsStillNeeded(75, 48)).toBe(27);
    expect(pairsStillNeeded(75, 90)).toBe(0);
    expect(() => pairsStillNeeded(75, 1.5)).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// Eligibility: the time-series split
// ---------------------------------------------------------------------------

describe("eligibleForStage", () => {
  const freeze = "2026-09-10T05:53:53.335Z";
  const cut = "2026-09-12T00:00:00.000Z";

  it("admits any snapshot inside the population cut for the materiality stage", () => {
    // Stage A reads no outcome, so a snapshot the candidate was fitted on
    // cannot leak anything into it.
    expect(eligibleForStage({
      stage: "materiality",
      snapshotCreatedAt: "2026-09-06T07:55:24.000Z",
      freezeFrozenAt: freeze,
      populationFrozenAt: cut,
    })).toEqual({ ok: true });
  });

  it("refuses a pre-freeze snapshot for the performance stage", () => {
    // This is the leakage refusal. The candidate was written from lessons about
    // exactly these rows.
    expect(eligibleForStage({
      stage: "performance",
      snapshotCreatedAt: "2026-09-06T07:55:24.000Z",
      freezeFrozenAt: freeze,
      populationFrozenAt: cut,
    })).toEqual({ ok: false, reason: "snapshot_predates_freeze" });
  });

  it("refuses a snapshot written in the same instant as the freeze", () => {
    // STRICTLY after. A snapshot at the freeze instant is one whose position
    // relative to the freeze cannot be established from the record, and the
    // safe reading of "cannot establish" is "not admissible".
    expect(eligibleForStage({
      stage: "performance",
      snapshotCreatedAt: freeze,
      freezeFrozenAt: freeze,
      populationFrozenAt: cut,
    })).toEqual({ ok: false, reason: "snapshot_predates_freeze" });
  });

  it("admits a post-freeze snapshot for the performance stage", () => {
    expect(eligibleForStage({
      stage: "performance",
      snapshotCreatedAt: "2026-09-11T09:00:00.000Z",
      freezeFrozenAt: freeze,
      populationFrozenAt: cut,
    })).toEqual({ ok: true });
  });

  it("refuses a snapshot past the population cut on either stage", () => {
    for (const stage of ["materiality", "performance"] as const) {
      expect(eligibleForStage({
        stage,
        snapshotCreatedAt: "2026-09-13T00:00:00.000Z",
        freezeFrozenAt: freeze,
        populationFrozenAt: cut,
      })).toEqual({ ok: false, reason: "snapshot_after_population_cut" });
    }
  });

  it("refuses an unreadable timestamp instead of assuming it is fine", () => {
    expect(eligibleForStage({
      stage: "performance",
      snapshotCreatedAt: "not a date",
      freezeFrozenAt: freeze,
      populationFrozenAt: cut,
    })).toEqual({ ok: false, reason: "timestamp_unreadable" });
  });
});

// ---------------------------------------------------------------------------
// Pairs and the stage A screen
// ---------------------------------------------------------------------------

describe("pairVerdicts", () => {
  it("needs both arms; a half pair is not an agreement", () => {
    // Counting a half pair as agreement would bias the disagreement rate DOWN,
    // which is the direction that cancels a forward evaluation that should have
    // happened.
    expect(pairVerdicts({ analysisId: "a", live: "traded", candidate: null })).toBeNull();
    expect(pairVerdicts({ analysisId: "a", live: null, candidate: "waited" })).toBeNull();
    expect(pairVerdicts({ analysisId: "a", live: null, candidate: null })).toBeNull();
  });

  it("marks a pair as disagreeing only when the published decisions differ", () => {
    expect(pairVerdicts({ analysisId: "a", live: "traded", candidate: "waited" })?.disagree).toBe(true);
    expect(pairVerdicts({ analysisId: "a", live: "waited", candidate: "waited" })?.disagree).toBe(false);
  });
});

describe("tallyMateriality", () => {
  const pair = (live: "traded" | "waited", candidate: "traded" | "waited"): VerdictPair => ({
    analysisId: `${live}-${candidate}`,
    live,
    candidate,
    disagree: live !== candidate,
  });

  it("counts disagreeing pairs over pairs", () => {
    const t = tallyMateriality([pair("traded", "waited"), pair("waited", "waited"), pair("waited", "traded")]);
    expect(t.pairs).toBe(3);
    expect(t.disagreements).toBe(2);
    expect(t.rate).toBeCloseTo(2 / 3, 12);
  });

  it("returns NaN over zero pairs, never 0", () => {
    // Zero is precisely the number a reader would take for "the two books
    // agreed".
    expect(Number.isNaN(tallyMateriality([]).rate)).toBe(true);
  });
});

describe("screenMateriality", () => {
  // The pre-registered comparator: 10/48, Wilson 95% [11.73%, 34.26%].
  const floor = wilson(10, 48);

  it("uses the floor's interval and not its point estimate", () => {
    // A rate of 30% is above the floor's 20.83% POINT estimate and still well
    // inside its interval. Calling that material would promote a book on the
    // strength of a floor measurement that is itself twenty-two points wide.
    const observed = wilson(15, 50);
    expect(observed.lo).toBeLessThan(floor.hi);
    expect(screenMateriality({
      observedLo: observed.lo,
      observedHi: observed.hi,
      floorLo: floor.lo,
      floorHi: floor.hi,
    })).toBe("indistinguishable");
  });

  it("calls a change material only once its lower bound clears the floor's upper bound", () => {
    // 45 of 50 pairs disagreeing: lower bound 0.7684, floor upper bound 0.3426.
    const observed = wilson(45, 50);
    expect(screenMateriality({
      observedLo: observed.lo,
      observedHi: observed.hi,
      floorLo: floor.lo,
      floorHi: floor.hi,
    })).toBe("material");
  });

  it("refuses to interpret a rate clearly below the floor rather than calling it immaterial", () => {
    // Two arms cannot agree more than one arm agrees with itself unless
    // something about the instrument changed between the two runs. That is a
    // finding about the harness, not about the rulebook.
    const observed = wilson(0, 200);
    expect(screenMateriality({
      observedLo: observed.lo,
      observedHi: observed.hi,
      floorLo: floor.lo,
      floorHi: floor.hi,
    })).toBe("below_floor_investigate");
  });

  it("refuses bounds outside [0, 1]", () => {
    expect(() => screenMateriality({ observedLo: -0.1, observedHi: 0.5, floorLo: 0.1, floorHi: 0.3 }))
      .toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// Stage B scoring
// ---------------------------------------------------------------------------

describe("truthFor", () => {
  it("reads a settled trade first, and records that the source was the outcome", () => {
    expect(truthFor({ outcome: "win", waitVerdict: null })).toEqual({ truth: "trade_was_right", source: "outcome" });
    expect(truthFor({ outcome: "loss", waitVerdict: null })).toEqual({ truth: "wait_was_right", source: "outcome" });
  });

  it("prefers the settled outcome when a wait_check is also present", () => {
    // Two scorers on one row with nothing recording which one won would be a
    // pooled statistic nobody can take apart afterwards.
    expect(truthFor({ outcome: "win", waitVerdict: "correct" }))
      .toEqual({ truth: "trade_was_right", source: "outcome" });
  });

  it("falls back to the wait_check verdict, in the direction waits.ts defines", () => {
    expect(truthFor({ outcome: "skipped", waitVerdict: "missed" }))
      .toEqual({ truth: "trade_was_right", source: "wait_check" });
    expect(truthFor({ outcome: "skipped", waitVerdict: "correct" }))
      .toEqual({ truth: "wait_was_right", source: "wait_check" });
  });

  it("returns null for every state where the market did not answer the question", () => {
    // 'untriggered', 'pending', 'no_call' and 'unknown' are all "we do not
    // know", which is not the same fact as "waiting was right" — and the
    // vocabulary in production carries all four (measured 2026-09-10:
    // wait_check verdicts correct 24, missed 11, no_call 6, unknown 3).
    for (const [outcome, waitVerdict] of [
      ["untriggered", null],
      ["pending", null],
      ["skipped", "no_call"],
      ["skipped", "unknown"],
      ["skipped", "pending"],
      [null, null],
      ["something_new", "something_else"],
    ] as Array<[string | null, string | null]>) {
      expect(truthFor({ outcome, waitVerdict })).toBeNull();
    }
  });
});

describe("armWasRight", () => {
  it("scores an arm against what the market vindicated", () => {
    expect(armWasRight("traded", "trade_was_right")).toBe(true);
    expect(armWasRight("waited", "trade_was_right")).toBe(false);
    expect(armWasRight("waited", "wait_was_right")).toBe(true);
    expect(armWasRight("traded", "wait_was_right")).toBe(false);
  });
});

describe("tallyPerformance", () => {
  const pair = (live: "traded" | "waited", candidate: "traded" | "waited", id: string): VerdictPair => ({
    analysisId: id,
    live,
    candidate,
    disagree: live !== candidate,
  });

  it("fills the 2x2 and keeps the discordant cells apart", () => {
    const t = tallyPerformance([
      // live right, candidate wrong -> b
      { pair: pair("traded", "waited", "1"), truth: { truth: "trade_was_right", source: "outcome" } },
      // live wrong, candidate right -> c
      { pair: pair("waited", "traded", "2"), truth: { truth: "trade_was_right", source: "outcome" } },
      // both right
      { pair: pair("waited", "waited", "3"), truth: { truth: "wait_was_right", source: "wait_check" } },
      // both wrong
      { pair: pair("traded", "traded", "4"), truth: { truth: "wait_was_right", source: "wait_check" } },
      // no truth at all
      { pair: pair("traded", "waited", "5"), truth: null },
    ]);
    expect(t.pairs).toBe(4);
    expect(t.b).toBe(1);
    expect(t.c).toBe(1);
    expect(t.bothRight).toBe(1);
    expect(t.bothWrong).toBe(1);
    expect(t.fromOutcome).toBe(2);
    expect(t.fromWaitCheck).toBe(2);
    // Reported, never dropped in silence: a run that replayed five rows and
    // could score four of them has not measured five rows.
    expect(t.unscorable).toBe(1);
  });

  it("splits the discordant cells by truth source, not only their totals", () => {
    // The two sources are different counterfactuals measured by different code,
    // and which one a row has is CORRELATED with the live arm's own verdict:
    // `outcome` exists only where production traded, `wait_check` only where it
    // waited. So a candidate that shifts decisions one way draws its discordant
    // pairs from one source, and a pooled b/c cannot be decomposed afterwards.
    const t = tallyPerformance([
      { pair: pair("traded", "waited", "1"), truth: { truth: "trade_was_right", source: "outcome" } },
      { pair: pair("traded", "waited", "2"), truth: { truth: "trade_was_right", source: "outcome" } },
      { pair: pair("waited", "traded", "3"), truth: { truth: "trade_was_right", source: "outcome" } },
      { pair: pair("waited", "traded", "4"), truth: { truth: "wait_was_right", source: "wait_check" } },
      { pair: pair("waited", "traded", "5"), truth: { truth: "wait_was_right", source: "wait_check" } },
    ]);
    // b: rows 1 and 2 (outcome), plus 4 and 5 (wait_check, live waited and the
    // wait was right, candidate traded).
    expect(t.b).toBe(4);
    expect(t.c).toBe(1);
    expect(t.bFromOutcome).toBe(2);
    expect(t.cFromOutcome).toBe(1);
    expect(t.bFromWaitCheck).toBe(2);
    expect(t.cFromWaitCheck).toBe(0);
    // The decomposition must add back up to the pooled cells, or the pooled
    // test and the sensitivity check would be describing different data.
    expect(t.bFromOutcome + t.bFromWaitCheck).toBe(t.b);
    expect(t.cFromOutcome + t.cFromWaitCheck).toBe(t.c);
    expect(t.fromOutcome + t.fromWaitCheck).toBe(t.pairs);
  });

  it("leaves the per-source cells at zero when a source contributed no discordant pair", () => {
    // Zero, not absent: a sensitivity check that silently omits a source reads
    // as "the other source was not consulted" rather than "it agreed".
    const t = tallyPerformance([
      { pair: pair("traded", "traded", "1"), truth: { truth: "trade_was_right", source: "wait_check" } },
      { pair: pair("traded", "waited", "2"), truth: { truth: "trade_was_right", source: "outcome" } },
    ]);
    expect(t.bFromWaitCheck).toBe(0);
    expect(t.cFromWaitCheck).toBe(0);
    expect(t.bFromOutcome).toBe(1);
  });

  it("counts a concordant pair without letting it reach the test", () => {
    // Both arms right, or both wrong, carries no information about which arm is
    // better; McNemar correctly ignores it, and this is where that is visible.
    const t = tallyPerformance([
      { pair: pair("traded", "traded", "1"), truth: { truth: "trade_was_right", source: "outcome" } },
      { pair: pair("waited", "waited", "2"), truth: { truth: "trade_was_right", source: "outcome" } },
    ]);
    expect(t.b + t.c).toBe(0);
    expect(mcnemarExact(t.b, t.c).discordant).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The two rendered books really can be spliced into a stored prompt
// ---------------------------------------------------------------------------

const rule = (over: Partial<Rule> & { id: string }): Rule => ({
  text_ja: `${over.id}のルール本文。`,
  text_en: `Rule text for ${over.id}.`,
  cause: "stop_too_tight",
  support: 3,
  scope: null,
  since: null,
  kind: "constraint",
  contract: PLAN_CONTRACT,
  evidence_contracts: [PLAN_CONTRACT],
  supported_by: [],
  ...over,
});

const renderBlock = (rules: Rule[], locale: "ja" | "en"): string =>
  renderLearnedRules(rules, locale, PLAN_CONTRACT, MAX_PROMPT_RULES, promptCharBudget(locale), null);

describe("the arms as they reach the wire", () => {
  const liveRules = [rule({ id: "r10" }), rule({ id: "r4" }), rule({ id: "r11", kind: "heuristic", support: 1 })];
  const candidateRules = [...liveRules, rule({ id: "r13", scope: "range regime" })];

  // A stored system prompt has the shape prompt-surgery measured on 48/48:
  // procedure, exactly one newline, then the heading, the fit note, and the
  // rule lines to end of string.
  const storedSystem = [
    "手順1-6の分析手順がここにある。",
    LOCALE.ja.rulesHeaders[0],
    LOCALE.ja.fitNote,
    "- ［1h/4h］古いルール本文。（実績2件・今の相場に該当）",
  ].join("\n");

  it("renders two different books to two different blocks", () => {
    const live = renderBlock(liveRules, "ja");
    const candidate = renderBlock(candidateRules, "ja");
    expect(live.length).toBeGreaterThan(0);
    expect(candidate.length).toBeGreaterThan(0);
    // The freeze refuses when these are equal: a run whose two arms send
    // identical system prompts would spend its whole budget measuring the noise
    // floor over again.
    expect(candidate).not.toBe(live);
  });

  it("renders unranked, so neither arm carries per-rule situation markers", () => {
    // This is the design decision index.ts argues at length. Re-computing a
    // rule's fit today would compare against today's market rather than the
    // snapshot's, and it would be computable for the live book and not for the
    // candidate's rules — two changes at once, and the pairing gone.
    const live = renderBlock(liveRules, "ja");
    expect(live).not.toContain(LOCALE.ja.fitNote);
    expect(live).not.toContain("今の相場に該当");
    expect(live).not.toContain("今は別局面");
    expect(live).not.toContain("今との照合不可");
  });

  it("produces a block spliceRulesBlock accepts, leaving everything before the seam untouched", () => {
    for (const rules of [liveRules, candidateRules]) {
      const block = renderBlock(rules, "ja");
      const spliced = spliceRulesBlock(storedSystem, block, "ja");
      expect("ok" in spliced && spliced.ok).toBe(true);
      if (!("system" in spliced)) throw new Error("splice refused");
      // The analytical procedure is what makes the two arms comparable at all.
      expect(spliced.system.startsWith("手順1-6の分析手順がここにある。\n")).toBe(true);
      expect(spliced.system.endsWith(block)).toBe(true);
      // The old rule text is gone: this is a replacement, not an append.
      expect(spliced.system).not.toContain("古いルール本文");
    }
  });

  it("splices the two arms to systems that differ only after the seam", () => {
    const liveSystem = spliceRulesBlock(storedSystem, renderBlock(liveRules, "ja"), "ja");
    const candidateSystem = spliceRulesBlock(storedSystem, renderBlock(candidateRules, "ja"), "ja");
    if (!("system" in liveSystem) || !("system" in candidateSystem)) throw new Error("splice refused");
    expect(liveSystem.blockStart).toBe(candidateSystem.blockStart);
    expect(liveSystem.system.slice(0, liveSystem.blockStart))
      .toBe(candidateSystem.system.slice(0, candidateSystem.blockStart));
    expect(liveSystem.system).not.toBe(candidateSystem.system);
  });
});

// ---------------------------------------------------------------------------
// Properties of the runner that are cheaper to pin than to re-measure
// ---------------------------------------------------------------------------

describe("the cost controls in version-compare/index.ts", () => {
  it("defaults dry_run to true, so only an explicit false can reach /v1/messages", () => {
    expect(indexSrc).toContain("const dryRun = body.dry_run !== false;");
  });

  it("keeps the 20-second, end-based call spacing that exists because a harness once starved a user", () => {
    expect(indexSrc).toContain("const MIN_CALL_SPACING_MS = 20_000;");
    // From the END of the previous call. Stamping the timestamp before
    // dispatch is what made the gap effectively zero on a ~30 s call.
    expect(indexSrc).toContain("const markCallEnded = () => {");
    expect(indexSrc).toContain("lastCallEndedAt = Date.now();");
  });

  it("carries the last call's end across a chain hop, so the spacing is not per-invocation", () => {
    // A chained run does about one billable cell per hop, so nearly every
    // billable call is an invocation's FIRST call — and a per-invocation local
    // starting at zero makes the 20 s a no-op for exactly those. The parent
    // tells the child when its last call ended.
    expect(indexSrc).toContain("last_call_ended_at: lastCallEndedAt,");
    expect(indexSrc).toContain("const handoffLastCallEnd = numberOrNull(body.last_call_ended_at);");
    // Validated, not trusted: a future or absurdly old value is ignored.
    expect(indexSrc).toContain("handoffLastCallEnd <= nowMs &&");
  });

  it("takes the spacing sleep before consulting the wall clock, not after", () => {
    // A sleep taken after the cell-start check spends time that check believed
    // was available: a cell could start with the minimum 80 s, sleep 20, and
    // have 60 left for a call the corpus says can take 72.
    expect(indexSrc).toContain("THE SPACING SLEEP HAPPENS HERE, BEFORE THE WALL CLOCK IS CONSULTED");
  });

  it("computes a call's timeout after the spacing sleep, so it cannot outlive its deadline", () => {
    expect(indexSrc).toContain("MEASURED AFTER THE SLEEP, NOT BEFORE IT");
    expect(indexSrc).toMatch(/await spaceCalls\(\);\s*\n\s*\n(\s*\/\/.*\n)+\s*const left = deadline - Date\.now\(\);/);
  });

  it("will not let an abort overwrite an operator's pause", () => {
    // Both stops end the spending; only one of them records what the operator
    // decided. Every status write on the run is conditional on 'running'.
    const unconditional = indexSrc.match(
      /patchRows\(\s*`version_compare_runs\?id=eq\.\$\{runId\}`,\s*\{\s*\n?\s*status:/g,
    );
    expect(unconditional).toBeNull();
    expect(indexSrc).toContain("abort_not_recorded:status_changed_under_us");
  });

  it("caps cells per invocation server-side rather than trusting the body", () => {
    expect(indexSrc).toContain("const MAX_CELLS_CAP = 4;");
    expect(indexSrc).toMatch(/max_cells must be an integer between 1 and \$\{MAX_CELLS_CAP\}/);
  });

  it("keeps a wall-clock budget with a write reserve, and will not start a cell that cannot finish", () => {
    expect(indexSrc).toContain("const WALL_CLOCK_BUDGET_MS = 130_000;");
    expect(indexSrc).toContain("const WRITE_RESERVE_MS = 10_000;");
    expect(indexSrc).toContain("const MIN_CELL_START_MS = 80_000;");
  });

  it("refuses to create a spending run without a completed dry run and two budgets", () => {
    expect(indexSrc).toContain("dry_run_id is required to create a run that calls the model");
    expect(indexSrc).toContain("budget_input_tokens is required and must be a positive integer");
    expect(indexSrc).toContain("budget_output_tokens is required and must be a positive integer");
    expect(indexSrc).toContain("the dry run did not finish counting its population");
  });

  it("guards the nine cron minutes, and no two of them are consecutive", () => {
    // The cell loop clears a guarded minute with ONE sleep, which is only
    // correct while the set has no run of two. A fifth cron job could break
    // that quietly.
    const match = indexSrc.match(/const CRON_MINUTES = new Set\(\[([^\]]*)\]\)/);
    expect(match).not.toBeNull();
    const minutes = (match?.[1] ?? "").split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
    expect(minutes).toEqual([3, 8, 13, 18, 23, 33, 38, 48, 53]);
    for (let i = 1; i < minutes.length; i += 1) {
      expect(minutes[i] - minutes[i - 1]).toBeGreaterThan(1);
    }
  });

  it("never writes the sweep token into a log line or a response", () => {
    // It appears exactly where it must: read from the RPC, compared, and sent
    // back out on the chain handoff header. Nowhere near console.* or the
    // summary object.
    for (const line of indexSrc.split("\n")) {
      if (!line.includes("console.")) continue;
      expect(line).not.toContain("sweepToken");
      expect(line).not.toContain("expectedToken");
    }
    expect(indexSrc).not.toMatch(/token:\s*(sweepToken|expectedToken)/);
  });

  it("compares a token in constant time and treats an empty expected value as a mismatch", () => {
    expect(indexSrc).toContain("constantTimeEqual(sweepToken, expectedToken)");
    expect(indexSrc).toContain("expectedToken.length === 0");
  });

  it("sends no tools on either arm, so the comparison is not contaminated by web drift", () => {
    expect(indexSrc).toContain('replayShape({ arm: "search_free", rowClass })');
    expect(indexSrc).toContain('arm: "search_free"');
    expect(indexSrc).not.toContain('arm: "search_on"');
  });
});

describe("the time-series split", () => {
  it("is a PostgREST filter on the wire, not a filter applied after the read", () => {
    // The requirement is that the split cannot be dropped by a refactor while
    // every test still passes. It goes out in the query string.
    expect(indexSrc).toContain("&created_at=gt.${encodeURIComponent(freezeFrozenAt)}");
    expect(indexSrc).toMatch(/runStage === "performance"\s*\n?\s*\? `&created_at=gt\./);
  });

  it("asks the pure rule as well, and refuses when the two disagree", () => {
    expect(indexSrc).toContain("eligibility_disagreement:");
  });

  it("is stated a third time as a trigger in the migration", () => {
    expect(migrationSrc).toContain("version_compare_runs_respect_the_split");
    expect(migrationSrc).toContain("a performance run must declare eligible_after >= the freeze instant");
    expect(migrationSrc).toContain("a materiality run must not declare eligible_after");
  });

  it("refuses a performance run that has nothing to replay yet, instead of creating an empty one", () => {
    expect(indexSrc).toContain("stage 'performance' is forward-only");
  });

  it("re-proves the split in report mode, on the path that actually emits the number", () => {
    // The three locks above all sit on the CREATION path. What decides which
    // rows get SCORED is notes.population.ids, and `notes` is deliberately
    // outside the trigger's column list, so a header whose id list was widened
    // by a later feature reaches report mode with every one of them silent.
    // The fourth check is the one that stands between that and a McNemar over
    // rows the candidate was fitted on.
    expect(indexSrc).toContain("THE SPLIT, RE-PROVED HERE, ON THE PATH THAT EMITS THE NUMBER");
    expect(indexSrc).toContain("stage_b_population_not_forward_only");
    // It re-reads the stamps rather than trusting the header.
    expect(indexSrc).toContain("read_failed:analysis_prompts_split_recheck");
    // And it asks the same pure rule the creation path asks.
    expect(indexSrc).toMatch(/eligibleForStage\(\{\s*\n\s*stage: "performance"/);
  });

  it("takes the LATER of the run's declared bound and the freeze's own instant", () => {
    // So the re-check stands even in a database where the trigger was never
    // applied, which is the state this migration is in until somebody runs it.
    expect(indexSrc).toContain("Math.max(Date.parse(declaredBound), Date.parse(freezeInstant))");
  });

  it("does not give a row with no readable timestamp the benefit of the doubt", () => {
    expect(indexSrc).toContain("no_prompt_row");
  });
});

describe("smallestMaterialCount", () => {
  const lo = (k: number, n: number) => wilson(k, n).lo;
  const floorHi = wilson(10, 48).hi;

  it("reports how large a disagreement the screen would actually need at this n", () => {
    // At today's corpus the screen cannot fire below 35 of 78, about 45%. This
    // is the number that decides whether a materiality run is worth its budget
    // at all, and it is not derivable from the verdict alone.
    const at78 = smallestMaterialCount({ pairs: 78, floorHi, wilsonLo: lo });
    expect(at78).not.toBeNull();
    expect(at78?.count).toBe(35);
    expect(at78?.rate).toBeCloseTo(35 / 78, 12);
  });

  it("falls as n grows, because the run's own interval narrows while the floor's does not", () => {
    const at78 = smallestMaterialCount({ pairs: 78, floorHi, wilsonLo: lo });
    const at156 = smallestMaterialCount({ pairs: 156, floorHi, wilsonLo: lo });
    const at300 = smallestMaterialCount({ pairs: 300, floorHi, wilsonLo: lo });
    expect(at156!.rate).toBeLessThan(at78!.rate);
    expect(at300!.rate).toBeLessThan(at156!.rate);
    // It never reaches the floor's point estimate: the comparator is the
    // floor's UPPER bound, so 20.83% is never on its own enough.
    expect(at300!.rate).toBeGreaterThan(10 / 48);
  });

  it("returns null rather than a number when no attainable count could clear the bound", () => {
    // n = 1 cannot produce a Wilson lower bound above 0.34 at any k. Null, not
    // zero and not `pairs`, because "no count would do" is not a count.
    expect(smallestMaterialCount({ pairs: 1, floorHi, wilsonLo: lo })).toBeNull();
    expect(smallestMaterialCount({ pairs: 0, floorHi, wilsonLo: lo })).toBeNull();
  });

  it("agrees with the screen it is describing", () => {
    // The threshold it reports must be exactly where screenMateriality flips,
    // or the disclosure would describe a different rule from the one that runs.
    const n = 78;
    const k = smallestMaterialCount({ pairs: n, floorHi, wilsonLo: lo })!.count;
    const floor = wilson(10, 48);
    const at = wilson(k, n);
    const below = wilson(k - 1, n);
    expect(
      screenMateriality({ observedLo: at.lo, observedHi: at.hi, floorLo: floor.lo, floorHi: floor.hi }),
    ).toBe("material");
    expect(
      screenMateriality({ observedLo: below.lo, observedHi: below.hi, floorLo: floor.lo, floorHi: floor.hi }),
    ).not.toBe("material");
  });
});

describe("the stopping rule", () => {
  it("seals the first look at which the population reaches the pre-registered n", () => {
    // Report mode is free and re-runnable while the scored-pair count keeps
    // growing, so without a rule an operator can look until the p-value is
    // small and publish that look. Looks below n were never capable of being
    // conclusive; the first look at or above it is the test.
    expect(indexSrc).toContain("stage_b_seal");
    expect(indexSrc).toContain("THE STOPPING RULE");
    // Conditional PATCH: two concurrent reports cannot seal two results.
    expect(indexSrc).toContain("&stage_b_seal=is.null");
  });

  it("takes `conclusive` from the seal and never from the fresh recount", () => {
    expect(indexSrc).toContain("conclusive: seal === null ? false : seal.conclusive === true");
  });

  it("makes the seal write-once in the database as well", () => {
    expect(migrationSrc).toContain("version_compare_runs_seal_is_write_once");
    expect(migrationSrc).toContain("before update of stage_b_seal on public.version_compare_runs");
    expect(migrationSrc).toContain("stage_b_seal jsonb");
  });

  it("says in the payload that a null result is not evidence of no improvement", () => {
    // psi = 0.7449 at the measured floor: the design is powered only for a
    // candidate that wins about three quarters of all discordant pairs. Any
    // real improvement smaller than that reads `significant: false`, and that
    // is the reading an owner reaches for first.
    expect(indexSrc).toContain("it does NOT mean not better");
    expect(indexSrc).toContain("powered_for_discordant_share");
  });

  it("emits the discordant cells per truth source as a sensitivity check, not as more tests", () => {
    expect(indexSrc).toContain("by_truth_source");
    expect(indexSrc).toContain("NOT a second and third test");
  });
});

describe("the migration", () => {
  it("puts RLS with no policy on all three tables and revokes them from the client roles", () => {
    for (const table of ["rulebook_candidate_freezes", "version_compare_runs", "version_compare_cells"]) {
      expect(migrationSrc).toContain(`alter table public.${table} enable row level security;`);
      expect(migrationSrc).toContain(`revoke all on public.${table} from public, anon, authenticated;`);
    }
    // A policy would be the wrong instrument: RLS with none denies every
    // non-service role, and service_role bypasses RLS.
    expect(migrationSrc).not.toMatch(/create policy/i);
  });

  it("refuses a ja-identical pair of books with a message, rather than a constraint 500", () => {
    // The digests a freeze is identified by, and `freeze_arms_differ`, are ja
    // only. renderBlock applies MAX_PROMPT_RULES and a per-locale character
    // budget, so two different rule arrays can collapse to one ja string while
    // their en blocks still differ. Under an `&&` that pair passed the
    // function's own refusal and came back from Postgres as an opaque 500.
    expect(indexSrc).toContain("if (renderedJa.live === renderedJa.candidate) {");
    expect(indexSrc).toContain("a freeze is identified by its ja digests");
    expect(indexSrc).not.toContain(
      "renderedJa.live === renderedJa.candidate && renderedEn.live === renderedEn.candidate",
    );
  });

  it("makes a freeze append-only with a trigger, because a policy cannot restrain service_role", () => {
    expect(migrationSrc).toContain("rulebook_candidate_freezes_are_immutable");
    expect(migrationSrc).toContain("before update or delete on public.rulebook_candidate_freezes");
  });

  it("refuses a freeze whose two books are the same, and a run whose counters exceed its expectation", () => {
    expect(migrationSrc).toContain("constraint freeze_arms_differ check (candidate_sha256 <> live_sha256)");
    expect(migrationSrc).toContain("version_compare_runs_cells_accounted_check");
  });

  it("claims a cell before spending on it, one per (run, row, arm)", () => {
    expect(migrationSrc).toContain("unique (run_id, analysis_id, arm)");
    expect(indexSrc).toContain("version_compare_cells?on_conflict=run_id,analysis_id,arm");
    expect(indexSrc).toContain("resolution=ignore-duplicates,return=representation");
  });

  it("lets one dry run authorise only one spending run", () => {
    expect(migrationSrc).toContain("version_compare_runs_one_spend_per_dry_run");
    expect(migrationSrc).toContain("where status in ('running', 'paused')");
  });

  it("stores digests and never prompt text", () => {
    expect(migrationSrc).toContain("system_sha256 text not null");
    expect(migrationSrc).toContain("user_sha256 text not null");
    expect(migrationSrc).toContain("rules_sha256 text not null");
    // The columns analysis_prompts was deliberately moved off a client-readable
    // table must not reappear here.
    expect(migrationSrc).not.toMatch(/^\s+system text/m);
    expect(migrationSrc).not.toMatch(/^\s+user text/m);
  });
});

describe("the two pure modules stay pure", () => {
  it("import nothing at all", () => {
    // Zero imports is what lets them be exercised with no Deno runtime, no
    // database and no possibility of reaching a table by accident.
    expect(pairingSrc).not.toMatch(/^import /m);
    expect(mcnemarSrc).not.toMatch(/^import /m);
    expect(pairingSrc).not.toMatch(/\bfrom ["']/);
    expect(mcnemarSrc).not.toMatch(/\bfrom ["']/);
  });

  it("do not carry a second copy of the Wilson interval", () => {
    // There is exactly one implementation of it in this repository, in
    // noise-floor/metric.ts, and the stage A screen takes its bounds as
    // arguments rather than recomputing them.
    for (const src of [pairingSrc, mcnemarSrc]) {
      expect(src).not.toContain("function wilson");
      expect(src).not.toContain("1.959963984540054");
    }
  });

  it("say in the payload, not only in the docs, that stage A is not a performance claim", () => {
    // Anyone reading the JSON is one copy-paste away from quoting it as one.
    expect(indexSrc).toContain("it is NOT evidence that either book is better");
  });
});

// ---------------------------------------------------------------------------
// The control arm: measuring the floor with the same ruler
// ---------------------------------------------------------------------------

describe("the arm vocabulary", () => {
  it("has three arms and one place that says how many", () => {
    // Every `rows * 2` in the runner became `rows * ARM_COUNT`. If the count
    // lived in more than one place, a budget or an expected_cells could be
    // left behind on the old number and a two-thirds-finished run would open
    // the reporting gate.
    expect(ARMS).toEqual(["live", "candidate", "live_b"]);
    expect(ARM_COUNT).toBe(3);
  });

  it("knows which pairs of arms must carry the same book and which must differ", () => {
    // live and live_b are the same frozen book by construction. If they ever
    // differ, the control is not a control and whatever it measures would be
    // published as the floor.
    expect(armsShareTheSameBook("live", "live_b")).toBe(true);
    expect(armsShareTheSameBook("live_b", "live")).toBe(true);
    expect(armsShareTheSameBook("live", "live")).toBe(true);
    // Everything involving the candidate must differ, or the cell is not a
    // comparison at all.
    expect(armsShareTheSameBook("live", "candidate")).toBe(false);
    expect(armsShareTheSameBook("candidate", "live")).toBe(false);
    expect(armsShareTheSameBook("candidate", "live_b")).toBe(false);
    expect(armsShareTheSameBook("live_b", "candidate")).toBe(false);
  });
});

describe("tripleVerdicts", () => {
  it("needs all three arms; a row missing its control is not a row where the analyst agreed", () => {
    // Counting it as agreement would push the MEASURED FLOOR down, which makes
    // the candidate's disagreement look larger by comparison — the direction
    // that promotes a rulebook.
    expect(tripleVerdicts({ analysisId: "a", live: "traded", candidate: "waited", liveB: null })).toBeNull();
    expect(tripleVerdicts({ analysisId: "a", live: null, candidate: "waited", liveB: "traded" })).toBeNull();
    expect(tripleVerdicts({ analysisId: "a", live: "traded", candidate: null, liveB: "traded" })).toBeNull();
  });

  it("sets the two paired observations from the live arm, which is the shared reference", () => {
    const t = tripleVerdicts({ analysisId: "a", live: "traded", candidate: "waited", liveB: "traded" });
    expect(t).not.toBeNull();
    // D_cand = 1: the candidate moved the answer.
    expect(t?.candidateDisagrees).toBe(true);
    // D_ctrl = 0: the same book, sent twice, agreed with itself.
    expect(t?.controlDisagrees).toBe(false);

    const u = tripleVerdicts({ analysisId: "b", live: "traded", candidate: "traded", liveB: "waited" });
    expect(u?.candidateDisagrees).toBe(false);
    // The control disagreeing is the whole point of having it: this is the
    // analyst changing its own answer with nothing swapped.
    expect(u?.controlDisagrees).toBe(true);
  });
});

describe("tallyAgainstControl", () => {
  const triad = (candidateDisagrees: boolean, controlDisagrees: boolean, id = "x"): ArmTriad => ({
    analysisId: id,
    live: "traded",
    candidate: candidateDisagrees ? "waited" : "traded",
    liveB: controlDisagrees ? "waited" : "traded",
    candidateDisagrees,
    controlDisagrees,
  });

  it("fills the paired 2x2 with b as CONTROL-only and c as CANDIDATE-only", () => {
    // THE ORIENTATION. An inverted b and c reverses the verdict, so it is
    // pinned with counts that could not be confused for each other.
    const rows = [
      triad(true, false, "c1"),
      triad(true, false, "c2"),
      triad(true, false, "c3"),
      triad(false, true, "b1"),
      triad(true, true, "both"),
      triad(false, false, "neither1"),
      triad(false, false, "neither2"),
    ];
    const t = tallyAgainstControl(rows);
    expect(t.rows).toBe(7);
    // c: the candidate disagreed and the control did not. Three of them.
    expect(t.c).toBe(3);
    // b: the control disagreed and the candidate did not. One.
    expect(t.b).toBe(1);
    expect(t.bothDisagree).toBe(1);
    expect(t.neitherDisagrees).toBe(2);
    // The two marginals share the denominator, which is what makes them
    // comparable at all.
    expect(t.candidateDisagreements).toBe(4);
    expect(t.controlDisagreements).toBe(2);
    expect(t.candidateRate).toBeCloseTo(4 / 7, 12);
    expect(t.controlRate).toBeCloseTo(2 / 7, 12);
    // Every row lands in exactly one cell of the 2x2.
    expect(t.b + t.c + t.bothDisagree + t.neitherDisagrees).toBe(t.rows);
  });

  it("returns NaN over zero rows, never 0", () => {
    // Zero is precisely the number a reader would take for "the analyst never
    // disagreed with itself", i.e. a perfect instrument.
    const t = tallyAgainstControl([]);
    expect(t.rows).toBe(0);
    expect(Number.isNaN(t.controlRate)).toBe(true);
    expect(Number.isNaN(t.candidateRate)).toBe(true);
  });

  it("feeds mcnemarExact in the orientation that calls c the material direction", () => {
    // This is the test that would fail if b and c were swapped anywhere
    // between the tally and the payload.
    const rows = [
      ...Array.from({ length: 9 }, (_, i) => triad(true, false, `c${i}`)),
      triad(false, true, "b0"),
    ];
    const t = tallyAgainstControl(rows);
    const test = mcnemarExact(t.b, t.c);
    expect(test.discordant).toBe(10);
    expect(test.pValue).toBeCloseTo(2 * (Math.pow(0.5, 10) * (1 + 10)), 12);
    expect(test.significant).toBe(true);
    // "candidate_better" in the generic test's vocabulary; in stage A it means
    // the candidate arm carries the discordant rows, i.e. MATERIAL.
    expect(test.direction).toBe("candidate_better");
    expect(
      screenAgainstControl({ b: t.b, c: t.c, significant: test.significant, underpowered: test.underpowered }),
    ).toBe("material");

    // Swapped, the same numbers must NOT read as material. If they did, the
    // orientation would not be load-bearing and an inversion would go unseen.
    const swapped = mcnemarExact(t.c, t.b);
    expect(
      screenAgainstControl({
        b: t.c,
        c: t.b,
        significant: swapped.significant,
        underpowered: swapped.underpowered,
      }),
    ).toBe("control_exceeds_candidate_investigate");
  });

  it("projects the triads into the two pair views without changing the disagreements", () => {
    const rows = [triad(true, false, "a"), triad(false, true, "b")];
    const cand = candidatePairs(rows);
    const ctrl = controlPairs(rows);
    expect(cand.map((p) => p.disagree)).toEqual([true, false]);
    expect(ctrl.map((p) => p.disagree)).toEqual([false, true]);
    // The control view puts the SECOND LIVE arm in the `candidate` slot so the
    // already-tested tallyPerformance can score one book against itself.
    expect(ctrl[1].candidate).toBe(rows[1].liveB);
    expect(cand[0].candidate).toBe(rows[0].candidate);
    // tallyMateriality over the candidate view is the raw candidate rate.
    expect(tallyMateriality(cand).disagreements).toBe(1);
  });
});

describe("screenAgainstControl", () => {
  it("never calls an underpowered run material", () => {
    // No split of fewer than six discordant rows can reach 0.05, so a screen
    // that fired on one would be firing on arithmetic that could not say no.
    const test = mcnemarExact(0, 5);
    expect(test.underpowered).toBe(true);
    expect(
      screenAgainstControl({ b: 0, c: 5, significant: test.significant, underpowered: test.underpowered }),
    ).toBe("indistinguishable");
  });

  it("reports 'indistinguishable' rather than 'the same' when the test does not reject", () => {
    const test = mcnemarExact(5, 6);
    expect(test.significant).toBe(false);
    expect(
      screenAgainstControl({ b: 5, c: 6, significant: test.significant, underpowered: test.underpowered }),
    ).toBe("indistinguishable");
  });

  it("calls a significant result in the wrong direction an instrument finding", () => {
    // A book cannot be more stable against a DIFFERENT book than against
    // itself. Reporting that as "immaterial" would bury it.
    const test = mcnemarExact(9, 0);
    expect(test.significant).toBe(true);
    expect(
      screenAgainstControl({ b: 9, c: 0, significant: test.significant, underpowered: test.underpowered }),
    ).toBe("control_exceeds_candidate_investigate");
  });

  it("refuses fractional or negative counts instead of rounding them", () => {
    expect(() => screenAgainstControl({ b: 1.5, c: 2, significant: true, underpowered: false })).toThrow(RangeError);
    expect(() => screenAgainstControl({ b: -1, c: 2, significant: true, underpowered: false })).toThrow(RangeError);
  });
});

describe("nullDiscordantRate", () => {
  it("is 2p(1-p): a stage A observation is itself a disagreement indicator", () => {
    // Under the null both indicators are Bernoulli(p); if they were
    // independent the pair would be discordant with probability 2p(1-p).
    expect(nullDiscordantRate(0)).toBe(0);
    expect(nullDiscordantRate(0.5)).toBe(0.5);
    expect(nullDiscordantRate(1)).toBe(0);
    expect(nullDiscordantRate(10 / 48)).toBeCloseTo(0.3298611111, 10);
  });

  it("asks for about 100 rows where the old one-proportion reading asked for 75", () => {
    // The relation to the pre-registered 75, stated as arithmetic rather than
    // as a claim. Same formula, same alpha, same power, same delta — the only
    // thing that changed is which rate is the discordant rate.
    const historical = 10 / 48;
    expect(requiredPairs(historical, DELTA).pairs).toBe(75);
    expect(requiredPairs(nullDiscordantRate(historical), DELTA).pairs).toBe(100);
  });

  it("still takes the exact answer when the measured floor is zero", () => {
    // A control arm that never disagreed with itself gives 2p(1-p) = 0, and
    // the formula degenerates there exactly as it does for stage B.
    const need = requiredPairs(nullDiscordantRate(0), DELTA);
    expect(need.exact).toBe(true);
    expect(need.pairs).toBe(EXACT_PAIRS_AT_ZERO_NOISE);
  });

  it("grows with the measured floor, so a noisier instrument buys fewer conclusions", () => {
    const at10 = requiredPairs(nullDiscordantRate(0.10), DELTA).pairs;
    const at2083 = requiredPairs(nullDiscordantRate(10 / 48), DELTA).pairs;
    const at30 = requiredPairs(nullDiscordantRate(0.30), DELTA).pairs;
    expect(at10).toBeLessThan(at2083);
    expect(at2083).toBeLessThan(at30);
  });

  it("refuses a rate outside [0, 1] instead of returning a negative requirement", () => {
    expect(() => nullDiscordantRate(-0.01)).toThrow(RangeError);
    expect(() => nullDiscordantRate(1.01)).toThrow(RangeError);
    expect(() => nullDiscordantRate(Number.NaN)).toThrow(RangeError);
  });
});

describe("the control arm in version-compare/index.ts", () => {
  it("counts three cells per row everywhere, from one constant", () => {
    // A `* 2` left anywhere is a run that opens the reporting gate with a
    // third of its cells missing.
    expect(indexSrc).toContain("frozenIds.length * ARM_COUNT");
    expect(indexSrc).toContain("population.length * ARM_COUNT");
    expect(indexSrc).toContain("expected_cells: ids.length * ARM_COUNT");
    expect(indexSrc).toContain("const expected = dryIds.length * ARM_COUNT");
    expect(indexSrc).not.toMatch(/\.length \* 2\b/);
    // The arms are iterated from the exported list, not from a literal pair.
    expect(indexSrc).not.toContain('["live", "candidate"] as const');
    expect(indexSrc).toContain("for (const arm of ARMS)");
  });

  it("sends the control arm the SAME rendered string, not a second render of the same rules", () => {
    // renderLearnedRules is deterministic, but "almost certainly identical" is
    // the wrong standard for the arm whose only job is to be identical.
    expect(indexSrc).toContain("live_b: jaLive");
    expect(indexSrc).toContain("live_b: enLive");
    expect(indexSrc).toContain("live_b: jaLiveSha");
    expect(indexSrc).toContain("live_b: enLiveSha");
  });

  it("proves the three pairing invariants in report mode instead of assuming them", () => {
    // All three arms agree on the question; live and live_b agree on BOTH the
    // rules digest and the system digest; candidate differs from live.
    expect(indexSrc).toContain("live.userSha !== candidate.userSha || live.userSha !== liveB.userSha");
    expect(indexSrc).toContain("live.rulesSha !== liveB.rulesSha || live.systemSha !== liveB.systemSha");
    expect(indexSrc).toContain("control_arm_is_not_identical_to_live");
    expect(indexSrc).toContain("if (live.rulesSha === candidate.rulesSha)");
    expect(indexSrc).toContain("same_book_both_arms");
  });

  it("refuses to buy a cell whose siblings say the control drifted", () => {
    // The cheap half of the same check, before the money is spent. The one
    // place that says which pairs must match is the pure function.
    expect(indexSrc).toContain("armsShareTheSameBook(cell.arm, otherArm)");
    expect(indexSrc).toContain("control_arm_carries_a_different_book:");
    expect(indexSrc).toContain("sibling_arm_carries_the_same_book:");
  });

  it("presents the raw rate, the measured floor and the paired test as three separate things", () => {
    expect(indexSrc).toContain("candidate_vs_live:");
    expect(indexSrc).toContain("control_vs_live:");
    expect(indexSrc).toContain("paired_mcnemar:");
    expect(indexSrc).toContain("THE MEASURED FLOOR");
    // The discordant cells are named in the payload, so the orientation cannot
    // be lost between the tally and the reader.
    expect(indexSrc).toContain("b_control_disagreed_candidate_did_not");
    expect(indexSrc).toContain("c_candidate_disagreed_control_did_not");
  });

  it("keeps 20.83% only as a labelled reference and lets it decide nothing", () => {
    expect(indexSrc).toContain("historical_floor_reference:");
    expect(indexSrc).toContain("MEASURED ON A DIFFERENT PROMPT RENDERING");
    expect(indexSrc).toContain("superseded_screen:");
    // The verdict comes from the paired test against the measured control.
    expect(indexSrc).toContain("const verdict = screenAgainstControl({");
    // And a control rate that differs from the borrowed one is itself surfaced.
    expect(indexSrc).toContain("measured_floor_differs");
    expect(indexSrc).toContain("measured_floor_direction");
  });

  it("sizes the stage B requirement from the floor this run measured", () => {
    expect(indexSrc).toContain("const need = requiredPairs(control.controlRate, DELTA);");
    expect(indexSrc).toContain("const needFromHistoricalFloor = requiredPairs(NOISE_FLOOR_RATE, DELTA);");
    // Sealed with the rate it was sized from, or a reader cannot tell whether
    // the number came from a measurement or from the constant.
    expect(indexSrc).toContain("required_pairs_noise_rate: need.noiseRate,");
    expect(indexSrc).toContain("required_pairs_from_historical_floor");
    // And it does not reopen optional stopping: the control rate is computed
    // from cells that are fixed once the run completes.
    expect(indexSrc).toContain("THIS DOES NOT REOPEN OPTIONAL STOPPING");
  });

  it("scores the control arm against the same truth as a floor under stage B's own b and c", () => {
    expect(indexSrc).toContain("const controlPerformance = tallyPerformance(controlScored);");
    expect(indexSrc).toContain("control_floor:");
    // A disclosure, not a correction: nothing subtracts one from the other.
    expect(indexSrc).toContain("b_live_right_control_wrong");
    expect(indexSrc).toContain("c_live_wrong_control_right");
  });

  it("refuses to resume or report on an aborted run", () => {
    expect(indexSrc).toContain("an aborted run cannot be resumed");
    expect(indexSrc).toContain('refusal: reportStatus === "aborted" ? "run_aborted" : "run_is_a_dry_run"');
  });
});

describe("the control-arm migration", () => {
  it("is a new file and does not edit the one that is already applied", () => {
    // 20260910180000 has run against production. A migration that has run is a
    // record of what happened, not a document to revise.
    expect(migrationSrc).toContain("arm text not null check (arm in ('live', 'candidate'))");
    expect(controlMigrationSrc).toContain("check (arm in ('live', 'candidate', 'live_b'))");
  });

  it("drops and recreates the check under one name, so it is safe to re-run", () => {
    // A CHECK constraint cannot be edited in place, and an `add constraint`
    // without the drop would fail on a second application.
    expect(controlMigrationSrc).toContain(
      "drop constraint if exists version_compare_cells_arm_check",
    );
    expect(controlMigrationSrc).toMatch(
      /add constraint version_compare_cells_arm_check\s*\n?\s*check \(arm in \('live', 'candidate', 'live_b'\)\)/,
    );
  });

  it("verifies the unique key admits a third arm rather than assuming it", () => {
    // The whole design rests on (run_id, analysis_id, arm). A key narrowed to
    // (run_id, analysis_id) would turn the control arm into a constraint
    // violation on the first cell of the first run.
    expect(controlMigrationSrc).toContain("'run_id,analysis_id,arm'");
    expect(controlMigrationSrc).toContain("the control arm cannot be claimed per (row, arm) without it");
  });

  it("corrects the comments the third arm made wrong", () => {
    expect(controlMigrationSrc).toContain("comment on table public.version_compare_runs is");
    expect(controlMigrationSrc).toContain("comment on column public.version_compare_cells.arm is");
    expect(controlMigrationSrc).toContain("comment on column public.version_compare_runs.expected_cells is");
    expect(controlMigrationSrc).toContain("rows x 3");
  });

  it("makes an aborted run terminal in the database as well as in the function", () => {
    expect(controlMigrationSrc).toContain("version_compare_runs_aborted_is_final");
    expect(controlMigrationSrc).toContain("before update of status on public.version_compare_runs");
  });

  it("leaves the freeze alone, because the control replays a book already frozen", () => {
    // live_b sends the live book that rulebook_candidate_freezes already
    // stores. Nothing about a third arm changes what was frozen.
    expect(controlMigrationSrc).not.toMatch(/alter table public\.rulebook_candidate_freezes/);
    expect(controlMigrationSrc).not.toMatch(/drop table/i);
    expect(controlMigrationSrc).not.toMatch(/create policy/i);
  });
});

describe("a row whose arm never reached the wire", () => {
  it("is counted as an unsent arm, not as a control that drifted", () => {
    // closeUnsent writes an empty rules digest so a refusal cannot be mistaken
    // for a measurement. With two arms a blank digest fell through harmlessly
    // — the candidate arm was required to DIFFER. The control arm is required
    // to MATCH, so the same blank would have read as an instrument alarm
    // raised by an ordinary skipped row.
    expect(indexSrc).toContain("const wasSent = (cell: { rulesSha: string }): boolean => cell.rulesSha.length > 0;");
    expect(indexSrc).toContain("if (!wasSent(live) || !wasSent(candidate) || !wasSent(liveB))");
    expect(indexSrc).toContain("rows_with_an_unsent_arm");
    // And closeUnsent is still the thing that writes the blank.
    expect(indexSrc).toContain('rulesSha: "",');
  });

  it("refuses a report whose control disagreed with itself on every row", () => {
    // At a control rate of 1 the sample-size formula has no defined answer and
    // every number downstream rests on that rate.
    expect(indexSrc).toContain("if (control.controlRate >= 1) {");
    expect(indexSrc).toContain("control_disagreed_on_every_row");
  });
});

// ---------------------------------------------------------------------------
// The order the three arms are sent in
// ---------------------------------------------------------------------------

describe("armOrderForRow", () => {
  it("offers every ordering of the three arms exactly once", () => {
    expect(ARM_ORDERS).toHaveLength(6);
    const seen = new Set(ARM_ORDERS.map((order) => order.join(",")));
    expect(seen.size).toBe(6);
    for (const order of ARM_ORDERS) {
      expect([...order].sort()).toEqual([...ARMS].sort());
    }
  });

  it("balances how far the candidate and the control comparisons sit from the reference", () => {
    // THIS IS THE WHOLE POINT OF THE PERMUTATION, and it is checked by
    // arithmetic rather than by trusting the comment.
    //
    // A chained run buys about one cell per hop, so a row's three cells are
    // three instants. The lag of a comparison is how many cell-slots separate
    // it from the 'live' arm. Sent in the declared order alone the control lag
    // is 2 on every row and the candidate lag is 1 on every row, so any drift
    // in the serving path lands entirely on the measured floor.
    let candidateLag = 0;
    let controlLag = 0;
    for (const order of ARM_ORDERS) {
      const live = order.indexOf("live");
      candidateLag += Math.abs(order.indexOf("candidate") - live);
      controlLag += Math.abs(order.indexOf("live_b") - live);
    }
    expect(candidateLag).toBe(8);
    expect(controlLag).toBe(8);
    expect(candidateLag).toBe(controlLag);

    // And the declared order on its own is exactly the imbalance being fixed.
    const declared = ARM_ORDERS[0];
    expect(declared).toEqual(["live", "candidate", "live_b"]);
    expect(Math.abs(declared.indexOf("candidate") - declared.indexOf("live"))).toBe(1);
    expect(Math.abs(declared.indexOf("live_b") - declared.indexOf("live"))).toBe(2);
  });

  it("gives one row the same order on every hop", () => {
    // The three cells of a row are claimed in separate invocations hours
    // apart, and each invocation rebuilds the pending list from scratch. An
    // order that differed between hops could not be recomputed from the record.
    const run = "3f1c1c1e-0000-4000-8000-000000000001";
    const row = "9a2b2b2e-0000-4000-8000-000000000002";
    const first = armOrderForRow(run, row);
    for (let i = 0; i < 25; i += 1) expect(armOrderForRow(run, row)).toEqual(first);
  });

  it("always returns a real permutation, whatever ids it is handed", () => {
    for (let i = 0; i < 400; i += 1) {
      const order = armOrderForRow(`run-${i}`, `row-${i * 7 + 1}`);
      expect(order).toHaveLength(ARM_COUNT);
      expect([...order].sort()).toEqual([...ARMS].sort());
    }
    // Empty strings are not a real input, but returning undefined for them
    // would be an index error at the one place a cell is created.
    expect([...armOrderForRow("", "")].sort()).toEqual([...ARMS].sort());
  });

  it("does not put every row of a run on one ordering", () => {
    // A hash that collapsed would leave the imbalance in place while looking
    // like it had been fixed.
    const run = "3f1c1c1e-0000-4000-8000-000000000001";
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) seen.add(armOrderForRow(run, `row-${i}`).join(","));
    expect(seen.size).toBe(6);
  });

  it("separates the run id from the row id, so ids cannot be chosen to collide", () => {
    expect(armOrderForRow("ab", "c")).not.toBe(undefined);
    // ("ab","c") and ("a","bc") would hash alike without the separator. They
    // are allowed to land on the same order by chance; what must not happen is
    // that the two keys are the SAME string.
    expect(`${"ab"}#${"c"}`).not.toBe(`${"a"}#${"bc"}`);
  });
});

describe("the arm order as index.ts uses it", () => {
  it("builds the pending list from the per-row order, not the declared one", () => {
    expect(indexSrc).toContain("for (const arm of armOrderForRow(runId, row.analysisId))");
    // The declared list is still what the arithmetic and the dry count use.
    expect(indexSrc).toContain("for (const arm of ARMS)");
  });
});

// ---------------------------------------------------------------------------
// A hop that cannot succeed does not hand the chain on
// ---------------------------------------------------------------------------

describe("the zero-progress guard", () => {
  it("marks the two breaks that will fail again on the next hop", () => {
    // Running before 20260910200000 is applied buys the first row's live and
    // candidate arms normally and then fails the live_b claim on the CHECK.
    // Without the flag, that failure was handed to a child, and to its child,
    // for max_chain_hops invocations.
    expect(indexSrc).toContain("let hardStop: string | null = null;");
    expect(indexSrc).toContain("hardStop = `claim_failed:${cell.arm}`;");
    expect(indexSrc).toContain("hardStop = `cell_write_failed:${cell.arm}`;");
  });

  it("refuses to chain and refuses to look like a success", () => {
    expect(indexSrc).toContain('if (chain && status === "running" && hardStop === null) {');
    expect(indexSrc).toContain("if (hardStop !== null) {");
    expect(indexSrc).toContain("return json(summarize(totals, false), 500);");
    expect(indexSrc).toContain("hard_stop: hardStop,");
  });

  it("leaves the ordinary zero-progress hops alone", () => {
    // A guarded cron minute and a hop with too little wall clock left must
    // keep chaining, or a run that meets one stalls forever.
    expect(indexSrc).toContain('skipped = "cron_minute";');
    expect(indexSrc).not.toContain('hardStop = "cron_minute"');
    expect(indexSrc).not.toMatch(/hardStop = .{0,40}wall_clock/);
  });
});

// ---------------------------------------------------------------------------
// An instrument alarm is not an ordinary skipped row
// ---------------------------------------------------------------------------

describe("the unsent-arm breakdown", () => {
  it("reads the refusal reason instead of only the blank digest", () => {
    expect(indexSrc).toContain('"tools_present,schema_in_prompt,shape,error_slice"');
    expect(indexSrc).toContain("refusal: typeof cell.error_slice === \"string\" ? cell.error_slice : \"\",");
  });

  it("names the three reasons that mean the harness caught itself", () => {
    // These are exactly the codes the pre-spend sibling check writes. A row
    // dropped for one of them is not attrition.
    expect(indexSrc).toContain("const INSTRUMENT_ALARMS = [");
    expect(indexSrc).toContain('"control_arm_carries_a_different_book:",');
    expect(indexSrc).toContain('"sibling_arm_carries_the_same_book:",');
    expect(indexSrc).toContain('"request_disagrees_with_sibling_arm:",');
  });

  it("counts them separately and pushes them into errors", () => {
    expect(indexSrc).toContain("rows_with_an_unsent_arm_on_an_instrument_alarm");
    expect(indexSrc).toContain("unsent_arm_reasons");
    expect(indexSrc).toContain("rows_dropped_on_instrument_alarm:");
  });
});

// ---------------------------------------------------------------------------
// What stage A says about its own power, and what `material` cannot mean
// ---------------------------------------------------------------------------

describe("stage A's own disclosures", () => {
  it("says whether the verdict was reached at the pre-registered n", () => {
    expect(indexSrc).toContain("rows_reach_required: stageANeed === null ? null : control.rows >= stageANeed.pairs,");
    expect(indexSrc).toContain("below_required_means");
  });

  it("states that the control bounds the byte-identical null and nothing wider", () => {
    // live_b differs from live by nothing; candidate differs by bytes. A
    // semantically null edit would also break that null, and this design has
    // no arm that separates the two.
    expect(indexSrc).toContain("what_material_does_not_separate");
    expect(indexSrc).toContain("semantically null edit");
  });
});
