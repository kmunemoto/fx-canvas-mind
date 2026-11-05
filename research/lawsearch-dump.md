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
<RUN>/ts/                  the TS's files (2–8), plus checks.csv and print.txt (TS only)
<RUN>/py/                  the Python's files (the same names as ts/, except the TS-only ones)
<RUN>/cmp/report.txt       the comparator's report (10)
```

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
 "g":{},"gFrom":"none: step 4","plant":"","spreadH1Sha256":"2e5a…"}
```

- `trials` lists the run's trials in table order.
- With `plant` non-empty, the run is a planted-error run. The Python compares nothing on it: it is run only for the
  checks of `lawsearch-design.md` 8.

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
| all.emitted, all.r1, all.r1w, all.r1b | int | the whole read range: every emitted candidate; ① (with T ≥ SPLIT); its warm-up part; ①b |
| all.adds_up | bool | all.emitted = all.r1 + all.r1w + all.r1b + Σ_halves (r2 … r6, counted) |
| floor | bool | ≥ 300 counted and ≥ 30 weeks in both halves |
| same_as | text | the earliest trial with the same first-half counted set (spec 4.6), or empty |
| group | text | the overlap group's first trial in table order (spec 9) |
| g, df, pass_min, mde, mark | real, int, real (q), real (q), bool | spec 9 見分けられる大きさ (empty when no g: the trial) |
| stage3_estimate | real (exact) | second.counted × 52 ÷ 76, written with or without g (spec 23.3) |

### `stage0_totals.csv` — `half,key,value` (key: half, key)

- half `first` and `second`: `pd.<SYM>.<buy|sell>`, then `reason.<code>`, summed over the trials.
- half empty: `groups.m15`, `groups.h1` (the number of groups), `floor.m15`, `floor.h1` (M_1 per tf).

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
  every row was read, which agreed only while every check after the choice passed.
- The cut checks of spec 15 / 23.2 are named so that `checks.csv` shows which is which: `cut` (stage 0, every trial,
  300 of the higher-timeframe boundary targets per timeframe and pair), `cut.chosen.first` (`stage1end`: the chosen
  trials on stage 1's universe with every boundary target), `cut.chosen.second` (`stage2`: the chosen trials on the
  second half's targets with every boundary target), and `suspect13.cut.stage1` / `suspect13.cut.stage2` (13 (i)).
  With no trial chosen, `cut.chosen.first` is one passing `*` row ("no trial was chosen").
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
- When the decision is one of stage 1's chosen trials (`stage1.csv` chosen, `stage1_summary.csv` chosen.*), a stage
  2 Holm pass (holm_pass, holm_delta_pass) or a verdict, the comparator writes `STOP 8.5 …` with both values and
  exits 6. The lead must tell the owner (spec 8.5). It does not go on.

### 9.4 Signals, as spec 17.2 asks

- For each trial and pair, the comparator also takes the lines of that pair in `signals/<trial>.csv` as written
  (after 9.2's adoption), joined with `\n`. It compares their sha256.
- When they differ, it prints the first differing line of each side.

## 10. The comparator's report and exit (PY1 `--run` / `--compare`)

- `<RUN>/cmp/report.txt`:
  - one line per file: `FILE <name> rows ts=<n> py=<n> diff=<n>`;
  - then up to 20 differences per file: `DIFF <file> <key> <column> ts=<v> py=<v> class=<c>`;
  - then the `ALLOWED …` and `STOP …` lines;
  - last, `RESULT agree` or `RESULT differ <n>`.
- Exit codes: 0 agree; 5 any difference that 9.2 and 9.3 do not allow; 6 a 9.3 stop; 3 the tree hash or the config
  failed.
- Files compared: everything under `ts/` except `checks.csv`, `choice.json`, `print.txt` and the TS-only columns of
  `suspect.csv`. A file that is in one folder and not the other is a difference.
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
  - `stage1.csv` `rank`, `chosen`, `skipped_reason`, `skipped_by`: the order of two `lb` of the trial's tf.
  - `stage1_summary.csv` `chosen.<tf>`: the same in that tf; `K_total`: in either tf; `lb_pos`, `lb_pos_groups`,
    `lb_and_pl_pos`: an `lb` vs 0; `bh_pass`: a `p_iut` vs a BH threshold k × 0.10 ÷ `bh_m`.
  - `stage2.csv` `holm_rank`, `holm_pass`, `C1`: a `p_iut` vs a Holm threshold 0.025 ÷ (K − k + 1), or the order of
    two `p_iut`; `holm_delta_rank`, `holm_delta_pass`: the same with `p_delta`; `C4`: the trial's `late_lb` vs 0;
    `no_uplift`: its `dF_lo` vs 0; `verdict`, `label`, `failed`: any of these Holm tests, or the trial's `delta_ub` or
    `late_lb` vs 0.
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
- The `FILE` lines of the report count the differences left after 9.2's and 9.3's allowances. Reason: `RESULT`
  counts them so, and the `ALLOWED` lines list the rest.
