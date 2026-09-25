// The analysis, from #104 on: RSI(14) and the Parabolic SAR, and nothing
// else.
//
// The owner's instruction (2026-09-25): 「これからのチャート分析はRSI と
// パラボリックSARで分析してください。他はいりません。」 — after #102 found RSI
// the best single timing rule of seventeen and #103 found the Parabolic SAR
// the only partner whose contribution to it was positive in both periods of
// the study (research/rsi-pairs.ts).
//
// THE RULE, exactly as the study tested it (research/rsi-combos.ts, base
// "bounce" with partner "psar"; src/test/rsisar.test.ts pins the two to the
// same bars):
//
//   BUY  when RSI(14) closes back above 30 (the bar before it was 30 or
//        below) and the SAR is under price after that bar;
//   SELL when RSI(14) closes back below 70 (the bar before it was 70 or
//        above) and the SAR is over price after that bar.
//
// Read on CLOSED bars only. A plan is published when the rule fired on the
// newest closed bar; at any other time the answer is WAIT, and the reader is
// shown what the next close would have to do for the rule to fire (triggers
// below).
//
// The plan the rule makes is the app's standing geometry (entry.ts): stop 0.8
// ATR from the entry, target 1.5 times the stop. That is the "app" measure of
// the study, and the win rates in RSI_SAR_EVIDENCE are measured with it.
//
// Deno-free on purpose: the tests import it directly.

import type { Candle } from "./indicators.ts";
import { atrSeriesOf, barOpenMs } from "./state.ts";
import { costlyHourAt } from "./timing.ts";

export const RSI_PERIOD = 14;
export const BUY_LEVEL = 30;
export const SELL_LEVEL = 70;
export const SAR_STEP = 0.02;
export const SAR_MAX = 0.2;
// The plan: the same numbers entry.ts's floors are written around
export const STOP_ATR = 0.8;
export const REWARD_RATIO = 1.5;
// Bars a past signal is given to reach its stop or target before it is
// counted as expired — the study's horizon
export const HORIZON_BARS = 48;
// Fewer closed bars than this and neither line has settled from its seed
export const MIN_BARS = 60;
// The version of the rule a row was decided by, stored on it
export const RULE_ID = "rsi14_30_70_psar_v1";

export type Side = "BUY" | "SELL";
export type Outcome = "win" | "loss" | "ambiguous" | "expired" | "open";

// ---- the two lines ----------------------------------------------------------

// Wilder's RSI, with the two running averages it is made of. The values are
// indicators.rsiSeries's exactly (the test pins it); the averages are what
// make it possible to say which close would move RSI to a given level.
export const wilderRsi = (
  closes: number[],
  period = RSI_PERIOD,
): { rsi: Array<number | null>; gain: Array<number | null>; loss: Array<number | null> } => {
  const rsi: Array<number | null> = closes.map(() => null);
  const gain: Array<number | null> = closes.map(() => null);
  const loss: Array<number | null> = closes.map(() => null);
  if (closes.length < period + 1) return { rsi, gain, loss };
  let g = 0;
  let l = 0;
  for (let i = 1; i <= period; i++) {
    const ch = closes[i] - closes[i - 1];
    if (ch >= 0) g += ch;
    else l -= ch;
  }
  g /= period;
  l /= period;
  const value = (a: number, b: number): number | null => (b === 0 ? (a === 0 ? null : 100) : 100 - 100 / (1 + a / b));
  gain[period] = g;
  loss[period] = l;
  rsi[period] = value(g, l);
  for (let i = period + 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    g = (g * (period - 1) + Math.max(ch, 0)) / period;
    l = (l * (period - 1) + Math.max(-ch, 0)) / period;
    gain[i] = g;
    loss[i] = l;
    rsi[i] = value(g, l);
  }
  return { rsi, gain, loss };
};

