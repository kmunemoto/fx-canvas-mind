import { describe, it, expect } from "vitest";
import {
  COUNTER_BREAK_BARS,
  HIST_RUN_BARS,
  RSI_EXTREME_LOW,
  RSI_RECOVERY,
  TURN_FACTS,
  compactTurn,
  computeTurn,
  macdHistSeries,
  turnForGate,
  turnLines,
} from "../../supabase/functions/analyze/turn";
import {
  FRESH_BREAK_BARS,
  STALE_BREAK_BARS,
  TURN_BLOCK,
  freshBreakOn,
  isTurning,
  structureBias,
  turnConflictFor,
} from "../../supabase/functions/analyze/entry";
import { computeStructure } from "../../supabase/functions/analyze/structure";
import { atr, macd, rsiSeries, type Candle } from "../../supabase/functions/analyze/indicators";

const T0 = Date.parse("2026-09-01T00:00:00Z");
const HOUR = 3_600_000;
const PIP = 0.01;

const bar = (i: number, o: number, h: number, l: number, c: number): Candle => ({
  datetime: new Date(T0 + i * HOUR).toISOString(),
  open: o,
  high: h,
  low: l,
  close: c,
});

// A path of closes turned into bars. The wick scales with the bar's own
// move, so the bar at the bottom of a leg (a big move) reaches lower than the
// small bar that follows it — a fixed wick made their lows tie, and a tie is
// not a pivot (structure.ts, pivots).
const fromCloses = (closes: number[]): Candle[] =>
  closes.map((c, i) => {
    const o = i === 0 ? c : closes[i - 1];
    const wick = 0.15 * Math.abs(c - o) + 0.005;
    return bar(i, o, Math.max(o, c) + wick, Math.min(o, c) - wick, c);
  });

// Flat, then a fall made of legs — four bars down, two up, so every leg's
// bottom is a confirmed pivot low that the next leg settles through — then
// `bounce` bars up that stay under the last broken level. The shape of the
// 9/8–9/14 daily, in miniature.
const fallThenBounce = (bounce: number, legs = 5): Candle[] => {
  const closes: number[] = [];
  for (let i = 0; i < 40; i++) closes.push(150 + (i % 2 === 0 ? 0.02 : -0.02));
  let p = 150;
  for (let k = 0; k < legs; k++) {
    for (let i = 0; i < 4; i++) { p -= 0.3; closes.push(p); }
    for (let i = 0; i < 2; i++) { p += 0.1; closes.push(p); }
  }
  for (let i = 0; i < bounce; i++) { p += 0.15; closes.push(p); }
  return fromCloses(closes);
};

const mirror = (rows: Candle[]): Candle[] =>
  rows.map((c) => ({ ...c, open: 300 - c.open, high: 300 - c.low, low: 300 - c.high, close: 300 - c.close }));

const read = (rows: Candle[]) => {
  const st = computeStructure(rows, atr(rows), PIP);
  return { st, turn: computeTurn(rows, st, null) };
};

describe("macdHistSeries", () => {
  it("ends on the number the indicator block prints", () => {
    const rows = fallThenBounce(6);
    const closes = rows.map((c) => c.close);
    const series = macdHistSeries(closes);
    expect(series[series.length - 1]).toBeCloseTo(macd(closes)!.hist, 12);
    // and is null before the slow EMA and the signal have both seeded
    expect(series[25 + 9 - 2]).toBeNull();
    expect(series[25 + 9 - 1]).not.toBeNull();
  });
});

