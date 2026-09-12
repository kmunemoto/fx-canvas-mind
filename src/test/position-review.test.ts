import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  REVIEW_EFFORT,
  REVIEW_MAX_TOKENS,
  REVIEW_SCHEMA_HELD,
  REVIEW_SCHEMA_PREVIOUS,
  analystDirection,
  buildReviewRequest,
  classifyChange,
  decidedBy,
  emptyReviewRun,
  finalizeReview,
  mechanicalFacts,
  parseReviewAnswer,
  readHeldReference,
  readPreviousReference,
  recordRequest,
  sideOf,
  type HeldReference,
  type MechanicalFacts,
  type PreviousReference,
  type ReviewRun,
} from "../../supabase/functions/analyze/review";
import type { Candle } from "../../supabase/functions/analyze/indicators";
import { isRejected, isSelfDeclined } from "../lib/outcomeStats";
import type { AnalysisRecord } from "../lib/types";

// The held-position review (#89). Three principles from the owner, each
// pinned below by the test that would fail if it were broken:
//   WAIT から自動的に「継続」を導かない       — the verdict comes from facts and a
//                                             separate answer, never the signal
//   元のプランを残し、勝手に上書きしない       — nothing here writes to a reference
//   新規の条件の悪化と、前の根拠の崩壊を区別 — kind from the analyst's direction,
//                                             thesis as its own labelled field

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const bar = (datetime: string, o: number, h: number, l: number, c: number): Candle => ({ datetime, open: o, high: h, low: l, close: c });

// Hourly bars, oldest first, from 00:00 on 2026-09-12.
const hourly = (points: Array<[number, number, number, number]>, from = "2026-09-12 00:00:00"): Candle[] => {
  const start = Date.parse(from.replace(" ", "T") + "Z");
  return points.map(([o, h, l, c], i) => {
    const t = new Date(start + i * 3_600_000).toISOString().slice(0, 19).replace("T", " ");
    return bar(t, o, h, l, c);
  });
};

const held = (over: Partial<HeldReference> = {}): HeldReference => ({
  kind: "held",
  position_id: "pos-1",
  analysis_id: "a-1",
  direction: "SELL",
  entry: 150.12,
  stop: 150.6,
  tp1: 149.4,
  tp2: null,
  tp3: null,
  opened_at: "2026-09-12T03:00:00Z",
  opened_at_source: "user",
  registered_after_settlement: false,
  interval: "1h",
  confidence: 72,
  thesis: "戻り売り",
  key_factors: ["上位足が下向き"],
  feed: "gmo",
  outcome: null,
  other_open_positions: { count: 0, ids: [] },
  snapshot: { rsi: 40 },
  structure: null,
  ...over,
});

const previous = (over: Partial<PreviousReference> = {}): PreviousReference => ({
  kind: "previous",
  analysis_id: "a-0",
  at: "2026-09-12T02:00:00Z",
  priced_at: "2026-09-12T02:00:05Z",
  interval: "1h",
  signal: "SELL",
  proposed_signal: "SELL",
  rejection: null,
  confidence: 72,
  decided_by: "analyst",
  analyst_direction: "SELL",
  levels: { direction: "SELL", entry: 150.12, stop: 150.6, tp1: 149.4, published: true },
  thesis: "戻り売り",
  key_factors: [],
  feed: "gmo",
  outcome: null,
  snapshot: null,
  structure: null,
  ...over,
});

const facts = (over: Partial<MechanicalFacts> = {}): MechanicalFacts => ({
  subject: "held",
  basis: "mid",
  feed: "gmo",
  feed_delta_atr: 0,
  price: 150.3,
  priced_at: "2026-09-12T10:00:00Z",
  direction: "SELL",
  entry: 150.12,
  stop: 150.6,
  tp1: 149.4,
  risk: 0.48,
  move_pips: -18,
  move_r: -0.38,
  to_stop_pips: 30,
  to_tp1_pips: 90,
  anchor_at: "2026-09-12T03:00:00Z",
  anchor_source: "opened_at",
  covers_anchor: true,
  bars_examined: 6,
  as_of: "2026-09-12 09:00:00",
  stop_touch: { measured: true, touched: false, from: "2026-09-12 04:00:00", as_of: "2026-09-12 09:00:00", bars_examined: 6 },
  tp1_touch: { measured: true, touched: false, from: "2026-09-12 04:00:00", as_of: "2026-09-12 09:00:00", bars_examined: 6 },
  ...over,
});

