// The rulebook: what the analyzer has learned from its own record.
//
// The postmortem function diagnoses every settled plan and consolidates the
// lessons into a short list of rules (public.rulebook). analyze puts those
// rules in front of the model on every call and records the rulebook version
// — and which rules actually fit in the prompt — on the plan, so the effect
// of a rule can be read off the outcomes that followed it instead of
// assumed.
//
// A rule's "support" is not what the model claims for it: it is the number of
// independent clusters of diagnosed plans behind it, computed by the
// postmortem function from the lessons the rule cites (supported_by). The
// prompt shows that number, and marks thinly-supported rules as under review,
// so the model does not read a rule written off one afternoon as settled law.
//
// Deno-free on purpose: the vitest suite imports this file directly, and the
// postmortem function shares the Rule shape.

import { UNCOMPARED } from "./situation.ts";
import type { RuleFit, RuleSituation } from "./situation.ts";

// A constraint says when not to trade or how to cap the risk; a heuristic
// says how to take the trade. Constraints are rendered first so a rule
// that pushes toward execution never buries the rule that holds it back.
export type RuleKind = "constraint" | "heuristic";

export interface Rule {
  id: string;
  text_ja: string;
  text_en: string;
  // The failure cause the rule addresses (see postmortem/facts.ts)
  cause: string;
  // Independent clusters of diagnosed plans behind it (server-computed)
  support: number;
  // Where it applies, in plain words ("1h/4h", "trend", "limit entries")
  scope: string | null;
  since: string | null;
  kind: RuleKind;
  // Which entry contract the analyst can actually CARRY THIS INSTRUCTION OUT
  // under. A rule is an instruction, and the analyst's available moves are set
  // by the contract: under entry_chosen_v1 it picked an entry price, under
  // market_v1 it cannot. So a rule about where to enter is unfollowable here
  // whichever way it points, and showing it spends prompt budget teaching a
  // move that does not exist.
  //
  // Derived by postmortem/prompt.ts `stampFor` from the rule's own cause and
  // its own text, on every path, every time. NEVER from when the rule was
  // written and never inherited from the stored book — a stamp that can be
  // inherited records which build was deployed when the editor last ran, which
  // is exactly the defect this field once had: four rules learned entirely
  // from entry_chosen_v1 evidence were stamped market_v1 because market_v1 was
  // current when the editor happened to run, and one of them taught the
  // analyst where to enter under a contract that fills at the market.
  //
  // null means no era endorses it. The rule stays in the book with its
  // evidence and its history; it is only held back from every prompt.
  //
  // This is the same refusal the statistics make: two contracts are two
  // populations, and a rulebook is a statistic about the analyst's mistakes.
  contract: string | null;
  // The entry contracts of the lessons this rule actually cites, deduped and
  // sorted. Observational: it never decides whether a rule reaches the prompt
  // (that is `contract`), only how the rule is LABELLED there. A rule whose
  // evidence all predates the current contract is still followable if its
  // cause and its text are — the evidence is just weaker, and the analyst is
  // told so rather than the fact being buried in jsonb.
  evidence_contracts: string[];
  // analysis ids of the lessons the rule was written from
  supported_by: string[];
}

export interface Rulebook {
  version: number;
  rules: Rule[];
  updated_at: string | null;
}

export type RuleLocale = "ja" | "en";

// Prompt real estate is not free: enough rules to matter, few enough to be
// read
export const MAX_PROMPT_RULES = 12;
// The character budget, per language. A character is not a fixed amount of
// prompt: Japanese runs about a token per character where English runs about
// four characters to the token, so the same twelve rules cost far less in
// English. Charging both languages 1600 characters therefore does not buy
// fairness — it silently shows the English analyst fewer rules for a smaller
// bill. The English budget is doubled and still the cheaper of the two.
export const MAX_PROMPT_CHARS = 1600;
export const MAX_PROMPT_CHARS_EN = 3200;
export const promptCharBudget = (locale: RuleLocale): number =>
  locale === "en" ? MAX_PROMPT_CHARS_EN : MAX_PROMPT_CHARS;
// A rule with this much support or less is shown as under review
export const VERIFYING_SUPPORT = 2;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v.trim() : fallback);

