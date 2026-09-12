# 判定・学習ループの不変条件と運用手順

FX Tactical Analyzer の裏で回っている「プラン → 判定 → 検証 → ルールブック → 次のプラン」のループについて、
**壊してはいけない前提（不変条件）** と **手で行う運用手順** を 1 か所にまとめたもの。
コード中のコメントが一次資料で、この文書はその索引。数値は 2026-09-05 時点のコードから写した。
食い違いを見つけたらコードが正しい。この文書を直すこと。

- 判定: `supabase/functions/track-outcomes/`（`evaluate.ts` が純粋ロジック、`quotes.ts` が Bid/Ask 取得、`waits.ts` が WAIT の採点、`index.ts` が入口）
- 検証と学習: `supabase/functions/postmortem/`（`facts.ts` が事実の算出、`prompt.ts` が診断とルール改訂、`index.ts` が入口）
- プラン生成: `supabase/functions/analyze/`（`entry.ts` がエントリーゲート、`rules.ts` がルールブックの選別、`price-source.ts` が価格 feed、`budget.ts` が時間予算）
- 経済指標: `supabase/functions/econ-calendar/`
- 共有: `supabase/functions/_shared/contract.ts`（契約）、`_shared/market-hours.ts`（休場判定）

---

## 1. ループの全体像

```
analyze ──(analyses 行を書く: plan_contract, price_at_signal, entry_point, SL/TP, rulebook_version)──▶ public.analyses
   ▲                                                                                                    │
   │ service role で直接読み、selectPromptRules で注入                                                    ▼
public.rulebook ◀──(改訂: revisionDue)── postmortem ◀──(closed_at + AFTER_WAIT_MS)── track-outcomes
                                             │                                                          │
                                             └──▶ public.lessons                        └──▶ analyses.evaluation / outcome / wait_check
```

1. **analyze** がプランを書く。現行契約ではサーバが分析時点の価格を成行のエントリーとして書き、シグナルの瞬間に約定させる（§2）。
2. **track-outcomes** が cron で 15 分ごとに走り、pending プランを実際の値動きで判定する。期限（`EXPIRY_DAYS`）を跨いだものはこの sweep が `expired` にする（§3）。
   WAIT も採点する（§3.6）。
3. **postmortem** が cron で 15 分ごとに走り、判定済みプランの「なぜ」を事実に基づいて診断し、`lessons` を書く。
   新しい教訓が溜まる／時間が経つとルールブックを改訂する（§4）。
4. 改訂されたルールブックは次の analyze のプロンプトに入る。ただし **現行契約の下で実行できるルール（`contract` が現行契約でスタンプされたもの）だけ** が出る。
   根拠が旧契約の記録だけでも、原因と文言が現行契約で実行可能なら「旧契約含む」の印付きで出る（`evidence_contracts` は表示にだけ使い、出すかどうかは決めない）。

すべての段階は「同じ入力なら同じ出力」を目指している。sweep が何時に走ったか、何回走ったか、誰が呼んだかで結果が変わってはいけない。

---

## 2. 契約（plan_contract）

`_shared/contract.ts` の 2 つの定数が「プランがどんな約束の下で書かれたか」を決める。

| 定数 | 値 | 意味 |
|---|---|---|
| `PLAN_CONTRACT` | `market_v1` | **現行**。サーバが分析時点の価格（`price_at_signal`）を成行のエントリーとして書く。モデルは SL と TP だけ置くか WAIT を答える。未約定は起こらない。 |
| `LEGACY_PLAN_CONTRACT` | `entry_chosen_v1` | 旧契約。モデルがエントリー価格を選んでいた。届かなければ `untriggered`。列が無かった時代の行はすべてこれ。 |

**不変条件**

- 契約は前にしか進まない。`plan_contract` が null の行は旧契約とみなす。
- 2 つの契約は 2 つの母集団。統計は混ぜない（`src/lib/outcomeStats.ts` の `contractKey`）。
- ルールブックの各ルールの `contract` は **その原因と文言を現行契約で実行できるか** で決まる（`postmortem/prompt.ts` の `stampFor`: 実行できれば改訂時の現行契約、できなければ null）。
  書かれた時期や証拠の時代からは決めない。証拠を得た時代は別フィールド `evidence_contracts`（引用 lesson の契約）に記録し、プロンプトの「旧契約含む」表示にだけ使う。
  analyze は現行契約のスタンプを持つルールだけをプロンプトに出す（`analyze/rules.ts` の `inForce`）。他のルールも `rulebook.rules` には残り、削除はされないがプロンプトには出ない。
  postmortem は改訂時にそうしたルールの id を `changes.held_back` に列挙し、`rulebook.stats.changes` と、sweep モードなら `postmortem_state.last_result` にも記録する（手動実行では返り値にだけ出る）。詳細は §4.3。
- `market_v1` では `entry_point` と `price_at_signal` は同じ丸めた定数から書かれる。判定側では `classifyOrder` がこれを `market` と分類し、`assessSignalBar` がシグナルの瞬間（`created_at`）に約定させる。
  判定時の約定価格（`evaluation.fill_price`）は、Bid/Ask 判定なら約定側のシグナル足終値（精査後は最初の細かい足の始値）、仲値判定なら `entry_point`（プランの数字。market_v1 では `price_at_signal` と同じ値）そのもの（`evaluate.ts` の `marketFillPrice`、§3.2）。Bid/Ask でもシグナル足が無ければ最初の後続足の始値、それも無ければ `entry_point` に落ちる。
- `FILL_TOLERANCE = 0.0002` はこの「同じ値」の許容幅（価格差ではなく基準価格に対する比率。0.02%、USD/JPY なら約 3 pips）で、旧契約の行にも効く。
- エントリーゲート（`analyze/entry.ts`）の距離・損切り幅の閾値は ATR 比で、残りはそれぞれの単位（RR 比、価格比、ADX 値、モード名）: `MAX_STOP_ATR 1.0`、`MIN_STOP_ATR 0.4`、`MARKET_TOLERANCE_ATR 0.15`、`MAX_LIMIT_ATR 0.5`、
  `MIN_RISK_REWARD 1.2`、`MAX_RISK_REWARD 6`、`FALLBACK_ATR_RATIO 0.0015`、`TREND_ADX 25` / `RANGE_ADX 20`、`MOMENTUM_MODES = trend day / breakout`。
  ゲートが「約定可能性」（`too_far` / `should_be_market`）を理由に拒否したプランは **shadow 行** として追跡だけ続ける（§4.4）。
  ただし market_v1 ではエントリーが常に現在値なので `inferEntryType` は必ず `market` を返し、この 2 つの拒否は起こらない。現行の analyze は shadow 行を書かない（本番の `analyses` に shadow 行は 1 件も無い。2026-09-05 時点）。
  実際に記録に出た拒否は `low_confidence` / `market_closed` / `poor_rr` の 3 種類だけで、**`incoherent` は 1 件も出ていない**。`stop_too_tight` と `target_out_of_reach` も 0 件（`entry_check.rejection` を全行で数えた。2026-09-08 13:50Z 実測で `low_confidence` 17 / `market_closed` 4 / `poor_rr` 1、母集団 59 行）。いずれも「約定可能性」の拒否ではないので shadow を作らない（本番の `analyses` に shadow 行は今も 1 件も無い）。
  **件数は 1 時間に数件のペースで動く**（この段落を書いてから読み直すまでの数分で `low_confidence` が 16 → 17 になった）。読むべきは「どの拒否が出て、どれが出ていないか」であって、写した数字ではない。数え直すなら `entry_check->>'rejection'` で group by すること。
  そして拒否の件数を「サーバが覆した回数」と読まないこと。2 段で外れる:
  1. `low_confidence` は**全行が `proposed_signal = WAIT`**。AI 自身が見送った行に確信度の下限が刻まれただけで、何も覆していない。`rejection` の文字列では区別できず、区別するのは `outcomeStats.ts` の `isRejected`（`signal = WAIT` かつ `proposed_signal` が BUY/SELL）。
  2. `market_closed` は **4 件すべてが `preview`**（休場中の下見）。`tally` は `isRejected` を呼ぶ**前に** shadow と preview を母集団から外すので（`outcomeStats.ts:358`、`:364`）、この 4 件はどの統計にも入らない。
  結果、**サーバが提案された BUY/SELL を覆した記録は `poor_rr` の 1 件だけ**（RR 1.19 対 下限 1.20。`outcomeStats.ts:151-155` が名指しているのがこの行）。画面が 16 と出していたのを 1 に直したのがこの 2 段で、ここで `market_closed` を足して「3 件」と書くと、その過大計上がそのまま戻る。

### 2.0 値動きの構造とダイバージェンス（サーバ計算）

- モデルには構造の判定を求めながら、日付も順序も距離も無いスイング価格を4つ渡していた。最初の21件のうち16件が「Lower Highs & Lower Lows」と答え、1件は必須項目を満たすためだけに空文字を返した。**判定ではなく強制された推測**だった。
  ダイバージェンスも同じで、「矛盾があれば必ず言及」と指示しながら最新足のRSIを1つしか渡していない。16文のうち2点を挙げたものは1つも無く、4文は別々のオシレーターを同一時点で比べたもの、14文がヘッジ表現だった。
- なので両方 **`structure.ts` / `divergence.ts` でコード側が計算**し、プロンプトに数値として渡す。全部 OHLC から計算でき、注文の意図に関する推測は一切含まない。
- **2つの規則がすべてを決める**:
  1. 閾値は必ず ATR の倍数。時間足が変わっても同じ意味になる。**ATR が無いときは名前付きの拒否**を返す（`0.1 * null` は JavaScript では 0 で、全閾値がティックノイズ検出器に化ける）。
  2. **確定足のみ**。形成中の足の「終値」は終値ではないので、走査すればブレイクを主張して数分後に取り消すことになる。呼び出し側が事前に切る。
- 主な定数: `BREAK_TOL_ATR = 0.10`（終値がこれだけ抜けて初めてブレイク）、`FLAT_TOL_ATR = 0.25`（これ以内は「同じ水準」）、`NEAR_TOL_ATR = 0.25`（これより近い水準は「余地」ではない）、`LEVEL_MERGE_ATR = 0.5`（これ以内は同じ水準の再テスト）。
  等値の許容が広いのは意図的。スイング同士は 1〜5 ATR 離れているので、数百分の1 ATR では**レンジ判定が永久に出ず全部トレンドになる** — 最初の21件の偏りそのもの。テストで固定している。
- **「直近2スイングの並び」は参照期間の構造ではない**。比較した2点は数本しか離れていないことがあり、200pips 下げた系列で「上昇」と答える確率が約8回に1回。なので:
  - 見出しは `直近2スイングの並び` と名乗り、**比較した2本を明示**する。
  - 隣に **参照期間の正味変化**（ATR建て）を出す。これは期間の質問に答える別の数値。
  - プロンプトは「判定はあなたの仕事。数値は数え直さず引用し、並びと正味変化が食い違ったらどちらを根拠にしたか書く」。**採用しろとは言わない**（言うと、偏った推測が疑えない計算値に変わるだけ）。
- ブレイクの状態は3値: `broken`（抜けたまま）/ `reclaimed`（その後の終値で戻された＝水準は生きている）/ `held`（終値では抜けていない）。
  `reclaimed` の判定は**現在までの全足**を見る（3本だけ見ていた頃、価格が40本・200pips 下に戻っている水準を「抜けたまま」と主張した）。
  `held` の水準は **ヒゲのみの突破回数** を出す。これが「ストップ狩り」の唯一の計算可能な根拠で、プロンプトが名指しで要求しているもの。
- 上値/下値余地は **全ての確定スイング**から探す（表示用にまとめた3水準からではない）。まとめた側から探していた頃、間の水準を飛ばして「余地21.6ATR」と印字し、61pips 上に水準があるのに「期間内に水準なし」と書いた。
- 距離とレンジ内位置は **約定価格**（`marketEntry`）基準。確定足の終値から測って生きた現在値の隣に出していた頃、エントリー足の最新足はほぼ常に形成中なので ATR建ての距離が全部ずれていた。ATR も**トリム後の系列**から取る（未トリムだと閾値が約7%きつくなる）。
- ダイバージェンスは**エントリー足のみ**。比較は両側とも **pivot 足の終値**（RSI が終値ベースなので、高値と突き合わせると「高値を付けて安値引け」の1本が教科書的ダイバージェンスに化ける）。
  拒否は必ず名前付き（`price_flat` / `rsi_flat` / `agree` / `pivots_too_close` / `rsi_warmup` / `few_pivots`）。RSI のウォームアップは **period の後から数える**（絶対index だと Wilder の種が残った点を通し、種だけ変えて同じ2点の判定が反転した）。
  隠れダイバージェンスは計算しないので、プロンプトで「主張するな」と明記する。
- 文字数は**測ってある**（テストで固定）: エントリー足で 900字未満、上位足は 200字未満（スキーマが上位足に求めるのは bias と note だけ）、拒否は 120字未満。

### 2.1 analyze 側の価格と受け付け条件

- エントリーは **仲値** を `pairDecimals`（JPY 3 桁 / 他 5 桁）で **1 回だけ** 丸めた定数。ゲート、`entry_point`、`price_at_signal`、`entry_check.price` の 4 か所が同じ定数 `marketEntry` を読む。プロンプトの「現在値」はモデル呼び出し前に `entrySnapshot.price` を同じ桁で丸めた文字列で、値は同じ。
  仲値なのは SMA・バンド・ATR・スイングがすべて仲値だから。スプレッドは判定で 1 回だけ課す（§3.2）。
- 1h だけ（`GMO_ANALYSIS_TIMEFRAMES`）、Twelve Data と並行して GMO の Bid/Ask を取り、`acceptOverlay` を通ればエントリー足の系列を GMO 仲値に差し替える
  （200 本以上、最新足が 2 本分より古くない、隙間が `MAX_GAP_INTERVALS` 以内、参照価格が最新足の高安から `MARKET_TOLERANCE_ATR`（0.15 ATR）以内。ATR が無いときだけ高安の内側を要求）。結果は `entry_check.price_feed`（twelve_data / gmo）と `feed_delta_atr`。
  予算 `PRICE_OVERLAY_BUDGET_MS = 8 秒`。GMO の失敗は分析を失敗させない。4h / 1day は GMO に 1week / 1month が無いので差し替えない。
- `priced_at` は市場データの fetch が解決した壁時計。`created_at − priced_at` がモデルの所要時間で、ユーザーが見た時点でのエントリー価格の古さ。
- サーバが受け付けるのは `ALLOWED_PAIRS`（7 ペア）と `TF_CHAIN` の 4 足だけ。**同じユーザーの** 同一ペア・同方向の pending 行（shadow を除く）が `OPEN_PLAN_WINDOW_HOURS = 24h` 内にあれば `context.open_same_direction` に数えて（上限 10 件）warnings に出す。他ユーザーの行は数えない。
- 分析に入る前に価格系列の健全性を検査する（`seriesHealth`）: `parseCandles` が null や 0 以下の値・高安が矛盾する足（`coherentBar`）を落とし、時刻で重複除去して昇順に並べ直す。
  エントリー足は 60 本、上位足は 2 本を最低ラインとし、最新足が `intervalMs × 3` より古ければ古すぎとする。エントリー足が通らなければ分析せず 502（`error_stage = "market_data_unhealthy"`、`diagnostics.issues` に理由）。取得は 4 足とも 250 本（`ENTRY_BARS` / `HIGHER_BARS`）で、上位足の SMA200 が計算できるだけの本数を必ず持つ。
- 指標のスナップショットは足が形成中かどうかを持つ（`barClosed` / `barsUsed`）。形成中なら確定足だけで計算し直した組（`closedSnapshots`）も作り、プロンプトには「この足はまだ形成中」と明記して両方を出す。
  雲は現在価格の下にある雲（26 本前の値から算出）と先行して描かれる雲（26 本先）を別の行に分ける（`cloudAt` / `cloudSide`）。SMA200 が本数不足なら「算出不能（足 n 本、200 本必要）」と書く。数値を書かないのは、足りない本数の平均を 200 本平均として読ませないため。
- モデルの答えはコード側でも検査する: 確信度が `MIN_CONFIDENCE = 60` 未満なら WAIT に落として返金し（`entry_check.rejection = "low_confidence"`）、
  TP1 < TP2 < TP3 の順序が壊れた段は落として `entry_check.tp_ladder_dropped` に理由を残す。`entry_check` には `confidence` / `confidence_floor` / `bars`（足ごとの本数）も入れる。
- 履歴の保存は **冪等**: 行の id をサーバ側で先に発番し（`crypto.randomUUID()`）、`Prefer: resolution=merge-duplicates` で最大 `SAVE_ATTEMPTS = 3` 回まで再試行する。
  再試行で同じプランが 2 行になると成績が二重に数えられる。3 回とも失敗したら分析を返さず `fail()`（`error_stage = "history_not_saved"`）でクレジットを返す。判定も診断も走らない結果を課金したまま返さない。
- 休場の判定は **広い述語** `isPossiblyClosed` で 2 回、ただし **役割が違う**（§2.2）。`check_market_hours`（到着時刻。下見にするかを決める）と `check_entry`（モデル応答後。20–40 秒の間に閉まることがある）。
  後者は `entry_check.rejection = "market_closed"` として残し、シグナルを WAIT に落とす。狭い述語では週に 1 時間の穴が空き、週末のギャップ越しの約定が「誰も取れない大勝ち」として記録される。

### 2.1.1 判断時点の読みは全部行に残す

- `context` に残すのは指標のスナップショットだけではない。`structure`（足ごと）・`divergence`（エントリー足）・`closed`（形成中の足を除いた読み）も入れる。
  以前は `computeStructure` / `detectDivergence` / `closedSnapshots` の結果がプロンプトの文字列にしか出ておらず、列に 1 つも残っていなかった。`closedSnapshots` のコメントは「記録は両方持たないと後から再現できない」と書いてあるのに、記録はどちらも持っていなかった。
- 直列化は各モジュールが自分で持つ（`compactStructure` / `compactDivergence`）。vitest が直接叩ける。
  `index` は落とす（系列が消えた後の配列位置は意味を持たない）。`barsAgo` と `datetime` は残す（後からでも意味がある）。価格はペアの桁、ATR 倍は 2 桁、`compactSnapshot` と揃える。
- `ok: false` の構造は **理由だけ**を残し、空の高安リストを付けない。`ok:false` の横に空配列があると「高安が無いと測定した」と読めてしまう。
- `closed` の要素が null なのは「別の読みが無かった」= 最新足が既に確定していて上の読みがそのまま確定足の読み、という意味。
- **行のサイズ**: 構造 1 足あたり約 1.5KB、3 足で約 4.7KB、ダイバージェンス約 0.25KB、確定足スナップショット最大約 1.5KB。既存の `context` が約 3KB なので 1 行がおよそ 3 倍になる。件数が増えたら測り直す。
- これが入ると `situation.ts` の軸に構造を足せる（今は指標だけなので「上値を切り下げている最中」が軸にできない）。ただし過去の行には無いので、足すのはデータが溜まってから。

### 2.2 下見（市場が閉まっている間）

- **閉まっているのは断る理由ではなく、プランを出さない理由**。以前は `check_market_hours` が 409 を返し、モデル呼び出しもクォータ消費も行の書き込みもせずに終わっていた。
  金曜 21:00 UTC 〜 日曜 22:00 UTC の **週 49 時間**（`market-hours.test` で毎時走査して固定）で、日本時間だと土 06:00 〜 月 07:00、つまり土日がまるごと入る。
  金曜終値までの指標・構造・ダイバージェンス・当てはまるルール・来週の指標は、日曜でもそのまま正しい。存在しないのはエントリーだけ。
