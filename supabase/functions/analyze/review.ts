// THE HELD-POSITION REVIEW.
//
// The app's WAIT means "do not open a new position now". It has never meant
// "close the one you hold", but the screen showed only the new-entry call, so
// a reader holding a SELL from the previous run had to guess. This module is
// the other half of the screen: what the plan the reader HOLDS (or, failing
// that, the plan the previous run published) looks like now, judged against
// ITS OWN thesis and levels — never derived from the new-entry signal.
//
// Three principles, from the owner, that every function below is built to
// keep:
//
//   1. WAIT から自動的に「継続」を導かない。保有プランを評価して決める。
//      The verdict comes from a SEPARATE model call that is not shown the
//      new-entry answer, plus mechanical facts the server measures itself.
//   2. 元のプランを残し、再分析で勝手に上書きしない。
//      Nothing here writes to the reference row. The review is stored on the
//      NEW row, and the position keeps the plan it was registered against.
//   3. 「新規の条件が悪くなった」と「前の売りの根拠が崩れた」を区別する。
//      The change since the previous run is classified from the ANALYST's
//      direction on each side (proposed_signal, not the published column that
//      the gate rewrites to WAIT), and the thesis reading is a separate,
//      labelled field that never enters the classification.
//
// Why a second call rather than a field on the main one. The main prompt and
// RESPONSE_SCHEMA are replay-harness artefacts: noise-floor/shape.ts carries a
// frozen copy of the schema and every stored analysis_prompts row is replayed
// verbatim. Touching either would silently retire the 90 rows already
// measured. And the main call flips SELL↔WAIT on identical input 10 times in
// 48 (NOISE_FLOOR_PREREGISTRATION.md §12.2); a hold verdict riding on it
// would inherit that noise with nothing to anchor it.
//
// Measurement honesty, in the sense docs/OPERATIONS.md §7.3 uses it. Every
// number here says what it was measured on. Touches are on the MID series of
// the entry timeframe (Twelve Data, or the GMO mid overlay — recorded as
// `feed`), examined from the bar AFTER the anchor instant; the tracker's own
// verdict is on whatever basis it recorded, and is reported BESIDE the mid
// facts, never merged into them. "Not measured" is a distinct state from
// "no touch" and renders as such. The analyst's answer is stored as written
// and never rewritten: the server's verdict sits next to it with the fact
// that decided it.
//
// Deno-free on purpose: src/test/position-review.test.ts imports this file
// directly. index.ts performs the fetches; this file builds the request,
// reads the rows, measures the facts and derives the verdict.

import type { Candle } from "./indicators.ts";
import type { AnalysisLocale } from "./locale.ts";

export const REVIEW_VERSION = 1;
// A short structured answer on a technical-only request. Named here so the
// request shape can be recorded off the object that was sent, and so
// index.ts carries no second numeric max_tokens literal (the noise-floor shape
// test pins that file to exactly one).
export const REVIEW_MAX_TOKENS = 2000;
export const REVIEW_EFFORT = "medium";
// How far back "the previous run" reaches. Older than this and the market the
// previous call read is not the market this one reads.
export const PREVIOUS_WINDOW_HOURS = 72;

export type Direction = "BUY" | "SELL";
export type PublishedSignal = "BUY" | "SELL" | "WAIT";
export type HeldVerdict = "hold" | "caution" | "exit_condition_met" | "undecidable";
export type ThesisStatus = "intact" | "weakened" | "broken" | "unknown";
export type ReferenceKind = "held" | "previous";
// Who made a WAIT a WAIT. Same rule as isRejected / isSelfDeclined in
// src/lib/outcomeStats.ts and waitReasonOf in src/lib/warnings.ts: a
// published trade is always the analyst's own call (the gate only ever
// rewrites TO WAIT); a WAIT with a proposed BUY/SELL and a rejection is the
// server's; a WAIT the analyst itself proposed is the analyst's; a WAIT with
// no proposed_signal recorded is nobody's to claim.
export type DecidedBy = "server" | "analyst" | "unknown";
export type ChangeKind = "same_call" | "reversed" | "trade_to_wait" | "wait_to_trade" | "unclear";
export type PriceFeed = "twelve_data" | "gmo";

export interface ReferenceOutcome {
  outcome: string;
  // The basis the TRACKER judged on, read off its evaluation. Null = not
  // recorded, never "mid" or "quotes" by assumption.
  price_basis: "mid" | "quotes" | null;
  closed_at: string | null;
  outcome_price: number | null;
}

export interface HeldReference {
  kind: "held";
  position_id: string;
  analysis_id: string;
  direction: Direction;
  entry: number;
  stop: number;
  tp1: number;
  tp2: number | null;
  tp3: number | null;
  opened_at: string;
  opened_at_source: "user" | "registered" | null;
  registered_after_settlement: boolean;
  interval: string;
  confidence: number | null;
  thesis: string | null;
  key_factors: string[];
  // Which book priced the plan (entry_check.price_feed). Null = not recorded.
  feed: PriceFeed | null;
  outcome: ReferenceOutcome | null;
  // The review reads the NEWEST open position on the pair. Others are
  // counted, and their ids are the caller's own rows.
  other_open_positions: { count: number; ids: string[] };
  snapshot: unknown | null;
  structure: unknown | null;
}

export interface PreviousReference {
  kind: "previous";
  analysis_id: string;
  at: string;
  priced_at: string | null;
  interval: string;
  signal: PublishedSignal;
  proposed_signal: PublishedSignal | null;
  rejection: string | null;
  confidence: number | null;
  decided_by: DecidedBy;
  analyst_direction: PublishedSignal | null;
  // The plan's levels. `published: false` means the analyst proposed them and
  // the gate refused to publish; they live on in entry_check and are what the
  // comparison should be made against. Null when the previous call named no
  // levels at all (a WAIT the analyst chose).
  levels: { direction: Direction; entry: number; stop: number; tp1: number; published: boolean } | null;
  thesis: string | null;
  key_factors: string[];
  feed: PriceFeed | null;
  outcome: ReferenceOutcome | null;
  snapshot: unknown | null;
  structure: unknown | null;
}

