// analyze v6 — direct REST auth/profile access to avoid edge runtime SDK drift
// Build timestamp: 2026-04-24T12:24:00Z
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const ADMIN_EMAILS = ["k.munemoto@kyoto-salute.com"];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

const parseJsonResponse = (rawText: string) => {
  if (!rawText) return null;

  try {
    return JSON.parse(rawText);
  } catch {
    return null;
  }
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
  const source = value && typeof value === "object" ? (value as Record<string, unknown>) : {};

  return {
    ...source,
    key_factors: toStringArray(source.key_factors),
    warnings: toStringArray(source.warnings),
    support_levels: toStringArray(source.support_levels),
    resistance_levels: toStringArray(source.resistance_levels),
  };
};

const extractAnthropicText = (claudeData: any) => {
  const content = claudeData?.content;

  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";

  const textParts: string[] = [];

  for (const block of content) {
    if (typeof block === "string") {
      textParts.push(block);
      continue;
    }

    if (block?.type === "text" && typeof block?.text === "string") {
      textParts.push(block.text);
    }
  }

  return textParts.join("").trim();
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  let stage = "init";

  try {
    stage = "read_auth_header";
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return json({ ok: false, error: "認証が必要です", diagnostics: { error_stage: "missing_auth" } }, 401);
    }

    stage = "load_env";
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");

    if (!supabaseUrl || !supabaseAnonKey) {
      return json({ ok: false, error: "サーバー設定エラー: Supabase credentials not configured", diagnostics: { error_stage: "missing_supabase_credentials" } }, 500);
    }

    stage = "fetch_user";
    const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: {
        Authorization: authHeader,
        apikey: supabaseAnonKey,
      },
    });
    const userRaw = await userRes.text();
    const userData = parseJsonResponse(userRaw) as { id?: string; email?: string | null } | null;
    const user = userRes.ok && userData?.id ? userData : null;

    if (!user) {
      return json({ ok: false, error: "認証に失敗しました", diagnostics: { error_stage: "auth_failed" } }, 401);
    }

    stage = "parse_request";
    let requestBody: unknown;
    try {
      requestBody = await req.json();
    } catch {
      return json({ ok: false, error: "リクエスト形式が不正です", diagnostics: { error_stage: "invalid_json" } }, 400);
    }

    const currencyPair = typeof (requestBody as { currencyPair?: unknown })?.currencyPair === "string"
      ? (requestBody as { currencyPair: string }).currencyPair.trim()
      : "";
    const interval = typeof (requestBody as { interval?: unknown })?.interval === "string"
      ? (requestBody as { interval: string }).interval.trim()
      : "";
    const includeFundamental = typeof (requestBody as { includeFundamental?: unknown })?.includeFundamental === "boolean"
      ? (requestBody as { includeFundamental: boolean }).includeFundamental
      : true;

    if (!currencyPair || !interval) {
      return json({ ok: false, error: "通貨ペアまたは時間足が不正です", diagnostics: { error_stage: "invalid_input" } }, 400);
    }

    stage = "fetch_profile";
    const profileRes = await fetch(
      `${supabaseUrl}/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}&select=*`,
      {
        headers: {
          Authorization: authHeader,
          apikey: supabaseAnonKey,
          Accept: "application/vnd.pgrst.object+json",
          "accept-profile": "public",
        },
      },
    );
    const profileRaw = await profileRes.text();
    const profile = profileRes.ok
      ? parseJsonResponse(profileRaw) as { plan?: string; last_analysis_date?: string; daily_analysis_count?: number } | null
      : null;

    const isAdmin = ADMIN_EMAILS.includes(user.email?.toLowerCase() || "");
    const plan = isAdmin ? "pro" : profile?.plan || "free";

    const limits: Record<string, number> = {
      free: 3,
      light: 10,
      standard: 30,
      pro: 9999,
    };
    const dailyLimit = limits[plan] || 3;

    const today = new Date().toISOString().split("T")[0];
    const lastDate = profile?.last_analysis_date?.split("T")[0];
    let count = lastDate === today ? (profile?.daily_analysis_count || 0) : 0;

    if (!isAdmin && count >= dailyLimit) {
      return json({ ok: false, error: "本日の分析上限に達しました。プランをアップグレードしてください。", diagnostics: { error_stage: "daily_limit_reached" } }, 400);
    }

    const twelveDataKey = Deno.env.get("TWELVE_DATA_API_KEY");
    if (!twelveDataKey) {
      return json({ ok: false, error: "サーバー設定エラー: Market data API key not configured", diagnostics: { error_stage: "missing_market_data_key" } }, 500);
    }

    stage = "fetch_market_data";
    const pair = currencyPair.replace("/", "");
    const tdUrl = `https://api.twelvedata.com/time_series?symbol=${pair}&interval=${interval}&outputsize=50&apikey=${twelveDataKey}`;
    const tdRes = await fetch(tdUrl);
    const tdData = await tdRes.json();

    if (tdData?.status === "error") {
      return json({ ok: false, error: `市場データ取得エラー: ${tdData?.message ?? "unknown error"}`, diagnostics: { error_stage: "market_data_failed" } }, 400);
    }

    const candles = Array.isArray(tdData?.values) ? tdData.values.slice(0, 30) : [];
    if (candles.length === 0) {
      return json({ ok: false, error: "市場データが取得できませんでした", diagnostics: { error_stage: "empty_market_data" } }, 400);
    }

    const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!anthropicKey) {
      return json({ ok: false, error: "サーバー設定エラー: AI API key not configured", diagnostics: { error_stage: "missing_ai_key" } }, 500);
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
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 4096,
        messages: [{ role: "user", content: userMessage }],
      }),
    });

    const claudeRaw = await claudeRes.text();
    let claudeData: any = {};

    try {
      claudeData = claudeRaw ? JSON.parse(claudeRaw) : {};
    } catch {
      claudeData = { raw: claudeRaw };
    }

    if (!claudeRes.ok || claudeData?.type === "error") {
      const msg = claudeData?.error?.message || claudeData?.error || claudeRaw || `status ${claudeRes.status}`;
      console.error("Claude API error:", claudeRes.status, msg);
      return json({ ok: false, error: `AI分析エラー: ${msg}`, diagnostics: { error_stage: "anthropic_request_failed", status: claudeRes.status } }, 400);
    }

    stage = "extract_ai_text";
    const finalText = extractAnthropicText(claudeData);

    if (!finalText) {
      console.error("Unexpected Claude response shape:", JSON.stringify({
        type: claudeData?.type,
        hasContentArray: Array.isArray(claudeData?.content),
        contentType: typeof claudeData?.content,
        preview: JSON.stringify(claudeData).slice(0, 500),
      }));

      return json({ ok: false, error: "AI分析エラー: レスポンス形式が不正です", diagnostics: { error_stage: "unexpected_anthropic_response" } }, 400);
    }

    const cleaned = finalText.replace(/```json\n?|```\n?/g, "").trim();
    let analysis: unknown;

    try {
      stage = "parse_ai_json";
      analysis = JSON.parse(cleaned);
    } catch {
      const first = cleaned.indexOf("{");
      const last = cleaned.lastIndexOf("}");

      if (first !== -1 && last > first) {
        analysis = JSON.parse(cleaned.substring(first, last + 1));
      } else {
        return json({ ok: false, error: "AI分析結果の解析に失敗しました", diagnostics: { error_stage: "analysis_parse_failed" } }, 400);
      }
    }

    const normalizedAnalysis = normalizeAnalysis(analysis);

    if (!isAdmin) {
      count += 1;
      stage = "update_profile";
      const updateRes = await fetch(
        `${supabaseUrl}/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}`,
        {
          method: "PATCH",
          headers: {
            Authorization: authHeader,
            apikey: supabaseAnonKey,
            "Content-Type": "application/json",
            Prefer: "return=minimal",
            "content-profile": "public",
          },
          body: JSON.stringify({
            daily_analysis_count: count,
            last_analysis_date: new Date().toISOString(),
          }),
        },
      );

      if (!updateRes.ok) {
        const updateRaw = await updateRes.text();
        console.warn("Profile update failed:", updateRes.status, updateRaw);
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
    });
  } catch (err) {
    console.error("Edge function error:", err);
    return json({
      ok: false,
      error: err instanceof Error ? err.message : "サーバーエラーが発生しました",
      diagnostics: { error_stage: "unhandled_exception", stage },
    }, 500);
  }
});
