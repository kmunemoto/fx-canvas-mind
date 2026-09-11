-- #68b の後半 — 成績が「誰の成績なのか」を言わせる。
--
-- 直前のマイグレーションで public.analyses.model を足した。列があるだけでは何も防げない。
-- 防ぎたいのは「モデルを入れ替えたあと、混ざった成績が混ざったと分からないまま読まれる」
-- ことで、そのためには読む側の画面に出ている必要がある。
--
-- performance_stats に列を通す案は採らなかった。あの関数は 250 行の再帰 CTE で、
-- mine → ordered → episodes → tagged → agg → shaped と6段を通す。正しく動いているものに
-- 列を1本通すために6箇所を触るのは、得られるものに対して壊す確率が高い。
--
-- 代わりに、答えたい問いだけを持つ小さい関数を置く。「この成績は誰が書いたものか」。
-- performance_stats は成績を出し、こちらは出自を出す。役割が分かれているほうが、
-- どちらも読みやすい。
--
-- 母集団の絞り込みは performance_stats の mine と同一にしてある（shadow/preview 除外、
-- plan_contract は coalesce で legacy 既定）。ここがずれると、同じ画面の2つの数字が
-- 別の集団を指すことになり、それはこの関数が防ごうとしている混同そのものである。
--
-- SECURITY INVOKER。public.analyses の RLS がこの関数を呼び出し元1アカウントに絞る
-- 唯一の仕組みで、本文に user_id = auth.uid() は意図的に書かない。

create or replace function public.model_mix(live_contract text default 'market_v1')
returns jsonb
language sql
stable
security invoker
set search_path to 'public', 'pg_temp'
as $function$
with mine as (
  select a.model, a.outcome, a.signal, a.created_at
  from public.analyses a
  where a.shadow = false
    and a.preview = false
    and coalesce(a.plan_contract, 'entry_chosen_v1') = live_contract
),
per_model as (
  select
    m.model,
    count(*)::int as calls,
    count(*) filter (where m.signal in ('BUY', 'SELL'))::int as traded,
    -- 「決着した」は勝ちと負けだけ。混ざったかどうかを判定するときに効くのは、
    -- 成績に実際に入っている件数であって、呼ばれた回数ではない。
    count(*) filter (where m.outcome in ('win', 'loss'))::int as settled,
    min(m.created_at) as first_at,
    max(m.created_at) as last_at
  from mine m
  group by m.model
)
select jsonb_build_object(
  'contract', live_contract,
  'calls', (select coalesce(sum(calls), 0)::int from per_model),
  'models', coalesce((
    select jsonb_agg(jsonb_build_object(
      'model', p.model,
      'calls', p.calls,
      'traded', p.traded,
      'settled', p.settled,
      'first_at', p.first_at,
      'last_at', p.last_at
    ) order by p.settled desc, p.calls desc, p.model nulls last)
    from per_model p
  ), '[]'::jsonb),
  -- 決着した取引を持つモデルが2つ以上あれば、成績はすでに混ざっている。
  -- 呼ばれただけのモデルは成績を動かしていないので、ここでは数えない。
  'pooled', (select count(*) from per_model where settled > 0 and model is not null) > 1,
  'models_with_settled', (select count(*)::int from per_model where settled > 0 and model is not null),
  -- model が NULL の行。「記録が無い」であって「既定のモデルだった」ではない。
  -- #60 より前の行は送信プロンプトごと残っていないので、埋めることはできない。
  'unrecorded', (select coalesce(sum(calls), 0)::int from per_model where model is null),
  'unrecorded_settled', (select coalesce(sum(settled), 0)::int from per_model where model is null)
);
$function$;

comment on function public.model_mix(text) is
  'この契約の成績を書いたモデルの内訳。pooled が true なら、決着済みの取引を持つモデルが'
  '2つ以上あり、成績はすでに混ざっている。unrecorded はモデルの記録が無い行の数で、'
  '「既定のモデルだった」という意味ではない。SECURITY INVOKER、RLS で呼び出し元1アカウントに絞られる。';

revoke all on function public.model_mix(text) from public;
revoke all on function public.model_mix(text) from anon;
grant execute on function public.model_mix(text) to authenticated;
