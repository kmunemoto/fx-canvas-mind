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

### 2.3 保有中の判断は新規判断と別に出す（positions / position_review、#89）

- **WAIT は「今から新しく入るのは見送り」であって「決済しろ」ではない。** 画面に新規判断しか無かったので、売りを持っている人が WAIT を見て決済の指示と読んでいた。直すのは 3 点: エントリー登録・保有中専用カード・前回からの変更理由。
- **元のプランは書き換えない。** 建玉は `public.positions`（プランの `analysis_id` を指すだけ）、評価は**今回の**分析行の `analyses.position_review`。参照した行に PATCH は無い。`position_review` が NULL なのは列より前の行だけで、参照が無い回は `status = skipped` の JSON が入る。
- **WAIT から「継続」を導かない。** 保有プランの評価は**別のモデル呼び出し**（`analyze/review.ts`）が行い、新規判断の答えは渡さない。2026-09-13 以降、この呼び出しは**独立したエッジ関数** `position-review` の中で走る（§6.1.2。判断は何も変えていない。動く場所だけが変わった）。理由は 2 つ:
  主プロンプトと `RESPONSE_SCHEMA` は再生ハーネスの資産で（`noise-floor/shape.ts` が凍結コピーを持ち、`analysis_prompts` の 90 行を逐語で再生する）、そこに項目を足すと測定済みの行が黙って無効になる。
  それと主呼び出しは同一入力で 48 回中 10 回 SELL↔WAIT が割れる（NOISE_FLOOR_PREREGISTRATION.md §12.2）。その上に乗せた保有判定は同じノイズを継ぐ。
- **参照は 2 つ、独立に引く。** `held` = このペアで開いている最新の建玉（足は問わない。建玉は建玉）。`previous` = 同じペア・同じ足の直近 72 時間以内の分析行（下見と shadow を除く）。無いときは理由を書く（`no_open_position` / `none_within_window` / `lookup_failed`）。両方無ければ `skipped`。
  評価するのは `held` があればその根拠、無ければ `previous` の根拠（`thesis_of`）。**`change`（前回との差）は常に `previous` について**書く。
- **`previous` が保有されているかは不明。** プロンプトは「建玉として評価しない・建玉があったかのように書かない・損益は仮定値」と明言し、スキーマに verdict の欄が無い（`REVIEW_SCHEMA_PREVIOUS`）。verdict が出るのは `held` だけ。
- **計測した事実が分析側の意見に勝つ。** サーバーが先に計算するもの（`mechanical`、モデル呼び出しの前に確定し、時間切れでも残る）:
  現在値、含み pips / R（`previous` では「プランの価格で入っていた場合」）、損切り・TP1 までの距離、**基準時刻より後の足**での損切り接触と TP1 到達（基準は建玉の `opened_at`、`previous` は `priced_at`。基準時刻を含む足は除外する — その足の値幅には建玉より前の動きが混ざる）。
  **足の開始時刻で切る**。日足のスタンプは「終わる日付」の名前なので（`_shared/market-hours.ts`）、`2026-09-16` の足は 09-15 21:00Z から始まる。スタンプをそのまま時刻として比べると、建玉の 3 時間前の動きが「建玉より後の接触」になり、サーバー判定の撤退条件に昇格する。夏時間で正確・冬時間で 1 時間早い側（`isPossiblyClosed` と同じ向き）に倒す。
  接触は 3 状態: `{measured:true, touched:true, at, bar_closed}` / `{measured:true, touched:false, from, as_of, bars_examined}` / `{measured:false, reason}`。**「未計測」は「なし」ではない。** 系列が基準時刻に届かないときは「なし」を「未計測」に落とすが、見つかった接触は落とさない。
  板は仲値（Twelve Data か GMO 仲値、`feed` に記録）。**仲値の損切り接触は撤退条件として扱う**（§3.2 の理由と同じ: 仲値で刈られる水準は Bid/Ask でも刈られる）。仲値で接触なし・TP1 到達は仲値上の事実で、判定システムの Bid/Ask 判定は `reference.outcome`（`price_basis` 込み）として**横に**出す。混ぜない。
- **verdict の導出（`finalizeReview`）。** `held` のときだけ。
  1. 仲値の損切り接触あり → `exit_condition_met`、`decided_by = server`、`override_reason = {source: mid_touch, at, feed, bar_closed}`。
  2. 判定システムが `loss` で、決着（`closed_at`）が建玉以後 → 同上、`{source: tracker, basis: price_basis}`。決着が建玉より前なら `override_suppressed = settled_before_open`（`opened_at_source = registered` の建玉は約定との前後が分からないので `settled_before_registration`）。決着後に登録した建玉（`registered_after_settlement`）は使わない。
  **この判定（`trackerSuppression`）はプロンプトにも渡す。** 渡さないと、分析側が判定システムの loss を見て `exit_condition_met` と答え、カードはそれを「AI の判定」として、「この決着は使っていない」の 1 行上に出す——抑制がプロンプト経由で破られる。
  3. 分析側の答えが矛盾している（hold×weakened / hold×broken / hold×unknown / caution×broken）→ `undecidable`、`{source: analyst_incoherent}`。答えは `override_reason.analyst` に残す。
  `exit_condition_met × 任意` は矛盾ではない（損切り到達は価格の事実で、根拠の話ではない）。`caution × unknown`・`undecidable × 任意` も同様。ここを広げると、矛盾していない答えに「矛盾している」と出る。
  4. それ以外 → 分析側の verdict、`decided_by = analyst`。
  5. 分析側の答えが無い（時間切れ・API・パース）→ **`verdict = null`**（記録なし）。`undecidable` は分析側の語で、システムの失敗に使わない。画面は「判定できない」と出しつつ理由（時間切れ等）を添える——**語釈（「材料が足りない…」）は出さない**。あれは分析側の語の定義であって、誰も言っていない意見になる。建玉ストリップでも同じで、理由の付かない「判定できない」は出さない。
  参照が引けなかった回（`lookup_failed`）は `skipped` ではなく `failed`。`skipped` は「見るものが無かった」であって、「見に行けなかった」ではない。ログにも出す（出さないと障害が「参照なし」として記録に消える）。
  `analyst` はモデルの答えそのままで、書き換えない。verdict と並べて「誰が決めたか」を必ず 1 行出す。
- **前回との差（`change`）は分析側の方向で分類する。** `signal` 列はゲートが WAIT に書き換えるので、各側で `{signal, proposed_signal, rejection, decided_by, published, analyst_direction}` を持つ。`decided_by` は `isRejected` / `isSelfDeclined`（§2.1）と同じ規則: 公開された売買は分析側、WAIT + 提案が売買 + 却下理由ありはサーバー、WAIT + 提案が WAIT は分析側、提案の記録が無ければ `unknown`。
  `kind` は `same_call / reversed / trade_to_wait / wait_to_trade / unclear` で、**根拠の評価（thesis_status）は入れない**。根拠は別のチップ「AI の見立て: 維持／弱化／崩壊／不明」。「新規の条件が悪くなった」と「前の根拠が崩れた」はこの 2 つの別々の行で読み分ける: ゲートの計測（`current_gate_rr`、AI 自身の WAIT では null＝「計測なし」と表示）と、根拠チップ。
- **時間予算。** 評価はプロンプト構築直後に開始し、主呼び出しと**並行**して走る。すべての fetch に絶対締切（`reviewDeadlineMs(elapsed)` = 壁時計 − `WRITE_RESERVE_MS` 10 s）と `AbortController` を `AbortSignal.any` で束ねて渡す。締切は「予備を食わない」ため、コントローラは**待つのをやめた評価を止める**ため: 猶予切れと `fail()`（評価が飛んでいる間の全エラー経路の唯一の出口）で `abort()` する。止めないと、行を書いたあとにモデル呼び出しを送る——課金され、答えは捨てられ、行が記録した送信内容にも入らない。待つのは `check_open_plans` の後の 1 回だけで、`planReviewWait(elapsed)`（= 最大 `REVIEW_GRACE_MS` 15 s、締切まで）を上限とする。時間切れは `status = partial`（事実は残る）または `failed`。組み立て（`finalizeReview`）は try/catch で、handler の catch-all（返金経路）には届かない。
  並行タスクは `stage` / `messages` / `baseRequest` に触らない（`applyRequestShape` が飛行中に `baseRequest` を書き換え、保存時に読み戻すため）。
- **送ったものは残す。** `public.position_review_prompts`（service role 専用、`analysis_prompts` と同じ扱い）に system / user / model / effort / max_tokens / sent_at。送っていない回（skipped）は書かない。時間切れでも送っていれば書く。将来「同じ入力なら結果を再利用する」を作るときの鍵はここから決定的に導ける。
- **登録（`register_position`）・決済（`close_position`）は SECURITY DEFINER の RPC だけ**（authenticated が呼べる definer 書き込みはこの 2 つが最初）。`search_path = ''`、`auth.uid()` が NULL なら明示的に拒む。登録の検査: 自分の行 / BUY か SELL / 下見・shadow でない / 損切りと TP1 がある / 約定価格が損切りと TP1 の間 / 約定時刻が**プランの書かれた「分」以後**・未来でない（入力欄が分までしか作れないので、秒を持つ `created_at` とそのまま比べると同じ分の約定が「プランより前」になる）。`p_opened_at` 省略時はサーバー時刻を記録し `opened_at_source = registered`（ブラウザの時計を既定値にすると進んだ時計が上限で、遅れた時計が下限で弾かれる）。二重登録は既存の行を返す（`already_open`）。決済は条件付き UPDATE 1 発。
  `outcome` ではゲートしない（判定システムが決着させた後も持ち続けている人はいる）。代わりに `registered_after_settlement` を行に書き、上の 2 で使わない。
- **画面。** 建玉があれば保有中カードを**新規判断の上**に出す（評価が失敗しても出す — カードが無いことが、この作業が消そうとした混乱そのもの）。固定文「下の新規判断（X）は『今から新しく入るか』の判断で、保有中のポジションを決済する指示ではありません」。新規判断が反対方向なら「別の判断です」の 1 行。`previous` があれば「前回からの変化」カードを hero の下に。損切り接触／判定 loss は最上段に赤で「既に達しています（基準）」。
  一覧の建玉ストリップは直近 40 行から最新の判定を探し、無ければ **何が起きたかで言い分ける**: 登録後に分析が走って**別の建玉**（サーバーはペアごとに最新 1 件だけ評価する）を見ていた／建玉を**参照できなかった**／本当に分析が無い。ページの空白を記録の空白として出さない（§7.3）。
  「前回は見送り（水準なし）」は**分析側が WAIT と答えた回だけ**。`levels` が null になるのはもう 1 つ、サーバーが `incoherent` で却下して水準が揃って記録されていない回があり、そこで「見送り」と書くとサーバーの却下を分析側の WAIT に畳む。
  「未計測」の理由文は、基準が約定（`opened_at`）か前回の値付け（`priced_at`）かで言い分ける。建玉が無い参照で「建玉時刻」と書けば、存在しなかったポジションの話になる。
  「現在値」には値が付いた時刻を添える（下見の回では金曜の終値であって、いまの値段ではない）。判定システムの欄は 3 つの沈黙を分ける: **未判定**（聞いて、まだ決着していない）／**プラン行を取得できず**（そもそも聞いていない）／進行中（`pending` に「板の記録なし」と付けない。板は決着のときにしか記録されないので、記録が無いのは当然で、欠落ではない）。
  カードから決済したら、そのカードは「保有中の判断」であることをやめる（決済済みの印を出し、判定を「決済前の判定」と言い直し、「決済する指示ではありません」の一文を下げる）。`positions` は決済済みも読む——閉じた建玉が一覧から消えると、入って決済したプランに「登録」ボタンがまた出て、同じプランに 2 本目の建玉が開く。
  約定・決済時刻の入力はブラウザの時計で解釈される（画面の時刻表示は全部日本時間）。入力欄の下に「記録される時刻」を日本時間で出す。
  `loadHistory` は連番で守る。分析後・登録後・決済後・ログイン時に同時に走るので、決済前に投げた再読込が後で着くと、閉じた建玉が開いた姿で戻る。
- **決済時刻も出どころを書く**（`closed_at_source`）。`close_position` は決済時刻を受け取り、省略時だけサーバー時刻を使って `registered` と刻む。深夜に損切りされて朝に記録した行が、朝の時刻の隣に朝には存在しなかった価格を並べる——`opened_at_source` を足した理由と同じ穴が決済側にあった。採点はこの時刻を使うので、言っていない時刻では採点できない。
- **学習に必要なものは今から残る。** 各評価行に `position_id`・価格・含み R・接触・verdict・`decided_by`・分析側の答え、建玉に決済価格と時刻（と出どころ）。途中の継続／撤退判断の損益を後から採点できる。採点そのものは今回の範囲外。
- **同一入力の再利用（ぶれの削減）は今回やっていない。** `position_review_prompts` に鍵の材料が揃ったところまで。

### 2.4 同じ入力なら、同じ答えを出す（inputs_key / analysis_reuses、#90）

- **なぜ引き直さないか。** 同じ入力に同じ答えは返らない。保存済みプロンプトを再生した 48 回のうち 10 回が SELL↔WAIT で割れている（20.83%、NOISE_FLOOR_PREREGISTRATION.md §12.2）。だから「同じ条件でもう一度分析する」は証拠を増やす操作ではなく、アナリストのノイズを引き直す操作である。入力が本当に同じなら、前の答えをそのまま出す。
- **鍵はプロンプトそのもの。** `inputsKey` = sha256(送った system + 送った user + model + effort + max_tokens + 下見か + **検索付きか** + 契約 + ロケール)。**中身を列挙しない**のが要点で、列挙するとプロンプト側が育つたびに鍵が置いていかれる（足の本数、指標、構造、教訓、イベント欄、言語規則、スキーマ——どれも答えを動かす）。鍵がプロンプトなら、育っても鍵は正しいままである。
  `effort` / `max_tokens` が NULL は「送らなかった」という**形**であって既定値ではない（`output_config` が弾かれて送り直した回）。`preview` は**到着時刻**で決まりプロンプトには出ないので、別に鍵へ入れる。
- **プロンプトに入っていない入力が 1 つある: web 検索。** full モードのリクエストには検索ツールが付いていて、アナリストは**モデル呼び出しの時点で**その日の指標・金融政策・ニュースを取りに行き、`fundamental_score` と本文と `key_factors` に織り込む。その中身はどちらの文字列にも入っていないので、鍵は見られないし、幅でも縛れない——**ニュースは休場中にも出る**。そして休場中こそが、この機能が効く唯一の場面である。
  最初に書いた版はここを見落として「プロンプト = 入力の全部」と言い切り、休場の間ずっと full の行を配る設計になっていた。金曜夜のニュースの読みを日曜の夜に「入力は一字一句同じでした」の見出しで出す、という意味である。**同じではない。**
  よって: **配るのは行の `mode` が `technical_only` のときだけ**（`full` / `technical_fallback` / NULL は `search_used` で断る。不明なモードは「安全と分かっているモード」ではない）。full を含めたければ「検索が返した内容」を保存して鍵に入れる必要がある。やっていない。
