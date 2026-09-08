# 事前登録: 診断の深さは診断の中身を変えるか（postmortem-v21）

**これは結果が出る前に書いた文書である。** 2026-09-08、`postmortem-v21` をデプロイした直後に書き、
測る対象・事前の予測・**何をもって「効かなかった」とするか** をここで固定する。
結果が出たあとに予測や失敗条件を書き換えない。追記だけを許す（§10）。

コード中のコメントが一次資料で、この文書はその索引。数値は 2026-09-08 時点のコードから写した。
食い違いを見つけたらコードが正しい。この文書を直すこと。

- 診断の入口: `supabase/functions/postmortem/index.ts`
- 事実の算出と待ち・窓の定数: `supabase/functions/postmortem/facts.ts`
- ループ全体の不変条件: `docs/OPERATIONS.md` §4

---

## 1. 問い

**終端の深さ（窓が丸ごと揃ってから）で書いた診断は、決着直後に書いた同じ行の診断と違うのか。**

診断は決着のすぐ後に書かれる。これは事故ではなく設計である（`AFTER_WAIT_MS`）。
一方、同じコードが「その後どうなったか」の窓として定義しているのは `AFTER_BARS` × プランの足であり、
最初の診断が見ているのはその窓のごく一部でしかない。

| プランの足 | `AFTER_WAIT_MS` | 判定足 `EVAL_INTERVAL` | 最初の診断が見る足数（概算） | 窓 `afterWindowMs` | 窓が丸ごと埋まったときの足数（上限） |
|---|---|---|---|---|---|
| 15min | 1h | 15min | 4 | 6h | 24 |
| 1h | 2h | 15min | 8 | 24h | 96 |
| 4h | 4h | 1h | 4 | 48h | 48 |
| 1day | 8h | 1h | 8 | 120h | 120 |

- `bars_after_settlement` は **判定足** で数える。`AFTER_BARS` は **プランの足** で窓の長さを決める。
  同じ「本」でも単位が違う（`facts.ts` の `MIN_AFTER_BARS` のコメント）。
- どの足でも最初の読みは **最短で** 4〜8 本、つまり `MIN_AFTER_BARS = 8` の境界かそれ以下に着地する。
  これは下限であって分布ではない: `isPostmortemDue` は `>=` で、1 run に 3 件しか進まないので、待ち行列が詰まった行は後から＝深く読まれる。
  実際 `lessons` 32 件のうち **20 件が 8 本以下**、12 件がそれより深い（2026-09-08 の実測。§7 の SQL で数え直せる）。
  この一行は当初「24 件のうち 12 件が 8 本以下」と書いていた。12 は **8 本より深い側** の数であり、母数も古い。
  デプロイ前に本番で数え直して直した経緯を残す。以降の数字はすべて 2026-09-08 に本番へ問い合わせた実測である。
- ここから直接に出る帰結: `thin`（8 本未満）という切り口は「信頼できない診断」の切り口として粗すぎる。
  1h と 1day のプランはちょうど 8 本で `thin = false` になるが、見ているのは窓の 8%〜7% でしかない。

## 2. 何を出したか（介入 = `postmortem-v21`）

1 回のデプロイに 4 つ入っている。順序に意味がある。

1. **前の読みを残す**（`analyses.postmortem.prior`）。done の診断を上書きする前に、その診断の要約を配列に積む。
   `version` / `created_at` / `cause` / `secondary_causes` / `avoidable` / `confidence` /
   `rule_blamed` / `rule_credited` / `lesson` / `bars_after_settlement` / `thin` だけを写し、
   `facts` も入れ子の `prior` も持たない（文書は既に 1 件 8〜10 KB あり、入れ子にすると二乗で増える）。
   上限は `HISTORY_KEEP = 20`。
2. **WAIT の `thin` を `null` にする**。見送りの「その後」は意図的に空配列に落としているので
   `bars_after_settlement` は構造上 0 であり、`thin = true` は **測っていない測定について「浅い」と言っていた**。
   `false` は逆向きの同じ嘘なので、当てはまらないと言える `null` を選んだ。
