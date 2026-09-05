// What the price actually did, computed rather than eyeballed.
//
// The model is asked for a structure verdict on every run and given nothing
// to build one from: the prompt carried four bare swing prices with no dates,
// no order, no touch count, and no distance — while the risk rules are
// written in ATR multiples. Sixteen of the first twenty-one analyses answered
// "Lower Highs & Lower Lows"; one shipped an empty string to satisfy a
// required field. That is not a market read, it is a forced guess.
//
// Everything here is computed from the OHLC series the app already fetches.
// Nothing is inferred about who was trading or why — this module has no
// opinion about intent, because the app has no order flow to form one from.
//
// TWO RULES THAT DECIDE EVERYTHING BELOW:
//
// 1. A tolerance is never a bare price. Every threshold is a multiple of
//    ATR14, so it means the same thing on a 1h chart and a 1day chart. When
//    ATR is missing the answer is a refusal, never a zero tolerance — in
//    JavaScript `0.1 * null` is 0, which would silently turn every test into
//    a tick-noise detector, the exact failure the tolerance exists to stop.
//
// 2. Only CLOSED bars. The whole point of "broken on a close" is that a wick
//    through a level is not a break; a forming bar's close is not a close, so
//    scanning it would assert breaks that unprint themselves minutes later.
//    Callers pass a series they have already trimmed (analyze does this for
//    its closed-bar snapshots already).
//
// Deno-free on purpose: src/test/structure.test.ts imports this directly.

import { rangeOf, type Candle, type Range } from "./indicators.ts";

// Confirmation window each side of a pivot. The same 2 bars the existing
// swingLevels uses, so the two never disagree about what a swing is.
export const PIVOT_BARS = 2;

// A close must clear a level by this much of an ATR to count as a break. Zero
// tolerance flips on the last decimal; a tenth of an average bar's range is
// the smallest move that is not noise at the scale the stops are set in.
export const BREAK_TOL_ATR = 0.10;

// Two highs (or two lows) within this much of an ATR are "the same level".
//
// Deliberately much wider than the break tolerance. Consecutive fractal
// pivots are typically one to five ATR apart, so a tolerance of a few
// hundredths of an ATR would mean the range verdict essentially never fires
// and every market reads as trending — which is exactly the bias the first
// twenty-one analyses showed.
export const FLAT_TOL_ATR = 0.25;

// Price must be at least this far from a level for it to be "the next level".
// Standing on a level is not having room to it.
export const NEAR_TOL_ATR = 0.25;

// Two levels closer than this are one level. Replaces a 0.05%-of-price rule,
// which is regime-blind: the same 0.05% is half an ATR on an hourly chart and
// a twentieth of one on a daily.
export const LEVEL_MERGE_ATR = 0.5;

export type PivotKind = "high" | "low";

export interface Pivot {
  index: number;
  barsAgo: number;
  datetime: string;
  // The extreme that made it a pivot
  price: number;
  // The close of the same bar. Divergence compares closes, because RSI is
  // computed from closes: a spike bar that prints the high and closes back at
  // its low would otherwise pair an extreme price with an unrelated RSI.
  close: number;
  kind: PivotKind;
}

export type BreakState = "held" | "broken" | "reclaimed";

export interface LevelBreak {
  level: number;
  kind: PivotKind;
  datetime: string;
  barsAgo: number;
  // The close that did it
  close: number;
  state: BreakState;
  // Bars whose wick cleared the level while the close did not. The honest,
  // computable core of what gets called a stop hunt.
  wickOnly: number;
}

export type StructureLabel =
  | "uptrend"
  | "downtrend"
  | "range"
  | "expanding"
  | "contracting"
  | "unknown";

export interface Structure {
  ok: boolean;
  // Why there is no answer, when there is no answer
  reason: string | null;
  bars: number;
  atr: number | null;
  label: StructureLabel;
  highs: Pivot[];
  lows: Pivot[];
  lastBreak: { up: LevelBreak | null; down: LevelBreak | null };
  // The nearest level above and below that price has not settled through
  nextUp: { level: number; pips: number; atr: number } | null;
  nextDown: { level: number; pips: number; atr: number } | null;
  range20: Range | null;
  range100: Range | null;
  // Mean of (close - low) / (high - low) over the last 20 bars. A proxy for
  // where trading settled inside its own bars, and labelled as a proxy
  // wherever it is shown — it is not a measure of who was buying.
  closePressure: number | null;
}

