#!/usr/bin/env python3
"""#392（docs §8.135）: research/analog.ts の数え直し（Python、同じ GMO のファイルから）。

足（Bid と Ask の合わせ方・週末 inside・期間）は、#371 で TypeScript と別に書かれた research/flowz-check.py の
関数（load_tf・keys_of・year_keys・round_chart・iso・ymd）を使う。中値は、始値・高値・安値・終値のそれぞれを
(Bid + Ask) / 2 にして、チャートと同じ桁（円の組 3、ほか 5）に丸める（emarm-check.py と同じ作り方）。

予測（似た相場の予測）は、research/analog-spec.md だけを読んで別に書いた research/analog-rule.py で計算する
（_shared/analog-forecast.ts・analog.ts は読まずに書いたもの）。ここで足すのは、spec の "The measurement" の
とおりの、アンカーの選び方、行の数字、向きが変わった足（flip）の追い方（動画の決め方、オーナーの持ち方:
指値・利確10 pips・損切りなし）、まとめの数、そして TypeScript の出力との比べ。

使い方:
  python3 -I research/analog-check.py --cache research/.cache --out research/out/analog
    期間（start・end・loadFrom）と決まりの数（params）は OUT/summary.json の meta から読む（params は spec の
    数 pattern 20・horizon 20・matches 10・window 1500・gap 20 と同じでなければ失敗）。
終了コード: 0 = 行・flip・まとめの数がすべて一致（最後の行 ANALOG-CHECK PASSED）、1 = 食い違いあり
（ANALOG-CHECK FAILED）。
"""
import argparse
import csv
import importlib.util
import json
import math
import os
import sys
import time

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, os.path.join(HERE, file))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


fc = load('flowz_check', 'flowz-check.py')
rule = load('analog_rule', 'analog-rule.py')

MIN = fc.MIN
HOUR = fc.HOUR
PAIRS = ['USD/JPY', 'EUR/JPY', 'AUD/JPY', 'EUR/USD', 'AUD/USD']
TFS = [('15min', '15min', 15 * MIN, 'day'), ('1h', '1hour', HOUR, 'day'), ('4h', '4hour', 4 * HOUR, 'year')]
SPEC_PARAMS = {'pattern': 20, 'horizon': 20, 'matches': 10, 'window': 1500, 'gap': 20}
RULE_PARAMS = {'pattern': rule.PATTERN, 'horizon': rule.HORIZON, 'matches': rule.MATCHES,
               'window': rule.WINDOW, 'gap': rule.GAP}
L, H, K, W, G = rule.PATTERN, rule.HORIZON, rule.MATCHES, rule.WINDOW, rule.GAP
OWNER_TP = 10
REL = 1e-9
SELF_SAMPLES = 24          # 1組（足の長さ×通貨）あたり、forecast_range を literal な forecast() と比べる数（＋最初と最後）
SHOW = 10                  # 種類ごとに出す食い違いの数

ROW_COLS = ['tf', 'pair', 'open', 'dir', 'places', 'midH', 'upH', 'loH', 'midSum', 'upSum', 'loSum', 'act', 'inside']
ROW_TEXT = {'tf', 'pair', 'open', 'places'}
FLIP_COLS = ['tf', 'pair', 'open', 'side', 'X', 'TP', 'SL', 'vRes', 'vExit', 'vPips', 'vBars', 'E', 'oTP', 'filled',
             'fillMode', 'F', 'sameBar', 'oRes', 'oExit', 'oPips', 'mae', 'oBars']
FLIP_TEXT = {'tf', 'pair', 'open', 'side', 'vRes', 'fillMode', 'oRes'}
# まとめの数のうち、比・平均・和（1e-9 の相対の差まで許す）。ほかは数（そのまま等しいこと）
LOOSE = {'hitRate', 'upShare', 'moveMean', 'errMidMean', 'errFlatMean', 'insideShare', 'winRate', 'perTrade',
         'avgWin', 'avgLoss', 'timeMean', 'heldSum'}


