import { describe, expect, it } from "vitest";
import {
  MAX_EXPIRES_BARS,
  MAX_TRIGGER_ATR,
  MIN_TRIGGER_ATR,
  readConditionalWait,
  scoreConditionalWait,
  type ConditionalWait,
  type ScorableBar,
} from "../../supabase/functions/_shared/conditional-wait.ts";

const HOUR = 60 * 60 * 1000;
const T0 = Date.parse("2026-09-01T00:00:00.000Z");

const claim = (over: Record<string, unknown> = {}) => ({
  trigger_price: 151.2,
  trigger_side: "above",
  then_signal: "BUY",
  expires_bars: 6,
  thesis_if_triggered: "レンジ上限を上抜けたら継続",
  ...over,
});

const read = (over: Record<string, unknown> = {}, ctx: Record<string, unknown> = {}) =>
  readConditionalWait({
    raw: claim(over),
    signal: "WAIT",
    price: 150.0,
    atr: 0.5,
    decimals: 3,
    ...ctx,
  } as Parameters<typeof readConditionalWait>[0]);

describe("readConditionalWait — what gets kept", () => {
  it("keeps a well-formed claim and records the distance it was judged on", () => {
    const got = read();
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.value.version).toBe(1);
    expect(got.value.trigger_price).toBe(151.2);
    expect(got.value.trigger_side).toBe("above");
    expect(got.value.then_signal).toBe("BUY");
    expect(got.value.expires_bars).toBe(6);
    expect(got.value.price_at_call).toBe(150);
    // 1.2 / 0.5
    expect(got.value.distance_atr).toBe(2.4);
  });

  it("clamps an over-long window rather than throwing the level away", () => {
    const got = read({ expires_bars: 400 });
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.value.expires_bars).toBe(MAX_EXPIRES_BARS);
  });

  it("keeps at least one bar when the analyst writes zero or a fraction", () => {
    for (const bars of [0, 0.4, -3]) {
      const got = read({ expires_bars: bars });
      expect(got.ok).toBe(true);
      if (!got.ok) return;
      expect(got.value.expires_bars).toBeGreaterThanOrEqual(1);
    }
  });

  it("caps the thesis instead of storing an essay", () => {
    const got = read({ thesis_if_triggered: "あ".repeat(500) });
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.value.thesis_if_triggered.length).toBe(120);
  });
});

describe("readConditionalWait — what gets refused, by name", () => {
  it("absent when the analyst did not answer", () => {
    for (const raw of [undefined, null]) {
      const got = readConditionalWait({ raw, signal: "WAIT", price: 150, atr: 0.5, decimals: 3 });
      expect(got).toEqual({ ok: false, rejection: "absent" });
    }
  });

  it("not_a_wait on a published direction — the plan is already the claim", () => {
    for (const signal of ["BUY", "SELL"]) {
      const got = readConditionalWait({ raw: claim(), signal, price: 150, atr: 0.5, decimals: 3 });
      expect(got).toEqual({ ok: false, rejection: "not_a_wait" });
    }
  });

  it("malformed on a missing or unusable field", () => {
    const cases: Record<string, unknown>[] = [
      { trigger_price: "151.2" },
      { trigger_side: "sideways" },
      { then_signal: "WAIT" },
      { expires_bars: null },
      { thesis_if_triggered: "   " },
    ];
    for (const over of cases) {
      expect(read(over)).toEqual({ ok: false, rejection: "malformed" });
    }
    expect(readConditionalWait({ raw: [1, 2], signal: "WAIT", price: 150, atr: 0.5, decimals: 3 }))
      .toEqual({ ok: false, rejection: "malformed" });
  });

  it("wrong_side when the level is already on the named side — an instant free hit", () => {
    expect(read({ trigger_side: "above", trigger_price: 149 })).toEqual({ ok: false, rejection: "wrong_side" });
    expect(read({ trigger_side: "below", trigger_price: 151 })).toEqual({ ok: false, rejection: "wrong_side" });
    // Equal to the market counts as already there.
    expect(read({ trigger_side: "above", trigger_price: 150 })).toEqual({ ok: false, rejection: "wrong_side" });
  });

  it("no_atr when there is no scale to judge the distance on", () => {
    for (const atr of [null, 0, Number.NaN]) {
      expect(read({}, { atr })).toEqual({ ok: false, rejection: "no_atr" });
    }
  });

  it("too_close inside the noise the plan is already standing aside from", () => {
    // 0.1 / 0.5 = 0.2 ATR, under the floor
    const got = read({ trigger_price: 150.1 });
    expect(got).toEqual({ ok: false, rejection: "too_close" });
    expect(MIN_TRIGGER_ATR).toBe(0.25);
  });

  it("too_far, where 'it never came' would mean nothing", () => {
    // 5.0 / 0.5 = 10 ATR
    const got = read({ trigger_price: 155 });
    expect(got).toEqual({ ok: false, rejection: "too_far" });
    expect(MAX_TRIGGER_ATR).toBe(3);
  });

  it("accepts the boundaries themselves — the bounds are inclusive", () => {
    expect(read({ trigger_price: 150.125 }).ok).toBe(true); // exactly 0.25 ATR
    expect(read({ trigger_price: 151.5 }).ok).toBe(true); // exactly 3.0 ATR
  });
});

