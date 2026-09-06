// Divergence, decided in code or not claimed at all.
//
// The system prompt tells the analyst to always mention divergence when the
// oscillators and the price structure disagree. The prompt then hands it ONE
// RSI, ONE stochastic pair and ONE MACD triple, all at the newest bar — so
// the comparison the instruction demands is not expressible in the data the
// instruction is attached to.
//
// The first twenty-one analyses contain sixteen divergence sentences and not
// one of them names an earlier bar with its reading. Four compare two
// different oscillators at the same instant; three assert that an indicator
// changed, which needs a second reading that was never sent; one applies the
// word to a candle wick with no indicator at all, and inverts the sign.
// Fourteen of the sixteen hedge ("〜的", "〜気味", "初期形成の可能性") —
// the model complying with "always mention" while having nothing to compute.
//
// So it is computed here, and the prompt's instruction changes from "always
// mention" to "cite this verdict and nothing else".
//
// WHY CLOSES, NOT EXTREMES: RSI is computed from closes. A pivot is found by
// its high or low. Pairing a bar's extreme with a close-derived indicator is
// how a single spike — high of the session, close back at the bottom — reads
// as a textbook divergence. Both sides of the comparison are the pivot bar's
// CLOSE, and the rendered line says so.
//
// Deno-free on purpose: src/test/divergence.test.ts imports this directly.

import type { Candle } from "./indicators.ts";
import { type Pivot } from "./structure.ts";

// The two closes must differ by this much of an ATR to be a higher high or a
// lower low at all. Below it, the two points are the same price and there is
// nothing for the indicator to diverge from.
export const PRICE_TOL_ATR = 0.25;
// And the two RSI readings must differ by this many points. Wilder RSI moves
// a point or two on noise alone.
export const RSI_TOL = 3;
// Pivots closer than this are one swing seen twice; further apart than this
// and they are not the same move.
export const MIN_GAP_BARS = 5;
export const MAX_GAP_BARS = 60;
// Wilder's seed is a simple average that decays by (period-1)/period per bar.
// At the first non-null index the RSI still carries most of that seed, so a
// comparison there is against an artefact of where the data happened to
// start. Twenty bars of smoothing leaves under a quarter of it.
export const RSI_WARMUP_BARS = 20;
// The period rsiSeries is computed with; the warm-up is counted after it.
export const RSI_PERIOD = 14;

export type DivergenceStatus = "bearish" | "bullish" | "none" | "unavailable";

export interface Divergence {
  status: DivergenceStatus;
  // Why, in every case — including why not
  reason: string;
  from: { datetime: string; barsAgo: number; close: number; rsi: number } | null;
  to: { datetime: string; barsAgo: number; close: number; rsi: number } | null;
  priceDelta: number | null;
  rsiDelta: number | null;
}

const none = (reason: string): Divergence => ({
  status: "none",
  reason,
  from: null,
  to: null,
  priceDelta: null,
  rsiDelta: null,
});

const unavailable = (reason: string): Divergence => ({
  status: "unavailable",
  reason,
  from: null,
  to: null,
  priceDelta: null,
  rsiDelta: null,
});

const read = (p: Pivot, series: Array<number | null>): number | null => {
  const v = series[p.index];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
};

/**
 * Regular divergence between price and RSI over the last two confirmed
 * pivots of one kind.
 *
 * `candles` must be CLOSED bars, `rsiValues` aligned index-for-index with
 * them, and `pivotList` the output of pivots() over the same series.
 *
 * Hidden divergence is not computed, and the prompt says so — an uncomputed
 * variant that the model is free to claim is worse than no variant at all.
 */
