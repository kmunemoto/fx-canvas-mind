#!/usr/bin/env bash
# The local PostgreSQL check of signal-alerts v42's migration, supabase/migrations/20261122010000_stockmacd_any_share.sql
# (research/allstocks-prod-spec.md section 9, "Local PostgreSQL"), on a scratch PostgreSQL (16 or later) whose user may
# create databases and roles: V42_PSQL, default "psql -h 127.0.0.1 -p 54329" (trust auth, as user postgres).
#   the migration on a table built by the repository's own migrations (from-migrations.py) with rows of every current
#     pair; its pair check against the app's isStockSymbol (live-chart/stocks.ts, through pair-inputs.ts) on made-up
#     inputs, under three database collations (C, libc C.utf8, ICU en-US); stockmacd_follow at 49 / 50 / 51 and with an
#     empty or non-array p_pairs; two sessions at once (the first holds its transaction open after the call, the second
#     waits on the lock and then refuses); the call under repeatable read and serializable refused; the daily note
#     cleared for a share nobody followed and kept for one followed; authenticated and anon cannot execute either
#     function or read the table, service_role can (with Supabase's default rights in schema public copied by
#     schema.sql, so that these lines fail when one of the migration's revokes is missing).
# Made-up rows only (made-up users from gen_random_uuid(), made-up symbols and names). It prints one PASS or FAIL line a
# check and exits non-zero on any FAIL. IT DROPS AND CREATES THE DATABASES v42_check, v42_check_cutf8 AND v42_check_icu
# THERE, and drops them when done; the roles anon, authenticated, service_role and authenticator are made when missing
# (stand-ins for Supabase's) and those it made are dropped when done. Nothing here touches the project's database.
#   bash scripts/stockmacd-v42/db-check.sh
set -uo pipefail
cd "$(dirname "$0")"
PSQL=${V42_PSQL:-psql -h 127.0.0.1 -p 54329}
SU="$PSQL -U postgres"
# (the notices of the older files' "if exists" statements are not checks)
export PGOPTIONS="-c client_min_messages=warning"
DENO=${DENO:-$(command -v deno || echo /opt/node22/bin/deno)}
MIG=../../supabase/migrations/20261122010000_stockmacd_any_share.sql
DB=v42_check
DBS=(v42_check v42_check_cutf8 v42_check_icu)
WORK=$(mktemp -d)
bad=0
made_roles=()

pass() { echo "PASS $1"; }
fail() { echo "FAIL $1"; bad=1; }
say() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1: got [$2], want [$3]"; fi; }
cleanup() {
  jobs -p | xargs -r kill 2> /dev/null
  for d in "${DBS[@]}"; do $SU -q -c "drop database if exists $d" 2> /dev/null; done
  for r in "${made_roles[@]}"; do $SU -q -c "drop role if exists $r" 2> /dev/null; done
  rm -rf "$WORK"
}
trap cleanup EXIT

# one statement (or several) as postgres in the check's database, its rows unaligned; errors in the output
q() { $SU -d "$DB" -q -At -v ON_ERROR_STOP=1 -c "$1" 2>&1; }
# as PostgREST reaches the database: the login role authenticator, then the request's role
as() { $PSQL -U authenticator -d "$DB" -q -At -v ON_ERROR_STOP=1 -c "set role $1" -c "$2" 2>&1; }

echo "== stand-ins for Supabase's roles"
for r in anon authenticated service_role; do
  if [ "$($SU -At -c "select count(*) from pg_roles where rolname = '$r'")" = "0" ]; then
    $SU -q -c "create role $r nologin" && made_roles+=("$r")
  fi
done
if [ "$($SU -At -c "select count(*) from pg_roles where rolname = 'authenticator'")" = "0" ]; then
  $SU -q -c "create role authenticator noinherit login" -c "grant anon, authenticated, service_role to authenticator" && made_roles=("authenticator" "${made_roles[@]}")
fi
echo "made here: ${made_roles[*]:-none}"

