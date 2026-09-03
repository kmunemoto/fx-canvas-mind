const FUNCTION_VERSION = "analyze-v20-2026-09-03T18:00:00Z";
// Open plans in the same direction inside this window are the same bet
const OPEN_PLAN_WINDOW_HOURS = 24;

import {
  computeSnapshot,
  parseCandles,
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

import { WALL_CLOCK_BUDGET_MS, canRetryWithoutSearch, planAttempt } from "./budget.ts";

import {
  MAX_LIMIT_ATR,
  MAX_STOP_ATR,
  MIN_RISK_REWARD,
  MIN_STOP_ATR,
  TREND_ADX,
  evaluateEntry,
  type EntryType,
  type EntryVerdict,
} from "./entry.ts";

import { parseRules, selectPromptRules } from "./rules.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const ADMIN_EMAILS = ["k.munemoto@kyoto-salute.com", "munekan2989@gmail.com"];

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
    `現在値: ${p(s.price)} (${s.datetime} UTC) 前足比 ${x(s.changePct)}%`,
    `RSI14: ${x(s.rsi)} | Stoch %K/%D: ${x(s.slowK)}/${x(s.slowD)} | ADX14: ${x(s.adx)}`,
    `MACD: ${x(s.macd, 5)} Signal: ${x(s.macdSignal, 5)} Hist: ${x(s.macdHist, 5)}`,
    `SMA20/50/200: ${p(s.sma20)} / ${p(s.sma50)} / ${p(s.sma200)}`,
    `BB(20,2): 上 ${p(s.bbUpper)} 中 ${p(s.bbMiddle)} 下 ${p(s.bbLower)}`,
    `一目: 転換 ${p(s.tenkan)} 基準 ${p(s.kijun)} 先行A ${p(s.spanA)} 先行B ${p(s.spanB)}`,
    `ATR14: ${p(s.atr)} (${x(s.atrPct)}% of price)`,
    `直近スイング高値: ${s.swingHighs.map((v) => v.toFixed(decimals)).join(", ") || "n/a"}`,
    `直近スイング安値: ${s.swingLows.map((v) => v.toFixed(decimals)).join(", ") || "n/a"}`,
  ].join("\n");
};