# ---------------------------------------------------------------- 食い違いの記録
class Diffs:
    def __init__(self):
        self.by_kind = {}
        self.total = 0

    def add(self, kind, msg):
        self.total += 1
        n = self.by_kind.get(kind, 0) + 1
        self.by_kind[kind] = n
        if n <= SHOW:
            print(f'DIFF [{kind}] {msg}')
        elif n == SHOW + 1:
            print(f'DIFF [{kind}] … (more of this kind are counted, not shown)')


def die(msg):
    print('ERROR: ' + msg)
    print('ANALOG-CHECK FAILED: 1 differences')
    sys.exit(1)


# ---------------------------------------------------------------- 数
def add_in_order(xs):
    s = 0
    for x in xs:
        s = s + x
    return s


def mean(xs):
    return add_in_order(xs) / len(xs) if xs else None


def quantile(xs, q):
    """並べた値の [max(0, ceil(q * n) - 1)]。なにもなければ None"""
    if not xs:
        return None
    s = sorted(xs)
    return s[max(0, math.ceil(q * len(s)) - 1)]


def ratio(a, b):
    return a / b if b else None


def first_index(mask, lo, hi):
    """lo <= k < hi で mask(k0, k1)[k - k0] が真になる最初の k（なければ None）。塊を大きくしながら探す"""
    size = 64
    k = lo
    while k < hi:
        e = min(hi, k + size)
        nz = np.flatnonzero(mask(k, e))
        if nz.size:
            return k + int(nz[0])
        k = e
        size *= 4
    return None


# ---------------------------------------------------------------- flip の追い方
def follow_video(d, a, X, TP, SL, o, h, l, c, pip):
    """動画の決め方: (vRes, vExit, vPips, vBars)。both と skipped は exit・pips・bars なし"""
    buy = d == 1
    if not ((SL < X < TP) if buy else (TP < X < SL)):
        return 'skipped', None, None, None
    for k in range(a + 1, a + H + 1):
        if k > a + 1:
            if (o[k] <= SL) if buy else (o[k] >= SL):
                return 'stop', o[k], d * (o[k] - X) / pip, k - (a + 1)
            if (o[k] >= TP) if buy else (o[k] <= TP):
                return 'tp', o[k], d * (o[k] - X) / pip, k - (a + 1)
        s = (l[k] <= SL) if buy else (h[k] >= SL)
        t = (h[k] >= TP) if buy else (l[k] <= TP)
        if s and t:
            return 'both', None, None, None
        if s:
            return 'stop', SL, d * (SL - X) / pip, k - (a + 1)
        if t:
            return 'tp', TP, d * (TP - X) / pip, k - (a + 1)
    x = c[a + H]
    return 'time', x, d * (x - X) / pip, (a + H) - (a + 1)


def follow_owner(d, a, o, h, l, c, O, Hh, Lw, pip):
    """オーナーの持ち方（指値 E = c[a]・利確 10 pips・損切りなし）。
    返り値: dict(E, oTP, filled, fillMode, F, sameBar, oRes, oExit, oPips, mae, oBars)。o・h・l・c は list、
    O・Hh・Lw は同じ値の numpy の並び（探すため）"""
    n = len(c)
    buy = d == 1
    E = c[a]
    TP = E + d * OWNER_TP * pip
    if buy:
        f = first_index(lambda k0, k1: (O[k0:k1] <= E) | (Lw[k0:k1] <= E), a + 1, n)
    else:
        f = first_index(lambda k0, k1: (O[k0:k1] >= E) | (Hh[k0:k1] >= E), a + 1, n)
    out = {'E': E, 'oTP': TP, 'filled': 0, 'fillMode': None, 'F': None, 'sameBar': 0, 'oRes': 'unfilled',
           'oExit': None, 'oPips': None, 'mae': None, 'oBars': None}
    if f is None:
        return out
    if (o[f] <= E) if buy else (o[f] >= E):
        mode, F, k0, same = 'open', o[f], f, 0
    else:
        mode, F, k0 = 'limit', E, f + 1
        same = 1 if ((h[f] >= TP) if buy else (l[f] <= TP)) else 0
    if buy:
        x = first_index(lambda q0, q1: (O[q0:q1] >= TP) | (Hh[q0:q1] >= TP), k0, n)
    else:
        x = first_index(lambda q0, q1: (O[q0:q1] <= TP) | (Lw[q0:q1] <= TP), k0, n)
    if x is None:
        res, eb, ex = 'held', n - 1, c[n - 1]
    else:
        res, eb = 'tp', x
        ex = o[x] if ((o[x] >= TP) if buy else (o[x] <= TP)) else TP
    # mae: max(0, dir * (F - adv) / pip) over f..eb。dir * (F - x) / pip は x について単調（丸めも単調）なので、
    # 買いは一番低い安値、売りは一番高い高値で、その最大になる（同じ double）
    adv = float(Lw[f:eb + 1].min()) if buy else float(Hh[f:eb + 1].max())
    worst = d * (F - adv) / pip
    out.update({'filled': 1, 'fillMode': mode, 'F': F, 'sameBar': same, 'oRes': res, 'oExit': ex,
                'oPips': d * (ex - F) / pip, 'mae': worst if worst > 0 else 0, 'oBars': eb - f})
    return out


