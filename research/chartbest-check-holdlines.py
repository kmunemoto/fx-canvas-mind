#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
chartbest-check-holdlines.py — the owner's way's print lines (docs/OPERATIONS.md §8.113 9「必ず並べるもの（§8.111 の
「出すもの」の 1〜8。…§8.111 の文の中身をすべて出す。違う所は §8.111 が先）」「1〜8 は、前半・後半に分けても並べる」「1〜8 は、
この口座でも出す」) recomputed by the independent Python from its OWN accounts (research/ownerhold-check.py used as a
library on the Python's own list, SQ-07), and compared with the TS's print.txt lines `hold.<src>.<acct>.<key>` by key,
exactly as printed (20 (d)「数は完全に一致」; a missing or extra key is a difference; python-issues PR-8, finding
hold-print-uncompared).

Written 2026-10-13 by the step-2b Python review fixer, who has not read any TS of this job. What it was written from:
  * the rule: §8.113 9 (the list 1〜8, the halves, the second-half account, 13's 100% / 0% rows), §8.111 出すもの 1〜8
    (and its numbers as published, used only as a reading of the definitions: the TP-time shares' denominators), §8.102
    出すもの, 勝率, 取引ごとの見方, プログラムで決めたこと (6259 最大の逆行, 6261 取引ごとの円, 6268 口座の取引の円) and
    独立した見直しの後の直し (6287: the rows, halves and pairs; 最大の逆行の円; 利確までの時間の分け方);
  * python-issues.md PR-8 (the families of keys, the decimals, 「-」 / 「—」, "start", ISO minutes joined by ";");
  * the print lines' KEY NAMES and the SHAPES of their values with every digit masked (never a value; $S/pyrev/
    print-shapes.txt): the interface only.
Free parts the rule does not fix are named constants below, each with the reading taken (spec questions SQ-PR*
in $S/spec-questions.md).
"""
import datetime
import importlib.util
import math
import os
import sys

import numpy as np


def _mod(name):
    key = f'cbcheck_{name}'
    if key in sys.modules:
        return sys.modules[key]
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), f'chartbest-check-{name}.py')
    spec = importlib.util.spec_from_file_location(key, path)
    m = importlib.util.module_from_spec(spec)
    sys.modules[key] = m
    spec.loader.exec_module(m)
    return m


D = _mod('data')
HT = _mod('holdtext')

PAIR_KEY = {p: p.replace('/', '_') for p in D.PAIRS}       # the keys' pair names (USD_JPY, …)
ROWS = ('main', 'mainSwap', 'worst', 'worstSwap', 'opposite')   # the account rows printed (§8.102 ①'s four + 逆向き)
HELD_ROWS = ('main', 'mainSwap')     # §8.111 4 / 直し 4: the held trades and the times, for the main row and the main swap row
HORIZONS = (('1d', D.DAY), ('1w', 7 * D.DAY), ('4w', 28 * D.DAY), ('end', None))   # §8.102「1日以内・1週以内・4週以内・END まで」
# SQ-PR6: every 中央値・90%点・99%点 of these prints (MAE, tpHours, heldDays) is the report's quantile of §8.111 直し 4
# 「分位は、報告の quantile（並べた値の floor(q×(n−1)) 番目）に揃えた」, with q = 0.5 for the median (no mean of two middles).
QUANTS = (('median', 0.5), ('p90', 0.9), ('p99', 0.99))
YES, NO = 'yes', 'no'
MISSING_NUMBER = '-'                 # PR-8: a number that does not exist
MISSING_RATE = HT.MISSING            # PR-8: a rate that does not exist 「—」
# SQ-PR1: the take profit's time in 利確までの時間の分け方 (「1日以内・1週以内・4週以内・END まで」, a TP that happened by P + h):
# the end of its 1-minute bar, as ③'s value counts a TP by a time「それまでに利確していれば…「それまでに利確」も、その足までで
# 見る」 (a TP is known to have happened only when its bar has ended): (x + 1 min) − P ≤ h.
TP_WITHIN_AT = 'barEnd'
# SQ-PR1: 「利確に届いた取引の P から利確までの時間」 (§8.111 4; tpHours): the recorded exit time, §8.102's own x「x は出た1分足の
# 始まり」 (スワップ), so x − P; where the rule means the bar's end it writes so (6261「利確の足の終わり」). Changed by this
# author from (x + 1 min) − P after the first comparison reported the family tpHours as differing (the values were not
# read); the reason is the rule's definition of x.
TP_HOURS_TO = 'x'
# SQ-PR2: 最大の資金の落ち込み = the largest fall of the account's P/L (net assets − money put in, so that a deposit is no
# gain) below its running peak (0 at the start), the P/L taken at the end of every 1-minute clock point (楽天が止まる時間
# included: the account and its prices exist then too), every position valued at its exit-side close by 値段の取り方
# (「ある時刻 τ の値段は、τ 以前に終わる最後の1分足の終値。…すべてこの決まり」; 一番悪い値 is the supplementary rows' way of
# judging the loss-cut, not a valuation of the funds), after the minute's own events. An earlier version of this file took
# the P/L only where ⑤ judges the loss-cut and at the row's loss-cut price; it was changed after the comparison named the
# key family maxDrawdown as differing (no value read), for the reason above.
DRAWDOWN_POINTS = 'everyMinuteClose'
# SQ-PR3: 最大の逆行の円 of an account row's trade (6287「取引ごとの円と同じ決まり…利確の足の終わり〈まだ持っているものは END〉
# のドル円の中値」): the USD/JPY mid at the end of the trade's MAE window — a TP and a loss-cut at the end of their minute's
# bar (x + 1 min), a deadline close-out at the end of the bar before its minute (x), a held trade at END.
MAE_YEN_AT = 'windowEnd'
# SQ-PR4: heldEnd.worstYen = the largest unrealized loss of one held trade at END (its yen, price only); inLoss = the held
# trades with a negative yen.
HELD_WORST = 'oneTrade'
# 13「オーナーの持ち方（段2。9 の主の行と逆向きの行、後半だけの口座の行。選んだ項目と今のメール2つ。全期間・前半・後半・ペアごと）
# も、プログラムが数える。当たる条件: 口座の勝率（利確 ÷ 入った取引）か取引ごとの勝率を、印字に使う桁で丸めた値が 100%
# （100.0%・100.00%）か 0% と同じ表示になる時（ちょうど100%・0%を含む）。件数によらない。」 (with 9「印字が100%（か0%）になる
# 行…は、…13 の調べ（①〜④）を先に行い、その結果を並べる」): the main row and the opposite row of each account (whole,
# halves, pairs) and the per-trade view's two sides (whole, halves, pairs) printing 100.00% or 0.00%, in the print order,
# as acct.<row>.<part>=<rate> / email.<side>.<part>=<rate> joined by ";" (SQ-PR5: the names and the order; empty when none).
SUSPICIOUS_ROWS = ('main', 'opposite')


# ---------------------------------------------------------------- formats (PR-8; JavaScript's toFixed, ASCII minus)
def fx(x, d):
    """toFixed(d) of a finite double: its exact binary value rounded half away from zero; '-' stays on a negative that
    rounds to zero (as toFixed); -0.0 prints as 0."""
    if x is None or (isinstance(x, float) and math.isnan(x)):
        return MISSING_NUMBER
    if x == 0:
        x = 0.0
    return HT.TX.fixed(float(x), d).replace(HT.TX.TEXT_MINUS, '-')


def rate(n_ok, n):
    return MISSING_RATE if not n else fx(100 * (n_ok / n), 2) + '%'


def pips(x):
    return fx(x, 2)


def yen(x):
    return fx(x, 0)


def hours(x):
    return fx(x, 2)


def iso_min(t):
    d = datetime.datetime.fromtimestamp(int(t) / 1000, datetime.timezone.utc)
    return d.strftime('%Y-%m-%dT%H:%MZ')


def times(ts):
    return ';'.join(iso_min(t) for t in sorted(int(x) for x in ts))


def quantile(xs, q):
    """§8.111 直し 4「分位は、報告の quantile（並べた値の floor(q×(n−1)) 番目）」."""
    s = sorted(xs)
    return s[min(len(s) - 1, math.floor(q * (len(s) - 1)))]


def mean_of(xs):
    """2「和は古い方から1つずつ足す」: the values in the given order (the trades' order), one at a time."""
    t = 0.0
    for v in xs:
        t += v
    return t / len(xs) if xs else None


# ---------------------------------------------------------------- the pieces
class Ctx:
    """The account-independent data of one source and account: the World (its paths in the signal's direction),
    the flipped World (the opposite's), the period's split and END, and the USD/JPY pair."""

    def __init__(self, W, W_opp, OH, period):
        self.W, self.Wo, self.OH = W, W_opp, OH
        self.split, self.end = period['split'], W.end
        self.uj = W.pairs[0]

    def uj_mid(self, at):
        k = self.uj.ended(at)
        return (self.uj.bc.item(k) + self.uj.ac.item(k)) / 2


def trade_parts(ctx, W, trades):
    """The trades of an account row in their order, with the signal's T, pair, P (the order time, after the move out of
    楽天が止まる時間) and path."""
    out = []
    for t in trades:
        k = t['sig']
        s, r = W.sigs[k], W.path_sig[k]
        out.append((t, s, r))
    return out


def win_block(items, pre, keys, with_n=True, with_lc=True):
    """勝率 (tp ÷ entered; 分母にロスカット・期限の決済・END でまだ持っている取引), the endings, 1回あたり pips and yen."""
    n = len(items)
    cnt = {h: 0 for h in ('tp', 'lc', 'deadline', 'held')}
    for t, _, _ in items:
        cnt[t['how']] += 1
    p = mean_of([t['dir'] * (t['exit'] - t['fill']) / W_unit(t) for t, _, _ in items])
    y = mean_of([t['yen'] for t, _, _ in items])
    if with_n:
        keys[pre + 'n'] = str(n)
    keys[pre + 'win'] = rate(cnt['tp'], n)
    keys[pre + 'tp'] = str(cnt['tp'])
    if with_lc:
        keys[pre + 'lc'] = str(cnt['lc'])
        keys[pre + 'deadline'] = str(cnt['deadline'])
    keys[pre + 'held'] = str(cnt['held'])
    keys[pre + 'pips'] = pips(p)
    keys[pre + 'yen'] = yen(y)


_UNITS = {}


def W_unit(t):
    return _UNITS[t['pi']]


def quant_block(keys, pre, xs_pips, xs_yen):
    keys[pre.format('mae') + 'n'] = str(len(xs_pips))
    for name, q in QUANTS:
        keys[pre.format('mae') + name] = pips(quantile(xs_pips, q)) if xs_pips else MISSING_NUMBER
    keys[pre.format('mae') + 'max'] = pips(max(xs_pips)) if xs_pips else MISSING_NUMBER
    for name, q in QUANTS:
        keys[pre.format('maeYen') + name] = yen(quantile(xs_yen, q)) if xs_yen else MISSING_NUMBER
    keys[pre.format('maeYen') + 'max'] = yen(max(xs_yen)) if xs_yen else MISSING_NUMBER


def tp_reached(x):
    """The time a TP has surely happened by (TP_WITHIN_AT): the end of its bar."""
    if TP_WITHIN_AT != 'barEnd':
        raise ValueError(TP_WITHIN_AT)
    return x + D.MIN


def tp_hours(x, P):
    """利確までの時間 in hours (TP_HOURS_TO)."""
    if TP_HOURS_TO != 'x':
        raise ValueError(TP_HOURS_TO)
    return (x - P) / D.HOUR


def within_block(keys, pre, entries, end, of_all):
    """§8.102「利確に届くまでの時間の分け方（1日以内・1週以内・4週以内・END まで）。時間 h の行は、P＋h が END 以前のメールだけで
    数える」. entries: (P, the TP's x or None) of the counted ones; of_all: the 'end' row's denominator."""
    for name, h in HORIZONS:
        if h is None:
            of = of_all
            tp = sum(1 for _, x in entries if x is not None)
        else:
            inside = [(P, x) for P, x in entries if P + h <= end]
            of = len(inside)
            tp = sum(1 for P, x in inside if x is not None and tp_reached(x) - P <= h)
        keys[f'{pre}tpWithin.{name}.share'] = rate(tp, of)
        keys[f'{pre}tpWithin.{name}.tp'] = str(tp)
        keys[f'{pre}tpWithin.{name}.of'] = str(of)


# ---------------------------------------------------------------- account rows
def account_mae(ctx, W, t, r):
    """6287: 最大の逆行 of an account row's trade — from the bar it entered in (a market order without a bar at P: the
    first bar after P) to the TP's or the loss-cut's bar, to the bar before a deadline close-out's minute plus the
    close-out price, or to the last bar ended by END for a held one; 楽天が止まる時間の bars included. Pips (≥ 0) and yen
    (MAE_YEN_AT)."""
    pr = W.pairs[t['pi']]
    fk = r['fillK']
    lo = fk if fk is not None and fk >= 0 else r['firstAfter']
    how, d, fill = t['how'], t['dir'], t['fill']
    if how == 'tp':
        hi = r['tpK']
        at = t['x'] + D.MIN                     # 6287「利確の足の終わり」
    elif how == 'lc':
        hi = pr.ended(t['x'] + D.MIN)
        at = t['x'] + D.MIN
    elif how == 'deadline':
        hi = pr.ended(t['x'])
        at = t['x']
    else:
        hi = pr.n - 1
        at = ctx.end
    worst = 0.0
    if lo is not None and 0 <= lo <= hi:
        if d > 0:
            worst = (fill - pr.seek_bl.range_min(lo, hi)) / pr.unit
        else:
            worst = (pr.seek_ah.range_max(lo, hi) - fill) / pr.unit
    if how == 'deadline':
        worst = max(worst, d * (fill - t['exit']) / pr.unit)
    worst = max(0.0, worst)
    if MAE_YEN_AT != 'windowEnd':
        raise ValueError(MAE_YEN_AT)
    conv = ctx.uj_mid(at) if pr.usd else 1.0
    return worst, worst * pr.unit * ctx.OH.UNITS * conv


def drawdown(acc):
    return acc.dd_max if hasattr(acc, 'dd_max') else None


def account_lines(ctx, W, acc, row, account, keys):
    pre = row + '.'
    items = trade_parts(ctx, W, acc.trades)
    win_block(items, pre, keys, with_n=False)
    s = acc.summary
    A = s['naSplit'] - s['inSplit']
    B = (s['naEnd'] - s['naSplit']) - (s['inEnd'] - s['inSplit'])
    keys[pre + 'A'], keys[pre + 'B'], keys[pre + 'S'] = yen(A), yen(B), yen(A + B)
    capped = [c for c in acc.calls if c.uAfter is not None and c.uAfter > 0]
    dead = [c for c in acc.calls if c.end == 'deadline']
    keys[pre + 'lcs'] = str(len(acc.lcs))
    keys[pre + 'deadlines'] = str(len(dead))
    keys[pre + 'capped'] = str(len(capped))
    keys[pre + 'calls'] = str(len(acc.calls))
    ends = {e: 0 for e in ('deposit', 'settle', 'deadline', 'lc', 'open')}
    for c in acc.calls:
        ends[c.end] += 1
    keys[pre + 'callEnds'] = ';'.join(f'{e}={n}' for e, n in ends.items())
    keys[pre + 'deposits'] = str(len(acc.deposits))
    total = 0.0
    for x in acc.deposits:
        total += x['amount']
    keys[pre + 'depositTotal'] = yen(total)
    keys[pre + 'in'] = yen(s['inEnd'])
    keys[pre + 'lcAt'] = times(x['at'] for x in acc.lcs)
    keys[pre + 'deadlineAt'] = times(c.endAt for c in dead)
    keys[pre + 'cappedAt'] = times(c.tau for c in capped)
    for name, level in (('reached50', 500000.0), ('reached100', 1000000.0)):
        if W.startYen >= level:
            keys[pre + name] = 'start'
        else:
            hit = next((x['at'] for x in acc.deposits if x['total'] >= level), None)
            keys[pre + name] = iso_min(hit) if hit is not None else MISSING_NUMBER
    fates = acc.fate
    n_all = len(W.sigs)
    cnt = {k: 0 for k in ('entered', 'unfilled', 'cancelCall', 'cancelLc', 'refusedMargin', 'refusedCall')}
    for f in fates:
        if f in ('tp', 'lc', 'deadline', 'held'):
            cnt['entered'] += 1
        elif f in cnt:
            cnt[f] += 1
    keys[pre + 'placed'] = rate(cnt['entered'], n_all)            # PR-2: the entered share
    keys[pre + 'notPlaced'] = f"{cnt['refusedMargin']};{cnt['refusedCall']}"
    keys[pre + 'unfilled'] = str(cnt['unfilled'])
    keys[pre + 'cancelCall'] = str(cnt['cancelCall'])
    keys[pre + 'cancelLc'] = str(cnt['cancelLc'])
    dd = drawdown(acc)
    keys[pre + 'maxDrawdown'] = yen(dd) if dd is not None else MISSING_NUMBER
    # 6287「口座の道筋の別の行（判断の4行ほか、すべての行）: 前半・後半・ペアごとの勝率と1回あたりと終わり方、…最大の逆行
    # （pips と円…）、利確までの時間の分け方（その行で入った取引のうち P＋h が END 以前のもの）」
    maes = [(t['how'] == 'tp',) + account_mae(ctx, W, t, r) for t, _, r in items]
    quant_block(keys, pre + '{}.tp.', [m[1] for m in maes if m[0]], [m[2] for m in maes if m[0]])
    quant_block(keys, pre + '{}.notTp.', [m[1] for m in maes if not m[0]], [m[2] for m in maes if not m[0]])
    within_block(keys, pre, [(r['P'], t['x'] if t['how'] == 'tp' else None) for t, _, r in items], ctx.end,
                 len(items))
    if account == 'full':
        # 9「1〜8 は、前半・後半に分けても並べる」: by the signal's T (6287「合図の T が境より前か」)
        for half, keep in (('H1', lambda T: T < ctx.split), ('H2', lambda T: T >= ctx.split)):
            sub = [it for it in items if keep(it[1]['T'])]
            win_block(sub, f'{pre}{half}.', keys)
            ks = [k for k in range(n_all) if keep(W.sigs[k]['T'])]
            ent = sum(1 for k in ks if fates[k] in ('tp', 'lc', 'deadline', 'held'))
            keys[f'{pre}{half}.placed'] = rate(ent, len(ks))
    for pi, pair in enumerate(D.PAIRS):
        win_block([it for it in items if it[0]['pi'] == pi], f'{pre}{PAIR_KEY[pair]}.', keys)
    if row in HELD_ROWS:
        held = [t for t, _, _ in items if t['how'] == 'held']
        keys[pre + 'heldEnd.n'] = str(len(held))
        tot = sw = 0.0
        for t in held:
            tot += t['yen']
            sw += t['swapYen']
        keys[pre + 'heldEnd.yen'] = yen(tot)
        if HELD_WORST != 'oneTrade':
            raise ValueError(HELD_WORST)
        keys[pre + 'heldEnd.worstYen'] = yen(min(t['yen'] for t in held)) if held else MISSING_NUMBER
        keys[pre + 'heldEnd.swapYen'] = yen(sw)
        keys[pre + 'heldEnd.inLoss'] = str(sum(1 for t in held if t['yen'] < 0))
        days = [(ctx.end - r['P']) / D.DAY for t, _, r in items if t['how'] == 'held']
        for name, q in (('median', 0.5), ('p90', 0.9)):
            keys[f'{pre}heldDays.{name}'] = hours(quantile(days, q)) if days else MISSING_NUMBER
        keys[pre + 'heldDays.max'] = hours(max(days)) if days else MISSING_NUMBER
        hrs = [tp_hours(t['x'], r['P']) for t, _, r in items if t['how'] == 'tp']
        keys[pre + 'tpHours.n'] = str(len(hrs))
        for name, q in (('median', 0.5), ('p90', 0.9)):
            keys[f'{pre}tpHours.{name}'] = hours(quantile(hrs, q)) if hrs else MISSING_NUMBER
        keys[pre + 'tpHours.max'] = hours(max(hrs)) if hrs else MISSING_NUMBER


# ---------------------------------------------------------------- the per-trade view (§8.102 取引ごとの見方)
def per_trade_lines(ctx, W, paths, sign, side, keys, usd_at):
    sigs = W.sigs
    n_all = len(sigs)
    parts = (('all', lambda T: True), ('first', lambda T: T < ctx.split), ('second', lambda T: T >= ctx.split))

    def one(k):
        s, r = sigs[k], paths[k]
        if r['none'] or not r['filled']:
            return None
        pr = W.pairs[s['p']]
        d = sign * s['dir']
        tpd = bool(r['tpd'])
        px = r['exit'] if tpd else r['endPx']
        p = d * (px - r['fill']) / pr.unit
        quote = ctx.OH.UNITS * d * (px - r['fill'])
        mae = r['mae']
        if pr.usd:
            at = r['x'] + D.MIN if tpd else ctx.end              # 6261 / 6287: 利確の足の終わり; END for a held one
            if usd_at != 'exitBarClose':
                raise ValueError(usd_at)
            conv = ctx.uj_mid(at)
        else:
            conv = 1.0
        return {'tp': tpd, 'pips': p, 'yen': quote * conv, 'mae': mae, 'maeYen': mae * pr.unit * ctx.OH.UNITS * conv,
                'P': r['P'], 'x': r['x'] if tpd else None, 'pi': s['p']}

    rows = [one(k) for k in range(n_all)]
    for name, keep in parts:
        ks = [k for k in range(n_all) if keep(sigs[k]['T'])]
        ent = [rows[k] for k in ks if rows[k] is not None]
        pre = f'email.{side}.{name}.'
        keys[pre + 'emails'] = str(len(ks))
        keys[pre + 'filled'] = str(len(ent))
        keys[pre + 'unfilled'] = str(len(ks) - len(ent))
        tp = sum(1 for e in ent if e['tp'])
        keys[pre + 'win'] = rate(tp, len(ent))
        keys[pre + 'tp'] = str(tp)
        keys[pre + 'held'] = str(len(ent) - tp)
        keys[pre + 'pips'] = pips(mean_of([e['pips'] for e in ent]))
        keys[pre + 'yen'] = yen(mean_of([e['yen'] for e in ent]))
        quant_block(keys, pre + '{}.tp.', [e['mae'] for e in ent if e['tp']], [e['maeYen'] for e in ent if e['tp']])
        quant_block(keys, pre + '{}.notTp.', [e['mae'] for e in ent if not e['tp']],
                    [e['maeYen'] for e in ent if not e['tp']])
        # §8.111's numbers: the per-trade view's shares count every email (an unfilled one is not a TP), the
        # account's every entered trade
        within_block(keys, pre, [(paths[k]['P'], rows[k]['x'] if rows[k] is not None else None) for k in ks],
                     ctx.end, len(ks))
    for pi, pair in enumerate(D.PAIRS):
        ent = [e for e in rows if e is not None and e['pi'] == pi]
        pre = f'email.{side}.{PAIR_KEY[pair]}.'
        tp = sum(1 for e in ent if e['tp'])
        keys[pre + 'win'] = rate(tp, len(ent))
        keys[pre + 'tp'] = str(tp)
        keys[pre + 'held'] = str(len(ent) - tp)
        keys[pre + 'pips'] = pips(mean_of([e['pips'] for e in ent]))
        keys[pre + 'yen'] = yen(mean_of([e['yen'] for e in ent]))


# ---------------------------------------------------------------- one source and account
def hold_lines(account, W, Wo, accs, unl, opp, th, facts, period, OH, usd_at):
    """{key: value} of hold.<src>.<account>.* as the Python prints them (keys without the prefix)."""
    for pr in W.pairs:
        _UNITS[pr.idx] = pr.unit
    ctx = Ctx(W, Wo, OH, period)
    keys = {'done': YES, 'signals': str(len(W.sigs))}
    rows = dict(accs)
    rows['opposite'] = opp
    for row in ROWS:
        Wr = Wo if row == 'opposite' else W
        account_lines(ctx, Wr, rows[row], row, account, keys)
    e = unl['main'].summary['estar']
    keys['estar'] = yen(e['value']) if e else MISSING_NUMBER
    m1 = {r: unl[r].summary['mSplit'] for r in ('main', 'mainSwap')}
    m2 = {r: unl[r].summary['mEnd'] - unl[r].summary['mSplit'] for r in ('main', 'mainSwap')}
    if account == 'full':
        keys['M1'], keys['M2'] = yen(m1['main']), yen(m2['main'])
        keys['M1swap'], keys['M2swap'] = yen(m1['mainSwap']), yen(m2['mainSwap'])
    else:
        keys['Mh'], keys['MhSwap'] = yen(m2['main']), yen(m2['mainSwap'])
    for f in ('main', 'L', 'plain'):
        keys['third.' + f] = pips(th[f])
    keys['third.n'] = str(th['n'])
    v = HT.verdict_of(facts)
    keys['v1'] = YES if v['one'] else NO
    keys['v2'] = YES if (v['twoAccounts'] and v['twoM']) else NO
    keys['v3'] = YES if v['three'] else NO
    per_trade_lines(ctx, W, W.path_sig, 1, 'main', keys, usd_at)
    per_trade_lines(ctx, W, W.path_opp, -1, 'opposite', keys, usd_at)
    keys['suspicious'] = suspicious(keys)
    return keys


def suspicious(keys):
    """13 (SUSPICIOUS_ROWS): the printed rates of 100.00% or 0.00% of the main and opposite rows (account and per
    trade), in the print order."""
    out = []
    for k, v in keys.items():
        if not (k.endswith('.win') and v in ('100.00%', '0.00%')):
            continue
        part = k[:-len('.win')]
        if part.startswith('email.'):
            if part.split('.')[1] not in SUSPICIOUS_ROWS:
                continue
            name = part
        else:
            row, _, rest = part.partition('.')
            if row not in SUSPICIOUS_ROWS:
                continue
            name = f'acct.{row}.{rest or "all"}'
        out.append(f'{name}={v}')
    return ';'.join(out)


# ---------------------------------------------------------------- the P/L path's drawdown (SQ-PR2)
def dd_account_class(OH):
    class DDAccount(OH.Account):
        """research/ownerhold-check.py's Account, also following the largest fall of its P/L (net assets − money put
        in) below the running peak (0 at the start), the P/L taken at the end of every 1-minute clock point (楽天が止まる
        時間 included) with every position at its exit-side close, after that minute's own events (DRAWDOWN_POINTS).
        Nothing else changes."""

        def __init__(self, *a, **k):
            super().__init__(*a, **k)
            if DRAWDOWN_POINTS != 'everyMinuteClose':
                raise ValueError(DRAWDOWN_POINTS)
            self.dd_peak = 0.0
            self.dd_max = 0.0

        def _see(self, pl):
            if pl > self.dd_peak:
                self.dd_peak = pl
            if self.dd_peak - pl > self.dd_max:
                self.dd_max = self.dd_peak - pl

        def minute(self, g):
            super().minute(g)
            if not self.unl:
                W = self.W
                ix1 = [int(W.e1[p][g]) for p in range(len(OH.PAIRS))]
                na, _ = self.na_req(ix1, 'exit')
                self._see(na - self.moneyIn)

        def quiet(self, ga, gb):
            # quiet() changes nothing in the account (it finds the first loss-cut minute, which minute() then runs):
            # the minutes before that one keep the positions as they are now
            lg = super().quiet(ga, gb)
            if not self.unl:
                self._quiet_dd(ga, gb if lg is None else lg)
            return lg

        def _quiet_dd(self, ga, gb):
            if gb <= ga:
                return
            W = self.W
            self.refresh()
            sl = slice(ga, gb)
            L = gb - ga
            active = [p for p in range(len(OH.PAIRS)) if self.agg[p][0] + self.agg[p][1] > 0]
            need_uj = self.dollars != 0.0 or any(W.pairs[p].usd for p in active)
            ujm = None
            if need_uj:
                k = W.e1[0][sl]
                u = W.pairs[0]
                ujm = (u.bc[k] + u.ac[k]) / 2
            na = np.full(L, self.yen)
            if self.dollars != 0.0:
                na = na + self.dollars * ujm
            for p in active:
                nb, ns, sb, ss = self.agg[p]
                pr = W.pairs[p]
                k = W.e1[p][sl]
                conv = ujm if pr.usd else 1.0
                na = na + (nb * pr.bc[k] - sb + ss - ns * pr.ac[k]) * OH.UNITS * conv
            pl = na - self.moneyIn
            # the running peak through this stretch (starting from the peak so far), and the largest fall below it
            peak = np.maximum.accumulate(np.concatenate(([self.dd_peak], pl)))[1:]
            fall = float(np.max(peak - pl))
            if fall > self.dd_max:
                self.dd_max = fall
            top = float(peak[-1])
            if top > self.dd_peak:
                self.dd_peak = top
    return DDAccount


# ---------------------------------------------------------------- the comparison with print.txt
def read_print(path):
    """The TS's print.txt lines hold.* other than the sentences: {key: value}."""
    out = {}
    with open(path, encoding='utf-8') as f:
        for line in f:
            k, sep, v = line.rstrip('\n').partition('\t')
            if sep and k.startswith('hold.'):
                out[k] = v
    return out


def compare_print(rep, mine, print_path):
    """PR-8: the Python's lines (mine: {full key: value}) against the TS's print.txt hold.* lines, by key, exactly as
    printed; a key on one side only is a difference (an account left out by the TS's budget has the one line
    hold.<src>.<acct>.done no: 9「数字は作らない」). A difference names the key only (20 (d)「違った時は値を出さず、どこが違う
    かだけを出す」)."""
    name = 'print.txt'
    rep.compared += 1
    if not os.path.exists(print_path):
        rep.add(name, '-', 'missing in ts')
        return 0, 1
    ts = read_print(print_path)
    nd = 0
    for k in sorted(set(mine) | set(ts)):
        if k not in ts:
            rep.add(name, k, 'only in py')
        elif k not in mine:
            rep.add(name, k, 'only in ts')
        elif mine[k] != ts[k]:
            rep.add(name, k, 'value')
        else:
            continue
        nd += 1
    return len(set(mine) | set(ts)), nd
