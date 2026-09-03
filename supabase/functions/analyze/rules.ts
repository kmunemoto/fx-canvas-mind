// The rulebook: what the analyzer has learned from its own record.
//
// The postmortem function diagnoses every settled plan and consolidates the
// lessons into a short list of rules (public.rulebook). analyze puts those
// rules in front of the model on every call and records the rulebook version
// on the plan, so the effect of a rule can be read off the outcomes that
// followed it instead of assumed.
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
  ja: "過去の判定から学んだルール（実際の値動きで検証済み。上の手順とリスク規定が優先で、これらは同じ条件下での補助的な指針。「検証中」は根拠がまだ少ない）:",
  en: "Rules learned from past outcomes (verified against actual prices; the procedure and risk limits above take precedence, these are supplementary guidance under the same conditions; \"under review\" means the evidence is still thin):",
};

const evidence = (rule: Rule, locale: RuleLocale): string => {
  if (locale === "ja") {
    return rule.support <= VERIFYING_SUPPORT ? `（検証中・実績${rule.support}件）` : `（実績${rule.support}件）`;
  }
  const cases = `${rule.support} case${rule.support === 1 ? "" : "s"}`;
  return rule.support <= VERIFYING_SUPPORT ? ` (under review, ${cases})` : ` (${cases})`;
};

// The block that goes into the system prompt. Constraints first, then the
// rules with the most evidence; stops adding when the character budget is
// spent. Empty when there is nothing learned yet, so the prompt carries no
// empty heading.
export const renderLearnedRules = (
  rules: Rule[],
  locale: RuleLocale = "ja",
  maxRules = MAX_PROMPT_RULES,
  maxChars = MAX_PROMPT_CHARS,
): string => {
  const lines: string[] = [];
  // The heading is part of the budget
  let chars = HEADERS[locale].length + 1;
  for (const rule of orderRules(rules)) {
    if (lines.length >= maxRules) break;
    const raw = locale === "ja" ? rule.text_ja || rule.text_en : rule.text_en || rule.text_ja;
    const text = raw.replace(/\s+/g, " ").trim();
    if (!text) continue;
    const scope = rule.scope ? (locale === "ja" ? `［${rule.scope}］` : `[${rule.scope}] `) : "";
    const line = `- ${scope}${text}${evidence(rule, locale)}`;
    if (chars + line.length > maxChars) break;
    lines.push(line);
    chars += line.length;
  }
  if (lines.length === 0) return "";
  return [HEADERS[locale], ...lines].join("\n");
};
