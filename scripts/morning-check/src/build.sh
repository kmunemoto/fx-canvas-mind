#!/usr/bin/env bash
# Rebuilds the deliverables in the folder above from the parts in this folder:
#   v3 (frozen: the Routine uses these for the GMO days up to key 20261014): pairs.sql, gold.sql, debug-closes.sql, debug-closes-gold.sql and their .min.sql
#   v4 (rule macdx_12_26_9_w600_1h_z90of120_v4, signal-alerts v28, bars opened from 2026-10-14 21:00 to 2026-10-19 20:00 UTC): pairs-v4.sql, gold-v4.sql and their .min.sql
#   v6 (#362: rule macdx_12_26_9_w600_1h_z95of120_v6, signal-alerts v30, bars opened from 2026-10-19 21:00 to 2026-10-26 20:00 UTC): pairs-v6.sql, gold-v6.sql and their .min.sql
#   v7 (#384: rule macdx_12_26_9_w600_15min_z95of120_v7, signal-alerts v31, the 15-minute chart, GMO days from key 20261026, the switch day, see ../README.md v7.1): pairs-v7.sql, gold-v7.sql and their .min.sql
#   v8 (#386: rule macdx_12_26_9_w600_1h_z95of120_v8, signal-alerts v33, the 1-hour chart again, GMO days from key 20261030, the switch day back, see ../README.md v8.1): pairs-v8.sql, gold-v8.sql and their .min.sql
#   v9 (#397: the MACD ride, rule ids macdx_12_26_9_w600_1h_ride90to96of120_{in,at,out}_v9, signal-alerts v39, GMO days from key 20261112, the switch day, see ../README.md v9.1): pairs-v9.sql, gold-v9.sql and their .min.sql
# The .sql files keep the comments; the .min.sql files are the same statement without comments and indentation (shorter to paste into one tool call).
# Nothing is edited by hand in the deliverables: change a part, run this, run the tests (see ../README.md).
#   bash build.sh
# The last step compares the eight v3 files with v3.md5 (they must stay byte for byte what they were when v3 went live: parts shared with v4 are head, syms-*, front-*,
# engine-closes, guard-*, and a change to one of them changes v3 as well; if that is wanted, update v3.md5 on purpose).
set -euo pipefail
cd "$(dirname "$0")"
A="python3 -I assemble.py"
O=..

# ---- v3 ----
$A $O/pairs.sql              header-pairs.part       head.part syms-pairs.part front-pairs.part engine-head.part engine-closes.part engine-rec.part back1.part guard-pairs.part back2.part --sub SQLNAME=pairs.sql
$A $O/pairs.min.sql                                  head.part syms-pairs.part front-pairs.part engine-head.part engine-closes.part engine-rec.part back1.part guard-pairs.part back2.part --sub SQLNAME=pairs.sql --strip
$A $O/gold.sql               header-gold.part        head.part syms-gold.part  front-gold.part  engine-head.part engine-closes.part engine-rec.part back1.part guard-gold.part  back2.part --sub SQLNAME=gold.sql
$A $O/gold.min.sql                                   head.part syms-gold.part  front-gold.part  engine-head.part engine-closes.part engine-rec.part back1.part guard-gold.part  back2.part --sub SQLNAME=gold.sql --strip
$A $O/debug-closes.sql       header-closes-pairs.part head.part syms-pairs.part front-pairs.part engine-head.part engine-closes.part engine-rec.part tail-closes-pairs.part
$A $O/debug-closes.min.sql                           head.part syms-pairs.part front-pairs.part engine-head.part engine-closes.part engine-rec.part tail-closes-pairs.part --strip
$A $O/debug-closes-gold.sql  header-closes-gold.part head.part syms-gold.part  front-gold.part  engine-head.part engine-closes.part engine-rec.part tail-closes-gold.part
$A $O/debug-closes-gold.min.sql                      head.part syms-gold.part  front-gold.part  engine-head.part engine-closes.part engine-rec.part tail-closes-gold.part --strip

# ---- v4 ----
$A $O/pairs-v4.sql           header-pairs-v4.part    head.part syms-pairs-v4.part front-pairs.part engine-head-v4.part engine-closes.part engine-rec-v4.part back1-v4.part guard-pairs.part dayend-pairs-v4.part back2-v4.part --sub SQLNAME=pairs.sql
$A $O/pairs-v4.min.sql                               head.part syms-pairs-v4.part front-pairs.part engine-head-v4.part engine-closes.part engine-rec-v4.part back1-v4.part guard-pairs.part dayend-pairs-v4.part back2-v4.part --sub SQLNAME=pairs.sql --strip
$A $O/gold-v4.sql            header-gold-v4.part     head.part syms-gold-v4.part  front-gold.part  engine-head-v4.part engine-closes.part engine-rec-v4.part back1-v4.part guard-gold.part  dayend-gold-v4.part  back2-v4.part --sub SQLNAME=gold.sql
$A $O/gold-v4.min.sql                                head.part syms-gold-v4.part  front-gold.part  engine-head-v4.part engine-closes.part engine-rec-v4.part back1-v4.part guard-gold.part  dayend-gold-v4.part  back2-v4.part --sub SQLNAME=gold.sql --strip

