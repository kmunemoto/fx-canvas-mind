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
import type { Divergence } from "./divergence.ts";

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
  // The last two swings on each side, compared. NOT a verdict about the
  // window: it is a two-pivot read that can sit a handful of bars apart, and
  // on a decisively trending series it disagrees with the direction of the
  // window it sits in roughly one time in eight. Rendered with the bars it
  // compared for exactly that reason.
  label: StructureLabel;
  labelFrom: { highs: [Pivot, Pivot] | null; lows: [Pivot, Pivot] | null };
  // What the window itself did, which is a different question from what the
  // last two swings did. Net change over the whole series, in ATR.
  netAtr: number | null;
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
      // Reclaimed if price settled back on the original side — within three
      // bars, OR at any point since, including where it sits now. The
      // three-bar window alone reported "抜けたまま" (still broken) about a
      // level price had been forty bars and two hundred pips back below.
      let state: BreakState = "broken";
      for (let j = i + 1; j < candles.length; j++) {
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

// The range's extremes come from the closed bars; where price sits inside
// them is asked about the price the plan is filled at.
const positionAt = (r: Range | null, price: number): Range | null =>
  r === null ? null : { ...r, positionPct: r.width > 0 ? ((price - r.low) / r.width) * 100 : null };

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
/**
 * ...
 *
 * `referencePrice` is the price the plan will actually be filled at — the
 * same constant the gate, the entry and the prompt's 現在値 all read. The
 * distances below are measured from IT, not from the last closed bar's
 * close. On the entry timeframe the newest bar is essentially always
 * forming, so those two differ by however far price has moved since the bar
 * opened; measuring the room ahead from a stale close, and printing it beside
 * a live 現在値, put every 上値余地/下値余地 and the range position out by
 * that amount — into the one rule that is denominated in ATR.
 */
export const computeStructure = (
  candles: Candle[],
  atrValue: number | null,
  pipSize: number,
  referencePrice: number | null = null,
  maxLevels = 3,
): Structure => {
  const base: Structure = {
    ok: false,
    reason: null,
    bars: candles.length,
    atr: usable(atrValue) ? atrValue : null,
    label: "unknown",
    labelFrom: { highs: null, lows: null },
    netAtr: null,
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
      .filter((b): b is LevelBreak => b !== null);
    const settled = list.filter((b) => b.state !== "held");
    // The most recent settled break of that side; failing that, the level
    // that was pierced most often and never closed through. That second case
    // is the only computable evidence behind a "stop hunt" — the prompt now
    // asks for it by name, so throwing it away left the model with nothing to
    // cite but its imagination.
    if (settled.length > 0) return settled.sort((a, b) => a.barsAgo - b.barsAgo)[0];
    return list.sort((a, b) => b.wickOnly - a.wickOnly)[0] ?? null;
  };

  const close = usable(referencePrice) ? referencePrice : candles[candles.length - 1].close;
  const nearTol = NEAR_TOL_ATR * atrValue;
  // A level counts as "next" when price has not settled through it and is not
  // already sitting on it. A level that was broken and reclaimed still counts:
  // price came back to this side of it, so it is in the way again.
  const standing = (p: Pivot) => {
    const b = breakOf(candles, p, atrValue);
    return b === null || b.state !== "broken";
  };
  // Searched over EVERY confirmed pivot, not the three merged levels picked
  // for display. Searching the display list reported the nearest of three
  // rather than the nearest that exists, which overstated the room — on one
  // measured series it printed 21.6 ATR of clear air below with four
  // standing lows in between — and printed "no level in the window" while a
  // level sat 61 pips overhead inside that same window.
  const above = rawHighs.filter((p) => p.price > close + nearTol && standing(p))
    .sort((a, b) => a.price - b.price)[0] ?? null;
  const below = rawLows.filter((p) => p.price < close - nearTol && standing(p))
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
    labelFrom: {
      highs: rawHighs.length >= 2 ? [rawHighs[rawHighs.length - 2], rawHighs[rawHighs.length - 1]] : null,
      lows: rawLows.length >= 2 ? [rawLows[rawLows.length - 2], rawLows[rawLows.length - 1]] : null,
    },
    netAtr: (candles[candles.length - 1].close - candles[0].close) / atrValue,
    highs,
    lows,
    lastBreak: { up: breaks("high"), down: breaks("low") },
    nextUp: gap(above),
    nextDown: gap(below),
    range20: positionAt(rangeOf(candles, 20), close),
    range100: positionAt(rangeOf(candles, Math.min(100, candles.length)), close),
    closePressure: pressure(candles),
  };
};

