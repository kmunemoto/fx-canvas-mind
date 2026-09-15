import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolveScoringWindows } from "../../supabase/functions/_shared/horizon.ts";
import { ENTRY_WINDOW_MS, EXPIRY_DAYS } from "../../supabase/functions/track-outcomes/evaluate.ts";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const table = (interval: string) => ({
  unfilledEntryMs: ENTRY_WINDOW_MS[interval],
  waitWindowMs: ENTRY_WINDOW_MS[interval],
  giveUpDays: EXPIRY_DAYS[interval],
});

const stored = (over: Record<string, unknown> = {}) => ({
  version: 1,
  unfilled_entry_ms: 48 * HOUR,
  wait_window_ms: 48 * HOUR,
  give_up_days: 20,
  ...over,
});

describe("a plan is scored under the windows it was issued with", () => {
  it("reads the row when the row has them, and says so", () => {
    const w = resolveScoringWindows(stored({ give_up_days: 7 }), table("1h"));
    expect(w.source).toBe("row");
    expect(w.give_up_days).toBe(7);
    // and that is NOT what the table says today — so the row really won
    expect(w.give_up_days).not.toBe(EXPIRY_DAYS["1h"]);
  });

  it("falls back to the table for every row written before the freeze", () => {
    // 108 of the 109 production rows were in this state the day this shipped.
    for (const absent of [null, undefined, {}, [], "", 0, "not an object"]) {
      const w = resolveScoringWindows(absent, table("1h"));
      expect(w.source, JSON.stringify(absent)).toBe("table");
      expect(w.unfilled_entry_ms).toBe(ENTRY_WINDOW_MS["1h"]);
      expect(w.give_up_days).toBe(EXPIRY_DAYS["1h"]);
    }
  });

  it("refuses a half-readable object rather than mixing the two sources", () => {
    // Taking one leg from the row and another from the table is the exact
    // disagreement this reader exists to prevent — and `source` could not then
    // name the truth whichever value it reported.
    const broken = [
      stored({ unfilled_entry_ms: null }),
      stored({ wait_window_ms: 0 }),
      stored({ give_up_days: -1 }),
      stored({ give_up_days: "20" }),
      stored({ unfilled_entry_ms: Number.NaN }),
      stored({ version: 2 }),
      stored({ version: undefined }),
    ];
    for (const b of broken) {
      const w = resolveScoringWindows(b, table("1h"));
      expect(w.source, JSON.stringify(b)).toBe("table");
      expect(w.give_up_days).toBe(EXPIRY_DAYS["1h"]);
    }
  });

  // The claim the whole change rests on, made checkable rather than asserted.
  it("changes no verdict on the data that exists today", () => {
    // Measured on production the day this shipped: 109 non-shadow non-preview
    // rows, of which 108 carry no scoring_windows at all and exactly one does
    // — a 1day row holding give_up_days 180 and unfilled_entry_ms 2,592,000,000.
    // Both are identical to the live table, so freezing the clocks cannot move
    // a single judgement.
    const theOneStoredRow = {
      version: 1,
      give_up_days: 180,
      wait_window_ms: 2_592_000_000,
      unfilled_entry_ms: 2_592_000_000,
    };
    const frozen = resolveScoringWindows(theOneStoredRow, table("1day"));
    const live = resolveScoringWindows(null, table("1day"));
    expect(frozen.source).toBe("row");
    expect(live.source).toBe("table");
    // same numbers by both routes
    expect(frozen.unfilled_entry_ms).toBe(live.unfilled_entry_ms);
    expect(frozen.give_up_days).toBe(live.give_up_days);
    expect(frozen.wait_window_ms).toBe(live.wait_window_ms);
    // and those really are the table's 1day values
    expect(live.unfilled_entry_ms).toBe(30 * DAY);
    expect(live.give_up_days).toBe(180);
  });

  it("agrees with what analyze freezes onto the row, on every interval", () => {
    // analyze stamps unfilled_entry_ms and wait_window_ms from the SAME
    // constant, so a row's two windows are equal at issue. If the scorer's
    // fallback ever disagreed with what analyze writes, a row written today
    // and a row written yesterday would be judged differently for no reason.
    for (const iv of ["15min", "1h", "4h", "1day"]) {
      const asIssued = {
        version: 1,
        unfilled_entry_ms: ENTRY_WINDOW_MS[iv],
        wait_window_ms: ENTRY_WINDOW_MS[iv],
        give_up_days: EXPIRY_DAYS[iv],
      };
      const w = resolveScoringWindows(asIssued, table(iv));
      const fallback = resolveScoringWindows(null, table(iv));
      expect(w.unfilled_entry_ms, iv).toBe(fallback.unfilled_entry_ms);
      expect(w.give_up_days, iv).toBe(fallback.give_up_days);
    }
  });
});

