import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  composeArm,
  readComposition,
} from "../../supabase/functions/version-compare/composition.ts";
import { MAX_PROMPT_RULES, type Rule } from "../../supabase/functions/analyze/rules.ts";

// #65 spent $22 comparing a book of three rules against a book of four, and
// what the analyst READ was three rules against two. Nothing in the run's
// payload said so; the freeze's two *_rule_count columns are BOOK counts taken
// before the contract filter, so the only artefact of that run pointed the
// opposite way.
//
// These tests pin the module that ends that. The shape of the real defect —
// a rule whose contract stamp is null because its ENGLISH text names an entry
// lever, dropped silently while the Japanese beside it is fine — is the first
// case, because it is the one that actually happened.

const rule = (over: Partial<Rule> & { id: string }): Rule => ({
  text_ja: `ルール${over.id}の本文。ADXが20未満なら見送る。`,
  text_en: `Rule ${over.id}: skip the trade when ADX is below 20.`,
  cause: "direction_wrong",
  support: 2,
  scope: null,
  since: "2026-09-01T00:00:00.000Z",
  kind: "constraint",
  contract: "market_v1",
  // Required by Rule and read by `evidence()` on the render path. Omitting
  // them crashes selectPromptRules, which is how the first draft of this file
  // found out they are not optional.
  supported_by: [],
  evidence_contracts: ["market_v1"],
  ...over,
});

