// analyze_v2 — v5 hardened Anthropic response parsing
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

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

const getCorsHeaders = (origin: string | null) => ({
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
});

const json = (req: Request, body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      ...getCorsHeaders(req.headers.get("origin")),
      "Content-Type": "application/json",
    },
  });

const ADMIN_EMAILS = ["k.munemoto@kyoto-salute.com", "munekan2989@gmail.com"];

Deno.serve(async (req: Request) => {
  const start = Date.now();

  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: getCorsHeaders(req.headers.get("origin")),
    });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return json(req, { ok: false, error: "認証が必要です", diagnostics: { error_stage: "missing_auth" } }, 401);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");

    if (!supabaseUrl || !supabaseAnonKey) {
      return json(req, { ok: false, error: "サーバー設定エラー: Supabase credentials not configured", diagnostics: { error_stage: "missing_supabase_credentials" } }, 500);
    }

    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    // Profile reads and usage-counter writes go through the service role: with
    // the caller's own token a user could reset their daily_analysis_count and
    // analyze without limit. Falls back to the caller's client if unset.
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const db = serviceRoleKey ? createClient(supabaseUrl, serviceRoleKey) : supabase;

    if (!serviceRoleKey) {
      console.warn("SUPABASE_SERVICE_ROLE_KEY is not configured; usage counters are not enforceable");
    }

    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();

    if (userError || !user) {
      return json(req, { ok: false, error: "認証に失敗しました", diagnostics: { error_stage: "auth_failed" } }, 401);
    }

    let requestBody: unknown;

    try {
      requestBody = await req.json();
    } catch {
      return json(req, { ok: false, error: "リクエスト形式が不正です", diagnostics: { error_stage: "invalid_json" } }, 400);
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
      return json(req, { ok: false, error: "通貨ペアまたは時間足が不正です", diagnostics: { error_stage: "invalid_input" } }, 400);
    }

    const { data: profile } = await db
      .from("profiles")
      .select("*")
      .eq("id", user.id)
      .single();

    const isAdmin = ADMIN_EMAILS.includes(user.email?.toLowerCase() || "");
    const plan = isAdmin ? "pro" : profile?.plan || "free";

    const limits: Record<string, number> = {
      free: 2,
      light: 10,
      standard: 30,
      pro: 9999,
    };

    const dailyLimit = limits[plan] || 3;
    const today = new Date().toISOString().split("T")[0];
    const lastDate = profile?.last_analysis_date?.split("T")[0];
    let count = lastDate === today ? (profile?.daily_analysis_count || 0) : 0;

    if (!isAdmin && count >= dailyLimit) {
      return json(req, { ok: false, error: `本日の上限(${dailyLimit}回)に達しました`, diagnostics: { error_stage: "daily_limit_reached" } }, 400);
    }

    const twelveDataKey = Deno.env.get("TWELVE_DATA_API_KEY");
    if (!twelveDataKey) {
      return json(req, { ok: false, error: "サーバー設定エラー: Market data API key not configured", diagnostics: { error_stage: "missing_market_data_key" } }, 500);
    }

    const pair = currencyPair.replace("/", "");
    const tdUrl = `https://api.twelvedata.com/time_series?symbol=${pair}&interval=${interval}&outputsize=50&apikey=${twelveDataKey}`;
    const tdRes = await fetch(tdUrl);
    const tdData = await tdRes.json();

    if (tdData.status === "error") {
      return json(req, { ok: false, error: `市場データ取得エラー: ${tdData.message}`, diagnostics: { error_stage: "market_data_failed" } }, 400);
    }

    const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!anthropicKey) {
      return json(req, { ok: false, error: "サーバー設定エラー: AI API key not configured", diagnostics: { error_stage: "missing_ai_key" } }, 500);
    }

    const candles = Array.isArray(tdData?.values) ? tdData.values.slice(0, 30) : [];
    if (candles.length === 0) {
      return json(req, { ok: false, error: "市場データが取得できませんでした", diagnostics: { error_stage: "empty_market_data" } }, 400);
    }

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
  "analysis": "詳細分析テキスト",
  "warnings": ["注意事項1", ...]
}
JSONのみ返してください。`;

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

    const claudeText = await claudeRes.text();
    let claudeData: any = {};

    try {
      claudeData = claudeText ? JSON.parse(claudeText) : {};
    } catch {
      claudeData = {};
    }

    if (!claudeRes.ok) {
      const apiError = claudeData?.error?.message || claudeData?.error || claudeText || `AI分析エラー (${claudeRes.status})`;
      console.error("Claude API error:", claudeRes.status, claudeText);
      return json(req, {
        ok: false,
        error: apiError,
        diagnostics: {
          error_stage: "anthropic_request_failed",
          processing_time_ms: Date.now() - start,
        },
      }, 400);
    }

    const finalText = extractAnthropicText(claudeData);

    if (!finalText) {
      return json(req, {
        ok: false,
        error: "AI分析エラー: レスポンス形式が不正です",
        diagnostics: {
          error_stage: "unexpected_anthropic_response",
          processing_time_ms: Date.now() - start,
        },
      }, 400);
    }

    const cleaned = finalText.replace(/```json\n?|```\n?/g, "").trim();
    let analysis;

    try {
      analysis = JSON.parse(cleaned);
    } catch {
      const first = cleaned.indexOf("{");
      const last = cleaned.lastIndexOf("}");

      if (first !== -1 && last > first) {
        analysis = JSON.parse(cleaned.substring(first, last + 1));
      } else {
        return json(req, {
          ok: false,
          error: "AI分析結果の解析に失敗しました",
          diagnostics: {
            error_stage: "analysis_parse_failed",
            processing_time_ms: Date.now() - start,
          },
        }, 500);
      }
    }

    if (!isAdmin) {
      count += 1;
      const { error: usageError } = await db
        .from("profiles")
        .upsert({
          id: user.id,
          ...(user.email ? { email: user.email } : {}),
          daily_analysis_count: count,
          last_analysis_date: new Date().toISOString().split("T")[0],
        });

      if (usageError) {
        console.error("Failed to persist usage count:", usageError.message);
      }
    }

    return json(req, {
      ok: true,
      data: {
        analysis,
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
    return json(req, {
      ok: false,
      error: err instanceof Error ? err.message : "サーバーエラーが発生しました",
      diagnostics: {
        error_stage: "unhandled_exception",
        processing_time_ms: Date.now() - start,
      },
    }, 500);
  }
});