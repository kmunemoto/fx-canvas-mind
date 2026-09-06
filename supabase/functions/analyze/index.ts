const FUNCTION_VERSION = "analyze-v40-2026-09-06T08:15:00Z";
// Open plans in the same direction inside this window are the same bet
const OPEN_PLAN_WINDOW_HOURS = 24;

import {
  atr,
  computeSnapshot,
  parseCandles,
  rsiSeries,
  seriesHealth,
  type Candle,
  type IndicatorSnapshot,
} from "./indicators.ts";

import {
  NEWS_DOMAINS,
  isInaccessibleDomainError,
  parseInaccessibleDomains,
  planDomainRecovery,
} from "./websearch.ts";

import {
  resolveAnalysisLocale,
  stringsFor,
  withDisclaimer,
  type AnalysisLocale,
} from "./locale.ts";

import { PRICE_OVERLAY_BUDGET_MS, WALL_CLOCK_BUDGET_MS, canRetryWithoutSearch, planAttempt } from "./budget.ts";

import {
  MAX_LIMIT_ATR,
  MAX_STOP_ATR,
  MIN_RISK_REWARD,
  MIN_STOP_ATR,
  TREND_ADX,
  evaluateEntry,
  waitPlanFor,
  type EntryType,
  type EntryVerdict,
  type WaitPlan,
} from "./entry.ts";

import {
  inForce,
  MAX_PROMPT_RULES,
  parseRules,
  promptCharBudget,
  type Rule,
  selectPromptRules,
} from "./rules.ts";
import {
  type ContextLike,
  contextFromStored,
  type Footprint,
  footprintOf,
  hasReading,
  type RuleSituation,
  situationFor,
} from "./situation.ts";

import { computeStructure, pivots, structureLines } from "./structure.ts";
import { detectDivergence, type Divergence } from "./divergence.ts";
import { HORIZON_MS, currenciesOf, renderEventBlock, upcomingFor, type EconEvent } from "../econ-calendar/events.ts";
import { closedTail, isPossiblyClosed, lastClose, nextOpen } from "../_shared/market-hours.ts";
import { PLAN_CONTRACT } from "../_shared/contract.ts";
import {
  GMO_ANALYSIS_TIMEFRAMES,
  acceptOverlay,
  fetchRecentQuotes,
  midCandle,
} from "./price-source.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const ADMIN_EMAILS = ["k.munemoto@kyoto-salute.com", "munekan2989@gmail.com"];
// Writing the history row is retried before the analysis is called a failure:
// a PostgREST hiccup should not cost the user a credit and a plan.
const SAVE_ATTEMPTS = 3;
const SAVE_RETRY_MS = 400;

// Plans that may run an analysis at all. Anything else — "free", an expired
// subscription, a missing profile row — is refused before any paid work.
const PAID_PLANS = new Set(["light", "standard", "pro"]);

// Server-side allowlist mirroring the pairs the UI offers. Without it any
// authenticated caller could aim the analyzer (and the paid market-data +
// Anthropic calls behind it) at arbitrary Twelve Data symbols, and put an
// arbitrary string into the model prompt.
const ALLOWED_PAIRS = new Set([
  "USD/JPY", "EUR/USD", "GBP/USD", "EUR/JPY",
  "GBP/JPY", "AUD/USD", "AUD/JPY",
]);

// Higher timeframes analyzed alongside the one the user picked. The entry
// timeframe comes first and is the one prices are planned on.
// Bars per timeframe. The higher timeframes used to ask for 130, which is
// below the 200 SMA200 needs, so the long-term trend the chain exists to
// supply was structurally absent from every higher-timeframe block and
// rendered as "n/a" on every run.
// The floor the system prompt states and the server now enforces. Below it the
// model's own answer is "I am not confident", and WAIT is the honest form of
// that answer.
const MIN_CONFIDENCE = 60;
const ENTRY_BARS = 250;
const HIGHER_BARS = 250;

// Length of one bar, for deciding whether the newest one has closed and how
// stale a series is allowed to be.
const INTERVAL_MS: Record<string, number> = {
  "15min": 15 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "4h": 4 * 60 * 60 * 1000,
  "1day": 24 * 60 * 60 * 1000,
  "1week": 7 * 24 * 60 * 60 * 1000,
  "1month": 30 * 24 * 60 * 60 * 1000,
};

const TF_CHAIN: Record<string, string[]> = {
  "15min": ["15min", "1h", "4h"],
  "1h": ["1h", "4h", "1day"],
  "4h": ["4h", "1day", "1week"],
  "1day": ["1day", "1week", "1month"],
};

type JsonRecord = Record<string, unknown>;

type AuthUser = {
  id: string;
  email: string | null;
};

type ProfileRecord = {
  plan?: string;
};

type ParsedRequestBody = {
  currencyPair: string;
  interval: string;
  includeFundamental: boolean;
  locale: AnalysisLocale;
};

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const withVersion = (body: unknown) => {
  if (isRecord(body)) {
    return { version: FUNCTION_VERSION, ...body };
  }

  return { version: FUNCTION_VERSION, data: body };
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(withVersion(body)), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
      "X-Function-Version": FUNCTION_VERSION,
    },
  });

// Deno's fetch puts the full request URL into network-failure messages, and
// the market-data key travels in that URL as a query parameter — so every
// error string that reaches the client goes through here first.
const redactSecrets = (message: string): string =>
  message
    .replace(/apikey=[^&\s)"']+/gi, "apikey=***")
    .replace(/x-api-key["\s:]+[^\s,"']+/gi, "x-api-key ***");

const parseJsonResponse = (rawText: string): unknown => {
  if (!rawText) return null;

  try {
    return JSON.parse(rawText);
  } catch {
    return null;
  }
};

const asTrimmedString = (value: unknown, fallback = "") => {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed || fallback;
};

const asFiniteNumber = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

const clampInt = (value: unknown, min: number, max: number, fallback: number) => {
  const n = asFiniteNumber(value);
  if (n === null) return fallback;
  return Math.round(Math.min(max, Math.max(min, n)));
};

const toStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];

  const normalized: string[] = [];

  for (const item of value) {
    if (typeof item === "string") {
      const trimmed = item.trim();
      if (trimmed) normalized.push(trimmed);
    } else if (typeof item === "number" && Number.isFinite(item)) {
      normalized.push(String(item));
    }
  }

  return normalized;
};

// JPY-quoted pairs trade in 3 decimals, everything else in 5
const pairDecimals = (pair: string) => (pair.toUpperCase().includes("JPY") ? 3 : 5);

const fmt = (value: number | null | undefined, decimals: number, fallback = "—") =>
  value === null || value === undefined || !Number.isFinite(value)
    ? fallback
    : value.toFixed(decimals);

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

const candleLines = (candles: Candle[], count: number) =>
  candles
    .slice(-count)
    .map((c) => `${c.datetime},${c.open},${c.high},${c.low},${c.close}`)
    .join("\n");

const snapshotLines = (s: IndicatorSnapshot, decimals: number) => {
  const p = (v: number | null) => fmt(v, decimals, "n/a");
  const x = (v: number | null, d = 2) => fmt(v, d, "n/a");
  return [
    `現在値: ${p(s.price)} (${s.datetime} UTC 始値の足${
      s.barClosed === false ? "・この足はまだ形成中" : s.barClosed === true ? "・確定済み" : ""
    }) 前足比 ${x(s.changePct)}%`,
    `RSI14: ${x(s.rsi)} | Stoch %K/%D: ${x(s.slowK)}/${x(s.slowD)} | ADX14: ${x(s.adx)}`,
    `MACD: ${x(s.macd, 5)} Signal: ${x(s.macdSignal, 5)} Hist: ${x(s.macdHist, 5)}`,
    `SMA20/50/200: ${p(s.sma20)} / ${p(s.sma50)} / ${
      s.sma200 === null ? `算出不能(足${s.barsUsed}本、200本必要)` : p(s.sma200)
    }`,
    `BB(20,2): 上 ${p(s.bbUpper)} 中 ${p(s.bbMiddle)} 下 ${p(s.bbLower)}`,
    // Two clouds, named apart. The pair this window computes is drawn 26 bars
    // AHEAD; the cloud standing at the current price was computed 26 bars ago.
    // Handing over one pair labelled 先行A/先行B invited reading the future
    // cloud as the one price is trading against.
    `一目 転換/基準: ${p(s.tenkan)} / ${p(s.kijun)}`,
    `現在価格の雲(26本前に算出・いま価格が接している雲): 上 ${p(s.cloudNow?.top ?? null)} 下 ${p(s.cloudNow?.bottom ?? null)} → 価格は${
      s.cloudSide === "above" ? "雲の上" : s.cloudSide === "below" ? "雲の下" : s.cloudSide === "inside" ? "雲の中" : "判定不能"
    }`,
    `先行する雲(26本先に描かれる・まだ価格は到達していない): 上 ${p(s.cloudAhead?.top ?? null)} 下 ${p(s.cloudAhead?.bottom ?? null)}${
      s.cloudAheadTwisted === true ? " ※ねじれ(現在の雲と上下が逆)" : ""
    }`,
    `ATR14: ${p(s.atr)} (${x(s.atrPct)}% of price)`,
    // The two swing lines that used to sit here are gone. They carried four
    // bare prices with no date, no order and no distance — 156.884 preceded
    // 157.081 only because the scan ran newest-first, and nothing said so.
    // The structure block below carries the same levels with the bar they
    // printed on and how far away they are.
  ].join("\n");
};

const SYSTEM_PROMPT = `あなたはプロップファームのシニアFXアナリストです。マルチタイムフレームの価格データと計算済みテクニカル指標に基づき、規律あるトレードプランを構築します。

必ず次の手順で分析してください:
1. STRUCTURE — 構造の判定はあなたの仕事である。ただし材料はサーバが計算済みで、そこにある数値は数え直さず引用する（スイング高安と日付、終値ブレイク、上下の余地、レンジ内の位置、正味変化）。
   「直近2スイングの並び」は**直近2点だけ**の比較であって、参照期間全体の構造ではない。並びと正味変化が食い違うことは普通にあるので、両方を見て自分で判断し、どちらを根拠にしたか書く。
   引用する水準は上の一覧にあるものだけにする（一覧に無い価格を「直近高値」と呼ばない）。
2. LEVELS — 上記のスイング高安に加え、移動平均・一目の雲・ラウンドナンバーから有効なサポート/レジスタンスを特定する。
   **板情報・出来高・建玉・約定履歴は一切取得していない。** 「ストップが溜まっている」「大口が仕込んでいる」「ストップ狩り」は、価格の動きからの**推測**であって観測した事実ではない。書く場合は推測であると明示し、根拠にした値動き（どの水準を何本前にヒゲだけで抜けたか等）を必ず添える。断定形で書かない。
3. TREND — 時間足間の方向整合性を評価する。上位足の方向に逆らうエントリーは確信度を大きく下げる。
4. TARGETS — 損切りと利確1/2/3を、**与えられたエントリー価格の周りに**決める。損切りは直近スイング±ATRに根拠を置き、現在値から ATR×0.5〜1.0 の範囲に置く。ATR×${MIN_STOP_ATR}未満の損切りはノイズで刈られるためサーバー側で却下され、遠すぎる損切りはリスクリワードが成立せず見送りになる。
5. ENTRY — **エントリー価格は選ばない。** 提示された「現在値」が、そのまま成行の約定価格になる。あなたが決めるのは損切りと利確だけで、それを現在値の周りに置く。
   - 「押し目を待って買う」「戻りを待って売る」は出力できない。今この価格で入るか、入らないかの二択である。待つべき局面なら signal を "WAIT" にする。
   - 現在値でのリスクリワード（TP1基準）が ${MIN_RISK_REWARD} を下回るプランは出さない。損切りを妥当な範囲で近づけて成立しないなら、それは「今は入るところではない」ということなので "WAIT" にする。無理に利確を伸ばして帳尻を合わせない。
   - WAIT は逃げではなく判断である。ただし WAIT もあとで検証される（その後の値動きで、取れたはずのトレードがあったかを機械的に採点する）ので、迷ったら WAIT ということはしない。
6. PLAN — 全てを統合して最終判断を下す。

ルール:
- 確信度が60未満の場合、signal は必ず "WAIT"。
- 時間足の方向が矛盾する場合は確信度を下げる。
- すべての価格は分析対象ペアの実際の価格スケールで出力する。
- 入力データの時刻はすべて UTC。文章で時刻に触れるときは日本時間（JST = UTC+9）に換算し、「JST」を添える。
{{LANGUAGE_RULE}}
- warnings には必ず「この分析は参考情報です。投資判断は自己責任で行ってください」を含める。
- ADX が 20 未満ならトレンドが弱いことを明記し、レンジ戦略を検討する。
- ダイバージェンスは「ダイバージェンス(RSI14・サーバ判定)」の行が結論である。その行が「なし」「判定不可」なら、ダイバージェンスがあるとは書かない。
  異なる2つのオシレーター（RSIとStoch）を同じ時点で比べたものや、同じ指標を別の時間足で比べたものはダイバージェンスではない。隠れ（ヒドゥン）ダイバージェンスは計算していないので主張しない。

{{EVENTS}}
{{LEARNED_RULES}}`;

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    signal: { type: "string", enum: ["BUY", "SELL", "WAIT"] },
    thesis: { type: "string", description: "一行のトレードテーゼ（日本語、30字以内）" },
    confidence: { type: "integer", description: "0-100" },
    technical_score: { type: "integer", description: "0-100" },
    fundamental_score: { type: "integer", description: "0-100。ファンダ情報なしの場合は50" },
    risk_level: { type: "string", enum: ["LOW", "MEDIUM", "HIGH"] },
    sentiment: { type: "string", enum: ["BULLISH", "NEUTRAL", "BEARISH"] },
    stop_loss: { type: "number" },
    take_profit_1: { type: "number" },
    take_profit_2: { type: "number" },
    take_profit_3: { type: "number" },
    risk_reward_ratio: { type: "string", description: "例 1:2.1（TP1基準）" },
    market_context: { type: "string", description: "市場環境の説明（日本語）" },
    market_context_detail: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["Trend Day", "Range Day", "Breakout", "Reversal", "Choppy"] },
        structure: { type: "string", description: "例 Higher Highs & Higher Lows" },
        smart_money: { type: "string", enum: ["Accumulation", "Distribution", "Neutral"] },
        strength: { type: "string", enum: ["Weak", "Moderate", "Strong"] },
        session: { type: "string", enum: ["Tokyo", "London", "New York", "Overlap", "Off Hours"] },
        direction: { type: "string", enum: ["Up", "Down", "Sideways"] },
        continuity: { type: "string", enum: ["Sustained", "Fading", "Choppy"] },
      },
      // smart_money is deliberately NOT required. As an enum of
      // Accumulation/Distribution/Neutral it forced a claim about
      // institutional intent on every run — 18 Distribution, 3 Accumulation,
      // 0 Neutral across the first 21, tracking direction perfectly and
      // carrying nothing direction did not. The app has no order flow, so
      // there is nothing to observe it from.
      required: ["mode", "structure", "strength", "session", "direction", "continuity"],
      additionalProperties: false,
    },
    stop_hunt_zone: {
      type: "string",
      description: "板情報は取得していないため推測。ヒゲのみで抜けた水準など、値動きの根拠があるときだけ価格帯を書き、無ければ Not detected",
    },
    timeframe_alignment: {
      type: "array",
      items: {
        type: "object",
        properties: {
          timeframe: { type: "string" },
          bias: { type: "string", enum: ["BULLISH", "NEUTRAL", "BEARISH"] },
          note: { type: "string", description: "10字程度の根拠（日本語）" },
        },
        required: ["timeframe", "bias", "note"],
        additionalProperties: false,
      },
    },
    key_factors: { type: "array", items: { type: "string" } },
    support_levels: { type: "array", items: { type: "number" } },
    resistance_levels: { type: "array", items: { type: "number" } },
    analysis: { type: "string", description: "詳細分析（日本語、手順1-5に沿って）" },
    warnings: { type: "array", items: { type: "string" } },
  },
  required: [
    "signal", "thesis", "confidence", "technical_score", "fundamental_score",
    "risk_level", "sentiment", "stop_loss", "take_profit_1",
    "take_profit_2", "take_profit_3", "risk_reward_ratio", "market_context",
    "market_context_detail", "timeframe_alignment",
    "key_factors", "support_levels", "resistance_levels", "analysis", "warnings",
  ],
  additionalProperties: false,
};