describe("what each arm actually showed the analyst", () => {
  it("counts what was RENDERED, not what is in the book", () => {
    // The exact shape of the #65 freeze: four book rules, two of them stamped
    // null, so two reach the prompt.
    const candidate = [
      rule({ id: "r10", contract: null }),
      rule({ id: "r4" }),
      rule({ id: "r12", kind: "heuristic", cause: "target_too_far" }),
      rule({ id: "r13", contract: null, kind: "heuristic", cause: "wait_missed_trade" }),
    ];
    const c = composeArm(candidate, "ja", "market_v1");
    expect(c.rules_in_book).toBe(4);
    expect(c.rules_shown).toBe(2);
    expect(c.ids_shown).toEqual(["r4", "r12"]);
    expect(c.withheld.map((w) => w.id).sort()).toEqual(["r10", "r13"]);
  });

  it("names the mechanism, not only the symptom", () => {
    // "contract is null" is the symptom. "its English text moves a lever this
    // contract does not have" is the thing an operator can act on — that rule
    // is one edit from being usable, and the bare null hid that for days once
    // already (postmortem/stamp.ts).
    const withEnglishLever = rule({
      id: "r13",
      contract: null,
      cause: "wait_missed_trade",
      kind: "heuristic",
      text_ja: "上位足が同方向でADX30超なら、伸び切り懸念で見送らず順張り。",
      text_en: "When higher timeframes agree, take the trend-direction market entry.",
    });
    const c = composeArm([rule({ id: "r4" }), withEnglishLever], "ja", "market_v1");
    const w = c.withheld.find((x) => x.id === "r13");
    expect(w?.reason).toBe("contract_mismatch");
    expect(w?.stamp_refusal).toBe("entry_lever_en");
    // The Japanese is sound. Recording the locale of the veto is the whole
    // point: a reader who only reads ja would otherwise see a rule that looks
    // perfectly followable and no explanation for its absence.
    expect(w?.stored_contract).toBeNull();
    expect(w?.stamp_recomputes_differently).toBe(false);
  });

  it("separates a cause the contract cannot produce from a phrase in the text", () => {
    // Two different refusals with two different remedies. Rewriting the text
    // fixes one and cannot fix the other, so pooling them would send an
    // operator to rewrite a rule that no rewrite can save.
    const deadCause = rule({ id: "r1", contract: null, cause: "entry_too_far" });
    const jaLever = rule({
      id: "r2",
      contract: null,
      text_ja: "押し目を待ってから指値で入る。",
      text_en: "Enter on a shallow retracement.",
    });
    const c = composeArm([rule({ id: "r4" }), deadCause, jaLever], "ja", "market_v1");
    expect(c.withheld.find((x) => x.id === "r1")?.stamp_refusal).toBe("cause_outside_contract");
    expect(c.withheld.find((x) => x.id === "r2")?.stamp_refusal).toBe("entry_lever_ja");
  });

  it("flags a stored stamp that today's rules would not grant", () => {
    // The phrase list and the cause taxonomy both move. A book stamped under
    // an older version of either is not wrong, but a reader comparing two runs
    // across such a change needs to know before doing it.
    const staleStamp = rule({
      id: "r9",
      // stored as followable...
      contract: "market_v1",
      // ...but the text names a lever, so stampFor would refuse it today
      text_ja: "押し目を待ってから入る。",
      text_en: "Wait for a pullback before entering.",
    });
    const c = composeArm([rule({ id: "r4" }), staleStamp], "ja", "market_v1");
    // It is still SHOWN — inForce reads the stored field, and this module
    // reports what happened rather than what should have.
    expect(c.ids_shown).toContain("r9");
    // The disagreement surfaces on the withheld list only, so a shown rule
    // with a stale stamp is not silently re-litigated here.
    expect(c.withheld).toHaveLength(0);
  });

  it("tells a budget cut apart from a contract veto", () => {
    // The rendered block discloses the budget cut and nothing else. Reporting
    // them as one number would let "the book is too long" and "the book is
    // full of rules this contract cannot use" look identical.
    const many = Array.from({ length: MAX_PROMPT_RULES + 3 }, (_, i) =>
      rule({ id: `r${i}`, kind: "heuristic", cause: "target_too_far" }));
    const c = composeArm(many, "ja", "market_v1");
    expect(c.rules_shown).toBeLessThan(many.length);
    expect(c.withheld.every((w) => w.reason === "budget")).toBe(true);
    expect(c.counts_close).toBe(true);
  });

  it("does not pool an empty rule into the contract count", () => {
    const blank = rule({ id: "rX", text_ja: "   ", text_en: "  \n " });
    const c = composeArm([rule({ id: "r4" }), blank], "ja", "market_v1");
    expect(c.withheld.find((x) => x.id === "rX")?.reason).toBe("empty_text");
  });

  it("closes its arithmetic on every shape above", () => {
    // in_book === shown + withheld. A breakdown that does not add up is a
    // defect in this module, and the field exists so it cannot be believed
    // while it is one.
    const books: Rule[][] = [
      [rule({ id: "a" })],
      [rule({ id: "a" }), rule({ id: "b", contract: null })],
      [rule({ id: "a" }), rule({ id: "b", text_ja: "", text_en: "" })],
      Array.from({ length: 20 }, (_, i) => rule({ id: `z${i}` })),
    ];
    for (const book of books) {
      const c = composeArm(book, "ja", "market_v1");
      expect(c.counts_close).toBe(true);
      expect(c.rules_in_book).toBe(c.rules_shown + c.withheld.length);
      expect(c.agrees_with_renderer).toBe(true);
    }
  });

  it("agrees with the renderer on the ORDER, not only the membership", () => {
    // The order is what the analyst read them in, and rules.ts puts
    // constraints first on purpose ("a rule that pushes toward execution never
    // buries the rule that holds it back"). A breakdown that got the order
    // wrong got the ranking wrong.
    const c = composeArm(
      [
        rule({ id: "h1", kind: "heuristic", cause: "target_too_far", support: 9 }),
        rule({ id: "c1", kind: "constraint", support: 1 }),
      ],
      "ja",
      "market_v1",
    );
    expect(c.ids_shown[0]).toBe("c1");
    expect(c.agrees_with_renderer).toBe(true);
  });

  it("reports an English-locale arm against the English budget", () => {
    // Both locales exist in the corpus, and the English budget is double. A
    // module that quietly charged ja's budget to an en arm would report rules
    // as cut that were shown.
    const book = Array.from({ length: 11 }, (_, i) =>
      rule({ id: `r${i}`, kind: "heuristic", cause: "target_too_far" }));
    const ja = composeArm(book, "ja", "market_v1");
    const en = composeArm(book, "en", "market_v1");
    expect(en.rules_shown).toBeGreaterThanOrEqual(ja.rules_shown);
    expect(en.agrees_with_renderer).toBe(true);
  });
});

