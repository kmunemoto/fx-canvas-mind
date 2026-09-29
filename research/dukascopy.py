#!/usr/bin/env python3
# #167: gold's (XAU/USD's) history, for measuring the emails' levels on gold.
# The owner (2026-09-29), after the stop on the currency pairs went to 30
# pips and gold's stayed at the video's $10 because gold had not been
# measured: 「金も測って」.
#
# GMO, whose bid/ask the currency pairs were measured on, has no gold, and
# the Twelve Data key the app reads gold with is not on GitHub (and its 800
# reads a day are the app's). Dukascopy's public data feed has gold's bid
# and ask, free and without a key:
#   * minute candles, one file a UTC day and side:
#       {BASE}/XAUUSD/{year}/{month-1:02}/{day:02}/{BID|ASK}_candles_min_1.bi5
#   * hourly candles, one file a UTC month and side:
#       {BASE}/XAUUSD/{year}/{month-1:02}/{BID|ASK}_candles_hour_1.bi5
# Each file LZMA ("alone" format); inside, 24 bytes a candle, big-endian:
# the seconds from the file's start (int32), open, close, low, high (int32,
# the price times SCALE), and the volume (float32). A minute (an hour)
# without a tick is filled with the last price and volume 0; those are not
# kept. read 2026-09-29 from GitHub's runners: a file came in about 16 s and
# the next ones were answered 503 ("No server is available to handle this
# request"), so each file is asked again after a wait, and the workers are
# few.
#
# Kept, decoded, in research/.cache/dukascopy/{SYMBOL}/{m1|h1}/{BID|ASK}/
# {YYYY-MM-DD|YYYY-MM}.json: {"status", "rows": [[ms, o, h, l, c, v], ...]}.
# A file kept is not fetched again, except the last two days' (a day's file
# may not be whole yet). A file that could not be fetched is not kept, and
# is counted.
#
# Usage: python3 research/dukascopy.py --start 2024-01-01 --end 2026-09-29
#          [--hours-from 2021-01] [--workers 3] [--symbol XAUUSD]
# Read-only against the feed; writes only under research/.cache.

import argparse
import concurrent.futures
import datetime as dt
import json
import lzma
import os
import struct
import sys
import threading
import time
import urllib.error
import urllib.request

BASE = "https://datafeed.dukascopy.com/datafeed"
# the price's integer scale in the feed, per symbol (checked on the data: a
# gold price comes out near the day's known price)
SCALE = {"XAUUSD": 1000}
CACHE = "research/.cache/dukascopy"
RECORD = struct.Struct(">iiiiif")
SIDES = ("BID", "ASK")


def decode(raw: bytes, start_ms: int, scale: int):
    """The candles of one file (an empty file: none), oldest first, the
    minutes (hours) without a tick left out, and how many were left out."""
    if not raw:
        return [], 0
    data = lzma.decompress(raw, format=lzma.FORMAT_ALONE)
    if len(data) % RECORD.size != 0:
        raise ValueError(f"{len(data)} bytes is not a whole number of candles")
    rows = []
    dropped = 0
    for off in range(0, len(data), RECORD.size):
        secs, o, c, lo, hi, vol = RECORD.unpack_from(data, off)
        if vol <= 0:
            dropped += 1
            continue
        rows.append([start_ms + secs * 1000, o / scale, hi / scale, lo / scale, c / scale, round(vol, 6)])
    return rows, dropped


def month_path(y: int, m: int) -> str:
    return f"{y}/{m - 1:02d}"


def targets(symbol: str, start: dt.date, end: dt.date, hours_from, today: dt.date):
    """(url, cache path, start ms, fresh) for each file wanted: the minute
    files of each day from start to end (Saturdays, when gold does not
    trade, left out), and the hourly files of each month from hours_from to
    end."""
    out = []
    d = start
    while d <= end:
        if d.weekday() != 5:
            for side in SIDES:
                url = f"{BASE}/{symbol}/{month_path(d.year, d.month)}/{d.day:02d}/{side}_candles_min_1.bi5"
                path = f"{CACHE}/{symbol}/m1/{side}/{d.isoformat()}.json"
                ms = int(dt.datetime(d.year, d.month, d.day, tzinfo=dt.timezone.utc).timestamp() * 1000)
                out.append((url, path, ms, (today - d).days <= 1))
        d += dt.timedelta(days=1)
    if hours_from is not None:
        y, m = hours_from.year, hours_from.month
        while (y, m) <= (end.year, end.month):
            for side in SIDES:
                url = f"{BASE}/{symbol}/{month_path(y, m)}/{side}_candles_hour_1.bi5"
                path = f"{CACHE}/{symbol}/h1/{side}/{y}-{m:02d}.json"
                ms = int(dt.datetime(y, m, 1, tzinfo=dt.timezone.utc).timestamp() * 1000)
                # a month's file grows until the month has ended
                fresh = (y, m) >= (today.year, today.month) or (today - dt.date(y, m, 1)).days < 33
                out.append((url, path, ms, fresh))
            m += 1
            if m == 13:
                y, m = y + 1, 1
    return out


