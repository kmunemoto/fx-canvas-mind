# 判定・学習ループの不変条件と運用手順

FX Tactical Analyzer の裏で回っている「プラン → 判定 → 検証 → ルールブック → 次のプラン」のループについて、
**壊してはいけない前提（不変条件）** と **手で行う運用手順** を 1 か所にまとめたもの。
コード中のコメントが一次資料で、この文書はその索引。数値は 2026-09-05 時点のコードから写した。
食い違いを見つけたらコードが正しい。この文書を直すこと。

- 判定: `supabase/functions/track-outcomes/`（`evaluate.ts` が純粋ロジック、`quotes.ts` が Bid/Ask 取得、`index.ts` が入口）
- 検証と学習: `supabase/functions/postmortem/`（`facts.ts` が事実の算出、`prompt.ts` が診断とルール改訂、`index.ts` が入口）
- プラン生成: `supabase/functions/analyze/`（`entry.ts` がエントリーゲート、`rules.ts` がルールブックの選別）
- 共有: `supabase/functions/_shared/contract.ts`（契約）、`_shared/market-hours.ts`（休場判定）

---

## 1. ループの全体像

```
analyze ──(analyses 行を書く: plan_contract, price_at_signal, entry_point, SL/TP)──▶ public.analyses
   ▲                                                                                   │
   │ rulebook_for_client / システムプロンプトへ注入                                       ▼
public.rulebook ◀──(改訂: revisionDue)── postmortem ◀──(closed_at + 待ち時間)── track-outcomes
                                             │                                          │
                                             └──▶ public.lessons                        └──▶ analyses.evaluation / outcome
```

1. **analyze** がプランを書く。現行契約ではサーバが分析時点の価格で成行約定させる（§2）。
2. **track-outcomes** が cron で 15 分ごとに走り、期限内の pending プランを実際の値動きで判定する（§3）。
3. **postmortem** が cron で 15 分ごとに走り、判定済みプランの「なぜ」を事実に基づいて診断し、`lessons` を書く。
   新しい教訓が溜まる／時間が経つとルールブックを改訂する（§4）。
4. 改訂されたルールブックは次の analyze のプロンプトに入る。ただし **現行契約の下で得た証拠を持つルールだけ** が出る。

すべての段階は「同じ入力なら同じ出力」を目指している。sweep が何時に走ったか、何回走ったかで結果が変わってはいけない。

---

## 2. 契約（plan_contract）

`_shared/contract.ts` の 2 つの定数が「プランがどんな約束の下で書かれたか」を決める。

| 定数 | 値 | 意味 |
|---|---|---|
| `PLAN_CONTRACT` | `market_v1` | **現行**。サーバが分析時点の価格（`price_at_signal`）で約定させる。モデルは SL と TP だけ置くか WAIT を答える。未約定は起こらない。 |
| `LEGACY_PLAN_CONTRACT` | `entry_chosen_v1` | 旧契約。モデルがエントリー価格を選んでいた。届かなければ `untriggered`。列が無かった時代の行はすべてこれ。 |

**不変条件**

- 契約は前にしか進まない。`plan_contract` が null の行は旧契約とみなす。
- 2 つの契約は 2 つの母集団。統計は混ぜない（`src/lib/outcomeStats.ts` の `contractKey`）。
- ルールブックの各ルールは **証拠を得た時代の契約** でスタンプされる（`evidence_contracts` / `contract`）。改訂時の現行契約ではない。
  analyze は現行契約のルールだけをプロンプトに出し（`analyze/rules.ts` の `inForce`）、他は `changes.held_back` に残る。
- `market_v1` では `entry_point` と `price_at_signal` は同じ丸めた定数から書かれる。判定側の `classifyOrder` はこれを `market` と分類し、シグナルの瞬間に約定させる。
  `FILL_TOLERANCE = 0.0002` はこの「同じ値」の許容幅で、旧契約の行にも効く。
- エントリーゲート（`analyze/entry.ts`）の閾値は ATR 比で書かれている: `MAX_STOP_ATR 1.0`、`MIN_STOP_ATR 0.4`、`MARKET_TOLERANCE_ATR 0.15`、`MAX_LIMIT_ATR 0.5`、
  `MIN_RISK_REWARD 1.2`、`MAX_RISK_REWARD 6`、`FALLBACK_ATR_RATIO 0.0015`、`TREND_ADX 25` / `RANGE_ADX 20`、`MOMENTUM_MODES = trend day / breakout`。
  ゲートが「約定可能性」を理由に拒否したプランは **shadow 行** として追跡だけ続ける（§4.4）。

