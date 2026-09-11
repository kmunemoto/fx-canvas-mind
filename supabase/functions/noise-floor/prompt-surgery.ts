// Reading a stored analyst prompt back well enough to send it again.
//
// The noise floor is measured by replaying `public.analysis_prompts` — the
// exact `system` and `user` strings a past analysis was made from — and
// counting how often the second answer differs from the first. Nothing in that
// table says which SHAPE of request the row was born in: `output_config`,
// `tools` and `max_tokens` were never stored. The only surviving witness is the
// prompt text itself, so this file is the reader for it: it decides which class
// a row belongs to, refuses a row it cannot read, and — for the one arm that
// asks for it — rewrites a searching prompt into the technical-fallback prompt
// the analyzer would itself have built had search been unavailable.
//
// TWO RULES GOVERN EVERY FUNCTION HERE, and they are the reason the file is
// shaped the way it is.
//
// 1. EVERY ASSERT REFUSES. There is no transform-with-a-fallback anywhere in
//    this module. A row that fails any check is returned as a refusal code and
//    reported as an exclusion; it is never patched up, never best-effort
//    parsed, and never silently passed through unchanged. The measurement this
//    file feeds is a disagreement rate, and a row repaired by a guess is a row
//    whose two replicates might disagree because the repair was applied
//    inconsistently rather than because the model changed its mind. An
//    excluded row costs one denominator; a repaired row costs the result.
//
// 2. NOTHING IS COMPARED AGAINST TODAY'S PROMPT. See `detectSchemaEra` and
//    `stripSchemaSuffix` below for the measurement that forced this, but the
//    short form is: the stored corpus spans two generations of RESPONSE_SCHEMA
//    and will span more, and any check written as "does this equal what
//    analyze/index.ts would build right now" refuses the older generation.
//    Every anchor in this file is a sentence that has not changed — the note
//    line, the tail sentence, the schema-instruction marker — never a payload.
//
// Zero imports, on purpose and by the same argument `_shared/episodes.ts`
// makes: this file is read by the Deno edge function, by vitest, and (from
// #65) by whatever splices a candidate rulebook into a stored system prompt.
// Importing `analyze/locale.ts` would be a one-line change and is deliberately
// not made — see the comment above LOCALE.

// ---------------------------------------------------------------------------
// The locale tables
// ---------------------------------------------------------------------------

export const SURGERY_LOCALES = ["ja", "en"] as const;
export type SurgeryLocale = (typeof SURGERY_LOCALES)[number];

// WHY THESE STRINGS ARE DUPLICATED FROM analyze/locale.ts RATHER THAN IMPORTED.
//
// They are byte-for-byte copies of `stringsFor(locale)` and of the two literals
// `userMessage` interpolates around its arguments, and `src/test/
// noise-floor-surgery.test.ts` asserts that equality against the real module on
// every run, so the copy cannot drift unnoticed.
//
// The copy exists because the two files answer different questions about the
// same sentence. `locale.ts` answers "what does the analyzer SAY today"; this
// file answers "what did a prompt written at some point in the past SAY". Those
// are the same string right now and are not required to stay so. The day a
// wording is improved, `locale.ts` must change — that is its job — and this
// table must NOT, because forty-eight stored rows still carry the old wording
// and a reader that follows the new one refuses all of them at once. An import
// would make that failure automatic and silent; the duplicate plus the equality
// test makes it a red test that a human answers by deciding whether the old
// wording gets its own entry here.
//
// That is not a hypothetical: `schemaInstruction`'s PAYLOAD already has two
// generations in the live corpus (41 rows and 4 rows, measured 2026-09-09), and
// the only reason its SENTENCE has one is that nobody has edited it yet.
//
// The second reason is smaller and still decides it: importing `locale.ts`
// would put an `analyze/` file in this function's bundle, and the point of a
// noise floor is that #65 can prove both of its arms ran the identical shape
// even after `analyze` has moved on.
export interface LocaleTable {
  // Line 1 of the user turn: `通貨ペア: ${pair}`. The prefix is the locale
  // discriminator — it is the first thing on the wire and cannot be absent.
  pairPrefix: string;
  // Line 2: `現在時刻(UTC): ${nowUtc}`.
  nowPrefix: string;
  // Line 3, one of exactly three values. This is the arm discriminator: it is
  // what was actually SENT, as opposed to `analyses.mode`, which is a column
  // set by a code path that can move without the bytes moving (index.ts sets
  // searchDroppedReason="no_allowed_domains" without calling giveUpSearch).
  searchNote: string;
  technicalNote: string;
  fallbackNote: string;
  // The last sentence of the prompt body, immediately before the schema suffix
  // when there is one and at end-of-string when there is not. Together with the
  // marker below it is the whole anchor for the strip.
  tail: string;
  // The opening of `schemaInstruction`, short enough to have survived every
  // edit to the schema PAYLOAD. Anchoring on this rather than on the whole
  // instruction is the point of the file — see detectSchemaEra.
  schemaMarker: string;
  // The full fixed part of `schemaInstruction`, marker through the newline that
  // separates the sentence from the JSON. Used only to locate where the JSON
  // payload begins, never to decide whether a row is acceptable.
  schemaInstruction: string;
  // Every heading the learned-rules block has ever been rendered under, most
  // recent first. An explicit list and never a prefix or fuzzy match: the
  // heading is the seam #65 cuts on, and a fuzzy match that drifts onto a
  // neighbouring sentence would splice a candidate rulebook into the middle of
  // the analytical procedure. Only the wording measured in the live corpus is
  // listed; when a heading changes, the old wording is ADDED here rather than
  // replaced, and until someone does that a row carrying it refuses.
  rulesHeaders: readonly string[];
  // Said once under the heading whenever the block was rendered ranked. Present
  // in 48/48 stored systems (measured 2026-09-09), which is how we know every
  // stored block was rendered with `fits !== null` — the thing #65 cannot
  // reproduce by re-rendering, because re-rendering recomputes the markers
  // against today's indicators.
  fitNote: string;
  // The fragment that identifies the "N further rules were left out" sentence
  // `rules.ts` appends when the character budget bites. Zero stored blocks
  // carry it (measured), so the shape check treats it as an optional last line
  // rather than assuming it can never appear.
  heldBackMarker: string;
}