# ---------------------------------------------------------------- まとめ
# アンカーの記録: (pair, year, has, dir, actSign, move, errMid, errFlat, inside)
# flip の記録: (pair, year, side, vRes, vPips, vBars, filled, oRes, oPips, mae, oBars, sameBar)
def group_stats(arecs, frecs):
    F = [r for r in arecs if r[2]]
    hit = sum(1 for r in F if r[3] != 0 and r[4] == r[3])
    miss = sum(1 for r in F if r[3] != 0 and r[4] == -r[3])
    act_up = sum(1 for r in F if r[4] == 1)
    act_down = sum(1 for r in F if r[4] == -1)
    v_dec = [r for r in frecs if r[3] in ('tp', 'stop', 'time')]
    v_tp = [r for r in frecs if r[3] == 'tp']
    v_st = [r for r in frecs if r[3] == 'stop']
    v_tm = [r for r in frecs if r[3] == 'time']
    o_f = [r for r in frecs if r[6] == 1]
    o_tp = [r for r in frecs if r[7] == 'tp']
    o_held = [r for r in frecs if r[7] == 'held']
    return {
        'anchors': len(arecs),
        'none': sum(1 for r in arecs if not r[2]),
        'dirUp': sum(1 for r in F if r[3] == 1),
        'dirDown': sum(1 for r in F if r[3] == -1),
        'dirFlat': sum(1 for r in F if r[3] == 0),
        'hit': hit,
        'miss': miss,
        'hitRate': ratio(hit, hit + miss),
        'actUp': act_up,
        'actDown': act_down,
        'upShare': ratio(act_up, act_up + act_down),
        'moveMean': mean([r[5] for r in F if r[3] != 0]),
        'errMidMean': mean([r[6] for r in F]),
        'errFlatMean': mean([r[7] for r in F]),
        'insideShare': ratio(add_in_order([r[8] for r in F]), H * len(F)),
        'allInside': sum(1 for r in F if r[8] == H),
        'flips': {
            'n': len(frecs),
            'buy': sum(1 for r in frecs if r[2] == 'BUY'),
            'sell': sum(1 for r in frecs if r[2] == 'SELL'),
            'video': {
                'tp': len(v_tp),
                'stop': len(v_st),
                'both': sum(1 for r in frecs if r[3] == 'both'),
                'time': len(v_tm),
                'skipped': sum(1 for r in frecs if r[3] == 'skipped'),
                'winRate': ratio(len(v_tp), len(v_tp) + len(v_st)),
                'perTrade': mean([r[4] for r in v_dec]),
                'avgWin': mean([r[4] for r in v_tp]),
                'avgLoss': mean([r[4] for r in v_st]),
                'timeMean': mean([r[4] for r in v_tm]),
                'barsMedian': quantile([r[5] for r in v_dec], 0.5),
            },
            'owner': {
                'filled': len(o_f),
                'unfilled': sum(1 for r in frecs if r[7] == 'unfilled'),
                'tp': len(o_tp),
                'held': len(o_held),
                'sameBar': sum(1 for r in o_f if r[11] == 1),
                'winRate': ratio(len(o_tp), len(o_f)),
                'perTrade': mean([r[8] for r in o_f]),
                'heldSum': add_in_order([r[8] for r in o_held]),
                'heldWorst': min(r[8] for r in o_held) if o_held else None,
                'maeMedian': quantile([r[9] for r in o_f], 0.5),
                'maeP90': quantile([r[9] for r in o_f], 0.9),
                'maeMax': max(r[9] for r in o_f) if o_f else None,
                'tpBarsMedian': quantile([r[10] for r in o_tp], 0.5),
                'tpBarsMax': max(r[10] for r in o_tp) if o_tp else None,
                'heldBarsMax': max(r[10] for r in o_held) if o_held else None,
            },
        },
    }


