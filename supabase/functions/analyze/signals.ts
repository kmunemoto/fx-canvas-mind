// Where price bounced, counted rather than remembered.
//
// The request (#99): "on each timeframe, from the chart alone, work out under
// what conditions price bounces, and draw it on the chart the way a signal
// indicator does — BUY/SELL at the bar, with the stop and the target".
//
// The indicators that do that on social media repaint: the arrow is placed
// after the move it points at, so every arrow on the screenshot is right and
// none of them was on the screen when it mattered. Everything here is
// decided at the bar it is drawn on, from that bar and the ones before it,
// and the test suite pins that: running the detector on the first k bars must
// produce exactly the signals the full series shows at indices below k.
//
// WHAT A SIGNAL IS. A named condition (a rejection wick at a confirmed swing
// low, a re-entry into the Bollinger band, a bullish divergence confirmed,
// ...) that fired on a CLOSED bar, priced as the app would price it: the
// entry is that bar's close, the stop sits just past the extreme the bounce
// rejected (floored and capped by the same ATR limits entry.ts enforces on
// the model), the target is RR times the stop distance. Then the bars that
// followed are walked: target first is a win, stop first is a loss, both in
// one bar is ambiguous, neither inside the horizon is expired. Mid prices, no
// spread — the same series the analysis reads — and the prompt and the panel
// both say so.
//
// SYMMETRY BY CONSTRUCTION. Every rule is written for the BUY side only. The
// SELL side is the same code run on the series with every price negated: a
// high becomes a low, RSI becomes 100 - RSI, the lower band becomes the upper
// one, the cloud top becomes its bottom. There is no second copy of any rule
// to drift from the first, and the test suite pins the mirror too.
//
// WHAT THE COUNTS ARE NOT. A hit rate over one window is a count, not a law:
// nine wins in twelve on a 480-bar 1h window is what happened in those
// twenty days, on this pair. The 95% interval is printed beside every rate so
// that "6/9" and "60/90" cannot read alike, and the prompt is told the
// break-even rate at this RR and told not to cite anything below it.
//
// Deno-free on purpose: src/test/signals.test.ts imports this directly.

import { ICHIMOKU_SHIFT, bollinger, ichimoku, rsiSeries, type Candle } from "./indicators.ts";
import { BREAK_TOL_ATR, FLAT_TOL_ATR, PIVOT_BARS, pivots, type Pivot } from "./structure.ts";
import {
  MAX_GAP_BARS,
  MIN_GAP_BARS,
  PRICE_TOL_ATR,
  RSI_PERIOD,
  RSI_TOL,
  RSI_WARMUP_BARS,
} from "./divergence.ts";
import { MIN_STOP_ATR } from "./entry.ts";

// The widest stop a signal may carry, in ATR. The prompt has always told the
// model to place its stop "ATR×0.6〜1.2 from the price" (step 4), and the
// floor half of that is enforced by entry.ts (MIN_STOP_ATR); this is the
// ceiling half, applied here to the signals so that a bounce which needs a
// wider stop than a plan may carry is counted as such rather than priced
// with a stop the plan could not have. The prompt reads this constant too.
export const MAX_STOP_WIDTH_ATR = 1.2;
// Target distance as a multiple of the stop distance. 1.5 is the middle of
// what the published plans actually carry (MIN_RISK_REWARD is 1.2), and it
// makes the break-even hit rate 40%, which the prompt is told in so many
// words.
export const RR = 1.5;
// How many bars after the signal the walk looks for a resolution. Four times
// the 1h plan horizon: the point is to learn whether the bounce worked, and
// horizon.ts measured the winners in the long tail.
export const SIGNAL_HORIZON_BARS = 48;
// A bar "touches" a level when its extreme comes within this of it, or
// pierces it by no more than PIERCE_MAX_ATR. Deeper than that is a break
// with a recovery, which is a different event with a different stop.
export const TOUCH_TOL_ATR = 0.15;
export const PIERCE_MAX_ATR = 0.5;
// The rejecting wick must be at least this share of the bar's range. A bar
// that closes on its low did not reject anything.
export const WICK_MIN = 0.35;
// The stop sits this far beyond the extreme the bounce rejected, before the
// app's own floor and cap are applied.
export const STOP_PAD_ATR = 0.1;
// A swing further back than this is not a level the reader can see on the
// chart, and is not what a trader means by "support".
export const LEVEL_LOOKBACK_BARS = 200;
// The same rule may not fire again within this many bars: two rejections of
// one level three bars apart are one test of it, not two.
export const COOLDOWN_BARS = 3;
// Signals this recent are "in force now" — the ones the analyst can act on.
export const RECENT_BARS = 3;
// An SMA20 pullback is only a pullback when the average has been rising.
export const MA_RISE_BARS = 5;
// A double bottom needs a real swing between its two lows.
export const MIN_BOUNCE_ATR = 1.0;
// An engulfing body smaller than this is a doji with ambitions.
export const ENGULF_BODY_ATR = 0.5;
export const ATR_PERIOD = 14;
export const MIN_SIGNAL_BARS = 60;

