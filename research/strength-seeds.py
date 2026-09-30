#!/usr/bin/env python3
"""The walks' summary for research/strength.ts (#174): the checks, and the
gates its header fixes before the data is read.

Usage:
  python3 research/strength-seeds.py <folder>          the gates (null, rank,
                                                       trend, the faults)
  python3 research/strength-seeds.py --delta <folder>  seed 7's rank runs at
                                                       each δ: the δ to use
"""
import glob
import json
import math
import os
import sys

TRADED = ["USD/JPY", "EUR/JPY", "GBP/JPY", "AUD/JPY", "NZD/JPY", "CAD/JPY", "CHF/JPY", "EUR/USD", "GBP/USD", "AUD/USD", "NZD/USD"]
CURRENCIES = ["JPY", "USD", "EUR", "GBP", "AUD", "NZD", "CAD", "CHF"]
SPREAD_PIPS = {"USD/JPY": 0.2, "EUR/JPY": 0.4, "GBP/JPY": 0.9, "AUD/JPY": 0.6, "NZD/JPY": 1.2, "CAD/JPY": 1.5, "CHF/JPY": 1.8, "EUR/USD": 0.3, "GBP/USD": 1.0, "AUD/USD": 0.5, "NZD/USD": 1.3}


def load(folder, pattern, deep=False):
    out = []
    for p in sorted(glob.glob(os.path.join(folder, "**", pattern) if deep else os.path.join(folder, pattern), recursive=deep)):
        with open(p) as f:
            out.append(json.load(f))
    return out


def merged(runs, series, halves=(0, 1)):
    n = 0
    s = 0.0
    for r in runs:
        for h in halves:
            a = r["store"].get(f"{series}|{h}")
            if a:
                n += a["n"]
                s += a["sum"]
    return (s / n if n else None), n


def se_of_means(xs):
    xs = [x for x in xs if x is not None]
    if len(xs) < 2:
        return None
    m = sum(xs) / len(xs)
    return math.sqrt(sum((x - m) ** 2 for x in xs) / (len(xs) - 1)) / math.sqrt(len(xs))


def fmt(x, d=2):
    return "  -  " if x is None else f"{x:+.{d}f}"


def larger_se(a):
    ses = [x for x in (a["se"], a["se4"]) if x is not None]
    return max(ses) if len(ses) == 2 else None


if len(sys.argv) > 2 and sys.argv[1] == "--delta":
    # each δ's run in a folder of its own (the file names do not carry δ)
    runs = [r for r in load(sys.argv[2], "strength-rank*-7.json", deep=True) if r.get("verdict") and not r["fault"] and r["allDiffer"] == 0 and r["seed"] == 7]
    if not runs:
        sys.exit("no clean rank runs on seed 7")
    for L in sorted({r["lstar"] for r in runs}):
        have = sorted(r["delta"] for r in runs if r["lstar"] == L)
        if have != [0.5, 1, 1.5, 2]:
            sys.exit(f"L* {L}: the δ runs are {have}, not 0.5, 1, 1.5 and 2 each once (clean, seed 7)")
    print("seed 7, the planted candidate's second-half e against 5 standard errors (the larger of by week and by four weeks):")
    chosen = {}
    for r in sorted(runs, key=lambda r: (r["lstar"], r["delta"])):
        c = r["Ls"].index(r["lstar"])
        a = r["candidates"][c]["second"]
        se = larger_se(a)
        z = a["m"] / se if se else None
        ok = z is not None and z >= 5
        print(f"  L* {r['lstar']:2} δ {r['delta']:3}: e {fmt(a['m'])} of {a['n']}, se {fmt(se)}, {fmt(z, 1)} se{'  <- 5 or more' if ok else ''}")
        if ok and r["lstar"] not in chosen:
            chosen[r["lstar"]] = r["delta"]
    for L in sorted({r["lstar"] for r in runs}):
        print(f"  L* {L}: δ {chosen.get(L, 'NONE of 0.5 .. 2: look into the walk')}")
    sys.exit(0)

folder = sys.argv[1] if len(sys.argv) > 1 else "research/out"
ok_all = True


def settled(runs, what):
    # the header's period and 1,000 placebos on every run gated
    bad = [r["seed"] for r in runs if (r["start"], r["split"], r["now"]) != ("2024-01-01", "2025-05-19", "2026-09-29 14:16:25") or r["placebo"]["n"] != 1000]
    if bad:
        sys.exit(f"{what}: seeds {bad} not run with the header's period and 1,000 placebos")


def gate(ok, what):
    global ok_all
    if not ok:
        ok_all = False
    print(f"  {'passed' if ok else 'NOT PASSED'}: {what}")


# ---- null ------------------------------------------------------------------------------
null = load(folder, "strength-null-[0-9]*.json")
seeds = sorted(r["seed"] for r in null)
print(f"null: {len(null)} runs, seeds {seeds[0] if seeds else '-'} .. {seeds[-1] if seeds else '-'}")
if seeds != list(range(7, 57)) or any(r["synth"] != "null" or r["fault"] for r in null):
    sys.exit(f"not the fifty null runs the gates are fixed on (seeds 7 .. 56, no fault): {seeds}")
