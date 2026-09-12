import { describe, it, expect } from "vitest";
import { fireEvent, render as rtlRender, screen, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";
import { LocaleProvider } from "../lib/i18n";
import HeldPositionCard from "../components/HeldPositionCard";
import ChangeSinceLastCard from "../components/ChangeSinceLastCard";
import OpenPositionsStrip from "../components/OpenPositionsStrip";
import AnalysisResultView from "../components/AnalysisResultView";
import { EntryRegistration } from "../components/EntryRegistration";
import { latestVerdictFor, normalizePosition, registerErrorOf } from "../lib/positions";
import type { AnalysisRecord, AnalysisResult, HeldReference, Position, PositionReview, PreviousReference, ReviewChange, ReviewMechanical } from "../lib/types";

const render = (ui: ReactElement, locale: "ja" | "en" = "ja"): RenderResult =>
  rtlRender(<LocaleProvider initial={locale}>{ui}</LocaleProvider>);

const hasJapanese = (s: string) => /[ぁ-んァ-ヶ一-龠]/.test(s);

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const heldRef = (over: Partial<HeldReference> = {}): HeldReference => ({
  kind: "held", position_id: "pos-1", analysis_id: "a-1", direction: "SELL", entry: 150.12, stop: 150.6, tp1: 149.4,
  tp2: null, tp3: null, opened_at: "2026-09-12T03:00:00Z", opened_at_source: "user", registered_after_settlement: false,
  interval: "1h", confidence: 72, thesis: "戻り売り", key_factors: [], feed: "gmo", outcome: null,
  other_open_positions: { count: 0, ids: [] }, ...over,
});

const prevRef = (over: Partial<PreviousReference> = {}): PreviousReference => ({
  kind: "previous", analysis_id: "a-0", at: "2026-09-12T02:00:00Z", priced_at: "2026-09-12T02:00:05Z", interval: "1h",
  signal: "SELL", proposed_signal: "SELL", rejection: null, confidence: 72, decided_by: "analyst", analyst_direction: "SELL",
  levels: { direction: "SELL", entry: 150.12, stop: 150.6, tp1: 149.4, published: true }, thesis: "戻り売り", key_factors: [],
  feed: "gmo", outcome: null, ...over,
});

const mech = (over: Partial<ReviewMechanical> = {}): ReviewMechanical => ({
  subject: "held", basis: "mid", feed: "gmo", feed_delta_atr: null, price: 150.3, priced_at: "2026-09-12T10:00:00Z",
  direction: "SELL", entry: 150.12, stop: 150.6, tp1: 149.4, risk: 0.48, move_pips: -18, move_r: -0.38, to_stop_pips: 30, to_tp1_pips: 90,
  anchor_at: "2026-09-12T03:00:00Z", anchor_source: "opened_at", covers_anchor: true, bars_examined: 6, as_of: "2026-09-12 09:00:00",
  stop_touch: { measured: true, touched: false, from: "2026-09-12 04:00:00", as_of: "2026-09-12 09:00:00", bars_examined: 6 },
  tp1_touch: { measured: false, reason: "series_starts_after_anchor" },
  ...over,
});

const change = (over: Partial<ReviewChange> = {}): ReviewChange => ({
  previous: { analysis_id: "a-0", at: "2026-09-12T02:00:00Z", signal: "SELL", proposed_signal: "SELL", rejection: null, confidence: 72, decided_by: "analyst", published: true, analyst_direction: "SELL" },
  current: { analysis_id: null, at: "2026-09-12T10:00:00Z", signal: "WAIT", proposed_signal: "WAIT", rejection: "low_confidence", confidence: 55, decided_by: "analyst", published: false, analyst_direction: "WAIT" },
  kind: "trade_to_wait", thesis_of: "previous", thesis_status: "intact", current_gate_rr: null, ...over,
});

const review = (over: Partial<PositionReview> = {}): PositionReview => ({
  version: 1, status: "ok", skipped_reason: null, error: null,
  reference: { held: heldRef(), held_reason: null, previous: null, previous_reason: "none_within_window", thesis_of: "held" },
  mechanical: mech(),
  analyst: { status: "ok", verdict: "hold", thesis_status: "intact", reasons: ["根拠は維持"], what_changed: ["RSI 40 → 45"], watch: null, model: "m", effort: "medium", max_tokens: 2000, error: null, elapsed_ms: 1000 },
  verdict: "hold", decided_by: "analyst", override_reason: null, override_suppressed: null, change: null,
  at: "2026-09-12T10:00:00Z", elapsed_ms: 1100, ...over,
});

const position = (over: Partial<Position> = {}): Position => ({
  id: "pos-1", analysis_id: "a-1", pair: "USD/JPY", interval: "1h", direction: "SELL", entry_price: 150.12, stop_loss: 150.6,
  take_profit_1: 149.4, take_profit_2: null, take_profit_3: null, opened_at: "2026-09-12T03:00:00Z", opened_at_source: "user",
  registered_after_settlement: false, status: "open", closed_at: null, close_price: null, close_reason: null,
  created_at: "2026-09-12T03:05:00Z", ...over,
});

const result = (over: Partial<AnalysisResult> = {}): AnalysisResult => ({
  signal: "WAIT", thesis: "様子見", confidence: 55, technical_score: 50, fundamental_score: 50, risk_level: "MEDIUM", sentiment: "NEUTRAL",
  entry_point: "150.300", stop_loss: "—", take_profit_1: "—", take_profit_2: "—", risk_reward_ratio: "—", analysis: "", key_factors: [],
  warnings: [], support_levels: [], resistance_levels: [], market_context: "", ...over,
});

const record = (over: Partial<AnalysisRecord> = {}): AnalysisRecord => ({
  id: "r-1", pair: "USD/JPY", interval: "1h", mode: "full", signal: "WAIT", confidence: 55, thesis: null, entry_point: null, stop_loss: null,
  take_profit_1: null, take_profit_2: null, take_profit_3: null, price_at_signal: null, outcome: "skipped", outcome_price: null,
  created_at: "2026-09-12T10:00:00Z", closed_at: null, evaluation: null, plan_contract: "market_v1", ...over,
});

// ---------------------------------------------------------------------------
// the held card
// ---------------------------------------------------------------------------

describe("HeldPositionCard", () => {
  it("says what the WAIT below is not, and whose verdict this is", () => {
    render(<HeldPositionCard review={review()} held={heldRef()} pair="USD/JPY" interval="1h" freshSignal="WAIT" />);
    expect(screen.getByTestId("held-verdict")).toHaveTextContent("継続");
    expect(screen.getByTestId("verdict-source")).toHaveTextContent("AI の判定");
    expect(screen.getByTestId("not-an-instruction")).toHaveTextContent("決済する指示ではありません");
    expect(screen.getByTestId("not-an-instruction")).toHaveTextContent("WAIT");
    expect(screen.getByTestId("thesis-status")).toHaveTextContent("維持");
    expect(screen.getByTestId("review-facts")).toHaveTextContent("未計測");
    expect(screen.queryByTestId("reversed-note")).toBeNull();
  });

  it("shows a server override with the fact that decided it, and the analyst's own word beside it", () => {
    const r = review({
      verdict: "exit_condition_met", decided_by: "server",
      override_reason: { source: "mid_touch", at: "2026-09-12 05:00:00", basis: "mid", feed: "gmo", bar_closed: true, before_open: false, analyst: { verdict: "hold", thesis_status: "intact" } },
      mechanical: mech({ stop_touch: { measured: true, touched: true, at: "2026-09-12 05:00:00", bar_closed: true } }),
    });
    render(<HeldPositionCard review={r} held={heldRef()} pair="USD/JPY" interval="1h" freshSignal="WAIT" />);
    expect(screen.getByTestId("held-verdict")).toHaveTextContent("撤退条件成立");
    expect(screen.getByTestId("verdict-source")).toHaveTextContent("損切り水準に接触");
    expect(screen.getByTestId("verdict-source")).toHaveTextContent("GMO");
    // the analyst's reading is still shown as the analyst's
    expect(screen.getByTestId("thesis-status")).toHaveTextContent("維持");
  });

  it("renders the card even when the model's answer never arrived, and says why", () => {
    const r = review({ status: "partial", error: "time_budget", analyst: null, verdict: null, decided_by: null });
    render(<HeldPositionCard review={r} held={heldRef()} pair="USD/JPY" interval="1h" freshSignal="WAIT" />);
    expect(screen.getByTestId("held-verdict")).toHaveTextContent("判定できない");
    expect(screen.getByTestId("verdict-source")).toHaveTextContent("時間切れ");
    expect(screen.getByTestId("thesis-status")).toHaveTextContent("取得できず");
    expect(screen.getByTestId("review-facts")).toBeInTheDocument();
  });

  it("names a fresh call in the opposite direction as a separate call", () => {
    render(<HeldPositionCard review={review()} held={heldRef()} pair="USD/JPY" interval="4h" freshSignal="BUY" />);
    expect(screen.getByTestId("reversed-note")).toHaveTextContent("反対方向");
    expect(screen.getByText(/登録時の分析足は 1h、今回の分析は 4h/)).toBeInTheDocument();
  });

  it("explains a suppressed tracker override and counts other positions", () => {
    const r = review({ override_suppressed: { reason: "settled_before_open", closed_at: "2026-09-12T02:00:00Z" } });
    render(<HeldPositionCard review={r} held={heldRef({ other_open_positions: { count: 2, ids: ["a", "b"] } })} pair="USD/JPY" interval="1h" freshSignal="WAIT" />);
    expect(screen.getByTestId("override-suppressed")).toHaveTextContent("建玉より前");
    expect(screen.getByTestId("other-open")).toHaveTextContent("2");
  });

  it("reads in English without a Japanese string left over", () => {
    const english = review({ analyst: { ...review().analyst!, reasons: ["thesis intact"], what_changed: ["RSI 40 to 45"] } });
    const { container } = render(<HeldPositionCard review={english} held={heldRef({ thesis: "sell the bounce" })} pair="USD/JPY" interval="1h" freshSignal="WAIT" />, "en");
    expect(screen.getByTestId("held-verdict")).toHaveTextContent("HOLD");
    expect(hasJapanese(container.textContent ?? "")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// the change card
// ---------------------------------------------------------------------------

describe("ChangeSinceLastCard", () => {
  const withChange = (c: ReviewChange, over: Partial<PositionReview> = {}) =>
    review({ reference: { held: null, held_reason: "no_open_position", previous: prevRef(), previous_reason: null, thesis_of: "previous" }, mechanical: mech({ subject: "previous" }), verdict: null, decided_by: null, change: c, ...over });

  it("says the analyst declined a NEW entry, keeps the thesis as its own clause, and offers registration", () => {
    render(<ChangeSinceLastCard review={withChange(change())} previous={prevRef()} change={change()} pair="USD/JPY" heldExists={false} onRegistered={() => {}} />);
    expect(screen.getByTestId("change-headline")).toHaveTextContent("SHORT");
    expect(screen.getByTestId("change-headline")).toHaveTextContent("WAIT");
    expect(screen.getByTestId("change-kind")).toHaveTextContent("新規エントリーを見送りました");
    expect(screen.getByTestId("gate-line")).toHaveTextContent("ゲートの計測はありません");
    expect(screen.getByTestId("change-thesis")).toHaveTextContent("前回の根拠");
    expect(screen.getByTestId("change-thesis")).toHaveTextContent("維持");
    expect(screen.queryByTestId("change-clause")).toBeNull();
    expect(screen.getByTestId("register-entry")).toHaveTextContent("前回のプランを保有中なら登録");
    expect(screen.getByTestId("review-facts")).toHaveTextContent("プランの価格で入っていた場合");
  });

  it("names a server refusal as the server's, with the gate's measurement, and hides registration when a position is held", () => {
    const c = change({
      kind: "reversed",
      current: { analysis_id: null, at: "t", signal: "WAIT", proposed_signal: "BUY", rejection: "poor_rr", confidence: 66, decided_by: "server", published: false, analyst_direction: "BUY" },
      current_gate_rr: 1.05,
    });
    render(<ChangeSinceLastCard review={withChange(c)} previous={prevRef()} change={c} pair="USD/JPY" heldExists={true} onRegistered={() => {}} />);
    expect(screen.getByTestId("change-kind")).toHaveTextContent("SHORT");
    expect(screen.getByTestId("change-kind")).toHaveTextContent("LONG");
    expect(screen.getByTestId("change-clause")).toHaveTextContent("リスクリワードが割に合わない");
    expect(screen.getByTestId("gate-line")).toHaveTextContent("1:1.05");
    expect(screen.queryByTestId("register-entry")).toBeNull();
  });

  it("puts a reached stop above everything, with its basis", () => {
    const r = withChange(change(), { mechanical: mech({ subject: "previous", stop_touch: { measured: true, touched: true, at: "2026-09-12 05:00:00", bar_closed: true } }) });
    render(<ChangeSinceLastCard review={r} previous={prevRef()} change={change()} pair="USD/JPY" heldExists={false} />);
    expect(screen.getByTestId("stop-reached")).toHaveTextContent("既に達しています");
    expect(screen.getByTestId("stop-reached")).toHaveTextContent("GMO");
  });

  it("labels refused levels and a level-less WAIT", () => {
    const refused = prevRef({ signal: "WAIT", proposed_signal: "SELL", rejection: "poor_rr", decided_by: "server", levels: { direction: "SELL", entry: 150.12, stop: 150.6, tp1: 149.4, published: false } });
    const c = change({ kind: "same_call", previous: { ...change().previous, signal: "WAIT", rejection: "poor_rr", decided_by: "server", published: false }, current: { ...change().current, signal: "SELL", proposed_signal: "SELL", rejection: null, decided_by: "analyst", published: true, analyst_direction: "SELL" } });
    render(<ChangeSinceLastCard review={withChange(c)} previous={refused} change={c} pair="USD/JPY" heldExists={false} onRegistered={() => {}} />);
    expect(screen.getByTestId("levels-refused")).toBeInTheDocument();
    expect(screen.getByTestId("change-clause")).toHaveTextContent("前回はサーバーが公開を見送っていました");
    // unpublished levels are not offered for registration
    expect(screen.queryByTestId("register-entry")).toBeNull();
  });

  it("reads in English", () => {
    const english = withChange(change(), { analyst: { ...review().analyst!, verdict: null, reasons: ["thesis intact"], what_changed: ["RSI 40 to 45"] } });
    const { container } = render(<ChangeSinceLastCard review={english} previous={prevRef({ thesis: "sell the bounce" })} change={change()} pair="USD/JPY" heldExists={false} />, "en");
    expect(screen.getByTestId("change-kind")).toHaveTextContent("declined a NEW entry");
    expect(hasJapanese(container.textContent ?? "")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// the strip, the registration button and the result view
// ---------------------------------------------------------------------------

describe("OpenPositionsStrip and latestVerdictFor", () => {
  it("shows the newest verdict for a position, dated", () => {
    const rows = [
      record({ id: "r-2", created_at: "2026-09-12T12:00:00Z", position_review: review({ verdict: "caution" }) }),
      record({ id: "r-1", created_at: "2026-09-12T10:00:00Z", position_review: review() }),
    ];
    render(<OpenPositionsStrip positions={[position()]} history={rows} onClosed={() => {}} />);
    expect(screen.getByTestId("latest-verdict")).toHaveTextContent("警戒");
    expect(screen.getByTestId("close-position")).toBeInTheDocument();
  });

  it("labels an absent verdict by what it looked at", () => {
    const sinceRegistration = latestVerdictFor(position({ created_at: "2026-09-12T03:05:00Z" }), [record({ created_at: "2026-09-12T01:00:00Z" })]);
    expect(sinceRegistration).toEqual({ kind: "none", conclusive: true, examined: 1 });
    const pageTooShort = latestVerdictFor(position({ created_at: "2026-09-10T03:05:00Z" }), [record({ created_at: "2026-09-12T01:00:00Z" })]);
    expect(pageTooShort).toEqual({ kind: "none", conclusive: false, examined: 1 });
    render(<OpenPositionsStrip positions={[position({ created_at: "2026-09-10T03:05:00Z" })]} history={[record({ created_at: "2026-09-12T01:00:00Z" })]} onClosed={() => {}} />);
    expect(screen.getByTestId("latest-verdict")).toHaveTextContent("直近1件に判定なし");
  });

  it("renders nothing without an open position", () => {
    const { container } = render(<OpenPositionsStrip positions={[position({ status: "closed" })]} history={[]} onClosed={() => {}} />);
    expect(container.textContent).toBe("");
  });
});

describe("EntryRegistration", () => {
  it("opens a form with the plan's entry filled in and the time optional", () => {
    render(<EntryRegistration analysisId="a-1" pair="USD/JPY" defaultPrice="150.123" onRegistered={() => {}} />);
    fireEvent.click(screen.getByTestId("register-entry"));
    const form = screen.getByTestId("register-form");
    expect(form).toHaveTextContent("元のプランは書き換えません");
    expect((form.querySelector("input[inputmode='decimal']") as HTMLInputElement).value).toBe("150.123");
    expect(form.querySelector("input[type='datetime-local']")).toBeInTheDocument();
  });

  it("maps the RPC's named errors and falls back to generic", () => {
    expect(registerErrorOf('P0002: analysis_not_found')).toBe("analysis_not_found");
    expect(registerErrorOf("fill_outside_plan")).toBe("fill_outside_plan");
    expect(registerErrorOf("something else")).toBe("generic");
    expect(registerErrorOf(null)).toBe("generic");
  });

  it("reads a position row and refuses a half row", () => {
    expect(normalizePosition({ id: "p", analysis_id: "a", pair: "USD/JPY", direction: "BUY", entry_price: "150.1", stop_loss: "149.7", take_profit_1: "150.7", opened_at: "t", status: "open" })?.entry_price).toBe(150.1);
    expect(normalizePosition({ id: "p", analysis_id: "a", pair: "USD/JPY", direction: "BUY", entry_price: "150.1", opened_at: "t" })).toBeNull();
  });
});

describe("AnalysisResultView with a review", () => {
  it("puts the held card above the new-entry call and the change card below it", () => {
    const r = review({
      reference: { held: heldRef(), held_reason: null, previous: prevRef(), previous_reason: null, thesis_of: "held" },
      change: change({ thesis_of: "held" }),
    });
    render(<AnalysisResultView result={result()} pair="USD/JPY" interval="1h" positionReview={r} analysisId="r-1" positions={[position()]} onPositionsChanged={() => {}} />);
    const held = screen.getByTestId("held-position-card");
    const hero = screen.getByText("WAIT", { selector: "p" });
    const changeCard = screen.getByTestId("change-card");
    expect(held.compareDocumentPosition(hero) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(hero.compareDocumentPosition(changeCard) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // the change card labels the thesis as the HELD plan's when that is what was reviewed
    expect(screen.getByTestId("change-thesis")).toHaveTextContent("元のプランの根拠");
    // a held position exists, so the previous plan is not offered for registration
    expect(screen.queryByTestId("register-entry")).toBeNull();
  });

  it("offers registration on a fresh trade with a row id, and shows the chip once registered", () => {
    const trade = result({ signal: "SELL", entry_point: "150.120", stop_loss: "150.600", take_profit_1: "149.400", take_profit_2: "148.900", risk_reward_ratio: "1:1.5" });
    const { unmount } = render(<AnalysisResultView result={trade} pair="USD/JPY" interval="1h" analysisId="r-9" positions={[]} onPositionsChanged={() => {}} />);
    expect(screen.getByTestId("register-entry")).toBeInTheDocument();
    unmount();
    render(<AnalysisResultView result={trade} pair="USD/JPY" interval="1h" analysisId="r-9" positions={[position({ analysis_id: "r-9" })]} onPositionsChanged={() => {}} />);
    expect(screen.queryByTestId("register-entry")).toBeNull();
    expect(screen.getByTestId("registered-chip")).toBeInTheDocument();
  });

  it("offers nothing when the row was not written", () => {
    const trade = result({ signal: "SELL", entry_point: "150.120", stop_loss: "150.600", take_profit_1: "149.400" });
    render(<AnalysisResultView result={trade} pair="USD/JPY" interval="1h" analysisId={null} positions={[]} onPositionsChanged={() => {}} />);
    expect(screen.queryByTestId("register-entry")).toBeNull();
  });
});
