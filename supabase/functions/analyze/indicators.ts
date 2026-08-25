// Technical-indicator math shared by the analyze edge function (Deno) and the
// vitest suite (src/test/indicators.test.ts imports this file directly), so it
// must stay pure TypeScript: no Deno, Node, or DOM APIs.
//
// All series are oldest-first. Twelve Data returns newest-first, so callers
// convert with `parseCandles` before computing anything.

export interface Candle {
  datetime: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface IndicatorSnapshot {
  price: number;
  datetime: string;
  changePct: number | null;
  rsi: number | null;
  macd: number | null;
  macdSignal: number | null;
  macdHist: number | null;
  bbUpper: number | null;
  bbMiddle: number | null;
  bbLower: number | null;
  sma20: number | null;
  sma50: number | null;
  sma200: number | null;
  tenkan: number | null;
  kijun: number | null;
  spanA: number | null;
  spanB: number | null;
  atr: number | null;
  atrPct: number | null;
  slowK: number | null;
  slowD: number | null;
  adx: number | null;
  swingHighs: number[];
  swingLows: number[];
}

// Twelve Data time_series values (newest-first, string fields) -> oldest-first numbers.
// Rows with non-numeric OHLC are dropped.
export const parseCandles = (values: unknown): Candle[] => {
  if (!Array.isArray(values)) return [];

  const out: Candle[] = [];
  for (const row of values) {
    if (typeof row !== "object" || row === null) continue;
    const r = row as Record<string, unknown>;
    const open = Number(r.open);
    const high = Number(r.high);
    const low = Number(r.low);
    const close = Number(r.close);
    if (![open, high, low, close].every(Number.isFinite)) continue;
    out.push({
      datetime: typeof r.datetime === "string" ? r.datetime : "",
      open,
      high,
      low,
      close,
    });
  }
  return out.reverse();
};

export const sma = (values: number[], period: number): number | null => {
  if (period <= 0 || values.length < period) return null;
  let sum = 0;
  for (let i = values.length - period; i < values.length; i++) sum += values[i];
  return sum / period;
};

// Full EMA series (same length as input, first period-1 entries are null).
// Seeded with the SMA of the first `period` values, then standard smoothing.
export const emaSeries = (values: number[], period: number): (number | null)[] => {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (period <= 0 || values.length < period) return out;

  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  let prev = seed / period;
  out[period - 1] = prev;

  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
};

// Wilder RSI. Needs at least period+1 closes.
export const rsi = (closes: number[], period = 14): number | null => {
  if (closes.length < period + 1) return null;

  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change >= 0) gain += change;
    else loss -= change;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;

  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(change, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-change, 0)) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
};

export const macd = (
  closes: number[],
  fast = 12,
  slow = 26,
  signalPeriod = 9,
): { macd: number; signal: number; hist: number } | null => {
  if (closes.length < slow + signalPeriod) return null;

  const fastSeries = emaSeries(closes, fast);
  const slowSeries = emaSeries(closes, slow);

  const macdLine: number[] = [];
  for (let i = slow - 1; i < closes.length; i++) {
    macdLine.push((fastSeries[i] as number) - (slowSeries[i] as number));
  }

  const signalSeries = emaSeries(macdLine, signalPeriod);
  const signal = signalSeries[signalSeries.length - 1];
  if (signal === null) return null;

  const macdValue = macdLine[macdLine.length - 1];
  return { macd: macdValue, signal, hist: macdValue - signal };
};

export const bollinger = (
  closes: number[],
  period = 20,
  mult = 2,
): { upper: number; middle: number; lower: number } | null => {
  const middle = sma(closes, period);
  if (middle === null) return null;

  let variance = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    variance += (closes[i] - middle) ** 2;
  }
  const sd = Math.sqrt(variance / period);
  return { upper: middle + mult * sd, middle, lower: middle - mult * sd };
};

const trueRanges = (candles: Candle[]): number[] => {
  const out: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prevClose = candles[i - 1].close;
    out.push(Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose)));
  }
  return out;
};

const wilderSmooth = (values: number[], period: number): number | null => {
  if (values.length < period) return null;
  let avg = 0;
  for (let i = 0; i < period; i++) avg += values[i];
  avg /= period;
  for (let i = period; i < values.length; i++) {
    avg = (avg * (period - 1) + values[i]) / period;
  }
  return avg;
};

export const atr = (candles: Candle[], period = 14): number | null => {
  if (candles.length < period + 1) return null;
  return wilderSmooth(trueRanges(candles), period);
};

export const stochastic = (
  candles: Candle[],
  kPeriod = 14,
  kSmooth = 3,
  dSmooth = 3,
): { slowK: number; slowD: number } | null => {
  const needed = kPeriod + kSmooth + dSmooth - 2;
  if (candles.length < needed) return null;

  const fastK: number[] = [];
  for (let i = kPeriod - 1; i < candles.length; i++) {
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - kPeriod + 1; j <= i; j++) {
      hh = Math.max(hh, candles[j].high);
      ll = Math.min(ll, candles[j].low);
    }
    fastK.push(hh === ll ? 50 : ((candles[i].close - ll) / (hh - ll)) * 100);
  }

  const slowKSeries: number[] = [];
  for (let i = kSmooth - 1; i < fastK.length; i++) {
    let s = 0;
    for (let j = i - kSmooth + 1; j <= i; j++) s += fastK[j];
    slowKSeries.push(s / kSmooth);
  }

  const slowK = slowKSeries[slowKSeries.length - 1];
  const slowD = sma(slowKSeries, dSmooth);
  if (slowD === null) return null;
  return { slowK, slowD };
};

