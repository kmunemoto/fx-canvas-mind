import { describe, it, expect } from "vitest";
import {
  AFTER_WAIT_MS,
  CAUSES,
  causesFor,
  computeFacts,
  isCause,
  isPostmortemDue,
  type PostmortemRow,
} from "../../supabase/functions/postmortem/facts.ts";
import {
  CONSOLIDATION_SCHEMA,
  DIAGNOSIS_SCHEMA,
  diagnosisSchema,
  MAX_RULES,
  buildConsolidationPrompt,
  buildDiagnosisPrompt,
  citationAllowed,
  clusterIds,
  fairShare,
  parseConsolidation,
  parseDiagnosis,
  revisionDue,
  summarizeRecord,
  wilson,
  withClusters,
  type PlanSummary,
  type RecordRow,
} from "../../supabase/functions/postmortem/prompt.ts";
import {
  MAX_PROMPT_CHARS,
  inForce,
  parseRules,
  renderLearnedRules,
  type Rule,
} from "../../supabase/functions/analyze/rules.ts";
import { emptyEvaluation, type Evaluation } from "../../supabase/functions/track-outcomes/evaluate.ts";
import type { Candle } from "../../supabase/functions/analyze/indicators.ts";

const candle = (datetime: string, high: number, low: number, open?: number, close?: number): Candle => ({
  datetime,
  open: open ?? (high + low) / 2,
  high,
  low,
  close: close ?? (high + low) / 2,
});

const T0 = "2026-08-20T00:00:00Z";
const HOUR = 3_600_000;
const at = (hours: number) => Date.parse(T0) + hours * HOUR;
const iso = (hours: number) => new Date(at(hours)).toISOString();
const stamp = (hours: number) => new Date(at(hours)).toISOString().slice(0, 19).replace("T", " ");
const quiet = (from: number, to: number, high: number, low: number): Candle[] => {
  const out: Candle[] = [];
  for (let h = from; h < to; h++) out.push(candle(stamp(h), high, low));
  return out;
};

// BUY at the market: 150, SL 149 (risk 1), TP1 152 (reward 2)
const buyMarket: PostmortemRow = {
  id: "1",
  pair: "USD/JPY",
  interval: "1h",
  signal: "BUY",
  entry_point: 150,
  stop_loss: 149,
  take_profit_1: 152,
  take_profit_2: 153,
  take_profit_3: 154,
  created_at: T0,
  price_at_signal: 150,
  evaluation: null,
  outcome: "pending",
  closed_at: null,
};

const evaluated = (row: PostmortemRow, over: Partial<Evaluation>, outcome: string, closedAt: string): PostmortemRow => ({
  ...row,
  outcome,
  closed_at: closedAt,
  evaluation: { ...emptyEvaluation(row, "1h", at(48)), order_type: "market", ...over },
});

const NOW = at(48);

describe("facts — losses", () => {
  it("calls a stop that was hit before the target came 'too tight', with the counterfactual to prove it", async () => {
    // Filled at the signal, stopped at hour 2, then price ran to TP1 by
    // hour 6: a stop 2R wide would have won
    const row = evaluated(buyMarket, {
      filled_at: iso(0), resolved_at: iso(2), resolution: "loss", mfe_r: 0.3, mae_r: 1,
    }, "loss", iso(2));
    const candles = [
      candle(stamp(-1), 150.2, 149.8),
      candle(stamp(0), 150.3, 149.9),
      candle(stamp(1), 150.3, 149.6),
      candle(stamp(2), 149.7, 148.9), // SL
      candle(stamp(3), 150.2, 149.3),
      candle(stamp(4), 151.0, 150.0),
      candle(stamp(5), 151.8, 150.9),
      candle(stamp(6), 152.3, 151.5), // TP1, after the stop
      ...quiet(7, 30, 152.2, 151.8),
    ];
    const f = await computeFacts(row, candles, "1h", NOW);
    expect(f.after.reached_tp1).toEqual({ at: iso(6), bars: 4 });
    expect(f.after.first_touch).toBe("tp1");
    expect(f.after.returned_to_entry).toBe(true);
    expect(f.counterfactual.stop_x2?.resolution).toBe("win");
    // 1.5R = 148.5: the 148.9 low never reaches it either
    expect(f.counterfactual.stop_x1_5?.resolution).toBe("win");
    expect(f.hints[0]).toBe("stop_too_tight");
    expect(f.hints).not.toContain("direction_wrong");
    expect(f.bars_after_settlement).toBe(23);
    expect(f.hours_to_settle).toBe(2);
  });

  it("calls a loss that kept going 'direction wrong'", async () => {
    const row = evaluated(buyMarket, {
      filled_at: iso(0), resolved_at: iso(2), resolution: "loss", mfe_r: 0.1, mae_r: 1,
    }, "loss", iso(2));
    const candles = [
      candle(stamp(0), 150.1, 149.7),
      candle(stamp(1), 149.9, 149.3),
      candle(stamp(2), 149.4, 148.8), // SL
      candle(stamp(3), 148.9, 148.2),
      candle(stamp(4), 148.3, 147.4),
      candle(stamp(5), 147.5, 146.9),
      ...quiet(6, 30, 147.2, 146.8),
    ];
    const f = await computeFacts(row, candles, "1h", NOW);
    expect(f.after.reached_tp1).toBeNull();
    // lowest low after the stop is 146.8: 2.2R past 149
    expect(f.after.beyond_sl_r).toBeCloseTo(2.2, 5);
    expect(f.counterfactual.stop_x2?.resolution).toBe("loss");
    expect(f.hints).toEqual(["direction_wrong"]);
  });

  it("flags an event bar and a target that a nearer one would have caught", async () => {
    const row = evaluated(buyMarket, {
      filled_at: iso(0), resolved_at: iso(4), resolution: "loss", mfe_r: 0.9, mae_r: 1,
    }, "loss", iso(4));
    const candles = [
      candle(stamp(0), 150.2, 149.9),
      candle(stamp(1), 150.6, 150.1),
      candle(stamp(2), 150.9, 150.5), // 0.9R in favour: TP at half (151) not quite
      candle(stamp(3), 151.1, 150.7), // half-target 151 reached
      candle(stamp(4), 150.8, 148.7), // event bar: 2.1 range vs ~0.4 median
      ...quiet(5, 30, 149.5, 149.1),
    ];
    const f = await computeFacts(row, candles, "1h", NOW);
    expect(f.abnormal_bar?.at).toBe(iso(4));
    expect(f.abnormal_bar?.range_ratio).toBeGreaterThanOrEqual(3);
    expect(f.counterfactual.tp_half?.resolution).toBe("win");
    expect(f.hints).toContain("target_too_far");
    expect(f.hints).toContain("news_shock");
  });
});