// The close that would put RSI exactly at `target` on the NEXT bar, given the
// averages after the last one. RSI rises with the close, so a close above
// this puts RSI above the target and a close below it puts RSI below.
export const closeForRsi = (
  lastClose: number,
  gain: number,
  loss: number,
  target: number,
  period = RSI_PERIOD,
): number | null => {
  if (!(target > 0 && target < 100) || !Number.isFinite(gain) || !Number.isFinite(loss)) return null;
  const rs = target / (100 - target);
  const now = loss === 0 ? (gain === 0 ? null : 100) : 100 - 100 / (1 + gain / loss);
  if (now === null) return null;
  const k = period - 1;
  if (target > now) return lastClose + k * (loss * rs - gain);
  if (target < now) return lastClose - k * (gain / rs - loss);
  return lastClose;
};

// Wilder's Parabolic SAR, the arithmetic research/indicator-series.ts
// psarSeries tested (the test pins the two together). `long[i]` is the side
// the SAR puts price on after bar i closes; `ep`/`af` are its state then.
export const parabolicSar = (
  candles: Candle[],
  step = SAR_STEP,
  max = SAR_MAX,
): { sar: Array<number | null>; long: Array<boolean | null>; ep: Array<number | null>; af: Array<number | null> } => {
  const n = candles.length;
  const sar: Array<number | null> = candles.map(() => null);
  const long: Array<boolean | null> = candles.map(() => null);
  const epS: Array<number | null> = candles.map(() => null);
  const afS: Array<number | null> = candles.map(() => null);
  if (n < 3) return { sar, long, ep: epS, af: afS };
  let up = candles[1].close > candles[0].close;
  let s = up ? candles[0].low : candles[0].high;
  let ep = up ? candles[1].high : candles[1].low;
  let af = step;
  sar[1] = s;
  long[1] = up;
  epS[1] = ep;
  afS[1] = af;
  for (let i = 2; i < n; i++) {
    const c = candles[i];
    let next = s + af * (ep - s);
    if (up) {
      next = Math.min(next, candles[i - 1].low, candles[i - 2].low);
      if (c.low < next) {
        up = false;
        next = ep;
        ep = c.low;
        af = step;
      } else if (c.high > ep) {
        ep = c.high;
        af = Math.min(af + step, max);
      }
    } else {
      next = Math.max(next, candles[i - 1].high, candles[i - 2].high);
      if (c.high > next) {
        up = true;
        next = ep;
        ep = c.high;
        af = step;
      } else if (c.low < ep) {
        ep = c.low;
        af = Math.min(af + step, max);
      }
    }
    s = next;
    sar[i] = s;
    long[i] = up;
    epS[i] = ep;
    afS[i] = af;
  }
  return { sar, long, ep: epS, af: afS };
};

// The SAR the NEXT bar will be measured against, and the side it stands on
// before that bar can flip it. While the SAR is under price the next bar
// flips it by trading below this level; while it is over price, by trading
// above it.
export const nextSar = (
  candles: Candle[],
  s: ReturnType<typeof parabolicSar>,
): { level: number; long: boolean } | null => {
  const i = candles.length - 1;
  if (i < 2) return null;
  const sar = s.sar[i];
  const long = s.long[i];
  const ep = s.ep[i];
  const af = s.af[i];
  if (sar === null || long === null || ep === null || af === null) return null;
  const raw = sar + af * (ep - sar);
  const level = long
    ? Math.min(raw, candles[i].low, candles[i - 1].low)
    : Math.max(raw, candles[i].high, candles[i - 1].high);
  return { level, long };
};

// ---- the rule ------------------------------------------------------------------

export const ruleAt = (rsi: Array<number | null>, long: Array<boolean | null>, i: number): Side | null => {
  if (i < 1) return null;
  const a = rsi[i - 1];
  const b = rsi[i];
  if (a === null || b === null) return null;
  if (a <= BUY_LEVEL && b > BUY_LEVEL && long[i] === true) return "BUY";
  if (a >= SELL_LEVEL && b < SELL_LEVEL && long[i] === false) return "SELL";
  return null;
};

export const planFor = (side: Side, entry: number, atr: number) => {
  const d = STOP_ATR * atr;
  const dir = side === "BUY" ? 1 : -1;
  return { entry, stop: entry - dir * d, target: entry + dir * d * REWARD_RATIO };
};

