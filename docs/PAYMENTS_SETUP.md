# 決済連携の手順（2026-09-10 時点）

決済がつながっていない原因と、つなぐために必要な作業を、**誰がやるか**で分けて書く。

この文書は Stripe を前提に書いてあるが、**§1 の不具合はどの決済会社を使っても直す必要がある**。
アプリ側の実装の問題であって、Stripe 固有ではない。

---

## 0. 前提の確認（ここを飛ばすと §2 以降が全部無駄になる）

**Stripe アカウント `acct_1TMeh9RjOhHsWH4G` は 2026-05-25 に閉鎖されている。**
理由は「禁止業種に該当」。§2 以降の手順は、**使えるアカウントがあること**を前提にしている。

閉鎖の判定は事業内容に対して出ているので、同じ商品のまま別アカウントを作っても同じ結果になる。
商品の作り替え（`docs/` の他の記録と、リポジトリの履歴を参照）が先。

---

## 1. アプリ側の不具合（こちらで直す。決済会社を問わない）

### 1.1 【重大】metadata のキーが送信側と受信側で違う

決済は成立するのに、**プランが永久に上がらない**。

```
create-checkout/index.ts:89   metadata: { supabase_user_id: user.id, plan }
stripe-webhook（本番のみ）    const userId = session.metadata?.user_id;
```

`user_id` は常に `undefined` なので `if (userId && session.subscription)` の中身が丸ごと飛ぶ。
`profiles.plan` も `stripe_subscription_id` も書かれない。

**症状**: 利用者は課金されるが、アプリはずっと `free` のまま。「払ったのに使えない」。

### 1.2 【重大】stripe-webhook のソースが git に無い

本番の Supabase にしか存在しない。`entrypoint_path` が
`/workspaces/fx-canvas-mind/supabase/functions/stripe-webhook/index.ts` を指しており、
今は存在しない Lovable のワークスペースからデプロイされたきり。

レビューもテストも再デプロイもできない。リポジトリに取り込む。

### 1.3 【重大】未知の価格IDで、課金中の利用者を `free` に落とす

```
const plan = PRICE_TO_PLAN[priceId] || "free";
await supabase.from("profiles").update({ plan }).eq("stripe_customer_id", ...);
```

`customer.subscription.updated` は、金額変更・支払い方法変更・期間更新など**ふつうに何度も飛ぶ**。
`STRIPE_PRICE_*` が未設定、あるいは Stripe 上の価格IDと 1 文字でも違えば、そのたびに `free` に落ちる。

直し方: 未知の価格IDは**現状維持＋エラー記録**にする。プランを下げるのは
`customer.subscription.deleted` だけの仕事。

### 1.4 `STRIPE_PRICE_*` が未設定だと、対応表が壊れる

```
const PRICE_TO_PLAN = {
  [Deno.env.get("STRIPE_PRICE_LIGHT") || ""]: "light",
  [Deno.env.get("STRIPE_PRICE_STANDARD") || ""]: "standard",
  [Deno.env.get("STRIPE_PRICE_PRO") || ""]: "pro",
};
```

3 つとも未設定なら、キー `""` の 1 件だけを持つオブジェクトになる（最後の `pro` が勝つ）。
起動時に 3 つ揃っていることを確認して、欠けていたら**動かずに落ちる**ようにする。

### 1.5 DB 更新の失敗を握り潰して Stripe に 200 を返す

```
if (error) console.error("DB update error:", error);
return new Response(JSON.stringify({ received: true }), ...);
```

Stripe は「届いた」と判断して再送しない。**課金は通ったがプランは上がらず、記録も残らない。**
DB 更新に失敗したら 5xx を返し、Stripe の再送に任せる。

### 1.6 success_url が Lovable のドメインを決め打ちしている

```
success_url: `${returnUrl || "https://fx-canvas-mind.lovable.app"}?checkout=success`
```

`returnUrl` が来なければ、決済後に旧ドメインへ飛ばされる。現行ドメインに直す。

### 1.7 【要確認】API バージョンが webhook 側とコード側で違う

- Webhook エンドポイントの登録: **2026-03-25.dahlia**
- コードの SDK 固定: `apiVersion: "2023-10-16"`（create-checkout / cancel-subscription / webhook すべて）

受信するイベントの本文はエンドポイント側のバージョンで組み立てられ、こちらから叩く API は
SDK 側のバージョンで返る。**この 2 つがずれていると、フィールドの位置が違う可能性がある。**

