# 法則探し: the comparison files of the small trial (research/lawsearch-dump.md)

Both implementations of `research/lawsearch-spec.md` (the TS study and the Python written apart from it) write the
files below for every synthetic run. The Python's comparator (`research/lawsearch-check.py --run`) then compares them
under spec 17.2's rules (9 and 10 here).

This file fixes the names, columns, row order and number formats, so that a builder who has read only the spec, this
file and `research/lawsearch-py-design.md` can write them. Every value is defined by the spec. The section numbers in
the "meaning" columns are the spec's.

---

## 1. A run's folder

```
<RUN>/manifest.json        written by the generator (TS) before anything reads the run
<RUN>/gmo/<SYM>/<interval>/<side>/<YYYYMMDD>.json   GMO's day files (SYM: USD_JPY EUR_JPY AUD_JPY EUR_USD AUD_USD;
                           interval: 15min, 1hour; side: bid, ask)
<RUN>/ts/                  the TS's files (2–8), plus checks.csv, cut_fail.csv (C3) and print.txt (TS only)
<RUN>/py/                  the Python's files (the same names as ts/, except the TS-only ones)
<RUN>/cmp/report.txt       the comparator's report (10)
```

- (C4a, 2026-11-05) `signals/`, `ind/`, `bars/`, `htf/` and `ts/cut_fail.csv` are sealed until stage 2 (12).

- A day file is one JSON object `{"status":0,"data":[{"openTime":"<ms>","open":"<dec>","high":"<dec>","low":"<dec>",
  "close":"<dec>"},…]}`. A day without bars has `"data":[]`. The prices have 3 decimals on the yen pairs and 5 on the
  dollar pairs.
- **manifest.json**: `{"version":"lawsearch-gen 1","spec":{group, seed, flip, fromMs, toMs, strength, strengthNote,
  drop, emptyDays},"files":<n>,"treeSha256":"<hex>","effectSignals":{…},"ms":<n>}`. `spec.group` is one of
  N R D H E15 E1h EF Q O C.
- **treeSha256**:
  1. List every file under `<RUN>/gmo`, with its path relative to `<RUN>/gmo` using `/`.
  2. Sort the paths by their UTF-8 bytes.
  3. Make the text of one line per file, `<path>\t<sha256 hex of the file's bytes>\n`.
  4. treeSha256 is the sha256 (lower-case hex) of that text's UTF-8 bytes.

  Both implementations compute it before reading a bar, and stop (exit 3) when it differs from the manifest.
- **Group O**: when `spec.group` is "O", both implementations use set O's E26 (14.2): the direction of bar i's target
  comes from C[i+1] vs C[i] (lawsearch-py-design.md 4.3). Every other group uses the spec's E26.

## 2. config.json (written by the TS first; the Python reads it and must not change any setting)

```json
{"mode":"syn","run":"<RUN>","trials":["m15.E04.F00", …],"N":8,
 "questions":{"q1":8,"q2":"b","q3":"a","q4":"a","q5":"a"},
 "kappaDelta":1,"kappaPl":1,"kappaFrom":"not calibrated: step 7",
 "g":{},"gFrom":"none: step 4","plant":"","spreadH1Sha256":"2e5a…","cut_max":null}
```

