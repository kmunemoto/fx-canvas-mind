#!/usr/bin/env python3
# #250 (docs §8.106 11 Python): stage 0's labels computed again, on their own, from GMO's files.
#
# Written from the docs, not from research/trend.ts: it reads the files the run read (research/.cache,
# or the walk's folder) with its own list of keys, builds each timeframe's bars the chart's way, and
# for every row of trend-labels.csv computes the chart's Dow line at C (§8.106 1):
#
#   * C: the signal bar's close T; T + 15 minutes for a late signal. The chart's reading a minute later.
#   * the bars: GMO's bid and ask, a bar on both sides only, an ask closing under the bid left out, a bar
#     the weekend shuts for all of its length left out (barInsideClosure: Friday 22:00 to Sunday 21:00
#     UTC at both ends), the mid of the two unrounded; each bar with the key of the newest file it is in.
#   * the window: the newest bar closed by C (start + length <= C); 300 closed bars when the next bar
#     has begun by C (it is counted, not read), 301 when it has not; none from a file older than the
#     oldest the chart's walk reads (day files: the JST day of now - (span + 1) days, span the days the
#     walk may look back for 301 bars; 4-hour: last JST year's file).
#   * the state: the Dow reading of _shared/dow.ts (written again here from its comment and rules).
#   * unreadable: fewer than 300 closed bars (1), a hole of 30 minutes or more among them, or among the
#     bars that should have closed between the newest of them and C, that neither the market's hours nor
#     GMO's own closures (a stamp most of the five pairs miss) explain (2).
#
# Then the halves (§8.106 5: the follow of 1,440 5-minute bars from C inside the half), the four
# candidates' counts, the floors (§8.106 2, 6) and the whole period's counts against the run's
# counts.json. Exit 1 on any difference; a count that differs is named, never printed (§8.106 11).

import argparse
import json
import math
import os
import sys
from datetime import datetime, timezone, timedelta

MIN = 60_000
HOUR = 60 * MIN
DAY = 24 * HOUR
WINDOW = 300
STEP = {"15min": 15 * MIN, "1h": HOUR, "4h": 4 * HOUR, "5min": 5 * MIN}
FILE = {"15min": "15min", "1h": "1hour", "4h": "4hour", "5min": "5min"}
PAIRS = ["USD/JPY", "EUR/JPY", "AUD/JPY", "EUR/USD", "AUD/USD"]
STATES = ["none", "up", "down", "toUp", "toDown"]
DIR = {"none": 0, "up": 1, "toUp": 1, "down": -1, "toDown": -1}


def ms_of(text):
    return int(datetime.fromisoformat(text.replace("Z", "+00:00")).timestamp() * 1000)


def utc(ms):
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc)


def iso(ms):
    return utc(ms).strftime("%Y-%m-%dT%H:%M:%S.") + f"{ms % 1000:03d}Z"


def jst_day(ms):
    return (utc(ms) + timedelta(hours=9)).strftime("%Y%m%d")


def jst_year(ms):
    return (utc(ms) + timedelta(hours=9)).year


def gmo_day(ms):
    # GMO's day file: from 21:00 UTC the day before to 21:00 UTC
    return jst_day(ms - 6 * HOUR)


def market_closed(ms):
    d = utc(ms)
    wd = d.weekday()  # Monday 0 .. Sunday 6
    if wd == 5:
        return True
    if wd == 4 and d.hour >= 22:
        return True
    if wd == 6 and d.hour < 21:
        return True
    return False


def possibly_closed(ms):
    d = utc(ms)
    wd = d.weekday()
    if wd == 5:
        return True
    if wd == 4 and d.hour >= 21:
        return True
    if wd == 6 and d.hour < 22:
        return True
    return False


def inside_closure(open_ms, step):
    if step > 47 * HOUR:
        return False
    return market_closed(open_ms) and market_closed(open_ms + step - 1)


def should_exist(s, step):
    if inside_closure(s, step):
        return False
    m = s
    while m < s + step:
        if not possibly_closed(m):
            return True
        m += 5 * MIN
    return False


# ---- the files --------------------------------------------------------------------------------