describe("facts — plans that never filled", () => {
  // SELL limit at 150 with the market at 149.5
  const sellLimit: PostmortemRow = {
    ...buyMarket,
    id: "2",
    signal: "SELL",
    entry_point: 150,
    stop_loss: 151,
    take_profit_1: 148,
    take_profit_2: 147,
    take_profit_3: 146,
    price_at_signal: 149.5,
  };

  it("calls a missed move 'entry too far' when a market entry would have won", async () => {
    const row = evaluated(sellLimit, {
      order_type: "limit", resolved_at: iso(3), resolution: "untriggered", reason: "missed",
    }, "untriggered", iso(3));
    const candles = [
      candle(stamp(0), 149.7, 149.2),
      candle(stamp(1), 149.4, 148.8),
      candle(stamp(2), 149.0, 148.3),
      candle(stamp(3), 148.4, 147.8), // TP1 reached without a fill
      ...quiet(4, 30, 148.2, 147.6),
    ];
    const f = await computeFacts(row, candles, "1h", NOW);
    expect(f.counterfactual.market_entry?.resolution).toBe("win");
    expect(f.from_signal.max_favorable_r).toBeGreaterThanOrEqual(1);
    expect(f.hints).toEqual(["entry_too_far"]);
    expect(f.order_type).toBe("limit");
    expect(f.hours_to_fill).toBeNull();
  });

  it("calls a plan whose stop came first 'direction wrong'", async () => {
    const row = evaluated(sellLimit, {
      order_type: "limit", resolved_at: iso(2), resolution: "untriggered", reason: "invalidated",
    }, "untriggered", iso(2));
    const candles = [
      candle(stamp(0), 149.7, 149.2),
      candle(stamp(1), 149.9, 149.4),
      candle(stamp(2), 151.2, 149.8), // SL reached... and the entry, in one bar
      ...quiet(3, 30, 151.4, 151.0),
    ];
    const f = await computeFacts(row, candles, "1h", NOW);
    expect(f.hints).toEqual(["direction_wrong"]);
  });

  it("notes a lapsed entry in a market that went nowhere as inconclusive", async () => {
    const row = evaluated(sellLimit, {
      order_type: "limit", resolved_at: iso(48), resolution: "untriggered", reason: "no_fill",
    }, "untriggered", iso(48));
    const candles = quiet(0, 60, 149.7, 149.3);
    const f = await computeFacts(row, candles, "1h", at(60));
    expect(f.counterfactual.market_entry?.resolution).toBeNull();
    expect(f.hints).toEqual(["inconclusive"]);
  });
});

describe("facts — remedies the gate would refuse, and chased entries", () => {
  it("does not call a miss 'entry too far' when no market version of the plan would pay", async () => {
    // SELL limit at 158.00 with the market at 157.76, SL 158.50, TP1 157.40.
    // Entered at the market the reward is 0.36 for a risk of 0.74 — or 0.50
    // with the stop moved along — so neither version passes the gate
    const row = evaluated({
      ...buyMarket, id: "3", signal: "SELL", entry_point: 158.0, stop_loss: 158.5, take_profit_1: 157.4,
      take_profit_2: null, take_profit_3: null, price_at_signal: 157.76,
    }, { order_type: "limit", resolved_at: iso(3), resolution: "untriggered", reason: "missed" }, "untriggered", iso(3));
    const candles = [
      candle(stamp(0), 157.85, 157.6),
      candle(stamp(1), 157.7, 157.5),
      candle(stamp(2), 157.55, 157.45),
      candle(stamp(3), 157.5, 157.3), // TP1 without a fill
      ...quiet(4, 30, 157.45, 157.2),
    ];
    const f = await computeFacts(row, candles, "1h", NOW, { atr: 0.4 });
    expect(f.counterfactual.market_entry).toMatchObject({ resolution: "win", viable: false });
    expect(f.counterfactual.market_entry_same_risk).toMatchObject({ resolution: "win", viable: false });
    expect(f.counterfactual.market_entry_same_risk?.rr).toBeCloseTo(0.72, 2);
    expect(f.hints).toEqual(["inconclusive"]);
    expect(f.notes.some((n) => n.includes("no market version of the plan pays"))).toBe(true);
  });

  it("calls a market entry that turned at once 'too early' when a pullback limit would have paid", async () => {
    const row = evaluated(buyMarket, {
      filled_at: iso(0), resolved_at: iso(2), resolution: "loss", mfe_r: 0.2, mae_r: 1,
    }, "loss", iso(2));
    const candles = [
      candle(stamp(0), 150.2, 149.4), // turned 0.6R against the entry at once
      candle(stamp(1), 149.6, 149.3),
      candle(stamp(2), 149.5, 148.9), // SL
      candle(stamp(3), 149.4, 148.7),
      candle(stamp(4), 150.0, 149.2),
      candle(stamp(5), 151.0, 149.8),
      candle(stamp(6), 152.3, 150.9), // TP1 after the stop
      ...quiet(7, 30, 152.0, 151.5),
    ];
    const f = await computeFacts(row, candles, "1h", NOW, { atr: 0.5 });
    // 0.7R against the entry in the two bars before the stop-out bar
    expect(f.early_adverse_r).toBeCloseTo(0.7, 5);
    // A fill 0.5R better (149.50, stop 148.50) happens on the first bar and
    // pays 2.5:1 instead of 2:1 — but that price sits a full ATR from the
    // market, so a plan entered there would not pass the gate. The reading is
    // "the move was already extended, do not take this one", not "place a
    // limit" — which under market_v1 is not an order anyone can send.
    expect(f.counterfactual.limit_pullback).toMatchObject({ resolution: "win", rr: 2.5, viable: false, gate: "too_far" });
    expect(f.hints).toEqual(["chased_move", "stop_too_tight"]);
    // The order matters: hints[0] is what gets stored when the model's answer
    // is unparseable, and declining the trade is a remedy that exists under
    // both contracts while widening the stop past MIN_STOP_ATR is not.
    const underMarketV1 = await computeFacts(row, candles, "1h", NOW, { atr: 0.5, contract: "market_v1" });
    expect(underMarketV1.hints).toEqual(["chased_move", "stop_too_tight"]);
  });

  it("measures the early adverse move only while the trade was open, and not for stop entries", async () => {
    // TP1 on the fill bar, then a crash: nothing of the crash was in the trade
    const won = evaluated(buyMarket, {
      filled_at: iso(0), resolved_at: iso(0), resolution: "win", mfe_r: 2, mae_r: 0.1,
    }, "win", iso(0));
    const crash = [
      candle(stamp(0), 152.1, 149.9),
      candle(stamp(1), 149.5, 148.0),
      candle(stamp(2), 148.0, 146.0),
      ...quiet(3, 30, 147.0, 146.5),
    ];
    const f = await computeFacts(won, crash, "1h", NOW, { atr: 0.5 });
    expect(f.early_adverse_r).toBeNull();

    // A stop entry: the fill bar's low is the approach to the entry
    const stopRow = evaluated({ ...buyMarket, id: "4", entry_point: 150.5, stop_loss: 149.5, take_profit_1: 152.5, price_at_signal: 150.0 }, {
      order_type: "stop", filled_at: iso(0), resolved_at: iso(3), resolution: "win", mfe_r: 2, mae_r: 0,
    }, "win", iso(3));
    const approach = [
      candle(stamp(0), 150.6, 149.6, 149.6, 150.55),
      candle(stamp(1), 151.0, 150.5),
      candle(stamp(2), 151.4, 150.9),
      candle(stamp(3), 152.6, 151.3),
      ...quiet(4, 30, 152.0, 151.5),
    ];
    const g = await computeFacts(stopRow, approach, "1h", NOW, { atr: 0.5 });
    expect(g.early_adverse_r).toBeNull();
    // ...and a "pullback" 0.5R below a stop entry sits at the market, which
    // is no wait at all, so there is no such counterfactual
    expect(g.counterfactual.limit_pullback).toBeNull();
  });

  it("notes on a win whether waiting for a pullback would have paid more", async () => {
    const row = evaluated(buyMarket, {
      filled_at: iso(0), resolved_at: iso(3), resolution: "win", mfe_r: 2, mae_r: 0.6,
    }, "win", iso(3));
    const pulled = [
      candle(stamp(0), 150.3, 149.4),
      candle(stamp(1), 150.8, 149.9),
      candle(stamp(2), 151.6, 150.6),
      candle(stamp(3), 152.2, 151.4),
      ...quiet(4, 30, 152.0, 151.5),
    ];
    const f = await computeFacts(row, pulled, "1h", NOW, { atr: 0.5 });
    expect(f.hints).toEqual(["good_call"]);
    expect(f.counterfactual.limit_pullback?.resolution).toBe("win");
    expect(f.notes.some((n) => n.includes("paid 2.5:1"))).toBe(true);

    const straight = [
      candle(stamp(0), 150.3, 149.8),
      candle(stamp(1), 150.8, 150.1),
      candle(stamp(2), 151.6, 150.6),
      candle(stamp(3), 152.2, 151.4),
      ...quiet(4, 30, 152.0, 151.5),
    ];
    const g = await computeFacts(row, straight, "1h", NOW, { atr: 0.5 });
    expect(g.counterfactual.limit_pullback?.resolution).toBe("untriggered");
    expect(g.notes.some((n) => n.includes("this entry was not late"))).toBe(true);

    // These notes are serialized verbatim into the model's payload, so they
    // must not name an order the current contract cannot place. gateReason
    // feeds the not-viable branch, which is the one this fixture takes.
    for (const n of [...f.notes, ...g.notes]) {
      expect(n).not.toMatch(/limit|指値|押し目/);
    }
  });
});