- **代償を隠さない: 実測のヒット率は 91 行中 0 件。** 作る前に本番で測ったとき、完全一致は 0 組、時刻の行を外して一致したのは 1 組だけ（下見の 1h、1 分差、両方 WAIT 68）。**その 1 組は `mode = full` だった。** だから上の規則ではそれも断る。今の運用でこの機能はまず効かない。効くのは `technical_only` の回と、フィードが止まっている二重送信だけ。
  なぜ一致しないかは契約に由来する。market_v1 ではプランは「その瞬間の値段」で約定し、その値段はプロンプトに入っている（`現在値:`）。市場が動いている間は 2 回の入力が一致しない。
  **1 分差で WAIT→SELL が割れた実測ペアはこれでは直らない。** あのペアは入力が違っていた（形成中の足の下 1 桁だけ）。直すなら「確定足だけで判断する」という別の変更が要る。この機能はそれをやったふりをしない（§7.3）。
- **外すのは時刻の 1 行だけ。** `現在時刻(UTC): …` / `Current time (UTC): …`。毎回違うので、入れたら一度も一致しない。**ロケールごとに文が違う**: 最初に書いた正規表現は日本語しか知らず、英語の読者では時刻が鍵に残ったまま——機能が死んでいて、それを言うものがどこにも無い、という形になっていた。`src/test/reuse.test.ts` は `analyze/locale.ts` から実物の user メッセージを組み立てて `SUPPORTED_LOCALES` 全部で 1 回だけ当たることを確かめる。削除ではなく**置換**する（`(clock line removed for the reuse key)`）。削ると、その行が無いプロンプトと衝突させられる。
- **外した分は幅で縛る。** 鍵が差を許すのは時計だけなので、窓は「時計がどれだけ動いてよいか」の話しかしていない。開場中は**エントリー足 1 本分**（足が閉じていないことは同一の足データが既に証明しているので、プランを書く単位より短く縛る）。下見は**その休場の全体**（`lastClose()`）——何も取引できないのだから、セッション名も次のイベントまでの距離も、起きた出来事に追い越されようがない。**この「起きていない」が成り立つのはニュースを読んでいない回だけ**で、だから上の `search_used` が先に効く。
- **断った理由は必ず残す。** `served` / `no_match` / `outside_window` / `not_servable`（shadow・結果なし・下見の食い違い）/ `positions_changed` / `search_used` / `lookup_failed` / `key_unavailable` / `forced_fresh`。`public.analysis_reuses` には**効いた回と断った回の両方**を積む。効いた回しか書かないと「一度も効いていない」と「そもそも試していない」が記録上で同じ顔になり、この機能で一番大事な事実（ほとんど効かない）が消える。service role 専用・追記のみ・プランの行は書き換えない。
  この一覧は `analyze/reuse.ts` の `REUSE_OUTCOMES` が正であり、**マイグレーションの CHECK 制約と突き合わせるテストがある**（手で書き写した一覧は、コードが値を増やした日に黙って古くなる）。
- **「引けなかった」を「引いて無かった」と書かない。** 候補の SELECT が非 2xx、建玉を確認できなかった、`created_at` が読めなかった——全部 `lookup_failed`。`no_match` と書けば動けていない機能が「動いて一致しなかった」と読め、`positions_changed` と書けば誰も観測していない読者の建玉についての主張になる（§7.3）。鍵そのものが作れず照会をしていない回は `key_unavailable`。service role キーが無くて 1 行も書けない回は、記録から消えないよう関数ログに出す。
- **建玉が動いていたら断る。** 保存された答えには保有中カードが付いて回る。候補の行以降にこのペアで建玉が登録・決済されていたら、その判定は**別の持ち玉**の話なので出さない。
  境目は行の `created_at` では**ない**。保有中の評価はモデル呼び出しの**前**に建玉を読み、行が書かれるのはその**後**（モデルは実測で平均 31.7 秒・最大 49.5 秒）。書き込み時刻で切ると、その 30〜50 秒の間の決済が見えない。`position_review.at` / `entry_check.priced_at` / `created_at` のうち**最も早い**時刻を使う（早すぎる境目は断りが 1 回増えるだけ、遅すぎる境目は閉じた建玉についてのカードを配る）。
- **索引と照会は同じ綴りで書く。** 部分索引を `where … shadow = false` で作り、照会は PostgREST 経由で `shadow=is.false`（SQL の `shadow IS FALSE`）を送っていた。プランナは BooleanTest が boolean 等値の述語を含意するとは証明できないので、**索引は一度も選ばれない**。本番の `explain` で確認済みで、綴りは対称でもない（`IS FALSE` の索引は `= false` の照会を拾わない）。効いていないと、毎回読者の全履歴を舐めて空振りし、その時間は分析の壁時計予算から引かれる（押し出されるのは web 検索で、画面には「ファンダが静かにテクニカルになった」として出る）。
- **経路は best-effort、かつ分析の邪魔をしない。** 鍵の計算・候補の取得・建玉の確認・ログ、どれが失敗しても通常の分析へ落ちる。断りのログは**待たない**（配列に積んで、行を書いた後の予備時間で回収する）。断りは既定の結果なので、ここで 1 往復待つのはほぼ毎回の負担になる。SELECT には全部 `AbortSignal.timeout`（残り予算内、最大 5 秒）を付ける——止めないと Supabase の 150 秒で worker ごと殺され、返金されない 546 になる。
  `forceFresh` は**最初の分岐**で決める。読者が「引き直せ」と言って待っている経路で、3 往復かけてから結論に着くのは、その人の予算を使って既に分かっていることを確かめる行為である。
- **再利用した回はクォータを返す——戻ったときだけそう言う。** モデルを呼んでいないので消費しない。`releaseQuota()` を応答の前に走らせて、画面の `remaining` が実際に残っている数になるようにする。
  返金は best-effort で、しかも二重返金を防ぐためガードを**先に**下ろすので、失敗すると恒久的である（回数は減ったまま、再試行は無い）。だから `credit_refunded` を記録して運ぶ: `true` のときだけ「消費していません」と書き、`false` のときは「戻せませんでした。残り回数は1減っています」と書く。`null`（管理者で最初から消費していない）はどちらも書かない。減った数字の隣で「消費していません」と言うのは、画面自身が見破れる嘘である。
- **古い答えを新しい顔で出さない。** 応答に `reused`（元の行の id・分析時刻・配った時刻・返金できたか）を載せ、`ReuseBanner` が上部に「同じ入力の回が既にあったので、その分析結果をそのまま出しています」＋**いつ分析したか（日本時間）**＋実測の理由（48 回中 10 回割れる）＋「時刻の情報だけは当時のものです」＋**「新しく分析する」ボタン**を出す。
  **「前回」と書かない。** 引くのは「自分の・同じ鍵の・最新の行」であって、直前の分析とは限らない（間に別のペアを回していれば、それが「前回」である）。「前回と同じ入力でした」は、読者が確かめられない隣接関係を主張している。
  **`inputs_key` はクライアントに送らない。** ハッシュはアナリストのシステムプロンプト全体を覆っていて、この repo はそれをサーバー側に留めると決めてある（`20260905161000_replay_inputs_are_server_side.sql` が `analyses.prompt` を落とした理由）。ダイジェストは平文ではないが、**どの画面も読んでいない**ので、線の外に置く得が無い。
  バナーは Index.tsx の JSX ではなく**独立したコンポーネント**にしてある。ページ内に埋めると、pin できるのは testid の grep だけで、ブロックが到達不能になっても grep は緑のままになる——それはまさに、古い SELL が無印で画面に出る形である。
  `analysis_id` は**元の行**を返す（読者がエントリー登録するのはそのプランだから）。`mode` も**元の行の値**（`result` には `mode` が入ったことが無いので、今回のリクエストから組み直すと、検索が落ちた行を「ニュース込み」のバッジ付きで、その行自身の「ニュースを読めませんでした」という警告の隣に出す）。`technicalData` は今回読んだ数字。
- **鍵は行にも刻む。** 保存時の `analyses.inputs_key` は **送った形**（`sentInputsKey`）から作る。`giveUpSearch()` は user メッセージも tools も丸ごと書き換えるので、フォールバックした回では「送ろうとした鍵」と「送った鍵」が違う。行に刻むのは後者である。NULL はこの列より前の行。ハッシュなので中身は復元できない。

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
5. **スキーマを足すマイグレーション**（関数が書く列・読む表・呼ぶ RPC）は**関数より先に**流す。関数が無い列に INSERT すると `history_not_saved` の 503 と返金になる。1 本で「足す」と「直す」の両方をやるマイグレーションは 2 本に分ける。PostgREST から列が見えることを確認してから関数を出す（`GET /rest/v1/analyses?select=<列>&limit=0` が 200）。

### 6.1.1 バンドルは行で折る（--line-limit=200）

- デプロイは Supabase の `deploy_edge_function` にファイル内容を **インラインで**渡す。つまり誰か（人でもエージェントでも）が中身を転記する。
- ミニファイの既定は 1 行に詰める形なので、analyze のバンドルは **64 行・最長 15,717 文字**になっていた。この形は読むことも正確に写すこともできず、2026-09-06 のデプロイでエージェントが「この大きさでは転記できない」と実際に拒否した。手写しの事故は #48 と #51 で 2 回起きている。
- `--line-limit=200` を付けると **402 行・最長 447 文字**になる（サイズ増は 0.5%）。折れないのは長い文字列リテラル（日本語のプロンプト）だけ。
- 4 つのバンドルすべてに付ける。`bundle:analyze` / `bundle:track-outcomes` / `bundle:postmortem` / `bundle:noise-floor`。
- **サイズは監視項目**。analyze は 78.8KB、postmortem は 82.0KB（2026-09-06）、noise-floor は 51.5KB・263 行・最長 372 文字（2026-09-09 実測、安全装置の修理後）。これ以上育つなら、インライン以外の経路（CLI にはアクセストークンが要る）を用意する必要がある。
- **2026-09-13、その限界に当たった。** analyze のバンドルが **116.2KB・621 行**（v53 は 110.3KB で通っていた）になり、デプロイのエージェントが「この量は 1 回の呼び出しで出し切れない」と実際に止まった。
  内訳（esbuild の metafile 実測）: index.ts 47.0KB / review.ts 22.8KB / locale.ts 10.7KB / structure.ts 7.5KB / indicators.ts 5.8KB / rules.ts 4.6KB / entry.ts 3.8KB / 他 14.0KB。**reuse.ts は 2.1KB しかない**——増えたのは #89 の保有中評価と、その周りの本体である。
  ソースを直接デプロイする案は却下: コメント込みで 430KB あり、バンドルより 3.7 倍悪い。ミニファイ済みバンドルが最小形である。
  **次に触る人へ**: 削れる余地はもう無いので、増やすなら先に経路を用意すること。選択肢は (a) Supabase のアクセストークンを用意して CLI か Management API で送る、(b) 機能を別のエッジ関数に割る（ただし analyze の壁時計予算に HTTP のホップを足すことになるので、§8.5 の余裕と相談）。
  なお `--line-limit=200` は **行末バックスラッシュで文字列を継続する行を 119 本**作る。転記の事故はここで起きるので、手写しするなら最優先で確認する箇所である。
- **2026-09-13、3 回試して 3 回とも通らなかった。実測を残す。**
  - サブエージェント 2 体が「1 回の呼び出しで出し切れない」と停止（うち 1 体は全文を読んだうえで拒否）。
  - メインの担当（私）も直接試したが、**116,242 バイトがツール呼び出しに乗らなかった**。実際に届いたのは 84 バイトの `deno.json` だけで、バンドル本体は丸ごと欠落していた。
  - **転記の精度ではなく容量の問題である。** 先に 90 行 / 16,631 バイトを書き出して原本と `cmp` したところ **バイト単位で完全一致**した。つまり「正確に写せない」のではなく「1 通のメッセージに載り切らない」。
  - **安全に失敗した。** Supabase 側は entrypoint の実在を**切り替え前に**検査するので、`bundle.js` を欠いた呼び出しは `Entrypoint path does not exist` で弾かれ、本番は v53 のまま無傷だった（本番へ POST して版を確認済み）。不完全なデプロイが本番を壊す経路にはなっていない。
  - 結論: **この経路はもう使えない。** 次に analyze を出すときは、先に経路を用意すること。→ §6.1.2 で分割した。

### 6.1.2 保有中評価を別関数に切り出した（2026-09-13、analyze v55）

- **やったこと**: `analyze/review.ts` を使う側を、analyze の中から新しいエッジ関数 `position-review` に移した。analyze はそこへ HTTP で投げるだけになった。
- **効いた理由はツリーシェイキング**。analyze が `review.ts` から import するのを `emptyReviewRun` と `finalizeReview` だけに絞ると、22.8KB のプロンプト本文は esbuild が落とす。ファイルを切り刻む必要はなかった。
  実測: analyze **116,242 → 93,816 バイト**（621 → 467 行）。`position-review` は 27,030 バイト・171 行。どちらもインライン経路の実績値（110,299 バイトは通った）の下に戻った。
- **判断は何も変えていない**。参照の引き方・不在の言い分け・機械的事実を先に計算すること・verdict の導出（`finalizeReview` は analyze 側に残す。**この回の signal を知らないと決められない**から）——全部そのまま。
- **取り消しの保証は作り直した**。分割前は、待つのをやめた analyze が `reviewAbort.abort()` で飛行中の Anthropic 呼び出しごと止めていた。HTTP 越しにはそれが効かないので、`position-review` 側で **`req.signal`（呼び出し元が切ったら発火）と予算タイムアウトを `AbortSignal.any` で束ねる**。これが無いと、見捨てられた評価が締切まで歩いて**誰も読まない課金済みの呼び出し**を投げ、しかも行が記録した送信内容とも食い違う。
- **足は送る、取り直さない**。`position-review` は市場データを自分では取らない。取り直すとプランが読まれた系列とは別の系列になり、接触の事実が「誰も見ていない系列」の話になる。
- **認証は service role のみ**。本文が「誰の建玉を読むか」を指定するので、ゲートウェイの JWT ではなく本文で service role を突き合わせる（`config.toml` は `verify_jwt = false`）。
- **analyze は失敗に耐える**。404 / 500 / 時間切れ / `run` の無い応答は、全部**名前の付いた評価失敗**（`review_http_*` / `review_bad_response` / `no_service_role`）になる。分析そのものは完走して保存される。
- **出す順番**: `position-review` → `analyze` → フロント。逆にすると analyze が居ない関数を呼ぶ。
- **モデル出力のパーサは共有する**（`_shared/model-output.ts`）。2 つに分かれた瞬間から、コピーは必ずずれる。ずれると評価側だけが「解析できない」を出し、画面は**存在する verdict について**「判定できない」と言う。
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
| | 切替前 | 切替後 | **現在** |
|---|---|---|---|
| model | Opus 5 | Sonnet 5 | **Opus 5** |
| EFFORT_TECHNICAL | `medium` | `max` | **`medium`** |
| EFFORT_SEARCH | `low` | `max` | **`low`** |
| max_tokens | 8000 | 16000 | **8000** |