class Inexact:
    n = 0


def same_num(a, b, loose):
    if a is None or b is None:
        return a is None and b is None
    if isinstance(a, bool) or isinstance(b, bool) or not isinstance(a, (int, float)):
        return a == b
    if a == b:
        return True
    if loose and abs(a - b) <= REL * max(abs(a), abs(b)):
        Inexact.n += 1
        return True
    return False


def compare(path, ts, mine, diffs, key=None):
    """ts: TypeScript の summary の値、mine: ここで数えた値（key: いまの欄の名前）"""
    if isinstance(mine, dict):
        if not isinstance(ts, dict):
            diffs.add('summary', f'{path}: not an object in summary.json ({ts!r})')
            return
        for k in mine:
            if k not in ts:
                diffs.add('summary', f'{path}.{k}: missing in summary.json (here {mine[k]!r})')
                continue
            compare(f'{path}.{k}', ts[k], mine[k], diffs, k)
        for k in ts:
            if k not in mine:
                diffs.add('summary', f'{path}.{k}: in summary.json ({ts[k]!r}) but not in the spec')
        return
    if isinstance(mine, list):
        if not isinstance(ts, list) or len(ts) != len(mine):
            diffs.add('summary', f'{path}: {ts!r} != {mine!r}')
            return
        for i, (x, y) in enumerate(zip(ts, mine)):
            compare(f'{path}[{i}]', x, y, diffs, key)
        return
    if isinstance(mine, str):
        if ts != mine:
            diffs.add('summary', f'{path}: summary.json {ts!r} != here {mine!r}')
        return
    if not same_num(ts, mine, key in LOOSE):
        diffs.add('summary', f'{path}: summary.json {ts!r} != here {mine!r}')


# ---------------------------------------------------------------- TypeScript の CSV（順に読む）
class Stream:
    def __init__(self, path, header, diffs, kind):
        self.f = open(path, newline='')
        self.rd = csv.reader(self.f)
        got = next(self.rd, None)
        if got != header:
            diffs.add(kind, f'header {got!r} != {header!r}')
        self.buf = next(self.rd, None)

    def take(self, tf, pair):
        out = []
        while self.buf is not None and len(self.buf) >= 2 and self.buf[0] == tf and self.buf[1] == pair:
            out.append(self.buf)
            self.buf = next(self.rd, None)
        return out

    def rest(self):
        n = 0
        while self.buf is not None:
            n += 1
            self.buf = next(self.rd, None)
        self.f.close()
        return n


def cell_same(ts, mine, text):
    if mine is None:
        return ts == ''
    if text:
        return ts == mine
    if ts == '':
        return False
    try:
        x = float(ts)
    except ValueError:
        return False
    return x == mine