- しかも文言が嘘だった。「見送り（WAIT）にしました」と言うが WAIT は作られていない。分析は 1 行も走らず、行も書かれていない。
- 現在は **下見（preview）** として実行する。既存の `check_entry` ゲートがそのまま使える: `marketShut` でシグナルを WAIT に落とし、`entry_point` / `stop_loss` / TP をすべて `—` にする。新しく足したのは行の印だけ。
- **到着時刻で決め、ゲートの時計を流用しない**（`previewMode` と `marketShut` は別変数）。開いている間に始まって閉場後に終わった回は、存在した値段で決めた本物の WAIT なので採点してよい。
- **採点されない仕組み**: 下見は `wait_plan` を書かない。track-outcomes の WAIT sweep も postmortem の WAIT 診断も `outcome=eq.skipped` **かつ `wait_plan` が非 null** で拾うので、書かなければ両方が素通りする。
  shadow 行も作らない（shadow は `outcome: pending` の追跡プランで、形状ゲート側の rejection が `too_far` のままになりうるため、ここを塞がないと週末のギャップで決済されるプランが 1 本開く）。
- **統計から外す**: `analyses.preview` 列。`performance_stats` は `mine` CTE で `preview = false` にするので、全スコープ・全次元・クラスタ・全比率が一度に外れる。`loop_health` は 3 つのカウントに明示的に足した（`wait_plan` 経由で偶然外れてはいたが、副作用で保たれる不変条件は壊れても誰も気づかない）。
  クライアント側は `outcomeStats.ts` の `isPreview` を `isShadow` と同じ 3 か所で見る。
- **数は隠さない**: `performance_stats().preview` に `total` と `last_at` を出す。除外したものが記録から消えるのは、黙って落とすのと同じ。
- **履歴には残す**（ユーザーの決定）。一覧に「下見」バッジを出す。**クォータは通常どおり消費する**（モデル呼び出しのコストは同じ）。
- **下見は直近終値より後の足を末尾から落とす**（`closedTail`＋狭い述語 `isMarketClosed`）。Twelve Data は閉場中も足を出し続け、それが平坦なため。
  初回の実測（2026-09-06 日曜 1h）: ATR 0.041（同ペア金曜の 0.385〜0.421 に対して約 1/10）、BB 幅 2.1 pips、価格・SMA20・SMA50・転換・基準がすべて 156.24 に潰れた。モデルはそれを「1h超凍結レンジ」と正しく描写した — **データの描写としては正しく、相場の描写としては誤り**。
  ATR はこのアプリの距離の単位（損切り幅・構造の許容・次の水準までの余地・`situation.ts` の `stretch` 軸）なので、1/10 になると全部が 10 倍遠く見える。
  狭い述語を使うのは、それが「この足を捨ててよいか」に答える方であり、track-outcomes が同じ足を落とすのに既に使っているから。両者が「足とは何か」で一致する。
  **末尾だけ**落とす。系列は昇順なので隙間ができない。`rawCounts` も同じだけ減らす（意図的な除去が「落としすぎ」の検査に引っかかると、壊れたフィードを捕まえるための検査が意味を失う）。
- **鮮度チェックの時計は 2 つあり、混ぜてはいけない**（`seriesHealth` の `nowMs` と `staleFromMs`）。
  `future_bar`（フィードが未来の足を返していないか）は **実時刻**で見る。休場かどうかと関係ない異常だから。`stale`（最後に取引した時点から見て古すぎないか）だけが `lastClose` を基準にする。
  最初の実装は `nowMs` ごと差し替えて本番に出し、金曜終値より新しい足が全部「未来の足」になって、ゲートが系列を古すぎではなく **新しすぎ**として弾いた（`issues: ["future_bar"]`）。`age_ms` は設定によらず実時刻の age を返す。
  テストは最終足の時刻を 1 点で固定せず、金曜 18:00 〜 日曜 05:03 を 1 時間刻みで走査する。1 点固定だと、この不具合はテストを通ってしまう（実際に通っていた）。
- 応答は `preview: true` と `market_opens_at`（`nextOpen`＝日曜 22:00 UTC＝月曜 07:00 JST）を返す。`nextOpen` は **遅い方**の開場を返す: 06:00 と言っておいて 07:00 まで analyze が断るより、1 時間遅く言う方がまし。
- 画面はこれをエラーではなく結果として出す（赤いトーストではなく結果の上のバナー）。以前はフロントに `market_closed` の分岐が 1 つも無く、409 が汎用エラー経路に落ちていた。

---

## 3. 判定（track-outcomes）の不変条件

### 3.1 何をもって勝ち負けとするか

- プランは **価格がエントリーに届いてはじめてトレード** になる。その後 TP1 が SL より先なら `win`、SL が先なら `loss`。
- 1 本の足が両方に触れたら、その解像度では順序が分からない。より細かい足を要求し（§3.3）、それでも決まらなければ **推測せず `ambiguous`**。
  例外は open-through（`step`）: 建玉がその足の始まる前から確実に開いていて（`fillCertainFrom` 以降）、始値がすでに SL / TP1 に達していれば、始値で決まった `loss` / `win` として `atOpen: true` を付け、細かい足は要求しない。
  逆行幅も始値時点で止める（足の残りは決済後の値動き。丸ごと入れると `mae_r` が膨れ、綺麗な勝ちが `lucky_win` になる）。約定足そのものには適用しない。
- シグナル足を割るとき、シグナル以前のサブ足と **シグナルを含むサブ足** は捨てる（プランが無かった時間の値動きでは決着させない）。
  サブ足が全部シグナル以前なら `"empty"`: 失敗に数えず、掠りは残したまま終端の `ambiguous`。
- 成行の約定は、シグナル足を見直す sweep（前回の約定が無い、または `signal_bar_pending` が立っている間）のたびに再導出される（Bid/Ask なら約定側のシグナル足終値、シグナル足を割った後は最初のサブ足の始値）。
  シグナル足が済んだ後の sweep は成行でも前回の `filled_at` / `fill_price` を引き継ぐ（`prevFill` の短絡）。見直す sweep の中で前回の約定を `prior` として渡すのは指値・逆指値だけ。
- 結果は `win` / `loss` / `untriggered`（旧契約のみ）/ `expired` / `ambiguous` のいずれか。決められなかった理由は `evaluation.reason`（`missed` / `invalidated` / `no_fill` は `untriggered` の内訳で旧契約のみ、ほかに `incoherent` / `no_data`）と `evaluation.ambiguity` に残す（`ambiguity.site` の語彙は §8）。
- 判定が見たものは全部 `evaluation` に証拠として残す（`price_basis`、`refined_interval`、`spread_at_fill` / `spread_at_exit`、`mfe` / `mae`、`bars_after_signal` など）。

### 3.2 Bid/Ask で判定する

- 判定の価格は **GMO コイン FX 公開 API の Bid/Ask**（`quotes.ts`、キー不要）。BUY は ask で約定し bid で決済、SELL はその鏡。
  仲値で両端を判定すると SL には遅く TP には早く届き、誤差が両端とも勝ちの側に寄る。これを避けるための切替。
- Bid/Ask で判定した行は `evaluation.price_basis = "quotes"`。使えなかった行は Twelve Data の仲値で判定し `"mid"` と書く。
- 仲値に落ちる条件: ペアが `GMO_SYMBOLS` に無い、判定足が `GMO_INTERVALS` に無い、プランが `MAX_QUOTE_LOOKBACK_MS`（3 日）より古い、
  取得した Bid/Ask の足が空か市場が開いている間に `MAX_GAP_INTERVALS`（3 本）を超える穴がある（`quotes incomplete`）、または取得が例外で落ちた。
- 次の tick に回す条件（行を触らず、仲値でも判定しない）: `MAX_QUOTE_REQUESTS`（20 / run）の残りが 2 未満で走り出せない、または走っている途中で予算が尽きた（`quotes deferred`）。
  仲値に落とさないのは、シグナル足を見直し中（`signal_bar_pending`）の成行はその sweep で約定価格が再導出されるため（§3.1）: 仲値で判定すると Bid/Ask で付けた約定価格（BUY なら ask）が `entry_point` で上書きされる。
- **精査の細かい足も同じ feed から取る**（v12 以降）。粗い足が Bid/Ask なら細かい足も Bid/Ask（`fetchQuoteWindow`）。
  基準が食い違う結果は「失敗した 1 回」として扱い、その足で判定しない（`fetchRange` の basis 不一致 → null）。
  理由: スプレッド未満だけ bid に触れた SL は仲値の足では見えない。
- GMO の取引日キー: 1min/5min/15min/1hour は `YYYYMMDD`（JST の取引日、夏時間で 06:00 JST 開始を実測。冬は未実測でコードはどちらの規則も断定しない）、4hour 以上は `YYYY`。
  - 粗い系列（`fetchQuotes`）は詰めた全キーを古い順に歩き、早止まりしない（48h で 5 キー = 10 要求、3 日の上限で 6 キー = 12 要求）。
  - 精査の窓（`fetchQuoteWindow`、粗い足 1 本分）だけは日付キーを近い順に歩く（前後 1 日ずつ詰めて 3 キー、JST の日付をまたぐ窓は 4 キー）。
    最初のキーは必ず取り、足が 1 本でも取れて、窓の中の開いている市場に細かい足 1 本分以上の穴が無くなった時点（`gap < rungMs`）で止める。
    穴が残れば `missing` として null（失敗 1 回）扱いにし、その足では判定しない（足が 1 本も無い・例外で落ちた場合も同じ）。ただし穴の原因が予算切れ（次のキーを `MAX_QUOTE_REQUESTS` が拒んだ）なら null ではなく `"deferred"` で、失敗には数えない。

### 3.3 精査の梯子（refinement ladder）

| プランの足 | 判定足 `EVAL_INTERVAL` | 精査の段 `finerRung` | 再判定周期 `CHECK_EVERY_MS` |
|---|---|---|---|
| 15min | 15min | 5min | 15 分 |
| 1h | 15min | 5min | 1 時間 |
| 4h | 1h | 15min（シグナル足のサブ足のみ → 5min） | 4 時間 |
| 1day | 1h | 15min（シグナル足のサブ足のみ → 5min） | 4 時間 |

- 段は「今の足より必ず細かい」: 15 分超なら 15min、5 分超なら 5min、それ以下は無し（`finerRung`）。
- 2 段目の 5min まで降りるのは **シグナル足を割った 15min サブ足だけ**。サブ足は `series` に継ぎ足され、後続足のループが `finerRung(15min)` で割る。
  シグナル足より後の 1h 足は 15min で 1 段止まり: そこでも順序が付かなければ `ambiguous`（`refined_interval = "15min"`）で確定する。`fetchRange` の呼び出しは 2 か所でどちらも再帰しない。
- 1 プランあたり `MAX_REFINE_ATTEMPTS = 3` 回まで。失敗（null）は 1 回に数える。**予算切れによる `"deferred"` は数えない**
  （`refine_attempts` はそのまま、行は `refine_pending = true` で stamp され、判定足 1 本分後に戻ってくる。§3.4）。stamp されずに次の tick の先頭へ回るのはグループ単位の予算切れ（§3.5）。
- 精査で分かった順序は `refined` / `refined_interval` に残す。分からなければ `ambiguous` と `ambiguity` の内訳。

### 3.4 形成中の足と週末

- **形成中の足は絶対に割らない。** `fetchRange` は `bar.t + bar.ms > nowMs` なら `"deferred"` を返す。
  閉じてから割るので、同じ足を後で見直しても結果は変わらない（「再判定 = 1 回で判定したのと同じ」が `src/test/track-outcomes.test.ts` の不変条件）。
- シグナル足がまだ済んでいない（形成中、閉じてから判定足 1 本分の市場時間が経つまで後続の足が無い、まだ配信されていない）なら `signal_bar_pending = true`。
  精査を次に回したなら `refine_pending = true`。シグナル足の掠りの精査を次に回した場合は両方立つ。
  例外はその sweep で閉じたシグナル足を最後まで割り終えた場合（`splitDone`）: 後続の足が無くても立てない（割り直しても得るものが無い）。判定が付いた行にも立たない。
  cron が :03/:18/:33/:48 なので、判定足が 1h の 4h / 1day プランは約 5 件に 4 件が最初の sweep でシグナル足形成中。判定足 15min のプランでは tick 直前の 3 分に作られたものだけ。
  金曜のプランは日曜まで待たない: `openMsSince` は狭い述語で数えるので 21–22Z を開場として banked し、判定足 1 本分がその夜のうちに埋まる（analyze は 21:00Z 以降のプランを書かない）。
- どちらかが立っている行は **判定足 1 本分**（`min(cadence, INTERVAL_MS[eval_interval])`）で戻ってくる。市場が閉まっている間は通常周期（`isDue`）。
- 時間は **市場時間** で数える。エントリー有効期間 `ENTRY_WINDOW_MS`（15min 12h / 1h 48h / 4h 7d / 1day 30d）と
  期限 `EXPIRY_DAYS`（15min 5 / 1h 20 / 4h 60 / 1day 180）は実際に取引された足で数え、跨いだ足に適用する。週末は消費しない。
  例外はデータの遅れ: 跨ぐ足がまだ無いのに、最後の足の閉場から壁時計で最大 2 本分を足すと期限を超えている場合だけ、`checked_at`（sweep 時刻）で打ち切る
  （未約定なら `no_fill`、建玉中なら最後の足の終値で `expired`）。`win` / `loss` / `expired` / `untriggered` の `resolved_at` が足の境界に乗らない唯一の経路（`ambiguous` は別で、精査の上限・`incoherent`・`window_short` は `checked_at`、シグナル足の掠りは `created_at` を打つ）。
- 休場の述語は 2 つ（`_shared/market-hours.ts`）。安全側が逆なので混ぜない。
  - `isMarketClosed`: 「この足を捨ててよいか / 市場時間をどう数えるか」。**最も狭い**休場（土曜全日、金 22:00Z 以降、日 21:00Z より前）。
  - `isPossiblyClosed`: 「足が無いのは feed の故障か / 今エントリーできるか」。**最も広い**休場（金 21:00Z 以降、日 22:00Z より前）。
    金 21–22Z と日 21–22Z は「開いているかもしれない時間」で、足が無くても欠損と数えない。信頼できる「今の価格」も無いので、analyze の `check_market_hours` と `marketShut` もこちらで判定する（§2.1）。
- 未来に日付が付いた足が来たら、仲値（Twelve Data）のシリーズはまるごと拒否する（`hasFutureCandles`、`FUTURE_SLACK_MS = 1 分`。BUY/SELL 行は `future_candles` で stamp、WAIT 行はその tick を飛ばす）。
  Bid/Ask（GMO）はシリーズごとには拒否せず、`usableBars` がその足だけ捨てる。UTC 以外で返ってきた事故の再発防止。

### 3.5 1 回の sweep の予算と順序

| 定数 | 値 | 意味 |
|---|---|---|
| `SWEEP_COOLDOWN_MS` | 10 分 | 全体クールダウン。`tracker_state.last_sweep_at` を条件付き UPDATE で先取りする。 |
| `USER_COOLDOWN_MS` | 5 分 | ユーザー呼び出し用。`profiles.last_tracked_at` を同じ作りで先取りする。 |
| `MAX_ROWS` / `MAX_WAIT_ROWS` | 60 / 20 | 1 回に見る BUY/SELL 行と WAIT 行の上限。 |
| `MAX_REQUESTS` | 5 | Twelve Data への要求数（シリーズ + 仲値の精査）。共有キーは 8/分。 |
| `MAX_QUOTE_REQUESTS` | 20 | GMO への要求数（粗い足 + Bid/Ask の精査）。 |
| `MAX_QUOTE_LOOKBACK_MS` | 3 日 | これより古いプランは仲値で判定。 |

- 行は `evaluation.checked_at` の古い順（一度も見ていない null の行が先頭、同値は `created_at` の古い順）。同じ pair × 判定足はまとめて 1 回で取る。
  予算が尽きたグループは stamp せず次の tick の先頭に回る。
- 返り値の `quote_refinements` は Bid/Ask の細かい足で精査した回数（feed が応答した分。予算で打ち切られた分は数えず `deferred` に入る）。
  要求数は `quote_requests`（粗い足 + 精査の合計。精査 1 回は日付キーごとに bid + ask の 2 要求）。これと `tracker_state.last_sweep_result` が「今回何をしたか」の記録。
- 呼び出し元は 2 つ: アプリがログイン直後にユーザーの JWT で叩く（`mode: user`、そのユーザーの pending 行だけ）、cron が sweep トークンで叩く（`mode: sweep`、全員）。
  判定ロジックは同じで、誰が呼んだかで結果が変わってはいけない。ユーザーモードは WAIT の採点を走らせず、`tracker_state.last_sweep_result` も書かない。
  `MAX_REQUESTS = 5` はユーザー呼び出しにも同じに効く。アプリが叩くのはログイン時だけで、分析直後には叩かない。
  直前の分析のシグナル足がまだ形成中なら、その行は `signal_bar_pending = true` で stamp されて `checked` に数えられ（掠りの精査が先送りされたときだけ `refine_pending` も立ち `deferred` に入る）、判定足 1 本分後の cron で戻ってくるのが正常。

### 3.6 WAIT の採点（waits.ts と analyze の wait_plan）

- WAIT も予測なので採点する。旧契約の `untriggered` が消えた今、これが「慎重すぎた」ことを示す **唯一の** 信号。採点しなければ学習ループは見送りを増やす方向にしか動けない。
- **方向は判断した時点で決めて保存する**（`waitPlanFor` → `analyses.wait_plan`）。採点側は保存された 1 本を歩くだけで、方向を選ばない。
  旧版は BUY と SELL を両方歩き、どちらかが利確に届けば `missed` とした。方向を選んでいたのは結果であって判断ではなく、半 ATR ずつ両側に振れる相場（十分な本数を取ればほとんどの相場）は、当時何が読めたかに関係なく `missed` になる。慎重すぎを測るための唯一の数字が、相場の値幅を測っていた。
- 方向の決め方（すべて判断時点の情報。`direction_source` に記録）: ①モデルが出したシグナルをサーバが却下した場合はその方向（`proposed_signal`）→ ②モデルが宣言した相場の方向 Up/Down（`declared_direction`）→ ③指標がトレンドと読んだ向き（`regime`）→ ④どれも無ければ **方向なし**（`none`）。
- 尺度は新しく作らない: `wait_plan.entry`（= 分析時点の丸めた現在値）から、ゲートが許す最小のトレード（損切り `MIN_STOP_ATR × ATR`、利確 `MIN_RISK_REWARD × 損切り幅`）。水準は plan に保存済みで、採点側は定数を読み直さない（後から定数を変えても過去の採点が黙って変わらない）。
- 判定: 保存された方向で利確が先なら `missed`（`r` は plan 自身の reward/risk）、損切りが先なら `correct`（`r = -1`）、期限内で生きていれば `pending`、期限切れで届かずなら `correct`（`r` は null。取っていない損は損ではない）、ATR か価格が無ければ `unknown`、
  **方向が決まっていなければ `no_call`**（採点しない。当たり・外れのどちらにも数えない）。1 本の足が両方に触れたら損切り扱い（疑わしいものを missed にしない）。
- `wait_check.scorer` にどの採点規則で出した判定かを刻む（2 = 判断時点の方向で 1 本だけ歩く現行版）。規則が違う判定は別の測定なので、1 つの miss rate に混ぜない。
- 期限は `ENTRY_WINDOW_MS` を **市場時間** で数える（`marketHorizonEnd`、30 分刻み。期限に壁時計 4 週を足した時点で打ち切る安全弁で、期限そのものを 4 週に縮めるものではない）。壁時計だと金曜の WAIT が週末で勝手に `correct` になる。
- 結果は `analyses.wait_check`（`wait_plan` とも `evaluation` とも別の列）。対象は `outcome = skipped` かつ `wait_check` が null または `verdict = pending` の行、`created_at` の古い順に `MAX_WAIT_ROWS = 20`。
  **sweep モードだけ**、BUY/SELL の判定が終わった後の残り予算（`MAX_REQUESTS`）でしか走らない。
- 統計: `wait_miss_rate` は `missed + correct` が `MIN_STAT_N` 以上で初めて出る。`pending` / `unknown` / `no_call` は分母にも入れない。
  サーバが却下した WAIT（`entry_check.rejection`。現行契約で起こるのは market_closed / low_confidence / stop_too_tight / poor_rr / target_out_of_reach）も採点され、`rejection` で区別する。
  ただし **`rejection` が付いているだけでは却下ではない**: 確信度の下限は AI 自身が WAIT と答えた行にも `low_confidence` を書く。却下と言えるのは `entry_check.proposed_signal` が BUY/SELL の行だけで、`proposed_signal = WAIT` は AI 自身の見送り（`isRejected` / `isSelfDeclined`、`performance_stats` の `rejected` / `self_declined`）。2026-09-08 実測で market_v1 の却下は 1 件、AI 自身の見送りが 16 件。`proposed_signal` が無い旧行はどちらにも数えない。