export const SIGNAL_RULES = [
  "level_reject",
  "ma200_reject",
  "ma20_pullback",
  "band_reentry",
  "cloud_reject",
  "divergence",
  "double_pivot",
  "engulfing",
] as const;
export type SignalRule = (typeof SIGNAL_RULES)[number];
export type SignalSide = "BUY" | "SELL";
export type SignalOutcome = "win" | "loss" | "ambiguous" | "expired" | "open";

export interface Signal {
  index: number;
  barsAgo: number;
  datetime: string;
  side: SignalSide;
  rule: SignalRule;
  // The level the bounce was read against
  level: number;
  entry: number;
  stop: number;
  target: number;
  // Stop distance in ATR, after the floor and cap
  stopAtr: number;
  outcome: SignalOutcome;
  // Bars from the signal to the bar that resolved it
  bars: number | null;
  // Max favourable excursion inside the horizon, in R (stop distances)
  mfeR: number | null;
}

export interface RuleStat {
  rule: SignalRule;
  side: SignalSide;
  // Decided: wins + losses
  n: number;
  wins: number;
  losses: number;
  ambiguous: number;
  expired: number;
  open: number;
  // Fired, but the stop the bounce demanded was wider than MAX_STOP_WIDTH_ATR
  untradable: number;
  rate: number | null;
  // Wilson 95% interval on the rate
  lo: number | null;
  hi: number | null;
  // (wins·RR − losses) / n, in R
  expectancyR: number | null;
  avgBars: number | null;
}

export interface TrendPoint {
  datetime: string;
  barsAgo: number;
  price: number;
}

// A line through the last two confirmed swings of one kind. Drawn from the
// first point and extended to the right edge; the slope is per bar of the
// series it was measured on.
export interface TrendLine {
  kind: "lows" | "highs";
  from: TrendPoint;
  to: TrendPoint;
  slopePerBar: number;
  // Where the extended line sits at the newest bar
  now: number;
}

export interface SignalRead {
  ok: boolean;
  reason: string | null;
  bars: number;
  atr: number | null;
  rr: number;
  horizon: number;
  signals: Signal[];
  stats: RuleStat[];
  // Signals on the last RECENT_BARS closed bars: the conditions in force now
  recent: Signal[];
  lines: TrendLine[];
}

const usable = (v: number | null | undefined): v is number =>
  typeof v === "number" && Number.isFinite(v) && v > 0;
// A LEVEL, as opposed to a scale. On the mirrored series every price is
// negative, so a level test that demanded `> 0` — as the first version of
// this file did, by reusing `usable` — silently switched the moving-average
// rules off for the whole SELL side. The reflection test could not see it:
// the bug reflects exactly like everything else. The backtest could (no
// SELL row for ma20_pullback on any timeframe), and there is now a test
// that asks for one on real prices.
const isLevel = (v: number | null | undefined): v is number =>
  typeof v === "number" && Number.isFinite(v);

// ---- causal series --------------------------------------------------------
// Each value at index i is computed from bars 0..i and nothing after. That is
// the whole discipline of this file, so these are written here rather than
// borrowed from the whole-series helpers, and the test suite checks each one
// against the whole-series helper at every index.

// Wilder ATR at every bar: the same seed and smoothing as indicators.atr, so
// atrSeries(c)[n-1] === atr(c).
export const atrSeries = (candles: Candle[], period = ATR_PERIOD): Array<number | null> => {
  const out: Array<number | null> = candles.map(() => null);
  if (candles.length < period + 1) return out;
  const tr = (i: number) => {
    const c = candles[i];
    const pc = candles[i - 1].close;
    return Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc));
  };
  let avg = 0;
  for (let i = 1; i <= period; i++) avg += tr(i);
  avg /= period;
  out[period] = avg;
  for (let i = period + 1; i < candles.length; i++) {
    avg = (avg * (period - 1) + tr(i)) / period;
    out[i] = avg;
  }
  return out;
};