export interface ReferenceSet {
  held: HeldReference | null;
  held_reason: "no_open_position" | "lookup_failed" | "plan_row_missing" | null;
  previous: PreviousReference | null;
  previous_reason: "none_within_window" | "lookup_failed" | null;
  // Whose thesis the analyst was asked about. The held plan when there is
  // one; the previous run's otherwise. `change` is ALWAYS about `previous`.
  thesis_of: ReferenceKind | null;
}

// One level, three states. `measured: false` is never rendered as "no touch".
export type LevelTouch =
  | { measured: true; touched: true; at: string; bar_closed: boolean }
  | { measured: true; touched: false; from: string; as_of: string; bars_examined: number }
  | { measured: false; reason: "no_anchor" | "series_starts_after_anchor" | "no_bars_since_anchor" };

export interface MechanicalFacts {
  subject: ReferenceKind;
  basis: "mid";
  feed: PriceFeed;
  // How far outside GMO's newest bar the Twelve Data reference sat at the
  // decision instant, in ATR (price-source.ts). Null = not measured; renders
  // as such, never as 0.
  feed_delta_atr: number | null;
  price: number;
  priced_at: string;
  direction: Direction;
  entry: number;
  stop: number;
  tp1: number;
  // |entry - stop| in price units; null when zero (an incoherent plan)
  risk: number | null;
  // Signed, favourable positive. For subject "previous" this is HYPOTHETICAL —
  // what a fill at the plan's entry would show — and is labelled so wherever
  // it is rendered.
  move_pips: number | null;
  move_r: number | null;
  // Remaining distance, signed: negative means price is already beyond it.
  to_stop_pips: number | null;
  to_tp1_pips: number | null;
  anchor_at: string | null;
  anchor_source: "opened_at" | "priced_at" | null;
  // The series reaches back to the anchor. False when it starts after it,
  // which turns a non-touch into "not measured" but never hides a touch.
  covers_anchor: boolean | null;
  bars_examined: number;
  // The bar containing the anchor instant is EXCLUDED: its range includes
  // moves before the position existed, and the tracker treats that bar as
  // ambiguous for the same reason. `from` on a non-touch is the first bar
  // actually examined.
  as_of: string | null;
  stop_touch: LevelTouch;
  tp1_touch: LevelTouch;
}

export interface AnalystReview {
  status: "ok" | "failed";
  // Only asked for a HELD plan. Null on a previous-only review and on failure.
  verdict: HeldVerdict | null;
  thesis_status: ThesisStatus | null;
  reasons: string[];
  what_changed: string[];
  watch: string | null;
  model: string | null;
  effort: string | null;
  max_tokens: number | null;
  error: string | null;
  elapsed_ms: number | null;
}

export interface OverrideReason {
  source: "mid_touch" | "tracker" | "analyst_incoherent";
  at: string | null;
  basis: "mid" | "quotes" | null;
  feed: PriceFeed | null;
  bar_closed: boolean | null;
  // For a tracker settlement: whether it landed before the position was
  // opened. Always false for a mid touch, which is measured since the open.
  before_open: boolean | null;
  // What the analyst actually answered, kept beside a verdict the server
  // replaced.
  analyst: { verdict: HeldVerdict | null; thesis_status: ThesisStatus | null } | null;
}

export interface ChangeSide {
  analysis_id: string | null;
  at: string;
  signal: PublishedSignal;
  proposed_signal: PublishedSignal | null;
  rejection: string | null;
  confidence: number | null;
  decided_by: DecidedBy;
  published: boolean;
  analyst_direction: PublishedSignal | null;
}

export interface Change {
  previous: ChangeSide;
  current: ChangeSide;
  // From the two ANALYST directions only. The thesis reading never enters it.
  kind: ChangeKind;
  thesis_of: ReferenceKind | null;
  // The analyst's reading of the thesis named by thesis_of, copied so the
  // sentence can be rebuilt from this object alone. Labelled as the analyst's
  // wherever it is rendered.
  thesis_status: ThesisStatus | null;
  // The gate's own measurement on the analyst's FRESH levels this run
  // (entry_check.risk_reward). Null on a model-chosen WAIT: no fresh plan was
  // measured, and the card says so rather than showing a blank.
  current_gate_rr: number | null;
}

export interface PositionReview {
  version: 1;
  // ok: reference, facts and the analyst's answer; partial: facts present but
  // the analyst's answer is not; skipped: nothing to review (no request was
  // sent); failed: not even the reference or the facts could be produced.
  status: "ok" | "partial" | "skipped" | "failed";
  skipped_reason: "no_reference" | null;
  error: string | null;
  reference: ReferenceSet | null;
  mechanical: MechanicalFacts | null;
  analyst: AnalystReview | null;
  // Derived, for a HELD plan only. Null = not produced (a previous-only
  // review, or nothing to derive it from) — never a stand-in for undecidable.
  verdict: HeldVerdict | null;
  decided_by: "server" | "analyst" | null;
  override_reason: OverrideReason | null;
  override_suppressed: { reason: "settled_before_open" | "registered_after_settlement"; closed_at: string | null } | null;
  change: Change | null;
  at: string;
  elapsed_ms: number | null;
}

// What the concurrent task accumulates. Filled progressively so that a
// timeout after the facts were measured still stores the facts.
export interface ReviewRun {
  status: "ok" | "failed" | "skipped";
  skipped_reason: "no_reference" | null;
  error: string | null;
  reference: ReferenceSet | null;
  mechanical: MechanicalFacts | null;
  analyst: AnalystReview | null;
  request: ReviewRequestRecord | null;
  started_at: string;
  elapsed_ms: number | null;
}

