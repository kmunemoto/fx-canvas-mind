-- 20260913160000 の冪等ガードを踏んだ分の後始末。
--
-- あのファイルは当初ガードを**関数単位**で書いていた（「この関数はもう variant を
-- 含むか」）。loop_health は述語が2種類あるので、1種類目を当てた瞬間に関数が variant を
-- 含むようになり、2種類目が黙ってスキップされた。5箇所直すはずが3箇所で止まり、
-- しかも**成功として返った**。
--
-- 160000 側のガードはアンカー単位に直してある（replacement の出現数で判定する。
-- replacement はアンカー＋追記なので、アンカーの出現数では当たったかどうか分からない）。
-- なので**新規に再生する場合、このファイルは何もしない**。本番に対して実際に走った
-- 修正をリポジトリに残すために置いてある — 適用済みなのにファイルが無い移行は、
-- 「再生すれば本番と同じになる」という前提を黙って壊す。
--
-- 最後の assert が本体である。途中で止まっても成功で返らないようにする。

do $migration$
declare
  target record;
  def text;
  hits int;
begin
  for target in
    select * from (values
      ('loop_health',
       'and a.shadow = false and a.preview = false', 2,
       'and a.shadow = false and a.preview = false and coalesce(a.variant, ''control'') = ''control''')
    ) as t(func, anchor, expected, replacement)
  loop
    select pg_get_functiondef(p.oid) into def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = target.func;

    if def is null then
      raise exception 'function public.% not found', target.func;
    end if;

    hits := (length(def) - length(replace(def, target.replacement, ''))) / length(target.replacement);
    if hits = target.expected then
      raise notice '%: already filtered; skipping', target.func;
      continue;
    end if;

    hits := (length(def) - length(replace(def, target.anchor, ''))) / length(target.anchor);
    if hits <> target.expected then
      raise exception 'expected % occurrence(s) in %, found %', target.expected, target.func, hits;
    end if;

    execute replace(def, target.anchor, target.replacement);
  end loop;
end
$migration$;

do $assert$
declare
  n int;
begin
  select (select count(*) from regexp_matches(pg_get_functiondef(p.oid), 'coalesce\((a\.)?variant', 'g'))
    into n
  from pg_proc p join pg_namespace nsp on nsp.oid = p.pronamespace
  where nsp.nspname = 'public' and p.proname = 'loop_health';

  if n <> 5 then
    raise exception 'loop_health should carry 5 variant predicates, found %', n;
  end if;
end
$assert$;
