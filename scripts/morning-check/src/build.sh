#!/usr/bin/env bash
# Rebuilds the eight deliverables in the folder above (pairs.sql, gold.sql, debug-closes.sql, debug-closes-gold.sql and their .min.sql)
# from the parts in this folder. The .sql files keep the comments; the .min.sql files are the same statement without comments and indentation
# (shorter to paste into one tool call). Nothing is edited by hand in the deliverables: change a part, run this, run the tests (see ../README.md).
#   bash build.sh
set -euo pipefail
cd "$(dirname "$0")"
A="python3 -I assemble.py"
O=..

$A $O/pairs.sql              header-pairs.part       head.part front-pairs.part engine.part back1.part guard-pairs.part back2.part --sub SQLNAME=pairs.sql
$A $O/pairs.min.sql                                  head.part front-pairs.part engine.part back1.part guard-pairs.part back2.part --sub SQLNAME=pairs.sql --strip
$A $O/gold.sql               header-gold.part        head.part front-gold.part  engine.part back1.part guard-gold.part  back2.part --sub SQLNAME=gold.sql
$A $O/gold.min.sql                                   head.part front-gold.part  engine.part back1.part guard-gold.part  back2.part --sub SQLNAME=gold.sql --strip
$A $O/debug-closes.sql       header-closes-pairs.part head.part front-pairs.part engine.part tail-closes-pairs.part
$A $O/debug-closes.min.sql                           head.part front-pairs.part engine.part tail-closes-pairs.part --strip
$A $O/debug-closes-gold.sql  header-closes-gold.part head.part front-gold.part  engine.part tail-closes-gold.part
$A $O/debug-closes-gold.min.sql                      head.part front-gold.part  engine.part tail-closes-gold.part --strip
