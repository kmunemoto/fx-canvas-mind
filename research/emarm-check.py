#!/usr/bin/env python3
"""#387（docs §8.130）: research/emarm.ts の数え直し（Python、同じ GMO のファイルから）。

足（Bid と Ask の合わせ方・週末・中値の丸め）は、#371 で TypeScript と別に書かれた research/flowz-check.py の
関数を使う（load_tf・keys_of・round_chart・is_possibly_closed）。15分足の中値は、始値・高値・安値・終値のそれぞれを
(Bid ＋ Ask) / 2 にして、チャートと同じ桁に丸める（analyze/price-source.ts の midCandle と live-chart の
historyRead）。

決まり（20EMA と 200EMA のクロス、200EMA へのタッチ、2本のネックライン、抜け、リターンムーブ、エントリー）は、
research/ema-return-spec.md だけを読んで別に書いた research/emarm-rule.py（_shared/ema-return.ts を読まずに書いた
もの）で判定する。ここで足すのは、600本の窓での判定と1本の長い判定の比べ、メールが送られる足（確定の0・1・3分後の
読み込み）、エントリーのあとの値の追い方（動画の損切りと利確1、オーナーの持ち方: 損切りなしで利確1だけ）、
数の比べだけ。

使い方:
  python3 -I research/emarm-check.py --cache research/.cache --out research/out/emarm
    期間（start・end・loadFrom）と決まりの数（params）は OUT/summary.json の meta から読む。
終了コード: 0 = 行と数がすべて一致（最後の行 EMARM-CHECK PASSED）、1 = 食い違いあり（EMARM-CHECK FAILED）。
"""
import argparse
import csv
import importlib.util
import json
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, os.path.join(HERE, file))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


fc = load('flowz_check', 'flowz-check.py')
rule = load('emarm_rule', 'emarm-rule.py')

MIN = fc.MIN
DAY = fc.DAY
PAIRS = ['USD/JPY', 'EUR/JPY', 'AUD/JPY', 'EUR/USD', 'AUD/USD']
STEP = 15 * MIN
READS = (0, 1, 3)                 # indicators.ts gmoIntervalsDue: 15分足は確定の0・1・3分後に読む
PARAMS = {'fast': rule.FAST, 'slow': rule.SLOW, 'window': rule.WINDOW, 'warm': rule.WARM, 'piv': rule.PIV, 'skip': rule.SKIP}
REL = 1e-9


def mailed(T):
    return any(not fc.is_possibly_closed(T + m * MIN + 1000) for m in READS)


def follow_video(o, h, l, c, e, pip):
    """動画の損切りと利確1: 次の足から最後の足まで。始値がどちらかを越えていれば始値で、両方に届いた足は both"""
    d = 1 if e['dir'] == 'BUY' else -1
    E, stop, tp = e['entry'], e['stop'], e['tp1']

    def pips(x):
        return ((x - E) * d) / pip

    def past_stop(x):
        return x <= stop if d == 1 else x >= stop

    def past_tp(x):
        return x >= tp if d == 1 else x <= tp

    at = e['bar']
    for j in range(at + 1, len(c)):
        if past_stop(o[j]):
            return 'stop', j - at, pips(o[j])
        if past_tp(o[j]):
            return 'tp', j - at, pips(o[j])
        s = past_stop(l[j] if d == 1 else h[j])
        t = past_tp(h[j] if d == 1 else l[j])
        if s and t:
            return 'both', j - at, None
        if s:
            return 'stop', j - at, pips(stop)
        if t:
            return 'tp', j - at, pips(tp)
    return 'open', len(c) - 1 - at, pips(c[-1])


def follow_owner(o, h, l, c, e, pip):
    """オーナーの持ち方: 損切りなし、利確1だけ。逆へ一番行った幅（出た足まで）と持った足の数"""
    d = 1 if e['dir'] == 'BUY' else -1
    E, tp = e['entry'], e['tp1']

    def pips(x):
        return ((x - E) * d) / pip

    at = e['bar']
    mae = 0
    for j in range(at + 1, len(c)):
        against = -pips(l[j] if d == 1 else h[j])
        if against > mae:
            mae = against
        if (o[j] >= tp) if d == 1 else (o[j] <= tp):
            return 'tp', j - at, pips(o[j]), mae
        if (h[j] >= tp) if d == 1 else (l[j] <= tp):
            return 'tp', j - at, pips(tp), mae
    return 'open', len(c) - 1 - at, pips(c[-1]), mae


def quantile(xs, q):
    if not xs:
        return None
    a = sorted(xs)
    return a[min(len(a) - 1, max(0, math.ceil(q * len(a)) - 1))]


def add(xs):
    s = 0
    for x in xs:
        s += x
    return s


def mean(xs):
    return add(xs) / len(xs) if xs else None


