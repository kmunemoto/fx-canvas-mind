import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { stringsFor, type AnalysisLocale } from "../../supabase/functions/analyze/locale";
import { parseRules, promptCharBudget, selectPromptRules } from "../../supabase/functions/analyze/rules";
import {
  LOCALE,
  MODE_FOR_CLASS,
  SCHEMA_ERAS,
  SURGERY_LOCALES,
  classifyRow,
  detectLocale,
  detectSchemaEra,
  fallbackTransform,
  isRefusal,
  locateRulesBlock,
  spliceRulesBlock,
  stripSchemaSuffix,
  type ClassifiedRow,
  type SurgeryLocale,
} from "../../supabase/functions/noise-floor/prompt-surgery";

// The noise floor replays stored prompts, and prompt-surgery.ts is the reader
// that decides whether a stored prompt can be replayed at all. Everything here
// is built from the REAL constants — `locale.ts`'s own `userMessage` builder
// and `rules.ts`'s own block renderer — rather than from production text pasted
// into a fixture. Two reasons, and the second is the load-bearing one:
//
//   * `analysis_prompts` is service-role only precisely so that prompt text
//     does not live where it need not (see
//     20260905161000_replay_inputs_are_server_side.sql); copying rows into a
//     git-tracked test file would undo that for the sake of a fixture.
//   * A fixture pinned to bytes captured on one day would go stale silently.
//     Building the row from the same functions production builds it from means
//     these tests are a statement about the BUILDER, which is the thing the
//     reader has to keep up with.
//
// The production figures the tests are calibrated against were measured
// 2026-09-09 against project endcqzewujdvimdlazhj over all 48 rows of
// `analysis_prompts` joined to `analyses`, and are quoted where they are used.

const surgerySrc = readFileSync("supabase/functions/noise-floor/prompt-surgery.ts", "utf8");

// A rulebook shaped like the live one: three rules, one constraint first, well
// inside MAX_PROMPT_CHARS so nothing is held back. `public.rulebook` version 8
// carries exactly 3 live rules (and 4 candidate rules) — measured — and all 48
// stored blocks render as heading + fit note + three `- ` lines, 579-595 chars.
const RULES = parseRules([
  { id: "r10", text_ja: "レンジではブレイク方向に逆張りしない", text_en: "Do not fade a break in a range", cause: "range_fade", support: 6, kind: "constraint" },
  { id: "r4", text_ja: "ADX が 20 未満のときは見送る", text_en: "Stand aside when ADX is below 20", cause: "weak_trend", support: 4, kind: "heuristic" },
  { id: "r11", text_ja: "上位足と逆向きのエントリーは枚数を半分にする", text_en: "Halve the size against the higher timeframe", cause: "htf_conflict", support: 3, kind: "heuristic" },
]);

// `fits` non-null is what makes `selectPromptRules` render the block RANKED,
// i.e. with the fit note under the heading. Every one of the 48 stored systems
// carries that note (measured 48/48), so a ranked block is the only shape the
// reader has ever had to read, and an unranked one is the interesting negative.
const rulesBlockFor = (locale: SurgeryLocale, ranked = true): string =>
  selectPromptRules(RULES, locale, null, 12, promptCharBudget(locale), ranked ? {} : null).text;

// The seam as `analyze/index.ts` builds it: SYSTEM_PROMPT ends
// `{{EVENTS}}\n{{LEARNED_RULES}}` and is then trimEnd()ed, so the heading is
// preceded by exactly one newline and the block runs to end-of-string.
const systemFor = (locale: SurgeryLocale, block = rulesBlockFor(locale)): string =>
  `You are the analyst.\nStep 1 through 6 go here.\n\nEconomic events: none.\n${block}`;

const SECTIONS = "### 1h\nclose 155.10\n\n### 4h\nclose 154.80";

// Two schema payloads that differ in content and in length, standing in for the
// two generations the live corpus actually carries. They are NOT the production
// payloads: what the tests need is that two different payloads behave
// identically, and the production lengths and digests are pinned separately
// against SCHEMA_ERAS below.
const PAYLOAD_OLD = JSON.stringify({
  type: "object",
  properties: { signal: { type: "string" }, confidence: { type: "integer" } },
  required: ["signal", "confidence"],
});
const PAYLOAD_NEW = JSON.stringify({
  type: "object",
  properties: {
    signal: { type: "string" },
    confidence: { type: "integer" },
    rules_applied: { type: "array", items: { type: "string" } },
  },
  required: ["signal", "confidence"],
});

