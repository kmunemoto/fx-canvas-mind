#!/usr/bin/env python3
"""#188: the hand examples' second calculation (docs §8.99 「手で計算した小さな例」).

make.py writes each fixture's files and, beside them, the numbers worked out by
hand (fixture.json's "expect"). This file works the same numbers out again,
apart from the hand: it reads only what make.py wrote (gmo/, signals.csv and
the runs in fixture.json) and walks the account bar by bar as §8.99 says, so a
slip in the hand's arithmetic, or a file written wrong, shows up as a
difference. It is NOT research/money-check.py (that one checks the study on
the real data); it does only what the fixtures use: the nine pairs' JPY and
USD pairs, the 25× course, F10k and FFk sizing, the caps, and the rows late,
thirds, net and turtle.

It also puts each planted error (interface.md §8) into its OWN reading, so
make.py can show that every plant moves at least one number a fixture expects.
How each plant is read here is written at PLANTS below; the study's own plants
may be done differently, and a fixture listing a plant is a claim made by hand
in its "hand" text, which this only confirms on this reading.

Rules read from §8.99 and the shared interface (§2), and the choices the two
leave open, are written where they are used; the ones the fixtures had to
decide are listed in make.py's README text too.
"""

import csv
import glob
import json
import math
import os
from datetime import datetime, timedelta, timezone
from decimal import ROUND_HALF_UP, Decimal
from zoneinfo import ZoneInfo

MIN = 60_000
HOUR = 60 * MIN
DAY = 24 * HOUR
FINE = 5 * MIN
STEP4 = 4 * HOUR
NY = ZoneInfo("America/New_York")
# the admission order (LIVE_PAIRS' order restricted to the pairs in play)
ORDER = ["USD/JPY", "EUR/JPY", "GBP/JPY", "AUD/JPY", "EUR/USD", "AUD/USD", "MXN/JPY", "NZD/JPY", "ZAR/JPY", "CAD/JPY", "CHF/JPY", "TRY/JPY"]
SYMBOL = {p: p.replace("/", "_") for p in ORDER}
SL, TP = 13, (4, 10, 16)
LIMIT = 30
# planted errors, each as this file reads it (interface.md §8)
PLANTS = {
    "sizefuture": "units from the equity at T + 4 h (the clean run's, at the last grid time by then)",
    "slotearly": "a cap slot free from the open of the exit's 5-minute bar",
    "exitlate": "every exit at the end of the pair's next 5-minute bar (the same price)",
    "pipplus": "the first trade of signals.csv out 1 pip better",
    "usdentry": "a USD pair's yen at the USD/JPY mid of its entry (T)",
    "hedgesum": "a pair's margin on its longs plus its shorts",
    "roundlot": "units rounded to the nearest 1,000, not cut down",
    "skipgaplc": "no loss-cut test on the first grid time after a gap of over a day",
    "callexitside": "the call tested, and C counted, on the exit side's closes",
    "nysummer": "the NY close at 21:55 UTC in US summer time as well",
    "marginentry": "margin on the entry's price and USD/JPY, fixed",
    "curemove": "a call also cured when the equity on mids is back at the margin",
}


def ms_of(s):
    return int(datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp() * 1000)


def iso(ms):
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def to_fixed(x, d):
    """Number(x.toFixed(d)): the exact binary value, halves up."""
    return float(Decimal(x).quantize(Decimal(1).scaleb(-d), rounding=ROUND_HALF_UP))


# ---- the files -----------------------------------------------------------------------------


def read_bars(gmo, pair, interval):
    """[(open ms, bid (o,h,l,c), ask (o,h,l,c))] by open time, both sides."""
    sides = {}
    for side in ("bid", "ask"):
        rows = {}
        for path in sorted(glob.glob(os.path.join(gmo, SYMBOL[pair], interval, side, "*.json"))):
            with open(path) as f:
                body = json.load(f)
            for r in body["data"]:
                rows[int(r["openTime"])] = tuple(float(r[k]) for k in ("open", "high", "low", "close"))
        sides[side] = rows
    return [(t, sides["bid"][t], sides["ask"][t]) for t in sorted(sides["bid"]) if t in sides["ask"]]


# ---- the trades (as stop2n.ts tradeAt, stop in pips) ---------------------------------------