export const LOCALE: Record<SurgeryLocale, LocaleTable> = {
  ja: {
    pairPrefix: "通貨ペア: ",
    nowPrefix: "現在時刻(UTC): ",
    searchNote:
      "分析モード: full — まずweb検索で本日の経済指標・金融政策・当該通貨の材料を確認し、fundamental_score とファンダ要因を分析に統合してください。検索は2回まで。",
    technicalNote:
      "分析モード: technical_only — テクニカルのみで判断し、fundamental_score は50、ファンダ要因には言及しないでください。",
    fallbackNote:
      "分析モード: technical_fallback — ニュース検索が利用できないため、テクニカルのみで判断し、fundamental_score は50、ファンダ要因には言及しないでください。",
    tail: "上記のマルチタイムフレームデータを手順1-6に沿って分析し、トレードプランを出力してください。",
    schemaMarker: "\n\n最終回答は<json>タグ内に",
    schemaInstruction:
      "\n\n最終回答は<json>タグ内に、次のJSON Schemaに厳密に従ったJSONのみを出力してください。キー名とenum値は英語のまま一字一句一致させ、required のフィールドは全て含めること。スキーマ外のキーは出力しないこと。\n",
    rulesHeaders: [
      "過去の判定から学んだルール（実際の値動きの検証から作成。上の手順とリスク規定が優先で、これらは同じ条件下での補助的な指針。「検証中」は根拠がまだ少ない）:",
    ],
    fitNote:
      "各ルールの「今の相場」判定は、そのルールの根拠になった過去の局面の実測値（ADX・RSI・SMA20乖離のATR倍・BB内の位置・上位足ADX）と現在値をサーバが機械的に比べた結果であって、ルール本文の主張ではない。判定できない場合はそう書く。",
    heldBackMarker: "文字数の都合で省略した。",
  },
  en: {
    pairPrefix: "Currency pair: ",
    // NOT "Now (UTC): ". The design brief for #64 wrote that wording and it
    // does not exist anywhere in the repo; `locale.ts` has said
    // "Current time (UTC): " since the English locale was added. Copied from
    // the source rather than from the brief, and the equality test in
    // src/test/noise-floor-surgery.test.ts is what proves which one is real.
    nowPrefix: "Current time (UTC): ",
    searchNote:
      "Mode: full — first use web search to check today's economic releases, monetary policy and any news moving this pair, then fold that into fundamental_score and the analysis. At most 2 searches.",
    technicalNote:
      "Mode: technical_only — judge on the technicals alone, set fundamental_score to 50, and do not refer to fundamentals.",
    fallbackNote:
      "Mode: technical_fallback — news search is unavailable, so judge on the technicals alone, set fundamental_score to 50, and do not refer to fundamentals.",
    tail: "Analyse the multi-timeframe data above following steps 1-6 and output the trade plan.",
    schemaMarker: "\n\nReturn your final answer inside <json> tags as JSON only,",
    schemaInstruction:
      "\n\nReturn your final answer inside <json> tags as JSON only, strictly following this JSON Schema. Keep key names and enum values exactly as written, include every required field, and output no keys outside the schema.\n",
    rulesHeaders: [
      "Rules learned from past outcomes (drawn from reviews against actual prices; the procedure and risk limits above take precedence, these are supplementary guidance under the same conditions; \"under review\" means the evidence is still thin):",
    ],
    fitNote:
      "The \"now\" verdict on each rule is a mechanical comparison the server made between today's readings and those measured on the past plans that rule was drawn from (ADX, RSI, distance from SMA20 in ATR, position in the Bollinger band, higher-timeframe ADX). It is not a claim made by the rule's own text, and it says so when it cannot tell.",
    heldBackMarker: "were left out for length",
  },
};

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