const run = (over: Partial<ReviewRun> = {}): ReviewRun => ({
  ...emptyReviewRun("2026-09-12T10:00:00Z"),
  status: "ok",
  reference: { held: held(), held_reason: null, previous: null, previous_reason: "none_within_window", thesis_of: "held" },
  mechanical: facts(),
  analyst: {
    status: "ok",
    verdict: "hold",
    thesis_status: "intact",
    reasons: ["根拠は維持"],
    what_changed: ["RSI 40 → 45"],
    watch: null,
    model: "m",
    effort: "medium",
    max_tokens: 2000,
    error: null,
    elapsed_ms: 1200,
  },
  request: null,
  elapsed_ms: 1300,
  ...over,
});

const current = (over: Partial<Parameters<typeof finalizeReview>[1]> = {}) => ({
  signal: "WAIT" as const,
  proposed_signal: "WAIT" as const,
  rejection: "low_confidence",
  confidence: 55,
  gate_rr: null,
  at: "2026-09-12T10:00:00Z",
  ...over,
});

// ---------------------------------------------------------------------------
// who decided, and which way the analyst pointed
// ---------------------------------------------------------------------------

describe("decidedBy agrees with the client's isRejected / isSelfDeclined", () => {
  // The same rule in two places, checked behaviourally: a WAIT the gate
  // wrote over a proposed trade is the server's, a WAIT the analyst itself
  // proposed is the analyst's, and a WAIT with no proposed_signal is nobody's.
  const record = (signal: "BUY" | "SELL" | "WAIT", proposed: "BUY" | "SELL" | "WAIT" | null, rejection: string | null): AnalysisRecord =>
    ({
      id: "x", pair: "USD/JPY", interval: "1h", mode: "full", signal, confidence: 60, thesis: null,
      entry_point: null, stop_loss: null, take_profit_1: null, take_profit_2: null, take_profit_3: null,
      price_at_signal: null, outcome: "skipped", outcome_price: null, created_at: "2026-09-12T00:00:00Z",
      closed_at: null, evaluation: null, plan_contract: "market_v1",
      entry_check: proposed === null ? null : ({ proposed_signal: proposed, rejection } as never),
    }) as AnalysisRecord;

  const cases: Array<["BUY" | "SELL" | "WAIT", "BUY" | "SELL" | "WAIT" | null, string | null]> = [
    ["SELL", "SELL", null],
    ["WAIT", "SELL", "poor_rr"],
    ["WAIT", "WAIT", "low_confidence"],
    ["WAIT", "WAIT", null],
    ["WAIT", null, "low_confidence"],
    ["WAIT", null, null],
    ["WAIT", "BUY", null],
  ];
  it.each(cases)("signal=%s proposed=%s rejection=%s", (signal, proposed, rejection) => {
    const r = record(signal, proposed, rejection);
    const who = decidedBy(signal, proposed, rejection);
    if (isRejected(r)) expect(who).toBe("server");
    else if (isSelfDeclined(r)) expect(who).toBe("analyst");
    else if (signal !== "WAIT") expect(who).toBe("analyst");
    else expect(who).toBe("unknown");
  });

  it("takes the analyst's direction from proposed_signal, and never guesses on a legacy WAIT", () => {
    expect(analystDirection("WAIT", "SELL")).toBe("SELL");
    expect(analystDirection("WAIT", "WAIT")).toBe("WAIT");
    expect(analystDirection("SELL", null)).toBe("SELL");
    expect(analystDirection("WAIT", null)).toBeNull();
  });
});

describe("classifyChange", () => {
  const side = (signal: "BUY" | "SELL" | "WAIT", proposed: "BUY" | "SELL" | "WAIT" | null, rejection: string | null = null) =>
    sideOf({ analysis_id: null, at: "t", signal, proposed_signal: proposed, rejection, confidence: null });

  it("classifies on the analyst's direction, not the published column", () => {
    // prev SELL published; now the analyst proposed BUY and the gate refused
    // it: the published column says SELL -> WAIT, the analyst reversed.
    expect(classifyChange(side("SELL", "SELL"), side("WAIT", "BUY", "poor_rr"))).toBe("reversed");
    // prev refused SELL (published WAIT); now SELL published: the same call
    // both times, the first one unpublished.
    const prev = side("WAIT", "SELL", "poor_rr");
    expect(classifyChange(prev, side("SELL", "SELL"))).toBe("same_call");
    expect(prev.published).toBe(false);
    expect(prev.decided_by).toBe("server");
  });

  it("names every move and refuses to guess", () => {
    expect(classifyChange(side("SELL", "SELL"), side("WAIT", "WAIT", "low_confidence"))).toBe("trade_to_wait");
    expect(classifyChange(side("WAIT", "WAIT"), side("BUY", "BUY"))).toBe("wait_to_trade");
    expect(classifyChange(side("WAIT", "WAIT"), side("WAIT", "WAIT"))).toBe("same_call");
    expect(classifyChange(side("SELL", "SELL"), side("SELL", "SELL"))).toBe("same_call");
    expect(classifyChange(side("WAIT", null), side("SELL", "SELL"))).toBe("unclear");
  });
});

