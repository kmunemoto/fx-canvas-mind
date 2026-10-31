#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
chartbest-check-hold.py — the owner's way (docs/OPERATIONS.md §8.113 9) in the independent Python re-computation.

For every source of the second half (the K_total items and the two emails) and both accounts (the full one and the
second-half one, 9 / SQ-27), this module
  1. makes the signal list the account runs on from the Python's own signals and writes it in research/ownerhold's dump
     layout (py/hold/<src>-<acct>/signals.csv, meta.json);
  2. compares that list with the TS's hold/<src>-<acct>/dump/signals.csv (key pair|side|open|late; E and tp as written
     by the dump's own number format, the shortest decimal that reads back as the same double: PI-1) and its meta.json;
  3. recomputes the accounts with research/ownerhold-check.py used as a library (SQ-07: an independent Python written
     from §8.102 without the TS) on the Python's OWN list — the World from py/hold/<src>-<acct>/, the five account rows,
     the four all-accepted rows (E*, M), ③ — plus the opposite-only account (§8.102 比べるもの「逆向きの取引だけで回した
     同じ口座」) and the per-trade view, and compares the TS's dump with ownerhold-check.py's own comparators;
  4. builds the owner-hold sentences from those numbers (research/chartbest-check-holdtext.py: 21, §8.102 書く文,
     SQ-08 / SQ-H1) and compares them with the TS's hold/sentences.tsv by id, character for character (PI-3).

The lists (9「合図の元だけを、その項目の START ≦ T < END の送られる合図すべて（③④では外さない。§8.111 と同じ）に替える」,
§8.111, SQ-27):
  * items: every signal passing ① and ② (③ and ④ not applied) with START <= T < END; E = the bar's rounded mid
    close, TP = E + d x 10 x pip, late 0, base = T;
  * ULTRA 5分足: the same on-time signals, and the late ones (window i+1, §8.111 3「ULTRA の遅れた合図は base ＝ 次の足の
    確定、P ＝ base ＋ 2分」): base = the close of bar i + 1, kept only when mailed (§8.111 2 and its review fix 2: one
    of the reads at base + 0, 1, 3 minutes is less than 10 minutes after T and outside isPossiblyClosed; PI-4);
  * MACD の山・谷: the sent fires (no late ones);
  * the second-half account keeps SPLIT <= T < END (SQ-27, by T).
Order: P (= base + 2 min), then the pairs' order, BUY first, then the bar's open; `i` numbers that order.

