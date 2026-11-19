#!/usr/bin/env python3
"""Local test bench of morning-check v12 (README.md v12.4): pairs1h-v11 (EUR/JPY, AUD/JPY and EUR/USD on v11's form, research/macdfade15min-prod-spec.md 7.3) against
pairs-v11 on v11's bench data (gen.py, then sim11.ts: the five pairs' 1-hour day files, v40's '1h' rows and subscriptions). For every GMO day both statements run on the same
database, and every SUMMARY and LINE row of the three pairs must be the same in both answers, in the same order (instrument, bar, side, verdict, and the data as the
statement wrote it); pairs1h-v11's answer must hold no row of another instrument, its RUN row must say `pairs1h.sql v11` (pairs-v11's `pairs.sql v11`), and the two RUN rows
must differ in nothing but `sql`, `lines`, `elapsed_s`, `db_now_utc`, `sql_md5` and `sql_chars`.

usage: python3 -I check1h.py DATADIR [--db NAME] [--load] [--from YYYYMMDD] [--to YYYYMMDD] [--saturdays] [--live-pairs MS] [--quiet] [--jobs N]
(the database: MC_PSQL, default "psql -h 127.0.0.1 -p 54361 -U postgres", and --db, default mc12h; --load loads DATADIR as check11.py --load does. Production's go-live
constant 1795003200000 in both statements is replaced by --live-pairs, by default the v11 bench's 2026-11-18 10:00 UTC, as check11.py does, so that the bench's mails are
after it.) Exit 1 on any difference.
"""
import concurrent.futures
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
DB = opt("--db", "mc12h")
PSQL = shlex.split(os.environ.get("MC_PSQL", "psql -h 127.0.0.1 -p 54361 -U postgres")) + ["-d", DB, "-q", "-v", "ON_ERROR_STOP=1"]
UTC = dt.timezone.utc
LIVE_P = int(opt("--live-pairs", str(int(dt.datetime(2026, 11, 18, 10, tzinfo=UTC).timestamp() * 1000))))
PROD_LIVE = "1795003200000::bigint"
THREE = {"EUR/JPY", "AUD/JPY", "EUR/USD"}
RUN_MAY_DIFFER = {"sql", "lines", "elapsed_s", "db_now_utc", "sql_md5", "sql_chars"}
TEXT = {k: open(os.path.join(HERE, "..", f"{k}.min.sql"), encoding="utf-8").read() for k in ("pairs-v11", "pairs1h-v11")}
for k, t in TEXT.items():
    if PROD_LIVE not in t:
        sys.exit(f"{k}.min.sql: no {PROD_LIVE} (go-live constant) to replace")


def psql(sql, *extra):
    r = subprocess.run(PSQL + list(extra), input=sql, capture_output=True, text=True)
    if r.returncode:
        sys.exit("psql failed: " + r.stderr[:3000])
    return r.stdout


def run(k, s, e):
    t = TEXT[k].replace("{{START_MS}}", str(s)).replace("{{END_MS}}", str(e)).replace(PROD_LIVE, f"{LIVE_P}::bigint")
    out = psql(t, "-At", "-F", "\x1f")
    return [tuple(ln.split("\x1f")) for ln in out.strip().split("\n") if ln]


if "--load" in args:
    psql("truncate public.gmo_kline_files, public.signal_alerts, public.signal_alert_subscriptions, public.live_chart_fallback, public.gold_tick_bars, public.twelve_data_usage;")
    psql(f"\\copy public.gmo_kline_files (symbol, price_type, interval, date_key, body) from '{d}/files.tsv'\n")
    psql(open(f"{d}/rows.sql", encoding="utf-8").read())
    print("loaded:", psql("select (select count(*) from public.gmo_kline_files) || ' files, ' || (select count(*) from public.signal_alerts) || ' mail rows, ' || (select count(*) from public.signal_alert_subscriptions) || ' subscriptions'", "-At").strip())

