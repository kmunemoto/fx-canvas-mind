import type { AnalysisRecord, Position, PositionReview } from "./types";

// Held positions on the client: reading the rows, calling the two RPCs that
// write them, and the small pure helpers the cards share.
//
// The reader's own rows only (RLS). Writes go through register_position and
// close_position — SECURITY DEFINER functions that validate the plan and own
// the row — so nothing here builds an INSERT.

const num = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

export const normalizePosition = (raw: unknown): Position | null => {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const entry = num(r.entry_price);
  const stop = num(r.stop_loss);
  const tp1 = num(r.take_profit_1);
  if (
    typeof r.id !== "string" || typeof r.analysis_id !== "string" || typeof r.pair !== "string" ||
    (r.direction !== "BUY" && r.direction !== "SELL") || entry === null || stop === null || tp1 === null ||
    typeof r.opened_at !== "string"
  ) {
    return null;
  }
  return {
    id: r.id,
    analysis_id: r.analysis_id,
    pair: r.pair,
    interval: typeof r.interval === "string" ? r.interval : "",
    direction: r.direction,
    entry_price: entry,
    stop_loss: stop,
    take_profit_1: tp1,
    take_profit_2: num(r.take_profit_2),
    take_profit_3: num(r.take_profit_3),
    opened_at: r.opened_at,
    opened_at_source: r.opened_at_source === "user" || r.opened_at_source === "registered" ? r.opened_at_source : null,
    registered_after_settlement: r.registered_after_settlement === true,
    status: r.status === "closed" ? "closed" : "open",
    closed_at: typeof r.closed_at === "string" ? r.closed_at : null,
    close_price: num(r.close_price),
    close_reason: r.close_reason === "manual" || r.close_reason === "stop" || r.close_reason === "target" || r.close_reason === "other"
      ? r.close_reason
      : null,
    created_at: typeof r.created_at === "string" ? r.created_at : "",
  };
};

export const normalizePositions = (raw: unknown): Position[] =>
  Array.isArray(raw) ? raw.map(normalizePosition).filter((p): p is Position => p !== null) : [];

// The RPC's named errors, so the form can say which check refused rather
// than showing a Postgres message. Anything else is "generic".
export const REGISTER_ERRORS = [
  "not_signed_in",
  "entry_price_must_be_positive",
  "analysis_not_found",
  "plan_is_not_a_trade",
  "plan_is_a_preview",
  "plan_is_a_shadow",
  "plan_has_no_levels",
  "fill_outside_plan",
  "opened_before_plan",
  "opened_in_future",
  "position_not_open",
  "close_price_must_be_positive",
  "close_reason_invalid",
] as const;
export type RegisterError = (typeof REGISTER_ERRORS)[number] | "generic";

export const registerErrorOf = (message: string | null | undefined): RegisterError => {
  if (typeof message !== "string") return "generic";
  const hit = REGISTER_ERRORS.find((e) => message.includes(e));
  return hit ?? "generic";
};

// What the strip shows under a position: the newest review row that judged
// it, or a labelled absence. The history page is the last forty rows, so
// "no verdict" is conclusive only when every same-pair row since the
// registration is inside that page — otherwise the strip says how many rows
// it looked at rather than presenting a gap as a fact.
export interface LatestVerdict {
  kind: "found";
  record: AnalysisRecord;
  review: PositionReview;
}
export interface NoVerdict {
  kind: "none";
  // True when the page reaches back to the registration, so the absence is
  // a fact about the record and not about the page.
  conclusive: boolean;
  examined: number;
}

export const latestVerdictFor = (
  position: Position,
  history: AnalysisRecord[],
): LatestVerdict | NoVerdict => {
  const rows = history.filter((r) => r.shadow !== true);
  const sorted = [...rows].sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
  for (const record of sorted) {
    const review = record.position_review;
    if (review && review.reference?.held?.position_id === position.id) {
      return { kind: "found", record, review };
    }
  }
  const oldest = sorted.length > 0 ? sorted[sorted.length - 1].created_at : null;
  const conclusive = oldest !== null && oldest <= position.created_at;
  return { kind: "none", conclusive, examined: sorted.length };
};

// The word the card shows for a review. Null verdict (not produced) renders
// as "undecidable" on screen, but the two are kept apart in the data.
export const displayVerdict = (review: PositionReview | null): "hold" | "caution" | "exit_condition_met" | "undecidable" =>
  review?.verdict ?? "undecidable";

export const isTradeSignal = (s: string | null | undefined): s is "BUY" | "SELL" => s === "BUY" || s === "SELL";
