// The exact bytes the noise-floor replay puts on the wire, and nothing else.
//
// #64 asks how often the analyst contradicts itself when the question has not
// changed. That number only means something if the two replicates of a row
// differ in NOTHING except the draw, so the request has to be assembled from
// values that cannot move between the first call and the second, and the file
// that assembles it has to be readable end to end without a database, a Deno
// runtime or a model call anywhere in it. Hence: zero imports, no I/O, one
// function that turns a stored prompt into a body.
//
// Everything that decides what goes on the wire lives here so that
// index.ts — which owns the token gate, the claim, the budget and the
// retries — has no shape decisions left to make and cannot make a different
// one on the second call than it made on the first.

// ---------------------------------------------------------------------------
// WHY THESE CONSTANTS ARE COPIED OUT OF analyze/index.ts RATHER THAN IMPORTED
// ---------------------------------------------------------------------------
//
// Two reasons, and the second is the one that matters.
//
// The first is mechanical. analyze/index.ts IS the analyzer: one module that
// reaches the price sources, the indicators, the structure and divergence
// passes, the entry geometry, the rulebook and the locale tables, and that
// opens with a Deno.serve. Importing one number out of it drags every one of
// those into this bundle and into the vitest process that reads this file
// directly. There is also no smaller thing to import even if the weight were
// acceptable: the two effort values are declared inside the request handler's
// body, not at module scope, so they are not importable at all without first
// moving them — and moving them is an edit to analyze, which this task must not
// make and which no measurement should ever require of the thing it measures.
//
// The second is the measurement itself. #65 compares the live rulebook against
// a candidate over these same rows, and its entire claim rests on both of its
// arms having been sent an identical request shape. If this file imported
// analyze, a deploy of analyze that moved `max_tokens` or an effort value while
// a run was in flight would move the shape underneath the run, silently, and
// the resulting rate would be a mixture of two shapes with nothing on the cell
// saying which one each half was. Pinned here, the shape is a git-visible
// constant: it can only change when somebody edits this file, which is a change
// a reviewer sees and a re-registration a run has to declare.
//
// The copy is not allowed to drift unnoticed, which is the whole difference
// between a deliberate duplication and a fork. src/test/noise-floor-shape.test.ts
// reads analyze/index.ts as text, pulls each of these out BY SYMBOL NAME — never
// by line number, because #65 edits that file and every line number in it will
// move — and fails when a value here no longer matches the value there. Failing
// loudly is the point: re-syncing is a decision somebody makes, not something
// that happens to a run.

// analyze's own ceiling, the `max_tokens` of its baseRequest. Copied rather
// than lowered to save money: a response cut short is scored `truncated` and
// leaves BOTH the numerator and the denominator, so a smaller ceiling would not
// spend less — it would spend the same on cells that cannot be counted. Copied
// rather than raised for the same reason in the other direction: a replay that
// can think longer than production could is not a replay of production.
export const MAX_TOKENS = 8000;

// The two effort values production sends, one per path.
//
// This model runs adaptive thinking at effort "high" when `output_config.effort`
// is absent, so omitting the key would replay every row at a depth production
// never used. Effort is the thinking-depth dial, which is to say it is the
// dominant driver of exactly the quantity being measured, and a floor measured
// at the wrong depth is not a floor for anything. Each row is therefore replayed
// at the value its own path sent: "low" on the searching path, where production
// leaves headroom for page fetches, and "medium" on the technical path.
export const EFFORT_SEARCH = "low";
export const EFFORT_TECHNICAL = "medium";

// The single version header production sends. There is no `anthropic-beta`
// header in analyze — measured, zero occurrences in the file — and there is
// none here either. A beta header changes what the API accepts and what it
// returns, and a replay that opts into behaviour production never had is not a
// replay of production.
export const ANTHROPIC_VERSION = "2023-06-01";

