import { useNavigate, Link } from "react-router-dom";
import { motion } from "framer-motion";
import {
  Zap, BarChart3, Clock, Brain, Download, Sparkles,
  ChevronRight, Check, Star, ArrowRight,
} from "lucide-react";
import {
  Accordion, AccordionContent, AccordionItem, AccordionTrigger,
} from "@/components/ui/accordion";

const fadeUp = {
  hidden: { opacity: 0, y: 30 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.6, ease: "easeOut" as const } },
};

const stagger = {
  visible: { transition: { staggerChildren: 0.15 } },
};

const PLANS = [
  {
    id: "light", name: "Light", price: "¥2,980", period: "/月",
    features: ["10回/日の分析", "USD/JPYのみ", "1時間足のみ"],
    recommended: false,
  },
  {
    id: "standard", name: "Standard", price: "¥5,980", period: "/月",
    features: ["30回/日の分析", "全通貨ペア対応", "全時間足対応", "ファンダメンタル分析", "分析履歴保存"],
    recommended: true,
  },
  {
    id: "pro", name: "Pro", price: "¥12,800", period: "/月",
    features: ["無制限の分析", "全機能", "アラート通知（予定）", "優先サポート"],
    recommended: false,
  },
];

const FAQS = [
  {
    q: "FX Tactical Analyzerとは何ですか？",
    a: "FX Tactical AnalyzerはAIを搭載したFXテクニカル分析ツールです。RSI、MACD、ボリンジャーバンドなど11種のテクニカル指標とファンダメンタル分析を統合し、BUY/SELL/WAITの売買判断と確信度スコアをリアルタイムで提供します。",
  },
  {
    q: "どの通貨ペアに対応していますか？",
    a: "USD/JPY、EUR/USD、GBP/JPY、EUR/JPYなど主要な通貨ペアに対応しています。Lightプランはドル円のみ、Standard/Proプランは全通貨ペアに対応しています。",
  },
  {
    q: "無料で使えますか？",
    a: "無料体験プランをご用意しています。有料プランはLight（月額2,980円）、Standard（月額5,980円）、Pro（月額12,800円）の3つのプランからお選びいただけます。",
  },
  {
    q: "分析にはどのくらい時間がかかりますか？",
    a: "テクニカル分析のみの場合は約10〜15秒、ファンダメンタル分析を含めた場合は約20〜30秒で結果が表示されます。",
  },
  {
    q: "どのようなテクニカル指標を使用していますか？",
    a: "RSI、MACD、ボリンジャーバンド、SMA（移動平均線）、一目均衡表、ATR、ストキャスティクス、ADXなど11種のテクニカル指標を使用し、マルチタイムフレーム分析（15分足/1時間足/4時間足/日足）を行います。",
  },
  {
    q: "解約はいつでもできますか？",
    a: "はい、マイページからいつでも解約可能です。解約後も契約期間終了まではご利用いただけます。",
  },
];