Rewritten 2026-10-13 by the step-2b Python fixer (python-issues.md PI-1, PI-3, PI-4), who has not read any TS of this
job; the earlier body of hold_rows took base = T + 5 min for every late signal and judged it with sent(base) alone.
Reviewed and changed 2026-10-13 by the step-2b Python review fixer, who has not read any TS of this job either
(python-issues PR-1 – PR-10): late_mailed, hold_rows, account_facts and per_trade checked against §8.111 2・3 (and its
fix 2), 9 and §8.102 (PR-10; hand case hold.lateMailed runs hold_rows); a capped call's time is τ (PR-1,
CAPPED_CALL_TIME); the per-trade view's yen of a dollar pair at the end of the TP's bar (PR-3, PER_TRADE_USD_AT);
call_facts (hand case text.hold.cappedCalls runs it, PR-4); the rates input of the real stage 2 (PR-7, compare_hold's
rates); the TS's timed-out marker (PR-9, timed_out); 9 の 1〜8 as print lines compared with print.txt by key (PR-8,
research/chartbest-check-holdlines.py).
"""
import importlib.util
import json
import os
import sys
import time


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


def ownerhold():
    """research/ownerhold-check.py loaded by path as a library (SQ-07); its main() does not run."""
    key = 'cbcheck_ownerhold_check'
    if key not in sys.modules:
        path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'ownerhold-check.py')
        spec = importlib.util.spec_from_file_location(key, path)
        m = importlib.util.module_from_spec(spec)
        sys.modules[key] = m
        spec.loader.exec_module(m)
    return sys.modules[key]


D = _mod('data')
S = _mod('signals')
CMP = _mod('compare')
HT = _mod('holdtext')
HL = _mod('holdlines')

HOLD_TP = 10                 # 9: the owner's TP 10 pips (ultraLevels' TP2)
START_YEN, CAP_YEN = 300000.0, 1000000.0      # 9: 始めの資金30万円、入れられるお金は合計100万円まで
DELAY_MIN = 2                # 9 / §8.111 3: P = T + 2 min (late: base + 2 min)
ACCOUNTS = ('full', 'h2')
HEADER = ['i', 'pair', 'side', 'open', 'T', 'E', 'tp', 'late', 'base']
# §8.111 2「ULTRA の遅れた合図は、鮮度（freshFor("5min")＝10分）の中のものだけ」 and its review fix 2「「10分の中」を、
# ちょうど10分は入れない（厳密な「未満」）にした」: a read at r keeps a late signal of close T only when r − T < 10 min.
LATE_FRESH = 10 * D.MIN
# SQ-H6: the swap rows' rates (§8.102 スワップ「…読めなければ §8.24 と同じく BIS の政策金利（月次、1か月遅れ）から目安を作る」).
# Made-up runs use ownerhold-check.py's synthetic rates (plan §3.12, as the TS's made-up runs); the real stage 2 passes
# the same BIS file as the TS's CB_BIS_CSV (chartbest-check.py --bis-csv, read against --bis-sha256 before anything
# is read; PR-7), which compare_hold gives to ownerhold-check.py's World in place of RATES.
RATES = 'synthetic'
# The 日時 written for a capped call (SQ-PF1, settled; python-issues PR-1, finding indep-02): its NY close τ, the time
# the call is judged and identified by — §8.102 判定「楽天の NY の引け τ の中値で、純資産が必要証拠金を下回ったら追証」,
# 楽天の決まり「追証: 取引日の終わりの中値で…100%を下回ると出る。判定の時刻は…21:55／20:55 UTC」 and the detail list
# 「追証（τ・期限・D・終わり方とその時刻・…・知らせの入金の後の U）」 (OPERATIONS.md 6159, 6118, 6287). The notice τ + 35 min
# is when the deposit is made, not the call's time (hand.json fields.holdText: 「tau: … its NY close τ」). The 不足額
# beside it stays U after the notice's deposit. 'tau' (the record's τ); the earlier reading 'notice' (τ + 35 min) came
# from a mistake of the fields text and is not offered any more.
CAPPED_CALL_TIME = 'tau'
# The per-trade view's yen of a dollar pair (SQ-PF5, settled by the rule text; python-issues PR-3, findings indep-01
# and hold-pertrade-yen): §8.102 プログラムで決めたこと「取引ごとの円: 円のペアは pips × 0.01 × 1万、ドルのペアは pips ×
# 0.0001 × 1万ドル × 利確の足の終わり（まだ持っているものは END）のドル円の中値（参考の数字）」 (OPERATIONS.md 6261), the same
# for 最大の逆行の円 (6287「取引ごとの円と同じ決まり: … 利確の足の終わり〈まだ持っているものは END〉のドル円の中値」), with
# 値段の取り方「ある時刻 τ の値段は、τ 以前に終わる最後の1分足の終値」: τ = the end of the TP's 1-minute bar (x + 1 min),
# so the USD/JPY mid of the last USD/JPY bar ending at or before x + 1 min ('exitBarClose'); a held trade at END. This
# differs ON PURPOSE from the account rows' trade table (6268「利確と期限の決済はその分の始まりまでに終わったドル円」, the
# bar ending at x, which research/ownerhold-check.py's account rows use): the per-trade view has its own rule.
# python-issues TS-1 (which proposed the account rows' convention here) is withdrawn.
PER_TRADE_USD_AT = 'exitBarClose'


# ---------------------------------------------------------------- the lists (9, §8.111, SQ-27)
def late_mailed(T, base):
    """§8.111 2 (with its review fix 2): a late ULTRA signal (close T, read in the window of the bar closing at base)
    is mailed when one of the reads at base + 0, 1, 3 minutes is less than 10 minutes after T and outside
    isPossiblyClosed. A late signal whose next bar does not open at T is therefore never mailed (base >= T + 10 min)."""
    for m in D.SENT_READS:
        r = base + m * D.MIN
        if r - T < LATE_FRESH and not D.possibly_closed(r):
            return True
    return False


def hold_rows(src, sigs, late, bars, period, account):
    """The list one account of one source runs on."""
    lo = period['start'] if account == 'full' else period['split']
    hi = period['end']
    rows = []
    for s in sigs:
        if s.src != src or s.reason in ('r1', 'r2') or not (lo <= s.T < hi):
            continue
        rows.append(_row(bars[s.pi], int(bars[s.pi].t[s.i]), s.T, s.E, s.dir, 0, s.T))
    if src == 'ultra5':
        for pb in bars:
            for i, d in late.get(pb.pair, []):
                T = int(pb.t[i]) + D.STEP
                if not (lo <= T < hi) or i + 1 >= pb.n:
                    continue
                base = int(pb.t[i + 1]) + D.STEP          # §8.111 3「base ＝ 次の足の確定」
                if not late_mailed(T, base):
                    continue
                rows.append(_row(pb, int(pb.t[i]), T, float(pb.mc[i]), d, 1, base))
    rows.sort(key=lambda r: (r['base'] + DELAY_MIN * D.MIN, D.PAIRS.index(r['pair']), 0 if r['side'] == 'BUY' else 1,
                             r['open']))
    for k, r in enumerate(rows):
        r['i'] = k
    return rows


def _row(pb, open_, T, E, d, late, base):
    tp = E + (d * HOLD_TP) * pb.pip
    return {'pair': pb.pair, 'side': S.DIR_NAME[d], 'open': open_, 'T': T, 'E': E, 'tp': tp, 'late': late, 'base': base}


def write_rows(path, rows):
    """PI-1: the hold dump is research/ownerhold's layout (plan 4.3), where E and tp are written as the shortest decimal
    that reads back as the same double (JavaScript's String(x)); the list is written the same way, so that E is compared
    as written (exactly) on the same number format."""
    CMP.write_csv(path, HEADER, [[str(r['i']), r['pair'], r['side'], str(r['open']), str(r['T']), CMP.js_num(r['E']),
                                  CMP.js_num(r['tp']), str(r['late']), str(r['base'])] for r in rows])


def own_meta(period, account):
    return {'start': period['start'] if account == 'full' else period['split'], 'end': period['end'],
            'split': period['split'], 'startYen': START_YEN, 'cap': CAP_YEN, 'step': 5, 'delay': DELAY_MIN}


# ---------------------------------------------------------------- the numbers of one account (§8.102, 9, SQ-H1)
FATES_ENTERED = ('tp', 'lc', 'deadline', 'held')


def placed_of(fate, ks):
    """§8.102 メールの行き先 over the signals ks of one account row: all, entered (then closed or held), unfilled,
    cancelled by a call or a loss-cut, refused (有効証拠金 / 追証の間)."""
    out = {'n': 0, 'entered': 0, 'unfilled': 0, 'cancelCall': 0, 'cancelLc': 0, 'refusedMargin': 0, 'refusedCall': 0}
    for k in ks:
        f = fate[k]
        out['n'] += 1
        if f in FATES_ENTERED:
            out['entered'] += 1
        elif f in out:
            out[f] += 1
    return out


def ab_of(acc):
    """§8.102 前半・後半: A = the net assets at SPLIT − the money put in by then; B = END's − SPLIT's − the deposits in
    between; S = A + B (the second-half account starts at SPLIT, so its A is 0 and B = S)."""
    s = acc.summary
    A = s['naSplit'] - s['inSplit']
    B = (s['naEnd'] - s['naSplit']) - (s['inEnd'] - s['inSplit'])
    return A, B, A + B


def calls_of(acc, OH):
    """One account row's call records (research/ownerhold-check.py's Call: tau, end, endAt, uAfter) → the capped calls
    (§8.102 ①「上限（100万円）のために知らせの時刻の入金の後に U が残った追証」: U > 0 after the notice's deposit; a call
    that ended before the notice has no such deposit, uAfter None, and is not capped), the calls ended by the
    deadline's close-out, and the capped calls as the sentence writes them ({tau: the time written, short: U after the
    notice's deposit, end}), in the records' order. hand.json's holdCalls case runs through this function."""
    if CAPPED_CALL_TIME != 'tau':
        raise ValueError(f'CAPPED_CALL_TIME {CAPPED_CALL_TIME!r}: only the NY close τ (SQ-PF1, settled)')
    capped = [c for c in acc.calls if c.uAfter is not None and c.uAfter > 0]
    dead = [c for c in acc.calls if c.end == 'deadline']
    return capped, dead, [{'tau': c.tau, 'short': c.uAfter, 'end': c.end} for c in capped]