// The server-tool identifiers, copied from analyze's applyRequestShape. They
// exist here only for the `search_on` arm, which is explicitly NOT the noise
// floor: its variance is model noise plus whatever the web did between the two
// calls, and nothing in the response separates the two. It is reported as
// replay stability and never as the floor.
export const WEB_SEARCH_TOOL_TYPE = "web_search_20260209";
export const WEB_SEARCH_NAME = "web_search";
export const WEB_SEARCH_MAX_USES = 1;

// The allowlist production searches under, copied verbatim from
// analyze/websearch.ts (12 entries, measured against that file by the test).
//
// What is deliberately NOT copied is `dropInaccessibleDomains`. Production
// prunes this list at runtime from what a 400 tells it, because a newly
// crawler-blocking site must degrade a user's analysis rather than break it.
// The replay must not do that: a prune between replicate 1 and replicate 2
// sends two different allowlists and books the difference as model noise. Here
// the list is frozen, and a 400 about an inaccessible domain fails the cell —
// which is the correct outcome, because a cell that had to change its own
// request is not a replicate of the other one.
export const NEWS_DOMAINS: string[] = [
  "bloomberg.com", "cnbc.com", "investing.com", "fxstreet.com",
  "dailyfx.com", "forexfactory.com", "tradingeconomics.com",
  "nikkei.com", "boj.or.jp", "federalreserve.gov",
  "ecb.europa.eu", "mof.go.jp",
];

