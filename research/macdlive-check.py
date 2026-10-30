#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""#388（docs §8.131）: research/macdlive.ts の数え直し（Python。標準ライブラリだけ。同じ GMO のファイルから）。

research/macdlive-spec.md の決まりで、1時間足の MACD のメールを2つの送り方で作り直す。
  close: 足が確定したときに、確定した600本の窓で決める（いまのメール。確定の0・3・5分後の読み込みのどれかが
         閉まりの中でなければ送る）。
  live : 作りかけの足を1分ごと（1〜59分）に、その分の値段（その前の1分足の Bid と Ask の終値の中値）を足の終値と
         して窓に入れて決め、決まりが出て、その分の1秒後が閉まりの中でない最初の分に送る。どの分でも送らなければ、
         確定の足を close と同じに決めて送る。1つの足に1通まで。
メールは1通ずつ、オーナーの持ち方（τ＋2分の E の指値・すでに良ければ成行・利確 E±10 pips・損切りなし）と、
メールの目安（損切り13・利確4）で追い、TypeScript の rows.csv の行（全部の列）と、summary.json の ways・live・
pairs の数を全部比べる（数え方は同じ数、和・平均・中央値・割合は同じか相対 1e-9 以内）。

足の読み込み（Bid と Ask の合わせ方・週末・中値の丸め）・1分足・メールの決まり（600本の窓の MACD・120本の枠・
95%の帯への入り）・1通の追い方・表の数は、#371 で TypeScript と別に書かれ、行と数がすべて一致した
research/flowz-check.py の関数を使う（load_tf・keys_of・round_chart・M1・zone_entry・is_possibly_closed・
follow・stats_of・median・add_in_order）。ここで書いたのは、live の1分ごとの決め方（窓の 0〜598 番の EMA と、
599 番の枠に入る 480〜598 番の最大・最小を足ごとに1回だけ計算し、分ごとには 599 番だけを足し直す速い形）、
メールの作り方と並べ方、2つの和（pipsSum・guidePipsSum）と live の数、比べ方。
速い形は、すべての足の確定の終値と、live で決まりが出たすべての分と、ほかの分の一部（SAMPLE_EVERY 分に1つ）で、
600本を組み直した zone_entry と比べ、1つでも違えば食い違いとして数える。

使い方:
  python3 -I research/macdlive-check.py --cache DIR --out OUT
    DIR: <DIR>/<USD_JPY など>/<1hour|1min>/<bid|ask>/<鍵>.json（GMO の形）
    OUT: research/macdlive.ts の出力（rows.csv と summary.json）。期間（start・end・loadFrom）は summary.json の
         meta から読む。
