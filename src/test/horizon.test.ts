import { describe, expect, it } from "vitest";
import {
  buildPlanHorizon,
  ENTRY_BAR_MS,
  entryBarMs,
  horizonBars,
  horizonWallMs,
  PLAN_HORIZON_BARS,
} from "../../supabase/functions/_shared/horizon.ts";
import { HORIZON_MS } from "../../supabase/functions/econ-calendar/events.ts";
import { marketHorizonEnd } from "../../supabase/functions/track-outcomes/waits.ts";
import { stringsFor } from "../../supabase/functions/analyze/locale.ts";

const HOUR = 60 * 60 * 1000;

describe("the declaration introduces no new number", () => {
  // The whole argument for this table is that it is the economic calendar's
  // lookahead read in the unit the trade is measured in. If that identity ever
  // breaks, the app is back to two disagreeing horizons and the migration
  // comment claiming otherwise becomes false.
  it("PLAN_HORIZON_BARS x ENTRY_BAR_MS reproduces HORIZON_MS exactly, on every interval", () => {
    const expected: Record<string, number> = {
      // #98: thirty one-minute bars, half an hour
      "1min": 30 * 60_000,
      "15min": 6 * HOUR,
      "1h": 12 * HOUR,
      "4h": 48 * HOUR,
      "1day": 120 * HOUR,
    };
    for (const interval of Object.keys(expected)) {
      expect(PLAN_HORIZON_BARS[interval] * ENTRY_BAR_MS[interval], interval).toBe(expected[interval]);
      expect(HORIZON_MS[interval], interval).toBe(expected[interval]);
      expect(horizonWallMs(interval), interval).toBe(expected[interval]);
    }
  });

  it("covers exactly the five intervals the app analyses, and no others", () => {
    expect(Object.keys(PLAN_HORIZON_BARS).sort()).toEqual(["15min", "1day", "1h", "1min", "4h"]);
    expect(Object.keys(ENTRY_BAR_MS).sort()).toEqual(["15min", "1day", "1h", "1min", "4h"]);
  });

  it("bar lengths agree with the tracker's own copy", () => {
    expect(entryBarMs("1min")).toBe(60_000);
    expect(entryBarMs("15min")).toBe(15 * 60_000);
    expect(entryBarMs("1h")).toBe(HOUR);
    expect(entryBarMs("4h")).toBe(4 * HOUR);
    expect(entryBarMs("1day")).toBe(24 * HOUR);
  });
});

describe("the values against what production actually did", () => {
  // Measured 2026-09-14 over 53 settled trades. These are the p90 holding
  // times in entry bars. The table is not free to drift far from them without
  // somebody noticing, which is the point of pinning them here.
  const P90: Record<string, number> = { "15min": 26.87, "1h": 9.08, "4h": 7.39, "1day": 3.70 };

  it("covers p90 on 1h, 4h and 1day", () => {
    for (const interval of ["1h", "4h", "1day"]) {
      expect(horizonBars(interval)!, interval).toBeGreaterThan(P90[interval]);
    }
  });

  it("does NOT cover p90 on 15min, and that is known rather than hidden", () => {
    // 24 against a p90 of 26.87 computed from twelve trades. The weakest of the
    // four values; the module comment says so instead of defending it.
    expect(horizonBars("15min")!).toBeLessThan(P90["15min"]);
  });
});