export interface RsiSarSignal {
  index: number;
  datetime: string;
  side: Side;
  rsi: number;
  rsiPrev: number;
  sar: number;
  atr: number;
  entry: number;
  stop: number;
  target: number;
  outcome: Outcome;
  // bars from the signal to the bar that settled it
  bars: number | null;
}

// Walk the bars after a signal on the mid candles in hand. A bar that
// reached both the stop and the target is "ambiguous": which came first is
// not in the candle, and it is never guessed.
const settle = (candles: Candle[], i: number, side: Side, stop: number, target: number): { outcome: Outcome; bars: number | null } => {
  const last = Math.min(candles.length - 1, i + HORIZON_BARS);
  for (let j = i + 1; j <= last; j++) {
    const c = candles[j];
    const tp = side === "BUY" ? c.high >= target : c.low <= target;
    const sl = side === "BUY" ? c.low <= stop : c.high >= stop;
    if (tp && sl) return { outcome: "ambiguous", bars: j - i };
    if (tp) return { outcome: "win", bars: j - i };
    if (sl) return { outcome: "loss", bars: j - i };
  }
  return { outcome: i + HORIZON_BARS <= candles.length - 1 ? "expired" : "open", bars: null };
};

// ---- what the next close would have to do ---------------------------------------

export interface Trigger {
  side: Side;
  // RSI is already past the level (30 or below for a buy, 70 or above for a
  // sell): the next close can complete the signal
  ready: boolean;
  // The close that puts RSI exactly on the level next bar. Ready: a close
  // beyond it (above for a buy) takes RSI back across. Not ready: a close at
  // or beyond it the other way (at or below for a buy) takes RSI past the
  // level, which is the first half of the signal.
  rsiClose: number | null;
  // Whether the SAR already stands on this signal's side (under price for a
  // buy). If it does, the next bar must not trade through `sarLevel`; if it
  // does not, the next bar must trade through it.
  sarOnSide: boolean | null;
  sarLevel: number | null;
  // Ready only: the close that completes the signal next bar — both halves at
  // once. Above it for a buy, below it for a sell.
  completeClose: number | null;
  // Ready only: the plan the rule would publish at that close
  plan: { entry: number; stop: number; target: number } | null;
}

const triggerFor = (
  side: Side,
  close: number,
  rsi: number,
  gain: number,
  loss: number,
  sar: { level: number; long: boolean } | null,
  atr: number,
): Trigger => {
  const level = side === "BUY" ? BUY_LEVEL : SELL_LEVEL;
  const ready = side === "BUY" ? rsi <= level : rsi >= level;
  const rsiClose = closeForRsi(close, gain, loss, level);
  const sarOnSide = sar === null ? null : side === "BUY" ? sar.long : !sar.long;
  const sarLevel = sar === null ? null : sar.level;
  let completeClose: number | null = null;
  if (ready && rsiClose !== null) {
    if (sarOnSide === true || sarLevel === null) completeClose = rsiClose;
    // A close beyond the SAR means the bar traded beyond it, which is what
    // flips it: so beyond both is enough for both halves.
    else completeClose = side === "BUY" ? Math.max(rsiClose, sarLevel) : Math.min(rsiClose, sarLevel);
  }
  return {
    side,
    ready,
    rsiClose,
    sarOnSide,
    sarLevel,
    completeClose,
    plan: completeClose === null || !(atr > 0) ? null : planFor(side, completeClose, atr),
  };
};

// ---- the read ---------------------------------------------------------------------

export interface RsiSarRead {
  ok: boolean;
  reason: string | null;
  bars: number;
  // aligned with the candles it was read from
  rsi: Array<number | null>;
  sar: Array<number | null>;
  long: Array<boolean | null>;
  signals: RsiSarSignal[];
  now: {
    datetime: string;
    close: number;
    rsi: number;
    rsiPrev: number | null;
    sar: number | null;
    long: boolean | null;
    atr: number;
    // the rule on the newest closed bar
    signal: Side | null;
  } | null;
  next: { sar: { level: number; long: boolean } | null; buy: Trigger; sell: Trigger } | null;
}