3. **修復パスが版ずれも直す**。`lessons` の行が存在していても、その `postmortem_version` が
   `analyses` 側の診断の版と違えば書き直す（`321bccaa` は v16 の教訓の下に v17 の診断があった）。
   モデルは呼ばない。診断は触らない。保存済みの診断からの再射影だけ。
4. **thin に限らず全 done 行を 1 回ずつ読み直す**（`retryFilter` の第 3 分岐）。

**1 が 4 より先でなければならない。** `MAX_REVISIONS = 1` なので、4 だけが先に出れば
読み直しの対象になる **26 行**（トレード 22・WAIT 4）の前の読みは上書きされて永久に失われ、
この文書の問い自体が成立しなくなる。だから 1 回のデプロイにした。

**診断の入力は変えていない。** プロンプト、原因語彙、`facts` の計算は v20 のまま。
これは §3 の交絡を繰り返さないためである。

## 3. 予備調査（n=4、交絡あり）

2026-09-07、保存済みの負け 4 件を 48〜95 本の深さで読み直した。
**2 件は `cause` がまるごと変わり（`c8788083` direction_wrong → stop_too_tight、`1b003cf3` direction_wrong → chased_move）、
1 件は `cause` を保ったまま `avoidable` が false に反転した（`c14cdb0a`）。残る 1 件（`32d167d3`）については何も記録が無い。**

4 件目が「変わらなかった」のか「変わったが記録していない」のかは、もう確かめられない。
読み直しが前の文書をそのまま上書きしたからである。**`prior` はこの取り返しのつかなさに対して入れた。**

ただしこの 4 件は、**原因語彙も同時に変えたビルド** で読み直している。
深さの効果と語彙変更の効果は分離できていない。加えて n=4 である。

この数字は「深さで診断が変わる」ことの証拠として使えない。以降どこで引用するときも同じ但し書きを付ける。
この予備調査の役割は、**測る価値がありそうだと判断した根拠** を残すことだけである。

## 4. 測ること

母集団は `prior` を持つ done 行のうち **トレード（`subject` が `wait` でない）行**。
`prior` の **最初の** 要素（決着直後の浅い読み）と、その行の現在の診断を突き合わせる。

- `cause` が変わった行数 / 全体
- `avoidable` が反転した行数
- `rule_blamed` か `rule_credited` が変わった行数
- **層別**: `prior.bars_after_settlement <= 8` の群と `> 8` の群で `cause` 変化率を比べる
- 参考として `confidence` の変化と `secondary_causes` の変化

母集団と比較先の取り方には、間違えると静かに別の問いに化ける点が 2 つある。

- **`->0` であって `->-1` ではない。** `prior` は古い順に積む（`index.ts` は末尾に追加する）ので、決着直後の読みは常に先頭。
  末尾は「直前の読み」でしかなく、`ids` で名指しした手動実行は `revisions` を消費せずに `prior` を 1 つ増やす（§9）。
  1 度でも手で覗いた行では `->-1` が「深い読み対深い読み」になり、差が出ないほうへ全指標が寄る。エラーは出ない。
- **WAIT 行は母集団から外す。** 見送りの診断が見る事実は時刻に依存しない（`facts.ts` は `after` を空配列に落とし、地平を `wait.untilMs` に固定する）ので、
  読み直しても入力は 1 回目と同一である。深さの介入は WAIT には何もしていない。
  ただし **捨てずに別行で報告する**: 入力が同じ 2 回の読みの不一致率は、そのまま「読み直すだけで揺れる量」の実測になる。§9 の限界に対する、この実験の中にある唯一の対照である。

