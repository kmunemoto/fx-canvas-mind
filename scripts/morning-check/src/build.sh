#!/usr/bin/env bash
# Rebuilds the deliverables in the folder above from the parts in this folder:
#   v3 (frozen: the Routine uses these for the GMO days up to key 20261014): pairs.sql, gold.sql, debug-closes.sql, debug-closes-gold.sql and their .min.sql
#   v4 (frozen: rule macdx_12_26_9_w600_1h_z90of120_v4, signal-alerts v28, the GMO days from key 20261015 up to key 20261015): pairs-v4.sql, gold-v4.sql and their .min.sql
#   v5 (rule macdx_12_26_9_w600_1h_x80of120_v5, signal-alerts v29, bars opened from 2026-10-15 21:00 UTC on): pairs-v5.sql, gold-v5.sql and their .min.sql
# The .sql files keep the comments; the .min.sql files are the same statement without comments and indentation (shorter to paste into one tool call).
# Nothing is edited by hand in the deliverables: change a part, run this, run the tests (see ../README.md).
#   bash build.sh
# The last step compares the eight v3 files with v3.md5 (they must stay byte for byte what they were when v3 went live: parts shared with v4 are head, syms-*, front-*,
# engine-closes, guard-*, and a change to one of them changes v3 as well; if that is wanted, update v3.md5 on purpose), and the four v4 files with v4.md5 likewise
# (frozen when v5 was made: parts shared with v5 are head, front-*, engine-closes, guard-*, dayend-*-v4).
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

# ---- v5 ----
$A $O/pairs-v5.sql           header-pairs-v5.part    head.part syms-pairs-v5.part front-pairs.part engine-head-v5.part engine-closes.part engine-rec-v5.part back1-v5.part guard-pairs.part dayend-pairs-v4.part back2-v5.part --sub SQLNAME=pairs.sql
$A $O/pairs-v5.min.sql                               head.part syms-pairs-v5.part front-pairs.part engine-head-v5.part engine-closes.part engine-rec-v5.part back1-v5.part guard-pairs.part dayend-pairs-v4.part back2-v5.part --sub SQLNAME=pairs.sql --strip
$A $O/gold-v5.sql            header-gold-v5.part     head.part syms-gold-v5.part  front-gold.part  engine-head-v5.part engine-closes.part engine-rec-v5.part back1-v5.part guard-gold.part  dayend-gold-v4.part  back2-v5.part --sub SQLNAME=gold.sql
$A $O/gold-v5.min.sql                                head.part syms-gold-v5.part  front-gold.part  engine-head-v5.part engine-closes.part engine-rec-v5.part back1-v5.part guard-gold.part  dayend-gold-v4.part  back2-v5.part --sub SQLNAME=gold.sql --strip

# ---- v3 and v4 must be unchanged ----
md5sum -c v3.md5
md5sum -c v4.md5