settled(null, "null")
Ls = null[0]["Ls"]
names = sorted(null[0]["checks"])
print("  checks, the runs together: " + ", ".join(f"{k} {sum(r['checks'][k]['mismatched'] for r in null)} of {sum(r['checks'][k]['compared'] for r in null)}" for k in names))
gate(all(r["allDiffer"] == 0 for r in null), "every check 0 differ on every run")
calls = sum(1 for r in null if r["verdict"]["called"])
bonf = sum(1 for r in null if any(r["verdict"]["bonf"]))
gate(calls <= 3, f"the call on {calls} of 50 (at most 3)")
gate(bonf <= 3, f"the Bonferroni road on {bonf} of 50 (at most 3)")
for c, L in enumerate(Ls):
    means = [r["candidates"][c]["all"]["m"] if r["candidates"][c]["all"] else None for r in null]
    pooled, n = merged(null, f"X{L} e")
    se = se_of_means(means)
    gate(pooled is not None and se is not None and abs(pooled) <= 0.3 and abs(pooled) <= 3 * se, f"X{L}: e, the seeds together, {fmt(pooled)} of {n} (se {fmt(se)}): within ±0.3 and 3 se")
    # widetp's rule (research/widetp-seeds.py): z by week and z by four
    # weeks, each sd at most 1.25; the low end (the lower of the two) over 0
    # on fewer than 7 of the 100
    zs = []
    z4s = []
    lows = 0
    for r in null:
        for part in ("first", "second"):
            a = r["candidates"][c][part]
            if not a or not a["se"] or not a["se4"]:
                continue
            zs.append(a["m"] / a["se"])
            z4s.append(a["m"] / a["se4"])
            if a["low"] is not None and a["low"] > 0:
                lows += 1

    def mean_sd(xs):
        m = sum(xs) / len(xs)
        return m, math.sqrt(sum((x - m) ** 2 for x in xs) / (len(xs) - 1))

    mz, sdz = mean_sd(zs)
    mz4, sdz4 = mean_sd(z4s)
    keep = lows < 7 and sdz <= 1.25 and sdz4 <= 1.25
    print(f"  X{L}: z on the halves ({len(zs)}): by week mean {fmt(mz)} sd {sdz:.2f}, by four weeks mean {fmt(mz4)} sd {sdz4:.2f}; the low end over 0 on {lows}: {'kept' if keep else 'LEFT OUT before the data'}")
    if not keep:
        ok_all = False
passed = sum(1 for r in null if r["placebo"]["passed"])
gate(passed >= 47, f"the placebo gate passed on {passed} of 50 (at least 47); the placebos called, the runs together: {sum(r['placebo']['called'] for r in null)} of {sum(r['placebo']['n'] for r in null)}, the Bonferroni road {sum(r['placebo']['bonf'] for r in null)}")
print("  told:")
for L in Ls:
    for name, label in ((f"S{L}", "stale"), (f"M{L}", "M"), (f"T1_{L}", "top 1")):
        m, n = merged(null, f"{name} e")
        print(f"    {label} L{L}: e {fmt(m)} of {n}")
    m, n = merged(null, f"ic {L}")
    print(f"    the rank IC L{L}: {fmt(m, 4)} of {n}")
tp = []
for p in TRADED:
    c = [0, 0, 0, 0, 0]
    for r in null:
        x = r["coinTp1"].get(p)
        if x:
            c = [a + b for a, b in zip(c, x)]
    lvl = c[1] + c[2] + c[3]
    want = (30 - SPREAD_PIPS[p] / 2) / 50
    tp.append(f"{p} {100 * c[1] / lvl:.1f}% ({100 * want:.1f}%)" if lvl else f"{p} -")
print("    the coin's TP1 first (the walk's (30 − spread / 2) / 50): " + ", ".join(tp))

# the power: a pips a trade added to one candidate's e (both halves)
print("  the power (the null runs; a pips a trade added to one candidate's e):")
for c, L in enumerate(Ls):
    for add in (1, 2, 3):
        picked = 0
        called = 0
        for r in null:
            ts = list(r["verdict"]["t"])
            f = r["candidates"][c]["first"]
            se1 = larger_se(f) if f else None
            if se1:
                ts[c] = (f["m"] + add) / se1
            best = None
            for i, t in enumerate(ts):
                if t is not None and (best is None or t > ts[best]):
                    best = i
            if best != c:
                continue
            picked += 1
            s = r["candidates"][c]["second"]
            weeks = s["C"] if s else 0
            if s and s["low"] is not None and s["m"] + add > 0 and s["low"] + add > 0 and weeks >= 30:
                called += 1
        print(f"    X{L} +{add}: picked {picked} of 50, called {called}")