interface RowParts {
  locale?: SurgeryLocale;
  note?: string;
  payload?: string | null;
  sections?: string;
}

// A stored row as `buildUserMessage` would have produced it.
const userFor = ({ locale = "ja", note, payload = PAYLOAD_OLD, sections = SECTIONS }: RowParts = {}): string => {
  const L = stringsFor(locale as AnalysisLocale);
  return L.userMessage({
    pair: "USD/JPY",
    nowUtc: "2026-09-09T12:00:00.000Z",
    note: note ?? L.searchNote,
    sections,
    schema: payload === null ? "" : L.schemaInstruction(payload),
  });
};

const accepted = (row: unknown): ClassifiedRow => {
  expect(isRefusal(row as object)).toBe(false);
  return row as ClassifiedRow;
};

const classifySearchRow = (parts: RowParts = {}): ClassifiedRow => {
  const locale = parts.locale ?? "ja";
  return accepted(classifyRow({
    user: userFor({ ...parts, locale }),
    system: systemFor(locale),
    mode: "full",
  }));
};

// -- 12 -------------------------------------------------------------------

describe("locale is decided once, from the first line, and never defaulted", () => {
  it("reads the locale off the currency-pair prefix", () => {
    expect(detectLocale(userFor({ locale: "ja" }))).toBe("ja");
    expect(detectLocale(userFor({ locale: "en" }))).toBe("en");
  });

  it("refuses a first line that carries neither prefix", () => {
    const row = classifyRow({ user: "Paire: USD/JPY\nx\ny\n", system: systemFor("ja"), mode: "full" });
    expect(isRefusal(row)).toBe(true);
    expect(isRefusal(row) && row.code).toBe("locale_undetected");
  });

  // The whole live corpus is Japanese (48/48 ja, 0 en, measured), which is
  // exactly the situation in which "fall back to ja" would never be noticed:
  // an English row would be read with Japanese constants, fail A3, and be
  // reported as an unreadable note line rather than as a locale the reader
  // handled wrongly. So an English row has to come out English all the way
  // through to the transformed bytes, not merely be accepted.
  it("carries an English row through as English rather than leaving it alone", () => {
    const row = classifySearchRow({ locale: "en" });
    expect(row.locale).toBe("en");
    expect(row.promptClass).toBe("search_derived");
    const out = fallbackTransform(row);
    expect(isRefusal(out)).toBe(false);
    expect(!isRefusal(out) && out.user).toContain(stringsFor("en").fallbackNote);
    expect(!isRefusal(out) && out.user).not.toContain(stringsFor("ja").fallbackNote);
  });

  it("copies every locale string from analyze/locale.ts byte for byte", () => {
    // This is the guard that lets prompt-surgery.ts duplicate the strings
    // instead of importing them. The duplication is deliberate — a stored
    // prompt is a historical artefact and the analyzer's wording is not — but
    // it is only safe while the copy is provably a copy TODAY.
    for (const locale of SURGERY_LOCALES) {
      const L = stringsFor(locale as AnalysisLocale);
      expect(LOCALE[locale].searchNote).toBe(L.searchNote);
      expect(LOCALE[locale].technicalNote).toBe(L.technicalNote);
      expect(LOCALE[locale].fallbackNote).toBe(L.fallbackNote);
      // The schema instruction, marker and tail are not exported as constants
      // by locale.ts — they are fragments of two template functions — so they
      // are recovered by building with a sentinel payload and a sentinel body.
      expect(L.schemaInstruction("PAYLOAD")).toBe(`${LOCALE[locale].schemaInstruction}PAYLOAD`);
      expect(LOCALE[locale].schemaInstruction.startsWith(LOCALE[locale].schemaMarker)).toBe(true);
      const built = L.userMessage({ pair: "P", nowUtc: "N", note: "NOTE", sections: "SEC", schema: "" });
      expect(built.startsWith(`${LOCALE[locale].pairPrefix}P\n${LOCALE[locale].nowPrefix}N\nNOTE\n\nSEC\n\n`)).toBe(true);
      expect(built.endsWith(LOCALE[locale].tail)).toBe(true);
      // And the rules heading and fit note come from rules.ts's own renderer,
      // where neither is exported either.
      const block = rulesBlockFor(locale);
      expect(LOCALE[locale].rulesHeaders).toContain(block.split("\n")[0]);
      expect(block.split("\n")[1]).toBe(LOCALE[locale].fitNote);
    }
  });
});