// ---------------------------------------------------------------------------
// reading the rows
// ---------------------------------------------------------------------------

describe("readPreviousReference", () => {
  it("keeps a refused plan's levels, labelled as unpublished, with the proposed direction", () => {
    const ref = readPreviousReference({
      id: "a", created_at: "t", signal: "WAIT", confidence: 66,
      entry_point: null, stop_loss: null, take_profit_1: null,
      entry_check: { proposed_signal: "SELL", rejection: "poor_rr", proposed_entry: 150.1, proposed_stop: 150.5, proposed_tp1: 149.7, price_feed: "gmo" },
      outcome: "skipped", price_basis: null,
    });
    expect(ref?.levels).toEqual({ direction: "SELL", entry: 150.1, stop: 150.5, tp1: 149.7, published: false });
    expect(ref?.decided_by).toBe("server");
    expect(ref?.analyst_direction).toBe("SELL");
    expect(ref?.feed).toBe("gmo");
  });

  it("reads a self-declined WAIT as having no levels, and does not invent a basis", () => {
    const ref = readPreviousReference({
      id: "a", created_at: "t", signal: "WAIT", entry_check: { proposed_signal: "WAIT", rejection: "low_confidence" },
      outcome: "skipped",
    });
    expect(ref?.levels).toBeNull();
    expect(ref?.decided_by).toBe("analyst");
    expect(ref?.outcome).toEqual({ outcome: "skipped", price_basis: null, closed_at: null, outcome_price: null });
  });

  it("reads the tracker's basis off the aliased column, quotes or mid", () => {
    const ref = readPreviousReference({
      id: "a", created_at: "t", signal: "SELL", entry_point: 150.1, stop_loss: 150.5, take_profit_1: 149.7,
      outcome: "loss", price_basis: "quotes", closed_at: "2026-09-12T05:00:00Z", outcome_price: 150.5,
    });
    expect(ref?.outcome?.price_basis).toBe("quotes");
    expect(ref?.levels?.published).toBe(true);
  });

  it("returns null rather than a half-read reference", () => {
    expect(readPreviousReference({ id: "a" })).toBeNull();
    expect(readPreviousReference(null)).toBeNull();
  });
});