```sql
with pairs as (
  select id,
         coalesce(postmortem->>'subject', 'trade')                 as subject,
         postmortem->>'cause'                                      as now_cause,
         postmortem->'prior'->0->>'cause'                          as prev_cause,
         (postmortem->>'avoidable')::boolean                       as now_avoidable,
         (postmortem->'prior'->0->>'avoidable')::boolean           as prev_avoidable,
         postmortem->>'rule_blamed'                                as now_blamed,
         postmortem->'prior'->0->>'rule_blamed'                    as prev_blamed,
         postmortem->>'rule_credited'                              as now_credited,
         postmortem->'prior'->0->>'rule_credited'                  as prev_credited,
         (postmortem->'prior'->0->>'bars_after_settlement')::int   as prev_bars,
         (postmortem->'facts'->>'bars_after_settlement')::int      as now_bars,
         jsonb_array_length(postmortem->'prior')                   as readings
  from public.analyses
  where postmortem->>'status' = 'done'
    and jsonb_array_length(coalesce(postmortem->'prior', '[]'::jsonb)) > 0
)
select subject,
       count(*)                                                                          as n,
       -- 自動の読み直しは 1 回だけなので readings は 1。2 以上は ids で手動実行した行（§9）
       count(*) filter (where readings > 1)                                              as hand_read,
       count(*) filter (where now_cause is distinct from prev_cause)                     as cause_changed,
       count(*) filter (where now_avoidable is distinct from prev_avoidable)             as avoidable_flipped,
       count(*) filter (where now_blamed  is distinct from prev_blamed
                           or now_credited is distinct from prev_credited)               as rule_changed,
       count(*) filter (where prev_bars <= 8)                                            as from_shallow,
       count(*) filter (where prev_bars <= 8 and now_cause is distinct from prev_cause)  as shallow_cause_changed,
       count(*) filter (where prev_bars >  8)                                            as from_deep,
       count(*) filter (where prev_bars >  8 and now_cause is distinct from prev_cause)  as deep_cause_changed
from pairs
group by subject;
```

`subject = 'trade'` の行が §5 と §6 の対象。`subject = 'wait'` の行は対照として並べて読むだけで、
主指標には足さない（足すと、入力が同じ 2 回の読みの揺れが「深さの効果」として数えられる）。

この SQL は未実行である（この文書は結果が出る前に書いている）。実行できないときはまずそれを直す。

## 5. 事前に置く予測

一巡後の n（`subject = 'trade'` の行）は **18〜22 件** を見込む。デプロイ時点の実測で、`revisions` を未消費の
done のトレード行がちょうど 22 件あり（§7）、そのうち失敗で落ちる分を引いた見込みである。
以下は **結果を見る前に** 置いた数字で、すべて割合なので n がこの見込みから外れても読み替えない。

| 指標 | 予測（点） | 予測（区間） |
|---|---|---|
| `cause` が変わる行の割合 | 35% | 20〜55% |
| `avoidable` が反転する行の割合 | 20% | 10〜35% |
| `rule_blamed` / `rule_credited` のいずれかが変わる行の割合 | 25% | 15〜40% |
| 層別差（≤8 本群の `cause` 変化率 − >8 本群の同率） | +15 ポイント | +5〜+35 ポイント |

## 6. 「効かなかった」とする条件（先に固定する）

次のいずれかが起きたら、**この介入は効かなかった** と書く。あとから読み替えない。

- **主条件**: `cause` の変化率が **20% 未満**。20% は §5 で先に置いた区間の下限であり、新しい数字ではない。
  → 深さは診断の中身を変えない。全件再診断は不要だった。
  このとき「それでも数件は変わったのだから意味はあった」とは書かない。上の閾値を先に置いたのはそのためである。
  条件を 1 本の指標の 1 本の閾値にしたのは、複数条件の **かつ** で書くと、どの条件も満たさず予測にも届かない帯（たとえば 17%）が
  「効いたとも効かなかったとも書かない」逃げ道になるからである。副次指標（`avoidable` の反転、`rule_blamed` / `rule_credited` の変化）は
  結論を分けるのではなく、主指標の読みを補強するか弱めるかとして報告する。目安は割合で置く: 反転 10% 未満、ルール変化 15% 未満なら「主指標の判定と同じ向き」。
- **層別条件**: ≤8 本群と >8 本群の `cause` 変化率の差が 0 ポイント以下。
  → 変化しているとしても、それは深さの効果ではない（`thin` という切り口の問題ですらない）。