export const smaSeries = (values: number[], period: number): Array<number | null> => {
  const out: Array<number | null> = values.map(() => null);
  if (values.length < period) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
};

// The lower Bollinger band at every bar (20, 2). The upper band is the mirror
// image, which is how the SELL side gets it.
export const lowerBandSeries = (closes: number[], period = 20): Array<number | null> =>
  closes.map((_, i) => (i < period - 1 ? null : bollinger(closes.slice(i - period + 1, i + 1), period)?.lower ?? null));

// The cloud standing at bar i: the spans computed ICHIMOKU_SHIFT bars earlier.
// Same numbers as indicators.cloudAt(candles, i), without copying the prefix
// of the series for every bar — on a year of 15-minute bars that copy is the
// difference between a backtest that runs and one that does not.
export const cloudSeries = (candles: Candle[]): Array<{ top: number; bottom: number } | null> =>
  candles.map((_, i) => {
    const from = i - ICHIMOKU_SHIFT;
    if (from < 51) return null;
    const ich = ichimoku(candles.slice(from - 51, from + 1));
    if (!ich) return null;
    return { top: Math.max(ich.spanA, ich.spanB), bottom: Math.min(ich.spanA, ich.spanB) };
  });

// ---- the mirror -----------------------------------------------------------
// Negating every price turns a low into a high and a support bounce into a
// resistance rejection. Wilder's true range, the pivot test, RSI's
// complement, the Bollinger bands and the cloud all survive the reflection
// exactly (the test suite says so), so one set of BUY rules covers both sides.
export const mirror = (c: Candle): Candle => ({
  datetime: c.datetime,
  open: -c.open,
  high: -c.low,
  low: -c.high,
  close: -c.close,
});

// ---- statistics -----------------------------------------------------------
export const wilson = (wins: number, n: number, z = 1.96): { lo: number; hi: number } | null => {
  if (n <= 0) return null;
  const p = wins / n;
  const d = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { lo: Math.max(0, (centre - margin) / d), hi: Math.min(1, (centre + margin) / d) };
};

// ---- detection (BUY side, on a series that may be mirrored) ---------------

interface Fired {
  index: number;
  rule: SignalRule;
  level: number;
  // The extreme the bounce rejected; the stop goes just past it
  extreme: number;
}

