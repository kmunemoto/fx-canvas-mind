// The rulebook: what the analyzer has learned from its own record.
//
// The postmortem function diagnoses every settled plan and consolidates the
// lessons into a short list of rules (public.rulebook). analyze puts those
// rules in front of the model on every call and records the rulebook version
// on the plan, so the effect of a rule can be read off the outcomes that
// followed it instead of assumed.
//
// Deno-free on purpose: the vitest suite imports this file directly, and the
// postmortem function shares the Rule shape.

export interface Rule {
  id: string;
  text_ja: string;
  text_en: string;
  // The failure cause the rule addresses (see postmortem/facts.ts)
  cause: string;
  // How many diagnosed plans stand behind it
  support: number;
  // Where it applies, in plain words ("1h/4h", "trend", "limit entries")
  scope: string | null;
  since: string | null;
}

export interface Rulebook {
  version: number;
  rules: Rule[];
  updated_at: string | null;
}

// Prompt real estate is not free: enough rules to matter, few enough to be
// read
export const MAX_PROMPT_RULES = 12;
export const MAX_PROMPT_CHARS = 1600;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v.trim() : fallback);

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
    });
  }
  return out;
};

// The block that goes into the system prompt. Rules with the most evidence
// first; stops adding when the character budget is spent. Empty when there
// is nothing learned yet, so the prompt carries no empty heading.
export const renderLearnedRules = (rules: Rule[], maxRules = MAX_PROMPT_RULES, maxChars = MAX_PROMPT_CHARS): string => {
  const sorted = [...rules].sort((a, b) => b.support - a.support);
  const lines: string[] = [];
  let chars = 0;
  for (const rule of sorted) {
    if (lines.length >= maxRules) break;
    const text = rule.text_ja.replace(/\s+/g, " ").trim();
    if (!text) continue;
    const scope = rule.scope ? `［${rule.scope}］` : "";
    const line = `- ${scope}${text}（実績${rule.support}件）`;
    if (chars + line.length > maxChars) break;
    lines.push(line);
    chars += line.length;
  }
  if (lines.length === 0) return "";
  return [
    "過去の判定から学んだルール（実際の値動きで検証済み。上の手順と矛盾する場合はこちらを優先する）:",
    ...lines,
  ].join("\n");
};
