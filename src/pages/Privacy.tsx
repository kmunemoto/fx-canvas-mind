import LegalPageLayout from "@/components/LegalPageLayout";

const Privacy = () => (
  <LegalPageLayout title="プライバシーポリシー">
    <section>
      <h2>第1条（個人情報の定義）</h2>
      <p>本プライバシーポリシーにおいて、個人情報とは個人情報保護法に定める個人情報を指します。</p>
    </section>

    <section>
      <h2>第2条（収集する情報）</h2>
      <p>当サービスは以下の情報を収集します:</p>
      <ul>
        <li>メールアドレス</li>
        <li>認証情報（パスワードはハッシュ化して保存）</li>
        <li>利用履歴（分析実行履歴、ログイン日時等）</li>
        <li>決済情報（クレジットカード情報はStripe社が管理し、当サービスは保持しません）</li>
      </ul>
    </section>

    <section>
      <h2>第3条（利用目的）</h2>
      <p>収集した情報は以下の目的で利用します:</p>
      <ul>
        <li>サービスの提供および運営</li>
        <li>ユーザーサポート</li>
        <li>利用状況の分析とサービス改善</li>
        <li>重要なお知らせの送信</li>
        <li>不正利用の防止</li>
      </ul>
    </section>

    <section>
      <h2>第4条（第三者提供）</h2>
      <p>法令に基づく場合を除き、ユーザーの同意なく個人情報を第三者に提供することはありません。ただし以下の業務委託先には、サービス提供のため必要な範囲で情報を提供します:</p>
      <ul>
        <li>Supabase（データベース・認証）</li>
        <li>Stripe（決済処理）</li>
        <li>Anthropic（AI分析）</li>
        <li>Twelve Data（市場データ取得）</li>
      </ul>
    </section>

    <section>
      <h2>第5条（情報の管理）</h2>
      <p>収集した情報は適切なセキュリティ対策のもと管理し、漏洩・改ざん・不正アクセスを防止します。</p>
    </section>

    <section>
      <h2>第6条（Cookie等の利用）</h2>
      <p>当サービスはユーザー体験向上のためCookieおよび類似技術を使用します。</p>
    </section>

    <section>
      <h2>第7条（開示・訂正・削除）</h2>
      <p>ユーザーは自己の個人情報について開示・訂正・削除を請求できます。お問い合わせ窓口までご連絡ください。</p>
    </section>

    <section>
      <h2>第8条（プライバシーポリシーの変更）</h2>
      <p>当社は必要に応じて本ポリシーを変更することがあります。重要な変更がある場合はサービス上で通知します。</p>
    </section>

    <section>
      <h2>第9条（お問い合わせ）</h2>
      <p>個人情報に関するお問い合わせ:<br />FX Tactical Labs<br />メールアドレス: k.munemoto@kyoto-salute.com</p>
    </section>

    <p className="text-sm text-muted-foreground/60 pt-6 border-t border-white/5">制定日: 2026年4月16日</p>
  </LegalPageLayout>
);

export default Privacy;
