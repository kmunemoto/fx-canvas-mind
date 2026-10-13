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

HOLD_TP = 10                 # 9: the owner's TP 10 pips (ultraLevels' TP2)
START_YEN, CAP_YEN = 300000.0, 1000000.0      # 9: 始めの資金30万円、入れられるお金は合計100万円まで
DELAY_MIN = 2                # 9 / §8.111 3: P = T + 2 min (late: base + 2 min)
ACCOUNTS = ('full', 'h2')
HEADER = ['i', 'pair', 'side', 'open', 'T', 'E', 'tp', 'late', 'base']
# §8.111 2「ULTRA の遅れた合図は、鮮度（freshFor("5min")＝10分）の中のものだけ」 and its review fix 2「「10分の中」を、
# ちょうど10分は入れない（厳密な「未満」）にした」: a read at r keeps a late signal of close T only when r − T < 10 min.
LATE_FRESH = 10 * D.MIN
# SQ-H6: the swap rows' rates. Made-up runs only use ownerhold-check.py's synthetic rates; the real stage 2 must pass
# the same BIS file as the TS before --hold is used on real data.
RATES = 'synthetic'
# hand.json fields.holdText「cappedCalls: [{tau: the call's notice time (ISO), …}]」: the time written for a capped call
# is its notice time τ + 35 min (§8.102「楽天の知らせの時刻 τ＋35分」), not the NY close τ (spec-questions SQ-PF1).
CAPPED_CALL_TIME = 'notice'
# The per-trade view's yen of a dollar pair (SQ-PF5): §8.102「ドルのペアは決済の時〈まだ持っているものは END〉のドル円の
# 中値で円にした」 with 値段の決まり「ある時刻 τ の値段は、τ 以前に終わる最後の1分足の終値」. 'exit': the price at the TP's
# recorded time x (the start of the 1-minute bar that reached it: the last bar ending at or before x) — the convention
# of the account rows (research/ownerhold-check.py, and the dump's trades, which agree). 'exitBarClose' (the
# alternative): the close of the TP's own bar (x + 1 min). A held trade is valued at END either way.
PER_TRADE_USD_AT = 'exit'


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
    capped = [c for c in acc.calls if c.uAfter is not None and c.uAfter > 0]   # §8.102 ①「…入金の後に U が残った追証」
    dead = [c for c in acc.calls if c.end == 'deadline']
    when = (lambda c: c.tau + OH.NOTICE_AFTER) if CAPPED_CALL_TIME == 'notice' else (lambda c: c.tau)
    return capped, dead, [{'tau': when(c), 'short': c.uAfter, 'end': c.end} for c in capped]


def row_facts(acc, W, OH):
    capped, dead, capped_calls = calls_of(acc, OH)
    A, B, S_ = ab_of(acc)
    return {'lcs': len(acc.lcs), 'deadlines': len(dead), 'capped': len(capped),
            'lcAt': [x['at'] for x in acc.lcs], 'deadlineAt': [c.endAt for c in dead], 'cappedCalls': capped_calls,
            'A': A, 'B': B, 'S': S_, 'inTotal': acc.summary['inEnd'],
            'placed': placed_of(acc.fate, range(len(W.sigs)))}


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
    capped, dead, _ = calls_of(opp, OH)
    o_view = trades_view(opp, W)
    opposite = dict(o_view, lcs=len(opp.lcs), deadlines=len(dead), capped=len(capped), S=ab_of(opp)[2])
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


def compare_dump(rep, tag, W, th, accs, unl, dump, gmo, OH):
    """The TS's hold dump against the Python's own World (the list was compared just before): ownerhold-check.py's
    comparators of §8.102 確かめ A — paths, emails' 1-day / 1-week values, ③, the five account rows and the four
    all-accepted rows (E*, M) — and its input checks (E against the 5-minute bars, TP = E ± 10 pips)."""
    C = _cmp_class(OH)()
    for msg in W.problems:
        C.bad('load', 'gmo', msg, None, None)
    OH.check_meta(C, W, False)
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


def compare_hold(rep, out, hold_dir, gmo, sources, sigs, late, bars, period, log):
    """Every (source, account) of 9: the list and meta against the dump; the Python's own accounts (ownerhold-check.py)
    against the dump; then the owner-hold sentences (hold.<src>.<acct>, always.s2.hold) against hold/sentences.tsv."""
    OH = ownerhold()
    facts = {}
    for src in sources:
        for acct in ACCOUNTS:
            t0 = time.time()
            tag = f'{src}-{acct}'
            mine_dir = os.path.join(out, 'hold', tag)
            os.makedirs(mine_dir, exist_ok=True)
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
            # the Python's own accounts on its own list (SQ-07)
            W = OH.World(gmo, mine_dir, RATES, lambda m: None)
            th = OH.third(W)
            accs = {r: OH.Account(W, c['swap'], c['worst'], c['dep'], False).run() for r, c in OH.ACCOUNT_ROWS.items()}
            unl = {r: OH.Account(W, OH.ACCOUNT_ROWS[r]['swap'], OH.ACCOUNT_ROWS[r]['worst'], OH.ACCOUNT_ROWS[r]['dep'],
                                 True).run() for r in OH.UNLIMITED_ROWS}
            main = OH.ACCOUNT_ROWS['main']
            opp = OH.Account(flipped_world(W, OH), main['swap'], main['worst'], main['dep'], False).run()
            facts[(src, acct)] = account_facts(src, acct, W, accs, unl, opp, th, period, OH)
            with open(os.path.join(mine_dir, 'facts.json'), 'w', encoding='utf-8') as f:
                json.dump(facts[(src, acct)], f, ensure_ascii=False, indent=1, default=float)
            note = ''
            if os.path.isdir(dump):
                nc, nm = compare_dump(rep, tag, W, th, accs, unl, dump, gmo, OH)
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