const Landing = () => {
  const navigate = useNavigate();
  const goSignup = () => navigate("/login?tab=signup");
  const goLogin = () => navigate("/login");

  return (
    <div className="min-h-screen bg-[#0a0e17] text-foreground overflow-x-hidden">
      {/* Header */}
      <header className="sticky top-0 z-50 border-b border-white/5 bg-[#0a0e17]/80 backdrop-blur-xl">
        <div className="container max-w-6xl mx-auto flex items-center justify-between px-4 h-16">
          <div className="flex items-center gap-2">
            <Zap className="h-5 w-5 text-[#00d4ff]" aria-hidden="true" />
            <span className="font-bold text-lg tracking-tight">FX Tactical Analyzer</span>
          </div>
          <nav aria-label="メインナビゲーション" className="flex items-center gap-3">
            <a href="#features" className="hidden md:inline text-sm text-muted-foreground hover:text-foreground transition-colors">機能</a>
            <a href="#pricing" className="hidden md:inline text-sm text-muted-foreground hover:text-foreground transition-colors">料金</a>
            <a href="#faq" className="hidden md:inline text-sm text-muted-foreground hover:text-foreground transition-colors">よくある質問</a>
            <button onClick={goLogin} className="text-sm text-muted-foreground hover:text-foreground transition-colors">
              ログイン
            </button>
            <button
              onClick={goSignup}
              className="text-sm font-semibold px-4 py-2 rounded-lg bg-[#00d4ff] text-[#0a0e17] hover:opacity-90 transition-opacity"
            >
              無料で始める
            </button>
          </nav>
        </div>
      </header>

      <main>
        {/* Hero */}
        <section aria-label="ヒーロー" className="relative py-24 md:py-36 overflow-hidden">
          <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,_rgba(0,212,255,0.08)_0%,_transparent_70%)]" />
          <div className="absolute inset-0 opacity-[0.03]" style={{
            backgroundImage: "linear-gradient(rgba(255,255,255,.1) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.1) 1px, transparent 1px)",
            backgroundSize: "60px 60px",
          }} />
          <motion.div
            className="relative container max-w-4xl mx-auto px-4 text-center"
            initial="hidden" animate="visible" variants={stagger}
          >
            <motion.h1 variants={fadeUp} className="text-4xl md:text-6xl font-bold leading-tight mb-6">
              AIが<span className="text-[#00d4ff]">FXを自動分析</span>。<br className="md:hidden" />
              最適な売買タイミングを逃さない。
            </motion.h1>
            <motion.p variants={fadeUp} className="text-lg md:text-xl text-muted-foreground max-w-2xl mx-auto mb-10">
              RSI・MACD・ボリンジャーバンドなど<span className="font-mono-data text-foreground">11種</span>のテクニカル指標とファンダメンタル分析をAIが統合。USD/JPY等の通貨ペアをマルチタイムフレームで分析し、BUY/SELL/WAITの明確な判断と確信度スコアをリアルタイムで提供します。
            </motion.p>
            <motion.div variants={fadeUp} className="flex flex-col items-center gap-4">
              <button
                onClick={goSignup}
                className="px-8 py-4 rounded-xl text-lg font-bold bg-gradient-to-r from-[#00d4ff] to-[#0088ff] text-[#0a0e17] hover:opacity-90 transition-opacity shadow-[0_0_30px_rgba(0,212,255,0.3)]"
              >
                無料で始める <ArrowRight className="inline h-5 w-5 ml-1" aria-hidden="true" />
              </button>
              <span className="text-sm text-muted-foreground">クレジットカード登録なしで3回まで無料体験</span>
            </motion.div>
          </motion.div>
        </section>

        {/* Pain Points */}
        <Section ariaLabel="ユーザーの悩み">
          <SectionTitle>こんな悩み、ありませんか？</SectionTitle>
          <motion.div className="grid grid-cols-1 md:grid-cols-3 gap-6" variants={stagger} initial="hidden" whileInView="visible" viewport={{ once: true }}>
            {[
              { icon: BarChart3, text: "複数の指標を見るのが大変" },
              { icon: Clock, text: "エントリーのタイミングに迷う" },
              { icon: Brain, text: "感情でトレードしてしまう" },
            ].map(({ icon: Icon, text }) => (
              <motion.div key={text} variants={fadeUp} className="glass rounded-2xl p-8 text-center border border-white/5">
                <div className="inline-flex items-center justify-center w-14 h-14 rounded-xl bg-[#00d4ff]/10 mb-5">
                  <Icon className="h-7 w-7 text-[#00d4ff]" aria-hidden="true" />
                </div>
                <p className="text-lg font-semibold">{text}</p>
              </motion.div>
            ))}
          </motion.div>
        </Section>

        {/* Features */}
        <Section id="features" ariaLabel="機能紹介">
          <SectionTitle>FX Tactical Analyzerでできること</SectionTitle>
          <motion.div className="grid grid-cols-1 md:grid-cols-3 gap-6" variants={stagger} initial="hidden" whileInView="visible" viewport={{ once: true }}>
            {[
              { icon: Download, title: "全自動データ取得", desc: "USD/JPYのリアルタイム価格、RSI、MACD、ボリンジャーバンド、一目均衡表など11種の指標を自動取得" },
              { icon: Sparkles, title: "AI総合判断", desc: "Claude AIがテクニカル分析とファンダメンタル情報を統合し、買い/売り/様子見を確信度スコア付きで提示" },
              { icon: Zap, title: "即座にエントリー判断", desc: "ボタン1つで10秒以内に分析完了。エントリーポイント、損切り、利確目標まで自動表示" },
            ].map(({ icon: Icon, title, desc }) => (
              <motion.article key={title} variants={fadeUp} className="glass rounded-2xl p-8 border border-white/5">
                <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-[#00d4ff]/10 mb-4">
                  <Icon className="h-6 w-6 text-[#00d4ff]" aria-hidden="true" />
                </div>
                <h3 className="text-lg font-bold mb-2">{title}</h3>
                <p className="text-sm text-muted-foreground leading-relaxed">{desc}</p>
              </motion.article>
            ))}
          </motion.div>
        </Section>

        {/* Steps */}
        <Section ariaLabel="利用ステップ">
          <SectionTitle>3ステップで使える</SectionTitle>
          <motion.div className="grid grid-cols-1 md:grid-cols-3 gap-8" variants={stagger} initial="hidden" whileInView="visible" viewport={{ once: true }}>
            {[
              { num: "01", title: "アカウント作成", sub: "30秒で完了" },
              { num: "02", title: "プラン選択", sub: "無料体験あり" },
              { num: "03", title: "「分析開始」を押すだけ", sub: "即座に結果表示" },
            ].map(({ num, title, sub }) => (
              <motion.div key={num} variants={fadeUp} className="text-center">
                <span className="font-mono-data text-4xl font-bold text-[#00d4ff]/30">{num}</span>
                <h3 className="text-lg font-bold mt-2 mb-1">{title}</h3>
                <p className="text-sm text-muted-foreground">{sub}</p>
              </motion.div>
            ))}
          </motion.div>
        </Section>

        {/* Pricing */}
        <Section id="pricing" ariaLabel="料金プラン">
          <SectionTitle>シンプルな料金プラン</SectionTitle>
          <motion.div className="grid grid-cols-1 md:grid-cols-3 gap-6" variants={stagger} initial="hidden" whileInView="visible" viewport={{ once: true }}>
            {PLANS.map((plan) => (
              <motion.div
                key={plan.id}
                variants={fadeUp}
                className={`relative glass rounded-2xl border p-6 flex flex-col ${
                  plan.recommended ? "border-[#00d4ff] ring-2 ring-[#00d4ff]/20" : "border-white/5"
                }`}
              >
                {plan.recommended && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2 flex items-center gap-1 px-3 py-1 rounded-full bg-[#00d4ff] text-[#0a0e17] text-xs font-semibold">
                    <Star className="h-3 w-3" aria-hidden="true" /> おすすめ
                  </div>
                )}
                <h3 className="text-xl font-bold mb-1">{plan.name}</h3>
                <div className="flex items-baseline gap-1 mb-6">
                  <span className="text-3xl font-bold font-mono-data">{plan.price}</span>
                  <span className="text-sm text-muted-foreground">{plan.period}</span>
                </div>
                <ul className="space-y-3 mb-6 flex-1">
                  {plan.features.map((f) => (
                    <li key={f} className="flex items-start gap-2 text-sm">
                      <Check className="h-4 w-4 text-[#00d4ff] mt-0.5 shrink-0" aria-hidden="true" /> {f}
                    </li>
                  ))}
                </ul>
              </motion.div>
            ))}
          </motion.div>
          <div className="text-center mt-8">
            <button
              onClick={() => navigate("/pricing")}
              className="text-sm text-[#00d4ff] hover:underline inline-flex items-center gap-1"
            >
              料金詳細を見る <ChevronRight className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        </Section>

        {/* Demo */}
        <Section ariaLabel="デモ画面">
          <SectionTitle>実際の分析画面</SectionTitle>
          <motion.div
            variants={fadeUp} initial="hidden" whileInView="visible" viewport={{ once: true }}
            className="glass rounded-2xl border border-white/5 overflow-hidden aspect-video flex items-center justify-center"
          >
            <div className="text-center text-muted-foreground">
              <BarChart3 className="h-16 w-16 mx-auto mb-4 opacity-30" aria-hidden="true" />
              <p className="text-sm">ダッシュボードスクリーンショット（準備中）</p>
            </div>
          </motion.div>
        </Section>

        {/* FAQ */}
        <Section id="faq" ariaLabel="よくある質問">
          <SectionTitle>よくある質問</SectionTitle>
          <motion.div variants={fadeUp} initial="hidden" whileInView="visible" viewport={{ once: true }} className="max-w-2xl mx-auto">
            <Accordion type="single" collapsible className="space-y-2">
              {FAQS.map((faq, i) => (
                <AccordionItem key={i} value={`faq-${i}`} className="glass rounded-xl border border-white/5 px-6">
                  <AccordionTrigger className="text-left hover:no-underline">
                    {faq.q}
                  </AccordionTrigger>
                  <AccordionContent className="text-muted-foreground">
                    {faq.a}
                  </AccordionContent>
                </AccordionItem>
              ))}
            </Accordion>
          </motion.div>
        </Section>

        {/* Final CTA */}
        <section aria-label="登録CTA" className="relative py-24">
          <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,_rgba(0,212,255,0.06)_0%,_transparent_70%)]" />
          <motion.div
            className="relative container max-w-3xl mx-auto px-4 text-center"
            variants={stagger} initial="hidden" whileInView="visible" viewport={{ once: true }}
          >
            <motion.h2 variants={fadeUp} className="text-3xl md:text-4xl font-bold mb-4">
              今すぐ始めましょう
            </motion.h2>
            <motion.p variants={fadeUp} className="text-muted-foreground mb-8">
              アカウント作成は30秒で完了します
            </motion.p>
            <motion.div variants={fadeUp}>
              <button
                onClick={goSignup}
                className="px-8 py-4 rounded-xl text-lg font-bold bg-gradient-to-r from-[#00d4ff] to-[#0088ff] text-[#0a0e17] hover:opacity-90 transition-opacity shadow-[0_0_30px_rgba(0,212,255,0.3)]"
              >
                無料で始める <ArrowRight className="inline h-5 w-5 ml-1" aria-hidden="true" />
              </button>
            </motion.div>
          </motion.div>
        </section>
      </main>

      {/* Footer */}
      <footer className="border-t border-white/5 py-10">
        <div className="container max-w-6xl mx-auto px-4">
          <div className="flex flex-col md:flex-row items-center justify-between gap-6">
            <div className="flex items-center gap-2">
              <Zap className="h-4 w-4 text-[#00d4ff]" aria-hidden="true" />
              <span className="text-sm font-semibold">FX Tactical Analyzer</span>
              <span className="text-xs text-muted-foreground ml-2">© 2026</span>
            </div>
            <nav aria-label="フッターナビゲーション" className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
              <Link to="/terms" className="hover:text-foreground transition-colors">利用規約</Link>
              <Link to="/privacy" className="hover:text-foreground transition-colors">プライバシーポリシー</Link>
              <Link to="/legal" className="hover:text-foreground transition-colors">特定商取引法に基づく表記</Link>
              <Link to="/contact" className="hover:text-foreground transition-colors">お問い合わせ</Link>
            </nav>
          </div>
          <p className="text-xs text-muted-foreground/60 text-center mt-6">
            本サービスは投資助言ではありません。FX取引にはリスクが伴います。
          </p>
        </div>
      </footer>
    </div>
  );
};

const Section = ({ children, id, ariaLabel }: { children: React.ReactNode; id?: string; ariaLabel?: string }) => (
  <section id={id} aria-label={ariaLabel} className="py-20 md:py-28">
    <div className="container max-w-6xl mx-auto px-4">{children}</div>
  </section>
);

const SectionTitle = ({ children }: { children: React.ReactNode }) => (
  <motion.h2
    variants={fadeUp} initial="hidden" whileInView="visible" viewport={{ once: true }}
    className="text-2xl md:text-3xl font-bold text-center mb-12"
  >
    {children}
  </motion.h2>
);

export default Landing;