describe("buildPlanHorizon", () => {
  const TUE = "2026-09-01T00:00:00.000Z";

  it("freezes the period in market time, not wall clock", () => {
    const h = buildPlanHorizon({
      interval: "1h",
      pricedAtIso: TUE,
      marketEnd: marketHorizonEnd,
      calendarLookaheadMs: HORIZON_MS["1h"],
    })!;
    expect(h.bars).toBe(12);
    expect(h.bar_ms).toBe(HOUR);
    expect(h.source).toBe("interval_table_v1");
    expect(h.declared_at).toBe(TUE);
    // Mid-week: market time and wall clock agree.
    expect(h.ends_at).toBe(new Date(Date.parse(TUE) + 12 * HOUR).toISOString());
    expect(h.calendar_covers_horizon).toBe(true);
  });

  it("walks past a weekend, and then says the calendar no longer covers it", () => {
    // Friday 20:00Z, two hours before the close. The calendar is spent in WALL
    // clock because a release is scheduled in wall clock; the plan's window is
    // walked in MARKET time. On a Friday the two come apart, and the row has to
    // record which way rather than assert they agree.
    const FRI = "2026-09-11T20:00:00.000Z";
    const h = buildPlanHorizon({
      interval: "1h",
      pricedAtIso: FRI,
      marketEnd: marketHorizonEnd,
      calendarLookaheadMs: HORIZON_MS["1h"],
    })!;
    const wallEnd = Date.parse(FRI) + 12 * HOUR;
    expect(Date.parse(h.ends_at)).toBeGreaterThan(wallEnd);
    expect(new Date(h.ends_at).getUTCDay()).toBe(1); // Monday
    expect(h.calendar_covers_horizon).toBe(false);
  });

  it("refuses an interval the table does not cover rather than inventing a default", () => {
    // A number nobody chose for this timeframe, stored as though somebody had,
    // is the class of claim this whole module exists to stop.
    expect(buildPlanHorizon({
      interval: "1week",
      pricedAtIso: TUE,
      marketEnd: marketHorizonEnd,
      calendarLookaheadMs: 0,
    })).toBeNull();
    expect(horizonBars("1week")).toBeNull();
    expect(horizonWallMs("1week")).toBeNull();
  });

  it("refuses an unparsable instant", () => {
    expect(buildPlanHorizon({
      interval: "1h",
      pricedAtIso: "not a date",
      marketEnd: marketHorizonEnd,
      calendarLookaheadMs: 0,
    })).toBeNull();
  });
});

// The sentence the analyst reads is the one thing here that also lands in the
// reuse key: it is interpolated into the user message, and the key is a digest
// of that message. `horizonDeclared` takes bars, hours and a timeframe label —
// no instant — so two analyses an hour apart on the same snapshot still share
// a key. That is a property of the SIGNATURE, and a signature is exactly what
// a later edit widens without noticing: adding `endsAt` to the sentence would
// give every run a different key, reuse would stop firing for every pair, and
// nothing would report it, because a cache that never hits looks identical to
// a cache that was never asked.
describe("the declared sentence carries no instant", () => {
  it("renders the same bytes whatever the clock says, in both locales", () => {
    for (const locale of ["ja", "en"] as const) {
      const L = stringsFor(locale);
      const sentence = L.horizonDeclared({ tfLabel: "1h", bars: 12, hours: 12 });
      // said twice with the same inputs: no hidden clock inside
      expect(sentence, locale).toBe(L.horizonDeclared({ tfLabel: "1h", bars: 12, hours: 12 }));
      // and nothing shaped like a date or a time of day
      expect(sentence, locale).not.toMatch(/\d{4}-\d{2}-\d{2}/);
      expect(sentence, locale).not.toMatch(/\d{1,2}:\d{2}/);
      expect(sentence, locale).not.toContain("Z");
      expect(sentence, locale).not.toContain("UTC");
      // it does say the two numbers it is allowed to say
      expect(sentence, locale).toContain("12");
      expect(sentence, locale).toContain("1h");
    }
  });

  it("says the count is not a deadline, so a winner is not cut to fit it", () => {
    // The count is a target, not a cutoff: measured on the 53 settled rows,
    // truncating at 24 bars would have discarded 2 — and BOTH were wins. The
    // sentence has to say so, or the model trims its targets to the count.
    expect(stringsFor("ja").horizonDeclared({ tfLabel: "1h", bars: 12, hours: 12 }))
      .toContain("期限ではありません");
    expect(stringsFor("en").horizonDeclared({ tfLabel: "1h", bars: 12, hours: 12 }))
      .toContain("NOT a deadline");
  });
});
