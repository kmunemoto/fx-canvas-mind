#!/usr/bin/env python3
"""#172: the random walks' runs of research/widetp.ts, summed up.

Reads the JSON each run writes (widetp-<synth>-<seed>.json) from a folder and
prints what widetp.ts's head fixes before the data is read:

  * every check 0 differ on every run;
  * "path" (no rule gains): how often the call and the Bonferroni road fire;
    each candidate's "less now" on the halves against a standard normal (the
    low end over 0, z's mean and sd); the coin's TP1 first at L120 against
    29.8 / (30 + T), and its "less now" near 0;
  * "drift" (a wider target gains): how often the call fires;
  * "wicks": the picks and calls, told;
  * the power: a number of pips a trade added to one candidate, the pick and
    the call replayed from the runs' own numbers (and, first, the runs' own
    pick and call replayed as they are).

Usage: python3 research/widetp-seeds.py <folder>
"""

import glob
import json
import math
import os
import sys

# ---- Student's t (as widetp.ts) --------------------------------------------------------


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

# ---- the runs ----------------------------------------------------------------------------


def low_end(s, p=0.975):
    """The lower of the low ends by week and by four weeks; None without both."""
    if not s or s["se"] is None or s["se4"] is None or s["C"] < 2 or s["C4"] < 2:
        return None
    return min(s["m"] - tq(p, s["C"] - 1) * s["se"], s["m"] - tq(p, s["C4"] - 1) * s["se4"])


