// Whether the move a timeframe is in has started to turn — decided in code,
// from facts the analyst can cite and the gate can act on.
//
// Measured 2026-09-19 over the 9/8–9/15 USD/JPY record. The daily label read
// 下降 through 9/19 (the two-pivot read needs two confirmed swings after the
// low), the system prompt made the higher timeframe's direction a confidence
// veto, and so the analyst had no way to say "this fall is ending" until the
// daily had closed above its last high. On 9/14 23:30 and 9/15 02:21 it sold
// the daily at 154.4 with the last settled breakdown eight bars old, the MACD
// histogram rising on every close since 9/10, RSI back from 22 to 38 and 0.30
// ATR of room to the next level below. Both lost. On 9/14 20:47 the 1h had
// closed through 154.489 and held it, with RSI 68 and the histogram positive,
// and the answer was WAIT — because the daily was "down". The record holds
// 62 SELLs, one BUY, and not one BUY proposed by the analyst.
//
// None of those facts was hidden from the model; they were spread across the
// indicator block and the structure block, unnamed, and nothing in the prompt
// said what they add up to. This module names them, counts them, and says
// which way they point. Symmetric by construction: every fact for "turning
// up" has its mirror for "turning down", read off the same series.
//
// What it is NOT: a direction. structureBias (entry.ts) still decides which
// way a rung points, off its closes. This says whether that direction is
// losing its footing, and how much evidence says so.
//
// Which facts were worth counting was checked, not assumed, against every
// decided SELL in the record (all pairs): a SELL placed within two bars of a
// settled breakdown won 6 of 8; a SELL placed after the last breakdown had
// been closed back through won 9 of 22; after a breakdown six or more bars
// old, 3 of 8. "Room to the next level under 0.5 ATR" — the lesson the
// post-mortems repeated ten times — separated nothing (5 wins, 5 losses), and
// is deliberately not a fact here.
//
// Deno-free on purpose: src/test/turn.test.ts imports this file directly.

import type { Candle } from "./indicators.ts";
import { emaSeries, rsiSeries, sma } from "./indicators.ts";
import type { LevelBreak, Structure } from "./structure.ts";
import type { Divergence } from "./divergence.ts";
import { FRESH_BREAK_BARS, STALE_BREAK_BARS, TURN_BLOCK, type TurnForGate } from "./entry.ts";

export { FRESH_BREAK_BARS, STALE_BREAK_BARS, TURN_BLOCK };

// The direction price would be turning TO
export type TurnSide = "Up" | "Down";

// The MACD histogram must have moved toward the turn on each of the last N
// closes. Two is one bar of noise; three is a run.
export const HIST_RUN_BARS = 3;
// RSI: the extreme it must have touched inside the lookback, and how far it
// must have come back from it. The daily on 9/15 read 22.1 → 38.0 over six
// bars; a bounce of a couple of points off 29 is not that.
export const RSI_LOOKBACK_BARS = 10;
export const RSI_EXTREME_LOW = 30;
export const RSI_EXTREME_HIGH = 70;
export const RSI_RECOVERY = 8;
// A close on the far side of SMA20 counts only while the crossing is recent:
// a series forty bars above its mean is trending, not turning.
export const MEAN_CROSS_BARS = 5;
// A level settled through IN the turn's direction counts while it is this
// recent. A break from thirty bars ago is history.
export const COUNTER_BREAK_BARS = STALE_BREAK_BARS;
// A break that was settled through and then closed back (structure.ts,
// "reclaimed") counts while the break itself is this recent. The 8/28 daily
// up-break that 9/2 reclaimed was thirteen bars old by 9/15 — that reclaim
// was the start of the fall, not evidence about its end.
export const FAILED_BREAK_BARS = STALE_BREAK_BARS * 2;

export type TurnFact =
  // the last settled break AGAINST the turn was closed back through
  | "failed_break"
  // the last settled break against the turn is old, and nothing has settled
  // through on that side since
  | "stale_break"
  // MACD histogram moved toward the turn on each of the last HIST_RUN_BARS closes
  | "hist_run"
  // RSI touched the extreme against the turn inside the lookback and has
  // travelled RSI_RECOVERY points back
  | "rsi_recovery"
  // a close crossed SMA20 toward the turn inside MEAN_CROSS_BARS
  | "mean_cross"
  // a level was settled through IN the turn's direction inside COUNTER_BREAK_BARS
  | "counter_break"
  // RSI divergence toward the turn (entry timeframe only; divergence.ts)
  | "divergence";

export const TURN_FACTS: readonly TurnFact[] = [
  "failed_break",
  "stale_break",
  "hist_run",
  "rsi_recovery",
  "mean_cross",
  "counter_break",
  "divergence",
];

// One fact, with the numbers it was read from. Which fields are present
// depends on the fact (see `render` below); the rest are null.
export interface TurnFactHit {
  fact: TurnFact;
  level: number | null;
  barsAgo: number | null;
  from: number | null;
  to: number | null;
}

export interface TurnEvidence {
  side: TurnSide;
  facts: TurnFactHit[];
  score: number;
}