const usable = (v: number | null | undefined): v is number =>
  typeof v === "number" && Number.isFinite(v) && v > 0;

// Every confirmed pivot in the series, oldest first. No dedupe and no cap:
// callers that want distinct levels merge them by ATR (mergeLevels), and
// callers that want the sequence want all of it.
export const pivots = (candles: Candle[]): Pivot[] => {
  const out: Pivot[] = [];
  const n = candles.length;
  for (let i = PIVOT_BARS; i < n - PIVOT_BARS; i++) {
    const c = candles[i];
    const isHigh =
      c.high >= candles[i - 1].high && c.high >= candles[i - 2].high &&
      c.high > candles[i + 1].high && c.high > candles[i + 2].high;
    const isLow =
      c.low <= candles[i - 1].low && c.low <= candles[i - 2].low &&
      c.low < candles[i + 1].low && c.low < candles[i + 2].low;
    const base = { index: i, barsAgo: n - 1 - i, datetime: c.datetime, close: c.close };
    if (isHigh) out.push({ ...base, price: c.high, kind: "high" });
    if (isLow) out.push({ ...base, price: c.low, kind: "low" });
  }
  return out;
};

// Distinct levels, newest first: a pivot within LEVEL_MERGE_ATR of one
// already kept is the same level being retested, not another one.
export const mergeLevels = (list: Pivot[], atrValue: number, max: number): Pivot[] => {
  const kept: Pivot[] = [];
  for (let i = list.length - 1; i >= 0 && kept.length < max; i--) {
    const p = list[i];
    if (kept.every((k) => Math.abs(k.price - p.price) > LEVEL_MERGE_ATR * atrValue)) kept.push(p);
  }
  return kept;
};

// Did a CLOSE settle through this level, and did it stay through?
//
// The scan starts PIVOT_BARS + 1 bars after the pivot: the two bars that
// confirmed it cannot also break it.
const breakOf = (candles: Candle[], p: Pivot, atrValue: number): LevelBreak | null => {
  const tol = BREAK_TOL_ATR * atrValue;
  const beyond = (v: number) => (p.kind === "high" ? v > p.price + tol : v < p.price - tol);
  const back = (v: number) => (p.kind === "high" ? v < p.price - tol : v > p.price + tol);
  let wickOnly = 0;
  for (let i = p.index + PIVOT_BARS + 1; i < candles.length; i++) {
    const c = candles[i];
    const pierced = p.kind === "high" ? c.high > p.price + tol : c.low < p.price - tol;
    if (beyond(c.close)) {
      // Reclaimed: price settled back on the original side within three bars.
      // A level broken and then taken back is not a level that gave way — it
      // is one that held, and it is still resistance (or support).
      let state: BreakState = "broken";
      for (let j = i + 1; j <= Math.min(i + 3, candles.length - 1); j++) {
        if (back(candles[j].close)) { state = "reclaimed"; break; }
      }
      return {
        level: p.price,
        kind: p.kind,
        datetime: c.datetime,
        barsAgo: candles.length - 1 - i,
        close: c.close,
        state,
        wickOnly,
      };
    }
    if (pierced) wickOnly++;
  }
  return wickOnly > 0
    ? { level: p.price, kind: p.kind, datetime: p.datetime, barsAgo: p.barsAgo, close: p.close, state: "held", wickOnly }
    : null;
};

const labelOf = (highs: Pivot[], lows: Pivot[], atrValue: number): StructureLabel => {
  if (highs.length < 2 || lows.length < 2) return "unknown";
  const tol = FLAT_TOL_ATR * atrValue;
  // highs/lows arrive newest first
  const hd = highs[0].price - highs[1].price;
  const ld = lows[0].price - lows[1].price;
  const hUp = hd > tol, hDown = hd < -tol;
  const lUp = ld > tol, lDown = ld < -tol;
  if (hUp && lUp) return "uptrend";
  if (hDown && lDown) return "downtrend";
  if (hUp && lDown) return "expanding";
  if (hDown && lUp) return "contracting";
  return "range";
};

