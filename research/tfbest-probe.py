#!/usr/bin/env python3
# #264-2 (docs §8.107 14 の 2): how the two feeds can be read, before anything is fetched for good. Numbers only:
# a price is read to be checked (is it inside the pair's band) and is never printed or kept; what comes out is
# statuses, counts, seconds and times (UTC).
#
#   duka-speed   Is Dukascopy's FX feed readable from GitHub's runners, and how fast: 300 files (5 pairs x 2 sides x
#                30 days spread over 2015-03-01..2023-12-31, Sunday to Friday) with 3 workers, then 100 other files
#                with 8 workers. Per file: the tries (a 503 is asked again after a wait, as research/dukascopy.py),
#                the seconds, the bytes, the candles, the band check.
#   duka-first   Each pair x side: the first UTC day with a file (a year at a time from 2003, then a binary search by
#                day; five days after it must have files too).
#   duka-sunday  Some Sundays (summer and winter, the weeks of New York's clock changes): the first candle of the
#                Sunday file and the last candle of the Friday before, for USDJPY and EURUSD.
#   gmo          GMO's klines: the 30-minute and 1-hour day files, the 4-hour, 8-hour and 1-day year files (2023), a
#                2-hour request (GMO has none: its answer), and every GMO day of 2024 and 2025 for USD_JPY's 1-hour
#                file (the days with no bars, and the days whose bars differ from that weekday's usual).
#
# Usage: python3 -I research/tfbest-probe.py --part duka-speed|duka-first|duka-sunday|gmo [--out DIR] [--workers N]
#        python3 -I research/tfbest-probe.py --selftest
# Read-only against the feeds; writes only under --out.

import argparse
import collections
import concurrent.futures as cf
import datetime as dt
import json
import lzma
import os
import statistics
import struct
import sys
import threading
import time
import urllib.error
import urllib.request

DUKA = "https://datafeed.dukascopy.com/datafeed"
GMO = "https://forex-api.coin.z.com/public/v1"
# symbol: (GMO's name, the price's integer scale in the feed, the band a price must stay inside)
PAIRS = {
    "USDJPY": ("USD_JPY", 1000, 70.0, 170.0),
    "EURJPY": ("EUR_JPY", 1000, 90.0, 180.0),
    "AUDJPY": ("AUD_JPY", 1000, 50.0, 115.0),
    "EURUSD": ("EUR_USD", 100000, 0.90, 1.65),
    "AUDUSD": ("AUD_USD", 100000, 0.50, 1.15),
}
SIDES = ("BID", "ASK")
RECORD = struct.Struct(">iiiiif")
UTC = dt.timezone.utc

lock = threading.Lock()
out_lines = []


def say(s=""):
    with lock:
        print(s, flush=True)
        out_lines.append(s)


def hhmm(ms):
    return dt.datetime.fromtimestamp(ms / 1000, UTC).strftime("%H:%M")


def stamp(ms):
    return dt.datetime.fromtimestamp(ms / 1000, UTC).strftime("%Y-%m-%d %H:%M")


def us_summer(d):
    """New York on summer time: the second Sunday of March to the first Sunday of November (the day itself is
    counted by its date; the clock changes at 2 o'clock local)"""
    mar1 = dt.date(d.year, 3, 1)
    start = mar1 + dt.timedelta(days=(6 - mar1.weekday()) % 7 + 7)
    nov1 = dt.date(d.year, 11, 1)
    end = nov1 + dt.timedelta(days=(6 - nov1.weekday()) % 7)
    return start <= d < end


# ---- Dukascopy -----------------------------------------------------------------------------------------------

def duka_url(symbol, side, day):
    return f"{DUKA}/{symbol}/{day.year}/{day.month - 1:02d}/{day.day:02d}/{side}_candles_min_1.bi5"


def decode(raw, day, symbol):
    """(candles, the first candle's ms, the last candle's ms, whether every close is inside the pair's band): the
    candles are those with a volume (a minute without a tick is filled by the feed)"""
    if not raw:
        return 0, None, None, True
    _, scale, lo, hi = PAIRS[symbol]
    data = lzma.decompress(raw, format=lzma.FORMAT_ALONE)
    if len(data) % RECORD.size:
        raise ValueError("not a whole number of candles")
    start = int(dt.datetime(day.year, day.month, day.day, tzinfo=UTC).timestamp() * 1000)
    n = 0
    first = last = None
    inband = True
    for off in range(0, len(data), RECORD.size):
        secs, o, c, l, h, vol = RECORD.unpack_from(data, off)
        if vol <= 0:
            continue
        n += 1
        ms = start + secs * 1000
        first = ms if first is None else first
        last = ms
        if not (lo <= c / scale <= hi):
            inband = False
    return n, first, last, inband