// What was sent, read back off the request object — the analysis_prompts
// discipline, for the same reason (nothing can be replayed from constants).
export interface ReviewRequestRecord {
  system: string;
  user: string;
  model: string;
  effort: string | null;
  max_tokens: number;
  sent_at: string;
}

export const emptyReviewRun = (startedAt: string): ReviewRun => ({
  status: "failed",
  skipped_reason: null,
  error: null,
  reference: null,
  mechanical: null,
  analyst: null,
  request: null,
  started_at: startedAt,
  elapsed_ms: null,
});

// ---------------------------------------------------------------------------
// Reading rows
// ---------------------------------------------------------------------------

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const strings = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
const signalOf = (v: unknown): PublishedSignal | null => (v === "BUY" || v === "SELL" || v === "WAIT" ? v : null);
const feedOf = (v: unknown): PriceFeed | null => (v === "twelve_data" || v === "gmo" ? v : null);

export const decidedBy = (
  signal: PublishedSignal,
  proposed: PublishedSignal | null,
  rejection: string | null,
): DecidedBy => {
  if (signal === "BUY" || signal === "SELL") return "analyst";
  if (proposed === "WAIT") return "analyst";
  if ((proposed === "BUY" || proposed === "SELL") && rejection !== null) return "server";
  return "unknown";
};

// The direction the ANALYST answered, which the published column loses on
// every refused run: proposed_signal when recorded; the published trade
// otherwise (the gate never rewrites to a trade); nothing for a legacy WAIT.
export const analystDirection = (
  signal: PublishedSignal,
  proposed: PublishedSignal | null,
): PublishedSignal | null => proposed ?? (signal === "BUY" || signal === "SELL" ? signal : null);

const outcomeOf = (row: Rec): ReferenceOutcome | null => {
  const outcome = str(row.outcome);
  if (outcome === null) return null;
  const basis = row.price_basis === "mid" || row.price_basis === "quotes" ? row.price_basis : null;
  return { outcome, price_basis: basis, closed_at: str(row.closed_at), outcome_price: num(row.outcome_price) };
};

// The analyses row as the review selects it (see index.ts for the select
// string; `price_basis`, `key_factors`, `snapshot` and `structure` are
// PostgREST JSON-path aliases).
export const readPreviousReference = (raw: unknown): PreviousReference | null => {
  if (!isRec(raw)) return null;
  const id = str(raw.id);
  const at = str(raw.created_at);
  const signal = signalOf(raw.signal);
  if (id === null || at === null || signal === null) return null;
  const check = isRec(raw.entry_check) ? raw.entry_check : null;
  const proposed = check ? signalOf(check.proposed_signal) : null;
  const rejection = check ? str(check.rejection) : null;
  const published = { entry: num(raw.entry_point), stop: num(raw.stop_loss), tp1: num(raw.take_profit_1) };
  const refused = check
    ? { entry: num(check.proposed_entry), stop: num(check.proposed_stop), tp1: num(check.proposed_tp1) }
    : { entry: null, stop: null, tp1: null };
  const levels = signal !== "WAIT" && published.entry !== null && published.stop !== null && published.tp1 !== null
    ? { direction: signal, entry: published.entry, stop: published.stop, tp1: published.tp1, published: true }
    : (proposed === "BUY" || proposed === "SELL") && refused.entry !== null && refused.stop !== null && refused.tp1 !== null
      ? { direction: proposed, entry: refused.entry, stop: refused.stop, tp1: refused.tp1, published: false }
      : null;
  return {
    kind: "previous",
    analysis_id: id,
    at,
    priced_at: str(raw.priced_at),
    interval: str(raw.interval) ?? "",
    signal,
    proposed_signal: proposed,
    rejection,
    confidence: num(raw.confidence),
    decided_by: decidedBy(signal, proposed, rejection),
    analyst_direction: analystDirection(signal, proposed),
    levels,
    thesis: str(raw.thesis),
    key_factors: strings(raw.key_factors),
    feed: check ? feedOf(check.price_feed) : null,
    outcome: outcomeOf(raw),
    snapshot: raw.snapshot ?? null,
    structure: raw.structure ?? null,
  };
};

// A positions row plus the plan row it points at.
export const readHeldReference = (
  positionRaw: unknown,
  planRaw: unknown,
  others: string[],
): HeldReference | null => {
  if (!isRec(positionRaw)) return null;
  const id = str(positionRaw.id);
  const analysisId = str(positionRaw.analysis_id);
  const direction = positionRaw.direction === "BUY" || positionRaw.direction === "SELL" ? positionRaw.direction : null;
  const entry = num(positionRaw.entry_price);
  const stop = num(positionRaw.stop_loss);
  const tp1 = num(positionRaw.take_profit_1);
  const openedAt = str(positionRaw.opened_at);
  if (id === null || analysisId === null || direction === null || entry === null || stop === null || tp1 === null || openedAt === null) {
    return null;
  }
  const plan = isRec(planRaw) ? planRaw : null;
  const check = plan && isRec(plan.entry_check) ? plan.entry_check : null;
  return {
    kind: "held",
    position_id: id,
    analysis_id: analysisId,
    direction,
    entry,
    stop,
    tp1,
    tp2: num(positionRaw.take_profit_2),
    tp3: num(positionRaw.take_profit_3),
    opened_at: openedAt,
    opened_at_source: positionRaw.opened_at_source === "user" || positionRaw.opened_at_source === "registered"
      ? positionRaw.opened_at_source
      : null,
    registered_after_settlement: positionRaw.registered_after_settlement === true,
    interval: str(positionRaw.interval) ?? "",
    confidence: plan ? num(plan.confidence) : null,
    thesis: plan ? str(plan.thesis) : null,
    key_factors: plan ? strings(plan.key_factors) : [],
    feed: check ? feedOf(check.price_feed) : null,
    outcome: plan ? outcomeOf(plan) : null,
    other_open_positions: { count: others.length, ids: [...others] },
    snapshot: plan?.snapshot ?? null,
    structure: plan?.structure ?? null,
  };
};

