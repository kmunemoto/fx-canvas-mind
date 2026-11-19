#!/usr/bin/env python3
"""Synthetic gold data for the local test bench of morning-check v12 (README.md v12.4): the stored 15-minute row (Twelve Data's bars).

usage: python3 -I gen_gold12.py SEED OUTDIR
writes OUTDIR/gold.sql   (the row of public.live_chart_fallback, pair XAU/USD, interval '15min', read a minute after the period's end)
       OUTDIR/bars.json  ({"XAU_USD": {pair, d, gold: true, bars: [[openMs, open, high, low, close]]}})
gen_gold.py (the v9 / v11 bench's 1-hour generator) on 15-minute bars, without the recorded minutes (v12 does not read public.gold_tick_bars): the same walk with
trending spells, the same hours (Sunday 22:00 to Friday 21:00 UTC: the Friday 20:45 bar is the last, and it closes at 21:00, in the weekend window).
"""
import datetime as dt
import json
import random
import sys

seed = int(sys.argv[1])
out = sys.argv[2]
rnd = random.Random(seed * 7919 + 15)
UTC = dt.timezone.utc
STEP = dt.timedelta(minutes=15)
H0 = dt.datetime(2026, 11, 1, 22, tzinfo=UTC)
H1 = dt.datetime(2026, 12, 31, 21, tzinfo=UTC)


def is_open(t):
    wd, h = t.weekday(), t.hour
    if wd == 5:
        return False
    if wd == 6:
        return h >= 22
    if wd == 4:
        return h < 21
    return True


px = 398000  # cents
vol = 0.00045 * px
drift = 0.0
spell = 0
bars = []
t = H0
while t < H1:
    if is_open(t):
        if spell <= 0:
            spell = rnd.randint(30, 160)
            drift = rnd.choice([-0.3, -0.16, 0.0, 0.0, 0.16, 0.3]) * vol
        spell -= 1
        o = px
        p = float(o)
        hi = lo = p
        for _ in range(15):
            p += rnd.gauss(drift / 15, vol / 15 ** 0.5)
            hi = max(hi, p)
            lo = min(lo, p)
        c = round(p)
        th = max(round(hi) + rnd.randint(-6, 6), o, c)
        tl = min(round(lo) + rnd.randint(-6, 6), o, c)
        ms = int(t.timestamp() * 1000)
        bars.append([ms, o / 100, th / 100, tl / 100, c / 100])
        px = c
    t += STEP

row = [{"datetime": dt.datetime.fromtimestamp(b[0] / 1000, UTC).strftime("%Y-%m-%d %H:%M:%S"), "open": b[1], "high": b[2], "low": b[3], "close": b[4]} for b in bars]
with open(f"{out}/gold.sql", "w", encoding="utf-8") as f:
    f.write("insert into public.live_chart_fallback (pair, interval, bars, source, fetched_at) values ('XAU/USD', '15min', '" + json.dumps(row, separators=(",", ":")) + "'::jsonb, 'twelvedata', '" + (H1 + dt.timedelta(minutes=1)).strftime("%Y-%m-%dT%H:%M:%SZ") + "');\n")
with open(f"{out}/bars.json", "w", encoding="utf-8") as f:
    json.dump({"XAU_USD": {"pair": "XAU/USD", "d": 2, "gold": True, "bars": bars}}, f)
print("gold bars", len(bars))