---

## 3. 判定（track-outcomes）の不変条件

### 3.1 何をもって勝ち負けとするか

- プランは **価格がエントリーに届いてはじめてトレード** になる。その後 TP1 が SL より先なら `win`、SL が先なら `loss`。
- 1 本の足が両方に触れたら、その解像度では順序が分からない。より細かい足を要求し（§3.3）、それでも決まらなければ **推測せず `ambiguous`**。
- 結果は `win` / `loss` / `untriggered`（旧契約のみ）/ `expired` / `ambiguous` のいずれか。決められなかった理由は `evaluation.reason` と `evaluation.ambiguity` に残す。
- 判定が見たものは全部 `evaluation` に証拠として残す（`price_basis`、`refined_interval`、`spread_at_fill` / `spread_at_exit`、`mfe` / `mae`、`bars_after_signal` など）。

### 3.2 Bid/Ask で判定する

- 判定の価格は **GMO コイン FX 公開 API の Bid/Ask**（`quotes.ts`、キー不要）。BUY は ask で約定し bid で決済、SELL はその鏡。
  仲値で両端を判定すると SL には遅く TP には早く届き、誤差が両端とも勝ちの側に寄る。これを避けるための切替。
- Bid/Ask で判定した行は `evaluation.price_basis = "quotes"`。使えなかった行は Twelve Data の仲値で判定し `"mid"` と書く。
- 使えない条件: ペアが `GMO_SYMBOLS` に無い、判定足が `GMO_INTERVALS` に無い、プランが `MAX_QUOTE_LOOKBACK_MS`（3 日）より古い、
  `MAX_QUOTE_REQUESTS`（20 / run）の残りが 2 未満、または取得が途中で尽きた（その場合は行を触らず次の tick に回す）。
- **精査の細かい足も同じ feed から取る**（v12 以降）。粗い足が Bid/Ask なら細かい足も Bid/Ask（`fetchQuoteWindow`）。
  基準が食い違う結果は「失敗した 1 回」として扱い、その足で判定しない（`fetchRange` の basis 不一致 → null）。
  理由: スプレッド未満だけ bid に触れた SL は仲値の足では見えない。
- GMO の取引日キー: 1min/5min/15min/1hour は `YYYYMMDD`（JST の取引日、夏時間で 06:00 JST 開始を実測。冬は未実測でコードはどちらの規則も断定しない）、4hour 以上は `YYYY`。
  日をまたぐ窓は最大 4 キー分を近い順に歩き、粗い足 1 本分の隙間が埋まった時点で止める。

### 3.3 精査の梯子（refinement ladder）

| プランの足 | 判定足 `EVAL_INTERVAL` | 精査の段 `finerRung` | 再判定周期 `CHECK_EVERY_MS` |
|---|---|---|---|
| 15min | 15min | 5min | 15 分 |
| 1h | 15min | 5min | 1 時間 |
| 4h | 1h | 15min → 5min | 4 時間 |
| 1day | 1h | 15min → 5min | 4 時間 |

- 段は「今の足より必ず細かい」: 15 分超なら 15min、5 分超なら 5min、それ以下は無し（`finerRung`）。
- 1 プランあたり `MAX_REFINE_ATTEMPTS = 3` 回まで。失敗（null）は 1 回に数える。**予算切れによる `"deferred"` は数えない**（行は stamp されず次の tick へ）。
- 精査で分かった順序は `refined` / `refined_interval` に残す。分からなければ `ambiguous` と `ambiguity` の内訳。

### 3.4 形成中の足と週末

- **形成中の足は絶対に割らない。** `fetchRange` は `bar.t + bar.ms > nowMs` なら `"deferred"` を返す。
  閉じてから割るので、同じ足を後で見直しても結果は変わらない（「再判定 = 1 回で判定したのと同じ」がテストの不変条件）。
- シグナル足そのものが形成中なら `signal_bar_pending = true`。精査を次に回したなら `refine_pending = true`。
  どちらかが立っている行は **判定足 1 本分**（`min(cadence, INTERVAL_MS[eval_interval])`）で戻ってくる。市場が閉まっている間は通常周期（`isDue`）。