// ---------------------------------------------------------------------------
// Mechanical facts
// ---------------------------------------------------------------------------

// Twelve Data's "YYYY-MM-DD HH:mm:ss" (UTC, no zone marker) or an ISO string.
export const barTimeMs = (datetime: string): number => {
  if (!datetime) return NaN;
  if (datetime.includes("T")) return Date.parse(datetime);
  const [date, time] = datetime.split(" ");
  return Date.parse(`${date}T${time || "00:00:00"}Z`);
};

const pipFor = (decimals: number): number => (decimals === 3 ? 0.01 : 0.0001);
const round = (v: number, d: number): number => Number(v.toFixed(d));

const touchOf = (
  bars: Candle[],
  direction: Direction,
  level: number,
  side: "stop" | "tp1",
  newestBarClosed: boolean | null,
): { at: string; bar_closed: boolean } | null => {
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    // A BUY is stopped from below and paid from above; a SELL the mirror.
    const touched = side === "stop"
      ? (direction === "BUY" ? b.low <= level : b.high >= level)
      : (direction === "BUY" ? b.high >= level : b.low <= level);
    if (touched) {
      const isNewest = i === bars.length - 1;
      return { at: b.datetime, bar_closed: isNewest ? newestBarClosed !== false : true };
    }
  }
  return null;
};

export const mechanicalFacts = (input: {
  subject: ReferenceKind;
  direction: Direction;
  entry: number;
  stop: number;
  tp1: number;
  anchor: { at: string | null; source: "opened_at" | "priced_at" };
  candles: Candle[];
  newestBarClosed: boolean | null;
  price: number;
  pricedAt: string;
  feed: PriceFeed;
  feedDeltaAtr: number | null;
  decimals: number;
}): MechanicalFacts => {
  const pip = pipFor(input.decimals);
  const sign = input.direction === "BUY" ? 1 : -1;
  const risk = Math.abs(input.entry - input.stop);
  const movePrice = (input.price - input.entry) * sign;
  const toStop = (input.price - input.stop) * sign;
  const toTp1 = (input.tp1 - input.price) * sign;

  const anchorMs = input.anchor.at === null ? NaN : Date.parse(input.anchor.at);
  const dated = input.candles
    .map((c) => ({ c, t: barTimeMs(c.datetime) }))
    .filter((x) => Number.isFinite(x.t));
  // Strictly after the anchor: the bar containing it is excluded (see the
  // field comment on `as_of`).
  const since = Number.isFinite(anchorMs) ? dated.filter((x) => x.t > anchorMs).map((x) => x.c) : [];
  const covers = Number.isFinite(anchorMs) && dated.length > 0 ? dated[0].t <= anchorMs : null;

  const measure = (side: "stop" | "tp1", level: number): LevelTouch => {
    if (!Number.isFinite(anchorMs)) return { measured: false, reason: "no_anchor" };
    if (since.length === 0) return { measured: false, reason: "no_bars_since_anchor" };
    const hit = touchOf(since, input.direction, level, side, input.newestBarClosed);
    // A touch found inside a partially covering series is still a touch.
    if (hit) return { measured: true, touched: true, at: hit.at, bar_closed: hit.bar_closed };
    if (covers === false) return { measured: false, reason: "series_starts_after_anchor" };
    return {
      measured: true,
      touched: false,
      from: since[0].datetime,
      as_of: since[since.length - 1].datetime,
      bars_examined: since.length,
    };
  };

  return {
    subject: input.subject,
    basis: "mid",
    feed: input.feed,
    feed_delta_atr: input.feedDeltaAtr,
    price: input.price,
    priced_at: input.pricedAt,
    direction: input.direction,
    entry: input.entry,
    stop: input.stop,
    tp1: input.tp1,
    risk: risk > 0 ? round(risk, input.decimals) : null,
    move_pips: round(movePrice / pip, 1),
    move_r: risk > 0 ? round(movePrice / risk, 2) : null,
    to_stop_pips: round(toStop / pip, 1),
    to_tp1_pips: round(toTp1 / pip, 1),
    anchor_at: input.anchor.at,
    anchor_source: input.anchor.at === null ? null : input.anchor.source,
    covers_anchor: covers,
    bars_examined: since.length,
    as_of: since.length > 0 ? since[since.length - 1].datetime : null,
    stop_touch: measure("stop", input.stop),
    tp1_touch: measure("tp1", input.tp1),
  };
};

// ---------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------

const VERDICTS: HeldVerdict[] = ["hold", "caution", "exit_condition_met", "undecidable"];
const THESIS: ThesisStatus[] = ["intact", "weakened", "broken", "unknown"];

// Two schemas, not one with a nullable verdict: a previous-only review has no
// verdict slot at all, so the model cannot fill one for a plan nobody holds.
export const REVIEW_SCHEMA_HELD = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: VERDICTS },
    thesis_status: { type: "string", enum: THESIS },
    reasons: { type: "array", items: { type: "string" } },
    what_changed: { type: "array", items: { type: "string" } },
    watch: { type: "string", description: "caution のとき何を見張るか。無ければ空文字。" },
  },
  required: ["verdict", "thesis_status", "reasons", "what_changed", "watch"],
  additionalProperties: false,
} as const;

export const REVIEW_SCHEMA_PREVIOUS = {
  type: "object",
  properties: {
    thesis_status: { type: "string", enum: THESIS },
    reasons: { type: "array", items: { type: "string" } },
    what_changed: { type: "array", items: { type: "string" } },
  },
  required: ["thesis_status", "reasons", "what_changed"],
  additionalProperties: false,
} as const;