def fetch(url, timeout=60, attempts=6):
    """(status, body, tries, seconds): 200 with the file, 404, or None after `attempts` tries; tries is the list of
    what each try got ('503', 'timeout', '200')"""
    wait = 4.0
    tries = []
    t0 = time.monotonic()
    for k in range(attempts):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                body = r.read()
            tries.append("200")
            return 200, body, tries, time.monotonic() - t0
        except urllib.error.HTTPError as e:
            tries.append(str(e.code))
            if e.code == 404:
                return 404, b"", tries, time.monotonic() - t0
            if e.code not in (429, 500, 502, 503, 504):
                return None, b"", tries, time.monotonic() - t0
        except Exception as e:
            tries.append(type(e).__name__)
        if k < attempts - 1:
            time.sleep(wait)
            wait = min(wait * 2, 60.0)
    return None, b"", tries, time.monotonic() - t0


def one_file(symbol, side, day):
    status, body, tries, secs = fetch(duka_url(symbol, side, day))
    r = {"symbol": symbol, "side": side, "day": day.isoformat(), "status": status, "bytes": len(body), "tries": tries,
         "secs": secs, "candles": 0, "first": None, "last": None, "inband": True, "decode": None}
    if status == 200:
        try:
            r["candles"], r["first"], r["last"], r["inband"] = decode(body, day, symbol)
        except Exception as e:
            r["decode"] = type(e).__name__
    return r


def trading_days(a, b):
    """Sunday to Friday (a Saturday has no FX file worth asking for) from a to b"""
    out = []
    d = a
    while d <= b:
        if d.weekday() != 5:
            out.append(d)
        d += dt.timedelta(days=1)
    return out


def run_files(items, workers, budget):
    """items: (symbol, side, day). Stops asking for new files after `budget` seconds (the rest are counted as not
    tried)."""
    t0 = time.monotonic()
    results = []
    skipped = [0]

    def work(it):
        if time.monotonic() - t0 > budget:
            with lock:
                skipped[0] += 1
            return None
        return one_file(*it)

    with cf.ThreadPoolExecutor(max_workers=workers) as ex:
        for r in ex.map(work, items):
            if r is not None:
                results.append(r)
    return results, skipped[0], time.monotonic() - t0


def summarize(label, results, skipped, wall, workers):
    ok = [r for r in results if r["status"] == 200 and r["bytes"] > 0 and r["decode"] is None]
    empty = [r for r in results if r["status"] == 200 and r["bytes"] == 0]
    nf = [r for r in results if r["status"] == 404]
    failed = [r for r in results if r["status"] is None]
    broken = [r for r in results if r["decode"] is not None]
    secs = sorted(r["secs"] for r in results)
    refused = sum(1 for r in results for t in r["tries"] if t in ("429", "500", "502", "503", "504"))
    other = collections.Counter(t for r in results for t in r["tries"] if t not in ("200", "404", "429", "500", "502", "503", "504"))
    say(f"== {label}: {workers} workers, {len(results)} files tried, {skipped} not tried (the time budget), wall {wall:.0f} s")
    say(f"   readable {len(ok)}, 404 {len(nf)}, empty {len(empty)}, gave up {len(failed)}, could not decode {len(broken)}")
    say(f"   tries refused (429/5xx) {refused}, other trouble {dict(other)}")
    if secs:
        say(f"   seconds a file (all its tries): median {statistics.median(secs):.1f}, p90 {secs[int(0.9 * (len(secs) - 1))]:.1f}, max {secs[-1]:.1f}; files an hour at this speed {3600 * len(results) / max(wall, 1e-9):.0f}")
    if ok:
        sizes = [r["bytes"] for r in ok]
        say(f"   bytes a file: median {statistics.median(sizes):.0f}, max {max(sizes)}; candles a file: median {statistics.median(r['candles'] for r in ok):.0f}, min {min(r['candles'] for r in ok)}, max {max(r['candles'] for r in ok)}")
        say(f"   every close inside the pair's band: {sum(1 for r in ok if r['inband'])} of {len(ok)} files")
    for sym in PAIRS:
        for side in SIDES:
            rs = [r for r in results if r["symbol"] == sym and r["side"] == side]
            if rs:
                say(f"   {sym} {side}: readable {sum(1 for r in rs if r in ok)}, 404 {sum(1 for r in rs if r['status'] == 404)}, empty {sum(1 for r in rs if r['status'] == 200 and r['bytes'] == 0)}, gave up {sum(1 for r in rs if r['status'] is None)}")
    if nf:
        say("   404 days: " + ", ".join(f"{r['symbol']} {r['side']} {r['day']}" for r in nf[:30]))
    if failed:
        say("   gave up: " + ", ".join(f"{r['symbol']} {r['side']} {r['day']} ({'/'.join(r['tries'])})" for r in failed[:20]))