export const isRuleKind = (v: unknown): v is RuleKind => v === "constraint" || v === "heuristic";

// The stored rows are jsonb written by the postmortem function; read them
// defensively so a malformed rule cannot take analyze down with it
export const parseRules = (value: unknown): Rule[] => {
  if (!Array.isArray(value)) return [];
  const out: Rule[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const textJa = str(item.text_ja);
    const textEn = str(item.text_en);
    if (!textJa && !textEn) continue;
    const support = Number(item.support);
    out.push({
      id: str(item.id, `r${out.length + 1}`),
      text_ja: textJa || textEn,
      text_en: textEn || textJa,
      cause: str(item.cause, "unknown"),
      support: Number.isFinite(support) && support > 0 ? Math.round(support) : 1,
      scope: str(item.scope) || null,
      since: str(item.since) || null,
      contract: str(item.contract) || null,
      // Absent on rules written before the field existed -> [] -> no marker.
      // This is what lets a new analyze build read an un-backfilled book
      // without inventing an era it cannot know.
      evidence_contracts: Array.isArray(item.evidence_contracts)
        ? [...new Set(
          item.evidence_contracts.filter((v): v is string => typeof v === "string" && v.trim().length > 0)
            .map((v) => v.trim()),
        )].sort()
        : [],
      kind: isRuleKind(item.kind) ? item.kind : "heuristic",
      supported_by: Array.isArray(item.supported_by)
        ? item.supported_by.filter((v): v is string => typeof v === "string" && v.length > 0)
        : [],
    });
  }
  return out;
};

// How a rule's situation verdict weighs in the ordering. `unknown` sits above
// `off` deliberately: "we could not tell" must not be ranked below "we
// measured that it does not apply", or a rule whose evidence predates the
// snapshot would be cut before one we actually checked and ruled out.
const FIT_RANK: Record<RuleFit, number> = { match: 0, unknown: 1, off: 2 };

// Constraints first, then — when the situation has been measured — the rules
// that fit the market in front of us, then the best-supported; ties keep the
// stored order.
//
// The kind comparison stays outermost on purpose. A constraint says when NOT
// to trade, and the situation check is a comparison against the handful of
// plans a rule happens to have been drawn from, not a proof that the
// constraint is irrelevant. Letting a well-matched heuristic outrank a
// constraint would turn a thin match into permission.
export const orderRules = (
  rules: Rule[],
  fits: Record<string, RuleSituation> = {},
): Rule[] =>
  [...rules].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "constraint" ? -1 : 1;
    const fa = FIT_RANK[fits[a.id]?.fit ?? "unknown"];
    const fb = FIT_RANK[fits[b.id]?.fit ?? "unknown"];
    if (fa !== fb) return fa - fb;
    return b.support - a.support;
  });

const HEADERS: Record<RuleLocale, string> = {
  ja: "過去の判定から学んだルール（実際の値動きの検証から作成。上の手順とリスク規定が優先で、これらは同じ条件下での補助的な指針。「検証中」は根拠がまだ少ない）:",
  en: "Rules learned from past outcomes (drawn from reviews against actual prices; the procedure and risk limits above take precedence, these are supplementary guidance under the same conditions; \"under review\" means the evidence is still thin):",
};

// Said once, when at least one rule carries a situation marker: the marker is
// a measurement, not something the rule claims about itself. Without this the
// model has no way to tell the two apart, and a rule that asserts its own
// conditions in its text would read as if the server had confirmed them.
const FIT_NOTE: Record<RuleLocale, string> = {
  ja:
    "各ルールの「今の相場」判定は、そのルールの根拠になった過去の局面の実測値（ADX・RSI・SMA20乖離のATR倍・BB内の位置・上位足ADX）と現在値をサーバが機械的に比べた結果であって、ルール本文の主張ではない。判定できない場合はそう書く。",
  en:
    "The \"now\" verdict on each rule is a mechanical comparison the server made between today's readings and those measured on the past plans that rule was drawn from (ADX, RSI, distance from SMA20 in ATR, position in the Bollinger band, higher-timeframe ADX). It is not a claim made by the rule's own text, and it says so when it cannot tell.",
};

