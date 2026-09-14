-- 20260913140000 は嘘を1つ残していた。
--
-- あの移行のコメントはこう書いた:「候補版の行は統計に入らない。」 patch したのは
-- performance_stats **だけ**である。同じ画面に出ている他の統計 —
-- separated_scores（方向・場所・タイミングの分解）、confidence_calibration
-- （確信度帯別）、model_mix（モデル別）、loop_health（ループの稼働状況）— は
-- 全部 `shadow = false and preview = false` のままで、腕を見ていない。
-- 本番で実測: variant を述語に持つのは performance_stats だけ
-- （separated_scores の "variant" は散文コメントの中の単語だった）。
--
-- つまりあの1行は、書いた時点で4つの関数について偽だった。ここで真にする。
--
-- loop_health には副作用がある。postmortem が候補版の行を診断しなくなったので、
-- awaiting_review（決着したのに postmortem が無い行の数）は**永久に減らない待ち行列**を
-- 数えることになっていた。ここで腕を外すと、その行列も同時に消える。
-- 「診断されない行を診断待ちとして数える」のは、報告としても間違っている。
--
-- 関数本体は書き写さない（20260913140000 と同じ理由）。ただし loop_health は
-- 同じ述語が5箇所に出るので「1箇所でなければ中断」は使えない。代わりに
-- **期待する出現数を明示し、数が合わなければ中断する**。数を書かずに全置換するのは、
-- 関数が作り変わっていても黙って通ってしまう。

do $migration$
declare
  target record;
  def text;
  hits int;
begin
  for target in
    select * from (values
      -- func, anchor, expected hits, replacement
      ('separated_scores',
       'where a.shadow = false and a.preview = false', 1,
       'where a.shadow = false and a.preview = false and coalesce(a.variant, ''control'') = ''control'''),
      ('confidence_calibration',
       'where a.shadow = false', 1,
       'where a.shadow = false and coalesce(a.variant, ''control'') = ''control'''),
      ('model_mix',
       'where a.shadow = false', 1,
       'where a.shadow = false and coalesce(a.variant, ''control'') = ''control'''),
      ('loop_health',
       'where user_id = auth.uid() and shadow = false and preview = false', 3,
       'where user_id = auth.uid() and shadow = false and preview = false and coalesce(variant, ''control'') = ''control'''),
      ('loop_health',
       'and a.shadow = false and a.preview = false', 2,
       'and a.shadow = false and a.preview = false and coalesce(a.variant, ''control'') = ''control''')
    ) as t(func, anchor, expected, replacement)
  loop
    select pg_get_functiondef(p.oid) into def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = target.func;

    if def is null then
      raise exception 'function %.% not found - refusing to guess at its definition', 'public', target.func;
    end if;

    -- 冪等性の判定は**アンカー単位**で行う。関数単位で「もう variant を含むか」を
    -- 見るのは間違いで、実際に一度それで踏んだ: loop_health は述語が2種類あり、
    -- 1種類目を当てた直後に関数が variant を含むようになって、2種類目が黙って
    -- スキップされた。5箇所直すはずが3箇所で止まり、しかも成功として返った。
    --
    -- アンカーの出現数では判定できない（replacement はアンカー＋追記なので、
    -- 当てた後もアンカーは同じ数だけ残る）。**replacement の出現数**を見る。
    hits := (length(def) - length(replace(def, target.replacement, ''))) / length(target.replacement);
    if hits = target.expected then
      raise notice '%: this predicate is already filtered; skipping', target.func;
      continue;
    end if;

    hits := (length(def) - length(replace(def, target.anchor, ''))) / length(target.anchor);
    if hits <> target.expected then
      raise exception 'expected % occurrence(s) of the base filter in %, found %',
        target.expected, target.func, hits;
    end if;

    execute replace(def, target.anchor, target.replacement);
  end loop;
end
$migration$;

comment on function public.variant_stats is
  '#86 / #87。候補版の腕を腕ごとに数える。performance_stats（対照版だけの見出しの成績）とは'
  '別の関数で、合算はしない。conditional_not_triggered が分母つきで出る唯一の場所であり、'
  '**not_triggered は合格ではない**ことが数字として成立するのはここだけである。'
  'SECURITY DEFINER で service_role のみに grant してある。他の成績 RPC は authenticated にも'
  'grant されていて SECURITY DEFINER ではない（RLS で呼び手の行だけが見える）ので、**同じ扱いではない**。'
  'この関数は全ユーザーの行を横断して数えるため、意図的に厳しくしてある。';

-- 適用後の状態を、推測ではなく**表明**する。上のループが途中で止まっても
-- 「成功」で返らないようにするため（実際に一度そうなった）。
do $assert$
declare
  n int;
begin
  for n in
    select (select count(*) from regexp_matches(pg_get_functiondef(p.oid), 'coalesce\((a\.)?variant', 'g'))
    from pg_proc p join pg_namespace nsp on nsp.oid = p.pronamespace
    where nsp.nspname = 'public' and p.proname = 'loop_health'
  loop
    -- この時点では 5。open_plans はこの後 20260913190000 で戻すので、最終状態は 4 に
    -- なる（あれは統計ではなく、いま建っている建玉の数である）。再生の途中経過として
    -- ここは 5 で正しい。
    if n <> 5 then
      raise exception 'loop_health should carry 5 variant predicates at this point, found %', n;
    end if;
  end loop;

  for n in
    select (select count(*) from regexp_matches(pg_get_functiondef(p.oid), 'coalesce\((a\.)?variant', 'g'))
    from pg_proc p join pg_namespace nsp on nsp.oid = p.pronamespace
    where nsp.nspname = 'public'
      and p.proname in ('separated_scores', 'confidence_calibration', 'model_mix')
  loop
    if n <> 1 then
      raise exception 'a sibling stats RPC should carry exactly 1 variant predicate, found %', n;
    end if;
  end loop;
end
$assert$;
