// Language of the generated analysis. The UI strings live in src/lib/i18n, but
// the analysis body, thesis, key factors and warnings are written by the model,
// so the locale has to reach the prompt or a viewer reading the app in English
// still gets a Japanese trade rationale.
//
// Deno-free on purpose: src/test/locale.test.ts imports this file directly.

export const SUPPORTED_LOCALES = ["ja", "en"] as const;
export type AnalysisLocale = (typeof SUPPORTED_LOCALES)[number];
export const DEFAULT_ANALYSIS_LOCALE: AnalysisLocale = "ja";

// Accepts what the client sends ("ja", "en-GB", "JA_jp") and anything else
// falls back rather than producing a prompt in no language at all.
export const resolveAnalysisLocale = (value: unknown): AnalysisLocale => {
  if (typeof value !== "string") return DEFAULT_ANALYSIS_LOCALE;
  const base = value.toLowerCase().replace("_", "-").split("-")[0];
  return (SUPPORTED_LOCALES as readonly string[]).includes(base)
    ? (base as AnalysisLocale)
    : DEFAULT_ANALYSIS_LOCALE;
};

interface LocaleStrings {
  // Appended to the system prompt: the analytical method is identical, only
  // the output language changes.
  languageRule: string;
  searchNote: string;
  technicalNote: string;
  fallbackNote: string;
  schemaInstruction: (schema: string) => string;
  userMessage: (parts: { pair: string; nowUtc: string; note: string; sections: string; schema: string }) => string;
  disclaimer: string;
  // Substring that identifies the disclaimer already being present, so it is
  // not appended twice when the model followed the instruction.
  disclaimerMarker: string;
  fallbackWarning: string;
}

const STRINGS: Record<AnalysisLocale, LocaleStrings> = {
  ja: {
    languageRule:
      "- analysis・thesis・key_factors・warnings などの文章は日本語で書く（market_context_detail の値は英語の定型語でよい）。",
    searchNote:
      "分析モード: full — まずweb検索で本日の経済指標・金融政策・当該通貨の材料を確認し、fundamental_score とファンダ要因を分析に統合してください。検索は2回まで。",
    technicalNote:
      "分析モード: technical_only — テクニカルのみで判断し、fundamental_score は50、ファンダ要因には言及しないでください。",
    fallbackNote:
      "分析モード: technical_fallback — ニュース検索が利用できないため、テクニカルのみで判断し、fundamental_score は50、ファンダ要因には言及しないでください。",
    schemaInstruction: (schema) =>
      `\n\n最終回答は<json>タグ内に、次のJSON Schemaに厳密に従ったJSONのみを出力してください。キー名とenum値は英語のまま一字一句一致させ、required のフィールドは全て含めること。スキーマ外のキーは出力しないこと。\n${schema}`,
    userMessage: ({ pair, nowUtc, note, sections, schema }) =>
      `通貨ペア: ${pair}\n現在時刻(UTC): ${nowUtc}\n${note}\n\n${sections}\n\n上記のマルチタイムフレームデータを手順1-5に沿って分析し、トレードプランを出力してください。${schema}`,
    disclaimer: "この分析は参考情報です。投資判断は自己責任で行ってください",
    disclaimerMarker: "自己責任",
    fallbackWarning: "ニュース検索が利用できなかったため、テクニカルのみで判断しています",
  },
  en: {
    languageRule:
      "- Write analysis, thesis, key_factors and warnings in English (market_context_detail values stay the fixed English terms).",
    searchNote:
      "Mode: full — first use web search to check today's economic releases, monetary policy and any news moving this pair, then fold that into fundamental_score and the analysis. At most 2 searches.",
    technicalNote:
      "Mode: technical_only — judge on the technicals alone, set fundamental_score to 50, and do not refer to fundamentals.",
    fallbackNote:
      "Mode: technical_fallback — news search is unavailable, so judge on the technicals alone, set fundamental_score to 50, and do not refer to fundamentals.",
    schemaInstruction: (schema) =>
      `\n\nReturn your final answer inside <json> tags as JSON only, strictly following this JSON Schema. Keep key names and enum values exactly as written, include every required field, and output no keys outside the schema.\n${schema}`,
    userMessage: ({ pair, nowUtc, note, sections, schema }) =>
      `Currency pair: ${pair}\nCurrent time (UTC): ${nowUtc}\n${note}\n\n${sections}\n\nAnalyse the multi-timeframe data above following steps 1-5 and output the trade plan.${schema}`,
    disclaimer: "This analysis is reference information. Trading decisions are your own responsibility.",
    disclaimerMarker: "your own responsibility",
    fallbackWarning: "News search was unavailable, so this call is based on technicals alone.",
  },
};

export const stringsFor = (locale: AnalysisLocale): LocaleStrings => STRINGS[locale];

// The disclaimer is a compliance requirement, so it is added server-side rather
// than left to the model — including when the model wrote its own wording.
export const withDisclaimer = (warnings: string[], locale: AnalysisLocale): string[] => {
  const { disclaimer, disclaimerMarker } = STRINGS[locale];
  const present = warnings.some((w) => w.toLowerCase().includes(disclaimerMarker.toLowerCase()));
  return present ? warnings : [...warnings, disclaimer];
};
