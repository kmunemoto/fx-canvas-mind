// #112: a second signal beside RSI + Parabolic SAR — the GainzAlgo V2 [Alpha]
// conditions, with the settings the owner's GainzAlgo Suite chart showed.
//
// The request (2026-09-25), with a screenshot of GainzAlgo Suite running its
// "V2 Alpha" model on gold: 「同じこれを導入してほしい」, and, asked whether it
// should replace RSI + SAR, 「並べて追加」. GainzAlgo publishes none of its
// logic. What is known:
//
//   * third-party write-ups of the V2 [Alpha] script agree on four
//     conditions, on the bar's close (research/reversal.ts GAINZ, #107);
//   * the screenshot's status line prints the script's inputs in order —
//     "(huge, text bubble, 0.5, 50, 5, 1:2, 1, 3)" — which match that
//     script's inputs: label size, label style, Candle Stability Index 0.5,
//     RSI Index 50, Candle Delta Length 5, risk to reward 1:2, and a TP & SL
//     multiplier of 1. The last number is not known (its TP/SL labels print
//     three decimals; it may be their precision);
//   * back-solving the screenshot's two TP/SL labels at 1:2 puts the stops
//     5.83 and 3.17 from the closes — not at the signal bars' own lows and
//     highs, and wider where the bars around were more violent. That is
//     consistent with a stop one ATR away (the multiplier of 1), which is
//     what is used here; it is a reading, not something GainzAlgo states.
//
// THE RULE, a BUY on a CLOSED bar when all four hold (a SELL is the mirror):
//
//   1. engulfing: the bar before closed down, this one closes up and above
//      that bar's open;
//   2. stable: the body is more than half the bar's true range;
//   3. RSI(14) below 50 (above 50 for a SELL);
//   4. the close is below the close 5 bars earlier (above, for a SELL).
//
// THE PLAN: stop 1 ATR(14) from the close, target twice the stop (break-even
// win rate 33.3%), the same 48-bar horizon as RSI + SAR.
//
// It does not decide the app's published plan, which stays RSI + SAR: it is
// drawn on the chart, can be mailed, and is recorded (signal_events) so the
// two can be compared on prices nobody had seen when they were written.
//
// Deno-free on purpose: the tests and research/reversal.ts import it.

import type { Candle } from "./indicators.ts";
import { atrSeriesOf } from "./state.ts";
import { HORIZON_BARS, settle, wilderRsi, type Outcome, type Side } from "./rsisar.ts";

export const GA_STABILITY = 0.5;
export const GA_RSI_LEVEL = 50;
export const GA_DELTA = 5;
export const GA_STOP_ATR = 1;
export const GA_REWARD = 2;
export const GA_HORIZON = HORIZON_BARS;
// RSI's seed and ATR need this many bars before the first reading counts
export const GA_MIN_BARS = 60;
// The version of the rule a row was decided by, stored on it
export const GA_RULE_ID = "gainz_v2a_050_50_5_atr1_v1";
// How the app and the alert tables name the two rules
export const RULES = ["rsi_sar", "gainz"] as const;
export type RuleKey = (typeof RULES)[number];
export const isRuleKey = (v: unknown): v is RuleKey => v === "rsi_sar" || v === "gainz";

// The larger of the bar's range and its gap from the close before it
export const trueRange = (bars: Candle[], i: number): number => {
  const b = bars[i];
  if (i < 1) return b.high - b.low;
  const pc = bars[i - 1].close;
  return Math.max(b.high, pc) - Math.min(b.low, pc);
};

export const engulfs = (bars: Candle[], i: number, side: Side): boolean => {
  if (i < 1) return false;
  const a = bars[i - 1];
  const b = bars[i];
  return side === "BUY"
    ? a.close < a.open && b.close > b.open && b.close > a.open
    : a.close > a.open && b.close < b.open && b.close < a.open;
};

export const stableBar = (bars: Candle[], i: number): boolean => {
  const tr = trueRange(bars, i);
  return tr > 0 && Math.abs(bars[i].close - bars[i].open) / tr > GA_STABILITY;
};

// The rule on bar i, from closes up to i only
export const gainzAt = (bars: Candle[], rsi: Array<number | null>, i: number): Side | null => {
  if (i < GA_DELTA) return null;
  const r = rsi[i];
  if (r === null || r === undefined || !stableBar(bars, i)) return null;
  const close = bars[i].close;
  const then = bars[i - GA_DELTA].close;
  if (engulfs(bars, i, "BUY") && r < GA_RSI_LEVEL && close < then) return "BUY";
  if (engulfs(bars, i, "SELL") && r > 100 - GA_RSI_LEVEL && close > then) return "SELL";
  return null;
};

export const planForGa = (side: Side, entry: number, atr: number) => {
  const d = GA_STOP_ATR * atr;
  const dir = side === "BUY" ? 1 : -1;
  return { entry, stop: entry - dir * d, target: entry + dir * d * GA_REWARD };
};

export interface GainzSignal {
  index: number;
  datetime: string;
  side: Side;
  rsi: number;
  // the body over the bar's true range
  stability: number;
  atr: number;
  entry: number;
  stop: number;
  target: number;
  outcome: Outcome;
  bars: number | null;
}

export interface GainzRead {
  ok: boolean;
  reason: string | null;
  bars: number;
  signals: GainzSignal[];
  now: { datetime: string; close: number; rsi: number; atr: number; signal: Side | null } | null;
}

