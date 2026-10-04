#!/usr/bin/env python3
"""#187: an independent check of research/stop2n.ts (docs §8.97), written apart
from it.

For every trade in the call's table (research/out/stop2n-trades.csv: the
emails' signals, either, of the nine pairs judged) it takes only the pair, the
signal bar, the side and A (the bar's ATR(14), checked against the email's own
by (a4) in the run), and works out the rest again from GMO's raw files (the
run's cache):

  * the 4-hour bar: its mid close (bid and ask halved, rounded to the chart's
    digits as JavaScript's toFixed does), the fill (a buy at the ask, a sell at
    the bid), TP1 20 pips;
  * N: the daily bars' mids rounded so, the true range the larger of high less
    low and the high's and the low's distance from the close before (the first
    bar's high less low), its first 20 averaged, then (TR + 19 N) / 20 (Wilder),
    from the first daily bar read; the newest daily bar whose open + 24 hours is
    at or before the signal's close;
  * the stops: 30 pips (not rounded), and the mid close less 2N and 2A (a
    sell's plus) rounded to the nearest tick (Math.round);
  * each trade followed on the 5-minute bid (a buy) or ask (a sell): out at the
    first level a bar reaches (both in one bar: the stop; a bar opening past
    one: at that open), or at the close of the last 5-minute bar of the 30th
    4-hour bar;
  * the number of trades, each half's and the whole period's mean of now, 2N
    and 2A and of "less now", against the run's JSON.

Prices must agree to 1e-9, pips to 1e-6, times exactly.

--plant late | pips puts an error into the table as read (one 2N exit a
5-minute bar later, or one 2N result 1 pip more), and the check must find it.

Usage: python3 research/stop2n-check.py [--cache research/.cache]
  [--out research/out] [--tag ""] [--start 2024-01-01] [--split 2025-05-19]
  [--end 2026-10-02T21:00:00Z] [--weekend inside|stamp] [--plant none|late|pips]
Read-only: prints to the job log.
"""

import argparse
import csv
import glob
import json
import math
import os
import sys
from datetime import datetime, timezone
from decimal import ROUND_HALF_UP, Decimal

MIN = 60_000
HOUR = 60 * MIN
DAY = 24 * HOUR
STEP = {"5min": 5 * MIN, "4hour": 4 * HOUR, "1day": DAY}
CALL = ["USD/JPY", "EUR/JPY", "GBP/JPY", "AUD/JPY", "NZD/JPY", "CAD/JPY", "CHF/JPY", "EUR/USD", "AUD/USD"]


def ms_of(s):
    return int(datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp() * 1000)


def iso(ms):
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d %H:%M")


# ---- the week (as _shared/market-hours.ts says it, written again) ----------------------


def market_closed(ms):
    d = datetime.fromtimestamp(ms / 1000, tz=timezone.utc)
    day = (d.weekday() + 1) % 7  # Sunday 0 .. Saturday 6
    if day == 6:
        return True
    if day == 5 and d.hour >= 22:
        return True
    if day == 0 and d.hour < 21:
        return True
    return False


def weekend_out(weekend, t, step):
    if weekend == "stamp":
        return market_closed(t)
    # inside: out only when the bar lies wholly in the closure (Friday 22:00
    # to Sunday 21:00, 47 hours)
    if step > 47 * HOUR:
        return False
    return market_closed(t) and market_closed(t + step - 1)


# ---- rounding as the program's JavaScript does ------------------------------------------


def to_fixed(x, d):
    """Number(x.toFixed(d)): the exact value, halves up."""
    return float(Decimal(x).quantize(Decimal(1).scaleb(-d), rounding=ROUND_HALF_UP))


def js_round(y):
    """Math.round: the nearest integer, halves toward +infinity."""
    f = math.floor(y)
    return f + 1 if y - f >= 0.5 else f


def round_to(x, d):
    return js_round(x * 10**d) / 10**d


# ---- GMO's files --------------------------------------------------------------------------


def read_bars(cache, symbol, interval, weekend, from_ms, now_ms):
    """Both sides by open time, as the run keeps them: on both sides, the ask's
    close not under the bid's, opened from from_ms, closed by now, the weekend's
    out. A time in two files: the first read (the files in name order)."""
    sides = {}
    differ = 0
    for side in ("bid", "ask"):
        rows = {}
        for path in sorted(glob.glob(os.path.join(cache, symbol, interval, side, "*.json"))):
            with open(path) as f:
                body = json.load(f)
            if not isinstance(body, dict) or not isinstance(body.get("data"), list):
                continue
            for r in body["data"]:
                t = int(r["openTime"])
                c = (float(r["open"]), float(r["high"]), float(r["low"]), float(r["close"]))
                if t in rows:
                    differ += rows[t] != c
                    continue
                rows[t] = c
        sides[side] = rows
    step = STEP[interval]
    out = {}
    for t, b in sides["bid"].items():
        a = sides["ask"].get(t)
        if a is None or a[3] < b[3]:
            continue
        if t < from_ms or weekend_out(weekend, t, step) or t + step > now_ms:
            continue
        out[t] = (b, a)
    return dict(sorted(out.items())), differ