// One code per assert. They are stored on the cell and printed in the run
// report, so a run that excluded rows says WHICH assert excluded them — the
// difference between "three rows were unreadable" and "three rows were written
// by a builder this reader has never seen".
export type RefusalCode =
  // A1..A7, classification
  | "locale_undetected"
  | "line2_shape"
  | "note_unrecognised"
  | "line4_not_blank"
  | "tail_not_unique"
  | "mode_text_disagree"
  | "seam_absent"
  | "seam_ambiguous"
  // The learned-rules block was found where it should be but is not shaped
  // like one. Not in the brief's list; added because `locateRulesBlock`
  // promises #65 a block it can replace wholesale, and "the heading is in the
  // right place" is not that promise.
  | "seam_malformed"
  // The note line and the bytes name different request shapes. Not in the
  // brief's list either; see the assert in `classifyRow` for the measurement
  // that says the two are welded together in `analyze/index.ts`, and for why a
  // row where they come apart must not be replayed on the strength of its note.
  | "class_shape_disagree"
  // B1..B4, schema-era detection. B5 (which era) never refuses: an unrecognised
  // era is RECORDED as "unknown" and replayed as it stands, because the point
  // of the replay is to send the stored bytes and an era we have not catalogued
  // is still stored bytes.
  | "marker_not_unique"
  | "marker_not_adjacent"
  | "marker_not_terminal"
  | "schema_unparseable"
  // The four post-conditions of the fallback transform
  | "transform_invariant"
  // spliceRulesBlock's two checks on the candidate it is handed
  | "candidate_has_dollar"
  | "candidate_not_a_block";

export interface Refusal {
  ok: false;
  code: RefusalCode;
  // Bounded, and never the prompt: enough to say which assert and what it saw,
  // short enough that it can be written to a column and read in a log without
  // putting prompt text anywhere it was deliberately removed from (see
  // 20260905161000_replay_inputs_are_server_side.sql).
  detail: string;
}

const refuse = (code: RefusalCode, detail: string): Refusal => ({ ok: false, code, detail });

// Every function here returns its answer or a Refusal, so callers need one
// discriminator rather than one per return type. `ok === false` rather than
// `"ok" in value`, because `RulesBlock` deliberately carries no `ok` field —
// it is embedded inside `ClassifiedRow`, where a second `ok` would read as a
// second verdict about the same row.
export const isRefusal = <T extends object>(value: T | Refusal): value is Refusal =>
  (value as Partial<Refusal>).ok === false;

// Occurrence counting without a regular expression, because every needle here
// is prose containing characters that are regex metacharacters in some locale
// or other — parentheses, brackets, a full stop, quotation marks — and a needle
// that is silently reinterpreted as a pattern is exactly the class of bug this
// file exists to refuse rather than absorb.
export const countOccurrences = (haystack: string, needle: string): number => {
  if (needle.length === 0) return 0;
  let n = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return n;
    n += 1;
    from = at + needle.length;
  }
};

// ---------------------------------------------------------------------------
// A1 — locale
// ---------------------------------------------------------------------------

// The locale is fixed HERE and every later constant is read from that locale's
// table. It is done first and once because the alternative — checking each
// assert against both tables — accepts a row whose first line is Japanese and
// whose note line is English, which is not a row any builder can produce and is
// therefore a row we have misread.
//
// Measured 2026-09-09 over all 48 stored rows: 48 ja, 0 en. The English branch
// has never been exercised by production data, which is the reason it must
// refuse rather than fall through to Japanese: a corpus with one observed
// locale is exactly the situation in which a default quietly becomes the only
// thing that ever runs.
export const detectLocale = (user: string): SurgeryLocale | null => {
  for (const locale of SURGERY_LOCALES) {
    if (user.startsWith(LOCALE[locale].pairPrefix)) return locale;
  }
  return null;
};

// ---------------------------------------------------------------------------
// B5 — the schema eras
// ---------------------------------------------------------------------------

export type SchemaEra = "v44" | "v48" | "none" | "unknown";

export interface SchemaEraEntry {
  era: "v44" | "v48";
  // UTF-16 code units, which is what String.length counts. Every character in
  // both suffixes is in the BMP, so this equals the character count Postgres
  // `length()` reports; that agreement was checked rather than assumed
  // (Postgres said 2617/2811 over the stored rows, and rebuilding today's
  // suffix in a JS runtime said 2811 for the same bytes).
  suffixLength: number;
  // Both digests over the UTF-8 encoding of the suffix. md5 is the figure the
  // SQL that measured this printed, and is here so the number in the report can
  // be traced back to the query; sha256 is the one a runtime can actually
  // recompute, because WebCrypto has no md5 and adding a hash dependency would
  // cost this file its zero imports.
  suffixMd5: string;
  suffixSha256: string;
}