export interface TurnRead {
  ok: boolean;
  reason: string | null;
  bars: number;
  // Evidence that the move is turning UP (against a fall) and DOWN (against a
  // rise). Both are always computed: which one matters depends on the plan.
  up: TurnEvidence;
  down: TurnEvidence;
}

const empty = (side: TurnSide): TurnEvidence => ({ side, facts: [], score: 0 });

const usable = (v: number | null | undefined): v is number =>
  typeof v === "number" && Number.isFinite(v);

// The histogram at every bar, aligned with `closes`. Built exactly as
// indicators.ts's macd() builds its last value, so the newest entry here is
// the number the indicator block prints.
export const macdHistSeries = (
  closes: number[],
  fast = 12,
  slow = 26,
  signalPeriod = 9,
): Array<number | null> => {
  const out: Array<number | null> = closes.map(() => null);
  if (closes.length < slow + signalPeriod) return out;
  const fastSeries = emaSeries(closes, fast);
  const slowSeries = emaSeries(closes, slow);
  const line: number[] = [];
  for (let i = slow - 1; i < closes.length; i++) {
    line.push((fastSeries[i] as number) - (slowSeries[i] as number));
  }
  const signal = emaSeries(line, signalPeriod);
  for (let j = 0; j < line.length; j++) {
    const s = signal[j];
    if (s !== null) out[slow - 1 + j] = line[j] - s;
  }
  return out;
};

const hit = (fact: TurnFact, parts: Partial<Omit<TurnFactHit, "fact">> = {}): TurnFactHit => ({
  fact,
  level: parts.level ?? null,
  barsAgo: parts.barsAgo ?? null,
  from: parts.from ?? null,
  to: parts.to ?? null,
});

const evidenceFor = (
  side: TurnSide,
  candles: Candle[],
  st: Structure,
  dv: Divergence | null,
  hist: Array<number | null>,
  rsi: Array<number | null>,
): TurnEvidence => {
  const facts: TurnFactHit[] = [];
  const sign = side === "Up" ? 1 : -1;
  // The breaks AGAINST the turn are on the side the move has been going:
  // a fall is made of breaks down.
  const against: LevelBreak | null = side === "Up" ? st.lastBreak.down : st.lastBreak.up;
  const withTurn: LevelBreak | null = side === "Up" ? st.lastBreak.up : st.lastBreak.down;

  if (against && against.state === "reclaimed" && against.barsAgo <= FAILED_BREAK_BARS) {
    facts.push(hit("failed_break", { level: against.level, barsAgo: against.barsAgo }));
  }
  if (against && against.state === "broken" && against.barsAgo >= STALE_BREAK_BARS) {
    facts.push(hit("stale_break", { level: against.level, barsAgo: against.barsAgo }));
  }

  const n = candles.length;
  // hist[n-1-HIST_RUN_BARS .. n-1], every step in the turn's direction
  const window = hist.slice(n - 1 - HIST_RUN_BARS);
  if (window.length === HIST_RUN_BARS + 1 && window.every(usable)) {
    const w = window as number[];
    let run = true;
    for (let i = 1; i < w.length; i++) if ((w[i] - w[i - 1]) * sign <= 0) run = false;
    if (run) facts.push(hit("hist_run", { from: w[0], to: w[w.length - 1], barsAgo: HIST_RUN_BARS }));
  }

  const now = rsi[n - 1];
  if (usable(now)) {
    let extreme: number | null = null;
    let extremeAt = -1;
    for (let i = Math.max(0, n - 1 - RSI_LOOKBACK_BARS); i < n - 1; i++) {
      const v = rsi[i];
      if (!usable(v)) continue;
      if (extreme === null || (v - extreme) * sign < 0) {
        extreme = v;
        extremeAt = i;
      }
    }
    if (extreme !== null) {
      const touched = side === "Up" ? extreme <= RSI_EXTREME_LOW : extreme >= RSI_EXTREME_HIGH;
      if (touched && (now - extreme) * sign >= RSI_RECOVERY) {
        facts.push(hit("rsi_recovery", { from: extreme, to: now, barsAgo: n - 1 - extremeAt }));
      }
    }
  }

  const closes = candles.map((c) => c.close);
  const meanAt = (i: number) => sma(closes.slice(0, i + 1), 20);
  const meanNow = meanAt(n - 1);
  if (meanNow !== null && (closes[n - 1] - meanNow) * sign > 0) {
    // the most recent bar that closed on the far side: that is when it crossed
    for (let k = 1; k <= MEAN_CROSS_BARS && n - 1 - k >= 0; k++) {
      const m = meanAt(n - 1 - k);
      if (m === null) break;
      if ((closes[n - 1 - k] - m) * sign <= 0) {
        facts.push(hit("mean_cross", { level: meanNow, barsAgo: k, to: closes[n - 1] }));
        break;
      }
    }
  }

  if (withTurn && withTurn.state === "broken" && withTurn.barsAgo <= COUNTER_BREAK_BARS) {
    facts.push(hit("counter_break", { level: withTurn.level, barsAgo: withTurn.barsAgo }));
  }

  if (dv && dv.status === (side === "Up" ? "bullish" : "bearish")) {
    facts.push(hit("divergence"));
  }

  return { side, facts, score: facts.length };
};

