#!/usr/bin/env bash
# The local test bench of the morning check v9 (README.md v9.4), start to end:
#   synthetic bars (gen.py: GMO day files of the five pairs; gen_gold.py: gold's stored row and recorded minutes)
#   -> production's MACD ride played over them with the SHARED code of the function (sim.ts imports supabase/functions/_shared/macd-ride.ts): the rides, the state rows and the
#      mails production would have left, and the lines the morning check should answer
#   -> the statements run on a scratch database for every GMO day and compared with those lines (check.py), the function form compared with the statement form (fncmp.py),
#      rows changed on purpose (scen.py), and the statement changed on purpose (teeth.py, about half an hour: only with MC_TEETH=1).
# Needs python3, deno, and a scratch PostgreSQL (16 or later) whose user may create databases: MC_PSQL, default "psql -h 127.0.0.1 -p 54329 -U postgres".
# IT DROPS AND CREATES THE DATABASES mc9 AND mc9g THERE. Nothing here touches the project's database.
#   bash run.sh [SEED ...]        (default: 1)
set -euo pipefail
cd "$(dirname "$0")"
PSQL=${MC_PSQL:-psql -h 127.0.0.1 -p 54329 -U postgres}
WORK=${MC_WORK:-$(mktemp -d)}
M=../../../supabase/migrations
for db in mc9 mc9g; do
  $PSQL -q -c "drop database if exists $db" -c "create database $db"
  $PSQL -d $db -q -v ON_ERROR_STOP=1 -f schema.sql -f $M/20261112120000_macd_rides.sql -f $M/20261112130000_morning_check_v9.sql
done
first=""
for seed in "${@:-1}"; do
  first=${first:-$seed}
  mkdir -p "$WORK/p$seed" "$WORK/g$seed"
  echo "== seed $seed: the five pairs"
  python3 -I gen.py "$seed" "$WORK/p$seed"
  deno run -A sim.ts "$WORK/p$seed"
  python3 -I check.py "$WORK/p$seed" --db mc9 --load --quiet
  python3 -I fncmp.py mc9 ../pairs-v9.min.sql mc.pairs_v9 --to 20261127
  echo "== seed $seed: gold"
  python3 -I gen_gold.py "$seed" "$WORK/g$seed"
  deno run -A sim.ts "$WORK/g$seed"
  python3 -I check.py "$WORK/g$seed" --db mc9g --load --quiet --sql ../gold-v9.min.sql
  python3 -I fncmp.py mc9g ../gold-v9.min.sql mc.gold_v9
done
echo "== rows changed on purpose (seed $first, the five pairs)"
python3 -I check.py "$WORK/p$first" --db mc9 --load --quiet --from 20261112 --to 20261112 > /dev/null
python3 -I scen.py "$WORK/p$first" --db mc9
echo "== rows changed on purpose (seed $first, gold)"
python3 -I check.py "$WORK/g$first" --db mc9g --load --quiet --sql ../gold-v9.min.sql --from 20261112 --to 20261112 > /dev/null
python3 -I scen.py "$WORK/g$first" --db mc9g --sql ../gold-v9.min.sql
if [ "${MC_TEETH:-0}" = 1 ]; then
  echo "== the statement changed on purpose (seed $first, the five pairs)"
  python3 -I teeth.py "$WORK/p$first" mc9
fi
echo "work files: $WORK"
