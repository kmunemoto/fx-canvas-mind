// REUSING AN ANSWER WHEN THE QUESTION WAS IDENTICAL.
//
// The owner's ask: 「完全に同じ入力条件なら結果を再利用する」— because the same
// input does not reliably give the same answer. Measured on this project's own
// stored prompts, replayed: 10 of 48 flipped SELL↔WAIT (#64). Asking twice
// therefore samples the analyst's noise; it does not gather evidence.
//
// WHAT "IDENTICAL" HAS TO MEAN, and what it turns out to cost.
//
// The honest key is the two strings that were sent, plus the shape they were
// sent at. Everything IN THE PROMPT that could move the answer is inside them:
// the candle blocks, every indicator, the structure, the learned rules, the
// event block, the language rule, the schema. Nothing needs to be enumerated
// or kept in step with the prompt builder, because the key IS the prompt.
//
// ONE INPUT IS NOT IN THE PROMPT: the web search. In full mode the request
// carries the search tool and the analyst fetches today's releases, policy
// lines and headlines AT MODEL TIME, then folds them into fundamental_score,
// analysis and key_factors. None of that is in either string, so the key
// cannot see it and no window can bound it — news lands while the market is
// shut, which is precisely and only when this feature can fire.
//
// An earlier draft of this module claimed the prompt was the whole input and
// served full-mode rows for the length of a closed session. That would have
// handed a reader Friday evening's news read on Sunday night, under a banner
// saying the inputs were byte-for-byte identical. They were not. So: a turn
// whose answer could contain web-fetched content is NOT REUSABLE, and the
// refusal is named (`search_used`). Covering full mode would mean storing
// what the search returned and keying on that; this module does not pretend
// to have done it.
//
// One line is excluded: `現在時刻(UTC): …`. It is the wall clock, it differs on
// every single run, and keying on it would make the feature fire never. Taking
// it out is not free — the analyst reads it for the session label and for how
// far off the next event is — so the window below bounds how far the clock may
// have moved, and the screen says which run's clock the answer was made under.
//
// WHAT THIS MEASURED, BEFORE IT WAS BUILT.
//
// Over the 91 stored prompt rows on 2026-09-13: byte-identical pairs, 0.
// Identical once the clock line is removed: exactly 1 pair — a 下見 (preview,
// market shut) run and its repeat a minute later, both WAIT 68.
//
// That one pair was `mode = full`. It searched. So under the rule above it is
// refused, and THE MEASURED HIT RATE OF THIS FEATURE IS 0 OF 91. Said plainly
// because the number is the point: as shipped it serves technical-only runs
// and nothing else, and on the traffic this project has actually seen it
// would not have fired once.
//
// That follows from the entry contract. Under market_v1 the plan is filled at
// the price of the moment, and that price is in the prompt (`現在値: …`). So
// while the market trades, two runs cannot have the same input: the forming
// bar ticks and the entry price moves. Reuse can only fire when the market is
// SHUT, or when the feed has not moved at all — a double submit, or a stalled
// provider — AND the run did not search.
//
// It is therefore NOT a fix for the flips seen a minute apart in a live
// market: those runs were given different inputs (the measured pairs differ
// only in the forming bar's last digits, and one of them flipped WAIT→SELL on
// a 1day chart). Reducing those needs a different change — deciding on closed
// bars only — and this module deliberately does not pretend to do it.
//
// Deno-free on purpose: src/test/reuse.test.ts imports this file directly.
// `inputsKey` uses WebCrypto, which Deno and Node 18+ both provide.

export const REUSE_VERSION = 1;

// The wall-clock line, which is the one thing allowed to differ.
//
// EVERY LOCALE WRITES IT DIFFERENTLY, and the first version of this pattern
// matched only the Japanese one — which would have left the clock inside the
// key for every English reader, so the feature would have been dead in that
// locale and nothing would have said so. src/test/reuse.test.ts now builds the
// real user message from analyze/locale.ts for each SUPPORTED_LOCALE and
// asserts this matches it exactly once, so a locale added later cannot repeat
// the mistake quietly.
//
// Anchored to the start of a line and matched to the end of it, so it cannot
// eat anything around it.
export const CLOCK_LINE = /^(?:現在時刻\(UTC\)|Current time \(UTC\)): .*$/m;

