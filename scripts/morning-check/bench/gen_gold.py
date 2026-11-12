#!/usr/bin/env python3
"""Synthetic gold data for the local test bench of morning-check v9: the stored 1-hour row (Twelve Data's bars) and the recorded minutes (Swissquote's mid).

usage: python3 -I gen_gold.py SEED OUTDIR
writes OUTDIR/gold.sql   (the row of public.live_chart_fallback and the rows of public.gold_tick_bars)
       OUTDIR/bars.json  ({"XAU_USD": {pair, d, gold: true, bars: [[openMs, open, high, low, close]], ticks: {openMs: [maxHigh, minLow, lastClose]}}})
The two feeds differ a little, and now and then by a spike, so that a touch is sometimes seen by one of them only.
"""
import datetime as dt
import json
import random
import sys

seed = int(sys.argv[1])
out = sys.argv[2]
rnd = random.Random(seed * 7919)
UTC = dt.timezone.utc
H0 = dt.datetime(2026, 9, 20, 22, tzinfo=UTC)
H1 = dt.datetime(2027, 1, 8, 21, tzinfo=UTC)


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
vol = 0.0009 * px
drift = 0.0
spell = 0
bars = []
ticks = {}
tick_rows = []
t = H0
while t < H1:
    if is_open(t):
        if spell <= 0:
            spell = rnd.randint(8, 40)
            drift = rnd.choice([-0.55, -0.3, 0.0, 0.0, 0.3, 0.55]) * vol
        spell -= 1
        o = px
        p = float(o)
        mins = []
        for m in range(60):
            mo = p
            hi = lo = p
            for _ in range(3):
                p += rnd.gauss(drift / 180, vol / 180 ** 0.5)
                hi = max(hi, p)
                lo = min(lo, p)
            mins.append((m, mo, hi, lo, p))
        c = round(p)
        hi = max(max(x[2] for x in mins), o, c)
        lo = min(min(x[3] for x in mins), o, c)
        # Twelve Data's bar: its own high and low, a few cents off the minutes' (another feed); now and then one feed has a spike the other has not
        # (so that a touch is sometimes seen by the stored bar only, found late by a close's catch-up, and sometimes by the minutes only)
        th = round(hi) + rnd.randint(-6, 6)
        tl = round(lo) + rnd.randint(-6, 6)
        if rnd.random() < 0.12:
            th += rnd.randint(30, 160)
        if rnd.random() < 0.12:
            tl -= rnd.randint(30, 160)
        if rnd.random() < 0.12:
            k = max(range(60), key=lambda i: mins[i][2])  # the minute that holds the hour's high
            mins[k] = (mins[k][0], mins[k][1], mins[k][2] + rnd.randint(30, 160), mins[k][3], mins[k][4])
        if rnd.random() < 0.12:
            k = min(range(60), key=lambda i: mins[i][3])  # the minute that holds the hour's low
            mins[k] = (mins[k][0], mins[k][1], mins[k][2], mins[k][3] - rnd.randint(30, 160), mins[k][4])
        th = max(th, o, c)
        tl = min(tl, o, c)
        ms = int(t.timestamp() * 1000)
        bars.append([ms, o / 100, th / 100, tl / 100, c / 100])
        # the recorded minutes: numeric with three decimals (a mid), a few minutes missing now and then
        kept = [x for x in mins if rnd.random() > 0.03]
        if kept and rnd.random() > 0.02:
            mh = max(round(x[2] * 10) for x in kept) / 1000
            ml = min(round(x[3] * 10) for x in kept) / 1000
            ticks[str(ms)] = [mh, ml, round(kept[-1][4] * 10) / 1000]
            for m, mo, xh, xl, xc in kept:
                mt = (t + dt.timedelta(minutes=m)).strftime("%Y-%m-%dT%H:%M:00Z")
                tick_rows.append(f"('{mt}', {round(mo * 10) / 1000}, {round(xh * 10) / 1000}, {round(xl * 10) / 1000}, {round(xc * 10) / 1000}, '{mt}', '{mt}', 3, 'swissquote')")
        px = c
    t += dt.timedelta(hours=1)

row = [{"datetime": dt.datetime.fromtimestamp(b[0] / 1000, UTC).strftime("%Y-%m-%d %H:%M:%S"), "open": b[1], "high": b[2], "low": b[3], "close": b[4]} for b in bars]
with open(f"{out}/gold.sql", "w", encoding="utf-8") as f:
    f.write("insert into public.live_chart_fallback (pair, interval, bars, source, fetched_at) values ('XAU/USD', '1h', '" + json.dumps(row, separators=(",", ":")) + "'::jsonb, 'twelvedata', '" + (H1 + dt.timedelta(minutes=1)).strftime("%Y-%m-%dT%H:%M:%SZ") + "');\n")
    for i in range(0, len(tick_rows), 2000):
        f.write("insert into public.gold_tick_bars (minute, open, high, low, close, first_at, last_at, samples, source) values\n" + ",\n".join(tick_rows[i:i + 2000]) + ";\n")
with open(f"{out}/bars.json", "w", encoding="utf-8") as f:
    json.dump({"XAU_USD": {"pair": "XAU/USD", "d": 2, "gold": True, "bars": bars, "ticks": ticks}}, f)
print("gold bars", len(bars), "hours with minutes", len(ticks), "minute rows", len(tick_rows))
