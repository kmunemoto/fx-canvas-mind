#!/usr/bin/env bash
# Rebuilds the deliverables in the folder above from the parts in this folder:
#   v3 (frozen: the Routine uses these for the GMO days up to key 20261014): pairs.sql, gold.sql, debug-closes.sql, debug-closes-gold.sql and their .min.sql
#   v4 (rule macdx_12_26_9_w600_1h_z90of120_v4, signal-alerts v28, bars opened from 2026-10-14 21:00 to 2026-10-19 20:00 UTC): pairs-v4.sql, gold-v4.sql and their .min.sql
#   v6 (#362: rule macdx_12_26_9_w600_1h_z95of120_v6, signal-alerts v30, bars opened from 2026-10-19 21:00 to 2026-10-26 20:00 UTC): pairs-v6.sql, gold-v6.sql and their .min.sql
#   v7 (#384: rule macdx_12_26_9_w600_15min_z95of120_v7, signal-alerts v31, the 15-minute chart, GMO days from key 20261026, the switch day, see ../README.md v7.1): pairs-v7.sql, gold-v7.sql and their .min.sql
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

# ---- v3 must be unchanged ----
md5sum -c v3.md5
