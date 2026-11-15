#!/usr/bin/env bash
# The local test of src/install-v9.sql: the block that creates mc.pairs_v9 / mc.gold_v9 from the pieces in mc._src (README.md v9.7, docs/OPERATIONS.md 8.151).
#   the pieces (src/pieces.py) put into a scratch database with the statements that are sent to production -> each answer's md5 and length compared with the list
#   -> the block run in one transaction -> the functions it leaves compared with those of the migration file (definition and rights)
#   -> the block run with a piece changed by one character, a piece missing, only gold's text changed, no mc._src: it must stop and create nothing.
# And src/install-v9-full.sql (the two sources in the file itself, for the SQL Editor when the pieces cannot be sent), on a database that has the first version's
# functions: it replaces them (definition and rights = the migration files'), and with one character changed, only gold's text changed, the file cut short, or
# CR LF line ends, it stops and the first version's functions stay.
# Needs python3 and a scratch PostgreSQL (16 or later) whose user may create databases: MC_PSQL, default "psql -h 127.0.0.1 -p 54329 -U postgres".
# IT DROPS AND CREATES THE DATABASES mc9i AND mc9j THERE. Nothing here touches the project's database.
#   bash install.sh
set -uo pipefail
cd "$(dirname "$0")"
PSQL=${MC_PSQL:-psql -h 127.0.0.1 -p 54329 -U postgres}
WORK=${MC_WORK:-$(mktemp -d)}
M=../../../supabase/migrations
bad=0
say() { if [ "$1" = "$2" ]; then echo "ok   $3"; else echo "FAIL $3: got [$1], want [$2]"; bad=1; fi; }
fresh() {
  $PSQL -q -c "drop database if exists mc9i" -c "create database mc9i" 2> /dev/null
  $PSQL -d mc9i -q -v ON_ERROR_STOP=1 -f schema.sql -f $M/20261112120000_macd_rides.sql
  $PSQL -d mc9i -q -v ON_ERROR_STOP=1 -c "create schema if not exists mc; revoke all on schema mc from public, anon, authenticated; create table if not exists mc._src (name text primary key, txt text not null); revoke all on mc._src from public, anon, authenticated;"
  for n in p1 c1a c1b p2 c2a c2b c2c r g1 g2; do $PSQL -d mc9i -q -At -F ' ' -v ON_ERROR_STOP=1 -f "$WORK/pieces/$n.sql"; done
}
state() { $PSQL -d mc9i -At -c "select 'functions=' || (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'mc') || ' pieces=' || (to_regclass('mc._src') is not null)::text"; }
block() { $PSQL -d mc9i -q -1 -v ON_ERROR_STOP=1 -f ../src/install-v9.sql 2>&1 | grep -E 'ERROR' | sed 's/^.*ERROR: *//' | cut -c1-60; }

