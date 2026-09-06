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
  // The cloud STANDING AT the newest bar: the spans computed 26 bars earlier.
  // spanA/spanB above are the pair this window projects 26 bars ahead, which
  // is a different place on the chart and was being read as if it were this.
  cloudNow: Cloud | null;
  cloudSide: CloudSide | null;
  // Where the projected cloud is going: its own top/bottom and whether it has
  // flipped (spanA crossing spanB) relative to the cloud at the price now.
  cloudAhead: Cloud | null;
  cloudAheadTwisted: boolean | null;
  // Whether the newest bar had closed when this was computed. A snapshot taken
  // mid-bar and the same bar's closed reading are otherwise indistinguishable,
  // and a breakout that is true mid-bar can be gone once the bar closes.
  barClosed: boolean | null;
  barsUsed: number;
}

// A price, or nothing. The bare global Number() is the wrong tool here: it
// reads null, "", "   ", [] and false as 0 and true as 1, and 0 is finite, so
// a missing field arrived as a price of zero and every indicator computed on
// it. Only a number, or a string that is entirely a number, counts.
const priceOf = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) && v > 0 ? v : null;
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? n : null;
};

// A bar that cannot be true is not data. A high below its own low, or below
// the open or close it is supposed to contain, means the row is damaged or the
// fields are transposed; either way the indicators computed from it are
// fiction and the plan resting on them is worse than no plan.
export const coherentBar = (c: Candle): boolean =>
  c.high >= c.low &&
  c.high >= c.open && c.high >= c.close &&
  c.low <= c.open && c.low <= c.close;

// Twelve Data time_series values (newest-first, string fields) -> oldest-first
// numbers, sorted by time, deduplicated, and with every incoherent bar
// dropped. Dropping is not silent to the caller: seriesHealth below reports
// what a series is missing so an analysis can refuse rather than proceed on
// holes.
export const parseCandles = (values: unknown): Candle[] => {
  if (!Array.isArray(values)) return [];

  const byTime = new Map<string, Candle>();
  const undated: Candle[] = [];
  for (const row of values) {
    if (typeof row !== "object" || row === null) continue;
    const r = row as Record<string, unknown>;
    const open = priceOf(r.open);
    const high = priceOf(r.high);
    const low = priceOf(r.low);
    const close = priceOf(r.close);
    if (open === null || high === null || low === null || close === null) continue;
    const datetime = typeof r.datetime === "string" ? r.datetime : "";
    const candle: Candle = { datetime, open, high, low, close };
    if (!coherentBar(candle)) continue;
    // Newest first on the wire, so the FIRST row for a timestamp is the
    // freshest reading of that bar and the one to keep.
    if (datetime === "") undated.push(candle);
    else if (!byTime.has(datetime)) byTime.set(datetime, candle);
  }
  // Sorted by time rather than merely reversed: the feed's order is a
  // convention, and one out-of-place row silently reorders every window.
  return [...byTime.values(), ...undated].sort((a, b) => a.datetime.localeCompare(b.datetime));
};

export interface SeriesHealth {
  ok: boolean;
  bars: number;
  dropped: number;
  // Milliseconds between the newest bar's open and now. Null when the newest
  // bar carries no readable timestamp.
  age_ms: number | null;
  issues: string[];
}

