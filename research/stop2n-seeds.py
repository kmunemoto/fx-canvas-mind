#!/usr/bin/env python3
"""#187: the random walks' runs of research/stop2n.ts, summed up against the
gates docs §8.97 fixes before the data is read.

Reads the JSON each run writes (stop2n-<synth>-<seed>.json) from a folder:

  * every check 0 differ on every run;
  * "path" (no rule gains), for 2N and for 2A: the call "clearly better" and
    "clearly worse" each on 3 runs at most; "less now" on the 100 halves
    (the emails' signals, either, CALL) against a standard normal: z by week
    and by four weeks with an sd up to 1.25, and a 95% low end over 0 on
    fewer than 7 (else the candidate is told, not judged); the coin's (all
    pairs) "less now" within ±0.3 pips; each stop's TP1 first of all the
    coin's trades within 120 bars within 2 points of the mean of
    (S − h)/(S + 20);
  * "drift" (a wider stop gains): "clearly better" on 9 of 10 or more, both;
  * "against" (a wider stop loses): "clearly worse" on 9 of 10 or more and
    "clearly better" on none, both;
  * the power on "path": pips a trade added to a candidate's "less now", the
    call replayed from the runs' own numbers (+1, +2, +4), and the smallest
    difference the runs could find.

Usage: python3 research/stop2n-seeds.py <folder>
"""

import glob
import json
import math
import os
import sys

# ---- Student's t (as stop2n.ts) --------------------------------------------------------


def betacf(a, b, x):
    tiny = 1e-300
    qab, qap, qam = a + b, a + 1, a - 1
    c, d = 1.0, 1 - qab * x / qap
    if abs(d) < tiny:
        d = tiny
    d = 1 / d
    h = d
    for m in range(1, 501):
        m2 = 2 * m
        aa = m * (b - m) * x / ((qam + m2) * (a + m2))
        d = 1 + aa * d
        d = tiny if abs(d) < tiny else d
        c = 1 + aa / c
        c = tiny if abs(c) < tiny else c
        d = 1 / d
        h *= d * c
        aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2))
        d = 1 + aa * d
        d = tiny if abs(d) < tiny else d
        c = 1 + aa / c
        c = tiny if abs(c) < tiny else c
        d = 1 / d
        de = d * c
        h *= de
        if abs(de - 1) < 1e-15:
            break
    return h


def ibeta(a, b, x):
    if x <= 0:
        return 0.0
    if x >= 1:
        return 1.0
    bt = math.exp(math.lgamma(a + b) - math.lgamma(a) - math.lgamma(b) + a * math.log(x) + b * math.log(1 - x))
    return bt * betacf(a, b, x) / a if x < (a + 1) / (a + b + 2) else 1 - bt * betacf(b, a, 1 - x) / b


def tcdf(t, df):
    p = 0.5 * ibeta(df / 2, 0.5, df / (df + t * t))
    return 1 - p if t >= 0 else p


_TQ = {}


def tq(p, df):
    if not (df >= 1 and 0.5 < p < 1):
        return float("nan")
    key = (p, df)
    if key in _TQ:
        return _TQ[key]
    lo, hi = 0.0, 1.0
    while tcdf(hi, df) < p:
        hi *= 2
    for _ in range(200):
        if hi - lo <= 1e-12:
            break
        mid = (lo + hi) / 2
        if tcdf(mid, df) < p:
            lo = mid
        else:
            hi = mid
    _TQ[key] = (lo + hi) / 2
    return _TQ[key]


for p, df, want in [(0.975, 1, 12.706), (0.975, 2, 4.303), (0.975, 10, 2.228), (0.975, 17, 2.110), (0.995, 10, 3.169), (0.95, 5, 2.015), (0.9975, 17, 3.222), (0.975, 1e6, 1.960)]:
    assert abs(tq(p, df) - want) < 1e-3, (p, df, tq(p, df), want)

Z80 = 0.8416212335729143