class Trade:
    pass


def follow(fine, f, buy, sl, tp, limit_end):
    """(kind, index of the 5-minute bar it went out in, price) or None."""
    j = f
    last = None
    while j < len(fine) and fine[j][0] < limit_end:
        t, b, a = fine[j]
        o, h, l = (b[0], b[1], b[2]) if buy else (a[0], a[1], a[2])
        if (o <= sl) if buy else (o >= sl):
            return ("sl", j, o)
        if (o >= tp) if buy else (o <= tp):
            return ("tp", j, o)
        hit_sl = l <= sl if buy else h >= sl
        hit_tp = h >= tp if buy else l <= tp
        if hit_sl and hit_tp:
            return ("amb", j, sl)
        if hit_sl:
            return ("sl", j, sl)
        if hit_tp:
            return ("tp", j, tp)
        last = j
        j += 1
    if last is not None and j < len(fine):
        c = fine[last][1][3] if buy else fine[last][2][3]
        return ("time", last, c)
    return None


def build_trades(fx, gmo, signals, plants):
    fine = {p: read_bars(gmo, p, "5min") for p in fx["pairs"]}
    four = {p: read_bars(gmo, p, "4hour") for p in fx["pairs"]}
    trades = []
    for k, s in enumerate(signals):
        tr = Trade()
        tr.id, tr.pair, tr.side = s["id"], s["pair"], s["side"]
        tr.T = ms_of(s["T"])
        tr.buy = tr.side == "BUY"
        tr.dir = 1 if tr.buy else -1
        tr.usd = not tr.pair.endswith("/JPY")
        tr.unit = 0.0001 if tr.usd else 0.01
        tr.order = (tr.T, ORDER.index(tr.pair), 0 if tr.buy else 1)
        bar_open = ms_of(s["bar_open"])
        if bar_open + STEP4 != tr.T:
            raise SystemExit(f"{tr.id}: T is not the signal bar's close")
        i = next(i for i, q in enumerate(four[tr.pair]) if q[0] == bar_open)
        _, b, a = four[tr.pair][i]
        tr.close = to_fixed((b[3] + a[3]) / 2, fx["digits"][tr.pair])
        tr.fill = a[3] if tr.buy else b[3]
        tr.sl = tr.close - tr.dir * SL * tr.unit
        tr.tps = [tr.close + tr.dir * x * tr.unit for x in TP]
        limit_end = four[tr.pair][i + LIMIT][0] + STEP4 if i + LIMIT < len(four[tr.pair]) else math.inf
        fn = fine[tr.pair]
        f = next((j for j, q in enumerate(fn) if q[0] >= tr.T), len(fn))
        tr.exits = {}
        for v, tp in (("main", tr.tps[0]), ("tp2", tr.tps[1]), ("tp3", tr.tps[2])):
            out = follow(fn, f, tr.buy, tr.sl, tp, limit_end)
            if out is None:
                raise SystemExit(f"{tr.id} {v}: no exit in the fixture's bars")
            tr.exits[v] = out
        # five minutes late: the first bar's close, not entered where its close
        # on the exit side is already past TP1 or the stop (tf-winrate's rule)
        _, b5, a5 = fn[f]
        tr.late_g = fn[f][0] + FINE
        tr.late_fill = a5[3] if tr.buy else b5[3]
        xc = b5[3] if tr.buy else a5[3]
        tr.passed = (xc >= tr.tps[0] or xc <= tr.sl) if tr.buy else (xc <= tr.tps[0] or xc >= tr.sl)
        tr.exits["late"] = None if tr.passed else follow(fn, f + 1, tr.buy, tr.sl, tr.tps[0], limit_end)
        if "pipplus" in plants and k == 0:
            for v, out in tr.exits.items():
                if out:
                    tr.exits[v] = (out[0], out[1], out[2] + tr.dir * tr.unit)
        if "exitlate" in plants:
            for v, out in tr.exits.items():
                if out:
                    tr.exits[v] = (out[0], min(out[1] + 1, len(fn) - 1), out[2])
        trades.append(tr)
    return trades, fine


# ---- the account -------------------------------------------------------------------------