const detectBuySide = (candles: Candle[], atrS: Array<number | null>): Fired[] => {
  const n = candles.length;
  const closes = candles.map((c) => c.close);
  const rsiS = rsiSeries(closes, RSI_PERIOD);
  const sma20 = smaSeries(closes, 20);
  const sma200 = smaSeries(closes, 200);
  const lowerBand = lowerBandSeries(closes);
  const cloud = cloudSeries(candles);
  const all = pivots(candles);
  const lows = all.filter((p) => p.kind === "low");
  const highs = all.filter((p) => p.kind === "high");
  // Position in `lows` of the low that is confirmed at a given bar
  const confirmedAt = new Map<number, number>(lows.map((p, k) => [p.index + PIVOT_BARS, k]));
  // Whether a confirmed low has since been closed through. Advanced one bar
  // at a time below, so at bar i it reflects closes up to i-1 only.
  const brokenAt = new Map<number, number>();
  let nextLow = 0;
  // Confirmed lows that entered the active set, oldest first
  const active: Pivot[] = [];
  const lastFired: Partial<Record<SignalRule, number>> = {};
  const fired: Fired[] = [];

  for (let i = 1; i < n; i++) {
    const a = atrS[i];
    // A low is confirmed at index p + PIVOT_BARS; it is a level from the bar
    // after that.
    while (nextLow < lows.length && lows[nextLow].index + PIVOT_BARS < i) active.push(lows[nextLow++]);
    // ... and it stops being one once it is further back than the reader can see
    while (active.length > 0 && i - active[0].index > LEVEL_LOOKBACK_BARS) active.shift();
    if (!usable(a)) continue;

    const c = candles[i];
    const prev = candles[i - 1];
    const range = c.high - c.low;
    const lowerWick = range > 0 ? (Math.min(c.open, c.close) - c.low) / range : 0;
    const rejected = range > 0 && lowerWick >= WICK_MIN;
    const touch = (level: number) =>
      c.low <= level + TOUCH_TOL_ATR * a &&
      c.low >= level - PIERCE_MAX_ATR * a &&
      prev.close > level &&
      c.close > level;
    // Standing levels the reader can see: confirmed before this bar, inside
    // the lookback, never closed through.
    const standing = active.filter((p) => !brokenAt.has(p.index));
    const nearestStanding = (): Pivot | null => {
      let best: Pivot | null = null;
      for (const p of standing) if (touch(p.price) && (best === null || p.price > best.price)) best = p;
      return best;
    };
    const fire = (rule: SignalRule, level: number, extreme: number) => {
      const last = lastFired[rule];
      if (last !== undefined && i - last < COOLDOWN_BARS) return;
      lastFired[rule] = i;
      fired.push({ index: i, rule, level, extreme });
    };

    // 1. A rejection wick at a confirmed swing low
    if (rejected) {
      const p = nearestStanding();
      if (p !== null) fire("level_reject", p.price, c.low);
    }
    // 2. ... at the 200-bar average
    const m200 = sma200[i];
    if (rejected && isLevel(m200) && touch(m200)) fire("ma200_reject", m200, c.low);
    // 3. ... at a rising 20-bar average (the pullback in a trend)
    const m20 = sma20[i];
    const m20Then = i >= MA_RISE_BARS ? sma20[i - MA_RISE_BARS] : null;
    if (rejected && isLevel(m20) && isLevel(m20Then) && m20 > m20Then && touch(m20)) fire("ma20_pullback", m20, c.low);
    // 4. ... at the top of the cloud, without having fallen through it
    const cl = cloud[i];
    if (
      rejected && cl !== null &&
      c.low <= cl.top + TOUCH_TOL_ATR * a && c.low >= cl.bottom &&
      prev.close > cl.top && c.close > cl.top
    ) fire("cloud_reject", cl.top, c.low);
    // 5. A close back inside the band after a close outside it
    const lbPrev = lowerBand[i - 1];
    const lb = lowerBand[i];
    if (lbPrev !== null && lb !== null && prev.close < lbPrev && c.close > lb) {
      fire("band_reentry", lb, Math.min(prev.low, c.low));
    }
    // 6/7. Things that are decided when a low is CONFIRMED, i.e. two bars
    // after it printed. That is the bar they fire on: not the low itself,
    // which nobody could have known was one.
    const k = confirmedAt.get(i) ?? -1;
    if (k >= 1) {
      const to = lows[k];
      const from = lows[k - 1];
      const gap = to.index - from.index;
      if (gap >= MIN_GAP_BARS && gap <= MAX_GAP_BARS && c.close > to.price) {
        // Bullish divergence: a lower closing low with a higher RSI. Same
        // thresholds as divergence.ts, which the test suite pins.
        const rFrom = rsiS[from.index];
        const rTo = rsiS[to.index];
        if (
          from.index - RSI_PERIOD >= RSI_WARMUP_BARS &&
          rFrom !== null && rTo !== null &&
          to.close - from.close < -PRICE_TOL_ATR * a &&
          rTo - rFrom > RSI_TOL
        ) fire("divergence", to.price, to.price);
        // Double bottom: two lows at the same level with a real swing between
        const between = highs.filter((h) => h.index > from.index && h.index < to.index);
        const peak = between.length > 0 ? Math.max(...between.map((h) => h.price)) : null;
        if (
          Math.abs(to.price - from.price) <= FLAT_TOL_ATR * a &&
          peak !== null && peak - Math.max(to.price, from.price) >= MIN_BOUNCE_ATR * a
        ) fire("double_pivot", Math.min(to.price, from.price), Math.min(to.price, from.price));
      }
    }
    // 8. A bullish engulfing bar at a level
    const engulfs =
      prev.close < prev.open && c.close > c.open &&
      c.open <= prev.close && c.close >= prev.open &&
      c.close - c.open >= ENGULF_BODY_ATR * a;
    if (engulfs) {
      const p = nearestStanding();
      const level = p !== null
        ? p.price
        : isLevel(m200) && touch(m200)
          ? m200
          : cl !== null && c.low <= cl.top + TOUCH_TOL_ATR * a && c.low >= cl.bottom && prev.close > cl.top && c.close > cl.top
            ? cl.top
            : null;
      if (level !== null) fire("engulfing", level, c.low);
    }

    // Now this bar's close is history: a standing low it settled through is
    // broken from the next bar on.
    for (const p of standing) if (c.close < p.price - BREAK_TOL_ATR * a) brokenAt.set(p.index, i);
  }
  return fired;
};