// Measured 2026-09-09 against the live corpus:
//
//   select length(suffix), md5(suffix), encode(sha256(convert_to(suffix,'UTF8')),'hex'), count(*)
//   from (select substr(u, strpos(u, MARKER)) as suffix from ...) group by 1,2,3;
//
//     2617 chars / 3043 bytes  md5 5d3d5538…  41 rows   no rules_applied
//     2811 chars / 3449 bytes  md5 5cfa2b6d…   4 rows   has rules_applied
//
// v44 and v48 are named for the analyze deployments they belong to; the only
// difference between the two payloads is the `rules_applied` property added on
// 2026-09-08 (it is in `properties`, not in `required`, which is still 20 keys
// in both).
//
// AND THE NUMBER THAT DECIDES THE WHOLE DESIGN OF THIS FILE: rebuilding
// `schemaInstruction(JSON.stringify(RESPONSE_SCHEMA))` from the working tree
// today produces 2811 chars / md5 5cfa2b6d… — byte-identical to the v48 entry.
// So a strip written as `text.endsWith(todaysInstruction) ? slice : refuse`
// accepts exactly the 4 v48 rows and REFUSES 41 OF THE 45 search-derived rows.
// That was checked, not reasoned about, and it is why nothing below ever looks
// at today's schema.
export const SCHEMA_ERAS: readonly SchemaEraEntry[] = [
  {
    era: "v44",
    suffixLength: 2617,
    suffixMd5: "5d3d5538fb27e74b37af2babeb2e2af4",
    suffixSha256: "ef9636d3cb76984077207df45e43f25e5ccee4e80885ded001fa89184df2a818",
  },
  {
    era: "v48",
    suffixLength: 2811,
    suffixMd5: "5cfa2b6d1d26cf322bc5b3142929a7bc",
    suffixSha256: "9d28925fc24c5c0946e23bcf525ec36b8359002ee88704d3a1d2bf7a9d70ae05",
  },
];

// Which generation of the schema this row's suffix belongs to.
//
// THIS FUNCTION NEVER REFUSES, and that is deliberate. The era is a label on
// the cell so that nobody later compares a v44 replay against a v48 answer as
// though they had the same field set; it is not a licence to send the row. A
// suffix this table does not recognise is a suffix from a generation nobody has
// catalogued yet, and the replay's job is to send the stored bytes back
// unchanged whatever generation wrote them.
//
// `suffixSha256` is optional because computing it needs a hash and this file
// has none. IT IS A DIGEST OF THE SUFFIX AND OF NOTHING ELSE — a third hash the
// caller has to take over `ClassifiedRow.schemaSuffix`, not either of the two
// it already has. `noise_cells.system_sha256` and `user_sha256` are digests of
// the whole strings that went on the wire; handing one of those in here matches
// no entry and demotes every row in the corpus to "unknown", which is a quiet
// way to lose the era column altogether. Given the right digest, a length that
// matches an entry whose digest does not is "unknown" rather than a wrong
// label. Without a digest the length alone decides, which is weaker and is why
// the parameter exists at all.
export const detectSchemaEra = (
  suffix: string | null,
  suffixSha256?: string | null,
): SchemaEra => {
  if (suffix === null) return "none";
  for (const entry of SCHEMA_ERAS) {
    if (entry.suffixLength !== suffix.length) continue;
    if (typeof suffixSha256 === "string" && suffixSha256.toLowerCase() !== entry.suffixSha256) {
      return "unknown";
    }
    return entry.era;
  }
  return "unknown";
};

// ---------------------------------------------------------------------------
// A7 / the #65 seam — locating the learned-rules block in a system prompt
// ---------------------------------------------------------------------------

export interface RulesBlock {
  // Index into the system string where the heading starts. Everything before
  // it is the analytical procedure and must survive a splice untouched.
  blockStart: number;
  // The heading actually found, which is one of `rulesHeaders` and not a
  // paraphrase of it.
  header: string;
  // The whole block, heading through end-of-string. `analyze/index.ts` renders
  // `{{LEARNED_RULES}}` as the last thing in SYSTEM_PROMPT and then trimEnd()s,
  // so a well-formed block runs to the end; that was measured true on 48/48.
  block: string;
  // Whether the block carries the fit note, i.e. whether it was rendered
  // ranked. 48/48 stored blocks do. #65 needs this: a re-rendered block
  // recomputes the per-rule fit markers against TODAY's indicators, so
  // splicing a re-render changes two things at once and destroys the pairing
  // its McNemar test depends on.
  ranked: boolean;
  // The `- ` rule lines, in the order shown.
  ruleLines: readonly string[];
  // The "N further rules were left out for length" sentence, when the budget
  // bit. Zero of the 48 stored blocks carry one.
  heldBackNote: string | null;
}