export interface CanonicalInput {
  system: string;
  user: string;
  model: string;
  // Null when no output_config was sent at all (the API rejected it and the
  // turn was retried without it). Null is a shape, not a default.
  effort: string | null;
  maxTokens: number | null;
  // Decided by ARRIVAL TIME, not by the prompt, so it has to be keyed
  // explicitly: the same market data can be read once while the market is
  // open and once after it shut, and those are different plans.
  preview: boolean;
  // Whether the request carried the web search tool. The tool's OTHER fields
  // (the allowed_domains list, which a domain-recovery retry prunes) are not
  // keyed, and do not need to be: a row that searched is refused outright
  // below, so no two runs with different allowlists can ever be served each
  // other's answer.
  //
  // Not in either string —
  // the tool block is part of the request, not the prompt — and a full mode
  // whose domain list came back empty sends no tool while leaving the user
  // message untouched, so without this the searching and non-searching
  // shapes would share a key.
  searched: boolean;
  contract: string;
  locale: string;
}

// The exact bytes the key is taken over. Returned as a string rather than
// hashed here so a test can read what is being compared.
export const canonicalInput = (input: CanonicalInput): string =>
  [
    `v${REUSE_VERSION}`,
    `model=${input.model}`,
    `effort=${input.effort ?? "(none)"}`,
    `max_tokens=${input.maxTokens ?? "(none)"}`,
    `preview=${input.preview ? "1" : "0"}`,
    `searched=${input.searched ? "1" : "0"}`,
    `contract=${input.contract}`,
    `locale=${input.locale}`,
    "--- system ---",
    input.system,
    "--- user ---",
    // Replaced rather than deleted, so a prompt that happens to contain the
    // replacement text cannot be made to collide with one that does not.
    input.user.replace(CLOCK_LINE, "(clock line removed for the reuse key)"),
  ].join("\n");

const hex = (buffer: ArrayBuffer): string =>
  Array.from(new Uint8Array(buffer)).map((b) => b.toString(16).padStart(2, "0")).join("");

export const inputsKey = async (input: CanonicalInput): Promise<string> => {
  const bytes = new TextEncoder().encode(canonicalInput(input));
  return hex(await globalThis.crypto.subtle.digest("SHA-256", bytes));
};

// ---------------------------------------------------------------------------
// How far back a match may be taken from
// ---------------------------------------------------------------------------

const MINUTE = 60_000;
const BAR_MS: Record<string, number> = {
  "15min": 15 * MINUTE,
  "1h": 60 * MINUTE,
  "4h": 4 * 60 * MINUTE,
  "1day": 24 * 60 * MINUTE,
};

// The clock is the only thing the key lets differ, so the window is only ever
// about how far the clock may have drifted. Two cases, and neither is a
// tuned number:
//
//   market open   one bar of the entry timeframe. Identical candles already
//                 prove no bar closed; this bounds the drift to less than the
//                 unit the plan is written in.
//   market shut   the whole closed session. Nothing can trade, so the
//                 session label and the distance to the next event cannot be
//                 overtaken by anything that happened — there was nothing.
//
// The shut case is passed its own floor (`sessionStartMs`, the last market
// close) rather than a duration, because the session's length is a fact about
// the calendar and not a constant worth writing down.
export const reuseFloorMs = (input: {
  interval: string;
  preview: boolean;
  nowMs: number;
  sessionStartMs: number;
}): number =>
  input.preview
    ? input.sessionStartMs
    : input.nowMs - (BAR_MS[input.interval] ?? BAR_MS["1h"]);