- 歩き始めは **`wait_plan.decided_at`**（市場データが解決した瞬間）で、`created_at`（INSERT の時刻）ではない。`created_at` はモデル呼び出し・ゲート・保存の後なので 30〜120 秒遅く、`judgeWait` は「その時刻より後に**始まる**足」しか見ないため、判定足 15 分の 1 本目がまるごと落ちていた。損切りが 0.4 ATR しかないので 1 本の差で判定が反転する。
- 移行時の実測: 本番の `skipped` 行は 3 件で全部 `verdict = unknown`・`bars_examined = 0`（`price_at_signal` も `entry_check` も無い時代の行）。両側採点は本番で 1 件も判定を出していないので、捨てた測定値は無い。

### 3.7 プロバイダの癖と時刻

- Twelve Data には必ず `timezone=UTC` を付けて要求する（既定は UTC ではない。最初のトラッカーはこれで壊れた）。返る `datetime` はゾーン無しなので `parseCandleTime` が `Z` を足す。
  取得本数は判定 `EVAL_OUTPUTSIZE`（15min 2000 / 1h 3200、`EXPIRY_DAYS` まで遡れる本数）、診断は `created_at − PRE_SIGNAL_MS(6h)` から。API キーは URL に載る。analyze はクライアントへ返すエラー文字列を `redactSecrets` に通す。track-outcomes / postmortem はプロバイダのエラー文を console にだけ出し、クライアントには定型文と `errors` の短い記号しか返さない。
- GMO: 各要求 10 秒で打ち切り。`mergeSides` は片側しか無い足と ask < bid の行を捨てる。`usableBars` は形成中の足を **残す**（高安は広がるだけ。割るのは §3.4 が止める）。
  隙間の許容は粗い系列で `MAX_GAP_INTERVALS = 3` 本、精査の窓は 1 本も欠けてはいけない。
- プロンプト内の時刻はすべて UTC。文章中の時刻を JST に換算させる指示があるのは analyze のプロンプトだけ（postmortem の診断プロンプトは「時刻は UTC」とだけ書き、改訂プロンプトは時刻に触れない）。

---

## 4. 検証と学習（postmortem）の不変条件

### 4.1 いつ、何件、どれだけの時間で診断するか

- 判定が付いた行は `closed_at` から `AFTER_WAIT_MS`（15min 1h / 1h 2h / 4h 4h / 1day 8h）待って初めて対象になる（`isPostmortemDue`）。「その後どうなったか」が存在するため。
  手動実行で `force: true` か `ids` を指定した場合はこの待ちを飛ばす。
- その後の窓は `AFTER_BARS`（15min 24 / 1h 24 / 4h 12 / 1day 5）本 × プランの足（`afterWindowMs`）。窓の中の足は判定足 `EVAL_INTERVAL` で数える。
  **単位が違う 2 つの「本」がある**: `AFTER_BARS` はプランの足で窓の長さを決め、`bars_after_settlement` は判定足で数えた実際の本数。
  1day の窓は日足 5 本＝120 時間で、その中に 1h 足が最大 120 本入る（`AFTER_BARS` 5 と `MIN_AFTER_BARS` 8 は矛盾していない）。
- `bars_after_settlement` が `MIN_AFTER_BARS = 8` 本に満たない診断は `thin` と記録する。ただし **`thin` は再診断の条件ではない**（2026-09-08、v21）。
  done の行はすべて、窓が丸ごと揃ってから `MAX_REVISIONS = 1` 回だけ読み直す（`revisions` が未記録＝旧版の行も拾えるよう、`revisions is null` と `revisions < 1` の両方で当てる）。
  `thin` を切り口にしていた頃の想定は外れている: `AFTER_WAIT_MS` が窓より 6〜15 倍短いので最初の読みはどの足でも最短 4〜8 本に着地し、
  8 本ちょうどの 1h / 1day は `thin = false` のまま窓の 1 割も見ていない（4〜8 本は下限であって分布ではない。待ち行列が詰まった行は後から＝深く読まれる。
  だから `lessons` 32 件のうち 12 件は 8 本超にいる。2026-09-08 実測）。経緯と、何をもって「効かなかった」とするかは `docs/POSTMORTEM_DEPTH_PREREGISTRATION.md`。
  再診断の失敗は `revisit_attempts` に積み `MAX_ATTEMPTS` で止め、元の診断はそのまま残す。
- **上書きする前に前の読みを残す**（`postmortem.prior`、`HISTORY_KEEP = 20` 件まで）。done の診断の要約（版・時刻・`cause`・`secondary_causes`・`avoidable`・`confidence`・
  `rule_blamed` / `rule_credited`・`lesson`・`bars_after_settlement`・`thin`）だけを写す。`facts` と入れ子の `prior` は入れない（文書は 1 件 8〜10 KB あり、入れ子にすると二乗で増える）。
  `MAX_REVISIONS = 1` なので、これが浅い読みを記録する唯一の機会である。
- WAIT の `thin` は `null`。見送りの「その後」は意図的に空配列なので `bars_after_settlement` は構造上 0 で、`true` も `false` も測っていない測定についての主張になる（§4.1.1）。
- `ids` で名指しした行は状態を問わず再診断し、`revisions` は消費しない。`force` は候補を増やさないが、飛ばす待ちには再診断の「窓が丸ごと揃うまで」も含まれる。
  窓が揃う前に `force: true` で走らせると薄い窓のまま `revisions` が 1 消費され、以後その行は見直されない。読み直していない行が残っている間は `force` ではなく `ids` で名指しする。
- 1 回に診断するのは `MAX_PLANS_PER_RUN = 3`。増やせるのは body の `limit`（1..`MAX_PLANS_ADMIN = 6` に丸める）だけで、`ids`（先頭 6 件まで）は候補を絞るだけ。
  `ids` を 6 件渡しても `limit` を省略すれば先頭 3 件で止まる（`due = rows.slice(0, options.limit)`）。手動実行は sweep トークンでも管理者 JWT でも同じ。
  失敗は `MAX_ATTEMPTS = 3` 回まで `postmortem.attempts` に積む。
- 管理者 JWT（`ADMIN_EMAILS`。同じ配列が 4 か所にある）の POST body: `force`、`ids`、`limit`、`consolidate`（`revisionDue` を待たずに**候補を書く**）、`promote`（決着件数の門を待たずに**候補を版に上げる**）。
  2 つは別の操作で、`consolidate` は候補を作るだけ、`promote` は既にある候補を昇格させるだけ。同じ run で両方渡すと候補を作った直後にそれを昇格させる。
- 壁時計の予算は `WALL_CLOCK_BUDGET_MS = 130 秒`（同名の定数が analyze にもあり、そちらは 135 秒。関数ごとに別物）。診断は開始から `START_DIAGNOSIS_BEFORE_MS = 75 秒` を過ぎたら新たに始めない（以降の行は `deferred (time budget)` として次の run に回す）。
  診断の LLM 呼び出しは `LLM_TIMEOUT_MS = 45 秒`（再試行 1 回を含めた合計の期限）。ルールブック改訂の呼び出しは別予算（§4.3）。
- **教訓を先に書き、それから done を打つ**。順序が逆だと、教訓の書き込みだけ失敗した行が「診断済み」として待ち行列から消え、二度と拾われない（学習に回らないまま消える）。
  教訓が書けなかった行も done は打ち（打たないと同じ行を毎回診断し直して他の行が進まない）、`errors` に `lesson not written, left for the repair pass` を残す。
- **修復パス**: 毎 run、`postmortem.status = done` の直近 `REPAIR_SCAN = 200` 行を id と診断の版だけで引き（`select=id,doc_version:postmortem->>version`。文書そのものは 8〜10 KB あるので引かない）、
  次の 2 種類を最大 `REPAIR_PER_RUN = 20` 件まで書き直す。欠落を先に、版ずれを後に詰める。
  1. `lessons` に対応する行が無いもの（教訓の書き込みだけ失敗した行）。
  2. `lessons` の行はあるが `postmortem_version` が `analyses` 側の診断の版と違うもの（`321bccaa` は v16 の教訓の下に v17 の診断があった）。
     ルールブックの編集者は `lessons` を読むので、版ずれの行は「その行のどこにも存在しない原因と教訓」を見せていたことになる。
  どちらも **保存済みの診断からの再射影** で、モデルは呼ばず診断も書き換えない（`writeLesson` は 1 つだけ）。run のサマリでは欠落の修復が `lessons_repaired`、版ずれの書き直しが `lessons_restated`。
  `lessons` 側の読み取りに失敗したときは「教訓が 1 つも無い」と見なさない（見なすと 200 行が全部「教訓が無い」に見えて、毎 run 20 件ずつ上書きしにいく。
  版ずれには見えない。版ずれの判定は `lessons` に行があることを要求するので、空集合からは 1 件も出ない）。修復を飛ばして `errors` に `repair: lessons unavailable, skipped` を残す。
- クールダウン `SWEEP_COOLDOWN_MS = 10 分` は sweep トークン呼び出しだけに効き、`postmortem_state.last_run_at` の条件付き UPDATE で先取りする（判定側と同じ作り）。管理者 JWT の手動実行はクールダウンを通らず、`last_result` も書かない。

### 4.1.1 見送り（WAIT）の診断

- WAIT は候補クエリから二重に外れていた（`outcome=in.(win,...)` と `signal=in.(BUY,SELL)`）ので、**一度も診断されていなかった**。診断されるのはトレードだけ、つまり学習は「もっと慎重に」の方向にしか進めなかった。
- 診断するのは **見送った先のトレード**（`wait_plan`。判断時点で確定し保存したもの）で、`facts` はそれを実際の値動きに当てはめて計算する。プロンプトは「このトレードは実行されていません」と明記する（書かないと建玉管理の教訓が出る）。
- 対象は `outcome=skipped & signal=WAIT & wait_plan is not null & shadow=false`、かつ `wait_check.verdict` が `missed` か `correct` の行だけ。`pending` は未測定、`unknown` / `no_call` は測定不能で、診断すればモデルが空欄を埋めることになる。
- トレードの後ろに積む（`due = rows.slice(0, limit)`）ので、1 回の予算はまず決着したポジションに使われる。1 回 3 件 × 1 日 96 回でどちらも捌ける。
- 判定の絞り込みは **SQL 側** で行う（`wait_check->>verdict=in.(missed,correct)`）。`no_call` と `unknown` は構造上ずっとそのままで、診断されない＝`postmortem` が null のまま＝候補クエリに永遠に一致する。
  取得後に JS で弾くと、古い順 40 件の枠をそういう行が占め切り、その後ろの採点済み WAIT（`missed` を含む）は二度と出てこない。
- ゲートが約定可能性で却下したプランは shadow 行として既に **トレードとして** 診断されるので、その親の WAIT 行は診断しない（`shadowParents`）。同じ場面から教訓を 2 本書くと、改訂の間隔を数える `lessons_since_rulebook` が倍速で進む。
- 修復パスの並び順は `created_at.desc`。`closed_at` は WAIT では常に null（決着時刻は `wait_check` の中）なので、`nullslast` だと全 WAIT が診断済みトレードの後ろに回り、取り残された WAIT の教訓が永遠に修復されなかった。
- run のサマリは `candidates`（両方の合計）・`trade_candidates`・`wait_candidates` を分けて出す。1 本目のクエリだけを数えていたので、WAIT だけを 3 件診断した run が「候補 0 件」と記録されていた。
- 原因は WAIT 専用の語彙から選ぶ（`WAIT_CAUSES`）: `wait_missed_trade`（見送ったが取れていた）/ `good_wait`（見送りは妥当）/ `regime_misread` / `news_shock` / `inconclusive`。
  決着したトレードには前 2 つを出さず、WAIT にはポジションの話（`stop_too_tight` など）を出さない（`causesForSignal`）。
- `wait_missed_trade` は **慎重すぎの唯一の証拠**なのでルールの根拠にできる。`good_wait` は `good_call` と同じく動かすレバーが無いので `UNCITABLE_CAUSES`。
  ただし `causeOutsideContract` からは両方とも見える（見えないと、慎重すぎから学んだルールが「その契約が出せない原因」としてプロンプトから外される）。
- モデルの答えが語彙外だったときに残る決定論的 hint も WAIT 用にする（`waitHint`）。トレード用の `facts.hints` をそのまま使うと、入っていない取引に `direction_wrong` が付く。
- 教訓は **行の実体** で登録する（`signal = WAIT`、`outcome = skipped`）。診断に使う行は仮想トレードの方向と勝敗を持っているので、それで登録すると誰も取っていないトレードの勝ちが記録に入る。
- **診断が見るのは、その判定が下された窓の中だけ**（`FactsContext.wait`）。`computeFacts` の既定はトレード用で、決着後 24 本の後窓・そこまで伸ばした寿命・`EXPIRY_DAYS`（1h なら 20 日）で再判定する反実仮想を持つ。
  そのまま渡すと「見送ったトレードは（採点窓の外で）利確に届いていた」という事実が並び、`wait_check.verdict = correct` の行に `wait_missed_trade` の診断が付く。しかも `wait_missed_trade` はルールの根拠にできる。除去したはずの後知恵が「事実」として裏口から戻ってくる。
  なので WAIT では: 寿命を `marketHorizonEnd`（採点と同じ市場時間の期限）で打ち切り、後窓は空、反実仮想は作らない（`cf.market_entry` は採点したトレードそのものを別の期限で再判定したものなので、同じ payload の中で矛盾する）。
- 決定論的 hint も WAIT 用に差し替える（`ctx.wait.hint`）。トレード用の hint は仮想トレードの勝敗で分岐するので、`missed` の行に `good_call`、`correct` の行に `stop_too_tight`（誰も建てていないポジションの損切りの話）が付き、しかもどちらも WAIT の語彙に無い＝スキーマ上選べない分類をモデルに渡すことになる。
- ルールへの投票（`stats.rule_feedback`）は `UNCITABLE_CAUSES` の原因からは行わない。`good_wait` は「根拠にならない」と決めたのに、正しく見送った 10 件がルールを 10 回 credit して、そのルールで負けた 2 件を票で上回りうる。
- 保存する診断書には `subject: "wait" | "trade"` を刻む。WAIT の `facts` は実行されていないトレードの測定なので、読み手がそれを知らないと存在しない建玉を読むことになる。

### 4.2 事実（facts）が先、診断はその範囲内

- 診断は `facts.ts` が新しいローソク足から計算した事実に縛られる: 基準値からプランの寿命＋事後窓で測った最大順行/逆行（`from_signal.max_favorable_r` / `max_adverse_r`。判定側の `mfe_r` / `mae_r` は再計算せず `evaluation` の値を plan に添えて渡す）、
  決済後の値動き、反実仮想（成行で入っていたら、広い SL なら、近い TP なら）、経済指標との照合（§5.1）、そして **危うさ（`danger`）**。
- `danger` の数値は約定した全プランで測り（損失や期限切れの行にも入る）、旗を立てるのは勝ちだけ。勝ちトレードの「実は危なかった」を事実にするための仕組み（PR #22）。閾値: `UNDERWATER_RATIO 0.5`、`MIN_DANGER_BARS 4`、`CHOP_CROSSINGS 4`、
  `SPIKE_CLOSE_R 0.5`、`SPIKE_REVERSAL_R 1`、`LATE_LIFE_RATIO 0.75`、`LUCKY_MAE_R 0.8`。旗は `deep_mae` / `mostly_underwater` / `chop` / `spike_target` / `late_win`。
  `lucky_win` の診断は立った旗を引用するようプロンプトで指示する（`parseDiagnosis` は cause の語彙しか検査しない）。決定論的な hint は旗が 1 つでも立てば `lucky_win`、無ければ `good_call`。
- 建玉中の足は約定足を含む（`x.t + barMs > filledMs`）。`life_used_ratio` は市場時間の足数で数え、壁時計では数えない。

### 4.3 ルールブックの改訂

- 改訂条件 `revisionDue`: **版以降の新しい教訓が 1 つ以上** かつ（`MIN_NEW_LESSONS = 5` 以上 **または** 前回の改訂から `MIN_REVISION_INTERVAL_MS = 24h`）。
  その run が lesson を書いたかでは決めない（`newLessons > 0` で門を閉じていた頃、17 時間・7 件分が放置された）。
  時計は「最後に**書かれた**改訂」= `rulebook.candidate.created_at`（候補が無ければ `updated_at`）。候補を保留している間 `updated_at` は止まるので、そちらを時計にすると 24h の門が毎回開く。
- **改訂は書くところと版に上げるところが別**（`rulebook.candidate` 列）。`revisionDue` が開いたら新しい書は `candidate` に入り、`rules` と `version` は動かない。
  分析が読むのは `rules` だけなので、候補が待っている間も現行版がそのまま出る。
- 候補が版に上がる条件 `measured`（`postmortem/promotion.ts` の `promotionGate`）: 現行版で決着したプランが **`MIN_DECIDED_EPISODES = 10` エピソード**（`promotion.ts:29`）。
  母集団は `rulebook_version = 現行版`・`outcome in (win, loss, expired)`・`shadow is false`・`preview is false` を `created_at` 昇順で `DECIDED_ROW_LIMIT = 1000` 件まで（`decidedRowsPath`）。週末の下見は採点も診断もされないのに `rulebook_version` は持つので、`outcome` の条件で既に外れていても `preview` を明示で外す（副作用で成り立っている不変条件は、壊れても誰も気付かない）。
- **数える単位は行ではなくエピソード**（`_shared/episodes.ts` の `episodeCount`。定義は下のクラスタの規則と同じ 1 つ）。同じペア・同じ方向のプランが一日のうちに 10 件並んでも、それは 1 つの局面を 10 回言い直しただけで、10 回の測定ではない。それを 10 件と数えると、たった一日の午後を根拠にルールブックを切り替えることになる。
  ルールの support も実績の「独立した局面」も既にエピソードで数えていて、ここが行で数えていた最後の場所だった。
  **この差は今の実データで開いている。2026-09-08 実測: 版 8 で決着した非 shadow・非 preview の行は 13 件、エピソードは 3 件**。行で読むと 13/10 で門が開いて見えるが、門は 3/10 で閉じている。行を数える運用判断はここで必ず間違える。
- 版 0（まだルールが無い）は最初の候補で無条件に上がる（ルールが無い版で作れたコホートは存在しないので、待たせると永久に待つ）。
  読み取りに失敗したとき、およびペア・方向・時刻が欠けて局面を特定できない行が 1 件でも混じったときは 0 件に丸めず `episodes: null` を返し、`errors` に出して昇格しない（**不明な件数は少ない件数ではない**。0 に丸めると、昇格に値した改訂を降格させたうえで、その丸めを実測値として報告することになる）。
  母集団が `DECIDED_ROW_LIMIT` で切れた場合の件数は真の値の**下限**（読みは時刻昇順の先頭から、走査は前向きのみ）。門が訊くのは「10 以上か」だけなので下限で判定しても安全側にしか倒れず、切れたことは `decided_population_truncated` に出す。
  上がらない限り学習は止まらない（候補は毎回上書きされ、最新の教訓を反映し続ける）。
  **これは「10 エピソードたまるまで改訂しない」ではない**: 文字どおり門にすると、決着が月に数件の今のペースでは数か月ルールが 1 行も増えない。書き続け、切り替えだけを律速する。
- 昇格は独立した書き込みで、その run が新しい候補を書いたかどうかに依存しない（依存させると「候補は書けたが版は上がらない」状態から抜けられない）。
  昇格した run は `promoted_from_candidate: true` を記録し、`candidate` を null に戻す。`last_result.promoted` に上がった版が入る。