def ends(s, p):
    """The lower of the low ends and the higher of the high ends by week and by
    four weeks, each with its own t(C − 1); None without both."""
    if not s or s["se"] is None or s["se4"] is None or s["C"] < 2 or s["C4"] < 2:
        return None, None
    w, b = tq(p, s["C"] - 1) * s["se"], tq(p, s["C4"] - 1) * s["se4"]
    return min(s["m"] - w, s["m"] - b), max(s["m"] + w, s["m"] + b)


def call(r, k, delta=0.0):
    """The call replayed from the run's numbers, `delta` pips a trade added."""
    g = r["groups"]["either|CALL"]
    s0, s1, sf = (g[p].get(k + " − now") for p in (0, 1, 2))
    if not (s0 and s1 and sf):
        return "none"
    lo, hi = ends(sf, r["pCall"])
    m0, m1 = s0["m"] + delta, s1["m"] + delta
    if m0 > 0 and m1 > 0 and lo is not None and lo + delta > 0:
        return "better"
    if m0 < 0 and m1 < 0 and hi is not None and hi + delta < 0:
        return "worse"
    return "undecided"


def mean_sd(xs):
    if len(xs) < 2:
        return float("nan"), float("nan")
    m = sum(xs) / len(xs)
    return m, math.sqrt(sum((x - m) ** 2 for x in xs) / (len(xs) - 1))