// -- 13 -------------------------------------------------------------------

describe("A2-A7 accept the shape production writes, and each has its own refusal", () => {
  it("accepts a search-derived Japanese row", () => {
    const row = classifySearchRow();
    expect(row.promptClass).toBe("search_derived");
    expect(row.markerIndex).not.toBeNull();
    expect(row.rules.ranked).toBe(true);
    expect(row.rules.ruleLines).toHaveLength(3);
    expect(row.rules.heldBackNote).toBeNull();
  });

  it("accepts the technical row, which carries no schema in its text", () => {
    // Measured 3/3 on the live technical_only rows: zero schema markers, and
    // the prompt ends exactly on the tail sentence.
    const row = accepted(classifyRow({
      user: userFor({ note: stringsFor("ja").technicalNote, payload: null }),
      system: systemFor("ja"),
      mode: "technical_only",
    }));
    expect(row.promptClass).toBe("technical");
    expect(row.markerIndex).toBeNull();
    expect(row.schemaEra).toBe("none");
  });

  const refusalOf = (user: string, system: string, mode: string): string => {
    const r = classifyRow({ user, system, mode });
    expect(isRefusal(r)).toBe(true);
    return isRefusal(r) ? r.code : "";
  };

  it("A2 refuses a second line without the UTC-time prefix", () => {
    const lines = userFor().split("\n");
    lines[1] = "時刻: 2026-09-09T12:00:00.000Z";
    expect(refusalOf(lines.join("\n"), systemFor("ja"), "full")).toBe("line2_shape");
  });

  it("A3 refuses a note line that is not one of the three known notes", () => {
    const lines = userFor().split("\n");
    // A near miss, not gibberish: the reader compares the whole line, so a note
    // that merely STARTS like a known one must still refuse.
    lines[2] = `${stringsFor("ja").searchNote} 追加の指示。`;
    expect(refusalOf(lines.join("\n"), systemFor("ja"), "full")).toBe("note_unrecognised");
  });

  it("A4 refuses when line 4 is not blank", () => {
    const lines = userFor().split("\n");
    lines[3] = "余計な行";
    expect(refusalOf(lines.join("\n"), systemFor("ja"), "full")).toBe("line4_not_blank");
  });

  it("A5 refuses when the tail sentence is not unique", () => {
    // Half the strip's anchor. A second copy anywhere in the market data means
    // `indexOf` can no longer say where the prompt body ends.
    const user = userFor({ sections: `${SECTIONS}\n${LOCALE.ja.tail}` });
    expect(refusalOf(user, systemFor("ja"), "full")).toBe("tail_not_unique");
  });

  it("A6 refuses when analyses.mode disagrees with the note line", () => {
    // The column is a cross-check, never the discriminator: index.ts can move
    // `resolvedMode` without calling giveUpSearch, so the two can part company
    // in principle. They agree on 48/48 today.
    expect(refusalOf(userFor(), systemFor("ja"), "technical_only")).toBe("mode_text_disagree");
    expect(MODE_FOR_CLASS.search_derived).toBe("full");
    expect(MODE_FOR_CLASS.technical).toBe("technical_only");
    expect(MODE_FOR_CLASS.already_fallback).toBe("technical_fallback");
  });

  it("A7 refuses a system with no rules heading, and one with two", () => {
    expect(refusalOf(userFor(), "You are the analyst.\nNo rulebook here.", "full")).toBe("seam_absent");
    const block = rulesBlockFor("ja");
    expect(refusalOf(userFor(), `${systemFor("ja")}\n\n${block}`, "full")).toBe("seam_ambiguous");
  });
});

// -- 14 -------------------------------------------------------------------