// Whether a parsed series is fit to analyse. Separate from parseCandles so the
// caller decides what to do about it: a hole in the middle of the entry
// timeframe is a reason to stop, the same hole three timeframes up may not be.
export const seriesHealth = (
  candles: Candle[],
  rawCount: number,
  minBars: number,
  intervalMs: number,
  nowMs: number,
  maxAgeIntervals = 3,
  // The moment STALENESS is measured from. Defaults to `nowMs`, and differs
  // from it only while the market is shut, when the newest bar is Friday's
  // close by definition and "hours behind the wall clock" is not evidence of
  // anything (see market-hours.ts `lastClose`).
  //
  // Kept as a SEPARATE clock rather than substituted for `nowMs`, because the
  // two answer different questions and swapping one for the other breaks the
  // other one. Substituting it wholesale shipped to production and turned
  // every bar newer than the Friday close into a `future_bar`: the freshness
  // gate then rejected the entry series for being too NEW, and the weekend
  // preview 502'd exactly where it used to 502 for being too old.
  staleFromMs = nowMs,
): SeriesHealth => {
  const issues: string[] = [];
  const dropped = Math.max(0, rawCount - candles.length);
  if (candles.length < minBars) issues.push(`too_few_bars:${candles.length}/${minBars}`);
  // A handful of dropped rows is a feed hiccup; a large share of them means
  // the payload is not what it claims to be.
  if (rawCount > 0 && dropped / rawCount > 0.05) issues.push(`dropped:${dropped}/${rawCount}`);
  const newest = candles.length > 0 ? candles[candles.length - 1] : null;
  const newestMs = newest ? Date.parse(newest.datetime.includes("T") ? newest.datetime : `${newest.datetime.replace(" ", "T")}Z`) : NaN;
  // Reported as the real age, off the real clock, whatever staleness is
  // measured against — the number on the row should not move because of how
  // the check was configured.
  const age = Number.isFinite(newestMs) ? nowMs - newestMs : null;
  const staleAge = Number.isFinite(newestMs) ? staleFromMs - newestMs : null;
  if (age === null || staleAge === null) issues.push("no_timestamp");
  // A bar dated after now is a broken feed, and that is true on a Sunday too.
  else if (age < 0) issues.push("future_bar");
  else if (intervalMs > 0 && staleAge > intervalMs * maxAgeIntervals) {
    issues.push(`stale:${Math.round(staleAge / 60000)}min`);
  }
  return { ok: issues.length === 0, bars: candles.length, dropped, age_ms: age, issues };
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

// Wilder RSI at every bar, aligned index-for-index with `closes`: null until
// the seed window has passed, a number after.
//
// A divergence needs the indicator at TWO points, and until this existed the
// prompt carried one RSI at the newest bar — so every claim about RSI rising,
// falling or diverging was about a second reading the model was never given.
//
// The Wilder seed is a simple average over the first `period` changes and is
// then smoothed; the values here are identical to what rsi() returned, which
// is now just the last of these.
export const rsiSeries = (closes: number[], period = 14): Array<number | null> => {
  const out: Array<number | null> = closes.map(() => null);
  if (closes.length < period + 1) return out;

  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change >= 0) gain += change;
    else loss -= change;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  // A stretch with no movement at all has neither gains nor losses, and the
  // ratio is 0/0. Reporting 100 there — as the single-value form did for any
  // zero-loss window — would put a flat market at the top of the scale.
  const value = (g: number, l: number): number | null => {
    if (l === 0) return g === 0 ? null : 100;
    return 100 - 100 / (1 + g / l);
  };
  out[period] = value(avgGain, avgLoss);

  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(change, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-change, 0)) / period;
    out[i] = value(avgGain, avgLoss);
  }
  return out;
};

