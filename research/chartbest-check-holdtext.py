#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
chartbest-check-holdtext.py — the owner-hold sentences of docs/OPERATIONS.md §8.113 21 (〈オーナーの持ち方の文〉 and the
range sentence of いつも添える文), written for the independent Python re-computation (20 (d)「文は1字も違わない」).

Written 2026-10-13 by the step-2b Python fixer, who has not read any TypeScript of this job, from:
  * §8.113 21「オーナーの持ち方の文: §8.102 の ①②③ の文と添える文（§8.111 でもそのまま使ったもの）を、項目ごとに2回使う。
    先に後半だけの口座（9）で使い、頭に「選ぶのに使っていない後半（2025年5月19日〜）だけで、30万円から始めた口座では、」と
    付ける。この口座の文では、「2024〜2026年のデータ」を「後半（2025-05-19〜2026-10-10）のデータ」に替える。② は前半・後半に
    分けず、「口座の損益は ○円（入金を引いた額。4つの行それぞれ）、後半の合図すべてを数えた損益 M_h は ○円（スワップ無し・
    主のスワップ込み）」の形で書く。次に全期間の口座で使い、頭に「選ぶのに使った前半を含む全期間（良く見えやすい）では、」と
    付ける（今のメール2つは選んでいないので、頭は「全期間では、」とする）。新しい項目では、どちらの口座でも、(b) を言う2つの
    文を付けず…、文の「メール」は「合図」と書く。9 の L の文は、全期間の ③ の L で全期間の口座の文の後に、後半の ③ の L で
    後半だけの口座の文の後に、1回ずつ書く。」 and its range sentence (いつも添える文「段2でオーナーの持ち方の数字を並べる時は…」);
  * §8.102 決まり「書く文」(① ② ③ and「どの場合も、次を添える」) and「勝率の書き方」;
  * §8.113 9 (the two L sentences; 「出せなかった」);
  * the resolutions of the free parts SQ-08 and SQ-H1 (as python-issues.md's appendix A1 / A2 quotes them), with
    SQ-RC1 open (PLACED_SHARE below), and SQ-32 (U+2212 minus), SQ-P18 (counts without separators).

The facts of one account are the dict hand.json's `fields.holdText` describes (rows main / mainSwap / worst /
worstSwap, placedHalves, m, mh, third, win, opposite, perTrade, perTradeParts, src, account, email, timedOut);
times are integer ms (the hand runner converts hand.json's ISO strings). research/chartbest-check-hold.py builds the
same dict from research/ownerhold-check.py's accounts of a run. Nothing here reads a file.
"""
import datetime
import importlib.util
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


TX = _mod('text')

# ---------------------------------------------------------------- the fixed words (21, §8.102, SQ-08, SQ-H1)
HEAD_H2 = '選ぶのに使っていない後半（2025年5月19日〜）だけで、30万円から始めた口座では、'      # 21 (literal date, SQ-H1 1)
HEAD_FULL_ITEM = '選ぶのに使った前半を含む全期間（良く見えやすい）では、'                       # 21
HEAD_FULL_EMAIL = '全期間では、'                                                              # 21 (the two emails)
DATA = {'full': '2024〜2026年のデータ', 'h2': '後半（2025-05-19〜2026-10-10）のデータ'}       # §8.102 / 21's replacement
WORD = {True: 'メール', False: '合図'}                                                        # 21「文の「メール」は「合図」」
ROWS = ('main', 'mainSwap', 'worst', 'worstSwap')                                             # SQ-08: the rows' order
ROW_NAME = {'main': '主の行（スワップ無し・1分足の終値）', 'mainSwap': 'スワップ込み・1分足の終値',
            'worst': 'スワップ無し・一番悪い値', 'worstSwap': 'スワップ込み・一番悪い値'}        # SQ-08
MAIN_LITERAL = '主の行（1分足の終値・スワップ無し）'          # §8.102's own words in ①・② (kept as written)
WORST_ROWS = ('worst', 'worstSwap')
SWAP_ROWS = ('mainSwap', 'worstSwap')
CAVEAT_WORST = '両建ての買いと売りが同時に一番悪い値にいる、実際には起きない形も含む'          # §8.102 ①
CAVEAT_SWAP = 'スワップは目安で、取り分は仮の値'      # §8.102 ① (楽天の実績 never read here: always, SQ-H1 8)
DATES_MAX = 10                                         # SQ-08: at most 10 dates, then 「ほか ○件」
ENDING = {'settle': '決済の充当で解消', 'deadline': '期限の決済', 'lc': 'ロスカット',            # SQ-08
          'deposit': '入金で解消', 'open': 'END の時点で未解消'}                                 # SQ-H1 7
ENDINGS_ALWAYS = ('settle', 'deadline', 'lc')          # SQ-08's three, always written
ENDINGS_IF_ANY = ('deposit', 'open')                   # SQ-H1 7: only when not zero
# SQ-H1 3 / SQ-RC1 (open): 置けた割合 = the four parts of §8.102's 「うち」 (入った + 置いたが入らなかった + 追証で取り消された
# + ロスカットで取り消された) ÷ all the account's emails ('sum'); the alternative 'entered' is §8.111's 「入った件数 ÷ その
# 半分のメール」. A printed share only; nothing else moves.
PLACED_SHARE = 'sum'
HOLD_PCT_DIGITS = 2                                    # SQ-H1 12 (as §8.111 wrote the owner's way's %)
MISSING = '—'                                          # SQ-H1 11 / 14: a number that does not exist
TIMED_OUT = 'のオーナーの持ち方は出せなかった（計算が Actions の1 job の時間に収まらなかった）。'   # 9, SQ-H1 13
NO_STOP = '損切りが無いので、作りの上で高く出る。この持ち方がうまくいく証拠ではない。'          # §8.102 勝率の書き方
B_SENTENCE = ('(b) のこれからのメールで比べるのは、取引ごとの P から1日後の1回あたりが、過去の見込みの範囲に入るかだけ。'
              '範囲に入っても、勝てるとも、口座の①②を確かめたとも言えない。')                 # §8.102 (the emails only)
B_UNCHANGED = '(b) の結果で、この判断は変わらない（(b) では口座の①②を見ない）。'                # §8.102


# ---------------------------------------------------------------- numbers (21「数字の書き方」, SQ-H1 12)
def pct(x):
    """The owner's way's % (two decimals, no sign); the exact binary value of 100 x rounded half up."""
    if x is None:
        return MISSING + '%'
    return TX.fixed(100 * x, HOLD_PCT_DIGITS) + '%'


def pips(x):
    """Pips signed, two decimals; 「—」 when there is no number (SQ-H1 11)."""
    return MISSING if x is None else TX.pips(x)


def yen(x):
    """Unsigned yen (money put in, E*, U): whole with separators."""
    return MISSING if x is None else TX.yen(x, sign=False)


def syen(x):
    """Signed yen (P/L, M, S, 1回あたり)."""
    return MISSING if x is None else TX.yen(x, sign=True)


def when(ms):
    """SQ-08: 'YYYY-MM-DD HH:MM UTC'."""
    d = datetime.datetime.fromtimestamp(int(ms) / 1000, datetime.timezone.utc)
    return d.strftime('%Y-%m-%d %H:%M') + ' UTC'


def dates(times):
    """SQ-08: oldest first, joined by 「、」, at most DATES_MAX, then 「ほか ○件」."""
    ts = sorted(int(t) for t in times)
    out = '、'.join(when(t) for t in ts[:DATES_MAX])
    if len(ts) > DATES_MAX:
        out += f'、ほか {len(ts) - DATES_MAX}件'
    return out


def share(n, k):
    return None if not n else k / n


# ---------------------------------------------------------------- ① ② ③ by rows (§8.102 決まり)
def fails_one(r):
    """§8.102 ①: a row holds when its loss-cuts, deadline close-outs and capped calls are all 0."""
    return r['lcs'] > 0 or r['deadlines'] > 0 or r['capped'] > 0


def fails_two_row(r, account):
    """§8.102 ② on one account row: A and B > 0 (full); 21 / 9: the second-half account by its own P/L S > 0."""
    if account == 'h2':
        return not r['S'] > 0
    return not (r['A'] > 0 and r['B'] > 0)


def two_m(f):
    """§8.102 ②'s M: M1 and M2 > 0, without swap and with the main swap (full); 9: M_h > 0 for both (h2)."""
    if f['account'] == 'h2':
        return all(x is not None and x > 0 for x in f['mh'])
    return all(x is not None and x > 0 for k in ('none', 'swap') for x in f['m'][k])


def verdict_of(f):
    """{one, twoAccounts, twoM, three} from the facts (§8.102 ①②③; 9 for the second-half account)."""
    rows = f['rows']
    th = f.get('third')
    L = th.get('L') if th else None
    return {'one': not any(fails_one(rows[r]) for r in ROWS),
            'twoAccounts': not any(fails_two_row(rows[r], f['account']) for r in ROWS),
            'twoM': two_m(f),
            'three': L is not None and L > 0}


def endings_text(calls, always=ENDINGS_ALWAYS, if_any=ENDINGS_IF_ANY):
    n = {k: 0 for k in ENDING}
    for c in calls:
        n[c['end']] += 1
    parts = [f'{ENDING[k]} {n[k]}' for k in always] + [f'{ENDING[k]} {n[k]}' for k in if_any if n[k]]
    return '・'.join(parts)


def counts3(r):
    return f"ロスカット {r['lcs']}回・期限の決済 {r['deadlines']}回・上限で入金し切れなかった追証 {r['capped']}回"


def details(r):
    """§8.102「日時と、入金し切れなかった追証の終わり方」 (SQ-08): the parts with a count above 0, in （…）."""
    parts = []
    if r['lcs'] > 0:
        parts.append('ロスカットの日時 ' + dates(r['lcAt']))
    if r['deadlines'] > 0:
        parts.append('期限の決済の日時 ' + dates(r['deadlineAt']))
    if r['capped'] > 0:
        calls = r['cappedCalls']
        parts.append('入金し切れなかった追証の日時 ' + dates(c['tau'] for c in calls) + '、終わり方 ' + endings_text(calls))
    return '（' + '。'.join(parts) + '）' if parts else ''


def caveats(rows_failing):
    """SQ-H1 8: a 一番悪い値 row → the worst caveat; a スワップ込み row → the swap caveat (in this order)."""
    cs = []
    if any(r in WORST_ROWS for r in rows_failing):
        cs.append(CAVEAT_WORST)
    if any(r in SWAP_ROWS for r in rows_failing):
        cs.append(CAVEAT_SWAP)
    return '（' + '。'.join(cs) + '）' if cs else ''


def part_one(f, data, word):
    rows = f['rows']
    m = rows['main']
    if not any(fails_one(rows[r]) for r in ROWS):
        return (f'30万円の口座で、{data}では、ロスカットも、追証の期限の決済も、上限で入金し切れなかった追証も0回で、'
                f"入れたお金の合計は {yen(m['inTotal'])} 円だった（4つの行すべて）。")
    if m['lcs'] > 0 or m['deadlines'] > 0:
        out = f'この持ち方では、{data}で口座が守れなかった。'
        for r in ROWS:
            out += f'{ROW_NAME[r]}: {counts3(rows[r])}{details(rows[r])}。'
        return out
    if m['capped'] > 0:
        calls = sorted(m['cappedCalls'], key=lambda c: int(c['tau']))
        lst = '、'.join(f"{when(c['tau'])}・不足 {yen(c['short'])} 円・{ENDING[c['end']]}" for c in calls[:DATES_MAX])
        if len(calls) > DATES_MAX:
            lst += f'、ほか {len(calls) - DATES_MAX}件'
        settled = sum(1 for c in calls if c['end'] == 'settle')
        out = (f'{MAIN_LITERAL}では、ロスカットも期限の決済も0回だった。ただ、オーナーの決まり（追証は入金で解消・入れるのは'
               f"合計100万円まで）では、入金で解消し切れない追証が {m['capped']} 回あった（{lst}）。その間は新しい{word}を受けず、")
        if settled == len(calls):
            out += '決済の充当で期限の前に解消した。'
        else:
            others = [c for c in calls if c['end'] != 'settle']
            out += (f'決済の充当で期限の前に解消したのは {settled}回だった（ほかは '
                    f'{endings_text(others, always=(), if_any=("deadline", "lc", "deposit", "open"))}）。')
        out += '決めた持ち方のままで口座を守れたとは言えない。'
        for r in ROWS:
            out += f'{ROW_NAME[r]}: {counts3(rows[r])}。'
        return out
    failing = [r for r in ROWS[1:] if fails_one(rows[r])]
    out = f'{MAIN_LITERAL}では、ロスカット・期限の決済・上限で入金し切れなかった追証は、どれも0回。'
    for r in failing:
        out += f'{ROW_NAME[r]}では、{counts3(rows[r])}{details(rows[r])}。'
    return out + f'口座が守れたとは言えない{caveats(failing)}。'


def halves_m(f):
    (a1, a2), (b1, b2) = f['m']['none'], f['m']['swap']
    return f'前半 {syen(a1)} 円・後半 {syen(a2)} 円', f'前半 {syen(b1)} 円・後半 {syen(b2)} 円'


def part_two_full(f, word):
    rows = f['rows']
    m = rows['main']
    none_txt, swap_txt = halves_m(f)
    m_after = f'すべての{word}を数えると、{none_txt}（主のスワップ込みは{swap_txt}）。'
    acc_fail = [r for r in ROWS if fails_two_row(rows[r], 'full')]
    if not acc_fail:
        if two_m(f):
            return (f"前半・後半とも、口座は増えた（前半 {syen(m['A'])} 円・後半 {syen(m['B'])} 円・全期間 {syen(m['S'])} 円。"
                    f'入金を引いた額。4つの行すべて）。すべての{word}を数えても、前半・後半とも0より上だった（{none_txt}。'
                    f'主のスワップ込みは{swap_txt}）。')
        out = f"口座は前半・後半とも増えた（置けた割合 {pct(placed_share(m['placed']))}）。すべての{word}を数えると、"
        halves = []
        for k, name in enumerate(('前半', '後半')):
            a, b = f['m']['none'][k], f['m']['swap'][k]
            if not (a > 0 and b > 0):
                halves.append(f'{name}は {syen(min(a, b))} 円で0以下だった（スワップ無し {syen(a)} 円・主のスワップ込み '
                              f'{syen(b)} 円）')
        out += '。'.join(halves) + '。'
        p = m['placed']
        w = f['win']
        out += (f"口座の道筋では、置けなかった{word} {p['refusedMargin'] + p['refusedCall']} 件（有効証拠金 {p['refusedMargin']}・"
                f"追証の間 {p['refusedCall']}）、追証で取り消された指値 {p['cancelCall']} 件、ロスカットで取り消された指値 "
                f"{p['cancelLc']} 件を取らず、ロスカット・期限で {w['lc'] + w['deadline']} 件を途中で決済した。"
                f'すべての{word}の見方では、これらも最後まで数えた。この持ち方で増えるとは言えない。')
        return out
    if 'main' in acc_fail:
        bad = [(name, v) for name, v in (('前半', m['A']), ('後半', m['B'])) if not v > 0]
        out = (f"この持ち方では、{'・'.join(n for n, _ in bad)}の口座は増えなかった（"
               f"{'・'.join(f'{n} {syen(v)} 円' for n, v in bad)}、全期間では {syen(m['S'])} 円）。")
        for r in ROWS:
            x = rows[r]
            out += f"{ROW_NAME[r]}: 前半 {syen(x['A'])} 円・後半 {syen(x['B'])} 円・全期間 {syen(x['S'])} 円。"
        return out + m_after
    out = f"{MAIN_LITERAL}では、前半 {syen(m['A'])} 円・後半 {syen(m['B'])} 円・全期間 {syen(m['S'])} 円。"
    for r in acc_fail:
        x = rows[r]
        bad = [f'{n} {syen(v)} 円' for n, v in (('前半', x['A']), ('後半', x['B'])) if not v > 0]
        out += f"{ROW_NAME[r]}では{'・'.join(bad)}（全期間 {syen(x['S'])} 円）。"
    return out + f'口座が増えたとは言えない{caveats(acc_fail)}。' + m_after


def part_two_h2(f):
    rows = f['rows']
    s = '・'.join(f"{syen(rows[r]['S'])} 円" for r in ROWS)
    mh = '・'.join(f'{syen(x)} 円' for x in f['mh'])
    return (f'口座の損益は {s}（入金を引いた額。4つの行それぞれ）、後半の合図すべてを数えた損益 M_h は {mh}'
            f'（スワップ無し・主のスワップ込み）。')


def part_three(f, v, word):
    th = f.get('third') or {}
    if v['three']:
        out = (f"P から1日後の時点で、ペアと向きごとの平均をそろえた数字（主の数字 {pips(th.get('main'))} pips、区間の下の端 "
               f"{pips(th.get('L'))} pips）では、合図の向きは逆向きより良かった。利確まで持った全体での比べではない。"
               f"{word}ごとの単純な d の平均は {pips(th.get('plain'))} pips（{th.get('n')} 件）。")
        plain = th.get('plain')
        if plain is not None and not plain > 0:
            out += (f'すべての{word}をそのまま平均すると {pips(plain)} pips で、合図の向きは逆向きより良くなかった。'
                    '主の数字が除くのは、ペアごとに期間を通して一定のトレンドの分だけ。')
        return out
    out = 'P から1日後の時点で取引ごとに比べると、合図の向きが逆向きより良いとは言えない。'
    if v['twoAccounts'] and v['twoM']:
        out += '口座が増えた分を、合図の力とは言えない（損切りなし・利確だけという持ち方の作りで増えた分と、区別できない）。'
    o = f['opposite']
    out += (f"逆向きの取引だけで回した同じ口座では、勝率 {pct(o['rate'])}（利確 {o['tp']}・ロスカット {o['lc']}・期限の決済 "
            f"{o['deadline']}・END でまだ持っている {o['held']}）、1回あたり {pips(o['pips'])} pips・{syen(o['yen'])} 円、"
            f"ロスカット {o['lcs']} 回・期限の決済 {o['deadlines']} 回・上限で入金し切れなかった追証 {o['capped']} 回、"
            f"口座の損益 S {syen(o['S'])} 円。")
    return out


def placed_share(p):
    if PLACED_SHARE == 'sum':
        return share(p['n'], p['entered'] + p['unfilled'] + p['cancelCall'] + p['cancelLc'])
    return share(p['n'], p['entered'])


def placed_text(p, word):
    n = p['n']
    return (f"置けた割合 {pct(placed_share(p))}（うち、入った {pct(share(n, p['entered']))}・置いたが入らなかった "
            f"{pct(share(n, p['unfilled']))}・追証で取り消された {pct(share(n, p['cancelCall']))}・ロスカットで取り消された "
            f"{pct(share(n, p['cancelLc']))}。どれも全{word}に対する割合）")


def part_added(f, v, data, word):
    """§8.102「どの場合も、次を添える」 with SQ-H1 2, 3, 10."""
    rows = f['rows']
    m = rows['main']
    out = f"30万円の口座で、{placed_text(m['placed'], word)}。"
    if f['account'] == 'full':
        h1, h2 = f['placedHalves']
        out += f'前半は{placed_text(h1, word)}、後半は{placed_text(h2, word)}。'
    out += f"入れたお金の合計 {yen(m['inTotal'])} 円。"
    for r in ROWS[1:]:
        x = rows[r]
        if fails_one(x) or fails_two_row(x, f['account']):
            out += f"{ROW_NAME[r]}では、{placed_text(x['placed'], word)}、入れたお金の合計 {yen(x['inTotal'])} 円。"
    w, o = f['win'], f['opposite']
    out += (f"勝率 {pct(w['rate'])}（利確 {w['tp']}・ロスカット {w['lc']}・期限の決済 {w['deadline']}・END でまだ持っている "
            f"{w['held']}。1回あたり {pips(w['pips'])} pips・{syen(w['yen'])} 円、ロスカット {w['lcEvents']} 回、"
            f"E* {yen(w['estar'])} 円。逆向きの取引だけの同じ口座では {pct(o['rate'])}）。" + NO_STOP)
    holds = v['one'] and v['twoAccounts'] and v['twoM']
    if holds:
        out += f'これは{data}での結果で、これからも口座が増えるとは言えない。'
    elif f['email']:
        out += B_UNCHANGED
    if f['email']:
        out += B_SENTENCE
    return out


def part_l(f, v):
    """9's L sentence after the per-trade view's win rates (SQ-H1 11), and §8.102 勝率の書き方's sentence."""
    t = f['perTrade']
    th = f.get('third') or {}
    out = (f"取引ごとの見方では、勝率 {pct(t['rate'])}（利確 {t['tp']}・END でまだ持っている {t['held']}。1回あたり "
           f"{pips(t['pips'])} pips・{syen(t['yen'])} 円）、逆向きでは {pct(t['oppRate'])}（1回あたり {pips(t['oppPips'])} pips・"
           f"{syen(t['oppYen'])} 円）。")
    if not v['three']:
        out += (f"この高い勝率は、損切りなし・利確10・END まで持つ作りで高く出ている。合図の力による分があるとは言えない（逆向き"
                f"でも {pct(t['oppRate'])}。P から1日後の比べは、主の数字 {pips(th.get('main'))} pips、下の端 "
                f"{pips(th.get('L'))} pips）。")
    else:
        diff = None if t['rate'] is None or t['oppRate'] is None else (t['rate'] - t['oppRate']) * 100
        out += (f"勝率の高さは、逆向きでも {pct(t['oppRate'])} になる作り（損切りなし・利確10・END まで持つ）で出ている。"
                f"合図の向きと逆向きの差は、P から1日後の比べで主の数字 {pips(th.get('main'))} pips・下の端 "
                f"{pips(th.get('L'))} pips で、勝率の差（{MISSING if diff is None else TX.signed(diff, HOLD_PCT_DIGITS)}"
                f'ポイント）を合図の力の大きさとは読まない。')
    return out + NO_STOP


def head_of(f):
    if f['account'] == 'h2':
        return HEAD_H2
    return HEAD_FULL_EMAIL if f['email'] else HEAD_FULL_ITEM


def hold_text(f):
    """〈オーナーの持ち方の文〉 of one source and one account (21; SQ-H1 1: head + ① + ② + ③ + 添える文 + 9's L)."""
    head = head_of(f)
    if f.get('timedOut'):
        return head + TX.name_of(f['src']) + TIMED_OUT
    data = DATA[f['account']]
    word = WORD[bool(f['email'])]
    v = verdict_of(f)
    two = part_two_h2(f) if f['account'] == 'h2' else part_two_full(f, word)
    return (head + part_one(f, data, word) + two + part_three(f, v, word) + part_added(f, v, data, word) +
            part_l(f, v))


def _range(xs, fmt, unit=''):
    xs = [x for x in xs if x is not None]
    if not xs:
        return MISSING
    return f'{fmt(min(xs))}{unit}〜{fmt(max(xs))}{unit}'


def hold_range_text(accounts):
    """21's range sentence (SQ-H1 14): per trade from the finished full accounts' whole / first / second-half rows;
    the account from every finished account (full and second-half); a timed-out account is left out."""
    done = [a for a in accounts if not a.get('timedOut')]
    parts = [p for a in done if a['account'] == 'full' for p in a['perTradeParts']]
    wins = [a['win'] for a in done]
    return ('この報告の、損切りなしの持ち方の勝率は、取引ごとの見方で '
            f"{_range([p['rate'] for p in parts], pct)}（1回あたり {_range([p['pips'] for p in parts], pips)} pips。"
            f"逆向きでは {_range([p['oppRate'] for p in parts], pct)}・{_range([p['oppPips'] for p in parts], pips)} pips）、"
            f"口座では {_range([w['rate'] for w in wins], pct)}（1回あたり {_range([w['pips'] for w in wins], pips)} pips）です。"
            'END でまだ持っている取引・最大の逆行・持った期間・ロスカットと期限の決済の回数・入金の合計は、項目ごとに下に並べます。')