describe("facts — wins and the regime", () => {
  it("separates a clean win from a lucky one", async () => {
    const win = evaluated(buyMarket, { filled_at: iso(0), resolved_at: iso(3), resolution: "win", mfe_r: 2, mae_r: 0.2 }, "win", iso(3));
    const lucky = evaluated(buyMarket, { filled_at: iso(0), resolved_at: iso(3), resolution: "win", mfe_r: 2, mae_r: 0.9 }, "win", iso(3));
    const candles = [
      candle(stamp(0), 150.2, 149.9),
      candle(stamp(1), 150.4, 149.1),
      candle(stamp(2), 151.4, 150.3),
      candle(stamp(3), 152.4, 151.2),
      ...quiet(4, 30, 152.5, 152.0),
    ];
    expect((await computeFacts(win, candles, "1h", NOW)).hints).toEqual(["good_call"]);
    expect((await computeFacts(lucky, candles, "1h", NOW)).hints).toEqual(["lucky_win"]);
  });

  it("flags a declared trend against a weak ADX", async () => {
    const row = evaluated(buyMarket, { filled_at: iso(0), resolved_at: iso(2), resolution: "loss", mfe_r: 0.1, mae_r: 1 }, "loss", iso(2));
    const candles = [candle(stamp(0), 150.2, 149.9), candle(stamp(1), 150.1, 149.5), candle(stamp(2), 149.6, 148.9), ...quiet(3, 30, 149.4, 149.0)];
    const f = await computeFacts(row, candles, "1h", NOW, { declaredMode: "Trend Day", adx: 14 });
    expect(f.regime).toEqual({ declared: "trend day", adx: 14, conflict: true });
    expect(f.hints).toContain("regime_misread");
    const g = await computeFacts(row, candles, "1h", NOW, { declaredMode: "Trend Day", adx: 35 });
    expect(g.regime?.conflict).toBe(false);
    expect(g.hints).not.toContain("regime_misread");
  });

  it("has nothing to say about the aftermath when there is none yet", async () => {
    const row = evaluated(buyMarket, { filled_at: iso(0), resolved_at: iso(2), resolution: "loss" }, "loss", iso(2));
    const candles = [candle(stamp(0), 150.2, 149.9), candle(stamp(1), 150.1, 149.5), candle(stamp(2), 149.6, 148.9)];
    const f = await computeFacts(row, candles, "1h", at(3));
    expect(f.bars_after_settlement).toBe(0);
    expect(f.after.returned_to_entry).toBeNull();
    expect(f.after.beyond_sl_r).toBeNull();
    expect(f.hints).toEqual(["inconclusive"]);
    expect(f.notes).toContain("no bars after the settlement yet");
  });
});

describe("scheduling", () => {
  it("waits after a settlement for the aftermath to exist", () => {
    const closed = iso(0);
    expect(isPostmortemDue({ interval: "1h", closed_at: closed }, at(1))).toBe(false);
    expect(isPostmortemDue({ interval: "1h", closed_at: closed }, at(0) + AFTER_WAIT_MS["1h"])).toBe(true);
    expect(isPostmortemDue({ interval: "1day", closed_at: closed }, at(7))).toBe(false);
    expect(isPostmortemDue({ interval: "1day", closed_at: closed }, at(8))).toBe(true);
    // no settlement time recorded: nothing to wait for
    expect(isPostmortemDue({ interval: "1h", closed_at: null }, at(0))).toBe(true);
  });
});