effort の範囲は `low` < `medium` < `high` < `xhigh` < `max`。

> **この切替は当日中に全部戻した。** 経緯は下の「8.5-a」。
> 現在の4値は切替前と完全に一致している。

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

## 8.5-a `max` を差し戻した — 見積もりが外れた記録（2026-09-12）

analyze v50 を 09:00Z 前後に出し、**10:45Z に v51 で差し戻した**。
本番で分析が2回続けて 504 で落ちたためである。

### 何が起きたか（本番ログそのまま）

```
10:40:45Z  フルモード
           85,002ms で web search を諦め（search_too_slow）
           技術のみで再試行 → 135,001ms `Analysis exceeded the wall-clock budget`
10:43:09Z  技術パスのみ（利用者がニューストグルを既に OFF にしていた）
           市場データ取得 1,340ms
           → 135,002ms `Analysis exceeded the wall-clock budget`
```

**2回目が finding である。** 検索なし・ページ取得なし・市場データは1.3秒で手元。
それでも**モデル呼び出しだけで残り約133秒を使い切った**。

### 外した見積もり

v50 のコメントにはこう書いてあった——実行 48fc15da の250セル
（実プロンプト・**前のモデル**・技術パス `medium`）でモデル呼び出しは
平均31.7秒・p99 42.6秒・最大49.5秒、予算135秒。よって技術パスは
使っていた時間の約3倍を持っている、と。

**その余裕はそのモデルのその深さについては本物で、移らなかった。**
effort はターン長の支配的な要因で、`medium` → `max` は3段ある。

同じコメントは失敗モードを「ファンダ分析が静かに技術分析になる（`drop_search`）」と
予告し、「`EFFORT_SEARCH` だけを単独で戻せばよい」と書いていた。
**どちらも間違い**だった。落ちたのは技術パスで、落ち方は優雅な劣化ではなく 504 である。

### 差し戻した範囲

**2段階で全部戻した。**

1. **11:30Z（v51）** — effort 2値だけ。壊れたのは effort 1点だったので、そこだけ。
   model（Sonnet 5）と max_tokens（16000）は維持した。
2. **12:00Z（v52）** — オーナーの判断で **model を Opus 5 に戻し**、
   **max_tokens も 8000 に戻した**。

`max_tokens` を一緒に戻したのは、16000 にした理由が2つとも消えたからである
（`max` effort と、別モデルの太いトークナイザ）。
それ自体は無害な背板でしかないが——実測は平均1,683・最大2,813で、
8000 にも近づいていない——**測定にとっては無害ではなかった**。
model と effort を戻したあと、この上限が
**#64 の床（20.83%）と #65 の `material` 判定を測った形との最後の差**だった。
戻したことで、**それらの数字は本番で実際に走っているアナリストを再び記述している**し、
これ以降の行は既存90行と同じ母集団に入る。

`noise-floor/shape.ts` の固定ミラーも同時に戻した。結果として
**`PRE_SWITCH_*` 3値すべてが現行値と等しく**なっているが、これはバグでも
冗長でもない——**新しい形で書かれた行は1行も存在しない**
（試みた2ターンはどちらも壁時計で死んだ）ので、フォールバックと現行値は一致し、
再生はどちらを使っても今日は正しい。

構造は残す。これはこの1回の差し戻しについての仕組みではないからである。
`analysis_prompts.effort` / `.max_tokens`（migration `20260912090000`）が
「その行がどの形で送られたか」の本当の答えで、定数はその列より前の行の
フォールバックにすぎない。**約100分だけ差が生まれ、次に何かが動けばまた生まれる。**
テストは「差がある」ではなく「**今は一致している**」を主張する形に変えた。
黙った一致ではなく、記録された一致にするためである。

### 課金

`public.profiles` はこのアカウントについて 2026-04-16 から `updated_at` が動いていない
（ADMIN_EMAILS で quota 経路を通らない）。**消費も返金も発生していない。**

### 次に上げるとき

`high` / `xhigh` は `medium` と `max` の間だが、**このモデルでは一度も計測していない**。
ライブで試せば同じことが起きる。

**上げ直すのは編集ではなく測定である。** 保存済みプロンプトを version-compare で
候補の深さに通し、セルあたりの所要時間を読んでから実ユーザーに出すこと。
84行×1アームで約$7。

---

## 8.6 契約フィルタの語句リストを直した（2026-09-12）

`ENTRY_LEVER_PHRASES`（`postmortem/stamp.ts`）から **`"market entry"` を外し**、
代わりに **`"limit plan"` / `"limit-based"` / `指値プラン` / `指値中心` を足した**。

### なぜ外したか — 名詞を拾っていた

このリストの規則は「**その本文が、この契約に無いレバーを名指しているか**」である。
market_v1 でアナリストが決められるのは **方向・損切り幅・利確幅・そもそも入るかどうか** の4つ。

`"market entry"` はそのどれも名指していない。**トレードそのものを指す名詞**である。

- 「skip the trend-direction **market entry** (WAIT)」→ 第4レバー（入るかどうか）
- 「take the trend-direction **market entry** with a 0.6-0.8x ATR stop」→ 第4＋第1＋第2レバー
- 「When following a strong trend with a **market entry**, keep the stop around 0.7 ATR」→ 第2レバー

この規則はリポジトリが既に書いていた。`src/test/postmortem.test.ts` の
「naming the entry price is required, choosing it is what does not exist」がそれで、
**「名詞に当たる veto は、編集者が書ける最も実行可能なルールを止めてしまう。だから動詞に当てる」**
と明記してある。`"market entry"` はその規則の例外になっていた。

### 実測（全ルールブックの全世代 + 凍結2冊）

判定が変わるのは**ちょうど5本、それ以外は1本も動かない**。

| | id | cause | 本文 |
|---|---|---|---|
| **veto 解除** | r10 | direction_wrong | 「…skip the trend-direction market entry (WAIT)」 |
| **veto 解除** | r13 | wait_missed_trade | 「…take the trend-direction market entry with a 0.6-0.8x ATR stop」 |
| **veto 解除** | r8 | stop_too_tight | 「…keep the stop around 0.7 ATR」 |
| **新たに veto** | r5 | plan_incoherent | 「for limit plans, always assess…」（2つの文言） |

解除される3本はいずれも**生きた原因**を持ち、**指値に一切触れていない**。
新たに veto される2本は**穴を塞いだ**もので、`"limit plans"` は
`"limit entry"` にも `"limit order"` にも一致しなかったため、
**指値注文の存在しない契約で、指値プランの話がアナリストに届いていた**。

### この veto は意味ではなく文言で決まっていた

調べている最中に候補ルールブックが書き換わり、それが証拠になった。

| | 本文 | スタンプ |
|---|---|---|
| 凍結（#65 が使った版）の r13 | 「…take the trend-direction **market entry** with a 0.6-0.8x ATR stop」 | **null**（誰にも見せられていない） |
| 2026-09-12 の候補の r13 | 「…take the trend with a 0.6-0.8 ATR stop」 | **market_v1** |

**同じ指示、同じ日本語、違うスタンプ。** 編集者がどの同義語を選んだかで判定が変わる。
それが決めていたのは「このループが唯一生んだ“もっと取れ”と言うルールが
アナリストに届くかどうか」だった。

### 今日の本への影響はゼロ

上の書き換えの結果、この修正を入れた時点で live・candidate のどのルールも
veto されていない。**これは予防的な修正であって、今の本を変えるものではない。**
一番安全な時期に入れたことになる。

`stampFor` は ja を先に、次に en を見て、どちらかが当たれば**両方のロケールから消す**。
#65 の凍結84行は全部 ja だったので、日本語として問題のないルールが
英文の言い回しのせいで消えていた。その非対称はこの修正でも残っている
（リストの設計がそうなっている）ので、次に効くときは同じことが起きうる。

デプロイ: postmortem v25（fn v35、95,526 bytes、バイト一致確認済み）。

---

## 8.7 候補版（variant）を入れた — #87 下位足 / #86 条件付き WAIT（2026-09-13、analyze v56）

### なぜ「候補版」という仕組みが要ったか

これまで変更を試す方法は 1 つしか無かった: モジュールの定数を書き換えて 100% の
トラフィックにデプロイする。その代償が §8.5 と §8.5-a である（1 日のうちに本番
504 が 2 回と 2 段階のロールバック）。ルールブックの `candidate` は答えにならない。
あれはオフライン再生用のオブジェクトで、analyze は一度も読んでいない。

候補版に必要なものは 3 つで、`supabase/functions/_shared/variants.ts` がその 1 つ目:

1. リクエストが指名できる名前
2. **行が永久に持つ**名前（2 つの母集団が事故で混ざらないため）
3. **再利用キーに入る**名前（#90）。ここを外すと候補版は対照版の保存済みの答えを
   返されて、「差が無い」と報告される — 走っていないのだから当然で、これが一番
   静かな失敗の形

`plan_contract` を流用しなかった理由もそこに書いた。あれは「建玉がどう約定するか」
の意味で、どちらの候補も約定の仕方は変えない。

### 誰が候補版を指名できるか — 管理者だけ、明示的に、自動割り当ては無し

権限の話ではなく証拠の話である。自分で腕を選ぶトラフィックは自己選択標本で、
2 つの母集団は変更そのものより「押した人」の差で違ってしまう。かといって実
トラフィックを無作為に割り当てるのは教科書的な正解だが、ここではもっと悪い:
#87 は**実際の金が動くプランを書く前に AI が読むもの**を変える変更で、決着済みの
記録は 48 件しかない。知らないうちに未検証の腕に乗せてよい数字ではない。

だから opt-in・管理者限定で、代償も隠さず書く: **これは無作為化試験ではなく、
意図的に小さい標本である。** 管理者以外が `variant` を送った場合は拒否せず
**control に落として行にそう記録する** — 走った腕を行が嘘なく持つ方が大事。

UI のトグルは作っていない。取引アプリの画面に実験スイッチを置く理由が無いので、
腕を使うときはリクエスト本文に `variant` を入れて analyze を直接呼ぶ。

### #87 下位足（`variant = "lower_tf"`）

エントリー足の 1 つ下の足（`LOWER_TIMEFRAME`: 15min→5min, 1h→15min, 4h→1h）を
48 本、**GMO Coin の仲値**で取る。Twelve Data の 8 リクエスト/分の枠を使わない
のが選定理由。

**`1day` は入っていない。** 下位足は 4h になるが、`fetchRecentQuotes` は
GMO_INTERVALS の key が `"day"` でないものを拒む（4h も 1day も `"year"`）ので、
`1day → 4h` は通信すらせず必ず null を返す。表に入れておくと、`lower_tf` と
刻まれているのに中身は対照版そのもの＋「取得できなかった」の一段落、という行が
できる。**走っていない腕にラベルが付く**のは variant 列が防ぐべき当のものである。

**上位足ではないことを 3 重に守っている。** プロンプトでは「仕掛け確認用・下位足」
という別ラベルに置き、方向と確信度を変える根拠にするなと明示し、
`timeframe_alignment` に入れるなと書いた。そのうえで
`normalizeAnalysis(..., excludeTimeframe)` が**サーバ側でその段を配列から落とす**。
指示は強制ではない — `timeframe_alignment` は画面が 1 段 1 矢印で描く自由配列なので、
指示だけでは下位足の方向チップがチャートに出うる。読みは `context.lower` に残る。

比較は**文字列一致ではなく分に正規化して**行う（`sameTimeframe`）。`item.timeframe`
はモデルが書く自由文字列なので、`"15min"` だけを見ていると `15分` `15m` `M15`
`15 min` `15min足`、そして `1h` に対する `60min` が素通りする。**1 つの綴りだけの
強制は、上の一文が否定しているのと同じ強さ**でしかない。取りこぼしより取り過ぎを
選んである: 誤検出はチップが 1 つ消えるだけ、見逃しは「タイミング専用」と言った段に
方向の矢印が出る。

### #86 条件付き WAIT（`variant = "conditional_wait"`）

WAIT の回にだけ、任意で「今は入らないが、この水準にこちら側から触れたら、こちらに
入る」と書ける。

**注文にはならない。** #37 の実測（当時の途中経過）: AI に約定価格を選ばせて
いた時期、売買 8 件のうち 5 件が未約定で、その 5 件すべてに AI 自身の
Trend Day / Breakout タグがシグナルと同じ向きに付いていた。この一文は
「その時期の全件」ではなく測った時点の途中経過であることを明示しておく —
その契約が終わった時点（2026-09-13 実測）で通算すると 18 件中 7 件が未約定
（約 39%）で、比率も件数もこの一文とは一致しない。`should_be_market` はその形を拒むために書かれた
規則で、条件付き WAIT を指値にすればそこへ戻る。画面に出るのは今までどおり水準
なしの WAIT で、入るのは横に置いて後で採点される予測である（レスポンスにも
含めていない）。

**`not_triggered` は合格ではない。** 既存の WAIT 採点は「窓が終わって何も取らなかった」
を `correct` と返すので、そのまま乗せると**届かない水準を名指しするのが一番安く
正しく見える手**になる。独立した判定語にしてある。

サーバの検査（`_shared/conditional-wait.ts`）: 現在値の反対側（`wrong_side`）、
ATR で `MIN_STOP_ATR` 未満（`too_close`）/ 3.0 超（`too_far`）、ATR が無い
（`no_atr`）、欠損（`malformed`）、WAIT でない回（`not_a_wait`）を名前付きで捨て、
理由を `entry_check.conditional_rejection` に残す。**黙って捨てない**: 出力の 8 割が
捨てられる腕は走っていない腕で、行がそう言えなければならない。

下限は `MIN_STOP_ATR` を**import している**（写した 0.4 ではない）。ゲートは
それより近い損切りを「ノイズの内側」として拒むので、それより近い発動水準は
このアプリ自身が信じていない水準を水準として採点することになる。同じ相場に
ついての同じ主張が 2 つの定数で食い違う理由が無い。

有効期限には**下限もある**（`MIN_EXPIRES_BARS = 3`）。窓が 1 本だと発動後に
方向を判定する余地が無く、届くか届かないかしか起こらない。**外れようが無い
主張は予測ではない**のに、外れうる主張と同じ列に並ぶことになる。
詰めたときは `expires_clamped: true` を残す（保存された窓が、書かれた窓とは
限らないため）。

### 採点の窓は「本数」ではなく「時間」である — ここが一番危なかった

`expires_bars` は**エントリー足**の本数で書かれる（AI が見ていた足がそれだから）。
採点する系列はそれより細かい: `EVAL_INTERVAL` は 1h→15min、4h/1day→1h を当てる。
渡された配列を `expires_bars` で切ると、窓は 15min 以外のすべての足で **4〜24 倍
短くなる**。出てくるのは単位の副作用でしかない `not_triggered` の山で、しかも
それは「発見」の顔をして出てくる。

なので窓は時間で計る。`conditionalWindowMs(plan, entryBarMs)` が本数を ms に直し、
**期限そのものは呼び出し側が `marketHorizonEnd` で市場時間として計算して渡す**
（`scoreConditionalWait` は `deadlineMs` を受け取る）。市場カレンダーの写しを 2 つ持つと
必ずずれるので、歩く部分は既にある `waits.ts` に残してある。
`src/test/conditional-wait.test.ts` に回帰テストを 2 本置いた: 1h・4本の見立てを 15min 足で
採点して 4 時間先まで見ること、そして金曜の見立てが閉場に窓を食われないこと。