# a fresh database ($1) of the given locale options ($2): the stand-ins, the subscriptions table as the repository's
# migrations leave it, made-up users, and a row of every current pair (the pair check's 43 values before v42)
PAIRS=$(python3 -I from-migrations.py pairs | sed "s/.*/'&'/" | paste -sd, -)
build_users() {
  for n in u0 u1 u2 probe; do
    $SU -d "$1" -q -v ON_ERROR_STOP=1 -c "with u as (insert into auth.users default values returning id) insert into public.v42_users (name, id) select '$n', id from u" || return 1
  done
}
build() {
  $SU -q -c "drop database if exists $1" -c "create database $1 template template0 encoding 'UTF8' $2" || return 1
  $SU -d "$1" -q -v ON_ERROR_STOP=1 -f schema.sql || return 1
  python3 -I from-migrations.py table | $SU -d "$1" -q -v ON_ERROR_STOP=1 || return 1
  build_users "$1" || return 1
  $SU -d "$1" -q -v ON_ERROR_STOP=1 <<SQL || return 1
-- every current pair: u0 on its chart (the FX pairs' 'macdx' 1-hour, gold's 'sweepx' 1-minute, a share's 'stockmacd'
-- 15-minute); u1 the shares' old '1h' rows (v40's) and the FX pairs' 'rsi_sar' 15-minute
insert into public.signal_alert_subscriptions (user_id, pair, "interval", rule, lang)
  select (select id from public.v42_users where name = 'u0'), p,
         case when p = 'XAU/USD' then '1min' when p like '%/%' then '1h' else '15min' end,
         case when p = 'XAU/USD' then 'sweepx' when p like '%/%' then 'macdx' else 'stockmacd' end, 'ja'
  from unnest(array[$PAIRS]) p;
insert into public.signal_alert_subscriptions (user_id, pair, "interval", rule, lang)
  select (select id from public.v42_users where name = 'u1'), p,
         case when p like '%/%' then '15min' else '1h' end, case when p like '%/%' then 'rsi_sar' else 'stockmacd' end, 'en'
  from unnest(array[$PAIRS]) p where p <> 'XAU/USD';
SQL
}

echo "== the migration on the table the repository's migrations leave, with rows of every current pair"
build "$DB" "" || { fail "the check's database could not be built"; exit 1; }
say "the table before v42: 43 current pair values, each with a row" "$(q "select count(distinct pair) || ' ' || count(*) from public.signal_alert_subscriptions")" "43 85"
before=$(q "select md5(string_agg(t::text, '|' order by t.id)) from public.signal_alert_subscriptions t")
err=$($SU -d "$DB" -q -v ON_ERROR_STOP=1 -f "$MIG" 2>&1 | grep -v "NOTICE:"; exit "${PIPESTATUS[0]}") || err="$err (exit $?)"
say "the migration applies with no error" "$err" ""
say "no row is changed by it (the rows' md5 before and after)" "$(q "select md5(string_agg(t::text, '|' order by t.id)) from public.signal_alert_subscriptions t")" "$before"
err=$($SU -d "$DB" -q -v ON_ERROR_STOP=1 -f "$MIG" 2>&1 | grep -v "NOTICE:"; exit "${PIPESTATUS[0]}") || err="$err (exit $?)"
say "applied a second time, it is still no error (if exists / or replace; its notices aside)" "$err" ""
def=$(q "select pg_get_constraintdef(oid) from pg_constraint where conname = 'signal_alert_subscriptions_pair_check'")
miss=""
for p in $(python3 -I from-migrations.py pairs | grep /); do case "$def" in *"'$p'"*) ;; *) miss="$miss $p" ;; esac; done
for pat in "'^[A-Z]{1,5}(-[A-Z]{1,2})?\$'" "'^[0-9][0-9A-Z]{3}[.]T\$'"; do case "$def" in *"$pat"*) ;; *) miss="$miss $pat" ;; esac; done
case "$def" in *"'NVDA'"* | *"'7203.T'"*) miss="$miss (a share literal left)" ;; esac
say "the pair check holds the 21 FX and gold literals and the two patterns, no share literal" "${miss# }" ""
say "the table's columns" "$(q "select string_agg(column_name || ':' || data_type, ',' order by ordinal_position) from information_schema.columns where table_schema = 'public' and table_name = 'signal_alert_stocks'")" \
  "pair:text,name:text,checked_at:timestamp with time zone,last_bar_at:timestamp with time zone,bars:integer,noted_at:timestamp with time zone"