// Find the seam. Refuses rather than guessing, on every one of four counts.
//
// Measured 2026-09-09 over all 48 stored systems: the heading occurs exactly
// once in each, is preceded by exactly one `\n` (never two — the template is
// `{{EVENTS}}\n{{LEARNED_RULES}}`), the block runs to end-of-string, and every
// block is five lines: heading, fit note, three `- ` rule lines. Four distinct
// blocks across the corpus, 579–595 characters. No held-back note anywhere, and
// no `$` in any stored system.
//
// The single-newline check is the one worth arguing for. `blockStart` is
// defined as `system.indexOf("\n" + header) + 1`, which is the index of the
// heading itself; splicing therefore keeps the newline that separated the
// events block from the rules block and cannot weld the two together or leave a
// blank line behind. Requiring the character before THAT newline not to be a
// newline as well is what makes the seam a single identifiable joint rather
// than "somewhere in a run of blank lines", which is what a later reader would
// have to guess at if the template ever grew one.
export const locateRulesBlock = (
  system: string,
  locale: SurgeryLocale,
): RulesBlock | Refusal => {
  const table = LOCALE[locale];

  let header: string | null = null;
  for (const candidate of table.rulesHeaders) {
    const n = countOccurrences(system, candidate);
    if (n === 0) continue;
    if (n > 1) return refuse("seam_ambiguous", `heading occurs ${n} times`);
    if (header !== null) {
      return refuse("seam_ambiguous", "two different known headings are present");
    }
    header = candidate;
  }
  if (header === null) {
    return refuse("seam_absent", `no known ${locale} rules heading in the system prompt`);
  }

  const headerIdx = system.indexOf(header);
  if (headerIdx < 1 || system[headerIdx - 1] !== "\n") {
    return refuse("seam_absent", "heading is not preceded by a newline");
  }
  if (headerIdx >= 2 && system[headerIdx - 2] === "\n") {
    return refuse("seam_ambiguous", "heading is preceded by more than one newline");
  }

  const blockStart = headerIdx;
  const block = system.slice(blockStart);
  const lines = block.split("\n");

  // Shape: heading, then the fit note when the block was rendered ranked, then
  // the `- ` rule lines, then at most one held-back note as the final line.
  // Anything else and this is not a block we can hand #65 a promise about.
  let i = 1;
  const ranked = lines[i] === table.fitNote;
  if (ranked) i += 1;
  const ruleLines: string[] = [];
  let heldBackNote: string | null = null;
  for (; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.startsWith("- ")) {
      if (heldBackNote !== null) {
        return refuse("seam_malformed", "a rule line follows the held-back note");
      }
      ruleLines.push(line);
      continue;
    }
    if (line.includes(table.heldBackMarker) && heldBackNote === null) {
      heldBackNote = line;
      continue;
    }
    return refuse("seam_malformed", `line ${i} of the block is neither a rule nor the held-back note`);
  }
  if (ruleLines.length === 0) {
    return refuse("seam_malformed", "the block carries no rule lines");
  }

  return { blockStart, header, block, ranked, ruleLines, heldBackNote };
};

// Replace the learned-rules block and nothing else.
//
// The splice itself is `slice(0, blockStart) + candidate`, never
// `String.replace`. See the note above `fallbackTransform` for why that matters
// generally; here it matters twice over, because the thing being substituted in
// is model-authored text from `public.rulebook.candidate` and a `$&` inside it
// would, under replace(), paste the entire matched block back into itself.
//
// The `$` refusal is therefore a tripwire rather than a fix. Measured
// 2026-09-09: zero `$` in any of the 48 stored systems and zero in any of the
// 48 stored user turns, so the hazard is inert on the corpus as it stands. The
// day a rule text carries one, this refuses loudly instead of leaving the
// hazard for whichever future consumer does reach for replace().
export const spliceRulesBlock = (
  system: string,
  candidateBlock: string,
  locale: SurgeryLocale,
): { ok: true; system: string; blockStart: number } | Refusal => {
  const located = locateRulesBlock(system, locale);
  if (isRefusal(located)) return located;

  if (candidateBlock.includes("$")) {
    return refuse("candidate_has_dollar", "the candidate block contains '$'");
  }
  // The candidate has to be a block, not a bare list of rules: #65 swaps one
  // rulebook for another and the heading is part of what the analyst reads.
  if (!LOCALE[locale].rulesHeaders.some((h) => candidateBlock.startsWith(h))) {
    return refuse("candidate_not_a_block", "the candidate does not start with a known heading");
  }

  const spliced = system.slice(0, located.blockStart) + candidateBlock;
  // Stated as an assert rather than left to the reader: the prefix is what
  // makes the two arms of #65 comparable, and an off-by-one in `blockStart`
  // would move a character of the procedure into the rulebook without changing
  // anything a diff of the two blocks would show.
  if (spliced.slice(0, located.blockStart) !== system.slice(0, located.blockStart)) {
    return refuse("seam_malformed", "the splice altered the text before blockStart");
  }
  return { ok: true, system: spliced, blockStart: located.blockStart };
};

// ---------------------------------------------------------------------------
// A1–A7 + B1–B5 — classification
// ---------------------------------------------------------------------------

export type PromptClass = "search_derived" | "technical" | "already_fallback";

// What `analyses.mode` must say for each class. The column is read as a
// CROSS-CHECK and never as the discriminator: index.ts sets
// searchDroppedReason="no_allowed_domains" without calling giveUpSearch, so the
// column can move without the bytes moving. The text is what was sent, so the
// text decides; a disagreement means one of the two is lying about the row and
// we do not know which, which is a refusal and not a tie-break.
//
// A6 IS NOT DECORATION, and the decoupled case is the reason. Traced through
// index.ts: on the `no_allowed_domains` branch the user turn is never rebuilt,
// so the bytes keep the search note and the inline schema — but
// `resolvedMode` reads `searchDroppedReason ? "technical_fallback" : "full"`
// and the row lands as `technical_fallback`, while `applyRequestShape` sends it
// with `output_config.format` and the technical effort. The text alone would
// call that row search-derived and replay it inline; the column alone would
// call it a fallback and replay a prompt that was never sent. Neither is right
// and A6 is what stops either from being used: the pair refuses. It is the only
// combination of the four `analyze` can produce where the note does not name
// the shape.
//
// They agree on 48/48 today (45 full / 3 technical_only / 0 technical_fallback,
// measured 2026-09-09), so nothing has taken that branch yet.
export const MODE_FOR_CLASS: Record<PromptClass, string> = {
  search_derived: "full",
  technical: "technical_only",
  already_fallback: "technical_fallback",
};