// The field contract, copied byte for byte out of analyze/index.ts — comments
// and all, so that the two blocks can be diffed by eye and by the test without
// a reader having to decide whether a difference is a difference. The reasoning
// inside it is analyze's and is preserved rather than restated.
//
// It is sent as `output_config.format` on the technical rows only. The 45
// search-derived rows carry their own era's copy of this schema inline in the
// stored user text, and that text is replayed verbatim: the schema those rows
// send is the one they were born with, not this one. That mismatch is recorded
// per cell as `schema_era` rather than repaired, because repairing it would
// edit the bytes being replayed.
export const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    signal: { type: "string", enum: ["BUY", "SELL", "WAIT"] },
    thesis: { type: "string", description: "一行のトレードテーゼ（日本語、30字以内）" },
    confidence: { type: "integer", description: "0-100" },
    technical_score: { type: "integer", description: "0-100" },
    fundamental_score: { type: "integer", description: "0-100。ファンダ情報なしの場合は50" },
    risk_level: { type: "string", enum: ["LOW", "MEDIUM", "HIGH"] },
    sentiment: { type: "string", enum: ["BULLISH", "NEUTRAL", "BEARISH"] },
    stop_loss: { type: "number" },
    take_profit_1: { type: "number" },
    take_profit_2: { type: "number" },
    take_profit_3: { type: "number" },
    risk_reward_ratio: { type: "string", description: "例 1:2.1（TP1基準）" },
    market_context: { type: "string", description: "市場環境の説明（日本語）" },
    market_context_detail: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["Trend Day", "Range Day", "Breakout", "Reversal", "Choppy"] },
        structure: { type: "string", description: "例 Higher Highs & Higher Lows" },
        smart_money: { type: "string", enum: ["Accumulation", "Distribution", "Neutral"] },
        strength: { type: "string", enum: ["Weak", "Moderate", "Strong"] },
        session: { type: "string", enum: ["Tokyo", "London", "New York", "Overlap", "Off Hours"] },
        direction: { type: "string", enum: ["Up", "Down", "Sideways"] },
        continuity: { type: "string", enum: ["Sustained", "Fading", "Choppy"] },
      },
      // smart_money is deliberately NOT required. As an enum of
      // Accumulation/Distribution/Neutral it forced a claim about
      // institutional intent on every run — 18 Distribution, 3 Accumulation,
      // 0 Neutral across the first 21, tracking direction perfectly and
      // carrying nothing direction did not. The app has no order flow, so
      // there is nothing to observe it from.
      required: ["mode", "structure", "strength", "session", "direction", "continuity"],
      additionalProperties: false,
    },
    stop_hunt_zone: {
      type: "string",
      description: "板情報は取得していないため推測。ヒゲのみで抜けた水準など、値動きの根拠があるときだけ価格帯を書き、無ければ Not detected",
    },
    timeframe_alignment: {
      type: "array",
      items: {
        type: "object",
        properties: {
          timeframe: { type: "string" },
          bias: { type: "string", enum: ["BULLISH", "NEUTRAL", "BEARISH"] },
          note: { type: "string", description: "10字程度の根拠（日本語）" },
        },
        required: ["timeframe", "bias", "note"],
        additionalProperties: false,
      },
    },
    key_factors: { type: "array", items: { type: "string" } },
    support_levels: { type: "array", items: { type: "number" } },
    resistance_levels: { type: "array", items: { type: "number" } },
    analysis: { type: "string", description: "詳細分析（日本語、手順1-5に沿って）" },
    warnings: { type: "array", items: { type: "string" } },
    // What the analyst says it USED, which is not what it was shown. The
    // server already measures whether each shown rule fits today's market
    // (context.rule_fit); nothing until now recorded which of them the answer
    // actually leaned on, so "the rule as written" and "the rule as used"
    // could only be told apart by reading the prose — and on the ten v8 rows
    // whose prose names the over-extension rule, none of them met that rule's
    // written condition (ADX above 60, RSI near 10).
    //
    // Deliberately NOT in `required`. Structured output does not bind when
    // web search is on, which is most production runs, so this field is
    // absent far more often than it is present and every reader downstream
    // treats absent as normal.
    rules_applied: {
      type: "array",
      items: { type: "string" },
      // No worked example here, and none with a live id in it. The rendered
      // schema is inlined into the user message on the searching path, which is
      // all but three of the stored v8 rows (36 of 39 when this was written, 40
      // of 43 just before the deploy — the three are the whole exception, not
      // the counts), so an example id is a live id sitting in the prompt.
      // The rule block now prints the ids (analyze/rules.ts, 2026-09-08), which
      // removes the reason this field could never be answered but not the
      // reason for the ban: `r10` as the example is `r10` as the answer, and a
      // claim that is really an echo of its own example is worse than no claim.
      // The ids belong beside the rules they name, and nowhere else.
      description:
        "提示された学習ルールのうち、この回の判断で実際に根拠として使ったものの id だけを列挙する。提示されただけで使わなかったルールは書かない。id を推測して作らない。1つも使わなかった場合は空配列 [] が正しい答えで、無理に埋めない。",
    },
  },
  required: [
    "signal", "thesis", "confidence", "technical_score", "fundamental_score",
    "risk_level", "sentiment", "stop_loss", "take_profit_1",
    "take_profit_2", "take_profit_3", "risk_reward_ratio", "market_context",
    "market_context_detail", "timeframe_alignment",
    "key_factors", "support_levels", "resistance_levels", "analysis", "warnings",
  ],
  additionalProperties: false,
};

// Both of the above are shared by every body this module builds, and two
// replicates of a row must be byte-identical. A single stray write through one
// body's `output_config.format.schema` would change what the OTHER replicate
// sends, and nothing downstream would show it: the cell records a sha256 of the
// system and user strings, not of the schema. Freezing turns that class of bug
// into a throw at the moment it happens instead of a quiet corruption of the
// measurement. (`allowed_domains` is copied into each body instead, so a body
// owns its own array and freezing the source list costs the caller nothing.)
const deepFreeze = <T>(value: T): T => {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};
deepFreeze(RESPONSE_SCHEMA);
deepFreeze(NEWS_DOMAINS);

// ---------------------------------------------------------------------------
// Arms, row classes and the shape each pair produces
// ---------------------------------------------------------------------------

// Which experiment the cell belongs to. `search_free` is the primary and the
// only one whose rate may be called a noise floor.
export type Arm = "search_free" | "fallback_surgery" | "search_on";

