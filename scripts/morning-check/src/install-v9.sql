-- #397 (docs §8.150, §8.151): the morning check of the MACD ride's e-mails (scripts/morning-check, v9) as two read-only functions.
--
-- The functions' sources are the repository's scripts/morning-check/pairs-v9.fn.sql and gold-v9.fn.sql, byte for byte: the same text as in
-- supabase/migrations/20261113140000_morning_check_v9_fix.sql. That file is some 85,000 characters, too long to be typed into one tool call without slips,
-- so the sources were sent to the database in ten pieces (table mc._src), each checked there by md5 and length against the repository's.
-- This block puts the pieces together, creates the functions only if each whole text has the md5 of the repository's file,
-- checks md5(prosrc) of what was created, and drops the pieces. Any difference raises an exception and nothing is kept.
-- Without mc._src this block cannot run: apply the repository's migration file instead (it creates the same two functions).
--
-- Read only: language sql, stable, one WITH ... SELECT each. The schema mc is not one the API serves; anon and authenticated have no right on it or on the functions.
-- To take them away again: drop schema mc cascade;
create schema if not exists mc;
revoke all on schema mc from public, anon, authenticated;
do $do$
declare
  v_pairs text;
  v_gold text;
  v_tail text;
  v_head constant text := '(p_start bigint, p_end bigint) returns table (row_type text, instrument text, bar_open_utc text, side text, verdict text, data json) language sql stable set search_path = '''' as ';
begin
  if to_regclass('mc._src') is null then
    raise exception 'mc._src is missing: apply supabase/migrations/20261113140000_morning_check_v9_fix.sql of the repository instead';
  end if;
  select string_agg(s.txt, '' order by o.n) into v_pairs
  from unnest(array['p1', 'c1a', 'c1b', 'p2', 'c2a', 'c2b', 'c2c', 'r']) with ordinality o(name, n) join mc._src s on s.name = o.name;
  select string_agg(s.txt, '' order by o.n) into v_gold
  from unnest(array['g1', 'c1a', 'c1b', 'g2', 'c2a', 'c2b', 'c2c']) with ordinality o(name, n) join mc._src s on s.name = o.name;
  select replace(replace(s.txt, 'pairs.sql v9', 'gold.sql v9'), 'mc.pairs_v9', 'mc.gold_v9') into v_tail from mc._src s where s.name = 'r';
  v_gold := v_gold || v_tail;
  if md5(v_pairs) is distinct from '72a3e67a2ff93fd4b77c1588141feb17' or length(v_pairs) is distinct from 43705 then
    raise exception 'the pairs source differs from the repository: md5 %, % chars', md5(v_pairs), length(v_pairs);
  end if;
  if md5(v_gold) is distinct from 'a6c423b0a3a1906f1ddb01d7eda8de99' or length(v_gold) is distinct from 41004 then
    raise exception 'the gold source differs from the repository: md5 %, % chars', md5(v_gold), length(v_gold);
  end if;
  if position('$mc$' in v_pairs) > 0 or position('$mc$' in v_gold) > 0 then
    raise exception 'a source holds the dollar quote';
  end if;
  execute 'create or replace function mc.pairs_v9' || v_head || '$mc$' || v_pairs || '$mc$';
  execute 'revoke all on function mc.pairs_v9(bigint, bigint) from public, anon, authenticated';
  execute 'create or replace function mc.gold_v9' || v_head || '$mc$' || v_gold || '$mc$';
  execute 'revoke all on function mc.gold_v9(bigint, bigint) from public, anon, authenticated';
  if (select md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = to_regprocedure('mc.pairs_v9(bigint,bigint)')) is distinct from '72a3e67a2ff93fd4b77c1588141feb17' then
    raise exception 'mc.pairs_v9: the stored source differs from the repository';
  end if;
  if (select md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = to_regprocedure('mc.gold_v9(bigint,bigint)')) is distinct from 'a6c423b0a3a1906f1ddb01d7eda8de99' then
    raise exception 'mc.gold_v9: the stored source differs from the repository';
  end if;
  drop table mc._src;
end
$do$;