// Price the signal as the app would, then walk the bars after it.
const settle = (
  candles: Candle[],
  atrS: Array<number | null>,
  f: Fired,
  side: SignalSide,
  horizon: number,
  sign: 1 | -1,
): Signal | null => {
  const n = candles.length;
  const a = atrS[f.index] as number;
  const c = candles[f.index];
  const entry = c.close;
  let stop = f.extreme - STOP_PAD_ATR * a;
  let dist = entry - stop;
  if (dist < MIN_STOP_ATR * a) {
    dist = MIN_STOP_ATR * a;
    stop = entry - dist;
  }
  if (dist > MAX_STOP_WIDTH_ATR * a + 1e-12) return null;
  const target = entry + RR * dist;

  let outcome: SignalOutcome = "open";
  let bars: number | null = null;
  let mfe = 0;
  const last = Math.min(n - 1, f.index + horizon);
  for (let j = f.index + 1; j <= last; j++) {
    const b = candles[j];
    mfe = Math.max(mfe, b.high - entry);
    const tp = b.high >= target;
    const sl = b.low <= stop;
    if (tp || sl) {
      outcome = tp && sl ? "ambiguous" : tp ? "win" : "loss";
      bars = j - f.index;
      break;
    }
  }
  if (outcome === "open" && f.index + horizon <= n - 1) outcome = "expired";

  return {
    index: f.index,
    barsAgo: n - 1 - f.index,
    datetime: c.datetime,
    side,
    rule: f.rule,
    level: sign * f.level,
    entry: sign * entry,
    stop: sign * stop,
    target: sign * target,
    stopAtr: Number((dist / a).toFixed(2)),
    outcome,
    bars,
    mfeR: Number((mfe / dist).toFixed(2)),
  };
};

const statsOf = (signals: Signal[], untradable: Record<string, number>): RuleStat[] => {
  const out: RuleStat[] = [];
  for (const side of ["BUY", "SELL"] as SignalSide[]) {
    for (const rule of SIGNAL_RULES) {
      const list = signals.filter((s) => s.side === side && s.rule === rule);
      const wins = list.filter((s) => s.outcome === "win").length;
      const losses = list.filter((s) => s.outcome === "loss").length;
      const n = wins + losses;
      const decided = list.filter((s) => s.outcome === "win" || s.outcome === "loss");
      const ci = wilson(wins, n);
      const skipped = untradable[`${side}:${rule}`] ?? 0;
      if (list.length === 0 && skipped === 0) continue;
      out.push({
        rule,
        side,
        n,
        wins,
        losses,
        ambiguous: list.filter((s) => s.outcome === "ambiguous").length,
        expired: list.filter((s) => s.outcome === "expired").length,
        open: list.filter((s) => s.outcome === "open").length,
        untradable: skipped,
        rate: n > 0 ? wins / n : null,
        lo: ci?.lo ?? null,
        hi: ci?.hi ?? null,
        expectancyR: n > 0 ? (wins * RR - losses) / n : null,
        avgBars: n > 0 ? decided.reduce((s, x) => s + (x.bars ?? 0), 0) / n : null,
      });
    }
  }
  return out;
};

const trendLines = (candles: Candle[]): TrendLine[] => {
  const n = candles.length;
  const all = pivots(candles);
  const out: TrendLine[] = [];
  for (const kind of ["lows", "highs"] as const) {
    const list = all.filter((p) => p.kind === (kind === "lows" ? "low" : "high"));
    if (list.length < 2) continue;
    const a = list[list.length - 2];
    const b = list[list.length - 1];
    const slope = (b.price - a.price) / (b.index - a.index);
    const point = (p: Pivot): TrendPoint => ({ datetime: p.datetime, barsAgo: p.barsAgo, price: p.price });
    out.push({ kind, from: point(a), to: point(b), slopePerBar: slope, now: b.price + slope * (n - 1 - b.index) });
  }
  return out;
};

/**
 * Every bounce condition that fired on the series, priced, settled and
 * counted. `candles` must be CLOSED bars, oldest first — a forming bar's
 * close is not a close, and a wick that has not finished printing has not
 * rejected anything.
 */