interface ReviewStrings {
  systemHeld: string;
  systemPrevious: string;
  user: (parts: {
    pair: string;
    nowUtc: string;
    reference: HeldReference | PreviousReference;
    mechanical: MechanicalFacts | null;
    sections: string;
    decimals: number;
  }) => string;
}

const fmtTouch = (t: LevelTouch, lang: "ja" | "en"): string => {
  if (t.measured === false) {
    const why = lang === "ja"
      ? { no_anchor: "基準時刻なし", series_starts_after_anchor: "系列が基準時刻に届かない", no_bars_since_anchor: "基準時刻以降の足なし" }[t.reason]
      : { no_anchor: "no anchor time", series_starts_after_anchor: "series starts after the anchor", no_bars_since_anchor: "no bars since the anchor" }[t.reason];
    return lang === "ja" ? `未計測（${why}）` : `not measured (${why})`;
  }
  if (t.touched === true) {
    return lang === "ja"
      ? `あり（${t.at} の足${t.bar_closed ? "" : "・形成中"}）`
      : `yes (bar ${t.at}${t.bar_closed ? "" : ", still forming"})`;
  }
  return lang === "ja"
    ? `なし（${t.from} 〜 ${t.as_of} の ${t.bars_examined} 本）`
    : `no (${t.bars_examined} bars, ${t.from} to ${t.as_of})`;
};

const factsBlock = (m: MechanicalFacts | null, lang: "ja" | "en", decimals: number): string => {
  if (!m) return lang === "ja" ? "（水準が無いため計算していない）" : "(no levels, nothing measured)";
  const p = (v: number) => v.toFixed(decimals);
  const feed = m.feed === "gmo" ? "GMO Coin" : "Twelve Data";
  const hypo = m.subject === "previous";
  if (lang === "ja") {
    return [
      `基準の板: 仲値・${feed}${m.feed_delta_atr === null ? "" : `（決定時の GMO との差 ${m.feed_delta_atr} ATR）`}`,
      `現在値: ${p(m.price)}（${m.priced_at}）`,
      `${hypo ? "プランの価格で入っていた場合（仮定値）" : "含み"}: ${m.move_pips} pips${m.move_r === null ? "" : `（${m.move_r}R）`}`,
      `損切りまで: ${m.to_stop_pips} pips ／ TP1まで: ${m.to_tp1_pips} pips（負なら既に越えている）`,
      `損切り接触（${m.anchor_at ?? "基準なし"} より後の足・仲値）: ${fmtTouch(m.stop_touch, "ja")}`,
      `TP1到達（同上）: ${fmtTouch(m.tp1_touch, "ja")}`,
    ].join("\n");
  }
  return [
    `Basis: mid, ${feed}${m.feed_delta_atr === null ? "" : ` (reference sat ${m.feed_delta_atr} ATR from GMO at the decision)`}`,
    `Current price: ${p(m.price)} (${m.priced_at})`,
    `${hypo ? "If filled at the plan's entry (hypothetical)" : "Open P&L"}: ${m.move_pips} pips${m.move_r === null ? "" : ` (${m.move_r}R)`}`,
    `To stop: ${m.to_stop_pips} pips / to TP1: ${m.to_tp1_pips} pips (negative = already beyond)`,
    `Stop touched (bars after ${m.anchor_at ?? "no anchor"}, mid): ${fmtTouch(m.stop_touch, "en")}`,
    `TP1 reached (same window): ${fmtTouch(m.tp1_touch, "en")}`,
  ].join("\n");
};

const outcomeLine = (o: ReferenceOutcome | null, lang: "ja" | "en"): string => {
  if (!o) return "";
  const basis = o.price_basis === "quotes" ? "Bid/Ask" : o.price_basis === "mid" ? (lang === "ja" ? "仲値" : "mid") : (lang === "ja" ? "板の記録なし" : "basis not recorded");
  return lang === "ja"
    ? `\n判定システムの結果（${basis}）: ${o.outcome}${o.closed_at ? `（${o.closed_at}）` : ""}`
    : `\nTracker verdict (${basis}): ${o.outcome}${o.closed_at ? ` (${o.closed_at})` : ""}`;
};