python3 -I ../src/pieces.py "$WORK/pieces" > "$WORK/pieces.txt"
echo "== the pieces go in, and each answer is the list's line"
got=$(fresh | awk '{printf "%s %s %s\n", $1, $3, $2}')
want=$(head -10 "$WORK/pieces.txt" | awk '{printf "%s %s %s\n", $1, $2, $3}')
say "$got" "$want" "ten pieces: name, chars, md5"
echo "== the block: the functions are the files'"
err=$(block); say "$err" "" "no error"
say "$(state)" "functions=2 pieces=false" "two functions, the pieces dropped"
say "$($PSQL -d mc9i -At -F ' ' -c "select 'pairs', length(prosrc), md5(prosrc) from pg_proc where oid = 'mc.pairs_v9(bigint,bigint)'::regprocedure")" "$(grep '^pairs' "$WORK/pieces.txt" | awk '{print $1, $2, $3}')" "md5(prosrc) of mc.pairs_v9"
say "$($PSQL -d mc9i -At -F ' ' -c "select 'gold', length(prosrc), md5(prosrc) from pg_proc where oid = 'mc.gold_v9(bigint,bigint)'::regprocedure")" "$(grep '^gold' "$WORK/pieces.txt" | awk '{print $1, $2, $3}')" "md5(prosrc) of mc.gold_v9"
$PSQL -q -c "drop database if exists mc9j" -c "create database mc9j" 2> /dev/null
$PSQL -d mc9j -q -v ON_ERROR_STOP=1 -f schema.sql -f $M/20261112120000_macd_rides.sql -f $M/20261112130000_morning_check_v9.sql -f $M/20261113140000_morning_check_v9_fix.sql
q="select string_agg(md5(pg_get_functiondef(p.oid)) || ' ' || coalesce(p.proacl::text, 'null'), ' / ' order by p.proname) || ' / ' || (select nspacl::text from pg_namespace where nspname = 'mc') from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'mc'"
say "$($PSQL -d mc9i -At -c "$q")" "$($PSQL -d mc9j -At -c "$q")" "definition and rights = the migration file's"
say "$($PSQL -d mc9i -At -c "select data->>'via' || ' ' || (data->>'sql_md5') from mc.pairs_v9(1794344400000, 1794430800000) where row_type = 'RUN'")" "function mc.pairs_v9 $(grep '^pairs' "$WORK/pieces.txt" | awk '{print $3}')" "mc.pairs_v9 runs and says its md5"
say "$($PSQL -d mc9i -At -c "select data->>'via' || ' ' || (data->>'sql_md5') from mc.gold_v9(1794344400000, 1794430800000) where row_type = 'RUN'")" "function mc.gold_v9 $(grep '^gold' "$WORK/pieces.txt" | awk '{print $3}')" "mc.gold_v9 runs and says its md5"
echo "== the block again (no pieces any more): it stops, the functions stay"
say "$(block)" "mc._src is missing: apply supabase/migrations/20261113140000" "stops"
say "$(state)" "functions=2 pieces=false" "nothing changed"
echo "== one character of one piece changed"
fresh > /dev/null; $PSQL -d mc9i -q -c "update mc._src set txt = replace(txt, '0.96::float8 * e.edge else', '0.97::float8 * e.edge else') where name = 'c1a'"
say "$(block | cut -c1-49)" "the pairs source differs from the repository: md5" "stops"
say "$(state)" "functions=0 pieces=true" "nothing created, the pieces kept"
echo "== a piece missing"
fresh > /dev/null; $PSQL -d mc9i -q -c "delete from mc._src where name = 'g2'"
say "$(block | cut -c1-48)" "the gold source differs from the repository: md5" "stops"
say "$(state)" "functions=0 pieces=true" "nothing created (the pairs' function, made first, is undone)"
echo "== only gold's text changed"
fresh > /dev/null; $PSQL -d mc9i -q -c "update mc._src set txt = txt || ' ' where name = 'g1'"
say "$(block | cut -c1-48)" "the gold source differs from the repository: md5" "stops"
say "$(state)" "functions=0 pieces=true" "nothing created"
echo "== the full block (src/install-v9-full.sql: the two sources in the file, no pieces), on a database that has the first version's functions"
FULL=../src/install-v9-full.sql
old() {
  $PSQL -q -c "drop database if exists mc9i" -c "create database mc9i" 2> /dev/null
  $PSQL -d mc9i -q -v ON_ERROR_STOP=1 -f schema.sql -f $M/20261112120000_macd_rides.sql -f $M/20261112130000_morning_check_v9.sql 2> /dev/null
}
md5s() { $PSQL -d mc9i -At -c "select string_agg(p.proname || ' ' || md5(p.prosrc), ' ' order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'mc'"; }
full() { PGOPTIONS="-c client_min_messages=warning" $PSQL -d mc9i -q -At -F ' ' -v ON_ERROR_STOP=1 -f "$1" 2>&1 | sed 's/^.*ERROR: *//' | cut -c1-60; }
OLDMD5="gold_v9 d687c0396bfaeff902465babc1d2404a pairs_v9 2341115ffd83c86d0f8d566deea0c34d"
NEWMD5="gold_v9 $(grep '^gold' "$WORK/pieces.txt" | awk '{print $3}') pairs_v9 $(grep '^pairs' "$WORK/pieces.txt" | awk '{print $3}')"
old; say "$(md5s)" "$OLDMD5" "before: the first version's functions"
say "$(full $FULL)" "$(printf 'installed gold_v9 %s %s\ninstalled pairs_v9 %s %s' $(grep '^gold' "$WORK/pieces.txt" | awk '{print $3, $2}') $(grep '^pairs' "$WORK/pieces.txt" | awk '{print $3, $2}'))" "runs; its last select shows the new md5 and length"
say "$(md5s)" "$NEWMD5" "after: the new functions"
say "$($PSQL -d mc9i -At -c "$q")" "$($PSQL -d mc9j -At -c "$q")" "definition and rights = the migration files'"
say "$($PSQL -d mc9i -At -c "select data->>'via' || ' ' || (data->>'sql_md5') from mc.gold_v9(1794344400000, 1794430800000) where row_type = 'RUN'")" "function mc.gold_v9 $(grep '^gold' "$WORK/pieces.txt" | awk '{print $3}')" "mc.gold_v9 runs and says its md5"
say "$(full $FULL | head -1)" "installed gold_v9 $(grep '^gold' "$WORK/pieces.txt" | awk '{print $3, $2}')" "run twice: the same"
echo "== the full block changed on the way: it stops, the first version's functions stay"
old; sed 's/0\.96::float8 \* e\.edge else/0.97::float8 * e.edge else/' $FULL > "$WORK/full-changed.sql"
say "$(cmp -s $FULL "$WORK/full-changed.sql" && echo same || echo changed)" "changed" "(one character of the shared text changed)"
say "$(full "$WORK/full-changed.sql" | head -1 | cut -c1-49)" "the pairs source differs from the repository: md5" "stops"
say "$(md5s)" "$OLDMD5" "nothing changed"
old; awk 'BEGIN{n=0} /^\$src\$;$/{n++} {print} n==1 && !done {getline; sub(/with recursive/, "with  recursive"); print; done=1}' $FULL > "$WORK/full-gold.sql"
say "$(cmp -s $FULL "$WORK/full-gold.sql" && echo same || echo changed)" "changed" "(only gold's text changed)"
say "$(full "$WORK/full-gold.sql" | head -1 | cut -c1-48)" "the gold source differs from the repository: md5" "stops"
say "$(md5s)" "$OLDMD5" "nothing changed (the pairs' function, made after the checks, is not made)"
old; head -c 60000 $FULL > "$WORK/full-cut.sql"
say "$(full "$WORK/full-cut.sql" | grep -c 'unterminated dollar-quoted string')" "1" "cut short: an error"
say "$(md5s)" "$OLDMD5" "nothing changed"
old; sed 's/$/\r/' $FULL > "$WORK/full-crlf.sql"
say "$(full "$WORK/full-crlf.sql" | head -1 | cut -c1-49)" "the pairs source differs from the repository: md5" "CR LF line ends (a paste may give them): stops"
say "$(md5s)" "$OLDMD5" "nothing changed"
$PSQL -q -c "drop database if exists mc9i" -c "create database mc9i" 2> /dev/null
$PSQL -d mc9i -q -v ON_ERROR_STOP=1 -f schema.sql -f $M/20261112120000_macd_rides.sql
full $FULL > /dev/null; say "$(md5s)" "$NEWMD5" "on a database without the schema mc: the new functions"
$PSQL -q -c "drop database if exists mc9i" -c "drop database if exists mc9j"
[ $bad = 0 ] && echo "install: all as expected" || { echo "install: SOMETHING DIFFERS"; exit 1; }