export const computeSignals = (candles: Candle[], horizon = SIGNAL_HORIZON_BARS): SignalRead => {
  const base: SignalRead = {
    ok: false,
    reason: null,
    bars: candles.length,
    atr: null,
    rr: RR,
    horizon,
    signals: [],
    stats: [],
    recent: [],
    lines: [],
  };
  if (candles.length < MIN_SIGNAL_BARS) return { ...base, reason: `too_few_bars:${candles.length}` };
  const atrS = atrSeries(candles);
  const atrNow = atrS[atrS.length - 1];
  if (!usable(atrNow)) return { ...base, reason: "no_atr" };

  const signals: Signal[] = [];
  const untradable: Record<string, number> = {};
  const sides: Array<{ side: SignalSide; series: Candle[]; sign: 1 | -1 }> = [
    { side: "BUY", series: candles, sign: 1 },
    { side: "SELL", series: candles.map(mirror), sign: -1 },
  ];
  for (const { side, series, sign } of sides) {
    // ATR is reflection-invariant; computed once and shared, which the test
    // suite also checks rather than assumes.
    const fired = detectBuySide(series, atrS);
    for (const f of fired) {
      const s = settle(series, atrS, f, side, horizon, sign);
      if (s === null) untradable[`${side}:${f.rule}`] = (untradable[`${side}:${f.rule}`] ?? 0) + 1;
      else signals.push(s);
    }
  }
  signals.sort((x, y) => x.index - y.index || x.side.localeCompare(y.side) || x.rule.localeCompare(y.rule));

  return {
    ...base,
    ok: true,
    atr: atrNow,
    signals,
    stats: statsOf(signals, untradable),
    recent: signals.filter((s) => s.barsAgo < RECENT_BARS),
    lines: trendLines(candles),
  };
};

// ---- rendering ------------------------------------------------------------

// The condition, named for the side it fired on. Prompt text, so Japanese;
// the client has its own dictionary (src/lib/i18n) for the same ids.
export const RULE_WORDS: Record<SignalRule, { BUY: string; SELL: string }> = {
  level_reject: { BUY: "確定安値での反発", SELL: "確定高値での反落" },
  ma200_reject: { BUY: "SMA200での反発", SELL: "SMA200での反落" },
  ma20_pullback: { BUY: "上向きSMA20への押し目", SELL: "下向きSMA20への戻り" },
  band_reentry: { BUY: "BB下限の外から復帰", SELL: "BB上限の外から復帰" },
  cloud_reject: { BUY: "雲の上限での反発", SELL: "雲の下限での反落" },
  divergence: { BUY: "強気ダイバージェンス確定", SELL: "弱気ダイバージェンス確定" },
  double_pivot: { BUY: "ダブルボトム確定", SELL: "ダブルトップ確定" },
  engulfing: { BUY: "水準での陽の包み足", SELL: "水準での陰の包み足" },
};

const pct = (v: number | null): string => (v === null ? "n/a" : `${Math.round(v * 100)}%`);

// The read, for the prompt. One block per timeframe; the model is told what
// was measured, how, and what it may not conclude from a small count.
export const signalLines = (s: SignalRead, decimals: number): string => {
  const p = (v: number) => v.toFixed(decimals);
  const head = `反発の実績(サーバ計算・確定足${s.bars}本・仲値・損切り=反発の極値の${STOP_PAD_ATR}ATR先(ATR×${MIN_STOP_ATR}〜${MAX_STOP_WIDTH_ATR}に収まるもののみ)・利確=損切り幅×${s.rr}・${s.horizon}本以内に判定)`;
  if (!s.ok) return `${head}: 判定保留 (${s.reason ?? "不明"})`;
  const counted = s.stats.filter((st) => st.n > 0 || st.ambiguous > 0 || st.expired > 0 || st.open > 0);
  const rows = counted.length === 0
    ? "  この窓で成立した条件なし"
    : counted
      .sort((x, y) => y.n - x.n || (y.rate ?? 0) - (x.rate ?? 0))
      .map((st) => {
        const ci = st.lo === null || st.hi === null ? "" : ` [95%CI ${pct(st.lo)}-${pct(st.hi)}]`;
        const extra = [
          st.ambiguous > 0 ? `判定不能${st.ambiguous}` : "",
          st.expired > 0 ? `期限切れ${st.expired}` : "",
          st.open > 0 ? `判定中${st.open}` : "",
          st.untradable > 0 ? `損切り幅超過で除外${st.untradable}` : "",
        ].filter((x) => x !== "").join("・");
        return `  ${RULE_WORDS[st.rule][st.side]}(${st.side}) ${st.wins}勝${st.losses}敗=${pct(st.rate)}${ci}${extra ? ` ${extra}` : ""}`;
      })
      .join("\n");
  const recent = s.recent.length === 0
    ? `直近${RECENT_BARS}本で成立した条件: なし`
    : `直近${RECENT_BARS}本で成立した条件: ${
      s.recent.map((r) =>
        `${r.side} ${RULE_WORDS[r.rule][r.side]} ${r.barsAgo}本前(水準${p(r.level)}・損切り${p(r.stop)}・利確${p(r.target)})`
      ).join(" / ")
    }`;
  const breakeven = Math.round((1 / (1 + s.rr)) * 100);
  const note = `※利確が損切りの${s.rr}倍なので損益分岐は的中率${breakeven}%。n<5 の条件、または95%CIの下限が${breakeven}%未満の条件を「反発しやすい」根拠にしない。数字は上の窓の中だけの数え上げで、窓の外の実績は不明。`;
  return `${head}:\n${rows}\n${recent}\n${note}`;
};

