#!/usr/bin/env python3
"""Local test bench of morning-check v9: does the bench have teeth? The statement is changed on purpose, one place at a time, and the comparison
(check.py over the days, then scen.py) must fail for each change.

usage: python3 -I teeth.py DATADIR DB [NAME ...]     (DB must hold DATADIR's rows; the five pairs)
       MC_GOLD=1 python3 -I teeth.py DATADIR DB       (gold: the changes to what only gold's statement has, its two sources of highs and lows)
"""
import os
import re
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))

d, db = sys.argv[1], sys.argv[2]
only = sys.argv[3:]
GOLD = os.environ.get("MC_GOLD") == "1"
SRC = os.path.join(HERE, "..", "gold-v9.min.sql" if GOLD else "pairs-v9.min.sql")
text = open(SRC, encoding="utf-8").read()
G = [
    ("gold: the recorded minutes not read", "where g.minute >= to_timestamp(pp.start_ms / 1000.0) and g.minute < to_timestamp(pp.end_ms / 1000.0)", "where false and g.minute >= to_timestamp(pp.start_ms / 1000.0) and g.minute < to_timestamp(pp.end_ms / 1000.0)"),
    ("gold: the stored bar's high and low not read", "select symbol, ot, 'twelve'::text as src, h8, l8, d from us where ot >= (select start_ms from pp)", "select symbol, ot, 'twelve'::text as src, h8, l8, d from us where false and ot >= (select start_ms from pp)"),
    ("gold: the minutes counted in the hour after", "(floor(extract(epoch from g.minute) / 3600) * 3600000)::bigint as ot, 'ticks'::text", "(floor(extract(epoch from g.minute) / 3600) * 3600000 + 3600000)::bigint as ot, 'ticks'::text"),
    ("gold: the minutes' high from their lows", "max(g.high)::float8, min(g.low)::float8", "max(g.low)::float8, min(g.low)::float8"),
    ("gold: the stored bar's high from its close", "y.d, b.hi as h8, b.lo as l8", "y.d, b.cl as h8, b.lo as l8"),
    ("gold: touch 0.96 -> 0.97", "then e.edge > 0 and e.nm >= 0.96::float8 * e.edge else", "then e.edge > 0 and e.nm >= 0.97::float8 * e.edge else"),
    ("gold: the minutes counted in an hour with no state row (review 2026-11-13)", "(ts.src <> 'ticks' or exists (select 1 from st join syms y on y.pair = st.pair where y.symbol = ts.symbol and st.ot = ts.ot)) as counted", "(true) as counted"),
    ("gold: BUY and SELL swapped", "case when b.in_top and not b.p_top then 'BUY' when b.in_bot and not b.p_bot then 'SELL' end as sd", "case when b.in_top and not b.p_top then 'SELL' when b.in_bot and not b.p_bot then 'BUY' end as sd"),
]
M = [
    ("a reached bar with no data told as reach_differs (review 2026-11-13)", "when not exists (select 1 from tb b where b.symbol = y.symbol and b.ot = k.rot) then 'not_recounted'", "when false then 'not_recounted'"),
    ("in_top 0.9 -> 0.91", "(f.tn > 0 and f.m >= 0.9::float8 * f.tn) as in_top", "(f.tn > 0 and f.m >= 0.91::float8 * f.tn) as in_top"),
    ("in_bot 0.9 -> 0.89", "(f.bn < 0 and f.m <= 0.9::float8 * f.bn) as in_bot", "(f.bn < 0 and f.m <= 0.89::float8 * f.bn) as in_bot"),
    ("p_top 0.9 -> 0.92", "(f.tp > 0 and f.mp >= 0.9::float8 * f.tp) as p_top", "(f.tp > 0 and f.mp >= 0.92::float8 * f.tp) as p_top"),
    ("at_top 0.96 -> 0.95", "(f.tn > 0 and f.m >= 0.96::float8 * f.tn) as at_top", "(f.tn > 0 and f.m >= 0.95::float8 * f.tn) as at_top"),
    ("touch 0.96 -> 0.97", "then e.edge > 0 and e.nm >= 0.96::float8 * e.edge else", "then e.edge > 0 and e.nm >= 0.97::float8 * e.edge else"),
    ("touch bottom 0.96 -> 0.95", "else e.edge < 0 and e.nm <= 0.96::float8 * e.edge end as touch", "else e.edge < 0 and e.nm <= 0.95::float8 * e.edge end as touch"),
    ("BUY and SELL swapped", "case when b.in_top and not b.p_top then 'BUY' when b.in_bot and not b.p_bot then 'SELL' end as sd", "case when b.in_top and not b.p_top then 'SELL' when b.in_bot and not b.p_bot then 'BUY' end as sd"),
    ("skip: reached in this bar skips too", "r.eot < f.ot and (r.status = 'open' or r.rot > f.ot)", "r.eot < f.ot and (r.status = 'open' or r.rot >= f.ot)"),
    ("skip: only an open ride skips", "r.eot < f.ot and (r.status = 'open' or r.rot > f.ot)", "r.eot < f.ot and (r.status = 'open')"),
    ("quiet: a later reach quiets too", "r.status = 'reached' and r.rot = f.ot else", "r.status = 'reached' and r.rot >= f.ot else"),
    ("touch read from the wrong end", "(values ('top', 'h'), ('bottom', 'l')) z(zside, w)", "(values ('top', 'l'), ('bottom', 'h')) z(zside, w)"),
    ("touch counted in the entry bar", "and b.touch and b.ot > r.eot", "and b.touch and b.ot >= r.eot"),
    ("touch: EMA 26 with 2/26", "(2.0::float8 / 27.0::float8) * x.xv + (1 - (2.0::float8 / 27.0::float8)) * f.e26_p as ne26", "(2.0::float8 / 26.0::float8) * x.xv + (1 - (2.0::float8 / 26.0::float8)) * f.e26_p as ne26"),
    ("touch: the pane's edge without the 119 bars", "greatest(f.ta_p, b.nm, g.nsg, b.nm - g.nsg) else least(f.tb_p, b.nm, g.nsg, b.nm - g.nsg) end as edge", "greatest(b.nm, g.nsg, b.nm - g.nsg) else least(b.nm, g.nsg, b.nm - g.nsg) end as edge"),
    ("state: sig compared with e12", "and t.sig = f.sg_p and", "and t.sig = f.e12_p and"),
    ("high and low floored, not rounded", "(div(mant::numeric * p10, den) + case when 2 * mod(mant::numeric * p10, den) >= den then 1 else 0 end) / p10 as vn", "div(mant::numeric * p10, den) / p10 as vn"),
    ("high is the bid's alone", "(b.bh + a.ah) / 2 as h8", "b.bh as h8"),
    ("paid: ask and bid swapped", "ac as paid_buy, bc as paid_sell", "bc as paid_buy, ac as paid_sell"),
    ("ride side to pane side swapped", "b.zside = case r.side when 'BUY' then 'top' else 'bottom' end and b.touch", "b.zside = case r.side when 'BUY' then 'bottom' else 'top' end and b.touch"),
    ("mail kinds swapped", "then 'in' else 'at' end as kind, (extract(epoch from a.bar_time)", "then 'at' else 'in' end as kind, (extract(epoch from a.bar_time)"),
    ("email 2 joined on the reached bar", "full join mo m on m.pair = o.pair and m.side = o.side and m.eot = o.eot", "full join mo m on m.pair = o.pair and m.side = o.side and m.eot = o.rot"),
    ("weekend window from 22:00", "case when (c2.cdw = 5 and c2.chh >= 21) or c2.cdw = 6", "case when (c2.cdw = 5 and c2.chh >= 22) or c2.cdw = 6"),
    ("go-live one hour earlier", "1794466800000::bigint, 3), ('EUR_JPY', 'EUR/JPY', 2, 1794466800000::bigint, 3), ('AUD_JPY', 'AUD/JPY', 3, 1794466800000::bigint, 3),", "1794463200000::bigint, 3), ('EUR_JPY', 'EUR/JPY', 2, 1794463200000::bigint, 3), ('AUD_JPY', 'AUD/JPY', 3, 1794463200000::bigint, 3),"),
    ("dup never told", "when n_rows > greatest(subs, 1) then 'dup' else 'ok' end)\nwhen has_exp then (case when reasons", "when false then 'dup' else 'ok' end)\nwhen has_exp then (case when reasons"),
    ("rides read without those seen late", "or r.reached_at >= to_timestamp(pp.start_ms / 1000.0))", "or false)"),
]
# the scenarios count only when they pass with the statement as it is (a walk without a ride that is entered and reached in one day has none to play)
r0 = subprocess.run(["python3", "-I", os.path.join(HERE, "scen.py"), d, "--db", db, "--sql", SRC], capture_output=True, text=True)
m0 = re.search(r"failed \[(.*)\]", r0.stdout)
scen_ok = r0.returncode == 0 and m0 is not None and not m0.group(1)
print("scenarios with the statement as it is:", "pass" if scen_ok else "NOT usable on this data (not counted)", flush=True)
out = []
for name, a, b in (G if GOLD else M):
    if only and name not in only:
        continue
    n = text.count(a)
    if n != 1:
        out.append((name, f"PATTERN x{n}"))
        print(name, "-> PATTERN FOUND", n, "TIMES")
        continue
    f = os.path.join(tempfile.gettempdir(), f"mc9-mut-{db}.sql")
    open(f, "w", encoding="utf-8").write(text.replace(a, b))
    r = subprocess.run(["python3", "-I", os.path.join(HERE, "check.py"), d, "--db", db, "--sql", f, "--quiet"], capture_output=True, text=True)
    if GOLD:
        # the bench's gold has no bar opened Sunday 21:00 UTC: its Monday summaries are CHECK with the statement as it is (8 of 42 days), so only more than that counts
        r.stdout = re.sub(r"summaries not OK (\d+)", lambda m: "summaries not OK " + str(max(0, int(m.group(1)) - 8)), r.stdout)
    m = re.search(r"summaries not OK (\d+) state checked/equal (\d+) (\d+) DIFFS (\d+)", r.stdout)
    by_days = (r.returncode != 0) or (m is None) or int(m.group(1)) > 0 or m.group(2) != m.group(3) or int(m.group(4)) > 0
    how = "days" if by_days else ""
    if not by_days and scen_ok:
        r2 = subprocess.run(["python3", "-I", os.path.join(HERE, "scen.py"), d, "--db", db, "--sql", f], capture_output=True, text=True)
        m2 = re.search(r"failed \[(.*)\]", r2.stdout)
        if r2.returncode != 0 or m2 is None or m2.group(1):
            how = "scenarios"
    res = f"CAUGHT by {how}" if how else "NOT CAUGHT"
    out.append((name, res))
    print(name, "->", res, "|", (m.group(0) if m else r.stderr[:200] or r.stdout[-200:]).strip(), flush=True)
print("mutations", len(out), "caught", sum(1 for _, r in out if r.startswith("CAUGHT")), "not caught", [n for n, r in out if not r.startswith("CAUGHT")])
