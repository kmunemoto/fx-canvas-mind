import type { AnalysisResult, AppSettings, SupplementaryInfo } from "./types";

const SYSTEM_PROMPT = `あなたはプロのFXアナリストです。トレーダーから提供されたチャート画像と情報を分析し、トレード判断を支援します。

## 分析手順
1. まずweb_searchツールで以下を検索してください:
   - 「USD/JPY today」で現在の市場状況
   - 「economic calendar today forex」で本日の経済指標
   - 「BOJ Fed monetary policy latest」で金融政策の最新動向

2. チャート画像から以下を読み取ってください:
   - ローソク足のパターン（はらみ、包み足、ピンバー等）
   - 移動平均線の方向と位置関係（ゴールデンクロス/デッドクロス）
   - RSIの値と乖離（ダイバージェンス）
   - MACDのシグナルとヒストグラムの方向
   - ボリンジャーバンドの幅とローソク足の位置
   - 一目均衡表（雲の位置、遅行スパン、転換線/基準線）
   - サポート/レジスタンスライン
   - トレンドラインやチャネル

3. テクニカルとファンダメンタルを総合して判断してください。

## 出力フォーマット（必ずこのJSON形式で回答）

必ず以下のJSON形式のみで回答してください。JSONの前後に説明文やマークダウンのバッククォートを付けないでください。

{
  "signal": "BUY" | "SELL" | "WAIT",
  "confidence": 0-100の数値,
  "technical_score": 0-100の数値,
  "fundamental_score": 0-100の数値,
  "risk_level": "LOW" | "MEDIUM" | "HIGH",
  "sentiment": "BULLISH" | "NEUTRAL" | "BEARISH",
  "entry_point": "具体的なレート",
  "stop_loss": "具体的なレート",
  "take_profit_1": "第1利確目標レート",
  "take_profit_2": "第2利確目標レート",
  "risk_reward_ratio": "数値",
  "analysis": "詳細な分析レポート（日本語、マークダウン形式）",
  "key_factors": ["判断の主要因1", "判断の主要因2", "判断の主要因3"],
  "warnings": ["注意事項1", "注意事項2"]
}

## 重要なルール
- 確信度60%未満の場合はsignalを必ず「WAIT」にしてください
- warningsには必ず「この分析は参考情報です。投資判断は自己責任で行ってください」を含めてください
- 重要な経済指標の発表前後30分はリスクを高めに評価してください
- 複数の時間足で方向が矛盾している場合は確信度を下げてください`;

async function compressImage(file: File, maxSizeKB = 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        let { width, height } = img;
        const maxDim = 1600;
        if (width > maxDim || height > maxDim) {
          const ratio = Math.min(maxDim / width, maxDim / height);
          width *= ratio;
          height *= ratio;
        }
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d")!;
        ctx.drawImage(img, 0, 0, width, height);

        let quality = 0.8;
        let dataUrl = canvas.toDataURL("image/jpeg", quality);
        while (dataUrl.length > maxSizeKB * 1370 && quality > 0.3) {
          quality -= 0.1;
          dataUrl = canvas.toDataURL("image/jpeg", quality);
        }
        resolve(dataUrl.split(",")[1]);
      };
      img.onerror = reject;
      img.src = e.target?.result as string;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export async function analyzeChart(
  images: File[],
  settings: AppSettings,
  supplementary: SupplementaryInfo
): Promise<AnalysisResult> {
  if (!settings.apiKey) throw new Error("APIキーが設定されていません");
  if (images.length === 0) throw new Error("チャート画像を選択してください");

  const imageContents = await Promise.all(
    images.map(async (file) => {
      const base64 = await compressImage(file);
      return {
        type: "image" as const,
        source: {
          type: "base64" as const,
          media_type: "image/jpeg" as const,
          data: base64,
        },
      };
    })
  );

  let textContent = `通貨ペア: ${settings.currencyPair}\nデフォルト損切り幅: ${settings.defaultStopLossPips} pips\nデフォルト利確幅: ${settings.defaultTakeProfitPips} pips`;
  if (supplementary.currentRate) textContent += `\n現在レート: ${supplementary.currentRate}`;
  if (supplementary.positionPreference !== "ANY") textContent += `\nポジション希望: ${supplementary.positionPreference === "BUY" ? "買い" : "売り"}`;
  if (supplementary.notes) textContent += `\n特記事項: ${supplementary.notes}`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": settings.apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 16000,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }],
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            ...imageContents,
            { type: "text", text: textContent },
          ],
        },
      ],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`API Error (${response.status}): ${err}`);
  }

  const data = await response.json();

  // Extract text blocks only
  let resultText = "";
  for (const block of data.content) {
    if (block.type === "text") {
      resultText += block.text;
    }
  }

  // Clean and parse JSON
  resultText = resultText.trim();
  if (resultText.startsWith("```")) {
    resultText = resultText.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  }

  try {
    return JSON.parse(resultText) as AnalysisResult;
  } catch {
    // Try to find JSON in the text
    const match = resultText.match(/\{[\s\S]*\}/);
    if (match) {
      return JSON.parse(match[0]) as AnalysisResult;
    }
    throw new Error("分析結果のパースに失敗しました。もう一度お試しください。");
  }
}
