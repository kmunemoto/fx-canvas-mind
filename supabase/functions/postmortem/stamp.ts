// THE ONLY WRITER OF Rule.contract.
//
// Lifted out of postmortem/prompt.ts on 2026-09-12, unchanged. Nothing about
// which rules are vetoed moved; only where the code lives did.
//
// WHY IT MOVED. version-compare needs to answer "why was this rule not shown
// to the analyst" in its report payload (see version-compare/composition.ts),
// and that answer is this function. Importing it from prompt.ts cost 42.8 KB
// of bundle for a fifteen-line function: prompt.ts's consolidation template
// literals interpolate imported constants, which defeats tree-shaking and
// drags facts.ts, analyze/entry.ts, analyze/indicators.ts and
// econ-calendar/events.ts in behind them. Measured with esbuild on
// 2026-09-12: importing `stampFor` from prompt.ts bundles to 42,836 bytes;
// importing `causeOutsideContract` from facts.ts, which is all this module
// needs, bundles to 838.
//
// So the stamp lives beside the taxonomy it consults rather than inside the
// prompt builder that happened to be its first caller. prompt.ts re-exports
// everything here, so every existing import keeps working and
// src/test/postmortem.test.ts still reaches it by the path it always used.
//
// Deno-free on purpose, like prompt.ts, so src/test can import it directly.

import { MARKET_CONTRACT, causeOutsideContract } from "./facts.ts";

// Vocabulary that names WHERE or WHEN to enter.
//
// Under market_v1 the server fills at the price of the moment; the analyst
// chooses direction, stop width, target width, and whether to trade at all.
// A rule whose text is ABOUT the entry price is unfollowable there whichever
// way it points — "wait for a pullback" and "do not wait for a pullback" are
// both instructions about a lever that does not exist, and the live rule r1
// was the second kind. So the test is topical, not directional: naming the
// lever is the defect.
//
// Matched on the VERB, never on the noun. An earlier draft listed
// 「エントリー価格」/"entry price", which reads as decisive until you notice
// that analyze's own market_v1 prompt says 「損切りと利確1/2/3を、与えられた
// エントリー価格の周りに決める」: under this contract the entry price is the
// house term for the GIVEN fill, the reference point every stop and target is
// measured from. A rule saying "place the stop at least 0.8xATR from the entry
// price" moves a lever the analyst really does have, and vetoing it would hold
// back the most followable rule the editor can write. Naming the price is
// required; choosing it is what does not exist.
//
// "market entry" WAS ON THIS LIST AND CAME OFF IT on 2026-09-12, with
// "limit plan" / "limit-based" / 指値プラン / 指値中心 put on in the same edit.
//
// The rule for this list is "does the text NAME a lever the contract does not
// have". "market entry" does not: under market_v1 the analyst decides whether
// to trade at all, so "skip the market entry" is the WAIT lever and "take the
// market entry with a 0.6-0.8 ATR stop" is the trade-or-not lever plus the
// stop-width lever. Both are moves the analyst really has. The phrase was
// matching a NOUN for the trade, not an instruction about where to enter.
//
// Measured over every rule that has ever existed in public.rulebook (live,
// candidate, history) and in both frozen books — the change flips exactly five
// rule texts and no others:
//
//   UN-VETOED, all three false positives, none of them touching a limit:
//     r10 direction_wrong   "skip the trend-direction market entry (WAIT)"
//     r13 wait_missed_trade "take the trend-direction market entry with a
//                            0.6-0.8x ATR stop"
//     r8  stop_too_tight    "keep the stop around 0.7 ATR"
//
//   NEWLY VETOED, and they should have been all along:
//     r5  plan_incoherent   "for limit plans, always assess the chance price
//                            never reaches the level" (x2 wordings)
//
// That second pair is a hole this edit closes rather than opens: "limit plans"
// matched neither "limit entry" nor "limit order", so those wordings were
// reaching the analyst under a contract that has no limit orders.
//
// WHY THE VETO WAS NEVER SEMANTIC, shown by the書き換え that happened while
// this was being investigated. The freeze used by run 48fc15da has
// r13 = "...take the trend-direction market entry with a 0.6-0.8x ATR stop"
// (stamped null, never shown to anyone). The candidate in the table on
// 2026-09-12 has r13 = "...take the trend with a 0.6-0.8 ATR stop" (stamped
// market_v1). Same instruction, same Japanese, different stamp. A filter whose
// verdict turns on which synonym the editor happened to pick is a lottery, and
// the thing it was deciding was whether the loop's only rule arguing for
// TRADING MORE reached an analyst at all.
//
// A floor, not a ceiling: it catches the vocabulary, not every paraphrase.
// The ceiling is one model call per REVISION (not per plan) asking of each
// emitted rule whether it moves one of the four levers. Until that exists this
// list is the floor, and the invariant test in src/test/postmortem.test.ts is
// what keeps the floor from eroding.
const ENTRY_LEVER_PHRASES: readonly string[] = [
  // ja — each names the act of choosing or timing the entry, not the price it
  // is measured from
  "押し目を待",
  "押し目まで待",
  "戻りを待",
  "戻りまで待",
  "戻り待ち",
  "指値で入",
  "指値でエントリー",
  "エントリーを引きつけ",
  "エントリーを引き付け",
  "引きつけて入",
  "引き付けて入",
  "成行で執行",
  "現値で執行",
  "どこで入る",
  "指値プラン",
  "指値中心",
  // en — matched lower-cased
  "wait for a pullback",
  "wait for the pullback",
  "wait for a retrace",
  "wait for the retrace",
  "limit entry",
  "limit order",
  "limit plan",
  "limit-based",
  "where to enter",
  "enter at market",
];

