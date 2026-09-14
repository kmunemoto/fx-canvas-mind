import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render as rtlRender, screen, waitFor, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";
import { LocaleProvider } from "../lib/i18n";
import { ja } from "../lib/i18n/ja";
import { en } from "../lib/i18n/en";

const rpc = vi.fn();
vi.mock("@/lib/supabase", () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a) } }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

import { normalizePosition, registrationFor, REGISTER_ERRORS } from "../lib/positions";
import { readHeldReference } from "../../supabase/functions/analyze/review";
import HeldPositionCard from "../components/HeldPositionCard";
import OpenPositionsStrip from "../components/OpenPositionsStrip";
import { HeldPositionRegistration } from "../components/HeldPositionRegistration";
import type { HeldReference, Position, PositionReview } from "../lib/types";

const render = (ui: ReactElement, locale: "ja" | "en" = "ja"): RenderResult =>
  rtlRender(<LocaleProvider initial={locale}>{ui}</LocaleProvider>);

// A row exactly as the RPC returns it for a position the reader already held:
// analysis_id NULL, levels their own.
const ownRow = (over: Record<string, unknown> = {}) => ({
  id: "pos-own", analysis_id: null, pair: "USD/JPY", interval: "1day", direction: "SELL",
  entry_price: 153.274, stop_loss: 156.15, take_profit_1: 151, take_profit_2: null, take_profit_3: null,
  opened_at: "2026-09-09T13:33:00Z", opened_at_source: "user", registered_after_settlement: false,
  status: "open", closed_at: null, closed_at_source: null, close_price: null, close_reason: null,
  created_at: "2026-09-14T15:00:00Z", ...over,
});

const ownPosition = (over: Partial<Position> = {}): Position => ({
  ...(normalizePosition(ownRow()) as Position), ...over,
});

const ownHeld = (over: Partial<HeldReference> = {}): HeldReference => ({
  kind: "held", position_id: "pos-own", analysis_id: null, direction: "SELL",
  entry: 153.274, stop: 156.15, tp1: 151, tp2: null, tp3: null,
  opened_at: "2026-09-09T13:33:00Z", opened_at_source: "user", registered_after_settlement: false,
  interval: "1day", confidence: null, thesis: null, key_factors: [], feed: null, outcome: null,
  other_open_positions: { count: 0, ids: [] }, ...over,
});

const review = (over: Partial<PositionReview> = {}): PositionReview => ({
  version: 1, status: "ok", skipped_reason: null, error: null,
  reference: {
    held: ownHeld(), held_reason: "no_plan_registered",
    previous: null, previous_reason: "none_within_window", thesis_of: "held",
  },
  mechanical: null,
  analyst: {
    status: "ok", verdict: "hold", thesis_status: "unknown", reasons: [], what_changed: [],
    watch: null, model: "m", effort: "medium", max_tokens: 2000, error: null, elapsed_ms: 1,
  },
  verdict: "hold", decided_by: "analyst", override_reason: null, override_suppressed: null, change: null,
  at: "2026-09-14T15:00:00Z", elapsed_ms: 1, ...over,
});

// ---------------------------------------------------------------------------
// the two guards that silently dropped the row
// ---------------------------------------------------------------------------