def ny_closes(first_ms, last_ms, plants):
    """Rakuten's NY close on each weekday: 16:55 New York time (05:55 / 06:55
    JST), from the IANA database."""
    out = []
    d = datetime.fromtimestamp(first_ms / 1000, tz=timezone.utc).date() - timedelta(days=1)
    end = datetime.fromtimestamp(last_ms / 1000, tz=timezone.utc).date() + timedelta(days=8)
    while d <= end:
        if d.weekday() < 5:
            tau = int(datetime(d.year, d.month, d.day, 16, 55, tzinfo=NY).timestamp() * 1000)
            if "nysummer" in plants:
                tau = int(datetime(d.year, d.month, d.day, 21, 55, tzinfo=timezone.utc).timestamp() * 1000)
            out.append(tau)
        d += timedelta(days=1)
    return out


def next_weekday_9(tau):
    d = datetime.fromtimestamp(tau / 1000, tz=timezone.utc).date() + timedelta(days=1)
    while d.weekday() >= 5:
        d += timedelta(days=1)
    return int(datetime(d.year, d.month, d.day, 9, 0, tzinfo=timezone.utc).timestamp() * 1000)


def run_account(fx, run, trades, fine, plants, e_clean=None):
    sizing, cap, row = run["sizing"], run["cap"], run.get("row")
    rate = 0.04 if run["course"] == 25 else 0.10
    lc = run["losscut"]
    start = float(run["start_equity"])
    f10k = sizing == "F10k"
    k = {"FF025": 0.0025, "FF05": 0.005, "FF1": 0.01, "FF2": 0.02}.get(sizing)
    pairs = fx["pairs"]
    ends = {p: [q[0] + FINE for q in fine[p]] for p in pairs}
    grid = sorted({g for p in pairs for g in ends[p]})
    last = {p: -1 for p in pairs}

    def px(p, how):
        j = last[p]
        if j < 0:
            raise SystemExit(f"{p}: no price yet")
        _, b, a = fine[p][j]
        return b[3] if how == "bid" else a[3] if how == "ask" else (b[3] + a[3]) / 2

    def conv(p):
        return px("USD/JPY", "mid") if not p.endswith("/JPY") else 1.0

    led = []
    st = {"balance": start, "taken": set(), "skipped": {"call": 0, "cap": 0, "lot": 0, "margin": 0, "passed": 0}, "calls": 0, "cures": 0, "deadlines": 0, "losscuts": 0, "shortfall": 0.0}
    pos = []  # open positions, in admission order
    pending = []  # late emails admitted at T, filled at the first bar's close
    call = None
    terms = {n: None for n in ("order", "nyclose", "losscut", "loss")}
    seq = [0]
    admitted = [0]

    def add(**r):
        seq[0] += 1
        led.append({"seq": seq[0], **r})

    def mark(q, how):
        side = how if how == "mid" else ("bid" if q["dir"] > 0 else "ask")
        c = q["conv_entry"] if "usdentry" in plants and q["usd"] else conv(q["pair"])
        return (px(q["pair"], side) - q["fill"]) * q["dir"] * q["units"] * c

    def equity(how="exit"):
        return st["balance"] + sum(mark(q, how) for q in pos)

    def margin(ps, mids=None):
        by = {}
        for q in ps:
            m = by.setdefault(q["pair"], [0.0, 0.0, 0.0, 0.0])
            if "marginentry" in plants:
                c = q["conv_entry"] if q["usd"] else 1.0
                m[0 if q["dir"] > 0 else 1] += q["units"] * q["fill"] * c
                m[2] = 1.0
            else:
                m[0 if q["dir"] > 0 else 1] += q["units"]
                m[2] = mids[q["pair"]] if mids else px(q["pair"], "mid") * conv(q["pair"])
        tot = 0.0
        for p, (L, S, mid, _) in by.items():
            tot += rate * ((L + S) if "hedgesum" in plants else max(L, S)) * mid
        return tot

    def close(q, units, price, g, reason):
        c = q["conv_entry"] if "usdentry" in plants and q["usd"] else conv(q["pair"])
        pnl = (price - q["fill"]) * q["dir"] * units * c
        st["balance"] += pnl
        q["units"] -= units
        if q["units"] == 0:
            pos.remove(q)
        add(g=iso(g), kind="exit", id=q["id"], units=units, px=price, pnl_yen=pnl, balance=st["balance"], reason=reason)

    def bump(name, value, g, lost):
        cur = terms[name]
        if cur is None or value > cur["value"]:
            terms[name] = {"name": name, "value": value, "g": iso(g), "lost": lost}

    def open_count(s, tr):
        live = [q for q in pos if not ("slotearly" in plants and q.get("exit_open") is not None and q["exit_open"] <= s)]
        live += pending
        if cap == "C0":
            return False
        if cap in ("T1", "T3"):
            return len({q["trade"] for q in live}) >= (1 if cap == "T1" else 3)
        if cap == "P1":
            return any(q["pair"] == tr.pair for q in live)
        if cap == "J2":
            if tr.usd:
                return False
            return len({q["trade"] for q in live if not q["usd"] and q["dir"] == tr.dir}) >= 2
        raise SystemExit(cap)

    def size(e_at, tr):
        if f10k:
            return 10_000
        base = e_at
        if row == "turtle":
            m = math.floor((start - e_at) / (0.1 * start))
            if m >= 1:
                base = min(e_at, start * 0.8**m)
        q = k * base / (SL * tr.unit * conv(tr.pair)) / 1000
        return (math.floor(q + 0.5) if "roundlot" in plants else math.floor(q)) * 1000

    def legs_of(u):
        if row != "thirds":
            return [u]
        if f10k:
            return [4000, 3000, 3000]
        # the whole first, then 1,000-unit lots dealt to TP1, TP2, TP3 in turn
        # (the larger first); for 10 lots or fewer this is also 0.4/0.3/0.3
        # with the largest remainders, so the fixture does not tell the two apart
        lots = [0, 0, 0]
        for i in range(u // 1000):
            lots[i % 3] += 1
        return [x * 1000 for x in lots]

    def new_pos(tr, units, fill, leg, variant):
        out = tr.exits[variant]
        kind, j, xp = out
        q = {"id": tr.id + (f"#{leg}" if leg else ""), "trade": tr.id, "pair": tr.pair, "dir": tr.dir, "usd": tr.usd, "units": units, "fill": fill,
             "kind": kind, "x": fine[tr.pair][j][0] + FINE, "exit_open": fine[tr.pair][j][0], "xpx": xp, "admit": admitted[0], "conv_entry": conv(tr.pair)}
        admitted[0] += 1
        pos.append(q)
        return q

    taus = ny_closes(grid[0], grid[-1], plants)
    gset = set(grid)
    tau_at = {}
    for tau in taus:
        if tau in gset:
            tau_at.setdefault(tau, []).append(tau)
        else:
            before = [g for g in grid if g < tau]
            if before:
                tau_at.setdefault(before[-1], []).append(tau)
    emails = sorted(trades, key=lambda t: t.order)
    ei = 0
    prev_g = None
    for g in grid:
        s = g - FINE
        gap = prev_g is not None and g - prev_g > DAY
        if ei < len(emails) and emails[ei].T < s:
            raise SystemExit(f"{emails[ei].id}: no union bar opens at T (the fixtures keep one)")
        # ① the deadline of a call not cured
        if call and call["d"] <= s:
            add(g=iso(s), kind="deadline")
            for q in list(pos):
                fn = fine[q["pair"]]
                j = next(j for j, b in enumerate(fn) if b[0] >= call["d"])
                price = fn[j][1][0] if q["dir"] > 0 else fn[j][2][0]
                if fn[j][0] != s:
                    raise SystemExit("the fixtures keep every pair's bar at the deadline")
                close(q, q["units"], price, s, "deadline")
            st["deadlines"] += 1
            call = None
        # ② the emails of this time, on the state at s
        batch = []
        while ei < len(emails) and emails[ei].T == s:
            batch.append(emails[ei])
            ei += 1
        if batch:
            e_s = equity()
            pnl_s = e_s - start
            for tr in batch:
                e_size = e_s
                if "sizefuture" in plants and e_clean is not None:
                    e_size = [v for t_, v in e_clean if t_ <= tr.T + STEP4][-1]
                u = size(e_size, tr)
                if row == "net":
                    opp = [q for q in pos if q["pair"] == tr.pair and q["dir"] == -tr.dir]
                    left = u
                    for q in sorted(opp, key=lambda q: q["admit"]):
                        if left == 0:
                            break
                        take = min(left, q["units"])
                        close(q, take, tr.fill, s, "net")
                        left -= take
                    if left == 0:
                        continue
                    u = left
                if not f10k and call:
                    add(g=iso(s), kind="skip", id=tr.id, reason="call")
                    st["skipped"]["call"] += 1
                    continue
                if open_count(s, tr):
                    add(g=iso(s), kind="skip", id=tr.id, reason="cap")
                    st["skipped"]["cap"] += 1
                    continue
                if not f10k and u < 1000:
                    add(g=iso(s), kind="skip", id=tr.id, reason="lot")
                    st["skipped"]["lot"] += 1
                    continue
                mids = {}
                for q in pos + pending:
                    mids[q["pair"]] = px(q["pair"], "mid") * conv(q["pair"])
                mids[tr.pair] = px(tr.pair, "mid") * conv(tr.pair)
                probe = {"pair": tr.pair, "dir": tr.dir, "units": u, "fill": tr.fill, "usd": tr.usd, "conv_entry": conv(tr.pair)}
                m_after = margin(pos + pending + [probe], mids)
                if not f10k and m_after > e_s:
                    add(g=iso(s), kind="skip", id=tr.id, reason="margin")
                    st["skipped"]["margin"] += 1
                    continue
                if f10k:
                    bump("order", m_after - pnl_s, s, -pnl_s)
                if row == "late":
                    pending.append({"tr": tr, "units": u, "pair": tr.pair, "dir": tr.dir, "usd": tr.usd, "fill": tr.fill, "trade": tr.id, "conv_entry": conv(tr.pair)})
                    continue
                st["taken"].add(tr.id)
                for leg, lu in enumerate(legs_of(u), start=1):
                    if lu == 0:
                        continue
                    variant = ("main", "tp2", "tp3")[leg - 1] if row == "thirds" else "main"
                    new_pos(tr, lu, tr.fill, leg if row == "thirds" else 0, variant)
                    add(g=iso(s), kind="enter", id=tr.id + (f"#{leg}" if row == "thirds" else ""), units=lu, px=tr.fill, margin=margin(pos))
        # the closes at g (a USD pair out inside this bar is turned into yen at
        # the USD/JPY mid of its exit's g)
        for p in pairs:
            while last[p] + 1 < len(ends[p]) and ends[p][last[p] + 1] <= g:
                last[p] += 1
        # ③ the exits inside this bar, in admission order; then the late fills
        for q in sorted([q for q in pos if q["x"] == g], key=lambda q: q["admit"]):
            close(q, q["units"], q["xpx"], g, q["kind"])
        for p in list(pending):
            tr = p["tr"]
            if tr.late_g != g:
                continue
            pending.remove(p)
            if tr.passed:
                add(g=iso(g), kind="skip", id=tr.id, reason="passed")
                st["skipped"]["passed"] += 1
                continue
            st["taken"].add(tr.id)
            new_pos(tr, p["units"], tr.late_fill, 0, "late")
            add(g=iso(g), kind="enter", id=tr.id, units=p["units"], px=tr.late_fill)
        # ④ the loss-cut on the exit side, then the cure of an open call
        if not f10k and pos and not ("skipgaplc" in plants and gap):
            e = equity()
            m = margin(pos)
            if e < lc * m:
                add(g=iso(g), kind="losscut", equity=e, margin=m)
                for q in list(pos):
                    close(q, q["units"], px(q["pair"], "bid" if q["dir"] > 0 else "ask"), g, "losscut")
                st["losscuts"] += 1
        if call:
            still = [dict(q, units=min(q["units"], call["units"][q["id"]])) for q in pos if q["id"] in call["units"]]
            released = call["m_tau"] - margin(still, call["mids"])
            cured = released >= call["C"]
            if "curemove" in plants and equity("mid") >= margin(pos):
                cured = True
            if cured:
                add(g=iso(g), kind="cure")
                st["cures"] += 1
                call = None
        # ⑤ the NY close (or the last grid time before it), on mids
        for tau in tau_at.get(g, []):
            m = margin(pos)
            e_mid = equity("mid")
            if f10k:
                bump("nyclose", m - (e_mid - start), g, -(e_mid - start))
                continue
            if call:
                continue
            e_test = equity() if "callexitside" in plants else e_mid
            if e_test < m:
                C = m - e_test
                mids = {q["pair"]: px(q["pair"], "mid") * conv(q["pair"]) for q in pos}
                call = {"C": C, "d": next_weekday_9(tau), "units": {q["id"]: q["units"] for q in pos}, "mids": mids, "m_tau": m}
                add(g=iso(g), kind="call", pnl_yen=C, margin=m)
                st["calls"] += 1
        # ⑥ the record
        if f10k:
            e = equity()
            bump("losscut", lc * margin(pos) - (e - start), g, -(e - start))
            bump("loss", -(e - start), g, -(e - start))
        st.setdefault("path", []).append((g, equity()))
        prev_g = g
    if ei < len(emails) or pending or pos:
        raise SystemExit("an email, a late fill or a position is left after the last bar")
    summary = {"final_balance": st["balance"], "final_equity": st["balance"], "taken": len(st["taken"]), "skipped": st["skipped"],
               "calls": st["calls"], "cures": st["cures"], "deadlines": st["deadlines"], "losscuts": st["losscuts"], "shortfall_yen": st["shortfall"]}
    if f10k:
        tl = [terms[n] for n in ("order", "nyclose", "losscut", "loss")]
        top = max(tl, key=lambda t: t["value"])
        summary["estar"] = {"value": top["value"], "terms": [{"name": t["name"], "value": t["value"], "g": t["g"]} for t in tl],
                            "lost": top["lost"], "margin": top["value"] - top["lost"], "binding": top["name"]}
    return led, summary, st["path"]


# ---- the comparison ------------------------------------------------------------------------

TOL = {"px": 1e-9, "pnl_yen": 1e-6, "balance": 1e-6, "equity": 1e-6, "margin": 1e-6, "value": 1e-6,
       "final_balance": 1e-6, "final_equity": 1e-6, "shortfall_yen": 1e-6, "lost": 1e-6}


def same(a, b, key):
    if isinstance(a, float) or isinstance(b, float):
        if a is None or b is None:
            return a is b
        return abs(float(a) - float(b)) <= TOL.get(key, 1e-6)
    return a == b


def diff(want, got, path=""):
    """Every key in `want` must be in `got` with the same value (the
    fixture's tolerances); lists the same length."""
    out = []
    if isinstance(want, dict):
        for kk, v in want.items():
            if not isinstance(got, dict) or kk not in got:
                out.append(f"{path}.{kk}: missing")
                continue
            out += diff(v, got[kk], f"{path}.{kk}")
        return out
    if isinstance(want, list):
        if not isinstance(got, list) or len(want) != len(got):
            return [f"{path}: {len(want)} rows wanted, {len(got) if isinstance(got, list) else got} got"]
        for i, (w, g) in enumerate(zip(want, got)):
            out += diff(w, g, f"{path}[{i}]")
        return out
    key = path.rsplit(".", 1)[-1]
    if not same(want, got, key):
        out.append(f"{path}: want {want!r}, got {got!r}")
    return out


def read_signals(path):
    with open(path) as f:
        return list(csv.DictReader(f))


def recompute(fixdir, plants=()):
    """{run key: {ledger, summary}} for a fixture, with `plants` put in."""
    with open(os.path.join(fixdir, "fixture.json")) as f:
        fx = json.load(f)
    signals = read_signals(os.path.join(fixdir, "signals.csv"))
    gmo = os.path.join(fixdir, "gmo")
    out = {}
    for run in fx["runs"]:
        e_clean = None
        if "sizefuture" in plants:
            trades, fine = build_trades(fx, gmo, signals, ())
            e_clean = run_account(fx, run, trades, fine, ())[2]
        trades, fine = build_trades(fx, gmo, signals, set(plants))
        led, summary, _ = run_account(fx, run, trades, fine, set(plants), e_clean)
        out[run["key"]] = {"ledger": led, "summary": summary}
    return fx, out


if __name__ == "__main__":
    import sys

    for d in sys.argv[1:]:
        fx, got = recompute(d)
        bad = diff(fx["expect"], got)
        print(f"{fx['name']}: {'PASS' if not bad else 'FAIL'}")
        for b in bad[:20]:
            print("   ", b)