describe("the fall that has started to turn — the 9/14 daily in miniature", () => {
  const rows = fallThenBounce(3);
  const { st, turn } = read(rows);

  it("is read off a structure that still points down", () => {
    expect(st.ok).toBe(true);
    expect(structureBias(st).bias).toBe("Down");
    expect(st.lastBreak.down?.state).toBe("broken");
    expect(st.lastBreak.down!.barsAgo).toBeGreaterThanOrEqual(STALE_BREAK_BARS);
  });

  it("counts the stale break, the histogram run and the RSI recovery, and calls it turning", () => {
    const facts = turn.up.facts.map((f) => f.fact);
    expect(facts).toContain("stale_break");
    expect(facts).toContain("hist_run");
    expect(facts).toContain("rsi_recovery");
    expect(turn.up.score).toBe(turn.up.facts.length);
    expect(turn.up.score).toBeGreaterThanOrEqual(TURN_BLOCK);
    // the numbers each fact was read from travel with it
    const rsi = turn.up.facts.find((f) => f.fact === "rsi_recovery")!;
    expect(rsi.from).toBeLessThanOrEqual(RSI_EXTREME_LOW);
    expect(rsi.to! - rsi.from!).toBeGreaterThanOrEqual(RSI_RECOVERY);
    const hist = turn.up.facts.find((f) => f.fact === "hist_run")!;
    expect(hist.barsAgo).toBe(HIST_RUN_BARS);
    expect(hist.to!).toBeGreaterThan(hist.from!);
    expect(isTurning(st, "Down", turnForGate(turn))).toBe(true);
  });

  it("says nothing is turning DOWN about a series that has been falling", () => {
    expect(turn.down.score).toBe(0);
    expect(isTurning(st, "Down", { up: { score: 0, facts: [] }, down: turnForGate(turn)!.down })).toBe(false);
  });

  it("refuses a SELL riding the fall and leaves a BUY against it alone", () => {
    const es = { structure: st, turn: turnForGate(turn) };
    expect(turnConflictFor("SELL", es)).toMatchObject({ side: "Up", score: turn.up.score, block: TURN_BLOCK });
    expect(turnConflictFor("SELL", es)!.facts).toEqual(turn.up.facts.map((f) => f.fact));
    expect(turnConflictFor("BUY", es)).toBeNull();
    expect(turnConflictFor("WAIT", es)).toBeNull();
  });
});

describe("symmetry: a rise that has started to turn reads as the mirror image", () => {
  const rows = fallThenBounce(3);
  const flipped = mirror(rows);
  const a = read(rows);
  const b = read(flipped);

  it("finds the same facts on the other side", () => {
    expect(structureBias(b.st).bias).toBe("Up");
    expect(b.turn.down.facts.map((f) => f.fact)).toEqual(a.turn.up.facts.map((f) => f.fact));
    expect(b.turn.up.facts.map((f) => f.fact)).toEqual(a.turn.down.facts.map((f) => f.fact));
    expect(b.turn.down.score).toBe(a.turn.up.score);
  });

  it("refuses the BUY riding the rise, and leaves the SELL alone", () => {
    const es = { structure: b.st, turn: turnForGate(b.turn) };
    expect(turnConflictFor("BUY", es)).toMatchObject({ side: "Down", score: a.turn.up.score });
    expect(turnConflictFor("SELL", es)).toBeNull();
  });
});

describe("a fresh break is the move still going, whatever the oscillators say", () => {
  // Legs, then a final leg cut to two bars: its first bar settled through
  // the previous leg's bottom, one bar ago.
  const closes: number[] = [];
  for (let i = 0; i < 40; i++) closes.push(150 + (i % 2 === 0 ? 0.02 : -0.02));
  let p = 150;
  for (let k = 0; k < 4; k++) {
    for (let i = 0; i < 4; i++) { p -= 0.3; closes.push(p); }
    for (let i = 0; i < 2; i++) { p += 0.1; closes.push(p); }
  }
  for (let i = 0; i < 2; i++) { p -= 0.3; closes.push(p); }
  const rows = fromCloses(closes);
  const { st, turn } = read(rows);

  it("reads a breakdown inside FRESH_BREAK_BARS", () => {
    expect(st.lastBreak.down?.state).toBe("broken");
    expect(st.lastBreak.down!.barsAgo).toBeLessThanOrEqual(FRESH_BREAK_BARS);
    expect(freshBreakOn(st, "down")).toBe(true);
  });

  it("never refuses the SELL for a turn, even with the score forced to the threshold", () => {
    const forced = { up: { score: TURN_BLOCK, facts: ["stale_break", "hist_run", "rsi_recovery"] }, down: { score: 0, facts: [] } };
    expect(turnConflictFor("SELL", { structure: st, turn: forced })).toBeNull();
    expect(isTurning(st, "Down", forced)).toBe(false);
    // and the real read carries no stale break — the break is new
    expect(turn.up.facts.map((f) => f.fact)).not.toContain("stale_break");
  });
});