// What each verdict looks like inside a rule's evidence parenthesis.
const FIT_LABEL: Record<RuleLocale, Record<RuleFit, string>> = {
  ja: { match: "・今の相場に該当", off: "・今は別局面", unknown: "・今との照合不可" },
  en: { match: ", fits now", off: ", different situation now", unknown: ", cannot compare" },
};

// Named when the budget forces a cut. A rulebook that silently loses rules to
// a character limit reads to the model as a complete book, and the rules it
// lost are — by the ordering above — the ones furthest from today's market,
// which is a defensible thing to do and an indefensible thing to hide.
const heldBack = (count: number, locale: RuleLocale, ranked: boolean): string => {
  if (locale === "ja") {
    return ranked
      ? `（このほかに${count}件のルールがあるが、文字数の都合で省略した。今の相場から遠いものから順に省いている。）`
      : `（このほかに${count}件のルールがあるが、文字数の都合で省略した。）`;
  }
  const rules = `${count} further rule${count === 1 ? "" : "s"}`;
  return ranked
    ? `(${rules} were left out for length, the ones furthest from today's market first.)`
    : `(${rules} were left out for length.)`;
};

const evidence = (
  rule: Rule,
  locale: RuleLocale,
  contract: string | null,
  fit: RuleSituation | undefined,
): string => {
  // ANY citation from another era earns the marker, not only a rule with no
  // in-era citations at all: the analyst is being told the record behind this
  // rule is partly from a game with different moves, and "partly" is the
  // honest word. It follows that the marker is sticky — it clears only when a
  // rule's citation list holds nothing from another era, which for a
  // support=1 rule means its single citation was replaced.
  const mixed = contract !== null && rule.evidence_contracts.some((c) => c !== contract);
  // Absent when the footprints could not be read at all, in which case every
  // rule renders exactly as it did before this check existed.
  const now = fit === undefined ? "" : FIT_LABEL[locale][fit.fit];
  if (locale === "ja") {
    const era = mixed ? "・旧契約含む" : "";
    return rule.support <= VERIFYING_SUPPORT
      ? `（検証中・実績${rule.support}件${era}${now}）`
      : `（実績${rule.support}件${era}${now}）`;
  }
  const cases = `${rule.support} case${rule.support === 1 ? "" : "s"}`;
  const era = mixed ? ", incl. prior contract" : "";
  return rule.support <= VERIFYING_SUPPORT
    ? ` (under review, ${cases}${era}${now})`
    : ` (${cases}${era}${now})`;
};

export interface PromptRules {
  // The block for the system prompt; empty when nothing has been learned
  text: string;
  // The rules that made it into the block, in the order shown — what the
  // model actually saw, which is what the plan is later judged against
  ids: string[];
  // In-force rules that did not fit the budget. Recorded as well as printed:
  // a prompt that showed 12 of 30 rules and one that showed 12 of 12 are
  // different prompts, and only this number tells them apart afterwards.
  heldBack: number;
}

// Rules the analyst can actually act on under `contract`. A rule written for
// another contract is held back, not deleted: it stays in the rulebook, keeps
// its evidence and its history, and returns the moment the editor re-emits it
// for the contract in force.
//
// This was not hypothetical. On the day the entry contract changed, seven of
// the nine rules in the live book were about where to place a limit entry — a
// move the analyst no longer has — and all nine were rendered into every
// prompt (732 of 1600 characters, nothing truncated). One of them taught a
// "roughly 20% fill rate", a number that cannot occur under a contract where
// the server fills at the market. The revision machinery could not clear them
// either: it may drop two rules per revision, so the book would have carried
// them for weeks.
//
// It is the same refusal the statistics make. Two contracts are two
// populations, and a rulebook is a statistic about the analyst's mistakes.
export const inForce = (rules: Rule[], contract: string | null): Rule[] =>
  contract === null ? rules : rules.filter((r) => r.contract === contract);