describe("diagnosis contract", () => {
  const plan: PlanSummary = {
    id: "1", pair: "USD/JPY", interval: "1h", signal: "BUY", mode: "full", confidence: 70, thesis: "t",
    entry: 150, stop_loss: 149, take_profit_1: 152, take_profit_2: null, take_profit_3: null, price_at_signal: 150,
    created_at: T0, outcome: "loss", reason: null, filled_at: iso(0), resolved_at: iso(2), mfe_r: 0.3, mae_r: 1,
    tps_hit: [], key_factors: ["a"], warnings: ["w"], analysis: "x".repeat(3000), market_context_detail: null,
    timeframe_alignment: [], entry_check: null, context: null, shadow: false,
  };

  it("truncates the analysis text and carries the facts verbatim", async () => {
    const row = evaluated(buyMarket, { filled_at: iso(0), resolved_at: iso(2), resolution: "loss" }, "loss", iso(2));
    const f = await computeFacts(row, [candle(stamp(0), 150.2, 149.9), candle(stamp(2), 149.6, 148.9)], "1h", NOW);
    const p = buildDiagnosisPrompt(plan, f);
    expect(p.user.length).toBeLessThan(6000);
    expect(p.user).toContain("以下省略");
    expect(p.user).toContain('"hints":["inconclusive"]');
    expect(p.system).toContain("stop_too_tight");
    expect(DIAGNOSIS_SCHEMA.required).toContain("lesson_ja");
  });

  it("keeps a well-formed diagnosis and falls back to the hint on a bad cause", () => {
    const good = parseDiagnosis({
      cause: "stop_too_tight", secondary_causes: ["news_shock", "stop_too_tight", "bogus"], avoidable: true, confidence: 140,
      verdict_ja: "v", verdict_en: "v-en", evidence_ja: ["e1", "e2"], evidence_en: ["e1"], lesson_ja: "l", lesson_en: "l-en", scope: "1h",
    }, ["direction_wrong"]);
    expect(good?.cause).toBe("stop_too_tight");
    expect(good?.secondary_causes).toEqual(["news_shock"]);
    expect(good?.confidence).toBe(100);
    const fallback = parseDiagnosis({ cause: "nonsense", verdict_ja: "v", lesson_ja: "l" }, ["entry_too_far"]);
    expect(fallback?.cause).toBe("entry_too_far");
    expect(fallback?.lesson_en).toBe("l");
    expect(fallback?.avoidable).toBe(false);
  });

  it("refuses an answer with no lesson or no verdict", () => {
    expect(parseDiagnosis({ cause: "good_call", verdict_ja: "v" }, [])).toBeNull();
    expect(parseDiagnosis({ cause: "good_call", lesson_ja: "l" }, [])).toBeNull();
    expect(parseDiagnosis("nope", [])).toBeNull();
  });
});