def stats_of(rows, long_rows, weeks):
    tp = [r for r in rows if r['vRes'] == 'tp']
    st = [r for r in rows if r['vRes'] == 'stop']
    decided = tp + st
    ages = [r['e']['bar'] - r['e']['x'] for r in rows]
    o_tp = [r for r in rows if r['oRes'] == 'tp']
    o_open = [r for r in rows if r['oRes'] == 'open']
    old = PARAMS['window'] - PARAMS['warm'] - 1
    return {
        'entries': len(rows),
        'mailed': sum(1 for r in rows if r['mailed']),
        'buy': sum(1 for r in rows if r['e']['dir'] == 'BUY'),
        'sell': sum(1 for r in rows if r['e']['dir'] == 'SELL'),
        'perWeek': len(rows) / weeks,
        'age': {'median': quantile(ages, 0.5), 'p90': quantile(ages, 0.9), 'max': max(ages) if ages else None},
        'rr': {'median': quantile([r['e']['rr'] for r in rows], 0.5), 'min': min(r['e']['rr'] for r in rows) if rows else None},
        'risk': {'median': quantile([abs(r['e']['entry'] - r['e']['stop']) for r in rows], 0.5)},
        'tp2': sum(1 for r in rows if r['e']['tp2'] is not None),
        'long': {
            'entries': len(long_rows),
            'both': sum(1 for r in rows if r['long']),
            'windowOnly': sum(1 for r in rows if not r['long']),
            'longOnly': sum(1 for x in long_rows if not x['inWindow']),
            'longOnlyOld': sum(1 for x in long_rows if not x['inWindow'] and x['e']['bar'] - x['e']['x'] > old),
        },
        'video': {
            'tp': len(tp),
            'stop': len(st),
            'both': sum(1 for r in rows if r['vRes'] == 'both'),
            'open': sum(1 for r in rows if r['vRes'] == 'open'),
            'winPct': 100 * len(tp) / len(decided) if decided else None,
            'avgWin': mean([r['vPips'] for r in tp]),
            'avgLoss': mean([r['vPips'] for r in st]),
            'sumDecided': add([r['vPips'] for r in decided]),
            'perTrade': mean([r['vPips'] for r in decided]),
            'openPips': add([r['vPips'] for r in rows if r['vRes'] == 'open']),
            'barsMedian': quantile([r['vBars'] for r in decided], 0.5),
        },
        'owner': {
            'tp': len(o_tp),
            'open': len(o_open),
            'avgWin': mean([r['oPips'] for r in o_tp]),
            'openPips': add([r['oPips'] for r in o_open]),
            'openWorst': min(r['oPips'] for r in o_open) if o_open else None,
            'maeMedian': quantile([r['oMae'] for r in rows], 0.5),
            'maeP90': quantile([r['oMae'] for r in rows], 0.9),
            'maeMax': max(r['oMae'] for r in rows) if rows else None,
            'barsMedian': quantile([r['oBars'] for r in o_tp], 0.5),
            'barsMax': max(r['oBars'] for r in o_tp) if o_tp else None,
        },
    }


def same_num(a, b):
    if a is None or b is None:
        return a is None and b is None
    if isinstance(a, bool) or isinstance(b, bool):
        return a == b
    if a == b:
        return True
    return abs(a - b) <= REL * max(abs(a), abs(b))