describe("the sentence a reader should not have to assemble", () => {
  const live = () => composeArm([rule({ id: "a" }), rule({ id: "b" }), rule({ id: "c" })], "ja", "market_v1");

  it("names the direction when the arms showed different counts", () => {
    const candidate = composeArm(
      [rule({ id: "a" }), rule({ id: "b", contract: null }), rule({ id: "c", contract: null })],
      "ja",
      "market_v1",
    );
    const text = readComposition(live(), candidate);
    expect(text).toContain("FEWER");
    expect(text).toContain("2");
    // It must say what that does to the verdict, in the same sentence.
    expect(text).toContain("cannot separate");
  });

  it("says MORE when the candidate added rules, rather than only 'differ'", () => {
    const candidate = composeArm(
      [rule({ id: "a" }), rule({ id: "b" }), rule({ id: "c" }), rule({ id: "d" })],
      "ja",
      "market_v1",
    );
    expect(readComposition(live(), candidate)).toContain("MORE");
  });

  it("does not claim the arms are equal when the counts merely match", () => {
    // Equal counts do NOT mean the arms are comparable in every way — the text
    // still differs, and that is the thing a fourth arm exists to separate.
    const candidate = composeArm(
      [rule({ id: "a" }), rule({ id: "b" }), rule({ id: "x" })],
      "ja",
      "market_v1",
    );
    const text = readComposition(live(), candidate);
    expect(text).toContain("3");
    expect(text).toContain("fourth arm");
  });

  it("refuses to say anything when the breakdown did not reconcile", () => {
    // A wrong story about which rules the analyst saw is worse than no story.
    const broken = { ...live(), agrees_with_renderer: false };
    const text = readComposition(live(), broken);
    expect(text).toContain("could not be reconciled");
    expect(text).not.toContain("FEWER");
    expect(text).not.toContain("MORE");
  });

  it("refuses on the arithmetic check too, not only the renderer check", () => {
    // This function is exported. A caller that does not assemble index.ts's
    // blocker list would otherwise get a confident sentence off a breakdown
    // whose own numbers do not add up.
    const miscounted = { ...live(), counts_close: false };
    const text = readComposition(live(), miscounted);
    expect(text).toContain("could not be reconciled");
    expect(readComposition(miscounted, live())).toContain("could not be reconciled");
  });
});

describe("the freeze's rule-count columns cannot be read as prompt counts again", () => {
  const src = readFileSync("supabase/functions/version-compare/index.ts", "utf8");

  it("renames the two columns in every freeze response", () => {
    // The bare names are what invited "candidate = live + 1". Source-pinned
    // because the defect is a field name, and no unit test can see a caller
    // misread one.
    expect(src).toContain("candidate_rule_count_in_book:");
    expect(src).toContain("live_rule_count_in_book:");
    // The bare names survive in exactly ONE place each — the INSERT, where
    // they are the actual column names of rulebook_candidate_freezes and
    // renaming them would be a migration rather than a relabelling. Anywhere
    // else they would be a response field a caller reads as a prompt count.
    expect((src.match(/\bcandidate_rule_count:/g) ?? [])).toHaveLength(1);
    expect((src.match(/\blive_rule_count:/g) ?? [])).toHaveLength(1);
    const insert = src.slice(
      src.indexOf('insertRows("rulebook_candidate_freezes"'),
      src.indexOf("if (inserted === null"),
    );
    expect(insert).toContain("candidate_rule_count: candidateRules.length,");
    expect(insert).toContain("live_rule_count: liveRules.length,");
  });

  it("puts the composition in the report payload above every rate", () => {
    const stageA = src.slice(src.indexOf("const stageA = {"), src.indexOf("// ---- stage B"));
    expect(stageA).toContain("what_each_arm_showed: composition,");
    // Above candidate_vs_live, which is the first rate.
    expect(stageA.indexOf("what_each_arm_showed")).toBeLessThan(stageA.indexOf("candidate_vs_live"));
  });

  it("derives the report's composition from the freeze rather than a column", () => {
    // This is what lets the run that ALREADY finished be re-reported with the
    // answer, for the price of one row read and no model call.
    expect(src).toContain("const freezeForReport = await readFreeze(String(run.freeze_id));");
    expect(src).toContain("parseRules(freezeForReport.candidate_rules)");
  });

  it("says the composition is unavailable rather than omitting it", () => {
    // A missing caveat that nothing announces is the exact failure this whole
    // change exists to end, so the failure path may not be silence.
    expect(src).toContain('available: false,');
    expect(src).toContain("read_failed:rulebook_candidate_freezes:composition");
  });
});

// An adversarial review on 2026-09-12 found six things the first draft got
// wrong. Each one gets a test here, because the whole point of this module is
// that its output can be trusted without reading the code that produced it.