export interface ClassifiedRow {
  ok: true;
  locale: SurgeryLocale;
  promptClass: PromptClass;
  // The user turn split on "\n", kept because both the transform and its
  // post-conditions work positionally and re-splitting invites the two to
  // disagree about what line 3 is.
  lines: readonly string[];
  // Where the tail sentence starts in the stored user turn.
  tailIndex: number;
  // Where the schema suffix starts, or null on a row that carries no schema in
  // its text (the technical rows: measured zero markers on 3/3).
  markerIndex: number | null;
  // `user.slice(markerIndex)`, or null. This is the thing whose length and
  // digest name the era.
  schemaSuffix: string | null;
  schemaEra: SchemaEra;
  rules: RulesBlock;
}

export type ClassifyResult = ClassifiedRow | Refusal;

export interface ClassifyInput {
  // The stored `analysis_prompts.user`
  user: string;
  // The stored `analysis_prompts.system`
  system: string;
  // The stored `analyses.mode`, for the A6 cross-check
  mode: string;
  // Optional sha256 of the schema suffix, for the B5 digest check. Absent means
  // the era is decided on length alone; see detectSchemaEra.
  schemaSuffixSha256?: string | null;
}

export const classifyRow = (input: ClassifyInput): ClassifyResult => {
  const { user, system, mode } = input;

  // A1
  const locale = detectLocale(user);
  if (locale === null) {
    return refuse("locale_undetected", "line 1 starts with no known currency-pair prefix");
  }
  const table = LOCALE[locale];
  const lines = user.split("\n");

  // A2
  if (lines.length < 4 || !lines[1].startsWith(table.nowPrefix)) {
    return refuse("line2_shape", "line 2 does not carry the UTC-time prefix");
  }

  // A3 — exact equality, never startsWith. The three notes share the prefix
  // "分析モード: " / "Mode: " and technical_only is a proper prefix of nothing,
  // but technical_fallback's wording restates technical_only's clause verbatim
  // after its own preamble; a prefix match here would be a coin toss on which
  // of the two a future edit turns into a prefix of the other.
  const promptClass: PromptClass | null = lines[2] === table.searchNote
    ? "search_derived"
    : lines[2] === table.technicalNote
      ? "technical"
      : lines[2] === table.fallbackNote
        ? "already_fallback"
        : null;
  if (promptClass === null) {
    return refuse("note_unrecognised", "line 3 is not one of the three known mode notes");
  }

  // A4 — `userMessage` puts a blank line between the note and the sections, so
  // a non-blank line 4 means the note line is not where we think it is, which
  // would make the transform below overwrite market data.
  if (lines[3] !== "") {
    return refuse("line4_not_blank", "line 4 is not blank");
  }

  // A5 — the tail sentence is half the strip's anchor, so it has to name one
  // place. Measured unique on 48/48.
  const tailCount = countOccurrences(user, table.tail);
  if (tailCount !== 1) {
    return refuse("tail_not_unique", `the tail sentence occurs ${tailCount} times`);
  }
  const tailIndex = user.indexOf(table.tail);

  // A6
  if (mode !== MODE_FOR_CLASS[promptClass]) {
    return refuse(
      "mode_text_disagree",
      `the text says ${promptClass} and the row says ${mode}`,
    );
  }

  // A7
  const rules = locateRulesBlock(system, locale);
  if (isRefusal(rules)) return rules;

  // B1–B4. A technical row carries no schema in its text at all (measured: 3/3
  // have zero markers and end exactly with the tail), so zero markers is a
  // valid state and only a count of two or more is a refusal.
  const markerCount = countOccurrences(user, table.schemaMarker);
  if (markerCount > 1) {
    return refuse("marker_not_unique", `the schema marker occurs ${markerCount} times`);
  }

  // THE NOTE LINE AND THE INLINE SCHEMA HAVE TO AGREE, and this is the one
  // assert here that is about the REQUEST rather than about the text.
  //
  // `analyze/index.ts` welds the two together in a single expression —
  // `includeFundamental ? buildUserMessage(SEARCH_NOTE, true) :
  // buildUserMessage(TECHNICAL_NOTE, false)`, and `giveUpSearch` rebuilds the
  // turn as `buildUserMessage(FALLBACK_NOTE, false)`. The second argument IS
  // `schemaInPrompt`. So the search note always carries the schema in the text
  // and the other two notes never do; measured 2026-09-09, 45 search rows with
  // exactly one marker and 3 technical rows with none, no exceptions.
  //
  // The class is what the caller picks the request shape from (§3.4: a
  // search-derived row replays inline with `{effort:"low"}` and no `format`,
  // the other two replay structured with `output_config.format`). A row where
  // the note and the bytes disagree therefore gets a shape production never
  // sent, chosen silently and on the note's word alone: a search prompt with no
  // field contract anywhere, or — the direction that decides this — a technical
  // prompt handed constrained decoding ON TOP OF a schema already in its text.
  // Constrained decoding is the one change that mechanically deletes the
  // parse-failure class (§3-3 (iv)) the whole measurement is built to keep, and
  // deleting it measures the floor LOW, which is the error that lets #65 read a
  // real rulebook regression as noise. Neither combination occurs in the corpus
  // today, which is exactly why nothing downstream would notice one appearing.
  if (markerCount === 1 && promptClass !== "search_derived") {
    return refuse("class_shape_disagree", `a ${promptClass} row carries a schema in its text`);
  }

  if (markerCount === 0) {
    // The other half of "no schema": the prompt must actually END at the tail.
    // Without this an unrecognised trailing section would be replayed as though
    // it were nothing at all.
    if (tailIndex + table.tail.length !== user.length) {
      return refuse("marker_not_terminal", "no schema marker, yet the prompt does not end at the tail");
    }
    if (promptClass === "search_derived") {
      return refuse("class_shape_disagree", "a search-derived row carries no schema in its text");
    }
    return {
      ok: true,
      locale,
      promptClass,
      lines,
      tailIndex,
      markerIndex: null,
      schemaSuffix: null,
      schemaEra: "none",
      rules,
    };
  }

  const markerIndex = user.indexOf(table.schemaMarker);
  // B2 — adjacency to the tail is what makes the strip a strip rather than a
  // search. `userMessage` interpolates the schema immediately after the tail
  // sentence with nothing between them; measured true on 45/45.
  if (markerIndex !== tailIndex + table.tail.length) {
    return refuse(
      "marker_not_adjacent",
      `marker at ${markerIndex}, tail ends at ${tailIndex + table.tail.length}`,
    );
  }
  const schemaSuffix = user.slice(markerIndex);
  // B3 — the suffix is the last thing in the prompt. Checked as "the fixed
  // instruction sentence is there and the string ends on the JSON's closing
  // brace", because that is the part that can be false: a builder that appended
  // anything after the schema would still satisfy B1 and B2.
  if (!schemaSuffix.startsWith(table.schemaInstruction)) {
    return refuse("marker_not_terminal", "the marker is not followed by the fixed instruction sentence");
  }

  // B4 — the payload after the instruction sentence is a JSON Schema object.
  // Parsed rather than pattern-matched, because a successful `JSON.parse` of
  // the WHOLE remainder is simultaneously the strongest available statement of
  // B3: JSON.parse tolerates trailing whitespace and nothing else, so a parse
  // that consumed every remaining byte proves the schema is the last thing in
  // the prompt without needing to know anything about the schema's contents —
  // which is the property this whole file is built around.
  //
  // The two ways it can fail therefore have to be kept apart, and the closing
  // brace is what separates them. Prose appended AFTER a well-formed schema
  // fails to parse because of the trailing text, and that is a terminality
  // failure (`marker_not_terminal`), not a statement about the schema. A
  // payload that ends where a JSON object ends and still will not parse is a
  // malformed schema (`schema_unparseable`). Reporting both as the same code
  // would tell an operator that the analyzer changed its schema when what
  // actually happened is that something started appending to the prompt.
  const payload = schemaSuffix.slice(table.schemaInstruction.length);
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return user.endsWith("}")
      ? refuse("schema_unparseable", "the text after the instruction sentence is not JSON")
      : refuse("marker_not_terminal", "the prompt does not end where the schema ends");
  }
  if (
    typeof parsed !== "object" || parsed === null || Array.isArray(parsed) ||
    !("type" in parsed) || !("properties" in parsed) || !("required" in parsed)
  ) {
    return refuse("schema_unparseable", "the payload is not an object carrying type/properties/required");
  }

  return {
    ok: true,
    locale,
    promptClass,
    lines,
    tailIndex,
    markerIndex,
    schemaSuffix,
    schemaEra: detectSchemaEra(schemaSuffix, input.schemaSuffixSha256 ?? null),
    rules,
  };
};

