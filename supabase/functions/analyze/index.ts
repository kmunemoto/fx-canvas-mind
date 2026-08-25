const FUNCTION_VERSION = "analyze-v8-2026-08-25T16:00:00Z";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const ADMIN_EMAILS = ["k.munemoto@kyoto-salute.com", "munekan2989@gmail.com"];

type JsonRecord = Record<string, unknown>;

type AuthUser = {
  id: string;
  email: string | null;
};

type ProfileRecord = {
  plan?: string;
  last_analysis_date?: string;
  daily_analysis_count?: number;
};

type ParsedRequestBody = {
  currencyPair: string;
  interval: string;
  includeFundamental: boolean;
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

const asNumber = (value: unknown, fallback = 0) => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
};

const toStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];

  const normalized: string[] = [];

  for (const item of value) {
    if (typeof item === "string") {
      const trimmed = item.trim();
      if (trimmed) normalized.push(trimmed);
    }
  }

  return normalized;
};

const normalizeAnalysis = (value: unknown) => {
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

  return {
    signal,
    confidence: asNumber(source.confidence, 0),
    technical_score: asNumber(source.technical_score, 0),
    fundamental_score: asNumber(source.fundamental_score, 0),
    risk_level: riskLevel,
    sentiment,
    entry_point: asTrimmedString(source.entry_point, "—"),
    stop_loss: asTrimmedString(source.stop_loss, "—"),
    take_profit_1: asTrimmedString(source.take_profit_1, "—"),
    take_profit_2: asTrimmedString(source.take_profit_2, "—"),
    risk_reward_ratio: asTrimmedString(source.risk_reward_ratio, "—"),
    market_context: asTrimmedString(source.market_context, ""),
    analysis: asTrimmedString(source.analysis, ""),
    key_factors: toStringArray(source.key_factors),
    warnings: toStringArray(source.warnings),
    support_levels: toStringArray(source.support_levels),
    resistance_levels: toStringArray(source.resistance_levels),
  };
};

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

  return {
    data: {
      currencyPair,
      interval,
      includeFundamental,
    } satisfies ParsedRequestBody,
  };
};