- `trials` lists the run's trials in table order.
- `cut_max` (C3, 2026-11-05): the TS's development cap `CUT_MAX` on the cut's targets per pair, as a JSON number (a
  positive integer), or `null` when it is not set. The TS refuses any other `CUT_MAX` (exit 2, before it reads a
  file). The Python's `--run` refuses (exit 2, with a message naming `cut_max`) a run whose `config.json` has a
  `cut_max` that is not `null`, or has no `cut_max` key (a run written before C3 cannot say whether it was capped;
  the missing-key refusal confirmed by the lead 2026-11-05, C4a). A capped run still prints `DEVELOPMENT CAP` in
  print.txt. Reason: the cap also capped `cut.chosen.first` and `cut.chosen.second`, and a capped run wrote passing
  rows under the same names with no trace in the files that rule 2 and CI read (C2 review finding 5; the lead's D5).
  - (C4a, 2026-11-05; the lead's E8, C3 review finding 5) The cap caps every cut check, not only the three that
    `cut_fail.csv` covers (8): `cut`, `cut.chosen.first`, `cut.chosen.second`, and the 13 (i) cut of hit trials,
    `suspect13.cut.stage1` and `suspect13.cut.stage2`. print.txt's `note.cut_max` names all five. Before, the note
    named only the first three, while the 13 (i) cut ran on the capped targets too.
  - (C4a, 2026-11-05; the lead's E9) `checks.csv` carries no cap marker: a capped run's cut rows read like an
    uncapped run's (`0 of N differ`, with a smaller N). The trace is `config.json`'s `cut_max` and print.txt's
    `note.cut_max`; the Python's `--run` refuses a capped run, so a capped `checks.csv` is never read for rule 2 or for
    opening stage 2.
- `mode` is `syn` (the TS generated the run) or `walkfiles` (the TS read an existing run's `gmo/`, read only). Both
  are synthetic runs with a generator `manifest.json`, so the Python reads them alike, with spec 15's synthetic price
  band (0.25–2.5 × the walk's start); any other mode stops the Python (exit 3). Reason: the run's data, not the way the
  TS reached them, decides the band; before, the Python took every mode but `syn` as real data and stopped on the
  real-data band (Python comparer, round C2).
- With `plant` non-empty, the run is a planted-error run. The Python compares nothing on it: it is run only for the
  checks of `lawsearch-design.md` 8.
  - (C4a, 2026-11-05; the lead's E9) The plant `secondHalfAll` stays as it is: the TS refuses at stage 2 (exit 2)
    and writes no `checks.csv` and no `print.txt`; the files written before the refusal stay in its folder, and only
    the exit is checked.

## 3. Formats (every CSV)

- UTF-8, LF line ends, one header line, fields separated by `,`. No quoting and no spaces. No field holds a comma.
- **int**: decimal digits with `-` for negatives (TS `String(n)`, Python `str(n)`).
- **real**: the shortest repr that reads back to the same double: TS `String(x)`, Python `repr(x)`. The text may
  differ (`1e-7` vs `1e-07`, `150` vs `150.0`). The comparator always parses with Python's `float()` and compares the
  doubles, never the text.
- **dec**: a raw price as a decimal string with the pair's digits (TS `x.toFixed(d)`; Python `f"{x:.{d}f}"`). Every
  such double is the nearest double to a d-decimal string, so both give the same text. It is compared as text.
- **bool**: `1` or `0`. **tri**: `1`, `0`, or empty for 無し.
- **無し / none / null**: an empty field.
- **text**: as written. The Japanese labels are UTF-8 and contain no comma.
- **time**: UTC epoch milliseconds as an int. **pair**: `USD/JPY` etc. in fields; the symbol `USD_JPY` in file names.
- **tf**: `m15` or `h1`. **half**: `first`, `second`, or empty. **d**: `1` (buy) or `-1` (sell).
- **Row order**: as each section says. The comparator matches rows by the key columns marked "key", so a difference
  in order is reported too, as an order difference.

## 4. Loading (spec 2, 15)

### `load.csv` — one row per loadTf call

| column | type | meaning |
|---|---|---|
| stage (key) | text | `syn0` (stage 0: [S0, END)), `syn1` (stage 1: [S0, SPLIT)), `syn2` (stage 2: [S0, END)) |
| pair (key), tf (key) | text | |
| from_ms, to_ms | int | |
| keys_first, keys_last, keys | text, text, int | the day keys opened: jstDayKey(from − 1 day) … jstDayKey(to), and how many |
| files_read | int | side files opened: 2 per key, read or not (11.1) |
| read_failures | int | files not JSON, not "status 0 or 404 with a data array", or missing |
| unparseable_rows | int | spec 2 数にできない行 (both sides) |
| value_stops | int | values of the wrong form that would read as finite (must be 0; the run stops otherwise) |
| dropped_ask_lt_bid | int | spec 2 捨てた数 |
| same_start_bid_rows | int | spec 2 同じ始まりの行の数 |
| bars | int | bars kept |
| first_s, last_s | int | first and last kept bar start (empty when none) |
| ohlc_bad, dup_starts, band_bad | int | spec 15 (each must be 0), counted in bars (11.2) |

Order: stage (syn0, syn1, syn2), then pair (table order), then tf (m15, h1).

### `askbid.csv` — spec 15's Ask < Bid share

Columns: `stage,pair,tf,year,num,den` (key: stage, pair, tf, year; all int but the texts). The year is the UTC year
of the Bid row's start. den counts the Bid rows of the read files with a same-start Ask row. num counts those whose
Ask close (the last Ask row of that start) is below the Bid close. Order: stage, pair, tf, year. A year with den = 0
is not written.

## 5. Bars, higher bars, holes, indicators (stage 0's load)

(C4a, 2026-11-05) `bars/`, `htf/` and `ind/` are sealed until stage 2 (12).

### `bars/<tf>_<SYM>.csv` — every bar of stage 0's load

| column | type | meaning |
|---|---|---|
| i (key) | int | spec 2 番号 |
| s | time | start |
| bo, bh, bl, bc, ao, ah, al, ac | dec | raw Bid and Ask OHLC |
| O, H, L, C | real (exact) | the rounded mid (spec 2) |
| Po, Ph, Pl, Pc, Bo, Bh, Bl, Bc, Ao, Ah, Al, Ac | int | points |
| day | int | D(s_i) as YYYYMMDD |
| g | int | the usable higher bar's index (spec 2 上位足), −1 when none |

Order: i ascending.

### `htf/<tf>_<SYM>.csv` — the higher bars made from `<tf>`'s bars (m15 → 1 hour, h1 → 4 hours)

Columns: `i,s,bo,bh,bl,bc,ao,ah,al,ac,O,H,L,C,Po,Ph,Pl,Pc` (types as above). Order: i ascending.

### `holes/summary.csv` and `holes/<tf>.csv` — spec 6 ③

- `holes/summary.csv`: `tf,pair,from_ms,n_slots,open_slots,present_slots,hole_slots` (key: tf, pair). The slots are
  [S0 rounded down to the step, END) on the clock grid. open_slots is the same on the five rows of a tf.
- `holes/<tf>.csv`: `pair,slot` (both keys). It lists every slot start that is part of a hole of the pair. Order: pair,
  then slot.

### `ind/<tf>_<SYM>.csv` — indicator values (spec 17.2 照らすもの「指標」)

- Rows: every i with `i % 97 == 0`, and every i that is the bar of any row of any `signals/<trial>.csv` of this tf
  and pair. Order: i ascending.
- Columns: `i`, then the built items' columns in this fixed order (later items append their own at the end, in the
  table's item order):

| column | type | class (9) | meaning |
|---|---|---|---|
| RSI14 | real | exact | RSI_14 of the mid close (spec 3.2) |
| RSI14_U, RSI14_D | real | exact | RMA_14 of up and dn |
| E04_buy, E04_sell | tri | exact | X↑(RSI14, 30), X↓(RSI14, 70) (empty when a value is 無し) |
| DON20_HH, DON20_LL | real | exact | max H[i−20..i−1], min L[i−20..i−1] (empty for i < 20) |
| DON20_s | int | exact | E26's target s (−1, 0, 1; never empty) |
| EMA200 | real | exact | EMA_200 of the mid close |
| F01_buy, F01_sell | tri | exact | (C − EMA200) > 0, −(C − EMA200) > 0 |
| BM_r | real | ln | r[i] = ln(C[i] ÷ C[i−1]); empty where BM_ok is 0 (11.3) |
| BM_ok | bool | exact | r[i] is usable |
| BM_sigma | real | ln | σ[i] |
| BM_z | real | ln | z[i] |
| B06_buy, B06_sell | tri | exact (but 9.2) | z ≤ −2, z ≥ 2 |
| B06_keep | bool | exact | 0 when T's UTC time is in [19:35, 24:00) |

## 6. Signals (stage 0's load) — `signals/<trial>.csv`

One file per trial (`<trial>` is the id, e.g. `m15.E04.F01.csv`). One row per candidate of spec 5 ①–⑤, with its
reason of spec 6.

| column | type | meaning |
|---|---|---|
| pair (key) | text | |
| i (key) | int | the signal bar |
| d (key) | int | 1 / −1 |
| T, X | time | T_i and X = T + 8 × step |
| reason | text | `counted`, `f_none` (spec 5 ④: F 無し), `both` (⑤), `r1` (①: outside both halves), `r1w` (①: in a half but before the warm-up), `r1b` (①b), `r2` … `r6` |
| half | text | `first` / `second` when (T, X) meets that half's rule of spec 1 (whatever the reason), else empty |
| warm | bool | the bar index is at or past every warm-up of the trial |

- Order: T, then pair, then buy before sell.
- f_none and both rows are written whatever their T. Rows that F = false drops are not written. Rows that a keep rule
  (spec 5 ③) drops are not written.
- (C4a, 2026-11-05) Sealed until stage 2 (12): the file holds every trial's second-half candidates with their reasons.

## 7. Stage 0 (spec 9)

### `stage0.csv` — long: `trial,key,value` (key: trial, key)

Per trial, in table order, these keys in this order:

| key | type | meaning |
|---|---|---|
| first.counted, first.weeks | int | counted signals of the first half; weeks with one |
| first.pd.<SYM>.buy, first.pd.<SYM>.sell | int | counted, by pair × direction (pairs in table order) |
| first.reason.<code> | int | for each code of 6's `reason` column (counted, f_none, both, r1, r1w, r1b, r2, r3, r4, r5, r6): r1 and r1w only for T < SPLIT; r2–r6 for the half's signals; f_none and both by the half column |
| first.no_trade, first.no_blind | int | counted signals without an entry bar; counted signals with a trade whose stratum has no blind bar (0) |
| first.per_week | real (exact) | first.counted ÷ 72 |
| second.counted, second.weeks | int | the second half's counted signals and weeks with one, only (spec 9 後半: 試しごとの内訳は段2まで出さない; spec 23.3, 2026-11-05: the trial's format wrote second.pd, second.reason, second.no_trade, second.no_blind and second.per_week too, and no longer does) |
| all.adds_up | bool | spec 15 数が合う for this trial over the whole read range: its emitted candidates = its ① (T ≥ SPLIT included) + ①'s warm-up part + ①b + Σ_halves (r2 … r6, counted). Only the 1/0 is written per trial (C3, below) |
| floor | bool | ≥ 300 counted and ≥ 30 weeks in both halves |
| same_as | text | the earliest trial with the same first-half counted set (spec 4.6), or empty |
| group | text | the overlap group's first trial in table order (spec 9) |
| g, df, pass_min, mde, mark | real, int, real (q), real (q), bool | spec 9 見分けられる大きさ (empty when no g: the trial) |
| stage3_estimate | real (exact) | second.counted × 52 ÷ 76, written with or without g (spec 23.3) |

- (C3, 2026-11-05) Per trial, stage0.csv holds only: the `first.*` keys, `second.counted`, `second.weeks`,
  `all.adds_up`, and the keys made from those numbers that spec 9 asks for per trial (`floor`, `same_as`, `group`,
  `g` … `mark`, `stage3_estimate`; that `floor`, `same_as`, `group`, `g`, `df`, `pass_min`, `mde` and `mark` stay per
  trial was confirmed by the lead 2026-11-05, C4a). The whole-range counts `all.emitted`, `all.r1`, `all.r1w` and
  `all.r1b` are no longer written per trial: they are per-timeframe sums in `stage0_totals.csv` (below). No other
  per-trial key may
  span both halves. Reason: with the first-half keys, a trial's `all.r1` gave its second-half ① count and its
  `all.emitted` its second-half r2–r6 total, which spec 9 後半 (試しごとの内訳は、段2まで出さない) and 23.3 forbid;
  sums over a timeframe's trials are allowed, like the second half's per-reason sums (C2 review finding 1; the lead's
  D1).

### `stage0_totals.csv` — `half,key,value` (key: half, key)

- half `first` and `second`: `pd.<SYM>.<buy|sell>`, then `reason.<code>`, summed over the trials.
- half empty: `groups.m15`, `groups.h1` (the number of groups), `floor.m15`, `floor.h1` (M_1 per tf).
- half empty (C3, 2026-11-05), after `floor.h1`, in this order: `all.emitted.m15`, `all.emitted.h1`, `all.r1.m15`,
  `all.r1.h1`, `all.r1w.m15`, `all.r1w.h1`, `all.r1b.m15`, `all.r1b.h1` (int). Each is the sum, over that
  timeframe's trials (table order, int addition), of the trial's whole-range count: every emitted candidate; ① (T ≥
  SPLIT included); ①'s warm-up part; ①b. These are the old per-trial `all.*` numbers (stage0.csv above), summed.
- (C4a, 2026-11-05; the lead's E4) These per-timeframe sums stay. In a run whose `TRIALS` has only one trial in a
  timeframe, each `all.*.<tf>` sum of that timeframe is that trial's own whole-range count; with one trial in the
  whole run, so is every sum of this file, the second half's `pd.*` and `reason.*` included. Such a run is for
  development only, never a run of the trial or a formal run (they run every trial of their table). The same holds
  for the stage-0 cut's target counts by kind in `checks.csv` and print.txt (TS only): with one trial, `signal N` is
  that trial's whole-range candidate count, up to the 3,000 sample (TS builder, C3).

## 8. Stages 1 and 2 (spec 7, 8, 10, 11, 13)

### `blind/<tf>_<half>.csv` — spec 8.1, both directions

- Columns: `row,pair,i,T,d,j,x,subst,m,h,pl,absm,hour,season,stratum,week`. All are int except pair and T. `subst`
  is a bool (the exit is spec 7's substitute). `season` is 0 both winter, 1 both summer, 2 New York only summer, 3
  London only summer. `stratum = ((pi × 2 + (d == 1 ? 0 : 1)) × 24 + hour) × 4 + season`, with pi the pair's table
  index. `week` = wk(T).
- Key: row. Order: row (0, 1, 2, …): T, then pair, then buy before sell.
- The first half is built at stage 1 ([S0, SPLIT) loaded), the second at stage 2.

### `late/<tf>_<half>.csv` — spec 8.8's late table

- Columns: `row,base_row,pair,i,T,d,j,x,subst,m,h,pl,absm,hour,season,stratum,week`.
- j and x are indices of the 15-minute series. T is the signal's T. hour, season and stratum are of T + 15 min. week
  is wk(T).
- Rows: the base table's rows that 8.8 keeps, in base-row order. `row` numbers them 0, 1, ….

### `blind_counts.csv` — `tf,half,rows,passed_bars,no_trade_bars,weeks,late_rows,late_no_entry,late_r4,late_end`

Key: tf, half. All int. late_end must be 0.

### `trades/<trial>_<half>.csv` — the trial's counted signals with a trade

- Columns: `pair,i,T,d,row,j,x,subst,m,h,pl,stratum,week,late_row,late_why,late_m,late_h,late_pl`.
- `row` is the blind row, and j through week are that row's values. `late_row` is −1 and `late_why` is `no_entry`,
  `r4` or `end` when 8.8 leaves the trade out. Otherwise `late_why` is empty and the late fields are the late row's.
- Key: pair, i, d. Order: row ascending.

### `strata.csv` — `stage,half,trial,stratum,n,m,sig_mean,B,blind_pl_mean,absm_mean`

- Key: stage, half, trial, stratum. n and m are int; the other values are real (exact).
- One row per stratum with n > 0. Order: trial (table order), then stratum ascending.

### `measures.csv` — long: `stage,half,trial,key,value` (key: stage, half, trial, key)

- stage is `stage1` (half `first`) or `stage2` (half `second`).
- `trial` is a trial id, or a blind measure row `blind.<tf>.<SYM>.<buy|sell>` (spec 8.7; for these, only the keys of
  "counts", a, pl and the extras are written).
- Rows: trials in table order, then the 20 blind rows (m15 then h1, pair order, buy then sell), then the keys in this
  order.

| key | type | class |
|---|---|---|
| counted, no_trade, no_blind, N, weeks, strata | int | exact |
| V.value, V.N, V.C_week, V.C_4w, V.four, V.has_t, V.use_lb, V.use_p, V.t, V.p, V.lb, V.ub, V.kappa | real, int, int, int, bool, bool, text, text, real, real, real, real, real | exact, exact, …, exact, p, q, q, exact |
| V.<c>.se, V.<c>.C, V.<c>.df, V.<c>.K, V.<c>.t, V.<c>.p, V.<c>.q975, V.<c>.half_width | real, int, int, int, real, real, real, real | exact, exact, exact, exact, exact, p, q, q |
| V.shift.used, V.shift.skipped, V.shift.sd | int, int, real | exact |
| pl_ex1w, ex1w_week, w_count, w_rate, blind_pl_w, pl_minus_blind, M | real, int, int, real, real, real, real | exact |
| pl_pair.<SYM>, n_pair.<SYM> (5 each), pl_buy, pl_sell, n_buy, n_sell | real / int | exact |
| pl_late, late_N, late_excl.no_entry, late_excl.r4, late_excl.end | real, int, int, int, int | exact |
| dF.against | text | exact |
| nov.N, nov.delta, nov.pl | int, real, real | exact |
| delta_dir.buy, delta_dir.sell, counted_dir.buy, counted_dir.sell | real, real, int, int | exact (stage2 only) |
| delta_pair.<SYM>, counted_pair.<SYM> (5 each) | real / int | exact (stage2 only) |
| c6.a, c6.b | real | exact (stage2 only) |

- V is `delta`, `a`, `pl`, `delta_late`, then `dF` (dF only for a trial with a directional F: (E, F01) against S01
  of its timeframe).
- `<c>` is `week`, `4w` (only when V.four is 1) and `shift` (for delta, a, pl and delta_late; never for dF). A
  candidate that is not built has no rows.
- `V.use_lb` and `V.use_p` are `week`, `4w`, `shift` or empty.
- At stage 2, delta's and pl's candidates are after κ (`V.kappa` = max(1, κ)). The other values' are not.

### `shift.csv` — `stage,half,trial,value,k,n,dropped,v`

- Key: stage, half, trial, value, k. value is `delta`, `pl`, `a` or `delta_late`.
- v is real (exact), empty when k is skipped (no signal left). n and dropped are int.
- Order: trial, value (that order), then k ascending.

### `clusters.csv` — `stage,half,trial,value,kind,g,S_g`

- Key: stage, half, trial, value, kind, g. value is delta, a, pl, delta_late or dF. kind is `week` or `4w`.
- g is the week, or the 4-week block floor((wk − w0) ÷ 4). S_g is real (exact; before × 100).
- Order: trial, value, kind, then g ascending.

### `stage1.csv` — long: `trial,key,value` (the trials with first-half measures, table order)

| key | type | meaning (spec 10) |
|---|---|---|
| pass_floor, same, checks_ok, has_t | bool | rules 1–3's inputs (checks_ok is read from the TS's `checks.csv`, 10.3) |
| delta, lb, pl, pl_ex1w, dF | real | (exact, q, exact, exact, exact) |
| suspicious, sus_checks_passed | bool | rule 6's inputs (from `suspect.csv`) |
| n, group | int, text | |
| fail_rule | int | 0 eligible, or the first rule 1–6 it fails |
| rank | int | its place in its tf's order (1 = first), empty when not eligible |
| chosen | bool | |
| skipped_reason, skipped_by | text | the label of `lawsearch-design.md` 7.2, and the chosen trial that caused it (empty when not skipped) |
| p_iut | real (p) | max(p_Δ, p_PL) of the first half (κ not applied), for the reference BH |

### `stage1_summary.csv` — `key,value`

| key | type |
|---|---|
| K_total | int |
| chosen.m15, chosen.h1 | text: the ids in choice order, joined by `|` |
| lb_pos, lb_pos_groups, lb_and_pl_pos | int |
| bh_m, bh_pass | int |

### `stage2.csv` — long: `trial,key,value` (the chosen trials, table order)

| key | type | class |
|---|---|---|
| kappa_delta, kappa_pl | real | exact |
| p_delta, p_pl, p_iut | real | p |
| t_delta, t_pl | real | exact |
| holm_rank, holm_pass, holm_delta_rank, holm_delta_pass | int, bool, int, bool | exact (but 9.3) |
| C1 … C7 | bool | exact (but 9.3) |
| verdict | int | exact |
| label | text | exact (`lawsearch-design.md` 7.2's strings) |
| failed | text | the failed conditions joined by `・` (e.g. `C3・C4`), empty when none |
| mde, sim_lb, delta_ub, late_lb, dF_lo, dF_hi | real | q |
| no_uplift | bool | D_F's lower end ≤ 0 (spec 11) |

### `suspect.csv` — spec 13

- Columns: `stage,half,id,looked,hit_delta,hit_a,hit_pl,hit_late,hit_W,hit,cut,poison1000,presence,retrace,hand,checks_passed`.
- Key: stage, half, id. Rows: the trials with measures, then the blind rows.
- `looked` through `hit` are compared. `cut`, `poison1000`, `presence`, `retrace`, `hand` and `checks_passed` come
  from the TS's checks (bool, or empty when the row did not hit; `hand` is `not-run` on synthetic runs). The Python
  reads them and does not recompute them.

### TS only (not compared)

- `checks.csv`: `trial,name,passed,detail,stage`. `trial` is `*` for a check of the whole run. `stage` is the stage
  that made the check: `gate`, `stage0`, `stage1`, `stage1end`, `stage2` or `end` (the print check). The Python reads
  it for rule 2: checks_ok = every `*` row and every row of that trial passed, among the rows whose `stage` is `gate`,
  `stage0` or `stage1`. Reason (2026-11-05, TS builder, round C2): rule 2 is decided at the choice, and spec 23.2's
  cut of the chosen trials (`stage1end`) and stage 2's checks come after it; before, the file had no stage column and
  every row was read, which agreed only while every check after the choice passed. (C3, 2026-11-05) A failed row of
  `gate`, `stage0`, `stage1` or `stage1end` also keeps stage 2 closed, in both implementations (11.14 (a)).
- The cut checks of spec 15 / 23.2 are named so that `checks.csv` shows which is which: `cut` (stage 0, every trial,
  300 of the higher-timeframe boundary targets per timeframe and pair), `cut.chosen.first` (`stage1end`: the chosen
  trials on stage 1's universe with every boundary target), `cut.chosen.second` (`stage2`: the chosen trials on the
  second half's targets with every boundary target), and `suspect13.cut.stage1` / `suspect13.cut.stage2` (13 (i)).
  With no trial chosen, `cut.chosen.first` is one passing `*` row ("no trial was chosen").
- `cut_fail.csv` (C3, 2026-11-05): every failing bar of the checks `cut`, `cut.chosen.first` and `cut.chosen.second`,
  one row per check, trial and failing target bar (and one per failing entry-bar check). Always written, with its
  header and no row when nothing failed.
  - Columns: `check,stage,trial,pair,k,s,T,kinds,cut,uncut` (`T` added C4a, 2026-11-05).
    - `check` is the check's name and `stage` its `checks.csv` stage (`stage0`, `stage1end`, `stage2`).
    - `trial` is the trial id and `pair` is `USD/JPY` etc.
    - `k` is the bar's index in the load the cut ran on (stage 0's or stage 2's [S0, END), stage 1's [S0, SPLIT);
      spec 2 番号, so the same bar has the same k in each), and `s` its start (time).
    - `T` (C4a, 2026-11-05; the lead's E7, the C3 TS runner's question): bar k's close time (time, s + step). It is
      the time that the `checks.csv` detail and the STOP line print (as ISO text), so a row of this file can be
      matched with them; before, only `s` was written, one bar length earlier than the printed time.
    - `kinds` is the target's kinds joined by `|` (`signal`, `even`, `gap`, `day`, `htf`), or `entry` for the check
      that a counted signal's entry bar is the uncut series' (spec 15; then k, s and T are the signal bar's).
    - `cut` and `uncut` (reworded C4a, 2026-11-05; the lead's E7, C3 review finding 4) are the decision at k in the
      cut and the uncut run, as the TS's own text, with no comma:
      - each candidate at k is `d:status:warm:reason:stratum` (d `1` / `-1`; status `emit`, `f_none` or `both`; warm
        `1` / `0`; reason a code of 6's `reason` column; stratum as the TS writes it);
      - the candidates at k are joined by `;`;
      - the field is empty when there is no candidate. The plant `chosenCutFirstDiff` adds `;planted` to its one
        `cut` field (with no candidate, that field reads `none;planted`).
      - For kinds `entry`, `cut` is the entry bar's index that the trade code gives and `uncut` the index of the
        uncut series' first bar with start ≥ T and < X; either is empty when there is none.
      - Before, this bullet said the parts of a decision were separated by `;`; in the files they are separated by
        `:`, and `;` only joins two or more candidates.
  - Order: check (cut, cut.chosen.first, cut.chosen.second), then trial (table order), then pair (table order), then
    k ascending, then kinds.
  - The STOP line, the `checks.csv` detail and print.txt's `check.<name>.detail` keep their caps (100 bars per trial,
    400 characters in print.txt). The checks `suspect13.cut.stage1` and `suspect13.cut.stage2` are not in this file.
  - Reason: spec 23.2 その試しの名前と外れた足を出す; before, a failing bar past the 100th per trial was written nowhere
    (C2 review finding 8; the lead's D6). TS only: the Python does not run the cut.
  - (C4a, 2026-11-05) It stays TS only and is not compared (10). It is sealed until stage 2 (12): a failing
    stage-0 cut lists second-half bars of any trial, with their reasons.
- `choice.json`: `{"m15":[…],"h1":[…]}`.
- `print.txt`.

## 9. Comparison classes (spec 17.2)

| class | rule |
|---|---|
| exact | ints, bools, tris, texts and dec strings by equality. Reals parsed with `float()`, then `==` (so −0 equals 0). Both empty is equal; one empty is a difference. |
| q | \|ts − py\| ≤ 1e−9 (values that use t's quantile: q975, half_width, lb, ub, pass_min, mde, sim_lb, delta_ub, late_lb, dF_lo, dF_hi) |
| p | \|ts − py\| ≤ 1e−9 × max(\|ts\|, \|py\|) (p values; a tiny p is never taken as 0) |
| ln | relative 1e−9, as p (B06's r, σ, z: they use ln, which is not correctly rounded) |
| real | \|ts − py\| ≤ 1e−9 (a real no table above names) |

### 9.1 What must be exact

- Spec 17.2's "最後の桁まで": the mid, the points, every indicator of 3.2 but RCI (none in the trial), F's values,
  and every number of 8–11 summed in 21.5's order. These are Δ, a, PL, W, strata, influence sums S_g, SE, t, D_F,
  Δ_k and SD_shift (the "exact" rows above).
- Every count, truth value and index: signals, F, reasons, halves, warm, trades, strata ids, weeks, groups, choices,
  Holm, C1–C7 and verdicts.

### 9.2 Allowed difference: B06's z near ±2 (§8.113 C17)

- A bar of a pair is a z-border bar when, in either implementation, |z − 2| ≤ 2e−9 or |z + 2| ≤ 2e−9 (relative 1e−9
  of the threshold).
- At such a bar, the B06 trials' rows of `signals/` may differ, and so may `B06_buy` / `B06_sell` and the rows of the
  following bar (its rising edge reads the border bar's condition).
- The comparator lists them as `ALLOWED z-border <tf> <pair> i=<i>`. The Python then adopts the TS's rows for those
  bars before it counts (lawsearch-py-design.md 5.3), and everything after must agree exactly.

### 9.3 Allowed difference: decisions on quantiles and p (spec 8.5)

- A decision that compares two values may differ when the two values compared are within 1e−9 of each other in
  either implementation. These decisions are: p vs a Holm or BH threshold, lb vs 0, ub vs 0, late_lb vs 0, dF_lo vs
  0, and the order of two lb or two p. Also (spec 23.5, 2026-11-05) the choice of the candidate in spec 8.5: V.use_lb
  (the widest t(0.975) × SE) and V.use_p (the largest p) when the two candidates' values are within 1e−9; the
  Python then adopts the TS's candidate, and the values that follow from it (V.t, V.lb, V.ub, stage 2's t_delta,
  t_pl and mde) are compared under the TS's candidate.
- The comparator lists each as `ALLOWED 8.5 <file> <trial> <key>`, and the Python adopts the TS's decision.
- (C3, 2026-11-05) An `ALLOWED` line may excuse only a value that rests on the near or tied values themselves: a key
  of the trial whose own decision compares them (for an order, the two trials of the pair), as 11.12 lists. A near or
  tied pair never excuses a key of any other trial. Reason: before, any near or tied pair of p excused `holm_rank`,
  `label` and `failed` of every trial, so a real difference in a third trial came out as `RESULT agree` (C2 review
  finding 2; the lead's D2).
- (C4a, 2026-11-05; the lead's E1 and E2) Two more narrowings, both in 11.12:
  - `stage2.csv` `failed`, `label` and `verdict` of a trial X rest on X's own decisions, not on the near values. A
    difference in them is excused only when one of those decisions of X actually differs between `ts/` and `py/`
    and that difference is itself excused by X's own values (X's C1, C4, verdict-2 test and, for `label` and
    `verdict`, X's `holm_delta_pass`). Never through another trial's p: a near or tied pair of p does not excuse
    them, even for the two trials of the pair. Reason: in C3 they were still excused through X's near pair of p, and
    without checking that any decision of X differed, so a difference from C2, C3, C6 or C7 came out as `ALLOWED`
    and `RESULT agree`, and a plain verdict difference as a `STOP 8.5` (C3 review finding 1).
  - `stage1.csv` `rank` is excused only for the two trials of the near pair of `lb`, as `holm_rank` is (docs
    question Q6 of C3).
- "Within 1e−9" is absolute here, for p too (settled by the lead 2026-11-05, as 11.12 reads it).
- When the decision is one of stage 1's chosen trials (`stage1.csv` chosen, `stage1_summary.csv` chosen.*), a stage
  2 Holm pass (holm_pass, holm_delta_pass) or a verdict, the comparator writes `STOP 8.5 …` with both values and
  exits 6. The lead must tell the owner (spec 8.5). It does not go on. (C4a) A verdict difference that 11.12 does
  not excuse is a `DIFF` (exit 5), not a `STOP 8.5`.

### 9.4 Signals, as spec 17.2 asks

- For each trial and pair, the comparator also takes the lines of that pair in `signals/<trial>.csv` as written
  (after 9.2's adoption), joined with `\n`. It compares their sha256.
- When they differ, it prints the first differing line of each side.

## 10. The comparator's report and exit (PY1 `--run` / `--compare`)

- `<RUN>/cmp/report.txt`:
  - one line per file: `FILE <name> rows ts=<n> py=<n> diff=<n>`;
  - then up to 20 differences per file: `DIFF <file> <key> <column> ts=<v> py=<v> class=<c>`;
  - then the `ALLOWED …` and `STOP …` lines (the `STOP 13 …` lines after the `ALLOWED` and `STOP 8.5` lines);
  - (C4a, 2026-11-05; the lead's E6) then, when a failed TS check kept stage 2 closed (11.14 (a)), one line
    `stage 2 not opened: <reason>` (its form is in 11.14 (a)). It is not a difference and not a stop: it changes
    neither `RESULT` nor the exit;
  - last, `RESULT agree` or `RESULT differ <n>`.
- Exit codes: 0 agree; 5 any difference that 9.2 and 9.3 do not allow; 6 a 9.3 stop; 3 the tree hash or the config
  failed.
  - (C3, 2026-11-05) Also: 2 refused before anything is computed (`--run` on a run with a plant, or with a
    `cut_max` that is not `null`: 2); 3 a spec 13 blind-row stop (11.14 (c)) when the comparison has no reason for 5
    or 6. When several apply, the first of 6, 5, 3, 0 wins: a 9.3 stop does not go on (9.3, as the comparator already
    does), and a difference (5) comes before a blind-row stop (3) because the hit itself may be the difference. The
    Python's own STOP inside a stage (a spec 2 / 15 data stop, a must-be-0 count such as no_blind) still exits 3
    with no comparison, as before. (This order, and the `STOP 13` report line below, were confirmed by the lead
    2026-11-05, C4a.)
  - A line `STOP 13 <stage> <id>: …` (11.14 (c)) is not a 9.3 stop: it is written before `RESULT`, and `RESULT`
    stays the comparison's (`agree` or `differ <n>`).
- Files compared: everything under `ts/` except `checks.csv`, `choice.json`, `print.txt` and the TS-only columns of
  `suspect.csv`. A file that is in one folder and not the other is a difference. (C3) `cut_fail.csv` is TS only
  too. A stop before stage 2 (11.14) leaves no stage-2 file or row in either folder.
- Before comparing, the comparator checks: `manifest.json`'s treeSha256 against the gmo folder; `config.json`'s
  `spreadH1Sha256` against `research/ledger/spread-hours-h1.csv`; and that `plant` is empty.

## 11. Conventions settled in the small trial (TS integrator, round 1)

Each line settles a point the sections above left open (how a count is counted, which rows a file holds, row order).
Both implementations follow it. None of them is a rule of the spec; the points the spec itself leaves open are listed
for the lead, not here.

### 11.0 The files compared

- `ts/config.json` is not compared, and `py/` holds no copy of it: it is the TS's input to the Python (2), as
  `manifest.json` is the generator's. Reason: 2 says the Python reads it and changes no setting, so it is not one of
  the Python's outputs, and 10 would otherwise report it as a file in one folder only.

### 11.1 load.csv

- `files_read` = 2 × `keys`: every side file the loader opens, whether it then reads or not; `read_failures` counts
  the opened files that fail. Reason: "2 per key" above, and a count that does not depend on the failures it sits
  next to.

### 11.2 Counted in bars

- `ohlc_bad`, `band_bad` and `dup_starts` count bars: a bar with several bad values (or sides) counts once.
  `dup_starts` counts the bars, after the merge, whose start is not later than the previous bar's start. Reason: spec
  15 states each check per bar; one number per bar makes the two counts equal however many values are bad.

### 11.3 ind/

- `BM_r` is empty where `BM_ok` is 0 (r may not be used there). Reason: the hand examples write r as null exactly
  there (A.4.33 bar 16, A.4.36 bar 27, A.4.40 bars 291 and 302).

### 11.4 blind_counts.csv and the late exclusions

- `late_no_entry`, `late_r4` and `late_end` count rows of the base table (2 per bar; both directions of a bar are
  always left out together, since all three tests read only the pair's bars and the clock). Reason: `rows` and
  `late_rows` in the same line count rows. The hand examples count bars (`blind_bars`), which is the row count ÷ 2.
- A base row is counted once, by the first of: no late entry bar → ④ on [T, X + 15 min) → X + 15 min past the
  period's end. The same order counts a trial's `late_excl.*` in measures.csv and `late_why` in trades/. Reason: the
  three counts must add up to the rows left out.

### 11.5 measures.csv

- A candidate without a t (8.5) writes `V.<c>.t`, `V.<c>.q975` and `V.<c>.half_width` empty and `V.<c>.p` = 1. A
  value without a t writes `V.t`, `V.lb`, `V.ub`, `V.use_lb` and `V.use_p` empty and `V.p` = 1. Reason: A.2.11 (the
  week candidate's t975 and half_width null, p 1).
- `weeks` counts the weeks with a counted signal, with or without a trade; `counted_dir.*` and `counted_pair.*`
  count counted signals with or without a trade (design 11 O-7). Reason: `counted` in the same block counts them so.
- The 20 blind rows write: `counted` … `strata`, then the `a.*` and `pl.*` keys (with their shift candidates), then
  `pl_ex1w` … `n_sell`. No `delta.*`, `delta_late.*`, `dF.*`, `pl_late` … `nov.pl`. Reason: 8 above ("only the keys of
  counts, a, pl and the extras").
- At stage 1, and for `a`, `delta_late` and `dF` at stage 2, `V.kappa` is 1; at stage 2 `delta.kappa` and
  `pl.kappa` are max(1, κ). Reason: κ belongs to Δ and PL of stage 2 only (spec 11).
- `dF`'s `V.use_p`, `V.p` and `V.t` come from the candidate with the largest p of its week and 4w candidates (8.5's
  choice, no shift), and `dF.N` is the (E, F) trial's N.

### 11.6 strata.csv, shift.csv, clusters.csv, trades/

- strata.csv, shift.csv and clusters.csv hold the trials only, never the 20 blind rows. clusters.csv writes the
  `4w` rows of a value only when its `V.four` is 1. Reason: 8 names the blind rows for measures.csv only, and a 4w
  candidate that is not used has no rows in measures.csv either.
- trades/ holds a file for each trial with measures: at stage 1 the floor-passing trials that are not same trials,
  at stage 2 the chosen trials. A trial whose rows serve only another trial's D_F gets no file of its own there.
- The `value` order inside one trial: clusters.csv `delta, a, pl, delta_late, dF` (measures.csv's order of V);
  shift.csv `delta, pl, a, delta_late` (the order 8 lists them in). Reason: 8's "that order" read as the order each
  section lists its values in.

### 11.7 stage0.csv and stage0_totals.csv

- `group` is empty for a trial that fails the floor; `groups.<tf>` counts the distinct non-empty groups. Reason:
  A.2.18 leaves the trials under the floor ungrouped (not_grouped).
- `first.reason.r1` and `first.reason.r1w` count the ① rows with T < SPLIT; `r1b` is first only. f_none and both go
  by the half column. The ① rows with T ≥ SPLIT go into `stage0_totals.csv`'s `second` `reason.r1` and `reason.r1w`
  (`second.reason.*` per trial is no longer written: spec 23.3). Reason: 7 above.
- (C3, 2026-11-05) The whole-range `all.emitted`, `all.r1`, `all.r1w` and `all.r1b` are summed per timeframe into
  `stage0_totals.csv` (7 above); per trial only `all.adds_up` stays. Each implementation still computes every trial's
  four counts, checks its own adds-up rule with them, and adds them up per timeframe in table order. Reason: 7 above
  (the lead's D1).
- `g`, `df`, `pass_min`, `mde` and `mark` are empty when the trial has no g (7 above, kept). `stage3_estimate` is
  written whether or not there is a g (spec 23.3, 2026-11-05; before, it was empty with them).
- `stage3_estimate` is (second.counted × 52) ÷ 76, in that order: the product is an exact integer, so the value is
  one correctly rounded division in both languages. Reason: it is compared exact (7 above), and 52 ÷ 76 first would
  round twice (Python builder, round C2).

### 11.8 stage2.csv

- `failed` is empty unless the verdict is 3. Reason: A.2.23 gives the list for verdict 3 and null for the others.

### 11.9 suspect.csv

- `hit_*` are 0 when `looked` is 0 (fewer than 100 counted signals). The blind rows' `hit_delta` and `hit_late`
  come out 0 by construction (their Δ and Δ_late are 0).
- `stage1.csv` `sus_checks_passed` (rule 6) and stage 2's C5 take a hit row's checks as passed only when
  `checks_passed` is 1 and `hand` is 1; empty when the row did not hit. Reason: (v) is one of 13's checks, and on a
  synthetic run it is not run (`hand` = not-run), so a hit row is never selectable there (spec 23.5; Python builder,
  round C2).

### 11.10 holes/summary.csv

- `present_slots` counts the slots of the grid ([S0 rounded down to the step, END), as `n_slots`) at which the pair has
  a bar starting; `hole_slots` the slots that are part of one of its holes. Reason: the columns' names, on the same
  grid as `n_slots` and `open_slots`.

### 11.11 Set O (TS only; not compared)

- In a run of group O, `ind/`'s `DON20_s` is the planted target the trial used (from C[i+1] vs C[i]), while
  `DON20_HH` and `DON20_LL` stay the real donchian. The last bar, which has no next bar, keeps the previous target.
  Reason: ind/ shows the values the trial used; both builders (TS B, PY2) chose the same for the last bar.

### 11.12 Which outputs show 9.3's decisions (the comparator; Python integrator, round 1)

- A difference is excused by 9.3 only in an output that shows one of its decisions, and only when that decision's own
  two values are within 1e−9 in either implementation. Two values exactly equal in both implementations are a tie
  (the next keys decide it, and must agree), not a near pair. Reason: 9.3 names decisions, not outputs, and a near
  value elsewhere must not excuse an unrelated difference.
  - `stage1.csv` `rank` (C4a, 2026-11-05: narrowed; the lead's E2, the C3 docs writer's question Q6): only for the
    two trials of a near pair of `lb` of the trial's tf (within 1e−9 of each other in either implementation, and not
    exactly equal in both), the same narrowing as `stage2.csv` `holm_rank` below. A swap of two near `lb` changes
    only those two trials' ranks, so another trial's `rank` difference is a `DIFF`. (Stage 1 has no tie route: two
    `lb` exactly equal in both are ordered by counted, then table order.) Before, a near pair excused the `rank` of
    every trial of the tf.
  - `stage1.csv` `chosen`, `skipped_reason`, `skipped_by`: the order of two `lb` of the trial's tf (any near pair of
    that tf; unchanged in C4a, the lead's E2: the skip rules can carry one swap to later trials of the tf, and a split
    of `chosen` is a `STOP 8.5`).
  - `stage1_summary.csv` `chosen.<tf>`: the same in that tf; `K_total`: in either tf; `lb_pos`, `lb_pos_groups`,
    `lb_and_pl_pos`: an `lb` vs 0; `bh_pass`: a `p_iut` vs a BH threshold k × 0.10 ÷ `bh_m`.
  - `stage2.csv` (C3, 2026-11-05: narrowed; before, these keys of every trial were excused by any near or tied pair of
    any two trials, C2 review finding 2; the lead's D2). Each key of a trial X is excused only by X's own decisions:
    - `holm_rank` of X: X is one of the two trials of a near pair of `p_iut` (within 1e−9 of each other in either
      implementation, and not exactly equal in both), or of an exact tie of `p_iut` (equal in both, p < 1) that is
      broken by a t that follows an adopted 8.5 split (11.13's last bullets). Only those two trials.
    - `holm_pass` and `C1` of X: the same pair rule, or X's own `p_iut` vs its own Holm threshold 0.025 ÷ (K − k + 1)
      (k = X's rank in either implementation) within 1e−9.
    - `holm_delta_rank`, `holm_delta_pass`: the same with `p_delta`; for a tie, only through an adopted
      `delta.use_p` split (the Δ-only Holm's order uses t_Δ).
    - `C4`: X's own `late_lb` vs 0. `no_uplift`: X's own `dF_lo` vs 0.
    - `failed`, `label` and `verdict` of X (C4a, 2026-11-05: rewritten; the lead's E1, C3 review finding 1). They
      rest on X's own decisions, not on a p of the order (C2–C7 do not use p). A difference in them is excused only
      when at least one of the decisions below actually differs for X between `ts/` and `py/`, and that difference
      is itself excused by X's own values (within 1e−9, absolute, in either implementation):
      - X's `C1` (X's `C1` differs between the two files), excused when X's own `p_iut` is within 1e−9 of its own
        Holm threshold 0.025 ÷ (K − k + 1), with K = `K_total` and k = X's `holm_rank`, taken per implementation
        (that implementation's `p_iut` against the threshold of its own rank and `K_total`);
      - X's `C4` (X's `C4` differs), excused when X's own `late_lb` is within 1e−9 of 0;
      - X's verdict-2 test, `delta_ub` < 0 (it differs when one file's `delta_ub` of X is below 0 and the other's is
        not; an empty `delta_ub` is not below 0), excused when X's own `delta_ub` is within 1e−9 of 0;
      - for `label` and `verdict` only, X's `holm_delta_pass` (X's `holm_delta_pass` differs), excused when X's own
        `p_delta` is within 1e−9 of its own Δ-only Holm threshold 0.025 ÷ (K − k + 1), with k = X's
        `holm_delta_rank`, per implementation. It decides verdict 4 against verdict 5 (`向きだけ` / `言えない`;
        `failed` is empty for both: 11.8). (Confirmed by the lead 2026-11-05, C4a; it was the docs writer's reading
        of D2 in C3.)
      - No route through another trial's p: a near or tied pair of `p_iut` or `p_delta` (the pair and tie rules of
        the keys above and of 11.13) never excuses X's `failed`, `label` or `verdict`, even when X is one of the two
        trials. When X's `C1` or `holm_delta_pass` splits only through such a pair (X's own p is not within 1e−9 of
        its own threshold), that key is excused as above (a `STOP 8.5`), and X's `failed`, `label` and `verdict`
        differences stay `DIFF` lines under the stop.
      - `failed`: the two lists (their conditions, split at `・`) may differ only in the conditions so excused. Of
        those, only `C4` can be in a list (`C1` never is, and the verdict-2 test is not a condition). So:
        - both verdicts are 3: the lists may differ only in `C4`, and only when X's `C4` difference is excused;
        - neither verdict is 3: both lists are empty (11.8), and any difference is a `DIFF`;
        - one verdict is 3 and the other is not [the docs writer's reading of E1, C4a; the lead to confirm]: the
          other side's list must be empty (11.8), and the difference is excused exactly when X's `verdict` difference
          is excused (below). The empty list then follows from the verdict, not from a condition (as when X's `C1`
          splits and the verdicts are 3 and 5). Read literally, "only in the conditions so excused" would make it a
          `DIFF` line under the verdict's `STOP 8.5`; the exit is 6 either way.
      - `label`: `ALLOWED 8.5` when excused as above; otherwise a `DIFF`.
      - `verdict`: excused through the same decisions of X as `label`. An excused verdict difference is a `STOP 8.5`
        (it is on the STOP list below); one that is not excused is a `DIFF` (exit 5), not a stop.
      - The `ALLOWED` or `STOP` line names the decision of X that differs and the value that excuses it.
      - Before (C3), these keys were also excused through X's near or tied pair of `p_iut`, and without checking
        that any decision of X differed. A difference that came from C2, C3, C6 or C7 then came out as `ALLOWED` and
        `RESULT agree` (any two strong trials with p_iut below 1e−9 are a near pair under the absolute test), and a
        plain verdict difference as a `STOP 8.5`.
    - Tests (C4a; the lead's E1, E2). These must now give `DIFF` and exit 5:
      - the refuter's cases f1, l1, v1, v1b, v2, t1 and d1 in
        `/tmp/claude-0/-home-user-fx-canvas-mind/293f73fc-e90f-5bbc-b9e3-ce7f929d8068/scratchpad/lawsearch/trial/c3/refute-1/t_refute1.py`
        (its controls keep their results: c0 exit 0; g1, a real C1 split on X's own p near its own threshold, exit
        6), and the real `--compare` on
        `/tmp/claude-0/-home-user-fx-canvas-mind/293f73fc-e90f-5bbc-b9e3-ce7f929d8068/scratchpad/lawsearch/trial/c3/refute-1/run`
        (`RESULT differ`, exit 5);
      - the reviewer's R-a … R-f in
        `/tmp/claude-0/-home-user-fx-canvas-mind/293f73fc-e90f-5bbc-b9e3-ce7f929d8068/scratchpad/lawsearch/trial/c3/review/d2/t_d2_review.py`;
      - for E2, a new case: three trials of one tf, two of them a near pair of `lb`, and the third's `rank` differs.
      - The earlier tests (t_decisions, t_candidates, t_checks, t_refute_c3 and t_c3_run in
        `/tmp/claude-0/-home-user-fx-canvas-mind/293f73fc-e90f-5bbc-b9e3-ce7f929d8068/scratchpad/lawsearch/trial/c3/py/`,
        and the C2 review and refute scripts of 11.13) keep their expected results, or are updated with a one-line
        reason each. Reading `t_decisions.py` (not run), the docs writer found four that change, all to `DIFF`, exit 5:
        "verdict split, its late_lb near 0 -> STOP" (C2's; X's `C4` is the same on both sides, so nothing the verdict
        rests on differs); "C3 label of E04 split, E04's own p_delta near its delta-only threshold -> ALLOWED" (X's
        `holm_delta_pass` is the same on both sides); "C3 label of E04 split, its own delta_ub near 0 -> ALLOWED"
        (`delta_ub` is below 0 on both sides, so the verdict-2 test does not differ); "C3 failed of E04 split, E04 in
        a near pair of p_iut (its own C1 excused) -> ALLOWED" (C3 review finding 1: only `failed` differs, and the
        pair route is gone).
    - Holm stops at the first trial that fails, so a split of one trial's `holm_pass` changes the pass of every trial
      after it. That split is always a `STOP 8.5` (exit 6, 10), and the later trials are not excused one by one: their
      differences stay `DIFF` lines under the stop. (Confirmed by the lead 2026-11-05, C4a.)
- `STOP 8.5` for `chosen`, `chosen.<tf>`, `K_total`, `holm_pass`, `holm_delta_pass`, `C1` and `verdict`; `ALLOWED 8.5`
  for the others. Reason: 9.3's stop list (the chosen trials, a Holm pass, a verdict); K_total and C1 are the count
  of the chosen trials and the Holm pass under other names.

### 11.13 The choice of the candidate (9.3, spec 23.5; Python builder, round C2)

- A split of `measures.csv` `V.use_lb` or `V.use_p` is excused (`ALLOWED 8.5 measures.csv <stage>|<half>|<trial>|
  V.use_lb …`) when the two candidates' `V.<c>.half_width` (use_lb) or `V.<c>.p` (use_p) are within 1e−9 of each
  other in either implementation, and not exactly equal in both. Reason: 11.12's near pair; an exact tie is decided by
  8.5's order (week, then 4w, then shift) and must agree.
- The values that follow from the choice are then compared under the TS's candidate, from the Python's own
  per-candidate values in `py/measures.csv` (py/ keeps the Python's own choice): `V.t` and `V.p` (as `V.<c>.t`,
  `V.<c>.p`), `V.lb` and `V.ub` (as `V.value` ∓ `V.<c>.half_width`); `stage1.csv` `lb`, `p_iut`; `stage2.csv`
  `p_delta`, `p_pl`, `p_iut`, `t_delta`, `t_pl`, `delta_ub`, `late_lb`, `dF_lo`, `dF_hi`, and `mde` (from `delta.<c>.df`,
  `delta.<c>.se` and `K_total`). Reason: 9.3 names V.t, V.lb, V.ub, t_delta, t_pl and mde; the others are the same
  values (V.p, or V.lb and V.ub of delta, delta_late and dF) under other names.
- Two p < 1 exactly tied in both implementations go to min(t_Δ, t_PL) (t_Δ for the Δ-only Holm; spec 11). When one
  of those t follows an adopted split, a split of the Holm order is one of 9.3's decisions too (11.12's Holm keys,
  with their STOP list). Reason: the t that breaks the tie is then the TS's candidate's in one implementation and the
  Python's in the other.
  - (C3, 2026-11-05; the lead's D2) This excuses only the two tied trials' `holm_rank`, `holm_pass` and `C1` (or
    `holm_delta_rank` and `holm_delta_pass`), and only when the adopted split is on a t the order uses: an adopted
    `delta.use_p` or `pl.use_p` split of one of the two trials whose t (t_Δ or t_PL) is min(t_Δ, t_PL) of that trial
    in either implementation; for the Δ-only Holm, an adopted `delta.use_p` split only. A `use_lb` split never
    touches the order (it changes no t). Two p = 1 are ordered by counted and table order, never by t, so they are
    never excused. No other trial's key, and no `failed` or `label`, is excused through the tie (11.12). (C4a,
    2026-11-05; the lead's E1) Nor is `verdict`, and this holds for the two tied trials too: their `failed`,
    `label` and `verdict` are excused only through their own decisions (11.12), never through the tie.
  - Tests that must now report `DIFF` (exit 5), not `ALLOWED`: the reviewer's R1, R2 and R3
    (`/tmp/claude-0/-home-user-fx-canvas-mind/293f73fc-e90f-5bbc-b9e3-ce7f929d8068/scratchpad/lawsearch/trial/c2/review/t_review.py`)
    and the refuter's r1, r2, r2b, k1b and r3
    (`/tmp/claude-0/-home-user-fx-canvas-mind/293f73fc-e90f-5bbc-b9e3-ce7f929d8068/scratchpad/lawsearch/trial/c2/refute-2/t_refute.py`):
    a third trial's `failed`, `label` or `holm_rank` differs while two other trials are near or tied. Their controls
    keep their results (k0 exit 0; k1, k2, k3 `DIFF`). A tie case whose adopted split is on a t that is not
    min(t_Δ, t_PL) of its trial in either implementation must give `DIFF` too. (C4a) Under the lead's E1 these are
    expected to keep their results (the docs writer read them; not run); the C4a tests are in 11.12.
- The `FILE` lines of the report count the differences left after 9.2's and 9.3's allowances. Reason: `RESULT`
  counts them so, and the `ALLOWED` lines list the rest.

### 11.14 Stops: what they leave in the files, and how the comparator treats them (C3, 2026-11-05; the lead)

A stop here is a decision of the run, not a crash: the files written up to it stay, and both implementations write
the same set of files, so the comparator compares them as usual.

- **(a) A failed check before stage 2** (the lead's D8). When any row of `ts/checks.csv` whose `stage` is `gate`,
  `stage0`, `stage1` or `stage1end` has `passed` 0, stage 2 is not opened.
  - TS: stages 0 and 1 run to their end as before (so set O still shows its stage-1 suspicion rows), and
    `cut.chosen.first` runs at stage 1's end (a failed gate check still runs nothing, as before). Then the run
    writes `checks.csv`, `suspect.csv` (stage-1 rows), `cut_fail.csv` and `print.txt`, and exits 3. print.txt
    withholds the numbers of each stage with a failed check (as before), and its `note.stage2` says that stage 2 was
    not opened and names the failed checks. The stop is not a check row of its own.
  - No stage-2 file or row is written: no `syn2` rows in `load.csv` and `askbid.csv`, no `blind/<tf>_second.csv`,
    `late/<tf>_second.csv` or `trades/<trial>_second.csv`, no `second` rows in `blind_counts.csv`, no `stage2` rows
    in `measures.csv`, `strata.csv`, `shift.csv`, `clusters.csv` and `suspect.csv`, no `stage2.csv`.
  - Python: it reads the same rows of `ts/checks.csv` and does not open stage 2 either. It compares the files as
    usual; its exit is the comparison's (a check is the TS's, as for every other TS check).
  - (C4a, 2026-11-05; the lead's E6, the C3 Python comparer's question) The comparator also writes the reason into
    `cmp/report.txt`, not only into its log: one line `stage 2 not opened: <reason>`, after the `ALLOWED`, `STOP 8.5`
    and `STOP 13` lines and just before `RESULT`. `RESULT` and the exit are unchanged. Before, a reader of report.txt
    alone could not tell that stage 2 was closed, or why the run had fewer files (O 6001–6004: 72 files instead of
    78–80, `RESULT agree`).
    - The line is written whenever `ts/checks.csv` has a row of stage `gate`, `stage0`, `stage1` or `stage1end`
      whose `passed` is not 1 (the condition above), by `--run` and by `--compare` alike (both read `ts/checks.csv`).
    - `<reason>` [form chosen by the docs writer, C4a]: `failed TS checks before stage 2: ` followed by each such
      row as `<name> <trial> <stage>`, in the file's row order, joined by `; `. Example: `stage 2 not opened: failed
      TS checks before stage 2: cut m15.E26.F00 stage0; poison m15.E26.F00 stage0; …`.
    - [Docs writer's reading of E6, C4a; the lead to confirm] A run whose stage 2 stays closed with no such failed
      row gets no line: `K_total` 0 with every check passed (spec 10: 選べる試しが1つも無ければ、後半は開けずに終わる).
      A stage-1 blind-row hit has its `STOP 13` line, and the TS's failed `suspect.blind.stage1` row (stage
      `stage1`) gives this line too.
  - A STOP raised inside a stage (a spec 2 / 15 data stop, a must-be-0 count) ends the run at that stage, as before;
    the Python, meeting the same condition, stops there too (exit 3, no comparison).
  - Reason: spec 11 opens the second half once, and a run with a known failure must not use it. Before, only a
    failed `cut.chosen.first` closed stage 2 (spec 23.2), and O 6001 opened it after its E26 failures (the TS
    builder's question in C2).
  - (Confirmed by the lead 2026-11-05, C4a.) This is stricter than spec 10 rule 2 (確かめ（15）がすべて通る, a rule of
    each trial) and spec 15 (1つでも外れたら、その段の数字を出さない) on purpose: since spec 11 opens the second half
    once, on real data one failed check keeps stage 2 closed for every trial until the error is fixed and the run is
    made again.
- **(b) `cut.chosen.second` failed** (the lead's D9). Stage 2 has run, so its dumps are written as usual.
  - TS: print.txt withholds stage 2's numbers (every `verdict.*`, every `count.stage2.*` and any other stage-2
    number; `withheld.stage2` is 1), and the run exits 3.
  - Python: it computes and writes stage 2's files as usual, and the comparator compares them as usual. It reads the
    failure from `ts/checks.csv` (the row `cut.chosen.second`, stage `stage2`, passed 0) and says so in its log. Its
    exit is the comparison's.
  - Reason: the cut is the TS's (the Python does not run it), and spec 23.2's 段2の数字を出さない governs what is
    shown, not what the two implementations compare.
- **(c) A blind (物差し) row hits** (the lead's D10). When a row of `suspect.csv` whose `id` is a blind row
  (`blind.<tf>.<SYM>.<buy|sell>`) has `hit` 1, both implementations stop at the end of that stage.
  - That stage's dumps are written in full, `suspect.csv` with that stage's rows. The next stage is not opened (a
    stage-1 hit leaves the files of (a); a stage-2 hit is the last stage of the trial).
  - TS: `checks.csv` has the failed row `suspect.blind.stage1` or `suspect.blind.stage2` (one per hit row; it names
    the row). print.txt withholds that stage's numbers and says STOP (a `note.*` key naming the stage and the blind
    rows that hit). Exit 3.
  - Python: it decides the hit itself (its own `suspect.csv` row), finishes that stage's files, does not open the
    next stage, and compares. report.txt gets one line `STOP 13 <stage> <id>: a blind row hit spec 13's lines` per
    hit row, before `RESULT`. Exit 3 when the comparison has no reason for 5 or 6 (10). (This line and the exit
    order were confirmed by the lead 2026-11-05, C4a.)
  - Reason: spec 13 物差しが当たったら、すべて止めて調べる. Before, the TS recorded a failed check and went on, and
    the Python wrote the row and went on.

## 12. Sealed until stage 2 (C4a, 2026-11-05; the lead's E5)

Some files are written before stage 2 and hold second-half material of each trial. They are kept, because the
TS–Python comparison needs them: spec 17.2 照らすもの compares the bars, the indicators, the signal sequence of each
trial and pair, and the counts by reason, and its 合わない項目 settles a mismatch 段0の前に. The lead decided how they
are treated. There is no code change: the files, their columns and their formats stay as 5, 6 and 8 say.

### The sealed files

| file | written | what of the second half it holds |
|---|---|---|
| `signals/<trial>.csv` (6; ts/ and py/) | stage 0 | every candidate of every trial over [S0, END), with its half and reason: counting its rows gives each trial's second-half pair × direction and reason breakdown (C3 review finding 2) |
| `ind/<tf>_<SYM>.csv` (5; ts/ and py/) | stage 0 | the indicator values at every signal bar of the second half |
| `bars/<tf>_<SYM>.csv` (5; ts/ and py/) | stage 0 | the second half's prices; with `signals/`, enough to compute any trial's second-half trades (spec 10: 選ばなかった試しの後半は、プログラムが計算を断る) |
| `htf/<tf>_<SYM>.csv` (5; ts/ and py/) | stage 0 | the second half's higher bars |
| `ts/cut_fail.csv` (8; TS only) | the run's end | a failing stage-0 cut's second-half bars of any trial, with their reasons |

### The rule

- They are sealed comparison dumps: written for the TS–Python comparison only. Before stage 2 they are never shown,
  read by a person, or summarised.
- Before stage 2, a person sees only print.txt's allowed numbers (its `PRINT_KEYS`, spec 15 出してよい項目) and the
  comparison's `RESULT` and its `DIFF` / `STOP` lines (10).
- A `DIFF` line means a program error: that run is fixed and run again.
- Programs read them as before: the comparator (9, 10), and on synthetic runs `lawsearch-flip.ts`, which reads
  `signals/` (and `blind/`) of the run it judges.
- Reason: spec 9 後半 (試しごとの内訳は、段2まで出さない) and spec 10 (選ばなかった試しの後半は、プログラムが計算を
  断る). Since C3, stage0.csv itself holds only the allowed per-trial numbers (7), but these files still held each
  trial's second-half material (the C3 docs writer's question Q3; C3 review finding 2).

### Points the rule leaves open [docs writer, C4a; for the lead]

- report.txt's `FILE` lines give each sealed file's row count, per trial for `signals/<trial>.csv`, over both halves.
  That count less the trial's first-half reason counts in stage0.csv is its number of candidates outside the first
  half (mostly the second half's), of which spec 9 allows only the counted number per trial. The rule's list of what
  a person sees names `RESULT`, `DIFF` and `STOP` lines only; read literally, `FILE` lines (and `ALLOWED` lines,
  which can name a second-half bar of a B06 trial, 9.2) are not shown before stage 2 either. The lead to confirm.
- A failing cut check also prints second-half bars of a trial with their decisions in places outside this list: the
  `checks.csv` detail (up to 100 bars per trial), the console STOP line, and print.txt's `check.<name>.detail` (400
  characters). 9.4 prints the first differing line of `signals/` when the sha256 differ. They are failure reports
  like `DIFF` lines; whether `checks.csv` is sealed is not said.
- Under a `STOP 8.5`, 11.12 leaves `DIFF` lines that follow from the stopped split (Holm's later trials), which are
  not program errors.
- On the trial's synthetic runs nothing in these files is real, and builders and reviewers read them to find program
  errors (as the C3 review did). Read as binding from the first real-data stage 0 on (spec 9 is 段0（実データ）).
- `holes/` (5) also covers the second half, per pair and not per trial; it follows from `bars/`.