def main():
    folder = sys.argv[1] if len(sys.argv) > 1 else "research/out"
    runs = {}
    for path in sorted(glob.glob(os.path.join(folder, "stop2n-*-*.json"))):
        if "lookahead" in path:
            continue
        with open(path) as f:
            r = json.load(f)
        if not r.get("synthetic"):
            continue
        runs.setdefault(r["synth"], []).append(r)
    for synth in runs:
        runs[synth].sort(key=lambda r: r["seed"])
    print(f"runs: {', '.join(f'{k} {len(v)} (seeds {v[0]['seed']} .. {v[-1]['seed']})' for k, v in runs.items())}")
    bad = [(r["synth"], r["seed"], r["allDiffer"]) for v in runs.values() for r in v if r["allDiffer"] != 0]
    first = next(iter(runs.values()))[0]
    compared = {k: sum(r["checks"][k]["compared"] for v in runs.values() for r in v) for k in first["checks"]}
    print(f"checks: {len(bad)} runs with a difference{': ' + str(bad) if bad else ''}; compared over the runs: {', '.join(f'{k} {n}' for k, n in compared.items())}")
    gates = []

    for synth, rs in runs.items():
        cands = rs[0]["candidates"]
        print(f"\n== {synth}: {len(rs)} runs")
        for k in cands:
            got = [call(r, k) for r in rs]
            own = [("better" if r["calls"][k]["better"] else "worse" if r["calls"][k]["worse"] else "undecided") for r in rs]
            same = sum(a == b for a, b in zip(got, own))
            nb, nw = got.count("better"), got.count("worse")
            print(f"  {k}: clearly better on {nb}, clearly worse on {nw}, of {len(rs)} (replayed from the runs' numbers as the runs' own on {same} of {len(rs)})")
            if synth == "path":
                gates.append((f"path {k}: clearly better on 3 at most", nb <= 3))
                gates.append((f"path {k}: clearly worse on 3 at most", nw <= 3))
            if synth == "drift":
                gates.append((f"drift {k}: clearly better on 9 of 10 or more", nb >= 9 and len(rs) >= 10))
            if synth == "against":
                gates.append((f"against {k}: clearly worse on 9 of 10 or more", nw >= 9 and len(rs) >= 10))
                gates.append((f"against {k}: clearly better on none", nb == 0))
            gates.append((f"{synth} {k}: the replayed call the runs' own on every run", same == len(rs)))

        if synth != "path":
            continue
        # each candidate's "less now" on the halves
        print(f"  each candidate, \"less now\" on the halves ({2 * len(rs)}): a 95% low end over 0 (nominal 2.5%), z by week and by four weeks (mean, sd)")
        for k in cands:
            zs, z4s, over = [], [], 0
            for r in rs:
                for h in (0, 1):
                    s = r["groups"]["either|CALL"][h].get(k + " − now")
                    if not s or not s["se"] or not s["se4"]:
                        continue
                    zs.append(s["m"] / s["se"])
                    z4s.append(s["m"] / s["se4"])
                    lo, _ = ends(s, 0.975)
                    over += lo is not None and lo > 0
            mz, sz = mean_sd(zs)
            mz4, sz4 = mean_sd(z4s)
            print(f"    {k:14s} low end over 0 on {over} of {len(zs)}; z {mz:+.2f} sd {sz:.2f}, 4 wk {mz4:+.2f} sd {sz4:.2f}")
            gates.append((f"path {k}: z's sd by week {sz:.2f} and by four weeks {sz4:.2f} up to 1.25", sz <= 1.25 and sz4 <= 1.25))
            gates.append((f"path {k}: a low end over 0 on {over} of {len(zs)}, fewer than 7", over < 7))
        # the coin: "less now" near 0
        print("  the coin (all pairs), the runs and halves together:")
        for k in cands:
            n = m = 0.0
            for r in rs:
                for h in (0, 1):
                    s = r["groups"]["coin|all"][h].get(k + " − now")
                    n += s["n"]
                    m += s["m"] * s["n"]
            m /= max(1, n)
            print(f"    {k} less now {m:+.3f} pips a trade (of {int(n)})")
            gates.append((f"path {k}: the coin's less now {m:+.3f} within ±0.3", abs(m) <= 0.3))
        # each stop where it should be
        print("  each stop, the coin within 120 bars: TP1 first of all against the mean of (S − h)/(S + 20), the runs together (the furthest run)")
        keys = list(rs[0]["theory"].keys())
        for k in keys:
            tp = n = th = be = 0.0
            worst = 0.0
            for r in rs:
                s = r["groups"]["coin|all"][2][k]
                tp += s["exits"]["tp"]
                n += s["n"]
                th += s["th"]
                be += s["beN"]
                worst = max(worst, abs(100 * (s["exits"]["tp"] / s["n"] - s["th"] / s["beN"])))
            first, want = 100 * tp / n, 100 * th / be
            print(f"    {k:16s} {first:.1f}% against {want:.1f}% ({first - want:+.2f} points; the furthest run {worst:.2f})")
            gates.append((f"path {k}: TP1 first {first:.1f}% within 2 points of {want:.1f}%", abs(first - want) <= 2))
        # the power
        print("  the power: pips a trade added to a candidate's \"less now\", the call replayed (of the runs)")
        for k in cands:
            row = []
            for delta in (1, 2, 4):
                row.append(f"+{delta}: {sum(call(r, k, delta) == 'better' for r in rs)}")
            mdes = [r["calls"][k]["mde"] for r in rs if r["calls"][k]["mde"] is not None]
            sds = []
            for r in rs:
                s = r["groups"]["either|CALL"][2].get(k + " − now")
                if s and s["se"] is not None:
                    sds.append(s["se"] * math.sqrt(s["n"]))
            print(f"    {k}: clearly better {', '.join(row)} of {len(rs)}; the smallest difference it could find {sum(mdes) / max(1, len(mdes)):.2f} pips (mean of the runs); the per-trade sd of less now (by week) {sum(sds) / max(1, len(sds)):.1f}")

    print("\n== THE GATES")
    for what, ok in gates:
        print(f"  {'ok  ' if ok else 'FAIL'} {what}")
    print(f"  checks 0 differ on every run: {'ok' if not bad else 'FAIL'}")
    allok = all(ok for _, ok in gates) and not bad
    print("ALL GATES PASS" if allok else "A GATE FAILS")
    sys.exit(0 if allok else 1)


if __name__ == "__main__":
    main()