def call_facts(acc, OH):
    """The call facts of one account row as the sentences use them (hand.json fields.holdText's deadlines, capped,
    deadlineAt, cappedCalls): §8.102 ①「追証の期限での全決済」 counted by the calls that ended by the deadline's close-out,
    with the time the positions were closed (the call's endAt: the start of the first 1-minute bar at or after the
    deadline, whose open closed them, §8.102「期限の時刻以後に始まる最初の1分足…の始値で、すべて決済する」), and the
    capped calls of calls_of. hand.json's holdCalls case runs through this function (python-issues PR-4)."""
    capped, dead, capped_calls = calls_of(acc, OH)
    return {'deadlines': len(dead), 'capped': len(capped), 'deadlineAt': [c.endAt for c in dead],
            'cappedCalls': capped_calls}


def row_facts(acc, W, OH):
    A, B, S_ = ab_of(acc)
    return dict(call_facts(acc, OH), lcs=len(acc.lcs), lcAt=[x['at'] for x in acc.lcs], A=A, B=B, S=S_,
                inTotal=acc.summary['inEnd'], placed=placed_of(acc.fate, range(len(W.sigs))))


def trades_view(acc, W):
    """§8.102 勝率: the entered trades of an account row (利確・ロスカット・期限・END でまだ持っている), the rate tp ÷ entered,
    1回あたり pips and yen (the account's own yen of each trade: a dollar pair at the USD/JPY mid of its close, END's
    for a held one)."""
    n = len(acc.trades)
    cnt = {h: 0 for h in FATES_ENTERED}
    p_sum = y_sum = 0.0
    for t in acc.trades:
        cnt[t['how']] += 1
        p_sum += t['dir'] * (t['exit'] - t['fill']) / W.pairs[t['pi']].unit
        y_sum += t['yen']
    return {'rate': cnt['tp'] / n if n else None, 'tp': cnt['tp'], 'lc': cnt['lc'], 'deadline': cnt['deadline'],
            'held': cnt['held'], 'pips': p_sum / n if n else None, 'yen': y_sum / n if n else None}


