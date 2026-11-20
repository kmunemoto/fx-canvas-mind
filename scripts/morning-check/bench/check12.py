#!/usr/bin/env python3
"""Local test bench of morning-check v12 (README.md v12.4): load a data folder (gen12.py or gen_gold12.py, then sim12.ts) into the local database, run pairs-v12 (or
gold-v12) for each GMO day, and compare its LINE rows with what the simulation (production's own code) says they should be: the set of (instrument, bar, side, verdict), and
per line the price in (`paid`), the close, `entry_diff_ticks` 0, the rows a follower, the reasons of a not_mailable line and near_edge; per instrument and day,
`expected_fires`, the switch's fields (`go_live_utc`, `end_1h_utc`, `switch_gap_bars`, `switch_overlap_bars`, worked out here from the constants) and
`macdx_1h_rows_after_end_1h` 0. check11.py on 15-minute bars.
The pairs are USD/JPY and AUD/USD only (research/macdfade15min-prod-spec.md 7.3, the per-pair form: sim12.ts follows and writes those two; gen12.py's other three pairs are
loaded but neither followed nor mailed): per day the SUMMARY rows must be of exactly those two (gold: XAU/USD), and pairs-v12's RUN `macdx_15min_rows_other_pairs` must be 0
(no 15-minute macdx row of another pair on a clean bench day); gold-v12's RUN has no such field.

usage: python3 -I check12.py DATADIR --kind pairs|gold [--db NAME] [--load] [--from YYYYMMDD] [--to YYYYMMDD] [--saturdays] [--sql FILE] [--live-pairs MS] [--live-gold MS]
       [--end-pairs MS] [--end-gold MS] [--show KEY] [--quiet] [--jobs N]
(the database: MC_PSQL, default "psql -h 127.0.0.1 -p 54361 -U postgres", and --db, default mc12p for the pairs and mc12g for gold. The go-live markers are replaced by
--live-pairs / --live-gold, by default the bench's 2026-11-25 10:00 / 09:45 UTC, the same as sim12.ts, and the markers of v40's end by --end-pairs / --end-gold, by default
2026-11-25 10:00 UTC for both: so the bench's pairs switch cleanly and gold has one bar judged by both forms, spec 6.2. --jobs: how many days are run at once, default 3;
the answers are compared in the days' order.) Exit 1 on any difference.
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
KIND = opt("--kind", "pairs")
assert KIND in ("pairs", "gold"), KIND
DB = opt("--db", "mc12p" if KIND == "pairs" else "mc12g")
PSQL = shlex.split(os.environ.get("MC_PSQL", "psql -h 127.0.0.1 -p 54361 -U postgres")) + ["-d", DB, "-q", "-v", "ON_ERROR_STOP=1"]
UTC = dt.timezone.utc
LIVE_P = int(opt("--live-pairs", str(int(dt.datetime(2026, 11, 25, 10, tzinfo=UTC).timestamp() * 1000))))
LIVE_G = int(opt("--live-gold", str(int(dt.datetime(2026, 11, 25, 9, 45, tzinfo=UTC).timestamp() * 1000))))
END_P = int(opt("--end-pairs", str(int(dt.datetime(2026, 11, 25, 10, tzinfo=UTC).timestamp() * 1000))))
END_G = int(opt("--end-gold", str(int(dt.datetime(2026, 11, 25, 10, tzinfo=UTC).timestamp() * 1000))))
FOLLOWERS = {"USD/JPY": 2}
INSTS = {"USD/JPY", "AUD/USD"} if KIND == "pairs" else {"XAU/USD"}


def psql(sql, *extra):
    r = subprocess.run(PSQL + list(extra), input=sql, capture_output=True, text=True)
    if r.returncode:
        sys.exit("psql failed: " + r.stderr[:3000])
    return r.stdout


# the go-live markers (README v12.1: set at the release; until then in the files) take the bench's instants. (Once the release sets them, the bench is run on a copy of
# the statement with the markers put back in place of the numbers, as check11.py did for v11.)


def run(text, s, e):
    t = text.replace("{{START_MS}}", str(s)).replace("{{END_MS}}", str(e)).replace("{{GO_LIVE_MS_PAIRS}}", str(LIVE_P)).replace("{{GO_LIVE_MS_GOLD}}", str(LIVE_G))
    t = t.replace("{{END_1H_MS_PAIRS}}", str(END_P)).replace("{{END_1H_MS_GOLD}}", str(END_G))
    out = psql(t, "-At", "-F", "\x1f")
    return [ln.split("\x1f") for ln in out.strip().split("\n") if ln]


if "--load" in args:
    psql("truncate public.gmo_kline_files, public.signal_alerts, public.signal_alert_subscriptions, public.live_chart_fallback, public.gold_tick_bars, public.twelve_data_usage;")
    if os.path.exists(f"{d}/files.tsv"):
        psql(f"\\copy public.gmo_kline_files (symbol, price_type, interval, date_key, body) from '{d}/files.tsv'\n")
    if os.path.exists(f"{d}/gold.sql"):
        psql(open(f"{d}/gold.sql", encoding="utf-8").read())
    psql(open(f"{d}/rows.sql", encoding="utf-8").read())
    print("loaded:", psql("select (select count(*) from public.gmo_kline_files) || ' files, ' || (select count(*) from public.live_chart_fallback) || ' gold rows, ' || (select count(*) from public.signal_alerts) || ' mail rows, ' || (select count(*) from public.signal_alert_subscriptions) || ' subscriptions'", "-At").strip())

expect = json.load(open(f"{d}/expect.json", encoding="utf-8"))
text = open(opt("--sql", os.path.join(HERE, "..", f"{KIND}-v12.min.sql")), encoding="utf-8").read()
first = dt.datetime.strptime(opt("--from", "20261112"), "%Y%m%d").date()
last = dt.datetime.strptime(opt("--to", "20261231"), "%Y%m%d").date()
LIVE, END = (LIVE_P, END_P) if KIND == "pairs" else (LIVE_G, END_G)
show = opt("--show")
fmt = lambda ms: dt.datetime.fromtimestamp(ms / 1000, UTC).strftime("%Y-%m-%d %H:%M")
bad = 0
tot = {"days": 0, "lines": 0, "values_checked": 0, "near_true": 0}
verdicts = {}
summaries = {}


def differ(*msg):
    global bad
    bad += 1
    if bad <= 40:
        print(*msg)


days = []
day = first
while day <= last:
    if day.weekday() < (6 if "--saturdays" in args else 5):  # Monday to Friday keys (and, with --saturdays, the Saturday keys: they hold the Friday 21:00 bar)
        s = int(dt.datetime(day.year, day.month, day.day, 21, tzinfo=UTC).timestamp() * 1000) - 86400000
        days.append((day.strftime("%Y%m%d"), s, s + 86400000))
    day += dt.timedelta(days=1)
# the statement for every day (read only: the days may run at once), then the answers compared one day after the other
with concurrent.futures.ThreadPoolExecutor(max_workers=int(opt("--jobs", "3"))) as pool:
    answers = dict(zip([k for k, _, _ in days], pool.map(lambda kse: run(text, kse[1], kse[2]), days)))
for key, s, e in days:
    want = {}
    for x in expect:
        if s <= x["bar"] < e:
            want[(x["pair"], fmt(x["bar"]), x["side"])] = x
    got = {}
    fires = {}
    for rt, inst, bar, side, verdict, data in answers[key]:
        j = json.loads(data)
        if show == key:
            print(rt, inst, bar, side, verdict, data[:1200])
        if rt == "RUN":
            # pairs-v12: the day's 15-minute macdx rows of a pair not in syms (a finding above 0); gold-v12: no such field (its slot is empty)
            if (KIND == "pairs" and j.get("macdx_15min_rows_other_pairs") != 0) or (KIND == "gold" and "macdx_15min_rows_other_pairs" in j):
                differ(key, "RUN macdx_15min_rows_other_pairs", j.get("macdx_15min_rows_other_pairs", "absent"))
        if rt == "LINE":
            got[(inst, bar, side)] = (verdict, j)
            verdicts[verdict] = verdicts.get(verdict, 0) + 1
        elif rt == "SUMMARY":
            fires[inst] = j["expected_fires"]
            # the switch's fields, worked out here from the constants: the 15-minute slots of the day judged by neither form [END, LIVE) and by both [LIVE, END - 15 min]
            slots = range(s, e, 900000)
            want_sw = {"go_live_utc": fmt(LIVE), "end_1h_utc": fmt(END), "switch_gap_bars": sum(1 for h in slots if END <= h < LIVE),
                       "switch_overlap_bars": sum(1 for h in slots if LIVE <= h and h + 900000 <= END), "macdx_1h_rows_after_end_1h": 0}
            for kk, vv in want_sw.items():
                if j.get(kk) != vv:
                    differ(key, inst, kk, j.get(kk), "want", vv)
            tot["switch_days"] = tot.get("switch_days", 0) + (1 if want_sw["switch_gap_bars"] or want_sw["switch_overlap_bars"] else 0)
            tag = verdict if verdict == "OK" else f"{verdict} [{j.get('attention')}{'; ' + j['no_data_why'] if j.get('no_data_why') else ''}]"
            summaries.setdefault(tag, []).append(f"{key} {inst}")
    insts = {inst for rt, inst, _, _, _, _ in answers[key] if rt == "SUMMARY"}
    if insts != INSTS:
        differ(key, "SUMMARY instruments", sorted(insts), "want", sorted(INSTS))
    tot["days"] += 1
    tot["lines"] += len(got)
    if set(got) != set(want):
        differ(key, "LINE set differs: only in SQL", sorted(set(got) - set(want)), "only in sim", sorted(set(want) - set(got)))
    for k, x in want.items():
        if k not in got:
            continue
        verdict, j = got[k]
        tot["values_checked"] += 1
        tot["near_true"] += 1 if x["near"] else 0
        if verdict != x["verdict"]:
            differ(key, k, "verdict", verdict, "sim", x["verdict"])
        if j.get("paid") != x["price"]:
            differ(key, k, "paid", j.get("paid"), "sim price", x["price"])
        if j.get("close") != x["close"]:
            differ(key, k, "close", j.get("close"), "sim close", x["close"])
        if j.get("near_edge") != x["near"]:
            differ(key, k, "near_edge", j.get("near_edge"), "sim", x["near"])
        if x["verdict"] == "ok":
            if j.get("entry_diff_ticks") != 0:
                differ(key, k, "entry_diff_ticks", j.get("entry_diff_ticks"))
            if j.get("mail_rows") != FOLLOWERS.get(k[0], 1) or j.get("mail_status") != "sent":
                differ(key, k, "mail_rows / status", j.get("mail_rows"), j.get("mail_status"))
            if j.get("why") is not None:
                differ(key, k, "why on an ok line", j.get("why"))
        else:
            if sorted((j.get("why") or "").split(";")) != sorted(x["why"].split(";")):
                differ(key, k, "why", j.get("why"), "sim", x["why"])
        for flag in ("other_side", "stop_or_target_rows"):
            if flag in j:
                differ(key, k, flag, j[flag])
    per = {}
    for (inst, _, _), x in want.items():
        per[inst] = per.get(inst, 0) + 1
    for inst, n in fires.items():
        if n != per.get(inst, 0):
            differ(key, inst, "expected_fires", n, "sim", per.get(inst, 0))

print(f"{KIND}: days {tot['days']}, lines {tot['lines']} (values checked on {tot['values_checked']}, near_edge true on {tot['near_true']}; SUMMARY rows with a switch gap or overlap {tot.get('switch_days', 0)}), DIFFS {bad}")
print("LINE verdicts:", dict(sorted(verdicts.items())))
for tag, where in sorted(summaries.items(), key=lambda kv: (kv[0] != "OK", kv[0])):
    print(f"SUMMARY {len(where)} x {tag}" + ("" if tag == "OK" or "--quiet" in args else ": " + ", ".join(where[:8]) + (" ..." if len(where) > 8 else "")))
sys.exit(1 if bad else 0)
