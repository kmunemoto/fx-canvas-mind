import { ja, type Dict } from "./ja";
import { en } from "./en";

export type { Dict } from "./ja";

export const LOCALES = ["ja", "en"] as const;
export type Locale = (typeof LOCALES)[number];

const DICTIONARIES: Record<Locale, Dict> = { ja, en };

export const DEFAULT_LOCALE: Locale = "ja";
export const STORAGE_KEY = "fx-locale";

export const isLocale = (value: unknown): value is Locale =>
  typeof value === "string" && (LOCALES as readonly string[]).includes(value);

// "ja", "ja-JP", "JA_jp" -> "ja". Anything we do not ship falls back to the
// default rather than rendering blanks.
export const resolveLocale = (candidate: string | null | undefined): Locale => {
  if (!candidate) return DEFAULT_LOCALE;
  const base = candidate.toLowerCase().replace("_", "-").split("-")[0];
  return isLocale(base) ? base : DEFAULT_LOCALE;
};

export const dictionaryFor = (locale: Locale): Dict => DICTIONARIES[locale];