const SYSTEM_PROMPT = `あなたはプロップファームのシニアFXアナリストです。マルチタイムフレームの価格データと計算済みテクニカル指標に基づき、規律あるトレードプランを構築します。

必ず次の手順で分析してください:
1. STRUCTURE — 各時間足の市場構造を判定する（高値切り上げ/切り下げ、レンジ、ブレイク後の戻し）。
2. LEVELS — スイング高安・移動平均・一目の雲・ラウンドナンバーから有効なサポート/レジスタンスを特定する。直近スイングのすぐ外側にストップが溜まる「ストップハントゾーン」があれば特定する。
3. TREND — 時間足間の方向整合性を評価する。上位足の方向に逆らうエントリーは確信度を大きく下げる。
4. TARGETS — 損切りと利確1/2/3を決める。損切りは直近スイング±ATRに根拠を置く。ただし entry_type が "market" になる場面（手順5参照）では、損切りを大きなスイング高安まで引かず、現在値から ATR×0.5〜1.0 の範囲に置く。ATR×${MIN_STOP_ATR}未満の損切りはノイズで刈られるためサーバー側で却下され、遠すぎる損切りはリスクリワードが成立せず見送りになる。
5. ENTRY — エントリー価格と entry_type を決める。ここが最重要:
   - market_context_detail.mode が "Trend Day" または "Breakout" で signal の方向が direction と一致する場合、あるいは ADX が ${TREND_ADX} 以上で価格・SMA20・SMA50 が signal の方向に並んでいる場合、押し目・戻りを待ってはいけない。entry_type を "market"、entry_point を現在値そのものにする。トレンド中に深い戻りは来ない。待つプランは約定しないまま値幅を丸ごと逃す（サーバー側で現在値の成行に修正されるか、却下される）。
   - "Reversal"（逆張り）や "Range Day"（レンジ）のときだけ entry_type を "limit" とし、現在値から離れたエントリーを置いてよい。ただし |entry_point − 現在値| はエントリー時間足の ATR の${MAX_LIMIT_ATR}倍以内。
   - ブレイクに乗る場合は entry_type を "stop"（BUYなら現在値より上、SELLなら現在値より下）。現在値から ATR の${MAX_STOP_ATR}倍以内に置く。
   - 決めたエントリーでのリスクリワード（TP1基準）は1.5倍以上を基本とし、${MIN_RISK_REWARD}を下回るプランは出さない。まず損切りを近い水準に寄せられないか検討し、それでも成立しないなら signal を "WAIT" にする。
6. PLAN — 全てを統合して最終判断を下す。

ルール:
- 確信度が60未満の場合、signal は必ず "WAIT"。
- 約定しないエントリーは、外れた予想よりも価値がない。現在値から離すのは明確な根拠があるときだけにする。
- 時間足の方向が矛盾する場合は確信度を下げる。
- すべての価格は分析対象ペアの実際の価格スケールで出力する。
- 入力データの時刻はすべて UTC。文章で時刻に触れるときは日本時間（JST = UTC+9）に換算し、「JST」を添える。
{{LANGUAGE_RULE}}
- warnings には必ず「この分析は参考情報です。投資判断は自己責任で行ってください」を含める。
- ADX が 20 未満ならトレンドが弱いことを明記し、レンジ戦略を検討する。
- RSI・Stoch の過熱と価格構造が矛盾する場合（ダイバージェンス）は必ず言及する。

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
    entry_point: { type: "number" },
    entry_type: {
      type: "string",
      enum: ["market", "limit", "stop"],
      description: "market=現在値で即エントリー / limit=押し目・戻りを待つ / stop=ブレイクに乗る",
    },
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
      required: ["mode", "structure", "smart_money", "strength", "session", "direction", "continuity"],
      additionalProperties: false,
    },
    stop_hunt_zone: { type: "string", description: "価格帯 または Not detected" },
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
    "risk_level", "sentiment", "entry_point", "entry_type", "stop_loss", "take_profit_1",
    "take_profit_2", "take_profit_3", "risk_reward_ratio", "market_context",
    "market_context_detail", "stop_hunt_zone", "timeframe_alignment",
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

  const entry = priceField(source.entry_point);
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
    entry_type: source.entry_type === "market" || source.entry_type === "limit" || source.entry_type === "stop"
      ? source.entry_type
      : "market",
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
    const limits: Record<string, number> = {
      free: 2,
      light: 10,
      standard: 30,
      pro: 9999,
    };
    const dailyLimit = limits[plan] || 3;

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

    // What the analyzer has learned from its own record (see rules.ts). Best
    // effort: an analysis without the rules is still an analysis.
    stage = "load_rulebook";
    let rulebookVersion: number | null = null;
    let learnedRules = "";
    // The rules that fit in the prompt — what the model actually saw
    let rulesShown: string[] = [];
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
        const shown = selectPromptRules(parseRules(rulebook.rules), locale);
        learnedRules = shown.text;
        rulesShown = shown.ids;
      }
    } catch (err) {
      console.warn("Rulebook unavailable:", err instanceof Error ? err.message : String(err));
    }

    stage = "fetch_market_data";
    const timeframes = TF_CHAIN[interval];
    const fetchSeries = async (tf: string, outputsize: number) => {
      // timezone=UTC: the tracker and the chart both read these timestamps as
      // UTC, and the provider's default zone is not.
      const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(currencyPair)}&interval=${encodeURIComponent(tf)}&outputsize=${outputsize}&timezone=UTC&apikey=${twelveDataKey}`;
      const res = await fetch(url);
      const raw = await res.text();
      const parsed = parseJsonResponse(raw);
      if (!res.ok || !isRecord(parsed) || parsed.status === "error") {
        const message = isRecord(parsed) ? asTrimmedString(parsed.message, "") : "";
        throw new Error(message || `市場データ取得エラー (${tf}, HTTP ${res.status})`);
      }
      return parseCandles(parsed.values);
    };

    let seriesByTf: Candle[][];
    try {
      // The entry timeframe needs at least 200 closes or sma(closes, 200)
      // silently returns null and SMA200 vanishes from the prompt.
      seriesByTf = await Promise.all(
        timeframes.map((tf, i) => fetchSeries(tf, i === 0 ? 250 : 130)),
      );
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

    const entryCandles = seriesByTf[0];
    if (entryCandles.length < 60) {
      return await fail({ ok: false, error: "市場データが不足しています", diagnostics: { error_stage: "empty_market_data", stage } }, 400);
    }

    console.log("Market data fetched", { elapsedMs: Date.now() - startedAt });

    stage = "compute_indicators";
    const snapshots = seriesByTf.map((candles) => computeSnapshot(candles));
    const entrySnapshot = snapshots[0];
    if (!entrySnapshot) {
      return await fail({ ok: false, error: "指標計算に失敗しました", diagnostics: { error_stage: "indicator_failed", stage } }, 500);
    }

    stage = "build_prompt";
    const tfSections = timeframes.map((tf, i) => {
      const snapshot = snapshots[i];
      const candles = seriesByTf[i];
      const body = snapshot ? snapshotLines(snapshot, decimals) : "指標計算に必要な本数が不足";
      const lines = candleLines(candles, i === 0 ? 40 : 20);
      return `### ${tf}${i === 0 ? "（エントリー時間足）" : "（上位足）"}\n${body}\n直近ローソク足 (datetime[UTC],open,high,low,close / 古い順):\n${lines}`;
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

    const anthropicHeaders = {
      "content-type": "application/json",
      "x-api-key": anthropicKey,
      "anthropic-version": "2023-06-01",
    };

    const baseRequest: JsonRecord = {
      model: "claude-opus-5",
      max_tokens: 8000,
      system: SYSTEM_PROMPT
        .replace("{{LANGUAGE_RULE}}", L.languageRule)
        .replace("{{LEARNED_RULES}}", learnedRules)
        .trimEnd(),
      messages: [{
        role: "user",
        content: includeFundamental
          ? buildUserMessage(SEARCH_NOTE, true)
          : buildUserMessage(TECHNICAL_NOTE, false),
      }],
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
    const declaredType = normalizedAnalysis.entry_type;
    const declaredMode = detail && typeof detail.mode === "string" ? detail.mode : null;
    const declaredDirection = detail && typeof detail.direction === "string" ? detail.direction : null;
    const proposed = {
      entry: normalizedAnalysis.entry_point_num,
      stop: normalizedAnalysis.stop_loss_num,
      tp1: normalizedAnalysis.take_profit_1_num,
      tp2: normalizedAnalysis.take_profit_2_num,
      tp3: normalizedAnalysis.take_profit_3_num,
    };
    const entryVerdict: EntryVerdict = evaluateEntry({
      signal: proposedSignal,
      entry: proposed.entry,
      stopLoss: proposed.stop,
      takeProfit1: proposed.tp1,
      price: entrySnapshot.price,
      atr: entrySnapshot.atr,
      mode: declaredMode,
      direction: declaredDirection,
      indicators: { adx: entrySnapshot.adx, sma20: entrySnapshot.sma20, sma50: entrySnapshot.sma50 },
    });

    let entryRejected = false;
    if (entryVerdict.snapped && !entryVerdict.repaired && entryVerdict.entry !== null) {
      // Inside the market band but not on it. The tracker treats anything
      // more than ~3 pips from the market as a limit that has to be touched,
      // so publish the price the checker actually approved.
      const originalEntry = normalizedAnalysis.entry_point;
      // Stored at the displayed precision, so the price the tracker judges
      // is the price the user was shown
      normalizedAnalysis.entry_point_num = Number(entryVerdict.entry.toFixed(decimals));
      normalizedAnalysis.entry_point = entryVerdict.entry.toFixed(decimals);
      normalizedAnalysis.entry_type = "market";
      if (entryVerdict.riskReward !== null) {
        normalizedAnalysis.risk_reward_ratio = `1:${entryVerdict.riskReward}`;
      }
      if (originalEntry !== normalizedAnalysis.entry_point) {
        normalizedAnalysis.warnings = [
          L.entrySnapped({ originalEntry, entry: normalizedAnalysis.entry_point }),
          ...normalizedAnalysis.warnings,
        ];
      }
    } else if (entryVerdict.repaired && entryVerdict.entry !== null) {
      // The pullback would not have come; the same plan entered now still
      // pays, so that is what gets published — and said.
      const originalEntry = normalizedAnalysis.entry_point;
      // Stored at the displayed precision, so the price the tracker judges
      // is the price the user was shown
      normalizedAnalysis.entry_point_num = Number(entryVerdict.entry.toFixed(decimals));
      normalizedAnalysis.entry_point = entryVerdict.entry.toFixed(decimals);
      normalizedAnalysis.entry_type = "market";
      if (entryVerdict.riskReward !== null) {
        normalizedAnalysis.risk_reward_ratio = `1:${entryVerdict.riskReward}`;
      }
      normalizedAnalysis.warnings = [
        L.entryRepaired({ signal: proposedSignal, originalEntry, entry: normalizedAnalysis.entry_point }),
        ...normalizedAnalysis.warnings,
      ];
      console.log("Entry repaired", { proposedSignal, originalEntry, entry: normalizedAnalysis.entry_point, riskReward: entryVerdict.riskReward });
    } else if (!entryVerdict.ok && entryVerdict.rejection) {
      entryRejected = true;
      console.warn("Entry rejected", {
        rejection: entryVerdict.rejection,
        repairRejection: entryVerdict.repairRejection,
        proposedSignal,
        distanceAtr: entryVerdict.distanceAtr,
        stopAtr: entryVerdict.stopAtr,
        riskReward: entryVerdict.riskReward,
        regime: entryVerdict.regime,
      });
      normalizedAnalysis.warnings = [
        L.entryRejected({
          rejection: entryVerdict.rejection,
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
    } else if (entryVerdict.ok && entryVerdict.snapDeclined) {
      // Inside the market band but left as written: say so, because the
      // tracker will treat it as a limit that has to be touched
      normalizedAnalysis.warnings = [
        L.entrySnapDeclined({
          entry: normalizedAnalysis.entry_point,
          price: entrySnapshot.price.toFixed(decimals),
          reason: entryVerdict.snapDeclined,
        }),
        ...normalizedAnalysis.warnings,
      ];
    }

    const entryCheck = {
      proposed_signal: proposedSignal,
      proposed_entry: proposed.entry,
      proposed_stop: proposed.stop,
      proposed_tp1: proposed.tp1,
      declared_type: declaredType,
      declared_mode: declaredMode,
      declared_direction: declaredDirection,
      entry_type: entryVerdict.entryType,
      regime: entryVerdict.regime,
      regime_direction: entryVerdict.regimeDirection,
      momentum: entryVerdict.momentum,
      distance_atr: entryVerdict.distanceAtr,
      stop_atr: entryVerdict.stopAtr,
      risk_reward: entryVerdict.riskReward,
      rejection: entryVerdict.rejection,
      repair_rejection: entryVerdict.repairRejection,
      repaired: entryVerdict.repaired,
      snapped: entryVerdict.snapped,
      snap_declined: entryVerdict.snapDeclined,
      atr: Number.isFinite(entrySnapshot.atr as number) ? entrySnapshot.atr : null,
      price: entrySnapshot.price,
    };

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
    // tell a misread market from a wrong call
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
    const context = {
      open_same_direction: openSameDirection,
      rules_shown: rulesShown,
      timeframes,
      entry: compactSnapshot(timeframes[0], snapshots[0]),
      higher: snapshots.slice(1).map((s, i) => compactSnapshot(timeframes[i + 1], s)),
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
      const priceAtSignal = Number.isFinite(entrySnapshot.price) ? entrySnapshot.price : null;
      const historyRes = await fetch(`${supabaseUrl}/rest/v1/analyses?select=id`, {
        method: "POST",
        headers: { ...historyHeaders, Prefer: "return=representation" },
        body: JSON.stringify({
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
          context,
          rulebook_version: rulebookVersion,
          outcome: trackable ? "pending" : "skipped",
        }),
      });
      let savedId: string | null = null;
      if (!historyRes.ok) {
        console.error("Failed to save analysis history:", historyRes.status, (await historyRes.text()).slice(0, 300));
      } else {
        const saved = parseJsonResponse(await historyRes.text());
        const first = Array.isArray(saved) ? saved[0] : saved;
        savedId = isRecord(first) && typeof first.id === "string" ? first.id : null;
      }

      // The refused plan is tracked too, out of sight: if the market goes on
      // to fill it and pay, the gate was wrong, and that has to be visible
      // somewhere
      // Only the fillability refusals are worth shadowing: "would the market
      // have reached this entry" is a question the tracker can answer. A
      // poor_rr or stop_too_tight refusal is a judgement about the plan's
      // shape, and a filled shadow of it would read as "the gate was wrong"
      // when it was not.
      const shadowable = entryRejected &&
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
            rulebook_version: rulebookVersion,
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
          spanA: p(entrySnapshot.spanA),
          spanB: p(entrySnapshot.spanB),
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
