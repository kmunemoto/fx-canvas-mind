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
  現行で起こる拒否は `incoherent` / `stop_too_tight` / `poor_rr` / `target_out_of_reach` で、これらは shadow を作らない。

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
- 休場の拒否は **広い述語** `isPossiblyClosed` で 2 回: `check_market_hours`（クォータ消費の前、409）と `check_entry`（モデル応答後。20–40 秒の間に閉まることがある）。
  後者は `entry_check.rejection = "market_closed"` として残し、シグナルを WAIT に落として返金する。狭い述語では週に 1 時間の穴が空き、週末のギャップ越しの約定が「誰も取れない大勝ち」として記録される。

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
- その後の窓は `AFTER_BARS`（15min 24 / 1h 24 / 4h 12 / 1day 5）本 × プランの足（`afterWindowMs`）。窓の中の足は判定足 `EVAL_INTERVAL` で数え、
  `bars_after_settlement` が `MIN_AFTER_BARS = 8` 本に満たない診断は `thin` として、窓が丸ごと揃ってから `MAX_REVISIONS = 1` 回だけ再診断する
  （`thin = true` かつ `revisions < 1`。再診断の失敗は `revisit_attempts` に積み `MAX_ATTEMPTS` で止め、元の診断はそのまま残す）。`thin` を記録していない旧版の診断も同じ経路で見直す。
- `postmortem.status = done` の行はそれ以外では再診断しない。`ids` で名指しした行だけは状態を問わず再診断し、`revisions` は消費しない。`force` は候補を増やさない（done の行は thin の再診断経路以外では拾わない）が、飛ばす待ちには thin 再診断の「窓が丸ごと揃うまで」も含まれる。
  窓が揃う前に `force: true` で走らせると薄い窓のまま `revisions` が 1 消費され、以後その行は見直されない。thin の行が残っている間は `force` ではなく `ids` で名指しする。
- 1 回に診断するのは `MAX_PLANS_PER_RUN = 3`。増やせるのは body の `limit`（1..`MAX_PLANS_ADMIN = 6` に丸める）だけで、`ids`（先頭 6 件まで）は候補を絞るだけ。
  `ids` を 6 件渡しても `limit` を省略すれば先頭 3 件で止まる（`due = rows.slice(0, options.limit)`）。手動実行は sweep トークンでも管理者 JWT でも同じ。
  失敗は `MAX_ATTEMPTS = 3` 回まで `postmortem.attempts` に積む。
- 管理者 JWT（`ADMIN_EMAILS`。同じ配列が 4 か所にある）の POST body: `force`、`ids`、`limit`、`consolidate`（`revisionDue` を待たずに**候補を書く**）、`promote`（決着件数の門を待たずに**候補を版に上げる**）。
  2 つは別の操作で、`consolidate` は候補を作るだけ、`promote` は既にある候補を昇格させるだけ。同じ run で両方渡すと候補を作った直後にそれを昇格させる。
- 壁時計の予算は `WALL_CLOCK_BUDGET_MS = 130 秒`（同名の定数が analyze にもあり、そちらは 135 秒。関数ごとに別物）。診断は開始から `START_DIAGNOSIS_BEFORE_MS = 75 秒` を過ぎたら新たに始めない（以降の行は `deferred (time budget)` として次の run に回す）。
  診断の LLM 呼び出しは `LLM_TIMEOUT_MS = 45 秒`（再試行 1 回を含めた合計の期限）。ルールブック改訂の呼び出しは別予算（§4.3）。
- **教訓を先に書き、それから done を打つ**。順序が逆だと、教訓の書き込みだけ失敗した行が「診断済み」として待ち行列から消え、二度と拾われない（学習に回らないまま消える）。
  教訓が書けなかった行も done は打ち（打たないと同じ行を毎回診断し直して他の行が進まない）、`errors` に `lesson not written, left for the repair pass` を残す。
