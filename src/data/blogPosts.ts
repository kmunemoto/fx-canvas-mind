import thumbBasics from "@/assets/blog-technical-basics.jpg";
import thumbRsi from "@/assets/blog-rsi.jpg";
import thumbMacd from "@/assets/blog-macd.jpg";
import thumbBollinger from "@/assets/blog-bollinger.jpg";
import thumbEntryPoint from "@/assets/blog-entry-point.jpg";
import thumbIchimoku from "@/assets/blog-ichimoku.jpg";
import thumbFundamental from "@/assets/blog-fundamental.jpg";

export type BlogCategory = "テクニカル分析" | "ファンダメンタル" | "初心者向け" | "ツール活用";

export interface BlogPost {
  slug: string;
  title: string;
  description: string;
  content: string; // HTML string
  category: BlogCategory;
  publishedAt: string; // ISO
  thumbnailUrl: string;
  tags: string[];
}

const CTA_HTML = `
<div class="not-prose mt-10 p-6 rounded-2xl border border-[#00d4ff]/30 bg-gradient-to-br from-[#00d4ff]/10 to-transparent">
  <h3 class="text-lg font-bold mb-2">FX Tactical Analyzerを無料で試す</h3>
  <p class="text-sm text-muted-foreground mb-4">
    FX Tactical Analyzerなら、RSI・MACD・ボリンジャーバンドなど11種のテクニカル指標をAIが自動分析。BUY/SELL/WAITの明確な判断と確信度スコアをリアルタイムで提供します。
  </p>
  <a href="/login?tab=signup" class="inline-block px-5 py-2.5 rounded-lg bg-[#00d4ff] text-[#0a0e17] font-semibold hover:opacity-90 transition-opacity">無料で始める</a>
</div>
`;