say "signal_alert_stocks: row level security on, no policy" "$(q "select relrowsecurity::text || ' ' || (select count(*) from pg_policy where polrelid = c.oid) from pg_class c where oid = 'public.signal_alert_stocks'::regclass")" "true 0"
say "signal_alert_stocks: a name of 101 characters, an empty name and bars below 0 are refused; 100 characters (multibyte) is taken" \
  "$($SU -d "$DB" -q -At <<'SQL' 2>&1
create function pg_temp.takes(p text, n text, b integer) returns text language plpgsql as $f$
begin
  begin
    insert into public.signal_alert_stocks (pair, name, bars) values (p, n, b);
    raise exception 'v42 probe: undo';
  exception
    when check_violation then return 'refused';
    when raise_exception then return 'taken';
  end;
end $f$;
select string_agg(x, ',' order by k) from (values
  (1, pg_temp.takes('ZZA', repeat('名', 101), null)),
  (2, pg_temp.takes('ZZA', '', null)),
  (3, pg_temp.takes('ZZA', null, -1)),
  (4, pg_temp.takes('ZZA', repeat('名', 100), 0))
) v(k, x);
SQL
)" "refused,refused,refused,taken"

echo "== the pair check against isStockSymbol (live-chart/stocks.ts) on made-up inputs"
VALUES=$("$DENO" run --allow-read pair-inputs.ts) || { fail "pair-inputs.ts did not run"; VALUES=""; }
n_in=$(printf '%s\n' "$VALUES" | grep -c "convert_from")
probe_off() {
  $SU -d "$1" -q -At <<SQL 2>&1
create function pg_temp.accepts(t text, p text) returns boolean language plpgsql as \$f\$
begin
  begin
    if t = 'sub' then
      insert into public.signal_alert_subscriptions (user_id, pair, "interval", rule, lang)
        values ((select id from public.v42_users where name = 'probe'), p, '15min', 'stockmacd', 'ja');
    else
      insert into public.signal_alert_stocks (pair) values (p);
    end if;
    raise exception 'v42 probe: undo';
  exception
    when check_violation then return false;
    when raise_exception then return true;
  end;
end \$f\$;
select count(*) || ' inputs; not as the app: ' || coalesce(string_agg(label, ' ') filter (where off), 'none')
from (
  select label, (pg_temp.accepts('sub', v) is distinct from sub) or (pg_temp.accepts('stock', v) is distinct from stock) as off
  from $VALUES t(label, sub, stock, v)
) x;
SQL
}
say "the pair checks (subscriptions, signal_alert_stocks) under the collation C" "$(probe_off "$DB")" "$n_in inputs; not as the app: none"
for spec in "v42_check_cutf8|locale 'C.utf8'|libc C.utf8" "v42_check_icu|locale_provider icu icu_locale 'en-US' locale 'C.utf8'|ICU en-US"; do
  IFS='|' read -r d opts label <<< "$spec"
  if build "$d" "$opts" > /dev/null 2>&1 && $SU -d "$d" -q -v ON_ERROR_STOP=1 -f "$MIG" > /dev/null 2>&1; then
    say "the pair checks under the database collation $label" "$(probe_off "$d")" "$n_in inputs; not as the app: none"
  else
    fail "the pair checks under $label: its database could not be built"
  fi
done

