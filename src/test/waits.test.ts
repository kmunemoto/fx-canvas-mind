import { describe, it, expect } from "vitest";
import { judgeWait, marketHorizonEnd, minimalTrade, type WaitBar } from "../../supabase/functions/track-outcomes/waits";
import { MIN_RISK_REWARD, MIN_STOP_ATR, waitPlanFor, type WaitPlan } from "../../supabase/functions/analyze/entry";

const HOUR = 60 * 60 * 1000;
// A Tuesday, so nothing here lands in the weekend break
const T = Date.parse("2026-09-01T09:00:00Z");
const PRICE = 150;
const ATR = 0.5;
// risk 0.2, reward 0.24
const { risk, reward } = minimalTrade(ATR);

const bar = (i: number, low: number, high: number): WaitBar => ({ t: T + (i + 1) * HOUR, low, high });

// The plan the way analyze builds it: from the signal the model proposed and
// the price and ATR that were on the screen, and from nothing else.
const planFor = (proposedSignal: "BUY" | "SELL" | "WAIT", declaredDirection: string | null = null): WaitPlan =>
  waitPlanFor({
    proposedSignal,
    declaredDirection,
    regime: "unclear",
    regimeDirection: null,
    entry: PRICE,
    atr: ATR,
    quote: null,
    decimals: 3,
    contract: "market_v1",
    decidedAt: new Date(T).toISOString(),
  });

const judge = (
  bars: WaitBar[],
  nowHours = 48,
  horizonHours = 48,
  plan: WaitPlan | null = planFor("BUY"),
) =>
  judgeWait(
    { price: PRICE, atr: ATR, signalMs: T, horizonMs: horizonHours * HOUR },
    plan,
    bars,
    T + nowHours * HOUR,
  );

describe("the minimal trade a WAIT is judged against", () => {
  it("is built from the app's own floors, not from a number invented here", () => {
    expect(risk).toBeCloseTo(MIN_STOP_ATR * ATR, 10);
    expect(reward).toBeCloseTo(MIN_RISK_REWARD * risk, 10);
    // The tightest stop and nearest target the entry gate would ever allow
    expect(risk).toBeCloseTo(0.2, 10);
    expect(reward).toBeCloseTo(0.24, 10);
  });

  it("is fixed at the moment of the call, from what was said then", () => {
    const p = planFor("BUY");
    expect(p.direction).toBe("BUY");
    expect(p.direction_source).toBe("proposed_signal");
    expect(p.entry).toBe(PRICE);
    expect(p.stop).toBeCloseTo(PRICE - risk, 10);
    expect(p.target).toBeCloseTo(PRICE + reward, 10);

    // A model that declined to trade but named the market's direction still
    // leaves a side to grade
    const declared = planFor("WAIT", "Down");
    expect(declared.direction).toBe("SELL");
    expect(declared.direction_source).toBe("declared_direction");

    // And one that named nothing leaves none — that is not a coin flip
    const silent = planFor("WAIT", "Sideways");
    expect(silent.direction).toBeNull();
    expect(silent.direction_source).toBe("none");
    expect(silent.stop).toBeNull();
  });
});