describe("rulebook consolidation", () => {
  const previous: Rule[] = [
    { id: "r1", text_ja: "旧ルール", text_en: "old rule", cause: "entry_too_far", support: 3, scope: null, since: "2026-08-01T00:00:00Z", kind: "heuristic", supported_by: ["a"] },
    { id: "r2", text_ja: "歯止め", text_en: "guard", cause: "direction_wrong", support: 2, scope: null, since: "2026-08-02T00:00:00Z", kind: "constraint", supported_by: ["c"] },
    { id: "r3", text_ja: "弱い", text_en: "weak", cause: "general", support: 1, scope: null, since: "2026-08-03T00:00:00Z", kind: "heuristic", supported_by: ["b"] },
    { id: "r4", text_ja: "最弱", text_en: "weakest", cause: "general", support: 1, scope: null, since: "2026-08-04T00:00:00Z", kind: "heuristic", supported_by: ["b"] },
  ];
  // a and b: the same situation, both "entry too far"; c: a wrong call
  const lessons = [
    { analysis_id: "a", cluster: "c1", cause: "entry_too_far" },
    { analysis_id: "b", cluster: "c1", cause: "entry_too_far" },
    { analysis_id: "c", cluster: "c2", cause: "direction_wrong" },
  ];
  const rule = (id: string, over: Record<string, unknown> = {}) => ({
    id, text_ja: `ルール${id}`, text_en: `rule ${id}`, cause: "general", scope: null, supported_by: [], ...over,
  });

  it("counts support from the cited lessons by cluster, never from the model, and drops a rule with no evidence", () => {
    const raw = {
      rules: [rule("r1", { supported_by: ["a", "b", "c", "zzz"], support: 99 }), rule("r2", { supported_by: ["c"] }), rule("r3"), rule("r4", { supported_by: ["a"] })],
      summary_ja: "s", summary_en: "s-en",
    };
    const c = parseConsolidation(raw, previous, "2026-09-03T00:00:00Z", lessons);
    expect(c?.rules.map((r) => r.id)).toEqual(["r2", "r1", "r4"]);
    expect(c?.rules.find((r) => r.id === "r1")).toMatchObject({ support: 2, supported_by: ["a", "b", "c"], since: "2026-08-01T00:00:00Z" });
    expect(c?.rules.find((r) => r.id === "r4")).toMatchObject({ support: 1, supported_by: ["a"] });
    expect(c?.changes).toEqual({ added: [], removed: ["r3"], restored: [], dropped: ["r3"] });
    expect(c?.summary_en).toBe("s-en");
  });

  it("only counts a citation that is about the rule's own failure, and never a refused plan's lesson", () => {
    const mixed = [
      ...lessons,
      { analysis_id: "s", cluster: "c9", cause: "entry_too_far", shadow: true },
      { analysis_id: "g", cluster: "c8", cause: "good_call" },
      { analysis_id: "n", cluster: "c7", cause: "news_shock" },
    ];
    expect(citationAllowed({ cause: "stop_too_tight", kind: "heuristic" }, mixed[0])).toBe(false);
    expect(citationAllowed({ cause: "entry_too_far", kind: "heuristic" }, mixed[0])).toBe(true);
    expect(citationAllowed({ cause: "general", kind: "heuristic" }, mixed[2])).toBe(true);
    expect(citationAllowed({ cause: "general", kind: "heuristic" }, mixed[3])).toBe(false);
    expect(citationAllowed({ cause: "general", kind: "heuristic" }, mixed[4])).toBe(false);
    expect(citationAllowed({ cause: "stop_too_tight", kind: "constraint" }, mixed[5])).toBe(true);
    expect(citationAllowed({ cause: "stop_too_tight", kind: "heuristic" }, mixed[5])).toBe(false);
    const raw = {
      rules: [
        rule("r1", { supported_by: ["a", "s", "g"] }),
        rule("r9", { cause: "stop_too_tight", supported_by: ["a", "b", "c"] }),
      ],
      summary_ja: "s", summary_en: "s",
    };
    const c = parseConsolidation(raw, previous, T0, mixed);
    expect(c?.rules.find((r) => r.id === "r1")).toMatchObject({ support: 1, supported_by: ["a"] });
    expect(c?.rules.some((r) => r.id === "r9")).toBe(false);
    expect(c?.changes.dropped).toEqual(["r9"]);
  });

  it("keeps constraints first, inherits a continuing rule's kind, and caps additions at two", () => {
    const raw = {
      rules: [
        rule("r9", { supported_by: ["a"] }), rule("r10", { supported_by: ["b"] }), rule("r11", { supported_by: ["c"] }),
        rule("r1", { supported_by: ["a", "c"] }), rule("r2", { supported_by: ["c"] }),
      ],
      summary_ja: "s", summary_en: "s-en",
    };
    const c = parseConsolidation(raw, previous, "2026-09-03T00:00:00Z", lessons);
    expect(c?.rules.map((r) => r.id)).toEqual(["r2", "r1", "r9", "r10"]);
    expect(c?.rules[0].kind).toBe("constraint");
    expect(c?.rules[2].since).toBe("2026-09-03T00:00:00Z");
    expect(c?.changes).toEqual({ added: ["r9", "r10"], removed: ["r3", "r4"], restored: [], dropped: ["r11"] });
  });

  it("puts back rules dropped beyond the removal allowance, weakest ones going first, with their evidence recounted", () => {
    const c = parseConsolidation({ rules: [rule("r1", { supported_by: ["a"] })], summary_ja: "s", summary_en: "s-en" }, previous, "2026-09-03T00:00:00Z", lessons);
    expect(c?.rules.map((r) => r.id)).toEqual(["r2", "r1"]);
    expect(c?.rules[0]).toMatchObject({ support: 1, supported_by: ["c"] });
    expect(c?.changes).toEqual({ added: [], removed: ["r3", "r4"], restored: ["r2"], dropped: [] });
    // A rule the model omitted whose evidence no longer holds up is not
    // put back, whatever the allowance
    const stale: Rule[] = [...previous, { ...previous[1], id: "r5", supported_by: ["gone"] }];
    const d = parseConsolidation({ rules: [rule("r1", { supported_by: ["a"] }), rule("r2", { supported_by: ["c"] }), rule("r3", { supported_by: ["b"] }), rule("r4", { supported_by: ["b"] })], summary_ja: "s", summary_en: "s" }, stale, T0, lessons);
    expect(d?.rules.some((r) => r.id === "r5")).toBe(false);
    expect(d?.changes.removed).toEqual(["r5"]);
  });

  it("keeps a continuing rule's older citations in evidence when they are handed back, and never lets a blank id take over a rule", () => {
    const old: Rule[] = [{ ...previous[0], support: 3, supported_by: ["x1", "x2", "x3"] }];
    const older = [
      ...lessons,
      { analysis_id: "x1", cluster: "cx1", cause: "entry_too_far" },
      { analysis_id: "x2", cluster: "cx2", cause: "entry_too_far" },
      { analysis_id: "x3", cluster: "cx3", cause: "entry_too_far" },
    ];
    const c = parseConsolidation({ rules: [rule("r1", { supported_by: ["x1", "x2", "x3"] })], summary_ja: "s", summary_en: "s" }, old, T0, older);
    expect(c?.rules[0]).toMatchObject({ id: "r1", support: 3, supported_by: ["x1", "x2", "x3"] });

    // A blank id gets a fresh one rather than r1's identity: r1 is recorded
    // as removed (within the allowance), the newcomer as added with its own
    // birth date
    const blank = parseConsolidation({ rules: [rule("", { kind: "heuristic", supported_by: ["a"] })], summary_ja: "s", summary_en: "s" }, old, T0, older);
    expect(blank?.rules.map((r) => r.id)).toEqual(["r1_"]);
    expect(blank?.rules[0].since).toBe(T0);
    expect(blank?.changes).toEqual({ added: ["r1_"], removed: ["r1"], restored: [], dropped: [] });
  });

  it("lets the first rulebook be written whole, up to the cap, and de-duplicates ids", () => {
    const rules = Array.from({ length: MAX_RULES + 3 }, (_, i) => rule(i === 1 ? "r1" : `r${i + 1}`, { kind: i % 2 ? "constraint" : "heuristic", supported_by: ["a"] }));
    const c = parseConsolidation({ rules, summary_ja: "s", summary_en: "s-en" }, [], "2026-09-03T00:00:00Z", lessons);
    expect(c?.rules).toHaveLength(MAX_RULES);
    expect(c?.rules.some((r) => r.id === "r1_")).toBe(true);
    expect(c?.rules.every((r, i, all) => i === 0 || all[i - 1].kind !== "heuristic" || r.kind === "heuristic")).toBe(true);
  });

  it("refuses an empty or malformed rewrite", () => {
    expect(parseConsolidation({ rules: [] }, previous, T0)).toBeNull();
    expect(parseConsolidation({ rules: [{ id: "x" }] }, previous, T0)).toBeNull();
    expect(parseConsolidation(null, previous, T0)).toBeNull();
  });

  it("summarises the record with its sample size, its independent situations, its realized R and the per-rule feedback", () => {
    const row = (over: Partial<RecordRow>): RecordRow => ({
      pair: "USD/JPY", signal: "SELL", created_at: "2026-09-03T04:00:00Z", outcome: "pending", shadow: false,
      rejection: null, filled: false, entry: 150, stop: 151, tp1: 148, outcome_price: null, rulebook_version: 2, ...over,
    });
    const rows = [
      row({ outcome: "win", signal: "BUY", entry: 150, stop: 149, tp1: 152, filled: true, rulebook_version: 0 }),
      row({ outcome: "loss", filled: true }),
      // the same situation an hour later: one cluster with the loss above
      row({ outcome: "loss", filled: true, created_at: "2026-09-03T05:00:00Z" }),
      row({ outcome: "untriggered" }),
      row({ outcome: "ambiguous", filled: true }),
      row({ outcome: "pending" }),
      row({ outcome: "skipped", signal: "WAIT", rejection: "should_be_market" }),
      row({ outcome: "skipped", signal: "WAIT" }),
      row({ outcome: "untriggered", shadow: true, rejection: "should_be_market" }),
      row({ outcome: "win", shadow: true, rejection: "too_far", filled: true }),
    ];
    const s = summarizeRecord(rows, [
      { cause: "stop_too_tight", cluster: "x", rule_blamed: "r1" },
      { cause: "stop_too_tight", cluster: "x" },
      { cause: "entry_too_far", cluster: "y", rule_credited: "r2" },
      { cause: "entry_too_far", cluster: "z", shadow: true },
    ]);
    expect(s).toMatchObject({
      total: 6, wins: 1, losses: 2, untriggered: 1, ambiguous: 1, open: 1, settled: 3,
      win_rate: null, fill_rate: null, rejected: 1, independent_clusters: 2,
    });
    expect(s.win_rate_ci95).toEqual([6, 79]);
    expect(s.realized_r).toEqual({ n: 3, sum: 0, mean: 0 });
    // The seeded, empty rulebook (version 0) is "no rules" too
    expect(s.by_rulebook_version.none).toMatchObject({ plans: 1, wins: 1, sum_r: 2 });
    expect(s.by_rulebook_version["2"]).toMatchObject({ plans: 5, losses: 2, untriggered: 1, open: 1, sum_r: -2 });
    expect(s.rule_feedback).toEqual({ r1: { blamed: 1, credited: 0 }, r2: { blamed: 0, credited: 1 } });
    expect(s.shadow).toEqual({ total: 2, untriggered: 1, wins: 1, losses: 0, open: 0 });
    expect(s.by_cause).toEqual({ stop_too_tight: 2, entry_too_far: 1 });
    expect(s.by_cause_clusters).toEqual({ stop_too_tight: 1, entry_too_far: 1 });
    expect(s.shadow_by_cause).toEqual({ entry_too_far: 1 });
    const p = buildConsolidationPrompt(previous, [], s);
    expect(p.user).toContain('"rejected":1');
    expect(p.user).toContain('"rule_feedback"');
    expect(p.system).toContain(String(MAX_RULES));
    expect(p.system).toContain("独立クラスタ");
    expect(p.system).toContain("基本手順");
  });

  const contractRow = (over: Partial<RecordRow>): RecordRow => ({
    pair: "USD/JPY", signal: "SELL", created_at: "2026-09-03T04:00:00Z", outcome: "pending",
    shadow: false, rejection: null, filled: false, entry: 150, stop: 151, tp1: 148,
    outcome_price: null, rulebook_version: 2, contract: "entry_chosen_v1", ...over,
  });

  it("counts one entry contract at a time, and says how many rows that left out", () => {
    // Under the old contract a plan the market never reached was never scored
    // at all; under the new one that cannot happen. A rate over both would
    // describe a population that never existed, so the old rows are counted
    // and set aside rather than pooled.
    const rows = [
      contractRow({ outcome: "win", filled: true }),
      contractRow({ outcome: "loss", filled: true }),
      contractRow({ outcome: "untriggered" }),
      contractRow({
        outcome: "loss", filled: true, contract: "market_v1",
        created_at: "2026-09-04T04:00:00Z",
      }),
    ];
    const s = summarizeRecord(rows, []);
    // The newest row names the contract the record is about
    expect(s.contract).toBe("market_v1");
    expect(s).toMatchObject({ total: 1, losses: 1, wins: 0, untriggered: 0, other_contract_rows: 3 });
  });

  it("treats a row with no contract as the legacy one", () => {
    const rows = [
      contractRow({ outcome: "win", filled: true, contract: null }),
      contractRow({ outcome: "loss", filled: true }),
    ];
    const s = summarizeRecord(rows, []);
    expect(s.contract).toBe("entry_chosen_v1");
    expect(s).toMatchObject({ total: 2, wins: 1, losses: 1, other_contract_rows: 0 });
  });

  it("counts an expiry against the win rate", () => {
    // A target placed beyond reach expires. Leaving expiries out of the
    // denominator made that the cheapest way to avoid ever being wrong.
    const rows = [
      ...Array.from({ length: 10 }, () => contractRow({ outcome: "win", filled: true })),
      ...Array.from({ length: 5 }, () => contractRow({ outcome: "loss", filled: true })),
      ...Array.from({ length: 5 }, () => contractRow({ outcome: "expired", filled: true, outcome_price: 150 })),
    ];
    const s = summarizeRecord(rows, []);
    expect(s.settled).toBe(15);
    expect(s.decided).toBe(20);
    // 10/20, not 10/15
    expect(s.win_rate).toBe(50);
  });

  it("scores the calls that declined to trade", () => {
    const wait = (verdict: string | null) =>
      contractRow({ outcome: "skipped", signal: "WAIT", wait_verdict: verdict });
    const s = summarizeRecord(
      [wait("missed"), wait("correct"), wait("correct"), wait("pending"), wait("unknown"), wait(null)],
      [],
    );
    expect(s).toMatchObject({ waits: 6, waits_judged: 3, waits_missed: 1 });
    // Below the sample floor the rate is withheld, like every other rate here
    expect(s.wait_miss_rate).toBeNull();
    const many = Array.from({ length: 30 }, (_, i) => wait(i < 6 ? "missed" : "correct"));
    expect(summarizeRecord(many, []).wait_miss_rate).toBe(20);
  });

  it("tells the editor what it may and may not write under the current contract", () => {
    const s = summarizeRecord([contractRow({ outcome: "win", filled: true })], []);
    const p = buildConsolidationPrompt(previous, [], s);
    // The analyst no longer picks an entry price, so a rule about where to
    // enter is a rule nobody can follow
    expect(p.system).toContain("エントリー価格はアナリストが選ばない");
    expect(p.system).toContain("stats.decided");
    expect(p.system).toContain("stats.waits_missed");
    expect(p.system).toContain("stats.other_contract_rows");
    expect(p.user).toContain('"contract":"entry_chosen_v1"');
  });
});