// The block that goes into the system prompt. Constraints first, then the
// rules with the most evidence; stops adding when the character budget is
// spent. Empty when there is nothing learned yet, so the prompt carries no
// empty heading.
export const selectPromptRules = (
  rules: Rule[],
  locale: RuleLocale = "ja",
  // The contract the plans being made right now are written under. null shows
  // every rule — what a caller with no contract to compare against should get.
  contract: string | null = null,
  maxRules = MAX_PROMPT_RULES,
  maxChars = promptCharBudget(locale),
  // Per rule id, how today's market compares with the plans that rule was
  // drawn from. null means the comparison was not made — the footprints could
  // not be read, or the caller does not do situation matching — and every rule
  // then renders exactly as it did before this existed. A non-null map puts
  // every in-force rule in one of the three verdicts: a rule with no entry has
  // no footprint to compare against, which is `unknown`, not silence.
  fits: Record<string, RuleSituation> | null = null,
): PromptRules => {
  const ranked = fits !== null;
  const fitOf = (rule: Rule): RuleSituation | undefined =>
    fits === null ? undefined : (fits[rule.id] ?? UNCOMPARED);

  const eligible = orderRules(inForce(rules, contract), fits ?? {})
    .map((rule) => {
      const raw = locale === "ja" ? rule.text_ja || rule.text_en : rule.text_en || rule.text_ja;
      const text = raw.replace(/\s+/g, " ").trim();
      if (!text) return null;
      const scope = rule.scope ? (locale === "ja" ? `［${rule.scope}］` : `[${rule.scope}] `) : "";
      // The id, in front of the rule as a LABEL for the line — not a word
      // inside the instruction, and nothing the analyst is asked to act on.
      //
      // It is here because the instrument added on 2026-09-08 could not work
      // without it: `rules_applied` asks the analyst which of these rules it
      // used, and every stored prompt written before that day carries this
      // block while NOT ONE carries a rule id (39 of 39 at the commit that
      // added the field; still 0 of 43 just before the deploy). So every id
      // an analyst could have produced was an id it had never been shown,
      // `claimedRules` dropped it, and the field collected nothing. The
      // postmortem side has always handed its rules over with the id attached
      // (`rules_in_force`); this is the analyst side catching up.
      //
      // THE COST IS PAID OUT OF THE SELECTION BUDGET, so this is not cosmetic.
      // The loop below stops on `chars + line.length + 1 > maxChars`, and the
      // label adds 2 + id.length characters per line in Japanese, 3 + id.length
      // in English. On the live book — r10, r4, r11, the three rules of version
      // 8 — the Japanese block goes from 582 to 596 against the 1600 cap and
      // the English from 1284 to 1301 against 3200. Those are budget figures,
      // counted with the newline this loop charges every line; the rendered
      // block is one character shorter than each (581 -> 595, 1283 -> 1300),
      // which is the number docs/OPERATIONS.md quotes. Three rules is also
      // nowhere near the 12-rule cap, so on the book in force nothing that is
      // shown today stops being shown.
      //
      // ON A LARGER BOOK IT CAN CHANGE THE SELECTION, and that is said here
      // rather than discovered later. Measured by running this function and
      // the one it replaces side by side over books built from the live rules:
      // an ELEVEN-rule book of rules this length shows eleven before the label
      // and ten after — in both languages — holding one back instead of none.
      // Eleven is where the label first costs a rule, not twelve: a twelve-rule
      // book is already cut to ten by the budget alone, with or without labels.
      // Where the cut lands depends on how long the rules are (a book of
      // 56-character rules goes twelve to eleven, one of 84-character rules ten
      // to nine), but it is always exactly one rule, and it is always the last
      // by the ordering above — furthest from today's market — and the block
      // still names the count it cut. The caps and the selection logic are
      // deliberately untouched: what a selected rule LOOKS LIKE is what changed
      // here, never which rules are selected.
      const label = locale === "ja" ? `[${rule.id}]` : `[${rule.id}] `;
      return { id: rule.id, line: `- ${label}${scope}${text}${evidence(rule, locale, contract, fitOf(rule))}` };
    })
    .filter((v): v is { id: string; line: string } => v !== null);

  const head = ranked ? [HEADERS[locale], FIT_NOTE[locale]] : [HEADERS[locale]];
  // The heading is part of the budget, and so is the note that explains the
  // markers — buying room for one more rule by dropping the sentence that
  // says where the markers come from would be the wrong trade.
  //
  // Every line is counted WITH the newline that joins it. Counting the rules
  // without theirs put the rendered block up to one character per rule over
  // the budget it reports respecting, which is a small lie about a number
  // whose only job is to be true.
  const headChars = head.reduce((n, line) => n + line.length + 1, 0);

  const shown: Array<{ id: string; line: string }> = [];
  let chars = headChars;
  for (const item of eligible) {
    if (shown.length >= maxRules) break;
    if (chars + item.line.length + 1 > maxChars) break;
    shown.push(item);
    chars += item.line.length + 1;
  }

  if (shown.length === 0) return { text: "", ids: [], heldBack: eligible.length };

  // Saying what was cut costs characters too, and the cost is not known until
  // the cut is. Give the sentence room by giving back rules until it fits —
  // never by printing it outside the budget the rest of the block respects.
  let cut = eligible.length - shown.length;
  let note = "";
  while (cut > 0) {
    const candidate = heldBack(cut, locale, ranked);
    if (chars + candidate.length + 1 <= maxChars) {
      note = candidate;
      break;
    }
    const dropped = shown.pop();
    if (dropped === undefined) break;
    chars -= dropped.line.length + 1;
    cut += 1;
  }
  if (shown.length === 0) return { text: "", ids: [], heldBack: eligible.length };

  const body = [...head, ...shown.map((v) => v.line)];
  if (note) body.push(note);
  return { text: body.join("\n"), ids: shown.map((v) => v.id), heldBack: cut };
};