// What production sent for this row, decided from the stored prompt TEXT by
// prompt-surgery.ts and cross-checked against `analyses.mode`. It is read from
// the text and not from the column because analyze can set
// `searchDroppedReason = "no_allowed_domains"` without calling giveUpSearch,
// which moves the column while leaving the bytes alone; the bytes are what was
// sent.
export type RowClass = "search_derived" | "technical";

// The shape recorded on the cell. It is stored rather than re-derived later
// because analysis_prompts keeps only system, user and model — every other
// field of the request is reconstructed from whatever this file said on the day
// the run happened, and a future reader must be able to see which
// reconstruction ran without going to the git history to find out.
export type Shape = "search_free_inline" | "structured" | "search_on";

export interface ReplayInput {
  arm: Arm;
  rowClass: RowClass;
  // From the stored `model` column, never a constant here: a row must be
  // replayed to the model that answered it. index.ts compares this against
  // `response.model` and refuses to pool a cell where the server answered from
  // somewhere else.
  model: string;
  // The two stored strings, exactly as production sent them. For
  // `fallback_surgery` the caller passes the transformed user text; the
  // transform and its post-conditions live in prompt-surgery.ts, and this
  // function neither performs nor second-guesses it.
  system: string;
  user: string;
}

export interface WebSearchTool {
  type: string;
  name: string;
  max_uses: number;
  allowed_domains: string[];
}

export interface OutputConfig {
  format?: { type: "json_schema"; schema: unknown };
  effort: string;
}

// Exactly the five keys of a replay body, plus `tools` on the one arm that has
// them. Written as a closed interface rather than a Record so that a sixth key
// cannot be added without a type change somebody has to read.
export interface ReplayBody {
  model: string;
  max_tokens: number;
  system: string;
  messages: Array<{ role: "user"; content: string }>;
  output_config: OutputConfig;
  tools?: WebSearchTool[];
}

// A refusal, not a failure. Every throw out of this module means the caller
// asked for a body that would have measured something other than what it
// claimed to measure; the prefix is stable so index.ts can record the cell as
// refused rather than as an answer.
export const SHAPE_REFUSAL_PREFIX = "shape_refused:";

const refuse = (code: string, detail: string): never => {
  throw new Error(`${SHAPE_REFUSAL_PREFIX} ${code} — ${detail}`);
};

// Every arm and every row class this module will build for, named exhaustively
// so that the mapping below can refuse anything else instead of defaulting.
//
// Neither value arrives from the type system. `arm` comes off a text column on
// noise_runs by way of a JSON request body, and `rowClass` comes from
// prompt-surgery.ts reading a stored prompt; TypeScript checks the call site
// and nothing checks the row. Which makes the default the dangerous part: a
// row class that is anything but "search_derived" — a typo, a null that arrived
// as a string, a third class added to prompt-surgery.ts and not to this file —
// would otherwise land on "structured", and "structured" is constrained
// decoding at effort "medium". That is exactly the shape the design refuses to
// make primary (D1): `format` removes the prose-parse failure the 45 rows
// actually run on, and "medium" is the deeper effort, so the cell would agree
// with itself more often than production's own shape does and the pooled rate
// would come out LOW. A floor that is too low is the one error #65 cannot
// survive — it licenses reading a real regression as noise. An unrecognised arm
// is the mirror of it: it used to fall through to `search_on`, which would have
// attached web search to the primary run and spent money doing it. Both refuse.
export const ARMS: readonly Arm[] = ["search_free", "fallback_surgery", "search_on"];
export const ROW_CLASSES: readonly RowClass[] = ["search_derived", "technical"];

