-- variant_stats の trend 内訳が、分母と合っていなかった。
--
-- 3つのカウンタは trend_at_call の値と完全一致で数えていたので、そのキーを持たない
-- 主張（trend_at_call を入れる前のビルドが書いた行）は conditional_claims には入るのに
-- 3つのどれにも入らない。**内訳の合計が分母に足りない**のに、その差には名前も無く、
-- どこにも出ない。この腕がまさに潰そうとしている形の失敗である。
--
-- 直す前に測った: 該当する行は 0 件（conditional_wait を持つ行が 1 件も無い）。
-- つまりこれは落ちたものを拾う修正ではなく、落ちる前に穴を塞ぐ修正である。
-- それでも足すのは、**部分の和が全体にならない内訳は内訳ではない**から。
--
-- ついでに demotions を足した。「候補版を頼んだのに control で走った」回は、
-- そうと書いてなければ「誰も頼まなかった腕」に見える（entry_check.variant_demotion）。

create or replace function public.variant_stats()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_object_agg(v.variant, v.stats), '{}'::jsonb)
  from (
    select
      a.variant,
      jsonb_build_object(
        'rows', count(*),
        'waits', count(*) filter (where a.signal = 'WAIT'),
        'conditional_claims', count(*) filter (where a.conditional_wait is not null),
        'conditional_scored', count(*) filter (where a.conditional_outcome is not null),
        'conditional_right',
          count(*) filter (where a.conditional_outcome->>'verdict' = 'triggered_right'),
        'conditional_wrong',
          count(*) filter (where a.conditional_outcome->>'verdict' = 'triggered_wrong'),
        'conditional_not_triggered',
          count(*) filter (where a.conditional_outcome->>'verdict' = 'not_triggered'),
        'conditional_unresolved',
          count(*) filter (where a.conditional_outcome->>'verdict' = 'triggered_unresolved'),
        'conditional_unmeasurable',
          count(*) filter (where a.conditional_outcome->>'verdict' = 'unmeasurable'),
        'conditional_with_trend',
          count(*) filter (where a.conditional_wait->>'trend_at_call' = 'with_trend'),
        'conditional_against_trend',
          count(*) filter (where a.conditional_wait->>'trend_at_call' = 'against_trend'),
        'conditional_trend_unknown',
          count(*) filter (where a.conditional_wait->>'trend_at_call' = 'unknown'),
        -- 内訳を分母に一致させる最後のバケツ。'unknown' は「比べる regime が
        -- 無かった」、こちらは「そのキーが無い」。同じ文ではない。
        'conditional_trend_absent',
          count(*) filter (where a.conditional_wait is not null
                             and a.conditional_wait->>'trend_at_call' is null),
        'rejections', (
          select coalesce(jsonb_object_agg(r.reason, r.n), '{}'::jsonb)
          from (
            select a2.entry_check->>'conditional_rejection' as reason, count(*) as n
            from public.analyses a2
            where a2.variant = a.variant
              and a2.shadow = false and a2.preview = false
              and a2.entry_check->>'conditional_rejection' is not null
            group by 1
          ) r
        ),
        'demotions', (
          select coalesce(jsonb_object_agg(d.reason, d.n), '{}'::jsonb)
          from (
            select a3.entry_check->>'variant_demotion' as reason, count(*) as n
            from public.analyses a3
            where a3.shadow = false and a3.preview = false
              and a3.entry_check->>'variant_requested' = a.variant
              and a3.entry_check->>'variant_demotion' is not null
            group by 1
          ) d
        )
      ) as stats
    from public.analyses a
    where a.shadow = false and a.preview = false
    group by a.variant
  ) v;
$$;

revoke all on function public.variant_stats() from public, anon, authenticated;
grant execute on function public.variant_stats() to service_role;

comment on function public.variant_stats is
  '#86 / #87。候補版の腕を腕ごとに数える。performance_stats（対照版だけの見出しの成績）とは'
  '別の関数で、合算はしない。conditional_not_triggered が分母つきで出る唯一の場所であり、'
  '**not_triggered は合格ではない**ことが数字として成立するのはここだけである。'
  'trend の内訳は with_trend + against_trend + trend_unknown + trend_absent = conditional_claims になる。'
  'demotions は「走った腕」ではなく「頼まれた腕」で引いてある。'
  'SECURITY DEFINER で service_role のみに grant。他の成績 RPC は authenticated にも grant されていて '
  'SECURITY DEFINER ではない（RLS で呼び手の行だけが見える）ので、**同じ扱いではない**。'
  'この関数は全ユーザーの行を横断して数えるため、意図的に厳しくしてある。';
