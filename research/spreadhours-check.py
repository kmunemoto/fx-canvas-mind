#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
spreadhours-check.py — docs/OPERATIONS.md §8.103 の段1（2「スプレッドの数え方」・3「避ける枠の決め方」）の
独立した計算し直し（Python。標準ライブラリと numpy だけ）。research/spreadhours*.ts は読まずに、§8.103 だけから書いた。

  * 鍵の一覧を自分で作り（期間を前後に1日広げた日本時間の日付。最後は END の日本時間の日付）、
    その GMO の1分足の日のファイル（売値・買値）だけを開く。フォルダの中を全部開くことはしない。
  * 足を残す決め方: 売値と買値の両方がある・買値の終値が売値の終値より下でない（日のファイルごと）、
    足の始まりが [START, END) で、終わりが END 以下・週末の閉まる時間（土曜すべて・金曜 22:00 UTC 以後・
    日曜 21:00 UTC 前）の中に、始まりと終わりの両方が入らない・前に残した足より後の時刻（同じ時刻の2本目でない）。
  * 季節は zoneinfo の America/New_York のずれ（−4時間なら夏）。枠は UTC の15分。
  * 1本の値 s ＝ (買値の終値 − 売値の終値) を 0.1 pips（円 0.001、ドル 0.00001）の整数に丸めたもの。
  * 枠ごとの本数・中央値（2倍の整数）・合計・90%点、base（すべての足の中央値、2倍）、しきい値
    max(3 × base, 1.0 pips)（2倍）、避けるか（本数 1,000 以上で、中央値 ≧ しきい値）。

使い方:
  python3 research/spreadhours-check.py --gmo GMO_DIR --dump DUMP_DIR [--also PLANT_DUMP ...] [--plant keys]
  --dump:  research/spreadhours.ts の書き出し（table.json）。全件ちょうど一致すること。
  --also:  仕込んだ誤りの書き出し。どれも、どこかが食い違うこと（一致したら失敗）。
  --plant keys: 鍵の一覧の外の日のファイル（最初の鍵の前の日）も開く（自分の確かめで止まること）。