// ---------------------------------------------------------------------------
// §4.3 — the fallback transform
// ---------------------------------------------------------------------------

export interface TransformedPrompt {
  ok: true;
  // The rewritten user turn: the note line swapped for the fallback note and
  // the schema suffix cut off, which is byte-for-byte what
  // `giveUpSearch` -> `buildUserMessage(FALLBACK_NOTE, false)` produces.
  user: string;
  // Where the strip cut, recomputed on the rewritten text and not carried over
  // from the stored one — the note swap changes the length of everything after
  // line 3.
  markerIndex: number;
}

// Rewrite a searching prompt into the technical-fallback prompt.
//
// USED BY ONE ARM ONLY, and that arm is not the headline. The primary arm sends
// the stored bytes with `tools` omitted and changes exactly one field; this
// transform changes four at once, three of them optional, and two of those
// three plausibly LOWER the variance being measured. A floor measured low is
// the error that lets #65 mistake a real rulebook regression for noise, so the
// surgery is a labelled comparison against the primary and never a substitute
// for it. Its whole value is that the difference between the two arms is a
// direct measurement of what the surgery costs — a cost currently assumed to be
// zero on no evidence at all.
//
// NEVER String.replace, NEVER replaceAll, FOR THE NOTE LINE. Both take the
// replacement as a template: `$&`, `$1`, "$`" and "$'" expand inside it, so
// substituting a string that happens to contain a dollar sign splices the match
// (or the text around it) into the output. The note being substituted in is a
// locale constant today, but the note being substituted OUT is read from a
// stored prompt, and `replace` also needs that search string to be a literal
// rather than a pattern. Measured 2026-09-09: zero `$` in any of the 48 stored
// user turns, so nothing would misfire today — which is exactly the condition
// under which a latent expansion bug survives review. Splitting on "\n",
// asserting the index, assigning, and rejoining has no template semantics at
// all, and is also the only form that can state WHICH line it changed.
//
// The exemplar problem, said out loud: ZERO `technical_fallback` rows have ever
// been written to `analysis_prompts` (measured; the mode does not appear in the
// corpus at all). So the output of this function cannot be diffed against a
// stored example of what it is trying to produce. What it CAN be checked
// against is the 3 stored `technical_only` rows, which the same
// `buildUserMessage(note, false)` call produced with a different note — a
// same-builder sibling, not the thing itself. The four post-conditions below
// are written to be exactly the invariants those three rows satisfy. Note also
// that those 3 rows are simultaneously the control and the confound: they are
// the only rows that show what a schema-free prompt looks like AND the only
// rows the primary arm sends in the structured shape.
export const fallbackTransform = (row: ClassifiedRow): TransformedPrompt | Refusal => {
  const table = LOCALE[row.locale];
  if (row.promptClass !== "search_derived") {
    return refuse(
      "transform_invariant",
      `only a search-derived row needs the surgery; this one is ${row.promptClass}`,
    );
  }
  if (row.markerIndex === null) {
    return refuse("transform_invariant", "a search-derived row with no schema suffix to strip");
  }

  const original = row.lines.join("\n");
  const lines = [...row.lines];
  // Positional assert before the assignment, so the failure is "line 3 was not
  // the note" rather than a silently mangled prompt.
  if (lines[2] !== table.searchNote) {
    return refuse("transform_invariant", "line 3 is not the search note at the point of the swap");
  }
  lines[2] = table.fallbackNote;
  const rejoined = lines.join("\n");

  // Recomputed, never reused: the fallback note is a different length from the
  // search note, so the stored markerIndex points somewhere else in the new
  // string. Carrying it over would cut the prompt mid-sentence — and it would
  // still satisfy a naive "the schema is gone" check.
  const markerCount = countOccurrences(rejoined, table.schemaMarker);
  if (markerCount !== 1) {
    return refuse("transform_invariant", `the rewritten text carries ${markerCount} markers before the strip`);
  }
  const markerIndex = rejoined.indexOf(table.schemaMarker);
  const out = rejoined.slice(0, markerIndex);

  // Post-condition 1 — the fallback note is present exactly once, and at line
  // index 2, with line 3 still blank. "Exactly once" is not redundant with the
  // positional check: the note is a sentence, and a sentence can also occur in
  // the market data if a future section ever quotes it.
  const outLines = out.split("\n");
  if (
    countOccurrences(out, table.fallbackNote) !== 1 ||
    outLines[2] !== table.fallbackNote ||
    outLines[3] !== ""
  ) {
    return refuse("transform_invariant", "post-condition 1: the fallback note is not the sole line 3");
  }

  // Post-condition 2 — zero markers. This is the one an `endsWith(today)`
  // implementation would pass on 4 rows and fail on 41; here it is checked on
  // the OUTPUT, where it is a statement about what is being sent rather than
  // about which schema generation wrote the input.
  if (countOccurrences(out, table.schemaMarker) !== 0) {
    return refuse("transform_invariant", "post-condition 2: a schema marker survived the strip");
  }

  // Post-condition 3 — ends exactly with the tail sentence. The 3 stored
  // technical rows do (measured 3/3), and it is what says the cut landed on the
  // sentence boundary rather than inside the JSON.
  if (!out.endsWith(table.tail)) {
    return refuse("transform_invariant", "post-condition 3: the output does not end with the tail sentence");
  }

  // Post-condition 4 — byte identity either side of the swapped line. Two
  // spans, because the swap moves every offset after line 3 by the difference
  // in the two notes' lengths, and a check that ignored that would either be
  // vacuous or would fail on a correct transform.
  //
  // Span A: index 0 through the newline that ends line 2, in both strings.
  const prefixEnd = row.lines[0].length + 1 + row.lines[1].length + 1;
  if (out.slice(0, prefixEnd) !== original.slice(0, prefixEnd)) {
    return refuse("transform_invariant", "post-condition 4a: the text before the note line changed");
  }
  // Span B: from the start of line 4 through the end of the tail sentence.
  // In the output that end is the end of the string, by post-condition 3.
  const origBodyStart = prefixEnd + table.searchNote.length + 1;
  const outBodyStart = prefixEnd + table.fallbackNote.length + 1;
  const origBodyEnd = row.tailIndex + table.tail.length;
  if (out.slice(outBodyStart) !== original.slice(origBodyStart, origBodyEnd)) {
    return refuse("transform_invariant", "post-condition 4b: the prompt body changed");
  }

  return { ok: true, user: out, markerIndex };
};

// The strip on its own, for a caller that wants the stored bytes minus the
// schema without the note swap. Kept separate from `fallbackTransform` because
// the two arms want different things: the surgery arm wants both changes, and a
// reader auditing what the schema suffix actually was wants neither.
export const stripSchemaSuffix = (row: ClassifiedRow): string =>
  row.markerIndex === null ? row.lines.join("\n") : row.lines.join("\n").slice(0, row.markerIndex);