def per_trade(W, ks, OH):
    """§8.102 取引ごとの見方（資金の限りなし）: every signal apart, in the signal's direction and the opposite one; entered =
    filled; the rate tp ÷ entered; 1回あたり pips and yen over the entered ones (held ones valued at END's price; a dollar
    pair at the USD/JPY mid of the close's time, END's for a held one)."""
    uj = W.pairs[0]

    def side(paths, sign):
        n = tp = 0
        p_sum = y_sum = 0.0
        for k in ks:
            s, r = W.sigs[k], paths[k]
            if r['none'] or not r['filled']:
                continue
            pr = W.pairs[s['p']]
            d = sign * s['dir']
            n += 1
            px = r['exit'] if r['tpd'] else r['endPx']
            tp += 1 if r['tpd'] else 0
            p_sum += d * (px - r['fill']) / pr.unit
            quote = OH.UNITS * d * (px - r['fill'])
            if pr.usd:
                at = W.end
                if r['tpd']:
                    at = r['x'] + (OH.MIN if PER_TRADE_USD_AT == 'exitBarClose' else 0)
                kk = uj.ended(at)
                quote *= (uj.bc.item(kk) + uj.ac.item(kk)) / 2
            y_sum += quote
        return {'n': n, 'tp': tp, 'rate': tp / n if n else None, 'pips': p_sum / n if n else None,
                'yen': y_sum / n if n else None}
    a, b = side(W.path_sig, 1), side(W.path_opp, -1)
    return {'rate': a['rate'], 'tp': a['tp'], 'held': a['n'] - a['tp'], 'pips': a['pips'], 'yen': a['yen'],
            'oppRate': b['rate'], 'oppPips': b['pips'], 'oppYen': b['yen']}


def flipped_world(W, OH):
    """The same World with every signal's direction reversed (same T, E, P and order; TP 10 pips the other way):
    §8.102 比べるもの「逆向き: 同じ T・同じ E・同じ持ち方で、向きだけ逆にした取引」, for the opposite-only account."""
    W2 = OH.World.__new__(OH.World)
    W2.__dict__.update(W.__dict__)
    W2.sigs = []
    for s in W.sigs:
        d = -s['dir']
        W2.sigs.append(dict(s, dir=d, side='BUY' if d > 0 else 'SELL',
                            tpIn=s['E'] + d * OH.TP_PIPS * W.pairs[s['p']].unit))
    W2.compute_paths()
    return W2