- **捨てられた草案の跡**（`rulebook.candidate.superseded`、`HISTORY_KEEP = 20` 世代で頭から切る配列。既存の jsonb の中なので列は増えていない）。
  上書きそのものは意図どおりで変えないが、`history` に入るのは**昇格した版だけ**なので、まだ 1 度も昇格していない今、出ていく草案はどこにも残らなかった（2026-09-08 に 4 時間差で 2 つの候補が書かれ、前のものは pg_net の応答本体にしか残っていない。その表の保持は 6 時間弱）。
  残すのは **メタデータだけ**: `created_at` / `base_version` / `rules`（**本数**。本文は残さない。書が既に大きく、収束しているかを問うのに本文は要らない）/ `changes` / `episode_definition_version`。
  **昇格するとこの跡も `candidate` ごと消える**（昇格の 2 経路がどちらも `candidate: null` を書く）。版が上がる瞬間が「切り替わる前に編集者は往復していたか」を最も訊きたい瞬間なので、そこは今も残っていない。残すなら `history` の要素か `stats` に載せることになる（列は増えない）。
- 進捗の見せ方: `LoopHealth` が読むのは `loop_health` の `candidate_waiting`（`LoopHealth.tsx:70`）と `decided_episodes_under_version`（`:90`）の 2 つで、候補が待っている間は「教訓あと n 件」ではなく「**独立した局面が x/10 件**で適用」と出す（教訓の数はもう関係しないため）。
  `candidate_created_at` も `loop_health` は返すが **画面はまだ使っていない**（型 `src/lib/types.ts:499` にあるだけ）。読まれている前提で消すと壊れる、を避けるためにここに書く。
  旧キー `decided_under_version` は **行数のまま** 残してあり、読みは `decided_episodes_under_version ?? decided_under_version`。移行前のクライアントに 0/10 を出させないための保険で、エピソードの数を持つ版が来ればそちらが勝つ。
  数え方の版 `EPISODE_DEFINITION_VERSION = 2` は門の判定にも候補にも刻む（`episode_definition_version`）。数え方が変わったのと分析が上手くなったのは、この番号なしでは後から区別できない。
- 改訂は 1 回の run につき最大 1 回（統合の分岐が 1 つあるだけで、回数を決める定数はない。`MAX_REVISIONS` は thin の再診断回数、§4.1）。
- 既存の id のまま本文や cause が書き換わったルールは `changes.reworded` に出る。追加でも削除でもないので `since` は据え置きだが、
  記録が無いと「版だけ上がって差分が空」なのに分析者が従う文章は入れ替わっている、という読めない改訂になる。
- 書に入らなかったルールの理由は `changes.reasons`（id → 理由）に残る。`dropped` は `add_cap`（1 回の追加上限）/ `no_evidence`（引用が 1 つも数えられない）/ `book_full`（`MAX_RULES` が埋まっている）、
  `removed` は `omitted`（編集者が外し、削除枠に収まった）/ `evidence_gone`（数え直しても support 0）/ `no_room`（復元したかったが席が無い）。
  一覧だけでは「2 回続けて落ちた」までしか分からず、原因が引けなかった（v7・v8 で `r12` が連続で落ちた）。
- 改訂のモデル呼び出しは診断の 45 秒とは別予算: 壁時計の残り − `WRITE_RESERVE_MS = 10 秒` を `MAX_CONSOLIDATION_MS = 110 秒` まで。
  それが `MIN_CONSOLIDATION_MS = 45 秒` 未満なら改訂せず `rulebook.reason = deferred_time_budget` を返す。起きるのは run の経過が 75 秒を超えたときだけで、実測は診断 1 件で約 24 秒・残予算 96 秒（`net._http_response` id 556）。
  この単価なら 3 件でも 45 秒は割らないので、`deferred_time_budget` が常態化していたら診断が想定より遅いということ。
- `last_result.rulebook.reason` の読み方（`index.ts` が出す 6 種類すべて）: `no_lessons` / `lessons_unavailable`（**教訓テーブルが読めなかった**。`no_lessons` と逆の意味で、空と読み違えないために別名にしてある）/ `evidence_unavailable` / `waiting`（`lessons_since_version`、`lessons_needed` 付き）/ `deferred_time_budget` / `candidate_held`。改訂して版まで上げた run は reason を持たず `revised: true`（`changes` 付き）。
  `candidate_held` が **今この本番で毎回出ている値**（版 8 の門が 3/10 で閉じているため。§4.3）。付く鍵は `candidate_rules` / `changes`（＝現行版に対する差分）/ `changes_since_candidate`（＝**上書きされた前の候補**に対する差分。前の候補が無い、またはそのルールが読めないときは null で、空の差分とは意味が違う）/ `previous_candidate_at` / `superseded_kept` / `decided_episodes_under_version` / `decided_needed` / `episode_definition_version` / `decided_population_truncated`。
  `changes` と `changes_since_candidate` は**別の質問への答え**: 前者は「今これを昇格させたら版 8 に何が起きるか」、後者は「編集者は収束しているのか、それとも往復しているのか」。矛盾する 2 つの草案はどちらも版 8 に対して報告するので、前者だけでは見分けられない。
  `rulebook` そのものが **null** の run は reason を持たない。ルールブックが読めなかった・モデルが答えなかった・条件付き UPDATE が 0 行だったのいずれかで、手がかりは `errors`（`rulebook: unavailable, not revised` など）だけ。
  `lesson_contributors` / `record_contributors` は何アカウントから学んでいるか。
- ルールは最大 `MAX_RULES = 10`。1 回の追加は `MAX_RULES_ADDED = 2` まで（前版が空の初回だけは `MAX_RULES` まで一度に書ける）。
  削除は省かれたルールのうち support の低い順に `MAX_RULES_REMOVED = 2` 本までで、残りは証拠を数え直して復元する（`changes.restored`）。数え直しで support が 0 になったものは上限に関係なく `changes.removed` に入る。
- support はモデルに申告させない。ルールが `supported_by` に挙げた lesson のうち `citationAllowed` を通るもの（実在し、shadow でなく、ルールの cause と合う。`general` なら任意の citable cause、`constraint` なら `CONSTRAINT_CAUSES` も可）の
  独立クラスタ数をサーバ側で数える。`inconclusive` / `plan_incoherent` / `good_call` は何の証拠にもならない。0 になったルールは出力から落ちて `changes.dropped` に入る。前版に無かった新規ルールはそこで消えるが、前版にもあったルールは省かれたルールと同じ削除の精算に回り、`MAX_RULES_REMOVED` の枠から外れれば保存済みの `supported_by` で数え直され、support が戻れば `changes.restored` として書に残る（`dropped` と `restored` の両方に出る）。引用先の lesson id が実在しなければ数えない。ルール id の乗っ取り防止が働くのはモデルが id を空で返したときだけで、サーバが振る `r<番号>` が既存 id と衝突する間 `_` を足す。
  モデルが既存ルールの id をそのまま名乗った場合は無効にせず「そのルールの継続」として扱い、本文は丸ごと差し替わり、`since` は前版から引き継ぎ、`MAX_RULES_ADDED` の枠にも数えない（`changes` には何も出ない）。
- `MIN_STAT_N = 20` が効くのは `win_rate`（分母 `decided`）/ `fill_rate` / `wait_miss_rate`（`waits_judged`）だけで、分母が 20 件未満なら null で渡す。
  `win_rate_ci95`（Wilson）と `realized_r.mean` は件数に関係なく渡し、小さい n を根拠にルールを強めないのはプロンプトの指示（サーバ側では検査しない）。
- クラスタ（＝エピソード。実装は `_shared/episodes.ts` の 1 か所だけで、postmortem もクライアントもそこを読む。`performance_stats` と `loop_health` は同じ規則を SQL で書き写したもの）: 同じペア × 同じ方向（鍵は `pair|signal`）のプランが、
  **そのエピソードの開始から** `CLUSTER_WINDOW_MS = 24h` 以内に作られたものは 1 つに数える。**直前のプランからではない**（直前起点だと毎回期限が前へ伸びる鎖になり、日次のプランが 1 週間まるごと 1 エピソードに融合する。`prompt.ts` が鎖で数え、画面と SQL は固定起点で数えていて、ルールが生き残るかを決めていたのは鎖の方だった）。
  直前のプランが決着（`closed_at`）してから `CLUSTER_REOPEN_MS = 4h` を **超えて** 作られたものは 24h 内でも別エピソード（前が未決着なら 24h 内は同じ）。「直前の 1 件」の決着だけを見る。もっと古い決着を持ち回ると、直前のプランがまだ建っているのに別のプランの決済で逃げられる。
  境界は 2 つとも逆に読まれたことがあるので明記する: 窓は `<`（ちょうど 24h 空けば別）、逃げ道は `>`（ちょうど 4h 先の決着では逃げない）。
  4h は集約の閾値であって統計的独立の主張ではない。`closed_at` は判定した足の境界で打たれる（1day のプランなら日単位）ので、エピソードの境界もその粒度しか持たない。エピソード数は「何回別々に判断したか」であって、有意差を許す標本数ではない。
  原因は鍵に含めず、原因別のクラスタ数は `by_cause_clusters` で後から数える。クラスタ鍵に `user_id` は含めない（全アカウント学習。鍵に入れると support が購読者数で増える）。
- 1 人のヘビーユーザーが占有しないよう `fairShare`（アカウントごとに新しい順をラウンドロビンで取る）。教訓は `RECENT_LESSONS 60` × `FAIR_FETCH_MULTIPLE 3` 件から 60 件、記録は `RECENT_ROWS 300` × 3 件から 300 件。
  現行ルールが `supported_by` で引用する教訓は窓の外でも別に読んで足し、読めなければ改訂しない（`evidence_unavailable`）。ルールブックの読み取り失敗も「空」ではない（空から書き直さない）。
- ルールの `contract` スタンプ（§2）: `stampFor` が改訂時の `PLAN_CONTRACT` を刻み、cause がその契約の原因分類に無い（`causeOutsideContract`。market_v1 では `entry_too_far`）か、
  文言がエントリーの選び方・タイミングを指示する（`unfollowableUnder`、`ENTRY_LEVER_PHRASES`: 「押し目を待」「指値で入」「wait for a pullback」など。「エントリー価格から ATR×0.8」のように価格を基準点として名指すのは可）ときだけ null にする。
  再出力されたルールも復元されたルールも毎回 cause と文言から再計算し、前版から継承しない（継承させたのが v7 の事故: 旧契約の証拠だけの 4 本が market_v1 とスタンプされた）。null のルールは `changes.held_back`。
- 版と履歴: プランは `rulebook_version` を 3 状態で記録する（null = 読めなかった、0 = 読めたが現行契約で有効なルールが無かった、n>0 = 版 n の少なくとも 1 本がプロンプトに入った）。
  `context.rules_shown` が実際に入った id（`MAX_PROMPT_RULES = 12` と文字予算で切れる。予算は言語別で `promptCharBudget(locale)` が ja に `MAX_PROMPT_CHARS = 1600`、en に `MAX_PROMPT_CHARS_EN = 3200` を返す。同じ版でもロケールが違えば本数は変わりうる）、`context.rulebook_version_read` が読めた版。
  文字予算で切れた本数は黙って消さず、`context.rule_fit.held_back` に残し、ブロックの末尾にも「このほかに N 件…」と書く（§4.5）。予算の計算は各行を **改行込み** で数える（改行を数えていなかったので、en の長いルール 12 本で 3200 字の予算に対し 3211 字を出していた）。
  診断が `rule_blamed / rule_credited` に書けるのは `rules_shown` の id だけで、postmortem は `history`（`HISTORY_KEEP = 20` 世代）から版ごとのルールを復元する。
  ただし `context.rules_shown` が配列で入っていない古い行は、その版のルール全部が対象になる（`shownIds` が null なら `versionRules` をそのまま渡す）。本番 21 行のうち `rules_shown` を持つのは 2 行だけで、残りはこの経路（2026-09-05 時点）。`history` を消すと古い版のプランが何を見たか分からなくなる。
- 書き込みは `rulebook?id=eq.1&version=eq.<読んだ版>` の条件付き UPDATE（楽観ロック）。0 行なら書かずにエラーに残す。`updated_at` は lessons を書いた **後** に打つ（次回に同じ lesson を新規と数えないため）。
- **手で `rulebook` を直すときの禁則**: `version` を上げない（誰も見ていないコホートを作る）、`updated_at` を触らない（`revisionDue` の時計）、`history` を書き換えない。
  ルールの契約を手で直すときも `causeOutsideContract` と `ENTRY_LEVER_PHRASES` の 2 条件で判定する。データを直すマイグレーションは **新しい関数をデプロイした後・cron を止めて** 流す（古い parser が先に改訂すると修正が巻き戻る）。

### 4.4 shadow 行

- ゲートが「約定可能性」を理由に拒否したプランは、拒否されなかった場合の姿を `shadow = true` の別行として保存し（`shadow_of` が元）、判定と診断は普通に受ける。
- **成績には数えず、履歴に独立した行としても出さない。** `outcomeStats.ts` は `isShadow` を除外して別集計（`shadowTally`）。
  ただし結果は隠さない: `AnalysisHistory` が `shadow_of` で元の WAIT 行に畳み込み、その詳細に「却下プランの追跡結果」（却下が正しかったか）を表示し、集計はゲート注記に出す。
- `loop_health` もプラン数（`open_plans` / `awaiting_review` / `reviewed`）は `shadow = false` で数える。ただし `lessons` と `lessons_since_rulebook` は shadow を除外せず、shadow 行から書かれた教訓も含む（`revisionDue` の数え方と同じ）。
  shadow の lesson はルールの support には数えない（`citationAllowed`）。

### 4.5 今の相場に合うルールを先に出す（situation.ts）

- **どのルールが今の相場に当てはまるかは、モデルに書かせずサーバが測る。**（v48 で足した `claimed_by_analyst` は同じオブジェクトに同居するが、モデルの自己申告であって判定ではない。下記。）ルールは根拠にしたプラン（`supported_by`）を挙げていて、そのプランは判断時点の指標スナップショットを `analyses.context.entry` / `.higher` に残している。
  そのスナップショットが張る範囲がそのルールの **フットプリント**で、今の値と比べるだけ。ルール本文の主張とは独立に決まる。
- そう決めたのは、モデルに条件を書かせると証拠を追い越すから。実際に本番の v8 で起きている: `r10` の本文は「ADX が 60 超・RSI が 10 前後」だが、読める 4 件の引用のうち 1 件は ADX 39・RSI 25.8。フットプリントは引用そのものなので、この乖離が起きない。
- 軸は 5 つ、いずれも `compactSnapshot` が持つ値だけで作る（この形はこのプロジェクトで唯一、初出以来キーが変わっていない）:
  `adx`（許容 10）/ `rsi`（8）/ `stretch` = (price − sma20) / atr（1、**符号付き**。平均から下に 5 ATR と上に 5 ATR は別の相場）/ `bb_pos` = (price − bb_lower) / (bb_upper − bb_lower)（0.25）/ `htf_adx` = 1 つ上の足の ADX（10）。
- 軸はすべて **無次元か、その足のスケールで割った量**（ADX・RSI・ATR 倍・バンド内の位置）。ルールは複数の足のプランをまたいで引用するので（`r10` は 1h と 1day の両方を引く）、価格や pips を軸にすると日足と 1h の値幅の違いを「相場が変わった」と読んでしまう。
  裏返しに、フットプリントは **証拠がどの足のものかを持たない**。足を軸に足すと今の証拠では比較できる軸が消えるので、限界として §8 に置く。
- 測れないもの・広すぎるものは判定に使わない。`MIN_FOOTPRINT_CASES = 2`（1 件は範囲ではなく点）、`WIDE_FACTOR = 3`（許容の 3 倍より広い軸はどんな相場も当たるので除外）、`MIN_COMPARABLE_AXES = 2`（1 軸の一致は雑音）。
  比較できた軸が 2 つ未満なら `unknown`。全軸が範囲内か許容内なら `match`、1 つでも外れれば `off`。
- **並び順は kind → fit → support。** `kind` が最も外側なのは変えない: constraint は「入るな」と言う規則で、数件の引用との突き合わせが「入ってよい」の許可になってはいけない。
  `unknown` は `off` より **上**。「照合できなかった」を「別の相場だと測った」より下に置くと、スナップショットが無い時代のルールが先に切られる。
- **fit はゲートではない。** ルールを消すことはなく、順番と印だけを変える。契約（`contract`）だけが唯一のゲート（§2）。
- 引用のうちスナップショットを読めなかった件数は隠さない。`cases`（読めた）と `cited`（挙げられた）を両方 `context.rule_fit.rules[id]` に残す。`r10` は 5 件挙げて 4 件しか読めない。
- shadow 行は読まない（`&shadow=is.false`）。support に数えないと決めたものが、この経路から戻ってきては意味がない（§4.4）。
- 読めなかったときは **黙って `unknown` にしない**: フットプリントの取得自体が失敗したらこの機能が無かったときと同じ描画に戻す（印も注記も出さない）。印が出るときは「これはサーバの実測であってルール本文の主張ではない」と 1 行だけ添える。
- 記録は `context.rule_fit`: `shown` / `held_back` / `rules[id] = { fit, comparable, missed, cases, cited }`。後から「その回にどのルールがどう判定されて出たか」を引ける。
- v48 から、同じオブジェクトに `claimed_by_analyst`（**AI の自己申告**・任意）が入りうる。「この回で実際に使った」とモデルが述べたルール id を、提示した id で濾したもの。**測定ではない**ので `fit` とは決して混ぜない。答えなかった回はキーごと不在（web 検索時はスキーマが拘束しないので、これが多数派）。`[]` は「どれも使わなかった」という申告そのもので、読めない答えは不在に倒す（`claimedRules`）。
  診断には渡さない。プランの `context` はそのまま診断プロンプトに入るので、postmortem 側の受け渡しでこのキーだけ落としている（postmortem-v24 の `withoutAnalystClaim`）。自己申告はルールについての証拠ではなく、後からサーバの実測と突き合わせるために取っている値なので、突き合わせる相手（`rule_blamed` / `rule_credited`）にそれ自身を食わせたら意味が無くなる。保存行はそのまま残る。
- **2026-09-08（analyze-v48）: プロンプトのルール行に id を出すようにした。記録はここで切れる。**
  行頭に `[r10]` の形でラベルとして置く（`selectPromptRules`）。それまでのルール行は scope と本文だけで、id はどこにも出ていなかった。デプロイ直前までの保存済みプロンプトを全数見て（7b2a641 の時点で 39 行、デプロイ直前で 43 行。すべて v8・すべて日本語・すべて system 側）、ルールブックのブロックは全行にあり、**ルール id は 0 行**。つまりこれより前の `claimed_by_analyst` は原理的に埋まらず、「申告が無い」は「使わなかった」の証拠ではない。
  **境目は日付ではなくデプロイなので、日付で切らない。** 2026-09-08 にはデプロイ前の行が 24 行あり、同じ日に後の行も入る。後から分けるときは `analyses.context->provenance->>function_version` が `analyze-v48-…` かどうか（v46 以前と null がデプロイ前。v8 の内訳は v44 25 行 / v45 3 行 / v46 4 行 / null 11 行で、v47 は 1 行も無い＝ビルドしたがデプロイしていない）、プロンプト側で見るなら `analysis_prompts.system ~ '\[r[0-9]+\]'` で切る。
  **この前後の行を 1 つの母集団として数えない。** アナリストへの入力そのものが変わっている。申告率・ルールの効き方・WAIT 率の差を「相場が変わった」「モデルが変わった」と読むと、実際に読んでいるのはプロンプトの変更である。契約（§2）を分けるのと同じ理由。
  **しかもこの 1 回のデプロイでプロンプトは 2 箇所変わる。** id のラベルと、`rules_applied` のスキーマ追加（v47 でコミットしたがデプロイしていないので、実際に入るのはここ）。検索ありの経路ではスキーマ全文が user 側に入る（保存済み 43 行のうち 40 行、例外は常に 3 行）ので、「使ったルールを後で訊かれる」という予告もこの日に初めて届く。前後で差が出たとき、どちらの効果かは分けられない。
  文字数: v8 の 3 本で日本語ブロックは 581 → 595 字（上限 1600）、英語は 1283 → 1300 字（上限 3200）。上限も選択ロジック（`MAX_PROMPT_RULES = 12` と文字数上限）も変えていない。ただし id の分だけ 1 行が長くなるので、文字数上限で切れる大きさのルールブックでは出る本数が 1 本減りうる: **現行 3 本と同程度の長さのルールを 11 本並べると、日本語・英語とも 11 本 → 10 本**（`held_back` 0 → 1）。実測。12 本なら上限だけで元から 10 本に切れており、ラベルの有無では変わらない（本数が減り始めるのは 12 本ではなく 11 本）。長さが揃ったルールブックなら減る位置は動く（1 本 56 字で 12 本 → 11 本、84 字で 10 本 → 9 本）が、減るのは常に 1 本で、落ちるのは並び順の最後＝今の相場から最も遠い 1 本。今の 3 本では起きない。
