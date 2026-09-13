-- 再利用（#90）の後始末。作った直後に 2 つ間違いが見つかった。どちらも
-- 「書いたつもり」と「実際に効いているもの」のずれである。
--
-- ---------------------------------------------------------------------------
-- 1. 索引が一度も使われない綴りで作られていた
-- ---------------------------------------------------------------------------
-- 部分索引の述語を `shadow = false` と書き、照会側は PostgREST 経由で
-- `shadow=is.false`（= SQL の `shadow IS FALSE`）を送っていた。プランナは
-- BooleanTest が boolean 等値の述語を含意するとは証明できないので、部分索引は
-- 候補にすら入らない。本番で確認した:
--
--   ... and shadow is false  -> Index Scan using analyses_user_created_idx
--                                 Filter: ((shadow IS FALSE) AND (inputs_key = ...))
--   ... and shadow = false   -> Index Scan using analyses_reuse_lookup_idx
--                                 Index Cond: (user_id = ... AND inputs_key = ...)
--
-- つまり毎回、読者の全履歴を created_at 順に舐めて（1 行ごとに result /
-- context / position_review の jsonb をヒープから引いて）空振りしていた。
-- 空振りは例外ではなく既定である——この機能は 91 行中ほぼ全部で断る。
-- しかもその時間は分析の壁時計予算から引かれる（§8.5: 押し出されるのは web
-- 検索で、画面には「ファンダが静かにテクニカルになった」として出る）。
--
-- 述語を照会と同じ綴りにする。作り直したあとで本番で測り直した:
--   ... and shadow is false  -> Index Scan using analyses_reuse_lookup_idx   ← 照会はこれ
--   ... and shadow = false   -> Index Scan using analyses_user_created_idx
-- つまり綴りは**対称ではない**。`IS FALSE` の索引は `= false` の照会を拾わない
-- （逆も同じ）。索引と照会は必ず同じ綴りで書くこと。この repo の照会は全部
-- PostgREST の `shadow=is.false` なので、索引側を `is false` に合わせる。
drop index if exists public.analyses_reuse_lookup_idx;
create index analyses_reuse_lookup_idx
  on public.analyses (user_id, inputs_key, created_at desc)
  where inputs_key is not null and shadow is false;

-- ---------------------------------------------------------------------------
-- 2. outcome の取りうる値が、コードと表で食い違っていた
-- ---------------------------------------------------------------------------
-- 制約が無かったので、コードが増やした値が黙って入る。表のコメントだけを見て
-- 集計する人は、書かれていない値を「あり得ない」と読み、その行を数え落とす。
-- 障害の記録が「一度も一致しなかった」に化ける——この表が存在する理由そのもの。
--
-- 足した値:
--   search_used     一番大事な修正。full モードのリクエストには web 検索ツール
--                   が付いていて、アナリストは**モデル呼び出しの時点で**ニュース
--                   を取りに行き、fundamental_score と本文に織り込む。その中身は
--                   プロンプトのどちらの文字列にも入っていないので、鍵は見られ
--                   ないし、幅でも縛れない（ニュースは休場中にも出る。そして
--                   休場中こそがこの機能の唯一効く場面である）。
--                   最初の版は「プロンプト = 入力の全部」と言い切り、休場の間
--                   ずっと full の行を配る設計だった。金曜夜のニュースの読みを
--                   日曜の夜に「入力は一字一句同じでした」の見出しで出す、と
--                   いう意味である。同じではない。よって検索した回は配らない。
--                   代償は隠さない: 唯一一致した 1 組は mode = full だったので、
--                   **実測のヒット率は 91 行中 0 件**になる。今の運用でこの機能
--                   はまず効かない。効くのは technical_only の回と、フィードが
--                   止まっている二重送信だけ。full を含めるには「検索が返した
--                   内容」を保存して鍵に入れる必要がある。やっていない。
--   lookup_failed   「引けなかった」は「引いて無かった」ではない。候補の SELECT
--                   が非 2xx、建玉の確認が不能、created_at が読めない——どれも
--                   no_match や positions_changed と書くと、誰も観測していない
--                   ことを観測したように記録する（§7.3）。
--   key_unavailable 鍵そのものが作れず、照会を一度もしていない回。
alter table public.analysis_reuses
  add constraint analysis_reuses_outcome_check
  check (outcome in (
    'served',
    'no_match',
    'outside_window',
    'not_servable',
    'positions_changed',
    'search_used',
    'lookup_failed',
    'key_unavailable',
    'forced_fresh'
  ));

comment on column public.analysis_reuses.outcome is
  'served / no_match / outside_window / not_servable / positions_changed / '
  'search_used / lookup_failed / key_unavailable / forced_fresh。'
  '断った理由を残さないと「一度も効いていない」と「そもそも試していない」が見分けられない。'
  'search_used = その行は web 検索付きで書かれており、検索が返した内容は鍵に入っていないので配らない。'
  'lookup_failed = 引けなかった（照会がエラー／建玉を確認できなかった／時刻が読めなかった）。'
  'key_unavailable = 鍵が作れず、照会自体をしていない。'
  'この一覧は analyze/reuse.ts の REUSE_OUTCOMES と一致する（src/test/reuse.test.ts が突き合わせる）。';
