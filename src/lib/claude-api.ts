import type { AnalysisResult, TechnicalData, AppSettings } from "./types";

const SYSTEM_PROMPT = `あなたはプロのFXアナリストです。提供されたUSD/JPYのテクニカルデータとウェブ検索による最新情報を総合的に分析し、トレード判断を支援します。

## 分析手順

### Step 1: ウェブ検索で最新情報を取得
以下を必ずweb_searchで検索してください:
1. 「USD JPY forecast today」 - 本日の市場予想
2. 「economic calendar today」 - 重要な経済指標発表予定
3. 「Federal Reserve Bank of Japan news」 - 日米中央銀行の最新動向

### Step 2: テクニカル分析
提供されたデータから以下を評価:
- トレンド方向: SMA20/50/200の並び順（パーフェクトオーダー等）
- モメンタム: RSI、MACD、Stochasticの方向性
- ボラティリティ: ボリンジャーバンド幅、ATR
- 一目均衡表: 雲の上か下か、転換線と基準線の位置関係
- ローソク足パターン: 直近のプライスアクション
- 重要なレベル: サポート/レジスタンス

### Step 3: ファンダメンタル分析
ウェブ検索結果から:
- 本日の重要経済指標
- 金融政策の方向性
- 市場リスクセンチメント
- 地政学的リスク

### Step 4: 総合判断
テクニカルとファンダメンタルを統合して最終判断。

## 出力フォーマット
必ず以下のJSON形式のみで回答してください。JSONの前後に説明文やバッククォートを絶対に付けないでください。

{
  "signal": "BUY" または "SELL" または "WAIT",
  "confidence": 0から100の整数,
  "technical_score": 0から100の整数,
  "fundamental_score": 0から100の整数,
  "risk_level": "LOW" または "MEDIUM" または "HIGH",
  "sentiment": "BULLISH" または "NEUTRAL" または "BEARISH",
  "entry_point": "具体的なレート（例: 142.850）",
  "stop_loss": "具体的なレート",
  "take_profit_1": "第1利確目標レート",
  "take_profit_2": "第2利確目標レート",
  "risk_reward_ratio": "数値（例: 2.0）",
  "analysis": "詳細な分析レポートを日本語で記述。テクニカルとファンダメンタルの両面から根拠を説明。",
  "key_factors": ["判断の主要因1", "判断の主要因2", "判断の主要因3"],
  "warnings": ["注意事項1", "注意事項2"],
  "market_context": "現在の市場環境の簡潔な説明（日本語）"
}

## 重要なルール
- 確信度60%未満の場合は signal を必ず「WAIT」にする
- warnings には必ず「この分析は参考情報です。投資判断は自己責任で行ってください」を含める
- 重要経済指標の発表前後はリスクを高めに評価する
- テクニカル指標同士が矛盾する場合は確信度を下げる
- RSIが30以下（売られすぎ）または70以上（買われすぎ）は特に注目
- MACDとシグナルのクロスは重要なシグナル
- 一目均衡表の雲のねじれは転換シグナル`;

function buildUserMessage(data: TechnicalData, settings: AppSettings, interval: string): string {
  const candleTable = data.timeSeries
    .map((c) => `| ${c.datetime} | ${c.open} | ${c.high} | ${c.low} | ${c.close} |`)
    .join("\n");

  return `以下の${settings.currencyPair}のリアルタイムデータを分析してください。

## 基本情報
- 通貨ペア: ${settings.currencyPair}
- 分析時間足: ${interval}
- 現在レート: ${data.price}
- 日時: ${data.datetime} JST

## ローソク足データ（直近20本）
| datetime | open | high | low | close |
|----------|------|------|-----|-------|
${candleTable}

## テクニカル指標（現在値）
- RSI(14): ${data.rsi}
- MACD: ${data.macd}, Signal: ${data.macdSignal}, Histogram: ${data.macdHist}
- ボリンジャーバンド: Upper=${data.bbUpper}, Middle=${data.bbMiddle}, Lower=${data.bbLower}
- SMA20: ${data.sma20}, SMA50: ${data.sma50}, SMA200: ${data.sma200}
- 一目均衡表: 転換線=${data.tenkan}, 基準線=${data.kijun}, 先行スパンA=${data.spanA}, 先行スパンB=${data.spanB}
- ATR(14): ${data.atr}
- Stochastic: %K=${data.slowK}, %D=${data.slowD}
- ADX(14): ${data.adx}

## トレード設定
- 損切り幅: ${settings.defaultStopLossPips} pips
- 利確目標幅: ${settings.defaultTakeProfitPips} pips

上記データに基づいて総合分析を行い、web_searchツールで最新のファンダメンタル情報も取得した上で判断してください。`;
}

export async function analyzeWithClaude(
  data: TechnicalData,
  settings: AppSettings,
  interval: string
): Promise<AnalysisResult> {
  const apiKey = settings.anthropicApiKey.trim();

  if (!apiKey.startsWith("sk-ant-")) {
    throw new Error("APIキーの形式が正しくありません。sk-ant-で始まるキーを入力してください。");
  }

  const userMessage = buildUserMessage(data, settings, interval);

  console.log("Calling Claude API...");
  console.log("API Key prefix:", apiKey.substring(0, 12));
  console.log("Model: claude-sonnet-4-20250514");

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true"
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4096,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage }]
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error("Claude API Error Status:", response.status);
    console.error("Claude API Error Body:", errorText);

    if (response.status === 401) {
      throw new Error("認証エラー: APIキーが無効です。Anthropic Consoleで新しいキーを発行してください。詳細: " + errorText);
    }
    throw new Error(`Claude API エラー (${response.status}): ${errorText}`);
  }

  const result = await response.json();
  console.log("Claude API raw response:", JSON.stringify(result).substring(0, 500));

  const textContent = result.content
    .filter((block: any) => block.type === "text")
    .map((block: any) => block.text)
    .join("");

  const cleaned = textContent.replace(/```json\n?|```\n?/g, "").trim();

  try {
    return JSON.parse(cleaned);
  } catch (parseErr) {
    console.error("JSON parse error. Raw text:", textContent);
    throw new Error("分析結果のパースに失敗しました。再度お試しください。");
  }
}