const planBlock = (r: HeldReference | PreviousReference, lang: "ja" | "en", decimals: number): string => {
  const p = (v: number) => v.toFixed(decimals);
  const factors = r.key_factors.length > 0 ? r.key_factors.map((f) => `- ${f}`).join("\n") : (lang === "ja" ? "- （記録なし）" : "- (none recorded)");
  const snap = r.snapshot === null ? (lang === "ja" ? "（記録なし）" : "(not recorded)") : JSON.stringify(r.snapshot);
  const structure = r.structure === null ? (lang === "ja" ? "（記録なし）" : "(not recorded)") : JSON.stringify(r.structure);
  if (r.kind === "held") {
    return lang === "ja"
      ? [
        `方向: ${r.direction} ／ 約定価格: ${p(r.entry)} ／ 損切り: ${p(r.stop)} ／ TP1: ${p(r.tp1)}`,
        `建玉の時刻: ${r.opened_at}（プランの分析足: ${r.interval}）${r.other_open_positions.count > 0 ? `\n同じペアに他 ${r.other_open_positions.count} 件の建玉あり（この評価は最新の 1 件のみ）` : ""}`,
        `元の根拠（thesis）: ${r.thesis ?? "（記録なし）"}`,
        `元の根拠（key_factors）:\n${factors}`,
        `プラン作成時の指標スナップショット: ${snap}`,
        `プラン作成時の構造: ${structure}`,
      ].join("\n")
      : [
        `Direction: ${r.direction} / fill: ${p(r.entry)} / stop: ${p(r.stop)} / TP1: ${p(r.tp1)}`,
        `Opened at: ${r.opened_at} (plan timeframe: ${r.interval})${r.other_open_positions.count > 0 ? `\n${r.other_open_positions.count} other open position(s) on this pair; this review covers the newest only` : ""}`,
        `Original thesis: ${r.thesis ?? "(not recorded)"}`,
        `Original key factors:\n${factors}`,
        `Indicator snapshot when the plan was written: ${snap}`,
        `Structure when the plan was written: ${structure}`,
      ].join("\n");
  }
  const levels = r.levels
    ? (lang === "ja"
      ? `方向: ${r.levels.published ? r.signal : r.proposed_signal} ／ エントリー（当時の現在値）: ${p(r.levels.entry)} ／ 損切り: ${p(r.levels.stop)} ／ TP1: ${p(r.levels.tp1)}${r.levels.published ? "" : `\n注意: この水準は AI が提案し、サーバーが公開を見送ったもの（却下理由: ${r.rejection ?? "不明"}）。公開されたのは WAIT。`}`
      : `Direction: ${r.levels.published ? r.signal : r.proposed_signal} / entry (market price then): ${p(r.levels.entry)} / stop: ${p(r.levels.stop)} / TP1: ${p(r.levels.tp1)}${r.levels.published ? "" : `\nNote: the analyst proposed these levels and the server declined to publish them (rejection: ${r.rejection ?? "unknown"}). What was published was WAIT.`}`)
    : (lang === "ja" ? "前回の判断は WAIT（見送り）で、水準は無い。" : "The previous call was WAIT and named no levels.");
  return lang === "ja"
    ? [
      `判断の時刻: ${r.at}（分析足: ${r.interval}）`,
      levels,
      `当時の根拠（thesis）: ${r.thesis ?? "（記録なし）"}`,
      `当時の根拠（key_factors）:\n${factors}`,
      `当時の指標スナップショット: ${snap}`,
      `当時の構造: ${structure}`,
    ].join("\n")
    : [
      `Decided at: ${r.at} (timeframe: ${r.interval})`,
      levels,
      `Thesis then: ${r.thesis ?? "(not recorded)"}`,
      `Key factors then:\n${factors}`,
      `Indicator snapshot then: ${snap}`,
      `Structure then: ${structure}`,
    ].join("\n");
};

const STRINGS: Record<AnalysisLocale, ReviewStrings> = {
  ja: {
    systemHeld: `あなたは FX の保有ポジション管理を担当するアナリストです。新規エントリーの判断は別のアナリストが別途行っており、あなたには渡されません。あなたの仕事は、ユーザーがすでに保有しているポジションを、そのポジションの「元のプラン」の根拠と水準に照らして評価することだけです。

原則:
- 新規に入るかどうかは判断しない。エントリー価格・損切り・利確を新しく提案しない。元のプランの水準は動かさない。
- 「今から新しく入るのは見送り」は「決済しろ」ではない。保有プランの評価は、保有プランの根拠が今も成り立つかで決める。
- verdict の定義:
  hold（継続）: 根拠が維持され、撤退条件は成立していない
  caution（警戒）: 根拠が弱まった、または不利な事実があるが、撤退条件は成立していない。watch に何を見張るかを書く
  exit_condition_met（撤退条件成立）: プラン自身の損切り水準に到達した、または根拠が拠っていた構造が確定足で崩れた
  undecidable（判定できない）: 材料が足りない、または元の根拠を評価できない
- thesis_status と verdict は矛盾させない。broken なら exit_condition_met。weakened は caution。intact は hold か caution。unknown は undecidable。
- サーバーが計算した事実（含み損益・水準までの距離・接触の有無。いずれも仲値ベース）は事実として引用し、数え直さない。「未計測」は「なし」ではない。
- what_changed には、プラン作成時のスナップショットと今の相場データを比べて、実際に変わったことだけを書く（数値と足を添える）。
- 板情報・出来高・建玉は取得していない。推測は推測と書く。
- 文章は日本語で書く。`,
    systemPrevious: `あなたは FX の「前回の判断」を検証するアナリストです。新規エントリーの判断は別のアナリストが別途行っており、あなたには渡されません。

このプランがユーザーに保有されているかは不明です。建玉として評価せず、建玉があったかのような書き方をしないでください。渡される損益の数値は「プランの価格で入っていたら」の仮定値です。

あなたの仕事は 2 つだけ:
(1) thesis_status — 前回の判断の根拠が今も成り立つか。
  intact（維持）: 根拠は今も成り立っている
  weakened（弱化）: 根拠は残っているが弱まった、または不利な事実が出た
  broken（崩壊）: 根拠が拠っていた構造が確定足で崩れた
  unknown（評価できない）: 材料が足りない
(2) what_changed — 前回のスナップショットと今の相場データを比べて、実際に変わったことだけ（数値と足を添える）。

原則:
- 新規に入るかどうかは判断しない。水準を提案しない。
- サーバーが計算した事実は事実として引用し、数え直さない。「未計測」は「なし」ではない。
- 板情報・出来高・建玉は取得していない。推測は推測と書く。
- 文章は日本語で書く。`,
    user: ({ pair, nowUtc, reference, mechanical, sections, decimals }) =>
      [
        `通貨ペア: ${pair}`,
        `現在時刻(UTC): ${nowUtc}`,
        "",
        reference.kind === "held" ? "## 評価対象: 保有中の建玉（元のプラン）" : "## 評価対象: 前回の判断（保有しているかは不明）",
        planBlock(reference, "ja", decimals),
        "",
        "## サーバーが計算した事実",
        factsBlock(mechanical, "ja", decimals) + outcomeLine(reference.outcome, "ja"),
        "",
        "## 現在の相場データ",
        sections,
        "",
        "上記に基づき、指定の JSON Schema に厳密に従って回答してください。",
      ].join("\n"),
  },
  en: {
    systemHeld: `You are the analyst responsible for managing an FX position the user already holds. A different analyst makes the new-entry call separately, and it is not shown to you. Your only job is to evaluate the held position against ITS OWN original plan: the thesis it was opened on and the levels it was opened with.

Rules:
- Do not decide whether to open a new position. Do not propose a new entry, stop or target. Do not move the original plan's levels.
- "Do not open a new position now" does not mean "close". The held plan is judged on whether its own thesis still holds.
- Verdict definitions:
  hold: the thesis is intact and no exit condition is met
  caution: the thesis has weakened or adverse facts have appeared, but no exit condition is met; name what to watch in the watch field
  exit_condition_met: the plan's own stop level was reached, or the structure the thesis rested on has broken on closed bars
  undecidable: not enough material, or the original thesis cannot be evaluated
- Keep thesis_status and verdict coherent: broken implies exit_condition_met; weakened is the caution case; intact goes with hold or caution; unknown goes with undecidable.
- Quote the server's measured facts (open P&L, distance to levels, touches — all on the mid price) as facts; do not recount them. "Not measured" is not "none".
- In what_changed, list only what actually changed between the snapshot at the plan and the market data now, with numbers and bars.
- This app sees no order book, volume or open interest. Mark inferences as inferences.
- Write in English.`,
    systemPrevious: `You are the analyst who checks the PREVIOUS call. A different analyst makes the new-entry call separately, and it is not shown to you.

Whether the user holds this plan is unknown. Do not evaluate it as a position and do not write as if one existed. Any P&L figures you are given are hypothetical: what a fill at the plan's entry would show.

You have exactly two jobs:
(1) thesis_status — whether the previous call's reasoning still holds.
  intact: it still holds
  weakened: it remains, but weaker, or adverse facts have appeared
  broken: the structure it rested on has broken on closed bars
  unknown: not enough material
(2) what_changed — only what actually changed between the previous snapshot and the market data now, with numbers and bars.

Rules:
- Do not decide whether to open a new position. Do not propose levels.
- Quote the server's measured facts as facts; do not recount them. "Not measured" is not "none".
- This app sees no order book, volume or open interest. Mark inferences as inferences.
- Write in English.`,
    user: ({ pair, nowUtc, reference, mechanical, sections, decimals }) =>
      [
        `Pair: ${pair}`,
        `Now (UTC): ${nowUtc}`,
        "",
        reference.kind === "held" ? "## Subject: the held position (its original plan)" : "## Subject: the previous call (whether it is held is unknown)",
        planBlock(reference, "en", decimals),
        "",
        "## Facts measured by the server",
        factsBlock(mechanical, "en", decimals) + outcomeLine(reference.outcome, "en"),
        "",
        "## Market data now",
        sections,
        "",
        "Answer strictly in the given JSON Schema.",
      ].join("\n"),
  },
};