export const detectDivergence = (
  candles: Candle[],
  rsiValues: Array<number | null>,
  pivotList: Pivot[],
  atrValue: number | null,
): Divergence => {
  if (typeof atrValue !== "number" || !Number.isFinite(atrValue) || atrValue <= 0) {
    return unavailable("no_atr");
  }
  if (rsiValues.length !== candles.length) return unavailable("rsi_misaligned");

  const test = (kind: "high" | "low"): Divergence | null => {
    const list = pivotList.filter((p) => p.kind === kind);
    if (list.length < 2) return null;
    const to = list[list.length - 1];
    const from = list[list.length - 2];
    const gap = to.index - from.index;
    if (gap < MIN_GAP_BARS) return none(`${kind}:pivots_too_close:${gap}`);
    if (gap > MAX_GAP_BARS) return none(`${kind}:pivots_too_far:${gap}`);
    // Measured from the first bar RSI exists at, not from the start of the
    // series. As an absolute index it admitted pivots with most of the Wilder
    // seed still in them: with bars 15-59 held identical and only the seed
    // changed, the same two pivots flipped between "bearish" and "none".
    if (from.index - RSI_PERIOD < RSI_WARMUP_BARS) return unavailable(`${kind}:rsi_warmup`);
    const rFrom = read(from, rsiValues);
    const rTo = read(to, rsiValues);
    if (rFrom === null || rTo === null) return unavailable(`${kind}:rsi_missing`);

    const priceDelta = to.close - from.close;
    const rsiDelta = rTo - rFrom;
    const priceTol = PRICE_TOL_ATR * atrValue;
    const pair = {
      from: { datetime: from.datetime, barsAgo: from.barsAgo, close: from.close, rsi: rFrom },
      to: { datetime: to.datetime, barsAgo: to.barsAgo, close: to.close, rsi: rTo },
      priceDelta,
      rsiDelta,
    };
    if (Math.abs(priceDelta) <= priceTol) {
      return { ...none(`${kind}:price_flat`), ...pair };
    }
    if (Math.abs(rsiDelta) <= RSI_TOL) {
      return { ...none(`${kind}:rsi_flat`), ...pair };
    }
    // Bearish: a higher closing high with a lower RSI.
    if (kind === "high" && priceDelta > 0 && rsiDelta < 0) {
      return { status: "bearish", reason: "higher_close_lower_rsi", ...pair };
    }
    // Bullish: a lower closing low with a higher RSI.
    if (kind === "low" && priceDelta < 0 && rsiDelta > 0) {
      return { status: "bullish", reason: "lower_close_higher_rsi", ...pair };
    }
    return { ...none(`${kind}:agree`), ...pair };
  };

  const bear = test("high");
  const bull = test("low");
  const hit = [bear, bull].filter((d): d is Divergence => d !== null && (d.status === "bearish" || d.status === "bullish"));
  if (hit.length === 2) {
    // Both fired: report the one whose newer pivot is more recent. Reporting
    // both would be reporting a contradiction as two facts.
    return (hit[0].to?.barsAgo ?? 0) <= (hit[1].to?.barsAgo ?? 0) ? hit[0] : hit[1];
  }
  if (hit.length === 1) return hit[0];
  // Neither fired. Prefer a real "no" over an "insufficient data": "there is
  // no divergence here" is a stronger and more useful statement than "could
  // not tell", and `bear ?? bull` returned whichever side existed rather than
  // whichever was informative — so a warm-up refusal on one side hid a clean
  // "none" on the other, and that weaker string is what got archived.
  const settled = [bear, bull].filter((d): d is Divergence => d !== null && d.status === "none");
  if (settled.length > 0) return settled[0];
  return bear ?? bull ?? unavailable("few_pivots");
};

// The divergence, in the shape it is stored on the plan.
//
// `reason` is kept on every path including "none": the record should say why
// there was no divergence, not merely that there was none, or a later reader
// cannot tell "looked and found nothing" from "could not look".
export const compactDivergence = (d: Divergence | null, decimals: number) => {
  if (d === null) return null;
  const round = (v: number | null, places: number): number | null =>
    typeof v === "number" && Number.isFinite(v) ? Number(v.toFixed(places)) : null;
  const side = (s: Divergence["from"]) =>
    s === null ? null : {
      datetime: s.datetime,
      barsAgo: s.barsAgo,
      close: round(s.close, decimals),
      rsi: round(s.rsi, 1),
    };
  return {
    status: d.status,
    reason: d.reason,
    from: side(d.from),
    to: side(d.to),
    price_delta: round(d.priceDelta, decimals),
    rsi_delta: round(d.rsiDelta, 1),
  };
};
