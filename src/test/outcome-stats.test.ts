import { describe, it, expect } from "vitest";
import {
  byConfidence, byContract, byMode, byRulebookVersion, byTimeframe,
  confidenceBandKey, contractKey, headlineScope, realizedR, serverTally, tally,
} from "../lib/outcomeStats";
import type { AnalysisRecord, OutcomeEvaluation } from "../lib/types";

const baseEvaluation: OutcomeEvaluation = {
  version: 5,
  eval_interval: "1h",
  order_type: "market",
  price_at_signal: 150.2,
  possible_fill: false,
  filled_at: null,
  fill_price: null,
  resolution: "ambiguous",
  reason: null,
  resolved_at: null,
  refined: false,
  refine_pending: false,
  refine_attempts: 0,
  mfe: null,
  mae: null,
  mfe_r: null,
  mae_r: null,
  tps_hit: [],
  bars_after_signal: 0,
  window_covers_signal: true,
  first_candle_at: null,
  last_candle_at: null,
  checked_at: "2026-09-03T00:00:00Z",
  note: null,
  path: [],
};

const rec = (over: Partial<AnalysisRecord>): AnalysisRecord => ({
  id: Math.random().toString(36).slice(2),
  pair: "USD/JPY",
  interval: "1h",
  mode: "full",
  signal: "BUY",
  confidence: 70,
  thesis: null,
  entry_point: 150,
  stop_loss: 149,
  take_profit_1: 152,
  take_profit_2: null,
  take_profit_3: null,
  price_at_signal: 150.2,
  outcome: "pending",
  outcome_price: null,
  created_at: "2026-08-20T00:00:00Z",
  closed_at: null,
  evaluation: null,
  ...over,
});

describe("tally", () => {
  it("keeps WAIT out of the win rate but never out of the call count", () => {
    const t = tally("all", [
      rec({ outcome: "win" }),
      rec({ outcome: "win" }),
      rec({ outcome: "loss" }),
      rec({ outcome: "untriggered" }),
      rec({ outcome: "ambiguous" }),
      rec({ outcome: "pending" }),
      rec({ signal: "WAIT", outcome: "skipped" }),
    ]);
    expect(t.total).toBe(6);
    // The WAIT is not a trade, so it is not in `total`, but it IS a call
    expect(t.calls).toBe(7);
    expect(t.waits).toBe(1);
    expect(t.wins).toBe(2);
    expect(t.losses).toBe(1);
    expect(t.untriggered).toBe(1);
    expect(t.ambiguous).toBe(1);
    expect(t.open).toBe(1);
    expect(t.winRate).toBe(67);
    // 3 verdicts out of 7 calls
    expect(t.verdictRate).toBe(43);
  });

  it("has no rate before anything settles", () => {
    expect(tally("all", [rec({ outcome: "pending" })]).winRate).toBeNull();
    expect(tally("all", [rec({ outcome: "pending" })]).fillRate).toBeNull();
  });

  it("measures how often the entry was actually reached", () => {
    // 2 filled (win, loss) + 1 expired counts as filled; 3 never triggered
    const t = tally("all", [
      rec({ outcome: "win" }),
      rec({ outcome: "loss" }),
      rec({ outcome: "expired" }),
      rec({ outcome: "untriggered" }),
      rec({ outcome: "untriggered" }),
      rec({ outcome: "untriggered" }),
      rec({ outcome: "pending" }),
      rec({ outcome: "ambiguous" }),
    ]);
    expect(t.fillRate).toBe(50);
    // The record as it stood before the entry fix: 1 filled, 5 never reached
    const before = tally("all", [
      rec({ outcome: "loss" }),
      ...Array.from({ length: 5 }, () => rec({ outcome: "untriggered" })),
    ]);
    expect(before.fillRate).toBe(17);
  });
});