export interface ReviewRequest {
  model: string;
  max_tokens: number;
  system: string;
  messages: Array<{ role: "user"; content: string }>;
  output_config: { format: { type: "json_schema"; schema: unknown }; effort: string };
}

// A pure function of copied inputs. It never reads the main call's request
// object: that object is rewritten while the review is in flight
// (applyRequestShape) and read back into the analysis_prompts row at save.
export const buildReviewRequest = (input: {
  model: string;
  locale: AnalysisLocale;
  pair: string;
  nowUtc: string;
  reference: HeldReference | PreviousReference;
  mechanical: MechanicalFacts | null;
  sections: string;
  decimals: number;
}): ReviewRequest => {
  const s = STRINGS[input.locale];
  const held = input.reference.kind === "held";
  return {
    model: input.model,
    max_tokens: REVIEW_MAX_TOKENS,
    system: held ? s.systemHeld : s.systemPrevious,
    messages: [{
      role: "user",
      content: s.user({
        pair: input.pair,
        nowUtc: input.nowUtc,
        reference: input.reference,
        mechanical: input.mechanical,
        sections: input.sections,
        decimals: input.decimals,
      }),
    }],
    output_config: {
      format: { type: "json_schema", schema: held ? REVIEW_SCHEMA_HELD : REVIEW_SCHEMA_PREVIOUS },
      effort: REVIEW_EFFORT,
    },
  };
};

export const recordRequest = (req: ReviewRequest, sentAt: string): ReviewRequestRecord => ({
  system: req.system,
  user: req.messages[0]?.content ?? "",
  model: req.model,
  effort: typeof req.output_config?.effort === "string" ? req.output_config.effort : null,
  max_tokens: req.max_tokens,
  sent_at: sentAt,
});

// The model's answer as written. A missing or malformed field is a failed
// answer, not a defaulted one.
export const parseReviewAnswer = (
  parsed: unknown,
  kind: ReferenceKind,
): { ok: true; verdict: HeldVerdict | null; thesis_status: ThesisStatus; reasons: string[]; what_changed: string[]; watch: string | null }
  | { ok: false; error: string } => {
  if (!isRec(parsed)) return { ok: false, error: "not_an_object" };
  const thesis = THESIS.includes(parsed.thesis_status as ThesisStatus) ? parsed.thesis_status as ThesisStatus : null;
  if (thesis === null) return { ok: false, error: "thesis_status_missing" };
  let verdict: HeldVerdict | null = null;
  if (kind === "held") {
    if (!VERDICTS.includes(parsed.verdict as HeldVerdict)) return { ok: false, error: "verdict_missing" };
    verdict = parsed.verdict as HeldVerdict;
  }
  const watch = typeof parsed.watch === "string" && parsed.watch.trim().length > 0 ? parsed.watch.trim() : null;
  return {
    ok: true,
    verdict,
    thesis_status: thesis,
    reasons: strings(parsed.reasons),
    what_changed: strings(parsed.what_changed),
    watch,
  };
};

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

