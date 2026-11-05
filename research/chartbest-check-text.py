#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
chartbest-check-text.py — the number formatting and the sentences of docs/OPERATIONS.md §8.113 21, re-written for
the independent Python re-computation (20 (d)「文は1字も違わない」).

Formatting (21「数字の書き方」): points (100 x the value) and % with 1 decimal, pips with 2, yen as an integer;
a sign on differences, hits and pips, none on win rates; the exact binary value rounded half up (Decimal
ROUND_HALF_UP of the float itself, as the TS's toFixed); an all-zero result is "+0.0" ("+0.00" for pips) whatever
the sign. In sentences a negative number is written with U+2212 '−' (SQ-32: SPEC.minusSign), dumps keep plain
numbers.
"""
import importlib.util
import os
import sys
from decimal import ROUND_HALF_UP, Decimal


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


def _sel():
    """The select module (loaded when a sentence needs it; it does not load this one at import)."""
    return _mod('select')


TEXT_MINUS = '\u2212'       # SQ-32: '−' in sentences (toFixed's '-' replaced)


def fixed(x, d):
    """JavaScript's x.toFixed(d) for a finite double (the exact binary value, ties away from zero), with the
    sentences' minus."""
    q = Decimal(1).scaleb(-d)
    s = format(Decimal(x).quantize(q, rounding=ROUND_HALF_UP), 'f')
    if s.startswith('-'):
        s = TEXT_MINUS + s[1:]
    return s


def signed(x, d):
    """A signed number: '+' on a positive (or all-zero) result."""
    s = fixed(x, d)
    body = s.lstrip(TEXT_MINUS)
    if all(ch in '0.' for ch in body):
        return '+' + body
    return s if s.startswith(TEXT_MINUS) else '+' + s


def pts(x):
    """A difference in points (100 x the value), 1 decimal, signed."""
    return signed(100 * x, 1)


def pct(p):
    """A win rate in %, 1 decimal, no sign."""
    return fixed(100 * p, 1) + '%'


def pct2(p):
    """The owner's way (§8.111): 2 decimals."""
    return fixed(100 * p, 2) + '%'


def pips(x):
    return signed(x, 2)


def yen(x, sign=False):
    """Yen as an integer with thousands separators (signed when asked)."""
    s = fixed(x, 0)
    neg = s.startswith(TEXT_MINUS)
    body = s.lstrip(TEXT_MINUS)
    body = f'{int(body):,}'
    if neg and body != '0':
        return TEXT_MINUS + body
    return ('+' + body) if sign else body


def count(n):
    """A count (integer) with thousands separators."""
    return f'{int(n):,}'


# ---------------------------------------------------------------- the pieces of 21
D_ = None


def _d():
    global D_
    if D_ is None:
        D_ = _mod('data')
    return D_


FEW = 30                                 # 9「決着が30回未満の行は、勝率を書かない（「数が少ない」と書く）」
FEW_TEXT = '数が少ない'
HUMAN_SLOT_CHECKED = '〈調べたこと〉'     # 21: filled by a person after the run (spec-questions.md)
HUMAN_SLOT_RESULT = '〈結果〉'
HUMAN_SLOT_FOUND = '〈誤りは見つかりませんでした／〈見つかった誤り〉が見つかり、直してやり直しました〉'
CAL_HEAD = 'これはチャートの形を読むやり方ではなく、時刻や暦の効果です。'
HOW = {'chart': '同じペア・同じ向き・同じ時間帯', 'cal': '同じペア・同じ向き'}
SUSPECT_NAMES = {           # 13's lines, as the condition names inside the sentences (SQ-33)
    'delta': '|Δ| ≧ 10ポイント', 'a': '|そろえない a| ≧ 10ポイント', 'w2': 'W2（決着の中）≧ 80%',
    'w1': 'W1（決着の中）≧ 90%', 'pl1': 'PL1 ≧ +1.00 pips', 'pl2': 'PL2 ≧ +3.00 pips',
    'zeroHundred': '勝率が0%か100%', 'lateGap': '|Δ − Δ_late| ≧ 5ポイント'}
BLIND_NAMES = {'BUY': 'ブラインドの買い', 'SELL': 'ブラインドの売り'}     # SQ-33


def name_of(src):
    """SQ-30: the ids of 3; the emails by their names."""
    return {'ultra5': 'ULTRA 5分足', 'macdx5': 'MACD の山・谷'}.get(src, src)


def rate(wp):
    return FEW_TEXT if wp['resolved'] < FEW else pct(wp['wRes'])


def pl(x):
    return pips(x) if x is not None else '—'


def p_or(x):
    return pts(x) if x is not None else '—'


def outcomes(row):
    """「利確10が先 ○%・1回あたり ○ pips（未決着 ○回）、損切り13・利確4の勝率 ○%・1回あたり ○ pips（未決着 ○回）」"""
    w10, w4 = row['w10'], row['w4']
    return (f'利確10が先 {rate(w10)}・1回あたり {pl(w10["pl"])} pips（未決着 {w10["open"]}回）、'
            f'損切り13・利確4の勝率 {rate(w4)}・1回あたり {pl(w4["pl"])} pips（未決着 {w4["open"]}回）')


def gt0(x):
    return x is not None and abs(x) >= 1e-12 and x > 0


def lt0(x):
    return x is not None and abs(x) >= 1e-12 and x < 0


# ---------------------------------------------------------------- stage 1 (21 段1の後)
def _s1_item(src, row):
    d = row['delta']
    a = row['a']
    return (f'{name_of(src)}（差 {p_or(d["est"])}ポイント、95%の幅 {p_or(d["lo"])}〜{p_or(d["hi"])}、{d["N"]}回。'
            f'鏡との差 a {p_or(a["est"])}ポイント、95%の幅 {p_or(a["lo"])}〜{p_or(a["hi"])}。{outcomes(row)}）')


def _none_part(group, sel):
    c = _sel().not_eligible_count(sel, group)
    head = 'チャートの形からは' if group == 'chart' else '時刻と暦からは'
    return f'{head}、選べる項目がありませんでした（疑う合図 {c["suspicious"]}個、差や幅が出せない {c["noT"]}個、差が0以下 {c["nonPositive"]}個）'


def stage1_sentences(sel, rows, counts, mrows, blind):
    """21 段1の後 (s1.summary or s1.none) and いつも添える文 (always.s1)."""
    M1c, M1t = counts['M1']['chart'], counts['M1']['cal']
    M1 = M1c + M1t
    out = []
    ch, ca = sel['chosen']['chart'], sel['chosen']['cal']
    if not ch and not ca:
        cc, ct = _sel().not_eligible_count(sel, 'chart'), _sel().not_eligible_count(sel, 'cal')
        c = {k: cc[k] + ct[k] for k in ('suspicious', 'noT', 'nonPositive')}
        text = (f'前半では、後半で確かめる項目を選べませんでした（床を通った{M1}項目のうち、疑う合図に当たった {c["suspicious"]}個、'
                f'差や幅が出せない {c["noT"]}個、差が0以下 {c["nonPositive"]}個。1つの項目は、この順で最初に当たった理由だけに数える）。')
        if c['suspicious']:
            text += (f'疑う合図に当たった項目は、測り方の誤りを調べ（{HUMAN_SLOT_CHECKED}）、誤りが見つからなくても、'
                     '決まりのとおり選んでいません。')
        text += ('後半は開けません。どのやり方も、目をつぶって入った場合より当たるとは言えません。今のメールは変えません。'
                 'オーナーの持ち方（指値・利確10・損切りなし）では、新しいやり方は1つも測っていません（後半へ進めた項目だけで測る決まりのため）。')
        out.append(('s1.none', text))
    else:
        K = len(ch) + len(ca)
        chart = ('チャートの形から' + '、'.join(_s1_item(s, rows[s]) for s in ch)) if ch else _none_part('chart', sel)
        if ca:
            cal = ('時刻と暦からは' + '、'.join(_s1_item(s, rows[s]) for s in ca) +
                   'を選びました（チャートの形を読むやり方ではなく、時刻や暦の効果です）。')
        else:
            cal = _none_part('cal', sel) + '。'
        lp = sel['lbPositive']
        sh = sel['shift95']
        text = (f'前半（2024年1月〜2025年5月、GMO の5分足、5ペア）で、床を通った{M1}項目（チャートの形 {M1c}・時刻と暦 {M1t}）の当たりを測りました。'
                '鏡との差 a は、合図の向きの勝率（利確10が損切り13より先）が、向きをコインで決めた場合より何ポイント高いかです。'
                '差（当たり）は、合図の a から、目をつぶって入った場合の a を引いた値です（目をつぶって入る所は、チャートの形では同じペア・同じ向き・同じ時間帯、時刻と暦では同じペア・同じ向きで、時間帯はそろえていません）。'
                f'幅の下の端が高い順に、後半で1回だけ確かめる{K}個を選びました: {chart}。{cal}'
                f'{M1}個から良いものを選んだので、前半の数字は良く見えやすく、まだ何も言えません。'
                f'前半で幅の下の端が0を超えたのは、チャートの形で {lp["chart"]["items"]}項目（重なりの組で {lp["chart"]["groups"]}組）、'
                f'時刻と暦で {lp["cal"]["items"]}項目（{lp["cal"]["groups"]}組）でした（kama-A・kama-B は1つと数えています）。'
                '同じ組の項目は似た所で合図を出すので、一緒に0を超えやすく、項目の数ほどの別々の証拠ではありません。'
                f'合図の時刻を週ごとまるごとずらした『でたらめな入り』でも、チャートの形では、0を超える数が {_int_or(sh["items"]["q95"])}項目'
                f'（{_int_or(sh["groups"]["q95"])}組）くらいまでは出ます（95%点）。一番の下の端も {p_or(sel["chanceLb"])}ポイントくらいになります。')
        out.append(('s1.summary', text))
    out.append(('always.s1', always_sentence(_always_rows(rows, mrows, blind, list(rows)), '前半')))
    return out


def _int_or(x):
    return '—' if x is None else str(int(x))


# ---------------------------------------------------------------- いつも添える文 (SQ-17)
def _always_rows(rows, mrows, blind, items):
    """The rows competing for the highest rate: the items (the table's order), ULTRA, MACD, the blind's two
    direction rows (SQ-17); a row needs 30 resolved trades of that exit."""
    out = []
    for s in sorted(items, key=_d().ORDER.get):
        out.append((name_of(s), rows[s]))
    for m in ('ultra5', 'macdx5'):
        if m in mrows:
            out.append((name_of(m), next(iter(mrows[m].values()))))
    for d in ('BUY', 'SELL'):
        out.append((BLIND_NAMES[d], blind[d]))
    return out


def _best(cands, leg):
    best = None
    for name, row in cands:
        wp = row[leg]
        if wp['resolved'] < FEW or wp['wRes'] is None:
            continue
        if best is None or wp['wRes'] > best[1]['wRes']:
            best = (name, wp)
    return best


def always_sentence(cands, half):
    b4, b10 = _best(cands, 'w4'), _best(cands, 'w10')

    def part(b):
        if b is None:
            return f'{FEW_TEXT}'
        return f'{pct(b[1]["wRes"])}（{b[0]}・{half}、決着の中、1回あたり {pl(b[1]["pl"])} pips）'
    return (f'損切り13の出口で、決着が30回以上の行（床を通った項目と物差し、その段で出した半分）のうち、一番高い勝率は、'
            f'利確4で {part(b4)}、利確10で {part(b10)}でした。損切り13・利確10で損益ゼロに要る勝率は約57%、利確4なら約76%です'
            '（どちらもスプレッドを引く前）。でたらめに入っても、ほぼこの割合になるので、やり方による差は小さく出ます。'
            '損切りなしの持ち方の勝率は、負けが確定しないので、作りの上で高く出ます。')


# ---------------------------------------------------------------- stage 2 (21 段2)
def _reason(code, row, st):
    if code == 'c2':
        bd = row['byDir']
        return f'買いか売りの片方で、当たりが0以下だった（買い {p_or(bd["BUY"]["est"])}・売り {p_or(bd["SELL"]["est"])}ポイント）'
    if code == 'c3':
        q = [p for p, b in row['byPair'].items() if b['N'] >= 30]
        up = [p for p in q if gt0(row['byPair'][p]['est'])]
        return f'当たりが0より上のペアが、{len(q)}ペアのうち {len(up)}ペアだけだった'
    if code == 'c4':
        lt = row['late']
        return f'5分遅れて入ると、当たりが0より大きいとは言えなかった（{p_or(lt["est"])}ポイント、幅 {p_or(lt["lo"])}〜{p_or(lt["hi"])}）'
    return f'疑う合図（{_suspect_names(row)}）に当たった'


def _suspect_names(row):
    """SQ-33: 13's own formulas, in 13's order, joined by '・'."""
    return '・'.join(SUSPECT_NAMES.get(x, x) for x in row['suspicious'])


def _failed(st, codes):
    return [c for c in codes if st[c] is False]


def _minus(row):
    """〈マイナスの文〉: PL1 or PL2 below 0."""
    parts = []
    if lt0(row['w4']['pl']):
        parts.append('損切り13・利確4')
    if lt0(row['w10']['pl']):
        parts.append('利確10')
    if not parts:
        return ''
    return f'当たりは0より上でも、{"と".join(parts)}の1回あたりの損益はマイナスです。'


def _paren(row, label_lo='直していない95%の幅', label_a='幅'):
    d, a = row['delta'], row['a']
    return (f'差 {p_or(d["est"])}ポイント、{label_lo} {p_or(d["lo"])}〜{p_or(d["hi"])}、{d["N"]}回。'
            f'鏡との差 a {p_or(a["est"])}ポイント、{label_a} {p_or(a["lo"])}〜{p_or(a["hi"])}。{outcomes(row)}')


def _vs_emails(it, K):
    du, dm = it['dU'], it['dM']
    if gt0(it['dUSimLb']) and gt0(it['dMSimLb']):
        return (f'今のメール2つ（ULTRA 5分足・MACD の山・谷）と比べても、当たりが高いと言えます（差 {p_or(du["est"])}・{p_or(dm["est"])}ポイント、'
                f'{K}個を確かめた分を直した下の端 {p_or(it["dUSimLb"])}・{p_or(it["dMSimLb"])}）。'
                'この差も、確かめの基準を通った項目についてだけ書くので、今のメールとの本当の差は、これより小さい見込みです。')
    if gt0(du['est']) and gt0(dm['est']):
        return (f'今のメール2つより点では高いですが、今のメールより当たると言えるほどの差ではありません（差 {p_or(du["est"])}・{p_or(dm["est"])}ポイント、'
                f'直していない95%の幅 {p_or(du["lo"])}〜{p_or(du["hi"])}・{p_or(dm["lo"])}〜{p_or(dm["hi"])}）。')
    low = [(n, e) for n, e in (('ULTRA 5分足', du), ('MACD の山・谷', dm)) if not gt0(e['est'])]
    return (f'今のメール（{"・".join(n for n, _ in low)}）より当たりが高くありませんでした'
            f'（差 {"・".join(p_or(e["est"]) for _, e in low)}ポイント）。')


def stage2_item(src, row, it, K, mrows, promote, group):
    how = HOW[group]
    d = row['delta']
    head = CAL_HEAD if group == 'cal' else ''
    j = it['judgment']
    w4, w10 = row['w4'], row['w10']
    mde = p_or(it['mde'])
    if j == 'confirmed':
        sim = it['simLb']
        sim_text = (f'{K}個を同時に直した、より厳しい下の端は {p_or(sim)}ポイントです。' if gt0(sim) else
                    f'{K}個を同時に直す、より厳しいやり方では、下の端は0を下回ります（{p_or(sim)}ポイント）。')
        u4, m4 = mrows['ultra5'][group]['w4'], mrows['macdx5'][group]['w4']
        cont = ('これからの足で、明らかに悪くなっていないかを1回だけ確かめてから（段3）、メールに足すかを決めてもらいます。'
                if promote == src else
                f'これからの確かめには進めません（このまとまりで段3に進めるのは{name_of(promote)}です。これは前もって決めた選び方によるもので、'
                f'{name_of(promote)}の方が当たるという意味ではありません）。')
        text = (f'選ぶのに使っていない後半（2025年5月19日〜2026年10月、GMO の5分足）で、{name_of(src)}の判断は、目をつぶって入った場合（{how}）より、'
                f'向きの当たりが {p_or(d["est"])}ポイント高く（直していない95%の幅 {p_or(d["lo"])}〜{p_or(d["hi"])}、{d["N"]}回）、'
                f'{K}個を確かめた分を直しても、0より大きいと言えます。'
                f'鏡との差 a（合図の向きの勝率〈利確10が損切り13より先〉が、向きをコインで決めた場合より何ポイント高いか）は {p_or(row["a"]["est"])}ポイント'
                f'（95%の幅 {p_or(row["a"]["lo"])}〜{p_or(row["a"]["hi"])}）です。'
                f'差は、この a から、目をつぶって入った場合（{how}）の a を引いた値です。'
                '後半は選ぶのに使っていないので、前半で選んだことによる上ぶれはありません。'
                f'ただし、この文は確かめの基準を通った時だけ書くので、{p_or(d["est"])}ポイントという差は、本当の差より大きめに出やすいです。'
                f'この数で、8割の確かさで見分けられる最小の差は {mde}ポイントです。'
                '出た差が小さいほど（とくに、この最小の差より小さい時は）、大きめに出ている分が大きい見込みです。'
                f'{sim_text}'
                f'メールと同じ出口（損切り13・利確4）では、後半の勝率（決着の中）{rate(w4)}・1回あたり {pl(w4["pl"])} pips（未決着 {w4["open"]}回を含む）。'
                f'同じ所に目をつぶって入った場合は {_rate_of(row["blindW1"])}・{pl(row["blindPl1"])} pips、'
                f'今の ULTRA 5分足は {rate(u4)}・{pl(u4["pl"])} pips、MACD の山・谷は {rate(m4)}・{pl(m4["pl"])} pips です'
                '（どれも後半、同じ数え方。今のメールの数字は、前に値段を見た期間のものです）。'
                '勝率の違いには、入る時間帯やスプレッドの違いも入るので、当たりの比べには上の差を使います。'
                f'利確10が先は、決着の中で {rate(w10)}・1回あたり {pl(w10["pl"])} pips（未決着 {w10["open"]}回）です。'
                f'{_vs_emails(it, K)}'
                f'5分遅れて入った場合の差は {p_or(row["late"]["est"])}ポイントでした。'
                f'{_minus(row)}'
                f'まだ決定ではありません。{cont}')
    elif j == 'partial' and it['form'] == 'i':
        why = '、'.join(_reason(c, row, it) for c in _failed(it, ('c2', 'c3')))
        text = (f'後半で、{name_of(src)}は、目をつぶって入った場合（{how}）より当たりが高いと、確かめた分を直しても言えました（{_paren(row)}）。'
                f'この差は、基準を通った時だけ書くので、大きめに出やすいです（この数で見分けられる最小の差は {mde}ポイント）。'
                f'{_minus(row)}しかし、{why}ので、決めた条件を満たしません。メールは変えません。'
                'それでも使うかは、オーナーが決めてください（その場合は、決めた条件ではなく、結果を見て決めたことになります）。')
    elif j == 'partial' and it['form'] == 'ro':
        why = '、'.join(_reason(c, row, it) for c in _failed(it, ('c2', 'c3', 'c4', 'c5')))
        only_c5 = _failed(it, ('c2', 'c3', 'c4', 'c5')) == ['c5']
        extra = ('この数では、Holm を通る差は、疑う合図の線より大きくなります。'
                 if only_c5 and it['passMin'] is not None and it['passMin'] >= 0.10 else '')
        text = (f'後半で、{name_of(src)}の数字は、疑う合図（{_suspect_names(row)}）に当たりました（{_paren(row)}）。'
                f'{_minus(row)}CLAUDE.md の決まりのとおり、まず測り方の誤りを疑い、{HUMAN_SLOT_CHECKED}を調べました。{HUMAN_SLOT_FOUND}。'
                f'誤りが見つからなくても、この数字から『当たる』とは言いません。{extra}'
                f'決めた条件（{why}）を満たさないので、メールは変えません。')
    elif j == 'partial':
        others = _failed(it, ('c2', 'c3'))
        also = f'また、{"、".join(_reason(c, row, it) for c in others)}。' if others else ''
        lt = row['late']
        text = (f'後半で、{name_of(src)}は、合図の足の終値で入ると、目をつぶって入った場合（{how}）より当たりが高く出ました（{_paren(row)}）。'
                f'この差は、基準を通った時だけ書くので、大きめに出やすいです（この数で見分けられる最小の差は {mde}ポイント）。'
                f'{_minus(row)}しかし、5分遅れて入ると、当たりが0より大きいとは言えませんでした（{p_or(lt["est"])}ポイント、95%の幅 {p_or(lt["lo"])}〜{p_or(lt["hi"])}）。'
                '終値の一時的なぶれ（気配の跳ね返り）で、見かけだけ当たっている疑いがあります。メールが届く約1分後に入った場合は、測っていません。'
                f'{also}決めた条件を満たさないので、メールは変えません。')
    elif j == 'bad':
        text = (f'後半で、{name_of(src)}の判断は、目をつぶって入った場合（{how}）より当たりが低い結果でした（{_paren(row, "幅")}）。')
        text += _suspect_tail(row)
    else:
        if d['t'] is None:
            a = row['a']
            text = (f'後半で、{name_of(src)}が、目をつぶって入った場合（{how}）より当たるとも、当たらないとも言えませんでした（{d["N"]}回。'
                    f'鏡との差 a {p_or(a["est"])}ポイント、幅 {p_or(a["lo"])}〜{p_or(a["hi"])}。{outcomes(row)}）。'
                    '差が無いという意味ではありません。（差と幅は出せませんでした）')
        else:
            text = (f'後半で、{name_of(src)}が、目をつぶって入った場合（{how}）より当たるとも、当たらないとも言えませんでした（{_paren(row, "幅")}）。'
                    f'差が無いという意味ではありません。この数では、{mde}ポイントより小さい差は、8割の確かさでは見分けられません。')
            if it['mde'] is not None and it['mde'] >= 0.10:
                text += (f'この {mde}ポイントは、疑う合図の線（10ポイント）より大きいので、この数では、疑う合図に当たらずに確かめられる差は'
                         'ほとんどありませんでした。')
        text += _suspect_tail(row)
    return head + text


def _rate_of(x):
    return pct(x) if x is not None else '—'


def _suspect_tail(row):
    if not row['suspicious']:
        return ''
    return f'この数字は疑う合図（{_suspect_names(row)}）に当たりました。{HUMAN_SLOT_CHECKED}を調べ、{HUMAN_SLOT_RESULT}。'


def stage2_final(st2, M1, K):
    conf = [s for s in st2['items'] if st2['items'][s]['judgment'] == 'confirmed']
    conf.sort(key=_d().ORDER.get)
    if not conf:
        return (f'アプリにない44のやり方（59項目。床を通ったのは{M1}項目）を測り、前半で選んだ{K}個を後半で確かめましたが、'
                '目をつぶって入った場合より当たると言える項目はありませんでした。この測り方では、どれが一番正確とは言えません。'
                '今のメール（ULTRA 5分足・MACD の山・谷）は変えません。')
    pc, pt = st2['promote']['chart'], st2['promote']['cal']
    comp = ''
    for g in ('chart', 'cal'):
        cg = [s for s in conf if _d().GROUP_OF[s] == g]
        if len(cg) == 1:
            comp += (f'{name_of(cg[0])}は、目をつぶって入った場合より当たると確かめられましたが、ほかのやり方より正確かは確かめていません'
                     f'（後半で確かめたのは{K}個だけで、ほかの{M1 - K}項目は後半を計算していません）。')
        elif not cg:
            comp += '確かめられた項目どうしの順位は、確かめていません。'
        else:
            comp += _dab_text(st2, g)
    return (f'アプリにない44のやり方（59項目）のうち、前半で選び、後半で確かめても当たると言えたのは{"、".join(name_of(s) for s in conf)}でした。'
            f'段3（これからの足での確かめ）に進めるのは、前もって決めた選び方（確かめた分を直した幅の下の端が一番高いもの）で、'
            f'チャートの形では{name_of(pc) if pc else "無し"}、時刻と暦では{name_of(pt) if pt else "無し"}です。'
            f'{comp}チャートの形の項目と、時刻と暦の項目は、測り方が違うので比べていません。')


def _dab_text(st2, g):
    a = st2['promote'][g]
    rows = [x for x in st2['dAB'] if x['A'] == a]
    better = [x for x in rows if lt0(x['est']['hi'])]
    if better:
        out = ''
        for x in better:
            e = x['est']
            out += (f'後半で確かめられたチャートの形の項目の中では、{name_of(x["B"])}の方が{name_of(a)}より当たると言えます'
                    f'（差 {p_or(e["est"])}ポイント、直していない95%の幅 {p_or(e["lo"])}〜{p_or(e["hi"])}）。'
                    f'{name_of(a)}を段3に進めるのは、前もって決めた選び方（直した下の端）によるもので、{name_of(a)}の方が当たるという意味ではありません。')
        return out
    if rows and all(gt0(x['est']['lo']) for x in rows):
        return (f'後半で確かめられたチャートの形の項目の中では、{name_of(a)}の方が{"・".join(name_of(x["B"]) for x in rows)}より当たると言えます'
                f'（差 {"・".join(p_or(x["est"]["est"]) for x in rows)}ポイント、直していない95%の幅の下の端 {"・".join(p_or(x["est"]["lo"]) for x in rows)}）。')
    parts = []
    for x in rows:
        e = x['est']
        parts.append(f'{name_of(a)}と{name_of(x["B"])}の差 {p_or(e["est"])}ポイント、幅 {p_or(e["lo"])}〜{p_or(e["hi"])}')
    return f'後半で確かめられたチャートの形の項目の中で、どれが一番当たるかは、この数では決められません（{"、".join(parts)}）。'


def stage2_sentences(st2, rows, mrows, blind, counts, chosen):
    M1 = counts['M1']['chart'] + counts['M1']['cal']
    K = len(chosen)
    out = []
    for s in sorted(chosen, key=_d().ORDER.get):
        g = _d().GROUP_OF[s]
        out.append((f's2.item.{s}', stage2_item(s, rows[s], st2['items'][s], K, mrows, st2['promote'][g], g)))
    out.append(('s2.final', stage2_final(st2, M1, K)))
    out.append(('always.s2', always_sentence(_always_rows(rows, mrows, blind, chosen), '後半')))
    return out