describe("groupings", () => {
  const records = [
    rec({ interval: "1h", outcome: "win", mode: "full", confidence: 72 }),
    rec({ interval: "4h", outcome: "loss", mode: "technical_only", confidence: 65 }),
    rec({ interval: "15min", outcome: "win", mode: "technical_only", confidence: 81 }),
    rec({ interval: "1h", outcome: "pending", mode: "full", confidence: 55 }),
  ];

  it("orders timeframes from fastest to slowest and drops empty ones", () => {
    expect(byTimeframe(records).map((g) => g.key)).toEqual(["15min", "1h", "4h"]);
    expect(byTimeframe(records).find((g) => g.key === "1h")).toMatchObject({ wins: 1, open: 1, winRate: 100 });
  });

  it("groups by analysis mode", () => {
    expect(byMode(records).map((g) => [g.key, g.wins, g.losses])).toEqual([
      ["full", 1, 0],
      ["technical_only", 1, 1],
    ]);
  });

  it("buckets confidence into bands", () => {
    expect(confidenceBandKey(55)).toBe("0-59");
    expect(confidenceBandKey(65)).toBe("60-69");
    expect(confidenceBandKey(72)).toBe("70-79");
    expect(confidenceBandKey(81)).toBe("80+");
    expect(confidenceBandKey(null)).toBe("unknown");
    expect(byConfidence(records).map((g) => g.key)).toEqual(["0-59", "60-69", "70-79", "80+"]);
    expect(byConfidence([...records, rec({ confidence: null, outcome: "win" })]).map((g) => g.key)).toEqual(["0-59", "60-69", "70-79", "80+", "unknown"]);
  });
});