- **修復パス**: 毎 run、`postmortem.status = done` の直近 `REPAIR_SCAN = 200` 行を id だけで引き、`lessons` に対応する行が無いものを最大 `REPAIR_PER_RUN = 20` 件まで書き直す。
  `lessons` 側の読み取りに失敗したときは「教訓が 1 つも無い」と見なさない（見なすと 200 行を全部書き直しにいく）。修復を飛ばして `errors` に `repair: lessons unavailable, skipped` を残す。
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
- 候補が版に上がる条件 `measured`: 現行版で決着した非 shadow のプランが `MIN_DECIDED_PER_VERSION = 10` 件（`outcome in (win, loss, expired)`、`rulebook_version = 現行版`）。
  版 0（まだルールが無い）は最初の候補で無条件に上がる。上がらない限り学習は止まらない（候補は毎回上書きされ、最新の教訓を反映し続ける）。
  **これは「10 件たまるまで改訂しない」ではない**: 文字どおり門にすると、決着が月に数件の今のペースでは数か月ルールが 1 行も増えない。書き続け、切り替えだけを律速する。
- 昇格は独立した書き込みで、その run が新しい候補を書いたかどうかに依存しない（依存させると「候補は書けたが版は上がらない」状態から抜けられない）。
  昇格した run は `promoted_from_candidate: true` を記録し、`candidate` を null に戻す。`last_result.promoted` に上がった版が入る。
- 進捗の見せ方: `loop_health` の `candidate_waiting` / `candidate_created_at` / `decided_under_version` を `LoopHealth` が読み、候補が待っている間は「教訓あと n 件」ではなく「決着 x/10 件で適用」と出す（教訓の数はもう関係しないため）。
- 改訂は 1 回の run につき最大 1 回（統合の分岐が 1 つあるだけで、回数を決める定数はない。`MAX_REVISIONS` は thin の再診断回数、§4.1）。
- 既存の id のまま本文や cause が書き換わったルールは `changes.reworded` に出る。追加でも削除でもないので `since` は据え置きだが、
  記録が無いと「版だけ上がって差分が空」なのに分析者が従う文章は入れ替わっている、という読めない改訂になる。
- 書に入らなかったルールの理由は `changes.reasons`（id → 理由）に残る。`dropped` は `add_cap`（1 回の追加上限）/ `no_evidence`（引用が 1 つも数えられない）/ `book_full`（`MAX_RULES` が埋まっている）、
  `removed` は `omitted`（編集者が外し、削除枠に収まった）/ `evidence_gone`（数え直しても support 0）/ `no_room`（復元したかったが席が無い）。
  一覧だけでは「2 回続けて落ちた」までしか分からず、原因が引けなかった（v7・v8 で `r12` が連続で落ちた）。
- 改訂のモデル呼び出しは診断の 45 秒とは別予算: 壁時計の残り − `WRITE_RESERVE_MS = 10 秒` を `MAX_CONSOLIDATION_MS = 110 秒` まで。
  それが `MIN_CONSOLIDATION_MS = 45 秒` 未満なら改訂せず `rulebook.reason = deferred_time_budget` を返す。起きるのは run の経過が 75 秒を超えたときだけで、実測は診断 1 件で約 24 秒・残予算 96 秒（`net._http_response` id 556）。
  この単価なら 3 件でも 45 秒は割らないので、`deferred_time_budget` が常態化していたら診断が想定より遅いということ。
- `last_result.rulebook.reason` の読み方: `no_lessons` / `evidence_unavailable` / `waiting`（`lessons_since_version`、`lessons_needed` 付き）/ `deferred_time_budget` / `revised: true`（`changes` 付き）。
  `rulebook` そのものが **null** の run は reason を持たない。ルールブックが読めなかった・モデルが答えなかった・条件付き UPDATE が 0 行だったのいずれかで、手がかりは `errors`（`rulebook: unavailable, not revised` など）だけ。
  `lesson_contributors` / `record_contributors` は何アカウントから学んでいるか。
