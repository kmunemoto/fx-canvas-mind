#!/usr/bin/env python3
"""#188: the random walks' runs of research/money.ts, summed up against the
gates docs §8.99 (作り物の値動き) and interface.md §9 fix before the data is
read; and the planted errors (§8.99 仕込む誤り, interface.md §8) against a
clean run.

  python3 research/money-seeds.py <folder>
      Reads money-<synth>-<seed>.json (what each walk run writes) from a
      folder, and, where there is one, the independent check's log of the same
      run, check-<synth>-<seed>.log (python3 research/money-check.py --cache
      <its DUMPDIR> --out <its OUTDIR> > check-<synth>-<seed>.log):
        * every run's own checks 0 differ;
        * "path" (no edge, seeds 1–20): the check against the study 0 differ
          on each (its log's last word: MONEY.TS AGREES WITH THE CHECK); TP1
          first of all within 2 points of (13 − h̄)/17 (h̄ the half spread paid
          a trade, its mean); pips a trade within −2h̄ ± 3 standard errors (by
          week); the kept-and-skipped difference outside its within-week band
          on at most 10% of (cell, seed);
        * "drift" (+0.10 pip a 5-minute bar, seeds 1–10): pips a trade over 0
          on every run; on 9 runs or more every k% cell ends above its start
          and the look-ahead lines fire;
        * "against" (−0.10, seeds 1–10): pips a trade under 0 on every run,
          every k% cell ends below its start on every run;
        * each run's time; over 120 minutes, §8.99's fewer counts (BOOT 500,
          THIN 100) are to be fixed before the data.
      A gate with fewer runs than it asks for fails (and says so).

  python3 research/money-seeds.py --plants <clean_dir> <planted_dir>...
      Each planted run's outputs against the clean run's (the same walk, the
      same BOOT and THIN): the ledger rows (money-ledger-*.csv) and the trade
      rows (money-trades.csv) that differ, and the numbers of money.json that
      differ (the trades', the cells', the told rows', the windows', the
      orders', the kept and skipped, the thinning's, the bands; not the
      checks, the times or the meta). 0 changed is a plant that failed. The
      planted run's own checks that differ are told beside (which caught it).
"""

import csv
import glob
import json
import os
import re
import sys

K_CELLS = [f"{s}_{c}" for s in ("FF025", "FF05", "FF1", "FF2") for c in ("C0", "T1", "T3", "P1", "J2")]
WANT = {"path": list(range(1, 21)), "drift": list(range(1, 11)), "against": list(range(1, 11))}
TWO_HOURS_MS = 120 * 60_000


def load_runs(folder):
    runs = {}
    for path in sorted(glob.glob(os.path.join(folder, "money-*-*.json"))):
        m = re.search(r"money-(path|wicks|drift|against)-(\d+)\.json$", path)
        if not m:
            continue
        with open(path) as f:
            r = json.load(f)
        if not r.get("meta", {}).get("synthetic"):
            continue
        r["_synth"], r["_seed"] = m.group(1), int(m.group(2))
        log = os.path.join(folder, f"check-{m.group(1)}-{m.group(2)}.log")
        r["_check"] = None
        if os.path.exists(log):
            with open(log) as f:
                text = f.read()
            r["_check"] = "MONEY.TS AGREES WITH THE CHECK" in text and "DOES NOT AGREE" not in text
        runs.setdefault(r["_synth"], []).append(r)
    for rs in runs.values():
        rs.sort(key=lambda r: r["_seed"])
    return runs


def differing_checks(r):
    return {k: c["mismatched"] for k, c in (r.get("checks") or {}).items() if c.get("mismatched")}