const INCOHERENT: Array<[HeldVerdict, ThesisStatus]> = [
  ["hold", "weakened"],
  ["hold", "broken"],
  ["caution", "broken"],
];

export const sideOf = (input: {
  analysis_id: string | null;
  at: string;
  signal: PublishedSignal;
  proposed_signal: PublishedSignal | null;
  rejection: string | null;
  confidence: number | null;
}): ChangeSide => ({
  analysis_id: input.analysis_id,
  at: input.at,
  signal: input.signal,
  proposed_signal: input.proposed_signal,
  rejection: input.rejection,
  confidence: input.confidence,
  decided_by: decidedBy(input.signal, input.proposed_signal, input.rejection),
  published: input.signal !== "WAIT",
  analyst_direction: analystDirection(input.signal, input.proposed_signal),
});

export const classifyChange = (previous: ChangeSide, current: ChangeSide): ChangeKind => {
  const p = previous.analyst_direction;
  const c = current.analyst_direction;
  if (p === null || c === null) return "unclear";
  if (p === c) return "same_call";
  if (p === "WAIT") return "wait_to_trade";
  if (c === "WAIT") return "trade_to_wait";
  return "reversed";
};

export interface CurrentSide {
  signal: PublishedSignal;
  proposed_signal: PublishedSignal | null;
  rejection: string | null;
  confidence: number | null;
  gate_rr: number | null;
  at: string;
}

// The server's verdict for a HELD plan, beside the analyst's. A measured fact
// outranks the analyst; an analyst who contradicts itself is not relayed; a
// missing analyst is null, not undecidable.
export const finalizeReview = (run: ReviewRun, current: CurrentSide): PositionReview => {
  const ref = run.reference;
  const held = ref?.held ?? null;
  const analyst = run.analyst;
  const mech = run.mechanical;

  let verdict: HeldVerdict | null = null;
  let decidedBy: "server" | "analyst" | null = null;
  let override: OverrideReason | null = null;
  let suppressed: PositionReview["override_suppressed"] = null;

  if (held !== null) {
    const analystSaid = analyst?.status === "ok"
      ? { verdict: analyst.verdict, thesis_status: analyst.thesis_status }
      : null;
    const midTouch = mech && mech.subject === "held" && mech.stop_touch.measured && mech.stop_touch.touched ? mech.stop_touch : null;
    const settled = held.outcome && held.outcome.outcome === "loss" ? held.outcome : null;
    if (midTouch) {
      verdict = "exit_condition_met";
      decidedBy = "server";
      override = {
        source: "mid_touch",
        at: midTouch.at,
        basis: "mid",
        feed: mech?.feed ?? null,
        bar_closed: midTouch.bar_closed,
        before_open: false,
        analyst: analystSaid,
      };
    } else if (settled) {
      const closedMs = settled.closed_at === null ? NaN : Date.parse(settled.closed_at);
      const openedMs = Date.parse(held.opened_at);
      if (held.registered_after_settlement) {
        suppressed = { reason: "registered_after_settlement", closed_at: settled.closed_at };
      } else if (Number.isFinite(closedMs) && Number.isFinite(openedMs) && closedMs < openedMs) {
        suppressed = { reason: "settled_before_open", closed_at: settled.closed_at };
      } else {
        verdict = "exit_condition_met";
        decidedBy = "server";
        override = {
          source: "tracker",
          at: settled.closed_at,
          basis: settled.price_basis,
          feed: null,
          bar_closed: null,
          before_open: Number.isFinite(closedMs) && Number.isFinite(openedMs) ? closedMs < openedMs : null,
          analyst: analystSaid,
        };
      }
    }
    if (verdict === null && analystSaid && analystSaid.verdict !== null) {
      const incoherent = INCOHERENT.some(([v, t]) => v === analystSaid.verdict && t === analystSaid.thesis_status);
      if (incoherent) {
        verdict = "undecidable";
        decidedBy = "server";
        override = {
          source: "analyst_incoherent",
          at: null,
          basis: null,
          feed: null,
          bar_closed: null,
          before_open: null,
          analyst: analystSaid,
        };
      } else {
        verdict = analystSaid.verdict;
        decidedBy = "analyst";
      }
    }
  }

  const change: Change | null = ref?.previous
    ? (() => {
      const prev = ref.previous;
      const previous = sideOf({
        analysis_id: prev.analysis_id,
        at: prev.at,
        signal: prev.signal,
        proposed_signal: prev.proposed_signal,
        rejection: prev.rejection,
        confidence: prev.confidence,
      });
      const cur = sideOf({
        analysis_id: null,
        at: current.at,
        signal: current.signal,
        proposed_signal: current.proposed_signal,
        rejection: current.rejection,
        confidence: current.confidence,
      });
      return {
        previous,
        current: cur,
        kind: classifyChange(previous, cur),
        thesis_of: ref.thesis_of,
        thesis_status: analyst?.status === "ok" ? analyst.thesis_status : null,
        current_gate_rr: current.gate_rr,
      };
    })()
    : null;

  // Facts are owed whenever the thesis reference has levels to measure
  // against: always for a held plan, and for a previous plan that named any.
  const factsOwed = held !== null || (ref?.previous?.levels ?? null) !== null;
  const status: PositionReview["status"] = run.status === "skipped"
    ? "skipped"
    : ref === null || (factsOwed && mech === null)
      ? "failed"
      : analyst?.status === "ok"
        ? "ok"
        : "partial";

  return {
    version: 1,
    status,
    skipped_reason: run.skipped_reason,
    error: run.error,
    reference: ref,
    mechanical: mech,
    analyst,
    verdict,
    decided_by: decidedBy,
    override_reason: override,
    override_suppressed: suppressed,
    change,
    at: current.at,
    elapsed_ms: run.elapsed_ms,
  };
};
