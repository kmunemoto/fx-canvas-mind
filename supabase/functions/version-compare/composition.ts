// WHAT EACH ARM ACTUALLY SHOWED THE ANALYST.
//
// Why this module exists, in one sentence: a $22 run compared a book of three
// rules against a book of four, and what the analyst READ was three rules
// against two.
//
// The long version. `public.rulebook_candidate_freezes` stores
// `live_rule_count` and `candidate_rule_count`. Both are counts of the parsed
// BOOK — `parseRules(...).length`, taken before the contract filter. On the
// freeze that run 48fc15da used they read 3 and 4, and the only reading those
// two numbers support is "the candidate is the live book plus one".
//
// The truth was the opposite. Measured on 2026-09-12 from the frozen arrays:
//
//   live      book 3 rules -> SHOWN 3   (r10, r4, r11)
//   candidate book 4 rules -> SHOWN 2   (r4, r12)
//
// Candidate r10 and r13 carry `contract: null`, so `inForce` (analyze/rules.ts)
// dropped them before rendering. Both were stamped null because their ENGLISH
// text contains "market entry", one of postmortem/stamp.ts's
// ENTRY_LEVER_PHRASES. That veto is deliberate and documented. What was NOT
// recorded anywhere is that it fired on this comparison — so the candidate's
// only rule that argues for TRADING MORE (r13) was never shown to a single
// analyst in the entire billable run, and no artefact said so.
//
// The measured input tokens agree and leave no room to argue: on 82 of 82
// complete rows the candidate arm's prompt is shorter than the live arm's by
// exactly 118 tokens, variance zero.
//
// SO THE 39.0% CARRIES AT LEAST THREE MECHANISMS, not one: different rule
// text, one fewer rule, and — because live r10 is the book's leading
// over-extension WAIT constraint — a missing brake. The run cannot separate
// them, and until this module existed its own payload did not even say they
// were mixed.
//
// This is the same failure as `candidate_better` and as #83: a true number
// beside a label that reads as something else. The fix is the same one —
// make the artefact say what happened.
//
// ---------------------------------------------------------------------------
// HOW IT IS DERIVED, AND WHY IT DOES NOT TRUST ITSELF
// ---------------------------------------------------------------------------
//
// Every withholding reason below is reconstructed by walking the same three
// gates `selectPromptRules` walks, in the same order. A reconstruction can
// drift from the thing it reconstructs, and a drifted one here would print a
// confident account of a prompt that was never sent.
//
// So it does not get to be believed on its own. `composeArm` runs the REAL
// `selectPromptRules` as well, and if the ids it reconstructed are not exactly
// the ids production selected — same members, same order — it returns
// `agrees_with_renderer: false` and every consumer must print that instead of
// the breakdown. Refusing is the only honest move: the alternative is a
// plausible story about rules the analyst may not have seen.
//
// Deno-free on purpose, so src/test can import it directly.

import {
  inForce,
  orderRules,
  promptCharBudget,
  selectPromptRules,
  MAX_PROMPT_RULES,
  type Rule,
  type RuleLocale,
} from "../analyze/rules.ts";
import { stampFor } from "../postmortem/stamp.ts";

// Why a rule in the book did not reach the analyst. Ordered as the gates fire.
export type WithheldReason =
  // `inForce` dropped it: its stamp is not the contract in force. The stamp's
  // own reason travels beside this one — a rule held back for a phrase in its
  // English text is one edit from being usable, and a rule held back because
  // its cause cannot occur under the contract is not.
  | "contract_mismatch"
  // Its text normalised to nothing, so `selectPromptRules` mapped it to null
  // before the budget was consulted. A rule with no text is not a rule, but it
  // is also not a rule the contract rejected, and pooling the two would hide a
  // corrupt book inside a contract statistic.
  | "empty_text"
  // In force, non-empty, and still cut — by MAX_PROMPT_RULES or by the
  // character budget. This is the ONLY reason the rendered block itself
  // discloses (the held-back note), and it is the only one that goes away by
  // making the book shorter rather than by rewriting a rule.
  | "budget";

