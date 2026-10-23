#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
backz.py — docs/OPERATIONS.md §8.126 の数え（#383）: 1時間足 MACD のメールの取引が、含み損 50・60 pips に
なったあと、利確まで戻ったか（過去のデータ。判定はしない）。Python。標準ライブラリだけ。

メールとオーナーの持ち方は、§8.124 の独立した Python（research/flowz-check.py。実データで TypeScript と一致した）
の compute と follow をそのまま使う（importlib で読む。ファイルは変えない）。ここで足すのは、取引ごとの τ_X
（含み損が初めて X pips 以上になった1分足）と、§8.126 の数えだけ。v6 は flowz-check.py のまま（95%）、v4 は
ZONE_SHARE だけを 90% にして同じ compute をもう一度回す。

使い方:
  python3 research/backz.py --cache DIR --start ISO --end ISO --load-from ISO --out out.json
      数えて out.json に書く（数は出さない。research/backz-check.py が同じ数を出した後に --print で出す）
  python3 research/backz.py --print out.json
"""
import argparse
import bisect
import importlib.util
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location('flowz_check', os.path.join(HERE, 'flowz-check.py'))
fc = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(fc)

MIN, DAY = fc.MIN, fc.DAY
XS = (50, 60)
RULES = (('v6', 95 / 100), ('v4', 90 / 100))
BINS = (('d1', 1), ('d7', 7), ('d30', 30), ('d90', 90))
EPS = 1e-6
TIE = 1e-9                     # §8.126 読み方の細部 1: ちょうど X pips（丸めでわずかに下に出るものも）は X 以上


def tau_of(pr, r, x):
    """含み損（決済側の値と約定値の差、pips。follow の mae と同じ式と範囲）が初めて x 以上（x − 1e-9 以上）になった1分足の番号（無ければ None）"""
    lo = bisect.bisect_left(pr.t, r['t0'])
    hi = r['tpK'] if r['tp'] else pr.n - 1
    fill, unit = r['fill'], pr.unit
    # 少し手前の値で候補を探し、式どおりの差で確かめる（ちょうど x の境目の丸めで食い違わないように）
    if r['_dir'] < 0:
        a, seek, adverse, thr = pr.ah, pr.m_ah, (lambda v: (v - fill) / unit), fill + (x - EPS) * unit
    else:
        a, seek, adverse, thr = pr.bl, pr.m_bl, (lambda v: (fill - v) / unit), fill - (x - EPS) * unit
    k = seek.first(lo, thr)
    while 0 <= k <= hi:
        if adverse(a[k]) >= x - TIE:
            return k
        k = seek.first(k + 1, thr)
    return None


_follow = fc.follow


def follow_tau(pr, P0, dirn, E, end):
    """flowz-check.py の follow に、τ_X（X＝50・60）の時刻を足す（結果は変えない）"""
    r = _follow(pr, P0, dirn, E, end)
    r['tau'] = {}
    if r['filled']:
        r['_dir'] = dirn
        for x in XS:
            k = tau_of(pr, r, x)
            r['tau'][x] = pr.t[k] if k is not None else None
    return r


fc.follow = follow_tau


def stats_x(emails, x):
    g = [e for e in emails if e.path['filled'] and e.path['tau'].get(x) is not None]
    back = [e for e in g if e.path['tp']]
    held = [e for e in g if not e.path['tp']]
    back_days = [(e.path['tpT'] + MIN - e.path['tau'][x]) / DAY for e in back]
    to_tau = [(e.path['tau'][x] - e.path['t0']) / DAY for e in back]
    dist = {}
    for name, lim in BINS:
        dist[name] = sum(1 for d in back_days if d <= lim)
    dist['longer'] = sum(1 for d in back_days if d > 90)

    def mm(xs):
        return dict(median=fc.median(xs), max=max(xs) if xs else None)

    side = {s: dict(n=sum(1 for e in g if e.side == s), back=sum(1 for e in back if e.side == s)) for s in ('SELL', 'BUY')}
    pair = {p: dict(n=sum(1 for e in g if e.pair == p), back=sum(1 for e in back if e.pair == p)) for p in fc.PAIRS}
    held_list = [dict(pair=e.pair, side=e.side, T=fc.iso(e.T), tau=fc.iso(e.path['tau'][x]), pips=e.path['pips'], mae=e.path['mae'])
                 for e in held]
    return dict(
        n=len(g), back=len(back), held=len(held),
        heldPipsSum=fc.add_in_order([e.path['pips'] for e in held]),
        heldPipsMin=min((e.path['pips'] for e in held), default=None),
        backDays=mm(back_days), backDist=dist, toTauDays=mm(to_tau),
        backPipsMean=fc.mean_in_order([e.path['pips'] for e in back]),
        mae=dict(all=mm([e.path['mae'] for e in g]), back=mm([e.path['mae'] for e in back]), held=mm([e.path['mae'] for e in held])),
        bySide=side, byPair=pair, heldList=held_list,
    )


def run(cache, start, end, load_from, share):
    fc.ZONE_SHARE = share
    emails, _pairs, ld, _extra = fc.compute(cache, start, end, end, load_from, lambda *a, **k: None)
    f = [e for e in emails if e.path['filled']]
    base = dict(mails=len(emails), filled=len(f), unfilled=len(emails) - len(f), tp=sum(1 for e in f if e.path['tp']),
                held=sum(1 for e in f if not e.path['tp']))
    return dict(share=share, base=base, x={str(x): stats_x(emails, x) for x in XS},
                load=dict(files=ld.files, failed=ld.failed))


def show(s):
    m = s['meta']
    print(f"backz (docs §8.126): emails in [{m['start']}, {m['end']}), 1-hour bars from {m['loadFrom']}")
    for name, r in s['rules'].items():
        b = r['base']
        print(f"== {name} ({r['share'] * 100:.0f}%): emails {b['mails']}, filled {b['filled']}, unfilled {b['unfilled']}, TP {b['tp']}, still held at END {b['held']}"
              f" (files {r['load']['files']}, failed {r['load']['failed']})")
        for x, t in r['x'].items():
            print(f"  X={x}: reached {t['n']}, came back to TP {t['back']}, still held at END {t['held']} (sum {t['heldPipsSum']}, worst {t['heldPipsMin']})")
            print(f"    back: days from tau to TP median {t['backDays']['median']} max {t['backDays']['max']}; within 1d {t['backDist']['d1']}, 7d {t['backDist']['d7']},"
                  f" 30d {t['backDist']['d30']}, 90d {t['backDist']['d90']}, longer {t['backDist']['longer']}; days fill->tau median {t['toTauDays']['median']} max {t['toTauDays']['max']};"
                  f" pips mean {t['backPipsMean']}")
            print(f"    MAE all {t['mae']['all']}, back {t['mae']['back']}, held {t['mae']['held']}")
            print(f"    by side {t['bySide']}")
            print(f"    by pair {t['byPair']}")
            for h in t['heldList']:
                print(f"    held: {h}")


def main():
    ap = argparse.ArgumentParser(description='docs §8.126 の数え')
    ap.add_argument('--cache')
    ap.add_argument('--start')
    ap.add_argument('--end')
    ap.add_argument('--load-from')
    ap.add_argument('--out')
    ap.add_argument('--print', dest='show')
    a = ap.parse_args()
    if a.show:
        with open(a.show, encoding='utf-8') as f:
            show(json.load(f))
        return
    if not (a.cache and a.start and a.end and a.load_from and a.out):
        sys.exit('--cache, --start, --end, --load-from and --out are needed')
    start, end, load_from = fc.ms_of(a.start), fc.ms_of(a.end), fc.ms_of(a.load_from)
    s = dict(meta=dict(start=fc.iso(start), end=fc.iso(end), loadFrom=fc.iso(load_from), xs=list(XS)),
             rules={name: run(a.cache, start, end, load_from, share) for name, share in RULES})
    with open(a.out, 'w', encoding='utf-8') as f:
        json.dump(s, f, indent=1)
    print(f"written {a.out}: " + ', '.join(f"{n} {r['base']['mails']} emails" for n, r in s['rules'].items()))


if __name__ == '__main__':
    main()
