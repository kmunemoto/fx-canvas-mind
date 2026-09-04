import { describe, it, expect } from "vitest";
import { ja } from "../lib/i18n/ja";
import { en } from "../lib/i18n/en";
import { LOCALES, DEFAULT_LOCALE, dictionaryFor, isLocale, resolveLocale } from "../lib/i18n/locales";
import { CAUSES } from "../../supabase/functions/postmortem/facts.ts";

// Walks both dictionaries together. TypeScript already requires every key, but
// it cannot catch a value left as the Japanese original, or an array that has
// a different number of entries in one locale (the landing page maps icons by
// index onto those arrays, so a short array renders `undefined`).
const walk = (
  a: unknown,
  b: unknown,
  path: string,
  onLeaf: (path: string, a: unknown, b: unknown) => void,
) => {
  if (Array.isArray(a) || Array.isArray(b)) {
    expect(Array.isArray(a) && Array.isArray(b), `${path} should be an array in both`).toBe(true);
    expect((b as unknown[]).length, `${path} length differs between locales`).toBe((a as unknown[]).length);
    (a as unknown[]).forEach((item, i) => walk(item, (b as unknown[])[i], `${path}[${i}]`, onLeaf));
    return;
  }
  if (a && typeof a === "object") {
    for (const key of Object.keys(a as object)) {
      expect(b, `${path}.${key} missing in the other locale`).toHaveProperty(key);
      walk((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], `${path}.${key}`, onLeaf);
    }
    return;
  }
  onLeaf(path, a, b);
};

describe("dictionaries", () => {
  it("have the same shape and the same array lengths", () => {
    walk(ja, en, "root", () => {});
    walk(en, ja, "root", () => {});
  });

  it("leave no English value still holding the Japanese text", () => {
    const hasJapanese = (v: unknown) => typeof v === "string" && /[ぁ-んァ-ヶ一-龠]/.test(v);
    const untranslated: string[] = [];

    walk(ja, en, "root", (path, a, b) => {
      if (typeof a === "function" || typeof b === "function") return;
      // Values that are legitimately identical across locales: brand names,
      // the em dash, ticker words like WIN/LOSS.
      if (hasJapanese(b)) untranslated.push(`${path} = ${String(b)}`);
    });

    expect(untranslated, `English values still in Japanese:\n${untranslated.join("\n")}`).toEqual([]);
  });

  it("keeps the direction gloss distinct from the direction word", () => {
    for (const locale of LOCALES) {
      const d = dictionaryFor(locale).direction;
      for (const signal of ["BUY", "SELL", "WAIT"] as const) {
        expect(d[signal].word.length, `${locale}.${signal}.word`).toBeGreaterThan(0);
        expect(d[signal].gloss.length, `${locale}.${signal}.gloss`).toBeGreaterThan(0);
      }
      // The whole point of the gloss: BUY and SELL must never read alike.
      expect(d.BUY.word).not.toBe(d.SELL.word);
      expect(d.BUY.gloss).not.toBe(d.SELL.gloss);
    }
  });
});

describe("resolveLocale", () => {
  it("maps browser tags onto shipped locales", () => {
    expect(resolveLocale("ja")).toBe("ja");
    expect(resolveLocale("ja-JP")).toBe("ja");
    expect(resolveLocale("JA_jp")).toBe("ja");
    expect(resolveLocale("en")).toBe("en");
    expect(resolveLocale("en-GB")).toBe("en");
  });

  it("falls back rather than rendering blanks for a locale we do not ship", () => {
    for (const tag of ["fr", "zh-CN", "", null, undefined, "nonsense"]) {
      expect(resolveLocale(tag)).toBe(DEFAULT_LOCALE);
    }
  });

  it("recognises exactly the locales we ship", () => {
    expect(isLocale("ja")).toBe(true);
    expect(isLocale("en")).toBe(true);
    expect(isLocale("fr")).toBe(false);
    expect(isLocale(42)).toBe(false);
    expect(LOCALES).toContain(DEFAULT_LOCALE);
  });
});

// A cause added on the server and forgotten on the client renders as a raw
// enum string in the UI with no error anywhere — both causeLabel implementations
// fall back to the key. This is the only thing that catches it.
describe("the cause taxonomy is fully labelled on both sides", () => {
  it("has a ja and en label for every cause the server can write", () => {
    for (const cause of CAUSES) {
      expect(ja.history.postmortem.causes, `ja is missing ${cause}`).toHaveProperty(cause);
      expect(en.history.postmortem.causes, `en is missing ${cause}`).toHaveProperty(cause);
    }
  });

  it("labels no cause the server cannot write", () => {
    for (const key of Object.keys(ja.history.postmortem.causes)) {
      expect(CAUSES, `ja labels unknown cause ${key}`).toContain(key);
    }
    for (const key of Object.keys(en.history.postmortem.causes)) {
      expect(CAUSES, `en labels unknown cause ${key}`).toContain(key);
    }
  });
});