// Does this rule's text instruct a move the contract does not have?
export const unfollowableUnder = (text: string, contract: string | null): boolean => {
  if (contract !== MARKET_CONTRACT) return false;
  const hay = text.toLowerCase();
  return ENTRY_LEVER_PHRASES.some((phrase) => hay.includes(phrase));
};

// The only writer of Rule.contract.
//
// It answers the single question its only reader asks (analyze/rules.ts
// `inForce`): can an analyst working under `writingContract` carry this
// instruction out? Not "when was it written", not "where did the evidence come
// from". The two vetoes can only REFUSE a stamp, never grant one, and nothing
// is ever inherited — a rule's stamp is recomputed from its own cause and its
// own text on every parse, by both the emit path and the restore path.
//
// That is the whole fix: the field used to be handed the running build's
// PLAN_CONTRACT, so it recorded which era was current when the editor happened
// to run. Four rules learned entirely from entry_chosen_v1 evidence were
// stamped market_v1 that way, and one of them taught the analyst where to
// enter under a contract that fills at the market.
//
// It also SAYS WHY it refused. It used to return a bare null, and the silence
// cost days: candidate rule r12 (cause wait_missed_trade, support 2 — the only
// rule the loop has ever produced that argues for TRADING more) was stamped
// null and dropped out of every analyst prompt because its English text
// contains "market entry", one of ENTRY_LEVER_PHRASES. Rule r10, which argues
// for trading LESS, was vetoed by the identical phrase: the filter is topical,
// not directional. Nothing on the run recorded either fact, so the rule simply
// was not there and no artefact said so.
//
// The reason is a fact ABOUT the refusal, never a change to it: which rules are
// vetoed is exactly what it was.
export type StampRefusal =
  // the cause cannot occur under this contract, so no instruction about it can
  | "cause_outside_contract"
  // the Japanese text moves a lever the contract does not have
  | "entry_lever_ja"
  // the English text does — r12's case, with sound Japanese beside it
  | "entry_lever_en";

export interface Stamp {
  contract: string | null;
  // Null when a stamp was granted, and also when no contract was named at all:
  // a caller that asked no question got no refusal.
  reason: StampRefusal | null;
}

export const stampFor = (
  rule: { cause: string; text_ja: string; text_en: string },
  writingContract: string | null,
): Stamp => {
  if (writingContract === null) return { contract: null, reason: null };
  if (causeOutsideContract(rule.cause, writingContract)) {
    return { contract: null, reason: "cause_outside_contract" };
  }
  if (unfollowableUnder(rule.text_ja, writingContract)) {
    return { contract: null, reason: "entry_lever_ja" };
  }
  if (unfollowableUnder(rule.text_en, writingContract)) {
    return { contract: null, reason: "entry_lever_en" };
  }
  return { contract: writingContract, reason: null };
};