def account_facts(src, account, W, accs, unl, opp, th, period, OH):
    split = period['split']
    ks = range(len(W.sigs))
    first = [k for k in ks if W.sigs[k]['T'] < split]
    second = [k for k in ks if W.sigs[k]['T'] >= split]
    rows = {r: row_facts(accs[r], W, OH) for r in HT.ROWS}
    m1 = {r: unl[r].summary['mSplit'] for r in ('main', 'mainSwap')}
    m2 = {r: unl[r].summary['mEnd'] - unl[r].summary['mSplit'] for r in ('main', 'mainSwap')}
    est = unl['main'].summary['estar']
    win = dict(trades_view(accs['main'], W), lcEvents=len(accs['main'].lcs), estar=est['value'] if est else None)
    oc = call_facts(opp, OH)
    o_view = trades_view(opp, W)
    opposite = dict(o_view, lcs=len(opp.lcs), deadlines=oc['deadlines'], capped=oc['capped'], S=ab_of(opp)[2])
    pt = per_trade(W, ks, OH)
    parts = [pt]
    if account == 'full':
        parts = [pt, per_trade(W, first, OH), per_trade(W, second, OH)]
    return {'src': src, 'account': account, 'email': src in D.MEASURES, 'timedOut': False, 'rows': rows,
            'placedHalves': ([placed_of(accs['main'].fate, first), placed_of(accs['main'].fate, second)]
                             if account == 'full' else None),
            'm': {'none': [m1['main'], m2['main']], 'swap': [m1['mainSwap'], m2['mainSwap']]},
            'mh': [m2['main'], m2['mainSwap']] if account == 'h2' else None,
            'third': {'main': th['main'], 'L': th['L'], 'plain': th['plain'], 'n': th['n']},
            'win': win, 'opposite': opposite, 'perTrade': pt,
            'perTradeParts': [{'rate': p['rate'], 'pips': p['pips'], 'oppRate': p['oppRate'], 'oppPips': p['oppPips']}
                              for p in parts]}


# ---------------------------------------------------------------- the comparison
def _cmp_class(OH):
    class AllCmp(OH.Cmp):
        """ownerhold-check.py's comparator, keeping every mismatch's (kind, key, field) — never a value (20 (d))."""

        def __init__(self):
            super().__init__()
            self.where = []

        def bad(self, kind, key, field, mine, dump):
            super().bad(kind, key, field, mine, dump)
            self.where.append((kind, key, field))
    return AllCmp


def compare_dump(rep, tag, W, th, accs, unl, dump, gmo, OH, expect_real=False):
    """The TS's hold dump against the Python's own World (the list was compared just before): ownerhold-check.py's
    comparators of §8.102 確かめ A — paths, emails' 1-day / 1-week values, ③, the five account rows and the four
    all-accepted rows (E*, M) — and its input checks (E against the 5-minute bars, TP = E ± 10 pips)."""
    C = _cmp_class(OH)()
    for msg in W.problems:
        C.bad('load', 'gmo', msg, None, None)
    OH.check_meta(C, W, expect_real)       # real data, the full account: 30万円・100万円・START・SPLIT of §8.111
    pairs5 = [pr.load15(gmo, None, f'{W.step}min') for pr in W.pairs]
    OH.check_inputs(C, W, pairs5, 'exact', {})
    OH.compare_paths(C, W, dump)
    OH.compare_emails(C, W, dump)
    OH.compare_third(C, th, dump)
    for row in OH.ACCOUNT_ROWS:
        OH.compare_account(C, accs[row], dump, row, False)
    for row in OH.UNLIMITED_ROWS:
        OH.compare_account(C, unl[row], dump, 'unlimited-' + row, True)
    rep.compared += 1
    for kind, key, field in C.where:
        rep.add(f'hold/{tag}/dump/{kind}', str(key), str(field))
    return sum(C.compared.values()), len(C.where)


# PR-9 (SQ-PF4; finding hold-budget): the TS's marker of an item's account that its time budget left out.
TIMED_OUT_FILE = 'timed-out.json'