export interface WithheldRule {
  id: string;
  kind: string;
  reason: WithheldReason;
  // The contract stamp as STORED on the frozen rule. Null is the interesting
  // case and the reason this field is not folded into `reason`.
  stored_contract: string | null;
  // Recomputed by `stampFor` from the rule's own cause and text, which is the
  // only thing that ever writes that field. Null when the recomputation grants
  // the stamp, i.e. when the stored null and today's rules disagree.
  stamp_refusal: string | null;
  // True when the stored stamp and the recomputed one differ. Not an error
  // here — the phrase list and the cause taxonomy both move — but it means the
  // book was stamped under rules that are no longer the rules, and a reader
  // comparing this run to a later one needs to know that before doing it.
  stamp_recomputes_differently: boolean;
}

export interface ArmComposition {
  // What the freeze's *_rule_count columns report. Kept so the two numbers sit
  // side by side and the misreading cannot survive looking at them.
  rules_in_book: number;
  // What the analyst read.
  rules_shown: number;
  // In the order shown, which is the order they were read in.
  ids_shown: string[];
  withheld: WithheldRule[];
  // Rendered block length. The freeze already recorded this; it is repeated
  // here so one object answers the whole question.
  block_chars: number;
  // rules_in_book === rules_shown + withheld.length. False means this module
  // and `selectPromptRules` disagree about how many rules exist, which is a
  // defect in this module, not a finding about the book.
  counts_close: boolean;
  // False when the reconstructed ids are not exactly production's ids. See the
  // header: when this is false the breakdown above is not evidence.
  agrees_with_renderer: boolean;
}

// The gates of `selectPromptRules`, walked in its order, with a reason kept for
// every rule that falls out. `contract` is passed through rather than defaulted
// because a null contract shows every rule, and silently defaulting to that
// here would report a prompt nobody was sent.
export const composeArm = (
  rules: Rule[],
  locale: RuleLocale,
  contract: string | null,
  maxRules: number = MAX_PROMPT_RULES,
  maxChars: number = promptCharBudget(locale),
): ArmComposition => {
  const withheld: WithheldRule[] = [];

  const noteWithheld = (rule: Rule, reason: WithheldReason): void => {
    // `stampFor` answers exactly one question — could an analyst under this
    // contract carry this instruction out — and it is the only writer of
    // Rule.contract. Asking it again here is how the payload gets to name the
    // mechanism ("its English text moves a lever the contract does not have")
    // rather than only the symptom ("contract is null").
    const restamped = stampFor(
      { cause: rule.cause, text_ja: rule.text_ja, text_en: rule.text_en },
      contract,
    );
    withheld.push({
      id: rule.id,
      kind: rule.kind,
      reason,
      stored_contract: rule.contract,
      stamp_refusal: restamped.reason,
      stamp_recomputes_differently: restamped.contract !== rule.contract,
    });
  };

  // Gate 1 — the contract filter.
  //
  // Membership is decided by OBJECT IDENTITY, not by id. `inForce` is a
  // `.filter`, so the rules it keeps are the very same objects; a Set of ids
  // would lose a rule whose id is shared with a rule that survived, and a
  // review on 2026-09-12 reproduced exactly that — a book carrying r1 twice,
  // one stamped and one not, reported `withheld: []` and a rules_in_book of 2
  // against a rules_shown of 1. Duplicate ids should not reach here (the
  // consolidation schema forbids them and `parseRules` does not dedupe), which
  // is the reason to be identity-exact rather than to trust that they do not.
  const eligibleByContract = inForce(rules, contract);
  const keptByContract = new Set<Rule>(eligibleByContract);
  for (const rule of rules) {
    if (!keptByContract.has(rule)) noteWithheld(rule, "contract_mismatch");
  }

  // Gate 2 — empty text, checked in the SAME locale fallback order the
  // renderer uses (ja falls back to en and vice versa), because a rule with
  // text in one language only is shown, not dropped.
  const ordered = orderRules(eligibleByContract, {});
  const nonEmpty: Rule[] = [];
  for (const rule of ordered) {
    const raw = locale === "ja" ? rule.text_ja || rule.text_en : rule.text_en || rule.text_ja;
    if (raw.replace(/\s+/g, " ").trim().length === 0) {
      noteWithheld(rule, "empty_text");
      continue;
    }
    nonEmpty.push(rule);
  }

  // Gate 3 — the budget. Which rules survive it is production's answer, not a
  // second copy of the loop: re-implementing the give-back-a-rule-to-fit-the-
  // note step is exactly where a reconstruction would drift.
  const rendered = selectPromptRules(rules, locale, contract, maxRules, maxChars, null);
  const shownIds = rendered.ids;
  // Here the id IS the right key: `ids` is what selectPromptRules reports, and
  // it reports ids. On a duplicate-id book this bucket can therefore still be
  // wrong — which is what `counts_close` is for, and what the caller now gates
  // the whole breakdown on.
  const shownSet = new Set(shownIds);
  for (const rule of nonEmpty) {
    if (!shownSet.has(rule.id)) noteWithheld(rule, "budget");
  }

  // The cross-check. Same members AND same order: the order is what the
  // analyst read them in, and a breakdown that got the order wrong got the
  // ranking wrong.
  const reconstructed = nonEmpty.filter((r) => shownSet.has(r.id)).map((r) => r.id);
  const agrees = reconstructed.length === shownIds.length &&
    reconstructed.every((id, i) => id === shownIds[i]);

  return {
    rules_in_book: rules.length,
    rules_shown: shownIds.length,
    ids_shown: [...shownIds],
    withheld,
    block_chars: rendered.text.length,
    counts_close: rules.length === shownIds.length + withheld.length,
    agrees_with_renderer: agrees,
  };
};

