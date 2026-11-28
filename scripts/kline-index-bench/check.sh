#!/usr/bin/env bash
# The local test of supabase/migrations/20261128130000_gmo_kline_index.sql (public.gmo_kline_index, signal-alerts v43: the
# index of the kept 5-minute files that the five pairs' 5-minute chart checks GMO's answers against, kline-direct.ts):
#   the migration applied (twice) on a scratch database made from ../morning-check/bench/schema.sql (the roles and
#   public.gmo_kline_files) and grants.sql (the grants it assumes, a model)
#   -> the function's catalog row: stable ('s'), security invoker, its search_path empty, its arguments and columns,
#      run by service_role only (anon and authenticated refused)
#   -> some 330 made-up GMO-shaped files (bodies.ts gen; prices made up) put in; the function run by service_role in a
#      read-only transaction, the table the same after it; each row compared with kline-direct.ts klineDigest (bodies.ts
#      compare, deno): every sound file's (n, h) equal, an odd copy agreeing with a GMO-like twin only when the walk
#      reads the same bars from both, no row for a file that is not status 0 with a list, before p_since, of another
#      interval or of a symbol not asked for
#   -> row level security as grants.sql models the project's (on, no policy, service_role BYPASSRLS): anon given SELECT
#      and EXECUTE gets no row, and service_role without BYPASSRLS none either (no error), which the row counts catch
#   -> the bench's own teeth: the function changed on purpose (chr(13) for chr(10), the open read for the close, no
#      status check, the revoke left out) must be caught.
# Needs deno and a scratch PostgreSQL (16 or later) whose user may create databases: KI_PSQL, default
# "psql -h 127.0.0.1 -p 54339 -U postgres". Not run in CI.
# IT DROPS AND CREATES ONLY ITS OWN SCRATCH DATABASES klidx AND klidx_t THERE (and makes the roles anon, authenticated
# and service_role there if they are missing). It touches no project database: it has no project's address or key.
#   bash check.sh
set -uo pipefail
cd "$(dirname "$0")"
PSQL=${KI_PSQL:-psql -h 127.0.0.1 -p 54339 -U postgres}
WORK=${KI_WORK:-$(mktemp -d)}
MIG=../../supabase/migrations/20261128130000_gmo_kline_index.sql
SCHEMA=../morning-check/bench/schema.sql
FN="public.gmo_kline_index(text, text[], text)"
CALL="select s, p, d, n, h from public.gmo_kline_index('5min', array['USD_JPY','EUR_JPY','AUD_JPY','EUR_USD','AUD_USD'], '20261103')"
bad=0
say() { if [ "$1" = "$2" ]; then echo "ok   $3"; else echo "FAIL $3: got [$1], want [$2]"; bad=1; fi; }
fresh() { # a scratch database $1 with the migration file $2 applied
  $PSQL -q -c "drop database if exists $1" -c "create database $1" 2> /dev/null
  PGOPTIONS="-c client_min_messages=warning" $PSQL -d "$1" -q -v ON_ERROR_STOP=1 -f $SCHEMA -f grants.sql -f "$2" 2>&1
}
q() { $PSQL -d "$1" -At -c "$2" 2>&1; }
rows() { # the function's rows ($1 the database), run by service_role in a read-only transaction
  $PSQL -d "$1" -q -At -F $'\t' -v ON_ERROR_STOP=1 -c "begin transaction read only" -c "set local role service_role" -c "$CALL" -c "commit" 2>&1
}