describe("the honest record", () => {
  const sell = { signal: "SELL" as const, entry_point: 150, stop_loss: 151, take_profit_1: 148 };

  it("scores settled plans in R and says what the rate rests on", () => {
    const t = tally("all", [
      rec({ outcome: "win", created_at: "2026-09-03T04:00:00Z" }), // BUY 150 / 149 / 152: +2R
      rec({ outcome: "loss", ...sell, created_at: "2026-09-03T04:00:00Z" }),
      // the same situation an hour later: one cluster with the loss above
      rec({ outcome: "loss", ...sell, created_at: "2026-09-03T05:00:00Z" }),
      rec({ outcome: "expired", outcome_price: 150.5, created_at: "2026-09-05T04:00:00Z" }), // +0.5R
      rec({ outcome: "untriggered" }),
    ]);
    expect(t.wins).toBe(1);
    expect(t.losses).toBe(2);
    // An expiry counts against the rate: 1 win out of win+loss+expired = 4.
    // Leaving it out let a target placed beyond reach sit out the number
    // entirely, which is the whole reason a plan would be written that way.
    expect(t.expired).toBe(1);
    expect(t.winRate).toBe(25);
    expect(t.winRateCi).toEqual([5, 70]);
    expect(t.clusters).toBe(2);
    expect(t.sumR).toBe(0.5);
    expect(t.expectancy).toBe(0.13);
  });

  it("partitions every call, so a new way to dodge a verdict shows up as a falling rate", () => {
    const t = tally("all", [
      rec({ outcome: "win" }),
      rec({ outcome: "loss", ...sell }),
      rec({ outcome: "expired", outcome_price: 150.5 }),
      rec({ outcome: "untriggered" }),
      rec({ outcome: "pending" }),
      rec({ signal: "WAIT", outcome: "skipped" }),
      rec({ signal: "WAIT", outcome: "skipped" }),
      rec({
        outcome: "ambiguous",
        evaluation: { ...baseEvaluation, reason: "incoherent" },
      }),
    ]);
    expect(t.calls).toBe(8);
    // A WAIT is still a call. Excluding it from the denominator is exactly how
    // "never trade, never be wrong" would hide.
    expect(t.waits).toBe(2);
    expect(t.incoherent).toBe(1);
    // 2 of 8 calls produced a verdict
    expect(t.verdictRate).toBe(25);
    expect(t.waitRate).toBe(25);
    // Every call lands in exactly ONE bucket. Asserted on the counts, which is
    // where the invariant actually lives: the percentages are each rounded on
    // their own and so can sum to a couple either side of 100.
    const counted = t.wins + t.losses + t.expired + t.untriggered +
      t.ambiguous + t.incoherent + t.open + t.waits;
    expect(counted).toBe(t.calls);
    const buckets = [
      t.verdictRate, t.waitRate, t.expiredRate, t.untriggeredRate,
      t.ambiguousRate, t.incoherentRate, t.openRate,
    ];
    expect(buckets.every((b) => b !== null)).toBe(true);
    expect(buckets.reduce((a, b) => (a ?? 0) + (b ?? 0), 0)).toBeGreaterThan(95);
    expect(buckets.reduce((a, b) => (a ?? 0) + (b ?? 0), 0)).toBeLessThan(105);
  });

  it("accounts for every call on the real production mix", () => {
    // The record as it actually stood: 1 win, 7 losses, 7 untriggered,
    // 3 WAIT, 1 open. Only 8 of 19 calls ever produced a verdict.
    const t = tally("all", [
      rec({ outcome: "win" }),
      ...Array.from({ length: 7 }, () => rec({ outcome: "loss" })),
      ...Array.from({ length: 7 }, () => rec({ outcome: "untriggered" })),
      ...Array.from({ length: 3 }, () => rec({ signal: "WAIT", outcome: "skipped" })),
      rec({ outcome: "pending" }),
    ]);
    expect(t.calls).toBe(19);
    expect(t.verdictRate).toBe(42);
    expect(t.untriggeredRate).toBe(37);
    expect(t.waitRate).toBe(16);
  });

  it("counts a malformed plan as a defect, not as an ordinary unknown", () => {
    const t = tally("all", [
      rec({ outcome: "ambiguous", evaluation: { ...baseEvaluation, reason: "incoherent" } }),
      rec({ outcome: "ambiguous", evaluation: { ...baseEvaluation, reason: null } }),
    ]);
    expect(t.incoherent).toBe(1);
    expect(t.ambiguous).toBe(1);
  });

  it("splits the record by rulebook version, before-rules first", () => {
    const groups = byRulebookVersion([
      rec({ outcome: "win", rulebook_version: 3 }),
      rec({ outcome: "loss", rulebook_version: null }),
      // the seeded, empty rulebook: no rules in force either
      rec({ outcome: "loss", rulebook_version: 0 }),
      rec({ outcome: "loss", rulebook_version: 2 }),
      rec({ outcome: "pending", rulebook_version: 10 }),
    ]);
    // Keys carry the contract as well as the version: a change of entry
    // contract must never be readable as a change of rulebook.
    expect(groups.map((g) => g.key)).toEqual([
      "entry_chosen_v1|none",
      "entry_chosen_v1|v2",
      "entry_chosen_v1|v3",
      "entry_chosen_v1|v10",
    ]);
    expect(groups[0]).toMatchObject({ losses: 2, sumR: -2 });
    expect(groups[2]).toMatchObject({ wins: 1, sumR: 2 });
  });

  it("prices a settled plan in multiples of its risk", () => {
    expect(realizedR(rec({ outcome: "win" }))).toBe(2);
    expect(realizedR(rec({ outcome: "loss" }))).toBe(-1);
    expect(realizedR(rec({ outcome: "expired", outcome_price: 149.5 }))).toBe(-0.5);
    expect(realizedR(rec({ outcome: "expired", ...sell, outcome_price: 149.5 }))).toBe(0.5);
    expect(realizedR(rec({ outcome: "pending" }))).toBeNull();
    expect(realizedR(rec({ outcome: "untriggered" }))).toBeNull();
  });
});