採点は**窓が閉じてから 1 回だけ**。判定は終端で、部分索引は
`conditional_outcome is null` の行しか引かないので、早すぎる `not_triggered` を
後から直しに来るものが無い。窓が開いている行は次の sweep に残す。

### スキーマは腕ごとに変えた — 対照版は v48 era のまま（実測）

腕が同じスキーマを送るなら候補版は対照版のラベル張り替えでしかない。なので
送信スキーマは変えるが、`RESPONSE_SCHEMA` 定数そのものは編集していない
（noise-floor/shape.ts がバイト一致の写しを持ち、prompt-surgery の `SCHEMA_ERAS`
は**そこから作った指示文のバイト列**で 45 行を再生可能にしている）。
`conditional_wait` を最後のプロパティに置き、対照版では**剥がす**。

2026-09-13 実測（作業ツリーから両方を組み立て直して比較）:

| 腕 | chars | bytes | sha256 | era |
|---|---|---|---|---|
| control（剥がした方） | 2811 | 3449 | `9d28925f…` | **v48 とバイト一致** |
| conditional_wait | 3737 | 5137 | `32d35b87…` | 新 era `v56cond` |

差分は 926 文字 / 1,688 バイト。**この表は一度間違っていた**: 最初は 3700 / 5030 /
`3da8257b…` と書いたが、同じ作業の中で `expires_bars` の説明文を直したので digest が
動いていた。数字を測ったあとにその数字の元を変えたら、測り直すまでその表は嘘である。

対照版は保存済みコーパスが鍵にしている era に居続ける。候補版だけが新しい era を
開き、それは `SCHEMA_ERAS` に登録した — "unknown" に落とすと「別の問いをされた行」と
「まだ誰も書き留めていない世代の行」が同じラベルになり、再生で混ぜてしまう。
digest は `src/test/variants.test.ts` が固定している。

### この数字が答えられないこと（先に書いておく）

レビューで測り直した結果、**`triggered_right` は「腕の先読み」ではなく「窓の間の
流れ」を測っている割合が大きい**。この採点規則そのものを 4 万パス／セルでシミュ
レートすると（σ は 1h の真の値幅が約 1 ATR になるよう設定、発動水準 1.0 ATR、
`expires_bars` 6）:

| 窓の中の drift（ATR/足） | 流れに沿った主張 | 流れに逆らう主張 |
|---|---|---|
| 0.00 | 51.6% | 48.0% |
| 0.10 | 63.7% | 36.3% |
| 0.20 | 73.9% | 25.6% |

つまり**帰無仮説は 50% ではない**。ありふれた弱いトレンドだけで 64% が出る。
だから `conditional_wait.trend_at_call`（ゲート自身の regime 読みに対して
「沿っている／逆らっている／不明」）を全ての主張に刻んである。**この列で分けずに
比率を読んではいけない。**

さらに:

- **トレードの成績と並べてはいけない。** 損切りも利確も最大逆行も無いので、
  `performance_stats` が返す期待値（R/件）と同じ軸には乗らない
  （この行は最初 具体的な R/件 の値を書いていたが、20260913140000 のコメントが
  指摘したとおり、それは `performance_stats` が単体で返さない分母の値だった。
  軸が違うと言うために、その関数が出さない数字を挙げる必要は無い）。
  最長の期限では「当たり」判定の過半が、このアプリ自身の最小損切り幅で
  先に切られていた主張である。
- **必要な n は遠い。** 50% を帰無として 60% を検出するのに**決着した主張が
  約 194 件**（`not_triggered` / `triggered_unresolved` / `unmeasurable` は
  分母の外）。上の drift を織り込んだ帰無に対してはもっと要る。腕は管理者の
  opt-in なので、当面出るのは 1 桁〜十数件で、その比率はラベル付きのノイズである。
- **`not_triggered` が罰として成立するのは `variant_stats()` の中だけ。** 分母
  つきで出るのがそこしかないため（§9-I）。

### 抜け道は「別の列に書いた」だけでは塞がらなかった

`not_triggered` を書いても、**同じ行は既存の WAIT 採点で `correct` のままだった。**
`wait_judged` は `verdict in ('missed','correct')` を数え `wait_missed` は
`'missed'` だけを数えるので correct は表示上の精度を上げ、postmortem は
`correct` を「見送りは妥当だった」として教訓にし、その教訓は共有ルールブックに
入って**対照版のプロンプトに出る**。つまり届かない水準を名指しするのは、依然として
一番安く正しく見える手だった。

塞ぎ方（20260913140000）:

1. `performance_stats` は `variant = 'control'` の行だけを数える。見出しの成績は
   対照版だけの記録になる（本番実測: 今日の対象 104 行 → 104 行、除外 0 件。
   つまり今日の値は変わらない。変わるのは「これから黙って混ざるかどうか」）。
2. `postmortem` は候補版の行を**診断対象から外す**（id 指定の回も例外にしない）。
   これが唯一あと戻りできない方向だったため — 候補版の行から引いた教訓は共有
   ルールブックに入り、以後の対照版の全実行がそれを読む。`lower_tf` の行なら
   `context.lower`（対照版が一度も見ていない下位足の読み）が教訓を書くモデルに
   渡っていた。
3. `variant_stats()` を追加。腕ごとに数え、`conditional_not_triggered` を分母つき
   で出す。`performance_stats` とは別関数にしてある（同じ関数に足すと呼ぶ側が
   うっかり合計する）。

### デプロイ

§8.7-a に記録した理由で、この節の最初の版が書いたデプロイ記録（analyze v56 =
98,831 bytes、track-outcomes v15 = 30,238 bytes、マイグレーション 2 本）は**その後の
修正で全部古くなった**。現在の記録は §8.7-b にある（§8.7-a も同じ理由で自分の記録を
古いとし、§8.7-b を指している — 二段階になっているのはそのため。ここで直接指す）。

---

## 8.7-a 同じ版名で 2 つのビルドを本番に出した（2026-09-13、#86/#87 の修正時）

§6.2 の手順は「関数を変えたら版名を上げる」である。**破った。**

#86/#87 を v56 / v15 として出したあと、マージ前監査の指摘を直して analyze と
track-outcomes を**中身を変えたまま同じ版名で再デプロイ**した。2 つのビルドが
`analyze-v56-2026-09-13T13:20:00Z` を名乗り、両方が行に同じ
`context.provenance.function_version` を書く。版名は「再デプロイをまたいで母集団を
割る鍵」なので、その鍵が壊れると 2 つの別の分析器が 1 つの記録に混ざり、後から
分ける手段が無い — #86/#87 が防ぐために作られたのと同じ形の失敗を、その修正の最中に
やった。

2 つのビルドは同じ挙動ではない: MIN_TRIGGER_ATR（0.25 と MIN_STOP_ATR）、
`expires_bars` の下限（無しと 3）、採点の窓（壁時計と市場時間）、タイムスタンプの
解釈、`timeframe_alignment` の除去方法がそれぞれ違う。

**被害の範囲は測って確定した: 0 行。** 最初のビルドが生きていた約 27 分の間に
`analyses` に書かれた行は 1 件も無い（本番実測: 13:15Z 以降に作られた行が 0、
最新行は 07:14Z）。候補版の行も条件付き主張も 0 件なので、どちらのビルドが書いたか
分からない行は存在しない。

**直した内容**: 変更した 5 関数すべての版名を上げ直した
（analyze v57 / track-outcomes v16 / postmortem v27 / noise-floor v5 /
version-compare v8）。

**この穴をテストが捕まえられなかった理由も書いておく。** 版に関するテストは
`src/test/weekend-preview.test.ts` の 1 本だけで、これはクライアントのピンと関数の
定数が一致することしか見ない。**両方とも上げなければ通る。** つまり「変えたのに
上げていない」という当のケースでは必ず緑になる。`TRACKER_VERSION` と
`POSTMORTEM_VERSION` に至っては 1545 本のどこからも参照されていない。
版名の一致はテストできるが、版名が**上がっているべきか**はコードからは分からない
（差分と履歴の話なので）。ここは手順で守るしかない箇所だと、はっきり書いておく。

デプロイ記録は §8.7-b にある（この節に書いていた版は、後続の修正で全部古くなった）。

---

## 8.7-b デプロイ記録と、マイグレーション台帳のずれ（2026-09-13〜14）

### 本番に出ているもの（全部 1 回目でバイト一致、sha256 照合済み）

| 関数 | 版 | bytes | fn ver |
|---|---|---|---|
| analyze | v57 | 99,836 | 76 |
| track-outcomes | v16 | 30,614 | 24 |
| postmortem | v27 | 95,583 | 37 |
| noise-floor | v5 | 55,036 | 13 |
| version-compare | v8 | 84,393 | 11 |

**この表は本番で確かめた分だけを「確認済み」と書く。** analyze は自分の版名を返す
401 で、track-outcomes は 23:48 の cron sweep が v16 として `errors: []` を記録した
ことで、postmortem は 401 応答で確認した。**noise-floor と version-compare は
デプロイの sha256 一致以外に本番側の目撃が無い** — 両方とも手動起動の関数で、
cron も無いので、次に誰かが回すまで「動いた」証拠は出ない。ここを「確認済み」と
書くと嘘になるので、書かない。

### マイグレーション台帳のファイル名がリポジトリと一致しない

リポジトリ側のファイル名（`20260913120000_…`）と、本番の台帳に記録された版
（`20260913130009` など、MCP が付ける時刻）は**一致しない**。つまり
`supabase migration list` のような標準の見え方では、この一連の移行は**全部「未適用」に
見える**（実際には適用済み）。中身の重複適用は各移行の冪等ガードが防ぐが、
**台帳の見た目は直っていない**。ここに書いておく以外にいまできることは無い。

### pg_get_functiondef を書き換える移行についての注意

このシリーズの移行は「適用時点の関数定義」を文字列置換する。だから
**ファイルと本番に流したテキストが 1 文字でも違うと、再生結果が本番と食い違う**。
実際に一度やった: 20260913140000 のファイルは置換文にコメント行を 1 行注入していて、
本番に流したほうは注入していなかった。しかも私はその検証を「アンカーが元ファイルに
在るか」の grep だけで済ませ、**置換後の文字列を比べていなかった**。

以後の手順: **SQL を 1 度だけ書き、そのテキストを本番適用とファイル記録の両方に使う。**
書き写さない。

---

## 8.8 狙う取引期間を宣言した（2026-09-14、#91 step 1）

### 直した問題

**アプリは「この取引が何時間先を狙うのか」を一度も決めていなかった。** 時間足は
「何を読むか」を決めるだけで、「どれだけ先を狙うか」は決めない。それでも期間は
4 つの場所に**暗黙に**存在していた:

| どこ | 何 | 1h での値 |
|---|---|---|
| `econ-calendar/events.ts` | `HORIZON_MS` | 12 時間 |
| `track-outcomes/evaluate.ts` | `ENTRY_WINDOW_MS` | 未約定を待つ上限 |
| `track-outcomes/evaluate.ts` | `EXPIRY_DAYS` | 追跡を諦める日数 |
| プロンプト | モデルの暗黙の想定 | 述べられていない |

一番はっきりした害は経済指標ブロックである。あれは「このプランの**想定寿命**が
発表をまたぐなら、見送るか、その値幅を吸収できる損切りにせよ」と指示しながら、
**想定寿命を一度も述べていなかった**（95 件中 38 件に出る）。つまりモデルは、
定義されていない量を根拠に損切りを広げるか見送るかを決めていた。

### やったこと（step 1 のみ。判定は 1 つも動かしていない）

`_shared/horizon.ts` に 1 つの表を置き、4 つの暗黙値のうち `HORIZON_MS` を
**そこから導出**した。**値は 1 ミリ秒も変えていない** — `PLAN_HORIZON_BARS ×
ENTRY_BAR_MS` が 4 本の時間足すべてで既存の `HORIZON_MS` を再現することは
`src/test/horizon.test.ts` が固定している。

期間を**本数**で宣言したのは実測による。決着した行の保有時間を**エントリー足の
本数**で見ると、中央値は 15分/1時間/4時間/日足で 1.05 / 1.67 / 1.26 / 2.82 本 —
時間足にほとんど依らない。時間で宣言すると時間足ごとにばらばらの数になる量が、
本数だとほぼ 1 つの数になる。

宣言した期間は `analyses.plan_horizon` に、判定側の外枠は `analyses.scoring_windows`
に、**発行時点で凍結して**書く。既存の 117 行は**意図的に埋めていない**: 今日
計算した期間は、先週のプランが狙っていた期間ではない。

### 「本数は期限ではない」を、プロンプトと画面の両方に書いた

これが一番誤解されやすいので、実測を根拠に書いておく。**決着した 53 件を 24 本で
打ち切ると 2 件が落ち、その 2 件はどちらも勝ちである。** だから本数は狙いであって
締切ではなく、期間を過ぎたプランも決着するまで採点し続ける。この一文を落とすと、
モデルは本数に合わせて利確を手前に引く。

### 触っていないもの

**`track-outcomes` と `postmortem` は開けていない。** 判定は 1 つも変わらず、既存の
行は 1 行も更新していない。`horizon_check`（期間内に決着したか）を別の記録として
残すのは step 2 で、勝敗とは分けたままにする。

### 出したもの（バイト一致を sha256 で照合済み）

**どの関数を出すかは推測せず、HEAD の worktree で同じ esbuild を使って
バンドルし直し、sha256 を突き合わせて決めた。** 6 本中 4 本が変わった。

| 関数 | 版 | fn ver | bytes | sha256 (先頭) | 試行 | 変わった理由 |
|---|---|---|---|---|---|---|
| analyze | v57 → **v58** | 78 | 102,671 | `e14952c4afc49744` | 2 | 本体。宣言・保存・プロンプト |
| postmortem | v28 → **v29** | 41 | 96,082 | `f4e1ed1953622ec6` | 3 | `econ-calendar/events.ts` 経由で `_shared/horizon.ts` を取り込む（108 B）。**挙動は不変** |
| version-compare | v9 → **v10** | 13 | 85,050 | `12b602adefbfb93d` | 1 | 同上。**挙動は不変** |
| position-review | v1 → **v2** | 2 | 27,026 | `2e0949cc0a7db1df` | 2 | `analyze/locale.ts` を取り込むため。**サイズもトークン数も HEAD と同一**（27,026 / 3,654）で、差は minifier の識別子名だけ |

**本番側の目撃があるのは analyze と position-review だけ** — 両方とも 401 応答が
自分の版名（`analyze-v58-…` / `position-review-v2-…`）を返した。**postmortem と
version-compare の 401 は版名を載せない**ので、この 2 本については sha256 一致
以外の証拠が無い。§8.7-b と同じ理由でここを「確認済み」とは書かない。