def mid_rounded(b, a, d):
    return tuple(to_fixed((b[k] + a[k]) / 2, d) for k in range(4))


def wilder_n(days, n=20):
    """pineAtr(days, n) written again: TR as the larger of H − L, |H − C₋₁|,
    |L − C₋₁| (the first bar's H − L), the first n averaged, then (TR + (n−1)·prev)/n."""
    out = []
    prev = None
    s = 0.0
    for i, (o, h, l, c) in enumerate(days):
        tr = h - l if i == 0 else max(h - l, abs(h - days[i - 1][3]), abs(l - days[i - 1][3]))
        if prev is None:
            s += tr
            if i < n - 1:
                out.append(None)
                continue
            prev = s / n
            out.append(prev)
            continue
        prev = (tr + (n - 1) * prev) / n
        out.append(prev)
    return out


# ---- the check ---------------------------------------------------------------------------


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache", default="research/.cache")
    ap.add_argument("--out", default="research/out")
    ap.add_argument("--tag", default="")
    ap.add_argument("--start", default="2024-01-01")
    ap.add_argument("--split", default="2025-05-19")
    ap.add_argument("--end", default="2026-10-02T21:00:00Z")
    ap.add_argument("--weekend", default="inside", choices=["inside", "stamp"])
    ap.add_argument("--plant", default="none", choices=["none", "late", "pips"])
    args = ap.parse_args()
    start = ms_of(args.start + "T00:00:00Z")
    split = ms_of(args.split + "T00:00:00Z")
    now = ms_of(args.end)
    year0 = datetime.fromtimestamp(start / 1000, tz=timezone.utc).year - 1
    long_from = int(datetime(year0, 1, 1, tzinfo=timezone.utc).timestamp() * 1000) - 9 * HOUR
    fine_from = start - 5 * DAY

    rows = list(csv.DictReader(open(os.path.join(args.out, f"stop2n-trades{args.tag}.csv"))))
    run = json.load(open(os.path.join(args.out, f"stop2n{args.tag}.json")))
    if args.plant != "none":
        for r in rows:
            if args.plant == "late" and r["n2_exit"] in ("tp", "sl"):
                r["n2_at"] = str(int(r["n2_at"]) + 5 * MIN)
                print(f"planted: {r['pair']} {iso(int(r['bar']))} {r['side']} 2N out a 5-minute bar later")
                break
            if args.plant == "pips":
                r["n2_pips"] = str(float(r["n2_pips"]) + 1)
                print(f"planted: {r['pair']} {iso(int(r['bar']))} {r['side']} 2N 1 pip more")
                break

    wrong = []
    # the run's own checks first: a run whose checks differ is not to be read,
    # whatever the trades below say
    if run.get("allDiffer", 1) != 0 or run.get("failedReads", 1) != 0:
        wrong.append(f"the run's own checks differ ({run.get('allDiffer')}) or GMO reads failed ({run.get('failedReads')})")
    checked = 0
    differ_rows = 0
    by_pair = {}
    for r in rows:
        by_pair.setdefault(r["pair"], []).append(r)
    results = []
    for pair, rs in by_pair.items():
        if pair not in CALL:
            wrong.append(f"{pair}: not one of the nine judged")
            continue
        symbol = pair.replace("/", "_")
        jpy = "JPY" in pair
        unit = 0.01 if jpy else 0.0001
        d = 3 if jpy else 5
        four, x1 = read_bars(args.cache, symbol, "4hour", args.weekend, long_from, now)
        day_raw, x2 = read_bars(args.cache, symbol, "1day", args.weekend, long_from, now)
        fine_raw, x3 = read_bars(args.cache, symbol, "5min", args.weekend, fine_from, now)
        differ_rows += x1 + x2 + x3
        times = list(four.keys())
        index = {t: i for i, t in enumerate(times)}
        dtimes = list(day_raw.keys())
        days = [mid_rounded(b, a, d) for b, a in day_raw.values()]
        nser = wilder_n(days)
        ft = list(fine_raw.keys())
        fv = list(fine_raw.values())
        print(f"{pair}: 4-hour bars {len(times)}, daily bars {len(dtimes)} (the first {iso(dtimes[0]) if dtimes else '-'}), 5-minute bars {len(ft)}; trades {len(rs)}")
        for r in rs:
            checked += 1
            bar = int(r["bar"])
            side = r["side"]
            buy = side == "BUY"
            dir_ = 1 if buy else -1
            tag = f"{pair} {iso(bar)} {side}"
            i = index.get(bar)
            if i is None:
                wrong.append(f"{tag}: no such 4-hour bar in the raw files")
                continue
            b, a = four[bar]
            close = mid_rounded(b, a, d)[3]
            fill = a[3] if buy else b[3]
            T = bar + 4 * HOUR
            tp = close + (dir_ * 20) * unit
            # N: the newest daily bar closed by T
            k = -1
            for q in range(len(dtimes)):
                if dtimes[q] + DAY <= T:
                    k = q
                else:
                    break
            N = nser[k] if k >= 0 else None
            A = float(r["A"])
            mine = {"close": close, "fill": fill, "tp": tp, "N": N, "day": dtimes[k] if k >= 0 else None}
            for key, got in (("close", float(r["close"])), ("fill", float(r["fill"])), ("tp", float(r["tp"])), ("N", float(r["N"])), ("day", int(r["day"]))):
                want = mine[key]
                if want is None or abs(want - got) > (0 if key == "day" else 1e-9):
                    wrong.append(f"{tag}: {key} {got} in the table, {want} from the raw files")
            if N is None:
                continue
            stops = {
                "now": close - (dir_ * 30) * unit,
                "n2": round_to(close - (dir_ * 2) * N, d),
                "a2": round_to(close - (dir_ * 2) * A, d),
            }
            if i + 30 >= len(times):
                wrong.append(f"{tag}: fewer than 30 bars after it")
                continue
            res = {}
            for rk, sl in stops.items():
                out = follow(ft, fv, times, i, T, buy, sl, tp)
                if out is None:
                    wrong.append(f"{tag} {rk}: not followed to its end")
                    continue
                kind, at, px = out
                pips = (px - fill) / unit if buy else (fill - px) / unit
                res[rk] = pips
                for key, want, got, tol in (
                    ("sl", sl, float(r[f"{rk}_sl"]), 1e-9),
                    ("exit", kind, r[f"{rk}_exit"], None),
                    ("at", at, int(r[f"{rk}_at"]), 0),
                    ("px", px, float(r[f"{rk}_px"]), 1e-9),
                    ("pips", pips, float(r[f"{rk}_pips"]), 1e-6),
                ):
                    ok = want == got if tol is None else abs(want - got) <= tol
                    if not ok:
                        wrong.append(f"{tag} {rk}: {key} {got} in the table, {want} from the raw files")
            if len(res) == 3:
                results.append((0 if T < split else 1, res))

    # the groups against the run's JSON
    g = run["groups"]["either|CALL"]
    names = {"now": run["nowRule"], "n2": run["candidates"][0], "a2": run["candidates"][1]}
    for p, label in ((0, "first half"), (1, "second half"), (2, "the whole period")):
        sel = [res for h, res in results if p == 2 or h == p]
        for rk in ("now", "n2", "a2"):
            m = sum(x[rk] for x in sel) / len(sel) if sel else None
            got = g[p].get(names[rk])
            if got is None or got["n"] != len(sel) or m is None or abs(got["m"] - m) > 1e-9:
                wrong.append(f"{label} {names[rk]}: {got and got['n']} trades, {got and got['m']} in the run; {len(sel)}, {m} again")
        for rk in ("n2", "a2"):
            m = sum(x[rk] - x["now"] for x in sel) / len(sel) if sel else None
            got = g[p].get(names[rk] + " − now")
            if got is None or got["n"] != len(sel) or m is None or abs(got["m"] - m) > 1e-9:
                wrong.append(f"{label} {names[rk]} less now: {got and got['m']} in the run, {m} again")
        if sel:
            print(f"{label}: {len(sel)} trades; now {sum(x['now'] for x in sel) / len(sel):+.4f}, 2N {sum(x['n2'] for x in sel) / len(sel):+.4f}, 2A {sum(x['a2'] for x in sel) / len(sel):+.4f} pips a trade")

    print(f"\nrows in two files with different prices: {differ_rows}")
    print(f"trades checked {checked}; the trades again {len(results)}; differ {len(wrong)}")
    for w in wrong[:40]:
        print(f"  {w}")
    if len(wrong) > 40:
        print(f"  … {len(wrong) - 40} more")
    print("THE TABLE AGREES WITH GMO'S RAW FILES" if not wrong else "THE TABLE DOES NOT AGREE")
    sys.exit(0 if not wrong else 1)


