import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(
        JSON.stringify({ error: "認証が必要です" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return new Response(
        JSON.stringify({ error: "認証に失敗しました" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { currencyPair, interval } = await req.json();

    // Get user profile for plan limits
    const { data: profile } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", user.id)
      .single();

    const plan = profile?.plan || "free";

    // Admin bypass — unlimited usage
    const ADMIN_EMAILS = ["k.munemoto@kyoto-salute.com"];
    const isAdmin = ADMIN_EMAILS.includes(user.email?.toLowerCase() || "");

    // Check daily limits
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

    if (count >= dailyLimit && !isAdmin) {
      return new Response(
        JSON.stringify({ error: "本日の分析上限に達しました。プランをアップグレードしてください。" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Fetch market data from Twelve Data
    const twelveDataKey = Deno.env.get("TWELVE_DATA_API_KEY");
    if (!twelveDataKey) {
      return new Response(
        JSON.stringify({ error: "サーバー設定エラー: Market data API key not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const pair = currencyPair.replace("/", "");
    const tdUrl = `https://api.twelvedata.com/time_series?symbol=${pair}&interval=${interval}&outputsize=50&apikey=${twelveDataKey}`;
    const tdRes = await fetch(tdUrl);
    const tdData = await tdRes.json();

    if (tdData.status === "error") {
      return new Response(
        JSON.stringify({ error: `市場データ取得エラー: ${tdData.message}` }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Call Claude API for analysis
    const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!anthropicKey) {
      return new Response(
        JSON.stringify({ error: "サーバー設定エラー: AI API key not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
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
      return new Response(
        JSON.stringify({ error: `AI分析エラー (${claudeRes.status})` }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const claudeData = await claudeRes.json();
    let finalText = claudeData.content
      ?.filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("") || "";

    // Parse JSON from response
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

    // Update usage count
    count += 1;
    await supabase
      .from("profiles")
      .update({
        daily_analysis_count: count,
        last_analysis_date: new Date().toISOString(),
      })
      .eq("id", user.id);

    return new Response(
      JSON.stringify({
        analysis,
        remaining: dailyLimit - count,
        plan,
        technicalData: {
          candles: candles.slice(0, 10),
          pair: currencyPair,
          interval,
        },
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("Edge function error:", err);
    return new Response(
      JSON.stringify({ error: err.message || "サーバーエラーが発生しました" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