// ---------------------------------------------------------------------------

const plan = (over: Partial<ConditionalWait> = {}): ConditionalWait => ({
  version: 1,
  trigger_price: 151.0,
  trigger_side: "above",
  then_signal: "BUY",
  expires_bars: 4,
  thesis_if_triggered: "上抜け継続",
  price_at_call: 150.0,
  atr_at_call: 0.5,
  distance_atr: 2.0,
  ...over,
});

// 15-minute bars, which is what a 1h plan is actually scored on
// (track-outcomes/evaluate.ts EVAL_INTERVAL).
const bars15 = (count: number, shape: (i: number) => Partial<ScorableBar>): ScorableBar[] =>
  Array.from({ length: count }, (_, i) => {
    const t = T0 + (i + 1) * 15 * 60 * 1000;
    return {
      datetime: new Date(t).toISOString(),
      high: 150.1,
      low: 149.9,
      close: 150,
      ...shape(i),
    };
  });

describe("scoreConditionalWait — the window is a duration, not a bar count", () => {
  it("a 1h plan of 4 bars looks four HOURS ahead on 15min bars, not four bars", () => {
    // The touch lands on the 10th 15-minute bar — 2.5 hours in. Inside a
    // 4-hour window; outside a naive 4-BAR slice of the same series. This is
    // the regression: slicing by expires_bars would report not_triggered on
    // every timeframe but 15min.
    const bars = bars15(20, (i) => {
      if (i === 9) return { high: 151.5, low: 150.0, close: 151.4 };
      if (i > 9) return { high: 151.8, low: 151.2, close: 151.6 };
      return {};
    });
    const got = scoreConditionalWait({ plan: plan(), barsAfterCall: bars, entryBarMs: HOUR, signalMs: T0 });
    expect(got.verdict).toBe("triggered_right");
    expect(got.bars_to_trigger).toBe(10);
    // 4 hours of 15-minute bars
    expect(got.bars_examined).toBe(16);
    expect(got.window_ends_at).toBe(new Date(T0 + 4 * HOUR).toISOString());
  });

  it("stops at the deadline — a touch after it is not a trigger", () => {
    // 17th bar = 4h15m in, one bar past the window.
    const bars = bars15(24, (i) => (i === 16 ? { high: 152, low: 150, close: 151.9 } : {}));
    const got = scoreConditionalWait({ plan: plan(), barsAfterCall: bars, entryBarMs: HOUR, signalMs: T0 });
    expect(got.verdict).toBe("not_triggered");
    expect(got.bars_examined).toBe(16);
  });

  it("ignores bars at or before the call", () => {
    const before: ScorableBar[] = [
      { datetime: new Date(T0 - HOUR).toISOString(), high: 153, low: 149, close: 152 },
      { datetime: new Date(T0).toISOString(), high: 153, low: 149, close: 152 },
    ];
    const got = scoreConditionalWait({
      plan: plan(),
      barsAfterCall: [...before, ...bars15(16, () => ({}))],
      entryBarMs: HOUR,
      signalMs: T0,
    });
    expect(got.verdict).toBe("not_triggered");
    expect(got.bars_examined).toBe(16);
  });
});