// ---- the long run ---------------------------------------------------------
// What the same detector counted over a long stretch of GMO's USD/JPY
// history, measured with supabase/functions/signal-backtest on 2026-09-25
// (docs/OPERATIONS.md §8.16). One window of a few hundred bars can say
// "6 of 9"; only this can say what 6 of 9 is worth. Rendered under the
// window's own counts so the analyst reads the two side by side.
//
// [decided, wins] per rule and side, at the same RR, stop and horizon as
// above. Only USD/JPY has been measured; the line says so for any other
// pair rather than borrowing these numbers.
//
// The numbers are a MEASUREMENT with a date on it, not a belief: the 4h and
// 1day rows cover 2024-01 to 2026-09, which was mostly a rising USD/JPY, and
// the BUY side's edge there is at least partly that. The 1min row is one
// month. Re-run the harness and replace the table rather than editing a cell.
export const LONG_RUN_PAIR = "USD/JPY";
export const LONG_RUN_MEASURED = "2026-09-25";
export const LONG_RUN: Record<string, { span: string; bars: number; rows: Partial<Record<SignalRule, { BUY: [number, number]; SELL: [number, number] }>> }> = {
  "1min": {
    span: "2026-08-24〜2026-09-25",
    bars: 33434,
    rows: {
      level_reject: { BUY: [1043, 434], SELL: [1025, 423] },
      ma200_reject: { BUY: [223, 79], SELL: [192, 96] },
      ma20_pullback: { BUY: [508, 202], SELL: [442, 178] },
      band_reentry: { BUY: [588, 249], SELL: [663, 273] },
      cloud_reject: { BUY: [340, 136], SELL: [290, 119] },
      divergence: { BUY: [19, 8], SELL: [26, 13] },
      double_pivot: { BUY: [123, 52], SELL: [134, 59] },
      engulfing: { BUY: [148, 51], SELL: [160, 71] },
    },
  },
  "15min": {
    span: "2025-09-23〜2026-09-25",
    bars: 24780,
    rows: {
      level_reject: { BUY: [1004, 411], SELL: [1138, 467] },
      ma200_reject: { BUY: [199, 92], SELL: [157, 62] },
      ma20_pullback: { BUY: [610, 240], SELL: [427, 167] },
      band_reentry: { BUY: [319, 135], SELL: [509, 201] },
      cloud_reject: { BUY: [349, 141], SELL: [240, 97] },
      divergence: { BUY: [14, 3], SELL: [28, 11] },
      double_pivot: { BUY: [123, 53], SELL: [162, 59] },
      engulfing: { BUY: [166, 59], SELL: [155, 55] },
    },
  },
  "1h": {
    span: "2025-09-23〜2026-09-25",
    bars: 6195,
    rows: {
      level_reject: { BUY: [247, 99], SELL: [308, 113] },
      ma200_reject: { BUY: [59, 23], SELL: [50, 13] },
      ma20_pullback: { BUY: [184, 75], SELL: [98, 28] },
      band_reentry: { BUY: [75, 29], SELL: [144, 51] },
      cloud_reject: { BUY: [89, 28], SELL: [60, 19] },
      divergence: { BUY: [1, 0], SELL: [12, 6] },
      double_pivot: { BUY: [17, 7], SELL: [52, 17] },
      engulfing: { BUY: [33, 14], SELL: [43, 13] },
    },
  },
  "4h": {
    span: "2024-01-01〜2026-09-25",
    bars: 4260,
    rows: {
      level_reject: { BUY: [146, 78], SELL: [177, 65] },
      ma200_reject: { BUY: [42, 21], SELL: [23, 8] },
      ma20_pullback: { BUY: [96, 45], SELL: [66, 25] },
      band_reentry: { BUY: [47, 9], SELL: [112, 52] },
      cloud_reject: { BUY: [58, 29], SELL: [41, 13] },
      divergence: { BUY: [3, 2], SELL: [4, 2] },
      double_pivot: { BUY: [8, 6], SELL: [25, 7] },
      engulfing: { BUY: [18, 8], SELL: [21, 10] },
    },
  },
  "1day": {
    span: "2024-01-01〜2026-09-25",
    bars: 709,
    rows: {
      level_reject: { BUY: [20, 11], SELL: [14, 4] },
      ma200_reject: { BUY: [3, 3], SELL: [4, 3] },
      ma20_pullback: { BUY: [16, 10], SELL: [5, 0] },
      band_reentry: { BUY: [8, 4], SELL: [15, 6] },
      cloud_reject: { BUY: [8, 6], SELL: [4, 1] },
      divergence: { BUY: [0, 0], SELL: [1, 0] },
      double_pivot: { BUY: [3, 3], SELL: [4, 1] },
      engulfing: { BUY: [2, 2], SELL: [5, 4] },
    },
  },
};

