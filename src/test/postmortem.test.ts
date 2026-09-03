import { describe, it, expect } from "vitest";
import {
  AFTER_WAIT_MS,
  computeFacts,
  isPostmortemDue,
  type PostmortemRow,
} from "../../supabase/functions/postmortem/facts.ts";
import {
  DIAGNOSIS_SCHEMA,
  MAX_RULES,
  buildConsolidationPrompt,
  buildDiagnosisPrompt,
  parseConsolidation,
  parseDiagnosis,
  summarizeRecord,
  type PlanSummary,
} from "../../supabase/functions/postmortem/prompt.ts";
import {
  MAX_PROMPT_CHARS,
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
    { id: "r1", text_ja: "旧ルール", text_en: "old rule", cause: "entry_too_far", support: 3, scope: null, since: "2026-08-01T00:00:00Z" },
  ];

  it("keeps the birth date of a continuing rule, caps the list and de-duplicates ids", () => {
    const rules = Array.from({ length: MAX_RULES + 3 }, (_, i) => ({
      id: i === 0 ? "r1" : i === 1 ? "r1" : `r${i + 1}`,
      text_ja: `ルール${i}`, text_en: `rule ${i}`, cause: i % 2 ? "stop_too_tight" : "weird", support: i === 0 ? 5 : 1, scope: i === 0 ? "1h" : null,
    }));
    const c = parseConsolidation({ rules, summary_ja: "s", summary_en: "s-en" }, previous, "2026-09-03T00:00:00Z");
    expect(c?.rules).toHaveLength(MAX_RULES);
    expect(c?.rules[0]).toMatchObject({ id: "r1", since: "2026-08-01T00:00:00Z", support: 5, scope: "1h", cause: "general" });
    expect(c?.rules[1].id).toBe("r1_");
    expect(c?.rules[1].since).toBe("2026-09-03T00:00:00Z");
    expect(c?.rules[1].cause).toBe("stop_too_tight");
    expect(c?.summary_en).toBe("s-en");
  });

  it("refuses an empty or malformed rewrite", () => {
    expect(parseConsolidation({ rules: [] }, previous, T0)).toBeNull();
    expect(parseConsolidation({ rules: [{ id: "x" }] }, previous, T0)).toBeNull();
    expect(parseConsolidation(null, previous, T0)).toBeNull();
  });

  it("summarises the record the way the UI does, with the shadow plans apart", () => {
    const rows = [
      { outcome: "win", signal: "BUY", shadow: false, rejection: null, filled: true },
      { outcome: "loss", signal: "SELL", shadow: false, rejection: null, filled: true },
      { outcome: "untriggered", signal: "SELL", shadow: false, rejection: null, filled: false },
      { outcome: "ambiguous", signal: "SELL", shadow: false, rejection: null, filled: true },
      { outcome: "pending", signal: "SELL", shadow: false, rejection: null, filled: false },
      { outcome: "skipped", signal: "WAIT", shadow: false, rejection: "should_be_market", filled: false },
      { outcome: "skipped", signal: "WAIT", shadow: false, rejection: null, filled: false },
      { outcome: "untriggered", signal: "SELL", shadow: true, rejection: "should_be_market", filled: false },
      { outcome: "win", signal: "SELL", shadow: true, rejection: "too_far", filled: true },
    ];
    const s = summarizeRecord(rows, [{ cause: "stop_too_tight" }, { cause: "stop_too_tight" }, { cause: "entry_too_far" }]);
    expect(s).toMatchObject({ total: 5, wins: 1, losses: 1, untriggered: 1, ambiguous: 1, open: 1, win_rate: 50, fill_rate: 75, rejected: 1 });
    expect(s.shadow).toEqual({ total: 2, untriggered: 1, wins: 1, losses: 0, open: 0 });
    expect(s.by_cause).toEqual({ stop_too_tight: 2, entry_too_far: 1 });
    const p = buildConsolidationPrompt(previous, [], s);
    expect(p.user).toContain('"rejected":1');
    expect(p.system).toContain(String(MAX_RULES));
  });
});

describe("rules in the analyze prompt", () => {
  const rules: Rule[] = [
    { id: "r1", text_ja: "弱い方", text_en: "weak", cause: "general", support: 1, scope: null, since: null },
    { id: "r2", text_ja: "強い方", text_en: "strong", cause: "stop_too_tight", support: 4, scope: "1h", since: null },
  ];

  it("renders the best-supported rules first, with their scope and evidence", () => {
    const text = renderLearnedRules(rules);
    const lines = text.split("\n");
    expect(lines[0]).toContain("過去の判定から学んだルール");
    expect(lines[1]).toBe("- ［1h］強い方（実績4件）");
    expect(lines[2]).toBe("- 弱い方（実績1件）");
  });

  it("renders nothing when nothing has been learned", () => {
    expect(renderLearnedRules([])).toBe("");
    expect(renderLearnedRules(parseRules("junk"))).toBe("");
  });

  it("stays inside its character budget", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ ...rules[1], id: `r${i}`, text_ja: "あ".repeat(120), support: 40 - i }));
    const text = renderLearnedRules(many);
    expect(text.length).toBeLessThanOrEqual(MAX_PROMPT_CHARS + 80);
    expect(text.split("\n").length - 1).toBeLessThanOrEqual(12);
  });

  it("reads stored rows defensively", () => {
    const parsed = parseRules([
      { id: "r1", text_ja: "a", text_en: "b", cause: "x", support: "3", scope: "", since: null },
      { text_en: "only english", support: -2 },
      { id: "r3" },
      "junk",
    ]);
    expect(parsed).toEqual([
      { id: "r1", text_ja: "a", text_en: "b", cause: "x", support: 3, scope: null, since: null },
      { id: "r2", text_ja: "only english", text_en: "only english", cause: "unknown", support: 1, scope: null, since: null },
    ]);
  });
});