// Which shape an (arm, row class) pair produces, and which pairs have no shape
// at all.
//
// The two refusals are not defensiveness about impossible inputs; both are
// reachable by passing the wrong row list to the wrong arm, and both would
// produce a cell that looks like a measurement and is not:
//
//   * fallback_surgery on a technical row. The surgery rewrites the third line
//     and cuts the inline schema off a SEARCH-derived prompt. A technical row
//     has neither — production already sent it in the structured shape — so
//     "surgery" on it is a no-op, and the cell would be byte-identical to the
//     same row's search_free cell while being pooled as evidence about what the
//     surgery costs. The arm exists precisely to measure that cost against
//     search_free; a row where the two arms are the same request contributes a
//     guaranteed zero and biases the cost toward zero.
//
//   * search_on on a technical row. Production never attaches web search to a
//     technical row: search is off for that path by definition. Worse, tools
//     and `output_config.format` are incompatible — analyze's own comment says
//     citations are why — so honouring the request would mean dropping `format`
//     as well, changing two fields at once on a row whose stored text has no
//     inline schema to fall back on. The row would answer into no contract at
//     all.
export const replayShape = (input: { arm: Arm; rowClass: RowClass }): Shape => {
  const { arm, rowClass } = input;
  if (!ARMS.includes(arm)) {
    return refuse(
      "arm_unknown",
      `arm must be one of ${ARMS.join(", ")}; there is no default, because the arm decides whether ` +
        "web search goes on the wire and an unrecognised one must not choose that by falling through",
    );
  }
  if (!ROW_CLASSES.includes(rowClass)) {
    return refuse(
      "row_class_unknown",
      `rowClass must be one of ${ROW_CLASSES.join(", ")}; there is no default, because the fallthrough ` +
        "would be the structured shape, whose constrained decoding removes the prose-parse failure these " +
        "rows actually run on and would report a floor lower than the analyst's",
    );
  }
  if (arm === "search_free") {
    return rowClass === "search_derived" ? "search_free_inline" : "structured";
  }
  if (arm === "fallback_surgery") {
    if (rowClass !== "search_derived") {
      return refuse(
        "arm_row_mismatch",
        "fallback_surgery is defined only on search-derived rows: a technical row has no note to rewrite " +
          "and no inline schema to strip, so the cell would duplicate search_free and report the surgery as free",
      );
    }
    return "structured";
  }
  if (arm === "search_on") {
    if (rowClass !== "search_derived") {
      return refuse(
        "arm_row_mismatch",
        "search_on is defined only on search-derived rows: production never attaches web search to the " +
          "technical path, and tools cannot be combined with output_config.format, so the row would be sent " +
          "with no field contract at all",
      );
    }
    return "search_on";
  }
  // Unreachable while ARMS and the branches above agree. It is written out
  // rather than left as an implicit fallthrough so that adding a fourth arm to
  // ARMS without adding a branch here fails a cell instead of quietly building
  // one of the three shapes for it.
  return refuse("arm_unhandled", `${arm} is a declared arm with no shape branch in this file`);
};

// The output_config each shape sends.
//
// It is never omitted and there is no path here that drops it. Production has
// one: a 400 whose message names `output_config` or `effort` sets
// `effortEnabled = false` and re-shapes the request, after which the searching
// path sends no `output_config` at all and the technical path sends `format`
// with no `effort`. It does that because a live user's analysis must survive
// the API rejecting a request option. A replay must not survive it: a cell
// whose effort quietly became the API default is not a replicate of the cell
// that ran at "low", and pooling the two reports a shape change as model noise.
// If the option is ever rejected, the cell fails and says so.
const outputConfigFor = (shape: Shape): OutputConfig => {
  if (shape === "structured") {
    return { format: { type: "json_schema", schema: RESPONSE_SCHEMA }, effort: EFFORT_TECHNICAL };
  }
  // search_free_inline and search_on are both the searching path's shape: no
  // `format`, because the 45 rows carry their contract as prose in the user
  // text and that is the parse path whose failures this measurement is supposed
  // to be able to see (a run that never meets a parse failure has not shown
  // that parse failures are rare — it has shown that constrained decoding
  // removed them).
  return { effort: EFFORT_SEARCH };
};