def part_duka_speed(args):
    days = trading_days(dt.date(2015, 3, 1), dt.date(2023, 12, 31))
    series = [(s, side) for s in PAIRS for side in SIDES]

    def pick(n, offset):
        return [days[(i * len(days)) // n + offset] for i in range(n)]

    first = [(s, side, d) for d in pick(30, 0) for (s, side) in series]
    second = [(s, side, d) for d in pick(10, 37) for (s, side) in series]
    r1, sk1, w1 = run_files(first, args.workers, args.budget)
    summarize("pass 1: 30 days x 10 series", r1, sk1, w1, args.workers)
    r2, sk2, w2 = run_files(second, 8, args.budget)
    summarize("pass 2: 10 other days x 10 series", r2, sk2, w2, 8)


def part_duka_first(args):
    def exists(symbol, side, day):
        r = one_file(symbol, side, day)
        return r["status"] == 200 and r["bytes"] > 0 and r["candles"] > 0 and r["decode"] is None

    def first_day(series):
        symbol, side = series
        yes_year = None
        last_no = None
        for y in range(2003, 2016):
            d = dt.date(y, 1, 8)
            d += dt.timedelta(days=(7 - d.weekday()) % 7)
            if exists(symbol, side, d):
                yes_year, first_yes = y, d
                break
            last_no = d
        if yes_year is None:
            return series, None, "no file in any January probe 2003..2015", 0
        if last_no is None:
            return series, first_yes, "the first probe (January 2003) already has a file; earlier years not searched", 0
        cand = [d for d in trading_days(last_no, first_yes) if d > last_no]
        lo, hi = 0, len(cand) - 1  # cand[hi] has a file
        while lo < hi:
            mid = (lo + hi) // 2
            if exists(symbol, side, cand[mid]):
                hi = mid
            else:
                lo = mid + 1
        day = cand[lo]
        after = [d for d in trading_days(day, day + dt.timedelta(days=9)) if d > day][:5]
        have = sum(1 for d in after if exists(symbol, side, d))
        return series, day, f"binary search between {last_no} and {first_yes}", have

    series = [(s, side) for s in PAIRS for side in SIDES]
    say("== first UTC day with a file (a year at a time from 2003, then a binary search by day; the 5 weekdays after it counted)")
    with cf.ThreadPoolExecutor(max_workers=args.workers) as ex:
        for (symbol, side), day, how, have in ex.map(first_day, series):
            say(f"   {symbol} {side}: {day.isoformat() if day else 'none'} ({how}); files on the next 5 weekdays: {have}")


def part_duka_sunday(args):
    sundays = [dt.date(2016, 1, 10), dt.date(2016, 3, 13), dt.date(2016, 3, 20), dt.date(2016, 7, 10), dt.date(2016, 11, 6),
               dt.date(2016, 11, 13), dt.date(2017, 7, 9), dt.date(2019, 1, 6), dt.date(2020, 3, 8), dt.date(2021, 7, 11),
               dt.date(2022, 12, 4), dt.date(2023, 7, 9), dt.date(2023, 12, 10)]
    items = []
    for s in ("USDJPY", "EURUSD"):
        for sun in sundays:
            items.append((s, "BID", sun))
            items.append((s, "BID", sun - dt.timedelta(days=2)))
    results, skipped, wall = run_files(items, args.workers, args.budget)
    by = {(r["symbol"], r["day"]): r for r in results}
    say("== the weekend's edges (UTC): the Sunday file's first and last candle, the Friday before it: first and last candle")
    for s in ("USDJPY", "EURUSD"):
        for sun in sundays:
            fri = sun - dt.timedelta(days=2)
            a, b = by.get((s, sun.isoformat())), by.get((s, fri.isoformat()))

            def f(r):
                if r is None:
                    return "not tried"
                if r["status"] != 200:
                    return f"status {r['status']}"
                if not r["candles"]:
                    return "no candles"
                return f"{hhmm(r['first'])}-{hhmm(r['last'])} ({r['candles']} candles)"

            say(f"   {s} Sunday {sun} (NY {'summer' if us_summer(sun) else 'winter'}): {f(a)}; Friday {fri}: {f(b)}")
    say(f"   {len(results)} files, {skipped} not tried, wall {wall:.0f} s")


# ---- GMO -----------------------------------------------------------------------------------------------------

def gmo_get(symbol, side, interval, key):
    url = f"{GMO}/klines?symbol={symbol}&priceType={side}&interval={interval}&date={key}"
    wait = 1.0
    last = None
    for k in range(6):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=30) as r:
                body = json.loads(r.read())
            return body
        except urllib.error.HTTPError as e:
            last = f"HTTP {e.code}"
            if e.code not in (429, 500, 502, 503, 504):
                return {"http": e.code}
        except Exception as e:
            last = type(e).__name__
        if k < 5:
            time.sleep(wait)
            wait = min(wait * 2, 16.0)
    return {"gave_up": last}


def gmo_shape(body):
    """(what the answer was, bar count, first open ms, last open ms): no price is read"""
    if "gave_up" in body or "http" in body:
        return f"no answer ({body.get('gave_up') or 'HTTP ' + str(body.get('http'))})", 0, None, None
    if body.get("status") != 0:
        msgs = body.get("messages") or []
        code = msgs[0].get("message_code") if msgs and isinstance(msgs[0], dict) else "?"
        return f"status {body.get('status')} {code}", 0, None, None
    rows = body.get("data") or []
    ts = sorted(int(r["openTime"]) for r in rows)
    return "ok", len(ts), (ts[0] if ts else None), (ts[-1] if ts else None)


def part_gmo(args):
    pairs = [(v[0], k) for k, v in PAIRS.items()]
    say("== GMO's day files (the key is a GMO day: 21:00 UTC to 21:00 UTC, filed under the next JST date)")
    keys = ["20231204", "20231205", "20231208", "20231211", "20231214", "20231215"]
    jobs = [(sym, "BID", iv, k) for sym, _ in pairs for iv in ("30min", "1hour") for k in keys]
    with cf.ThreadPoolExecutor(max_workers=args.workers) as ex:
        res = list(ex.map(lambda j: (j, gmo_shape(gmo_get(*j))), jobs))
    for iv in ("30min", "1hour"):
        for sym, _ in pairs:
            parts = []
            for (j, sh) in res:
                if j[0] == sym and j[2] == iv:
                    what, n, a, b = sh
                    parts.append(f"{j[3]}: {what}, {n} bars" + (f" {stamp(a)}..{stamp(b)}" if n else ""))
            say(f"   {sym} {iv}: " + " | ".join(parts))
    say("== GMO's year files of 2023 (4hour, 8hour, 1day: BID of each pair; ASK of USD_JPY), and a 2hour request")
    jobs = [(sym, "BID", iv, "2023") for sym, _ in pairs for iv in ("4hour", "8hour", "1day")]
    jobs += [("USD_JPY", "ASK", iv, "2023") for iv in ("4hour", "8hour", "1day")]
    jobs += [("USD_JPY", "BID", "2hour", "2023"), ("USD_JPY", "BID", "2hour", "20231214")]
    with cf.ThreadPoolExecutor(max_workers=args.workers) as ex:
        res = list(ex.map(lambda j: (j, gmo_shape(gmo_get(*j))), jobs))
    for (j, (what, n, a, b)) in res:
        say(f"   {j[0]} {j[1]} {j[2]} {j[3]}: {what}, {n} bars" + (f", first {stamp(a)}, last {stamp(b)}" if n else ""))

    # the days of 2024 and 2025: USD_JPY's 1-hour file for each GMO day
    start, end = dt.date(2024, 1, 1), dt.date(2025, 12, 31)
    days = []
    d = start
    while d <= end:
        days.append(d)
        d += dt.timedelta(days=1)
    with cf.ThreadPoolExecutor(max_workers=args.workers) as ex:
        shapes = list(ex.map(lambda d: gmo_shape(gmo_get("USD_JPY", "BID", "1hour", d.strftime("%Y%m%d"))), days))
    rows = []
    for d, (what, n, a, b) in zip(days, shapes):
        rows.append({"day": d, "what": what, "n": n, "first": a, "last": b})
    noanswer = [r for r in rows if r["what"].startswith("no answer")]
    none = [r for r in rows if r["n"] == 0 and not r["what"].startswith("no answer")]
    say(f"== USD_JPY 1-hour day files, GMO days {start}..{end}: {len(rows)} days, no answer {len(noanswer)}, no bars {len(none)}")
    if noanswer:
        say("   no answer: " + ", ".join(f"{r['day']}" for r in noanswer))
    # the usual shape of a weekday in each season: the most common (bars, first time, last time)
    usual = {}
    groups = collections.defaultdict(list)
    for r in rows:
        if r["n"]:
            groups[(r["day"].weekday(), us_summer(r["day"]))].append((r["n"], hhmm(r["first"]), hhmm(r["last"])))
    for k, v in groups.items():
        usual[k] = collections.Counter(v).most_common(1)[0][0]
    say("   the usual (bars, first, last) by weekday of the GMO day (Mon=0) and NY season:")
    for k in sorted(usual):
        say(f"     weekday {k[0]} {'summer' if k[1] else 'winter'}: {usual[k]} ({len(groups[k])} days)")
    odd = [r for r in rows if r["n"] and (r["n"], hhmm(r["first"]), hhmm(r["last"])) != usual[(r["day"].weekday(), us_summer(r["day"]))]]
    say(f"   days with bars that differ from the usual: {len(odd)}")
    for r in odd[:120]:
        say(f"     {r['day']} (weekday {r['day'].weekday()}, {'summer' if us_summer(r['day']) else 'winter'}): {r['n']} bars {hhmm(r['first'])}..{hhmm(r['last'])}")
    say("   days with no bars (not a weekend's usual): " + ", ".join(f"{r['day']}({r['day'].weekday()})" for r in none[:200]))


# ---- a check of the reading itself -----------------------------------------------------------------------------

def selftest():
    day = dt.date(2023, 12, 10)
    recs = b"".join(RECORD.pack(s, 142000, 142010, 141990, 142020, v) for s, v in ((79200, 5.0), (79260, 0.0), (79320, 2.0)))
    raw = lzma.compress(recs, format=lzma.FORMAT_ALONE)
    n, first, last, inband = decode(raw, day, "USDJPY")
    assert n == 2 and hhmm(first) == "22:00" and hhmm(last) == "22:02" and inband, (n, first, last, inband)
    raw = lzma.compress(RECORD.pack(79200, 1420000, 1420100, 1419900, 1420200, 1.0), format=lzma.FORMAT_ALONE)
    assert decode(raw, day, "USDJPY")[3] is False  # a wrong scale shows as out of the band
    assert decode(b"", day, "USDJPY") == (0, None, None, True)
    assert us_summer(dt.date(2016, 3, 13)) and not us_summer(dt.date(2016, 3, 12)) and not us_summer(dt.date(2016, 11, 6)) and us_summer(dt.date(2016, 11, 5))
    assert gmo_shape({"status": 0, "data": [{"openTime": "1702504800000"}, {"openTime": "1702508400000"}]})[1:2] == (2,)
    assert gmo_shape({"status": 1, "messages": [{"message_code": "ERR-5003"}]})[0] == "status 1 ERR-5003"
    print("selftest ok")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--part", choices=["duka-speed", "duka-first", "duka-sunday", "gmo"])
    ap.add_argument("--out", default="research/out/tfbest-probe")
    ap.add_argument("--workers", type=int, default=3)
    ap.add_argument("--budget", type=float, default=4200.0, help="seconds after which no new file is asked for")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args()
    if args.selftest:
        selftest()
        return
    if not args.part:
        ap.error("--part or --selftest")
    os.makedirs(args.out, exist_ok=True)
    t0 = time.monotonic()
    {"duka-speed": part_duka_speed, "duka-first": part_duka_first, "duka-sunday": part_duka_sunday, "gmo": part_gmo}[args.part](args)
    say(f"done in {time.monotonic() - t0:.0f} s")
    with open(os.path.join(args.out, f"{args.part}.txt"), "w", encoding="utf-8") as f:
        f.write("\n".join(out_lines) + "\n")


if __name__ == "__main__":
    main()
