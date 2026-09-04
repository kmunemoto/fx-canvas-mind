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
export const MAX_PROMPT_CHARS = 1600;
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

// Constraints first, then the best-supported; ties keep the stored order
export const orderRules = (rules: Rule[]): Rule[] =>
  [...rules].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "constraint" ? -1 : 1;
    return b.support - a.support;
  });

const HEADERS: Record<RuleLocale, string> = {
  ja: "過去の判定から学んだルール（実際の値動きの検証から作成。上の手順とリスク規定が優先で、これらは同じ条件下での補助的な指針。「検証中」は根拠がまだ少ない）:",
  en: "Rules learned from past outcomes (drawn from reviews against actual prices; the procedure and risk limits above take precedence, these are supplementary guidance under the same conditions; \"under review\" means the evidence is still thin):",
};

const evidence = (rule: Rule, locale: RuleLocale, contract: string | null): string => {
  // ANY citation from another era earns the marker, not only a rule with no
  // in-era citations at all: the analyst is being told the record behind this
  // rule is partly from a game with different moves, and "partly" is the
  // honest word. It follows that the marker is sticky — it clears only when a
  // rule's citation list holds nothing from another era, which for a
  // support=1 rule means its single citation was replaced.
  const mixed = contract !== null && rule.evidence_contracts.some((c) => c !== contract);
  if (locale === "ja") {
    const era = mixed ? "・旧契約含む" : "";
    return rule.support <= VERIFYING_SUPPORT
      ? `（検証中・実績${rule.support}件${era}）`
      : `（実績${rule.support}件${era}）`;
  }
  const cases = `${rule.support} case${rule.support === 1 ? "" : "s"}`;
  const era = mixed ? ", incl. prior contract" : "";
  return rule.support <= VERIFYING_SUPPORT ? ` (under review, ${cases}${era})` : ` (${cases}${era})`;
};

export interface PromptRules {
  // The block for the system prompt; empty when nothing has been learned
  text: string;
  // The rules that made it into the block, in the order shown — what the
  // model actually saw, which is what the plan is later judged against
  ids: string[];
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
  maxChars = MAX_PROMPT_CHARS,
): PromptRules => {
  const lines: string[] = [];
  const ids: string[] = [];
  // The heading is part of the budget
  let chars = HEADERS[locale].length + 1;
  for (const rule of orderRules(inForce(rules, contract))) {
    if (lines.length >= maxRules) break;
    const raw = locale === "ja" ? rule.text_ja || rule.text_en : rule.text_en || rule.text_ja;
    const text = raw.replace(/\s+/g, " ").trim();
    if (!text) continue;
    const scope = rule.scope ? (locale === "ja" ? `［${rule.scope}］` : `[${rule.scope}] `) : "";
    const line = `- ${scope}${text}${evidence(rule, locale, contract)}`;
    if (chars + line.length > maxChars) break;
    lines.push(line);
    ids.push(rule.id);
    chars += line.length;
  }
  if (lines.length === 0) return { text: "", ids: [] };
  return { text: [HEADERS[locale], ...lines].join("\n"), ids };
};

export const renderLearnedRules = (
  rules: Rule[],
  locale: RuleLocale = "ja",
  contract: string | null = null,
  maxRules = MAX_PROMPT_RULES,
  maxChars = MAX_PROMPT_CHARS,
): string => selectPromptRules(rules, locale, contract, maxRules, maxChars).text;