- **実データでの基準値（v8 のルール 3 本・最新行 717df3db の 1day スナップショットに対して、2026-09-06 に実測）**:
  `r10` = match（読めた引用 4/5、比較した軸は rsi・stretch・bb_pos・htf_adx、adx は広すぎて除外）/ `r4` = unknown（読めた引用 1/2 で全軸が thin）/ `r11` = off（5 軸すべて比較でき、bb_pos 以外が外れ）。
  ブロックは 581/1600 字、3 本とも出て `held_back = 0`（id を出すようにした 2026-09-08 以降は 595/1600 字、本数は同じ）。
  `r10` と `r11` は scope がどちらも `over-extended trends` だが判定が割れる。`r10` の証拠は 1day と 1h の両方の伸び切りを含み、`r11` の証拠は 1h のバンドウォークだけ。今の日足はその区別の片方にだけ入る。これがこの仕組みで見たかった差そのもの。

---

## 5. cron の時刻と冪等性

`cron.job`（Supabase の pg_cron）。ジョブはマイグレーションの `cron.schedule`（`20260903090000` / `20260903100000` / `20260903100500` / `20260903150000` / `20260903190000`）で作られている。
ただし時刻の変更はマイグレーションを足さず `cron.alter_job` か `cron.job` の直接更新で行う（§10）ので、時刻の正はデータベース。

| jobid | 名前 | schedule (UTC) | 呼び先 | timeout |
|---|---|---|---|---|
| 1 | `track-outcomes-sweep` | `3,18,33,48 * * * *` | `/functions/v1/track-outcomes` | 90 s |
| 4 | `postmortem-sweep` | `8,23,38,53 * * * *` | `/functions/v1/postmortem` | 150 s |
| 5 | `econ-calendar-sync` | `13 * * * *` | `/functions/v1/econ-calendar` | 60 s |
| 3 | `purge-cron-history` | `0 3 * * *` | `cron.job_run_details` の 7 日より古い行を削除 | – |

- pg_net の timeout は関数の壁時計予算より長くする。postmortem は自前で 130 秒まで走るのに待ちが 120 秒だったので、予算いっぱいの run は応答を捨てられていた（行は書けているが `net._http_response` にはタイムアウトしか残らない）。
  150 秒に直した（`20260905105342_postmortem_cron_timeout_matches_budget`）。プラットフォームがワーカーを殺すのも 150 秒なので、まだ走っているものを待つことにはならない。
- 判定と診断は 5 分ずらしてある: 2 つの sweep が同じ分に市場データ（Twelve Data の共有キー、8/分）の割当を食い合わないようにするため。
  判定が付いた行は `AFTER_WAIT_MS` 経ってから診断の対象になるので、同じ 15 分枠の診断が拾う設計ではない。
- 呼び出しは `net.http_post`（pg_net）。ヘッダ `x-sweep-token` の値は **SQL の中で `vault.decrypted_secrets` から読む**。トークンの文字列はどこにも書かない（§7）。
- 冪等性は関数側で担保する:
  - 全体クールダウン（10 分。econ-calendar は 30 分）を `tracker_state` / `postmortem_state` / `econ_calendar_state` の **条件付き UPDATE 1 発** で先取りする。2 tick が同時に来ても片方は `skipped: "cooldown"` で帰る。
  - 判定は市場時間で数えるので、走る時刻に依存しない（§3.4）。同じ feed（`price_basis`）で同じ足を見る限り、同じ行を何度判定しても同じ結果。
    ただし feed は sweep ごとにプランの壁時計の齢（3 日）と Bid/Ask 取得の成否で決まるので、quotes から mid に落ちた pending 行は判定価格が変わり、シグナル足を見直し中の成行は約定価格が `entry_point` で書き換わる（§8）。
  - 診断は done の行を無制限には再診断しない。`MAX_REVISIONS = 1` 回だけの読み直しと `ids` の名指しが例外（§4.1）。
- 一時停止と再開:

```sql
select cron.alter_job(4, active := false);  -- postmortem を止める（デプロイ中など）
select cron.alter_job(4, active := true);
```

- 結果の確認:

```sql
select jobid, status, return_message, start_time from cron.job_run_details order by start_time desc limit 10;
select id, status_code, left(content, 300) from net._http_response order by id desc limit 5;
select * from public.tracker_state;      -- last_sweep_at, last_sweep_result
select * from public.postmortem_state;   -- last_run_at, last_result
select * from public.econ_calendar_state;
```

- 手動 sweep も同じ経路で打つ（トークンを手元に出さない）:

```sql
select net.http_post(
  url := 'https://endcqzewujdvimdlazhj.supabase.co/functions/v1/track-outcomes',
  headers := jsonb_build_object('Content-Type','application/json',
    'x-sweep-token', (select decrypted_secret from vault.decrypted_secrets where name = 'track_outcomes_sweep_token')),
  body := '{"mode":"sweep"}'::jsonb, timeout_milliseconds := 90000);
```

### 5.1 econ-calendar 同期

- 出典は Forex Factory の週間 JSON（キー不要）。**今週分しか公開されていない**。`actual` は無いので「何が予定され、予想は何か」までで、「何が出たか」は決して言わない。
- クールダウン 30 分を `econ_calendar_state.last_run_at` で先取り。レート制限時は HTML が返るので、JSON でなければ **保存済みを消さずに** エラーだけ積む。`KEEP_PAST_DAYS = 45` より古い行は毎回削除。管理者 JWT で手動実行可。
- 時刻: feed の `date` は米東部オフセット付き ISO なので UTC に正規化する。終日は **生文字列** の `00:00`、休日は `impact = Holiday` で判定（どちらかを満たせば `all_day`。UTC に直してから見ると 04:00 UTC の指標が終日に化ける）。
- 読み手: analyze は `HORIZON_MS`（15min 6h / 1h 12h / 4h 48h / 1day 5d）の High/Medium をプロンプトに入れ、「読めて空」と「読めなかった」を区別して書く（`calendarOk`）。プロンプトは High の前後 `BLACKOUT_MS = 30 分` に約定するプランを禁じる。
  postmortem は `abnormal_bar`（中央値の `ABNORMAL_RANGE_RATIO = 3` 倍以上の足）を `ATTRIBUTION_LEAD_MS = 5 分` の余裕で指標に帰属させる。決定論的な hint は `event` の有無に関わらず異常足があれば `news_shock` を立てる。
  縛るのは名指しの方で、`event` があればその足で発表された指標を事実として書いてよく、null の異常足は「原因不明の急変動」として指標のせいだと断定させない（プロンプトの指示）。

---

### 5.2 noise-floor（アナリストのノイズ床を測る。**cron に載せない**）

- **何のためか**: 同じプロンプトをもう一度送ったとき、答えがどれだけの割合で変わるかを測る。#65（現行ルールブック対候補ルールブックの対応のある比較・McNemar）の**前提条件**であって、それ自体が目的ではない。
  この数が無いまま #65 を走らせると、観測された差が「ルールブックが効いた」のか「モデルが同じ入力に二度同じ答えを返さなかった」のかを**区別できない**。設計と閾値は `docs/NOISE_FLOOR_PREREGISTRATION.md` に、最初の課金呼び出しの前に固定してある。読み替えを防ぐために先に書いたものなので、走らせたあとに書き換えない。
- **絶対に cron に載せない。** ジョブは存在しないし、作らない。`§5` の表に行を足す変更は差し戻すこと。理由は 2 つ:
  この関数は**呼ぶたびに課金される** `ANTHROPIC_API_KEY`（analyze と postmortem と同じ鍵）を使うこと、そして母集団を凍結して 1 パスで走り切る測定なので、勝手に再走したら「いつ止めたか」で結果を作れることである（`§5` の他の 3 つは冪等な sweep で、性質が違う）。
  実測: 2026-09-08 07:14:46Z〜07:23:02Z に同じ鍵でクレジット残高不足が 6 回連続し、**ライブアプリのユーザーにエラーとして見えた**。これがこの関数の失敗半径である。
- **ユーザーに見えるものには触らない**: `analyses` / `lessons` / `rulebook` に書かない。`/functions/v1/analyze` を呼ばない（呼べば quota を消費し行を作る）。`analysis_prompts` は**読むだけ**。quota は 1 回も消費されず、返却も発生しない。書き込むのは `public.noise_runs` と `public.noise_cells` の 2 つだけ。
- **認証は sweep トークンのみ。管理者 JWT の枝は無い**（他の 3 つと違う点）。トークンが無ければ・違えば一律 401。
  金を使う関数に `ADMIN_EMAILS`（すでに 4 か所）の 5 つ目のコピーを作らないため、そして想定する呼び手が「vault からトークンを読む SQL」＝psql の前での意図的な操作だからである。

#### デプロイ順（この順でしか通らない）

1. **マイグレーション `20260909120000_the_analyst_is_measured_against_itself.sql` を先に当てる。** 関数は最初の 1 リクエストで `noise_runs` に行を作るので、テーブルが無ければ 500 で止まる（課金は 1 回も起きない）。
2. **`supabase/config.toml` の `[functions.noise-floor] verify_jwt = false`。** 済み。これが無いと `supabase functions deploy noise-floor` 経路でゲートウェイの既定 `verify_jwt = true` が効き、**下の `net.http_post`（`x-sweep-token` だけで JWT を持たない）は関数に届く前に 401 になる**。psql からはトークン不一致と区別が付かない。チェーンの自己 POST も同じ理由で落ちる（関数は `chain_handoff_status:401` を `errors` に出す）。リポジトリのデプロイ経路（`.claude/workflows/deploy-edge-verified.js`）は `verify_jwt: false` を明示的に渡すので、そちらだけなら元から通る。
3. **`npm run bundle:noise-floor` → `.claude/workflows/deploy-edge-verified.js`。** バンドルは `.gitignore` 済み（他の 3 つと同じく明示パスで列挙）。

#### 呼び方（トークンの値はどこにも書かない）

`x-sweep-token` は必ず `vault.decrypted_secrets` からの副問い合わせで埋める（`§7`）。`timeout_milliseconds` は関数の壁時計予算 130 秒より長くする。

```sql
-- 1) ドライラン（無料。/v1/messages は 1 回も呼ばれない）
select net.http_post(
  url := 'https://endcqzewujdvimdlazhj.supabase.co/functions/v1/noise-floor',
  headers := jsonb_build_object('Content-Type','application/json',
    'x-sweep-token', (select decrypted_secret from vault.decrypted_secrets where name = 'track_outcomes_sweep_token')),
  body := '{"dry_run":true,"arm":"search_free","reps":2}'::jsonb,
  timeout_milliseconds := 150000);

-- 返り値を読む（run_id / measured_input_tokens / bound_output_tokens）
select id, status_code, left(content, 1000) from net._http_response order by id desc limit 3;
```

- `dry_run` の既定は **true**。フィールドを書き忘れた body も、綴りを間違えた body も、JSON ですらない body も、全部無料の経路に落ちる。**明示的な `false` だけがモデルを呼べる。**
- ドライランは全行に `POST /v1/messages/count_tokens`（無料）を、送る本体から `max_tokens` だけ落として投げる。返すのは
  `measured_input_tokens`（**実測**。行ごとに 1 回数えて `reps` 倍する。2 反復は同じバイト列なので 2 回数える意味が無い）と
  `bound_output_tokens = 8000 × 行数 × reps`（**上界であって見積もりではない**。`count_tokens` は入力しか数えず、出力は適応思考が出力レートで `max_tokens` まで課金される）。
  `status = 'dry'` の行を 1 本書き、セルは 1 つも書かない。壁時計が尽きたら `run_id` を渡して同じドライランを再開できる。
  **ドライランにもライブと同じ 3 つの安全装置が付いている**（呼び出し間隔 2 秒、cron の分を避ける、401/403/429/5xx で即中止）。無料なのは事実だが、この関数の失敗半径は「課金」ではなく「**共有キー**」である。48 行ぶんの拒否を一気に作るのは 1 回作るより悪い。中断したら `run_id` で再開すればよく、止まる代償は POST 1 回である。
- **ドライラン無しにライブ実行は作れない。** `dry_run:false` の作成には、同じ母集団・同じアーム・同じ `reps` の**完了した**ドライランを指す `dry_run_id` と、`budget_input_tokens`・`budget_output_tokens` の両方が必須。予算の 2 つの数字はドライランの上の 2 つから**人間が決める**（`docs/NOISE_FLOOR_PREREGISTRATION.md` の未決事項 1）。

#### ドライラン → パイロット → 本走行

1. **ドライラン**（無料）。`run_id` と `measured_input_tokens` / `bound_output_tokens` を得る。この 2 つが出るまで先へ進まない。
2. **パイロット（器具の検査であって推定ではない）**。目的を絞った 6 行を `analysis_ids` で名指しし、その 6 行だけの**別のドライラン**を取ってから 12 セルを手で流す。
   パイロットのセルは**事前登録で p̂₀ から除外されている**。合算すれば「先に覗いてから母集団を決めた」ことになる。
   合格条件は 6 つ（事前登録 §9・設計 §8 のゲート）: 12/12 が `status='ok'`、`usage.input_tokens` が `count_tokens` の値と整合、`response_model` が行の `model` と一致、`missing_required_keys` が空、費用の外挿が承認済み予算の内側、`analyses`/`lessons`/`rulebook` と quota が動いていないこと。
   ```sql
   body := jsonb_build_object('dry_run', false, 'dry_run_id', '<pilot dry run>', 'arm','search_free',
                              'reps', 2, 'max_cells', 2, 'chain', false,
                              'analysis_ids', jsonb_build_array('<id1>','<id2>','<id3>','<id4>','<id5>','<id6>'),
                              'budget_input_tokens', <n>, 'budget_output_tokens', <n>)
   ```
3. **本走行**。凍結した母集団に対して `chain:true` で 1 回だけ叩けば、あとは自分で次のホップを撃つ。
   ```sql
   body := jsonb_build_object('dry_run', false, 'dry_run_id', '<full dry run>', 'arm','search_free',
                              'reps', 2, 'max_cells', 2, 'chain', true,
                              'budget_input_tokens', <n>, 'budget_output_tokens', <n>)
   ```
   **途中で結果を見ない**（事前登録 §7）。数時間かかる。
4. **レポート**（モデルを 1 回も呼ばない読み取り専用モード）。
   ```sql
   body := jsonb_build_object('report_run_id', '<run id>')
   ```
   `metric.ts` の `report(...)` をそのまま返す。`completed + failed < expected` の間、**率は出ない**（`emitted:false` と拒否理由が返る）。`status='claimed'` のセルは `CellStatus` ではないので `report()` に渡さず、`unfinished_cells` として別に数えて返す。

   レポートは `report()` に渡す前に 4 つを自分で拒否する（**HTTP 409、`report.refusal` に理由**。率は出さない）。どれも「間引いた 40 行の率を 48 行の率として出す」向きの事故で、その向きは #65 が耐えられない側である。
   - `expected_cells_disagrees_with_frozen_population` — 門は**凍結した id リスト**（`notes.population.ids`）から数え直した期待値で判定する。`expected_cells` 列は可変で、手で下げれば `<` の比較は途中の run でも通ってしまう。列は突き合わせるだけ。
   - `cells_outside_frozen_population` — 凍結した母集団に無い行のセルがある。
   - `replicates_of_a_row_sent_different_requests` — **1 行の 2 反復が同じリクエストを送ったことの証明**。`system_sha256` / `user_sha256` / `effort` / `max_tokens` / `tools_present` / `schema_in_prompt` / `shape` を反復間で比較する。リクエストは呼び出しごとに保存プロンプトから組み直され、1 行の 2 反復は何時間も離れた別々の呼び出しに落ちるのが普通なので、その間に `shape.ts` を入れ替えれば別々のリクエストが「2 反復」として混ざる。**後の版がより拘束的なら答えは揃いやすくなり、率は低く出る**。（同じ比較は走行中にもしていて、兄弟と食い違うセルは**買わずに** `aborted` にする。）
   - `stratum_unknown_for_some_cells` — 層が引けなかったセルがある。層が不明なセルは `core` に落ちる＝ preview の 4 行が中核に混ざる＝分母が 40 でなく 44 になる＝ Wilson 上限が**下がる**。以前はこれが `errors` の 1 行として率の隣に出ていた。

#### 走行中の安全装置（すべて関数側で強制。body では緩められない）

- **max_cells は 1 回の呼び出しにつき最大 4**、`reps` は 2〜3。**ただし `max_cells` が数えるのはセルであって課金される呼び出しではない**: `pause_turn` のループは 1 セルの中で最大 5 回叩ける。予算はセルの中でも見るようにしてあり（`budget_crossed_mid_cell`）、そもそも `pause_turn` はサーバツールの信号なので `tools` を付ける `search_on` アームでしか起きない。
- **壁時計**: 予算 130 秒、書き込み用に 10 秒を残す。**残りが 80 秒を切ったら次のセルを始めない**。1 回のモデル呼び出しの上限は 100 秒。
  80 秒は実測から決めてある。`analyses.created_at − analysis_prompts.sent_at`（fetch から write までの実時間＝モデル時間の**上界**）を 48 行全部で見ると 最小 39.1 秒・中央値 56.0 秒・p90 66.1 秒・最大 71.8 秒、62 秒超が 11/48、**80 秒超は 0/48**（2026-09-09 実測）。
  最初は 25 秒だった。それは**実測の最小値より下**で、その残り時間で始めたセルは「claim して、課金される生成をさせて、途中で切る」ことが確定していた。終わったセルは自動で取り直さないので、その反復は永久に失われ、その行は分母から落ちる。**落ちるのは遅い行だから、48 行の母集団からの無作為でない間引き**になる。
  代償は正直に書く: 80 秒にすると `max_cells:2` でも 1 呼び出し 1 セルが普通になり、ホップ数はおよそ倍要る。`max_chain_hops` は同じ定数から計算しているので、片方だけ動いて run が立ち往生することはない。
- **cron の分を避ける**: UTC の分が `{3,8,13,18,23,33,38,48,53}` のときはセルを開始しない。**その分を寝て待つ**（次の分の頭まで、壁時計に収まる限り）。時間が足りなければ `skipped:"cron_minute"` で帰る。
  実測（`select jobid, jobname, schedule, active from cron.job`、2026-09-09）: 生きているジョブは 4 本で、上の 9 分は**エッジ関数を叩く 3 本の和集合**。postmortem は同じ Anthropic キーを共有し、残り 2 本はワーカーとデータベースを共有する。
  `purge-cron-history`（`0 3 * * *`）は入れていない: 1 日 1 回・関数を呼ばない・`cron.job_run_details` を消すだけ。
  **「寝て待つ」であって「帰る」ではない理由**: チェーンのブロックは status・残セル・予算・ホップ数は見るが「このホップは仕事をしたか」は見ない。だから帰るだけだと、何もしなかったホップが即座に次のホップを撃ち、そのホップも同じ分の中で refuse し……と 1 秒に 1 回転する。**ガードした分の中で 50〜100 ホップ**、つまり本走行のホップ予算まるごとが、よりによってその分の中で燃える。ガードの目的が正反対に働き、run はセルを大半残して永久に止まる。分を寝て待てば refuse 1 回あたり 1 ホップになり、これが `max_chain_hops` の計算がもともと前提にしていた姿である。9 分ぶんの取りこぼしは `60/51` を掛けて見込んである。
  なおこの 9 分は**連続しない**（実測）。だから 1 回寝れば必ず抜ける。5 本目の cron を足すときはここを壊さないこと（テストで固定してある）。