def day_keys(from_ms, to_ms):
    # every GMO day from the one holding from_ms to the JST day of to_ms
    keys = []
    d = utc(from_ms - 6 * HOUR) + timedelta(hours=9)
    d = datetime(d.year, d.month, d.day, tzinfo=timezone.utc)
    last = jst_day(to_ms)
    while True:
        k = d.strftime("%Y%m%d")
        keys.append(k)
        if k >= last:
            break
        d += timedelta(days=1)
    return keys


def year_keys(from_ms, to_ms):
    return [str(y) for y in range(int(gmo_day(from_ms)[:4]), int(gmo_day(to_ms - 1)[:4]) + 1)]


def read_rows(path, problems):
    try:
        with open(path) as f:
            body = json.load(f)
    except FileNotFoundError:
        return None
    except Exception as e:  # noqa: BLE001
        problems.append(f"{path}: {e}")
        return None
    out = []
    for r in body.get("data") or []:
        try:
            t = int(r["openTime"])
            o, h, lo, c = float(r["open"]), float(r["high"]), float(r["low"]), float(r["close"])
        except (KeyError, ValueError, TypeError):
            continue
        if all(math.isfinite(x) for x in (o, h, lo, c)):
            out.append((t, o, h, lo, c))
    out.sort(key=lambda x: x[0])
    return out


class Bars:
    def __init__(self, t, bid, ask, key):
        self.t, self.bid, self.ask, self.key = t, bid, ask, key
        self.n = len(t)
        # rows are (t, open, high, low, close): the mids of high, low and close
        self.mid = [((b[2] + a[2]) / 2, (b[3] + a[3]) / 2, (b[4] + a[4]) / 2) for b, a in zip(bid, ask)]


def load(gmo, pair, tf, from_ms, to_ms, problems, missing):
    sym = pair.replace("/", "_")
    keys = year_keys(from_ms, to_ms) if tf == "4h" else day_keys(from_ms, to_ms)
    bid, ask, key_of = [], [], {}
    for k in keys:
        b = read_rows(f"{gmo}/{sym}/{FILE[tf]}/bid/{k}.json", problems)
        a = read_rows(f"{gmo}/{sym}/{FILE[tf]}/ask/{k}.json", problems)
        if b is None or a is None:
            missing.append(f"{pair} {tf} {k}")
            continue
        for x in b:
            if x[0] not in key_of or int(k) > key_of[x[0]]:
                key_of[x[0]] = int(k)
        bid.extend(b)
        ask.extend(a)
    bid.sort(key=lambda x: x[0])
    ask.sort(key=lambda x: x[0])
    asks = {}
    for x in ask:
        asks[x[0]] = x
    step = STEP[tf]
    T, B, A, K, seen = [], [], [], [], set()
    for x in bid:
        if x[0] in seen:
            continue
        a = asks.get(x[0])
        if a is None or a[4] < x[4]:
            continue
        seen.add(x[0])
        t = x[0]
        if t < from_ms or t + step > to_ms or inside_closure(t, step):
            continue
        T.append(t)
        B.append(x)
        A.append(a)
        K.append(key_of[t])
    return Bars(T, B, A, K)


# ---- holes ---------------------------------------------------------------------------------

def closures(series, step):
    # GMO's own closures: stamps missing from at least 80% of the pairs whose data spans them (at least five)
    have = [set(b.t) for b in series if b.n]
    spans = [(b.t[0], b.t[-1]) for b in series if b.n]
    if not spans:
        return set()
    lo = min(s[0] for s in spans)
    hi = max(s[1] for s in spans)
    out = set()
    s = lo
    while s <= hi:
        cover = sum(1 for (a, b) in spans if a <= s <= b)
        miss = sum(1 for (a, b), h in zip(spans, have) if a <= s <= b and s not in h)
        if cover >= 5 and miss >= 0.8 * cover and should_exist(s, step):
            out.add(s)
        s += step
    return out


def gap_prefix(b, step, holes):
    p = [0] * (b.n + 1)
    for i in range(b.n):
        bad = 0
        if i + 1 < b.n:
            frm = b.t[i] + step
            to = b.t[i + 1]
            if to - frm >= 30 * MIN:
                missing = 0
                s = frm
                while s < to:
                    if should_exist(s, step) and s not in holes:
                        missing += step
                    s += step
                bad = 1 if missing >= 30 * MIN else 0
        p[i + 1] = p[i] + bad
    return p


