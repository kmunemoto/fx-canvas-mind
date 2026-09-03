import LegalPageLayout from "@/components/LegalPageLayout";

const rows: [string, string][] = [
  ["販売事業者", "宗本寛太"],
  ["運営責任者", "宗本寛太"],
  ["所在地", "〒607-8189 京都府京都市山科区大宅細田町98-38"],
  ["電話番号", "090-8386-0894（受付時間: 平日10:00〜18:00）"],
  ["メールアドレス", "k.munemoto@kyoto-salute.com"],
  [
    "販売価格",
    "Lightプラン: 月額2,980円（税込）\nStandardプラン: 月額5,980円（税込）\nProプラン: 月額12,800円（税込）",
  ],
  ["商品代金以外の必要料金", "通信費はお客様のご負担となります"],
  ["支払方法", "クレジットカード決済（Stripeを通じて処理）"],
  ["支払時期", "月額料金は毎月、申し込み日と同日に自動課金されます"],
  ["商品の引渡時期", "決済完了後、即時にサービスをご利用いただけます"],
  [
    "返品・返金について",
    "デジタルサービスの性質上、原則として返品・返金には応じておりません。ただし、運営者の責による重大な不具合が発生した場合は、個別にご相談ください",
  ],
  [
    "解約方法",
    "アプリ内のマイページからいつでも解約手続きが可能です。解約後も契約期間終了日までサービスをご利用いただけます",
  ],
  ["動作環境", "最新のWebブラウザ（Chrome、Safari、Edge等）を推奨します"],
];

const Tokushoho = () => (
  <LegalPageLayout title="特定商取引法に基づく表記" japaneseOnly>
    <div className="space-y-0">
      {rows.map(([label, value]) => (
        <div key={label} className="flex flex-col sm:flex-row gap-1 sm:gap-4 py-4 border-b border-white/5">
          <span className="text-foreground font-semibold min-w-[200px] shrink-0 text-sm">{label}</span>
          <span className="text-sm whitespace-pre-line">{value}</span>
        </div>
      ))}
    </div>
    <p className="text-sm text-muted-foreground/60 pt-6 border-t border-white/5">最終更新日: 2026年4月18日</p>
  </LegalPageLayout>
);

export default Tokushoho;
