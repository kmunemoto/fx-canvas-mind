#!/usr/bin/env python3
"""Local test bench of morning-check v9 (pairs): load a data folder into the local database, run the statement for each GMO day,
and compare its LINE rows with what the simulation (the shared TypeScript code) says they should be.

usage: python3 -I check.py DATADIR [--db NAME] [--load] [--from YYYYMMDD] [--to YYYYMMDD] [--sql FILE] [--show KEY] [--quiet]
(the database: MC_PSQL, default "psql -h 127.0.0.1 -p 54329 -U postgres", and --db, default mc9; for gold: --sql ../gold-v9.min.sql)
"""
import datetime as dt
import json
import os
import shlex
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))

args = sys.argv[1:]
d = args[0]
opt = lambda k, default=None: (args[args.index(k) + 1] if k in args else default)
DB = opt("--db", "mc9")
PSQL = shlex.split(os.environ.get("MC_PSQL", "psql -h 127.0.0.1 -p 54329 -U postgres")) + ["-d", DB, "-q", "-v", "ON_ERROR_STOP=1"]
SQLFILE = opt("--sql", os.path.join(HERE, "..", "pairs-v9.min.sql"))
UTC = dt.timezone.utc


def psql(sql, *extra):
    r = subprocess.run(PSQL + list(extra), input=sql, capture_output=True, text=True)
    if r.returncode:
        sys.exit("psql failed: " + r.stderr[:3000])
    return r.stdout


if "--load" in args:
    psql("truncate public.gmo_kline_files, public.signal_alerts, public.signal_alert_subscriptions, public.macd_rides, public.macd_ride_state, public.live_chart_fallback, public.gold_tick_bars, public.twelve_data_usage;")
    if os.path.exists(f"{d}/files.tsv"):
        psql(f"\\copy public.gmo_kline_files (symbol, price_type, interval, date_key, body) from '{d}/files.tsv'\n")
    if os.path.exists(f"{d}/gold.sql"):
        psql(open(f"{d}/gold.sql", encoding="utf-8").read())
    psql(open(f"{d}/rows.sql", encoding="utf-8").read())
    print("loaded:", psql("select (select count(*) from public.gmo_kline_files) || ' files, ' || (select count(*) from public.macd_rides) || ' rides, ' || (select count(*) from public.macd_ride_state) || ' states, ' || (select count(*) from public.signal_alerts) || ' mails'", "-At").strip())

expect = json.load(open(f"{d}/expect.json", encoding="utf-8"))
text = open(SQLFILE, encoding="utf-8").read()
first = dt.datetime.strptime(opt("--from", "20261112"), "%Y%m%d").date()
last = dt.datetime.strptime(opt("--to", "20270108"), "%Y%m%d").date()
show = opt("--show")
fmt = lambda ms: dt.datetime.fromtimestamp(ms / 1000, UTC).strftime("%Y-%m-%d %H:%M")
bad = 0
tot = {"days": 0, "lines": 0, "summary_not_ok": 0, "state_checked": 0, "state_equal": 0, "near_checked": 0, "near_true": 0}
kinds = {}
day = first
while day <= last:
    if day.weekday() < 5:  # Monday to Friday keys
        s = int(dt.datetime(day.year, day.month, day.day, 21, tzinfo=UTC).timestamp() * 1000) - 86400000
        e = s + 86400000
        key = day.strftime("%Y%m%d")
        out = psql(text.replace("{{START_MS}}", str(s)).replace("{{END_MS}}", str(e)), "-At", "-F", "\x1f")
        rows = [ln.split("\x1f") for ln in out.strip().split("\n") if ln]
        got = set()
        nears = {}
        for rt, inst, bar, side, verdict, data in rows:
            j = json.loads(data)
            if rt == "LINE":
                got.add((inst, bar, side, j["kind"], verdict))
                nears[(inst, bar, side, j["kind"])] = j.get("near_edge")
                kinds[(j["kind"], verdict)] = kinds.get((j["kind"], verdict), 0) + 1
                if j["kind"] == "out" and j.get("reach_check") not in ("same", "reached_bar_before_range"):
                    print(key, "reach_check", inst, bar, side, j.get("reach_check"))
                    bad += 1
            elif rt == "SUMMARY":
                tot["state_checked"] += j["state_checked"]
                tot["state_equal"] += j["state_equal"]
                if verdict != "OK":
                    tot["summary_not_ok"] += 1
                    if "--quiet" not in args:
                        print(key, inst, verdict, j.get("attention"), j.get("no_data_why"))
            if show == key:
                print(rt, inst, bar, side, verdict, data[:1500])
        want = set()
        for x in expect:
            if x["kind"] == "open":
                continue
            if x["kind"] == "out":
                in_day = s <= x["bar"] < e
                late_in_day = x["bar"] < s and s <= x["seenAt"] < e
                if in_day or late_in_day:
                    want.add((x["pair"], fmt(x["bar"]), x["side"], "out", "ok"))
                    if in_day and "near" in x:
                        tot["near_checked"] += 1
                        if nears.get((x["pair"], fmt(x["bar"]), x["side"], "out")) != x["near"]:
                            bad += 1
                            print(key, "NEAR (touch) differs", x["pair"], fmt(x["bar"]), x["side"], nears.get((x["pair"], fmt(x["bar"]), x["side"], "out")), x["near"])
            elif s <= x["bar"] < e:
                want.add((x["pair"], fmt(x["bar"]), x["side"], x["kind"], x["verdict"]))
                if "near" in x:
                    tot["near_checked"] += 1
                    tot["near_true"] += 1 if x["near"] else 0
                    if nears.get((x["pair"], fmt(x["bar"]), x["side"], x["kind"])) != x["near"]:
                        bad += 1
                        print(key, "NEAR differs", x["pair"], fmt(x["bar"]), x["side"], x["kind"], nears.get((x["pair"], fmt(x["bar"]), x["side"], x["kind"])), x["near"])
        tot["days"] += 1
        tot["lines"] += len(got)
        if got != want:
            bad += 1
            print(key, "DIFF only in SQL:", sorted(got - want), "only in sim:", sorted(want - got))
    day += dt.timedelta(days=1)
print("days", tot["days"], "lines", tot["lines"], "summaries not OK", tot["summary_not_ok"], "state checked/equal", tot["state_checked"], tot["state_equal"], "DIFFS", bad)
print("near_edge checked", tot["near_checked"], "of them true (closes)", tot["near_true"])
print("lines by kind and verdict:", dict(sorted(kinds.items())))