- **課金は呼び出し回数ではなく `usage` で数える**。応答のたびに `noise_runs.spent_*` を**セルから再計算して**書き直し、どちらかの予算を超えたら run を `aborted` にして止まる。`max_tokens: 8000` では回数は費用の上界にならない。
  再計算にしてあるのはインクリメントを二重に当てる事故（古い claim の再実行、ホップの再コミット）を構造的に不可能にするためで、二重計上は**まだ ok セルが揃っていないのにレポートの門を開ける**＝率を低く出す＝#65 が本物の劣化をノイズと読む方向の誤りになる。
- **測れなかった費用はゼロではない。** 途中で切られた呼び出しは、サーバが既に出したぶんを課金したうえで `usage` をクライアントに返さない。そのセルの `input_tokens` / `output_tokens` は `null`（＝**不明**であって 0 ではない）で書かれる。
  `spent_*` の 2 列は**実測のまま**にしてあり（マイグレーションがそう宣言している列に推測を書くと、以後この run の費用の読みが全部推測になる）、代わりに**上界を別の数として持つ**: 応答に `unmeasured_cells` / `bound_input_tokens_unmeasured` / `bound_output_tokens_unmeasured` が出る。入力側の 1 セルあたり上界はドライランの**行ごと最大**入力トークン数（`notes.unmeasured_cell_input_bound`）、出力側は `max_tokens`。
  **予算の判定は「実測 + 上界」で行う。** そうしないと、全部タイムアウトしている run が「消費 0」のまま母集団ぶん課金できてしまう。
- **予算はドライランと突き合わせる。** `budget_input_tokens` はドライランの `measured_input_tokens` の、`budget_output_tokens` は `bound_output_tokens` の、**それぞれ 2 倍を超えたら拒否**する（2 倍の理由: ドライランは 1 セル 1 呼び出しで数えるが `pause_turn` の継続は 1 セルで最大 5 回叩き、毎回長くなった会話を送り直すので、`search_on` アームがそもそも成り立たなくなる。桁を 1 つ間違えた入力は 2 倍でも止まる）。
  拒否の文面には**比較された 2 つの実測値が入る**ので、断られた側は何と比べられたかを見て決め直せる。
- **1 つの `dry_run_id` で作れるライブ実行は 1 本だけ。** 同じ body を 2 回 POST しても 2 本目は拒否される（`dry_run_id has already been spent by run ...`）。`net.http_post` は非同期で、返り値が `net._http_response` に現れるのは最大 130 秒後だから、「作れたのか分からない」窓＝「もう 1 回叩く」窓である。
  関数側の判定は読んでから書く形なので、数百ミリ秒以内に重なった 2 回は原理的に両方通りうる。そこはデータベース側で閉じてある: マイグレーションの `noise_runs_one_spend_per_dry_run`（`(notes->>'dry_run_id')` の部分一意インデックス、`status in ('running','paused')` の行だけを対象）が 2 本目の INSERT を落とす。**関数はインデックスより厳しい**: `dry` 以外のどの実行にでも引用済みの `dry_run_id` は、`done` でも `aborted` でも拒否し、どの実行が使ったかを返す（実測 2026-09-09: 本番実行の 1 回目がこれで 400、課金 0）。**中断したあとに走り直すときは、ドライランを取り直す**（無料・約 96 秒）。
- **占有率の上限は「チェーンを使わないこと」で守る（2026-09-09 の事故）。** 呼び出しの間隔を空けても、自己 POST で連鎖する限りエッジのワーカーは切れ目なく埋まる。実測: 40 分間ほぼ 100% 占有し、05:08 に postmortem の定時ジョブと重なった瞬間、利用者の `analyze` がワーカーを取れず「接続できませんでした」になった（その 1 件は関数の呼び出しログにすら残っていない。前後の分析は成功）。
  **残りを流すときは `chain:false` で、外から低頻度に叩く。** 一時的な pg_cron ジョブを、既存 4 ジョブと衝突しない分（`1,6,11,16,21,26,31,36,41,46,51,56`）に置き、終わったら `cron.unschedule` で消す。1 発 2 セル ≒ 80 秒 / 5 分 = 占有率 27%。「cron に載せない」という原則は**恒久スケジュールを作らない**という意味であって、運用者が張って外す一時ジョブはその趣旨に反しない。趣旨に反するのは、無人で走り続けることのほう。
- **同時実行はしない — run 単位のリース**で担保する。1 回の呼び出しは `notes.lease_until` を条件付き PATCH で取ってからでないとセルに触らない。取れなければ何も使わずに `skipped:"locked"` で帰る。
  **限界を明記する**: 呼び出しの間隔（最低 2 秒）は**1 回の呼び出しの中でだけ**保証される。チェーンの親が最後に叩いてから子が最初に叩くまでの間隔は保証されない。リースが止めるのは「2 つのワーカーが同時に叩くこと」であって、「2 つの連続したワーカーの間隔」ではない。
- **再試行しない中止条件**: 400 の本文に `credit balance is too low`、**402**（課金ステータスそのもの。上の 400 は 2026-09-08 に観測された形であって唯一の形ではない）、401 / 403 / 429、および **5xx 全部（529 overloaded を含む）**。
  529 は「再試行可能」とされているが、この関数の規則は再試行しないことである。過負荷の共有キーはまさにその典型で、そのときライブの analyze も同じキーで失敗しており、analyze は**モデルを呼ぶ前に quota を消費する**。2 秒間隔で母集団ぶん撃ち続けるのは、障害に向けた負荷試験である。
  `retry-after` と `anthropic-ratelimit-*` は記録のためだけに読む。待って撃ち直すことは、ライブの analyze の呼び出しを落とす行為そのものである。
- **`response.model` が行の `model` と違ったら、そのセルだけでなく run ごと止まる**（`abort_reason` に返ってきた識別子が入る）。
  以前はセルの status だけだった。`report()` は「全反復が失敗した行」を分母から静かに落として `emitted:true` を出すので、走行の途中でモデルが変わると母集団が黙って縮み、全行が影響を受ける場合は 96 回全部叩いてから拒否していた。止めればパイロットが 1 呼び出しで気づく。**ドライランでは検出できない**（`count_tokens` はモデルを返さない）。
  実測 2026-09-09: 保存されている `model` 列は 48/48 が同じ値で、日付サフィックスの無いエイリアスである。そして `response.model` をこのリポジトリが読み戻したことは一度も無い（analyze が保存しているのは**リクエスト側**の値）。つまりこの等値はまだ一度も観測されていない。API がエイリアスを日付入りに解決するなら最初のセルで止まるので、そのとき「解決後の識別子を受け入れる」か「止める」かを決めるのは人である。
- **`search_on` アームの費用は 2 つの予算では縛れない。** web 検索は**リクエスト単位**の課金で、`usage.server_tool_use.web_search_requests` はトークンではない。関数は見つけたら `errors` に `web_search_requests:<n>` として出すが、**上限は無い**。このアームを走らせるなら、上限は人が持つこと。
- **`run_id` と `analysis_ids` は同時に指定できない。** 行の集合は作成時に固定される。以前は `run_id` があると body の `analysis_ids` を黙って無視していたので、「止まった run の数行だけ流し直す」つもりの再 POST が残り全部に課金していた。
- **claim してから使う**: セルは `(run_id, analysis_id, rep)` の一意キーに `Prefer: resolution=ignore-duplicates` で先に INSERT する（既定の `status='claimed'`）。0 行返れば他の呼び出しが持っている。claim はモデル呼び出しの**前に**コミットされるので、150 秒で殺されたワーカーは沈黙ではなく証跡を残す。
- **ログに出るのは status・`request_id`・エラーの 200 文字だけ**。body もプロンプトもヘッダもトークンも出さない。

#### 止め方と直し方

```sql
-- キルスイッチ。次のホップがこれを読んで撃たない（走行中の 1 セルは走り切る）
update public.noise_runs set status = 'paused' where id = '<run id>';

-- 再開: 状態を戻してから run_id で 1 回叩く（chain:true なら以後は自走する）
update public.noise_runs set status = 'running' where id = '<run id>' and status = 'paused';
--   body := jsonb_build_object('run_id','<run id>','dry_run',false,'chain',true,'max_cells',2)

-- 予算で止まった run を続ける: 予算を上げ、status も戻す（2 つとも意図的に手で行う）
update public.noise_runs set budget_output_tokens = <n>, status = 'running', abort_reason = null
 where id = '<run id>' and status = 'aborted';

-- ホップを使い切って止まった run: 上限を上げるか、run_id で叩き直す
update public.noise_runs set max_chain_hops = max_chain_hops + 20 where id = '<run id>';

-- claim したまま終わらなかったセルを消したあとは、status も戻すこと。
-- claim 残りがある run は 'done' にならず 'running' のままなので普通は不要だが、
-- 手で 'done' や 'aborted' にしてしまった run はこれを戻さないと再開が無反応になる
-- （run_id での再 POST は status が 'running' でなければ何もしない）。
update public.noise_runs set status = 'running', abort_reason = null
 where id = '<run id>' and status in ('done', 'aborted');
```

- **最初のライブ実行で `patch_failed:noise_runs_lease` が返って 500 になったら**、リースの PostgREST フィルタ（`notes->>lease_until=lt....`）の綴りが通っていない。**そのとき課金は 1 回も起きていない**（リースはセルに触る前に取る）。比較の意味論は Postgres で実測してあるが、REST の綴りはこの環境から end-to-end で叩けなかった。直すのは `index.ts` の 1 行。
- **`skipped:"locked"` が返ったら、その run は別のワーカーが持っている。** チェーンのホップが飛んでいる最中か、165 秒以内に死んだワーカーのリースが残っているか。何も使わずに帰っているので、待ってから叩き直せばよい。**リースが理由で「動いていない」と判断しない。**
- **`unfinished_cells > 0` の run は `done` にならない。** `pending`（＝まだ claim されていないセル）が空でも、claim したまま終わっていないセルがあれば `running` のままにする。以前はここで `done` を書いていたので、**途中の run が完了した run に見え**、しかも上の「消してから再 POST」がその後 status で弾かれて無反応になっていた。

- **claim したまま終わらなかったセルは自動で再取得しない。** 支払い済みかもしれない呼び出しをもう一度撃つと、記録は 1 回なのに請求は 2 回になる。止まった run は止まったまま見え、レポートの門は閉じたままになる。やり直すなら人が消す:
  ```sql
  select id, analysis_id, rep, claimed_at from public.noise_cells
   where run_id = '<run id>' and status = 'claimed' order by claimed_at;
  delete from public.noise_cells
   where run_id = '<run id>' and status = 'claimed' and claimed_at < now() - interval '15 minutes';
  ```
- 進捗の確認:
  ```sql
  select id, status, arm, reps, expected_cells, completed_cells, failed_cells,
         spent_input_tokens, budget_input_tokens, spent_output_tokens, budget_output_tokens,
         chain_hops, max_chain_hops, abort_reason
    from public.noise_runs order by created_at desc limit 5;
  select status, count(*) from public.noise_cells where run_id = '<run id>' group by 1 order by 2 desc;
  ```

#### 2 つのテーブルが意味するもの

| テーブル | 1 行が意味するもの |
|---|---|
| `public.noise_runs` | 再実行 1 本の**ヘッダ**。凍結した母集団（`population_frozen_at` と `notes.population.ids`）、アーム、`reps`、`expected_cells`、実測の消費トークン、そして終わったかどうか。 |
| `public.noise_cells` | **1 行 1 反復**。送った形（`shape` / `effort` / `max_tokens` / `tools_present` / `schema_in_prompt` / `schema_era`）、送った 2 つの文字列の sha256、正規化**前**の生の答え、そしてそのセルが測定になっているかを言う `status`。 |

- どちらも RLS 有効・ポリシー無し、`anon` と `authenticated` から revoke 済み。読み書きできるのは `service_role` だけ。`rls_enabled_no_policy` が INFO の advisor に出るのは**意図した状態**で、`analysis_prompts` が `20260905161000` から持っているのと同じ。
- **プロンプト本文は保存しない。** 保存するのは実際に送った 2 つの文字列の sha256 だけ。`analyses` はテーブルレベルで `authenticated` に select を許しているので、デバッグの便宜でプロンプトを 2 つ目のテーブルに書き戻せば `20260905161000` が消した露出を作り直すことになる。2 反復が同一のバイト列を送ったことを示すには digest で足りる。
- **ヘッダを 2 つに分けてある理由**: 途中の run が完了した run に見えてはいけない。レポートは `completed_cells + failed_cells < expected_cells` の間、率を出すことを拒否する。「読めなかったことはゼロではない」に立つ足場がこれである。
- `status`（run）: `dry` → `running` → `done` / `aborted` / `paused`。`status`（cell）: `claimed` と、`metric.ts` の 9 つの終了値（`ok` / `http_error` / `parse_failed` / `missing_keys` / `refusal` / `truncated` / `timeout` / `pause_exhausted` / `aborted`）。
  **`ok` 以外は分子からも分母からも外れる。決して WAIT にしない**: `normalizeAnalysis` は読めない signal を `"WAIT"` に、読めない confidence を `0` に丸めるので、正規化後だけを読むハーネスは解析失敗を全て「WAIT で一致」と数え、床を実際より低く出す。実測 2026-09-09 で 48 行中 45 行はフィールド契約をプロンプト中の散文からしか受け取っていない。
  セルの `aborted` は「これは測定ではない」を 3 つの理由で表す（行を分類できない・`response_model` が行の `model` と違う・答えが列に収まらない）。理由は `error_slice` に入る。
- **母集団（2026-09-09 実測）**: `analysis_prompts` 48 行、`analyses` に 48/48 join、`mode='full'` 45・`technical_only` 3・`technical_fallback` 0、`preview` 4、v48 世代 4、**この 2 つの層は互いに素**（だから中核は 40 行で、0/40 の Wilson 上限 8.76% は分岐点 8.8% の真上にある。n=48 と n=40 は必ず並べて出す）。
  直近 24 時間で 22 行増えていた（マイグレーションのコメントは数時間前に 23 行と実測している。窓が動くだけで桁は同じ）。**分母が 1 日で自分の半分ほど動く表なので、凍結は形式ではない。**

---

## 6. デプロイ手順

### 6.1 順序の不変条件

1. **エッジ関数を先に、フロントエンドを後に。** フロントは新しい `evaluation` の形を読むので、逆にすると古い関数が書いた行を新しい UI が読めない時間ができる。
2. 関数を変えたら **バージョン文字列を上げる**: `TRACKER_VERSION`（track-outcomes/index.ts）、`POSTMORTEM_VERSION`（postmortem/index.ts）、`FUNCTION_VERSION`（analyze/index.ts、econ-calendar/index.ts、noise-floor/index.ts）。
   返り値と `tracker_state.last_sweep_result.version` / `postmortem_state.last_result.version` / `econ_calendar_state.last_result.version` に出る（状態テーブルに書くのは sweep モードのときだけ。analyze は返り値と `X-Function-Version` ヘッダ）ので、本番で「どれが動いているか」を確かめる唯一の手がかり。
   noise-floor は返り値と `public.noise_runs.version`（run を作った呼び出しのバージョン）に出る。
3. デプロイしたものは **読み戻して sha256 を比べる** まで「デプロイ済み」と言わない。
4. データを直すマイグレーションは、それを解釈する関数を先にデプロイし、cron を止めてから流す（§4.3）。

### 6.1.1 バンドルは行で折る（--line-limit=200）

- デプロイは Supabase の `deploy_edge_function` にファイル内容を **インラインで**渡す。つまり誰か（人でもエージェントでも）が中身を転記する。
- ミニファイの既定は 1 行に詰める形なので、analyze のバンドルは **64 行・最長 15,717 文字**になっていた。この形は読むことも正確に写すこともできず、2026-09-06 のデプロイでエージェントが「この大きさでは転記できない」と実際に拒否した。手写しの事故は #48 と #51 で 2 回起きている。
- `--line-limit=200` を付けると **402 行・最長 447 文字**になる（サイズ増は 0.5%）。折れないのは長い文字列リテラル（日本語のプロンプト）だけ。
- 4 つのバンドルすべてに付ける。`bundle:analyze` / `bundle:track-outcomes` / `bundle:postmortem` / `bundle:noise-floor`。
- **サイズは監視項目**。analyze は 78.8KB、postmortem は 82.0KB（2026-09-06）、noise-floor は 51.5KB・263 行・最長 372 文字（2026-09-09 実測、安全装置の修理後）。これ以上育つなら、インライン以外の経路（CLI にはアクセストークンが要る）を用意する必要がある。
  `.claude/workflows/deploy-edge-verified.js` の説明文は「約 93KB・約 432 行」を前提に書いてあるが、これは analyze / postmortem の話であって noise-floor はその半分強である。ワークフローは切り出す前に `wc -l` を取るので動作は正しい。数字のほうが 4 つのスラッグ全部には当てはまらない、というだけ。

### 6.2 手順

```sh
npm test                     # vitest 全件（現在 1002 / 40 ファイル）
npx tsc --noEmit -p tsconfig.app.json   # 既存エラー 12 件が基準。増やさない
npm run check:functions      # deno check（5 関数の入口）
npm run bundle:functions     # esbuild minify → supabase/functions/<slug>/bundle.js（gitignore 済み）
( cd supabase/functions/<slug> && timeout 6 deno run --allow-net --allow-env bundle.js ); echo $?   # 124 = 起動して待機中 = OK
```

- デプロイは保存済みワークフロー `.claude/workflows/deploy-edge-verified.js` で行う（`scriptPath` で起動、`args: { slug, version }`）。
  中身: `deploy_edge_function`（`entrypoint_path: "bundle.js"`, `import_map_path: "deno.json"`, `verify_jwt: false`, files = `deno.json {"imports":{}}` + `bundle.js`）→
  `get_edge_function` で読み戻し → ローカルと sha256 比較。sha256 か `version` 文字列が不一致なら再デプロイ（合計 3 回まで。初回 + 再試行 2 回）。
  最後まで一致しなくても例外は投げない。sha256 と `version` 文字列のどちらが合わなかったかをログに書いて返り、返り値の `verified` が false になる（版だけ合わないときは大抵ローカルのバンドルが古い。作り直す）。
  `args.version` には `POSTMORTEM_VERSION` 等の文字列全体（例 `postmortem-v9-2026-09-05T05:35:00Z`）を渡す。部分文字列だと sha256 が一致していても 3 回使い切る。
- バンドルは一度モデルの出力を経由するので写し間違いが起こり得る（このプロジェクトで実際に複数回起きた）。検証を省かない。
  postmortem（約 71 KB）だけでなく analyze（約 54 KB）のバンドルも Read の 1 ページに収まらない。バンドルを持つ 4 つ（analyze / track-outcomes / postmortem / noise-floor）はどれも必ずワークフロー経由。
  econ-calendar は `./events.ts` しか読まないのでバンドルを作らず、この手順の対象外。
- 長い関数（postmortem）を差し替える間は cron を止める: `cron.alter_job(4, active := false)` → デプロイ → `true`。
  止めずにデプロイすると、切り替えの瞬間に飛んだ tick は応答を受け取れない。2026-09-05 11:08Z の実測では pg_net が 150 秒待ち切って
  `Timeout of 150000 ms reached` を記録し、本文は空だった。関数は起動しておらずクールダウンも取っていないので次の tick は普通に走る（1 回分の記録が消えるだけ）。
  検証付きデプロイは 3 回まで試すので、止めるべき窓は数分ではなく十数分ある。
  判定側（track-outcomes）は 1 回の走行が短い（LLM 呼び出しが無く、cron の timeout も 90 s）ので通常は不要。10 分クールダウンは両関数に同じ値で入っており、止める・止めないの理由にはならない。
- 本番での確認: 次の sweep の返り値（`net._http_response`）の `version` が新しいこと。analyze は認証なしで叩くと 401 と一緒に `version` と `diagnostics` を返す。

### 6.3 フロントエンド