echo "== the migration on a scratch database (schema.sql's roles and table, grants.sql)"
say "$(fresh klidx $MIG)" "" "applies with ON_ERROR_STOP, no message"
say "$(PGOPTIONS="-c client_min_messages=warning" $PSQL -d klidx -q -v ON_ERROR_STOP=1 -f $MIG 2>&1)" "" "applies again (create or replace)"
echo "== the function's catalog row"
say "$(q klidx "select provolatile from pg_proc where oid = '$FN'::regprocedure")" "s" "provolatile 's' (stable)"
say "$(q klidx "select prosecdef from pg_proc where oid = '$FN'::regprocedure")" "f" "security invoker (prosecdef false)"
say "$(q klidx "select proconfig::text from pg_proc where oid = '$FN'::regprocedure")" '{"search_path=\"\""}' "its search_path empty"
say "$(q klidx "select l.lanname from pg_proc p join pg_language l on l.oid = p.prolang where p.oid = '$FN'::regprocedure")" "sql" "language sql"
say "$(q klidx "select proretset::text || ' ' || array_to_string(proargnames, ',') || ' ' || array_to_string(proargmodes, ',') from pg_proc where oid = '$FN'::regprocedure")" "true p_interval,p_symbols,p_since,s,p,d,n,h i,i,i,t,t,t,t,t" "a set of (s, p, d, n, h) from (p_interval, p_symbols, p_since)"
say "$(q klidx "select pg_get_function_result('$FN'::regprocedure)")" "TABLE(s text, p text, d text, n integer, h text)" "its columns' types"
say "$(q klidx "select prosrc ~* '\\m(insert|update|delete|merge|truncate|copy)\\M' from pg_proc where oid = '$FN'::regprocedure")" "f" "its source has no insert, update, delete, merge, truncate or copy"
say "$(q klidx "select proacl::text from pg_proc where oid = '$FN'::regprocedure")" "{postgres=X/postgres,service_role=X/postgres}" "rights: its owner and service_role only (no PUBLIC, though grants.sql's defaults gave anon and authenticated)"
for r in anon authenticated; do
  say "$(q klidx "select has_function_privilege('$r', '$FN', 'execute')")" "f" "$r may not run it"
  say "$($PSQL -d klidx -At -c "set role $r" -c "$CALL" 2>&1 | grep -o 'permission denied for function gmo_kline_index')" "permission denied for function gmo_kline_index" "$r is refused when it tries"
done
say "$(q klidx "select has_function_privilege('service_role', '$FN', 'execute')")" "t" "service_role may run it"
say "$($PSQL -d klidx -q -At -c "set role service_role" -c "select count(*) from public.gmo_kline_index('5min', array['USD_JPY'], '')" 2>&1)" "0" "service_role runs it (the table empty: no row)"

echo "== made-up GMO-shaped files (bodies.ts gen), the function run by service_role in a read-only transaction"
deno run --allow-read --allow-write="$WORK" bodies.ts gen "$WORK" || bad=1
say "$($PSQL -d klidx -q -v ON_ERROR_STOP=1 -f "$WORK/load.sql" 2>&1)" "" "the files go in"
STATE="select count(*) || ' ' || md5(string_agg(symbol || '|' || price_type || '|' || interval || '|' || date_key || '|' || body::text || '|' || fetched_at::text, E'\n' order by symbol, price_type, interval, date_key)) from public.gmo_kline_files"
before=$(q klidx "$STATE")
say "${before%% *}" "331" "331 files in the table"
rows klidx > "$WORK/rows.tsv"
say "$(grep -v -P '^[A-Z_]+\t(BID|ASK)\t[0-9]{8}\t[0-9]+\t[0-9a-f]{16}$' "$WORK/rows.tsv" | head -3)" "" "the call: no error in a read-only transaction, every line a row (s, p, d, n, h)"
say "$(q klidx "$STATE")" "$before" "the table the same after it (its count, the md5 of every row with fetched_at)"
say "$(wc -l < "$WORK/rows.tsv" | tr -d ' ')" "295" "295 rows (281 sound files, 14 odd copies)"
say "$(LC_ALL=C sort -t $'\t' -k1,1 -k2,2 -k3,3 -c "$WORK/rows.tsv" 2>&1 && echo sorted)" "sorted" "ordered by symbol, price_type, date_key (this database's collation, C.UTF-8 here)"
echo "-- each row against kline-direct.ts (bodies.ts compare)"
deno run --allow-read bodies.ts compare "$WORK" "$WORK/rows.tsv" || bad=1
say "$(grep -P '^USD_JPY\tBID\t20261231\t' "$WORK/rows.tsv" | cut -f5)" "$(deno eval "import { klineDigest } from './../../supabase/functions/signal-alerts/kline-direct.ts'; console.log(await klineDigest({ status: 0, data: [{ openTime: '１', open: 'é', high: '\u{1F600}', low: '終値', close: 'x' }] }))")" "non-ASCII fields: the same digest (UTF-8 both sides)"
say "$($PSQL -d klidx -q -At -c "set role service_role" -c "select n || ' ' || h from public.gmo_kline_index('5min', array['USD_JPY'], '20261231')" 2>&1)" "1 $(grep -P '^USD_JPY\tBID\t20261231\t' "$WORK/rows.tsv" | cut -f5)" "p_since and p_symbols narrow it (one symbol, one day)"
echo "-- row level security (grants.sql's model: on, no policy, service_role BYPASSRLS)"
say "$(q klidx "select c.relrowsecurity::text || ' ' || (select count(*) from pg_policy p where p.polrelid = c.oid) from pg_class c where c.oid = 'public.gmo_kline_files'::regclass")" "true 0" "the table's row level security on, no policy"
say "$(q klidx "select rolbypassrls from pg_roles where rolname = 'service_role'")" "t" "service_role bypasses it (so the 295 rows above)"
say "$($PSQL -d klidx -q -At -v ON_ERROR_STOP=1 -c "begin" -c "grant select on public.gmo_kline_files to anon" -c "grant execute on function $FN to anon" -c "set local role anon" -c "select count(*) from ($CALL) x" -c "rollback" 2>&1)" "0" "anon given SELECT and EXECUTE (rolled back) still gets no row: no policy lets it"
say "$($PSQL -d klidx -q -At -v ON_ERROR_STOP=1 -c "begin" -c "alter role service_role nobypassrls" -c "set local role service_role" -c "select count(*) from ($CALL) x" -c "rollback" 2>&1)" "0" "service_role without BYPASSRLS (rolled back): no row and no error, which the 295 rows above would catch"
say "$(q klidx "select rolbypassrls from pg_roles where rolname = 'service_role'")" "t" "service_role's BYPASSRLS back after that rollback"