const pressure = (candles: Candle[], period = 20): number | null => {
  const start = Math.max(0, candles.length - period);
  let sum = 0;
  let n = 0;
  for (let i = start; i < candles.length; i++) {
    const c = candles[i];
    const span = c.high - c.low;
    if (span <= 0) continue;
    sum += (c.close - c.low) / span;
    n++;
  }
  return n > 0 ? sum / n : null;
};

/**
 * The structure of the series, as numbers.
 *
 * `candles` must contain CLOSED bars only — a forming bar's close is not a
 * close, and every break here is decided on a close.
 *
 * `atrValue` is ATR14 over the same series. Without it there is no scale to
 * measure a tolerance in, and the honest answer is a refusal.
 */
export const computeStructure = (
  candles: Candle[],
  atrValue: number | null,
  pipSize: number,
  maxLevels = 3,
): Structure => {
  const base: Structure = {
    ok: false,
    reason: null,
    bars: candles.length,
    atr: usable(atrValue) ? atrValue : null,
    label: "unknown",
    highs: [],
    lows: [],
    lastBreak: { up: null, down: null },
    nextUp: null,
    nextDown: null,
    range20: null,
    range100: null,
    closePressure: null,
  };
  if (!usable(atrValue)) return { ...base, reason: "no_atr" };
  // Enough bars for an ATR seed plus a window with pivots in it. Below this
  // the "structure" would be two pivots in a handful of bars, which is a
  // shape, not a structure.
  if (candles.length < 40) return { ...base, reason: `too_few_bars:${candles.length}` };
  if (!usable(pipSize)) return { ...base, reason: "no_pip_size" };

  const all = pivots(candles);
  const rawHighs = all.filter((p) => p.kind === "high");
  const rawLows = all.filter((p) => p.kind === "low");
  // Two different questions, two different lists.
  //
  // The LABEL is about the sequence: was the last high above the one before
  // it? That reads the pivots as they came. Merging first would fold two
  // near-equal highs into one level and leave nothing to compare — which is
  // precisely the case the label exists to name (a range).
  //
  // The LEVELS are about distinct prices to trade against, so there the
  // near-equal pair is one level being retested, not two.
  const highs = mergeLevels(rawHighs, atrValue, maxLevels);
  const lows = mergeLevels(rawLows, atrValue, maxLevels);

  const breaks = (kind: PivotKind) => {
    const list = (kind === "high" ? highs : lows)
      .map((p) => breakOf(candles, p, atrValue))
      .filter((b): b is LevelBreak => b !== null && b.state !== "held");
    // The most recent settled break of that side
    return list.sort((a, b) => a.barsAgo - b.barsAgo)[0] ?? null;
  };

  const close = candles[candles.length - 1].close;
  const nearTol = NEAR_TOL_ATR * atrValue;
  // A level counts as "next" when price has not settled through it and is not
  // already sitting on it. A level that was broken and reclaimed still counts:
  // price came back to this side of it, so it is in the way again.
  const standing = (p: Pivot) => {
    const b = breakOf(candles, p, atrValue);
    return b === null || b.state !== "broken";
  };
  const above = highs.filter((p) => p.price > close + nearTol && standing(p))
    .sort((a, b) => a.price - b.price)[0] ?? null;
  const below = lows.filter((p) => p.price < close - nearTol && standing(p))
    .sort((a, b) => b.price - a.price)[0] ?? null;
  const gap = (p: Pivot | null) =>
    p === null ? null : {
      level: p.price,
      pips: Math.abs(p.price - close) / pipSize,
      atr: Math.abs(p.price - close) / atrValue,
    };

  return {
    ...base,
    ok: true,
    label: labelOf(rawHighs.slice(-2).reverse(), rawLows.slice(-2).reverse(), atrValue),
    highs,
    lows,
    lastBreak: { up: breaks("high"), down: breaks("low") },
    nextUp: gap(above),
    nextDown: gap(below),
    range20: rangeOf(candles, 20),
    range100: rangeOf(candles, Math.min(100, candles.length)),
    closePressure: pressure(candles),
  };
};
