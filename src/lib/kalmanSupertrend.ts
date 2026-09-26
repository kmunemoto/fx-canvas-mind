// #119: a "SPECTRA-style" trend line, rebuilt from what SentioEdge publishes
// about its invite-only SPECTRA indicator (the code itself is not public):
//
//   raw HL2 + raw ATR → Kalman state estimation → smoothed price + smoothed
//   ATR → Supertrend bands → (Smart Trail) → RSI momentum filter →
//   (volume confidence)
//
// Rebuilt here: the Kalman filter on HL2 and on ATR, the Supertrend on
// those, and the RSI filter on its flips. Left out, and said so on the
// chart: the "Smart Trail" (its rule is not published) and the volume
// classification (GMO's FX bars carry no volume).
//
// A one-dimensional Kalman filter with fixed noise is, once it has settled,
// an exponential average: its gain K tends to a constant set by Q/R alone
// (here 0.01/0.1: K ≈ 0.27, about a 6-bar EMA). Its "adaptiveness" is only
// the first few bars.
//
// Shown on the chart only, off unless switched on: no signal, alert or
// record is judged on it. #120 measured it on past data (research/gainz.ts,
// docs §8.33): after the spread it lost as entering at random did, and the
// RSI filter almost never removed a turn (a 3-ATR break has RSI on its side).

export interface KalmanStParams {
  // the filter's process and measurement noise (only their ratio matters)
  q: number;
  r: number;
  atrLength: number;
  factor: number;
  rsiLength: number;
}

export const KST_DEFAULTS: KalmanStParams = { q: 0.01, r: 0.1, atrLength: 10, factor: 3, rsiLength: 14 };

type Bar = { high: number; low: number; close: number };

export const kalman = (xs: number[], q: number, r: number): number[] => {
  let x = 0;
  let p = 1;
  return xs.map((z, i) => {
    if (i === 0) {
      x = z;
      return x;
    }
    const pp = p + q;
    const k = pp / (pp + r);
    x += k * (z - x);
    p = (1 - k) * pp;
    return x;
  });
};

// Wilder's ATR; the first `n` bars average the true ranges there are
const atr = (bars: ReadonlyArray<Bar>, n: number): number[] => {
  let a = 0;
  return bars.map((b, i) => {
    const prev = i > 0 ? bars[i - 1].close : b.close;
    const tr = Math.max(b.high - b.low, Math.abs(b.high - prev), Math.abs(b.low - prev));
    a = i < n ? (a * i + tr) / (i + 1) : (a * (n - 1) + tr) / n;
    return a;
  });
};

// Wilder's RSI of the closes; none until `n` changes exist
export const wilderRsi = (closes: number[], n: number): Array<number | null> => {
  const out: Array<number | null> = closes.map(() => null);
  let gain = 0;
  let loss = 0;
  for (let i = 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    const g = Math.max(ch, 0);
    const l = Math.max(-ch, 0);
    if (i <= n) {
      gain += g / n;
      loss += l / n;
      if (i < n) continue;
    } else {
      gain = (gain * (n - 1) + g) / n;
      loss = (loss * (n - 1) + l) / n;
    }
    out[i] = loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss);
  }
  return out;
};

export interface KalmanStRead {
  // the smoothed price the bands are drawn about
  mid: Array<number | null>;
  // the Supertrend line: under price while up, over it while down
  line: Array<number | null>;
  trend: Array<1 | -1 | null>;
  // bars where the trend turned: `passed` when RSI agreed (above 50 for a
  // turn up, below for a turn down), which is when the chart marks it
  flips: Array<{ i: number; side: "BUY" | "SELL"; passed: boolean; rsi: number | null }>;
}

// `lastClosed`: the index of the newest closed bar — a turn on a bar still
// forming is not marked (it could turn back before the bar closes)
export const kalmanSupertrend = (
  bars: ReadonlyArray<Bar>,
  params: KalmanStParams = KST_DEFAULTS,
  lastClosed: number = bars.length - 1,
): KalmanStRead => {
  const n = bars.length;
  const empty: KalmanStRead = { mid: bars.map(() => null), line: bars.map(() => null), trend: bars.map(() => null), flips: [] };
  if (n <= params.atrLength + 1) return empty;
  const src = kalman(bars.map((b) => (b.high + b.low) / 2), params.q, params.r);
  const vol = kalman(atr(bars, params.atrLength), params.q, params.r);
  const rsi = wilderRsi(bars.map((b) => b.close), params.rsiLength);
  const up: number[] = [];
  const dn: number[] = [];
  const trend: Array<1 | -1> = [];
  for (let i = 0; i < n; i++) {
    let u = src[i] - params.factor * vol[i];
    let d = src[i] + params.factor * vol[i];
    if (i > 0) {
      if (bars[i - 1].close > up[i - 1]) u = Math.max(u, up[i - 1]);
      if (bars[i - 1].close < dn[i - 1]) d = Math.min(d, dn[i - 1]);
    }
    up.push(u);
    dn.push(d);
    const t = i === 0 ? 1 : trend[i - 1] === -1 && bars[i].close > dn[i - 1] ? 1 : trend[i - 1] === 1 && bars[i].close < up[i - 1] ? -1 : trend[i - 1];
    trend.push(t);
  }
  // the first ATR-length bars are the average still filling: not drawn
  const warm = params.atrLength;
  const flips: KalmanStRead["flips"] = [];
  for (let i = warm + 1; i < n && i <= lastClosed; i++) {
    if (trend[i] === trend[i - 1]) continue;
    const side = trend[i] === 1 ? "BUY" : "SELL";
    const r = rsi[i];
    flips.push({ i, side, rsi: r, passed: r !== null && (side === "BUY" ? r > 50 : r < 50) });
  }
  return {
    mid: src.map((v, i) => (i < warm ? null : v)),
    line: trend.map((t, i) => (i < warm ? null : t === 1 ? up[i] : dn[i])),
    trend: trend.map((t, i) => (i < warm ? null : t)),
    flips,
  };
};
