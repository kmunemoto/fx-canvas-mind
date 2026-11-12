#!/usr/bin/env python3
"""Local test bench of morning-check v9: the function form answers what the statement form answers (but the RUN row's md5, length, via and elapsed time).

usage: python3 -I fncmp.py DB STATEMENT.min.sql FUNCTION [--from YYYYMMDD] [--to YYYYMMDD]
"""
import datetime as dt
import json
import os
import shlex
import subprocess
import sys
import time

db, sqlfile, fn = sys.argv[1:4]
args = sys.argv[4:]
opt = lambda k, default=None: (args[args.index(k) + 1] if k in args else default)
PSQL = shlex.split(os.environ.get("MC_PSQL", "psql -h 127.0.0.1 -p 54329 -U postgres")) + ["-d", db, "-q", "-v", "ON_ERROR_STOP=1", "-At", "-F", "\x1f"]
text = open(sqlfile, encoding="utf-8").read()
UTC = dt.timezone.utc


def run(sql):
    t0 = time.time()
    r = subprocess.run(PSQL, input=sql, capture_output=True, text=True)
    if r.returncode:
        sys.exit("psql failed: " + r.stderr[:2000])
    rows = []
    for ln in r.stdout.strip().split("\n"):
        rt, inst, bar, side, verdict, data = ln.split("\x1f")
        j = json.loads(data)
        if rt == "RUN":
            for k in ("sql_md5", "sql_chars", "via", "elapsed_s", "db_now_utc"):
                j.pop(k, None)
        rows.append((rt, inst, bar, side, verdict, json.dumps(j, sort_keys=True)))
    return rows, time.time() - t0


day = dt.datetime.strptime(opt("--from", "20261112"), "%Y%m%d").date()
last = dt.datetime.strptime(opt("--to", "20270108"), "%Y%m%d").date()
days = same = 0
ta = tb = 0.0
while day <= last:
    if day.weekday() < 5:
        s = int(dt.datetime(day.year, day.month, day.day, 21, tzinfo=UTC).timestamp() * 1000) - 86400000
        a, x = run(text.replace("{{START_MS}}", str(s)).replace("{{END_MS}}", str(s + 86400000)))
        b, y = run(f"select * from {fn}({s}, {s + 86400000})")
        days += 1
        ta += x
        tb += y
        if a == b:
            same += 1
        else:
            print(day, "DIFFERENT", [r for r in a if r not in b][:2], [r for r in b if r not in a][:2])
    day += dt.timedelta(days=1)
print(f"{fn}: days {days}, the same answer on {same}; seconds statement {ta:.1f}, function {tb:.1f}")