describe("evidence bookkeeping", () => {
  it("groups plans on the same pair and direction close together into one cluster, unless the earlier one had long settled", () => {
    const ids = clusterIds([
      { pair: "USD/JPY", signal: "SELL", created_at: "2026-09-03T04:49:00Z", closed_at: "2026-09-03T06:45:00Z" },
      { pair: "USD/JPY", signal: "SELL", created_at: "2026-09-03T12:35:00Z", closed_at: "2026-09-03T13:00:00Z" },
      // the next day, long after the previous one closed: a new decision
      { pair: "USD/JPY", signal: "SELL", created_at: "2026-09-04T05:00:00Z" },
      { pair: "USD/JPY", signal: "BUY", created_at: "2026-09-03T05:00:00Z" },
      { pair: "EUR/USD", signal: "SELL", created_at: "2026-09-03T05:00:00Z" },
      // Another account's identical plan is the SAME market situation. The
      // rulebook is shared, so this is one decision by one analyst delivered
      // to two people — one piece of evidence about it, not two. Keying the
      // cluster by user made a rule's support grow with the subscriber count.
      { pair: "USD/JPY", signal: "SELL", created_at: "2026-09-03T05:00:00Z" },
    ]);
    expect(ids[0]).not.toBe(ids[1]);
    expect(ids[2]).not.toBe(ids[1]);
    expect(ids[5]).toBe(ids[0]);
    expect(new Set(ids).size).toBe(5);
    // still open when the next one was made: the same bet again
    const open = clusterIds([
      { pair: "USD/JPY", signal: "SELL", created_at: "2026-09-03T04:49:00Z", closed_at: null },
      { pair: "USD/JPY", signal: "SELL", created_at: "2026-09-03T12:35:00Z", closed_at: null },
      { pair: "USD/JPY", signal: "SELL", created_at: "2026-09-04T03:00:00Z" },
    ]);
    expect(new Set(open).size).toBe(1);
    // Clustered by when the PLAN was made, not when the review ran
    const rows = withClusters([
      { analysis_id: "a", pair: "USD/JPY", signal: "SELL", created_at: "2026-09-05T00:00:00Z", plan_created_at: "2026-09-03T04:49:00Z", cause: "entry_too_far", outcome: "untriggered", interval: "1h", mode: null, order_type: "limit", lesson_ja: "x", lesson_en: "x", confidence: 80, avoidable: true, shadow: false, scope: null, rule_blamed: null, rule_credited: null },
      { analysis_id: "b", pair: "USD/JPY", signal: "SELL", created_at: "2026-09-05T00:00:00Z", plan_created_at: "2026-09-01T04:49:00Z", cause: "entry_too_far", outcome: "untriggered", interval: "1h", mode: null, order_type: "limit", lesson_ja: "x", lesson_en: "x", confidence: 80, avoidable: true, shadow: false, scope: null, rule_blamed: null, rule_credited: null },
    ]);
    expect(rows[0].cluster).not.toBe(rows[1].cluster);
    expect(rows[0].cluster).toContain("2026-09-03");
  });

  it("gives a small sample a wide interval", () => {
    expect(wilson(0, 1)).toEqual([0, 79]);
    expect(wilson(1, 2)).toEqual([9, 91]);
    expect(wilson(55, 100)).toEqual([45, 64]);
    expect(wilson(0, 0)).toBeNull();
  });

  it("waits for enough new lessons, or a day, before rewriting the rulebook", () => {
    const now = Date.parse("2026-09-03T12:00:00Z");
    expect(revisionDue(0, null, now)).toBe(false);
    expect(revisionDue(1, null, now)).toBe(true);
    expect(revisionDue(1, "2026-09-03T10:00:00Z", now)).toBe(false);
    expect(revisionDue(5, "2026-09-03T10:00:00Z", now)).toBe(true);
    expect(revisionDue(1, "2026-09-02T11:00:00Z", now)).toBe(true);
  });

  it("accepts a rule reference only from the rules in force", () => {
    const d = parseDiagnosis({
      cause: "entry_too_far", secondary_causes: [], avoidable: true, confidence: 70,
      verdict_ja: "v", verdict_en: "v", evidence_ja: [], evidence_en: [], lesson_ja: "l", lesson_en: "l", scope: null,
      rule_blamed: "r1", rule_credited: "r9",
    }, [], ["r1", "r2"]);
    expect(d?.rule_blamed).toBe("r1");
    expect(d?.rule_credited).toBeNull();
  });
});