// ---------------------------------------------------------------------------
// The candidate
// ---------------------------------------------------------------------------

export interface CandidateRow {
  id: string;
  created_at: string;
  preview: boolean;
  shadow: boolean;
  has_result: boolean;
  // The row's OWN record of what went into its answer. `technical_only` is
  // the one value that says no web-fetched content is in it. Read off the
  // column rather than rebuilt from today's request flag: a row written under
  // a dropped search is `technical_fallback`, and rebuilding would label it
  // "full" beside its own warning saying news was unavailable.
  mode: string | null;
  // The earliest instant this row's answer could have read the reader's
  // positions — the held-position review starts BEFORE the model call and the
  // row is written after it, so `created_at` is 30-50 s too late to use as
  // the cutoff for "did the holdings move since".
  read_positions_at: string;
}

export type ReuseRefusal =
  // No stored row carries this key for this reader.
  | "no_match"
  // Found, but older than the floor above.
  | "outside_window"
  // Found, but it is a shadow row or carries no stored answer: there is
  // nothing to serve.
  | "not_servable"
  // Found, but the reader's positions on this pair changed since it was
  // written, so its held-position judgement is about a different holding.
  | "positions_changed"
  // A lookup that COULD NOT BE MADE — the query errored, or the positions
  // check could not be answered. Refuses like the others, but it is not a
  // measurement: folding it into `no_match` would fill the log with rows
  // saying "looked, found nothing" for a feature that never got to look, and
  // folding the positions case into `positions_changed` would state a fact
  // about the reader's holdings that nobody observed (docs/OPERATIONS.md
  // §7.3). analyze/index.ts already draws this line for the review's
  // references (`lookup_failed` there); it has to hold here too.
  | "lookup_failed"
  // Found, but its answer may contain what a web search returned, which is
  // not in the key and cannot be put there.
  | "search_used"
  // The key itself could not be computed, so no lookup was made at all.
  // `decideReuse` never returns this — there was nothing to decide — but the
  // log has to be able to say it, or a run that could not ask reads back as a
  // run that asked and missed.
  | "key_unavailable"
  // The caller asked for a fresh analysis explicitly.
  | "forced_fresh";

// Every value `analysis_reuses.outcome` may hold. Exported so the migration's
// CHECK constraint is pinned to THIS list by a test rather than to a hand
// retyped copy of it: a refusal that exists in the code and not in the
// constraint is a write that fails, and one that exists in the constraint and
// not in the code is a value no measurement will ever count.
export const REUSE_OUTCOMES = [
  "served",
  "no_match",
  "outside_window",
  "not_servable",
  "positions_changed",
  "search_used",
  "lookup_failed",
  // The key itself could not be computed, so the lookup never happened. Its
  // own name, because a run that could not ask is not a run that asked and
  // missed.
  "key_unavailable",
  "forced_fresh",
] as const;

export type ReuseDecision =
  | { reuse: true; analysis_id: string; analyzed_at: string }
  | { reuse: false; refusal: ReuseRefusal };