- ルールは最大 `MAX_RULES = 10`。1 回の追加は `MAX_RULES_ADDED = 2` まで（前版が空の初回だけは `MAX_RULES` まで一度に書ける）。
  削除は省かれたルールのうち support の低い順に `MAX_RULES_REMOVED = 2` 本までで、残りは証拠を数え直して復元する（`changes.restored`）。数え直しで support が 0 になったものは上限に関係なく `changes.removed` に入る。
- support はモデルに申告させない。ルールが `supported_by` に挙げた lesson のうち `citationAllowed` を通るもの（実在し、shadow でなく、ルールの cause と合う。`general` なら任意の citable cause、`constraint` なら `CONSTRAINT_CAUSES` も可）の
  独立クラスタ数をサーバ側で数える。`inconclusive` / `plan_incoherent` / `good_call` は何の証拠にもならない。0 になったルールは出力から落ちて `changes.dropped` に入る。前版に無かった新規ルールはそこで消えるが、前版にもあったルールは省かれたルールと同じ削除の精算に回り、`MAX_RULES_REMOVED` の枠から外れれば保存済みの `supported_by` で数え直され、support が戻れば `changes.restored` として書に残る（`dropped` と `restored` の両方に出る）。引用先の lesson id が実在しなければ数えない。ルール id の乗っ取り防止が働くのはモデルが id を空で返したときだけで、サーバが振る `r<番号>` が既存 id と衝突する間 `_` を足す。
  モデルが既存ルールの id をそのまま名乗った場合は無効にせず「そのルールの継続」として扱い、本文は丸ごと差し替わり、`since` は前版から引き継ぎ、`MAX_RULES_ADDED` の枠にも数えない（`changes` には何も出ない）。
- `MIN_STAT_N = 20` が効くのは `win_rate`（分母 `decided`）/ `fill_rate` / `wait_miss_rate`（`waits_judged`）だけで、分母が 20 件未満なら null で渡す。
  `win_rate_ci95`（Wilson）と `realized_r.mean` は件数に関係なく渡し、小さい n を根拠にルールを強めないのはプロンプトの指示（サーバ側では検査しない）。
- クラスタ: 同じペア × 同じ方向（鍵は `pair|signal`）のプランが直前のプランから `CLUSTER_WINDOW_MS = 24h` 以内に作られたものは 1 つに数える。
  前のプランが決着（`closed_at`）してから `CLUSTER_REOPEN_MS = 4h` を超えて作られたものは 24h 内でも別クラスタ（前が未決着なら 24h 内は同じクラスタ）。
  原因は鍵に含めず、原因別のクラスタ数は `by_cause_clusters` で後から数える。クラスタ鍵に `user_id` は含めない（全アカウント学習）。
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

- **どのルールが今の相場に当てはまるかは、モデルに書かせずサーバが測る。** ルールは根拠にしたプラン（`supported_by`）を挙げていて、そのプランは判断時点の指標スナップショットを `analyses.context.entry` / `.higher` に残している。
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
- **実データでの基準値（v8 のルール 3 本・最新行 717df3db の 1day スナップショットに対して、2026-09-06 に実測）**:
  `r10` = match（読めた引用 4/5、比較した軸は rsi・stretch・bb_pos・htf_adx、adx は広すぎて除外）/ `r4` = unknown（読めた引用 1/2 で全軸が thin）/ `r11` = off（5 軸すべて比較でき、bb_pos 以外が外れ）。
  ブロックは 581/1600 字、3 本とも出て `held_back = 0`。
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
  - 診断は `postmortem.status = done` の行を再診断しない。例外は thin の再診断と `ids` の名指し（§4.1）。
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

## 6. デプロイ手順

### 6.1 順序の不変条件

