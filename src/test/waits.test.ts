import { describe, it, expect } from "vitest";
import { judgeWait, minimalTrade, type WaitBar } from "../../supabase/functions/track-outcomes/waits";
import { MIN_RISK_REWARD, MIN_STOP_ATR } from "../../supabase/functions/analyze/entry";

const HOUR = 60 * 60 * 1000;
// A Tuesday, so nothing here lands in the weekend break
const T = Date.parse("2026-09-01T09:00:00Z");
const PRICE = 150;
const ATR = 0.5;
// risk 0.2, reward 0.24
const { risk, reward } = minimalTrade(ATR);

const bar = (i: number, low: number, high: number): WaitBar => ({ t: T + (i + 1) * HOUR, low, high });

const judge = (bars: WaitBar[], nowHours = 48, horizonHours = 48) =>
  judgeWait(
    { price: PRICE, atr: ATR, signalMs: T, horizonMs: horizonHours * HOUR },
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
});

describe("scoring a WAIT", () => {
  it("calls it a miss when a minimal long would have paid", () => {
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
    const w = judge([
      bar(0, PRICE - 0.1, PRICE + 0.05),
      bar(1, PRICE - reward - 0.01, PRICE - 0.05),
    ]);
    expect(w.verdict).toBe("missed");
    expect(w.direction).toBe("SELL");
  });

  it("calls it correct when the market chopped and took out both sides", () => {
    const w = judge([
      bar(0, PRICE - risk - 0.01, PRICE + 0.05), // long stopped
      bar(1, PRICE - 0.05, PRICE + risk + 0.01), // short stopped
    ]);
    expect(w.verdict).toBe("correct");
    expect(w.direction).toBeNull();
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
      [{ t: sat, low: PRICE, high: PRICE + reward + 1 }],
      sat + 72 * HOUR,
    );
    expect(w.bars_examined).toBe(0);
    expect(w.verdict).toBe("correct");
  });

  it("says it cannot judge, rather than guessing, when the call predates the data", () => {
    const noAtr = judgeWait({ price: PRICE, atr: null, signalMs: T, horizonMs: HOUR }, [], T + HOUR);
    expect(noAtr.verdict).toBe("unknown");
    const noPrice = judgeWait({ price: null, atr: ATR, signalMs: T, horizonMs: HOUR }, [], T + HOUR);
    expect(noPrice.verdict).toBe("unknown");
    // and it does not invent levels it could not compute
    expect(noAtr.risk).toBeNull();
  });

  it("records the levels it used so the verdict can be checked by hand", () => {
    const w = judge([bar(0, PRICE - 0.05, PRICE + 0.05)], 49, 48);
    expect(w.price).toBe(PRICE);
    expect(w.atr).toBe(ATR);
    expect(w.risk).toBeCloseTo(risk, 10);
    expect(w.reward).toBeCloseTo(reward, 10);
    expect(w.horizon_ms).toBe(48 * HOUR);
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
});