first = dt.datetime.strptime(opt("--from", "20261102"), "%Y%m%d").date()
last = dt.datetime.strptime(opt("--to", "20270108"), "%Y%m%d").date()
days = []
day = first
while day <= last:
    if day.weekday() < (6 if "--saturdays" in args else 5):  # Monday to Friday keys (and, with --saturdays, the Saturday keys)
        s = int(dt.datetime(day.year, day.month, day.day, 21, tzinfo=UTC).timestamp() * 1000) - 86400000
        days.append((day.strftime("%Y%m%d"), s, s + 86400000))
    day += dt.timedelta(days=1)
with concurrent.futures.ThreadPoolExecutor(max_workers=int(opt("--jobs", "3"))) as pool:
    a11 = dict(zip([k for k, _, _ in days], pool.map(lambda kse: run("pairs-v11", kse[1], kse[2]), days)))
    a1h = dict(zip([k for k, _, _ in days], pool.map(lambda kse: run("pairs1h-v11", kse[1], kse[2]), days)))

bad = 0
tot = {"days": 0, "summary_rows": 0, "line_rows": 0, "other_pairs_rows_in_pairs_v11": 0}
verdicts = {}


def differ(*msg):
    global bad
    bad += 1
    if bad <= 40:
        print(*msg)


for key, _, _ in days:
    old = [r for r in a11[key] if r[0] != "RUN" and r[1] in THREE]
    new = [r for r in a1h[key] if r[0] != "RUN"]
    tot["other_pairs_rows_in_pairs_v11"] += sum(1 for r in a11[key] if r[0] != "RUN" and r[1] not in THREE)
    if any(r[1] not in THREE for r in new):
        differ(key, "pairs1h-v11 has rows of", sorted({r[1] for r in new if r[1] not in THREE}))
    if old != new:
        only_old = [r[:5] for r in old if r not in new]
        only_new = [r[:5] for r in new if r not in old]
        differ(key, "rows differ: only in pairs-v11", only_old[:4], "only in pairs1h-v11", only_new[:4], "(or the order)" if not only_old and not only_new else "")
    run11 = [json.loads(r[5]) for r in a11[key] if r[0] == "RUN"]
    run1h = [json.loads(r[5]) for r in a1h[key] if r[0] == "RUN"]
    if len(run11) != 1 or len(run1h) != 1:
        differ(key, "RUN rows", len(run11), len(run1h))
        continue
    if run11[0].get("sql") != "pairs.sql v11" or run1h[0].get("sql") != "pairs1h.sql v11":
        differ(key, "RUN sql", run11[0].get("sql"), run1h[0].get("sql"))
    ka = {k: v for k, v in run11[0].items() if k not in RUN_MAY_DIFFER}
    kb = {k: v for k, v in run1h[0].items() if k not in RUN_MAY_DIFFER}
    if ka != kb:
        differ(key, "RUN differs beyond sql / lines / elapsed_s / db_now_utc / sql_md5 / sql_chars:", ka, kb)
    if run1h[0].get("lines") != sum(1 for r in new if r[0] == "LINE"):
        differ(key, "pairs1h-v11 RUN lines", run1h[0].get("lines"), "LINE rows", sum(1 for r in new if r[0] == "LINE"))
    tot["days"] += 1
    tot["summary_rows"] += sum(1 for r in new if r[0] == "SUMMARY")
    tot["line_rows"] += sum(1 for r in new if r[0] == "LINE")
    for r in new:
        if r[0] == "LINE":
            verdicts[r[4]] = verdicts.get(r[4], 0) + 1

print(f"pairs1h-v11 against pairs-v11: days {tot['days']}, the three pairs' SUMMARY rows {tot['summary_rows']} and LINE rows {tot['line_rows']} compared "
      f"(USD/JPY and AUD/USD rows of pairs-v11 left aside {tot['other_pairs_rows_in_pairs_v11']}), DIFFS {bad}")
print("LINE verdicts (the three pairs):", dict(sorted(verdicts.items())))
if tot["line_rows"] == 0 or tot["summary_rows"] == 0:
    print("nothing compared: the data has no row of the three pairs")
    sys.exit(1)
sys.exit(1 if bad else 0)
