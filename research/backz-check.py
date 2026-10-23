#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
backz-check.py — docs/OPERATIONS.md §8.126 の独立した計算し直し（Python。標準ライブラリだけ）。

research/backz.py と .github/workflows/backz.yml は読まずに、§8.126 と、そこが指す §8.124（メール・期間・
オーナーの持ち方・含み損の最大の測り方）と §8.122（95% の決まり）だけから書いた。

使ったもの（research/flowz-check.py を importlib で読み込み、変えずに使う。§8.124 で TypeScript と実データの
39,472 個の値が一致した、メールと1通ずつの取引の計算）:
  - compute（GMO のファイルの読み込み〈load_tf・M1・LoadStats〉、メールの決まり〈zone_entry。帯の割合は
    モジュールの ZONE_SHARE を読むので、v6 は 95/100、v4 は 90/100 にして呼ぶ〉、メールの順〈T、同じ T は
    PAIRS の順〉、1通ずつの follow〈P＝T＋2分の指値・すでに良ければ成行・利確 E±10・損切りなし・楽天の停止の
    足は約定と利確を判定しない・含み損の最大 mae〉）
  - M1 の1分足の並び（t・ah・bl・unit）、median、add_in_order、mean_in_order、iso、ms_of、PAIRS、MIN、DAY、REL、
    Cmp（数の比べ方: 完全に同じか相対 1e-9 以内）、stop_start（τ_X が楽天の停止の足かを数えて出すだけ）
compute の中で follow を呼ぶ所だけ、follow を包んだ関数に差し替える（follow の答えは変えず、生きている
1分足から τ_X を足すため）。

この節（§8.126）から、ここで書いたもの:
  - 含み損（約定の1分足〈P に足が無い時は P の後の最初の足〉から、利確の足〈利確しないものは END までの最後の
    足〉まで、楽天の停止の足も入れて、売りは〈Ask の高値 − 約定値〉/ pip、買いは〈約定値 − Bid の安値〉/ pip。
    follow の mae と同じ式・同じ範囲）が初めて X pips 以上になる1分足 τ_X（塊ごとの最大で飛ばして探す）。
    §8.126 の「読み方の細部」1: ちょうど X pips は「X 以上」に入れる。この式の倍精度の値が X − 1e-9 以上なら
    届いたと数える（例: 約定 1.08424、Ask の高値 1.08924 → 49.999999999998934 は 50 に届いた）。
    G_X ＝ mae ≧ X − 1e-9 の取引と同じになる（自分の中で確かめる）。
  - 組 G_X と、出す数のすべて（元の数、G_X・戻った・まだ持っている、日数の中央値・最大・分布、損益、含み損の
    最大、売り買い・ペアごと、まだ持っているもの1つずつ）と、ファイルとの比べ（数・文字は完全に同じ、小数は
    相対 1e-9 以内、計算し直していない鍵も食い違いとして数える）

使い方:
  python3 research/backz-check.py --cache DIR --summary out.json [--write mine.json]
    DIR: <DIR>/<USD_JPY など>/<1min|1hour|4hour>/<bid|ask>/<鍵>.json（GMO の形）
    期間（start・end・loadFrom）と X（xs）は out.json の meta から読む。