def gates_main(folder):
    runs = load_runs(folder)
    if not runs:
        print(f"no walk runs (money-<synth>-<seed>.json) in {folder}")
        sys.exit(1)
    told = [f"{k} {len(v)} (seeds {[r['_seed'] for r in v]})" for k, v in runs.items()]
    print(f"runs: {', '.join(told)}")
    gates = []
    for synth, rs in runs.items():
        bad = [(r["_seed"], differing_checks(r)) for r in rs if differing_checks(r)]
        print(f"\n== {synth}: {len(rs)} runs; own checks differing on {len(bad)}{': ' + str(bad) if bad else ''}")
        gates.append((f"{synth}: every run's own checks 0 differ", not bad))
        times = [r["meta"].get("runtime_ms") or 0 for r in rs]
        counts = {json.dumps(r["meta"].get("counts")) for r in rs}
        print(f"  runtime: most {max(times) / 60_000:.1f} min, mean {sum(times) / len(times) / 60_000:.1f} min (counts {', '.join(sorted(counts))})")
        gates.append((f"{synth}: every run within 120 minutes (most {max(times) / 60_000:.1f})", max(times) <= TWO_HOURS_MS))
        for r in rs:
            t = r["trades"]
            ff = [r["cells"][k]["final_equity"] for k in K_CELLS if k in r["cells"]]
            start = 1_000_000
            print(f"  seed {r['_seed']:3d}: {t['n']} trades, TP1 first {100 * (t['win_all'] or 0):.1f}%, {t['mean_pips']:+.3f} pips a trade (se {t.get('se_week') or float('nan'):.3f}), h̄ {t.get('h_mean') or float('nan'):.3f}; k% cells above the start {sum(x > start for x in ff)} of {len(ff)}; look-ahead lines {len(r.get('suspect') or [])}; the check {'agrees' if r['_check'] else 'DIFFERS' if r['_check'] is False else 'not run'}")
        want = WANT.get(synth)
        seeds = [r["_seed"] for r in rs]
        if want:
            gates.append((f"{synth}: the runs of seeds {want[0]} .. {want[-1]} ({len(seeds)} found)", all(s in seeds for s in want)))
        if synth == "path":
            agree = [r["_check"] for r in rs]
            gates.append((f"path: the check against the study 0 differ on every run ({sum(a is True for a in agree)} agree, {sum(a is False for a in agree)} differ, {sum(a is None for a in agree)} not run)", all(a is True for a in agree)))
            for r in rs:
                t = r["trades"]
                h = t.get("h_mean")
                th = (13 - h) / 17 if h is not None else None
                ok = th is not None and t["win_all"] is not None and abs(t["win_all"] - th) <= 0.02
                gates.append((f"path seed {r['_seed']}: TP1 first {100 * t['win_all']:.2f}% within 2 points of (13 − h̄)/17 = {100 * th:.2f}%" if th is not None else f"path seed {r['_seed']}: no h̄", ok))
                se = t.get("se_week")
                ok = se is not None and h is not None and abs(t["mean_pips"] + 2 * h) <= 3 * se
                gates.append((f"path seed {r['_seed']}: {t['mean_pips']:+.3f} pips a trade within −2h̄ {-2 * h:+.3f} ± 3 se ({3 * se:.3f})" if se is not None and h is not None else f"path seed {r['_seed']}: no se", ok))
            outside = total = 0
            for r in rs:
                for k, x in (r.get("kept") or {}).items():
                    if not x or x.get("diff") is None or not x.get("perm_band"):
                        continue
                    total += 1
                    lo, hi = x["perm_band"]
                    outside += not (lo <= x["diff"] <= hi)
            print(f"  kept less skipped outside its within-week band: {outside} of {total} (cell, seed)")
            gates.append((f"path: kept less skipped outside its band on {outside} of {total}, at most 10%", total > 0 and outside <= 0.1 * total))
        if synth == "drift":
            gates.append(("drift: pips a trade over 0 on every run", all(r["trades"]["mean_pips"] > 0 for r in rs)))
            good = sum(all(r["cells"][k]["final_equity"] > 1_000_000 for k in K_CELLS) and len(r.get("suspect") or []) > 0 for r in rs)
            gates.append((f"drift: every k% cell above its start and the look-ahead lines firing on {good} of {len(rs)}, 9 of 10 or more", good >= 9))
        if synth == "against":
            gates.append(("against: pips a trade under 0 on every run", all(r["trades"]["mean_pips"] < 0 for r in rs)))
            gates.append(("against: every k% cell below its start on every run", all(all(r["cells"][k]["final_equity"] < 1_000_000 for k in K_CELLS) for r in rs)))
    for synth in WANT:
        if synth not in runs:
            gates.append((f"{synth}: no runs found (seeds {WANT[synth][0]} .. {WANT[synth][-1]} wanted)", False))
    print("\n== THE GATES")
    for what, ok in gates:
        print(f"  {'ok  ' if ok else 'FAIL'} {what}")
    allok = all(ok for _, ok in gates)
    print("ALL GATES PASS" if allok else "A GATE FAILS")
    sys.exit(0 if allok else 1)


