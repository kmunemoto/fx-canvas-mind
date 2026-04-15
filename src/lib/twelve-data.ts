import type { TechnicalData, CandleData, TimeInterval } from "./types";

const BASE = "https://api.twelvedata.com";

const MAX_RETRIES = 3;
const RETRY_DELAY = 61000;

async function fetchJson(url: string) {
  const res = await fetch(url);

  let data: any = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  if (res.status === 429 || data?.code === 429) {
    const err: any = new Error("Too Many Requests (429)");
    err.status = 429;
    throw err;
  }

  if (!res.ok) throw new Error(`Twelve Data API error: ${res.status}`);
  if (data?.status === "error") {
    const err: any = new Error(data.message || "Twelve Data API error");
    if (data.code === 429) err.status = 429;
    throw err;
  }

  return data;
}

async function fetchWithRetry(url: string, retries = 0): Promise<any> {
  try {
    return await fetchJson(url);
  } catch (err: any) {
    if (err.status === 429 && retries < MAX_RETRIES) {
      await new Promise((r) => setTimeout(r, RETRY_DELAY));
      return fetchWithRetry(url, retries + 1);
    }
    throw err;
  }
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function fetchPrice(symbol: string, apiKey: string): Promise<string> {
  const data = await fetchWithRetry(`${BASE}/price?symbol=${symbol}&apikey=${apiKey}`);
  return data.price;
}

export async function fetchTechnicalData(
  symbol: string,
  interval: TimeInterval,
  apiKey: string,
  onStage?: (stage: string) => void,
  onPriceUpdate?: (price: string) => void
): Promise<TechnicalData> {
  onStage?.("fetching_batch1");

  const [tsData, rsiData, macdData, bbandsData, sma20Data, ichimokuData, atrData] = await Promise.all([
    fetchWithRetry(`${BASE}/time_series?symbol=${symbol}&interval=${interval}&outputsize=100&apikey=${apiKey}`),
    fetchWithRetry(`${BASE}/rsi?symbol=${symbol}&interval=${interval}&time_period=14&apikey=${apiKey}`),
    fetchWithRetry(`${BASE}/macd?symbol=${symbol}&interval=${interval}&apikey=${apiKey}`),
    fetchWithRetry(`${BASE}/bbands?symbol=${symbol}&interval=${interval}&time_period=20&sd=2&apikey=${apiKey}`),
    fetchWithRetry(`${BASE}/sma?symbol=${symbol}&interval=${interval}&time_period=20&apikey=${apiKey}`),
    fetchWithRetry(`${BASE}/ichimoku?symbol=${symbol}&interval=${interval}&apikey=${apiKey}`),
    fetchWithRetry(`${BASE}/atr?symbol=${symbol}&interval=${interval}&time_period=14&apikey=${apiKey}`),
  ]);

  const timeSeries: CandleData[] = (tsData.values || []).slice(0, 20).map((v: any) => ({
    datetime: v.datetime,
    open: v.open,
    high: v.high,
    low: v.low,
    close: v.close,
  }));

  const provisionalPrice = timeSeries[0]?.close;
  if (provisionalPrice) onPriceUpdate?.(provisionalPrice);

  await delay(1100);

  onStage?.("fetching_batch2");

  const [priceData, sma50Data, sma200Data, stochData, adxData] = await Promise.all([
    fetchWithRetry(`${BASE}/price?symbol=${symbol}&apikey=${apiKey}`),
    fetchWithRetry(`${BASE}/sma?symbol=${symbol}&interval=${interval}&time_period=50&apikey=${apiKey}`),
    fetchWithRetry(`${BASE}/sma?symbol=${symbol}&interval=${interval}&time_period=200&apikey=${apiKey}`),
    fetchWithRetry(`${BASE}/stoch?symbol=${symbol}&interval=${interval}&apikey=${apiKey}`),
    fetchWithRetry(`${BASE}/adx?symbol=${symbol}&interval=${interval}&time_period=14&apikey=${apiKey}`),
  ]);

  const safeVal = (data: any, ...keys: string[]) => {
    try {
      const v = data.values?.[0];
      if (!v) return "N/A";
      if (keys.length === 0) return (Object.values(v).find((x) => typeof x === "string" && x !== v.datetime) as string) || "N/A";
      return keys.length === 1 ? (v[keys[0]] ?? "N/A") : keys.map((k) => v[k] ?? "N/A");
    } catch {
      return "N/A";
    }
  };

  const macdVals = macdData.values?.[0] || {};
  const ichimokuVals = ichimokuData.values?.[0] || {};
  const stochVals = stochData.values?.[0] || {};
  const bbandsVals = bbandsData.values?.[0] || {};
  const price = priceData.price ?? provisionalPrice ?? "N/A";

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