def compare_group(kind, tf, pair, cols, text, ts_rows, my_rows, diffs):
    """my_rows: 列の順の値の並び（None は空）。open の順と、行ごとの全部の列を比べる"""
    ts_by = {}
    for r in ts_rows:
        if len(r) != len(cols):
            diffs.add(kind, f'{tf} {pair}: a row with {len(r)} columns: {r!r}')
            continue
        ts_by[r[2]] = r
    mine_opens = [r[2] for r in my_rows]
    ts_opens = [r[2] for r in ts_rows]
    if mine_opens != ts_opens:
        ms, ts_ = set(mine_opens), set(ts_opens)
        only_mine = [x for x in mine_opens if x not in ts_]
        only_ts = [x for x in ts_opens if x not in ms]
        diffs.add(kind, f'{tf} {pair}: {len(ts_opens)} in the TS file, {len(mine_opens)} here; only here {len(only_mine)} '
                        f'{only_mine[:5]}, only in TS {len(only_ts)} {only_ts[:5]}'
                        + ('' if only_mine or only_ts else ' (same set, other order)'))
    for r in my_rows:
        t = ts_by.get(r[2])
        if t is None:
            continue
        for ci, name in enumerate(cols):
            if not cell_same(t[ci], r[ci], name in text):
                diffs.add(kind, f'{tf} {pair} {r[2]} {name}: TS {t[ci]!r} != here {r[ci]!r}')


def fmt_places(a, js):
    return ';'.join(str(a - int(j)) for j in js)