# ---- v6 (#362: the same rule as v4 with the band from 95%; parts shared with v4 but back1, back2, header and syms) ----
$A $O/pairs-v6.sql           header-pairs-v6.part    head.part syms-pairs-v6.part front-pairs.part engine-head-v4.part engine-closes.part engine-rec-v4.part back1-v6.part guard-pairs.part dayend-pairs-v4.part back2-v6.part --sub SQLNAME=pairs.sql
$A $O/pairs-v6.min.sql                               head.part syms-pairs-v6.part front-pairs.part engine-head-v4.part engine-closes.part engine-rec-v4.part back1-v6.part guard-pairs.part dayend-pairs-v4.part back2-v6.part --sub SQLNAME=pairs.sql --strip
$A $O/gold-v6.sql            header-gold-v6.part     head.part syms-gold-v6.part  front-gold.part  engine-head-v4.part engine-closes.part engine-rec-v4.part back1-v6.part guard-gold.part  dayend-gold-v4.part  back2-v6.part --sub SQLNAME=gold.sql
$A $O/gold-v6.min.sql                                head.part syms-gold-v6.part  front-gold.part  engine-head-v4.part engine-closes.part engine-rec-v4.part back1-v6.part guard-gold.part  dayend-gold-v4.part  back2-v6.part --sub SQLNAME=gold.sql --strip

# ---- v7 (#384: the v6 rule on the 15-minute chart, rule macdx_12_26_9_w600_15min_z95of120_v7, signal-alerts v31, GMO days from key 20261026; the engine parts are v4's,
#      every part that holds an interval-dependent constant has a -v7 copy: header, head, syms, front, back1, guard, dayend (pairs), back2) ----
$A $O/pairs-v7.sql           header-pairs-v7.part    head-v7.part syms-pairs-v7.part front-pairs-v7.part engine-head-v4.part engine-closes.part engine-rec-v4.part back1-v7.part guard-pairs-v7.part dayend-pairs-v7.part back2-v7.part --sub SQLNAME=pairs.sql
$A $O/pairs-v7.min.sql                               head-v7.part syms-pairs-v7.part front-pairs-v7.part engine-head-v4.part engine-closes.part engine-rec-v4.part back1-v7.part guard-pairs-v7.part dayend-pairs-v7.part back2-v7.part --sub SQLNAME=pairs.sql --strip
$A $O/gold-v7.sql            header-gold-v7.part     head-v7.part syms-gold-v7.part  front-gold-v7.part  engine-head-v4.part engine-closes.part engine-rec-v4.part back1-v7.part guard-gold-v7.part  dayend-gold-v4.part  back2-v7.part --sub SQLNAME=gold.sql
$A $O/gold-v7.min.sql                                head-v7.part syms-gold-v7.part  front-gold-v7.part  engine-head-v4.part engine-closes.part engine-rec-v4.part back1-v7.part guard-gold-v7.part  dayend-gold-v4.part  back2-v7.part --sub SQLNAME=gold.sql --strip

# ---- v8 (#386: the v6 rule on the 1-hour chart again, rule macdx_12_26_9_w600_1h_z95of120_v8, signal-alerts v33, GMO days from key 20261030, the switch day back,
#      see ../README.md v8.1; v6's parts but header, syms, back1 and back2) ----
$A $O/pairs-v8.sql           header-pairs-v8.part    head.part syms-pairs-v8.part front-pairs.part engine-head-v4.part engine-closes.part engine-rec-v4.part back1-v8.part guard-pairs.part dayend-pairs-v4.part back2-v8.part --sub SQLNAME=pairs.sql
$A $O/pairs-v8.min.sql                               head.part syms-pairs-v8.part front-pairs.part engine-head-v4.part engine-closes.part engine-rec-v4.part back1-v8.part guard-pairs.part dayend-pairs-v4.part back2-v8.part --sub SQLNAME=pairs.sql --strip
$A $O/gold-v8.sql            header-gold-v8.part     head.part syms-gold-v8.part  front-gold.part  engine-head-v4.part engine-closes.part engine-rec-v4.part back1-v8.part guard-gold.part  dayend-gold-v4.part  back2-v8.part --sub SQLNAME=gold.sql
$A $O/gold-v8.min.sql                                head.part syms-gold-v8.part  front-gold.part  engine-head-v4.part engine-closes.part engine-rec-v4.part back1-v8.part guard-gold.part  dayend-gold-v4.part  back2-v8.part --sub SQLNAME=gold.sql --strip

