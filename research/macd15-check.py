#!/usr/bin/env python3
"""#384（docs §8.127）: research/macd15.ts の数え直し（Python、同じ GMO のファイルから）。

足（Bid と Ask の合わせ方・週末・中値の丸め）と、メールの決まり（600本の窓の MACD・120本の枠・95%の帯への入り）は、
#371 で TypeScript と別に書かれ、1時間足で行と数がすべて一致した research/flowz-check.py の関数を使う
（load_tf・round_chart・zone_entry・is_possibly_closed）。ここで足すのは、15分足の読み込みの時刻（確定の0・1・3分後）、
入りの足のシグナルの線・枠の端を決めた線・描いた枠での割合・山と谷ごとの数と、数の比べだけ。

使い方:
  python3 -I research/macd15-check.py --cache research/.cache --out research/out/macd15
終了コード: 0 = 行と数がすべて一致（最後の行 MACD15-CHECK PASSED）、1 = 食い違いあり（MACD15-CHECK FAILED）。
"""
import argparse
import csv
import importlib.util
import json
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('flowz_check', os.path.join(HERE, 'flowz-check.py'))
fc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fc)

MIN = fc.MIN
HOUR = fc.HOUR
DAY = fc.DAY
WINDOW = fc.WINDOW
ZONE_BARS = fc.ZONE_BARS
PAIRS = fc.PAIRS
STEP = {'15min': 15 * MIN, '1h': HOUR}
GMO_NAME = {'15min': '15min', '1h': '1hour'}
READS = {'15min': (0, 1, 3), '1h': (0, 3, 5)}       # indicators.ts gmoIntervalsDue
MARGIN = 0.08


def mailed(tf, T):
    return any(not fc.is_possibly_closed(T + m * MIN + 1000) for m in READS[tf])


def ms_of(text):
    return fc.ms_of(text)


def iso(ms):
    return fc.iso(ms)


def pine_ema(xs, n):
    """pine.ts pineEma: 最初の n 個の単純平均から（None の間は None）"""
    out = [None] * len(xs)
    a = 2 / (n + 1)
    b = 1 - a
    start = None
    for i, v in enumerate(xs):
        if v is not None:
            start = i
            break
    if start is None or len(xs) - start < n:
        return out
    s = 0.0
    for k in range(start, start + n):
        s += xs[k]
    e = s / n
    out[start + n - 1] = e
    for k in range(start + n, len(xs)):
        e = a * xs[k] + b * e
        out[k] = e
    return out


def macd_lines(closes):
    fast = pine_ema(closes, 12)
    slow = pine_ema(closes, 26)
    line = [None if f is None or s is None else f - s for f, s in zip(fast, slow)]
    sig = pine_ema(line, 9)
    hist = [None if l is None or s is None else l - s for l, s in zip(line, sig)]
    return line, sig, hist