// The structure, rendered.
//
// Full detail on the ENTRY timeframe only. The higher timeframes get one
// line each: the schema asks them for a bias and a note, not for a break
// history, and three full blocks would spend two thirds of the added budget
// on the two timeframes the plan is not built at.
export const structureLines = (st: Structure, dv: Divergence | null, decimals: number, full: boolean): string => {
  const p = (v: number | null | undefined) =>
    typeof v === "number" && Number.isFinite(v) ? v.toFixed(decimals) : "n/a";
  const label = ({
    uptrend: "上昇(高値切り上げ・安値切り上げ)",
    downtrend: "下降(高値切り下げ・安値切り下げ)",
    range: "レンジ(高安がほぼ同値)",
    expanding: "拡大(高値切り上げ・安値切り下げ)",
    contracting: "収縮(高値切り下げ・安値切り上げ)",
    unknown: "判定不能",
  })[st.label];

  if (!st.ok) return `構造(サーバ計算): 判定保留 (${st.reason ?? "不明"}・足${st.bars}本)`;

  const gap = (g: { level: number; pips: number; atr: number } | null, dir: string) =>
    g === null
      ? `${dir}: 参照期間内に未突破の水準なし`
      : `${dir}: ${p(g.level)} (${g.pips.toFixed(1)}pips / ${g.atr.toFixed(2)}ATR)`;

  // The head names the two swings it compared, and calls itself what it is.
  //
  // It used to read "構造(サーバ計算・確定足250本): 上昇" — a two-pivot read,
  // sometimes a handful of bars apart, dressed as the verdict for the whole
  // window, with the prompt telling the analyst to adopt it. On a series that
  // fell 200 pips it said 上昇 about one time in eight. Worse, the label was
  // computed from the raw pivots while the list printed below it is merged,
  // so the head could assert 高値切り下げ above three ascending highs.
  const pair = (two: [Pivot, Pivot] | null, kind: string) =>
    two === null ? `${kind}: 2点なし` : `${kind} ${p(two[0].price)}(${two[0].barsAgo}本前)→${p(two[1].price)}(${two[1].barsAgo}本前)`;
  const head = `直近2スイングの並び(サーバ計算): ${label} [${pair(st.labelFrom.highs, "高値")} / ${pair(st.labelFrom.lows, "安値")}]`;
  // What the window did, which the two swings above do not answer.
  const window = st.netAtr === null
    ? ""
    : ` / 参照${st.bars}本の正味変化 ${st.netAtr > 0 ? "+" : ""}${st.netAtr.toFixed(1)}ATR`;
  const room = `${gap(st.nextUp, "上値余地")} ${gap(st.nextDown, "下値余地")}`;
  if (!full) return `${head}${window}\n${room}`;

  const piv = (list: typeof st.highs, kind: string) =>
    list.length === 0
      ? `${kind}: なし`
      : `${kind}: ${list.map((h) => `${p(h.price)}(${h.datetime.slice(5, 16)}Z・${h.barsAgo}本前)`).join(" ← ")}`;

  const brk = (b: typeof st.lastBreak.up, dir: string) => {
    if (b === null) return `${dir}: 終値で抜けた水準なし`;
    if (b.state === "held") {
      // Pierced intrabar, never closed through. The honest, computable core
      // of what usually gets called a stop hunt.
      return `${dir}: ${p(b.level)}(${b.datetime.slice(5, 16)}Z・${b.barsAgo}本前) は終値では抜けていない・ヒゲのみの突破${b.wickOnly}回`;
    }
    const state = b.state === "reclaimed" ? "その後の終値で戻された(=水準は生きている)" : "抜けたまま";
    return `${dir}: ${p(b.level)} を ${b.datetime.slice(5, 16)}Z(${b.barsAgo}本前) の終値${p(b.close)}で突破・${state}${
      b.wickOnly > 0 ? `・それ以前にヒゲのみの突破${b.wickOnly}回` : ""
    }`;
  };

  const rng = (r: typeof st.range20, n: number) =>
    r === null
      ? `直近${n}本レンジ: 算出不能`
      : `直近${n}本レンジ: 高${p(r.high)} 安${p(r.low)} 幅${p(r.width)}${
        r.positionPct === null ? "" : ` / 現在値は下から${r.positionPct.toFixed(0)}%`
      }`;

  const div = (() => {
    if (dv === null) return "";
    if (dv.status === "unavailable") return `\nダイバージェンス(RSI14・サーバ判定): 判定不可(${dv.reason})`;
    if (dv.status === "none") return `\nダイバージェンス(RSI14・サーバ判定): なし(${dv.reason})`;
    const f = dv.from!, t = dv.to!;
    return `\nダイバージェンス(RSI14・サーバ判定): ${dv.status === "bearish" ? "弱気" : "強気"}。` +
      `${f.datetime.slice(5, 16)}Z 終値${p(f.close)} RSI${f.rsi.toFixed(1)} → ${t.datetime.slice(5, 16)}Z 終値${p(t.close)} RSI${t.rsi.toFixed(1)}` +
      ` (価格${dv.priceDelta! > 0 ? "+" : ""}${p(dv.priceDelta)} / RSI${dv.rsiDelta! > 0 ? "+" : ""}${dv.rsiDelta!.toFixed(1)})`;
  })();

  return [
    head + window,
    room,
    piv(st.highs, "確定スイング高値(新しい順)"),
    piv(st.lows, "確定スイング安値(新しい順)"),
    brk(st.lastBreak.up, "終値ブレイク(上)"),
    brk(st.lastBreak.down, "終値ブレイク(下)"),
    rng(st.range20, 20),
    st.closePressure === null
      ? ""
      : `終値の位置(直近20本平均・OHLCからの計算値): ${(st.closePressure * 100).toFixed(0)}% (高値寄り100/安値寄り0)`,
    // Said once, because the alternative is the model reading the edge of the
    // window as a property of the market — which is what produced "空白地帯"
    // and "8月来のもみ合い" in the first twenty-one analyses.
    "※スイングは前後2本で確定するため、直近2本は構造判定に入らない。上記は参照期間内の事実で、期間外は不明。",
    div,
  ].filter((l) => l !== "").join("\n");
};