describe("the schema strip is anchored on the marker and the tail, not on today's schema", () => {
  // THE CLAIM, RE-MEASURED 2026-09-09 AGAINST PRODUCTION.
  //
  // The stored search-derived prompts carry two generations of the schema
  // suffix, sliced from the marker `\n\n最終回答は<json>タグ内に` to
  // end-of-string:
  //
  //   2617 chars / 3043 bytes  md5 5d3d5538fb27e74b37af2babeb2e2af4  41 rows
  //   2811 chars / 3449 bytes  md5 5cfa2b6d1d26cf322bc5b3142929a7bc   4 rows
  //
  // and rebuilding `schemaInstruction(JSON.stringify(RESPONSE_SCHEMA))` from
  // the working tree today gives 2811 chars, md5 5cfa2b6d… — byte-identical to
  // the four-row generation. So an implementation written as
  // `user.endsWith(todaysInstruction) ? strip : refuse` accepts 4 rows and
  // REFUSES 41 OF THE 45 search-derived rows. That is not an estimate; it is
  // the count the query returned.
  //
  // The test below stages the same situation with two synthetic payloads:
  // whichever one is "today's", the other one must still strip.
  it("strips both generations, though only one of them is today's", () => {
    const todaysSuffix = stringsFor("ja").schemaInstruction(PAYLOAD_NEW);

    for (const payload of [PAYLOAD_OLD, PAYLOAD_NEW]) {
      const user = userFor({ payload });
      const row = classifySearchRow({ payload });
      expect(row.markerIndex).toBe(user.indexOf(LOCALE.ja.schemaMarker));
      expect(stripSchemaSuffix(row).endsWith(LOCALE.ja.tail)).toBe(true);
      expect(stripSchemaSuffix(row)).not.toContain(LOCALE.ja.schemaMarker);
    }

    // ...and the older generation is exactly the row the endsWith test drops.
    expect(userFor({ payload: PAYLOAD_NEW }).endsWith(todaysSuffix)).toBe(true);
    expect(userFor({ payload: PAYLOAD_OLD }).endsWith(todaysSuffix)).toBe(false);
  });

  it("records the two measured eras and labels an uncatalogued one 'unknown'", () => {
    const v44 = SCHEMA_ERAS.find((e) => e.era === "v44");
    const v48 = SCHEMA_ERAS.find((e) => e.era === "v48");
    expect(v44?.suffixLength).toBe(2617);
    expect(v44?.suffixMd5).toBe("5d3d5538fb27e74b37af2babeb2e2af4");
    expect(v48?.suffixLength).toBe(2811);
    expect(v48?.suffixMd5).toBe("5cfa2b6d1d26cf322bc5b3142929a7bc");
    // Both digests are pinned, not only the md5. The md5 is traceability — it
    // is the figure the SQL printed — but the sha256 is the one `detectSchemaEra`
    // actually compares against, so leaving it unpinned would let a typo in the
    // only load-bearing digest demote the whole corpus to "unknown" with every
    // test still green. Re-measured 2026-09-09 with
    // `encode(sha256(convert_to(suffix,'UTF8')),'hex')` over the stored rows,
    // and the v48 value re-derived independently by rebuilding
    // `schemaInstruction(JSON.stringify(RESPONSE_SCHEMA))` from the working tree.
    expect(v44?.suffixSha256).toBe("ef9636d3cb76984077207df45e43f25e5ccee4e80885ded001fa89184df2a818");
    expect(v48?.suffixSha256).toBe("9d28925fc24c5c0946e23bcf525ec36b8359002ee88704d3a1d2bf7a9d70ae05");

    // Length alone names the era when no digest is offered...
    expect(detectSchemaEra("x".repeat(2617))).toBe("v44");
    expect(detectSchemaEra("x".repeat(2811))).toBe("v48");
    // ...a digest that disagrees demotes it to unknown rather than mislabelling...
    expect(detectSchemaEra("x".repeat(2617), "0".repeat(64))).toBe("unknown");
    expect(detectSchemaEra("x".repeat(2617), v44!.suffixSha256)).toBe("v44");
    // ...and an era nobody has catalogued is recorded, never refused: the
    // replay's job is to send the stored bytes back whatever wrote them.
    expect(detectSchemaEra("x".repeat(1234))).toBe("unknown");
    expect(detectSchemaEra(null)).toBe("none");
    const row = classifySearchRow();
    expect(row.schemaEra).toBe("unknown");
    expect(row.schemaSuffix).not.toBeNull();
  });
});