1. **エッジ関数を先に、フロントエンドを後に。** フロントは新しい `evaluation` の形を読むので、逆にすると古い関数が書いた行を新しい UI が読めない時間ができる。
2. 関数を変えたら **バージョン文字列を上げる**: `TRACKER_VERSION`（track-outcomes/index.ts）、`POSTMORTEM_VERSION`（postmortem/index.ts）、`FUNCTION_VERSION`（analyze/index.ts、econ-calendar/index.ts）。
   返り値と `tracker_state.last_sweep_result.version` / `postmortem_state.last_result.version` / `econ_calendar_state.last_result.version` に出る（状態テーブルに書くのは sweep モードのときだけ。analyze は返り値と `X-Function-Version` ヘッダ）ので、本番で「どれが動いているか」を確かめる唯一の手がかり。
3. デプロイしたものは **読み戻して sha256 を比べる** まで「デプロイ済み」と言わない。
4. データを直すマイグレーションは、それを解釈する関数を先にデプロイし、cron を止めてから流す（§4.3）。

### 6.2 手順

```sh
npm test                     # vitest 全件（現在 514）
npx tsc --noEmit -p tsconfig.app.json   # 既存エラー 12 件が基準。増やさない
npm run check:functions      # deno check（4 関数の入口）
npm run bundle:functions     # esbuild minify → supabase/functions/<slug>/bundle.js（gitignore 済み）
( cd supabase/functions/<slug> && timeout 6 deno run --allow-net --allow-env bundle.js ); echo $?   # 124 = 起動して待機中 = OK
```

- デプロイは保存済みワークフロー `.claude/workflows/deploy-edge-verified.js` で行う（`scriptPath` で起動、`args: { slug, version }`）。
  中身: `deploy_edge_function`（`entrypoint_path: "bundle.js"`, `import_map_path: "deno.json"`, `verify_jwt: false`, files = `deno.json {"imports":{}}` + `bundle.js`）→
  `get_edge_function` で読み戻し → ローカルと sha256 比較。sha256 か `version` 文字列が不一致なら再デプロイ（合計 3 回まで。初回 + 再試行 2 回）。
  最後まで一致しなくても例外は投げない。sha256 と `version` 文字列のどちらが合わなかったかをログに書いて返り、返り値の `verified` が false になる（版だけ合わないときは大抵ローカルのバンドルが古い。作り直す）。
  `args.version` には `POSTMORTEM_VERSION` 等の文字列全体（例 `postmortem-v9-2026-09-05T05:35:00Z`）を渡す。部分文字列だと sha256 が一致していても 3 回使い切る。
- バンドルは一度モデルの出力を経由するので写し間違いが起こり得る（このプロジェクトで実際に複数回起きた）。検証を省かない。
  postmortem（約 71 KB）だけでなく analyze（約 54 KB）のバンドルも Read の 1 ページに収まらない。バンドルを持つ 3 つ（analyze / track-outcomes / postmortem）はどれも必ずワークフロー経由。
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
| sweep トークン | `vault.decrypted_secrets` の `track_outcomes_sweep_token` | `public.track_outcomes_sweep_token()`（`security definer`、**`service_role` のみ実行可**）と cron の SQL |
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
- **軸は指標だけで、構造と時間帯を持たない**: `situation.ts` は `compactSnapshot` にある値しか使えない。`computeStructure` / `detectDivergence` の結果も `closedSnapshots` も行に残っていないので、
  「上値を切り下げている最中」「ロンドン時間」といった局面の違いは軸にできない。構造を軸にしたければ先に構造を行へ保存する必要がある（今はプロンプト文字列にしか出ていない）。
- **未観測**: v12 の Bid/Ask 精査、`quote_refinements`、WAIT の採点、danger の閾値は本番の平日データでまだ十分に観測できていない。月曜の 1h 分析で観る。

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
       count(*) filter (where entry_check->>'rejection' is not null) as server_rejected
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