- 時間は **市場時間** で数える。エントリー有効期間 `ENTRY_WINDOW_MS`（15min 12h / 1h 48h / 4h 7d / 1day 30d）と
  期限 `EXPIRY_DAYS`（15min 5 / 1h 20 / 4h 60 / 1day 180）は実際に取引された足で数え、跨いだ足に適用する。週末は消費しない。
- 休場の述語は 2 つ（`_shared/market-hours.ts`）。安全側が逆なので混ぜない。
  - `isMarketClosed`: 「この足を捨ててよいか / 今エントリーできるか」。**最も狭い**休場（土曜全日、金 22:00Z 以降、日 21:00Z より前）。
  - `isPossiblyClosed`: 「足が無いのは feed の故障か」。**最も広い**休場（金 21:00Z 以降、日 22:00Z より前）。
    金 21–22Z と日 21–22Z は「開いているかもしれない時間」で、足が無くても欠損と数えない。
- 未来に日付が付いた足が来たらそのシリーズごと拒否する（`hasFutureCandles`、`FUTURE_SLACK_MS = 1 分`）。UTC 以外で返ってきた事故の再発防止。

### 3.5 1 回の sweep の予算と順序

| 定数 | 値 | 意味 |
|---|---|---|
| `SWEEP_COOLDOWN_MS` | 10 分 | 全体クールダウン。`tracker_state.last_sweep_at` を条件付き UPDATE で先取りする。 |
| `USER_COOLDOWN_MS` | 5 分 | ログイン直後のユーザー呼び出し用。 |
| `MAX_ROWS` / `MAX_WAIT_ROWS` | 60 / 20 | 1 回に見る BUY/SELL 行と WAIT 行の上限。 |
| `MAX_REQUESTS` | 5 | Twelve Data への要求数（シリーズ + 仲値の精査）。共有キーは 8/分。 |
| `MAX_QUOTE_REQUESTS` | 20 | GMO への要求数（粗い足 + Bid/Ask の精査）。 |
| `MAX_QUOTE_LOOKBACK_MS` | 3 日 | これより古いプランは仲値で判定。 |

- 行は `checked_at` の古い順。同じ pair × 判定足はまとめて 1 回で取る。予算が尽きたグループは stamp せず次の tick の先頭に回る。
- 返り値の `quote_refinements` は Bid/Ask の精査に使った要求数。これと `tracker_state.last_sweep_result` が「今回何をしたか」の記録。

---

## 4. 検証と学習（postmortem）の不変条件

### 4.1 いつ診断するか

- 判定が付いた行は `closed_at` から `AFTER_WAIT_MS`（15min 1h / 1h 2h / 4h 4h / 1day 8h）待って初めて対象になる。「その後どうなったか」が存在するため。
- その後の窓は `AFTER_BARS`（15min 24 / 1h 24 / 4h 12 / 1day 5）本。`MIN_AFTER_BARS = 8` 本に満たない診断は thin として窓が揃ったら再診断する。
- 1 回に診断するのは `MAX_PLANS_PER_RUN = 3`（管理者の手動実行は `MAX_PLANS_ADMIN = 6`）。失敗は `MAX_ATTEMPTS = 3` 回まで `postmortem.attempts` に積む。
- 壁時計の予算は `WALL_CLOCK_BUDGET_MS = 130 秒`。診断は残り `START_DIAGNOSIS_BEFORE_MS = 75 秒` を切ったら始めない。LLM 呼び出しは 45 秒で切る。
- 全体クールダウン `SWEEP_COOLDOWN_MS = 10 分` は `postmortem_state.last_run_at` の条件付き UPDATE で先取りする（判定側と同じ作り）。

### 4.2 事実（facts）が先、診断はその範囲内

- 診断は `facts.ts` が新しいローソク足から計算した事実に縛られる: 最大順行/逆行（`mfe_r` / `mae_r`）、決済後の値動き、
  反実仮想（成行で入っていたら、広い SL なら、近い TP なら）、経済指標との照合、そして **危うさ（`danger`）**。