class Stats:
    def __init__(self):
        self.lock = threading.Lock()
        self.fetched = 0
        self.cached = 0
        self.missing = 0
        self.failed = 0
        self.tries = 0
        self.refused = 0
        self.seconds = 0.0
        self.dropped = 0
        self.rows = 0
        self.failures = []

    def add(self, **kw):
        with self.lock:
            for k, v in kw.items():
                if k == "failure":
                    if len(self.failures) < 20:
                        self.failures.append(v)
                else:
                    setattr(self, k, getattr(self, k) + v)


def fetch_one(url: str, timeout: float, attempts: int, stats: Stats):
    """(status, bytes, what each try got): 200 with the file, 404 (none for
    that day), or None after `attempts` tries."""
    wait = 4.0
    got = []
    for k in range(attempts):
        t0 = time.monotonic()
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                body = r.read()
            took = time.monotonic() - t0
            stats.add(tries=1, seconds=took)
            got.append(f"200/{took:.0f}s")
            return 200, body, got
        except urllib.error.HTTPError as e:
            took = time.monotonic() - t0
            stats.add(tries=1, seconds=took)
            got.append(f"{e.code}/{took:.0f}s")
            if e.code == 404:
                return 404, b"", got
            if e.code in (429, 500, 502, 503, 504):
                stats.add(refused=1)
            else:
                return None, f"http {e.code}".encode(), got
        except Exception as e:  # timeouts, resets
            took = time.monotonic() - t0
            stats.add(tries=1, seconds=took)
            got.append(f"{type(e).__name__}/{took:.0f}s")
        if k < attempts - 1:
            time.sleep(wait)
            wait = min(wait * 2, 60.0)
    return None, b"gave up", got


def work(item, symbol: str, timeout: float, attempts: int, stats: Stats):
    url, path, start_ms, fresh = item
    if not fresh and os.path.exists(path):
        stats.add(cached=1)
        return
    status, body, got = fetch_one(url, timeout, attempts, stats)
    print(f"  {url.split('/datafeed/')[1]}: {' '.join(got)}", flush=True)
    if status is None:
        stats.add(failed=1, failure=f"{url} ({body.decode(errors='replace')})")
        return
    try:
        rows, dropped = decode(body, start_ms, SCALE[symbol]) if status == 200 else ([], 0)
    except Exception as e:
        stats.add(failed=1, failure=f"{url} (decode: {e!r})")
        return
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump({"status": status, "dropped": dropped, "rows": rows}, f, separators=(",", ":"))
    stats.add(fetched=1, missing=1 if status == 404 else 0, dropped=dropped, rows=len(rows))


def report(symbol: str):
    """What the kept minute files hold, to check the reading: candles whose
    high or low does not hold the open and close (a wrong field order would
    show here), minutes where the bid is above the ask, the spread, and each
    month's price range (a wrong scale would show here)."""
    import statistics
    base = f"{CACHE}/{symbol}/m1"
    days = sorted(set(os.listdir(f"{base}/BID")) & set(os.listdir(f"{base}/ASK"))) if os.path.isdir(f"{base}/BID") and os.path.isdir(f"{base}/ASK") else []
    bad_ohlc = 0
    crossed = 0
    only_one = 0
    matched = 0
    spreads = []
    months = {}
    per_day = []
    first = None
    for name in days:
        sides = {}
        for side in SIDES:
            with open(f"{base}/{side}/{name}") as f:
                sides[side] = {r[0]: r for r in json.load(f)["rows"]}
        for rows in sides.values():
            for r in rows.values():
                o, h, lo, c = r[1], r[2], r[3], r[4]
                if lo > min(o, c) + 1e-9 or h < max(o, c) - 1e-9:
                    bad_ohlc += 1
        both = sorted(set(sides["BID"]) & set(sides["ASK"]))
        only_one += len(set(sides["BID"]) ^ set(sides["ASK"]))
        per_day.append(len(both))
        for t in both:
            b, a = sides["BID"][t], sides["ASK"][t]
            matched += 1
            if b[4] > a[4] + 1e-9:
                crossed += 1
            spreads.append(a[4] - b[4])
            mo = dt.datetime.fromtimestamp(t / 1000, dt.timezone.utc).strftime("%Y-%m")
            lo, hi = months.get(mo, (float("inf"), float("-inf")))
            months[mo] = (min(lo, b[3]), max(hi, b[2]))
        if first is None and both:
            first = {"day": name, "bid": sides["BID"][both[0]], "ask": sides["ASK"][both[0]], "lastBid": sides["BID"][both[-1]]}
    spreads.sort()
    q = lambda p: spreads[int(p * (len(spreads) - 1))] if spreads else None
    print(json.dumps({
        "days": len(days), "minutesMatched": matched, "minutesOneSideOnly": only_one,
        "minutesPerDay": {"min": min(per_day) if per_day else None, "median": statistics.median(per_day) if per_day else None, "max": max(per_day) if per_day else None},
        "candlesHighLowNotHolding": bad_ohlc, "bidAboveAsk": crossed,
        "spreadAtClose": {"p10": q(0.1), "median": q(0.5), "p90": q(0.9), "p99": q(0.99)},
        "first": first, "months": {k: [round(v[0], 2), round(v[1], 2)] for k, v in sorted(months.items())},
    }, indent=1), flush=True)