# ---------------------------------------------------------------- 1組（足の長さ × 通貨）
def run_pair(args, tf, interval, step, keyk, pair, start, end, load_from, ld, diffs):
    sym = pair.replace('/', '_')
    dec = 5 if pair.endswith('/USD') else 3
    pip = 0.01 if 'JPY' in pair else 0.0001
    keys = fc.keys_of(load_from, end) if keyk == 'day' else fc.year_keys(load_from, end)
    got = fc.load_tf(cache=args.cache, sym=sym, interval=interval, step=step, keys=keys,
                     from_ms=load_from, to_ms=end, ld=ld)
    t = [x[0] for x in got]
    o = [fc.round_chart((x[1][1] + x[2][1]) / 2, dec) for x in got]
    h = [fc.round_chart((x[1][2] + x[2][2]) / 2, dec) for x in got]
    l = [fc.round_chart((x[1][3] + x[2][3]) / 2, dec) for x in got]
    c = [fc.round_chart((x[1][4] + x[2][4]) / 2, dec) for x in got]
    n = len(t)
    O, Hh, Lw, C = (np.array(v, dtype=np.float64) for v in (o, h, l, c))

    # アンカー: a >= W - 1、t[a] + step >= START、a + H <= n - 1（t は昇順なので一続き）
    a_first = W - 1
    while a_first < n and t[a_first] + step < start:
        a_first += 1
    a_last = n - 1 - H
    anchors = list(range(a_first, a_last + 1)) if a_first <= a_last else []
    info = {'pair': pair, 'bars': n, 'first': fc.iso(t[0]) if n else None, 'last': fc.iso(t[-1]) if n else None,
            'anchors': len(anchors), 'firstAnchor': fc.iso(t[anchors[0]]) if anchors else None,
            'lastAnchor': fc.iso(t[anchors[-1]]) if anchors else None}
    rows, flips, arecs, frecs = [], [], [], []
    if not anchors:
        return info, rows, flips, arecs, frecs, 0
    lo_idx = max(W - 1, a_first - 1)        # flip のため、最初のアンカーの1本前も（あれば）
    R = rule.forecast_range(C, lo_idx, a_last)

    # 自分の確かめ: 速い計算（forecast_range）と、spec をそのまま書いた forecast（c[0..a] だけを渡す）
    picks = sorted(set([lo_idx, a_last] + [lo_idx + (a_last - lo_idx) * i // (SELF_SAMPLES + 1)
                                          for i in range(1, SELF_SAMPLES + 1)]))
    for a in picks:
        f = rule.forecast(C[:a + 1])
        i = a - lo_idx
        if f is None or not R['ok'][i]:
            same = f is None and not R['ok'][i]
        else:
            same = (f['start'] == R['start'][i] and [p['j'] for p in f['places']] == R['j'][i].tolist()
                    and [p['d'] for p in f['places']] == R['d'][i].tolist() and f['mid'] == R['mid'][i].tolist()
                    and f['up'] == R['up'][i].tolist() and f['lo'] == R['lo'][i].tolist() and f['dir'] == R['dir'][i])
        if not same:
            diffs.add('rule-self', f'{tf} {pair} a={a}: forecast_range and forecast() differ')

    A = np.array(anchors)
    I = A - lo_idx
    ok = R['ok'][I]
    mid, up, lo = R['mid'][I], R['up'][I], R['lo'][I]
    ca = C[A]
    act = C[A + H]
    msum = np.zeros(len(A))
    usum = np.zeros(len(A))
    lsum = np.zeros(len(A))
    inside = np.zeros(len(A), dtype=np.int64)
    for hh in range(1, H + 1):
        msum = msum + mid[:, hh]
        usum = usum + up[:, hh]
        lsum = lsum + lo[:, hh]
        x = C[A + hh]
        inside = inside + ((lo[:, hh] <= x) & (x <= up[:, hh]))
    dr = R['dir'][I]
    act_sign = np.where(act > ca, 1, np.where(act < ca, -1, 0))
    move = (dr.astype(np.float64) * (act - ca)) / pip
    err_mid = np.abs(act - mid[:, H]) / pip
    err_flat = np.abs(act - ca) / pip
    # 行
    okL, drL, asL = ok.tolist(), dr.tolist(), act_sign.tolist()
    mvL, emL, efL, inL = move.tolist(), err_mid.tolist(), err_flat.tolist(), inside.tolist()
    midH, upH, loH = mid[:, H].tolist(), up[:, H].tolist(), lo[:, H].tolist()
    msL, usL, lsL, actL = msum.tolist(), usum.tolist(), lsum.tolist(), act.tolist()
    Rok, Rdir = R['ok'].tolist(), R['dir'].tolist()
    for x, a in enumerate(anchors):
        year = fc.ymd(t[a] + step)[0]
        if not okL[x]:
            arecs.append((pair, year, False, None, None, None, None, None, None))
            continue
        d = drL[x]
        open_ = fc.iso(t[a])
        rows.append([tf, pair, open_, d, fmt_places(a, R['j'][a - lo_idx]), midH[x], upH[x], loH[x],
                     msL[x], usL[x], lsL[x], actL[x], inL[x]])
        arecs.append((pair, year, True, d, asL[x], mvL[x] if d != 0 else None, emL[x], efL[x], inL[x]))
        # flip: 1本前の予測があり（a - 1 >= W - 1、null でない）、その dir と違う
        if d == 0 or a - 1 < W - 1:
            continue
        p = a - 1 - lo_idx
        if not Rok[p] or Rdir[p] == d:
            continue
        side = 'BUY' if d == 1 else 'SELL'
        X = o[a + 1]
        TP = midH[x]
        SL = float(lo[x, 1:].min()) if d == 1 else float(up[x, 1:].max())
        vres, vexit, vpips, vbars = follow_video(d, a, X, TP, SL, o, h, l, c, pip)
        ow = follow_owner(d, a, o, h, l, c, O, Hh, Lw, pip)
        flips.append([tf, pair, open_, side, X, TP, SL, vres, vexit, vpips, vbars, ow['E'], ow['oTP'], ow['filled'],
                      ow['fillMode'], ow['F'], ow['sameBar'], ow['oRes'], ow['oExit'], ow['oPips'], ow['mae'],
                      ow['oBars']])
        frecs.append((pair, year, side, vres, vpips, vbars, ow['filled'], ow['oRes'], ow['oPips'], ow['mae'],
                      ow['oBars'], ow['sameBar']))
    return info, rows, flips, arecs, frecs, len(picks)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--cache', required=True)
    ap.add_argument('--out', required=True)
    args = ap.parse_args()
    t_all = time.time()
    summary = json.load(open(os.path.join(args.out, 'summary.json')))
    meta = summary['meta']
    if meta.get('params') != SPEC_PARAMS:
        die(f'params in summary.json differ from the spec: {meta.get("params")} != {SPEC_PARAMS}')
    if RULE_PARAMS != SPEC_PARAMS:
        die(f'analog-rule.py constants differ from the spec: {RULE_PARAMS} != {SPEC_PARAMS}')
    start, end, load_from = fc.ms_of(meta['start']), fc.ms_of(meta['end']), fc.ms_of(meta['loadFrom'])
    print(f'period: loadFrom {meta["loadFrom"]}, start {meta["start"]}, end {meta["end"]}; params {meta["params"]}')
    diffs = Diffs()
    if meta.get('tfs') != [x[0] for x in TFS]:
        diffs.add('summary', f'meta.tfs {meta.get("tfs")!r} != {[x[0] for x in TFS]!r}')
    if meta.get('pairs') != PAIRS:
        diffs.add('summary', f'meta.pairs {meta.get("pairs")!r} != {PAIRS!r}')
    ts_rows = Stream(os.path.join(args.out, 'rows.csv'), ROW_COLS, diffs, 'rows')
    ts_flips = Stream(os.path.join(args.out, 'flips.csv'), FLIP_COLS, diffs, 'flips')
    ld = fc.LoadStats()
    n_rows = n_flips = n_self = 0
    for tf, interval, step, keyk in TFS:
        pairs_info, tf_arecs, tf_frecs = [], [], []
        for pair in PAIRS:
            t0 = time.time()
            info, rows, flips, arecs, frecs, ns = run_pair(args, tf, interval, step, keyk, pair, start, end,
                                                           load_from, ld, diffs)
            pairs_info.append(info)
            tf_arecs.extend(arecs)
            tf_frecs.extend(frecs)
            tr = ts_rows.take(tf, pair)
            tfl = ts_flips.take(tf, pair)
            compare_group('rows', tf, pair, ROW_COLS, ROW_TEXT, tr, rows, diffs)
            compare_group('flips', tf, pair, FLIP_COLS, FLIP_TEXT, tfl, flips, diffs)
            n_rows += len(rows)
            n_flips += len(flips)
            n_self += ns
            print(f'{tf} {pair}: {info["bars"]} bars, {info["anchors"]} anchors, {len(rows)} rows '
                  f'(TS {len(tr)}), {len(flips)} flips (TS {len(tfl)}), {time.time() - t0:.1f}s', flush=True)
        ts_tf = summary.get('tfs', {}).get(tf)
        if ts_tf is None:
            diffs.add('summary', f'tfs.{tf}: missing in summary.json')
            continue
        years = sorted({r[1] for r in tf_arecs})
        mine = {
            'pairs': pairs_info,
            'all': group_stats(tf_arecs, tf_frecs),
            'byPair': {p: group_stats([r for r in tf_arecs if r[0] == p], [r for r in tf_frecs if r[0] == p])
                       for p in PAIRS},
            'byYear': {str(y): group_stats([r for r in tf_arecs if r[1] == y], [r for r in tf_frecs if r[1] == y])
                       for y in years},
        }
        compare(f'tfs.{tf}', ts_tf, mine, diffs)
    for k in summary.get('tfs', {}):
        if k not in [x[0] for x in TFS]:
            diffs.add('summary', f'tfs.{k}: in summary.json but not a timeframe of the spec')
    left_r, left_f = ts_rows.rest(), ts_flips.rest()
    if left_r:
        diffs.add('rows', f'{left_r} rows in rows.csv were not matched to a timeframe/pair here (order or names)')
    if left_f:
        diffs.add('flips', f'{left_f} rows in flips.csv were not matched to a timeframe/pair here (order or names)')
    ts_load = summary.get('load', {})
    print(f'files read here {ld.files}, failed {ld.failed} {ld.failed_ex}; summary.json load (not in the spec, '
          f'not compared): files {ts_load.get("files")}, failed {ts_load.get("failed")}')
    print(f'compared: rows {n_rows}, flips {n_flips}; forecast_range vs forecast() samples {n_self}; '
          f'summary numbers equal within 1e-9 but not bit-equal: {Inexact.n}; {time.time() - t_all:.0f}s')
    if diffs.total:
        print('differences by kind: ' + ', '.join(f'{k} {v}' for k, v in sorted(diffs.by_kind.items())))
        print(f'ANALOG-CHECK FAILED: {diffs.total} differences')
        sys.exit(1)
    print('ANALOG-CHECK PASSED')


if __name__ == '__main__':
    main()
