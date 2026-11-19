#!/usr/bin/env python3
"""Synthetic GMO 15-minute day files (BID and ASK) for the five pairs, for the local test bench of morning-check v12 (README.md v12.4).

usage: python3 -I gen12.py SEED OUTDIR
writes OUTDIR/files.tsv  (symbol, price_type, interval, date_key, body json: the rows of public.gmo_kline_files, interval '15min')
       OUTDIR/bars.json  (the same bars for the Deno side: {symbol: {pair, d, bars: [[openMs, bid o,h,l,c, ask o,h,l,c] as strings]}})
gen.py (the v9 / v11 bench's 1-hour generator) on 15-minute bars: the same walk with trending spells (so that the MACD line goes to the pane's edges often), the same spreads
(the ask is the bid plus 2 to 5 ticks, field by field, so the mids carry half ticks), the same winter hours (Sunday 22:00 to Friday 22:00 UTC) and the same day keys (a bar
opened at t belongs to the GMO day of t + 3 h: key K holds K-1 21:00 .. K 20:45; a Saturday key holds the Friday 21:00 .. 21:45 bars).
"""
import datetime as dt
import json
import random
import sys

seed = int(sys.argv[1])
out = sys.argv[2]
rnd = random.Random(seed * 104729)
UTC = dt.timezone.utc
STEP = dt.timedelta(minutes=15)
H0 = dt.datetime(2026, 11, 1, 22, tzinfo=UTC)
H1 = dt.datetime(2026, 12, 31, 22, tzinfo=UTC)
SYMS = [("USD_JPY", "USD/JPY", 3, 158.6), ("EUR_JPY", "EUR/JPY", 3, 177.1), ("AUD_JPY", "AUD/JPY", 3, 109.2), ("EUR_USD", "EUR/USD", 5, 1.1086), ("AUD_USD", "AUD/USD", 5, 0.6840)]


def is_open(t):
    # winter hours: Sunday 22:00 UTC to Friday 22:00 UTC
    wd, h = t.weekday(), t.hour  # Monday = 0
    if wd == 5:
        return False
    if wd == 6:
        return h >= 22
    if wd == 4:
        return h < 22
    return True


def key_of(t):
    return (t + dt.timedelta(hours=3)).strftime("%Y%m%d")


files = {}
bars_out = {}
for sym, pair, d, base in SYMS:
    tick = 10 ** -d
    px = round(base / tick)  # in ticks (bid)
    vol = 0.0003 * base / tick  # ticks of one 15-minute bar's standard deviation (half the hour's of gen.py)
    drift = 0.0
    spell = 0
    rows = []
    t = H0
    while t < H1:
        if is_open(t):
            if spell <= 0:
                spell = rnd.randint(30, 160)
                drift = rnd.choice([-0.3, -0.16, 0.0, 0.0, 0.16, 0.3]) * vol
            spell -= 1
            o = px
            hi = lo = o
            p = o
            for _ in range(3):
                p += rnd.gauss(drift / 3, vol / 3 ** 0.5)
                hi = max(hi, p)
                lo = min(lo, p)
            c = round(p)
            bo, bh, bl, bc = o, max(round(hi), o, c), min(round(lo), o, c), c
            so, sh, sl, sc = (rnd.randint(2, 5) for _ in range(4))
            ao, ah, al, ac = bo + so, bh + sh, bl + sl, bc + sc
            ah = max(ah, ao, ac)
            al = min(al, ao, ac)
            f = lambda v: f"{v * tick:.{d}f}"
            rows.append((int(t.timestamp() * 1000), f(bo), f(bh), f(bl), f(bc), f(ao), f(ah), f(al), f(ac)))
            px = c
        t += STEP
    bars_out[sym] = {"pair": pair, "d": d, "bars": rows}
    for r in rows:
        k = key_of(dt.datetime.fromtimestamp(r[0] / 1000, UTC))
        files.setdefault((sym, "BID", k), []).append({"openTime": str(r[0]), "open": r[1], "high": r[2], "low": r[3], "close": r[4]})
        files.setdefault((sym, "ASK", k), []).append({"openTime": str(r[0]), "open": r[5], "high": r[6], "low": r[7], "close": r[8]})

with open(f"{out}/files.tsv", "w", encoding="utf-8") as f:
    for (sym, side, k), data in sorted(files.items()):
        day = dt.datetime.strptime(k, "%Y%m%d")
        body = {"status": 0, "data": data, "responsetime": day.strftime("%Y-%m-%dT21:00:0") + f"{rnd.randint(1, 4)}.{rnd.randint(100, 999)}Z"}
        f.write("\t".join([sym, side, "15min", k, json.dumps(body, separators=(",", ":"))]) + "\n")
with open(f"{out}/bars.json", "w", encoding="utf-8") as f:
    json.dump(bars_out, f)
print("files", len(files), "bars per symbol", {s: len(v["bars"]) for s, v in bars_out.items()})
