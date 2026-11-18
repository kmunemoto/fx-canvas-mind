#!/usr/bin/env bash
# The local test bench of the morning check v11 (README.md v11.4), start to end:
#   synthetic 1-hour bars (the v9 bench's generators, unchanged: gen.py, GMO day files of the five pairs; gen_gold.py, gold's stored Twelve Data row)
#   -> production's MACD fade played over them with the function's OWN code (sim11.ts imports _shared/macd-fade.ts, signal-alerts/indicators.ts's ridePaidAt and
#      _shared/market-hours.ts's isPossiblyClosed): the mail rows production would have left, and the lines the morning check should answer
#   -> pairs-v11 and gold-v11 run on a scratch database for every GMO day (Saturday keys included) and compared with those lines (check11.py), then rows changed on purpose
#      (scen11.py: the pairs, gold and the shares' statement) and, with MC_TEETH=1, the statements changed on purpose (teeth11.py).
# Needs python3, deno, and a scratch PostgreSQL (16 or later) whose user may create databases: MC_PSQL, default "psql -h 127.0.0.1 -p 54351 -U postgres".
# IT DROPS AND CREATES THE DATABASES mc11p AND mc11g THERE. Nothing here touches the project's database.
#   bash run11.sh [SEED ...]        (default: 1)
set -euo pipefail
cd "$(dirname "$0")"
PSQL=${MC_PSQL:-psql -h 127.0.0.1 -p 54351 -U postgres}
export MC_PSQL="$PSQL"
DENO=${MC_DENO:-deno}
WORK=${MC_WORK:-$(mktemp -d)}
for db in mc11p mc11g; do
  $PSQL -q -c "drop database if exists $db" -c "create database $db"
  $PSQL -d $db -q -v ON_ERROR_STOP=1 -f schema-v11.sql
done
first=""
for seed in "${@:-1}"; do
  first=${first:-$seed}
  mkdir -p "$WORK/p$seed" "$WORK/g$seed"
  echo "== seed $seed: the five pairs"
  python3 -I gen.py "$seed" "$WORK/p$seed"
  $DENO run -A sim11.ts "$WORK/p$seed"
  python3 -I check11.py "$WORK/p$seed" --kind pairs --load --saturdays --quiet
  echo "== seed $seed: gold"
  python3 -I gen_gold.py "$seed" "$WORK/g$seed"
  $DENO run -A sim11.ts "$WORK/g$seed"
  python3 -I check11.py "$WORK/g$seed" --kind gold --load --saturdays --quiet
done
echo "== rows changed on purpose (seed $first)"
python3 -I check11.py "$WORK/p$first" --kind pairs --load --from 20261130 --to 20261130 --quiet > /dev/null
python3 -I check11.py "$WORK/g$first" --kind gold --load --from 20261130 --to 20261130 --quiet > /dev/null
python3 -I scen11.py "$WORK/p$first" "$WORK/g$first"
if [ "${MC_TEETH:-0}" = 1 ]; then
  echo "== the statements changed on purpose (seed $first)"
  python3 -I teeth11.py "$WORK/p$first" "$WORK/g$first"
fi
echo "work files: $WORK"