def timed_out(rep, hold_dir, tag, src, acct):
    """9「合図がとても多い項目で、計算が Actions の1 job（6時間）に収まらない時は、その項目のオーナーの持ち方は「出せなかった」と
    書く。数字は作らない。」 — items only: the two emails are always computed (9「今のメール2つの数字は、§8.111 の数字を再現して
    並べる（20 の (c)）」, 21「今のメール2つも、同じ2つの口座で並べる」). The TS leaves hold/<src>-<acct>/timed-out.json
    ({src, account, signals, deadline, at, why}) and no dump for such an account. The marker is accepted only for an item,
    only when the dump is absent and only when it names this source and account; the account then gets the sentence
    「出せなかった」, is left out of the range sentence, and nothing else of it is compared. A marker for an email, beside
    a dump, unreadable or naming another account is a difference (and the account is computed and compared as usual).
    Added 2026-10-13 by the step-2b Python review fixer (python-issues PR-9), who has not read any TS."""
    path = os.path.join(hold_dir, tag, TIMED_OUT_FILE)
    if not os.path.exists(path):
        return False
    name = f'hold/{tag}/{TIMED_OUT_FILE}'
    rep.compared += 1
    try:
        with open(path, encoding='utf-8') as f:
            m = json.load(f)
        if not isinstance(m, dict):
            raise ValueError('not an object')
    except (OSError, ValueError) as e:
        rep.add(name, '-', f'unreadable ({e.__class__.__name__})')
        return False
    ok = True
    if src in D.MEASURES:
        rep.add(name, '-', 'a marker for an email (9: the two emails are never left out)')
        ok = False
    if os.path.isdir(os.path.join(hold_dir, tag, 'dump')):
        rep.add(name, '-', 'a marker beside a dump')
        ok = False
    if m.get('src') != src or m.get('account') != acct:
        rep.add(name, '-', 'src / account')
        ok = False
    return ok


