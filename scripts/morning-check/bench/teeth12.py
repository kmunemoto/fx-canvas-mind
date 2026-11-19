#!/usr/bin/env python3
"""Local test bench of morning-check v12 (README.md v12.4): the statements changed on purpose (teeth11.py on 15-minute bars, with the switch's parts). Each change is made
to pairs-v12.min.sql and gold-v12.min.sql (one place, or every copy of one constant), then the days are compared again (check12.py on some GMO days, the switch day and a
Saturday key included, the pairs and gold) and, when that does not catch it, the rows changed on purpose (scen12.py). A change nobody catches is a blind spot of the
bench. The data folders must already be loaded (check12.py --load).

usage: python3 -I teeth12.py PAIRS_DATADIR GOLD_DATADIR [--dbp NAME] [--dbg NAME] [--from YYYYMMDD] [--to YYYYMMDD] [--only TEXT]  (--only: the changes whose name holds TEXT)
"""
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
args = sys.argv[1:]
pdir, gdir = args[0], args[1]
opt = lambda k, default=None: (args[args.index(k) + 1] if k in args else default)
DBP, DBG = opt("--dbp", "mc12p"), opt("--dbg", "mc12g")
FROM, TO = opt("--from", "20261123"), opt("--to", "20261128")
base = {k: open(os.path.join(HERE, "..", f"{k}-v12.min.sql"), encoding="utf-8").read() for k in ("pairs", "gold")}
RULE = "macdx_12_26_9_w600_15min_fade96of120_in_v12"

# (name, [(old, new, count)]): each old text must occur exactly `count` times in BOTH statements (count 0: in the pairs' only)
CHANGES = [
    ("share 0.96 -> 0.95 everywhere (v7's)", [("0.96::float8", "0.95::float8", 8)]),
    ("share 0.96 -> 0.97 everywhere", [("0.96::float8", "0.97::float8", 8)]),
    ("Zp (the bar before) at 0.95, Z at 0.96", [("(f.tp > 0 and f.mp >= 0.96::float8 * f.tp) as p_top, (f.bp < 0 and f.mp <= 0.96::float8 * f.bp) as p_bot",
                                               "(f.tp > 0 and f.mp >= 0.95::float8 * f.tp) as p_top, (f.bp < 0 and f.mp <= 0.95::float8 * f.bp) as p_bot", 1)]),
    ("near_edge's decision at 0.95", [("b.nm >= 0.96::float8 * e.t2", "b.nm >= 0.95::float8 * e.t2", 1), ("b.nm <= 0.96::float8 * e.b2", "b.nm <= 0.95::float8 * e.b2", 1)]),
    ("the side the flow's, not the fade's (top BUY, bottom SELL)", [("case when b.in_top and not b.p_top then 'SELL' when b.in_bot and not b.p_bot then 'BUY' end as sd",
                                                                     "case when b.in_top and not b.p_top then 'BUY' when b.in_bot and not b.p_bot then 'SELL' end as sd", 1)]),
    ("the bar before read from the bar itself (Zp = Z)", [("(f.tp > 0 and f.mp >= 0.96::float8 * f.tp) as p_top, (f.bp < 0 and f.mp <= 0.96::float8 * f.bp) as p_bot",
                                                           "(f.tn > 0 and f.m >= 0.96::float8 * f.tn) as p_top, (f.bn < 0 and f.m <= 0.96::float8 * f.bn) as p_bot", 1)]),
    ("the price in from the other side of the book (pairs)", [("ac as paid_buy, bc as paid_sell", "bc as paid_buy, ac as paid_sell", 0)]),
    ("the price in the mid close for the pairs", [("coalesce(case j.side when 'BUY' then pd.paid_buy when 'SELL' then pd.paid_sell end, x.clo::float8) as x_paid",
                                                   "x.clo::float8 as x_paid", 1)]),
    ("entry_diff_ticks against the close, not the price in", [("case when j2.entry is not null and j2.x_paid is not null\nthen round(((case when abs(j2.entry_max - j2.x_paid) > abs(j2.entry - j2.x_paid) then j2.entry_max else j2.entry end) - j2.x_paid)",
                                                              "case when j2.entry is not null and j2.x_clo is not null\nthen round(((case when abs(j2.entry_max - j2.x_clo) > abs(j2.entry - j2.x_clo) then j2.entry_max else j2.entry end) - j2.x_clo)", 1)]),
    ("other_side never told", [("from mails group by pair, ot having count(*) > 1)", "from mails group by pair, ot having count(*) > 2)", 1)]),
    ("a target not counted (stop only)", [("count(*) filter (where a.stop is not null or a.target is not null) as n_st", "count(*) filter (where a.stop is not null) as n_st", 1)]),
    ("a stop not counted (target only)", [("count(*) filter (where a.stop is not null or a.target is not null) as n_st", "count(*) filter (where a.target is not null) as n_st", 1)]),
    ("the mails read under v11's id on the 1-hour chart", [(f"where a.kind = 'signal' and a.interval = '15min' and a.rule = '{RULE}'",
                                                            "where a.kind = 'signal' and a.interval = '1h' and a.rule = 'macdx_12_26_9_w600_1h_fade96of120_in_v11'", 1)]),
    ("the mails read on the 1-hour chart under the new id", [(f"where a.kind = 'signal' and a.interval = '15min' and a.rule = '{RULE}'",
                                                             f"where a.kind = 'signal' and a.interval = '1h' and a.rule = '{RULE}'", 1)]),
    ("the subscriptions read on '1h' (v11's)", [("where interval = '15min' and rule = 'macdx' group by pair", "where interval = '1h' and rule = 'macdx' group by pair", 1)]),
    ("the other macdx rows read as v11 did (the 1-hour chart only)", [(f"a.interval in ('1h', '15min') and a.rule like 'macdx%' and not (a.interval = '15min' and a.rule = '{RULE}')",
                                                                      f"a.interval = '1h' and a.rule like 'macdx%' and a.rule <> '{RULE}'", 1)]),
    ("the files read on '1hour' (v11's FRONT, pairs)", [("where f.interval = '15min' and f.price_type in ('BID', 'ASK')", "where f.interval = '1hour' and f.price_type in ('BID', 'ASK')", 0)]),
    ("the weekend window an hour later", [("(j2.cdw = 5 and j2.chh >= 21)", "(j2.cdw = 5 and j2.chh >= 22)", 1)]),
    ("the close time an hour after the open (v11's) in the weekend window", [("extract(dow from to_timestamp((j.ot + 900000) / 1000.0) at time zone 'UTC') as cdw,\nextract(hour from to_timestamp((j.ot + 900000) / 1000.0) at time zone 'UTC') as chh",
                                                                               "extract(dow from to_timestamp((j.ot + 3600000) / 1000.0) at time zone 'UTC') as cdw,\nextract(hour from to_timestamp((j.ot + 3600000) / 1000.0) at time zone 'UTC') as chh", 1)]),
    ("go-live never applied", [("case when j2.ot < j2.live_ms then 'before_go_live' end", "case when false then 'before_go_live' end", 1)]),
    ("go-live read one bar late (ot <= live_ms)", [("case when j2.ot < j2.live_ms then 'before_go_live' end", "case when j2.ot <= j2.live_ms then 'before_go_live' end", 1)]),
    ("late 1-hour rows read on the bar's open, not its close", [("and a.bar_time + interval '1 hour' > to_timestamp(y.end_1h_ms / 1000.0)", "and a.bar_time > to_timestamp(y.end_1h_ms / 1000.0)", 1)]),
    ("late 1-hour rows from the bar that ends at end_1h_ms (>=)", [("and a.bar_time + interval '1 hour' > to_timestamp(y.end_1h_ms / 1000.0)", "and a.bar_time + interval '1 hour' >= to_timestamp(y.end_1h_ms / 1000.0)", 1)]),
    ("late 1-hour rows never told in attention", [("case when coalesce(lt.n, 0) > 0 then 'macdx_1h_rows_after_end_1h=' || lt.n end,", "", 1)]),
    ("the switch's gap from the bar after end_1h_ms", [("count(h) filter (where h >= y.end_1h_ms and h < y.live_ms) as gap_bars", "count(h) filter (where h > y.end_1h_ms and h < y.live_ms) as gap_bars", 1)]),
    ("the switch's overlap counted in whole hours", [("count(h) filter (where h >= y.live_ms and h + 900000 <= y.end_1h_ms) as overlap_bars", "count(h) filter (where h >= y.live_ms and h + 3600000 <= y.end_1h_ms) as overlap_bars", 1)]),
    ("the day's end an hour before the range's end (v11's, pairs)", [("(ss.day_bars > 0 and ss.last_day_ot <> pp.end_ms - 900000) as cut", "(ss.day_bars > 0 and ss.last_day_ot <> pp.end_ms - 3600000) as cut", 0)]),
]