const readProfile = (value: unknown): ProfileRecord | null => {
  if (isRecord(value)) {
    return {
      plan: typeof value.plan === "string" ? value.plan : undefined,
      last_analysis_date: typeof value.last_analysis_date === "string" ? value.last_analysis_date : undefined,
      daily_analysis_count: asNumber(value.daily_analysis_count, 0),
    };
  }

  if (Array.isArray(value) && value.length > 0 && isRecord(value[0])) {
    const first = value[0];
    return {
      plan: typeof first.plan === "string" ? first.plan : undefined,
      last_analysis_date: typeof first.last_analysis_date === "string" ? first.last_analysis_date : undefined,
      daily_analysis_count: asNumber(first.daily_analysis_count, 0),
    };
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

  let stage = "init";

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
    if (parsedRequest.error) {
      return json({ ok: false, error: parsedRequest.error, diagnostics: { error_stage: "invalid_input", stage } }, 400);
    }
    if (!parsedRequest.data) {
      return json({ ok: false, error: "リクエスト形式が不正です", diagnostics: { error_stage: "invalid_input", stage } }, 400);
    }

    const requestData = parsedRequest.data;
    const { currencyPair, interval, includeFundamental } = requestData;

    // The usage counters are read and written with the service role: with the
    // caller's own token a user could PATCH their own daily_analysis_count back
    // to zero and analyze without limit. Fall back to the caller's token only if
    // the key is missing, which keeps the function working but unenforced.
    const usesServiceRole = !!serviceRoleKey;
    const dbApiKey = serviceRoleKey || supabaseAnonKey;
    const dbAuthorization = serviceRoleKey ? `Bearer ${serviceRoleKey}` : authHeader;

    if (!usesServiceRole) {
      console.warn("SUPABASE_SERVICE_ROLE_KEY is not configured; usage counters are not enforceable");
    }

    stage = "fetch_profile";
    const profileRes = await fetch(
      `${supabaseUrl}/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}&select=*`,
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
    const today = new Date().toISOString().split("T")[0];
    const lastDateRaw = typeof profile?.last_analysis_date === "string"
      ? profile.last_analysis_date.split("T")[0]
      : "";
    let count = lastDateRaw === today ? asNumber(profile?.daily_analysis_count, 0) : 0;

    if (!isAdmin && count >= dailyLimit) {
      return json({
        ok: false,
        error: "本日の分析上限に達しました。プランをアップグレードしてください。",
        diagnostics: { error_stage: "daily_limit_reached", stage, dailyLimit, count },
      }, 400);
    }

    stage = "fetch_market_data";
    const pair = currencyPair;
    const tdUrl = `https://api.twelvedata.com/time_series?symbol=${pair}&interval=${interval}&outputsize=50&apikey=${twelveDataKey}`;
    const tdRes = await fetch(tdUrl);
    const tdRaw = await tdRes.text();
    const tdJson = parseJsonResponse(tdRaw);

    if (!tdRes.ok || !isRecord(tdJson)) {
      return json({
        ok: false,
        error: "市場データが取得できませんでした",
        diagnostics: { error_stage: "market_data_failed", stage, status: tdRes.status, preview: tdRaw.slice(0, 300) },
      }, 400);
    }

    if (tdJson.status === "error") {
      return json({
        ok: false,
        error: `市場データ取得エラー: ${asTrimmedString(tdJson.message, "unknown error")}`,
        diagnostics: { error_stage: "market_data_failed", stage },
      }, 400);
    }

    const rawValues = Array.isArray(tdJson.values) ? tdJson.values : [];
    const candles: JsonRecord[] = [];

    for (const item of rawValues) {
      if (isRecord(item)) {
        candles.push(item);
      }
      if (candles.length >= 30) break;
    }

    if (candles.length === 0) {
      return json({ ok: false, error: "市場データが取得できませんでした", diagnostics: { error_stage: "empty_market_data", stage } }, 400);
    }

    stage = "build_prompt";
    const analysisScope = includeFundamental
      ? "テクニカル分析に加えて、経済ニュース・経済指標・市場センチメントも考慮して総合判断してください。"
      : "テクニカル分析のみに限定して判断してください。経済ニュースやファンダメンタル要因は考慮しないでください。";

    const userMessage = `
通貨ペア: ${currencyPair}
時間足: ${interval}
分析モード: ${includeFundamental ? "full" : "technical_only"}
指示: ${analysisScope}
直近のローソク足データ (最新から):
${JSON.stringify(candles, null, 2)}

上記データを分析して、以下のJSON形式で回答してください:
{
  "signal": "BUY" | "SELL" | "WAIT",
  "confidence": 0-100の数値,
  "technical_score": 0-100の数値,
  "fundamental_score": 0-100の数値,
  "risk_level": "LOW" | "MEDIUM" | "HIGH",
  "sentiment": "BULLISH" | "NEUTRAL" | "BEARISH",
  "entry_point": "価格",
  "stop_loss": "価格",
  "take_profit_1": "価格",
  "take_profit_2": "価格",
  "risk_reward_ratio": "比率",
  "market_context": "市場環境の説明",
  "key_factors": ["要因1", "要因2", ...],
  "support_levels": ["価格1", "価格2", ...],
  "resistance_levels": ["価格1", "価格2", ...],
  "analysis": "詳細分析テキスト",
  "warnings": ["注意事項1", ...]
}
JSONのみ返してください。`;

    stage = "request_ai";
    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 4096,
        messages: [{ role: "user", content: userMessage }],
      }),
    });

    const claudeRaw = await claudeRes.text();
    const claudeJson = parseJsonResponse(claudeRaw);

    if (!claudeRes.ok) {
      const errorMessage = isRecord(claudeJson) && isRecord(claudeJson.error)
        ? asTrimmedString(claudeJson.error.message, "AI分析エラー")
        : isRecord(claudeJson)
        ? asTrimmedString(claudeJson.error, "AI分析エラー")
        : "AI分析エラー";

      return json({
        ok: false,
        error: errorMessage,
        diagnostics: { error_stage: "anthropic_request_failed", stage, status: claudeRes.status, preview: claudeRaw.slice(0, 300) },
      }, 400);
    }

    stage = "extract_ai_text";
    const finalText = extractAnthropicText(claudeJson);
    if (!finalText) {
      return json({
        ok: false,
        error: "AI分析エラー: レスポンス形式が不正です",
        diagnostics: { error_stage: "unexpected_anthropic_response", stage, preview: claudeRaw.slice(0, 300) },
      }, 400);
    }

    stage = "parse_ai_json";
    const cleaned = finalText.replace(/```json\n?|```\n?/g, "").trim();
    let parsedAnalysis: unknown = null;
    let parsed = false;

    try {
      parsedAnalysis = JSON.parse(cleaned);
      parsed = true;
    } catch {
      const first = cleaned.indexOf("{");
      const last = cleaned.lastIndexOf("}");

      if (first !== -1 && last > first) {
        parsedAnalysis = JSON.parse(cleaned.slice(first, last + 1));
        parsed = true;
      }
    }

    if (!parsed) {
      return json({
        ok: false,
        error: "AI分析結果の解析に失敗しました",
        diagnostics: { error_stage: "analysis_parse_failed", stage, preview: cleaned.slice(0, 300) },
      }, 400);
    }

    const normalizedAnalysis = normalizeAnalysis(parsedAnalysis);

    if (!isAdmin) {
      count += 1;
      stage = "update_profile";
      const updateRes = await fetch(
        `${supabaseUrl}/rest/v1/profiles`,
        {
          method: "POST",
          headers: {
            Authorization: dbAuthorization,
            apikey: dbApiKey,
            "Content-Type": "application/json",
            Prefer: "return=minimal,resolution=merge-duplicates",
            "content-profile": "public",
          },
          body: JSON.stringify({
            id: user.id,
            ...(user.email ? { email: user.email } : {}),
            daily_analysis_count: count,
            last_analysis_date: new Date().toISOString().split("T")[0],
          }),
        },
      );

      if (!updateRes.ok) {
        console.error("Failed to persist usage count:", updateRes.status, (await updateRes.text()).slice(0, 300));
      } else {
        await updateRes.text();
      }
    }

    stage = "response";
    return json({
      ok: true,
      data: {
        analysis: normalizedAnalysis,
        remaining: isAdmin ? null : dailyLimit - count,
        plan,
        mode: includeFundamental ? "full" : "technical_only",
        technicalData: {
          candles: candles.slice(0, 10),
          pair: currencyPair,
          interval,
        },
      },
      diagnostics: { stage },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "サーバーエラーが発生しました";
    console.error("Edge function error:", err);
    return json({
      ok: false,
      error: message,
      diagnostics: { error_stage: "unhandled_exception", stage },
    }, 500);
  }
});