def closes(symbol: str, day_from: str, all_from: str):
    """The mid price at hour marks, to compare with the Twelve Data bars the
    app keeps (where their bars start and end, and how near the two feeds'
    prices are): the close of the last minute before each mark, when that
    minute is within the five before it. From day_from, the marks 20:00 to
    01:00 UTC around each day's end; from all_from, every hour's. Printed as
    lines "CLOSE <UTC hour> <mid>" between markers."""
    base = f"{CACHE}/{symbol}/m1"
    days = sorted(set(os.listdir(f"{base}/BID")) & set(os.listdir(f"{base}/ASK")))
    mids = {}
    for name in days:
        if name[:10] < day_from:
            continue
        sides = {}
        for side in SIDES:
            with open(f"{base}/{side}/{name}") as f:
                sides[side] = {r[0]: r[4] for r in json.load(f)["rows"]}
        for t in set(sides["BID"]) & set(sides["ASK"]):
            mids[t] = (sides["BID"][t] + sides["ASK"][t]) / 2
    print("CLOSES BEGIN", flush=True)
    if mids:
        first = min(mids)
        last = max(mids)
        h = (first // 3_600_000 + 1) * 3_600_000
        while h <= last + 60_000:
            when = dt.datetime.fromtimestamp(h / 1000, dt.timezone.utc)
            if when.strftime("%Y-%m-%d") >= all_from or when.hour in (20, 21, 22, 23, 0, 1):
                for k in range(1, 6):
                    v = mids.get(h - k * 60_000)
                    if v is not None:
                        print(f"CLOSE {when.strftime('%Y-%m-%dT%H')} {v:.3f}")
                        break
            h += 3_600_000
    print("CLOSES END", flush=True)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--symbol", default="XAUUSD")
    p.add_argument("--start")
    p.add_argument("--end")
    p.add_argument("--report", action="store_true", help="only report on the kept minute files")
    p.add_argument("--closes", nargs=2, metavar=("DAY_FROM", "ALL_FROM"), help="only print the mid at hour marks")
    p.add_argument("--hours-from", default=None, help="YYYY-MM: the hourly files from this month")
    p.add_argument("--workers", type=int, default=3)
    p.add_argument("--attempts", type=int, default=6)
    p.add_argument("--timeout", type=float, default=40.0)
    p.add_argument("--budget-minutes", type=float, default=150.0, help="stop starting new files after this long")
    a = p.parse_args()
    if a.report:
        return report(a.symbol)
    if a.closes:
        return closes(a.symbol, a.closes[0], a.closes[1])
    start = dt.date.fromisoformat(a.start)
    end = dt.date.fromisoformat(a.end)
    hours_from = dt.date.fromisoformat(a.hours_from + "-01") if a.hours_from else None
    today = dt.datetime.now(dt.timezone.utc).date()
    items = targets(a.symbol, start, end, hours_from, today)
    stats = Stats()
    t0 = time.monotonic()
    deadline = t0 + a.budget_minutes * 60
    skipped = 0
    print(f"{len(items)} files wanted ({a.symbol}, {a.start}..{a.end}, hourly from {a.hours_from}), {a.workers} workers", flush=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=a.workers) as ex:
        futs = []
        for it in items:
            futs.append(ex.submit(lambda it=it: None if time.monotonic() > deadline else work(it, a.symbol, a.timeout, a.attempts, stats)))
        for k, f in enumerate(concurrent.futures.as_completed(futs), 1):
            f.result()
            if k % 50 == 0 or k == len(futs):
                el = time.monotonic() - t0
                print(f"  {k}/{len(futs)} done in {el:.0f}s: fetched {stats.fetched} (404 {stats.missing}), kept before {stats.cached}, failed {stats.failed}; "
                      f"{stats.tries} requests, {stats.refused} refused, {stats.seconds / max(1, stats.tries):.1f}s a request", flush=True)
    done = stats.fetched + stats.cached + stats.failed
    skipped = len(items) - done
    print(json.dumps({
        "files": len(items), "fetched": stats.fetched, "notFound": stats.missing, "keptBefore": stats.cached,
        "failed": stats.failed, "notStarted": skipped, "requests": stats.tries, "refused": stats.refused,
        "secondsPerRequest": round(stats.seconds / max(1, stats.tries), 2), "elapsed": round(time.monotonic() - t0, 1),
        "candlesKept": stats.rows, "candlesWithoutTick": stats.dropped, "failures": stats.failures,
    }, indent=1), flush=True)


if __name__ == "__main__":
    sys.exit(main())