describe("the review findings, pinned so they cannot come back", () => {
  const src = readFileSync("supabase/functions/version-compare/index.ts", "utf8");

  it("does not lose a withheld rule whose id is shared with a shown one", () => {
    // The worst shape found: a book carrying one id twice, one copy stamped and
    // one not. Keying the kept set by id swallowed the vetoed twin, so the
    // payload said `withheld: []` on a book that withheld a rule.
    const twins = [
      rule({ id: "r1", contract: "market_v1" }),
      rule({ id: "r1", contract: null }),
    ];
    const c = composeArm(twins, "ja", "market_v1");
    expect(c.rules_in_book).toBe(2);
    expect(c.withheld).toHaveLength(1);
    expect(c.withheld[0].reason).toBe("contract_mismatch");
  });

  it("gates the whole report block, not one sentence in it", () => {
    // The defect this change exists to fix, reintroduced INSIDE the fix: the
    // first draft emitted `available: true` and a confident
    // what_this_does_to_the_verdict beside a `reading` that said the counts
    // were unknown. Two fields of one object contradicting each other.
    const block = src.slice(
      src.indexOf("let composition: JsonRecord = {"),
      src.indexOf("// ---- the three things the report must not blur"),
    );
    expect(block).toContain("const blockers: string[] = [];");
    expect(block).toContain("!liveComp.agrees_with_renderer || !candComp.agrees_with_renderer");
    expect(block).toContain("!liveComp.counts_close || !candComp.counts_close");
    // available:true and the verdict sentence must sit on the far side of the
    // blocker check, never beside it.
    expect(block).toContain("blockers.length > 0");
    // The FIELD, not the explanatory comment that also names it.
    expect(block.indexOf("blockers.length > 0"))
      .toBeLessThan(block.indexOf("what_this_does_to_the_verdict:"));
    // ...and it lives on the branch where blockers were empty, so the refusal
    // branch cannot carry a verdict at all.
    const refusal = block.slice(block.indexOf("blockers.length > 0"), block.indexOf(": {\n                what_this_is:"));
    expect(refusal).toContain("available: false,");
    expect(refusal).not.toContain("what_this_does_to_the_verdict:");
  });

  it("checks the re-render against the digest the freeze actually stored", () => {
    // agrees_with_renderer compares today's walk against today's renderer, so
    // it is silent about the renderer itself moving. The freeze's ja digests
    // are the only thing that can prove the breakdown describes the prompt
    // that was sent.
    const block = src.slice(
      src.indexOf("let composition: JsonRecord = {"),
      src.indexOf("// ---- the three things the report must not blur"),
    );
    expect(block).toContain("sha256Hex(renderBlock(liveBook, \"ja\"))");
    expect(block).toContain("freezeForReport.live_sha256");
    expect(block).toContain("freezeForReport.candidate_sha256");
    expect(block).toContain("const digestsMatch");
    // A mismatch must BLOCK, not merely annotate.
    expect(block).toContain("if (!digestsMatch) {");
  });

  it("composes the reused freeze from the STORED books, not the current ones", () => {
    // The candidate rulebook is rewritten by the postmortem sweep every few
    // hours. Composing today's books beside counts read from the stored row
    // would put a breakdown of one book next to the counts of another.
    expect(src).toContain("composeFrozen(existing[0].live_rules, existing[0].candidate_rules)");
  });

  it("does not log a book count under a name that reads as a prompt count", () => {
    const at = src.indexOf('console.log("version-compare freeze"');
    const log = src.slice(at, src.indexOf("});", at) + 3);
    expect(log).toContain("candidate_rules_in_book:");
    expect(log).toContain("candidate_rules_shown:");
    expect(log).not.toMatch(/candidate_rules: /);
    expect(log).not.toMatch(/live_rules: /);
  });

  it("leaves no dead import behind in prompt.ts", () => {
    const prompt = readFileSync("supabase/functions/postmortem/prompt.ts", "utf8");
    // causeOutsideContract was only ever used by stampFor, which moved.
    expect(prompt).not.toContain("causeOutsideContract");
    // ...and stamp.ts is where it is used now.
    expect(readFileSync("supabase/functions/postmortem/stamp.ts", "utf8")).toContain("causeOutsideContract");
  });

  it("carries the trust flag on the freeze-mode object too", () => {
    // Freeze mode's consumer is a human reading a response, who should not
    // have to open two nested objects to learn the breakdown is unreliable.
    expect(src).toContain("trustworthy: l.agrees_with_renderer && c.agrees_with_renderer");
  });
});
