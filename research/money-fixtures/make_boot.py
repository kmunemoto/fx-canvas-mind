#!/usr/bin/env python3
"""#188: the hand example of the weeks rearranged (docs §8.99 「手で計算した小さな
例」: 週の並べ替えで、週をまたいで続く建玉と、次に置かれた週の同じペアの反対の
建玉（両建ての証拠金）の例は、並べ替えが money.ts だけなので、money.ts と手の計算
で合わせる).

research/money.ts only (FIXTURE=research/money-fixtures/boot_carry_hedge): the
independent check does not rearrange weeks (interface.md §5), so this fixture
is not one for research/money-check.py --fixture. It is written with make.py's
own bar writer (the same files, the same conventions) and its numbers are
typed here from the hand calculation below; there is no second calculation
in Python (recompute.py does not rearrange either).

The example. USD/JPY only, spread 0.4 pip (bid below, ask = bid + 0.004).
Three weeks (Sunday 21:00 UTC):
  week 0 (A, from 2024-02-04 21:00): S1 BUY, its signal bar closing Fri
      2024-02-09 16:00 at mid 160.000 (bid 159.998, ask 160.002): fill 160.002,
      TP1 160.040, stop 159.870. Nothing more that week: it is held over the
      weekend.
  week 1 (B, from 2024-02-11 21:00): one bar, Mon 2024-02-12 04:30, bid
      160.000 / 160.045 / 160.000 / 160.040: S1 out at TP1 160.040, x 04:35.
  week 2 (C, from 2024-02-18 21:00): S2 SELL, its signal bar closing Mon
      2024-02-19 04:00 at mid 150.000 (bid 149.998, ask 150.002): fill
      149.998, TP1 149.960, stop 150.130; a flat bar at 04:30; the bar at 08:00
      (bid 150.000 / 150.000 / 149.950 / 149.960, ask + 0.004: low 149.954):
      S2 out at TP1 149.960, x 08:05. (Then make.py's flush bars at 09:00 and
      09:05: nothing is held then.)
The clock G (bar ends): Feb 9 16:00, 16:05 | Feb 12 04:35 | Feb 19 04:00,
04:05, 04:35, 08:05, 09:05, 09:10. Rakuten's NY closes in it (Feb, US
standard time, 21:55 UTC): Fri Feb 9 (judged at 16:05), Mon–Fri Feb 12–16
(judged at Feb 12 04:35).

Run "path" (FF1_C0, as it is) and "same" (FF1_C0, weeks [0, 1, 2]: the path
itself, every row as "path" with the ids suffixed @<position>):
  1 enter S1 Feb 9 16:00: E 1,000,000 -> floor(0.01 x 1,000,000 / 0.13 / 1,000)
    = 76 -> 76,000 at 160.002; equity on the closes then 1,000,000 + 76,000 x
    (159.998 - 160.002) = 999,696; margin 0.04 x 76,000 x 160.000 = 486,400.
  2 exit S1 Feb 12 04:35 at 160.040: 76,000 x 0.038 = 2,888 -> 1,002,888.
  3 enter S2 Feb 19 04:00: E 1,002,888 -> floor(77.145) -> 77,000 at 149.998;
    equity 1,002,888 - 77,000 x 0.004 = 1,002,580; margin 0.04 x 77,000 x 150
    = 462,000.
  4 exit S2 Feb 19 08:05 at 149.960: 77,000 x 0.038 = 2,926 -> 1,005,814.

Run "rearranged" (FF1_C0, weeks [0, 2, 1]: A, then C, then B):
  the moves d: A 0; C placed a week early (-1 week); B a week late (+1 week).
  The new clock: Feb 9 16:00, 16:05 (A) | Feb 12 04:00, 04:05, 04:35, 08:05,
  09:05, 09:10 (C's, a week early) | Feb 19 04:35 (B's, a week late). S1 goes
  on along its own path at its own times (the clock's less 0): at Feb 12
  04:00 and 04:05 its own last bar is still Fri's (bid 159.998, mid 160.000;
  B's first bar is at 04:30); at Feb 12 04:35 its own exit bar: out at TP1
  160.040, on the clock at 04:35 (C's 04:30 bar gives the clock that close).
  S2 comes in at Feb 12 04:00 (its T less a week).
  1 enter S1@0 Feb 9 16:00: as in "path" (76,000; 999,696; 486,400).
  2 enter S2@1 Feb 12 04:00: E = 1,000,000 + 76,000 x (159.998 - 160.002) =
    999,696 -> floor(76.900) -> 76,000 at 149.998. The margin after it, MAX a
    pair, each position at its own mid: long S1 76,000 x 160.000 = 12,160,000,
    short S2 76,000 x 150.000 = 11,400,000 -> 0.04 x 12,160,000 = 486,400 <=
    999,696: in. (Both at the clock's week's mid, 150, it would be 456,000;
    the two sides added, 942,400.) Equity then: S1 -304, S2 at its T's ask
    150.002 -304 -> 999,392.
  3 exit S1@0 Feb 12 04:35 at 160.040: 2,888 -> 1,002,888; equity with S2 at
    its own 04:35 close (ask 150.002): 1,002,888 - 304 = 1,002,584; margin S2
    alone at its own mid 0.04 x 76,000 x 150 = 456,000.
  4 exit S2@1 Feb 12 08:05 at 149.960: 76,000 x 0.038 = 2,888 -> 1,005,776.
  No call (Fri Feb 9's NY close: on mids 999,848 >= 486,400), no loss-cut.

Run "rearranged_f10k" (F10k_C0, the same weeks, from 0 yen):
  rows: enter S1@0 (equity -40, margin 64,000); enter S2@1 (equity -80,
  margin 0.04 x max(1,600,000, 1,500,000) = 64,000); exit S1@0 +380 (balance
  380, equity 340, margin 60,000); exit S2@1 +380 (760).
  E*'s terms: the order 64,000 - (-40) = 64,040 at S2's T Feb 12 04:00 (S1's
  64,000 - 0 before it); the NY close Fri Feb 9 at 16:05: 64,000 - (-20, on
  mids) = 64,020; the loss-cut at Feb 12 04:05, both held: 32,000 - (-80) =
  32,080; the P/L's most negative 80 there. E* = 64,040 (the order term):
  40 lost by then + 64,000 the margin.
"""

