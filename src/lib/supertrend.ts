// #136: SuperTrend by KivancOzbilgic, a port of its open-source Pine code
// (TradingView, https://jp.tradingview.com/script/r6dAP7yi/, Pine v4), with
// its defaults: Source hl2, ATR Period 10, ATR Multiplier 3, the ATR by
// RMA (its "Change ATR Calculation Method" on).
//
//   up = hl2 − 3 × ATR, held at the last one's while the close before stayed
//        above that one (it only rises during an uptrend)
//   dn = hl2 + 3 × ATR, held likewise from above (it only falls)
//   the trend turns up when a close goes over the last dn, and down when a
//   close goes under the last up
//
// Drawn as the original draws it: the up line green while the trend is up,
// the dn line red while it is down, a dot and a "Buy" ("Sell") label on the
// line where it turns, and the space between the line and ohlc4 tinted.
// Shown on the chart only: no signal, alert or record is judged on it.

import { pineAtr } from "../../supabase/functions/_shared/pine";

// #155: moved to supabase/functions/_shared/pine.ts, shared with the functions
export { pineAtr };

export interface SupertrendParams {
  period: number;
  multiplier: number;
}

export const ST_DEFAULTS: SupertrendParams = { period: 10, multiplier: 3 };

type Bar = { high: number; low: number; close: number; open?: number };

export interface SupertrendRead {
  // the line: `up` while the trend is up, `dn` while it is down
  line: Array<number | null>;
  trend: Array<1 | -1 | null>;
  // bars where the trend turned (closed bars only)
  signals: Array<{ i: number; side: "BUY" | "SELL"; price: number }>;
}


// `lastClosed`: the index of the newest closed bar — a turn on a bar still
// forming is not marked, and the line is not drawn there (it can still
// move before the bar closes)
export const supertrend = (
  bars: ReadonlyArray<Bar>,
  params: SupertrendParams = ST_DEFAULTS,
  lastClosed: number = bars.length - 1,
): SupertrendRead => {
  const n = bars.length;
  const atr = pineAtr(bars, Math.max(1, Math.round(params.period)));
  const ups: Array<number | null> = [];
  const dns: Array<number | null> = [];
  const trends: Array<1 | -1> = [];
  for (let i = 0; i < n; i++) {
    const b = bars[i];
    const src = (b.high + b.low) / 2;
    const a = atr[i];
    let up = a === null ? null : src - params.multiplier * a;
    let dn = a === null ? null : src + params.multiplier * a;
    // nz(up[1], up): the last one, or this one when there is none
    const up1 = i > 0 && ups[i - 1] !== null ? ups[i - 1] : up;
    const dn1 = i > 0 && dns[i - 1] !== null ? dns[i - 1] : dn;
    if (i > 0 && up !== null && up1 !== null && bars[i - 1].close > up1) up = Math.max(up, up1);
    if (i > 0 && dn !== null && dn1 !== null && bars[i - 1].close < dn1) dn = Math.min(dn, dn1);
    ups.push(up);
    dns.push(dn);
    const was = i > 0 ? trends[i - 1] : 1;
    trends.push(was === -1 && dn1 !== null && b.close > dn1 ? 1 : was === 1 && up1 !== null && b.close < up1 ? -1 : was);
  }
  const line: Array<number | null> = [];
  const trend: Array<1 | -1 | null> = [];
  const signals: SupertrendRead["signals"] = [];
  for (let i = 0; i < n; i++) {
    const t = trends[i];
    const v = t === 1 ? ups[i] : dns[i];
    const shown = i <= lastClosed && v !== null;
    line.push(shown ? v : null);
    trend.push(shown ? t : null);
    if (shown && i > 0 && t !== trends[i - 1]) signals.push({ i, side: t === 1 ? "BUY" : "SELL", price: v as number });
  }
  return { line, trend, signals };
};