/**
 * The turn evidence for one timeframe.
 *
 * `candles` are CLOSED bars only and `st` is computeStructure over the same
 * bars — the two must describe one series, which is why this takes the
 * structure rather than recomputing it. `dv` is the entry timeframe's
 * divergence, or null on the rungs where none is computed.
 */
export const computeTurn = (
  candles: Candle[],
  st: Structure,
  dv: Divergence | null,
): TurnRead => {
  const base: TurnRead = { ok: false, reason: null, bars: candles.length, up: empty("Up"), down: empty("Down") };
  if (!st.ok) return { ...base, reason: st.reason ?? "structure" };
  if (candles.length < 40) return { ...base, reason: `too_few_bars:${candles.length}` };
  const closes = candles.map((c) => c.close);
  const hist = macdHistSeries(closes);
  const rsi = rsiSeries(closes);
  return {
    ...base,
    ok: true,
    up: evidenceFor("Up", candles, st, dv, hist, rsi),
    down: evidenceFor("Down", candles, st, dv, hist, rsi),
  };
};

// The two counts the gate reads (entry.ts). Nothing else crosses that seam:
// the gate must not need this module's types to be tested.
export const turnForGate = (t: TurnRead | null | undefined): TurnForGate | null =>
  !t || !t.ok
    ? null
    : {
      up: { score: t.up.score, facts: t.up.facts.map((f) => f.fact) },
      down: { score: t.down.score, facts: t.down.facts.map((f) => f.fact) },
    };

// ---------------------------------------------------------------------------
// Rendering, for the prompt
// ---------------------------------------------------------------------------

const renderFact = (f: TurnFactHit, side: TurnSide, p: (v: number | null) => string): string => {
  // Against a turn UP, the breaks that matter are breaks DOWN
  const againstWord = side === "Up" ? "下" : "上";
  const withWord = side === "Up" ? "上" : "下";
  const x = (v: number | null, d = 2) => (usable(v) ? v.toFixed(d) : "n/a");
  const signed = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(1)}`;
  switch (f.fact) {
    case "failed_break":
      return `${againstWord}抜け${p(f.level)}(${f.barsAgo}本前)はその後の終値で戻された`;
    case "stale_break":
      return `最後の${againstWord}抜け${p(f.level)}は${f.barsAgo}本前・以後に新しい${againstWord}抜けなし`;
    case "hist_run":
      return `MACDヒストが${f.barsAgo}本連続で${side === "Up" ? "上昇" : "下降"}(${x(f.from, 5)}→${x(f.to, 5)})`;
    case "rsi_recovery":
      return `RSI ${x(f.from, 1)}(${f.barsAgo}本前)→${x(f.to, 1)} (${usable(f.from) && usable(f.to) ? signed(f.to - f.from) : "n/a"})`;
    case "mean_cross":
      return `終値がSMA20(${p(f.level)})を${withWord}に抜けて${f.barsAgo}本`;
    case "counter_break":
      return `${withWord}抜け${p(f.level)}(${f.barsAgo}本前)が終値で成立`;
    case "divergence":
      return side === "Up" ? "強気ダイバージェンス" : "弱気ダイバージェンス";
  }
};

// One line per timeframe. Both sides are printed even when one is empty, so
// "no evidence of a turn down" is a stated reading and not an absence.
export const turnLines = (t: TurnRead, decimals: number): string => {
  if (!t.ok) return `転換の証拠(サーバ判定): 判定保留 (${t.reason ?? "不明"})`;
  const p = (v: number | null) => (usable(v) ? v.toFixed(decimals) : "n/a");
  const side = (e: TurnEvidence) => {
    const word = e.side === "Up" ? "上向き" : "下向き";
    const list = e.facts.length === 0 ? "なし" : e.facts.map((f) => renderFact(f, e.side, p)).join(" / ");
    return `${word} ${e.score}/${TURN_FACTS.length} [${list}]`;
  };
  return `転換の証拠(サーバ判定・確定足): ${side(t.up)} ｜ ${side(t.down)}`;
};

// The turn, in the shape it is stored on the plan (context.turn), beside
// compactStructure. Prices to the pair's decimals, indicator values to five.
const r = (v: number | null, d: number): number | null => (usable(v) ? Number(v.toFixed(d)) : null);

export const compactTurn = (tf: string, t: TurnRead, decimals: number) => {
  if (!t.ok) return { tf, ok: false, reason: t.reason, bars: t.bars };
  const side = (e: TurnEvidence) => ({
    score: e.score,
    facts: e.facts.map((f) => ({
      fact: f.fact,
      level: r(f.level, decimals),
      bars_ago: f.barsAgo,
      from: r(f.from, 5),
      to: r(f.to, 5),
    })),
  });
  return { tf, ok: true, reason: t.reason, bars: t.bars, block: TURN_BLOCK, up: side(t.up), down: side(t.down) };
};