**`track-outcomes` と `noise-floor` はバンドルがバイト単位で HEAD と同一だった
（`c3d77eaa3f1da3cc` / `e608381430d80333`）ので、版も上げていないし出してもいない。**
挙動が変わらないのに版名だけ進めると、版名が「何が動いているか」を指さなくなる。

挙動が変わらない 3 本を**それでも出した**のは §8.7-a の逆側の理由による。出さないと
リポジトリと本番のバイトがずれたままになり、次に誰かが照合したとき**偽の警報**が出る。
偽の警報に慣れると、本物の警報も無視される。

バンドルサイズの壁（110,299 B は通り、116,242 B は落ちた）に対して analyze は
102,671 B。まだ 7.6 KB ほど余裕がある。

### 照合が 4 回はじいた — うち 2 回は転記のずれで、毎回おなじ形

4 本のうち**バイト一致が 1 回目で出たのは version-compare だけ**である。照合が
はじいた回の内訳:

| 関数 | はじいた回 | 何が起きたか |
|---|---|---|
| analyze | 1 回目 | **転記のずれ** +1 B: `c==="Up"==(r==="BUY")` が `c==="Up"===(r==="BUY")` に |
| postmortem | 1 回目 | デプロイ自体が実行されず、照合は**まだ v28 のままの本番**を読んだ（版名不一致で弾かれる） |
| postmortem | 2 回目 | **転記のずれ** +2 B: `e==` が `e===`、`typeof t==` が `typeof t===` |
| position-review | 1 回目 | デプロイ自体が実行されず（同上） |

転記がずれた 2 回は**外れ方が同じ**である:

いずれも **esbuild が `===` を `==` に縮めた箇所が、書き出しで `===` に戻っている**。
元は `(regime === "Up") === (then === "BUY")` のような**真偽値どうしの比較**なので、
`==` と `===` は意味が同じ — **動作は変わらない**。だから「意味は同じなので良い」と
言いたくなるが、それは違う。ここで分かったのは次のことである:

**バンドルを丸ごと書き出す経路は、1〜2 文字を確率的に取り違える。** 今回は
たまたま意味の変わらない場所だっただけで、次も意味の変わらない場所とは限らない。
#48 / #51 と同じ失敗が、同じ経路で繰り返し起きている。

**この照合が無ければ、版名だけは v58 / v29 なのに中身が違うものが本番に乗っていた。**
ずれた版もそうでない版も同じ版名を持っていたので、**版名では区別できない**。
§8.7-a が言う「同じ版名で 2 つのビルド」は、手で版名を上げ忘れたときだけでなく、
**転記が 1 文字ずれたときにも起きる**。sha256 の照合は省略できない。

デプロイが実行されなかった 2 回も、照合が無ければ「出した」と報告していた。
**「デプロイを呼んだ」は「出た」ではない。**

---

## 8.9 すでに持っている建玉を登録できるようにした（2026-09-14、#92）

### きっかけと、拒否が正しかったこと

利用者が、5 日前から持っている USD/JPY の売り（約定 153.274）を、その日書かれた
日足プラン（エントリー 154.856）に登録しようとして `opened_before_plan` で断られた。
「プラン作成より前だとダメなのか」という問いである。

**その拒否は正しい。** `register_position` は利用者から約定価格と約定時刻だけを
受け取り、**損切りと利確はプランの行から写す**。だからプランより前の約定を通すと、
行が 3 か所で嘘をつく:

1. 置いていない損切り（156.150）が、その人の損切りとして記録される
2. 保有中レビューの `move_R` は `|約定価格 − 損切り|` で割るので、**取っていない
   288 pips のリスク**で含み損益が R 換算される
3. レビューは `opened_at` を起点に「建ててから損切りに触ったか」を測る。
   プランより前を起点にすると、**プランが書かれる前の値動き**をこのプランに
   ついての証拠として読む

**だからチェックは緩めなかった。** 足りないのは「プランに紐づかない建玉」という
概念のほうで、それを足した。

### 直す前に、壊れる場所を推測ではなく数えた

`positions.analysis_id` を nullable にすると何が壊れるかを、層ごとに掃き出して
1 件ずつ**反証側に有利な条件で**検証した。**候補 110 件 → 確認 16 件・棄却 29 件**
（残りは検証の途中でコンテナ再起動により失われたが、結論に必要な分は回収済み）。

自分では見ていなかった層が 2 つ出た:

| 場所 | 何が起きるはずだったか |
|---|---|
| `src/lib/positions.ts` | `typeof r.analysis_id !== "string"` で**行ごと捨てる**。`typeof null === "object"` なので静かに消え、「何も持っていない」と区別がつかない |
| `supabase/functions/position-review/index.ts` | 取りに行っていないのに `lookup_failed` を**でっち上げ**、画面が「プラン行を取得できず」＝**起きていない障害**を報告する |

いちばん効いた指摘は `held_reason` に**4 つ目の値**が要ることだった。既存の 3 つは
`held === null`（評価する対象が無い）に付くが、`no_plan_registered` は
**`held` が非 null のまま付く** — 建玉はあり、評価もできる。無いのはプランだけである。
既存の 3 つに畳むと、そのどれもが嘘になる。

### 入れたもの

- `positions.analysis_id` を nullable に。**`analysis_id IS NULL` がその印そのもの**で、
  `origin` のような列は足していない。FK は `on delete cascade` なので「プランが消えて
  null になった行」は存在せず（行ごと消える）、**null の意味は 1 つしか無い**
- `register_held_position`（別 RPC）。**損切り・利確は利用者自身のものを受け取る**。
  水準の向き・利確の順番・ペア書式・時間足を検査する
- **約定時刻の下限は置かない。** プラン経由と違って比べる相手が無く、「何日前までなら
  本当か」を決める根拠がこちらに無い。古すぎる約定はレビューが
  `covers_anchor = false` として正直に報告する。未来だけを断る
- 重複は `(user_id, pair, direction, entry_price, opened_at) where status='open' and
  analysis_id is null` の部分一意索引で止める。既存の
  `positions_one_open_per_analysis` は **NULL どうしを別物として扱うので独立建玉を
  1 つも止めない** — 同じペアに複数建てるのは普通なので、それは意図どおりである
- 画面: 保有中の枠に「持っている建玉を登録」を置き、**建玉が 0 件でも枠を出す**
  （出さないと、分析を 1 度も回していない人に登録する場所が無い）

### 成績には入らない

**本番で実測**: `performance_stats` / `variant_stats` / `loop_health` の定義本文に
`positions` は 1 度も出てこない。アプリが出したコールでない建玉が勝率に混ざる経路は、
**気をつけているからではなく構造として**存在しない。フォームにもそう書いてある。

### 本番で確かめたこと

マイグレーションは**ファイルに 1 度書き、そのテキストを適用に使った**（§8.7-b）。
適用後に `prosrc` の md5 を突き合わせ、**`f08f9433…`（4,408 文字／112 行）で一致**。
転記ずれ無し。

RPC は本番で 7 通り叩いて、**全部トランザクションごと巻き戻した**（実測: 行は 0 件のまま）:

| 入力 | 返り |
|---|---|
| SELL なのに TP1 > 約定 | `levels_incoherent` |
| 未来の約定時刻 | `opened_in_future` |
| `30min` | `interval_invalid` |
| TP2 を飛ばして TP3 | `targets_out_of_order` |
| `usd/jpy` | `pair_invalid` |
| 正しい入力 | `analysis_id=NULL` / `src=user` / `entry=153.274` |
| 二度押し | `already_open=true`・同じ id |

### 出したもの

バンドルを取り直して sha256 で比べたところ、**変わったのは `position-review` だけ**
（v2 → **v3**、27,078 B）。`analyze` は `analyze/review.ts` を**バンドルしているのに
バイト同一**で、これは推測ではなく測って確かめた: `readHeldReference` 固有の文字列
`other_open_positions` は analyze のバンドルに **0 回**、position-review に 5 回出る。
analyze は同関数を使わないので tree-shaking で落ちており、**中を直しても analyze の
バイトは変わらない**。だから analyze の版は上げていない。

---

## 8.10 公開前の検査が、自分で入れた 3 つを見つけた（2026-09-14、#91 / #92 の直後）

マージ直前にプリフライト検査を回した。バンドル差分・ビルド・フロントとバックエンドの
契約・本番データに対する画面の挙動・差分の安全性の 5 層を並列で見て、
**公開を壊す指摘は 0 件**（ビルド成功、tsc は基準どおり、契約は全部一致、
機密・モデル識別子・探りファイルの混入なし）。

一方で、**#91 / #92 で自分が入れた表示の誤りが 3 つ**出た。3 つとも
「画面が事実でないことを言う」型で、このプロジェクトが #83 で直したのと同じ種類である。

### (1) WAIT の行が「狙う期間」を宣言していた

`analyze` は `plan_horizon` を**全行に**書く（`wait_plan` が WAIT 限定なのとは非対称）。
履歴パネルの期間ブロックを `tracked &&` の**外**に置いていたので、WAIT の行が
「狙う期間: 1時間足で12本」と表示する。取引を提案していない行である。

しかも同じパネルの下には見送りの検証が「検証期間 48時間」と出る。**1 つの判断の下に
12 時間と 48 時間が並び、どちらが効いているか書かれていない。** 本番の WAIT は
118 行中 57 行（48%）なので、ほぼ 1 行おきに出る。

さらに、既存 WAIT 行は `plan_horizon` が null なので、**公開した瞬間に 48 行全部が
「この分析には狙う期間が記録されていません」**と表示する — 元から持ちようのない
ものについての苦情である。

述語は `tracked` ではなく `signal !== "WAIT"` にした。`tracked` は
`outcome = 'skipped'` も除くので、期間を宣言した BUY/SELL が skipped になった行で
期間を隠してしまう。**本番実測では両者は同じ集合**（skipped は WAIT 48/48 のみ）
なので今日は何も変わらないが、意図をそのまま書いた述語のほうが後の行の形に耐える。

### (2) プランの無い建玉に「根拠は維持されており」と書いていた

`verdictGloss` は 1 組しか無く、`held.analysis_id` で分岐していなかった。結果、
独立建玉のカードが **3 行の間に自己矛盾**を書く:

- 「プラン自身の撤退条件に達しています」 ← 到達したのは**利用者が登録した**水準
- その 3 行下に「元になったプランはありません（あなたが登録した建玉です）」
- `hold` では「**根拠は維持されており**」— 維持される根拠が存在しない（thesis は null で、
  モデルにも「（記録なし）」として渡している）

同じコミットが `heldSubtitleOwn` / `ownTimeframe` / `trackerNoPlan` / `thesis.noPlan` を
足しておきながら、`verdictGloss` だけ**取りこぼしていた**。N 箇所のうち 1 箇所を
落とす、いつもの形である。`verdictGlossOwn` を足して分岐させた。

### (3) 経済指標カレンダーの警告が、ほぼ常に出る文言だった

`calendar_covers_horizon` を「カレンダーが期間の終わりまで届かなかった回にだけ出す」
警告として書いた。**自分で測ったら、そうではなかった**（4 週間・1 時間刻みの開始点）:

| 時間足 | covers=false |
|---|---|
| 15min | 208/672（31%） |
| 1h | 232/672（35%） |
| 4h | 376/672（56%） |
| **1day** | **664/672（99%）** |

仕組みを見れば当然だった。期間は**市場時間**で歩くので `ends_at` は
`priced_at + lookahead` より後にしかならない。つまりこのフラグが本当に言っているのは
「**この窓が市場の休みをまたいだ**」であり、5 日分の窓は必ず週末をまたぐ。

文としては**毎回本当**で、**ほぼ毎回役に立たない**。それは
`planHorizon.ts` に自分で書いた「毎回出る行は読まれなくなる」そのものである。
**表示をやめ、フラグは行に残した**（2 つの時計を後で比べるときの事実ではある）。

### (4) 再利用で返した答えだけ、期間が付いていなかった

`analyze` の成功応答は 2 か所しかなく、**再利用側に `plan_horizon` が無かった**
（SELECT も列を取っていなかった）。同じプランが、再利用だと期間なし・履歴だと期間あり
になる。`planHorizon.ts` の存在理由そのものが「新しい結果と履歴が 1 つのプランについて
食い違わないこと」なので、この経路がそれを破っていた。行に保存済みの値を返すよう直し、
**analyze v58 → v59**。本番の再利用ヒットはまだ 0 件（`analysis_reuses` は全て
`no_match`）なので、誰にも見えないうちに塞いだ。

### 検査が見つけられなかったこと、を検査が見つけた

完全性の批評役が正しく指摘した: **その時点で 3 つの修正は作業ツリーにしか無く、
マージされる HEAD には入っていなかった。** しかも修正を捕まえるテストも未コミット
だったので、**HEAD のテストは欠陥を抱えたまま緑**だった。CI はマージを止めない。
コミットして初めて直ったことになる、という当たり前を、仕組みとして言われた。

---

## 8.11 期間内に決着したかを別の記録にし、採点の時計を凍結した（2026-09-14、#91 step 2）

step 1 でプランは「狙う期間」を宣言するようになった。宣言しただけでは、守れたか
どうかは誰も見ていない。ここで 2 つ足す。**勝敗は 1 つも動かしていない。**

### (a) 採点の時計を凍結した — まず**数えてから**直した

採点器は窓の表（`ENTRY_WINDOW_MS` / `EXPIRY_DAYS`）を**生きたモジュール定数から**
読んでいた。つまり表を変えると、既に発行済みのプランが黙って再採点される。
「許容日数を縮めたせいで過去のプランが expired になる」が起こりうるのに、行には
何も残らない。`scoring_windows` を発行時に凍結しているのはそのためで、ここで
**その凍結を実際に効かせた**。

**読んでいる箇所を先に数えた。5 箇所あり、しかも独立ではなかった:**

| 場所 | 何の窓 |
|---|---|
| `track-outcomes/evaluate.ts` | 未約定を待つ窓・追跡を諦める窓 |
| `track-outcomes/index.ts` | WAIT 採点の horizon |
| `postmortem/index.ts` | **WAIT 診断**の窓 |
| `postmortem/facts.ts` | `life_used_ratio` の分母 |

**WAIT の採点窓と診断窓は、設計上わざと同じ horizon を歩いている。** 片方だけ
凍結すると、1 つの行が 2 つの違う窓で判定され、しかも行にはどちらで出た判定かが
書かれない。だから 5 つをまとめて 1 つの読み取り口 `resolveScoringWindows` に通し、
**5 つとも通っていること**をテストで固定した（実装が 2 つあると必ずずれる）。

**判定は 1 件も変わらない。**本番実測: 109 行中 108 行は `scoring_windows` を持たず
定数へフォールバックし、持っている 1 行の値
（`give_up_days` 180 / `unfilled_entry_ms` 2,592,000,000）は**現行定数と完全に同一**
だった。この主張はテストにも書いてあるので、口約束ではない。

読み取り口は半端に読めた場合に**行と表を混ぜない**（3 つ揃うか、全部表か）。混ぜると
`source` がどちらを名乗っても嘘になる。

### (b) pace — 期間内に決着したか。**成績ではない**