describe("scoreConditionalWait — the verdicts", () => {
  it("not_triggered is a verdict of its own and never a pass", () => {
    const got = scoreConditionalWait({
      plan: plan(),
      barsAfterCall: bars15(16, () => ({})),
      entryBarMs: HOUR,
      signalMs: T0,
    });
    expect(got.verdict).toBe("not_triggered");
    expect(got.triggered_at).toBeNull();
    expect(got.move_after_atr).toBeNull();
  });

  it("unmeasurable when no bar falls inside the window at all", () => {
    const got = scoreConditionalWait({ plan: plan(), barsAfterCall: [], entryBarMs: HOUR, signalMs: T0 });
    expect(got.verdict).toBe("unmeasurable");
    expect(got.bars_examined).toBe(0);
    expect(got.window_ends_at).toBe(new Date(T0 + 4 * HOUR).toISOString());
  });

  it("triggered_wrong when the named direction lost ground after the touch", () => {
    const bars = bars15(16, (i) => {
      if (i === 1) return { high: 151.2, low: 150, close: 151 };
      if (i > 1) return { high: 150.6, low: 149.5, close: 150.0 };
      return {};
    });
    const got = scoreConditionalWait({ plan: plan(), barsAfterCall: bars, entryBarMs: HOUR, signalMs: T0 });
    expect(got.verdict).toBe("triggered_wrong");
    expect(got.bars_to_trigger).toBe(2);
    // (150.0 - 151.0) / 0.5
    expect(got.move_after_atr).toBe(-2);
  });

  it("scores a SELL claim in its own direction", () => {
    const p = plan({ trigger_side: "below", trigger_price: 149.0, then_signal: "SELL" });
    const bars = bars15(16, (i) => {
      if (i === 0) return { high: 150, low: 148.9, close: 149 };
      return { high: 148.6, low: 148.0, close: 148.5 };
    });
    const got = scoreConditionalWait({ plan: p, barsAfterCall: bars, entryBarMs: HOUR, signalMs: T0 });
    expect(got.verdict).toBe("triggered_right");
    // (149.0 - 148.5) / 0.5
    expect(got.move_after_atr).toBe(1);
  });

  it("triggered_unresolved when the touch is the last bar in the window", () => {
    const bars = bars15(16, (i) => (i === 15 ? { high: 151.4, low: 150, close: 151.3 } : {}));
    const got = scoreConditionalWait({ plan: plan(), barsAfterCall: bars, entryBarMs: HOUR, signalMs: T0 });
    expect(got.verdict).toBe("triggered_unresolved");
    expect(got.bars_to_trigger).toBe(16);
    expect(got.move_after_atr).toBeNull();
  });

  it("the trigger is a touch, not a close", () => {
    // High reaches the level, close never does.
    const bars = bars15(16, (i) => (i === 3 ? { high: 151.05, low: 150, close: 150.2 } : {}));
    const got = scoreConditionalWait({ plan: plan(), barsAfterCall: bars, entryBarMs: HOUR, signalMs: T0 });
    expect(got.triggered_at).toBe(bars[3].datetime);
  });

  it("leaves move_after_atr null rather than inventing a scale without an ATR", () => {
    const bars = bars15(16, (i) => (i === 0 ? { high: 151.5, low: 150, close: 151.4 } : { close: 151.8, high: 152, low: 151 }));
    const got = scoreConditionalWait({
      plan: plan({ atr_at_call: null }),
      barsAfterCall: bars,
      entryBarMs: HOUR,
      signalMs: T0,
    });
    expect(got.verdict).toBe("triggered_right");
    expect(got.move_after_atr).toBeNull();
  });
});