describe("readHeldReference", () => {
  const row = {
    id: "p", analysis_id: "a", direction: "BUY", entry_price: "150.100", stop_loss: "149.700", take_profit_1: "150.700",
    take_profit_2: null, take_profit_3: null, opened_at: "2026-09-12T03:00:00Z", opened_at_source: "registered",
    registered_after_settlement: true, interval: "4h",
  };
  it("joins the position with its plan row and counts the other open positions", () => {
    const ref = readHeldReference(row, { thesis: "押し目買い", key_factors: ["a", "b"], confidence: 70, outcome: "pending", entry_check: { price_feed: "twelve_data" } }, ["q", "r"]);
    expect(ref?.entry).toBe(150.1);
    expect(ref?.thesis).toBe("押し目買い");
    expect(ref?.key_factors).toEqual(["a", "b"]);
    expect(ref?.feed).toBe("twelve_data");
    expect(ref?.opened_at_source).toBe("registered");
    expect(ref?.registered_after_settlement).toBe(true);
    expect(ref?.other_open_positions).toEqual({ count: 2, ids: ["q", "r"] });
  });

  it("still returns the position when the plan row is missing — the facts are computable without it", () => {
    const ref = readHeldReference(row, null, []);
    expect(ref).not.toBeNull();
    expect(ref?.thesis).toBeNull();
    expect(ref?.feed).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// the measured facts
// ---------------------------------------------------------------------------

describe("mechanicalFacts", () => {
  const base = {
    subject: "held" as const,
    price: 150.3,
    pricedAt: "2026-09-12T10:00:00Z",
    feed: "gmo" as const,
    feedDeltaAtr: null,
    decimals: 3,
    newestBarClosed: true,
  };

  it("signs the move and the distances by direction, in pips and R", () => {
    const sell = mechanicalFacts({
      ...base, direction: "SELL", entry: 150.12, stop: 150.6, tp1: 149.4,
      anchor: { at: "2026-09-12T03:00:00Z", source: "opened_at" }, candles: [],
    });
    expect(sell.move_pips).toBe(-18);
    expect(sell.move_r).toBe(-0.38);
    expect(sell.to_stop_pips).toBe(30);
    expect(sell.to_tp1_pips).toBe(90);
    const buy = mechanicalFacts({
      ...base, direction: "BUY", entry: 150.12, stop: 149.7, tp1: 150.8,
      anchor: { at: "2026-09-12T03:00:00Z", source: "opened_at" }, candles: [],
    });
    expect(buy.move_pips).toBe(18);
    expect(buy.to_stop_pips).toBe(60);
    expect(buy.to_tp1_pips).toBe(50);
    expect(buy.risk).toBe(0.42);
  });

  it("finds a stop touch on the bars AFTER the anchor and names the bar", () => {
    // Anchor 03:00; the 03:00 bar contains it and is excluded; the 05:00 bar
    // trades up through the SELL stop.
    const candles = hourly([
      [150.1, 150.2, 150.0, 150.1],
      [150.1, 150.2, 150.0, 150.1],
      [150.1, 150.2, 150.0, 150.1],
      [150.1, 150.9, 150.0, 150.1], // 03:00 — the anchor bar, excluded even though it reaches the stop
      [150.1, 150.3, 150.0, 150.2],
      [150.2, 150.65, 150.1, 150.5], // 05:00 — touch
      [150.5, 150.7, 150.4, 150.6],
    ]);
    const f = mechanicalFacts({
      ...base, direction: "SELL", entry: 150.12, stop: 150.6, tp1: 149.4,
      anchor: { at: "2026-09-12T03:00:00Z", source: "opened_at" }, candles,
    });
    expect(f.covers_anchor).toBe(true);
    expect(f.bars_examined).toBe(3);
    expect(f.stop_touch).toEqual({ measured: true, touched: true, at: "2026-09-12 05:00:00", bar_closed: true });
    expect(f.tp1_touch).toMatchObject({ measured: true, touched: false, from: "2026-09-12 04:00:00", as_of: "2026-09-12 06:00:00", bars_examined: 3 });
  });

  it("marks a touch on a still-forming newest bar as such", () => {
    const candles = hourly([
      [150.1, 150.2, 150.0, 150.1],
      [150.1, 150.2, 150.0, 150.1],
      [150.1, 150.65, 150.0, 150.5],
    ], "2026-09-12 03:00:00");
    const f = mechanicalFacts({
      ...base, newestBarClosed: false, direction: "SELL", entry: 150.12, stop: 150.6, tp1: 149.4,
      anchor: { at: "2026-09-12T03:00:00Z", source: "opened_at" }, candles,
    });
    expect(f.stop_touch).toEqual({ measured: true, touched: true, at: "2026-09-12 05:00:00", bar_closed: false });
  });

  it("never reports 'no touch' on a series that does not reach the anchor, but never hides a touch either", () => {
    const late = hourly([
      [150.1, 150.2, 150.0, 150.1],
      [150.1, 150.2, 150.0, 150.1],
    ], "2026-09-12 08:00:00");
    const noTouch = mechanicalFacts({
      ...base, direction: "SELL", entry: 150.12, stop: 150.6, tp1: 149.4,
      anchor: { at: "2026-09-12T03:00:00Z", source: "opened_at" }, candles: late,
    });
    expect(noTouch.covers_anchor).toBe(false);
    expect(noTouch.stop_touch).toEqual({ measured: false, reason: "series_starts_after_anchor" });
    const lateTouch = hourly([[150.1, 150.7, 150.0, 150.1]], "2026-09-12 08:00:00");
    const touched = mechanicalFacts({
      ...base, direction: "SELL", entry: 150.12, stop: 150.6, tp1: 149.4,
      anchor: { at: "2026-09-12T03:00:00Z", source: "opened_at" }, candles: lateTouch,
    });
    expect(touched.stop_touch).toMatchObject({ measured: true, touched: true });
    expect(touched.covers_anchor).toBe(false);
  });

  it("says why nothing was measured", () => {
    const candles = hourly([[150.1, 150.2, 150.0, 150.1]], "2026-09-12 00:00:00");
    expect(mechanicalFacts({
      ...base, direction: "SELL", entry: 150.12, stop: 150.6, tp1: 149.4,
      anchor: { at: null, source: "priced_at" }, candles,
    }).stop_touch).toEqual({ measured: false, reason: "no_anchor" });
    expect(mechanicalFacts({
      ...base, direction: "SELL", entry: 150.12, stop: 150.6, tp1: 149.4,
      anchor: { at: "2026-09-12T00:30:00Z", source: "opened_at" }, candles,
    }).stop_touch).toEqual({ measured: false, reason: "no_bars_since_anchor" });
  });

  it("records the feed and its delta, and a null delta stays null", () => {
    const f = mechanicalFacts({
      ...base, feed: "twelve_data", feedDeltaAtr: 0.12, direction: "BUY", entry: 150, stop: 149.5, tp1: 151,
      anchor: { at: null, source: "priced_at" }, candles: [],
    });
    expect(f.feed).toBe("twelve_data");
    expect(f.feed_delta_atr).toBe(0.12);
    expect(f.basis).toBe("mid");
  });
});

// ---------------------------------------------------------------------------
// the request
// ---------------------------------------------------------------------------

describe("buildReviewRequest", () => {
  const common = { model: "m", pair: "USD/JPY", nowUtc: "2026-09-12T10:00:00Z", sections: "### 1h\n...", decimals: 3 };

  it("asks for a verdict only when a plan is HELD, and never searches", () => {
    const heldReq = buildReviewRequest({ ...common, locale: "ja", reference: held(), mechanical: facts() });
    expect(heldReq.output_config.format.schema).toBe(REVIEW_SCHEMA_HELD);
    expect(heldReq.max_tokens).toBe(REVIEW_MAX_TOKENS);
    expect(heldReq.output_config.effort).toBe(REVIEW_EFFORT);
    expect("tools" in heldReq).toBe(false);
    expect(heldReq.system).toContain("保有ポジション");
    expect(heldReq.system).toContain("「決済しろ」ではない");
    expect(heldReq.messages[0].content).toContain("含み");

    const prevReq = buildReviewRequest({ ...common, locale: "ja", reference: previous(), mechanical: facts({ subject: "previous" }) });
    expect(prevReq.output_config.format.schema).toBe(REVIEW_SCHEMA_PREVIOUS);
    expect((REVIEW_SCHEMA_PREVIOUS.properties as Record<string, unknown>).verdict).toBeUndefined();
    expect(prevReq.system).toContain("保有されているかは不明");
    expect(prevReq.messages[0].content).toContain("仮定値");
    expect(prevReq.messages[0].content).not.toContain("含み:");
  });

  it("tells the analyst a refused plan was refused, and a WAIT had no levels", () => {
    const refused = buildReviewRequest({
      ...common, locale: "ja",
      reference: previous({ signal: "WAIT", proposed_signal: "SELL", rejection: "poor_rr", decided_by: "server", levels: { direction: "SELL", entry: 150.1, stop: 150.5, tp1: 149.7, published: false } }),
      mechanical: facts({ subject: "previous" }),
    });
    expect(refused.messages[0].content).toContain("サーバーが公開を見送った");
    expect(refused.messages[0].content).toContain("poor_rr");
    const wait = buildReviewRequest({ ...common, locale: "ja", reference: previous({ signal: "WAIT", proposed_signal: "WAIT", analyst_direction: "WAIT", levels: null }), mechanical: null });
    expect(wait.messages[0].content).toContain("水準は無い");
    expect(wait.messages[0].content).toContain("計算していない");
  });

  it("renders 'not measured' as not measured, in both languages", () => {
    const m = facts({ stop_touch: { measured: false, reason: "series_starts_after_anchor" } });
    const ja = buildReviewRequest({ ...common, locale: "ja", reference: held(), mechanical: m });
    expect(ja.messages[0].content).toContain("未計測（系列が基準時刻に届かない）");
    const en = buildReviewRequest({ ...common, locale: "en", reference: held(), mechanical: m });
    expect(en.messages[0].content).toContain("not measured (series starts after the anchor)");
    expect(en.system).toContain("does not mean \"close\"");
    expect(/[ぁ-んァ-ヶ一-龠]/.test(en.system)).toBe(false);
  });

  it("records what was sent off the request object", () => {
    const req = buildReviewRequest({ ...common, locale: "ja", reference: held(), mechanical: facts() });
    const rec = recordRequest(req, "2026-09-12T10:00:01Z");
    expect(rec).toEqual({
      system: req.system, user: req.messages[0].content, model: "m", effort: REVIEW_EFFORT, max_tokens: REVIEW_MAX_TOKENS, sent_at: "2026-09-12T10:00:01Z",
    });
  });
});

describe("parseReviewAnswer", () => {
  it("requires a verdict for a held plan and ignores one for a previous plan", () => {
    expect(parseReviewAnswer({ thesis_status: "intact", reasons: [], what_changed: [] }, "held")).toEqual({ ok: false, error: "verdict_missing" });
    const prev = parseReviewAnswer({ verdict: "hold", thesis_status: "intact", reasons: ["a"], what_changed: [] }, "previous");
    expect(prev).toMatchObject({ ok: true, verdict: null, thesis_status: "intact", reasons: ["a"] });
  });

  it("does not default a missing thesis, and turns an empty watch into null", () => {
    expect(parseReviewAnswer({ verdict: "hold", reasons: [] }, "held")).toEqual({ ok: false, error: "thesis_status_missing" });
    expect(parseReviewAnswer({ verdict: "caution", thesis_status: "weakened", reasons: [], what_changed: [], watch: "  " }, "held")).toMatchObject({ ok: true, watch: null });
    expect(parseReviewAnswer("nope", "held")).toEqual({ ok: false, error: "not_an_object" });
  });
});

// ---------------------------------------------------------------------------
// the derivation
// ---------------------------------------------------------------------------

describe("finalizeReview — a measured fact outranks the analyst, and the analyst's word is kept", () => {
  it("turns an analyst 'hold' into exit_condition_met on a mid stop touch, keeping what the analyst said", () => {
    const r = finalizeReview(run({ mechanical: facts({ stop_touch: { measured: true, touched: true, at: "2026-09-12 05:00:00", bar_closed: true } }) }), current());
    expect(r.verdict).toBe("exit_condition_met");
    expect(r.decided_by).toBe("server");
    expect(r.override_reason).toMatchObject({ source: "mid_touch", at: "2026-09-12 05:00:00", basis: "mid", feed: "gmo", before_open: false, analyst: { verdict: "hold", thesis_status: "intact" } });
    expect(r.analyst?.verdict).toBe("hold");
    expect(r.status).toBe("ok");
  });

  it("uses the tracker's loss only when it settled after the fill, on the basis it recorded", () => {
    const after = run({ reference: { held: held({ outcome: { outcome: "loss", price_basis: "quotes", closed_at: "2026-09-12T06:00:00Z", outcome_price: 150.6 } }), held_reason: null, previous: null, previous_reason: null, thesis_of: "held" } });
    const r = finalizeReview(after, current());
    expect(r.verdict).toBe("exit_condition_met");
    expect(r.override_reason).toMatchObject({ source: "tracker", basis: "quotes", at: "2026-09-12T06:00:00Z", before_open: false });

    const before = run({ reference: { held: held({ outcome: { outcome: "loss", price_basis: "mid", closed_at: "2026-09-12T02:00:00Z", outcome_price: 150.6 } }), held_reason: null, previous: null, previous_reason: null, thesis_of: "held" } });
    const s = finalizeReview(before, current());
    expect(s.verdict).toBe("hold");
    expect(s.decided_by).toBe("analyst");
    expect(s.override_suppressed).toEqual({ reason: "settled_before_open", closed_at: "2026-09-12T02:00:00Z" });

    const late = run({ reference: { held: held({ registered_after_settlement: true, outcome: { outcome: "loss", price_basis: "quotes", closed_at: "2026-09-12T06:00:00Z", outcome_price: 150.6 } }), held_reason: null, previous: null, previous_reason: null, thesis_of: "held" } });
    expect(finalizeReview(late, current()).override_suppressed?.reason).toBe("registered_after_settlement");
  });

  it("does not relay an analyst that contradicts itself", () => {
    for (const [verdict, thesis] of [["hold", "weakened"], ["hold", "broken"], ["caution", "broken"]] as const) {
      const r = finalizeReview(run({ analyst: { ...run().analyst!, verdict, thesis_status: thesis } }), current());
      expect(r.verdict).toBe("undecidable");
      expect(r.decided_by).toBe("server");
      expect(r.override_reason).toMatchObject({ source: "analyst_incoherent", analyst: { verdict, thesis_status: thesis } });
    }
    // exit_condition_met beside an intact thesis is the stop-touch case and is
    // NOT flagged
    const ok = finalizeReview(run({ analyst: { ...run().analyst!, verdict: "exit_condition_met", thesis_status: "intact" } }), current());
    expect(ok.verdict).toBe("exit_condition_met");
    expect(ok.decided_by).toBe("analyst");
  });

  it("records a failed analyst as NOT PRODUCED, never as undecidable, and keeps the facts", () => {
    const r = finalizeReview(run({ status: "failed", error: "time_budget", analyst: null }), current());
    expect(r.status).toBe("partial");
    expect(r.verdict).toBeNull();
    expect(r.decided_by).toBeNull();
    expect(r.mechanical).not.toBeNull();
    expect(r.error).toBe("time_budget");
  });

  it("never derives the verdict from the new-entry signal", () => {
    // Same run, every possible fresh signal: the held verdict does not move.
    for (const signal of ["BUY", "SELL", "WAIT"] as const) {
      const r = finalizeReview(run(), current({ signal, proposed_signal: signal, rejection: null }));
      expect(r.verdict).toBe("hold");
      expect(r.decided_by).toBe("analyst");
    }
  });
});

describe("finalizeReview — the change since the previous run", () => {
  const withPrevious = (prev: PreviousReference, over: Partial<ReviewRun> = {}) =>
    run({ reference: { held: null, held_reason: "no_open_position", previous: prev, previous_reason: null, thesis_of: "previous" }, mechanical: facts({ subject: "previous" }), analyst: { ...run().analyst!, verdict: null }, ...over });

  it("says who decided each side, and keeps the thesis out of the kind", () => {
    const r = finalizeReview(withPrevious(previous()), current({ signal: "WAIT", proposed_signal: "WAIT", rejection: "low_confidence" }));
    expect(r.verdict).toBeNull();
    expect(r.change).toMatchObject({
      kind: "trade_to_wait",
      thesis_of: "previous",
      thesis_status: "intact",
      current_gate_rr: null,
      previous: { signal: "SELL", analyst_direction: "SELL", decided_by: "analyst", published: true },
      current: { signal: "WAIT", proposed_signal: "WAIT", rejection: "low_confidence", decided_by: "analyst", published: false },
    });
    const broken = finalizeReview(withPrevious(previous(), { analyst: { ...run().analyst!, verdict: null, thesis_status: "broken" } }), current({ signal: "WAIT", proposed_signal: "WAIT", rejection: "low_confidence" }));
    expect(broken.change?.kind).toBe("trade_to_wait");
    expect(broken.change?.thesis_status).toBe("broken");
  });

  it("reports a server refusal as the server's, with the gate's own measurement", () => {
    const r = finalizeReview(withPrevious(previous()), current({ signal: "WAIT", proposed_signal: "BUY", rejection: "poor_rr", gate_rr: 1.05 }));
    expect(r.change?.kind).toBe("reversed");
    expect(r.change?.current.decided_by).toBe("server");
    expect(r.change?.current_gate_rr).toBe(1.05);
  });

  it("is about the previous run even when a held plan supplied the thesis", () => {
    const both = run({ reference: { held: held(), held_reason: null, previous: previous({ analysis_id: "a-0" }), previous_reason: null, thesis_of: "held" } });
    const r = finalizeReview(both, current());
    expect(r.verdict).toBe("hold");
    expect(r.change?.previous.analysis_id).toBe("a-0");
    expect(r.change?.thesis_of).toBe("held");
  });

  it("is ok, not failed, when the previous call was a WAIT with nothing to measure", () => {
    const r = finalizeReview(withPrevious(previous({ signal: "WAIT", proposed_signal: "WAIT", analyst_direction: "WAIT", levels: null }), { mechanical: null }), current({ signal: "SELL", proposed_signal: "SELL", rejection: null, gate_rr: 1.6 }));
    expect(r.status).toBe("ok");
    expect(r.change?.kind).toBe("wait_to_trade");
  });

  it("names the other outcomes: skipped and failed", () => {
    expect(finalizeReview({ ...emptyReviewRun("t"), status: "skipped", skipped_reason: "no_reference", reference: { held: null, held_reason: "no_open_position", previous: null, previous_reason: "none_within_window", thesis_of: null } }, current())).toMatchObject({ status: "skipped", skipped_reason: "no_reference", verdict: null, change: null });
    expect(finalizeReview({ ...emptyReviewRun("t"), error: "lookup" }, current())).toMatchObject({ status: "failed", error: "lookup" });
    // held reference but no facts: failed, because the facts are owed
    expect(finalizeReview(run({ mechanical: null, analyst: null }), current()).status).toBe("failed");
  });
});

// ---------------------------------------------------------------------------
// the seams in analyze/index.ts and the migration
// ---------------------------------------------------------------------------

describe("the review is wired into analyze without touching the main call", () => {
  const src = readFileSync("supabase/functions/analyze/index.ts", "utf8");

  it("starts after the market-hours refusal, beside the main call, with an absolute deadline and no rejection path", () => {
    const start = src.indexOf("const runPositionReview = async (acc: ReviewRun)");
    expect(start).toBeGreaterThan(src.indexOf('stage = "check_market_hours"'));
    expect(start).toBeGreaterThan(src.indexOf("applyRequestShape();"));
    expect(start).toBeLessThan(src.indexOf("for (let attempt = 0; attempt < 5; attempt++)"));
    expect(src).toContain("AbortSignal.timeout(Math.max(1_000, reviewDeadlineMs(elapsed())))");
    expect(src).toContain('.catch((err) => ({ ...reviewAcc, status: "failed" as const, error: classifyReviewError(err)');
    // every fetch the task makes carries that signal
    const task = src.slice(start, src.indexOf("const classifyReviewError"));
    const fetches = [...task.matchAll(/await fetch\(/g)].length;
    const signalled = [...task.matchAll(/signal: reviewSignal/g)].length;
    expect(fetches).toBeGreaterThan(0);
    expect(signalled).toBe(fetches);
    // and the task never writes the handler's shared state
    expect(task).not.toMatch(/\n\s+stage = /);
    expect(task).not.toMatch(/\n\s+messages = /);
    expect(task).not.toMatch(/baseRequest\.[a-z_]+ = /);
  });

  it("is awaited once, after the open-plan check and before the row is assembled, under a bounded grace", () => {
    const awaitAt = src.indexOf("const reviewRun: ReviewRun = await Promise.race([");
    expect(awaitAt).toBeGreaterThan(src.indexOf('stage = "check_open_plans"'));
    expect(awaitAt).toBeLessThan(src.indexOf("    const context = {"));
    expect(src).toContain("planReviewWait(elapsed())");
    expect([...src.matchAll(/await reviewPromise|reviewPromise,\n/g)].length).toBe(1);
    // finalisation cannot reach the catch-all
    const fin = src.slice(awaitAt, src.indexOf("    const context = {"));
    expect(fin).toContain("positionReview = finalizeReview(");
    expect(fin).toContain("} catch (err) {");
    expect(fin).toContain('error: `finalise_threw: ${detail}`');
  });

  it("writes the review on THIS row and records the request it sent", () => {
    expect(src).toContain("position_review: positionReview,");
    expect(src).toContain("/rest/v1/position_review_prompts?on_conflict=analysis_id");
    // never a PATCH on the reference row
    expect(src).not.toMatch(/rest\/v1\/analyses\?id=eq\.[^`]*\bposition_review\b/);
    // and the response names the row
    expect(src).toContain("analysis_id: savedId,");
    expect(src).toContain("position_review: savedId === null ? null : positionReview,");
  });

  it("keeps index.ts inside the request-shape pins: one max_tokens literal, one header literal", () => {
    expect([...src.matchAll(/\bmax_tokens:\s*\d+/g)].length).toBe(1);
    expect([...src.matchAll(/"anthropic-version"\s*:/g)].length).toBe(1);
  });
});

describe("the migration", () => {
  const sql = readFileSync("supabase/migrations/20260912150000_register_entries_and_review_held_positions.sql", "utf8");

  it("lets a user write only through the two definer functions, pinned and grant-limited", () => {
    expect(sql).toContain("alter table public.positions enable row level security;");
    expect(sql).toContain("revoke all on public.positions from public, anon, authenticated;");
    expect(sql).toContain("grant select on public.positions to authenticated;");
    for (const fn of ["register_position(uuid, numeric, timestamptz)", "close_position(uuid, numeric, text)"]) {
      expect(sql).toContain(`revoke all on function public.${fn} from public, anon;`);
      expect(sql).toContain(`grant execute on function public.${fn} to authenticated;`);
    }
    expect([...sql.matchAll(/set search_path = ''/g)].length).toBe(2);
    expect([...sql.matchAll(/security definer/g)].length).toBe(2);
    expect([...sql.matchAll(/if v_uid is null then/g)].length).toBe(2);
  });

  it("checks the plan before copying it, and is idempotent on a repeat", () => {
    for (const check of ["plan_is_not_a_trade", "plan_is_a_preview", "plan_is_a_shadow", "plan_has_no_levels", "fill_outside_plan", "opened_before_plan", "opened_in_future"]) {
      expect(sql).toContain(check);
    }
    expect(sql).toContain("on conflict (analysis_id) where status = 'open' do nothing");
    expect(sql).toContain("'already_open', v_already");
    expect(sql).toContain("stop_loss numeric not null,");
    expect(sql).toContain("take_profit_1 numeric not null,");
    expect(sql).toContain("opened_at_source text not null check (opened_at_source in ('user', 'registered'))");
    expect(sql).toContain("v_a.outcome <> 'pending'");
  });

  it("closes with one conditional UPDATE and keeps the review prompts server-only", () => {
    expect(sql).toMatch(/update public\.positions\s+set status = 'closed'[\s\S]*?where id = p_position_id\s+and user_id = v_uid\s+and status = 'open'/);
    expect(sql).toContain("alter table public.analyses add column if not exists position_review jsonb;");
    expect(sql).toContain("alter table public.position_review_prompts enable row level security;");
    expect(sql).toContain("revoke all on public.position_review_prompts from public, anon, authenticated;");
  });
});