`separated_scores()` に 4 つ目の軸として足した。**行には保存していない。**
`plan_horizon.ends_at` も `evaluation.resolved_at` も既に行に凍結済みなので、導出は
2 つの凍結値の上で行われ、**track-outcomes を開ける必要が無かった**。既存 3 軸も
同じく導出なので、そちらに揃えた形でもある。

**母集団が上の 3 軸と違う。** 3 軸は postmortem が done の行しか見ない（facts が
要る）。pace は 2 つの時刻だけで出るので、診断待ちの行も数えられる。`causes` が
既に「違う母集団だ」と大声で書いているのと同じ扱いにした — 分母を書かずに並べるのが、
この関数が存在する理由そのものの誤りだからである。

**どちらが良いとも言っていない**（`descriptive: true`）。実測: 決着した 53 件を
24 本で打ち切ると 2 件が落ち、その 2 件は**どちらも勝ち**である。伸びた勝ちは期間の
外で決着する。画面はこの数字を良い／悪いの色で塗らず、その一文を行に出す。

本番での初回の値: `n: 0`（期間を宣言した決着済み取引はまだ無い）、`rate: null`
（答えが無いことを答えが無いと表示）、`no_horizon: 42`（step 1 より前の決着済み取引。
**隠さず出す**）。

`definition_version` は**上げていない**。既存 3 軸の定義は 1 文字も変わっておらず、
版をまたいだ比較は 3 軸についてそのまま有効である。古い保存物に pace が無いのは
「そのとき測っていなかった」という正しい意味になる。ここで上げると、変わっていない
3 軸に対してヘッダの警告（「1 つの実験が 2 つとして報告される」）が誤って発動する。

### 400 行の関数は手で写さなかった

`separated_scores()` は 400 行ある。§6.1 / §8.7-b のとおり書き写しはこのプロジェクトが
実際に壊した作業なので、**生きた定義を読み、アンカーで 3 箇所だけ差し替え、どれか 1 つ
でも 1 箇所でなければ中断する**形にした。適用後に「アンカーが在ったか」ではなく
**置換後の文字列が入っているか**を確かめている（53dca87 はそこを取り違えて偽を書いた）。

---

## 8.12 BUY が一度も出ない問題への 3 つの対処（2026-09-19、#95）

きっかけは利用者の一言だった。USD/JPY の売り建玉（153.274、損切り 160.000、TP1 152.900）を
持ったまま 156.895 まで逆行し、保有中カードは「判定できない」、そして「一回も BUY の
分析結果が出ませんが大丈夫？」。同時に**ワークフローの使用が禁止された**ので、以降の調査は
SQL とコードの直読みだけで行い、推測は推測と書いた。

### 調べて分かったこと（直したのはこの 3 つに対してだけ）

- **BUY が出ないのはゲートのせいではない。** 却下される前の `proposed_signal` 自体が
  SELL か WAIT しか無かった。分析器が BUY を提案していない。
- プロンプトは上位足の方向を「確信度の拒否権」として扱い、日足の読みは通期で downtrend
  だった。ところが**上位足の「終値ブレイク」行は非 full 表示では分析器に渡っていなかった**。
  9/14〜9/19 の転換を検出する仕組みが、サーバにもプロンプトにも無かった。
- 「判定できない」は設計どおりだった。#92 で登録した建玉には元のプランが無く、
  `thesis_status` は unknown → verdict は undecidable に落ちる。**建玉そのものを根拠として
  評価する道が無かった**。
- 利用者の記録には同方向の負けが 9 件並んでいたが、**画面のどこにも「連敗している」とは
  出ていなかった**。

### (1) 上位足の構造転換を分析器に見せる（analyze v61）

- `structure.ts`: 上位足のセクション（非 full 表示）にも `終値ブレイク(上)` / `終値ブレイク(下)`
  の 2 行を出す。full 表示は変えていない。
- `index.ts`: tfSections の末尾に**サーバ判定の方向行**を付けた
  （`上位足の方向(サーバ判定・各足の「終値ブレイク」行から): 4h=… / 1day=…`）。同じ
  sections は position-review にも流れる。SYSTEM_PROMPT の手順 3 に、上位足の方向は
  終値ブレイクで読むこと、逆らう signal はサーバーが公開しないことの 2 行を足した。
- `entry.ts`: `structureBias` は**直近の確定した終値ブレイク**（`state === "broken"`）の向き。
  上下両方にあれば `barsAgo` の小さい方、同数なら無し。ブレイクが無ければ二点ラベル
  （uptrend → Up / downtrend → Down）。`structureConflictFor(signal, higher)` が BUY/SELL を
  上位足の向きと突き合わせ、逆らっていれば `structure_conflict` で却下して WAIT を公開する。
  `entry_check` に `structure_read`（各上位足の読み）と `structure_conflict`（却下したときの
  足・向き・水準・時刻）を保存し、locale の却下文にも足した。

**正直に書いておく: このゲートは 9/9〜9/15 の連敗を防げなかった。** 当時の日足は
この基準でも Down と読めていた。効くのは上位足が転換した**次の足から**であって、
過去に遡って効くものではない。

### (2) プランなし建玉のレビューを「判定できない」で終わらせない（position-review v4）

`planBlock` は `analysis_id === null` の建玉に対して「元のプラン: **無し**」と明示し、
**評価する根拠（thesis）は「登録された方向・損切り・TP1」そのもの**だと書く。
`systemHeld` には「元の根拠が評価できない」を理由に undecidable にしないこと、
`unknown` は相場データそのものが無いときだけ、と足した。今の足がその方向を支持していれば
intact、逆行する事実が出ていれば weakened、逆向きの終値ブレイクが確定していれば broken。

### (3) 同方向の連敗を画面に出す（フロントのみ）

`directionStreak` は**読んでいる本人の記録**だけを見る。shadow と下見を除き、win / loss /
expired で決着した行を新しい順に並べ、最新が負けなら同方向の負けが何件続いているかを数える。
3 件以上で、結果画面（**同方向のプランが公開されたときだけ**）と履歴に出す。
「AI はこの連敗を見ていません。このプランはそれとは別に出ています」と併記した。
AI に見せなかったのは意図的で、連敗の数で判断を曲げる根拠がまだ無いからである。

### 出したもの（全 5 本、バイト一致を sha256 で照合済み）

| 関数 | 版 | fn ver | bytes | sha256 (先頭) | 試行 | 変わった理由 |
|---|---|---|---|---|---|---|
| analyze | v60 → **v61** | 82 | 106,525 | `431447bcdd4aa8f7` | 1 | 本体 |
| position-review | v3 → **v4** | 4 | 30,246 | `ef614d2129aa01ce` | 1 | プランなし建玉の thesis と systemHeld |
| postmortem | v30 → **v31** | 43 | 96,959 | `fd09baf85490645e` | 2 | 識別子名だけ。**挙動は不変** |
| version-compare | v11 → **v12** | 15 | 85,050 | `bad6e4d605b9a63a` | 1 | 同上 |
| track-outcomes | v17 → **v18** | 26 | 31,444 | `ce958f4f4f686122` | 1 | 同上 |

`noise-floor` はバイト単位で本番（fn 14、`e608381430d80333`）と同一だったので、
§8.8 と同じく版も上げず出してもいない。

後ろ 3 本を出したのは §8.8 の理由による。まず**本番 4 本が origin/main のビルドと一致する
ことを別 worktree で作り直して確かめ**、次にドリフトが「識別子文字以外の差が 0、
識別子を全部落とした骨格が同一」であることを機械的に確かめてから、版名を上げて出した。
`entry.ts` / `structure.ts` を取り込むバンドルは、コードが 1 バイトも増えなくても minifier の
識別子割り当てが変わる。バイトが違えば版名も変える（§8.7-a）。

analyze は 106,525 B。壁（110,299 は通り、116,242 は落ちた）まで **3.8 KB** しか無い。

### 照合の経路が変わった — 転記が 1 文字ずれ、今回は構文で止まった

**今回の照合は 1 文字も書き写していない。** 読み戻しは大きすぎて harness がファイルに
落とし（analyze / postmortem / version-compare / noise-floor）、小さい 2 本はセッションの
記録から取り出し、どちらも script で sha256 を比べた。ずれの検査も同じで、失敗した
postmortem のデプロイ本文を記録から取り出して HEAD のバンドルと行単位で比べたところ、
**差は 140 行目の 1 箇所、`?` が `&&` になっていた**だけだった。

これは §8.8 の「1〜2 文字を確率的に取り違える」と同じ経路だが、今回は**意味が変わる場所**
（三項演算子の `?`）だった。たまたま対応する `:` が浮いて構文エラーになり、バンドル段階で
弾かれて本番には出ていない（fn 42 のまま）。**構文が通る形でずれていたら sha256 の照合で
止まっていた**が、そこまでは行かなかった、というだけである。転記は依然として信用できない。

### 検査

tsc 12（基準どおり）、vitest 1,634 件通過（59 ファイル）、eslint 29（基準どおり）、
deno check 5 本とも通過。追加したテストは entry（`structureBias` / `structureConflictFor` /
ゲート / locale の `case "structure_conflict":` の存在）、structure（非 full 表示に 2 行）、
position-review（プランなし建玉の文言と systemHeld の規則）、outcome-stats（連敗の数え方）、
analysis-view（連敗の表示と非表示）。`EXPECTED_ANALYZE_VERSION` は v61 に上げ、
`weekend-preview.test.ts` がそれを固定している。

---

## 8.13 9/15 の SELL 判断の反省と、転換を読む仕組み（2026-09-19〜20、#96）

きっかけは「9/15 とか sell と判断したが絶対 buy で判断するべきでした。これについてしっかり
反省して、分析をレベルアップさせて」。#95 の 3 つの対処（§8.12）は「日足が直近高値を終値で
上抜けた**次の足**から効く」歯止めで、9/14〜9/15 の判断そのものは救えない、と書いていた。
今回はその判断を素材にして、何が見えていなかったかを保存データから数え直した。

### 読んだもの

- USD/JPY 9/8〜9/19 の全 84 回（signal・却下理由・確信度・結果・postmortem の原因と教訓）。
- 実際に送ったプロンプト（`analysis_prompts`）7 本: 9/14 10:59 1h SELL、9/14 20:47 1h WAIT、
  9/14 23:30 / 9/15 02:21 / 9/15 22:52 の 1day SELL ほか。
- 行に保存された構造（`context.structure`）と指標（`context.entry` / `context.higher`）、
  および**全ペア**の決着済みプラン（shadow・下見を除く）。

### 分かったこと（すべて保存データの数字）

1. **BUY は構造的に出せなかった。** 全 113 回で BUY 1・SELL 62・WAIT 50。`proposed_signal`
   に BUY は 0（記録のある 102 行中）。プロンプトの「上位足に逆らうエントリーは確信度を大きく
   下げる」+「60 未満は WAIT」+ 日足ラベルが 9/19 まで「下降」で、BUY は WAIT に潰れていた。
2. **9/14 20:47 の 1h は上に転換済みだった。** 154.489 を終値で上抜けて維持、RSI 68.2、
   MACD ヒスト +0.097、SMA20（153.969）の上。出力は WAIT（`wait_missed_trade`）。
3. **9/15 02:21 の日足 SELL の材料。** 直近の下抜け 158.036 は 8 本前、MACD ヒストは 9/10 の
   −0.53 から −0.18 へ上向き、RSI は 22 → 35〜39、下値余地 0.30ATR（154.006）、TP1 152.95 は
   三番底の向こう、FOMC が 48.7 時間後（プランは 120 時間）。
4. **勝敗を分けるもの／分けないもの**（全ペア決着 SELL 55 件）。
   - 下抜けから 2 本以内の SELL: 6 勝 2 敗。戻された（失敗した）下抜けの後の SELL: 9 勝 13 敗。
     6 本以上前の古い下抜け: 3 勝 5 敗。抜け無し: 5 勝 9 敗。
   - 「余地 0.5ATR 未満」: 5 勝 5 敗。「上位足の売られ過ぎ（RSI≤32 か SMA20 から −2ATR）」:
     21 勝 23 敗。**どちらも分けない。** 教訓が 10 回繰り返した「余地 0.5ATR 未満は見送る」は
     データが支持しないので、ゲートにしていない。
5. 週足は 9/15 時点で 155.251 を**下抜けた直後（0 本前）**。日足プランの BUY は週足に真っ向から
   逆らう。取るべきだったのは 4h（153.818 を上に回復）/ 1h（上抜け確定）の BUY で、それが
   WAIT だったのが本当の取りこぼしである。

### 直したもの

- **`analyze/turn.ts` 転換の証拠（サーバ判定・対称）。** 各足の確定足から 7 つの事実を数える:
  失敗した抜け（`failed_break`）・古い抜け（`stale_break`、6 本以上前で以後の同方向の抜け無し）・
  MACD ヒストの 3 本連続（`hist_run`）・RSI の極値からの戻り（`rsi_recovery`、10 本以内に ≤30
  / ≥70 を触れて 8pt 以上戻る）・SMA20 の跨ぎ（`mean_cross`、5 本以内）・逆方向の終値ブレイク
  （`counter_break`、6 本以内）・ダイバージェンス（エントリー足のみ）。上向き・下向きを常に両方
  計算し、プロンプトに 1 行（`転換の証拠(サーバ判定・確定足): 上向き 3/7 [...] ｜ 下向き 0/7 [なし]`）、
  `context.turn` に数値ごと保存する。
- **ゲート（`entry.ts`）。** `TURN_BLOCK = 3`、`FRESH_BREAK_BARS = 2`、`STALE_BREAK_BARS = 6`。
  - `turn_conflict`（新しい却下）: エントリー足の方向に乗る継続プラン（下降中の SELL）を、
    逆向きの証拠が 3 以上あり、直近 2 本以内に同方向の終値ブレイクが無いとき公開しない。
    9/14 23:30 と 9/15 02:21 の日足 SELL がこれ。下抜け 2 本以内の SELL（6 勝 2 敗）は止めない。
  - **転換中の上位足は拒否権を失う**（`structureVerdictFor` の yield）。9/14 20:47 の 1h BUY は、
    日足が「下（終値ブレイク）・ただし転換中 3/7」で拒否せず、4h は方向なし → 公開できる。
    通した上位足は `entry_check.structure_yielded` に、各足の数と転換中かは
    `structure_read[].turn / turning` に残す。
- **プロンプト手順 3 と 6。** 方向は終値ブレイク、転換中の定義、継続プランと逆方向プランの規則を
  書き、「上位足がまだ下向きだから」だけを理由に反対方向を捨てるなと明記。手順 6 は
  **`counter_case`（反対方向のケース）を signal を決める前に必ず書かせる**: 方向・一行の
  テーゼ・一覧の数値を引用した根拠 2〜4 件・乗り換える条件。schema では任意（replay harness の
  必須キー検査のため。`conditional_wait` と同じ理由）、プロンプトでは必須。行の `result.counter_case`
  に保存し、画面の「反対のケース」カードに出す。