- **手続き条件**: 一巡しても `prior` を持つトレードの行が 10 件に満たない。
  → 測定そのものが成立していない。結論を書かず、なぜ再診断が流れていないかを先に調べる（§7）。

逆に、**変化率が高いこと自体は「深い読みが正しい」ことを意味しない。**
ここで測っているのは 2 つの読みの一致率であって、どちらが当たっているかではない。
正しさを測るには別の基準（実際にその後どうなったか）が要る。これはこのデザインの外にある。

## 7. いつ結果が出るか

- デプロイ時点（2026-09-08）の実測。`analyses` 46 行、うち done が 32 行、`lessons` も 32 行
  （done の診断 1 件につき教訓 1 行。`lessons.analysis_id` は `analyses` への外部キーで `on delete cascade`）。
  **読み直しの対象は 26 行**（トレード 22・WAIT 4）。残る 6 行は既に `revisions` を消費済みで、対象外である（§9）。
  数え直すのは 1 行:

```sql
select count(*) as done_rows from public.analyses where postmortem->>'status' = 'done';
select count(*) filter (where bars_after_settlement <= 8) as shallow, count(*) as lessons
from public.lessons;
```

- **待ち行列の速さは律速ではない。** 1 run あたり `MAX_PLANS_PER_RUN = 3` 件、cron は 15 分ごと = 1 時間あたり 12 件。
  実際に効いているのは `afterWindowMs`（1day なら 120 時間）で、**窓が丸ごと揃うまで再診断は始まらない**。
  直近に決着した行ほど後に回る。
- 実測（2026-09-08）: 対象 22 件のトレード行のうち **13 件は既に窓が揃っている**（＝すぐ読み直せる。3 件/run なら 5 run、
  1 時間強で終わる分）。残る 9 件は窓待ちで、**いちばん長い行であと約 101 時間**（2026-09-08 00:20 に決着した 1day の行、窓 120 時間）。
- したがって **一巡には約 4 日半を見込む**（2026-09-12 ごろ）。部分的な結果は数時間で出るが、それは窓の揃った古い行に偏っている。
  当初この見積もりは「34 時間」としていた。それは 400 行という誤った母数から throughput で割った数で、根拠が残らなかったため捨てた。
  **途中経過で §5 の予測に触らない。**
- 途中経過は run のサマリで見る: `diagnosed`、`lessons`、`lessons_repaired`、`lessons_restated`。
  `lessons_restated` が伸びていれば §2 の 3 が効いている。`diagnosed` が伸びないまま数時間過ぎるなら、
  `retryFilter` が 400 を返していないか（PostgREST の手組みの `or=(...)` は括弧 1 つで 400 になり、
  sweep はそれを飲み込む）を最初に疑う。
- **`limit=40` の余白を見る。** 候補の取得は `limit=40` で `closed_at.asc.nullsfirst` 順なので、読み直し待ちの古い行がページを
  埋めると、決着したばかりの行が **初回の診断すら受けられなくなる**（`due = rows.slice(0, options.limit)`）。
  数えるのは done 行の総数ではなく、`retryFilter` に **合致する** 行の数である。実測（2026-09-08）はトレード側 23 件
  （未診断 1 + 読み直し 22）で、余白は 17 件。WAIT 側は別クエリで 15 件。**今は詰まっていないが、余白は 17 件しかない。**
  この余白を使い切ると、停止は静かに起きる（エラーは出ない）。一巡を待つ前に必ず数え直すこと。

## 8. とくに見るもの: `r11`

現行ルールのうち `r11` の支持は引用 3 件で立っている。**その 3 件がどの深さの読みなのかは、まだ確かめていない。**
下の SQL がそれを返す（`l.bars_after_settlement`）ので、結果を書くときは最初にこれを実行する。
（`docs/OPERATIONS.md` §8 の「`r11` が 3 件」は `context.entry` のスナップショットが引けるかどうかの話で、読みの深さの話ではない。混ぜない。）