// `bars` must be CLOSED bars, oldest first.
export const readGainz = (bars: Candle[]): GainzRead => {
  if (bars.length < GA_MIN_BARS) return { ok: false, reason: `bars<${GA_MIN_BARS}`, bars: bars.length, signals: [], now: null };
  const { rsi } = wilderRsi(bars.map((c) => c.close));
  const atr = atrSeriesOf(bars);
  const signals: GainzSignal[] = [];
  for (let i = 1; i < bars.length; i++) {
    const side = gainzAt(bars, rsi, i);
    const a = atr[i];
    if (side === null || a === null || !(a > 0)) continue;
    const plan = planForGa(side, bars[i].close, a);
    // settle() walks the same 48 bars RSI + SAR's signals get
    const done = settle(bars, i, side, plan.stop, plan.target);
    signals.push({
      index: i,
      datetime: bars[i].datetime,
      side,
      rsi: rsi[i] as number,
      stability: Math.abs(bars[i].close - bars[i].open) / trueRange(bars, i),
      atr: a,
      entry: plan.entry,
      stop: plan.stop,
      target: plan.target,
      outcome: done.outcome,
      bars: done.bars,
    });
  }
  const i = bars.length - 1;
  const r = rsi[i];
  const a = atr[i];
  if (r === null || a === null || !(a > 0)) return { ok: false, reason: "no_reading", bars: bars.length, signals, now: null };
  return {
    ok: true,
    reason: null,
    bars: bars.length,
    signals,
    now: { datetime: bars[i].datetime, close: bars[i].close, rsi: r, atr: a, signal: gainzAt(bars, rsi, i) },
  };
};

const round = (v: number | null | undefined, d: number): number | null =>
  v === null || v === undefined || !Number.isFinite(v) ? null : Number(v.toFixed(d));

// The chart's marks, in the ChartSignalMark shape PriceChart draws
export const chartGainz = (read: GainzRead, chartBars: number, decimals: number) => {
  const from = Math.max(0, read.bars - chartBars);
  return read.signals.filter((s) => s.index >= from).map((s) => ({
    datetime: s.datetime,
    barsAgo: read.bars - 1 - s.index,
    side: s.side,
    rule: "gainz",
    level: null,
    entry: round(s.entry, decimals),
    stop: round(s.stop, decimals),
    target: round(s.target, decimals),
    stop_atr: GA_STOP_ATR,
    outcome: s.outcome,
    bars: s.bars,
    mfe_r: null,
  }));
};

// What the client's GA card draws: the reading on the newest closed bar, the
// plan if the rule fired on it, the tally on this chart and the evidence.
export const compactGainz = (tf: string, read: GainzRead, decimals: number) => {
  const sideTally = (side: Side) => {
    const s = read.signals.filter((x) => x.side === side);
    const count = (o: Outcome) => s.filter((x) => x.outcome === o).length;
    return { n: s.length, wins: count("win"), losses: count("loss"), ambiguous: count("ambiguous"), expired: count("expired"), open: count("open") };
  };
  const now = read.now;
  const plan = now && now.signal ? planForGa(now.signal, now.close, now.atr) : null;
  return {
    tf,
    rule: GA_RULE_ID,
    ok: read.ok,
    reason: read.reason,
    bars: read.bars,
    stop_atr: GA_STOP_ATR,
    reward_ratio: GA_REWARD,
    horizon: GA_HORIZON,
    now: now === null ? null : {
      datetime: now.datetime,
      close: round(now.close, decimals),
      rsi: round(now.rsi, 1),
      atr: round(now.atr, decimals),
      signal: now.signal,
      plan: plan === null ? null : { entry: round(plan.entry, decimals), stop: round(plan.stop, decimals), target: round(plan.target, decimals) },
    },
    tally: { BUY: sideTally("BUY"), SELL: sideTally("SELL") },
    evidence: {
      period: GA_EVIDENCE.period,
      pairs: GA_EVIDENCE.pairs,
      breakeven: GA_EVIDENCE.breakeven,
      tf: GA_EVIDENCE.byTf[tf] ?? NOT_MEASURED,
      all: GA_EVIDENCE.all,
    },
  };
};

// ---- what was measured -------------------------------------------------------------
//
// research/gainz.ts (#112 block, run 2026-09-25): GMO 15-minute bid/ask,
// eleven pairs, this exact rule and plan, spread paid, 17:00-23:59 UTC left
// out on 15min and 1h. Nothing was chosen on these numbers — the settings
// are the screenshot's — so both periods were reported; the second is the
// one quoted. `win` is over the trades that reached the stop or the target,
// `meanR` over every trade (one still open at 48 bars at its value then).
//
//   first period (2024-01 to 2025-06): 12,880 trades, won 30.4%, -0.086R
//   second period (2025-07 on):        10,757 trades, won 28.8%, -0.134R;
//     entering at every bar instead: -0.118R (the rule adds -0.015R,
//     [-0.047, +0.016]); 0 of 11 pairs positive
export interface GainzEvidence {
  measured: boolean;
  win: number | null;
  n: number | null;
  // mean result per trade over the stop distance, spread paid
  meanR: number | null;
}
const NOT_MEASURED: GainzEvidence = { measured: false, win: null, n: null, meanR: null };
export const GA_EVIDENCE = {
  period: "2025-07〜2026-09",
  pairs: 11,
  breakeven: 1 / (1 + GA_REWARD),
  all: { measured: true, win: 0.288, n: 10757, meanR: -0.134 } as GainzEvidence,
  byTf: {
    "1min": NOT_MEASURED,
    "15min": { measured: true, win: 0.282, n: 8317, meanR: -0.15 },
    "1h": { measured: true, win: 0.306, n: 1791, meanR: -0.08 },
    "4h": { measured: true, win: 0.307, n: 649, meanR: -0.08 },
    "1day": NOT_MEASURED,
  } as Record<string, GainzEvidence>,
};