# ---- the planted errors against a clean run ---------------------------------------------------

# money.json's parts whose numbers a plant may move (not the checks, the times, the meta)
PARTS = ["trades", "cells", "rows", "account", "suspect", "windows", "orders", "order_ranges", "kept", "thin", "thin_ranks", "boot"]


def leaves(x, path=""):
    """every number, string and flag in x with its path"""
    if isinstance(x, dict):
        for k, v in x.items():
            yield from leaves(v, f"{path}.{k}" if path else k)
    elif isinstance(x, list):
        for i, v in enumerate(x):
            yield from leaves(v, f"{path}[{i}]")
    else:
        yield path, x


def rows_of(path):
    if not os.path.exists(path):
        return None
    with open(path) as f:
        return list(csv.reader(f))


def rows_changed(a, b):
    """rows of b not as in a (by position), and rows only one of them has"""
    if a is None and b is None:
        return 0
    if a is None or b is None:
        return len(a or b)
    n = sum(x != y for x, y in zip(a, b))
    return n + abs(len(a) - len(b))


def plants_main(clean, planted):
    with open(os.path.join(clean, "money.json")) as f:
        base = json.load(f)
    if base.get("plant"):
        print(f"{clean} is a planted run ({base['plant']}), not a clean one")
        sys.exit(1)
    base_leaves = {p: v for part in PARTS for p, v in leaves(base.get(part), part)}
    ledgers = sorted(os.path.basename(p) for p in glob.glob(os.path.join(clean, "money-ledger-*.csv")))
    print(f"the clean run: {clean} ({len(ledgers)} ledgers, {len(base_leaves)} numbers; counts {base.get('meta', {}).get('counts')})")
    failed = []
    print(f"\n{'plant':14s} {'ledger rows':>12s} {'trade rows':>11s} {'numbers':>8s}  caught by (the planted run's own checks that differ)")
    for d in planted:
        with open(os.path.join(d, "money.json")) as f:
            r = json.load(f)
        name = r.get("plant") or f"(none: {d})"
        if r.get("meta", {}).get("counts") != base.get("meta", {}).get("counts"):
            print(f"{name:14s} not comparable: counts {r.get('meta', {}).get('counts')} against the clean run's {base.get('meta', {}).get('counts')}")
            failed.append(name)
            continue
        names = sorted(set(ledgers) | {os.path.basename(p) for p in glob.glob(os.path.join(d, "money-ledger-*.csv"))})
        ledger = sum(rows_changed(rows_of(os.path.join(clean, n)), rows_of(os.path.join(d, n))) for n in names)
        trades = rows_changed(rows_of(os.path.join(clean, "money-trades.csv")), rows_of(os.path.join(d, "money-trades.csv")))
        mine = {p: v for part in PARTS for p, v in leaves(r.get(part), part)}
        numbers = sum(mine.get(p, "<none>") != v for p, v in base_leaves.items()) + sum(p not in base_leaves for p in mine)
        caught = differing_checks(r)
        print(f"{name:14s} {ledger:12d} {trades:11d} {numbers:8d}  {', '.join(f'{k} {v}' for k, v in caught.items()) or 'none of its own checks'}")
        if ledger + trades + numbers == 0:
            failed.append(name)
    print(f"\n{'EVERY PLANT CHANGED SOMETHING' if not failed else 'A PLANT CHANGED NOTHING (failed): ' + ', '.join(failed)}")
    sys.exit(0 if not failed else 1)


def main():
    args = sys.argv[1:]
    if args and args[0] == "--plants":
        if len(args) < 3:
            print("usage: money-seeds.py --plants <clean_dir> <planted_dir>...")
            sys.exit(2)
        plants_main(args[1], args[2:])
    else:
        gates_main(args[0] if args else "research/out")


if __name__ == "__main__":
    main()