// Every refusal is named. A reuse that quietly did not happen is
// indistinguishable from a feature that is not running, and the row that
// records the run has to be able to say which.
export const decideReuse = (input: {
  candidate: CandidateRow | null;
  floorMs: number;
  preview: boolean;
  forceFresh: boolean;
  // True when a positions row on this pair was created or closed after the
  // candidate was written. Null when it COULD NOT BE CHECKED, which refuses
  // too — a false negative here serves a held-position verdict about a
  // different holding — but under its own name, because "we could not ask"
  // is not the same claim as "the holdings moved".
  positionsChangedSince: boolean | null;
}): ReuseDecision => {
  if (input.forceFresh) return { reuse: false, refusal: "forced_fresh" };
  const c = input.candidate;
  if (c === null) return { reuse: false, refusal: "no_match" };
  if (c.shadow || !c.has_result) return { reuse: false, refusal: "not_servable" };
  // The key already carries `preview`, so a mismatch here would be a bug
  // rather than a stale row; refusing costs one model call and asserting
  // costs a plan served under the wrong market state.
  if (c.preview !== input.preview) return { reuse: false, refusal: "not_servable" };
  // The only mode whose answer provably holds no web-fetched content. NULL
  // (a row from before the column, or a write that raced) refuses too: an
  // unknown mode is not a known-safe one.
  if (c.mode !== "technical_only") return { reuse: false, refusal: "search_used" };
  const at = Date.parse(c.created_at);
  // A timestamp that could not be read is not a row that was found to be old.
  // Calling it `outside_window` would send an operator to widen the window
  // over a parse failure — a tuning decision taken on a fault.
  if (!Number.isFinite(at)) return { reuse: false, refusal: "lookup_failed" };
  if (at < input.floorMs) return { reuse: false, refusal: "outside_window" };
  if (input.positionsChangedSince === null) return { reuse: false, refusal: "lookup_failed" };
  if (input.positionsChangedSince) return { reuse: false, refusal: "positions_changed" };
  return { reuse: true, analysis_id: c.id, analyzed_at: c.created_at };
};

// What the response and the row record about a reuse. Stored on the log table
// rather than on the plan: the plan itself is not rewritten by being served
// again (docs/OPERATIONS.md §2.3).
// NO `inputs_key` HERE. The digest covers the whole analyst system prompt,
// which this repo deliberately keeps off the client
// (20260905161000_replay_inputs_are_server_side.sql dropped `analyses.prompt`
// for exactly that reason). A digest is not the plaintext, so shipping it
// would weaken the boundary rather than break it — but no screen reads the
// field, so it buys nothing to put on the wire. It stays on the
// `analysis_reuses` row, where the measurement needs it.
export interface ReuseRecord {
  version: 1;
  analysis_id: string;
  analyzed_at: string;
  served_at: string;
  // Did the credit actually come back? The refund is a best-effort RPC that
  // clears its own guard BEFORE it runs (so it can never double-refund), which
  // means a failure is permanent: the count stays down and nothing retries.
  // The banner says "no analysis credit was used", and it must not say that
  // over a counter the reader just watched go down.
  // null = none was consumed in the first place (admin), which is not a
  // failed refund and is reported as neither.
  credit_refunded: boolean | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// The earliest parseable timestamp among the row's own records of when it
// looked at the world. Earliest, not latest: every candidate is a moment the
// stored answer had already read something, and a cutoff that is too EARLY
// only costs a refusal, while one that is too late serves a held-position
// card about a holding that has since been closed.
const earliestStamp = (raw: Record<string, unknown>, fallback: string): string => {
  const stamps: string[] = [fallback];
  const review = isRecord(raw.position_review) ? raw.position_review : null;
  if (review !== null && typeof review.at === "string") stamps.push(review.at);
  const check = isRecord(raw.entry_check) ? raw.entry_check : null;
  if (check !== null && typeof check.priced_at === "string") stamps.push(check.priced_at);
  let best = fallback;
  let bestMs = Number.POSITIVE_INFINITY;
  for (const s of stamps) {
    const ms = Date.parse(s);
    if (Number.isFinite(ms) && ms < bestMs) {
      bestMs = ms;
      best = s;
    }
  }
  return best;
};

export const readCandidate = (raw: unknown): CandidateRow | null => {
  if (!isRecord(raw)) return null;
  const id = typeof raw.id === "string" ? raw.id : null;
  const created = typeof raw.created_at === "string" ? raw.created_at : null;
  if (id === null || created === null) return null;
  return {
    id,
    created_at: created,
    preview: raw.preview === true,
    shadow: raw.shadow === true,
    // `result` is the normalized analysis the screen draws. A row without one
    // (an old row, or one whose save raced) has nothing to serve.
    has_result: isRecord(raw.result),
    mode: typeof raw.mode === "string" ? raw.mode : null,
    read_positions_at: earliestStamp(raw, created),
  };
};