echo "== stockmacd_follow at 49 / 50 / 51, and its arguments"
U0=$(q "select id from public.v42_users where name = 'u0'")
U1=$(q "select id from public.v42_users where name = 'u1'")
U2=$(q "select id from public.v42_users where name = 'u2'")
# u0 follows n made-up shares on '15min' (XAA, XAB, ...) and 5 others on '1h' only (not counted); signal_alert_stocks empty
reset_to() {
  q "delete from public.signal_alert_subscriptions where rule = 'stockmacd'; delete from public.signal_alert_stocks;
     insert into public.signal_alert_subscriptions (user_id, pair, \"interval\", rule, lang)
       select '$U0', 'X' || chr(65 + i / 26) || chr(65 + i % 26), '15min', 'stockmacd', 'ja' from generate_series(0, $1 - 1) i;
     insert into public.signal_alert_subscriptions (user_id, pair, \"interval\", rule, lang)
       select '$U0', 'HOLD' || chr(65 + i), '1h', 'stockmacd', 'ja' from generate_series(0, 4) i;" > /dev/null
}
follow() { q "select public.stockmacd_follow('$1', '$2'::jsonb, '${3:-ja}', now(), 50)"; }
count() { q "select public.stockmacd_followed_count()"; }
rows_of() { q "select count(*) from public.signal_alert_subscriptions where user_id = '$1' and rule = 'stockmacd' and \"interval\" = '15min'"; }

reset_to 49
say "the count: 49 shares on '15min' (the 5 shares followed on '1h' only are not counted)" "$(count)" "49"
say "at 49, a new share: saved (true), 50" "$(follow "$U1" '["NEWA"]') $(count)" "t 50"
say "at 50, a new share: refused (false), nothing saved, 50" "$(follow "$U2" '["NEWB"]') $(count) $(rows_of "$U2")" "f 50 0"
say "at 50, a share another user follows: saved (true), still 50" "$(follow "$U2" '["XAA"]') $(count) $(rows_of "$U2")" "t 50 1"
say "at 50, one of the 22 nobody follows (AAPL): refused" "$(follow "$U2" '["AAPL"]') $(count)" "f 50"
say "at 50, a batch of a followed share and a new one: refused, nothing of it saved" "$(follow "$U2" '["XAB","NEWC"]') $(count) $(rows_of "$U2")" "f 50 1"
say "a 51st share put in by hand (a statement sent by hand; the function is not in it)" "$(q "insert into public.signal_alert_subscriptions (user_id, pair, \"interval\", rule, lang) values ('$U0', 'HANDX', '15min', 'stockmacd', 'ja')") $(count)" " 51"
say "51 rows put in by hand: a re-tick of a followed share is saved, the count stays 51" "$(follow "$U0" '["XAC"]') $(count)" "t 51"
say "at 51, a new share: refused" "$(follow "$U1" '["NEWD"]') $(count)" "f 51"
reset_to 45
say "at 45, 10 shares nobody follows in one call: refused at 45, nothing saved" "$(follow "$U1" '["NA","NB","NC","ND","NE","NF","NG","NH","NI","NJ"]') $(count) $(rows_of "$U1")" "f 45 0"
say "at 45, 5 of them: saved, 50" "$(follow "$U1" '["NA","NB","NC","ND","NE"]') $(count) $(rows_of "$U1")" "t 50 5"
say "a re-tick writes the lang and created_at today's upsert writes; a share asked twice is one row" \
  "$(q "select public.stockmacd_follow('$U1', '[\"NA\",\"NA\"]'::jsonb, 'en', '2026-01-02T03:04:05Z', 50)") $(q "select count(*) || ' ' || lang || ' ' || to_char(created_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS') from public.signal_alert_subscriptions where user_id = '$U1' and pair = 'NA' group by lang, created_at")" \
  "t 1 en 2026-01-02 03:04:05"
n0=$(q "select count(*) from public.signal_alert_subscriptions")
bad_args() { case "$1" in *"stockmacd_follow: bad arguments"*) echo bad_arguments ;; *"cannot extract elements"*) echo not_an_array ;; *) echo "[$1]" ;; esac; }
say "an empty p_pairs: refused (bad arguments)" "$(bad_args "$(follow "$U1" '[]')")" "bad_arguments"
say "a p_pairs that is an object, or a string: an error" "$(bad_args "$(follow "$U1" '{"pair":"NEWE"}')") $(bad_args "$(follow "$U1" '"NEWE"')")" "not_an_array not_an_array"
say "a lowercase pair, a pair with no .T, a p_lang not ja or en, no p_user: refused (bad arguments)" \
  "$(bad_args "$(follow "$U1" '["newe"]')") $(bad_args "$(follow "$U1" '["7203"]')") $(bad_args "$(follow "$U1" '["NEWE"]' fr)") $(bad_args "$(q "select public.stockmacd_follow(null, '[\"NEWE\"]'::jsonb, 'ja', now(), 50)")")" \
  "bad_arguments bad_arguments bad_arguments bad_arguments"