// Wilder ADX. Needs roughly 2*period candles to produce a value.
export const adx = (candles: Candle[], period = 14): number | null => {
  if (candles.length < 2 * period + 1) return null;

  const tr = trueRanges(candles);
  const plusDM: number[] = [];
  const minusDM: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const upMove = candles[i].high - candles[i - 1].high;
    const downMove = candles[i - 1].low - candles[i].low;
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }

  // Wilder-smoothed running sums, then DX per bar once period bars accumulate
  let trSum = 0;
  let plusSum = 0;
  let minusSum = 0;
  for (let i = 0; i < period; i++) {
    trSum += tr[i];
    plusSum += plusDM[i];
    minusSum += minusDM[i];
  }

  const dxs: number[] = [];
  const pushDx = () => {
    if (trSum === 0) {
      dxs.push(0);
      return;
    }
    const plusDI = (plusSum / trSum) * 100;
    const minusDI = (minusSum / trSum) * 100;
    const sum = plusDI + minusDI;
    dxs.push(sum === 0 ? 0 : (Math.abs(plusDI - minusDI) / sum) * 100);
  };
  pushDx();

  for (let i = period; i < tr.length; i++) {
    trSum = trSum - trSum / period + tr[i];
    plusSum = plusSum - plusSum / period + plusDM[i];
    minusSum = minusSum - minusSum / period + minusDM[i];
    pushDx();
  }

  return wilderSmooth(dxs, period);
};

const midOfRange = (candles: Candle[], period: number): number | null => {
  if (candles.length < period) return null;
  let hh = -Infinity;
  let ll = Infinity;
  for (let i = candles.length - period; i < candles.length; i++) {
    hh = Math.max(hh, candles[i].high);
    ll = Math.min(ll, candles[i].low);
  }
  return (hh + ll) / 2;
};

// Current (unshifted) Ichimoku values — what the lines are "made of" right now.
export const ichimoku = (
  candles: Candle[],
): { tenkan: number; kijun: number; spanA: number; spanB: number } | null => {
  const tenkan = midOfRange(candles, 9);
  const kijun = midOfRange(candles, 26);
  const spanB = midOfRange(candles, 52);
  if (tenkan === null || kijun === null || spanB === null) return null;
  return { tenkan, kijun, spanA: (tenkan + kijun) / 2, spanB };
};

// Fractal swing points (2 bars each side), newest first, deduplicated by
// proximity so the model gets distinct levels rather than one cluster.
export const swingLevels = (
  candles: Candle[],
  maxLevels = 4,
): { highs: number[]; lows: number[] } => {
  const highs: number[] = [];
  const lows: number[] = [];

  for (let i = candles.length - 3; i >= 2; i--) {
    const c = candles[i];
    const isHigh =
      c.high >= candles[i - 1].high && c.high >= candles[i - 2].high &&
      c.high > candles[i + 1].high && c.high > candles[i + 2].high;
    const isLow =
      c.low <= candles[i - 1].low && c.low <= candles[i - 2].low &&
      c.low < candles[i + 1].low && c.low < candles[i + 2].low;

    const distinct = (arr: number[], v: number) =>
      arr.every((x) => Math.abs(x - v) / v > 0.0005);

    if (isHigh && highs.length < maxLevels && distinct(highs, c.high)) highs.push(c.high);
    if (isLow && lows.length < maxLevels && distinct(lows, c.low)) lows.push(c.low);
    if (highs.length >= maxLevels && lows.length >= maxLevels) break;
  }

  return { highs, lows };
};

export const computeSnapshot = (candles: Candle[]): IndicatorSnapshot | null => {
  if (candles.length < 2) return null;

  const closes = candles.map((c) => c.close);
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];

  const macdResult = macd(closes);
  const bb = bollinger(closes);
  const stoch = stochastic(candles);
  const ichi = ichimoku(candles);
  const atrValue = atr(candles);
  const swings = swingLevels(candles);

  return {
    price: last.close,
    datetime: last.datetime,
    changePct: prev.close === 0 ? null : ((last.close - prev.close) / prev.close) * 100,
    rsi: rsi(closes),
    macd: macdResult?.macd ?? null,
    macdSignal: macdResult?.signal ?? null,
    macdHist: macdResult?.hist ?? null,
    bbUpper: bb?.upper ?? null,
    bbMiddle: bb?.middle ?? null,
    bbLower: bb?.lower ?? null,
    sma20: sma(closes, 20),
    sma50: sma(closes, 50),
    sma200: sma(closes, 200),
    tenkan: ichi?.tenkan ?? null,
    kijun: ichi?.kijun ?? null,
    spanA: ichi?.spanA ?? null,
    spanB: ichi?.spanB ?? null,
    atr: atrValue,
    atrPct: atrValue === null || last.close === 0 ? null : (atrValue / last.close) * 100,
    slowK: stoch?.slowK ?? null,
    slowD: stoch?.slowD ?? null,
    adx: adx(candles),
    swingHighs: swings.highs,
    swingLows: swings.lows,
  };
};
