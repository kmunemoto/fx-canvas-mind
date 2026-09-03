import { describe, it, expect } from "vitest";
import { byConfidence, byMode, byRulebookVersion, byTimeframe, confidenceBandKey, realizedR, tally } from "../lib/outcomeStats";
import type { AnalysisRecord } from "../lib/types";

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
  it("counts only WIN and LOSS toward the rate and ignores WAIT rows", () => {
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
    expect(t.wins).toBe(2);
    expect(t.losses).toBe(1);
    expect(t.untriggered).toBe(1);
    expect(t.ambiguous).toBe(1);
    expect(t.open).toBe(1);
    expect(t.winRate).toBe(67);
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
    expect(t.winRate).toBe(33);
    expect(t.winRateCi).toEqual([6, 79]);
    expect(t.clusters).toBe(2);
    expect(t.sumR).toBe(0.5);
    expect(t.expectancy).toBe(0.13);
  });

  it("splits the record by rulebook version, before-rules first", () => {
    const groups = byRulebookVersion([
      rec({ outcome: "win", rulebook_version: 3 }),
      rec({ outcome: "loss", rulebook_version: null }),
      rec({ outcome: "loss", rulebook_version: 2 }),
      rec({ outcome: "pending", rulebook_version: 10 }),
    ]);
    expect(groups.map((g) => g.key)).toEqual(["none", "v2", "v3", "v10"]);
    expect(groups[0]).toMatchObject({ losses: 1, sumR: -1 });
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
