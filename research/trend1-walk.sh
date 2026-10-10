#!/bin/bash
# #250 (docs §8.106 段1の作り 8): one walk of stage 1's checks — research/trend.ts writes it as GMO's files over
# (a)'s period and labels it (LIGHT), research/trend1.ts takes it through the whole procedure. The walk's kind
# and strength come from its seed (fixed in the docs before the runs):
#   101..180  no effect (101..120 for ①, 121..140 ②, 141..160 ③, 161..180 ④)
#   201..210  the trend goes on: WALK_KIND on, strength 0.03, hours 72
#   301..310  the trend turns back: WALK_KIND back, strength 0.3, hours 4
#   401..404  a drift up on every pair: WALK_KIND drift, strength 0.012
# With "answer" as the second argument (seeds 101..104), the 1-hour label is the mid's direction 4 hours on.
#
# usage: research/trend1-walk.sh <seed> [answer]   (CALIB_DIR: where the summaries go; DENO: deno's path)
set -euo pipefail
seed=$1
answer=${2:-}
CALIB_DIR=${CALIB_DIR:-research/out/trend1/calib}
DENO=${DENO:-deno}
if [ "$seed" -ge 101 ] && [ "$seed" -le 180 ]; then kind=none; str=0; hrs=0
elif [ "$seed" -ge 201 ] && [ "$seed" -le 210 ]; then kind=on; str=0.03; hrs=72
elif [ "$seed" -ge 301 ] && [ "$seed" -le 310 ]; then kind=back; str=0.3; hrs=4
elif [ "$seed" -ge 401 ] && [ "$seed" -le 404 ]; then kind=drift; str=0.012; hrs=0
else echo "seed $seed: not one of the walks' seeds" >&2; exit 2; fi
if [ -n "$answer" ] && { [ "$answer" != "answer" ] || [ "$seed" -lt 101 ] || [ "$seed" -gt 104 ]; }; then echo "answer: seeds 101..104 only" >&2; exit 2; fi
name=w$seed
[ -n "$answer" ] && name=answer$seed
out=$CALIB_DIR/$name
walk=$CALIB_DIR/.walk-$name
mkdir -p "$out"
MODE=syn SEED=$seed LIGHT=1 SYN_START=2024-01-01T00:00:00Z SYN_END=2026-10-03T00:00:00Z WALK_KIND=$kind WALK_STRENGTH=$str WALK_HOURS=$hrs OUT=$walk \
  "$DENO" run --v8-flags=--max-old-space-size=8192 --allow-read=. --allow-write=research/out --allow-env research/trend.ts > "$out/walk.log" 2>&1 \
  || { echo "seed $seed: research/trend.ts failed"; tail -n 20 "$out/walk.log"; exit 1; }
s=0
MODE=syn SEED=$seed WALK_DIR=$walk ANSWER=$([ -n "$answer" ] && echo 1 || echo "") OUT=$out \
  "$DENO" run --v8-flags=--max-old-space-size=8192 --allow-read=. --allow-write=research/out --allow-env research/trend1.ts > "$out/s1.log" 2>&1 || s=$?
rm -rf "$walk"
if [ "$s" != "0" ]; then echo "seed $seed ($name): research/trend1.ts exit $s"; grep -E "^FAIL" "$out/s1.log" || tail -n 20 "$out/s1.log"; exit 1; fi
echo "seed $seed ($name, $kind): $(grep -cE '^ok  ' "$out/s1.log") checks ok"
