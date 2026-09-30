#!/usr/bin/env python3
"""The walks' summary for research/prewarn.ts (#171-5): the checks, and the
gates its header fixes before the data is read.

Usage: python3 research/prewarn-seeds.py <folder with prewarn-path-<seed>.json>
"""
import glob
import json
import os
import sys

folder = sys.argv[1] if len(sys.argv) > 1 else "research/out"
runs = []
for p in sorted(glob.glob(os.path.join(folder, "prewarn-*-*.json"))):
    with open(p) as f:
        runs.append(json.load(f))
if not runs:
    sys.exit(f"no runs in {folder}")
synths = sorted({r["synth"] for r in runs})
print(f"runs: {len(runs)} ({', '.join(synths)}), seeds {sorted(r['seed'] for r in runs)}")

# the checks
names = sorted(runs[0]["checks"])
bad = [r["seed"] for r in runs if r["allDiffer"]]
print("checks, the runs together: " + ", ".join(f"{k} {sum(r['checks'][k]['mismatched'] for r in runs)} of {sum(r['checks'][k]['compared'] for r in runs)}" for k in names))
print(f"runs with a difference: {bad or 'none'}; GMO failures {sum(r['failedReads'] for r in runs)}")

leads = runs[0]["leads"]


def pooled(group, series):
    n = 0
    s = 0.0
    for r in runs:
        for half in (0, 1):
            a = r["store"].get(f"{group}|{half}|{series}")
            if a:
                n += a["n"]
                s += a["sum"]
    return (s / n if n else None), n


def fmt(x, pct=False):
    if x is None:
        return "  -  "
    return f"{100 * x:5.1f}%" if pct else f"{x:+.2f}"


ok_all = True
for group in ("all", "AB"):
    gated = group == "all"
    et, etn = pooled(group, "ET either")
    print(f"\n== either|{group}{' (the gates)' if gated else ' (told)'}: the email's trades {fmt(et)} of {etn}")
    for design in ("once", "watch"):
        for X in leads:
            if design == "watch" and X == 5:
                continue
            tag = f"either {design} {X}"
            P, Pn = pooled(group, f"W {tag}")
            R, Rn = pooled(group, f"R {tag}")
            wt, wtn = pooled(group, f"WT {tag}")
            d = None if wt is None or et is None else wt - et
            flag = ""
            if gated and (d is None or abs(d) > 0.3):
                flag = "  <- OUT OF ±0.3"
                ok_all = False
            print(f"  {design:5} {X:3} min: hit {fmt(P, True)} of {Pn}, warned {fmt(R, True)} of {Rn}; every warning's trade {fmt(wt)} of {wtn}, less the email's {fmt(d)}{flag}")
    if gated:
        ps = [pooled(group, f"W either once {X}")[0] for X in (5, 30, 120)]
        rs = [pooled(group, f"R either once {X}")[0] for X in (5, 30, 120)]
        rise = all(v is not None for v in ps + rs) and ps[0] > ps[1] > ps[2] and rs[0] > rs[1] > rs[2]
        if not rise:
            ok_all = False
        print(f"  once, 5 / 30 / 120 min: hit {' / '.join(fmt(v, True) for v in ps)}, warned {' / '.join(fmt(v, True) for v in rs)}: {'higher nearer the close' if rise else 'NOT higher nearer the close'}")

print(f"\ngates: {'all passed' if ok_all and not bad else 'NOT PASSED: look into the program before the data'}")
