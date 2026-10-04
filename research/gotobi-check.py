# #186: an independent check of research/gotobi.ts's per-day table (docs §8.96),
# written apart from it: every trade's result is computed again from GMO's raw
# day files (the run's cache), and the groups' win rates and means again from
# those results. Run after MODE=real, on the same runner.
#
# Read-only: reads research/.cache/gotobi and research/out/gotobi-days.csv,
# prints to the job log.

import csv
import glob
import json
import os
from datetime import datetime, timedelta, timezone

CACHE = "research/.cache/gotobi"
DAYS = "research/out/gotobi-days.csv"


def load(side):
    out = {}
    # in date order, as gotobi.ts reads them (a bar in two files: the earlier file's)
    for path in sorted(glob.glob(f"{CACHE}/{side}/*.json")):
        text = open(path).read()
        if text == "null":
            continue
        for row in json.loads(text)["data"]:
            t = int(row["openTime"])
            if t not in out:
                out[t] = round(float(row["open"]) * 1000)
    return out


def ms(dt):
    return int(dt.timestamp() * 1000)


def main():
    bid = load("bid")
    ask = load("ask")
    print(f"raw bars: bid {len(bid)}, ask {len(ask)}")

    def usable(t):
        return t in bid and t in ask and ask[t] >= bid[t]

    rows = list(csv.DictReader(open(DAYS)))
    checked = 0
    wrong = []
    groups = {}
    for r in rows:
        if not r["pl_sen"]:
            continue
        d = datetime.strptime(r["date"], "%Y-%m-%d").replace(tzinfo=timezone.utc)
        # 23:00 JST the evening before = 14:00 UTC the day before; 9:55 JST = 00:55 UTC
        entry0 = ms(d - timedelta(hours=10))
        exit0 = ms(d + timedelta(minutes=55))
        entry = next((entry0 + k * 60_000 for k in range(5) if usable(entry0 + k * 60_000)), None)
        exit_ = next((exit0 + k * 60_000 for k in range(60) if usable(exit0 + k * 60_000)), None)
        if entry is None or exit_ is None:
            wrong.append(f"{r['date']}: no usable bar here but a result in the table")
            continue
        pl = (bid[exit_] - ask[entry]) / 10  # sen
        checked += 1
        table_entry = ms(datetime.strptime(r["entry_utc"], "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=timezone.utc))
        table_exit = ms(datetime.strptime(r["exit_utc"], "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=timezone.utc))
        if table_entry != entry or table_exit != exit_ or not table_entry < table_exit:
            wrong.append(f"{r['date']}: times {r['entry_utc']} {r['exit_utc']} vs {entry} {exit_}")
        if abs(pl - float(r["pl_sen"])) > 0.051:
            wrong.append(f"{r['date']}: result {r['pl_sen']} vs {pl:.1f}")
        if abs(ask[entry] / 1000 - float(r["buy"])) > 0.0005 or abs(bid[exit_] / 1000 - float(r["sell"])) > 0.0005:
            wrong.append(f"{r['date']}: prices {r['buy']} {r['sell']} vs {ask[entry] / 1000} {bid[exit_] / 1000}")
        for key in (r["kind"], f"{r['kind']} {r['date'][:4]}"):
            groups.setdefault(key, []).append(pl)
    print(f"trades checked {checked}; disagreements {len(wrong)}")
    for w in wrong[:20]:
        print("  ", w)
    for key in sorted(groups):
        xs = groups[key]
        won = sum(1 for x in xs if x > 0)
        print(f"{key}: n {len(xs)}, won {won} ({100 * won / len(xs):.1f}%), mean {sum(xs) / len(xs):.2f} sen")


if __name__ == "__main__":
    main()