1. PR → squash merge → `main`。
2. Lovable の `deploy_project`（project `5c09cdc7-f0d2-421a-8546-1ae88d357daa`、publish 名 `fx-canvas-mind`）。**フロントに変更があるときだけ。**
3. 公開確認: `index.html` を nocache で取り直し、参照している `assets/index-*.js` が新しいハッシュになっていること。CDN の反映に 2–3 分かかる。
4. 作業ブランチを `main` に揃える: `git checkout -B claude/app-confirmation-jvmk03 origin/main && git push --force-with-lease -u origin claude/app-confirmation-jvmk03`。

### 6.4 コミットに入れてはいけないもの

- `bundle.js`（gitignore 済み）、レビュー用の使い捨てテスト `src/test/zzprobe*.test.ts`、パスワードやトークンの文字列。
- アシスタントのモデル名は説明文・コメント・PR 本文に書かない。例外は所定の `Co-Authored-By` トレーラーと、API 呼び出しに必要なモデル ID（postmortem の `MODEL`、analyze の `model:`）。

---

## 7. 秘密とアクセスの扱い

| 秘密 | 置き場所 | 読める者 |
|---|---|---|
| sweep トークン | `vault.decrypted_secrets` の `track_outcomes_sweep_token` | `public.track_outcomes_sweep_token()`（`security definer`、**`service_role` のみ実行可**）、cron の SQL（track-outcomes / postmortem / econ-calendar）、および **noise-floor**（cron からは決して呼ばれない。人が psql から叩くときの SQL と、チェーンの自己 POST だけ） |
| `SUPABASE_SERVICE_ROLE_KEY`、Twelve Data のキーなど | エッジ関数の環境変数 | 関数だけ |
| 管理者 | `ADMIN_EMAILS`（analyze / postmortem / econ-calendar の各 `index.ts` と `src/lib/admin.ts` の 4 か所に同じ配列） | `k.munemoto@kyoto-salute.com`, `munekan2989@gmail.com` が Pro 相当 |

**不変条件**

- トークンの値はリポジトリ、マイグレーション、チャット、ログのどこにも書かない。関数を SQL から呼ぶときは必ず `(select decrypted_secret from vault.decrypted_secrets where name = ...)` をヘッダ式に埋める。
- 関数は受け取ったトークンを RPC 経由で取り出した値と **定数時間比較** する（`constantTimeEqual`）。空文字は不一致。
- `consume_analysis_quota` / `release_analysis_quota` / `track_outcomes_sweep_token` は `service_role` だけが実行できる。`public`, `anon`, `authenticated` からは revoke 済み。
- `public.analysis_prompts`（分析 1 件につき system / user / model / sent_at）は **RLS 有効・ポリシー無し**で、`anon` と `authenticated` からは grant を revoke してある。読み書きできるのは `service_role` だけ。
  `analyses` はテーブルレベルで `authenticated` に select を許しているので、同じ列をそこに置くとシステムプロンプト（ルールブック本文を含む）がクライアントから読める。プロンプトの保存に失敗しても分析は返す（失敗するのはその 1 件の再現性だけ）。
- `public.rulebook` はクライアントから直接 SELECT できない（PR #23）。ルール本文を返すのは `rulebook_for_client()`（`authenticated`）だけ。
  `loop_health()`（`authenticated`）/ `public_track_record()`（`anon` + `authenticated`）も `security definer` で同じテーブルを読むが、返すのは version・現行契約で有効なルール数・更新時刻だけ。
  他ユーザーの `analysis_id` はクライアントに返さない。
- 上の grant を変えるときは必ず `authenticated` ロールとして RPC が動き直接 SELECT が拒否されることを SQL で確かめる。

### 7.1 分析クォータ

- クォータは **課金される作業の前に** 1 発の条件付き UPDATE（`consume_analysis_quota`）で消費する（読んで・比べて・書く、では並行要求が 1 クレジットで複数回通る）。
  その後の失敗経路は必ず `release_analysis_quota` で返金する（同じクレジットを二度返さない）。ゲートが WAIT に落とした分析も返金。管理者は消費しない。
- 順序: 認証 → プラン確認（`PAID_PLANS = light/standard/pro`、free は 402）→ 休場確認（`isPossiblyClosed` なら 409）→ クォータ消費 → ルールブック → カレンダー → 市場データ → モデル。未課金と休場はクォータの前に弾くので課金されない。
- 上限: light 10 / standard 30 / pro 9999（1 日）。日替わりは DB の `current_date`。返金は同じ日の行だけで、日付をまたいだ返金は起こらない。
- Supabase は 150 秒でワーカーを殺し、クライアントには返金されない 546 が返る。だから関数は自前の `WALL_CLOCK_BUDGET_MS = 135 秒` で止まり、検索付きは `SEARCH_BUDGET_MS = 85 秒` で検索を諦めて技術分析だけで答える。

---

### 7.2 成績集計（performance_stats）

- 成績は `public.performance_stats()` がサーバ側で **全行から** 出す。クライアントが取るのは行の一覧（直近 40 件）だけで、統計はそこから計算しない。
  40 件から計算していた頃の実害: `clusters` は目標 50 に構造上到達できず（その分岐は死んでいた）、`sumR` は移動窓の合計なので**勝ちトレードの後に減ることがあり**、信頼区間は n が 40 で頭打ちなので永遠に狭まらず、4 つの内訳は 40 件を 2〜3 件のセルに割って勝率に色を付けていた。
- **`security invoker`**（`loop_health` と違う）。RLS が呼び出し元の行だけに絞るので、ユーザ絞り込みを書き忘れる余地が無い。`prosecdef = false` であることを本番で確認済み。
- **どのグループも勝率を単独では返さない**。同じオブジェクトに `decided` / `sum_r` / `trades_per_call` / `wait_rate` が必ず並ぶ。
  「正解率が上がった」のか「取引を減らしただけ」なのかは勝率だけでは区別できず、後者は decided と trades_per_call が下がり wait_rate が上がり sum_r が下がる、という形でしか見えない。
- 返す軸: `scopes`（all_time / last_90d / last_50_calls）、`by_rulebook_version`、`by_confidence`、`by_timeframe`、`by_mode`、`by_contract`、`shadow`。
- 契約は混ぜない。scopes と各内訳は **現行契約の行だけ**で、それ以外は `other_contract_rows` に件数だけ出す。
  ただし `by_contract` は全行から作る。**全部が旧契約という状態は実在する**（本番の 21 件は全部 `entry_chosen_v1`。契約変更後まだ 1 件も分析していない）ので、現行契約で絞り切ると記録がまるごと消える。混ぜるのではなく、契約ごとに別のオブジェクトにして両方見せる。
  クライアントは `headlineScope()` で選ぶ: 現行契約に件数があればそれ、無くて旧契約が 1 つだけなら旧契約（ラベルにその契約名を出す）、それ以外は現行契約の空の集計。
- WAIT の判定は `scorer >= 2` のものだけ数える（§3.6）。
- `below_min_n` は決着 20 件未満の印。**率は伏せない**: 信頼区間を添えて出すほうが空欄より情報量が多く、伏せると「件数が少ない」ことまで見えなくなる。
- クライアント側の `tally()` は消していない。RPC が落ちたときのフォールバックで、そのときは「直近 N 件のみで集計」とラベルが変わる。統計と一覧は別の母集団なので、`stats-scope` と `history.scope` の 2 つのラベルが別々に付く。

---

### 7.3 推測と事実の区別

- アプリは**板情報・出来高・建玉・約定履歴を一度も取得していない**。「ストップが溜まっている」「大口が仕込んでいる」「ストップ狩り」は全部、値動きからの推測。最初の21件では、それが「RSI は 44.1」と同じ声で書かれていた。
- プロンプトから「直近スイングのすぐ外側のストップハントゾーンを特定する」という指示を**削除**した。板を見ていないアプリに他人の注文の位置を推定して報告しろと言っていたことになる。
  `smart_money` は必須列挙から外した（21件で Distribution 18 / Accumulation 3 / Neutral 0、方向と完全一致で、方向以上の情報が無い）。
- **タグ付けは描画時**（`src/lib/inference.ts`）。モデルに自己申告させない理由:
  - 検証されないタグは今より**悪い**。「実測」チップは区別なしの散文より強い断定になる。
  - 描画時なら**既存の行にも遡って効く**。
  - web 検索経路では構造化出力が使えない（非互換）ので、スキーマは散文としてしか届かない。
- **断り書きは全文一致でのみ除外する**。部分一致にしていた版は、プロンプトが「推測と明示して書け」と指示しているせいで**従ったモデルほどタグが消える**という逆転を起こした（断り書きと主張が同じ文に入るため）。雑に断定した方がタグが付く、という最悪の設計だった。
- 語彙は**日英両方**（本文はロケールに追従するので、日本語だけだと英語の回が素通りする）。曖昧な語は入れない（`買い方` は `買い方向` に一致して、計算済みの事実にチップを付けた。チップが実測値に出た時点で意味を失う）。
- タグを出す場所: thesis（画面で最大かつ履歴に残る唯一の文）、key_factors、analysis、market_context、warnings（アプリ自身の声として読まれる欄）、`smart_money` 行、`stop_hunt_zone` 行。
- **既知の限界**: 語彙一致は言い換えに負ける。`157.10を上抜ければ加速しやすい` は同じ主張だが、どの語彙にも一致しない。**床であって、ふるいではない**。モジュールとテストの両方に書いてある。
- チャートは2つの見た目で描く: **破線=サーバ計算の水準**（確定スイング、終値で抜けた水準）、**点線+「(AI)」=モデルが挙げた水準**、**帯=現在価格の雲**。
  重ね描きは**価格レンジを広げない**（遠い水準に合わせると全ローソク足が平らになる）。範囲外は描かず、**件数を凡例に出す**（黙って落とすと「無かった」と読める）。
  ラベルは**左端**に置く（右のレーンはプランのもので、そこに市場の水準を足すとスマホでエントリーと損切りのラベルが画面外に押し出される）。

---

## 8. 既知の限界

- **旧契約（`entry_chosen_v1`）の再導出**: pending の旧契約行を Bid/Ask や細かい足で判定し直すとき、指値・逆指値（`classifyOrder` が `market` 以外と分類した注文）の約定は細かい足から再導出する。
  「触れる前に反対側へ抜けた」足があれば約定を前倒しし、触れた足があれば再導出、どちらも無ければ前回の状態を引き継ぐ。
  細かい足が約定前の区間を歩けない場合は前回の判定を残す。詳細は `evaluate.ts` の "Known limits, all on the legacy contract" で始まるコメント。
  2026-09-05 時点で pending の旧契約行は 1 件あるが、`entry_point` と `price_at_signal` の差が `FILL_TOLERANCE` 内で `market` と分類されるため、この再導出の分岐には入らない。
- **推測タグは postmortem 経路に届かない**: `isInference` は描画時の関数なので、人間が見る画面にしか効かない。しかし analyze の散文（`key_factors` / `analysis`）は postmortem にそのまま証拠として渡り、そこから出た `evidence` / `lesson` がルールブックに入り、また analyze のプロンプトに戻る。
  この **モデル→モデルの経路にはチップが1つも無い**。「大口の売りが上値を抑えている」を根拠にした教訓が、誰もチップを見ないまま規則になりうる。未対処。
- **WAIT の採点足は Twelve Data 固定**: `wait_plan` の価格は GMO オーバーレイが採用された足（`entry_check.price_feed = gmo`）由来のことがあり、`acceptOverlay` は 2 つのフィードが `MARKET_TOLERANCE_ATR = 0.15 ATR` まで離れていても通す。一方 WAIT の sweep は常に Twelve Data の足を取る。
  損切り幅が `MIN_STOP_ATR = 0.4 ATR` しかないので、フィード差が最大で損切り幅の 3 割強に達しうる。トレード側は同じフィードで約定させて塞いだ縫い目が、WAIT 側では開いている。`entry_check.price_feed` と `feed_delta_atr` で事後に切り分けられるようにはしてある。
- **GMO の取引日の境界**: 夏時間で 06:00 JST 開始を実測。冬（NY 17:00 = 07:00 JST の可能性）は未実測。`fetchQuoteWindow` は 4 キーまで歩くので実用上は問題ないが、`jstDayKey` はどちらも断定しない。
- **仲値へのフォールバック**: 3 日（`MAX_QUOTE_LOOKBACK_MS`）より古いプラン、GMO に無いペア／判定足、Bid/Ask の取得が空・欠損あり・失敗で返った行は Twelve Data の仲値で判定される。
  `MAX_QUOTE_REQUESTS` の予算切れは仲値に落とさない。グループの粗い足が取れなければ行を触らず次の tick の先頭へ回し、精査の窓が予算で切れた場合は `refine_pending` で stamp して判定足 1 本分後に戻す（§3.2 / §3.3 / §3.5）。`price_basis` で見分けられる。quotes から mid に落ちた pending 行は判定価格が変わる（§5）。
- **4h / 1day プランの精査**: シグナル足のサブ足だけが 5min まで降りる。後続の 1h 足は 15min で止まる（§3.3）。`MAX_REFINE_ATTEMPTS = 3` は全段で共有。
- **`ambiguous` は推測しない**: 精査を尽くしても順序が分からないプランは採点されない。`evaluation.ambiguity.site` の語彙:
  `incoherent` / `pre_fill` / `unfilled_touch` / `fill_bar`（この 4 つは旧契約のみ）/ `window_short` / `no_finer_data` / `signal_bar`（market_v1 で最多になる見込み。まだ実績は無い）/ `in_trade` / `feed_conflict`。
  `bar_range / span` が 1 前後なら梯子が 1 段足りない（データで直す）、3 以上なら本当の急変（そのときだけ採点規約を再考）。行ごとではなくヒストグラムとして読む。
- **型検査の基準線**: `npx tsc --noEmit -p tsconfig.app.json` は既存のエラー 12 件がある。増やさないことだけを見ている。
- **現行契約の実績がまだ無い**: 2026-09-05 時点で `analyses` は 21 件すべて旧契約（`entry_chosen_v1`）で、`market_v1` の行は 0 件。契約変更後にまだ分析が走っていない。
  現行契約の統計・ルール・shadow の挙動はすべてコードの上での話で、本番の裏付けはこれから。
- **フットプリントが測れる引用は半分以下**: `analyses` 21 行のうち `context.entry` を持つのは 10 行、`lessons` 17 件のうち判断時点のスナップショットを引けるのは 9 件（2026-09-06 時点）。
  現行のルール 3 本では `r11` が 3 件、`r10` が 5 件中 4 件、`r4` は 1 件しか読めず、`r4` は常に `unknown` になる。フットプリントは本番が育つまで薄い。
- **軸は形成中の足を含んだ値で測る**: 構造と抜けは確定足だけで判定する（§2.0）が、`situation.ts` の 5 軸は違う。行に残っているスナップショット（`context.entry`）が昔から形成中の足込みの値で、`closedSnapshots` は保存していないため。
  ここで生きた側だけ確定足にすると「確定足の現在」と「形成中の足の過去」を比べることになり、揃っていない方が悪い。軸は事象ではなく連続量で、許容（ADX 10・RSI 8・1 ATR）は形成途中の振れに対して広い。確定足のスナップショットを行に残せるようになったら両側を同時に移す。
- **ペアを軸にも門にもしていない**: 軸はすべて無次元なので、USD/JPY で学んだルールが EUR/USD の同じ形に当たりうる。本番の証拠が全部 USD/JPY なので今は差が出ないが、意図的な選択であって検査漏れではない。ルールは「伸び切ったトレンドを追うな」のような一般則として書かれている。
- **軸は指標だけで、構造と時間帯を持たない**: `situation.ts` は `compactSnapshot` にある値しか使えない。構造とダイバージェンスは 2026-09-06 から行に残るようになった（§2.1.1）が、**それ以前の行には無い**ので、構造を軸に足しても既存のルールのフットプリントでは全部 thin になる。足すのは新しい行が溜まってから。時間帯（セッション）はそもそも計算していない。
- **週末の足は analyze でも常時落とす（2026-09-07 修正）**: `fetchSeries` の中で `barFullyClosed`（`_shared/market-hours.ts`）を全ての足に当てる。下見だけ・末尾だけだった切り詰めをやめ、3 つの足すべてが通る 1 か所で落とす。
  狭い述語 `isMarketClosed` を足の**開始時刻**ではなく**期間全体**に問う。開始時刻で問うと、日曜名の 1day 足（週の寄りと週末ギャップを持つ）と、1 日が週末に当たる月足（本番の月足は 1 日始まり。2026-08-01 は土曜）を毎週消してしまう。閉場の最長連続は 47 時間（`CLOSED_WINDOW_MS`）で、それより長い足は必ず取引時間を含むので落とさない（7 日 = 7 の倍数なので週足だけがこのガードを必要とする。30 日足は端点判定だけで既に安全）。
  **日曜の寄り前帯（17:00Z 以降）は落とさない**（`SUNDAY_PREOPEN_UTC_HOUR`）。これは実測による例外である。本番 1b003cf3（2026-09-07T01:06:34Z 送信）の 4h 足 `2026-09-06 17:00`（= 日曜 17:00-21:00Z）は
  `O 156.23401 / H 156.38212 / L 155.86375 / C 155.99882`、値幅 0.518。前後の週末の足は 0.018〜0.092 で、この安値 155.86375 が週の寄りの安値、終値は次の 21:00 足の始値と 5 桁一致する。**週末ギャップがこの足に入っている。** 期間全体を `isMarketClosed` だけで見ると 15min/1h/4h でこの足が毎週消える — ATR を守るために入れたフィルタが、狭い述語が防ぐはずの「本物のデータの破壊」をやる。17:00Z は実測が特定できる一番粗い境界（プリントは 17:00-21:00Z のどこかで、プロンプト 1 本ではそれ以上絞れない）なので、保守的にバケットの先頭を採る。
  **粗い足のスタンプは足の開始時刻ではなく取引日の「名前」である**（実測）。同じプロンプトの 1day 足は、同じプロンプトの 4h 足の厳密な集約になっている: `1day 2026-09-05` = 4h `09-04 21:00`〜`09-05 17:00` = 金 21:00Z〜土 21:00Z、`1day 2026-09-06` = 4h `09-05 21:00`〜`09-06 17:00` = 土 21:00Z〜日 21:00Z。つまり提供側は外為の 1 日を NY 17:00 の引けで区切り、**終わる日の日付で名付けている**。4h の格子も `{01,05,09,13,17,21}Z` であって `{00,04,...}Z` ではない（4h `2026-09-04 21:00` が 1h の 21:00+22:00+23:00+00:00 と厳密一致することで確認）。
  そのため 1day では「その名前の取引日は取引日か」を問うことになる。これは**正しい問い**で、正しい答えを出す。真の期間でモデル化する方が悪い: 金 21:00-22:00Z は狭い述語では開場なので、期間判定は 24 分の 23 がフィラーの土曜名の足を**残して**しまう。日曜名の足は上の寄り前帯の規則が既に残す。
  平坦さの判定は **足していない**。フィラーの足は平坦ではないため（2026-09-06 07:55Z の行は 20 本すべてがフィラーの窓で BB 上限 156.250 / 下限 156.229 = 2.1pips、標準偏差は 0 ではない）、AND を取ると 1 本も落ちず、しかもログにも出ない。
  落とす分だけ取得本数を増やした（`OUTPUTSIZE`: 15min 550 / 1h 480 / 4h 400 / 1day 320 / 1week・1month 250）。週あたりの閉場スロットは 172/672・43/168・10/42・1/7、最悪時の残存は 378/351/300/274 本。従来の 250 本のままだと 78/164/190/214 本になり、上 3 つは SMA200 の 200 本を割る。Twelve Data の課金はリクエスト単位なので 1 回 3 リクエストのままで費用は増えない（`start_date`/`end_date` でページングすると 3 という数が崩れる）。
  `rawCount` は落とした分を引いてから返す。`seriesHealth` の 5% ゲートは**壊れたフィード**を捕まえるためのもので、意図して捨てた足を入れると 15min で 31%・1day で 14% になり毎回 502 になる。なお分母が「残すつもりだった行数」に変わったぶん、壊れたフィードを捕まえるゲートは相対的に**厳しく**なる（15min なら 550 行のうち 19 行 = 3.4% で発火する）。意図した方向だが、締めていることは締めていると書いておく。GMO オーバーレイ採用時は `rawCounts[0]` を GMO の本数に置き直す（480 のまま残すと 230/480 = 48% で、採用したら必ず 502）。
  `minBars` も足ごとにした（15min/1h/4h/1day は 200 = SMA200 の下限、1week/1month は 52 = 一目均衡表 spanB）。上位足の `2` は 130 本回帰を見逃した値。
  効果（本番の実測）: 4h ATR は 2026-09-07(月) 01:07 の 0.313 に対し 09-04(金) 05:57 が 0.564（0.55 倍）。1h ATR は未処理の 09-06 07:55 が 0.041、末尾だけ切った 15:02 が 0.288（0.14 倍）。ATR はこのアプリの寸法の単位なので、小さすぎる ATR は損切り幅・構造の許容・次の水準までの距離・`situation.ts` の軸をすべて歪める。
  1day については、同じ 1b003cf3 の日足ペイロード（確定 19 本）で平均 TR を計算すると 0.8665 → **0.9968（1.15 倍）**。土曜名の足を落とした分である。日曜名の足も落とすと 1.1350 になるので、修正後もなお週末フリーの読みの約 0.88 倍で、**その残差は週の寄りを持つ足を意図的に残していることの代償**である。0.88 を 1.00 にする方法は今のところ無い（提供側がその足に寄りと週末を同居させている）。
  ATR 建ての定数（`MIN_STOP_ATR` / `MAX_STOP_ATR` / `BREAK_TOL_ATR` / `NEAR_TOL_ATR` / `MARKET_TOLERANCE_ATR` ほか）は **この修正では触っていない**。意味が「壁時計の足・縮んだ ATR」から「取引時間の足・本当の ATR」に変わっただけで、同じコミットで調整すると測っている 1 つの変化が混ざる。方向は分かっている: 月曜の ATR はおよそ倍になるので、ATR 建ての許容はすべて広がり、`too_far` の却下は減り、GMO オーバーレイは通りやすくなり、`stretch` は 2.7 付近から 0.8 付近へ落ちる。