describe("the facts that need a recent event stay recent", () => {
  it("counter_break is the break in the turn's own direction, inside its window", () => {
    // The mirror of the fresh-breakdown series is a fresh breakout: for a
    // turn UP that is a counter_break, for a turn DOWN it is the move itself.
    const closes: number[] = [];
    for (let i = 0; i < 40; i++) closes.push(150 + (i % 2 === 0 ? 0.02 : -0.02));
    let p = 150;
    for (let k = 0; k < 4; k++) {
      for (let i = 0; i < 4; i++) { p += 0.3; closes.push(p); }
      for (let i = 0; i < 2; i++) { p -= 0.1; closes.push(p); }
    }
    for (let i = 0; i < 2; i++) { p += 0.3; closes.push(p); }
    const { st, turn } = read(fromCloses(closes));
    expect(st.lastBreak.up?.state).toBe("broken");
    expect(st.lastBreak.up!.barsAgo).toBeLessThanOrEqual(COUNTER_BREAK_BARS);
    const hit = turn.up.facts.find((f) => f.fact === "counter_break");
    expect(hit).toBeDefined();
    expect(hit!.level).toBe(st.lastBreak.up!.level);
    expect(hit!.barsAgo).toBe(st.lastBreak.up!.barsAgo);
    expect(turn.down.facts.map((f) => f.fact)).not.toContain("counter_break");
  });
});

describe("what it says, and what it stores", () => {
  const rows = fallThenBounce(3);
  const { st, turn } = read(rows);

  it("renders both sides on one line, with the count out of the fact list", () => {
    const line = turnLines(turn, 3);
    expect(line).toContain("転換の証拠(サーバ判定・確定足)");
    expect(line).toContain(`上向き ${turn.up.score}/${TURN_FACTS.length}`);
    expect(line).toContain(`下向き 0/${TURN_FACTS.length} [なし]`);
    expect(line).toContain("MACDヒスト");
    expect(line).toContain("RSI");
    expect(line.split("\n")).toHaveLength(1);
    expect(line.length).toBeLessThan(400);
  });

  it("refuses to render or count anything off an unusable structure", () => {
    const short = rows.slice(0, 30);
    const bad = computeStructure(short, atr(short), PIP);
    const t = computeTurn(short, bad, null);
    expect(t.ok).toBe(false);
    expect(t.up.score).toBe(0);
    expect(turnLines(t, 3)).toContain("判定保留");
    expect(turnForGate(t)).toBeNull();
    expect(compactTurn("1h", t, 3)).toEqual({ tf: "1h", ok: false, reason: t.reason, bars: 30 });
  });

  it("stores the threshold beside the counts, and the numbers beside the facts", () => {
    const c = compactTurn("1day", turn, 3) as Record<string, unknown>;
    expect(c.ok).toBe(true);
    expect(c.block).toBe(TURN_BLOCK);
    const up = c.up as { score: number; facts: Array<Record<string, unknown>> };
    expect(up.score).toBe(turn.up.score);
    expect(up.facts.map((f) => f.fact)).toEqual(turn.up.facts.map((f) => f.fact));
    for (const f of up.facts) expect(Object.keys(f).sort()).toEqual(["bars_ago", "fact", "from", "level", "to"]);
  });

  it("hands the gate the two counts and the fact names, nothing else", () => {
    const g = turnForGate(turn)!;
    expect(g).toEqual({
      up: { score: turn.up.score, facts: turn.up.facts.map((f) => f.fact) },
      down: { score: 0, facts: [] },
    });
  });

  it("rsiSeries is what the recovery is read from", () => {
    const series = rsiSeries(rows.map((c) => c.close));
    const hit = turn.up.facts.find((f) => f.fact === "rsi_recovery")!;
    expect(hit.to).toBeCloseTo(series[series.length - 1]!, 9);
  });
});