終了コード: 0 = 全部一致（最後の行 BACKZ-CHECK PASSED）、1 = 食い違いあり、または入力の誤り
（最後の行 BACKZ-CHECK FAILED: n differences）。
"""
import argparse
import bisect
import importlib.util
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))


def _load_flowz_check():
    path = os.path.join(HERE, 'flowz-check.py')
    spec = importlib.util.spec_from_file_location('flowz_check', path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


fc = _load_flowz_check()
MIN, DAY = fc.MIN, fc.DAY
PAIRS = fc.PAIRS
SIDES = ('SELL', 'BUY')
RULES = (('v6', 95 / 100), ('v4', 90 / 100))     # §8.126: v6 は 95%、v4 は同じ決まりの 90%
SPEC_XS = [50, 60]                               # §8.126: X＝50 と 60 pips
DIST = (('d1', 1), ('d7', 7), ('d30', 30), ('d90', 90))   # 「以内」は端を含む
REAL = dict(start='2024-01-01T00:00:00Z', end='2026-10-17T00:00:00Z', loadFrom='2023-10-01T00:00:00Z')
META_KEYS = ('start', 'end', 'loadFrom', 'xs')
BLK = 512
TIE = 1e-9                                       # 読み方の細部 1: 差 ≧ X − 1e-9 を X 以上とする
ORIG_FOLLOW = fc.follow
ORIG_SHARE = fc.ZONE_SHARE


def die(msg):
    print('ERROR: ' + msg)
    print('BACKZ-CHECK FAILED: 1 differences')
    sys.exit(1)


# ---------------------------------------------------------------- τ_X
def _blocks(pr):
    """1分足の Ask の高値の塊ごとの最大と、Bid の安値の塊ごとの最小（楽天の停止の足も入れる）"""
    bk = getattr(pr, '_backz_blocks', None)
    if bk is None:
        ah, bl, n = pr.ah, pr.bl, pr.n
        bk = ([max(ah[i:i + BLK]) for i in range(0, n, BLK)], [min(bl[i:i + BLK]) for i in range(0, n, BLK)])
        pr._backz_blocks = bk
    return bk


def first_reach(pr, dirn, fill, lo, hi, x):
    """lo..hi（両端を含む）の1分足のうち、含み損（pips）が初めて x 以上になる足の番号。無ければ −1。
    含み損: 売り（dirn −1）は (Ask の高値 − 約定値) / unit、買い（dirn ＋1）は (約定値 − Bid の安値) / unit。
    引き算と割り算は単調なので、塊の最大（売り）・最小（買い）で届かなければ、その塊のどの足も届かない。"""
    unit = pr.unit
    hiB, loB = _blocks(pr)
    vals, blk = (pr.ah, hiB) if dirn < 0 else (pr.bl, loB)
    i = lo
    while i <= hi:
        j = i // BLK
        bend = min((j + 1) * BLK, hi + 1)
        if i == j * BLK and bend == min((j + 1) * BLK, pr.n):
            v = blk[j]
            if ((v - fill) / unit if dirn < 0 else (fill - v) / unit) < x:
                i = bend
                continue
        if dirn < 0:
            for k in range(i, bend):
                if (vals[k] - fill) / unit >= x:
                    return k
        else:
            for k in range(i, bend):
                if (fill - vals[k]) / unit >= x:
                    return k
        i = bend
    return -1


def make_follow(xs, notes):
    """flowz-check の follow をそのまま呼び、入った取引に τ_X（1分足の始まりの時刻 ms、無ければ None）を足す"""
    def follow_tau(pr, P0, dirn, E, end):
        r = ORIG_FOLLOW(pr, P0, dirn, E, end)
        r['tau'] = {}
        r['tauStop'] = {}
        if not r['filled']:
            return r
        # 見る範囲: 約定の足（P に足が無い成行は、P の後の最初の足）から、利確の足（利確しないものは最後の足）まで
        lo = bisect.bisect_left(pr.t, r['t0'])
        hi = r['tpK'] if r['tp'] else pr.n - 1
        if not (lo < pr.n and pr.t[lo] == r['t0']):
            notes['noBarFill'] += 1
        for x in xs:
            k = first_reach(pr, dirn, r['fill'], lo, hi, x - TIE) if lo <= hi else -1
            # 数えるだけ: ちょうど X の足を届いたと数えない読み（差 ≧ X）なら τ_X が違ったか
            k_strict = first_reach(pr, dirn, r['fill'], lo, hi, x) if lo <= hi else -1
            if k_strict != k:
                notes['tieMoved'][x] = notes['tieMoved'].get(x, 0) + 1
            r['tau'][x] = pr.t[k] if k >= 0 else None
            # 数えるだけ: τ_X が楽天の停止の中の足か
            r['tauStop'][x] = bool(k >= 0 and fc.stop_start(pr.t[k]) is not None)
            if k >= 0:
                if k == lo:
                    notes['tauAtFillBar'] += 1
                if r['tp'] and k == hi:
                    notes['tauAtTpBar'] += 1
        return r
    return follow_tau


# ---------------------------------------------------------------- 1つの決まりの計算
def run_rule(cache, start, end, load_from, share, xs, log):
    notes = dict(noBarFill=0, tauAtFillBar=0, tauAtTpBar=0, tieMoved={})
    fc.ZONE_SHARE = share
    fc.follow = make_follow(xs, notes)
    try:
        emails, pair_info, ld, extra = fc.compute(cache, start, end, end, load_from, log)
    finally:
        fc.follow = ORIG_FOLLOW
        fc.ZONE_SHARE = ORIG_SHARE
    return emails, ld, notes


def mm(xs):
    return dict(median=fc.median(xs), max=max(xs) if xs else None)


def rule_summary(emails, ld, share, xs, internal):
    """§8.126 の「出す数」。emails は compute の順（メールの時刻、同じ時刻は PAIRS の順）。"""
    fl = [e for e in emails if e.path['filled']]
    ntp = sum(1 for e in fl if e.path['tp'])
    base = dict(mails=len(emails), filled=len(fl), unfilled=len(emails) - len(fl), tp=ntp, held=len(fl) - ntp)
    out_x = {}
    edge = {}
    stop_tau = {}
    for x in xs:
        for e in fl:
            in_g = e.path['tau'][x] is not None
            if in_g != (e.path['mae'] >= x - TIE):  # 自分の中の確かめ（follow の mae と τ_X の有無）
                internal.append(f'{e.pair} {fc.iso(e.T)} X={x}: tau {e.path["tau"][x]} but mae {e.path["mae"]!r}')
        g = [e for e in fl if e.path['tau'][x] is not None]
        back = [e for e in g if e.path['tp']]
        held = [e for e in g if not e.path['tp']]
        back_ms = [e.path['tpT'] + MIN - e.path['tau'][x] for e in back]     # τ_X の足の始まり → 利確の足の終わり
        back_days = [d / DAY for d in back_ms]
        to_tau = [(e.path['tau'][x] - e.path['t0']) / DAY for e in back]     # 約定の足の始まり → τ_X の足の始まり
        held_pips = [e.path['pips'] for e in held]
        dist = {}
        for name, d in DIST:
            dist[name] = sum(1 for v in back_ms if v <= d * DAY)
        dist['longer'] = sum(1 for v in back_ms if v > 90 * DAY)
        edge[x] = sum(1 for v in back_ms if v in (DAY, 7 * DAY, 30 * DAY, 90 * DAY))
        stop_tau[x] = sum(1 for e in g if e.path['tauStop'][x])
        out_x[str(x)] = {
            'n': len(g),
            'back': len(back),
            'held': len(held),
            'heldPipsSum': fc.add_in_order(held_pips),
            'heldPipsMin': min(held_pips) if held_pips else None,
            'backDays': mm(back_days),
            'backDist': dist,
            'toTauDays': mm(to_tau),
            'backPipsMean': fc.mean_in_order([e.path['pips'] for e in back]),
            'mae': {'all': mm([e.path['mae'] for e in g]), 'back': mm([e.path['mae'] for e in back]),
                    'held': mm([e.path['mae'] for e in held])},
            'bySide': {s: {'n': sum(1 for e in g if e.side == s), 'back': sum(1 for e in back if e.side == s)}
                       for s in SIDES},
            'byPair': {p: {'n': sum(1 for e in g if e.pair == p), 'back': sum(1 for e in back if e.pair == p)}
                       for p in PAIRS},
            'heldList': [dict(pair=e.pair, side=e.side, T=fc.iso(e.T), tau=fc.iso(e.path['tau'][x]),
                              pips=e.path['pips'], mae=e.path['mae']) for e in held],
        }
    return dict(share=share, base=base, x=out_x, load=dict(files=ld.files, failed=ld.failed)), edge, stop_tau


# ---------------------------------------------------------------- 比べる
class Diff(fc.Cmp):
    def bad(self, where, what, mine, theirs):
        self.n += 1
        self.by[what] = self.by.get(what, 0) + 1
        if len(self.examples) < 30:
            self.examples.append(f'{where} [{what}]: mine {mine!r} / file {theirs!r}')

    def integer(self, where, mine, theirs):
        """数え（整数）: 完全に同じで、ファイルの方も整数"""
        self.fields += 1
        if type(theirs) is int and theirs == mine:
            self.exact += 1
        else:
            self.bad(where, 'integer', mine, theirs)

    def real(self, where, mine, theirs):
        """小数: 完全に同じか相対 1e-9 以内（fc.Cmp.num）。ファイルの方が数でなければ食い違い。"""
        if theirs is not None and (type(theirs) is bool or not isinstance(theirs, (int, float))):
            self.fields += 1
            self.bad(where, 'number', mine, theirs)
            return
        self.num(where, 'number', mine, theirs)


def compare(D, where, mine, theirs):
    if isinstance(mine, dict):
        if not isinstance(theirs, dict):
            D.fields += 1
            D.bad(where, 'object', 'object', theirs)
            return
        for k, v in mine.items():
            if k not in theirs:
                D.fields += 1
                D.bad(f'{where}.{k}', 'key', 'present', 'missing in the file')
            else:
                compare(D, f'{where}.{k}', v, theirs[k])
        for k in theirs:
            if k not in mine:
                D.fields += 1
                D.bad(f'{where}.{k}', 'key not recomputed', None, theirs[k])
        return
    if isinstance(mine, list):
        if not isinstance(theirs, list):
            D.fields += 1
            D.bad(where, 'list', f'list of {len(mine)}', theirs)
            return
        if len(mine) != len(theirs):
            D.fields += 1
            D.bad(where, 'list length', len(mine), len(theirs))

            def key(r):
                return (r.get('pair'), r.get('T')) if isinstance(r, dict) else repr(r)
            tk = {key(r): r for r in theirs}
            mk = {key(r): r for r in mine}
            for k in mk:
                if k not in tk:
                    D.fields += 1
                    D.bad(where, 'list item', k, 'missing in the file')
            for k in tk:
                if k not in mk:
                    D.fields += 1
                    D.bad(where, 'list item', 'missing in mine', k)
            for k in mk:
                if k in tk:
                    compare(D, f'{where}{list(k) if isinstance(k, tuple) else k}', mk[k], tk[k])
            return
        for i, (a, b) in enumerate(zip(mine, theirs)):
            compare(D, f'{where}[{i}]', a, b)
        return
    if isinstance(mine, str):
        D.same(where, 'string', mine, theirs)
        return
    if isinstance(mine, bool):
        D.same(where, 'bool', mine, theirs)
        return
    if isinstance(mine, int):
        D.integer(where, mine, theirs)
        return
    D.real(where, mine, theirs)      # 小数と None（null）


# ---------------------------------------------------------------- 全体
def main():
    ap = argparse.ArgumentParser(description='docs §8.126 の独立した計算し直し')
    ap.add_argument('--cache', required=True)
    ap.add_argument('--summary', required=True)
    ap.add_argument('--write', help='ここで計算した数を JSON に書く（確かめ用）')
    a = ap.parse_args()
    t_all = time.time()
    try:
        with open(a.summary, encoding='utf-8') as f:
            S = json.load(f)
        meta = S['meta']
        start, end, load_from = (fc.ms_of(meta[k]) for k in ('start', 'end', 'loadFrom'))
        xs = meta['xs']
        if not isinstance(xs, list) or not xs or any(type(x) is not int for x in xs):
            raise ValueError(f'meta.xs {xs!r}')
    except Exception as e:  # noqa: BLE001
        die(f'out.json meta: {e!r}')
    if not os.path.isdir(a.cache):
        die(f'no cache folder {a.cache}')
    print(f'backz-check (docs §8.126): email time T in [{fc.iso(start)}, {fc.iso(end)}), 1-hour bars from '
          f'{fc.iso(load_from)}, 1-min bars from {fc.iso(start)}; X = {xs}')
    if all(fc.ms_of(REAL[k]) == fc.ms_of(meta[k]) for k in REAL):
        print("  the period is §8.126's (= §8.124's: START 2024-01-01, END 2026-10-17, 1-hour bars from 2023-10-01)")
    else:
        print("  the period is NOT §8.126's real one (a test run)")
    D = Diff()
    # meta は入力。§8.126 の X（50・60）と、知らない鍵が無いことだけを確かめる
    D.same('meta.xs', 'spec X', SPEC_XS, xs)
    for k in meta:
        if k not in META_KEYS:
            D.fields += 1
            D.bad(f'meta.{k}', 'key not recomputed', None, meta[k])
    for k in S:
        if k not in ('meta', 'rules'):
            D.fields += 1
            D.bad(k, 'key not recomputed', None, S[k])

    mine = {'meta': {k: meta[k] for k in META_KEYS}, 'rules': {}}
    internal = []
    for name, share in RULES:
        t_r = time.time()
        print(f'rule {name} (zone share {share!r}):')
        emails, ld, notes = run_rule(a.cache, start, end, load_from, share, xs, lambda s: print('  ' + s.strip()))
        summ, edge, stop_tau = rule_summary(emails, ld, share, xs, internal)
        mine['rules'][name] = summ
        b = summ['base']
        print(f'  base: mails {b["mails"]}, filled {b["filled"]}, unfilled {b["unfilled"]}, TP {b["tp"]}, '
              f'held {b["held"]}; files read {ld.files}, failed {ld.failed}' +
              (f' ({"; ".join(ld.failed_ex)})' if ld.failed else ''))
        for x in xs:
            g = summ['x'][str(x)]
            print(f'  X={x}: n {g["n"]}, back {g["back"]}, held {g["held"]} (sum {g["heldPipsSum"]!r}, worst '
                  f'{g["heldPipsMin"]!r}); backDays median {g["backDays"]["median"]!r} max {g["backDays"]["max"]!r}; '
                  f'dist {g["backDist"]}; toTau median {g["toTauDays"]["median"]!r} max {g["toTauDays"]["max"]!r}; '
                  f'back pips mean {g["backPipsMean"]!r}')
            print(f'         rules met here: backDays exactly 1/7/30/90 days {edge[x]}; tau_X in a Rakuten stop bar '
                  f'{stop_tau[x]}; exact-X ties that set tau_X (tau_X or G_X would differ with >= X) '
                  f'{notes["tieMoved"].get(x, 0)}')
        print(f'  rules met here: filled trades with no bar at P {notes["noBarFill"]}; summed over X: '
              f'tau_X on the fill bar {notes["tauAtFillBar"]}, tau_X on the TP bar {notes["tauAtTpBar"]} '
              f'({time.time() - t_r:.1f}s)')
    for s in internal:
        D.fields += 1
        D.bad(s, 'internal: tau_X vs follow mae', None, None)

    if 'rules' not in S or not isinstance(S['rules'], dict):
        D.fields += 1
        D.bad('rules', 'key', 'present', 'missing in the file')
    else:
        compare(D, 'rules', mine['rules'], S['rules'])
    if a.write:
        with open(a.write, 'w', encoding='utf-8') as f:
            json.dump(mine, f, ensure_ascii=False, indent=1)
        print(f'wrote {a.write}')
    print(f'compared {D.fields} values: {D.exact} exactly equal, {D.near} equal within {fc.REL:g} relative '
          f'(largest {D.near_max:.3g}), {D.n} different')
    if D.n:
        print('differences by kind: ' + ', '.join(f'{k} {v}' for k, v in sorted(D.by.items(), key=lambda x: -x[1])))
        for s in D.examples:
            print('  ' + s)
    print(f'({time.time() - t_all:.1f}s)')
    if D.n:
        print(f'BACKZ-CHECK FAILED: {D.n} differences')
        sys.exit(1)
    print('BACKZ-CHECK PASSED')
    sys.exit(0)


if __name__ == '__main__':
    main()