- `danger` は勝ちトレードの「実は危なかった」を事実として測る（#36）。閾値: `UNDERWATER_RATIO 0.5`、`MIN_DANGER_BARS 4`、`CHOP_CROSSINGS 4`、
  `SPIKE_CLOSE_R 0.5`、`SPIKE_REVERSAL_R 1`、`LATE_LIFE_RATIO 0.75`、`LUCKY_MAE_R 0.8`。旗は `deep_mae` / `mostly_underwater` / `chop` / `spike_target` / `late_win`。
  `lucky_win` の診断は立った旗を引用しなければならない。
- 建玉中の足は約定足を含む（`x.t + barMs > filledMs`）。`life_used_ratio` は市場時間の足数で数え、壁時計では数えない。

### 4.3 ルールブックの改訂

- 改訂条件 `revisionDue`: **新しい教訓が 1 つ以上** かつ（`MIN_NEW_LESSONS = 5` 以上 **または** 前回 `updated_at` から `MIN_REVISION_INTERVAL_MS = 24h`）。
- 1 回の run で改訂は `MAX_REVISIONS = 1` 回。ルールは最大 `MAX_RULES = 10`、1 回の追加/削除は各 `MAX_RULES_ADDED` / `MAX_RULES_REMOVED = 2` まで。
- 統計は `MIN_STAT_N = 20` 件未満なら根拠にしない。support はサーバ側で実件数から算出する（モデルの申告を信じない）。
- クラスタ: 同じ原因が `CLUSTER_WINDOW_MS = 24h` 内に重なったものは 1 つに数え、`CLUSTER_REOPEN_MS = 4h` 空けば別クラスタ。クラスタ鍵に `user_id` は含めない（全アカウント学習）。
- 1 人のヘビーユーザーが占有しないよう `fairShare`（`RECENT_ROWS 300` × `FAIR_FETCH_MULTIPLE 3` から均等に取る）。
- ルールの契約スタンプは証拠の時代（§2）。現行契約と違うルールは `changes.held_back` に入り、削除はされないがプロンプトにも出ない。
- 旧版は `HISTORY_KEEP = 20` 世代保持。

### 4.4 shadow 行

- ゲートが「約定可能性」を理由に拒否したプランは、拒否されなかった場合の姿を `shadow = true` の別行として保存し（`shadow_of` が元）、判定と診断は普通に受ける。
- **ユーザー向けの履歴・成績には出さない。** `outcomeStats.ts` は `isShadow` を除外して別集計（`shadowTally`）、`loop_health` も `shadow = false` で数える。
  ゲートが正しかったかを測るための行であって、成績ではない。

---

## 5. cron の時刻と冪等性

`cron.job`（Supabase の pg_cron）。ジョブはマイグレーションではなく直接作られているので、時刻の正はデータベース。

| jobid | 名前 | schedule (UTC) | 呼び先 | timeout |
|---|---|---|---|---|
| 1 | `track-outcomes-sweep` | `3,18,33,48 * * * *` | `/functions/v1/track-outcomes` | 90 s |
| 4 | `postmortem-sweep` | `8,23,38,53 * * * *` | `/functions/v1/postmortem` | 120 s |
| 5 | `econ-calendar-sync` | `13 * * * *` | `/functions/v1/econ-calendar` | 60 s |
| 3 | `purge-cron-history` | `0 3 * * *` | `cron.job_run_details` の 7 日より古い行を削除 | – |

- 判定と診断は 5 分ずらしてある: 判定が付いた行を同じ 15 分枠の診断が拾えるように。
- 呼び出しは `net.http_post`（pg_net）。ヘッダ `x-sweep-token` の値は **SQL の中で `vault.decrypted_secrets` から読む**。トークンの文字列はどこにも書かない（§7）。
- 冪等性は関数側で担保する:
  - 全体クールダウン（10 分）を `tracker_state` / `postmortem_state` の **条件付き UPDATE 1 発** で先取りする。2 tick が同時に来ても片方は `skipped: "cooldown"` で帰る。
  - 判定は市場時間で数えるので、走る時刻に依存しない（§3.4）。同じ行を何度判定しても同じ結果。
  - 診断は `postmortem.status = done` の行を再診断しない（thin の再診断と `force` を除く）。
- 一時停止と再開:

```sql
select cron.alter_job(4, active := false);  -- postmortem を止める（デプロイ中など）
select cron.alter_job(4, active := true);
```

- 結果の確認:

```sql
select jobid, status, return_message, start_time from cron.job_run_details order by start_time desc limit 10;
select id, status_code, left(content, 300) from net._http_response order by id desc limit 5;
select * from public.tracker_state;   -- last_sweep_at, last_sweep_result
select * from public.postmortem_state; -- last_run_at, last_result
```

- 手動 sweep も同じ経路で打つ（トークンを手元に出さない）:

```sql
select net.http_post(
  url := 'https://endcqzewujdvimdlazhj.supabase.co/functions/v1/track-outcomes',
  headers := jsonb_build_object('Content-Type','application/json',
    'x-sweep-token', (select decrypted_secret from vault.decrypted_secrets where name = 'track_outcomes_sweep_token')),
  body := '{"mode":"sweep"}'::jsonb, timeout_milliseconds := 90000);
```

---

## 6. デプロイ手順

### 6.1 順序の不変条件

1. **エッジ関数を先に、フロントエンドを後に。** フロントは新しい `evaluation` の形を読むので、逆にすると古い関数が書いた行を新しい UI が読めない時間ができる。
2. 関数を変えたら **バージョン文字列を上げる**: `TRACKER_VERSION`（track-outcomes/index.ts）、`POSTMORTEM_VERSION`（postmortem/index.ts）、`FUNCTION_VERSION`（analyze/index.ts）。
   返り値と `*_state.last_result.version` に出るので、本番で「どれが動いているか」を確かめる唯一の手がかり。
3. デプロイしたものは **読み戻して sha256 を比べる** まで「デプロイ済み」と言わない。

### 6.2 手順

```sh
npm test                     # vitest 全件（現在 509）
npx tsc --noEmit -p tsconfig.app.json   # 既存エラー 12 件が基準。増やさない
npm run check:functions      # deno check（4 関数の入口）
npm run bundle:functions     # esbuild minify → supabase/functions/<slug>/bundle.js（gitignore 済み）
( cd supabase/functions/<slug> && timeout 6 deno run --allow-net --allow-env bundle.js ); echo $?   # 124 = 起動して待機中 = OK
```

- デプロイは保存済みワークフロー `.claude/workflows/deploy-edge-verified.js` で行う（`scriptPath` で起動、`args: { slug, version }`）。
  中身: `deploy_edge_function`（`entrypoint_path: "bundle.js"`, `import_map_path: "deno.json"`, `verify_jwt: false`, files = `deno.json {"imports":{}}` + `bundle.js`）→
  `get_edge_function` で読み戻し → ローカルと sha256 比較 → 不一致なら最大 3 回まで再デプロイ。
  バンドルは一度モデルの出力を経由するので写し間違いが起こり得る（実際に 2 度起きた）。検証を省かない。
- postmortem のバンドルは 70 KB 超で Read の 1 ページに収まらない。必ずワークフロー経由。
- 長い関数（postmortem）を差し替える間は cron を止めてよい: `cron.alter_job(4, active := false)` → デプロイ → `true`。判定側は 10 分クールダウンがあるので通常は不要。
- 本番での確認: 次の sweep の返り値（`net._http_response`）の `version` が新しいこと。analyze は認証なしで叩くと 401 と一緒に `version` と `diagnostics` を返す。

### 6.3 フロントエンド

1. PR → squash merge → `main`。
2. Lovable の `deploy_project`（project `5c09cdc7-f0d2-421a-8546-1ae88d357daa`、publish 名 `fx-canvas-mind`）。**フロントに変更があるときだけ。**
3. 公開確認: `index.html` を nocache で取り直し、参照している `assets/index-*.js` が新しいハッシュになっていること。CDN の反映に 2–3 分かかる。
4. 作業ブランチを `main` に揃える: `git checkout -B claude/app-confirmation-jvmk03 origin/main && git push --force-with-lease -u origin claude/app-confirmation-jvmk03`。

### 6.4 コミットに入れてはいけないもの

- `bundle.js`（gitignore 済み）、レビュー用の使い捨てテスト `src/test/zzprobe*.test.ts`、パスワードやトークンの文字列、モデルの識別子（コミットメッセージ・PR・コード）。

---

## 7. 秘密の扱い