tmp = tempfile.mkdtemp(prefix="teeth12-")
caught = 0
ran = 0
for name, subs in CHANGES:
    if opt("--only") and opt("--only") not in name:
        continue
    texts = dict(base)
    bad = None
    for old, new, n in subs:
        for k in ("pairs", "gold"):
            want = n if n else (1 if k == "pairs" else 0)
            if texts[k].count(old) != want:
                bad = f"{k}: '{old[:60]}' occurs {texts[k].count(old)} times, not {want}"
            texts[k] = texts[k].replace(old, new)
    if bad:
        print(f"SETUP ERROR  {name}: {bad}")
        continue
    paths = {}
    for k, t in texts.items():
        paths[k] = os.path.join(tmp, f"{k}.sql")
        with open(paths[k], "w", encoding="utf-8") as f:
            f.write(t)
    how = None
    for kind, ddir, db in (("pairs", pdir, DBP), ("gold", gdir, DBG)):
        r = subprocess.run([sys.executable, "-I", os.path.join(HERE, "check12.py"), ddir, "--kind", kind, "--db", db, "--sql", paths[kind], "--from", FROM, "--to", TO,
                            "--saturdays", "--quiet"], capture_output=True, text=True)
        if r.returncode == 1:
            how = f"days ({kind}): " + next((ln for ln in r.stdout.split("\n") if ln.startswith(f"{kind}: days ")), "?")
            break
        if r.returncode != 0:
            how = f"days ({kind}): the statement failed: " + (r.stdout + r.stderr)[-300:]
            break
    if not how:
        s = subprocess.run([sys.executable, "-I", os.path.join(HERE, "scen12.py"), pdir, gdir, "--dbp", DBP, "--dbg", DBG, "--pairs", paths["pairs"], "--gold", paths["gold"]],
                           capture_output=True, text=True)
        if s.returncode:
            fails = [ln[5:].split(":")[0] for ln in s.stdout.split("\n") if ln.startswith("FAIL ")]
            how = f"scenarios only: {len(fails)} failed ({'; '.join(fails[:4])}{' ...' if len(fails) > 4 else ''})"
    ran += 1
    caught += 1 if how else 0
    print(("CAUGHT       " if how else "NOT CAUGHT   ") + name + (f"  <- {how}" if how else ""))
    sys.stdout.flush()
print(f"changes run {ran} (of {len(CHANGES)}), caught {caught}, not caught {ran - caught}")