// ---------------------------------------------------------------------------
// Anthropic response handling
// ---------------------------------------------------------------------------

const extractAnthropicText = (value: unknown) => {
  if (!isRecord(value)) return "";

  const content = value.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";

  const textParts: string[] = [];

  for (const block of content) {
    if (typeof block === "string") {
      textParts.push(block);
      continue;
    }

    if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
      textParts.push(block.text);
    }
  }

  return textParts.join("").trim();
};

const parseAnalysisJson = (finalText: string): unknown => {
  const tagMatch = finalText.match(/<json>([\s\S]*?)<\/json>/);
  const source = tagMatch ? tagMatch[1] : finalText;
  const cleaned = source.replace(/```json\n?|```\n?/g, "").trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    const first = cleaned.indexOf("{");
    const last = cleaned.lastIndexOf("}");
    if (first !== -1 && last > first) {
      try {
        return JSON.parse(cleaned.slice(first, last + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
};

interface NormalizedAnalysis {
  signal: "BUY" | "SELL" | "WAIT";
  thesis: string;
  confidence: number;
  technical_score: number;
  fundamental_score: number;
  risk_level: string;
  sentiment: string;
  entry_point: string;
  stop_loss: string;
  take_profit_1: string;
  take_profit_2: string;
  take_profit_3: string;
  entry_type: EntryType;
  risk_reward_ratio: string;
  market_context: string;
  market_context_detail: JsonRecord | null;
  stop_hunt_zone: string;
  timeframe_alignment: { timeframe: string; bias: string; note: string }[];
  analysis: string;
  key_factors: string[];
  warnings: string[];
  support_levels: string[];
  resistance_levels: string[];
  // raw numbers kept for the analyses table / outcome tracking
  entry_point_num: number | null;
  stop_loss_num: number | null;
  take_profit_1_num: number | null;
  take_profit_2_num: number | null;
  take_profit_3_num: number | null;
}

const normalizeAnalysis = (value: unknown, decimals: number, locale: AnalysisLocale): NormalizedAnalysis => {
  const source = isRecord(value) ? value : {};
  const signal = source.signal === "BUY" || source.signal === "SELL" || source.signal === "WAIT"
    ? source.signal
    : "WAIT";
  const riskLevel = source.risk_level === "LOW" || source.risk_level === "MEDIUM" || source.risk_level === "HIGH"
    ? source.risk_level
    : "MEDIUM";
  const sentiment = source.sentiment === "BULLISH" || source.sentiment === "NEUTRAL" || source.sentiment === "BEARISH"
    ? source.sentiment
    : "NEUTRAL";

  const priceField = (v: unknown) => {
    const n = asFiniteNumber(v);
    return { num: n, text: n === null ? asTrimmedString(v, "—") : n.toFixed(decimals) };
  };

  // The entry is no longer read from the model — the server writes it from the
  // market price. Parsed as a blank so the shape is unchanged for callers.
  const entry = priceField(undefined);
  const sl = priceField(source.stop_loss);
  const tp1 = priceField(source.take_profit_1);
  const tp2 = priceField(source.take_profit_2);
  const tp3 = priceField(source.take_profit_3);

  const levelList = (v: unknown) => {
    if (!Array.isArray(v)) return [];
    const out: string[] = [];
    for (const item of v) {
      const n = asFiniteNumber(item);
      if (n !== null) out.push(n.toFixed(decimals));
      else if (typeof item === "string" && item.trim()) out.push(item.trim());
    }
    return out;
  };

  const detail = isRecord(source.market_context_detail) ? source.market_context_detail : null;

  const alignment: { timeframe: string; bias: string; note: string }[] = [];
  if (Array.isArray(source.timeframe_alignment)) {
    for (const item of source.timeframe_alignment) {
      if (!isRecord(item)) continue;
      const bias = item.bias === "BULLISH" || item.bias === "BEARISH" || item.bias === "NEUTRAL"
        ? item.bias
        : "NEUTRAL";
      alignment.push({
        timeframe: asTrimmedString(item.timeframe, "?"),
        bias,
        note: asTrimmedString(item.note, ""),
      });
    }
  }

  return {
    signal,
    thesis: asTrimmedString(source.thesis, ""),
    confidence: clampInt(source.confidence, 0, 100, 0),
    technical_score: clampInt(source.technical_score, 0, 100, 0),
    fundamental_score: clampInt(source.fundamental_score, 0, 100, 50),
    risk_level: riskLevel,
    sentiment,
    entry_point: entry.text,
    stop_loss: sl.text,
    take_profit_1: tp1.text,
    take_profit_2: tp2.text,
    take_profit_3: tp3.text,
    // Every plan is entered at the market by construction
    entry_type: "market" as const,
    risk_reward_ratio: asTrimmedString(source.risk_reward_ratio, "—"),
    market_context: asTrimmedString(source.market_context, ""),
    market_context_detail: detail,
    stop_hunt_zone: asTrimmedString(source.stop_hunt_zone, "Not detected"),
    timeframe_alignment: alignment,
    analysis: asTrimmedString(source.analysis, ""),
    key_factors: toStringArray(source.key_factors),
    warnings: withDisclaimer(toStringArray(source.warnings), locale),
    support_levels: levelList(source.support_levels),
    resistance_levels: levelList(source.resistance_levels),
    entry_point_num: entry.num,
    stop_loss_num: sl.num,
    take_profit_1_num: tp1.num,
    take_profit_2_num: tp2.num,
    take_profit_3_num: tp3.num,
  };
};

const parseRequestBody = async (req: Request): Promise<
  | { data: ParsedRequestBody; error?: undefined }
  | { data?: undefined; error: string }
> => {
  let requestBody: unknown;

  try {
    requestBody = await req.json();
  } catch {
    return { error: "リクエスト形式が不正です" };
  }

  const body = isRecord(requestBody) ? requestBody : {};
  const currencyPair = asTrimmedString(body.currencyPair);
  const interval = asTrimmedString(body.interval);
  const includeFundamental = typeof body.includeFundamental === "boolean"
    ? body.includeFundamental
    : true;

  if (!currencyPair || !interval) {
    return { error: "通貨ペアまたは時間足が不正です" };
  }

  if (!TF_CHAIN[interval]) {
    return { error: `未対応の時間足です: ${interval}` };
  }

  if (!ALLOWED_PAIRS.has(currencyPair.toUpperCase())) {
    return { error: `未対応の通貨ペアです: ${currencyPair}` };
  }

  return {
    data: {
      currencyPair,
      interval,
      includeFundamental,
      // Unknown or missing values fall back to Japanese rather than failing.
      locale: resolveAnalysisLocale(body.locale),
    } satisfies ParsedRequestBody,
  };
};

const readProfile = (value: unknown): ProfileRecord | null => {
  if (isRecord(value)) {
    return { plan: typeof value.plan === "string" ? value.plan : undefined };
  }

  if (Array.isArray(value) && value.length > 0 && isRecord(value[0])) {
    return readProfile(value[0]);
  }

  return null;
};

const readAuthUser = (value: unknown): AuthUser | null => {
  if (!isRecord(value)) return null;
  const id = asTrimmedString(value.id);
  if (!id) return null;

  return {
    id,
    email: typeof value.email === "string" ? value.email : null,
  };
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const startedAt = Date.now();
  let stage = "init";
  // A credit is spent before the billable work starts (that is what closes the
  // TOCTOU race), so every failure past that point has to hand it back.
  let quotaConsumed = false;
  let releaseQuota: () => Promise<void> = async () => {};
  let remainingToday: () => number | null = () => null;

  const fail = async (payload: JsonRecord, status: number) => {
    const refunded = quotaConsumed;
    await releaseQuota();
    // Let the client resync its "remaining today" counter after a refund
    return json(refunded ? { ...payload, remaining: remainingToday() } : payload, status);
  };

  try {
    stage = "read_auth_header";
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return json({ ok: false, error: "認証が必要です", diagnostics: { error_stage: "missing_auth", stage } }, 401);
    }

    stage = "load_env";
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const twelveDataKey = Deno.env.get("TWELVE_DATA_API_KEY");
    const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");

    if (!supabaseUrl || !supabaseAnonKey) {
      return json({ ok: false, error: "サーバー設定エラー: Supabase credentials not configured", diagnostics: { error_stage: "missing_supabase_credentials", stage } }, 500);
    }

    if (!twelveDataKey) {
      return json({ ok: false, error: "サーバー設定エラー: Market data API key not configured", diagnostics: { error_stage: "missing_market_data_key", stage } }, 500);
    }

    if (!anthropicKey) {
      return json({ ok: false, error: "サーバー設定エラー: AI API key not configured", diagnostics: { error_stage: "missing_ai_key", stage } }, 500);
    }

    stage = "fetch_user";
    const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: {
        Authorization: authHeader,
        apikey: supabaseAnonKey,
      },
    });
    const userRaw = await userRes.text();
    const user = userRes.ok ? readAuthUser(parseJsonResponse(userRaw)) : null;

    if (!user) {
      return json({
        ok: false,
        error: "認証に失敗しました",
        diagnostics: { error_stage: "auth_failed", stage, status: userRes.status, preview: userRaw.slice(0, 200) },
      }, 401);
    }

    stage = "parse_request";
    const parsedRequest = await parseRequestBody(req);
    if (parsedRequest.error || !parsedRequest.data) {
      return json({ ok: false, error: parsedRequest.error ?? "リクエスト形式が不正です", diagnostics: { error_stage: "invalid_input", stage } }, 400);
    }

    const { currencyPair, interval, includeFundamental, locale } = parsedRequest.data;
    const L = stringsFor(locale);
    const decimals = pairDecimals(currencyPair);

    // The usage counters are read and written with the service role: with the
    // caller's own token a user could reset their own count and analyze without
    // limit. Fall back to the caller's token only if the key is missing.
    const dbApiKey = serviceRoleKey || supabaseAnonKey;
    const dbAuthorization = serviceRoleKey ? `Bearer ${serviceRoleKey}` : authHeader;

    if (!serviceRoleKey) {
      console.warn("SUPABASE_SERVICE_ROLE_KEY is not configured; usage counters are not enforceable");
    }

    releaseQuota = async () => {
      if (!quotaConsumed) return;
      quotaConsumed = false; // never refund the same credit twice
      try {
        const res = await fetch(`${supabaseUrl}/rest/v1/rpc/release_analysis_quota`, {
          method: "POST",
          headers: {
            Authorization: dbAuthorization,
            apikey: dbApiKey,
            "Content-Type": "application/json",
            "content-profile": "public",
          },
          body: JSON.stringify({ p_user_id: user.id }),
        });
        if (!res.ok) {
          console.error("Quota release failed:", res.status, (await res.text()).slice(0, 300));
        } else {
          await res.text();
          count = Math.max(count - 1, 0);
        }
      } catch (err) {
        console.error("Quota release threw:", err);
      }
    };

    stage = "fetch_profile";
    const profileRes = await fetch(
      `${supabaseUrl}/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}&select=plan`,
      {
        headers: {
          Authorization: dbAuthorization,
          apikey: dbApiKey,
          Accept: "application/vnd.pgrst.object+json",
          "accept-profile": "public",
        },
      },
    );
    const profileRaw = await profileRes.text();
    const profile = profileRes.ok ? readProfile(parseJsonResponse(profileRaw)) : null;

    const isAdmin = ADMIN_EMAILS.includes((user.email || "").toLowerCase());
    const plan = isAdmin ? "pro" : (profile?.plan || "free");

    // Analysis is a paid feature. Every call costs a model turn and several
    // market-data requests, so an account without a subscription is turned
    // away here — before any of that is spent, and before a quota row is
    // touched. The client hides the button, but the client is not the guard.
    stage = "check_subscription";
    if (!isAdmin && !PAID_PLANS.has(plan)) {
      return json({
        ok: false,
        error: L.subscriptionRequired,
        diagnostics: { error_stage: "subscription_required", stage, plan },
        subscription_required: true,
        plan,
      }, 402);
    }

    // A shut market is not a failure, and it is not a plan either.
    //
    // Every plan is entered at the price on screen, so with the market closed
    // there is no price to enter at: publishing one lets the weekend gap be
    // written up as a trade nobody could have taken. That much stands, and the
    // late gate at check_entry still turns a closed market into a WAIT.
    //
    // What it was never a reason for is refusing to LOOK. This used to return
    // a 409 before spending anything, which put the analyst out of reach from
    // Friday 21:00 UTC to Sunday 22:00 UTC — about 49 hours a week, and in
    // Japan that is the whole of Saturday and Sunday, which is exactly when a
    // person has time to study a chart. Nothing the server computes off
    // Friday's close stops being true on a Sunday: the indicators, the
    // structure, the divergence, the rules whose situation matches, the week's
    // calendar. Only the entry does.
    //
    // The refusal also said something untrue. Its message read "I made it a
    // WAIT" — and nothing was made: no analysis ran, no row was written, and
    // the user was told about a decision that did not exist.
    //
    // So the run goes ahead as a PREVIEW: the full read, no entry, no stop, no
    // targets, and a row that is kept out of every statistic and never scored.
    // Deliberately decided from the arrival time and NOT reused for the late
    // gate below — a run that began while the market was open and ended after
    // the close was still decided at a price that existed, and that WAIT is a
    // real one the scorer should grade.
    stage = "check_market_hours";
    const previewMode = isPossiblyClosed(Date.now());
    const marketOpensAt = previewMode ? new Date(nextOpen(Date.now())).toISOString() : null;

    const limits: Record<string, number> = {
      light: 10,
      standard: 30,
      pro: 9999,
    };
    const dailyLimit = limits[plan] || 10;

    // Check-and-increment in one statement, before any paid work. Reading the
    // count, testing it, then writing it back lets concurrent requests all
    // pass the same check and bill K analyses against one credit.
    let count = 0;
    remainingToday = () => (isAdmin ? null : Math.max(dailyLimit - count, 0));
    if (!isAdmin) {
      stage = "consume_quota";
      const quotaRes = await fetch(`${supabaseUrl}/rest/v1/rpc/consume_analysis_quota`, {
        method: "POST",
        headers: {
          Authorization: dbAuthorization,
          apikey: dbApiKey,
          "Content-Type": "application/json",
          "content-profile": "public",
        },
        body: JSON.stringify({ p_user_id: user.id, p_limit: dailyLimit }),
      });
      const quotaRaw = await quotaRes.text();

      if (!quotaRes.ok) {
        console.error("Quota RPC failed:", quotaRes.status, quotaRaw.slice(0, 300));
        return json({
          ok: false,
          error: "利用状況の確認に失敗しました。時間をおいて再試行してください。",
          diagnostics: { error_stage: "quota_rpc_failed", stage, status: quotaRes.status },
        }, 500);
      }

      const consumed = asFiniteNumber(parseJsonResponse(quotaRaw));
      if (consumed === null) {
        return json({
          ok: false,
          error: "本日の分析上限に達しました。プランをアップグレードしてください。",
          diagnostics: { error_stage: "daily_limit_reached", stage, dailyLimit },
        }, 400);
      }
      count = consumed;
      quotaConsumed = true;
    }

    // The plans each in-force rule was drawn from, read back for the indicator
    // snapshot the analyst was looking at when it made them. One request for
    // all of them; a rule's footprint is the range those readings span.
    //
    // The ids come out of jsonb written by another function, and they go into
    // a URL — so they are checked against the shape of a uuid first. A book
    // that has been tampered with should fail to produce a footprint, not
    // shape the query.
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    // Twelve rules citing ten plans each stays well inside a URL. The cap is a
    // backstop, and it costs nothing quietly: a citation left out is simply a
    // cited plan the footprint could not read, which the block already counts
    // and reports.
    const MAX_FOOTPRINT_IDS = 120;
    const loadFootprints = async (rules: Rule[]): Promise<Record<string, Footprint> | null> => {
      // Rules are learned across every account, so a rule's citations point at
      // plans this caller does not own. Without the service role the read goes
      // out under the caller's own JWT, and RLS answers with their slice of
      // the evidence: a NARROWER footprint that is indistinguishable from a
      // real one, on a range whose whole job is to say what evidence exists.
      // Refuse rather than narrow — the rules then render as they did before
      // this check existed.
      if (!serviceRoleKey) return null;
      const ids = [...new Set(rules.flatMap((r) => r.supported_by))]
        .filter((id) => UUID_RE.test(id))
        .slice(0, MAX_FOOTPRINT_IDS);
      const byId = new Map<string, ContextLike>();
      if (ids.length > 0) {
        try {
          // shadow=is.false is not belt-and-braces. A shadow row is the plan
          // the analyst would have made under the other contract; it is kept
          // out of the statistics and out of a rule's support on purpose
          // (docs §4.4), and a footprint is a statement about the evidence a
          // rule rests on. Reading a shadow snapshot here would let shadow
          // evidence back in through the situation check while every other
          // door stayed shut. The column is NOT NULL DEFAULT false, so this
          // filter drops nothing else.
          const res = await fetch(
            `${supabaseUrl}/rest/v1/analyses?id=in.(${ids.join(",")})&shadow=is.false&select=id,context`,
            { headers: { Authorization: dbAuthorization, apikey: dbApiKey, "accept-profile": "public" } },
          );
          if (!res.ok) return null;
          const rows = parseJsonResponse(await res.text());
          if (!Array.isArray(rows)) return null;
          for (const row of rows) {
            if (!isRecord(row) || typeof row.id !== "string") continue;
            byId.set(row.id, contextFromStored(row.context));
          }
        } catch (err) {
          // A rule whose evidence cannot be read must not become a rule that
          // claims today's market is different. Returning null renders every
          // rule the way it rendered before this check existed.
          console.warn("Rule footprints unavailable:", err instanceof Error ? err.message : String(err));
          return null;
        }
      }
      const out: Record<string, Footprint> = {};
      for (const rule of rules) {
        const cited = [...new Set(rule.supported_by)];
        const readable = cited
          .map((id) => byId.get(id))
          .filter((ctx): ctx is ContextLike => ctx !== undefined && hasReading(ctx));
        out[rule.id] = footprintOf(readable, cited.length);
      }
      return out;
    };

    // What the analyzer has learned from its own record (see rules.ts). Best
    // effort: an analysis without the rules is still an analysis.
    stage = "load_rulebook";
    let rulebookVersion: number | null = null;
    let learnedRules = "";
    // The rules that fit in the prompt — what the model actually saw
    let rulesShown: string[] = [];
    // In-force rules, kept parsed so they can be RENDERED later, once the
    // indicators exist and today's market can be compared against the
    // situations each rule was learned in. The fetch stays here, early, where
    // it overlaps the rest of the setup; only the rendering waits.
    let inForceRules: Rule[] = [];
    // Per rule id, the measured range of each situation axis across the plans
    // that rule cites. null when the plans could not be read — the rules then
    // render exactly as they did before this check existed, rather than every
    // one of them claiming "cannot compare" on the strength of a failed fetch.
    let footprints: Record<string, Footprint> | null = null;
    try {
      const rulebookRes = await fetch(`${supabaseUrl}/rest/v1/rulebook?id=eq.1&select=version,rules`, {
        headers: {
          Authorization: dbAuthorization,
          apikey: dbApiKey,
          Accept: "application/vnd.pgrst.object+json",
          "accept-profile": "public",
        },
      });
      const rulebookRaw = await rulebookRes.text();
      const rulebook = rulebookRes.ok ? parseJsonResponse(rulebookRaw) : null;
      if (isRecord(rulebook)) {
        const v = asFiniteNumber(rulebook.version);
        rulebookVersion = v === null ? null : Math.round(v);
        // Only the rules the analyst can still act on. A rule written for the
        // previous contract stays in the book but never reaches the prompt.
        inForceRules = inForce(parseRules(rulebook.rules), PLAN_CONTRACT);
        footprints = await loadFootprints(inForceRules);
        // Three distinct states, kept distinct the way the calendar already
        // separates "read and clear" from "could not be read":
        //   null -> the rulebook could not be read at all
        //   0    -> it was read, and nothing in it was in force under this
        //           contract, so the plan saw no rules
        //   n>0  -> version n, and at least one of its rules reached the prompt
        // Recorded on the row below. Without this a plan that saw an empty
        // rulebook lands in version n's cohort and dilutes the very statistic
        // used to judge whether version n helped.
      }
    } catch (err) {
      console.warn("Rulebook unavailable:", err instanceof Error ? err.message : String(err));
    }

    // Scheduled releases the plan has to live through. Free, cached hourly by
    // the econ-calendar function; a plan written an hour before Non-Farm
    // Payrolls with no mention of it is not a plan.
    stage = "load_events";
    let eventBlock = "";
    let eventsAhead: Array<{ at: string; country: string; impact: string; title: string }> = [];
    // "The calendar was read and the horizon is clear" and "the calendar could
    // not be read" are different facts, and an empty block said neither. A
    // plan written 17 hours before Non-Farm Payrolls on a 1h timeframe sees an
    // empty horizon quite legitimately — but it must know that is what it is
    // looking at, or it will treat silence as an all-clear it never got.
    let calendarOk = false;
    try {
      const horizon = HORIZON_MS[interval] ?? 12 * 60 * 60 * 1000;
      const currencies = [...currenciesOf(currencyPair), "All"];
      const until = new Date(Date.now() + horizon).toISOString();
      const eventsRes = await fetch(
        `${supabaseUrl}/rest/v1/econ_events?select=id,event_at,country,title,impact,forecast,previous,all_day,source` +
          `&event_at=gte.${encodeURIComponent(new Date(Date.now() - 60 * 60 * 1000).toISOString())}` +
          `&event_at=lte.${encodeURIComponent(until)}` +
          `&country=in.(${currencies.map(encodeURIComponent).join(",")})` +
          `&impact=in.(High,Medium)&order=event_at.asc&limit=25`,
        { headers: { Authorization: dbAuthorization, apikey: dbApiKey, "accept-profile": "public" } },
      );
      const rows = eventsRes.ok ? parseJsonResponse(await eventsRes.text()) : null;
      if (Array.isArray(rows)) {
        const events = rows.filter(isRecord) as unknown as EconEvent[];
        const upcoming = upcomingFor(events, currencyPair, Date.now(), horizon);
        eventBlock = renderEventBlock(upcoming, Date.now(), locale);
        eventsAhead = upcoming.slice(0, 8).map((e) => ({
          at: e.event_at, country: e.country, impact: e.impact, title: e.title,
        }));
        calendarOk = true;
      }
    } catch (err) {
      console.warn("Calendar unavailable:", err instanceof Error ? err.message : String(err));
    }
    // renderEventBlock returns "" for an empty horizon, so say which of the
    // two silences this is
    if (eventBlock === "") {
      eventBlock = calendarOk
        ? L.calendarClear(Math.round((HORIZON_MS[interval] ?? 12 * 60 * 60 * 1000) / (60 * 60 * 1000)))
        : L.calendarUnavailable;
    }

    stage = "fetch_market_data";
    // Stamped when the fetch resolves. Deliberately NOT the newest candle's
    // datetime: that is the OPEN of a still-forming bar, so on a daily plan it
    // would back-date the fill up to 24 hours into price action that is
    // already known — and its bare "YYYY-MM-DD HH:mm:ss" form is read as
    // local time by V8, which is the reason parseCandleTime exists.
    let pricedAtIso = new Date().toISOString();
    const timeframes = TF_CHAIN[interval];
    // How many rows each timeframe's payload carried before parsing, so
    // seriesHealth can tell "the provider sent little" from "we threw a lot
    // away".
    const rawCounts: number[] = [];
    const fetchSeries = async (tf: string, outputsize: number) => {
      // timezone=UTC: the tracker and the chart both read these timestamps as
      // UTC, and the provider's default zone is not.
      const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(currencyPair)}&interval=${encodeURIComponent(tf)}&outputsize=${outputsize}&timezone=UTC&apikey=${twelveDataKey}`;
      // Without a signal a hung provider burns the whole wall clock and the
      // worker is killed at 150s with no chance to refund the quota. Share the
      // one budget the rest of the function already lives by.
      const res = await fetch(url, { signal: AbortSignal.timeout(Math.max(1_000, WALL_CLOCK_BUDGET_MS - (Date.now() - startedAt))) });
      const raw = await res.text();
      const parsed = parseJsonResponse(raw);
      if (!res.ok || !isRecord(parsed) || parsed.status === "error") {
        const message = isRecord(parsed) ? asTrimmedString(parsed.message, "") : "";
        throw new Error(message || `市場データ取得エラー (${tf}, HTTP ${res.status})`);
      }
      rawCounts.push(Array.isArray(parsed.values) ? parsed.values.length : 0);
      return parseCandles(parsed.values);
    };

    // The plan is priced here and filled by the tracker days later. Those two
    // read different books — every 1h plan settled since the trading-day fix
    // carries price_basis "quotes" — so entry_point came from Twelve Data while
    // the fill came from GMO. Pricing the entry timeframe from the same feed
    // that fills it closes that seam.
    //
    // Deliberately an OVERLAY on an unchanged Twelve Data fetch: that one
    // already-paid request set is the fallback, so a GMO outage costs a label,
    // never an analysis. The two run concurrently, so the marginal cost is only
    // what GMO takes beyond Twelve Data.
    const overlayDeadline = Date.now() + PRICE_OVERLAY_BUDGET_MS;
    const overlayWanted = GMO_ANALYSIS_TIMEFRAMES.has(interval);
    const gmoAttempt = overlayWanted
      ? fetchRecentQuotes(currencyPair, interval, 250, Date.now(), overlayDeadline, async (url) => {
        const left = overlayDeadline - Date.now();
        if (left <= 0) return null;
        const r = await fetch(url, { signal: AbortSignal.timeout(left) });
        return r.ok ? await r.json().catch(() => null) : null;
        // The GMO arm may never reject: it shares a Promise.all with the fetch
        // whose rejection is the real market_data_failed path.
      }).catch(() => null)
      : Promise.resolve(null);

    let seriesByTf: Candle[][];
    let gmoRaw: Awaited<typeof gmoAttempt> = null;
    try {
      // The entry timeframe needs at least 200 closes or sma(closes, 200)
      // silently returns null and SMA200 vanishes from the prompt.
      const [td, gmo] = await Promise.all([
        Promise.all(timeframes.map((tf, i) => fetchSeries(tf, i === 0 ? ENTRY_BARS : HIGHER_BARS))),
        gmoAttempt,
      ]);
      seriesByTf = td;
      gmoRaw = gmo;
    pricedAtIso = new Date().toISOString();
    } catch (err) {
      const raw = err instanceof Error ? err.message : "";
      const message = redactSecrets(raw || "市場データが取得できませんでした");
      const isRateLimit = /credits|run out|limit/i.test(message);
      // A thrown fetch (DNS/TLS/connection) carries the request URL; report it
      // generically rather than forwarding the transport's own text.
      const isTransport = /error sending request|error trying to connect|dns|tcp/i.test(raw);
      console.error("Market data fetch failed:", message);
      return await fail({
        ok: false,
        error: isRateLimit
          ? "市場データAPIの制限に達しました。1分ほど待って再試行してください。"
          : isTransport
            ? "市場データの取得に失敗しました。時間をおいて再試行してください。"
            : `市場データ取得エラー: ${message}`,
        diagnostics: { error_stage: "market_data_failed", stage },
      }, 400);
    }

    // Swapped BEFORE entryCandles binds, on purpose. entryCandles is read again
    // ~600 lines later for the chart the client draws; swapping after it binds
    // would leave the chart on Twelve Data bars while every indicator, the entry
    // marker and entry_point moved to GMO, with nothing raised.
    let priceFeed: "twelve_data" | "gmo" = "twelve_data";
    let feedDeltaAtr: number | null = null;
    let overlayReason: string | null = overlayWanted ? (gmoRaw === null ? "unavailable" : null) : "not_attempted";
    if (gmoRaw) {
      // A snapshot of the Twelve Data series purely to supply the reference the
      // overlay is checked against; the real snapshots are computed below from
      // whichever series wins.
      const reference = computeSnapshot(seriesByTf[0]);
      if (!reference) {
        overlayReason = "no_reference";
      } else {
        const check = acceptOverlay({
          quotes: gmoRaw.bars,
          refPrice: reference.price,
          atr: reference.atr,
          nowMs: Date.now(),
          intervalMs: 60 * 60 * 1000,
        });
        feedDeltaAtr = check.deltaAtr;
        overlayReason = check.reason;
        if (check.ok) {
          seriesByTf = [gmoRaw.bars.map(midCandle), ...seriesByTf.slice(1)];
          priceFeed = "gmo";
        }
      }
    }

    // The two-sided quote behind the mid the plan is written on. Taken from
    // the newest bar of the same GMO series the overlay uses, so it is the
    // same instant the user is looking at; null when that feed was not
    // consulted or had nothing, in which case only the mid is on record.
    // ...from the series the overlay ACCEPTED. When acceptOverlay rejects
    // (stale, gap, too short, or the two feeds disagreeing by more than
    // MARKET_TOLERANCE_ATR) the plan is priced off Twelve Data, and recording
    // GMO's bid/ask beside a Twelve Data mid would produce a "quote" that need
    // not even bracket the price it claims to explain.
    const newestQuote = priceFeed === "gmo" && gmoRaw && gmoRaw.bars.length > 0
      ? gmoRaw.bars[gmoRaw.bars.length - 1]
      : null;
    const decisionQuote = newestQuote
      ? {
        bid: newestQuote.bid.close,
        ask: newestQuote.ask.close,
        at: newestQuote.datetime,
        source: "gmo",
      }
      : null;

    const entryCandles = seriesByTf[0];
    if (entryCandles.length < 60) {
      return await fail({ ok: false, error: "市場データが不足しています", diagnostics: { error_stage: "empty_market_data", stage } }, 400);
    }

    // On a preview, cut the series back to the last time the market traded.
    //
    // Twelve Data keeps emitting bars while the market is shut, and they are
    // flat: the first weekend preview came back with the 1h ATR at 0.041
    // against 0.385-0.421 on the Friday rows of the same pair — a tenth —
    // a Bollinger band 2.1 pips wide, and price, SMA20, SMA50, tenkan and
    // kijun all collapsed onto 156.24. The model read that correctly and
    // called it "an ultra-frozen 1h range", which is a true description of
    // the data and a false one of the market.
    //
    // ATR is the unit this whole app measures in — stop distances, structure
    // tolerances, the room to the next level, the situation axes — so an ATR
    // ten times too small makes every distance look ten times further.
    //
    // The NARROW predicate, on purpose: `isMarketClosed` answers "may I throw
    // this bar away?", is deliberately conservative about doing so, and is
    // already what track-outcomes uses to drop the same bars. The two now
    // agree on what a bar is.
    //
    // Trailing only. The series is ascending, so this removes the tail and
    // introduces no gap; bars from EARLIER weekends are left exactly as a
    // weekday run would see them. That contamination is real and older than
    // this change, and it is measured separately rather than fixed blind here.
    if (previewMode) {
      seriesByTf = seriesByTf.map((candles, i) => {
        const dropped = closedTail(candles.map((c) =>
          Date.parse(c.datetime.includes("T") ? c.datetime : `${c.datetime.replace(" ", "T")}Z`)
        ));
        const end = candles.length - dropped;
        if (dropped > 0) {
          // Taken off the raw count too. These bars were not lost to a broken
          // feed, so they must not count towards the "too much dropped" issue
          // that exists to catch one.
          rawCounts[i] = Math.max(0, (rawCounts[i] ?? candles.length) - dropped);
          console.log("Preview trimmed closed-market bars", { tf: timeframes[i], dropped, kept: end });
        }
        return end === candles.length ? candles : candles.slice(0, end);
      });
    }

    // Whether the series are fit to analyse. parseCandles now drops a bar it
    // cannot believe — a null priced at zero, a high under its own low — but
    // dropping is only half the job: a series full of holes must not be
    // analysed at all, because every indicator downstream would be computed on
    // fiction and the plan resting on it would enter the record as a real
    // trade.
    // Staleness is measured against the last time the market TRADED, not
    // against the wall clock. On a weekend the newest bar is Friday's close by
    // definition, which against "now" reads as a feed three thousand minutes
    // behind — and the entry series would be rejected as unfit, so the preview
    // this build exists to allow would 502 before computing anything. It is
    // the same distinction market-hours.ts already draws: an absence of bars
    // while the market is shut is not evidence that anything failed.
    const staleFrom = previewMode ? lastClose(Date.now()) : Date.now();
    const health = seriesByTf.map((candles, i) =>
      seriesHealth(
        candles,
        rawCounts[i] ?? candles.length,
        i === 0 ? 60 : 2,
        INTERVAL_MS[timeframes[i]] ?? 0,
        Date.now(),
        3,
        staleFrom,
      )
    );
    if (!health[0].ok) {
      console.error("Entry series unfit", { pair: currencyPair, tf: timeframes[0], issues: health[0].issues });
      return await fail({
        ok: false,
        error: "市場データが不正です。しばらくしてからお試しください",
        diagnostics: { error_stage: "market_data_unhealthy", stage, issues: health[0].issues },
      }, 502);
    }
    // A higher timeframe in poor shape is not fatal — the entry timeframe is
    // what the plan is written on — but it is said out loud rather than
    // quietly analysed.
    const degraded = health.slice(1)
      .map((h, i) => (h.ok ? null : `${timeframes[i + 1]}:${h.issues.join("/")}`))
      .filter((v): v is string => v !== null);
    if (degraded.length > 0) console.warn("Higher timeframe series degraded", { pair: currencyPair, degraded });

    console.log("Market data fetched", {
      elapsedMs: Date.now() - startedAt,
      priceFeed,
      overlayReason,
      feedDeltaAtr,
      gmoRequests: gmoRaw?.requests ?? 0,
      gmoKeys: gmoRaw?.keys ?? 0,
    });

    stage = "compute_indicators";
    const snapshotNow = Date.now();
    const snapshots = seriesByTf.map((candles, i) =>
      computeSnapshot(candles, INTERVAL_MS[timeframes[i]] ?? 0, snapshotNow)
    );
    // The same reading with the newest bar removed. A higher-timeframe
    // breakout that is true mid-bar can be gone by the close, so the plan has
    // to be able to say which of the two it is looking at — and the record has
    // to keep both, or the judgement cannot be reproduced afterwards.
    const closedSnapshots = seriesByTf.map((candles, i) => {
      const s = snapshots[i];
      if (!s || s.barClosed !== false) return null;
      return computeSnapshot(candles.slice(0, -1), INTERVAL_MS[timeframes[i]] ?? 0, snapshotNow);
    });
    const entrySnapshot = snapshots[0];
    if (!entrySnapshot) {
      return await fail({ ok: false, error: "指標計算に失敗しました", diagnostics: { error_stage: "indicator_failed", stage } }, 500);
    }

    stage = "build_prompt";
    // The reading the model is about to be given, in the exact shape it will
    // be stored in on the plan below. Rendered once, here, and used twice: to
    // compare today's market against the situations each learned rule was
    // drawn from, and as the record of what the model was looking at. Two
    // renderings would be two shapes, and a rule's footprint is measured from
    // stored rows — so the drift would not show up as a bug, it would show up
    // as a rule quietly matching the wrong markets.
    const roundTo = (v: number | null, d: number) => (v === null || !Number.isFinite(v) ? null : Number(v.toFixed(d)));
    const compactSnapshot = (tf: string, s: IndicatorSnapshot | null) =>
      s === null
        ? { tf, unavailable: true }
        : {
          tf,
          datetime: s.datetime,
          price: roundTo(s.price, decimals),
          change_pct: roundTo(s.changePct, 2),
          rsi: roundTo(s.rsi, 1),
          adx: roundTo(s.adx, 1),
          atr: roundTo(s.atr, decimals),
          atr_pct: roundTo(s.atrPct, 3),
          macd_hist: roundTo(s.macdHist, 5),
          sma20: roundTo(s.sma20, decimals),
          sma50: roundTo(s.sma50, decimals),
          sma200: roundTo(s.sma200, decimals),
          bb_upper: roundTo(s.bbUpper, decimals),
          bb_lower: roundTo(s.bbLower, decimals),
          tenkan: roundTo(s.tenkan, decimals),
          kijun: roundTo(s.kijun, decimals),
          span_a: roundTo(s.spanA, decimals),
          span_b: roundTo(s.spanB, decimals),
          slow_k: roundTo(s.slowK, 1),
          slow_d: roundTo(s.slowD, 1),
          swing_highs: s.swingHighs.map((v) => roundTo(v, decimals)),
          swing_lows: s.swingLows.map((v) => roundTo(v, decimals)),
        };
    const entryContext = {
      entry: compactSnapshot(timeframes[0], snapshots[0]),
      higher: snapshots.slice(1).map((s, i) => compactSnapshot(timeframes[i + 1], s)),
    };

    // A pip, for expressing distances in the unit the plan is read in. The
    // other half of every distance is the ATR, because that is the unit the
    // stop rules are written in.
    const pipSize = decimals === 3 ? 0.01 : 0.0001;
    // Structure is computed on CLOSED bars only: a forming bar's close is not
    // a close, and every break here is decided on a close. Computed on
    // seriesByTf, which is the series AFTER the GMO overlay swap — the same
    // array the indicators read, so the structure and the indicators can
    // never describe two different feeds.
    const structures = seriesByTf.map((candles, i) => {
      const bars = snapshots[i]?.barClosed === false ? candles.slice(0, -1) : candles;
      // ATR over the SAME bars the structure is measured on. Reading it off
      // the untrimmed series scaled every tolerance by the true range of a
      // bar seconds old — near zero — so a Wilder ATR14 came out about 7%
      // low and every threshold tightened by that much, on a block that says
      // it was computed on closed bars.
      const closedAtr = atr(bars);
      return {
        bars,
        structure: computeStructure(bars, closedAtr, pipSize, entrySnapshot.price),
      };
    });
    // Divergence on the entry timeframe only. A disagreement between two
    // pivots three months apart on the 1day is not something a 15-minute plan
    // acts on, and rendering it on every timeframe would pay three times to
    // say one thing.
    const entryDivergence: Divergence | null = (() => {
      const { bars } = structures[0];
      if (bars.length < 40) return null;
      return detectDivergence(
        bars,
        rsiSeries(bars.map((c) => c.close)),
        pivots(bars),
        atr(bars),
      );
    })();

    const tfSections = timeframes.map((tf, i) => {
      const snapshot = snapshots[i];
      const candles = seriesByTf[i];
      const closed = closedSnapshots[i];
      const body = snapshot ? snapshotLines(snapshot, decimals) : "指標計算に必要な本数が不足";
      // When the newest bar is still forming, the same reading without it is
      // given alongside, so "the trend on closed bars" and "what is happening
      // right now" are two labelled things rather than one blurred one.
      const closedBody = closed
        ? `\n[確定足のみ(形成中の足を除く)]\n${snapshotLines(closed, decimals)}`
        : "";
      const lines = candleLines(candles, i === 0 ? 40 : 20);
      const feedLabel = i === 0 && priceFeed === "gmo" ? "GMO Coin 仲値" : "Twelve Data 仲値";
      const structure = `\n${structureLines(structures[i].structure, i === 0 ? entryDivergence : null, decimals, i === 0)}`;
      return `### ${tf}${i === 0 ? `（エントリー時間足・${feedLabel}）` : `（上位足・${feedLabel}）`}\n${body}${closedBody}${structure}\n直近ローソク足 (datetime[UTC],open,high,low,close / 古い順):\n${lines}`;
    }).join("\n\n");

    const nowUtc = new Date().toISOString();
    const SEARCH_NOTE = L.searchNote;
    const TECHNICAL_NOTE = L.technicalNote;
    const FALLBACK_NOTE = L.fallbackNote;

    // Structured outputs cannot be combined with web search, so the search path
    // has to carry the same field contract in the prompt instead. Reusing the
    // one RESPONSE_SCHEMA keeps both paths on a single definition.
    const SCHEMA_INSTRUCTION = L.schemaInstruction(JSON.stringify(RESPONSE_SCHEMA));

    const buildUserMessage = (note: string, schemaInPrompt: boolean) =>
      L.userMessage({
        pair: currencyPair,
        nowUtc,
        note,
        sections: tfSections,
        schema: schemaInPrompt ? SCHEMA_INSTRUCTION : "",
      });

    stage = "request_ai";
    // Supabase kills the worker at 150s wall clock with no chance to respond —
    // the client just sees a bare 546 and the spent credit is never refunded.
    // Stop a few seconds short of that so a slow turn returns a real error and
    // hands the credit back.
    const elapsed = () => Date.now() - startedAt;
    const msLeft = () => WALL_CLOCK_BUDGET_MS - elapsed();

    // Opus 5 runs adaptive thinking at effort "high" by default, which is the
    // dominant cost in a turn. The technical path is fast and can afford
    // "medium"; the searching path also pays for page fetches, so it runs at
    // "low" to leave room for them.
    const EFFORT_TECHNICAL = "medium";
    const EFFORT_SEARCH = "low";

    // Which of the learned rules the market in front of us actually looks
    // like. Measured, not asserted: each rule's citations carry the reading
    // the analyst had when it made them, and this compares today against that
    // range (see situation.ts). Rules that fit are shown first; rules measured
    // as belonging to another market are shown last and cut first when the
    // budget bites, with the cut named in the block.
    //
    // Deferred to here rather than done beside the rulebook fetch because the
    // comparison needs the indicators, and the indicators are computed after
    // the prices arrive.
    const ruleFits: Record<string, RuleSituation> | null = footprints === null
      ? null
      : Object.fromEntries(
        Object.entries(footprints).map(([id, print]) => [id, situationFor(print, entryContext)]),
      );
    const shownRules = selectPromptRules(
      inForceRules,
      locale,
      PLAN_CONTRACT,
      MAX_PROMPT_RULES,
      promptCharBudget(locale),
      ruleFits,
    );
    learnedRules = shownRules.text;
    rulesShown = shownRules.ids;
    // Enough to reconstruct the comparison from the row: the verdict per rule,
    // which axes could be compared, which of them today fell outside, and how
    // much of each rule's cited evidence the footprint could actually read.
    const ruleFitRecord = ruleFits === null ? null : {
      shown: shownRules.ids,
      held_back: shownRules.heldBack,
      rules: Object.fromEntries(
        Object.entries(ruleFits).map(([id, fit]) => [id, {
          fit: fit.fit,
          comparable: fit.comparable,
          missed: fit.missed,
          cases: fit.cases,
          cited: fit.cited,
        }]),
      ),
    };

    const anthropicHeaders = {
      "content-type": "application/json",
      "x-api-key": anthropicKey,
      "anthropic-version": "2023-06-01",
    };

    const userMessageText = includeFundamental
      ? buildUserMessage(SEARCH_NOTE, true)
      : buildUserMessage(TECHNICAL_NOTE, false);

    const baseRequest: JsonRecord = {
      model: "claude-opus-5",
      max_tokens: 8000,
      system: SYSTEM_PROMPT
        .replace("{{LANGUAGE_RULE}}", L.languageRule)
        .replace("{{EVENTS}}", eventBlock)
        .replace("{{LEARNED_RULES}}", learnedRules)
        .trimEnd(),
      messages: [{ role: "user", content: userMessageText }],
    };

    // Web search responses carry citations, which are incompatible with
    // output_config.format — so the search path parses JSON out of the text
    // while the technical path uses structured outputs.
    let searchDomains = includeFundamental ? [...NEWS_DOMAINS] : [];
    let searchEnabled = includeFundamental && searchDomains.length > 0;
    // Set when search was requested but had to be given up; the client shows a
    // different badge for it rather than silently passing off a technical-only
    // read as the full analysis the user asked for.
    let searchDroppedReason: string | null = null;
    let pruneRetries = 0;
    // `effort` is a plain request option, but this deployment cannot verify
    // that against the live API before shipping. If it is ever rejected, drop
    // it and retry rather than failing the analysis over a latency hint.
    let effortEnabled = true;

    const applyRequestShape = () => {
      if (searchEnabled) {
        baseRequest.tools = [{
          type: "web_search_20260209",
          name: "web_search",
          max_uses: 1,
          allowed_domains: searchDomains,
        }];
        // Only `format` is incompatible with web search (citations); `effort`
        // applies to both shapes.
        if (effortEnabled) baseRequest.output_config = { effort: EFFORT_SEARCH };
        else delete baseRequest.output_config;
      } else {
        delete baseRequest.tools;
        baseRequest.output_config = effortEnabled
          ? { format: { type: "json_schema", schema: RESPONSE_SCHEMA }, effort: EFFORT_TECHNICAL }
          : { format: { type: "json_schema", schema: RESPONSE_SCHEMA } };
      }
    };
    applyRequestShape();

    if (includeFundamental && !searchEnabled) {
      searchDroppedReason = "no_allowed_domains";
    }

    // Server tools may pause long turns (stop_reason "pause_turn"); continue
    // the same turn by echoing the assistant content back. The same bounded
    // loop also re-runs the request after pruning an uncrawlable domain, so
    // the ceiling covers both kinds of continuation.
    let messages = [...(baseRequest.messages as JsonRecord[])];
    let claudeData: JsonRecord | null = null;

    const outOfTime = async () => {
      console.error("Analysis exceeded the wall-clock budget", { elapsedMs: Date.now() - startedAt });
      return await fail({
        ok: false,
        error: "分析に時間がかかりすぎたため中断しました。「経済ニュース・指標も考慮する」をOFFにするか、時間をおいて再試行してください。",
        diagnostics: { error_stage: "wall_clock_exceeded", stage, elapsedMs: Date.now() - startedAt },
      }, 504);
    };

    // Abandoning web search when it runs long, then answering on the technicals
    // alone. Same end state as an uncrawlable allowlist, so it reuses that path
    // and is reported to the user the same way.
    const giveUpSearch = (reason: string) => {
      console.warn("Dropping web search to stay inside the budget", {
        reason,
        elapsedMs: Date.now() - startedAt,
      });
      searchEnabled = false;
      searchDroppedReason = reason;
      messages = [{ role: "user", content: buildUserMessage(FALLBACK_NOTE, false) }];
      applyRequestShape();
    };

    for (let attempt = 0; attempt < 5; attempt++) {
      if (msLeft() <= 0) return await outOfTime();

      const plan = planAttempt(elapsed(), searchEnabled);
      if (plan.action === "out_of_time") return await outOfTime();
      // Searching has run past its share of the budget; answer without it.
      if (plan.action === "drop_search") giveUpSearch("search_too_slow");

      let claudeRes: Response;
      try {
        claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: anthropicHeaders,
          body: JSON.stringify({ ...baseRequest, messages }),
          signal: AbortSignal.timeout(plan.timeoutMs),
        });
      } catch (err) {
        // AbortSignal.timeout rejects with TimeoutError; anything else is a
        // transport failure and is reported the same way to the client.
        const timedOut = err instanceof DOMException && err.name === "TimeoutError";
        if (timedOut && canRetryWithoutSearch(elapsed(), searchEnabled)) {
          // The searching turn ran long but there is still time to answer on
          // the technicals — do that rather than returning nothing.
          giveUpSearch("search_too_slow");
          continue;
        }
        if (timedOut || msLeft() <= 0) {
          return await outOfTime();
        }
        throw err;
      }

      const claudeRaw = await claudeRes.text();
      const parsed = parseJsonResponse(claudeRaw);

      if (!claudeRes.ok) {
        const errorMessage = isRecord(parsed) && isRecord(parsed.error)
          ? asTrimmedString(parsed.error.message, "AI分析エラー")
          : "AI分析エラー";
        console.error("Claude API error:", claudeRes.status, claudeRaw.slice(0, 500));

        // The API validates allowed_domains up front and rejects the whole
        // request when a listed site blocks Anthropic's crawler — which sites
        // do that changes without notice. Drop the ones it named and retry;
        // give up search entirely rather than fail the analysis.
        if (searchEnabled && isInaccessibleDomainError(errorMessage)) {
          const blocked = parseInaccessibleDomains(errorMessage);
          console.warn("Web search domains rejected as uncrawlable:", blocked.join(", "));

          const recovery = planDomainRecovery(searchDomains, blocked, pruneRetries);
          if (recovery.action === "retry") {
            searchDomains = recovery.domains;
            pruneRetries++;
            applyRequestShape();
          } else {
            giveUpSearch("uncrawlable_domains");
          }
          continue;
        }

        if (effortEnabled && /output_config|effort/i.test(errorMessage)) {
          console.warn("output_config.effort rejected; retrying without it:", errorMessage.slice(0, 200));
          effortEnabled = false;
          applyRequestShape();
          continue;
        }

        return await fail({
          ok: false,
          // Anthropic's own text is English and written for developers; keep it
          // in diagnostics and show the user something actionable instead.
          error: "AI分析エラーが発生しました。時間をおいて再試行してください。",
          diagnostics: { error_stage: "anthropic_request_failed", stage, status: claudeRes.status, detail: errorMessage.slice(0, 300), preview: claudeRaw.slice(0, 300) },
        }, 400);
      }

      if (!isRecord(parsed)) {
        return await fail({
          ok: false,
          error: "AI分析エラー: レスポンス形式が不正です",
          diagnostics: { error_stage: "unexpected_anthropic_response", stage },
        }, 400);
      }

      if (parsed.stop_reason === "pause_turn" && Array.isArray(parsed.content)) {
        messages.push({ role: "assistant", content: parsed.content });
        continue;
      }

      claudeData = parsed;
      break;
    }

    if (!claudeData) {
      return await fail({
        ok: false,
        error: "AI分析が完了しませんでした。もう一度お試しください。",
        diagnostics: { error_stage: "anthropic_pause_loop", stage },
      }, 400);
    }

    console.log("Model turn complete", {
      elapsedMs: Date.now() - startedAt,
      searchDroppedReason,
      pruneRetries,
    });

    stage = "parse_ai_json";
    const finalText = extractAnthropicText(claudeData);
    const parsedAnalysis = parseAnalysisJson(finalText);

    if (!isRecord(parsedAnalysis)) {
      return await fail({
        ok: false,
        error: "AI分析結果の解析に失敗しました",
        diagnostics: { error_stage: "analysis_parse_failed", stage, preview: finalText.slice(0, 300) },
      }, 400);
    }

    const normalizedAnalysis = normalizeAnalysis(parsedAnalysis, decimals, locale);

    // A plan whose entry the market never reaches is worth less than a wrong
    // one: it teaches nothing and it inflates the record with trades that
    // never happened. Refuse it here rather than publishing it, and keep the
    // refusal so the rate can be measured.
    stage = "check_entry";
    const detail = normalizedAnalysis.market_context_detail;
    const proposedSignal = normalizedAnalysis.signal;

    // THE ENTRY IS THE MARKET PRICE, and it is rounded ONCE, here, before
    // anything reads it.
    //
    // The gate used to be handed the unrounded float while the row stored the
    // rounded one, so a plan could be certified at RR 1.2006 and judged at
    // 1.1975 — and the post-mortem's replay of the gate would then report that
    // the gate would not publish a plan the gate had published. One constant,
    // five readers: the gate, the prompt, entry_point, price_at_signal and
    // entry_check.price.
    //
    // Mid, not bid or ask. Every level the model reasoned with — the SMAs, the
    // bands, the ATR, the swings, all forty candles — is a mid. Quoting the
    // entry on the ask while the stop stays mid-derived would measure risk and
    // reward on two different rulers, and those two numbers are the whole gate
    // now. The spread is charged exactly once, at judgement.
    const marketEntry = Number(entrySnapshot.price.toFixed(decimals));
    normalizedAnalysis.entry_point_num = marketEntry;
    normalizedAnalysis.entry_point = marketEntry.toFixed(decimals);
    normalizedAnalysis.entry_type = "market";

    // The second and third targets were parsed, stored, drawn on the chart and
    // shown to the user in profit-green without anything ever checking which
    // side of the entry they were on. A BUY at 150.000 could be published with
    // targets at 149.500 and 149.000 — two prices reachable only by the trade
    // losing. The judge ignores them (targetsReached filters anything not
    // beyond TP1), so this was purely a lie told to the reader.
    //
    // Dropped rather than fatal: the leg that decides win or loss is
    // entry/stop/TP1, and that IS checked. A plan sound on that leg is still a
    // plan; the extra targets are garnish, and garnish that points the wrong
    // way is removed and recorded rather than allowed to sink the dish.
    const ladderDropped: string[] = [];
    {
      const dir = proposedSignal === "BUY" ? 1 : -1;
      let bound = normalizedAnalysis.take_profit_1_num;
      const rungs = [
        {
          name: "take_profit_2",
          value: normalizedAnalysis.take_profit_2_num,
          clear: () => {
            normalizedAnalysis.take_profit_2_num = null;
            normalizedAnalysis.take_profit_2 = "—";
          },
        },
        {
          name: "take_profit_3",
          value: normalizedAnalysis.take_profit_3_num,
          clear: () => {
            normalizedAnalysis.take_profit_3_num = null;
            normalizedAnalysis.take_profit_3 = "—";
          },
        },
      ];
      for (const rung of rungs) {
        if (rung.value === null) continue;
        const beyondEntry = (rung.value - marketEntry) * dir > 0;
        const beyondPrevious = bound === null || (rung.value - bound) * dir > 0;
        if (beyondEntry && beyondPrevious) {
          bound = rung.value;
          continue;
        }
        ladderDropped.push(rung.name);
        rung.clear();
      }
      if (ladderDropped.length > 0) {
        console.warn("Take-profit ladder out of order", {
          signal: proposedSignal,
          entry: marketEntry,
          dropped: ladderDropped,
        });
      }
    }

    const proposed = {
      entry: marketEntry,
      stop: normalizedAnalysis.stop_loss_num,
      tp1: normalizedAnalysis.take_profit_1_num,
      tp2: normalizedAnalysis.take_profit_2_num,
      tp3: normalizedAnalysis.take_profit_3_num,
    };
    const entryVerdict: EntryVerdict = evaluateEntry({
      signal: proposedSignal,
      entry: marketEntry,
      stopLoss: proposed.stop,
      takeProfit1: proposed.tp1,
      price: marketEntry,
      atr: entrySnapshot.atr,
      mode: detail && typeof detail.mode === "string" ? detail.mode : null,
      direction: detail && typeof detail.direction === "string" ? detail.direction : null,
      indicators: { adx: entrySnapshot.adx, sma20: entrySnapshot.sma20, sma50: entrySnapshot.sma50 },
    });

    // "Enter now at the market" is not an available action when the market is
    // shut. Without this a plan written on a Friday evening is judged by
    // filling at the Sunday reopen, across the weekend gap — which can be
    // written up as a large win that nobody could have taken.
    // The WIDE predicate, deliberately. isMarketClosed names only the hours
    // that are shut under every daylight-saving rule — right for deciding
    // whether to discard a bar, wrong here. Refusing to publish is the
    // conservative act: if the market MIGHT be shut there is no reliable "now"
    // to enter at, and publishing anyway is what lets a weekend gap be written
    // up as a trade nobody could have taken. The narrow one left a one-hour
    // hole every week.
    const marketShut = isPossiblyClosed(Date.now());

    // The prompt has always said "below 60 confidence the answer is WAIT", and
    // nothing enforced it: a BUY the model itself rated 10/100 was published
    // exactly like one it rated 95, and entered the record as a settled trade
    // rather than as the WAIT the stated policy calls for. Enforced here, on
    // the same path as the other refusals, so the plan becomes a WAIT row that
    // the wait scorer grades and the credit is handed back.
    const lowConfidence = normalizedAnalysis.confidence < MIN_CONFIDENCE;

    let entryRejected = false;
    let rejectionReason: string | null = null;
    if (marketShut || lowConfidence || (!entryVerdict.ok && entryVerdict.rejection)) {
      entryRejected = true;
      rejectionReason = marketShut
        ? "market_closed"
        : lowConfidence
        ? "low_confidence"
        : (entryVerdict.rejection ?? "unknown");
      console.warn("Entry rejected", {
        rejection: rejectionReason,
        proposedSignal,
        stopAtr: entryVerdict.stopAtr,
        riskReward: entryVerdict.riskReward,
        regime: entryVerdict.regime,
      });
      normalizedAnalysis.warnings = [
        marketShut ? L.marketClosed : L.entryRejected({
          rejection: rejectionReason,
          signal: proposedSignal,
          distanceAtr: entryVerdict.distanceAtr,
          stopAtr: entryVerdict.stopAtr,
          riskReward: entryVerdict.riskReward,
          repairRejection: entryVerdict.repairRejection,
        }),
        ...normalizedAnalysis.warnings,
      ];
      normalizedAnalysis.signal = "WAIT";
      // A WAIT that still carries an entry, a stop and targets reads as a
      // trade. The refused levels live on in entry_check and the shadow row.
      normalizedAnalysis.entry_point = "—";
      normalizedAnalysis.stop_loss = "—";
      normalizedAnalysis.take_profit_1 = "—";
      normalizedAnalysis.take_profit_2 = "—";
      normalizedAnalysis.take_profit_3 = "—";
      normalizedAnalysis.risk_reward_ratio = "—";
      normalizedAnalysis.entry_point_num = null;
      normalizedAnalysis.stop_loss_num = null;
      normalizedAnalysis.take_profit_1_num = null;
      normalizedAnalysis.take_profit_2_num = null;
      normalizedAnalysis.take_profit_3_num = null;
      // The user asked for a plan and the gate took it away; that is not a
      // credit spent
      await releaseQuota();
    } else if (entryVerdict.riskReward !== null) {
      // The published ratio is the one measured at the price that will be
      // filled, not whatever the model wrote in prose
      normalizedAnalysis.risk_reward_ratio = `1:${entryVerdict.riskReward}`;
    }

    const entryCheck = {
      proposed_signal: proposedSignal,
      proposed_entry: proposed.entry,
      proposed_stop: proposed.stop,
      proposed_tp1: proposed.tp1,
      // The model's own confidence, and whether the floor is what refused the
      // plan. Recorded on the row so the rate of low-confidence calls is
      // measurable rather than inferred from a rejection string.
      confidence: normalizedAnalysis.confidence,
      confidence_floor: MIN_CONFIDENCE,
      // Targets removed for pointing the wrong way. Empty on a sound plan; a
      // rising count is evidence the model's output is degrading, which is
      // exactly the kind of thing that otherwise goes unnoticed.
      tp_ladder_dropped: ladderDropped,
      // Which bar each timeframe's reading came from, and whether it had
      // closed. Two runs a minute apart can see different trends off the same
      // unclosed bar; without this the difference is invisible afterwards.
      bars: timeframes.map((tf, i) => ({
        tf,
        bars: seriesByTf[i]?.length ?? 0,
        newest: snapshots[i]?.datetime ?? null,
        closed: snapshots[i]?.barClosed ?? null,
      })),
      // Under market_v1 the model declares no order type — the server sets
      // the entry — so what is worth recording is the contract itself.
      contract: PLAN_CONTRACT,
      // The plan's geometry, recorded on every row so the floors can be
      // calibrated from what actually happened rather than guessed.
      //
      // Measured over the first eight plans: the stop sat between 0.72 and
      // 1.03 ATR (mean 0.86) while the median plan resolved in about six
      // bars — over which price wanders roughly sqrt(6) ~ 2.4 ATR. So the
      // stop was at about a third of the distance price was expected to
      // travel before the trade ended. That is a strong argument for a floor
      // scaled to the HOLDING PERIOD rather than to one bar, and it is
      // deliberately NOT imposed yet: eight plans is not enough to move a
      // threshold on, and swinging from too permissive to nothing-passes
      // would be the same overfitting in the other direction. Recorded now,
      // decided when there is something to decide it with.
      tp1_atr: entrySnapshot.atr && proposed.tp1 !== null
        ? Number((Math.abs(proposed.tp1 - marketEntry) / entrySnapshot.atr).toFixed(2))
        : null,
      declared_mode: detail && typeof detail.mode === "string" ? detail.mode : null,
      declared_direction: detail && typeof detail.direction === "string" ? detail.direction : null,
      priced_at: pricedAtIso,
      entry_type: entryVerdict.entryType,
      regime: entryVerdict.regime,
      regime_direction: entryVerdict.regimeDirection,
      momentum: entryVerdict.momentum,
      distance_atr: entryVerdict.distanceAtr,
      stop_atr: entryVerdict.stopAtr,
      risk_reward: entryVerdict.riskReward,
      // The reason actually acted on, not just the shape gate's opinion. A
      // market_closed refusal used to be logged and dropped, leaving the row
      // identical to a plan the model itself declined — so the server's own
      // refusals were invisible, and the WAIT scorer graded them as the
      // analyst's judgement.
      rejection: entryRejected ? rejectionReason : entryVerdict.rejection,
      repair_rejection: entryVerdict.repairRejection,
      atr: Number.isFinite(entrySnapshot.atr as number) ? entrySnapshot.atr : null,
      // marketEntry, not entrySnapshot.price: entry_point, price_at_signal
      // and the gate all use the rounded constant, and this field is read
      // beside them.
      price: marketEntry,
      // Which book priced this plan, and how far outside that book's newest
      // bar our reference sat. Read by the post-mortem record stats.
      price_feed: priceFeed,
      feed_delta_atr: feedDeltaAtr,
    };

    // What the row is standing aside FROM, decided here rather than
    // reconstructed later from what the market did. Every input is on this
    // page and none of them can see forward: the model's own signal, the
    // direction it declared while declining to trade, the regime the
    // indicators read, the entry the gate approved, and the ATR that sized
    // it. Built for BUY and SELL too — a plan the server refuses becomes a
    // WAIT below, and the refused direction is exactly what a WAIT of that
    // kind should be graded against.
    const waitPlan: WaitPlan = waitPlanFor({
      proposedSignal,
      declaredDirection: detail && typeof detail.direction === "string" ? detail.direction : null,
      regime: entryVerdict.regime,
      regimeDirection: entryVerdict.regimeDirection,
      entry: marketEntry,
      atr: Number.isFinite(entrySnapshot.atr as number) ? entrySnapshot.atr : null,
      quote: decisionQuote,
      decimals,
      contract: PLAN_CONTRACT,
      decidedAt: pricedAtIso,
    });

    // The same direction on the same pair already open from an earlier plan:
    // another one is the same bet again, not a new one, and the record would
    // count it as an independent sample. Said on the plan, and kept with it.
    stage = "check_open_plans";
    let openSameDirection = 0;
    if (serviceRoleKey && (normalizedAnalysis.signal === "BUY" || normalizedAnalysis.signal === "SELL")) {
      try {
        const sinceIso = new Date(Date.now() - OPEN_PLAN_WINDOW_HOURS * 60 * 60 * 1000).toISOString();
        const openRes = await fetch(
          `${supabaseUrl}/rest/v1/analyses?select=id&user_id=eq.${encodeURIComponent(user.id)}&pair=eq.${encodeURIComponent(currencyPair)}&signal=eq.${normalizedAnalysis.signal}&outcome=eq.pending&shadow=is.false&created_at=gte.${encodeURIComponent(sinceIso)}&limit=10`,
          { headers: { Authorization: dbAuthorization, apikey: dbApiKey, "accept-profile": "public" } },
        );
        const openRows = openRes.ok ? parseJsonResponse(await openRes.text()) : null;
        openSameDirection = Array.isArray(openRows) ? openRows.length : 0;
        if (openSameDirection > 0) {
          normalizedAnalysis.warnings = [
            L.openSameDirection({ count: openSameDirection, signal: normalizedAnalysis.signal, hours: OPEN_PLAN_WINDOW_HOURS }),
            ...normalizedAnalysis.warnings,
          ];
        }
      } catch (err) {
        console.warn("Open plan check unavailable:", err instanceof Error ? err.message : String(err));
      }
    }

    // What the model was looking at, kept with the plan so a post-mortem can
    // tell a misread market from a wrong call. The snapshots were rendered
    // before the prompt was built (see `entryContext` above) — the same
    // objects, not a second rendering of them, because these rows are what a
    // rule's situation footprint is later measured from and a shape that
    // differs between the writing and the reading would make the footprint
    // describe a market nobody analysed.
    const context = {
      open_same_direction: openSameDirection,
      rules_shown: rulesShown,
      // The version that was READ, kept beside the version that was USED, so
      // "the book was there and empty for me" stays distinguishable from "the
      // book could not be read" after the fact.
      rulebook_version_read: rulebookVersion,
      events_ahead: eventsAhead,
      timeframes,
      entry: entryContext.entry,
      higher: entryContext.higher,
      // Which rules were compared against today's market, and how it came out.
      // Kept whole: "the plan was shown r4 and r10" and "the plan was shown
      // r4 and r10, and r10 had been measured as belonging to another market"
      // are different prompts, and only this tells them apart afterwards.
      rule_fit: ruleFitRecord,
    };

    // The user asked for news to be factored in and it could not be; say so in
    // the result rather than passing a technical-only read off as full analysis.
    const resolvedMode = !includeFundamental
      ? "technical_only"
      : searchDroppedReason
        ? "technical_fallback"
        : "full";

    if (resolvedMode === "technical_fallback") {
      normalizedAnalysis.warnings = [L.fallbackWarning, ...normalizedAnalysis.warnings];
    }

    // History row for the win/loss tracker. Only BUY/SELL plans with prices
    // can be evaluated later; WAIT rows are stored for the record as skipped.
    stage = "save_history";
    if (serviceRoleKey) {
      const trackable = normalizedAnalysis.signal !== "WAIT" &&
        normalizedAnalysis.entry_point_num !== null &&
        normalizedAnalysis.stop_loss_num !== null &&
        normalizedAnalysis.take_profit_1_num !== null;
      const historyHeaders = {
        Authorization: dbAuthorization,
        apikey: dbApiKey,
        "Content-Type": "application/json",
        "content-profile": "public",
      };
      // The same rounded constant the gate approved and the row stores as the
      // entry. Storing the raw float here and the rounded one there is what
      // let a plan be certified at one risk/reward and judged at another.
      const priceAtSignal = Number.isFinite(marketEntry) ? marketEntry : null;
      // What was actually sent to the model. The prompt's market content is
      // mostly candle blocks, and the event block's forecast/previous are
      // overwritten in econ_events as the week runs, so neither can be rebuilt
      // from parts later. A plan that cannot be replayed cannot be compared
      // against a different rulebook on its own snapshot.
      // Read back from `messages`, not from the string first built:
      // giveUpSearch() replaces the user turn wholesale when search is
      // abandoned, so a row whose mode is technical_fallback would otherwise
      // carry the full-search prompt and replay a different turn than the one
      // that produced the plan.
      const sentTurn = messages[0];
      const sentUserText = isRecord(sentTurn) && typeof sentTurn.content === "string"
        ? sentTurn.content
        : userMessageText;
      const promptRecord = {
        system: typeof baseRequest.system === "string" ? baseRequest.system : null,
        user: sentUserText,
        model: typeof baseRequest.model === "string" ? baseRequest.model : null,
        at: pricedAtIso,
      };
      // The two-sided quote behind the mid the user was shown. Execution is
      // one-sided, so an honest fill starts here, not at price_at_signal.
      const quoteAtSignal = decisionQuote;
      // The retry below re-POSTs this body, and a timeout or a dropped socket
      // can lose the response after the INSERT has committed. Owning the id
      // makes attempt N+1 land on the row attempt N wrote instead of creating
      // a second, independent plan — which the tracker would settle twice, the
      // post-mortem would draw two lessons from, and the record would count
      // twice.
      const analysisId = crypto.randomUUID();
      const historyBody = JSON.stringify({
          id: analysisId,
          user_id: user.id,
          pair: currencyPair,
          interval,
          mode: resolvedMode,
          signal: normalizedAnalysis.signal,
          confidence: normalizedAnalysis.confidence,
          thesis: normalizedAnalysis.thesis || null,
          entry_point: normalizedAnalysis.entry_point_num,
          stop_loss: normalizedAnalysis.stop_loss_num,
          take_profit_1: normalizedAnalysis.take_profit_1_num,
          take_profit_2: normalizedAnalysis.take_profit_2_num,
          take_profit_3: normalizedAnalysis.take_profit_3_num,
          risk_reward: normalizedAnalysis.risk_reward_ratio,
          result: normalizedAnalysis,
          // Market price at the time of the plan: tells the tracker whether
          // the entry was a market, limit or stop order
          price_at_signal: priceAtSignal,
          // Why a plan was or was not publishable, so the rate of unfillable
          // entries can be tracked over time
          entry_check: entryCheck,
          // Only on a row that stood aside: on a published trade the plan
          // itself is the prediction, and a second one beside it would be a
          // second thing to keep in step.
          //
          // Never on a preview. This is not decoration — it is the whole of
          // how a preview stays unscored: both the WAIT sweep in
          // track-outcomes and the WAIT diagnosis in postmortem select on
          // `outcome=eq.skipped` AND `wait_plan` being non-null, so a row
          // without one is invisible to them. Scoring a preview would grade a
          // Friday-close reading against Monday's reopen, across the gap,
          // which is the exact thing the closed-market rule exists to stop.
          wait_plan: normalizedAnalysis.signal === "WAIT" && !previewMode ? waitPlan : null,
          // The market was shut when this was asked for, so it is a read of
          // the last close and not a plan. Kept in the history and kept out of
          // every statistic, every lesson and every rulebook count.
          preview: previewMode,
          context,
          rulebook_version: rulebookVersion === null ? null : (rulesShown.length > 0 ? rulebookVersion : 0),
          // Which contract this plan was made under. Never inferred: a reader
          // that has to guess will guess the legacy value and the two eras
          // will pool silently.
          plan_contract: PLAN_CONTRACT,
          priced_at: pricedAtIso,
          quote_at_signal: quoteAtSignal,
          outcome: trackable ? "pending" : "skipped",
      });
      // The row IS the plan. Nothing else persists it: unsaved, it never
      // reaches the user's history, the tracker never settles it, the
      // post-mortem never sees it and it never becomes a lesson. This used to
      // be a console.error under an ok:true response — the user was charged a
      // credit for an analysis that left no trace. Retry the write, and if it
      // still will not land, say so and hand the credit back.
      let savedId: string | null = null;
      let saveError = "";
      for (let attempt = 1; attempt <= SAVE_ATTEMPTS && savedId === null; attempt++) {
        try {
          // Upsert on the primary key: a repeat rewrites the identical body
          // onto the row the previous attempt created rather than inserting
          // another. Success is the status, not the shape of the body — a 2xx
          // whose representation could not be parsed used to send the loop
          // round again over a row that had already landed.
          const historyRes = await fetch(`${supabaseUrl}/rest/v1/analyses`, {
            method: "POST",
            headers: { ...historyHeaders, Prefer: "return=minimal,resolution=merge-duplicates" },
            body: historyBody,
          });
          const historyText = await historyRes.text().catch(() => "");
          if (historyRes.ok) savedId = analysisId;
          else saveError = `${historyRes.status}: ${historyText.slice(0, 200)}`;
        } catch (err) {
          saveError = err instanceof Error ? err.message : String(err);
        }
        if (savedId === null && attempt < SAVE_ATTEMPTS) {
          console.error(`Failed to save analysis history (attempt ${attempt}):`, saveError);
          await new Promise((resolve) => setTimeout(resolve, SAVE_RETRY_MS * attempt));
        }
      }
      if (savedId === null) {
        console.error("Failed to save analysis history, giving up:", saveError);
        return await fail({
          ok: false,
          error: "分析は完了しましたが保存できませんでした。回数は戻しました。もう一度お試しください",
          diagnostics: { error_stage: "history_not_saved", stage, detail: redactSecrets(saveError).slice(0, 200) },
        }, 503);
      }

      // The refused plan is tracked too, out of sight: if the market goes on
      // to fill it and pay, the gate was wrong, and that has to be visible
      // somewhere
      // Only the fillability refusals are worth shadowing: "would the market
      // have reached this entry" is a question the tracker can answer. A
      // poor_rr or stop_too_tight refusal is a judgement about the plan's
      // shape, and a filled shadow of it would read as "the gate was wrong"
      // when it was not.
      // The replay inputs go to their own table: nothing in the app reads
      // them, and the system prompt has never been client-readable, while
      // analyses carries a table-level select grant to authenticated. A
      // failure here costs the ability to replay this one plan and nothing
      // else, so it is logged rather than fatal.
      try {
        const promptRes = await fetch(`${supabaseUrl}/rest/v1/analysis_prompts?on_conflict=analysis_id`, {
          method: "POST",
          headers: { ...historyHeaders, Prefer: "resolution=merge-duplicates,return=minimal" },
          body: JSON.stringify({
            analysis_id: savedId,
            system: promptRecord.system,
            user: promptRecord.user,
            model: promptRecord.model,
            sent_at: promptRecord.at,
          }),
        });
        if (!promptRes.ok) {
          console.error("Failed to save the replay prompt:", promptRes.status, (await promptRes.text().catch(() => "")).slice(0, 200));
        } else await promptRes.text().catch(() => {});
      } catch (err) {
        console.error("Replay prompt insert threw:", err instanceof Error ? err.message : String(err));
      }

      // Never parentless: a shadow whose shadow_of is null cannot be folded
      // back into the row it is the shadow of, and reads as a plan of its own.
      // Never on a preview. The shadow is a TRACKED plan (`outcome: pending`),
      // and the shape gate's own rejection can still be "too_far" while the
      // reason actually acted on was the closed market — so without this a
      // weekend preview would quietly open a trade to be settled against
      // Monday's reopen, through the one door the preview rules leave ajar.
      const shadowable = savedId !== null && entryRejected && !previewMode &&
        (entryVerdict.rejection === "too_far" || entryVerdict.rejection === "should_be_market") &&
        (proposedSignal === "BUY" || proposedSignal === "SELL") &&
        proposed.entry !== null && proposed.stop !== null && proposed.tp1 !== null;
      if (shadowable) {
        const shadowRes = await fetch(`${supabaseUrl}/rest/v1/analyses`, {
          method: "POST",
          headers: { ...historyHeaders, Prefer: "return=minimal" },
          body: JSON.stringify({
            user_id: user.id,
            pair: currencyPair,
            interval,
            mode: resolvedMode,
            signal: proposedSignal,
            confidence: normalizedAnalysis.confidence,
            thesis: normalizedAnalysis.thesis || null,
            entry_point: proposed.entry,
            stop_loss: proposed.stop,
            take_profit_1: proposed.tp1,
            take_profit_2: proposed.tp2,
            take_profit_3: proposed.tp3,
            risk_reward: entryVerdict.riskReward !== null ? `1:${entryVerdict.riskReward}` : null,
            result: null,
            price_at_signal: priceAtSignal,
            entry_check: entryCheck,
            context,
            rulebook_version: rulebookVersion === null ? null : (rulesShown.length > 0 ? rulebookVersion : 0),
            plan_contract: PLAN_CONTRACT,
            priced_at: pricedAtIso,
            outcome: "pending",
            shadow: true,
            shadow_of: savedId,
          }),
        });
        if (!shadowRes.ok) {
          console.error("Failed to save shadow plan:", shadowRes.status, (await shadowRes.text()).slice(0, 300));
        } else {
          await shadowRes.text();
        }
      }
    }

    stage = "response";
    const p = (v: number | null) => fmt(v, decimals);
    const x = (v: number | null, d = 2) => fmt(v, d);
    const { entry_point_num: _e, stop_loss_num: _s, take_profit_1_num: _t1, take_profit_2_num: _t2, take_profit_3_num: _t3, ...clientAnalysis } = normalizedAnalysis;

    return json({
      ok: true,
      data: {
        analysis: clientAnalysis,
        remaining: isAdmin ? null : dailyLimit - count,
        plan,
        mode: resolvedMode,
        entry_check: entryCheck,
        rulebook_version: rulebookVersion,
        // The market was shut when this was asked for, so this is a read of
        // the last close rather than a plan. The client shows it as a result
        // with the plan removed, not as an error — and says when the analyst
        // starts publishing plans again, which is the question a person asks
        // the moment they are told "not now".
        preview: previewMode,
        market_opens_at: marketOpensAt,
        technicalData: {
          price: p(entrySnapshot.price),
          datetime: entrySnapshot.datetime,
          timeSeries: [],
          rsi: x(entrySnapshot.rsi),
          macd: x(entrySnapshot.macd, 5),
          macdSignal: x(entrySnapshot.macdSignal, 5),
          macdHist: x(entrySnapshot.macdHist, 5),
          bbUpper: p(entrySnapshot.bbUpper),
          bbMiddle: p(entrySnapshot.bbMiddle),
          bbLower: p(entrySnapshot.bbLower),
          sma20: p(entrySnapshot.sma20),
          sma50: p(entrySnapshot.sma50),
          sma200: p(entrySnapshot.sma200),
          tenkan: p(entrySnapshot.tenkan),
          kijun: p(entrySnapshot.kijun),
          // The pair THIS window projects 26 bars into the future. The panel
          // used to render these two as plain "Ichimoku Span A/B", which is
          // the cloud price will meet — not the one it is trading against.
          spanA: p(entrySnapshot.spanA),
          spanB: p(entrySnapshot.spanB),
          // The cloud price is actually inside, computed 26 bars ago. It was
          // sent to the model, correctly named, and never to the client at
          // all — so the panel confirmed a claim about "price below the
          // cloud" with the wrong pair of numbers.
          cloudNowTop: p(entrySnapshot.cloudNow?.top ?? null),
          cloudNowBottom: p(entrySnapshot.cloudNow?.bottom ?? null),
          cloudSide: entrySnapshot.cloudSide ?? null,
          // The levels the judgement rests on, so the chart can draw them and
          // a reader can check a claim against the picture instead of taking
          // it on trust. Computed here, never model-authored — which is why
          // the chart can draw them in a different register from anything the
          // model cites.
          levels: (() => {
            const st = structures[0].structure;
            if (!st.ok) return [];
            const out: Array<{ label: string; value: number; kind: string }> = [];
            for (const h of st.highs) out.push({ label: `H ${h.barsAgo}本前`, value: h.price, kind: "swing_high" });
            for (const l of st.lows) out.push({ label: `L ${l.barsAgo}本前`, value: l.price, kind: "swing_low" });
            const brk = [st.lastBreak.up, st.lastBreak.down].filter((b) => b !== null && b.state !== "held");
            for (const b of brk) out.push({ label: b!.state === "reclaimed" ? "戻された" : "終値ブレイク", value: b!.level, kind: "break" });
            return out;
          })(),
          cloudBand: entrySnapshot.cloudNow
            ? { top: entrySnapshot.cloudNow.top, bottom: entrySnapshot.cloudNow.bottom }
            : null,
          // Whether the newest bar had closed when this was read. Without it
          // a mid-bar price renders as a settled "current rate".
          barClosed: entrySnapshot.barClosed,
          atr: p(entrySnapshot.atr),
          slowK: x(entrySnapshot.slowK),
          slowD: x(entrySnapshot.slowD),
          adx: x(entrySnapshot.adx),
          candles: entryCandles.slice(-60),
        },
      },
      diagnostics: { stage },
    });
  } catch (err) {
    const message = redactSecrets(err instanceof Error ? err.message : "サーバーエラーが発生しました");
    console.error("Edge function error:", err);
    return await fail({
      ok: false,
      error: message,
      diagnostics: { error_stage: "unhandled_exception", stage },
    }, 500);
  }
});