// -- 15 -------------------------------------------------------------------

describe("B1-B4 each refuse with their own code", () => {
  const refusalOf = (user: string): string => {
    const r = classifyRow({ user, system: systemFor("ja"), mode: "full" });
    expect(isRefusal(r)).toBe(true);
    return isRefusal(r) ? r.code : "";
  };

  it("B1 refuses two markers", () => {
    // A second marker inside the market data: `indexOf` would find the wrong
    // one and the strip would cut away a chunk of the prompt body.
    expect(refusalOf(userFor({ sections: `${SECTIONS}${LOCALE.ja.schemaMarker}x` }))).toBe("marker_not_unique");
  });

  it("B2 refuses a marker that does not sit immediately after the tail", () => {
    const user = userFor();
    const at = user.indexOf(LOCALE.ja.schemaMarker);
    expect(refusalOf(`${user.slice(0, at)}なお補足。${user.slice(at)}`)).toBe("marker_not_adjacent");
  });

  it("B3 refuses a marker whose slice does not run to the end", () => {
    expect(refusalOf(`${userFor()}\n\n追伸。`)).toBe("marker_not_terminal");
    // The same code covers the other half of "terminal": a prompt with no
    // schema at all that nonetheless does not end at the tail sentence.
    expect(refusalOf(`${userFor({ payload: null })}\n追伸。`)).toBe("marker_not_terminal");
  });

  it("B4 refuses a payload that is not a JSON Schema object", () => {
    // Ends where a JSON object ends and still will not parse: a malformed
    // schema, told apart from appended prose by that closing brace.
    expect(refusalOf(userFor({ payload: "{not json}" }))).toBe("schema_unparseable");
    // Parses, but is not a schema: `required` missing.
    expect(refusalOf(userFor({ payload: JSON.stringify({ type: "object", properties: {} }) }))).toBe("schema_unparseable");
    // Parses to an array, which has no keys to check.
    expect(refusalOf(userFor({ payload: "[1,2,3]" }))).toBe("schema_unparseable");
    // ...whereas text appended after a well-formed schema is a terminality
    // failure and must not be reported as the analyzer changing its schema.
    expect(refusalOf(`${userFor()}\n\n追伸。`)).toBe("marker_not_terminal");
  });
});

// -- 15b ------------------------------------------------------------------

describe("the note line and the inline schema have to agree about the shape", () => {
  // `analyze/index.ts` binds the two in one expression — the note and
  // `schemaInPrompt` are the two arguments of the same `buildUserMessage` call
  // — so the search note always carries the schema and the other two never do
  // (measured 2026-09-09: 45 search rows with one marker, 3 technical rows with
  // none). The class is what the caller picks the request shape from, so a row
  // where they part company would be replayed in a shape production never sent,
  // on the note's word alone and with nothing downstream to notice.
  it("refuses a technical row that carries a schema in its text", () => {
    // The direction that decides the assert: sent as `structured`, this row
    // would get `output_config.format` ON TOP OF the schema still in its text.
    // Constrained decoding mechanically deletes the parse-failure class the
    // measurement exists to keep, and deleting it measures the floor LOW —
    // the error that lets #65 read a real regression as noise.
    const r = classifyRow({
      user: userFor({ note: stringsFor("ja").technicalNote }),
      system: systemFor("ja"),
      mode: "technical_only",
    });
    expect(isRefusal(r)).toBe(true);
    expect(isRefusal(r) && r.code).toBe("class_shape_disagree");
  });

  it("refuses a search-derived row that carries no schema in its text", () => {
    // The mirror: replayed inline with `{effort:"low"}` and no `format`, this
    // row would reach the model with no field contract anywhere at all.
    const r = classifyRow({ user: userFor({ payload: null }), system: systemFor("ja"), mode: "full" });
    expect(isRefusal(r)).toBe(true);
    expect(isRefusal(r) && r.code).toBe("class_shape_disagree");
  });

  it("still reports terminality first when a schema-free row does not end at the tail", () => {
    // Ordering matters: B3 is a statement about the bytes and this assert is a
    // statement about the request, and a prompt with something appended after
    // the tail is the former. Naming it a shape disagreement would send an
    // operator looking at `analyze`'s note/schema weld instead of at whatever
    // started appending to the prompt.
    const r = classifyRow({ user: `${userFor({ payload: null })}\n追伸。`, system: systemFor("ja"), mode: "full" });
    expect(isRefusal(r) && r.code).toBe("marker_not_terminal");
  });

  it("accepts the two combinations production actually writes", () => {
    expect(classifySearchRow().markerIndex).not.toBeNull();
    expect(accepted(classifyRow({
      user: userFor({ note: stringsFor("ja").technicalNote, payload: null }),
      system: systemFor("ja"),
      mode: "technical_only",
    })).markerIndex).toBeNull();
  });
});

