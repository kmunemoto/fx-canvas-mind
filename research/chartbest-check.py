#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
chartbest-check.py — the independent Python re-computation of docs/OPERATIONS.md §8.113 20 (d) (#318, step 2
"試し": the blind table, donchian-A20/A55, breedon-1/2, ULTRA 5分足 and MACD の山・谷).

Written by another agent from §8.113, the sections 20 (d) lets it read (§8.102's sent signals, §8.106 段1 1-3,
§8.107 2-4 and 7, §8.109 合図の決まり 1-9, §8.111) and the plan's dump formats, never from research/chartbest*.ts.
It makes its own bars, signals (the items' and the two emails'), blind table, trades, statistics, choices,
judgments and sentences into <out> (py/), and only then opens the TS's dumps (<ts>) to compare them file by file:
integers and strings exactly, reals within 1e-9, sentences character for character; a difference is printed as
"DIFFER <file> <key> <column>" (never a value), and the run ends "PYTHON CHECK FAILED" (exit 1). Exit 2: an input
error (nothing compared). The helper files research/chartbest-check-*.py are loaded by path (CI runs python3 -I).

Usage:
  python3 -I research/chartbest-check.py --mode hand [--hand research/chartbest/hand.json] [--plant NAME]
  python3 -I research/chartbest-check.py --mode run --gmo OUT/gmo --ts OUT/ts --out OUT/py [--period main|mini]
         [--full] [--o-mode] [--force-choice id,id | --choice-ledger FILE [--choice-sha256 HEX]] [--stages 0,1,2]
         [--n-summary FILE] [--counts-only-suspicion] [--plant NAME] [--no-compare] [--strict-format]
         [--hold [--hold-dir DIR] [--bis-csv FILE --bis-sha256 HEX]]