def follow(ft, fv, times, i, T, buy, sl, tp):
    """The trade on the 5-minute bars from T to the 30th 4-hour bar's close:
    (kind, the open of the bar it went out in, the price) or None."""
    lo, hi = 0, len(ft)
    while lo < hi:
        m = (lo + hi) // 2
        if ft[m] < T:
            lo = m + 1
        else:
            hi = m
    f = lo
    if f >= len(ft):
        return None
    side = 0 if buy else 1  # a buy goes out on the bid, a sell on the ask
    for j in range(i + 1, i + 31):
        end = times[j] + 4 * HOUR
        while f < len(ft) and ft[f] < end:
            o, h, l, c = fv[f][side]
            if (o <= sl) if buy else (o >= sl):
                return ("sl", ft[f], o)
            if (o >= tp) if buy else (o <= tp):
                return ("tp", ft[f], o)
            hit_sl = (l <= sl) if buy else (h >= sl)
            hit_tp = (h >= tp) if buy else (l <= tp)
            if hit_sl and hit_tp:
                return ("amb", ft[f], sl)
            if hit_sl:
                return ("sl", ft[f], sl)
            if hit_tp:
                return ("tp", ft[f], tp)
            f += 1
        if f >= len(ft) and ft[-1] + 5 * MIN < end:
            return None
        if j == i + 30:
            return ("time", ft[f - 1], fv[f - 1][side][3])
    return None


if __name__ == "__main__":
    main()
