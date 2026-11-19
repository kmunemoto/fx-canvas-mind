#!/usr/bin/env bash
# The local test bench of the morning check v12 (README.md v12.4), start to end: run11.sh on 15-minute bars, per pair (research/macdfade15min-prod-spec.md 7.3).
#   the statements' structure (structure12.py: ASCII, strip, the markers, no ';' and no DDL word; no database)
#   synthetic 15-minute bars (gen12.py: GMO day files of the five pairs, interval '15min'; gen_gold12.py: gold's stored Twelve Data row on '15min')
#   -> production's MACD fade on the 15-minute chart played over them with the function's OWN code (sim12.ts imports _shared/macd-fade.ts, signal-alerts/indicators.ts's
#      ridePaidAt, gmoIntervalsDue, twelveCloseDue, latestCloseMs and freshFor, and _shared/market-hours.ts's isPossiblyClosed): the mail rows production would have left,
#      and the lines the morning check should answer; in the pairs' run for USD/JPY and AUD/USD only (the pairs v41 judges on 15 minutes; the other three are loaded, not
#      followed, not mailed)
#   -> pairs-v12 and gold-v12 run on a scratch database for every GMO day (Saturday keys included) and compared with those lines (check12.py), then rows changed on purpose
#      (scen12.py: the pairs, gold, the switch day, the RUN count of other pairs' 15-minute rows and the shares' statement) and, with MC_TEETH=1, the statements changed on
#      purpose (teeth12.py)
#   -> pairs1h-v11 (EUR/JPY, AUD/JPY, EUR/USD on v11's form) against pairs-v11 on v11's bench data of each seed (gen.py, sim11.ts; check1h.py)
# gold-v12 is never sent (gold stays on gold-v11): its run here is kept as a record, not a release check.
# Needs python3, deno, and a scratch PostgreSQL (16 or later) whose user may create databases: MC_PSQL, default "psql -h 127.0.0.1 -p 54361 -U postgres".
# IT DROPS AND CREATES THE DATABASES mc12p, mc12g AND mc12h THERE (the tables of schema-v11.sql, which v12 reads as v11 does). Nothing here touches the project's database.
#   bash run12.sh [SEED ...]        (default: 5)
# The FIRST seed is the one the scenarios and the teeth run on: it must be a seed whose two-pair walk has an AUD/USD entry in the weekend window and an entry on a Friday
# bar opened 20:00 to 20:30 UTC (scen12.py p33, p34, p37: they fail, not skip, without one), and on the switch day (key 20261125) an entry before 10:00 UTC and one from it
# (p21). Of seeds 1 to 10, 3, 5 and 7 have the two weekend kinds, and of those 5 and 7 the switch day's two (3 has no entry from 10:00 that day): README.md v12.4.
set -euo pipefail
cd "$(dirname "$0")"
PSQL=${MC_PSQL:-psql -h 127.0.0.1 -p 54361 -U postgres}
export MC_PSQL="$PSQL"
DENO=${MC_DENO:-deno}
WORK=${MC_WORK:-$(mktemp -d)}
echo "== the statements' structure"
python3 -I structure12.py
for db in mc12p mc12g mc12h; do
  $PSQL -q -c "drop database if exists $db" -c "create database $db"
  $PSQL -d $db -q -v ON_ERROR_STOP=1 -f schema-v11.sql
done
first=""
for seed in "${@:-5}"; do
  first=${first:-$seed}
  mkdir -p "$WORK/p$seed" "$WORK/g$seed" "$WORK/h$seed"
  echo "== seed $seed: the two 15-minute pairs (USD/JPY, AUD/USD)"
  python3 -I gen12.py "$seed" "$WORK/p$seed"
  $DENO run -A sim12.ts "$WORK/p$seed"
  python3 -I check12.py "$WORK/p$seed" --kind pairs --load --saturdays --quiet
  echo "== seed $seed: gold (gold-v12, a record)"
  python3 -I gen_gold12.py "$seed" "$WORK/g$seed"
  $DENO run -A sim12.ts "$WORK/g$seed"
  python3 -I check12.py "$WORK/g$seed" --kind gold --load --saturdays --quiet
  echo "== seed $seed: the three 1-hour pairs (pairs1h-v11 against pairs-v11, on v11's bench data)"
  python3 -I gen.py "$seed" "$WORK/h$seed"
  $DENO run -A sim11.ts "$WORK/h$seed"
  python3 -I check1h.py "$WORK/h$seed" --load --saturdays
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