# ---- the Dow reading --------------------------------------------------------------------------

def dow_state(bars, pivot=4):
    # bars: (high, low, close). Swings: a high (low) with no higher (lower) high in the `pivot` bars
    # each side (equal on the left counts as higher); two of a kind in a row keep the more extreme.
    # up: a close over the last swing high; its key the swing low before (押し安値); a close under the key
    # is the first break (toDown); the turn is confirmed by a lower high and a close under the swing low
    # before it, and called off by a close over the old leg's top. Mirrored for down.
    n = len(bars)
    sw = []  # [i, kind, price]
    state = "none"
    key = None  # [i, price]
    broken_h = broken_l = -1
    break_at = -1
    extreme = 0.0

    def last_of(kind, after=-1):
        for k in range(len(sw) - 1, -1, -1):
            if sw[k][0] <= after:
                break
            if sw[k][1] == kind:
                return sw[k]
        return None

    def add(kind, i, price):
        if sw and sw[-1][1] == kind:
            last = sw[-1]
            if (price <= last[2]) if kind == "H" else (price >= last[2]):
                return
            sw.pop()
        sw.append([i, kind, price])

    for t in range(n):
        p = t - pivot
        if p - pivot >= 0:
            is_h = is_l = True
            for k in range(p - pivot, p + pivot + 1):
                if k == p:
                    continue
                if (bars[k][0] >= bars[p][0]) if k < p else (bars[k][0] > bars[p][0]):
                    is_h = False
                if (bars[k][1] <= bars[p][1]) if k < p else (bars[k][1] < bars[p][1]):
                    is_l = False
            if is_h:
                add("H", p, bars[p][0])
            if is_l:
                add("L", p, bars[p][1])
        c = bars[t][2]
        lh = last_of("H")
        ll = last_of("L")
        if state == "none":
            if lh and c > lh[2]:
                state, broken_h = "up", lh[0]
                key = [ll[0], ll[2]] if ll else None
            elif ll and c < ll[2]:
                state, broken_l = "down", ll[0]
                key = [lh[0], lh[2]] if lh else None
        elif state == "up":
            if lh and lh[0] > broken_h and c > lh[2]:
                broken_h = lh[0]
                if ll and (key is None or ll[0] > key[0]):
                    key = [ll[0], ll[2]]
            if key and c < key[1]:
                extreme = max(bars[k][0] for k in range(key[0], t + 1))
                break_at = t
                state = "toDown"
        elif state == "down":
            if ll and ll[0] > broken_l and c < ll[2]:
                broken_l = ll[0]
                if lh and (key is None or lh[0] > key[0]):
                    key = [lh[0], lh[2]]
            if key and c > key[1]:
                extreme = min(bars[k][1] for k in range(key[0], t + 1))
                break_at = t
                state = "toUp"
        elif state == "toDown":
            low2 = last_of("L", break_at - 1)
            high2 = last_of("H", low2[0]) if low2 else None
            if c > extreme:
                state = "up"
                if lh:
                    broken_h = lh[0]
                key = [ll[0], ll[2]] if ll else key
            elif low2 and high2 and high2[2] < extreme and c < low2[2]:
                state = "down"
                broken_l = low2[0]
                key = [high2[0], high2[2]]
        elif state == "toUp":
            high2 = last_of("H", break_at - 1)
            low2 = last_of("L", high2[0]) if high2 else None
            if c < extreme:
                state = "down"
                if ll:
                    broken_l = ll[0]
                key = [lh[0], lh[2]] if lh else key
            elif high2 and low2 and low2[2] > extreme and c > high2[2]:
                state = "up"
                broken_h = high2[0]
                key = [low2[0], low2[2]]
    return state