describe("a position with no plan survives both normalisers", () => {
  // This is the defect shape the app has now hit four times: a required-field
  // guard written when the field could not be null. typeof null === "object",
  // so the row does not fail loudly — it is filtered out and the screen shows
  // nothing, which is indistinguishable from "you hold nothing".
  it("the client normaliser keeps it, and still rejects a wrong type", () => {
    const ok = normalizePosition(ownRow());
    expect(ok, "a null analysis_id must not drop the row").not.toBeNull();
    expect(ok?.analysis_id).toBeNull();
    expect(ok?.entry_price).toBe(153.274);
    // an omitted key is the same as null on the wire
    expect(normalizePosition({ ...ownRow(), analysis_id: undefined })?.analysis_id).toBeNull();
    // but a number is still a bug, not a standalone position
    expect(normalizePosition({ ...ownRow(), analysis_id: 42 })).toBeNull();
  });

  it("the server reference builder keeps it, carrying the null through", () => {
    const ref = readHeldReference(ownRow(), null, []);
    expect(ref, "the review would have no subject at all").not.toBeNull();
    expect(ref?.analysis_id).toBeNull();
    // the levels it reviews are the reader's own, off the position row
    expect(ref?.entry).toBe(153.274);
    expect(ref?.stop).toBe(156.15);
    expect(ref?.tp1).toBe(151);
    // and every plan-derived field is absent rather than invented
    expect(ref?.thesis).toBeNull();
    expect(ref?.confidence).toBeNull();
    expect(ref?.outcome).toBeNull();
    expect(ref?.key_factors).toEqual([]);
  });

  it("still refuses a row missing something it actually needs", () => {
    // Widening the guard must not widen it to everything: without a stop
    // there is no R to compute and the card can say nothing.
    for (const missing of ["direction", "entry_price", "stop_loss", "take_profit_1", "opened_at"]) {
      expect(readHeldReference(ownRow({ [missing]: null }), null, []), missing).toBeNull();
    }
  });
});

describe("a standalone position is never claimed by a plan", () => {
  it("registrationFor does not match it to any analysis", () => {
    const own = ownPosition();
    // The plan card asks "is there a position for THIS analysis?" — a position
    // belonging to no analysis must never come back as the answer.
    expect(registrationFor("some-analysis-id", [own])).toEqual({ state: "none" });
    expect(registrationFor(null, [own])).toEqual({ state: "none" });
  });
});

// ---------------------------------------------------------------------------
// what the card says
// ---------------------------------------------------------------------------

describe("the held card does not invent a plan that never existed", () => {
  it("says there is no plan instead of labelling an empty plan thesis", () => {
    render(<HeldPositionCard review={review()} held={ownHeld()} pair="USD/JPY" interval="1day" freshSignal="WAIT" />);
    expect(screen.getByTestId("held-no-plan")).toBeTruthy();
    // the label that would be false
    expect(screen.queryByText(ja.position.thesis.heldLabel)).toBeNull();
  });

  it("does not say it is judging the position on a plan's thesis and levels", () => {
    const { unmount } = render(
      <HeldPositionCard review={review()} held={ownHeld()} pair="USD/JPY" interval="1day" freshSignal="WAIT" />,
    );
    expect(screen.queryByText(ja.position.heldSubtitle)).toBeNull();
    expect(screen.getByText(ja.position.heldSubtitleOwn)).toBeTruthy();
    unmount();

    // and a plan-backed position keeps the original wording
    const planBacked = ownHeld({ analysis_id: "a-1", thesis: "戻り売り" });
    render(
      <HeldPositionCard
        review={review({ reference: { held: planBacked, held_reason: null, previous: null, previous_reason: null, thesis_of: "held" } })}
        held={planBacked}
        pair="USD/JPY"
        interval="1day"
        freshSignal="WAIT"
      />,
    );
    expect(screen.getByText(ja.position.heldSubtitle)).toBeTruthy();
    expect(screen.queryByTestId("held-no-plan")).toBeNull();
  });

  it("calls the timeframe the reader's own, not the plan's", () => {
    render(<HeldPositionCard review={review()} held={ownHeld()} pair="USD/JPY" interval="1day" freshSignal="WAIT" />);
    // 「分析足」 would name a plan's chart; there is no plan here
    const line = screen.getByText(new RegExp(ja.position.ownTimeframe));
    expect(line.textContent).toContain(ja.position.ownTimeframe);
    expect(line.textContent).not.toContain(ja.position.planTimeframe);
  });

  it("does not gloss the verdict as a thesis that never existed", () => {
    // 「根拠は維持されており」 three lines under 「元になったプランはありません」
    // is the card contradicting itself: there is no thesis to be intact, and
    // no plan whose exit condition this could be.
    render(<HeldPositionCard review={review()} held={ownHeld()} pair="USD/JPY" interval="1day" freshSignal="WAIT" />);
    const card = screen.getByTestId("held-verdict").parentElement;
    expect(card?.textContent ?? "").not.toContain(ja.position.verdictGloss.hold);
    expect(card?.textContent ?? "").toContain(ja.position.verdictGlossOwn.hold);
  });

  it("keeps the plan wording on a plan-backed position", () => {
    const planBacked = ownHeld({ analysis_id: "a-1", thesis: "戻り売り" });
    render(
      <HeldPositionCard
        review={review({ reference: { held: planBacked, held_reason: null, previous: null, previous_reason: null, thesis_of: "held" } })}
        held={planBacked} pair="USD/JPY" interval="1day" freshSignal="WAIT"
      />,
    );
    const card = screen.getByTestId("held-verdict").parentElement;
    expect(card?.textContent ?? "").toContain(ja.position.verdictGloss.hold);
    expect(card?.textContent ?? "").not.toContain(ja.position.verdictGlossOwn.hold);
  });

  it("speaks English to an English reader", () => {
    render(
      <HeldPositionCard review={review()} held={ownHeld()} pair="USD/JPY" interval="1day" freshSignal="WAIT" />,
      "en",
    );
    const text = screen.getByTestId("held-no-plan").textContent ?? "";
    expect(text).not.toMatch(/[ぁ-んァ-ヶ一-龠]/);
    expect(text).toBe(en.position.thesis.noPlan);
  });
});