終了コード: 0 = 行と数がすべて一致（最後の行 MACDLIVE-CHECK PASSED）、1 = 食い違いあり、または入力の誤り
（最後の行 MACDLIVE-CHECK FAILED: n differences）。
"""
import argparse
import bisect
import csv
import importlib.util
import json
import math
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location('flowz_check', os.path.join(HERE, 'flowz-check.py'))
fc = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(fc)

MIN = fc.MIN
HOUR = fc.HOUR
WINDOW = fc.WINDOW               # 600
ZONE_BARS = fc.ZONE_BARS         # 120
ZONE_SHARE = fc.ZONE_SHARE       # 0.95
PAIRS = fc.PAIRS                 # 行の順（同じ τ はこの順）
READ_AFTER = fc.READ_AFTER       # 確定の 0・3・5 分後に読む
P_AFTER = fc.P_AFTER             # 指値は τ ＋ 2分
REL = fc.REL                     # 1e-9
WAYS = ('close', 'live')         # 同じ τ・同じ通貨は close が先
LIVE_MINUTES = range(1, 60)      # 作りかけの足を見る分 k（τ = 足の始まり ＋ k 分）
SAMPLE_EVERY = 499               # 決まりの出ない分も、この数に1つは600本を組み直して確かめる
MAX_DIFF_LINES = 40
A12, A26, A9 = 2 / (12 + 1), 2 / (26 + 1), 2 / (9 + 1)   # alpha = 2 / (n + 1)（1つの値として）
REAL = dict(start='2024-01-01T00:00:00Z', end='2026-10-29T21:00:00Z', loadFrom='2023-10-01T00:00:00Z')

COLS = ['way', 'pair', 'open', 'tau', 'side', 'E', 'early', 'minutes', 'gone', 'filled', 'market', 'fillT', 'fill',
        'tp', 'tpT', 'exit', 'endPx', 'pips', 'mae', 'hold', 'g_result', 'g_pips', 'g_both']
STR_COLS = {'way', 'pair', 'open', 'tau', 'side', 'fillT', 'tpT', 'g_result'}
FLAG_COLS = {'early', 'gone', 'filled', 'market', 'tp', 'g_both'}
NUM_COLS = {'E', 'minutes', 'fill', 'exit', 'endPx', 'pips', 'mae', 'hold', 'g_pips'}
STAT_KEYS = ['mails', 'filled', 'unfilled', 'tp', 'held', 'win', 'pipsSum', 'pipsMean', 'pipsMedian', 'maeMedian',
             'maeMax', 'holdMedian', 'holdMax', 'heldPipsSum', 'heldPipsMin', 'guideTp', 'guideSl', 'guideHeld',
             'guideBoth', 'guideWin', 'guidePipsSum', 'guidePipsMean']
LIVE_KEYS = ['early', 'gone', 'minutesMedian', 'minutesMax']
PAIR_KEYS = ['bars1h', 'judged']
# 同じ数でなければならないもの（数え方と、行の値そのもの）。ほか（和・平均・中央値・割合）は相対 1e-9 まで。
EXACT_KEYS = {'mails', 'filled', 'unfilled', 'tp', 'held', 'guideTp', 'guideSl', 'guideHeld', 'guideBoth', 'early',
              'gone', 'bars1h', 'judged', 'maeMax', 'holdMax', 'heldPipsMin', 'minutesMax'}


def die(msg):
    """入力の誤り: 理由を出し、食い違い1つとして失敗で終える（fc.die は最後の行が FLOWZ-CHECK なので使わない）"""
    print('ERROR: ' + msg)
    print('MACDLIVE-CHECK FAILED: 1 differences')
    sys.exit(1)


def mailed_at_close(T):
    """close の送り方: 確定の 0・3・5 分後（それぞれ1秒後）の読み込みのどれかが isPossiblyClosed でない"""
    return any(not fc.is_possibly_closed(T + m * MIN + 1000) for m in READ_AFTER)


# ---------------------------------------------------------------- live の速い決め方
def prep(base):
    """base: 窓の 0..598 番（確定した 599 本の終値）。fc.zone_entry と同じ順に EMA を進め、
    (598 番の ema12, ema26, signal, 480..598 番の線・シグナル・ヒストと 0 の最大, 同じく最小,
     inTop(598), inBottom(598)) を返す。599 番（作りかけの足）は decide でこれに1つ足すだけ。"""
    n = len(base)                      # WINDOW - 1
    last = n - 1                       # 598
    s = 0.0
    for k in range(12):
        s += base[k]
    fast = s / 12
    for k in range(12, 26):
        fast = A12 * base[k] + (1 - A12) * fast
    s = 0.0
    for k in range(26):
        s += base[k]
    slow = s / 26
    line = [0.0] * n
    line[25] = fast - slow
    for k in range(26, n):
        x = base[k]
        fast = A12 * x + (1 - A12) * fast
        slow = A26 * x + (1 - A26) * slow
        line[k] = fast - slow
    s = 0.0
    for k in range(25, 34):
        s += line[k]
    sig = s / 9
    sigs = [0.0] * n
    sigs[33] = sig
    for k in range(34, n):
        sig = A9 * line[k] + (1 - A9) * sig
        sigs[k] = sig
    # 599 番の枠（480..599）のうち、確定した 480..598 番の最大・最小（0 を含む）
    pre_top = 0.0
    pre_bot = 0.0
    for k in range(n + 1 - ZONE_BARS, n):
        lv, sv = line[k], sigs[k]
        for v in (lv, sv, lv - sv):
            if v > pre_top:
                pre_top = v
            if v < pre_bot:
                pre_bot = v
    # 598 番の枠（479..598）: 上に 479 番を足す
    top, bot = pre_top, pre_bot
    lv, sv = line[n - ZONE_BARS], sigs[n - ZONE_BARS]
    for v in (lv, sv, lv - sv):
        if v > top:
            top = v
        if v < bot:
            bot = v
    m = line[last]
    in_top = top > 0 and m >= ZONE_SHARE * top
    in_bot = bot < 0 and m <= ZONE_SHARE * bot
    return fast, slow, sig, pre_top, pre_bot, in_top, in_bot


def decide(p, x):
    """599 番の終値を x としたときの決まり。fc.zone_entry と同じ (side, m, top, bottom) か None。"""
    fast0, slow0, sig0, pre_top, pre_bot, in_top0, in_bot0 = p
    f = A12 * x + (1 - A12) * fast0
    s = A26 * x + (1 - A26) * slow0
    m = f - s
    g = A9 * m + (1 - A9) * sig0
    h = m - g
    top, bottom = pre_top, pre_bot
    for v in (m, g, h):
        if v > top:
            top = v
        if v < bottom:
            bottom = v
    if top > 0 and m >= ZONE_SHARE * top and not in_top0:
        return 'SELL', m, top, bottom
    if bottom < 0 and m <= ZONE_SHARE * bottom and not in_bot0:
        return 'BUY', m, top, bottom
    return None


# ---------------------------------------------------------------- メールを作る
def compute(cache, start, end, load_from, log):
    """2つの送り方のメールを作り、1通ずつ追う。(rows, pair_info, ld, chk) を返す。rows は並べた後の行。"""
    ld = fc.LoadStats()
    emails = []
    pair_info = []
    chk = dict(closes=0, liveSignals=0, sampled=0, minutes=0, noPrice=0, blocked=0, notMailed=0, mismatch=[])
    for pi, pair in enumerate(PAIRS):
        t_pair = time.time()
        sym = pair.replace('/', '_')
        dec = 5 if pair.endswith('/USD') else 3
        h1 = fc.load_tf(cache, sym, '1hour', HOUR, fc.keys_of(load_from, end), load_from, end, ld)
        t = [x[0] for x in h1]
        c = [fc.round_chart((x[1][4] + x[2][4]) / 2, dec) for x in h1]
        del h1
        m1 = fc.M1(pair, cache, start, end, ld)
        mt, mbc, mac, n1 = m1.t, m1.bc, m1.ac, m1.n
        mine = []
        judged = short = 0
        n_close = n_live = n_early = n_gone = 0

        def email(way, i, tau, side, E, early, gone):
            return dict(way=way, pair=pair, pi=pi, open=t[i], T=t[i] + HOUR, tau=tau, side=side, E=E,
                        early=early, minutes=(t[i] + HOUR - tau) // MIN, gone=gone)

        for i in range(len(t)):
            T = t[i] + HOUR
            if T < start or T >= end:
                continue
            if i + 1 < WINDOW:
                short += 1
                continue
            judged += 1
            base = c[i - WINDOW + 1:i]                 # 足 i−599 .. i−1（確定した終値）
            d_close = fc.zone_entry(base + [c[i]])     # close の決まり（600本の窓、flowz-check の関数）
            p = prep(base)
            chk['closes'] += 1
            f_close = decide(p, c[i])
            if f_close != d_close:
                chk['mismatch'].append(f'{pair} close of the bar opening {fc.iso(t[i])}: fast {f_close} / zone_entry {d_close}')
            sent = d_close is not None and mailed_at_close(T)
            if d_close is not None and not sent:
                chk['notMailed'] += 1
            if sent:
                mine.append(email('close', i, T, d_close[0], c[i], 0, 0))
                n_close += 1
            # live: 作りかけの足を1分ごとに
            live = None
            j = bisect.bisect_left(mt, t[i])
            for k in LIVE_MINUTES:
                tau = t[i] + k * MIN
                o = tau - MIN                          # τ の値段は、τ − 1分に始まる1分足の終値の中値
                while j < n1 and mt[j] < o:
                    j += 1
                if j >= n1 or mt[j] != o:
                    chk['noPrice'] += 1                # 値段の無い分は決めない
                    continue
                x = fc.round_chart((mbc[j] + mac[j]) / 2, dec)
                d = decide(p, x)
                chk['minutes'] += 1
                if d is not None or chk['minutes'] % SAMPLE_EVERY == 0:
                    z = fc.zone_entry(base + [x])      # 600本を組み直して確かめる
                    chk['liveSignals' if d is not None else 'sampled'] += 1
                    if d != z:
                        chk['mismatch'].append(f'{pair} minute {fc.iso(tau)} (price {x!r}): fast {d} / zone_entry {z}')
                if d is None:
                    continue
                if fc.is_possibly_closed(tau + 1000):
                    chk['blocked'] += 1                # 決まりは出たが、閉まりの中かもしれない分: 次の分へ
                    continue
                live = (d[0], tau, x)
                break
            if live is not None:
                mine.append(email('live', i, live[1], live[0], live[2], 1, int(d_close is None)))
                n_live += 1
                n_early += 1
                n_gone += int(d_close is None)
            elif sent:
                mine.append(email('live', i, T, d_close[0], c[i], 0, 0))   # どの分でも送らず、確定で送る
                n_live += 1
        for e in mine:
            e['path'] = fc.follow(m1, e['tau'] + P_AFTER, 1 if e['side'] == 'BUY' else -1, e['E'], end)
        n_m1 = m1.n
        del m1
        emails.extend(mine)
        pair_info.append(dict(pair=pair, bars1h=len(t), judged=judged))
        log(f'  {pair}: 1h bars {len(t)}, judged {judged} (short of 600: {short}), 1-min bars {n_m1}; '
            f'close emails {n_close}; live emails {n_live} (early {n_early}, gone {n_gone}, at the close '
            f'{n_live - n_early}) ({time.time() - t_pair:.1f}s)')
    order = {w: k for k, w in enumerate(WAYS)}
    emails.sort(key=lambda e: (e['tau'], e['pi'], order[e['way']]))
    return [row_of(e) for e in emails], pair_info, ld, chk


def row_of(e):
    """rows.csv の1行（flowz.ts csvOf と同じ: fillT・fill は約定のとき、tpT・exit は利確のとき、endPx は END まで
    持ったとき、pips・mae・hold・g_* は約定のときだけ。None は空）"""
    p = e['path']
    f = p['filled']
    return dict(way=e['way'], pair=e['pair'], open=fc.iso(e['open']), tau=fc.iso(e['tau']), side=e['side'], E=e['E'],
                early=e['early'], minutes=e['minutes'], gone=e['gone'],
                filled=int(f), market=p['market'], fillT=fc.iso(p['t0']) if f else None, fill=p['fill'] if f else None,
                tp=p['tp'] if f else 0, tpT=fc.iso(p['tpT']) if f and p['tp'] else None,
                exit=p['exit'] if f and p['tp'] else None, endPx=p['endPx'] if f and not p['tp'] else None,
                pips=p['pips'] if f else None, mae=p['mae'] if f else None, hold=p['hold'] if f else None,
                g_result=p['g_result'] if f else None, g_pips=p['g_pips'] if f else None,
                g_both=p['g_both'] if f else None)


# ---------------------------------------------------------------- 数
def stats_of(rows):
    """flowz-lib.ts statsOf（fc.stats_of）に、2つの和（約定した行の pips・目安の pips を行の順に足す。無ければ 0）"""
    s = fc.stats_of(rows)
    fl = [r for r in rows if r['filled']]
    s['pipsSum'] = fc.add_in_order([r['pips'] for r in fl])
    s['guidePipsSum'] = fc.add_in_order([r['g_pips'] for r in fl])
    return s


def live_of(rows):
    lv = [r for r in rows if r['way'] == 'live']
    er = [r for r in lv if r['early']]
    mins = [r['minutes'] for r in er]
    return dict(early=len(er), gone=sum(1 for r in lv if r['gone']), minutesMedian=fc.median(mins),
                minutesMax=max(mins) if mins else None)


def summary_of(rows, pair_info):
    ways = {}
    for way in WAYS:
        wr = [r for r in rows if r['way'] == way]
        ways[way] = {'all': stats_of(wr)}
        for p in PAIRS:
            ways[way][p] = stats_of([r for r in wr if r['pair'] == p])
    live = live_of(rows)
    live_pairs = {p: live_of([r for r in rows if r['pair'] == p]) for p in PAIRS}
    return dict(ways=ways, live=live, livePairs=live_pairs, pairs=pair_info)


# ---------------------------------------------------------------- 比べる
class Cmp:
    def __init__(self):
        self.n = 0
        self.fields = 0
        self.near = 0
        self.near_max = 0.0

    def bad(self, msg):
        self.n += 1
        if self.n <= MAX_DIFF_LINES:
            print('DIFF ' + msg)

    def num(self, where, mine, theirs, exact):
        """数: None は null と同じ。exact でなければ相対 1e-9 まで同じとみる。"""
        self.fields += 1
        if mine is None or theirs is None:
            if not (mine is None and theirs is None):
                self.bad(f'{where}: TS {theirs!r} / Python {mine!r}')
            return
        if isinstance(theirs, bool) or not isinstance(theirs, (int, float)):
            self.bad(f'{where}: TS {theirs!r} (not a number) / Python {mine!r}')
            return
        a, b = float(mine), float(theirs)
        if a == b:
            return
        if not exact and math.isfinite(a) and math.isfinite(b) and abs(a - b) <= REL * max(abs(a), abs(b)):
            self.near += 1
            self.near_max = max(self.near_max, abs(a - b) / max(abs(a), abs(b)))
            return
        self.bad(f'{where}: TS {theirs!r} / Python {mine!r}')


def compare_rows(C, mine, head, theirs):
    if head != COLS:
        C.bad(f'rows.csv header: TS {",".join(head)} / expected {",".join(COLS)}')
    if len(theirs) != len(mine):
        C.bad(f'rows: TS {len(theirs)}, Python {len(mine)}')

    def key(r):
        return (r.get('way'), r.get('pair'), r.get('open'))
    tk = {}
    for r in theirs:
        if key(r) in tk:
            C.bad(f'rows.csv: the bar {key(r)} has two rows')
        tk[key(r)] = r
    mk = {key(r): r for r in mine}
    for k in mk:
        if k not in tk:
            C.bad(f'row {k}: in Python ({mk[k]["tau"]} {mk[k]["side"]}), missing in rows.csv')
    for k in tk:
        if k not in mk:
            C.bad(f'row {k}: in rows.csv ({tk[k].get("tau")} {tk[k].get("side")}), missing in Python')
    a = [key(r) for r in mine if key(r) in tk]
    b = [key(r) for r in theirs if key(r) in mk]
    if a != b:
        at = next((q for q in range(min(len(a), len(b))) if a[q] != b[q]), min(len(a), len(b)))
        C.bad(f'row order: from the shared row {at} on, Python {a[at] if at < len(a) else None} / '
              f'TS {b[at] if at < len(b) else None}')
    for r in mine:
        t = tk.get(key(r))
        if t is None:
            continue
        where = f'row {r["way"]} {r["pair"]} open={r["open"]}'
        for col in COLS:
            v = r[col]
            s = t.get(col)
            s = '' if s is None else s
            C.fields += 1
            if col in NUM_COLS:
                if v is None:
                    ok = s == ''
                else:
                    try:
                        ok = s != '' and float(s) == v
                    except ValueError:
                        ok = False
            elif col in FLAG_COLS:
                ok = s == ('' if v is None else str(int(v)))
            else:
                ok = s == ('' if v is None else str(v))
            if not ok:
                C.bad(f'{where} {col}: TS {s!r} / Python {v!r}')


def compare_obj(C, where, mine, theirs, keys):
    if not isinstance(theirs, dict):
        C.bad(f'{where}: missing in summary.json')
        return []
    for k in keys:
        if k not in theirs:
            C.bad(f'{where}.{k}: missing in summary.json')
            continue
        C.num(f'{where}.{k}', mine[k], theirs[k], k in EXACT_KEYS)
    return [f'{where}.{k}' for k in theirs if k not in keys]


def pick(obj, pair):
    """通貨の鍵（'USD/JPY'、無ければ 'USD_JPY'）"""
    if not isinstance(obj, dict):
        return None
    return obj.get(pair, obj.get(pair.replace('/', '_')))


def compare_summary(C, mine, S):
    skipped = []
    ways = S.get('ways')
    for way in WAYS:
        tw = ways.get(way) if isinstance(ways, dict) else None
        if not isinstance(tw, dict):
            C.bad(f'ways.{way}: missing in summary.json')
            continue
        skipped += compare_obj(C, f'ways.{way}.all', mine['ways'][way]['all'], tw.get('all'), STAT_KEYS)
        for p in PAIRS:
            skipped += compare_obj(C, f'ways.{way}.{p}', mine['ways'][way][p], pick(tw, p), STAT_KEYS)
    lv = S.get('live')
    if isinstance(lv, dict) and 'early' not in lv and 'all' in lv:
        # 通貨ごとにも分けて書いてある形
        skipped += compare_obj(C, 'live.all', mine['live'], lv.get('all'), LIVE_KEYS)
        for p in PAIRS:
            if pick(lv, p) is not None:
                skipped += compare_obj(C, f'live.{p}', mine['livePairs'][p], pick(lv, p), LIVE_KEYS)
    else:
        skipped += compare_obj(C, 'live', mine['live'], lv, LIVE_KEYS)
    tp = S.get('pairs')
    if isinstance(tp, list):
        tp = {x.get('pair'): x for x in tp if isinstance(x, dict)}
    for info in mine['pairs']:
        skipped += compare_obj(C, f'pairs.{info["pair"]}', info, pick(tp, info['pair']), PAIR_KEYS)
    return [k for k in skipped if not k.endswith('.pair')]


# ---------------------------------------------------------------- 全体
def main():
    ap = argparse.ArgumentParser(description='docs §8.131 (#388) の独立した計算し直し')
    ap.add_argument('--cache', required=True)
    ap.add_argument('--out', required=True)
    a = ap.parse_args()
    t_all = time.time()
    try:
        with open(os.path.join(a.out, 'summary.json'), encoding='utf-8') as f:
            S = json.load(f)
        meta = S['meta']
        start, end, load_from = (fc.ms_of(meta[k]) for k in ('start', 'end', 'loadFrom'))
    except Exception as e:  # noqa: BLE001
        die(f'summary.json meta: {e!r}')
    try:
        with open(os.path.join(a.out, 'rows.csv'), newline='', encoding='utf-8') as f:
            rd = csv.DictReader(f)
            head = list(rd.fieldnames or [])
            ts_rows = list(rd)
    except Exception as e:  # noqa: BLE001
        die(f'rows.csv: {e!r}')
    if not os.path.isdir(a.cache):
        die(f'no cache folder {a.cache}')
    print(f'macdlive-check (docs §8.131): bars closing in [{fc.iso(start)}, {fc.iso(end)}), 1h bars from '
          f'{fc.iso(load_from)}')
    if all(fc.ms_of(REAL[k]) == fc.ms_of(meta[k]) for k in REAL):
        print('  the period is the spec\'s (START 2024-01-01, END 2026-10-29T21:00Z, bars from 2023-10-01)')
    else:
        print('  the period is NOT the spec\'s real one (a test run)')

    rows, pair_info, ld, chk = compute(a.cache, start, end, load_from, print)
    mine = summary_of(rows, pair_info)
    for way in WAYS:
        s = mine['ways'][way]['all']
        print(f'  {way}: emails {s["mails"]}, filled {s["filled"]}, unfilled {s["unfilled"]}, TP {s["tp"]}, held at END '
              f'{s["held"]} (pips {s["heldPipsSum"]!r}, worst {s["heldPipsMin"]!r}), TP/filled {s["win"]!r}%, pips summed '
              f'{s["pipsSum"]!r} (mean {s["pipsMean"]!r}, median {s["pipsMedian"]!r}); guide TP {s["guideTp"]}, '
              f'stop {s["guideSl"]}, held {s["guideHeld"]}, both {s["guideBoth"]}, pips summed {s["guidePipsSum"]!r}')
    lv = mine['live']
    print(f'  live: early {lv["early"]}, gone {lv["gone"]}, minutes early median {lv["minutesMedian"]!r}, '
          f'max {lv["minutesMax"]!r}')
    print(f'  files read {ld.files}, failed {ld.failed}; 1-min bars left out: one side {ld.one_side}, crossed '
          f'{ld.crossed}, closure {ld.closure}, repeated {ld.repeated}')
    if ld.failed:
        print('  files not read: ' + '; '.join(ld.failed_ex))
    print(f'  signals at a close not mailed (closure) {chk["notMailed"]}; live minutes judged {chk["minutes"]}, without '
          f'a price {chk["noPrice"]}, with a signal in a possibly closed minute (skipped) {chk["blocked"]}')
    print(f'  the fast live decision against zone_entry on a rebuilt 600-close window: closes of every judged bar '
          f'{chk["closes"]}, minutes with a signal {chk["liveSignals"]}, other minutes sampled {chk["sampled"]}; '
          f'mismatches {len(chk["mismatch"])}')

    C = Cmp()
    for m in chk['mismatch']:
        C.bad('fast decision: ' + m)
    compare_rows(C, rows, head, ts_rows)
    skipped = compare_summary(C, mine, S)
    print(f'compared {C.fields} fields: {C.near} equal only within {REL:g} relative (largest {C.near_max:.3g}), '
          f'{C.n} different')
    if skipped:
        print('in summary.json, not compared: ' + ', '.join(skipped[:20]) + (' ...' if len(skipped) > 20 else ''))
    print(f'({time.time() - t_all:.1f}s)')
    if C.n:
        print(f'MACDLIVE-CHECK FAILED: {C.n} differences')
        sys.exit(1)
    print(f'rows {len(rows)} and every number the same')
    print('MACDLIVE-CHECK PASSED')
    sys.exit(0)


if __name__ == '__main__':
    main()
