import LegalPageLayout from "@/components/LegalPageLayout";

const Legal = () => (
  <LegalPageLayout title="特定商取引法に基づく表記" japaneseOnly>
    <div className="space-y-6">
      {[
        ["販売事業者", "FX Tactical Analyzer 運営事務局"],
        ["運営統括責任者", "（代表者名）"],
        ["所在地", "（所在地を記載）"],
        ["電話番号", "（電話番号を記載）"],
        ["メールアドレス", "support@fx-tactical-analyzer.com"],
        ["販売URL", "https://fx-canvas-mind.lovable.app"],
        ["販売価格", "Light: ¥2,980/月、Standard: ¥5,980/月、Pro: ¥12,800/月（税込）"],
        ["追加手数料", "なし（決済手数料は当社が負担）"],
        ["支払方法", "クレジットカード（Visa、Mastercard、American Express、JCB）"],
        ["支払時期", "サービス利用開始時に即時決済。以降、契約期間ごとに自動更新・決済"],
        ["商品の引渡時期", "決済完了後、即時にサービスをご利用いただけます"],
        ["返品・キャンセル", "デジタルサービスの性質上、購入後の返金はお受けしておりません。サブスクリプションの解約は次回更新日の前日までにマイページから手続きを行ってください。解約後も契約期間終了まではサービスをご利用いただけます"],
        ["動作環境", "最新版のGoogle Chrome、Safari、Firefox、Microsoft Edgeを推奨。インターネット接続が必要です"],
      ].map(([label, value]) => (
        <div key={label} className="flex flex-col sm:flex-row gap-1 sm:gap-4 py-3 border-b border-white/5">
          <span className="text-foreground font-semibold min-w-[160px] shrink-0">{label}</span>
          <span>{value}</span>
        </div>
      ))}
    </div>

    <p className="text-sm text-muted-foreground/60 pt-6 border-t border-white/5">最終更新日: 2026年4月16日</p>
  </LegalPageLayout>
);

export default Legal;