const failed = (bars: Candle[], reason: string): RsiSarRead => ({
  ok: false,
  reason,
  bars: bars.length,
  rsi: bars.map(() => null),
  sar: bars.map(() => null),
  long: bars.map(() => null),
  signals: [],
  now: null,
  next: null,
});

// `bars` must be CLOSED bars, oldest first.
export const readRsiSar = (bars: Candle[]): RsiSarRead => {
  if (bars.length < MIN_BARS) return failed(bars, `bars<${MIN_BARS}`);
  const closes = bars.map((c) => c.close);
  const { rsi, gain, loss } = wilderRsi(closes);
  const psar = parabolicSar(bars);
  const atr = atrSeriesOf(bars);
  const signals: RsiSarSignal[] = [];
  for (let i = 1; i < bars.length; i++) {
    const side = ruleAt(rsi, psar.long, i);
    const a = atr[i];
    if (side === null || a === null || !(a > 0)) continue;
    const plan = planFor(side, bars[i].close, a);
    const settled = settle(bars, i, side, plan.stop, plan.target);
    signals.push({
      index: i,
      datetime: bars[i].datetime,
      side,
      rsi: rsi[i] as number,
      rsiPrev: rsi[i - 1] as number,
      sar: psar.sar[i] as number,
      atr: a,
      entry: plan.entry,
      stop: plan.stop,
      target: plan.target,
      outcome: settled.outcome,
      bars: settled.bars,
    });
  }
  const i = bars.length - 1;
  const r = rsi[i];
  const g = gain[i];
  const l = loss[i];
  const a = atr[i];
  if (r === null || g === null || l === null || a === null || !(a > 0)) {
    return { ...failed(bars, "no_reading"), rsi, sar: psar.sar, long: psar.long, signals };
  }
  const sarNext = nextSar(bars, psar);
  return {
    ok: true,
    reason: null,
    bars: bars.length,
    rsi,
    sar: psar.sar,
    long: psar.long,
    signals,
    now: {
      datetime: bars[i].datetime,
      close: bars[i].close,
      rsi: r,
      rsiPrev: rsi[i - 1],
      sar: psar.sar[i],
      long: psar.long[i],
      atr: a,
      signal: ruleAt(rsi, psar.long, i),
    },
    next: {
      sar: sarNext,
      buy: triggerFor("BUY", bars[i].close, r, g, l, sarNext, a),
      sell: triggerFor("SELL", bars[i].close, r, g, l, sarNext, a),
    },
  };
};

// ---- what was measured --------------------------------------------------------------

// The study behind the rule (#103, research/rsi-pairs.ts): GMO 15-minute
// bid/ask, eleven pairs, 2024-01 to 2026-09, the rule chosen on the first
// period and these numbers read on the SECOND (2025-07 onwards), spread paid,
// 17:00-23:59 UTC left out on 15min and 1h.
//
//   win  — the plan above (stop 0.8 ATR, target 1.5x): break-even 40%
//   hit  — price went 1 ATR the signal's way before 1 ATR against: 50%
//   blind — entering at every bar instead, same pair, side, timeframe, hour
//
// Constants, not a live count: they are the evidence the rule was adopted
// on, and they do not move until the study is rerun.
export interface RsiSarEvidence {
  measured: boolean;
  win: number | null;
  winN: number | null;
  hit: number | null;
  hitN: number | null;
}
export const RSI_SAR_EVIDENCE = {
  period: "2025-07〜2026-09",
  pairs: 11,
  breakeven: { win: 0.4, hit: 0.5 },
  blind: { win: 0.35, hit: 0.448 },
  all: { measured: true, win: 0.354, winN: 1239, hit: 0.46, hitN: 1243 } as RsiSarEvidence,
  byTf: {
    "1min": { measured: false, win: null, winN: null, hit: null, hitN: null },
    "15min": { measured: true, win: 0.35, winN: 885, hit: 0.462, hitN: 888 },
    "1h": { measured: true, win: 0.34, winN: 247, hit: 0.44, hitN: 248 },
    "4h": { measured: true, win: 0.421, winN: 107, hit: 0.495, hitN: 107 },
    "1day": { measured: false, win: null, winN: null, hit: null, hitN: null },
  } as Record<string, RsiSarEvidence>,
};