def oldest_key(tf, now):
    if tf == "4h":
        return jst_year(now) - 1
    per_day = max(1, DAY // STEP[tf])
    open_days = math.ceil((WINDOW + 1) / per_day)
    span = math.ceil(open_days * 7 / 5) + 2
    return int(jst_day(now - (span + 1) * DAY))


def label(b, gp, tf, C, holes):
    step = STEP[tf]
    # the newest bar closed by C
    lo, hi = 0, b.n
    while lo < hi:
        m = (lo + hi) // 2
        if b.t[m] + step <= C:
            lo = m + 1
        else:
            hi = m
    i = lo - 1
    if i < 0:
        return "-", 9
    forming = i + 1 < b.n and b.t[i + 1] <= C
    ok = oldest_key(tf, C + 60_000)
    lo, hi = 0, b.n
    while lo < hi:
        m = (lo + hi) // 2
        if b.key[m] < ok:
            lo = m + 1
        else:
            hi = m
    start = max(i - (WINDOW - 1) if forming else i - WINDOW, lo, 0)
    if start > i:
        return "-", 9
    state = dow_state(b.mid[start:i + 1])
    # the bars that should have closed after the newest one by C
    trail = 0
    s = b.t[i] + step
    while s + step <= C:
        if should_exist(s, step) and s not in holes:
            trail += step
        s += step
    x = (1 if i - start + 1 < WINDOW else 0) | (2 if gp[i] - gp[start] > 0 or trail >= 30 * MIN else 0)
    return state, x


# ---- the floors -------------------------------------------------------------------------------

def floor_miss(n, k, o, u, wk, wo, kb, ks, wkb, wks):
    """§8.106 6 for one candidate in one half: the floors it misses, in the run's order and words"""
    return [m for m, short in (
        ("kept<300", k < 300), ("out<300", o < 300), ("keptWeeks<30", wk < 30), ("outWeeks<30", wo < 30),
        ("BUY<50", kb < 50), ("SELL<50", ks < 50), ("BUYWeeks<40", wkb < 40), ("SELLWeeks<40", wks < 40),
        ("unread>2%", 50 * u > n),
    ) if short]


def floors_hand():
    """hand-made counts: all at the line meet the floors; each one short (the unreadable one over) misses it alone"""
    line = dict(n=5000, k=300, o=300, u=100, wk=30, wo=30, kb=50, ks=50, wkb=40, wks=40)
    bad = [] if not floor_miss(**line) else ["hand: at the line"]
    for key, v, want in (("k", 299, "kept<300"), ("o", 299, "out<300"), ("wk", 29, "keptWeeks<30"), ("wo", 29, "outWeeks<30"),
                         ("kb", 49, "BUY<50"), ("ks", 49, "SELL<50"), ("wkb", 39, "BUYWeeks<40"), ("wks", 39, "SELLWeeks<40"),
                         ("u", 101, "unread>2%")):
        if floor_miss(**{**line, key: v}) != [want]:
            bad.append(f"hand: {key} {v}")
    return bad


# ---- the run ----------------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--gmo", required=True)
    ap.add_argument("--labels", required=True)
    ap.add_argument("--counts", required=True)
    ap.add_argument("--mode", choices=["stage0", "syn"], required=True)
    ap.add_argument("--label-end", default="2026-10-09T12:00:00Z")
    a = ap.parse_args()
    if a.mode == "syn":
        start, end, label_end = ms_of("2024-10-01T00:00:00Z"), ms_of("2025-07-26T00:00:00Z"), None
        label_end = end + 7 * DAY
    else:
        start, end, label_end = ms_of("2024-01-01T00:00:00Z"), ms_of("2026-10-03T00:00:00Z"), ms_of(a.label_end)
    split = ms_of("2025-05-19T00:00:00Z")
    y0 = utc(start).year
    frm = {
        "15min": start - 12 * DAY,
        "1h": start - 45 * DAY,
        "4h": start - 90 * DAY if a.mode == "syn" else int(datetime(y0 - 1, 1, 1, tzinfo=timezone.utc).timestamp() * 1000),
    }
    problems, missing = [], []
    bars = {p: {tf: load(a.gmo, p, tf, frm[tf], label_end, problems, missing) for tf in ("15min", "1h", "4h")} for p in PAIRS}
    holes = {tf: closures([bars[p][tf] for p in PAIRS], STEP[tf]) for tf in ("15min", "1h", "4h")}
    gps = {p: {tf: gap_prefix(bars[p][tf], STEP[tf], holes[tf]) for tf in ("15min", "1h", "4h")} for p in PAIRS}
    print(f"read: {', '.join(f'{p} ' + '/'.join(str(bars[p][tf].n) for tf in ('15min', '1h', '4h')) for p in PAIRS)}; files missing {len(missing)}; problems {len(problems)}")
    for m in missing[:5]:
        print(f"  missing {m}")
    print(f"GMO's own closures: {', '.join(f'{tf} {len(holes[tf])}' for tf in holes)}")

    with open(a.labels) as f:
        lines = [l.rstrip("\n") for l in f if l.strip()]
    head = lines[0].split(",")
    want_head = ["T", "pair", "side", "late", "C", "half", "s15", "x15", "s1h", "x1h", "s4h", "x4h"]
    bad = []
    if head != want_head:
        print(f"header {head}, not {want_head}")
        sys.exit(1)
    rows = []
    for l in lines[1:]:
        c = l.split(",")
        r = dict(zip(head, c))
        T = ms_of(r["T"])
        C = T + (15 * MIN if r["late"] == "1" else 0)
        if ms_of(r["C"]) != C:
            bad.append(f"{r['T']} {r['pair']} {r['side']}: C {r['C']}, not {iso(C)}")
        mine = {}
        for tf, s_col, x_col in (("15min", "s15", "x15"), ("1h", "s1h", "x1h"), ("4h", "s4h", "x4h")):
            st, x = label(bars[r["pair"]][tf], gps[r["pair"]][tf], tf, C, holes[tf])
            mine[tf] = (st, x)
            if st != r[s_col] or str(x) != r[x_col]:
                bad.append(f"{r['T']} {r['pair']} {r['side']} {tf}: run {r[s_col]}/{r[x_col]}, here {st}/{x}")
        rows.append((r, T, C, mine))
    print(f"labels: {len(rows)} rows x 3 timeframes, {len(bad)} different")
    for b in bad[:10]:
        print(f"  {b}")

    # the halves: the 1,440th 5-minute bar from C closed by the split (or END), near the edges
    edge = 21 * DAY
    half_bad = []
    my_half = {}
    longest = 0
    for p in PAIRS:
        t5 = []
        for lo_, hi_ in ((split - edge, split + 14 * DAY), (end - edge, end)):
            t5.extend(load(a.gmo, p, "5min", lo_, hi_, problems, missing).t)
        t5.sort()

        def end_of(T, limit):
            lo, hi = 0, len(t5)
            while lo < hi:
                m = (lo + hi) // 2
                if t5[m] < T:
                    lo = m + 1
                else:
                    hi = m
            j = lo + 1439
            if j >= len(t5) or t5[j] + 5 * MIN > limit:
                return None
            return t5[j] + 5 * MIN

        for r, T, C, _ in rows:
            if r["pair"] != p:
                continue
            if T < split:
                if T < split - edge:
                    h = "H1"
                else:
                    e = end_of(C, split)
                    if e:
                        longest = max(longest, e - T)
                    h = "H1" if e is not None and e <= split else "-"
            elif T < end - edge:
                h = "H2"
            else:
                e = end_of(C, end)
                if e:
                    longest = max(longest, e - T)
                h = "H2" if e is not None and e <= end else "-"
            my_half[id(r)] = h
            if h != r["half"]:
                half_bad.append(f"{r['T']} {p} {r['side']}: run {r['half']}, here {h}")
    print(f"halves: {len(half_bad)} different; the longest follow near an edge {longest / DAY:.2f} days; files missing {len(missing)} (with the 5-minute ones)")
    for b in half_bad[:10]:
        print(f"  {b}")

    # the four candidates (§8.106 2) and the counts (§8.106 6), from the labels computed here
    def verdict(c, side, mine):
        sd = 1 if side == "BUY" else -1

        def ok(tf):
            return mine[tf][0] != "-" and mine[tf][1] == 0

        def against(tf):
            return DIR[mine[tf][0]] == -sd

        if c == 0:
            return (-1 if against("1h") else 1) if ok("1h") else 0
        if c == 1:
            return (-1 if against("4h") else 1) if ok("4h") else 0
        if c == 2:
            return (-1 if against("1h") and against("4h") else 1) if ok("1h") and ok("4h") else 0
        return (-1 if against("15min") else 1) if ok("15min") else 0

    def week(ms):
        return (ms - (3 * DAY + 21 * HOUR)) // (7 * DAY)

    names = ["①1H", "②4H", "③1H+4H", "④15M"]
    mine_counts = {}
    for h in ("H1", "H2"):
        # the halves computed here, not the run's
        in_h = [(r, T, mine) for r, T, C, mine in rows if my_half[id(r)] == h]
        for c, name in enumerate(names):
            v = [verdict(c, r["side"], mine) for r, T, mine in in_h]
            for side in ("all", "BUY", "SELL"):
                sel = [(x, T) for (r, T, mine), x in zip(in_h, v) if side == "all" or r["side"] == side]
                mine_counts[(h, name, side)] = (
                    sum(1 for x, _ in sel if x == 1),
                    sum(1 for x, _ in sel if x == -1),
                    sum(1 for x, _ in sel if x == 0),
                    len({week(T) for x, T in sel if x == 1}),
                    len({week(T) for x, T in sel if x == -1}),
                )
    # (a count that differs is named, not printed: §8.106 11, no number leaves a run that failed)
    fields = ("kept", "out", "unread", "weeksKept", "weeksOut")
    with open(a.counts) as f:
        theirs = json.load(f)
    count_bad = []
    for c in theirs["counts"]:
        k = (c["half"], c["cand"], c["side"])
        got = mine_counts.get(k)
        want = tuple(c[x] for x in fields)
        if got is None:
            count_bad.append(f"{k}: not counted here")
        elif got != want:
            count_bad.append(f"{k}: {', '.join(x for x, g, w in zip(fields, got, want) if g != w)} differ")
    if len(theirs["counts"]) != len(mine_counts):
        count_bad.append("the number of counts differs")
    print(f"counts: {len(theirs['counts'])} compared, {len(count_bad)} different")
    for b in count_bad[:10]:
        print(f"  {b}")

    # the floors (§8.106 6), from the counts here: in a half, kept and left out 300 or more each, over 30
    # weeks or more each; BUY and SELL each kept 50 or more over 40 weeks or more; unreadable 2% or less.
    # First on hand-made counts (the walk never meets them: its second half is 10 weeks)
    floor_bad = floors_hand()
    for h in ("H1", "H2"):
        n_h = sum(1 for r, T, C, mine in rows if my_half[id(r)] == h)
        for name in names:
            k, o, u, wk, wo = mine_counts[(h, name, "all")]
            kb, _, _, wkb, _ = mine_counts[(h, name, "BUY")]
            ks, _, _, wks, _ = mine_counts[(h, name, "SELL")]
            miss = floor_miss(n_h, k, o, u, wk, wo, kb, ks, wkb, wks)
            if theirs["floors"].get(f"{h}|{name}") is not (not miss) or theirs.get("misses", {}).get(f"{h}|{name}") != miss:
                floor_bad.append(f"{h} {name}")
    if len(theirs["floors"]) != 2 * len(names) or len(theirs.get("misses", {})) != 2 * len(names):
        floor_bad.append("the number of floors differs")
    # the weeks the run divides by (§8.106 12 の2): each half's length, and the whole's
    my_weeks = {"all": (end - start) / (7 * DAY), "H1": (split - start) / (7 * DAY), "H2": (end - split) / (7 * DAY)}
    for k, w in my_weeks.items():
        got = theirs.get("weeks", {}).get(k)
        if not isinstance(got, (int, float)) or abs(got - w) > 1e-9:
            floor_bad.append(f"weeks {k}")
    print(f"floors: {2 * len(names)} compared, and the weeks; {len(floor_bad)} different{': ' + ', '.join(floor_bad) if floor_bad else ''}")

    # the whole of (a), both halves and the edges (§8.106 12 の2)
    whole_bad = []
    theirs_whole = {w["cand"]: (w["kept"], w["out"], w["unread"]) for w in theirs.get("whole", [])}
    for c, name in enumerate(names):
        v = [verdict(c, r["side"], mine) for r, T, C, mine in rows]
        if theirs_whole.get(name) != (v.count(1), v.count(-1), v.count(0)):
            whole_bad.append(name)
    print(f"whole period: {len(names)} compared, {len(whole_bad)} different{': ' + ', '.join(whole_bad) if whole_bad else ''}")
    ok = not bad and not half_bad and not count_bad and not floor_bad and not whole_bad and not problems and not missing
    print("PYTHON CHECK", "OK" if ok else "FAILED")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