- **世代。** `counter_case` は全腕が送るので、control 腕は v48 を離れて **v62**（3,402 字 /
  md5 `2592d20d…`）、候補腕は **v62cond**（4,328 字 / md5 `6364e194…`）。両方
  `prompt-surgery.ts` の `SCHEMA_ERAS` に登録。`shape.ts` の `CONTROL_RESPONSE_SCHEMA` は
  `conditional_wait` と `counter_case` の**両方**を剥ぐので、凍結コーパスへ送るバイトは v48 のまま
  （`variants.test.ts` と `noise-floor-shape.test.ts` が両方の等式を固定）。
- **画面。** 却下理由 `turn_conflict`（件数と閾値を行から読む）、`structure_read` の転換表示は
  型のみ、`counter_case` カード（方向・テーゼ・根拠・乗り換え条件）。
- **固定データでの再現（`src/test/turn.test.ts`）。** 9/15 02:21 のプロンプトにあった日足 40 本を
  確定足として固定した。上向き ≥3（古い抜け・MACD ヒストの連続上昇・RSI の戻り）で SELL は
  `turn_conflict`、BUY はこのゲートの対象外（週足が決める）。合成系列で 7 事実の各々と鏡像対称、
  新しい抜けの免除を確認。`entry.test.ts` で 9/14 の 1h BUY が日足を通過すること、9/8 の SELL が
  止まらないこと、上位足の拒否が先に来ることを固定。

### 正直に書いておくこと

- **9/15 に日足プランで BUY は、今回の版でも出ない。** 週足の下抜けが 0 本前で新しく、転換の
  証拠も足りない。出るようになるのは 1h / 4h のプラン（日足が転換中として拒否権を失う）。
- ゲートは事後に見つけた型に合わせたもので、効果は測っていない。保存データの**点値**で近似した
  「転換スコア」は勝敗をきれいに分けない（スコア 0: 14 勝 16 敗、1: 4 勝 10 敗、3: 5 勝 2 敗 —
  3 は戻り売りの勝ち）。turn.ts が見るのは「連続」「戻り」という**変化**で、それは点値からは
  復元できない。効かなかったら次の決着で分かる（§9 の照会に `turn_conflict` を足すこと）。
- 「余地 0.5ATR」は入れていない（上の 4）。教訓の文面とデータが食い違う例として残す。
- **analyze のバンドルが壁を越えた。** 単一ファイルで 115,580 B（§8.12 の壁: 106,525 は通過・
  110,299 も通過、116,242 は落下）。これでインラインのデプロイ経路は使えなくなったので、
  経路そのものを変えた（下）。

### デプロイ経路を変えた — バイトをメッセージに載せるのをやめる（2026-09-20）

これまでのデプロイは、ミニファイ済みバンドル約 100 KB を**丸ごとツール呼び出しに書き写して**
送っていた。この経路には天井があり（106,525 B は通過、116,242 B は落下。落下時は本文が黙って
消えて `deno.json` 84 B だけが届いた）、#96 の 115,580 B はその天井の中にある。加えてこの経路は
本番の手前に転記を挟むので、事故が 3 回起きている（#48・#51・2026-09-19 の 1 文字）。

そこで `.github/workflows/deploy-functions.yml` を足した。GitHub がリポジトリをチェックアウトし、
Supabase CLI が **TypeScript ソースを直接**デプロイする。

- 既定の対象: `analyze` / `position-review` / `postmortem` / `track-outcomes` / `noise-floor` /
  `version-compare`。決済系（create-checkout・stripe-webhook・cancel-subscription）と
  `econ-calendar` は**既定に入れていない**。このパイプラインの一部ではなく、触っていない push で
  出し直す理由が無いため。手動実行（workflow_dispatch）で slug を名指しすれば出せる。
- 起動条件: `main` への push で `supabase/functions/**` か `supabase/config.toml` か
  このワークフロー自身が変わったとき、および手動実行。
- `verify_jwt` は `supabase/config.toml` から読む（ワークフローのフラグにしない）。
- **必要な秘密**: リポジトリの Secret `SUPABASE_ACCESS_TOKEN`（Supabase の
  Account → Access Tokens で発行）。無いときはワークフローが最初のステップで止まり、
  どこで発行してどこに入れるかを `::error::` で出す。**トークンの値はこのリポジトリにも
  ログにも残らない。**
- これで `supabase/functions/**/index.ts` が唯一の出所になる。`bundle.js` 群は
  **ローカルのサイズ確認とインライン経路の代替**として残すが、本番で動くものではなくなった。
  §8.7-a の「読み戻して sha256 で照合する」手順は、インライン経路を使うときだけの手順である。

### 出したもの（GitHub Actions の run #1、2026-09-20 02:35Z）

| 関数 | 版 | fn ver | 経路 |
|---|---|---|---|
| analyze | v61 → **v62** | 82 → **83** | Actions |
| position-review | v4 → **v5** | 4 → **5** | Actions |
| postmortem | v31 → **v32** | 43 → **44** | Actions |
| track-outcomes | v18 → **v19** | 26 → **27** | Actions |
| noise-floor | v6 → **v7** | 14 → **15** | Actions |
| version-compare | v12 → **v13** | 15 → **16** | Actions |

決済系 3 本と `econ-calendar` は既定の対象外なので、版も fn ver も動いていない（意図どおり）。
デプロイ全体で 25 秒（`Deploy` ステップ 02:35:11→02:35:36Z）。

**動いている版の確認の仕方も変わった。** バンドルを読み戻して sha256 を比べる代わりに、
関数に認証なしで当てて、返る JSON の `version` を読む（どの応答にも `FUNCTION_VERSION` が
入る）。実測:

```
analyze         → 401 {"version":"analyze-v62-2026-09-19T15:00:00Z", ...}
position-review → 401 {"version":"position-review-v5-2026-09-19T15:00:00Z", ...}
```

これは「リポジトリのバイトが本番に届いたか」ではなく「**本番で動いているコードが何と
名乗るか**」を見ている。Actions が出す以上、届いたバイトはリポジトリのものだと GitHub の
チェックアウトが保証するので、照合する対象はそちらに移った。

### 検査

tsc 12（基準どおり）、eslint 34（clean tree の実測も 34。§8.12 の「29」は当時の数字）、
vitest 1,667 件通過（60 ファイル）、deno check 6 本通過。`EXPECTED_ANALYZE_VERSION` は v62。

---

## 8.14 損切りと利確1に ATR×0.6 の下限を入れた（2026-09-21、#97）

利用者の指示:「利確と損切りの幅を最低0.6は設定してください」。きっかけは 1 時間足のプランで、
損切り 20pips（ATR 0.9 倍）・利確1 25pips（ATR 1.1 倍）。**そのプラン自体は下限を満たしていた**が、
下にあった床は ATR×0.4 で、同じ ATR なら 9pips の損切りまで通る設定だった。

### 入れたもの

- `MIN_STOP_ATR` を **0.4 → 0.6**。
- `MIN_TP1_ATR = 0.6` を新設し、却下理由 **`target_too_close`** を足した（entry.ts の Rejection は 8 種に）。
  エントリーの反対側にも同じ幅を要求する。「届いても読みが当たった証拠にならない距離」という意味。
- **判定は表示と同じ丸めた ATR 倍で行う。** 0.6 は二進では表現できず、`150 - 0.6` は
  0.5999999999999943 になる。生の double で比べると、画面が「ATR 0.6倍」と表示している隣で
  「近すぎる」と却下する行ができる。#83 で消したのと同じ型の嘘なので、行に記録し画面に出す
  `round2` 済みの値で判定する。
- 却下の順番は 損切り → 利確1 → リスクリワード。利確 0.4ATR・損切り 0.8ATR のような行は
  RR（1:0.5）でも落ちるが、**「利確が近すぎる」の方が正確な一文**なのでそちらを返す。

### 波及したもの（黙って変わると困るもの）

- **WAIT の採点対象が変わった。** WAIT は「このアプリ自身が許す最小のトレード」で採点する決まりで、
  その寸法は上の 2 つの定数から作られる。最小トレードは 損切り 0.4ATR・利確 0.48ATR から
  **0.6ATR・0.72ATR** になった。別の尺度なので `WAIT_SCORER` を **2 → 3**。
  - 保存済みのプランは自分が刻まれた era のまま。採点器は**保存されたプランの水準**を歩くので、
    過去の判定が遡って書き換わることはない（track-outcomes/waits.ts）。
  - `judgeWait` が判定に刻む era を、ビルドの現在値ではなく**採点したプランの era** に直した。
    これをしないと、era 2 のプランに対する判定に 3 が刻まれ、2 つの測定が 1 つの数字に混ざる。
  - **学習ダイジェストの `waits_judged` は一度 0 に戻る。** 本番の WAIT 判定は全て era 2 で、
    `>= WAIT_SCORER` のフィルタが era 2 を落とすため。これは仕様どおりで、
    「見送りすぎ」の唯一の証拠がしばらく空になることを意味する（§9 で見ること）。
- **条件付き WAIT のトリガー下限も 0.6 ATR に動いた。** `MIN_TRIGGER_ATR` は
  `MIN_STOP_ATR` を import していて、「ゲートがノイズと呼ぶ距離に置いたトリガーは、
  このアプリ自身が信じていない水準」という理由で同じ値にしてある。候補腕の挙動が変わる。
- **post-mortem の反実仮想**も同じ床で viable を判定する（`tp_half` のように利確を半分にする案は、
  0.6ATR を割ると `target_too_close` で採用不可になる）。

### 実測（主張を先に書いて外したので、数え直して置いた）

- 公開済みプランで `stop_atr` を持つ 57 件のうち、**0.4〜0.6 に 3 件**あり、新しい床なら却下されていた:
  09-07 12:50 JST USD/JPY 1day 0.50（勝ち）／09-11 22:01 1day 0.57（負け）／09-14 11:01 4h 0.59（負け）。
  1 勝 2 敗は n=3 で何の証拠でもない。**床が何を落とすかの事実**として置く。
- `tp1_atr` を持つ 47 件のうち、最小は **0.71 ATR**で、0.6 を割るものは無い。利確側の床は
  今のところ**何も落とさない**（`MIN_RISK_REWARD` を下げたときに初めて効く保険）。
- `entry.test.ts` の「公開されて約定した唯一のプラン」を再現するテストは、**却下される側に反転した**
  （1day BUY、損切り 0.53ATR）。床が動いたらこういうテストが書き換わるべきなので、消さずに反転させた。

### 検査

vitest 1,674 件通過（60 ファイル）、tsc 12（基準どおり）、eslint 34（基準どおり）、deno check 6 本通過。
版: analyze **v63**、postmortem **v33**、track-outcomes **v20**（`EXPECTED_ANALYZE_VERSION` も v63）。
position-review / noise-floor / version-compare は挙動が変わらないので据え置き。

---

## 8.17 分析モデルを利用者の指定した新しい版に切り替えた（2026-09-25、#101）

利用者の指示:「この記録は claude-opus-5 が単独で書いています を opus5.5 に使う様にして」。

### 変えたもの

- **analyze の `baseRequest.model`** と **postmortem の `MODEL`** を新しいモデルに（ID はコードの定数を参照）。
  保有中レビュー（position-review）は analyze が渡すモデルを使うので、自動で同じモデルになる。
- **effort は明示のまま**（テクニカル `medium`、検索あり `low`）。新しいモデルは API の既定 effort が
  前のモデルより 1 段低く、同じ段でも前のモデルより多く考える。
- **出力上限**: 考えた分も上限に数えられるので、上限の小さい所を広げた。保有中レビュー 2000 → 4000、
  原因分析 2500 → 4000、ルールブック改訂 4000 → 6000。**分析本体の 8000 は据え置き**（前のモデルでの
  実測は平均 1,683・最大 2,813。ノイズ床と版比較のハーネスがこの値に固定されている）。
- **AI が回答を控えた場合（`stop_reason: "refusal"`）と上限で切れた場合（`max_tokens`）を別のエラーに**した。
  これまではどちらも「解析に失敗しました」になっていた。どちらも利用回数は返金される。
- 版: analyze **v66**、postmortem **v35**（`EXPECTED_ANALYZE_VERSION` も v66）。

### 変えなかったもの（理由つき）

- **サーバー側のフォールバック（拒否時に別モデルで自動再実行）は入れていない。** 入れると、どのモデルが
  答えたかが回答ごとに変わり得て、行に刻むモデルとノイズ床・版比較の「本番と同じリクエストで再生する」
  前提が崩れる（`noise-floor-shape.test.ts` は analyze に beta ヘッダが無いことを固定している）。
  FX 分析で拒否される種類（サイバー・生物・推論の書き出し）に当たる見込みは低いので、まず拒否の件数を
  `model_refusal` で数え、出るようなら入れる。

### 読むときの注意

- **これより前の実測は前のモデルのもの。** ノイズ床（#64 の 20.83%）、版比較の判定（#65）、確信度の較正、
  成績の集計は、前のモデルの行で測った。新しいモデルの行が溜まるまで、それらを新しいモデルの性質として
  読まない。画面の「モデルの内訳」は行ごとのモデルで分けて数えるので、切り替え後は 2 モデル表示になる。
- 前回モデルを替えたとき（2026-09-12）は effort を `max` にして壁時計（150 秒）で 504 が続き戻した。
  今回は effort を据え置いたが、同じ段でも考える量が増えるので、切り替え後の所要時間を行で確認する
  （`analysis_prompts.sent_at` → `analyses.created_at`）。

---

## 8.16 反発の条件をチャートから数え、時間足ごとに的中率を測ってチャートに描く（2026-09-25、#99）

利用者の指示:「各時間足でチャート分析だけで、どんな条件反発するのかとかを分析させて、チャートにこんな感じで表示させる様にして
チャートに線引いたりして　この精度を完璧にあげてください今から」（添付は SNS で流れている「BUY/SELL の旗が付いた
インジケーター」のスクリーンショット）。

### 先に結論（正直に）

**「反発しやすい条件」を機械的に数えたところ、日中足（1分・15分・1時間）ではどの条件も的中率 35〜46% で、
損益分岐（利確が損切りの 1.5 倍なので 40%）の前後に固まっている。**つまり、この種の条件だけで「精度を完璧に上げる」
ことはできない。できたのは、**その条件が本当に何回反発したかを数え、AI と画面の両方にそのまま出す**ことで、
「サポートで反発しやすい形」という言い方が数字なしに出ないようにしたこと。4時間足・日足の BUY 側だけは 50% 前後の
条件があるが、計測期間（2024-01〜2026-09）がほぼ円安・ドル高の一方向だった影響を切り分けられない。

### 入れたもの