describe("rules in the analyze prompt", () => {
  const rules: Rule[] = [
    { id: "r1", text_ja: "弱い方", text_en: "weak", cause: "general", support: 1, scope: null, since: null, kind: "heuristic", supported_by: [] },
    { id: "r2", text_ja: "強い方", text_en: "strong", cause: "stop_too_tight", support: 4, scope: "1h", since: null, kind: "heuristic", supported_by: [] },
    { id: "r3", text_ja: "歯止め", text_en: "guard", cause: "direction_wrong", support: 3, scope: null, since: null, kind: "constraint", supported_by: [] },
  ];

  it("renders constraints first, then the best-supported rules, marking thin ones as under review", () => {
    const lines = renderLearnedRules(rules).split("\n");
    expect(lines[0]).toContain("上の手順とリスク規定が優先");
    expect(lines[1]).toBe("- 歯止め（実績3件）");
    expect(lines[2]).toBe("- ［1h］強い方（実績4件）");
    expect(lines[3]).toBe("- 弱い方（検証中・実績1件）");
  });

  it("renders in English for an English analysis", () => {
    const lines = renderLearnedRules(rules, "en").split("\n");
    expect(lines[0]).toContain("Rules learned from past outcomes");
    expect(lines[1]).toBe("- guard (3 cases)");
    expect(lines[2]).toBe("- [1h] strong (4 cases)");
    expect(lines[3]).toBe("- weak (under review, 1 case)");
  });

  it("renders nothing when nothing has been learned", () => {
    expect(renderLearnedRules([])).toBe("");
    expect(renderLearnedRules(parseRules("junk"))).toBe("");
  });

  it("stays inside its character budget", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ ...rules[1], id: `r${i}`, text_ja: "あ".repeat(120), support: 40 - i }));
    const text = renderLearnedRules(many);
    expect(text.length).toBeLessThanOrEqual(MAX_PROMPT_CHARS);
    expect(text.split("\n").length - 1).toBeLessThanOrEqual(12);
  });

  it("takes the newest from each account in turn, not the newest overall", () => {
    // One shared rulebook, many accounts. Read newest-first with a fixed
    // limit, a single busy account fills the whole window and the rulebook
    // quietly becomes that person's — their pairs, their timeframes, their
    // read of the market — while everyone else never enters it.
    const heavy = Array.from({ length: 10 }, (_, i) => ({ u: "busy", n: i }));
    const quiet = [{ u: "quiet", n: 100 }, { u: "quiet", n: 101 }];
    const picked = fairShare([...heavy, ...quiet], (x) => x.u, 4);
    expect(picked.map((x) => x.u)).toEqual(["busy", "quiet", "busy", "quiet"]);
    // With one contributor it is plain newest-first, unchanged
    expect(fairShare(heavy, (x) => x.u, 3).map((x) => x.n)).toEqual([0, 1, 2]);
    // Never invents rows, and never drops one it could have taken
    expect(fairShare(quiet, (x) => x.u, 99)).toHaveLength(2);
    expect(fairShare(heavy, (x) => x.u, 0)).toEqual([]);
  });

  it("stamps the contract the editor was writing for, and leaves restored rules on theirs", () => {
    // Emitting a rule under this revision's prompt IS the statement that the
    // analyst can follow it now. A rule the editor never looked at — restored
    // below to fill the book back up — must not be revived by that silence.
    // Four previous rules and one re-emitted: two of the other three are
    // dropped by MAX_RULES_REMOVED and the third is restored untouched, which
    // is the case this test is about.
    const legacy = (id: string, support: number): Rule => ({
      id, text_ja: "旧", text_en: `old ${id}`, cause: "entry_too_far", support,
      scope: null, since: "2026-09-01T00:00:00Z", contract: "entry_chosen_v1",
      kind: "heuristic", supported_by: ["L1"],
    });
    const previous: Rule[] = [
      legacy("old1", 1),
      legacy("old2", 2),
      legacy("old3", 9),
      { id: "keep", text_ja: "残", text_en: "keep", cause: "stop_too_tight", support: 2, scope: null, since: "2026-09-01T00:00:00Z", contract: "entry_chosen_v1", kind: "constraint", supported_by: ["L2"] },
    ];
    const lessons = [
      { analysis_id: "L1", cluster: "c1", cause: "entry_too_far" },
      { analysis_id: "L2", cluster: "c2", cause: "stop_too_tight" },
    ];
    const out = parseConsolidation(
      { rules: [{ id: "keep", text_ja: "残", text_en: "keep", cause: "stop_too_tight", kind: "constraint", scope: null, supported_by: ["L2"] }], summary_ja: "s", summary_en: "s" },
      previous,
      T0,
      lessons,
      "market_v1",
    );
    const byId = new Map((out?.rules ?? []).map((r) => [r.id, r]));
    expect(byId.get("keep")?.contract).toBe("market_v1");
    // old3 was not re-emitted; it comes back only as a restore, so it keeps
    // the contract it was written for and stays out of the prompt
    expect(byId.get("old3")?.contract).toBe("entry_chosen_v1");
    expect(inForce(out?.rules ?? [], "market_v1").map((r) => r.id)).toEqual(["keep"]);
  });

  it("reads stored rows defensively", () => {
    const parsed = parseRules([
      { id: "r1", text_ja: "a", text_en: "b", cause: "x", support: "3", scope: "", since: null },
      { text_en: "only english", support: -2 },
      { id: "r3" },
      "junk",
    ]);
    expect(parsed).toEqual([
      { id: "r1", text_ja: "a", text_en: "b", cause: "x", support: 3, scope: null, since: null, contract: null, kind: "heuristic", supported_by: [] },
      { id: "r2", text_ja: "only english", text_en: "only english", cause: "unknown", support: 1, scope: null, since: null, contract: null, kind: "heuristic", supported_by: [] },
    ]);
  });
});