Never reads real prices by itself: --gmo is a folder of day files written by the made-up generator (the real stage
modes of the TS feed it real files only after their own gates, 22). A --gmo under research/.cache is real data: the
second half is then opened only from --choice-ledger read against CHOICE_LEDGER_SHA256 (12, 14), only with --hold,
whose swap rows read the BIS file --bis-csv against --bis-sha256 (the TS's CB_BIS_CSV), and the made-up options are
refused.
"""
import argparse
import hashlib
import importlib.util
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)


def _mod(name):
    key = f'cbcheck_{name}'
    if key in sys.modules:
        return sys.modules[key]
    path = os.path.join(HERE, f'chartbest-check-{name}.py')
    spec = importlib.util.spec_from_file_location(key, path)
    m = importlib.util.module_from_spec(spec)
    sys.modules[key] = m
    spec.loader.exec_module(m)
    return m


D = _mod('data')
S = _mod('signals')
CNT = _mod('count')
ST = _mod('stats')
SEL = _mod('select')
TX = _mod('text')
CMP = _mod('compare')
CAN = _mod('canon')


def die(msg):
    print('ERROR: ' + msg, file=sys.stderr)
    print('PYTHON CHECK FAILED')
    sys.exit(2)


def sha256_of(path):
    with open(path, 'rb') as f:
        return hashlib.sha256(f.read()).hexdigest()


def log(msg):
    print(msg, flush=True)


# ---------------------------------------------------------------- the Python's own dumps
def write_stage0(out, bars, sigs, pre, holes, counts):
    for pb in bars:
        d = pb.digits
        rows = [[str(i), str(int(pb.t[i])), D.price_str(pb.mo[i], d), D.price_str(pb.mh[i], d),
                 D.price_str(pb.ml[i], d), D.price_str(pb.mc[i], d)] for i in range(pb.n)]
        CMP.write_csv(os.path.join(out, f'bars-{pb.sym}.csv'), ['i', 't', 'mo', 'mh', 'ml', 'mc'], rows)
    rows = [[s.src, s.pair, str(s.i), str(s.T), S.DIR_NAME[s.dir], D.price_str(s.E, D.digits_of(s.pair)), s.reason,
             s.half or '-', ';'.join(s.marks)] for s in sigs]
    CMP.write_csv(os.path.join(out, 'signals.csv'), ['src', 'pair', 'i', 'T', 'dir', 'E', 'reason', 'half', 'marks'], rows)
    rows = []
    for src in D.TRIAL_ITEMS + D.MEASURES:
        for pair in D.PAIRS:
            c = pre.get((src, pair))
            if c is not None:
                rows.append([src, pair] + [str(c[k]) for k in ('bothSuppressed', 'firstSkipped', 'nullPrevSkipped', 'late')])
    CMP.write_csv(os.path.join(out, 'prefilter.csv'),
                  ['src', 'pair', 'bothSuppressed', 'firstSkipped', 'nullPrevSkipped', 'late'], rows)
    rows = [[pb.pair, str(a), str(b)] for pb in bars for a, b in holes[pb.pi]]
    CMP.write_csv(os.path.join(out, 'holes.csv'), ['pair', 'a', 'b'], rows)
    CMP.write_json(os.path.join(out, 'counts.json'), counts)


BLIND_HEADER = ['pair', 'k', 'T', 'E', 'hour', 'season', 'week', 'block',
                'b4k', 'b4p', 'b4n', 's4k', 's4p', 's4n', 'b10k', 'b10p', 'b10n', 's10k', 's10p', 's10n', 'eBuy']


def write_blind(out, table, bars):
    rows = []
    for bp in table.pairs:
        d = D.digits_of(bp.pair)
        for r in range(bp.k.size):
            row = [bp.pair, str(int(bp.k[r])), str(int(bp.T[r])), D.price_str(float(bp.E[r]), d), str(int(bp.hour[r])),
                   str(int(bp.season[r])), str(int(bp.week[r])), str(int(bp.block[r]))]
            for leg in ('b4', 's4', 'b10', 's10'):
                row += [ST.KIND_LETTER[int(bp.kind[leg][r])], CMP.js_num(float(bp.pips[leg][r])), str(int(bp.nbars[leg][r]))]
            e = int(bp.eBuy[r])
            row.append('' if e == ST.NO_E else str(e))
            rows.append(row)
    CMP.write_csv(os.path.join(out, f'blind-{table.half}.csv'), BLIND_HEADER, rows)


SHIFT_HEADER = ['src', 'half', 'layer', 'k', 'delta', 'dropped', 'seasonCross']
TRADES_HEADER = ['src', 'pair', 'i', 'T', 'dir', 'half', 'sChart', 'sCal', 'e', 'y4', 'y10', 'p4', 'p10', 'mp4', 'mp10',
                 'lateT', 'eLate', 'sLateChart', 'sLateCal', 'nextOk']


def trade_rows(trades):
    rows = []
    for tr in trades:
        s = tr.sig
        nxt = tr.next_row is not None
        rows.append([s.src, s.pair, str(s.i), str(s.T), S.DIR_NAME[s.dir], s.half,
                     str(ST.stratum_of('chart', s.pi, s.dir, s.T)), str(ST.stratum_of('cal', s.pi, s.dir, s.T)),
                     '' if tr.e is None else str(tr.e), '' if tr.y4 is None else str(tr.y4),
                     '' if tr.y10 is None else str(tr.y10), CMP.js_num(tr.p4), CMP.js_num(tr.p10),
                     CMP.js_num(tr.mp4), CMP.js_num(tr.mp10),
                     str(tr.next_T) if nxt else '', '' if tr.e_late is None else str(tr.e_late),
                     str(ST.stratum_of('chart', s.pi, s.dir, tr.next_T)) if nxt else '',
                     str(ST.stratum_of('cal', s.pi, s.dir, tr.next_T)) if nxt else '',
                     'true' if nxt else 'false'])
    return rows


def clean_row(row):
    out = {}
    for k, v in row.items():
        if k.startswith('_') or k in ('counted', 'nE'):
            continue
        if isinstance(v, dict) and 'est' in v and 'cands' in v:
            out[k] = ST.strip(v)
        else:
            out[k] = v
    return out


# ---------------------------------------------------------------- the gates of the stages (1, 12, 14, 17, 22, 20 (d)-(f))
# Rewritten 2026-10-12 from the rule by the step-2b Python author, who has not read the TS (py-brief 1.8). They decide
# which data and which items are opened, never a number; every refusal exits 2 (die) before any bar is read.
REFUSE_H2 = 'the second half (stage 2) is opened only with --choice-ledger'
# Added 2026-10-13 by the step-2b Python review fixer (who has not read any TS): python-issues PR-7.
REFUSE_HOLD = ("stage 2 without --hold (14「段2で、オーナーの持ち方（9）も測る」; 20 (d)「Python の計算し直し〔すべての段〕」: "
               "the owner's way is recomputed and compared too)")
REFUSE_RATES = ("--hold without --bis-csv and --bis-sha256 (the swap rows' BIS policy rates: the same file as the TS's "
                "CB_BIS_CSV, read against its sha256, SQ-H6; the Python's rates are otherwise the made-up synthetic ones)")


def under_real_cache(path):
    """1「GMO はこの開発環境から届かないので、すべて GitHub Actions で取る。日のファイルは actions/cache に置き」: the real
    jobs restore GMO's day files under <repo>/research/.cache (D.REAL_CACHE) and pass a --gmo inside it, so such a
    --gmo is real data. Decided from the resolved paths alone (the folder need not exist), before anything is read."""
    cache = os.path.realpath(os.path.join(REPO, D.REAL_CACHE))
    gmo = os.path.realpath(path)
    return os.path.commonpath([cache, gmo]) == cache


def choice_from_ledger(a, real):
    """12「research/ledger/chartbest-choice.json と、その sha256 の定数を commit する。段2は、この定数が無いと走らない。
    選ばなかった項目は、後半で何も計算しない（プログラムが断る）。」 The ledger's bytes are hashed before anything in it
    is read: the sha256 must equal D.CHOICE_LEDGER_SHA256 on real data, --choice-sha256 on made-up data (a walk
    ledger); an empty expected value, an unreadable file or another sha256 refuses. The file is JSON whose top-level
    'chosen' is {'chart': [...], 'cal': [...]} (select.json's 'chosen'); every item must be a trial item of that
    group, none twice, at most K_CHART chart and K_CAL calendar items (12). Returns the chart items, then the
    calendar ones: the only items the second half is opened for."""
    want = ((D.CHOICE_LEDGER_SHA256 if real else a.choice_sha256) or '').strip().lower()
    if not want:
        die(f'{REFUSE_H2} read against its sha256: ' +
            ('CHOICE_LEDGER_SHA256 is empty (12「段2は、この定数が無いと走らない」)' if real else '--choice-sha256 is not given'))
    try:
        got = sha256_of(a.choice_ledger)
    except OSError as e:
        die(f'--choice-ledger {a.choice_ledger} cannot be read ({e.__class__.__name__}); nothing opened')
    if got != want:
        die(f'sha256 {a.choice_ledger} {got} is not the expected {want}: nothing in it read, nothing opened (12)')
    try:
        with open(a.choice_ledger, encoding='utf-8') as f:
            ch = json.load(f)['chosen']
        chart, cal = list(ch['chart']), list(ch['cal'])
    except (OSError, ValueError, KeyError, TypeError) as e:
        die(f'--choice-ledger {a.choice_ledger}: not a choice ledger ({e.__class__.__name__})')
    items = chart + cal
    wrong = ([x for x in chart if D.GROUP_OF.get(x) != 'chart'] + [x for x in cal if D.GROUP_OF.get(x) != 'cal'] +
             [x for x in items if x not in D.TRIAL_ITEMS])
    if wrong or len(set(items)) != len(items) or len(chart) > D.K_CHART or len(cal) > D.K_CAL:
        die(f'--choice-ledger {a.choice_ledger}: not a choice of 12 for the trial items (items {items})')
    return items


def stage_gate(a, stages):
    """Called first in run(a), before any bar is read. Returns (real, the ledger's items or None).
    * --choice-ledger stands for stage 1 (12: the choice is made once, at stage 1, and committed): never with 1 in
      --stages, never with --force-choice, only with 2 in --stages; --choice-sha256 only with it.
    * Real data (--gmo under research/.cache): none of the made-up options (20 (e)/(f): --force-choice,
      --choice-sha256, --o-mode, --counts-only-suspicion, --plant; --period mini is the development period); the
      second half only through --choice-ledger read against CHOICE_LEDGER_SHA256 (12, 14, 22「段2（後半、選んだ
      K_total 個だけ…）」); not before R_cb (17; the rules are fixed before real data is read); never without the
      comparison (20 (d)「Python の計算し直し〔すべての段〕」); a stage 2 only with --hold (14, 20 (d): the owner's
      way is recomputed too), and --hold only with --bis-csv and --bis-sha256 (the swap rows' BIS rates, the same file
      as the TS's CB_BIS_CSV, hashed before anything is read; SQ-H6). PR-7, added by the step-2b Python review fixer.
    * Made-up data: a second half without stage 1 needs --choice-ledger (a walk ledger) or --force-choice; no
      --bis-csv / --bis-sha256 (the made-up runs' rates are the synthetic ones of plan §3.12).
    * --bis-csv / --bis-sha256 only with --hold.
    Every reason found is printed; any one refuses (exit 2)."""
    real = under_real_cache(a.gmo)
    why = []
    if a.choice_ledger:
        if 1 in stages:
            why.append('--choice-ledger stands for stage 1: --stages must not hold 1 with it')
        if 2 not in stages:
            why.append('--choice-ledger opens the second half: --stages must hold 2 with it')
        if a.force_choice:
            why.append('--choice-ledger and --force-choice: one choice only')
    elif a.choice_sha256:
        why.append('--choice-sha256 without --choice-ledger')
    if real:
        made_up = [name for name, on in (('--force-choice', a.force_choice), ('--choice-sha256', a.choice_sha256),
                                         ('--o-mode', a.o_mode), ('--counts-only-suspicion', a.counts_only_suspicion),
                                         ('--plant', a.plant), ('--period mini', a.period != 'main')) if on]
        if made_up:
            why.append(f'real data (--gmo under {D.REAL_CACHE}): {", ".join(made_up)} only on made-up data')
        if 2 in stages and not a.choice_ledger:
            why.append(f'real data: {REFUSE_H2} read against CHOICE_LEDGER_SHA256 (12「段2は、この定数が無いと走らない」)')
        if time.time() * 1000 < D.R_CB:
            why.append('real data before R_cb (17: 2026-10-13 00:00 UTC)')
        if a.no_compare:
            why.append('real data: --no-compare (20 (d): every stage is compared)')
        # PR-7 (findings gates-02, hold-real-stage2-no-hold): 14「段2で、オーナーの持ち方（9）も測る」 and 20 (d)「Python の
        # 計算し直し〔すべての段〕」「照らすもの…判定、文」: a real stage 2 recomputes the owner's way too
        if 2 in stages and not a.hold:
            why.append(f'real data: {REFUSE_HOLD}')
        # its swap rows read the BIS policy rates (§8.102 スワップ「BIS の政策金利（月次、1か月遅れ）から目安を作る」,
        # §8.111「§8.102 のまま」): the same file as the TS's CB_BIS_CSV, read against its sha256 (SQ-H6)
        if a.hold and not (a.bis_csv and a.bis_sha256):
            why.append(f'real data: {REFUSE_RATES}')
    else:
        if 2 in stages and 1 not in stages and not a.choice_ledger and not a.force_choice:
            why.append(f'stage 2 without stage 1: {REFUSE_H2} (a walk ledger) or --force-choice')
        if a.bis_csv or a.bis_sha256:
            why.append('made-up data: --bis-csv / --bis-sha256 only on real data (the made-up runs use the synthetic '
                       "rates of plan §3.12, research/ownerhold-check.py's SYNTH_RATES, as the TS's made-up runs do)")
    if (a.bis_csv or a.bis_sha256) and not a.hold:
        why.append("--bis-csv / --bis-sha256 are the owner's way's rates input: only with --hold")
    if why:
        die('; '.join(why))
    if real and a.hold:
        # the rates file is hashed before anything in it (or any bar) is read
        want = a.bis_sha256.strip().lower()
        try:
            got = sha256_of(a.bis_csv)
        except OSError as e:
            die(f'--bis-csv {a.bis_csv} cannot be read ({e.__class__.__name__}); nothing opened')
        if got != want:
            die(f'sha256 {a.bis_csv} {got} is not --bis-sha256 {want}: nothing in it read, nothing opened (SQ-H6)')
        log(f'sha256 {a.bis_csv} {got} (the BIS policy rates of the swap rows)')
    return real, (choice_from_ledger(a, real) if a.choice_ledger else None)


# ---------------------------------------------------------------- the stages
def run(a):
    period = D.PERIODS[a.period]
    out = a.out
    stages = {int(x) for x in a.stages.split(',') if x}
    real, ledger_chosen = stage_gate(a, stages)
    os.makedirs(out, exist_ok=True)
    # 20 (a): the ledger's sha256 against the constant, before reading anything else
    cand = os.path.join(REPO, D.CANDIDATES_PATH)
    if not os.path.exists(cand) or sha256_of(cand) != D.CANDIDATES_SHA256:
        die(f'{D.CANDIDATES_PATH}: sha256 differs from the constant (nothing read)')
    wide_path = os.path.join(REPO, D.SPREAD_HOURS_PATH)
    if sha256_of(wide_path) != D.SPREAD_HOURS_SHA256:
        die(f'{D.SPREAD_HOURS_PATH}: sha256 differs from the constant')
    wide = D.load_wide_slots(wide_path)
    if not os.path.isdir(a.gmo):
        die(f'no GMO folder {a.gmo}')
    t0 = time.time()
    bars, diags = D.load_all(a.gmo, period)
    for pb, dg in zip(bars, diags):
        log(f'read {pb.pair} 5min files={dg.files} failed={len(dg.failed)} oneSide={dg.one_side} crossed={dg.crossed} '
            f'dup={dg.dup} ohlc={dg.ohlc} closure={dg.closure} nan={dg.nan} bars={pb.n}')
        if dg.failed:
            die(f'{pb.pair}: {len(dg.failed)} day files could not be read')
        if pb.n == 0:
            die(f'{pb.pair}: no bars')
    holes, open_slots = S.holes_of(bars, period)
    sigs, pre, late, both = S.all_signals(bars, period, holes, o_mode=a.o_mode, plant=a.plant)
    blind0 = CNT.Blind(bars, holes, period)
    counts = CNT.stage0(bars, sigs, both, holes, period, blind0, wide, CNT.load_n_summary(a.n_summary))
    write_stage0(out, bars, sigs, pre, holes, counts)
    log(f'stage 0: {len(sigs)} signals, holes {sum(len(h) for h in holes)}, {time.time() - t0:.1f}s')
    stats, shift_rows, trade_out = {}, [], []
    sentences = []
    select = stage2 = None
    floor_items = [s for s in D.TRIAL_ITEMS if counts[s]['floor']]
    both_dirs = {s: s.startswith('donchian') for s in D.TRIAL_ITEMS}
    tables = {}
    rows_by_half = {}
    chosen = []

    def rows_of_half(half, items):
        table = ST.BlindTable(bars, blind0.idx, half, period, a.plant)
        tables[half] = table
        write_blind(out, table, bars)
        rows, mrows = {}, {}
        for src in list(items) + list(D.MEASURES):
            tr = ST.trades_of([s for s in sigs if s.src == src], table, bars, half)
            trade_out.extend(tr)
            layers = CNT.layers_of(src)
            for layer in layers:
                row = ST.source_row(tr, table, layer, period, half, bars, plant=a.plant)
                stats.setdefault(src, {}).setdefault(half, {})[layer] = clean_row(row)
                for k, dk, dr, cr in row.get('_shifts') or []:
                    shift_rows.append([src, half, layer, str(k), CMP.js_num(dk), str(dr), str(cr)])
                log(f'{src} {half} {layer}: unresolved {row["_unresolved"]}, no Δ_late term {row["_lateExcluded"]}'
                    + (f', Δ_late shift sd {row["_shift_late"]["sd"]}' if row.get('_shift_late') else ''))
                if src in D.MEASURES:
                    mrows.setdefault(src, {})[layer] = row
                else:
                    rows[src] = row
        blind = ST.blind_rows(table, period, half)
        stats.setdefault('blind', {})[half] = {k: ({kk: ST.strip(vv) if isinstance(vv, dict) and 'cands' in vv else vv
                                                    for kk, vv in v.items()} if k != 'pairDir' else
                                                   {p: {kk: ST.strip(vv) if isinstance(vv, dict) and 'cands' in vv else vv
                                                        for kk, vv in x.items()} for p, x in v.items()})
                                               for k, v in blind.items()}
        rows_by_half[half] = (rows, mrows, blind, table)
        return rows, mrows, blind, table

    # ---- the stage control flow of 12 and 13 (rewritten from the rule by the step-2b Python author, py-brief 1.7)
    if 1 in stages:
        rows, mrows, blind, table = rows_of_half('H1', floor_items)
        select = SEL.stage1(rows, counts['groups'], counts_only=a.counts_only_suspicion)
        hits = SEL.yardstick_hits(mrows, blind)
        select['yardstickHit'] = SEL.yardstick_hit(mrows, blind)
        # 13「物差し（ブラインド・ULTRA・MACD）が当たったら、すべて止める」: the choice is emptied (K_total = 0), so 12
        # opens no second half; 20 (e) H「作り物では、疑う合図は数えて出すだけで、選ぶのを止めない」 keeps it
        stopped = SEL.stop_on_yardsticks(select, hits, a.counts_only_suspicion)
        select['intervalsSeen'] = SEL.intervals_seen(1, M1=len(floor_items))
        if stopped:
            log(f'stage 1: yardstick hits {hits}: 13 stops everything, nothing is chosen (K_total 0)')
        elif hits:
            log(f'stage 1: yardstick hits {hits}: counted only (--counts-only-suspicion, 20 (e) H), the choice stands')
        else:
            log('stage 1: yardstick hits []')
        CMP.write_json(os.path.join(out, 'select.json'), select)
        sentences += TX.stage1_sentences(select, rows, counts, mrows, blind)
        log(f'stage 1: floor {floor_items}, chosen {select["chosen"]}, {time.time() - t0:.1f}s')
    if 2 in stages:
        # the items the second half is opened for (12「選ばなかった項目は、後半で何も計算しない」): the committed choice
        # (--choice-ledger, read by stage_gate), else the made-up --force-choice, else this run's stage 1
        if ledger_chosen is not None:
            chosen, source = list(ledger_chosen), '--choice-ledger'
        elif a.force_choice:
            chosen, source = [x for x in a.force_choice.split(',') if x], '--force-choice'
        elif select is not None:
            chosen, source = select['chosen']['chart'] + select['chosen']['cal'], 'stage 1'
        else:
            chosen, source = [], 'no choice given'      # stage_gate refuses this; kept for safety
        outside = [x for x in chosen if x not in D.TRIAL_ITEMS]
        if outside:
            die(f'{source} names items outside the trial: {outside}')
        if not chosen:
            # 12「どちらのまとまりにも選べる項目が無ければ、ここで終える（21 の文）。後半は開けない。」: no second-half
            # blind table, no item or email row of the second half, no stage2.json, no stage-2 sentence
            stages = stages - {2}
            log(f'stage 2: no item chosen ({source}): the second half is not opened (12)')
    if 2 in stages:
        rows, mrows, blind, table = rows_of_half('H2', chosen)
        stage2 = SEL.stage2(chosen, rows, mrows, both_dirs, counts_only=a.counts_only_suspicion, plant=a.plant)
        hits2 = SEL.yardstick_hits(mrows, blind)
        stage2['yardstickHit'] = SEL.yardstick_hit(mrows, blind)
        stage2['intervalsSeen'] = SEL.intervals_seen(2, K=len(chosen), n_dab=len(stage2['dAB']))
        log(f'stage 2: yardstick hits {hits2}{" (13: stops everything)" if hits2 and not a.counts_only_suspicion else ""}')
        CMP.write_json(os.path.join(out, 'stage2.json'), stage2)
        sentences += TX.stage2_sentences(stage2, rows, mrows, blind, counts, chosen)
        log(f'stage 2: chosen {chosen}, {time.time() - t0:.1f}s')
    if trade_out:
        trade_out.sort(key=lambda tr: (tr.sig.half, D.src_rank(tr.sig.src), tr.sig.pi, tr.sig.T, -tr.sig.dir))
        CMP.write_csv(os.path.join(out, 'trades.csv'), TRADES_HEADER, trade_rows(trade_out))
    if stats:
        CMP.write_json(os.path.join(out, 'stats.json'), stats)
    if shift_rows:
        CMP.write_csv(os.path.join(out, 'shift.csv'), SHIFT_HEADER, shift_rows)
    if sentences:
        CMP.write_tsv(os.path.join(out, 'sentences.tsv'), sentences)
    log(f'py/ written in {time.time() - t0:.1f}s')
    if a.no_compare:
        return 0
    extra = None
    if a.hold:
        if 2 not in stages:
            die('--hold needs stage 2 (the K_total items)')
        hold_dir = a.hold_dir or os.path.join(os.path.dirname(os.path.abspath(a.ts)), 'hold')
        HD = _mod('hold')

        rates = a.bis_csv if real else HD.RATES          # stage_gate: real --hold has the BIS file (read against its sha256)

        def extra(rep):
            HD.compare_hold(rep, out, hold_dir, a.gmo, list(chosen) + list(D.MEASURES), sigs, late, bars, period, log,
                            rates=rates, real=real)
    return compare_all(out, a.ts, bars, stages, extra, strict=a.strict_format)


# ---------------------------------------------------------------- the comparison (only after py/ is complete)
# The plan's 4.3 columns of each CSV (one missing on either side is a difference; others are notes)
PLAN_COLUMNS = {
    'bars': ['i', 't', 'mo', 'mh', 'ml', 'mc'],
    'signals.csv': ['src', 'pair', 'i', 'T', 'dir', 'E', 'reason', 'half', 'marks'],
    'prefilter.csv': ['src', 'pair', 'bothSuppressed', 'firstSkipped', 'nullPrevSkipped', 'late'],
    'holes.csv': ['pair', 'a', 'b'],
    'blind': ['pair', 'k', 'T', 'E', 'hour', 'season', 'week', 'block', 'b4k', 'b4p', 'b4n', 's4k', 's4p', 's4n',
              'b10k', 'b10p', 'b10n', 's10k', 's10p', 's10n', 'eBuy'],
    'trades.csv': ['src', 'pair', 'i', 'T', 'dir', 'half', 'sChart', 'sCal', 'e', 'y4', 'y10', 'p4', 'p10', 'mp4',
                   'mp10', 'lateT', 'eLate', 'sLateChart', 'sLateCal', 'nextOk'],
    'shift.csv': ['src', 'half', 'layer', 'k', 'delta', 'dropped', 'seasonCross'],
}
CSV_SPECS = {
    'signals.csv': (['src', 'pair', 'i', 'dir'], {'T': 'int', 'E': 'price', 'reason': 'str', 'half': 'half',
                                                  'marks': 'list', 'i': 'int', 'dir': 'dir'}),
    'prefilter.csv': (['src', 'pair'], {k: 'int' for k in ('bothSuppressed', 'firstSkipped', 'nullPrevSkipped', 'late')}),
    'holes.csv': (['pair', 'a'], {'a': 'int', 'b': 'int'}),
    'trades.csv': (['src', 'pair', 'i', 'dir'], dict({k: 'int' for k in ('i', 'T', 'sChart', 'sCal', 'e', 'y4', 'y10', 'lateT',
                                                                         'eLate', 'sLateChart', 'sLateCal')},
                                                     half='half', dir='dir', nextOk='bool')),
    'shift.csv': (['src', 'half', 'layer', 'k'], {'k': 'int', 'dropped': 'int', 'seasonCross': 'int',
                                                  'lateDropped': 'int', 'lateSeasonCross': 'int'}),   # late*: if written
}
BLIND_KINDS = dict({k: 'int' for k in ('k', 'T', 'hour', 'season', 'week', 'block', 'b4n', 's4n', 'b10n', 's10n', 'eBuy')},
                   E='price', b4k='kind', s4k='kind', b10k='kind', s10k='kind')


def compare_all(out, ts, bars, stages, extra=None, strict=False):
    rep = CMP.Report()
    if not os.path.isdir(ts):
        die(f'no TS dump folder {ts}')

    def canon(name):
        if strict:
            return None
        return lambda x, y: CAN.canon_pair(name, x, y, tuple(D.TRIAL_ITEMS + D.MEASURES), tuple(D.MEASURES),
                                           D.GROUP_OF)

    def csv(name, keys, kinds, required):
        CMP.compare_csv(rep, name, os.path.join(out, name), os.path.join(ts, name), keys, kinds,
                        required=required, strict=strict)
    for pb in bars:
        csv(f'bars-{pb.sym}.csv', ['i'], {'i': 'int', 't': 'int', 'mo': 'price', 'mh': 'price', 'ml': 'price',
                                          'mc': 'price'}, PLAN_COLUMNS['bars'])
    for name in ('signals.csv', 'prefilter.csv', 'holes.csv'):
        keys, kinds = CSV_SPECS[name]
        csv(name, keys, kinds, PLAN_COLUMNS[name])
    CMP.compare_json_file(rep, 'counts.json', os.path.join(out, 'counts.json'), os.path.join(ts, 'counts.json'),
                          special={'/groups': CMP.partition_equal}, canon=canon('counts.json'))
    for half, st in (('H1', 1), ('H2', 2)):
        if st in stages:
            csv(f'blind-{half}.csv', ['pair', 'k'], BLIND_KINDS, PLAN_COLUMNS['blind'])
    for name in ('trades.csv', 'shift.csv'):
        if os.path.exists(os.path.join(out, name)):
            keys, kinds = CSV_SPECS[name]
            csv(name, keys, kinds, PLAN_COLUMNS[name])
    for name in ('stats.json', 'select.json', 'stage2.json'):
        if os.path.exists(os.path.join(out, name)):
            CMP.compare_json_file(rep, name, os.path.join(out, name), os.path.join(ts, name),
                                  special={'/groups': CMP.partition_equal} if name == 'select.json' else None,
                                  canon=canon(name))
    if os.path.exists(os.path.join(out, 'sentences.tsv')):
        CMP.compare_tsv(rep, 'sentences.tsv', os.path.join(out, 'sentences.tsv'), os.path.join(ts, 'sentences.tsv'))
    if extra is not None:
        extra(rep)
    ok = not rep.differ
    CMP.write_json(os.path.join(out, 'pycheck.json'), {'ok': ok, 'compared': rep.compared,
                                                       'mismatched': len(rep.differ), 'differ': rep.differ,
                                                       'notes': rep.notes})
    for n in rep.notes:
        print(f"NOTE {n['file']} {n['note']}")
    for d in rep.differ[:2000]:
        print(f"DIFFER {d['file']} {d['key']} {d['column']}")
    if len(rep.differ) > 2000:
        print(f'DIFFER ... {len(rep.differ) - 2000} more (pycheck.json)')
    print(f'compared {rep.compared} files, {len(rep.differ)} differences')
    print('PYTHON CHECK OK' if ok else 'PYTHON CHECK FAILED')
    return 0 if ok else 1


def main():
    ap = argparse.ArgumentParser(description='§8.113 independent Python re-computation')
    ap.add_argument('--mode', choices=('hand', 'run'), required=True)
    ap.add_argument('--hand', default=None, help="research/chartbest/hand.json: its cases run too (the Python's own "
                    'docs-derived cases always run)')
    ap.add_argument('--plant', default='')
    ap.add_argument('--gmo')
    ap.add_argument('--ts')
    ap.add_argument('--out')
    ap.add_argument('--period', choices=('main', 'mini'), default='main')
    ap.add_argument('--full', action='store_true')
    ap.add_argument('--o-mode', action='store_true')
    ap.add_argument('--force-choice', default='')
    ap.add_argument('--choice-ledger', default='', help="stage 1's choice (chartbest-choice.json, or a walk ledger's "
                    'choice.json), read against its sha256; the second half is opened for its items (no stage 1)')
    ap.add_argument('--choice-sha256', default='', help='the sha256 of --choice-ledger (made-up only; real data uses '
                    'the constant CHOICE_LEDGER_SHA256)')
    ap.add_argument('--stages', default='0,1,2')
    ap.add_argument('--n-summary', default=None)
    ap.add_argument('--counts-only-suspicion', action='store_true')
    ap.add_argument('--hold', action='store_true', help='also the owner-hold dumps (hold/<src>-<acct>/dump/)')
    ap.add_argument('--hold-dir', default=None, help='the hold/ folder (default: next to --ts)')
    ap.add_argument('--bis-csv', default='', help="real data with --hold only: the BIS policy rates of the swap rows, "
                    "the same file as the TS's CB_BIS_CSV (research/ownerhold-check.py's --rates format)")
    ap.add_argument('--bis-sha256', default='', help='the sha256 --bis-csv is read against (real data with --hold only)')
    ap.add_argument('--no-compare', action='store_true')
    ap.add_argument('--strict-format', action='store_true',
                    help="compare the dumps' layouts as written (the plan's 4.4: headers and keys equal), without "
                         'chartbest-check-canon.py and the CSV column tolerance')
    a = ap.parse_args()
    if a.mode == 'hand':
        # 20 (g)「手の例〔どの run でも走る。TS と Python の両方。…〕」: the Python's own docs-derived cases
        # (chartbest-check-hand.py) first, then, with --hand, every case of that file (hand.json) through the Python's
        # own functions (chartbest-check-handjson.py). With --plant (20 (f)) only the own cases run, judged by their
        # PLANT_EXPECT. The exit: 2 when either returned 2 (an unreadable file, an unknown plant), else the larger.
        # (Rewritten by the step-2b Python author, py-brief 1.1.)
        code = _mod('hand').main(a.plant)
        if a.hand and not a.plant:
            code_json = _mod('handjson').main(a.hand)
            code = 2 if 2 in (code, code_json) else max(code, code_json)
        sys.exit(code)
    if not (a.gmo and a.out and (a.ts or a.no_compare)):
        die('--mode run needs --gmo, --out and --ts (or --no-compare)')
    sys.exit(run(a))


if __name__ == '__main__':
    main()