def main():
    folder = sys.argv[1] if len(sys.argv) > 1 else "research/out"
    # candidates to leave out, comma-separated: the call and the Bonferroni
    # road replayed without them
    out = [k.strip() for k in (sys.argv[2] if len(sys.argv) > 2 else "").split(",") if k.strip()]
    runs = {}
    for path in sorted(glob.glob(os.path.join(folder, "widetp-*-*.json"))):
        with open(path) as f:
            r = json.load(f)
        runs.setdefault(r["synth"], []).append(r)
    for synth in runs:
        runs[synth].sort(key=lambda r: r["seed"])
    told = [f"{k} {len(v)} (seeds {v[0]['seed']} .. {v[-1]['seed']})" for k, v in runs.items()]
    print(f"runs: {', '.join(told)}")

    # every check
    bad = [(r["synth"], r["seed"], r["allDiffer"], r["hDiffer"]) for v in runs.values() for r in v if r["allDiffer"] != 0]
    compared = {k: sum(r["checks"][k]["compared"] for v in runs.values() for r in v) for k in next(iter(runs.values()))[0]["checks"]}
    print(f"checks: {len(bad)} runs with a difference{': ' + str(bad) if bad else ''}; compared over the runs: {', '.join(f'{k} {n}' for k, n in compared.items())}")

    for synth, rs in runs.items():
        picks = rs[0]["picks"]
        print(f"\n== {synth}: {len(rs)} runs")
        called = [r["seed"] for r in rs if r["clearly"]]
        print(f"  the call fired on {len(called)} of {len(rs)}{': seeds ' + ', '.join(map(str, called)) if called else ''}")
        bonf = [(r["seed"], [k for k, b in r["bonf"].items() if b["above"]]) for r in rs]
        bonf = [(s, ks) for s, ks in bonf if ks]
        print(f"  the Bonferroni road on {len(bonf)} of {len(rs)}{': ' + '; '.join(f'seed {s} {ks}' for s, ks in bonf) if bonf else ''}")
        tally = {}
        for r in rs:
            tally[r["pick"]] = tally.get(r["pick"], 0) + 1
        print(f"  the picks: {', '.join(f'{k} {v}' for k, v in sorted(tally.items(), key=lambda kv: -kv[1]))}")

        # replay the runs' own pick and call from their numbers
        same = 0
        for r in rs:
            p, c = replay(r, picks, None, 0)
            same += p == r["pick"] and c == r["clearly"]
            b = {k for k in picks if bonf_above(r, k, len(picks))}
            same_b = b == {k for k, x in r["bonf"].items() if x["above"]}
            same -= not same_b
        print(f"  replayed from the runs' numbers: the pick, the call and the Bonferroni road as the runs' own on {same} of {len(rs)}")
        if out:
            kept = [k for k in picks if k not in out]
            got = [replay(r, kept, None, 0) for r in rs]
            called = [r["seed"] for r, (_, c) in zip(rs, got) if c]
            road = [r["seed"] for r in rs if any(bonf_above(r, k, len(kept)) for k in kept)]
            print(f"  without {', '.join(out)} ({len(kept)} candidates): the call on {len(called)} of {len(rs)} {called}; the Bonferroni road on {len(road)} {road}")

        # each candidate's "less now" on the halves (either, A+B)
        print(f"  each candidate, \"less now\" on the halves ({2 * len(rs)}): low end over 0 (nominal 2.5%), z by week and by four weeks (mean, sd)")
        for k in picks:
            zs, z4s, over = [], [], 0
            for r in rs:
                for h in (0, 1):
                    s = r["groups"]["either|AB"][h].get(k + " − now")
                    if not s or not s["se"] or not s["se4"]:
                        continue
                    zs.append(s["m"] / s["se"])
                    z4s.append(s["m"] / s["se4"])
                    lo = low_end(s)
                    over += lo is not None and lo > 0
            mz, sz = mean_sd(zs)
            mz4, sz4 = mean_sd(z4s)
            flag = " — LEAVE OUT (7 or more, or an sd over 1.25)" if over >= 7 or sz > 1.25 or sz4 > 1.25 else ""
            print(f"    {k:14s} low end over 0 on {over} of {len(zs)}; z {mz:+.2f} sd {sz:.2f}, 4 wk {mz4:+.2f} sd {sz4:.2f}{flag}")

        # the coin: TP1 first at L120, and "less now", the runs and halves together
        coin = [r["groups"].get("coin|all") for r in rs]
        print("  the coin (all pairs), the runs and halves together:")
        for t in (5, 10, 15, 20, 30, 45, 60, 90):
            tp = sl = amb = time = 0
            for g in coin:
                for h in (0, 1):
                    s = g[h].get(f"T{t} S30 L120")
                    tp += s["exits"]["tp"]
                    sl += s["exits"]["sl"]
                    amb += s["exits"]["amb"]
                    time += s["exits"]["time"]
            first = 100 * tp / max(1, tp + sl + amb)
            want = 100 * 29.8 / (30 + t)
            gate = "" if synth != "path" or t > 30 else (" ok" if abs(first - want) <= 2 else " — OFF BY MORE THAN 2 POINTS")
            print(f"    T{t} L120: TP1 first {first:.1f}% against 29.8/(30+T) {want:.1f}% (time-outs {100 * time / max(1, tp + sl + amb + time):.1f}%){gate}")
        worst = 0.0
        for k in coin[0][0]:
            if not k.endswith(" − now"):
                continue
            n = sum(g[h][k]["n"] for g in coin for h in (0, 1))
            m = sum(g[h][k]["m"] * g[h][k]["n"] for g in coin for h in (0, 1)) / max(1, n)
            # the gate: the rules with the stop 30 (the others, #164's, told)
            if " S30 " in k:
                worst = max(worst, abs(m))
            print(f"    {k:22s} {m:+.3f} pips a trade{'' if ' S30 ' in k else ' (told)'}")
        if synth == "path":
            print(f"    the largest \"less now\" with the stop 30 {worst:.3f}: {'within' if worst <= 0.3 else 'NOT within'} ±0.3")

        if synth == "path":
            print("  the power: pips a trade added to one candidate, the pick and the call replayed")
            for planted in ("T20 S30 L30", "T45 S30 L30", "A1 S30 L30"):
                for delta in (0.5, 1, 2):
                    got = [replay(r, picks, planted, delta) for r in rs]
                    picked = sum(p == planted for p, _ in got)
                    both = sum(p == planted and c for p, c in got)
                    anyc = sum(c for _, c in got)
                    print(f"    {planted} +{delta}: picked {picked} of {len(rs)}, picked and called {both}, called at all {anyc}")


def bonf_above(r, k, K):
    """A candidate's second-half low end over 0 with a Bonferroni interval (K)."""
    lo = low_end(r["groups"]["either|AB"][1].get(k + " − now"), 1 - 0.025 / K)
    return lo is not None and lo > 0


def mean_sd(xs):
    if len(xs) < 2:
        return float("nan"), float("nan")
    m = sum(xs) / len(xs)
    return m, math.sqrt(sum((x - m) ** 2 for x in xs) / (len(xs) - 1))


def replay(r, picks, planted, delta):
    """The pick (the highest t on the first half for the pick) and the call
    (the second half), with `delta` pips a trade added to `planted`."""
    best, pick = -math.inf, None
    for k in picks:
        pt = r["pickT"][k]
        if pt["se"] is None or pt["se4"] is None:
            continue
        se = max(pt["se"], pt["se4"])
        if se <= 0:
            continue
        t = (pt["m"] + (delta if k == planted else 0)) / se
        if t > best:
            best, pick = t, k
    if pick is None:
        return None, False
    s = r["groups"]["either|AB"][1].get(pick + " − now")
    lo = low_end(s)
    add = delta if pick == planted else 0
    m = s["m"] + add
    return pick, m > 0 and lo is not None and lo + add > 0


if __name__ == "__main__":
    main()