// Wilder RSI. Needs at least period+1 closes.
export const rsi = (closes: number[], period = 14): number | null => {
  if (closes.length < period + 1) return null;
  const series = rsiSeries(closes, period);
  const last = series[series.length - 1];
  // The single-value form has always answered 100 for a window with no
  // losses, and a stored row's number must not change under it. Only the
  // no-movement-at-all case, which used to answer 100 too, is now null.
  return last;
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

export interface Range {
  high: number;
  low: number;
  width: number;
  // Where the last close sits inside the range, 0 (at the low) to 100 (at the
  // high). Null on a range with no width: a percentage of zero is not 50, it
  // is undefined, and rendering NaN% is worse than saying nothing.
  positionPct: number | null;
}

// The highest high and lowest low over the last `period` bars, and where
// price sits inside them.
//
// midOfRange computed exactly these two extremes and threw both away,
// returning only the midpoint — so the prompt could say where the middle of
// the range was but never how wide it was or where price stood in it.
export const rangeOf = (candles: Candle[], period: number): Range | null => {
  if (candles.length < period || period <= 0) return null;
  let high = -Infinity;
  let low = Infinity;
  for (let i = candles.length - period; i < candles.length; i++) {
    high = Math.max(high, candles[i].high);
    low = Math.min(low, candles[i].low);
  }
  if (!Number.isFinite(high) || !Number.isFinite(low)) return null;
  const width = high - low;
  const close = candles[candles.length - 1].close;
  return {
    high,
    low,
    width,
    positionPct: width > 0 ? ((close - low) / width) * 100 : null,
  };
};

const midOfRange = (candles: Candle[], period: number): number | null => {
  const r = rangeOf(candles, period);
  return r === null ? null : (r.high + r.low) / 2;
};

// Ichimoku's displacement, in bars. The spans computed from a window ending
// at bar N are drawn at bar N + 26; the cloud standing at bar N is therefore
// the pair computed 26 bars earlier.
export const ICHIMOKU_SHIFT = 26;

// The unshifted values: tenkan and kijun, which are drawn where they are
// computed, plus the spans this window projects 26 bars INTO THE FUTURE.
// Reading spanA/spanB here as "the cloud at the current price" is the mistake
// this module used to invite — see cloudNow below.
export const ichimoku = (
  candles: Candle[],
): { tenkan: number; kijun: number; spanA: number; spanB: number } | null => {
  const tenkan = midOfRange(candles, 9);
  const kijun = midOfRange(candles, 26);
  const spanB = midOfRange(candles, 52);
  if (tenkan === null || kijun === null || spanB === null) return null;
  return { tenkan, kijun, spanA: (tenkan + kijun) / 2, spanB };
};

export interface Cloud {
  top: number;
  bottom: number;
  spanA: number;
  spanB: number;
}

// The cloud standing AT a given bar: the spans computed 26 bars before it.
// This is what "price is above/below the cloud" means, and it is a different
// pair of numbers from the one the newest window projects.
export const cloudAt = (candles: Candle[], index: number): Cloud | null => {
  const from = index - ICHIMOKU_SHIFT;
  if (from < 0) return null;
  const window = candles.slice(0, from + 1);
  const ich = ichimoku(window);
  if (!ich) return null;
  return {
    top: Math.max(ich.spanA, ich.spanB),
    bottom: Math.min(ich.spanA, ich.spanB),
    spanA: ich.spanA,
    spanB: ich.spanB,
  };
};

export type CloudSide = "above" | "inside" | "below";

export const cloudSide = (price: number, cloud: Cloud): CloudSide =>
  price > cloud.top ? "above" : price < cloud.bottom ? "below" : "inside";

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

// `nowMs` and `intervalMs` are optional: without them the snapshot simply
// reports barClosed as null rather than guessing. Passing them is how the
// caller gets a reading it can later reproduce, because "the newest bar" means
// something different at 10:05 and at 10:59.
export const computeSnapshot = (
  candles: Candle[],
  intervalMs = 0,
  nowMs = 0,
): IndicatorSnapshot | null => {
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
  const now = cloudAt(candles, candles.length - 1);
  const ahead = ichi
    ? { top: Math.max(ichi.spanA, ichi.spanB), bottom: Math.min(ichi.spanA, ichi.spanB), spanA: ichi.spanA, spanB: ichi.spanB }
    : null;
  const openMs = Date.parse(last.datetime.includes("T") ? last.datetime : `${last.datetime.replace(" ", "T")}Z`);
  const closed = intervalMs > 0 && nowMs > 0 && Number.isFinite(openMs) ? openMs + intervalMs <= nowMs : null;

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
    cloudNow: now,
    cloudSide: now ? cloudSide(last.close, now) : null,
    cloudAhead: ahead,
    cloudAheadTwisted: ahead && now ? (ahead.spanA - ahead.spanB) * (now.spanA - now.spanB) < 0 : null,
    barClosed: closed,
    barsUsed: candles.length,
  };
};