```sql
select l.analysis_id, l.cause, l.bars_after_settlement, l.postmortem_version,
       a.postmortem->>'cause'             as cause_now,
       a.postmortem->'prior'->0->>'cause' as cause_before
from public.lessons l
join public.analyses a on a.id = l.analysis_id
-- ::text が要る。analysis_id は uuid、jsonb_array_elements_text は text を返し、
-- PostgreSQL に uuid = text の暗黙変換は無い（無いと operator does not exist で落ちる）
where l.analysis_id::text in (
  select jsonb_array_elements_text(r->'supported_by')
  from public.rulebook, jsonb_array_elements(rules) r
  where id = 1 and r->>'id' = 'r11'
);
```

- **`r11` の引用のうち 1 件でも `cause` が変われば**、その `support` は数え直しになる（`support` は独立クラスタ数）。
  8 本の読みでルールブックが書かれていた具体例が 1 つ確定する。
- **`r11` がそのまま残れば**、少なくともこの scope では 8 本の読みは持ちこたえた。
  介入が無駄だったことにはならないが、以後 `r11` を根拠に「浅い読みは危険」と論じることはできない。

## 9. このデザインの既知の限界（先に書いておく）

- `MAX_REVISIONS = 1` なので、自動の読みは 2 回で終わる。変化が **深さのせい** なのか
  **読み直すたびに揺れるだけ** なのかを、このデザインでは分離できない。
  §6 の主条件を満たして「効いた」と読める場合でも、この限界は結果と一緒に書く。
  唯一の手がかりは §4 で別に数える WAIT 行（入力が同じ 2 回の読み）であり、これは対照として設計したものではない。
- `ids` で名指しした手動実行は `revisions` を消費しないまま `prior` を 1 つ増やす。つまり自動の 1 回の他に、
  手で読ませた回数だけ読みが積まれうる。§4 の `hand_read` がそれを数える。1 件でもあれば、その行の
  `prior` の中身を見てから層別に入れる（先頭は決着直後の読みのままなので、比較そのものは壊れない）。
- 診断に渡すルールはプランの版に固定される（`rulesByVersion`）が、その版が `rulebook.history` から
  溢れると（`HISTORY_KEEP = 20`）2 回目の読みだけルール無しになる。該当行は層別から外す。
- `prior` は done の読みしか積まない。failed を挟んだ行は `prior` が 1 段少ない。
- WAIT 行は `thin` が `null` で「浅い/深い」の層別に入らず、主指標にも足さない（§4）。見送りそのものの再診断は別の問いで、この文書は扱わない。
- `prior` の上限は `HISTORY_KEEP = 20` で、溢れたときに落ちるのは **先頭＝決着直後の読み** である
  （`slice(-(HISTORY_KEEP - 1))`。ルールブックの履歴と同じ書き方を写した）。自動の読み直しは 1 回なので通常は届かないが、
  同じ行を手動で 20 回以上読ませればこの実験の前半分が消える。§4 の `hand_read` が 0 でないうちは覚えておくこと。
- **6 行は既に手遅れである。** デプロイ時点で `revisions` を消費済みの done 行が 6 件あり、新しい `retryFilter` にも
  合致しない。トレード 3 件（`43992a50` / `0679b7f2` / `1d4b65c5`）と WAIT 3 件（`321bccaa` / `4a2b856b` / `1e167ee9`）で、
  WAIT の 3 件は `thin` が構造上つねに真だったせいで（§2 の 2）唯一の読み直しを浪費した行である。
  この 6 行の「決着直後の読み」は `prior` が入る前に上書きされており、もう取り返せない。母集団はここから 26 行に減っている。
- 母集団は本番のトレードの done 行であり、無作為抽出ではない。対照群も無い。読める主張は
  「同じ行を深く読み直すと診断がどれだけ変わるか」だけで、それ以上ではない。

## 10. 結果を書く場所

結果はこの文書の末尾に「## 11. 結果（2026-09-__）」として **追記** する。
§5 の予測と §6 の失敗条件は書き換えない。読み替えを防ぐために先に書いたものだからである。