describe("standing aside is scored too", () => {
  const wait = (verdict: string | null) =>
    rec({
      signal: "WAIT",
      outcome: "skipped",
      wait_check: verdict === null
        ? null
        : {
            verdict: verdict as "missed" | "correct" | "pending" | "unknown",
            direction: "BUY", r: 1.2, at: "2026-09-03T09:00:00Z",
            price: 150, atr: 0.2, risk: 0.08, reward: 0.096,
            bars_examined: 40, horizon_ms: 48 * 3_600_000,
            checked_at: "2026-09-03T12:00:00Z",
            scorer: 2,
          },
    });

  it("counts only the WAITs a verdict was actually reached on", () => {
    // 'pending' has not been looked at yet and 'unknown' never can be. Putting
    // either in the denominator would make over-caution look rarer the slower
    // the tracker runs.
    const t = tally("all", [
      wait("missed"), wait("missed"), wait("correct"), wait("correct"),
      wait("pending"), wait("unknown"), wait(null),
    ]);
    expect(t.waits).toBe(7);
    expect(t.waitsJudged).toBe(4);
    expect(t.waitsMissed).toBe(2);
    expect(t.waitMissRate).toBe(50);
  });

  it("has no miss rate before anything has been judged", () => {
    const t = tally("all", [wait("pending"), wait(null)]);
    expect(t.waitsJudged).toBe(0);
    expect(t.waitMissRate).toBeNull();
  });
});

describe("two entry contracts are never pooled", () => {
  it("treats a row with no contract as the legacy one", () => {
    expect(contractKey(rec({}))).toBe("entry_chosen_v1");
    expect(contractKey(rec({ plan_contract: "market_v1" }))).toBe("market_v1");
  });

  it("refuses EVERY rate when the rows span both contracts", () => {
    const t = tally("all", [
      rec({ outcome: "win", plan_contract: "entry_chosen_v1" }),
      rec({ outcome: "loss", plan_contract: "market_v1" }),
      rec({ outcome: "untriggered", plan_contract: "entry_chosen_v1" }),
    ]);
    expect(t.contracts).toEqual(["entry_chosen_v1", "market_v1"]);
    // Counts are still true — it is the RATES that would describe a population
    // that never existed. An untriggeredRate rendered under a contract where
    // untriggered cannot happen is a lie of its own.
    expect(t.wins).toBe(1);
    expect(t.calls).toBe(3);
    expect(t.winRate).toBeNull();
    expect(t.winRateCi).toBeNull();
    expect(t.verdictRate).toBeNull();
    expect(t.untriggeredRate).toBeNull();
    expect(t.waitRate).toBeNull();
    expect(t.fillRate).toBeNull();
    expect(t.expectancy).toBeNull();
    expect(t.sumR).toBeNull();
  });

  it("computes normally once the rows are one contract", () => {
    const t = tally("m", [
      rec({ outcome: "win", plan_contract: "market_v1" }),
      rec({ outcome: "loss", plan_contract: "market_v1" }),
    ]);
    expect(t.contracts).toEqual(["market_v1"]);
    expect(t.winRate).toBe(50);
    expect(t.verdictRate).toBe(100);
  });

  it("splits the record by contract so both can be read side by side", () => {
    const groups = byContract([
      rec({ outcome: "win", plan_contract: "market_v1" }),
      rec({ outcome: "loss" }),
      rec({ outcome: "untriggered" }),
    ]);
    expect(groups.map((g) => g.key)).toEqual(["entry_chosen_v1", "market_v1"]);
    expect(groups[0]).toMatchObject({ losses: 1, untriggered: 1 });
    expect(groups[1]).toMatchObject({ wins: 1 });
  });

  it("orders the rulebook table by contract then version, not by NaN", () => {
    // The old comparator did Number(key.slice(1)) on what is now a composite
    // key, so every comparison was NaN and the table came out in Map order.
    const groups = byRulebookVersion([
      rec({ outcome: "win", rulebook_version: 5, plan_contract: "market_v1" }),
      rec({ outcome: "loss", rulebook_version: 2 }),
      rec({ outcome: "loss", rulebook_version: 10 }),
      rec({ outcome: "loss", rulebook_version: 1, plan_contract: "market_v1" }),
    ]);
    expect(groups.map((g) => g.key)).toEqual([
      "entry_chosen_v1|v2",
      "entry_chosen_v1|v10",
      "market_v1|v1",
      "market_v1|v5",
    ]);
  });

  it("keeps an all-WAIT bucket in the breakdown instead of dropping it", () => {
    // Filtering on `total` hid exactly the behaviour the WAIT rate exists to
    // show: a confidence band the analyst never traded from.
    const groups = byConfidence([
      rec({ confidence: 40, signal: "WAIT", outcome: "skipped" }),
      rec({ confidence: 75, outcome: "win" }),
    ]);
    expect(groups.map((g) => g.key)).toContain("0-59");
    expect(groups.find((g) => g.key === "0-59")).toMatchObject({ waits: 1, total: 0, calls: 1 });
  });
});