# ---- rank ----------------------------------------------------------------------------------
for L, lo, hi in ((6, 8, 17), (30, 18, 27)):
    runs = [r for r in load(folder, f"strength-rank{L}-[0-9]*.json") if not r["fault"]]
    seeds = sorted(r["seed"] for r in runs)
    print(f"\nrank, L* {L}: {len(runs)} runs, seeds {seeds}; δ {sorted({r['delta'] for r in runs})}")
    if seeds != list(range(lo, hi + 1)) or len({r["delta"] for r in runs}) != 1:
        sys.exit(f"not the ten rank runs the gate is fixed on (L* {L}, seeds {lo} .. {hi}, one δ)")
    settled(runs, f"rank L* {L}")
    gate(all(r["allDiffer"] == 0 for r in runs), "every check 0 differ on every run")
    called = sum(1 for r in runs if r["verdict"]["called"])
    gate(called >= 9, f"the call on {called} of 10 (at least 9)")
    c = Ls.index(L)
    picked = sum(1 for r in runs if r["verdict"]["pick"] == c)
    print(f"  told: the pick X{L} on {picked} of 10; the placebo gate passed on {sum(1 for r in runs if r['placebo']['passed'])} of 10")
    bad = []
    parts = []
    for p in TRADED:
        m, n = merged(runs, f"X{L} e @{p}")
        parts.append(f"{p} {fmt(m)}")
        if m is None or m <= 0:
            bad.append(p)
    gate(not bad, f"every pair's e above 0, the seeds together ({', '.join(parts)})")
    for name, label in ((f"M{L}", "M"), (f"S{L}", "stale")):
        m, n = merged(runs, f"{name} e")
        print(f"  told: {label} e {fmt(m)} of {n}; X{L} {fmt(merged(runs, f'X{L} e')[0])}")

# ---- trend (told) ----------------------------------------------------------------------------
trend = [r for r in load(folder, "strength-trend-[0-9]*.json") if not r["fault"]]
if sorted(r["seed"] for r in trend) != list(range(7, 17)):
    sys.exit(f"not the ten trend runs (seeds 7 .. 16): {sorted(r['seed'] for r in trend)}")
settled(trend, "trend")
if trend:
    print(f"\ntrend (told, but its checks gated): {len(trend)} runs, seeds {sorted(r['seed'] for r in trend)}")
    gate(all(r["allDiffer"] == 0 for r in trend), "every check 0 differ on every run")
    print(f"  the call on {sum(1 for r in trend if r['verdict']['called'])}, the Bonferroni road on {sum(1 for r in trend if any(r['verdict']['bonf']))}; the placebo gate passed on {sum(1 for r in trend if r['placebo']['passed'])}")
    for L in Ls:
        x = merged(trend, f"X{L} e", (1,))
        s = merged(trend, f"S{L} e", (1,))
        j = merged(trend, f"X{L} e -JPY", (1,))
        print(f"  X{L}, the second half: e {fmt(x[0])} of {x[1]}; without the yen {fmt(j[0])} of {j[1]}; the stale meter {fmt(s[0])} of {s[1]}")

# ---- the faults (told; each must show) -------------------------------------------------------
print("\nthe planted faults (once each on seed 7):")
for fault, pattern in (("LOOKAHEAD", "strength-null-LOOKAHEAD-*.json"), ("MISALIGN", "strength-null-MISALIGN-*.json"), ("ORIENT", "strength-rank*-ORIENT-*.json")):
    runs = load(folder, pattern)
    if len(runs) != 1 or runs[0]["seed"] != 7:
        gate(False, f"{fault}: {len(runs)} runs ({', '.join(str(r['seed']) for r in runs)}), not one on seed 7")
        continue
    r = runs[0]
    la = r["checks"]["lookahead"] if "checks" in r else None
    if fault == "LOOKAHEAD":
        share = la["mismatched"] / la["compared"] if la and la["compared"] else 0
        gate(share >= 0.99, f"LOOKAHEAD: (la) {la['mismatched'] if la else '-'} of {la['compared'] if la else '-'} differ ({100 * share:.1f}%, at least 99%); the call {'made' if r.get('verdict', {}).get('called') else 'not made'}, X6 e {fmt(r['candidates'][0]['all']['m'])}, X30 {fmt(r['candidates'][1]['all']['m'])}")
    elif fault == "MISALIGN":
        stopped = r.get("stopped") or (r.get("align") or {}).get("stopped")
        gate(bool(stopped) or (la is not None and la["mismatched"] > 0), f"MISALIGN: (tri) {'stopped the run' if stopped else 'passed'}, (la) {la['mismatched'] if la else '-'} of {la['compared'] if la else '-'} differ")
    else:
        L = r["lstar"]
        m, n = merged([r], f"X{L} e @EUR/USD")
        gate(m is not None and m < 0, f"ORIENT (L* {L}): EUR/USD's e {fmt(m)} of {n}, below 0")

print(f"\ngates: {'all passed' if ok_all else 'NOT PASSED: look into the program before the data'}")
