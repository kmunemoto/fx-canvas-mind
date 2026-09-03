import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  DEFAULT_LOCALE,
  STORAGE_KEY,
  dictionaryFor,
  isLocale,
  resolveLocale,
  type Dict,
  type Locale,
} from "./locales";

// Values live in ./locales and are imported from there directly, so this file
// exports only React things and stays Fast-Refresh friendly. Types are erased,
// so re-exporting them here costs nothing.
export type { Dict, Locale } from "./locales";

// localStorage throws in some privacy modes, and a preference that cannot be
// read is not a reason to fail to render.
const readStored = (): Locale | null => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return isLocale(raw) ? raw : null;
  } catch {
    return null;
  }
};

const initialLocale = (): Locale => {
  const stored = readStored();
  if (stored) return stored;
  if (typeof navigator !== "undefined") return resolveLocale(navigator.language);
  return DEFAULT_LOCALE;
};

interface LocaleContextValue {
  locale: Locale;
  setLocale: (next: Locale) => void;
  t: Dict;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

export const LocaleProvider = ({
  children,
  // Pinning the locale is for tests and for anywhere the choice is already
  // made; left unset the provider uses the stored preference, then the browser.
  initial,
}: {
  children: ReactNode;
  initial?: Locale;
}) => {
  const [locale, setLocaleState] = useState<Locale>(() => initial ?? initialLocale());

  useEffect(() => {
    if (typeof document !== "undefined") {
      document.documentElement.lang = locale;
    }
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // A preference we cannot persist still applies for this session.
    }
  }, []);

  const value = useMemo<LocaleContextValue>(
    () => ({ locale, setLocale, t: dictionaryFor(locale) }),
    [locale, setLocale],
  );

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
};

export const useLocale = (): LocaleContextValue => {
  const ctx = useContext(LocaleContext);
  if (!ctx) throw new Error("useLocale must be used inside <LocaleProvider>");
  return ctx;
};

// The common case: `const t = useT();` then `t.control.analyze`. Property
// access rather than t("control.analyze") so a wrong key is a compile error.
export const useT = (): Dict => useLocale().t;

// For the error boundary's fallback, which must render even if it somehow ends
// up outside the provider — a crash screen that itself crashes is useless.
export const useOptionalT = (): Dict => useContext(LocaleContext)?.t ?? dictionaryFor(DEFAULT_LOCALE);