import json
import os
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import make  # noqa: E402
from make import Ledger, at, flat, iso, ohlc, run, summary, tid  # noqa: E402


def boot_carry_hedge():
    s1, s2 = tid("USD/JPY", "2024-02-09 12:00", "BUY"), tid("USD/JPY", "2024-02-19 00:00", "SELL")
    path = Ledger()
    path.enter("2024-02-09 16:00", s1, 76_000, 160.002, balance=1_000_000, equity=999_696, margin=0.04 * 76_000 * 160.000)
    path.add(g=iso(at("2024-02-12 04:35")), kind="exit", id=s1, units=76_000, px=160.040, pnl_yen=76_000 * (160.040 - 160.002), balance=1_002_888, equity=1_002_888, margin=0, reason="tp")
    path.enter("2024-02-19 04:00", s2, 77_000, 149.998, balance=1_002_888, equity=1_002_580, margin=0.04 * 77_000 * 150.000)
    path.add(g=iso(at("2024-02-19 08:05")), kind="exit", id=s2, units=77_000, px=149.960, pnl_yen=77_000 * (149.998 - 149.960), balance=1_005_814, equity=1_005_814, margin=0, reason="tp")
    same = Ledger()
    for r in path.rows:
        same.add(**{k: v for k, v in r.items() if k != "seq"})
    same.rows[0]["id"] += "@0"
    same.rows[1]["id"] += "@0"
    same.rows[2]["id"] += "@2"
    same.rows[3]["id"] += "@2"
    re = Ledger()
    re.enter("2024-02-09 16:00", s1 + "@0", 76_000, 160.002, balance=1_000_000, equity=999_696, margin=0.04 * 76_000 * 160.000)
    re.enter("2024-02-12 04:00", s2 + "@1", 76_000, 149.998, balance=1_000_000, equity=999_392, margin=0.04 * max(76_000 * 160.000, 76_000 * 150.000))
    re.add(g=iso(at("2024-02-12 04:35")), kind="exit", id=s1 + "@0", units=76_000, px=160.040, pnl_yen=76_000 * (160.040 - 160.002), balance=1_002_888, equity=1_002_584, margin=0.04 * 76_000 * 150.000, reason="tp")
    re.add(g=iso(at("2024-02-12 08:05")), kind="exit", id=s2 + "@1", units=76_000, px=149.960, pnl_yen=76_000 * (149.998 - 149.960), balance=1_005_776, equity=1_005_776, margin=0, reason="tp")
    f = Ledger()
    f.enter("2024-02-09 16:00", s1 + "@0", 10_000, 160.002, balance=0, equity=-40, margin=64_000)
    f.enter("2024-02-12 04:00", s2 + "@1", 10_000, 149.998, balance=0, equity=-80, margin=64_000)
    f.add(g=iso(at("2024-02-12 04:35")), kind="exit", id=s1 + "@0", units=10_000, px=160.040, pnl_yen=380, balance=380, equity=340, margin=60_000, reason="tp")
    f.add(g=iso(at("2024-02-12 08:05")), kind="exit", id=s2 + "@1", units=10_000, px=149.960, pnl_yen=380, balance=760, equity=760, margin=0, reason="tp")
    estar = {
        "value": 64_040,
        "set_by": "order",
        "g": iso(at("2024-02-12 04:00")),
        "lost": 40,
        "margin": 64_000,
        "terms": [
            {"name": "order", "value": 64_040, "g": iso(at("2024-02-12 04:00"))},
            {"name": "nyclose", "value": 64_020, "g": iso(at("2024-02-09 16:05"))},
            {"name": "losscut", "value": 32_080, "g": iso(at("2024-02-12 04:05"))},
            {"name": "negative", "value": 80, "g": iso(at("2024-02-12 04:05"))},
        ],
    }
    rearranged = dict(run("rearranged", "FF1"), weeks=[0, 2, 1])
    return {
        "name": "boot_carry_hedge",
        "what": "the weeks rearranged (money.ts only): a position carried over a weekend on its own path, an opposite one of the same pair from the next placed week, the margin MAX a pair at each one's own mid",
        "hand": [line for line in __doc__.split("The example.")[1].strip().split("\n")],
        "pairs": ["USD/JPY"],
        "bars": {
            "USD/JPY": [
                flat("2024-02-09 15:55", 159.998),
                ohlc("2024-02-12 04:30", 160.000, 160.045, 160.000, 160.040),
                flat("2024-02-19 03:55", 149.998),
                flat("2024-02-19 04:30", 149.998),
                ohlc("2024-02-19 08:00", 150.000, 150.000, 149.950, 149.960),
            ],
        },
        "signals": [("USD/JPY", "2024-02-09 12:00", "BUY"), ("USD/JPY", "2024-02-19 00:00", "SELL")],
        "runs": [run("path", "FF1"), dict(run("same", "FF1"), weeks=[0, 1, 2]), rearranged, dict(run("rearranged_f10k", "F10k"), weeks=[0, 2, 1])],
        "expect": {
            "path": {"ledger": path.rows, "summary": summary(1_005_814.0, taken=2)},
            "same": {"ledger": same.rows, "summary": summary(1_005_814.0, taken=2)},
            "rearranged": {"ledger": re.rows, "summary": summary(1_005_776.0, taken=2)},
            "rearranged_f10k": {"ledger": f.rows, "summary": dict(summary(760.0, taken=2), estar=estar)},
        },
        "plants": ["hedgesum"],
    }


def main():
    fx = boot_carry_hedge()
    d = make.write(fx)
    # marked so no loop over the fixtures hands it to the check
    path = os.path.join(d, "fixture.json")
    with open(path) as f:
        out = json.load(f)
    out["money_ts_only"] = True
    with open(path, "w") as f:
        json.dump(out, f, indent=1)
        f.write("\n")
    print(f"{fx['name']}: written to {d} ({sum(len(v['ledger']) for v in fx['expect'].values())} ledger rows, {len(fx['runs'])} runs); money.ts only (FIXTURE={d})")


if __name__ == "__main__":
    main()