// Only rows with at least this many decided signals are printed: below it
// the interval is wider than the difference between good and useless.
export const LONG_RUN_MIN_N = 20;

// The long run, for the prompt. One line, or one sentence saying there is
// none for this pair or this rung.
export const longRunLines = (tf: string, pair: string): string => {
  const head = "長期実績(サーバ計測・同じ条件・同じ損切りと利確)";
  if (pair !== LONG_RUN_PAIR) return `${head}: ${pair} は未計測（${LONG_RUN_PAIR} のみ計測済み）。上の窓の数字だけで判断する。`;
  const run = LONG_RUN[tf];
  if (!run) return `${head}: ${tf} は未計測。上の窓の数字だけで判断する。`;
  const parts: string[] = [];
  for (const rule of SIGNAL_RULES) {
    const row = run.rows[rule];
    if (!row) continue;
    for (const side of ["BUY", "SELL"] as const) {
      const [n, wins] = row[side];
      if (n < LONG_RUN_MIN_N) continue;
      const ci = wilson(wins, n);
      parts.push(`${RULE_WORDS[rule][side]}(${side}) ${pct(wins / n)}[${pct(ci?.lo ?? null)}-${pct(ci?.hi ?? null)}] n=${n}`);
    }
  }
  const body = parts.length === 0 ? `n<${LONG_RUN_MIN_N} の条件しかない` : parts.join(" / ");
  return `${head}: ${LONG_RUN_PAIR} ${tf} ${run.span}（GMO仲値・確定足${run.bars.toLocaleString("en-US")}本・${LONG_RUN_MEASURED}計測）: ${body}
※上の窓の数字は長期実績と併せて読む。長期の95%CI下限が損益分岐（40%）に届かない条件は、窓の中で何勝していても「反発しやすい」根拠にしない。`;
};

// The read, in the shape it is stored on the plan: the counts and the
// conditions in force, never the whole list of signals (that is what the
// chart payload is for, and it is not stored).
const r = (v: number | null | undefined, d: number): number | null =>
  typeof v === "number" && Number.isFinite(v) ? Number(v.toFixed(d)) : null;

export const compactSignal = (s: Signal, decimals: number) => ({
  datetime: s.datetime,
  barsAgo: s.barsAgo,
  side: s.side,
  rule: s.rule,
  level: r(s.level, decimals),
  entry: r(s.entry, decimals),
  stop: r(s.stop, decimals),
  target: r(s.target, decimals),
  stop_atr: s.stopAtr,
  outcome: s.outcome,
  bars: s.bars,
  mfe_r: s.mfeR,
});

export const compactSignals = (tf: string, s: SignalRead, decimals: number) => {
  if (!s.ok) return { tf, ok: false, reason: s.reason, bars: s.bars };
  return {
    tf,
    ok: true,
    bars: s.bars,
    atr: r(s.atr, decimals),
    rr: s.rr,
    horizon: s.horizon,
    stats: s.stats.map((st) => ({
      rule: st.rule,
      side: st.side,
      n: st.n,
      wins: st.wins,
      losses: st.losses,
      ambiguous: st.ambiguous,
      expired: st.expired,
      open: st.open,
      untradable: st.untradable,
      rate: r(st.rate, 3),
      lo: r(st.lo, 3),
      hi: r(st.hi, 3),
      expectancy_r: r(st.expectancyR, 2),
      avg_bars: r(st.avgBars, 1),
    })),
    recent: s.recent.map((x) => compactSignal(x, decimals)),
    lines: s.lines.map((l) => ({
      kind: l.kind,
      from: { ...l.from, price: r(l.from.price, decimals) },
      to: { ...l.to, price: r(l.to.price, decimals) },
      slope_per_bar: r(l.slopePerBar, decimals + 2),
      now: r(l.now, decimals),
    })),
  };
};