def gmo_day(t):
    return iso((t + 3 * HOUR) // DAY * DAY)[:10]


def quantile(xs, q):
    if not xs:
        return None
    a = sorted(xs)
    return a[min(len(a) - 1, max(0, math.ceil(q * len(a)) - 1))]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--cache', required=True)
    ap.add_argument('--out', required=True)
    args = ap.parse_args()
    summary = json.load(open(os.path.join(args.out, 'summary.json')))
    meta = summary['meta']
    start, end, load_from = ms_of(meta['start']), ms_of(meta['end']), ms_of(meta['loadFrom'])
    if meta['margin'] != MARGIN:
        fc.die('margin differs')
    ts_rows = list(csv.DictReader(open(os.path.join(args.out, 'rows.csv'))))
    ld = fc.LoadStats()
    diffs = 0

    def bad(msg):
        nonlocal diffs
        diffs += 1
        if diffs <= 40:
            print('DIFF', msg)

    mine = []
    pairs_out = {}
    weeks = (end - start) / (7 * DAY)
    for pair in PAIRS:
        sym = pair.replace('/', '_')
        dec = 5 if pair.endswith('/USD') else 3
        pairs_out[pair] = {}
        for tf in ('15min', '1h'):
            step = STEP[tf]
            got = fc.load_tf(cache=args.cache, sym=sym, interval=GMO_NAME[tf], step=step, keys=fc.keys_of(load_from, end),
                             from_ms=load_from, to_ms=end, ld=ld)
            t = [x[0] for x in got]
            c = [fc.round_chart((x[1][4] + x[2][4]) / 2, dec) for x in got]
            judged = short = 0
            rows = []
            for i in range(len(t)):
                T = t[i] + step
                if T < start or T > end:
                    continue
                if i + 1 < WINDOW:
                    short += 1
                    continue
                judged += 1
                w = c[i - WINDOW + 1:i + 1]
                d = fc.zone_entry(w)
                if d is None:
                    continue
                side, m, top, bottom = d
                line, sig, hist = macd_lines(w)
                k = WINDOW - 1
                sell = side == 'SELL'
                edge_by, best = 'm', 0.0
                for name, xs in (('m', line), ('s', sig), ('h', hist)):
                    for j in range(k - ZONE_BARS + 1, k + 1):
                        v = xs[j]
                        if (v > best) if sell else (v < best):
                            best, edge_by = v, name
                height = top - bottom
                drawn_edge = top + MARGIN * height if sell else bottom - MARGIN * height
                rows.append(dict(tf=tf, pair=pair, open=t[i], side=side, m=m, s=sig[k], top=top, bottom=bottom,
                                 mailed=mailed(tf, T), edgeBy=edge_by, drawn=m / drawn_edge))
            mine.extend(rows)
            ml = [r for r in rows if r['mailed']]
            days = {}
            for r in ml:
                k2 = gmo_day(r['open'] + step)
                days[k2] = days.get(k2, 0) + 1
            per_run = {}
            if ml:
                line_all = macd_lines(c)[0]
                run, sign = 0, 0
                run_of = []
                for v in line_all:
                    sg = 0 if v is None else (1 if v > 0 else (-1 if v < 0 else sign))
                    if sg != sign:
                        run += 1
                    sign = sg
                    run_of.append(run)
                idx = {tt: i for i, tt in enumerate(t)}
                per = {}
                for r in ml:
                    q = run_of[idx[r['open']]]
                    per[q] = per.get(q, 0) + 1
                for n in per.values():
                    key = '4+' if n >= 4 else str(n)
                    per_run[key] = per_run.get(key, 0) + 1
            drawn = [r['drawn'] for r in ml]
            pairs_out[pair][tf] = dict(
                bars=len(t), first=iso(t[0]) if t else None, last=iso(t[-1]) if t else None, judged=judged, short=short,
                entries=len(rows), mailed=len(ml), notMailed=len(rows) - len(ml),
                sell=sum(1 for r in ml if r['side'] == 'SELL'), buy=sum(1 for r in ml if r['side'] == 'BUY'),
                perWeek=len(ml) / weeks, daysWithMail=len(days), maxInADay=max([0] + list(days.values())),
                crossZero=sum(1 for r in ml if (r['s'] < 0 if r['side'] == 'SELL' else r['s'] > 0)),
                edgeBy=dict(m=sum(1 for r in ml if r['edgeBy'] == 'm'), s=sum(1 for r in ml if r['edgeBy'] == 's'),
                            h=sum(1 for r in ml if r['edgeBy'] == 'h')),
                drawn=dict(min=min(drawn) if drawn else None, median=quantile(drawn, 0.5), max=max(drawn) if drawn else None,
                           at95=sum(1 for x in drawn if x >= 0.95), at90=sum(1 for x in drawn if x >= 0.9)),
                perRun=per_run)
            print(f'{pair} {tf}: {len(t)} bars, judged {judged} (short {short}), entries {len(rows)}, mailed {len(ml)}')

    # the rows, one by one
    if len(ts_rows) != len(mine):
        bad(f'rows: TS {len(ts_rows)}, Python {len(mine)}')
    for k, (a, b) in enumerate(zip(ts_rows, mine)):
        same = (a['tf'] == b['tf'] and a['pair'] == b['pair'] and ms_of(a['open']) == b['open'] and a['side'] == b['side']
                and float(a['m']) == b['m'] and float(a['s']) == b['s'] and float(a['top']) == b['top']
                and float(a['bottom']) == b['bottom'] and (a['mailed'] == '1') == b['mailed'] and a['edgeBy'] == b['edgeBy']
                and float(a['drawn']) == b['drawn'])
        if not same:
            bad(f'row {k}: TS {dict(a)} / Python {b}')
    # the numbers
    ts_pairs = {p['pair']: p for p in summary['pairs']}
    for pair in PAIRS:
        for tf in ('15min', '1h'):
            a, b = ts_pairs[pair][tf], pairs_out[pair][tf]
            for key in b:
                if a.get(key) != b[key]:
                    bad(f'{pair} {tf} {key}: TS {a.get(key)} / Python {b[key]}')
    print(f'load: requests {ld.requests if hasattr(ld, "requests") else "-"}')
    if diffs:
        print(f'MACD15-CHECK FAILED: {diffs} differences')
        sys.exit(1)
    print(f'rows {len(mine)} and every number the same')
    print('MACD15-CHECK PASSED')


if __name__ == '__main__':
    main()