// THE 9/15 DAILY, AS THE SERVER WOULD READ IT NOW.
//
// The forty daily bars that were in the prompt of the 9/15 02:21 JST SELL
// (analysis_prompts, 2026-09-14 17:21 UTC), read as closed bars — which is
// the closed series the 9/15 22:52 JST SELL was judged on. Forty bars is the
// least computeStructure accepts, so the histogram has six values and the RSI
// carries more of its seed than it would on the 271 bars production reads;
// what is asserted is the shape of the reading, not the fourth decimal.
const DAILY_0915: Array<[string, number, number, number, number]> = [
  ["2026-07-30", 163.43786, 163.74131, 157.94708, 159.54396],
  ["2026-07-31", 159.57659, 160.89204, 157.42088, 157.46124],
  ["2026-08-02", 157.62134, 158.15371, 157.02617, 157.22446],
  ["2026-08-03", 157.22112, 157.87141, 155.25118, 157.20071],
  ["2026-08-04", 157.19512, 157.96897, 157.14772, 157.73525],
  ["2026-08-05", 157.74145, 157.8688, 157.31747, 157.77151],
  ["2026-08-06", 157.77244, 158.54377, 157.55979, 158.47131],
  ["2026-08-07", 158.4738, 158.57867, 156.75879, 157.79433],
  ["2026-08-09", 157.82301, 157.94834, 157.55408, 157.7481],
  ["2026-08-10", 157.74836, 159.3653, 157.67157, 159.31691],
  ["2026-08-11", 159.31153, 159.39136, 158.96128, 159.30255],
  ["2026-08-12", 159.30271, 159.54195, 158.73433, 159.43154],
  ["2026-08-13", 159.43219, 159.56954, 159.03591, 159.52336],
  ["2026-08-14", 159.51949, 159.54679, 158.63325, 159.3206],
  ["2026-08-16", 159.31783, 159.39575, 159.1872, 159.31991],
  ["2026-08-17", 159.31442, 159.59935, 158.85226, 159.4692],
  ["2026-08-18", 159.4717, 159.78217, 159.30593, 159.62429],
  ["2026-08-19", 159.6287, 159.65469, 158.05538, 158.15784],
  ["2026-08-20", 158.15919, 159.17568, 158.03631, 159.07472],
  ["2026-08-21", 159.07528, 159.14371, 158.3743, 158.97932],
  ["2026-08-23", 158.96173, 159.12455, 158.6436, 159.01237],
  ["2026-08-24", 159.01255, 159.28622, 158.54563, 159.09768],
  ["2026-08-25", 159.09948, 159.49191, 159.05529, 159.21233],
  ["2026-08-26", 159.20786, 159.44751, 158.89027, 159.31576],
  ["2026-08-27", 159.31659, 159.51455, 159.11766, 159.41185],
  ["2026-08-28", 159.40995, 160.20556, 159.30459, 160.11541],
  ["2026-08-30", 160.1027, 160.23685, 159.90367, 160.06593],
  ["2026-08-31", 160.07273, 160.20195, 159.48706, 159.74629],
  ["2026-09-01", 159.74676, 160.27118, 159.6411, 160.19861],
  ["2026-09-02", 160.19916, 160.40466, 158.27877, 158.72699],
  ["2026-09-03", 158.72599, 158.96743, 155.30841, 155.8121],
  ["2026-09-04", 155.81038, 156.84624, 155.2976, 156.25071],
  ["2026-09-06", 156.23459, 156.38212, 155.86375, 155.99882],
  ["2026-09-07", 155.99884, 156.28476, 154.06047, 154.3609],
  ["2026-09-08", 154.36303, 154.5002, 152.90794, 153.99706],
  ["2026-09-09", 153.99968, 154.01176, 152.95714, 153.5536],
  ["2026-09-10", 153.5543, 154.65897, 153.31138, 154.49485],
  ["2026-09-11", 154.48598, 154.61701, 153.27802, 153.52682],
  ["2026-09-13", 153.56871, 154.12917, 152.37945, 153.58473],
  ["2026-09-14", 153.5839, 155.00251, 153.21967, 154.37469],
];

describe("the 9/15 daily SELL, replayed through the turn read", () => {
  const rows: Candle[] = DAILY_0915.map(([datetime, open, high, low, close]) => ({ datetime, open, high, low, close }));
  const { st, turn } = read(rows);

  it("still reads the daily as pointing down off a breakdown that is not fresh", () => {
    expect(st.ok).toBe(true);
    expect(structureBias(st)).toMatchObject({ bias: "Down", from: "break" });
    expect(st.lastBreak.down!.barsAgo).toBeGreaterThan(FRESH_BREAK_BARS);
  });

  it("counts the facts the 9/15 SELL was written over, and refuses it", () => {
    const facts = turn.up.facts.map((f) => f.fact);
    expect(facts).toContain("stale_break");
    expect(facts).toContain("hist_run");
    expect(facts).toContain("rsi_recovery");
    expect(turn.up.score).toBeGreaterThanOrEqual(TURN_BLOCK);
    expect(turn.down.score).toBeLessThan(TURN_BLOCK);
    const es = { structure: st, turn: turnForGate(turn) };
    expect(turnConflictFor("SELL", es)).toMatchObject({ side: "Up", block: TURN_BLOCK });
    // and a daily BUY is not this gate's business (the weekly above decides it)
    expect(turnConflictFor("BUY", es)).toBeNull();
  });

  it("says so in the prompt line, with the numbers", () => {
    const line = turnLines(turn, 3);
    expect(line).toMatch(/上向き [3-7]\/7/);
    expect(line).toContain("以後に新しい下抜けなし");
    expect(line).toMatch(/RSI \d+\.\d\(\d+本前\)→\d+\.\d \(\+\d+\.\d\)/);
  });
});