// ---------------------------------------------------------------------------
// the strip and the form
// ---------------------------------------------------------------------------

describe("the reader can reach the form before they have registered anything", () => {
  it("offers it with nothing open, and stays hidden where it is not offered", () => {
    // The strip used to vanish with no positions. A reader who already holds
    // one and has run no analysis would then have nowhere to register it.
    const { unmount } = render(
      <OpenPositionsStrip positions={[]} history={[]} onClosed={() => {}}
        defaultPair="USD/JPY" defaultInterval="1h" onRegistered={() => {}} />,
    );
    expect(screen.getByTestId("register-held")).toBeTruthy();
    unmount();

    render(<OpenPositionsStrip positions={[]} history={[]} onClosed={() => {}} />);
    expect(screen.queryByTestId("open-positions")).toBeNull();
  });
});

describe("the form sends the reader's own levels, through its own RPC", () => {
  beforeEach(() => rpc.mockReset());

  const open = () => {
    render(
      <HeldPositionRegistration defaultPair="USD/JPY" defaultInterval="1day" onRegistered={() => {}} />,
    );
    fireEvent.click(screen.getByTestId("register-held"));
  };

  const type = (label: string, value: string) => {
    const input = screen.getByText(label).parentElement?.querySelector("input");
    if (!input) throw new Error(`no input for ${label}`);
    fireEvent.change(input, { target: { value } });
  };

  it("calls register_held_position, never register_position", async () => {
    rpc.mockResolvedValue({ data: { position: ownRow(), already_open: false }, error: null });
    open();
    type(ja.position.own.fillPrice, "153.274");
    type(ja.position.own.stopLoss, "156.150");
    type(ja.position.own.tp1, "151.000");
    fireEvent.click(screen.getByTestId("own-dir-SELL"));
    fireEvent.submit(screen.getByTestId("register-held-form"));

    await waitFor(() => expect(rpc).toHaveBeenCalled());
    const [name, params] = rpc.mock.calls[0] as [string, Record<string, unknown>];
    expect(name, "the plan RPC would copy a plan's levels").toBe("register_held_position");
    expect(params.p_direction).toBe("SELL");
    expect(params.p_entry_price).toBe(153.274);
    expect(params.p_stop_loss).toBe(156.15);
    expect(params.p_take_profit_1).toBe(151);
    expect(params.p_pair).toBe("USD/JPY");
    expect(params.p_interval).toBe("1day");
    // A blank optional target is ABSENT, not zero: sending 0 would be a
    // take-profit the reader never set, and the server would refuse it as
    // incoherent rather than default it.
    expect(params).not.toHaveProperty("p_take_profit_2");
    expect(params).not.toHaveProperty("p_take_profit_3");
    // and a blank fill time means "use your clock", so it is not sent either
    expect(params).not.toHaveProperty("p_opened_at");
  });

  it("refuses before the network when a required level is missing", async () => {
    open();
    type(ja.position.own.fillPrice, "153.274");
    fireEvent.submit(screen.getByTestId("register-held-form"));
    await waitFor(() => expect(screen.getByTestId("own-register-error")).toBeTruthy());
    expect(rpc, "a request with no stop should never leave the browser").not.toHaveBeenCalled();
  });

  it("shows the server's own refusal rather than a generic failure", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'levels_incoherent' } });
    open();
    type(ja.position.own.fillPrice, "153.274");
    type(ja.position.own.stopLoss, "151.000");
    type(ja.position.own.tp1, "156.150");
    fireEvent.submit(screen.getByTestId("register-held-form"));
    await waitFor(() => expect(screen.getByTestId("own-register-error")).toBeTruthy());
    expect(screen.getByTestId("own-register-error").textContent)
      .toBe(ja.position.registerErrors.levels_incoherent);
  });

  it("names the field that is actually wrong, not the one next to it", async () => {
    // An unreadable TP2 reported the TAKE PROFIT 1 error, pointing the reader
    // at a box that was fine.
    open();
    type(ja.position.own.fillPrice, "153.274");
    type(ja.position.own.stopLoss, "156.150");
    type(ja.position.own.tp1, "151.000");
    type(ja.position.own.tp2, "abc");
    fireEvent.submit(screen.getByTestId("register-held-form"));
    await waitFor(() => expect(screen.getByTestId("own-register-error")).toBeTruthy());
    const shown = screen.getByTestId("own-register-error").textContent;
    expect(shown).not.toBe(ja.position.registerErrors.take_profit_1_must_be_positive);
    expect(shown).toBe(ja.position.registerErrors.targets_out_of_order);
  });

  it("says on the form that this position is not part of the app's record", () => {
    open();
    expect(screen.getByTestId("own-not-counted").textContent).toBe(ja.position.own.notCounted);
  });
});

