-- cdced64 は「適用後の状態を表明する assert を足した」と書いた。足したのは
-- **ファイルにだけ**である。本番に流した SQL はその編集より前のもので、この assert は
-- ここで一度も実行されていない。兄弟 3 関数の最終状態は、どこでも表明されていなかった。
--
-- いま走らせる。状態が正しければ何もしない no-op で、それが証明になる。正しくなければ
-- 大きな音で落ちる。存在する assert というのはそういうものである。
do $assert$
declare
  n int;
  bad text;
begin
  select (select count(*) from regexp_matches(pg_get_functiondef(p.oid), 'coalesce\((a\.)?variant', 'g'))
    into n
  from pg_proc p join pg_namespace nsp on nsp.oid = p.pronamespace
  where nsp.nspname = 'public' and p.proname = 'loop_health';
  -- 5 ではなく 4。open_plans は意図的に戻してある（20260913190000）。
  -- あれは統計ではなく、いま建っている建玉の数だから。
  if n <> 4 then
    raise exception 'loop_health should carry 4 variant predicates, found %', n;
  end if;

  select string_agg(p.proname || '=' || c.n::text, ', ')
    into bad
  from pg_proc p
  join pg_namespace nsp on nsp.oid = p.pronamespace
  cross join lateral (
    select count(*) as n from regexp_matches(pg_get_functiondef(p.oid), 'coalesce\((a\.)?variant', 'g')
  ) c
  where nsp.nspname = 'public'
    and p.proname in ('separated_scores', 'confidence_calibration', 'model_mix')
    and c.n <> 1;
  if bad is not null then
    raise exception 'each sibling stats RPC should carry exactly 1 variant predicate; got %', bad;
  end if;

  select (select count(*) from regexp_matches(pg_get_functiondef(p.oid), 'coalesce\((a\.)?variant', 'g'))
    into n
  from pg_proc p join pg_namespace nsp on nsp.oid = p.pronamespace
  where nsp.nspname = 'public' and p.proname = 'performance_stats';
  if n <> 3 then
    raise exception 'performance_stats should carry 3 variant predicates, found %', n;
  end if;

  raise notice 'arm-filter end state verified: performance_stats=3, loop_health=4, siblings=1 each';
end
$assert$;