export const blogPosts: BlogPost[] = [
  {
    slug: "fx-technical-analysis-basics",
    title: "FXテクニカル分析の基本｜初心者が知るべき11種の指標と使い方",
    description: "RSI、MACD、ボリンジャーバンド、移動平均線、一目均衡表など、FXで使われる代表的な11種のテクニカル指標を初心者向けに徹底解説。売買シグナルの読み方と組み合わせ方も紹介します。",
    category: "初心者向け",
    publishedAt: "2026-04-15",
    thumbnailUrl: thumbBasics,
    tags: ["テクニカル分析", "初心者", "RSI", "MACD"],
    content: `
<h2 id="intro">テクニカル分析とは</h2>
<p>テクニカル分析とは、過去の価格データやチャートパターンから将来の値動きを予測する手法です。ファンダメンタル分析が経済指標やニュースを根拠にするのに対し、テクニカル分析は「相場の値動きにはパターンがある」という前提に立ち、数学的に算出された指標で売買タイミングを判断します。</p>
<p>FX取引で安定した成績を残すためには、複数のテクニカル指標を組み合わせて根拠を積み重ねることが重要です。本記事では、初心者がまず押さえておきたい11種類の代表的な指標を、見方と使い方を含めて解説します。</p>

<h2 id="trend">トレンド系指標</h2>

<h3 id="ma">1. 移動平均線（MA）</h3>
<p>一定期間の終値の平均をつないだ線で、トレンドの方向を示します。短期MA（5/20）と長期MA（75/200）の組み合わせが基本。短期線が長期線を下から上に抜ける「ゴールデンクロス」は買いシグナル、その逆の「デッドクロス」は売りシグナルとされます。</p>

<h3 id="bollinger">2. ボリンジャーバンド</h3>
<p>移動平均線の上下に標準偏差（σ）を加えた帯を表示する指標。価格は概ね±2σの範囲に収まる性質を利用し、バンドの拡大（エクスパンション）でトレンド発生、収縮（スクイーズ）でレンジを判断します。</p>

<h3 id="ichimoku">3. 一目均衡表</h3>
<p>転換線・基準線・先行スパン1/2・遅行スパンの5本で構成される日本発祥の指標。「雲」の上下で大局のトレンド方向を、雲の厚さで支持/抵抗の強さを判断します。</p>

<h3 id="adx">4. ADX（平均方向性指数）</h3>
<p>トレンドの「強さ」を0〜100で数値化する指標。25を超えると強いトレンド、20以下ならレンジ相場と判断します。+DIと-DIの位置関係で方向性も把握できます。</p>

<h2 id="oscillator">オシレーター系指標</h2>

<h3 id="rsi">5. RSI（相対力指数）</h3>
<p>0〜100で買われすぎ/売られすぎを示します。70以上で買われすぎ（売りシグナル）、30以下で売られすぎ（買いシグナル）が基本。ダイバージェンス（価格とRSIの逆行）はトレンド転換の有力サインです。</p>

<h3 id="macd">6. MACD</h3>
<p>2本の指数移動平均線の差を表すMACDラインと、そのEMAであるシグナルラインで構成。クロスでトレンド転換を、ヒストグラムで勢いの変化を読み取ります。</p>

<h3 id="stochastics">7. ストキャスティクス</h3>
<p>%Kと%Dの2本線で買われすぎ/売られすぎを示す指標。80以上で売り、20以下で買いが基本。RSIより反応が早く、短期売買に向いています。</p>

<h3 id="cci">8. CCI（商品チャネル指数）</h3>
<p>価格が平均からどれだけ乖離しているかを示す指標。+100以上は強い上昇、-100以下は強い下落。±200を超える極端な値はトレンド転換の前兆になることがあります。</p>

<h2 id="volatility">ボラティリティ・ボリューム系</h2>

<h3 id="atr">9. ATR（アベレージ・トゥルー・レンジ）</h3>
<p>一定期間の値動きの平均幅を示す指標。損切り幅やポジションサイズの計算に活用します。ATRが拡大すれば相場が活発、縮小すれば膠着を意味します。</p>

<h3 id="pivot">10. ピボットポイント</h3>
<p>前日の高値・安値・終値から算出される支持/抵抗ライン。デイトレードで意識される節目として機能します。</p>

<h3 id="fibonacci">11. フィボナッチ・リトレースメント</h3>
<p>23.6%、38.2%、50%、61.8%、76.4%といった黄金比をベースにした押し目/戻り目の目安。トレンド中の調整局面で機能しやすい指標です。</p>

<h2 id="combine">指標の組み合わせ方</h2>
<p>単一の指標だけで判断するのは危険です。一般的には、トレンド系（MA、一目、ADX）で大局を判断し、オシレーター系（RSI、ストキャス）でエントリータイミングを計り、ATRで損切り幅を決める、という多層的な使い方が定石です。</p>

<blockquote>
  <p>初心者がやりがちな失敗は、複数の指標で同じ性質のものを重ねてしまうこと（例：RSIとストキャス）。性質の異なる指標を組み合わせることで、根拠の精度が高まります。</p>
</blockquote>

<h2 id="ai">AIによる自動分析という選択肢</h2>
<p>11種の指標を毎回手動で確認し、整合性を判断するのは熟練者でも骨の折れる作業です。FX Tactical Analyzerはこのプロセスを完全自動化し、各指標のスコアと総合判断（BUY/SELL/WAIT）、確信度を秒速で算出します。</p>
<p>テクニカル分析を学びながら、AIの判断と自分の判断を比較することで、上達のスピードが大きく変わります。</p>
${CTA_HTML}
`,
  },
  {
    slug: "rsi-guide-fx",
    title: "RSIの使い方完全ガイド｜FXでの売買判断とダイバージェンスの見方",
    description: "RSI（相対力指数）の計算方法から70/30ルール、ダイバージェンスの見つけ方、他の指標との組み合わせまで、FXトレードに使えるRSIの実践的活用法を完全解説。",
    category: "テクニカル分析",
    publishedAt: "2026-04-20",
    thumbnailUrl: thumbRsi,
    tags: ["RSI", "テクニカル分析", "ダイバージェンス"],
    content: `
<h2 id="what">RSIとは</h2>
<p>RSI（Relative Strength Index、相対力指数）は、J. Welles Wilder Jr.が1978年に開発したオシレーター系指標です。一定期間の値動きにおける「上昇幅」と「下落幅」の比率から、買われすぎ／売られすぎを0〜100の範囲で示します。</p>

<h2 id="formula">RSIの計算式</h2>
<p>RSIの基本式は次の通りです：</p>
<pre><code>RSI = 100 - (100 / (1 + RS))
RS  = n期間の上昇幅平均 / n期間の下落幅平均</code></pre>
<p>標準的な期間は<strong>14</strong>。この値はWilderが推奨した数値で、現在も世界中のトレーダーに使われています。</p>

<h2 id="basic">基本的な見方：70/30ルール</h2>
<ul>
  <li><strong>70以上</strong>：買われすぎ。反落の可能性が高まる（売り目線）</li>
  <li><strong>30以下</strong>：売られすぎ。反発の可能性が高まる（買い目線）</li>
  <li><strong>50</strong>：中立ライン。50超で上昇優勢、50割れで下落優勢</li>
</ul>
<p>ただし強いトレンド相場では70以上／30以下に張り付くことも珍しくないため、機械的に逆張りすると損失を重ねます。</p>

<h2 id="divergence">ダイバージェンスの見方</h2>
<p>ダイバージェンス（逆行現象）はRSIの最大の武器です。</p>

<h3 id="bearish-div">弱気ダイバージェンス</h3>
<p>価格は高値を更新しているのに、RSIは前回高値を更新できない状態。上昇の勢いが衰えているサインで、トップアウトの前兆です。</p>

<h3 id="bullish-div">強気ダイバージェンス</h3>
<p>価格は安値を更新しているのに、RSIは前回安値を更新できない状態。下落の勢いが衰えているサインで、ボトムアウトの前兆となります。</p>

<blockquote><p>ダイバージェンスは「トレンド転換の予告」であり「即座のエントリーサイン」ではありません。価格の確定的な反転（ローソク足のパターン、トレンドラインのブレイクなど）を確認してからエントリーするのが鉄則です。</p></blockquote>

<h2 id="combo">他の指標との組み合わせ</h2>
<ol>
  <li><strong>RSI + 移動平均線</strong>：MAでトレンド方向を確認し、RSIで押し目/戻りを狙う</li>
  <li><strong>RSI + ボリンジャーバンド</strong>：±2σタッチ＋RSI極値で逆張り精度UP</li>
  <li><strong>RSI + 水平線</strong>：レジサポ付近でのRSIダイバージェンスは反転確度が高い</li>
</ol>

<h2 id="practice">実践的なトレード手法</h2>
<h3 id="trend-follow">トレンドフォロー型</h3>
<p>上昇トレンドではRSIが40〜50まで押した時を買い場とし、70超えで利確を検討。下降トレンドではその逆です。</p>

<h3 id="reverse">逆張り型</h3>
<p>レンジ相場で、RSI 30以下＋下ヒゲローソク足出現で買い、RSI 70以上＋上ヒゲ出現で売り。必ず損切りラインを設定することが必須です。</p>

<h2 id="caveats">RSI使用時の注意点</h2>
<ul>
  <li>強トレンド中の70/30は逆張り厳禁</li>
  <li>期間設定（14が標準、9で敏感に、25で滑らかに）を相場に合わせる</li>
  <li>ダイバージェンスは複数時間足で確認すると精度が上がる</li>
</ul>
${CTA_HTML}
`,
  },
  {
    slug: "macd-guide-fx",
    title: "MACDの見方と使い方｜ゴールデンクロスとシグナルラインの活用法",
    description: "MACDの3つの構成要素、ゴールデンクロス／デッドクロスの見方、ゼロラインとの関係、ヒストグラムの活用、エントリータイミングまでをFXトレード視点で詳しく解説します。",
    category: "テクニカル分析",
    publishedAt: "2026-04-25",
    thumbnailUrl: thumbMacd,
    tags: ["MACD", "テクニカル分析", "ゴールデンクロス"],
    content: `
<h2 id="what">MACDとは</h2>
<p>MACD（Moving Average Convergence Divergence、移動平均収束拡散法）は、Gerald Appelが1970年代に開発したトレンド系オシレーター指標です。2本の指数移動平均線（EMA）の差を可視化することで、トレンドの方向と強さを同時に読み取れます。</p>

<h2 id="components">MACDの3つの構成要素</h2>

<h3 id="macd-line">1. MACDライン</h3>
<p><code>MACD = 短期EMA(12) - 長期EMA(26)</code></p>
<p>2本のEMAの差。プラスなら短期が長期より上＝上昇優勢、マイナスなら下降優勢を示します。</p>

<h3 id="signal-line">2. シグナルライン</h3>
<p><code>シグナル = MACDの9期間EMA</code></p>
<p>MACDラインを平滑化したもので、ノイズを除去しトレンド転換のサインを生み出します。</p>

<h3 id="histogram">3. ヒストグラム</h3>
<p><code>ヒストグラム = MACD - シグナル</code></p>
<p>2本の差を棒グラフで表示。勢いの変化が視覚的に分かるため、転換の予兆を素早く察知できます。</p>

<h2 id="cross">ゴールデンクロス／デッドクロス</h2>
<ul>
  <li><strong>ゴールデンクロス</strong>：MACDラインがシグナルラインを下から上に抜ける → 買いシグナル</li>
  <li><strong>デッドクロス</strong>：MACDラインがシグナルラインを上から下に抜ける → 売りシグナル</li>
</ul>
<p>ただし、レンジ相場ではダマシが多発します。ゼロラインとの位置関係で精度を上げることが重要です。</p>

<h2 id="zero-line">ゼロラインの重要性</h2>
<p>MACDがゼロラインの<strong>上</strong>でゴールデンクロス → 強い買いシグナル<br>
MACDがゼロラインの<strong>下</strong>でデッドクロス → 強い売りシグナル</p>
<blockquote><p>ゼロラインは「短期EMAと長期EMAが一致する点」。これを超えるかどうかは、中期的なトレンド転換を意味する重要なポイントです。</p></blockquote>

<h2 id="histogram-signal">ヒストグラムによる早期察知</h2>
<p>ヒストグラムの「ピークアウト」はMACDクロスより早く出現します。例えば上昇中にヒストグラムが縮み始めたら、勢いが弱まっている合図。クロスを待たずに利確準備に入る判断ができます。</p>

<h2 id="divergence">MACDダイバージェンス</h2>
<p>RSIと同様、価格とMACDの方向が逆行する現象はトレンド転換の有力サインです。特に高値圏／安値圏でのダイバージェンスは見逃せません。</p>

<h2 id="entry">実践的なエントリータイミング</h2>
<ol>
  <li>上位足（4時間足／日足）のMACDでトレンド方向を確認</li>
  <li>下位足（15分／1時間足）のMACDゴールデンクロスでエントリー</li>
  <li>ヒストグラムが反対方向に転じたら一部利確</li>
  <li>シグナルクロス＋ヒストグラム反転で全決済</li>
</ol>

<h2 id="settings">パラメータ設定の考え方</h2>
<p>標準は<code>(12, 26, 9)</code>。デイトレード向けには<code>(5, 13, 5)</code>のように短くし、スイング向けには長めに設定します。期間を変えても基本的な使い方は同じです。</p>

<h2 id="caveats">使用上の注意</h2>
<ul>
  <li>レンジ相場ではダマシが多い → ADXでトレンド有無を併用</li>
  <li>クロス後のローソク足確定を待つことでダマシを減らせる</li>
  <li>MACD単独ではなく、RSIや水平線と組み合わせて根拠を増やす</li>
</ul>
${CTA_HTML}
`,
  },
];

export const BLOG_CATEGORIES: ("全て" | BlogCategory)[] = [
  "全て",
  "テクニカル分析",
  "ファンダメンタル",
  "初心者向け",
  "ツール活用",
];

export function getPostBySlug(slug: string): BlogPost | undefined {
  return blogPosts.find((p) => p.slug === slug);
}

export function getRelatedPosts(slug: string, limit = 2): BlogPost[] {
  const current = getPostBySlug(slug);
  if (!current) return [];
  const sameCat = blogPosts.filter((p) => p.slug !== slug && p.category === current.category);
  const others = blogPosts.filter((p) => p.slug !== slug && p.category !== current.category);
  return [...sameCat, ...others].slice(0, limit);
}

export function estimateReadingTime(html: string): number {
  const text = html.replace(/<[^>]+>/g, "");
  // Japanese: ~500 chars per minute
  return Math.max(1, Math.round(text.length / 500));
}