- **`analyze/signals.ts`**（Deno 非依存・`src/test/signals.test.ts`）: 確定足から 8 条件 × BUY/SELL を数える。
  確定安値/高値での反発（`level_reject`）、SMA200 での反発（`ma200_reject`）、上向き/下向き SMA20 への押し目・戻り
  （`ma20_pullback`）、BB の外から内側への復帰（`band_reentry`）、雲の上限/下限での反発（`cloud_reject`）、
  ダイバージェンス確定（`divergence`）、ダブルボトム/トップ確定（`double_pivot`）、水準での包み足（`engulfing`）。
  - **先読みしない**: 各条件は「その足とそれ以前」だけで決まる。ピボットは前後 2 本で確定するので、ダブルボトムや
    ダイバージェンスは**2 本後の足に旗が付く**（安値そのものには付かない。付けたら SNS のインジケーターと同じ描き直しになる）。
    テストで「先頭 k 本だけで計算した結果 = 全体で計算した結果の k 本目まで」を固定してある。
  - **上下対称は構成で保証**: ルールは BUY 側だけ書き、SELL 側は全価格を負にした系列に同じコードを当てる（高値と安値、
    RSI と 100−RSI、BB の上下、雲の上下がそのまま入れ替わる）。ATR は反射で不変（テストで確認）。
  - **値付けは本番のプランと同じ**: エントリー=その足の終値、損切り=反発の極値の 0.1ATR 先（ATR×0.6 未満は 0.6 に、
    ATR×1.2 超は「損切り幅超過」として数え、値は付けない）、利確=損切り幅×1.5。以後の足を歩いて、利確先=勝ち、
    損切り先=負け、同じ足で両方=判定不能、48 本以内に決着なし=期限切れ。**仲値・スプレッド抜き**（分析と同じ系列）。
  - 出力: 条件×方向ごとの n・勝敗・的中率・**Wilson 95%CI**・期待値(R)・平均決着本数、直近 3 本で成立した条件、
    直近 2 スイングを結ぶ線（安値線・高値線）。
- **プロンプト**: 各時間足のブロックに「反発の実績（この窓）」と「長期実績（下記の計測値・USD/JPY のみ）」を出す。
  手順 2 に「引用は勝敗の数字と CI をそのまま使う／挙がっていない条件を反発しやすいと呼ばない／n<5 か CI 下限が
  損益分岐未満の条件は根拠にしない」を追加。損切り幅の上限 1.2 は `MAX_STOP_WIDTH_ATR` として定数化した（これまで
  プロンプトの文字列にだけあった）。
- **記録**: `context.signals`（時間足ごとの集計・直近成立・線。信号の全リストは保存しない）。
- **画面**: チャートを時間足ごとにタブで切り替え（連鎖の 3 段、各 120 本）。条件が成立した足に BUY/SELL の旗
  （濃い=勝ち・薄い=負け・白抜き=判定中/不能）と、その損切り・利確の短い線、直近 2 スイングの線。
  下に「反発の条件（この窓での実績）」の表（条件・勝敗・的中率(95%CI)・今成立）と、数え方の注記と損益分岐。
  旧い応答（`charts` なし）は従来どおり 60 本のチャートだけを出す。
- **`supabase/functions/signal-backtest`**（ハーネス）: GMO の公開 Bid/Ask を日付ファイルで遡り、同じ検出器を長期に
  当てて集計を返す。sweep トークン必須・書き込みなし。MCP でバンドルを直接デプロイした（v2、12,937B）。
  ワークフローの既定集合には入れていない（手動実行で名指し可）。

### 長期実測（USD/JPY・GMO 仲値・確定足・RR1.5・48 本・2026-09-25 計測）

n≥20 の主な行。`[ ]` は Wilson 95%CI、期待値は R。**損益分岐は 40%**。

| 足 | 期間 | 条件 | BUY | SELL |
|---|---|---|---|---|
| 1min | 2026-08-24〜09-25（33,434 本） | 確定安値/高値での反発 | 42% [39-45] n=1043 | 41% [38-44] n=1025 |
| 1min | | SMA200 | 35% [29-42] n=223 | **50% [43-57] n=192** |
| 1min | | BB 復帰 | 42% n=588 | 41% n=663 |
| 15min | 2025-09-23〜2026-09-25（24,780 本） | 確定安値/高値での反発 | 41% [38-44] n=1004 | 41% [38-44] n=1138 |
| 15min | | SMA200 | 46% [39-53] n=199 | 40% [32-47] n=157 |
| 15min | | SMA20 押し目/戻り | 39% n=610 | 39% n=427 |
| 15min | | BB 復帰 | 42% n=319 | 40% n=509 |
| 15min | | 雲 | 40% n=349 | 40% n=240 |
| 1h | 2025-09-23〜2026-09-25（6,195 本） | 確定安値/高値での反発 | 40% [34-46] n=247 | 37% [32-42] n=308 |
| 1h | | SMA20 押し目/戻り | 41% [34-48] n=184 | 29% [21-38] n=98 |
| 1h | | BB 復帰 | 39% n=75 | 35% n=144 |
| 1h | | 雲 | 32% n=89 | 32% n=60 |
| 4h | 2024-01-01〜2026-09-25（4,260 本） | 確定安値/高値での反発 | **53% [45-61] n=146（+0.34R）** | 37% [30-44] n=177 |
| 4h | | SMA20 押し目/戻り | 47% [37-57] n=96 | 38% n=66 |
| 4h | | SMA200 | 50% [36-65] n=42 | 35% n=23 |
| 4h | | 雲 | 50% [38-63] n=58 | 32% n=41 |
| 4h | | BB 復帰 | **19% [10-33] n=47** | 46% [38-56] n=112 |
| 1day | 2024-01-01〜2026-09-25（709 本） | 確定安値/高値での反発 | 55% [34-74] n=20 | 29% n=14 |

前半/後半に割った安定性: 15分足の確定安値/高値反発は前半・後半とも 41%（両方向）で**安定して損益分岐**。1時間足の
BUY は 35%→45%、SELL は 40%→34%。4時間足の BUY 確定安値反発は 57%→49%、SMA20 押し目は 54%→38% と**後半で落ちる**。
1分足の SMA200 での反落（SELL）は 49%→52%。SMA200 の上か下か（順張り/逆張り）で割っても、時間足をまたいで一貫する
規則は出なかった（1時間足の確定安値反発 BUY は逆張り側 51%・順張り側 33%、15分足の BB 復帰 BUY も逆張り側 48%・
順張り側 35% だが、4時間足では逆）。

「利確を 1.0R にしたら」（決着前に 1.0R まで伸びた割合）も 48〜55% で、損益分岐 50% の前後。**利確の倍率を変えても
辺は出ない。**

### 見落としていた不具合（バックテストが捕まえた）

最初の実行で **SELL 側の SMA200・SMA20 の行が全時間足で 0 件**だった。水準の判定に `usable`（`> 0` を要求）を使い回して
いたため、負にした系列では移動平均が常に「使えない」と判定されていた。反射のテストでは捕まらない（バグも対称に反射する）
ので、「長い系列で全ルールが両方向に出る」テストを足して直した。

### 検査

vitest 1,711 件通過（61 ファイル）、tsc 12・eslint 34（基準どおり）、deno check 8 本通過（analyze + signal-backtest を含む）。
版: analyze **v65**（`EXPECTED_ANALYZE_VERSION` も v65）。postmortem / track-outcomes は変更なし。

---

## 8.15 1分足の分析を追加した（2026-09-24、#98）

利用者の指示:「超短期売買用に1分足の分析機能も追加して」。

### 入れたもの

- **時間足の連鎖は 1分足 → 5分足 → 15分足**（`TF_CHAIN["1min"]`）。他の連鎖と同じ「1段上、さらに1段上」
  の形。1時間足は入れていない: Twelve Data は 1 分析あたり 3 リクエストで固定（tracker の枠の計算がそれ前提）で、
  30 分で終わるプランに 1 時間足の 3 本目を使うのは割に合わないため。
- **分析も GMO の Bid/Ask で行う**（`GMO_ANALYSIS_TIMEFRAMES` に `1min`）。採点は GMO で行うので、分析側の
  フィードが違うと、1分足の小さな損切りに対してフィード差が無視できない割合になる。1日のファイルに 1,440 本
  あるので 250 本は 1〜2 ファイルで足り、どの足よりも安い。
- **狙う期間は 30 本（30 分）**。他の足と違い**実測の保有本数から出した数字ではない**（1分足の記録がまだ無い）。
  行に刻んであるので、記録が溜まれば採点をやり直さずに差し替えられる。
- 採点（track-outcomes）: 1分足のプランは 1分足で歩く。**1分より細かい足は無い**ので、1本の中で損切りと利確の
  両方に触れた足は分割できず `ambiguous`（判定不能）で決着する。これは「その 1 分の中の順番は分からない」という
  正直な判定で、1分足では他の足より起きやすいはず。
  期限 1 市場日、見送りの採点窓 1 時間（他の足が約 48 本なのを 60 本に丸めた）、再判定 1 分ごと。
- 事後分析（postmortem）: 決着後 15 分待ち、30 本の後の値動きを見る。
- **画面**: 時間足の選択肢に「1分足」（スマホ幅 320px で 5 つ並ぶよう文字を 11px に）。期間は「約30分」と
  分で言う（時間で言うと「約0時間」になり、終わったプランに読める）。**1分足のプランにだけ**、価格を読んだ時刻と
  表示時点での経過秒数を出す。

### 実測で決めたもの

- **価格を読んでから結果が保存されるまで、中央値 54.3 秒・p90 64.0 秒**（full 109 件）。technical_only は
  3 件しか無く（中央値 43.8 秒）比べられない。1分足ではほぼ 1 本分ずれるので、画面に秒で出す。
- **取得本数**: 最初の案（1分足 550 本・5分足 400 本）は、**週の最悪の瞬間（月曜の窓開け直後）に使える足が
  0 本**だった。週末の休場は約 43 時間 = 1 分足 2,580 本分あり、550 本がまるごと吸われる。
  `weekend-preview.test.ts` の既存の検査がこれを捕まえた。**1分足 3,000 本（最悪でも 420 本残る）、
  5分足 800 本（284 本残る）**にした。Twelve Data の課金はリクエスト単位なので本数は費用に効かない。
  tracker 側の 1 分足の取得も、期限 1 日＋週末を覆う 3,200 本にした。

### 1分足を足すと黙って壊れていたところ（2 か所は実害、1 か所は私の読み違い）

1. **GMO の鮮度・欠損チェックに「1時間」が直書き**されていた（`acceptOverlay` の `intervalMs`）。1時間足だけが
   対象のうちは偶然正しかった。1分足では 90 分古い系列が「新しい」と判定される。エントリー足の長さを渡すよう直した。
2. **再利用の窓**が未定義の足で「1時間」に落ちる。実際にはプロンプトに最新の 1 分足が入るので鍵がほぼ一致しないが、
   「ほぼ」は 1 分足の契約として弱いので 1 本分にした。
3. `price-source.ts` の足の長さが「15分足以外は全部 1 時間」扱いだった。**最初、これで最新 60 本が捨てられると
   報告したが誤りだった**（`usableBars` は足の長さを使っていない）。実際の影響は、日付ファイルを遡る範囲が 4 日分で
   なく 18 日分として計算され、データが薄い時間帯に最大約 36 リクエストを期限まで打ち続けること。表にして直し、
   テストは「旧コードでは落ちる」ことを確かめてある。

### 正直に書いておくこと

- 1分足の ATR は **推定で 2〜3 pips**（15分足の ATR 約 10 pips を √15 で割った値）。損切りの下限 ATR×0.6 は
  **推定 1.5〜2 pips**で、スプレッドがその無視できない割合を占める。
  **プランの採点にはスプレッドが入っている**（GMO の Bid/Ask で判定するとき、BUY は Ask で約定して Bid で決済、
  SELL はその逆。`fillSide` / `exitSide`）。つまり 1 分足では、スプレッドの分だけ損切りに届きやすいことが
  そのまま成績に出る。入っていないのは**見送り（WAIT）の採点だけ**（`WaitPlan.spread` は記録のみ）と、
  GMO が取れずに仲値で判定した行（`price_basis = "mid"`）。
- 学習ルール（ルールブック）は 15 分足以上の実績から作られたもので、1 分足の分析にもそのまま提示される。
  局面の比較（rule_fit）は時間足を問わないので「今の相場に該当」と出ることがあるが、時間足の違いは見ていない。
- 1 分析は他の足と同じく利用回数を 1 つ消費し、モデル呼び出しの費用も同じ。

### 検査

vitest 1,681 件通過（60 ファイル）、tsc 12・eslint 34（基準どおり）、deno check 7 本通過。
版: analyze **v64**、postmortem **v34**、track-outcomes **v21**（`EXPECTED_ANALYZE_VERSION` も v64）。

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

**I. 候補版の腕（#86 / #87）** — 腕ごとに、混ぜずに

```sql
select public.variant_stats();
```

読み方の順番は決まっている。

1. `rows` と `conditional_claims` を先に見る。主張が 0 件なら比率は無い。
2. `rejections` を見る。ひとつの理由に偏っていたら、それは「腕の結果」ではなく
   「腕が走っていない」。
3. `conditional_not_triggered` を**分母に入れて**見る。届かなかった水準は合格では
   ない。
4. `conditional_right` / `conditional_wrong` は、**必ず `conditional_with_trend` /
   `conditional_against_trend` と並べて**見る。§8.7 の表のとおり、弱いトレンド
   だけで 64% が出る。流れに沿った主張ばかりで高い比率が出ていたら、それは
   相場を測っている。
5. 決着した主張が 194 件に届くまで、比率は報告しない。

`performance_stats()` と足し算してはいけない。あちらは `variant = 'control'`
だけの記録である。

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
- [ ] `position_review` の形（`analyze/review.ts` の `PositionReview`）を変えるなら、フロントの鏡（`src/lib/types.ts`）・カード（`HeldPositionCard` / `ChangeSinceLastCard` / `ReviewFacts`）・i18n を同時に足す。verdict は `held` だけ、`change` は `previous` だけ、根拠の評価は `kind` に入れない（§2.3）。
- [ ] プロンプトの**送り方**（`model` / `effort` / `max_tokens` / tools / user メッセージの組み立て）を変えたら、`analyze/reuse.ts` の `REUSE_VERSION` を上げるか確かめる。答えの出方が変わったのに鍵が同じなら、古い版の答えが新しい版の入力に対して配られる（§2.4）。時刻の文言をロケールに足したときは `CLOCK_LINE` と `src/test/reuse.test.ts` の全ロケール検査を通す。
- [ ] **プロンプトの外から答えに入るもの**（web 検索のように、モデル呼び出しの時点で取りに行くもの）を足したら、その回を再利用の対象から外す。鍵はプロンプトしか見ていないので、外にあるものは「同じ入力」の判定に入らない（§2.4）。
- [ ] 断る理由を足したら `REUSE_OUTCOMES` と `analysis_reuses.outcome` の CHECK 制約を**両方**動かす（テストが突き合わせる）。
- [ ] エッジ関数を増やすなら `config.toml`・`package.json`（`bundle:*` と `check:functions`）・`.gitignore`（bundle.js）・deno.json を同時に足す。出す順番は「呼ばれる側 → 呼ぶ側 → フロント」。
- [ ] analyze のバンドルは **110KB 未満**に保つ（§6.1.1 の実測。116KB は通らなかった）。`review.ts` から import を増やすとプロンプト本文が丸ごと戻ってくるので、`npm run bundle:analyze && wc -c` で必ず測る。
- [ ] 部分索引を足すなら、述語を**照会と同じ綴り**で書く。`shadow = false` の索引は `shadow=is.false`（PostgREST の既定）の照会を拾わない。`explain` で実際に選ばれることを確かめる（§2.4）。