// The taxonomy has two eras. entry_too_far and entry_too_early stay valid
// INPUTS forever — stored rows, stored lessons and stored rulebook rules carry
// them — but nothing produces them again. The danger of a half-done rename is
// that it is silent: parseDiagnosis swallows an unknown cause and substitutes
// hints[0], so a name changed in one place and not another yields plausible
// diagnoses with no error at any layer.
describe("the cause taxonomy across the two entry contracts", () => {
  it("keeps the legacy names accepted, so no stored rule loses its cause", () => {
    // Dropping either from CAUSES would make parseConsolidation coerce an old
    // rule's cause to "general" and silently widen its evidence.
    expect(CAUSES).toContain("chased_move");
    expect(CAUSES).toContain("entry_too_far");
    expect(CAUSES).toContain("entry_too_early");
    expect(CAUSES).toHaveLength(12);
    for (const c of ["chased_move", "entry_too_far", "entry_too_early"]) expect(isCause(c)).toBe(true);
  });

  it("offers the model only the causes its own contract can produce", () => {
    const live = causesFor("market_v1");
    expect(live).toContain("chased_move");
    expect(live).not.toContain("entry_too_far");
    expect(live).not.toContain("entry_too_early");
    for (const c of [...causesFor("entry_chosen_v1"), ...live]) expect(CAUSES).toContain(c);
    expect(causesFor("entry_chosen_v1")).toHaveLength(12);
    expect(causesFor(null)).toHaveLength(12);

    expect(diagnosisSchema("market_v1").properties.cause.enum).not.toContain("entry_too_far");
    expect(diagnosisSchema("entry_chosen_v1").properties.cause.enum).toContain("entry_too_far");
    // The consolidation schema must NOT be narrowed: an existing rule whose
    // cause is entry_too_far has to be re-emittable under its own cause
    // rather than coerced to "general".
    expect(CONSOLIDATION_SCHEMA.properties.rules.items.properties.cause.enum).toContain("entry_too_far");
  });

  it("never stores the dead spelling, whatever the model answers", () => {
    const ok = {
      cause: "entry_too_early", secondary_causes: [], avoidable: true, confidence: 70,
      verdict_ja: "v", verdict_en: "v", evidence_ja: [], evidence_en: [],
      lesson_ja: "l", lesson_en: "l", scope: null, rule_blamed: null, rule_credited: null,
    };
    expect(parseDiagnosis(ok, ["inconclusive"], [], "market_v1")?.cause).toBe("chased_move");
    expect(parseDiagnosis(ok, ["inconclusive"], [], "entry_chosen_v1")?.cause).toBe("chased_move");
    // A cause this row's contract cannot produce falls to the deterministic
    // hint, which is contract-correct by construction.
    const legacy = { ...ok, cause: "entry_too_far" };
    expect(parseDiagnosis(legacy, ["stop_too_tight"], [], "market_v1")?.cause).toBe("stop_too_tight");
    expect(parseDiagnosis(legacy, ["stop_too_tight"], [], "entry_chosen_v1")?.cause).toBe("entry_too_far");
  });

  it("cites across the rename in both directions", () => {
    const lesson = (cause: string) => ({ analysis_id: "a", cause, shadow: false });
    expect(citationAllowed({ cause: "entry_too_early", kind: "heuristic" }, lesson("chased_move"))).toBe(true);
    expect(citationAllowed({ cause: "chased_move", kind: "heuristic" }, lesson("entry_too_early"))).toBe(true);
    // A constraint rule of another cause reaches it through CONSTRAINT_CAUSES
    expect(citationAllowed({ cause: "direction_wrong", kind: "constraint" }, lesson("entry_too_early"))).toBe(true);
    // The legacy cause that was NOT renamed keeps its own bucket
    expect(citationAllowed({ cause: "entry_too_far", kind: "heuristic" }, lesson("entry_too_far"))).toBe(true);
  });

  it("merges the two spellings into one bucket, and counts each era", () => {
    const l = (cause: string, contract: string | null, cluster: string) =>
      ({ cause, contract, cluster, shadow: false });
    const s = summarizeRecord([], [
      l("entry_too_early", "entry_chosen_v1", "c1"),
      l("chased_move", "market_v1", "c2"),
      l("entry_too_far", "entry_chosen_v1", "c3"),
    ]);
    expect(s.by_cause.chased_move).toBe(2);
    expect(s.by_cause.entry_too_early).toBeUndefined();
    expect(s.by_cause_clusters.chased_move).toBe(2);
    // entry_too_far names something only the old contract could do, so it is
    // never aliased — it keeps its own bucket.
    expect(s.by_cause.entry_too_far).toBe(1);
    expect(s.lessons_by_contract).toEqual({ entry_chosen_v1: 2, market_v1: 1 });
  });

  it("does not let a market_v1 plan be filed under a legacy cause", async () => {
    // Under market_v1 entry === price_at_signal and the judge fills on the
    // signal bar, so an untriggered verdict means the fill could not be
    // established — not that the entry was never reached.
    const row = {
      id: "u1", pair: "USD/JPY", interval: "1h", signal: "BUY" as const,
      entry_point: 150, stop_loss: 149, take_profit_1: 152,
      take_profit_2: null, take_profit_3: null,
      created_at: new Date(NOW - 40 * 60 * 60 * 1000).toISOString(),
      price_at_signal: 150,
      evaluation: { resolution: "untriggered", reason: "no_fill", order_type: "limit" } as never,
      outcome: "untriggered", closed_at: new Date(NOW - 20 * 60 * 60 * 1000).toISOString(),
    };
    const candles = [
      candle(stamp(0), 150.2, 149.9), candle(stamp(1), 150.6, 150.1),
      candle(stamp(2), 151.4, 150.5), ...quiet(3, 30, 152.4, 151.6),
    ];
    const legacy = await computeFacts(row, candles, "1h", NOW, { atr: 0.5 });
    const live = await computeFacts(row, candles, "1h", NOW, { atr: 0.5, contract: "market_v1" });
    expect(live.hints).toEqual(["inconclusive"]);
    expect(live.hints).not.toContain("entry_too_far");
    expect(live.notes.some((n) => n.includes("market_v1") && n.includes("could not be established from the data"))).toBe(true);
    // The old era still reads the same fixture the old way
    expect(legacy.hints.some((h) => h === "entry_too_far" || h === "inconclusive")).toBe(true);
    // Whatever the era, no market_v1 row may carry a cause only the old
    // contract could produce — the half-done-rename detector.
    for (const h of live.hints) expect(["entry_too_far", "entry_too_early"]).not.toContain(h);
  });
});
