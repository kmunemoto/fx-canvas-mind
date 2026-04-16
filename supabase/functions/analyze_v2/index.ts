import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

const ADMIN_EMAILS = ["k.munemoto@kyoto-salute.com"];

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return json({ error: "認証が必要です" }, 401);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");

    if (!supabaseUrl || !supabaseAnonKey) {
      return json({ error: "サーバー設定エラー: Supabase credentials not configured" }, 500);
    }

    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();

    if (userError || !user) {
      return json({ error: "認証に失敗しました" }, 401);
    }

    const { currencyPair, interval } = await req.json();

    const { data: profile } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", user.id)
      .single();

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
      return json({ error: `本日の上限(${dailyLimit}回)に達しました` }, 400);
    }

    const twelveDataKey = Deno.env.get("TWELVE_DATA_API_KEY");
    if (!twelveDataKey) {
      return json({ error: "サーバー設定エラー: Market data API key not configured" }, 500);
    }

    const pair = currencyPair.replace("/", "");
    const tdUrl = `https://api.twelvedata.com/time_series?symbol=${pair}&interval=${interval}&outputsize=50&apikey=${twelveDataKey}`;
    const tdRes = await fetch(tdUrl);
    const tdData = await tdRes.json();

    if (tdData.status === "error") {
      return json({ error: `市場データ取得エラー: ${tdData.message}` }, 400);
    }

    const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!anthropicKey) {
      return json({ error: "サーバー設定エラー: AI API key not configured" }, 500);
    }

    const candles = tdData.values?.slice(0, 30) || [];
    const userMessage = `
通貨ペア: ${currencyPair}
時間足: ${interval}
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
        model: "claude-sonnet-4-6",
        max_tokens: 4096,
        messages: [{ role: "user", content: userMessage }],
      }),
    });

    if (!claudeRes.ok) {
      const errText = await claudeRes.text();
      console.error("Claude API error:", claudeRes.status, errText);
      return json({ error: `AI分析エラー (${claudeRes.status})` }, 400);
    }

    const claudeData = await claudeRes.json();
    const finalText =
      claudeData.content
        ?.filter((block: any) => block.type === "text")
        .map((block: any) => block.text)
        .join("") || "";

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
        throw new Error("Failed to parse analysis JSON");
      }
    }

    if (!isAdmin) {
      count += 1;
      await supabase
        .from("profiles")
        .update({
          daily_analysis_count: count,
          last_analysis_date: new Date().toISOString(),
        })
        .eq("id", user.id);
    }

    return json({
      analysis,
      remaining: isAdmin ? null : dailyLimit - count,
      plan,
      technicalData: {
        candles: candles.slice(0, 10),
        pair: currencyPair,
        interval,
      },
    });
  } catch (err) {
    console.error("Edge function error:", err);
    return json({ error: err instanceof Error ? err.message : "サーバーエラーが発生しました" }, 500);
  }
});