say "none of the refused calls wrote a row" "$(q "select count(*) from public.signal_alert_subscriptions")" "$n0"

echo "== two sessions at once (PostgREST's way in: authenticator, then service_role)"
two_at_once() { # $1 the first's share, $2 the second's share; prints "first second waited count"
  reset_to 49
  $PSQL -U authenticator -d "$DB" -q -At -v ON_ERROR_STOP=1 > "$WORK/a.out" 2>&1 <<SQL &
set role service_role;
begin;
select public.stockmacd_follow('$U1', '["$1"]'::jsonb, 'ja', now(), 50);
select pg_sleep(4);
commit;
SQL
  local a=$!
  sleep 1
  $PSQL -U authenticator -d "$DB" -q -At -v ON_ERROR_STOP=1 -c "set role service_role" -c "select public.stockmacd_follow('$U2', '[\"$2\"]'::jsonb, 'ja', now(), 50)" > "$WORK/b.out" 2>&1 &
  local b=$!
  sleep 1.5
  # the second waits on the first's lock (391042), not granted while the first's transaction is open
  local waiting
  waiting=$(q "select count(*) filter (where not granted) || '/' || count(*) filter (where granted) from pg_locks where locktype = 'advisory' and objid = 391042")
  local b_done=no
  kill -0 "$b" 2> /dev/null || b_done=yes
  wait "$a"
  wait "$b"
  echo "$(grep -E '^[tf]$' "$WORK/a.out" | head -1) $(grep -E '^[tf]$' "$WORK/b.out" | head -1) waiting=$waiting second_done_early=$b_done $(count)"
}
say "at 49, the first adds P and holds its transaction open, the second adds Q: the second waits on the lock, then refuses; 50" \
  "$(two_at_once NEWP NEWQ) $(rows_of "$U2")" "t f waiting=1/1 second_done_early=no 50 0"
say "at 49, both add the same new share P: the second waits, then finds P followed and is saved; still 50" \
  "$(two_at_once NEWP NEWP) $(rows_of "$U2")" "t t waiting=1/1 second_done_early=no 50 1"

echo "== isolation: the call refuses under any level but read committed"
reset_to 10
level() { $SU -d "$DB" -q -At -c "begin isolation level $1" -c "select public.stockmacd_follow('$U1', '[\"NEWR\"]'::jsonb, 'ja', now(), 50)" -c "commit" 2>&1 | grep -o "stockmacd_follow: needs read committed" | head -1; }
say "under repeatable read: refused" "$(level 'repeatable read')" "stockmacd_follow: needs read committed"
say "under serializable: refused" "$(level serializable)" "stockmacd_follow: needs read committed"
say "and nothing saved by either" "$(rows_of "$U1") $(count)" "0 10"
say "this local server's default level (what the concurrency check above ran under)" "$(q "show default_transaction_isolation")" "read committed"

echo "== the daily note: cleared for a share nobody followed, kept for one followed"
reset_to 10
q "insert into public.signal_alert_stocks (pair, name, checked_at, last_bar_at, bars, noted_at) values
     ('XAA', 'Example Holdings', now(), now() - interval '9 days', 120, now() - interval '1 day'),
     ('NEWN', 'Example Trading', now(), now() - interval '30 days', 80, now() - interval '20 days')" > /dev/null
say "a call with a followed share (XAA) and one nobody follows (NEWN): saved" "$(follow "$U1" '["XAA","NEWN"]')" "t"
say "NEWN's note cleared, XAA's kept, both names kept" \
  "$(q "select string_agg(pair || ':' || name || ':' || (last_bar_at is null)::text || (bars is null)::text || (noted_at is null)::text, ' ' order by pair) from public.signal_alert_stocks")" \
  "NEWN:Example Trading:truetruetrue XAA:Example Holdings:falsefalsefalse"
