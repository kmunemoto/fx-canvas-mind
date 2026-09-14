-- 「1/N だけ直す」を3回繰り返したので、今回は N を数えてから直す。
--
-- 1) performance_stats は public.analyses を**3回**読む。20260913140000 が述語を
--    足したのは最初の1回だけで、shadow ブロックと preview ブロックは腕を混ぜたまま
--    だった。しかも 20260913150000 系の修正で shadow 行が腕を正しく名乗るように
--    なったので、候補版の shadow 行がここに現れるようになっている。
--    あの移行の見出しの主張「候補版の行は統計に入らない」は、まだ偽だった。
--
-- 2) variant_stats.demotions は、追加した当の場面で構造的に出てこない。
--    demotions は「頼まれた腕」で引くのに、外側は「走った腕」で group by する。
--    1day で lower_tf を頼んで毎回 control に落ちる腕は**自分の行を1つも持たない**
--    ので、その腕のグループ自体が存在せず、demotions もどこにも出ない。
--    「頼まれたのに走らなかった腕が、誰も頼まなかった腕に見える」— それを消すために
--    足した機能が、まさにその形で消えていた。
--    腕の一覧を「行を持つ腕 ∪ 頼まれた腕」の和で作り直す。
--
-- 3) 直前に書いた grant コメントも偽だった。「他の成績 RPC は SECURITY DEFINER では
--    ない」と書いたが、loop_health は SECURITY DEFINER である（本番で実測）。
--    しかも loop_health は、この同じ一連の修正が「兄弟の成績 RPC」と呼んでいる当の
--    関数である。偽の主張を、別の偽の主張で置き換えていた。

do $migration$
declare
  def text;
  hits int;
begin
  select pg_get_functiondef(p.oid) into def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'performance_stats';

  if def is null then
    raise exception 'performance_stats not found';
  end if;

  for hits in
    select 1 where position('from public.analyses where shadow = true and coalesce' in def) > 0
  loop
    raise notice 'performance_stats shadow/preview blocks already filtered; skipping';
    return;
  end loop;

  hits := (length(def) - length(replace(def, 'from public.analyses where shadow = true', ''))) /
          length('from public.analyses where shadow = true');
  if hits <> 1 then
    raise exception 'expected 1 shadow read in performance_stats, found %', hits;
  end if;
  hits := (length(def) - length(replace(def, 'from public.analyses where preview = true', ''))) /
          length('from public.analyses where preview = true');
  if hits <> 1 then
    raise exception 'expected 1 preview read in performance_stats, found %', hits;
  end if;

  def := replace(def,
    'from public.analyses where shadow = true',
    'from public.analyses where shadow = true and coalesce(variant, ''control'') = ''control''');
  def := replace(def,
    'from public.analyses where preview = true',
    'from public.analyses where preview = true and coalesce(variant, ''control'') = ''control''');
  execute def;
end
$migration$;

do $assert$
declare
  n int;
begin
  select (select count(*) from regexp_matches(pg_get_functiondef(p.oid), 'coalesce\((a\.)?variant', 'g'))
    into n
  from pg_proc p join pg_namespace nsp on nsp.oid = p.pronamespace
  where nsp.nspname = 'public' and p.proname = 'performance_stats';
  if n <> 3 then
    raise exception 'performance_stats should carry 3 variant predicates (main, shadow, preview), found %', n;
  end if;
end
$assert$;

