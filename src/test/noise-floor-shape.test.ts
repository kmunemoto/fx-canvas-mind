import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  ANTHROPIC_VERSION,
  ARMS,
  EFFORT_SEARCH,
  EFFORT_TECHNICAL,
  MAX_TOKENS,
  PRE_SWITCH_EFFORT_SEARCH,
  PRE_SWITCH_EFFORT_TECHNICAL,
  PRE_SWITCH_MAX_TOKENS,
  NEWS_DOMAINS,
  RESPONSE_SCHEMA,
  ROW_CLASSES,
  SHAPE_REFUSAL_PREFIX,
  WEB_SEARCH_MAX_USES,
  WEB_SEARCH_NAME,
  WEB_SEARCH_TOOL_TYPE,
  buildReplayRequest,
  replayHeaders,
  replayShape,
} from "../../supabase/functions/noise-floor/shape";

// shape.ts holds a deliberate copy of analyze's request constants: importing
// them would drag the whole analyzer into this bundle, and #65 needs a shape it
// can prove was identical across both of its arms even after analyze moves.
// This file is the other half of that bargain. It reads analyze/index.ts and
// analyze/websearch.ts AS TEXT and pulls each constant out BY SYMBOL NAME —
// never by line number, because #65 edits analyze and every line number in it
// is going to move. A change over there fails here, loudly, instead of forking
// the two copies in silence.
//
// DEFERRED: the test list's #25 (noise-floor/index.ts logs no token, carries no
// admin-email array, and uses the five house error strings) is not here. That
// file is written by a later step and does not exist yet; a test that reads a
// missing file would go red for the wrong reason. It belongs with index.ts.
const analyzeSrc = readFileSync("supabase/functions/analyze/index.ts", "utf8");
const websearchSrc = readFileSync("supabase/functions/analyze/websearch.ts", "utf8");
const shapeSrc = readFileSync("supabase/functions/noise-floor/shape.ts", "utf8");