// -- 16, 17 ---------------------------------------------------------------

describe("the fallback transform holds its four post-conditions", () => {
  const row = () => classifySearchRow();

  it("rewrites the note and strips the schema, and nothing else", () => {
    const original = userFor();
    const out = fallbackTransform(row());
    expect(isRefusal(out)).toBe(false);
    if (isRefusal(out)) return;
    const L = LOCALE.ja;
    const lines = out.user.split("\n");

    // 1. the fallback note, exactly once, at line index 2, line 3 still blank
    expect(lines[2]).toBe(L.fallbackNote);
    expect(lines[3]).toBe("");
    expect(out.user.split(L.fallbackNote)).toHaveLength(2);

    // 2. zero markers
    expect(out.user).not.toContain(L.schemaMarker);

    // 3. ends exactly with the tail sentence
    expect(out.user.endsWith(L.tail)).toBe(true);

    // 4. byte identity either side of the swapped line. Two spans, because the
    // swap moves every offset after line 3 by the difference in the two notes'
    // lengths — a single-span check would either be vacuous or fail on a
    // correct transform.
    const prefixEnd = lines[0].length + 1 + lines[1].length + 1;
    expect(out.user.slice(0, prefixEnd)).toBe(original.slice(0, prefixEnd));
    const origBodyStart = prefixEnd + L.searchNote.length + 1;
    const outBodyStart = prefixEnd + L.fallbackNote.length + 1;
    const origBodyEnd = original.indexOf(L.tail) + L.tail.length;
    expect(out.user.slice(outBodyStart)).toBe(original.slice(origBodyStart, origBodyEnd));
    // and the two notes really are different lengths, so 4b is not vacuous
    expect(L.fallbackNote.length).not.toBe(L.searchNote.length);
  });

  it("produces exactly what giveUpSearch would have built", () => {
    // THE STRONGEST CHECK AVAILABLE, AND IT IS STILL NOT THE REAL THING.
    // `giveUpSearch` calls `buildUserMessage(FALLBACK_NOTE, false)`, which is
    // `userMessage` with the fallback note and an empty schema argument — so
    // that is what the transform is compared against here, byte for byte.
    //
    // It is a SAME-BUILDER SIBLING and not a stored exemplar, because ZERO
    // `technical_fallback` rows have ever been written to `analysis_prompts`
    // (measured 2026-09-09: 45 full, 3 technical_only, 0 technical_fallback).
    // The only stored rows built by this call are the 3 `technical_only` ones,
    // which differ from the target in the note line alone — and those same 3
    // rows are simultaneously the control here and the confound in the run,
    // being also the only rows the primary arm sends in the structured shape.
    const out = fallbackTransform(row());
    expect(isRefusal(out)).toBe(false);
    const expected = userFor({ note: stringsFor("ja").fallbackNote, payload: null });
    expect(!isRefusal(out) && out.user).toBe(expected);
  });

  it("satisfies the same invariants the stored technical rows satisfy", () => {
    const technical = accepted(classifyRow({
      user: userFor({ note: stringsFor("ja").technicalNote, payload: null }),
      system: systemFor("ja"),
      mode: "technical_only",
    }));
    const out = fallbackTransform(row());
    expect(isRefusal(out)).toBe(false);
    if (isRefusal(out)) return;
    const storedTechnical = technical.lines.join("\n");
    for (const text of [out.user, storedTechnical]) {
      expect(text.split(LOCALE.ja.schemaMarker)).toHaveLength(1);
      expect(text.endsWith(LOCALE.ja.tail)).toBe(true);
      expect(text.split("\n")[3]).toBe("");
    }
  });

  it("refuses rather than transforming a row that does not need it", () => {
    const technical = accepted(classifyRow({
      user: userFor({ note: stringsFor("ja").technicalNote, payload: null }),
      system: systemFor("ja"),
      mode: "technical_only",
    }));
    const out = fallbackTransform(technical);
    expect(isRefusal(out)).toBe(true);
    expect(isRefusal(out) && out.code).toBe("transform_invariant");
  });

  it("never reaches for String.replace on the note line", () => {
    // `replace` and `replaceAll` read the REPLACEMENT as a template: `$&`,
    // `$1`, "$`" and "$'" expand inside it. Zero `$` occur in any of the 48
    // stored user turns or systems (measured), so nothing would misfire today
    // — which is exactly the condition under which such a bug survives review.
    // Split, assert the index, assign, rejoin has no template semantics at all.
    expect(surgerySrc).not.toContain(".replace(");
    expect(surgerySrc).not.toContain(".replaceAll(");
  });
});

