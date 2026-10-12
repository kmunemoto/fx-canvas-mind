#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
chartbest-check-select.py — stage 1 (12) and stage 2 (14-16) of the independent Python re-computation of
docs/OPERATIONS.md §8.113: eligibility, the ranking by the low end, the choice per group with the overlap groups,
the descriptive counts (LB > 0, the week shift's 95% points, the chance low end), Holm over both groups, C1-C5,
the judgments, the promotion, D_U / D_M / D_AB, MDE, the marks and the intervals seen.

Interpretations (spec-questions.md):
  * NOT_ELIGIBLE_ORDER: an item not eligible is counted under the first of suspicious, no t, Δ <= 0 (21).
  * C2_VACUOUS: a both-direction item with no direction holding 30 e-signals passes C2 (nothing to fail).
  * C2_C3_NOT_APPLIED: a condition not applied to an item (C2 for one-direction items, C3 when q < 3) counts as met.
  * HOLM_T_NONE_LAST: an item without t has p = 1 and sorts after every t (14).
  * INTERVALS_S2_*: the count per stage as itemised in intervals_parts() below (SQ-P11).
"""
import importlib.util
import math
import os
import sys


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
ST = _mod('stats')

NOT_ELIGIBLE_ORDER = ('suspicious', 'noT', 'nonPositive')
MIN_E_C2C3 = 30          # 14 C2 / C3: directions / pairs with >= 30 e-signals
MARK_LINE = 0.10         # 16: the 10-point marks
MARK_PASS_MIN, MARK_MDE = 'passMin', 'mde'         # the marks' names (11, 16; names only)
# 14: a condition not applied to an item is written null (c2c3Applied says which were applied); the judgment
# counts it as met
C2_C3_NOT_APPLIED = None


# ---------------------------------------------------------------- stage 1 (12)
def eligibility(row, counts_only):
    """The first reason an item is not eligible, or None (floor and the checks are given)."""
    if row['suspicious'] and not counts_only:
        return 'suspicious'
    if row['delta']['t'] is None:
        return 'noT'
    if not ST.gt0(row['delta']['est']):
        return 'nonPositive'
    return None


def rank_key(src, row):
    """12: LB descending, then e-signals descending, then the table's order."""
    return (-row['delta']['lb'], -row['nE'], D.ORDER[src])


def stage1(rows, groups, counts_only=False):
    """rows: {item: row (its group's layer, H1)} of the floor-passing items; groups: {item: group id}."""
    reasons, eligible = {}, []
    for src in sorted(rows, key=D.ORDER.get):
        r = eligibility(rows[src], counts_only)
        if r is None:
            eligible.append(src)
        else:
            reasons[src] = r
    ranking = sorted(eligible, key=lambda s: rank_key(s, rows[s]))
    chosen = {'chart': [], 'cal': []}
    taken = set()
    for src in ranking:
        g = D.GROUP_OF[src]
        if len(chosen[g]) >= (D.K_CHART if g == 'chart' else D.K_CAL):
            continue
        if groups.get(src) in taken:
            continue
        chosen[g].append(src)
        taken.add(groups.get(src))
    lbpos = {}
    for g in ('chart', 'cal'):
        items = [s for s in rows if D.GROUP_OF[s] == g and ST.gt0(rows[s]['delta']['lb'])]
        lbpos[g] = {'items': item_count(items), 'groups': group_count(items, groups)}
    out = {
        'eligible': eligible,
        'notEligible': reasons,
        'notEligibleCount': {g: not_eligible_count({'notEligible': reasons}, g) for g in ('chart', 'cal')},
        'ranking': [{'src': s, 'lb': rows[s]['delta']['lb'], 'nE': rows[s]['nE'], 'order': D.ORDER[s]} for s in ranking],
        'chosen': chosen,
        'Ktotal': len(chosen['chart']) + len(chosen['cal']),
        'lbPositive': lbpos,
    }
    out.update(shift_counts(rows, groups))
    return out


# 10, 12: kama-A and kama-B give the same signals (3, C24), so they count as one item among the items above 0
SAME_SIGNAL_ITEMS = (('kama-A', 'kama-B'),)


def item_count(ids):
    """10/12「0を超えた項目の数」: distinct items, kama-A and kama-B counted once."""
    xs = set(ids)
    n = len(xs)
    for grp in SAME_SIGNAL_ITEMS:
        k = sum(1 for x in grp if x in xs)
        if k > 1:
            n -= k - 1
    return n


def group_count(ids, groups):
    """10/12: the number of overlap groups (11) the items fall in."""
    return len({groups.get(s, s) for s in ids})


def p95_of(xs):
    """10: the 95% point, the floor(0.95 x (n - 1))-th of the ascending list (None for an empty list)."""
    if not xs:
        return None
    s = sorted(xs)
    return s[int(math.floor(0.95 * (len(s) - 1)))]


def not_eligible_count(sel, group):
    """21: the not-eligible items of a group counted under their first reason (suspicious, no t, Δ <= 0)."""
    return {k: sum(1 for s, r in sel['notEligible'].items() if r == k and D.GROUP_OF[s] == group)
            for k in NOT_ELIGIBLE_ORDER}


def shift_counts(rows, groups):
    """10/12: per k, over the floor-passing chart items, Δ_k - t(0.975, df) x SE (the item's own SE and df): the
    number of items above 0 and of their groups; the max (the chance low end). Their means and 95% points."""
    chart = [s for s in rows if D.GROUP_OF[s] == 'chart' and rows[s].get('_shifts') is not None]
    by_k = {}
    for s in chart:
        d = rows[s]['delta']
        use = next((c for c in d['cands'] if c['kind'] == d['use']), None)
        if use is None or d['t'] is None:
            continue
        for k, dk, _, _ in rows[s]['_shifts']:
            if dk is None:
                continue
            by_k.setdefault(k, []).append((s, dk - use['half']))
    items, grps, best = [], [], []
    for k in sorted(by_k):
        xs = by_k[k]
        above = [s for s, v in xs if ST.gt0(v)]
        items.append(item_count(above))
        grps.append(group_count(above, groups))
        best.append(max(v for _, v in xs))

    def mean(v):
        acc = 0.0
        for x in v:
            acc += x
        return acc / len(v) if v else None

    q95 = p95_of
    return {'shift95': {'items': {'mean': mean(items), 'q95': q95(items)},
                        'groups': {'mean': mean(grps), 'q95': q95(grps)}, 'k': len(items)},
            'chanceLb': q95(best)}


def yardstick_hit(measure_rows, blind):
    """13: whether a yardstick hit stops everything (SQ-16: the blind's BUY and SELL rows, the emails' rows)."""
    return bool(yardstick_hits(measure_rows, blind))


def yardstick_hits(measure_rows, blind):
    """13: the yardsticks' (the blind, ULTRA, MACD) suspicious hits, '<src> <layer or direction> <line>'; any hit
    stops everything (unless the set counts suspicion only)."""
    out = []
    for src in D.MEASURES:
        for layer, row in (measure_rows.get(src) or {}).items():
            out += [f'{src} {layer} {x}' for x in row['suspicious']]
    for d in ('BUY', 'SELL'):
        out += [f'blind {d} {x}' for x in blind[d]['suspicious']]
    return out


# ---------------------------------------------------------------- stage 2 (14-16)
def used_cand(est):
    return next((c for c in est['cands'] if c['kind'] == est['use']), None)


def p_of(est):
    """14: one-sided p = 1 - T(t, df); 1 without t."""
    c = used_cand(est)
    if est['t'] is None or c is None:
        return 1.0
    return 1 - ST.tcdf(est['t'], c['df'])


def holm(items, rows, plant=''):
    """14: Holm over the K_total items, p from each item's own t (p_of)."""
    return holm_order([(s, p_of(rows[s]['delta']), rows[s]['delta']['t'], rows[s]['nE']) for s in items], plant)


def holm_order(entries, plant=''):
    """14: entries (src, p, t or None, e-signals). p ascending (then t descending, e-signals descending, the table's
    order); the k-th passes while p <= 0.025 / (K - k + 1); the first failure stops it."""
    K = len(entries)

    def key(e):
        s, p, t, ne = e
        return (p, -(t if t is not None else -math.inf), -ne, D.ORDER[s])
    out = {}
    going = True
    for k, (s, p, _, _) in enumerate(sorted(entries, key=key), start=1):
        lim = D.ALPHA / (K - k + 1) if plant != 'noHolm' else D.ALPHA
        ok = going and p <= lim
        if plant != 'noHolm' and not ok:
            going = False
        out[s] = {'p': p, 'holmRank': k, 'holmPass': bool(ok)}
    return out


def mde_of(est, K):
    c = used_cand(est)
    if c is None or est['t'] is None:
        return None, None, None
    q1 = ST.tq(1 - D.ALPHA / K, c['df'])
    q8 = ST.tq(0.80, c['df'])
    return (q1 + q8) * c['se'], q1 * c['se'], est['est'] - q1 * c['se']


def stage2(chosen, rows, measure_rows, both_dirs, counts_only=False, plant=''):
    """chosen: the K_total items; rows: {item: row (its layer, H2)}; measure_rows: {measure: {layer: row}}."""
    K = len(chosen)
    hm = holm(chosen, rows, plant)
    items = {}
    for s in chosen:
        r = rows[s]
        d = r['delta']
        c = used_cand(d)
        c1 = hm[s]['holmPass']
        # C2 / C3 not applied are written C2_C3_NOT_APPLIED and count as met (a judgment tests `is not False`);
        # c2c3Applied says which were applied (14「C2・C3 を当てない項目は、そう書く」)
        c2_app = both_dirs.get(s, False)
        c2 = C2_C3_NOT_APPLIED
        if c2_app:
            c2 = True
            for dn in ('BUY', 'SELL'):
                bd = r['byDir'][dn]
                if bd['N'] >= MIN_E_C2C3 and not ST.gt0(bd['est']):
                    c2 = False
        q = [p for p, bp in r['byPair'].items() if bp['N'] >= MIN_E_C2C3]
        q_pos = sum(1 for p in q if ST.gt0(r['byPair'][p]['est']))
        c3_app = len(q) >= 3
        c3 = C2_C3_NOT_APPLIED
        if c3_app:
            c3 = q_pos > len(q) / 2
        c4 = ST.gt0(r['late']['lo'])
        c5 = not r['suspicious'] or counts_only
        if all(x is not False for x in (c1, c2, c3, c4, c5)) and c1:
            judgment, form = 'confirmed', None
        elif d['hi'] is not None and ST.lt0(d['hi']):
            judgment, form = 'bad', None
        elif c1:
            judgment = 'partial'
            form = 'ro' if not c5 else ('ha' if not c4 else 'i')
        else:
            judgment, form = 'cannot', None
        mde, pass_min, sim_lb = mde_of(d, K)
        marks = []
        if pass_min is not None and pass_min >= MARK_LINE:
            marks.append(MARK_PASS_MIN)
        if mde is not None and mde >= MARK_LINE:
            marks.append(MARK_MDE)
        layer = D.GROUP_OF[s]
        du = ST.diff_est(d, measure_rows['ultra5'][layer]['delta'])
        dm = ST.diff_est(d, measure_rows['macdx5'][layer]['delta'])
        items[s] = {'p': hm[s]['p'], 't': d['t'], 'df': c['df'] if c else None,
                    'holmRank': hm[s]['holmRank'], 'holmPass': hm[s]['holmPass'],
                    'c1': c1, 'c2': c2, 'c3': c3, 'c4': c4, 'c5': c5,
                    'c2c3Applied': {'c2': c2_app, 'c3': c3_app},
                    'judgment': judgment, 'form': form, 'mde': mde, 'passMin': pass_min, 'simLb': sim_lb,
                    'dU': ST.strip(du), 'dM': ST.strip(dm),
                    'dUSimLb': sim_low(du, K), 'dMSimLb': sim_low(dm, K), 'marks': marks}
    promote = {}
    for g in ('chart', 'cal'):
        conf = [s for s in chosen if D.GROUP_OF[s] == g and items[s]['judgment'] == 'confirmed']
        if not conf:
            promote[g] = None
            continue
        promote[g] = sorted(conf, key=lambda s: (-items[s]['simLb'], -rows[s]['nE'], D.ORDER[s]))[0]
    dab = []
    for g in ('chart', 'cal'):
        a = promote[g]
        if a is None:
            continue
        for b in chosen:
            if b != a and D.GROUP_OF[b] == g and items[b]['judgment'] == 'confirmed':
                dab.append({'A': a, 'B': b, 'est': ST.strip(ST.diff_est(rows[a]['delta'], rows[b]['delta']))})
    return {'items': items, 'promote': promote, 'dAB': dab, 'Ktotal': K}


def sim_low(est, K):
    """14: D - t(1 - 0.025 / K_total, df) x SE (the D's own chosen candidate)."""
    c = used_cand(est)
    if c is None or est['t'] is None:
        return None
    return est['est'] - ST.tq(1 - D.ALPHA / K, c['df']) * c['se']


# 15 (SQ-P11): the yardsticks' printed intervals in stage 2, which the rule leaves to "プログラムが数えて出す".
# The Python counts every interval its stage-2 stats carry for them: per email and layer Δ, a and Δ_late; per email
# W1, PL1, W2, PL2; per blind pair x direction row a, W1, PL1, W2, PL2.  (The TS's mini-N101 run printed 44 for
# K_total = 2, which these give as 88; 44 would follow from per email and layer Δ and a only, and per blind row a
# only.  Changing these three constants changes the count; nothing else depends on it.)
INTERVALS_S2_EMAIL_LAYER = ('delta', 'a', 'late')
INTERVALS_S2_EMAIL_WINPL = ('w1', 'pl1', 'w2', 'pl2')
INTERVALS_S2_BLIND_ROW = ('a', 'w1', 'pl1', 'w2', 'pl2')


def intervals_parts(stage, M1=0, K=0, n_dab=0):
    """15: the 95% intervals made from outcomes and printed, itemised."""
    if stage == 0:
        return {}
    n_email, n_layer, n_blind = len(D.MEASURES), 2, 10
    if stage == 1:
        # 15 段1: M_1 Δ, M_1 a, the emails' Δ and a in two layers (8), the blind pair x direction a (10)
        return {'delta': M1, 'a': M1, 'measures': n_email * n_layer * 2, 'blind': n_blind}
    return {'holm': K, 'late': K, 'a': K, 'winpl': 4 * K, 'dUdM': 2 * K, 'dAB': n_dab,
            'measures': n_email * n_layer * len(INTERVALS_S2_EMAIL_LAYER) + n_email * len(INTERVALS_S2_EMAIL_WINPL),
            'blind': n_blind * len(INTERVALS_S2_BLIND_ROW)}


def intervals_seen(stage, M1=0, K=0, n_dab=0):
    """15: the count for a stage, itemised, with its total (stage 0: total 0)."""
    out = dict(intervals_parts(stage, M1, K, n_dab))
    out['total'] = sum(out.values())
    return out