// The one match of a pattern, or a failure that says which symbol went missing.
// Everything below insists on exactly one occurrence: two declarations of the
// same constant in analyze would mean this file pinned whichever one happened
// to come first, which is the silent fork all over again.
const soleMatch = (src: string, pattern: RegExp): RegExpMatchArray => {
  const all = [...src.matchAll(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`))];
  expect(all.length).toBe(1);
  return all[0];
};

// The source text of the object literal that follows a declaration, found by
// brace matching rather than by a regex, because the literals here contain
// braces inside string values ("{{LANGUAGE_RULE}}" in the system prompt) and
// nested objects several levels deep. Quotes and line comments are tracked so
// that a brace inside either does not move the depth. It is not a JS parser —
// a regex literal containing a brace would defeat it — and there is none in
// either literal it is pointed at.
const objectLiteralAfter = (src: string, declaration: string): string => {
  const at = src.indexOf(declaration);
  expect(at).toBeGreaterThan(-1);
  const start = src.indexOf("{", at);
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (quote !== null) {
      if (c === "\\") { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
    if (c === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i);
      if (nl === -1) break;
      i = nl;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated object literal after ${declaration}`);
};

const quotedStrings = (src: string): string[] => [...src.matchAll(/"([^"]*)"/g)].map((m) => m[1]);

// A stored row's two strings. Synthetic, but the only thing the builder does
// with them is put them on the wire unread, so the content is irrelevant and
// the type is not: production sends both as plain strings and so must this.
const SYSTEM = "あなたはFXアナリストです。\n\n## 学習済みルール\n- r1: 何か\n";
const USER = "通貨ペア: USD/JPY\n現在時刻(UTC): 2026-09-09T12:00:00Z\nまず検索してください。\n\n### 1h\n";

describe("20 — the constants duplicated into shape.ts still equal analyze's", () => {
  it("max_tokens comes from analyze's baseRequest and is still 8000", () => {
    // analyze has no `MAX_TOKENS` symbol: the ceiling is a property of the
    // request literal, so the anchor is the declaration `const baseRequest`
    // plus the property key. Both are names, neither is a position.
    const baseRequest = objectLiteralAfter(analyzeSrc, "const baseRequest: JsonRecord = {");
    const inRequest = soleMatch(baseRequest, /\bmax_tokens:\s*(\d+)/);
    expect(Number(inRequest[1])).toBe(MAX_TOKENS);
    expect(MAX_TOKENS).toBe(8000);
    // Exactly one place SETS the ceiling. The other mentions of the key
    // RECORD it — analyze writes the sent shape onto analysis_prompts so a
    // replay can be honest across a change like this one — and a recorder that
    // copies the request cannot drift from it. So the guard is on numeric
    // literals, which is what "there is one ceiling" actually means.
    expect([...analyzeSrc.matchAll(/\bmax_tokens:\s*\d+/g)].length).toBe(1);
  });

  it("EFFORT_SEARCH and EFFORT_TECHNICAL match their declarations in analyze", () => {
    expect(soleMatch(analyzeSrc, /const EFFORT_SEARCH\s*=\s*"([^"]*)"/)[1]).toBe(EFFORT_SEARCH);
    expect(soleMatch(analyzeSrc, /const EFFORT_TECHNICAL\s*=\s*"([^"]*)"/)[1]).toBe(EFFORT_TECHNICAL);
    // Pinned as literals too, so that swapping the pair in both files at once
    // would still be caught.
    //
    // BOTH PATHS ARE NOW EQUAL, and the older version of this test said the
    // opposite: "the whole per-row effort decision rests on the searching path
    // being the shallower of the two". That was true while the values were
    // "low" and "medium". On 2026-09-12 the owner moved analyze to a cheaper
    // model and spent the saving on depth, and both went to the top of the
    // range. The per-shape branch in outputConfigFor therefore no longer
    // differentiates effort — only `format` — and that is a fact about today's
    // configuration, not a simplification to bake in: the branch stays, because
    // the searching path is the one with a documented history of hitting the
    // wall clock and is the one value that would be walked back first.
    expect(EFFORT_SEARCH).toBe("low");
    expect(EFFORT_TECHNICAL).toBe("medium");
  });

  it("does not re-sync the pre-switch constants to analyze, ever", () => {
    // These describe the shape rows were sent at BEFORE 2026-09-12. They are
    // history, and history does not track a live file. If a future change
    // re-points them at analyze's current values — the obvious mistake, since
    // the three constants above it are supposed to track analyze — every row
    // written before the switch would replay at a depth it never saw, silently.
    expect(PRE_SWITCH_MAX_TOKENS).toBe(8000);
    expect(PRE_SWITCH_EFFORT_SEARCH).toBe("low");
    expect(PRE_SWITCH_EFFORT_TECHNICAL).toBe("medium");
    // ALL THREE ARE EQUAL TO THE CURRENT CONSTANTS AGAIN, and that is not a
    // bug and not a reason to delete them. The 2026-09-12 switch — model,
    // both efforts, and this ceiling — was fully reverted the same day, and
    // NO ROW WAS EVER WRITTEN AT THE NEW SHAPE: both turns that tried died at
    // the wall clock. So the fallback and the current values agree, and a
    // replay is correct either way today.
    //
    // Asserting the equality rather than the difference is the honest version.
    // It is what makes the two blocks a documented coincidence instead of a
    // silent one, and it fails the moment analyze moves again without these
    // being re-read — which is exactly when somebody needs to think.
    expect(PRE_SWITCH_MAX_TOKENS).toBe(MAX_TOKENS);
    expect(PRE_SWITCH_EFFORT_SEARCH).toBe(EFFORT_SEARCH);
    expect(PRE_SWITCH_EFFORT_TECHNICAL).toBe(EFFORT_TECHNICAL);
  });

  it("analyze records the shape it sent, so a replay can be honest across a switch", () => {
    // The reason the pre-switch constants are a FALLBACK and not the answer.
    // #68b put `model` on the row for exactly this argument; on 2026-09-12 it
    // came due for the other two request parameters.
    expect(analyzeSrc).toContain("effort: typeof sentOutputConfig?.effort === \"string\"");
    expect(analyzeSrc).toContain("max_tokens: typeof baseRequest.max_tokens === \"number\"");
    expect(analyzeSrc).toContain("effort: promptRecord.effort,");
    expect(analyzeSrc).toContain("max_tokens: promptRecord.max_tokens,");
  });

  it("the version header matches, and neither file asks for a beta", () => {
    expect(soleMatch(analyzeSrc, /"anthropic-version"\s*:\s*"([^"]*)"/)[1]).toBe(ANTHROPIC_VERSION);
    expect(analyzeSrc).not.toContain("anthropic-beta");
    expect(shapeSrc).not.toContain('"anthropic-beta"');
  });

  it("leaves the confidence floor to metric.ts and pins that it has not moved", () => {
    // MIN_CONFIDENCE is not a request-shape constant — nothing in the body
    // depends on it — so shape.ts does not carry a third copy of it; the
    // published_proxy projection in metric.ts owns that duplicate. What this
    // asserts is that the floor analyze enforces is still the one #64 and #65
    // both project through, and that it did not quietly acquire a second home
    // here.
    expect(soleMatch(analyzeSrc, /const MIN_CONFIDENCE\s*=\s*(\d+)/)[1]).toBe("60");
    expect(shapeSrc).not.toContain("MIN_CONFIDENCE");
  });
});

describe("21 — the RESPONSE_SCHEMA copy", () => {
  const analyzeSchemaLiteral = objectLiteralAfter(analyzeSrc, "const RESPONSE_SCHEMA = {");
  const shapeSchemaLiteral = objectLiteralAfter(shapeSrc, "export const RESPONSE_SCHEMA = {");

  it("requires the same 20 keys as analyze", () => {
    // The top-level `required` is the one indented two spaces; the nested ones
    // (market_context_detail, timeframe_alignment's items) sit deeper. Anchored
    // on the indentation inside the already-extracted literal rather than on a
    // line number.
    const required = quotedStrings(soleMatch(analyzeSchemaLiteral, /\n {2}required: \[([\s\S]*?)\]/)[1]);
    expect(required.length).toBe(20);
    expect(RESPONSE_SCHEMA.required).toEqual(required);
  });

  it("is a verbatim copy, comments included", () => {
    // Stricter than it needs to be for the bytes — reformatting the literal
    // would fail this while changing nothing on the wire, since JSON.stringify
    // ignores source whitespace — and deliberately so. What DOES change the
    // wire is key order and any value, on the 3 technical rows where this
    // schema is serialized into output_config.format, and no cheap check
    // separates those from a reflow. So the copy is pinned whole: when this
    // fails, re-copy the literal out of analyze and record the re-sync, rather
    // than editing one side until the test goes quiet.
    expect(shapeSchemaLiteral).toBe(analyzeSchemaLiteral);
  });

  it("is frozen, so one body cannot rewrite another's contract", () => {
    expect(Object.isFrozen(RESPONSE_SCHEMA)).toBe(true);
    expect(Object.isFrozen(RESPONSE_SCHEMA.properties)).toBe(true);
    expect(Object.isFrozen(NEWS_DOMAINS)).toBe(true);
  });
});

describe("22 — each arm sends the shape production sent for that row", () => {
  it("search_free on a search-derived row: no tools, no format, effort low", () => {
    const body = buildReplayRequest({
      arm: "search_free", rowClass: "search_derived", model: "claude-opus-5", system: SYSTEM, user: USER,
    });
    expect(replayShape({ arm: "search_free", rowClass: "search_derived" })).toBe("search_free_inline");
    // `tools` must be ABSENT, not present-and-undefined: the cell records
    // tools_present from whether the key exists.
    expect("tools" in body).toBe(false);
    expect("format" in body.output_config).toBe(false);
    expect(body.output_config).toEqual({ effort: "low" });
    // The schema those 45 rows answer into stays inline in their own text,
    // replayed verbatim at whatever era they were born with.
    expect(body.messages[0].content).toBe(USER);
  });

  it("search_free on a technical row: format + effort medium, still no tools", () => {
    const body = buildReplayRequest({
      arm: "search_free", rowClass: "technical", model: "claude-opus-5", system: SYSTEM, user: USER,
    });
    expect(replayShape({ arm: "search_free", rowClass: "technical" })).toBe("structured");
    expect("tools" in body).toBe(false);
    expect(body.output_config.effort).toBe("medium");
    expect(body.output_config.format?.type).toBe("json_schema");
    // The same object, not a copy: a copy could be edited on one replicate.
    expect(body.output_config.format?.schema).toBe(RESPONSE_SCHEMA);
  });

  it("fallback_surgery sends the transformed text in the technical shape", () => {
    const transformed = "通貨ペア: USD/JPY\n現在時刻(UTC): 2026-09-09T12:00:00Z\n検索は使えません。\n\n### 1h\n";
    const body = buildReplayRequest({
      arm: "fallback_surgery", rowClass: "search_derived", model: "claude-opus-5", system: SYSTEM, user: transformed,
    });
    expect(replayShape({ arm: "fallback_surgery", rowClass: "search_derived" })).toBe("structured");
    expect("tools" in body).toBe(false);
    expect(body.output_config.effort).toBe("medium");
    expect(body.output_config.format?.schema).toBe(RESPONSE_SCHEMA);
    // The transform is prompt-surgery.ts's job and this builder neither
    // performs it nor checks it — it sends exactly the string it was handed.
    expect(body.messages[0].content).toBe(transformed);
  });

  it("refuses the two arm/row pairs that would produce a cell that measures nothing", () => {
    // A technical row has no note to rewrite and no inline schema to strip, so
    // its surgery cell would be byte-identical to its search_free cell and
    // would pool as evidence that the surgery is free.
    expect(() => buildReplayRequest({
      arm: "fallback_surgery", rowClass: "technical", model: "claude-opus-5", system: SYSTEM, user: USER,
    })).toThrow(SHAPE_REFUSAL_PREFIX);
    // And production never attaches web search to the technical path; doing it
    // here would also have to drop `format`, leaving the row with no contract.
    expect(() => buildReplayRequest({
      arm: "search_on", rowClass: "technical", model: "claude-opus-5", system: SYSTEM, user: USER,
    })).toThrow(SHAPE_REFUSAL_PREFIX);
  });

  it("refuses a row that is missing either stored string or the model column", () => {
    // An empty system prompt is a valid request that asks a different question,
    // and the sha256 on the cell would faithfully record the emptiness of
    // something nobody meant to send.
    for (const bad of [
      { model: "", system: SYSTEM, user: USER },
      { model: "claude-opus-5", system: "", user: USER },
      { model: "claude-opus-5", system: SYSTEM, user: "" },
    ]) {
      expect(() => buildReplayRequest({ arm: "search_free", rowClass: "search_derived", ...bad }))
        .toThrow(SHAPE_REFUSAL_PREFIX);
    }
  });

  it("maps the arms onto the shapes analyze itself builds", () => {
    // The mapping above is only right because it is production's. Read the two
    // branches of analyze's applyRequestShape and pin that the searching path
    // is effort-only and the technical path is format + effort.
    const applyShape = objectLiteralAfter(analyzeSrc, "const applyRequestShape = () => {");
    expect(applyShape).toContain("{ effort: EFFORT_SEARCH }");
    expect(applyShape).toContain(
      '{ format: { type: "json_schema", schema: RESPONSE_SCHEMA }, effort: EFFORT_TECHNICAL }',
    );
    // And that `format` really is the search-incompatible half — analyze
    // deletes tools on the technical branch and never sets format on the
    // searching one.
    expect(applyShape).toContain("delete baseRequest.tools;");
  });
});

describe("23 — plain strings, and the keys that must never appear", () => {
  const bodies = [
    buildReplayRequest({ arm: "search_free", rowClass: "search_derived", model: "claude-opus-5", system: SYSTEM, user: USER }),
    buildReplayRequest({ arm: "search_free", rowClass: "technical", model: "claude-opus-5", system: SYSTEM, user: USER }),
    buildReplayRequest({ arm: "search_on", rowClass: "search_derived", model: "claude-opus-5", system: SYSTEM, user: USER }),
  ];

  it("sends system and the single user turn as plain strings", () => {
    for (const body of bodies) {
      expect(typeof body.system).toBe("string");
      expect(body.system).toBe(SYSTEM);
      expect(body.messages.length).toBe(1);
      expect(body.messages[0].role).toBe("user");
      expect(typeof body.messages[0].content).toBe("string");
    }
  });

  it("carries exactly the keys production sends and no others", () => {
    expect(Object.keys(bodies[0])).toEqual(["model", "max_tokens", "system", "messages", "output_config"]);
    expect(Object.keys(bodies[1])).toEqual(["model", "max_tokens", "system", "messages", "output_config"]);
    expect(Object.keys(bodies[2])).toEqual(["model", "max_tokens", "system", "messages", "output_config", "tools"]);
  });

  it("has no sampling knob, no seed, no thinking block and no cache_control", () => {
    // temperature/top_p/top_k are not accepted parameters on this model and
    // the Messages API has no seed, so there is nothing to pin and no default
    // to record: two identical POSTs are two independent samples. That is the
    // quantity being measured, not a defect to configure away — a replay made
    // deterministic would report a floor of zero by construction and hand #65
    // a number about the harness. cache_control is absent for a different
    // reason: it needs the content-block array form, and production sends both
    // strings plain, so buying the cache would change the very shape whose
    // stability is the measurement.
    //
    // Matched as JSON keys rather than as bare words, so that a description
    // added to the schema one day cannot fail this for saying "temperature".
    for (const body of bodies) {
      const wire = JSON.stringify(body);
      for (const key of ["temperature", "top_p", "top_k", "seed", "thinking", "cache_control"]) {
        expect(wire).not.toContain(`"${key}":`);
      }
    }
  });

  it("builds exactly the three production headers and never a beta", () => {
    const headers = replayHeaders("test-key-not-a-real-credential");
    expect(Object.keys(headers).sort()).toEqual(["anthropic-version", "content-type", "x-api-key"]);
    expect(headers["anthropic-version"]).toBe(ANTHROPIC_VERSION);
    expect(headers["content-type"]).toBe("application/json");
    expect(() => replayHeaders("")).toThrow(SHAPE_REFUSAL_PREFIX);
  });
});

describe("24 — search_on's web_search tool", () => {
  const body = buildReplayRequest({
    arm: "search_on", rowClass: "search_derived", model: "claude-opus-5", system: SYSTEM, user: USER,
  });

  it("is the one tool analyze attaches, at analyze's own version and use cap", () => {
    const applyShape = objectLiteralAfter(analyzeSrc, "const applyRequestShape = () => {");
    expect(soleMatch(applyShape, /type:\s*"(web_search_\d+)"/)[1]).toBe(WEB_SEARCH_TOOL_TYPE);
    expect(soleMatch(applyShape, /name:\s*"(web_search)"/)[1]).toBe(WEB_SEARCH_NAME);
    expect(Number(soleMatch(applyShape, /max_uses:\s*(\d+)/)[1])).toBe(WEB_SEARCH_MAX_USES);
    expect(body.tools?.length).toBe(1);
    expect(body.tools?.[0].type).toBe("web_search_20260209");
    expect(body.tools?.[0].name).toBe("web_search");
    expect(body.tools?.[0].max_uses).toBe(1);
    // The searching path keeps effort and never gains format: citations and
    // output_config.format are incompatible, which is why the 45 rows carry
    // their contract as prose in the first place.
    expect(body.output_config).toEqual({ effort: "low" });
  });

  it("sends the 12-domain allowlist as it stands in websearch.ts", () => {
    const declared = quotedStrings(
      soleMatch(websearchSrc, /export const NEWS_DOMAINS: string\[\] = \[([\s\S]*?)\];/)[1],
    );
    expect(declared.length).toBe(12);
    expect(NEWS_DOMAINS).toEqual(declared);
    expect(body.tools?.[0].allowed_domains).toEqual(declared);
  });

  it("gives each body its own copy of the allowlist", () => {
    // Production prunes this list at runtime when the API reports a domain its
    // crawler cannot reach. The replay must not: a prune between replicate 1
    // and replicate 2 sends two different allowlists and books the difference
    // as model noise. The constant is frozen so a prune cannot happen in place,
    // and each body gets its own array so that freezing costs the caller
    // nothing.
    expect(body.tools?.[0].allowed_domains).not.toBe(NEWS_DOMAINS);
    expect(Object.isFrozen(body.tools?.[0].allowed_domains)).toBe(false);
  });
});

// The block below is not in the brief's test list. It pins the three properties
// the rest of this file assumed rather than checked: that an unrecognised arm or
// row class refuses instead of picking a shape, that the shape written on the
// cell is the shape that went on the wire, and that two calls with one input
// build the same bytes without sharing anything either of them could edit.
describe("26 — no silent default, and two replicates that cannot drift", () => {
  type ShapeInput = Parameters<typeof replayShape>[0];
  type BuildInput = Parameters<typeof buildReplayRequest>[0];
  const row = { model: "claude-opus-5", system: SYSTEM, user: USER };
  const loosely = (arm: string, rowClass: string) =>
    ({ arm, rowClass, ...row }) as unknown as BuildInput;

  it("refuses an arm or a row class it does not recognise, rather than defaulting", () => {
    // Neither value is protected by the type system at runtime: `arm` arrives
    // off a text column by way of a JSON body and `rowClass` comes from
    // prompt-surgery.ts reading a stored prompt. The direction of the old
    // defaults is what makes this worth a test rather than a type. An
    // unrecognised rowClass used to become "structured" — constrained decoding
    // at effort "medium" — which suppresses the prose-parse failure the 45 rows
    // actually run on and would report a floor BELOW the analyst's. That is the
    // one error #65 cannot survive, because it licenses reading a real
    // regression as noise. An unrecognised arm used to become "search_on",
    // which would have put web search on the primary run and billed for it.
    for (const bad of ["search-free", "SEARCH_FREE", "primary", ""]) {
      expect(() => replayShape({ arm: bad, rowClass: "search_derived" } as unknown as ShapeInput))
        .toThrow(`${SHAPE_REFUSAL_PREFIX} arm_unknown`);
      expect(() => buildReplayRequest(loosely(bad, "search_derived")))
        .toThrow(`${SHAPE_REFUSAL_PREFIX} arm_unknown`);
    }
    for (const bad of ["search-derived", "full", "technical_fallback", ""]) {
      expect(() => replayShape({ arm: "search_free", rowClass: bad } as unknown as ShapeInput))
        .toThrow(`${SHAPE_REFUSAL_PREFIX} row_class_unknown`);
      expect(() => buildReplayRequest(loosely("search_free", bad)))
        .toThrow(`${SHAPE_REFUSAL_PREFIX} row_class_unknown`);
    }
    // Missing entirely is the same answer as wrong, on both.
    expect(() => buildReplayRequest({ ...row } as unknown as BuildInput)).toThrow(SHAPE_REFUSAL_PREFIX);
  });

  it("writes the same shape on the cell that it puts on the wire", () => {
    // index.ts records noise_cells.shape from replayShape and sends the body
    // from buildReplayRequest. Nothing downstream keeps a copy of the request,
    // so if those two ever disagreed the record would describe a call nobody
    // made and no later reader could catch it.
    const pairs = [
      { arm: "search_free", rowClass: "search_derived", shape: "search_free_inline", tools: false, format: false, preSwitchEffort: PRE_SWITCH_EFFORT_SEARCH },
      { arm: "search_free", rowClass: "technical", shape: "structured", tools: false, format: true, preSwitchEffort: PRE_SWITCH_EFFORT_TECHNICAL },
      { arm: "fallback_surgery", rowClass: "search_derived", shape: "structured", tools: false, format: true, preSwitchEffort: PRE_SWITCH_EFFORT_TECHNICAL },
      { arm: "search_on", rowClass: "search_derived", shape: "search_on", tools: true, format: false, preSwitchEffort: PRE_SWITCH_EFFORT_SEARCH },
    ] as const;
    for (const p of pairs) {
      expect(replayShape({ arm: p.arm, rowClass: p.rowClass })).toBe(p.shape);

      // A ROW WITH NO RECORDED SHAPE is a row written before migration
      // 20260912090000, which is a row sent at the pre-switch values. It must
      // replay at those, NOT at today's — that is the whole point of keeping
      // two sets of constants, and getting it backwards would replay 90
      // existing rows at a depth none of them ever saw.
      const legacy = buildReplayRequest({ arm: p.arm, rowClass: p.rowClass, ...row });
      expect("tools" in legacy).toBe(p.tools);
      expect("format" in legacy.output_config).toBe(p.format);
      expect(legacy.output_config.effort).toBe(p.preSwitchEffort);
      expect(legacy.max_tokens).toBe(PRE_SWITCH_MAX_TOKENS);

      // A ROW THAT RECORDED ITS SHAPE replays at what it recorded, whatever
      // the constants in this file happen to say today. The recorded value is
      // deliberately neither of the two constants, so a fallback that fired
      // when it should not have would show up here rather than passing by
      // coincidence.
      const recorded = buildReplayRequest({
        arm: p.arm,
        rowClass: p.rowClass,
        ...row,
        effort: "xhigh",
        maxTokens: 12345,
      });
      expect(recorded.output_config.effort).toBe("xhigh");
      expect(recorded.max_tokens).toBe(12345);
      expect("tools" in recorded).toBe(p.tools);
      expect("format" in recorded.output_config).toBe(p.format);
    }
    // Those four plus the two refusals above are every (arm, row class) pair
    // there is, so the table is exhaustive and stays exhaustive: adding an arm
    // without deciding its shapes fails here.
    expect(ARMS.length * ROW_CLASSES.length).toBe(pairs.length + 2);
  });

  it("builds byte-identical bodies twice and shares nothing either could edit", () => {
    // The whole measurement is the difference between two calls, so a body that
    // is not a pure function of its input would put the harness inside the
    // number. Identical bytes is the claim; not sharing a mutable object is
    // what keeps it true after index.ts has held both bodies at once.
    for (const p of [
      { arm: "search_on", rowClass: "search_derived" },
      { arm: "search_free", rowClass: "technical" },
    ] as const) {
      const a = buildReplayRequest({ ...p, ...row });
      const b = buildReplayRequest({ ...p, ...row });
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
      expect(a).not.toBe(b);
      expect(a.output_config).not.toBe(b.output_config);
      expect(a.messages).not.toBe(b.messages);
      if (a.tools !== undefined) {
        expect(a.tools).not.toBe(b.tools);
        expect(a.tools[0].allowed_domains).not.toBe(b.tools?.[0].allowed_domains);
      }
    }
  });

  it("throws on a write through one body's schema instead of rewriting the other's", () => {
    // The schema is the one thing the two structured bodies deliberately share,
    // and the cell records a sha256 of system and user only — a stray write
    // here would change what the other replicate sends with nothing in the
    // record showing it. The freeze is what turns that into a throw at the
    // moment it happens; this asserts the throw, not just the flag.
    const a = buildReplayRequest({ arm: "search_free", rowClass: "technical", ...row });
    const b = buildReplayRequest({ arm: "search_free", rowClass: "technical", ...row });
    const schema = a.output_config.format?.schema as { required: string[] };
    expect(schema).toBe(b.output_config.format?.schema);
    expect(() => { schema.required = []; }).toThrow(TypeError);
    expect(() => { schema.required.push("stop_hunt_zone"); }).toThrow(TypeError);
    expect(RESPONSE_SCHEMA.required.length).toBe(20);
    // And the frozen allowlist cannot be pruned in place the way production
    // prunes its own copy.
    expect(() => { (NEWS_DOMAINS as string[]).pop(); }).toThrow(TypeError);
    expect(NEWS_DOMAINS.length).toBe(12);
  });
});