// The guard against the failure this project keeps repeating: fixing one of N
// sites. Five places read the two window tables for SCORING, and all five must
// now go through the one reader — otherwise a row is judged through one window
// and diagnosed through another, with nothing on it to say so.
describe("every scoring clock goes through the one reader", () => {
  const SITES: Array<{ file: string; why: string }> = [
    { file: "supabase/functions/track-outcomes/evaluate.ts", why: "the unfilled-entry and give-up windows" },
    { file: "supabase/functions/track-outcomes/index.ts", why: "the WAIT scorer's horizon" },
    { file: "supabase/functions/postmortem/index.ts", why: "the WAIT diagnosis window — the same horizon the scorer walked" },
    { file: "supabase/functions/postmortem/facts.ts", why: "life_used_ratio's denominator" },
  ];

  it("no scorer reads the window tables except through resolveScoringWindows", () => {
    for (const { file, why } of SITES) {
      const src = readFileSync(file, "utf8");
      expect(src, `${file} (${why}) must call the shared reader`).toContain("resolveScoringWindows");
      // Every remaining mention of the tables must be inside a call to the
      // reader — i.e. as the FALLBACK it is handed, never as the value used.
      const direct = src.split("\n").filter((line) =>
        /(ENTRY_WINDOW_MS|EXPIRY_DAYS)\[/.test(line) &&
        !/(unfilledEntryMs|waitWindowMs|giveUpDays):/.test(line)
      );
      expect(direct, `${file}: these read a window table outside the reader`).toEqual([]);
    }
  });

  it("both selects actually fetch the column, or the freeze is a silent no-op", () => {
    // Without scoring_windows in the SELECT every row arrives undefined, the
    // reader answers "table" for all of them, and the freeze reports success
    // while doing nothing.
    const tracker = readFileSync("supabase/functions/track-outcomes/index.ts", "utf8");
    // The two are built differently — the trade one as a named constant, the
    // WAIT one inline in the URL — so each is found by what it selects rather
    // than by a single pattern over both.
    const tradeSelect = tracker.split("\n").find((l) => /const select = "id,pair,interval,signal/.test(l));
    expect(tradeSelect, "the trade select moved; this guard is now blind").toBeTruthy();
    expect(tradeSelect, "the trade scorer would see every row as unfrozen")
      .toContain("scoring_windows");

    const waitSelect = tracker.split("\n").find((l) => l.includes("wait_plan") && l.includes("select="));
    expect(waitSelect, "the WAIT select moved; this guard is now blind").toBeTruthy();
    expect(waitSelect, "the WAIT scorer would see every row as unfrozen")
      .toContain("scoring_windows");
    expect(readFileSync("supabase/functions/postmortem/index.ts", "utf8"))
      .toContain('"scoring_windows"');
  });
});

// ---------------------------------------------------------------------------
// (d) PACE — the fourth axis, and the one that must never be read as a score
// ---------------------------------------------------------------------------

describe("pace states the period and refuses to grade it", () => {
  it("reads the server's object, and treats an older server as 'not measured'", async () => {
    const { readSeparatedScores } = await import("../lib/outcomeStats");
    // A server that predates #91 step 2 sends no `pace` key at all. That must
    // read as n = 0 with a NULL rate — "no answer" — never as 0%.
    const old = readSeparatedScores({
      generated_at: null, live_contract: "market_v1", definition_version: 1,
      thresholds: {}, population: {}, scopes: { all_time: { graded_trades: 3 } },
      by_contract: {}, other_contract_rows: 0, other_contracts: [],
    });
    expect(old?.scopes.all_time.pace.n).toBe(0);
    expect(old?.scopes.all_time.pace.rate).toBeNull();
    expect(old?.scopes.all_time.pace.descriptive).toBe(false);

    const now = readSeparatedScores({
      generated_at: null, live_contract: "market_v1", definition_version: 1,
      thresholds: {}, population: {},
      scopes: {
        all_time: {
          graded_trades: 10,
          pace: {
            n: 8, inside: 5, outside: 3, rate: 63, ci95: [30, 88],
            no_horizon: 42, open_past_horizon: 1, untriggered: 2, expired: 0,
            below_min_n: true, descriptive: true,
          },
        },
      },
      by_contract: {}, other_contract_rows: 0, other_contracts: [],
    });
    const p = now?.scopes.all_time.pace;
    expect(p?.n).toBe(8);
    expect(p?.inside).toBe(5);
    expect(p?.outside).toBe(3);
    expect(p?.rate).toBe(63);
    expect(p?.ci).toEqual([30, 88]);
    // The rows the rate could NOT be taken on are carried, not dropped.
    expect(p?.noHorizon).toBe(42);
    expect(p?.openPastHorizon).toBe(1);
    expect(p?.descriptive).toBe(true);
    expect(p?.belowMinN).toBe(true);
  });

  it("never lets inside + outside exceed its own denominator", async () => {
    const { readSeparatedScores } = await import("../lib/outcomeStats");
    const s = readSeparatedScores({
      generated_at: null, live_contract: "market_v1", definition_version: 1,
      thresholds: {}, population: {},
      scopes: { all_time: { graded_trades: 10, pace: { n: 8, inside: 5, outside: 3 } } },
      by_contract: {}, other_contract_rows: 0, other_contracts: [],
    });
    const p = s!.scopes.all_time.pace;
    // The server computes all three over one population; a client that ever
    // saw them disagree would be rendering a percentage over the wrong base.
    expect(p.inside + p.outside).toBe(p.n);
  });

  it("says in both locales that this is not a score", async () => {
    const { ja } = await import("../lib/i18n/ja");
    const { en } = await import("../lib/i18n/en");
    for (const d of [ja, en]) {
      expect(d.scores.pace.notAScore.length).toBeGreaterThan(20);
      // and the hint must name the different population, because the three
      // axes above it share a heading and not a denominator
      expect(d.scores.pace.hint.length).toBeGreaterThan(20);
    }
    expect(ja.scores.pace.notAScore).toContain("成績ではありません");
    expect(en.scores.pace.notAScore).toContain("not a score");
    expect(en.scores.pace.notAScore).not.toMatch(/[ぁ-んァ-ヶ一-龠]/);
    expect(en.scores.pace.hint).not.toMatch(/[ぁ-んァ-ヶ一-龠]/);
  });
});
