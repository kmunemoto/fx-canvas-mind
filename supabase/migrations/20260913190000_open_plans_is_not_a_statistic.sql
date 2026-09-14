-- open_plans は統計ではない。腕で絞ってはいけなかった。
--
-- 20260913160000 は loop_health の述語を5箇所すべて対照版限定にした。4箇所は正しい
-- （awaiting_review / reviewed / decided_episodes は「記録」であり、腕を混ぜてはいけない）。
-- **open_plans だけは違う。** あれは「いま自分がいくつ建てているか」を数える生の露出で、
-- 記録ではない。候補版の腕で建てた建玉は、候補版だろうと**実際に建っている**。
-- そこを腕で絞ると、画面は本人に「建玉は無い」と言う。自分の金についての嘘である。
--
-- 「統計は腕を混ぜるな」は正しい規則だが、規則を当てる対象を数えるときに
-- 「これは統計か、それとも今の事実か」を見ていなかった。5つ数えて5つとも当てた。
-- 数えるだけでは足りず、1つずつ何であるかを見る必要があった。

do $migration$
declare
  def text;
  anchor constant text :=
    E'    ''open_plans'', (\n      select count(*) from public.analyses\n      where user_id = auth.uid() and shadow = false and preview = false and coalesce(variant, ''control'') = ''control''';
  restored constant text :=
    E'    ''open_plans'', (\n      select count(*) from public.analyses\n      where user_id = auth.uid() and shadow = false and preview = false';
  hits int;
begin
  select pg_get_functiondef(p.oid) into def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'loop_health';

  if def is null then
    raise exception 'loop_health not found';
  end if;

  hits := (length(def) - length(replace(def, anchor, ''))) / length(anchor);
  if hits = 0 then
    raise notice 'open_plans is not arm-filtered; nothing to do';
  elsif hits <> 1 then
    raise exception 'expected 0 or 1 arm-filtered open_plans blocks, found %', hits;
  else
    execute replace(def, anchor, restored);
  end if;
end
$migration$;

do $assert$
declare
  n int;
begin
  -- 4 のはず: open_plans を戻したので 5 から 1 減る。
  select (select count(*) from regexp_matches(pg_get_functiondef(p.oid), 'coalesce\((a\.)?variant', 'g'))
    into n
  from pg_proc p join pg_namespace nsp on nsp.oid = p.pronamespace
  where nsp.nspname = 'public' and p.proname = 'loop_health';
  if n <> 4 then
    raise exception 'loop_health should carry 4 variant predicates after restoring open_plans, found %', n;
  end if;

  -- そして open_plans が腕を見ていないこと自体を表明する。
  if (select position('''open_plans'', (' in pg_get_functiondef(p.oid)) from pg_proc p
      join pg_namespace nsp on nsp.oid = p.pronamespace
      where nsp.nspname = 'public' and p.proname = 'loop_health') = 0 then
    raise exception 'open_plans block not found in loop_health';
  end if;
end
$assert$;
