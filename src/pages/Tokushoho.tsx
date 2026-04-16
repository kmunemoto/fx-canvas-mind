import LegalPageLayout from "@/components/LegalPageLayout";

const rows = [
  ["販売事業者", "FX Tactical Labs"],
  ["運営統括責任者", "宗本 寛太"],
  ["所在地", "〒604-0902 京都府京都市中京区毘沙門町533-1 プラザ御所南 2階"],
  ["電話番号", "お問い合わせはメールにて承ります。請求があった場合は遅滞なく開示いたします。"],
  ["メールアドレス", "k.munemoto@kyoto-salute.com"],
  ["販売URL", "https://fx-canvas-mind.lovable.app"],
  ["販売価格", "各プランページに記載の通り（Light: 月額¥2,980、Standard: 月額¥5,980、Pro: 月額¥12,800、すべて税込）"],
  ["商品代金以外の必要料金", "インターネット接続料金等の通信費はお客様負担"],
  ["支払方法", "クレジットカード決済（Stripe）"],
  ["支払時期", "お申し込み時に初回課金、以降は月次自動更新"],
  ["サービス提供時期", "決済完了後、即時利用可能"],
  ["返品・キャンセルについて", "デジタルサービスの性質上、お申し込み後のキャンセル・返金は原則承っておりません。ただしサービスに重大な不具合があった場合はこの限りではありません。"],
  ["解約方法", "マイページからいつでも解約可能。解約後も契約期間終了日までご利用いただけます。"],
  ["動作環境", "モダンなWebブラウザ（Chrome、Safari、Firefox、Edge最新版）"],
];

const Tokushoho = () => (
  <LegalPageLayout title="特定商取引法に基づく表記">
    <div className="space-y-0">
      {rows.map(([label, value]) => (
        <div key={label} className="flex flex-col sm:flex-row gap-1 sm:gap-4 py-4 border-b border-white/5">
          <span className="text-foreground font-semibold min-w-[180px] shrink-0 text-sm">{label}</span>
          <span className="text-sm">{value}</span>
        </div>
      ))}
    </div>
    <p className="text-sm text-muted-foreground/60 pt-6 border-t border-white/5">制定日: 2026年4月16日</p>
  </LegalPageLayout>
);

export default Tokushoho;