def compare_hold(rep, out, hold_dir, gmo, sources, sigs, late, bars, period, log, rates=RATES, real=False):
    """Every (source, account) of 9: the list and meta against the dump; the Python's own accounts (ownerhold-check.py)
    against the dump; then the owner-hold sentences (hold.<src>.<acct>, always.s2.hold) against hold/sentences.tsv.
    rates: the swap rows' rates for ownerhold-check.py's World — 'synthetic' on made-up data, the BIS file (the TS's
    CB_BIS_CSV, read against its sha256 by chartbest-check.py's stage_gate) on real data (PR-7, SQ-H6). An item's
    account the TS left out by its budget (timed_out) gets 「出せなかった」 only (PR-9)."""
    OH = ownerhold()
    DDA = HL.dd_account_class(OH)
    lines = {}
    if real and rates == 'synthetic':
        raise ValueError("the real stage 2's owner's way needs the BIS rates (SQ-H6): refused before here by stage_gate")
    facts = {}
    for src in sources:
        for acct in ACCOUNTS:
            t0 = time.time()
            tag = f'{src}-{acct}'
            mine_dir = os.path.join(out, 'hold', tag)
            os.makedirs(mine_dir, exist_ok=True)
            if timed_out(rep, hold_dir, tag, src, acct):
                facts[(src, acct)] = {'src': src, 'account': acct, 'email': False, 'timedOut': True}
                log(f'hold {tag}: left out by the TS\'s time budget ({TIMED_OUT_FILE}, an item, no dump): '
                    '「出せなかった」 (9), nothing else compared')
                # its only print line: done no (9「数字は作らない」: any other hold.<src>.<acct>.* line is a difference)
                lines[f'hold.{src}.{acct}.done'] = HL.NO
                continue
            rows = hold_rows(src, sigs, late, bars, period, acct)
            write_rows(os.path.join(mine_dir, 'signals.csv'), rows)
            meta = own_meta(period, acct)
            CMP.write_json(os.path.join(mine_dir, 'meta.json'), meta)
            dump = os.path.join(hold_dir, tag, 'dump')
            name = f'hold/{tag}/signals.csv'
            if os.path.isdir(dump):
                CMP.compare_csv(rep, name, os.path.join(mine_dir, 'signals.csv'), os.path.join(dump, 'signals.csv'),
                                ['pair', 'side', 'open', 'late'],
                                {'i': 'int', 'open': 'int', 'T': 'int', 'E': 'price', 'late': 'int', 'base': 'int',
                                 'side': 'dir'})
                try:
                    with open(os.path.join(dump, 'meta.json'), encoding='utf-8') as f:
                        tmeta = json.load(f)
                    # the dump's own meta (ownerhold's layout): the period, the money, the 5-minute step and P = T + 2 min
                    for k in ('start', 'end', 'split', 'startYen', 'cap', 'step', 'delay'):
                        if k not in tmeta or float(tmeta[k]) != float(meta[k]):
                            rep.add(f'hold/{tag}/meta.json', k, 'value')
                except (OSError, ValueError):
                    rep.add(f'hold/{tag}/meta.json', '-', 'unreadable')
            else:
                rep.add(name, '-', 'missing in ts')
            # the Python's own accounts on its own list (SQ-07); the limited rows and the opposite also follow their
            # P/L's largest fall (PR-8's maxDrawdown, research/chartbest-check-holdlines.py; nothing else changes)
            W = OH.World(gmo, mine_dir, rates, lambda m: None)
            th = OH.third(W)
            accs = {r: DDA(W, c['swap'], c['worst'], c['dep'], False).run() for r, c in OH.ACCOUNT_ROWS.items()}
            unl = {r: OH.Account(W, OH.ACCOUNT_ROWS[r]['swap'], OH.ACCOUNT_ROWS[r]['worst'], OH.ACCOUNT_ROWS[r]['dep'],
                                 True).run() for r in OH.UNLIMITED_ROWS}
            main = OH.ACCOUNT_ROWS['main']
            Wo = flipped_world(W, OH)
            opp = DDA(Wo, main['swap'], main['worst'], main['dep'], False).run()
            facts[(src, acct)] = account_facts(src, acct, W, accs, unl, opp, th, period, OH)
            with open(os.path.join(mine_dir, 'facts.json'), 'w', encoding='utf-8') as f:
                json.dump(facts[(src, acct)], f, ensure_ascii=False, indent=1, default=float)
            # PR-8: 9 の 1〜8 as the print lines hold.<src>.<acct>.<key>, from the same accounts
            own = HL.hold_lines(acct, W, Wo, {r: accs[r] for r in HT.ROWS}, unl, opp, th, facts[(src, acct)], period,
                                OH, PER_TRADE_USD_AT)
            for k, v in own.items():
                lines[f'hold.{src}.{acct}.{k}'] = v
            note = ''
            if os.path.isdir(dump):
                nc, nm = compare_dump(rep, tag, W, th, accs, unl, dump, gmo, OH, real and acct == 'full')
                note = f', the dump: compared {nc}, mismatched {nm}'
            log(f'hold {tag}: {len(rows)} signals ({sum(1 for r in rows if r["late"])} late), own accounts '
                f'{time.time() - t0:.1f}s{note}')
    # 21: for each source the second-half account's sentence, then the full account's; then the range sentence
    sentences = []
    for src in sources:
        for acct in ('h2', 'full'):
            sentences.append((f'hold.{src}.{acct}', HT.hold_text(facts[(src, acct)])))
    sentences.append(('always.s2.hold', HT.hold_range_text([facts[k] for k in facts])))
    py_tsv = os.path.join(out, 'hold', 'sentences.tsv')
    CMP.write_tsv(py_tsv, sentences)
    CMP.compare_tsv(rep, 'hold/sentences.tsv', py_tsv, os.path.join(hold_dir, 'sentences.tsv'))
    log(f'hold: {len(sentences)} owner-hold sentences written (py/hold/sentences.tsv) and compared')
    # PR-8: the print lines (9 の 1〜8 and the sentences, hold.text.<id>) against the TS's print.txt, by key
    for sid, text in sentences:
        lines[f'hold.text.{sid}'] = text
    CMP.write_tsv(os.path.join(out, 'hold', 'lines.tsv'), sorted(lines.items()))
    print_path = os.path.join(os.path.dirname(os.path.abspath(hold_dir)), 'print.txt')
    n, nd = HL.compare_print(rep, lines, print_path)
    log(f'hold: {len(lines)} print lines written (py/hold/lines.tsv); print.txt: compared {n} keys, {nd} differ')