終了コード: 0 = 一致（--also はどれも食い違い）、1 = 食い違い（または --also が一致）、2 = 入力の誤り、3 = 確かめで止まった。
"""
import argparse
import datetime
import json
import math
import os
import sys
from zoneinfo import ZoneInfo

import numpy as np

MIN = 60_000
HOUR = 3_600_000
DAY = 86_400_000
SLOT = 15 * MIN
SLOTS = 96
START = 1704067200000          # 2024-01-01 00:00 UTC
END = 1790985600000            # 2026-10-03 00:00 UTC
KEY_MIN = '20231231'
KEY_MAX = '20261003'
MIN_BARS = 1000
FLOOR2 = 20
PAIRS = ['USD/JPY', 'EUR/JPY', 'AUD/JPY', 'EUR/USD', 'AUD/USD']
SEASONS = ['summer', 'winter']
NY = ZoneInfo('America/New_York')
UTC = datetime.timezone.utc


def die(msg, code=2):
    print(f'spreadhours-check: {msg}', file=sys.stderr)
    sys.exit(code)


def jst_key(ms):
    return datetime.datetime.fromtimestamp((ms + 9 * HOUR) / 1000, UTC).strftime('%Y%m%d')


def keys_of(start, end, plant):
    first = datetime.datetime.strptime(jst_key(start - DAY), '%Y%m%d').date()
    last = datetime.datetime.strptime(jst_key(end), '%Y%m%d').date()
    if plant == 'keys':
        first -= datetime.timedelta(days=1)
    out = []
    d = first
    while d <= last:
        out.append(d.strftime('%Y%m%d'))
        d += datetime.timedelta(days=1)
    return out


def closed(t):
    """GMO の週末（土曜すべて・金曜 22:00 UTC 以後・日曜 21:00 UTC 前）。"""
    wd = datetime.datetime.fromtimestamp(t / 1000, UTC).weekday()   # 月曜 0
    h = (t % DAY) // HOUR
    return wd == 5 or (wd == 4 and h >= 22) or (wd == 6 and h < 21)


_SUMMER = {}


def summer(t):
    """その時刻の NY のずれが −4時間か（1時間の中では変わらない: 切り替わりは UTC の正時）。"""
    h = t // HOUR
    if h not in _SUMMER:
        off = datetime.datetime.fromtimestamp(h * HOUR / 1000, UTC).astimezone(NY).utcoffset()
        _SUMMER[h] = off == datetime.timedelta(hours=-4)
    return _SUMMER[h]


def read_rows(path, problems):
    """日のファイル1つの行（openTime, close）。読めなければ None。"""
    try:
        with open(path, 'rb') as f:
            j = json.loads(f.read())
    except Exception as e:  # noqa: BLE001
        problems.append(f'{path}: {e!r}')
        return None
    st = j.get('status')
    data = j.get('data')
    if not isinstance(data, list) or st not in (0, 404):
        problems.append(f'{path}: status {st}')
        return None
    return [(int(r['openTime']), float(r['close'])) for r in data]


def load_pair(gmo, pair, keys):
    sym = pair.replace('/', '_')
    scale = 1000 if 'JPY' in pair else 100000
    problems = []
    failed = 0
    dropped = dict(oneSide=0, crossed=0, closure=0, repeated=0)
    t_out, s_out = [], []
    last = -math.inf
    not_whole = 0
    for key in keys:
        bid = read_rows(os.path.join(gmo, sym, '1min', 'bid', f'{key}.json'), problems)
        ask = read_rows(os.path.join(gmo, sym, '1min', 'ask', f'{key}.json'), problems)
        if bid is None or ask is None:
            failed += 1
            continue
        asks = {}
        for t, c in ask:
            asks[t] = c          # 同じ時刻が2回あれば後の行（TS の Map と同じ）
        day = []
        for t, bc in bid:
            if t not in asks:
                dropped['oneSide'] += 1
                continue
            ac = asks.pop(t)
            if ac < bc:
                dropped['crossed'] += 1
                continue
            day.append((t, bc, ac))
        dropped['oneSide'] += len(asks)
        for t, bc, ac in day:
            if t < START or t + MIN > END:
                continue
            if closed(t) and closed(t + MIN - 1):
                dropped['closure'] += 1
                continue
            if t <= last:
                dropped['repeated'] += 1
                continue
            last = t
            d = (ac - bc) * scale
            r = int(round(d))
            if abs(d - r) > 1e-6:
                not_whole += 1
            t_out.append(t)
            s_out.append(r)
    return np.array(t_out, dtype=np.int64), np.array(s_out, dtype=np.int64), dropped, failed, not_whole, problems


def twice_median(sorted_vals):
    n = sorted_vals.size
    if n == 0:
        return None
    if n % 2:
        return int(2 * sorted_vals[(n - 1) // 2])
    return int(sorted_vals[n // 2 - 1] + sorted_vals[n // 2])


def table_of(gmo, pair, keys):
    t, s, dropped, failed, not_whole, problems = load_pair(gmo, pair, keys)
    n = t.size
    season = np.fromiter((0 if summer(int(x)) else 1 for x in t), dtype=np.int64, count=n)
    slot = (t % DAY) // SLOT
    cell = season * SLOTS + slot
    base2 = twice_median(np.sort(s)) if n else 0
    thr2 = max(3 * base2, FLOOR2)
    cells = []
    for c in range(2 * SLOTS):
        v = np.sort(s[cell == c])
        bars = int(v.size)
        med2 = twice_median(v)
        p90 = int(v[min(bars - 1, int(math.floor(0.9 * (bars - 1))))]) if bars else None
        cells.append(dict(season=SEASONS[c // SLOTS], slot=c % SLOTS, bars=bars, med2=med2, sum=int(v.sum()), p90=p90,
                          avoid=bool(bars >= MIN_BARS and med2 is not None and med2 >= thr2)))
    return dict(pair=pair, keyMin=keys[0], keyMax=keys[-1], tMin=int(t[0]) if n else None, tMax=int(t[-1]) + MIN if n else None,
                bars=int(n), dropped=dropped, failed=failed, notWhole=not_whole, base2=base2, thr2=thr2, cells=cells), problems


def checks_of(tb):
    bad = []
    if tb['failed']:
        bad.append(f"{tb['pair']}: {tb['failed']} day files not read")
    if not (tb['keyMin'] >= KEY_MIN and tb['keyMax'] <= KEY_MAX):
        bad.append(f"{tb['pair']}: the day files opened {tb['keyMin']}..{tb['keyMax']}, outside {KEY_MIN}..{KEY_MAX}")
    if not tb['bars']:
        bad.append(f"{tb['pair']}: no bar kept")
    elif not (tb['tMin'] >= START and tb['tMax'] <= END):
        bad.append(f"{tb['pair']}: the bars kept {tb['tMin']}..{tb['tMax']}, outside {START}..{END}")
    if tb['notWhole']:
        bad.append(f"{tb['pair']}: {tb['notWhole']} spreads not a whole 0.1 pips")
    return bad


def same(a, b):
    if isinstance(a, float) or isinstance(b, float):
        return a is not None and b is not None and abs(a - b) <= 1e-9
    return a == b


def compare(mine, dump_dir):
    """自分の表と TS の table.json の食い違い（文の一覧）。"""
    path = os.path.join(dump_dir, 'table.json')
    try:
        with open(path) as f:
            j = json.load(f)
    except Exception as e:  # noqa: BLE001
        die(f'{path}: {e!r}')
    if j.get('start') != START or j.get('end') != END or j.get('keyMin') != KEY_MIN or j.get('keyMax') != KEY_MAX:
        return [f'{path}: the period or the key range is not §8.103 2\'s']
    theirs = {t['pair']: t for t in j['tables']}
    diffs = []
    for tb in mine:
        th = theirs.get(tb['pair'])
        if th is None:
            diffs.append(f"{tb['pair']}: not in the dump")
            continue
        for k in ('keyMin', 'keyMax', 'tMin', 'tMax', 'bars', 'failed', 'notWhole', 'base2', 'thr2'):
            if not same(tb[k], th[k]):
                diffs.append(f"{tb['pair']} {k}: mine {tb[k]}, the dump's {th[k]}")
        for k in tb['dropped']:
            if tb['dropped'][k] != th['dropped'][k]:
                diffs.append(f"{tb['pair']} dropped {k}: mine {tb['dropped'][k]}, the dump's {th['dropped'][k]}")
        if len(th['cells']) != len(tb['cells']):
            diffs.append(f"{tb['pair']}: {len(th['cells'])} cells in the dump")
            continue
        for a, b in zip(tb['cells'], th['cells']):
            for k in ('season', 'slot', 'bars', 'med2', 'sum', 'p90', 'avoid'):
                if not same(a[k], b[k]):
                    diffs.append(f"{tb['pair']} {a['season']} slot {a['slot']} {k}: mine {a[k]}, the dump's {b[k]}")
            if a['bars'] and b['bars'] and abs(a['sum'] / a['bars'] - b['sum'] / b['bars']) > 1e-9:
                diffs.append(f"{tb['pair']} {a['season']} slot {a['slot']} mean differs")
    return diffs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--gmo', required=True)
    ap.add_argument('--dump', required=True)
    ap.add_argument('--also', action='append', default=[])
    ap.add_argument('--plant', default='')
    a = ap.parse_args()
    keys = keys_of(START, END, a.plant)
    mine = []
    bad = []
    for pair in PAIRS:
        tb, problems = table_of(a.gmo, pair, keys)
        for p in problems[:5]:
            print(f'  {p}')
        print(f"{pair}: day files {tb['keyMin']}..{tb['keyMax']} ({len(keys)}), bars {tb['tMin']}..{tb['tMax']} ({tb['bars']}), "
              f"left out {json.dumps(tb['dropped'])}, base2 {tb['base2']}, thr2 {tb['thr2']}")
        bad += checks_of(tb)
        mine.append(tb)
    for b in bad:
        print(f'CHECK FAILED {b}')
    if bad:
        print('PYTHON: stopped by its checks; nothing compared')
        sys.exit(3)
    diffs = compare(mine, a.dump)
    for d in diffs[:20]:
        print(f'  DIFFERS {d}')
    print(f'PYTHON vs {a.dump}: ' + ('every value the same' if not diffs else f'{len(diffs)} values differ'))
    code = 1 if diffs else 0
    for d in a.also:
        dd = compare(mine, d)
        print(f'PYTHON vs {d} (a planted error): ' + (f'{len(dd)} values differ (caught)' if dd else 'THE SAME (NOT CAUGHT)'))
        if not dd:
            code = 1
    sys.exit(code)


if __name__ == '__main__':
    main()