// The statistics moved to the server because they were being computed from
// the forty rows the client happened to fetch. The adapter below is what lets
// the panel switch source without a second set of render branches, so its
// field mapping is the whole contract.
describe("the record comes from the server, not from the page", () => {
  const group = {
    calls: 21, waits: 3, rejected: 0, waits_judged: 0, waits_missed: 0,
    total: 18, wins: 2, losses: 8, expired: 0, open: 1, untriggered: 7,
    ambiguous: 0, incoherent: 0, filled: 10, settled: 17, decided: 10,
    with_r: 10, clusters: 3, contracts: ["market_v1"],
    win_rate: 20, win_rate_ci95: [6, 51] as [number, number], fill_rate: 59,
    sum_r: -4.74, expectancy: -0.47, trades_per_call: 0.86, verdict_rate: 48,
    wait_rate: 14, expired_rate: 0, untriggered_rate: 33, ambiguous_rate: 0,
    incoherent_rate: 0, open_rate: 5, wait_miss_rate: null, below_min_n: true,
  };

  it("maps every field the panel draws", () => {
    const t = serverTally("all", group);
    expect(t.calls).toBe(21);
    expect(t.wins).toBe(2);
    expect(t.losses).toBe(8);
    expect(t.winRate).toBe(20);
    expect(t.winRateCi).toEqual([6, 51]);
    // The three that make a rate readable: how many trades it rests on, what
    // they paid, and how many independent situations they came from
    expect(t.expectancy).toBe(-0.47);
    expect(t.sumR).toBe(-4.74);
    expect(t.clusters).toBe(3);
    expect(t.fillRate).toBe(59);
    expect(t.waitRate).toBe(14);
  });

  it("falls back to an older contract's record rather than showing nothing", () => {
    // Every plan can predate the current contract — production is exactly
    // that today — and filtering the record away because of it would leave
    // the owner with an empty panel instead of a labelled one.
    const empty = { ...group, calls: 0, total: 0, wins: 0, losses: 0, decided: 0 };
    const stats = {
      generated_at: "2026-09-05T18:00:00Z",
      live_contract: "market_v1",
      scopes: { all_time: empty },
      by_rulebook_version: {}, by_confidence: {}, by_timeframe: {}, by_mode: {},
      by_contract: { entry_chosen_v1: group },
      other_contract_rows: 21, other_contracts: ["entry_chosen_v1"],
      shadow: { total: 0, untriggered: 0, wins: 0, losses: 0, open: 0, other: 0 },
    };
    const picked = headlineScope(stats);
    expect(picked?.contract).toBe("entry_chosen_v1");
    expect(picked?.group.calls).toBe(21);

    // And once the live contract has calls of its own, that is the record
    const live = { ...stats, scopes: { all_time: group } };
    expect(headlineScope(live)?.contract).toBeNull();
  });

  it("does not pool two contracts to fill the panel", () => {
    const stats = {
      generated_at: "2026-09-05T18:00:00Z",
      live_contract: "market_v1",
      scopes: { all_time: { ...group, calls: 0, total: 0, wins: 0, losses: 0, decided: 0 } },
      by_rulebook_version: {}, by_confidence: {}, by_timeframe: {}, by_mode: {},
      by_contract: { entry_chosen_v1: group, some_other_v1: group },
      other_contract_rows: 42, other_contracts: ["entry_chosen_v1", "some_other_v1"],
      shadow: { total: 0, untriggered: 0, wins: 0, losses: 0, open: 0, other: 0 },
    };
    // Two candidates and no live rows: show the empty live scope rather than
    // pick one arbitrarily or add them together
    expect(headlineScope(stats)?.contract).toBeNull();
    expect(headlineScope(stats)?.group.calls).toBe(0);
  });
});