create or replace function public.variant_stats()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with arms as (
    select a.variant as arm
    from public.analyses a
    where a.shadow = false and a.preview = false
    union
    select a.entry_check->>'variant_requested'
    from public.analyses a
    where a.shadow = false and a.preview = false
      and a.entry_check->>'variant_requested' is not null
  )
  select coalesce(jsonb_object_agg(arm, stats), '{}'::jsonb)
  from (
    select
      x.arm,
      jsonb_build_object(
        'rows', (select count(*) from public.analyses a
                  where a.shadow = false and a.preview = false and a.variant = x.arm),
        'waits', (select count(*) from public.analyses a
                   where a.shadow = false and a.preview = false and a.variant = x.arm
                     and a.signal = 'WAIT'),
        'conditional_claims', (select count(*) from public.analyses a
                   where a.shadow = false and a.preview = false and a.variant = x.arm
                     and a.conditional_wait is not null),
        'conditional_scored', (select count(*) from public.analyses a
                   where a.shadow = false and a.preview = false and a.variant = x.arm
                     and a.conditional_outcome is not null),
        'conditional_right', (select count(*) from public.analyses a
                   where a.shadow = false and a.preview = false and a.variant = x.arm
                     and a.conditional_outcome->>'verdict' = 'triggered_right'),
        'conditional_wrong', (select count(*) from public.analyses a
                   where a.shadow = false and a.preview = false and a.variant = x.arm
                     and a.conditional_outcome->>'verdict' = 'triggered_wrong'),
        'conditional_not_triggered', (select count(*) from public.analyses a
                   where a.shadow = false and a.preview = false and a.variant = x.arm
                     and a.conditional_outcome->>'verdict' = 'not_triggered'),
        'conditional_unresolved', (select count(*) from public.analyses a
                   where a.shadow = false and a.preview = false and a.variant = x.arm
                     and a.conditional_outcome->>'verdict' = 'triggered_unresolved'),
        'conditional_unmeasurable', (select count(*) from public.analyses a
                   where a.shadow = false and a.preview = false and a.variant = x.arm
                     and a.conditional_outcome->>'verdict' = 'unmeasurable'),
        'conditional_with_trend', (select count(*) from public.analyses a
                   where a.shadow = false and a.preview = false and a.variant = x.arm
                     and a.conditional_wait->>'trend_at_call' = 'with_trend'),
        'conditional_against_trend', (select count(*) from public.analyses a
                   where a.shadow = false and a.preview = false and a.variant = x.arm
                     and a.conditional_wait->>'trend_at_call' = 'against_trend'),
        'conditional_trend_unknown', (select count(*) from public.analyses a
                   where a.shadow = false and a.preview = false and a.variant = x.arm
                     and a.conditional_wait->>'trend_at_call' = 'unknown'),
        'conditional_trend_absent', (select count(*) from public.analyses a
                   where a.shadow = false and a.preview = false and a.variant = x.arm
                     and a.conditional_wait is not null
                     and a.conditional_wait->>'trend_at_call' is null),
        'rejections', (
          select coalesce(jsonb_object_agg(r.reason, r.n), '{}'::jsonb)
          from (
            select a.entry_check->>'conditional_rejection' as reason, count(*) as n
            from public.analyses a
            where a.shadow = false and a.preview = false and a.variant = x.arm
              and a.entry_check->>'conditional_rejection' is not null
            group by 1
          ) r
        ),
        -- 「頼まれた腕」で引く。外側の腕一覧が和集合になったので、行を1つも
        -- 持たない腕でもここに出る。それが無いと、毎回 control に落ちる腕は
        -- 「誰も頼まなかった腕」と区別できない。
        'demotions', (
          select coalesce(jsonb_object_agg(d.reason, d.n), '{}'::jsonb)
          from (
            select a.entry_check->>'variant_demotion' as reason, count(*) as n
            from public.analyses a
            where a.shadow = false and a.preview = false
              and a.entry_check->>'variant_requested' = x.arm
              and a.entry_check->>'variant_demotion' is not null
            group by 1
          ) d
        )
      ) as stats
    from arms x
    where x.arm is not null
  ) v;
$$;

revoke all on function public.variant_stats() from public, anon, authenticated;
grant execute on function public.variant_stats() to service_role;

comment on function public.variant_stats is
  '#86 / #87. Counts each arm separately; never summed with performance_stats (the control-only headline record). The only place conditional_not_triggered appears with a denominator, which is the only way not_triggered is a penalty rather than an absence. The trend breakdown sums to conditional_claims. The arm list is the UNION of arms that have rows and arms that were REQUESTED, so an arm demoted every time still reports its demotions. Granted to service_role only: it counts across all users, whereas the other stats RPCs are granted to authenticated. (loop_health is also SECURITY DEFINER - an earlier version of this comment claimed no other stats RPC was, which was false.)';