// The one sentence a reader should not have to assemble from two counts.
//
// It names the DIRECTION, because that is the half the freeze's columns get
// wrong, and it refuses to say anything at all when the breakdown did not
// agree with the renderer.
export const readComposition = (
  live: ArmComposition,
  candidate: ArmComposition,
): string => {
  // BOTH self-checks, not one. The review that produced the blocker list in
  // index.ts also pointed out that this function honoured only the first —
  // and this function is exported, so a caller that does not build the
  // blocker list would still get a confident sentence off a breakdown that
  // does not add up.
  if (
    !live.agrees_with_renderer || !candidate.agrees_with_renderer ||
    !live.counts_close || !candidate.counts_close
  ) {
    return "the rule breakdown could not be reconciled with the renderer, so it is not reported; " +
      "treat the per-arm rule counts in this run as unknown rather than as equal";
  }
  const delta = candidate.rules_shown - live.rules_shown;
  if (delta === 0) {
    // EQUAL COUNTS ARE NOT A CLEAN BILL. They rule out one confound and leave
    // the other standing: the arms still differ in bytes, and nothing in a
    // three-arm design can tell "the new text means something different" from
    // "the text moved at all". Saying only "they differ in TEXT" would read as
    // reassurance, and a reader who stops there has been told the run
    // separated something it did not.
    return `both arms showed the analyst ${live.rules_shown} rules, so the disagreement rate is not carrying ` +
      "a difference in HOW MANY instructions the analyst got. It still cannot separate a difference in " +
      "MEANING from a difference in bytes: that needs a fourth arm carrying a perturbation of the live " +
      "book that changes no instruction.";
  }
  const direction = delta < 0 ? "FEWER" : "MORE";
  return `the candidate arm showed the analyst ${Math.abs(delta)} ${direction} rule(s) than the live arm ` +
    `(${candidate.rules_shown} against ${live.rules_shown}). The disagreement rate this run measures therefore ` +
    "carries a difference in HOW MANY instructions the analyst received as well as a difference in what they " +
    "said, and this run cannot separate the two. Read the withheld list for why each book rule did not reach " +
    "the prompt.";
};