echo "== the bench's teeth: the function changed on purpose must be caught"
teeth() { # $1 what, $2 the changed migration file
  say "$(cmp -s $MIG "$2" && echo same || echo changed)" "changed" "($1)"
  fresh klidx_t "$2" > /dev/null
  $PSQL -d klidx_t -q -v ON_ERROR_STOP=1 -f "$WORK/load.sql"
  rows klidx_t > "$WORK/rows-t.tsv"
  deno run --allow-read bodies.ts compare "$WORK" "$WORK/rows-t.tsv" fail > "$WORK/compare-t.txt" 2>&1
  say "$?" "0" "$1: the comparison fails ($(grep -c '^FAIL' "$WORK/compare-t.txt") FAIL lines: $(grep '^FAIL' "$WORK/compare-t.txt" | head -1 | cut -c6-80))"
}
sed 's/chr(10)/chr(13)/' $MIG > "$WORK/mig-cr.sql"; teeth "chr(13) between the bars" "$WORK/mig-cr.sql"
sed "s/t.e ->> 'close'), chr(10)/t.e ->> 'open'), chr(10)/" $MIG > "$WORK/mig-open.sql"; teeth "the open read for the close" "$WORK/mig-open.sql"
sed "/and f.body -> 'status' = '0'::jsonb/d" $MIG > "$WORK/mig-status.sql"; teeth "no status check" "$WORK/mig-status.sql"
grep -v '^revoke all on function' $MIG > "$WORK/mig-norevoke.sql"
say "$(cmp -s $MIG "$WORK/mig-norevoke.sql" && echo same || echo changed)" "changed" "(the revoke left out)"
fresh klidx_t "$WORK/mig-norevoke.sql" > /dev/null
say "$(q klidx_t "select has_function_privilege('anon', '$FN', 'execute')::text || ' ' || has_function_privilege('authenticated', '$FN', 'execute')::text")" "true true" "the revoke left out: anon and authenticated could run it (the rights checks above can fail)"
$PSQL -q -c "drop database if exists klidx" -c "drop database if exists klidx_t"
echo "work files: $WORK"
[ $bad = 0 ] && echo "check: all as expected" || { echo "check: SOMETHING DIFFERS"; exit 1; }
