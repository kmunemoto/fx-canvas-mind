-- 統計が腕を混ぜていた（#86 / #87 のレビュー指摘）。
--
-- 20260913120000 のコメントにこう書いた:「行が永久に持つ名前 — 2つの母集団が
-- 事故で混ざらないため」。行はそうなった。**統計はそうなっていなかった。**
-- performance_stats の本体に `variant` は一度も出てこず（本番で実測: 0 箇所）、
-- 候補版の行はそのまま見出しの成績に合流する。つまりあのコメントは、書いた時点では
-- 本当ではなかった。
--
-- （この行は最初「48件・24勝24敗・+0.217R/件 の出どころ」と書いていた。その 3 つは
--   別々の場面で数えた別々の分母の値で、performance_stats が 1 つの区画としてその
--   3 つ組を返すことは無い。成績の話をするのに、この関数が出さない数字を根拠として
--   並べていた。）
--
-- さらに悪いのは WAIT の数え方である。wait_judged は verdict in ('missed',
-- 'correct') を数え、wait_missed は 'missed' だけを数えるので、**correct は
-- 表示上の WAIT 精度を上げる。** #86 の条件付き WAIT は「窓が終わって何も取ら
-- なかった」行なので既存の採点では correct になる。つまり #86 が塞ぐために
-- 書かれたはずの抜け道 —「届かない水準を名指しするのが一番安く正しく見える」—
-- は、conditional_outcome を誰も読まない限りそのまま開いていた。
-- not_triggered はどの分母にも入っていなかった。罰ではなく不在だった。
--
-- ここで閉じる: 候補版の行は統計に入らない。見出しの成績は対照版だけの記録に
-- なる。候補版の腕の数字は、腕ごとに別に見る（docs/OPERATIONS.md §8.7 / §9-I）。
--
-- 今日の値は変わらない（本番実測: 全 113 行が variant = 'control'）。
-- 変わるのは「これから候補版を回したときに黙って混ざるかどうか」である。
--
-- 関数本体は書き写さずに差し替える。250 行ある関数本体を手で写すのはこのプロジェクトが
-- 実際に何度か壊した作業で（OPERATIONS §6.1）、ここで必要な変更は述語 1 つ
-- だけなので、生きている定義を読んで 1 箇所だけ差し替え、
-- **1 箇所でなければ中断する**。
--
-- （最初この行は「281 行」と書いていた。281 は 2026-09-08 のマイグレーション
--   ファイル全体の行数で、関数本体ではない。数え間違いというより、数えた対象が
--   違っていた。）

do $migration$
declare
  def text;
  anchor constant text := 'where a.shadow = false and a.preview = false';
  patched constant text := anchor || E'\n    -- 候補版の腕は見出しの記録に入れない（20260913140000）。\n'
    || '    and coalesce(a.variant, ''control'') = ''control''';
  hits int;
begin
  select pg_get_functiondef(p.oid) into def
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'performance_stats';

  if def is null then
    raise exception 'performance_stats not found — refusing to guess at its definition';
  end if;

  hits := (length(def) - length(replace(def, anchor, ''))) / length(anchor);
  if hits <> 1 then
    raise exception
      'expected exactly 1 occurrence of the base filter in performance_stats, found %', hits;
  end if;

  -- 既に当たっている場合は何もしない（再適用しても壊れない）。
  if position('a.variant' in def) > 0 then
    raise notice 'performance_stats already filters on variant; nothing to do';
    return;
  end if;

  execute replace(def, anchor, patched);
end
$migration$;

-- 候補版の腕を、腕ごとに・混ぜずに読むための最小の窓口。
-- 見出しの成績とは別の関数にしてある。同じ関数に足すと、呼ぶ側が
-- うっかり合計して「混ぜない」という約束がまた紙の上だけになる。
create or replace function public.variant_stats()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    jsonb_object_agg(v.variant, v.stats),
    '{}'::jsonb
  )
  from (
    select
      a.variant,
      jsonb_build_object(
        'rows', count(*),
        'waits', count(*) filter (where a.signal = 'WAIT'),
        -- 条件付き WAIT（#86）。claims が分母で、not_triggered はその中にいる。
        -- ここが「不在ではなく罰」になる唯一の場所なので、5 つとも出す。
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
        -- 相場の流れに乗っただけの主張がどれだけ混ざっているか。これが無いと
        -- triggered_right は「窓の間にどちらへ流れたか」を測った数字でしかない。
        'conditional_with_trend',
          count(*) filter (where a.conditional_wait->>'trend_at_call' = 'with_trend'),
        'conditional_against_trend',
          count(*) filter (where a.conditional_wait->>'trend_at_call' = 'against_trend'),
        'conditional_trend_unknown',
          count(*) filter (where a.conditional_wait->>'trend_at_call' = 'unknown'),
        -- 捨てた理由の内訳。出力の 8 割が捨てられる腕は走っていない腕である。
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
  'SECURITY DEFINER で service_role のみに grant してある。他の成績 RPC は authenticated にも '
  'grant されていて SECURITY DEFINER ではない（RLS で呼び手の行だけが見える）ので、**同じ扱いではない**。'
  'この関数は全ユーザーの行を横断して数えるため、意図的に厳しくしてある。'
  '※ この comment は 20260913160000 で上書きされる（当初「他の成績 RPC と同じ扱い」と書いたが偽だった）。';