// -- 18 -------------------------------------------------------------------

describe("locateRulesBlock finds the seam #65 will cut on, or refuses", () => {
  it("finds the heading once, preceded by a single newline, running to the end", () => {
    const block = rulesBlockFor("ja");
    const system = systemFor("ja", block);
    const found = locateRulesBlock(system, "ja");
    expect(isRefusal(found)).toBe(false);
    if (isRefusal(found)) return;
    expect(found.header).toBe(block.split("\n")[0]);
    expect(found.blockStart).toBe(system.indexOf(`\n${found.header}`) + 1);
    expect(found.block).toBe(block);
    expect(system.slice(found.blockStart)).toBe(block);
    expect(found.ranked).toBe(true);
    expect(found.ruleLines).toHaveLength(3);
    expect(found.ruleLines.every((l) => l.startsWith("- "))).toBe(true);
    expect(found.heldBackNote).toBeNull();
  });

  const codeOf = (system: string, locale: SurgeryLocale = "ja"): string => {
    const r = locateRulesBlock(system, locale);
    expect(isRefusal(r)).toBe(true);
    return isRefusal(r) ? r.code : "";
  };

  it("refuses an absent heading, a doubled heading, and a heading at index 0", () => {
    expect(codeOf("You are the analyst.\nNothing learned yet.")).toBe("seam_absent");
    expect(codeOf(`${systemFor("ja")}\n\n${rulesBlockFor("ja")}`)).toBe("seam_ambiguous");
    // No preceding newline means no seam: `blockStart` is defined as the index
    // after that newline, so there is nothing to cut on.
    expect(codeOf(rulesBlockFor("ja"))).toBe("seam_absent");
    // More than one blank line before the heading is a template this reader has
    // never seen; refusing beats guessing which newline the seam is.
    expect(codeOf(`Procedure.\n\n${rulesBlockFor("ja")}`)).toBe("seam_ambiguous");
  });

  it("refuses a heading that is merely similar — there is no fuzzy prefix match", () => {
    const block = rulesBlockFor("ja");
    const lines = block.split("\n");
    lines[0] = `${lines[0].slice(0, 20)}（表現を変えた見出し）:`;
    expect(codeOf(systemFor("ja", lines.join("\n")))).toBe("seam_absent");
  });

  it("refuses a block whose body is not rule lines", () => {
    const lines = rulesBlockFor("ja").split("\n");
    lines[3] = "ルール本文ではない行";
    expect(codeOf(systemFor("ja", lines.join("\n")))).toBe("seam_malformed");
  });

  it("reads the held-back note rules.ts actually writes, in both locales", () => {
    // `heldBackMarker` is the one locale constant the byte-for-byte test above
    // cannot reach: `heldBack()` is a private function of rules.ts and the
    // sentence only exists when the budget bites. So it is pinned here instead,
    // against the real renderer — capping `maxRules` forces the cut without
    // touching the character budget, and the marker has to match both the
    // ranked and the unranked wording, which differ after it.
    //
    // Zero of the 48 stored blocks carry one (measured 2026-09-09), which is
    // why the reader treats it as an optional last line rather than assuming it
    // can never appear — and why nothing else would have exercised this branch.
    for (const locale of SURGERY_LOCALES) {
      const cut = selectPromptRules(RULES, locale, null, 2, promptCharBudget(locale), {});
      expect(cut.heldBack).toBe(1);
      const note = cut.text.split("\n").at(-1) ?? "";
      expect(note.includes(LOCALE[locale].heldBackMarker)).toBe(true);
      expect(note.startsWith("- ")).toBe(false);

      const found = locateRulesBlock(systemFor(locale, cut.text), locale);
      expect(isRefusal(found)).toBe(false);
      if (isRefusal(found)) return;
      expect(found.ranked).toBe(true);
      expect(found.ruleLines).toHaveLength(2);
      expect(found.heldBackNote).toBe(note);
    }
  });

  it("refuses a rule line that follows the held-back note", () => {
    // The note is the LAST line or the block is not one: a rule after it means
    // the reader has mistaken some other sentence for the note, and #65 would
    // be handed a block whose tail it cannot account for.
    const cut = selectPromptRules(RULES, "ja", null, 2, promptCharBudget("ja"), {});
    expect(codeOf(systemFor("ja", `${cut.text}\n- [r12] 注記のあとに来たルール`))).toBe("seam_malformed");
  });

  it("reads an unranked block as unranked rather than refusing it", () => {
    // `fits === null` renders the heading with no fit note. No stored row is
    // shaped like this (48/48 carry the note), but the renderer can still
    // produce it, so the reader reports the shape instead of rejecting it.
    const found = locateRulesBlock(systemFor("ja", rulesBlockFor("ja", false)), "ja");
    expect(isRefusal(found)).toBe(false);
    expect(!isRefusal(found) && found.ranked).toBe(false);
    expect(!isRefusal(found) && found.ruleLines).toHaveLength(3);
  });
});