| 秘密 | 置き場所 | 読める者 |
|---|---|---|
| sweep トークン | `vault.decrypted_secrets` の `track_outcomes_sweep_token` | `public.track_outcomes_sweep_token()`（`security definer`、**`service_role` のみ実行可**）と cron の SQL |
| `SUPABASE_SERVICE_ROLE_KEY` など | エッジ関数の環境変数 | 関数だけ |
| 管理者 | `ADMIN_EMAILS`（analyze / postmortem の定数） | `k.munemoto@kyoto-salute.com`, `munekan2989@gmail.com` が Pro 相当 |

**不変条件**

- トークンの値はリポジトリ、マイグレーション、チャット、ログのどこにも書かない。関数を SQL から呼ぶときは必ず `(select decrypted_secret from vault.decrypted_secrets where name = ...)` をヘッダ式に埋める。
- 関数は受け取ったトークンを RPC 経由で取り出した値と **定数時間比較** する（`constantTimeEqual`）。空文字は不一致。
- `consume_analysis_quota` / `release_analysis_quota` / `track_outcomes_sweep_token` は `service_role` だけが実行できる。`public`, `anon`, `authenticated` からは revoke 済み。
- `public.rulebook` はクライアントから直接 SELECT できない（#54）。読むのは `rulebook_for_client()`（`authenticated`）だけ。他ユーザーの `analysis_id` はクライアントに返さない。
- `loop_health()` は `authenticated`、`public_track_record()` は `anon` と `authenticated`。どちらも `security definer` で、返す数字は自分の行か全体の集計だけ。
- 上の grant を変えるときは必ず `authenticated` ロールとして RPC が動き直接 SELECT が拒否されることを SQL で確かめる。

---

## 8. 既知の限界

- **旧契約（`entry_chosen_v1`）の再導出**: pending の旧契約行を Bid/Ask や細かい足で判定し直すとき、指値の約定は細かい足から再導出する。
  「触れる前に反対側へ抜けた」足があれば約定を前倒しし、触れた足があれば再導出、どちらも無ければ前回の状態を引き継ぐ。
  細かい足が約定前の区間を歩けない場合は前回の判定を残す。詳細は `evaluate.ts` の "Known limits (legacy contract)" コメント。現在 pending の旧契約行は無い。
- **GMO の取引日の境界**: 夏時間で 06:00 JST 開始を実測。冬（NY 17:00 = 07:00 JST の可能性）は未実測。`fetchQuoteWindow` は 4 キーまで歩くので実用上は問題ないが、`jstDayKey` はどちらも断定しない。
- **仲値へのフォールバック**: 3 日より古いプラン、GMO に無いペア、予算切れが続いた行は Twelve Data の仲値で判定される。`price_basis` で見分けられる。
- **4h / 1day プランの精査**: 判定足が 1h なので 15min → 5min の 2 段を歩けるが、`MAX_REFINE_ATTEMPTS = 3` を共有する。
- **`ambiguous` は推測しない**: 精査を尽くしても順序が分からないプランは採点されない。件数と内訳は `evaluation.ambiguity` で計測している（#52）。発生源の分布を見てから規約を決める。
- **型検査の基準線**: `npx tsc --noEmit -p tsconfig.app.json` は既存のエラー 12 件がある。増やさないことだけを見ている。
- **未観測**: v12 の Bid/Ask 精査、`quote_refinements`、WAIT の採点、danger の閾値は本番の平日データでまだ十分に観測できていない。月曜の 1h 分析で観る。

---

## 9. 変更するときのチェックリスト

- [ ] 契約を変えるなら `_shared/contract.ts` だけを変え、旧契約の行が統計・ルール選別・判定で別扱いになることをテストで確認する。
- [ ] 判定ロジックを変えるなら「再判定 = 1 回判定」と「形成中の足を割らない」のテストを通す（`src/test/track-outcomes.test.ts`）。
- [ ] 新しい `evaluation` / `postmortem` のフィールドはフロントの型（`src/lib/types.ts`）と表示（`OutcomeDetail.tsx`）と i18n（`ja.ts` / `en.ts`、英語辞書に日本語を入れない）を同時に足す。
- [ ] cron の時刻を変えるなら `cron.job` を直接更新し、この表も直す。
- [ ] 関数を変えたらバージョン文字列を上げ、関数 → フロントの順にデプロイし、sha256 と本番の `version` を確認する。
- [ ] 秘密の文字列・モデル識別子・使い捨てテストがコミットに入っていないか `git diff --cached` で見る。