def compare(path, a, b, bad):
    """a: TypeScript の summary の値、b: ここで数えた値"""
    if isinstance(b, dict):
        if not isinstance(a, dict):
            bad(f'{path}: not an object in summary.json')
            return
        for k in b:
            compare(f'{path}.{k}', a.get(k), b[k], bad)
        return
    if isinstance(b, str):
        if a != b:
            bad(f'{path}: {a!r} != {b!r}')
        return
    if not same_num(a, b):
        bad(f'{path}: {a!r} != {b!r}')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--cache', required=True)
    ap.add_argument('--out', required=True)
    args = ap.parse_args()
    summary = json.load(open(os.path.join(args.out, 'summary.json')))
    meta = summary['meta']
    start, end, load_from = fc.ms_of(meta['start']), fc.ms_of(meta['end']), fc.ms_of(meta['loadFrom'])
    if meta['params'] != PARAMS:
        fc.die(f'params differ: {meta["params"]} != {PARAMS}')
    ts_rows = list(csv.DictReader(open(os.path.join(args.out, 'rows.csv'))))
    ts_long = list(csv.DictReader(open(os.path.join(args.out, 'long.csv'))))
    ld = fc.LoadStats()
    diffs = 0

    def bad(msg):
        nonlocal diffs
        diffs += 1
        if diffs <= 40:
            print('DIFF', msg)

    weeks = (end - start) / (7 * DAY)
    mine, mine_long, all_long_in = [], [], []
    for pi, pair in enumerate(PAIRS):
        sym = pair.replace('/', '_')
        dec = 5 if pair.endswith('/USD') else 3
        pip = 0.01 if 'JPY' in pair else 0.0001
        got = fc.load_tf(cache=args.cache, sym=sym, interval='15min', step=STEP, keys=fc.keys_of(load_from, end),
                         from_ms=load_from, to_ms=end, ld=ld)
        t = [x[0] for x in got]
        o = [fc.round_chart((x[1][1] + x[2][1]) / 2, dec) for x in got]
        h = [fc.round_chart((x[1][2] + x[2][2]) / 2, dec) for x in got]
        lo = [fc.round_chart((x[1][3] + x[2][3]) / 2, dec) for x in got]
        c = [fc.round_chart((x[1][4] + x[2][4]) / 2, dec) for x in got]
        bars = [{'o': o[i], 'h': h[i], 'l': lo[i], 'c': c[i]} for i in range(len(t))]

        def in_range(i):
            return start <= t[i] + STEP <= end

        judged = sum(1 for i in range(len(t)) if in_range(i) and i + 1 >= PARAMS['window'])
        short = sum(1 for i in range(len(t)) if in_range(i) and i + 1 < PARAMS['window'])
        win = [e for e in rule.scan_windows(bars, PARAMS['window'] - 1) if in_range(e['bar'])]
        long_ = [e for e in rule.scan(bars) if in_range(e['bar'])]
        long_at = {e['bar']: e for e in long_}
        win_at = {e['bar']: e for e in win}
        rows = []
        for e in win:
            v = follow_video(o, h, lo, c, e, pip)
            ow = follow_owner(o, h, lo, c, e, pip)
            le = long_at.get(e['bar'])
            rows.append({'pair': pair, 'e': e, 'mailed': mailed(t[e['bar']] + STEP), 'long': le is not None and le['dir'] == e['dir'],
                         'vRes': v[0], 'vBars': v[1], 'vPips': v[2], 'oRes': ow[0], 'oBars': ow[1], 'oPips': ow[2], 'oMae': ow[3]})
        long_rows = [{'e': e, 'inWindow': e['bar'] in win_at and win_at[e['bar']]['dir'] == e['dir']} for e in long_]
        mine.extend((r, t) for r in rows)
        mine_long.extend((pair, x, t) for x in long_rows)
        all_long_in.extend(long_rows)
        st = stats_of(rows, long_rows, weeks)
        st.update({'bars': len(t), 'first': fc.iso(t[0]) if t else None, 'last': fc.iso(t[-1]) if t else None, 'judged': judged, 'short': short})
        compare(f'pairs[{pair}]', summary['pairs'][pi], st, bad)
        print(f'{pair}: {len(t)} bars, judged {judged} (short {short}), entries {len(rows)}, long {len(long_)}')
    compare('total', summary['total'], stats_of([r for r, _ in mine], all_long_in, weeks), bad)

    # 行ごと（TS の文字列を double に戻して、そのまま比べる）
    if len(ts_rows) != len(mine):
        bad(f'rows: {len(ts_rows)} in rows.csv, {len(mine)} here')
    for a, (r, t) in zip(ts_rows, mine):
        e = r['e']
        want = {
            'pair': r['pair'], 'open': fc.iso(t[e['bar']]), 'side': e['dir'],
            'x': fc.iso(t[e['x']]), 't': fc.iso(t[e['t']]), 'aAt': fc.iso(t[e['aAt']]), 'b': fc.iso(t[e['B']]),
            'k': fc.iso(t[e['K']]), 'dk': fc.iso(t[e['Dk']]), 'r': fc.iso(t[e['R']]),
            'mailed': '1' if r['mailed'] else '0', 'long': '1' if r['long'] else '0', 'vRes': r['vRes'], 'oRes': r['oRes'],
            'vBars': str(r['vBars']), 'oBars': str(r['oBars']),
        }
        for k, v in want.items():
            if a[k] != v:
                bad(f'row {a["pair"]} {a["open"]} {k}: {a[k]!r} != {v!r}')
        nums = {'a': e['A'], 'neck': e['H'], 'entry': e['entry'], 'stop': e['stop'], 'tp1': e['tp1'], 'tp2': e['tp2'], 'rr': e['rr'],
                'vPips': r['vPips'], 'oPips': r['oPips'], 'oMae': r['oMae']}
        for k, v in nums.items():
            got_ = None if a[k] == '' else float(a[k])
            if got_ != v:
                bad(f'row {a["pair"]} {a["open"]} {k}: {a[k]!r} != {v!r}')
    if len(ts_long) != len(mine_long):
        bad(f'long: {len(ts_long)} in long.csv, {len(mine_long)} here')
    for a, (pair, x, t) in zip(ts_long, mine_long):
        e = x['e']
        want = {'pair': pair, 'open': fc.iso(t[e['bar']]), 'side': e['dir'], 'x': fc.iso(t[e['x']]), 'inWindow': '1' if x['inWindow'] else '0'}
        for k, v in want.items():
            if a[k] != v:
                bad(f'long {a["pair"]} {a["open"]} {k}: {a[k]!r} != {v!r}')
        for k, v in {'entry': e['entry'], 'stop': e['stop'], 'tp1': e['tp1']}.items():
            if float(a[k]) != v:
                bad(f'long {a["pair"]} {a["open"]} {k}: {a[k]!r} != {v!r}')

    print(f'rows {len(mine)}, long {len(mine_long)}; files {ld.files}, failed {ld.failed}')
    if diffs:
        print(f'EMARM-CHECK FAILED: {diffs} differences')
        sys.exit(1)
    print('EMARM-CHECK PASSED')


if __name__ == '__main__':
    main()
