// #176: Zero-lag TEMA Crosses [Loxx], a port of its open-source Pine code
// (TradingView, https://jp.tradingview.com/script/sjkyqVmc-Zero-lag-TEMA-Crosses-Loxx/,
// Pine v5, Mozilla Public License 2.0, © loxx), with its defaults: the
// close, Fast Period 22, Slow Period 144, bars coloured, signals shown.
//
//   zero-lag TEMA(x, n) = TEMA(TEMA(x, n), n), TEMA(x, n) = 3 × (e1 − e2) + e3
//                         (e1 = EMA(x, n), e2 = EMA(e1, n), e3 = EMA(e2, n))
//   fast = zero-lag TEMA(close, 22), slow = zero-lag TEMA(close, 144)
//   the fast line and the candles green while fast > slow, red otherwise;
//   the slow line white
//   L (long)  = the fast line crosses over the slow one (ta.crossover)
//   S (short) = the fast line crosses under it (ta.crossunder)
//
// One thing differs, and why: Pine's EMA starts from the simple average of
// its first n values, so six EMAs of 144 in a row give the slow line its
// first value 858 bars in, and it then needs some hundreds more before it
// stops depending on where the bars began. TradingView computes it over
// years of bars; the chart reads some 1,300 (live-chart's deep history,
// DEEP_HISTORY_BARS). Over those, an EMA started from its first value comes
// to TradingView's line sooner: on random walks (docs §8.87), with 1,200
// bars before the 120 drawn the L/S marks on them were TradingView's in all
// 120 walks (Pine's own start: 116), and the slow line within 0.4% of a
// bar's mean move. So the EMAs here start from the first value; past the
// bars that start needs, the two are the same line (the tests check it).
//
// Judged on closed bars only. Shown on the chart only: no signal, alert or
// record is judged on it.

export interface ZlTemaParams {
  fast: number;
  slow: number;
}

export const ZLT_DEFAULTS: ZlTemaParams = { fast: 22, slow: 144 };

// The bars before the first one drawn that the slow line needs to be
// TradingView's (docs §8.87); with fewer, the chart says so
export const ZLT_SETTLE_BARS = 1200;

// An EMA started from the first value: alpha = 2 / (n + 1) of each new one
export const emaFromFirst = (xs: ReadonlyArray<number>, n: number): number[] => {
  const alpha = 2 / (n + 1);
  const out: number[] = [];
  let prev = 0;
  for (let i = 0; i < xs.length; i++) {
    prev = i === 0 ? xs[0] : alpha * xs[i] + (1 - alpha) * prev;
    out.push(prev);
  }
  return out;
};

export const tema = (xs: ReadonlyArray<number>, n: number): number[] => {
  const e1 = emaFromFirst(xs, n);
  const e2 = emaFromFirst(e1, n);
  const e3 = emaFromFirst(e2, n);
  return e1.map((v, i) => 3 * (v - e2[i]) + e3[i]);
};

// The original's zlagtema(): TEMA, and TEMA again of that
export const zeroLagTema = (xs: ReadonlyArray<number>, n: number): number[] => tema(tema(xs, n), n);

export interface ZlTemaRead {
  fast: number[];
  slow: number[];
  // 1: fast above slow (green), −1: not (red); null on bars not judged
  // (still forming)
  side: Array<1 | -1 | null>;
  signals: Array<{ i: number; side: "BUY" | "SELL" }>;
}

// The colour of each bar (the original's `temafast > temaslow ? green :
// red`) and its L/S marks (ta.crossover / ta.crossunder of the two lines),
// on the bars up to `lastClosed` only
export const zltSidesAndSignals = (
  fast: ReadonlyArray<number>,
  slow: ReadonlyArray<number>,
  lastClosed: number,
): Pick<ZlTemaRead, "side" | "signals"> => {
  const side: ZlTemaRead["side"] = fast.map((f, i) => (i > lastClosed ? null : f > slow[i] ? 1 : -1));
  const signals: ZlTemaRead["signals"] = [];
  for (let i = 1; i <= Math.min(lastClosed, fast.length - 1); i++) {
    if (fast[i] > slow[i] && fast[i - 1] <= slow[i - 1]) signals.push({ i, side: "BUY" });
    else if (fast[i] < slow[i] && fast[i - 1] >= slow[i - 1]) signals.push({ i, side: "SELL" });
  }
  return { side, signals };
};

// `lastClosed`: the index of the newest closed bar
export const zlTemaCrosses = (
  closes: ReadonlyArray<number>,
  params: ZlTemaParams = ZLT_DEFAULTS,
  lastClosed: number = closes.length - 1,
): ZlTemaRead => {
  const fast = zeroLagTema(closes, Math.max(1, Math.round(params.fast)));
  const slow = zeroLagTema(closes, Math.max(1, Math.round(params.slow)));
  return { fast, slow, ...zltSidesAndSignals(fast, slow, lastClosed) };
};