とくに `cancel-subscription/index.ts:76` の `updated.current_period_end` は、新しい API
バージョンで場所が変わっている可能性がある（Stripe のドキュメントはこの実行環境から参照できない
ため、**未確認**）。どちらかに揃えるのが正しく、揃える前に必ず Stripe のダッシュボードで
実際のイベント本文を 1 件見て確かめること。**推測で直さない。**

---

## 2. ダッシュボード側の手順（オーナーがやる）

### 2.1 モードを決める

右上の**テストモード**トグル。テストと本番で、APIキー・価格ID・署名シークレットが**すべて別物**。
ここを混ぜるのが一番多い失敗。まずテストモードで通してから本番に移す。

### 2.2 商品と価格を 3 つ作る

**商品** → **商品を追加**。`light` / `standard` / `pro` の 3 つ。

- 料金体系: **継続（Recurring）** ← 買い切りにするとサブスクにならない
- 請求期間: 月次
- 通貨: JPY

作成後、各価格の **`price_` で始まる ID** を控える。商品ID（`prod_`）ではなく**価格ID**。

**確認**: 商品一覧で 3 つとも「継続」と表示されていること。

### 2.3 Webhook エンドポイント

**開発者** → **Webhook**。

- URL: `https://endcqzewujdvimdlazhj.supabase.co/functions/v1/stripe-webhook`
- イベント（現行コードが処理するのはこの 3 つだけ。増やしてもコード側が無視する）
  - `checkout.session.completed` … 初回契約でプランを上げる
  - `customer.subscription.updated` … プラン変更を反映する
  - `customer.subscription.deleted` … 解約で `free` に戻す

登録後に表示される**署名シークレット（`whsec_` で始まる）**を控える。

**確認**: エンドポイントが「アクティブ」で、リッスン対象が 3 件。

### 2.4 Supabase にシークレットを 5 つ入れる

Supabase ダッシュボード → **Edge Functions** → **Secrets**。
**名前がこの通りでないと動かない**（コードが `Deno.env.get` で読む名前）。

| 名前 | 値 |
|---|---|
| `STRIPE_SECRET_KEY` | `sk_test_...` または `sk_live_...` |
| `STRIPE_WEBHOOK_SECRET` | §2.3 の `whsec_...` |
| `STRIPE_PRICE_LIGHT` | ライトの `price_...` |
| `STRIPE_PRICE_STANDARD` | スタンダードの `price_...` |
| `STRIPE_PRICE_PRO` | プロの `price_...` |

**値をチャットや git に貼らないこと。** ダッシュボードで直接入力する。

**確認**: この 5 つは、このセッションからは**読めない**。入力したことはオーナーしか確認できない。

---

## 3. つながったことの確かめ方

§1 を直して再デプロイし、§2 を終えてから、テストモードで 1 件通す。

1. アプリから購入 → Stripe のテストカード `4242 4242 4242 4242` で決済
2. Stripe の **Webhook** → 該当エンドポイント → **イベントの配信** で
   `checkout.session.completed` が **200** で配信されていること
3. データベースで、その利用者の行が上がっていること

```sql
select plan, stripe_customer_id is not null as has_customer,
       stripe_subscription_id is not null as has_subscription, updated_at
from public.profiles where id = '<user_id>';
```

`plan` が `light` / `standard` / `pro` のいずれかになり、`has_subscription` が `true` なら成功。
`free` のままなら §1.1 が残っている。

4. 解約 → `customer.subscription.deleted` が 200 で配信され、`plan` が `free` に戻ること

`public.profiles` の `plan` は `profiles_plan_check` で
`free` / `light` / `standard` / `pro` のみ許可されている。他の値を書こうとすると制約で落ちる。

---

## 4. 順番

```
1. §1 の不具合を直す（こちら）           ← 決済会社が決まる前でもできる
2. stripe-webhook を git に取り込む（こちら）
3. §2.1〜2.4（オーナー）
4. 再デプロイ（こちら）
5. §3 でテストモードの 1 件を通す
6. 本番モードで §2.2〜2.4 をやり直す（キーも価格IDも署名シークレットも別物）
```

§1 と §2 は互いに独立なので、どちらから始めてもよい。
ただし **§3 の確認は両方が終わっていないとできない**。
