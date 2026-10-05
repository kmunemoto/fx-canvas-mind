#!/usr/bin/env python3
# #188: the rows the study told to look into before reporting (docs §8.99
# 先読みを疑うとき), looked into from the run's own files (research/out of the
# real data's run 2, every check 0 differ). The study printed three:
#
#   1. row_p12_FF1_C0: the fall with the open P/L under the exits' (the
#      balance alone). Where each fall's peak and trough are, and the balance
#      and the equity (the balance and the open P/L) at each, from its ledger.
#   2. and 3. row_nights_F10k_C0 / row_nights_FF1_C0: better a trade than the
#      cell with the nights. The 3,958 trades (CALL9, main) split by the
#      email's close: 16:00 and 20:00 UTC (the nights) and the rest; each
#      part's count, TP1 first, pips a trade and the spread paid, and the
#      difference of pips a trade with a 95% interval from resampling the
#      weeks (2,000 draws, seeded 188), also with the spread added back.
#
# Reads only; prints only. Usage: python3 research/money-look.py DIR
import csv
import json
import os
import random
import sys
from datetime import datetime, timezone

d = sys.argv[1]
WEEK0 = datetime(2023, 12, 31, 21, tzinfo=timezone.utc).timestamp()


def ts(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()


def yen(x):
    return f"¥{x:,.0f}"


# ---- 1. the falls ------------------------------------------------------------------------------
js = json.load(open(os.path.join(d, "money.json")))
every = {**js["cells"], **js["rows"]}
flagged = [k for k, s in every.items() if s["mdd_yen"] < s["mdd_exits"]["yen"] - 1e-6]
print(f"== 1. THE FALLS: open P/L under the exits' in {len(flagged)} of {len(every)} cells and rows: {', '.join(flagged) or '-'}")
for k in flagged:
    s = every[k]
    rows = list(csv.DictReader(open(os.path.join(d, f"money-ledger-{k}.csv"))))
    t = [ts(r["g"]) for r in rows]

    def at(iso_):
        # the ledger's last row at or before the time (the ledger has a row
        # at each entry and exit; the equity between rows is not in it)
        x = ts(iso_)
        i = max(j for j in range(len(rows)) if t[j] <= x)
        r = rows[i]
        b, e = float(r["balance"]), float(r["equity"])
        same = "at it" if t[i] == x else f"the last before it, {r['g']}"
        return f"{iso_}: ledger row {r['seq']} ({r['kind']}, {same}): balance {yen(b)}, equity {yen(e)} (open P/L {yen(e - b)})"

    for name, m in (("with the open P/L (every 5-minute close)", s["mdd"]), ("the exits only (the balance)", s["mdd_exits"])):
        print(f"  {k}, {name}: fall {yen(m['yen'])}")
        print(f"    peak   {at(m['peak'])}")
        print(f"    trough {at(m['trough'])}")
    x_tr = ts(s["mdd"]["trough"])
    hi_b = max(float(r["balance"]) for r in rows)
    hi_e = max(float(r["equity"]) for j, r in enumerate(rows) if t[j] <= x_tr)
    print(f"    the highest balance {yen(hi_b)}; the highest equity on the ledger's rows up to the open-P/L trough {yen(hi_e)}; the last row ({rows[-1]['g']}): balance {yen(float(rows[-1]['balance']))}, equity {yen(float(rows[-1]['equity']))}")

# ---- 2. the nights ------------------------------------------------------------------------------
sig = {r["id"]: r for r in csv.DictReader(open(os.path.join(d, "money-signals.csv")))}
trades = []
for r in csv.DictReader(open(os.path.join(d, "money-trades.csv"))):
    if r["variant"] != "main":
        continue
    s = sig[r["id"]]
    if s["group"] != "CALL9":
        continue
    T = ts(s["T"])
    unit = 0.01 if s["pair"].endswith("JPY") else 0.0001
    trades.append({
        "night": datetime.fromtimestamp(T, timezone.utc).hour in (16, 20),
        "hour": datetime.fromtimestamp(T, timezone.utc).hour,
        "week": int((T - WEEK0) // (7 * 86400)),
        "tp": r["exit_kind"] == "tp",
        "kind": r["exit_kind"],
        "pips": float(r["pips"]),
        "spread": 2 * abs(float(r["fill"]) - float(r["mid_close"])) / unit,
    })


def part(ts_):
    n = len(ts_)
    sp = sorted(t["spread"] for t in ts_)
    med = (sp[(n - 1) // 2] + sp[n // 2]) / 2
    return f"{n} trades, TP1 first {100 * sum(t['tp'] for t in ts_) / n:.1f}%, {sum(t['pips'] for t in ts_) / n:+.2f} pips a trade, spread paid mean {sum(sp) / n:.2f} (median {med:.2f}), {sum(t['pips'] + t['spread'] for t in ts_) / n:+.2f} with the spread added back"


night = [t for t in trades if t["night"]]
rest = [t for t in trades if not t["night"]]
print(f"\n== 2. THE NIGHTS (CALL9, main: {len(trades)} trades; exit kinds {dict(sorted({k: sum(t['kind'] == k for t in trades) for k in set(t['kind'] for t in trades)}.items()))})")
print(f"  the nights (16:00, 20:00 UTC): {part(night)}")
print(f"  the rest:                       {part(rest)}")
for h in sorted(set(t["hour"] for t in trades)):
    print(f"    {h:02d}:00 UTC: {part([t for t in trades if t['hour'] == h])}")

weeks = sorted(set(t["week"] for t in trades))
byw = {w: [t for t in trades if t["week"] == w] for w in weeks}


def diff(ts_, f):
    a = [f(t) for t in ts_ if not t["night"]]
    b = [f(t) for t in ts_ if t["night"]]
    return sum(a) / len(a) - sum(b) / len(b) if a and b else None


rng = random.Random(188)
for label, f in (("pips", lambda t: t["pips"]), ("pips with the spread added back", lambda t: t["pips"] + t["spread"])):
    draws = []
    for _ in range(2000):
        pick = [t for w in (rng.choice(weeks) for _ in weeks) for t in byw[w]]
        x = diff(pick, f)
        if x is not None:
            draws.append(x)
    draws.sort()
    lo, hi = draws[int(0.025 * len(draws))], draws[int(0.975 * len(draws)) - 1]
    print(f"  the rest less the nights, {label} a trade: {diff(trades, f):+.2f} [{lo:+.2f}, {hi:+.2f}] (95%, {len(weeks)} weeks resampled, {len(draws)} draws)")