// ---- rendering --------------------------------------------------------------------

const f = (v: number | null | undefined, d: number) => (v === null || v === undefined || !Number.isFinite(v) ? "—" : v.toFixed(d));

// The lines the analyst reads for one timeframe. Everything in them is
// computed; the analyst is told to quote, not recount.
export const rsiSarLines = (read: RsiSarRead, decimals: number, entryRung: boolean): string => {
  if (!read.ok || !read.now) return `RSI・パラボリックSAR: 算出不能（確定足${read.bars}本、${read.reason ?? "—"}）`;
  const n = read.now;
  const sarSide = n.long === null ? "—" : n.long ? "価格の下（買い側）" : "価格の上（売り側）";
  const lines = [
    `RSI(14)（確定足）: ${f(n.rsiPrev, 1)} → ${f(n.rsi, 1)}`,
    `パラボリックSAR(0.02, 0.2)（確定足）: ${f(n.sar, decimals)}・${sarSide}`,
    `ATR(14): ${f(n.atr, decimals)}`,
    `最新の確定足（${n.datetime} UTC）でのサイン: ${n.signal ?? "なし"}`,
  ];
  const last = read.signals[read.signals.length - 1];
  if (last) {
    const barsAgo = read.bars - 1 - last.index;
    lines.push(`直近のサイン: ${last.side}（${barsAgo}本前・${last.datetime} UTC・エントリー ${f(last.entry, decimals)}・結果 ${last.outcome}）`);
  } else {
    lines.push(`直近のサイン: この${read.bars}本の中にはなし`);
  }
  const tally = (side: Side) => {
    const s = read.signals.filter((x) => x.side === side);
    return `${side} ${s.length}回（勝ち${s.filter((x) => x.outcome === "win").length}・負け${s.filter((x) => x.outcome === "loss").length}）`;
  };
  lines.push(`この${read.bars}本で出たサイン: ${tally("BUY")} / ${tally("SELL")}（損切りATR×${STOP_ATR}・利確はその${REWARD_RATIO}倍・仲値で判定）`);
  if (entryRung && read.next) {
    const t = (tr: Trigger) => {
      const name = tr.side === "BUY" ? "買い" : "売り";
      const lvl = tr.side === "BUY" ? BUY_LEVEL : SELL_LEVEL;
      if (tr.ready) {
        return `${name}: RSIは${lvl}${tr.side === "BUY" ? "以下" : "以上"}。次の足の終値が ${f(tr.completeClose, decimals)} ${tr.side === "BUY" ? "を上回れば" : "を下回れば"}条件がそろう（RSIが${lvl}を戻す終値 ${f(tr.rsiClose, decimals)}、SAR ${f(tr.sarLevel, decimals)}${tr.sarOnSide ? "は既に同じ側" : "を抜ける必要あり"}）。`;
      }
      return `${name}: まだ準備前。まず終値が ${f(tr.rsiClose, decimals)} ${tr.side === "BUY" ? "以下" : "以上"}になってRSIが${lvl}${tr.side === "BUY" ? "を割る" : "を超える"}必要がある。その後にRSIが${lvl}を戻し、そのときSARが${tr.side === "BUY" ? "価格の下" : "価格の上"}にあればサイン（今のSAR ${f(tr.sarLevel, decimals)}）。`;
    };
    lines.push(`次の足で条件がそろう価格（サーバ計算）: ${t(read.next.buy)} / ${t(read.next.sell)}`);
  }
  return lines.join("\n");
};

const round = (v: number | null | undefined, d: number): number | null => (v === null || v === undefined || !Number.isFinite(v) ? null : Number(v.toFixed(d)));

const compactTrigger = (tr: Trigger, d: number) => ({
  side: tr.side,
  ready: tr.ready,
  rsi_close: round(tr.rsiClose, d),
  sar_on_side: tr.sarOnSide,
  sar_level: round(tr.sarLevel, d),
  complete_close: round(tr.completeClose, d),
  plan: tr.plan === null ? null : { entry: round(tr.plan.entry, d), stop: round(tr.plan.stop, d), target: round(tr.plan.target, d) },
});