// ---------------------------------------------------------------------------
// The body
// ---------------------------------------------------------------------------
//
// WHAT IS ABSENT, AND WHY IT IS ABSENT ON PURPOSE
//
// No `temperature`, no `top_p`, no `top_k`, no `seed`. The measured fact this
// rests on is about the repo, not the API: analyze/index.ts contains zero
// occurrences of any of the four, so production has never sent one, and the
// test pins that none of them reaches the wire from here either. The design
// dossier additionally records that these parameters are not accepted on this
// model and that sending one returns 400. That is an API-behaviour claim, it
// has NOT been re-measured — doing so costs a billable call — and nothing here
// needs it to be true. Even if the API took a temperature tomorrow, pinning one
// would still be refused: production did not send it, and a replay that samples
// differently from the analysis it is replaying is not a replay.
//
// So two identical POSTs are two independent samples, and that is not a defect
// to be configured away, it is the entire quantity #64 exists to measure.
// Anyone who arrives here intending to "make the replay deterministic" should
// stop: determinism would make the number zero by construction and #65 would
// inherit a floor that describes the harness rather than the analyst.
//
// No `thinking` key. Effort is expressed through `output_config.effort`, which
// is what production sends; adding a thinking block would be a second, louder
// statement about the same dial.
//
// No `cache_control`, and `system` and `messages[0].content` go out as plain
// STRINGS. Production sends both as plain strings; cache_control requires the
// content-block array form, so switching to it to save money would change the
// shape of the very request whose stability is being measured — a certain
// change to buy an unproven saving, since the minimum cacheable prefix is
// model-dependent and the stored system prompts may well sit under it.
//
// The key set is closed and the test pins it. A body with one extra key is a
// body production never sent.
export const buildReplayRequest = (input: ReplayInput): ReplayBody => {
  const { arm, rowClass, model, system, user } = input;

  // A missing string is refused rather than defaulted. An empty system prompt
  // is a perfectly valid request that measures a different question, and the
  // sha256 written on the cell would faithfully record the emptiness of
  // something nobody meant to send.
  if (typeof model !== "string" || model.length === 0) {
    return refuse("model_missing", "the row's stored model column is required; there is no default here");
  }
  if (typeof system !== "string" || system.length === 0) {
    return refuse("system_missing", "the row's stored system prompt is required and must not be empty");
  }
  if (typeof user !== "string" || user.length === 0) {
    return refuse("user_missing", "the row's stored user prompt is required and must not be empty");
  }

  const shape = replayShape({ arm, rowClass });

  const body: ReplayBody = {
    model,
    max_tokens: MAX_TOKENS,
    system,
    messages: [{ role: "user", content: user }],
    output_config: outputConfigFor(shape),
  };

  // `tools` is assigned only on the arm that has them, never assigned as
  // `undefined`: the cell records `tools_present`, and index.ts and the test
  // both ask whether the key EXISTS. A key present with an undefined value
  // disappears from the JSON body but not from `"tools" in body`, which is
  // exactly the kind of difference that would be invisible on the wire and
  // wrong in the record.
  if (shape === "search_on") {
    body.tools = [{
      type: WEB_SEARCH_TOOL_TYPE,
      name: WEB_SEARCH_NAME,
      max_uses: WEB_SEARCH_MAX_USES,
      allowed_domains: [...NEWS_DOMAINS],
    }];
  }

  return body;
};

// The three headers production sends, and only those three.
//
// This lives here rather than in index.ts so that "no anthropic-beta header"
// is a property of a pure function a test can call, instead of a claim about a
// Deno module that can only be checked by grepping its source. The key is
// taken as an argument and is never logged, returned in a summary, or stored:
// it appears in one place, on its way out.
export const replayHeaders = (apiKey: string): Record<string, string> => {
  if (typeof apiKey !== "string" || apiKey.length === 0) {
    return refuse("api_key_missing", "the Anthropic key comes from the environment and is required");
  }
  return {
    "content-type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": ANTHROPIC_VERSION,
  };
};