- **修正前後の行はスケールが違う（移行しない）**: 既存の `analyses` 行は汚染された ATR で書かれている。フットプリントは行の `context` から作るので、修正後は生きた側だけが動く（`situation.ts` が「両側が同時に動くこと」と言っている不変条件の逆）。それでも移行しないのは、(1) 1h ではずれが週初に集中する — Wilder ATR は直近 40 本に 94.8% の重みがあり、1h ならその 40 本は 40 時間なので水曜にはほぼ収束する（**4h・1day では成り立たない**: 40 本は 4h で 6.7 日、1day で約 8 週なので実効窓は常に週末をまたぐ。1day ATR は本番で木 0.999 / 金 1.015 / 日 1.043 と平日も汚染されており、この 2 つの足では世代の差は週初だけでなく恒常的なスケール差である）、(2) 引用できる行が `context.entry` 付きで 10 件しかなく、書かれた日で門を作るとルールが全部 `unknown` になる、(3) `compactSnapshot` の形も 5 軸も変えていないので契約変更ではなく**データの世代**の話、の 3 つ。
  世代を跨いで混ぜてはいけない列: `entry_check.atr` / `tp1_atr` / `stop_atr` / `distance_atr` / `feed_delta_atr`、`context.structure.*.atr` / `net_atr` / `next_up.atr`、およびそれらが支える `MIN_STOP_ATR` / `MAX_STOP_ATR` / `MIN_RISK_REWARD` の較正。ATR 建てではないが同じ切り替えで**単位が変わる**列も同じ扱いにする: `context.structure[].barsAgo` と `labelFrom` の本数（壁時計の足 → 取引時間の足。`structureLines` が「N本前」として出しているのはこれ）。世代を行に立てるなら `plan_contract` が先例だが、ここでは使わない。
- **track-outcomes の仲値タイムラインは未対処（別タスク）**: `evaluate.ts` の `timeline`（Twelve Data 仲値のフォールバック経路）には閉場のフィルタが 1 つも無く、「仲値のフィードは閉まっている市場の足を出さない」というコメントが付いている。本番のログ（2026-09-06 15:01:21Z、1h で 42 本 / 4h で 10 本 / 1day で 2 本）はそれが誤りであることを示している。
  害は幻の SL/TP ではなく（金曜の終値に座った足が金曜の終値の届かない水準に届くことはない）幻の**市場時間**で、`withMarketTime` が 1h プランの 48 時間のエントリー期限に週末の約 47 時間を計上する。`quoteTimeline` の側は既に `!isMarketClosed(b.t)` で落としている。同じバグ・別の関数・別の契約なので、この差分は広げずに別タスクにしてある。
- **週末でも価格系列は取れる（実測）**: 2026-09-06（日）の実行で `issues` が `["future_bar"]` だけだった、すなわち `too_few_bars` も `dropped` も通っている。Twelve Data は日曜でも 250 本の健全な 1h 系列を返す。最終足は金曜 21:00 UTC より後（`lastClose` を基準にすると `staleAge` が負になる位置）。
- **下見はまだ 1 件も無い**: 2026-09-06 に入れたばかりで、本番の `preview` 行は 0 件。除外が効いていることは `performance_stats()` の数字が入れる前後で一致すること（21 コール / 18 トレード / 10 決着 / 勝率 20% / 3 クラスタ / 採点率 59%）でしか確かめていない。実際の下見が 1 件入ったところで同じ数字が動かないことを見る。
- **未観測**: v12 の Bid/Ask 精査、`quote_refinements`、WAIT の採点、danger の閾値は本番の平日データでまだ十分に観測できていない。月曜の 1h 分析で観る。

---

## 8.5 分析モデルの切り替え（2026-09-12）

オーナーの判断で、**分析（analyze）を Sonnet に、effort を範囲の一番上（`max`）に**した。
安いモデルに移した分を思考の深さに使う、という意図である。

| | 前 | 後 |
|---|---|---|
| model | Opus 5 | Sonnet 5 |
| EFFORT_TECHNICAL | `medium` | `max` |
| EFFORT_SEARCH | `low` | `max` |
| max_tokens | 8000 | 16000 |

effort の範囲は `low` < `medium` < `high` < `xhigh` < `max`。

### max_tokens を上げたのは飾りではない

2つ同時に動いた。effort が `max` になって出力が増える方向に動き、
かつ **このモデルのトークナイザは同じ文章で約30%多くトークンを出す**。
古い組み合わせに合わせた上限は、プランの途中で応答を切る。
**打ち切られた応答は「安い分析」ではなく、金を払った失敗である。**

なお 8000 は元の組み合わせでは一度も近づいていない。実行 48fc15da の
250セルで出力は平均1,683トークン、最大2,813。上限は的ではなく背板なので、
使わない回には一切費用がかからない。

### 壁時計の余裕（実測）

effort は1ターンの支配的な費用で、ワーカーは150秒で殺される。
だから元の値は低く置かれていた。どれだけの余裕に対して使うのかを実測で置く。

実行 48fc15da の250セル——**本物の保存済みプロンプト・前のモデル・
技術パスの `medium`**——でのモデル呼び出し:

| | 秒 |
|---|---|
| 平均 | 31.7 |
| p50 | 31.8 |
| p90 | 36.8 |
| p99 | 42.6 |
| 最大 | 49.5 |

自前の予算は135秒。**技術パスは使っていた時間の約3倍を持っている。**

### 検索パスにはその余裕が無い（隠さずに書く）

`budget.ts` は、フルモードのターンが effort `low` で **135002ms で予算に
当たった**実測を記録している。ここを `max` にするのは、既に無い余裕を使うことである。

そのとき何が起きるかはエラーではない。`planAttempt` が `drop_search` を返し、
技術のみで再試行し、クライアントは劣化バッジを出す。
つまりこの設定の失敗モードは「**ファンダ分析が静かに技術分析になる**」であって
「分析が失敗する」ではない。

ログにそれが出たら、**`EFFORT_SEARCH` だけを単独で戻せばよい**。技術パスは触らない。

### 送信時の形を行に刻んだ（#68b と同じ理由）

`noise-floor/shape.ts` は再生リクエストを組むとき、
**model は行から取り、effort と max_tokens は固定定数から取っていた**。
その非対称は、定数が動く日まで害が無い。動いたのがこの日である。

切り替え前の行を切り替え後に再生すると、その行が一度も送られたことのない深さで走る。
shape.ts 自身のコメントが「本番より長く考えられる再生は、本番の再生ではない」と
書いているのに、である。

なので `public.analysis_prompts` に `effort` と `max_tokens` を足した
（migration `20260912090000`）。analyze が送信時に書き、shape.ts が行から読む。

- **記録がある行**はその値で再生される
- **記録が無い行**（この列より前の90行）は `PRE_SWITCH_*` 定数にフォールバックする。
  それがその行が実際に送られた形だからである
- `PRE_SWITCH_*` は**二度と analyze に同期しない**。これは歴史であって、
  生きているファイルを追いかけるものではない。テストがそれを固定している

effort が NULL になるのは、この列より前の行と、
**API が `output_config` を拒否して effort 無しで再送された行**である。
NULL は「記録が無い」であって「既定値だった」ではない。

### これで無効になるもの

`docs/NOISE_FLOOR_PREREGISTRATION.md` の床（20.83%）と、#65 の実測床（19.5%）と
`material` 判定は、**前のモデル・前の深さのアナリストについての測定**である。
歴史としては有効で、新しいアナリストについては何も言わない。

これは #68b がモデル列を足して防ごうとした混同そのもので、
画面の `ModelMix` パネルが「成績が混ざっている」と言うのはこのためにある。

### 変えていないもの

**postmortem（ルール改訂の編集者）は前のモデルのまま。**
オーナーが言ったのは「分析」であって、学習ループの編集者ではない。
ここを一緒に動かすと、2つの変更が1つの実験として報告される。

---

## 9. 次の実データで確かめること

現行契約（`market_v1`）の行はまだ 1 件も無く、今動いているものの多くはコード上でしか確認できていない（§8）。
最初の平日データが入ったときに、何を・どのクエリで・何と照らして見るかをここに置く。下の SQL はすべて本番で実行を確認済み。

**A. 契約と約定の形** — 現行契約の行が書かれたか、成行として約定したか

```sql
select plan_contract, count(*) as n,
       count(*) filter (where entry_point = price_at_signal) as entry_eq_signal,
       count(*) filter (where evaluation->>'order_type' = 'market') as market_orders,
       count(*) filter (where evaluation->>'price_basis' = 'quotes') as on_quotes,
       count(*) filter (where evaluation->>'spread_at_fill' is not null) as have_spread
from public.analyses
where signal in ('BUY','SELL') and shadow = false
group by 1 order by 1;
```

期待: `market_v1` の行が現れ、その行は `entry_eq_signal` = `n`、`market_orders` = `n`。
`on_quotes` と `have_spread` は 3 日以内なら `n` に一致するはず。`on_quotes` が伸びないなら §3.2 の「仲値に落ちる条件」を疑う。

**B. 判定不能の発生源** — `ambiguous` が出たとき、梯子が足りないのか本当の急変か

```sql
select evaluation->'ambiguity'->>'site' as site, count(*) as n,
       round(avg((evaluation->'ambiguity'->>'bar_range')::numeric), 2) as avg_bar_range,
       round(avg((evaluation->'ambiguity'->>'span')::numeric), 2) as avg_span
from public.analyses
where evaluation->'ambiguity'->>'site' is not null
group by 1 order by n desc;
```

現在 0 件。`signal_bar` が最多になる見込み（§8）。`bar_range / span` が 1 前後ならデータで直せる、3 以上なら本当の急変。1 件ずつではなく分布で読む。

**C. sweep の予算と精査** — Bid/Ask の精査が実際に走っているか

```sql
select created,
       content::jsonb->>'quote_requests'   as q_req,
       content::jsonb->>'quote_refinements' as q_refine,
       content::jsonb->>'refinements'       as mid_refine,
       content::jsonb->>'checked'  as checked,
       content::jsonb->>'deferred' as deferred,
       content::jsonb->>'waits_checked' as waits,
       content::jsonb->>'errors'   as errors
from net._http_response
where status_code = 200 and content like '%track-outcomes-v%'
      and created > now() - interval '24 hours'
order by id desc limit 20;
```

期待: 開いている市場で `checked > 0` の tick に `q_req > 0`。`q_refine > 0` は掠りがあったときだけなので、0 が続くのは異常ではない。
`deferred` が毎 tick 立つなら予算不足（§3.5）。`errors` は常に空であるべき。

**D. 英語の本文が全文で保存されているか**（2026-09-05 の修正の効果確認）

```sql
select 'rules' as what, count(*) as n,
       count(*) filter (where length(r->>'text_en') between 159 and 161) as at_old_cap,
       max(length(r->>'text_en')) as max_en
from public.rulebook, jsonb_array_elements(rules) r where id = 1
union all
select 'lessons', count(*),
       count(*) filter (where length(lesson_en) between 159 and 161),
       max(length(lesson_en))
from public.lessons
union all
select 'lessons(修正後)', count(*),
       count(*) filter (where length(lesson_en) between 159 and 161),
       max(length(lesson_en))
from public.lessons where created_at > '2026-09-05T13:15:00Z';
```

修正前の 17 件中 15 件、ルール 3 件中 2 件は 160 に張り付いたまま（復元不能）。
**見るのは 3 行目だけ**: 修正後に書かれた教訓が 160 に張り付いていたら、上限ではなくモデルの書き方の問題。

**E. WAIT の採点**

```sql
select wait_check->>'verdict' as verdict, count(*) as n,
       -- rejection だけを数えると AI 自身の見送りが「サーバの却下」に化ける（§3.6）
       count(*) filter (where entry_check->>'proposed_signal' in ('BUY','SELL')
                          and coalesce(entry_check->>'rejection','') <> '') as server_rejected,
       count(*) filter (where entry_check->>'proposed_signal' = 'WAIT') as self_declined
from public.analyses where signal = 'WAIT' group by 1 order by n desc;
```

現在は 3 件すべて `unknown`（`price_at_signal` が無かった時代の行なので採点材料が無い）。
新しい WAIT は `pending` → `correct` / `missed` に落ちるはず。新しい行まで `unknown` なら §3.6 の入力（ATR・価格）を疑う。

**F. 勝ちの危うさ（danger）**

```sql
select outcome, count(*) as n,
       count(*) filter (where postmortem->'facts'->'danger' is not null) as have_danger,
       count(*) filter (where jsonb_array_length(coalesce(postmortem->'facts'->'danger'->'flags','[]'::jsonb)) > 0) as flagged
from public.analyses
where outcome in ('win','loss','expired','ambiguous') and shadow = false and postmortem->>'status' = 'done'
group by outcome order by outcome;
```

既存 10 件は `have_danger` = 0。v9 より前に診断された行で、再診断もされないため（§4.1）。**v9 以降に診断された行だけを見る**。
`danger` は約定した全プランに入り、旗が立つのは勝ちだけ（§4.2）。勝ちの大半に旗が立つなら閾値が緩すぎる。

**G. ルールブック改訂の差分**

```sql
select version, updated_at,
       stats->'changes'->>'added'     as added,
       stats->'changes'->>'removed'   as removed,
       stats->'changes'->>'restored'  as restored,
       stats->'changes'->>'dropped'   as dropped,
       stats->'changes'->>'held_back' as held_back,
       stats->'changes'->>'reworded'  as reworded,
       stats->'changes'->>'reasons'   as reasons
from public.rulebook where id = 1;
```

`reasons` は v8 では null（記録前）。v9 以降は `dropped` と `removed` の各 id に理由が付く（§4.3）。
見るべきもの:
- **同じ id が毎回 `dropped` に出るか**。v7・v8 は `r12` が 2 回続けて落ちた。`reasons` がその理由を言うので、`no_evidence` が続くならプロンプト側で引用条件を伝える改善に進む。`book_full` や `add_cap` なら正常な混雑。
- `reworded` が鳴ったら、本当に本文が変わったか history と突き合わせる（v8 の初回は切り詰めの空白差による誤検知だった）。

**H. 週末の足を落とした後の最初の月曜**（2026-09-07 の修正の効果確認）

- ATR が上がったか。同じペア・同じ足で、修正前の月曜の行（`context.entry.atr`）と修正後の月曜の行を並べる。4h で 0.313 → 0.56 付近、1h で 0.04 → 0.28 付近が予想値（§8 の実測）。
- ルールの `fit` が反転したものがあるか。フットプリントは旧世代の行から作られ、生きた側だけが新しいスケールで動くので、`stretch`（ATR で割る）と `bb_pos`（バンド幅で割る）を持つルールが動く可能性がある。動いたら、ルールが変わったのではなく物差しが直ったのだと分かるように記録する。
- ログに `Dropped closed-market bars` が 3 行出ているか（足ごとに 1 行、`dropped` と `kept`）。平日の実行で `dropped` が 0 なら、フィルタが効いていないか取得本数が足りていない。
- 日曜名の 1day 足は**残す**。これは実測で決着済みで（§8）、その足は土 21:00Z〜日 21:00Z にあたり週末ギャップと週の寄りを持つ。320 行のうち日曜名は約 46 本（250 本の分析窓では約 36 本）残るが、消すと毎週の寄りが日足から消えるのでこの側に倒してある。残差は §8 の実測どおり週末フリーの読みの約 0.88 倍。
- 日曜の寄り前帯（17:00-21:00Z）が毎週プリントを持つのか、2026-09-06 だけの現象か。今回はギャップを持つ 4h 足 1 本を証拠に 17:00Z で線を引いた。月曜の 15min/1h の生ペイロードを 1 回見て、17:00・18:00・19:00・20:00Z のどのバケットに実際の値幅が入るかを確かめる。18:00 以降にしか無いと分かれば `SUNDAY_PREOPEN_UTC_HOUR` を上げてフィラーをもう数本落とせる（下げる方向の証拠が出たら下げる）。
- 21:00-24:00Z に `interval=1day` の分析を 1 回走らせる。日足のスタンプは足より 3 時間遅れるので、提供側が新しい日足を 21:00Z 時点で配り始めているなら最新足の `Date.parse` は未来になり、`seriesHealth` が `future_bar` を立てる。1day がエントリー足のときこれは `health[0]` なので **502 `market_data_unhealthy`**（06:00-09:00 JST）。この差分より前からある挙動で、未実測。出たら `seriesHealth` 側の話として別に直す。

---

## 10. 変更するときのチェックリスト

- [ ] 契約を変えるなら `_shared/contract.ts` を起点に、同じ値を持つ `postmortem/facts.ts`（`MARKET_CONTRACT`）・`src/lib/outcomeStats.ts`（`CURRENT_CONTRACT` / `LEGACY_CONTRACT`）・`src/lib/types.ts`（`PlanContract`）と、
  `postmortem/prompt.ts`（診断・改訂のシステムプロンプトが契約名を本文に直書きしている。定数を参照しないのでテストにも型検査にもかからない）、
  DB 側の check 制約 `analyses_plan_contract_check` および `public_track_record()` の SQL リテラル（どちらも新しいマイグレーションで）も同時に変える。
  `src/test/entry-contract.test.ts` / `learning-loop.test.ts` が `PLAN_CONTRACT` との一致を検査するが、check 制約だけはテストされない。そのうえで旧契約の行が統計・ルール選別・判定で別扱いになることをテストで確認する。
- [ ] 判定ロジックを変えるなら「再判定 = 1 回判定」と「形成中の足を割らない」のテストを通す（`src/test/track-outcomes.test.ts`）。
- [ ] 新しい `evaluation` / `postmortem` のフィールドはフロントの型（`src/lib/types.ts`）と表示（`OutcomeDetail.tsx`）と i18n（`ja.ts` / `en.ts`、英語辞書に日本語を入れない）を同時に足す。
- [ ] cron の時刻を変えるなら `cron.job` を直接更新し、§5 の表も直す。
- [ ] 関数を変えたらバージョン文字列を上げ、関数 → フロントの順にデプロイし、sha256 と本番の `version` を確認する。
- [ ] `rulebook` を手で直すなら `version` / `updated_at` / `history` に触らず、cron を止め、新しい関数を先にデプロイしてから流す（§4.3）。
- [ ] 秘密の文字列・使い捨てテストがコミットに入っていないか `git diff --cached` で見る。