// ---------------------------------------------------------------------------
// the dictionaries
// ---------------------------------------------------------------------------

describe("every refusal the new RPC can raise has wording in both locales", () => {
  it("names each one, in its own language", () => {
    const fromRpc = [
      "pair_invalid", "interval_invalid", "direction_invalid",
      "stop_loss_must_be_positive", "take_profit_1_must_be_positive",
      "levels_incoherent", "targets_out_of_order",
      "not_signed_in", "entry_price_must_be_positive", "opened_in_future", "position_not_open",
    ] as const;
    for (const key of fromRpc) {
      // registerErrorOf matches on substring, so the name must be in the list
      // the client knows — otherwise every one of these shows as "generic".
      expect(REGISTER_ERRORS as readonly string[], key).toContain(key);
      expect(ja.position.registerErrors[key].length, `ja.${key}`).toBeGreaterThan(0);
      expect(en.position.registerErrors[key].length, `en.${key}`).toBeGreaterThan(0);
      expect(en.position.registerErrors[key], `en.${key} is Japanese`).not.toMatch(/[ぁ-んァ-ヶ一-龠]/);
    }
  });

  it("gives the plan-less card its own wording, distinct from the plan-backed one", () => {
    for (const d of [ja, en]) {
      expect(d.position.heldSubtitleOwn).not.toBe(d.position.heldSubtitle);
      expect(d.position.ownTimeframe).not.toBe(d.position.planTimeframe);
      expect(d.position.facts.trackerNoPlan).not.toBe(d.position.facts.trackerPending);
      expect(d.position.facts.trackerNoPlan).not.toBe(d.position.facts.trackerUnknown);
    }
    for (const s of [en.position.heldSubtitleOwn, en.position.ownTimeframe, en.position.facts.trackerNoPlan, en.position.thesis.noPlan]) {
      expect(s).not.toMatch(/[ぁ-んァ-ヶ一-龠]/);
    }
  });
});