export const renderLearnedRules = (
  rules: Rule[],
  locale: RuleLocale = "ja",
  contract: string | null = null,
  maxRules = MAX_PROMPT_RULES,
  maxChars = promptCharBudget(locale),
  fits: Record<string, RuleSituation> | null = null,
): string => selectPromptRules(rules, locale, contract, maxRules, maxChars, fits).text;

// The rule ids the analyst says it applied, kept to the ids it was actually
// shown.
//
// Same filter `parseDiagnosis` puts on rule_blamed (postmortem/prompt.ts): a
// non-string is not an id, an id the run never showed is not an id, and a
// repeat is not a second citation. Nothing here checks the claim against the
// market — src/lib/inference.ts says why a model-authored tag can never be
// evidence, and this one is stored as a claim precisely so it is never read
// as one.
//
// `null` means the analyst did not answer, which is NOT the same as answering
// "none". Structured output does not bind on the searching path, so silence
// is the common case and a deliberate empty list has to stay tellable from
// it.
//
// An answer that named things and lost all of them is silence too, not a
// denial: it is an answer we could not read. Storing `[]` for one of those
// would file "I used none of them" on a row whose prose may say the opposite.
//
// Until 2026-09-08 that was not a corner case but the whole population:
// `selectPromptRules` rendered each rule as its scope and its text and printed
// NO id, so every id an analyst could produce was one it had never been shown
// and every answer was dropped whole. Every stored version-8 prompt is from
// that era. The block now carries the id, so a lost answer means what it says —
// an id that was invented, or one from a rulebook this run was not shown — and
// the two eras of this field must be read apart (docs/OPERATIONS.md).
export const claimedRules = (value: unknown, shown: string[]): string[] | null => {
  if (!Array.isArray(value)) return null;
  const ruleRef = (v: unknown): string | null => {
    // One enclosing bracket pair comes off first, because the id is printed as
    // a LABEL — `- [r10]［scope］…` — and that bracketed token is now the only
    // form of the id anywhere in the prompt: the block prints no bare id and
    // the schema description is banned from carrying an example. An analyst
    // answering with exactly what it was handed would otherwise lose its whole
    // answer to an unmatched `[r10]`, and the row would be filed as "did not
    // answer" — indistinguishable from the silence this field exists to end.
    // Both widths, because the line around the label is Japanese.
    const id = typeof v === "string"
      ? v.trim().replace(/^[[［](.+)[\]］]$/, "$1").trim().slice(0, 20).trim()
      : "";
    return id && shown.includes(id) ? id : null;
  };
  const kept = [...new Set(value.map(ruleRef).filter((id): id is string => id !== null))];
  return kept.length === 0 && value.length > 0 ? null : kept;
};