reset_to 50
q "insert into public.signal_alert_stocks (pair, name, last_bar_at, bars, noted_at) values ('NEWS', 'Example Works', now(), 10, now())" > /dev/null
say "a call refused at the cap leaves the note of the share nobody follows as it was" \
  "$(follow "$U1" '["NEWS"]') $(q "select (last_bar_at is not null)::text || ' ' || bars || ' ' || (noted_at is not null)::text from public.signal_alert_stocks where pair = 'NEWS'")" \
  "f true 10 true"

echo "== rights"
# (the stand-ins first: Supabase's default rights are in place here, so the lines below can fail on a missing revoke)
say "the stand-ins hold Supabase's default rights in schema public: a table and a function made there by postgres are open to anon and authenticated until revoked" \
  "$(q "begin;
        create table public.v42_probe (x integer);
        create function public.v42_probe_f() returns integer language sql as 'select 1';
        select has_table_privilege('anon', 'public.v42_probe', 'select')::text || ' ' || has_table_privilege('authenticated', 'public.v42_probe', 'select')::text || ' '
          || (select string_agg(a.grantee::regrole::text, ',' order by a.grantee::regrole::text) from pg_proc p cross join lateral aclexplode(p.proacl) a
              where p.oid = 'public.v42_probe_f()'::regprocedure and a.privilege_type = 'EXECUTE' and a.grantee in ('anon'::regrole, 'authenticated'::regrole));
        rollback;")" \
  "true true anon,authenticated"
say "anon and authenticated hold no right on signal_alert_stocks and cannot execute either function (as booleans; the read-back's reading)" \
  "$(q "select string_agg(r || ':' || has_table_privilege(r, 'public.signal_alert_stocks', 'select,insert,update,delete,truncate,references,trigger')::text
          || ',' || has_function_privilege(r, 'public.stockmacd_followed_count()', 'execute')::text
          || ',' || has_function_privilege(r, 'public.stockmacd_follow(uuid, jsonb, text, timestamptz, integer)', 'execute')::text, ' ' order by r)
        from unnest(array['anon', 'authenticated']) r")" \
  "anon:false,false,false authenticated:false,false,false"
denied() { case "$1" in *"permission denied"*) echo denied ;; *) echo "[$1]" ;; esac; }
for r in authenticated anon; do
  say "$r cannot execute stockmacd_followed_count, stockmacd_follow, or read signal_alert_stocks" \
    "$(denied "$(as $r "select public.stockmacd_followed_count()")") $(denied "$(as $r "select public.stockmacd_follow('$U1', '[\"NEWT\"]'::jsonb, 'ja', now(), 50)")") $(denied "$(as $r "select count(*) from public.signal_alert_stocks")")" \
    "denied denied denied"
done
reset_to 10
say "service_role executes both and may read and write signal_alert_stocks" \
  "$(as service_role "select public.stockmacd_followed_count()") $(as service_role "select public.stockmacd_follow('$U1', '[\"NEWT\"]'::jsonb, 'ja', now(), 50)") $(q "select has_table_privilege('service_role', 'public.signal_alert_stocks', 'select,insert,update,delete')")" \
  "10 t t"
say "PUBLIC holds no right on either function (each revoke followed its create)" \
  "$(q "select count(*) from pg_proc p cross join lateral aclexplode(p.proacl) a where p.pronamespace = 'public'::regnamespace and p.proname in ('stockmacd_follow', 'stockmacd_followed_count') and a.grantee = 0")" "0"
say "both are security definer with search_path=public; the count stable, the follow volatile" \
  "$(q "select string_agg(proname || ':' || prosecdef::text || ':' || array_to_string(proconfig, ';') || ':' || provolatile::text, ' ' order by proname) from pg_proc where pronamespace = 'public'::regnamespace and proname in ('stockmacd_follow', 'stockmacd_followed_count')")" \
  "stockmacd_follow:true:search_path=public:v stockmacd_followed_count:true:search_path=public:s"

if [ "$bad" = "0" ]; then echo "== all PASS"; else echo "== some FAIL"; fi
exit $bad
