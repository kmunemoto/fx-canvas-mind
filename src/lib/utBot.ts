// #137: UT Bot Alerts by QuantNomad, a port of its open-source Pine code
// (TradingView, https://jp.tradingview.com/script/n8ss8BID-UT-Bot-Alerts/,
// Pine v4; UT Bot first written by Yo_adriiiiaan from an idea of HPotter),
// with its defaults: Key Value 1, ATR Period 10, signals from the chart's
// own candles (its Heikin Ashi option off, and not ported).
//
//   stop = a trailing stop Key Value × ATR(10) from the close: while the
//          close stays above it (this bar and the one before) it only rises,
//          max(stop, close − loss); while below it only falls,
//          min(stop, close + loss); when the close crosses it, it starts
//          again on the other side
//   Buy  = the close crosses over the stop; Sell = under it
//   each candle green while its close is above the stop, red while below
//
// As the original, the stop itself is not drawn: only the Buy/Sell labels
// (under the candle / over it) and the candles' colours. Judged on closed
// bars only. Shown on the chart only: no signal, alert or record is judged
// on it.

import { pineAtr } from "./supertrend";

export interface UtBotParams {
  keyValue: number;
  atrPeriod: number;
}

export const UT_DEFAULTS: UtBotParams = { keyValue: 1, atrPeriod: 10 };

type Bar = { high: number; low: number; close: number };

export interface UtBotRead {
  stop: Array<number | null>;
  // 1: the close above the stop (green), −1: below (red), null: neither or
  // not judged (the bar still forming)
  side: Array<1 | -1 | null>;
  signals: Array<{ i: number; side: "BUY" | "SELL" }>;
}

// `lastClosed`: the index of the newest closed bar
export const utBot = (
  bars: ReadonlyArray<Bar>,
  params: UtBotParams = UT_DEFAULTS,
  lastClosed: number = bars.length - 1,
): UtBotRead => {
  const atr = pineAtr(bars, Math.max(1, Math.round(params.atrPeriod)));
  const stop: Array<number | null> = [];
  for (let i = 0; i < bars.length; i++) {
    const src = bars[i].close;
    const loss = atr[i] === null ? null : params.keyValue * (atr[i] as number);
    const prev = i > 0 ? stop[i - 1] : null;
    // nz(stop[1], 0); a comparison with the bar before the first is false
    const s1 = prev ?? 0;
    const before = i > 0 ? bars[i - 1].close : null;
    let v: number | null;
    if (loss === null) v = null;
    else if (before !== null && src > s1 && before > s1) v = Math.max(s1, src - loss);
    else if (before !== null && src < s1 && before < s1) v = Math.min(s1, src + loss);
    else v = src > s1 ? src - loss : src + loss;
    stop.push(v);
  }
  const side: UtBotRead["side"] = [];
  const signals: UtBotRead["signals"] = [];
  for (let i = 0; i < bars.length; i++) {
    const s = stop[i];
    const c = bars[i].close;
    const judged = i <= lastClosed && s !== null;
    side.push(!judged ? null : c > (s as number) ? 1 : c < (s as number) ? -1 : null);
    if (!judged || i === 0) continue;
    const p = stop[i - 1];
    if (p === null) continue;
    const cp = bars[i - 1].close;
    // crossover(ema(close, 1), stop) — an EMA of one bar is the close
    if (c > (s as number) && cp <= p) signals.push({ i, side: "BUY" });
    // crossover(stop, ema(close, 1))
    else if ((s as number) > c && p <= cp) signals.push({ i, side: "SELL" });
  }
  return { stop, side, signals };
};
