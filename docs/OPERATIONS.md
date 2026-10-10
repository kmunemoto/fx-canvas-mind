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

## 8.18 過去のチャートから状態ごとの傾向を測った。方向の手がかりは無く、時間帯のコストだけが効いた（2026-09-25、#100）

利用者の指示:「精度は過去のチャートを分析して傾向を調べて上げて」。

### 方法（研究: `research/tendencies.ts`、実行: `.github/workflows/research.yml`）

- **データ**: GMO の 15 分足 Bid/Ask、2024-01〜2026-09（約 67,500 本）、USD/JPY・EUR/USD・EUR/JPY・GBP/JPY・AUD/JPY。
  1 時間足・4 時間足・日足・週足は 15 分足から組み立てた。
- **各バーで**、状態（`analyze/state.ts`: MA50/200 の上下と傾き、20 本モメンタム、RSI・ADX・DI・BB・ボラの帯、
  時間帯、曜日、直近 2 スイングの並び、20 本レンジ内の位置、連続足、足の大きさ、上位 2 段のトレンド）を読み、
  BUY と SELL を公開プランと同じ形で開いた（BUY は Ask で入り Bid で決済、SELL は逆、損切り ATR×0.8、
  利確はその 1.5 倍、両方届いた足は 15 分足で割る。損益分岐 40%）。
- **前半（〜2025-06）で傾向を探し、後半（2025-07〜）で確かめた。** Holm 補正、日単位（4 時間足は週単位）の
  クラスタで信頼区間。USD/JPY で作ったモデルを他の 4 ペアの後半にも当てた。
- **対照実験**: 正しいランダムウォークでは、見つかる傾向 0 件・後半の AUC 0.49〜0.53。最初は試運転用の乱数が
  壊れていて（倍精度で 2^53 を超える掛け算）偽の傾向が出た。これで先読みが無いことも確かめた。

### 結果

1. **方向の手がかりは無かった。** 15 分足・1 時間足・4 時間足のどれでも、トレンド・モメンタム・RSI・構造・
   上位足などの「方向」の特徴は前半で有意にならなかった。コストの悪い時間帯を除いて探し直しても 0 件、
   モデルの後半の予測力は AUC 0.49〜0.51（当てずっぽうと同じ）。前半だけで見ると AUC 0.55〜0.62 に
   見える — これが「過去のチャートに傾向が見える」正体。#99 の反発条件の実測（35〜46%）とも合う。
2. **時間帯のコストは強く、どこでも再現した。** GMO はニューヨーク終値の日替わり（UTC 21 時／冬 22 時、
   日本時間 6〜7 時ごろ）にスプレッドが開く。USD/JPY の 15 分足の終値で、UTC 21 時台の中央値 12.5 pips、
   22 時台 12.1、23 時台 2.9（ほかの時間は 0.2〜0.4）。
   - その時間に入ったプランの勝率は 15 分足で 1.5〜4.6%、1 時間足で 13〜18%。
   - その前の時間に入ったプランも、持っている間にそこで損切りに掛かる。1 時間足で UTC 19〜20 時に入って
     負けたプランの 23〜31% が 21〜22 時に損切りになっていた。
   - **「UTC 17〜23 時（日本時間 2:00〜8:59）は出さない」を後半期間だけで評価すると、5 ペアすべて・15 分足と
     1 時間足の両方で、残したプランの勝率が 4〜6 ポイント上がった。** USD/JPY: 15 分足 BUY 33.9→38.9%・
     SELL 30.4→35.3%、1 時間足 BUY 36.3→39.8%・SELL 32.2→35.6%。外したプランの勝率は 18〜28%。
   - 4 時間足には効果が無い（損切りが広く、スプレッドの跳ねが届かない）。
3. **それでも損益分岐（40%）には届かない。** 時間帯を選んでも、方向を当てる力が無ければ期待値はほぼ 0 か
   マイナス。アプリの成績は AI の方向判断にかかっていて、チャートの状態の統計はそれを代わりにできない。

### アプリに入れたもの（analyze v67）

- **見送り理由 `costly_hours`**（`analyze/timing.ts`）: 価格を読んだ時刻が UTC 17〜23 時の 15 分足・1 時間足、
  UTC 20〜23 時の 1 分足の BUY/SELL は公開せず WAIT にする。順番は 市場休場 → 確信度 → **時間帯** → 形。
  - **1 分足は勝率を測っていない。** 測ったのはスプレッドそのもの（12.5 pips）で、1 分足の損切り（1.5〜2 pips）
    より広いので、入った時点で損切りに掛かる。30 本の期間で日替わりに届く直前の 1 時間も含めた。画面と
    サーバーの文でもそう書いている。
  - 見送った行に、時刻と検証の数字（`entry_check.costly_hours`）を載せ、画面の見送り理由の横に
    「日本時間 6時台・この時間帯の勝率 24%／ほか 36%」のように出す。
  - **形のゲートを通っていたプランは影（shadow）で追う。** 本番でもこのルールが正しかったかを測れる。
- **アプリ自身の過去のプランへの影響は小さい**: 1 分・15 分・1 時間足で決着済みの 40 件のうち、この時間帯は
  2 件（1 勝 1 敗）。これまでの利用はほとんど日本の日中〜夜で、過去の成績の数字はこのルールでほぼ変わらない。
  効くのは、今後この時間帯に分析したとき。

### 再実行

`.github/workflows/research.yml` を手動実行（入力で通貨ペアと分割日を変えられる）。GMO の日付ファイルは
Actions のキャッシュに残るので、2 回目以降は約 30 秒。数字を更新したら `timing.ts` の `COSTLY_EVIDENCE` を
書き換える（前半で決めたルールを後半で評価した数字だけを載せる）。

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

### 8.19 分析を RSI とパラボリックSAR だけにした（#104、analyze v68）

- **指示**: 「これからのチャート分析はRSI とパラボリックSARで分析してください。他はいりません。」「分析したチャートに画像のbuyとsellを乗せる様に…waitの場合（どこまで上がったり下がったりしたら注文を入れるか）」。#102 で RSI が17ルール中1位、#103 で SAR が「前半も後半も RSI に足してプラスだった唯一の相手」だったことを受けたもの。
- **ルール**（`analyze/rsisar.ts`、研究の `rsi-combos.ts` の bounce + psar と同じ足で出ることをテストで固定）:
  - BUY: RSI(14) が30以下から30を上に戻した確定足で、SAR(0.02, 0.2) が価格の下。
  - SELL: RSI が70以上から70を下に戻した確定足で、SAR が価格の上。
  - エントリー足の**最新の確定足**で出たときだけ BUY/SELL。それ以外は WAIT。
  - プランは現在値で成行、損切り ATR×0.8、利確1はその1.5倍、利確2・3なし。entry.ts の下限（損切り0.6ATR以上、RR1.2以上）を作りから満たす。
- **signal はサーバーが決める。** モデルの答えは `entry_check.model_signal` に残すだけで、signal・損切り・利確は上書きする。チャートの旗と判定が食い違わないようにするため。
- **外したもの**: プロンプトの他の指標・構造・転換・反発条件・ダイバージェンス・学習ルール、構造ゲートと転換ゲート、確信度の下限（60未満でも WAIT にしない。値は記録する）。チャートの測定水準・雲の帯・AI が挙げた水準、サイドの指標表（MACD・BB・一目・ストキャス・ADX）。
  - 構造・転換・ダイバージェンス・#99 の反発条件は**計算と保存は続けている**（`context`）。プロンプトとゲートと画面から外しただけ。
  - 学習ルールは読まない（書かれている指標をもう使わないため）。rulebook は版の記録のために読むだけで、足跡の照会（他人の行の読み出し）もやめた。
- **残したもの**: 市場休止と、#100 の時間帯（15分足・1時間足は UTC 17〜23時、1分足は 20〜23時）の見送り。指標ではなくコストの規則で、研究でもこの時間帯を除いて測っている。
- **WAIT のときの注文の目安**: 次の足の終値がいくらなら条件がそろうかをサーバーが計算する（`closeForRsi` で RSI を30/70にする終値を逆算、`nextSar` で次の足の SAR）。
  - 準備済み（RSI が既に30以下/70以上）: 「次の足が X を上回って（下回って）引けたら」。SAR が逆側なら X は RSI の価格と SAR の大きい方（小さい方）。そのときのプランも出す。
  - 準備前: 「まず終値が Y 以下（以上）で RSI が30を割る（70を超える）必要がある。その後 SAR より上（下）で戻せば」。
  - 次の足の確定が見送りの時間帯なら、その旨を出す。
  - テスト: 準備済みの状態で「X をわずかに超えて引ける足」を足すとルールが発火し、わずかに届かない足では発火しないことを、多数の状態で確認している。
- **チャート**: 各時間足に過去のサインを旗で描き（参照画像のように BUY/SELL のラベルと TP/SL の箱）、SAR を点で、RSI を下の帯で描く。箱は新しい順に3つまで、重なる箱は描かない。旗の勝敗は仲値で判定（スプレッド抜き）。
- **検証の数字**（`RSI_SAR_EVIDENCE`、#103 の後半 2025-07〜2026-09・11ペア・スプレッド込み）:

| 時間足 | 勝率（損切り0.8ATR・利確1.5倍） | 当たり（ATR1本分先に届いた方） |
|---|---|---|
| 15分足 | 35.0%（885回） | 46.2% |
| 1時間足 | 34.0%（247回） | 44.0% |
| 4時間足 | 42.1%（107回） | 49.5% |
| 合計 | 35.4%（1,239回） | 46.0% |
| 毎回入った場合 | 35.0% | 44.8% |

  損益ゼロは勝率40%・当たり50%。**このルールは損益ゼロに届いていない**。画面にもそう出す。1分足と日足は測っていない。
- **リプレイ用の文面は変えていない**: `locale.ts` の userMessage と horizonDeclared は noise-floor の読み取り器がバイト単位で写しているので、そのまま。新しい指示はシステムプロンプトに書いた（手順を6つにして「手順1-6」の文に合わせた）。学習ルールの見出しが無いので、v68 以降の行は noise-floor の対象外（新しい時代）。
- バンドルは 132KB → 117KB に減った（古いプロンプトと補助関数を消したため）。デプロイは Actions の CLI 経路なので問題なし。
- 保有中評価（`position-review`）のプロンプトは変えていない。エントリーの判断ではなく、持っているポジションの扱いの評価のため。

### 8.20 RSI＋SAR の売買サインをメールで知らせる（#105、signal-alerts v1）

- **指示**: 「buyかsellのタイミングがきたらメールで知らせてほしいです。」
- **仕組み**: pg_cron `signal-alerts-sweep`（毎時 2・17・32・47 分、他の定期処理と分をずらした）→ `signal-alerts` 関数（sweep token で認証）。
  - 登録されているペア×時間足だけを読む。1時間足以上は毎時の最初の20分の回だけ（足が正時に確定するため）。
  - 足は GMO コインの公開 bid/ask の中値（キー不要・回数制限なし）。フォーミング中の足を除いた確定足 200 本に `readRsiSar` をそのまま当てる（ルールは #104 と同じ関数）。
  - 足の確定から20分以内（`FRESH_MS`）のサインだけを送る。15分足は直前の足も窓に入るので、1回失敗しても次の回で拾う。二重送信は `signal_alerts` の一意キー（利用者・種類・ペア・足・足の時刻・売買）で防ぐ。挿入できた回だけが送る。
  - 15分足・1時間足で UTC 17〜23時（日本時間 2:00〜8:59）に確定したサインは、アプリが WAIT にする時間帯なので**メールせず** `skipped / costly_hours` として記録する。市場が閉まっている可能性がある時間（`isPossiblyClosed`）は回ごと休む。
  - メールの中身: ペア・時間足・売買・確定時刻（日本時間）・RSI の前→今・SAR・目安のエントリー/損切り/利確（0.8ATR / 1.5倍）・その時間足の検証勝率と損益ゼロの40%に届いていないこと・価格の出どころ・アプリへのリンク・停止方法・投資助言ではない旨。日足は「検証していない」と書く。
- **アプリとずれる可能性**: アプリの分析は 15分足・4時間足・日足を Twelve Data から読む（共有キーが毎分8回までなので、15分ごとの巡回には使えない）。価格の配信元が違うので、まれにサインの有無や数値がずれる。メールと設定画面にそう書いた。
- **誰が使えるか**: Pro と管理者（料金表で「アラート通知」は Pro の項目）。登録と解除は関数経由だけ（テーブルは本人の行の SELECT だけを許可）。プランが切れても登録は残るが送らない。解除はプランに関係なくできる。
- **時間足**: 15分・1時間・4時間・日足。1分足は測っていないうえ、通知が多すぎて読まれなくなるので外した。ペアはアプリの7ペア。
- **設定画面**: 設定 → メール通知。ペア×時間足のチェック、テストメール（5分に1回）、最近の通知20件（送信済み・失敗・未送信（送信設定なし）・時間帯で見送り）。
- **メール送信は Resend**。関数のシークレット `RESEND_API_KEY` が無い間は、サインを検出して `not_configured` で記録するだけで**メールは出ない**（画面にもそう出す）。
  - 送信元は `Sextant <alerts@fx-tactical.jp>`（v2、2026-09-25 から）。fx-tactical.jp を Resend で認証済み（お名前.com の DNS に `resend._domainkey` TXT・`send` と `rsend` の CNAME・`_dmarc` TXT `v=DMARC1; p=none;` を追加）。これでどのアドレスにも届く。
    - v1 は Resend 共用の `onboarding@resend.dev` から送っていた。この送信元は Resend アカウントを作ったアドレスにしか届かないため、v1 の間はお客様に届かず、料金表の「アラート通知（予定）」も外していなかった。v2 で「売買サインのメール通知」に変えた。
    - 受信（Enable Receiving）は使っていない。`alerts@fx-tactical.jp` 宛ての返信はどこにも届かない。
    - 関数に `ALERT_FROM` を設定すれば送信元を上書きできる。
  - プロバイダのエラー文にメールアドレスが含まれる場合（上の制限のエラーは Resend アカウントの持ち主のアドレスを含む）、記録する前に `[email]` に置き換える。
- **確認のしかた**:

```sql
-- 直近の巡回の結果（reads に各チャートの最新確定足・RSI・サイン、signals / sent / not_configured など）
select id, status_code, left(content::text, 2000) from net._http_response
where content::text like '%signal-alerts-v%' order by id desc limit 3;

-- 送った/送れなかった通知
select created_at, kind, pair, interval, side, closed_at, status, skip_reason, error
from public.signal_alerts order by created_at desc limit 20;
```

### 8.21 GainzAlgo 風の「大きく動いたあとの反転足」と、RSI＋SAR の利確2倍を測った（#106、研究のみ）

- **指示**: GainzAlgo V2 Alpha の動画（金・15分足）を見て「タイミングをどうやって決めてると思う？」→「やってみて」。アプリの挙動は変えていない。
- **動画から読めたこと**: TP/SL の表示から逆算すると、どのサインも利確幅が損切り幅のちょうど2倍（1:2）で、損切り幅は 1.6〜3.0 と相場の荒さで変わる。SELL は急騰後の天井、BUY は急落後の底に出ている。中身は非公開なので、ここから先は推測。
- **測ったもの**（`research/reversal.ts`・`research/gainz.ts`、`gainz.yml` で実行。ルールはデータを見る前に固定）:
  - 反転足の読み方3通り（どれも「前の足の安値を割る陰線で確定」＝売り、その鏡像＝買い）: 直近3本で20本高値 / 直前3本で RSI≥70 / 直近3本の高値が20本平均から2ATR以上。
  - 出口3通り: アプリ（損切り0.8ATR・利確1.5倍、損益ゼロ勝率40%）、0.8ATR・2倍、1.0ATR・2倍（損益ゼロ33.3%）。48本で決着しなければその時点の成行。
  - 物差しは期待値（R＝損切り幅、スプレッド込み）。同じペア・時間足・売買・時刻に毎本入った場合（ブラインド）との差も出す。
  - 読み方は前半（〜2025-06）の15分足・1.0ATR・2倍で選び（`rev_rsi70` が1位）、後半（2025-07〜2026-09）で確かめた。11ペア、15分足は UTC 17〜23時を除く。
- **結果（後半、選ぶのに使っていない期間）**:

| ルール | 時間足・出口 | 件数 | 勝率 | 期待値 | ブラインドとの差 |
|---|---|---|---|---|---|
| 反転足（RSI 70/30、前半1位） | 15分・1.0ATR・2倍 | 8,638 | 29.4%（損益ゼロ33.3%） | −0.113R | +0.012R（誤差の範囲） |
| 同上、ペア別 | 全時間足 | — | — | 11ペア中 **0** でプラス | — |
| RSI＋SAR（今のアプリ） | 全時間足・アプリの出口 | 1,255 | 35.0%（損益ゼロ40%） | −0.125R | +0.008R |
| RSI＋SAR | 全時間足・0.8ATR・2倍 | 1,255 | 29.2% | −0.122R | +0.010R |
| RSI＋SAR | 全時間足・1.0ATR・2倍 | 1,255 | 30.3% | −0.087R | +0.026R |

  - 他の反転足の読み方（20本高値・2ATR）も15分足で −0.12〜−0.14R、ブラインドと同じ。
  - RSI＋SAR の利確2倍は、後半では少し良く見える（1.0ATR・2倍で −0.087R）が、前半では逆に悪かった（アプリ −0.077R に対して −0.142R）。一貫した改善ではないので、出口は変えない。
  - 4時間足は後半だけプラスに見える行がある（RSI＋SAR 1.0ATR・2倍 +0.150R、n=107）が、前半は大きくマイナス（−0.427R）で、幅も ±0.4R 以上。偶然の範囲。
  - どのルールも「毎本入る」とほぼ同じで、タイミングの力は見つからなかった。15分足ではスプレッドだけで1回あたり約 −0.13R 失う（4時間足は約 −0.06R）。
- **言えること・言えないこと**: GainzAlgo の本当の中身は非公開なので、「GainzAlgo が効かない」とは言えない。言えるのは「動画から読める『大きく動いたあとの反転足・利確2倍』を FX 11ペアで試すと、ランダムに入るのと変わらず、スプレッドの分だけ負ける」まで。動画は金で、GMO に金は無いので試していない。

### 8.22 報告されている GainzAlgo V2 [Alpha] の条件をそのまま再現して測った（#107、研究のみ）

- **指示**: GainzAlgo Suite の仕組みを調べたあと「やってみて」。アプリの挙動は変えていない。
- **再現した条件**（`research/reversal.ts` GAINZ。第三者の解説が V2 [Alpha] のスクリプトについて報告しているもの。公式の発表ではない）: 買いは ①包み足（前の足が陰線、今の足が陽線でその始値より上で確定）②実体が大きい ③RSI(14) が一定未満 ④終値が10本前より安い、がすべてそろった確定足。売りはその鏡像。
  - 報告の数字が資料によって違うので、データを見る前に3通りに固定した: `gz_atr80`（実体 ≥ 0.7ATR・RSI<80）、`gz_range80`（実体 ≥ 足の高安の0.7・RSI<80）、`gz_atr50`（実体 ≥ 0.7ATR・RSI<50）。
  - 出口と物差しは §8.21 と同じ（1.0ATR・利確2倍が主。15分足で前半に1つ選び、後半で確かめる）。
- **結果（後半 2025-07〜2026-09、15分足・1.0ATR・利確2倍）**:

| 読み方 | 件数 | 勝率（損益ゼロ33.3%） | 期待値 | ブラインドとの差 |
|---|---|---|---|---|
| gz_atr50（前半1位） | 6,903 | 28.9% | −0.129R | −0.001R |
| gz_atr80（数字付きで報告されている読み方） | 9,583 | 29.4% | −0.113R | +0.015R |
| gz_range80（前半は最下位） | 7,958 | 30.2% | −0.090R | +0.037R |

  - 前半1位の gz_atr50 は、11ペア中 **0** でプラス。
  - gz_range80 は後半だけ良く見えるが、前半は3つの中で最下位で、期待値もマイナス。後から選べば結果を見て選んだことになる。
  - 1時間足の gz_atr50 は前半 +0.040R（ブラインド比 +0.108R）だったが、後半は −0.098R で続かなかった。4時間足は後半 −0.03〜0.00R で、幅が ±0.15R 以上。
  - アプリの出口（0.8ATR・1.5倍）でも、後半15分足の勝率は 34.3%（損益ゼロ40%）、期待値 −0.142R。
  - 15分足で1ペアあたり1日2〜3回ほど出る（除外時間帯を除く）。
- **結論**: 報告されている V2 [Alpha] の条件は、FX 11ペアではランダムに入るのと変わらず、スプレッドの分だけ負けた。公式の「勝率75%超」に近い数字はどの読み方・時間足・出口でも出ていない（1:2 なら勝率は29〜30%）。
- **言えないこと**: 再現したのは第三者が報告した条件で、今売られている Suite と同じとは限らない（Suite には5つのモデルがあり、細かい条件や初期値は非公開）。金は試していない。

### 8.23 通知したサインの実際の成績を自動で記録する（#108、signal-alerts v3）

- **指示**: 「作って」（「届いた通知ごとに、その後の値動きで利確・損切りのどちらに先に届いたかを記録し、数か月分の実際の勝率と期待値を画面に出す」という提案に対して）。過去データ（§8.21: 勝率35%・−0.125R）の主張を、主張した時点では誰も見ていなかった値動きで確かめるためのもの。
- **何を記録するか**: `signal_events`。アプリの7ペア×4時間足（15分・1時間・4時間・日足）で出た RSI＋SAR のサインを、**誰かが通知を登録しているかに関係なく**全部記録する。1ペアだけ（月7回ほど）だと何年もかかるが、7ペアなら月50回ほど集まる。15分足・1時間足の UTC 17〜23時のサインも `costly = true` で記録し、画面の集計からは分ける。
- **決着のさせ方**（`signal-alerts/record.ts`、実データを見る前に固定）:
  - 入り: サインの足の終値。買いは ask、売りは bid（メールが届くのは数分後なので、これより良い値では入れない）。
  - 損切り・利確: メールに書いた値（仲値から 0.8ATR と その1.5倍）。買いは bid、売りは ask で判定。損切りを越えて始まった足はその始値で決済、利確を越えて始まった足は利確の値だけを認める。
  - 同じ足で両方に届いたら負け（ambiguous）。48本で決着しなければその足の終値で決済（expired）。
  - R = 損益 ÷ 計画の損切り幅（仲値の入り〜損切り）。きれいな勝ちが約 +1.49R、負けが約 −1.01R になるのはスプレッドの分。
- **いつ動くか**: 既存の巡回（毎時 2・17・32・47 分）の中。15分足は毎回、1時間足以上は毎時 :02 と :17 に全7ペアを読み、新しいサインを記録し、未決着のサインをその足で決着させる。追加の取得は無い（決着に必要な足は、検出のために取った直近200本の中にある）。
- **画面**: 設定 → メール通知 に「通知の成績」。「あなたに届いた通知」（`signal_alerts.status = sent` のもの）と「全7ペアのサイン（メールする時間帯のもの）」の回数・勝ち/負け/期限切れ・勝率・1回あたり平均R（10回以上で誤差の幅）、過去データでの見込み。30回未満は「まだ判断しないで」と出す。最近の通知の各行にも結果（勝ち +1.49R / 決着待ち など）を出す。
- **確認のしかた**:

```sql
-- 記録と決着の状況
select interval, costly, outcome, count(*), round(avg(r)::numeric, 3) as mean_r
from public.signal_events group by 1, 2, 3 order by 1, 2, 3;

-- 直近の巡回で記録・決着した数（recorded / settled / open）
select id, left(content::text, 400) from net._http_response
where content::text like '%signal-alerts-v3%' order by id desc limit 3;
```

### 8.24 長い期間のトレンドとスワップ、SAR で利を伸ばす出口を測り、4時間足中心にした（#109〜#111）

- **指示**: 「勝てる様にするにはどうしたらいいと思う？アプリの仕様」への提案（①アプリを4時間足・日足中心にし、数量の目安を出す ②トレンドフォロー・スワップ・SAR で利を伸ばす出口を測る ③採用のルールを書いておく）に「全部実装お願いします」。数量の目安は「設定は増やさない」（利用者の選択）ので、資金や許容リスクは入力させず、1万通貨あたりの損失だけを出す。

**#109 25年分の日足でトレンドフォローとスワップ（研究のみ）** — `research/longhist.ts`・`longhist-lib.ts`、`longhist.yml` で実行。

- データ: ECB の日次参照レート（1999-01-04〜）を GMO の11ペアに換算（1日1本）。金利は FRED の OECD 3か月金利（月次）を1か月遅れで使う。FRED に GitHub から届かないときは、8通貨すべて BIS の政策金利（月次）に切り替える（混ぜない。どちらを使ったかはログの先頭に出る）。
- 方法（データを見る前に固定）: 12か月モメンタム（`tsmom252`）・200日線・50/200日線・55/20日ブレイクアウトを、各ペア年率10%の値動きに揃え、1pip のスプレッド込みで、11ペア均等のポートフォリオで測る。ルールは 1999〜2012 の Sharpe で1つ選び、2013〜 で確かめる。偶然の幅はランダムな売買（約60日ごとに向きが変わる）20通り。
- **結果（スワップ無し）**:

| ルール | 1999〜2012 の Sharpe | 2013〜 の Sharpe | 2013〜 の年率・最大下落 |
|---|---|---|---|
| 12か月モメンタム（前半1位） | 0.18 | **0.20** | +1.2%（ポートフォリオの値動き 6.0%）・−18.0%、14年中7年プラス |
| 200日線 | 0.11 | 0.09 | +0.6% |
| 50/200日線 | 0.10 | 0.04 | +0.2% |
| 55/20日ブレイクアウト | 0.06 | −0.10 | −0.5% |
| ランダム20通り | 中央値 0.07・上位5% 0.54 | 中央値 0.01・上位5% **0.69** | — |

  - 前半1位の12か月モメンタムは後半もプラスだったが、Sharpe 0.20 はランダムの上位5%（0.69）より下で、偶然の範囲を出ない。後半にプラスだったのは11ペア中7ペア。
- **スワップ込み・キャリー**（2026-09-25 の実行。FRED は GitHub から取れず（1回目は HTTP/2 のエラー、2回目は15分以上応答が無く止めた、3回目も60秒応答なし）、**BIS の政策金利**で測った。GMO が実際に払うスワップとは違い、差し引く −0.5%/年も仮の値）:

| 戦略 | 1999〜2012 の Sharpe | 2013〜 の Sharpe | 2013〜 の年率・最大下落 |
|---|---|---|---|
| キャリー（金利の高い通貨を買い続ける。選ぶものは無い） | 0.45 | **0.35** | +1.6%（値動き 4.6%）・−11.0%、14年中9年プラス |
| キャリー＋トレンド（200日線と向きが合うときだけ） | 0.50 | 0.24 | +1.0%・−9.5% |
| 12か月モメンタム＋スワップ | 0.49 | 0.06 | +0.4%・−18.1% |
| 200日線＋スワップ | 0.40 | 0.05 | +0.3% |

  - 両方の期間でプラスだったのはキャリーだけ。ただし後半の Sharpe 0.35 もランダムの上位5%（0.69、スワップ無しで測った幅）より下で、偶然の範囲を出ない。
  - キャリーは急な巻き戻しに弱い: 2008年10月の1か月で −8.8%（年率1.6〜2.7% の約3〜5年分）、2024年8月は −1.5%。トレンドを組み合わせると 2008-10 は −0.1%、2024-08 は −0.5%。
  - トレンドにスワップを足すと前半は良く見えるが（0.18 → 0.49）、後半はかえって下がった（0.20 → 0.06）。
  - どれも数か月〜年単位で持ち続けるもので、アプリの売買サイン（数時間〜数日）とは別物。アプリには入れていない。

**#110 SAR で利を伸ばす出口（研究のみ）** — `research/exits.ts`・`exits-lib.ts`、`exits.yml` で実行。

- 方法: GMO の15分足（2024-01〜）を1時間・4時間・日足にまとめ、入り（アプリの RSI＋SAR / SAR の反転）× 出口（固定: 損切り0.8ATR・利確1.5倍 / SAR で追いかける / 3ATR のシャンデリア）を ATR 単位の期待値で比べる（スプレッド込み、最長500本、データの終わりで未決着の取引は最後の値で評価）。出口はアプリの入り・4時間足の前半（〜2025-06）で選び、後半（2025-07〜）で確かめる。物差しは同じ出口で毎本入った場合（ブラインド）との差。
- **結果（アプリの入り・4時間足）**:

| 出口 | 前半 n=116: 期待値・ブラインドとの差 | 後半 n=107: 期待値・ブラインドとの差 [95%の幅] |
|---|---|---|
| SAR で追いかける（前半1位） | −0.193・−0.055 | +0.540・**+0.541 [−0.191〜+1.274]** |
| 固定（今のアプリ） | −0.283・−0.233 | +0.041・+0.081 |
| シャンデリア | −0.492・−0.294（前半は最下位） | +0.981・+1.216 [+0.102〜+2.330] |

  - 前半1位の SAR は、前半はマイナス、後半はプラスで、向きが期間で入れ替わった。後半の幅はゼロをまたぐ（後半は11ペア中10ペアでプラスだが、1ペア5〜15件）。
  - シャンデリアは後半だけ幅がゼロを上回ったが、前半は3つの中で最下位。結果を見てから選ぶことになるので採らない。
  - 1時間足では、どの出口でもアプリの入りはブラインド以下（後半 −0.05〜−0.13）。日足はアプリの入りが前半21件・後半3〜5件しかなく判断できない。
- **結論**: 一貫した改善は無い。出口は変えない。

**#111 アプリの変更**（signal-alerts v4）

- 分析の既定の時間足を1時間足から**4時間足**に。
- 時間足の選択の下に「スプレッドだけで失う損切り幅の割合」を出す（`src/lib/costs.ts`。§8.21 の研究で、アプリの出口で毎本入った場合の両期間の平均: 15分 約14%・1時間 約8%・4時間 約6%。1分足・日足は測っていないので割合は出さない）。15分足・1時間足では「4時間足・日足の方が負担は小さい」と添える。
- 分析結果の損切りの下と、通知メールの損切りの行に「1万通貨で損切りなら ¥X の損失」（円のペアは円、ドルのペアはドル。換算はしない）。
- 通知の注意書きの先頭に15分足の負担。所有者の USD/JPY 15分足の通知登録（最初に作ったもの）は外した。設定画面でいつでも付け直せる。

**採用のルール（これから売買のルールを変えるときはすべてこれに従う）**

1. データを見る前に候補とルールを固定し、前半で1つ選ぶ。選んだものが、選ぶのに使っていない後半でも、ブラインド（またはランダム）との差の95%の幅がゼロを上回ること。前半で負けたものを後半の結果で拾わない。
2. 1を満たしても、§8.23 の実際の記録（通知したサインのその後の値動き）が30回以上たまった時点で、過去の見込みと矛盾しないことを確かめてから入れる。
3. 画面・メールに出す数字は測ったものだけ。測っていないものは「未測定」と書くか、出さない。
4. 同じデータで条件を足したり数字を合わせ込んだりしない（試すほど偶然の当たりが混ざる）。試したものは、負けたものも含めてこの文書に残す。

  - #106・#107・#109・#110 はどれも1を満たさなかったので、売買のルール（RSI＋SAR・損切り0.8ATR・利確1.5倍）は変えていない。

### 8.25 GainzAlgo V2 Alpha 型のサイン（GA型）を RSI＋SAR と並べて追加した（#112、analyze v69・signal-alerts v5）

- **指示**: GainzAlgo Suite（V2 Alpha が有効）の画面のスクリーンショットに「同じこれを導入してほしい」。RSI＋SAR を置き換えるか聞いたところ「並べて追加」。**採用のルール（§8.24）を満たしたからではなく、利用者の指示で追加した**。アプリの売買判定（BUY/SELL/WAIT とプラン）は RSI＋SAR のまま。
- **ルール**（`supabase/functions/analyze/gainz.ts`。研究・分析・通知が同じ関数を使う）: 買いは確定足で ①包み足（前の足が陰線、今の足が陽線でその始値より上で確定）②実体が真の値幅の半分超 ③RSI(14) 50未満 ④終値が5本前より安い。売りはその逆。損切り ATR(14)×1、利確はその2倍、48本で決着。
  - 数字の出どころ: 画面の「(huge, text bubble, 0.5, 50, 5, 1:2, 1, 3)」を、公開されている V2 Alpha の入力（ラベルの大きさ・形・Candle Stability Index・RSI Index・Candle Delta Length・リスクリワード・TP & SL の倍率）の順に読んだもの。最後の「3」は不明。損切り1ATR は、画面の2つの TP/SL を 1:2 で逆算した損切り幅（5.83・3.17）が足の高安ではなく値動きの大きさに沿っていることからの読みで、GainzAlgo の説明ではない。
- **検証**（`research/gainz.ts` の #112 の部分、11ペア・スプレッド込み。設定はデータで選んでいないので両期間を出す）:

| 期間 | 件数 | 勝率（損益ゼロ33.3%） | 1回あたり | 毎本入った場合 | 差 [95%] |
|---|---|---|---|---|---|
| 前半 2024-01〜2025-06 | 12,880 | 30.4% | −0.086R | −0.097R | +0.011R |
| 後半 2025-07〜 | 10,757 | 28.8% | −0.134R | −0.118R | −0.015R [−0.047, +0.016] |

  - 後半の時間足別: 15分 28.2%・−0.150R（8,317件）、1時間 30.6%・−0.080R（1,791件）、4時間 30.7%・−0.080R（649件）。後半は11ペア中 **0** でプラス。
  - つまり #107 と同じく、ランダムに入るのと変わらず、スプレッドの分だけ負ける。この数字はそのまま画面とメールに出している。
- **アプリの変更**:
  - 分析: `technicalData.gainz`（最新の確定足でサインが出たか・そのときのプラン・チャート内の回数・検証の数字）を「GA型サイン」のカードに表示。チャートには枠だけの「GA BUY / GA SELL」の印（RSI＋SAR の塗りつぶしの印とは別）。
  - 通知: 設定 → メール通知 に「RSI＋SAR / GA型」の切り替え。GA型はチャートごとに別に登録（`signal_alert_subscriptions.rule`）。メールの件名は「…のサイン（GA型）」。15分足・1時間足の UTC 17〜23時は RSI＋SAR と同じくメールしない。
  - 記録: `signal_events` に `rule = gainz_v2a_050_50_5_atr1_v1` で全7ペア×4時間足を記録・決着（§8.23 と同じやり方）。設定画面の成績はルールごと。
- **マイグレーション**: `20260925180000_signal_alert_rules.sql`（`rule` 列とルール込みの一意キーを追加。先に適用し、古い関数もそのまま動く）→ 関数を v5 に更新 → `20260925181000_signal_alert_rules_drop_old_keys.sql`（ルールを含まない古い一意キーを削除）。
- **確認のしかた**:

```sql
select rule, interval, outcome, count(*), round(avg(r)::numeric, 3) as mean_r
from public.signal_events group by 1, 2, 3 order by 1, 2, 3;

select rule, count(*) from public.signal_alert_subscriptions group by 1;
```

### 8.26 リアルタイムチャート（5通貨ペア）を追加した（#113、live-chart v1）

- **指示**: 「リアルタイムのチャートを表示するようにできる？5パターンぐらいでいい」。何の5つか・作り方を聞いたところ「通貨ペア5つ」「アプリ独自のチャート」（TradingView の埋め込みではなく、アプリのサインを描けるもの）。
- **画面**: メイン画面の操作バーの下に「リアルタイムチャート」。USD/JPY・EUR/USD・GBP/USD・EUR/JPY・GBP/JPY のタブ（各タブに今の価格）と、1分・15分・1時間・4時間・日足の切り替え（最初は分析で選んでいる時間足）。売値・買値・スプレッド、RSI＋SAR と GA型のサイン（最新の確定足）、次の足の確定までの残り時間を出す。ログイン中のみ。
- **仕組み**（`supabase/functions/live-chart/`）:
  - `bars`: GMO の買値・売値の足を確定足200本＋形成中の足まで読み、RSI＋SAR と GA型を分析・通知と同じ関数で判定し、直近120本と印を返す。画面は足が確定した4秒後に読み直す（同じ足の読みは関数内で20秒使い回す）。
  - `ticker`: GMO の ticker を1回読み、5ペアの買値・売値を返す（2秒使い回す）。画面は5秒ごと（タブが裏にある間は止める）に読み、形成中の足の終値・高値・安値だけを動かす。
  - サインは確定足だけで判定するので、形成中の足が動いても印は変わらない。新しい足が確定して読み直したときに新しいサインがあれば「新しいサイン: …」と出す。
- **GMO のメンテナンス（v2、2026-09-26）**: 公開の翌朝（土曜 9:49 JST）に「チャートを読み込めませんでした」。関数のログは ticker・bars とも 502、GMO の公開 API は全呼び出しに `{"status":5,"messages":[{"message_code":"ERR-5201","message_string":"MAINTENANCE. Please wait for a while"}]}` を返していた（データベースの pg_net から確認）。関数はこれを `maintenance`（503）として返し、画面は「メンテナンス中」と出して1分ごとに確認する。あわせて、形成中の足が無いとき（市場休止中）とエラーのときは1分おきに読み直す（v1 は足の確定時刻が過去だと5秒ごとに読み直していた）。
- **GMO が読めない間の代わり（v3、2026-09-26）**: 利用者の「必要」（メンテナンス中でも前回の相場が閉じた時点までのチャートを出す提案に対して）。GMO から足が1本も取れないとき、Twelve Data（分析と同じ配信、同じキー）の直近260本を表示する。キーは1分に8回までを分析と共有しているので、取った足は `public.live_chart_fallback`（ペア×時間足で1行、関数だけが読み書き）に保存し、同じチャートは30分に1回までしか取り直さない。さらに1つのインスタンスで1分に3回まで。取れないときは保存済みの古い足、それも無ければメンテナンスの表示。画面には「別の配信（Twelve Data）の直近の足を表示しています（取得時刻）。価格は動きません」と、市場が閉じている間は再開予定時刻（`nextOpen`、日本時間の月曜 7:00）を出す。GMO が戻ると次の読み直し（1分ごと）で自動で GMO の足に切り替わる。
- **サインの成績は §8.23（RSI＋SAR）・§8.25（GA型）のとおりで、どちらも過去の検証では損益ゼロに届いていない**。チャートは見やすくするためのもので、勝てる根拠を足したものではない。


### 8.27 リアルタイムチャートを GainzAlgo の見た目に寄せ、GA型・1時間足をおすすめ設定にした（#114）

- **指示**: GainzAlgo Suite のスクリーンショットに「リアルタイムでこれをチャートに実装して。分析の仕方は任せます。最善なものを選んで。で、buyとsellのタイミングにメールを送る」。
- **選んだもの: GA型（§8.25）・1時間足**。理由と限界:
  - GA型の3つの時間足で、ランダムに毎本入った場合との差（スプレッド込み）は 15分 +0.006R / −0.020R、**1時間 +0.068R / +0.006R**、4時間 −0.086R / −0.012R（前半 / 後半）。両期間ともプラスだったのは1時間足だけ。
  - ただし差はどれも誤差の範囲（1時間足の後半は [−0.068, +0.080]）で、損益そのものはスプレッドを払うと −0.003R / −0.080R。**勝てる根拠ではない**。
  - 他のルールにも両期間でわずかにプラスのもの（研究で測った SAR の反転での入り、#110）があり、結果を見てから選ぶこと自体が偶然の当たりを選ぶ危険を含む（§8.24 のルール4）。GainzAlgo の見た目を求められているので GA型の中から選び、本当の検証は実際の記録（§8.23）に任せる。
- **画面**（`LiveChart`）: 最初は「GA型（おすすめ）」表示・1時間足。GA型のサインだけを GainzAlgo のように塗りつぶしの BUY/SELL ラベルと TP/SL の枠で描き、RSI の帯と SAR の点は出さない。「RSI＋SAR」「両方」に切り替えられる（両方のときは GA型は枠だけの「GA BUY/SELL」）。チャートの下に最新のサイン（向き・確定時刻・エントリー/TP/SL・結果）。
- **メール**: 所有者（k.munemoto@kyoto-salute.com）に GA型・1時間足の通知を5ペア（USD/JPY・EUR/USD・GBP/USD・EUR/JPY・GBP/JPY）登録した（`signal_alert_subscriptions.rule = 'gainz'`）。1時間足の確定から約2分後（巡回は毎時 :02）に届く。日本時間 2:00〜8:59 に確定したサインはメールしない（記録は残る）。以前からの RSI＋SAR の登録（USD/JPY 1時間・4時間・日足）はそのまま。

### 8.28 リアルタイムチャートに「Pro Scalper」風の描画を足した（#115）

- **指示**: ProfitPro の「Pro Scalper」インジケーターの動画に「添付間違えた、これです やってほしい機能」。
- **動画に映っていたもの**: BUY/SELL のラベル、サインごとの建玉の箱（緑=エントリー〜利確、赤=エントリー〜損切り、右へ伸びる）、利確したところの × と「TP」、エントリーからの破線、サインの足の薄い縦線、価格の上下の赤と緑の帯（雲）。
- **足したもの**（`PriceChart` の `positions`・`sarStyle`、`LiveChart` で有効。分析画面のチャートは変えていない）:
  - **建玉の箱**: 新しい方から8つのサインについて、サインの足から決着した足まで（決着していなければ最新の足まで、48本で決着しなければ48本目まで）。緑=エントリー〜利確、赤=エントリー〜損切り、灰色の線=エントリー。判定中の箱は少し濃い。
  - **破線と ×**: エントリーから決着したところ（利確・損切り、同じ足で両方に触れたときは損切り側、48本で決着しなければその足の終値）へ破線、そこに ×（TP=利確・SL=損切り・期限=48本で決着せず）。判定中は × を出さず、破線を今の価格まで引く。
  - **縦線**: サインの足に薄い縦線（BUY 緑・SELL 赤）。
  - **帯**: パラボリックSAR から価格と反対側へ ATR(14)×1 の幅の帯（緑=SAR が価格の下、赤=価格の上）。GA型の表示では SAR の点の代わりに帯だけ、RSI＋SAR・両方の表示では点と帯。GA型の判定には使っていない（凡例にもそう書いた）。
  - これまでの点線の損切り・利確の線は、箱が同じ水準を描くので箱を出すチャートでは出さない。
- **Pro Scalper と違うところ**: 公開の説明では、売買は Kalman フィルターで調整した Supertrend の反転、帯は出来高加重移動平均（VWMA）のバンドで、利確の × は買われ過ぎ・売られ過ぎと高値・安値の更新で何度も付く。中身は非公開（招待制）で、GMO の足には出来高が無いので VWMA は作れない。ここでは見た目と機能（建玉の箱・決着の ×・流れの帯）を揃え、サインは GA型（§8.25・§8.27、1時間足がおすすめ）のまま変えていない。× はサインの決着（利確2倍・損切り ATR×1）の1つだけ。
- **正直な注意**: 動画の「天井と底でぴったり BUY/SELL」は販売側の見せ方で、Pro Scalper には「サインを後から描き直す（back print）」という利用者の苦情がある。このアプリのサインは確定足だけで判定し、後から消えたり動いたりしない。箱は負けたサインも同じように描く。GA型の成績はスプレッド込みで 1時間足 −0.003R / −0.080R（前半 / 後半、§8.27）で、勝てる根拠ではない。
- **チャートのラベルの重なりを直した**（分析画面のチャートにも効く）: ラベルが左右の端で切れないように、同じ高さに重なるラベルは1段ずらす（端に押し付けられた2つの SELL が重なっていた）。TP/SL の数字の枠はラベルに重なる位置には置かず、ラベルの横に置けるときは横に置く。

### 8.29 チャートの全画面表示と拡大・縮小・移動（#116）

- **指示**: 「チャートを画面いっぱいに出して、拡大できたり、収縮できたりできる機能追加して」。
- **対象**: `PriceChart` を使う3つのチャートすべて（リアルタイムチャート・分析結果・結果の詳細）。`interactive={false}` で外せる。
- **全画面**: チャートの右上の全画面ボタンで開く。
  - ページの上にかぶせる層として `<body>` に描く。カードの `backdrop-filter`（glass）の中では `position: fixed` がカードに固定されてしまうため。
  - ブラウザの全画面（Fullscreen API）も要求する。PC と Android では画面全体、iPhone の Safari は要素の全画面に対応していないので層だけ。
  - ✕ か Esc で閉じる。ブラウザの全画面が終わった（Esc・戻る操作）ときも閉じる。開いている間は後ろのページをスクロールさせない。
  - 価格のチャートと RSI の帯が画面の高さに合わせて伸び、価格の目盛りも高さに応じて増える（70px ごと、4〜10本）。
  - リアルタイムチャートは、全画面の中でもペア・時間足・表示（GA型/RSI＋SAR/両方）のタブと売値・買値を出す（1行で横にスクロール）。切り替えて読み込む間も全画面は閉じない（読み込み中はその旨を表示）。
- **拡大・縮小・移動**（`src/lib/chartView.ts`）:
  - 表示は「右端から何本ずらして、何本見せるか」。ずらしていなければ新しい足が来るたびに最新の足を追う。
  - ＋/− ボタンは右端（最新の足）を軸に 1.5 倍ずつ。ピンチとホイールは指・カーソルの下の足を動かさずに拡大縮小。
  - ホイールは全画面では普通に回すだけ、ページ上では Ctrl を押しながら（トラックパッドのピンチもこれ）。普通のホイールはページのスクロールのまま。
  - 拡大しているときは、左右のドラッグ（1本指・マウス）で過去へ移動。
  - ページ上のチャートは上下のスワイプでページがスクロールする（`touch-action: pan-y`）。全画面ではすべての操作がチャート。
  - ↺ ボタンか、PC ではダブルクリックで全体に戻る（スマホのダブルタップは試していない）。タッチ画面ではタップでその足の四本値を表示。
  - 最小は15本。最大は受け取った足すべて（リアルタイムチャートは確定足120本と形成中の1本）。それより過去へは縮小できない。過去を増やすには GMO から読む本数を増やす必要があり、アラートと同じ200本の窓で判定しているサインと一致させる工夫がいるので、今回はしていない。
  - 価格の目盛りは表示中の足（と SAR、エントリー・損切り・利確の線）に合わせる。
  - 別のペア・時間足に切り替えると、同じ拡大率のまま最新の足に戻る（分析結果の時間足タブも同じ）。
- **確かめたこと**: Chromium（Playwright）で PC とスマホ（タッチ）の両方を試した。
  - PC: Ctrl＋ホイールで 121→84 本、ドラッグで過去へ、全画面（ブラウザの全画面も入る）、全画面での普通のホイール、全画面のままペア切り替え、Esc で両方閉じる。
  - スマホ: ピンチで 121→40 本、1本指ドラッグ、縦向き・横向きの全画面。
  - 素早いスワイプの直後のタップは、ブラウザがスワイプを止めるのに使うので効かない（どのページでも同じブラウザの動き）。

### 8.30 チャートにストキャスティクスを追加した（#117）

- **指示**: TradingView のヘルプ記事 `https://jp.tradingview.com/support/solutions/43000502332/` に「これをチャートに追加して」。記事は「ストキャスティクス（STOCH）」の説明。作業環境からは TradingView に直接つながらないので、記事の番号と内容・既定値は検索結果で確かめた（%K の期間 14・%K の平滑化 1・%D の平滑化 3、上のバンド 80・下のバンド 20）。
- **計算**（`src/lib/stochastic.ts`、TradingView の組み込み「ストキャスティクス」と同じ）:
  - 生の値 = 100 ×（終値 − 期間中の最安値）÷（期間中の最高値 − 最安値）。期間は %K の期間（14本）。
  - %K = 生の値の単純移動平均（%K の平滑化、既定1 = そのまま）、%D = %K の単純移動平均（%D の平滑化、既定3）。
  - 期間中の高値と安値が同じ（値幅ゼロ）なら値なし（Pine の na と同じ）。平均の窓に値なしが混じればその平均も値なし。
  - 確かめ方: 手で計算した小さな例と、研究（#102）の別実装 `research/indicator-series.ts` の `stochSeries`（14・3・3 と 14・1・3）と一致すること（値幅ゼロの扱いだけ違う: 研究側は50）。
- **表示**（`PriceChart`、3つのチャートすべて）: 価格の下に RSI と同じ形の帯で、%K 青（#2962FF）・%D オレンジ（#FF6D00）、80・50・20 の線、20〜80 を薄く塗る（TradingView の既定の色）。左上に「Stoch 14 1 3 %K … %D …」（カーソル・タップした足、なければ表示中の最後の足の値）。拡大・移動・全画面に合わせて動く。リアルタイムチャートは形成中の足の値も今の価格で動く（TradingView と同じ。サインは確定足だけで判定するので影響しない）。
- **切り替えと設定**: チャートの下に「インジケーター」の切り替え（RSI(14) はそのチャートに RSI があるときだけ・ストキャス）と、⚙ で3つの期間（1〜100）と「既定（14・1・3）に戻す」。選んだものはこのブラウザに保存し（`src/lib/chartPrefs.ts`、localStorage。読めないときは既定のまま）、すべてのチャートに共通。既定はどちらも表示。
- **全画面**: 帯の数に応じて高さを分け、横向きのスマホ（高さ390）でも価格・RSI・ストキャスが収まる（Chromium で 価格142・RSI 51・ストキャス 51、下端379）。設定を開いて画面より長くなったときだけ縦にスクロールする。
- **サインには使っていない**: 表示だけ。売買の判定（GA型・RSI＋SAR）とメールは変えていない。#102 で17のルールを比べたとき、ストキャスティクスのルール（スロー 14・3・3 の %K と %D の交差を 20/80 で）は1位の RSI に及ばなかった。

### 8.31 全画面チャートを TradingView のアプリのように見やすく・使いやすくし、白背景を選べるようにした（#118）

- **指示**: TradingView のアプリのスクリーンショット4枚（銘柄の検索、時間足のシート、分析ハブ、白背景のチャートとストキャス）に「チャートをアップにした時に見づらい、使いづらい、あと白背景も選べる様にして」「画像みたいな感じで見やすくして、使いやすく」。
- **全画面の並び**（`PriceChart` の `fullscreenLayer`）:
  - 上: ペアと時間足、現在値（最新の足の終値）と前の足比の変化（上げは緑・下げは赤）。十字線のあるときはその足の四本値。リアルタイムチャートは売値・買値・スプレッドと新しいサインもこの下に。横向きなど幅があるときは1行にまとめる。
  - 中: チャートとストキャス（と RSI）で残りの高さを使う。凡例とインジケーターの切り替えは全画面では出さない（カードには残る）。
  - 下（TradingView のアプリと同じ位置）: 「USDJPY ⌄」「1時間 ⌄」のボタン、−/＋（拡大縮小）、⚙（設定）、☾/☀（背景）、✕。
  - ペアと時間足のボタンは下から出るシートを開く。ペアのシートは5ペアの一覧（記号・日本語名・今の価格・選択中に✓）。時間足のシートは5つの時間足と、表示するサイン（GA型/RSI＋SAR/両方）。選ぶとシートが閉じ、全画面のまま切り替わる。
  - 設定のシート: インジケーター（RSI・ストキャスの表示と期間）、背景（黒/白）、表示範囲（全体を表示・操作の説明）。
  - シートは背景をタップ・✕・Esc で閉じる（Esc はシートが先、次に全画面）。
- **読みやすさ**（カードと全画面の両方）:
  - 現在値の線と価格軸のタグ（最新の足が陽線なら緑、陰線なら赤）。
  - 十字線: カーソル・タップした位置の横線と、価格軸にその価格、時間軸にその足の日時のタグ。十字線の出ている間に他の足を薄くするのはやめた（チャートが見づらくなっていた）。
  - ストキャス（と RSI）の値を右の軸に線の色のタグで（%K 青・%D オレンジ、重なるときはずらす）。
  - グリッドを点線にし、時刻のラベルの位置に縦の点線。時刻のラベルは幅に応じて3〜8個（以前は3個）。
  - 計画の水準（エントリー・損切り・利確）の無いチャートでは右端の水準用の欄（84px）を無くし、その分ローソク足を広く。価格軸の幅は価格の桁数と文字の大きさで決める。
  - 全画面では目盛り・ラベル・BUY/SELL・TP/SL の文字を大きく（約1.25倍）。
- **白背景**: チャートのカードと全画面だけに白のテーマ（`.chart-light`、`src/index.css`）。アプリ全体の色は変えていない。色は TradingView の白背景に合わせた（陽線 #089981 前後の緑・陰線 #F23645 前後の赤・文字 #131722 前後・グリッド薄い灰色）。カードの☀/☾ ボタンか設定のシートで切り替え、このブラウザに保存（`chartPrefs.theme`、既定は黒）。
- **確かめたこと**: Chromium（Playwright）で、スマホ縦（白・十字線・ペアのシート・時間足のシート・設定のシート）、スマホ横（白、ヘッダーが1行で価格234px・ストキャス67px・下のバーが画面内）、PC（黒・十字線）を画面で確認。テストは `chart-look.test.tsx`（背景の切り替えと保存、現在値のタグの色、十字線の価格と日時、ストキャスのタグ、水準の欄の有無と時刻ラベルの数、全画面の価格表示と文字の大きさ）と、`chart-zoom.test.tsx` を新しいシートの操作に合わせて更新。
- **TradingView と違うところ**: 出来高は GMO の FX の足に無いので出していない。銘柄の検索は5ペアだけなので一覧のみ。描画ツール・アラート・比較などの分析ハブの機能は無い。

### 8.32 SPECTRA 型（カルマン・スーパートレンド）を追加し、チャートの上でインジケーターをオンオフできるようにした（#119）

- **指示**: `https://jp.tradingview.com/script/IgL6Yia5-SPECTRA-Signal-Processing-Engine-SentioEdge/` に「このチャートの理屈分かる？ あと、こういうインジケーターはオンオフできる様にチャートで」。
- **SPECTRA の仕組み**（招待制でコードは非公開。作業環境から TradingView・SentioEdge のサイトには直接つながらないので、検索で読める販売側の説明から）:
  - 処理の順: 高値と安値の中間（HL2）と ATR → カルマンフィルターで平滑 → その値でスーパートレンドの帯 → 「Smart Trail」で構造の確認 → RSI の勢いフィルター → 出来高で信頼度を分類（Normal / Strong BUY・SELL）。
  - ほかに TP1（1:1）・TP2（1:2）の分割利確と損切り・途中決済、Trend Cloud、Reversal Zones、6つの時間足の一覧、直近500回の成績表。「リペイントしない」とうたう。
  - 中身はトレンドフォロー（スーパートレンドの反転）で、#115 の Pro Scalper（カルマンで調整したスーパートレンド）と同じ系統。
  - カルマンフィルター（雑音を一定とみなす1次元のもの）は、しばらくすると一定の重みの指数移動平均と同じになる（下の例で約6本の EMA）。「適応型」というほど状況に合わせて変わるわけではない。
  - 成績表はチャートに出ている期間の結果で、その期間に合わせて設定を選べば良く見える（期間外で確かめたものではない）。FX の出来高は TradingView でもブローカー1社のティック数で、出来高による分類の意味は薄い。
- **SPECTRA 型**（`src/lib/kalmanSupertrend.ts`、公開の説明の処理順を再現。表示のみ・既定はオフ）:
  - HL2 と ATR(10) をカルマンフィルター（Q=0.01・R=0.1、落ち着いたときの重み約0.27）で平滑 → スーパートレンド（ATR×3、TradingView の既定と同じ 10・3）→ 反転した確定足で RSI(14) が 50 の上（売りは下）のときだけ ▲（安値の下）/▼（高値の上）。
  - 線: 上昇中は緑で価格の下、下降中は赤で価格の上。反転で線は切れる（TradingView と同じ）。雲: 平滑した価格と線の間を薄く塗る。
  - 入れていないもの: Smart Trail（規則が公開されていない）、出来高の分類（GMO の足に出来高が無い）、TP・損切り、時間足の一覧、成績表。
  - リアルタイムチャートの形成中の足では反転の印を付けない（`formingLast`）。確定足だけ。
  - RSI は分析と同じ Wilder の RSI（テストで一致を確認）。
  - 追加の時点では過去のデータで検証していなかった（一覧の名前に「未検証」と付けた）。その後 #120 で測った（§8.33。名前の「未検証」は外し、凡例に結果を書いた）。サインの判定・メール・記録には使っていない。
- **チャートの上でのオンオフ**（TradingView のチャート左上の一覧と目のアイコンと同じ形）:
  - 3つのチャートすべての左上に、そのチャートが描けるものの一覧: 売買サイン（リアルタイムは「GA型のサイン」など表示中のルール名）、建玉の箱、SAR の帯、パラボリックSAR、高値線・安値線、SPECTRA型 10 3、RSI(14)、ストキャス。
  - 目のアイコンで表示・非表示を切り替える。非表示のものは取り消し線と目の斜線。ストキャスの ⚙ で期間の設定（全画面では設定のシートが開く）。
  - 一覧は ^ でたたんで「インジケーター 5/6」（表示中/全部）のボタン1つにできる。スマホのカードでは最初はたたんだ状態、全画面と PC では開いた状態。
  - 全画面の設定のシートにも同じ切り替えを並べた。
  - 選んだものはこのブラウザに保存（`chartPrefs.overlays`）。既定は SPECTRA 型だけオフ、他はオン（今までと同じ見た目）。
  - これまでのチャートの下の「インジケーター」の切り替え行は、この一覧に置き換えた。
- **確かめたこと**: テスト `spectra.test.tsx`（カルマンの重み・サーバーの RSI との一致・反転と RSI フィルター・形成中の足に印を付けないこと・一覧の中身と各切り替え・たたみ・全画面の設定のシート）。Chromium で PC・スマホのカード（たたんだ状態・開いた状態）・全画面を画面で確認。

### 8.33 SPECTRA 型を過去のチャートで測った（#120、研究のみ）

- **指示**: 「測ってみて、搭載はしてくれたよね？」（搭載は §8.32 のとおり済み、既定はオフ）。
- **方法**（GA型 §8.25 と同じ `research/gainz.ts`、`gainz.yml` で実行）:
  - GMO の15分足（2024-01〜）11ペアを 15分・1時間・4時間で。前半 2024-01〜2025-06、後半 2025-07〜2026-09。スプレッド込み。15分・1時間は UTC 17〜23時を除く（アプリと同じ）。
  - ルールはアプリのチャートの計算そのもの（`src/lib/kalmanSupertrend.ts` を研究から直接読み込む）: `spectra_rsi`（RSI フィルターあり＝チャートの ▲▼）と、比較の `spectra_st`（同じ反転すべて）。
  - 出口: 損切り ATR×1・利確2倍（r2w、GA型と同じ）と、SPECTRA の分割利確に合わせた split（半分は利確1倍・半分は2倍、同じ損切り）。反対のサインでの途中決済は入れていない（どの出口も48本で打ち切り）。
  - 物差し: 同じペア・時間足・向き・時刻に毎本入った場合との差（lift）。95%の幅は週ごとのまとまりで計算。
  - 設定（スーパートレンドの 10・3、カルマンの Q・R、RSI 50）はデータを見る前に決めたもので、ここで選んでいない。両期間とも出す。
- **結果**（`spectra_rsi`、r2w、全時間足）:

| 期間 | 回数 | 勝率（損益ゼロ 33.3%） | 1回あたり [95%の幅] | ランダムとの差 [95%の幅] |
|---|---|---|---|---|
| 前半 | 8,515 | 31.2% | −0.062R [−0.103〜−0.022] | +0.030R [−0.010〜+0.070] |
| 後半 | 7,164 | 29.4% | −0.116R [−0.166〜−0.066] | −0.002R [−0.052〜+0.048] |

  - 時間足別（前半 / 後半）: 15分 −0.065R・差 +0.037 / −0.133R・差 −0.007、**1時間 −0.048R・差 +0.023 / −0.031R・差 +0.052 [−0.048〜+0.151]**、4時間 −0.077R・差 −0.051 / −0.146R・差 −0.095。
  - ペア別に1回あたりがプラスだったのは前半1/11（NZD/JPY +0.05R）、後半0/11。
  - split（SPECTRA の分割利確）: 前半 −0.070R・差 +0.022、後半 −0.117R・差 −0.003。最初の利確（1倍）に届いたのは 46.1% / 44.1%。r2w とほぼ同じで、利確の分け方では変わらない。
  - **RSI のフィルターは効いていない**: 外したのは前半 8,516回中1回、後半 7,165回中1回。価格が平滑した値から ATR×3 を抜けてスーパートレンドが反転するときには、ほとんど常に RSI が既に同じ側にある。
- **結論**: スプレッドを払うと、どの時間足・どちらの期間でもマイナス。全体ではランダムに入った場合と差が無い。1時間足は両期間ともランダムより少し良い（+0.023R / +0.052R）が、幅はゼロをまたぐ。GA型の1時間足（§8.27: −0.003R・差 +0.068 / −0.080R・差 +0.006）や SAR の反転（#110）と同じく「トレンドフォローの1時間足はわずかにましで、それでも負け」の範囲。結果を見てから選ぶと偶然を拾うので（§8.24 のルール4）、SPECTRA型をサインやメールに使う変更はしない。チャートの表示（既定オフ）のまま、名前の「未検証」を外し、凡例にこの結果を書いた。
- **アプリの表示との違い**: 研究は全履歴で計算し、チャートは画面の足（リアルタイムは121本）だけで計算する。スーパートレンドは前の足の帯を引き継ぎ、カルマンと ATR も計算の始まりの影響がしばらく残るので、チャートの左端に近いところ（左端から最初の反転まで）は研究と違う反転になることがある。

### 8.34 FVG Crossfire（FluxChart、公開コード）をインジケーターに追加した（#121）

- **指示**: `https://jp.tradingview.com/script/uTeXKnH4-FVG-Crossfire/` に「次は、これをインジケーターに追加して。これはコードも公開されてますね」。
- **コードの入手**: 作業環境から TradingView には直接つながらないので、ワークフロー `.github/workflows/pine-source.yml`（読み取りのみ・秘密情報なし）を追加し、GitHub の runner で公開ページと公開ソース（PUB;5efe3c3efecb462898f78c0864b9a681、v2.0、371行、Pine Script v6）を読んでジョブのログから取得した。ライセンスは Mozilla Public License 2.0（© fluxchart）。
- **移植**（`src/lib/fvgCrossfire.ts`。MPL 2.0 はファイル単位のライセンスなので、このファイルに MPL 2.0 と原作者の表示を付けた。他のファイルには及ばない）。既定の設定のまま、規則を1つずつ写した:
  - FVG（3本の足の1本目と3本目の間の空白）は背景で追うだけで描かない。最小幅（価格に対する %）は既定 0 で、すべてのギャップを使う。
  - 待っているギャップは終値で埋まる（既定「Close」）。ただし3本遅れで判定（新しいギャップを作った動きが古いギャップを消してしまわないように）。完全に埋まったら外す。
  - 新しいギャップが、逆向きの古いギャップの埋まっていない部分に重なったら、その重なりだけを「クロスファイアゾーン」にする。向きと色は新しいギャップ側。古いギャップからゾーンへの「origin funnel」を描く。
  - ゾーンに逆向きのギャップがまた重なると反転: それまでの箱は止まり、重なった部分だけの逆向きの箱が続く（反転ごとに狭くなる）。★ の数＝形成と反転の回数（5回以上は「5 ★」）。
  - 再テスト: ゾーンに触れていなかった足の次に触れた足（ひげでよい）に、買い側は ▲（足の下）、売り側は ▼（足の上）。
  - 終わり: 終値が反対側を抜けたら（既定「Close」）その連鎖全体を薄くして残し、矢印は消す（既定「Show mitigated zones」）。
  - 1つのギャップが使われるのは1回だけ。日・週の区切りの前後の足ではギャップを探さない（TradingView の FX の1日はニューヨーク 17:00 始まり。GMO の日足の区切りも同じ時刻）。
  - 確定足だけで判定（リアルタイムの形成中の足には何も付けない）。
  - 本数の上限（ギャップ80・ゾーン120・矢印20）も同じ。
  - 入れていないもの: アラート、既定で使われない設定（重なるゾーンの結合・枠線・中央線）。
- **表示**: 3つのチャートの左上の一覧に「FVG Crossfire」（既定でオン、目のアイコンで切り替え）。色は元の #0ecb81（買い側）・#f6465d（売り側）。このアプリのチャートは TradingView より小さく、数 pips の帯は線になってしまうので、帯の価格は元のままで、高さを最低2px、生きているゾーンには細い縁を付けた。凡例に仕組みと「表示のみ」を記載。
- **元との違い**: 元は直近 3,000本の中で探すが、このチャートは画面の足（リアルタイムは確定足120本）だけで探すので、ゾーンは少なめで、それより前のギャップからできたゾーンは出ない。
- **サインには使っていない**: 売買の判定・メール・記録は変えていない。過去データでの検証もしていない（ゾーン自体は売買のサインではない。再テストの矢印を売買に使った場合の成績は測っていない）。
- **確かめたこと**: テスト `fvg-crossfire.test.tsx`（ゾーンの形成・原点の funnel・反転と狭まり・再テスト・終わり・セッションの区切り・★の表記・一覧での切り替え・形成中の足）。Chromium でリアルタイムチャート（15分足）の表示を確認。

### 8.35 Weighted Volume Profile（Flux Charts、公開コード）をインジケーターに追加した（#122）

- **指示**: `https://jp.tradingview.com/script/o8fvRI5E-Weighted-Volume-Profile-Flux-Charts/` に「次はこれを追加して、コードも公開されてるよ」。
- **コードの入手**: §8.34 のワークフロー `pine-source.yml` を、このページの URL を入力にして手動実行し、公開ソース（PUB;a6ffc981b60c487ca69937142107ad06、v2.0、151行、Pine Script v5）をジョブのログから取得した。ライセンスは MPL 2.0（© fluxchart）。
- **移植**（`src/lib/weightedVolumeProfile.ts`、ファイルに MPL 2.0 と原作者の表示）。既定の設定のまま:
  - 直近 200本（Analyze Bars）の高値〜安値を 30段（Row Count）に分ける。
  - 各足を、ひげの範囲が触れるすべての段に丸ごと足す（段で分け合わない）。終値＞始値なら買い側、それ以外は売り側。元のループどおり、範囲を決めた200本より1本古い足まで数える。
  - 重み付けは既定の「Normal」（どの足も同じ）。「Recent」「Past」（0.85×1/(i+1)、0.85×(i+1)/N に 0.15 を足す）も同じ式で入れてあるが、画面からは選べない。
  - 各段の横棒は、読んだ最初の足から右へ（Align To: Left）、買い側→売り側の順。長さは最少の段=1本分〜最多の段=50本分の比例（四捨五入）。段の高さの1/3を段の間のすき間にする。
  - POC（Point Of Control）: 合計がいちばん多い段（同数なら元のループどおり下の段）の中央に、その段の横棒の終わりから右端まで黄色の線（太さ2）。
- **元との違い**:
  - **出来高**: 元は足ごとの出来高で数えるが、GMO の FX の足（リアルタイムの予備の Twelve Data も）には出来高がない。ここでは**1本=1**として数えるので、横棒は「価格がその段に留まった時間（足の本数）」で、出来高ではない（TPO 型のプロファイル）。凡例にそう書いた。
  - **本数**: 元は 200本に満たないチャートでは描かない（高値・安値が出ない）。ここではチャートにある全部（リアルタイムは形成中を含む121本）で描き、凡例に本数を出す。
  - **描き方**: 元は不透明な箱を足の上に描く。ここでは足が見えるように、ローソク足の下に半透明（30%）で描く。白背景では黄色が見えにくいので POC を濃い黄色（#F2A900）にした。色は買い側・売り側ともこのチャートの陽線・陰線の色。
  - 形成中の足も含めて計算する（元もチャートの最後の足で計算し直す）。
- **表示**: 3つのチャートの左上の一覧に「Weighted Volume Profile 200 30」（既定でオン、目のアイコンで切り替え）。
- **サインには使っていない**: 売買の判定・メール・記録は変えていない。過去データでの検証もしていない。
- **確かめたこと**: テスト `volume-profile.test.tsx`（段の区切り・触れた段への加算・買い側／売り側・1〜50本の長さと四捨五入・POC の同数の扱い・全段同数・範囲より1本古い足・重み付けの式・一覧での切り替え・200本の窓・白背景の POC の色）。Chromium でリアルタイムチャート相当（15分足121本）を PC・スマホ幅・白背景で表示して確認。
- **#123 で変更**: 下の §8.36 のとおり、FVG Crossfire と1つのインジケーターにまとめた（一覧の名前・スイッチ・凡例・色）。

### 8.36 FVG Crossfire と Weighted Volume Profile を1つのインジケーターにまとめた（#123）

- **指示**: 「さっきのFVG Crossfireとこれは表示をニコイチにしてチャートに表示させるようにしてください」。
- **変更**（計算は §8.34・§8.35 のまま。表示だけ）:
  - 一覧（3つのチャートの左上と、全画面の設定シート）の2行を1行「FVG Crossfire + Volume Profile」にまとめた。目のアイコン1つで両方をオン／オフ（既定でオン）。
  - 設定は `overlays.fvgProfile` の1つ。#121 からの `overlays.fvgCrossfire` が保存されている端末では、その値を引き継ぐ（FVG Crossfire を消していた人は、まとめた後も消えたまま）。#122 の `volumeProfile` の保存値は使わない。
  - 凡例も1つの段落にまとめ、【箱】（FVG Crossfire）と【左の横棒】（Volume Profile）に分けて説明。
  - 色をそろえた: Volume Profile の横棒を FVG Crossfire と同じ #0ecb81（買い側）・#f6465d（売り側）に（§8.35 ではチャートの陽線・陰線の色だった）。POC の黄色の線はそのまま。
- **サインには使っていない**: 変わらず表示のみ。
- **確かめたこと**: テスト（`volume-profile.test.tsx`: 一覧が1行・スイッチ1つで両方が消える・凡例が1つ・色・以前の設定の引き継ぎ、`fvg-crossfire.test.tsx`・`spectra.test.tsx` の一覧の名前と件数）。Chromium で PC・スマホ幅・白背景の表示と、スイッチで両方が消えることを確認。

### 8.37 Zone Shift（ChartPrime、公開コード）をリアルタイムチャートに追加した（#124）

- **指示**: `https://jp.tradingview.com/script/8lfE3qMN-Zone-Shift-ChartPrime/` に「これも追加して」。
- **コードの入手**: §8.34 のワークフロー `pine-source.yml` をこの URL で手動実行し、公開ソース（PUB;7546dd15909647c886052e94bf75c5c5、v1.0、67行、Pine Script v6）をジョブのログから取得。ライセンスは MPL 2.0（© ChartPrime）。
- **移植**（`src/lib/zoneShift.ts`、ファイルに MPL 2.0 と原作者の表示）。既定の設定（Length 100）のまま:
  - 中央線 = EMA(終値, 100) と HMA(終値, 60) の平均。上下の線 = 中央線 ± 直近200本の（高値−安値）の平均。
  - 確定足で: 安値が上の線を下から上に抜けたら（前の足の安値は線の下、それまで下降）上昇トレンド。高値が下の線を上から下に抜けたら下降トレンド。その足の安値（高値）が「トレンド開始の水準」。
  - 再テスト ◆: 上昇中に終値か安値がその水準を下から上に抜け直したら足の下に、下降中に終値か高値が上から下に抜け直したら足の上に。前の ◆ から6本以上あいたときだけ（元の `> 5`）。下降側の条件は元のまま、今の水準と1本前の水準を混ぜて比べる（そのため、下降に変わった足そのものに ◆ が付くことがある。テストに記録）。
  - 足の色をトレンドで塗る（上昇=ライム #00E676、下降=青 #2962FF。最初の上昇までは下降扱い＝元と同じ）。中央線と水準は1本おきの点線、上下の線は実線（チャートの文字色）。
  - Pine の決まりどおり: EMA は最初の100本の単純平均から始める（アプリの他の EMA と同じ）、WMA・SMA は窓がそろうまで値なし、値なしとの比較は偽。上下の線は形成中の足にも引くが、トレンドと ◆ は確定足だけで判定。
  - ◆ は文字ではなく SVG のひし形で描く（スマホのフォントに「⯁」がない場合があるため）。
- **足の本数（元と違う点）**: 200本平均の最初の値は200本目で、リアルタイムチャートの121本では足りない。そこで:
  - エッジ関数 `live-chart` に `{action: "history"}` を追加（v4）。確定足を最大 `HISTORY_BARS` = 600本返す（GMO のみ。Twelve Data の予備は使わない）。インスタンス内で10分キャッシュ。サインに使う `bars` の読み方（200本）は変えていないので、RSI+SAR・GA型の判定とメールは変わらない。
  - クライアントは Zone Shift がオンのときだけ読み、チャートの最初の足より前の部分をつないで計算する（`historyBefore`）。つながらない（読んでから時間がたった）ときは読み直す。読めないときは描かず、凡例にそう出す（次の足の読み込みで読み直す）。読んでいる間も描かない（足だけでは足りず、全部が青になってしまうため）。
  - 元は TradingView の全履歴から計算するが、ここでは最大600本＋画面の足から。画面より前が約480本あるので、EMA の始め方の違いの影響は画面の左端で約0.05%まで薄まる（出だしから約380本、0.98^380）。トレンドの状態は最初の上抜けまで「下降」なので、読んだ範囲で一度も抜けていないと元と色が違うことがある。
  - 日足は GMO の年ファイル2年分まで（9月末で約450本、年初は約260本）なので、年の初めは画面の左側に線が出ないことがある。1時間足の600本は GMO の日ファイル約30日分（売値・買値で約60回）を順に読むので、最初の表示に数秒かかる。
- **表示する場所**: リアルタイムチャートだけ（一覧に「Zone Shift 100」、既定でオン、目のアイコンで切り替え）。分析結果と成績のチャートは121本しかなく、過去の足も持っていないので一覧に出さない（自分で200本以上ある図なら出る）。
- **サインには使っていない**: 売買の判定・メール・記録は変えていない。過去データでの成績は §8.38（#125）。
- **確かめたこと**: テスト `zone-shift.test.tsx`（SMA・WMA・EMA・HMA の Pine の式、既定値、上昇・下降の始まりと水準、再テストと6本の間隔、形成中の足、チャートでの色・線・◆・凡例・切り替え、読み込み中・失敗の表示、`history` の中身と600本、つなぎ方、オンのときだけ読む、失敗しても繰り返し読まない）。エッジ関数を esbuild で束ねてビルドできることを確認。Chromium で 15分足721本（600本＋121本）を PC・スマホ幅・白背景で表示して確認。

### 8.38 Zone Shift を過去のチャートで測った（#125、研究のみ）

- **指示**: 「測って」（§8.37 の Zone Shift）。
- **方法**（SPECTRA 型 §8.33 と同じ `research/gainz.ts`、`gainz.yml` で実行。run 36247247143）:
  - GMO の15分足（2024-01〜）11ペアを 15分・1時間・4時間で。前半 2024-01〜2025-06、後半 2025-07〜2026-09。スプレッド込み。15分・1時間は UTC 17〜23時を除く。
  - ルールはチャートの計算そのもの（`src/lib/zoneShift.ts` を研究から直接読み込む、Length 100）。各ペアの全履歴で計算するので、トレンドの状態は計測の始まり（210本目）より前に落ち着いている。
    - `zs_shift`: 確定足でトレンドが変わった足（足の色が変わるところ）で、その向きに入る。
    - `zs_retest`: 再テストの ◆ の足で、トレンドの向きに入る。
  - 入るのはその足の終値（買いは買値〈ask〉・売りは売値〈bid〉で入り、反対側で出る＝スプレッドを払う）。出口は r2w（損切り ATR×1・利確2倍）と split（半分は利確1倍・半分は2倍）。48本で打ち切り。
  - 物差し: 同じペア・時間足・向き・時刻に毎本入った場合との差（lift）。95%の幅は週ごとのまとまりで計算。
  - 設定は公開の既定値で、データを見る前に決めた。順位付けはせず、両期間とも出す。
- **結果**（r2w、全時間足。損益ゼロの勝率は 33.3%）:

| ルール | 期間 | 回数 | 勝率 | 1回あたり [95%の幅] | ランダムとの差 [95%の幅] |
|---|---|---|---|---|---|
| 転換 `zs_shift` | 前半 | 6,981 | 30.7% | −0.076R [−0.128〜−0.024] | +0.015R [−0.036〜+0.066] |
| 転換 `zs_shift` | 後半 | 5,687 | 29.7% | −0.109R [−0.150〜−0.067] | +0.006R [−0.036〜+0.048] |
| 再テスト ◆ `zs_retest` | 前半 | 10,965 | 30.4% | −0.087R [−0.123〜−0.052] | +0.006R [−0.029〜+0.041] |
| 再テスト ◆ `zs_retest` | 後半 | 9,028 | 30.4% | −0.085R [−0.124〜−0.046] | +0.026R [−0.013〜+0.066] |

  - 時間足別（前半 / 後半、1回あたり・差）:
    - 転換: 15分 −0.067R・+0.035 / −0.138R・−0.011、**1時間 −0.125R・−0.058 / +0.003R・+0.087 [−0.025〜+0.198]**、4時間 −0.039R・−0.012 / −0.089R・−0.029。
    - ◆: 15分 −0.108R・−0.003 / −0.103R・+0.025、1時間 −0.062R・+0.005 / −0.024R・+0.048 [−0.030〜+0.127]、**4時間 +0.087R・+0.112 [−0.031〜+0.254] / −0.065R・−0.015**。
  - ペア別に1回あたりがプラス: 転換は前半 0/11・後半 0/11。◆は前半 1/11（USD/JPY +0.00R）・後半 1/11（USD/JPY +0.02R）。
  - split: 転換 −0.069R・差 +0.021 / −0.111R・差 +0.003（最初の利確に届いたのは 46.9% / 44.4%）。◆ −0.081R・差 +0.010 / −0.095R・差 +0.018。r2w とほぼ同じ。
  - 細かく分けると前半だけ幅がゼロをまたがない組がある（◆ 4時間の split: 差 +0.106 [+0.001〜+0.212]、そのうち売り +0.187 [+0.022〜+0.352]。転換 15分の売りの split: +0.070 [+0.014〜+0.125]）。どれも後半では消えた（◆ 4時間 −0.017、売り −0.028、転換 15分の売り +0.029 [−0.032〜+0.089]）。多くの組を見ると偶然でこのくらいは出る。
- **結論**: スプレッドを払うと、転換でも ◆ でも、どちらの期間でもマイナス（時間足ごとに見て、後半で1回あたりがプラスなのは転換の1時間足 +0.003R だけで、ほぼゼロ）。ランダムに入った場合との差はどちらも誤差の範囲。GA型・SPECTRA型の1時間足と同じく「1時間足はわずかにましで、それでも勝てない」の範囲。結果を見てから選ぶと偶然を拾うので（§8.24 のルール4）、Zone Shift をサインやメールに使う変更はしない。チャートの表示はそのまま（既定オン）、凡例にこの結果を書いた。
- **チャートの表示との違い**: 研究は全履歴で計算、チャートは最大600本＋画面の足で計算（§8.37）。トレンドの状態が落ち着いた後は同じになる。

### 8.39 GA型のサインのあと、ストキャスがしきい値を抜けるまで待つと良くなるかを測った（#126、研究のみ）

- **きっかけ**: USD/JPY 1時間足で GA型の SELL が3回続けて損切りに当たり、その後に大きく下げた（2026-09-23〜26）。SELL のときストキャスは 80 超で、80 を下に抜けたのは下げ始めのころだった。所有者の指示は「測ってみて、80の数字を見直すか」。
- **方法**（`research/gainz.ts` の #126 の部分、`gainz.yml`、run 36254627527。データ・期間・スプレッド・物差しは §8.33 と同じ）:
  - GA型のサイン（アプリと同じ `gz_app`）のあと24本以内に、チャートのストキャス（`src/lib/stochastic.ts` をそのまま使う、14・1・3）の **%K が最初にしきい値を下に抜けた足で売り**（買いは 100−しきい値 を上に抜けた足）。その足の終値で入り、その足の ATR で損切り ATR×1・利確2倍（r2w）。GA のサインが続いても入るのは最初に抜けた1回だけ。
  - しきい値の候補 70・75・80・85・90 は、**前半（1時間足・r2w）で1つ選び、後半で判定**（結果を見てから選ばないため）。待つ本数（24）・%D ではなく %K を使うこと・候補は、データを見る前に決めた。
  - 比べるもの: GA型そのまま（すぐ入る）と、GA なしでストキャスがしきい値を抜けただけで入る場合。
- **結果**（1時間足、r2w。損益ゼロの勝率 33.3%）:

| 入り方 | 前半 回数 | 前半 1回あたり（ランダムとの差） | 後半 回数 | 後半 勝率 | 後半 1回あたり（ランダムとの差 [95%]） |
|---|---|---|---|---|---|
| GA型そのまま | — | −0.003R（+0.068） | 1,791 | 30.6% | −0.080R（+0.006 [−0.068〜+0.080]） |
| 待つ・70 | 2,119 | **+0.029R（+0.096 [+0.019〜+0.173]）← 前半で選ばれた** | 1,808 | 29.9% | **−0.101R（−0.017 [−0.083〜+0.050]）** |
| 待つ・75 | 2,131 | −0.002R（+0.066） | 1,822 | 29.5% | −0.113R（−0.027） |
| 待つ・80 | 2,058 | −0.048R（+0.021） | 1,755 | 30.5% | −0.086R（+0.004） |
| 待つ・85 | 1,927 | −0.052R（+0.016） | 1,646 | 29.5% | −0.114R（−0.023） |
| 待つ・90 | 1,711 | −0.102R（−0.033） | 1,413 | 29.6% | −0.113R（−0.023） |

  - 前半で選ばれた 70 は、前半ではランダムより良く（幅がゼロをまたがない）、1回あたりもプラスだったが、**後半は −0.101R でランダム以下、GA型そのまま（−0.080R）より悪い**。後半は11ペアすべてでマイナス。買い −0.070R・売り −0.128R。分割利確（1倍/2倍）でも −0.085R。
  - 80 は両期間とも GA型そのままとほぼ同じ（差 +0.021 / +0.004）。どのしきい値も後半で GA型そのままを上回っていない。
  - 他の時間足: 15分はどのしきい値も両期間でマイナス、ランダムとの差もゼロ前後。4時間は後半だけ差がプラスの組がある（90: +0.059、85: +0.041）が、前半はすべてマイナスで、1回あたりも後半マイナス。
  - GA なしでストキャスがしきい値を抜けただけで入る場合: 1時間足の後半はすべてのしきい値でランダム以下（例 70: −0.120R、差 −0.039 [−0.072〜−0.006]）。4時間足は前半ランダム以下・後半わずかに上で、揃わない。
- **結論**: 「ストキャスが80（や70〜90）を抜けるまで待つ」は、GA型を良くしなかった。スクリーンショットの3回のような場面では後から見ると効いて見えるが、11ペア・2年半では、待っても待たなくても同じか悪い。80 を別の数字にしても変わらない（前半で一番良かった 70 は後半で崩れた）。GA型のサイン・メールは変えない。ストキャスは表示のまま（§8.30）。

### 8.40 リアルタイムチャートに金（XAU/USD）を追加した（#127）

- **指示**: TradingView の「金CFD（米ドル／オンス）」1時間足のスクリーンショットに「金cFDを追加して」。
- **価格の取り先を確かめた**（読み取り専用のワークフロー `.github/workflows/feed-check.yml`、キーなし）:
  - GMOコインの FX の公開 API は21銘柄（`/public/v1/symbols`）で、**金はない**。
  - Twelve Data に XAU/USD（Gold Spot / US Dollar、分類は Precious Metal）があり、`symbol_search?show_plan=true` の `access.plan` が **Basic**（アプリの今の無料枠のキーで取れる）。
  - Swissquote の公開気配（`forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument/XAU/USD`）はキーなしで売値・買値を返す（2026-09-26 に 4284.855 / 4285.545）。
- **作り**（エッジ関数 `live-chart` v5 と画面）:
  - 足: Twelve Data の XAU/USD を一度に `GOLD_BARS` = 800本読み、`live_chart_fallback` に保存。**その後に足が確定するまで**は保存したものを使う（`goldFresh`: 読んだ時刻がいまの足の始まり以降なら新しい。市場が閉まっている可能性がある間は30分）。Twelve Data の1分あたりの上限（共有キー8回）を守るインスタンスごとの制限は、GMO が読めないときの予備と共用。
  - 動く価格: Swissquote の standard の売値・買値を、FX のティッカーと一緒に5秒ごと（インスタンス内2秒キャッシュ）。最後の気配が3分より古いときは「取引中でない」（日々の休止・週末）。形成中の足はこの中間値で動く。
  - **1分足はなし**: 足が毎分確定すると1日最大1,440回読むことになり、Twelve Data の無料枠（1日800回、分析と共用）を超えるため。金を選ぶと 15分・1時間・4時間・日足だけになり、1分足を見ていたときは1時間足に切り替わる。
  - Zone Shift の過去の足（`history`）も同じ800本から返す。
  - その後（#176）: 一度に読んで保存するのは1,400本（`GOLD_BARS`）になった。チャートの足と印・ほかのインジケーター・ダウ理論は、これまでと同じ最新800本（`TWELVE_CHART_BARS`）を使う。1,400本すべてを使うのは Zero-lag TEMA の深い過去だけ（§8.87）。
  - 表示: 小数2桁（`priceDecimals`）、スプレッドは pips ではなく**ドル**、名前は「金（米ドル／オンス）」。「GMO が読めないため別の配信」という予備の注意は出さず、金の取り先を書いた説明をチャートの下に出す。
- **元と違う点・対象外**:
  - TradingView の「金CFD」とは提供元が違うので、数ドルずれることがある。
  - サイン（GA型・RSI＋SAR）の印は Twelve Data の中間値の足で判定して表示するが、**メール通知と成績の記録の対象外**（どちらも GMO の売値・買値で判定する仕組みで、GMO に金がない）。
  - 分析（AI の分析）の通貨ペアにはまだ入れていない（pips・桁数・市場の時間の扱いを金に合わせる変更が必要）。
- **確かめたこと**: テスト `gold.test.tsx`（一覧と時間足、Twelve Data の URL、保存した足の鮮度、Swissquote の読み方と古い気配、足の読み方〈小数2桁・形成中の足・次の確定〉、履歴、画面で金を選ぶと1時間足に切り替わる・1分足がない・スプレッドがドル・説明文・予備の注意が出ない、桁数）と `live-chart.test.tsx`（銘柄が6つ）。エッジ関数は `deno check` と esbuild で確認。Chromium で、関数の読み方で作った金の1時間足800本を PC・スマホ幅で表示して確認。**本番の Twelve Data と Swissquote からの読み込みは、公開後に画面で確かめる**（ここからは本番の関数をログインして呼べない）。

### 8.41 分析でも金（XAU/USD）を選べるようにし、pips と休止時間の扱いを金に合わせた（#128）

- **指示**: 「選べる様に 直して」（§8.40 の報告で、分析の通貨ペアにまだ金がないこと・pips と毎日の休止の扱いを直す必要があることを伝えた後）。
- **分析で選べる**: 設定の通貨ペアに XAU/USD（`SettingsDrawer`）、`analyze` の `ALLOWED_PAIRS` にも追加。足は Twelve Data（1回の分析で3回、FX と同じ）。GMO には金がないので GMO の足での補正はなく、成績の判定（`track-outcomes`）も Twelve Data の中間値。
- **桁数と距離の単位**:
  - 価格は小数2桁（`pairDecimals`・`priceDecimals`・`position-review` の既定）。
  - 距離は pips ではなく**ドル**: 損切り・利確までの距離（「$12.34・ATR 1.4倍」）、RSI＋SAR の条件までの距離、成績の詳細、保有ポジションの確認（含み・損切りまで・TP1まで）。サーバー側も金は「1ドル」を単位に計算し（`pipSize`・`review.ts` の `pipFor`）、AI に渡す構造の説明・ポジション確認の数字も「ドル」と書く。
  - 「1万通貨で損切りなら〜」は金では出さず、「1オンスで損切りなら $X の損失」にした（`lossPer10k` は金で null）。
- **休止時間**（`_shared/market-hours.ts` に `isGoldBreak`・`isPossiblyClosedFor`・`nextOpenFor`・`lastCloseFor`）:
  - 金は FX の週末に加えて、**毎日ニューヨーク17時台**（夏は UTC 21時台＝日本時間 朝6時台、冬は UTC 22時台＝朝7時台）に止まる。日曜の再開もニューヨーク18時で、冬は FX より1時間遅い。この1時間も週末と同じ「閉まっている」扱いにした: 分析は下見（WAIT、エントリーなし）、再開予定は休止明け、データの古さは休止の始まりから測る（休止中に1分足・15分足が「古い」と判定されて失敗しないように）。
  - FX の通貨ペアの判定は変わらない（`*For` は FX では元の関数と同じ値を返す。1年分を1時間ごとにテストで確認）。
  - 閉まっているときの説明は金用の文（「金の市場が閉まっている（週末、または毎日のニューヨーク17時台…）」）。
- **FX の測定を金に当てはめない**:
  - GMO のスプレッドで測った「割高な時間帯」（UTC 17〜23時の 15分・1時間足の見送り）は金には適用しない（金では測っていない）。
  - RSI＋SAR と GA型の「過去の検証」の欄に、金では「この検証は FX の通貨ペアのものです。金では測っていません」と出す。
- **対象外のまま**: メール通知（GMO の売値・買値で判定するため、金は入らない）。
- **確かめたこと**: テスト `gold-analysis.test.tsx`（ニューヨークの夏・冬時間の切り替え、金の休止の判定、FX では元の関数と1年分一致、休止明け・冬の日曜の再開、休止中のデータの古さの基準、分析の許可リスト・桁数・ドルの単位・割高な時間帯の除外、画面のドル表示、1万通貨の表示の除外、ポジション確認のドル表示）。分析のソースの記述を確かめるテスト（`entry-contract`・`weekend-preview`）を新しい関数名に合わせた。`deno check`（analyze・position-review・live-chart・signal-alerts・track-outcomes）。**本番で金の分析を1回走らせて確かめるのは、公開後**（ここからはログインして分析を呼べない）。

### 8.42 リアルタイムチャートにダウ理論（4時間・1時間・15分・5分）を追加した（#129）

- **指示**: Instagram のリール（The5ers Japan の投稿、46秒）に「この動画のダウ理論のインジケーター作って／この人が言ってる通りので」。
- **動画を読んだ方法**: 開発環境からは Instagram・YouTube に届かないため、読み取り専用のワークフロー `.github/workflows/reel-read.yml`（yt-dlp で動画と投稿文、faster-whisper で音声の文字起こし、tesseract で画面の文字。公開 URL のみ・キーなし・リポジトリには何も書かない）で読んだ。話していることの要点:
  - 「ダウ理論をストレートに…高値・安値の更新を追っていけるインジケーター」
  - 「4時間・1時間・15分・5分で自動的に、高値を更新している状態か安値を更新している状態かを判別」
  - 「1回タッチしたけど、もう1回タッチしたら初めて確定する」
  - 「上位足の水平線の抵抗がどこにあるかも全部分かる…機械で引ける」
  - 投稿文にあった元のインタビュー（YouTube）は、ランナーからも読めなかった（YouTube のボット確認）。オーナーが上げた動画ファイルも同じリールだった（画面は空白、音声が同じ長さ・同じ内容）。**本人のコードは公開されていない**ので、動画が言っていない部分は教科書どおりのダウ理論で決めた。
- **読み方**（`supabase/functions/_shared/dow.ts`。データを見る前に決めた。「もう1回タッチしたら確定」の読み方は、選択肢を出してオーナーが「トレンド転換の確定」を選んだ）:
  - 山と谷: 左右 `DOW_PIVOT` = 5本の足より高い高値・低い安値。5本後に確定し、後から変わらない（同じ種類が続いたら、より外側の方を残す）。
  - 上昇（高値更新中）: 終値が直前の山を上に抜けた。その前の谷が**押し安値**。下降はその逆で**戻り高値**。
  - 1回目: 終値が押し安値を割った＝転換の**兆し**（未確定）。
  - 2回目: その後に谷、それより低い山（戻り高値の切り下げ）ができ、終値がその谷を割ったら下降への転換が**確定**。確定する前に終値が元の上昇の高値を超えたら**取消**（上昇が続行）。下降から上昇も同じ。
  - 判定は確定した足の終値だけ。
- **作り**（エッジ関数 `live-chart` v6 と画面）:
  - `action: "dow"`: 通貨ペアの 4時間・1時間・15分・5分（金は 4時間・1時間・15分。5分足は Twelve Data の無料枠の都合）を、それぞれ確定足 `DOW_BARS` = 300本で判定して返す（状態・いつから・押し安値／戻り高値・直近の山と谷・山と谷30個・出来事20個）。FX は GMO の足（`fetchDowQuotes`）、金はチャートと同じ `live_chart_fallback` の保存（足が確定するまで読み直さない）。インスタンス内で時間足ごとに、新しい足が確定するまで読み直さない（市場が閉まっている可能性がある間は5分ごと）。4つの時間足は並行して読む。
  - 金の Twelve Data の回数: 見ている人がいる間、15分足は15分に1回・1時間足は1時間に1回・4時間足は4時間に1回まで（チャートと同じ時間足なら同じ保存を使うので増えない）。
  - 画面: 設定の「ダウ理論」がオンの間（初期値オン）、1分ごとに読む。チャートの下に4つの時間足の状態（上昇／下降／兆し／判定なし）・押し安値か戻り高値・いつから、全画面では上に1行。チャートには、**その時間足の**山と谷（HH・HL・LH・LL と、それをつなぐ細い線）、押し安値／戻り高値の線（割れたら破線）、① と「確定」「取消」の印、**上位足の**押し安値／戻り高値（太い点線）と直近の山・谷（細い点線）を右端にラベル付きで描く。1分足・日足は判定の対象外（上位足の線だけ、日足は無し）。上位足の線は値幅の外なら描かない（値幅を広げない）。
- **元と違う点・対象外**: 本人の判定と同じになるとは限らない（山と谷の幅、終値での判定、2回目の条件はこちらで決めた）。表示のみで、サインの判定・メール・成績の記録には使っていない。過去のチャートでの成績は §8.43 で測った。
- **確かめたこと**: テスト `dow.test.tsx`（段ごとに作った相場で、高値更新・1回目・確定・安値更新・逆向きの1回目・確定が決めた足で起きること、取消、どの足で止めても過去の判定が変わらないこと、関数が返す日時・丸め・形成中の足を除くこと、金は5分足なし、アプリ側の読み込み、チャートのラベル・線・印・上位足の線・説明・オンオフ、リアルタイムチャートで4つの時間足の表示・ペアを変えると読み直す・オフなら読まない・読めないときの表示）。`deno check`（live-chart）。Chromium で、関数の読み方で作った足を PC・スマホ幅と全画面で表示して確認。**本番の GMO・Twelve Data からの読み込みは、公開後に画面で確かめる**（ここからは本番の関数をログインして呼べない）。

### 8.43 ダウ理論の兆し・確定を過去のチャートで測った（#130、研究のみ）

- **その後（#179、2026-10-02）**: 出来事の足ではなく、チャートの1行が出ている間（5分ごと、5分足を含む4つの時間足）の当たりを、今の設定（左右4本）で測った。当たりはランダムに入った場合とほぼ同じ（約48〜52%）で、売買すると1回あたりどれもマイナス。ここと同じ結論（§8.90）。
- **指示**: 「測って」（§8.42 のダウ理論）。
- **方法**（SPECTRA 型 §8.33・Zone Shift §8.38 と同じ `research/gainz.ts`、`gainz.yml` で実行。run 36283784785、週ごとの確認は run 36283969642）:
  - GMO の15分足（2024-01-01〜2026-09-25）11ペアを 15分・1時間・4時間で。前半 2024-01〜2025-06、後半 2025-07〜。スプレッド込み。15分・1時間は UTC 17〜23時を除く。
  - 判定はチャートと同じ `supabase/functions/_shared/dow.ts`（山と谷は左右5本、終値）を研究から直接読み込み、各ペアの全履歴で計算。
  - 入り方（データを見る前に決めた。どれもその足の終値で入る）:
    - `dow_update`: トレンド中の高値・安値の更新で、トレンドの向きに。
    - `dow_break1`: 1回目（押し安値・戻り高値を終値で抜けた足）で、抜けた向きに。
    - `dow_confirm`: 2回目（転換の確定）で、新しい向きに。
    - `dow_update_htf`・`dow_confirm_htf`: 上の2つを、1つ上の時間足（15分→1時間、1時間→4時間）の最後の確定足が同じ向きのトレンド（上昇なら買い・下降なら売り）のときだけにしたもの。4時間足には上がないので対象外。
  - 出口は r2w（損切り ATR×1・利確2倍）と split（半分は利確1倍・半分は2倍）。48本で打ち切り。物差しは同じペア・時間足・向き・時刻に毎本入った場合との差（lift）、95%の幅は週ごとのまとまりで計算。順位付けはせず、両期間とも出す。
  - 動画の5分足は測っていない（履歴が15分足）。金も対象外（GMO にない）。
- **結果**（r2w、全時間足。損益ゼロの勝率は 33.3%。ランダムに入った場合は前半 −0.094R・後半 −0.114R）:

| 入り方 | 期間 | 回数 | 勝率 | 1回あたり [95%の幅] | ランダムとの差 [95%の幅] |
|---|---|---|---|---|---|
| 更新 `dow_update` | 前半 | 6,542 | 30.6% | −0.081R [−0.136〜−0.027] | +0.007R [−0.048〜+0.062] |
| 更新 `dow_update` | 後半 | 5,434 | 31.3% | −0.062R [−0.115〜−0.008] | +0.042R [−0.011〜+0.096] |
| 1回目 `dow_break1` | 前半 | 3,755 | 31.3% | −0.058R [−0.113〜−0.004] | +0.035R [−0.019〜+0.090] |
| 1回目 `dow_break1` | 後半 | 3,094 | 29.9% | −0.101R [−0.167〜−0.035] | +0.017R [−0.049〜+0.083] |
| 確定 `dow_confirm` | 前半 | 2,409 | 29.7% | −0.108R [−0.165〜−0.050] | −0.011R [−0.068〜+0.047] |
| 確定 `dow_confirm` | 後半 | 2,059 | 28.6% | −0.139R [−0.210〜−0.069] | −0.026R [−0.097〜+0.044] |
| 更新＋上位足 `dow_update_htf` | 前半 | 3,327 | 31.5% | −0.055R [−0.133〜+0.024] | +0.036R [−0.044〜+0.115] |
| 更新＋上位足 `dow_update_htf` | 後半 | 2,671 | 29.9% | −0.102R [−0.167〜−0.036] | +0.009R [−0.056〜+0.075] |
| 確定＋上位足 `dow_confirm_htf` | 前半 | 571 | 25.9% | −0.222R [−0.332〜−0.113] | −0.120R [−0.230〜−0.010] |
| 確定＋上位足 `dow_confirm_htf` | 後半 | 472 | 30.8% | −0.074R [−0.196〜+0.048] | +0.038R [−0.083〜+0.158] |

  - 時間足別（前半 / 後半、1回あたり・差）:
    - 更新: 15分 −0.087R・+0.015 / −0.070R・+0.051、1時間 −0.080R・−0.020 / −0.027R・+0.036、4時間 −0.017R・+0.001 / −0.066R・−0.052。
    - 1回目: 15分 −0.062R・+0.043 / −0.125R・+0.005、**1時間 +0.007R・+0.074 / +0.006R・+0.093 [−0.064〜+0.249]**、4時間 −0.215R・−0.187 [−0.364〜−0.010] / −0.115R・−0.054。
    - 確定: 15分 −0.107R・+0.003 / −0.184R・−0.055、1時間 −0.156R・−0.090 / +0.021R・+0.097 [−0.053〜+0.246]、4時間 +0.034R・+0.069 / −0.136R・−0.091。
    - 確定＋上位足: 15分 −0.122R・−0.008 / −0.105R・+0.023、1時間 −0.628R・−0.572 [−0.747〜−0.396]（113回・勝率12.4%）/ +0.029R・+0.086（110回・33.9%）。
  - ペア別に1回あたりがプラス（r2w、全時間足）: 更新 3/11・2/11、1回目 3/11・3/11、確定 2/11・1/11、更新＋上位足 4/11・1/11、確定＋上位足 0/11・4/11。
  - split も同じ傾向（確定: 前半 −0.122R・差 −0.026、後半 −0.138R・差 −0.024。1回目: −0.065R・+0.029 / −0.106R・+0.013）。
  - **確定＋上位足の1時間足・前半**（勝率12.4%）だけ極端だったので、週ごとに見た（`WEEKS_OF`）: 56週に散らばり（1週最大6回）、特定の週の出来事ではない。後半は 110回・33.9% で消えた。実装の誤りなら両方の期間に出るはずで、後半の独立したデータで再現しないので、多くの組を見たときに出る偏りとして扱う（この組を避ける・逆にするといった使い方もしない）。
- **結論**:
  - スプレッドを払うと、どの入り方もどちらの期間でもマイナス。ランダムに入った場合との差は、どれも誤差の範囲。
  - **「2回目で確定」まで待っても良くならない**: 確定は1回目より、両期間とも差がわずかに低い（−0.011 / −0.026 に対し +0.035 / +0.017、どちらも誤差の範囲）。
  - 上位足と同じ向きに限っても改善しない。
  - 1時間足の1回目だけ両期間で 1回あたり ほぼ0（+0.007R / +0.006R）。GA型・SPECTRA型・Zone Shift と同じく「1時間足はわずかにましで、それでも勝てない」の範囲。結果を見てから選ぶと偶然を拾うので（§8.24 のルール4）、ダウ理論をサインやメールに使う変更はしない。チャートの表示はそのまま（既定オン）、説明文にこの結果を書いた。
- **研究コードの追加**: `WEEKS_OF`（「ルール|出口|disc か val|範囲」を ; 区切り、`gainz.yml` の手動実行の入力 `weeks_of`）で、指定した組の週ごとの回数・勝ち・R を出せるようにした。

### 8.44 GainzAlgo Suite の「Pro」の説明を独自の式にした点数方式（Pro型）を作って測った（#131）

- **指示**: TradingView の GainzAlgo Suite のページ（https://jp.tradingview.com/script/h7UO9YR8-GainzAlgo-Suite/）に「どういうしくみだと思う？」→「作って測って」。
- **ページで確かめたこと**（`pine-source.yml` で読んだ。run 36313245521）: 招待制でコードは非公開（TradingView が「ソースを見る権限がない」と返す）。1つのスクリプトに5つのモデル（Standard・Pro・V2 Essential・V2 Proficient・V2 Alpha）があり、どれを使えるかは購入したライセンスキーで決まる。どれも確定足で判定し、後から印は変わらないとある。
  - Standard の説明は「ローソク足の反転の形・値幅の確認・勢いの確認・短期トレンドの確認の4つが全部そろったらサイン」。§8.25 の設定（0.5・50・5・1:2）と第三者が報告した V2 Alpha の4条件（包み足・実体が値幅の半分超・RSI 50未満・終値が5本前より安い）に一対一で当てはまる（アプリの GA型）。ただしページでは V2 Alpha が「条件がいちばん多い」とされ、V2 Alpha に設定欄に出ない条件があるのかは分からない。
  - Pro の説明は「足の形・値動きの大きさ・勢い・トレンドを点数にして重み付けし、値動きの大きさは順位で正規化し、直近の相場から決まるしきい値を超えたらサイン」。部品の名前（CSTA・SAMSM・CSMRM）はあるが式はない。
- **作ったもの**（`src/lib/gainzPro.ts`。式はこのアプリの独自の読み方で、データを見る前に固定）:
  - 必要条件: 陰線→陽線の確定足（売りは陽線→陰線）。
  - 4つの部品（買いの向き。売りは鏡像）: ①足の形＝終値の位置×実体の割合（必要条件がなければ0）②RSI(14) の加速＝この足の変化−前の足の変化 ③値幅の広がり＝真の値幅÷直前の ATR(14) ④EMA(50) の10本の傾き（ATR で割る。押し目買いの読み方で、上向きほど買いの点が高い）。
  - それぞれを直近100本の中の順位（0〜1）にして平均した点数が、直近100本の点数の上位5%に入った足でサイン。最初のサインまでに約260本要る。
  - 研究では、4つの `gp_score` と、傾きを外した3つの `gp_rev` を測った。
- **画面**: チャートのインジケーター一覧に「Pro型（点数）」（既定オフ）。オンにすると、サインの足に丸付きの P（買いは足の下に緑、売りは上に赤。同じ足に GA型のラベルがあれば1段外側）。計算にはリアルタイムチャートが Zone Shift 用に読む過去の足（`history`）を使い、Pro型だけオンでも読む。説明文に式と結果を書いた。サイン・メール・成績の記録には使わない。
- **測り方**: §8.38・§8.43 と同じ `research/gainz.ts`（11ペア、15分・1時間・4時間、前半 2024-01〜2025-06 / 後半 2025-07〜、スプレッド込み、15分・1時間は UTC 17〜23時を除く、r2w と split、ランダムに入った場合との差）。順位付けはせず、GA型（Standard の読み方）と並べて両期間とも出した。run 36313514919。
- **結果**（r2w、全時間足。損益ゼロの勝率は 33.3%）:

| 読み方 | 期間 | 回数 | 勝率 | 1回あたり [95%の幅] | ランダムとの差 [95%の幅] |
|---|---|---|---|---|---|
| Pro型 `gp_score`（4つ） | 前半 | 51,811 | 30.2% | −0.093R [−0.119〜−0.068] | −0.001R [−0.026〜+0.024] |
| Pro型 `gp_score`（4つ） | 後半 | 43,665 | 29.3% | −0.118R [−0.141〜−0.095] | −0.005R [−0.028〜+0.018] |
| 傾きなし `gp_rev`（3つ） | 前半 | 51,651 | 30.5% | −0.083R [−0.104〜−0.061] | +0.008R [−0.014〜+0.029] |
| 傾きなし `gp_rev`（3つ） | 後半 | 43,545 | 29.4% | −0.117R [−0.137〜−0.096] | −0.004R [−0.025〜+0.017] |
| GA型（Standard の4条件） | 前半 | 12,880 | 30.4% | −0.086R [−0.117〜−0.054] | +0.011R [−0.020〜+0.042] |
| GA型（Standard の4条件） | 後半 | 10,757 | 28.8% | −0.134R [−0.165〜−0.103] | −0.015R [−0.047〜+0.016] |

  - 時間足別（Pro型、前半 / 後半、1回あたり・差）: 15分 −0.106R・−0.002 / −0.131R・−0.003、1時間 −0.056R・+0.009 / −0.089R・−0.011、4時間 −0.050R・−0.025 / −0.054R・−0.007。
  - ペア別に1回あたりがプラス: Pro型も傾きなしも両期間とも 0/11。
  - split も同じ（Pro型: 前半 −0.089R・差 +0.003、後半 −0.118R・差 −0.004）。
  - 回数は GA型の約4倍で、後半は対象の足（両側の毎本入り 645,785回＝足 322,892本）の約13.5%に出た。上位5%は直近100本との比較なので、相場が続けて動く間は5%より多く通る。
  - 細かく分けると前半だけ幅がゼロをまたがない組がある（傾きなしの1時間足 split: 差 +0.034 [+0.003〜+0.065]）が、後半は −0.008 で消えた。
- **結論**: この読み方の点数方式は、ランダムに入った場合と区別がつかず、スプレッドの分だけ負ける。傾き（トレンド）の点を入れても外しても同じ。GA型（Standard の読み方）とも差がない。結果を見て式を変えると偶然を拾うので（§8.24 のルール4）、式は変えず、サインやメールにも使わない。
- **言えないこと**: GainzAlgo の本物の Pro の式は非公開で、ここで作ったものは説明文から作った独自の読み方。「GainzAlgo の Pro が効かない」とは言えず、言えるのは「説明文どおりの考え方（反転の足の形・勢い・値幅・トレンドの点数を順位で正規化し、相対的なしきい値で出す）を素直に式にしたものは、FX 11ペアではランダムと変わらない」まで。金は試していない（GMO にない）。
### 8.45 各インジケーターの数字の設定を総当たりし、前半で勝率が最も高かった設定に変えた（#132）

- **指示**: 「それぞれのインジケーターを無理やりどういう設定にしたら勝率が上がるか検証して、一番勝率の高い設定を探してそれをそのインジケーターに設定してください。それぞれのインジケーターの分析の仕方はもちろん守って」→「それぞれのインジケーターはなんかの数字を設定しているでしょ？中で それのベストを探して欲しい」。
- **決め方**（データを見る前に `research/tune.ts` の先頭に固定）:
  - 読み方（どの足で何を見るか）は変えず、数字の設定だけを、前もって決めた格子で総当たりした。今の設定は必ず格子に入れた。
  - 出口はインジケーターごとに固定し、探さない。利確を近づければ勝率はいくらでも上がるが、入る時の良し悪しは変わらないため。GA型とチャートだけのインジケーター: 損切り ATR×1・利確2倍（r2w、損益ゼロの勝率 33.3%）。RSI＋SAR: アプリのプラン（損切り ATR×0.8・利確1.5倍、損益ゼロ 40%）。出口が同じなら勝率が高い＝1回あたりも良い。
  - 条件は `research/gainz.ts` と同じ（GMO の15分足の Bid/Ask、2024-01〜、11ペア、15分・1時間・4時間、スプレッド込み、15分・1時間は UTC 17〜23時を除く、48本まで、同じペア・時間足・向き・時刻にランダムに入った場合との差、週ごとにまとめた95%の幅）。
  - **選び方**: 前半（2024-01〜2025-06）で300回以上入った設定のうち、3つの時間足を合わせた勝率が最も高いもの。後半（2025-07〜2026-09-25）は選ぶのに使わず、確かめるだけに使う。後半で悪くても、前もって言ったとおり選んだ設定にする。
  - Weighted Volume Profile はサインを出さないので勝率がなく、対象外。
- **run**: `tune.yml` の run 36314734948（勝率の分母などの表示を足す前の run 36314354075 でも、選ばれた設定は8つとも同じ）。
- **格子**（数は300回以上の設定 / 全体）:
  - GA型: 実体の割合 0.3〜0.8・RSI の水準 30〜70・何本前と比べるか 2〜15（139 / 180）。
  - RSI＋SAR: RSI の期間 7・9・14・21、水準 20〜40、SAR の加速 0.01・0.02・0.03（上限はその10倍）（47 / 60）。
  - SPECTRA型: 倍率 1.5〜4、ATR 7〜20、カルマンの r 0.02・0.1・0.5（60 / 60）。
  - Zone Shift: 長さ 50〜200、値幅の本数 100・200・400、再テストの間隔 3・5・10（45 / 45）。
  - ダウ理論: 山と谷の左右の本数 2〜12（8 / 8）。
  - Pro型: 順位の本数 50・100・200、しきい値 0.8〜0.98、EMA 20・50・100（36 / 36）。
  - ストキャス: %K の期間 5〜21、平滑 1・3・5、水準 70〜90（下はその鏡像）（60 / 60）。
  - FVG Crossfire: 埋まり判定の遅れ 1〜5本、最小のギャップ幅 0〜0.05%（15 / 20）。
- **結果**（全時間足。1回あたりはスプレッド込み）:

| インジケーター | 設定（今 → 選んだ） | 前半 今 | 前半 選んだ | 後半 今 | 後半 選んだ | 後半のランダムとの差（今 → 選んだ） |
|---|---|---|---|---|---|---|
| GA型 | 0.5・RSI 50・5本 → 0.7・RSI 40・5本 | 12,880回 30.4% −0.086R | 2,036回 32.6% −0.019R | 10,757回 28.8% −0.134R | 1,754回 30.1% −0.093R | −0.015R → +0.025R [−0.057〜+0.107] |
| RSI＋SAR | RSI(14) 30/70 → RSI(9) 25/75（SAR 0.02/0.2 のまま） | 1,514回 36.9% −0.077R | 931回 38.6% −0.036R | 1,255回 35.0% −0.125R | 802回 35.5% −0.112R | +0.007R → +0.022R [−0.068〜+0.113] |
| SPECTRA型 | ATR 10・倍率3・r 0.1 → ATR 7・倍率1.5・r 0.02 | 8,515回 31.2% −0.062R | 18,885回 31.6% −0.050R | 7,164回 29.4% −0.116R | 15,901回 29.2% −0.121R | −0.002R → −0.008R [−0.040〜+0.024] |
| Zone Shift | 100・200・5 → 75・200・10 | 15,128回 30.3% −0.088R | 12,058回 31.1% −0.064R | 12,361回 29.9% −0.102R | 10,056回 29.2% −0.122R | +0.010R → −0.011R [−0.047〜+0.024] |
| ダウ理論 | 左右5本 → 4本 | 2,409回 29.7% −0.108R | 2,826回 30.7% −0.078R | 2,059回 28.6% −0.139R | 2,460回 29.4% −0.117R | −0.026R → −0.005R [−0.074〜+0.064] |
| Pro型 | 100本 → 50本（0.95・EMA 50 のまま） | 51,811回 30.2% −0.093R | 52,029回 30.6% −0.082R | 43,665回 29.3% −0.118R | 43,752回 29.5% −0.114R | −0.005R → −0.000R [−0.022〜+0.022] |
| ストキャス | 14・1・3、80/20 → 21・5・3、70/30 | 55,389回 29.9% −0.102R | 20,855回 30.8% −0.076R | 46,684回 29.1% −0.125R | 17,317回 28.7% −0.136R | −0.007R → −0.018R [−0.045〜+0.010] |
| FVG Crossfire | 遅れ3本・最小幅0 → 遅れ3本・0.05% | 25,847回 30.3% −0.088R | 8,229回 31.2% −0.063R | 22,085回 29.0% −0.128R | 5,287回 31.4% −0.057R | −0.012R → +0.042R [−0.005〜+0.089] |

  - RSI＋SAR の損益ゼロは 40%（出口がアプリのプラン）。ほかは 33.3%。RSI＋SAR の「1 ATR 先に届いた割合」（r1w、後半）は 45.6% → 45.3%。
  - FVG は遅れ2本と3本が両期間とも同じ数字（同点）だったので、遅れは今の3本のまま、最小幅だけ変えた。
  - 前半の勝率の順位と後半の勝率の順位の相関（順位相関）: GA型 0.18、RSI＋SAR −0.23、SPECTRA型 −0.10、Zone Shift −0.48、ダウ理論 0.10、Pro型 −0.25、ストキャス −0.25、FVG 0.99。FVG 以外は、前半で良かった設定が後半でも良いという関係がほぼ無いか逆。
  - GA型の時間足別（選んだ設定、ランダムとの差、前半 / 後半）: 15分 +0.072R / +0.017R、1時間 +0.146R / −0.019R、4時間 −0.050R / +0.252R。
- **読み方**:
  - 後半で今の設定より良かったのは GA型・RSI＋SAR（わずか）・ダウ理論・Pro型（わずか）・FVG の5つ。SPECTRA型・Zone Shift・ストキャスの3つは後半で今の設定より悪かった。
  - 設定どうしの差はほとんどが偶然の範囲。たくさんの設定から前半の1位を選ぶと、前半の数字は運の分だけ高く出る。後半では、今の設定との勝率の差が FVG 以外はどれも縮むか逆になった（GA型 +2.2 → +1.3ポイント、ストキャス +0.9 → −0.4ポイントなど）。順位相関がほぼゼロなのもそのため。例外は FVG で、最小のギャップ幅が大きいほど良いという並びが両期間で同じだった（小さな隙間を捨てる。差は +0.9 → +2.4ポイント）。今の設定も含めて後半は前半より全体に勝率が低く、これは設定ではなく相場の違い。
  - どの設定も後半の1回あたりはマイナスで、ランダムとの差の95%の幅はすべてゼロをまたぐ。**勝てる設定が見つかったわけではない。**
  - サインの回数（後半、今 → 選んだ）: GA型は約6分の1、FVG は約4分の1、ストキャスは約3分の1、RSI＋SAR は約3分の2に減る。Zone Shift は約2割減る。SPECTRA型は約2.2倍、ダウ理論は約1.2倍に増える。Pro型はほぼ同じ。
- **アプリに入れたこと**（選んだ設定をそのまま既定にした）:
  - GA型（`analyze/gainz.ts`）: `GA_STABILITY` 0.7・`GA_RSI_LEVEL` 40・`GA_DELTA` 5、RSI の期間を `GA_RSI_PERIOD` = 14 として明示（RSI＋SAR の期間を変えても GA型が引きずられないように）。ルール ID を `gainz_v2a_050_50_5_atr1_v1` → `gainz_v2a_070_40_5_atr1_v2`。
  - RSI＋SAR（`analyze/rsisar.ts`）: RSI(9)・25/75。ルール ID を `rsi14_30_70_psar_v1` → `rsi9_25_75_psar_v2`。AI 分析の指示文・メール・チャート・説明文も定数から作るようにした。
  - 成績の記録（`signal-alerts`）: 今のルール ID の行だけを数える。古い設定のサインはどちらの成績にも入らないので、成績は新しい設定のサインから数え直しになる。過去の検証の数字（`BACKTEST`・`GA_BACKTEST`）は上の後半の数字に差し替えた。
  - SPECTRA型 ATR 7・倍率1.5・q 0.01/r 0.02、Zone Shift 75・200・10、ダウ理論 左右4本（`_shared/dow.ts` の `DOW_PIVOT`）、Pro型 50本、ストキャス 21・5・3 と線 70/50/30、FVG 最小幅 0.05%。（SPECTRA型・Zone Shift・ストキャスは #133 で元に戻した。下の「その後」）
  - ストキャスは利用者が画面で設定を変えられるので、保存されている設定が元の既定（14・1・3）のままで印（`stochDefaults: 132`）が無いときだけ新しい既定に移す。自分で変えた設定はそのまま。（#133 で戻した）
  - リアルタイムチャートのおすすめ時間足: §8.27 と同じ基準（GA型の3つの時間足のうち、前半・後半ともランダムより良かったもの）を新しい設定に当てると15分足だけ（+0.072R・+0.017R、どちらも誤差の範囲）なので、1時間足 → 15分足に変えた。
  - 各インジケーターの説明文に、選び直したこと・元の設定・後半の数字を書いた。
- **言えないこと**: この選び方で前半の1位を選んでも、後半で良くなるとは限らない（3つは悪くなった）。「最も勝率の高い設定」は前半のデータでの話で、これからの相場で最も勝率が高い設定という意味ではない。金は試していない（GMO にない）。
- **その後（#133）**: 指示「後半で悪くなった3つ戻して」で、SPECTRA型（ATR 10・倍率3・q 0.01/r 0.1）・Zone Shift（100・200・5）・ストキャス（14・1・3、線 80/50/20）を #132 の前の設定に戻した。
  - ストキャスの保存済みの設定: #132 の間に保存されたもの（印 `stochDefaults: 132`）が 21・5・3 のままなら、既定だったから持っていたものとして 14・1・3 に戻す。印 132 で別の数字のもの、印の無い 21・5・3（#132 より前に自分で選んだもの）はそのまま。これから保存する設定には印 133 を付けるので、この後に自分で 21・5・3 を選んでも戻さない。
  - 3つの説明文は #132 の前の文に戻し、「#132 で前半1位だった設定は後半で元の設定より悪かったため元に戻した」と数字（勝率）付きで1文足した。
  - 残りの5つ（GA型・RSI＋SAR・ダウ理論・Pro型・FVG）と、リアルタイムチャートのおすすめ時間足（15分足）は #132 のまま。

### 8.46 ストキャスのサインがダマシかどうかを判定できるかを測った（#134、研究のみ）

- **指示**: 4時間足で、上げ続けているのに %K が80を何度も割るスクリーンショットに「ダマシがなくなるストキャスの設定あります？」→（設定では無理と答えたあと）「ストキャスが騙しかどうかを判断するためのインジケーター考えて」。
- **決め方**（データを見る前に `research/stochfake.ts` の先頭に固定。`stochfake.yml`、run 36317961217）:
  - サイン: アプリのストキャス（14・1・3、線 80/20）の %K が80を上から下に抜けたら売り、20を下から上に抜けたら買い。
  - ダマシ＝負け。出口は損切り ATR×1・利確2倍（r2w、損益ゼロ 33.3%）。条件は §8.45 と同じ（11ペア、15分・1時間・4時間、前半 2024-01〜2025-06 / 後半 2025-07〜、スプレッド込み、15分・1時間は UTC 17〜23時を除く）。
  - 警告3つ（サインの足の終値で分かることだけ）: ①ADX(14) が25以上で逆向きの DI が上（強いトレンドに逆らう）②1つ上の時間足（15分→1時間、1時間→4時間、4時間→日足）のダウ理論が逆向きのトレンド ③直前14本のうち10本以上、%K が80以上（買いは20以下）に張り付いていた。
  - 判定: 警告ごと、警告が1つも無いものだけ通す、2つ以上ならダマシ、そして「確認待ち」（5本以内に終値がサインの足の安値〈買いは高値〉を抜けたら、その足で入る）。
  - 選び方: 前半で通したサインの勝率が最も高い判定（前半で300回以上通したもの）。後半で「通したもの − 外したもの」の勝率の差の95%の幅がゼロより上なら効いたとする。
  - 実データの前に、ランダムな値動き（`SYNTHETIC`）で試したところ、確認待ちの「外したもの」が勝率2%になった。確認されなかったかどうかはサインの後にしか分からず、価格が逆に行ったものが集まるため（先読み）。そこで確認待ちは、すべてのサインと比べることにした。直したあと、ランダムな値動き11ペアではどの判定も差がゼロ前後だった。
- **結果**（全時間足。後半）:

| 判定 | 通した 回数・勝率 | 外した 回数・勝率 | 通した − 外した [95%] |
|---|---|---|---|
| 判定なし（すべて） | 46,684回 29.1%（−0.125R） | — | — |
| ①ADX | 29,775回 28.3% | 16,909回 30.6% | −2.3ポイント [−3.7〜−0.9] |
| ②上位足のダウ | 30,414回 28.8% | 16,270回 29.7% | −0.9 [−2.3〜+0.4] |
| ③張り付き | 39,719回 29.0% | 6,965回 29.7% | −0.7 [−2.2〜+0.7] |
| 警告なしだけ | 18,910回 28.1% | 27,774回 29.8% | −1.7 [−3.0〜−0.3] |
| 2つ以上でダマシ | 36,633回 28.6% | 10,051回 30.8% | −2.2 [−3.8〜−0.6] |
| 確認待ち（すべてと比べる） | 27,731回 29.0%（−0.126R） | — | −0.1 [−0.7〜+0.5] |

  - 前半で選ばれたのは確認待ち（前半 30.4%、すべてのサインより +0.5ポイント [−0.1〜+1.1]）。後半は 29.0% で、すべてのサインと同じ。**判定として効かなかった。** 時間足別（後半、すべてのサインとの差）: 15分 −0.3、1時間 +0.9、4時間 +0.4ポイントで、どれも幅がゼロをまたぐ。
  - 警告は逆向きに出た。ADX・警告なし・2つ以上の3つは、前半も後半も「ダマシ」とした側のほうが勝率が高かった（前半 −1.3・−1.3・−1.2ポイント）。「強いトレンドに逆らうストキャスのサインはダマシ」は、このデータでは成り立たなかった。
  - ただしこれは結果を見てから分かった向きで、前もって立てた仮説ではない。「ダマシ」とされた側も勝率は 29.8〜30.8% で損益ゼロの 33.3% に届かず、1回あたり −0.07〜−0.10R（後半）。逆に使っても勝てる根拠にはならない。
  - 警告が付いた割合（両期間）: ①36.8%、②34.9%、③15.2%。
- **結論**: 前もって決めたやり方では、ストキャスのサインのダマシを見分ける判定は作れなかった。チャートには載せない（効かない判定を出すと、見分けられると誤解させるため）。

### 8.47 チャートにボリンジャー %b と RCI を追加した（#135）

- **指示**: ストキャスのダマシの話（§8.46）のあと「ストキャスとは計算の仕方が違うが、今、最近の値幅の上の方か下の方かを見る目安として使うインジケーターを探して」→「TradingView にあるかも調べてみて」→「両方入れますか？」（候補のうち勧めた %b と RCI の両方）。
- **TradingView で確かめたこと**（公式ヘルプの日本語版を `pine-source.yml` で読んだ。run 36327705461・36327739903〜36327745439）:
  - ボリンジャーバンド %b（43000501971）、RCI（43000765570）、CCI（43000502001）、RSI（43000502338）は標準のインジケーター。ケルトナーチャネル（43000502266）は帯だけで、帯の中の位置を出すものは標準に無い。終値の順位（パーセンタイル）は標準に無く、公開スクリプト（Percentile Rank [racer8]、直近 n 本の終値のうち今より安いものの割合、初期値100本）がある。
  - 初期設定はヘルプの設定画面の画像で確かめた: %b は Length 20・Source Close・StdDev 2、線は 1.00・0.50・0.00。RCI は Source Close・RCI Length 10・平滑化 SMA 14、線は +80・0・−80。
- **計算**:
  - `src/lib/percentB.ts`: %b =（終値 − 下のバンド）÷（上のバンド − 下のバンド）、バンド = 20本の SMA ± 2 × 標準偏差（母標準偏差、Pine の `ta.stdev` の既定と同じ）。値幅ゼロの窓は値なし。
  - `src/lib/rci.ts`: 直近10本の終値の順位（安い順に0から、同じ値は位置の平均）と時間の順番のピアソン相関 ×100。ヘルプの例（10・12・15・12 → 0・1.5・3・1.5）どおり。同じ値が無ければ研究側の `rciSeries`（スピアマンの式）と一致する。黄色の線は RCI の14本 SMA。
- **画面**: チャートの一覧に「BB %b 20 2」「RCI 10」（既定はオフ。スマホで帯が増えすぎないため）。オンにするとストキャスの下に帯を出す。%b は青い線、1.00・0.50・0.00 の点線、帯の内側を青・上を赤・下を緑で薄く塗り、縦の目盛りは画面の値に合わせる（0〜1 は常に入れる）。RCI は青い線と黄色の平均線、±80・0 の点線。右の軸に値のタグ（黄色のタグは文字を黒に）。説明文に計算と「反転の合図ではない」ことを書いた。表示のみで、サイン・メール・成績には使わない。
- **言えること・言えないこと**: どちらも「最近の値幅の上の方か下の方か／どれだけ一方向に動いたか」の目安で、ランダムな値動きで計算するとストキャス（14・1・3）との順位相関は %b 0.96・RCI 0.82（中身の大部分は同じ情報）。先の向きを当てる力は測っていない。

### 8.48 SuperTrend（KivancOzbilgic、公開コード）をチャートに追加した（#136）

- **指示**: Pine のソースを貼って「https://jp.tradingview.com/script/r6dAP7yi/ このインジケーター追加して」。
- **ソースの確認**: `pine-source.yml` でページと公開ソースを読んだ（run 36329776599）。公開ソース（v3.0、37行、Pine v4）は貼られたコードと同じ。ページの説明: ATR の計算は既定が RMA（設定で SMA に替えられる）、既定は期間10・倍率3、「横ばいの相場では一般にうまくいかない」。スクリプト ID が英大文字・小文字まじり（`PUB;VfOP…`）で、ワークフローが16進数しか拾っていなかったので直した。
- **移植**（`src/lib/supertrend.ts`、既定のまま）:
  - Source hl2、ATR は Pine の `atr(10)`（真の値幅の RMA。最初の10本の単純平均から始め、1本目の真の値幅は高値−安値）。
  - `up = hl2 − 3×ATR`（前の足の終値が前の up より上なら、前の up より下げない）、`dn = hl2 + 3×ATR`（同様に上げない）。
  - 向きは、下降中に終値が前の dn を上に抜けたら上昇、上昇中に終値が前の up を下に抜けたら下降。
  - 確かめ方: Pine の na の扱いどおりに別に書いた Python の実装と、ランダムな値動き3,000本で線・向き・転換（61回）が完全に一致した。手で計算した5本の例をテストに入れた。
- **画面**: チャートの一覧に「SuperTrend 10 3」（既定はオフ）。オンにすると、上昇中は下の線を緑、下降中は上の線を赤で描く（向きが変わるところで線を切る）。転換した足の線上に ● と「Buy」「Sell」のラベル。線とローソク足の平均（ohlc4）の間を薄く塗る。確定足だけで判定し、形成中の足には描かない（元は形成中の足にも描く）。説明文に仕組みと、過去の検証はまだしていないこと（同じ仕組みをカルマンフィルターでならした SPECTRA型は #120 でランダムと差がなかったこと）を書いた。表示のみで、サイン・メール・成績には使わない。

### 8.49 UT Bot Alerts（QuantNomad、公開コード）をチャートに追加した（#137）

- **指示**: 「https://jp.tradingview.com/script/n8ss8BID-UT-Bot-Alerts/ これ使って」。
- **ソース**: `pine-source.yml` で公開ソースを読んだ（run 36330314248、v1.0、42行、Pine v4）。説明: UT Bot は Yo_adriiiiaan が作り、元の考えは HPotter。これは QuantNomad が自分の UT Bot Strategy のアラート版として公開したもの。
- **移植**（`src/lib/utBot.ts`、既定のまま: Key Value 1、ATR Period 10、Heikin Ashi の足で判定する設定はオフ＝移植していない）:
  - 損切りの線（トレーリングストップ）: 終値が線の上にいる間（この足と前の足）は `max(前の線, 終値 − 1×ATR)`、下にいる間は `min(前の線, 終値 + 1×ATR)`、抜けたら反対側で `終値 ∓ 1×ATR` からやり直す。前の線が無いときは0として比べる（Pine の `nz`）。ATR は Pine の `atr()`（§8.48 と同じ RMA）。
  - Buy = 終値が線を上に抜けた足、Sell = 下に抜けた足（元は `crossover(ema(close,1), 線)`。1本の EMA は終値そのもの）。
  - 足の色: 終値が線より上なら緑、下なら赤（元の `barcolor`）。
  - 確かめ方: Pine の na の扱いどおりに別に書いた Python の実装と、ランダムな値動き5,000本で線の値、Buy 316回、Sell 316回が完全に一致した。手で計算した5本の例をテストに入れた。
- **画面**: チャートの一覧に「UT Bot 1 10」（既定はオフ）。オンにすると Buy を足の下、Sell を足の上にラベルで出し、ローソク足を緑・赤で塗る（Zone Shift の色より優先）。元のとおり線そのものは描かない。確定足だけで判定し、形成中の足は塗らない。表示のみで、サイン・メール・成績には使わない。過去の検証はしていない。
- その後（#176）: ローソク足の色は、Zero-lag TEMA がオンならそちらが優先（§8.87）。

### 8.50 リアルタイムチャートを4時間足で開くようにした（#138）

- **指示**: 「4時間足を基本にしてください」。
- **変えたこと**: リアルタイムチャートの最初の時間足を15分足 → 4時間足（`LiveChart.tsx` の `BASE_INTERVAL`。元の名前は `RECOMMENDED_INTERVAL`）。1分足の無い金に切り替えたときに移る先も4時間足。分析の時間足は #111 から4時間足が初期値で、変えていない。
- **これまでの決め方との違い**: おすすめの時間足は、§8.27（1時間足）と §8.45（15分足）では「GA型が前半・後半ともランダムより少し良かった時間足」で選んでいた。今回は所有者の指定で4時間足にした。GA型の説明文の下の文は、次の事実に書き換えた。
  - 4時間足はスプレッドが損切り幅に占める割合が一番小さい（約6%。15分足は約14%、`src/lib/costs.ts`）。
  - ランダムに入った場合の損も、3つの時間足で一番小さい（§8.45 の run の物差し）。
  - GA型（#132 の設定）の4時間足は、前半 106回・30.2%・−0.094R、後半 102回・39.2%・+0.176R。回数が少なく、期間によるばらつきが大きいことも書いた。

### 8.51 分析機能を画面から外し、料金プランを Light（メール通知）だけにした（#139）

- **指示**: 「分析機能いらなくなりました」。確認した答え:
  - 範囲: 画面から外すだけ（サーバーの分析の仕組みと過去のデータは残す）。
  - 保有ポジションの登録: 一緒に外す。
  - 料金プラン: 中身を書き換える。組み立ては「ライトだけにする」との答えで、次のように読んだ。無料＝リアルタイムチャート、Light（月額2,980円）＝＋売買サインのメール通知と成績。Standard・Pro は申し込みを止める。
  - Light で契約中の1人: そのまま。
- **画面**:
  - ログイン後のページ（`src/pages/Index.tsx`）は、ヘッダー・案内の帯（無料ユーザー向け、Light のメール通知の案内）・リアルタイムチャート・注意書き・設定だけにした。
  - 分析の入力・結果・履歴・学習ルールなどの分析の表示と保有ポジションは、元のページをまるごと `src/pages/Analysis.tsx` に移して残した。どこからも開けず、ルートを足せば戻せる。
  - 設定の「通貨ペア」（分析用）は、分析のページから渡されたときだけ出る。
- **メール通知**: `signal-alerts` の `alertsAllowed` を Pro だけから、有料プラン（light・standard・pro）と管理者に広げた。今 Light の1人と Pro の1人が使える。
- **料金・宣伝の文**:
  - 料金ページとトップページのプランを、Free（¥0、チャート）と Light（¥2,980、＋メール通知と成績）の2枚にした。
  - トップページは、分析の自動採点と学習の節（とその公開 RPC の呼び出し）を外した。見出し・機能・手順・よくある質問・シェア文を、チャートとメール通知の内容に書き換えた（日本語・英語）。「勝率をうたわない理由」は残し、サインの過去の成績が損益ゼロに届いていないことを書いた（数字は載せない）。
  - 案内の帯・注意書き・ログイン画面の注意書き・通知の注意の「分析」の言葉を直した。
- **特定商取引法の表記と利用規約**:
  - 販売価格を Light だけにし、「Standard・Pro の新規のお申し込みは終了」と書いた。
  - 利用規約の第5条のサービスの説明を「チャートおよび売買サインを表示し、その通知を送信する情報提供サービス」にした。
  - どちらも最終更新日を 2026年9月27日にした。
  - プライバシーポリシーは、過去の分析のデータと処理先の記載がまだ事実なので変えていない。
- **ついでに直したこと**: メール通知の GA型の注意が #132 の前の数字（勝率28.8%・−0.134R・「15分足で1日数回」）のままだった。#132 の設定の後半の数字（30.1%・−0.093R）と、出る頻度（15分足で1ペアあたり2〜3日に1回ほど）に直した。
- **変えていないこと**:
  - サーバーの analyze 関数と、分析の自動採点・原因分析の定期実行（`track-outcomes-sweep`・`postmortem-sweep`）は動いたまま。新しい分析が来ないので、追跡するものは増えない。
  - 決済の関数（create-checkout）は、この仕組みのデプロイの対象外なので触っていない。Standard・Pro は画面から申し込めないが、関数は直接呼ばれれば受け付ける。

### 8.52 無料ユーザーはインジケーターを使えないようにした（#140）

- **指示**: 「無料ユーザーはインジケーターは使えないように」。
- **線引き**: ロックするのは、あとから足したインジケーターの10個（ストキャス・ボリンジャー %b・RCI・SPECTRA型・SuperTrend・UT Bot・FVG Crossfire + Volume Profile・Zone Shift・ダウ理論・Pro型）。売買サイン（GA型・RSI＋SAR）、建玉の箱、サインの材料である RSI とパラボリックSAR（点と帯）は無料のまま。
- **しくみ**（画面側）:
  - `PriceChart` の `indicatorsLocked` が true のとき、上の10個は一覧に 🔒 付きで出るが、目のアイコンは無い。
  - 保存された設定がオンでも描かない（この端末の設定は消さないので、有料プランになると元の表示に戻る）。
  - 🔒 を押すと `onLockedIndicator`（料金ページ）へ移る。全画面の設定シートも同じで、ストキャスの期間の設定も出さない。
  - `LiveChart` は `indicatorsAllowed` が false のとき、ダウ理論（`dow`）と、Zone Shift・Pro型のための過去の足（`history`）を読みに行かない。
  - `Index.tsx` は、有料プラン（light・standard・pro）か管理者なら使える。プランの読み込み中はロックしておく（有料の方は読み込みが終わると使える）。
- **サーバー**: 足の読み込み（`live-chart`）はプランで分けていない。インジケーターは画面で計算するので、ロックも画面側だけ。
- **文面**:
  - 料金ページとトップページの Free から「インジケーターの切り替え」を外し、Light に「インジケーター（ストキャス・…など）」を足した。
  - 見出しの下の説明・手順・よくある質問・案内の帯も同じ内容にした。

### 8.53 チャートの設定（ペア・時間足・インジケーター）を覚えるようにした（#141）

- **指示**: 「設定した、ペアや時間足、インジケーターを覚えとく様にしてください」。
- **覚えるもの**: インジケーターのオンオフと設定（ストキャスの期間など）、背景（黒・白）に加えて、リアルタイムチャートの**ペア・時間足・サインの種類**（GA型・RSI＋SAR・両方）。
- **しくみ**:
  - これまでどおりこの端末（`localStorage` の `sextant.chart.prefs.v1`）に保存し、そこに `live: {pair, interval, view}` を足した。`LiveChart` は開くときにそれを使い、押して選んだときに保存する。
  - 保存した値は、チャートにまだある選択肢のときだけ使う（無いペア・金の1分足などは、USD/JPY・4時間足・GA型に戻る）。ページから時間足が渡されたときはそちらが先。
  - **アカウントにも保存する**（新しい表 `user_chart_prefs`、1人1行、`src/lib/chartPrefsSync.ts`）。ログインしたらアカウントの設定を読み、この端末の設定をそれで置き換える（アカウントにまだ無いときは、この端末の設定をアカウントに書く）。そのあとは変えるたびに 0.8 秒待ってまとめて書く。
  - これで別の端末や、ホーム画面のアプリ（PWA）とブラウザ（Safari）の間でも同じ設定で開く（PWA とブラウザは保存場所が別なので、端末に保存するだけでは揃わなかった）。
  - アカウントが読めないとき（通信が切れているなど）は、この端末の設定のまま使い、上書きしない。
- **表**: `user_chart_prefs(user_id 主キー → auth.users, prefs jsonb, updated_at)`。行レベルセキュリティで本人だけが読み書きできる（ログインしていない人は読めない）。`prefs` は 8KB 未満（今は数百バイト）。マイグレーション `20260927160000_user_chart_prefs.sql`。適用後、他人の行は書けない・本人の行は通る・未ログインは読めないことを確かめた。
- **無料プラン**: 🔒 のインジケーター（§8.52）はオンで保存されていても描かない。保存された設定は消さないので、有料プランになるとその表示に戻る。

### 8.54 チャートの大きな流れを最もよく読むインジケーターを測った（#142、研究のみ）

- **指示**: 「ストキャスってようは今のチャートの大きさ流れが読めないんですよ。チャートの大きな流れを読むのに一番適しているインジケーターを探してきて」。
- **決め方**（データを見る前に `research/bigflow-lib.ts`・`bigflow.ts` の先頭に固定。`bigflow.yml`、run 36334391311）:
  - **答え＝あとから見たチャートの波**: 終値のジグザグで、波の端から ATR(14)×K 戻したら折り返しとする。2つの折り返しの間の足は、その波（上げ・下げ）に属する。最初の折り返しの前と、まだ続いている最後の波は数えない。チャートの表示は120本なので、K=6（ランダムな値動きで波が120本前後になる大きさ）を本番、K=3（小さい波）と K=12（画面より大きい波）を参考にする。
  - **候補31個**: TradingView 標準のもの（移動平均 25・75・200 の単純と 50・200 の指数、その傾き、25/75・50/200 の並び、パーフェクトオーダー、MACD の0線・シグナル、DMI、ADX25 付き DMI、一目均衡表の雲・基準線・遅行スパン、ドンチャン20・55、アルーン、ボルテックス、線形回帰100、RCI52、RSI、ストキャス）と、アプリのもの（SAR、SuperTrend、UT Bot、SPECTRA型、Zone Shift、ダウ理論）。設定は既定のまま、調整していない。
  - 各足の読み（上・下・どちらでもない）を答えと比べ、正しく読めた足の割合を点数にする（どちらでもないは半分）。15分・1時間・4時間を同じ重みで平均。
  - 選び方: 前半（2024-01〜2025-06）で点数が最も高いもの。後半（2025-07〜）で ①ストキャスより良い（差の95%の幅がゼロより上）②後半でも1位か、1位との差の幅がゼロをまたぐ、の両方なら「成り立つ」。95%の幅は月ごとのまとまりで計算（通貨ペアは一緒に動き、波は数週間続くため）。
  - 実データの前に、ランダムな値動き（`SYNTHETIC`）で全体を走らせた。未来に何も無い値動きでも、読みの点数は 50% を大きく超える（波のすでに過ぎた部分を読むだけで点が取れる）。これを実データの点数の土台として並べる。
- **結果**（K=6、3つの時間足の平均。答えの波は平均 100〜109 本）:

| 候補 | 前半 | 後半 [95%] | 後半の4時間足 | 反転（100本あたり、4時間足） | 新しい波を示すまで（中央値、4時間足） | ランダムな値動きでの後半 |
|---|---|---|---|---|---|---|
| **指数移動平均(50) の上か下か（選ばれた）** | 73.8% | **71.6% [70.4〜72.9]**（1位） | 70.0% | 8.2回 | 12本 | 74.9% |
| RSI(14) が50の上か下か | 73.2% | 71.5% | 70.0% | 10.7回 | 6本 | 72.8% |
| 一目均衡表の基準線 | 72.8% | 71.3% | 70.2% | 8.9回 | 6本 | 71.9% |
| MACD の0線 | 73.2% | 71.2% | 69.4% | 3.5回 | 14本 | 73.8% |
| 単純移動平均(75) | 72.8% | 70.6% | 69.0% | 5.8回 | 16本 | 74.6% |
| 一目均衡表の雲（雲の中はどちらでもない、約15%） | 72.4% | 70.5% | 69.1% | 2.7回 | 22本 | 73.8% |
| SuperTrend(10,3) | 72.4% | 69.3% | 66.7% | 2.8回 | 12本 | 72.4% |
| **ストキャス %K が50の上か下か** | 68.9% | **68.3%**（12位） | 68.5% | 12.5回 | 4本 | 68.6% |
| 単純移動平均(200) | 65.8% | 63.2% | 64.1% | 3.5回 | 19本 | 68.5% |
| ダウ理論（アプリ） | 60.9% | 60.6% | 60.7% | 0.6回 | 41本（36%は示さないまま終わる） | 65.0% |

  - **判定: 成り立つ**。指数移動平均(50) は後半も1位（71.6%）で、ストキャスとの差は **+3.3ポイント [+1.9〜+4.7]**。
  - 以下は1回目の実行のあとに、説明のために足した数字（選び方・判定には使っていない。run 36334533335、判定の数字は1回目と同じ）:
    - 時間足ごとのストキャスとの差（後半）: 15分 +4.3 [+3.3〜+5.2]、1時間 +4.3 [+2.4〜+6.1]、**4時間 +1.4 [−1.7〜+4.6]（幅がゼロをまたぐ）**。4時間足は前半は +4.8 [+1.7〜+8.0] だったが、後半だけでは見分けられない。
    - 後半の上位との差: RSI(14)>50 +0.2 [−0.5〜+0.8]、基準線 +0.4 [−0.9〜+1.6]、MACD の0線 +0.4 [−0.0〜+0.8] で見分けられない。単純移動平均(75) +1.0 [+0.5〜+1.6]、雲 +1.1 [+0.6〜+1.7]、単純移動平均(25) +1.2 [+0.2〜+2.2] よりは上。
  - 波の大きさで答えが変わる: 小さい波（K=3、平均35本）では**ストキャスが1位**（後半 73.9%）、画面より大きい波（K=12、平均250〜350本）では移動平均200（指数・単純）が1位（後半 72.5%・72.4%）、ストキャスは31個中26位（62.0%）。ストキャスは小さい波を読む道具で、大きな流れには向かない、というのが数字でも出た。
  - **ランダムな値動きでもほぼ同じ順位・点数になる**（指数移動平均(50) 74.9%、ストキャス 68.6%。ランダムな値動きの波は平均 118〜131本で、実データの 100〜109本より少し長いので、点数は目安の比較）。どのインジケーターも、波のすでに過ぎた部分を、自分の速さに合った大きさで読んでいるだけで、先を知っているわけではない。点数の差は主に「読みたい波の大きさと、インジケーターの速さが合っているか」から来る。
  - **先は当てない**: 読んだ向きにその後48本の値が動いた割合は、後半はどの候補も 45〜50%。指数移動平均(50) は前半 50.6% [48.7〜52.5]・+0.03 ATR [−0.21〜+0.26]、後半 48.1% [46.6〜49.7]・−0.29 ATR [−0.50〜−0.07]（ペアの平均の動きを引いたもの）。4時間足の後半は −0.85 ATR [−1.24〜−0.45] と読みの逆に動いたが、前半は +0.16 [−0.37〜+0.69] で、期間で向きが変わる。流れを「今どちらか」読むことと、その流れが続くことは別。
- **結論**:
  - 表示している120本くらいの大きな流れを読むなら **指数移動平均(50)（EMA50）の上か下か** が最もよかった（3つの時間足の平均で、両期間とも1位）。ただし RSI(14)>50・基準線・MACD の0線とは後半で見分けられない差で、4時間足だけではストキャスとの差も後半は見分けられない。MACD の0線は反転が EMA50 の半分以下（4時間足 100本あたり 3.5回と 8.2回）だが、結果を見てから選び直すことはしない（§8.24 のルール4）。
  - もっと大きな流れ（画面の2〜3倍）を見るなら移動平均200。ストキャスは小さい波用。
  - どれも「これまでの流れ」を読むもので、売買のサインには使えない（その後の値動きは読みと同じ向きに動いていない）。§8.24 のルールどおり、サインやメールには入れない。

### 8.55 EMA 50 と EMA 200 の線をチャートに追加した（#143）

- **指示**: 「EMA50 の線（必要なら移動平均200も）をチャートに追加して、両方」（§8.54 の結果を受けて）。
- **何を足したか**:
  - 終値の指数移動平均 50（オレンジ `#FF9800`）と 200（紫 `#E040FB`）の線（`src/lib/emaLines.ts`）。
  - 計算は TradingView と同じ（最初の n 本の単純平均から始め、以後は 2/(n+1) ずつ）。§8.54 の研究で使った `analyze/indicators.ts` の `emaSeries` と同じ値になることをテストで確かめている。
  - 200本の線は、§8.54 の大きい波（K=12）で前半1位だった指数の200本にした（単純200本とは前半 74.6% で同点、後半 72.5% と 72.4%）。
- **表示**:
  - 既定でオン（所有者が両方を求めたため）。インジケーターの一覧に線の色の印付きで出て、1本ずつオンオフできる。
  - 形成中の足まで線を引く（TradingView と同じ）。価格の目盛りは線も入るように合わせる（線が離れていても画面の外に切れない）。
  - 下に説明文（読み方、§8.54 の結果、先の向きは当たらないこと）。
- **計算に使う足**: リアルタイムチャートは、Zone Shift・Pro型と同じ画面より前の確定足（600本）を、どちらかの線がオンのあいだ読む。画面の120本と合わせて720本で計算するので、200本の線も画面の最初の足から引ける。読み込み中は線を引かない（届くと線が動くため）。
- **無料プラン**: ほかのインジケーターと同じく 🔒（§8.52）。
- 表示のみで、サインの判定・メールには使っていない。

### 8.56 iSPEED FX のチャート操作を参考に、チャートを使いやすくまとめた（#144）

- **指示**: 「ispeedfxからチャートの動作の仕方学んできて、もっとチャートを使いやすくまとめて　やり方は任せる」。
- **読んだもの**（開発環境からは届かないため、`page-read.yml`（公開ページの本文と画像の文字を読むだけのジョブ）で GitHub から読んだ）:
  - iSPEED FX の公式の使い方（チャート・トレーディングチャート）、楽天銀行版の機能紹介、2026年2月のトレーディングチャートの発表、第三者の紹介記事。
- **iSPEED FX のチャートの動き**（今回まねたもの）:
  - チャートを長押しすると十字カーソルが出て、指を動かすとついてくる。タップで消える。四本値（始・高・安・終）とテクニカルの値を見られる。
  - 価格軸・時間軸を指1本で上下・左右にスワイプして拡大・縮小（2026年2月から。ピンチ不要）。縦軸固定のオン・オフ。
  - テクニカルは「トレンド系（チャート〈大〉に重ねる）」と「オシレーター系（チャート〈小〉）」に分け、歯車の設定画面から選ぶ。チャートの上に指標名と値。
  - チャートの上下の項目を整理してチャートの領域を広げた。横画面に対応。
  - まねていないもの: チャートからの発注（このアプリは発注しない）、描画ツール、4分割・12チャート、Myチャート、チャートの形状。
- **変えたこと**（`PriceChart`・`LiveChart`）:
  - **チャートを先に**: 各インジケーターの説明文（これまでチャートの上に並び、スマホでは画面数枚分）を、チャートの下の「チャートの見方・インジケーターの説明」に折りたたんだ。4時間足をおすすめする説明文もチャートの下に折りたたみ。通貨ペアのボタンは1行で横にスクロール。スマホの縦画面でページの高さが約半分になった。
  - **インジケーターの一覧を分けた**: チャートの上にかぶさっていた一覧をやめ、チャートの上の「インジケーター n/m」ボタン（全画面では下の設定ボタン）の中に、「サインと建玉」「トレンド系（チャートに重ねる）」「オシレーター系（チャートの下）」に分けて並べた。各行に目のアイコン（表示・非表示）と ⓘ（その説明を開く）。
  - **チャートの左上**には、重ねているものの名前と EMA 50・200 の値だけ（十字カーソルの足の値、無ければ画面の最後の足）。触っても何も起きない（下の操作をさまたげない）。十字カーソル中は一番上に始・高・安・終。
  - **十字カーソル**: 長押し（0.35秒）で出て、指を動かすとついてくる（そのあいだはページがスクロールしない）。指を離してもそのまま、タップで消える（消えているときのタップはこれまでどおりその足を表示）。タップの直後にブラウザが送るマウスの動きは無視する（無視しないとタップで消した十字カーソルがまた出る）。
  - **指1本の拡大・縮小**: 右の価格の目盛りを下へドラッグで縦に縮小・上へで拡大（0.25〜4倍、画面の足の中央を基準）。「自動」ボタンかダブルクリックで元に戻る。下の時間の目盛りを右へドラッグで横に拡大（最新の足は右端のまま）、左へで縮小。ピンチ・ボタン・横ドラッグの移動はこれまでどおり。
  - **横画面**: スマホ（指で操作・高さ540px以下）を横にすると全画面で開き、縦に戻すと閉じる（自動で開いたときだけ）。リアルタイムチャートだけ。
- 実際のブラウザ（Chromium、スマホの大きさ・タッチ操作）で、長押し→指を動かす→離す→タップ、価格の目盛りのドラッグ、縦のスワイプでページがスクロールすること、横画面で全画面になることを確かめた。

### 8.57 動画の Q-Trend と BLSH、その組み合わせ（3つの確認）を追加した（#145）

- **指示**: 動画（「Video_by_scalping_master_trend」）を添えて「この動画と同じ仕組みのインジケーターを入れたい。この二つのインジケーターの組み合わせができるように。調べて探して、実装して。」。
- **動画から読み取ったこと**（動画はリポジトリに入れていない）:
  - 画面: TradingView、金（XAUUSD、OANDA）の3分足。チャートに **Q-Trend**（名前が出ている）、下の枠に **BLSH**（緑と赤の面、黄と青の線）。
  - 話している内容: ヒンディー語。開発環境で音声認識（Whisper medium、英語へ翻訳）にかけて読んだ。要点は「**3つの確認（triple confirmation）**」:
    - 買い: Q-Trend が BUY、BLSH の線が黄、面が緑。売り: Q-Trend が SELL、線が青（下向き）、面が赤。
    - 3つがそろったらすぐ入る（「ヒストグラムが赤になったらすぐエントリー」）。サインが出ても面の色が合わないものは「フェイクエントリー」。
    - 設定: Q-Trend は既定のまま。BLSH は色だけ動画のとおりにして、ほかは変えない。
- **元のインジケーター**（どちらも TradingView の公開コード。`pine-source.yml` で読んだ）:
  - Q-Trend（tarasenko_、Pine v5、MPL 2.0）: https://www.tradingview.com/script/2vRdxyjm-q-trend/
  - Buy Low Sell High Composite（zacmcc、Pine v3、短い名前が BLSH）: https://www.tradingview.com/script/turEX2Ly-Buy-Low-Sell-High-Composite/
- **移植**（`src/lib/qTrend.ts`・`src/lib/blsh.ts`）:
  - Q-Trend: 直近200本の終値の最高値と最安値の中間から始まる線。終値が「線＋ATR(14)×1（1本前の ATR）」を上に抜けたら線を ATR 1つ分上げて BUY、下に抜けたら下げて SELL（同じ向きが続く間は最初の1回だけ）。その足か直前4本のどれかが200本の値幅の端1/8で始まっていたら STRONG。線とローソク足はサインの色。元の既定の「Type A」だけ（元の EMA のならしは既定でオフのため移植していない）。確定足だけで判定。
  - BLSH: RSI(14)（25〜75）、EMA(5)−EMA(35)、MACD のヒストグラム（どちらも ±ATR(9)×2）、MFI(14)（25〜75）をそれぞれ −1〜+1 にそろえて足し、4で割った面（0より上が緑、0以下が赤）。線は同じ幅にそろえた MACD のシグナル線で、MACD がシグナル以上なら黄、下なら青。
  - 3つの確認（`tripleConfirm`）: Q-Trend のサインから次のサインまでの間で、線の色と面の色がそろった最初の確定足に「3✓ BUY」「3✓ SELL」。そろわないまま次のサインが出たら印なし（動画の「フェイク」）。
  - Pine のとおりにしたこと: `ta.atr`・RSI は最初の平均で始める Wilder の平均、EMA は最初の単純平均で始める、何もない値との比較は偽、200本そろうまで線なし。
  - Python で別に書いた計算と、線の値・サインの足・BLSH の値・3つの確認の足が一致することをテストで確かめた。
- **元と違うところ**（画面の説明にも書いた）:
  - GMO の FX の足には出来高がないため、BLSH の MFI は1本=1として計算（14本のうち上がった足の典型価格の割合の目安）。
  - BLSH の線の色は動画の黄と青（元は緑と赤）。元の交差の点は描いていない（動画にも出ていない）。白背景では黄を濃くした（Volume Profile の POC と同じ）。
  - TradingView は Q-Trend の線をチャートの最初の足から計算するため、ここ（画面より前の確定足600本から計算）とは線の位置が少しずれることがある。
  - このアプリの時間足に3分足はない（1分・15分・1時間・4時間・日足）。金（XAU/USD）は選べる。
- **画面**:
  - インジケーターの一覧に「Q-Trend × BLSH（3つの確認）」（サインと建玉）、「Q-Trend 200 14 1」（トレンド系）、「BLSH」（オシレーター系、チャートの下の枠）。どれも最初からオン、目のアイコンで個別にオフ。無料プランではほかのインジケーターと同じく鍵。
  - ローソク足の色は UT Bot ＞ Q-Trend ＞ Zone Shift の順（オンのもののうち先のもの）。
  - Q-Trend のラベルと 3✓ の印は、買いは足の下・売りは足の上。上下の端で入らないときは反対側へ、近くの足のラベルと重なるときは一段外へ、それでも入らないときは足の反対側へ（足には重ねない）。どれもチャートの枠の中。
  - BLSH の枠の右の値と上の読みは、そのときの線の色（黄か青）。
  - 画面より前の確定足600本（Zone Shift などと同じ読み込み）を使う。読み込み中は描かない。
- **検証**: 過去のデータでの検証はまだしていない（未測定）。表示のみで、サインの判定・メール・成績の記録には使っていない。
- 実際のブラウザ（Chromium、スマホの大きさ、黒と白の背景、全画面）で、線・ラベル・3✓ の印・BLSH の枠を確かめた。

### 8.58 リアルタイムチャートに1分足・5分足を全ペアで（#146、live-chart v7）

- **指示**: 「1分足と5分足を追加して、全てのペアに」。
- **それまで**: FX 5ペアは 1分・15分・1時間・4時間・日足（5分足はダウ理論の読み取りだけ）。金（XAU/USD）は 15分・1時間・4時間・日足だけで、ダウ理論も5分足なし（§8.40: 足が毎分確定すると Twelve Data の無料枠〈1日800回〉を超えるため）。
- **変えたこと**:
  - 時間足を全ペア共通で **1分・5分・15分・1時間・4時間・日足** の6つにした（`LIVE_INTERVALS`、関数と画面の両方）。FX の5分足は GMO の5分足（1分足・15分足と同じ日ごとの読み方）。金の1分足・5分足は Twelve Data（ほかの時間足と同じく、足が確定するたびに読み直し）。
  - 金のダウ理論にも5分足を入れた（4時間・1時間・15分・5分、FX と同じ）。
  - **Twelve Data の1日の回数を数える**: 新しい表 `public.twelve_data_usage`（UTC の日ごとの回数）と関数 `take_twelve_data_credit(p_cap)`（service_role のみ）。`live-chart` は Twelve Data を読む前に1回数え、その日の回数が時間足ごとの上限に達していたら読まずに、最後に読んだ足を出す。上限は **1分足 450・5分足 600・ほか 720**（`TWELVE_CAPS`）。1分足が最初に止まり、5分足が次、長い時間足は最後まで残る。1分足を1日中開いたままでも、ほかの金の時間足と、GMO が読めないときの予備が読めなくなることはない。800 との差の 80 は、数えていないほかの関数（分析まわり、いまはほとんど使われない）の分。数える処理が失敗したときは読む（数え忘れでチャートを止めない）。
  - 上限で止まった金の時間足には、チャートの上に「金の◯◯は、きょうの Twelve Data の読み込み上限に達したため、◯◯ に読んだ足までを表示しています（足は動きません）。上限は日本時間の朝9時に戻ります。」と出す（`limited`）。
  - **読み直せなかった足の扱いを直した**: 保存した Twelve Data の足のうち、読んだ時点でまだ形成中だった足は、時間が過ぎても確定足として扱わない（読んだところで止まった足を確定足として描き、サインを判定していた）。金・GMO の予備・金の履歴とダウ理論に共通。
  - 1分間に Twelve Data を読む回数（インスタンスごと）を 3 → 5 にした。金の1分足とダウ理論（5分・15分・1時間・4時間）が同じ分に重なるため。Twelve Data の上限は1分8回。
- **見積もり**（1人が金の1分足を開いたまま、ダウ理論オン）: 1時間あたり 約77回（1分足60・5分足12・15分足4・1時間足1・4時間足0.25）。上限450に届くのは約5.8時間後。そのあと1分足は止まり、5分足以上は続く。
- **確かめたこと**: テスト（6つの時間足と並び順、FX の5分足を GMO から読む〈チャート用201本・履歴601本〉、金の1分・5分足の鮮度、上限の順番、読んだ時点で形成中だった足を外す、上限で止まったときの表示、保存した時間足の復元、金に切り替えても1分・5分足のまま、ダウ理論の時間足）。全 2151 件成功。`deno check` 成功。本番の DB で `take_twelve_data_credit` が上限で止まること・app のユーザーから読めないことを、過去の日付（1999-01-01）で確かめてから、その行を消した。Chromium で、時間足のボタン6つがスマホの幅で1行に収まること、金の5分足の上限の表示、金のダウ理論の5分足を確かめた。
- **本番で確かめること**: Twelve Data から金の1分足・5分足が実際に読めるか（ここからは本番の関数をログインして呼べない）。
- **その後（#181、2026-10-02）**: 足を楽天FXの15種類（1・2・3・4・5・10・15・30分、1・2・4・8時間、日・週・月）にした（§8.92）。上限の数え方はこの節のまま。新しい2・3・4分足は1分足の上限（450）、10分足は5分足の上限（600）で数える（その足を Twelve Data から読んでまとめるため）。

### 8.59 チャートをいつもリアルタイムで表示する（#147、live-chart v8）

- **指示**: 「チャートはいつもリアルタイムで表示するように」（§8.58 で、金の1分足が上限に達すると止まると伝えたあと）。
- **リアルタイムでなかったところ**:
  1. 形成中の足: 読んだ足に、いまの価格1つだけを当てていた。価格が戻るとヒゲも戻った（高値・安値が消えた）。
  2. 足の確定: 次の読み込み（確定の4秒後）が届くまで、チャートは止まっていた。読み込みが遅い・失敗したときはもっと長く止まった。
  3. 金: Twelve Data の1日の上限（§8.58）に達したとき・読めないときは、最後に読んだ足のまま止まった。
  4. 画面に戻ったとき: 価格は次の5秒ごとの読み込みまで古いまま。足の確定を過ぎていても、次の読み込みを待っていた（ブラウザが裏のタイマーを遅らせる）。
- **変えたこと**:
  - **画面側**（`tickLive`・`withRead`、全ペア）: 価格が来るたびに、形成中の足の終値を動かし、高値・安値は届いた一番遠いところで残す。足の時間が過ぎたら、次の価格でその場で次の足を始める（足の区切りは読んだ足と同じ）。次の読み込みが届いたらそれに置き換える。ただし、届いた足より新しい足（読み直せなかったとき）は残す。「次の足の確定」もいま形成中の足に合わせた。
  - **画面に戻ったら**すぐ価格を読み、足の確定を過ぎていれば足も読み直す。
  - **金の価格を記録**: 新しい表 `public.gold_tick_bars`（1分ごとの Swissquote の中間値の始値・高値・安値・終値、2日分）と関数 `record_gold_tick`（service_role のみ）。`live-chart` はティッカーで Swissquote を読むたびに（取引中の価格だけ）1つ記録する。ティッカーは誰かがリアルタイムチャートを開いている間、5秒ごとに呼ばれる（関数内で2秒キャッシュ）。
  - **金を読み直せないとき**（上限・Twelve Data が答えない）は、最後に読んだ足に、その後に記録した価格で足を足して返す（`extendWithTicks`）。読んだときに形成中だった足は、そのあとの分で高値・安値を広げ、終値を最新にする。以後の足はその時間の分だけで作る。足の区切りは読んだ足と同じ。ダウ理論と履歴にも同じ足を使う。画面には「◯◯ からの足を Swissquote の価格（数秒ごと）から作っています」と理由（上限か、読み直せなかったか）を出す。
- **限り**:
  - 価格は誰かがチャートを開いている間だけ記録する。誰も開いていなかった時間の金の足は抜ける（その分の足は作らない）。
  - 記録は数秒ごとの価格なので、その間の一瞬の高値・安値は入らないことがある。Twelve Data の足とも提供元が違うので、少しずれることがある。
  - 画面が作った足（確定の直後の数秒）は、サインの判定には使っていない。サインは次の読み込みの確定足で判定する（これまでどおり）。
  - 価格の読み込みは5秒ごとのまま（速くすると、関数の呼び出し回数が見ている人数×時間で増えるため）。
- **確かめたこと**: テスト 2159 件成功。
  - 形成中の足の高値・安値が戻らないこと
  - 足の時間が過ぎたら次の足を始めること（4時間足の区切りも）
  - 形成中の足がない読み込みのときの扱い
  - 新しい読み込みで置き換えつつ、それより新しい足は残すこと
  - 次の読み込みが届かなくても、画面が次の足に進むこと
  - 金: 記録した分の読み方、読んだあとの足の作り方（形成中だった足の延長・その後の足・記録のない時間）、上限・読み直せなかったときの表示

  `deno check` とビルドも成功。本番の DB で `record_gold_tick` の1分へのまとめ方（最初の価格が始値、最後が終値）を確かめた。あわせて、app のユーザーから呼べない・読めないことも過去の日付（1999-01-01）で確かめ、確認の行は消した。Chromium で、次の読み込みが返らないようにして分の境目をまたぎ、チャートが次の1分足に進むこと（「次の足の確定」が次の分に変わること）、エラーが出ないことを確かめた。

### 8.60 Q-Trend と 3✓ の過去の印が、開き直しで変わらないようにした（#148）

- **きっかけ**: 「このsellとbuyはリアルタイムで表示される？後出し？」への答えで、次のことが分かった。
  - どの印も未来の足は使っていない（確定した足までで判定）。
  - ただし Q-Trend の線は、計算を始めた足からの積み重ねで決まる。チャートは開くたびに画面より前の足を読み直すので、始まりの足が時計とともにずれる。そのため、開き直すと過去の印が動いたり消えたりしていた。
  - 本番の金1時間足（2026-09-28 に読んだ584本）で、始まりを1〜48時間ずらして比べた。画面の120本の印は、48通り中44通りで変わった。多くは1〜3本のずれで、9本ずれる例や、消える例もあった。新しい印は変わらなかった。
  - 指示: 「1は直して」。
- **変えたこと**（`anchoredStart`・`barStepMs`、`PriceChart`）:
  - Q-Trend と BLSH（つまり 3✓ も）を、読んだ足の中の**決まった時刻**から計算するようにした。決まった時刻とは、1970-01-01 UTC から数えて200本分の時間の倍数のうち、読んだ足が届く一番早いもので、計算はその時刻かそのあとの最初の足から始める。
  - 開き直しても同じ足から始まるので、同じ線と印になる。始まりが次の倍数に移るのは、読んだ足がその時刻より前に届かなくなったときだけ（1時間足なら約8日に1回、1分足なら約3時間20分に1回、15分足なら約2日に1回）。
  - その時刻より後、画面の最初の足より前に200本残らないとき（読んだ足が短いとき）は、これまでどおり最初の足から計算する。
  - 足の時刻が読めないチャート（テストの一部）も、これまでどおり。
- **測り直し**（同じ584本で、1時間ごとに開き直したとして48時間分）:

  | 計算の始まり | 印が変わった回数 | 違う印の組み合わせ |
  |---|---|---|
  | 読んだ最初の足（これまで） | 32回 | 10通り |
  | 決まった時刻から（今回） | 1回（始まりが次の時刻に移ったとき） | 2通り |

- **限り**:
  - 始まりが次の時刻に移るときは、過去の印が変わることがある。
  - TradingView とは始まりが違うので、線の位置が少しずれることがある（画面の説明も直した）。
  - 足の確定直後の数秒に、画面が作った足で判定する件（§8.59）は、今回は直していない。
- **確かめたこと**: テスト 2162 件成功。
  - 始まりの選び方: 同じ時刻・次の時刻・読んだ足が短いとき・時刻なし・週末のすき間
  - 足の長さの読み方
  - チャートで、画面より前に読んだ足が4本ずれても Q-Trend と 3✓ の印が同じになること（始まりを固定しないとこのテストが失敗することも確かめた）

### 8.61 足の確定直後は、正式な足が届くまでインジケーターの判定をしない（#149）

- **きっかけ**: §8.59 で、足の時間が過ぎたら画面が価格から次の足を始めるようにした。その結果、確定直後の数秒は、画面が作った足（確定した足の終値が画面で見た価格のまま）でもインジケーターが判定していた。正式な足が届いて終値が少し違うと、印が一瞬出て消えることがあった（金は価格の提供元が違うので起きやすい）。
- 指示: 「2も入れて」（判定の条件は変えず、正式な足が届いてから判定する）。
- **変えたこと**:
  - `PriceChart` に `unjudged` を追加した。新しい足から何本を、どのインジケーターの判定にも使わないかを渡す（これまでの `formingLast` は1本）。Q-Trend・3✓・UT Bot・SuperTrend・SPECTRA・FVG Crossfire・Zone Shift・Pro 型に効く。
  - `LiveChart` は、読んだ足の最後の確定足より後ろ（形成中の足と、その後に価格で作った足）を判定から外す（`unjudgedOf`）。次の読み込み（通常、確定の4〜5秒後）が届くと、その足も判定に入る。
  - GA型・RSI＋SAR の印とダウ理論は、もとからサーバーが読み込みの確定足だけで判定している（変更なし）。
- **その分遅れること**: 印は、正式な足が届いてから出る。これまでは確定の瞬間に出ることもあったが、今は数秒後になる。
- **確かめたこと**: テスト 2165 件成功。
  - 外す本数の数え方
  - チャートで、2番目に新しい足の STRONG BUY と 3✓ BUY が、外すと出ないこと
  - 次の読み込みが返らない状態で次の足が始まったとき、ライブチャートが「2本外す」とチャートに渡すこと（渡さないとこのテストが失敗することも確かめた）

### 8.62 トレンド系で未追加だったもの（トレンドライン・GC/DC・一目均衡表・MACD・ADX）を追加した（#150）

- **指示**: 流れ（上昇・下降・横ばい）を判断するトレンド系の手法の説明を添えて、「まだ追加していないやつ追加して」。説明にあったのは、ダウ理論、トレンドライン、移動平均線（ゴールデンクロス・デッドクロス）、一目均衡表、MACD、ADX。
- **すでにあったもの**: ダウ理論（§8.42）、移動平均線（EMA 50・200、§8.55）。「高値線・安値線」は分析画面の線で、リアルタイムチャートには出ていなかった。
- **追加したもの**（`src/lib/trendTools.ts`、`PriceChart`）:

  | 名前 | 中身 | 最初の状態 |
  |---|---|---|
  | トレンドライン | ダウ理論と同じ山・谷（左右4本）から作る。直近の「切り上がった2つの谷」を結ぶ線（緑）と、直近の「切り下がった2つの山」を結ぶ線（赤）を右へ延ばす。終値が線をはっきり越えたら（ヒゲではなく終値）そこで止めて「割れ」「抜け」と書く | オン |
  | GC・DC（EMA 50×200） | EMA 50 が EMA 200 を上に抜けた確定足に GC、下に抜けた確定足に DC（Pine の crossover / crossunder）。EMA の線を消していても出る | オン |
  | 一目均衡表 9 26 52 | TradingView の標準と同じ（転換線・基準線・先行スパン1/2を25本先へ・遅行スパンを25本前へ、雲は先行1が上なら緑）。チャートの左上に、終値が「雲の上（上昇優勢）・雲の中・雲の下（下落優勢）」のどれかを出す | オフ |
  | MACD 12 26 9 | TradingView の標準と同じ（EMA 12 − EMA 26、その9本 EMA、ヒストグラムは4色）。チャートの下の枠 | オフ |
  | ADX 14 14 | TradingView の標準「Directional Movement Index」と同じ（Wilder の平均、ADX・+DI・−DI）。25（説明の目安）に点線。チャートの下の枠 | オフ |

  - 一目均衡表・MACD・ADX は、%b・RCI と同じく最初はオフにした。雲と4本の線、枠2つが増えるため。インジケーターの一覧（トレンド系・オシレーター系）でオンにできる。
  - どれも画面より前の足（履歴）も使って計算する。ライブチャートは、これらのどれかがオンなら履歴を読む。
  - 無料プランでは、ほかのインジケーターと同じく鍵がかかる。
  - トレンドラインと GC・DC は確定足だけで判定する（#149 の、判定に使わない新しい足も守る）。
- **限り**:
  - 一目均衡表の雲は、最新の足より右（25本先の未来の部分）を描いていない。このチャートには、最新の足より右に余白がないため。
  - トレンドラインの引き方（どの山・谷を結ぶか）はアプリの決め方で、人が引く線とは違うことがある。
  - どれも過去の検証はしていない（未測定）。表示のみで、サインの判定・メールには使っていない。
- **確かめたこと**:
  - Python で別に書いた TradingView の式と、次の値・位置が小数10桁まで一致すること: MACD・シグナル・ヒストグラム、+DI・−DI・ADX、一目の各線、最初に値が出る足、GC・DC の足、トレンドラインの山・谷と割れた足。
  - チャートで次のことを確かめた（テスト 2176 件成功）: トレンドラインと「抜け」、GC の印、一目・MACD・ADX がオフで始まりオンで出ること、一目の「雲の上」の表示、MACD の色、ADX の25の線、鍵、ライブチャートが GC・DC だけオンでも履歴を読むこと。
  - Chromium で、スマホの大きさと全画面で見た目を確かめた。

### 8.63 動画のインジケーター「ULTRA EN」を、動画の設定と印から作った（#151）

- **指示**: 動画（30秒・音声なし）を添えて「このインジケーター追加して　どんなインジケーターか調べて内容を実装して。動画の数値を設定して。」
- **動画から読めたこと**:
  - 名前は「ULTRA EN」（TradingView の作者 F-INVEST）。表の見出しは「ULTRA_V1.2」。金（約 4,300 ドル）の短い時間足。
  - 設定（動画で打ち直した後の値）:

    | 欄 | 動画の値 |
    |---|---|
    | Run RSI strategy | オン |
    | RSI Length・Overbought・Oversold | 14・70・30（動画の中で 16→14、72→70、34→30 に変更） |
    | Trade mode | 「Trend-f…」（途中で切れていて、選択肢は見えない） |
    | Run MACD strategy | オフ（12・26・9） |
    | MACD（HA）の欄 | Slow 26・Signal 9。この欄のオン・オフは映っていない |
    | SL (Price)・TP1・TP2・TP3 | 10・5・10・15（動画の中で 11→10、8→5、13→10、18→15 に変更） |

  - チャートでは、売りのエントリー 4327.154 に対して SL 4337.154、TP1 4322.154、TP2 4317.154、TP3 4312.154。つまり SL と TP は価格の幅（ドル）。
  - 右上の表は、TP1・TP2・TP3・SL に届いた回数と割合、TOTAL、WIN RATE。TOTAL は TP1＋SL（489＋133＝622）。TP1 に届くと 489→490、622→623 に増えた。WIN RATE は TP1 の割合（79%）。
- **調べたこと**:
  - F-INVEST の TradingView のページを GitHub Actions（`page-read.yml`）で読んだ。公開スクリプトは 0 本で、紹介文には Telegram の連絡先がある。スクリプト検索でも「ULTRA EN」は出てこない。
  - 招待制（動画の鍵の印）で、コードは読めない。そのため、作者と同じ計算かどうかは確かめられない。
- **作ったもの**（`src/lib/ultra.ts`、`PriceChart`、一覧の「売買サイン」の中、最初からオン）:
  - **サイン**: RSI(14) が 70 以上から 70 を下に抜けた確定足に Sell、30 以下から 30 を上に抜けた確定足に Buy（Pine の crossunder / crossover）。
    - 動画のチャートでは、天井の少しあとに Sell、底の少しあとに Buy が出ている。これに合うのは「行き過ぎから戻った所で入る」形だった。
    - 逆の形（70 を上に抜けたら買う）では、底の直後の Buy が説明できない。「Trend-f…」はこの読み方にした。これはアプリの読み方。
  - **エントリー**: その足の終値。損切りは 10、利確は 5・10・15。
    - 金はドルで使う。FX ペアでは同じ数字を pips として使う（10 pips など）。動画は金だけで、金の 10 ドルをそのまま価格にするとドル円では 10 円になるため。これはアプリの決め事。
  - **印**:
    - 届いた足に ★TP1〜★TP3。
    - TP1 より先に損切りに届いた足に小さな ×。
    - 最新のサインの箱（緑＝エントリー、赤＝損切りまで、青＝TP3まで）。決着していなければ右端まで延ばし、エントリー・SL・TP の価格を出す。決着したら薄くする。
  - **表**（#152 でチャートの上の1行に移した。§8.64）: 読み込んだ足の中で、TP1・TP2・TP3・損切りに届いた回数と、合計に対する割合。合計は TP1＋損切りで、勝率は TP1 の割合。動画の表と同じ数え方。
  - **数え方の決め事**（動画からは分からない部分）:
    - 同じ足で損切りと利確の両方に届いたら、損切りに数える（アプリの他の記録と同じ）。
    - TP1 のあとに損切りに届いたら、そこで終わり。損切りには数えない（動画の TOTAL＝TP1＋SL に合う）。
    - どのサインも、前のサインと関係なく、損切りか TP3 まで追う。
  - Q-Trend と同じく、決まった時刻（200本分の時間ごと）の足から計算する（§8.60）。開き直しても、過去の印と表の数は変わらない。
  - 確定足だけで判定する（§8.61 の、判定に使わない新しい足も守る）。
  - ライブチャートは、ULTRA がオンなら履歴を読む。無料プランでは鍵がかかる。
  - 作っていないもの: MACD strategy（動画でオフ）、MACD（HA）の欄（オンかどうかが映っていない）。
- **限り**:
  - 作者のコードは読めないので、同じ足に同じサインが出るとは限らない。
  - 動画の「80% WIN RATE」は、このアプリでは測っていない。
  - TP1（5）は損切り（10）の半分の幅なので、値動きに偏りがなければ、でたらめに入っても約 67% は TP1 に先に届く（10 ÷ (5＋10)）。勝率が高く見えやすい数え方。
  - 画面の確認に使った金の 1 時間足（2026-08-25〜09-28、585 本）の表は、18 回中 TP1 が 8 回（44%）だった。回数が少なく、測定ではない。
  - 表示のみで、サインの判定・メールには使っていない。
- **確かめたこと**:
  - Python で別に書いた計算と、次の値が一致すること（小数 10 桁まで）:
    - Pine の RSI の値。
    - 金（ドル）とドル円（pips）の合成データの、サインの足・向き・エントリー・SL・TP・届いた足・結果・表の数。
  - 手で作った足で、次の決め事を確かめた:
    - 同じ足の損切りと利確は損切り。
    - TP1 のあとの損切りは数えない。
    - TP1 と TP2 が同じ足、TP3 で終わり。
    - 形成中の足は判定しない。
  - わざと壊した 8 通り（同じ足で利確を優先、RSI を逆向きに抜ける形、TP1 後の損切りも数える、pips を掛けない、形成中の足も判定、RSI の 100 を 50、チャートの足だけで数える、チャートで形成中の足も判定）を、それぞれテストが見つけることを確かめた。
  - テスト 2192 件成功。
  - Chromium で、スマホの大きさと全画面で見た目を確かめた。


### 8.64 ULTRA の表と価格がチャートに重なって見づらいのを直した（#152）

- **指示**: USD/JPY 5分足（白背景・全画面）の画面を添えて「ultra被っててみずらい」。
- **原因**:
  - 右上の表（動画と同じ位置）が、最新の足と、決着前のサインの価格（SL・Entry・TP）の上に重なっていた。
  - その価格の札も、チャートの右端で最新の足の上に重なっていた。
- **直したこと**（`PriceChart`）:
  - 表をチャートの外、上の1行に移した: 「ULTRA TP1 7 78% · TP2 … · 損切り … · 合計 9 · 勝率 78%」。狭い画面では折り返す。
  - 決着前のサインがあり、最新の足が画面に入っているときだけ、最新の足の右に札の幅だけ余白を空け、札をそこに出す。動画も価格を最新の足より右に描いている。
    - 足の幅（`slot`）をその分だけ狭くする。十字線・ドラッグ・拡大の位置の計算も、同じ幅（`barsW`）を使う。
    - 決着したら余白はなくなる。過去へスクロールしているときも空けない。
  - 札の文字を「Entry: 157.444」から「Entry 157.444」に短くした。
  - 表の TP1・TP2・TP3 の色を、白背景でも読める濃さにした。
- **確かめたこと**:
  - 表がチャートの外（上）にあること。
  - 決着前は、5つの札がすべて最新の足より右にあること。決着後は余白がないこと。
  - わざと壊した2通り（余白を空けない・いつも空ける）を、それぞれテストが見つけることを確かめた。
  - Chromium で、白背景の全画面・カード、黒背景を見て確かめた。


### 8.65 楽天FXの通貨ペアと楽天証券のCFD商品を追加する — まず GMO の21ペア（#153）

- **指示**: 楽天証券の「CFD銘柄一覧（商品）」と楽天FXの通貨ペア選択の画面を添えて、「画像のペアと銘柄を全て追加して」「順番に丁寧にして、時間かかってもいいから。これはルールとして覚えておいて全ての作業に言える」。ルールは `CLAUDE.md` に書いた。
- **画像にあったもの**:
  - 楽天FX: 38ペア。アプリにあったのは 5 つ（米ドル/円・ユーロ/円・ポンド/円・ユーロ/ドル・ポンド/ドル）。
  - CFD 商品: 金・銀・銅・プラチナ・パラジウム・WTI原油・北海原油・ヒーティングオイル・ガソリン・天然ガス・大豆・コーン・コーヒー・粗糖（画面の下が切れていて、その先は見えない）。アプリにあったのは金だけ。
- **価格の取得元を調べた**（2026-09-28、GitHub Actions の `page-read.yml` で。この開発環境からは外に出られない）:

  | 取得元 | 足（チャート） | 現在値 | 今回の対象で取れるもの |
  |---|---|---|---|
  | GMO コイン（今の FX の取得元） | ○（無料・キー不要） | ○ | 21 ペア。`/public/v1/symbols` の全部で、すべて楽天FXの38ペアの中にある |
  | Swissquote（今の金の現在値） | ×（履歴なし） | ○ | GMO にない17ペアのうち16（人民元/香港ドルは無い）、銀・プラチナ・パラジウム。原油・天然ガスなどは無い |
  | Twelve Data（今の金の足） | ○ | ○ | FX は無料の Basic にある（ズロチ/円・チェココルナ/円で確認。人民元/香港ドルは無い）。銀・プラチナ・銅・WTI・北海原油は Grow（有料）。ヒーティングオイル・ガソリン・天然ガス・大豆・コーン・コーヒー・粗糖は商品一覧に無い |
  | Yahoo Finance | — | — | GitHub のサーバーからは 429（拒否）で読めなかった |

  - Twelve Data の料金ページ: 個人向け（Basic 無料・Grow 月29ドル〜・Pro 月99ドル〜・Ultra 月329ドル〜）は「personal, internal, and non-commercial purposes」。Basic は「Internal non-display usage」。商用（Business）は別の料金（今回は読めていない）。今の金の足も、この条件の中で使っている。
- **今回やったこと**（GMO の残り16ペアを、今の5ペアと同じ仕組み・同じ品質で追加）:
  - `track-outcomes/quotes.ts` の `GMO_SYMBOLS` に10記号を足して、GMO の21記号すべてにした（トルコリラ/円・ランド/円・メキシコペソ/円・フォリント/円・Sクローナ/円・ユーロ/ポンド・豪ドル/NZドル・豪ドル/カナダドル・NZドル/カナダドル・Nクローネ/Sクローナ）。豪ドル/円など6つは、すでにあった。
  - リアルタイムチャートのペア（`LIVE_PAIRS`、サーバーと画面の両方）を、楽天FXの並び順の21ペア＋金にした。
  - ペアの横一列の左に「銘柄の一覧」ボタンを付けた。押すと、FX と商品（CFD）に分けた3列の一覧が開く。名前は楽天FXの画面と同じ呼び方（ランド/円・Nクローネ/Sクローナ など）。選ぶと閉じ、横一列もそのペアまで動く。
  - 全画面のペア一覧も、FX と商品（CFD）の見出しで分けた。日本語・英語の正式名も21ペア分足した。
  - サーバーの読み込み結果の保存（足・履歴・ダウ理論）の上限を 200 件にした（22ペア×6時間足）。以前の 50〜100 件のままだと、ペアを替えるたびに保存が全部消える。live-chart v9。
  - 価格の桁は GMO と同じ（円のペアは小数3桁、それ以外は5桁）。pips は円のペアが 0.01、それ以外は 0.0001（フォリント/円は 0.485/0.491 で 0.6pips）。
- **まだ追加していないもの**（取得元の決定が要る。オーナーに確認中）:
  - FX 17ペア: 人民元/円・ドル/カナダドル・ドル/スイス・ポンド/スイス・ユーロ/スイス・豪ドル/スイス・NZドル/スイス・香港ドル/円・SGドル/円・Nクローネ/円・ユーロ/豪ドル・ポンド/豪ドル・ズロチ/円・チェココルナ/円・カナダドル/スイス・人民元/香港ドル・ドル/香港ドル。
  - 商品 13: 銀・銅・プラチナ・パラジウム・WTI原油・北海原油・ヒーティングオイル・ガソリン・天然ガス・大豆・コーン・コーヒー・粗糖。
  - その後（オーナーの判断）: FX は無料プランで15ペアを追加した（§8.66）。人民元/円と人民元/香港ドルは足の取得元が無く、まだ無い。商品は有料プラン（Twelve Data Grow）を契約しないので、金だけのまま。
- **気をつけること**:
  - ULTRA（§8.63）は FX で「同じ数字を pips」として使う。値段の低いペア（フォリント/円 0.49円、トルコリラ/円 3.2円、ランド/円 9.6円 など）では、損切り10pips（0.1円）が価格の数%になり、ドル/円よりずっと広い。
  - メール通知の対象ペア（`ALERT_PAIRS`、7ペア）は変えていない。
  - 新しいペアのサインは、過去のチャートで測っていない（これまでの測定は11ペア）。
- **確かめたこと**:
  - GMO の新しいペアの足が取れること（フォリント/円の1分足、Nクローネ/Sクローナの4時間足、トルコリラ/円の日足、ユーロ/ポンドの15分足、ランド/円の1時間足。どれも status 0 で足が返った）。
  - テストで次のことを確かめた:
    - GMO の21記号が楽天FXの38ペアの並びのとおりに入っていること。
    - サーバーと画面のペアの並びが同じであること。
    - 日本語・英語の名前があること。
    - 一覧を開いて選ぶとチャートが替わり、覚えられること。
    - 新しいペアの足を GMO から読むこと。
    - 保存していた新しいペアで開くこと。
  - わざと壊した3通り（一覧が閉じない・サーバーと画面の並びがずれる・名前が抜ける）を、テストが見つけることを確かめた。
  - Chromium で、スマホの大きさで見た目を確かめた（一覧、選んだあと、全画面の一覧）。
- **その後（#175、2026-10-01）**: アプリは円のペアと金だけになった（§8.86）。GMO の21ペアのうち、チャートに残るのは円の12ペア。`GMO_SYMBOLS` は21記号のまま（研究と記録の決着が使う）。
- **その後（#177、2026-10-01）**: ユーロ/ドルを戻した（§8.88）。チャートに出す GMO のペアは、円の12ペアとユーロ/ドルの13になった。
- **その後（#178、2026-10-02）**: 豪ドル/ドルも戻した（§8.89）。チャートに出す GMO のペアは14になった。

### 8.66 GMO にない楽天FXの15ペアを、金と同じ仕組みで追加する（#154）

- **指示**: §8.65 の調べの結果を伝えたあと、「私は無料プランに該当します。なぜなら私以外誰も使ってないからです。個人向けプランで追加して お客様が付いたら有料プランを契約します」、続けて「1進んで 2はなしで」。1 = FX の残りを無料プランで追加する、2 = 商品のための有料プラン（Twelve Data Grow）は契約しない（商品は金だけのまま）。
- **追加した15ペア**（楽天FXの呼び方）: ドル/カナダドル・ドル/スイス・ポンド/スイス・ユーロ/スイス・豪ドル/スイス・NZドル/スイス・香港ドル/円・SGドル/円・Nクローネ/円・ユーロ/豪ドル・ポンド/豪ドル・ズロチ/円・チェココルナ/円・カナダドル/スイス・ドル/香港ドル。並びは楽天FXのとおりで、GMO の21ペアの間に入る。FX は36ペア、金と合わせて37。
- **追加していない2ペア**:
  - 人民元/円（CNH/JPY）: Twelve Data に無い（`forex_pairs` で CNH が付くのは USD/CNH と CNY/CNH だけ、`symbol_search` でも空）。CNY/JPY（中国本土の人民元）はあるが、CNH（海外の人民元）とは別の値段なので、代わりには使っていない。Swissquote に現在値はある。
  - 人民元/香港ドル（CNH/HKD）: Twelve Data にも Swissquote にも無い。
- **取得元を確かめた**（2026-09-28、GitHub Actions の `page-read.yml`）:
  - 足: Twelve Data。15ペアとも `symbol_search` の `show_plan` が Basic（無料）。
  - 現在値: Swissquote の公開レート。15ペアとも答えた。
  - 本番の関数で実際に15ペアの足が読めるかは、まだ確かめていない（関数はログインしないと呼べず、ここからは呼べない）。オーナーが開いたあと、`live_chart_fallback` にそのペアの行が入っているかで確かめられる。
- **仕組み**（金と同じ。`live-chart/logic.ts` の「the broker's pairs GMO does not serve」、live-chart v10）:
  - 足: 金と同じ読み方（`twelveBars`）。`live_chart_fallback` に保存し、足が確定するまでは読み直さない。800本。1日の読み込み上限（時間足ごと）も金と同じ数えで分け合う。履歴（Zone Shift など）とダウ理論も同じ足から。
    - その後（#176）: 読んで保存するのは1,400本。使うのはこれまでと同じ最新800本で、1,400本すべてを使うのは Zero-lag TEMA の深い過去だけ（§8.87）。
  - 現在値: 画面は ticker に表示中のペアを伝える。表示中のペアが15ペアのどれかなら、そのペアは毎回（5秒ごと）Swissquote を読む。残りの14ペアは、1回の読みで3つずつ、それぞれ1分に1回まで（一覧の価格のため）。3分以上答えのないペアの価格は返さない。
  - 価格の記録: 表示中のペアの Swissquote の中値を、1分に1行ずつ `live_tick_bars` に記録（金の `gold_tick_bars` と同じ作り、2日分、関数だけが読み書きできる）。上限に達したあとや Twelve Data が読めないとき、その後の足をこれで作る（金の #147 と同じ）。記録するのはそのペアのチャートが開かれている間だけ。
  - ペアを切り替えたら、その価格を次の5秒を待たずにすぐ頼む。切り替える前に頼んだ答えが後から届いても、新しい答えを上書きしない。
  - 画面の注記: 15ペア用の説明（足と価格の取得元、上限、1分5回の枠）、上限に達したときの表示（「ドル/カナダドルの1分足は…このペアのチャートが開かれている間だけ記録する…」）、一覧の下の説明（表示中以外の価格は1〜3分前のもの、人民元の2ペアが無い理由）。
- **見つけて直したこと**（金にも効く）:
  - Swissquote の答えは、プラットフォーム（3つ）の並びが答えごとに違い、`standard` の価格は1つ（AT）にしか無い。これまでは最初のプラットフォームの値を使っていたので、スプレッドが答えごとに変わりえた。どこにあっても `standard` を使うようにした。
  - 値動きの少ないペアの Swissquote の時刻は、最後に値が変わった時刻。ドル/香港ドルは、ほかのペアが1秒前のときに18分前だった（2026-09-28 月曜 17:53 UTC）。金と同じ「3分より古ければ休止中」だと、開いている市場で「市場休止中」と出てしまう。FX は、週の開いている時間は取引中とし（週の始まりと終わりの、夏時間で動く時間だけ値の古さで判断）、時刻は読んだ時刻にした。
  - Twelve Data の1分5回の枠（この関数のインスタンスごと）は、コードを読むと、同時に来た読み込みがまとめて枠のチェックを通りうる形だった（実際に起きたのは見ていない）。枠を先に取るようにした。また、ダウ理論の読み込み（4つの時間足）は枠の最後の2回を使わず、チャートの足に残す。
  - 保存していたペアが横一列の後ろの方にあると、開いたときにそのボタンが見えていなかった（#153 から。価格が入るとボタンが広がり、位置がずれる）。価格が入ったあとにもう一度合わせる。
- **気をつけること**:
  - Twelve Data の1日800回を金と分け合う。計算では、1つのペアを1分足で開いたままにすると1時間に約60回、ダウ理論も開いていると約77回（測ってはいない）。上限（1分足450・5分足600・その他720、1日の合計で数える）に達すると、その時間足は Swissquote の価格から足を作って続ける。
  - GMO にないペアや時間足を1分の間にいくつも開くと、1分5回の枠に当たり、チャートが1分ほど後に出ることがある（画面の説明に書いた）。
  - 楽天FXとは提供元が違うので、値段が少しずれる。スプレッドは Swissquote の standard のもので、楽天FXのものではない。
  - メール通知の対象（`ALERT_PAIRS`）と成績の記録には入れていない。過去のチャートでのサインの測定もしていない。
  - Swissquote の公開レートの利用条件は、読んでいない（金の #127 から同じ）。
- **確かめたこと**:
  - テスト（`src/test/twelve-pairs.test.tsx` の10件と、`pairs` / `gold` / `live-chart` の書き換え）で次のことを確かめた:
    - 15ペアの足と現在値を、それぞれのペアの記号で読むこと。
    - Swissquote の実際の答え（Nクローネ/円、3つのプラットフォーム）で、並びが変わっても同じ standard の値を取ること。
    - ドル/香港ドルの18分前の値が、月曜の夜は取引中、土曜は休止中、週の端では値の古さで決まること。
    - 読み込み結果が「このペア自身の配信」として扱われ、価格でチャートが動き、履歴も読むこと。
    - 5秒ごとの読みで、表示中のペアは毎回、残りは最初の25秒以内に1回、その後はほぼ1分に1回（1分より短い間隔では読まない）こと。
    - 記録の表が関数だけのものであること（マイグレーションの文面で）。
    - 画面で、一覧から選ぶ、すぐ価格を頼む、上限の表示、古い答えを捨てる、保存したペアが見えること。
  - わざと壊した11通り（standard を最初のプラットフォームだけで探す、FX を値の古さで休止にする、読む順を逆にする、切り替えてすぐ頼まない、古い答えを捨てない、15ペアを「このペア自身の配信」にしない、金の表から記録を読む、15ペアを金と書く、「このペアの」を落とす、価格で15ペアのチャートを動かさない、価格が入ったあとに列を合わせない）を、テストが見つけることを確かめた。
  - 全テスト 2209 件、型チェック（既存の12件のみ）、lint、Deno の型チェック。
  - Chromium で、スマホの大きさで見た目を確かめた（一覧、ドル/カナダドルを選んだあと、上限に達したときの表示、全画面の一覧、保存したドル/香港ドルで開いたとき）。価格はテスト用の作り物。
- **その後（#175、2026-10-01）**: 15ペアのうち、円の5ペア（香港ドル/円・SGドル/円・Nクローネ/円・ズロチ/円・チェココルナ/円）だけを残した（§8.86）。一覧の価格のために Swissquote を読むのも5ペアになった。
- **その後（#180、2026-10-02）**: ドル/カナダドルを戻した（§8.91）。この仕組みで読むのは、円の5ペアとドル/カナダドルの6ペアになった。一覧の価格のために Swissquote を読むのも6ペア。

### 8.67 Q-Trend と ULTRA の印が出たら、全銘柄でメールを送る（#155、signal-alerts v6）

- **指示**: リアルタイムチャート（ドル/円5分足）の画面を添えて「全ての銘柄でこのsellとbuyの判断がでたときstrongも含む。その時にメールが届く様にして」。続けて金5分足の画面を添えて「strongも」。
- **画面の印の内訳**（コードで確かめた）: 「BUY」「SELL」「STRONG」は Q-Trend（#145）、「Buy ☆」「Sell ☆」は ULTRA（#151）。
- **オーナーに確かめて決まったこと**:
  - 印: Q-Trend（BUY・SELL・STRONG）と ULTRA（Buy ☆・Sell ☆）の両方。
  - 時間足: 5分足・15分足・1時間足・4時間足・日足（1分足は送らない）。
  - GMO にない16銘柄（15ペアと金）: 1時間足・4時間足・日足まで（Twelve Data の無料枠のため）。**金の5分足・15分足は対象外**（2枚目の画面の金5分足の STRONG は届かない。1時間足以上の STRONG は届く）。
  - 送り方: 印ごとに1通。
  - 確かめる前に伝えた数字: 印の回数は、金1時間足（約1か月・585本）で Q-Trend が1日約1.5回（うち STRONG 約4分の1）、ULTRA が約0.8回。5分足は画面のドル/円で Q-Trend が約10時間に5〜6回。全銘柄で1時間足は1日約80通、5分足は1日数百通の見込み（どれも概算）。Resend の料金表（2026-09-29 に読んだ）: 無料は月3,000通・1日100通、Pro（月20ドル）は月5万通・1日の上限なし。オーナーの契約中のプランは、こちらからは見られない。
- **画面の印とメールを一致させる**:
  - Q-Trend と ULTRA の計算を `supabase/functions/_shared/`（`pine.ts`・`qtrend.ts`・`ultra.ts`）へ移し、画面（`src/lib/qTrend.ts`・`ultra.ts`・`supertrend.ts`・`trendTools.ts` は再エクスポート）とメールで同じコードを使う。移したコードは元と同じ（差分で確かめた。変えたのは import とコメント、Deno の型チェックのための型注記1か所）。
  - 足も同じ: メールの判定は、チャートの履歴と同じ関数（`live-chart/logic.ts` の `historyRead`・`historyOfBars`）で読んだ足（小数の丸めも同じ）で行う。
  - **計算の始まりの決め方を変えた**（#148 の続き）: Q-Trend の線は始まりの足で変わる。これまでは「持っている足の最初」から数えていたため、開いたままの画面（数時間前に読んだ履歴を持ち続ける）と、開き直した画面・メールで、始まりがずれることがあった。**最新の判定足から600本前の足**から数えるようにした（`anchoredStart` の `lastJudged`、`ANCHOR_WINDOW = 600`）。画面は、形成中の足や価格から作った足（判定しない足）を数えない。これで、開いたままの画面・開き直した画面・メールが同じ足から始まる。
    - この変更で、画面の Q-Trend・3✓・ULTRA の過去の印が、反映の時に一度だけ動くことがある（金など Twelve Data の銘柄は、これまで約800本前から数えていた）。
  - GMO の日足は、画面の履歴が今年と去年のファイルだけ（最大約520本）なので、600本に届かない。そのときは画面と同じく、持っている足の最初から数える。
- **巡回**（`signal-alerts` の新しいモード `indicators`、pg_cron で毎分）:
  - 購読されているチャートだけを読む。市場が閉まっている間（`isPossiblyClosed`）は何もしない（今の RSI＋SAR の巡回と同じ）。
  - GMO の21ペア: 5分足・15分足は足の確定の1分後と3分後、1時間足は毎時3分と5分、4時間足・日足は毎時4分と6分（GMO の4時間足・日足の区切りは確かめていないため毎時見る）。同じ足はインスタンスの中で二度判定しない。
  - GMO の足ファイルの保存: 画面と同じ600本を読むには、1時間足で1ペアあたり約70回の問い合わせが要る。終わった日（翌日の9時・日本時間を過ぎた日）と終わった年のファイルは変わらないので、`public.gmo_kline_files` に一度だけ保存し、その後は表から読む（関数だけが読み書き。2か月より前に保存したものは毎日3:07 UTC に消す）。GMO への問い合わせは0.2秒おき。
  - Twelve Data の16銘柄: チャートが保存している足（`live_chart_fallback`）を使い、その確定の足が無いときだけ読み直す（1回の巡回で3回まで、同じチャートは3分あけて）。1日の読み込みの数え方はチャートと共通で、メールの読み込みは780回まで（チャートの上限720回より上。チャートが上限に達した後もメールは読める）。
  - 1分を過ぎて次の巡回と重なったら、同じインスタンスでは後の方を「busy」で終える。
  - 新しさ: 5分足は確定から10分、15分足は20分、1時間足以上は30分までの印だけを送る。
- **メール**: 件名は「【Sextant】USD/CAD 1時間足 売り（SELL・STRONG）のサイン（Q-Trend）」「【Sextant】USD/JPY 5分足 買い（Buy ☆）のサイン（ULTRA）」など。本文は確定した時刻、Q-Trend は終値・越えた線・ε（ATR(14)×1）・STRONG の意味、ULTRA は RSI(14) の前後・エントリー・損切り・利確1〜3（金はドル、ほかは pips）。どちらも過去のチャートで検証していないこと、足の出どころ（GMO か Twelve Data）、止め方、投資助言でないこと。日本語と英語。
  - 送信は0.6秒おき（Resend は1秒2回まで）、「429」の制限に当たったら1.5秒後に1回だけ送り直す（今の RSI＋SAR のメールにも効く）。
  - 送信の記録は今の表（`signal_alerts`）に、ルールの名前（`qtrend_200_14_1_v1`・`ultra_rsi14_30_70_sl10_tp5_10_15_v1`）と STRONG かどうか（新しい列 `strong`）を付けて残す。同じ印は二度送らない（今と同じ一意の鍵）。成績の記録（`signal_events`）は付けない。
- **購読**: `signal_alert_subscriptions` の制約を広げた（37銘柄・5分足・`qtrend`/`ultra`）。どのルールでどのチャートを選べるかは関数が決める（RSI＋SAR と GA型は今までどおり7ペア・15分足以上）。
  - **見つけて直したこと**: 今の RSI＋SAR の巡回は、知らないルールの購読を RSI＋SAR として扱う作りだった。Q-Trend の購読を足すと、そこに RSI＋SAR のメールを送ってしまうところだった。今の巡回は RSI＋SAR と GA型の購読だけを読むようにした。
- **画面**（設定 → メール通知）: 種類のタブに Q-Trend と ULTRA を追加。37銘柄×5つの時間足の表で、GMO にない16銘柄の5分・15分は「—」。一番上の「すべての銘柄」の行で、時間足ごとに全銘柄をまとめてオン・オフ（一部だけオンのときは「－」）。最近の通知に「売り・STRONG（Q-Trend）」「買い（ULTRA）」。カード冒頭の説明を4種類にした。
- **気をつけること**:
  - 5分足・15分足を全銘柄でオンにすると1日に数百通になることがある。Resend が無料プランなら1日100通・月3,000通を超えた分は「送信失敗」になる（画面の説明にも書いた）。
  - 反映後の最初の数回は、GMO の足ファイルがまだ保存されていないため問い合わせが多く、1回の巡回が90秒の上限に達する。作り物の GMO での確認では、5分足は最初の回から判定できたが、1時間足（1ペア約70ファイル）はそろうまでに数回の巡回（1時間足は毎時2回なので2時間ほど）がかかる見込み。その間の一部のチャートは「unavailable」「deadline」でその回の判定を飛ばす。
  - Twelve Data の16銘柄は、毎時の区切りで最大16〜48チャートを1分3回ずつ読むため、メールが最大30分ほど遅れることがある（30分を過ぎた印は送らない）。
  - 金曜の最後の足（市場が閉まる時刻に確定する足）の印は、市場が閉まっている扱いの時間に入るため送らない（今の RSI＋SAR と同じ）。
  - Twelve Data が上限などで読めずチャートが価格から足を作っているとき（#147）、チャートはその足で判定するが、メールは Twelve Data の足でしか判定しない。
- **確かめたこと**:
  - テスト（`src/test/indicator-alerts.test.tsx` 14件、`signal-alert-settings.test.tsx` に4件）:
    - 始まりの決め方（最新の判定足から600本前・判定しない足を数えない）。開いたままの画面と開き直した画面で、Q-Trend と ULTRA の印が同じになること。
    - **足を1本ずつ進めながら、実際に描いた PriceChart の最新の確定足の印と、メールの判定が一致すること**（ドル/円5分足で120本、その間に Q-Trend・ULTRA・STRONG が出る。日足で600本に届かない場合も40本）。
    - 選べるチャート（16銘柄は1時間足以上）、ULTRA の単位（金はドル）、読む分、Twelve Data の新しさ、日ファイルを保存してよいか、STRONG・線・ε・損切り・利確の値。
    - 二つの巡回が自分のルールの購読だけを読むこと。
    - 設定画面: 37銘柄の表、16銘柄の「—」、1つのチェック、「すべての銘柄」でのまとめてオン・オフ（5分足は GMO の21ペアだけ、1時間足は37銘柄）、一部だけオンの表示、STRONG の表示。
  - わざと壊した9通り（始まりを持っている最初の足で決める、画面が判定しない足を数える〔Q-Trend・ULTRA それぞれ〕、メールの判定で始まりを合わせない、まとめてオンで16銘柄にも5分足を送る、STRONG を表示しない、ほか）を、テストが見つけることを確かめた。
  - 全テスト 2227 件、型チェック（既存の12件のみ）、lint、Deno の型チェック。
  - 関数の本体（`index.ts`）を、外への通信（データベース・GMO・Twelve Data・Resend）をすべて作り物に置き換えて実際に動かした（作業用の仕組み、リポジトリには入れていない）:
    - ドル/円5分足: 600本で判定し、画面側の計算と同じ印（ULTRA の買い）でメールを1通送った。GMO への問い合わせは22回（うち終わったファイル18個を保存）。
    - 同じインスタンスで3分後は、判定済みとして読まない（問い合わせ0回）。新しいインスタンスでは保存したファイルを表から読み、問い合わせは今日の分の4回。同じ印は二度送らない。
    - ドル/カナダドル1時間足: Twelve Data を1回だけ読み（1日の数えも1回）、画面側と同じ印（Q-Trend の強い売り）でメールを送った。1分後は読まない。土曜は何もしない。
    - 全銘柄・全時間足・両方の印を購読した量（306件）: 保存が空の最初の回は GMO へ452回で90秒の上限に達した。ファイルがそろった後の5分足の回は21チャートで約8秒（問い合わせ42回）、表から読み直す新しいインスタンスでも58チャートで約38秒。
  - Chromium で、スマホの大きさで設定画面を確かめた（値は作り物）。
- **本番への反映**（2026-09-28、UTC）:
  1. 19:3x に表の変更を入れた（`indicator_alerts`。制約・`gmo_kline_files`・`strong` 列を確かめた。既存の購読8件はどれも新しい制約の内側）。
  2. PR #115 をマージし、関数を反映した（signal-alerts v6）。
  3. 手で1回呼んで `mode: "indicators"`・v6・購読0件の答えを確かめてから、毎分の cron（`indicator_alerts_sweep`、jobid 15）を入れた。
  4. オーナーのアカウントに、選べる全チャート × 2種類の306件を登録した（言語は日本語、既存の購読と同じ）。
- **本番で確かめたこと**（19:39〜20:08 UTC、月曜の夜）:
  - 最初の5分足の回（19:41）: GMO の21ペアすべてで600本を読み、最新の確定足（19:35 始まり）で判定。42.8秒（上限90秒）、終わったファイル126個を表に保存、今日のファイルの問い合わせ84回。
  - 最初の15分足の回（19:46）は一部のペアが「deadline」、19:48 の回で残りを判定した。
  - 19:47 の既存の RSI＋SAR の巡回は v6 で、購読8件だけを読んだ（新しい306件を RSI＋SAR として扱っていない）。
  - メール: 20:05 までに11通、20:16 までに17通（登録から約37分）を送った（どれも Resend が受け付けた ID あり。受信箱での表示はこちらからは見ていない）。この速さが続けば1日に数百通になり、Resend の無料プラン（1日100通）なら数時間で上限に達する（最初の37分だけの数字）。例: 「MXN/JPY 5分足 ULTRA の買い（RSI 20.9→34.4）」「NZD/CAD 5分足 Q-Trend の買い」「MXN/JPY 5分足 Q-Trend の買い・STRONG」「GBP/CHF 1時間足 ULTRA の売り」「NOK/SEK 4時間足 Q-Trend の売り・STRONG」。確定から送信まで1分半〜5分。同じ印を別のインスタンスが判定し直しても、二度は送っていない（`duplicate`）。
  - 20:00 の区切り: Twelve Data の1時間足16銘柄は 20:01〜20:06 に判定（1回3つずつ）。GMO の4時間足・日足（年のファイル）は 20:04 に21ペアとも判定。GMO の1時間足は、ファイルがまだそろっていないため 20:03・20:05 の2回で21ペア中10ペアだけ判定し、11ペアはこの時間の足を飛ばした（見込みどおりの立ち上がり）。
  - **実際のチャート画面との突き合わせはしていない**: GMO の元データはこの作業環境から読めず（プロキシが403）、本番のチャートはログインが要るため。同じ計算であることはテストで確かめている。
- **反映後に見つけて直したこと（signal-alerts v7）**:
  - **Twelve Data の4時間足は UTC の 01:00・05:00・09:00・13:00・17:00・21:00 に始まる**（本番の保存足で確かめた。16銘柄とも。金も）。v6 は 00:00・04:00… に閉じると決めつけていたため、20:00 の区切りで「その足が無い」と読み直しを続け（1分ごと、30分間）、しかも 21:00 に閉じる足は判定しなかった。GMO にない16銘柄の4時間足の印は送られず、Twelve Data の1日の回数を無駄に使うところだった（この日の回数は 20:10 に111回で、上限の手前）。
  - 直し方:
    - 足がどこで始まるかを、保存されている足そのものから読む（`twelvePhase`）。閉じる時刻をそれに合わせる（`twelveCloseDue` の `phaseMs`）。夏時間などで Twelve Data の区切りが動いても、足に合わせて動く。
    - まだ足を見ていないチャートは、毎時の最初の30分に保存足を読んで区切りを知る。保存足が無ければ UTC の区切りで一度読んで知る。
    - 一つの区切りで Twelve Data を読むのは2回まで（区切りの1分後と、足が無ければその3分後）。何回読んだかは保存足の時刻（`fetched_at`）で数えるので、インスタンスが替わっても増えない（`twelveReadDue`）。
  - 確かめたこと（作業用の仕組みで、Twelve Data を本番と同じ区切りの作り物にし、毎分新しいインスタンスで動かした）:
    - v6: 20:00〜21:30 に4時間足2チャートを58回読み、21:00 の足は判定しなかった（本番と同じ）。
    - v7: 同じ時間で4時間足は各1回（21:01）、21:00 に閉じた足（17:00 始まり）で判定。
    - Twelve Data が2分半遅れる場合は各2回読んで判定。10分遅れる場合は各2回で諦め、その区切りは送らない。
    - 保存足が無い場合: 4時間足は 20:01 に一度読んで区切りを知り、21:01 に判定。日足は 00:02 に判定（00:00 の区切りを UTC で。Twelve Data が日足をいつ確定させるかは本番ではまだ見ていない）。
    - テスト3件を追加（区切りの読み方・閉じる時刻・読む回数の上限）。区切りを無視する変更と、回数の上限を外す変更を、それぞれテストが見つけることを確かめた。
  - **本番での確認（v7、20:20 UTC に反映）**:
    - 保存足の無かった4時間足9チャートは、20:21〜20:24 に各1回だけ読んで区切り（17:00 始まり）を知った。その後 20:30 まで4時間足は読んでいない（Twelve Data のこの日の回数は 20:32 に153回で止まった）。
    - 21:00 の区切り: Twelve Data の4時間足16銘柄を 21:06〜21:11 にすべて 21:00 に閉じた足（17:00 始まり）で判定し、GBP/CHF（ULTRA の売り）と USD/HKD（Q-Trend の買い）のメールを送った（v6 では送れなかった印）。1時間足16銘柄も 21:06 までに判定。
    - 同じ時刻: GMO の日足21ペアを 21:04 に、21:00（日本時間 6:00）に閉じた日の足で判定（CHF/JPY・GBP/USD・NZD/JPY の3通）。GMO の1時間足は21ペア中20ペアを判定（前の時間は10ペア。NZD/CAD は時間切れのあと読み込みに失敗）。
    - 19:47〜21:12 のメールは52通、すべて送信済み（失敗0）。応答の失敗（200以外・時間切れ）は0。Twelve Data のこの日の回数は 21:12 に185回。GMO のファイルの表は1,702件・2.3MB。
  - 気づいたこと（直していない）: チャート側（`live-chart` の `goldFresh`）も Twelve Data の足を UTC の区切りで読み直すため、4時間足は 21:00 に閉じた足が次の 00:00 まで読み直されないことがある（確かめていない）。メールの巡回は購読されているチャートの保存足を読み直すので、そのチャートではこの影響は出ない見込み（下のとおり、2026-09-29 からオーナーの4時間足は購読していない）。
- **1時間足だけにした（2026-09-29 00:26 UTC、オーナーの指示）**:
  - 指示: 「やっぱりメール送るの1時間足だけにして」。確かめて決まったこと: RSI＋SAR も1時間足だけにする（「これも1時間足だけ」）。設定画面は変えない（「画面はそのまま」: 5分足〜日足は選べるまま。コードは変えていない）。
  - それまでの送信: 19:47〜00:25 UTC に161通（5分足124・15分足24・1時間足4・4時間足3・日足6）、すべて送信済み（失敗0）。1日100通を超えても失敗していないので、Resend は無料プランの1日の上限には当たっていない（契約中のプランはこちらからは見られない）。
  - オーナーの購読から1時間足以外を外した: Q-Trend・ULTRA の232件（5分足・15分足 各21銘柄、4時間足・日足 各37銘柄、2種類）と、RSI＋SAR のドル/円 4時間足・日足の2件。残りは Q-Trend 1時間足37・ULTRA 1時間足37・GA型 1時間足5・RSI＋SAR ドル/円1時間足1の80件（すべてオーナーのもの）。
  - 確かめたこと: 00:26 以降の毎分の巡回は購読74件で、1時間足だけを読んでいる。00:32 の RSI＋SAR の巡回は購読6件（GA型5・RSI＋SAR 1）。この巡回が7ペアの15分足なども読むのは、成績の記録（#108）のためで今までどおり（メールは購読しているチャートだけ）。
- **5分足だけにした（2026-09-29 02:22 UTC、オーナーの指示）**:
  - 指示: 「やっぱり5分足だけにして 売買のタイミングのメール送るの」。確かめて決まったこと: RSI＋SAR と GA型は5分足を作っていない（15分足以上だけ）ため送らない（「送らない」）。設定画面は変えない（前回のまま）。
  - 1時間足だけだった間（00:26〜02:22）のメールは8通（すべて Q-Trend）。
  - オーナーの購読: Q-Trend・ULTRA の1時間足74件を外し、5分足を選べる GMO の21ペアに Q-Trend・ULTRA の5分足42件を入れた。RSI＋SAR（ドル/円1時間足）と GA型（5ペアの1時間足）の6件を外した。残りは Q-Trend 5分足21・ULTRA 5分足21の42件だけ。
  - GMO にない16銘柄（15ペアと金）は5分足を選べない（Twelve Data の無料枠）ため、この16銘柄のメールは届かない。
  - 確かめたこと: 02:24 以降の巡回は購読42件で、5分足だけを読んでいる（02:26・02:28・02:31 の回で21ペアを600本で判定）。02:32 の RSI＋SAR の巡回は購読0件（成績の記録のために読むのは今までどおり）。
  - 最初の5分足の回（02:26）で10通: 02:20 の足（日本時間 11:20〜11:25）で円の8ペア（ドル/円・ユーロ/円・ポンド/円・ペソ/円・ランド/円・カナダドル/円・フラン/円・クローナ/円）が Q-Trend の売り（うち2つ STRONG）、ほかに ULTRA の売り2つ（豪ドル/米ドル・NZドル/円、RSI が70を下へ）。円が一斉に動いたときは、5分足のメールがまとめて届く。19:47 からの合計は182通、失敗0。
- **その後（#175、2026-10-01）**: メールの対象は、円の17ペアと金の18銘柄（GMO にない6銘柄は1時間足以上）、RSI＋SAR と GA型は円の4ペアになった（§8.86）。外したペアのオーナーの購読38件は、マイグレーションで消した（2026-10-01 06:23 UTC）。
- **その後（#177、2026-10-01）**: ユーロ/ドルを戻した（§8.88）。メールの対象は19銘柄（GMO にない6銘柄は1時間足以上のまま）、RSI＋SAR と GA型は5ペアになった。
- **その後（#178、2026-10-02）**: 豪ドル/ドルも戻した（§8.89）。メールの対象は20銘柄、RSI＋SAR と GA型は6ペアになった。
- **その後（#180、2026-10-02）**: ドル/カナダドルも戻した（§8.91）。メールの対象は21銘柄（GMO にない7銘柄は1時間足以上）。RSI＋SAR と GA型は6ペアのまま（ドル/カナダドルは GMO にないので入らない。#175 の前も入っていなかった）。


### 8.68 買い・売りの合図の TP（#156）

- **指示**: ユーロ/ポンド5分足の画面（Q-Trend の BUY・STRONG、ULTRA の表、右上に「SL 0.85896」）を添えて「buy、sellの合図が出た時にtp出してくれないの？」。
- **分かったこと**:
  - 画面の「BUY」「SELL」「STRONG」は Q-Trend の印で、Q-Trend には元から TP も損切りも無い（#145。メールにも無い）。
  - ULTRA（Buy ☆・Sell ☆）には TP1〜3 と損切りがある（メールにもある）。ところが画面では、出ている取引の値札（SL・Entry・TP1〜3）がまとめて一つの塊として動かされていた。そのため、損切りがチャートより上、TP がチャートより下にあると（静かな5分足ではよくある）、「SL」だけが上の端に残り、Entry と TP は下にはみ出して見えなかった。添えられた画面がこれ（売りの損切り 0.85896 がチャートの10 pips 上、TP が5〜15 pips 下）。
- **直したこと**（`PriceChart.tsx` の `ulBox`）:
  - 値札は、その価格がチャートの中なら線の位置に置く。チャートの外なら、はみ出した側の端に寄せて「↑」「↓」を付ける（例「SL 0.85884 ↑」「TP1 0.85734 ↓」）。
  - 重ならないように上から順に離し、下の端からも押し戻す。5つの値札がいつもチャートの中に見える。
  - 値札の幅は矢印の分を見込んで空ける（右の余白が2文字ほど広がる）。
- **確かめたこと**:
  - 静かなユーロ/ポンド5分足の作り物の足で、直す前は売りの場合「SL」だけがチャートの中にあり、Entry と TP1〜3 は外にあった。買いの場合も TP2・TP3 だけで、価格がチャートの中にある Entry まで外に出ていた。直した後は5つともチャートの中にある。
  - テスト1件を追加した（`ultra.test.tsx`: 値札の文字と矢印、5つともチャートの中、価格の順、損切りは上の端・TP は下の端）。直す前の並べ方ではこのテストが落ちることを確かめた。
  - Chromium で、スマホの幅（390px）で表示を目で見て確かめた（値は作り物）。インジケーターを全部オンにしていると、左上の凡例が長くなり、上の端に寄せた値札と一部重なる（読める。直す前からある）。
  - 全テスト 2231 件、型チェック（既存の12件のみ）、lint。
- **Q-Trend の TP と損切りの決め方を3つ測った**（オーナーの選択「先に3つを測って比べる」。`research/qtrend-tp.ts`、GitHub Actions の `qtrend-tp.yml`。GMO はこの環境から読めないため）:
  - 決め方: A「線」＝損切りは次の終値で逆の合図が出る所（合図の後の線 ∓ ATR(14)）、TP はその幅の1・2・3倍。B「ULTRA と同じ」＝損切り10 pips、TP 5・10・15 pips。C「ATR」＝損切り ATR×1.5、TP ATR×1・2・3。
  - やり方（データを見る前に決めた）: GMO の5分足の売値・買値、メールの21ペア、2026-01-05〜2026-09-29（前半・後半の区切り 2026-05-18）。合図はメールと同じ判定（最新600本・同じ起点、チャートと同じ丸め）で、メールの関数 `indicatorSignals` と見本20,772本で比べて違いは0。合図の足の終値で入る（買いは買値、売りは売値。スプレッドを払う）。TPk か損切りのどちらか先に届いた方で全部決済（k ごとに別に測る）。同じ足で両方に届いたら損切りに数える。1日（288本）で決まらなければその足の終値で決済。合図は重なってもそれぞれ数える（メールと同じ）。区間は週ごとのまとまりを考えた95%。
  - **結果: どの決め方でも負け越し**（合図 76,594回、TP1 で決済した場合）:
    - A: TP に届く率 26.9%（損益ゼロに要る率 50%）、平均 −0.54R、1回あたり −2.22 pips（損切り幅の中央値 4.6 pips）。
    - B: 43.5%（要る率 66.7%）、−0.23R、−2.34 pips（1日で決まらない回が16%）。
    - C: 30.4%（要る率 60%）、−1.50R、−2.21 pips（損切り幅 4.2 pips）。
    - TP2・TP3 にしても、1回あたりの pips はほぼ同じ（−2.2〜−2.4）。前半・後半、STRONG とそれ以外でも同じ向き（後半の方が悪い）。
  - **負けの中身**:
    - スプレッド: 21〜23時 UTC（日本時間6〜9時）は払ったスプレッドの中央値が4.9 pips で、1回あたり −7.3〜−7.6 pips。17〜20時 UTC も −3.2〜−3.9 pips。00〜16時 UTC（日本時間9時〜翌1時）は −1.0〜−1.5 pips で、スプレッド（中央値0.9 pips）より少し大きい程度。
    - ペア: トルコリラ/円・フォリント/円・ランド/円・ペソ/円は ATR の損切り幅がスプレッドより狭く、C はすぐ損切りになる（例 フォリント/円 −12R）。ノルウェークローネ/スウェーデンクローナはスプレッド7 pips。
    - 物差し（同じトレンドの向きに6本ごとに入った場合、TP1）と比べても、合図の足で入る方がよくはない。主要7ペアで A −1.89 pips（物差し −1.66）、B −1.94（−1.76）、C −1.87（−1.60）。R では A だけ合図の方が少しよい（−0.27R と −0.32R）。
  - 読み方: 3つの中では B（ULTRA と同じ数字）が R で見て損が小さいが、損切り幅が広い分スプレッドの割合が小さいためで、1回あたりの pips はどれも同じくらい。この期間・この入り方では、TP と損切りの決め方で Q-Trend の5分足の合図が勝ち越しになることはなかった。
  - 確かめたこと: 作り物のランダムな5分足では、3つともスプレッドの分だけ負ける（エッジが無いところでエッジを作らない）。起点を1本ずらすとメールの関数との比較で違いが出る（比較が効いている）。
- **決まったこと**: オーナーの選択は「B」（ULTRA と同じ数字）。結果（どれも負け越し）を伝えたうえでの選択。
- **作ったこと**（signal-alerts v8）:
  - 計算: `_shared/ultra.ts` の、合図のあとを損切りか TP3 まで追う部分を `followTrade` として取り出した（ULTRA の動きは同じ。既存のテストで確かめた）。損切りと TP の値は `ultraLevels`。`_shared/qtrend.ts` の `qTrendTrades` が、Q-Trend の合図を同じように追う（その足の終値で入り、損切り10・TP 5・10・15。FX は pips、金はドル）。
  - チャート（`PriceChart.tsx`）: 最新の Q-Trend の合図に、エントリー（緑）・損切り（赤）・TP1〜3（青）の点線を引く（ULTRA は破線と色の帯、Q-Trend は点線だけ）。決着していなければ、右端に「Q」の付いた枠だけの値札（例「Q TP1 0.85727 ↓」）。ULTRA の値札と一つの列にまとめて並べるので重ならない。決着したら薄く、決着した足まで。ULTRA がオフでも、値札の分だけ最新の足の右を空ける。
  - メール: Q-Trend のメールに「損切り・利確の目安（ULTRA と同じ数字）」（エントリー・損切り・利確1〜3 と、それぞれの pips〈金はドル〉）を足し、「もともと目安がないため ULTRA と同じ数字を付けている」「過去の5分足では1回あたり平均で約2.3〜2.4 pips の負け。ほかの時間足は測っていない」と書いた。送信の記録（`signal_alerts`）にも損切りと TP1 が入るので、設定画面の「最近の通知」に ULTRA と同じく目安の行が出る。
  - チャートの凡例: Q-Trend に損切り・利確の説明と測った結果を足した。Q-Trend と ULTRA の凡例にあった「表示のみで、メールには使っていません」は #155 から事実と違っていたので、「メール通知にも使っています」に直した。Q-Trend の「過去の検証はまだしていません」も、今回の測定に合わせて書き直した。
- **確かめたこと**:
  - `qTrendTrades`: 値（終値から10・5・10・15の単位）、届いた足・損切りの足・終わった足が、テストの中で別に書いた単純な追い方と一致すること、確定足だけを使うこと（テスト3件）。
  - チャート: 静かなユーロ/ポンド5分足で、Q-Trend の値札の値が、チャートと同じ手順を別に計算した値と一致すること。ULTRA と合わせて10枚の値札が、チャートの中で重ならず価格の順に並ぶこと。ULTRA がオフでも右に余白があること。Q-Trend がオフなら何も描かないこと（テスト3件）。値札を並べ直さずに描く変更をテストが見つけることを確かめた。Chromium のスマホの幅（390px）で目でも見た。
  - メール: 足を1本ずつ進める既存の一致のテスト（120本）で、新しい足に Q-Trend の合図が出たときの損切り・TP が、チャートの値と一致すること。メールの文面（日本語・英語、金はドル、ULTRA のメールは変わらない）。メール側だけ幅を変えるとテストが落ちることを確かめた。
  - 全テスト 2238件、型チェック（既存の12件のみ）、lint、Deno の型チェック。
- **本番での確認**（2026-09-29、UTC）: 03:37 に関数を反映（signal-alerts v8、03:38 の回から v8・購読42件）。03:46 に Q-Trend の5分足のメールが3通（ドル/円の買い: エントリー 157.373・損切り 157.273・TP1 157.423、豪ドル/カナダドルの売り: 0.9945・0.9955・0.9940、トルコリラ/円の買い: 3.209・3.109・3.259）。送信の記録に損切りと TP1 が入り、どれも10 pips・5 pips の所。受信箱での表示はこちらからは見ていない。
- **気づいたこと（直していない）**: 値の安い円のペアでは、10 pips（0.10円）が価格に比べて大きい。トルコリラ/円（約3.2円）では価格の約3%、フォリント/円（約0.49円）では約20%で、損切りにも TP にもほぼ届かない。ULTRA では前からあったこと（#151 から、FX はすべて同じ pips を使う決め事）。測定でも B の「1日で決まらない」回の多くはこうしたペアだった。

### 8.69 メールを送る時間足: 足ごとの勝率を測り、4時間足にした（#157）

- **指示**（2026-09-29）: 「売買のタイミングのメールを送る時、今は5分足ですが、全体的に何分足の売買のタイミングが勝率が高いか判断してもらってその足でメールを送る様にしてください」。測定の途中で、オーナーが「4時間足でいきます」「4時間足でbuy、sell、strongのシズナルが出たらメールください」と決めた（結果が出る前）。
- **測り方**（`research/tf-winrate.ts`、GitHub Actions の `tf-winrate.yml`。データを見る前に決めた）:
  - 合図: メールと同じ判定（`indicatorSignals` と同じ窓・同じ起点・チャートと同じ丸め）で、GMO の21ペアの5分・15分・1時間・4時間・日足の Q-Trend（BUY・SELL、STRONG を含む）と ULTRA（Buy・Sell）。日足の窓は本番と同じ「今年と去年のファイル」。期間 2024-01-01〜2026-09-29、前半・後半の区切り 2025-05-19。
  - メールで送られる合図だけを数えた: 巡回は市場が閉まっているかもしれない間（金曜21時〜日曜22時 UTC）は動かないので、その間に確定する足の合図は送られない（数は別に出した）。
  - 勝ち負け: メールに書く値そのもの（その足の中値の終値から損切り10 pips、TP1〜3 5・10・15 pips）。合図の足の終値で入り（買いは買値、売りは売値。スプレッドを払う）、GMO の5分足の売値・買値で追う。損切りより先に TP1 に届いたら勝ち。同じ5分足で両方に届いたら損切りに数える。5日（5分足1,440本）で決まらなければその時点で決済し、勝率からは外す（ULTRA の表と同じ）。区間は週ごとのまとまりを考えた95%。
  - あわせて出したもの: Q-Trend・ULTRA 別、前半・後半、5分遅れて入った場合、物差し（同じ足の終値にでたらめに入った場合。両方の向き、抽出した足）、STRONG とそれ以外、時間帯、ペアごと。
  - 選び方: 最初は「勝率の数字が一番高い足」にしていた。作り物のランダムな値動き（どの足も本当の勝率は同じ）で試すと、2回とも日足が選ばれた（30回で83%、379回で68%）。回数が一番少なくぶれが大きい足が、偶然で一番になっていた。そこで実データを見る前に、「勝率の95%区間の下の端が一番高い足」に変えた。作り物では5分足が選ばれ、2番目との差も物差しとの差も誤差の範囲だった。
  - 確かめたこと: メールの関数との照合で違いは0（5分足 51,557・15分足 19,577・1時間足 8,279・4時間足 5,491・日足 3,221 本）。合図の足の終値は、その時刻に終わる5分足の終値とすべて一致（時刻のずれなし）。
- **結果**（両方の合図を合わせて、終値で入った場合）:

  | 時間足 | 勝率（TP1が先） | 95%区間 | 回数 | 1回あたり | 物差し |
  |---|---|---|---|---|---|
  | 5分足 | 59.4% | 59.0〜59.8% | 307,686 | −1.99 pips | 59.9% |
  | 15分足 | 60.0% | 59.4〜60.5% | 98,775 | −1.81 pips | 60.0% |
  | 1時間足 | 61.8% | 60.9〜62.7% | 23,726 | −1.52 pips | 59.9% |
  | 4時間足 | 62.2% | 60.5〜64.0% | 5,850 | −1.20 pips | 60.2% |
  | 日足 | 35.3% | 31.6〜39.0% | 725 | −9.34 pips | 41.8% |

  - 決めておいた選び方（区間の下の端）では1時間足（60.9%）がわずかに上で、4時間足（60.5%）が2番。勝率そのものは4時間足が一番。4時間足と1時間足の差は +0.4 ポイント（区間 −1.4〜+2.2）で、誤差の範囲。前半は1時間足 61.6%・4時間足 61.3%、後半は4時間足 63.3%・1時間足 62.0%。5分遅れて入ると、1時間足 59.5%・4時間足 59.2%。
  - 1時間足の合図は、物差しより +1.9 ポイント（区間 +1.1〜+2.7）。4時間足は 62.2% と 60.2%（差の区間は出していない）。
  - どの足も負け越し。損切り10・TP1 5 では、スプレッドを払って勝ち越すには約67%以上が要る。
  - 4時間足の内訳: Q-Trend 61.4%（4,109回）、ULTRA 64.2%（1,741回）。Q-Trend の STRONG 62.3%、それ以外 61.0%。足の始まりが 00〜05時 UTC の合図は 66.8%、12〜16時 UTC は 57.3%（あとから分けた数字で、確かめてはいない）。
  - 日足が極端に悪いのは、GMO の日足が 21:00 UTC（日本時間6時）に確定し、その時刻のスプレッドが一番広いため（払ったスプレッドの中央値 7.9 pips、物差しも 41.8%）。
  - 測れていないこと: 4時間足は14ペアだけ（#153 で足した7ペアは GMO のデータが 2026-05-17 からで、600本の窓に届かない）。Twelve Data の16銘柄（15ペアと金）は測っていない。GMO の読み込みは340回失敗（1ペア・1つの足あたり数日分）、ポンド/ドルの日足は取れなかった。
- **GMO の4時間足・日足の時刻**（この測定のデータで分かったこと）: GMO の4時間足は UTC の 0・4・8・12・16・20時に始まる（確定は日本時間 1・5・9・13・17・21時）。日足はどれも 21:00 UTC 始まり。Twelve Data の4時間足は 01:00・05:00… UTC 始まり（§8.67 v7、確定は日本時間 2・6・10・14・18・22時）。
- **購読を4時間足にした**（2026-09-29 05:49 UTC、オーナーの指示「4時間足でいきます」）:
  - オーナーの購読: Q-Trend・ULTRA の5分足42件（GMO の21ペア）を外し、4時間足74件（全37銘柄 × 2種類。GMO の21ペアと Twelve Data の15ペア・金）を入れた。前に「1時間足だけ」にしたときと同じく、選べる全銘柄。設定画面とコードは変えていない。
  - 5分足だった間（02:22〜05:49）のメールは100通（Q-Trend 68・ULTRA 32）、失敗0。
  - 確かめたこと: 05:50 の回から購読74件。06:04・06:06 の回で GMO の21ペアの4時間足を読み、エラーなし（14ペアは600本、#153 で足した7ペアは577本）。一番新しい確定足は 00:00 UTC 始まりの足で、合図なし。Twelve Data の16銘柄はこの時間は読まない（次の確定が 09:00 UTC のため。実際に読むところはまだ見ていない）。
  - 最初の確定での確認（2026-09-29、UTC）: 08:04・08:06 の回で GMO の21ペアの 04:00 始まりの足を判定し、エラーなし。09:01〜09:06 の回で Twelve Data の16銘柄の 05:00 始まりの足を1回3つずつ読み、エラーなし（09:06 に16銘柄そろった。その後の回は保存足で判定し、Twelve Data は読んでいない）。メールは3通、どれも送信済みで重なりなし: 08:04 豪ドル/米ドル 4時間足 Q-Trend 売り（エントリー 0.6989・損切り 0.6999・TP1 0.6984）、08:04 豪ドル/カナダドル 同じく売り（0.99162・0.99262・0.99112）、09:04 ユーロ/豪ドル（Twelve Data）Q-Trend 買い（1.62314・1.62214・1.62364）。受信箱での表示はこちらからは見ていない。
  - 気づいたこと（直していない）: 巡回は金曜21時〜日曜22時 UTC に動かないため、週の最後の GMO の4時間足（金曜 20:00 UTC 始まり、土曜 0:00 UTC に確定）と Twelve Data の4時間足（金曜 17:00 UTC 始まり、21:00 UTC に確定）の合図は送られない。日足も金曜に確定する足は送られない（測定で192回）。
  - メールと凡例の「過去の5分足で測ると…ほかの時間足は測っていません」は、この測定で古くなった（4時間足は1回あたり −1.2 pips）。
- **メールとチャートの説明を、この測定に合わせて直した**（オーナーの指示「直して」、signal-alerts v9）:
  - メール: Q-Trend と ULTRA のメールに、そのメールの時間足で測った数字を書く（例: 4時間足の Q-Trend「過去の4時間足（2024年1月〜2026年9月、GMO の FX、スプレッド込み）で測ると、この目安で損切りより先に利確1に届いたのは 61.4%（損益ゼロには67%より上が要ります）で、利確1か損切りで全部決済すると1回あたり平均で約1.35 pips の負けでした。」）。数字は `indicators.ts` の `INDICATOR_MEASURED`（上の測定の Q-Trend・ULTRA 別、終値で入った場合）。Twelve Data の15ペアと金のメールには「〇〇 そのものは測っていません（GMO の FX の値です）」を足す。ULTRA のメールの「動画の勝率（79〜80%）は、このアプリでは測っていません」は「動画（金）の勝率は79〜80%です」＋測った数字にした。
  - チャートの凡例（Q-Trend・ULTRA、日本語・英語）: 5つの足の勝率と1回あたりの pips を並べ、「金と Twelve Data の銘柄は測っていません」とした。
  - §8.68 の5分足の数字（1回あたり約2.3〜2.4 pips の負け）は、TP を自分の約定値から測り、1日で決済した別の測り方の値。今回の数字（5分足の Q-Trend は約2.10 pips の負け）は、メールに書く値そのもの（中値の終値から）で、5日まで追った値。
  - 確かめたこと: テスト（メールの文面: 5分足・4時間足の数字、Twelve Data の銘柄の一文、英語、ULTRA。凡例の数字）。表の値を1つ変えるとテストが落ちることを確かめた。全テスト 2238件、型チェック（既存の12件のみ）、lint、Deno の型チェック。
- **その後（#175、2026-10-01）**: アプリは円のペアと金だけになった（§8.86）。この測定は GMO の21ペア（円以外を含む）で行ったもので、メールとチャートに書いている数字はそのままにしている（円のペアだけで測り直してはいない）。オーナーの4時間足の購読は36件（18銘柄 × 2種類）になった（2026-10-01 06:23 UTC）。`tf-winrate.ts` などの研究は、やり直しても同じ21ペアを測る（`GMO_STUDY_PAIRS`）。
- **その後（#177、2026-10-01）**: ユーロ/ドルを戻した（§8.88）。ユーロ/ドルはこの測定の21ペアに入っている。オーナーの4時間足の購読は、ユーロ/ドルの Q-Trend・ULTRA を登録し直して38件（19銘柄 × 2種類）になった（2026-10-01 16:51 UTC）。
- **その後（#178、2026-10-02）**: 豪ドル/ドルも戻した（§8.89）。豪ドル/ドルもこの測定の21ペアに入っている。オーナーの4時間足の購読は、豪ドル/ドルの Q-Trend・ULTRA を登録し直して40件（20銘柄 × 2種類）になった（2026-10-02 01:22 UTC）。
- **その後（#180、2026-10-02）**: ドル/カナダドルも戻した（§8.91）。ドル/カナダドルは GMO にないので、この測定（GMO の21ペア）には入っていない。オーナーの4時間足の購読に、ドル/カナダドルの Q-Trend・ULTRA を登録し直した（09:31 UTC。購読は42件。§8.91）。

### 8.70 Stoch・BLSH・MACD で合図を絞る案を測り、入れなかった（#158）

- **指示**（2026-09-29）: ドル/円1時間足の画面（GA型の SELL が上昇中に続けて損切りになっている所）を添えて「なぜ失敗したかを考えて、反省して今後判定するのに学習するようにして」と送ったあと、それを止めて、チェコ・コルナ/円4時間足の画面（Q-Trend・ULTRA・Stoch・BLSH・MACD）を添えて「buyとsellの判断はstochとblshとmacdを考慮して判断して出す様にして」。その後「Stoch・BLSH・MACDを考慮してbuyとsellの判断をするともっと正確にbuyとsellをだせると思う」。
- **決まったこと**（オーナーの選択）: 決め方は「3つとも同じ向き」（BUY は Stoch の %K が %D より上・BLSH の面が緑〈0より上〉・MACD がシグナルより上、SELL は逆）。対象は Q-Trend と ULTRA の両方（チャートの印とメール）。入れる前に過去のデータで測って比べる。
- **準備**: Stoch・BLSH・MACD の計算を `supabase/functions/_shared/`（`stochastic.ts`・`blsh.ts`・`macd.ts`）へ移した。画面側（`src/lib`）は読み直すだけで、計算は変えていない（BLSH が使う Zone Shift の SMA・EMA も、足し算の順番まで同じまま `_shared/pine.ts` へ移した）。値まで確かめている既存のテスト（6ファイル・78件）と全テストで確かめた。判定は `_shared/confirm.ts`（`confirmRead`・`confirms`）。
- **測り方**（`research/confirm.ts`、GitHub Actions の `confirm.yml`。データを見る前に決めた）: §8.69 の測り方そのまま（GMO の21ペア、5分足〜日足、2024-01-01〜、メールで送られる合図、損切り10・TP1 5 pips、スプレッド込み）で、合図ごとにその足で3つがそろったかの印を付け、「全部（今のメール）」「そろった合図（絞ったあとのメール）」「そろわなかった合図」を比べた。3つの値は合図と同じ足（Q-Trend の起点）から計算し、その窓だけで計算し直した値と見本で比べた。でたらめに入った場合（物差し）も、3つがそろった所だけと比べた。決め方: 4時間足・両方合わせて・期間全体で、絞ると勝率がはっきり（区間がすべて0より下）下がるなら入れる前に相談、そうでなければ入れる。
- **確かめたこと**: メールの関数との照合で違い0（合図: 5分足 51,718・15分足 19,610・1時間足 8,319・4時間足 5,492・日足 3,468 本）。3つの判定を窓だけで計算し直した値との違いも0（各足 約3,300〜4,700 本）。作り物のランダムな値動きでは、どの足もそろった合図とそれ以外に差がなかった。
- **結果**（損切りより先に TP1 に届いた割合、両方の合図を合わせて）:

  | 時間足 | 全部 | そろった合図 | 残る割合 | 差（そろった−全部） |
  |---|---|---|---|---|
  | 5分足 | 59.4% | 58.2% | 25% | −1.2（区間 −1.6〜−0.8） |
  | 15分足 | 60.0% | 59.0% | 25% | −1.0（−1.7〜−0.3） |
  | 1時間足 | 61.8% | 61.2% | 24% | −0.6（−1.9〜+0.7） |
  | 4時間足 | 62.3% | 61.1% | 23% | −1.1（−4.0〜+1.7） |
  | 日足 | 35.3% | 44.5% | 23% | +9.2（+2.3〜+16.2） |

  - 4時間足の1回あたり: 全部 −1.16 pips、そろった合図 −1.34 pips。前半・後半とも、そろった合図の方が少し低い（−1.9・−0.4 ポイント、どちらも誤差の範囲）。Q-Trend だけでは 61.4% → 61.1%（残るのは33%）。ペアごとには上がるもの・下がるものがあり、そろった方がよいとは言えない。
  - ULTRA: 4時間足・日足では3つがそろうことが一度もなく（4時間足 1,811回中0回）、5分足でも 79,331回中214回。ULTRA は RSI が売られすぎ・買われすぎから戻った所で出るため、そのとき BLSH の面は反対の色になる（BLSH には RSI が入っている）。入れると ULTRA のメールは来なくなる。
  - 物差し: でたらめに入った場合も、3つがそろった所の方が勝率は高くない（4時間足 60.2% → 59.9%、15分足 60.0% → 58.9%）。3つが同じ向きになった時点では、損切り10・TP1 5 の決め方にとって有利になっていない。
  - 日足だけ上がったが、損益ゼロに要る約67%からは遠い。作り物の値動きでも日足は同じくらい上がった（回数が少ないため）ので、偶然の可能性がある。
- **決まったこと**: 決めておいた基準では「はっきり悪くはない」ので「入れる」側だったが、良くもなっておらず、ULTRA のメールが来なくなることを伝えたうえで、オーナーの選択は「入れない」。メールとチャートは変えていない。`_shared/confirm.ts` と `research/confirm.ts` は測定をやり直せるように残した（本番のコードからは読んでいない）。3つの指標を `_shared` へ移したことはそのまま（計算は同じ）。

### 8.71 合図と Stoch・BLSH・MACD の全パターンを測り、どれも入れなかった（#159）

- **指示**（2026-09-29）: §8.70 のあと「で実際にStoch・BLSH・MACDを考慮してbuyかsellを判断すると勝率はどうなるの？」、続けて「全てのパターン試してみて勝率の良い方法を採用して」。聞いたところ、オーナーの選択は「幅は今のままで勝率で比べる」（損切り10・TP1 5 pips のまま）と「4時間足のまま」。
- **測り方**（`research/patterns.ts`、GitHub Actions の `patterns.yml`。パターンと選び方はデータを見る前に決めた）:
  - パターン: 合図（Q-Trend・その STRONG だけ・ULTRA・どちらか〈今のメール〉・合図なし）と、入る足での3つの条件（買いの場合。売りは逆）の組み合わせ。
    - Stoch（14, 1, 3）: 問わない・%K が %D より上・下・20以下・80以上・50より下・50より上
    - BLSH: 問わない・面が緑（0より上）・赤（0以下）・前の足より上がった・下がった
    - MACD（12, 26, 9）: 問わない・ヒストグラムが0より上・下・前の足より上がった・下がった・MACD 線が0より上・下
    - 5 × 7 × 5 × 7 = 1,225 から「合図なし・条件なし」を除いた 1,224 通り。「合図なし」は、3つの条件が前の足ではそろっておらず、その足でそろった所で入る。
  - 勝ち負けは §8.69 と同じ（GMO のペア、4時間足、2024-01-01〜、メールで送られる合図、中値の終値から損切り10・TP1 5 pips、スプレッド込み、5分足で5日まで追う、区間は週ごとのまとまりを考えた95%）。3つの値は合図と同じ足（Q-Trend の起点）から計算した。
  - 選び方: 前半（2025-05-19 より前）だけで、決済が150回以上あるパターンのうち、勝率の区間の下の端が一番高いものを選ぶ。後半で、勝率が今のメール（どちらかの合図・条件なし）より高く、かつ区間の下の端が物差し（すべての足の終値で両方の向きに入った場合）の勝率より高ければ入れる。そうでなければメールは今のまま。
  - 確かめたこと: メールの関数との照合で違い0（4,603本）。3つの値を窓だけで計算し直した値との違いも0（4,603本）。GMO の読み込みの失敗0。作り物のランダムな値動き（どのパターンも本当の勝率は同じ）の2組（12ペアずつ）では、2回とも「今のまま」になった。後半の物差しとの差の平均は −0.56・−0.21 ポイント、区間の下の端が物差しより上のパターンは 3.0%・0.2%。
- **結果**（損切りより先に TP1 に届いた割合）:

  | | 前半 | 後半 |
  |---|---|---|
  | 今のメール（どちらかの合図・条件なし） | 61.2%（58.8〜63.7%、2,939回、1回あたり −1.28 pips） | 63.2%（61.0〜65.3%、2,724回、−1.08 pips） |
  | 物差し（すべての足の終値、両方の向き） | 59.3%（58.7〜59.9%、56,550回、−1.66 pips） | 61.4%（61.1〜61.8%、52,812回、−1.47 pips） |
  | 選ばれたパターン | 64.9%（下の端 61.7%、1,036回） | 64.7%（61.2〜68.2%、921回） |

  - 選ばれたパターン: どちらかの合図で、買いは Stoch の %K が50より下・BLSH が前の足より上がった・MACD のヒストグラムが前の足より上がった（売りは %K が50より上・BLSH が下がった・ヒストグラムが下がった）。
  - 後半で今のメールより 1.5 ポイント高いが、区間の下の端（61.2%）が物差し（61.4%）に届かなかったので、決めておいた選び方では「入れない」。
  - 残る合図は今のメールの約3分の1（後半 921回 / 2,724回）。1回あたりの pips はこのパターンについては出していない。勝率 64.7% は、損益ゼロに要る約67%より下。
  - 前半で決済150回以上のパターンは 1,224 通り中 565。後半で今のメールより高かったのは 565 中 279（約半分）。
  - 作り物のランダムな値動きの1組でも、同じパターンが「どちらかの合図」の中で一番になり、後半 68.3%（今のメール 64.9%）だった。本当の勝率がどれも同じデータでも、この程度の差は出る。
  - 上位のパターンの多くは「買いは Stoch の %K が50より下（売りは50より上）」を含む。その条件だけ（どちらかの合図・%K 50より下）では後半 63.9%（60.6〜67.2%、1,052回）で、今のメールとほとんど変わらない。
  - 合図ごとの一番（前半で選んだもの、後半）: Q-Trend（%K 50より下・ヒストグラム0より下）65.7%（245回）、STRONG（条件なし）65.1%（622回）、ULTRA（%K 50より下・BLSH 上がった・ヒストグラム上がった）65.4%（664回）、合図なし（ヒストグラム上がった）62.4%（6,990回）。
  - 実データでは、後半の物差しとの差の平均が +1.49 ポイント、区間の下の端が物差しより上のパターンが 103（18.2%）で、作り物より多い。今のメール自身が物差しより約2ポイント高い（前半 61.2% と 59.3%、後半 63.2% と 61.4%）ことが大きいと考えられる（分けて確かめてはいない）。
  - 測れていないこと: 4時間足は14ペアだけ（§8.69 と同じ。#153 で足した7ペアは600本の窓に届かない）。Twelve Data の16銘柄は測っていない。
- **決まったこと**: 決めておいた選び方で「今のまま」。メールとチャートは変えていない。`research/patterns.ts` と `patterns.yml` は測定をやり直せるように残した（本番のコードからは読んでいない）。

### 8.72 チャートに線を引けるようにした（描画ツール、#160）

- **指示**（2026-09-29）: 「他のfxと株のアプリみたいにチャートに線引けたりできる様にして 色々機能調べて追加して」。
- **調べたこと**（ほかのアプリの描画機能）:
  - TradingView: ツールの分類（線・チャネル、フィボナッチ・ギャン、図形、文字、ロング／ショート、値幅・期間の計測など）。操作は、トレンドライン・フィボナッチ・長方形・計測が2点、平行チャネルが3点、水平線・垂直線・ロング／ショートが1点。マグネット（弱＝始値・高値・安値・終値の近くだけ吸着、強＝いつも吸着。Ctrl／Cmd を押している間は切り替わる）、描いた後も同じツールのまま、すべて隠す、すべて削除、固定、元に戻す（Ctrl+Z）。線は銘柄ごとで、どの時間足にも出る。
  - iSPEED FX: トレンドライン（単線・複線）、水平線、垂直線、フィボナッチ（リトレースメント・タイムゾーン・ファン・アーク）。描画ボタン → ツール → 始点と終点。選んで消す・全部消す。「ラインキープ」で同じペアの線を別の時間足にも出す。
  - MT4: トレンドライン（右へ延長が既定）、水平線、垂直線、等間隔チャネル、フィボナッチ、長方形、文字、矢印。フィボナッチの既定の水準は 0・23.6・38.2・50・61.8・100・161.8・261.8・423.6。
  - GMO（FXネオ）: 始点をタップするとき画面上部に虫メガネ（拡大表示）、マグネット、線や端のドラッグで移動、削除・全削除。外為どっとコム・DMM FX などにも虫メガネ。
  - 調べ方の限界: 各社のサイトはこの環境から開けず、多くは検索結果の抜粋と第三者の説明による。フィボナッチ（リトレースメント・タイムゾーン）の既定の水準と色は、TradingView の Charting Library の説明書の写し（GitHub）で確かめた。iSPEED FX の既定の水準・色は確かめていない。
- **入れたもの**（ライブチャート。カードと全画面の鉛筆ボタン）:
  - ツール18種類: 線（トレンドライン・水平線・垂直線・レイ・水平レイ・延長線・平行チャネル）、フィボナッチ（リトレースメント・タイムゾーン・ファン・アーク）、図形・文字・計測（長方形・テキスト・上矢印・下矢印・値幅と期間の計測・ロングポジション・ショートポジション）。「ツール」ボタンで一覧を開いて選ぶ（スマホの幅では1列に並びきらなかったため）。
  - 描き方: タップ（クリック）で1点ずつ置く。1点目からドラッグして離すと2点目まで一度に引ける。置く間は十字カーソルでその位置の価格と時刻を出す。マウスでは、次の点がカーソルについてくる。
  - 描いた線: タップで選ぶ → 線をドラッグで移動、丸い点をドラッグで端を移動。色（10色）・太さ（1〜4）・線の種類（実線・破線・点線）・文字・固定・複製・削除。Delete キーで削除、Esc で描きかけ・選択をやめる、Ctrl+Z で元に戻す、Ctrl+Y／Ctrl+Shift+Z でやり直す。選んだ線の色・太さ・線の種類は、次に描く線にも使う。
  - 描画のバー: マグネット（オフ・弱・強）、続けて描く、すべて隠す、元に戻す、やり直す、このペアの線をすべて削除（もう一度聞く）。
  - 表示: 水平線・水平レイの価格を右の目盛りに線の色で出す。選んだ線の点の価格も出す。計測は値幅（pips と%）・本数・時間、ロング／ショートは利確・損切りの価格と pips、リスクリワードを出す。
  - 右の余白: 最新の足より左へドラッグすると、右に空きが出る（表示中の本数の半分まで、少なくとも10本）。タイムゾーンやポジションの箱を未来の側へ描くため（TradingView の右の余白と同じ役目）。戻す方へドラッグすると、先に余白が閉じる。#116 の「全体を表示しているときは横に動かない」は、左へのドラッグでは余白が出るように変わった。
- **既定値**（新しく決めたもの）:
  - フィボナッチ・リトレースメント: TradingView の既定の11水準（0・0.236・0.382・0.5・0.618・0.786・1・1.618・2.618・3.618・4.236）と色。0が2点目、1が1点目（TradingView・MT4 と同じ向き）。
  - タイムゾーン: 2点の間の本数 ×（0・1・2・3・5・8・13・21・34・55・89）。ファン: 1点目から、2点目の時刻の 38.2%・50%・61.8% の価格を通る線。アーク: 2点目を中心に、2点の長さの 38.2%・50%・61.8%・100% の半円（ファンとアークは一般的な定義で、iSPEED FX の既定値と同じかは確かめていない）。
  - ロング／ショート: 1タップで置き、利確と損切りは表示中の値幅の8%ずつ、箱は表示中の本数の6分の1（8本以上）。点を動かして合わせる。
  - マグネットはオフ、続けて描くはオフ、新しい線は青・太さ2・実線（フィボナッチ・図形・計測・ポジションは太さ1）。
- **保存**: 線はペアごと（どの時間足にも、時刻と価格の位置で出る）。この端末（`localStorage`）と、ログインしていればアカウント（新しい表 `user_chart_drawings`、1行＝1人の1ペア、本人の行だけ読み書き、`src/lib/drawingsSync.ts`）。ログインしたとき、アカウントにあるペアはアカウントの線を使い、この端末にしかないペアはアカウントへ送る。その後は変えてから0.8秒後に、変わったペアだけ書く。1ペア200本まで（それ以上は描けないと表示する）。描画のバーの設定（マグネット・続けて描く・隠す・新しい線の見た目）はチャートの設定（§8.53、#141 の `user_chart_prefs`）に入れた。
- **無料ユーザー**: 描画ツールには鍵をかけていない（#140 の鍵はインジケーターだけ）。
- **確かめたこと**:
  - テスト: 描画の計算（時刻と位置の変換、各ツールの形、当たり判定、マグネット、移動、保存形式の検証、この端末への保存）30件、チャートでの操作（タップ・ドラッグ・マウスで描く、選ぶ、動かす、固定、色・太さ・線の種類、削除・元に戻す・やり直す、隠す・全削除、Esc、続けて描く、マグネット、文字、ポジション、計測、ペアごと・別の時間足、右の余白、指の小さな揺れ、ダブルクリック、200本）とアカウントとの同期 26件。右の余白のテスト2件を足し、#116 のテスト1件を今回の動きに合わせて書き直した。全テスト 2,296件、型チェック（前からある12件のみ）、変更したファイルの lint、本番用のビルド。
  - ブラウザ（スマホの大きさ 390×844、タッチ）: ドラッグとタップで描く、選んで色を変える・動かす、何もない所をタップで選択を外す、描いている間ページが動かない、全画面、横向き（844×390）、白背景、右の余白へのタイムゾーン、文字の入力。
  - データベース: 表を作り（`apply_migration`）、行単位の権限で本人の行は書け、他人の行と未ログインの読み取りは断られることを、最後に取り消す形で確かめた（表は0行のまま）。
- **途中で見つけて直したこと**: スマホの幅でツールの列がはみ出して一部が見えなかった（「ツール」ボタンの一覧にした）。一覧が閉じるとチャートの位置が跳ねた（一覧をチャートの上に重ねた）。日本語の入った箱の幅が足りなかった。指の小さな揺れでドラッグ扱いになり、1回で線ができてしまうおそれ（指は10、マウスは5動いたらドラッグ）。2点目のクリックがダブルクリック（全体表示に戻す）にもなっていた。文字ツールで、タップの後のマウスの合図で入力欄から外れ、最初の1文字が消えていた。
- **確かめていないこと**: 実機（iPhone・Android）では試していない（ブラウザのスマホの大きさとタッチで試した）。アカウントとの同期は、実際のログインでは試していない（表と権限はデータベースで、同期の動きはテストの模擬で確かめた）。虫メガネ（拡大表示）は入れていない。Lovable に公開した後の画面は見ていない。

### 8.73 合図の良し悪しを「その後 Stoch が20／80に届いたか」で測り、見分ける条件を探した（#161）

- **指示**（2026-09-29）: ドル/円4時間足の画面（上昇中に出た ULTRA の Sell ☆ を赤丸で囲ったもの）を添えて「赤丸で囲ったsellとかさ、結局その後にstochの20を下回ってないからダメよ」。どう使うかを聞いたところ、オーナーの選択は「見分ける条件を探す」（この基準で測り直し、合図の時点で見分けられる条件があるか調べ、はっきり良くなるときだけ入れる。なければ今のまま）。
- **測り方**（`research/stochgood.ts`、GitHub Actions の `stochgood.yml`。データを見る前に決めた）:
  - 良い合図: 売りは、合図の足の後、4時間足の終値で Stoch の %K（14, 1, 3）が20を下回ったとき。ただし、メールの損切り（中値の終値から10 pips）に先に届いたら悪い合図。買いは逆（%K が80を上回る）。損切りは5分足の売値・買値で追い、%K が届く足の途中で損切りに届いたら損切りが先とした。30本（5日）以内にどちらもなければ数えない。
  - 合図: メールと同じもの（§8.71 と同じ。GMO の14ペア、4時間足、2024-01-01〜、メールで送られるもの）。物差しは、すべての足の終値で両方の向きに入った場合。
  - **偶然との差**: 買いの合図の時点で %K がすでに80に近ければ、少し上がるだけで「80を上回った」になる。作り物のでたらめな値動きで試すと、「%K が80以上の買い」は 45%、メールは 30% と、値動きの予想と関係なく差が出た。そこで、合図ごとに「同じ向き・同じ %K の位置（10刻み。売りは100から数える）・直近14本の値幅（pips の帯）から、すべての足ででたらめに入った場合」の届く割合を出し、それを上回った分（偶然との差）で比べることにした（実データを見る前に変えた）。
  - 条件: 合図の足での Stoch・BLSH・MACD（§8.71 と同じ）、Q-Trend の向き（順・逆・問わない）、ダウ理論の向き（上昇または上昇の兆し・下降または下降の兆し・問わない）。4つの合図 × 2,205 通り。
  - 選び方: 前半（2025-05-19 より前）で、合図が150回以上ある条件のうち、偶然との差の区間の下の端が一番高いものを選ぶ。後半で、その下の端が今のメールの偶然との差より上なら入れる。そうでなければ今のまま。
  - 確かめたこと: メールの関数との照合の違い0（4,603本）。Stoch・BLSH・MACD を窓だけで計算し直した値との違い0。ダウ理論をその足までで読み直した値との違い0（先の足を使っていない）。%K を全体で計算した値と窓の値との違い0。作り物のでたらめな値動き2組では、2回とも「今のまま」。後半の、メールとの差の全パターン平均は −0.12・−0.06 ポイント。
- **結果**（損切りより先に Stoch が20（買いは80）に届いた割合。カッコは偶然との差）:

  | | 前半 | 後半 |
  |---|---|---|
  | 今のメール（両方の合図） | 29.8%（−1.7） | 34.9%（+0.5） |
  | Q-Trend | 32.7%（−3.3） | 38.9%（−0.7） |
  | ULTRA | 21.4%（+1.7） | 24.6%（+3.4） |
  | 物差し（すべての足の終値） | 30.0% | 33.9% |

  - 合図は、すべての足で入った場合と比べて届きやすくはない。ULTRA は、同じ位置から入った場合より少し届きやすい（後半 +3.4、区間 +0.9〜+5.8）が、そもそも Stoch が高い所で出るため、届く割合は4回に1回ほど。
  - 赤丸の種類（ULTRA の売り、合図の時にダウ理論が上昇・上昇の兆し）: 856回で 23.7%。ダウ理論が下降・下降の兆しのときの売りは131回で 27.5%。差ははっきりしない（回数も少ない）。Q-Trend の売りは、ダウ理論が下降のとき 33.5%、上昇のとき 31.9%。
  - 前半で選ばれた条件: ULTRA の合図で、買いは %K が20以下・BLSH が上がった・MACD のヒストグラムが上がった・Q-Trend と逆向き（売りは逆）。前半の偶然との差 +6.5（下の端 +1.3）、後半 +2.2（−3.0〜+7.3、202回、メールの合図の7%）で、下の端がメールの +0.5 に届かなかったので「今のまま」。
  - 前半で選ばれなかった条件の中には、後半で下の端がメールを上回ったものが 1,611 中 170（10.6%）あった（作り物のデータでは 1.9%・0%）。例えば、両方の合図で「買いは BLSH が赤・MACD のヒストグラムが0より下」（勢いと逆向きに入る形）は後半 25.0%（+2.4、+0.1〜+4.6）。ただし、後半を見てから選ぶと偶然を拾うので、決めておいた選び方では使えない。
  - 測れていないこと: 4時間足は14ペアだけ（§8.69 と同じ）。Twelve Data の16銘柄は測っていない。偶然との差は、%K の位置と値幅でそろえているが、作り物のデータでも ULTRA のダウ理論順向き（30〜40回）では −10 ポイントほどのずれが出た。数の少ない分け方では、この物差しにも残るずれがある。
- **決まったこと**: 決めておいた選び方で「今のまま」。メールとチャートは変えていない。`research/stochgood.ts` と `stochgood.yml` は測定をやり直せるように残した（本番のコードからは読んでいない）。

### 8.74 「Stoch が20（買いは80）に届いたら利確」を今の決済と比べた（#162）

- **指示**（2026-09-29）: §8.73 の後、「Stoch が20を下回ったら利確」という決済の使い方を示したところ、オーナーが「測ってみて」。
- **測り方**（`research/stochexit.ts`、GitHub Actions の `stochexit.yml`。データを見る前に決めた）:
  - 合図: メールと同じ（§8.73 と同じ。GMO の14ペア、4時間足、2024-01-01〜、メールで送られるもの。Q-Trend と ULTRA が同じ足・同じ向きなら1回）。物差しは、すべての足の終値で両方の向きに入った場合。
  - どちらも合図の足の終値で入る（買いは買値、売りは売値。スプレッドを払う）。損切りはメールと同じ、中値の終値から10 pips。5分足の売値・買値で追い、5分足の始値がすでに水準の先なら、その始値で決済。
  - 今の決済: TP1（5 pips）か損切り。同じ5分足で両方に届いたら損切り。
  - Stoch 決済: 損切りか、4時間足の終値で %K（14, 1, 3）が20を下回った（買いは80を上回った）足の終値で決済。その足の途中で損切りに届いたら損切りが先。
  - どちらも、30本（5日）で決着しなければ、その足の終値で決済。
  - 出したもの: 1回あたりの pips（週ごとのまとまりを考えた95%区間）、勝った割合、平均の勝ち・負け、決済の内訳。同じ合図どうしの「Stoch 決済 − 今の決済」と、物差しの同じ差を引いた「物差しと比べた差」。
  - 「はっきり良い」の基準（データを見る前にオーナーに伝えた）: メールの合図全体で、前半・後半とも Stoch 決済の1回あたりが今より良く、後半の差の区間の下の端が0より上。入れるかどうかはオーナーが決める。
  - 作り物のでたらめな値動きでの確かめ: 今の決済はスプレッド分の負け（−0.3〜−0.5 pips）。一方、Stoch 決済は作り物の作り方で結果が変わった。5分足にひげがあると −0.6〜−1.0、ひげがないと +0.2〜+0.9 になった。5分ごとの一歩が水準を飛び越えても、その水準で決済したとして数えるため。物差しと比べた差は、3組とも −0.5〜+0.8 と0に近かった。作り物のデータでは、2つの決済の差を ±1 pips くらいより細かくは確かめられない。「はっきり良い」の判定は、ひげありの2組とも「はっきり良いとは言えない」だった。
  - 確かめたこと: メールの関数との照合の違い0（4,603本）。%K を全体で計算した値と窓の値との違い0（59,822本）。GMO の読み込みの失敗0。今の決済の1回あたり（−1.28・−1.06 pips）は、§8.71 の今のメール（−1.28・−1.08 pips）とほぼ同じ。
- **結果**（1回あたりの pips、スプレッド込み。カッコは勝った割合）:

  | | 今の決済（TP1 5pips） | Stoch 決済 | 差（Stoch − 今） |
  |---|---|---|---|
  | 今のメール 前半 | −1.28（60.0%） | −2.44（23.7%） | −1.16（−2.22〜−0.11） |
  | 今のメール 後半 | −1.06（61.2%） | −1.66（26.7%） | −0.60（−1.51〜+0.30） |
  | Q-Trend 前半・後半 | −1.43・−1.12 | −2.83・−1.79 | −1.40・−0.67 |
  | ULTRA 前半・後半 | −0.88・−0.78 | −1.88・−1.56 | −1.00・−0.77 |
  | 物差し 前半・後半 | −1.66・−1.47 | −1.62・−1.59 | +0.04・−0.12 |

  - Stoch 決済は、勝つのは4回に1回ほど（23〜27%）。勝つときは大きく、平均 +20〜+22 pips（ULTRA は +31〜+34 pips）。ただし損切り（平均 −10 pips）が多く、1回あたりでは今の決済より 0.6〜1.2 pips 悪い。前半は差の区間がすべて0より下で、はっきり悪い。
  - 物差しと比べた差: 前半 −1.20（−2.34〜−0.05）、後半 −0.48（−1.47〜+0.50）。すべての足で入った場合は、2つの決済でほとんど同じ（Stoch 決済との差は +0.04・−0.12）。合図で入るときに、Stoch 決済の方が損をしている。
  - 売り・買い別、ULTRA の売りだけ、STRONG だけでも、Stoch 決済が両方の半分で今より良いものはなかった（後半だけ STRONG の売りが +0.22、区間 −3.28〜+3.72）。
  - どちらの決済でも、1回あたりは負け越し。
  - 測れていないこと: 4時間足は14ペアだけ。Twelve Data の16銘柄は測っていない。損切りは水準ちょうどで決済としており、実際のすべり（水準より不利な約定）は数えていない。Stoch 決済は損切りが多い（約7割）ので、すべりの分だけ、実際には Stoch 決済がもう少し悪くなる向き。
- **判定**: 基準では「はっきり良いとは言えない」（両方の半分で今より悪い）。メールとチャートは変えていない。`research/stochexit.ts` と `stochexit.yml` は測定をやり直せるように残した（本番のコードからは読んでいない）。

### 8.75 損切りを置かない Stoch 決済を測った（#163）

- **指示**（2026-09-29）: §8.74（損切りありの Stoch 決済は今の決済より悪い）の後、オーナーが「損切りを考えなかった場合を測って」。
- **測り方**（`research/stochfree.ts`、GitHub Actions の `stochfree.yml`。データを見る前に決めた）:
  - 合図・物差し・入り方・5分足での追い方は §8.74 と同じ。今の決済と、損切りありの Stoch 決済も §8.74 のまま。
  - 損切りなし（今回の本題）: 損切りも TP も置かない。4時間足の終値で %K（14, 1, 3）が20を下回った（買いは80を上回った）足の終値で決済。30本（5日）で届かなければ、その足の終値で決済（§8.74 と同じ上限）。
  - 補足: 上限を120本（4週間）にした場合も並べた。30本の上限そのものが一種の損切りとして働くため。
  - 取引は、上限までの足（30本、120本の方は120本）がすべてデータにあるものだけを数えた。§8.74 では、データの終わり近くの取引は、終わる前に決済したものだけが数えられていた（数日分。今回はどの決済でも同じく外した）。
  - 出したもの: 1回あたりの pips（95%区間）、勝った割合、平均の勝ち・負け、最悪の1回、悪い方から5%の境目、決済の内訳。損切りなしの方は、途中でどこまで逆に行ったか（買いは売値の安値、売りは買値の高値、5分足）、今の損切り（10 pips）の位置を越えた取引の数と、その取引が最後にどうなったか。
  - 「はっきり良い」の基準（§8.74 と同じ）: メールの合図全体で、前半・後半とも今の決済より1回あたりが良く、後半の差の区間の下の端が0より上。120本の方も同じ基準で判定。入れるかどうかはオーナーが決める。
  - 作り物のでたらめな値動きでの確かめ（21ペア、乱数の種を変えて10通り）: 損切りなしは終値でだけ決済するので、スプレッド分（−0.40 pips）になるはず。20個の半分の平均は −0.43（物差し）・−0.41（メールの合図）で、偏りはなかった。ただし1組（種7の前半）は −1.66・−3.07 と外れた。95%区間が −0.40 を含んだのは、グループごとに20回中18〜20回（120本の方は17〜19回）。120本の方は週ごとの区間が少し狭かった。取引が週をまたぐためで、4週間ごとにまとめた区間も出し、判定には2つの下の端の低い方を使うことにした（実データを読む前に決めた）。判定は10通りとも「はっきり良いとは言えない」。
  - 確かめたこと: メールの関数との照合の違い0（4,603本）。%K の違い0（59,836本）。損切りなしの決済の終値と、%K を見た4時間足の終値の違い0（3,084,775回）。GMO の読み込みの失敗0。
- **結果**（1回あたりの pips、スプレッド込み。カッコは95%区間）:

  | | 今の決済（TP1 5pips） | Stoch 決済（損切りあり） | 損切りなし（30本） | 損切りなし（120本） |
  |---|---|---|---|---|
  | 今のメール 前半 | −1.28 | −2.44 | −1.98（−9.11〜+5.15） | −0.40（−7.67〜+6.86） |
  | 今のメール 後半 | −1.06 | −1.61 | +3.72（+0.07〜+7.38） | +5.55（+2.07〜+9.04） |
  | Q-Trend 前半・後半 | −1.43・−1.12 | −2.83・−1.73 | −0.65・+2.38 | −0.01・+3.37 |
  | ULTRA 前半・後半 | −0.88・−0.81 | −1.88・−1.54 | −2.54・+7.42 | +1.72・+12.14 |
  | 物差し 前半・後半 | −1.66・−1.46 | −1.62・−1.56 | +0.84・−0.04 | +1.88・+1.71 |

  - 損切りなし（120本）− 今の決済（今のメール）: 前半 +0.88（−6.39〜+8.15）、後半 +6.63（+3.08〜+10.18、4週間ごとでは +3.33〜+9.92）。
  - 物差しと比べた差（120本）: 前半 −2.66（−11.31〜+5.98）、後半 +3.46（−1.30〜+8.23）。すべての足で入った場合も、損切りなしにすると今より良くなった（+3.54・+3.17）。後半の物差しの差は、買いが +7.77、売りが −1.44。後半は、どの足で買っても %K 80 まで待てば1回 +6.39 pips（+2.19〜+10.58）だった。後半の良さの半分ほどは、合図ではなく、その時期の相場によるもので、合図だけの強みは区間が0をまたいで言えない。
  - 勝った割合は64〜66%。ただし平均の負けが大きい（前半 −66〜−68、後半 −40〜−44 pips。今の決済は約 −10）。
  - 損切りを置かない危なさ（今のメール）:
    - 最悪の1回は、30本で −1,025.8 pips、120本で −1,121.9 pips（どちらも前半の買い）。クロス円なら1万通貨で約10〜11万円の損。
    - 前半は、悪い方から5%の取引が −155 pips（120本は −146）より悪かった。
    - 途中で逆に行った最大は 1,723 pips（120本は 1,766）。
    - 途中で今の損切りの位置を越えたのは 64〜70%。越えた取引も最後は58〜59%が勝ったが、平均では前半 −10.0・−7.7、後半 −2.3・+0.5 pips だった（30本・120本の順）。
  - 損切りなし（30本）を損切りありの Stoch 決済と比べると、後半は +5.34（+1.98〜+8.70）、前半は +0.46（−6.55〜+7.47）。
  - 買い・売り別（120本、今のメール）: 買いは前半 −1.97、後半 +8.07。売りは前半 +1.15、後半 +3.32。
  - 測れていないこと:
    - 4時間足は14ペアだけで、Twelve Data の16銘柄は測っていない。
    - スワップ（金利）は数えていない。損切りなしは平均で約10〜13本（約2日）持つ。今の決済は約3〜4本。
    - 今の決済の損切りは水準ちょうどで決済としており、すべりは数えていない（実際には今の決済がもう少し悪くなる向き）。
    - 最悪の1回がどのペアのいつかは出していない。
- **判定**: 決めた基準では、損切りなし（30本）は「はっきり良いとは言えない」（前半は今より悪い）。損切りなし（120本）は「はっきり良い」（両方の半分で今より良く、後半の差の下の端 +3.08）。ただし、後半の良さの半分ほどは物差しにも出ており、合図だけの強みは言えない。また、1回で1,000 pips を超える負けがあった。メールとチャートは変えていない。入れるかどうかはオーナーが決める。`research/stochfree.ts` と `stochfree.yml` は測定をやり直せるように残した（本番のコードからは読んでいない）。

### 8.76 損切りせずに利確（TP1）まで待った場合を測った（#164）

- **指示**（2026-09-29）: §8.75 の後、オーナーが「僕が思ったのはもし、損切りのラインにいってしまっても利確より先に、そのままポジションを待っていれば利確にいくのではないかという事です」。
- **測り方**（`research/tphold.ts`、GitHub Actions の `tphold.yml`。データを見る前に決めた）:
  - 合図・物差し・入り方・5分足での追い方は §8.74・§8.75 と同じ。今の決済も §8.74 のまま（TP1 5 pips か損切り 10 pips。同じ5分足で両方に届いたら損切り）。
  - 待つ決済（今回の本題）: TP1 だけを置き、損切りは置かない。TP1 に届いたら決済（5分足の始値がすでに TP1 の先ならその始値）。30本（5日）で届かなければ、その足の終値で決済。
  - 補足: 上限を120本（4週間）にした場合も並べた。
  - 取引は、上限までの足がすべてデータにあるものだけを数えた（§8.75 と同じ）。
  - オーナーの問いへの答えとして出したもの: 今の決済で損切りになった取引のうち、待てば TP1 に届いたのは何%か（5日以内・4週間以内）、何本目で届いたか、届かなかった取引は最後にいくらだったか（平均と最悪）、損切りになった取引を待った場合の平均と、損切りした場合の平均。
  - すべての取引について: 1回あたりの pips（週ごと・4週間ごとの95%区間）、勝った割合、平均の勝ち・負け、最悪の1回、途中でどこまで逆に行ったか。待つ決済 − 今の決済と、物差しと比べた差。
  - 「はっきり良い」の基準（§8.74・§8.75 と同じ）: メールの合図全体で、前半・後半とも今の決済より1回あたりが良く、後半の差の区間の下の端（2つの区間の低い方）が0より上。入れるかどうかはオーナーが決める。
  - 作り物のでたらめな値動きでの確かめ（21ペア、乱数の種を変えて10通り）:
    - 照合はすべて0件のずれ。今の決済が TP1 か時間切れで終わった取引は、待つ決済でもまったく同じ結果になった。今の決済で損切りになった取引は、待つ決済でも全件、損切りの位置を越えていた。
    - 損切りになった取引の 82.6〜86.7% が5日以内に、90.3〜93.5% が4週間以内に TP1 に届いた。それでも待った場合の平均は −12.47〜−7.94 pips（4週間では −16.20〜−7.17）で、損切りした場合（−10.20）と大差なかった。
    - 待つ決済 − 今の決済は平均 +0.24 pips。作り物の5分足のひげが TP1 に触れて、そこで約定するため。判定は20回中2回「はっきり良い」と出た。この程度の小さな差でも判定が出ることがある。
  - 確かめたこと（実データ）:
    - メールの関数との照合の違い0（4,603本）。
    - 今の決済が TP1 か時間切れで終わった取引と、待つ決済との違い0（75,381件）。
    - 損切りになった取引が待つ決済で損切りの位置を越えていなかったもの0（45,566件）。
    - 時間切れの終値と4時間足の終値の違い0（23,400回）。
    - GMO の読み込みの失敗0。
- **結果 1: 損切りになった取引を、そのまま待っていたら**（今のメール）:

  | | 前半 | 後半 |
  |---|---|---|
  | 今の決済で損切りになった取引 | 1,139（全体の38.0%） | 1,003（34.6%） |
  | 5日以内に TP1 に届いた | 78.7%（平均3.8本目） | 80.3%（4.2本目） |
  | 届かなかった取引の5日後 | 平均 −54.3、最悪 −422.0 pips | 平均 −70.2、最悪 −587.1 pips |
  | 損切りになった取引を5日待った平均 | −8.03 pips | −10.06 pips |
  | 4週間以内に TP1 に届いた | 89.3%（平均10.2本目） | 89.7%（9.5本目） |
  | 届かなかった取引の4週間後 | 平均 −98.4、最悪 −1,067.7 pips | 平均 −111.8、最悪 −555.8 pips |
  | 損切りになった取引を4週間待った平均 | −6.48 pips | −7.32 pips |
  | 損切りした場合の平均 | −10.52 pips | −10.69 pips |

  - オーナーの考えのとおり、損切りになった取引の約8割は5日以内に、約9割は4週間以内に TP1 まで戻った。
  - ただし、戻らなかった1〜2割は大きく負けた。戻った取引の利益は1回 +5 pips ほどなので、損切りになった取引全体の平均は、損切りした場合より 0.6〜4 pips 良いだけだった。
- **結果 2: すべての取引の1回あたり**（pips、スプレッド込み。カッコは95%区間）:

  | | 今の決済 | 待つ（5日） | 待つ（4週間） |
  |---|---|---|---|
  | 今のメール 前半 | −1.28（勝ち60.0%） | −0.33（89.6%） | +0.25（94.3%） |
  | 今のメール 後半 | −1.06（61.1%） | −0.84（89.0%） | +0.06（93.3%） |
  | 差（待つ − 今）前半 | | +0.95（−0.06〜+1.95） | +1.53（−0.20〜+3.26） |
  | 差（待つ − 今）後半 | | +0.22（−1.07〜+1.51） | +1.13（−0.13〜+2.40） |
  | 物差しの差 前半・後半 | | +0.38・+0.30 | +0.62・+1.25 |

  - どちらの半分でも、待つ方が今より少し良い。ただし差の区間はすべて0をまたぐ。
  - 物差し（すべての足で入った場合）でも同じくらい良くなるので、合図の強みではなく、決済のしかたの差。物差しと比べた差は、5日で +0.57・−0.08、4週間で +0.91・−0.12。
  - 勝った割合は9割前後に上がる。一方、負けたときの平均は、5日で −43〜−45 pips、4週間で −63〜−73 pips（今の決済は約 −10）。最悪の1回は、5日で −422.0・−587.1 pips、4週間で −1,067.7・−555.8 pips。
    - −1,067.7 pips は、クロス円なら1万通貨で約10.7万円。利確1回（約 +4.6 pips）の約230回分にあたる。
  - グループ別（4週間、後半の差）: ULTRA は +2.87（+1.06〜+4.67）、STRONG は +0.42（−2.12〜+2.96）、Q-Trend は +0.43（−1.08〜+1.94）。ULTRA の物差しと比べた差は +1.62（−0.34〜+3.57）。
  - 測れていないこと:
    - 4時間足は14ペアだけで、Twelve Data の16銘柄は測っていない。
    - スワップ（金利）は数えていない。待つ決済は平均で約6本（5日。5.6・6.4本）、約11〜14本（4週間。11.4・14.4本）持つ。今の決済は約3〜4本。
    - 今の決済の損切りは水準ちょうどで決済としており、すべりは数えていない（実際には今の決済がもう少し悪くなる向き）。
    - 戻った取引が、戻る前にどこまで逆に行ったかは、戻らなかった取引と分けて出していない（損切りになった取引全体では、途中で平均42〜46 pips 逆に行った）。
- **判定**: 決めた基準では、待つ（5日）も待つ（4週間）も「はっきり良いとは言えない」。どちらも両方の半分で今より良かったが、後半の差の下の端が −1.07・−0.37 だった。メールとチャートは変えていない。入れるかどうかはオーナーが決める。`research/tphold.ts` と `tphold.yml` は測定をやり直せるように残した（本番のコードからは読んでいない）。

### 8.77 損切りの幅を広げた場合を測った（#165）

- **指示**（2026-09-29）: §8.76 の後、間を取る案として「損切りを広く置く」ことを示したところ、オーナーが「測ってみて、それで決める」。
- **測り方**（`research/widestop.ts`、GitHub Actions の `widestop.yml`。データを見る前に決めた）:
  - 合図・物差し・入り方・5分足での追い方は §8.74〜§8.76 と同じ。
  - 決済: TP1（中値の終値から5 pips）と、損切り S pips。S は 10（今のメール）・15・20・30・50・100・なし。同じ5分足で両方に届いたら損切り。5分足の始値がすでに先ならその始値。待つ上限 L は30本（5日）か120本（4週間）。上限までに決着しなければ、その足の終値で決済。今の決済は S 10・L 30本。
  - どの決済も同じ取引で比べた（120本がすべてデータにある取引だけ）。
  - 決め方（データを見る前に決めた）:
    1. 候補は S 15・20・30・50・100 × L 5日・4週間の10通り。
    2. 前半で、メールの合図の1回あたりの pips が一番良いものを1つ選ぶ（後半は見ない）。
    3. 選んだものを後半で今の決済と比べる。後半の1回あたりが今より良く、差の区間の下の端（週ごと・4週間ごとの低い方）が0より上なら「はっきり良い」。入れるかどうかはオーナーが決める。
  - 作り物のでたらめな値動きでの確かめ（2種類 × 乱数の種10通り）:
    - 照合はすべて0件のずれ。
    - ひげを後から付ける作り物（§8.74 から使っているもの）では、10回中6回「はっきり良い」と出た。この作り物では、ひげで TP1 に約定したあと値が戻るので、広い損切りほど本当に得になる（物差しの平均で、S10 −0.30 → S50 −0.10 pips）。
    - 5分足を100個の小さな値動きから作る作り物（今回加えた。高値・安値は値動きそのものの端で、どの決済にも得はない）では、10回とも「はっきり良いとは言えない」。どの決済も −0.43〜−0.52 pips で、スプレッド分の近く。
    - 決め方は、広い損切りが本当に得なときには反応し、どれも同じときには反応しなかった。
  - 確かめたこと（実データ）:
    - メールの関数との照合の違い0（4,603本）。
    - 新しい書き方の S10・L30 と §8.76 の今の決済、S なしと §8.76 の待つ決済の違い0（355,092件）。
    - ある幅で TP1 か時間切れで終わった取引が、1つ広い幅でもまったく同じ結果になったか: 違い0（1,145,879件）。
    - 時間切れの終値と4時間足の終値の違い0（100,804回）。
    - GMO の読み込みの失敗0。
- **結果**（今のメール、1回あたりの pips、スプレッド込み。前半・後半）:

  | 損切り | 5日: 1回あたり | 勝った割合 | 平均の負け | 最悪の1回 | 4週間: 1回あたり |
  |---|---|---|---|---|---|
  | 10（今） | −1.28・−1.07 | 60%・61% | −10・−10 | −32・−53 | −1.32・−1.11 |
  | 15 | −1.05・−0.97 | 70%・70% | −14・−14 | −32・−53 | −1.09・−1.04 |
  | 20 | −0.95・−1.05 | 75%・74% | −18・−17 | −29・−53 | −1.00・−1.12 |
  | 30 | −0.61・−0.99 | 81%・79% | −23・−22 | −41・−88 | −0.62・−1.08 |
  | 50 | −0.74・−0.43 | 85%・85% | −31・−29 | −66・−88 | −0.83・−0.51 |
  | 100 | −0.40・−0.57 | 89%・88% | −40・−39 | −109・−129 | −0.50・−0.54 |
  | なし（参考） | −0.33・−0.80 | 90%・89% | −43・−45 | −422・−587 | +0.25・+0.06 |

  - 選ばれたもの: 前半で一番良かった S100・5日（−0.40）。後半は −0.57 で、今の決済は −1.07。差は +0.51（区間 −0.40〜+1.41、4週間ごとでは −0.44〜+1.45）。
  - 5日の方は、どの幅も前半・後半とも今より少し良い（差 +0.03〜+0.88 pips）。ただし差の区間が両方の半分で0より上のものはない。後半の差: S15 +0.11、S20 +0.03、S30 +0.08、S50 +0.64（区間 −0.00〜+1.29）、S100 +0.51。
  - 物差し（すべての足で入った場合）も、広げると同じくらい良くなる（5日: S30 +0.22・+0.23、S50 +0.13・+0.32、S100 +0.15・+0.28）。合図の強みではなく、決済のしかたの差。
  - どの幅でも、メールの1回あたりはマイナスのまま（損切りなし・4週間の +0.25・+0.06 だけが0近く）。
  - 広げるほど勝つ割合は上がるが、負けたときの平均と最悪の1回が大きくなる。損切りを置いても、週明けなどに損切りの先から始まる足では、その始値で決済になるので、損切りの幅より大きく負けることがある（S30 の最悪 −88 pips、物差しでは −259.5 pips）。
  - 測れていないこと:
    - 4時間足は14ペアだけで、Twelve Data の16銘柄は測っていない。
    - スワップ（金利）は数えていない。
    - 損切りは水準ちょうどで決済としており、すべりは数えていない（損切りが多い今の決済の方が、実際にはもう少し悪くなる向き）。
    - 後半を見てから S50 を選ぶのは、決めた手順ではない（後知恵になる）。
- **判定**: 決めた基準では「はっきり良いとは言えない」（選ばれた S100・5日は、後半の差の下の端が −0.44）。メールとチャートは変えていない。入れるかどうかはオーナーが決める。`research/widestop.ts` と `widestop.yml` は測定をやり直せるように残した（本番のコードからは読んでいない）。

### 8.78 FX の損切りを30 pips にした（#166）

- **指示**（2026-09-29）: §8.77 の結果と選択肢（1. 今のまま 10 pips・2. 30 pips・3. 50 pips・4. その他）を示したところ、オーナーが「2で」。
- **変えたこと**:
  - `_shared/ultra.ts`: FX のペアの設定 `ULTRA_PAIRS`（損切り30、利確 TP1〜TP3 は 5・10・15 のまま）と、ペアごとに設定を選ぶ `ultraParamsFor(gold)` を追加した。`ULTRA_DEFAULTS` は動画の設定（損切り10）のままで、金はこれを使う（金はドルで損切り10ドル。金は測っていないため、動画のままにした）。
  - `_shared/qtrend.ts` の `qTrendTrades` に設定を渡せるようにした（Q-Trend の損切り・利確も ULTRA と同じ数字）。
  - チャート（`PriceChart.tsx`）とメール（`signal-alerts/indicators.ts`）で、FX のペアは損切り30で損切り・利確の線・価格を出す。ULTRA の表（TP1・TP2・TP3・損切りの回数）も損切り30で数える。
  - シグナルの出方（ULTRA は RSI が30・70をまたいだ足、Q-Trend は線を抜けた足）は損切りに左右されないので、メールが届くタイミングは変わらない。
  - メールの記録の ID（`ULTRA_RULE_ID`、`ultra_rsi14_30_70_sl10_tp5_10_15_v1`）は変えていない。メールの重複を防ぐ一意のキーに含まれていて、変えると公開の直後に同じシグナルのメールが2通届くことがあるため。実際の損切りの価格は、今までどおり送信の記録（`signal_alerts.stop`）に残る。
  - メールの文面: FX の ULTRA のメールは「ULTRA の目安（利確は動画の設定、損切りは30pips）」と、「FX では、このアプリで測った結果から損切りを30pipsにしています」を足した。損益ゼロに要る割合は設定から計算する（30÷(30＋5) で86%）。金のメールは、測った数字を書かず「金はこの目安では測っていません」とした（FX の数字は損切りが違うため）。
  - チャートの説明（日本語・英語）: インジケーター名「ULTRA（RSI 14・SL 30・TP 5/10/15 pips）」（金は SL $10 のまま）、損切りの記述、測った数字（下）、メール通知の設定の説明。
  - 研究プログラムは `ULTRA_DEFAULTS`（損切り10）を読むので、これまでに記録した結果はそのまま再現できる。`research/tf-winrate.ts` だけは損切りを `SL` で渡せるようにした（既定は10。`tf-winrate.yml` は入力 `sl`、push で走るときは30）。
- **測り直し**（メールと説明文に書く数字。`research/tf-winrate.ts` を損切り30で、GitHub Actions run 36587276263。§8.69 と同じ測り方: GMO の21ペア、2024-01-01〜、メールで送られるシグナルを、その足の終値で入った場合。5日で決着しなければその時点で決済）:

  | 時間足 | Q-Trend: TP1 が先・1回あたり | ULTRA: TP1 が先・1回あたり | （§8.69、損切り10のとき） |
  |---|---|---|---|
  | 5分足 | 84.1%・−1.90 pips | 84.9%・−1.49 pips | Q 58.9%・−2.10、U 61.0%・−1.64 |
  | 15分足 | 84.1%・−1.80 | 84.6%・−1.47 | Q 59.5%・−1.92、U 61.1%・−1.51 |
  | 1時間足 | 85.3%・−1.31 | 85.5%・−1.39 | Q 61.9%・−1.46、U 61.6%・−1.67 |
  | 4時間足 | 86.0%・−0.87 | 86.6%・−0.46 | Q 61.4%・−1.35、U 64.2%・−0.82 |
  | 日足 | 75.8%・−8.07 | 77.0%・−8.10 | Q 35.9%・−9.11、U 33.5%・−10.00 |

  - 損益ゼロには86%より上が要る（スプレッドを払うと、さらに上）。どの時間足も1回あたりは負けのまま。損切り10のときより、どれも少し負けが小さい。
  - 価格の低い円のペアでは、30 pips が値段に比べて大きい。メキシコペソ/円・南アランド/円・トルコリラ/円・スウェーデンクローナ/円は、5日で決着しない取引が多く、TP1 が先の割合が89〜98%と高く出た。ハンガリーフォリント/円は、5日以内に決着した取引がなかった。上の数字はこれらを含めた全ペアの値。
  - 確かめたこと: メールの関数との照合の違い0（5分足 51,741・15分足 19,621・1時間足 8,320・4時間足 5,492・日足 3,468 本）。GMO の読み込みの失敗0。作り物の値動き（2ペア）で、損切り30なら TP1 が先の割合が約85%（損益ゼロの境目の86%近く）になることを確かめた。
- **確かめたこと**:
  - テスト: 全テスト 2,296件。直したのは、ULTRA のチャート（FX の損切りの価格・画面の外の札・インジケーター名・表の回数）、Q-Trend の損切り・利確（FX の設定では損切り30）、メールの文面（FX の損切り30・金は10ドルで「測っていません」・測った数字）、インジケーター名の一覧、シグナルの損切り（USD/JPY で30 pips）。
  - チャートの表の回数の期待値は、テストと同じ作り物の値動きで別に数え直して決めた。損切り10で数えると、元の期待値（TP1 5・損切り16 など）がそのまま再現できることを先に確かめた。
  - メールの数字を1つ変えると、テストが落ちることを確かめた。
  - 型チェック（既存の12件のみ）、lint、Deno の型チェック（signal-alerts）。
- **反映**: main へのマージで、GitHub Actions（`deploy-functions.yml`）が関数を反映する（signal-alerts v10）。そのあと Lovable に公開する。

### 8.79 金の利確・損切りを測った（#167）

- **指示**（2026-09-29）:
  - §8.78 で FX の損切りを30 pips にした。金は動画の設定のまま（損切り10ドル、TP1〜TP3 は5・10・15ドル）で、測っていなかった。そこでオーナーが「金も測って」。
  - 途中で、オーナーが金の4時間足のチャートを見て「tp低すぎない？」（TP1〜TP3 が1本の足の幅の中に収まっていた）。
  - アプリの金の足の幅（中央値: 5分足 $3.4・15分足 $6.6・1時間足 $14.3・4時間足 $30.3）を示し、利確の幅も測る案を出した。オーナーは「1で」。
- **データ**:
  - アプリは金の足を Twelve Data から読むが、そのキーは GitHub にない。そこで Dukascopy の公開データ（売値・買値の1分足 2023-12-18〜2026-09-28、1時間足 2021-01〜）を GitHub Actions で取った（`research/dukascopy.py`、`gold.yml`）。開発用の環境からは Dukascopy に届かない。
  - 欠けている日は聖金曜日の3日だけ（金の市場が休みの日）。1時間ファイルと1分足は、15,978 時間のうち3時間を除いて一致した。1時間足は、1分足がある期間は1分足から作った（進行中の月の1時間ファイルはまだ出ないため）。
  - 足の区切りは、アプリが保存している Twelve Data の足を Dukascopy の毎時の中値と照らして決めた（測定の結果を見る前）。
    - 日足（2025-11-11 以降の今の形）は、シドニー時間の朝7時で区切られる（UTC 21時、豪州の夏時間中は20時）。平日どの曜日も同じ（終値の差の中央値 $0.39〜0.91。1時間ずらすと $2.9〜9.7）。
    - Twelve Data は、日曜17時（UTC）から金曜21時まで毎時の足を出している。市場が閉まっている時間（日曜の開く前・金曜の引け後・毎日の休止）は、ほぼ動かない足になっている。アプリが捨てるのは、週末に丸ごと入る足だけ（`barFullyClosed`）。そのため日足には、毎週小さな日曜の足がある。測定では、この時間に直前の値の平らな足を入れた。
    - 4時間足は 01時・05時…（UTC）で区切られる。豪州の夏時間中（10月〜4月）の区切りは、保存された足が5月からしかないので分からない。そこで日足に合わせて 00時・04時… とした。ほかに、ニューヨーク時間に合わせる形、01時のままの形、平らな足を入れない形でも測った。
  - こうして作った足を、アプリが保存している Twelve Data の足と照らした。
    - 日足: 276本すべてが同じ日付でそろった（終値の差の中央値 $0.71）。
    - 4時間足: Twelve の 602本すべてに、同じ時刻の足があった（$0.79）。
    - 1時間足: 557本がそろった（$0.87）。
    - Twelve にだけあったのは、クリスマスの日足1本と、米国の祝日の午後の1時間足3本。
  - 実際に送られた金のメールのうち、データの期間に入るのは1通だけ（1時間足・ULTRA の BUY、09-28 22:00、RSI 30.12）。測定では、この合図は18時と23時の足に出ていて、22時には出ていない。フィードの違いで、個々の合図は前後にずれることがある。
- **測り方**（`research/gold.ts`、GitHub Actions の `gold-study.yml`。データを見る前に決めた）:
  - 合図: メールと同じ Q-Trend・ULTRA（`indicatorSignals`、600本）。メールで送られるものだけ（市場が閉まっている時間は送らない）。
  - 入り方: 合図の足の終値で入る（BUY は買値、SELL は売値）。利確・損切りの水準は、足の中値の終値から測る。
  - 追い方: 5分足の売値・買値で追い、先に届いた方で決済する。
    - 同じ5分足で両方に届いたら損切り。
    - 5分足の始値がすでに水準の先なら、その始値で決済。
    - 5日（金の23時間×5）で決着しなければ、その時点の終値で決済。4時間足は4週間でも測った。
  - 決済の組み合わせ:
    - 利確 T ＝ 5（今のメールの TP1）・15・30・50ドル。
    - 損切り S ＝ 10（今）・15・20・30・50・100ドル・なし。
    - 足の幅（ATR14）に合わせるもの6通り（利確 0.5・1・2倍 × 損切り 1・2倍）。
  - 決め方（§8.77 と同じ）:
    1. 候補は4時間足の51通り（今の決済と、損切り100ドル・なしを除く）。
    2. 前半（〜2025-05-18）で1回あたりが一番良いものを1つ選ぶ。
    3. 後半で今の決済と比べる。後半で今より良く、差の区間の下の端（週ごと・4週間ごとの低い方）が0より上なら「はっきり良い」。
  - 作り物の値動き50本（同じ区切り）での確かめ:
    - 照合はすべて違い0。
    - 判定が誤って「はっきり良い」と出たのは50本中1本。
    - 損切り100ドル・なしは、区間が狭く出すぎる（まれな大きな負けが半分の期間に出ないため）。数字は出すが、判定の対象にしなかった。
  - 確かめたこと（実データ）: メールの関数との照合の違い0（5,788本）、損切りの幅を1つ広げたときの結果の違い0（835,784件）、合図の足の終値と5分足の違い0（29,510回）。
- **結果**（2024-01-01〜2026-09-28、メールの合図、1回あたりのドル、スプレッド込み。スプレッドの中央値は $0.54、日足だけ $0.73）:
  - 今の決済（TP1 5ドル・損切り10ドル・5日）:

    | 時間足 | 回数 | TP1 が先 | 1回あたり |
    |---|---|---|---|
    | 5分足 | 19,649 | 64% | −0.77 |
    | 15分足 | 6,481 | 64% | −0.74 |
    | 1時間足 | 1,816 | 64% | −0.69 |
    | 4時間足 | 459 | 63% | −0.77（区間 −1.43〜−0.11） |
    | 日足 | 72 | 61% | −1.36 |

    - 損益ゼロには、スプレッドを除いても TP1 が先の割合が 67% 要る。どの時間足も届かない。
    - 4時間足で、合図と関係なくすべての足で入った場合（物差し）は −0.65（64%）。メールの合図とほぼ同じ。
  - 4時間足、利確と損切りの組み合わせ（全期間・5日、1回あたり）:

    | 利確＼損切り | 10 | 15 | 20 | 30 | 50 |
    |---|---|---|---|---|---|
    | 5（今） | −0.77 | −0.86 | −1.59 | −1.75 | −1.26 |
    | 15 | −0.88 | −0.93 | −1.06 | −1.51 | −1.05 |
    | 30 | −0.09 | −0.14 | −0.83 | −1.18 | −0.41 |
    | 50 | −0.06 | −0.41 | −0.81 | −0.46 | +1.13 |

    - 足の幅に合わせるもの: 利確1倍・損切り2倍 +0.74、利確2倍・損切り2倍 +1.66 など。
    - 前半と後半で大きく違う: 利確50・損切り50 は −3.44 と +6.13、足の幅の2倍・2倍は −0.86 と +4.42。後半（2025-05〜）は金が大きく上がった時期。
  - 選ばれたもの: 利確50・損切り10・4週間（前半 +0.51、今の決済は −0.74）。
    - 後半は −0.33 で、今の決済は −0.80。差は +0.47（区間の下の端 −3.10）。判定は「はっきり良いとは言えない」。
    - この決め方が良く見えるのは BUY の分（BUY +4.63、SELL −3.54）。物差しでも同じ形（BUY +3.61、SELL −3.03）なので、合図の強みではなく、この期間に金が上がり続けたことによる。
  - 区切りを変えた3通り（4時間足をニューヨーク時間に合わせる・01時のまま・平らな足を入れない）:
    - 判定はどれも「はっきり良いとは言えない」。
    - 選ばれたものは3通りとも違った（利確30・損切り15・5日、利確15・損切り20・5日、利確15・損切り30・5日）。後半の差は −0.72・−1.41・−0.04。
    - 今の決済の4時間足は −1.04・−0.68・−1.07。
    - 利確50・損切り50・5日の後半は、本命の区切りでは +6.13 だが、3通りでは −0.16・+0.41・+1.36。4時間足は前半240回・後半219回しかなく、足を1時間ずらすだけで数字が大きく動く。
  - 測れていないこと:
    - メールの足（Twelve Data）そのものではなく、Dukascopy の値から作った足で測った（終値の差の中央値 $0.7〜0.9）。
    - 豪州の夏時間中の4時間足の区切り。10月4日から夏時間になるので、そのあと保存される足で確かめられる。
    - Twelve Data の日足の作り方は、2025-04 と 2025-11 に変わっている（それ以前は別の区切り）。今の区切りで全期間を測った。
    - スワップ（金利）とすべりは数えていない。
- **判定**: 決めた基準では「はっきり良いとは言えない」（4通りの区切りすべて）。メールとチャートは変えていない。変えるかどうかはオーナーが決める。`research/gold.ts`・`research/dukascopy.py` と `gold.yml`・`gold-study.yml` は、測定をやり直せるように残した（本番のコードからは読んでいない）。

### 8.80 金の利確を30・60・90ドルにした（#168）

- **指示**（2026-09-30）:
  - §8.79 の結果と選択肢（1. 今のまま・2. 利確を広げる〈例: 利確30ドルか50ドル・損切り10ドル〉・3. 説明文だけ直す・4. その他）を示したところ、オーナーが「2で」。
  - 数字を確かめたところ、利確1は30ドル、利確2・3は利確1の2倍・3倍（60・90ドル）、損切りは10ドルのまま。
    - 利確1の選択肢として示した数字（4時間足）: 30ドルは TP1 が先 25%・1回あたり −0.09ドル（前半 −0.14・後半 −0.04）、50ドルは 16%・−0.06ドル（前半 +0.20・後半 −0.33）。どちらも今の決済より「はっきり良い」とは言えない差だった。
- **変えたこと**:
  - `_shared/ultra.ts`: 金の設定 `ULTRA_GOLD`（損切り10、利確 TP1 30・TP2 60・TP3 90）を追加し、`ultraParamsFor(gold)` が金にこれを返すようにした。`ULTRA_DEFAULTS`（動画の設定）と FX の `ULTRA_PAIRS`（損切り30）はそのまま。
  - Q-Trend の損切り・利確も ULTRA と同じ数字を使うので、金は Q-Trend も利確 30・60・90ドル（チャートとメール）。
  - シグナルの出方（ULTRA は RSI が30・70をまたいだ足、Q-Trend は線を抜けた足）は利確に左右されないので、メールが届くタイミングは変わらない。
  - メールの記録の ID（`ULTRA_RULE_ID`）は変えていない（§8.78 と同じ理由: メールの重複を防ぐ一意のキーに含まれているため）。実際の損切りと利確1の価格は、送信の記録（`signal_alerts.stop`・`target`）に残る。
  - メールの文面（金）:
    - ULTRA のメールの見出しを「ULTRA の目安（損切りは動画の設定、利確は30・60・90ドル）」にし、「金では、このアプリで測ったうえで、利確を30・60・90ドルにしています（動画は5・10・15）」を足した。
    - 「金はこの目安では測っていません」をやめ、測った数字（下）にした。損益ゼロに要る割合は 10÷(10＋30) で25%。スプレッドを払う分、さらに上が要ることも書いた（1時間足の Q-Trend は 25.6% でも負けのため）。
  - チャート: インジケーター名「ULTRA（RSI 14・SL $10・TP $30/60/90）」。ULTRA と Q-Trend の説明文（日本語・英語）に金の設定と測った数字。メール通知の設定の説明（利確1〜3: FX は 5・10・15pips、金は 30・60・90ドル）。
  - 研究プログラムは `ULTRA_DEFAULTS` を読み、アプリの `ultraParamsFor` を読んでいないので、これまでの結果はそのまま再現できる。`research/gold.ts` に、メールに書く数字（利確30・損切り10・5日）を小数1桁で出す行を足した。
- **メールと説明文に書く数字**（`research/gold.ts`、GitHub Actions run 36678229867。§8.79 と同じデータ・同じ計算。メールで送られる合図を、その足の終値で入った場合。5日で決着しなければその時点で決済）:

  | 時間足 | Q-Trend: TP1 が先・1回あたり | ULTRA: TP1 が先・1回あたり |
  |---|---|---|
  | 5分足 | 25.5%・−0.09ドル | 22.8%・−1.14ドル |
  | 15分足 | 25.6%・−0.01ドル | 21.4%・−1.68ドル |
  | 1時間足 | 25.6%・−0.03ドル | 23.9%・−0.74ドル |
  | 4時間足 | 27.2%・+0.59ドル | 20.8%・−1.97ドル |
  | 日足 | 26.5%・+0.21ドル | 15.4%・−4.45ドル |

  - 損益ゼロには（スプレッドを除いて）25%より上が要る。4回に3回ほどは損切りになる。
  - 金のメールが届くのは1時間足・4時間足・日足だけ（Twelve Data の銘柄のため）。5分足・15分足の数字はチャートの説明にだけ書いた。
  - このほかの出力（§8.79 の表・判定）は、前回の実行（run 36657390402）と1行も変わらないことを確かめた。
  - 利確2・3（60・90ドル）は測っていない。測れていないことは §8.79 と同じ（メールの足そのものではない、豪州の夏時間中の4時間足の区切り、スワップ・すべり）。
- **確かめたこと**:
  - テスト: 全テスト 2,299件（3件を足した）。
    - 足したもの: 金の設定の値（`ULTRA_GOLD`・`ultraParamsFor`）、金の作り物の値動きでの取引（利確30・60・90）、金のサインの損切り・利確（10ドル・30・60・90ドル）。
    - 直したもの: チャートの金の表示（名前・印・箱・札・表の回数・説明文）、メールの金の文面（損切り・利確・測った数字・損益ゼロの割合）。
  - チャートの表の回数の期待値は、テストと同じ作り物の値動きで、テストとは別に Python で数え直して決めた。
    - 利確5・10・15で数えると、元の期待値（取引10件、TP1 9・TP2 6・TP3 3・損切り1）がそのまま再現できることを先に確かめた。
    - 利確30・60・90では TP1 1・TP2 0・TP3 0・損切り8（合計9）で、最新のサインは決着していない。
    - 画面の外に出る価格の札（損切り↓・TP2↑・TP3↑）は、足の範囲（4253.73〜4288.25）と余白から外に出ることを確かめた。
  - 金の設定を元（5・10・15）に戻すとテストが4件落ちること、メールの数字を1つ変えるとテストが落ちることを確かめた。
  - 型チェック（既存の12件のみ）、lint（変更の前後で同じ既存の34件）、Deno の型チェック（signal-alerts・research/gold.ts）。
- **反映**: main へのマージで、GitHub Actions（`deploy-functions.yml`）が関数を反映する（signal-alerts）。そのあと Lovable に公開する。

### 8.81 メールを、足の確定の直後に読んで送る（#171）

- **きっかけ**（2026-09-30）:
  - AUD/USD 4時間足の ULTRA 買い（2026-09-29 21:00 JST 確定、損切り10 pips の設定のとき）のメールは 21:04:13 に届いた。
  - GMO の1分足では、利確1（+5 pips）に届いたのは 21:04〜21:05（Bid 0.70070）と、21:13 にちょうど同じ値に触れた1回だけで、そのあと 21:55 に損切りに届いた。メールを見てから入ると、利確1はほぼ取れなかった。
  - オーナー「4分後じゃ遅いじゃないですか？一瞬で届く様にはならない？」。1〜3（確定の1分後に読む・確定の直後から読む・予告メール）を示したところ「試してみて、1〜3すべてやるのもあり？」。1は2の控えとして含め、2から進める（3は決め方を確かめてから）。
- **4分かかっていた理由**（`signal_alerts` の直近14日、送ったもの。確定からメールの行ができるまで）:

  | 時間足 | 中央値 | 最短 |
  |---|---|---|
  | 5分足 | 72〜78秒 | 69秒 |
  | 15分足 | 96秒（Q-Trend） | 80秒 |
  | 1時間足 | 193〜249秒 | 96秒 |
  | 4時間足 | 253秒 | 63秒 |
  | 日足 | 296〜423秒 | 296秒 |

  - 4時間足・日足は確定の4分後と6分後に読む決まりだった（5分足・15分足・1時間足と同じ時刻に GMO へまとめて問い合わせないよう、ずらしていた）。GMO の足が遅れて出るからではない。
  - 4時間足21ペアの読み込みは約12秒（GMO へ0.2秒おきに Bid・Ask の今年分を1ペア2回）。送信（Resend に渡すまで）は約0.5秒。
  - メールは、全部のチャートを読み終えてからまとめて送っていた。
- **測ったこと**（`research/gmo-lag.py`、GitHub Actions `gmo-lag.yml`。読み取りだけ）: 確定の前後に GMO の足を0.2秒おきに読み、GMO が答えを作った時刻（`responsetime`）と最新の2本を記録した。

  | 確定（UTC） | 銘柄・足 | 確定後に GMO が作った最初の答え | 確定した足 |
  |---|---|---|---|
  | 08:30 | USD/JPY 1分・5分 | 3.66秒後・0.61秒後 | どちらも最終の値 |
  | 08:40 | USD/JPY 1分・5分、AUD/USD 1分・5分 | 1.67・0.77・2.90・2.90秒後 | どれも最終の値 |
  | 09:00 | USD/JPY 5分・15分・1時間 | 1.65〜1.66秒後 | どれも最終の値 |
  | 09:00 | AUD/USD 5分・15分・1時間 | 4.18〜4.40秒後 | どれも最終の値 |

  - GMO の答えは CDN（CloudFront）を通り、数秒前に作られた答えが返ることがある（確定の1.5秒後に読んで、確定の0.24秒前に作られた答えだった）。
  - GMO が確定より後に作った答えには、確定した足が最終の値で入っていた。「確定後に作られたのに最終の値でない答え」は一度もなかった（上の12回）。
  - 4時間足のファイル（年ごと）の形成中の足も、1時間足と同じ最新の値で更新されていた（09:00 前後）。4時間足そのものの確定は、まだ測っていない。
  - 前の取引日のファイルは、終わったあとも何時間も前の答えが返る（9月29日のファイルは、翌日も前日 21:00 に作られた答えだった）。
- **変えたこと**（signal-alerts v11）:
  - 読む時刻（`gmoIntervalsDue`）: 足が確定したその分にも読む（5分足は5分ごと、15分足は15分ごと、1時間足・4時間足・日足は毎時0分）。これまでの時刻（5分足・15分足は1分後と3分後、1時間足は3分後と5分後、4時間足・日足は4分後と6分後）は、控えとして残す。
  - 巡回は、分が始まって1秒たってから読む（`startWaitMs`。時計が少し遅れていても、確定した足を確定したと数えるため）。分の終わり2秒以内に始まった巡回は、次の分として動く。
  - 古い答えで判定しない（`staleForClose`）: GMO が確定より前に作った答えで、確定した足（かそれより新しい足）が入っているものは、1秒おいて読み直す（8回まで）。それでも古ければ、その回は読まずに控えの時刻に任せる。古い足しか入っていない答え（終わった取引日のファイル）は、そのまま使う。`responsetime` がない答えは、これまでどおり使う。
  - 4時間足・日足は、1ペア目を読んで、この時刻に足が確定したかを見極める（`hourCloseOf`）。確定していなければ残りのペアは読まない（これまでは確定のない時間にも毎時42回ずつ問い合わせていた）。確定した足が足1本分より古いとき（読み込みが途中で切れた、週末をはさむ）は「わからない」とし、次のペアで見極める。
  - サインが出たチャートは、全部を読み終えるのを待たずに、その場でメールを送る。
  - 巡回の結果（`net._http_response` に残る）に、各チャートを確定の何ミリ秒後に判定したか（`judged_after_ms`）と、読み直した回数（`files.stale`）を出す。
  - 二重に送らないことは、これまでどおり送信の記録の一意のキーで守る（控えの時刻の巡回が同じサインを見ても送らない）。
  - `feed-check.yml` に、答えを jq で絞ってから表示する設定を足した（`filter`・`max_bytes`。指定しなければ動きは同じ）。
- **変えていないこと**:
  - Twelve Data の15ペアと金（確定の1分後から、1回の巡回で3つまで。無料プランの読み込みの上限が1分8回で、チャートと分け合うため）。同じ時刻に確定する16銘柄を全部読むには数分かかる。
  - メールが携帯に届くまでの時間（Gmail 側。測っていない）。
- **見込み**（測っていない。反映後に確かめる）: GMO のペアは、確定の数秒後に1ペア目、21ペアを順に読むので最後のペアは十数秒後。
- **確かめたこと**:
  - テスト: 全テスト 2,303件（読む時刻のテストを直し、4件を足した: 読む時刻と確定の時刻、古い答えの見分け方〈08:30 の実際の答えの形で〉、1時間の中の確定の見極め、始まりの待ち時間）。
  - 古い答えの見分けで「確定した足が入っているか」を見ないようにする、確定した分に5分足を読まないようにする、「わからない」を「確定なし」と扱う、の3つのまちがいを入れると、それぞれテストが落ちることを確かめた。
  - `research/gmo-lag.py --selftest`（作り物の答えでのまとめ方）と、そのまちがい2つを見つけること。
  - 型チェック（既存の12件のみ、変えたファイルには0件）、lint（既存の34件のみ、変えたファイルには0件）、Deno の型チェック（signal-alerts）。
- **反映**: main へのマージで、GitHub Actions（`deploy-functions.yml`）が signal-alerts を反映する。画面は変えていない（Lovable の公開は要らない）。
  - 4時間足そのものの確定を測る前に反映した。オーナーの指示「今反映して」（2026-09-30 20:10 JST。「今夜 21:00 の確定からすぐ速くしたい場合は、測る前に反映することもできる」と示したうえで）。
  - 21:00 JST（12:00 UTC）の確定を、本番の巡回と測定（`gmo-lag.yml`）の両方で確かめる。
  - 反映: PR #139（マージ 2c9a2da）、`deploy-functions.yml` run 36706934489 成功、signal-alerts v18 → v19（2026-09-30 11:11:32 UTC）。11:12 の巡回から版名 v11。
- **反映後の最初の4時間足の確定**（2026-09-30 12:00 UTC = 21:00 JST）:
  - 測定（run 36710438631）: USD/JPY 4時間足は確定の1.08秒後、AUD/USD 4時間足は3.81秒後に GMO が作った答えが、確定後に作られた最初の答えで、どちらも確定した足が最終の値だった（1時間足も1.78・3.78秒後で同じ）。測った確定は4つの時刻で16回、「確定後に作られたのに最終の値でない答え」は一度もない。
  - 本番の巡回（12:00 の巡回、`net._http_response`）: GMO の21ペアすべてを 12:00 に確定した足で判定した。確定から判定まで、最初のペアが1.7秒、最後のペアが14.1秒。古い答えの読み直しは1回。
  - サインは GBP/JPY の Q-Trend BUY（STRONG）の1つ。メールの行は確定の3.56秒後に作られ、4.23秒後に Resend に渡った（これまでの4時間足は中央値253秒）。携帯に届いた時刻は測っていない。
  - 送ったエントリー 208.647 は、確定の3分後に GMO から読んだ確定足の Bid 208.643・Ask 208.652 の仲値（208.6475）と合っていた。
  - 控えの 12:04・12:06 の巡回も21ペアすべてを読み直し、判定は3回とも同じ（サインは GBP/JPY の1つだけ）。この2回は送信済み（duplicate）として送っていない。
  - 控えの巡回が全ペアを読み直したのは、判定済みの覚え（`judgedBar`）が巡回のインスタンスごとで、毎回別のインスタンスで動いたため。確定のある時刻の GMO への問い合わせは、これまでと同じ量（1回42件）。
- **確定のない時刻**（13:00 UTC、GMO の4時間足は確定しない）: 4時間足は1ペア目だけを読み（古い答えの読み直し2回を含めて GMO へ4件）、残り20ペアは「確定なし」（`no_close`）として読まなかった。13:04・13:06 の控えも1ペア目だけ（各2件）。これまでは確定のない時刻にも毎時42件ずつ問い合わせていた。
  - Twelve Data の16銘柄（4時間足は 13:00 UTC に確定）は、これまでどおり1回の巡回で3つずつ読み、確定の約1〜6分後に判定した（最後の金は6分後）。


### 8.82 FX の利確を20・40・60 pips にした（#173）

- **指示**（2026-09-30）:
  - オーナー「利確幅、狭すぎる」（FX の利確1 5・利確2 10・利確3 15 pips、損切り30）。まず測ってから選んでもらう予定で、測定（#172、`research/widetp.ts`）を始めた。
  - その後、EUR/USD 4時間足の ULTRA 買い（17:00 JST 確定）の値動きを確かめたところで、オーナー「利確を広げてください」。
  - 利確1を 10・20・30 pips のどれにするか、測定の結果を待って決めるかを示した。オーナーは「利確1 20 pips」を選んだ（測定の結果は待たない）。
  - 利確2・3は利確1の2倍・3倍（動画の 5・10・15 と同じ比）。損切りは30 pips のまま。
- **変えたこと**:
  - `_shared/ultra.ts`: FX の設定（ULTRA_PAIRS）を、損切り30・利確 20・40・60 pips にした。金（ULTRA_GOLD）と動画の設定（ULTRA_DEFAULTS）は変えていない。
    - サインの出方は利確に左右されないので、メールが届くタイミングは変わらない。
    - メールの記録の ID（ULTRA_RULE_ID）は変えていない（二重送信を防ぐキーの一部）。
  - Q-Trend のメールとチャートの損切り・利確も、ULTRA と同じ数字なので同じく変わる。
  - メール: 目安の見出し（「利確は20・40・60pips、損切りは30pips」）、説明（損切りは測った結果から30、利確は20・40・60〈動画は5・10・15〉）、「測った成績」を利確20で測り直した数字、損益ゼロに要る割合 60%（30÷(30+20)。これまでは 86%）。
  - チャート: インジケーター名「ULTRA（RSI 14・SL 30・TP 20/40/60 pips）」、ULTRA と Q-Trend の説明文、メール通知の設定の説明（日本語・英語）。
  - 0以下になる目安: HUF/JPY（約0.49円）の売りでは、利確3（60 pips = 0.60円）が0より下になる。メールでは「利確3 —（0より下になるため、この目安はありません）」と書き、チャートには札も線も出さない（札の説明の文では「—」）。
  - 説明文の直し（誤り探しで見つかったもの）:
    - Q-Trend の説明: 今どの銘柄にも使っていない TP1 5・TP2 10・TP3 15 を、今の数字として書かないようにした（FX と金の今の数字だけにした）。
    - メールと Q-Trend の説明の損益ゼロの割合に、金と同じく「スプレッドの分さらに上」を足した（4時間足の ULTRA は 60.1% で、60% を少し超えていても負けている）。
    - メール通知の設定の注意書き: 「Q-Trend も ULTRA も、過去のチャートでの検証はしていません」（#155 からの文）を、測った成績をメールとチャートの説明に書いていることに直した。「足が確定してから1〜3分ほどで届きます」（#171 の前の文）を、GMO の銘柄は確定から十数秒ほどで送ることに直した。
  - `research/tf-winrate.ts` と `tf-winrate.yml`: 利確1を入力で渡せるようにした（利確2・3は2倍・3倍。指定しなければ動画の 5・10・15。ワークフローの既定は 20）。
  - signal-alerts の版名を v12 にした。
- **測り直した成績**（tf-winrate、利確1 20・損切り30、GitHub Actions run 36730814776）:
  - 2024-01-01〜2026-09-30、GMO の FX 21ペア。メールで送られるサインを、その足の終値で入った場合（スプレッド込み）。5日たっても決着しなければ、その時点で決済。
  - 照合: メールの関数との合図の違い0（5つの時間足）、GMO の読み込みの失敗0。

  | 時間足 | Q-Trend: 利確1が先 | 1回あたり | ULTRA: 利確1が先 | 1回あたり |
  |---|---|---|---|---|
  | 5分足 | 58.0% | −2.03 pips | 58.2% | −1.81 pips |
  | 15分足 | 58.4% | −1.80 | 58.0% | −1.79 |
  | 1時間足 | 59.2% | −1.33 | 58.4% | −1.87 |
  | 4時間足 | 58.3% | −1.47 | 60.1% | −0.54 |
  | 日足 | 55.1% | −6.92 | 50.0% | −9.50 |

  - 損益ゼロには、スプレッドを除いても、利確1が先の割合が 60% より上である必要がある。4時間足の ULTRA（60.1%）を除いて、どれも 60% より下で、1回あたりはどれもマイナス。
  - 4時間足は、#182 で GMO の日曜 20:00 UTC の足を残して測り直した（Q-Trend 59.1%・−1.17 pips、ULTRA 60.8%・−0.37 pips。§8.93）。メールとチャートの説明は #192 までその数字（#192 で損切り13・利確4に変え、測り直した。§8.98）。
  - 利確5のとき（§8.78、run 36587276263）の4時間足は、Q-Trend −0.87・ULTRA −0.46 pips だった。
    - ただし、同じ取引どうしを比べた数字ではない（期間の終わりが1日違う）。区間も重なっている。
    - 利確を広げて良くなったとも、悪くなったとも言えない。同じ取引どうしで比べた測定は §8.83（#172）。そこでも、利確20と利確5の差ははっきりしなかった（全期間 −0.49 pips、区間 −1.24〜+0.26）。
  - 5日で決着しない取引は、4時間足で 17%（6,097回のうち1,018回）。ほぼすべてが値段の低い円のペア（MXN/JPY 341回・ZAR/JPY 331回・TRY/JPY 345回、ほかは NZD/USD の1回）。
    - これらのペアは、決着した取引だけで数えると利確1が先の割合が高く出る（4時間足 MXN/JPY 74.7%・ZAR/JPY 71.1%）。
    - 上の表は、これらを含めた21ペアの値（§8.78 と同じ数え方）。
- **確かめたこと**:
  - テスト: 全テスト 2,304件。
    - 期待値を利確20・40・60に直したもの: 設定、メールの文面と数字、チャートの ULTRA の表・札・印、Q-Trend の札、インジケーター名、説明文。
    - チャートの ULTRA の表と印の期待値は、テストとは別に Python で数え直して決めた。利確5・10・15では、元の期待値がそのまま出ることを先に確かめた。
    - 十字線のテストは、作り物の値動きの最新の ULTRA の取引が、利確が広がって決着しないまま残る。すると右端に価格の札の場所が空き、足の位置がずれる。十字線を確かめるテストなので、そのテストだけ ULTRA と Q-Trend を切った。
  - 0以下の目安のテストを足した。
    - HUF/JPY の売り（終値 0.488）のメールで、利確3が「—」になり、マイナスの価格が出ないこと。
    - チャートで、利確3の札が出ず、どの札にもマイナスの価格が出ないこと。足は作り物で、最新の取引が決着していない売りになる種を Python で数えて選んだ。
    - 0以下を外す処理を消すと、この2件が落ちる。
  - 利確を5・10・15に戻すと7件、メールの数字を1つ変えると1件、テストが落ちることを確かめた。
  - 誤り探し（4つの見方: 変え忘れ・数字・テスト・本番。見つかった指摘は別の1人が確かめた）:
    - 本当とされた指摘は直した: HUF/JPY のマイナスの利確、Q-Trend の説明の古い数字、メール通知の設定画面の古い文。
    - 誤りではないとされたものは変えていない。チャートで利確の札が混み合うと線から離れること（札をチャートの中に重ねずに並べる、以前からの決まり）、十字線のテストで ULTRA を切ったこと。
  - 型チェック（既存の12件のみ、変えたファイルには0件）、lint（変えたファイルに0件）、Deno の型チェック（signal-alerts）。
- **かかる範囲**:
  - FX の全ペア（GMO の21ペア、Twelve Data の15ペア）の、全時間足（5分足〜日足）のメールとチャート。金は変わらない。
  - Twelve Data のペアは測っていない。
  - #153 で足した7ペアは、GMO の足が 2026-05 からしかない。5分足〜1時間足にはその期間が入っているが、4時間足と日足は判定できる足がなく、測れていない。
  - 値段の低いペアでは、同じ pips でも値段に比べた幅がずっと大きい。HUF/JPY（約0.49円）では、測った取引が5日のうちに1回も決着しなかった（5分足 2,771回、15分足 999回、1時間足 126回）。利確5・損切り30のときも同じだった（§8.78）。
- **反映**: PR #142（マージ 50334df）、`deploy-functions.yml` run 36737325928 成功。本番の巡回は 2026-09-30 15:32 UTC から版名 v12（`net._http_response` で確かめた）。画面の文言は Lovable に公開を依頼（状態 pending、反映は確かめていない）。

### 8.83 FX の利確1の幅を、同じ取引で比べて測った（#172）

- **指示**（2026-09-30）: オーナー「利確幅、狭すぎる」（FX の利確1 5・利確2 10・利確3 15 pips、損切り30）。先に測って、数字と選択肢を示し、オーナーが決める。
  - 測っている途中で、オーナーは測定の結果を待たずに、利確を20・40・60 pips にした（#173、§8.82）。
  - この測定の「今」は、決めたとおり #173 の前のメール（利確1 5 pips）のまま。今のメールの決済は、候補の T20（利確1 20・損切り30・5日）と同じ。
- **測り方**（`research/widetp.ts`、GitHub Actions の `widetp.yml`）:
  - データを見る前に決めて commit した（0347822）。その後の直し:
    - 誤り探しの直し（59446aa）。
    - #173 に合わせた確かめの直し（de9efd4）。
    - 作り物の値動きの結果（75c56c4）。
  - データ: GMO の4時間足・5分足（Bid/Ask）。
    - 期間は 2024-01-01〜2026-09-29 14:16:25 UTC。#165 の run 36581316006 の終わりと同じにして、§8.77 の数字がもう一度出ることを確かめる（§8.77 はその前の run〈14:09:47 まで〉から書いたが、確定した4時間足は同じで、同じ数字が出ている）。
    - 前半は 2025-05-18 まで。
  - 合図・物差し・入り方・5分足での追い方は §8.77 と同じ。読む時刻は #171 の後のもの（確定の0・4・6分後）。
  - 決済: 利確1 T と損切り30 pips（中値の終値から）。先に届いた方で全部を決済する。
    - 同じ5分足で両方に届いたら損切り。5分足の始値がすでに先にあれば、その始値で決済。
    - 30本（5日）で決着しなければ、その足の終値で決済。
    - 候補（10通り）: T ＝ 10・15・20・30・45・60・90 pips と、合図の足の ATR14 の 0.5・1・2倍。ATR14 はメールと同じ始まりから計算する。4時間足の ATR14 の中央値（前半）は、A+B ではペアにより 19.5〜66.7 pips、C では 2.2〜4.2 pips。
    - 今: T ＝ 5（#173 の前のメール）。
    - 数字だけ出すもの: 4週間（120本）持つ場合。
    - 利確2・3は 2T・3T（動画の 5:10:15 の比）として、届いた割合だけを出す。判定は利確1だけ。
  - 選ぶ・判定する集まり: 円の主要7ペアとドルの4ペア（A+B、11ペア）。
    - TRY/JPY・ZAR/JPY・MXN/JPY（C）は値段が低く、1 pip の重さが違うので別に出す。
    - §8.77 は14ペアまとめて判定した。そこから変えた。
  - 決め方:
    1. 前半で、「今との差」の t が一番大きい候補を1つ選ぶ。
       - t は、平均 ÷ 標準誤差（週ごと・4週ごとの大きい方）。
       - 後半の値を使う取引（SPLIT の直前5日のもの）は除く。
       - 平均だけで選ぶと、ばらつきの大きい一番広い候補が選ばれやすいと考えたため（平均だけで選んだ場合を、作り物の値動きで試してはいない）。
    2. 後半で今と比べる。次の両方を満たせば「はっきり良い」。
       - 後半の1回あたりが今より良い。
       - 差の区間の下の端が0より上。下の端は、週ごと・4週ごとの低い方。区間は t 分布。
    3. 表から選ぶときのために、全候補の後半の差に Bonferroni の区間も出す。
- **作り物の値動き**（実データの前。de9efd4 の版で70回）:
  - 確かめはすべて違い0。
  - 効き目のない値動き（path、50回）:
    - 「はっきり良い」は0回、Bonferroni も0回（関門はどちらも3回まで）。
    - どの候補も、区間の下の端が0より上になったのは100回中0〜3回（7回以上なら外す決まり）。
    - z のばらつきは 0.96〜1.18（関門は1.25まで）。外す候補はなかった。
    - 利確1が先の割合は計算どおり（T5 84.9%・計算 85.1%、T20 59.6%・59.6% など）。
  - 広い利確が得をする値動き（drift、10回）: 10回とも「はっきり良い」（関門は9回）。
  - 狭い利確が得をする値動き（wicks、10回）: 0回。
  - 検出力（path の上で、1つの候補に1回あたりの得を足す）:
    - 「はっきり良い」と出た回数（50回中）: T20 は +1 pip で23回、+2 pips で49回。T45 は +1 pip で6回、+2 pips で30回。ATR×1 は +1 pip で20回、+2 pips で48回。
    - 1回あたり1〜2 pips の得でも、この作り物のばらつきで見逃すことが多い（候補によってさらに見分けにくい）。実データのばらつきは、この作り物と同じではない。
- **確かめたこと**（実データ、GitHub Actions run 36738170786、commit 75c56c4）:
  - メールの関数との照合:
    - 合図 10,142本。
    - メールの水準 6,185本（損切り30・利確 20/40/60）。
    - Q-Trend の ε 4,324本。
    - ATR 10,142本。
    - どれも違い0。
  - §8.76 のコードとの照合: 違い0（355,092件）。
  - 損切り・利確・上限の入れ子: 違い0。
    - 損切りの入れ子 275,987件。
    - 利確の入れ子 2,065,684件（pips と ATR の候補をまとめて並べたもの）。
    - 上限の入れ子 1,065,276件。
  - 時間切れの終値: 違い0（338,817件）。
  - 読む時刻の変更: 違い0（59,836本）。
  - GMO の読み込みの失敗: 0。
  - §8.77 の数字の再現: 5つとも小数2桁まで同じ（例: S10 L30 の −1.28・−1.07、S30 L30 の −0.61・−0.99。取引の数も 3,001・2,762 で同じ）。
- **結果**（A+B の11ペア、メールの合図、1回あたりの pips、スプレッド込み。前半 2,416回・後半 2,216回）:

  | 利確1 | 前半 | 後半 | 全期間 | 利確1が先（全期間） | 損益ゼロに要る割合（30÷(30＋T)、スプレッドを除く） | 勝ちの平均（前半・後半） |
  |---|---|---|---|---|---|---|
  | 5（#173 の前） | −0.48 | −1.20 | −0.82 | 84.7% | 85.7% | +4.7・+4.6 |
  | 10 | −0.90 | −1.10 | −1.00 | 73.6% | 75.0% | +9.6・+9.7 |
  | 15 | −1.15 | −1.29 | −1.22 | 65.0% | 66.7% | +14.6・+14.9 |
  | 20（今のメール） | −1.35 | −1.27 | −1.31 | 58.3% | 60.0% | +19.6・+20.0 |
  | 30 | −1.77 | −0.96 | −1.38 | 48.5% | 50.0% | +29.6・+30.0 |
  | 45 | −1.41 | −0.58 | −1.01 | 39.3% | 40.0% | +44.5・+44.8 |
  | 60 | −1.82 | −0.91 | −1.38 | 32.2% | 33.3% | +58.9・+58.5 |
  | 90 | −2.91 | −0.85 | −1.93 | 22.6% | 25.0% | +83.6・+80.9 |
  | ATR×0.5 | −1.66 | −1.24 | −1.46 | 61.0% | 63.0% | +18.6・+16.0 |
  | ATR×1 | −2.53 | −1.18 | −1.89 | 44.8% | 46.8% | +35.9・+31.8 |
  | ATR×2 | −3.47 | −1.36 | −2.46 | 29.6% | 31.2% | +67.9・+61.0 |

  - どの幅も、利確1が先の割合が、スプレッドを除いた損益ゼロの線のわずかに下にある。
  - 1回あたりの平均は、どの幅でも前半・後半ともマイナス。ただし半分ごとでは、区間が0をまたぐものが多い。全期間では、T45・T60・T90 以外は区間が0より下。
  - 負けの平均はどの幅でも約 −29〜−31 pips（損切り30）。
    - 最悪の1回は、損切りの30 pips より大きい。5分足が損切りの先から始まるとその始値で決済になる決まりなので、週明けの窓などでそうなったと考えられるが、どの取引かは確かめていない。
      - 前半: 利確5 −41.0、利確10 −49.2、利確15〜45 と ATR×0.5 −149.0、利確60・90 と ATR×1・×2 −257.6 pips。幅によって違うのは、広い利確ほど長く持つためと考えられるが、これも確かめていない。
      - 後半: どの幅も −88 pips。
  - 選ばれたもの: 前半では、10の候補すべてで、今（利確5）との差の平均がマイナスだった（t がすべてマイナス）。その中で一番ましな T45（t −1.07）が選ばれた。
    - 前半の差の区間の全体が0より下なのは ATR×0.5・×1・×2 だけで、ほかの7つは区間が0をまたぐ。
    - 後半は −0.58 で、今は −1.20。
    - 差は +0.62（区間 −1.33〜+2.57、4週ごとでは −1.73〜+2.97）。
  - Bonferroni の区間: どの候補も0をまたぐ。
  - 今のメール（利確20）と #173 の前（利確5）の差:
    - 前半 −0.88、後半 −0.07、全期間 −0.49 pips。
    - 全期間の区間は −1.24〜+0.26（4週ごとでは −1.33〜+0.35）。
    - 利確20の方が少し悪い向きだが、はっきりとは言えない。
  - 利確20の取引の様子（全期間）:
    - 利確1に届くまでの速さ: 1時間以内 12.2%、4時間以内 30.6%、1日以内 55.3%。持つ時間の中央値は約0.2日。
    - 利確2（40 pips）に届いた割合は 41.6%、利確3（60 pips）は 31.7%。
    - チャートの数え方（4時間足の中値、スプレッドなし）では、利確1が先の割合は 56.2%。
    - 損切りが 0.5 pip・1 pip 悪く約定した場合、後半の今との差は −0.20・−0.33。
  - 見るだけの数字（判定には使わない。たくさんの分け方の中の1つなので、たまたまの可能性がある）:
    - 選ばれた T45 の後半の今との差を、分け方ごとに出した（分け方の間の違いがたまたまでないかは確かめていない）。
      - ULTRA の合図だけ: +3.34（週ごとの区間 +0.41〜+6.27、4週ごとの区間 −0.23〜+6.91。671回）。
      - STRONG: +4.09（週ごとの区間 +0.47〜+7.71、4週ごとの区間 −0.06〜+8.25。493回）。
      - Q-Trend: −0.31。
      - 買い: +1.65。売り: −0.30。
      - ペアごと: −3.98（EUR/USD）〜+5.26（USD/JPY）。
    - 物差し（A+B のすべての足で両方向に入った場合）: 今と候補（5日）の1回あたりは、前半・後半とも −1.23〜−1.84 pips。
  - C（TRY/JPY・ZAR/JPY・MXN/JPY）:
    - 5日で決着しない取引が多い（利確5で 39.4%、利確20で 85.3%）。
    - 全期間の1回あたりは、利確5 −0.66、利確20 −0.81。
    - A+B とは別に出し、判定には入れていない。
  - 測れていないこと:
    - 4時間足の履歴がある14ペアだけ。#153 で足した7ペアと、Twelve Data のペアは測っていない。
    - ほかの時間足は測っていない。メールとチャートの利確・損切りの設定（ULTRA_PAIRS）はすべての時間足・ペアで1つなので、ここで決めた幅は、測っていない時間足とペアにもかかる。
    - スワップ（金利）は数えていない。
    - すべりは、損切りを 0.5・1 pip 悪くした場合だけを数えた。
    - 足の確定からメールを見て注文するまでの時間は数えていない（入りは合図の足の終値としている）。
    - 後半を見てから、判定で選ばれなかった幅を選ぶのは、決めた手順ではない（後知恵になる）。
- **判定**: 決めた基準では「はっきり良いとは言えない」。選ばれた T45 は、後半の差の下の端が −1.73。
  - 後半と全期間では、どの幅も、同じ取引で比べた差の区間が0をまたぐ。前半では、ATR×0.5・×1・×2 の区間が0より下（今より悪い向き）だった。
  - 利確の幅を変えて1回あたりが良くなるという証拠は、この測定では出なかった。
  - `research/widetp.ts` と `widetp.yml` は、測定をやり直せるように残した（本番のコードからは読んでいない）。
- **オーナーの決定**（2026-09-30）: 結果と選択肢（今のまま 20・40・60／5・10・15 に戻す／45・90・135）を示したところ、オーナーは「今のまま 20・40・60」を選んだ。メールとチャートは変えない（§8.82 の設定のまま）。

### 8.84 確定の前に送る予告メールを測った（#171-5）

- **指示**（2026-09-30）: 4時間足のメールが確定の4分後に届いた件で、オーナー「4分後じゃ遅いじゃないですか？一瞬で届く様にはならない？」。3つの案（確定の1分後に読む・確定の直後から読む・予告メール）に「試してみて、1〜3すべてやるのもあり？」。1・2は §8.81 で済んだ（確定から十数秒で送る）。3の予告は、決め方をオーナーに確かめてから作る約束で、先に「確定の何分前の予告が、どれくらい当たるか」を測った。オーナー「進めて」。
- **測り方**（`research/prewarn.ts`、GitHub Actions の `prewarn.yml`。データを見る前に決めて commit した: 7c78df0。誤り探しの直し 5b3144e、作り物の値動きの結果 163556e）:
  - データ: §8.83 と同じ（GMO の4時間足・5分足、2024-01-01〜2026-09-29 14:16:25 UTC、前半は 2025-05-18 まで）。オーナーが受け取っているのは4時間足の Q-Trend と ULTRA だけ（`signal_alert_subscriptions`、2026-09-30）なので、4時間足だけを測った。
  - 予告: 確定の X 分前（5・10・15・30・60・120分）の値段のまま足が確定したら、メールの合図が出るか。
    - できかけの足の終値は、その時刻に終わる5分足の中値（チャートと同じ丸め）。
    - 合図の計算はメールと同じ決まり。1本前までの状態から1本分だけ進め、メールの関数そのものと照合した。
  - 予告の出し方:
    - 「一度だけ」: 確定の X 分前に1回見る。
    - 「見張り」: X 分前から5分ごとに見て、初めて合図が出たときに1回予告する（本番なら毎分見られるが、データは5分足）。
  - 数えたもの:
    - 当たり: 予告のうち、確定で同じ合図が出た割合。
    - 拾えた: 確定の合図のうち、予告があった割合。
    - 週あたりの予告の数。
    - 当たったとき、予告の時点で入った値段とメールで入った値段の差。
    - 予告の時点で入った取引（当たり・外れ全部）の1回あたりの pips。出口はメールと同じ（利確1 20・損切り30・5日）。
  - 何かを選んだり判定したりはしない。数字をオーナーに見せて決めてもらう。
- **作り物の値動き**（実データの前、10回・21ペア）:
  - 照合はすべて違い0。
  - 確定に近いほど、当たりも拾えた割合も高い（5・30・120分前: 当たり 93.1%・84.1%・70.5%、拾えた 91.9%・77.8%・47.0%）。
  - 予告で入った取引すべてとメールの取引の差は +0.03〜+0.13 pips で、決めた関門（±0.3、かつ種ごとの標準誤差の3倍）の中。
- **誤り探し**（実データの前。4つの見方: 先読み・できかけの足の計算・数え方・実データでの動き）:
  - 先読みの照合が、作りの上で必ず通る形だけのものだった。先の5分足を値段に使うようにわざと変えても見つけられず、そのとき予告の当たりは100%に見えた。
  - t の時点で切った5分足から値段と約定を出し直して比べる照合に作り直した。わざと変えた版で約19万6千件・2万3千件の食い違いが出て見つけられることを確かめてから、実データを走らせた。
  - ほかに、説明の抜け（週あたりの数え方など）と関門の説明の誤りを直した。
- **確かめたこと**（実データ、GitHub Actions run 36749311538、commit 163556e）: すべて違い0。
  - メールの関数との合図: 10,142本。
  - できかけの足の合図とメールの関数そのもの: 220,681件。
  - 確定の値での同じ計算: 59,836本。
  - t で切った値段と約定: 1,541,574件。
  - 取引を追い始める足: 48,843件。
  - 時間切れの終値: 7,518件。
  - GMO の読み込みの失敗: 0。
  - §8.83 の利確20の数字の再現: 前半 −1.35（2,416回）・後半 −1.27（2,216回）が同じ。
- **結果**（A+B の11ペア、両方の指標、全期間 144週。メールで入った取引は1回あたり −1.36 pips、4,742回）:

  | 一度だけ・何分前 | 当たり | 拾えた | 週あたりの予告（11ペア） | 予告で入った取引（1回あたり） | うち外れた予告 | 当たりで早く入った値段の差（平均・中央値） |
  |---|---|---|---|---|---|---|
  | 5分 | 92.7% | 93.1% | 33.3 | −1.34 pips | −5.80 | +0.06・0.00 |
  | 10分 | 89.7% | 90.7% | 33.5 | −1.74 | −7.76 | +0.17・0.00 |
  | 15分 | 88.4% | 87.8% | 32.9 | −2.09 | −8.25 | +0.35・+0.10 |
  | 30分 | 86.2% | 81.9% | 31.5 | −1.66 | −10.16 | +1.37・+0.50 |
  | 60分 | 80.2% | 69.8% | 28.8 | −1.34 | −13.63 | +4.01・+1.70 |
  | 120分 | 72.2% | 50.8% | 23.3 | −2.47 | −17.61 | +7.49・+3.90 |

  | 見張り・何分前から | 当たり | 拾えた | 週あたりの予告 | 予告で入った取引 |
  |---|---|---|---|---|
  | 10分 | 88.1% | 94.8% | 35.7 | −1.57 |
  | 15分 | 85.2% | 95.5% | 37.1 | −2.03 |
  | 30分 | 79.9% | 96.6% | 40.0 | −1.81 |
  | 60分 | 72.4% | 97.3% | 44.5 | −1.35 |
  | 120分 | 63.5% | 97.9% | 51.1 | −1.74 |

  - 確定に近いほど、当たりも拾えた割合も高い。見張りは拾える割合が高いが、外れが増える。
  - 外れた予告は、どれも「確定で合図が出なかった」もの。1つの指標で、予告と逆向きの合図が確定で出ることは、決まりの上で起きない（Q-Trend の直前の向きと ULTRA の1本前の RSI は、その足のあいだ変わらないため）。
  - 予告の時点で入った取引は、どの時刻・どの出し方でも、1回あたり −1.34〜−2.47 pips。メールで入った取引（−1.36）より良いものはなかった（取引が違うので、差の区間は出していない）。
    - 当たった予告だけで見ると、早く入った分は得に見える（30分前 +1.37、120分前 +7.49）。当たりは「そのあと値が進んで合図になったもの」だけを選んでいるので、これは必ず出る見かけの得。外れた予告で、それ以上を失っている。
    - 5分前の予告で当たったときの値段の差は、平均 +0.06・中央値 0.00 pips。ほとんど同じ値段。
  - 前半・後半でほぼ同じ（一度だけ・5分前: 当たり 93.1%・92.3%、拾えた 93.3%・92.8%）。
  - 指標ごとにもほぼ同じ（一度だけ・5分前: Q-Trend 当たり 92.5%・拾えた 92.5%、ULTRA 92.8%・94.4%）。C（TRY/JPY・ZAR/JPY・MXN/JPY）も同じくらい（92.5%・93.8%）。
  - 今の確定のメール（合図）も A+B で週に約33通（4,770回 ÷ 144週）。予告を別のメールで送ると、メールの数はおよそ倍になる。
- **測れていないこと**:
  - 4時間足の履歴がある14ペアだけ。#153 で足した7ペアと、Twelve Data のペア・金は測っていない。受け取っている37銘柄全部での予告の数は、測っていない。
  - 4時間足以外は測っていない。
  - 本番では毎分見られるが、測定は5分ごと。
  - 予告のメールが届くまで・見て注文するまでの時間、スワップ、すべりは数えていない。
- **オーナーの決定**（2026-09-30）: 結果と選択肢（作らない／5分前に1回／30分前に1回／見張り〈30分前から〉）を示したところ、オーナーは「作らない」を選んだ。予告メールは作らない。本番のメールとチャートは変えていない。`research/prewarn.ts` と `prewarn.yml` は、測定をやり直せるように残した（本番のコードからは読んでいない）。

### 8.85 通貨の強弱を、買い・売りの合図として測った（#174）

- **指示**（2026-09-30）: GBP/JPY の4時間足の画像を見せて、オーナー「この画像以外に加えるべき違う指標のインジケーター考えて、買いか売りを判断するためにこの画像以外の指標で買い売り判断できるやつ」。いくつかの種類を示したところ、オーナーは「通貨の強弱」を選んだ。予告メール（§8.84）の後で、先に測ってから、チャートやメールに入れるかをオーナーが決める。
- **測り方**（`research/strength.ts`・`strength-lib.ts`、GitHub Actions の `strength.yml`。3人に別々の立場〈単独の合図・今のメールの絞り込み・誤りを疑う〉で設計案を出してもらい、1人がまとめたものをもとに、データで強弱を一度も計算する前に決めて commit した: e6ee094。データは §8.83 と同じもの〈GMO の4時間足・5分足、2024-01-01〜2026-09-29 14:16:25 UTC〉で、メールの合図と取引の結果はすでに見ていた）:
  - 強弱: 7つの円クロス（USD・EUR・GBP・AUD・NZD・CAD・CHF の対円）の4時間足の終値（チャートと同じ中値）から、8通貨それぞれの L 本の値動き（対数）を出し、8通貨の平均を引く。7本すべてに足がある時刻だけを使う（埋めない）。強い順に1〜8位。
    - 円クロスでは、A と B の強弱の差は A/B そのものの L 本の値動き（対数）と式の上で同じになる（照合で確かめた）。ドルのペアでは、2つの円クロスから作った値動きなので、そのペアそのものとは三角のずれの分だけ違う。強弱が1枚のチャートに足すのは「8通貨の中での順位」だけ。
  - 合図: A+B の11ペア（円クロス7つとドルのペア4つ）で、A/B の A が1〜2位・B が7〜8位になった足で買い、逆で売り。その状態に入ったときに1回だけ（Q-Trend と同じ）。メールが送られる確定だけ（§8.81 の読み方）。
  - 候補は2つ: L = 6本（1日）と 30本（5日）。前半（2025-05-18 まで）で選び、後半で判定。
  - 取引: メールと同じ（確定の終値で入る、利確1 20・損切り30、5分足の Bid/Ask で追う、30本で時間切れ）。
  - 物差し e: 同じペア・同じ確定での「コイン投げ」（買いと売りの両方）の平均との差。スプレッド・ペア・時間帯の違いは打ち消し合う。効き目がなければ平均は0。
  - 判定: 後半の e の区間（週ごと・4週ごとの低い方、t 分布）の下の端が0より上なら「コイン投げよりはっきり良い」。
  - 補正の道: L6・L30 の両方の後半の e を、片側 2.5%÷2 の区間で見る（候補が2つあることへの補正）。選ばれなかった方は、その下の端が0より上のときだけ「補正の後も0より上」と告げる。
  - 作り物の強弱1,000通りに同じ選び方と判定をかけ、判定か補正の道のどちらかで 4%（1,000通り中40通り）より多く「良い」になるなら、区間が狭すぎるとして何も判定しない（作り物の強弱の関門）。
- **作り物の値動き**（実データの前。8通貨の値からペアを作るので三角の関係が保たれる新しい作り方。各 1,000 通りの作り物の強弱）:
  - 効き目なし（50回）: 判定 0回、補正の道 0回、e は +0.05（L6）・−0.05（L30）、作り物の強弱の関門 50回とも通過。すべての照合が違い0。
  - 効き目あり（上位2つを上げ、下位2つを下げる作り物。L6・L30 それぞれ10回）: 10回とも判定、11ペアすべてで e が0より上。
  - 力（効き目なしの50回で、片方の候補の e に前半・後半とも足して数えた）: 1回あたり +2 pips（L6）・+3 pips（L30）あれば、50回中40回判定される（L30 で +2 pips なら19回）。+1 pips では L6 が11回、L30 が2回。
  - わざと入れた誤り3つ（1本先の終値を読む・1本ずれで結ぶ・EUR/USD の向きを逆にする）は、どれも照合で見つかった。
- **誤り探し**（実データの前。3人の別々の見方: 先読み・統計・冒頭の決まりとプログラム）:
  - 失敗できない照合が4つあった（0 の状態の足に出た合図を見ない、SPLIT をまたぐ取引を見られない、取引を追い始める時刻と水準が自分の計算と比べるだけ）。作り直し、見直しがわざと入れた誤り4つが見つかることを確かめた。
  - ほかに、作り物の値動きのまとめ方（1,000通りの確かめ、関門の決まり）を直した。作り直した後に作り物の値動き83回をやり直し、関門はすべて通った。
- **実データで決まりを1つ変えたこと**（取引を追う前に、値段だけを見て）:
  - 1回目（run 36763362396）は、決めたとおり三角の照合で止まった（EUR/USD 39本・GBP/USD 37本が5 pips 超、決めた上限 0.1%）。
  - 2回目（run 36763749912）で外れた足を値段だけで一覧にした（一覧に出るのは、どれかのドルのペアが5 pips を超えた足だけ）。
    - 4つのドルのペアがほぼ同じ割合（終値の 1e-4 で 3.4〜6.8。日の最後の 16:00・20:00 の足は1つのペアだけ 9.1 まで）ずれる日: 2023-04-05・2024-03-27・2024-12-24・2025-04-16 は取引日まるごと（20:00〜16:00 UTC の6本。2024-12-24 は次の 20:00 も）。2025-12-24 は 12:00・16:00・20:00 の3本だけが一覧に出た（ほかの足がずれていたかは見えていない）。共通の USD/JPY がほかのクロスとずれていたことを指す（推測）。
    - EUR/USD と GBP/USD、または EUR/USD だけがずれる日（2023-04-28・2024-04-30・2025-04-30）。
    - 薄い時間の1本だけ（16:00 か 20:00 UTC。12月26・27日、7月3日、金曜の夜）。
    - 中央値は 0.07〜0.11 pips で、USD/JPY を1本ずらしたときの 1/60〜1/140。系列全体は1本ずれていない。ただし外れた足を1本ずつ、時刻のずれかどうか確かめてはいない。取引日まるごとの日は、ずれが1日じゅうほぼ同じ大きさなので（1本ずれなら足ごとに USD/JPY の値動きの分だけ変わる）、時刻のずれではないと推測している。薄い時間の1本は分からない。
  - そこで「5 pips 超の割合」だけを関門から外して告げるだけにした（中央値と1本ずらしは関門のまま）。そうした足を読む合図を除いた e も参考に出した。変えた理由は冒頭に書いて commit してから（55ce46c）、3回目を走らせた。
- **確かめたこと**（実データ、run 36764072301、commit 55ce46c）: すべて違い0。
  - 強弱の計算を、確定で切ったローソク足から別のやり方で計算し直したもの: 6,142件。
  - SPLIT までの足だけで作り直した選び方: 22,804件。
  - 4時間足の終値と5分足: 48,004件（週の最後の足などは告げるだけ: 1,727件、違い0）。
  - メールの合図とメールの関数: 8,073件。
  - §8.83 の利確20の数字の再現: 前半 −1.35（2,416回）・後半 −1.27（2,216回）が同じ。GMO の読み込みの失敗 0。
- **結果**（A+B の11ペア。判定は後半〈72週のうち、合図の取引がある71週〉。ほかの数字は、書いていなければ全期間〈144週〉）:
  - 作り物の強弱の関門: 1,000通り中 14通り（1.4%）が判定、補正の道 17通り（1.7%）。通過。
  - 前半で選ばれたのは L6（1日）。後半の e は **+0.23 pips（1回あたり、1,859回）、区間 −1.74〜+2.20**。下の端が0より下なので、**判定されなかった**（コイン投げよりはっきり良いとは言えない。良くても1回あたり +2.2 pips ほど）。作り物の強弱1,000通りの中でも真ん中あたり（610通りより上）。L30 は +0.09（区間 −1.79〜+1.97。週ごとでは −1.61〜+1.79）。
  - スプレッドを入れた損益（全期間）は、コイン投げと同じように負け: L6 の合図 1回あたり −1.66 pips（3,866回、週に約27回）、L30 −1.93 pips。どの確定でも入るコイン投げは −1.63、今のメールは −1.36（4,742回）。利確1が先に届く割合 57.7%・57.1%（損益分岐は 60%、スプレッド抜き）。後半だけでは L6 −1.29（区間 −2.74〜+0.16）、L30 −1.57（−3.49〜+0.34）、コイン投げ −1.59、今のメール −1.36（2,326回）。

  | 見たもの（参考、判定ではない） | 数字 |
  |---|---|
  | 三角のずれた足を読む合図を除いた L6 の後半の e | +0.28、ほぼ同じ（除いた合図は全期間で67回。後半で何回減ったかは出していない。全期間の e は +0.02） |
  | ペア自身の値動きの向き（M、強弱を使わない） | e +0.10（L6）・+0.44（L30。後半 +1.08、区間 −0.08〜+2.24） |
  | 順位の当たり具合（翌日の強弱との順位相関） | −0.022（L6）・−0.002（L30）、どちらも0と区別できない |
  | 120本前の強弱で同じ合図（古い強弱） | e −0.30（L6）・+0.40（L30） |
  | 下位2つに入った割合が最も高かった通貨 | 円（36%・41%） |
  | 今のメールの合図を、確定での5日の強弱で分けたとき | 強弱と同じ向き −2.95 pips、逆向き −0.82 pips（後半の差 −3.98、区間 −8.72〜+0.77） |

  - 強弱と同じ向きの合図のほうが、良くなってはいなかった（数字は、後から絞り込みを選ぶためのものではない。選ぶなら新しく測り方を決めて測る）。
- **測れていないこと**:
  - A+B の11ペアだけ。受け取っている37銘柄のうち8通貨でできている24銘柄のうち、残り13銘柄（Twelve Data のペアと #153 で足した GMO のペア）は、過去のデータがなく測っていない。
  - 4時間足以外は測っていない。
  - スワップ、すべり、メールが届いて注文するまでの時間。
  - 本番で7本の円クロスを確定のたびに読めるか（同じ時刻にそろうか）。
- **オーナーの決定**（2026-10-01）: 結果と選択肢（入れない／チャートに表示だけ／記録だけして後で測る／数字を添えてメールで送る）を示したところ、オーナーは「入れない」を選んだ。通貨の強弱は、チャートにもメールにも入れない。本番のメールとチャートは変えていない。`research/strength.ts`・`strength-lib.ts`・`strength-seeds.py` と `strength.yml` は、測定をやり直せるように残した（本番のコードからは読んでいない）。

### 8.86 通貨ペアを円のペアと金だけにした（#175）

- **指示**（2026-10-01）: 「通貨のペアを円とどれかだけにして」。確かめて決まったこと: 範囲はアプリ全体（チャート・メール・オーナーの購読。「アプリ全体」）、金は残す（「金は残す」）。
- **その後（#177、2026-10-01）**: ユーロ/ドルを戻した（チャート・Q-Trend と ULTRA のメール・RSI＋SAR と GA型。§8.88）。オーナーの購読（ユーロ/ドルの Q-Trend・ULTRA の4時間足）も登録し直した（2026-10-01 16:51 UTC）。
- **その後（#178、2026-10-02）**: 豪ドル/ドルも同じように戻した（§8.89）。オーナーの購読（豪ドル/ドルの Q-Trend・ULTRA の4時間足）も登録し直した（2026-10-02 01:22 UTC）。
- **その後（#180、2026-10-02）**: ドル/カナダドルも戻した（§8.91）。GMO にないので、#175 の前と同じく、チャートと Q-Trend・ULTRA のメール（1時間足〜日足）だけ。オーナーの購読（ドル/カナダドルの Q-Trend・ULTRA の4時間足）も登録し直した（09:31 UTC。購読は42件）。
- **残したもの**（18銘柄）: 楽天FXの円のペアのうち、ここで読める17ペアと金。並びは楽天FXのまま。
  - GMO から読む12ペア: ドル/円・ユーロ/円・ポンド/円・豪ドル/円・ペソ/円・NZドル/円・ランド/円・カナダドル/円・フラン/円・リラ/円・フォリント/円・Sクローナ/円。
  - Twelve Data（足）と Swissquote（現在値）で読む5ペア（§8.66）: 香港ドル/円・SGドル/円・Nクローネ/円・ズロチ/円・チェココルナ/円。
  - 金（§8.65 より前から）。
  - 人民元/円は、前から足の取得元が無いため無い（§8.66）。
- **外したもの**（19ペア）: ユーロ/ドル・ポンド/ドル・豪ドル/ドル・NZドル/ドル・ドル/カナダドル・ドル/スイス・ポンド/スイス・ユーロ/ポンド・ユーロ/スイス・豪ドル/スイス・NZドル/スイス・豪ドル/NZドル・ユーロ/豪ドル・ポンド/豪ドル・カナダドル/スイス・Nクローネ/Sクローナ・豪ドル/カナダドル・NZドル/カナダドル・ドル/香港ドル。
- **変えたこと**:
  - チャート（live-chart v11）: `LIVE_PAIRS` を37から18に、Twelve Data で読むペア（`TWELVE_FX_PAIRS`）を15から5にした。外したペアの足・履歴・ダウ理論は、外へ読みに行く前に `invalid_request` で断る。一覧の価格のために Swissquote を読むのは5ペアになった（1回の読みで3つずつは同じ）。
  - 画面: 同じ一覧（横一列・銘柄の一覧・全画面の一覧）。保存されていたペアが外したものなら、ドル/円で開く（時間足と表示は保存のまま）。
  - メール（signal-alerts v13）:
    - Q-Trend・ULTRA は18銘柄（チャートの一覧に従う。GMO にない6銘柄は1時間足以上のまま）。
    - RSI＋SAR・GA型（`ALERT_PAIRS`）は7ペアから4ペア（ドル/円・ユーロ/円・ポンド/円・豪ドル/円）にした。
    - 成績の記録（#108）は、この4ペアのサインだけを数える（見出しは「全4ペアのサイン」）。外した3ペア（ユーロ/ドル・ポンド/ドル・豪ドル/ドル）の未決着のサインは、もう決着させない。
  - データベース（マイグレーション `20261001053000_yen_pairs_only`）:
    - 外したペアの購読を消し、購読できるペアを18にした（制約 `signal_alert_subscriptions_pair_check`）。
    - 外したペアの保存足（`live_chart_fallback`）と、記録した価格（`live_tick_bars`）を消した。`live_tick_bars` は、そのペアの新しい価格が入ったときにしか古い行を消さないため。
  - 文言:
    - 一覧の注記、メール通知の注記（「GMOコインにない6銘柄」）、成績の見出し。
    - トップページと料金の「5通貨ペア」（#153 より前のままだった）。
    - よくある質問（どの通貨ペアか。これも #153 より前のままだった）。
    - `index.html`・`404.html` の説明。
  - 研究: 11本の測定プログラム（confirm・patterns・prewarn・qtrend-tp・stochexit・stochfree・stochgood・tf-winrate・tphold・widestop・widetp）は、チャートの一覧からペアを取っていた。これまで測った GMO の21ペアに、元の並びのまま固定した（`research/lib.ts` の `GMO_STUDY_PAIRS`）。やり直しても同じものを測る。prewarn と widetp は、そうしないと起動時のペアの確かめ（ユーロ/ドルなどが一覧に無い）で止まるところだった。
- **変えていないもの**:
  - これまでの記録（`signal_events`）と送ったメール（`signal_alerts`）は消していない。画面の成績の記録は4ペアの分だけを数える。最近の通知の一覧には、外したペアのメールもそのまま出る。
  - 各ユーザーの保存したペアと描いた線は消していない。外したペアの線は、そのペアがチャートに無いので見えない（オーナーのユーロ/ドルの線1つ）。
  - 次の4つは変えていない。
    - 分析（`analyze` の `ALLOWED_PAIRS`）。#139 から画面に無い。
    - 設定の引き出しのペア（`SettingsDrawer`）。ペアを選ぶ欄は表示されない。
    - GMO の記号の表（`GMO_SYMBOLS`）。21記号のまま。研究と記録の決着が使う。
    - ペアの名前（日本語・英語）。
  - メールとチャートの説明の測った数字（「GMO の FX」）: これまでの測定は GMO の21ペア（円以外を含む）で測った値。円のペアだけで測り直してはいない。
- **本番のデータ**（2026-10-01、読み取りで確かめた。マイグレーションの前）:
  - 購読: 74件（すべてオーナー）。外したペアは38件（Q-Trend・ULTRA の4時間足 各19）、残るのは36件（同じく各18）。
  - 未決着のサイン: 2件で、どちらも外したペア。
  - 成績の記録（`signal_events`）: 27行（すべて直近365日の中。ルールで分けずに数えた行数）。そのうち15行が外した3ペア（ユーロ/ドル6・ポンド/ドル5・豪ドル/ドル4）。画面の成績の数字は、この分減る。（最初に「32件」と書いたのは、ペアごとの数を足し間違えたもの。PR #146 の docs にはその誤りのまま入った。）
  - 外したペアの保存足は50行、記録した価格は47行。
- **確かめたこと**:
  - サーバー・画面・研究・マイグレーションの一覧が食い違わないことを、プログラムで突き合わせた。
    - サーバーと画面の18が同じ並び。
    - 研究の21が、元の一覧から Twelve Data のペアと金を除いたものと同じ並び。
    - マイグレーションの4つの一覧が、サーバーの18と同じ。
  - テストを8ファイル書き換え、次の点を足した。
    - 外した19ペアが画面にもサーバーにも無いこと。
    - 保存されていた外したペア（ユーロ/ドル）がドル/円で開くこと。
    - RSI＋SAR・GA型が4ペアで、成績と決着が4ペアに絞られること。
    - マイグレーションの一覧がサーバーと同じで、購読を消してから制約を付けること。
    - 記録と送ったメールを消さないこと。
  - 全テスト 2331件、型チェック（既存の12件のみ。main でも同じ12件）、lint（変えたファイル）、Deno の型チェック（2つの関数と研究12本）、画面のビルド。
  - 独立した確かめ（4つの観点で別々に調べ、見つかったものを別の確かめ役が検証）。
    - 漏れ・サーバーの正しさ・データベースの3つは、見つかったもの0件。
    - 切り替えの順番で1件（下の「気をつけること」）。
- **気をつけること**:
  - 関数を反映してから画面を公開するまでの間、古い画面（開いたままのタブを含む）で外したペアを押すと、「チャートを読み込めませんでした」が出たままになる。保存したペアが外したものの人が古い画面を開いた場合も同じ。外へは読みに行かないので、Twelve Data などの枠は使わない。新しい画面は古い関数でも壊れない（コードを読んで確かめた。違いは、成績の見出し「全4ペア」が古い関数の7ペアの数字に付くことだけ）。そのため、関数の反映を確かめたらすぐに画面を公開し、マイグレーションはその後にする。開いたままのタブは、読み直すまで古い画面のまま。
  - 関数の反映からマイグレーションまでの間は、外したペアの購読がまだ残る。メールは送られない（巡回が18銘柄だけを読む）が、テストメールの「登録中のチャート」には載り、その購読はオフにもできない（関数が断る）。マイグレーションで消える。
- **本番への反映**（2026-10-01、UTC）:
  1. オーナーの許可（「マージしてよい」）を得て、PR #146 をマージした（06:22）。
  2. 関数の反映（GitHub Action、06:22:06〜06:22:42）: signal-alerts（06:22:35）と live-chart（06:22:37）。Action の記録では、どちらも「変更なし」ではなく反映された。
     - signal-alerts: 06:23 の毎分の巡回から v13。読んだ購読は36件（06:22 の v12 の回は74件）。外したペアの38件は、マイグレーションの前から読んでいない。
     - live-chart: 版の文字列そのものは読んでいない（呼ぶにはログインが要る）。反映は Action の記録と関数の更新時刻で確かめた。
  3. Lovable で公開した（06:23 ごろ）。答えは pending（deployment_id 2bc72ca7-8d45-4a55-a31f-627c24770077）。反映は確かめていない。
  4. マイグレーションを当てた（台帳の 20261001062351 `yen_pairs_only`）。
     - 購読: 36件（Q-Trend・ULTRA の4時間足 各18、18銘柄）。外したペアは0件。制約は18ペア。
     - 保存足（`live_chart_fallback`）: 外したペアの行は0（残りは24行、うち金6行）。
     - 記録した価格（`live_tick_bars`）: 外したペアの行は0（残りは11行）。
     - 記録（`signal_events` 28行）と送ったメール（`signal_alerts` 327行）は、そのまま残っている。
  - 関数の反映からマイグレーションまでは約1分（06:22:37〜06:23:51）。
- **反映後に確かめたこと**:
  - 06:32 の RSI＋SAR の巡回（v13）。
    - 読んだのは円の4ペアの15分足だけ。この時刻に確定するのは15分足。
    - 購読は0件（RSI＋SAR・GA型の購読は以前から0件）。
    - 06:15 確定のドル/円の売りは、06:17 の v12 の回が記録したもの。まだ新しい間（20分）なので読み直し、同じ行を返した。新しい行は作っていない。
    - 未決着として数えたのは1件（このドル/円）。外したペアの未決着2件（ユーロ/ドル15分足 05:30 確定の買い、ポンド/ドル日足 09-30 21:00 確定の買い）は数えず、決着もさせていない。
  - 見ていないもの（ログインが要るため）: 公開後の画面、メール通知の欄、成績の記録の画面の数字。

### 8.87 Zero-lag TEMA Crosses（loxx、公開コード）をチャートに追加した（#176）

- **指示**（2026-10-01）: 「https://jp.tradingview.com/script/sjkyqVmc-Zero-lag-TEMA-Crosses-Loxx/ これ追加して」。
  - 遅い線（144本の EMA を6回重ねたもの）は、画面より前に約1,200本の足がないと TradingView の値と同じにならない。そう伝えたうえで、オーナーが選んだのは「TradingView と同じにする」。
  - 中身: オンの間は画面より前の足を深く読む。GMO のファイルを保存して2回目から速くする。足りないところ（日足、フォリント/円・Sクローナ/円など）は注記で知らせる。
- **ソース**: `pine-source.yml`（run 36867162667）で公開ソースを読んだ。`PUB;66a0ab5e21cb42f4b7c70bba09da31c2` v1.0、112行、Pine v5、Mozilla Public License 2.0、© loxx。
- **移植**（`src/lib/zlTema.ts`。既定のまま: 終値、速い22・遅い144、足の色あり、印あり）:
  - 線: `zlagtema(x, n) = TEMA(TEMA(x, n), n)`、`TEMA = 3×(EMA1 − EMA2) + EMA3`。速い線は終値の zlagtema(22)、遅い線は zlagtema(144)。元の Source の選択肢のうち、平均足などは移植していない（既定の Close だけ）。
  - 色: 速い線が遅い線より上なら、速い線とローソク足を緑（`#2DD204`）にする。それ以外（同じ値を含む）は赤（`#D2042D`）。遅い線は白（明るい背景では濃い色）。
  - 印: 速い線が遅い線を上に抜けた足に L（黄色の▲、足の下）、下に抜けた足に S（赤紫の▼、足の上）。元の `ta.crossover` / `ta.crossunder` と同じ判定で、前の足は「以下」「以上」で見る。
  - **元と違う点1（EMA の始まり）**: Pine の `ta.ema` は最初の n 本の単純平均から始まるので、遅い線の最初の値は 858本目（6×143）に出る。この移植は、どの EMA も最初の値から始める。理由は下の測定のとおり。
  - **元と違う点2**: 最初の足から、終値が初めて変わる足までは、交差を数えない。2本の線が同じ値から始まり、そこで分かれるだけだからで、Pine ではこの範囲の線に値がなく、印も出ない。
- **始まりの違いを測った**（`research/zltema-warmup.py`、作り物の値動き120通り、種 2026、4,000本）:
  - TradingView の線の代わりに、Pine と同じ計算を4,000本すべてでした線を使った。
  - この移植を「画面より前の N 本＋画面の120本」で計算し、画面の120本で比べた。

  | 画面より前の足 | 印が同じだった数 | 遅い線のずれの最大（1本の平均の値動きを1とする） | 色の違う足（120本のうち、平均と最大） |
  |---|---|---|---|
  | 0本 | 0/120 | 24.1 | 28.5（75） |
  | 300本 | 22/120 | 3.08 | 4.2（40） |
  | 500本 | 84/120 | 0.54 | 0.48（7） |
  | 600本 | 106/120 | 0.14 | 0.15（4） |
  | 800本 | 116/120 | 0.037 | 0.03（1） |
  | 1,200本 | 120/120 | 0.003 | 0（0） |

  - Pine と同じ始まり（単純平均）で同じことをすると、1,200本で 116/120、1,500本で 120/120 だった。最初の値から始める方が、少ない本数で TradingView に近づく。そのため、こちらを選んだ。
  - この結果から、画面より前が1,200本（`ZLT_SETTLE_BARS`）より少ないときは注記を出す。600本（`ZLT_ROUGH_BARS`）より少ないときは「大きくずれることがある」と書く。
  - 本物の足で、TradingView の画面と線や印を突き合わせてはいない（ここから TradingView を開けない）。
- **深い過去の読み込み**（`live-chart` v12。`history` に `deep: true`、`logic.ts` の `fetchDeepQuotes`）:
  - オンの間だけ、画面より前の確定足を1,400本（`DEEP_HISTORY_BARS`）読む。ほかのインジケーターとメールが読む本数（600本など）は変えていない。
  - GMO のペア:
    - 4時間足・日足は、年のファイルを新しい年から読む。最大8年（`DEEP_YEARS`）で、足のない年に当たったらやめる。
    - 1分足〜1時間足は、日のファイルを新しい日から読む（週末だけの日は読まない）。1,400本は、1時間足で約60営業日分（売値・買値で約120ファイル）、15分足で約15営業日分。
    - 終わったファイルは、インスタンスのメモリと `gmo_kline_files`（メールの巡回が使っている表）に保存し、2回目からはそこから読む。まだ終わっていないファイル（今日の分）は、毎回 GMO から読む。表の読み書きに失敗しても、記録するだけで読み込みは続ける。
    - GMO への要求は、インスタンスごとに0.1秒おき（1秒に最大10回）。GMO の公開 API の回数の制限は調べていない。
    - 1回の読み込みは最大20秒。時間切れや読めなかったファイルがあると、そこまでの足を「途中まで」（`complete: false`）として返す。画面は1.5秒ごとに、最大6回まで続きを頼む。最後まで読めた答えだけを10分間とっておく。
    - GMO が 404 を返すファイルは、足のないファイルとして読み進める（ふだんの読み込みと同じ扱い）。日の切り替わり前の今日のファイルなどが当たる。時間切れやサーバーのエラーは「途中まで」として扱う。
  - 金と Twelve Data の5ペア:
    - 一度に読む本数（`GOLD_BARS`）を800本から1,400本にした。Twelve Data の使用回数は本数によらず1回（Twelve Data の「Credits」の記事。2026-10-01 に `page-read.yml` の run 36868542364 で読んだ: "/time_series ... (1 credit) * (3 symbols) = 3 credits"）。
    - チャートの足と印・ほかのインジケーター・ダウ理論には、これまでと同じ最新800本（`TWELVE_CHART_BARS`）を使う。1,400本すべてを使うのは、深い過去だけ。
    - メールの関数（signal-alerts）も同じ定数で1,400本を読み、保存する。メールの合図は `anchoredStart` から判定するので変わらない。コードは同じだが、版を v14 に上げた。
  - 画面（`LiveChart`）:
    - 読み込み中は、線と印を描かない。途中までの足を読み直す間は、その足で描いたままにする。読み直しに失敗しても捨てない。
    - オフにしたとき・ペアや時間足を替えたとき・画面を離れたときは、読み込みを取り消す。読めなかったときは、次の足で読み直す。
- **読める足が足りないところ**（GMO のデータの始まりは、研究のログで確かめた）:
  - フォリント/円・Sクローナ/円: 4時間足は 2026-05-18 から、日足は 2026-01-01 からしかない。画面より前は4時間足で約460本、日足で約75本になり、「大きくずれることがある」と出る。
  - 主要なペアの日足: GMO に少なくとも 2023-01-01 からある（研究がそこから読んでいる）。それより前があるかは確かめていない。2023年からだけなら、画面より前は約850本で、「少しずれることがある」と出る。
  - それ以外（GMO の1分足〜4時間足、Twelve Data の銘柄）は、1,400本読めれば画面より前が約1,280本になり、注記は出ない。
- **画面**:
  - インジケーターの一覧の「トレンド系」に「Zero-lag TEMA 22 144」がある（既定はオフ、UT Bot の次）。無料プランでは 🔒（§8.52）。
  - ローソク足の色は、Zero-lag TEMA → UT Bot → Q-Trend → Zone Shift の順に優先する。
  - 色と印は確定した足だけで判定する。線は形成中の足にも引く（TradingView と同じ）。価格の目盛りは2本の線も入るように合わせる。
  - チャートの下の説明文: 移植であること、既定、色と印、深く読むこと、始まりの違い、画面より前の足の本数（足りないときはその旨）、過去の検証はしていないこと。
  - 表示のみで、サインの判定・メール・成績には使っていない。
- **確かめたこと**:
  - テスト:
    - `zl-tema.test.tsx`（8件）: 手で計算した値。Pine と同じ始まりで別に書いた実装との一致（作り物の値動き3つで、画面より前1,200本なら遅い線のずれが平均の値動きの1%未満、印が同じ）。前の足が少ないと違うこと。交差の判定。L と S が交互に出ること。始まりでは印を出さないこと。
    - `deep-history.test.ts`（10件）: 年・日のファイルの読み方、週末、時間切れ、読めなかったファイル、日の切り替わり前の 404、過去の日の 404、関数のコード。
    - `zl-tema-chart.test.tsx`（11件）: 一覧・線・印・色・説明文、読み込み中、本数ごとの注記、前の足がないとき、形成中の足、ロック、オフの間は読まないこと、続きを頼むこと、「読み込み中」で止まらないこと、取り消し、途中までの足の読み直し。
    - `spectra.test.tsx`: 一覧と数を直した。
  - わざと誤りを入れて、テストが見つけることを確かめた。
    - 計算: alpha、TEMA の式、「以下」と「より小さい」、TEMA を1回だけにする。
    - 読み込み: 年での打ち切り、週末、時間切れ、読めなかったファイル。
    - 確かめで見つかった点の直しは、直す前のコードでテストが失敗することを確かめた。ただし 404 の扱いは関数の入口（`index.ts`）にあり、テストからは動かせないので、コードの文字列で確かめている。
  - 全テスト 2,360件、型チェック（以前からある12件だけ）、lint、Deno の型チェック（live-chart・signal-alerts）、画面のビルド。
  - 画面: Chromium で、暗い背景・明るい背景、スマホと PC の幅で描いて見た。明るい背景で黄色の L が見えにくかったので、印に濃い縁取りを付けた。確かめで見つかった点を直したあとは、撮り直していない。
  - 独立した確かめ（2回）:
    - 1回目（5つの観点）: 重大な点が1つ見つかった。0:00 JST から GMO の 06:00 の日の切り替わりまで、1分足〜1時間足の深い読み込みが毎日失敗していた（今日のファイルの 404 を失敗として扱っていた）。小さな点は9つ: Twelve Data の6銘柄でほかのインジケーターが動く、表の保存の失敗で全体が落ちる、画面が「読み込み中」のまま止まる、取り消しがない、途中までの足を読み直さない、2本目の足の偽の L/S、注記の「少し」、コメントの数字2つ。どれも直した。退けた指摘が2つ。
    - 2回目（直した部分だけ、3つの観点）: 小さな点が5つ。うち2つは1回目の直しで入った後戻りだった（途中までの足を読み直す間に線が消える、読み直しに失敗すると捨てる）。どれも直した。退けた指摘が2つ。
- **まだ確かめていないこと**:
  - 本番で、1時間足を初めて開いてから描けるまでの時間（GMO への約120回の要求。2回目からは保存したファイルを使う）。
  - 本番の足で、TradingView の画面と線・印が同じになるか。
  - GMO の公開 API の回数の制限。
  - 冬時間の GMO の日の切り替わり（07:00 JST の可能性。`track-outcomes/quotes.ts` の `jstDayKey` のメモ）。404 を足のないファイルとして読むので、どちらでも読み進める作りにしてある。
  - 主要なペアの日足が、2023年より前まであるか。
- **反映のときに気をつけること**:
  - マージすると、関数の Action が live-chart（v12）と signal-alerts（v14）を反映する。そのあと画面を公開する。
  - 古い画面は `deep` を送らないので、新しい関数で困ることはない。新しい画面と古い関数の組み合わせでは、`deep` が無視されて、ふだんの600本（金と Twelve Data の5ペアは800本）が返る。そのときの注記は「画面より前の足が N本しか読めなかった…」になり、本数は正しく出る。
  - 金と Twelve Data の5ペアの保存足（`live_chart_fallback`）は、反映の前に読んだものが800本のままになっている。次に読み直すまで（その時間足の足が確定するまで）は、深い過去も800本で、注記が出る。
- **本番への反映**（2026-10-01、UTC）:
  1. オーナーの許可（「マージしてよい」）を得て、PR #148 をマージした（16:10:49）。
  2. 関数の反映（GitHub Action run 36890036736、16:10:53 に開始）: signal-alerts（16:11:37）と live-chart（16:11:40）。16:12 の毎分の巡回は signal-alerts-v14 で動き、応答は 200、購読は36件。live-chart の版の文字列は読んでいない（呼ぶにはログインが要る）。
  3. Lovable で公開した（16:12 ごろ）。答えは pending（deployment_id cbd0fe71-3dac-4540-ad7b-8e2a3485d9a7）。公開を頼む前に、Lovable がマージ（d20b774）を取り込んでいたことは確かめた。反映そのものは確かめていない。
  - 見ていないもの（ログインが要るため）: 公開後の画面で Zero-lag TEMA を描けるか、1時間足を初めて開いたときの時間。

### 8.88 ユーロ/ドルを戻した（#177）

- **その後（#178、2026-10-02）**: 豪ドル/ドルも同じように戻した（§8.89）。
- **その後（#180、2026-10-02）**: ドル/カナダドルも戻した（§8.91。GMO にないので、RSI＋SAR・GA型には入らない）。
- **指示**（2026-10-01）: 「ユーロドル追加して」。#175（§8.86）で外したペアの一つ。確かめて決まったこと（オーナーの選択）:
  - 範囲: チャートと Q-Trend・ULTRA のメールに加えて、RSI＋SAR・GA型にも戻す（「RSI＋SAR・GA型も戻す」）。
  - オーナーの購読: Q-Trend・ULTRA の4時間足に、ほかの18銘柄と同じく登録し直す（「登録し直す」）。
  - 順番: #176 を先に終えてから、別の PR で出す（「#176 を先に」）。
- **変えたこと**:
  - チャート（live-chart v13）: `LIVE_PAIRS` を18から19にした。場所は楽天FXの並びの元の場所（豪ドル/円の次）。GMO から読むので、1分足〜日足がある。Twelve Data の枠は使わない。
  - 画面: 同じ一覧（`src/lib/liveChart.ts` の `LIVE_FX_PAIRS`）。#175 の前にユーロ/ドルを保存していた人は、またユーロ/ドルで開く。
  - メール（signal-alerts v15）:
    - Q-Trend・ULTRA: チャートの一覧に従うので19銘柄。ユーロ/ドルは5分足〜日足を選べる。
    - RSI＋SAR・GA型（`ALERT_PAIRS`）: 4ペアから5ペアにした（ドル/円・ユーロ/ドル・ユーロ/円・ポンド/円・豪ドル/円。#175 の前の並び）。
    - 成績の記録（#108）: ユーロ/ドルのサインを再び数える（見出しは「全5ペアのサイン」）。#175 の間に決着させなかったユーロ/ドルの1件（15分足 05:30 確定の買い）も、また決着させる。
  - データベース（マイグレーション `20261001163000_eur_usd_back`）: 購読できるペアの制約を19にした。消すものはない。
  - 文言: 料金・トップページ・よくある質問・成績の見出し、`index.html`・`404.html` の説明。
- **抜けている期間**: #175 の反映（10-01 06:22 UTC）から #177 の反映（10-01 16:51 UTC。RSI＋SAR・GA型の巡回が読み始めたのは 17:02）までの間、ユーロ/ドルは読んでいない。この間のユーロ/ドルの RSI＋SAR・GA型のサインは記録されておらず、Q-Trend・ULTRA のメールも送っていない。あとから埋めることはしていない。
- **確かめたこと**:
  - テスト: 一覧と並び、GMO から読むこと、保存していたユーロ/ドルで開くこと、外れたままのペア（ポンド/ドルなど）が無いこと、2つのマイグレーションの一覧（#175 の18と、#177 の19）、RSI＋SAR・GA型の5ペア、メールの設定の数（19銘柄、5分足は GMO の13ペア）。
  - 全テスト 2,362件、型チェック（以前からある12件だけ）、lint、Deno の型チェック（live-chart・signal-alerts）。
  - 独立した確かめ（2つの観点: 漏れと、出し方・データベース・文書。見つかったものを別の確かめ役が検証）:
    - 出す順番の誤りが1つ（2つの観点が同じものを見つけた）。はじめはマイグレーションを関数と画面の後に置いていた。その順番だと、新しい関数の反映からマイグレーションまでの間、ユーロ/ドルの購読と、時間足ごとの「すべての銘柄」のオン（ユーロ/ドルを含めて一度に保存する）が失敗する。下の「出す順番」を直し、§10 にも足した。
    - 文書の小さな点が3つ。§8.86 の「その後」が、まだ登録していないオーナーの購読を「戻した」と書いていた。§8.87 のマージの時刻が Action の開始の時刻になっていた。§8.65・§8.67・§8.69 に #177 の「その後」が無かった。どれも直した。
    - 退けた指摘はない。
- **出す順番**: マイグレーション → マージ → 関数の反映（Action）→ 画面の公開 → オーナーの購読の登録。
  - マイグレーションを先にするのは、新しい関数（v15）がメール通知の設定にユーロ/ドルを出すため。制約が18ペアのままだと、ユーロ/ドルを含む購読の保存が失敗する。今の関数（v14）はユーロ/ドルを書き込む前に断るので、制約を先に広げても困ることはない。マイグレーションは、マージの許可を得てから、マージの直前に当てる。
  - 関数を画面より先にするのは、新しい画面と古い関数の組み合わせだと、古い関数がユーロ/ドルを断り、ユーロ/ドルのチャートだけ読めなくなるため。
- **本番への反映**（2026-10-01、UTC。上の「出す順番」のとおり）:
  1. オーナーの許可（「マージしてよい」）を得て、マイグレーション `eur_usd_back` を当てた（16:50:27。台帳の版は当てた時刻の 20261001165027）。当てる前に、関数が #176 のとき（16:11）のままであることを確かめた。当てた後、制約は19ペアになり、購読は36件のままだった。
  2. PR #149 をマージした（16:50:39）。
  3. 関数の反映（GitHub Action run 36895016979、16:50:42 に開始、成功）: signal-alerts（16:51:16）と live-chart（16:51:19）。16:52 からの毎分の巡回は signal-alerts-v15 で動き、応答は 200、購読は38件。live-chart の版の文字列は読んでいない（呼ぶにはログインが要る）。
  4. Lovable で公開した（16:51 ごろ）。答えは pending（deployment_id c4f66a48-052f-4f26-9f7d-7e1677db7623）。公開を頼む前に、Lovable がマージ（1c1a048）を取り込んでいたこと（16:50:47）は確かめた。反映そのものは確かめていない。
  5. オーナーの購読: ユーロ/ドルの Q-Trend・ULTRA の4時間足（日本語）を登録した（16:51:59）。購読は38件（19銘柄 × 2種類、すべてオーナーのもの）になった。
  6. 17:02 の RSI＋SAR・GA型の巡回（signal-alerts-v15、応答 200）: 5ペア × 4つの時間足の20を読み、ユーロ/ドルも15分足・1時間足・4時間足・日足を読んだ（どれも200本、新しいサインなし）。#175 の間に決着させなかったユーロ/ドルの1件（GA型 15分足、05:15 の足の買い）は、この回で「負け」と決着した（17:02:00）。値動きの順番は、こちらでは確かめていない（GMO の API はこの作業の環境から読めない）。未決着は、引き続き数えないポンド/ドルの日足1件だけ。
  - 見ていないもの（ログインが要るため）: 公開後の画面でユーロ/ドルのチャートを開けるか、メール通知の設定にユーロ/ドルが出るか。
  - ユーロ/ドルの4時間足の Q-Trend・ULTRA の最初の判定は、次の GMO の4時間足の確定（20:00 UTC）の後になる。まだ見ていない。

### 8.89 豪ドル/ドルを戻した（#178）

- **その後（#180、2026-10-02）**: ドル/カナダドルも戻した（§8.91）。
- **指示**（2026-10-02）: 「豪ドル/ドル、追加して」。#175（§8.86）で外したペアの一つ。範囲は、#177（§8.88）でユーロ/ドルを戻したときのオーナーの選択と同じにした（今回はオーナーに聞き直さず、最初の連絡で伝えた）:
  - チャートと Q-Trend・ULTRA のメールに加えて、RSI＋SAR・GA型にも戻す。
  - オーナーの購読: Q-Trend・ULTRA の4時間足に、ほかの19銘柄と同じく登録し直す。#175 の前は、この購読からオーナーに豪ドル/ドルの4時間足のメールが5通届いていた（9-29〜10-01、Q-Trend 1通・ULTRA 4通。本番の送信の記録で確かめた）。
- **変えたこと**:
  - チャート（live-chart v14）: `LIVE_PAIRS` を19から20にした。場所は楽天FXの並びの元の場所（ユーロ/ドルの次。#175 の前は、間にポンド/ドルがあった）。GMO から読むので、1分足〜日足がある。Twelve Data の枠は使わない。
  - 画面: 同じ一覧（`src/lib/liveChart.ts` の `LIVE_FX_PAIRS`）。#175 の前に豪ドル/ドルを保存したままの人は、また豪ドル/ドルで開く（#175 の間にペア・時間足・表示のどれかを選んだ人は、ドル/円が保存し直されている）。
  - メール（signal-alerts v16）:
    - Q-Trend・ULTRA: チャートの一覧に従うので20銘柄。豪ドル/ドルは5分足〜日足を選べる。
    - RSI＋SAR・GA型（`ALERT_PAIRS`）: 5ペアから6ペアにした（ドル/円・ユーロ/ドル・ユーロ/円・ポンド/円・豪ドル/ドル・豪ドル/円。#175 の前の並びからポンド/ドルを除いたもの）。
    - 成績の記録（#108）: 豪ドル/ドルのサインを再び数える（見出しは「全6ペアのサイン」）。#175 の前の豪ドル/ドルの記録は4件で、どれも決着している（本番を読んで確かめた。未決着は無い）。画面の成績に戻るのは、今の設定の1件（GA型 15分足、09-29 06:15 確定の買い、負け −1.03R）だけ。ほかの3件は前の GA型の設定（`gainz_v2a_050_50_5_atr1_v1`）のもので、成績は今の設定の行だけを数える（`signal-alerts/index.ts` の `ofRule`、#132 から）。
  - データベース（マイグレーション `20261002010000_aud_usd_back`）: 購読できるペアの制約を20にした。消すものはない。
  - 文言: 料金・トップページ・よくある質問・成績の見出し、`index.html`・`404.html`。
- **抜けている期間**: #175 の反映（10-01 06:22 UTC）から #178 の反映（10-02 01:21 UTC。RSI＋SAR・GA型の巡回が読み始めたのは 01:32）までの間、豪ドル/ドルは読んでいない。この間の豪ドル/ドルの RSI＋SAR・GA型のサインは記録されておらず、Q-Trend・ULTRA のメールも送っていない。あとから埋めることはしていない。
- **確かめたこと**:
  - テスト: 一覧と並び、GMO から読むこと、保存していた豪ドル/ドルで開くこと、外れたままのペア（ポンド/ドルなど）が無いこと、3つのマイグレーションの一覧（#175 の18、#177 の19、#178 の20）、RSI＋SAR・GA型の6ペア、メールの設定の数（20銘柄、5分足は GMO の14ペア）。
  - 全テスト 2,364件、型チェック（以前からある12件だけ）、lint（変えたファイル）、Deno の型チェック（live-chart・signal-alerts）、画面のビルド。
  - 独立した確かめ（3つの観点: 漏れ、豪ドル/ドルの動き（メールの文面・画面・深い過去を含む）、データベース・出す順番・文書。見つかったものを2つの見方で反証）: 本当の問題は0件。報告は1件で、「記録4件のうち画面の成績に戻るのは1件」を書いていない点（文は本当なので欠陥ではないと判定）。読み手のために上に書き足した。
- **出す順番**: マイグレーション → マージ → 関数の反映（Action）→ 画面の公開 → オーナーの購読の登録（§10 の「増やすとき」、§8.88 と同じ）。マージはオーナーに聞かずに進める（CLAUDE.md、2026-10-01 のオーナーの指示「マージまで勝手に進めて」）。
- **本番への反映**（2026-10-02、UTC。上の「出す順番」のとおり）:
  1. マイグレーション `aud_usd_back` を当てた（01:19:58。台帳の版は当てた時刻の 20261002011958）。当てる前に、毎分の巡回がまだ signal-alerts-v15・購読38件であることを確かめた。当てた後、制約は20ペアになり、購読は38件のままだった。
  2. PR #151 をマージした（01:20:29。CLAUDE.md のとおり、オーナーに聞かずに）。
  3. 関数の反映（GitHub Action run 36950466281、01:20:32 に開始、成功）: signal-alerts（01:21:04）と live-chart（01:21:10）。01:22 からの毎分の巡回は signal-alerts-v16 で動き、応答は 200、購読は40件。live-chart の版の文字列は読んでいない（呼ぶにはログインが要る）。
  4. Lovable で公開した（01:21 ごろ）。答えは pending（deployment_id 8faf871d-de8e-4c12-a54d-29d796003381）。公開を頼む前に、Lovable がマージ（55bcb97）を取り込んでいたこと（01:20:36）は確かめた。反映そのものは確かめていない。
  5. オーナーの購読: 豪ドル/ドルの Q-Trend・ULTRA の4時間足（日本語）を登録した（01:22:01）。購読は40件（20銘柄 × 2種類、すべてオーナーのもの）になった。
  6. 01:32 の RSI＋SAR・GA型の巡回（signal-alerts-v16、応答 200）: この回は15分足だけで、6ペアを読み、豪ドル/ドルも200本を読んだ（新しいサインなし、記録0・決着0）。1時間足・4時間足・日足で豪ドル/ドルを読む回は、まだ見ていない。
  - 見ていないもの（ログインが要るため）: 公開後の画面で豪ドル/ドルのチャートを開けるか、メール通知の設定に豪ドル/ドルが出るか。
  - 豪ドル/ドルの4時間足の Q-Trend・ULTRA の最初の判定は、次の GMO の4時間足の確定（04:00 UTC）の後になる。まだ見ていない。

### 8.90 チャートのダウの表示が当たる割合を測る（#179、研究のみ）

- **指示**（2026-10-02）: チャートのダウの1行（例「ダウ 4H 下降 · 1H 下降 · 15M 上昇の兆し · 5M 上昇」）の画面に「赤丸のダウの予想の的中率は？」。§8.43（#130）の記録から、表示の向きに入った場合の当たり（損切りと利確を同じ ATR の幅にした場合、スプレッド込み）が約43〜50%で、ランダムに入った場合とほぼ同じだと答えた。そのうえで、次の3つを伝えた。
  - §8.43 の数字は出来事の足（更新・1回目・確定）で入った場合だけ。
  - 山と谷の幅が今と違う（左右5本。今は #132 から4本）。
  - 5分足は測っていない。
  オーナー「はかります」。表示が出ている間の当たりを、今の表示と同じ作りで測る。
- **測り方**（データを見る前に決めた。案を3つの見方（統計・チャートとの一致・作りの落とし穴）で独立に見直し、指摘を入れて固めた。`research/dow-hit.ts`）:
  - **対象**: 今チャートに出している GMO の14ペア（円の12ペア・ユーロ/ドル・豪ドル/ドル）。GMO にない5ペアと金は測らない。時間足は表示と同じ5分・15分・1時間・4時間。期間は 2024-01-01 から、走らせた時点の最後の確定足まで。前半（〜2025-06-30）と後半（2025-07-01〜）に分ける（§8.43 と同じ区切り）。
    - フォリント/円・Sクローナ/円は GMO のデータが 2026-05 からしかないので、判定は両期間にデータがある12ペアで行い、2ペアは別に出す。
    - 左右4本（`DOW_PIVOT`）は前半で選んだ数字（§8.45）なので、前半は表示に有利な向きに選ばれた期間だと書き添える。
  - **表示の再現**: 各時間足の確定足ごとに、その足までの確定足300本（チャートの `DOW_BARS`。`fetchDowQuotes` と同じ読み方で、丸めない中値）で `_shared/dow.ts` の `dowTheory` を計算し、最後の足の状態をその足の表示とする。上昇・上昇の兆しは上を、下降・下降の兆しは下を予想したとみる。判定なしは数えず、出ていた割合だけを出す。300本そろわない足は数えない。
    - チャートと同じになるかを、チャートの関数そのもので照らす。保存した GMO のファイルを返す偽の読み込みで、ペア×時間足ごとに約300本を選び、`fetchDowQuotes` → `splitBars` → `dowOf` の状態と比べる。月曜の始まり・年明け・夏時間の切り替わりも含める。食い違いは0件であることを、本番の数字を読む前の条件にする。
  - **いつ数えるか**（主）: 5分足の確定ごと（チャートの1行が変わりうる時刻ごと）に、各時間足の「その時刻までに確定した最後の足の表示」（足の始まり＋長さ ≦ その時刻）を、その時に出ている表示として数える。オーナーが表示を見ている時間に比例して数えることになる。
    - あわせて、表示が変わった直後だけ（新しい表示が出た最初の5分）も出す。チャートに出るのは確定の0〜約90秒後なので（画面は60秒ごとに読み直す）、確定の値段で入る数字は上限とし、次の5分足の終値で入った場合も並べる。
  - **当たりの数え方**（どれもその時刻の5分足の終値から、5分足で追う）:
    1. **先に届いた方**（主。中値、スプレッドなし）: その時刻の中値から上下に、その時間足の ATR(14)（Wilder、最後の確定足まで）の幅を取る。予想の向きに先に届いたら当たり、逆なら外れ。同じ5分足で両方に届いたら 0.5 と数え、件数を出す。その時間足の48本ぶんの時間（市場が開いている5分足の本数）で、どちらにも届かなければ数えない（割合を出す）。
    2. **12本後の向き**（中値）: その時間足の12本ぶんあとの5分足の終値が、予想の向きに動いていたか。同じ値は 0.5。
    3. **売買した場合**（スプレッド込み）: 予想の向きに、買いは売値・売りは買値で入る。損切りと利確はどちらも ATR×1。5分足の bid/ask で追う（両方に届いた足は損切り、値を飛び越えて始まった足は始値で約定）。48本ぶんで決まらなければ最後の値で決済する。勝率（決着したものの中）と1回あたりの損益（ATR を1とした R）。これは当たりの別の証拠ではなく、1回あたりの損益を出すためのもの。スプレッドの広いペアに引っぱられるので、3つのまとまり（円の主要ペアとドルのペア・リラ/ランド/ペソ・フォリント/クローナ）に分けても出し、ペア×時間足ごとのスプレッド÷ATR も出す。
  - **ランダムとの比べ方**: 同じペア・時間足・期間・向き・UTC の時刻で、表示と関係なくすべての5分足の確定で入った場合の当たりを出す。表示のそれぞれの数に、その区分の率を当てはめた値を「ランダムなら」とし、その差（lift）を出す。
  - **95%の幅**: 確定した週ごとにまとめる（14ペア共通の週）。ランダムの率を見積もる誤差も入れる（影響関数で計算する）。4時間足は、48本が2週にまたがるので、4週ごとのまとまりも出し、広い方を使う。
  - **効果がないときの物差し**: 効果のない作り物の値動き（14ペアの連動・値動きの大きさの変化・週末あり）を本番と同じ手順で20通り通す。時間足×表示ごとに、効果がないときの差の平均と、幅が0をまたがない割合（約5%のはず）を出す。差の平均が0から外れていれば、それを0の位置とする。割合が大きく外れる時間足は、作り物での差のばらつきを幅に使う。
  - **判定の決まり**（順位は付けない）:
    - 「予測力がある」と言うのは、24の組（4つの表示 × 4つの時間足、と「4つそろった」上昇・下降 × 4つの時間足）のそれぞれで、1（先に届いた方）の差が、前半・後半の両方で95%の幅ごと0の位置より上のときだけ。12ペアで判定する。
    - 「勝てる」と言うのは、3（売買した場合）の1回あたりの損益そのものが、両期間とも95%の幅ごと0より上のときだけ。
    - 時間足ごとに「見つけられる最小の差」（幅の約2倍）も書き、誤差の範囲を「効果なし」とは書かない。両期間とも有意にマイナスなら「逆に外れやすい」と書くが、逆に使うことはしない（§8.43 と同じ）。
    - どこかの組の当たりが65%以上になったら、報告の前に先読みがないかを調べる（CLAUDE.md の決まり）。
  - **4つそろった**: 5分足の確定ごとに、4つの時間足の表示がすべて上昇（またはすべて下降。兆しは入れない）なら「そろった」。各時間足の ATR と48本で、上と同じように数える。そろっている間の5分ごとと、そろった最初の5分を出す。
  - **説明用**（判定には使わない。データを見る前にこれだけに決めた）:
    - 各時間足の表示を、1つ上の時間足のトレンドと同じ向きか違う向きかで分けたもの。
    - オーナーの画面のような食い違った形: 4H と 1H が同じ向きのトレンドで、15M と 5M がその逆の向き（トレンドか兆し）のとき、4H・1H の向きを1時間足の幅で数えたもの。
    - 表示が出てからの本数（0本・1〜3本・4〜12本・13本以上）ごとの差。
  - **外すもの**（数は出す）: 次の5分足が30分以上あと（週末など）の時刻。ATR が値の刻みの4倍より小さい足。市場が開いているはずなのに30分以上足がない所を、300本の窓か追いかける範囲にふくむもの。追いかける範囲がデータの終わりを越えるもの。
  - **データ**: GMO の bid/ask の足（5分・15分・1時間は日のファイル、4時間は年のファイル。チャートと同じ）。保存したファイルは使うが、直近10日は必ず取り直し、平日の日のファイルが途中までなら取り直す。読み込んだあと、結果を読む前に、ペア×時間足ごとの穴と読めなかった数を出す。
  - **先に作り物で確かめること**（実データを読む前）:
    - ランダムウォーク（効果なし）で、どの表示も差が0の位置のまわりに収まること（上の20通り）。
    - トレンドが続く値動きで、上昇・下降の表示の差がプラスに出ること。平均に戻る値動きでマイナスに出ること。
    - 答えを知っているラベル（その先の動き）でほぼ100%になること。わざと1本先を見たダウの表示で、どれくらい差が出るか（先読みの物差し）。
    - 後の足を書き換えても、その時刻の表示と ATR が変わらないこと。その時刻より前の5分足を書き換えても、結果が変わらないこと。
  - **プログラムを書きながら決めたこと**（実データを読む前。`research/dow-hit.ts` の頭にも書いた）:
    - 「次の5分足の終値で入った場合」は、その終値を中心に同じ ATR の幅を取り、その次の足から追う（そこで入った人が出会う値動き）。
    - 14ペアのほとんど（データのあるペアの8割以上）で同時に足がない時刻は、GMO 自身が止まっていた時間（休日や配信の停止）とみる。そのときはチャートにも足がなかったので「穴」とは数えない。穴として外すのは、1つのペアだけに足がない所。止まっていた日付は結果の前に出す。
    - 「割合が大きく外れる」は、作り物で幅が0をまたがない割合が、その時間足で10%（ふつうの5%の2倍）を超えたとき。そのときは、その時間足の幅に、作り物での差のばらつきと自分の幅の広い方を使う。0の位置の誤差（ばらつき÷√20）はいつも足す。
    - 値の刻みは、データの値の小数の桁数から読む（作り物ではチャートの桁数）。
    - 先読みの物差しとして、答えを知っているラベル（先に届いた方。ほぼ100%になるはず）と、1本先のダウの表示を、判定の横に出す。
  - **作り物での確かめ**（2026-10-02、手元。2ペア×半年の短い期間）:
    - チャートの関数（`fetchDowQuotes` → `splitBars` → `dowOf`）との照合: 効果なし・トレンドが続く・平均に戻るの3つで、計5,227か所（照らす数の設定は、効果なしが100、ほかの2つが50）、食い違い0件。
    - 後の足を書き換える／前の足を書き換える確かめ: どちらも動いたもの0件。
    - 答えを知っているラベル: 4つの時間足すべてで100%。
    - 1本先のダウの表示がふつうの表示より高くなる分（先読み1本ぶんの上乗せ）: 効果なしの値動き6通りの平均で、5分足 +1.2、15分足 +0.8、1時間足 +0.65、4時間足 +0.7ポイント（4時間足は −0.02〜+1.64 とばらつく）。最初に「4時間足で約+4〜11ポイント」と書いたのは、1通りの短い作り物での1本先の表示の差そのもので、ふつうの表示もほぼ同じだけ（+3.7〜+9.8）偶然に出ていた。先読みの大きさではない。
    - 効果なし: 差は0のまわり（例: 5分足の上昇 +0.07ポイント、95%の幅 −0.95〜+1.09）。ただし、この短い期間では幅が狭すぎる（見直し役が短い作り物を20通り流したところ、幅が0をまたがない割合は約11%）。0の位置と幅は、実データと同じ長さで Actions で流す20通りで決める。
    - トレンドが続く値動き: 上昇・下降の差がプラス（例: 1時間足の上昇 +10.7ポイント、下降 +10.9ポイント）。
    - 平均に戻る値動き: 差がマイナス（例: 5分足の上昇 −5.1ポイント、下降 −7.2ポイント）。
  - **プログラムの独立した見直し**（2026-10-02、実データを読む前。3つの観点: チャートとの一致、先読みと当たりの数え方、統計・判定・Actions。見つかったものを別の確かめ役が反証で確かめた）:
    - 数字や判定を変える誤りは0件。
      - チャートとの一致の見直し役は、GMO に似せたファイル（休日の休み、1ペアだけの欠け、取引日で分けた日のファイル、夏時間の切り替わり）を作り、5分ごとのすべての時刻で照らして、約77,000か所で食い違い0件だった。
      - 統計の見直し役は、影響関数の幅と差を Python で別に計算し直し、プログラムと6桁まで一致した。
    - 本当と確かめられた小さな点が3つあり、直した。
      - データの終わり（END）の時点で形成中の足は、ここの足には入らないが、END の後に読んだファイルには入っている。そのため最後のいくつかの時刻で、チャートとの照合が本当ではない食い違いを出しうる。そこは当たりを数えない時刻（追いかける範囲がデータを越える）なので、照合も、足がすべて END までに確定した時刻だけで行う。
      - 上の「1本先のダウの表示」の書き方（直した）。
      - §8.90 で出すと決めた「時間足×表示ごとの、効果なしで幅が0をまたがない割合」を出していなかった。時間足ごとの割合に加えて、表示ごとにも出す。10%の決まりは時間足ごとのまま。
    - 本当ではないと判定されたが、分かりやすくしたもの:
      - 65%以上の一覧は、100件未満の組も含めてすべて出し、100件未満には印を付ける（効果なしでも、小さな組は偶然に65%を超える）。
      - 途中で保存された日のファイルは、30分以上の穴の隣にあるときだけ読み直す。最後の30分より短い切れは見つけられない。ただし直近10日は必ず読み直す。
  - **実データでの結果**（GitHub Actions の run 36983279241、2026-10-02 08:18〜08:30 UTC、コミット 9d2a681。データの終わりは 2026-10-02 00:00 UTC）:
    - **先に確かめたデータ**（結果を読む前に読んだ）:
      - 読めなかったファイル: 14ペアとも0。説明のつかない穴: 14ペア×4つの時間足すべてで0。
      - GMO 自身が止まっていたとみなした日: 12月25日と1月1日（と、その前日の早じまい）、2025-09-08 の約1時間（全ペア同時）。どれも休日かメンテナンス。
      - チャートとの照合: 実データで 49,785か所、食い違い0件。効果なしの作り物20通りでも各 50,099か所、食い違い0件。先読みの確かめ（後の足・前の足の書き換え）も20通りすべてで動いたもの0件。
      - 外れたもの: 次の足が30分以上あと（週末など）が149か所。ATR が値の刻みの4倍より小さいもの（リラ/円の5分足は 203,889 のうち 187,450、ペソ/円の5分足は 92,871、ランド/円の5分足は 50,737）。フォリント/円は値が約0.43円で刻みが0.001なので、ほぼすべてがこれで外れた（4時間足の707か所だけが残った）。Sクローナ/円はデータが 2026-05 からで、300本そろわない時刻が外れた。
      - 効果なしの作り物20通りで、24の組の幅が0をまたがなかった割合: 5分足 5.0%、15分足 6.3%、1時間足 10.0%、4時間足 6.7%。10%を超えた時間足はないので、幅は実データ自身の幅を使った。0の位置は、どれも0から1ポイント以内だった。
    - **判定**（12ペア。決めておいた決まりのとおり）:
      - 「予測力がある」: 24の組のうち0。
      - 「勝てる」: 24の組のうち0。
      - 「逆に外れやすい」（両期間とも有意にマイナス）: 5分足の上昇の1つだけ（差は前半 −0.48、後半 −0.72ポイント）。決まりどおり、逆に使うことはしない。差はスプレッドよりずっと小さい。
      - 見つけられる最小の差（幅の約2倍）: 5分足 約1.1、15分足 約1.8、1時間足 約3.7、4時間足 約7.2ポイント。4時間足はこれより小さい効果があるかどうかは言えない。
    - **先に届いた方（ATR の幅、中値、スプレッドなし）の当たり**（12ペア、5分ごとに数えた。前半 / 後半。カッコはランダムに入った場合）:
      - 5分足: 上昇 50.0% / 50.0%（50.5 / 50.7）、下降 49.4 / 48.5（49.5 / 49.3）、上昇の兆し 50.8 / 50.4（50.5 / 50.6）、下降の兆し 49.1 / 49.0（49.6 / 49.3）、4つそろった上昇 50.2 / 49.6（50.5 / 50.8）、4つそろった下降 49.7 / 49.5（49.5 / 49.5）。
      - 15分足: 上昇 49.8 / 50.2（50.6 / 50.7）、下降 49.1 / 48.9（49.4 / 49.4）、上昇の兆し 50.6 / 50.4（50.6 / 50.6）、下降の兆し 48.5 / 49.1（49.3 / 49.3）、そろった上昇 50.1 / 49.5（50.5 / 50.8）、そろった下降 48.8 / 49.2（49.4 / 49.5）。
      - 1時間足: 上昇 50.6 / 50.8（50.9 / 51.3）、下降 48.7 / 48.0（49.2 / 49.0）、上昇の兆し 50.7 / 51.4（50.8 / 51.2）、下降の兆し 49.4 / 49.3（49.2 / 48.6）、そろった上昇 50.6 / 50.4（50.8 / 51.3）、そろった下降 49.9 / 49.0（49.2 / 49.1）。
      - 4時間足: 上昇 51.7 / 49.0（50.7 / 51.6）、下降 50.3 / 45.5（49.7 / 49.0）、上昇の兆し 50.2 / 48.4（50.4 / 51.2）、下降の兆し 49.9 / 45.9（49.2 / 48.4）、そろった上昇 49.5 / 50.7（50.7 / 51.7）、そろった下降 51.2 / 45.0（49.5 / 49.3）。
      - 12本後の向きでも同じで、ランダムとの差はどれも小さく、4時間足の後半はむしろ低い。
    - **売買した場合**（スプレッド込み、損切り・利確とも ATR×1。勝率は決着したものの中、1回あたりの損益は ATR を1とした R）:
      - 12ペア: 5分足 勝率 30〜35%・1回あたり −0.61〜−0.70R、15分足 30〜34%・−0.42〜−0.61R、1時間足 36〜39%・−0.28〜−0.38R、4時間足 35〜46%・−0.09〜−0.35R。どの組もマイナス。
      - 円の主要ペアとドルのペア（9ペア、全期間）: 5分足 −0.49〜−0.58R、15分足 −0.26〜−0.32R、1時間足 −0.11〜−0.14R、4時間足 −0.03〜−0.10R。
      - リラ/ランド/ペソ: 5分足 −1.4〜−1.6R、4時間足 −0.40〜−0.63R（スプレッドが ATR の 0.15〜3.9倍）。
      - 損が短い時間足ほど大きいのは、スプレッドが ATR に占める割合が大きいため（主要ペアのスプレッド÷ATR は、5分足 0.42〜0.69、4時間足 0.04〜0.08）。
    - **オーナーの画面の形**（4H・1H が同じ向き、15M・5M がその逆。1時間足の幅で 4H・1H の向きに数えた）: 4H・1H が下降の形（オーナーの画面と同じ）は 86,007か所で当たり 50.1%（ランダム 49.0%）、差 +1.1ポイント（95%の幅 −1.5〜+3.7）。前半 +3.3、後半 −2.1 と食い違う。売買すると1回あたり −0.37R。4H・1H が上昇の形は 49.7%（ランダム 51.2%）。
    - **表示が変わった直後**（最初の5分）は、ふつうより良くない（5分足で差 −1.3〜−3.2ポイント）。5分遅れて入っても同じ。上位の時間足と同じ向きか、表示が出てからの本数で分けても、はっきりした差はない。
    - **先読みの物差し**: 答えを知っているラベルは4つの時間足すべてで100%。1本先のダウの表示は、ふつうの表示より 5分足 +0.87〜+1.08、15分足 +0.58〜+0.74、1時間足 +0.46〜+0.64、4時間足 +0.28〜+0.56ポイント高いだけ（4つの表示の範囲）。
    - **65%以上の確かめ**（CLAUDE.md の決まり）: 当たりが65%以上の組は48あり、すべてフォリント/円・Sクローナ/円のまとまりの説明用の組だった（データが約4か月半。例: 4時間足の「下降になって1〜3本」の12本後の向き 100%、144か所）。144か所は4時間足3本ぶんの5分足で、1回の出来事にあたる。同じ2ペア・同じ期間の効果なしの作り物8通りでも、すべてで65〜100%の組が出た（100件以上の組だけで各8〜39）。チャートとの照合も食い違い0件で、先読みではなく、出来事が少ないための偶然と判断した。
    - **まとめ**: チャートのダウの1行は、出ている間に入っても、ランダムに入った場合と当たりはほぼ同じ（約48〜52%）。スプレッドを払うと、どの時間足・どの表示でも1回あたりマイナス。§8.43（#130、出来事の足で入った場合）と同じ結論。
  - **画面の説明文は変えていない**: チャートのダウ理論の説明は、#132 の測定（確定で入った場合、損切り ATR×1・利確2倍）を書いており、間違いではない。今回の結果を足すかどうかはオーナーに伺う。→ オーナー「2書き足して」。#183 で、#182 のあとに測り直した数字で書き足した（§8.94）。

### 8.91 ドル/カナダドルを戻した（#180）

- **指示**（2026-10-02）: 「ドルカナダドルも追加して」。#175（§8.86）で外したペアの一つ。決めたこと（オーナーに最初の連絡で伝えた）:
  - 順番: 途中だった #179（§8.90）を終えてから始めた（CLAUDE.md の「一つずつ終わらせてから次に進む」）。
  - 範囲: #175 の前と同じ形で戻す。ドル/カナダドルは GMO にないので、金と同じ仕組み（足は Twelve Data、動く価格は Swissquote。§8.66）で読む。チャートと、Q-Trend・ULTRA のメール（GMO にない銘柄なので1時間足〜日足）。
  - RSI＋SAR・GA型には入れない。このメールは GMO の足しか読まない作りで、ドル/カナダドルは #175 の前から対象外だった。入れるには、このメールで Twelve Data の足を読む部分を新しく作る必要がある（オーナーに伝えた）。
  - オーナーの購読: ユーロ/ドル・豪ドル/ドルと同じく、Q-Trend・ULTRA の4時間足に登録し直す。
- **変えたこと**:
  - チャート（live-chart v15）: `LIVE_PAIRS` を20から21にした。場所は楽天FXの並びの元の場所（リラ/円の次、香港ドル/円の前。#175 の前は、間に NZドル/ドルがあった）。金と同じ仕組みで読むペア（`TWELVE_FX_PAIRS`）を5から6にした（先頭。#154 のときと同じ）。一覧の価格のために Swissquote を読むのも6ペア（1回の読みで3つずつは同じ）。
  - 画面: 同じ一覧（`src/lib/liveChart.ts` の `LIVE_FX_PAIRS`・`TWELVE_FX_PAIRS`）。#175 の前にドル/カナダドルを保存したままの人は、またドル/カナダドルで開く。
  - メール（signal-alerts v17。中身は版の文字列だけ）: Q-Trend・ULTRA はチャートの一覧に従うので21銘柄。ドル/カナダドルは1時間足・4時間足・日足を選べる。RSI＋SAR・GA型（`ALERT_PAIRS`）は6ペアのまま。
  - データベース（マイグレーション `20261002090000_usd_cad_back`）: 購読できるペアの制約を21にした。消すものはない。
  - 文言: 一覧の注記（GMOコインにない6ペア）、メール通知の注記（GMOコインにない7銘柄）、料金・トップページ・よくある質問、`index.html`・`404.html`。
- **Twelve Data の読み込み**: 1日800回を金とほかのペアで分け合う（§8.66。上限は時間足ごとに 1分足450・5分足600・その他720、メールは780まで）。#175 の前はこの仕組みで15ペアを読んでいて、今は6ペア。チャートでドル/カナダドルを開いている間と、購読した足が確定したときに読む。オーナーの4時間足の購読では、4時間足が確定するたびに1回から数回（確定の直後に新しい足がまだ無ければ、数分の間に読み直す。チャートが先に読んでいれば、その保存足を使う）。メールの巡回は1回に3つまで読むので、4時間足の確定のときに読む GMO にない銘柄は7つになり、3分ほどで読み終わる。
- **本番のデータ**（2026-10-02、読み取りで確かめた。反映の前）:
  - 制約は20ペア。購読は40件（すべてオーナー、Q-Trend・ULTRA の4時間足 各20）。ドル/カナダドルの購読は0。
  - ドル/カナダドルの保存足（`live_chart_fallback`）・記録した価格（`live_tick_bars`）・記録（`signal_events`）は0行（保存足と価格は #175 のマイグレーションで消した）。送ったメール（`signal_alerts`）は3件（#175 の前のもの）が残っている。
- **抜けている期間**: #175 の反映（10-01 06:22 UTC）から今回の反映までの間、ドル/カナダドルは読んでいない。この間の Q-Trend・ULTRA のメールは送っていない。あとから埋めることはしない。
- **確かめたこと**:
  - テスト: 一覧と並び（21銘柄、金と同じ仕組みで読む6ペア、先頭がドル/カナダドル）、Twelve Data と Swissquote をペアの記号で読むこと、表示中のドル/カナダドルの価格を毎回頼むこと、保存していたドル/カナダドルで開くこと、外れたままのペア（ドル/スイスなど）が無いこと、4つのマイグレーションの一覧（#175 の18、#177 の19、#178 の20、#180 の21）、メールの設定（21銘柄、ドル/カナダドルは1時間足から、5分足は GMO の14ペア、1時間足の「すべての銘柄」は21）。
  - 全テスト 2,366件、型チェック（以前からある12件だけ。main でも同じ12件）、lint（変えたファイル）、Deno の型チェック（live-chart・signal-alerts）、画面のビルド。
- **出す順番**: マイグレーション → マージ → 関数の反映（Action）→ 画面の公開 → オーナーの購読の登録（§10 の「増やすとき」、§8.88・§8.89 と同じ）。
  - オーナーの購読を入れる時刻に気をつける（独立した確かめで見つかった点）。#175 でドル/カナダドルの保存足（`live_chart_fallback`）を消したため、メールの巡回は最初、ドル/カナダドルの4時間足の区切りを知らない。保存足が無いと区切りを0時（00/04/08…時）と決めるが、Twelve Data の4時間足は 01/05/09/13/17/21 時 UTC に確定する。そのため、購読をその確定の前後30分（例 12:30〜13:30 UTC）に入れると、その確定が判定されず、その足の Q-Trend・ULTRA のメールが送られない（次の確定からは、読んだ足から区切りを覚えて正しく動く）。それ以外の時刻に入れれば抜けない。コード（`signal-alerts/index.ts` の、保存足が無いときの区切り）は #155 からのもので、今回は変えず、購読を入れる時刻で避ける。
- **独立した確かめ**（3つの観点: 漏れ、Twelve Data のペアとしての動きと読み込みの上限、データベース・出す順番・文書。見つかったものを別の確かめ役が反証で確かめた）:
  - 漏れ: 0件。#175 が Twelve Data のペアのために変えた所は、すべてドル/カナダドルの分を戻してあった。
  - Twelve Data のペアとしての動き: 記号の対応表は無く、ペア名のまま読む（Twelve Data は `USD/CAD`、Swissquote は `instrument/USD/CAD`）。小数5桁、pips 0.0001 も正しい。読み込みは 9月28日〜10月1日に1日122〜261回で、上限（720・780）まで余裕がある。
  - 本当と確かめられた点は1つ（上の「購読を入れる時刻」）。2つの観点が同じものを見つけた。
- **本番への反映**（2026-10-02、UTC。上の「出す順番」のとおり）:
  1. マイグレーション `usd_cad_back` を当てた（09:20:33。台帳の版は当てた時刻の 20261002092033）。当てる前に、毎分の巡回がまだ signal-alerts-v16・購読40件であることを確かめた。当てた後、制約は21ペアになり、購読は40件のままだった。
  2. PR #154 をマージした（09:20:56。CLAUDE.md のとおり、オーナーに聞かずに）。
  3. 関数の反映（GitHub Action run 36989259604、09:20:59 に開始、成功）: signal-alerts（09:21:28）と live-chart（09:21:30）。09:22 からの毎分の巡回は signal-alerts-v17 で動き、応答は 200、購読は40件。live-chart の版の文字列は読んでいない（呼ぶにはログインが要る）。
  4. Lovable で公開した（09:23 ごろ）。答えは pending（deployment_id 2e1e03c9-964c-4991-ad3a-c69362422d3f）。公開を頼む前に、Lovable がマージ（9adcae6）を取り込んでいたこと（09:20:56）は確かめた。反映そのものは確かめていない。
  5. オーナーの購読: ドル/カナダドルの Q-Trend・ULTRA の4時間足（日本語）を登録した（09:31:10。上の「購読を入れる時刻」のとおり、09:00 の確定の前後30分を外した）。購読は42件（21銘柄 × 2種類、すべてオーナーのもの）になった。09:32 の巡回（signal-alerts-v17、応答 200）は購読42件を読み、Twelve Data は読まなかった（4時間足の確定の時刻ではないため）。
  - ドル/カナダドルの保存足は、09:32 の時点でまだ0行。コードどおりなら、チャートで誰も開かない限り、メールの巡回は区切りを0時として 12:00 に Twelve Data を1回読み、その足を保存して区切り（01/05/09…時）を覚える。最初の判定は 13:00 UTC の確定の後になる。どちらもまだ見ていない。
  - 見ていないもの（ログインが要るため）: 公開後の画面でドル/カナダドルのチャートを開けるか、メール通知の設定にドル/カナダドルが出るか。
  - **その後（13:10 UTC に確かめた）**: 最初の判定は、13:00 UTC の確定の後に行われた。13:01:00 の巡回（signal-alerts-v17、応答 200、購読42件）が、ドル/カナダドルの4時間足を Twelve Data から読み、09:00 UTC 始まりの足（13:00 確定）を判定した。確定から判定までは61.8秒。新しい印は無く、メールは0件。保存足（`live_chart_fallback` の4時間足）は 13:01:01 に読んだもので、最後の足が 09:00 UTC 始まり。
    - 上に書いた見込み（12:00 に1回読んで区切りを覚える）は起きなかった。12:00〜12:05 の巡回はドル/カナダドルを読んでいない。12時より前に、オーナーがドル/カナダドルのチャートを開いていた（保存足の 1時間足は 11:42、15分足・5分足は 12:31 に読まれている）。チャートを開くとまず4時間足を読む（開いたときの足は4時間足）ので、そのとき4時間足の保存足ができ、巡回はそこから区切り（01/05/09…時）を覚えたと考えている。4時間足の保存足は 13:01 に上書きされたため、最初に読まれた時刻は確かめられない。見込みは「チャートで誰も開かない限り」という条件付きで、その条件が満たされなかった。
    - チャートが開けることは、この保存足（オーナーの画面からの読み込み）でわかった。メール通知の設定に出るかは、まだ見ていない。

### 8.92 チャートの足を楽天FXの15種類に（#181、live-chart v16）

- **指示**（2026-10-02）: 楽天FXの足のメニューの画像と一緒に「足の種類、これだけ追加して」。メニューは 1・2・3・4・5・10・15・30分足、1・2・4・8時間足、日足・週足・月足、TICK の16。
- **順番**: 足の15種類を先に出す。TICK は決まった長さの足ではなく、今の仕組み（決まった長さの足を読む）に載らないので、別に進める（下の「TICK」）。
- **それまで**: 1分・5分・15分・1時間・4時間・日足の6つ（§8.58）。
- **作る前に確かめたこと**（読み取りだけ。GitHub Actions の feed-check、run 37009518910・37009733230、USD_JPY の Bid）:
  - GMO にある足: 10分・30分は日のファイル（YYYYMMDD。GMO の日の始まり 21:00 UTC から）。8時間・週・月は年のファイル（YYYY）。2分・3分・4分・2時間は 404（無い）。
  - 区切り: 8時間足は 0・8・16 時 UTC（4時間足と同じ格子）。週足は土曜 21:00 UTC（日本時間の日曜 06:00）。月足は前の月の末日 21:00 UTC（日本時間の1日 06:00）。
  - 冬の日の切り替わりも 21:00 UTC だった（2026-01-15 の1分足のファイルが 2026-01-14 21:00 UTC から始まる）。
  - GMO の週は日曜 22:00 UTC（日本時間の月曜 07:00）に始まる（2026-09-27 と 2026-01-18 の1時間足）。日曜 20:00 UTC の4時間足と日曜 16:00 UTC の8時間足には、その最初の2時間の値動きが入っている（例: 2026-09-27 20:00 UTC の4時間足は始値 157.287・高値 157.635・安値 157.276・終値 157.425。前の金曜の終値 157.242、次の月曜 00:00 UTC の始値 157.424）。
  - 2022年のファイルは無い（週足・月足・日足とも 404）。週足は2023年からの約196本、月足は46本がすべて。
  - Twelve Data にはここから届かない（403）。Twelve Data の週足・月足は、前の分析機能が読んでいた（月足は1日の日付。週足の日付が何曜日に付くかは記録が無い）。
- **変えたこと**:
  - 足を15にした（`LIVE_INTERVALS`、楽天FXのメニューの順。関数と画面の両方）。`LIVE_STEP_MS` に新しい足の長さ（月足は最も長い31日）。
  - 足の終わり（`barEndMs`）: 月足は暦で、次の月の始まりの同じ時刻に閉じる（GMO は日本時間の1日 06:00、Twelve Data は1日 00:00 UTC）。形成中の足・次の確定・確定足の判定・値動きで伸ばす足（`extendWithTicks`）がこれを使う。今の6つの足では、これまでと同じ値になる（始まり＋長さ）。
  - **GMO の14ペア**（`CHART_GMO`、`fetchChartQuotes`）: 10分・30分・8時間・週・月は GMO の足をそのまま読む。2・3・4分は1分足、2時間は1時間足（偶数時。GMO の4時間足・8時間足と同じ格子）からまとめる。最初の1本は、読んだ足の始まりで途中から始まるかもしれないので捨てる。足を捨てるのは、足の全体が休みの時間のときだけ（`barFullyClosed`。#182 から `barInsideClosure`、§8.93）なので、土曜 21:00 UTC の週足と日曜 16:00 UTC の8時間足は残る。年のファイルは、GMO に無い年（404）の手前まで読む。GMO の過去ファイルの保存（`gmo_kline_files`、`keptReader`。深い読み込みと同じもの）を、新しい足の足・過去の読み込みにも使う。
  - **今の6つの足は読み方を変えていない**（GMO_INTERVALS、usableBars、fetchLiveQuotes の今の道）。深い読み込みの保存の処理は `keptReader` にまとめたが、動きは同じ（どこまで前のファイルを読み込んだかを覚えるようにしたので、後でもっと前が要る読み込みは表を読み直す）。
  - **Twelve Data の7銘柄**: 週足・月足だけ Twelve Data からそのまま読む（`live_chart_fallback` に行が増える）。ほかは保存した短い足からまとめる（`TWELVE_BUILT`）: 2・3・4分←1分足、10分←5分足、30分←15分足、2時間←1時間足（奇数時。Twelve Data の4時間足 01・05・09… UTC と同じ格子）、8時間←4時間足（21・05・13 UTC）。
    - 2時間足・8時間足の区切りは、読んだ短い足の最新の足の始まりに合わせる（`twelveBuiltOffset`）。Twelve Data の4時間足の 01・05・09… UTC は夏（シドニーの冬・ニューヨークの夏）に測ったもので、夏時間で動くかは確かめていない。動いても、短い足2本の途中で区切ることはない。
    - 読み込みと1日の上限は元の足のもの（2・3・4分は1分足の450、10分は5分足の600、ほかは720）。まとめた足は、まとめた足が確定したら元の足を読み直す（`builtFresh`）。
    - 1分足は1回に3,000本読む（`TWELVE_1MIN_BARS`。ほかは今までどおり1,400本）。3分足・4分足が Q-Trend・ULTRA の決まった計算の始まり（600本前）より前まで届くように（3,000本で4分足は750本）。Twelve Data は本数にかかわらず1回で1回分（§8.87）なので、使う回数は変わらない。1分足のチャートで使う本数（最新800本）と深い過去（Zero-lag TEMA、最新1,400本）は変わらない（新しい方から切る）。
    - Twelve Data にない名前は送らない（`TWELVE_SERVED`。送ると1回分を使って足が来ない）。
    - 週足・月足は、形成中なら UTC の1日に1回読み直す（`newestBarFresh`）。保存する最少本数は12本（ほかの足は60本）。
  - GMO が読めないときの予備（Twelve Data）も、新しい足は同じ作り方にした。
  - **画面**: 足のボタンを横に流れる1行に（ペアの行と同じ。選んだ足が見える所まで動かす）。全画面のシートは4列（楽天FXのメニューと同じ）。足の名前（2分足〜月足）。次の確定までの残りが1日以上なら「◯日 時:分:秒」、確定の時刻に日付を付ける。週足・月足の時間の目盛りは年付きの日付。形成中の足の始まりは関数から受け取る（`forming_open`。月の長さが違うので、次の確定からは逆算できない）。値動きで次の足を始める処理（`tickLive`）は、月足を暦で区切る。
  - **文言**: Q-Trend・ULTRA の説明に「1分・2分・3分・4分・10分・30分足、2時間・8時間足、週足・月足は測っていません」を足した（1分足も、これまで測っていないのに書いていなかった）。金・Twelve Data の銘柄の説明に、まとめた足の読み込みと上限。料金・トップページを「1分足〜月足の15種類」にした。
  - **変えていないもの**: メール通知の足（5分〜日足。`INDICATOR_INTERVALS`・`ALERT_INTERVALS`、購読の制約）。ダウ理論の足（4H・1H・15M・5M）。マイグレーションは無い。signal-alerts は版の文字列だけ上げた（v18。live-chart/logic.ts を読み込むので出し直しになる）。
- **本物の GMO のデータで確かめたこと**（research/chart-timeframes.ts、run 37012277852、2026-10-02 13:20 UTC。読み込み302回、失敗0回）:
  - USD/JPY・EUR/USD・HUF/JPY の新しい9つの足を、チャートと同じ関数で読めた。201本（週足は196本・月足は46本。HUF/JPY は GMO の過去が2026年からで、週足39本・月足10本）。おかしな値の足と土曜の足は無い。8時間足は日曜 16:00 UTC の足が残る（週末の間は48時間）。2時間足の週末の間は50時間（金曜 20:00 → 日曜 22:00 UTC）。
  - 作った足を GMO 自身の足と照らした（USD/JPY の Bid の始値・高値・安値・終値）。2分×5 と10分足は39本、3分×10 と30分足は19本、4分×15 と1時間足は12本、2時間×2 と4時間足は102本。すべて一致し、違いは0。
  - 月足は46本で、RSI＋SAR・GA型の判定に要る60本に届かない。印は出ず、チャートはそう表示する。
- **確かめたこと（コード）**: テスト（新しく src/test/timeframes.test.ts。一覧と長さと名前が関数・画面・日英でそろう、月足の終わり、GMO と Twelve Data の読み方の表、まとめた足の値、偽の GMO で2分・2時間・10分・30分・8時間・週・月を読む〈測った区切りどおりの偽物〉、まとめた足と週足・月足の新しさ、月足の値動き、画面の月足の切り替わり、年付きの目盛り。見直しのあとに足したもの〈下〉）。新しく src/test/timeframes-chart.test.tsx（チャートの部品を月足・週足で動かす）。6つの一覧を前提にしたテストを直した。全テスト 2,391件、型チェック（以前からある12件だけ）、lint、Deno の型チェック（live-chart・signal-alerts・research/chart-timeframes.ts）、画面のビルド。
- **独立した見直し**（ワークフロー、33エージェント。5つの見方〈今の6つの足が変わっていないか・GMO の新しい足・Twelve Data の新しい足・画面・テストと記録〉で探し、見つかったものを2人ずつが反論を試みた）: 見つかったもの14件。2人とも反論できなかったもの9件、意見が分かれたもの1件、反論されたもの4件。今の6つの足とメールの巡回で、結果が変わる所は見つからなかった。直したもの:
  - **途中で止まった GMO の読み込み**（中）: 新しい足の足・過去の読み込みが、時間切れや答えの無いファイルで途中で止まっても、全部として出し、覚えていた。今は今の6つの足と同じく「読めなかった」とする（足は Twelve Data の予備に進み、覚えない。過去は 502 で、画面は次の読み込みで読み直す）。
  - **Twelve Data の8時間足の区切り**（中）: 4時間足の格子（05時 UTC から）を決め打ちしていたので、Twelve Data の4時間足が夏時間で動くと、まだ形成中の4時間足を含む8時間足を確定とすることがあった。今は読んだ足から区切りを決める（`twelveBuiltOffset`。2時間足も同じ）。
  - **週足の年のファイルの保存**（低）: 年のファイルは1月2日から「終わった」として保存するが、GMO の週足の年のファイルは、日本時間の日曜で年を分けるので、最後の週が次の年に入る（2025年のファイルの最後の週は 2025-12-27 21:00 UTC から 2026-01-03 まで。feed-check で読んだ52本）。その週の途中で保存すると、作りかけの週足が固まった。今は最後の週が終わってから保存する（`gmoFileClosed`）。
  - **Twelve Data の3分足・4分足の本数**（低）: 1,400本の1分足からでは、4分足が350本ほどで、Q-Trend・ULTRA の決まった計算の始まり（600本前）に届かず、開き直すと印が動くことがあった。1分足を3,000本読むようにした（上）。
  - **GMO が止まっているときの3分足・4分足**（低）: 予備の1分足の行を1分足のチャートと共有するので、1分足のチャートが先に開かれていると、260本の行から作って4分足が64本・3分足が86本になった。行の本数が足りなければ読み直すようにした。
  - **保存したファイルの読み込みの記録**（意見が分かれた1件、低）: 覚えたファイルを数で消すとき、どこまで表から読み込んだかの記録を残していたので、消したあとは表ではなく GMO から1つずつ読み直した。両方を一緒に消すようにした（`clearKlineMemory`）。
  - **テストの足りない所**（中・低、4件）: Twelve Data の読み方の決まり（知らない名前を送らない・元の足を読む・まとめた足の新しさ）、8時間足・2時間足の区切りが動いたとき、画面の月足・週足（形成中の足の始まりを関数から受け取る所）。テストを足した。
  - 反論された4件: 次の確定に日付を付けるかの決め方とコメントの食い違い、fetchChartQuotes のテストの時刻が1つだけ、research/chart-timeframes.ts の照らし合わせが重なりの無いときに「0件一致・0件不一致」を出す、テストの偽の GMO と本物の違い。どれも、確かめると結果を誤らせるものではなかった。
- **限り（測っていない・まだ見ていないこと）**:
  - 新しい足の勝率は測っていない（説明文にそう書いた）。
  - Twelve Data の週足の日付が何曜日に付くかは見ていない。本番で読んだあと、保存した行で確かめる。
  - Q-Trend・EMA200・Zone Shift は200本、Zero-lag TEMA は約1,200本の過去が要る。月足（46本）・週足（196本）では出ないか、TradingView とずれる。
  - FVG Crossfire は「週の区切りの隣の足を使わない」決まりなので、週足・月足ではいつも何も出ない。8時間足でも多くの足が除かれる。決まりは変えていない。
  - 2時間足の過去（601本）は1時間足のファイルを約70日分読む。保存したファイル（60日で消える）が無いと、1回の読み込み（20秒）で読み切れないことがある。そのときは途中までの足を出さず、保存もしない（下の「見直し」）。画面は過去なしでチャートを出し、次のチャートの読み込みのときに読み直す。読んだファイルは保存されるので、何度か開くと読み切れるようになる（本番では確かめていない）。
  - 楽天FXの2時間足・8時間足の区切りは確かめていない（ここでは GMO・Twelve Data それぞれの4時間足の格子に合わせた）。
- **見つけた別の問題（今回は直していない）**: 今の4時間足は、GMO の日曜 20:00 UTC の足（週の最初の2時間）を、足の始まりが休みの時間という理由で捨てている（`usableBars` が足の始まりの時刻を見る）。チャートの4時間足と、メール（4時間足の Q-Trend・ULTRA）の判定の両方に関わる。直すとメールの判定が変わるので、オーナーに伺う。→ オーナー「1直して」。#182 で直した（§8.93）。
- **本番への反映**（2026-10-02）: PR #156 をマージ（14:37 UTC）。
  - 関数: GitHub Actions の Deploy edge functions（run 37021173952）が成功した（14:38:17 UTC）。本番の live-chart のコードは `live-chart-v16-2026-10-02T14:00:00Z` で、見直しの直し（`twelveBuiltOffset`・`gmoFileClosed`・`clearKlineMemory`・`TWELVE_1MIN_BARS`）が入っている。毎分の巡回は 14:39:00 UTC から `signal-alerts-v18-2026-10-02T14:00:00Z` で、200・購読42件（その前の 14:38:00 は v17）。
  - 画面: Lovable にマージのコミット（9eccd36）が届いたのを見てから公開した（deploy_project、14:40 UTC 頃）。返事は pending（deployment d53bdfe8）。公開が終わったかは確かめていない。
  - まだ確かめていないこと: 本番の関数が新しい足を読むこと。関数はログインした人しか呼べず、ここからは届かない。反映の直後（14:40 UTC 頃）の `gmo_kline_files` には、新しい足のファイル（10min・30min・8hour・1week・1month）はまだ無い（誰もまだ開いていない）。誰かが開いたあとに、保存されたファイルで確かめる。
- **TICK**: 次の段階。今は、価格は画面が5秒ごとに聞く値だけで、価格が動くたびの記録はどこにも無い。GMO の公開 WebSocket で動くたびの値を受けられるかを確かめてから、作り方を決める。

### 8.93 GMO の日曜 20:00 UTC の4時間足を捨てないようにした（#182、live-chart v17・signal-alerts v19）

- **指示**（2026-10-03）: §8.92 で見つけた別の問題（4時間足が日曜 20:00 UTC の足を捨てている）を直すかを伺い、オーナー「1直して」「続けて」。
- **問題**:
  - GMO の FX の週は日曜 22:00 UTC（日本時間の月曜 07:00）に始まる。GMO の4時間足は 0・4・8… 時 UTC の格子なので、日曜 20:00 UTC の足（20:00〜24:00）に週の最初の2時間の値動きが入っている。
  - 足を使うかを決める `usableBars`（track-outcomes/quotes.ts）は、足の始まりの時刻だけを見て、休みの時間（`isMarketClosed`: 土曜、金曜 22:00 から、日曜 21:00 まで）に始まる足を捨てていた。日曜 20:00 の4時間足は始まりが休みの時間なので、中に値動きがあっても捨てられていた。
  - かかっていた所: チャートの4時間足（その足が系列に無い）と、メールの4時間足の Q-Trend・ULTRA（その足が無い系列で計算し、月曜 00:00 UTC には判定しない。週の最初の判定は月曜 04:00 UTC だった）。RSI+SAR・GA型の巡回（6ペア〈`ALERT_PAIRS`〉の15分・1時間・4時間・日足。購読が無くても成績の記録 `signal_events` に書く。#108、§8.23）も、4時間足を同じ読み方で読んでいた。
- **作る前に確かめたこと**（読み取りだけ。GMO の公開の足）:
  - `research/weekend-bars.ts`（run 37134212990、2026-10-03 15:42 UTC。GMO の14ペア、週末11回〈夏と冬、時計の切り替わりの週末、下の詰め物のある 2026-09-12 の週末〉。金曜 18:00〜月曜 02:00 UTC に始まる Bid の足。読み込み2,828回、失敗0回）:
    - 1・5・10・15・30分足、1時間足、日足: 前のやり方と今のやり方（下の `barInsideClosure`）で、捨てる足は同じ（1分足 472本、5分足 96本、10分足 48本、15分足 32本、30分足 16本、1時間足 8本、日足 2本。どれも HUF/JPY・SEK/JPY の下の詰め物で、4時間足の2本を合わせた676本すべてが、始値・高値・安値・終値が同じ値）。
    - 4時間足: 420本のうち、前のやり方は142本を捨て、今のやり方は2本だけを捨てる。残るようになった140本は、すべて日曜 20:00 UTC の足。
    - その140本を、同じ4時間の中の GMO の1時間足をまとめたもの（最初の始値・一番高い高値・一番安い安値・最後の終値）と照らした。140本すべてで、始値・高値・安値・終値が一致した。中の1時間足は、22:00・23:00 の2本が126本、21:00 からの3本が12本（2026-09-13 の週。この週はふだんより1時間早く日曜 21:00 UTC から値動きがあった）、20:00 からの4本が2本（HUF/JPY・SEK/JPY の 2026-09-13。20:00 の1時間足は詰め物）。
  - `research/weekend-years.ts`（run 37134212966。GMO の14ペアの 2023〜2026年の4時間足と日足の年のファイルすべて、Bid と Ask。読み込み224回、失敗0回）:
    - 4時間足（Bid 67,404本・Ask 67,404本）: 前のやり方は 2,160本を捨て、今のやり方は2本。残るようになった 2,158本はすべて日曜 20:00 UTC の足で、Bid と Ask の両方にある（片方だけの足は0本）。
    - 日足（Bid・Ask それぞれ 12,084本）: どちらのやり方も、下の詰め物の2本だけを捨てる。
  - **GMO の週末の詰め物**: HUF/JPY と SEK/JPY の 2026-09-12〜13 の週末に、始値・高値・安値・終値が同じ1つの値の足がある（4時間足は日曜 16:00 UTC、日足は土曜 21:00 UTC、1分〜1時間足は日曜 17:00〜20:59 UTC）。値動きの無い足なので、捨てたままにする。
- **作り方**:
  - `barInsideClosure(足の始まり, 足の長さ)`（_shared/market-hours.ts）を足した。足の始まりと終わり（最後の1ミリ秒）の両方が休みの時間（`isMarketClosed`）にあるときだけ捨てる。長さがわからない（0以下）ときは、前と同じく始まりだけで決める。休みの時間（47時間）より長い足は捨てない。
  - §8.92 で新しい足に使った `barFullyClosed` は使わない。日曜 17:00 UTC からを「開いているかもしれない」とする帯（`SUNDAY_PREOPEN_UTC_HOUR`。Twelve Data の足のためのもの）があるので、GMO の詰め物（日曜 16:00 の4時間足、土曜 21:00 の日足、日曜 17:00〜20:59 の短い足）を残してしまう。上の2つの確かめで、`barFullyClosed` は捨てる足が0本だった。
  - GMO の格子で、前のやり方と答えが違うのは、4時間足の日曜 20:00 UTC の足だけ（テストで、夏と冬の2つの週の、全部の足の格子の時刻で確かめた。前のやり方が残した足を捨てることは無い）。
- **変えたこと**:
  - `usableBars`（メールの巡回と、チャートの1分・5分・15分・1時間・4時間・日足の読み込みが使う）: 足の長さを渡して、`barInsideClosure` で決める。
  - チャートの #181 の足（`fetchChartQuotes`。2・3・4・10・30分、2・8時間、週・月）: `barFullyClosed` から `barInsideClosure` に替えた。GMO の足を、どこでも1つの決まりで決める。8時間足の日曜 16:00 UTC の足、週足（土曜 21:00）・月足は、これまでどおり残る。1〜30分足の詰め物は日曜の日本時間のファイル（土曜 21:00〜日曜 21:00 UTC）にあり、そのファイルはこれまでどおり読まない。
  - Twelve Data の足（`parseTwelveData`）は変えていない（`barFullyClosed` のまま）。成績の記録（track-outcomes）が判定に使う1分・15分・1時間足と、analyze（1分〜1時間足）は、答えが変わらない。
  - 版の文字列: live-chart v17、signal-alerts v19。マイグレーションは無い。
  - メールの記録の ID（QTREND_RULE_ID・ULTRA_RULE_ID・RULE_ID・GA_RULE_ID）と、二重送信を防ぐキー（足の時刻・向き・ID）は変えていない。
  - 研究のプログラムの週末の捨て方も同じ決まりにした（confirm・patterns・prewarn・stochexit・stochfree・stochgood・tphold・widestop・widetp・strength・gmo・qtrend-tp）。`research/tf-winrate.ts` と `research/dow-hit.ts` は入力 `WEEKEND`（`inside` が今のやり方で既定、`stamp` が前のやり方）を足し、tf-winrate には測る期間の終わり `END` も足した。
    - これまでの記録（§8.82 より前を含む）の研究の数字は、前のやり方で測ったもの。測り直したのは、メールとチャートの説明に書いている4時間足の数字（下）と、ダウの表示の当たり（下）だけ。
- **測り直した4時間足の成績**（`research/tf-winrate.ts`、利確1 20・損切り30 pips、2024-01-01〜2026-09-30 14:40:11 UTC〈§8.82 と同じ終わり〉、GMO の FX 21ペア、メールで送られる合図をその足の終値で入った場合、スプレッド込み）:
  - 前のやり方で同じ期間を測り直すと、§8.82 の数字とすべて同じになった（run 37133903888、`WEEKEND=stamp`）。測り方そのものは変わっていないことの確かめ。
  - 今のやり方（run 37134322956、`WEEKEND=inside`）。メールの関数との合図の違いは0（4時間足 5,692件。前のやり方では 5,506件）。GMO の読み込みの失敗0。

  | 4時間足 | 前（日曜 20:00 を捨てる） | 今（残す） |
  |---|---|---|
  | Q-Trend: 利確1が先 | 58.3%（4,285回） | 59.1%（4,498回） |
  | Q-Trend: 1回あたり | −1.47 pips [−2.44, −0.50] | −1.17 pips [−2.06, −0.27] |
  | ULTRA: 利確1が先 | 60.1%（1,812回） | 60.8%（1,865回） |
  | ULTRA: 1回あたり | −0.54 pips [−1.93, +0.84] | −0.37 pips [−1.77, +1.03] |

  - [ ] は 95% の幅。前と今の幅は大きく重なっていて、良くなったとは言えない。1回あたりはどちらもマイナス（ULTRA は幅が0をまたぐ）。損益ゼロには、スプレッドを除いても利確1が先の割合が 60% より上である必要がある（§8.82）。
  - 5分・15分・1時間・日足の数字は、前と1桁目まで同じ。
  - 回数が増えたのは、日曜 20:00 の足で出る合図（月曜 00:00 UTC の確定）が加わったのと、足が1本増えると Q-Trend・ULTRA の計算が変わり、ほかの足の合図も変わるため。足の始まりの時刻で分けると、20:00 UTC の足（平日の 20:00 と日曜 20:00）の取引は 467回 → 703回、利確1が先 61.9% → 60.4%、1回あたり −0.99 → −1.87 pips（払ったスプレッドの中央 2.00 → 2.20 pips）。
  - 前半（〜2025-05-18）と後半で、上がり下がりはそろわない。Q-Trend 前半 58.6%・−1.50 → 60.5%・−0.80、後半 58.0%・−1.44 → 57.6%・−1.55。ULTRA 前半 59.2%・−1.11 → 58.6%・−1.45、後半 61.1%・+0.04 → 63.1%・+0.76。
  - メールとチャートの説明の4時間足の数字（`INDICATOR_MEASURED`、日英の説明文）を、今の数字にした。
  - ダウの表示の当たり（§8.90、`research/dow-hit.ts`）も今のやり方で測り直した（run 37134324269、`WEEKEND=inside`、終わり 2026-10-02 00:00 UTC。チャートの関数との照らし合わせ 49,795件で違い0）。数字は、ダウの説明に書き足すとき（#183）に記録する。
- **オーナーにとって変わること**:
  - **4時間足のメール（Q-Trend・ULTRA）**: 月曜 00:00 UTC（日本時間 09:00）に、日曜 20:00 UTC の足の確定を判定するようになる（`hourCloseOf` が月曜 00:00 に「確定」と答える）。その足で合図が出ればメールが届く。これまでは月曜 04:00 UTC（日本時間 13:00）が週の最初の判定だった。
  - **チャートの4時間足**: 日曜の夜（日本時間の月曜 07:00〜09:00）の形成中の足が、日曜 20:00 UTC（日本時間 月曜 05:00）の足になり、次の確定は月曜 00:00 UTC。月曜からはその足が確定足として並ぶ。1週間の4時間足は30本から31本になる。
  - 過去の4時間足の印（Q-Trend・ULTRA の BUY/SELL、ほかのインジケーター）が、反映のあとに1度動くことがある（足が1本増え、Q-Trend の決まった計算の始まり〈600本前〉も動くため）。
  - **反映の前から開いたままの4時間足のチャートは、開き直す必要がある**（独立した見直しで見つかったこと、下）。画面は、過去の足（Q-Trend・ULTRA・EMA・Zone Shift などに使う約600本）を、チャートの足が追い越すまで読み直さない（`LiveChart.tsx` の `historyBefore`）。開いたままだと、古い決まりの過去の足（日曜 20:00 が無い）と新しい決まりの足をつないで計算するので、Q-Trend の決まった計算の始まりがメールと違う足になることがある。見直しの試し（GMO の4時間足の時刻の並びだけで試した。値段は使っていない）では、開き直さない場合、2026-10-05〜11-20 の確定264回のうち64回で、画面とメールの計算の始まりが違った。その間は、画面の Q-Trend・ULTRA の印が、届くメールと食い違うことがある（実際の値段で印が変わるかは確かめていない）。過去の足を読み直すまで、長くて約6.5週間続く。
    - 過去の足はタブのメモリーにだけあり、端末には保存していない。開き直す（ページを読み込み直す）か、ペアか時間足を一度切り替えれば、新しい決まりの過去の足を読む。
    - 画面の新しい版を公開しても、開いたままのタブは古い版のまま動くので、コードで直しても反映の前から開いているタブには効かない。手当ては開き直すことだけ。メールは毎回600本を新しい決まりで読むので、メールの判定は正しい。
  - **RSI+SAR・GA型の成績の記録**: 6ペアの4時間足も、月曜 00:00 UTC に日曜 20:00 UTC の足の確定を判定するようになる。RSI+SAR・GA型の購読は0件なので、メールは増えない。成績の記録（`signal_events`）に、その足で出た合図が加わる（二重送信を防ぐキーと RULE_ID・GA_RULE_ID は変わらない）。
  - 1分〜1時間足・日足、#181 の足、Twelve Data の銘柄は変わらない。成績の記録の決着（track-outcomes。1分・15分・1時間足で追う）も変わらない。
- **確かめたこと（コード）**:
  - 新しく src/test/weekend-gmo.test.ts: 日曜 20:00 の4時間足を残す、詰め物を捨てる（`barFullyClosed` なら残ってしまうことも）、GMO の格子で前と答えが違うのは日曜 20:00 の4時間足だけ、長さがわからないときと長い足、偽の GMO の4時間足を `fetchYearQuotes` で読む（日曜 20:00 が残り・日曜 16:00 の詰め物が捨てられ・1週間31本）、チャートの日曜の夜と月曜の `liveRead`、メールの月曜 00:00 の `hourCloseOf`、コードの決まり（`usableBars` と `fetchChartQuotes` が `barInsideClosure` を使う、`barInsideClosure` に日曜の帯が無い）。前のやり方に戻すと、このうち3件が落ちることを確かめた。
  - 4時間足の数字のテスト（indicator-alerts・ultra）を今の数字にした。
  - 全テスト 2,401件、型チェック（以前からある12件だけ）、lint（変えたファイルに0件）、Deno の型チェック（live-chart・signal-alerts・track-outcomes・analyze、変えた研究のプログラムすべて）、画面のビルド。
- **独立した見直し**（ワークフロー、8エージェント。4つの見方〈捨て方の決まりと呼び出し元・メール・チャート・数字とテストと研究〉で探し、見つかったものを別の1人が反論を試みた）: 見つかったもの4件。反論できなかったもの1件、反論されたもの3件。
  - **反映の前から開いたままの4時間足のチャート**（低。反論できなかった）: 上の「オーナーにとって変わること」に書いたとおり。チャートの見方の1人も同じことを見つけたが、確かめた1人は「反映の移り変わりの、以前からある性質」として反論した。どちらも、メールは正しいこと、開き直せば直ることでは一致している。コードは変えず（開いたままのタブには新しいコードが届かないため）、記録とオーナーへの報告で開き直しを伝える。
  - 反論されたもの:
    - 「メールの月曜 00:00 の判定」のテスト（`hourCloseOf` だけを見る）は、前のやり方でも通る。→ `hourCloseOf` は変えていないので当然で、月曜に最新の確定足が日曜 20:00 になることは、チャートのテスト（`fetchLiveQuotes` を通る）が前のやり方で落ちて確かめている。確かめた1人が、巡回の道（`fetchLiveQuotes` → `historyRead` → `hourCloseOf`）を通すテストを作業用のコピーで走らせ、今のやり方で「確定」、前のやり方で「わからない」になることを確かめた。
    - RSI+SAR・GA型の4時間足の成績の記録が、記録の影響先から抜けていた。→ 動きは正しく（日曜 20:00 の足には値動きがある）、メールも増えないので欠陥ではないとされたが、記録に書き足した（上）。
- **限り（測っていない・まだ見ていないこと）**:
  - 本番で月曜 00:00 UTC の判定が動くことは、反映のあとの最初の月曜（2026-10-05 00:00 UTC）に確かめる（§9 K）。→ 確かめた（下の「本番での確かめ」）。
  - GMO の週が日曜 22:00 UTC より早く始まった週（2026-09-13 の 21:00）も、値動きは日曜 20:00 の4時間足に入るので残る。日曜 20:00 より前に値動きのある週は、確かめた範囲（2023〜2026年の年のファイル）には無かった（日曜 16:00 UTC の4時間足は、詰め物の2本だけ）。もし日曜 20:00 より前に週が始まると、日曜 16:00 の足は今のやり方でも捨てる。
  - 研究の過去の数字（上）は前のやり方のまま。
- **本番への反映**（2026-10-03、市場が閉まっている土曜）: PR #158 をマージ（16:30 UTC、52e244b）。
  - 関数: GitHub Actions の Deploy edge functions（run 37137092818）が成功した（16:31:12 UTC）。
    - 本番の live-chart のコードは `live-chart-v17-2026-10-03T16:00:00Z` で、`barInsideClosure` が入っている（`get_edge_function` で読んで確かめた。`usableBars` の `return !barInsideClosure(t, intervalMs);` と `fetchChartQuotes` の `!barInsideClosure(t, baseLen)`）。
    - 毎分の巡回は 16:32:00 UTC から `signal-alerts-v19-2026-10-03T16:00:00Z`（`indicators` と `sweep` のどちらも 200。その前の 16:31:00 は v18）。土曜なので `market_closed` で飛ばしていて、購読の数や読んだ足はこの応答には出ない。
  - **版名を上げずに出し直した関数**: 同じ反映で analyze・postmortem・track-outcomes・version-compare も出し直しになった（変えた `track-outcomes/quotes.ts`・`_shared/market-hours.ts` と、コメントだけ変えた `track-outcomes/evaluate.ts`・`analyze/price-source.ts` を含むため。`deno info` で確かめた）。版名は上げていない。§6.2 の決まり（関数を変えたら版名を上げる）からは外れている。
    - 上げなかった理由: この4つが `usableBars` を使うのは1分〜1時間足（日のファイルの足）だけで、GMO の格子では前と答えが同じ（src/test/weekend-gmo.test.ts で、夏と冬の週の全部の格子の時刻で確かめた）。同じ版名の2つのビルドの動きは同じなので、§8.7-a のように別の動きが1つの版名に混ざることは無い。版名を上げると、動きが同じなのに version-compare などの母集団が分かれる。
    - 前例: #153 で `quotes.ts` を変えたときも、この4つの版名は上げていない。#181 では `live-chart/logic.ts` を読み込む signal-alerts の版名を上げた（こちらは動きが変わるものを含んでいた）。
  - 画面: Lovable にマージのコミット（52e244b）が届いたのを見てから公開した（`deploy_project`、16:32 UTC 頃）。返事は pending（deployment c938b699）。公開が終わったかは確かめていない。
  - まだ確かめていないこと: 月曜 00:00 UTC の4時間足の判定（§9 K、2026-10-05 00:00 UTC）。日曜の夜のチャートの形成中の足（関数はログインした人しか呼べず、ここからは見られない）。
- **本番での確かめ**（2026-10-05 00:14〜00:20 UTC、§9 K。読み取りだけ。`net._http_response` は約6時間分しか残らないので、数字はここに写しておく）:
  1. Q-Trend・ULTRA の巡回（`signal-alerts-v20-2026-10-04T10:00:00Z`、`indicators`）: 00:00:00 UTC の巡回（id 17037、200）で、購読42件（応答の `subscriptions`）のうち、4時間足の GMO の14ペア（AUD/JPY・AUD/USD・CAD/JPY・CHF/JPY・EUR/JPY・EUR/USD・GBP/JPY・HUF/JPY・MXN/JPY・NZD/JPY・SEK/JPY・TRY/JPY・USD/JPY・ZAR/JPY）すべてを、`newest` 2026-10-04T20:00:00.000Z の足で判定した（`judged_sun20` 14、`skipped` は無し、600本、確定から 2.8〜8.1秒で判定）。前のやり方なら、この足は `unknown` で飛ばしていた。合図は14ペアとも出なかった。
     - 00:04・00:06 UTC の巡回も、同じ14ペアを同じ足で判定し直した（確定から約4分・6分。合図は0）。4時間足を 0・4・6分に読むのは控えの読み直しで（`gmoIntervalsDue`）、判定済みの足を読まない記憶（`judgedBar`）は関数のインスタンスごとなので、別のインスタンスで動くと判定し直す作り（コメントの「once an instance」）。二重のメールは、`signal_alerts` の一意のキー（user_id・kind・pair・interval・bar_time・side・rule）で防ぐ。今回は合図が0なので、二重送信は起きようがなかった。この3回が別のインスタンスだったかは、ログからは確かめていない。
     - Twelve Data の7銘柄（金を含む）の4時間足は、この時刻には読まない（01・05・09… UTC の格子。変わらない）。
  2. `public.signal_alerts` の4時間足の行は、`bar_time` 2026-10-04 20:00 UTC も `closed_at` 2026-10-05 00:00 UTC も0行（合図が出ていないので、行が無いのが正しい。4時間足の一番新しい行は 2026-10-02 20:00 UTC のもの）。
  3. チャートの形成中の足（日本時間の月曜 07:00〜09:00）は、ここからは見られない（関数はログインした人しか呼べない）。確かめていない。
  4. 04:00 UTC の判定（2026-10-05 04:15〜04:26 UTC に確かめた。読み取りだけ）: 04:00:00 UTC の巡回（id 17329、200、`signal-alerts-v20-2026-10-04T10:00:00Z`、購読42件）で、4時間足の GMO の14ペアすべてを `newest` 2026-10-05T00:00:00.000Z の足で判定した（600本〈USD/JPY・GBP/JPY は601本〉、確定から 2.5〜7.6秒、`skipped` は無し）。合図は14ペアとも出なかった。04:04・04:06 UTC の控えの読み直しも同じ足で判定し直した（合図は0）。
     - Twelve Data の7銘柄（CZK/JPY・HKD/JPY・NOK/JPY・PLN/JPY・SGD/JPY・USD/CAD・XAU/USD）の4時間足も、04:01〜04:06 UTC の巡回で `newest` 2026-10-05T00:00:00.000Z の足（1,060本、金は1,059本）で判定した（04:01 に HKD/JPY・SGD/JPY・USD/CAD、04:02 に残りの金以外、04:03 に金）。上の1の「01・05・09… UTC の格子」は 2026-09-28 に読んだときの格子で、コードは格子を足そのものから読む（`twelvePhase`）。今回の足は 00:00 UTC 始まりだった。格子がいつ変わったかは確かめていない。
     - HKD/JPY で Q-Trend の買い（`qtrend:BUY`、☆ではない）が出た。`public.signal_alerts` の4時間足の行（`bar_time` 2026-10-05 00:00 UTC）はこの1行だけで、`sent`（04:01:03 UTC に作られ、同じ時刻に送信、エラー無し）。04:02〜04:06 UTC の巡回でも同じ合図を判定し直したが、行は1行のまま（二重のメールは出ていない）。この合図の結果（利確・損切りのどちらに先に届いたか）は、この時点ではまだ決まっていない。
     - RSI+SAR・GA型の巡回（`sweep`）: 04:02 UTC（id 17331）と 04:17 UTC（id 17350）の巡回で、6ペアの4時間足を `bar` 2026-10-05 00:00:00 の足で判定した（200本、合図は無し）。`signal_events` の 4h・`bar_time` 2026-10-05 00:00 UTC の行は0行（正しい）。
  5. RSI+SAR・GA型の巡回（`sweep`）: 00:02 UTC（id 17039）と 00:17 UTC（id 17058）の巡回で、6ペア（USD/JPY・EUR/USD・EUR/JPY・GBP/JPY・AUD/USD・AUD/JPY）の4時間足を、`bar` 2026-10-04 20:00:00 の足で判定した（200本）。合図は出なかった（`signal` が null）。`signal_events` の 4h・`bar_time` 2026-10-04 20:00 UTC の行は0行（正しい）。

### 8.94 ダウの説明に、表示が出ている間の当たり（#179）を書き足した（#183）

- **指示**（2026-10-03）: §8.92 の報告で「#179 で測ったダウの表示の当たりを、チャートのダウの説明に書き足しますか」と伺い、オーナー「2書き足して」。
- **使った数字**: #182（§8.93）で GMO の日曜 20:00 UTC の4時間足を残したので、§8.90 の測定（run 36983279241、前のやり方）ではなく、今のやり方で測り直したもの（`research/dow-hit.ts`、run 37134324269、`WEEKEND=inside`、期間 2024-01-01〜データの終わり 2026-10-02 00:00 UTC、前半〜2025-06-30・後半 2025-07-01〜。測り方は §8.90 のまま）。
  - 確かめ: チャートの関数との照らし合わせは実データ 49,795か所で食い違い0件。効果なしの作り物20通りでも各 50,099か所で0件、先読みの確かめ（後の足・前の足の書き換え）も20通りすべてで動いたもの0件。効果なしで幅が0をまたがなかった割合は 5分足 4.6%・15分足 7.1%・1時間足 10.0%・4時間足 5.8%（10%を超えた時間足はないので、幅は実データ自身の幅）。
  - 判定（12ペア、決めておいた決まりのとおり）: 「予測力がある」24の組のうち0、「勝てる」24の組のうち0、「逆に外れやすい」は5分足の上昇の1つだけ（§8.90 と同じ）。
  - 65%以上の組は76あり、すべてフォリント/円・Sクローナ/円のまとまり（データが約4か月半）の組だった（§8.90 は48）。12ペアの判定の組には無い。§8.90 と同じく、出来事が少ないための偶然と判断した（このまとまりの数字は説明文に使っていない）。
  - §8.90 から変わったのは、4時間足の表示と、4時間足を含む「4つそろった」の組だけ（5分・15分・1時間足のそれぞれの表示の数字は同じ）。4時間足（前半 / 後半、カッコはランダム）:

  | 4時間足の表示 | §8.90（前のやり方） | 今 |
  |---|---|---|
  | 上昇 | 51.7 / 49.0（50.7 / 51.6） | 51.3 / 49.5（50.7 / 51.7） |
  | 下降 | 50.3 / 45.5（49.7 / 49.0） | 50.2 / 45.9（49.6 / 49.1） |
  | 上昇の兆し | 50.2 / 48.4（50.4 / 51.2） | 50.4 / 48.1（50.4 / 51.0） |
  | 下降の兆し | 49.9 / 45.9（49.2 / 48.4） | 49.3 / 46.3（49.2 / 48.3） |
  | 4つそろった上昇 | 49.5 / 50.7（50.7 / 51.7） | 49.1 / 51.2（50.8 / 51.8） |
  | 4つそろった下降 | 51.2 / 45.0（49.5 / 49.3） | 50.7 / 45.0（49.5 / 49.4） |

  - 書いた数字（12ペア、24の組、前半と後半）: 先に届いた方の当たり 45.0〜51.4%、ランダムに入った場合 48.3〜51.8%。売買した場合（スプレッド込み、損切り・利確とも ATR×1）の勝率 30.4〜45.0%、1回あたり −0.106〜−0.696R（5分足 −0.61〜−0.70R、15分足 −0.42〜−0.60R、1時間足 −0.29〜−0.38R、4時間足 −0.11〜−0.34R）。オーナーの画面の形（4H・1H が下降、15M・5M が逆）は 87,125か所で 50.2%（ランダム 49.0%）、差 +1.2ポイント（95%の幅 −1.4〜+3.8）、売買すると1回あたり −0.36R。
- **変えたこと**: チャートのダウ理論の説明（`dowNote`、日英）に、#132 の文のあとへ #179 の結果を1つ足した。「表示が出ている間に入った場合も #179 で測りました（GMO の12ペア、2024-01-01〜2026-10-01、5分ごとに数え、ATR の幅で予想の向きに先に届いたら当たり）。どの時間足・どの表示でも当たりは45〜51%で、同じ時刻にランダムに入った場合（48〜52%）と差は誤差の範囲でした（前半・後半の両方でランダムをはっきり上回った組は24のうち0）。4H・1H が下降で15M・5M が逆向きの形も、当たり50.2%（ランダム49.0%）で同じです。スプレッドを払って売買すると（損切り・利確とも ATR×1）、勝率は30〜45%、1回あたり −0.11〜−0.70R で、どの組もマイナスでした。」
  - #132 の文（確定で入った場合、損切り ATR×1・利確2倍）はそのまま残した。測り方が違う別の結果で、間違いではない。
  - 関数とメールは変えていない（画面の文言だけ）。
- **確かめたこと**: src/test/dow.test.tsx の説明の確かめに、今回の文の3か所を足した。全テスト 2,401件、型チェック（以前からある12件だけ）、lint、画面のビルド。
- **本番への反映**（2026-10-03）: PR #160 をマージ（16:39 UTC、15a2f19）。関数は変えていないので、関数の反映は無い。Lovable にマージのコミット（15a2f19）が届いたのを見てから公開した（`deploy_project`、16:40 UTC 頃）。返事は pending（deployment 698b28df）。公開が終わったかは確かめていない。

### 8.95 プロトレーダーのやり方を調べた（#185、研究のみ）

- **指示**（2026-10-03）: オーナー「プロトレーダーのやり方を真似したい、一旦調べて」。TICK（§8.92）の作業の途中だったが、こちらを先にした。
- **調べ方**:
  - 6つの見方で、それぞれ別の1人が調べた（ワークフロー）。機関投資家・ヘッジファンド、プロップファーム、著名トレーダーの書き残した規則、日本のプロ・元銀行ディーラー、勝つ人と負ける人の違い（研究と規制当局）、このリポジトリで既に測ったこと。見つけた数字は、別の1人が出典で確かめた。最後に、抜けを探す1人が見直した。
  - この環境からは外のウェブページが開けず（WebFetch が遮断。検索も回数の上限に達した）、最初の数字はほとんどが検索結果の要約だった。そこで、挙がった出典26本を GitHub Actions で開いて本文を読み（`research/source-read.py`、`source-read.yml`、run 37141540605）、本文と照らし直した（6エージェント）。本文まで読めたのは19本、要旨か紹介ページだけが4本、取れなかったのが3本（SSRN の2本と SEC の書類が 403）。
  - 下の数字は、本文で確かめたもの（出典の言葉どおり）。確かめられなかったものは「未確認」と書く。
- **確かめたこと**:
  - **勝率**: 勝率100%のプロは、読めた資料に一人もいない。
    - タートル（1980年代に規則どおりに売買した集団）の規則の文書: 「most of the trades that the Turtles made resulted in losses」（ブレイクのほとんどはトレンドにならない）。
    - FundedNext（プロップファーム、2026年2月の支払いの報告。会社の発表、デモの環境、支払いを受けた人だけ）: 勝率の中央値は CFD 50.0%・先物 63.0%。支払いを受けた CFD 口座の41%は勝率5割未満。リスク・リワードの中央値 1.49:1。
    - ジュン氏（17億円の収益とされる専業トレーダー、ザイFX!）: 「勝率は上級者でも50％をわずかに上回る程度。40％台の億トレーダーも珍しくありません」。ひろぴー氏（外為どっとコムのメディア）: 勧める勝率は40%台前半。どちらも記事の言葉で、記録の裏付けは無い。
  - **損の決め方（資金管理）**:
    - タートル: N（20日の平均の値幅＝ATR）が1つ動くと口座の1%が動く量を1単位にする。損切りは入値から 2N（1回の取引の危険は口座の2%まで）。損切りは「each time, every time, without fail」。単位の上限は1市場4・強く相関する市場6・ゆるく相関する市場10・片側の合計12。口座が元から10%減るごとに、量の計算に使う額を20%減らす。1987年10月の暴落の翌日、金利先物を上限まで買っていた人は1日で口座の20〜40%を失った。文書は「4年間の平均で年率80%」とするが、本人たちの申告で監査された数字ではない。「多くのタートルは儲からなかった。規則が悪いのではなく守れなかったから」。
    - FTMO（プロップファームのブログ）: 1回のリスクは口座の1%以内を勧める（規則ではなく推奨）。
  - **個人の成績**:
    - ESMA（EU の規制当局、2018-03-27）: 「74-89% of retail accounts typically lose money ... average losses per client ranging from €1,600 to €29,000」（CFD の口座。1回ごとの勝率ではない）。
    - 金融先物取引業協会（2018年3月、金融庁の会議資料）: 主要18社の顧客のうち実効レバレッジ5倍未満は43%。2015年1月15日のスイスフランの急変で、店頭FXの個人に預けた額を超える損（未収金）が1,094件・18億5,800万円。日本の顧客の何割が利益を出しているかは、この資料には無い（調べ役が挙げた「利益が出た人60.3%」「減った口座72.22%」は、この資料に無く未確認）。
    - 日銀レビュー（2016）: 日本の個人は短い期間の値動きと逆に建てる（逆張り）。円が急に上がる時は、ロスカットの強制決済が値動きを大きくすることがある。平均レバレッジは 2014年4〜6月期の6.3倍から2016年1〜3月期の4.6倍に下がった。勝った人の割合は書かれていない。
  - **機関投資家**（勝率の数字はどの論文にも無い）:
    - AQR（2010年版）: 60銘柄（商品・株価指数・債券・通貨）を12か月の向きで売買する仮の戦略は、1985〜2009年に年率17.8%・最大の落ち込み −13.3%（取引コストも手数料も引く前。「do not include trading costs or fees」）。ただし1銘柄ずつの Sharpe の平均は0.4で、成績は多くの市場に分けて持つことから来ている。
    - CFM（2014）: 数か月の長いトレンドは200年続いているが、3日ほどの短いトレンドは2003年以降ほぼ消えた。
    - キャリー（Menkhoff ら、JF 2012）: 高金利の通貨を買い低金利の通貨を売る組は、売値と買値の差を引いて年率7.23%。世界の為替が急に荒れると弱い。円キャリーは2024年8月の巻き戻しの前に約40兆円（BIS Bulletin 90 の紹介ページ）。
  - **プロップファーム**: Topstep（2025年）は審査（Trading Combine）の合格が16.8%、シミュレーションの資金提供口座の参加者のうち実資金の口座に呼ばれたのは0.71%。
  - **ゴトー日・仲値**（日本特有のもの）:
    - 神戸大の紀要（国民経済雑誌 224(6)）: GMOクリック証券のドル円1分足（2007年1月〜2020年1月）で、スプレッドを2銭として引いた。ゴトー日の前の晩23時に買って 9:55 に売ると、900日の累計 +56.838円（1回あたり約 +6.3銭）。ゴトー日でない日の同じ取引は、2,513日で −68.154円。
    - 茨城大（CCS2022-46）: ゴトー日のドル円は深夜3時ごろから 9:55 に向けて上がり、仲値の直後に下がる。
    - ザイFX!: 同じ「金曜のゴトー日、7時→10時」の上がった割合は、58日で数えると74.1%、約240日で数えると58%。回数が少ないと割合は高く出る。
    - Krohn ら（JF 2024、「仲値の型は個人のコストでは儲からない」とされる）は 403 で取れず未確認。
- **このアプリで既に測ったこと**: 4時間足のメール（§8.93）、利確の幅（§8.83）、損切りなし（§8.76）、1999年からの日足のトレンドフォロー・ブレイクアウト・キャリー（§8.24 #109）、利を伸ばす出口（§8.24 #110）。どれも、スプレッドを払うと1回あたりがマイナスか、偶然と区別できなかった。ゴトー日・仲値はまだ測っていない。
- **抜けを探した見直しで出たこと**（計算は調べ役のもの。単純な2通りの勝ち負けのモデル）:
  - 期待値がマイナスのままでは、資金管理で変えられるのは負ける速さだけ。Q-Trend（59.1%・−1.17 pips）に1回1%を賭け続けると、全取引のあとの資金の中央値は元の約15%。ケリー基準の答えは「賭けない」。
  - 今の Q-Trend・ULTRA のメールは成績を記録していない（§8.67）。1回の損益のばらつきは約24 pips で、±1 pip の差を見分けるには約3,600回（Q-Trend で約2年）要る。
  - 円のペアは同じ向きに動きやすい（§8.67 で円の8ペアに同時に売りが出た）。同時に持つ数の上限は、まだ無い。
  - 楽天FXのスプレッド・スワップ・すべり・ロスカットは調べていない（測定はすべて GMO の売値・買値）。
- **真似できそうで、このアプリで測れるもの**（オーナーに示した候補。どれもまだ測っていない）:
  1. 損切りを固定30 pips から 2N（ATR の2倍）にする（タートル）。同じ取引で、勝率・1回あたり・最大の落ち込みを比べる。
  2. ゴトー日の朝のドル円（神戸大と同じ形を、GMO の売値・買値で。ゴトー日でない日と比べる）。
  3. 資金管理と、同時に持つ数の上限の試算。
  4. 今のメールの成績を記録していく。
- **限り**: 読めなかった出典（Krohn ら、Chague ら〈ブラジルのデイトレーダーの97%が損〉、Virtu の上場届出〈1,238日で負けは1日〉）の数字は使っていない。著名トレーダーの言葉（Paul Tudor Jones の「5対1なら当たりは20%でよい」など）は名言サイトからの又聞きで、確かめていない。読んだ本文は作業用のフォルダに置き、repo には入れていない（出典の著作物のため）。

### 8.96 ゴトー日の朝のドル円を測る（#186、研究のみ）

- **指示**（2026-10-04）: §8.95 の候補から、オーナーが「ゴトー日のドル円」「損切りを値幅の2倍に」「資金管理の試算」を選んだ。順番に1つずつ測る。これはその1つ目。
- **元にする研究**: 神戸大の紀要（国民経済雑誌 224(6)、§8.95）。GMOクリック証券のドル円1分足（2007年1月〜2020年1月）で、ゴトー日の前の晩 23時（日本時間）に買って 9:55 に売ると、スプレッドを2銭として引いて、900日の累計 +56.838円（1回あたり約 +6.3銭。スプレッドを引く前は約 +8.3銭）。ゴトー日でない日は 2,513日で −68.154円。ここでは、論文が終わった後の期間（GMO FX の公開データのある期間）で、同じ形が今も成り立つかを測る。
  - 値動きを読む前に、内閣府の一覧で 2007-01-01〜2020-01-31 を数える。数えるのは、ここの決め方でのゴトー日（月曜を含む）と、ゴトー日でない月〜金の数。論文の 900・2,513 と並べる（暦だけで、値動きは見ない）。合わなくても決め方は変えず、差を書く。ここの比べる日は営業日で月曜を除くので、比べる日の数字は論文の −68.154円とは並べない。
- **測り方**（データを見る前に決めた。下書き 0f8279f を、3つの見方〈統計・決め方とデータ・作りの落とし穴〉の独立した見直しで直した。`research/gotobi.ts`）:
  - **データと期間**: GMO FX の公開データの USD_JPY の1分足、売値（Bid）と買値（Ask）の両方。
    - 最初の日は、Bid・Ask の両方に足がある最初の GMO の日のファイルの日。値段を計算しない下見（ファイルがあるかと足の数だけ）で決め、docs に書いて commit してから測る。結果を見て動かさない。最初の取引は、入る足（前の日 23:00）がその日以降のファイルにある最初の日。最後の取引は、出る日が 2026-10-02 以前のもの。
    - 読めなかったファイルと、取引日の中の1分足の欠けを、結果を読む前に出す。429・5xx・時間切れは3回まで読み直し、それでも読めなければ日を外さずに測定を止める（走らせるたびに数が変わらないように）。
    - 日のファイルは actions/cache に置き、ファイルごとの足の数と sha256 を research/out に出す。日ごとの表（日付・曜日・区分と外した理由・入った時刻と買値・出た時刻と売値・損益・2つのスプレッド）を CSV で research/out に出す。Deno の版を固定し、run の番号を docs に書く。
  - **ゴトー日**（神戸大の決め方に合わせた。2月・31日・前倒しの先が休みの日・月曜の扱いは論文で確かめておらず、ここで決めた）: 毎月5・10・15・20・25・30日。2月は5・10・15・20・25日の5つで、月末は足さない。31日はゴトー日にしない。その日が土曜・日曜・月曜の祝日なら、直前の金曜を「前倒しゴトー日」とする。前倒しの先の金曜が営業日でない（祝日、または 12/31〜1/3）ときは、ゴトー日にしない（木曜には動かさない）。火〜金曜の祝日と重なったら、ゴトー日にしない（前倒しもしない）。
  - **あいまいな日**: ゴトー日にしなかった日（火〜金曜の祝日のゴトー日と、前倒しの先が休みのゴトー日）の直前の営業日が比べる日にあたるときは、「あいまいな日」とし、ゴトー日にも比べる日にも入れない（実際の決済はその日に移ることがあるとされる。確かめていない）。日付と数を、結果の前に出す。
  - **祝日**: https://www8.cao.go.jp/chosei/shukujitsu/syukujitsu.csv をバイトのまま読み、Shift_JIS として読む。見出しの1行を除く全行が「年/月/日,名前」の形であること。「休日」（振替休日・国民の休日）も祝日に入れる。12/31〜1/3 はコードで足す。測る期間の各年で祝日が16〜21日あること。既知の日（2019-04-30、2023-11-03、2024-02-23、2024-05-03、2024-05-06、2025-11-24、2026-09-22）がすべて入っていること。合わない行があるとき、3回読み直しても読めないとき、既知の日が欠けたときは、測定をせずに止まる。読んだ CSV と sha256 と行数を research/out に残し、結果の前に出す。
  - **比べる日**: 日本の営業日（月〜金で、祝日と 12/31〜1/3 を除く）で、ゴトー日（前倒しを含む）でもあいまいな日でもない日。
  - **取引（主）**: 前の日の 23:00（日本時間）に始まる1分足の始値で買い（Ask）、当日の 9:55 に始まる1分足の始値で売る（Bid）。スプレッドは実際の売値と買値の差（神戸大の2銭固定ではない）。損切りは置かない（神戸大と同じ）。
    - 23:00 は神戸大の表11でゴトー日の累計が最も大きかった時刻で、論文の期間で選ばれた数字。ここの期間は論文の後なので、選び直していない。
    - 時刻はすべて UTC のミリ秒で決める（日本に夏時間は無い）。日 D の入る足の始まりは Date.UTC(D) − 10時間（前の日 14:00 UTC）、出る足の始まりは Date.UTC(D) + 55分（00:55 UTC）。日のファイルは D−1 と D の両方を Bid・Ask で読み、openTime がこの値と同じ足を使う。ファイルの名前や並びの位置で足を選ばない。同じ足が2つのファイルにあれば1回だけ数える。実行環境のタイムゾーンで答えが変わる関数は使わない。
    - 入る足・出る足は、Bid と Ask の両方に同じ openTime の足があり、Ask の始値が Bid の始値以上の足だけを使う。
    - 入る足: 23:00 の足が使えなければ、23:01〜23:04 の最初の使える足の始値で買う。無ければ、その日は取引しない（23:00 の時点で分かることなので外してよい）。
    - 出る足: 9:55 の足が使えなければ、9:56〜10:54 の最初の使える足の始値で売り、何分あとに売ったかと数を出す。10:54 までに無ければ「出られない日」として主から外し、日付を出す。説明用に、9:55 ちょうどで出られた日だけの数字も出す。
    - 使えない理由は4つに分け、ゴトー日・比べる日ごとに数と日付を出す。①市場の休み（前後30分に Bid・Ask とも足が無い）。②欠け（前後30分には足がある）。③片側だけ、または Ask が Bid より安い。④ファイルが無い（404）。
    - 月曜は、前の日（日曜）の 23:00 に GMO の市場が開いていない（GMO の週は日曜 22:00 UTC＝月曜 07:00 JST に始まる。§8.93）。そのため主の比べ方には入れず、ゴトー日と比べる日の両方から外して数を出す。祝日明けの日は外さない（FX は日本の祝日も開いていると考えているが、確かめていない。祝日の 23:00 に足があるかは祝日ごとに数えて結果の前に出し、無ければ上の入る足の決まりで外れる）。
  - **曜日をそろえた差**: 火・水・木・金の曜日ごとに「ゴトー日の平均 − 同じ曜日の比べる日の平均」を出し、ゴトー日の曜日ごとの回数で重みを付けて足す。判定の差には、これを使う（ゴトー日は前倒しで金曜に集まるので、そろえない差には「木曜の夜〜金曜の朝」の動きが混ざるため）。そろえない差（神戸大と同じ比べ方）は説明用に並べる。曜日ごとの回数は、結果の前に出す。
  - **出すもの**: ゴトー日と比べる日のそれぞれで次を出す。
    - 回数、勝った割合（損益が0より大きい回÷全部の回。0ちょうどの回は数を別に出す）とその95%の幅（Wilson）。
    - 1回あたりの損益（銭＝pips）の平均・中央値・5%・25%・75%・95%の点。勝ちの平均・負けの平均と、損益ゼロに要る勝率。1万通貨あたりの円（1銭＝100円）。
    - 払ったスプレッド＝（入りの Ask − 入りの Bid）/2 ＋（出の Ask − 出の Bid）/2。23:00 と 9:55 のスプレッドも別に出す。
    - 日付順の累計の損益と、その最大の落ち込み、最長の連敗、最悪の1回。
    - 最大の逆行＝23:00 の足から 9:54 の足までの Bid の安値の最小 − 入りの Ask（9:55 の足は入れない）。中値で見た値と、05:00〜07:59 JST の足を除いた値も並べ、最悪が起きた時刻を出す。
    - 論文と並べるため、中値の始値どうしの損益（スプレッドを引く前）と、それから2銭を引いた値（判定には使わない）。
    - 損益は、価格を 0.001円単位の整数にして計算する。
  - **95%の幅**（3つ出す）: (1) t の幅（ゴトー日の平均は1つの組の t、差は Welch の t。曜日をそろえた差は曜日ごとの分散から標準誤差を出し、自由度は Welch–Satterthwaite）。(2) 日ごとに引き直すブートストラップ（ゴトー日と比べる日を別々に、曜日ごとに、それぞれの回数のまま。百分位、10,000回、種を固定）。(3) 月ごとに引き直すブートストラップ（暦の月を単位に、その月のゴトー日と比べる日をまとめて引き直す。重みは引き直すたびに計算し直す。百分位、10,000回、種を固定）。判定には、3つのうち下の端がいちばん低いものを使う。
  - **判定の決まり**:
    - 「使える候補」と言うのは、ゴトー日の1回あたりの平均の95%の幅の下の端が0より上で、かつ、曜日をそろえた差の95%の幅の下の端も0より上のときだけ。
    - 結果の読み方を3つ、先に決める。(a) 使える候補（上の決まり）。(b) 曜日をそろえた差の95%の幅の上の端（3つのうち最も高いもの）が +9銭（神戸大の差）より下なら、「神戸大と同じ大きさの効果は、この期間には見られない」と書く。(c) どちらでもなければ、「回数が足りず決められない」と書き、効果がないとは書かない。
    - (a) でも、すぐには使わない。2026-10-05 以降の日で同じ取引を記録して確かめる。その確かめの決まりは、記録を見る前に別の節で決める。
    - 見つけられる最小の差＝標準誤差×2.8（その大きさの差が本当にあれば、10回に8回は幅の下の端が0を超える大きさ）。標準誤差には、3つの幅のうち最も広いもの（幅の半分÷1.96）を使う。
    - データの前の見込み: 23:00〜9:55 の標準偏差を 50・60・70銭と仮定する（ドル円の年率約10%からの見積もりで、GMO のデータからではない）。神戸大と同じ大きさの効果でも、この決まりで「使える候補」と出る見込みは約2〜4割で、曜日をそろえた差と3つの幅の低い方を使うと、さらに下がる見込み。作り物で計算した値（下の検出力の表）をここに書いてから、実データを読む。
    - 前半と後半は、最初の日が決まった時点で、暦の上で主に入るゴトー日の数がちょうど半分になる日付で分ける（値段は見ない）。暦の年ごとの表も出す。どれも判定には使わない。
    - 結果を見たあとで日を外さない（介入や指標の夜も入れる）。
    - 勝った割合が65%以上の組を、説明用の表も含めてすべて一覧にし、100回未満の組には印を付ける。主の組で勝った割合が65%以上のとき、またはゴトー日の中値での1回あたりが +17銭（神戸大の約 +8.3銭の約2倍）以上のときは、報告の前に先読みを調べる（CLAUDE.md の決まり）。
  - **説明用**（判定には使わない。表の幅は1つずつの95%の幅で、見た数〈何通りか〉を表の上に書く。入る時刻の表と取引B の表には Bonferroni の幅も並べる。説明用で良く見えたものは、2026-10-05 以降のデータで別に決めてから測る候補にするだけ）:
    - 入る時刻を 22:00〜9:00 の毎時（神戸大の表11と同じ）にした場合の、ゴトー日と比べる日の累計と1回あたり。毎時 h 時の入りは、h が 0〜9 なら Date.UTC(D) + (h−9)時間、22・23 なら Date.UTC(D) + (h−33)時間。時刻ごとの払ったスプレッドの中央値を並べ、06:00・07:00 の行に「日の切り替わり」と書く。
    - 曜日ごとの差（火・水・木・金のそれぞれで、ゴトー日 − 比べる日）。曜日をそろえない差。
    - 金曜のゴトー日だけ（主の取引を金曜のゴトー日に限り、金曜の比べる日と比べたもの）。ザイFX! の 7時→10時は測らない。
    - 9:55 に Bid で売り、11:00〜22:00 に Ask で買い戻す側（神戸大の取引B）。
    - 月曜を入れた場合（月曜 08:00 JST〈日曜 23:00 UTC〉に始まる1分足の Ask の始値で買う）。
    - 比べる日から月の最後の営業日を除いた平均と差。ゴトー日の次の営業日を「偽のゴトー日」とした、曜日をそろえた差（0の近くに出るはず）。
    - 入るのを 23:01、出るのを 9:56 の足の始値にずらした場合（1分遅れ）。23:00 と 9:55 のスプレッドの中央値と95パーセンタイルを、米国の夏時間と冬時間に分けて。
    - 両方の組で、損益の大きい5日と小さい5日（日付つき）。上下それぞれ1%（端数は切り上げ）を除いた平均。財務省が公表した為替介入の日に入るか出る取引を除いた平均。払ったスプレッドの大きい10回（日付つき）。12/24〜12/27・12/30〜1/5 に入るか出る回の一覧（除かない）。
    - 1回の損益の、1日ずれの自己相関と、その2乗の自己相関（ゴトー日・比べる日・すべての営業日の並び）。
    - ゴトー日の平均の95%の幅の下の端（銭）を、「1回あたりの追加の費用（楽天FXとの差・すべり）がこれ以下なら、まだ0より上」の目安として書く。
  - **先に作り物で確かめること**（実データを読む前）:
    - **足の作り**（1分足の作り物。雑音なし）: ①中値は一定、スプレッドは 23:00 が1.0銭・9:55 が0.2銭なら、すべての取引の損益がちょうど −0.6銭、勝った割合0%（取り違えると、中値どうしなら0、Ask と Bid が逆なら +0.6、Ask どうしなら −0.4、Bid どうしなら +0.4）。②ゴトー日の 23:00〜9:55 に +5銭なら、ゴトー日がちょうど +4.4銭、比べる日がちょうど −0.6銭。③同じ +5銭をゴトー日の次の営業日に入れると、ゴトー日は −0.6銭（1日ずれの検出）。④ゴトー日の1日前の窓に入れても −0.6銭。⑤UTC とみた窓（JST の 8:00〜18:55）に入れても −0.6銭。⑥22:59 の足の中と、9:55 の足の始値より後に飛びを入れても主は変わらない。23:00 の足の始値より後に入れると主に出る。⑦23:00 より前の足を何本か消しても、入る時刻は 14:00 UTC のまま。⑧日のファイルを夏は 21:00 UTC・冬は 22:00 UTC で区切った作り物と、区切らない作り物で結果が同じ。⑨毎時の表で、0:00〜9:00 の入りはゴトー日の当日、22:00・23:00 の入りは前の日。
    - **ゴトー日の決め方**（手で作った日付）: 2023-11-05(日)・2024-02-25(日)・2024-05-05(日) は前倒しの先の金曜が祝日なのでゴトー日なし、あいまいな日は 2023-11-02・2024-02-22・2024-05-02。2025-01-05(日) は前倒しの先の 01-03 が休みなのでゴトー日なし（直前の営業日 2024-12-30〈月〉はゴトー日だが、月曜なので主には入らない）。前倒しの先が金曜: 2024-07-15(月・祝)→07-12、2025-05-05(月・祝)→05-02、2025-09-15(月・祝)→09-12、2026-07-20(月・祝)→07-17。ゴトー日なしであいまいな日がある: 2026-03-20(金・祝) の 03-19(木)、2026-05-05(火・祝) の 05-01(金)。2025-11-25(火) はゴトー日で主に入る。2024-03-01(金) は比べる日で、入りは 2024-02-29 23:00。2025-09-12（9/15 の前倒し）の入りが 2025-09-11T14:00:00Z、出が 2025-09-12T00:55:00Z。どの平日も、ゴトー日・比べる日・あいまいな日・外した日（理由つき）のどれか1つだけに入ること。
    - **数の確かめ**（1日1回の損益を直接作ってよい。ブートストラップは2,000回にしてよい）: 作り物の値動きの大きさは、データを見ずに決めた3通り（23:00〜9:55 の標準偏差が 50・60・70銭）。荒れる時期がかたまる形と、まれな飛び（1年に数回、200〜500銭）を入れる。
      - 効果なし（60銭）を1,000通り流す。「使える候補」と出た割合が2.5%以下。差の95%の幅が0を含まない割合と、ゴトー日の平均の95%の幅が本当の値を含まない割合が、3つの幅それぞれで2.9〜7.1%。
      - すべての日に +3銭と、金曜だけ +10銭（ゴトー日と関係なし）を、それぞれ200通り。「使える候補」と出た割合が2.5%以下。金曜の作り物では、曜日をそろえた差の平均が0±1銭、そろえない差の平均が「金曜の割合の違い×10銭」±1銭。
      - ゴトー日の 23:00〜9:55 だけに +5・+10・+20銭と、神戸大と同じ形（スプレッドを引く前にゴトー日 +8.3銭・比べる日 −0.7銭）を、3つの大きさでそれぞれ200通り。曜日をそろえた差の推定の平均が入れた大きさの±2銭以内。「使える候補」と出た割合（検出力）を表にし、実データの前に docs に書く。
      - 線から外れたら、実データを読む前に原因を調べる。決まりを直すなら、直したことと理由を docs に書いてから読む。
  - **作り物での確かめの結果と、実データの前に直したこと**（2026-10-04。Actions run 37167676229 の synthetic。手元で走らせた結果と同じ数字。下の見直しのあとの run 37169395968 でも、表Aまでの数字は同じ）:
    - 足の作り①〜⑨・予備の足・売り買いの側・ゴトー日の決め方（手で作った日付）は、すべて通った。
    - ⑤ の窓を JST 10:00〜18:55 に直した。上の「JST の 8:00〜18:55」では 9:55 の売りが窓の中に入り、正しいプログラムでも +5銭を取ってしまう。UTC と取り違えたプログラムは 23:00 UTC（JST 8:00）に買い 09:55 UTC（JST 18:55）に売るので、10:00〜18:55 の窓なら取り違えたものだけが +5銭を取る。
    - ③ の作り物で、期間の最後のゴトー日の次の営業日を探す所が終わらなかった（プログラムの誤り。直した）。
    - 数の確かめで線から外れたもの（最初に手元で走らせた結果）と、原因と直し:
      1. ブートストラップ2つの95%の幅が狭かった。効果なし1,000通りで、本当の値を含まない割合が、日ごとは差 7.5%・ゴトー日の平均 8.0%、月ごとは 9.2%・9.3%（線は 2.9〜7.1%）。t の幅は 6.0%・6.4% で線の中。
         - 切り分け（手元、600通りずつ、効果なし）: 荒れる時期のかたまりも飛びもない正規分布では、t 4.3〜5.3%・日ごと 5.7〜6.0%・月ごと 6.7%。荒れる時期のかたまりだけを入れると、月ごと 9.2〜9.7%・日ごと 6.7〜7.0%（t は 5.2〜5.3%）。まれな飛びだけでは、月ごと 6.7〜6.8%。原因は、荒れる時期がかたまることと、月の数が36しかないこと。ブートストラップの計算の誤りではない（Actions でも正規分布の作り物を流し、t 3.4%・5.2%、日ごと 3.4%・5.5%、月ごと 5.7%・5.8% と出した）。
         - 直し: 2.9〜7.1% の確かめは t の幅だけにし、ブートストラップの2つは外れる割合を出すだけにした。判定は3つの幅のうち下の端がいちばん低いもの（読み方 b は上の端がいちばん高いもの）を使うので、狭いブートストラップが判定を甘くすることはない。結果の報告でも、ブートストラップの幅には「作り物では95%より狭く出た」と添える。
      2. 「金曜だけ +10銭」で「使える候補」と出た割合が 2.6%（線は 2.5%以下）。この作り物ではゴトー日の平均が金曜の分だけ上がるので、「使える候補」の割合は、曜日をそろえた差の片側の誤りの 2.5% にもともと近い。2.5% ちょうどの線では、作り物の回数による揺れだけで落ちる。
         - 直し: 「使える候補 2.5%以下」の3つの確かめ（効果なし・すべての日 +3・金曜 +10）の線を、2.9〜7.1% の帯と同じく、作り物の回数の標準誤差の3倍を足した値にした（1,000通りで 4.0%、200通りで 5.8%）。
      3. 「金曜だけ +10銭」の「曜日をそろえた差 0±1銭」は、200通りでは ±1 が標準誤差の約1.8倍しかなく、正しく作れていても7%ほどの確率で落ちる。
         - 直し: 効果なしと同じ種で1,000通りにした。あわせて、同じ種で効果あり・なしを並べ、差がぴったり入れた大きさだけ動くかの確かめを足した（金曜 +10 では曜日をそろえた差が 0、そろえない差が「金曜の割合の違い×10銭」。ゴトー日 +5・+10・+20銭と神戸大の形では、どちらの差もその大きさ）。200組で、ずれは最大 4×10⁻¹⁴銭。
    - 直したあとの結果（run 37167676229 では58の確かめ、下の見直しのあとの run 37169395968 では70の確かめが、すべて通った）: 効果なしで「使える候補」0.8%、t の幅が外れた割合は差 6.0%・平均 6.4%（参考: 日ごと 7.5%・8.0%、月ごと 9.2%・9.3%）。すべての日 +3銭で 0.0%。金曜 +10銭で 2.6%、曜日をそろえた差の平均 −0.27銭、そろえない差の平均 3.24銭（金曜の割合の違い 49.7%−14.8%＝0.349 → 3.49銭）。
    - **検出力の表**（作り物の暦は 2023-10-31〜2026-10-02 で、主のゴトー日 173・比べる日 405。下見で決まった実データの暦と同じ。実データで足が無くて外れる日があれば、そのぶん減る。各200通り、「使える候補」と出た割合、かっこ内は曜日をそろえた差の推定の平均〈銭〉。run 37169395968）:
      - 見直しで、上の「標準偏差 50・60・70銭」は、作り物では飛び（200〜500銭）を足す前の部分の大きさになっていて、飛びを入れた全体では約 68・75・83銭だったことがわかった（作り物を200通り流して測った値）。決めたとおりに作った表を A とし、全体を 50・60・70銭にそろえた（飛びも含めて全体を縮めた）表 B を足した。実データの1日の標準偏差（結果と一緒に出す）に近い方の行を読む。
      - 表A（決めたとおり。50・60・70銭は飛びを足す前。かっこ内は全体の標準偏差）:

        | 標準偏差 | ゴトー日 +5銭 | +10銭 | +20銭 | 神戸大の形（ゴトー日 +8.3・比べる日 −0.7、差 9.0） |
        |---|---|---|---|---|
        | 50銭（全体 67.5） | 8.0%（5.1） | 19.5%（9.8） | 73.5%（19.5） | 26.0%（9.9） |
        | 60銭（全体 75.1） | 6.0%（6.0） | 21.5%（9.9） | 66.0%（19.8） | 17.0%（9.7） |
        | 70銭（全体 83.2） | 5.0%（5.8） | 16.5%（10.4） | 62.0%（20.1） | 15.0%（10.3） |

      - 表B（全体の標準偏差をそろえた。かっこ内の最初は測った全体の標準偏差）:

        | 全体の標準偏差 | ゴトー日 +5銭 | +10銭 | +20銭 | 神戸大の形 |
        |---|---|---|---|---|
        | 50銭（49.8） | 7.5%（4.4） | 47.5%（9.8） | 94.5%（20.5） | 38.0%（9.3） |
        | 60銭（59.8） | 7.5%（5.3） | 34.5%（10.3） | 82.5%（19.8） | 22.5%（8.9） |
        | 70銭（69.7） | 5.5%（5.0） | 21.5%（10.5） | 77.0%（19.7） | 16.5%（9.0） |

      - 神戸大と同じ大きさの効果が今もあっても、この決まりで「使える候補」と出るのは 15〜38%（データの前の見込みの「約2〜4割より下がる」のとおり）。「使える候補」と出なくても、効果がないとは言えない。読み方 (b)（曜日をそろえた差の幅の上の端が +9銭より下）か (c) かで書き分ける。
  - **プログラムの独立した見直し**（2026-10-04、実データの値段を読む前。4つの見方〈取引と足・暦と祝日・統計と判定・出すものとデータの扱い〉で読み、指摘ごとに別のエージェントが反証を試みた）: 指摘は35件（重なりを含む）。反証の確かめで28件が残り、すべて直した（commit dda8932）。
    - データの扱い: GMO の答えを、status 0 で足の一覧があるかを確かめる前に保存していた。メンテナンスの答え（status 5）を保存すると、次の実行でも読み直さずに止まり続ける。いまは使える答えだけを保存し、それ以外は3回読み直して止まる。
    - 決めたのに出していなかった数字: 9:55 ちょうどで出られた日だけの数字、月曜を入れた比べ方（月曜を5つ目の曜日として足す）、月末を除いた比べる日の平均（END の月の最後の営業日を END と取り違えていたのも直した）、外した理由4つごとのゴトー日・比べる日の数と日付、毎時の表と取引B の1つずつの95%の幅（Bonferroni と並べる）と毎時の表の比べる日の累計、曜日ごとの差の幅。
    - 決めた定義との違い: 毎時の表の払ったスプレッドが入りのスプレッドそのものだったのを、入りと出の半分ずつにした。年末年始の一覧を、出た日だけでなく入った日でも拾うようにした（2023-12-28 と 2026-01-06 が漏れていた）。勝率65%以上の一覧に、説明用の表を含むすべての組を入れた。
    - 暦: 「どの平日も1つだけに入る」の確かめが落ちようのない形だったので、すべての月〜金を、暦の3つの区分か「理由つきで外した日」（祝日の名前、または 12/31〜1/3）のどれか1つに入ることで確かめるようにした（713日＋外した52日、ずれ0）。日ごとの表にも外した平日を理由つきで入れる。神戸大の期間の数え方は、上の下見の結果のとおり。
    - 退けられた7件のうち、手間が小さく害のないものは入れた: 最初の日の前に足の無い日が14日以上あることの確かめ、祝日の一覧の出どころ・行数・sha256 を research/out に残すこと、土日の 404 を欠けたファイルと分けること、欠けを数える範囲を読んだファイルに合わせること、祝日の 23:00 の足を月〜木の祝日だけで数えること、作り物の job に最初の日を渡すこと。
    - あわせて、GMO の答えを作り物に差し替えて本番の形を手元で通しで走らせた（scratchpad の作り物で、commit しない）。すべての平日が日ごとの表に1行ずつ入ること（765行＝営業日 713＋外した平日 52）、払ったスプレッドが作ったとおり 0.6銭になること、メンテナンスの答えを保存しないこと（4回読んで止まり、次の実行ではそのファイルだけを読み直して最後まで通る）を確かめた。
  - **下見の結果**（2026-10-04、Actions run 37168015998 の prepare、見直しのあとの run 37169395968 でも同じ。値段は読んでいない。ファイルがあるかと足の数だけ）:
    - 祝日の一覧: 1,067行、sha256 cec37a743c96995cdb9cb52b685c9003634682a9b0e1a640a6b9b96881fe964a。既知の日はすべて入っていた。測る期間の年（2023〜2026）は 17・21・19・18日で、16〜21日の中。
      - 最初の run 37167676229 では、プログラムが神戸大の期間の年（2007〜2022）にも16〜21日の確かめをかけていて、2011年（15日。元日が土曜で振替休日が無い年）で止まった。決まりは「測る期間の各年」なので、プログラムをそれに合わせた（神戸大の期間の年は数を出すだけ。2019年は22日）。
    - **最初の日は 2023-10-27（金）**（GMO の USD_JPY 1分足で、Bid・Ask の両方に足がある最初の日のファイル。どちらも1,440本）。2019-01〜2023-10 の各月の初めの平日には足が無く、2023-11-01 にはあった。2023-09-22〜2023-10-26 の35日には、Bid に足のあるファイルが無かった（Ask は、Bid に足がある日だけ読んだ）。
      - 最初の取引の日は、入る足（前の日 23:00 JST）が 2023-10-27 以降のファイルにある最初の営業日の 2023-10-30（月）。月曜は主に入らないので、主の最初は 2023-10-31（火）。
    - 暦（2023-10-30〜2026-10-02）: 営業日 713、ゴトー日 200（うち月曜 27）、あいまいな日 7。主（火〜金）のゴトー日は 火28・水30・木29・金86 の 173日、比べる日は 火115・水114・木116・金60 の 405日。期間の中の祝日は 57日。
      - ゴトー日なし: 2023-11-05・2024-02-25・2024-05-05・2025-01-05（前倒しの先が休み）、2024-03-20・2025-03-20・2026-03-20・2026-05-05（火〜金の祝日）。
      - あいまいな日: 2023-11-02・2024-02-22・2024-03-19・2024-05-02・2025-03-19・2026-03-19・2026-05-01（2025-01-05 の直前の営業日 2024-12-30 はゴトー日のまま）。
      - 前半と後半の分かれ目は 2025-05-09（後半の最初のゴトー日。前に 86日）。
    - 神戸大の期間（2007-01-01〜2020-01-31）をこの決め方で数えると、ゴトー日 902日（論文 900日）。ゴトー日でない月〜金は、祝日と 12/31〜1/3 も含めると 2,513日で、論文の 2,513日と同じ（その期間の月〜金は 3,415日）。営業日だけなら 2,299日（比べる日 2,276・あいまいな日 23）。論文のゴトー日でない日は、祝日も含めた月〜金の数とみられる（最初の run 37168015998 では営業日だけを出していて、見直しで直した）。ここの比べる日は営業日だけなので、論文とは数が違う。決まりどおり、決め方は変えない。
- **結果**（2026-10-04、Actions run 37170186723〈mode=real、FIRST=2023-10-27、END=2026-10-02、commit 961fe49〉。保存した日のファイルからの再実行と独立した確かめは run 37171230155）:
  - **結果の前に出した確かめ**:
    - 月〜金の日のファイルはすべて読めた（404 なし）。1分足は Bid・Ask とも 1,084,958本。
    - 取引時間（月 08:00〜土 05:00 JST）の中で欠けた1分足は 8,842本。ほぼすべてが 12/25 と 1/1（GMO が休み。1日 1,320〜1,440本）と、その翌日の最初の1時間（60本ずつ）。ほかは 2025-09-08（月）の 79本と、ばらばらの3本だけ。
    - 月〜木の祝日 41日のうち 38日に 23:00 の足があった。無かったのは 1/1 の3日（休み）。
    - 主から外した日は5日。ゴトー日2日（2024-12-25・2025-12-25、出る 9:55 が休み）と、比べる日3日（2023・2024・2025年の 12/26、入る前の日の 23:00 が休み）。理由はすべて「市場の休み」。9:55 より後に売った日は 0。
  - **主の取引**（前の日 23:00 JST の Ask で買い、9:55 JST の Bid で売る。火〜金。スワップは入れていない）:

    | | 回数 | 勝った割合（95%の幅） | 1回あたりの損益（95%の t の幅） | 中央値 | 勝ちの平均 / 負けの平均 | 損益ゼロに要る勝率 | 累計 | 最大の落ち込み | 最長の連敗 | 最悪の1回 |
    |---|---|---|---|---|---|---|---|---|---|---|
    | ゴトー日 | 171 | 55.6%（48.1〜62.8%） | +6.15銭（−1.40〜+13.70） | +7.00 | +37.89 / −33.53 | 46.9% | +1,051.7銭 | −372.1銭 | 9 | −174.2銭（2023-12-08） |
    | 比べる日 | 402 | 57.2%（52.3〜62.0%） | +1.71銭（−3.58〜+6.99） | +6.35 | +34.27 / −41.83 | 55.0% | +685.7銭 | −1,098.1銭 | 7 | −282.0銭（2023-12-14） |

    - 1万通貨あたりでは、ゴトー日は1回 +615円、比べる日は +171円。払ったスプレッドの中央値はどちらも 0.50銭（23:00 は 0.50・0.40、9:55 は 0.50）。
    - 最大の逆行（持っている間の最悪）は、ゴトー日で中央値 −25.1銭、最悪 −324.3銭（2023-12-08、17:47 UTC）。比べる日で中央値 −25.8銭、最悪 −320.3銭。損切りは置いていない。
    - 中値どうし（スプレッドを引く前）は、ゴトー日 +6.66銭・比べる日 +2.20銭。神戸大の約 +8.3銭と並べるための値で、2銭を引くと +4.66銭（判定には使わない）。
    - 1日の損益の標準偏差は、ゴトー日 49.99銭・比べる日 53.91銭。検出力の表Bの「50銭」の行が近い（神戸大と同じ大きさの効果で、「使える候補」と出る見込みは 38%）。
  - **判定**: ゴトー日の平均 +6.15銭の3つの幅は、t −1.40〜+13.70、日ごと −1.42〜+13.70、月ごと −2.11〜+14.14 で、いちばん低い下の端は −2.11。曜日をそろえた差 +7.51銭の3つの幅は、t −2.83〜+17.86、日ごと −2.61〜+17.57、月ごと −4.36〜+19.38 で、いちばん低い下の端は −4.36、いちばん高い上の端は +19.38。
    - 読み方は **(c) 回数が足りず決められない**。「使える候補」の決まり（2つの下の端がどちらも0より上）には届かず、上の端が +9銭（神戸大の差）より上なので (b) でもない。効果がないとは言えない。神戸大と同じくらいの効果があるとも、無いとも言えない。
    - そろえない差（神戸大と同じ比べ方）は +4.44銭（−4.75〜+13.64）。見つけられる最小の差（いちばん広い幅の標準誤差×2.8）は 16.96銭で、神戸大の 9銭より大きい。約3年・171回では、神戸大の大きさの効果を見分けるには回数が足りない。
    - ブートストラップの2つの幅は、作り物では95%より狭く出た（上の作り物での確かめ）。判定には、3つのうち下の端がいちばん低いもの・上の端がいちばん高いものを使った。
  - **説明用**（判定には使わない。幅は1つずつの95%の幅）:
    - 曜日ごとの差: 火 +2.51（−13.36〜+18.38）、水 +2.83（−20.83〜+26.50）、木 +0.42（−27.82〜+28.66）、金 +13.03（−3.05〜+29.11）。金曜のゴトー日だけでは、86回で勝った割合 58.1%・平均 +7.34銭、金曜の比べる日は 59回で平均 −5.69銭。
    - 前半（〜2025-05-08）の曜日をそろえた差は +13.65（−3.16〜+30.46）、後半は −0.03（−12.26〜+12.20）。年ごとは 2024年 +8.11・2025年 +16.22・2026年 −5.55（2023年は11〜12月の9回だけ）。
    - 入る時刻の表（12行）: 0:00 と 1:00 に入った場合のゴトー日の平均は +6.72・+5.93銭で、1つずつの95%の幅は下の端がわずかに0より上（+0.02・+0.16）。12行を見た Bonferroni の幅は0を含む。06:00〜08:00 JST に入ると、払ったスプレッドの中央値が 5.85〜6.35銭になる（GMO の日の切り替わりでスプレッドが広がる）。
    - 神戸大の取引B（9:55 に売り、あとで買い戻す）: ゴトー日では 11:00〜15:00 に買い戻すと平均 +2.8〜+3.6銭（向きは神戸大と同じ）で、どれも1つずつの幅が0を含む。比べる日は −3.6〜+0.3銭。
    - 月曜だけ（08:00 JST に買う）: ゴトー日 26回 −2.86銭、比べる日 101回 −7.87銭。月曜を5つ目の曜日として足すと、曜日をそろえた差は +7.18（−1.94〜+16.31）。
    - 比べる日から月の最後の営業日を除くと、差は +7.97（−2.63〜+18.58）。ゴトー日の次の営業日を偽のゴトー日にすると +1.22（−10.19〜+12.64。0の近くに出るはずのもの）。1分遅らせる（23:01→9:56）と +7.83。2024年の介入の日に入るか出る取引を除くと +7.36。上下1%を除いた平均は、ゴトー日 +5.98・比べる日 +2.36。
    - スプレッド: 23:00 の中央値 0.40銭（95パーセンタイルは米国の夏時間 0.9・冬時間 0.7）、9:55 の中央値 0.50銭（同 1.0・1.2）。いちばん大きく払ったのは 2024-08-06 の 1.8銭。
    - 1回の損益の1日ずれの自己相関は、ゴトー日 0.137、比べる日 0.018。
  - **勝った割合が65%以上の組と、先読みの確かめ**: 一覧に入ったのは「2026年の比べる日」の 66.3%（101回、1回あたり +9.54銭）だけ。主の組はどちらも65%未満で、中値での1回あたりも +17銭未満なので、決まりでの必須の確かめには当たらない。それでも、測定プログラムとは別に書いた小さなプログラム（research/gotobi-check.py）で、GMO の生の日のファイルからすべての取引の時刻・値段・損益と組ごとの勝率・平均を計算し直した（run 37171230155）。573回すべてで一致し、食い違いは0。この取引は時刻だけで決まり、条件が無いので、先の足を使う入り口が無い。2026年の 66.3% は、その年にドル円が夜の間に上がった日が多かったことを表すもので、ゴトー日の効果ではない。
    - 確かめのプログラムが誤りを見つけられることは、手元の作り物で、損益を1つ +5銭ずらした表と、入りの時刻を1時間ずらした表の両方を見つけることで確かめた。
  - **このあと**: 決まりどおり (c) なので、使える候補にはしない。説明用で良く見えたもの（金曜のゴトー日、0:00・1:00 の入り、取引B）は、2026-10-05 以降のデータで、別に決まりを書いてから測る候補にとどめる（今は測らない）。

- **限り**（先に書いておく）:
  - 暦の上のゴトー日は年に約70日だが、主に入るのは、月曜・祝日・あいまいな日を除いて年に約55〜60日（暦での見積もり）。実際の数は、結果の前に出す数で置き換える。神戸大（13年で900日）より回数はずっと少ない。
  - スワップは損益に入れない（GMO の公開データに過去のスワップが無いため。論文が入れたかは未確認）。この取引は毎回日の切り替わりをまたぐので、実際の口座では毎回スワップが付く。ドル円の買いは、米国の金利が日本より高いあいだは受け取る側。計算上の目安は1日1〜2銭（金利差3〜5%×約150円÷365。業者が払った額ではない）。週末の分をまとめて付ける曜日がある（どの曜日かは未確認）。曜日をそろえた差では、曜日ごとの付き方の違いはおおむね打ち消し合う。
  - 楽天FXの 23:00 と 9:55 のスプレッド・すべり・日の切り替わりの時刻は調べていない（GMO の売値・買値で測る）。
  - 仲値の型は日本の企業の実需から来るとされ、ほかのペアや時間足には当てはまらない。

### 8.97 損切りを 2N（値幅の2倍）にした場合を測る（#187、研究のみ）

- **指示**（2026-10-04）: §8.95 の候補から、オーナーが「ゴトー日のドル円」「損切りを値幅の2倍に」「資金管理の試算」を選んだ。順番に1つずつ測る。これはその2つ目（ゴトー日は §8.96）。
- **注**: この節の「今」は #192 の前のメールの水準（FX は損切り30・利確 20・40・60 pips）。同じ日の #192 で損切り13・利確 4・10・16 に変えた（§8.98）。
- **問い**: 今のメールの合図（Q-Trend と ULTRA の4時間足）で、損切りを固定の30 pips から「値幅の2倍」にすると、同じ取引で、勝率・1回あたりの損益・最大の落ち込みがどう変わるか。
  - タートル（§8.95）の真似のうち、損切りの置き方だけを変える。量の決め方（1回の危険を口座の1〜2%にする）と、タートルの入り方・出方は変えない（量は #188 で別に測る）。
- **前の調べ**（読み取りだけ、5人のワークフロー。下の測り方はこれを元に決めた）:
  - 今メールが届くのは、オーナーの購読している Q-Trend と ULTRA の4時間足だけ（21銘柄、§8.91）。FX の損切りは30 pips、利確は 20・40・60 pips（`_shared/ultra.ts` の `ULTRA_PAIRS`）。金は損切り10ドル・利確 30・60・90ドル。水準は合図の足の中値の終値から測る。
  - 値幅（ATR）を損切りに使った測定は、金の §8.79（利確も ATR の倍数）だけ。FX のメールの合図で、利確は今のまま損切りだけを ATR の倍数にした測定は無い。
  - 損切りを広げた前の測定（§8.77、利確5のとき）では、広げるほど勝つ割合は上がったが、1回あたりの差ははっきりせず、同じ大きさの差が物差し（すべての足で入った場合）にも出た（合図ではなく決済の差）。
  - 合図の測定で、最大の落ち込みを出したことは無い。
- **見直し**（データを見る前。統計・データ・作りの3つの見方で誤りを探し、見つかったものを、それぞれ別の人が反証した。ワークフロー、6人）: 最初の下書き（2846528）から、本当とされたものを直した。下の測り方は直した後のもの。
  - 直したもの:
    - 勝率の数え方。決着した取引の中の割合は、時間切れ（多くは損）を除く。そのため、効き目が無くても、損切りを広げると「損切りの幅 ÷（幅＋20）」より上に出る（反証した人の作り物の値動きで、2N が約110 pips のとき 88.7% 対 84.6%）。見出しの勝率を、すべての取引の中の割合にした。
    - 持っている間の逆行（最大の逆行）を足した。決済で数えた落ち込みには、広い損切りで持っている間の含み損が入らないため。
    - 作り物の確かめ。§8.83 の候補ごとの関門（z のばらつき、下の端が0より上の回数、物差しの差の偏り）を戻した。drift の大きさを決め、逆向きの値動き（against）を足した。2N・2A の損切りの置き場所を直接確かめるもの（理屈の割合と、損切りの価格）を足した。
    - §8.83 の数字の再現（WEEKEND=stamp）、GMO の読み込みの失敗0（日足を含む）、N の無い取引0、日足の古さを足した。
    - 次のものを決めた: 見つけられる最小の差、「プラスと言える」の区間、説明用の表の見た数、§8.24 の①との関係、前に見た数字、区間の作り（§8.83 と同じ言い方に直した）、丸め方、実データの後の確かめの中身。
  - 直さなかったもの（反証で、本当でない、または結果を変えないとされたもの）:
    - 損益ゼロの線を ΣS/(ΣS+20×回数) にする案。効き目が無いときの割合は、取引ごとの S/(S+20) の平均のほうで、案の式は誤り。
    - R をばらつきで割る案。
    - スワップの夜の数を必須にする案（安いので説明用に出す）。
    - 120本の区間の案。
    - 作り物の日足を GMO と同じ作りにする案（下に違いを書いておく）。
    - 値動きの大きさが変わる作り物を足す案。反証した人の計算では、週・4週の区間はずれなかった（z のばらつき 1.01）。実データから見つけられる最小の差を出すことで代える。
- **測り方**（データを見る前に決める。`research/stop2n.ts`。§8.83 の `research/widetp.ts` を元にする）:
  - **データと期間**: GMO の4時間足・5分足・日足（Bid・Ask）。START 2024-01-01、END 2026-10-02 21:00 UTC（決めた時刻で固定し、やり直しても同じ足を読む）。前半は 2025-05-18 まで（SPLIT 2025-05-19、§8.77 から同じ）。週末の足の扱いは #182 の後のもの（`barInsideClosure`。入力 WEEKEND=inside が既定。stamp は #182 の前の扱いで、下の再現にだけ使う。tf-winrate と同じ）。
  - **合図**: メールで送られる Q-Trend と ULTRA（4時間足）。メールの関数（`indicatorSignals`）との照合を、§8.83 と同じく行う。読む時刻は #171 の後のもの（確定の0・4・6分後）。同じ足・同じ向きの合図は1つの取引として数える（「どちらか」。§8.83 と同じ）。合図ごと（Q-Trend・ULTRA・STRONG）の数字は説明用に出す。
  - **入り**: 合図の足の終値。買いは Ask、売りは Bid（スプレッドを払う）。損切りと利確の水準は、メールと同じく中値の終値から測る。
  - **利確**: 今のメールの利確1（20 pips）で全部を決済する。利確2・3に届いた割合は、同じ損切り・同じ30本で、利確を 40・60 にして追ったもの（説明用）。
  - **損切り**（S）:
    - 今: 30 pips（メールの計算のまま。丸めない）。
    - **2N**（タートル）:
      - N は日足の真の値幅の20日平均。日足は GMO の Bid・Ask の中値を、チャートと同じく表示の桁に丸めたもの（`historyRead`。21:00 UTC 区切り）。
      - 平均は Wilder の平滑（`pineAtr(日足, 20)` と同じ式。最初の値は20日の単純平均）。読んだ日足（2023年の年のファイルから）の最初の足から計算する。
      - 合図の確定の時刻を T とする。足の始まり＋24時間 ≤ T となっている最新の日足の N を使う。T を含む日足は使わない（先読みになるため）。
      - 損切りは中値の終値から 2N。
    - **2A**: 合図の4時間足の ATR(14)（メールと同じ始まりから計算する、メールが計算している値）の2倍。
    - 判定するのは 2N と 2A の2つ。説明用に 1N・3N・1A・3A と損切りなし（参考）も出す。
    - 丸め: N と A から作る損切り（1N〜3N・1A〜3A）だけを、表示の桁（円のペア3桁・ほか5桁）のいちばん近い刻みに丸める（`Math.round`）。幅・R・入れ子の順は、丸めた価格からの幅で数える。
  - **追い方**: 5分足の Bid（買い）か Ask（売り）で、利確と損切りの先に届いた方で決済する。同じ5分足で両方に届いたら損切り。5分足の始値がすでに先にあれば、その始値で決済。30本（5日）で決着しなければ、その足の終値で決済（§8.83 と同じ）。4週間（120本）持つ場合は説明用に出す。
  - **同じ取引**: どの損切りでも、120本がすべてデータにある取引だけを使う。N か A が無い取引は、すべての損切りから外し、数を出す（0であること。下の確かめ）。
  - **判定する組**: 今メールが届くペアのうち、4時間足の履歴が2024年からあり、値段の低い3ペアを除いた9ペア（円の主要7ペア USD/JPY・EUR/JPY・GBP/JPY・AUD/JPY・NZD/JPY・CAD/JPY・CHF/JPY と、EUR/USD・AUD/USD）。§8.83 の A+B（11ペア）から、今アプリに無い GBP/USD・NZD/USD を除いた。
    - 説明用に別に出す: A+B（11ペア、§8.83 と並べるため）、TRY/JPY・ZAR/JPY・MXN/JPY（値段が低く、1 pip の重さが違う）、ペアごと。1つのペアは、当てはまる組（判定の9ペア・A+B・C・全部）のすべてに入る。
    - 測れないもの: HUF/JPY・SEK/JPY（4時間足が 2026-05 から）、Twelve Data の銘柄（USD/CAD と円のペア5つ。研究から読めない）、金（データの元が違う。今回は測らない）。
  - **出すもの**（今・2N・2A と説明用の損切りのそれぞれ。全期間・前半・後半）:
    - **勝率**（見出し）: 利確1が先の割合。同じ取引すべての中で数える（5日で決着しなかった取引は勝ちに数えない）。横に、物差し（下）の同じ損切りでの同じ割合と、損益が0より上の割合（すべての取引の中）を出す。
    - 説明用に、決着した取引の中の利確1が先の割合も出す。「時間切れを除く。効き目が無くても、損切りを広げると上がる」と書き添える。5日で決着しなかった割合と、その平均の損益を横に出す。
    - 「効き目が無く、時間切れも無いときの利確1が先の割合」: 取引ごとの S/(S+20) の平均（スプレッドを除く）。これを損益ゼロの線とは呼ばない。損益ゼロかどうかは、1回あたりの損益（とその区間）だけで答える。
    - 1回あたりの損益（pips、スプレッド込み）とその95%の区間。中央値、勝ちの平均・負けの平均、最悪の1回、下から5%の点。
    - 損切りの幅（pips）の中央値と、ペアごとの中央値・最小・最大。持った時間の中央値。決済の内訳（利確・損切り・両方・時間切れ）。
    - 持った夜の数（21:00 UTC をまたいだ回数）の平均と、候補 − 今。スワップの目安で、スワップそのものは数えない。
    - **最大の逆行**（取引ごと）:
      - 入りの約定値から、決済した5分足まで（その足を含む）の、決済する側の一番悪い値（買いは Bid の安値、売りは Ask の高値）までの pips。
      - 損切りで出た取引は、決済の値段まで。決済の足の中の順番は分からないので、利確で出た足の逆の値も入れる（多めに出ることがある）。始値で出た足は、その始値まで。
      - pips と R（逆行 ÷ 損切りの幅）で、中央値・95%の点・最悪を出す。
      - 利確1で勝った取引だけの同じ数字（pips と R）と、勝ちのうち逆行が30 pips 以上・100 pips 以上だった割合も出す。
      - 今の損切り30なら切られていた勝ち（同じ取引の今が、損切りか両方で出たもの）の割合は、逆行の大きさからではなく、同じ取引から直接数える（逆行は約定値から測るので、30 pips ではスプレッドの分だけずれる。プログラムの見直しで見つかった）。
    - **決済で数えた落ち込み**（判定には使わない）:
      - 判定する組のすべての取引を、決済の時刻の順に並べる。1回ずつ同じ量（pips のまま）で足した累計の、山からの一番大きな下がり（いつからいつか）を出す。同じ時刻に決済した取引は、その時刻の合計を1回で足す。
      - 最長の連敗（損益が0以下の続いた回数。同じ時刻の中は、入りの時刻、ペアの名前の順に並べる）。一番悪かった週の合計（決済の週）。
      - 持っている間の含み損は入らないので、広い損切りに甘い。最大の逆行と並べて読む。取引の重なりと、円のペアが同じ向きに動くことも入れていない。口座全体の含み損益の落ち込みは #188 で扱う。
    - **R**（損益 ÷ その取引の損切りの幅）の1回あたりの平均（区間は出さない）: 1回の危険の大きさをそろえた場合の目安（タートルの量の決め方に近い）。損切りが広いほど0に近づく（同じ危険なら量が小さくなる）。判定には使わない。
    - 物差し: 判定する組のすべての4時間足の終値で両方向に入った場合の、今と 2N・2A の差（決済の差か、合図の差かを分けるため）。
    - 損切りが 0.5・1 pip 悪く約定した場合の差。
  - **判定**（候補 − 今、同じ取引の1回あたりの差。候補ごと）:
    - 区間は §8.83 と同じ作り。入りの週ごと・4週ごとにまとめた標準誤差で、それぞれ t（まとまりの数 − 1）の区間を作る。下の端は低い方、上の端は高い方を取る。2つの候補を判定するので、Bonferroni で片側 1.25% ずつにする。
    - 「はっきり良い」: 前半と後半の差がどちらも0より上で、かつ、全期間の差の区間の下の端が0より上。
    - 「はっきり悪い」: 前半と後半の差がどちらも0より下で、かつ、全期間の差の区間の上の端が0より下。
    - どちらでもなければ「決められない」（差が無いとは書かない）。
    - **プラスと言える**: 全期間の、候補そのものの1回あたりの区間（判定と同じ作り、片側 1.25%）の下の端が0より上。今と説明用の損切りは、95%の区間で出す。
    - **見つけられる最小の差**: （片側 1.25% の t ＋ 0.84）× 全期間の差の標準誤差。週ごと・4週ごとのそれぞれで計算し、大きい方を出す。結果と一緒に出す。これより小さい差は、あっても「決められない」になりやすい。
    - **位置づけ**: これは、前もって決めた2つの候補を全期間で確かめるもので、§8.24 の①（前半で選び、後半で確かめる）ではない。「はっきり良い」でも、オーナーが入れる前に、2026-10-05 からの取引で、前もって決めた確かめで確かめる（§8.96 の (a) と同じ）。採用のルール②（実際の記録30回以上、§8.24）は、Q-Trend・ULTRA の成績を記録していないので、今は満たせない。入れるかどうかはオーナーが決める。
    - **前に見たもの**: この期間の今（損切り30・利確20）の数字は、§8.83 ですでに出ている（A+B の前半 −1.35・後半 −1.27）。§8.77 では、利確5のとき損切りを広げるとわずかに良く、同じ差が物差しにも出た。2N と 2A は §8.95 の調べから選んだもので、このデータを見て選んだものではない。
    - 物差しにも同じ大きさの差が出たら、「合図ではなく決済のしかたの差」と書く（§8.77 と同じ）。
  - **説明用の表**: 表ごとに、見た区間の数（K）を書く。1つずつの95%の区間の横に、Bonferroni（片側 2.5%÷K）の区間も出す。説明用の損切りや切り口（売り買い・合図ごと・ペアごと・A+B・C・120本・すべり）が良く見えても、それは次に測る候補になるだけ。前もって決めて、2026-10-05 からのデータで測る（§8.24 の4）。
  - **勝率が機械的に上がること**（先に書いておく）: 利確を20のまま損切りを広げると、合図の良し悪しと関係なく、利確1が先の割合は上がる。2N はおそらく 80〜90%台になる。そのため、勝率と並べて、物差しの割合と1回あたりの損益を必ず出す。
  - **先読みを疑うとき**: 勝率65%以上の組は一覧にする（広い損切りはほとんど入る）。さらに、次のどれかが出たら、報告の前に先読みを調べ、何を調べたかを結果と一緒に書く。
    - 合図の利確1が先（すべての取引の中）が、物差しの同じ損切りより3ポイント以上高い。
    - 1回あたり +2 pips より上。
    - 「プラスと言える」か「はっきり良い」。
  - **先に作り物で確かめること**（実データを読む前）:
    - 確かめ（どれも違い0で通ること）:
      - 合図とメールの関数、メールの水準（損切り30・利確 20/40/60）、ATR(14) とメールの ε（§8.83 の (a)〜(a4)）。
      - N を別に書いた簡単な計算でもう一度出して同じこと。N に使った日足は始まり＋24時間 ≤ T で、次の日足はそうでないこと。日足を N の足で切って計算し直しても同じこと。
      - 損切りの置き場所（すべての取引で）: 損切りの価格が、中値の終値から k·N・k·A を引いた（売りは足した）ものを表示の桁に丸めたものと同じこと。窓でない損切りの決済の値段が、その取引の損切りの価格と同じこと。
      - 損切りの入れ子: 取引ごとに、丸めた損切りの幅の順に並べて比べる（同じ価格は比べない。損切りなしは一番広い）。広い損切りが先に出ることは無く、狭い損切りで利確か時間切れになった取引は、広い損切りでも同じ結果。
      - 30本と120本の入れ子。時間切れの終値と4時間足の終値。合図の取引に利確2・3が付いていること。
      - GMO の読み込みの失敗0（4時間足・5分足・日足の Bid・Ask。1つのファイルを5回まで読み直す）。N か A の無い取引0。
      - 実データで1つでも違えば、測定プログラムは失敗で終わり（数字は読まない）、確かめのプログラムも失敗にする。
      - 日足の古さ: ペアごとに「T −（N に使った日足の始まり＋24時間）」の最大を出す。72時間（金曜 21:00 から月曜 21:00 まで）を超えたものは日付つきで一覧にし、結果の前に理由を書く。ペアごとの最初の日足の時刻と、START より前の日足の本数も出す。
    - 先読みの確かめが落ちうること: わざと T を含む日足の N を使うと、確かめが違いを見つけること。
    - 効き目のない値動き（§8.77 の path、50通り）:
      - 「はっきり良い」「はっきり悪い」がそれぞれ多くても3回。
      - 候補ごと（§8.83 と同じ関門）。判定する組の「候補 − 今」の前半・後半（100）で、z（平均 ÷ 標準誤差、週ごと・4週ごと）のばらつきが 1.25 まで。95%の区間の下の端が0より上になったのが7回以上なら、その候補は判定せず説明用にする。物差しの「候補 − 今」の平均（全ペア、50通りと前半・後半をまとめて）が ±0.3 pips 以内。
      - 損切りの置き場所の理屈: 物差しの120本の、すべての取引の中の利確1が先の割合が、S30・1N〜3N・1A〜3A のそれぞれで、取引ごとの (S−h)/(S+20) の平均の ±2ポイント以内。h はその取引の入りのスプレッドの半分（作り物では 0.2 pip。S30 なら約 59.6%）。損切りが置かれていない、単位を誤った、などの誤りはここで外れる。
    - 広い損切りが得をする値動き（drift。合図の取引だけ、合図の後に5分足ごとに 0.05 pip ずつ合図の向きへ動かす。10通り）: 2N・2A のどちらも「はっきり良い」が9回以上。
    - 広い損切りが損をする値動き（against。同じ大きさで合図と逆の向きへ。10通り）: 2N・2A のどちらも「はっきり悪い」が9回以上、「はっきり良い」は0回。
    - 検出力: path の50通りで、候補の差に1回あたり +1・+2・+4 pips を足して判定をやり直したとき、「はっきり良い」と出る回数を表にし、実データの前に docs に書く。
      - 作り物の値幅は実データより小さい（手元の path で 2N の中央値 約95 pips。実データの4時間足の ATR は §8.83 で 19.5〜66.7 pips）。ばらつきも小さいので、この表は実データでの見つけやすさを多めに見せる。実データでは、上の「見つけられる最小の差」と並べて読む。
    - 作り物の日足は GMO と同じ作りではない（金曜の夜に1時間ほどの日足ができ、4時間足の区切りが 1・5・9… 時）。作り物は作りの誤りを探すためのもので、N の大きさは実データと違う。
  - **§8.83 の再現**（実データの本番の前）: WEEKEND=stamp と §8.83 の END 2026-09-29T14:16:25Z で走らせる。今（T20 S30 L30）の A+B（メールの合図、どちらか）が、§8.83 の前半 −1.35（2,416回）・後半 −1.27（2,216回）と、回数と小数2桁まで同じになること（§8.84 と同じ）。この走りでは、今の数字と確かめだけを出し、候補の数字は出さない。違えば本番に進まない。本番の A+B の表には、§8.83 と週末の扱い・期間が違うことを書き添える。
  - **実データの後の確かめ**（§8.96 の gotobi-check と同じ考え）:
    - 測定プログラムは、判定する組の合図の取引ごとの表を research/out に出す。列は、ペア・合図の足の時刻・向き・入りの値段・A・N とその日足の時刻・利確の価格、今・2N・2A それぞれの損切りの価格・決済の時刻・値段・種類・pips。
    - 確かめのプログラム（`research/stop2n-check.py`、測定プログラムとは別に書く）は、表から（ペア・足の時刻・向き）と A だけを受け取る（A は (a4) で確かめ済み）。N は GMO の生の日足のファイルから、入りと決済は生の4時間足と5分足のファイルから計算し直す。値段は 1e-9、pips は 1e-6 まで一致すること。
    - 取引の数と、前半・後半・全期間の今・2N・2A の平均と差も、測定プログラムの JSON と突き合わせる。
    - 実データの前に、作り物のファイルで次を示す。誤りの無いときは違い0になること。入れた誤り（T を含む日足の N、決済を5分足1本遅らせたもの、1つの取引の pips +1）を見つけること（§8.96 と同じ）。
- **プログラムの独立した見直し**（実データの前。spec・作りの誤り・確かめの3つの見方、それぞれ別の人が反証。ワークフロー、6人）: 17件のうち本当とされたのは6つ（重なりを除く）。cd1c885 で直した。
  - 実データで確かめが1つでも違うと、測定プログラムが失敗で終わらなかった（緑のまま読んではいけない数字が出うる）。失敗で終えるようにし、確かめのプログラムも失敗にする。
  - 持ち主の表の R に、見た数に入っていない区間が出ていた。R は平均だけにした。
  - 説明用のペアごとの数字が、判定の9ペアの分しか出ていなかった。すべてのペアで出し、JSON にも残す。
  - 勝ちの逆行を R で出していなかった。出す。N・A の損切りすべての幅をペアごとに出す。
  - 「今の損切り30なら切られていた勝ち」を逆行 30 pips 以上で数えると、スプレッドの分だけ多く出る（作り物で 2N の勝ちの 24.3% 対、同じ取引から直接数えて 23.9%）。直接数える。
  - 作り物のまとめが、決めた回（path 7〜56、drift・against 7〜16）がそろっているかを確かめていなかった。関門にした。
  - 本当でない・結果を変えないとされたもの: 古い5分足のファイルが途中までのまま残っている心配（Actions の記録で、この期間の日のファイルはどれも日が終わった後に読み直されていた）、N の無い取引の数え方の重なり（0 でなければどのみち確かめが違う）、確かめのプログラムの重なった足の扱い・読む範囲（起きれば失敗に出る。読み違えにはならない）、区間を確かめのプログラムで計算し直すこと（今の取り決めは平均と回数まで）など。
- **作り物の結果**（実データの前。cd1c885 の版で、12ペア×70回。§8.97 の関門はすべて通った）:
  - 確かめはすべての回で違い0（照合 77万本、損切りの置き場所 1億2,618万件、入れ子 5,883万件など）。わざと T を含む日足の N を使った回は、(n2) が 9,764件すべてで違い、確かめのプログラムも N・日足・損切りの違いを見つけた。
  - 効き目のない値動き（path、50回）:
    - 「はっきり良い」は 2N・2A とも0回。「はっきり悪い」は 2N 2回・2A 3回（関門はそれぞれ3回まで。2A はちょうど上限）。
    - 候補ごと: 95%の下の端が0より上は 2N 100回中2回・2A 0回（7回以上なら外す）。z のばらつきは 2N 1.13・1.16、2A 1.04・1.11（週ごと・4週ごと。関門は1.25まで）。z の平均は 2N −0.21・2A −0.09（偶然かどうかは確かめていない）。
    - 物差しの「候補 − 今」は 2N −0.009・2A −0.001 pips（568万回。関門は ±0.3）。
    - 損切りの置き場所の理屈（物差し、120本、すべての取引の中の利確1が先）: S30 59.6%（理屈 59.6%）、1N 69.8%（69.9%）、2N 82.3%（82.3%）、3N 87.1%（87.5%）、1A 51.6%（51.6%）、2A 68.1%（68.2%）、3A 76.3%（76.3%）。どれも ±2ポイント以内（一番離れた回でも 1.03 ポイント）。
    - path の1回（seed 7）の判定する組では、2N の勝率（すべての中の利確1が先）78.6%（物差し 78.4%）・1回あたり −0.27 pips、決着した中の割合は 85.2% で、「効き目が無く時間切れも無いときの割合」82.5% より上に出た（見出しの勝率をすべての中にした理由のとおり）。
  - 広い損切りが得をする値動き（drift、10回）: 2N・2A とも10回すべて「はっきり良い」（seed 7 で 2N +7.69・2A +2.16 pips）。
  - 広い損切りが損をする値動き（against、10回）: 2N・2A とも10回すべて「はっきり悪い」、「はっきり良い」は0回（seed 7 で 2N −17.28・2A −3.43 pips）。
  - 検出力（path の50回で、候補の差に1回あたりの得を足して判定をやり直す）:

    | 候補 | +1 pip | +2 pips | +4 pips | 見つけられる最小の差（50回の平均） | 1回あたりの差のばらつき |
    |---|---|---|---|---|---|
    | 2N | 8回 | 43回 | 50回 | 1.79 pips | 34.0 pips |
    | 2A | 45回 | 50回 | 50回 | 0.84 pips | 16.2 pips |

    - 作り物の 2N の幅は約95 pips で、実データ（§8.83 の4時間足の ATR 19.5〜66.7 pips から、おそらくもっと広い）より狭い。ばらつきも小さいので、実データではこれより見つけにくい。実データでは、結果と一緒に出す「見つけられる最小の差」で読む。
  - 確かめのプログラム（9ペアの作り物のファイル、4,038回）: 誤りの無いときは違い0。入れた誤りは3つとも見つけた（決済を5分足1本遅らせたもの・pips +1 はその1件、T を含む日足の N は約1万3千件）。測定プログラムの確かめが違った回の JSON を渡すと、それだけで失敗にする。
- **確かめたこと**（実データ、GitHub Actions run 37179315070、commit 6755b5f。3つの段がすべて通った）:
  - §8.83 の再現（WEEKEND=stamp、END 2026-09-29T14:16:25Z、A+B、今 T20 S30 L30）: 前半 −1.35（2,416回）・後半 −1.27（2,216回）。§8.83 と回数・小数2桁まで同じ。この段の確かめもすべて違い0。
  - 本番の確かめはすべて違い0。合図とメールの関数 10,600本、メールの水準 6,504本、ε 4,572本、ATR 10,600本、N の計算し直し 13,636本、N の日足が T までに確定 15,226件、損切りの置き場所 184万7,910件、損切りの入れ子 86万711件、30本と120本の入れ子 86万2,358件、時間切れの終値 20万3,592件、N と A のある取引 12万3,194件（N か A の無い取引0）。GMO の読み込みの失敗0。
  - 日足の古さ（72時間超）: 14件で、どれも 2024-01-02 の合図（14ペア×1日。最大は同じ日の 20:00 の 95時間）。年末年始の休み（2023-12-29 金曜の引けから 2024-01-02 の朝まで市場が閉まっていた）で新しい日足が無く、N はその時点で確定していた最新の日足（2023-12-28 21:00 始まり）から取った。先読みではない。ほかに 72時間を超えたものは無い。
  - 独立した確かめ（`research/stop2n-check.py`）: 判定する組の 3,958回すべてで、入り・N・損切り・決済の時刻と値段・損益が GMO の生のファイルと一致。前半・後半・全期間の今・2N・2A の平均と差も JSON と一致。食い違い0。
- **結果**（判定する組の9ペア、メールの合図〈どちらか〉、同じ 3,958回。1回あたりは pips、スプレッド込み。前半 2,049回・後半 1,909回）:

  | 損切り | 損切りの幅（中央値） | 勝率（すべての中の利確1が先） | 物差しの勝率 | 損益が0より上 | 1回あたり（95%の区間） | 今との差 | 最悪の1回 | 負けの平均 |
  |---|---|---|---|---|---|---|---|---|
  | 今（30 pips） | 30 | 59.6% | 57.9% | 59.6% | −0.71（−1.76〜+0.34） | − | −149.0 | −30.8 |
  | **2N** | 204 | **86.9%** | 85.9% | 87.1% | **+1.22**（−1.18〜+3.62） | **+1.93** | −443.6 | −124.3 |
  | **2A** | 73 | **77.7%** | 75.8% | 77.7% | **−0.07**（−1.86〜+1.72） | **+0.64** | −321.8 | −69.2 |

  - **判定**（片側 1.25%、週ごと・4週ごとの低い方・高い方）:
    - 2N: 今との差は前半 +1.01・後半 +2.92・全期間 **+1.93（−0.80〜+4.67）→「決められない」**。見つけられる最小の差は 3.72 pips（これより小さい差は、あっても決められない）。2N そのものは +1.22（下の端 −1.87）で、プラスと言えない。
    - 2A: 前半 +0.76・後半 +0.51・全期間 **+0.64（−0.95〜+2.23）→「決められない」**。見つけられる最小の差 2.18 pips。2A そのものは −0.07（下の端 −2.12）。
    - 物差し（判定の9ペアのすべての4時間足、両方向、7万5,186回）の今との差は 2N +0.13（−1.31〜+1.57）・2A −0.19（−0.68〜+0.30）。合図の 2N の差（+1.93）は物差しより大きいが、区間は0をまたぐ。
  - **勝率が上がった理由**: 2N の勝率 86.9% は、物差し（どこでも両方向に入る）でも 85.9% になる。損切りを広げたことで機械的に上がった分がほとんどで、合図の分は約1ポイント。決着した取引の中の割合は 93.8%（時間切れ 7.4%、その平均 −76.9 pips を除くため）、「効き目が無く時間切れも無いときの割合」は 90.3%。
  - **持っている間の逆行**（2N）: 中央値 21.6 pips、95%の点 168.5、最悪 443.6 pips。利確1で勝った取引の 95%の点は 100.6 pips、最悪 355.1 pips。勝ちの 31.4% は、同じ取引が今の損切り30なら損切りで終わっていた（2A は 23.3%）。勝ちの 5.1% は、いったん 100 pips 以上逆に動いてから勝った。
  - **決済で数えた落ち込み**（1回1単位、pips。持っている間の含み損は入らないので広い損切りに甘い）: 今 −3,242.6（2024-01-04〜2026-07-29）、一番悪かった週 −528.6。2N −5,670.5（2024-02-16〜2024-08-05）、一番悪かった週 −1,632.6（2024-04-21 の週）。2A −2,380.4、一番悪かった週 −1,103.2。累計は今 −2,817、2N +4,833、2A −279 pips。最長の連敗は今 12回、2N 5回、2A 8回。
  - R（損益 ÷ 損切りの幅）の1回あたり: 今 −0.024、2N +0.003、2A −0.003。持った夜の数は今より 2N で1回あたり +1.08、2A で +0.33（スワップは数えていない）。
  - 損切りが 0.5・1 pip 悪く約定した場合の 2N の差: +2.11・+2.28（今のほうが損切りに多くかかるので、差は広がる）。
- **説明用**（判定には使わない。見た区間の数 52。良く見えても次に測る候補で、2026-10-05 からのデータで、前もって決めて測る）:
  - 2N の今との差: 買い +4.00（95% +0.51〜+7.50、Bonferroni −3.56〜+11.57）、売り +0.03。Q-Trend +1.05、ULTRA +3.93、STRONG +2.57。CHF/JPY +6.21（95% +1.22〜+11.21、Bonferroni −3.89〜+16.31）、CAD/JPY −2.58。損切り1 pip 悪化 +2.28（95% +0.04〜+4.52）。95%の区間で0より上のものが3つあるが、Bonferroni ではどれも0をまたぐ。
  - A+B（11ペア。§8.83 とは週末の扱いと期間が違う）: 2N +1.67（95% −0.29〜+3.62）、2A +0.68。
  - 値段の低い3ペア（C）は、利確20が遠く、勝率が 10% ほどで、2N の幅も 11〜21 pips と今より狭い。2N −0.18、2A −0.52。TRY/JPY の 2A −0.91（95% −1.59〜−0.24）。
  - 説明用の損切り: 1N +1.29、3N +1.66、1A −0.02、3A +0.80、損切りなし +1.93（今との差、全期間。どれも 95%の区間が0をまたぐ）。
- **先読みの確かめ**（勝率が高く見える組があるため、報告の前に行った）:
  - 一覧に上がった13件は、後半の 2N・3N・損切りなしが1回あたり +2 pips を超えたもの（+2.09〜+2.25、どれも区間は0をまたぐ）と、全ペア（C を含む）の組で物差しより勝率が3ポイント以上高いもの（後半）。判定する組の全期間では、2N の勝率は物差しより 1.0ポイント高いだけ。「はっきり良い」「プラスと言える」は無い。
  - 先読みの入り口になりうる所は、どれも確かめで違い0: N の日足が T までに確定していること（(n2) 15,226件、確かめのプログラムが生の日足から「始まり＋24時間 ≤ T」で計算し直して 3,958回一致）、合図がその足までの足だけで出ていること（(a) メールの関数に合図の足までを渡して 10,600本一致）、A がメールの計算と同じこと（(a4)）。作り物でわざと T を含む日足の N を使うと、(n2) と確かめのプログラムが違いを見つけることも示してある。
  - 勝率の高さは、損切りを広げたことによる機械的なもの（物差しも 85.9%）で、先読みのしるしは見つからなかった。
- **読み方**:
  - 2N・2A とも、今の損切り30との差は「決められない」。2N は今より1回あたり約 +1.9 pips 良い向きだが、この期間の取引の数では、+3.7 pips より小さい差は見分けられない。
  - 2N にすると勝率は 59.6% から 86.9% に上がるが、1回あたりの損益は +1.22 pips（区間 −1.18〜+3.62）で、0と見分けられない。勝ちは約 +20 pips、負けは平均 −124 pips・最悪 −444 pips になり、決済で数えた落ち込みも今の約1.7倍（−5,671 pips）、一番悪い週は約3倍（−1,633 pips）。
  - 勝率100%に近づくように見えるのは、損切りを遠くに置いたため。負けの回数は減るが、1回の負けが大きくなる。
  - 入れるかどうかはオーナーが決める。入れる前には、2026-10-05 からの取引で、前もって決めた確かめが要る（上の「位置づけ」）。
- **限り**（先に書いておく）:
  - スワップは数えていない（夜の数だけ出す）。損切りが広いと長く持つので、実際の口座では差が出る（向きはペアと売り買いで違う）。
  - すべりは、損切りを 0.5・1 pip 悪くした場合だけ。窓開けで損切りより大きく負けることがある（始値で決済）。
  - 楽天FXのスプレッドは調べていない（GMO の売値・買値で測る）。
  - 4時間足のほかの時間足と、測れないペア（上）は測らない。メールとチャートの損切りの設定は全部の銘柄・時間足で1つなので、ここで決めた幅は測っていない所にもかかる。
  - タートルの方式そのもの（量の決め方、ブレイクでの入り、10日・20日の出口、½N ごとの買い増し）ではない。

---

### 8.98 利確・損切りを、動画（F-INVEST PREMIUM）のチャートの線に合わせた（#192、signal-alerts v20）

- **指示**（2026-10-04）:
  - オーナーが動画（Instagram の28秒の動画。F-INVEST の上位版のインジケーター「F_INVEST_PREMIUM_EN」〈TradingView〉、金 XAUUSD）を送り、「利確と損切り、これに合わせて」。
  - 動画から読み取れたこと（コマを切り出して読んだ。動画のファイルはリポジトリに入れていない）:
    - 設定画面（12〜14秒）: SL 15・TP1 4・TP2 10・TP3 15。
    - チャートの線: エントリー 4166.020 に TP1 4170.020（+4）・TP2 4176.020（+10）・TP3 4182.020（+16）。別の取引（4277.120）も +4・+10・+16。
    - 損切りの札は、字幕で下半分が隠れていて数字が読めない。線の位置（14.0秒のコマ: エントリー 755・TP1 695・TP2 604・損切り 949 画素）から、1ドルが約15.0〜15.1画素で、損切りはエントリーの約12.9ドル下（13ドル）と読んだ。
    - 設定画面とチャートの線が合わない（TP3 は 15 と 16、損切りは 15 と 約13）。
    - 表（F-INVEST PREMIUM）: TP1 110回 82%・TP2 78回 58%・TP3 62回 46%・損切り 24回 18%・合計134（後のコマでは TP1 122回 80%・損切り 30回 20%・合計152）。合計は TP1＋損切りで、ULTRA EN と同じ数え方。
    - サインには絞り込みがある（Impulse Candle Filter 入、Momentum Confirmation 入〈8・65・43、TREND〉。Smart Volume Filter・Trend Momentum・Session filter は切）。
  - オーナーに確かめたこと（選択肢から選んでもらった）: 対象は「金とFXの両方」、TP3 は「16（チャートの線どおり）」、損切りは「13（チャートの線どおり）」。
  - 決めた水準: **損切り13・利確 TP1 4・TP2 10・TP3 16**。金はドル、FX は pips（#151 と同じ読み替え）。Q-Trend も ULTRA と同じ数字（#156 からのオーナーの選択）。
- **変えたこと**:
  - `_shared/ultra.ts`: `ULTRA_PAIRS`（FX）と `ULTRA_GOLD`（金）を、どちらも損切り13・利確 4・10・16 にした。
    - 前は FX が損切り30・利確 20・40・60 pips（#166・#173）、金が損切り10・利確 30・60・90ドル（#168）。
    - `ULTRA_DEFAULTS`（最初の動画の設定 10・5・10・15）は変えていない。メールの記録の ID（`ULTRA_RULE_ID` = `ultra_rsi14_30_70_sl10_tp5_10_15_v1`）がこれから作られ、二重送信を防ぐキーの一部のため（§8.78 と同じ）。
  - サインの出し方（ULTRA は RSI の30・70のまたぎ、Q-Trend は線の抜け）は変えていない。メールが届くタイミングも変わらない。
    - 上位版の絞り込みは作っていない。コードが公開されておらず、オーナーの指示は利確と損切りだけのため。
  - メール（signal-alerts v20）:
    - 目安の見出しを「ULTRA の目安（損切りは13pips、利確は4・10・16pips）」にした（金は「13ドル、4・10・16ドル」）。
    - 説明を「損切り・利確は、F-INVEST のもう一つの動画（上位版・金。表では利確1に届いたのが80〜82%。サインには、このアプリにない絞り込みがあります）のチャートの線に合わせて…」にした。
    - 「測った成績」を新しい水準の数字（下の表）にした。
    - 損益ゼロに要る割合は 13÷(13＋4) で **76%**（前は FX 60%、金 25%）。
  - チャート: インジケーター名を「ULTRA（RSI 14・SL 13・TP 4/10/16 pips）」にした（金は「SL $13・TP $4/10/16」）。ULTRA と Q-Trend の説明文（日本語・英語）と、メール通知の設定の説明も直した。
  - 0以下になる目安: 利確3は16 pips（0.16円）になった。今の銘柄では、いちばん安い HUF/JPY（約0.49円）でも0より下にならない。外す処理は残し、テストで確かめる（下）。
  - `research/tf-winrate.ts`・`tf-winrate.yml`:
    - 利確2・3を入力で渡せるようにした。無ければ利確1の2倍・3倍。4・10・16 は比例しないため。
    - 水準の並び（どれも0より上、利確1＜2＜3）を確かめる。
    - ワークフローの既定を新しい水準にした。
  - `research/gold.ts`: 利確4・損切り13・5日の行（MAIL #192）を足した（#168 の MAIL の行と同じ形）。
    - ほかの表・判定には入れていない。
    - 作り物の値動きで、足す前と後とで、MAIL の行のほかは出力が同じことを確かめた。
  - 前のメールの水準を前提にした研究プログラムは変えていない（`research/widetp.ts`・`stop2n.ts`・`strength.ts`・`prewarn.ts`）。
    - どれも、その時のメールの水準（損切り30・利確20）を測ったもの。今の版で走らせると「メールの水準が変わった」で止まる（そう作ってある）。
    - やり直すときは、#192 の前の版（main の a93866d）で走らせる。
  - signal-alerts の版名を v20 にした。§8.93 の月曜の確かめのクエリ（版名で絞る所）は、v19 と v20 のどちらでも拾うようにした。
- **測り直した成績（FX）**:
  - 測り方: `research/tf-winrate.ts`、損切り13・利確 4/10/16、GitHub Actions run 37191488441。
  - 期間は 2024-01-01〜2026-09-30 14:40:11 UTC（§8.82・§8.93 と同じ終わり）。GMO の FX 21ペア、WEEKEND=inside（§8.93）。
  - メールで送られるサインを、その足の終値で入った場合（スプレッド込み）。全部を利確1か損切りで決済し、5日で決着しなければその時点で決済。

  | 時間足 | Q-Trend: 利確1が先 | 1回あたり | ULTRA: 利確1が先 | 1回あたり |
  |---|---|---|---|---|
  | 5分足 | 70.3% | −2.03 pips | 71.9% | −1.62 pips |
  | 15分足 | 70.5% | −1.90 | 72.0% | −1.51 |
  | 1時間足 | 72.6% | −1.46 | 72.8% | −1.60 |
  | 4時間足 | 73.6% | −1.07 | 74.5% | −0.94 |
  | 日足 | 50.8% | −8.88 | 53.0% | −8.79 |

  - 損益ゼロには、スプレッドを除いても 76%より上が要る。どれも届かない。1回あたりはどれもマイナスで、95%区間もすべて0より下（4時間足: Q-Trend −1.36〜−0.79、ULTRA −1.30〜−0.58 pips）。
  - 日足は、確定する 21:00 UTC のスプレッドが広い（払った中央値 8.7 pips で、利確1の4 pips より広い）。そのため、利確1が先の割合が大きく下がる。
  - 前半・後半（2025-05-19 で分けた）も同じ向き。4時間足では、Q-Trend 73.5%・−1.05 pips と 73.6%・−1.09 pips、ULTRA 74.4%・−0.94 pips と 74.6%・−0.94 pips。
  - 物差し（同じ時間足の終値から抜き出した足〈4時間足は約半分〉で、両方向に入った場合。§8.69 と同じ）: 4時間足で 71.6%・−1.55 pips。合図は物差しより 2.3 ポイント高い（区間 0.9〜3.7）。
  - 利確2・3まで全部持った場合（参考、4時間足・2つ合わせて）: 利確2で 54.3%・−1.07 pips、利確3で 42.2%・−1.15 pips。
  - 5日で決着しない取引: 4時間足で 251回（6,363回のうち）。前の水準では 1,047回。
  - 照合で違いは出なかった:
    - メールの関数と合図を比べた違いは0（5つの時間足）。GMO の読み込みの失敗も0。
    - 105の組（21ペア×5時間足）のすべてで、合図の足の終値と5分足の終値の違いは0。
  - 再現:
    - 同じプログラム（利確2・3の入力を足した版）を、前の水準（損切り30・利確 20/40/60）と同じ終わりで走らせた（run 37191489765）。#192 の前のメールの数字（§8.82・§8.93）が、10個すべて同じに出た。
    - 合図の読み込みの行（105行）も、2つの実行で同じだった。
- **測り直した成績（金）**:
  - 測り方: `research/gold.ts`、"Study gold" run 37191490950 の、アプリと同じ区切りのジョブ（4h tw, daily tw, fill twelve）。
  - データは Dukascopy の金（Twelve Data と同じ区切りの足）、2024-01-01〜2026-09-28。§8.80 と同じデータで、Actions のキャッシュ dukascopy-xau-36653964158。

  | 時間足 | Q-Trend: 利確1が先・1回あたり | ULTRA: 利確1が先・1回あたり |
  |---|---|---|
  | 5分足 | 74.3%・−0.66ドル | 73.0%・−0.87ドル |
  | 15分足 | 74.3%・−0.65ドル | 73.6%・−0.78ドル |
  | 1時間足 | 75.3%・−0.50ドル | 72.1%・−1.05ドル |
  | 4時間足 | 73.9%・−0.68ドル | 72.5%・−1.02ドル |
  | 日足 | 78.0%・−0.19ドル | 42.3%・−6.41ドル |

  - 損益ゼロには、スプレッドを除いて76%より上が要る。上回るのは日足の Q-Trend（78.0%、50回）だけで、それもスプレッドを払って −0.19ドル（95%区間 −2.16〜+1.78）。
  - 日足の ULTRA は26回と少ない。4時間足の区間は Q-Trend −1.50〜+0.13、ULTRA −2.32〜+0.28 ドル。
  - 同じ実行の #168 の行（利確30・損切り10）は、#192 の前のメールの数字（§8.80）と1つ残らず同じに出た（同じデータ・同じ計算であることの確かめ）。
  - 動画の表（利確1 80〜82%）とは比べられない。動画は上位版の絞り込み付きのサインで、期間やスプレッドの扱いも分からない。ここでは、最初の動画の RSI のサインのまま測った。
- **勝率について**（目指しているのは勝率100%、CLAUDE.md）:
  - 利確1が先の割合は、FX で 70〜75%、金で 72〜75%（5分足〜4時間足）に上がった。ただしこれは、利確1が損切りより近い（4 対 13）ための数え方の違い。値動きに偏りがなければ、でたらめに入っても約76%になる。
  - 1回あたりはどれもマイナスのまま。
  - 前の水準とは同じ合図・同じ入り方で、出方だけが違う。4時間足の1回あたりの差は Q-Trend +0.10・ULTRA −0.57 pips。この差の区間は出していないので、良くなったとも悪くなったとも言えない。
- **確かめたこと**:
  - テスト: 全テスト 2,402件（113ファイル）がすべて通った（見直しの後。下の2件の確かめとテスト1件を足した）。
    - 期待値を新しい水準に直したもの:
      - 設定（`ULTRA_PAIRS`・`ULTRA_GOLD`）。
      - 金の作り物の値動きでの取引（10件すべてが利確1に先に届き、損切り0）。
      - FX のチャートの表・印・札、EUR/GBP の札（損切り↑・利確↓）、Q-Trend の損切り・利確と札。
      - メールの文面と数字（損益ゼロ 76%）、インジケーター名、説明文。
    - チャートの表・印・取引の期待値は、テストとは別に Python で数え直して決めた。前の水準（5・10・15、30・60・90、30・20・40・60）では、元の期待値がそのまま出ることを先に確かめた。
    - 金のチャートのテスト: 最新の取引が利確3で終わる（384本目）。そこで、箱が薄く、札が出ない形を確かめるようにした（決着していない箱と札は、FX と EUR/GBP のテストで確かめる）。
    - 0以下の目安のテスト: 今の銘柄では起きない。そこで、HUF/JPY の作り物の値動きを約0.13円に下げて確かめる（動き方は同じなので、合図も同じ）。売りの利確3（−0.027円）の札が出ないこと、メールでも「—」になることを確かめる。
    - 金の「1回あたり勝ち」の書き方: 今の測った数字に勝ちが無いため、テストの中で一時的に数字を入れて確かめ、元に戻す。
    - `ULTRA_RULE_ID` が変わっていないこと（`ultra_rsi14_30_70_sl10_tp5_10_15_v1`）のテストは、そのまま通る。
  - 型チェック: 既存の12件のみ（変更前の版でも同じ12件）。lint: 変えたファイルに0件。
  - Deno の型チェック: signal-alerts・live-chart・research/tf-winrate.ts・research/gold.ts。
  - 独立した見直し（4つの見方: 変え忘れ・数字・テスト・本番。それぞれの指摘を、別の1人が反証を試みて確かめた）:
    - 本当とされて直したもの（7件。どれも重さは低か中）:
      - 前の水準を今のこととして書いたコメント（`research/tf-winrate.ts`、`signal-alerts/indicators.ts` のメールの節の頭）。
      - この節の「今のメールの数字」2か所を「#192 の前のメールの数字」にした。
      - 物差しの説明を直した（「すべての終値」ではなく、4時間足は約半分を抜き出している）。
      - HUF/JPY の値段（「約0.4円」ではなく約0.49円）。
      - テストの確かめ漏れ: ULTRA だけで決着していない取引の札が、最新の足の右の余白に出ることを確かめるテストが、金のテストの書き換えで消えていた。EUR/GBP のテストに足した。余白の条件から ULTRA を外すと、このテストが落ちることを確かめた（足す前は、全テストが通っていた）。
    - 誤りではないとされたが、足したもの:
      - 決着した箱では余白が空かないことの確かめ（金のテスト）。最新の取引が決着したかを見ないように変えると落ちる。
      - チャートの説明文に手で写した数字（勝率と1回あたり、FX・金、Q-Trend・ULTRA の40個。日本語と英語）が、メールの表と同じであることのテスト。表の数字か説明文の数字を1つ変えると落ちる。
      - チャートが前の水準でメールしたサインも新しい水準で描き直すこと、開いたままのタブのこと（上の「かかる範囲」）。
    - 誤りではないとされ、変えていないもの: tf-winrate の Actions で TP2・TP3 を省くと、既定の 10・16 が入る（見出しの行と env に出る。メールの数字は利確1だけで決まる）。
    - 見直しの中で試した、わざと壊したときの結果:
      - `ULTRA_PAIRS` を前の値に戻すと8件、`ULTRA_GOLD` を戻すと5件が落ちる。
      - `ULTRA_DEFAULTS` を変えると11件が落ちる（ルールIDのテストを含む）。
      - 0以下を外す処理を消すと、チャートとメールのテストがそれぞれ落ちる。
- **かかる範囲**:
  - Q-Trend と ULTRA の全銘柄（FX・金）・全時間足について、メールとチャートの損切り・利確が変わる。
  - オーナーの購読（Q-Trend と ULTRA の4時間足、21銘柄）のメールは、反映の後の合図からこの水準になる。
  - 前に送ったメールの記録（`signal_alerts.stop`・`target`）は、送った時の水準のまま。
  - チャートは、読み込んだ足のすべてのサインを、その時の設定で追い直す（#151 からの作り。どの水準でメールしたかは読まない）。そのため画面の公開の後は、前の水準でメールしたサインも、損切り13・利確 4/10/16 で描かれ、決着の判定もその水準になる。前のメールで持った建玉の損切り・利確は、メールに書いた数字で見る。
  - 公開の前から開いたままのタブは、開き直すまで前の水準で描く（インジケーター名も前のまま。§8.93 と同じ）。
  - 成績の記録（track-outcomes）は RSI+SAR・GA型のもので、Q-Trend・ULTRA には無い（#155）。変わらない。
  - Twelve Data の銘柄（金を除く）は測っていない。
  - #188（資金管理）は、新しい水準で測り方を決め直す。
- **本番への反映**（2026-10-04）:
  1. PR #165 をマージした（10:25 UTC、ab5cd74）。
  2. 関数: `deploy-functions.yml` run 37195344093 が成功した（10:26 UTC）。本番のメールの巡回は 10:27:00 UTC から版名 `signal-alerts-v20-2026-10-04T10:00:00Z`（`net._http_response` で確かめた。日曜なので `market_closed` で判定は飛ばしている）。
  3. 画面: Lovable にマージのコミット（ab5cd74）が届いたのを見てから公開した（`deploy_project`、10:28 UTC 頃）。返事は pending（deployment f0659692）。公開が終わったかは確かめていない。
  4. 新しい水準のメールが最初に出るのは、市場が開いてからの合図（月曜）。§8.93 の月曜 00:00 UTC の確かめ（v19 と v20 のどちらでも拾う）で、あわせて見る。

### 8.99 資金管理と、同時に持つ数の上限を試算する（#188、研究のみ）

- **指示**（2026-10-04）: §8.95 の候補から、オーナーが「ゴトー日のドル円」「損切りを値幅の2倍に」「資金管理の試算」を選んだ。順番に1つずつ測る。これはその3つ目（§8.96・§8.97 の次）。§8.98 の後にオーナー「続けて」。
- **注**: 水準は #192 の後のもの（損切り13・利確 4・10・16 pips、§8.98）。合図は変わっていない。
- **問い**（どれも、この期間の1つの道筋の上で、出来事を数えて述べる。答えは予想ではない）:
  1. メールの合図（Q-Trend と ULTRA の4時間足）を全部取っていたら、口座はどうなったか。1回の量が「毎回1万通貨」の場合と「資金の 0.25・0.5・1・2%」の場合。
  2. 同時に何本持っていたか（全部・円の同じ向き・ペアごと）。量と関係なく、取引だけから数える。
  3. 楽天FXの決まり（証拠金・追証・ロスカット）は、どれだけ効くか。
  4. 同時に持つ数に上限を付けると何が変わるか（1つずつ・3つまで・1ペア1つ・円の同じ向き2つまで）。取る数が減る分の効き目と分けて見る。
  5. 落ち込みのうち、1回あたりのマイナスによる分と、偶然や取引が重なることによる分（損益ゼロに直した参考と比べる）。
- **答えないこと**: どの量・上限ならプラスになるか（1回あたりがマイナスなので、ならない）。上限や量の決まりをアプリに入れるか（§8.24 の確かめが要る売買の決まりの変更）。オーナーの本当の口座・コース・約定・スワップ・楽天FXの値段。測れない8つの FX の銘柄と金（TRY/JPY・ZAR/JPY・MXN/JPY は説明用の行だけ）。ペアごと・時間ごとの成績（出さない）。
- **先に書いておくこと**（データの前に決まっている。結果ではない）:
  - 量の決め方は勝率（利確1が先）を変えない。勝率は合図と 4・13 の水準で決まる。
  - 1回あたりがマイナスのままでは、量・上限・減らし方で変えられるのは、減る速さと落ち込みの深さだけ。プラスにはならない。ケリー基準の答えは「賭けない」（§8.98 の21ペアの数字で約 −0.24）。
  - 上限で損が減るのは、主に取る数が減るため。上限で残った取引が良く見えたら、それは合図の絞り込み（§8.24 で、前もって決めて新しい取引で確かめるもの）で、資金管理ではない。
  - 倍賭け（負けたら量を増やす）は平均を変えず、破産しやすくするだけなので入れない。
  - 同じ「資金の k%」なら、損切り13の取引は損切り30の約2.3倍の通貨数になる。1回あたりのレバレッジと証拠金も約2.3倍になる。
- **前の調べ**（読み取りだけ）:
  - 4人のワークフロー（#192 の前、損切り30のときに調べた）: メールの取引の作り（#187 の作りが使える）、アプリの数量の扱い、楽天FXの決まり、資金管理の測り方。
  - アプリには数量の目安が無い。#40 で数量の計算を外し、#111 で「設定は増やさない」（オーナーの選択）。出しているのは RSI+SAR・GA型のメールの「1万通貨で損切りなら ¥X の損失」だけで、Q-Trend・ULTRA のメールには無い。
  - オーナーの購読（2026-10-04）: Q-Trend と ULTRA の4時間足、21銘柄（円のペア17・EUR/USD・AUD/USD・USD/CAD・金）。口座の大きさ・コース・全部のメールを取るかは、どこにも記録が無い。
- **測り方の決め方**（データを見る前。ワークフロー）:
  - 3人が別々に案を書いた（楽天の決まりに忠実・統計の厳しさ・オーナーが使えるか）。2人が採点し、1人がまとめ、1人が抜けを探した。
  - 採点は「1万通貨・要った口座」の案と「楽天の決まりに忠実」の案に割れた。前者を元に、後者の口座の決まりと、厳しさの案の確かめ方を足した。
  - 抜け探しで直したこと: 仕込む誤りが本当に効くかの確かめ、§8.98 の数字は21ペア（14ではない）、「前の水準より約2.5倍速く減る」は測った平均どうしの比で区間が広く（約1倍〜10倍超）計算では決まらないので書かない、足が無い時刻の扱い、見る数字が多すぎる（約390）ので幅を付けるのはオーナーに見せる表だけにする、ほか。
  - 書いた後の見直し（ワークフロー。3つの観点〈決まりの抜けと先読み・コードと楽天の決まり・計算と正直さ〉で探し、観点ごとに別の1人が反論を試みて確かめた）: 指摘33件（観点の間の重なりを含む）のうち、本当とされた29件をすべて直した。主なもの: 上限のますは並べ方で変わる、週の並べ替えで週をまたぐ取引の扱い、52週の窓の取り方、損益ゼロの直し方、1万通貨のますの口座の数字の出し方、ドル円の楽天のスプレッドの時期とキャンペーンの値、AS の決済の順と指値・逆指値の取り消し、タートルの読み方が資金より大きく賭ける所、測れない銘柄の数（11）、まだ見ていない数字の書き方。本当でないとされた4件（5分遅れの判定の時刻・AS の数え方・3分割の pips・先読みを疑う範囲）も、読み違いを防ぐために書き足した。
- **楽天FXの決まり**（2026-10-04 にページの本文を読んだもの。読めなかったものは「仮定」と書く）:
  - 25倍コース: 証拠金は取引額の4%。ロスカットは 50〜95%（5%刻み。口座を開いた時は25倍コース・50%）で、取引時間中に証拠金維持率（純資産÷必要証拠金）が水準を下回ると、口座のすべての建玉を決済し、発注済みの注文も取り消す。純資産は「一定間隔での時価評価」で、その間隔と使う値段は公開されていない。
  - 追証（25倍コースだけ）: NY の引け（米国の夏 20:55 UTC・冬 21:55 UTC）に、中値で証拠金維持率が100%を下回ると出る。期限は 18:00 JST（09:00 UTC）で、その日が取引日でなければ次の取引日（年末年始・クリスマスなどは別の期限を決めることがある）。入金するか、一部か全部を決済して解消する（口座の「充当額」は「入金、及びポジション決済により、解消している金額」）。値動きで戻っても解消にならない。期限までに解消しないと、全部決済される。
  - 10倍コース: 証拠金10%、追証なし。ロスカットは 40〜95%（5%刻み）から選ぶ。
  - 新しい注文が受け付けられる条件: 「有効証拠金（純資産 − 証拠金計。証拠金計 ＝ 必要証拠金 ＋ 注文中証拠金）。新たに取引できる余力の金額」（楽天FXのステータスの見方のページ、2026-10-04 に読んだ）。下の受け付けの4（注文した後の必要証拠金が資金を超えたら見送る）は、これに合う。損切り・利確の決済の注文が注文中証拠金を取らないことは読んでいない（仮定: 取らない）。
  - 取引単位 1,000通貨。両建ては可で、必要証拠金はペアごとに買いと売りの多い方で数える（MAX 方式）。必要証拠金は中値で計算し（取引単位×中値×証拠金率×数量÷1,000、円に切り上げ）、値段とともに動く。ドルのペアの必要証拠金はドルで出し、円にする（換算の値段は書かれていない）。
  - ドルのペアの損益は楽天のレートで円にする（その差は書かれていない）。
  - AS ストリーミング注文: 両建てにはならず、反対の注文は決済になる。どの建玉から決済するかは、客が4つから選ぶ（新しい順・古い順・1通貨あたりの損の大きい順・益の大きい順。古いページでは新しい順が初期設定）。AS の注文を出すと、発注済みの指値・逆指値は取り消される（そのペアだけか全ペアかを客が選ぶ）。
- **測り方**（`research/money.ts`。#187 の `stop2n.ts` の取引の作りを写し、水準を 13・4・10・16 に固定する。違えば止まる）:
  - **データと期間**: GMO の4時間足・5分足（Bid・Ask）。START 2024-01-01、END 2026-10-02 21:00 UTC（#187 と同じで固定）、前半は 2025-05-18 まで、WEEKEND=inside（§8.93）。
  - **銘柄**: 9ペア（#187 でデータの前に決めた組: USD/JPY・EUR/JPY・GBP/JPY・AUD/JPY・NZD/JPY・CAD/JPY・CHF/JPY・EUR/USD・AUD/USD）。どれもオーナーが購読していて、GMO に2024年からの足があり、楽天が扱っている（ポンド円は、今の広告のスプレッドが「-」）。結果で選んでいない。
    - 入れないもの: HUF/JPY・SEK/JPY（GMO の4時間足が 2026-05 から）、CZK・HKD・NOK・PLN・SGD/JPY と USD/CAD（Twelve Data で、Bid・Ask の過去が無い）、金（楽天証券の CFD で別の口座。証拠金を分け合わない）。
    - TRY/JPY・ZAR/JPY・MXN/JPY は説明用の行だけ（#187 と同じく、値段が低く 1 pip の重さが違うため。13・4 での打ち切りの割合は測っていない）。
    - 報告の最初に「測れない8つと、説明用の行（12ペア）だけに入れる TRY/JPY・ZAR/JPY・MXN/JPY の、合わせて11の FX の銘柄のメールも同じ口座に来るので、同時に持つ数と証拠金と E\* は少なめに出る」と書く。
  - **取引**（口座と関係なく決まる）:
    - メールで送られる合図（読む時刻は確定の 0・4・6 分後、§8.97 と同じ）。合図はメールの関数と比べて違い0であること。
    - 合図の足の終値で入る（買いは Ask、売りは Bid）。損切りと利確は、メールと同じく中値の終値から（損切り ∓13 pips、利確1・2・3 ±4・10・16 pips）。メールは確定から十数秒で送られる（携帯に届く時刻は測っていない）ので、確定の値段で入るのは一番早い入り方。
    - 5分足で追い、利確1か損切りで全部を決済。同じ5分足で両方に届いたら損切り。足が水準を越えて始まったら、その始値で決済。30本の4時間足で決着しなければ、30本目の終値で決済。決済の時刻は、決済した5分足の終わり。
    - 同じペア・同じ足・同じ向きは1つの取引（どちらの合図かは列に残す）。同じ足の買いと売りは2つ（両建て）。前の取引が残っているうちの同じ向きは重ねる。
    - 入るのは、合図の足の後に120本の4時間足がデータにある取引だけ（#187 と同じ。入りの時刻だけで切る。入りは END の約4週間前まで）。
    - 損切り・利確は、入ると同時に置く（OCO）とする。
  - **口座**:
    - 円の口座。始めは100万円（以前のアプリの初期値で、オーナーの口座ではない）。結果は「1万通貨あたりの円」と「始めに対する%」でも出す。入金・出金・スワップ・手数料は入れない。
    - 含み損益は、決済する側の値段（買いは Bid・売りは Ask）の5分足の終値で数える。ドルのペアは、同じ5分足のドル円の中値の終値で円にする。ドルのペアの必要証拠金も、同じ5分足のドル円の中値の終値で円にする（楽天の換算の値段は書かれていないので仮定）。
    - ある銘柄（またはドル円）にその時刻の5分足が無いときは、その前の最後の値段を使う。使った数を出す。
  - **量**:
    - **毎回1万通貨**（ドルのペアも1万通貨。損切りで約 $13 ≈ 約1,950円で、円のペアの1,300円より大きい）。
    - **資金の k%**（0.25・0.5・1・2%）: 通貨数 ＝ k × 資金 ÷（13 pips の円の値）を 1,000通貨単位で切り捨てる。ドルのペアの 13 pips の円の値は、確定の時点 T で終わる5分足のドル円の中値の終値（Bid と Ask の終値の平均）で数える。資金は、その足の確定の時点の含み損益込み（その時点までに決済した5分足が終わった取引は決済済み、ほかは含み損益）。同じ足の合図は、すべて同じ資金で量を決める。1,000通貨に届かなければ見送る（初めて見送った日を出す）。
  - **受け付け**（同じ足の合図を、楽天の一覧の順〈ドル円・ユーロ円・ポンド円・豪ドル円・ユーロドル・豪ドルドル・NZドル円・カナダ円・スイス円〉、買いを先に、1つずつ判定する）。見送る理由は、この順に:
    1. 追証が解消していない（仮定: 新しい注文を入れない）
    2. 上限（枠が空くのは、決済した5分足が終わった後）
    3. 1,000通貨未満
    4. 証拠金が足りない（注文した後の必要証拠金が資金を超える。楽天の「有効証拠金」に合う。上）
  - **証拠金**: ペアごとに MAX 方式、中値×通貨数×4%（10倍コースは10%）。値段とともに動く。円への切り上げは無視する。
  - **ロスカット**: 5分足の終値ごとに、資金（決済する側の値段）が必要証拠金の50%を下回ったら、すべてをその終値で決済する。その後も残った資金で続ける。
  - **追証**: NY の引けごとに、中値で資金が必要証拠金を下回ったら、足りない額 C の追証。
    - 解消（仮定）: 引けの時に持っていた建玉が決済され、引けの値段で数えた必要証拠金（MAX 方式）が C 以上減ったら解消。自分の損切り・利確での決済も数える。両建ては、多い方を決済した分だけ減る。
    - 期限（次の平日 09:00 UTC。金曜なら月曜。年始やクリスマスの繰り延べは入れない、仮定）までに解消しなければ、期限の時刻以降の最初の5分足の始値で、すべて決済する。
    - 入金はしない（仮定）。
    - 引けの時刻ちょうどの足が無いときは、その前の最後の終値で判定する。
  - **一つの5分足の中の順番**: ① 解消しない追証の期限 → ② その時刻の合図の受け付け → ③ その足の中の決済 → ④ 終値でロスカット、解消の判定 → ⑤ 足の終わりが NY の引けなら追証の判定 → ⑥ 終値で資金を記録。週末は足が無く、週明けの最初の足が窓を持つ。
  - **上限**（5通り）: なし（証拠金だけ）／1つずつ／3つまで／1ペア1つ（両建ても重ねも無し）／円のペアの買い2つまで・売り2つまで（ドルのペアは数えない）。
- **表**: 量5通り（毎回1万通貨・0.25・0.5・1・2%）× 上限5通り ＝ 25のます。すべて出す。どのますも、9ペア・両建て・利確1で全部決済・入金なし・GMO の値段。資金の%のますは、100万円から・25倍コース・ロスカット50%。
  - 毎回1万通貨のますは、受け付けの判定のうち追証・証拠金（とロスカット）を外し、上限で見送ったもの以外のすべてのメールを受け付けた道筋で計算する（口座がそのますの E\* 以上なら、楽天の決まりの下でも同じ道筋になる）。上限なしのますは並べ方によらない。上限のますは、決めた順（上の受け付けの順）で決まり、並べ方で変わる。
  - 1万通貨のますの口座の数字は、口座によらない円で出す（円の合計・落ち込みの円・一番悪い週と日の円・山を下回った期間）。比の数字（証拠金÷資金・実際に使ったレバレッジ・%の落ち込み）は、口座をそのますの E\* として出す。追証・ロスカット・不足金は、この道筋では起きない（口座が E\* 以上の場合）と書く。100万円から始めた場合は出さない。
- **見出し**（前もって決めた1つ）: **毎回1万通貨・上限なしで、すべてのメールが受け付けられ、追証もロスカットも起きないために要った、最初の口座の額（E\*、1万通貨あたり、円）**。
  - 量が決まっているので、口座の額は一次の式で入り、正確に出る。並べ方にも、オーナーの口座の大きさにもよらない（1,000通貨あたりは10分の1）。
  - E\* ＝ 次の4つの一番大きい値（どれも、すべて受け付けた道筋の上で）: 注文の時の「注文後の必要証拠金 − それまでの損益」の最大、NY の引けの「必要証拠金 − 損益（中値）」の最大、5分足の終値の「必要証拠金×50% − 損益」の最大、損益のマイナスの最大。どれがいつ決めたかを出す。
  - 「そのときまでに減った分」と「そのとき持っていた取引の証拠金」に分けて出す。
  - 「この期間を後から見て要った額」と書く。続けるほど減った分が増える。52週の窓ごとの E\* の中央と最大も出す。窓は、毎週始まる52週のすべて（週は日曜 21:00 UTC 始まり、最初の入りの週から）。窓の中で入った取引だけを、窓の終わりを越えても決済まで追い、損益は窓の始めで0。窓の終わりが、データの最後の入りの時刻より後の窓は使わない。窓の数を出す。
  - 横に出すもの: 勝率（利確1が先・すべての取引の中。決着した中も）、1回あたりの pips（区間つき）、1万通貨で1回あたりと1年あたりの円（区間つき。1年 ＝ 365.25日 ÷（最後の決済 − 最初の入り））、損益ゼロに直した道筋の E\*、週の並べ替えの幅。
  - 前提の1行（見出しではない）: 「9ペアの 13・4 の1回あたりは0より下か」を、週ごと・4週ごとの区間の高い方の上の端で答える。前半・後半も出す。
- **出すもの**:
  - **取引ごと**（3,958回。口座と関係ない）:
    - 勝率（すべての中・決着した中）、打ち切りの割合とその平均、前半・後半。
    - 1回あたりの pips（スプレッド込み）と95%区間（週ごと・4週ごとにまとめ、それぞれ t(C−1)。低い方の下の端と高い方の上の端）、中央値、R（pips÷13）。1万通貨の円（ドルのペアは決済の時のドル円で換算）。
    - 勝ち・負けの平均、最悪の1回（pips と R）、窓で損切りより大きく負けた回数とその平均。
    - 物差し: 9ペアのすべての4時間足の終値で両方向に入った場合の、同じ数字（取引と同じ除外をかける: メールが出る時刻、判定する足、後に120本、#187 の N と A と15の決まり。#187 の物差しは 75,186回で、回数は横に出すだけ）。
    - 持った時間（5分足の数で数える。中央・95%の点・最大。持った5分足の数は、全ペアをまとめた5分足の終値〈どれかのペアに足がある時刻〉のうち、T より後で、決済した5分足の終わり以前のもの〈(T, 決済の足の終わり]〉の数。同時の数も同じ終値で数える）、暦の時間（同じく）、週末をまたいだ数、NY の引けをまたいだ数とスワップの日数（水曜は3日）、1回あたりの円を ¥100（1万通貨・1 pip）動かすスワップの額。
    - 同時に持っていた数（5分足の終値ごと）: 最大、1つ以上・3つ以上・5つ以上の時間の割合、平均。円の同じ向きの最大、ペアごとの最大、同じペアの両建ての数と時間の割合、1つの足のメールの数の分かれ方、同じ足の円の同じ向きの最大。持った5分足の数の合計 ＝ 同時の数の合計（確かめ）。
  - **ますごと**:
    - 終わりの口座（資金の%のます）・円の合計（1万通貨のます）。前半・後半・暦年。年あたり。
    - 一番深い落ち込み（含み損益込み、5分足の終値。山・底・戻った日、または「戻っていない」）。4時間足の終値、決済だけ、すべての建玉が5分足の一番悪い値に同時にいた場合（上の限り）も出す。始めを下回った最大も。
    - 一番悪い週（日曜 21:00 UTC から）・一番悪い日（21:00 UTC から）。山を下回っていた一番長い期間と、その割合。
    - 取った数と、見送った数（理由ごと）。取った取引の勝率と1回あたり。
    - 同時の数（入る時の最大・中央、円の同じ向きの最大）。証拠金÷資金の最大・中央、0.8を超えた時間の割合。実際に使ったレバレッジの最大。
    - 追証（日付・額・解消か強制決済か）、ロスカット（日付・前後の資金）、不足金。
    - 1万通貨のますでは E\*（4つの値と時刻、減った分と証拠金の分）。52週の窓の E\* と損益ゼロの E\* は、見出しのます（毎回1万通貨・上限なし）だけで出す。
  - **上限と証拠金の確かめ**（上限のます〈1万通貨と 0.5%〉と、資金の 1・2% で証拠金で見送ったます）:
    - 残した取引と見送った取引の1回あたりの差（R）。同じ週の中で入れ替えた1,000回の幅。ペアごとにそろえて入れ替えた幅と、スプレッドを除いた R の差も出す。
    - 同じ週に同じ数をでたらめに見送った200回の中で、終わりの口座・落ち込み・一番悪い週の順位。でたらめに見送る回 d（1〜200）は、週ごとに、そのますで見送ったのと同じ数のメールを、その週のメールから sha256（「{d}|{ペア}|{向き}|{T の UTC の ISO 文字列}」）の小さい順に選んで見送る。残りは、そのますと同じ量の決め方・コース・証拠金・追証・ロスカットで（上限だけ外して）走らせ、実際に取った数も出す。
- **説明用の行**（見出しのますと、資金1%・上限なしのますで、1つだけ変える。勝率と1回あたりを必ず横に出す）:
  - 12ペア（TRY/JPY・ZAR/JPY・MXN/JPY を足す）
  - 5分遅れて入る（tf-winrate と同じ: 最初の5分足の終値で入り、もう水準を越えていれば見送り、次の足から追う）。受け付けの4つの判定・量・枠・E\* の注文の項は、すべて確定の時点 T（T までの資金、T の中値）で決める。水準を越えて見送ったメールの枠は T＋5分で空き、同じ足のほかのメールは判定し直さない。見送りの理由に「入る前に水準を越えていた」を足して数を出す。払ったスプレッドの中央値も出す。
  - 夜中（日本時間 1時・5時の確定 ＝ 16:00・20:00 UTC）のメールを見送る（オーナーが眠っている場合。時間を選ぶためではない）。払ったスプレッドの中央値も出す。
  - 利確1・2・3に分ける（1万通貨は 4,000・3,000・3,000 を利確1・2・3に。資金の%は全体を決めてから 1,000通貨単位で大きい順に分ける。損切りは同じ）。この行の1回あたり（pips・円）は、各部分の通貨数の重みで数える（1万通貨は 0.4・0.3・0.3）。
  - 反対のメールで決済（古い順を選んだ楽天の AS ストリーミング注文に近いもの: 反対の建玉を古い順に決済し、残りだけを新しく建てる。楽天では決済の順は客が選び〈古いページでは新しい順が初期設定〉、AS の注文はそのペア〈設定によっては全ペア〉の指値・逆指値を取り消す。ここでは、残った建玉の損切り・利確は、同じ値段で置き直すと仮定する）。
    - 受け付けの判定は、決済した後に新しく建てる残りの分だけにかける。決済の部分は、追証の最中でも、1,000通貨未満でもする。
    - 反対のメールで決済した建玉は「反対で決済」として、勝率の分母に入れ、勝ちにはしない。1回あたりには、その決済の損益を入れる。すべてを決済に使ったメールは、取引に数えない（数は出す）。
    - 一部を決済した建玉の損切り・利確は、残りの量で残す。
  - 楽天の広告のスプレッド（GMO の中値 ± 半分で、入りと決済を追い直す。値段ごとに、その時刻の決まりを使う。時刻の区切りは、始まりの時刻ちょうどから次の決まり〈[始まり, 終わり)〉で、5分足は足の始まりの時刻で、入りは確定の時刻で決める。銭〈円のペア〉と pips〈ドルのペア〉）:
    - ドル円: 2025-03-06 07:10 JST（その日の取引の始まり）から 0.2〈9:00〜翌3:00 JST〉／3.8〈3:00〜9:00 JST〉（2026-09-14 の縮小の対象ではない）。9:00 の確定での入りは 0.2、5:00 の確定での入りは 3.8。2024-01-01〜2024-08-13 のドル円の広告の値は読んでいないので GMO のまま。
    - 2026-09-14 07:00 JST から: ユーロ円 0.4、豪ドル円 0.5、NZドル円 0.6、カナダ円 0.6、スイス円 0.8、ユーロドル 0.3、豪ドルドル 0.4。
    - 2026-07-13 07:00〜08-08 05:55 JST（キャンペーン）: ユーロ円 0.4、豪ドル円 0.5、NZドル円 0.7、カナダ円 0.6、スイス円 0.8、ユーロドル 0.3、豪ドルドル 0.4。
    - それ以外（2024-01-01 から 2026-09-14 07:00 JST まで）: ユーロ円 0.5、豪ドル円 0.6、NZドル円 1.2、カナダ円 1.7、スイス円 1.8、ユーロドル 0.4、豪ドルドル 0.9（2021〜2022年に決まった標準の値で、2026-09-04 のお知らせの「現行」。その間に変わっていないことは確かめていない。仮定）。
    - GMO のまま: 分からない期間（広告の停止の間。2024-08-14 06:10 JST から 2025-02-05 07:10 JST まで、ドル円は 2025-03-06 07:10 JST まで。どれも、その日の取引の始まりを楽天の取引時間のページから数えた時刻）、ポンド円（今の広告が「-」）、除外の日（2024-11-11・2024-11-28・2026-06-19、日本時間の暦日）。
    - 当てはめた取引の割合を出す。
  - 10倍コース（資金の1%と0.5%）
  - ロスカットを5分足の一番悪い値で（厳しい側の限り）
  - 追証の厳しい解消（引けに持っていた建玉がすべて決済されたら解消）
  - 証拠金の上限なし（追証・ロスカットも無し。並べ方によらない参考）
  - 損益ゼロに直した参考（出口〈時刻・値段・利確か損切りか〉は変えず、取引ごとの損益の道筋だけを δ ×（入りから経った5分足の数 ÷ その取引の5分足の数）ずらす。5分足の数は下の「持った5分足の数」と同じ数え方。δ は 3,958回の平均から1つ決め〈1万通貨は1回あたりの円、資金の%は R〉、どのますも同じ。証拠金の値段はずらさない〈追証の判定の中値の資金には、ずらした分も入る〉。1回あたりの pips はずらさない。決める時には使わない参考で、先読みの確かめから外す）
  - タートルの減らし方（§8.95: 口座が元から10%減るごとに、量の計算に使う額を20%減らす。読み方: 減った段の数 m ＝ 切り捨て（(始め − 資金) ÷ 始めの10%）、m が1以上なら量の計算に使う額 ＝ min（資金, 始め × 0.8^m）。資金が始めの約21%を下回ると 始め × 0.8^m が資金より大きくなるので、資金を上限にする。資金が戻れば m も戻る。戻し方と上限は §8.95 の本文に無いので、この読み方の結果と書く）。資金の1% と 0.5%。
- **順番の幅**: 同じ足の合図の順で結果が変わるます（資金の%のますと、上限のます）のうち、オーナーに見せる表のます（資金の%・上限なしの4つと、上限の8つ）で、20通りの並べ方の最小・中央・最大を出す。並べ方 r（1〜20）では、同じ足の合図を sha256（「{r}|{ペア}|{向き}|{T の UTC の ISO 文字列}」）の小さい順に判定する。
- **区間・幅**:
  - 1回あたり: #187 と同じ作り（上）。
  - 口座の数字の幅: 週（日曜 21:00 UTC 始まり。最初の入りの週から最後の決済の週まで。これが元の長さ）を、1週と4週のまとまりで、元の長さまで引き直す（同じ週が何度出てもよい。1週は置き場所ごとに週をでたらめに選び、4週は始まりの週をでたらめに選んで循環で4週を取る）。それぞれ1,000回（1週の1,000回が先、4週の1,000回が後で、1つの乱数 mulberry32・seed 188 から）。広い方の 5〜95%（90%の幅。小さい順の 999×0.05 と 999×0.95 の切り捨ての番目）を出す。どのますも同じ引き直し。幅を付けるのは、オーナーに見せる表のます（上限なしの5つと、上限の8つ）だけ。ほかのますは点の値だけ。
    - 置いた週ごとに、その元の週に入った取引を、元の5分足の道筋ごと持ってくる。時刻は、置いた場所と元の週の差だけずらす。
    - 週をまたぐ取引は、元の道筋のまま決済まで続ける（次に置かれた週の値段は使わない）。
    - 口座の時計（5分足の終値・NY の引け・追証の期限）は、置いた週のもの（元の時刻をずらしたもの）。ほかの週から続いている取引は、その時刻を、その取引の元の週のずらし方で戻した時刻の値段で数える。その時刻に足が無ければ、前の最後の値段。
    - 同じペアで元の週が違う建玉の必要証拠金は、建玉ごとに元の中値で数え、ペアごとに買いの合計と売りの合計の多い方（MAX 方式）。
    - 量・上限・証拠金・追証・ロスカット・E\* は、並べ替えるたびに、この道筋の上で計算し直す（週ごとの損益を並べ替えるのではない）。
  - 幅の意味: 「見た週を、別の順・別の組み合わせで過ごしたら」。予想ではない。ほぼ、この期間に見た週の組み合わせの範囲で、2015年のスイスフランのような出来事は入らない。
  - 実行の時間: 作り物の値動きで全体の時間を測り（引き直し1,000回・でたらめに見送る200回のまま）、120分を超えるなら、データの前に引き直しを500回、でたらめに見送る回数を100回にする。
  - 量や上限の違いに有意かどうかの判定はしない（量の効き目は計算で決まり、上限は好みの問題）。数字を並べて述べるだけ。
  - 見た区間・幅の数は、プログラムが正確に出す。良く見えるものがあっても、2026-10-05 からの取引で前もって決めて確かめるまでは、入れる理由にならない（§8.24 ④）。
- **プログラムで決めたこと**（データの前。本文に無かった細かい決まり。プログラムの独立した見直し〈6つの観点で探し、観点ごとに反論を試みて確かめた。指摘31件、本当とされたもの18件〉の後に決めた。money.ts と money-check.py は、これに合わせる）:
  - 取引:
    - 水準は、チャートの中値の終値（Bid と Ask の終値の平均を、円のペア3桁・ドルのペア5桁に四捨五入）から作り、水準そのものは丸めない。届いたかは決済する側の5分足の高値・安値で見て、ちょうど届いたら届いたとする（§8.97 と同じ）。
    - 30本で打ち切る値段は、30本目の4時間足の中の最後の5分足の、決済する側の終値とする。
    - 5分遅れの行は、T 以後に始まる最初の5分足（T ちょうどの足が無ければ次の足）の終値で入る。「もう水準を越えていた」は、その足の決済する側の終値が利確1以上か損切り以下のときだけとする。
    - 持った5分足の数・暦の時間・週末・NY の引けは、どの行も T から数える。
    - 楽天のスプレッドの行: 入りは4時間足の中値の終値（丸めない）± 半分、5分足の4つの値は Bid と Ask の平均 ± 半分とし、水準は変えない。当てはめた割合は入りの時刻で数える。TRY/JPY・ZAR/JPY・MXN/JPY は GMO のまま。
    - 勝ち・負けの平均は、pips が0より上を勝ちとする。「窓で損切りより大きく負けた」は、損切りの水準を越えて始まった5分足の始値で決済したものとする。払ったスプレッドは入りの時の Ask − Bid（5分遅れは最初の5分足の終値の時）とする。
    - 95%の点は、小さい順の（回数−1）×0.95 の切り捨ての番目とし、補間しない。
    - NY の引けをまたいだ数は T と決済の間の引けで数え、スワップの3日は UTC の水曜の引けとする（祝日の違いは入れない。仮定）。
    - 同時の数の割合と平均は、（最初の入り, 最後の決済］の5分足の終値の数で数える。3分割の行では、どれかの部分が開いている間を1つと数える。5分遅れの行の入る時の同時の数には、約定を待っている注文も数える（独立した確かめでは比べない）。両建ての数は、同じペアの反対の向きが開いている間に入った取引で数える（同じ足で両方に入れば両方）。
  - 口座の手順:
    - 同じ足のメールは、量も証拠金の判定も同じ T の資金で決める（先に受け付けたメールのスプレッドは引かない。注文後の必要証拠金には、先に受け付けた分を T の中値で入れる）。
    - 量は 1,000通貨の数の切り捨て（計算の誤差のため 1e-9 を足してから）とする。資金がマイナスなら量もマイナスで、1,000通貨未満として見送る。損益と証拠金は円に丸めない。
    - 同じ足の中の決済と、一度に決済する建玉は、受け付けた順に決済する。
    - 3分割は、全体の量を決めてから 1,000通貨ずつ利確1・2・3の順に配る（10個なら 4・3・3、52個なら 18・17・17）。0の部分は建てない。どの部分も同じ損切りで、利確1の後も損切りは動かさない。
    - 5分遅れの行のメールは、T に量・枠・証拠金・E\* の注文の項を決め、最初の5分足の中の決済の後に入る。約定の足が終わった注文は、受け付けた順にすべて入れる。約定を待っている注文は、約定するまで（または「もう水準を越えていた」と分かるまで）上限の枠を使う。前の足から約定を待っている注文は、次の足の注文後の必要証拠金には入れない（楽天の注文中証拠金とは違う。ペアの足が4時間以上無いときだけ起きる）。
    - メールの受け付けの帳簿の時刻は、いつも T とする（米国の夏時間の金曜 20:00 UTC のように、T の後に5分足が無く、次の足が日曜 22:00 UTC でも同じ）。そのときの受け付けは、T の状態（その夕方の NY の引けの代わりの終値の判定の後）で行い、最初に追う足は次の足とする。
  - 追証・ロスカット・期限・不足金:
    - 追証は、UTC の月〜金のすべての日の NY の引けで判定する（祝日と年末年始も。楽天がその日に判定しないことは入れない。仮定）。2つの引けが同じ終値に落ちるときは1回だけ判定し、期限は早い方のものとする。
    - 建玉が無いとき（必要証拠金0）は、資金がマイナスでも追証にしない。
    - 解消は引けの次の5分足から判定し、自分の決済・反対での決済・ロスカットで減った分を数える。
    - 期限で決済するドルのペアは、期限の5分足の始まりまでに終わったドル円の中値の終値で円にする。損益ゼロの行のずらす割合も、同じ時刻までで数える。
    - 不足金は、ロスカットか期限で決済した後に資金がマイナスになったときの、一番大きいマイナスとする。自分の損切りが窓で越えて資金がマイナスになったときは、終わりの資金には出るが、不足金の行には数えない（それには、証拠金をいっぱいに使った建玉で、値段の約4%の窓が要る。#187 の取引で損切りを一番大きく越えたのは −149 pips〈ドル円で約1%〉で、それより大きな窓があるかは測っていない）。
    - 一番悪い値でロスカットを見る行は、判定も決済も、すべての建玉がその足の一番悪い値に同時にいたとする。
  - E\*: 注文の項は受け付けた注文だけで数え（上限で見送ったメールは入れない）、損益はその足のメールを入れる前のものとする。引けの項は建玉が無い引けでも数える。値が同じときは、注文・引け・ロスカット・損益の順、次に早い時刻のものとする（建玉を一度も持たない口座では、ロスカットと損益の項が0のままで、その時刻は2つのプログラムで違う。値は同じで、実データの1万通貨のますはどれも取引を持つので起きない。合わせていない）。証拠金の分は、ロスカットの項では必要証拠金の50%、損益の項では0とする。説明用の行の1万通貨のますにも出す。
  - 説明用の行:
    - 12ペアの行は、楽天の一覧の順に MXN/JPY を豪ドルドルの後、ZAR/JPY を NZドル円の後、TRY/JPY を最後に入れ、時計は12ペアの5分足とする。
    - 反対で決済する行では、メールの量が1,000通貨未満なら決済もせず、1,000通貨未満として見送る。決済はそのメールの入りの値段で行い、T のドル円で円にする。決済は残りの判定より先に行い、残りが見送られても戻さない。
  - ますの数字:
    - 落ち込みなどは、最初の約定（5分遅れの行は最初の5分足の終わり、ほかは T）の時刻以前の最後の終値から、最後に何かが起きた5分足（見送りも含む）の終わりまでで数える。
    - 山と底は、1e-6円より高い・深いときだけ入れ替える（計算の誤差で同じ深さの底が入れ替わらないように）。山に戻ったのは、山から 1e-6円以内に戻ったときとする。何も落ちなければ、山・底・戻った日は出さない。
    - %の落ち込みは、（山 − 今）÷ 山の資金（1万通貨のますは E\* ＋ 山）の最大とする。戻った日は、一番深い落ち込みの山に戻った最初の終値とする。
    - 4時間足の落ち込みは UTC の 0・4・8・12・16・20時の終値で、決済だけの落ち込みは5分足ごとの決済済みの資金で数える（同じ5分足の中の決済の間は見ない）。
    - 一番悪い週と日は、終わりの資金 − 前の終わりの資金とする。下がった週が無ければ、一番小さい上がりを出す。
    - 証拠金÷資金の最大・中央は建玉のある終値で数え、0.8を超えた割合は全体の終値の数で割る。レバレッジは両建ての両方を足す。
    - 口座の前半・後半は 2025-05-19 00:00 UTC の資金で分ける。年あたりは、1万通貨のますは直線、資金の%のますは複利とする。
    - 取った取引の勝率は、口座での決済で数える。「決着した中」は時間切れ以外のすべてで、反対で決済・ロスカット・期限は分母に入れて勝ちにしない。
  - 並べ方・見送り・差:
    - sha256 の文字列は「1|USD/JPY|BUY|2024-01-02T04:00:00.000Z」の形とし、16進の小文字の小さい順に並べる。
    - 残した取引と見送った取引の R は、そのメールの取引（利確1で全部決済）の pips ÷ 13 とする。見送りは理由を問わない。スプレッドを除いた R は、pips に入りの Ask − Bid を足して13で割る。入れ替えの幅は、1,000回の 2.5〜97.5% とする。
    - 上限と証拠金の確かめのますは、上限の8つと、資金の1%・2%の上限なしの2つとする。
    - でたらめに見送る数は、そのますでその週に見送った数（理由を問わない）とする。順位は、下だった回数と同じだった回数で出す。
    - 最後に置いた週の取引が週を越えるときは、その週の元の続きの終値で時計を延ばす（新しいメールは来ない）。
  - 確かめの細かいこと:
    - 円の許し幅は 1e-6円（100万円を超える額はその 1e-12）とする。
    - 独立した確かめで比べないもの（区間と幅、山を下回った期間、証拠金÷資金、レバレッジ、前半・後半・暦年、年あたり）は、money.ts だけで出す。
    - 作り物の確かめの h は入りのスプレッドの半分の平均とし、標準誤差は週ごとにまとめる。独立した確かめは、効き目なしの20通りにだけ当てる（合図の向きに動かす作り物の値動きは、GMO の形のファイルに入らないため）。
    - 実データは END の既定値のまま走らせる。
- **確かめ**（1つでも違えば失敗で終わり、数字は読まない）:
  - データ: 読み込みの失敗0。ドルのペアの取引の間、ドル円の5分足があること（T と、持っているドルのペアに足がある終値ごとに、ドル円の最後の足からの5分足の数〈すべてのペアをまとめた終値で数える。週末と休みは0本〉が12本〈市場の60分〉以下。短い抜けは前の値段を使って数える。確かめるのはメールの取引〈利確1で全部決済〉の間で、ほかの行も前の値段を同じように使う）。取引は #187 と同じ 3,958回（ペアごとに 434・447・433・433・447・435・447・437・445、前半 2,049・後半 1,909）。#187 の表との1件ずつの照合はしない（表は Actions の成果物にしか無く、ここからは取れないため）。代わりに下の再現をする。
  - 再現: 同じ作りで、追う水準だけを前の 30・20 にすると、#187 の今の数字（前半 −0.6018・後半 −0.8298・全期間 −0.7117）が小数4桁まで同じになること。この段は、その3つだけを出す。メールの水準の確かめ（13・4・10・16）と固定は、この段でも外さない。
  - 合図とメールの関数の違い0、メールの水準、30本で打ち切った決済が4時間足の終値と同じ。
  - 口座の式:
    - 終わりの資金 ＝ 始め ＋ 決済の損益の合計（1e-6円）。資金を別のループで数え直して同じ。
    - 量を決めて上限と証拠金を外すと、損益の合計 ＝ Σ 通貨数×向き×（決済−入り）×換算 と完全に同じ。
    - ごく小さい資金の%（1e-6、端数あり、証拠金なし）で、(終わり−1)÷k が R（円）の合計と合う（相対 1e-3）。
    - 決済した5分足の終値で、含み損益が決済の損益と同じ。
    - 量の入力の時刻がすべて入る時刻以前（量を決めた資金を、別のループで T までの決済と T の終値から数え直して同じ）。上限を超えない。注文後の必要証拠金が資金以下。追証の最中に入らない。ロスカットの後・期限の後に建玉が無い。通貨数は 1,000 の倍数で 1,000〜500万。
    - 5分足の落ち込み ≧ 4時間足の落ち込み。
    - 持った5分足の数の合計 ＝ 同時の数の合計。
    - 3分割の各部分（利確1・2・3）の pips が、取引ごとに、利確1・2・3で全部決済した場合の pips と同じ（1e-6）。
    - E\* のちょうど上（1＋1e-9 倍）では何も起きず、少し下（1−1e-6 倍）では1つ以上起きる（1万通貨のますすべて。E\* が0のますは当てはまらないと数える）。
    - 週をそのまま並べると、元の道筋と同じになる。
    - 証拠金を別のループで、入るときと NY の引けごとに数え直して同じ。
  - **独立した確かめ**（`research/money-check.py`。money.ts とは別に書く）:
    - 表から（ペア・足・向き・合図）だけを受け取る。GMO の生のファイルから、すべての取引（利確1・2・3、5分遅れ、楽天のスプレッド）と、25のますと説明用の行の口座、20通りの並べ方、でたらめに見送るうちの最初の3回と、差の点の値を計算し直す。
    - NY の時刻は Python の zoneinfo から。
    - 値段 1e-9、pips 1e-6、決済ごとの資金 1e-6円、出来事の時刻と数は完全に一致すること。引き直しの幅は money.ts だけで、上の「そのまま並べる」確かめと作り物と手の例で確かめる。
  - **手で計算した小さな例**（2つのプログラムが同じ値を出すこと。帳簿・まとめの数字のほか、取引の表の列〈持った5分足の数など〉も比べる）: 週明けの窓で、証拠金がいっぱいのままロスカット／決済で解消する追証／解消しない追証の期限での決済／金曜の追証の月曜の期限／夏時間の切り替わりの週／両建ての証拠金と解消／反対のメールでの決済／1,000通貨未満の見送り／足の無い時刻／上限で、入る足の中で決済される取引／反対のメールで一部を決済して残りを建てる取引。週の並べ替えで、週をまたいで続く建玉と、次に置かれた週の同じペアの反対の建玉（両建ての証拠金）の例は、並べ替えが money.ts だけなので、money.ts と手の計算で合わせる。
- **作り物の値動き**（実データの前。`stop2n.ts` の作り物の作りと同じ、9ペアは互いに関係なし。ただし4時間足は GMO と同じ 0・4・8… 時 UTC の区切りにする〈#187 の作り物は 21時からの区切りで、16時・20時の確定が無く、夜中の行とドル円の 3.8銭を試せないため〉。週も GMO と同じく、米国の夏時間の間は金曜 20:00 UTC、ほかは 21:00 UTC に終わり、日曜 22:00 UTC に始まる〈金曜 20:00 の確定のメールの後に足が無い場合を試すため。§8.92〉。結果を docs に書いてから実データを走らせる）:
  - 効き目なし（20通り）: 確かめと独立した確かめの違い0。勝率（すべての中）が理屈の値（(13−h)÷17、h はスプレッドの半分）の ±2ポイント。1回あたりが −2h の ±3標準誤差。上限の差が幅の外に出るのは1割まで（上限の8つのますで数えた割合と、資金の1%・2%のますを足した10のますで数えた割合の、両方）。
  - 合図の向きに 0.10 pip／5分 動かす（10通り）: すべてで1回あたりがプラス、9通り以上で資金の%のどのますも口座が増え、そのますごとに増え過ぎの知らせが出ること。
  - 逆向き −0.10（10通り）: すべてで1回あたりがマイナス、資金の%のどのますも口座が減る。
- **仕込む誤り**（作り物の上で入れ、確かめで見つかること。誤りごとに「変わった判断と数字の数」を出し、0なら仕込みの失敗として止める。効く場面を手の例に結び付ける。作り物の値動きと手の例の両方で数え、どちらかで変わって見つかれば仕込みの成功とする。週明けのロスカットを飛ばす誤りは、作り物の値動きでは変わる数が0になる〈週明けの窓では、その取引自身の損切りがロスカットの判定より先に決済するため。資金の%の量では、ほかの建玉だけでロスカットに届くことがない〉ので、手の例〈gap_losscut〉で数える。値動きで戻ったら追証を解消にする誤りも、GMO の週末に合わせた作り物の値動きでは追証が出ないので、手の例〈追証の5つの例〉で数える。これはデータの前に決めた）:
  - 4時間後の資金で量を決める（先読み）
  - 決済の足の始まりで枠を空ける（先読み。入る足の中で決済される例）
  - 決済を1本遅らせる／1回を +1 pip
  - ドルのペアを入りの時のドル円で換算する
  - 両建ての証拠金を足し算にする（両建ての例）
  - 量を四捨五入する
  - 週明けのロスカットを飛ばす（窓の例）
  - 追証を決済する側の値段で判定する（追証の例）
  - 夏の NY の引けを 21:55 UTC にする（夏時間の例）
  - 証拠金を入りの値段で固定する（窓・追証の例）
  - 値動きで戻ったら追証を解消にする（追証の例）
- **作り物の結果**（実データの前。46ee45a の版で、9ペアと説明用の3ペア×40回。§8.99 の関門はすべて通った）:
  - 確かめ: 40回すべてで money.ts 自身の確かめは違い0。効き目なしの20回すべてで、独立した確かめ（money-check.py が GMO の形のファイルから計算し直す）も違い0（20回で 9,499万件を照らし合わせた。台帳の行 789万行、取引の値段・時刻・種類 715万件、合図 44万本など）。
  - 効き目のない値動き（path、20回）:
    - 合図（9ペア、1回に約4,100回）の勝率（すべての中の利確1が先）は 20回で 73.95〜76.02%、1回あたり −0.63〜−0.28 pips。20回とも、理屈の値 (13−h)÷17 = 75.29% の ±2ポイントと、−2h（−0.40 pips）の ±3標準誤差の中（関門）。
    - 20回を合わせると、合図 82,501回で 74.82%・−0.481 pips、物差し（9ペアのすべての判定の足で両方向に入る、151万2,000回）で 74.99%・−0.451 pips。
    - 物差しが理屈の値 75.29%・−0.40 pips より 0.3 ポイント低いわけを、データの前に確かめた。作り物は5分足を100の小さな歩み（1歩 −0.35〜+0.35 pips の一様）で作るので、線を越えた歩みは、線から平均 0.104 pips 先で止まる（100万回の試算で測った値。利確の側も損切りの側も同じ）。越えた分を入れた理屈の値は (12.8＋0.104)÷(17＋0.208) ＝ 74.99%、1回あたり −0.452 pips（決済は線の値段なので、越えた分は損益に入らない）。物差しの 74.99%（±0.035）・−0.451 pips と合う。作り物とは別の乱数でも同じだった（JavaScript の Math.random で100万回 75.02%±0.04、numpy で300万回 74.995%±0.025、Python の random で20万回×4 75.24・74.80・74.94・74.99%）。
    - 前に「線を越える分では説明できない」とオーナーに伝えたのは誤りだった。その時の Python の試算（20万回、75.24%）は、種を替えた3回（74.80・74.94・74.99%）と比べて、たまたま高く出た回だった（74.99% から標準誤差の +2.6倍）。
    - 合図の 74.82% は物差しの 74.99% から −0.17 ポイント（標準誤差 0.15、−1.1倍）で、偶然の幅の中。
    - 作り物の乱数（mulberry32）は、出る値の平均が 1/2 よりわずかに小さい（周期の 2^32 個すべてで −3.05×10⁻⁵）。このため作り物の値動きは、4時間あたり約 −0.10 pips 下に動く（作業用の試算の 133本で −0.114±0.016 pips）。合図の買いと売りはほぼ同じ数（seed 1 で 2,060 対 2,042）なので、勝率への効きは打ち消し合う（買いだけなら約 −0.15 ポイント、売りだけなら約 +0.15 ポイント）。作り物だけの性質で、実データには関係しない。
    - 上限で残した取引 − 見送った取引が、週の中で並べ替えた幅の外に出たのは、上限の8つのますで 149組中11（7.4%）、資金の1%・2%のますを足した10のますで 189組中14（7.4%）（関門はどちらも1割まで）。どの取引も見送らず差の無い組が 11組。
    - 先読みを疑う知らせ（下の「先読みを疑うとき」）は、効き目が無くても1回に 0〜24行出た。多いのは、含み損益込みの落ち込みが決済だけの落ち込みより小さいもの（20回で101行、いろいろなますと行で。差は15〜2,675円、中央値354円）、上限1つのますの勝率が 76.5% 以上のもの、5分遅れ・夜中を見送った行が1回あたり良いもの。偶然でも出るので、実データでは出た行ごとに中を調べて、何を調べたかを書く（行が出たことだけでは判定しない）。
  - 合図の向きに 0.10 pip／5分 動かす（drift、10回）: 合図 41,107回で 82.33%・+0.80 pips（1回あたり +0.695〜+0.947）。10回すべてで1回あたりがプラス。10回すべてで資金の%の20のますすべての口座が増え、ますごとに増え過ぎの知らせが出た（関門は9回以上）。
  - 逆向き −0.10（against、10回）: 66.23%・−1.94 pips（−2.047〜−1.842）。10回すべてで1回あたりがマイナス、資金の%のどのますも口座が減った。
  - 実行の時間: 引き直し1,000回・でたらめに見送る200回の回（path の seed 1）が 48.8分。120分以内なので、回数はそのまま。
  - 仕込んだ誤り（path の seed 1 で、引き直し4回・見送り3回。誤りの無い回と比べて、変わった台帳の行・取引の行・数字。12の誤りすべてを数えた）:

    | 誤り | 台帳の行 | 取引の行 | 数字 | 見つけたもの |
    |---|---|---|---|---|
    | 4時間後の資金で量を決める | 191,828 | 0 | 1,180 | money.ts の確かめ（量の元の資金）166,107件、独立した確かめ（51万2,854件） |
    | 決済の足の始まりで枠を空ける | 66,209 | 0 | 1,139 | money.ts の確かめ（上限）130件、独立した確かめ（53万7,219件） |
    | 決済を1本遅らせる | 392,408 | 27,408 | 4,288 | 独立した確かめ（189万9,066件） |
    | 1回を +1 pip | 355,418 | 1 | 2,284 | money.ts の確かめ（置き場所）1件、独立した確かめ（82万6,493件） |
    | ドルのペアを入りの時のドル円で換算 | 392,304 | 0 | 3,008 | 独立した確かめ（83万3,975件） |
    | 両建ての証拠金を足し算 | 2 | 0 | 45 | 独立した確かめ（2件） |
    | 量を四捨五入 | 270,779 | 0 | 2,123 | 独立した確かめ（103万5,240件） |
    | 追証を決済する側の値段で判定 | 0 | 0 | 24 | 独立した確かめ（12件） |
    | 夏の NY の引けを 21:55 UTC | 18,470 | 726 | 157 | 独立した確かめ（13万9,462件） |
    | 証拠金を入りの値段で固定 | 88,472 | 0 | 390 | 独立した確かめ（8万8,551件） |
    | 週明けのロスカットを飛ばす | 0 | 0 | 0 | 作り物では変わらない（前に決めたとおり）。手の例 gap_losscut で見つけた |
    | 値動きで戻ったら追証を解消 | 0 | 0 | 0 | 作り物では変わらない（前に決めたとおり）。追証の5つの手の例で見つけた |

    - 手の例（19。money.ts で19、独立した確かめで18。boot_carry_hedge は引き直しの例で money.ts だけ）は、誤りの無いときすべて合った。2つのプログラムの台帳・取引・まとめを横に並べても違い0（18の例）。手の例ごとに挙げた誤りを入れると、58の組み合わせすべてで失敗した。
    - 仕込んだ誤りと手の例の数字は、独立した見直しの3回目が 46ee45a と同じ中身のファイル（研究のプログラム14本と手の例の md5・sha256 が一致）で出したもの。
  - 限り: 作り物の細かい歩みは線をわずかに越えて止まるので、作り物の上の勝率と1回あたりの見込みは、理屈の値より少し低い（物差しで 74.99%・−0.45 pips）。乱数の性質のわずかな下向きの動きは、買いと売りで打ち消し合う。関門の理屈の値は前に決めたまま（75.29%・−0.40）で、すべての回がその幅の中に入った。実データの数字の読み方は変わらない。
- **実データの1回目**（2026-10-05 00:01〜00:26 UTC、run 37245830575、056f24c。失敗）:
  - 1段目（#187 の再現、LEVELS=old）と2段目（試算。money.ts 自身の確かめと #187 の 3,958回の門）は通った。3段目の独立した確かめが違いを見つけて失敗した（108,776件）。決まりどおり、数字は読まない。
  - 違いの元: 説明用の3ペアのうち TRY/JPY・MXN/JPY の9つの合図（どれも T が月曜 00:00 UTC）で、money-check.py が楽天の行（rakuten）を「データが先に尽きた」として、その合図を5つの行ごと落とした。そのため12ペアの説明用の行（p12）の2つの回だけが食い違った。ほかの25のます・説明用の行・並べ方・でたらめに見送る回・残した取引と見送った取引・窓は違い0。
  - 原因は money-check.py の誤り: 楽天の行だけ、足の時刻も打ち切り（30本目の4時間足の終わり）の手前で切ってから追っていた。打ち切りが週末の休みの中にあると、手前の最後の5分足は打ち切りより前に終わるので、データが先に尽きたと判定していた。money.ts は全部の足で追っていて、§8.99 のとおり（打ち切りの手前の最後の5分足の終値で決済）。値幅の小さい説明用のペアだけが、1週間決着せずに打ち切りまで残った。作り物の値動きにも手の例にも打ち切りまで残る取引が無かったので、データの前には見つからなかった。
  - 見てしまった数字: 失敗の理由を読むために3段目の出力の末尾を読み、違いの例として p12 の行の数字（2つのプログラムの、最後の残高・勝率・1回あたり・E* など）と、違った取引の帳簿の行を見た。2段目の試算の出力と成果物（artifact）は読んでいない。測り方は変えない。
  - 直したこと（056f24c の後のコミット）:
    - 手の例 timeout_closure を足した（20個目）。GBP/JPY の日曜 20:00 の足の買いで、どの水準にも届かず、金曜 22:00（休みの前の最後の5分足の終わり）に打ち切りで決済する。手の計算と2つ目の計算（recompute.py）は一致した。
    - 直す前の money-check.py は、この手の例で本番と同じ理由（rakuten: not followed to its end）で失敗し、money.ts は通った。
    - money-check.py の1行を直した（足の時刻は全部、値段は打ち切りまで渡す）。直した後は、手の例20個すべてが両方のプログラムで通り、2つのプログラムの出力の横並べも違い0。作り物の値動き2回（path の seed 2・3）の照らし合わせも違い0。
    - money.ts は変えていない（作り物の seed 2 の出力は、実行時間のほかは前の回と同じ）。手の例の作り（make.py）の決まりの文1つ（「どの取引も TP か損切りで終わる」に、この例の例外を書き足した）を変え、ほかの手の例の数字は変わっていない。
  - 2回目を走らせる。money.ts と END は変えていないので、試算の数字は1回目と同じになるはず。1回目と2回目の試算の出力（money.json の実行時間を除いたもの・帳簿・取引の表）が同じかを、中身を読まずに指紋（sha256）で確かめる。
- **実データの2回目**（2026-10-05 00:39〜01:11 UTC、run 37248350037、8af5498。3段とも通った）:
  - 1段目（#187 の再現、LEVELS=old）: 3つの平均 −0.6018・−0.8298・−0.7117 が4桁まで同じ。
  - 2段目（試算）: #187 の 3,958回と同じ取引（ペアごと・前半 2,049・後半 1,909 も同じ）。GMO の読み込みの失敗0。money.ts 自身の確かめはすべて違い0（合図 9,056件・メールの水準 5,543件・終値 37,831件・置き場所 25,053件・ドル円 18,097件・道筋 19,108件、口座の14項目〈台帳の 146,161件ほか〉、3部の5項目〈引き直し 26,000件ほか〉）。
  - 3段目（独立した確かめ。money-check.py が GMO の生のファイルから計算し直す）: 24項目すべて違い0（合図 20,588件、ファイル 48、取引の値段 128,675件・時刻 77,205件、台帳の行 358,285行、台帳の量と円 各 1,433,140件、まとめの円 564件、E\* 104件、並べ方 240件、でたらめに見送る回 120件、窓 90件など）。
  - 1回目と2回目の同じこと: 試算の出力50ファイル（台帳47・取引の表・合図の表・money.json〈実行時間の2つを除く〉）の sha256 がすべて同じ（`money-same.yml`、run 37250824588）。2段目の印字254行も、実行時間の3行のほかは同じ。この作業環境からは成果物の保管場所につながらない（組織のネットワークの決まり）ので、照合は GitHub の実行環境でした。中身は読んでいない。
- **結果: 取引ごと**（9ペアの 3,958回、利確1で全部決済、GMO の値段、スプレッド込み。口座と関係ない）:
  - **勝率（利確1が先、すべての中）73.3%**（決着した中も 73.3%。打ち切り0）。**1回あたり −1.06 pips**（95%区間 週 [−1.40, −0.72]、4週 [−1.43, −0.69]）、中央値 +3.6、R −0.081。
  - 1万通貨で1回あたり −111円（[−148, −74]）、1年あたり（1,477回）−163,872円（−223,024〜−104,720円）。勝ちの平均 +3.6 pips、負けの平均 −13.3、最悪の1回 −54.5（R −4.19）。窓で損切りより大きく負けた 10回（平均 −22.9）。払ったスプレッド 0.50 pips（中央値）。
  - 前半 2,049回 73.8%・−0.96 pips（[−1.52, −0.40]）、後半 1,909回 72.8%・−1.17 pips（[−1.57, −0.77]）。
  - 前提の1行「9ペアの 13・4 の1回あたりは0より下か」: 高い方の上の端が、全期間 −0.69・前半 −0.35・後半 −0.70。**どれも0より下（はい）**。
  - 損益ゼロに要る勝率（決着した中）は、データの前の見込みで 76.5%（スプレッド無し）・78.5%（0.7 pips）。73.3% は届かない。
  - 利確2で全部 54.2%・−1.06 pips、利確3で全部 43.2%・−1.01、5分遅れ 3,276回（682回は入る前に水準を越えて見送り）67.2%・−1.08、楽天の広告のスプレッド（取引の 69.9% に当てた）73.8%・−0.94。
  - 物差し（9ペアのすべての判定の足で両方向、75,186回。#187 と同じ数）70.5%・−1.65 pips。合図の利確1が先は物差しより +2.8 ポイント。
  - 12ペア（説明用、5,147回）: 70.5%（決着した中 74.1%、打ち切り 4.8%、その平均 −3.1 pips）・−1.01 pips。
  - 持った時間: 5分足の数で中央3・95%の点41・最大185。暦の時間で中央 0.25時間・95%の点 3.83時間・最大 57.58時間。週末をまたいだ 31回、楽天の NY の引けをまたいだ 224回（スワップ 302日。1万通貨で1日 ¥1,311 のスワップが、1回あたりを ¥100 動かす）。
  - 同時に持っていた数（5分足の終値ごと、198,418個）: 最大9（2024-04-04 20:05 UTC）、1つ以上の時間 14.4%・3つ以上 0.9%・5つ以上 0.1%、平均 0.191。円の同じ向きの最大7。ペアごとの最大は豪ドル円が2、ほかは1。同じペアの両建て0。メールの数ごとの足の数: 1つの足 1,086本、2つ 497本、3つ 230本、4つ 112本、5つ 60本、6つ 41本、7つ 16本、8つ 8本、9つ 2本。持った5分足の数の合計 37,951 ＝ 同時の数の合計 37,951。
  - データの前の見込み（1回あたり約 −114円、1年あたり約 −17万円）と近い。
- **結果: 見出し**（毎回1万通貨・上限なしで、すべてのメールが受け付けられ、追証もロスカットも起きないために要った最初の口座、1万通貨あたり。この期間を後から見て要った額）: **E\* ＝ 901,483円**（1,000通貨なら約9万円）。
  - 2026-05-28 16:00 UTC の注文の項で決まった: それまでに減った 432,963円 ＋ その時に持っていた取引の証拠金 468,520円。4つの項: 注文 901,483円（2026-05-28 16:00）、NY の引け 616,527円（2026-08-17 20:55）、ロスカット 611,297円（2026-08-26 06:10）、マイナスの最大 452,860円（2026-08-18 01:15）。
  - 週の並べ替えの幅 738,961〜1,003,609円（1週のまとまり）。52週の窓 89個で、中央 589,969円・最大 696,644円（2025-06-15 からの窓、注文の項）。損益ゼロに直した道筋（δ ＋111.0円）の E\* は 506,968円。
  - 横に: 勝率 73.3%、1回あたり −1.06 pips（[−1.43, −0.69]）、−111円（[−151, −71]）、1年あたり −163,872円。データの前の見込み（約60万〜130万円）の中。
- **結果: オーナーに見せる表**（13のます。[ ] は週の並べ替えの 5〜95%〈1週と4週の広い方〉。資金の%のますは100万円から・25倍・ロスカット50%。25のますのどれでも、追証・ロスカット・不足金は0回）:

  | ます | 口座 | 一番深い落ち込み（含み損益込み） | 一番悪い週 | 取った数（見送り） | 勝率・1回あたり |
  |---|---|---|---|---|---|
  | 毎回1万通貨・上限なし | 円の合計 −439,237円 [−570,704〜−310,403] | 455,501円（E\*＋山の 50.4%） | −25,414円 | 3,958 | 73.3%・−1.06 pips（−111円） |
  | 資金の0.25%・上限なし | 457,013円（−54.3%）[365,293〜570,928] | 55.3% | −31,667円 | 3,958 | 73.3%・−1.06 |
  | 資金の0.5%・上限なし | 215,175円（−78.5%）[140,962〜315,324] | 79.4% | −48,856円 | 3,776（証拠金で182） | 73.2%・−1.08 |
  | 資金の1%・上限なし | 84,670円（−91.5%）[49,483〜155,254] | 91.9% | −85,202円 | 3,017（証拠金で941） | 73.2%・−1.07 |
  | 資金の2%・上限なし | 83,779円（−91.6%）[42,245〜199,406] | 92.9% | −100,543円 | 1,737（証拠金で2,221） | 73.9%・−0.90 |
  | 1万通貨・1つずつ | −230,785円 [−293,522〜−171,506] | 242,103円（74.0%） | −10,565円 | 2,017（上限で1,941） | 73.0%・−1.11 |
  | 1万通貨・3つまで | −393,260円 [−502,016〜−296,673] | 406,004円（65.5%） | −18,958円 | 3,485（473） | 73.3%・−1.08 |
  | 1万通貨・1ペア1つ | −439,627円 [−571,094〜−310,793] | 455,891円（50.4%） | −25,414円 | 3,957（1） | 73.3%・−1.06 |
  | 1万通貨・円の同じ向き2つまで | −366,347円 [−469,077〜−271,468] | 378,381円（57.4%） | −18,724円 | 3,306（652） | 73.4%・−1.05 |
  | 0.5%・1つずつ | 423,975円（−57.6%）[344,105〜515,607] | 59.0% | −29,816円 | 2,017（1,941） | 73.0%・−1.11 |
  | 0.5%・3つまで | 239,958円（−76.0%）[167,841〜330,099] | 76.8% | −49,248円 | 3,485（473） | 73.3%・−1.08 |
  | 0.5%・1ペア1つ | 214,567円（−78.5%）[140,677〜314,237] | 79.5% | −48,856円 | 3,775（上限1・証拠金182） | 73.2%・−1.08 |
  | 0.5%・円の同じ向き2つまで | 269,719円（−73.0%）[193,669〜366,361] | 73.8% | −44,842円 | 3,306（652） | 73.4%・−1.05 |

  - 1万通貨の上限のますの E\*: 1つずつ 325,107円、3つまで 616,957円、1ペア1つ 901,873円、円の同じ向き2つまで 656,285円。
  - 1万通貨・上限なしの前半・後半 −204,328・−234,909円、暦年 2024年 −89,729・2025年 −247,954・2026年（10月2日まで）−101,555円。
  - 同じ足のメールの順（20通り）での幅: 0.25% は変わらず（457,013円）、0.5% 210,052〜231,830円、1% 71,638〜96,022円、2% 59,579〜102,238円。
  - データの前の見込み（0.25% 約47万円・0.5% 約22万円・1% 約5万円・2% 約0.6万円）と比べて、0.25%・0.5% は近い。1% と 2% は見込みより残った。見込みは証拠金で断られる分を入れていなかったが、実際は 1% で941回、2% で2,221回が証拠金で断られ、そのぶん負けが少なかった（見込みでは「メールの約1〜3割」。2% は56%）。
- **結果: 上限と証拠金の確かめ**（R ＝ そのメールの取引の pips ÷ 13）: 残した取引 − 見送った取引は、1つずつ −0.009 R、3つまで −0.014、円の同じ向き2つまで +0.005、1%の証拠金 −0.003、2%の証拠金 +0.022。どれも、同じ週の中で入れ替えた幅（と、ペアごとにそろえた幅）の上の端を越えていない（先読みを疑う知らせ0）。上限で損が減ったのは、残した取引が良いからではなく、取る数が減ったから（先に書いたとおり）。同じ週に同じ数をでたらめに見送った200回と比べても、上限のますの円・落ち込みは200回の中ほど（例: 1万通貨・1つずつの円は200回中69回がそれより下）。
- **結果: 説明用の行**（1つだけ変える。左が毎回1万通貨・上限なし、右が資金1%・上限なし）:
  - 12ペア: −537,797円（70.5%・−1.01 pips、E\* 1,005,004円）／45,306円（−95.5%、69.8%・−1.00）
  - 5分遅れ: −373,014円（3,276回、67.2%・−1.08、E\* 835,046円）／95,266円（67.0%・−1.22）
  - 夜中（日本時間1時・5時）を見送る: −246,104円（2,511回、75.2%・−0.88、E\* 667,075円）／283,191円（−71.7%、75.3%・−0.84）
  - 利確1・2・3に分ける: −441,924円（73.3%・−1.05、E\* 893,088円）／85,101円（73.3%・−1.07）
  - 反対のメールで決済: 上限なしのますと同じ数字（同じペアで反対のメールが、持っている間に来たことが無かった。両建て0）
  - 楽天の広告のスプレッド: −393,517円（73.8%・−0.94、E\* 860,043円）／132,970円（74.0%・−0.86。追証1回: 2025-10-23 20:55 UTC に 1,253円、2025-10-24 00:05 に解消）
  - 10倍コース: 1% 289,456円（−71.1%、証拠金で2,493回見送り、72.6%・−1.09）、0.5% 331,523円（−66.8%、73.1%・−1.10）
  - ロスカットを一番悪い値で・追証の厳しい解消: 上限なしのますと同じ（追証もロスカットも起きなかった）
  - 証拠金の上限なし（1%）: 40,016円（−96.0%、73.3%・−1.06）
  - 損益ゼロに直した参考: 1万通貨は円の合計0・落ち込み 137,479円（E\* 506,968円）、1% は 969,562円（−3.0%）・落ち込み 44.8%
  - タートルの減らし方: 1% 109,772円（−89.0%、73.4%・−1.06）、0.5% 282,396円（−71.8%、73.2%・−1.08）
- **問いへの答え**（この期間の1つの道筋の上で）:
  1. メールを全部取っていたら、口座は減った。1万通貨で −439,237円（1回あたり −111円）。資金の%では、0.25% で 54%、0.5% で 79%、1% と 2% で 92% 減った（勝率はどれも 73〜74%、1回あたり −0.9〜−1.1 pips）。
  2. 同時に持っていたのは最大9本、1本以上の時間は 14.4%、円の同じ向きは最大7本。
  3. 楽天の決まり: 25のますで追証・ロスカットは0回。効いたのは新しい注文の証拠金の上限で、1% で 941回、2% で 2,221回のメールが断られた。
  4. 上限で損は減ったが、取る数が減った分だけ（残した取引は見送った取引より良くない）。1回あたりはどの上限でも −1.05〜−1.11 pips。
  5. 1万通貨・上限なしの落ち込み 455,501円のうち、損益ゼロに直しても残る分は 137,479円（約3割）。残りの約7割は1回あたりのマイナスによる。
- **先読みを疑う知らせ**（3行。報告の前に、2回目の成果物から `research/money-look.py` で調べた。run 37251044596）:
  - 取引の知らせは0（どの行も勝率 76.5% 未満、1回あたりがプラスの行なし、100% なし）。上限と証拠金の知らせも0。口座が増えたますは無い。
  - 12ペア・資金1%（row_p12_FF1_C0）の、含み損益込みの落ち込み 972,822円が、決済だけの 974,110円より 1,288円小さい: 決済だけの山は 2024-01-10 08:40 UTC の決済での残高 1,018,431円だが、その時ほかの取引が −6,930円の含み損で、有効証拠金は 1,011,501円だった。有効証拠金の山は 2024-01-03 12:40 UTC の 1,016,210円で、残高の山に届かなかった（2,221円低い）。谷は、有効証拠金 43,388円（2026-08-13 22:00）・残高 44,321円（2026-08-18 04:00）で、有効証拠金の方が 933円深い。2,221 − 933 ＝ 1,288円。残高が山のときに含み損があったためで、後の値段は使っていない。作り物でも同じ知らせが20回で101行出ていた（差の中央値354円）。
  - 夜中を見送る行（2つ）が1回あたり良い: 3,958回を確定の時刻で分けると、夜中（16:00・20:00 UTC）1,447回 70.1%・−1.37 pips、それ以外 2,511回 75.2%・−0.88 pips。差 +0.49 pips の95%区間（週を引き直す2,000回、種188）は [−0.19, +1.13] で0を含む。見送りは確定の時刻だけで決まり（メールの時点で分かる）、後の値段は使っていない。払ったスプレッドを足し戻しても差は +1.09 [+0.41, +1.76] で、夜中の差はスプレッドの分ではない。作り物（効き目なし、path の seed 2）でも、夜中とそれ以外の差が逆向きに 0.38 pips 出た（[−0.83, +0.09]）。
  - 調べるために時間ごとの数字も出して見た（§8.99 では「時間ごとの成績は出さない」と決めていた。先読みの確かめのためだけに見たもので、結果に入れず、何かを変える理由にしない。§8.24 ④）: 00:00 UTC 442回 68.8%・−3.68 pips（払ったスプレッドの平均 4.61・中央値 2.80 pips）、04:00 694回 77.7%・−0.08、08:00 682回 77.6%・−0.14、12:00 693回 74.6%・−0.63、16:00 991回 75.4%・−0.48、20:00 456回 58.6%・−3.29。00:00 UTC（日本時間 9時の直前の値段）で入る取引の GMO のスプレッドが大きいわけは調べていない（試算と独立した確かめは、どちらも同じ GMO の値段を使う）。
- 印字した区間・幅は236（取引の区間45、並べ替えの幅99、入れ替えの幅20、並べ方の幅72）。良く見えるものがあっても、2026-10-05 からの取引で前もって決めて確かめるまでは、入れる理由にならない（§8.24 ④）。
- **限り**（上の「限り」に足す）: 結果は GMO の値段で、楽天の値段ではない。楽天の広告のスプレッドの行（−0.94 pips）が近づけたもの。00:00 UTC の確定の値段のスプレッドは、実際にメールを見て入る時（9時を過ぎた後）より大きいかもしれない。
- **先読みを疑うとき**（報告の前に調べ、何を調べたかを書く。CLAUDE.md）:
  - どのます・説明用の行でも、口座が増えた（1万通貨は円の合計が0以上）。9ペアの1回あたり、または、どのます・説明用の行で取った取引の1回あたりがプラス。
  - どのます・説明用の行でも、取った取引の勝率（決着した中）が 76.5%以上（スプレッドを除いた損益ゼロ）。100% のもの。
  - 上限・証拠金で残した取引が、見送った取引より幅を超えて良い。
  - 5分遅れ・夜中を見送ったほうが良い。
  - 含み損益込みの落ち込みが、決済だけの落ち込みより小さい。
- **前に見たもの**: §8.98（21ペアの 13・4 の数字。9ペアの合図を含む）、§8.97（同じ 3,958回の 30・20 の数字）、§8.82・§8.93（30・20）。9ペアの 13・4 の取引ごとの数字（9ペアをまとめた勝率と1回あたり、口座の数字）は、まだ誰も見ていない。ただし §8.98 の実行（run 37191488441）の記録には、21ペアそれぞれの時間足ごとの利確1が先の割合と決着した数（9ペアのそれぞれの4時間足を含む。tf-winrate の数え方で、Q-Trend と ULTRA を1つにまとめておらず、この節の 3,958回と同じ取引ではない）が出ていて、#192 の見直しの作業用に保存してある。この測り方の決め方には使っていない。
- **データの前の見込み**（§8.98 の21ペアの数字から計算。結果ではない。損切り13・利確4・打ち切りの3つに分けた形、作業用の `scratchpad/mm188/final_expect.py`）:
  - 損益ゼロに要る利確1が先の割合（決着した中）: スプレッド無しで 76.5%、GMO の中央値 0.7 pips で 78.5%、ドル円の 3.8銭（日本時間 5時の確定）で 87.6%。
  - 値動きに偏りが無く打ち切りも無い場合の理屈の値は約74%（(13−0.35)÷17）。§8.98 で実際に測った物差し（同じ時間足の終値から抜き出した足で両方向に入った場合）は 71.6%・−1.55 pips で、合図はその 2.3 ポイント上（区間 0.9〜3.7、§8.98）。
  - 毎回1万通貨: 1回あたり約 −114円、1年あたり約 −17万円（−13万〜−21万円は §8.98 の21ペアの平均の95%区間から。9ペアは回数が少ないので、もっと広い）。要った口座 E\* は約 60万〜130万円（うち減った分が約45万円。残りの証拠金の分は、メールが同じ足に重なる度合いで決まり、まだ測っていない）。
  - 資金の%（100万円から、証拠金の上限と断られる分を入れない計算）: 0.25% で約47万円（落ち込み約54%、一番悪い週 約 −3%）、0.5% で約22万円（約79%、約 −7%）、1% で約5万円（約96%、約 −13%）、2% で約0.6万円（1,000通貨に届かず止まる）。損益ゼロの仕組みでも、1%で約43%落ちる。
  - 証拠金（25倍、1%、値段は仮の値）: ドル円1回で口座の約46%、ポンド円で約59%。1本では上限に届かず、同時に2〜3本で届く（ドル円＋ポンド円など4つの組は2本でも入らない。豪ドルドル＋NZドル円＋豪ドル円の3本は約77%で入る。同じペアの両建ては多い方だけ数えるので、それより多く入ることもある）。メールの約1〜3割が証拠金で断られる見込み（作り物で、合わせ込んでいない）。
  - 10倍コースでは、ドル円・ユーロ円・ポンド円・スイス円は1本でも1%を賭けられない（ドル円で約0.87%まで）。2%（25倍）では、値段が162.5円を超える円のペアは1本も持てない。どちらも資金が大きいときの話で、1,000通貨単位の切り捨てのため、資金が小さくなると持てるようになる（2%で資金10万円なら約166.7円、1万円なら250円まで）。
  - 損切りを越える窓: 同じ大きさの窓（#187 の最悪は −149 pips）に損切り13で当たれば −11.5回分（1%なら口座の −11.5%）。
- **限り**:
  - 楽天FXの値段ではない（GMO）。広告のスプレッドの行だけが近づけたもの。早朝・休日・指標の時の広がりは入れていない。ドル円の 0.1銭のキャンペーン（2026-06、3万通貨まで）も入れていない。
  - スワップは数えていない（またいだ数と、効き目が出る額だけ）。
  - ロスカットを調べる間隔と使う値段、追証の最中の新しい注文、追証の解消の数え方、決済の注文の注文中証拠金（取らないとする）、ドルのペアの必要証拠金の円への換算（同じ5分足のドル円の中値とする）、10倍コースのロスカットの水準（40〜95%から選ぶもので、50%とする）、ペアごとの証拠金率（すべて4%とする）は仮定。新しい注文の受け付け（有効証拠金）はページで確かめた。
  - 楽天のメンテナンス（日本時間 6:55〜7:10、米国の夏は 5:55〜6:10）は入れていない。月曜の始まりは、楽天も GMO も 7:00 JST（§8.93。GMO は 2026-09-13 の週だけ 6:00）。
  - 追証の期限の、年始（1月1日は楽天の取引日でない）の繰り延べと、年末年始・クリスマスに楽天が別に決めることがある期限は入れていない（どれも次の平日 09:00 UTC とする仮定）。
  - すべりは窓だけ。
  - 測れない8つの FX の銘柄と金は入っていない。TRY/JPY・ZAR/JPY・MXN/JPY も説明用の行だけ。見出しと25のますの同時に持つ数・証拠金・E\* は少なめに出る。
  - この期間の1つの道筋だけ。E\* は後から見た額で、期間が長いほど大きくなる。
  - 作り物（9ペアは互いに関係なし）には、円のペアどうしが同じ向きに動く関係が無い。
  - 2N の損切りは、新しい水準では測っていない。
- **オーナーに伺うこと**（答えまでは既定で測る。答えは説明用の行を足すだけで、見出しは変えない）:
  1. 楽天FXのコースとロスカットの水準（既定: 25倍・50%）
  2. メールは全部取るか、夜中（1時・5時）も取るか（既定: 全部。夜中を見送る行も出す）
  3. 同じ足の Q-Trend と ULTRA は1つか2つか（既定: 1つ）
  4. 量は同じ通貨数か、資金の%か（既定: 見出しは1万通貨、表は全部）
  5. 利確1・2・3の使い方（既定: 利確1で全部。分ける行も出す）
  6. 両建てか、反対のメールで決済か（既定: 両建て）
  7. 追証で入金するか（既定: しない）
  8. 損切り・利確をすぐ置くか、メールから注文まで何分か（既定: すぐ置く・確定の値段。5分遅れの行も出す）
  9. 口座の大きさ（既定: 聞かない。1万通貨あたりと%で出す）
  10. 金（楽天証券の CFD、別の口座）も取引するか（既定: 入れない）
- **アプリに入れうること**（決めるのはオーナー。ルール③で、測った数字だけを出す）:
  - Q-Trend・ULTRA のメールに「1万通貨で損切りなら約1,300円（ドルのペアは13ドル、金は1オンス13ドル）」を足す（#111 と同じ。測定も設定も要らない）。
  - 測った後に、口座についての1行を足す。
  - 上限でメールを止めるのは売買の決まりの変更で、§8.24 の確かめが要る（ルール②には成績の記録〈§8.95 の候補4〉が要る）。
  - 数量の計算を戻すのは、「設定は増やさない」を戻すことになる。
- **次の順番**:
  1. この節を docs に入れる（データの前）。
  2. 楽天の注文の受け付けの条件（発注可能額）と、10倍コースのロスカットの水準を読む（読み取りだけ）。違えばこの節を直す。→ 済み（2026-10-04）: 受け付けは有効証拠金で、仮定と合っていた。10倍コースのロスカットは 40〜95% から選ぶもので、50% とする仮定のまま。AS 注文の決済の順と取り消しを書き足した。
  3. プログラムと独立した確かめを書き、手の例・作り物・仕込んだ誤り・独立した見直しで確かめる。→ 済み（46ee45a。独立した見直しと3回の照らし合わせ）。
  4. 作り物の結果を docs に書く。→ 済み（2026-10-05、上の「作り物の結果」）。
  5. 実データを1回だけ走らせる。→ 1回目は確かめのプログラムの誤りで失敗した（上の「実データの1回目」）。直した2回目は3段とも通り、試算の出力は1回目と同じだった（上の「実データの2回目」）。
  6. 勝率と1回あたりを並べて、日本語で報告する。→ 済み（2026-10-05）。

### 8.100 移動平均線を3本にし、それぞれの数字を選べるようにした（#200）

- **指示**: 「移動平均線を設定できる様にして　数字選んで」、続けて「3つほしい」（2026-10-05）。
- **何を変えたか**（`src/lib/emaLines.ts`・`src/lib/chartPrefs.ts`・`PriceChart`・`LiveChart`）:
  - 移動平均線を3本にした。初めは EMA 50（オレンジ `#FF9800`）・EMA 200（紫 `#E040FB`）・EMA 20（水色 `#00BCD4`、新しい3本目）。
  - 各線の行に ⚙ を付けた。押すと「移動平均線の設定」が開き（全画面では、⚙ のある設定のシートの中の設定まで動く）、線1の数字の欄に移る。3本それぞれの数字と種類を選べる。
    - 数字はボタン（5・10・20・25・50・75・100・200）で選ぶか、1〜500 の整数を打ち込む。打っている途中の数も、1〜500 の整数ならその場で線に反映する。欄は空にして打ち直せる。範囲の外・整数でない数・空は受け付けず、欄は赤い枠になる。欄を離れると、線に使っている数字に戻る。
    - 種類は EMA（指数）か SMA（単純）。計算はどちらも TradingView と同じ（EMA は最初の n 本の単純平均から始め、以後 2/(n+1) ずつ。SMA は直近 n 本の平均）。
    - 「初期設定（EMA 50・200・20）に戻す」ボタン。
  - 線の名前・左上の値・説明文は、選んだ数字と種類で出す（例「SMA 25」）。
  - **GC・DC（ゴールデンクロス・デッドクロス）**は、線1と線2の交差にした。短い方を速い線とする（初めは今までどおり EMA 50×200）。同じ数字で種類だけ違う2本（例 EMA 50 と SMA 50）は、先に動く EMA を速い線とする。線1と線2の並びを入れ替えても同じ印になる。線1と線2が同じ数字・同じ種類なら交差は出ず、説明文にそう出す。線3は交差に使わない。印は、線と同じくチャートの描く範囲の中だけに描く。
  - **計算に使う足**: リアルタイムチャートが画面のほかに読む足（ふだんの履歴）は、最新の確定足600本で、画面の120本と重なる。画面より前にあるのは約480本（GMO のペア。Twelve Data のペアは約680本）で、合わせて約600本になる。ただし GMO の日足は今年と去年のファイルだけを読むので、これより少ない（コードから数えると、2026-10-05 で画面より前に約337本、1月の初めは約144本。実データでは数えていない）。
    - EMA は最初の値（初めの n 本の平均）の影響が、1本ごとに (1 − 2/(n+1)) 倍ずつ残る。期間の約3倍の足がないと、TradingView の値とずれる。ふだんの約600本では、EMA 300 で最新の値に最初の値が約13%残る。EMA 500 では約67%残る（独立した見直しで、長い履歴で計算した値との差が約1 ATR になった）。
    - そのため、**200より長い線**か、**ふだんの履歴では足りない線**（GC・DC に使う線を含む）がオンの間は、Zero-lag TEMA と同じ深い履歴（1,400本。GMO のペアで画面より前に約1,280本）を読む。深く読むかは、リアルタイムチャートが1回だけ決めてチャートに渡す。初期設定の3本は、15分足・1時間足・4時間足ではふだんの履歴で足りるので、今までどおり深くは読まない。GMO の日足では、初期設定の EMA 200 も足りないので深く読む。
    - 深い履歴は、ふだんの履歴より多く読めたときだけ使う。読み終わるまでと、読めなかったとき・途中で止まってふだんの履歴より短いときは、ふだんの履歴で引き、説明文にそう出す（次の足で読み直す）。説明文に出すのは、移動平均のために深く読むときだけ（Zero-lag TEMA のためだけに読んだ深い履歴でも、多ければ線の計算に使うが、そのときの線はふだんの履歴で足りているので何も言わない）。
    - 深い履歴を最後まで読んでも、ふだんの履歴より多くなかったペア・時間足（GMO の週足・月足は、ふだんの履歴で GMO にある足を全部読んでいる）では、それ以上は深く読まない。その線は、足りない理由（引けない・途中から）だけを説明文に出す。
    - 足が足りない線は、説明文に理由を出す。期間より足が少なく引けない（週足・月足など）、画面より前の足が足りず画面の途中から引いている、計算に使えた足が少なく TradingView の値とずれる（EMA で、最新の値に最初の値が5%より多く残れば「少し」、25%より多く残れば「大きく」）。途中から引いている EMA は、ずれも合わせて言う。
    - 数字の上限は500。深い履歴があれば、500本の線も画面の最初の足から引ける。足の少ない時間足・ペアでは、上の理由が説明文に出る。
  - **保存**: 数字と種類は、ほかの設定と同じく、この端末とアカウント（§8.53、`user_chart_prefs`）に保存する。前から保存してある設定（数字が無い）は、初期設定の3本として読む。3本目のスイッチは、前の設定には無いので「オン」から始まる。
  - 線1・線2のスイッチの名前（`ema50`・`ema200`）は、アカウントに保存してあるオンオフを引き継ぐため変えていない（数字を変えても名前は同じ）。
  - **前からの不具合も直した**: 無料プラン（インジケーターがロック中）で、無料の項目（サイン・SAR など）を切り替えると、保存してある有料のインジケーターのオンが消えていた（ロック中は画面の上ではオフとして扱うため、その状態を保存していた）。保存してある値から切り替えるようにした。#140 の「保存した選択はプランで戻る」のとおりになる。
- **説明文で言っていること**（嘘をつかないため）:
  - §8.54（#142）で測った移動平均は、SMA 25・75・200 と EMA 50・200 だけ（終値が線の上か下か）。説明文の 71.6% などの数字はその測定のもの。
  - 選んだ線にそれ以外のもの（初めの EMA 20 を含む）があれば、「…は測っていません」と出す。
  - 3本目の初めの数字 20 は、短い・中くらい・長いの3本（20・50・200）にするための選び方で、測った結果ではない。
  - 無料プランでは「インジケーターを使えるプランで各線の ⚙ から選べます」と出す（⚙ は出ないため）。
- **変えていないこと**: 表示のみで、サインの判定・メール・成績の記録には使っていない（前と同じ）。無料プランでは3本とも 🔒 で、⚙ も数字の設定も出ない（§8.52）。
- **独立した見直し**（ワークフロー。5つの観点〈計算・設定の保存・画面・説明文・テスト〉で探し、指摘ごとに別の1人が反論を試みて確かめた）: 指摘16件のうち、本当とされた14件（重なりをまとめて8つ）をすべて直した。
  - 計算に使う足の本数の誤り（初めの版では「画面より前の確定足を600本読む」「500本の線も画面の最初の足から引ける」と書いていたが、実際は約480本）と、長い EMA が TradingView の値とずれること → 上の「計算に使う足」。
  - 同じ数字で種類だけ違うとき、GC・DC の向きが線の並びで入れ替わり、説明文も「短い方・長い方」と事実と違うことを言っていた → EMA を速い線にし、説明文を分けた。
  - 数字の欄を空にできず、前の数字に戻った → 打っている途中の文字を出すようにした。
  - ⚙ を押しても見える所が変わらなかった（カードではチャートの下に開くだけ、全画面のシートでは何も起きない）→ 設定まで動いて、線1の数字の欄に移るようにした。
  - 無料プランで「各線の ⚙ で選べます」と出ていた → 上の文に変えた。
  - テストの穴（3本目だけオンで履歴を読むこと、GC・DC の印の位置、全画面のシートのロック）→ テストを足した。
  - 本当でないとされた2件: 古い版のまま開いているタブが新しい設定を消すこと（#141 の「最後に書いた側が勝つ」作りがもとからそうで、今回の変更で生まれたものではない）、アカウント同期のテスト（設定の全体を送るので maLines も送られることを確かめた）。
  - 見直しの前の調べで見つかった、ロック中の切り替えで保存が消える不具合（上）と、GC・DC の印が描く範囲の外に出ること（上）も直した。
  - 同じ作りのストキャスの ⚙ も、全画面のシートでは押しても何も起きない（前からのもの）。今回は直していない。
- **2回目の独立した見直し**（直した部分だけを3つの観点で探し、指摘ごとに反論を試みた）: 指摘11件のうち、本当とされた9件（重なりをまとめて7つ）を直した。
  - 深い履歴の読み込みが途中で止まると、ふだんの履歴より短い足を使い、初期設定の EMA 200 と GC・DC まで消えていた → 深い履歴は、ふだんの履歴より多いときだけ使う。
  - GMO の日足はふだんの履歴が少なく、初期設定の EMA 200 がずれていた（深くは読まなかった）→ ふだんの履歴で足りない線があるときも深く読む。
  - 画面の途中から引く EMA で、TradingView とのずれを言っていなかった → 両方を言う。
  - 深い履歴を読まないチャート（成績の画面など）でも「深く読みます」と出ていた → 出さない。日本語の「初めの数本の平均」を「初めの期間ぶん（n 本）の足の平均」に直した。
  - 数字の欄の打ちかけが、Esc で全画面のシートを閉じたときなどに残り、次に開くと赤い枠で出た → フォームが閉じたら捨てる。
  - リアルタイムチャートから深い足が線に届くことを確かめるテストが無かった → 足した。
  - 本当でないとされた2件: ⚙ で数字の欄に移るとスマホのキーボードが開くこと、無料プランの説明文に「読み込み中」が出ること。
- **3回目の独立した見直し**（2回目の直しの部分だけを2つの観点で探し、指摘ごとに反論を試みた）: 指摘5件はすべて本当とされ、重なりをまとめて4つを直した。
  - GMO の週足・月足で、初期設定のまま足の増えない深い読み込みをし、「深く読み切れなかった…次の足で読み直します」と事実と違う文が出続けた → 最後まで読んで増えなければ、そのペア・時間足では深く読まない。
  - コードのコメントが、Zero-lag TEMA だけのために読んだ深い履歴のときも説明文で言うと書いていた → 直した（上）。
  - 深く読む文が出る側と、英語の新しい文を確かめるテストが無かった、移動平均のために深く読むときだけ状態を言うことのテストが無かった → 足した。
  - 確かめていないこと: チャートが深い履歴より先に進んだとき（約120本後）に深く読み直すこと。そのための判定（深い足がチャートにつながっていなければ「これ以上は無い」としない）を外しても、テストは失敗しない。
- **確かめたこと**:
  - テスト（`src/test/ema-lines.test.tsx` の #200 は20件）: 数字と種類の読み方（範囲の外・小数・文字は初期値）、前からの保存の読み方、保存と読み直し、SMA の計算、測った5本の判定、⚙ から数字（ボタン・打ち込み・範囲外は受け付けない）と種類を変えると線の名前と左上の値がその計算になること、欄を空にして打ち直せること、⚙ で線1の数字の欄に移ること（カード・全画面）、説明文の「測っていません」、初期設定に戻す、GC・DC が線1と線2の短い方を速い線にして交差の足に印を出すこと（印の位置が線の点と同じ）、同じ数字で種類だけ違う2本は並びを入れ替えても同じ印になること、同じ線なら出ないこと、全画面のシートから変えられること、無料プランで ⚙ と数字の設定が出ないこと（全画面のシートも）、ロック中に無料の項目を切り替えても保存したオンが残ること、200より長い線で深い履歴を読むこと（200では読まない）、ふだんの履歴で足りない線があれば深く読むこと（足りれば読まない）、深い履歴が届くとそれで計算し直し、届くまで・読めないとき・途中で止まって短いときはふだんの履歴で引いて説明文にそう出すこと（リアルタイムチャートを通しても）、足りない線の理由（途中から・ずれの大小）、深い履歴を読まないチャートでは深く読む文を出さないこと、移動平均のために深く読むときだけ状態を言うこと、深く読んでも増えないとき（週足・月足のように）は1回だけ読んで何も言わないこと、英語の文、打ちかけがフォームを閉じると消えること、3本目だけオンでもふだんの履歴を読むこと（オフなら読まない）。
  - 足したテストが本当に誤りを見つけるかを、誤りを1つずつ入れて確かめた。1回目の直しの6つ（GC・DC を線の並びで決める、ロック中の保存を元に戻す、3本目で履歴を読まない、長い線で深い履歴を読まない、欄を空にできない、深い履歴を使わない）と、2回目の直しの5つ（短い深い履歴も使う、途中から引く EMA のずれを言わない、打ちかけを残す、ふだんの履歴の足りなさで深く読まない、深く読むかをチャートに渡さない）と、3回目の直しの2つ（増えなくても深く読み続ける、移動平均のためでなくても状態を言う）。どれも、少なくとも1件のテストが失敗した（「深く読むかをチャートに渡さない」は、初めはどのテストも失敗しなかったので、テストを強めた）。
  - 前からのテストのうち、「画面より前の足を読むのは、このインジケーターがオンのときだけ」を確かめる4つは、3本目が初めからオンだと何もしなくても通ってしまうので、3本目をオフにして意味を保った。
  - 全テスト 2,422件、型チェック（以前からある12件だけ）、lint（変えたファイルに0件）、画面のビルド。
  - Chromium（Playwright）で、スマホ幅のチャートで ⚙ を開き、線1を 25・SMA、線3を 13（打ち込み）にして、線の名前・左上の値・保存された設定が変わることを画面で確かめた（初めの版）。直した数字の欄は、同じ作りの小さなページを Chromium で動かし、キーで消して打ち直せること（50 → 空 → 150）、範囲外（600）は赤い枠で受け付けないこと、欄を離れると線の数字に戻ることを確かめた。
  - 3回目の直しの後に、Chromium（Playwright、スマホ幅 390×800）で一時ページ（コミットしない）を開き、カードの ⚙ で設定が画面の中に入り（上 403・下 800）、線1の数字の欄に移ることを確かめた。全画面のシートでも、⚙ を押す前は画面の下（上 1232）にあった設定が画面の中に入り、線1の数字の欄に移った。欄を空にすると赤い枠で線は EMA 20 のまま、35 と打つと EMA 35 になった。
- **本番への反映**（2026-10-05）: PR #168 をマージ（02:57 UTC 頃、8aa57a9）。関数は変えていないので、関数の反映は無い。Lovable で公開した（`deploy_project`、02:58 UTC 頃）。返事は pending（deployment ea15de22）。公開が終わったかは確かめていない。

### 8.101 移動平均線だけのチャートを、リアルタイムチャートの下に足した（#201）

- **指示**: 「チャートに移動平均線を載せただけのシンプルなチャートも別で欲しい」（2026-10-05）。オーナーの選んだこと: 置き場所は今のチャートの下に並べる、ペアと時間足は別に選べる、線は今のチャートと同じ3本（数字・種類・オンオフは共通）、無料プランでは Light 以上だけ（線は 🔒、ローソク足は見える）。
- **何を変えたか**（`LiveChart`・`PriceChart`・`src/lib/chartPrefs.ts`・`src/pages/Index.tsx`・文言）:
  - トップ画面のリアルタイムチャートの下に「移動平均線チャート」を足した（ログイン中だけ。上のチャートと同じ）。
  - 出すのは、ローソク足・移動平均線3本・価格（売値／買値／スプレッド）・次の足の確定までの時間・説明文だけ。サインの印・建玉の箱・SAR・下の帯（RSI・ストキャス・%b・RCI・BLSH・MACD・ADX）・ほかのインジケーター（Q-Trend・ULTRA・GC/DC・一目均衡表など）・ダウ・「GA型／RSI+SAR」の表示の切り替え・描く道具は出さない。上のチャートで保存してオンにしてあっても、このチャートでは出さない（保存はそのまま）。インジケーターの一覧も、3本だけを出す。
  - ペアと時間足は、このチャートで別に選び、別に覚える（設定の `maLive`。この端末とアカウントに保存。§8.53）。上のチャートで選んでも、このチャートは変わらない（逆も同じ）。初めて開くときは、上のチャートの選択ではなく、最初のペア（USD/JPY）と基本の時間足（4時間足）で開く。
  - 線3本の数字・種類・オンオフは、上のチャートと共通（§8.100 の設定をそのまま使う）。どちらで変えても両方に効く。GC・DC（線1と線2の交差）は、このチャートでは出さない。
  - 画面より前の足（ふだんの履歴・深い履歴）は、このチャートでは移動平均線のためだけに読む（線がオンのとき。§8.100 と同じ決め方。GC・DC の線や Zero-lag TEMA のためには読まない）。
  - 無料プラン: 線3本は 🔒（押すと料金の画面）。ローソク足と価格は見える。画面より前の足は読まない。説明は「🔒 の移動平均線は Light プラン（月額2,980円）で使えます」（上のチャートの「売買サインと RSI・SAR は無料で表示できます」は、このチャートには無いので出さない）。
  - スマホを横にしたときに全画面で開くのは、上のリアルタイムチャートだけ（§8.56、#144）。下のチャートは全画面のボタンで開く。操作の説明の「スマホを横にすると全画面で開きます」も、横にすると開くチャートだけに出す（成績の画面などのチャートは、前から横にしても開かないのにこの文が出ていたので、合わせて直った）。
  - ペア・時間足の列は、選んだボタンが見えるように、列の中だけを横に動かすようにした（前は `scrollIntoView` で、ページまで縦に動くことがあった。下のチャートを足すと、開いたときにページが下のチャートへ飛ぶため）。
- **変えていないこと**: 表示のみで、サインの判定・メール・成績の記録には使っていない。関数（サーバー）は変えていない。
- **知っておくこと**（コードから。本番では測っていない）:
  - 価格（5秒ごと）と足は、チャートごとに読む。2つのチャートが開いている間は、`live-chart` 関数への呼び出しがおよそ2倍になる。まとめる作りにはしていない。
    - GMO の価格は、関数が2秒だけ持っておく（同じ関数の中で）ので、GMO への読み込みは2倍にはならないことがある。GMO にないペア（Swissquote の価格）は、画面のペアを呼び出しごとに読むので、下のチャートがそのペアなら Swissquote への読み込みが増える。
    - Twelve Data のペアの足は、関数が1分に5回まで（そのうち2回はチャートの足のため）に抑えている。2つのチャートが Twelve Data のペアを開くと、この回数を分け合う。
- **独立した見直し**（ワークフロー。4つの観点〈下のチャートの動き・チャートの「線だけ」の扱い・設定の保存と画面への組み込みと説明文・テスト〉で探し、指摘ごとに別の1人が反論を試みて確かめた）: 指摘12件のうち、本当とされた10件（重なりをまとめて7つ）をすべて直した。
  - スマホを横にすると2つのチャートが同時に全画面になり（下のチャートが上に重なる）、縦に戻すとページがスクロールできなくなっていた（全画面がそれぞれページのスクロールを止めて戻すため、閉じる順で止めたままになる）→ 横にして開くのは上のチャートだけにした。
  - 下のチャートの説明文に「（GC・DC に使う線を含む）」が出ていた（このチャートは GC・DC を描かず、そのために深くも読まない）→ 出さない。
  - 無料プランで「売買サインと RSI・パラボリックSAR は無料で表示できます」と出ていた → 上の文に変えた。
  - 線を3本ともオフにすると、説明文に「画面より前の足を読み込み中です」と出続けていた（何も読まないのに）→ 線が1本もオンでなければ出さない（上のチャートでも同じ）。
  - テストの穴（ストキャスの帯が出ないこと、「新しいサイン」の知らせを出さないこと、全画面の時間足のシートに「サインの表示」の選択が出ないこと、次の足の確定の表示）→ テストを足した。
  - 本当でないとされた2件: ペアの列を左へ戻す動きのテストが無いこと（右へ動かす側と同じ作りで、動きは正しい）、トップ画面を描くテストが無いこと（今のコードは無料プランの値を正しく渡している）。
- **2回目の独立した見直し**（直した部分だけを2つの観点で探し、指摘ごとに反論を試みた）: 指摘4件のうち、本当とされた2件（同じ1つ）を直した。
  - 下のチャートを全画面のボタンで開いてからスマホを横にすると、上のチャートも自動で開いて重なり、下を先に閉じて縦に戻すと、ページがスクロールできないまま残った → 横向きで自動で開くのは、ほかの全画面が開いていないときだけにした。ページのスクロール止めは、開いている全画面の数で数え、最後の1つが閉じたときに元に戻す（閉じる順によらない）。閉じるときにブラウザの全画面を抜けるのは、そのチャートの全画面のときだけにした。
  - 本当でないとされた2件: 英語の文を確かめるテストが無いこと（英語の文は正しく、日本語と同じ作り）。
- **3回目の独立した見直し**（2回目の直しだけを、React の二重の実行・開いたままの画面の移動・Esc と戻る操作・iPhone・テストの後始末の観点で探した。見直した人は一時的なテストも動かした）: 指摘は0件。
- **確かめたこと**:
  - テスト（`src/test/ma-chart.test.tsx` の21件と、書き直した `src/test/twelve-pairs.test.tsx` の1件）:
    - 保存でオンのほかのインジケーター・下の帯・サイン・描く道具を出さず、一覧は3本だけで、保存はそのままであること。
    - ペアと時間足を上のチャートと別に覚え、片方で選んでももう片方は変わらないこと（アカウントから届いた分も）。何も覚えていなければ USD/JPY・4時間足で開くこと。
    - 線の数字・種類・オンオフが共通であること。
    - 画面より前の足を、線のためだけに読むこと（ほかのインジケーター・ダウ・Zero-lag TEMA・GC/DC のためには読まない）。
    - 無料プランの 🔒・説明文（日英）・次の足の確定の表示。
    - 全画面の時間足のシートに「サインの表示」の選択が出ないこと、「新しいサイン」の知らせを出さないこと。
    - スマホを横にしたときと、手で全画面を開いてから横にしたとき、2つの全画面をどの順で閉じても、ページのスクロールが元に戻ること。
    - ペアの列は列の中だけを横に動かし、`scrollIntoView` を使わないこと。
  - 足したテストが本当に誤りを見つけるかを、誤りを1つずつ入れて確かめた（作りの13、1回目の直しの9、2回目の直しの3、合わせて25）。どれも少なくとも1件のテストが失敗した。初めはどのテストも失敗しなかった3つ（GC・DC の線で深く読むかの判定、下のチャートへの「線だけ」の指定、全画面の設定シートの操作の説明）は、テストを足して見つけられるようにした。
  - 全テスト 2,443件、型チェック（以前からある12件だけ）、lint（変えたファイルに0件）、画面のビルド。
  - Chromium（Playwright）で一時ページ（作り物の値動きで2つのチャートを並べたもの。コミットしない）を開いて確かめた。
    - スマホ幅 390×800 で、開いてもページは縦に動かなかった（`scrollY` 0、スクロールの出来事も0回）。下のチャートで覚えた列の端のペア（CZK/JPY）は、列の中で見えていた。
    - 下のチャートは線3本だけで、サインの印は0個（上のチャートは2個）。下でペアを GBP/JPY に変えると、読み込んだのは下のチャートの足と履歴だけで、保存されたのは `maLive` だけ（上の `live` はそのまま）。
    - 全画面の設定のシートは3本だけで、ストキャスの設定は無し。無料プランでは 🔒 が3つで、線は無し。
    - スマホとして動かした Chromium（`isMobile`・`hasTouch`）で画面を横・縦にした。横にすると上のチャートだけが全画面になり、縦に戻すと閉じて、ページのスクロールが戻った。下のチャートを手で全画面にしてから横にしても、開いているのは下のチャートだけで、閉じて縦に戻すとページはスクロールできた。
  - 確かめていないこと: 本物のスマホでの動き（Chromium のスマホの動きを真似たものだけ）。本番で2つのチャートを開いたときの関数への呼び出しの増え方（上の「知っておくこと」はコードから。測っていない）。
- **本番への反映**（2026-10-05）: PR #169 をマージ（05:26 UTC 頃、bec7894。§8.93 の 04:00 UTC の確かめも同じ PR）。関数は変えていないので、関数の反映は無い。Lovable で公開した（`deploy_project`、05:27 UTC 頃）。返事は pending（deployment 49eeb841）。公開が終わったかは確かめていない。

### 8.102 オーナーの実際の持ち方で、15分足 ULTRA のメールの成績を測り、記録する（#205、研究のみ）

- **指示**（2026-10-05）:
  - オーナー「どうやったら、勝率が上がるか考えて」。§8.19〜§8.101 を読み比べて、次の順を提案した。①今のメールの実際の成績を記録する、②コストの悪い時間帯を避けるルールを先に決めて、まだ見ていないデータで確かめる、③時間帯をそろえて、サインの本当の力を測り直す。オーナー「順番通りでお願いします」「指値で利確は1つだけです」。
  - 同じ日に、メールを15分足にした。オーナー「これ15分足のサインでメールください」（PLN/JPY 4時間足 ULTRA のメールの画像）、「今の4時間足は無くしてください」「それなら、ペアを絞りましょう」。ペアは、楽天の広告のスプレッドが狭い5つ（オーナーの選択「スプレッドの狭い5ペア」）: USD/JPY・EUR/USD・EUR/JPY・AUD/USD・AUD/JPY。選ぶ前に、ペアごとの15分足の過去の数字（Q-Trend と ULTRA を合わせた、利確1が先の割合）も見せていた。選び方はスプレッドで、勝率ではない。
  - オーナーの購読は、2026-10-05 16:48 UTC から ULTRA の15分足の5ペアだけ（DB と巡回の記録で確かめた。4時間足と残りの9ペアは、オーナーがアプリで外した）。
- **オーナーの持ち方**（2026-10-05 の選択式の質問への、オーナーの答え。「」は選んだ答えの文）:
  - 入り方「指値で入る」（メールのエントリーの値段に）。利確「利確2（10pips）」だけ。損切り「置いていない」。遅れ「1分以内」（メールが届いてから注文するまで）。
  - 指値が入らないとき「入るまで置いたまま」。利確に届かず逆に動いたとき「利確に届くまで持つ」。夜中・早朝のメール「届いたら全部注文する」。同じペアを持ったまま次のメールが来たら「毎回入る」。
  - 注文しようとした時、値段がすでにエントリーより有利なら「成行ですぐ入る」。その成行は「普通の成行（新規注文）」（両建てになり、置いている指値は残る。楽天の AS ストリーミング注文ではない）。利確の注文は「入りと同時に置く（IFD）」。成行で入ったときの利確は「メールの利確2の値段」。
  - 量「1万通貨」。資金「30〜50万円」。楽天FXの「25倍コース」。ロスカットの水準「50%（変えていない）」。
  - 追証が来たら「入金して解消する」。入金の時は「知らせを見てすぐ」。入金の額は「不足額だけ」。追証の入金も含めて入れられるお金は「100万円まで」。楽天が追証のときに未約定の指値を取り消したら「置き直さない」。すでに入っている取引の利確の注文を楽天が取り消したら「同じ値段に置き直す」。
  - この持ち方は、そのままの形では測ったことがない。近いのは §8.76（GMO の14ペアの4時間足だけ。Q-Trend と ULTRA を合わせた当時のメール。確定の値段で入り、利確1 5 pips だけ、損切りなし。120本〈4週間〉で届かなければ、その足の終値で決済）。勝った割合は前半 94.3%・後半 93.3%、1回あたり +0.25・+0.06 pips、届かなかった取引の4週間後の最悪 −1,067.7 pips（前半）。§8.76 の docs には ULTRA だけの差（後半 +2.87 pips〈+1.06〜+4.67〉）を書いたが、ULTRA だけの勝率と1回あたりは書いていない。15分足・利確10・指値で入る形は測っていない。
- **この持ち方の形**: 損切りも期限も無いので、1つの取引が終わるのは、利確か、楽天のロスカット・追証の期限での強制決済（口座全体）だけ。取引ごとに見ると、ほとんどが利確で終わり、勝率は作りの上で高く出る。負けは、まだ持っている取引の含み損と、口座全体の強制決済に集まる。そのため、判断は口座の見方で行う（下の「決まり」）。
- **楽天FXの決まり**（2026-10-05 に楽天の取引ルールのページ〈www.rakuten-sec.co.jp/web/fx/rule/〉を GitHub Actions〈page-read.yml、run 37355352375〉で読んだ。下の「」の2文だけ原文を引き、ほかは要約）:
  - 追証: 取引日の終わりの中値で、証拠金維持率（純資産 ÷ 必要証拠金）が100%を下回ると出る。判定の時刻は日本時間 6:55（米国の夏は 5:55）＝ 21:55／20:55 UTC。期限は原則、翌取引日の18時（日本時間）。期限までに、不足額以上の入金か、建玉の全部又は一部の決済で解消する。値動きで戻っても解消にならない。期限までに解消しないと、全建玉を強制決済する。取引画面とメールで知らせる（メールは遅れや不着がありうる。知らせの時刻は、このページには書かれていない。会員向けのページの時刻は下）。
  - 追証が出たときの注文: 「追証が発生した場合は、既にお客様が発注なさった未約定の新規注文を当社の任意で取消します。」「（決済注文であってもIF-DONE注文、OCO注文、IF-OCO注文、リピート注文の中に、新規注文を組み合わせている場合は、当該注文についても同様に当社の任意で取消します。）」。追証の間に新しい注文を受け付けるかは、このページには書かれていない。
  - ロスカット: 25倍コースは50〜95%（口座を開いた時は50%）。証拠金維持率が水準を下回ると、保有する建玉をすべて決済する。判定の純資産の評価は「一定間隔」（間隔は書かれていない）。
  - 有効証拠金（純資産 −（必要証拠金 ＋ 注文中証拠金））で新しい注文を受け付けることは、§8.99 で楽天のページを読んで確かめた。
  - §8.99 で読んだ楽天のページ（会員向けの取引ルールのページとステータスの見方のページ。2026-10-04）の原文（控えは scratchpad の mm-rakuten-rules。repo には入れていない）:
    - 「追証金額: 必要維持証拠金額-前日最終純資産」「前日最終純資産: 毎FX営業日におけるニューヨーククローズ時点の純資産額。スタンダード25倍コースおよび法人口座では、追証判定額となります。」
    - 「追証充当済金額: 追加証拠金（追証）の解消のために入金された金額と建玉の決済によって充当済みとされた金額の合計」「追証未解消額: 追証金額 - 追証充当済金額」。両建てのとき「大きい方の建玉を決済しても、追加証拠金の充当は反対建玉の数量との差額分に限られます」。
    - 「楽天 FXでは、円残高の他に、ストレート通貨ペア（ EUR/USD GBP/USD AUD/USD）の取引で発生する米ドルの残高があります。」純資産は「日本円と外貨を円換算した合計金額」。米ドルのマイナス残高の両替の決まり（毎週第1営業日の NY の引けで、純資産 ÷ マイナス残高の円の値 ≦ 50% のとき）と、客が行うコンバージョン（±20 pips のレート）がある。
    - 追証の知らせの時刻: 米国夏時間は「追証判定結果通知：概ね午前6時30分（日本時間）」、冬時間は「概ね午前7時30分（日本時間）」（NY の引けの約35分後。UTC では 21:30／22:30）。資金の振替は「火曜日から土曜日の午前3時頃から午前6時頃まで」（日本時間）などの時間帯は受け付けない。
    - スワップは「各営業日の終了時（メンテナンスに入る時間）」に付き、「メンテナンス時間終了後、保有ポジションにスワップポイントが付与されます」。
- **測るもの**（データを見る前に決めた。`research/ownerhold.ts`、GitHub Actions の `ownerhold.yml`）:
  - **(a) これまでのデータ**: GMO の5ペアの、15分足の ULTRA の合図。
    - 作り方: メールと同じ足の読み方（tf-winrate と同じ。GMO の Bid・Ask の中値、チャートと同じ丸め、最新の600本の窓、`anchoredStart`）。合図は、tf-winrate と同じく、計算の起点（`anchoredStart`）が同じ間は1回の計算で作る。足 i を最新とする600本の窓で `indicatorSignals` を呼んだ結果（barTime が足 i のもの）と、見本の足で照合し、食い違いの件数を出す。
    - 1つの合図は（ペア・ULTRA・向き・足の始まりの時刻）で1件（メールの二重送信を防ぐ鍵と同じ。利用者の番号は除く）。足 i の窓には無く、足 i+1 の窓で初めて出る足 i の合図は、メールでは次の足が確定した時の巡回で送られる（巡回の読む時刻と `freshFor` の20分からの読み。測っていない）。この合図の注文する時刻は T＋17分（次の足の確定＋2分）とし、件数を別に出す。
    - メールが送られない時間（`isPossiblyClosed`: 金曜 21:00 UTC〜日曜 22:00 UTC）に確定した足は数えない（件数を出す）。
    - 期間: 合図の足の確定 T が START 以上・END 未満。START は 2024-01-01、END は 2026-10-03 00:00 UTC（土曜。値段が止まっている時刻）。前半・後半は 2025-05-19 00:00 UTC で分ける（§8.98・§8.99 と同じ）。
    - 1分足の始まり: 5ペアの Bid・Ask の1分足が両方そろう最初の日を、値段を計算しない下見で決め、docs に書いて commit してから測る（§8.96 のゴトー日と同じやり方。ドル円は §8.96 で 2023-10-27 からと分かっていた）。どれかが 2024-01-01 より後なら、5ペアの最初の日のうち一番遅い日の、次の月曜 00:00 UTC を START にする（口座は5ペアを同時に見るので、ペアごとにずらさない）。
      - 下見の結果（`research/min1-start.ts`、run 37350023645、2026-10-05。足の本数だけを数え、値段は読んでいない）: 5ペアとも、売値（Bid）に足がある最初の日と、売値・買値（Ask）の両方がそろう最初の日は同じ 2023-10-27（金）。その前に調べた45日（2023-09-12〜2023-10-26。土日を含む暦の日）には売値の足が無かった（買値は、売値に足がある日だけ読んだので、この45日は読んでいない）。2024-01-02 は5ペアとも売値・買値それぞれ1,380本。どれも 2024-01-01 より前なので、START は 2024-01-01 のまま。
  - **(b) これからのメール**: 送ったメールそのものを数える。
    - 書き出す行: `signal_alerts` の、オーナーの行・kind が 'signal'・rule が ULTRA の id（`ULTRA_RULE_ID`）・interval が '15min'・5ペア・status が 'sent'・`sent_at` があり、`sent_at` が 2026-10-05 16:17 UTC 以降で END_b より前のもの。書き出すのは、ペア・向き・足の始まりの時刻・確定の時刻・エントリー（`entry`）・送った時刻（`sent_at`）だけ（宛先・利用者の番号は書かない）。オーナーで絞るので、合図ごとに1行になる。status が 'sent' でない行は書き出さず、件数だけ記録する。同じ（ペア・足・向き）にほかの宛先の行が何件あったかは、件数だけ出す。利確2は E から計算する（`target` の列は利確1）。
    - 書き出しは Claude が DB の道具で行い、`research/ledger/ultra15.csv` に足して commit する（Actions からは DB を読めない）。同じ合図を GMO の足から計算し直し、送ったメールとの食い違いを件数と一覧で出す（数える元は、送ったメール。食い違いがあっても止めない）。
    - データの終わり（END_b）: 走らせる日の前の土曜 00:00 UTC。それより後の足は読まない（途中までしか入っていない日のファイルを読まないため）。前の週の結果は書き換えずに残す。
    - (b) の口座: 書き出した最初の行の P から、30万円（主）と50万円で新しく始める。(a) の取引・置いている指値は持ち込まない。毎週、CSV の最初の行から END_b まで同じ決まりで回し直す。前の週に書いた数字が回し直して変われば、その差と理由を書く。
    - 毎週の手順: 週に1回（月曜）の Routine で Claude の作業を始め、①オーナーの行を書き出して CSV に足し、作業ブランチに commit・push する、②そのブランチで END_b を入れて `ownerhold.yml` を走らせる、③docs に記録し、PR を作ってマージする、④オーナーに日本語で報告する。週が抜けたら、抜けた土曜ごとに END_b を1つずつ走らせ、抜けたことを書く。
- **持ち方 O（主）**: 1分足（GMO の Bid・Ask）で追う。
  - 値段の取り方（1つの決まり）: ある時刻 τ の値段は、τ 以前に終わる最後の1分足の終値。NY の引け・END・1日後の評価・ドルのペアを円にするドル円の中値・P に足が無いときの判定は、すべてこの決まり（金曜の NY の引けには GMO の足が無いので、その前の最後の終値になる。§8.99 と同じ）。代わりの終値を使った件数を、金曜・祝日・その他に分けて出す。平日に τ ちょうどで終わる足が無い日の件数と日付も出す。
  - 指値の値段 E: メールのエントリー（合図の足の中値の終値、チャートと同じ丸め）。
  - 注文する時刻 P: (a) は T＋2分（仮定）。§8.81 で測った1件（GBP/JPY 4時間足の Q-Trend）では、確定の4.23秒後に Resend に渡った。15分足で送るまでの時間、携帯に届く時刻、オーナーが注文する時刻は測っていない。補足として T＋1分と T＋5分の行も出し、遅れの幅を見る。(b) は送った時刻（`sent_at`）＋1分を分で切り上げた時刻（届くまでの遅れを0とした場合）。補足で `sent_at`＋5分の行も出す。(b) の記録から、確定から送るまでの時間（中央値・最大）を出す。
  - 楽天が止まる時間: 楽天FXは毎日（月〜木の夜）、米国の夏は 20:55〜21:10 UTC、それ以外は 21:55〜22:10 UTC に止まる（§8.99。夏かどうかは楽天の NY の引けと同じ決め方）。P がこの間に入るメールは、P を止まる時間の終わりに動かす（仮定。件数を出す）。止まっている間の1分足では、注文の受け付け・成行の判定・指値の約定・利確・ロスカットを判定しない（楽天が止まっている間にロスカットを判定しないことは確かめていない。仮定）。止まる時間の後の最初の1分足で、ふだんの決まりのまま判定する。補足として、止まっている間も判定する行を出し、主との差を並べる。
  - 注文の時点の判定: P から始まる1分足の始値で見る。すでに有利（買いで Ask の始値が E 以下、売りで Bid の始値が E 以上）なら、その始値で成行で入る（オーナーの答え）。そうでなければ、E に指値を置く。P から始まる1分足が無い（GMO が週末で止まっている〈米国の夏の金曜 20:00 UTC 以後〉など）ときは、P の値段（上の値段の決まり。買いは Ask、売りは Bid）で判定し、成行ならその値段で入り、指値なら次にある1分足から約定を追う（件数を出す。補足で、それらを外した行も出す）。
  - 指値の約定: 置いた後の1分足で、買いは Ask の安値が E 以下になった最初の足で、E と始値の安い方で入る。売りは Bid の高値が E 以上になった最初の足で、E と始値の高い方で入る（始値が E より有利な値段で始まった足〈週明け・止まる時間の後・足の欠けの後〉で、始値で約定させるのは仮定。楽天のページでは確かめていない）。取り消さない（オーナーの答え。楽天の追証とロスカットでの取り消しは下）。週末をまたいでも残す。END までに入らなかったものは「入らなかった」とする。
  - 補足（触れただけの約定）: E を 0.1 pips 越えないと入らない場合の行も出す。補足（窓の有利な約定なし）: 指値は E ちょうど、利確は利確の値段ちょうどで約定させる行も出す。始値で有利な値段になった約定の件数と、それで足された pips を、入りと利確に分け、週明け・止まる時間の後・足の欠けの後・ふだんの1分足に分けて出す。
  - 利確（IFD。入りと同時に置く）: 指値で入った取引も、成行で入った取引も、メールの利確2の値段（E から10 pips。オーナーの答え）。決済する側（買いは Bid、売りは Ask）の値段が届いた1分足で、利確の値段と始値の有利な方で出る（窓の扱いは上と同じ仮定）。入った1分足の中では利確を数えない（その足の中の順番が分からないため。その足で利確に届いていた件数を出す）。追証のときに楽天が利確の注文を取り消しても、オーナーは同じ値段に置き直す（答え）ので、利確は途切れないとして数える（置き直すまでの時間は0とする。仮定）。
  - 損切り・期限: なし。END で持っているものは、END の値段（上の値段の決まり。決済する側）で評価し、「まだ持っている」とする。
- **口座（主）**: 1回1万通貨、楽天の25倍コース。§8.99（#188）の決まりを基にし、プログラムは `ownerhold.ts` に新しく書く（`research/money-account.ts` は5分足の格子で動き、取り消さない指値・期限なしの保有・スワップ・入金を持たないので使わない）。使い回すのは `nyClosesBetween`・`rakutenSpread`（money-trades.ts）、`tausOf`（export するか写す）、`clustered` など（money-stats.ts）。
  - 証拠金: ペアごとに、買いの量と売りの量の大きい方 × 中値 × 4%（ドルのペアは、上の値段の決まりのドル円の中値で円にする）。§8.99 と同じ。
  - 純資産: 円の残高（始めの資金 ＋ 入金 ＋ 円のペアの決済した損益 ＋ 円のペアのスワップ）＋ ドルの残高（ドルのペアの決済した損益とスワップ。ドルのまま持つ）× その時点のドル円の中値（上の値段の決まり）＋ まだ決済していない取引の評価損益（決済する側の値段。ドルのペアは同じドル円で円にする）。ドルの残高を数える時点ごとに円にする（楽天の決まり。換算に中値を使うのは仮定）。オーナーはコンバージョンをしない（仮定。オーナーの答えに無い）。米ドルのマイナス残高の両替の決まりは入れない（仮定。当たる回数〈毎週第1営業日の NY の引けで条件を満たした回数〉は出す）。補足として、ドルのペアの損益を決済の時のドル円で円にして固定する行（§8.99 の作り）も出す。スワップの行では、スワップも同じ扱い（円のペアは円、ドルのペアはドル）。
  - 注文の受け付け: 有効証拠金（純資産 −（建玉の必要証拠金 ＋ 注文中証拠金））が、その注文の証拠金（E で1万通貨 × 4%）以上のときだけ受け付ける。数えるのは P の値段（上の値段の決まり。評価損益は決済する側、証拠金は中値）。注文（新しい注文と置いている指値）の証拠金は、その注文の E × 1万通貨 × 4% で、ドルのペアは判定する時点（その P）のドル円の中値で円にする（判定のたびに数え直す。仮定）。新しい注文に、買いと売りの大きい方で数える相殺は効かせない（確かめていない。仮定）。置いた指値は、約定するまで、その注文1つ分の注文中証拠金を取る（買いと売りの大きい方を当てはめない。仮定）。成行の注文も同じ条件。
    - §8.99 との違い: §8.99 は「注文した後の必要証拠金（買いと売りの大きい方）が純資産以下」で受け付け、前の足から待っている注文を次の足の注文後の必要証拠金に入れなかった（docs §8.99。プログラムでは money-account.ts の decisions T2）。補足として、§8.99 の式（新しい注文にも相殺を効かせ、置いている指値も大きい方で数える）で同じ口座を回した行を出す。
  - ロスカット: 水準は50%（オーナーの答え）。ロスカットを判定する1分足ごとに、その足の決済する側の終値で純資産を出し、必要証拠金の50%を下回ったら、すべての取引をその終値で決済し、置いている指値もすべて取り消す（楽天の決まり。§8.99）。楽天が判定する間隔と値段は公開されていない。主は1分足の終値（楽天が止まる間の足は判定しない。仮定）。補足として、すべての取引が同時にその1分足の一番悪い値（買いは Bid の安値、売りは Ask の高値）にいたとする行（§8.99 の lcworst と同じ作り。両建ての買いと売りが同時に一番悪い値にいる、実際には起きない形も含む）と、5分足の区切りで判定する行（§8.99 と同じ間隔）も出す。
  - 追証（入れられるお金の上限: 始めの資金 ＋ 入金の合計が100万円まで。オーナーの答え）:
    - 判定: 楽天の NY の引け τ の中値（上の値段の決まり）で、純資産が必要証拠金を下回ったら追証（不足額 D ＝ 必要証拠金 − 純資産）。
    - 追証が出たとき、置いている指値（未約定の新規注文）はすべて取り消し、置き直さない（楽天の決まりは「任意で取り消す」。主はすべて取り消す〈仮定〉。オーナーの答え「置き直さない」）。補足として、取り消さない行も出す。約定した取引の利確は途切れない（上）。
    - 入金（主）: 楽天の知らせの時刻 τ＋35分（米国夏 21:30 UTC・冬 22:30 UTC。楽天の「概ね」の時刻ちょうどとする。仮定）の1つの出来事として、その時点の min(U, 100万円 − それまでに入れたお金〈始め＋入金〉) を入金する。τ＋35分以前に終わる1分足の①〜⑤をすべて済ませた後、τ＋35分以後に始まる1分足の①より前に行い、足を待たない（オーナーの答え「知らせを見てすぐ」「不足額だけ」〈楽天が示す未解消額ちょうど〉「100万円まで」。知らせを見てから入金するまでの遅れを0と読んだもの。仮定）。金曜の追証も金曜の τ＋35分（END より前）に入金する（その後、週明けまで足が無いので、週明けの最初の足の始めに入れたのと同じに働く）。祝日などで τ＋35分の後の最初の足が期限より後でも、入金は期限より前に済んでいる。その時点で U が0以下（決済の充当で解消済み）なら入金しない。ロスカットで追証が終わっていれば入金しない。未解消額 U ＝ D −（入金 ＋ 決済による充当）。決済による充当は、τ に持っていた建玉が決済されるたびに、その決済で減った必要証拠金（τ の値段で、ペアごとの買いと売りの大きい方の減り。楽天の「反対建玉の数量との差額分に限られます」と同じ）を足したもの（利確・ロスカットでの決済も数える）。U が0以下になった時点で解消する。値動きで戻っても解消にしない（楽天の決まり）。
    - U が残っている間（判定から知らせの時刻の入金まで、と、上限のため入金の後も U が残ったとき）: 解消・期限・ロスカットのどれか早いものまで、新しいメールの注文を受け付けない（§8.99 と同じ仮定。楽天のページには書かれていない）。期限（翌取引日の 09:00 UTC。金曜なら月曜。年末年始などの繰り延べは入れない、仮定）までに U が残れば、期限の時刻以後に始まる最初の1分足（期限を含む足があればその足）の始値で、すべて決済する。期限の前にロスカットが起きれば、追証はそこで終わる（仮定）。補足として、上限のときに一部も入金しない行（主と同じ知らせの時刻に、U が残りの枠に収まるときだけ U を入金し、収まらなければ入金しない）と、判定の時刻 τ に min(D, 枠) を入金する行（入金がいちばん早い場合。楽天の知らせより前で、夏の τ〈5:55 日本時間〉は振替を受け付けない時間の中）も出し、主との差を並べる。
    - 補足（期限の前に入金する行。知らせの時刻には入金しない）: 判定から翌取引日 08:59 UTC までは、上の「U が残っている間」と同じに扱う（新しい注文は受け付けない。置いている指値は取り消し済み。決済の充当で解消・ロスカットで終わったら、その追証は終わり、入金しない）。08:59 UTC の時刻の出来事として（08:59 以前に終わる1分足を済ませた後、足を待たない）、U が残っていれば min(U, 100万円 − それまでに入れたお金) を入金する。それでも U が残れば、09:00 の期限で全決済。入金の時刻の幅を見る補足で、判断には使わない。
  - NY の引けの処理（追証の判定・指値の取り消し。補足の τ の入金の行では入金も）は、時刻の順に、1つの出来事として行う: τ 以前の出来事（τ 以前に終わる1分足の ①〜⑤ と、P ≦ τ で足の無い注文）をすべて済ませた後、τ より後に始まる1分足の①より前に行う。値段は上の値段の決まり（τ 以前に終わる最後の1分足の終値。金曜は週明けの足を使わない）。建玉と指値は、その時点のものを使う。追証の判定に使う純資産は、その夜のスワップを入れる前のもの（楽天の「前日最終純資産＝ニューヨーククローズ時点の純資産額」と「スワップはメンテナンス時間終了後に付与」から。字のとおりに読んだもので、仮定）。その夜のスワップは、楽天が止まる時間の終わり（τ＋15分）に純資産に入れる（スワップの行だけ）。これも1つの出来事で、τ＋15分以前に終わる1分足をすべて済ませた後、τ＋15分に始まる1分足の①より前に行う。そのため、P＝τ＋15分（止まる時間の後に動かした P）の注文の受け付けと、E* の①には、その夜のスワップが入る。2つの引けが同じ時点に落ちたら、スワップは引けごとにすべて足し、追証の判定は1回、期限は早い方（§8.99 と同じ）。平日は、τ で終わる足の⑤の直後と同じになる。§8.99 は、足の無い T の受け付けを引けの判定の後に置いていた（docs §8.99）。ここでは時刻の順にする。補足として、その夜のスワップを入れた後で追証を判定する行も出す（スワップ込みの行で、追証の回数と入金の合計の差を並べる）。
  - 1つの1分足（始まり s、終わり g）の中の順番: ①解消していない追証の期限（始値ですべて決済。追証の入金は、主の知らせの時刻も補足の 08:59 も、足の中の順番ではなく時刻の出来事〈上〉なので、期限より前に済んでいる） → ②P＝s の注文（楽天の一覧の順〈USD/JPY・EUR/JPY・AUD/JPY・EUR/USD・AUD/USD〉で、同じペアは買いを先に。成行なら始値で入る）→ ③置いている指値の約定（置いた順。②で置いた指値も含む）→ ④利確（入った順。入った足では数えない）→ ⑤ロスカット（終値。その足で入った取引も含む）と、追証の解消の判定 → ⑥記録。止まる時間の1分足では ②〜⑤ を飛ばす。NY の引けの処理は上のとおり、この順番とは別の出来事。
  - ロスカット・期限の決済の後: 残った資金で続ける（仮定。オーナーの答えに無い）。取り消された指値は置き直さない（オーナーの答え「置き直さない」は追証の取り消しについての答え。ロスカットの取り消しも同じとする〈仮定〉）。補足として、ロスカットのたびに始めの額まで入金し直す行（入れられるお金の上限の100万円まで。入金の回数と合計）も出す。
  - 始めの資金: 30万円と50万円（オーナーの答えの両端）。判断は30万円の行。
  - 前半・後半: 30万円から始めた1本の道筋を、2025-05-19 00:00 UTC の純資産で分ける。前半の損益 A ＝ その時の純資産 − 30万円 − それまでの入金。後半の損益 B ＝ END の純資産 − その時の純資産 − その後の入金。全期間の損益 S ＝ A ＋ B。始め直さない（§8.99 と同じ）。補足として、2025-05-19 に30万円で始め直し、それより前の合図の取引を持ち込まない後半の口座も出す（判断には使わない）。
  - ペアごとの口座: そのペアのメールだけを受ける別々の口座（30万円・50万円から）。参考で、判断には使わない。
  - E*（§8.99 と同じ定義）: すべてのメールが受け付けられ、追証もロスカットも一度も起きないために要った、いちばん小さい始めの資金。すべてのメールを受け付けた道筋（追証の取り消しも入金も無い道筋）の上で、次の4つのうち一番大きい値（量が決まっているので、資金によらない道筋の上で一次の式で出る）。各項は、その行が判定する時点だけで数える。①注文の時点 P（止まる時間の後に動かした P）: 建玉の必要証拠金 ＋ 置いている指値の注文中証拠金 ＋ その注文の証拠金 − それまでの損益（受け付けと同じ数え方）。②楽天の NY の引けごと（止まる時間の始まりでも数える）: 必要証拠金 − 損益（中値）。③ロスカットを判定する1分足ごと（主の行では止まる時間の足を除く。止まる間も判定する補足の行では、すべての足で、その行の道筋の上で数える）: 必要証拠金 × 50% − 損益（決済する側の終値。一番悪い値の行は、その足の一番悪い値）。④損益のマイナスの最大（同じ時点だけで）。どの項が、いつ E* を決めたかを出す。スワップ無しの行とスワップ込みの行で別々に出す。補足として、注文中証拠金を入れない E* も出す（仮定による幅）。確かめとして、行ごとに、E* の少し上では置けない注文・ロスカット・追証がどれも0回、少し下ではどれかが1回以上起きることを確かめる（§8.99 の estarCheck と同じ）。E* が100万円を超えれば、そう書く。
- **取引ごとの見方（資金の限りなし）**: すべてのメールを別々に数える（ロスカットも追証も無い）。判断の②の後半の条件（すべてのメールの円の損益 M）、③、(b) の読む数字に使う。勝率・利確までの時間・最大の逆行・入らなかったメールの数字は参考で、判断には使わない（口座の道筋ではロスカットで取引が途中で切れ、逆行が小さく出るため、これらはこの見方で数える。口座の道筋の分は別の行で出す）。
- **スワップ**:
  - 取引ごとに、またいだ楽天の NY の引けの数とスワップの日数（水曜は3日。§8.99 と同じ数え方、`nyClosesBetween`・`tausOf`。t0 は入った1分足の始まり、x は出た1分足の始まり。祝日の違いは入れない）。合計を、ペア・向き別と、利確に届いた取引・届かなかった取引別に出す。確かめとして、口座で NY の引けの処理に足したスワップの日数の合計が、取引ごとの日数の合計と一致すること。
  - 「口座の損益を0にする、1日あたりのスワップ（1万通貨・円、全取引の平均）」を出す。
  - スワップ込みの行: 楽天の日ごとのスワップの実績が START から読めれば、それを使う。読めなければ §8.24 と同じく BIS の政策金利（月次、1か月遅れ）から目安を作る。向きを w（買い +1、売り −1）として、年率 ＝ w ×（ペアの前の通貨の金利 − 後ろの通貨の金利）− 取り分。取り分は向きにかかわらず引き、仮の値 0.5%（補足の行は 1.0%）。1回のスワップ ＝ 年率 ÷ 100 × 1万通貨 × その日の中値 × スワップの日数 ÷ 365（§8.24 の research/longhist-lib.ts と同じ形。ドルのペアのスワップはドルで出してドルの残高に足す。その日の中値はドル建て）。スワップは、楽天が止まる時間の終わりに純資産に入れる（上の NY の引けの処理。その後のロスカット・追証の判定に効く）。
  - 「主のスワップ込みの行」＝ 楽天の実績が読めればその行、読めなければ取り分0.5%の行。どちらになるかは、結果を見る前に、読めたかどうかだけで決まる。
- **判断の道筋**（オーナーに出す数字の主。1つに決める）: 30万円・ロスカットは1分足の終値で判定・スワップ無し・GMO の値段・P＝T＋2分・触れたら約定・5ペアまとめて・追証は楽天の知らせの時刻（τ＋35分）にその時の未解消額を入金（上限100万円）・追証で指値を取り消す・止まる時間は判定しない。スワップ無しを主にするのは、スワップが目安と仮の取り分で、仮定が少ない方を主にするため。主のスワップ込みの行の同じ数字を、同じ表のすぐ下に並べる（判断の①②には両方を使う）。
- **比べるもの**:
  - 逆向き: 同じ T・同じ E・同じ持ち方で、向きだけ逆にした取引。同じ時刻なので、スプレッド・利確の形・その時刻の値動きの大きさの影響はそろう。期間の上げ下げ（トレンド）は、ペアごとの買いと売りの合図の数の差の分だけ差に残る（ULTRA の買いと売りの合図は別々に出るので、数はそろわない）。そのため、主の数字は次のように作る。
    - メールごとの差 d ＝（合図の向きの値 − 逆向きの値）。値は、P から1日後の時点の1回あたり（取引ごとの見方。それまでに利確していれば利確の損益、していなければ1日後の評価、入っていなければ 0。単位 pips）。
    - 1日後の評価: P＋24時間の値段（上の値段の決まり。決済する側。週末・祝日で足が無いときも同じ。「それまでに利確」も、その足までで見る）。P＋24時間が値段の無い時間に当たった件数を、合図の向きと逆向きに分けて出す。
    - 主の数字 ＝ 5ペアそれぞれで、全期間の買いの合図の d の平均と売りの合図の d の平均を同じ重みで平均し、その5つを同じ重みで平均したもの。各 d に「その平均の中での重み」（ペアと向きの件数で決まる。N ÷（10 × そのペア・向きの件数））を掛けて、週ごとと4週ごとにまとめた t(C−1) の両側95%区間（C はまとまりの数。§8.99 の1回あたりと同じ作り。`clustered`）を出し、2つのうち低い方の下の端 L を使う（`statOf` はこの重みを決まったものとして扱う近似）。まとまりの鍵は T の週。
    - d は週をまたがない: 金曜 21:00〜日曜 22:00 UTC に確定した合図は数えない。1日後の評価は P＋24時間の値段（その時刻以前の最後の1分足）で行う。週の切れ目（日曜 21:00 UTC）は GMO が止まっている時間の中にある。確かめとして、d の期間（P から1日後の評価の足まで）が、T の週・4週のまとまりの外に出た件数を出す（作り物と実データの両方）。0件でなければ、③は区間で決めず止める。
    - 週や月ごとに重みをそろえる作りは使わない（2回目の見直しで、作り物の値動きで確かめた: その重みは同じ週の後の合図で決まり、後の合図は d を決める値動きで決まるので、合図に力が無くても大きくプラスに出た）。3回目の見直しで、この主の数字を作り物で確かめた（見直しの中で書いた作り物のプログラムで、repo には入れていない。1分足・指値か成行・利確10・1日後の評価・力の無い RSI の合図。力の無い値動き4つの種で計200回: 主の数字の平均は +0.12・−0.01・+0.04・−0.04 pips、下の端が0より上は計3回。ペアごとに一定のトレンドを入れた値動き〈1分足1本あたり 0.01・0.03 pips〉では、主の数字は0のまわりで、メールごとの単純な平均は −1.6・−13.3 pips にずれた。15分足1本あたり 0.01 pips のトレンドでは、単純な平均もずれなかった〈−0.004 pips〉。週ごとのますは、どの値動きでも約 +7 pips にずれた。1つの種〈14、50回〉は Claude が走らせ直し、同じ結果を確かめた）。本番の確かめは、下の確かめ A で行う。この主の数字が消すのは、ペアごとに期間を通して一定のトレンドだけ。期間の中で変わるトレンドは残る（ULTRA は逆張りなので、残る分は③に厳しい側〈マイナス〉に出る見込み。同じ作り物で、トレンドが途中で変わる値動きでは、ばらつきの −7倍だった）。
    - 補足: メールごとの d の平均（件数と並べる）。1週後の時点で同じもの。口座の見方で、逆向きの取引だけで同じ口座を回した結果（勝率と1回あたりも）。
  - メールの決め方の再現: 確定の値段で入り（買いは Ask、売りは Bid）、損切り13・利確1（4 pips）。この行だけは、tf-winrate と同じく5分足（money-data.ts の読み込み）で追う（T から始まる5分足から追う・始値で越えたら始値で出る・同じ足で両方に届けば損切り・5分足1,440本で区切りその足の決済する側の終値で出る・1,440本が END までに無い合図は外す）。足 i の窓で出た合図だけで作る（足 i+1 の窓で初めて出る合図は入れず、件数だけ出す）。同じ Actions の実行の中で、tf-winrate.ts を PAIRS＝5ペア・SL 13・TP1 4・同じ END・WEEKEND＝inside で先に走らせ、その JSON の 15分足・ULTRA・利確1 の全体・前半・後半の件数（n・tp・sl・amb・open）と、ペアごとの ULTRA の合図の数（coverage の 15min。1,440本で外す前の数）が完全に一致すること、1回あたりの平均の差が 1e-9 pips 以下であること（足す順の違いで最後の桁が変わるため。1件が 0.1 pips ずれると平均は約 1e-5 pips 動くので、この幅でも誤りは見つかる）を確かめてから、口座・取引ごと・③の計算に進む。合図を1件ずつは比べない（tf-winrate は合図の一覧を出さないため）。
  - 楽天の広告のスプレッド（§8.99 と同じ表）で、入りと決済を追い直した行。ドル円は 2025-03-06 から、広告の早朝の値（日本時間3〜9時 3.8銭）も入る。§8.99 の表でも GMO の値段のままの期間がある（ドル円は 2024-01-01〜2025-03-06、ほかの4ペアは 2024-08-14〜2025-02-05、除外の3日）。当てはめた割合を、入りと決済それぞれ、ペアごと・前半・後半ごとに出す。
- **出すもの**（全体・前半・後半。5ペアまとめてと、ペアごと。(a) と (b) は別々に。どれも判断の道筋の数字を主にし、主のスワップ込みの行を並べる）:
  - 口座: 終わりの純資産と損益（円。入金を引いたもの）。ロスカットの回数・日時・前後の資金（①の4つの行それぞれで、0回の行も含めて）。追証ごとの日時・不足額 D・どう終わったか（入金・決済で解消・ロスカット・期限の決済・END の時点で未解消〈U と期限の時刻〉）・取り消した指値の数。入金の回数・額・合計の時間の道筋（いつ・いくら・それまでの合計）、1回の入金の最大、入れたお金の合計（始め＋入金）が50万円・100万円に届いた日時。最大の資金の落ち込み、E*、同時に持っていた取引の数の最大とそのときの証拠金、置いている指値の数の最大。
  - メールの行き先（全メールに対する件数と割合。前半・後半も）: 指値で入った・成行で入った（それぞれの取引ごとの勝率と1回あたり）、入って利確した・入って口座で決済された（ロスカット・期限）・入ってまだ持っている・置いたが入らなかった・追証で取り消された・ロスカットで取り消された・置けなかった（理由ごと: 有効証拠金・追証の間）。「口座で取らなかったメール ＝ 置けなかった ＋ 追証で取り消された ＋ ロスカットで取り消された」の合計も1行で出す。
  - 勝率（オーナーに出すのは1つ）: 判断の道筋で、入った取引のうち、利確で決済したものの割合。分母には、ロスカット・期限で決済したものと、END でまだ持っているものも入れ、これらは勝ちにしない（§8.99 と同じ）。同じ行に、1回あたりの pips と円（利確・ロスカット・期限で決済した損益と、END でまだ持っているものの評価を含む。ドルのペアは決済の時〈まだ持っているものは END〉のドル円の中値で円にした参考の数字）、終わり方ごとの件数（利確・ロスカット・期限・まだ持っている）、ロスカットの回数、E*、逆向きの取引だけで回した同じ口座の勝率と1回あたりを並べる。主のスワップ込みの行の同じ数字を、すぐ下に並べる（2つの行で置けたメールの数か勝率が違えば、その差も書く）。
  - 50万円の行・入金し直す行・取引ごとの見方の勝率は参考。
  - 利確に届くまでの時間の分け方（1日以内・1週以内・4週以内・END まで）。時間 h の行は、P＋h が END 以前のメールだけで数える（早く終わる利確だけを数えて勝率が上に寄るのを防ぐ）。
  - 最大の逆行（pips と円）: 中央値・90%点・99%点・最大。利確に届いた取引と届かなかった取引に分けて。
  - 入らなかったメール・置けなかったメール・取り消されたメールの「もし成行で入っていたら」の取引ごとの結果。置けた・資金で断られた・指値が入らなかったの3つに分けた、取引ごとの勝率と1回あたり。
  - スワップ（上）。楽天が止まる時間で P を動かした件数と、止まっている間も判定する行との差。窓の有利な約定の件数と pips（上）。
- **区間**: 1回あたりの区間は、週ごとと4週ごとにまとめた t(C−1) の両側95%区間の、低い方の下の端（§8.99 の1回あたりと同じ作り）。口座の数字には幅を付けない（1本の道筋なので）。損切りなしで、利確か END まで持つ取引（取引ごとの見方の1回あたり、1週後の行など）の区間は、まとまりをまたいで重なるので、狭く出るおそれがある。これらは区間だけで「0より上」とは書かない。③の d だけは、週をまたがないので（上）、区間の下の端で決める。
- **決まり**（データを見る前に決めた）:
  - これはオーナーの今のやり方の成績を出す測定で、何かを採用するかを決めるものではない。
  - 判断に使う条件は ①〜③。どれも、始めの資金30万円・GMO の値段・P＝T＋2分・触れたら約定・5ペアまとめて・判断の道筋の追証と止まる時間の扱い。
    - ① 口座・全期間: ロスカットが0回、追証の期限での全決済が0回、上限（100万円）のために知らせの時刻の入金の後に U が残った追証が0回（その後に決済の充当で解消しても、END の時点で未解消でも数える。厳しい側）。スワップ無しの行と主のスワップ込みの行の両方で、さらにそれぞれ1分足の終値で判定した行と一番悪い値で判定した行の両方で（4つの行すべてで）。
    - ② 口座・前半と後半: 口座の損益 A・B（入金を引いたもの。純資産の差で数え、決済した分だけでは数えない）が、ともに0より上（①と同じ4つの行すべてで）。さらに、取引ごとの見方で、すべてのメールの円の損益 M（前半・後半の境と END の評価を含む）も、前半・後半とも0より上（スワップ無しの行と主のスワップ込みの行の両方で。口座が一部のメールしか取らなかったために②が通るのを防ぐ）。M は口座の純資産と同じ作りで数える: 円のペアの損益 ＋（ドルのペアの決済した損益とスワップの合計〈ドル〉＋ まだ持っている分の評価〈ドル〉）× その時点のドル円の中値（値段の決まり）。前半・後半の境と END の時点で数え、M1 ＝ 境の値、M2 ＝ END の値 − 境の値（M2 には、前半にたまったドルの、境から END までの換算の差も入る）。決済の時に円にして固定する M は補足の行に出す（判断には使わない）。
    - ③ 取引ごと・全期間・P から1日後の時点: 合図の向き − 逆向きの主の数字（上の「逆向き」）の、区間の下の端 L が0より上。
  - 書く文（先に決めた。①→②→③の順に、当てはまる文をすべて書く。主の行〈スワップ無し・1分足の終値〉の結果を先に、条件に使ったほかの行の結果を後に書く。①・②とも、欠けたときの文は「主の行で欠けた」と「主の行ではそろい、ほかの行だけで欠けた」の2つから選ぶ。「この持ち方では」で始まる言い切りは、主の行で欠けたときだけ使う）:
    - ①がそろう: 「30万円の口座で、2024〜2026年のデータでは、ロスカットも、追証の期限の決済も、上限で入金し切れなかった追証も0回で、入れたお金の合計は __ 円だった（4つの行すべて）」。
    - ①が主の行で欠けた（主の行でロスカットか期限の決済が1回以上）: 「この持ち方では、2024〜2026年のデータで口座が守れなかった」と書き、4つの行それぞれで、ロスカット __ 回・期限の決済 __ 回・上限で入金し切れなかった追証 __ 回（0回の行も。日時と、入金し切れなかった追証の終わり方〈決済で解消・ロスカット・期限の決済〉）を並べる。
    - ①が主の行で欠けた（主の行でロスカットも期限の決済も0回で、上限で入金し切れなかった追証だけが1回以上）: 「主の行（1分足の終値・スワップ無し）では、ロスカットも期限の決済も0回だった。ただ、オーナーの決まり（追証は入金で解消・入れるのは合計100万円まで）では、入金で解消し切れない追証が __ 回あった（日時・不足額・どう終わったか）。その間は新しいメールを受けず、決済の充当で期限の前に解消した。決めた持ち方のままで口座を守れたとは言えない」。続けて4つの行それぞれの3つの回数を並べる。
    - ①が主の行ではそろい、ほかの行だけで欠けた: 「主の行（1分足の終値・スワップ無し）では、ロスカット・期限の決済・上限で入金し切れなかった追証は、どれも0回。〈欠けた行〉では、ロスカット __ 回・期限の決済 __ 回・上限で入金し切れなかった追証 __ 回（日時。入金し切れなかった追証は、終わり方も）。口座が守れたとは言えない」。欠けた行が一番悪い値の行なら「両建ての買いと売りが同時に一番悪い値にいる、実際には起きない形も含む」、スワップ込みの行なら「スワップは目安で、取り分は仮の値」（楽天の実績が読めなかったとき）と添える。
    - ②がそろう: 「前半・後半とも、口座は増えた（前半 +A 円・後半 +B 円・全期間 +S 円。入金を引いた額。4つの行すべて）。すべてのメールを数えても、前半・後半とも0より上だった（前半 M1 円・後半 M2 円）」。
    - ②が主の行の口座で欠けた: 「この持ち方では、〈前半／後半〉の口座は増えなかった（〈前半／後半〉 __ 円、全期間では S 円）」と書き、4つの行それぞれの前半・後半・全期間の値を、そろった行も含めて並べる。
    - ②が主の行の口座ではそろい、ほかの行だけで欠けた: 「主の行（1分足の終値・スワップ無し）では、前半 +A 円・後半 +B 円・全期間 +S 円。〈欠けた行〉では〈前半／後半〉 __ 円（全期間 __ 円）。口座が増えたとは言えない」（但し書きは①と同じ）。
    - ②の口座の行で欠けたときは、どちらの文の後にも「すべてのメールを数えると、前半 M1 円・後半 M2 円」と続ける。
    - ②が、口座の4つの行ではそろい、すべてのメールの見方だけで欠けた: 「口座は前半・後半とも増えた（置けた割合 __%）。すべてのメールを数えると、〈前半／後半〉は __ 円で0以下だった（スワップ無しの行と主のスワップ込みの行の値を並べる）。口座の道筋では、置けなかったメール __ 件（有効証拠金 __・追証の間 __）、追証で取り消された指値 __ 件、ロスカットで取り消された指値 __ 件を取らず、ロスカット・期限で __ 件を途中で決済した。すべてのメールの見方では、これらも最後まで数えた。この持ち方で増えるとは言えない」。
    - ③がそろう: 「P から1日後の時点で、ペアと向きごとの平均をそろえた数字（主の数字 __ pips、区間の下の端 L pips）では、合図の向きは逆向きより良かった。利確まで持った全体での比べではない」。続けて、メールごとの単純な d の平均（__ pips・件数）を必ず並べる。それが0以下のときは「すべてのメールをそのまま平均すると __ pips で、合図の向きは逆向きより良くなかった。主の数字が除くのは、ペアごとに期間を通して一定のトレンドの分だけ」と書き添える。
    - ③が欠けた: 「P から1日後の時点で取引ごとに比べると、合図の向きが逆向きより良いとは言えない」。②がそろったときは続けて「口座が増えた分を、合図の力とは言えない（損切りなし・利確だけという持ち方の作りで増えた分と、区別できない）」と書く。どちらの場合も、逆向きの取引だけで回した口座の結果を並べる。
    - どの場合も、次を添える。
      - 「30万円の口座で、置けた割合 __%（うち、入った __%・置いたが入らなかった __%・追証で取り消された __%・ロスカットで取り消された __%。どれも全メールに対する割合。前半・後半も同じ形）。入れたお金の合計 __ 円」（判断の道筋の数字。①②が欠けた行があれば、その行の数字も並べる）。
      - 「勝率 __%（1回あたり __ pips・__ 円、ロスカット __ 回、E* __ 円。逆向きの取引だけの同じ口座では __%）。損切りが無いので、作りの上で高く出る。この持ち方がうまくいく証拠ではない」。
      - ①か②が欠けた行があるとき: 「(b) の結果で、この判断は変わらない（(b) では口座の①②を見ない）」。①②がそろったとき: 「これは2024〜2026年のデータでの結果で、これからも口座が増えるとは言えない」。どちらも続けて: 「(b) のこれからのメールで比べるのは、取引ごとの P から1日後の1回あたりが、過去の見込みの範囲に入るかだけ。範囲に入っても、勝てるとも、口座の①②を確かめたとも言えない」。
    - 置けなかったメールと、取り消された指値（追証・ロスカット）の両方が0件のときだけ、「全部のメールを受けて」と書ける。断られた・取り消されたメールを除いて残った取引が良く見えたら、それは口座の状態による絞り込みで、この持ち方が良いことの証拠ではない（§8.99 と同じ）。
  - 勝率の書き方: どの勝率（判断の道筋・参考の行・(b) の毎週の報告）にも、その横に終わり方の件数（口座の道筋では利確・ロスカット・追証の期限の決済・END でまだ持っている。取引ごとの見方では利確・END でまだ持っている）を書き、「損切りが無いので、作りの上で高く出る。この持ち方がうまくいく証拠ではない」と必ず書き添える。勝率が100%のとき、または合図の向きの勝率が逆向きの勝率を大きく上回るときは、報告の前に中を調べ（先読みを疑う。§8.84・§8.99 と同じ）、何を調べたかを書く。
  - (b) の読み方: (b) は記録。読む数字は1つ、「P から1日後の時点の1回あたり（取引ごとの見方、GMO、触れたら約定）」。比べるのは1回だけで、P＋1日が END_b 以前のメールが30件たまった最初の END_b の run で比べる（件数だけを §8.24 の採用のルールの2の30回にそろえた。この節は採用を決めないので、この比べで採用のルールを満たしたとは書かない）。
    - 比べる窓（時刻のずれの式で決める）: W0 ＝ 2026-10-04（日）21:00 UTC、S_b ＝ (b) の最初の行の P、o1 ＝ S_b − W0、o2 ＝ END_b − 24時間 − W0。(b) の値は、P が [S_b, END_b − 24時間] に入るメールの、メールごとの平均。(a) の値は、週の始まり W（日曜 21:00 UTC。1週ずつずらす）ごとに、P が [W ＋ o1, W ＋ o2] に入るメールの、メールごとの平均（W ＋ o2 ＋ 24時間 ≦ END の W だけ）。夏時間の切り替えの週も UTC のずれのまま数える。(a) のその値の5〜95%点と比べ、次のどちらかを書く。「過去の見込みの範囲に入っている」／「過去の見込みと合わない（上か下か）」。(a) の各値の件数と (b) の件数を並べる。週ごとには比べない（何度も比べると、偶然の外れが混ざるため）。「範囲に入っている」でも、「勝てる」「確かめた」とは書かない。そのあとも記録は毎週続け、(b) の口座の数字も毎週出す。
    - (a) の比べる値の残し方: (a) を実データで回し、下の「確かめ（実データの run の中）」をすべて通った最初の run（run 番号と commit を書く。それより前に失敗した run があれば、その番号・commit・失敗の理由も書く）から、メールごとの値（T・ペア・向き・P・週・P から1日後の1回あたり）を取り出し、`research/ledger/ultra15-a.csv` として commit して固定する（Actions は repo に push しないので、Claude が commit する）。①〜③の結果を出したのと同じ run から取る。比べるときは (a) を計算し直さず、このファイルだけを読む。
- **確かめ A（作り物。実データを読む前。満たさなければ、実データに進まない）**（外れたら、プログラムの誤りを探す。誤りが見つかれば、決まり・種・幅は変えずに直して走らせ直す。見つからなければ止めて、オーナーに報告する）:
  - 作り物の値動き（本番と同じ道具: 1分足・指値・P＝T＋2分・楽天が止まる時間と GMO の週末〈金曜 20:00／21:00 UTC で終わる〉を入れる。期間は実データと同じ〈START の600本前から END まで〉。合図は作り物ごとに1回だけ作り、③と仕込んだ誤りで使い回す。初めの値段とトレンドで値段がマイナスにならないことを確かめる）で、次を確かめる。
    - (1) トレンドの無い値動き（§8.99 と同じ作り、乱数の種を変えて20通り）と、(2) ペアごとにトレンドはあるが合図に力は無い値動き（1分足1本あたり 0.01 pips と 0.03 pips。(1) と同じ20の種の値動きに、トレンドを足す。種は 1〜20 とし、走らせる前に変えない。向きはペアの一覧の順に＋と−を交互にする。0.01 と 0.03 をそれぞれ20通り。③の確かめは pips だけで行い口座を使わないので、値段がマイナスにならないよう、始めの値段はどのペアも十分高く〈100,000 pips 相当〉置く）で、次の2つを満たす。(i) ③の主の区間の下の端が0より上になるのが、(1)・(2) の0.01・(2) の0.03 のそれぞれ20通りのうち2通り以下（正しい区間なら1通りあたり約2.5%で、3通り以上になるのは約1.3%）。(ii) それぞれ20通りの主の数字の平均が、0から t(19) の両側99.9%点（3.88）×（20通りの標準偏差 ÷ √20）以内（両側。トレンドを消す作りが働いていることの確かめ。正しい作りなら外れるのは1組あたり約0.1%、3組で約0.3%以下）。
    - 仕込んだ誤りとして「週ごとのますで重みをそろえる」作りと「メールごとの単純な平均にする」作りを同じ作り物にかけ、前者は (i) で、後者は (2) の (ii) で外れが出ること（0件なら、この確かめに力が無いとして止める）。
  - 別に書いた計算し直し（Python）で、取引ごとの注文の判定・約定・利確・最大の逆行・1日後と1週後の評価（合図の向きと逆向き）と、口座のロスカット・追証・取り消し・入金・解消・期限・スワップ・E* と、②の M1・M2（スワップ無しと主のスワップ込み）が、全件一致すること。手の例: 上限の手前で一部だけ入金する追証（例: 入れたお金90万円・D 15万円。知らせの時刻に10万円を入金して U は5万円。τ に持っていた建玉〈両建てでない〉1本の利確の充当〈約6万円〉で期限の前に解消し、その後、期限までの間のメール1件を受け付ける）。入れたお金がすでに100万円で入金が0円の追証が、利確2回の充当の合計で U が0以下になって解消する例。期限の前にロスカットで終わる例。判定から知らせの時刻までの間の利確で U が減り、入金が減る例と、その間のロスカットで追証が終わり入金しない例。12/24 の NY の引けの追証（GMO の足が 12/25 にまる1日無い）で、知らせの時刻の入金で解消し、期限の全決済にならない例。期限の前に入金する補足の行で、利確で 08:59 の前に解消する例と、08:59 の前の利確1回で一部だけ充当され、08:59 に U だけを入金する例。金曜の NY の引けの追証（週明けの窓で、取り消した指値が約定しないこと）。夏の金曜 20:00 UTC の合図で、P に足が無く、その夜に追証が出る例（その指値が取り消されること）。週明けの最初の足で利確する取引の金曜のスワップ。楽天が止まる時間の合図（余力ぎりぎりで、τ＋15分のスワップを入れるかどうかで、P＝τ＋15分の注文を受け付けるかが変わる形）。E* の③の最大が止まる時間の足に来る道筋。
  - 先読みの確かめ: 判断ごとに、その判断の時刻までに分かる足だけ（その時刻で切った足）から計算し直し、使った値と全件一致すること（§8.84 と同じ）。合図と E は T に確定した15分足まで。注文の判定は P の1分足の始値まで（その足の高値・安値・終値と、それより後は書き換える）。約定・利確・ロスカットはその1分足まで。NY の引けの処理はその時刻まで。入った足の中では利確を数えない決まりも、この確かめに入れる。
  - 仕込んだ誤り: わざと誤りを入れた版を作り、上の確かめと Python の計算し直しが、それぞれ食い違いを何件出したかを書く。誤りごとに、変わった判断と数字の数を出し、作り物の値動きと手の例の両方で数え、どちらかで変われば仕込みの成功とする。0件なら仕込みの失敗として止める（§8.99 と同じ）。入れる誤りと、数える行: P の次の足の始値で注文を判定する（主）、約定を次の足の値段で決める（主）、入った足の中の利確を数える（主）、ロスカットを次の足の値段で判定する（主）、売りのスワップの符号を逆にする（スワップ込み）、金曜の NY の引けを週明けの最初の足で処理する（主）、足の無い P の注文を引けの処理の後に回す（主）、楽天が止まる間に約定・ロスカットを判定する（主）、入金した後も追証の間として注文を止め続ける（主）、100万円の上限を超えても入金する（主）、U が解消した後も期限まで注文を止める（主。手の例）、解消しても 08:59 に入金する（期限の前に入金する補足の行）、08:59 に D の全額を入れる（期限の前に入金する補足の行）、入金と決済の充当を足し合わせない（主。手の例）、知らせの時刻ではなく判定の時刻 τ に入金する（主。手の例）、入金を知らせの時刻以後の最初の足の中で、期限の後に行う（主。手の例）、ドルの損益を決済の時に円で固定する（主の口座と M）、その夜のスワップを追証の判定の前に入れる（スワップ込み）、その夜のスワップを P＝τ＋15分の注文の受け付けの後に入れる（スワップ込み。手の例）、E* の③に止まる間の足を数える（主）、週ごとのますで重みをそろえる（③）、メールごとの単純な平均にする（③）。
  - スワップ: ドルの金利が円より高い日に、ドル円の売りのスワップがマイナスになること。同じ日・同じペアで、買いと売りのスワップの合計が −2 × 取り分 × 取引額 × 日数 ÷ 365 になること。
- **確かめ B（実データの run の中。1つでも違えば、その run は失敗で終わり、数字は読まない。§8.99 と同じ）**:
  - (1) データ: GMO の読み込みの失敗が0。1分足の欠けは、約定と利確の判定では次にある1分足で判定する（時点の評価は値段の決まり）。平日に連続60分を超える欠けと、τ ちょうどで終わる足が無い平日は、件数と日時を一覧に出す（落とす理由にはしない）。キャッシュは新しい鍵（gmo-1min-*）にし、ほかの研究のキャッシュが Actions の上限で消えないかも確かめる。
  - (2) tf-winrate との照合（上の「メールの決め方の再現」）。tf-winrate.ts は同じ job の中で先に走らせる。
  - (2') `indicatorSignals` との見本の照合（(a) の作り方）で、食い違いが0件であること。見本の足は、tf-winrate と同じく、決まった間隔の足と、合図が出た足の一部（7件に1件）を入れる。同じ job の tf-winrate の JSON の check（15分足）の食い違いも0件であること。
  - (3) Python の計算し直しと先読みの確かめを、実データでも全件で行い、全件一致すること（§8.99 の money-check.py と同じ扱い）。
  - (4) E* の少し上と少し下の確かめ（行ごと）。d の期間が週・4週のまとまりの外に出た件数が0。
  - (5) どれか1つでも違えば: 口座・取引・③・(b) の比べの数字は書き出さずに終える。原因を探すために見たものは、すべて「見てしまった数字」として docs に書く。決まり（測り方）は変えず、プログラムの誤りだけを直して走らせ直す。直す前と後で変わらないはずの出力は、中身を読まずに sha256 で同じか確かめる（§8.99 と同じ）。
  - (b) の毎週の run では、送ったメールとの食い違いでは止めない（上）。ただし (1)・(3)・(4) は、毎週も同じく失敗で終える。
- **見直し**: この決まりは、データを見る前に、独立した見直し（Claude の Workflow。指摘ごとに別のエージェントが反論を試み、反論できなかったものだけを直した）を5回と、5回目の直しの確かめを1回行って決めた。本当とされた指摘は、1回目から順に 31・20・26・10・8 件（5回目は重なりを除いて5件）、直しの確かめで1件。どれも直した。最後の直し（追証の入金を、知らせの時刻の出来事にする）は、Claude が読み直して確かめた（見直しのエージェントには、かけていない）。値段はまだ読んでいない（1分足の始まりの下見で、足の本数だけを数えた）。
- **限り**:
  - 値段は GMO で、楽天ではない。楽天の広告のスプレッドの行が近づけたもの（ドル円は期間の約4割、ほかの4ペアは約2割が、その行でも GMO の値段のまま）。広告を超える実際の早朝の広がりと、指標の時の広がりは入れていない。
  - スワップは、楽天の実績が読めなければ政策金利からの目安で、業者の取り分も仮の値。
  - メールが携帯に届くまでの時間と、オーナーが注文した時刻は測っていない（T＋1分・T＋5分の行の差で、遅れの影響を見る）。追証の知らせの時刻は、楽天の会員向けのページでは「概ね」6:30／7:30（日本時間）で、実際に届く時刻は測っていない。オーナーの実際の約定（楽天の取引の記録）は見ていない。
  - この節で新しく置いた仮定（ここに無いものは、オーナーの答えか、楽天のページか §8.99 の決まり）:
    - 注文の時刻: (a) の P＝T＋2分。足 i+1 の窓で初めて出る合図の P＝T＋17分。楽天が止まる時間に当たった P を止まる時間の終わりに動かすこと。P に足が無いときの判定。(b) の P＝sent_at＋1分を分で切り上げた時刻（送ってから携帯に届くまでの遅れを0とする）。
    - 約定: 窓を空けて始まった足で、指値と利確を始値の有利な方で約定させること。楽天が止まる間は約定・利確・ロスカットを判定しないこと。入りの指値を E に触れたら約定とすること（§8.99 の利確の「届いたら」を入りにも当てたもの。0.1 pips 越えの行は補足）。入った1分足の中では利確を数えないこと。
    - 証拠金: 新しい注文に相殺を効かせないこと。注文中証拠金を注文ごとに足すこと。ドルのペアの注文中証拠金を判定のたびのドル円で数え直すこと。ドルの残高を中値で円にすること。オーナーがコンバージョンをしないこと。米ドルのマイナス残高の両替を入れないこと。
    - ロスカット: 判定する間隔と値段（1分足の終値）。ロスカットの後も残った資金で続けること。ロスカットで取り消された指値を置き直さないこと。
    - 追証: 置いている指値をすべて取り消すこと（楽天は「任意で」）。約定した取引の利確が途切れないこと（オーナーが同じ値段に置き直すまでの時間を0とする）。入金を楽天の知らせの時刻（τ＋35分。「概ね」の時刻ちょうど）に行うこと（知らせを見てから入金するまでの遅れを0とする）。U が残っている間は新しい注文を受け付けないこと。決済による充当を τ の値段の必要証拠金の減りで数えること。その夜のスワップを追証の判定の後、止まる時間の終わりに、P＝τ＋15分の注文の受け付けより前に入れること。期限の前のロスカットで追証が終わること。期限を翌取引日 09:00 UTC とし繰り延べを入れないこと。
- **プログラムで決めたこと**（実データの前。本文に無かった細かい決まり。`research/ownerhold.ts`・`ownerhold-data.ts`・`ownerhold-trades.ts`・`ownerhold-account.ts`・`ownerhold-report.ts`・`ownerhold-fixture.ts` と、別に書いた `ownerhold-check.py` は、これに合わせる）:
  - 足と合図:
    - 1分足は Bid と Ask の両方がある足だけを使う。Ask の終値が Bid の終値より下の足、週末の閉まる時間の中の足（market-hours の barInsideClosure）、同じ時刻の2本目は落とし、件数を出す。
    - 足 i+1 の窓で初めて出る足 i の合図は、窓 i+1 の起点が窓 i と違うときだけ調べる（起点が同じなら同じ計算になる）。メールが出るのは、足 i+1 の確定の1分後か3分後の巡回が、足 i の確定から20分以内で、市場が閉まっているかもしれない時間（isPossiblyClosed）でないとき。P はその足 i+1 の確定＋2分。
    - 同じ P の注文は、楽天の一覧の順（USD/JPY・EUR/JPY・AUD/JPY・EUR/USD・AUD/USD）、同じペアは買いを先に受け付ける。
  - 取引ごと:
    - P に足があれば、その足の始値（買いは Ask、売りは Bid）で成行か指値かを決める。足が無ければ、P の値段（P 以前に終わる最後の1分足の終値）で決め、指値は P の後の最初の足から追う。P より前に足が1本も無いときは、注文しない。
    - 最大の逆行は、入った足（足の無い P の成行は P の後の最初の足）から利確の足（利確しなければ END までの最後の足）まで、楽天が止まる時間の足も含めて数える（利確の足の中の順番は分からないので、その足の安値・高値も入れる。厳しい側）。
    - 1日後の評価の「値段の無い時間」は、P＋24時間ちょうどに終わる足が無いこととする。
    - 取引ごとの円: 円のペアは pips × 0.01 × 1万、ドルのペアは pips × 0.0001 × 1万ドル × 利確の足の終わり（まだ持っているものは END）のドル円の中値（参考の数字）。
    - 窓の有利な約定の分け方: 前の足が6時間より前なら「週明け」、前の足が止まる時間の中か、前の足との間に NY の引けがあれば「止まる時間の後」、前の足が1分より前なら「足の欠けの後」、ほかは「ふだん」。
  - 口座の時刻:
    - 時計は、5ペアのどれかに足がある分。出来事は時刻の順で、ある分の足より前に、その分以前の出来事をすべて済ませる。同じ時刻の出来事は、スワップ → 入金（知らせの時刻・08:59）→ 足の無い P の注文 → NY の引け → 前半・後半の境と END の記録の順。
    - ①の期限の決済で、その分に足の無いペアは、そのペアの最後の終値で決済する。
    - 追証が続いている間に次の NY の引けが来ても（祝日などで期限の決済の足がまだ来ない）、新しい追証は判定しない（今の追証が、その期限で続く）。2つの引けの「同じ値段の点」は、5ペアそれぞれの τ 以前に終わる最後の足が同じこととする。
    - 一番悪い値のロスカットの行の必要証拠金は、その分の終値の中値で数える（純資産だけを一番悪い値で数える）。
    - ロスカット・期限・利確でのドルのペアの決済の損益はドルの残高に入れる（主）。取引の表の「円」は参考で、利確と期限の決済はその分の始まりまでに終わったドル円、ロスカットはその分の終わりまでに終わったドル円、END でまだ持っているものは END のドル円で円にする。
    - スワップの「その日の中値」は、そのペアの τ の値段（τ 以前に終わる最後の足の終値の中値）とする。スワップを付けるのは、τ より前に入った（入った足の始まり、足の無い P の成行は P が τ より前）まだ持っている取引。
    - E* の4つの項の時刻: 注文の項は注文の時刻（P の足の始まり、足の無い P は P）、引けの項は τ、ロスカットの項と損益の項は判定する分の終わり。値が同じときは、時刻の早いものとする。損益の項は、注文の時点・引け・ロスカットを判定する分のすべてで数える（−純資産。注文の時点と引けでは決済する側の値段の純資産、ロスカットを判定する分では、その行がロスカットを判定する値段〈1分足の終値か一番悪い値〉の純資産）。
    - 期限の前に入金する補足の行（08:59）は、知らせの時刻には入金しない。入金の時刻は期限の1分前（08:59 UTC）の出来事。
    - E* の確かめ: E* × (1 + 1e-9) で始めた口座で、断られた注文・取り消された指値・ロスカット・追証がどれも0回。E* × (1 − 1e-6) で始め、入れられるお金の上限も同じ額にした口座で、どれかが1回以上。
  - 手の例:
    - §8.102 の手の例「夏の金曜 20:00 UTC の合図で、P に足が無く、その夜に追証が出る例（その指値が取り消されること）」は、§8.102 の受け付けの決まりでは起きない: 有効証拠金で受け付けた注文の時点で純資産（決済する側）は必要証拠金を上回り、同じ値段の点の NY の引けでは純資産（中値）はそれ以上なので、追証にならない。そこで、この例は、その注文が引けの前に有効証拠金で断られ、その夜に追証が出る形で作った（足の無い注文を引けの後に回す誤りでは、「追証の間」として断られる）。
- **実データの前の直し**（2026-10-06。値段の実データは読んでいない）:
  - スワップの付け方: 楽天のスワップの決まりのページ（www.rakuten-sec.co.jp/web/fx/rule/swap/、§8.99 で GitHub Actions で読んだ控え）を読み直すと、ドルのペアのスワップは「スワップの受取金額（外貨）×外貨の対円レート終値（Bid）＝スワップの受取金額（小数点第一位を切り捨て）」、支払いは Ask と切り上げで、円にして付けている。§8.102 の「ドルのペアのスワップはドルで出してドルの残高に足す」を、これに合わせて直す。ドルのペアは、1回のスワップをドルで出し（受け取りはセント未満を切り捨て、支払いは切り上げ）、その τ のドル円の終値（受け取りは Bid、支払いは Ask）で円にして（円未満は受け取り切り捨て・支払い切り上げ）、円の残高に足す。円のペアも、円未満を同じに扱う（受け取りは切り捨て、支払いは切り上げ）。ドルの残高には、ドルのペアの決済した損益だけが入る。
  - スワップ込みの主の行: 楽天の日ごとのスワップの実績を START から読める公開ページは見つからなかった（スワップの決まりのページと、その案内のリンクを GitHub Actions で読んだ。過去のスワップカレンダーはログインの後の画面への案内だけだった）。§8.102 の決まりどおり、主のスワップ込みの行は取り分0.5%の行になる（結果を見る前に、読めたかどうかだけで決まった）。
  - BIS の政策金利は τ の月の1〜4か月前のうち一番新しい月の値を使う（`longhist-lib.ts` の `rateBefore` と同じ。4か月より前しか無ければ止まる）。
- **独立した見直しの後の直し**（2026-10-06。値段の実データは読んでいない。見直しのワークフローの指摘を1件ずつ確かめて直した）:
  - 先読みの確かめを足す:
    - 入った足の中では利確を数えない決まりを、取引ごとの見方のすべての道筋（利確の足の始まり x ＞ 入った足の始まり t0。足の無い P の成行は t0＝P）と、口座のすべての行の利確（利確の分 ＞ 入った分）で全件確かめる。1件でも破れたら数字を出さない。
    - 合図と E: 判定したすべての15分足（と、遅れた合図を調べたすべての窓 i+1）を、その時に巡回が読めた値段だけ（足 i の確定の1分後までに終わった15分足。遅れた合図は足 i+1 の確定の1分後まで）からチャートの `historyRead` で作り直し、最新600本を `indicatorSignals` に渡して、合図の有無と向き、送ったメールの E と利確2が全件一致することを確かめる。切った後の値段は渡さない。作り物の値動き（全期間）と実データの両方で行う。
    - 口座: 出来事（NY の引け・スワップ・知らせの入金・08:59・足の無い P の注文・前半と後半の境・END）と⑤（ロスカット）は、その時刻までに終わった1分足だけを読めることとし、その時刻に始まる足（まだ終わっていない足）を読めば毒が入る（前は ⑤ と出来事で、時計ちょうどに始まる足を読めた）。
  - スワップの確かめを足す: 期間のすべての NY の引けとペアと2つの取り分で、買いと売りの合計 ＝ −2 × 取り分 × 1万 × 中値 × 日数 ÷ 365 ÷ 100、買い ＝（金利の差 − 取り分）× 同じ、ドルの金利が円より高い日のドル円の売りがマイナス（日数は `tausOf` の数え方）。すべてを受け付けた道筋のスワップ込みの取引ごとに、持っていた引け（τ より前に入り、τ＋15分にまだ持っている）のスワップを作り直した合計と、口座が付けた合計が一致すること。
  - 確かめ B(2') に足す: tf-winrate の JSON の check（15分足）の食い違いが0件で、照らした数が0件でないこと。tf-winrate の START・SPLIT・END・損切り13・WEEKEND inside・5つのペアが、この run と同じこと。tf-winrate と、ここで読む5分足の GMO の読み込みの失敗が0件であること。
  - 取っておいた GMO の日のファイル: GMO が答えた時刻（responsetime）が、その日のファイルの終わり（鍵の日の 22:00 UTC。GMO の日の切り替わり 06:00・07:00 JST の遅い方）より前のもの、または答えた時刻の無いもの（404 を取っておいたもの）は、読み直す。実データの job では、tf-winrate の前に、期間のそのようなファイル（1分足・5分足・15分足）を消す（`MODE=cache`）。404 は、答えた時刻を付けて取っておく。1分足が Bid と Ask ともにあるのに15分足が無い15分の枠の数と例を、ペアごとに出す（失敗にはしない。巡回も同じ GMO のファイルを読んだため）。
  - 出すものを足す: 最大の逆行の円（取引ごとの円と同じ決まり: 円のペアは pips × 0.01 × 1万、ドルのペアは pips × 0.0001 × 1万ドル × 利確の足の終わり〈まだ持っているものは END〉のドル円の中値）。取引ごとの見方の全体・前半・後半（合図の T が境より前か）・ペアごと、成行と指値に分けた勝率と1回あたり。口座の道筋の別の行（判断の4行ほか、すべての行）: 前半・後半・ペアごとの勝率と1回あたりと終わり方、成行と指値に分けた勝率と1回あたり、最大の逆行（pips と円。入った足から、利確・ロスカットはその分の足まで、期限の決済はその分の前の足までとその値段、まだ持っているものは END までに終わった最後の足まで。楽天が止まる時間の足も数える）、利確までの時間の分け方（その行で入った取引のうち P＋h が END 以前のもの）。判断の4行と08:59の行の、ロスカット（日時・前後の資金・決済した数・取り消した数）、追証（τ・期限・D・終わり方とその時刻・取り消した指値の数・入金・充当・知らせの入金の後の U）、入金（日時・額・それまでの合計）の明細。②の補足の行（ドルの損益を決済の時に円で固定した M1・M2、スワップ無しと主のスワップ込み）。
  - 米ドルのマイナス残高の両替の決まり（入れない。当たる回数を出す）: 週の最初の NY の引け（前の引けから2日より後の引け。祝日は見ない）ごとに、ドルの残高がマイナスで、純資産（中値）÷（−ドルの残高 × ドル円の中値）が 50% 以下の回数と日時を、口座の行ごとに出す。
  - Python の計算し直し: E の丸めはチャートと同じ `Number(v.toFixed(d))`（double の正確な値を、ちょうど半分なら上へ）。メールごとの1日後と1週後の値（合図の向きと逆向き）と、1日後の値段の無い時間を、全件比べる（`emails.csv`）。実データでは `--quiet` で走らせ、計算した数（追証・ロスカット・入金の回数、E*、比べた件数、食い違いの例）をログに出さず、食い違いの合計と、食い違いのあった種類の名前だけを出す。
  - 仕込んだ誤りを2つ足す（合わせて24）: NY の引けを τ に始まる足で処理する（主）、E をその次の足の終値にする（合図。全件の先読みの確かめが5ペアすべてで食い違いを出すこと）。仕込んだ誤りの「変わった数」は、§8.102 の「数える行」（主の行とその道筋・③・E*、スワップ込みの行、補足の行など）で数える。作り物の値動きと手の例の変わった数を合わせて0の誤りがあれば、実データの run に進まない（`research/ownerhold-plants.py`、Actions の plants の段）。加えて、どの確かめでも見つからなかった誤りがあれば、同じく進まない（§8.102 より厳しい側）。
  - P がデータの最後の足より後で END より前のメール（END が土曜 0:00 UTC のとき、金曜の最後の15分足で確定した合図など）は、§8.102 の注文の時点の決まりどおり、足の無い P として P の値段（最後の足の終値）で判定する（成行なら入って END でまだ持っている取引、指値なら入らなかった指値）。何もしないのは、P が END 以後か、P より前に足が1本も無いときだけ。Actions の全期間の作り物で、取引ごとの見方と Python はこのメールを何もしないとし、口座だけが判定していて、Python と1件食い違った。いったん口座も何もしない形にそろえたが、独立した見直しで本文と違うと分かったので、取引ごとの見方と Python を本文どおりに直し、口座はそのままにした。
  - 2回目の独立した見直しの後: Python は注文の時刻 P を TS の書き出しから写さず、T＋2分（遅れた合図は T＋17分）として自分で出し、合図ごとに T＝足の始まり＋15分、書き出しの base＝T（遅れた合図は T＋15分）、meta の遅れ＝2分を照らす（実データの run では、meta の始めの資金30万円・上限100万円・START・SPLIT も照らす）。TS の全件の先読みの確かめも、送った合図の T と、注文の元の時刻（その合図を見つけた読みの足の確定）を照らす。作り物の値動きでは遅れた合図が出ない（作り物の walk ではどれも0件だった）ので、遅れた合図の扱いは実データの run の確かめで初めて通る。仕込んだ誤りごとに、自分の確かめ・手の例の照合・Python が出した食い違いの件数を、誤りの判定の表に書く。取引ごとの道筋が「何もしない」メールと、すべてを受け付けた口座で注文しなかったメールが一致することも確かめる（engineVsPaths）。
  - 手の例は14個（前に12個と書いたのは誤り）。
  - (b) これからのメールの部分（`research/ledger/ultra15.csv` を読み、送ったメールと計算し直しを照らし、P＝sent_at＋1分を分で切り上げた時刻で口座を回す部分）は、まだプログラムに無い。(a) の実データの run の後、毎週の run の前に書く。

- **最初の実データの run の後の直し**（2026-10-06。run 37450906176。確かめ A はすべて通り、実データの job の確かめ14のうち E* の確かめ〈estar〉だけが落ちた。決まりどおり数字を出す段には進まず、数字は見ていない。落ちた確かめの中身〈E* の値など〉もログに出ず、見ていない。原因はプログラムを読んで探し、手の例で再現して確かめた）:
  - E* が数でなくなる誤り: 期間の始まり 2024-01-01（元日）は GMO の足が無い（§8.97 の記録: 2023-12-29 金曜の引けから 2024-01-02 の朝まで市場が閉まっていた）。そのため、その夜の楽天の NY の引け（21:55 UTC）が、どのペアの足よりも前に来る。TS の口座は、ドルの残高が0でも、まだ無いドル円の中値を掛けていた。そのため、その引けの純資産が数でなくなり、E* の一番大きい値がそこで止まった（4つの行すべてで E* の確かめが落ちる形）。ドルの残高が0なら円の残高だけにする（Python は前からこの数え方）。あわせて、E* の項が数でなければ数えて、その項は使わずに E* の確かめを落とす。今回の run が落ちた原因はこれでほぼ説明がつく。ただし、2024-01-01 の GMO の最初の足の時刻を、実データで直接は見ていない（このコンテナからは GMO を読めない）。
  - 同じ値段の点の引け（読んで見つけた、本文との違い）: 本文には「各項は、その行が判定する時点だけで数える」と「2つの引けが同じ値段の点なら1回だけ判定する」がある。これに合わせ、すべてを受け付けた道筋でも、前の引けと同じ値段の点の引けでは、引けの項と損益の項を数えない（TS と Python の両方。前は両方とも数えていた）。祝日（12/25・1/1）の間にスワップを払うと、2回目の引けの項の方が大きくなる。口座はそこを判定しないので、E* の少し下で始めても何も起きず、確かめが落ちる。実データでこれが効いていたかは分からない。
  - 手の例を2つ足す（合わせて16）:
    - 「足の前の引け」（estarBeforeBars）: 直す前は E* が数でなくなり、確かめが落ちた。直した後は手で出した 69,610円（火曜の引けの項）。
    - 「クリスマスの同じ値段の点の引けとスワップ」（estarSamePoint）: 直す前は、スワップ込みの行で E* が 12/25 の項 102,085円になり、確かめが落ちた。直した後は 12/24 の項 101,846円（スワップ無しの行は 101,610円）。
    - どちらも Python と食い違い0件。TS だけを元に戻すと、Python がスワップ込みの2つの行で食い違い（8件）を出すことも確かめた。
  - 実データの run で E* の確かめが落ちたときは、数字を出さずに、落ちた行ごとに4つの条件の yes/no を出す: E* が正の数か、少し上で何も起きないか、少し下で何か起きるか、すべての項が数か。

- **2回目の実データの run の後の直し**（2026-10-06。run 37461509838。確かめ A はすべて通り、E* の確かめも通った。落ちたのは loads と tfWinrate。どちらも GMO の読み込みの失敗が0件でないことによるもので、tf-winrate では40件、この研究の読み込みでは16件だった。ドル円と豪ドル/米ドルで「1分足があるのに15分足が無い枠」が 2026-08-23 から出て、合図の数も1回目の run と違った。決まりどおり数字を出す段には進まず、数字は見ていない）:
  - 原因の調べ（`research/gmo-cache-diag.ts`、Actions `gmo-cache-diag.yml`、run 37470964060。読み取りだけ）:
    - 取っておいた日のファイルのうち、1分足 8,610・5分足 8,620・15分足 8,620 は、GMO が作った時刻（responsetime）が、その日の終わりとしていた鍵の日の 22:00 UTC のちょうど1時間前だった。
    - 足のあるファイルは、どれも最後の足が 20:59 UTC で終わっていた（途中で切れたファイルは無い）。足の無い日（土日・祝日）のファイルは、20:59:57〜59 UTC に作られていた。
    - 過去の日を GMO から読み直しても同じだった。米国の冬の 2024-01-02 も夏の日も、最後の足は 20:59 UTC で、作られた時刻は 21:00:00〜21:00:03 UTC。GMO は過去の日のファイルを、作った時の responsetime のまま返す（CloudFront。2026-09-25 に作り直されたファイルも、中の responsetime は元のまま）。
  - つまり、GMO の日のファイルの終わりは、夏冬とも鍵の日の 21:00 UTC（06:00 JST）。「06:00・07:00 JST の遅い方で 22:00 UTC」としたのは誤りだった。そのため、GMO 自身の丸1日分のファイルを「その日が終わる前の答え」とみなし、run のたびにほとんどすべてを読み直していた（この研究の読み込みだけで、1回目の run は 18,800 件、2回目は 17,330 件。tf-winrate の件数はログに出していない）。読んだ中身は丸1日分で正しかったが、この量の読み直しの中で失敗が出た。
  - 失敗した読み込みの理由（HTTP の状態か、GMO の状態か）は、ログに出していなかったので分からない。
  - 直したこと:
    - 日の終わりを鍵の日の 21:00 UTC にする。足の無いファイルは、その1分前（20:59 UTC）以後に作られたものも丸1日分とする。
    - GMO が HTTP 200 で GMO の誤りの状態（混み合い・メンテナンスなど）を返したときも、待ってから読み直す（この研究は6回、tf-winrate は5回）。
    - 失敗した読み込みは、最後の答え（HTTP の状態、GMO の状態とメッセージの番号、つながらなかったこと）を数えてログに出す。この研究は最初の5件の例も出す。
  - 偽の答えで手元で確かめた: 日の終わりの判定、GMO の誤りが1回あった後に読めること、誤りが続けば失敗として理由が残ること。作り物の値動きと手の例は GMO を読まないので、この直しでは変わらない。

- **3回目の実データの run**（2026-10-06。run 37471792086、bbcb61b）: 確かめ A、実データの確かめ、Python の計算し直しがすべて通り、数字を出す段まで進んだ。ただし、その段は analysis.json を整形したままと ultra15-a.csv（約9,500行）をログに出していて、ログ全体が 34,419 行になった。このセッションから読めるのは job のログの末尾 5,000 行だけだった（ログをまとめて落とす置き場 results-receiver.actions.githubusercontent.com は、このセッションの通信の決まりで止められている）。そのため、確かめの行も数字も読めず、数字は見ていない。数字の段はファイル（print.txt）に書き、成果物にして、後ろの job が 4,500 行ずつ出すように変えた。プログラムは同じなので、同じ数字が出るはず。run を出し直す。

- **(a) の結果**（2026-10-06。run 37478579946、765db45。期間 2024-01-01〜2026-10-03 0:00 UTC、前半は 2025-05-18 まで。合図 9,510件〈遅れた合図 0件〉。確かめ A、実データの確かめ14、Python の計算し直し〈食い違い0件〉がすべて通った後に、数字の段の print.txt〈34,054行、sha256 d15b2db5…4ccc〉を numbers の job から読み、つなぎ直して sha256 が一致することを確かめた。取引ごとの1日後の値は `research/ledger/ultra15-a.csv`〈9,502行、sha256 ce4c6ace…70c2〉）。§8.102 で先に決めた文（①→②→③の順）:
  - ①（主の行で欠けた）: この持ち方では、2024〜2026年のデータで口座が守れなかった。
    - 主の行（スワップ無し・1分足の終値）: ロスカット1回（2025-04-11 08:51 UTC、3件を決済、その時の純資産 85,419円）・期限の決済24回（2024-06-21〜2025-10-07）・上限で入金し切れなかった追証28回（終わり方は期限の決済24・決済で解消3・ロスカット1）。
    - 主のスワップ込み: ロスカット1回（2025-04-11 08:51、8件）・期限の決済30回（2024-11-15〜2026-09-30）・入金し切れなかった追証36回（期限30・解消5・ロスカット1）。
    - 一番悪い値: ロスカット1回（2025-04-11 08:48、3件）・期限の決済24回・入金し切れなかった追証29回（期限24・解消4・ロスカット1）。
    - 一番悪い値・スワップ込み: ロスカット2回（2025-04-11 08:51・2025-10-06 20:39）・期限の決済15回・入金し切れなかった追証17回（期限15・解消1・ロスカット1）。
  - ②（主の行の口座で欠けた）: この持ち方では、前半・後半の口座は増えなかった（前半 −918,895円・後半 −71,244円、全期間では −990,139円）。
    - 4つの行の前半・後半・全期間: 主 −918,895・−71,244・−990,139円、主のスワップ込み −815,144・−104,212・−919,356円、一番悪い値 −937,728・−53,861・−991,589円、一番悪い値・スワップ込み −879,572・−125,733・−1,005,305円（入金を引いた額）。
    - すべてのメールを数えると、前半 +2,214,086円・後半 +3,465,092円（スワップ込みでは +1,639,393円・+2,129,912円）。
  - ③（欠けた）: P から1日後の時点で取引ごとに比べると、合図の向きが逆向きより良いとは言えない（主の数字 +0.39 pips、区間の下の端 L −0.89 pips。メールごとの単純な d の平均 +0.26 pips・9,502件。d の期間が週・4週のまとまりの外に出た件数0）。
    - 逆向きの取引だけで回した同じ口座: 勝率92.5%（利確2,316・期限の決済187・END でまだ持っている2）、1回あたり −3.10 pips・−346円、ロスカット0回・期限の決済38回、全期間 −854,117円。
  - 30万円の口座で、置けた割合15.3%（うち、入った15.3%・置いたが入らなかった0%・追証で取り消された0.04%・ロスカットで取り消された0%。どれも全メールに対する割合）。前半28.5%・後半1.8%。置けなかったのは有効証拠金で7,868件・追証の間で185件。入れたお金の合計は1,000,000円（50万円に 2024-04-15、100万円に 2024-06-20 に届いた）。最大の資金の落ち込み 1,015,059円。
  - 勝率91.8%（利確1,334・ロスカット3・期限の決済116・END でまだ持っている0）（1回あたり −6.0 pips・−671円、ロスカット1回、E* 5,968,075円。逆向きの取引だけの同じ口座では92.5%）。損切りが無いので、作りの上で高く出る。この持ち方がうまくいく証拠ではない。
    - 主のスワップ込み: 勝率94.0%（利確2,323・ロスカット8・期限の決済139・まだ持っている1）、1回あたり −2.3 pips・−301円、ロスカット1回、E* 6,781,774円。置けたメールは2,477件で、主の行（1,457件）と違う。
    - E* は100万円を超えた（4つの行とも。どれも 2024-07-11 10:32 UTC の注文の項で決まった）。
  - (b) の結果で、この判断は変わらない（(b) では口座の①②を見ない）。(b) のこれからのメールで比べるのは、取引ごとの P から1日後の1回あたりが、過去の見込みの範囲に入るかだけ。範囲に入っても、勝てるとも、口座の①②を確かめたとも言えない。
  - 置けなかったメールと取り消された指値があるので、「全部のメールを受けて」とは書けない。
  - 参考（判断には使わない）: 取引ごとの見方（資金の限りなし）では、勝率98.8%（利確9,391・END でまだ持っている110。入らなかった指値9）、1回あたり +4.86 pips・+577円。逆向きでも勝率98.8%・+2.65 pips。100%に近いので、報告の前に中を調べた: 逆向きでも同じ勝率なので、合図の力ではなく、損切り無し・利確10 pips・END まで持つ作りで高く出ている。先読みの確かめ（将来の値段を書き換えても結果が変わらないこと、入った1分足で利確を数えないこと、合図をその時に読めた値段だけで作り直すこと、口座の出来事が時刻までに終わった足だけを読むこと）は、実データでどれも食い違い0件だった。
- **(b) のプログラムの細部**（2026-10-07。(b) のプログラムを書く前に、上の (b) の文に無い細部を決めた。(b) の数字はまだ1つも出していない。毎日のメールと計算し直しの照合〈下の「照合」と同じ中身を SQL で行ったもの〉で、メールの行〈ペア・向き・時刻・エントリー〉は見ている）:
  - ledger の形: `research/ledger/ultra15.csv`。列は `pair,side,open,T,E,sentAt`（open は足の始まり、T は確定の時刻、sentAt は送った時刻〈ミリ秒まで〉。どれも UTC の ISO の文字列。E は DB の `entry` をそのまま）。並びは sentAt の順。行の条件は上の「書き出す行」どおり。status が 'sent' でない行の件数と、同じ（ペア・足・向き）のほかの宛先の行の件数は、毎週の docs に書く（CSV には入れない）。同じ（ペア・向き・足の始まり）の行が2つあれば、入力の誤りとして止める。
  - P: sentAt（ミリ秒の整数）を分に切り上げた時刻 ＋1分（＝ sentAt＋1分を分で切り上げた時刻。sentAt がちょうど分の境目なら、その時刻＋1分）。補足の sentAt＋5分の行は、sentAt＋5分を分で切り上げた時刻（＝主の P＋4分）。楽天が止まる時間に入れば、止まる時間の終わりに動かす（(a) と同じ）。(b) では、遅れた合図かどうかで P を変えない（送った時刻から出すので）。
  - S_b: END_b より前に送った行の P（止まる時間で動かした後）のうち、一番早いもの。口座はここから始める。
  - 口座と取引ごとの見方: (a) と同じ作り（`analyse`）で、始まり S_b・終わり END_b。(b) には前半・後半が無い（境を END_b に置くので後半は空。全体だけを読む）。行は (a) の行から、T＋1分の行（(b) では主にあたる）と、後半から始め直す行を除いたもの。利確は E から10 pips（`ultraLevels` の利確2。(a) と同じ）。スワップは (a) と同じ BIS の政策金利からの目安。
  - 照合（計算し直しとメール）: GMO の15分足から (a) と同じ作り方（`signalsOf`）で合図を作り、送る時刻（遅れていなければ T、遅れた合図は T＋15分）が [2026-10-05 16:17 UTC, END_b) に入るものと、ledger の行を（ペア・向き・足の始まり）で照らす。出すもの: 一致した数、メールだけの行と計算し直しだけの合図（一覧）、一致したもののうち E が違うもの（一覧）、遅れの違い（計算し直しは遅れた合図なのにメールは確定から15分以内に送られた、またはその逆）。数える元は送ったメール。食い違いでは止めない。
  - 毎週の run で失敗にする確かめ: (1) GMO の読み込みの失敗0（loads）。(3) Python の計算し直しの食い違い0と、先読みの確かめ（lookAheadPaths・lookAheadAccount）。(4) E* の少し上と少し下（estar）と、d の期間（dOutside）。ほかに、(a) で通した確かめ（tpAfterEntryPaths・tpAfterEntryAccount・engineVsPaths・swapNights・swapRule・swapAgain）も失敗にする（(a) と同じ扱いで、上の文より厳しい側）。計算し直しの合図の確かめ（signalProbe・signalCut）は照合のためだけのものなので、出すが失敗にはしない。tf-winrate との照合（(2)）は毎週は走らせない。
  - Python の (b): Python は ledger の CSV を自分で読み、END_b より前に送った行から P を自分で出し（上の決まり）、TS の signals.csv（ペア・向き・足の始まり・E・sentAt）と S_b（meta の start）を照らす。E を15分足から作り直す確かめは、(b) では食い違いに数えない（E はメールの値。メールと GMO の足の違いは、上の照合に出る）。その件数だけを出す。
  - 送るまでの時間: sentAt − T を、END_b より前に送った全行で、中央値（偶数件なら真ん中2つの平均）と最大（秒）で出す。
  - 比べる窓（1回だけ。上の「(b) の読み方」）:
    - 数える行: ledger の行のうち、取引ごとの見方の道筋が「何もしない」でなく、P＋24時間 ≦ END_b のもの（P は止まる時間で動かした後。(a) の ultra15-a.csv と同じ作り）。その件数を n(END_b) とする。
    - 比べる run: n(END_b) ≧ 30 で、n(END_b − 7日) < 30 の run（END_b − 7日の件数は、同じ ledger・同じ道筋で、P＋24時間 ≦ END_b − 7日 の行を数える）。それ以外の run では比べず、「比べは END_b ＝ __ の run で済んだ」か「まだ __ 件」とだけ出す。
    - (b) の値: 数える行の、P から1日後の時点の1回あたり（合図の向き、pips。(a) の v1d と同じ `valueAt`。入らなかった指値は0）の、メールごとの平均。
    - (a) の値: W ＝ W0 − k週（k ≧ 1）のうち、W＋o1 ≧ 2024-01-01 00:00 UTC（(a) の START）で、W＋o2＋24時間 ≦ 2026-10-03 00:00 UTC（(a) の END）のものごとに、ultra15-a.csv の P が [W＋o1, W＋o2] に入る行の v1d の平均。行が0件の W は値を作らず、その数を出す。
    - 5%点と95%点: (a) の値を小さい順に並べた、floor(q ×（個数 − 1）) 番目（0から数える）の値（`money-stats.ts` の `quantile` と同じ）。5%点 ≦ (b) の値 ≦ 95%点なら「過去の見込みの範囲に入っている」、95%点より上なら「過去の見込みと合わない（上）」、5%点より下なら「過去の見込みと合わない（下）」。
    - 並べるもの: (a) の値の個数と、各値の件数（最小・中央値・最大と、W ごとの一覧）、(b) の件数。
- **(b) のプログラムと見直し**（2026-10-07。(b) の数字はまだ1つも出していない）:
  - 書いたもの: `research/ownerhold-b.ts`（ledger の読み込みと確かめ・合図への変換・照合・送るまでの時間・比べる窓）。`research/ownerhold.ts` の MODE=b・printb・bsyn（`analyse` は (a) と (b) の形を選べるようにした）。`research/ownerhold-check.py` の `--ledger`・`--end-b`・`--a-csv`。`ownerhold.yml` の bsyn・weekly・numbersb（end_b を入れて起動したときは、確かめ A の job は走らず weekly だけが走る）。
  - 作り物での確かめ（bsyn）: 作り物の値動きの合図をメールとし（送った時刻は送る時刻の0〜60秒後。ちょうど分の境目、59.999秒後なども入れた）、メールの記録にありうる違いを4つ仕込んだ（1通を抜く・足の無いメールを1通足す・1通の E を変える・1通を15分より後に送ったことにする）。END_b を 2026-10-10・10-17・10-24 の3つで回し、TS の確かめはすべて通り、照合の4つの違いは仕込んだとおりの件数で出て、Python の食い違いはどれも0件だった。比べる窓は 10-10 の run だけで比べ、10-17・10-24 では比べなかった（決まりどおり）。仕込んだ誤り3つ（P を切り捨てで出す・比べる窓の o2 から24時間を引かない・30件以上のたびに比べる）は、どれも Python が食い違いとして見つけた（それぞれ当たる END_b で）。
  - (a) が変わらないこと: 直す前（3f4e05a）と後で、手の例の書き出し 2,557 ファイルと、3か月の作り物の値動き（仕込んだ誤り2つを含む）の書き出し 2,306 ファイルの sha256 がすべて同じ。Python の (a) の pycheck.json も同じ（作り物の値動きで 101,611件を比べて食い違い0）。手の例16個は新しい Python でもすべて通った。
  - 独立した見直し（Claude の Workflow。4つの見方で探し、見方ごとに別のエージェントが反論を試みた。8エージェント）: 指摘8件のうち、本当とされたのは4件。どれも直した。
    - 口座の始まりの値段（重い）: (b) の口座は S_b から始まるが、TS の口座は始まりの時点で「その前に終わった最後の1分足」を使わず（読み込んである前の日の足を使わず）、最初の1分の値段が数でなかった。最初の分にドルのペアの注文があるとき（注文中証拠金にドル円の中値を使う）や、同じ分に成行で入った取引があるときに、E* の確かめと先読みの確かめが落ち、ledger の最初の行は毎週同じなので、毎週の run が毎回落ちる形だった。値段の決まり（τ 以前に終わる最後の1分足の終値）どおりに、口座の始まりで、その前に終わった最後の1分足から値段を読むように直した（Python は前からこの読み方）。bsyn に「難しい始まり」を足した: 最初の2通（EUR/JPY の売りと EUR/USD の買い、どちらも成行で入る）を 2026-10-05 20:53 UTC に送ったことにし、P（20:55）が楽天の止まる時間に入って 21:10（＝S_b）に動く形。直しを戻した写しで走らせると、この例で先読みの確かめ（lookAheadAccount）と E* の確かめが落ち、直した後は通る。(a) は、始まり 2024-01-01 00:00 の前の1日に GMO の足が無い（§8.97 の記録）ので、始まりの値段は直す前と同じく無い。作り物と手の例で書き出しが同じことは上のとおり確かめたが、(a) の実データでは走らせ直していない。
    - 止まる間も判定する行（補足）の始まり: この行は P を動かさないので、最初のメールの P が止まる時間に入ると、その P が S_b より前になり、この行の口座とその E* から、そのメールが抜けていた（決まりでは、何もしないのは P が END 以後か、P より前に足が無いときだけ）。この行（口座と E*）だけは、動かす前の一番早い P が S_b より前なら、そこから始めるように直した（(a) では、どの P も START より後なので変わらない）。(b) では、この行で「道筋が何もしない」でないメールが注文されなかった件数を数え、0でなければ失敗にする確かめ（judgeMaintOrders）を足した。直しを戻した写しで、難しい始まりの例はこの確かめで落ちる（抜けた4件）。なお、実際の ledger の最初の行（2026-10-06 05:00:03.824 UTC に送ったメール、P 05:02）は止まる時間に入らない。
    - 照合の遅れの境目: 「確定から15分以内に送られた」の「以内」どおり、ちょうど15分は時間内（遅れていない）とした（前はちょうど15分を遅れとしていた）。
    - Python の「E が15分足から作り直した値と違う件数」（決まりで「その件数だけを出す」）が、毎週の run のログに出ていなかった。`--quiet` でも1行出すようにした（入力の照合の件数で、測った数字ではない）。
    - 本当とされなかった4件: bsyn の段が Python の異常終了も「仕込んだ誤りを見つけた」と数える形（いまのコードでは起きていない。念のため、Python が pycheck.json を書き終えて食い違いが0より多いときだけ見つけたと数えるように固めた）。毎週の run で確かめ A を走らせないこと（決まりは、毎週の失敗の条件を (1)・(3)・(4) としている。確かめ A はプログラムの push のたびに走る）。END_b の確かめが土曜 00:00 UTC かだけなこと（その日のうちに走らせても、土曜の鍵の日のファイルに足は無い）。止まる間も判定する行の抜け（上の直しと同じ中身を、別の見方の反論役は「決まりは S_b から始めると書いている」として本当としなかった。補足の行がメールを抜くと主との差が読めなくなるので、直した）。
  - Actions: 直した後の push の run 37578690082（716271e）で、確かめ A（③の作り物60通り・手の例16個と仕込んだ誤り・作り物の値動きの全部と仕込んだ誤り24・plants）と bsyn（3つの END_b と難しい始まり。Python の食い違い0件、仕込んだ (b) の誤り3つはどれも見つけた）がすべて通った。weekly・real は決まりどおり走らなかった。
- **(b) の毎週の手順の中身**（2026-10-07 に決めた。最初の run は 2026-10-12〈月〉、END_b ＝ 2026-10-10 00:00 UTC）:
  1. ledger の書き出し（DB の道具）: `signal_alerts` から、オーナーの user_id・kind 'signal'・rule ULTRA の id・interval '15min'・5ペア・status 'sent'・sent_at があり、2026-10-05 16:17 UTC 以上 END_b 未満の行を、sent_at・pair・side の順に、`pair,side,open,T,E,sentAt`（時刻は UTC の ISO、ミリ秒まで。E は entry をそのまま文字にしたもの）で書く。sent_at にミリ秒より細かい値が無いことも数えて確かめる（2026-10-07 の時点で13行、0件）。同じ条件で status が 'sent' でない行の件数と、オーナーの行と同じ（ペア・足・向き・rule・interval）のほかの宛先の行の件数を数え、docs に書く（user_id は repo に書かない）。前の週の CSV と、前の週の END_b より前の行がすべて同じであることを確かめてから、`research/ledger/ultra15.csv` を置き換えて commit・push する。
  2. `ownerhold.yml` を作業ブランチで、end_b ＝ その END_b を入れて起動する（weekly と numbersb だけが走る）。
  3. weekly のログから、照合の一覧（メールと計算し直し）・確かめの結果・Python の食い違いの数と E の違いの件数を読む。numbersb の job から print.txt を読み、つなぎ直した sha256 が weekly のログと同じことを確かめる。
  4. docs に記録し（前の週に書いた数字が回し直して変われば、その差と理由も）、PR を作ってマージし、オーナーに日本語で報告する。比べる窓は、比べる run（P＋1日 ≦ END_b のメールが初めて30件以上になった END_b）でだけ書く。

### 8.103 ② コストの悪い時間帯を避けるルールを先に決め、まだ見ていないデータで確かめる（#206、研究のみ）

- **指示**: §8.102 の指示（2026-10-05）の②。オーナー「順番通りでお願いします」。① の (a) を記録し、(b) を毎週回す形にした後に始めた（2026-10-07）。
- **前に分かっていること**（§8.18、#100。今の ULTRA のメールとは違う合図と決済での結果）: GMO のスプレッドは NY の日替わり（UTC 21〜23時台）に大きく開く（ドル円の15分足の終値で、21時台の中央値 12.5 pips・22時台 12.1・23時台 2.9、ほかの時間は 0.2〜0.4）。「UTC 17〜23時は出さない」を前半で決め、後半だけで評価すると、5ペア・15分足と1時間足で、残したプランの勝率が4〜6ポイント上がった（損切りのある公開プランでの数字）。今の15分足 ULTRA のメール（指値・利確10・損切りなし）では、時間帯ごとの成績は測っていない（(a) の結果も時間帯では分けていない）。§8.99（#188）でも、2024〜2026年の4時間足のメール（損切り13・利確4）を確定の時刻で分けた数字を出している（夜中〈16:00・20:00 UTC〉が悪く、00:00 UTC は払ったスプレッドの平均 4.61 pips。詳しくは下の決まりの「前から知っていたこと」。2026-10-07 の2回目の見直しで、ここに無いことが見つかって足した）。
- **下見: GMO の15分足・5分足がいつからあるか**（`research/gmo-start.ts`、run 37582349994、2026-10-07。足の本数だけを数え、値段は読んでいない）: 5ペアとも、15分足・5分足の売値と買値がそろう最初の日は 2023-10-27（金）。その前の45日（2023-09-12〜10-26）に売値の足は無く、2010〜2023年の各年1月の最初の平日にも無かった（各月の最初の平日を 2010-01 から順に調べ、2023-11 で初めて足があった）。1分足と同じ始まり（§8.102 の下見）。2024-01-02 は15分足 92本・5分足 276本（売値・買値とも）。
  - 2023年11〜12月の値段を結果として docs に出したのは、§8.96（ゴトー日。ドル円の1分足の、ゴトー日の朝の売買の損益と時刻ごとのスプレッド）だけ（docs を「2023」で探した範囲。すべてのプログラムを確かめてはいない）。ほかの研究は、2023年の足を、合図の前の足（§8.102 の (a) の15分足は 2023-12-20 から）・ATR の始まり・週末の足の調べ・足の本数の下見としてだけ読んだ。15分足の ULTRA の合図とこの持ち方の成績は、2023年ではまだ計算していない。（直し: 2026-10-07 に「どれも 2024-01 からの足しか読んでいない」、その直後に「2023年の足を読んだのは §8.96 だけ」と書いたが、どちらも誤り。② の決まりの見直しで見つかった）2024年より前に使える GMO の足は 2023-10-27〜2023-12-31 の約2か月だけで、15分足の合図に要る前の足（`LEAD15` 12日）を除くと、合図を出せるのは 2023年11月上旬から。
- **オーナーの選択**（2026-10-07、選択式の質問への答え。「」は選んだ答えの文）:
  - 確かめるデータ「両方で確かめる」: まず 2023年11〜12月の足（GMO の1分足、今の測り方と同じ作り）で確かめ、そのあと、これからのメール（§8.102 の (b)、毎週の記録）でもう一度確かめる。
  - 避ける時間帯の決め方「スプレッドの広さで決める」: 2024〜2026年の GMO の足から、時間帯ごとのスプレッド（売値と買値の差）だけを数えて、広い時間帯を避ける。成績（合図の後の値動き）は見ない。決め方は、2024〜2026年の足を読む前に docs に書く。
- **決まり**（2026-10-07。データを見る前に決めた。まだ読んでいないものは3つ。段1で数える数字〈2024〜2026年の1分足の、枠ごとのスプレッド〉、2023年11〜12月の ULTRA の合図とその後の値動き、(b) のメールを避ける枠で分けた成績。2023年の足のうち、これまでに読んだもの・見た数字は、下の「前から知っていたこと」に書いた。この決まりのために読んだのは、docs〈§8.18・§8.93・§8.96・§8.97・§8.99・§8.102・§8.103〉と、研究のプログラム〈research/ownerhold*.ts・ownerhold-check.py・money-stats.ts・ownerhold.yml・market-hours.ts〉だけ）:
  - これは、②のルール（スプレッドの広い時間帯のメールでは注文しない）が効くかを、ルールを決めたときに見ていない2つのデータで確かめるもの。ルールを使うかは、結果を見てオーナーが決める。メールの仕組みは変えない。
  - 2つの段に分ける。
    - 段1（ルールを決める）: 2024〜2026年の GMO の1分足から、時間の枠ごとのスプレッド（買値 − 売値）だけを数える。避ける枠を決めて、ファイルに固定する。合図も、合図の後の値動きも計算しない。
    - 段2（確かめる）: 固定したファイルを、まず2023年11〜12月の GMO の足に当てる。次に、これからのメール（§8.102 の (b)）に当てる。段2は枠を計算し直さない。
  - 測るもの: 避けたメールの P から1日後の値が、同じ週・同じペア・同じ向きの残したメールより悪いか（GMO の値段で、メール1通ずつ）。
  - 測らないもの: 楽天での成績。オーナーの実際の約定。口座が増えるか（口座は参考に並べるだけ）。利確まで持った最後の損益。注文を遅らせる形。
  - **前から知っていたこと**（下の決め方は、これを知った上で決めた）:
    - §8.18（#100）: 時間ごとのスプレッド（ドル円の15分足の終値で、UTC 21時台の中央値 12.5 pips・22時台 12.1・23時台 2.9、ほかの時間は 0.2〜0.4）。§8.18 の文は「UTC 21 時／冬 22 時」に開くと書いている。ただし、季節に分けて数えた数字は docs に無い。もう1つは、損切りのある別の持ち方で「UTC 17〜23時は出さない」とすると、勝率が上がったこと。
    - §8.96（#186、ゴトー日）: GMO のドル円の1分足（売値・買値）を 2023-10-27 から読み、2023年11〜12月を含む次の数字を docs に出している。
      - 入る時刻ごとの払ったスプレッドの中央値（2023-10-30〜2026-10-02 をまとめた値）。06:00〜08:00 JST〈UTC 21〜23時〉に入ると 5.85〜6.35銭。
      - 23:00 と 9:55 JST のスプレッドの中央値と、米国の夏冬に分けた95パーセンタイル。
      - 2023年の取引の損益。2023年は11〜12月の9回だけ。最悪の1回は 2023-12-08 の −174.2銭、比べる日の最悪は 2023-12-14 の −282.0銭、最大の逆行は 2023-12-08 17:47 UTC。
      - 2023-12-25 にドル円の足が無かったこと（2023-12-26 の比べる日が外れた）。
      - 見たのは、ドル円の夜の窓（14:00〜00:55 UTC）の値動きと、時刻ごとのスプレッド。
    - §8.97（#187）: 14ペアの日足を、2023年の年のファイルから読んだ（ATR の始まりに使った。値は出していない。年末年始の休み〈2023-12-29 金曜の引けから 2024-01-02 の朝まで〉は書いた）。
    - §8.99（#188）: 2024〜2026年の GMO の4時間足のメール（Q-Trend と ULTRA、損切り13・利確4。今の15分足 ULTRA の損切りなしの持ち方とは違う）を、確定の時刻で分けた数字を docs に出している。
      - 夜中（16:00・20:00 UTC の確定）1,447回 70.1%・1回あたり −1.37 pips、それ以外 2,511回 75.2%・−0.88 pips。差 +0.49 pips（95%区間 −0.19〜+1.13）。払ったスプレッドを足し戻しても差は +1.09 pips（+0.41〜+1.76）で、§8.99 は「夜中の差はスプレッドの分ではない」と書いている。
      - 時刻ごと（§8.99 は、先読みの確かめのためだけに見て、何かを変える理由にしないと決めていた）: 00:00 UTC 442回 68.8%・−3.68 pips（払ったスプレッドの平均 4.61・中央値 2.80 pips）、20:00 UTC 456回 58.6%・−3.29 pips、ほかの時刻（04:00・08:00・12:00・16:00）は 74.6〜77.7%・−0.08〜−0.63 pips。
      - 楽天の広告のスプレッドの表（§8.102 でも使った）: ドル円は 2025-03-06 から、日本時間3〜9時が 3.8銭。
      - どれも 2024〜2026年の数字で、2023年11〜12月と (b) のメールには触れていない。
    - §8.102 の (a) の run（同じ job の tf-winrate を含む）: 合図の前の足として、2023年の足を読んだ。15分足は 2023-12-20 から、5分足は 2023-12-27 から、1時間足は 2023-11-17 から、4時間足・日足は 2023年の年のファイルから。どれも値は出していない。
      - 1分足は 2023-12-31 00:00 UTC 以後だけを使った（年末年始の休みで、2024-01-02 まで足は無かった〈§8.97〉）。
      - (a) の数字の段の print.txt（analysis.json の全体と、ultra15-a.csv の 9,502行〈T・P・1日後の値〉）は、つなぎ直すために一度すべて読んだ。時間帯では集めていない。
    - ほかの研究でも、2023年の足を、合図の前の足や、週末の足の調べ（§8.93 の `weekend-years.ts`。2023〜2026年の4時間足・日足）で読んだ。その足での成績は出していない。ここで全部を数え上げてはいない。
    - 下見（§8.102・§8.103）: 2023年の足の本数だけを数えた（値段は読んでいない）。
    - まとめ:
      - 2023年11〜12月の ULTRA の合図と、その後の値動きは、どのペアでも計算していない。
      - ドル円以外の4ペアは、2023年11〜12月の1分足の値段を読んでいない。
      - ドル円の 2023年11〜12月は、別の問い（ゴトー日）で一部をすでに使ったデータ。
      - この節で「まだ見ていないデータ」と書くときは、いつもこの但し書きが付く。
    - (a) の成績（`ultra15-a.csv`）を時間帯で分けて見たことは無い。2つの確かめが終わるまで、分けて見ない。
  - **記録の直し**: 上の「下見」の項の、2023年の足を読んだかの文は、2026-10-07 に2回直した（いまの文。最初の2つはどちらも誤り）。

- **スプレッドがこの持ち方に効く道筋**（考え。どれも測っていない。下の決め方の理由）:
  - 指値の入り:
    - 買いの指値は、買値（Ask）が E に触れたら E で入る。買値は中値よりスプレッドの半分だけ高い。そのため、広い間は、中値が E よりスプレッドの半分だけ下がるまで入らない。
    - 広い間に入った取引は、その時の中値より、スプレッドの半分だけ悪い値（E）で入る。すでに有利で成行で入るときも、その時の買値で入るので同じ。売りは向きが逆になるだけ。
  - 利確: 決済する側の値段（買いは売値）が利確の値段に届いたら出る。広い間に届いた利確は、その時の中値より、スプレッドの半分だけ悪い値で出る。
  - 広い時間が過ぎた後:
    - 上の2つの分は、広い時間が過ぎても消えず、中値で評価した1日後の値に残る。
    - 広い間に入らなかった指値は、広い時間が過ぎれば、条件がふだんに戻る。
  - 損切りも期限も無いので、利確まで持てば、損益はいつも +10 pips（窓を空けて有利に約定したときは、それより大きい）。
    - 広さが変えるのは、利確までの時間と、その間の含み損（口座）。利確まで持った最後の損益ではない。
    - そのため、主の数字は1日後の値にする（§8.102 の③と同じ時点）。
  - 合図と E は、中値の15分足で決まる。広がりが売値と買値の片側に寄ると、中値も動き、合図と E がずれうる。
  - 1日後の評価の時刻（P＋24時間）は、次の日の同じ時刻。避けたメールは、評価の時刻も広い時間に当たる（下の5で、中値で評価する理由）。
  - このルールで変わるのは、新しい注文だけ。持っている取引が広い時間をまたぐことは変わらない。

- **1. 時間の枠**:
  - 枠は UTC の15分（0:00〜0:14 が枠0、…、23:45〜23:59 が枠95）。これを米国の夏時間と冬時間に分ける。1つのペアで 2 × 96 ＝ 192枠。
  - 夏か冬かは、その時刻の NY のずれで決める。market-hours の `nyOffsetMs` が −4時間なら夏、−5時間なら冬（楽天の NY の引けと止まる時間と同じ決め方）。1分足は足の始まりの時刻で、メールは P で、季節と枠を決める。
  - 季節で分ける理由:
    - 楽天の NY の引けと止まる時間は、夏冬で UTC が1時間動く（夏 20:55、冬 21:55 UTC）。
    - 一方、GMO の週の始まりは、夏冬とも日曜 22:00 UTC（§8.93）。日のファイルの区切りも、夏冬とも 21:00 UTC（§8.102）。
    - GMO の広がりが、NY の時刻に付いて動くのか、UTC（日本時間）の決まった時刻に来るのかは、確かめていない（季節に分けて数えた数字が無い）。
    - 季節ごとに UTC で数えれば、どちらでも枠はずれない。季節の中では NY と UTC のずれは一定なので、NY の時刻で数えても同じ枠になる。
  - 15分にする理由: メールの足と同じ区切り。(a) の作りの P（T＋2分）は、T から始まる枠に入る（遅れた合図の T＋17分は、次の枠に入る）。
  - 曜日・祝日・週明け・金曜の終わりでは分けない。下の中央値で決めるので、週に1日だけ広がる時刻（週明けの最初の数分など）は、広い枠にならない。そうした時刻は、このルールでは避けない（限り）。
  - 英国・欧州の夏時間の切り替えが米国とずれる週（年に約3週）も、米国の季節だけで分ける（仮定: GMO の広がりは、米国の季節の中では同じ時刻に来る）。

- **2. スプレッドの数え方**（段1）:
  - 使う足: 5ペアの GMO の1分足のうち、§8.102 の読み込み（`loadM1`）が残す足。
    - 残すのは、売値と買値の両方があり、買値の終値が売値の終値より下でなく、週末の閉まる時間の外にあり、同じ時刻の2本目でない足。落とした件数は、ペアごとに出す。
    - 足の始まりが 2024-01-01 00:00 UTC 以上、2026-10-03 00:00 UTC 未満（(a) と同じ期間）。
    - 15分足・5分足は読まない。
  - 読む日のファイル:
    - TS は、`keysOf` が出す鍵のファイルだけを開く。鍵は、期間を前後に1日広げた日本時間の日付で、20231231〜20261003。
    - Python は、同じ決め方で鍵の一覧を自分で作り、その鍵のファイルだけを開く。いまの `ownerhold-check.py` の `read_side` のように、フォルダのファイルを `os.listdir` で全部開く作りは使わない。
    - 2023-12-31 の鍵（2023-12-30 21:00〜12-31 21:00 UTC）は週末で、足は無い見込み。あっても期間の外なので残さない。
  - 確かめ（TS と Python の両方。1つでも外れたら、表もファイルも出さずに止まる）:
    - GMO の読み込みの失敗が0。
    - 開いた鍵の最小と最大が、上の範囲の中。
    - 残した足の始まりの最小が 2024-01-01 00:00 以上。終わりの最大が 2026-10-03 00:00 以下。
    - この4つの値（鍵の最小・最大、足の時刻の最小・最大）は、ログに出す。
  - 1本の値 s: 買値の終値 − 売値の終値を、GMO の値段の最後の桁（0.1 pips。円のペアは 0.001、ドルのペアは 0.00001）の整数にする。
    - 本来は整数なので、丸めるのは浮動小数の誤差だけ。TS と Python がちょうど一致するようにするため。
    - 1分の終わりの1点の値で、その1分を代表させる（仮定。売値と買値の終値は同じ瞬間の値とする。§8.18 と同じ）。
  - 枠の値: ペア・季節・枠ごとに、その枠に始まる1分足の s の中央値（本数が偶数なら真ん中2つの平均。`medianOf`）。
  - ふだんの値 base: ペアごとに、期間のすべての1分足（夏冬・すべての枠）の s の中央値。
  - 中央値にする理由: 毎日のように広い時間だけを選ぶため。指標の発表などで、たまに一瞬だけ開く時刻は、時刻のルールでは避けられない。平均は使わない。
  - 並べるだけの数字（決めるのには使わない）: 枠ごとの本数・平均・90%点（`quantile` と同じ取り方）。
  - このプログラムは、合図・取引・その後の値動きの関数を呼ばない。
    - `loadM1` のある `ownerhold-data.ts` は、読み込んだ時点で合図のコード（`ultra.ts`・`indicators.ts` など）も import する。それは呼ばない。
    - 出すのは、スプレッドの表と確かめの結果だけ。

- **3. 避ける枠の決め方**:
  - 避ける枠の条件は2つ。枠の中央値 ≧ max（3 × base、1.0 pips）であること。その枠の1分足が1,000本以上あること。ペアごと・季節ごとに決める。
    - 比べは整数で行う。中央値も base も、0.1 pips の整数かその半分。そこで 0.1 pips の単位で2倍して、2 × 中央値 ≧ max（3 × 2 × base、20）で比べる。TS と Python がちょうど一致するようにするため。
    - 3倍: そのペアのふだんより、はっきり広い時間だけを選ぶため。
    - 1.0 pips: 利確2（10 pips）に対して効く広さだけを選ぶため。広い間に入った取引は、入りと利確のそれぞれで、スプレッドの半分ずつ悪い値になる。1.0 pips なら合わせて約1 pips で、利確の1割。
    - どちらも、データを見る前に置いた数で、一番良い数かは確かめていない。§8.18 の日替わりの開きは、どちらの基準でも入る見込み（ドル円の15分足の終値で中央値 12 pips 台、ふだんの30倍以上）。ただし 2024〜2026年の1分足では、まだ数えていない。
  - 1,000本より少ない枠は、避けない（一覧に出す）。
    - 見込み: 期間のうち、冬は約46週、夏は約98週（暦から数えた。足は数えていない）。
    - 開いている枠は、冬でも約2,700本以上ある見込み。この決まりが当たる枠は無い見込み。
  - ペアごとにする理由: ふだんのスプレッドはペアで違い、コストはそのペアの取引にかかる。
    - オーナー向けの表には、5ペアのどれかで避ける枠（和）も並べる。
    - 確かめるのは、ペアごとの枠だけ。
  - 当たる枠は、そのまま全部使う。となりの枠をつなげたり、離れた1枠を外したりしない。
  - 止める条件（段1の結果を docs に書いた後、段2の前に見る）:
    - どれかのペア・季節で、避ける枠が32（8時間）を超えたら、「広い時間だけを避ける」ルールにならない。段2に進まず、オーナーに報告する。
    - 冬の避ける枠がどのペアにも無ければ、2023年（すべて冬）では確かめられないと書く。
    - 夏冬ともどのペアにも無ければ、ルールは何も避けない。②の確かめはしないと書いて終える。
    - 基準は、避ける枠が多くても少なくても動かさない。決め方を変えるときは、6 の「R の置き直し」に従う。
  - 書き出し: `research/ledger/spread-hours.csv`。
    - 列は、ペア・季節・枠・UTC の時刻・本数・中央値・平均・90%点・base・しきい値・避けるか。
    - docs には、次を書く。ペア・季節ごとの避ける時刻（UTC と日本時間）、base、しきい値、避ける時間が週の取引時間に占める割合、ファイルの sha256、run の番号と commit。
  - 段2のプログラムは、このファイルの sha256 が、docs とプログラムの定数に書いた値と同じことを確かめてから読む。
    - 違えば、何も計算せずに止まる。
    - 2023年や (b) の数を見た後で、枠も基準も変えない。

- **4. 判定する時刻と「避ける」の意味**:
  - 判定する時刻は、注文する時刻 P。P が楽天の止まる時間に入れば、その終わり（τ＋15分）に動かした後の P を使う（§8.102 の取引ごとの見方と口座と同じ P）。
    - 2023年: P＝T＋2分（遅れた合図は T＋17分。§8.102 の仮定のまま）。
    - (b): 送った時刻（sentAt）＋1分を、分で切り上げた時刻（§8.102 の (b) のまま）。
  - P の季節で、P がそのペアの避ける枠に入るメールを「避けたメール」、ほかを「残したメール」とよぶ。
  - 避けるとは、そのメールでは何も注文しないこと（指値も成行も置かない）。
    - ほかのメールの注文、入っている取引、置いている指値とその利確は変えない。
    - 広い間だけ指値を外す形や、注文を遅らせる形は測らない。
  - 動かした後の P にする理由:
    - オーナーが実際に注文する時刻で、成行か指値かもそこで決まる。
    - 2023年の作りでは、動かす前と後で枠は変わらない。冬に止まる時間に入る P は 22:02 だけで、動かした 22:10 も同じ 22:00 の枠。
    - (b) では、送るのが遅れて枠が変わることがある（7 の (3) の手の例で確かめる）。
  - 判定は、P の時刻と固定したファイルだけで決まり、値段を読まない。
  - 合図の足（T−15分〜T）が広い時間にあっても、P が次の枠なら避けない（限り）。

- **5. 2023年11〜12月での確かめ**:
  - 期間:
    - START ＝ 2023-11-08 00:00 UTC（水）。
      - 15分足は、2023-10-27 00:00 UTC（＝ START − `LEAD15`〈12日〉）から読む。GMO の最初の日のファイル（鍵 20231027）は、2023-10-26 21:00 UTC からの足を持つ（§8.96 で1,440本）。その3時間は読まない（(a) と同じ読み方）。
      - 15分足の600本の窓は、START の時点で約750本前からある見込み。600本目は 2023-11-06 の朝の見込み（暦から数えた。足は数えていない）。
    - END ＝ 2023-12-30 00:00 UTC（土）。GMO は、2023-12-29 金曜の引けから 2024-01-02 の朝まで止まっていた（§8.97）。
    - 合図は、確定 T が [START, END) のもの。
  - 2024年の足は1本も読まない:
    - TS も Python も、`keysOf` の決め方の鍵のファイルだけを開く（2 と同じ）。
      - 1分足は START − 1日から読むので、鍵は 20231106〜20231230。
      - 15分足は、鍵が 20231026〜20231230。
    - 開いた鍵の最大が 20231230 以下で、残した1分足・15分足の終わりが、すべて END 以下であること。両方のプログラムで確かめ、ログに出す。
    - [START, END) の15分足で、600本の窓がそろわないもの（`noWindow`）が、5ペアとも0件であること。
    - 1つでも外れたら、数字を出さずに止める。
    - 窓がそろわなかったときの START の決め直し（先に決めておく）:
      - 新しい START は、5ペアのうち一番遅く600本目の15分足が確定した時刻の後の、最初の 00:00 UTC。
      - 止まった run のログには、ペアごとの600本目の時刻だけを出す（足の本数だけで決まり、値段は使わない）。
      - 15分足は 2023-10-27 00:00 UTC から読んだままにする（START − LEAD15 にしない）。END は変えない。
      - 決め直したら、数の見込み（数えるメール・週の数）を書き直し、docs に書いてから走らせ直す。
    - キャッシュ: 2023年の run は、共有のキャッシュ（`gmo-1min-*`）を戻さない。専用の鍵（`gmo-2023-*`）のキャッシュだけを戻し、保存する。
      - 手元に 2024年以後の日のファイルが無い形で走らせるため。
      - また、2023年の日のファイルが、共有のキャッシュに入らないようにするため。
  - 作り: §8.102 の (a) をそのまま使う。
    - 合図〈`signalsOf`〉・P＝T＋2分・指値は E・すでに有利なら成行・利確2〈E ± 10 pips〉だけ・損切りも期限も無し・1万通貨・触れたら約定・楽天の止まる時間・値段の決まり。
    - メールが送られない時間（金曜 21:00〜日曜 22:00 UTC）に確定した足は数えない。
    - 前半・後半は無い（境を END に置く。(b) と同じ）。
  - この期間は、すべて米国の冬時間（夏時間は 2023-11-05 に終わった）。確かめるのは冬の枠だけ。
    - 2023-12-25（月）: §8.96 で、ドル円にこの日の足が無かった（14:00 UTC の足が無く、2023-12-26 の比べる日が外れた。期間の欠けのほぼすべてが 12/25 と 1/1）。ほかの4ペアの 2023-12-25 は見ていない。
    - 感謝祭（11/23）と、年末の薄い週も外さない。
  - 数えるメール（下の順に見て、当てはまった最初の理由1つだけで数えなかったことにする）:
    1. 取引ごとの見方の道筋が「何もしない」。
    2. P が金曜（UTC の曜日）。
    3. P＋24時間 ＞ END。END は土曜 00:00 UTC なので、2 で外した後には当たらない見込み。守りとして置き、7 の (3) の手の例で確かめる。
    4. 評価が早まったメール。そのペアの「P＋24時間以前に終わる最後の1分足」の終わりが、min（P＋24時間、P の後の最初の GMO の週末の始まり）より60分以上前のもの。
       - GMO の週末の始まりは、金曜 20:00 UTC（米国の夏）・21:00 UTC（冬）。`nyOffsetMs` で決める（作り物の `synthOpen` と同じ区切り。§8.102）。
       - 12/25・1/1 などの GMO の休みや、足の長い欠けで、評価が早まったメールが当たる。値段は見ず、足の時刻だけで決まる。
       - 木曜の夜の P は、評価が週末の始まりで切れるだけなので、当たらない（夏の木曜 21:10 UTC の P も当たらない）。
       - 2023年は当たらない見込み（2023-12-25 は月曜で、その前の日曜の夜は足が無い）。
    5. （避けたメールだけ）同じますに、数えた残したメールが1通も無い。
    - 1〜4 に当たらないメールを「数えたメール」とよぶ。5 に当たらない避けたメールを「そろえた避けたメール」とよぶ。
    - x・Δ・区間・件数・そろえたかの判定は、数えたメールだけで作る。ますの残したメールの平均も、数えた残したメールだけで出す。
    - 金曜を外す理由:
      - 1日後の値は週をまたがない（P＋24時間以前に終わる最後の1分足で評価する）。金曜の P は、週の終わりのため、評価までの時間が3〜24時間短い。
      - 避ける枠が NY の日替わりのあたり（夏 21時台・冬 22時台の見込み）なら、そこに金曜の P は無い（GMO は金曜の 20:00〈夏〉・21:00〈冬〉UTC に止まる）。
      - そのため、金曜を入れると、残したメールにだけ評価の短いメールが混ざる。
      - 損切りが無く、利確で10 pips に止まる形では、評価までの時間が長いほど、トレンドに逆らう取引の損が大きく出る。すると、避けたメールが悪く出る向き（ルールが効くように見える向き）にずれる。
    - 評価が早まったメールを外す理由: 金曜と同じ。休みの夜は足が無く、避ける枠にメールが出ない。そのため、評価の短いメールが、残したメールの側にだけ入る。
    - 木曜の夜の P（夏 20:00、冬 21:00 UTC より後）も、評価までの時間が最大3〜4時間短くなる。それでも外さない（仮定: このずれは小さい。7 の (4) の作り物のトレンドの組で確かめる）。
  - 1日後の値 v（主。pips、合図の向き）:
    - P＋24時間までに利確の足が終わっていれば、利確の損益。
    - 入っていて利確していなければ、P＋24時間以前に終わる最後の1分足の中値の終値（売値と買値の終値の平均）で評価した損益。
    - 入っていなければ0。
    - §8.102 の `valueAt` との違いは、評価の値段（`valueAt` は決済する側）だけ。入りと利確は、これまでどおり売値と買値で追う（スプレッドはそこで効く）。
    - 中値にする理由:
      - 避けたメールは、評価の時刻（P＋24時間）も次の日の広い時間に当たる。
      - 決済する側の値段で評価すると、まだ持っている取引だけが、そのスプレッドの半分（ドル円の日替わりなら約6 pips の見込み）悪く出る。
      - オーナーはその時刻に決済しないので、これは測り方で生まれる差で、ルールが効く向きに出る。
      - 中値なら、入りと利確で払うコストは v に残り、評価の時刻の広さは入らない（仮定: 広い時間の中値はゆがんでいない）。
  - 主の数字 差 Δ（1つだけ。pips）:
    - ます ＝（T の週〈日曜 21:00 UTC の区切り、`weekOf`〉・ペア・向き）。
    - そろえた避けたメール1通ずつ、x ＝ その v −（同じますの、数えた残したメールの v の平均）。Δ ＝ x の平均。
    - Δ が0より下なら、避けたメールの方が悪い（ルールが効く向き）。
    - 同じますに数えた残したメールが1通も無い避けたメールは使わない（件数を出す）。
    - 週・ペア・向きでそろえる理由:
      - 約8週の間に、ペアごとの上げ下げは週ごとに変わりうる。
      - 避けたメールと残したメールで、週・ペア・向きの混ざり方が違うと、時間帯ではなく相場の上げ下げの差が Δ に混ざる。
      - 同じ週の中でそろえれば、その分が消える。
  - 区間: x を T の週でまとめた、t(C−1) の両側95%区間（`clustered`・`intervalOf` の週の行）。C は、そろえた避けたメールのある週の数で、2023年は最大8。
    - x は同じ週のメールだけで決まり、v は週をまたがない。そのため、週どうしは重ならない（仮定: 週をまたいだつながりは無い）。
    - 確かめとして、v の期間（P から評価の足まで）が T の週の外に出た件数を出す。0件でなければ、区間で決めずに止める（§8.102 の③と同じ）。
    - 4週ごとのまとまりは使わない（2か月では2つしか無く、区間が作れない）。§8.102 の「2つのうち低い方」とは、ここが違う。
    - 週が少ないので、区間は近似。7 の (4) の作り物で、外れの割合を確かめる（外れすぎれば99%に替える。7 の (4)）。
  - 足りる数: そろえた避けたメールが30通以上で、それがある週が5週以上。
  - 見込み（どれも数えていない）:
    - (a) の合図は 9,510件・約143.7週で、開いている1時間あたり約0.56件。
    - 2023年の数えるメールは約400件。
    - 避ける時間が1日1時間なら、避けたメールは約20通。2時間なら約40通（メールが時刻に一様とした場合）。
    - 30通に届かないこともありうる。
  - 書く文（先に決めた。上から当てはまる1つを書き、続けて「どの場合も」の文を書く）:
    - 数が足りない: 「2023年11〜12月では、避けた時間帯のメールが __ 通（__ 週）で、決めた数（30通・5週）に届かない。このデータでは、ルールが効くかは言えない」。
    - 区間の上の端が0より下: 「2023年11〜12月（ルールを決めたときに見ていないデータ）では、避けた時間帯のメールは、同じ週・同じペア・同じ向きの残したメールより、P から1日後の値が1通あたり __ pips 悪かった（95%区間 __〜__ pips。避けた __ 通・__ 週）。1日後の時点の比べで、利確まで持った最後の損益の比べではない。時刻の違うメールどうしの比べなので、スプレッドのせいか、その時刻のほかの性質のせいかは分けられない」。
    - 区間の下の端が0より上: 「2023年11〜12月では、避けた時間帯のメールの方が、1日後の値が1通あたり __ pips 良かった（95%区間 __〜__ pips。__ 通・__ 週）。このルールは、良いメールを外す側だった」。
    - それ以外: 「2023年11〜12月では、避けた時間帯のメールが悪いとも良いとも言えない（差 __ pips、95%区間 __〜__ pips。__ 通・__ 週）。区間（__〜__ pips）の中のどの差も、このデータと合う。1通あたり __ pips（区間の端のうち、0から遠い方）くらいの差があっても、この数では見分けられなかったことがありうる。差が無いという意味ではない」。
      - 「見分けられる最小の差」は書かない。docs のこれまでの「見つけられる最小の差」は、その差が本当にあれば10回に8回は見つかる大きさ（標準誤差×2.8）で、区間の幅の半分（t × 標準誤差）はその約 1/1.4 しかないため（2023年の t(7) で、約8割で見つかる大きさは幅の半分の約1.38倍）。
    - どの場合も:
      - 平均と合計:
        - 「数えたメールのうち、避けたメールは __ 通（うち、そろえた __ 通）で、1日後の値の平均は __ pips（合計 __ pips）。残したメールは __ 通で、平均 __ pips。この2つの平均は、週・ペア・向きをそろえていないので、相場の上げ下げの差が混ざる。判断は Δ で行う」。
        - 続けて「このデータで避けると（そろえずに数えると）、1通あたりの平均は __ pips から __ pips に〈上がり／下がり／変わらず〉、合計は __ pips〈増える／減る〉」と書く。〈〉は数から決まる方を書く。前の数は数えたメールすべての平均、後の数は残したメールの平均。
        - 避けたメールの平均が0より上なら、この文の前に「避けたメールも、平均では1日後に勝っていた」と書く。
      - 1日以内の勝率:
        - 「1日以内の勝率（数えたメールのうち、P から1日以内に入った取引で、1日以内に利確した割合）: 避けたメール __%（__ 件中 __ 件。1回あたり __ pips。1日の時点でまだ持っている __ 件、1日以内に入らなかった __ 件）、残したメール __%（同じ形）。損切りが無いので、作りの上で高く出る。ルールが効く証拠でも、この持ち方がうまくいく証拠でもない」。
        - 1回あたりは、勝率の分母と同じ取引（P から1日以内に入った取引）の v の平均。
      - 2023年のスプレッド:
        - 「2023年の、避けた枠のスプレッドの中央値は __ pips、残した枠は __ pips（ペアごと）」。
        - 数え方: 足の始まりが [START, END) の、`loadM1` が残す1分足を使う。ペアごとに、避けた枠（冬）のすべての1分足の s をまとめた中央値と、残した枠のすべての1分足の s をまとめた中央値を出す。避ける枠の無いペアは「避ける枠なし」と書く。
        - 避けた枠をまとめた中央値が、そのペアのしきい値（2024〜2026年から決めた値）より下なら、「〈ペア〉では、2023年のこの時間は、ルールを決めた 2024〜2026年ほど広くなかった」と添える。
        - 枠ごとの中央値は、表に並べるだけ。
      - 口座（参考）: 「30万円の口座（§8.102 の判断の道筋の作りで、START から END まで）: ルールなし __ 円・ロスカット __ 回・期限の決済 __ 回・上限で入金し切れなかった追証 __ 回、ルールあり __ 円・__ 回・__ 回・__ 回（入金を引いた損益）。入れたお金の合計 __ 円・__ 円、置けた割合 __%・__%（ルールで注文しなかった __ 件は、置けなかったメールと分けて数える）、勝率 __%・__%（1回あたり __・__ pips、__・__ 円。終わり方の件数も）。1本の道筋で約8週だけなので、幅は付けず、判断には使わない」。
      - 結びの文: 「これは約8週（すべて米国の冬時間。感謝祭と年末を含む）・GMO の値段・P から1日後の値での結果。楽天での成績や、口座が増えるかを確かめたものではない。ドル円の 2023年11〜12月は、§8.96（ゴトー日）で一部を見たデータ。ルールを使っていく確かめは (b) で行う」。
  - 並べる数字（判断には使わない。幅は付けない）:
    - 数えなかったメールの件数。上の理由の順で、1通を1つの理由にだけ数える。評価が早まったメールは、日付も出す。1,000本より少ない枠に P が入ったメールの件数も出す。
    - ペアごと・週ごとの、避けたメールと残したメールの件数。
    - 決済する側の値段で評価した v での、同じ Δ（点だけ。区間は付けない）。「決済する側で評価すると、避けたメールは、評価の時刻の広がりの分だけ悪く出る作り」と添える。
    - ドル円を除いた4ペアだけの Δ（点だけ。区間は付けない）と、そのそろえた避けたメールの件数。「ドル円の 2023年は §8.96 で一部を見たデータなので、それを除いた数字」と添える。
  - 見る数字を絞る:
    - 2023年の run は、すべての確かめと Python が通った後に、この節に書いた数字だけを print.txt に書く。
    - print の項目は、プログラムに書いた「出してよい項目」の一覧と照らす。ほかの項目があれば、何も出さずに止まる。
    - analysis.json の全体・dump・Python の pycheck.json は、成果物にもログにも出さない。sha256 だけをログに出す。
    - Python の食い違いは、項目の名前と件数だけを出す（`--quiet`）。
    - 成果物は、print.txt と `ultra15-2023.csv` だけ。
    - ③の数字（合図と逆向きの比べ）・E* の値・スワップ込みの行など、この節に書いていない数字は出さず、読まない。#207 ③ で、2023年11〜12月をまだ見ていないデータとして使える余地を残すため。使うかは③で決める。この節で見た数字は、③では見た数字として扱う。
  - 記録: 確かめがすべて通った run から、メールごとの値を `research/ledger/ultra15-2023.csv` として commit する（合図の向きだけ）。
    - 列: T・ペア・向き・P・季節・枠・避けたか・数えたか・数えなかった理由・v〈中値〉・v〈決済する側〉。
  - 数字の後の調べ（結果によらず、毎回同じ項目を行う。何を調べたかを書く）:
    - 件数を照らし合わせる。すべてのメール ＝ 数えたメール ＋ 理由ごとの数えなかったメール。数えたメール ＝ 避けた ＋ 残した。数えた避けたメール ＝ そろえた ＋ 同じますに残したメールが無い。
    - 先読みの確かめ（`lookAheadPaths`・中値の v・`lookAheadAccount`・`signalCut`）の、比べた数と食い違いの数を読み直す。
    - 手の例が、この run と同じ commit で通ったことを読み直す。
    - 避けたかの判定が、Python が P だけから作り直した判定と全件一致したことを読み直す。
    - 1日以内の勝率の分母と分子を、終わり方の件数と照らす。
    - 次のどれかに当たったときは、そのことも書く。1日以内の勝率のどれかが100%。|Δ| が10 pips（利確の幅）を超えた。区間が0をまたがない。調べる項目は同じ。CLAUDE.md の「100%に見えたら、まず先読みを疑う」は、この毎回の調べで満たす（§8.84・§8.102 と同じ）。
    - 数字を読んだ後に、プログラムの誤りが見つかって直したとき:
      - 最初の run の数字と文は、そのまま残す。
      - 直した後の数字と文は、その隣に並べ、「数字を見た後に直した」と書く。
      - 直したことで書く文が変わったときは、そのデータを「まだ見ていないデータ」での確かめとして数えない。6 の2つを合わせた文は、もう一方のデータだけで書く。
      - 段1のファイルは、2023年の数字を読んだ後に誤りが見つかっても、2023年の確かめについては替えない。替えたファイルは、6 の R を置き直した後の (b) でだけ確かめる。
    - (b) の比べる run でも、同じにする。

- **6. これからのメール（(b)）で、もう一度確かめる**:
  - 数えるメール: `research/ledger/ultra15.csv` の行のうち、sentAt が R 以後のもの。
    - R ＝ この決まりを main にマージした時刻（UTC）の後の、最初の 00:00 UTC（docs に書く）。R より前の行は、件数だけ出して使わない。
      - **R ＝ 2026-10-08 00:00 UTC**。この決まりは PR #175 で、2026-10-07 10:24:27 UTC に main にマージした（merge commit d0a4002）。
    - R にする理由:
      - ルールの決め方はこの決まりで固まり、枠は 2024〜2026年のスプレッドだけで決まる。
      - R の後に送ったメールは、決め方を決めた後のメールなので、「まだ見ていない」とはっきり言える。
      - R より前は約2日分（2026-10-07 の時点で13行）で、外しても数はほとんど減らない。
    - R の置き直し:
      - この決まりの決め方を、マージの後に1か所でも変えたら、R を置き直す。決め方とは、枠の決め方・数え方・基準・判定する時刻・数えるメール・Δ と区間の作り・比べる時。3 の止める条件で決め方を変えるときや、見直しで直すときも含む。
      - 新しい R は、変えた決まりを main にマージした後の最初の 00:00 UTC とし、docs に書く。それより前の行は、件数だけ出して使わない。
      - プログラムの誤りを直しただけで、決め方が変わらないときは、R を変えない。
      - 2023年11〜12月は、その時までに 2023年の値段を読んでいなければ、新しい決め方でもそのまま使う。読んだ後なら、新しい決め方の確かめには使わない。
  - そのうち、5 と同じ順で数えなかったものを除いたものを数える。除くのは、道筋が「何もしない」・金曜の P・P＋24時間 ＞ END_b・評価が早まったメール。
    - P・季節・枠・v・ます・Δ・区間・足りる数は、2023年と同じ。
    - 2026-11-01 の夏時間の終わりの前は夏の枠、後は冬の枠（P で決める）。
    - 評価が早まったメールは、2026-12-24（木）・2026-12-31（木）などに出る見込み（12/25・1/1 は GMO が休み）。
  - 毎週の run:
    - ② の出力は5つだけ。そろえた避けたメールの件数、それがある週の数、残したメールの件数、足りる数（30通・5週）に届いたか、比べる run かどうか。
    - TS と Python が、この項目の一覧と照らし、ほかの項目があれば失敗にする。
    - Δ も、避けたメールと残したメールの値も出さない（何度も見ると、偶然の外れが混ざるため）。
    - §8.102 の (b) の毎週の出力を、避ける枠で分けて見ることもしない（見てしまったら、そう書く）。
    - ② の出力は、§8.102 の (b) の書き出しとは別のファイル（例 `b/costhours.json`）に書く。(b) の `analysis.json`・`checks.json` には足さない。
    - 段1のファイルの sha256 の定数が空の間は、② の行を出さない（7 の (0)）。
  - 比べるのは1回だけ:
    - 比べる run は、そろえた避けたメールが初めて100通以上になった END_b の run（END_b − 7日では100通未満だった run）。
    - END_b ＝ 2027-03-13 00:00 UTC（土。米国が夏時間に変わる前の最後の土曜）の run までに100通に届かなければ、その run で比べる。そのとき30通・5週に足りなければ「数が足りない」。
    - 比べた後の run では、「② の比べは END_b ＝ __ の run で済んだ」とだけ出す。
    - 100通にする理由:
      - 2023年の見込み（約20〜40通）の数倍で、見分けられる差が小さくなる。
      - 避けたメールは、週に約3通（避ける時間が1日1時間のとき）〜約6通（2時間）の見込み。比べる run は、2027年2月ごろか締め切りになる見込み（数えていない）。
      - 締め切りを置くのは、いつまでも待つことと、都合の良い時に止めることを防ぐため。
  - 書く文: 2023年と同じ4つの文から1つと、「どの場合も」の文を書く。
    - 「2023年11〜12月では」を「これからのメール（R〜END_b）では」に替える。
    - 口座の参考は、R 以後のメールだけで、30万円から始めた口座（ルールなし・あり）。
    - スプレッドの確かめは、その期間の足（足の始まりが [R, END_b) の1分足。季節は足ごとに決める）で行う。
    - ドル円の但し書きは付けない。
  - 2つを合わせた文（両方が出た後に書く。2つの区間や数は合わせない）:
    - 両方で「悪かった」: 「まだ見ていない2つのデータ（2023年11〜12月と、これからのメール）の両方で、避けた時間帯のメールは、残したメールより P から1日後の値が悪かった（2023年 __ pips、これから __ pips）。GMO の値段・1日後の値での話で、楽天での成績や、口座が増えることを確かめたものではない。2023年のドル円は、一部をすでに見たデータ。使うかはオーナーが決める」。
    - どちらかで「良かった」: 「〈どちら〉では、避けた時間帯のメールの方が良かった。このルールが効くとは言えない」。
    - それ以外: 「このルールが効くとは言えない（2023年は〈文〉、これからのメールは〈文〉）。差が無いという意味ではない」。
    - どの場合も、「勝率が上がる」とは書かない（比べたのは1日後の値）。
    - 5 の「数字の後の調べ」で、どちらかのデータが「まだ見ていないデータ」での確かめにならなくなったときは、もう一方だけで書く。
  - これは §8.102 の (b) の比べる窓とは別の比べで、どちらも相手を変えない。

- **7. データを読む前の確かめ**:
  - 方針:
    - §8.102 の道具を使い回す。新しく書くのは、段1のプログラム、メールの判定、評価が早まったメールの判定、中値の v、Δ と区間、口座のルールの行、Python の計算し直しだけ。
    - 満たさなければ、実データに進まない。
    - 外れたら、プログラムの誤りを探す。見つかれば、決まり・種・幅を変えずに直して走らせ直す。見つからなければ、止めてオーナーに報告する（§8.102 と同じ）。
  - (0) 走らせ方と、決まる前の枠で実データが走らない作り:
    - `costhours.yml` は、push では作り物の確かめ（下の (1)〜(10)）だけを走らせる。
    - 段1の実データは、dispatch の入力 `stage1=yes` でだけ走る。2023年の実データは、別の入力 `y2023=yes` でだけ走る。1つの run で両方は走らない。
    - 2023年の mode と、(b) の毎週の ② の行は、プログラムに書いた `spread-hours.csv` の sha256 の定数とだけ比べる。環境変数や入力では上書きできない。
    - 定数は、段1のファイルを commit するまで空にしておく。空なら、2023年の mode は GMO を読む前に止まる。(b) の毎週の run は、② の行を出さずに、§8.102 の (b) だけを続ける。
    - 作り物の確かめは、別のパスに置いた仮のファイル（例 `research/out/costhours/provisional.csv`）を使い、作り物の mode だけが読む。仮の枠は、5ペアとも夏 21:00〜21:59・冬 22:00〜22:59 UTC（NY の17時台）。`research/ledger/spread-hours.csv` には書かない。
    - キャッシュ:
      - 段1は、共有のキャッシュ（`gmo-1min-*`）を戻してよい。2 のとおり鍵の一覧のファイルだけを開くので、中にある期間の外のファイルは開かない。保存は、専用の鍵（`gmo-spread-*`）だけにする。
      - 2023年は 5 のとおり、専用の鍵（`gmo-2023-*`）だけを使う。
  - (1) 段1の作り物:
    - §8.102 の `synthesize` に、時刻で決まるスプレッドを足せるようにする。中値の動きは今のまま。足さないときの書き出しは今と同じ。休みの日は無し。
    - 2024-01-01〜2026-10-03 の5ペアを GMO の日のファイルにし（`writeGmoFiles`）、本番と同じ読み込みで読む。
    - ふだんのスプレッドは、今の作り物の値（ドル円 0.2 pips など）。
    - 仕込む枠:
      - 夏 21:00〜22:44 UTC・冬 22:00〜23:44 UTC に ＋12 pips（NY の日替わりに付く形。入る）。
      - 中央値がちょうどしきい値の枠（入る）と、それより 0.1 pips 下の枠（入らない）。
      - 3 × base は越えるが 1.0 pips に届かない枠（ドル円。入らない）。1.0 pips は越えるが 3 × base に届かない枠（ふだんの広いペア。入らない）。
      - 金曜だけ ＋20 pips 開く枠（金曜に開いている時刻で。入らない）。まれに大きく開いて、平均だけがしきい値を越える枠（入らない）。
    - 前もって書いた避ける枠の一覧と、プログラムの答えが、ペア・季節・枠のすべてで一致すること。
  - (2) 段1の Python（`research/spreadhours-check.py`）:
    - 季節は `zoneinfo` の America/New_York で、TS とは別に出す。
    - 鍵の一覧を自分で作り、その GMO の日のファイルだけを開く。
    - 次が、作り物と実データの両方で、全件ちょうど一致すること。枠ごとの本数・中央値・base・しきい値・避けるか、開いた鍵の最小・最大、残した足の時刻の最小・最大。中央値は 0.1 pips の整数かその半分なので、ちょうど比べる。平均と90%点は 1e-9 以内。
    - 実データでは、一致を確かめてから、ファイルを書く。
  - (3) 手の例（TS と Python が、先に書いた答えと一致すること。避けたかは仮の枠で決める）:
    - (b) で P が楽天の止まる時間に入り、枠が変わるメール。
      - 2026-10-12（月。夏時間）20:53:30 UTC に送り、P が 20:55 から 21:10 に動き、枠が 20:45（枠83）から 21:00（枠84）になる。
      - §8.102 の bsyn の「難しい始まり」と同じ形を、R の後の日に置き直したもの。
      - 答え: 季節は夏、枠は 21:00、避けたメール、数えたメール（月曜。この手の例では R を 2026-10-08 とする）。
    - 夏冬の切り替わりをまたぐ P（2026-10-29〈木〉と 2026-11-02〈月〉）。
    - 週明けの最初の合図（日曜 22:15 UTC の確定、P 22:17）。
    - 金曜の P。主の数字には数えない。口座のルールの行では判定する。
    - 評価が早まったメール（12/25 を閉じた作り物の足で）:
      - 2026-12-24（木）の P。数えない。
      - 2026-12-23（水）21:30 UTC の P。評価が30分早まるだけなので、数える。
      - 夏の木曜 21:10 UTC の P。評価が週末の始まりで切れるだけなので、数える。
    - END を水曜 00:00 にした手の例。火曜 12:02 UTC の P で、P＋24時間 ＞ END。「P＋24時間が END より後」で数えない。
    - 同じますに残したメールが無い避けたメール。使わずに数える。
    - 入っていて利確していない取引の P＋24時間が、広さを仕込んだ枠に当たる形。決済する側の値が、中値の値より広さの半分だけ悪いこと。主の v が中値の値になること。
    - 避けたメールの v から5 pips を引くと、Δ と避けたメールの平均がちょうど5 pips 下がり、残したメールの平均は変わらないこと。
  - (4) 区間の作り物（効果なし）:
    - 2023年と同じ暦（START〜END）の作り物の値動き。12/25 は、作り物の休みのオプションで足を作らない。
    - 15分足は、本番と同じく 2023-10-27 00:00 UTC から読む（`dataSetOf` と同じ）。
    - スプレッドは一定（今の作り物と同じ）で、合図に力は無い。
    - 避ける枠は、段1で決めた冬の枠。段1の前は、(0) の仮の枠でプログラムを確かめる。
    - 乱数の種 1〜100（走らせる前に変えない）を、3組で回す。トレンドなし・1分足1本あたり 0.01 pips・0.03 pips（向きは §8.102 の確かめ A と同じ）。
    - 作り物では足りる数を当てず、どの種でも Δ と区間を出す。
    - 線1（区間の外れ）: 各組で、区間の上の端が0より下（「悪かった」）と、下の端が0より上（「良かった」）が、それぞれ100通りのうち7通り以下。
      - 正しい区間なら1通りあたり約2.5%で、8通り以上になるのは約0.4%（3組の両側の6つのどれかで外れるのは約2%）。
      - 区間が本当は片側で10%外れるなら、1つの数えにつき約8割の見込みで見つかる。
    - 線2（Δ の平均）: 各組100通りの Δ の平均が、0から 3.39（t(99) の両側99.9%点）×（100通りの標準偏差 ÷ 10）以内。ますと金曜の外し方が、トレンドのずれを消していることの確かめ。
    - 区間の外れが7通りを超えたとき:
      - プログラムの誤りが見つからなければ、2023年と (b) の判断に使う区間を両側99%に替え、同じ100通りで確かめ直す（作り物だけを見て決める）。
      - 99%のときの線は、片側の外れがそれぞれ100通りのうち3通り以下。正しい区間なら1通りあたり約0.5%で、4通り以上になるのは約0.2%。
      - Δ の平均の線は、95%のときと同じ。
      - それでも超えれば、止めてオーナーに報告する。
  - (5) 広さが効く作り物:
    - (4) と同じ種・トレンドなしの値動きを使う。段1で決めた冬の避ける枠だけ、中値はそのままで、売値と買値を ±6 pips 広げる（スプレッド ＋12 pips。§8.18 くらいの開き。合図と E は変わらない）。
    - 線: 100通りの Δ の平均が、0より 3.39 ×（標準偏差 ÷ 10）以上下にあること。広い時間に入った分の損を、この測り方が見られることの確かめ。
    - 出すだけのもの（判断には使わない。2023年の足を読む前に docs に書く）:
      - 「悪かった」と出た種の割合。この期間と件数で、§8.18 くらいの開きが見えるかの目安。
      - そろえた避けたメールの件数の中央値。
      - 決済する側で評価した Δ の平均。中値にしないと、どれだけずれるかの目安。
    - 作り物の値動きは、実際より裾が細く、変動の偏りも無い。そのため、実データではこれより見分けにくい見込み。
  - (6) (b) の比べる run の作り物:
    - R〜2027-03-13 の暦の作り物の値動き（12/25・1/1 は休みのオプションで閉じる）から、合図をメールにした作り物の ledger を作る（bsyn と同じ作り）。
    - END_b を3つ回す。END_b は、作り物の件数だけを見て選ぶ。
      - そろえた避けたメールが初めて100通以上になる END_b。
      - その1週前。
      - 締め切り（2027-03-13）。
    - 仮の枠を2つ使う（どちらも作り物の mode だけが読み、`research/ledger/spread-hours.csv` には書かない）。
      - 100通に届く END_b とその1週前は、(6) 用の広い仮のファイルで作った作り物で回す。広い仮の枠は、5ペアとも夏 18:00〜21:59・冬 19:00〜22:59 UTC（1日4時間。(0) の1時間を含む）。
      - 締め切りは、(0) の仮のファイル（1日1時間）で作った作り物で回す。
      - run の中で次を確かめ、違えば失敗にする: 広い仮のファイルでは、100通に届く END_b が締め切りより前にあり、その1週前は100通未満。(0) の仮のファイルでは、締め切りまで100通に届かない。
      - 見込み: 見直しのエージェントが作り物（bsyn と同じ作り、種 1・2・3・7）を R〜2027-03-13 で数えたところ、1日1時間の仮の枠では、そろえる前の避けたメールが種ごとに 56〜72通だった（そろえた後はさらに減る）。1日4時間なら、その約4倍の見込み（数えていない）。
    - TS と Python で、次が一致すること。件数・比べるかどうか・比べる run の Δ と区間・評価が早まったメールの件数。
  - (7) 段2の Python（`ownerhold-check.py` に足す）:
    - `spread-hours.csv` を自分で読み、sha256 も確かめる。日のファイルは、鍵の一覧のものだけを開く。
    - 次が、作り物と実データの両方で全件一致すること。
      - メールごとの P・季節・枠・避けたか・数えたか・数えなかった理由。
      - v（中値と決済する側）・ます・Δ・区間・件数・外した数。
      - 1日以内の勝率と1回あたり。
      - ルールの行の口座。
    - (b) では、毎週は件数と足りる数と出力の項目を照らす。比べる run では、Δ と区間も照らす。
  - (8) 先読みの確かめ:
    - 避けたかどうかは、P の時刻と固定したファイルだけで決まる。値段を渡さない作りにし、Python が P だけから作り直す。
    - 評価が早まったかは、足の時刻だけで決まる（値段を渡さない）。
    - 中値の v を、§8.102 の先読みの確かめ（`lookAhead`。P＋24時間で切り、その後の足を書き換えても値が変わらない）に入れる。ルールの行の口座も `lookAheadAccount` に入れる。
    - 段1の run と 2023年の run が、期間の外の足を読まないことを、開いた鍵と残した足の時刻で確かめる（2・5）。
  - (9) 仕込んだ誤り:
    - わざと誤りを入れた版で、どれかの確かめが食い違いを出すこと。
    - 次のどちらかがあれば、実データに進まない（§8.102 と同じ）。どの確かめでも見つからない誤り。変わった数が0の誤り。
    - 段1に仕込む誤り:
      - 中央値でなく平均で決める。
      - 夏冬を分けない。
      - ≧ でなく ＞ で決める。
      - base を平均にする。
      - ドルのペアを円のペアの単位で数える。
      - 2024年より前の足を1本残す（止まること）。
      - 鍵の一覧の外の日のファイルを開く（TS・Python とも、開いた鍵の確かめで止まること）。
    - 段2に仕込む誤り:
      - 合図の足の始まり（T−15分）の枠で判定する。
      - 主の v を、決済する側の値段で出す。
      - ますに週を入れない。
      - 金曜の P も数える。
      - 祝日で評価が早まったメールも数える。
      - ますの残したメールの平均に、数えなかったメール（金曜の P など）を入れる。
      - P＋24時間が END より後のメールを入れる（END を水曜にした手の例だけで数える）。
      - END より後の足を1本読む（止まること）。
      - 4週のまとまりで区間を作る。
      - ルールの行で、避けたメールも注文する。
      - ルールのファイルの1枠を変える（sha256 で止まること）。
      - 仮のファイルを本番のパスに置く（sha256 で止まること）。
      - 定数が空のまま 2023年の mode を起動する（GMO を読む前に止まること）。
      - ③の d を print に出す（出してよい項目の確かめで止まること）。
      - (b) で毎週 Δ を出す（毎週の出力の項目の確かめで止まること）。
      - (b) で、100通以上の run のたびに比べる。
      - (b) で締め切りを無視する。
  - (10) (a) と (b) が変わらないこと:
    - 足す前と後で、次の sha256 がすべて同じ。(a) の作り物と手の例の書き出し。(b) の bsyn の書き出し（§8.102 の (b) を足した時と同じ確かめ）。
    - そのため、作り物の休みの日はオプション（初めは無し）にし、(a) と bsyn は休み無しのまま走らせる。
    - ② の出力は、別のファイルに書く（6）。
  - (11) 2023年の実データの run の中の確かめ（1つでも外れたら、数字を出さない）:
    - §8.102 の (a) の実データの確かめ14のうち、tf-winrate との照合（`tfWinrate`）を除く13を行う。
      - `loads`。
      - `signalProbe`（`indicatorSignals` との見本の照合。遅れた合図の照合〈probeLate〉を含む）。
      - `signalCut`（すべての足の合図の先読みの確かめ）。
      - `lookAheadPaths`・`tpAfterEntryPaths`・`engineVsPaths`・`tpAfterEntryAccount`・`lookAheadAccount`。
      - `estar`（値は出さずに、通ったかだけ）。
      - `swapNights`・`swapRule`・`swapAgain`。
      - `dOutside`（通ったかだけ）。
    - 加えて行う確かめ:
      - 5 の「2024年の足を読まない」確かめ（TS と Python の、開いた鍵と残した足の時刻）。
      - `noWindow` が0。
      - `spread-hours.csv` の sha256。
      - v の期間が週の外に出た件数が0。
      - 中値の v の先読みの確かめ。
      - Python の ② の部分の全件一致。
    - tf-winrate を2023年で走らせない理由:
      - 合図の作りは (a) と同じプログラムで、(a) で一致した。
      - 2023年では、§8.102 の B(2') のうち、この run の中の見本の照合（`signalProbe`）と `signalCut` だけを行う。
      - tf-winrate の JSON との照合と、5分足の読み込み（`reproduce`）は行わない（5分足は読まない）。
  - (12) 見直し: この決まりと、プログラムに、それぞれ1回、独立した見直しをかける（Claude の Workflow。指摘ごとに反論を試み、反論できなかったものだけを直す）。

- **8. 限り**:
  - 値段は GMO で、楽天ではない。
    - ルールは GMO のスプレッドで決め、GMO の足で確かめる。楽天の時間ごとのスプレッドは測っていない。
    - 楽天の広告では、ドル円は 2025-03-06 から日本時間3〜9時が 3.8銭（§8.99）。GMO の広い時間より長く広い見込み。このルールは、楽天の広がりに合わせていない。
  - 2023年は約8週（11/8〜12/29）だけ。
    - すべて米国の冬時間。夏の枠は、(b) の 2026-11-01 までの約3週半でしか確かめない。
    - 感謝祭と年末（12/25 の休みと薄い週）を含む。
  - ドル円の 2023年11〜12月は、別の問い（ゴトー日、§8.96）ですでに使ったデータ（夜の窓の値動きと、2023年を含む時刻ごとのスプレッド）。4ペアだけの Δ を、点で並べるだけ。
  - 2023年の合図は計算し直したもので、送ったメールではない（15分足の ULTRA のメールは 2026-10-05 から）。P＝T＋2分は §8.102 の仮定のまま。
  - ルールは 2024〜2026年のスプレッドから決め、それより前の2023年に当てる。
    - 成績は見ていないが、「その時にこのルールを使っていたら」の確かめではない。
    - GMO の広がり方が2023年と違えば、ルールは2023年の広い時間に合わない（そのため、2023年の枠ごとのスプレッドも並べる）。
  - 主の数字は、メールごとの P から1日後の値（まだ持っているものは中値で評価）。
    - オーナーの実際の終わり方（利確まで持つ）の、最後の損益ではない。損切りも期限も無いので、1日後に負けていても、その後に利確するかもしれない。
    - 口座は1本の道筋で、幅を付けない。
  - Δ は、時刻の違うメールどうしの比べ。差が出ても、スプレッドのせいか、その時刻のほかの性質（値動きの癖など）のせいかは分けられない。
  - 中値の評価は仮定。広がりが片側に寄っていれば、中値もゆがみ、その分は残る（測っていない）。
  - 主の数字に入れないもの: 金曜の P のメール。祝日などで評価が60分以上早まったメール。木曜の夜の P は、評価までの時間が少し短いまま入れる。
  - 週のまとまりが少ない（2023年は最大8）ので、区間は近似。作り物で確かめるが、作り物は実際の裾の太さや変動の偏りを持たない。
  - スプレッドは、1分足の終値の1点で数えた。1分の中の短い広がりは見ない。曜日・祝日・週明け・金曜の終わりは分けていない。週に1日だけ広がる時刻は避けない。
  - 合図の足が広い時間にあっても、P が後の枠なら避けない。ルールで変わるのは新しい注文だけで、持っている取引が広い時間をまたぐことは変わらない。
  - (b) は、送ったメールを GMO の足で追ったもので、オーナーの実際の約定ではない（§8.102 と同じ）。

- **この節で新しく置いた仮定と決め**（ここに無いものは、オーナーの答えか、§8.102 の決まり）:
  - 仮定:
    - GMO の広がりは、米国の季節の中では同じ時刻に来る（英国・欧州の切り替えのずれは見ない）。
    - 1分足の終値のスプレッドで、その1分を代表させる。売値と買値の終値は、同じ瞬間の値とする。
    - 2024〜2026年の時刻ごとの広がりの形が、2023年11〜12月と 2026-10 以後にも同じ（2023年は並べる数字で見るだけ）。
    - 広い時間の中値はゆがんでいない。
    - 週をまたいだつながりは無い。
    - 木曜の夜の評価の短さによるずれは小さい（作り物で確かめる）。
    - 週が少ないときの区間の近似（作り物で確かめる）。
    - GMO の週末の始まりは、金曜 20:00（夏）・21:00（冬）UTC（評価が早まったメールの決めに使う。§8.102 の作り物と同じ）。
  - 決め（データを見る前に選んだもの。一番良いかは確かめていない）:
    - UTC の15分の枠を、米国の夏冬に分ける。曜日で分けない。
    - 中央値。max（3 × base、1.0 pips）を、0.1 pips の2倍の整数で比べる。ペアごと。1,000本。32枠で止める。
    - 動かした後の P で判定する。中値で評価する。
    - 金曜の P を外す。評価が60分以上早まったメールを外す。数えなかった理由の順。
    - （週・ペア・向き）のますで、数えたメールだけを使う。
    - 週ごとの95%区間（作り物で外れすぎれば99%。そのときの線は片側3通り）。
    - 30通・5週。
    - START 2023-11-08・END 2023-12-30。15分足は 2023-10-27 から読む。窓がそろわないときの START の決め直し。
    - R と、その置き直し。100通か 2027-03-13 の早い方。
    - 数字を見た後の直しの扱い。
    - 実データの run の起動の仕方と sha256 の定数。段1のキャッシュ（共有を戻してよい）と、2023年のキャッシュ（専用）。

- **順番**（一つずつ、確かめてから次に進む。のぞき見を防ぐ順）:
  1. この決まりを docs に書く（§8.103 の下見の項の誤りの文も直す）。独立した見直しをかけて commit し、main にマージする（2024〜2026年の枠ごとのスプレッドも、2023年の値段も、読む前）。マージの時刻から R を決めて docs に書く。
  2. プログラムを書く（予定: `research/spreadhours.ts`・`research/spreadhours-check.py`・`research/costhours.ts`・`ownerhold.ts` の2023年の MODE・Actions の `costhours.yml`）。7 の (0)〜(10) を、仮の枠（(6) の広い仮の枠を含む）と作り物で、Actions の push の run で通す。独立した見直しをかける。
  3. 段1を実データで走らせる。
     - dispatch の `stage1=yes` で起動する。2024〜2026年の1分足だけを読む。ログに出すのは、スプレッドの表と確かめの結果だけ。
     - Python と一致した run の `spread-hours.csv` を commit する。避ける枠と sha256 を、docs と段2のプログラムの定数に書いてマージする。
     - 3 の止める条件に当たれば、ここで止めてオーナーに報告する（決め方を変えるなら、6 の R の置き直し）。
  4. 段1で決めた冬の枠で、7 の (4)・(5) を走らせ直し、結果を docs に書く（2023年の足を読む前）。
  5. 2023年の run。
     - dispatch の `y2023=yes` で起動する。
     - すべての確かめと Python が通った run の、5 に書いた数字だけを読む。5 の「数字の後の調べ」をして、先に決めた文を書く。
     - docs・PR・マージ・オーナーへの日本語の報告。
  6. (b) の毎週の run に、6 の件数の行を足す。
     - 比べる run で1回だけ Δ を出し、「数字の後の調べ」をする。
     - 2つを合わせた文を書いて、オーナーに日本語で報告する。
  - 原因を探すために、ここに書いていない数字を見たら、すべて「見てしまった数字」として docs に書く（§8.102 と同じ）。

- **見直し**（2026-10-07。この決まりの下書きに、Claude の Workflow で独立した見直しをかけた。3つの見方〈のぞき見・統計・作れるか〉で指摘を探した）:
  - 指摘は23件。うち3組は同じ中身（§8.96 との食い違い・R の置き直し・平均の文）。
  - Claude が、指摘ごとに docs とプログラムで確かめた。見たのは、ownerhold-data.ts の `keysOf`・`loadM1`・`synthOpen`、ownerhold.ts の `dataSetOf` と print、ownerhold-check.py の `read_side`、ownerhold.yml のキャッシュ、market-hours.ts の `isMarketClosed`。
  - どれも中身は本当で、すべて直した。
  - 直し方を、指摘から変えたもの:
    - 祝日で評価が早まったメール:
      - 指摘の決め方は「P＋24時間が週末の閉まる時間〈`barInsideClosure`〉の外」。`isMarketClosed` の金曜の閉まりは 22:00 UTC からなので、この決め方では、夏の木曜 21:00〜21:59 UTC の P を祝日と同じに外してしまう。この P は、GMO が金曜 20:00 に止まるので評価が60〜119分早まるが、ふつうの週末で、避ける夏の枠に入りそうな時刻でもある。
      - そこで、P の後の最初の GMO の週末の始まり（金曜 20:00〈夏〉・21:00〈冬〉UTC）で決めた。
    - 段1のキャッシュ: 共有のキャッシュを戻してよいとした。両方のプログラムが鍵の一覧のファイルだけを開くので、期間の外のファイルは開かない。約10,000の日のファイルを GMO から読み直さずに済む。2023年の run だけは、専用のキャッシュにした。
    - ドル円を除いた4ペアの Δ: 区間を付けず、点だけにした。決済する側の Δ と同じく、判断に使わない数字に区間を付けると、2つ目の比べになるため。
    - 作り物を 2023-10-27 から作る件: 作り物も本番も、15分足を START − LEAD15（2023-10-27 00:00 UTC）から読む（`dataSetOf`）。読む足は今も同じなので、変えない。
  - 直した後の全文は、Claude が読み直した。
- **2回目の見直し**（2026-10-07。直した後の下書きに、Claude の Workflow でもう一度、独立した見直しをかけた。3つの見方〈のぞき見・統計・作れるか〉で指摘を探し、指摘ごとに別のエージェントが反論を試みた）:
  - 指摘は13件。反論できず本当とされたのは3件で、3件とも直した。
    - 「前から知っていたこと」に §8.99 の時刻ごとの成績（夜中・00:00 UTC・20:00 UTC）と、00:00 UTC の払ったスプレッドが無かった。読んだ docs の一覧にも §8.99 が無かった（下調べ #208-1 で読んでいた）→ 足した。
    - 「それ以外」の文の「区間の幅の半分より小さい差は見分けられない」は、docs のこれまでの「見つけられる最小の差」（10回に8回見つかる大きさ）と同じ言い方で、約1.4倍小さい差まで見分けられるように読める → 区間に基づく文に替えた。
    - (6) の作り物は、1日1時間の仮の枠では締め切りまでに100通に届かない見込み（見直しのエージェントが作り物で数えた）→ (6) 用に1日4時間の広い仮の枠を置き、届くことを run の中で確かめる。
  - 本当ではないとされた10件（反論の理由を Claude が読んで、受け入れた）のうち、守りを固める案として次の3つは、プログラムを書くとき（順番 2）に取り入れるかを決める。決まりの文は変えない。
    - 2023年の y2023 の job に、同じ run の作り物の job への needs を付ける。
    - R・2023年の START・END を、TS と Python の定数にし、meta と照らす。
    - 2023年のメールごとの CSV をどの job からどう出すかを、プログラムで決める。
- **プログラム（順番 2、2026-10-07）**:
  - 書いたもの:
    - 段1（先に main に入れた）: `research/spreadhours.ts`・`research/spreadhours-lib.ts`・`research/spreadhours-check.py`、`ownerhold-data.ts` の作り物のスプレッドを足すオプション（`extraSpread`）。
    - 段2:
      - `research/costhours-lib.ts`: 値段を渡さない部分。P と固定したファイルだけで決める「避けたか」、数えなかった理由（上から1つ）、評価が早まったか（GMO の週末の始まり）、ます・x・Δ・週ごとの t(C−1) の区間、先に決めた文、出してよい項目の一覧、(b) の比べる run の決め方。R・2023年の START/END・開いてよい鍵・締め切り・段1のファイルの sha256 の定数（いまは空）を持つ。
      - `research/costhours.ts`: 足から出す部分。メールごとの P（止まる時間の後に動かしたもの）・P＋24時間以前に終わる最後の足・中値と決済する側の1日後の値・1日以内に入ったか・利確したか。中値の値の先読みの確かめ、v の期間が週の外に出た件数、ルールの行の口座、期間のスプレッド、print と `ultra15-2023.csv`。
      - `research/ownerhold.ts`: MODE=costhand（7 の (3)）・costsyn（(4)・(5) と、1つ目の作り物の全部の確かめ）・bcostsyn（(6)）・y2023（2023年の実データ）・y2023print。毎週の (b)（MODE=b・printb）に ② の行（定数が空の間は出さない）。
      - `research/ownerhold-trades.ts`: `valueAt` に中値での評価（既定は今までどおり決済する側）。
      - `research/ownerhold-data.ts`: 作り物の休みの日（`closedKeys`。既定は無し）と、15分足の600本目の時刻（窓がそろわないときにログに出す）。
      - `research/ownerhold-check.py`: ② の計算し直し（下）。
      - `research/costhours-hand.json`: 手の例と、先に書いた答え。
      - `.github/workflows/costhours.yml`: push で s1syn・s2hand・s2syn（3組）・s2b。dispatch の `y2023=yes` で y2023（s2hand・s2syn・s2b の後だけ。`stage1=yes` と同時は止める）。`ownerhold.yml` の毎週の job の Python に、TS が ② の行を書いたときだけ `--cost` を付ける。
  - 決まりの文に無く、プログラムを書くときに決めたこと:
    - 手の例の入力: E は、止まる時間の後に動かした P の足の、注文する側の始値（成行で入る）。利確は E ± 10 pips。持ったままの評価を見る例（held-wide）は利確を 1,000 pips にした。答えのファイルはプログラムを走らせる前に書いた。走らせた後に、入力を1つだけ変えた: 金曜の P の例（friday）の利確を 1,000 pips にした。どちらのメールも1日以内に利確して v が同じ +10 pips になり、仕込んだ誤り「ますの平均に数えなかったメールを入れる」が手の例で見えなかったため。答えは変えていない。
    - (6): 決まりの3つの END_b（100通に届いた END_b・その1週前・締め切り）に、「100通に届いた END_b の1週後（比べは済んだ、とだけ出す）」を足した。仕込んだ誤り「100通以上の run のたびに比べる」を見つけるため。
    - 仕込んだ誤り: 決まりの一覧に、「中値の値を1分後の足で評価する」（midAhead。中値の先読みの確かめが見つけること）を足した。
    - 2回目の見直しの「守りを固める案」3つは、すべて取り入れた。y2023 の job は、同じ run の s2hand・s2syn・s2b の後だけ走る。R・2023年の START/END・鍵の一覧は、TS と Python がそれぞれ定数で持ち、Python は dump の meta と照らす。2023年のメールごとの CSV は、すべての確かめが通った後に y2023print がログと成果物（print.txt と並べて）に出す。
    - (b) の口座の参考（比べる run だけ）は、R 以後のメールだけで、その最初の P（止まる時間の後に動かした P）から始める。
    - 段1のファイルが無い今は、2023年の mode は GMO を読む前に止まり（終了コード 3）、毎週の (b) は ② の行を出さない（「段1のファイルの sha256 が無い」とだけ出す）。
  - Python（`ownerhold-check.py` に足した。TS は読まずに、この節だけから書いた）:
    - 季節は zoneinfo の America/New_York。P・枠・避けたか・理由・評価が早まったか（GMO の週末の始まりも自分で出す）・中値と決済する側の v・ます・x・Δ・区間（t 分布の点も自分で出す）・1日以内の勝率・ルールの行の口座（§8.102 の Python の口座に「注文しないメール」を渡せるようにした）・期間のスプレッドを、自分で読んだ足から作り、TS の書き出しと全件照らす。
    - 2023年は、自分で作った鍵の一覧（1分足 20231106〜20231230、15分足 20231026〜20231230）のファイルだけを開き、開いた鍵の最小・最大を照らす。
    - 作り物の仮のファイルは、Python が自分で作ったものと1字まで同じかを照らす。本番の `spread-hours.csv` は、Python が持つ sha256 の定数（TS とは別に持つ。いまは空）と照らす。
    - 手の例は、Python が `costhours-hand.json` から自分で合図を作り（P0・止まる時間・E・利確）、答えと TS の書き出しの両方と照らす。
    - (b) では、ledger から自分で作ったメールで、END_b ごとの件数・比べる run かどうか・5つの出力（とその名前）を照らす。
  - 確かめた結果（すべて作り物と仮の枠。実データはまだ1本も読んでいない）:
    - 7 の (3) 手の例: TS と Python のどちらも、先に書いた答えのとおり（run A 17通・run B 2通）。5 pips を引く例も答えのとおり（Δ と避けたメールの平均がちょうど 5 pips 下がり、残したメールの平均は同じ）。TS と Python の書き出しも全件一致。
    - 7 の (9) 計算が変わる仕込んだ誤り（10個）は、どれも見つかった:
      - 手の例の答えが外れた数: 枠を合図の足の始まりで決める 25・決済する側の v 2・ますに週を入れない 3・金曜の P を数える 2・祝日で評価が早まったメールを数える 1・ますの平均に数えなかったメールを入れる 1・P＋24時間が END より後を数える 1・ルールの行で避けたメールも注文する 1・中値を1分後の足で評価する 1（中値の先読みの確かめも 10 件の食い違い）。4週のまとまりで区間を作る誤りは、手の例の答えには出ない（区間だけが変わる）。
      - Python との食い違い（手の例）: 10個とも出た（3〜65 件）。
      - Python との食い違い（2023年の暦の1つ目の作り物）: 枠を合図の足の始まりで 553・決済する側の v 12・週なしのます 507・金曜の P 182・数えなかったメールを平均に 19・4週のまとまり 3・ルールの行で避けたメールも注文 9・中値を1分後で 83。祝日と P＋24時間が END より後の2つは、2023年の暦では変わる数が0（この期間に当たるメールが無い。決まりの見込みどおり）で、手の例で見つかった。
    - 7 の (9) 止まる誤り: 定数が空のまま 2023年の mode を起動 → GMO を読む前に止まる（終了コード 3、「sha256 が書かれていない」）。ルールのファイルの1枠を変える・仮のファイルを本番のパスに置く → 止まる（同じファイルを自分の sha256 と照らすと読める、も確かめた。いまは定数が空なので、本番のパスの仮のファイルは「空」で止まる。段1の後は sha256 の食い違いで止まる）。③の d を print に出す → 出してよい項目の確かめで止まる。END より後の足を1本読む → 期間の確かめで止まる（5ペアの1分足・15分足など7件）。(b) で毎週 Δ を出す → 止まる。(b) で100通以上のたびに比べる・締め切りを無視する → 比べる run の判定が変わって見つかった。
    - 7 の (4)（仮の枠〈1日1時間〉、種 1〜100）: トレンドなし 悪い側 0・良い側 4（99%: 0・1）、Δ の平均 −0.68 ± 0.64。1分足 0.01 pips: 0・4（0・2）、−0.04 ± 0.69。0.03 pips: 2・6（0・2）、+0.34 ± 0.93。どの組も線1（片側7通り以下）と線2（平均が 3.39 × 標準誤差の内側）を満たした。区間は95%のまま。
    - 7 の (5)（仮の枠の冬の枠を 12 pips 広げる）: Δ の平均 −3.28 ± 0.66 で、線（−3.39 × 0.66 ＝ −2.24 より下）を満たした。出すだけのもの: 「悪かった」と出た種は100通りのうち2、そろえた避けたメールの件数の中央値 19、決済する側で評価した Δ の平均 −4.41。仮の枠での値。順番 4 で段1の冬の枠で走らせ直し、その値を書く。
    - 7 の (6): 広い仮の枠（1日4時間）では、そろえた避けたメールが 2026-12-19 の END_b で初めて100通以上（104通・11週）。その1週前（12-12、91通）は比べない、12-19 は比べる run、1週後（12-26）は「済んだ」とだけ出す。1日1時間の仮の枠は締め切り（2027-03-13）まで100通に届かず（51通・19週）、締め切りの run で比べる。評価が早まったメールは、12-26 の run で5通、締め切りの run で13通（12/24・12/31 の木曜など）。どの END_b も、件数・比べるか・比べる run の Δ と区間・評価が早まったメールの件数が、TS と Python で一致した。
    - 7 の (7): 2023年の暦の1つ目の作り物で、§8.102 の部分と ② の部分の全部（65,779 項目。② はメールごとの値〈ますを含む〉6,665・避けたかの判定 476・口座 27・スプレッド 6・まとめ 48・開いた鍵 10・足の時刻 20 など）が、TS と Python で一致した。
    - 7 の (10): 足す前（main の 0f9953a）と後で、(a) の手の例の書き出し（9,457 ファイル、仕込んだ誤り込み）と bsyn の書き出し（1,527 ファイル）の sha256 が全部同じ（手元と、Actions の job unchanged の両方）。(a) の作り物（1つ目の作り物を全部と、トレンドの2組の1つずつ）は、手元では時間の上限で止まり、比べ終わらなかった。Actions の job（unchanged の synthetic、run 37630580155）では 20,484 ファイルの sha256 が全部同じ。
    - Actions: costhours の run 37621766024（3524393）・37623414676（1e5f641）・37630580155（56bf935）、ownerhold の run 37621766039・37623414693・37630579420（同じ順）。56bf935 の2つの run は、どちらも全部の job が通った（costhours: inputs・s1syn・s2hand・s2syn 3組・s2b・unchanged 3組。ownerhold: fixtures・bsyn・third 3組・full 6組・plants。y2023・s1real・weekly などは、入力が無いので飛ばした）。
  - 独立した見直し（7 の (12)、2026-10-07。Claude の Workflow。5つの見方〈段1・段2の TS・Python・のぞき見・Actions〉で指摘を探し、指摘ごとに別のエージェントが反論を試みた）:
    - 指摘は21件。反論できなかったのは14件（同じ中身が2組あり、実質12件）。すべて直した。
      - 手の例の Python の step が、`| tee` で Python の失敗を隠していた（重い）→ 終了コードで落とす。
      - (b) の比べる run の print の「数字の後の調べ」が空だった → 2023年と同じ行（件数の照らし合わせ・先読みの確かめの比べた数と食い違い・1日以内の勝率の分母と分子・当たったもの）を出し、Python の避けたかの判定の照らし合わせも足す。
      - 先読みの確かめ（signalCut・lookAheadAccount・ルールの行の口座）の「比べた数」が print に無かった → 出す。
      - Python が、ます（週・ペア・向き）を照らしていなかった → 照らす。
      - 2023年: 開いた鍵と残した足の時刻を、両方のプログラムがログに出していなかった。Python は15分足の終わりを確かめていなかった（1分足の確かめも、読み込みで切った後なので外れようがなかった）→ 両方でログに出し、Python は開いたファイルの1分足・15分足のすべてが END 以下で終わることを確かめる。
      - (b) の Python が、鍵の一覧の外の日のファイルも開いていた → 自分の鍵の一覧のファイルだけを開く。
      - 毎週の (b) に、締め切りの日付（2027-03-13）を前もって渡すと、その run が比べる run になり、Δ などが早く出た → END_b は過ぎた土曜だけにする（TS・Python とも）。
      - 7 の (10) が Actions の push の run に無かった → job（unchanged）を足した。main の 0f9953a と今のプログラムで同じ作り物を走らせ、全ファイルの sha256 を比べる。
      - 段1の後に、(4)(5) を段1の冬の枠で走らせ直す道が無かった（順番 4）→ プログラムが段1のファイルの sha256 を持った後は、costsyn が段1のファイル（sha256 を確かめて）を使う。Python もそのファイルで照らす。
      - 段1の仕込んだ誤り「鍵の一覧の外のファイルを開く」が、足の時刻の確かめでも止まっていて、開いた鍵の確かめが壊れても気づけなかった → 開いた鍵の確かめだけで止まる形にし、Actions でどの確かめで止まったか（5ペアとも）を見る。
      - 2023年の避けた枠のスプレッド: 期間に足の無い夏の枠だけを避けるペアが「中央値は -（0本）」と出る → 「避ける枠なし」。
      - (5) の件数の中央値が、真ん中2つの小さい方だった → 2つの平均（medianOf）。
    - 反論されて取り下げた7件（理由を Claude が読んで受け入れた）: 段1の実データの run が Python の前に作業用の CSV を書く（決まりのファイルは `research/ledger/spread-hours.csv` で、確かめが通った後にだけ commit する）。「比べは済んだ」を件数だけで出す（決まりが END_b と件数で決めている）。仮のファイルを本番のパスに置く誤りが、いまは空の定数で止まる（2件。決まりで定数は段1まで空。sha256 の食い違いは別の確かめで見ている）。避けたかの判定の関数に v が渡る（値段〈GMO の売値・買値〉は渡らない。v は判定に使われない）。(4)(5) を段1の枠で走らせられない（順番 2 では仮の枠で通すのが決まり。ただし順番 4 の道は上で足した）。Python が 2023年の口座の元手を meta から取る（ルールの行の口座は TS が固定の 30万円・100万円で作り、Python と照らしている）。

- **段1の結果（順番 3、2026-10-07）**:
  - run: dispatch の `stage1=yes`、run 37634829079（commit 99c18c5、PR #179 をマージした後の作業ブランチ）。
    - s1syn: 作り物の確かめが通った。
    - s1real: TS の確かめがすべて通った（「REAL: every check passed」。CHECK FAILED と読み込みの失敗は0件）。
    - Python（`spreadhours-check.py`）: 同じファイルから計算し直し、「every value the same」。
  - 読んだ足:
    - どのペアも、日のファイル 20231231〜20261003（1,008日）。
    - 残した足は 2024-01-01 22:00 UTC〜2026-10-02 21:00 UTC。
      - USD/JPY 1,019,317 本
      - EUR/JPY 1,020,701 本
      - AUD/JPY 1,019,320 本
      - EUR/USD 1,019,320 本
      - AUD/USD 1,020,701 本
    - 外した足は、片側だけの足（oneSide）が USD/JPY・AUD/JPY・EUR/USD で各 1,381 本。EUR/JPY・AUD/USD は0本。ほかの理由（crossed・closure・repeated）は0本。
    - USD/JPY が AUD/JPY・EUR/USD より3本少ない理由は、ログからは分からない（調べていない）。
    - GMO から新しく読んだのは各ペア6件（失敗0）。残りは保存済みの日のファイル（各2,010件。売値・買値で 1,008 × 2 ＝ 2,016 件）。
  - ファイル: `research/ledger/spread-hours.csv`（960行）、sha256 `2b325574297a9891bc4760717ab3f6e3891d073725b01b46b0faa7b89605bb93`。
    - print の段がログに出した中身を書き起こした。sha256 がログの値と一致することで、1字まで同じことを確かめた。
  - 避ける枠: 5ペア・夏冬のどれも同じ14枠。UTC 20:30〜23:45（日本時間 5:30〜8:45）。
    - 夏と冬で、UTC の時刻はずれていない。楽天の止まる時間（夏 20:55〜21:10、冬 21:55〜22:10 UTC）は、どちらの季節もこの中に入る。
    - 1,000本より少ない枠は無い（いちばん少ない枠で 2,625 本。冬）。
  - base としきい値、避けた枠と残した枠の中央値:

    | ペア | base | しきい値 | 避けた枠の中央値（夏） | 避けた枠の中央値（冬） | 残した枠の中央値の最大 |
    |---|---|---|---|---|---|
    | USD/JPY | 0.40 | 1.20 | 1.40〜10.10 | 3.00〜19.20 | 0.50 |
    | EUR/JPY | 0.50 | 1.50 | 2.70〜11.60 | 4.90〜16.40 | 0.60 |
    | AUD/JPY | 0.70 | 2.10 | 3.10〜7.50 | 3.80〜12.10 | 0.70 |
    | EUR/USD | 0.50 | 1.50 | 1.70〜7.40 | 2.60〜9.80 | 0.50 |
    | AUD/USD | 0.40 | 1.20 | 2.90〜4.80 | 2.80〜4.50 | 0.50 |

    （単位は pips）
  - 避ける枠の足が、その季節の1分足に占める割合: 夏 13.87〜13.88%、冬 13.79%（どのペアも）。
  - 3 の止める条件: どれにも当たらない。
    - 避ける枠は、どのペア・季節も14（32以下）。
    - 冬の避ける枠が、どのペアにもある。2023年11〜12月（冬）で確かめられる。
  - 定数: `research/costhours-lib.ts` の `SPREAD_HOURS_SHA256` と、`research/ownerhold-check.py` の `C_SPREAD_SHA256` に、上の sha256 を書いた。
    - 手元で確かめたこと: TS と Python のどちらも、このファイルを読んで避ける枠が140（5ペア × 2季節 × 14）、しきい値（0.1 pips の2倍）が USD/JPY 24・EUR/JPY 30・AUD/JPY 42・EUR/USD 30・AUD/USD 24 で、同じだった。1字変えたファイルは、どちらも sha256 の食い違いで止まった。
  - 定数を入れたことで変わること:
    - push の run の s2syn（7 の (4)・(5)）は、段1のファイルで走る（順番 4）。
    - 毎週の (b) は、次の月曜（10/12、END_b 10/10）の run から、② の行を出す。出すのは件数などの5つだけで、Δ を出すのは比べる run の1回だけ（順番 2 の作りのまま）。
    - 2023年の run は、dispatch の `y2023=yes` でだけ走る。まだ走らせていない（順番 5）。

- **段1の枠での 7 の (4)・(5)（順番 4、2026-10-07。2023年の足を読む前）**:
  - run: push の run 37636478344（commit 273b6cc。PR #180 でマージ）の s2syn。3組とも「the slots avoided: research/ledger/spread-hours.csv (stage 1's, its sha256 checked)」で、段1のファイルで走った。
  - (4)（種 1〜100、区間は95%。括弧は99%）:

    | 組 | 悪い側 | 良い側 | Δ の平均 ± 標準誤差 | 線1 | 線2 |
    |---|---|---|---|---|---|
    | トレンドなし | 1（0） | 4（0） | −0.37 ± 0.42 | 満たす | 満たす |
    | 1分足 0.01 pips | 0（0） | 2（0） | −0.13 ± 0.46 | 満たす | 満たす |
    | 1分足 0.03 pips | 3（0） | 4（0） | −0.07 ± 0.60 | 満たす | 満たす |

    - 区間が出なかった種は、どの組も0。
    - 種ごとの区間を数え直した数も、まとめの数と合う（Claude のエージェントがログの100行ずつを数えた）。
  - (5)（段1の冬の避ける枠を 12 pips 広げる、トレンドなし）: Δ の平均 −3.75 ± 0.43。線（−3.39 × 0.43 ＝ −1.47 より下）を満たした。
    - 出すだけのもの: 「悪かった」と出た種は100通りのうち10。そろえた避けたメールの件数の中央値は60。決済する側で評価した Δ の平均は −5.30。
    - 仮の枠（1日1時間）のときは、それぞれ 2・19・−4.41 だった（順番 2）。段1の枠は1日3.5時間なので、そろえた件数が増えた。
    - 読み方: 2023年11〜12月の1回の確かめでは、冬の避ける枠のスプレッドが本当に 12 pips 広くても、「悪かった」と出るのは作り物で100通りのうち10通りだった。差があっても「言えない」と出ることが多い確かめ、ということ（決まりは変えない）。
  - 1つ目の作り物（トレンドなし、種1）の全部の確かめ（FULL）:
    - TS の確かめ: 19個すべて ok。
    - 出してよい項目の確かめ: d を出す仕込みで止まった。P＋24時間の足の仕込み（pastEndBar）も止まった（期間の外の読み7回）。
    - 計算が変わる仕込んだ誤り:
      - TS で数が変わったのは8つ（slotFromOpen 478・vExit 36・noWeekCell 477・fridayIn 112・keptMeanAll 35・blocks4 1・ruleOrdersAvoided 1・midAhead 88）。midAhead は、TS 自身の確かめ（lookAheadMid 143）でも止まった。
      - Python との食い違いは、8つとも出た（575・39・619・250・73・3・9・109 件）。
      - holidayIn・pastEndIn は、2023年の暦では変わる数が0（順番 2 と同じ。手の例 s2hand で見つかる）。
    - Python（`--cost research/ledger/spread-hours.csv`。sha256 を Python 自身の定数と照らした）: 65,779 項目で、食い違いは0。
    - 定数を空にする仕込み（emptyConst）: 2023年の mode は、GMO を読む前に止まった（終了コード 3）。
  - 2023年のデータは、まだ読んでいない。次は順番 5（dispatch の `y2023=yes`）。

- **2023年11〜12月での確かめの結果（順番 5、2026-10-07）**:
  - run: dispatch の `y2023=yes`、run 37640996321（commit 95c773d。PR #181 をマージした後）。
    - 同じ run の s2hand（手の例）・s2syn（3組）・s2b がすべて通った後に、y2023 の job が走った。
    - 2023年の日のファイルは、専用のキャッシュ（`gmo-2023-*`）だけを使った。前のキャッシュは無く、GMO から読んだ。保存した鍵は gmo-2023-37640996321。
  - 読んだ範囲の確かめ（決まりの 5 のとおり）:
    - 開いた日のファイル: 1分足 20231106〜20231230、15分足 20231026〜20231230。TS と Python で同じ。
    - TS が残した足:
      - 1分足: 5ペアとも 2023-11-07 00:00〜2023-12-29 21:00 UTC（足の終わり）
      - 15分足: 5ペアとも 2023-10-27 00:00〜2023-12-29 21:00 UTC
      - どちらも END（2023-12-30 00:00 UTC）以下。
    - 600本の窓がそろわない合図（noWindow）は0件。TS の確かめは19個すべて ok。
  - 合図は 491件。
  - Python（`--quiet`。`--cost research/ledger/spread-hours.csv --cost-2023`）は「main dump: mismatched 0」。避けたかの判定（Python が P だけから作り直したもの）は、491件で食い違い0件。
  - 読んだのは、print.txt（決めた項目だけ）と、メールごとの記録だけ。③の数字・E*・スワップ込みの行は出しておらず、読んでいない。
  - 先に決めた文（「それ以外」に当たった）:
    - 「2023年11〜12月では、避けた時間帯のメールが悪いとも良いとも言えない（差 -6.11 pips、95%区間 -25.82〜13.60 pips。43 通・8 週）。区間（-25.82〜13.60 pips）の中のどの差も、このデータと合う。1通あたり -25.82 pips くらいの差があっても、この数では見分けられなかったことがありうる。差が無いという意味ではない。」
  - どの場合も書く文:
    - 平均と合計:
      - 「数えたメールのうち、避けたメールは 43 通（うち、そろえた 43 通）で、1日後の値の平均は -14.02 pips（合計 -602.90 pips）。残したメールは 373 通で、平均 -2.82 pips。この2つの平均は、週・ペア・向きをそろえていないので、相場の上げ下げの差が混ざる。判断は Δ で行う。」
      - 「このデータで避けると（そろえずに数えると）、1通あたりの平均は -3.98 pips から -2.82 pips に上がり、合計は 602.90 pips 増える。」
    - 1日以内の勝率:
      - 「1日以内の勝率（数えたメールのうち、P から1日以内に入った取引で、1日以内に利確した割合）: 避けたメール 69.0%（42 件中 29 件。1回あたり -14.35 pips。1日の時点でまだ持っている 13 件、1日以内に入らなかった 1 件）、残したメール 82.0%（367 件中 301 件。1回あたり -2.87 pips。1日の時点でまだ持っている 66 件、1日以内に入らなかった 6 件）。損切りが無いので、作りの上で高く出る。ルールが効く証拠でも、この持ち方がうまくいく証拠でもない。」
    - 2023年のスプレッド（避けた枠・残した枠の中央値）:

      | ペア | 避けた枠 | 残した枠 |
      |---|---|---|
      | USD/JPY | 11.70 pips（7,170本） | 0.20 pips |
      | EUR/JPY | 10.50 pips（7,170本） | 0.80 pips |
      | AUD/JPY | 4.90 pips（7,170本） | 1.00 pips |
      | EUR/USD | 4.70 pips（7,170本） | 0.50 pips |
      | AUD/USD | 3.30 pips（7,170本） | 0.60 pips |

      - どのペアも、避けた枠の中央値は、そのペアのしきい値（1.20〜2.10 pips）より上。「広くなかった」と添えるペアは無い。
    - 口座（参考）: 「30万円の口座（§8.102 の判断の道筋の作りで、START から END まで）: ルールなし -159,611 円・ロスカット 0 回・期限の決済 0 回・上限で入金し切れなかった追証 0 回、ルールあり -138,695 円・0 回・0 回・0 回（入金を引いた損益）。入れたお金の合計 150,418 円・64,392 円、置けた割合 12.4%・10.0%（ルールで注文しなかった 44 件は、置けなかったメールと分けて数える）、勝率 91.5%・93.9%（1回あたり -22.95・-23.87 pips、-2,679・-2,806 円。終わり方: ルールなし tp 54・held 5、ルールあり tp 46・held 3）。1本の道筋で約8週だけなので、幅は付けず、判断には使わない。」
    - 結びの文: 「これは約8週（すべて米国の冬時間。感謝祭と年末を含む）・GMO の値段・P から1日後の値での結果。楽天での成績や、口座が増えるかを確かめたものではない。ドル円の 2023年11〜12月は、§8.96（ゴトー日）で一部を見たデータ。ルールを使っていく確かめは (b) で行う。」
  - 並べる数字（判断には使わない）:
    - すべてのメール 491通、数えた 416通（避けた 43・残した 373）。数えなかった理由（順に1つ）: 何もしない 0・金曜 75・P＋24時間が END より後 0・評価が早まった 0・同じますに残したメールが無い 0。
    - 評価が早まったメールの日付: なし。1,000本より少ない枠に P が入ったメール: 0通。
    - ペアごと（避けた・残した）: AUD/JPY 8・66、USD/JPY 7・93、EUR/USD 7・71、EUR/JPY 10・81、AUD/USD 11・62。
    - 週ごと（週の始まりの日曜。避けた・残した）: 11-05 6・17、11-12 6・47、11-19 3・51、11-26 5・48、12-03 8・59、12-10 7・66、12-17 5・54、12-24 3・31。
    - 決済する側の値段で評価した v での Δ: -6.37 pips（点だけ）。決済する側で評価すると、避けたメールは、評価の時刻の広がりの分だけ悪く出る作り。
    - ドル円を除いた4ペアの Δ: -6.39 pips（点だけ。そろえた避けたメール 36通）。ドル円の 2023年は §8.96 で一部を見たデータなので、それを除いた数字。
  - 数字の後の調べ（決まりの項目すべて）:
    - 件数: すべて 491 ＝ 数えた 416 ＋ 数えなかった 75。数えた 416 ＝ 避けた 43 ＋ 残した 373。数えた避けた 43 ＝ そろえた 43 ＋ 同じますに残したメールが無い 0。どれも合う。
    - 先読みの確かめの比べた数と食い違い:
      - lookAheadPaths: 9,456・0
      - 中値の v: 982・0
      - lookAheadAccount: 10・0
      - ルールの行の口座: 4・0
      - signalCut: 17,685・0
    - 手の例（7 の (3)）: 同じ run・同じ commit の s2hand が success。
    - 避けたかの判定: Python が P だけから作り直した判定と、491件で全件一致。
    - 1日以内の勝率の分母と分子を、終わり方の件数と照らした（避けた 29/42〈まだ持っている 13・入らなかった 1〉、残した 301/367〈66・6〉。合う）。
    - 1日以内の勝率の100%、|Δ| が10 pips を超えること、0をまたがない区間: どれも無し。
    - Claude が、commit したメールごとの記録（下）から別に計算し直した。Δ -6.11、95%区間 -25.82〜13.60（週でまとめた t(7)、8週）・平均・件数・週ごとの件数・決済する側の Δ -6.37・4ペアの Δ -6.39（36通）が、print.txt と同じだった。
  - 記録: `research/ledger/ultra15-2023.csv`（491行。合図の向きだけ）、sha256 `c2912fe1ab94eccd91fbc3ef09baa343f83228f76d02f1ed13fa59a694934c36`。y2023print の段がログに出した中身を書き起こし、ログの sha256 との一致で確かめた。
  - 判断には使わない気づき（決まりは変えない）:
    - 2023年の冬に広かったのは、どのペアも UTC 20:00〜22:45 の枠だった。中央値は USD/JPY 11.9〜12.9、AUD/USD 3.3〜7.8 pips など。
      - 避けた枠のうち 23:00〜23:45 の4枠は、2023年には 20:00〜22:45 よりずっと狭かった（USD/JPY 0.20〜0.30・EUR/JPY 1.20〜1.60・AUD/JPY 1.10〜1.60・EUR/USD 0.50・AUD/USD 0.70〜0.80 pips）。
      - 20:00・20:15 の2枠は、2023年には広かったが、避けていない。段1の 2024〜2026年の冬では、この2枠の中央値はふだんと同じ（例: EUR/USD 0.50 pips）。
    - 順番 4 の (5) では、冬の避ける枠が本当に 12 pips 広くても、この確かめで「悪かった」と出たのは100通りのうち10通りだった。今回の「言えない」は、その見込みどおりの出方でもある。
  - 次は順番 6: (b) の毎週の run で、R（2026-10-08 00:00 UTC）以後のメールを数える。そろえた避けたメールが100通に届いた END_b の run か、締め切り（2027-03-13）の run で、1回だけ比べる。

### 8.104 日本語の売買メールで、通貨ペアを楽天FXの名前（ユーロ/円など）にした（#211、signal-alerts v21）

- **指示**（2026-10-07）: オーナーが、15分足の ULTRA のメールの画面（ペアの所に赤丸）と、楽天FXのペアの一覧の画面を送り、「メールのさ、売買のメール、赤丸の通貨のペアの部分をこの場合だとユーロ/円と日本語で表示して こんな感じで、そっちの方分かりやすい」。件名も変えるかを選択式で確かめ、オーナーは「件名も本文も日本語」を選んだ。
- **変えたこと**:
  - `supabase/functions/_shared/pair-names.ts`（新しい）: `PAIR_JA`（37銘柄）と `pairJa`。
    - 名前は、アプリのペアの一覧（`src/lib/i18n/ja.ts` の `live.pairShort`。#153・#154 で楽天FXの一覧に合わせたもの）と同じ。
    - 一覧に無いペアは、コード（EUR/JPY など）のまま出す（`toString` のような、オブジェクトがもともと持つ名前もコードとして扱う）。
  - 日本語のメール（signal-alerts v21）の件名と本文の1行目。ULTRA・Q-Trend（`signal-alerts/indicators.ts`）と、GA型・RSI＋SAR（`signal-alerts/logic.ts`）。
    - 例（ULTRA）: 件名「【Sextant】ユーロ/円 15分足 売り（Sell ☆）のサイン（ULTRA）」、1行目「ユーロ/円の15分足で、ULTRA の売り（Sell ☆）のサインが出ました。」。
    - 名前のすぐ後に「の」「は」などが続く所では、間を空けない（コードのときは「EUR/JPY の」と空けていた）。
  - 本文の中のペア名: Twelve Data の銘柄の注記（「足は Twelve Data のもの（香港ドル/円は GMOコインにないため）」）と、測っていない銘柄の注記（「香港ドル/円そのものは測っていません」）。
  - テストメールの「登録中のチャート」の一覧（日本語のとき）。
  - 金は、楽天FXの一覧のとおり「金」と出る（例: 「【Sextant】金 1時間足 …」）。
  - 変えていないもの:
    - 英語のメール（EUR/JPY などのコードのまま）。
    - サインの出し方、ルールの ID、二重送信を防ぐキー、メールを送る時刻。
    - 記録（`signal_alerts` などの `pair` はコードのまま）。§8.102 の (b) の毎週の書き出しと、毎日のメールの照合は、`pair` のコードで行うので影響しない。
    - アプリの画面（メールの履歴の一覧など）。指示はメールのため。
  - テスト:
    - `src/test/pair-names.test.ts`（新しい）: `PAIR_JA` がアプリの一覧と同じこと、メールを送る全銘柄（Q-Trend・ULTRA の `LIVE_PAIRS` と、RSI＋SAR・GA型の `ALERT_PAIRS`）に名前があること、知らないペアはコードのままのこと。
    - 件名と1行目の期待値をドル/円・ユーロ/円に直した（ULTRA・Q-Trend・GA型・RSI＋SAR）。金は件名、香港ドル/円は本文の2つの注記、テストメールは一覧の行を確かめる。英語のメールがコードのままのことも確かめる。
- **確かめ**（2026-10-07）:
  - 全テスト 115ファイル・2,446件が通った。型の確かめ（`tsc -p tsconfig.app.json`）の誤り12件は、変える前と同じもの（`postmortem.test.ts` など、今回の変更とは関係ない）。lint は誤りなし。
  - esbuild で signal-alerts の関数を組み立てられることを確かめた（Deno の `deno check` は、この開発環境に Deno が無いため走らせていない）。
  - 独立した見直し（別のエージェント）: 誤りは見つからなかった。細かい指摘のうち、次を直した。
    - `pairJa` が `toString` などの名前で、オブジェクトがもともと持つ関数を返しうる（今の銘柄では起きない）→ 自分のキーだけを見るようにした。
    - テストが RSI＋SAR・GA型の `ALERT_PAIRS` を直接は確かめていない → 足した。
    - docs の2か所の書き方（テストメールの見出しの名前、テストが確かめる所）→ 直した。
    - 日本語の名前の後の空き（「ユーロ/円 の」）→ 詰めた。
  - 見直しは、各呼び出しを1か所ずつ元に戻すと、テストが1つずつ落ちることも確かめた。
- **出したもの**（2026-10-07）:
  - PR #173 をマージした（#206 ② の下見とオーナーの選択の記録も一緒に入った）。
  - 関数: `deploy-functions.yml` run 37605714025 が成功した（10:11:48 UTC に終わり）。
  - 本番の毎分の巡回は、10:12:00 UTC から版名 `signal-alerts-v21-2026-10-07T10:00:00Z`（`indicators`、応答 200）。10:11:00 までは v20。`net._http_response` で確かめた。
  - 画面は変えていないので、Lovable への公開はしていない。
  - 本番のメール: 10:12 UTC の時点では、v21 になってから送られたメールはまだ無い（`signal_alerts` に行が無い）。最初のメールの件名と1行目は、次の毎日の照合（2026-10-08 00:16 UTC の予約）で確かめる。
  - **本番での確かめ**（2026-10-07 11:48 UTC 頃、Gmail で alerts@fx-tactical.jp から来たものだけを読んだ）: v21 の後の最初のメールは 11:00:08 UTC のユーロ/ドル15分足 ULTRA の買い。件名「【Sextant】ユーロ/ドル 15分足 買い（Buy ☆）のサイン（ULTRA）」、1行目「ユーロ/ドルの15分足で、ULTRA の買い（Buy ☆）のサインが出ました。」で、楽天FXの名前になっていた。v21 の前のメール（同じ日の 08:30 の USD/JPY・AUD/JPY など）は、コードのままだった。

### 8.105 金の15分足の Q-Trend・ULTRA のメールを出せるようにした（#212、signal-alerts v22）

- **指示**（2026-10-07）: オーナーが金1時間足のチャートの画面を送り、「あと、この金の売買のタイミングのメールっておくってる？」。
  - 答え: 送っていない。今のオーナーの購読は15分足 ULTRA の5ペアだけ（§8.102。10/5 に15分足へ替えたとき、楽天の広告スプレッドが狭い5ペアを選び、金は入らなかった）。
  - 金のメールは、9/28〜10/2 にオーナー宛てに6通（Q-Trend 4時間足4・ULTRA 4時間足1・ULTRA 1時間足1）。いま金を購読している人はいない。
  - 選択式の質問で、オーナーは「15分足 ULTRA を足す」を選んだ。
- **選んだ後に分かったこと**: 金（Twelve Data の銘柄）のメールは、1時間足以上だけにしていた（#155。Twelve Data の無料枠〈1日800回、チャートと共有〉のため）。購読を足すだけでは送れないので、コードを変えた。オーナーには、そのことを伝えてから作った。
- **Twelve Data の使用**（`twelve_data_usage`、1日の回数。UTC の日付）: 9/28 217・9/29 261・9/30 159・10/1 122・10/2 95・10/3 4・10/4 7・10/5 145・10/6 46・10/7 26（10:35 UTC まで）。
  - 金の15分足は、確定ごとに1回読む（足がまだ無ければ3分後にもう1回）。そのため、1日に約90〜190回増える見込み（数えていない）。
  - Twelve Data が読めなかったとき（答えの誤り・時間切れ）や、読んだ足の保存に失敗したときは、その確定の新しさの窓（20分）の間、成功するまで読み直す。巡回はふつう毎回新しいインスタンスで動くので、毎分読み直すことになる（前からある作りで、1時間足でも同じ。見直しで、写した関数を動かして確かめた）。そのときは、1つの確定で2回より多く読む。どの読み込みも1日の上限の中で数える。
  - アラートが読めるのは1日780回まで（`ALERT_TWELVE_CAP`、チャートの上限より上）。
- **変えたこと**:
  - `signal-alerts/indicators.ts`: `GOLD_ALERT_INTERVALS`（15分足・1時間足・4時間足・日足）を足し、`indicatorIntervalsFor` で金だけこれにした。
  - 巡回がその分に見る Twelve Data のチャートを決める所を、`twelveChartDue`（indicators.ts）にまとめ、1時間より短い足を自分の区切りで見るようにした。
    - 前は、足の区切り（`twelvePhaseOf`）を知らないチャートは、毎時の前半30分（:01〜:29）だけ見ていた。1時間足以上なら確定はすべてこの30分に入るので、困らなかった。
    - 巡回は、ふつう毎回新しいインスタンスで動く（見直しで、本番の巡回の記録〈`net._http_response` の files.table が毎回110・skipped judged が0回〉から確かめた。§8.81 の記録とも同じ）。そのため区切りはいつも分からず、金15分足は :01〜:29 しか見られない。:30 の確定は送られず、:45 の確定は約16分遅れて送られるところだった（最初の版〈ca48d04〉の見直しで見つかり、出す前に直した）。
    - 今は、区切りが分からない1時間より短い足は、UTC の区切り（Twelve Data の15分足は正15分ごと。保存した足で確かめた）で見る。1時間足以上は前のまま。
    - ほかの Twelve Data の銘柄（6ペア）は、今のまま1時間足以上。
    - 金の5分足は入れていない。
    - 読み方は1時間足と同じ作り（確定の1分後に読み、足が無ければ3分後にもう1回）。読んだ足は `live_chart_fallback` に保存し、チャートと共有する。
  - 金の毎日の休み（NY の 17:00〜18:00）の間も、Twelve Data は、ほとんど動かない15分足を返す（保存した足で、10/1・10/2・10/5・10/6 の休みの4本ずつを確かめた。§8.79 の記録とも同じ）。巡回は、その足でも判定する。休みの足で印が出れば、メールも送る（チャートも同じ足で印を描く）。
  - 版名を `signal-alerts-v22-2026-10-07T12:00:00Z` にした。
  - 画面:
    - メール通知の設定の表で、金の15分足が選べるようになる。表はサーバーが返す一覧から作るので、画面のコードは変えていない。
    - 説明文（日本語・英語）の「1時間足・4時間足・日足だけ」に「金は15分足も」を足した（設定の注記、表の「—」の説明、よくある質問）。
    - 金のチャートの説明と、ほかの Twelve Data の6ペアのチャートの説明は、「サインの印は表示するが、メール通知の対象外」と書いていた（#155 から、1時間足以上の Q-Trend・ULTRA はメールできたので、前から誤り）。メールできる時間足（金は15分足から、6ペアは1時間足から）と、GA型・RSI＋SAR は対象外であることを書くように直した。
  - メールの「測った成績」の行は、金の15分足の数字が前からある（`GOLD_MEASURED`。ULTRA は利確1が先 73.6%・1回あたり約0.78ドルの負け、Q-Trend は 74.3%・約0.65ドルの負け。損切り13ドル・利確1 4ドル、2024年1月〜2026年9月）。オーナーの持ち方（損切りなし・利確10）での数字ではない。
  - 変えていないもの:
    - サインの出し方、ルールの ID。
    - ② と §8.102 の (b) の研究。どちらも GMO の5ペアだけを数えるので、金のメールは入らない。
- **テスト**: 金は15分足を選べ、5分足は選べないこと。ほかの Twelve Data の銘柄は1時間足以上のままであること（サーバーの一覧と、設定の表の両方）。区切りを知らないインスタンスでも、金15分足を各15分の確定の1〜14分後に見ること（:31・:46 を含む）。1時間足以上は前のまま毎時の前半30分であること。
- **見直し**（2026-10-07。Claude の Workflow。3つの見方〈巡回・正しさ・ほかへの影響〉で指摘を探し、指摘ごとに別のエージェントが反論を試みた）: 指摘8件のうち、本当とされたのは6件で、中身は4つ（重い1つは上の :30・:45 の件で、3つの見方から重ねて出た。ほかは docs の休みの足と読み直しの書き方、金のチャートの説明）。4つとも直した。本当ではないとされた2件（設定の答えの `limited_intervals`、毎日の照合）は、変えていない。
- **出したもの**（2026-10-07）:
  - PR #177 をマージした（#206 ② 段1のプログラムも一緒に入った）。関数: `deploy-functions.yml` run 37615967406 が成功した（11:43:39 UTC に終わり）。本番の巡回は 11:44:00 UTC から v22。
  - 画面: Lovable で公開した（`deploy_project`、11:44 UTC 頃）。返事は pending（deployment e6efaa66）。公開が終わったかは確かめていない。
  - オーナーの購読: XAU/USD 15分足 ULTRA（日本語）を、データベースに直接足した（11:44:14 UTC）。
  - 本番での確かめ: 11:46:00 UTC の巡回（購読6件）で、Twelve Data を1回読み、金15分足の 11:30 始まりの足を、確定から約62秒後に判定した（合図なし）。11:47 の巡回は保存した足で判定し、読み込みは0回だった。11:45 の確定は、直す前の作り（毎時 :01〜:29 だけ）では見られなかった時刻で、直したとおりに動いた。
  - 毎日の照合の予約（2026-10-08 00:16 UTC）は、GMO の5ペアだけを照らし、金は件数と判定の記録だけを書くように直した。

### 8.106 流れ（ダウ）の条件で15分足 ULTRA のメールを絞ると勝率が上がるかを、先に決めてから測る（#250、研究のみ）

- **指示**（2026-10-09）: 10/9、ユーロ/円の15分足 ULTRA の売りのメール（177.290・177.388・177.581・177.769・177.702）の後も、値段は上がり続けた。オーナー:
  - 「流れ（トレンド）の条件を付けたら良くなるかは、まだ測ったことがありません。測ってみて」
  - 「ニュースは考慮しなくていいです。チャート分析だけで大丈夫」
  - 「メールの数が減ってもいいです勝率をが上がるなら」
  - 外れたメールの「なぜ」を調べて報告し、学んで直していくこと（「なぜ外したのかを学習するようにして…報告して…学んで修正していって」）は、#251 で別に決める。この節は、その最初の1つとして「流れの条件」を測る決まり。
- **使うもの**: チャートの値段（GMO の Bid・Ask の足）だけ。ニュース・経済指標の予定・ほかの情報は使わない。
- **いつ決めたか**: 流れで分けた成績を1つも見る前（2026-10-09）。
  - この決まりのために読んだものは、次の4つだけ。
    - docs。
    - 研究のプログラム。
    - (a) の `ultra15-a.csv`（流れでは分けていない）。
    - DB の 10/6〜10/9 のメールの行。
  - 決め方: Claude の Workflow（読む3・案を作る3・比べる1・反証2）で案を比べ、反証で出た大きめの指摘5つ（下の「見直しで直したこと」）を直してから書いた。
- **オーナーの選択**: 勝ちの決め方は「利確10 pips が損切り13 pips より先」（オーナー「Aで」、2026-10-09）。
- **順番**（オーナー「では、おすすめの順番で」、2026-10-09。夕方に、この測定を先にした）: この測定（#250）→ メール1通ずつの記録（#247）→ 外れたメールから学ぶ仕組み（#251）→ ③（時間帯。#251 の候補の一つとして）→ TICK。② は月曜の Routine がそのまま続ける。

**前から知っていること**（下の決め方は、これを知った上で決めた）
- 流れを読む道具は、これまで先を当てていない:
  - §8.46（#134）: ストキャス 80/20 のサイン（ULTRA に近い、行き過ぎからの戻りの合図）で、1つ上の時間足のダウが逆向きのサインを外しても、良くならなかった。
    - 後半（2025-07〜）で、残した 30,414回 28.8%・外した 16,270回 29.7%。差は −0.9ポイント（−2.3〜+0.4）。
    - 損切りは ATR×1、利確は2倍。11ペア・15分足・1時間足・4時間足。
    - これは下の候補 ① とほぼ同じ形で、下の後半と大部分が重なる期間で測ったもの。
  - #103（GitHub Actions run 36106114155 のログ。docs には無かった）: RSI 30/70 の合図に「1つ上の時間足の終値が SMA50 の上（買い）・下（売り）」を足すと、残るのは約13%。後半（2025-07〜）で +1.5ポイント（−2.0〜+5.0）で、効くとは言えなかった。損切りは ATR×1、利確は同じ幅。11ペア。
  - §8.43（#130）・§8.90（#179）・§8.94（#183）: ダウの表示が当たる割合は、ランダムとほぼ同じだった（45〜51%、ランダムは 48〜52%）。上位足と同じ向きに限っても、良くならなかった。
  - §8.54（#142）: 流れを読む道具は、過去の流れを読むだけで、その先は当たらなかった。
  - §8.70（#158）・§8.71（#159）: Stoch・BLSH・MACD で絞っても、良くならなかった。
  - §8.73（#161）: 4時間足の ULTRA の売りは、同じ足のダウが上昇・上昇の兆しの時が856回（23.7%）、下降・下降の兆しの時が131回（27.5%）で、差ははっきりしなかった。下と同じ 2025-05-19 で前半・後半に分けていた（4時間足で、勝ちの決め方も違う）。
  - §8.85（#174）: 通貨の強弱と同じ向きのメールは、1回あたり −2.95 pips。逆向きは −0.82 pips。差ははっきりしなかった。
- 15分足 ULTRA のメールの成績:
  - §8.98: 利確4が損切り13より先 72.0%・1回あたり −1.51 pips（GMO の21ペア。5ペアだけの数は出していない）。4時間足では、利確10が先 54.3%・−1.07 pips。
  - §8.102 の (a)（2024-01〜2026-10、9,510件）: オーナーの持ち方（指値・利確10・損切りなし）で、1回ごとの勝率は 98.8%。逆向きに入っても 98.8%。30万円の口座では 91.8%・1回あたり −6.0 pips（−671円）。
- この決まりを作る調べで、(a) の `ultra15-a.csv` から出した数（流れでは分けていない）:
  - 1日後に −30 pips 以下 11.1%。1日後の平均 −0.99 pips。
  - 同じペア・同じ向きが3時間以内に続いたメールは 61.5%。
    - 続きの最初のメールが一番悪い（平均 −7.73 pips）。ただし「最初か」は後のメールで決まるので、先読み。
    - 送る時に分かる分け方（前の3時間に同じ向きのメールがあったか）では、あった −0.28 pips・無かった −1.42 pips で、ほとんど差が無い。
  - 1日以内に利確した割合は、5ペアとも買いの方が売りより高かった（例: ドル円 84.1% と 80.5%）。
  - 1日以内の利確が半分以下だった日は 9.1%（GMO の日。21:00 UTC 区切り）。10/9 のような日は、今の決まりでもよくある。
- ダウの山と谷の幅（左右4本、`DOW_PIVOT`）は、§8.45（#132）で選んだ。
  - 選んだのは 2024-01〜2025-06 の、ダウの出来事の勝率（ULTRA の成績ではない）。
  - この期間は、下の前半の全部と、後半の最初の6週（2025-05-19〜06-30）に重なる。
- きっかけは 2026-10-06〜10-09 のメール（10/9 の売り、10/7 のユーロ/ドルの買い8通など）。
  - オーナーの画面の読みは、10/9 15:36 が 4時間足 下降・1時間足 上昇・15分足 上昇・5分足 上昇。
  - これは画面を見た時刻の表示。メールの時刻ごとの表示は確かめていない。
- **見込み**（測っていない）: 上の結果から、本当の差は −2〜+2ポイントくらい。小さく良くなるのと同じくらい、悪い（外したメールの方が良い）こともありうる。後半は、上の §8.46・§8.73・§8.90 で一部をすでに見た期間なので、まったく新しいデータではない。
  - ① か ② が「採用候補」になり、それが §8.46 や §8.90 と食い違うときは、報告の前に、先読みと測り方の誤りを疑って調べる（11 の「数字の後」）。

**1. 流れの読み方（ラベル）**
- チャートのダウの1行を、そのまま使う（`_shared/dow.ts` の `dowTheory`、左右4本、確定した足300本）。設定は変えない。
- 向き（§8.90 と同じ）:
  - 上昇・上昇の兆しは、上向き。
  - 下降・下降の兆しは、下向き。
  - 判定なしは、向きなし。
- 読む時刻 C: 合図の足の確定 T。
  - C の60秒後にチャートが出す表示と同じものを作る（`research/dow-hit.ts` の `labelsOf` の作り）。
  - この作りは、§8.94 の測り直し（run 37134324269、`WEEKEND=inside`）でチャートと 49,795か所で食い違い0だった。新しいプログラムでは `WEEKEND` を `inside` に固定し、環境変数では変えない。
  - 足: その時間足の GMO の Bid・Ask の中値（丸めない）。C までに確定した足（始まり＋長さ ≦ C）だけの値段を使う。C ちょうどに確定した足は使う（GMO は確定の1〜4秒後に出す。§8.81）。
  - 窓: 確定した足の新しい方から300本。C に次の足がまだ始まっていなければ301本（形成中の足は本数にだけ数え、値段は使わない。チャートと同じ）。チャートが読むファイルの範囲だけを使う。
  - ファイル:
    - 1時間足と15分足は、日のファイル。
    - 4時間足は、年のファイル。日曜 20:00 UTC の足も入れる（#182）。
    - 足ごとに、どの GMO のファイル（鍵）から来たかを持つ。日のファイルの鍵は `gmoDayKey`（21:00 UTC 区切り）、4時間足は GMO の年の決まりで作る。
- 遅れた合図（T＋15分で読んだもの）は、C＝T＋15分で読み、入りも追うのも C から始める（C の足の終値で、決済する側と逆の側）。(a) には遅れた合図が0件なので、今は効かない。
- 逆向き: 買いのメールで下向き、売りのメールで上向き。
- 読めないメールは、その候補の比べから外して数を出す。
  - 読めないのは、確定した足が300本に足りない時と、説明のつかない穴がある時。
  - 本番で使うなら、読めない時はメールを出す。

**2. 候補（この4つだけ）**
- ① 1時間足のダウが逆向きなら、出さない。
- ② 4時間足のダウが逆向きなら、出さない。
- ③ 1時間足と4時間足の両方が逆向きなら、出さない。
- ④ 15分足のダウが逆向きなら、出さない。
  - 10/9 の形。
  - ULTRA の売りは、15分足の RSI(14) が70を上から下に抜けた時に出る。つまり、値段が上がった後に出る。そのため、売りの多くが外れる見込み。
  - 6 の数の決まりで、成績を見ずに落ちることがある。
- 向きなしは、どの候補でも出す。
- 候補にしないもの（後から足さない）:
  - 5分足。
  - ダウ以外の線（移動平均・Q-Trend・SuperTrend・一目均衡表・ADX など）。
  - ほかの組み合わせ。
  - ダウの設定の変更。
  - 流れに逆らうメールだけを残すルール。
  - 同じ向きのメールの続き（後のメールで決まるため）。
  - 時間帯。
- 外したメールの方が良かったときは、「このルールは良いメールを外す側だった」と書く。逆張りのルールには変えない。試すなら、新しく決めて、新しいデータで確かめる。

**3. 測るもの**（メール1通ずつ。GMO の Bid・Ask。スプレッド込み）
- 主（勝率）: 利確10 pips が損切り13 pips より先に来た割合（W2）と、1回あたりの pips（PL2）。
  - 追い方:
    - 値段は、メールのエントリー E から測る。
    - 入りは、合図の足の終値（買いは Ask、売りは Bid）。
    - T から5分足で追う。
    - 値段を飛び越えて始まった足は、始値で約定とする。
    - 1本の足で利確と損切りの両方に届いたら、損切りと数える。
    - 5取引日（5分足1,440本）で決着しなければ「未決着」。割合からは外し、pips はその時の決済側の値で入れる（tf-winrate と同じ。§8.98）。
  - 主にする理由:
    - 10 pips は、オーナーの利確。
    - 流れが効くなら、4 pips より差が出やすい（考え。測っていない）。
  - 損益ゼロに要る割合は 13÷23 ＝ 56.5%（スプレッド別）。
- 並べるもの（主ではないが、8 の条件に使う）:
  - メールに出している数: 利確4が先の割合（W1）と、1回あたり（PL1）。5ペアだけの数は、ここで初めて出す。
  - 利確16が先の割合と、1回あたり（説明だけ）。
  - オーナーの持ち方（指値・利確10・損切りなし）:
    - (a) の `ultra15-a.csv`（sha256 ce4c6ace…70c2）の、1日後の値 v1d をつなぐ。
    - 出すのは、1日後の平均と、1日後に −30 pips 以下の割合（B30）。
    - 1日以内の利確の割合には、「損切りが無いので作りの上で高く出る」と必ず添える。
  - 参考の行（先に決めた。判断には使わない）:
    - 残したメールだけで回した30万円の口座（§8.102 の口座の作りに、流れの条件を足したもの。② と同じ形）。
    - 損切りなしで持った1通ずつの、利確した時か5取引日後の値（残したメールと全部のメール）。
  - 通数: 全部・残す・外す。1週あたり。買い・売り別。
- 勝率は、いつも1回あたりの pips と並べて出す。
- メールの水準での1回あたり（PL2・PL1）は、決着した取引では勝率からほぼ決まる（PL2 ≒ 23×W2 − 13 − スプレッド）。そのため「1回あたりが下がらない」は、W2 と別の守りにはあまりならない。オーナーが実際に持つ形（損切りなし・何日も持つ・口座）は、上の参考の行で見る。

**4. 比べ方**
- 層: ペア × 向き（5 × 2 ＝ 10層）。
- δ（デルタ）:
  - 層ごとに「残したメールの平均 − 外したメールの平均」を出し、外したメールの数で重みを付けて平均する。
  - 0より上なら、外したメールの方が悪かった（ルールが効く向き）。
  - W2・PL2・W1・PL1・v1d で出す。B30 だけは「外した − 残した」。
- オーナーに先に見せる差は、層でそろえた「残したメール − 全部のメール」と、その幅。これは、オーナーが受け取るメールが良くなる大きさ（外す割合が2割なら δ の約2割）。δ はその次に並べる。生の数は、買いと売りを分けて出す（流れの条件で、買いと売りの混ざり方が変わるため）。
- 層に分ける理由: ペアと向きの混ざり方の違いを消すため（この期間は、どのペアも買いの方が良かった）。
- 週ではそろえない（② と違う）。
  - 流れは何日も続く。週でそろえると、ルールが使う差そのものが消える。
  - 4時間足では、比べる相手のいない週も多くなる。
  - 週・ペア・向きでそろえた δ は、説明として並べる。
- 区間（説明として並べる）:
  - 層の平均の誤差も入れた標準誤差（影響関数）を使う。
  - T の週ごとと、4週ごとにまとめて出し、広い方を使う。4週のまとまりが10に足りない時は、週ごとだけを使う。
  - t(C−1)、両側95%。
- **決めるのは、ランダムな外し方との比べ（並べ替えの検定）**:
  - 理由: 残すメールが1〜2割と少ない時、上の区間は「残した方が良く見える」側に甘くなる（見直しで、(a) の前半の成績を流れで分けずに使って確かめた）。
  - 作り方: 調べる候補と同じ「層ごとの外す数」で、メールを塊ごとにランダムに外す形を2,000通り作る。塊は、ペア・向き・日、ペア・向き・週、全ペア・向き・日、全ペア・向き・週 の4種類で、各500通り。どれも流れでは分けない。
  - それぞれで δ_W2 ÷ 標準誤差（t）を出す。4種類それぞれの上から2.5%の点のうち、一番高いものを「ランダムの線」とする。
  - 本物の t がランダムの線より上なら「ランダムに外した場合より良い」とする。線は、決める半分の成績で作る。
- 生の数（そろえない）: 残したメール・全部のメールの成績。オーナーが受け取るメールの成績そのもので、8 の条件にも使う。
- 物差し（説明だけ）: わざと1本先の足まで入れたラベルで作った δ。先読みがあるとどう見えるかを示す。

**5. データの分け方**
- メール: (a) の合図。§8.102 と同じ作り（`signalsOf`）で、2024-01-01〜2026-10-03、9,510件。
- 前半（選ぶ）:
  - T が 2025-05-19 00:00 UTC より前のメール。
  - そのうち、5取引日の追う窓と P＋24時間が 2025-05-19 より前に終わるものだけを使う。後半の値段は1本も使わない。
- 後半（1回だけ確かめる）: T が 2025-05-19 以後で、追う窓が 2026-10-03 00:00 UTC までに終わるメール。
- (a) は、どちらの半分も流れで分けたことが無い。全体の数は見ている（「前から知っていること」）。後半の一部は、似た問いで §8.46・§8.73・§8.90 がすでに見ている。
- これからのメール: R_trend 以後に送ったメール（§8.102 の (b) の ledger）。
  - R_trend ＝ この決まりを main にマージした後の、最初の 00:00 UTC。**2026-10-10 00:00 UTC**（日本時間 10/10 9:00）。PR #185 を 2026-10-09 11:05:15 UTC にマージした（merge 27b6bf4）。
  - 置き直し（2026-10-10、12 の4 の言えないの文を1か所変えたため）: 新しい R_trend は、その変更を main にマージした後の最初の 00:00 UTC。**2026-10-11 00:00 UTC**（日本時間 10/11 9:00）。PR #190 を 2026-10-10 11:15:12 UTC にマージした（merge d9ab18e）。9 の確かめと 12 の7 は、この新しい R_trend から数える。
  - 9 の確かめまで、流れで分けた割合を出さない（12 の7）。
- 使わないもの:
  - 2023年11〜12月。理由は、1通ずつの値をすでに出していること（§8.103）、8週しかないこと、1時間足・4時間足の窓もそろわない見込みであること。
  - ほかの GMO のペア。
  - Dukascopy。
  - 2026-10-06〜10-09 のメール。きっかけなので、例にだけ使う。

**6. 段0（成績を読まない）**
- (a) のすべてのメールに、C の時の1時間足・4時間足・15分足のラベルを付ける。成績を計算するコードは読み込まない。
- 出すのは数だけ: 候補・半分・向きごとの、残す・外す・読めない通数、1週あたりの通数、残すメールがある週の数（向きごと）。
- 数の決まり（満たさない候補は、成績を見ずに落とす。落とした理由と数を書く）:
  - どちらの半分でも、残すメールと外すメールがそれぞれ300通以上で、30週以上にわたる。
  - どちらの半分でも、買い・売りのそれぞれで、残すメールが50通以上で、40週以上にわたる。
  - 読めないメールが、どちらの半分でも2%以下。越えたら、成績を読む前に止めて理由を調べる。
- ラベルを `research/ledger/trend-labels.csv` に書き、その sha256 を TS と Python の定数にして commit する。段1・段2は、ファイルの sha256 が定数と違えば、何も計算せずに止まる。
- 例（12 の5）のために、(b) の ledger の 10/7・10/9 の行にもラベルを付ける。出すのはラベルだけで、成績は出さない。

**7. 段1（前半で1つ選ぶ）**
- 6 を通った候補ごとに、前半の δ を出す。
- 選べる候補の条件（どれも点で見る）:
  - δ_W2 が0より上。全体でも、買い・売りそれぞれでも。
  - δ_PL2 が0以上。
- 選び方: 選べる候補のうち、t（δ_W2 ÷ 標準誤差）が一番大きいもの。同じなら、残すメールが多い方。
- 前半でも、選んだ候補の t と、前半の成績で作ったランダムの線（4）を並べる（説明。選び方には使わない）。
- 選べる候補が無ければ、そこで終わる。「前半で、流れの条件で良くなるものは無かった」と書き、後半は開けない。
- 記録:
  - 選んだ候補・前半の表・ランダムの線を docs に書く。
  - `research/ledger/trend-choice.json` と、その sha256 の定数を commit する。段2は、この定数が無いと走らない。
  - 選ばなかった候補は、後半で計算しない。
- 前半の数字には、「4つから良いものを選んだので、良く見えやすい」と添える。

**8. 段2（後半で1回だけ確かめる。選んだ候補だけ）**
- 次のすべてを満たしたら「採用候補」:
  1. 勝率が上がる:
     - 本物の t が、後半の成績で作ったランダムの線より上（4）。
     - 生の数でも、残したメールの W2 が全部のメールより高い。
  2. 1回あたりの損益が下がらない:
     - δ_PL2 が0以上。
     - 生の数でも、残したメールの PL2 が全部以上。
     - メールに出している数（W1・PL1）も、残したメールが全部以上。
  3. 損切りなしの持ち方で悪くならない: δ_v1d が0以上で、δ_B30 も0以上。
  4. 買い・売りの両方で、δ_W2 が0より上。
  5. 確かめ（11）がすべて通り、「100%に近い」合図が出ていない。
  - 2〜4 は点で見る（区間は並べるだけ）。
- 書く文（先に決めた。1つだけ書く。文は 12 の4）:
  - 採用候補: 1〜5 をすべて満たす。
  - 悪い: δ_W2 の区間（4）の上の端が0より下。
  - 一部が悪い: 1 は満たし、2〜4 のどれかを満たさない。
  - 言えない: それ以外。
- 選んだ候補の、メールごとの行を `research/ledger/trend-h2.csv` に commit する。

**9. これからのメールで、悪くなっていないかを1回だけ確かめる**（8 が「採用候補」の時だけ）
- これは「悪くなっていないか」の確かめで、「良くなった」の確かめにはならない（8週では、効果が無いルールでも約半分は通るため。見直しで計算した）。オーナーにもそう伝える。
- 使うメール: R_trend 以後に送ったメール（(b) の ledger）。
  - C は、送った時刻より前の最後の15分足の確定。
  - 同じ作りでラベルを付ける。ラベルは比べる run でまとめて作る（確定した足だけを使うので、後で作っても同じ）。
- 成績は、3 と同じ測り方。v1d は §8.102 の作りで計算する。
- 比べる時:
  - R_trend から8週たった後の、最初の月曜の run で1回だけ。
  - 残す・外すメールのどちらかが30通に足りなければ、16週の run で1回だけ。
  - それでも足りなければ「数が足りない」で、メールは変えない。
- 区間は、週ごとのまとまりで作る（4週のまとまりは使わない）。
- 明らかに悪い: δ_W2 か δ_PL2 の95%区間の上の端が0より下。
- 明らかに悪くなければ、メールを変えるかをオーナーに決めてもらう。明らかに悪ければ変えない。
- R_trend の置き直し:
  - この節の決まりをマージの後に1か所でも変えたら、変えた決まりを main にマージした後の最初の 00:00 UTC を、新しい R_trend にする。
  - プログラムの誤りを直しただけなら、変えない。

**10. メールを変えた後**（オーナーが決めた時だけ）
- 出さなかった合図も、`signal_alerts` に status 'skipped'・理由 'trend' で残す。
- 本番のラベルの読み方:
  - 15分足を読むのと同じ巡回で作る（メールを遅らせない。#171）。
  - 1時間足・4時間足の答えにも、確定前に作られた答えを読み直す仕組み（`staleForClose`）を当てる。読み直しても古ければ、ラベルは読めないとし、メールを出して数える。
  - メールごとに、ラベルが使った最後の足を記録する。
  - 最初の1週は、本番と研究のラベルを照らす。毎時ちょうど（:00）と4時間足の確定の時刻のメールも含め、使った最後の足まで比べる。
  - チャートのダウの表示は、確定から最大90秒ほど遅れて変わる。メールに書く時は、そのことを添える。
- ラベルが読めない時は、メールを出す。
- メールに「1時間足のダウ: 上昇（買いと同じ向き）」のような1行を足す。
- 26週後に1回だけ見直す。δ_W2 か δ_PL2 の点が0より下なら、元に戻して報告する。
- ② と (b) の数え方への影響は、変える前に決めて docs に書く。

**11. 確かめ**（実データの数字を出す前に行う。1つでも外れたら数字を出さない）
- データ:
  - GMO の読み込みの失敗が0。
  - 1時間足・4時間足の最初の足の時刻（本数だけを数え、値段は読まない）。
  - 1時間足・4時間足と、15分足から作った足の食い違いの数。金曜の 21:00 UTC より前に作られた1時間足のファイルも含める。
  - 穴の数。
- 今までと同じに出ること:
  - `ultra15-a.csv` の1行ずつが、作り直した合図のちょうど1つに当たる。作り直した合図のうち行の無い8件は、(a) の CSV が書かなかったもの（P が無い、または P＋1日が END を越える）とちょうど同じで、それぞれの理由を出す。
  - v1d は、1行ずつ1回だけつながる。
  - 利確4の件数と pips が、tf-winrate（PAIRS=5）と同じ。利確10・16にも広げる。
  - dow-hit のコードを lib に分けた後も、作り物での出力の sha256 が同じ。
- 先読み（時間足ごとに、「C までに確定していない足」＝始まり＋長さ ＞ C の足で決める）:
  - 切った確かめ: C までに確定していない足は、時刻だけを残して値段を空にして作り直したラベルが、全件同じ。
  - 毒の確かめ: C までに確定していない足の値段を ±777.7 pips 書き換えても（時刻は残し、300本・301本の数え方は変えない）、ラベルが1つも変わらない。成績は変わること。
  - チャートの確かめ:
    - `fetchDowQuotes` → `splitBars` → `dowOf` と比べる。
    - メールの時刻 2,000か所以上で比べる。月曜の始まり（00:00〜03:45 UTC、最新の4時間足が日曜 20:00 の足になる時刻）・年明け・夏時間の切り替わりを含める。
    - 状態・本数・最初と最後の足が、全部同じであること。
  - 成績の側: 5分足の T より前を書き換えても、成績が変わらない。
- 手の例:
  - 15:00〜20:59 UTC の足の日のファイルの鍵（GMO の日は 21:00 UTC 区切り）。
  - 金曜・土曜の鍵。
  - 日本時間の年の境目の4時間足。
  - 作り物の4時間足の時刻が、本物の GMO の区切り（0・4・8… UTC）と同じこと。
- 作り物の値動き:
  - GMO のファイルの形で書き、同じ読み込みで読む。種と強さは run の前に固定する。
  - 1時間足・4時間足のファイルは、GMO の区切り（始まり＝floor(t/長さ)×長さ）で作る。日曜 20:00 UTC の4時間足を残し、夏の金曜の 20:00 UTC 台の足も作る（本物の GMO と同じ）。tf-winrate の作り物の4時間足（21時からの区切り）は使わない。
  - 効果なし20通り（候補ごと）:
    - 4つの候補を合わせて、後半の区間が0をまたがなかった割合を出す。その割合の95%の上の端が10%以下なら通る。
    - 全部の手順で「採用候補」になるのは、合わせて80通りのうち4つ以下。
  - 流れが続く値動き10通り: ① の後半の δ_W2 が、8つ以上で0より上。
  - 流れが戻る値動き10通り: ① の後半の δ_W2 が、8つ以上で0より下。
  - ペアごとに一定の上げ下げ4通り: δ_W2 の区間が、3つ以上で0をまたぐ。そろえない差は並べる。
  - 答えを知ったラベル（次の4時間の中値の向き）: δ_W2 が30ポイントを超える。先読みがあればこう見える、という物差し。
- 仕込んだ誤り（どれも見つかること）:
  - 形成中の足を窓に入れる。
  - 毎時の途中の C で、確定していない1時間足・4時間足の値段を使う（毒の確かめで見つかること）。
  - 1本先のラベルを使う。
  - 買いと売りを取り違える。
  - 兆しの向きを取り違える。
  - T−15分で読む。
  - 遅れた合図を T から追う。
  - 層から向きを外す。
  - 層の平均の誤差を区間から外す。
  - ランダムな外し方を層の外す数とそろえない。
  - 前半の mode で後半のメールを追う。
  - 前半の終わりをまたぐメールを残す。
  - sha256 を間違える。
- Python（別に書く）:
  - GMO のファイルを、自分の鍵の一覧で読む。
  - ダウとチャートの窓・ラベル・5分足の追い方・δ・区間・ランダムな外し方（同じ種）・選び方・文を、計算し直す。
  - ラベルは全件同じ。数は 1e-9 以内。選んだ候補と文が同じ。
- 出す数を絞る:
  - 決めた項目だけを print.txt に書く。
  - 前半の mode は前半だけ、後半の mode は選んだ候補だけを出す。
- 数字の後（毎回同じことをする）:
  - 件数を照らす。全部 ＝ 数えた ＋ 理由ごと。数えた ＝ 残す ＋ 外す。
  - 先読みの確かめの数を読み直す。
  - 次のどれかに当たったら、報告の前に、先読みと測り方の誤りを疑って調べる（CLAUDE.md・§8.84）:
    - 残したメールの W2 が80%以上。
    - 残したメールの W1 が90%以上。
    - |δ_W2| が10ポイント以上。
    - PL2 が1回あたり +3 pips 以上。
    - どれかの割合が100%。
    - ① か ② が「採用候補」で、§8.46・§8.90 と食い違う。
  - 数字を読んだ後にプログラムの誤りを直したとき:
    - 前の数字と文はそのまま残し、隣に「数字を見た後に直した」と書く。
    - 文が変わったら、後半は「選ぶのに使っていないデータ」での確かめとして数えない。これからのメールだけで決める。

**12. オーナーに見せるもの**（日本語で短く。勝率は、いつも1回あたりの損益と並べる）
1. 測る前（2026-10-09 に伝えた）:
   - 流れ（チャートのダウ）の条件を4つ、先に決めてから測る。チャートだけを使い、ニュースは使わない。
   - ①〜④ の条件。逆向きとは、買いのメールで下降・下降の兆し、売りのメールで上昇・上昇の兆しのこと。
   - 2024年1月〜2025年5月のデータで1つ選び、選ぶのに使っていない2025年5月〜2026年10月のデータで、1回だけ確かめる。
   - 勝ちは「利確10 pips が損切り13 pips より先」。1回あたりの pips と、メールに出している利確4の勝率も、必ず並べる。
   - 使うのは、勝率が上がって、1回あたりの損益も下がらない時だけ。そのあと、これからのメールで悪くなっていないかを見てから、メールを変えるかを決めてもらう。
   - 差が5〜10ポイントより小さいと、見分けられない。これまでの研究では、流れを読む道具で先は当たっていない。「良くなるとは言えない」になる見込みが高い。
2. 段0の後:
   - 「数えただけの結果です（成績はまだ見ていません）。(a) の期間（2024年1月〜2026年10月）で、今の5ペアのメールは週 約66通でした。①なら週 約__通、②なら約__通、③なら約__通、④なら約__通になります。」
   - 落とした候補があれば、その理由を添える。
3. 前半の後:
   - 表を出す。列は、全部・残す・外す。行は、次の5つ。買いと売りは分けても出す。
     - 通数（1週あたり）。
     - 利確10が先の割合と、1回あたり。
     - 利確4が先の割合と、1回あたり。
     - 1日後に −30 pips 以下の割合（損切りなし）。
     - 1日後の平均。
   - 「選んだのは〈ルール〉です。4つから良いものを選んだので、この数字は良く見えやすく、判断には使いません。」
   - 選べる候補が無い時は、こう書く。「前半で、4つのどれも決めた条件を満たしませんでした。ここで終わります。流れの条件で良くなるものは見つかりませんでした。メールは今のままです。」
4. 後半の後（4つの文から1つだけ）:
   - 採用候補:
     - 「選ぶのに使っていない後半（__週）で、〈ルール〉で残したメールは、利確10が先 __%・1回あたり __ pips でした。全部のメールでは __%・__ pips、外したメールは __%・__ pips です。
     - ペアと向きをそろえると、受け取るメールの勝率は +__ポイント（95%の幅 __〜__）。ランダムに同じ数を外した場合より良い結果でした。メールは週 約__通から約__通になります。
     - 損切りなしで持った場合も、1日後に −30 pips 以下の割合は __% から __% になり、1日後の平均は __ pips から __ pips で、悪くなっていません。
     - これからのメールで8週たった所で、悪くなっていないかを1回だけ確かめます（良くなったことの確かめにはなりません）。そのあと、メールを変えるかを決めてもらいます。」
   - 言えない: 「後半では、〈ルール〉を付けても、勝率が上がるとは言えませんでした（残した __%・__ pips、全部 __%・__ pips、外した __%・__ pips）。ランダムに同じ数を外した場合と区別できませんでした。差が無いという意味ではありません。__ポイントくらいの差は、この数では見分けられません。メールは今のままです。」
     - （2026-10-10 に変えた。段2の作りの見直し）「ランダムに同じ数を外した場合と区別できませんでした。」は、t が無いか、t が後半のランダムの線以下の時だけ書く。t が線を越えたのに言えないになった時は、この1文の代わりに「t は __ で、ランダムの線 __ を越えましたが、〈生の数で、残したメールの W2 が全部以下でした／調べる合図〈名前〉に当たりました〉。そのため、決めた条件を満たしません。」と書く（事実と違う文を書かないため）。この変更で、9 のとおり R_trend を置き直す。
   - 悪い: 「後半では、外したメールの方が良い結果でした（差 __ポイント、95%の幅 __〜__）。このルールは良いメールを外す側でした。使いません。」
   - 一部が悪い: 「勝率は上がりましたが、〈1回あたりの損益／メールの利確4の数字／損切りなしの1日後／買いか売りの片方〉が悪くなったので、使いません（__）。」
5. 例（証拠ではない）:
   - 「10/9 のユーロ/円の売りは、メールの時刻に1時間足 __・4時間足 __・15分足 __ でした。〈ルール〉なら、__通が外れ、__通が残っていました。
   - 10/7 のユーロ/ドルの買い8通は、__通が外れ、__通が残っていました。
   - この日を見て思いついたので、ルールが効く証拠にはなりません。」
6. いつも添える:
   - 「利確10・損切り13で損益ゼロに要る勝率は、約57%（スプレッド別）です。勝率100%には遠い数字です。
   - 損切りなしで1回ごとに数えた勝率（約99%）は、損切りが無いので作りの上で高く出ます。そのため、判断には使っていません。」
7. 学び方（#251 とのつながり）:
   - 「外れたメールは、毎朝、その時のチャートの形（ダウの向きなど）と一緒に報告します。勝ったメールの同じ数も、必ず並べます。負けだけを見ると、どんな条件も効いて見えるためです。
   - 1通や1日の外れでは、決まりを変えません。外れに多い形は、次に試す候補として記録します。今回のように先に決めて、選ぶのに使っていないデータで確かめてから直します。後から合わせた設定は、#132・#133 で後で悪くなったためです。」
   - R_trend 以後のメールについて、この節の候補で分けた割合（何%が逆向きだったか、逆向きのメールの勝率など）は、9 の確かめが済むまで出さない。8 で「採用候補」にならなかったと決まった場合は、その時点で出してよくなる。1通ずつの向きは出してよい（9 は「悪くなっていないか」の確かめで、「まだ見ていないデータ」の確かめとは言わないため）。

**13. しないこと**
- 前半で選ぶ前に、後半を流れで分けない。選ばなかった候補を、後半で計算しない（誰でも。計算したら「見た」と書く）。
- 結果を見てから、次のものを変えない。変えたら R_trend を置き直し、後半は「選ぶのに使っていないデータ」として数えない。
  - 候補。
  - ラベルの作り。
  - 測るもの。
  - 比べ方。
  - 条件。
  - 文。
- 結果を見て、条件を足したり重ねたりしない（§8.24 のルール4）。
- 「外したメールの方が良かった」からといって、逆張りのルールにしない。
- ニュース・経済指標の予定を使わない。
- 「採用候補」とオーナーの決定の前に、メールを変えない。
- R_trend 以後のメールを、9 の確かめまで流れで分けて集めない。毎週の (b) の出力も、流れで分けない。
- 10/6〜10/9 のメールを、証拠に使わない。
- 損切りなしの1回ごとの勝率（約99%）を、良くなった証拠に使わない。
- (a) を時間帯で分けない（§8.103 の約束）。
- 試した候補は、負けたものも含めて、この節に残す。

**見込み**（どれも測っていない）
- メールの数: 前半は約4,700通・73週、後半は約4,600通・72週（(a) の行数から見込んだ）。
- 見分けられる差（10回に8回見つかる大きさ）。利確10が先の割合で、次のくらい。
  - 残すメールが半分なら、約5〜6ポイント。
  - 残すメールが1〜2割なら、約8〜12ポイント。
  - 残したメールと全部のメールの差は、その（1 − 残す割合）倍になる。
- 本当の差は −2〜+2ポイントくらいの見込み（「前から知っていること」）。「言えない」になる見込みが高い。
- 流れに沿うメールだけを残すと、残るのは1〜5割くらいの見込み（#103 では約13%）。
- 作業の時間: 段0〜段2で約1〜2週間。これからのメールでの確かめは、R_trend から8週後。

**見直しで直したこと**（2026-10-09。反証の指摘のうち大きめの5つ。どれも成績を見る前）
- 決めるのを、区間ではなくランダムな外し方との比べにした（4・8）。残すメールが少ない時、区間は甘くなるため。数の決まりに、向きごとの週の数を足した（6）。
- これからのメールの確かめを「悪くなっていないか」の確かめと書き直した（9）。8週では、良くなったことは確かめられないため。週ごとのまとまりにした。
- 先読みの確かめを「C までに確定していない足」で決め直した（11）。毎時の途中の C で、形成中の1時間足・4時間足の値段を使っても見つからない作りだったため。
- 本番で使う時の読み方を決めた（10）。メールを遅らせず、1時間足・4時間足にも確定前の答えの読み直しを当てる。
- 毎朝の報告（#247・#251）で、R_trend 以後のメールを流れで分けた割合を出さないことにした（12 の7）。1通ずつの向きは出してよい。
- ほかに、小さめの指摘も直した: 後半がまったく新しいデータではないこと・見込み（−2〜+2）・オーナーに先に見せる差（残したメール − 全部）・メールの水準の1回あたりは勝率からほぼ決まること・作り物の効果なしの合わせ方・遅れた合図・チャートの確かめの run（§8.94）・足のファイルの鍵・作り物の1時間足と4時間足の区切り・(a) の合図と CSV の行の数（9,510 と 9,502）。


**段0の作り**（2026-10-09。実データの数を見る前に決めた細部。上の決まりは1か所も変えていないので、R_trend はそのまま）
- プログラム:
  - `research/trend.ts`（MODE=stage0 が実データ、MODE=syn が作り物）。成績を計算するコードは読み込まない。
  - `research/trend-labels.ts`: dow-hit のラベルの作りとチャートとの照らし合わせを、lib に分けたもの。分ける前と後で、dow-hit の作り物の出力の sha256 が同じだった（38e0e23b…5c15、96d775c5…d66b。11 の「今までと同じに出ること」）。
  - `research/trend-data.ts`: GMO の足を、どのファイル（鍵）から来たかつきで読む。作り物の値動きも作る。
  - `research/trend-check.py`: Python で別に計算し直す。
  - `.github/workflows/trend.yml`: push では作り物と仕込んだ誤りだけを走らせる。実データは dispatch（stage0=yes）の時だけ。
- 合図: §8.102 の (a) と同じ（`signalsOf`、2024-01-01〜2026-10-03、15分足は12日前から読む）。
  - `ultra15-a.csv` と1件ずつ照らす（T・ペア・向きだけを読み、1日後の値は読まない）。行の無い8件は、理由つきで出す。
    - 8件すべてが「P＋1日が END を越える」（このプログラムで計算できる理由）であること。ほかの理由のものがあれば止めて、手で調べる（下の見直しで足した）。
- 足を読む範囲:
  - 15分足は (a) の始まりの12日前から、1時間足は45日前から、4時間足は前の年の1月1日から。
  - 終わりは 2026-10-09 12:00 UTC。10/9 の最後の例（08:45 UTC）の後の4時間足が確定する時刻。run はその1時間後より後に走らせる。
- 説明のつかない穴: 窓の足どうしの間か、窓の最新の足と C の間の、30分以上の抜けのうち、市場の休みでも GMO の休みでもないもの（窓の最新の足と C の間は、下の見直しで足した）。
  - GMO の休みは、データのある5ペアすべてがまたがる刻みのうち、8割以上（4ペア以上）に足が無いもの。§8.90 の作り（14ペア）を5ペアにした。
  - GMO の休みが、足があるはずの時間で数えて4日以上続いていたら止める（下の見直しで足した）。すべてのペアで同じファイルが落ちると休みと数えられ、その後のラベルが、古い窓のまま読めるとされるため。作った5日の休みで、この確かめが外れることも毎回見る。
- ③ の読めない（下の見直しで、書いていなかったのを書いた。プログラムは前からこの形）:
  - 1時間足か4時間足のどちらか（または両方）が読めないメールは、③ では読めないと数え、比べから外す。1時間足が読めて逆向きでない（③ でも残ることが決まっている）メールでも同じ。
  - 理由: 比べに入るかを判定で変えず、残す・外すを、両方が読めるメールの同じ集まりで比べるため。「判定が決まる時は残す側に数える」読み方では、読めない区間のメールが残す側にだけ入る。ランダムな外し方の比べ（4）でも、ルールでは外せないメールを外せることになる。
  - ③ の読めない数は、① と ② の読めないメールを合わせた数になる。2% の決まり（6）もこの数で見る。print.txt に、その内わけ（1時間足だけ・4時間足だけ・両方）も出す。
  - 本番では、どちらでもメールを出す（1）。
- 半分の分け方:
  - 前半の終わり（2025-05-19）と END の21日前より前のメールは、追う窓（5分足1,440本、約5日）がその半分に収まるとする。
  - それより近いメールだけ、5分足を1本ずつ数えて決める。21日で足りること（数えた窓の一番長いものが20日未満）を、run の中で確かめる。
  - 手の例: 前半の終わりか END の3日以内に確定したメールは、どちらの半分にも入らないこと。
  - 追う窓は C から数える（遅れた合図は T＋15分から。§8.106 1）。窓が届く長さ（21日で足りるかの確かめ）は、確定の T から測る。
  - 手の例（遅れた合図）: 各ペア・各境目で、T から追うと半分に収まり、T＋15分から追うと収まらない最後の15分足を探し、遅れた写しがどちらの半分にも入らないこと。
- チャートとの照らし合わせ（11）:
  - すべてのメールの C（3つの時間足すべて）で照らす。
  - そのほかに、毎週の月曜 00:00〜03:45 UTC の15分ごと（最新の4時間足が日曜 20:00 の足になる時刻）と、年明け・夏時間の切り替わりの後の36時間の毎時も照らす。
  - 照らすのは、向き・本数・最初と最後の足の時刻。
- 先読みの確かめ（11）:
  - すべてのメール・すべての時間足で、ラベルの窓のまわり（前後8本）だけで作り直す。
  - C までに確定していない足の値段を、切った確かめでは空（NaN）、毒の確かめでは ±777.7 pips にする。ラベル（向き・窓・読めるか）が1つも動かないこと。
- 例（12 の5）:
  - 10/7・10/9（日本時間）に送った5ペアのメール35通を、DB から書き出した（`research/ledger/trend-examples.csv`。利用者の情報は含まない）。(b) の ledger（ultra15.csv）はまだ無いので、同じ形の別のファイルにした。
  - 同じ足で合図を作り直し、足の時刻と向きで照らして、ラベルだけを出す（成績は出さない）。
- 作り物（11）:
  - 5ペア、2024-10-01〜2025-07-26（年明け・夏時間の切り替わり・前半の終わりを含む）。種は1と2。
  - GMO の週: 日曜 22:00 UTC から、金曜は米国の夏は 21:00 UTC、冬は 22:00 UTC まで（冬の終わりは、土曜の日のファイルに入る足を試すための選び方）。12/25 と 1/1 は休み。
  - GMO の格子で5分・15分・1時間・4時間足を作り、GMO のファイルの形で書いて、同じ読み込みで読む。
  - USD/JPY の 2025-02-12 の1時間足のファイルを空にして、説明のつかない穴の扱いを試す。
  - 作り物には遅れた合図が無いので、50通に1通を「T＋15分で読む」写しにして照らす（数には入れない）。
- 仕込んだ誤り（11）: 次の11通り。それぞれ、決めた TS の確かめ（かっこの中）が見つけること。CI（trend.yml）で毎回確かめる。
  - 形成中の足を窓に入れる（毒の確かめ）。
  - 毎時の途中の C で、確定していない1時間足・4時間足の値段を使う（毒の確かめ）。
  - 1本先のラベルを使う（毒の確かめ）。
  - T−15分で読む（チャートとの照らし合わせ）。
  - 遅れた合図を T で読む（チャートとの照らし合わせ）。
  - 買いと売りを取り違える（候補の判定の手の例）。
  - 兆しの向きを取り違える（候補の判定の手の例）。
  - ファイルの鍵を日本時間の日付にする（ファイルの鍵の照らし合わせ）。
  - 週末の足を始まりの時刻だけで捨てる（#182 より前のやり方。チャートとの照らし合わせ）。
  - 前半の終わりをまたぐメールを残す（半分の確かめ）。
  - GMO のファイルを1つ落とす（読み込みの確かめ。下の見直しで足した）。
  - 仕込んだ誤りは、作り物（MODE=syn）でだけ動く。実データの run で設定すると、何もせずに止まる。
- 手元での確かめ（作り物。種1と2。下の見直しの前。見直しの後は、その中の「確かめ直し」）:
  - TS の確かめはすべて通った。チャートとの照らし合わせ 20,835か所・21,066か所で違い0。先読みの確かめ 8,055か所・8,286か所で動き0。
  - Python と、ラベル（2,630通・2,705通 × 3）・半分・通数がすべて同じ。
  - 仕込んだ誤り10通りは、すべて TS の確かめのどれかが見つけた。Python も8通りで違いを出した（残る2つ、遅れた合図を T で読む誤りとファイルの鍵の誤りは、作り物のラベルを変えないので、Python では見えない。TS が見つける）。
- 気づいたこと（直していない）:
  - GMO の 2026-09-18・09-25・10-02（米国の夏）の金曜のファイルは、20:45 UTC の15分足まであり、20:00 台も値動きがある（`public.gmo_kline_files`）。
  - §8.102 の作り物（`synthOpen`）は、夏の金曜を 20:00 UTC で止めている。本物と1時間違う。§8.102 の本文の「米国の夏の金曜 20:00 UTC 以後 GMO は止まっている」も、この3つの金曜とは合わない。
  - (a) の数字は実データで測ったので、これには関係しない。作り物の確かめの作りだけの違い。冬の金曜がいつ止まるかは確かめていない。実データの run で、週の最後の15分足の時刻を数えて出す。

**段0のプログラムの見直し**（2026-10-09。実データの数を見る前。候補・ラベルの作り方の決まり・測るもの・比べ方・条件・文は変えていないので、R_trend はそのまま）
- 別のエージェントがプログラムを読んで、試した。大きな誤りはなく、小さな指摘が9つあった。
- 9つそれぞれを、別のエージェントに反証させた（Workflow、9体）。7つは「その通り」、2つ（③ の読めない数え方、細かい出力）は「一部その通り」だった。
- 直したこと:
  - 窓の最新の足と C の間の穴も、説明のつかない穴として「読めない」にした（1 の「説明のつかない穴がある時」）。
    - それまでは、窓の中の穴だけを見ていた。GMO がファイルを1つ落とすと、古いままの窓を「読める」としていた。
    - 作り物では、2025-02-12 のドル円の買い2通（14:00・16:00 UTC）の1時間足が、18〜20時間前の足で読まれていた。直した後は「読めない」。
    - 手の例: 作り物のドル円の1時間足で、2025-02-11 21:30 UTC は読める、22:00 と 2025-02-12 14:00 UTC は読めない。
    - dow-hit（§8.90）の測り方は変えていない（その測定は終わっているため。lib の既定のまま）。
    - 残りの穴: すべてのペアで同じファイルが落ちると「GMO の休み」と数えられ、この確かめでも見えない。そこで、GMO の休みが4日以上続いたら止める確かめを足した（段0の作り）。
  - 遅れた合図の半分: 追う窓を C（T＋15分）から数える（1）。窓が届く長さは、これまでどおり T から測る。
    - (a) には遅れた合図が無いので、今は何も変わらない。
    - 各ペア・各境目で、T から追うと半分に収まり、T＋15分から追うと収まらない最後の15分足を探す。その遅れた写しが、どちらの半分にも入らないことを確かめる（作り物で10か所すべて見つかり、すべて正しかった）。
  - 確かめが1つでも外れたら、数が外に出ないようにした（11 の「1つでも外れたら数字を出さない」）:
    - 数・ラベル・print.txt は、TS の確かめと Python がすべて通った時だけ、artifact に残す。外れた時は checks.json だけを残す。ラベルからは数が計算できるので、ラベルも残さない。
    - Python は、違った数の値を出さず、どこが違うかだけを出す。
    - 実データの run では、数と例の判定を print.txt にだけ書き、ログには書かない。
    - 落ちた時は、Deno のエラーとその場所（標準エラー。プログラムは何もそこに書かない）だけをログに出す。それまでは、何も出さずに止まることがあった。手元で、読む時刻の入れ違いと日付の書き違いで、理由が出て数が出ないことを確かめた。
  - 読み込みの確かめ（loads）を、すべての読み込み（半分の5分足、例のファイル）の後に移した。仕込んだ誤りに「GMO のファイルを1つ落とす」を足した。
  - 数の決まり（6）:
    - 候補ごとに、足りない決まりを名前で出す（「落とした理由と数を書く」）。
    - 読めないメールが2%を越えた候補は、「落とす」ではなく「止める」と出す（6 の「越えたら、成績を読む前に止めて理由を調べる」）。
    - 決まりの線ちょうどの数と、1つずつ足りない数（読めないメールは1通多い数）の手作りの表で、TS と Python の両方を試す。作り物は後半が10週しかないので、決まりを満たす側は、作り物では一度も通らないため。
    - Python は、決まりの判定・足りない理由・1週あたりの通数の分母（週の数）・期間全体の通数も、別に計算して照らす。
  - ③ の読めない数え方は変えない（両方のラベルが読めるメールだけで比べる）。書いていなかったので、決まりとして段0の作りに書き、手の例を1つ足した。print.txt に、③ の読めないメールの内わけを出す。
    - もう1つの読み方（判定が読めないラベルで変わる時だけ読めない）も比べた。読めない区間のメールが残す側にだけ入るので、選ばなかった。
  - ファイルの鍵と GMO の決まりの照らし合わせを、毎回すべての足で1回だけ数える（これまでは、仕込んだ誤りの時だけ）。説明の書き違いも直した。
  - 仕込んだ誤りは、作り物でだけ動くようにした。CI では、仕込んだ誤りごとに、決めた確かめが見つけることを確かめる（先読みの3つは毒の確かめ。11 の「毒の確かめで見つかること」）。
  - (a) の行が無い8通は、8通すべてが「P＋1日が END を越える」であることを確かめにした（それまでは数だけで、理由は推測の書き方だった）。
  - 1週あたりの通数は、半分の長さ（日数÷7。前半 72.0週・後半 71.7週）で割る（それまでは、境目の週を両方の半分に数えていた）。期間全体（143.7週）で、各候補なら1週に何通出すか（残す＋読めない。読めない時はメールを出すため）と、どちらの半分にも入らないメールの数も出す（12 の2）。
- 確かめ直し（作り物。種1と2。直した後）:
  - TS の確かめはすべて通った（足した「GMO の休み」「数の決まりの手作りの表」を含む）。チャートとの照らし合わせ 20,835か所・21,066か所で違い0。先読みの確かめ 8,055か所・8,286か所で動き0。作り物の GMO の休みは、いちばん長いもので24時間。作った5日の休み（火曜から翌週の月曜）は119時間で、確かめが外れることを見た。
  - ラベルの sha256: 種1は adcdc64a…（窓の後ろの穴で、上のドル円の2通だけが変わった）、種2は 68410751…（変わらない）。
  - Python と、ラベル（2,630通・2,705通 × 3）・半分・通数・数の決まりと足りない理由・週の数・期間全体の通数が、すべて同じ。わざと変えた数の決まり・理由・週の数は、Python が見つけた。
  - 仕込んだ誤り11通りは、それぞれ決めた確かめが見つけた。Python も9通りで違いを出した（残る2つ、遅れた合図を T で読む誤りとファイルの鍵の誤りは、作り物のラベルを変えないので、Python では見えない）。

**段0の結果**（2026-10-09。Actions run 37947773957、ブランチの 026b145。成績は読んでいない）
- 確かめ（11）: TS の確かめはすべて通った。
  - チャートとの照らし合わせ: 70,095か所で違い0（メールの C 9,510か所・月曜の始まり 11,515か所・年明けと夏時間の切り替わり 2,340か所、それぞれ3つの時間足）。
  - 先読みの確かめ: 切った確かめ・毒の確かめとも、28,530か所で動き0。
  - (a) の CSV: sha256 は決めたもの。9,502行がそれぞれ合図の1つに当たる。行の無い8通は、すべて 2026-10-02 の合図で、どれも「P＋1日が END を越える」。
  - データ:
    - GMO の読み込みの失敗0。ファイルの鍵の違い0。1時間足・4時間足と15分足の食い違い0。
    - 説明のつかない穴は、5ペア・3つの時間足とも0。
    - GMO の休みは年末年始（12/24・25、12/31・1/1）と 2025-09-08 の1時間だけ。いちばん長いもので25時間。
    - 週の最後の15分足は、読んだ足では、5ペアとも146週すべてで 20:45 UTC だった（夏も冬も）。上の「気づいたこと」の、冬の金曜がいつ止まるかへの答え（作り物の確かめの作りだけに関わり、段0の数には関わらない）。
  - 半分: 端の近くの420通を5分足で数えた。いちばん長い追う窓は7.04日。端の3日以内のメールは、どちらの半分にも入っていない。
- Python（別の計算し直し）: ファイルの欠け0。ラベル（9,510通 × 3）・半分・通数（24）・数の決まり（8）と週の数・期間全体の通数（4）が、すべて同じ。
- ラベル: `research/ledger/trend-labels.csv`（9,510行、sha256 897b76cf…b64a）。
  - Actions の labels の job が、sha256 を確かめてから commit した（025f223）。
  - 手元で、このファイルから別に数え直した通数も、print.txt と同じだった。
  - sha256 を TS（`research/trend-labels.ts`）と Python（`research/trend-check.py`）の定数にした。push のたびに trend.yml がファイルと照らす。
- 通数（成績は読んでいない）:
  - (a) の 9,510通（143.7週、週 66.2通）。前半 4,725通（72.0週）・後半 4,653通（71.7週）・どちらの半分にも入らない 132通。遅れた合図は0通。
  - 読めないメールは、4つの候補とも0通（説明のつかない穴が0のため）。
  - 期間全体で、各候補なら出すメール（残す＋読めない）:

| 候補 | 出すメール（1週あたり） | 残す | 外す |
| --- | --- | --- | --- |
| ① 1時間足が逆向きなら出さない | 21.5通 | 3,084 | 6,426 |
| ② 4時間足が逆向きなら出さない | 30.5通 | 4,390 | 5,120 |
| ③ 両方が逆向きなら出さない | 38.1通 | 5,476 | 4,034 |
| ④ 15分足が逆向きなら出さない | 6.0通 | 864 | 8,646 |

  - 半分ごと（残す通数のかっこは1週あたり。買い／売りの通数と、残すメールのある週の数）:

| 候補 | 前半 残す | 前半 外す | 前半 買い／売り（週） | 後半 残す | 後半 外す | 後半 買い／売り（週） |
| --- | --- | --- | --- | --- | --- | --- |
| ① | 1,516（21.1） | 3,209 | 742／774（71／71） | 1,526（21.3） | 3,127 | 755／771（71／71） |
| ② | 2,121（29.5） | 2,604 | 1,009／1,112（68／70） | 2,203（30.7） | 2,450 | 1,233／970（69／68） |
| ③ | 2,671（37.1） | 2,054 | 1,287／1,384（71／71） | 2,731（38.1） | 1,922 | 1,431／1,300（71／71） |
| ④ | 425（5.9） | 4,300 | 197／228（61／62） | 430（6.0） | 4,223 | 220／210（55／60） |

  - 外すメールのある週は、どの候補も前半72週・後半71週。
  - 数の決まり（6）: 4つとも、両方の半分で満たした（落とす候補も、止める候補も無い）。いちばん余裕が少ないのは ④ の後半（残す 430通、残すメールのある週は買い55週・売り60週。決まりは300通・40週）。
- 読み方（成績ではない）:
  - ULTRA の合図は、15分足のダウと逆向きのことが多い（91%）。売りは値段が上がった後に出るため（2 の見込みどおり）。1時間足で逆向きは68%、4時間足で54%、両方で42%。
  - ① や ④ では、メールの大部分を外すことになる。外したメールの方が成績が良いこともありうる（成績はまだ見ていない）。
- 例（12 の5。ラベルだけで、成績は見ていない。証拠ではない）:
  - 10/7 のユーロ/ドルの買い8通は、3つの時間足ともダウが下降（1通だけ、15分足は下降の兆し）で、4つの候補のすべてで外す側になる。
  - 10/9 のユーロ/円の売り5通は、15分足が上昇・1時間足が上昇か上昇の兆し・4時間足が下降で、① と ④ では外し、② と ③ では残す。
  - 35通すべてのラベルは、run の print.txt に出した。
- 次は段1（前半で1つ選ぶ）。プログラムを作り、作り物と別の計算し直しで確かめてから走らせる。

**10/9 の1日の見比べ**（2026-10-09。オーナーの依頼「これを加えた判断の勝率を比べて、今日出してた判断とこれを考慮した場合で」。証拠ではない）
- 何をしたか:
  - 10/9 JST のメール20通（FX 5ペア16通・金4通。2026-10-08 17:45〜10-09 08:46 UTC）に、メールの時刻のダウ（15分足・1時間足・4時間足）と、その後の結果を付けた。
  - FX: `research/trend-day.ts`（GMO の Bid・Ask。ラベルは段0と同じ読み方）。Actions run 37929009561（12:15 UTC までの足）。チャートとの照らし合わせは 48か所で違い0。
  - 金: `research/trend-day-gold.ts`。金は GMO に無いので、チャートが金のダウに使う保存足（`public.live_chart_fallback` の Twelve Data の足。最後の800本の確定足）で読んだ。
    - 結果は5分足の中値（スプレッドなし）で見た目安。4通とも、利確・損切りの時刻を5分足で手でも確かめた。
    - 足は repo に入れていない。DB の md5 と同じことを確かめた（15分足 c82bec42…・1時間足 70cc7526…・4時間足 7a7ba5aa…・5分足 4585b242…。12:04〜12:16 UTC の保存）。
    - 15分足は、メールの足を入れた読みと入れない読みの両方で、4通とも同じ表示（上昇）だった。
- 結果（利確10が損切り13より先。FX は pips、金はドル。未決着は 12:15 UTC の値）:
  - 全部（今の判断）: 20通で 11勝8敗・未決着1（58%）。
    - FX 16通: 利確8・損切り7・未決着1（53%）。決着分の1回あたり −1.0 pips。
    - 金 4通: 利確3・損切り1（75%）。1回あたり +4.25ドル。
  - ① 残す7通: 3勝4敗（43%）。FX 6通 50%・−1.8 pips。金 1通 0%・−13ドル。
  - ② 残す17通: 8勝8敗・未決着1（50%）。FX 14通 46%・−2.7 pips。金 3通 67%・+2.33ドル。
  - ③ 残す18通: 9勝8敗・未決着1（53%）。FX 15通 50%・−1.8 pips。金 3通 67%・+2.33ドル。
  - ④ 残す1通: 0勝1敗（FX、−13.3 pips）。20通のうち19通が、15分足のダウと逆向きだった。
  - 外す側は、どの条件でも残す側より勝っていた（例: ① の外す13通は 8勝4敗・未決着1）。
  - 利確4/損切り13 では: 全部 14勝6敗（70%）。① 5勝2敗（71%）。② 11勝6敗（65%）。③ 12勝6敗（67%）。④ 1勝0敗。
  - 追記（14:38 UTC の run 37945570630。段0の見直しの後の同じプログラムで、足が増えた後）:
    - 未決着だった豪ドル/ドル 15:00 JST の売りは、21:40 JST に利確10に届いた。
    - 全部 20通で 12勝8敗（60%）。FX 16通は 9勝7敗（56%）・1回あたり −0.3 pips。
    - ② 残す17通 9勝8敗（53%。FX 14通 50%・−1.8 pips）。③ 残す18通 10勝8敗（56%。FX 15通 53%・−1.0 pips）。① の外す13通 9勝4敗。① と ④ の残す側は変わらない。利確4は変わらない。
    - ラベルは、窓の後ろの穴の直しの後も同じだった。チャートとの照らし合わせは 48か所で違い0。
- 読み方:
  - この日は、4つのどの条件を足しても、利確10の勝率も1回あたりも良くならなかった。
  - 20通・1日だけで、証拠にはならない（12 の5、13）。この日は前半・後半にも、R_trend 後の確かめにも入らない。
  - 段0は成績を見ないが、この見比べは段0のデータ（2024-01〜2026-10-03 のメール）を使っていない。オーナーの依頼で、10/9 のメールだけの成績を出した。候補・ラベルの作り・測るもの・比べ方・条件・文は変えていない（13）。

**段1の作り**（2026-10-10。前半の成績を1つも計算する前に決めた細部。上の決まり（1〜13）は1か所も変えていないので、R_trend はそのまま）
- プログラム:
  - `research/trend1.ts`: MODE=stage1 が実データの前半、MODE=syn が作り物の全部の手順（前半で選び、後半で確かめる）、MODE=calib が作り物の通る条件。MODE=stage2 は段2で使い、`research/ledger/trend-choice.json` の sha256 の定数が無いと止まる。
  - `research/trend-stats.ts`: 追い方・δ・幅・ランダムな外し方・手の例の部品。`research/trend1-calib.ts`: 作り物の通る条件。`research/trend1-walk.sh`: 作り物1つ（種から値動きの種類を決める）。
  - `research/trend-check.py` に段1を足す。別のエージェントが、この節と上の決まりだけを読んで書く（TS は読まない）。
  - `.github/workflows/trend.yml` に段1の job を足す。
- 走る前の止まり方: ラベルのファイル（`research/ledger/trend-labels.csv`）の sha256 が定数と違えば、足も (a) も読まずに止まる。(a) の `ultra15-a.csv` の sha256 が決めたものと違っても止まる。

**1. 前半のメールと、読むもの**
- メール: ラベルのファイルで半分が H1 の行（4,725通）。読めるか・残すか外すかは、ファイルのラベルで決める（2 の判定。段0と同じ）。
- 足は、前半の終わり（2025-05-19 00:00 UTC）までに確定したものだけを使う。GMO のファイルは日（21:00 UTC 区切り）か年の単位なので、境目のファイル（日の 20250519、年の 2025）は読んでから、時刻で後の足を捨てる。
- E と、入りの Bid・Ask:
  - 15分足から合図を作り直して得る（§8.102 の `signalsOf`。終わりは前半の終わり）。ファイルの行（T が前半の終わりより前）と作り直した合図が、1対1で同じ（T・ペア・向き・遅れ・C。確かめ signals）。
  - E は、合図の足の（Bid の終値＋Ask の終値）÷2 を double で計算し、その正確な値を、ちょうど半分なら上へ丸めて、円のペアは3桁・ドルのペアは5桁にしたもの（チャートの `Number(v.toFixed(d))`、ownerhold-check.py の round_chart と同じ）。例: Bid 150.060・Ask 150.065 → 中値は double でちょうど 150.0625 → E 150.063。
  - 入りの値は、合図の足の終値（買いは Ask、売りは Bid）。遅れた合図は、C で閉じる15分足（合図の次の足）の終値で入る（決まり 1）。水準はどちらもメールの E から。(a) にも作り物にも、遅れた合図は0通。
- 1日後の値 v1d は、(a) の CSV から T・ペア・向きでつなぐ（確かめ aFile: sha256、前半のメールがどれもちょうど1行につながる、その行の P＋24時間が前半の終わりまで）。前半でないメールの行はつながない。
- ラベルは、段0と同じ作り（`loadTf`、5ペアに共通の GMO の休み、`seriesOf`、`labelsOf`）でも計算し直し、前半のすべてのメール・3つの時間足で、ファイルと同じであること（確かめ labelsAgain）。下の物差しが段0と同じ道を通ることの確かめ。

**2. 成績の追い方**（3。tf-winrate の `follow` と同じ）
- 水準は `ultraLevels` と同じ double の式: 損切り E − dir×13×pip、利確 E + dir×n×pip（n は 4・10・16。dir は買い1・売り−1、pip は円のペア 0.01・ドルのペア 0.0001。この順に掛け、丸めない）。プログラムは `ULTRA_PAIRS` が損切り13・利確 4/10/16 であることを確かめる。
- C から始まる5分足（GMO の Bid・Ask。両側がそろった足だけ。週末に全部が入る足は外す。`loadQuotes` と同じ）の最初の足（始まりが C 以後の最初）から、決済する側（買いは Bid、売りは Ask）で1本ずつ見る。比べは double のまま、等号を含む（買いの損切りは 安値・始値 ≦ 水準、利確は 高値・始値 ≧ 水準。売りは逆）:
  - 始値が損切りに届いていれば損切り（始値で）。でなければ、始値が利確に届いていれば利確（始値で）。
  - そうでなければ、1本で両方に届いたら損切り（損切りの値で）。片方だけなら、その水準で。
  - 1,440本で決まらなければ未決着。pips は1,440本目の終値（決済する側）で出す。データが1,440本に足りなければ、追わない（結果なし。前半ではそれ自体が確かめ h1Only の外れ）。
  - double の誤差で、ドルのペアでは損切りちょうどの値段が届かない側に数えられることがある（例: E 1.16427 の買いの損切りは 1.1629699999999998 で、Bid の安値 1.16297 は届かない）。tf-winrate と同じにするため、そのままにする（手の例にする）。
- pips: 買いは（出た値 − 入った値）÷ pip、売りは逆。
- 勝率 W は 利確 ÷（利確＋損切り。両方に届いたものは損切り）。未決着は外す。1回あたり PL は、未決着を含む全部の平均。W2・PL2 は利確10、W1・PL1 は利確4、W3・PL3 は利確16（説明）。
- B30: v1d が −30 ＋ 1e-9 以下なら1、ほかは0（(a) の v1d には浮動小数の誤差があり、−30.0 pips の行が −29.999999999998916 と書かれているため）。
- 確かめ fiveHoles（11 の「穴の数」の5分足の分）: 半分ごとに、メールごとの追う窓（C の前の足から1,440本目まで）で、隣の足との間が30分以上あいていて、市場の休みでも5ペアに共通の GMO の休み（段0と同じ決め方）でもないものの数が0。GMO が5分足のファイルを落とすと、追う窓が黙って伸びるため。
- tf-winrate との照らし合わせ（11。実データだけ。確かめ tfWinrate）:
  - tf-winrate を、5ペア・START 2024-01-01・SPLIT 2025-05-19・END 2025-05-19T00:00:00Z（前半の終わり。後半を読まない）・損切り13・利確 4/10/16・週末 inside で、同じ job の中で走らせる。
  - tf-winrate は前半の成績を標準出力と `tf-winrate.json` に書く。標準出力はファイルに書き、ログには「GMO reads that failed」の行だけを出す。`tf-winrate.json` は確かめだけに読み、残さない（11 の「1つでも外れたら数字を出さない」）。
  - 15分足 ULTRA の利確4・10・16 それぞれの件数（n・利確・損切り・両方・未決着）が、前半のメールの数と同じで、pips の平均が 1e-9 以内。tf-winrate は、データの中で1,440本を追えない合図を外すので、END を前半の終わりにすると、追う合図は前半のメールとちょうど同じになる（またぐメールと、T がちょうど前半の終わりのメールは、どちらでも追わない）。
  - ペアごとの合図の数（T ≦ 前半の終わり。tf-winrate は END ちょうどに閉じた足の合図も数える）も同じ。tf-winrate 自身の合図の確かめ（indicatorSignals との違い）が0。読み込みの失敗0。

**3. δ と幅**（4）
- 層: ペア × 向きの10。並びは、ペア（ドル円・ユーロ円・豪ドル円・ユーロドル・豪ドル米ドル）× 買い・売り。
- 数えるメール: 候補が比べるメール（残す＋外す。読めないものは入れない）のうち、W は決着したもの、PL・v1d・B30 は全部。
- δ ＝ Σ 層 s（n外_s ÷ N外）×（残した平均_s − 外した平均_s）。
  - 残すか外すが0通の層は入れない。N外 は入れた層の外したメールの数の和。入れなかった層の外したメールの数を出す。
  - B30 だけは（外した平均 − 残した平均）。
  - 買いだけ・売りだけの δ は、その5つの層だけで同じ式。
- 層でそろえた「残したメール − 全部のメール」（12 の3 で最初に見せる差）＝（N外 ÷ N全部）× δ。
  - N全部 は入れた層の残す＋外す。層の重みを全部のメールの数にすると、ちょうどこの形になる（Σ (n全部_s ÷ N全部)(残した平均_s − 全部の平均_s) ＝ Σ (n外_s ÷ N全部)(残した平均_s − 外した平均_s)）。
  - 幅も同じ倍率をかける。
- 標準誤差（影響関数。層の平均の誤差を入れる）:
  - 残したメール i（層 s）: (n外_s ÷ N外) ×（y_i − 残した平均_s）÷ n残_s。
  - 外したメール i: −（y_i − 外した平均_s）÷ N外。B30 は符号を逆にする。
  - 塊ごとに足して和 S_g を作り、標準誤差 ＝ √(C ÷ (C−1) × Σ S_g²)。C は、δ に入れた層について、その物差しで数えたメール（W なら決着したもの）がある塊の数。
- 塊:
  - 週: T の週（日曜 21:00 UTC から。`lib.ts` の WEEK_OFFSET）。
  - 4週: 半分の最初の週（前半は 2024-01-01、後半は 2025-05-19 を含む週）から4週ずつ。
  - 幅の半分（t(0.975, C−1) × 標準誤差）が大きい方の塊を使う（決まり 4 の「広い方」）。同じなら週。4週の塊が10に足りない時は週だけ。自由度は、使った方の C − 1。
- 幅: δ ± t(0.975, 自由度) × 標準誤差。t ＝ δ ÷ 使った方の標準誤差。C < 2・N外 ＝ 0・標準誤差が0 の時、t は無い（その候補は選べない）。
- t(0.975, 自由度) は、Student の t の分布を、不完全ベータ関数（Numerical Recipes の betacf）と2分法（幅 1e-12 まで）で出す（`money-stats.ts` の `tQuantile` と同じ作り）。手の例: 自由度 1・9・17・71 で 12.7062047・2.2621572・2.1098156・1.9939434。
- 週・ペア・向きでそろえた δ_W2（説明）: 層を ペア × 向き × 週 にした同じ式の点だけを出す。層が週の中にあるので、影響関数は週ごとに足すと0になり、この作りの幅は0になる（出さない）。使えた外したメールの割合（分母は、その候補の決着した外したメール）も出す。

**4. ランダムな外し方**（4。段1では、選んだ候補の説明だけに使う。段2では決めるのに使う）
- 範囲: 候補が比べるメール（残す＋外す。決着していないものも入れる）。層ごとに、候補が外した数（全部のメールで数えたもの）だけ外し、残りを残す。外した後の δ_W2 と t は、3 と同じ作り（決着したメールで）。
- 塊: 日 ＝ floor((T − 21時間) ÷ 1日)（T は合図の足の終わり。遅れた合図でも T）。週は 3 と同じ。
- 4種類、各500通り:
  - ア ペア・向き・日、イ ペア・向き・週: 層ごとに、その層のメールがある塊を小さい順に並べ、並べ替える。
  - ウ 全ペア・向き・日、エ 全ペア・向き・週: 向きごとに、その向きのメールがある塊（どのペアでも）を小さい順に並べて1回並べ替え、5ペアがその同じ順で取る。
- 取り方（層ごと。ウ・エではペアの順に）:
  - 塊の並べ替えは、外す数が0の層・向きでも、毎回1回行う（乱数を引く）。
  - 並んだ塊を順に見る。その層のメールが無い塊は、乱数を使わずに飛ばす。残りの外す数が0になったら、その層は乱数を使わずに終える。
  - 塊のその層のメールが残りの外す数以下なら、まるごと外す。多ければ、その塊のその層のメール（T の順。同じ T なら遅れていない方が先）を並べ替え、先頭から残りの数だけ外して、その層を終える。
- 乱数: mulberry32（`trend-data.ts` の rng と同じ）。
  - 計算: s ＝ (s ＋ 0x6D2B79F5) を 2^32 で割った余り。t ＝ imul(s xor (s >>> 15), s or 1)。t ＝ t xor (t ＋ imul(t xor (t >>> 7), t or 61)) を32ビットに切ったもの。出力 ＝ ((t xor (t >>> 14)) >>> 0) ÷ 2^32。imul は32ビットの符号つきの掛け算（JavaScript の Math.imul）。
  - 手の例: 種 251,101 の最初の3つは 0.639131162315607・0.965791508089751・0.727509640622884。
  - 種 ＝ 250,000 ＋ 10,000 × 作り物の種（実データは0）＋ 1,000 × 半分（前半1・後半2）＋ 100 × 候補（1〜4）＋ 種類（ア1・イ2・ウ3・エ4）。種類ごとに、500通りをこの順で作る: ア・イは層の並びの順に、ウ・エは向き（買い・売り）ごとに塊の並べ替え → ペアの順に取る。
  - 並べ替えは Fisher–Yates（i を n−1 から1まで下げ、j ＝ floor(rnd() × (i+1)) と入れ替える）。
- t が無い外し方（3 の決まり）は、t を −∞ とする（線を上げない）。その数を出す。
- 種類ごとに、500の t を小さい順に並べた ⌈0.975 × 500⌉ ＝ 488番目を、その種類の線とする。4種類の線の一番高いものが、ランダムの線。
- 確かめ randomCounts: どの外し方でも、層ごとの外した数が候補と同じ。
- 実データでも、前半の線は4候補すべてについて計算する（選んだかどうかで、確かめの名前・数・かかる時間が変わらないように。print.txt には選んだ候補の線だけを書く）。実データの確かめは randomCounts.H1 の1つで、候補の名前を入れない（段1のプログラムの見直しで直した）。

**5. 選び方**（7）
- 6 を通った候補（4つとも。ファイルから数え直した通数で、もう一度確かめる。確かめ floors）について、前半の δ_W2（全体・買い・売り）と δ_PL2 を出す。
- 選べる: δ_W2 が全体・買い・売りのどれでも0より上で、δ_PL2 が0以上（どれも点で）。t が無い候補は選べない。
- 選ぶ: 選べる候補のうち t が一番大きいもの。同じなら、前半の残すメールが多い方。それも同じなら番号の小さい方。
- 選んだ候補だけ、前半のランダムの線（4種類の線と一番高いもの）を、その t と並べる（説明。選び方には使わない）。
- 物差し（4。説明）: 4つの候補それぞれで、ラベルを1本先まで入れたもので前半の δ_W2 を出す。
  - 1本先: C の時に確定していた最新の足の、データの上で次の足（休みをまたいでも次の足）が確定した時の窓（段0の仕込んだ誤り oneBarAhead と同じ作り。窓は、その次の足の始まり＋長さの時刻で読み直す）。C で読めないラベル（窓が無い、本数が足りない、穴がある）は、そのまま読めない。1本先で読めなくなったラベルは、物差しでは読めないとして比べから外す。データの上に次の足が無い時も、1本先では読めない（前半のメールの C は前半の終わりの5日以上前なので、実際には起きない）。
  - 判定が変わったメールの割合（分母は前半のすべてのメール。読めなくなったものも変わったと数える）も出す。
- 書き出すもの: `trend-choice.json`（選んだ候補か「無し」、4つの候補の前半の δ_W2・買い・売り・δ_PL2・t・選べるか、ラベルと (a) の sha256）。選べる候補が無い時も「無し」と書いて commit する（段2は走らない）。

**6. print.txt に書くもの**（11 の「出す数を絞る」。これ以外は書かない）
- 候補ごとの前半の表（12 の3）: 全部・残す・外すの列で、通数（1週あたり。前半は72.0週）・利確10が先の割合と1回あたり・利確4が先の割合と1回あたり・1日後に −30 pips 以下の割合（損切りなし）・1日後の平均。買いと売りも別に出す。全部の列は、前半のすべてのメール（読めないメールは0通）。
- 候補ごとに: 利確16が先の割合と1回あたり（説明）。δ（W2・PL2・W1・PL1・v1d・B30）とその幅・t・使った塊。δ_W2 の買い・売り。層でそろえた「残したメール − 全部のメール」（W2）と幅。週・ペア・向きでそろえた δ_W2 の点。物差しの δ_W2。選べるか（足りない条件の名前）。
- 選んだ候補（または無し）と、12 の3 の文。選んだ候補の t と前半のランダムの線。
- 件数の照らし合わせ（11 の「数字の後」）: 前半のメール ＝ 比べたメール ＋ 読めないメール、比べたメール ＝ 残す ＋ 外す、決着 ＋ 未決着 ＝ 全部。前半のメールはラベルのファイルの H1 の行の数で、残す・外す・読めない・決着・未決着は、それぞれ別に数える（確かめ counts.H1 も同じ。段1のプログラムの見直しで直した）。
- 調べる合図（11 の「数字の後」）に当たったもの: どれかの候補で、残したメールの W2 が80%以上、残したメールの W1 が90%以上、|δ_W2|（全体）が10ポイント以上、PL2 が +3 pips 以上（全部・残す・外す、全体・買い・売りのどれでも）、W1・W2・W3・B30 のどれかの割合が100%。物差しの δ_W2 は入れない（先読みの物差しそのものなので）。当たったら、報告の前に、先読みと測り方の誤りを調べる。
- 3 の参考の行（30万円の口座、損切りなしで持った1通ずつの値）は、段2で、選んだ候補の後半だけに出す（前半の表には入れない）。口座は、後半の始めに30万円で始めた口座（§8.102 の後半の口座の作り）を、全部のメールと、残すメール＋読めないメール（流れの条件を足した時に出すメール。読めないメールは0通）で回す（② のルールの行と同じ形: 注文しないメールを渡す）。

**7. 確かめ**（11。1つでも外れたら数字を出さない。外れた時は checks.json だけを残す）
- labelsFile（sha256。外れたら何も読まずに止まる）・aFile・signals・labelsAgain・fiveHoles・tfWinrate（実データ）・loads（GMO の読み込みの失敗0）。
- h1Only: (1) 使った足（5分足・15分足・1時間足・4時間足）は、どれも前半の終わりまでに確定している。(2) 追ったメールは、ファイルで半分が H1 の行とちょうど同じ。(3) どのメールも、1,440本を読んだ足の中で追えた（追えないメールが1つでもあれば外れる）。
- followHand: 手作りの5分足で、利確が先・損切りが先・1本で両方・始値で越える（両方の向き、買いと売り）・未決着（1,440本目の終値。ちょうど1,440本のデータと、1,441本目が別の値のデータ）・利確4と16（利確10を越えてから16に届く）・遅れた合図（C から追う）・決済する側（買いを Bid で）・ドルのペアの損切りちょうど（上の例）・1,439本しか無いデータ（追わない）。
- sentenceHand: 手作りの条件で、8 の文（採用・悪い・一部が悪い・言えない）が決まりの順で出る（TS と Python で同じ名前 adopt・bad・partBad・cannot）。
- lookBehind（11 の「成績の側」）: すべての前半のメールで、C より前の5分足（300本）を ±777.7 pips 書き換えても、どの成績も変わらない。C から始まる最初の足を ±777.7 pips 書き換えると、すべてのメールの成績（pips）が変わる。
- verdicts（段0と同じ手の例）・floors（ファイルから数え直した通数が 6 を満たす）。
- deltaHand: 手で計算した小さな表で、δ（5/9）・影響関数の標準誤差（11/27。外したメールの誤差を入れないと 2/27 になる形）・t（15/11）・残したメール − 全部（1/3）・B30 の向き・塊の選び方（4週が10に足りない時、幅の半分で比べて4週の方が広い時と狭い時）・t(0.975) の点・mulberry32 の最初の3つ。
- randomCounts。
- Python（別に書く。11）: 前半の行と (a) の行、E と入りの Bid・Ask、5分足の追い方、成績、判定、δ と幅と t、選び方と文、ランダムの線（前半・後半とも4候補すべての、4種類×500 の t を小さい順に並べたもの。実データでは前半の4候補。選んだ候補の線は別にも比べる）、物差しのラベル（時間足ごとの向きと読めない印。emails.csv の ys・yx の列）と δ_W2、件数の照らし合わせが、TS と同じ（数は 1e-9 以内、選んだ候補と文は同じ）。違った数の値は出さず、どこが違うかだけを出す。項目の名前と数は、候補を選んだかどうかで変わらない。

**8. 作り物**（11）
- 期間は実データと同じ（2024-01-01〜2026-10-03、前半の終わり 2025-05-19）。5ペア。`trend-data.ts` の値動きを GMO のファイルの形で書き、同じ読み込みで読む。ラベルと半分は `trend.ts`（MODE=syn）がつける。期間と値動きの種類は環境変数で渡し、渡さなければ段0のまま（段0の作り物のラベルの sha256、種1 adcdc64a…・種2 68410751… が変わらないことを、CI で毎回確かめる）。この作り物では、チャートと先読みの確かめ（段0で済んだもの）を省く（LIGHT。省いたことを checks.json に書く）。
- 作り物には (a) の1日後の値が無い。そのため v1d・B30 は出さず、全部の手順の 8 の3 は「満たした」と数える（採用が多めに出る側）。8 の5 は、作り物の run の確かめ（LIGHT で省いたものは通ったと数える）がすべて通り、調べる合図（6）がその候補に当たっていないこと。
- 値動きの種類（効果は、ふつうの値動きに足す。効果の乱数は別の列から引くので、効果の無い部分は効果なしの作り物と同じ）。強さと長さは、試しの run（種 901〜913。正式な種は使わない）で選んだ:
  - 効果なし: 種 101〜180。決まり 11 の「効果なし20通り（候補ごと）」のとおり、候補ごとに別の20通り（① 101〜120、② 121〜140、③ 141〜160、④ 161〜180）。どの run でも4つの候補を計算するが、通る条件には、その候補の20通りだけを数える。
  - 流れが続く: 種 201〜210。ペアごとに向き（上か下）を持ち、5分ごとに 5 ÷ (60 × 72) の確率で入れ替わる（平均72時間）。1分あたり、向き × 0.03 × そのペアの1分の動きの大きさ だけ動く。試し: 平均36時間・0.03 で ① の後半の δ_W2 +3.2ポイント、36時間・0.05 で +2.2・+2.7、72時間・0.03 で +4.3・+2.2。
  - 流れが戻る: 種 301〜310。中心に向かって、1分あたり ln 2 ÷ (60 × 4) の割合で戻る（半減期4時間）。中心は、1分あたり 0.3 × そのペアの1分の動きの大きさ でランダムに動く。試し: 半減期6時間で −4.7、4時間で −6.4・−7.7。
  - 一定の上げ下げ: 種 401〜404。5ペアとも上へ、1分あたり 0.012 × そのペアの1分の動きの大きさ。下げを強くすると、値の低いペアが期間中に0に届くため、5ペアとも上にした（このため、この作り物が試すのは向きの層の効き目で、ペアの層の効き目は試さない）。試し: 買いと売りの W2 の差が約8ポイント、① の前半の残した − 外した（そろえない）が +4.9ポイント。
  - 答えを知ったラベル: 種 101〜104 の値動きで、1時間足のラベルを、C から4時間後の中値の向き（C と C＋4時間のそれぞれで最新の確定した5分足の中値の終値。上なら上昇、下なら下降、同じなら判定なし）に替えた run。① の後半の δ_W2 を出す。
  - dispatch で回すのは、合わせて108 run（効果なし80・流れが続く10・流れが戻る10・一定の上げ下げ4・答えを知ったラベル4）。
- 通る条件:
  - 効果なし: 80（4候補 × それぞれの20通り）の後半の δ_W2 の幅のうち、0を含まないものの割合を p とする。p ＋ 1.96 × √(p(1−p) ÷ 80) が10%以下なら通る（6 を通らない候補の幅も80に数える）。
    - 割合の幅は正規近似にした（80のうち4つで 9.8%、5つで 11.6%。4つ以下で通る）。正確な二項の幅（Clopper–Pearson）では2つ以下しか通らない。
    - 幅が正しくても（本当に5%）、この確かめは約37%の確率で外れる（Clopper–Pearson なら約77%）。本当の外れが6%なら約53%、7%なら約67%。
    - 外れた時の手順（今、固定する）: 種・数え方・線は変えない。実データは走らせない。checks.json と、候補ごとの外れの数と80の幅を docs に書き、オーナーに伝えて止める。回し直しや線の変更は決まりの変更として扱い、9 のとおり R_trend を置き直す。
  - 効果なし: 全部の手順（候補ごとに、その20通りで、6・7・8 の1〜5 を、その候補を選んだとして）で採用候補になるのが、80のうち4つ以下。
  - 流れが続く: ① の後半の δ_W2 が、10通りのうち8つ以上で0より上。
  - 流れが戻る: 8つ以上で0より下。
  - 一定の上げ下げ: ① の後半の δ_W2 の幅が、4通りのうち3つ以上で0を含む。そろえない差（残した − 外した W2、買い・売り別）も出す。
  - 答えを知ったラベル: 4通りとも、① の後半の δ_W2 が30ポイントを超える。
- 仕込んだ誤り（11 のうち、段1の部品に入るもの。それぞれ、決めた確かめが見つけること。CI で毎回確かめる。作り物でだけ動き、実データの run で設定すると止まる）:
  - 決済する側を取り違える（買いを Ask で追う）→ followHand。
  - 兆しの向きを取り違える → verdicts。
  - 遅れた合図を T から追う → followHand。
  - 層から向きを外す → deltaHand。
  - 層の平均の誤差を幅から外す（外したメールの影響関数を0にする）→ deltaHand。
  - ランダムな外し方を、層ではなく全体の外す数でそろえる → randomCounts。
  - 前半の mode で後半のメールを追う → h1Only。
  - 前半の終わりをまたぐメールを残す（T だけで前半にする）→ h1Only。
  - 5分足の日のファイルを1つ落とす（ドル円の 2025-02-12）→ fiveHoles。
  - sha256 を間違える → 何も計算せずに止まる（CI で、1文字変えたラベルのファイルで確かめる）。
  - 段0の仕込んだ誤り（ラベルの作り）は、段0の CI がこれまでどおり毎回確かめる。
- CI: push では、作り物2つ（種101は前半で候補を選ばず、種102は選ぶ。両方の道を毎回通す）の全部の手順と Python の照らし合わせ、仕込んだ誤り（種101）、sha256 の止まり方。dispatch（stage1=yes）では、作り物の108 run を先に回し、通る条件をすべて満たした時だけ、同じ run の中で実データの前半を走らせる。

**段1の作りの見直し**（2026-10-10。前半の成績を計算する前）
- 5つの観点（決まりとの食い違い・統計・後半や先の足の漏れ・TS と Python の再現・コードの事実）で別々のエージェントが読み、見直し役ごとに別のエージェントが反証した（Workflow、10体）。
- 直したこと（上の 1〜8 に入れた）:
  - 塊の選び方: 標準誤差の大きい方ではなく、幅の半分（t × 標準誤差）が大きい方（決まり 4 の「広い方」。週と4週で自由度が違うため）。
  - 週・ペア・向きでそろえた δ は点だけ（この作りの幅は0になるため）。
  - ランダムな外し方の乱数の使い方（外す数にちょうど届いた時・外す数が0の時）、mulberry32 の式と手の例、並べ替えた先頭から外すこと。
  - E の丸め方（ちょうど半分は上へ）、水準の double の式と等号、ドルのペアの損切りちょうどの手の例、B30 の誤差の扱い、日の塊の決め方、物差しの「1本先」と読めないラベルの扱い。
  - 遅れた合図の入り（C で閉じる15分足の終値。決まり 1 のとおり）。
  - 5分足の穴の確かめ（fiveHoles）と、その仕込んだ誤り。aFile に P＋24時間の確かめ。h1Only の中身を3つに分けて書いた。
  - tf-winrate の出力（前半の成績が入る）をログに出さず、残さない。ペアごとの合図の数は T ≦ 前半の終わりで比べる。
  - 効果なしの作り物を、決まり 11 の「候補ごと」のとおり候補ごとに別の20通りにした（合わせて108 run）。外れた時の手順を先に決めた。この確かめが、幅が正しくても約37%外れることも書いた。
  - 作り物の値動きの定義を、コードの作りに合わせて書いた（一定の上げ下げは5ペアとも上）。
  - 調べる合図の PL2 を、全部・残す・外すのどれでも、にした。物差しの δ は合図に入れない。
- 反証で取り下げたもの: 口座の参考の行の「残すメール＋読めないメール」（決まり 1・10 の「読めない時はメールを出す」に合う）。ほかの指摘は、反証のときにはもう直っていたもの（同じ内容）だった。

**段1のプログラムの見直し**（2026-10-10。前半の実データを計算する前）
- 5つの観点（決まりどおりか・後半や先の足の漏れと出すもの・確かめと仕込んだ誤り・Python・CI と作り物）で別々のエージェントが読み、観点ごとに別のエージェントが反証した（Workflow、10体）。
- 本当とされて直したもの（上の 4〜8 にも入れた）:
  1. 実データの run が失敗した時に、前半で選んだ候補がログと checks.json に出てしまう。確かめの名前（randomCounts.H1.＜候補＞）と説明に候補の名前が入り、選ばれなかった時はその行が無かった。
     - 実データでも4候補すべての線を計算し、確かめを候補の名前の無い1つ（randomCounts.H1）にした。
     - Python も4候補すべてを比べ、項目の名前と数が、選んだかどうかで変わらないようにした。
  2. 候補が選ばれると、Python の照らし合わせが必ず「違う」になる。result.json の H1.line は線の全体なのに、Python は数だけと比べていた。
     - 実データで候補が選ばれると確かめで止まり、trend-choice.json が commit されない作りだった。
     - 種101は候補を選ばないので、CI では一度も通らない道だった。
     - 直して、CI の push に種102（前半で②を選ぶ）を足した。直す前のプログラムで種102を走らせると「DIFFER H1.line」で落ち、直した後は通ることを確かめた。
  3. 「一部が悪い」の文の名前が、TS（partBad）と Python（partly）で違った。その文になった作り物では、必ず「違う」になる（まだ起きていなかった）。同じ名前にし、文の手の例（sentenceHand）を両方に足した。
  4. print.txt の件数の照らし合わせが、同じ数から引き算していて、外れようがなかった。ラベルのファイルの H1 の行の数と、別々に数えた数で照らすようにした。確かめ counts.H1 も足した。
  5. print.txt に、買い・売り別の δ_W2 の幅・t・塊が出ていた（6 の書くものに無い）。点だけにした。
  6. followHand に、ちょうど1,440本の境目（1,440本目の終値）と、利確16に届く例が無かった。足した（16件から19件）。
  7. 作り物の判定で、計算できなかった幅（summary.json では null）を「0を含む」と数えていた（一定の上げ下げ）。
     - 数字でない値は、どの条件も満たさないことにした。
     - 効果なしでは、計算できなかった幅があれば外れとした。
     - 108 run には、計算できなかった幅は無かった。
  8. Python が、物差しのラベルそのもの（向きと読めない印）を比べず、判定だけを比べていた。
     - TS が emails.csv に、時間足ごとの1本先のラベル（ys・yx の列）を書き、Python がそれを比べる。
     - あわせて、データの上に次の足が無い時の扱いを Python にそろえた（読めない。実際には起きない）。
- 反証で取り下げたもの（直していない）:
  - 成功した run が result.json と emails.csv を残すこと。段0と同じで、失敗した時は checks.json だけを残す。
  - summary.json が無い時に、Python が文を比べないこと。今の作りでは起きない。
  - Python の「使った足が前半の終わりまで」の項目が外れようがないこと。Python 自身の読み込みの確かめで、決まりの確かめは TS の h1Only。
- 直した後の確かめ:
  - 歩み101: summary.json と result.json は、直す前とバイト単位で同じだった。変わったのは、print.txt の直した所と emails.csv の新しい列だけ。Python は PYTHON CHECK OK。
  - 歩み102: 前半で②を選ぶ。summary.json は、108 run の時と同じだった（歩みの置き場所の名前のほか）。Python は PYTHON CHECK OK（直す前のプログラムでは DIFFER H1.line）。
  - 仕込んだ誤り9通りは、それぞれ決めた確かめが見つけた。前半の mode で後半のメールを追う誤りは、新しい counts.H1 も見つけた。
  - deno check・lint。
- 実データの run では、選んだかどうかに関わらず4候補の線を計算するので、前より少し時間がかかる。

**作り物の108 run の結果**（手元、2026-10-10）
- 直す前のプログラム（4c103ca）で回した。直した所は summary.json の値を変えない（歩み101・102で、直す前と同じ summary.json になることを確かめた）。dispatch では、CI がもう一度108 run を回し、同じ条件で判定する。
- 通る条件は、すべて満たした:
  - 効果なし: 80のうち、0を含まない幅は4つ（5.0%）で、割合の上の端は 9.78%（10%以下）。候補ごとには ① 1・② 2・③ 1・④ 0。採用候補は0（4以下）。
  - 流れが続く: ① の後半の δ_W2 が、10通りすべてで0より上（+1.87〜+7.73 ポイント）。
  - 流れが戻る: 10通りすべてで0より下（−8.35〜−3.37 ポイント）。
  - 一定の上げ下げ: 4通りすべてで、幅が0を含む。
  - 答えを知ったラベル: 4通りすべてで30ポイントを超える（+52.11〜+54.79 ポイント）。
  - どの run でも、確かめ（21）はすべて通った。
- 効果なしの4つは、通る上の端に近い（5つなら外れていた）。

**段1の結果**（2026-10-10、GitHub Actions run 38031410727。前半 2024-01-01〜2025-05-19、72.0週、4,725通。作り物の108 run が条件をすべて満たした同じ run の中で走らせた）
- 確かめは、すべて通った（followHand 19・deltaHand 9・verdicts 7・sentenceHand 8・floors・signals・labelsAgain 14,175か所の違い0・aFile・h1Only・fiveHoles〈穴0〉・lookBehind〈違い0〉・randomCounts・counts・tfWinrate・loads〈失敗0〉）。Python の別の計算し直しも、すべての項目で TS と同じ（PYTHON CHECK OK）。調べる合図（11 の「数字の後」）は、どれにも当たらなかった（「none」）。
- 前半の成績（利確10が先 ＝ W2、利確4が先 ＝ W1。1回あたりは pips、スプレッドを払った値）:

  | 候補 | 残す通数（週あたり） | W2・1回あたり（残す／外す） | W1・1回あたり（残す／外す） | δ_W2（幅、t） | 買い・売りの δ_W2 | 選べるか |
  |---|---|---|---|---|---|---|
  | 全部（今のメール） | 4,725（65.6） | 52.7%・−1.40 | 71.5%・−1.36 | — | — | — |
  | ① 1時間足 | 1,516（21.1） | 53.8%・−1.12 ／ 52.3%・−1.53 | 72.5%・−1.16 ／ 71.1%・−1.46 | +1.49（−3.03〜+6.01、t 0.656） | +0.15 ／ +2.78 | 選べる |
  | ② 4時間足 | 2,121（29.5） | 53.2%・−1.28 ／ 52.3%・−1.49 | 72.8%・−1.15 ／ 70.5%・−1.54 | +0.72（−3.44〜+4.88、t 0.366） | **−1.43** ／ +2.90 | 選べない（買いの δ_W2 が0以下） |
  | ③ 1時間足と4時間足 | 2,671（37.1） | 53.3%・−1.25 ／ 52.0%・−1.59 | 72.8%・−1.14 ／ 69.9%・−1.65 | +1.43（−3.13〜+5.99、t 0.661） | +1.25 ／ +1.61 | 選べる |
  | ④ 15分足 | 425（5.9） | 53.9%・−1.04 ／ 52.6%・−1.43 | 72.0%・−1.20 ／ 71.5%・−1.38 | +1.82（−3.63〜+7.28、t 0.706） | +1.18 ／ +2.45 | 選べる |

  - δ_PL2（1回あたり、pips）: ① +0.40、② +0.17、③ +0.37、④ +0.53（どれも幅は0をまたぐ）。δ_W1: ① +1.38、② +2.14（−0.49〜+4.76）、③ +2.80（+0.09〜+5.52）、④ +1.18。
  - 層でそろえた「残したメール − 全部のメール」（W2）: ① +1.01、② +0.40、③ +0.62、④ +1.66（④ の幅 −3.30〜+6.62）。
  - 損切りなしで1日持った場合（(a) の v1d）: 全部は −30 pips 以下が10.3%、1日後の平均 −0.87 pips。残したメールは ① 10.3%・−1.14、② 9.6%・−0.45、③ 9.9%・−0.71、④ 9.9%・−0.83。
  - 週・ペア・向きでそろえた δ_W2（点だけ。説明）: ① −4.07、② −5.34、③ −3.71、④ +1.05。ほかの3つは、週の中で比べると逆の向きになる（週ごとの当たり外れの違いが、δ_W2 の正の値の元になっている形）。
  - 物差し（1本先のラベル。先読みがあればこう見える）の δ_W2: ① +3.81、② +2.34、③ +3.73、④ +3.52（判定が変わったメールは 1.6%・2.1%・2.5%・0.5%）。本物の δ_W2 より大きい。
- 選べる候補は ①・③・④。t が一番大きい ④（0.706）を選んだ（③ 0.661、① 0.656。3つの差は 0.05 以内で、ほぼ同じ）。選び方は決まりのとおり機械的。
- ④ の前半のランダムの線は 2.539（種類別: ペア・向き・日 2.361、ペア・向き・週 2.074、全ペア・向き・日 2.160、全ペア・向き・週 2.539。説明で、選び方には使っていない）。④ の t 0.706 は、この線よりずっと下。前半でも、ランダムに同じ数を外した場合と区別できない。
- 書く文（先に決めた。12 の3）: 「選んだのは④（15分足のダウが逆向きなら出さない）です。4つから良いものを選んだので、この数字は良く見えやすく、判断には使いません。」
- 読み方（測っていないことを含めない）:
  - どの候補も、δ_W2 の幅は −3〜+7 ポイントにまたがり、効くとも効かないとも言えない。
  - ④ は、メールが週 約66通から約6通（9%）になる。ULTRA の売りは値段が上がった後に出るので、15分足のダウと逆向きになるものが約91%ある（段0）。
  - 1回あたりの損益は、どの条件でもマイナスのまま（残す側 −1.04〜−1.28 pips、全部 −1.40）。勝率100%はおろか、損益ゼロに要る約57%（スプレッド別）にも、利確10は届いていない（52.7〜53.9%）。
  - 前半の数字は、4つから選んだので良く見えやすい。判断には使わない。
- 次は段2（後半で ④ だけを1回）。段2のプログラムはまだ実データでは動かない（`MODE=stage2` は止まる）。段2の細部を、後半の成績を計算する前に決めて docs に書いてから作る。
- 選んだ候補は `research/ledger/trend-choice.json` に commit された（sha256 db4b2078…b7c6。`TREND_CHOICE_SHA256` の定数に入れた。段2は、これが違えば何も読まずに止まる）。artifact（trend-stage1、30日）には、print.txt・checks.json・result.json・emails.csv が入っている。

**別件**
- 10/9 の売りのメールの RSI を値段から計算し直す件は、2026-10-10 09:16 JST の毎朝の照合（Routine）で行う（GMO のその日の足が保存された後）。この測定とは別で、この測定はそのメールを使わない。

**段2の作り**（2026-10-10。後半の成績を1つも計算する前に決めた細部。見直し〈下の「段2の作りの見直し」〉の後、決まり 12 の4 の「言えない」の文を1か所だけ変えたので、決まり 9 のとおり R_trend を置き直す。ほかの決まりと段1の作りは変えていない）
- 段2で計算するのは、段1で選んだ ④（15分足のダウが逆向きなら出さない）だけ。①②③ は、後半の成績・δ・線・物差しの δ・調べる合図を計算しない（後半の残す・外すの数は、段0で数えてある。決まり 13）。
- プログラム:
  - `research/trend1.ts` の MODE=stage2。走る前に、`research/ledger/trend-choice.json` の sha256 が `TREND_CHOICE_SHA256`（db4b2078…b7c6）と同じで、chosen が「④15M」であることを確かめる（確かめ choiceFile）。違えば何も読まずに止まる。ラベルのファイルと (a) の sha256 も、段1と同じに確かめる。
  - 候補の一覧は、trend-choice.json から取った ④ の1つだけにして、成績・δ・線・物差しの δ・調べる合図を作る（4候補で回す関数をそのまま使わない）。result.json の H2 には ④ の1つだけを書く（確かめ onlyChosen）。
  - 前半のメールは追わない（前半の成績は計算しない）。前半の足は、窓とラベルのために読む。
  - 作り物の段2の道: MODE=stage2 に WALK_DIR（作り物の置き場所）と、作り物用の choice ファイル（chosen ＝ ④15M）とその sha256（環境変数）を渡すと、作り物の足で、実データの段2と同じ関数を通す（GMO には行かない）。作り物には (a) が無いので、v1d は §8.102 の1日後の値と同じ式（`valueAt`。動かした後の P＋24時間、決済する側）で作る。P は T＋2分を楽天の止まる時間の後まで動かしたもの（§8.102 の `pOf`・`follow` と同じ）。
  - `research/trend-check.py --mode stage2`: Python の別の計算し直しに段2を足す。別のエージェントが、この節と上の決まりと段1の作りと、§8.102 の値段の決まり（注文の時点・止まる時間・約定・利確・時点の値）だけを読んで書く（TS は読まない）。口座は `ownerhold-check.py` の口座（`c_rule_accounts`。#206 と同じ）を使う。何も読む前に、trend-choice.json の sha256 と chosen を確かめ、違えば止まる。
  - `.github/workflows/trend.yml`: push で、作り物の段2の道（種101・102）と Python、仕込んだ誤りを毎回回す。dispatch（stage2=yes）では、段1の作り 8 の108 run（MODE=syn。段1と同じ）を先に回し、同じ通る条件をすべて満たした時だけ、同じ run の中で実データの後半を走らせる。

**1. 後半のメールと、読むもの**
- メール: ラベルのファイルで半分が H2 の行（4,653通。T が 2025-05-19 00:00 UTC 以後で、5取引日の追う窓が END ＝ 2026-10-03 00:00 UTC までに終わるもの。決まり 5）。
- 足: END までに確定したものだけ（1分足・5分足・15分足・1時間足・4時間足）。
- E と入りの Bid・Ask: 段1の作り 1 と同じ（15分足から合図を作り直す。確かめ signals.H2）。
- v1d: (a) の CSV。後半のメールがどれもちょうど1行につながり、その行の P＋24時間が END まで（確かめ aFile.H2。(a) は END ＝ 2026-10-03 で書かれ、sha256 で固定してあるので、P＋24時間の部分は作りの上で外れない）。
- ラベル: 段1の作り 1 と同じ作りで、後半のすべてのメール・3つの時間足で、ファイルと同じ（確かめ labelsAgain.H2）。物差しの1本先のラベルも同じ作り（後半のメールの C は END の5日以上前なので、次の足はある）。

**2. 追い方**（段1の作り 2 と同じ）
- h2Only: (1) 読んだ足（口座と持ち値の1分足を含む）は、どれも END までに確定している。(2) 追ったメールは、ファイルで半分が H2 の行とちょうど同じ。(3) どのメールも、1,440本を読んだ足の中で追えた。
- fiveHoles.H2・lookBehind.H2 は段1と同じ作り。
- tf-winrate との照らし合わせ（tfWinrate.H2）:
  - tf-winrate を、5ペア・START 2024-01-01・SPLIT 2025-05-19・END 2026-10-03T00:00:00Z・損切り13・利確 4/10/16・週末 inside で、同じ job の中で走らせる。
  - 標準出力と標準エラーはファイルに書き、ログには「GMO reads that failed」の行だけを出す。`tf-winrate.json` は確かめだけに読み、残さない。tf-winrate は、前半・後半の、足ごと・ペアごとの5ペアの成績を書く。15分足 ULTRA の5ペアの全体の数（利確4/10/16、損切り13）は、前半は段1の表の「全部」、後半は段2の表の「全部」で見る数になる。まだ誰も見ていないのは、ほかの足の数と、15分足のペアごとの数（§8.107〈#264〉に伝える）。
  - 後半の表（second。T が SPLIT 以後）の15分足 ULTRA の利確4・10・16 の件数（n・利確・損切り・両方・未決着）が後半のメールと同じで、pips の平均が 1e-9 以内。ペアごとの合図の数（T ≦ END）も同じ。tf-winrate 自身の合図の確かめの違いが0。読み込みの失敗0。

**3. δ と幅**（段1の作り 3 と同じ）
- 4週の塊は、2025-05-19 を含む週から。週の数は71.7週。

**4. ランダムな外し方**（段1の作り 4 と同じ。後半の成績で、④ だけ）
- 種 ＝ 250,000 ＋ 2,000（後半）＋ 400（④）＋ 種類（ア1・イ2・ウ3・エ4）＝ 252,401〜252,404（実データ）。作り物は 250,000 ＋ 10,000 × 種 ＋ 2,400 ＋ 種類。
- 4種類 × 500通り。各種類の t を小さい順に並べた488番目のうち、一番高いものが後半のランダムの線。確かめ randomCounts.H2。

**5. 決め方**（決まり 8。比べは double のまま。段1と同じく、0との差の決まりは置かない）
- 1 勝率が上がる: ④ の t（δ_W2 ÷ 使った標準誤差）が後半のランダムの線より大きい。かつ、生の数でも、残したメールの W2 が全部のメールより高い（買い・売りを合わせて）。t が無ければ満たさない。
- 2 1回あたりの損益が下がらない: δ_PL2 ≧ 0。生の数で、残したメールの PL2 ≧ 全部、W1 ≧ 全部、PL1 ≧ 全部。
- 3 損切りなしの持ち方で悪くならない: δ_v1d ≧ 0 かつ δ_B30 ≧ 0（B30 は「外した − 残した」）。
- 4 買い・売りの両方で δ_W2 > 0。
- 5 確かめ（8）がすべて通り、Python が合い、調べる合図（6）が ④ に当たっていない。
- 2〜4 は点で見る（幅は並べるだけ）。
- 文の名前（sentenceHand と同じ）: adopt（1〜5 をすべて満たす）・bad（δ_W2 の幅の上の端が0より下）・partBad（1 を満たし、2〜4 のどれかを満たさない）・cannot（それ以外。1〜4 を満たして 5 だけ満たさない時もここ）。
- 文を埋める（決まり 12 の4）:
  - 4つの文を、毎回、同じ数から全部埋めてから、文の名前で1つを選ぶ（埋める道を文で分けない）。4つの埋めた文は result.json に書き、Python も自分の数から同じ決まりで埋めて、文字列ごと比べる。
  - 数の書き方: % とポイントは小数1桁、pips は小数2桁、週は小数1桁、1週あたりの通数は整数。差（ポイント・pips）は符号つき。正確な2進の値を10進に直し、ちょうど半分は上へ丸める（TS は toFixed、Python は Decimal の ROUND_HALF_UP）。
  - 数の書き方の細部（TS と Python で同じ文字列にするため）:
    - % とポイントは、割合を double で100倍した値を丸める。符号をつけるのは、ポイントの差・幅の両端・pips。符号は、0 より大きい時と 0 の時（−0 を含む）に「+」、0 より小さい時は toFixed が出す「-」（ASCII）。丸めた結果が「-0.0」になる小さな負の値は、そのまま「-0.0」と書く。
    - 勝率の %・週・1週あたりの通数・「__ポイントくらいの差」（絶対値）には符号をつけない。t と線は小数2桁で、負の時だけ「-」がつく。
    - 採用の文の「+__ポイント」は、「+」を重ねず、符号つきの数で埋める（例「+1.7ポイント」）。
    - 〈ルール〉は「④（15分足のダウが逆向きなら出さない）」。
    - 一部が悪いの（__）の項目の書き方: 「δ_PL2 -0.12 pips」「残した PL2 -1.30・全部 -1.20 pips」「残した W1 70.1%・全部 71.5%」「残した PL1 -1.30・全部 -1.20 pips」「δ_v1d -0.40 pips」「δ_B30 +1.2ポイント」「買いの δ_W2 -0.8ポイント」「売りの δ_W2 -0.8ポイント」。満たさなかったものだけを、この順で「、」でつなぐ。
    - 言えないの、t が線を越えた時の〈〉は、当てはまるものを「生の数で、残したメールの W2 が全部以下でした」「調べる合図（〈名前を「、」でつなぐ〉）に当たりました」の順で、「。また、」でつなぐ。
    - （2026-10-10 に足した。Python の別の計算し直しを書いた時に、決まっていなかったと分かった細部。後半の成績は、まだ1つも計算していない）
      - 採用の文の4つの行（12 の4 の4つの「・」）は、改行（LF 1つ）でつなぐ。言い回しは 12 の4 のとおり（「利確10が先 __%・1回あたり __ pips でした。」「外したメールは __%・__ pips です。」）。
      - 調べる合図には、名前を2つ付ける。並びは、次の5種類の順で、その中は列（全部・残す・外す）、向き（全体・買い・売り）の順、100% は W1・W2・W3・B30 の順。
        - 数えるための名前（print.txt・result.json・条件 5。英数字と記号は ASCII、δ だけはギリシャ文字）: 「④15M: kept W2 81.3% (80% or more)」「④15M: kept W1 93.8% (90% or more)」「④15M: |δ W2| -12.34 points (10 or more)」「④15M: PL2 〈all／kept／out〉 〈all／BUY／SELL〉 +3.00 (+3 or more)」「④15M: 〈W1／W2／W3／B30〉 〈列〉 〈向き〉 100%」。% は小数1桁で符号なし、ポイントと pips は小数2桁で、0 以上なら「+」。条件 5 は、名前が「④15M:」で始まる合図があれば満たさない。
        - 文に入れる名前（言えないの文の〈名前〉。オーナーが読むので日本語。2026-10-10、段2のプログラムの見直しで、英語の名前が文に入っていたのを直した）: 「残したメールの W2 が80%以上（81.3%）」「残したメールの W1 が90%以上（93.8%）」「|δ_W2| が10ポイント以上（-12.3ポイント）」「〈全部のメール／残したメール／外したメール〉〈なし／の買い／の売り〉の PL2 が +3 pips 以上（+3.00 pips）」「〈列〉〈向き〉の 〈W1／W2／W3／B30〉 が100%」。% とポイントは小数1桁、pips は小数2桁で、ポイントと pips は 0 以上なら「+」（ほかの数の書き方と同じ）。
      - 満たさなかったかどうかは、条件（8）と同じ向きで決める。数にならない値（NaN）は、満たさなかった側に入れる（一部が悪いの項目にも入れる）。
      - 数にならない値（NaN・無限）は、文では「-」と書く。
      - 4つの文は毎回埋めるので、選ばれない文では、当てはまるものが無い〈〉と（__）が空になることがある。その時は何も書かない（例「勝率は上がりましたが、が悪くなったので、使いません（）。」「…を越えましたが、。そのため…」）。選ばれる文では起きない（一部が悪いは満たさない項目がある時だけ選ばれる。言えないで t が線を越えるのは、理由があるか、確かめが外れた時だけで、確かめが外れたら数字を出さない）。
  - 採用候補の「__週」は71.7。「受け取るメールの勝率は +__ポイント（95%の幅 __〜__）」は、層でそろえた「残したメール − 全部のメール」（W2）とその幅。「週 約__通から約__通」は、全部 → 残す＋読めない。
  - 採用候補の「−30 pips 以下の割合は __% から __%」と「1日後の平均は __ pips から __ pips」は、条件 3 と同じ物差しにそろえる: 全部の生の値 → 全部の生の値 ＋ 層でそろえた「残したメール − 全部のメール」（B30 は −（N外 ÷ N全部）× δ_B30、v1d は（N外 ÷ N全部）× δ_v1d。N は、その δ に入れた層の数）。生の「全部 → 残す」は表に並べる。
  - 一部が悪いの〈〉は、満たさなかったものを、この順で「、」でつなぐ: 1回あたりの損益（δ_PL2 か生の PL2）、メールの利確4の数字（生の W1 か PL1）、損切りなしの1日後（3）、買いか売りの片方（4）。（__）には、満たさなかった項目ごとに「名前 値」を「、」でつないで書く（δ は「δ_PL2 −0.12 pips」の形、生の数は「残した W1 70.1%・全部 71.5%」の形）。
  - 悪いの差と幅は δ_W2。言えないの「__ポイントくらいの差」は、δ_W2 の幅の端のうち0から遠い方の絶対値。
  - 言えないの「ランダムに同じ数を外した場合と区別できませんでした。」は、t が無いか、t が後半のランダムの線以下の時だけ書く。t が線を越えたのに言えないになった時は、この1文の代わりに「t は __ で、ランダムの線 __ を越えましたが、〈生の数で、残したメールの W2 が全部以下でした／調べる合図〈名前〉に当たりました〉。そのため、決めた条件を満たしません。」と書く（決まり 12 の4 の変更。上の頭書きのとおり R_trend を置き直す）。
- 書き出し: 後半のメールごとの行のファイル `trend-h2.csv`（T・ペア・向き・遅れ・C・④ の判定・E・入りの Bid と Ask・利確4/10/16 の結果と pips・v1d・物差しの ④ の判定・持ち値〈7〉の値と印）。①②③ の列は書かない。TS は、このファイルの sha256 を checks.json に書く。Python は、このファイルそのものを、すべての行と列について自分の計算と比べる。確かめと Python がすべて通った時だけ、別の job が、sha256 が checks.json の値と同じことを確かめてから、`research/ledger/trend-h2.csv` に commit する（段1の trend-choice.json と同じ形）。

**6. print.txt に書くもの**（11 の「出す数を絞る」。これ以外は書かない）
- ④ の後半の表（12 の4）: 全部・残す・外すの列で、通数（1週あたり。71.7週）・利確10が先の割合と1回あたり・利確4が先の割合と1回あたり・1日後に −30 pips 以下の割合（損切りなし）・1日後の平均・利確16が先の割合と1回あたり（説明）。買いと売りも別に出す。全部の列は、後半のすべてのメール（読めないメールは0通）。
- δ（W2・PL2・W1・PL1・v1d・B30）とその幅・t・使った塊。δ_W2 の買い・売り（点）。層でそろえた「残したメール − 全部のメール」（W2・v1d・B30）と幅。週・ペア・向きでそろえた δ_W2 の点。物差しの δ_W2 と、判定が変わったメールの割合。
- ④ の t と、後半のランダムの線（4種類それぞれの点と、一番高いもの）。
- 1〜5 の合否、文の名前、選んだ文（数を埋めたもの）。
- 件数の照らし合わせ: 後半のメール ＝ 比べたメール ＋ 読めないメール、比べたメール ＝ 残す ＋ 外す、決着 ＋ 未決着 ＝ 後半のメール（利確10）。ラベルのファイルの H2 の行の数と、それぞれ別に数えた数で照らす（確かめ counts.H2）。
- 調べる合図（11 の「数字の後」。段1の作り 6 と同じ項目を ④ について）。当たったら、報告の前に先読みと測り方の誤りを調べる。
- 参考の行（7）。

**7. 参考の行**（決まり 3。先に決めた。判断には使わない）
- 口座: §8.102 の後半の口座の作り（2025-05-19 00:00 UTC に30万円で始め、それより前の取引を持ち込まない）を、② のルールの行と同じ形（`costhours.ts` の `ruleAccounts`。`runAccount`・MAIN_OPTS・元手30万円・上限100万円）で、2つの行で回す。
  - 全部: 後半のメールをすべて注文する。
  - ④: 残すメール＋読めないメール（読めないメールは0通）を注文し、外すメールは注文しない。
  - 作り物でも、口座は全部と ④ の2行（前半で何を選んだかに関わらない）。
  - 注文は §8.102 の本線と同じ（指値 E・利確10・損切りなし・触れたら約定）。P は (a) の CSV の P の列（T＋2分を、楽天の止まる時間の後まで動かした時刻。後半の4,653通のうち、21通は T＋10分〈T が 21:00 UTC に19通、22:00 UTC に2通〉で、ほかは T＋2分）。足は GMO の1分足。終わりは END。
  - 出すもの: ルールの行と同じ項目（損益、ロスカットの数、期限の数、入金の合計、注文した数と割合、勝率、pips、円）。
  - 先読みの確かめ（lookAheadAccount。2行 × ±）が通ること（8）。
- 1通ずつの持ち値（全部と、④ の残すメール）:
  - 同じ道（§8.102 の `follow`。指値 E・利確10・損切りなし）で、H5 は、動かした後の P（`follow` の path.P）以後に始まる最初の5分足から数えて1,440本目の終わり。例: 夏の T 21:00 UTC の合図は P が 21:10 で、21:10 の5分足から数える。
  - 値は `valueAt`（H5 以前に終わる最後の1分足の、決済する側の終値。利確の1分足が H5 までに終わっていれば、利確の値）。
  - H5 までに約定しなかったメール（END まで約定しなかったものを含む）と、H5 が END より後のメールは、数・平均・割合のどれにも入れず、その数だけを出す（END まで約定しなかった数も別に出す）。分母は、H5 までに約定し、H5 が END までのメール。
    - （2026-10-10 に足した細部）H5 が END より後のメールは、約定したかに関わらず「H5 が END より後」（trend-h2.csv の holdKind は late）に数え、約定しなかった数には入れない。H5 が END までのメールだけを、END まで約定しなかった（never）・H5 までに約定しなかった（notFilled）・利確（tp）・持ったまま（held）に分ける。
  - 出すもの: 数・平均 pips・利確した割合（「損切りが無いので作りの上で高く出る」と添える）・−30 pips 以下の割合（値が −30 ＋ 1e-9 以下。段1の作り 2 の B30 と同じ）。
  - 先読みの確かめ lookAheadHold: 各メールで、H5 以前に終わる最後の1分足より後の1分足を ±777.7 pips 書き換え、follow と valueAt をやり直しても、値が変わらない（§8.102 の lookAhead の作り）。

**8. 確かめ**（11。1つでも外れたら数字を出さない。外れた時は checks.json だけを残す）
- labelsFile・choiceFile（どちらも外れたら何も読まずに止まる）・aFile.H2・signals.H2・labelsAgain.H2・h2Only・fiveHoles.H2・lookBehind.H2・tfWinrate.H2・loads・followHand・deltaHand・verdicts・sentenceHand・sentenceHand2（4つの文を手で埋めた例・t が線を越えた言えないの文・理由の無い時の空・合図の2つの名前）・holdHand（持ち値の手の例）・floors・randomCounts.H2・counts.H2・onlyChosen・lookAheadAccount・lookAheadHold。
  - onlyChosen: result.json の H2 の stats・線・調べる合図が ④ の1つだけで、trend-h2.csv と print.txt に ①②③ の後半の数や列が無い。TS は stats・線・合図（数えるための名前が「④15M:」で始まる）と trend-h2.csv の見出し（決めた21列ちょうど）を見て、print.txt は Python が見る。
  - sentenceHand: 段1の8つの名前の例に足して、手で作った数で4つの文を埋めた中身（採用の文の v1d・B30 と、t が線を越えた言えないの文を含む）が、決めた文字列と同じ（TS と Python の両方）。
  - 持ち値の手の例: 夏の 21:00 UTC の合図（P 21:10、H5 は 21:10 の足から）、H5 の後に約定したメール、−30 ちょうど。（2026-10-10 に足した）P から数えた5分足が1,439本しかないメールは、約定していても、END まで約定しなくても late。1,440本あって END まで約定しないメールは never。H5 がちょうど END なら数え、END が H5 より前なら late（TS だけ。Python は END までの足だけを持つ）。
- Python（別に書く）: trend-h2.csv のすべての行と列（後半の行と (a) の行、E と入りの Bid・Ask、5分足の追い方、成績、v1d、物差しの判定、持ち値）、δ と幅と t、ランダムの線（④ の4種類×500 の t を小さい順に並べたもの）、1〜5 と文の名前、4つの埋めた文、件数、口座の2行、onlyChosen が、TS と同じ。
  - 許し幅: 口座の円は 1e-6円（100万円を超える額はその 1e-12）、口座の pips と割合は 1e-6（§8.102・§8.99 と同じ）、数・1通ずつの行き先・終わり方は完全に一致。それ以外の数は 1e-9。文は文字列ごと同じ。
  - 項目の名前と数と場所の名前は、成績で変わらないようにする。口座は、行ごとに決まった項目と、後半のすべてのメールの行き先だけで比べる（終わり方の辞書は、決まった鍵すべてに0を入れてから比べる）。持ち値は、後半のすべてのメールを1行ずつ（約定しなかった・H5 が END より後の印つきで）比べる。場所の名前は（T・ペア・向き）だけで、時刻の値段や成績を入れない。違った数の値は出さず、どこが違うかだけを出す。
- yml: 実データの段2で TS か Python が落ちた時は、「stage 2: exit N」だけを出し、Deno のエラーの中身（real.err）はログにも artifact にも出さない。
- 確かめの名前・数・かかる時間は、文で変わらない。

**9. 作り物**
- 108 run（段1の作り 8）は、MODE=syn で段1と同じに回し、同じ通る条件で見る（作り物には (a) が無いので v1d・B30 は出さず、5 の3 は「満たした」と数える）。
- 作り物の段2の道（上の「プログラム」）を、push のたびに種101・102 の作り物で回す。④ だけの集計、口座の2行、持ち値、4つの文を埋めること、trend-h2.csv の書き出し、onlyChosen、Python --mode stage2（作り物）を通す。値には意味が無く、プログラムの道を通して Python と照らすためだけに使う（通る条件には入れない）。作り物には1分足が無いので、作り物の5分足をそのまま1分足の列として渡す（4分おきに穴のある1分足）。作り物の足は END の7日後まである（`trend.ts` の LABEL_END）。
- 段2で足す仕込んだ誤り（作り物の段2の道で、種101で回す。それぞれ、決めた確かめが見つけること）:
  - 後半の mode で前半のメールを追う → h2Only。
  - END をまたぐメールを残す（T だけで後半にする）→ h2Only。
  - 口座と持ち値の1分足を END＋3日まで読む → h2Only（(1)）。END は土曜 00:00 UTC で、次の足は日曜 22:00 UTC からなので、1日では何も読まない（作り物の手元の試しで分かった）。
  - 後半で4候補を計算して書く → onlyChosen。
  - 持ち値を H5 の1分後の足で読む → lookAheadHold。
  - 口座の ④ の行で、外すメールも注文する → Python の照らし合わせ（口座の ④ の行）。
  - 後半の線を前半の種で作る（種の半分を1にする）→ Python の照らし合わせ（H2 の線）。
  - 採用の文の「+__ポイント」に δ_W2 を入れる → Python の照らし合わせ（埋めた文）。
  - trend-choice.json の sha256 を間違える → 何も読まずに止まる（CI で、1文字変えたファイルで確かめる）。
  - Python で見つける誤りは、その出力で Python を走らせ、Python が最後まで走って「PYTHON CHECK FAILED」で終わり、決めた項目が DIFFER であることを CI で見る（例外で落ちた時は、見つけたと数えない）。
- CI の syn の job で、trend-choice.json の sha256 と、TS（`research/trend-labels.ts`）・Python（`research/trend-check.py`）の TREND_CHOICE_SHA256 が同じことも確かめる。

**10. 記録と伝え方**
- 段2の文と表を docs に書き、オーナーに伝える。勝率は、いつも1回あたりの pips と並べる。
- 採用候補なら 9（R_trend から8週たった後の確かめ）に進む。それ以外なら、#250 はここで終わり、メールは今のまま。
- 後半の数字を見た後にプログラムの誤りを直した時は、決まり 11 の「数字の後」のとおり、前の数字と文を残し、隣に「数字を見た後に直した」と書く。

**段2の作りの見直し**（2026-10-10。後半の成績を計算する前）
- 4つの観点（決まりとの食い違い・漏れ・コードの事実・確かめと Python）で別々のエージェントが読み、観点ごとに別のエージェントが反証した（Workflow、8体）。指摘26個のうち、正しい7・一部正しい17・誤り2。正しい・一部正しいものを、上の 1〜10 に入れた。
- 主に直したこと:
  - 作り物でも、実データの段2と同じ道（④ だけの集計・口座・持ち値・文を埋める・trend-h2.csv・Python）を毎回通すようにした（作り物の段2の道）。段1で、CI で通らない道に必ず落ちる誤りが残っていたため。
  - ①②③ を後半で計算しないことを確かめる onlyChosen と、その仕込んだ誤りを足した。
  - (a) の P は T＋2分とは限らない（楽天の止まる時間の後まで動かした時刻。後半の21通は T＋10分）ことを書き、持ち値の H5 を、動かした後の P から数えることにした。持ち値の分母・−30 の扱い・先読みの確かめ（lookAheadHold）を決めた。
  - 文は、4つとも毎回埋め、Python と文字列ごと比べることにした。採用の文の1日後の数を、条件 3 と同じ物差し（層でそろえた差）にした。
  - 言えないの文に、t が線を越えた時は事実と違う一文（「ランダムに同じ数を外した場合と区別できませんでした」）が入っていた。その時だけ別の文にした。これは決まり 12 の4 の変更なので、R_trend を置き直す。
  - Python の項目の名前と数を成績で変えないこと、口座の許し幅、trend-h2.csv そのものを照らすこと、choice ファイルの確かめを Python と CI にも足した。h2Only の (1) を外して見せる仕込んだ誤りを足した。
  - tf-winrate の数の注を直した: 15分足の5ペアの全体の数は、段1・段2で見る数になる（§8.107 に伝える）。
- 反証で取り下げたもの: trend-h2.csv とラベルのファイルをつなげば ①②③ の後半の成績を出せること（決まり 8 で1通ずつの行を残す以上避けられず、決まり 13 が「誰でも計算しない」と決めている）。Python が ownerhold-check.py の口座を使うと走らせ方が変わること（#206 と同じ形で動いている）。

**段2のプログラムの見直し**（2026-10-10。後半の成績を計算する前。Workflow、8体: 決まりどおりか・先読みと期間・CI と出力・数の扱いの4つの見方で指摘を出し、見方ごとに別のエージェントが反証した。本物のデータは誰も読んでいない）
- 指摘14個のうち、正しい8・一部正しい4・誤り2。多く（採用の文の言い回し、空の〈〉、合図の名前のそろえ、CI の numpy、late の決め方）は、見直しが読んだ版の後の commit（Python の別の計算し直しと照らした時の直し）で直っていた。
- 直したこと:
  - 言えないの文に入る合図の名前が英語だった（オーナーが読む文）。文には日本語の名前を入れ、英語の名前は数えるためだけに使う（上の数の書き方の細部）。
  - 本物の段2で、1,440本を追えなかったメールがあると、tf-winrate との照らし（tfWinrate.H2）が例外で止まり、checks.json が残らなかった（作り物の道では tf-winrate を照らさないので CI では通らない）。段1と同じく、そのメールを除いてから照らす順にし、照らす側も結果の無いメールを「違う」と数えて止まらないようにした。
  - 手の例を足した: 理由の無い言えないの文と、満たさない項目の無い一部が悪いの文（どちらも空）、合図の日本語の名前、late の持ち値（1,439本・END まで約定しない・H5 がちょうど END）。TS と Python の両方。
  - onlyChosen（TS）に、合図の名前と trend-h2.csv の見出しを足した。確かめの一覧に sentenceHand2・holdHand の名前を足した。trend-h2.csv の P の列も、H5 と同じく数でない時は空にする（本物では起きないと反証で確かめた道）。
- 反証で取り下げたもの: CI に numpy が無い（直した後の版では venv で入っていて、push の CI〈run 38045250909〉で syn1 がすべて通った）。(a) の行が無いメールで P が数でなくなる（ラベルと (a) の sha256 が決まっていて、後半の4,653通はすべて (a) のちょうど1行につながる）。

**段2の結果**（2026-10-10、GitHub Actions run 38047806808、ブランチの 46a5385〈main と同じ中身〉。後半 2025-05-19〜2026-10-03、71.7週、4,653通。作り物の108 run が条件をすべて満たした同じ run の中で走らせた。1回だけ）
- 確かめは、すべて通った（choiceFile・followHand 19・deltaHand 9・verdicts 7・sentenceHand 8・sentenceHand2・holdHand 6・floors・signals.H2〈9,510行の違い0〉・labelsAgain.H2〈13,959か所の違い0〉・h2Only・fiveHoles.H2〈穴0〉・lookBehind.H2〈違い0〉・tfWinrate.H2・aFile.H2・randomCounts.H2・onlyChosen・lookAheadAccount〈変わった0〉・lookAheadHold〈変わった0〉・counts.H2・loads〈失敗0〉）。Python の別の計算し直しも、すべての項目で TS と同じ（PYTHON CHECK OK。trend-h2.csv の全行・全列、δ・線〈2,007個〉・条件・4つの文・口座2行〈9,361項目〉・持ち値を含む）。調べる合図（11 の「数字の後」）は、どれにも当たらなかった（「none」）。
- 後半の成績（④ だけ。利確10が先 ＝ W2、利確4が先 ＝ W1。1回あたりは pips、スプレッドを払った値。読めないメールは0通）:

  | | 通数（週あたり） | W2・1回あたり | W1・1回あたり | 1日後 −30 pips 以下（損切りなし） | 1日後の平均 | 利確16（説明） |
  |---|---|---|---|---|---|---|
  | 全部（今のメール） | 4,653（64.9） | 55.2%・−0.78 | 73.4%・−0.98 | 11.9% | −1.04 | 43.2%・−0.98 |
  | ④ で残す | 430（6.0） | 53.7%・−1.13 | 72.6%・−1.12 | 11.6% | −0.72 | 43.3%・−0.94 |
  | ④ で外す | 4,223（58.9） | 55.3%・−0.74 | 73.5%・−0.96 | 11.9% | −1.07 | 43.2%・−0.98 |
  | 買い: 全部／残す／外す | 2,125／220／1,905 | 56.7%・−0.43 ／ 56.4%・−0.51 ／ 56.7%・−0.42 | 74.4%・−0.79 ／ 74.5%・−0.73 ／ 74.4%・−0.80 | 9.4% ／ 6.4% ／ 9.8% | +0.77 ／ +3.34 ／ +0.47 | 45.9% ／ 46.4% ／ 45.8% |
  | 売り: 全部／残す／外す | 2,528／210／2,318 | 54.0%・−1.07 ／ 51.0%・−1.78 ／ 54.2%・−1.01 | 72.5%・−1.13 ／ 70.5%・−1.52 ／ 72.7%・−1.10 | 13.9% ／ 17.1% ／ 13.6% | −2.56 ／ −4.96 ／ −2.34 | 41.0% ／ 40.0% ／ 41.1% |

  - δ_W2（層でそろえた「残す − 外す」）: −2.40ポイント（95%の幅 −8.29〜+3.48、t −0.861、4週の塊18）。買い −0.67、売り −3.83。
  - δ_PL2 −0.56 pips（−1.93〜+0.81）。δ_W1 −1.09（−5.75〜+3.58）、δ_PL1 −0.18（−0.98〜+0.62）、δ_v1d −0.62（−4.29〜+3.04）、δ_B30（外す − 残す）−1.04（−5.22〜+3.13）。
  - 層でそろえた「残したメール − 全部のメール」（W2）: −2.18（−7.52〜+3.16）。v1d −0.56、B30 +0.95。
  - 週・ペア・向きでそろえた δ_W2（点だけ。説明）: −3.30。
  - 物差し（1本先のラベル。先読みがあればこう見える）の δ_W2: −0.84（判定が変わったメール 0.5%）。
  - 後半のランダムの線: 2.454（種類別: ペア・向き・日 2.050、ペア・向き・週 2.454、全ペア・向き・日 2.209、全ペア・向き・週 2.248）。④ の t −0.861 は、線よりずっと下。
- 決まり 8 の条件: 1 満たさない・2 満たさない・3 満たさない・4 満たさない・5 満たす → **言えない**。
- 文（先に決めた。12 の4）: 「後半では、④（15分足のダウが逆向きなら出さない）を付けても、勝率が上がるとは言えませんでした（残した 53.7%・-1.13 pips、全部 55.2%・-0.78 pips、外した 55.3%・-0.74 pips）。ランダムに同じ数を外した場合と区別できませんでした。差が無いという意味ではありません。8.3ポイントくらいの差は、この数では見分けられません。メールは今のままです。」
- 参考の行（決まり 3。判断には使わない）:
  - 口座（§8.102 の本線: 指値 E・利確10・損切りなし・触れたら約定、30万円から）: 全部を注文すると 損益 −427,447円、入金 700,000円、期限 6回、注文 2,519通（54.1%）、勝ち 95.6%、1回あたり −1.90 pips。④ で残す＋読めないだけを注文すると 損益 +261,237円、入金 108,562円、期限 0回、注文 381通（8.2%）、勝ち 98.4%、1回あたり +5.85 pips。注文の数と持つ量がまったく違うので、この2行で ④ の良し悪しは言えない（損切りなしの勝ちの割合は、作りの上で高く出る）。
  - 損切りなしで利確10か5営業日（H5）まで持った値: 全部 4,618通の平均 +0.10 pips（−30 pips 以下 7.9%）、④ で残す 427通の平均 −0.34 pips（8.7%）。
- 読み方（測っていないことを含めない）:
  - 後半では、④ で残したメールの方が、勝率も1回あたりも低かった（利確10が先 53.7%・−1.13 pips に対し、全部 55.2%・−0.78 pips）。ただ、δ_W2 の幅は −8.3〜+3.5 ポイントで0をまたぐので、「悪い」とも言えない（「悪い」は幅の上の端が0より下の時）。
  - 前半の ④ は δ_W2 +1.82 だったが、後半は −2.40 だった。4つから選んだ前半の数字が良く見えていた分は、後半には残らなかった（決まりで判断に使わないとしたとおり）。
  - 今のメール（全部）の後半は、利確10が先 55.2%・1回あたり −0.78 pips、利確4が先 73.4%・1回あたり −0.98 pips。1回あたりは、どちらもマイナスのまま。勝率100%には遠い。
  - 先読みの確かめ（lookBehind・lookAheadAccount・lookAheadHold・物差し）は、どれも先読みの形を示していない。
- 決まりのとおりにすること: メールは今のまま。9（これからのメールでの8週の確かめ）は「採用候補」の時だけなので、行わない。12 の7 の「R_trend 以後のメールを流れで分けた割合」は、採用候補にならないと決まったので、出してよくなった。
- `research/ledger/trend-h2.csv` は、checks.json の sha256 と同じことを確かめてから、Actions が commit した（673175c、sha256 1c5a7cfe…4e4b）。artifact（trend-stage2、30日）には print.txt・checks.json・result.json・trend-h2.csv が入っている。
- これで #250 の測定は終わり。#264（§8.107）は「#250 を先に終える」の答えのとおり、ここまで待っていた。

### 8.107 何分足・何時間足の ULTRA が一番当たるかを、先に決めてから測る（#264、研究のみ）

- **指示**（2026-10-10）: オーナー「今15分足で売買の判断をしてるけど、何分足何時間足で売買の判断するのが一番正確なのか調べて、それをメールで送るようにしましょう。一番勝率が高い足で、一番判断が正確な足で」。
- **オーナーの選択**（2026-10-10、選択式の質問への答え）:
  - 勝率の決め方「利確10が損切り13より先」（#250 と同じ。メールに出している「利確4が先」の勝率と1回あたりの損益が下がらないことも条件にする）。
  - 15分足と比べる足「5分足・1時間足・4時間足・30分/2時間/8時間足」（すべて）。
  - 確かめ方「昔の値段で確かめる」（まだ誰も計算していない昔の値段〈Dukascopy〉で、1回だけ比べる）。
  - 順番「#250 を先に終える」（14 の頭に、どこまで待つかを書いた）。
- **いつ決めたか**: 足ごとの ULTRA の勝率・損益を、この決まりのために新しく計算する前（2026-10-10）。ただし、似た数字を見たことはある（下の「前から知っていること」）。
  - 決め方は、Claude の Workflow（調べる1・案を作る3・比べてまとめる1・反証2、7体）で作った。反証で出た指摘23個（統計9・データ14）を受けて、決め方を大きく変えた（4 の鏡の取引、6 の期間と取り方、7 の比べの多さの直し）。
  - その下書きを、別の Workflow で見直した（統計・漏れ・できるか・あいまいさ・確かめの5つの見方で指摘を出し、指摘ごとに別のエージェントが反証した）。指摘75個のうち、正しい23・一部正しい36・誤り16。正しい・一部正しいものを直し、直した下書きをもう一度見直して（30個）また直し、3回目の見直し（7個）でも直した（17 に一覧）。成績はまだ1つも計算していない。
- **使うもの**: チャートの値段だけ。ニュース・指標の予定・ほかの情報は使わない。
- **答えること**: 今のメールの5ペアの ULTRA で、合図の足を替えると、15分足より「当たる」か。当たるは2つで見る。
  - 判断の当たり a: 向きをコインで決めた場合（合図の向きと、同じ時刻・同じ値段で逆向きに入る「鏡」の取引の、勝率の平均）より、合図の向きの取引が利確10に先に届く割合が、何ポイント高いか。合図と鏡の勝率の差（合図の W2 − 鏡の W2）は、a の2倍になる。
  - 勝率と損益: オーナーが受け取る形（利確10が損切り13より先の割合と1回あたりの pips。利確4が先の割合と1回あたりも）。
- **答えないこと**: 5ペア以外・金・Q-Trend、損切り・利確の幅の見直し、時間帯で分けた成績（§8.103 の約束。16）、勝率100%に近づく方法（この測定で見つかるとは限らない）。

**前から知っていること**（下の決め方は、これを知った上で決めた）
- 同じ問いを、2026-09-29（§8.69）にも聞かれている。その後、メールの足は「全部 → 1時間足 → 5分足 → 4時間足 → 15分足」と変わってきた。
- 足ごとの ULTRA の成績（GMO の21ペア、2024-01-01〜2026-09-30、損切り13・利確4が先、スプレッドを払って。§8.98）:
  - 5分足 71.9%・1回あたり −1.62 pips、15分足 72.0%・−1.51、1時間足 72.8%・−1.60、4時間足 74.5%・−0.94、日足 53.0%・−8.79。
  - 損益ゼロには 76%（13 ÷ 17）が要る。でたらめに入っても、スプレッドを引く前は約76%になるので、足による差は小さく出る。
  - 4時間足は、同じ足の終値から抜き出した足で両方向に入った場合（物差し）より、Q-Trend と ULTRA を合わせて +2.3 ポイント（0.9〜3.7）高かった。4時間足の前半は 74.4%、後半は 74.6%（ULTRA）。
- 古い水準（損切り10・利確5 など）の同じ形の数字（§8.69・§8.78・§8.82・§8.93）。1時間足は物差しより +1.9 ポイント（1.1〜2.7）。
- 同じ run（37191488441）のログには、足ごとの前半・後半の行、ペアごと・足ごとの、Q-Trend と ULTRA を合わせた利確4が先の割合と決着した数（5ペアを含む21ペア）、時間帯ごとの行も出ていた（docs に写したのは、上の数字だけ）。
- 5ペアの ULTRA だけの足ごとの成績は、ownerhold の run の中で tf-winrate が計算したが、ログにも出さず、残してもいない（誰も見ていない）。ただし15分足の5ペアの全体の数（GMO、損切り13・利確 4/10/16）は別: 前半（2024-01〜2025-05）は §8.106 段1の結果で見ている（利確10が先 52.7%・1回あたり −1.40 pips、利確4が先 71.5%・−1.36 pips）。後半（2025-05〜2026-10）も §8.106 段2で見る。まだ誰も見ていないのは、ほかの足の数と、15分足のペアごとの数。
- 15分足 ULTRA の5ペアの持ち方の成績（§8.102）と、1日後の値（§8.106）は見ている。4時間足 ULTRA の時間帯ごとの成績（§8.99）は見ている。
- 見たことが無いもの: Dukascopy の FX の値段（コードも無かった）、2023-10-27 より前の5ペアの ULTRA の合図と成績、30分足・2時間足・8時間足の ULTRA の成績、鏡の取引との差。
- **ここまでの数字は、4時間足が良く見える。この決まりは、それを知った上で書いたので、GMO の 2024〜2026年で一番を選ぶことはしない**（7）。

**1. 比べるもの**
- 合図: ULTRA だけ（メールと同じ。`indicatorSignals` の ULTRA の分。RSI 14 が 30 を上へ抜けたら買い、70 を下へ抜けたら売り）。ULTRA の設定と `ULTRA_RULE_ID` は変えない。Q-Trend は比べない（オーナーが受け取っているのは ULTRA だけ。比べる数が倍になる）。
- ペア: 今のメールの5ペア。並びは USD/JPY・EUR/JPY・AUD/JPY・EUR/USD・AUD/USD（層・種・表の並び）。足は5ペアに共通の1つを選ぶ（ペアごとには選ばない）。
- 足:
  - 基準は15分足（今のメール）。比べるのは、5分足・30分足・1時間足・2時間足・4時間足・8時間足の6つ。
  - 入れない足と理由: 1分足（オーナーが #155 で外した）、2・3・4・10分足（1分足から作る足で、メールの仕組みに無い）、日足（合図が少ない見込み。21:00 UTC の確定はスプレッドが広く、21ペアの日足は 53.0%・−8.79 pips）、週足・月足（200本に足りず、合図が出ない）。
  - 足の区切り（UTC）: 5分・15分・30分・1時間は、その長さの区切り。2時間は偶数時の始まり。4時間は 0・4・8・12・16・20 時の始まり。8時間は 0・8・16 時の始まり。
  - メールで今送れるのは、5分足・1時間足・4時間足。30分足・2時間足・8時間足は、選ばれたら、メールの仕組みに足す作業が要る（15）。
- 金は、この決まりには入れない。FX の後に、別の決まりで確かめる（値段の取り方が違い、Twelve Data の読む回数の上限もあるため）。
- 損切り13・利確 4/10/16（`ULTRA_PAIRS`）は、足ごとに替えない。問いは「同じ水準で、どの足の終値で入ると当たるか」。

**2. 合図の作り**（メールと同じ）
- 足: チャートの足。Bid と Ask の四本値から、同じ時刻の中値の四本値を作る。中値は、四本値ごとに (Bid＋Ask)÷2 を double で出し、その正確な値を、ちょうど半分なら上へ丸めて、円のペアは3桁・ドルのペアは5桁にする（チャートの `Number(v.toFixed(d))`。§8.106 段1の作り 1 と同じ。例: Bid 150.060・Ask 150.065 → double でちょうど 150.0625 → 150.063。Python の round は偶数へ丸めて 150.062 になるので使わず、正確な値を Decimal の ROUND_HALF_UP で丸める）。足の始まりと終わりがどちらも市場の休み（`isMarketClosed`: 土曜のすべて、金曜 22:00 UTC 以後、日曜 21:00 UTC より前）の中にある足は作らない（足の終わりは、始まり＋長さ−1ミリ秒。tf-winrate の WEEKEND=inside と同じ）。NY の夏時間（`nyOffsetMs` が −4時間）は、3月第2日曜 07:00 UTC から11月第1日曜 06:00 UTC まで。
- 窓: 確定した足 i が最新の時、新しい方から600本（足りなければ、ある分）を `indicatorSignals` に渡す。tf-winrate と同じく、計算の起点が同じ間は1回の計算で作る。
  - 計算の起点（`anchoredStart`）: 窓の最初の足の始まりの時刻を t0 とし、t0 以上で（200 × 足の長さ）の倍数（1970-01-01 00:00 UTC から数える）になる最初の時刻 at を決め、始まりが at 以上の最初の足から RSI を計算する。足の長さは、窓の新しい方120本の、隣り合う足の始まりの差の最小。その足の番号 s が（最新の足の番号 − 119 − 200）以下でなければ、窓の最初の足から。
  - RSI は Pine の rma（長さ14。最初の14個の上げ・下げの単純平均から始め、下げの平均が0なら100、上げの平均が0なら0）。買いは「RSI が 30 より上で、1本前が 30 以下」、売りは「RSI が 70 より下で、1本前が 70 以上」。RSI の無い足では出ない。窓が200本以下なら何も出さない。
- 送られる合図: 足の確定 T が、送られない時間（土曜の全部、金曜 21:00 UTC 以後、日曜 22:00 UTC より前。`isPossiblyClosed`。§8.102 と同じ）にないもの。
- 遅れた合図: 足 i が最新の窓には無く、足 i+1 が最新の窓で初めて出る足 i の合図（§8.102。メールは次の足の確定後に送る）。窓 i と窓 i+1 の比べだけで決め、本番の新しさの時間（freshFor）は使わない（30分足以上の遅れた合図は、本番ではメールにならないが、ここでは数えて外す）。
- 祝日: T が、毎年の [12/24 00:00, 12/27 00:00) UTC または [12/31 00:00, 1/3 00:00) UTC（始まりを含み、終わりを含まない）にある合図（GMO は 12/25・1/1 に足が無く、前日は早く終わる。GMO の足と Dukascopy の足が一番ずれるため）。
- 1つの合図は（ペア・足の長さ・向き・足の始まり）で1件。
- 外す理由と順番: 合図は、次の順で最初に当たった1つの理由だけに数える（同じ合図を2つの理由に数えない）。
  - ① T が期間（7）の外 ② 送られない時間 ③ 祝日 ④ 遅れた合図 ⑤ 窓の穴（3） ⑥ 追えない（3。1,440本に足りない） ⑦ e が作れない（4。合図か鏡が未決着）。
  - 割合の分母は、その足の5ペアの合計で、その理由の直前までを通った合図の数。
  - ④が0.5%、⑤が2%を超えた時: 15分足なら、そこで止まり、オーナーに伝える。比べる足 X なら、段0で落とし（名前と理由を書く）、m を数え直す（7 の床）。
  - ⑥: 段1では0でなければ止まる（データの欠け）。段2では、END までに1,440本を追えない最後の合図を、tf-winrate と同じく追わずに数だけ出す。
  - ⑦は成績の数なので、足を落とす理由にしない。数を出すだけ。どれかの足で2%を超えた時は、ログには足の名前を入れず「⑦の限度」とだけ出して止まり、オーナーに伝える（m は変えない）。

**3. 取引の追い方**（§8.106 段1の作り 2 と同じ。tf-winrate の `follow`）
- E: 合図の足の中値の終値（2 の丸めの後）。
- 水準: 損切り E − dir×13×pip、利確 E + dir×n×pip（n は 4・10・16。dir は買い1・売り−1。pip は円のペア 0.01・ドルのペア 0.0001）。この順に double で掛け、丸めない。
- 入り: 合図の足の終値（買いは Ask、売りは Bid）。
- 追う足: 5分足（Bid・Ask。両側がそろった足だけ）の、始まりが T 以後の最初の足から、決済する側（買いは Bid、売りは Ask）で、1,440本まで。比べは double のまま、等号を含む。1本ずつ、始値が損切りに届いていれば損切り（始値で）、でなければ始値が利確に届いていれば利確（始値で）、でなければ1本で両方に届いたら損切り（amb）、片方ならその水準。1,440本で決まらなければ未決着で、1,440本目の終値で決済。1,440本に足りなければ、結果なし（2 の⑥）。
- pips: 買いは（出た値 − 入った値）÷ pip、売りは逆。W は 利確 ÷（利確＋損切り＋amb。未決着は外す）。PL は数えた合図（未決着を含む）の平均。
- **T より後の足を条件にして、合図を外すことはしない**（後の足の穴や値で、合図を外さない）。追う足の穴は、休みの後と同じく、次の足の始値で決まる扱いにする。
- 窓の穴（T より前。2 の⑤）:
  - 枠は5分。「開いている枠」は、GMO の週（日曜 22:00 UTC〜金曜 21:00 UTC）の中で、5ペアのうち3ペア以上に5分足（両側）がある枠（そのペア自身も数える）。
  - 穴は、そのペアに5分足が無い開いている枠が、6枠（30分）以上、切れ目なく続くもの（開いていない枠が間に入れば、そこで切れる）。
  - 合図は、穴の一部でも、新しい方から10本目の足の始まりから T までと重なれば外す。

**4. 鏡の取引と「当たり」**
- 鏡: 同じ合図の、同じ T・同じ E で、向きだけ逆の取引。入りは逆向きの側の終値（買い合図の鏡は売りなので Bid の終値、売り合図の鏡は Ask の終値）。水準は E から、向きを逆にして同じ式（鏡が売りなら損切り E+13、利確 E−n）。追い方・決済する側は 3 と同じ。鏡の pips も、この入りで出す。
- 1つの合図の「勝ち」y: 利確10が先なら1、損切り（amb を含む）が先なら0、未決着は無し。合図と鏡の両方が決着した合図だけ、e ＝ y(合図) − y(鏡)（−1・0・+1）を作る（2 の⑦）。
- 当たり a ＝ e の平均 ÷ 2。意味は「向きをコインで決めた場合（合図と鏡の勝率の平均）より、合図の向きの勝率が何ポイント高いか」。コインなら0。合図と鏡の勝率の差は 2a。文や表では a を使い、「逆向きで入った場合との差」とは書かない。
- 鏡を使う理由:
  - 勝率 W は、T 以後の値で決まる（水準は E から、決済は T 以後の5分足）。追い始めの枠（T の枠）がスプレッドの広い枠（`spread-hours.csv` の avoid=yes。20:30〜24:00 UTC。中央値で 1.4〜19 pips ほど）に入ると、決済する側の値が中値から遠くなり、利確は遠く、損切りは近くなるので、合図の当たりと関係なく勝率が下がる。
  - その枠に入る割合は足で違う（4時間足・8時間足の T は 0・4・8・12・16・20 時なので0。15分足・1時間足は1割ほどの見込み。段0で数える）。この差は、合図の当たりではない。
  - 鏡は、同じ時刻・同じ値段・同じスプレッドで入るので、スプレッドが上下に同じだけ広がる限り、この差は当たりに入らない。そこで、決めるのは勝率でなく当たりの差（P）にし、勝率は条件（G2）と説明にする。
  - 0時に確定する足は、入りの値が 23:45 の枠（中央値 1.4〜4.9 pips）になる。入りの値は pips にだけ効き、勝率には効かない。
- 上げ・下げの偏り（ドリフト）は、層（ペア × 向き）の中で、X と15分足が同じ時刻の混ざり方で入るなら、差に入らない。入る時刻の混ざり方（その時刻の動きの大きさ）が違うと、当たりは動きの大きさの2乗にほぼ反比例するので、少し残る。作り物 D で、それが採用候補を作らないことを確かめる（12）。
- T より後の値動きが上下に同じ確率で起き（それまでの動きと関係なく）、スプレッドも上下に同じなら、合図ごとの e の期待値は0になる（T より後の値動きを E を中心に上下に裏返すと、同じ T・同じ E から入る買いと売りの勝ち負けが入れ替わり、裏返した値動きも同じだけ起こりやすいため）。作り物 N・S で、e の平均が0から離れないことを確かめる（12）。値動き全体を裏返すと、合図も鏡も同じ形の取引に移るので、e は変わらない（12 の裏返しの確かめ）。

**5. 勝率と損益**
- 合図の側: W2・PL2（利確10。主）、W1・PL1（利確4。メールに出している数字）、W3・PL3（利確16。説明）。
- 鏡の側: W2・PL2、W1・PL1（説明。鏡の pips は 4 の入りで出す）。
- 損益ゼロに要る割合を並べる: 利確10 なら 13÷23 ＝ 56.5%、利確4 なら 13÷17 ＝ 76.5%（スプレッドを引く前）。

**6. 値段**（確かめの値段と、コスト）
- 確かめに使う値段（「昔の値段」）: Dukascopy の公開データ（datafeed.dukascopy.com）の、5ペアの1分足、Bid と Ask。
  - 1つのファイルは UTC の1日・1つの側。`{SYMBOL}/{YYYY}/{MM-1}/{DD}/{BID|ASK}_candles_min_1.bi5`（`research/dukascopy.py` と同じ。LZMA、1件24バイト）。価格は整数 ÷ スケール（円のペア 1000・ドルのペア 100000。価格の帯の確かめ〈10〉と段0の近さの確かめで、GMO の終値と照らす）。ティックの無い分（出来高0）は無い。シンボルは USDJPY・EURJPY・AUDJPY・EURUSD・AUDUSD。
  - 日曜〜金曜の UTC の日を読む（日曜の 22:00〜24:00 が GMO の週に入る）。
- 取る期間と、使い方:
  - 2015-03-01〜2023-12-31 の日曜〜金曜の UTC の日を取る。
  - 2015-03-01〜2015-12-31 は、窓の前の足としてだけ読む。T が 2016-01-04 より前の合図は作らず、成績は計算も保存もしない。
  - 合図は 2016-01-04 から（8時間足は GMO の週に16本〈日曜1・月〜木12・金3〉なので、600本は約37.5週・約262日かかる。2015-03-01 から 2016-01-04 は309日）。
  - 2023-10-27 以後は、近さの確かめ（段0）だけに使い、成績は読まない。
  - 2012-01-01〜2015-02-28 は、取らない・読まない。③（時間帯、#207）や #251 が、まだ誰も成績を計算していない昔の値段を使えるように残す（2015-03〜12 の値段は、この研究が窓の前の足として読むが、合図も成績も作らない）。
- 取れなかった日: 取得の時に 404 か空だった日のファイル（ペア × 側 × 日）の一覧を、取得の後・段0の前に `research/ledger/tfbest-missing.csv` に残し、sha256 を定数にする（docs には数だけを書く）。プログラムは、一覧にない日のファイルが欠けていれば止まる（確かめ dukascopyDays。キャッシュや artifact の欠けを見つける）。一覧にある日は、窓の穴（3）と追う足の穴の決まりのとおりに扱う。
- GMO の足にそろえる:
  - 分を GMO の週の中だけ使う: 日曜 22:00 UTC 以後、金曜 21:00 UTC より前。Bid と Ask が両方ある分だけ。
  - 足は、Bid と Ask を別々に、1 の区切りで作る（始値＝最初の分の始値、高値＝最高、安値＝最低、終値＝最後の分の終値。その区間に使う分が1つ以上あれば、足がある）。日曜の最初の足は、22:00 UTC から（日曜 20:00 の4時間足と、日曜 16:00 の8時間足は、22:00〜24:00 の分だけを持つ。#182 と同じ）。そのあと中値と丸め（2）。追う5分足も同じ作り。
  - 祝日の足の有無は、そろえない（2 の祝日の合図を外すだけ。限界として書く）。
- コストの2通り（合図・E・水準は、どちらも同じ。決めるのは鏡との差なので、コストにほとんど左右されない）:
  - D-G（主。P・G1〜G4 はこれで決める）: 中値の四本値（2 の丸めの後）のそれぞれに、GMO のスプレッドの中央値の半分を上下に足す。
    - s は `research/ledger/spread-hours.csv` の median の列（pips）。ペア × 季節（NY が夏時間〈`nyOffsetMs` が −4時間〉なら summer、ほかは winter）× 15分の枠（UTC）。
    - h ＝ (s × pip) ÷ 2（この順に double で）。Bid ＝ 中値 − h、Ask ＝ 中値 ＋ h。Bid・Ask は丸めない。
    - 枠: 入りは、合図の足の最後の1分の始まりの枠。追う5分足は、その足の始まりの枠。
    - median を読む関数を足す（`parseSpreadHours` は avoid の集合しか返さない）。ファイルの sha256 が `SPREAD_HOURS_SHA256` と違えば、何も読まずに止まる。
    - 上下に同じなので、鏡との差は時刻に左右されない。
  - D-D: Dukascopy 自身の Bid・Ask。ずれの強さを見る確認（G5）。
- GMO の値段（段2。見たことのあるデータ）: メールと同じ GMO の Bid・Ask。5分足・15分足・30分足・1時間足の日のファイル、4時間足・8時間足の年のファイル。2時間足は1時間足から作る。
  - 段2の合図は、T が 2024-01-01 00:00 UTC 以上で、追う窓が 2026-10-03 00:00 UTC（tf-winrate の END）までに終わるものだけ。R（2026-10-08）・R_trend（§8.106。置き直す予定）・R_tf 以後の足は読まない。
- Dukascopy と GMO が近いことの確かめ（段0。成績は読まない）: 2023-11-13〜2023-12-30（UTC）の GMO の足と、Dukascopy から作った足を、ペア × 足のセルごとに比べる。
  - 足の有無: GMO にあって Dukascopy に無い足の割合（分母は GMO の足の数）と、Dukascopy にあって GMO に無い足の割合（分母は Dukascopy の足の数）が、どちらも1%以下。2023-12-25（UTC の日）の足は、割合から除いて別に出す。
  - 終値: 両方にある足で、|GMO の中値の終値 − Dukascopy の中値の終値|（pips）の中央値が0.5以下。99%点（`money-stats.ts` の quantile。昇順に並べた floor(0.99 × (n−1)) 番目）が5以下。99%点は、足の最後の1分の始まりが avoid=yes の枠（20:30〜24:00 UTC）にある足を除いて出す（その枠の足は別に出す）。
  - 合図: セルの、送られる合図（2 の②だけを当てる。①は、近さの確かめの期間 2023-11-13〜2023-12-30 に置き換える。③〜⑦は当てない）が GMO・Dukascopy のどちらも20個以上の時だけ、同じ足・向きで合う割合が、GMO の合図に対しても Dukascopy の合図に対しても60%以上。20個未満のセルは「対象外」と出す。
  - 1つのセルでも外れたら、その足を落とす（落とした名前と理由を書く）。15分足が外れたら、そこで止めて、オーナーに伝える。

**7. 数え方と、決め方**
- 期間と半分:
  - 合図の T が 2016-01-04 00:00 UTC 以上・2023-10-01 00:00 UTC 未満。追う窓は 2023-10-27 00:00 UTC より前に終わる（GMO の始まり。成績はこの日以後を読まない）。
  - 週番号 wk(t) ＝ floor((t − WEEK_OFFSET) ÷ 1週)（WEEK_OFFSET は3日21時間。週は日曜 21:00 UTC から。`lib.ts`）。
  - W は期間の暦の週の数（合図の有無によらない）: W ＝ wk(2023-10-01 00:00 UTC − 1ミリ秒) − wk(2016-01-04 00:00 UTC) ＋ 1 ＝ 2803 − 2400 ＋ 1 ＝ 404（2016-01-03 21:00 の週から 2023-09-24 21:00 の週まで）。
  - 前半は wk(T) − 2400 が 202 未満の合図（T が 2019-11-17 21:00 UTC より前）、後半は残りの202週。すべての足と15分足で同じ。
- 層: ペア × 向きの10（並びは 1 のペア × 買い・売り）。
- 差 Δ_y（y は a・W2・W1・PL2・PL1。X − 15分足）:
  - Δ_y ＝ Σ 層 s（n_X,s ÷ N_X）×（X の平均_s − 15分足の平均_s）。重みは X の層の割合。つまり「X の合図の、ペアと向きの割合にそろえた、15分足との差」。§8.106 段1の作り 3 の δ の式で、「残した」を15分足、「外した」を X として、符号を逆にしたもの（B30 と同じ向きの扱い）。
  - 層に X か15分足のどちらかが無ければ、その層は入れない（X の入れなかった合図の数を出す）。N_X は入れた層の X の合図の数の和。
  - W の差は決着した合図、PL の差は数えた合図（未決着を含む）、a の差は e のある合図で作る。a の1件は e ÷ 2。
  - 文のための重みつきの当たり: a^w_X ＝ Σ (n_X,s ÷ N_X) × X の a の平均_s、a^w_15 ＝ Σ (n_X,s ÷ N_X) × 15分足の a の平均_s。Δ_a ＝ a^w_X − a^w_15。
  - 標準誤差（影響関数。層の平均の誤差を入れる）: X の合図 i（層 s）は (y_i − X の平均_s) ÷ N_X。15分足の合図 i（層 s）は −(n_X,s ÷ N_X) × (y_i − 15分足の平均_s) ÷ n_15,s。塊ごとに足して S_g を作り、標準誤差 ＝ √(C ÷ (C−1) × Σ S_g²)。C は、入れた層について、その y で数えた合図（W なら決着、a なら e のある合図）が X か15分足にある塊の数。
  - 塊: 週（wk(T)）と、4週（floor((wk(T) − 2400) ÷ 4)。期間の最初の週から4週ずつ）。幅の半分（t(0.975, C−1) × 標準誤差）が広い方を使う（同じなら週。4週の塊が10に足りなければ週だけ）。自由度は、使った方の C − 1。
  - 幅: Δ ± t(0.975, 自由度) × 標準誤差。t ＝ Δ ÷ 使った方の標準誤差。C < 2・N_X が0・標準誤差が0 なら t は無い。
  - t の分布: Student の t を、不完全ベータ関数（Numerical Recipes の betacf）と2分法（幅 1e-12 まで）で出す（`money-stats.ts` の `tQuantile` と同じ作り）。手の例: 自由度 1・9・17・71 で t(0.975) ＝ 12.7062047・2.2621572・2.1098156・1.9939434。
- 1つの足の幅（W・PL・a。説明）: 1件ごとの影響 (y_i − 平均) ÷ N を週の塊ごとに足し、標準誤差 ＝ √(C ÷ (C−1) × Σ S_g²)、幅 ＝ 平均 ± t(0.975, C−1) × 標準誤差。W は決着した合図、PL は全部、a は e のある合図で。
- 床（数だけで決める。成績を見る前。段0）: 数えるのは、2 の①〜⑥を通った合図（⑦は成績の数なので使わない）。比べる足は、次をすべて満たすものだけ。
  - 合図が500通以上。
  - 10の層のどれもが20通以上。
  - 合図のある週が100週以上。
  - 6 の近さの確かめを通る。
  - 2 の④（遅れた合図）が0.5%以下、⑤（窓の穴）が2%以下。
  - 満たさない足は落とし、名前と満たさなかった条件を書く。残った足の数を m とする（6以下）。m は段0で決まり、成績を見た後に変えない。15分足が満たさなければ止まる。
  - 作り物では、床を計算して出すが、足を落とさない（m ＝ 6。12）。
- 比べの多さの直し（Holm）:
  - 主の検定は、Δ_a（X − 15分足、D-G）が0より大きいか。片側。m 個の足のそれぞれについて、片側の p ＝ 1 − T(t, 自由度) を出す（T は Student の t の累積。上と同じ作り）。
  - t が無い足は p ＝ 1 とし、m に数え、並びの最後に置く（「言えない」）。
  - p の小さい順に 1, …, m と並べ（同じなら t の大きい順、それも同じなら短い足）、k 番目の p が 0.025 ÷ (m − k + 1) 以下である間、「0より大きい」とする。1つでも満たさなければ、そこで止める（それより後の足はすべて「言えない」）。一番上の足の基準は、片側 0.025 ÷ m（m が6なら 0.42%）。
  - 説明のため、どの足にも、Δ_a の95%の幅（両側、直さない）を出す。
- 見たことのあるデータでは、足を選ばない: GMO の 2024〜2026年（段2）は、決めるのに使わない。**決めるのは、Dukascopy の昔の値段で、すべての足を1回だけ**（段1）。「見たことのあるデータで1つ選んでから確かめる」やり方は、選ぶ時の運が大きく、力が落ちる（見直しの指摘）ので、しない。

**8. 決め方と文**（段1）
- 足 X（m 個のうちの1つ）の条件（すべて段1の値段で）:
  - P: Holm で、Δ_a（D-G）が0より大きい。
  - G1: Δ_W1 ≧ 0、Δ_PL1 ≧ 0、Δ_PL2 ≧ 0（D-G。メールに出している数字と、利確10の1回あたりが下がらない）。
  - G2: Δ_W2 > 0（D-G。勝率が高い）。
  - G3: Δ_a（D-G）が、前半でも後半でも0より大きい（点だけ。7 の半分）。
  - G4: Δ_a（D-G）が、5ペアのうち3つ以上で0より大きい（点だけ。ペアごとに同じ式で、層は向きの2つ）。
  - G3・G4 で Δ_a が作れない時（共通の層が無い・N_X が0）は「0より大きくない」とし、そう出す。
  - G5: D-D でも Δ_W2 > 0。
  - G6: 確かめ（10）がすべて通り、Python が合い、その X の合図の側・鏡の側と、その X の Δ_a で、疑う合図（13）が1つも当たっていない（プログラムが数える）。15分足の合図の側・鏡の側で当たった時は、すべての X で G6 を満たさない。
  - 0との比べは、|x| < 1e-12 は0とする（「> 0」は満たさず、「≧ 0」は満たす）。
- 足ごとの判定（1つの足に1つ。この順で、最初に当たったもの）:
  - 採用候補: P と G1〜G6 をすべて満たす。
  - 悪い: Δ_a の95%の幅（両側、直さない）の上の端が0より下。
  - 一部: P を満たし、G1〜G6 のどれかを満たさない。
  - 言えない: それ以外。Δ_a の点が0より大きくても、Holm を通らなければここ。
- 採用候補が複数なら、どれにも文を出す。9 の確かめに進める「一番」は、同時の下限 Δ_a − t(1 − 0.025 ÷ m, 自由度) × 標準誤差 が一番大きい足（同じなら短い足）。t が一番大きい足と違う時は、そう書く。「一番」は、9 に進める足を決めるのにだけ使う。
- 数字の書き方: ポイントと % は小数1桁、pips は小数2桁。符号をつけるのは、差（Δ と、その幅の両端）・当たり（a、a^w_X、a^w_15）・pips の値（PL）。勝率の % には符号をつけない。正確な2進の値を10進に直し、ちょうど半分は上へ丸める（TS は toFixed、Python は Decimal の ROUND_HALF_UP）。符号をつける数は、丸めた後の数字がすべて0なら、元の符号（−0 を含む）によらず「+0.0」（pips は「+0.00」）と書く（−0.04 も「+0.0」。§8.106 の「-0.0」とは違う決まり）。週の数は W（404）。
- 1週あたりのメールの通数: 2 の①・②を通った合図から、30分足以上では④（遅れた合図）を除いた数 ÷ W を、整数に丸める（ちょうど半分は上へ）。5分足・15分足の遅れた合図は、本番でメールになるので数える。
- 文（○は数字で埋める。〈m〉は床を通った足の数）:
  - 採用候補: 「選ぶのに使っていない2016年1月〜2023年9月の値段（Dukascopy、5ペア、404週。スプレッドは今の GMO の時間帯ごとの中央値）で、〈X〉の合図は、利確10が損切り13より先 ○%・1回あたり ○ pips、15分足は ○%・○ pips でした（どちらも、そろえない値。ペアと向きの割合をそろえた勝率の差は ○ポイント）。向きをコインで決めた場合より、〈X〉は勝率が ○ポイント、15分足は ○ポイント高く（どちらも〈X〉の合図のペアと向きの割合にそろえた値）、その差 ○ポイント（95%の幅 ○〜○）は、〈m〉つの足を比べた分を直しても、0より大きいと言えます。選んだ後の数字なので、本当の差はこれより小さい見込みです。メールに出している利確4が先は、〈X〉○%・○ pips、15分足 ○%・○ pips。前半・後半とも〈X〉が上で、5ペアのうち○ペアで上でした。メールは、15分足の週 約○通から、約○通になります。まだ決定ではありません。〈続き〉」
    - 〈続き〉は、「一番」の足（9 に進める足）なら「これからの GMO の足で、8週が経ち、〈X〉の合図が買い・売りそれぞれ5回以上で30回たまった所で、明らかに悪くなっていないかを1回だけ確かめてから、メールを替えるか、並べるかを決めてもらいます。26週たっても足りなければ、替えません。」。ほかの採用候補なら「これからの確かめには進めません（進めるのは〈一番の足〉です）。」
    - 文の「勝率が ○ポイント」は a^w_X と a^w_15、「その差」は Δ_a（＝ a^w_X − a^w_15）。「ペアと向きの割合をそろえた勝率の差」は Δ_W2（G2）。
  - 採用候補が複数の時（最後に足す）: 「採用候補は〈X1〉・〈X2〉…です。これからの確かめに進めるのは、比べた分を直した下の端が一番高い〈X〉です（〈t が一番大きいのは〈Y〉です〉）。」
  - 悪い: 「選ぶのに使っていない2016年1月〜2023年9月の値段で、〈X〉は15分足より当たりが低い結果でした（差 ○ポイント、幅 ○〜○。利確10が先の勝率 〈X〉○%・15分足 ○%、1回あたり 〈X〉○・15分足 ○ pips）。メールは15分足のままです。」
  - 一部: 「選ぶのに使っていない2016年1月〜2023年9月の値段で、〈X〉は15分足より当たりが高いと、〈m〉つの足を比べた分を直しても言えました（差 ○ポイント、幅 ○〜○）。しかし、〈理由〉ので、決めた条件を満たしません。メールは15分足のままです。それでも替えるかは、オーナーが決めてください（その場合は、決めた条件ではなく、結果を見て決めたことになります）。」
    - 〈理由〉は、満たさなかった G を番号の順に、すべて「、」でつなぐ: G1「メールの利確4の勝率か1回あたり、または利確10の1回あたりが下がった」、G2「利確10が先の勝率が上がらなかった」、G3「前半か後半で逆だった」、G4「5ペアのうち上は○ペアだけだった」、G5「Dukascopy 自身のスプレッドでは勝率が上がらなかった」、G6「疑う合図（〈当たったものの名前〉）に当たった」。
  - 言えない: 「選ぶのに使っていない2016年1月〜2023年9月の値段で、〈X〉と15分足のどちらが当たるとも言えませんでした（差 ○ポイント、幅 ○〜○）。差が無いという意味ではありません。幅の端のうち0から遠い方（○ポイント）くらいの差があっても、この数では見分けられないことがあります。メールは15分足のままです。」
    - t が無い足（7）は、括弧と「幅の端…」の文の代わりに「（差と幅は出せませんでした）」と書く。
  - 最後に足す文（採用候補が無い時）:
    - P を満たす足が1つも無い時: 「比べた〈m〉つの足のどれも、15分足より当たるとは言えませんでした。メールは15分足のままです。」
    - P を満たす足はあるが、採用候補が無い時: 「〈P を満たした足〉は15分足より当たりが高いと言えましたが、決めた条件を満たさなかったので、メールは15分足のままです。」
- いつも添える文: 「どの足も勝率100%には遠い数字です。損切り13・利確10で損益ゼロに要る勝率は約57%、利確4なら約76%（どちらもスプレッドを引く前）です。でたらめに入ってもほぼこの割合になるので、足による差は小さく出ます。」
- 見込み（計算したものではなく、掛け算。段0の数で置き換える）:
  - 5ペアの ULTRA の合図は、2016〜2023年（約8年）で、15分足 約28,000・5分足 約80,000・30分足 約14,000・1時間足 約7,000・2時間足 約3,500・4時間足 約1,800・8時間足 約900。
  - 1つの足の Δ_a を、Holm の最初の段（片側 0.025÷6）で8割の確かさで見分けられる大きさは、5分足 約1.4・30分足 約2.1・1時間足 約2.7・2時間足 約3.6・4時間足 約4.9・8時間足 約6.8 ポイント（a の1件の標準偏差 約0.47、設計効果 1.5 と置いた）。
  - これまでの数字（1時間足 +1.9、4時間足 +2.3 ポイント。物差しに対する X の当たり a にあたる）から、a_X は0〜3ポイントと思う。検定する Δ_a ＝ a_X − a_15 は、15分足の a を見ていないので分からない（15分足の a も正なら、Δ_a はもっと小さい）。
  - **「言えない」で終わる見込みが高い。その時は、メールは15分足のままで、そう伝える。**

**9. これからのメールで、明らかに悪くなっていないかを1回だけ確かめる**（8 で採用候補が出た時だけ。進めるのは「一番」の足 X）
- R_tf ＝ この決まりを main にマージした後の、最初の 00:00 UTC。**2026-10-11 00:00 UTC**（日本時間 10/11 9:00）。PR #190 を 2026-10-10 11:15:12 UTC にマージした（merge d9ab18e）。マージ後に決まりを変えたら、置き直す。
- 8週が経ち、R_tf 以後にメールに出る形の X の合図のうち、合図と鏡の両方が決着した（e のある）ものが30回（買い・売りそれぞれ5回以上）たまったら、1回だけ。26週たっても足りなければ「数が足りない」で、替えない。
- X をどう追うか、オーナーが選ぶ（確かめの前に）: (a) X の合図を、15分足と並べて送る（今のメールで送れる足の時だけ。30分・2時間・8時間足は、メールの仕組みを足してから。既定。送ったメールと計算した合図を照らす）。(b) 送らず、GMO の足から計算するだけ（「メールで送っていない合図で確かめた」と書く）。
- 見るのは、X の当たり a（X の合図と、その鏡の取引の勝率の差の半分）だけ。説明として、X の W2・PL2・W1・PL1 も添える（GMO の実際のスプレッドでの、メールに出している数字）。
- 15分足の R_tf 以後の a は、①(b)・②・#250 の確かめが済むまで計算しない（済んだ後に、同じ週で計算してよい）。
- 幅: 7 の1つの足の幅と同じ作り（週の塊）で、片側95%の上の端 ＝ a ＋ t(0.95, C−1) × 標準誤差。上の端が0より下なら「明らかに悪い」、それ以外は「明らかには悪くない」（良くなったという確かめではない）。C が2未満なら「数が足りない」。
- 文:
  - 明らかに悪い: 「これからの GMO の足（○週、〈X〉○回）では、〈X〉の当たり（向きをコインで決めた場合との勝率の差）が、0より低い結果でした（○ポイント、片側95%の上の端 ○）。メールは15分足のままです。」
  - 明らかには悪くない: 「これからの GMO の足（○週、〈X〉○回）では、〈X〉は明らかには悪くありませんでした（当たり ○ポイント、片側95%の上の端 ○。利確10が先 ○%・1回あたり ○ pips、利確4が先 ○%・○ pips）。これは『明らかに悪くなっていないか』の確かめで、『良くなった』の確かめではありません。この数では、当たりがコインより悪くても、−○ポイント（○ ＝ t(0.95, C−1) × 標準誤差）より上なら見つけられません。段1の当たり（○ポイント）から数えると、○ポイント（段1の当たり＋上の○）まで下がっても見つからないことがあります。次から選んでください。(A) 〈X〉だけにする（15分足のメールを使う ①(b)・②・#250 の確かめは止まります）。(B) 〈X〉を足し、15分足は #250 と ② の確かめが済むまで残す。(C) 15分足のままにする。」
  - 数が足りない: 「26週たっても〈X〉の合図が30回に届かなかったので、言えません。メールは15分足のままです。」

**10. 確かめ**（それぞれ、止める段を〔 〕に書く。外れたら、その段の数字を出さない。段1の数字は、〔段1〕の確かめがすべて通った後にだけ出す）
- 先読み:
  - 切り取り〔段0・段1〕: すべての足・合図で、窓を、その合図の確定の時刻までの足だけで作り直しても、合図と E が同じ。
  - 毒〔段0・段1〕: T 以後の足・分・5分足を ±777.7 pips 動かしても、合図と E が変わらない。
  - 追う足〔段1〕: T 以前に終わる5分足を ±777.7 pips 動かしても、成績は変わらない。T 以後の最初の足を動かすと、すべての合図の成績が変わる。
  - closeSame〔段1〕: 合図の足の終値と、同じ時刻に終わる5分足の終値が、pip ÷ 100 以内で同じ。同じ時刻に終わる5分足が無い合図は、この確かめの対象外として数える（closeNoFine。合図は外さない）。closeNoFine が、ある足の合図の1%を超えたら止まる。
  - indicatorSignals〔段0〕: メールの関数 `indicatorSignals` と、このプログラムの合図が、全部の合図と見本の足で、食い違い0。
- 期間〔段0・段1・段2〕: (1) 数えた合図のすべてで、T が 7 の期間の中（段2は 6 の段2の期間の中）。(2) 段1の成績に使った5分足が、すべて 2023-10-27 00:00 UTC より前に始まる（段2は、追う窓が 2026-10-03 00:00 UTC までに終わる）。(3) 読んだ Dukascopy のファイルの日付が 2015-03-01〜2023-12-31。(4) T が 2016-01-04 より前の合図が0。作り物では、作り物の期間（12）で同じことを見る。
- 手の例〔どの run でも走る。TS と Python の両方〕: 追い方を使わない手の例（E の丸め・t の分布・grid・session・spread〈枠・h の値・入りの枠〉・送られる合図・祝日・遅れた合図・外す理由の順番〈①〜⑥〉・半分・窓の穴・床・近さ・線ちょうどの表）は、段0の run でも走る。追い方を使う手の例（followHand・鏡・当たり・spread〈損切りの水準とちょうど同じ例の結果、入りの値と pips〉・外す理由の順番〈⑦〉・δ・Holm・判定と文・疑う合図）は、手作りのデータだけを使う別のプロセスで走らせる（段0の数を数えるモジュールは、追い方を読み込まない。13）。
  - followHand〔追い方を使う〕、E の丸め（150.0625 → 150.063）、t の分布（7 の自由度 1・9・17・71）。
  - 鏡（買いと売り、上に先に動く／下に先に動く／始値で越える／未決着。pips まで。入りは逆向きの側の終値）、当たり（a ＝ 0.5・−0.5・0）。
  - grid（足の始まりと終わり。日曜・金曜の足、2時間足と8時間足、4時間足の日曜 20:00）、session（夏の日曜 21:00〜22:00 の分を捨てる、冬の金曜 21:00〜22:00）。
  - spread（枠の端、NY の夏時間の切り替わり 2016-03-13・2016-11-06。h の値: h が刻みの上にある例〈円・ドルとも s ＝ 0.4 pips〉と、h が刻みの外の例〈s ＝ 0.3 pips〉。1時間足の入りの枠: ドル円・夏の 20:00〜21:00 の足の合図は、最後の分 20:59 が 20:45 の枠（10.1 pips）で、最初の分 20:00 の枠（0.5 pips）ではない）。
  - spread〔追い方を使う〕: h が刻みの上にある例で、Bid の安値が損切りの水準とちょうど同じになる例の結果（損切り）。1時間足の入りの例の、合図と鏡の入りの値と pips。
  - 送られる合図（金曜の足、日曜の足）、祝日の窓の端（12/24 00:00 は外す、12/27 00:00 は外さない）、遅れた合図、外す理由の順番（①〜⑥。⑦〈合図か鏡が未決着〉の例は追い方を使う側で走る）。
  - 半分（2019-11-17 21:00 UTC の直前と直後の合図）。
  - δ（§8.106 の deltaHand と同じ形で、X − 15分足の向き。a^w_X − a^w_15 ＝ Δ_a）、Holm（p の順と止まり方。t が無い足を含む）。
  - 線ちょうどと1つ下の手作りの表: 床（500通・層20通・合図のある週100）、窓の穴（6枠と5枠、開いていない枠で切れる）、遅れた合図の0.5%、⑤・⑦の2%、closeNoFine の1%、近さの確かめ（1%・0.5 pips・5 pips・60%・20個）。
  - 判定と文（Holm を通らず点は＋の足は「言えない」、G6 だけ外れた「一部」、G が複数外れた「一部」、採用候補が複数、P を満たす足があり採用候補が無い時の最後の文、数字の書き方、別の足で疑う合図が当たった時〈その足だけ G6 を満たさない〉、15分足で当たった時〈すべての X が G6 を満たさない〉、当たった足が P を満たさない時〈8 の順で「悪い」か「言えない」〉、t が無い足の「言えない」）。
  - 疑う合図（線ちょうどと1つ下）。
- 数が合う: 〔段0・段1〕全部の合図 ＝ 2 の①〜⑥の理由ごとに外した数の和 ＋ 数えた合図（①〜⑥を通った合図）。段0で確かめるのはこの式だけ。〔段1〕決着＋未決着 ＝ 数えた合図。e のある合図 ＝ 数えた合図 − ⑦。
- 出してよい項目〔段0・段1・段2〕: print の項目を、プログラムに書いた「出してよい項目」の一覧と照らし、ほかの項目があれば何も出さずに止まる（§8.103 と同じ）。
- データ（Dukascopy）〔段0・段1〕（段1は、キャッシュか artifact から読み直すので、同じ確かめをもう一度行う）:
  - 読み込みの失敗（読めない・壊れたファイル）が0.1%以下。404 と空の日は dukascopyDays で扱う。
  - dukascopyDays: `tfbest-missing.csv` の sha256 が定数と同じで、そこに無い日のファイルが、その run で読む範囲の日について、ペア × 側ごとにすべてある。
  - 同じ時刻の重複0。Ask < Bid の分は捨てて数え、ペア・年で0.1%を超えたら止まる。四本値の矛盾0。
  - スケール（価格の帯）: USD/JPY 70〜170、EUR/JPY 90〜180、AUD/JPY 50〜115、EUR/USD 0.90〜1.65、AUD/USD 0.50〜1.15 を出た分があれば止まる。作り物では、作り物の始値の 0.25〜2.5倍を帯とする（12）。
  - 日曜 22:00 UTC の5分足が無い週の数（説明。止まらない。祝日の窓にかかる週〈日曜が 2016-12-25・2017-01-01・2017-12-24・2017-12-31・2021-12-26・2022-01-02・2022-12-25・2023-01-01〉は別に出す）。
- データ（GMO）〔段0・段1・段2〕: 読み込みの失敗0。5分足の穴が30分以上で、休みでも5ペア共通の GMO の休みでもないものが、追う窓で0。
- 近さの確かめ（6）〔段0〕。
- tf-winrate との照らし合わせ〔段1〕:
  - 段1の job の中で、段1の数字を出す前に、GMO の 2024-01-01〜2026-10-03 で、このプログラムの GMO の道と tf-winrate（5ペア・START 2024-01-01・END 2026-10-03T00:00:00Z・損切り13・利確 4/10/16・週末 inside）を走らせて比べる。
  - tf-winrate の標準出力と標準エラーはファイルに書き、ログには「GMO reads that failed」の行と確かめの合否だけを出す。`tf-winrate.json` は確かめだけに読み、残さない（§8.106 段1の作り 2 と同じ）。GMO の成績は、ここでは出さない（段2で出す）。
  - 比べるのは、tf-winrate が扱える足（5分・15分・1時間・4時間）の「ULTRA・全部」の件数（n・利確・損切り・両方・未決着）と pips の平均（1e-9 以内）。このプログラムの数は、2 の③（祝日）・⑤（窓の穴）で外す前で、④（遅れた合図）で外した後のもの（tf-winrate は、足 i を最新にした窓で出た合図だけを数えるため）。END までに1,440本を追えない最後の合図は、tf-winrate と同じく追わない。
  - 30分・2時間・8時間足には、この照らし合わせが無い（Python の計算し直しだけ。限界）。作り物では、この照らし合わせを行わず、行わなかったことを checks.json に書く。
- 計算し直し（Python。11）〔段0・段1・段2〕。
- 作り物（12）〔段1の前。dispatch では、作り物がすべて通った時だけ実データを走らせる〕。

**11. 別の計算し直し（Python）**
- 別のエージェントが、この §8.107 の全体と、ここで参照している §8.106 段1の作り 1〜3（E の丸め・追い方・δ と標準誤差と塊と t の分布）と、§8.102 の送られる合図の決めだけを読んで書く（TS は読まない。`research/tfbest-check.py`）。取得したファイルから計算する。
- 足の作り（分から）、窓、`anchoredStart`、RSI、合図、送られる合図、遅れた合図、外す理由と順番、E、追い方、鏡、a、W・PL、層、Δ、標準誤差、t、Holm、床、近さの確かめ、判定と文が、TS と同じ（数は 1e-9 以内。選び方と文は同じ）。
- 違った数の値は出さず、どこが違うかだけを出す。

**12. 作り物の値動き**（プログラムの確かめ。決めた通りに動くか）
- 共通の作り:
  - 作り物は、Dukascopy の形のファイルと、GMO の形のファイルの両方を、同じ値動きから書き、本物と同じ読み込みで読む。
  - 期間: 日付は本物と同じ 2015-03-01 から（窓の前の足）。合図の T は wk(T) − 2400 が 0〜155（2016-01-04 00:00 UTC 以上、2018-12-30 21:00 UTC 未満。W ＝ 156、前半は wk(T) − 2400 が 78 未満〈T が 2017-07-02 21:00 UTC より前〉、4週の塊は39）。値段は、T の範囲の終わりの2週後（2019-01-13 21:00 UTC）まで書き、追う窓はそこまでに終わる。7 の期間・半分・塊、10 の期間の確かめは、この期間で行う（実データの式の 404・202 を、156・78 に置き換える。半分の境は「wk(T) − 2400 が floor(W ÷ 2) 未満」）。
  - 始値と動き: 始値は USD/JPY 110.000・EUR/JPY 125.000・AUD/JPY 80.000・EUR/USD 1.10000・AUD/USD 0.70000。5ペアの1分の中値は、刻み（0.1 pip）の上に置く。1分の動きの大きさ（標準偏差）は、円のペア 1.0 pip・ドルのペア 0.6 pip に、UTC の時間帯の倍率（00〜06時 0.8、07〜15時 1.2、16〜20時 1.0、21〜23時 0.6）を掛けたもの。上下には同じ（D・E・EQ・O を除き、上げ・下げの偏りは無い）。
  - 価格の帯（10 のスケール）は、作り物では始値の 0.25〜2.5倍とする（10倍の誤りは見つかる。豪ドル/円でも、ドリフトの無い約150 run のどれかが帯を出る確率は約0.007%）。N と D の値動きが、期間中この帯を出ないことを、試しの種 901〜920 で確かめて docs に書く。
  - Dukascopy の形のファイルのスプレッドは、N・D・E・EQ・O では上下に 0.1 pip ずつ（合わせて 0.2 pips）。S・SA は下に書く。上下の広がりは刻みの偶数倍にし、中値の丸めが起きないようにする。
  - D-G は、本物と同じく `spread-hours.csv` の中央値を中値に足す。
  - 近さの確かめ（6）は、作り物の期間の最後の7週の足で行う。GMO の道（段2・tf-winrate との照らし合わせにあたるもの）は、作り物の GMO の形のファイルで、作り物の期間で走らせ、GMO の穴の確かめを通す。tf-winrate との照らし合わせは実データだけで行い、作り物では行わなかったことを checks.json に書く。
  - 床（7）は計算して出すが、足を落とさない（m ＝ 6。3年では8時間足が約350通で、床の500通に届かないため）。床の判定は、10 の線ちょうどの手作りの表で確かめる。
  - 作り物の「採用候補」は、P と G1〜G5 で数える（G6 の疑う合図は数えて出すだけ。E は強い力を入れるため）。
  - 作り物には自然な穴が無いので、2 の⑤（窓の穴）で外した合図が0であること（0でなければ外れ）。
- 強さの決め方: 作り物ごとに、目標と、動かしてよい量を1つだけ決めておく。量は、試しの種 901〜920 で、目標に合う値に決め、正式な種を走らせる前に docs に書く。目標は、生成器の側で測った値か、採用候補の数ではない出力で見る（採用候補の数を見て強さを変えない）。正式な種を走らせた後は変えない。
- 種と数と、通る条件:
  - N 効果なし（50通り、種 101〜150）: (1) Holm を通る足が出る run が4つ以下。(2) どの足でも、直さない片側 2.5% の検定を通る run が5つ以下。(3) 15分足を含む7つの足のそれぞれで、50 run の a の平均 ÷（run の a の標準偏差 ÷ √50）の絶対値が3.5未満。
  - 裏返し（N の種 101〜105 の値動きを、最初の値を中心に上下に裏返した5通り。スプレッドは上下に同じなので、Bid と Ask が入れ替わる）: 合図の時刻・足・ペアが元の run と1対1で合い、向きが逆。合図ごとに、裏返した run の合図の y は、元の run の同じ合図の y とぴったり同じ、pips は 1e-9 pips 以内で同じ（pips は double の計算で最後の桁がずれるため）。鏡の y と pips も、元の鏡と同じ決まりで同じ（したがって e も同じ）。RSI がちょうど30か70の足（1e-9 以内）と、水準にちょうど届く例（差 pip ÷ 1000 以内）は、例外として数えて出す。
  - D 一定の上げ（30通り、種 201〜230）: 5ペアとも上げの、一定のドリフト（§8.106 の D と同じ向き。下げにすると、値の低いペアが帯を出やすいため）。量は「1分あたり 係数 × そのペアの1分の動きの大きさ」の係数1つ。目標は「ペアごとに、鏡も層も使わない15分足の『買いの W2 − 売りの W2』を出し、その5ペアの平均が約4ポイント」（8ポイントでは、期間中に帯を出るため）。通る条件: 採用候補が出る run が3つ以下。歯の確かめ（e の平均で向きの偏りを見つけられることの確認）: 15分足の D-G で、30 run をまとめた買いの合図の e の平均が正、売りの合図の e の平均が負で、どちらも run 間の標準誤差の3倍を超える（上げのドリフトでは、買いの合図は鏡の売りより勝ちやすく、売りの合図は鏡の買いより負けやすいので、向きは式から決まる）。
  - S スプレッドだけ（30通り、種 301〜330）: Dukascopy の形のファイルのスプレッドを、枠ごとに `spread-hours.csv` の median（9割）か p90（1割）にし（刻みの偶数倍に丸める）、上下に同じだけ広げる。D-G は中値に CSV を足し直すので、P・G1〜G4 では S は N と同じ作りになる。S が見るのは D-D（G5）の側。通る条件: 採用候補が出る run が3つ以下。D-D の a で、N の (3) と同じ確かめ（30 run、3.5未満）。説明として、30 run をまとめた8時間足の生の勝率の差 Δ_W2（D-D と D-G の両方）を出す（鏡を使わない比べは時刻の違いで動くことの確認。通る条件には入れない）。
  - SA 広がりが片側（30通り、種 401〜430）: Bid ＝ 中値、Ask ＝ 中値 ＋ CSV の median（刻みに丸める）。ファイルの中値は、時間帯で median の半分だけ動く（その汚れが D-G に入る）。通る条件: 採用候補が出る run が3つ以下。説明として、15分足の D-D の、買いの合図と売りの合図の e の平均を出す（向きは、作り物の時間帯ごとの動きと、合図がどの枠に集まるかで決まり、式からは決まらないので、通る条件には入れない）。
  - E 本当の力が4時間足の合図にある（10通り、種 611〜620）:
    - 生成器の中で、4時間足（UTC の区切り）の中値の終値から、本番とは別に書いた短い式で RSI 14（Wilder、データの最初から）を逐次に計算し、30 を上へ・70 を下へ抜けたら、その足の確定の直後から4時間、1分ごとに g ÷ 240 pips を合図の向きに足す（確定より前の値は変えない。重なれば足し合わせる）。
    - 動かす量は g の1つで、目標は「試しの種で測ったパイプラインの Δ_a（4時間足 − 15分足、D-G）が約10ポイント」（採用候補の数は見ない）。あわせて、生成器の側で測った4時間足の a（生成器が見つけた合図と鏡を、1分の中値で、利確10・損切り13まで追ったもの）も docs に書く。
    - 通る条件: 4時間足が採用候補（P と G1〜G5）になる run が6つ以上。3年の作り物では Δ_a の標準誤差が約2.3ポイントなので、1 run の通る確率の見込みは約0.9、10通り中6つ以上の確率は約99%（G1〜G5 を足した実際の確率は、試しの種で測って docs に書く）。
    - 平均回帰（半減期4時間）の作りは使わない。見直しの模擬で、平均回帰では15分足の方が当たり、4時間足の合図は1ペア年あたり1〜4通に減ったため（4時間足が採用候補になれない）。
  - E3 実際の大きさ（10通り、種 621〜630）: E と同じ作りで、目標を約3ポイント（パイプラインの Δ_a）にする。4時間足が採用候補になる run の数を出すだけ（説明。3年なので、8年の実データより見分ける力は弱い）。
  - EQ 同じ力があらゆる足にある（10通り、種 501〜510。説明だけ）: 7つの足のそれぞれで E と同じ押しを入れ、足ごとの g を、生成器の側で測った a がどの足でも約5ポイントになるように決める。生成器の側の a と、採用候補が出た run の数を出す。押しが重なるので、足ごとの a をちょうど同じにはできず、小さな差（例えば5分足で1ポイント）でも正しく見分けられることがあるため、通る条件にはしない。
  - O 答えを知っている（4通り、種 801〜804）: すべての足の合図の向きを、T と T＋4時間のそれぞれで最新の5分足の中値の終値を比べた向き（上なら買い、下なら売り、同じなら合図なし）に替える。
    - この run で外れてよい確かめは、切り取り・毒・indicatorSignals・追う足（O の向きが T の足と T より後の足で決まるため）。同じ値で消えた合図は「O で消した」として数え、数が合うに入れる。それ以外の確かめは、すべて通ること。外れてよい確かめが実際に外れたことと、通った確かめを checks.json に書く。
    - 通る条件: 4通りとも、外れてよい4つの確かめのうち切り取りと毒が外れ、4時間足の a が線（試しの種で測った4時間足の a の半分。docs に書く）を超え、13 の疑う合図が当たる。数字は、ふつうの出力とは別に出す。Python も同じ規則で向きを計算し直す。
- 通る確率（正しい手順でも外れる確率。二項分布と t の分布で計算した）:
  - N: (1) 50のうち5つ以上 0.81%。(2) 1つの足で6つ以上 0.15%、6つの足のどれか 0.90%。(3) 1つの足で 0.10%、7つの足のどれか 0.70%。N の合計 約2.4%。
  - D・SA: 30のうち4つ以上 0.64%（P だけの確率 2.5% から出した上限。G1〜G5 があるので実際はもっと低い。D・SA では本当の Δ_a がちょうど0とは限らないので、目安）。D の歯の確かめは、4ポイントの差なら標準誤差の10倍以上の見込みで、外れる確率はほぼ0（試しの種で確かめて docs に書く）。
  - S: 0.64% と、(3) と同じ確かめの 1.06%（7つの足。自由度29）で、合計 約1.7%。
  - E: 1 run の通る確率が 0.9 なら 0.16%、0.85 なら 0.99%。
  - 裏返し・O は、正しい手順なら外れない。
  - 全部の合計の上限: E を除いて約5.4%（E を 0.16% とすると約5.6%）。作り物が価格の帯で止まる分（約0.007%）は、これに比べて小さい。
- 外れた時の手順（今、固定する）: 種・数え方・線は変えない。実データは走らせない。結果を docs に書き、オーナーに伝えて止める。回し直しや決まりの変更は、決まりの変更として扱い、R_tf を置き直す。
- 仕込んだ誤り（作り物でだけ設定できる。それぞれ、書いた確かめが見つける）:
  - 確定していない足を使う → 切り取り。T の次の足から E を取る → 毒。
  - 追う足を5分早く始める → 追う足の確かめ。5分遅く始める → followHand。入りを中値にする → followHand。買いを Ask で決済する → followHand。amb を利確に数える → followHand。ドルのペアの pip を 0.01 にする → followHand。
  - 送られない時間の足を送る → 送られる合図の手の例。祝日の窓の終わりを含める → 祝日の手の例。
  - 4時間足の区切りを 21:00 始まりにする → grid の手の例と近さの確かめ。夏の日曜 21:00 の分を残す → session の手の例。
  - 季節を逆にする → spread の手の例。入りのスプレッドを足の最初の分の枠にする → spread の手の例（1時間足の入りの例）。h を s × pip にする（2で割らない）→ spread の手の例（刻みの外の例）。
  - 中値を偶数へ丸める → E の丸めの手の例。円のペアのスケールを10倍にする → スケール（価格の帯）と近さの確かめ。
  - 鏡を作らず、合図と同じ向きにする → 鏡の手の例。鏡の入りを合図と同じ側にする → 鏡の手の例（pips）。
  - 層から向きを外す → δ の手の例。標準誤差から15分足の項を外す → δ の手の例。4週の塊を10に足りなくても使う → δ の手の例。
  - Holm を使わず、1つずつ 2.5% で見る → Holm の手の例と N。前半・後半の境を1週ずらす → 半分の手の例。
  - 作り物の T の上の端を1週あとにする → 期間の確かめ。sha256 を間違える → 何も読まずに止まる。
  - Dukascopy の形の、作り物の期間の中の日のファイルを1つ落とす → dukascopyDays。GMO の形の5分足の、作り物の期間の中の日のファイルを1つ落とす → GMO の穴の確かめ（作り物の GMO の道の追う窓で）。
  - 時間帯ごとの成績を print に出す → 出してよい項目。疑う合図の線を外す → 疑う合図の手の例と O。

**13. 出す数と、数字の後**
- 数字は print.txt にだけ書く。TS の確かめと Python がすべて通った時だけ、artifact に残す。ログには、確かめの名前と合否（数は入れない）、GMO・Dukascopy の読み込みの失敗の行、sha256 だけを出す。外れた時は checks.json だけを残す。確かめの名前・数・かかる時間が、結果（採用候補が出たか、どの足か）で変わらないようにする。
- 段0（数だけ。成績を読まない）: 取得と近さの確かめの結果、足ごとの合図の数（ペア・向き・週）、2 の理由ごとに外した数、T が広い枠に入る割合（4）、床の判定（落とした足の名前と条件）、m、メールになった場合の1週あたりの通数。出したら `research/ledger/tfbest-counts.json` に残し、sha256 を定数にする。段0のモジュールは、成績を計算するコード（追い方）を読み込まない。
- 段1（Dukascopy。すべての足を1回だけ）:
  - 足ごとに: 数・決着・未決着・amb、合図の側の W2/PL2・W1/PL1・W3/PL3 と幅、鏡の側の W2/PL2・W1/PL1、a と幅、メールの通数。
  - X ごとに: Δ_a（a^w_X・a^w_15）・Δ_W2・Δ_W1・Δ_PL1・Δ_PL2 と幅・t・自由度・使った塊、Holm の結果、同時の下限、G1〜G6 の合否、判定、文。前半・後半・ペアごとは、Δ_a の点だけ（G3・G4 のため）。
  - 出さないもの: 時間帯ごとの成績、トレンドで分けた成績、Q-Trend（出してよい項目の一覧に入れない）。
  - 段1の数字を出したら、`research/ledger/tfbest-stage1.json`（判定・文・主な数）に残し、sha256 を定数にする。段1は、この定数があると走らない（もう一度走らせるのは、下の「数字を見た後に直した」時だけで、決まりの変更として定数を外す）。
- 段2（GMO の 2024〜2026年。見たことのあるデータ。決めない）: 段1の定数が無いと走らない。段1とは別の dispatch で走らせる。出す X は、段0で残った m 個。4週の塊は floor((wk(T) − 2817) ÷ 4)（2817 は 2024-01-01 00:00 UTC の週）。期間は 6 の段2の期間。出すのは、足ごとの W・PL・a と幅、X ごとの Δ と幅だけで、Holm・G1〜G6・採用候補・判定の言葉は出さない。「見たことのあるデータで、実際の GMO のスプレッドでの数字です。これで決めません」と添える。
- 疑う合図（G6。プログラムが数える）:
  - 対象: 段1の D-G の全期間の表で、6つの X と15分足の、合図の側と鏡の側（W・PL・a）と、6つの X の Δ_a。前半・後半・ペア・層は入れない。
  - 当たる条件: W2 が80%以上、W1 が90%以上、勝率が0%か100%（決着が100通以上の時だけ）、|a| が10ポイント以上、|Δ_a| が10ポイント以上、PL1 が +1 pip 以上、PL2 が +3 pips 以上。
  - 当たった時は、8 の G6 のとおり、その X（15分足で当たった時はすべての X）が G6 を満たさない（判定は 8 の順で決める）。先読みと測り方の誤りを調べた結果を docs に書き、オーナーに伝える。誤りが見つかれば、下の「数字を見た後に直した」時の手順。見つからなくても、決まりの変更なしには採用候補に戻さない。
  - 調べること（判定は変えない）: 5分足か8時間足が P と G1〜G5 を満たした時も、先読みと測り方の誤りを調べて書く。
- 数字の後に確かめる（報告の前に）: 数が合う、先読みの確かめの数を読み直す。
- 数字を読んだ後にプログラムの誤りを直した時: 前の数字と文は消さずに残し、隣に「数字を見た後に直した」と書く。直せるのは、見つかったプログラムの誤りだけ。文が変わるなら、その段はもう「見ていないデータ」ではなく、これからのメールの確かめだけが決める。
- 取り下げ・やり直しは、決まりの変更として docs に書き、R_tf を置き直す。

**14. 順番と、やること**（1つずつ終えて、確かめてから次へ）
- #250 を先に終える: 段1（6）は、#250 の段2の結果の文を docs に書き、オーナーに伝えた後に始める。§8.106 の 9（これからのメールでの確かめ。最長26週）は待たない。それまでにできるのは、成績を計算しない準備（1〜5）だけ。
1. この節を docs に書き、独立した見直し（Workflow。反証つき）をして直し、マージする。R_tf を記録する。
2. 取り方の下調べ（値段は残さず、数だけ）: Dukascopy の FX が GitHub Actions から読めるか、1ファイルの速さ（300ファイル）、各ペア・側の最初の日、日曜の最初の分の時刻（いくつかの週）。GMO の 30分足・1時間足の日のファイルと、4時間足・8時間足・日足の年のファイル（2023）の最初の足。GMO の休み（日が丸ごと無い日と、早く終わる日。2024・2025年のファイルの足の有無だけ）。結果を docs に書く。
   - **2 の結果**（run 38056868685、2026-10-10、main 3fe241b の `research/tfbest-probe.py`。4つの job とも成功。手作りのファイルの読み方の確かめ〈selftest〉は4つとも ok。ログは全部読んだ。値段は出していない）:
     - Dukascopy は Actions から読めた。ただし遅く、断られることが多い。
       - 1回目（3 workers、30日 × 10系列〈5ペア × bid/ask〉の予定300）: 時間の上限までに試せたのは168、読めた160、6回試してあきらめた8、壊れて読めないもの0。断られた試し（429/5xx）121、ほかの失敗はタイムアウト18・URLError 95。1ファイルにかかった秒数（全部の試しを含む）は中央値 39.5・上から10% 177.0・最大 405.2。この速さで1時間に約141ファイル。
       - 2回目（8 workers、ほかの10日 × 10系列の100）: 読めた91、あきらめた9。断られた試し93、タイムアウト16・URLError 38。秒数は中央値 27.8・上から10% 214.0・最大 385.0。1時間に約371ファイル。
       - 1ファイルは約11.6〜11.9 KB、1分足は中央値1439〜1440本（少ない日は117本・159本）。終値は、全ファイルでペアごとの幅の中だった（160/160、91/91）。
       - あきらめたファイルは、ほぼ 503 の続き（例: EURUSD ask 2015-03-01、EURUSD bid 2017-07-07 など17）。日によらず散らばっている。
     - Dukascopy の最初の日（UTC）: ドル円 bid 2003-06-02・ask 2003-05-04、ユーロ円 bid 2003-08-03・ask 2003-10-14、豪ドル円 2003-12-22（両側）、ユーロドル 2003-05-04（両側）、豪ドル/ドル 2003-08-03（両側）。どれも次の5平日にファイルが5つあった。測る期間（2015-03-01〜）は、全ペアで足りている。
     - Dukascopy の週末の端（ドル円・ユーロドル、13週ずつ）: 日曜の最初の1分足は、NY の冬 22:00、夏 21:00 UTC（夏は 21:02・21:04・21:05 から始まる週もあった）。金曜の最後の1分足は、冬 21:59、夏 20:59 UTC。読めなかったファイルが5つあった（ドル円 2016-03-11 金・2016-07-08 金・2016-07-10 日、ユーロドル 2016-11-13 日・2020-03-06 金）。
     - GMO（5ペア）:
       - 30分足・1時間足の日のファイルは、2023-12 の日で読めた（GMO の日は 21:00〜21:00 UTC で、次の日本の日付で呼ぶ）。30分足は 46〜48本、1時間足は 23〜24本。月曜のファイルは 22:00 UTC から、ほかの日は 21:00 から。
       - 年のファイル（2023、各ペアの bid とドル円の ask）: 4時間足 1219本・8時間足 629本で、どちらも最初の足は 2023-03-29 08:00 UTC。日足 259本、最初は 2023-01-01 21:00 UTC。
       - **2時間足は GMO に無い**（年・日のファイルとも HTTP 404）。2時間足を測るなら、1時間足から作る必要がある（作り方は 4 で決める）。
       - ドル円の1時間足の日のファイル（GMO の日 2024-01-01〜2025-12-31、731日）: 答えが無い日0、足が無い日212（土・日にあたる日と、2024-01-01・2024-12-25・2025-01-01）。ふだんの日は、月曜〈GMO の日〉が23本（22:00〜20:00）、火〜金が24本（21:00〜20:00）で、NY の夏と冬で同じだった。ふだんと違う日は4つ（2024-01-02・2024-12-26・2025-01-02・2025-12-26。どれも休みの次の日で、23本・22:00 から）。
     - 3（取得）への影響（まだ作りは決めていない）: 予定の約2.7万ファイルは、この速さでは1つの job で約73〜190時間かかる。ペア × 側の10の job に分けても、1つあたり約7〜19時間で、GitHub の job の上限（6時間）を超える。年でも分けること、あきらめたファイルを次の run で読み直す作り（`tfbest-missing.csv`）が要る。3 の作りを決める時に書く。
3. 取得: `dukascopy.py` に FX のスケールを足し、ペア × 側ごとの matrix の job で、2015-03-01〜2023-12-31 を取り、キャッシュと artifact（sha256 の控え付き）に残す。キャッシュは7日使わないと消えるので、artifact にも残す。ファイルの数は約2.7万。取れなかった日の一覧（`tfbest-missing.csv`）と sha256 の定数を残し、数を docs に書く。
4. プログラム: `research/tfbest-data.ts`・`tfbest-lib.ts`・`tfbest.ts`（MODE は count・syn・calib・stage1・stage2・fwd）と、`tfbest-check.py`（別のエージェント）、`.github/workflows/tfbest.yml`（push では手の例・作り物1つ・仕込んだ誤り。dispatch では 12 の作り物を先に回して、通った時だけ実データ。段1と段2は別の dispatch）。12 の強さを試しの種で決めて docs に書く。独立した見直し（Workflow）。
5. 段0（数だけ）。結果を docs に書き、オーナーに伝える。
   ――― ここまでは成績を計算しない ―――
6. 段1（Dukascopy）。文を docs に書き、オーナーに伝える。
7. 段2（GMO）。
8. 採用候補が出た時だけ: 9 のこれからの確かめ → オーナーの選択 → メールを替える作業（15）。

**15. メールを替える時**（オーナーが決めた時だけ）
- 今送れる足（5分足・1時間足・4時間足）なら、購読を替える（15分足を残すか外すかはオーナーが選ぶ）。
- 30分足・2時間足・8時間足は、先にメールの仕組みを足す: 購読の足の制約（migration）、`INDICATOR_INTERVALS` と巡回の分、GMO の足の読み方（2時間足・8時間足の確定の見つけ方）、新しさの時間、件名と設定画面の足の名前、`INDICATOR_MEASURED` の数字とチャートの説明（テストあり）。順番は migration → マージ → 関数 → 画面（反映を確かめず、状態をそのまま伝える）→ 購読。
- メールの「測った成績」には、段1の数字（Dukascopy の昔の値段。そう書く）と、あれば、これからの GMO の数字を載せる。選んだ足の GMO の 2024〜2026年の数字は、「何個の足から選んだ期間の数字」と書かない限り載せない。
- 15分足のメールを使っている ①(b)・②・#250 に何が起きるかを、docs に書く。

**16. しないこと**
- 見たことのあるデータ（GMO の 2024〜2026年）で一番を選ぶこと。
- Dukascopy の 2012-01〜2015-02 を取ること・読むこと。T が 2016-01-04 より前、または 2023-10-27 以後の成績を計算すること。
- 15分足の R_tf 以後のメールの成績を、ここで計算すること（9 の後回しの分を除く）。
- (a) を時間帯で分けること（§8.103）。R_trend 以後のメールを流れで分けること（§8.106）。
- Q-Trend・金・5ペア以外・損切りと利確の幅の見直し。
- 結果を見てから、足・水準・期間・条件・作り物の強さを変えること。変えるなら、決まりの変更として書き、R_tf を置き直す。
- 「言えない」を「差が無い」と書くこと。

**17. 決まりの見直しで直したこと**（2026-10-10。成績を1つも計算する前）
- 統計:
  - E の作り物: 平均回帰では4時間足が採用候補になれない（短い足の方が当たる）ので、4時間足の合図の後に押す作りにした。3年の作り物では5ポイントは見分けられないので、目標を10ポイント（試しの種で測ったパイプラインの Δ_a）にし、通る確率を書いた。
  - 当たり a の言い方: 「逆向きで入った場合との差」は 2a なので、文をすべて「コインで向きを決めた場合より」にし、文の数を X の層の割合にそろえた a にした（差が Δ_a になる）。
  - 「一部」は Holm を通った足だけ。Holm を通らない足は、点が＋でも「言えない」。文の理由を G の番号ごとに決めた。
  - G6 の「説明がある」をやめ、疑う合図が当たらないことにした（プログラムが数える）。疑う合図の対象を決めた。
  - 「一番」を t の最大から、同時の下限の最大に替えた。
  - 作り物では床を当てず m ＝ 6。N・S に e の平均の確かめ、裏返しの確かめを足した。作り物ごとの強さの目標を決めた。通る線を少し緩め、全体の外れる確率（E を除いて約5.4%）を書いた。
  - 半分の境（404週、2019-11-17 21:00 UTC）、t が無い足の Holm での扱い、1つの足の幅、これからの確かめの幅の作りと、見分けられる大きさの文を決めた。
- 漏れ:
  - tf-winrate の照らし合わせを、段1の数字の前に、出力を隠して走らせることにした。段0は追い方を読み込まない。
  - 段2の期間（END 2026-10-03）を決め、段2は判定の言葉を出さない。段1は1回だけ・段2は段1の後（sha256 の定数）。出してよい項目の確かめを足した。
  - 外す理由の順番と分母、「止まる」と「落とす」の違い（比べる足は段0で落とす、⑦は落とさない）を決めた。
- データ:
  - 2015年の読み方（窓の前の足だけ）、約262日、2012-01〜2015-02 を残すことを言い直した。
  - D-G の h の式と単位、広い枠（20:30〜24:00 UTC）、近さの確かめのセル・差・分位点・分母、窓の穴、祝日の端、丸めを言い切った。
  - 期間・dukascopyDays・スケールの確かめを足し、日曜の最初の足は説明だけにした（祝日の週の再開を測っていないため）。closeNoFine の扱いを決めた。
  - Python が読むところ（§8.106 段1の作り 1〜3 と §8.102）を書いた。
- 2回目の見直し（2026-10-10。Workflow、6体: 直しが指摘に合っているか・食い違い・数字と作り物、それぞれ反証つき）。指摘30個のうち、正しい19・一部正しい10・誤り1。直したこと:
  - 裏返しの確かめの向きを直した（値動き全体を裏返すと、合図も鏡も同じ形の取引に移るので、e は逆にならず同じになる）。e の期待値が0になる理由も書き直した。
  - 作り物の期間（W ＝ 156、半分の境 78）・始値・1分の動きの大きさ・作り物の価格の帯（始値の 0.4〜2.5倍）を数で書いた。D は5ペアとも上げにし、目標を約4ポイントに下げた（8ポイントでは帯を出るため）。
  - SA の歯の確かめ（買いが正・売りが負）は、向きが式から決まらないのでやめ、説明だけにした。向きの偏りを e の平均で見つける確かめは、向きが式から決まる D に移した。
  - G6 は、その X（と15分足）で当たった時だけ効くことにした。判定は 8 の順で決める。
  - 段0の「数が合う」は、成績を使わない式だけにした。追い方を使う手の例は、段0の数を数えるモジュールとは別のプロセスで走らせる。
  - O の run で外れてよい確かめ（切り取り・毒・indicatorSignals・追う足）を書いた。
  - 作り物の近さの確かめ・GMO の道・期間の仕込んだ誤りを、作り物の期間で書き直した。結果が変わらない仕込んだ誤り（h の掛ける順）を、変わるもの（2で割らない）に替えた。
  - 文: そろえない勝率と Δ_W2 を並べる、1週あたりの通数の数え方、符号をつける数、t が無い足の文、「一番」の足だけ確かめの文を付ける、見分けられない大きさの文を書き直した。
  - 近さの確かめの合図、tf-winrate と照らす数（④で外した後）、段2の4週の塊の起点、`isMarketClosed` の中身、Dukascopy のデータの確かめを段1でも行うこと、を書いた。
  - 前から知っていることに、15分足の5ペアの全体の数（GMO）は §8.106 で見る数になることを書いた（§8.106 段2の作りの見直しから）。
- 3回目の見直し（2026-10-10。Workflow、2体: 2回目の直しが指摘に合っているか、反証つき）。指摘7個のうち、正しい5・一部正しい1・誤り1。直したこと:
  - 裏返しの確かめで、y はぴったり、pips は 1e-9 pips 以内で比べることにした（pips は double の計算で最後の桁がずれ、ぴったりでは正しいプログラムでも外れるため）。
  - 作り物の価格の帯を、始値の 0.25〜2.5倍にした（0.4倍では、豪ドル/円がドリフトの無い run でもまれに帯を割り、どれかの run が止まる確率が約0.8%あったため）。
  - 符号をつける数で、丸めた後が0になる値（−0 を含む）は「+0.0」（pips は「+0.00」）と言い切った（TS と Python で書き方が分かれないように）。
  - 手の例のうち、spread の損切りちょうどの例の結果と入りの値・pips、外す理由の順番の⑦を、追い方を使う側に移した。E の丸め・t の分布・線ちょうどの表は、追い方を使わない側と書いた。
  - 1週あたりの通数で④を除くのは、30分足以上だけにした（5分足・15分足の遅れた合図は、本番でメールになる）。
  - 2回目の見直しの数を直した（正しい19・一部正しい10）。前から知っていることの、run 37191488441 のペアごとの行の中身を正確に書いた。
- 決めかねたところ（オーナーに伝える）: 「#250 を先に終える」は、#250 の段2の文まで待つと読んだ（§8.106 の 9 の最長26週は待たない）。

### 8.108 オーナーのメールを15分足から5分足に替えた（2026-10-10、データベースの購読だけ。コードは変えていない）

- **指示**（2026-10-10）: オーナー「メールを5分足にしましょう。5分足で判断してください。」
- **替える前に確かめたこと**（読み取りだけ）:
  - `signal_alert_subscriptions` の全部は、1人（オーナー）の6件だけだった: ULTRA・15分足・日本語で、ドル円・ユーロ円・豪ドル円・ユーロドル・豪ドル/ドル・金。ほかの人の購読は無い。
  - 5分足のメールは、すでに仕組みにある。GMO の5ペアは `INDICATOR_INTERVALS` に5分足があり、巡回は5分足を確定の0・1・3分後に読み（`gmoIntervalsDue`）、新しさの窓は10分（`freshFor`）。2026-09-28 19:47〜09-29 05:41 UTC（約10時間）に、オーナー1人宛てに、19ペアで ULTRA の5分足のメールを51通送った実績がある（`signal_alerts`。Q-Trend の5分足は173通）。5ペアだけで5分足のメールを送るのは、今回が初めて。
  - 金は、5分足のメールの仕組みが無い（`GOLD_ALERT_INTERVALS` は15分足以上。Twelve Data の無料枠〈1日800回、チャートと共有〉のため。§8.105）。
- **替えたこと**（2026-10-10 13:53:48 UTC＝日本時間 22:53。データベースに直接）: `signal_alert_subscriptions` の、rule が ultra・interval が 15min の5ペア（USD/JPY・EUR/JPY・AUD/JPY・EUR/USD・AUD/USD）の interval を 5min にした（5件）。
  - 金（XAU/USD・15分足 ULTRA）は、そのまま。
  - 元に戻す時は、同じ文の逆: `update public.signal_alert_subscriptions set "interval" = '15min' where rule = 'ultra' and "interval" = '5min' and pair in ('USD/JPY','EUR/JPY','AUD/JPY','EUR/USD','AUD/USD');`
- **変えていないもの**: サインの出し方（ULTRA、損切り13・利確 4/10/16）、ルールの ID、メールの文面、画面、関数（signal-alerts v22）。メールの「測った成績」の行は、5分足の数字が前からある（`INDICATOR_MEASURED`、GMO の FX、2024年1月〜2026年9月、スプレッド込み）: ULTRA の5分足は、損切りより先に利確1（4）に届いたのが 71.9%・1回あたり −1.62 pips、15分足は 72.0%・−1.51 pips。
- **測っていないこと・分かっていること**（嘘をつかない）:
  - 5分足が15分足より当たるかは、測っていない。今ある数字（上）では、勝率は同じ（71.9% と 72.0%）で、1回あたりは5分足の方がわずかに悪い。どちらも1回あたりはマイナス。この比べは #264（§8.107）で、昔の値段（Dukascopy）を使って、先に決めた手順で測る途中。オーナーの指示で先にメールを替えたので、#264 の結果は、メールを替えるかの決めではなく、今の5分足を続けるかの材料になる。
  - 数は、約3倍になる見込み: §8.107 の見積もりで、5ペアの ULTRA の合図は5分足 約200通・15分足 約65〜70通（週あたり。2016〜2023年の昔の値段での数。GMO の今の数としては測っていない。15分足は、後半 2025-05〜2026-10 の GMO で 64.9通/週だった）。
  - 5分足のメールは、確定の約1分後に届く作り（0・1・3分後に読む）。5分の足に対して、約20%の遅れ。
  - 本番で、5分足のメールがちゃんと出ることは、まだ確かめていない。替えた時は土曜で、巡回は `market_closed` だった。最初の判定は、日曜 22:00 UTC（日本時間 月曜 7:00）の相場再開後の、22:05 UTC の確定から。
- **ほかの測定・毎朝の仕組みへの影響**（まだ決めていない。オーナーに伝えた）:
  - 次のものは、オーナーの15分足 ULTRA のメール（5ペア）を数える作りだった: §8.102 (b) の毎週の測定（ledger `ultra15.csv`）、② の (b)（§8.103。そろえた避けたメールが100通、期限 2027-03-13）、#247（1通ずつの結果の記録と毎朝の報告。作る途中）、毎朝の照合の予約（Routine）。この5ペアの15分足のメールは、2026-10-10 13:53:48 UTC で止まった。R（2026-10-08 00:00 UTC）以後に溜まった15分足のメールは、約2日分だけ。
  - 金の15分足のメールは、これまでどおり続く（この測定の対象外）。
  - これらを、5分足のメールに合わせて作り直すか、15分足の購読も残して続けるかは、決めていない（#247・#251 の設計と一緒に決める）。予約（Routine）の一覧は、権限の確認で読めなかった（2026-10-10）ので、中身は確かめていない。

### 8.109 MACD の山・谷でのクロスを合図にしたら当たるかを、先に決めてから測る（#272、研究のみ。メールはまだ変えない）

- **指示**（2026-10-10）: オーナーが5分足のチャート3枚（ユーロドル・豪ドル/ドル・ドル円、10/09 20:00〜10/10 05:55 JST）の「3✓ BUY/SELL」の一部を青丸で囲んで、「出す判断は青丸したタイミングだけでいいです。他のsell、buyの判断はいらないです。ダマシだから。」「macdのオレンジ線を青線がクロスしたタイミングで判断して欲しい。かつ青線とオレンジ線が上か下の一番上、一番下でクロスした時にbuy、sellを判断してメールを送る様にしましょう。」「これが一番見ていてチャートの判断が正確な気がします。」
- **先に分かっていたこと**:
  - 「3✓」は Q-Trend × BLSH の三重一致（#145）の、画面だけの印。メールには使っていない（メールは ULTRA）。
  - ドル円は、データベースの GMO の5分足（bid、10/07〜10/09 の3日分）で、チャートと同じ計算をした。3✓ は7つ出て、6つは画面の印と同じ時刻だった。残りの1つ（10/10 05:45 の SELL）は画面に見えなかった。原因は確かめていない（画面の最後の足は、週末の広いスプレッドの中値で、bid より高く見える）。青丸の3つ（21:50 BUY・00:20 SELL・04:20 BUY）は、どれも同じ向きの MACD のクロス（21:30・00:10・04:10）の10〜20分後で、クロスは山（0より上）か谷（0より下）だった。丸のない印は、クロスから遅れて MACD が真ん中まで来てから出たもの（00:50 SELL）、谷での SELL（03:45）、決まりに合うのに丸のないもの（20:15 SELL、画面の左端）だった。ユーロドル・豪ドル/ドルは、データベースに5分足が無く、画像を目で見ただけ。
  - 青丸は、その後の値動きを見てから選んだもの。この3枚だけでは、決まりの良し悪しは言えない。
- **オーナーの決定**（2026-10-10、質問への答え）:
  - 「一番上・一番下」は、**直近の波の中の高い側・低い側**（0のラインの上・下ではない）。何本分・どのくらいかは、データを見る前に決めてここに書く。
  - 合図は、**MACD のクロスだけ**（3✓ も ULTRA も使わない）。
  - **先に測ってから**切り替える。それまでは、今の ULTRA 5分足のメールを続ける。
- **オーナーの説明（2回目）**（2026-10-10、同じ3枚の MACD の欄に、緑丸と紫丸を付けて）: 「macdの緑丸ぐらい一番上、一番下に近いところでのクロスで判断して。逆に紫丸は0に近いから0に近いクラスでは判断いらない。」
  - 印は11個。緑（判断する）7つ: ドル円 20:00 頃（上）・00:05 頃（上）・04:10 頃（下）、豪ドル/ドル 21:20 頃（上）・22:45 頃（下）・05:25 頃（上）、ユーロドル 04:20 頃（上）。紫（判断しない、0の近く）4つ: ドル円 21:40 頃、豪ドル/ドル 02:25 頃、ユーロドル 00:35 頃・01:55 頃（時刻は画像の丸の中心から読んだもので、10分ほどずれうる）。
  - つまり「一番上・一番下」は、**0から遠く、欄の上の端・下の端に近い所**でのクロス。0の近くのクロスは、山や谷の形でも出さない。
  - これで、最初の案（直近48本の中の位置。下の「確かめ」6に記録）は取り下げた。最初の案では、ドル円 21:30 の紫丸のクロスも BUY になっていた（直近48本の中では下の方〈pos 0.21〉だが、0の近く〈−0.73 pips〉）。取り下げたのは、測る期間のデータを読む前。
- **合図の決まり**（決めた: 2026-10-10。測る期間のデータは読んでいない。このあと選び直さない）:
  1. **足**: GMO の5分足の bid と ask を時刻で合わせる（`mergeSides`。片側だけの足と、ask の終値が bid より下の行は捨てる）。休みの中の足は捨てる（`usableBars`・`barInsideClosure`）。確定した足だけを使う。
     - 中値は (bid ＋ ask) ÷ 2 で、チャートと同じに丸める（`Number(v.toFixed(d))`。d は円のペア 3、ほか 5。`midCandle`・`historyRead`）。
     - Python では `Decimal` の ROUND_HALF_UP で丸める（`round()` は使わない。research/trend-check.py と同じ）。
  2. **窓**: 足 i の判断には、i で終わる確定足600本だけを使う（メールの巡回と同じ）。600本ない時は出さず、「足りない」として数える。
  3. **MACD(12,26,9)**: `_shared/macd.ts`（Pine の EMA、最初は単純平均）を、窓の中値の終値で計算する。
     - m ＝ 青線、g ＝ オレンジ線、h ＝ m − g（丸めない）。
     - Python は TS と同じ順番で計算する（足し算は1つずつのループ。`sum()`・`fsum` は使わない）。
  4. **クロス**（足 i だけを見る）: 向き side(k) は、h[k] > 0 なら +1、h[k] < 0 なら −1、ちょうど 0 なら前の足の向き（見直しの M1）。
     - side(i−1) と side(i) が両方あって違う時がクロス。+1 になったら上抜け、−1 になったら下抜け。
     - 取り下げた最初の書き方（h[i−1] ≦ 0 < h[i]）は使わない。
  5. **x**: 下抜けなら x ＝ m[i]、上抜けなら x ＝ −m[i]（価格の単位）。
  6. **3つの条件**（全部を満たす時だけ出す。等しい時は出す）:
     - **C0（0の正しい側）**: x > 0。SELL は0より上での下抜け、BUY は0より下での上抜けだけ。m[i] ＝ 0 は出さない。
     - **C1（0から遠い）**: 直近288本（24時間）の真の値幅 TR を、k ＝ i−287 から i まで順に1つずつ足して S とする。S > 0 かつ (4 × x) × 288 ≧ S の時に通る（x が、1本あたりの平均の値幅の4分の1以上）。
       - TR[k] ＝ max(高値[k], 終値[k−1]) − min(安値[k], 終値[k−1])。丸めた中値で計算する。
       - 終値[k−1] は番号で1つ前の足。週末やメンテナンスの空きをまたいでも、そのまま使う（空きの分は、その足の TR に入る）。
       - `pineAtr`・`pineRma` は使わない。
     - **C2（波の頂点から戻りすぎていない）**: 今の波の |m| の最大 P に対して、2 × x ≧ P の時に通る（頂点の半分より0に近づく前のクロス）。
       - m の符号（ちょうど 0 は前の符号）が同じまま続いている今の波の、最初の足を r とする。m が null の所で波は切れる。
       - r' ＝ max(r, i−287)（288本より前は数えない）。P は、r' から i まで（i を含む）の |m| の最大。
  7. **決めた数**: 窓600本、C1 は288本と4分の1、C2 は288本までと2分の1。
  8. 1回のクロスが1つの合図。間はあけない。同じ波の中で続けて出たら、それぞれ1通として数える。
  9. 巡回と同じ時だけ数える: 5分足は確定の0・1・3分後に読む（`gmoIntervalsDue`）。そのどれかが `isPossiblyClosed` の外にある足だけ。
- **決まりをどう選んだか**（そのまま書く）:
  - **選び方**: 11個の印を見たあとで選んだ。印は、オーナーが夜全体の画面を見て、あとから付けたもの。メールはその場で前の足だけで決めるので、その形の決まりから選んだ。
  - **設計のワークフロー**（2026-10-10。案を出す3・比べる2・反証1）:
    - 案 (A) 画面の上・下の端に対する割合（直近60本・2分の1）: 11個中10個。ドル円 20:00 の緑を外した（その3時間前に大きな山があるため。この形では、どの本数でも合わない）。
    - 案 (B) 直近86本の |MACD| の60%点に対する割合（0.63）: 11個とも合ったが、余裕が小さく（1.31倍）、数字が丸くない。
    - 案 (C) **この決まり**: 11個とも合った。余裕は C1 が2.24倍、C2 が1.83倍で、数字は丸い。
    - 2人の判定とも、(C) を1位にした。
    - 反証役は、計算をやり直して同じ数字を確かめた。足 i で切っても、i より後を乱数に替えても、66の判断は1つも変わらなかった（先の足を使っていない）。
    - 私も、別に書いた計算で、11個とも同じ判断になることを確かめた。
  - **印の値**（x ÷ 1本あたりの平均の値幅 ／ x ÷ 波の頂点）:
    - 緑: ドル円 20:00 0.367/0.843、00:10 0.471/0.791、04:10 0.512/0.834。豪ドル/ドル 21:25 0.384/0.655、22:50 0.771/0.799、05:30 0.960/0.900。ユーロドル 04:25 0.703/0.796。
    - 紫: ドル円 21:30 0.164/0.629（C1 で出ない）、ユーロドル 01:55 0.589/0.358（C2 で出ない）。豪ドル/ドル 02:30 と ユーロドル 00:40 は0の逆側（C0 で出ない）。
  - **誤りなしになる範囲**（288本で）: k1 ≦ 0.367 かつ 0.358 < k2 ≦ 0.655。ただし、k1 ≦ 0.164 かつ k2 ≦ 0.629 の所は除く。
    - 4分の1と2分の1は、この中の丸い数。
    - C1 の下限はドル円 21:30 の紫1つだけ（0.164）、C2 の下限はユーロドル 01:55 の紫1つだけ（0.358）で決まっている。
    - C0 は、印からではなく、オーナーの言葉（上で SELL、下で BUY）から入れた。C0 を外しても、11個の印は合う。
  - **印の日の様子**（成績ではない。10/09 06:00〜10/10 05:55 JST）:
    - 66回のクロスで27回出た（ドル円 13/24、豪ドル/ドル 8/20、ユーロドル 6/22）。
    - 27回のうち13回は、同じ波の中での2回目以降。緑7つのうち3つも2回目以降なので、「1つの波に1回」にはしない。
    - 画面の中では、28回のクロスで14回出た。緑7つと、丸のない7つ（ドル円 23:20 売り・03:25 買い、豪ドル/ドル 01:10 売り・04:40 売り、ユーロドル 20:20・22:15・23:00 買い）。絵をオーナーに送った。
    - 1日から伸ばすと、5ペアで週に約225通になる（測っていない。今の ULTRA 5分足は、§8.108 の見積もりで約200通）。
    - 反証役の作り物（ランダムウォーク）では、クロスの41〜43%で出た。形で選ぶだけで、それだけで当たるという意味ではない。
  - **注意**:
    - その場のチャート（直近120本の画面）で見ると、出した27回のうち10回（緑のうち3つ）は、欄の真ん中寄りに見える（端までの0.4より下）。オーナーは夜全体の画面で印を付けたため。
    - オーナーの1回目の指示との違い: ドル円 21:30 のクロスは、1回目に青丸で囲んだ 3✓ BUY（21:50）の前のクロスだが、2回目の説明で紫（判断しない）になった。この決まりは2回目に従い、この BUY は出さない。
- **測り方**（今のメール ULTRA 5分足の 71.9% を測った `research/tf-winrate.ts` と同じ作り）:
  - **期間**: 2024-01-01 〜 **2026-10-09 00:00 UTC**（オーナーの画像の日は入れない）。前半・後半の境は 2025-05-19 00:00 UTC（tf-winrate と同じ）。
  - **ペア**: 主はメールの5ペア（ドル円・ユーロ円・豪ドル円・ユーロドル・豪ドル/ドル）。参考に、71.9% と同じ GMO の21ペア。
    - 21ペアは別の run（`mode=real21`）で、同じ作りで走らせる。参考だけなので、(a)(b)(c) と勧めの文は判断しない（数字は出すが、「判断しない」と書く）。
  - **入り方と決済**（メールの目安と同じ）:
    - 損切り13・利確 4/10/16 pips を、合図の足の中値の終値から置く（`ultraLevels`）。
    - 合図の足の終値で入る（BUY は ask、SELL は bid）。その後を GMO の5分足の bid/ask で追い、利確1か損切りの先に届いた方で決済する。
    - 同じ5分足で両方に届いたら損切り（損切りの値段）。足が水準を越えて始まったら、その始値で決済。
    - 5取引日（1440本）たっても決着しなければ、その時の値段で決済する（「未決着」）。1440本がデータの終わりを越える合図は入れず、数を出す。
  - **勝ち**: 利確1が損切りより先。勝率は、決着した取引のうちの勝ちの割合。95%の幅は、週ごとのまとまりで出す（tf-winrate と同じ）。1回あたりの損益（pips、スプレッド込み、未決着はその時の値段）も必ず一緒に出す。
  - **同じ run で、同じ足・同じ決済で並べるもの**:
    - (イ) ULTRA 5分足（今のメール）だけ。Q-Trend とは混ぜない。tf-winrate と同じ作り（`anchoredStart` の区切り、`indicatorSignals` との照合）で出す。
    - (ロ) MACD のすべてのクロス（C0〜C2 なし）。
    - (ハ) 目をつぶった入り方（5分足の終値から、ハッシュで選んだ足に BUY と SELL の両方。偶然の当たり）。
  - **主と (イ) の差**（見直しの M3）: d ＝ 主の1回あたりの平均 − (イ) の1回あたりの平均。95%の幅は、tf-winrate の `diffCi` と同じ週ごとの式を、勝ち（0/1）の代わりに pips で使う。
    - 入れるもの: 5ペア、利確1（全部を利確1か損切りで決済）、終値で入る、送られる合図すべて。
  - **ほかに出す数字**（報告だけ。選ぶのには使わない）:
    - 前半・後半それぞれ。ペアごと（ペアごとの d と、ペアを同じ重さにした d も）。5分遅れて入った場合（次の5分足の終値。すでに水準を越えていたら入らない）。利確2・利確3まで全部持った場合。
    - 週あたりの通数と、週あたりの pips（通数 × 1回あたり）。
    - 未決着・始値での決済・あいまいの数、データの終わりで外した数、未決着を除いた d。
    - 条件ごとに出さなかった数（C0、C1 だけ、C2 だけ、両方）。「足りない」で外した数。
    - 288本の TR の窓に空き（5分より長い間）がある判断の数と、空きの後36本以内に出た合図の勝率・pips（別に出す）。
    - 同じ波で1回目に出た合図と、2回目以降の合図（別に出す）。
    - 出した時の x と、1本あたりの平均の値幅（S ÷ 288）の、pips での分布。
    - 波の切り替わりを「0を 0.2 × 平均の値幅より越えた時」にした場合と、「0から 0.2 × 平均の値幅より近づいたら切る」にした場合に、変わる判断の数。
  - **損益ゼロに必要な勝率**: 利確4・損切り13では、13 ÷ 17 ＝ 76.5% より上（スプレッドの分さらに上）。勝率がこれより低いと、1回あたりはマイナスになる。
- **オーナーへの勧め方**（ここで決める。決めるのはオーナー）:
  - 「MACD の山・谷に替えるのがよい」と言うのは、次の3つを全部満たす時だけ:
    - (a) 全期間で、d の95%の幅が0より上。
    - (b) 前半と後半の両方で、d が0より上。
    - (c) 5分遅れて入った場合も、主の1回あたりが (イ) 以上（見直しの M6。メールは確定の約1分後に届くので、0分と5分ではさむ）。
  - それ以外は「ULTRA より良いとは言えない」と伝える。どちらでも、数字（勝率と1回あたりの損益）は全部見せる。
  - 主の1回あたりの損益とその95%の幅は、必ず書く（見直しの M7）。主の1回あたりについては、次のどれかを書く:
    - 平均が0以下: 「1回あたりはマイナス」。
    - 平均は0より上だが、95%の幅が0をまたぐ: 「1回あたりがプラスとは言えない（95%の幅が0をまたぐ）」。
    - 95%の幅が0より上: 「1回あたりはプラス」。
    - 3つの条件を満たしても、上の2つのどちらかなら、「ただし ULTRA より負けが小さいだけで、」を前に付ける。
    - （2026-10-10 に直した。最初は、幅が0をまたぐ時も「1回あたりはまだマイナス」と書く決まりだったが、平均がプラスの時に嘘になるため。どちらも、測る期間のデータを読む前。）
  - (ロ) や別の数の組から、あとで一番良いものを選ぶのは「選んだ」ことになる。選ぶなら、新しく確かめ直す（見直しの N7）。
  - (イ) の数字は 71.9% にならない（ペアと終わりの時刻が違うため）。そう伝える。
  - 勝率100%に見える数字が出たら、先に測り方の誤り（先読みなど）を疑って調べる。
- **確かめ**（数字を読む前に、全部通す）:
  1. **先読みの確かめ**: ペアごとに、判断したすべてのクロス（出たものも出なかったものも）と、等間隔の約300本の足で、その足で終わる600本の窓で計算し直し、全期間の計算と、クロスと判断が全部同じか。1つでも違えば、成績を読む前に止める。
     - （2026-10-10 に、見直しの指摘で「合図の7つに1つ」から「すべてのクロス」に広げた。測る期間のデータを読む前。）
  2. **作り物の値動き**（tf-winrate の synthetic5。種を2〜3つ）: 主の勝率と1回あたりが、同じ作り物での (ハ) の95%の幅の中に入るか。主 − (イ) の幅が0をまたぐか（見直しの M5。「スプレッド分のマイナス」は目安にしない）。外れたら調べる。数字を合わせに行かない。
  3. **別に書く計算し直し**（Python、`research/macdx-check.py`。docs と共有のコードだけから書き、macdx.ts は読まずに書いた）: 主の合図（時刻・向き）と、1回ずつの結果（決着の種類・pips）が、TS と全部同じか。
     - Python は、すべての足で、その足で終わる600本の窓から MACD を計算する（決まりのとおり）。
     - 照らし合わせ: 向き・送ったか・C0・C1・C2・出たかは完全に一致。x と S は相対 1e-9、P は相対 1e-6 まで（TS は P を全期間で一度に計算した MACD から取るため、窓の始まりの EMA の種の差が、長い波の始まり近くに残る。判断の C2 は完全に一致を求める）。pips は 1e-6。
     - 結果の出し方（Actions）: 確かめが全部通るまで、成績はファイルにだけ書く。途中で落ちたら、bars.csv と decisions.csv だけを上げ、成績の入ったファイル（trades.csv・report.json・print.txt）は上げない。
  4. **手で作った例**: h[i−1] ＝ 0、h[i] ＝ 0、m[i] ＝ 0、波の中の m ＝ 0、(4x)×288 ＝ S、2x ＝ P、S ＝ 0、空きをまたぐ TR、288本より長い波、i で始まる波、600本ない場合。
  5. **(イ) の再現**（見直しの M4）: 新しいプログラムで、21ペア・START 2024-01-01・END 2026-09-30T14:40:11Z・損切り13・利確 4/10/16・WEEKEND inside で走らせ、run 37191488441 の ULTRA 5分足の行（71.9%・−1.62 pips・同じ数）と合うか。この run では、MACD の数字は出さない。
  6. **決まりの確かめ**（成績ではない。済み）: 11個の印に全部合う（上の「印の値」）。
     - 取り下げた最初の案（N ＝ 48・3分の1）での結果（2026-10-10、ドル円の bid/ask から中値で計算）: 画像の時間のクロス8つのうち、合図は5つ（21:30 BUY・23:20 SELL・00:10 SELL・03:25 BUY・04:10 BUY）。参考の120本（画面の幅）では、23:20 と 00:10 の下抜けが真ん中（0.51・0.52）になり、SELL が出なかった。
- **確かめの結果**（2026-10-10。実データの成績は、まだ読んでいない）:
  - 確かめ 4（手の例）: 26個すべて合った（Actions の hand job と手元）。
  - 確かめ 1（先読み）と 3（Python）: 作り物の値動き13通り（種 1〜13、5ペア、2024-01-01〜2026-10-09、run 38067175213 と 38067610668）で、どれも先読みの違い0（1通りあたり約8.9万か所）、Python と TS の判断（約8.8万のクロス）と取引（約3.5万）が全部一致。P の全期間と窓の差は、いちばん大きくて相対 2.8e-12。
  - 確かめ 5（ULTRA の再現）: run 38067180321 で REPRODUCED（71.9% [71.2, 72.6]・−1.62 pips [−1.76, −1.49]・数もすべて同じ）。
  - 確かめ 2（作り物で、主が目をつぶった入り方 (ハ) と同じに見えるか）:
    - 13通りのうち11通りで、主の勝率と1回あたりが (ハ) の95%の幅に入った。種3は少し下（主 76.0%・−0.28 pips、(ハ) の幅 [76.1, 77.0]・[−0.26, −0.11]）、種4は少し上（主 76.9%・−0.14 pips、(ハ) の幅 [75.7, 76.7]・[−0.33, −0.16]）に外れた。
    - 調べたこと: 作り物は1本ずつ独立に動く値動きなので、入る時刻を選んでも成績は変わらないはず。主 −（ハ）の1回あたりは、13通りの平均で +0.005 pips（種ごとのばらつき 0.046）、勝率は +0.02 ポイントで、どちら向きにも偏っていない。外れは上と下に1つずつ。この確かめは「主の値が (ハ) の幅に入るか」を見るので、差が無くても主自身のばらつきで外れることがある。誤りの跡は見つからなかった（Python との全件一致も通っている）。
    - 種4と種8で (ハ) の行がまったく同じに見えたので調べた: 取引を1つずつ比べると、20248回のうち7352回で結果が違い、ペアごとの利確の数も違う。5ペアを足した利確の数（15427）が、たまたま同じだった（作り物には窓開けが無く、損益はほぼ利確か損切りの幅で決まるため、利確の数が同じなら1回あたりも同じになる）。
    - 主 − (イ) の d の95%の幅は、13通りすべてで0をまたいだ。勧めの文は13通りとも「ULTRA より良いとは言えない」。
    - 作り物の上でも、主の勝率は 76.0〜77.0%、1回あたりは −0.11〜−0.28 pips（損益ゼロに要る 76.5% とスプレッドの分）。
- **実データの結果**（2026-10-10、run 38068838023、5ペア・2024-01-01〜2026-10-09 00:00 UTC、1回だけ）:
  - 先に読んだ確かめの行: GMO の読み込みの失敗0、ULTRA と `indicatorSignals` の違い 0/5463、先読みの違い 0/83742、Python と TS の足・判断（82388）・取引（31624）が全件一致（PYTHON CHECK OK）。勝率90%以上の行は無かった。数字はこの後に読んだ。
  - 全期間・終値で入る・利確1（利確4 か 損切り13 のどちらか先）:

    | | 回数 | 勝率（利確1が先）[95%の幅] | 1回あたりの損益 [95%の幅] |
    |---|---|---|---|
    | 主（MACD の山・谷） | 31624 | 72.3% [71.6, 72.9] | −1.28 pips [−1.40, −1.16] |
    | (イ) ULTRA 5分足（今のメール） | 27175 | 72.9% [72.1, 73.7] | −1.18 pips [−1.34, −1.03] |
    | (ロ) すべてのクロス | 81782 | 71.2% [70.8, 71.6] | −1.63 pips [−1.73, −1.54] |
    | (ハ) 目をつぶった入り方 | 20078 | 71.9% [71.3, 72.4] | −1.51 pips [−1.64, −1.39] |

    - 主の内訳: 利確 22860・損切り 8584・同じ足で両方 180・未決着 0（窓開けの始値で決済 100）。持った長さは平均13本（約65分）。
    - 前半（〜2025-05-18）: 主 71.4%・−1.44 pips、ULTRA 72.4%・−1.31 pips。後半: 主 73.2%・−1.12 pips、ULTRA 73.4%・−1.05 pips。
  - 主と (イ) の差: d ＝ −0.10 pips [−0.24, 0.04]（前半 −0.13・後半 −0.07）。勝率の差 −0.6 ポイント [−1.4, 0.2]。
    - 5分遅れて入った場合: 主 69.3%・−1.21 pips（すでに水準を越えていて入らなかった 3063）、ULTRA 69.4%・−1.12 pips（同 3192）。
    - (a) 満たさない・(b) 満たさない・(c) 満たさない。
  - **勧めの文**（先に決めた作りのまま）: 「ULTRA より良いとは言えない（(a) 満たさない・(b) 満たさない・(c) 満たさない）。主の1回あたり −1.28 pips [−1.40, −1.16]、1回あたりはマイナス。」
  - 報告だけ（選ぶのには使わない）:
    - 週あたり（5ペアの合計）: 主 220.3 通・−279.9 pips、ULTRA 189.2 通・−222.0 pips。データの終わりで外したのは主 218・ULTRA 185。
    - ペアごと（主 / ULTRA、1回あたり）: ドル円 −1.60 / −1.52、ユーロ円 −1.75 / −1.73、豪ドル円 −1.66 / −1.41、ユーロドル −0.87 / −0.76、豪ドル/ドル −0.52 / −0.47。d はどのペアでも95%の幅が0をまたぐ。ペアを同じ重さにした d は −0.10。
    - 利確2まで全部持つ: 主 52.8%・−1.45 pips、ULTRA 53.7%・−1.23 pips。利確3まで: 主 41.9%・−1.46 pips、ULTRA 42.4%・−1.32 pips。
    - 空きの後36本以内の合図（836回）: 65.8%・−3.96 pips（スプレッドの中央 1.70 pips）。同じ波の1回目（18755回）: 71.5%・−1.46 pips、2回目以降（12869回）: 73.5%・−1.02 pips。
    - クロス 82388（送られない時刻 61）、出したもの 31842。出さなかった理由: C0 30526、C1 だけ 5312、C2 だけ 4940、両方 9707。288本の TR の窓に空きがある判断 16685（出したもの 6638）。波の切り方を変えると変わる判断: 「0を越えた時」1453、「0に近づいたら切る」1785。
    - 出した時の x の中央 3.03 pips（10%点 1.19・90%点 8.57）、1本あたりの平均の値幅の中央 4.23 pips。
    - 主も ULTRA も、(ハ) より1回あたりの負けは小さいが、どれもマイナス。この差は勧め方の条件に入れていない。
  - 損益ゼロに要る勝率 76.5%（スプレッドの分さらに上）に、主・ULTRA・(ロ)・(ハ) のどれも届かない。
- **21ペアの参考**（run 38070630317。参考だけで、(a)(b)(c) と勧めの文は判断しない）:
  - 1回目（run 38069493804）は、GMO の読み込みが112回失敗（応答が JSON でない）し、決まりどおり成績を出す前に止まった。読めたファイルは取っておき、2回目で残りを読んだ。
  - 先に読んだ確かめの行: GMO の読み込みの失敗0、ULTRA と `indicatorSignals` の違い 0/16283、先読みの違い 0/255843、Python と TS の足（21ペア）・判断（250157）・取引（94819）が全件一致。
  - 7ペア（ユーロ/ポンド・豪ドル/NZドル・ハンガリーフォリント円・スウェーデンクローナ円・ノルウェークローネ/スウェーデンクローナ・豪ドル/カナダドル・NZドル/カナダドル）は、GMO の5分足が 2026-05-17 からしか無い。
  - 全期間: 主 94819回・71.7% [71.1, 72.2]・−1.67 pips [−1.78, −1.56]（未決着 5116）、ULTRA 80487回・71.9% [71.2, 72.6]・−1.62 pips [−1.75, −1.49]、(ロ) 70.5%・−2.03 pips、(ハ) 71.2%・−1.86 pips。
    - ULTRA は 71.9%・−1.62 pips で、§8.98 の値と同じ（終わりの時刻が違うので回数は違う）。
  - d ＝ −0.05 pips [−0.15, 0.06]（前半 +0.02・後半 −0.11）。勝率の差 −0.3 ポイント [−0.8, 0.3]。(a)(b)(c) はどれも「いいえ」だった（判断はしない）。
  - 週あたり（21ペア）: 主 662.4 通・−1093.6 pips、ULTRA 562.2 通・−902.7 pips。
  - ペアごとの d で95%の幅が0をまたがないのは2つ: トルコリラ円 +0.32 [0.12, 0.52]（主 75.5%・−1.97 pips、ULTRA 72.7%・−2.29 pips）と NZドル/カナダドル −1.02 [−1.88, −0.15]。21ペアから後で良いペアを選ぶのは「選んだ」ことになるので、選ぶなら新しく確かめ直す（見直しの N7）。トルコリラ円も1回あたりはマイナス。
  - ハンガリーフォリント円は、5取引日で決着した取引が無く、勝率が出ない（1回あたりは主 −0.67・ULTRA −0.71 pips、どちらも期限での決済）。利確・損切りの幅（0.04円・0.13円）が、この通貨の1日の値動きに比べて広いためと思われる（値動きの大きさは確かめていない）。
  - この決まりの、5ペア・GMO の値段・利確4/損切り13 での勝率と1回あたりは上で測った。それ以外の決済（利確だけで待つなど）は測っていない。
  - オーナーの持ち方（損切りなし・利確10）での成績は、この測定には入れない。損切りなしで測る時は、§8.102 の作り（含み損の大きさ・持った期間・ロスカットと期限の数・入金）で別に測る。
  - 楽天FX の値段ではなく、GMO の値段で測る。
- **順番**:
  1. この決まりを docs に書いてマージし、時刻を記録する。（済み: PR #197、マージ 2026-10-10T15:28:19Z。これを R_macd とする。）
  2. プログラム（`research/macdx.ts`）・Python の計算し直し・Actions の作りを書き、確かめ1〜5を通し、独立した見直しにかける。
  3. 実データで1回走らせ、数字をここに書いて、オーナーに伝える。（済み: run 38068838023。上の「実データの結果」。21ペアの参考は run 38069493804。）
  4. メールを替えるかは、その後にオーナーが決める。

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

**J. 新しい足（#181、§8.92）** — 本番で読めているか

```sql
-- GMO の新しい足のファイル（誰かが開いたあと）。週足の年のファイルは、最後の週が終わった年だけ
select interval, count(*) as files, min(date_key), max(date_key), max(fetched_at)
from public.gmo_kline_files
where interval in ('10min', '30min', '8hour', '1week', '1month')
group by interval order by interval;
```

1. 週足（`1week`）に、今年（最後の週がまだ終わっていない年）の行が無いこと（`gmoFileClosed`）。
2. Twelve Data の7銘柄の週足・月足の保存行（`live_chart_fallback` の `1week`・`1month`）で、週足の日付が何曜日に付くかを見る（まだ見ていない）。
3. 2026-11-01（ニューヨークの冬時間）のあと、Twelve Data の4時間足の始まりの時刻が動いたかを、保存行（`4h`）で見る。動いていたら、8時間足は読んだ足に合わせて区切られる（`twelveBuiltOffset`）が、§8.92 の記録を直す。

**K. 日曜 20:00 UTC の4時間足（#182、§8.93）** — 反映のあとの最初の週の始まり（2026-10-04 22:00 UTC〜10-05 04:00 UTC）

```sql
-- 月曜 00:00 UTC の巡回: 4時間足を日曜 20:00 UTC の足で判定したか（skipped が unknown なら前のまま）
select id, created, status_code, content::jsonb->>'version' as version,
       (select count(*) from jsonb_array_elements(content::jsonb->'reads') r
         where r->>'interval' = '4h' and r->>'newest' = '2026-10-04T20:00:00.000Z') as judged_sun20,
       (select string_agg(distinct r->>'skipped', ',') from jsonb_array_elements(content::jsonb->'reads') r
         where r->>'interval' = '4h') as skipped_4h
from net._http_response
where (content like '%signal-alerts-v19%' or content like '%signal-alerts-v20%')  -- #192 の v20 が先に出ていれば v20
  and created between '2026-10-05 00:00:00+00' and '2026-10-05 00:10:00+00'
order by id;
```

1. 00:00 台の最初の巡回で、4時間足の購読（2026-10-03 は Q-Trend・ULTRA 各21銘柄）のうち GMO の14ペアが、`newest` 2026-10-04T20:00:00.000Z で判定されていること（`judged_sun20` が 14。読み込みの時間切れで次の巡回に回ったものは、次の巡回で判定される）。前のやり方なら、この時刻の4時間足は `unknown` で飛ばしていた。Twelve Data の7銘柄（金を含む）の4時間足は 01・05・09… UTC の格子で、変わらない。
2. その足で合図が出ていれば、`public.signal_alerts` に 4h・`closed_at` 2026-10-05 00:00 UTC の行があること（出ていなければ行は無いのが正しい）。
3. チャートの4時間足を日曜の夜（日本時間の月曜 07:00〜09:00）に開き（反映の前から開いていたタブは、開き直してから）、形成中の足が日本時間 月曜 05:00 の足で、次の確定が 09:00 であること。月曜 09:00 のあとは、その足が確定足として並ぶこと。
5. RSI+SAR・GA型の巡回（00:02・00:17 UTC）で、6ペアの4時間足が日曜 20:00 UTC の足で判定されていること。合図が出ていれば `signal_events` に 4h・`bar_time` 2026-10-04 20:00 UTC の行がある。
4. 04:00 UTC の判定（いつもどおり）が続くこと。

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
- [ ] 通貨ペアを増やす・減らすときは、次を同時に変える（§8.86）。研究は `research/lib.ts` の `GMO_STUDY_PAIRS` を使うので、変えない。
  - サーバーの `LIVE_PAIRS`・`TWELVE_FX_PAIRS`（`live-chart/logic.ts`）。
  - 画面の `LIVE_FX_PAIRS`・`TWELVE_FX_PAIRS`（`src/lib/liveChart.ts`）。
  - RSI＋SAR・GA型の `ALERT_PAIRS`（`signal-alerts/logic.ts`）。
  - 日本語のメールのペア名 `PAIR_JA`（`_shared/pair-names.ts`）。アプリの一覧（`ja.ts` の `live.pairShort`）と同じにする（`src/test/pair-names.test.ts` が確かめる。§8.104）。
  - 購読の制約 `signal_alert_subscriptions_pair_check`（新しいマイグレーションで）。
  - 文言: ja/en の一覧の注記・メール通知の注記・トップページ・料金・よくある質問・成績の見出し、`index.html`・`404.html`。
  - 減らすときは、関数 → 画面 → マイグレーションの順に出す。古い画面で外したペアを選ぶとエラーが出たままになるので、関数の反映を確かめたらすぐに画面を公開する。
  - 増やすときは、マイグレーション（制約を広げる）→ 関数 → 画面の順に出す。新しい関数は増えたペアをメール通知の設定に出すので、制約が先に広がっていないと、そのペアを含む購読の保存（時間足ごとの「すべての銘柄」のオンを含む）が失敗する（§8.88。#177 ではじめ、減らすときの順番を書いていた）。
- [ ] GMO の日のファイルを読む処理を足すなら、日の切り替わり前（0:00 JST から GMO の 06:00、冬は 07:00 の可能性）の今日のファイルの 404 を、足のないファイルとして扱う。テストの時刻を 15:00〜21:00 UTC にも置く（§8.87。一度これで毎日数時間、読み込みが失敗する作りにしていた）。
- [ ] チャートの足の種類を変えるときは、次を同時に変える（§8.92）。
  - サーバーの `LIVE_INTERVALS`・`LIVE_STEP_MS`（`live-chart/logic.ts`）と、画面の `LIVE_INTERVALS`・`INTERVAL_STEP_MS`（`src/lib/liveChart.ts`）。テスト（`src/test/timeframes.test.ts`）が両方の一致を見る。
  - GMO にない足は `CHART_GMO`（どの GMO の足から作るか）、Twelve Data にない足は `TWELVE_BUILT`。Twelve Data に送る名前は `TWELVE_SERVED` だけにする（知らない名前を送ると、1日の回数を使って足が来ない）。
  - 長さが決まらない足（月足）は `barEndMs` で終わりを決める（関数と画面の両方）。
  - 文言: ja/en の `control.intervals`・`live.intervalShort`、説明文の「測っていない」足、料金・トップページの範囲。
  - メール通知の足は別の一覧（`INDICATOR_INTERVALS`・`ALERT_INTERVALS`・購読の制約）なので、チャートだけなら変えない。live-chart/logic.ts を変えると signal-alerts も出し直しになるので、両方の版を上げる。
  - テストで「チャートにない足」の例に使っている名前（`6h`・`12h` など）が、新しい足とぶつからないか確かめる。
- [ ] `GOLD_BARS` を変えるなら、チャートのふだんの読み込みが使う本数（`TWELVE_CHART_BARS`）が変わらないことを確かめる。メールの関数（signal-alerts）も同じ定数を読むので、両方の版を上げる（§8.87）。
- [ ] `rulebook` を手で直すなら `version` / `updated_at` / `history` に触らず、cron を止め、新しい関数を先にデプロイしてから流す（§4.3）。
- [ ] 秘密の文字列・使い捨てテストがコミットに入っていないか `git diff --cached` で見る。
- [ ] `position_review` の形（`analyze/review.ts` の `PositionReview`）を変えるなら、フロントの鏡（`src/lib/types.ts`）・カード（`HeldPositionCard` / `ChangeSinceLastCard` / `ReviewFacts`）・i18n を同時に足す。verdict は `held` だけ、`change` は `previous` だけ、根拠の評価は `kind` に入れない（§2.3）。
- [ ] プロンプトの**送り方**（`model` / `effort` / `max_tokens` / tools / user メッセージの組み立て）を変えたら、`analyze/reuse.ts` の `REUSE_VERSION` を上げるか確かめる。答えの出方が変わったのに鍵が同じなら、古い版の答えが新しい版の入力に対して配られる（§2.4）。時刻の文言をロケールに足したときは `CLOCK_LINE` と `src/test/reuse.test.ts` の全ロケール検査を通す。
- [ ] **プロンプトの外から答えに入るもの**（web 検索のように、モデル呼び出しの時点で取りに行くもの）を足したら、その回を再利用の対象から外す。鍵はプロンプトしか見ていないので、外にあるものは「同じ入力」の判定に入らない（§2.4）。
- [ ] 断る理由を足したら `REUSE_OUTCOMES` と `analysis_reuses.outcome` の CHECK 制約を**両方**動かす（テストが突き合わせる）。
- [ ] エッジ関数を増やすなら `config.toml`・`package.json`（`bundle:*` と `check:functions`）・`.gitignore`（bundle.js）・deno.json を同時に足す。出す順番は「呼ばれる側 → 呼ぶ側 → フロント」。
- [ ] analyze のバンドルは **110KB 未満**に保つ（§6.1.1 の実測。116KB は通らなかった）。`review.ts` から import を増やすとプロンプト本文が丸ごと戻ってくるので、`npm run bundle:analyze && wc -c` で必ず測る。
- [ ] 部分索引を足すなら、述語を**照会と同じ綴り**で書く。`shadow = false` の索引は `shadow=is.false`（PostgREST の既定）の照会を拾わない。`explain` で実際に選ばれることを確かめる（§2.4）。