describe("scoring a WAIT", () => {
  it("calls it a miss when the trade named at the call would have paid", () => {
    const w = judge([
      bar(0, PRICE - 0.05, PRICE + 0.1),
      bar(1, PRICE + 0.05, PRICE + reward + 0.01), // target reached, stop never touched
    ]);
    expect(w.verdict).toBe("missed");
    expect(w.direction).toBe("BUY");
    expect(w.r).toBe(MIN_RISK_REWARD);
    expect(w.at).toBe(new Date(T + 2 * HOUR).toISOString());
  });

  it("calls it a miss the other way too — the test is symmetric", () => {
    const w = judge(
      [
        bar(0, PRICE - 0.1, PRICE + 0.05),
        bar(1, PRICE - reward - 0.01, PRICE - 0.05),
      ],
      48,
      48,
      planFor("SELL"),
    );
    expect(w.verdict).toBe("missed");
    expect(w.direction).toBe("SELL");
  });

  it("does not call it a miss because the OTHER side would have paid", () => {
    // This is the whole point of the rewrite. The call was a long; the market
    // fell far enough to stop it and then rose. The old scorer walked both
    // sides and reported "missed, SELL" — a trade nobody at the time had
    // named, chosen because it was the one that won.
    const w = judge([
      bar(0, PRICE - risk - 0.01, PRICE + 0.02), // the long is stopped here
      bar(1, PRICE - 0.02, PRICE + reward + 5), // and then price runs up
    ]);
    expect(w.verdict).toBe("correct");
    expect(w.direction).toBe("BUY");
    expect(w.r).toBe(-1);
  });

  it("calls it correct when the trade named at the call was stopped out", () => {
    const w = judge([bar(0, PRICE - risk - 0.01, PRICE + 0.05)]);
    expect(w.verdict).toBe("correct");
    expect(w.r).toBe(-1);
  });

  it("does not credit a bar that reached the target and the stop together", () => {
    // Within one bar the order is unknowable, and a WAIT should only be
    // called wrong on evidence that is not in doubt
    const w = judge([bar(0, PRICE - risk - 0.01, PRICE + reward + 0.01)]);
    expect(w.verdict).not.toBe("missed");
  });

  it("waits rather than guessing while the window is still open", () => {
    const w = judge([bar(0, PRICE - 0.05, PRICE + 0.05)], 10, 48);
    expect(w.verdict).toBe("pending");
  });

  it("settles as correct once the window closes with nothing taken", () => {
    const w = judge([bar(0, PRICE - 0.05, PRICE + 0.05)], 49, 48);
    expect(w.verdict).toBe("correct");
    // Nothing was taken and nothing was lost: claiming −1 here would be a
    // loss that never happened
    expect(w.r).toBeNull();
  });

  it("ignores bars past the horizon — a move two days later is not a missed call", () => {
    const w = judge(
      [bar(0, PRICE - 0.05, PRICE + 0.05), { t: T + 60 * HOUR, low: PRICE, high: PRICE + 10 }],
      72,
      48,
    );
    expect(w.verdict).toBe("correct");
    expect(w.bars_examined).toBe(1);
  });

  it("ignores a level reached while the market was shut", () => {
    // Saturday: nobody could have taken this trade
    const sat = Date.parse("2026-09-05T12:00:00Z");
    const w = judgeWait(
      { price: PRICE, atr: ATR, signalMs: sat - HOUR, horizonMs: 48 * HOUR },
      planFor("BUY"),
      [{ t: sat, low: PRICE, high: PRICE + reward + 1 }],
      sat + 72 * HOUR,
    );
    expect(w.bars_examined).toBe(0);
    // and it does NOT call the WAIT correct on that: no bars is no evidence
    expect(w.verdict).toBe("pending");
  });

  it("counts the horizon in market time, so a weekend cannot grade a WAIT for free", () => {
    // Measured in wall clock, a Friday WAIT spends its 48 hours mostly on a
    // shut market: no bars survive the filter, nothing is stopped, the window
    // expires and the call is graded "correct" having seen nothing. Since the
    // whole point is to catch over-caution, that is the one verdict a WAIT
    // must not be able to award itself.
    const friEvening = Date.parse("2026-09-04T20:00:00Z");
    const end = marketHorizonEnd(friEvening, 48 * HOUR);
    // 48 hours of OPEN market from Friday evening runs past the weekend and
    // well into the following week
    expect(end).toBeGreaterThan(friEvening + 48 * HOUR);
    expect(end).toBeGreaterThan(Date.parse("2026-09-08T00:00:00Z"));

    const w = judgeWait(
      { price: PRICE, atr: ATR, signalMs: friEvening, horizonMs: 48 * HOUR },
      planFor("BUY"),
      [],
      friEvening + 50 * HOUR, // Sunday evening in wall clock
    );
    expect(w.verdict).toBe("pending");
  });

  it("scores nothing when nothing at the time named a side", () => {
    // No plan at all: every row written before the plan existed
    const none = judge([bar(0, PRICE - 5, PRICE + 5)], 49, 48, null);
    expect(none.verdict).toBe("no_call");
    expect(none.bars_examined).toBe(0);
    expect(none.r).toBeNull();

    // A plan that was written but had no direction to write
    const silent = judge([bar(0, PRICE - 5, PRICE + 5)], 49, 48, planFor("WAIT", "Sideways"));
    expect(silent.verdict).toBe("no_call");
    expect(silent.direction).toBeNull();
  });

  it("says it cannot judge, rather than guessing, when the call predates the data", () => {
    const noAtr = judgeWait(
      { price: PRICE, atr: null, signalMs: T, horizonMs: HOUR },
      { ...planFor("BUY"), atr: null, stop: null, target: null, risk: null, reward: null },
      [],
      T + HOUR,
    );
    expect(noAtr.verdict).toBe("unknown");
    // and it does not invent levels it could not compute
    expect(noAtr.risk).toBeNull();
  });

  it("records the levels it used so the verdict can be checked by hand", () => {
    const w = judge([bar(0, PRICE - 0.05, PRICE + 0.05)], 49, 48);
    expect(w.price).toBe(PRICE);
    expect(w.atr).toBe(ATR);
    expect(w.risk).toBeCloseTo(risk, 10);
    expect(w.reward).toBeCloseTo(reward, 10);
    expect(w.stop).toBeCloseTo(PRICE - risk, 10);
    expect(w.target).toBeCloseTo(PRICE + reward, 10);
    expect(w.horizon_ms).toBe(48 * HOUR);
    // Which rule produced it: a verdict from the two-sided scorer and one
    // from this scorer are not the same measurement
    expect(w.scorer).toBe(2);
    expect(w.direction_source).toBe("proposed_signal");
  });
});

// The judge above is only worth anything if the sweep actually reaches it.
// The first wiring put the WAIT pass after an early return taken whenever no
// trade was due — so on most ticks it ran on nothing at all, reporting success.
describe("the sweep reaches the WAIT pass", () => {
  it("has no early return between reading the rows and scoring the waits", async () => {
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync("supabase/functions/track-outcomes/index.ts", "utf8"));
    const dueAt = src.indexOf("const due = rows.filter");
    const waitAt = src.indexOf("and the calls that declined to trade");
    expect(dueAt).toBeGreaterThan(0);
    expect(waitAt).toBeGreaterThan(dueAt);
    const between = src.slice(dueAt, waitAt);
    // A bare `return json({...})` here skips WAIT scoring entirely
    expect(between).not.toMatch(/\n\s{4}return json\(/);
  });

  it("hands the scorer the stored plan, not just the row's price", async () => {
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync("supabase/functions/track-outcomes/index.ts", "utf8"));
    expect(src).toContain("wait_plan&order=created_at.asc");
    expect(src).toContain("isRecord(row.wait_plan)");
  });

  it("never picks the direction from the outcome", async () => {
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync("supabase/functions/track-outcomes/waits.ts", "utf8"));
    // The old scorer walked both sides and chose the winner. If either of
    // these comes back, the miss rate is measuring the market's range again.
    expect(src).not.toContain("long.won ? ");
    expect(src).not.toMatch(/let short: SideState/);
  });
});