// -- 19 -------------------------------------------------------------------

describe("spliceRulesBlock replaces the block and nothing before it", () => {
  const system = systemFor("ja");
  const candidate = `${rulesBlockFor("ja")}\n- [r12]［1h］追加された候補ルール（実績1件）`;

  it("changes the system only at and after blockStart", () => {
    const located = locateRulesBlock(system, "ja");
    expect(isRefusal(located)).toBe(false);
    if (isRefusal(located)) return;
    const out = spliceRulesBlock(system, candidate, "ja");
    expect(isRefusal(out)).toBe(false);
    if (isRefusal(out)) return;
    expect(out.blockStart).toBe(located.blockStart);
    expect(out.system.slice(0, out.blockStart)).toBe(system.slice(0, out.blockStart));
    expect(out.system.slice(out.blockStart)).toBe(candidate);
    expect(out.system).not.toBe(system);
    // The first difference is exactly at blockStart, not one character either
    // side of it: an off-by-one would move a character of the procedure into
    // the rulebook without showing up in a diff of the two blocks.
    let firstDiff = 0;
    while (firstDiff < system.length && firstDiff < out.system.length &&
      system[firstDiff] === out.system[firstDiff]) firstDiff += 1;
    expect(firstDiff).toBeGreaterThanOrEqual(out.blockStart);
    expect(system[out.blockStart - 1]).toBe("\n");
  });

  it("refuses a candidate carrying a dollar sign", () => {
    // A tripwire, not a fix: the splice itself is slice-and-concat and is
    // immune. Zero `$` occur in any of the 48 stored systems (measured), so
    // refusing costs nothing today and pins the assumption for whoever next
    // reaches for a replace-based splice.
    const out = spliceRulesBlock(system, `${candidate}$&`, "ja");
    expect(isRefusal(out)).toBe(true);
    expect(isRefusal(out) && out.code).toBe("candidate_has_dollar");
  });

  it("refuses a candidate that is a bare rule list rather than a block", () => {
    const out = spliceRulesBlock(system, "- [r12] 見出しのない候補", "ja");
    expect(isRefusal(out)).toBe(true);
    expect(isRefusal(out) && out.code).toBe("candidate_not_a_block");
  });

  it("refuses when the system has no seam to splice on", () => {
    const out = spliceRulesBlock("You are the analyst.", candidate, "ja");
    expect(isRefusal(out)).toBe(true);
    expect(isRefusal(out) && out.code).toBe("seam_absent");
  });
});
