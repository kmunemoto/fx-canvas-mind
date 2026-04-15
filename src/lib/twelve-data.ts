import type { TechnicalData, CandleData, TimeInterval } from "./types";

const BASE = "https://api.twelvedata.com";

async function fetchJson(url: string) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Twelve Data API error: ${res.status}`);
  const data = await res.json();
  if (data.status === "error") throw new Error(data.message || "Twelve Data API error");
  return data;
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function fetchPrice(symbol: string, apiKey: string): Promise<string> {
  const data = await fetchJson(`${BASE}/price?symbol=${symbol}&apikey=${apiKey}`);
  return data.price;
}

export async function fetchTechnicalData(
  symbol: string,
  interval: TimeInterval,
  apiKey: string,
  onStage?: (stage: string) => void
): Promise<TechnicalData> {
  onStage?.("fetching_price");

  // Batch 1: price + time_series (2 requests)
  const [priceData, tsData] = await Promise.all([
    fetchJson(`${BASE}/price?symbol=${symbol}&apikey=${apiKey}`),
    fetchJson(`${BASE}/time_series?symbol=${symbol}&interval=${interval}&outputsize=100&apikey=${apiKey}`),
  ]);

  const price = priceData.price;
  const timeSeries: CandleData[] = (tsData.values || []).slice(0, 20).map((v: any) => ({
    datetime: v.datetime,
    open: v.open,
    high: v.high,
    low: v.low,
    close: v.close,
  }));

  onStage?.("fetching_indicators");

  // Wait to respect rate limit (8 req/min)
  await delay(1200);

  // Batch 2: RSI, MACD, BBands, SMA20, SMA50, SMA200, Ichimoku, ATR (8 requests)
  const [rsiData, macdData, bbandsData, sma20Data, sma50Data, sma200Data, ichimokuData, atrData] =
    await Promise.all([
      fetchJson(`${BASE}/rsi?symbol=${symbol}&interval=${interval}&time_period=14&apikey=${apiKey}`),
      fetchJson(`${BASE}/macd?symbol=${symbol}&interval=${interval}&apikey=${apiKey}`),
      fetchJson(`${BASE}/bbands?symbol=${symbol}&interval=${interval}&time_period=20&sd=2&apikey=${apiKey}`),
      fetchJson(`${BASE}/sma?symbol=${symbol}&interval=${interval}&time_period=20&apikey=${apiKey}`),
      fetchJson(`${BASE}/sma?symbol=${symbol}&interval=${interval}&time_period=50&apikey=${apiKey}`),
      fetchJson(`${BASE}/sma?symbol=${symbol}&interval=${interval}&time_period=200&apikey=${apiKey}`),
      fetchJson(`${BASE}/ichimoku?symbol=${symbol}&interval=${interval}&apikey=${apiKey}`),
      fetchJson(`${BASE}/atr?symbol=${symbol}&interval=${interval}&time_period=14&apikey=${apiKey}`),
    ]);

  // Wait again for rate limit
  await delay(1200);

  // Batch 3: Stochastic, ADX (2 requests)
  const [stochData, adxData] = await Promise.all([
    fetchJson(`${BASE}/stoch?symbol=${symbol}&interval=${interval}&apikey=${apiKey}`),
    fetchJson(`${BASE}/adx?symbol=${symbol}&interval=${interval}&time_period=14&apikey=${apiKey}`),
  ]);

  const safeVal = (data: any, ...keys: string[]) => {
    try {
      const v = data.values?.[0];
      if (!v) return "N/A";
      if (keys.length === 0) return Object.values(v).find((x) => typeof x === "string" && x !== v.datetime) as string || "N/A";
      return keys.length === 1 ? (v[keys[0]] ?? "N/A") : keys.map((k) => v[k] ?? "N/A");
    } catch {
      return "N/A";
    }
  };

  const macdVals = macdData.values?.[0] || {};
  const ichimokuVals = ichimokuData.values?.[0] || {};
  const stochVals = stochData.values?.[0] || {};
  const bbandsVals = bbandsData.values?.[0] || {};

  return {
    price,
    datetime: new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }),
    timeSeries,
    rsi: safeVal(rsiData, "rsi") as string,
    macd: macdVals.macd ?? "N/A",
    macdSignal: macdVals.macd_signal ?? "N/A",
    macdHist: macdVals.macd_hist ?? "N/A",
    bbUpper: bbandsVals.upper_band ?? "N/A",
    bbMiddle: bbandsVals.middle_band ?? "N/A",
    bbLower: bbandsVals.lower_band ?? "N/A",
    sma20: safeVal(sma20Data, "sma") as string,
    sma50: safeVal(sma50Data, "sma") as string,
    sma200: safeVal(sma200Data, "sma") as string,
    tenkan: ichimokuVals.tenkan_sen ?? "N/A",
    kijun: ichimokuVals.kijun_sen ?? "N/A",
    spanA: ichimokuVals.senkou_span_a ?? "N/A",
    spanB: ichimokuVals.senkou_span_b ?? "N/A",
    atr: safeVal(atrData, "atr") as string,
    slowK: stochVals.slow_k ?? "N/A",
    slowD: stochVals.slow_d ?? "N/A",
    adx: safeVal(adxData, "adx") as string,
  };
}