# ---- v9 (#397: the MACD ride, signal-alerts v39, rule ids macdx_12_26_9_w600_1h_ride90to96of120_{in,at,out}_v9, GMO days from key 20261112, the switch day, see ../README.md v9.1;
#      the head, the engine, the guards and the day's end are the parts v8 uses; new: header, syms, front (the pairs' high / low and the two closes), back1 and back2) ----
$A $O/pairs-v9.sql           header-pairs-v9.part    head.part syms-pairs-v9.part front-pairs-v9.part engine-head-v4.part engine-closes.part engine-rec-v4.part back1-v9.part guard-pairs.part dayend-pairs-v4.part back2-v9.part run-v9.part --sub SQLNAME=pairs.sql
$A $O/pairs-v9.min.sql                               head.part syms-pairs-v9.part front-pairs-v9.part engine-head-v4.part engine-closes.part engine-rec-v4.part back1-v9.part guard-pairs.part dayend-pairs-v4.part back2-v9.part run-v9.part --sub SQLNAME=pairs.sql --strip
$A $O/gold-v9.sql            header-gold-v9.part     head.part syms-gold-v9.part  front-gold-v9.part  engine-head-v4.part engine-closes.part engine-rec-v4.part back1-v9.part guard-gold.part  dayend-gold-v4.part  back2-v9.part run-v9.part --sub SQLNAME=gold.sql
$A $O/gold-v9.min.sql                                head.part syms-gold-v9.part  front-gold-v9.part  engine-head-v4.part engine-closes.part engine-rec-v4.part back1-v9.part guard-gold.part  dayend-gold-v4.part  back2-v9.part run-v9.part --sub SQLNAME=gold.sql --strip

# ---- v9, the function form (README v9.7): the same statements with the two markers as the parameters p_start / p_end and the RUN row's md5 read from pg_proc (run-v9-fn.part),
#      and the migration that installs them as mc.pairs_v9 / mc.gold_v9 (generated: never edited by hand) ----
$A $O/pairs-v9.fn.sql        head.part syms-pairs-v9.part front-pairs-v9.part engine-head-v4.part engine-closes.part engine-rec-v4.part back1-v9.part guard-pairs.part dayend-pairs-v4.part back2-v9.part run-v9-fn.part --sub SQLNAME=pairs.sql --sub START_MS=p_start --sub END_MS=p_end --sub FN=mc.pairs_v9 --sub FNFILE=pairs-v9.fn.sql --strip
$A $O/gold-v9.fn.sql         head.part syms-gold-v9.part  front-gold-v9.part  engine-head-v4.part engine-closes.part engine-rec-v4.part back1-v9.part guard-gold.part  dayend-gold-v4.part  back2-v9.part run-v9-fn.part --sub SQLNAME=gold.sql --sub START_MS=p_start --sub END_MS=p_end --sub FN=mc.gold_v9 --sub FNFILE=gold-v9.fn.sql --strip
# The migration of the current functions. 20261112130000_morning_check_v9.sql is the first one (2026-11-12, as installed on 2026-11-13) and is kept as it was: a new version of
# the statements gets a NEW migration name here (docs/OPERATIONS.md 10). 2026-11-13: the review's fixes (docs 8.151, README v9.6).
MIG=20261113140000_morning_check_v9_fix.sql
python3 -I mkfn.py ../../../supabase/migrations/$MIG fn-header-v9.part mc.pairs_v9 $O/pairs-v9.fn.sql mc.gold_v9 $O/gold-v9.fn.sql
# and the block that builds the same functions from pieces sent one at a time (README v9.7: pieces.py, then install-v9.sql run once)
python3 -I mkinstall.py install-v9.sql install-v9.part $MIG $O/pairs-v9.fn.sql $O/gold-v9.fn.sql
# and one block that holds the two sources in full, for the SQL Editor when the pieces cannot be sent (2026-11-13: the connector answered 502)
python3 -I mkinstall.py install-v9-full.sql install-v9-full.part $MIG $O/pairs-v9.fn.sql $O/gold-v9.fn.sql

# ---- v3 must be unchanged ----
md5sum -c v3.md5
