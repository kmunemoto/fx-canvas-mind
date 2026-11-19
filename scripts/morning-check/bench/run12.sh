#!/usr/bin/env bash
# The local test bench of the morning check v12 (README.md v12.4), start to end: run11.sh on 15-minute bars.
#   synthetic 15-minute bars (gen12.py: GMO day files of the five pairs, interval '15min'; gen_gold12.py: gold's stored Twelve Data row on '15min')
#   -> production's MACD fade on the 15-minute chart played over them with the function's OWN code (sim12.ts imports _shared/macd-fade.ts, signal-alerts/indicators.ts's
#      ridePaidAt, gmoIntervalsDue, twelveCloseDue, latestCloseMs and freshFor, and _shared/market-hours.ts's isPossiblyClosed): the mail rows production would have left,
#      and the lines the morning check should answer
#   -> pairs-v12 and gold-v12 run on a scratch database for every GMO day (Saturday keys included) and compared with those lines (check12.py), then rows changed on purpose
#      (scen12.py: the pairs, gold, the switch day and the shares' statement) and, with MC_TEETH=1, the statements changed on purpose (teeth12.py).
# Needs python3, deno, and a scratch PostgreSQL (16 or later) whose user may create databases: MC_PSQL, default "psql -h 127.0.0.1 -p 54361 -U postgres".
# IT DROPS AND CREATES THE DATABASES mc12p AND mc12g THERE (the tables of schema-v11.sql, which v12 reads as v11 does). Nothing here touches the project's database.
#   bash run12.sh [SEED ...]        (default: 1)
set -euo pipefail
cd "$(dirname "$0")"
PSQL=${MC_PSQL:-psql -h 127.0.0.1 -p 54361 -U postgres}
export MC_PSQL="$PSQL"
DENO=${MC_DENO:-deno}
WORK=${MC_WORK:-$(mktemp -d)}
for db in mc12p mc12g; do
  $PSQL -q -c "drop database if exists $db" -c "create database $db"
  $PSQL -d $db -q -v ON_ERROR_STOP=1 -f schema-v11.sql
done
first=""
for seed in "${@:-1}"; do
  first=${first:-$seed}
  mkdir -p "$WORK/p$seed" "$WORK/g$seed"
  echo "== seed $seed: the five pairs"
  python3 -I gen12.py "$seed" "$WORK/p$seed"
  $DENO run -A sim12.ts "$WORK/p$seed"
  python3 -I check12.py "$WORK/p$seed" --kind pairs --load --saturdays --quiet
  echo "== seed $seed: gold"
  python3 -I gen_gold12.py "$seed" "$WORK/g$seed"
  $DENO run -A sim12.ts "$WORK/g$seed"
  python3 -I check12.py "$WORK/g$seed" --kind gold --load --saturdays --quiet
done
echo "== rows changed on purpose (seed $first)"
python3 -I check12.py "$WORK/p$first" --kind pairs --load --from 20261125 --to 20261125 --quiet > /dev/null
python3 -I check12.py "$WORK/g$first" --kind gold --load --from 20261125 --to 20261125 --quiet > /dev/null
python3 -I scen12.py "$WORK/p$first" "$WORK/g$first"
if [ "${MC_TEETH:-0}" = 1 ]; then
  echo "== the statements changed on purpose (seed $first)"
  python3 -I teeth12.py "$WORK/p$first" "$WORK/g$first"
fi
echo "work files: $WORK"
