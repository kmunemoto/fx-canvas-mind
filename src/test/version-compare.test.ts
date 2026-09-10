import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  DELTA,
  EXACT_PAIRS_AT_ZERO_NOISE,
  Z_ALPHA_2,
  Z_BETA,
  mcnemarExact,
  pairsStillNeeded,
  requiredPairs,
} from "../../supabase/functions/version-compare/mcnemar";
import {
  armWasRight,
  eligibleForStage,
  pairVerdicts,
  screenMateriality,
  tallyMateriality,
  smallestMaterialCount,
  tallyPerformance,
  truthFor,
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