const TF_MS: Record<string, number> = {
  "1min": 60_000,
  "15min": 15 * 60_000,
  "1h": 60 * 60_000,
  "4h": 4 * 60 * 60_000,
  "1day": 24 * 60 * 60_000,
};

// When the next bar — the one the triggers are about — closes, and whether
// that close falls in the hours the app refuses to publish in (timing.ts).
// A trigger that can only complete inside them is a trigger the reader would
// wait for and the app would then decline, so it is said up front.
export const nextCloseOf = (tf: string, read: RsiSarRead): { at: string; costly: boolean } | null => {
  const step = TF_MS[tf];
  if (!read.now || step === undefined) return null;
  const open = barOpenMs(read.now.datetime);
  if (!Number.isFinite(open)) return null;
  // the newest closed bar opened at `open`; the next one closes two steps on
  const closeMs = open + 2 * step;
  return { at: new Date(closeMs).toISOString(), costly: costlyHourAt(tf, closeMs) };
};

// What the client draws and the row keeps: the reading now, the next-close
// triggers and the evidence the rule was adopted on. The series and the
// signal list travel with the charts, not here.
export const compactRsiSar = (tf: string, read: RsiSarRead, decimals: number) => {
  const sideTally = (side: Side) => {
    const s = read.signals.filter((x) => x.side === side);
    const count = (o: Outcome) => s.filter((x) => x.outcome === o).length;
    return { n: s.length, wins: count("win"), losses: count("loss"), ambiguous: count("ambiguous"), expired: count("expired"), open: count("open") };
  };
  return {
    tf,
    rule: RULE_ID,
    ok: read.ok,
    reason: read.reason,
    bars: read.bars,
    stop_atr: STOP_ATR,
    reward_ratio: REWARD_RATIO,
    horizon: HORIZON_BARS,
    now: read.now === null ? null : {
      datetime: read.now.datetime,
      close: round(read.now.close, decimals),
      rsi: round(read.now.rsi, 1),
      rsi_prev: round(read.now.rsiPrev, 1),
      sar: round(read.now.sar, decimals),
      sar_below: read.now.long,
      atr: round(read.now.atr, decimals),
      signal: read.now.signal,
    },
    next: read.next === null ? null : {
      close: nextCloseOf(tf, read),
      sar: read.next.sar === null ? null : { level: round(read.next.sar.level, decimals), below: read.next.sar.long },
      buy: compactTrigger(read.next.buy, decimals),
      sell: compactTrigger(read.next.sell, decimals),
    },
    tally: { BUY: sideTally("BUY"), SELL: sideTally("SELL") },
    evidence: {
      period: RSI_SAR_EVIDENCE.period,
      pairs: RSI_SAR_EVIDENCE.pairs,
      breakeven: RSI_SAR_EVIDENCE.breakeven,
      blind: RSI_SAR_EVIDENCE.blind,
      tf: RSI_SAR_EVIDENCE.byTf[tf] ?? { measured: false, win: null, winN: null, hit: null, hitN: null },
      all: RSI_SAR_EVIDENCE.all,
    },
  };
};

// One chart's worth: the last `chartBars` closed bars, the two lines beside
// them and every signal that fired inside them, in the ChartSignalMark shape
// PriceChart already draws.
export const chartRsiSar = (read: RsiSarRead, chartBars: number, decimals: number) => {
  const from = Math.max(0, read.bars - chartBars);
  return {
    rsi: read.rsi.slice(from).map((v) => round(v, 1)),
    sar: read.sar.slice(from).map((v) => round(v, decimals)),
    sar_below: read.long.slice(from),
    marks: read.signals.filter((s) => s.index >= from).map((s) => ({
      datetime: s.datetime,
      barsAgo: read.bars - 1 - s.index,
      side: s.side,
      rule: "rsi_sar",
      level: round(s.sar, decimals),
      entry: round(s.entry, decimals),
      stop: round(s.stop, decimals),
      target: round(s.target, decimals),
      stop_atr: STOP_ATR,
      outcome: s.outcome,
      bars: s.bars,
      mfe_r: null,
    })),
  };
};
