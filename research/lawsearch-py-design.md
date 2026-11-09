# 法則探し: the Python of the small trial (research/lawsearch-py-design.md)

Two builders write the Python half of spec 17.2 for the small trial (spec 19 step 3):

- **PY1**: `research/lawsearch-check.py`, the bars, the exclusions, the trades and every measure and decision, plus
  the comparison with the TS's files.
- **PY2**: `research/lawsearch_sig.py`, the indicators, the trial's items, the filters, the events of spec 5 and the
  higher-timeframe rule.

PY1 imports PY2. Neither builder reads any TS.

## 0. What you may read, and what you must not

- **Read**:
  - `research/lawsearch-spec.md` (the only authority, with 付録 A);
  - `research/lawsearch-hand.json` and `research/lawsearch-hand.md`;
  - `research/lawsearch-dump.md` (the files you write and how they are compared);
  - this file;
  - `research/ledger/lawsearch-candidates.json` and `research/ledger/spread-hours-h1.csv`;
  - for PY2 only, the parts of docs §8.113 that spec 17.3 pulls in: `docs/OPERATIONS.md` §8.113 "5. 出来事" (the
    decision order and the "no signal" bars), "4" 置5–置7, item C1 (donchian-A) and item C17 (bigmove), with 17.3's
    substitutions.
- **Do not read**: any `.ts` file (the study's or the app's), `research/lawsearch-design.md`, `research/lawsearch-types.ts`,
  `research/lawsearch-rules.ts`, the chartbest files, or the git history of `research/lawsearch*.ts`. The spec has
  every formula. When the spec, the hand examples and this file seem to disagree, the spec wins: write it down and
  tell the lead.
- **The TS's output you read** (data, not code): a run's `manifest.json` and `ts/config.json`; `ts/checks.csv` (rule
  2 of spec 10); the check columns of `ts/suspect.csv` (13 (i)–(v)); and, only for an allowed difference
  (lawsearch-dump.md 9.2, 9.3), the TS's rows at that place.
  - (C3, 2026-11-05) Also from `ts/checks.csv`: whether stage 2 is opened (a failed row of stage `gate`, `stage0`,
    `stage1` or `stage1end` keeps it closed) and whether `cut.chosen.second` failed (5.6). From `ts/config.json`:
    `cut_max` (2).
  - (C4a, 2026-11-05) The same failed rows of `ts/checks.csv` also give the report line `stage 2 not opened: …`
    (5.7; the lead's E6).
- **Sealed files** (C4a, 2026-11-05; the lead's E5): `signals/`, `ind/`, `bars/` and `htf/` (yours in `py/` and the
  TS's in `ts/`) and the TS's `cut_fail.csv` hold second-half material of every trial. They are written for the
  TS–Python comparison only and are never shown, read by a person or summarised before stage 2
  (lawsearch-dump.md 12). Your code writes and compares them as before; nothing changes in it.

## 1. Files, running, and how PY1 loads PY2

- `python3 -I research/lawsearch-check.py …`. With `-I`, the script's folder is not on `sys.path`, so PY1 loads PY2
  by its path:

  ```python
  import importlib.util, pathlib
  _HERE = pathlib.Path(__file__).resolve().parent
  _spec = importlib.util.spec_from_file_location("lawsearch_sig", _HERE / "lawsearch_sig.py")
  sig = importlib.util.module_from_spec(_spec)
  _spec.loader.exec_module(sig)
  ```
- PY2 imports nothing of PY1. Both use only the standard library and numpy (float64).
- PY2 also runs alone: `python3 -I research/lawsearch_sig.py --hand [--plant NAME]` runs groups 3 and 4.

## 2. PY1's command line and exit codes

| command | does |
|---|---|
| `--hand [--plant NAME]` | the hand examples of groups 1 and 2 (PY1) and of 3 and 4 (by `sig.run_hand`); one line per example |
| `--run RUN` | recompute everything from `RUN/gmo` into `RUN/py/`, then compare with `RUN/ts/` (lawsearch-dump.md 10) |
| `--compare RUN` | the comparison only |
| `--plant NAME` | with `--hand` only: a planted error (6) |

- Exit codes:
  - 0: all passed, or agree;
  - 2: refused (a run folder without `manifest.json`, one under `research/.cache`, or a `config.json` with a plant
    given to `--run`);
    - (C3, 2026-11-05; the lead's D5) also `--run` on a run whose `ts/config.json` has a `cut_max` that is not
      `null`, or has no `cut_max` key. Refuse before computing anything, with a message that names `cut_max` and its
      value (for example `REFUSED config.json cut_max 20: a capped development run is not compared`). Reason:
      `cut_max` is the TS's development cap on its cut checks; a capped run's checks pass under their normal names,
      so it must never be compared as a run of the trial (lawsearch-dump.md 2). (The refusal of a missing key was
      the C3 docs writer's reading; confirmed by the lead 2026-11-05, C4a. The cap reaches every cut check of the
      TS, the 13 (i) cut included, and `checks.csv` carries no cap marker: lawsearch-dump.md 2.)
    - (C4b, 2026-11-05; the lead's E14) also `--compare` on such a run: the same condition (`cut_max` not `null`,
      or no `cut_max` key, in `RUN/ts/config.json`) and the same message as `--run`, before anything is compared
      and before anything is written into `RUN/cmp/`. Use one function for both commands. Reason: before, only
      `--run` refused, so `--compare` alone could compare a capped `ts/` and give `RESULT agree`, and `checks.csv`
      carries no cap marker that would catch it later. Unit test: `--compare` on a copy of a run whose
      `ts/config.json` has `"cut_max":20`, and on one with the key removed → exit 2, the message names `cut_max`,
      no `cmp/report.txt` written; with `"cut_max":null` → it compares as before.
  - 3: a spec 2 or 15 check failed, or a STOP;
    - (C3, 2026-11-05; the lead's D10) also a spec 13 stop on a blind row (5.6): the run stops at the end of that
      stage, the comparison is still made, and the exit is 3 when the comparison gives no 5 or 6.
  - 4: a required hand example failed;
  - 5: a TS–Python difference not allowed;
  - 6: a stop of spec 8.5 (lawsearch-dump.md 9.3).
  - (C3) When several apply to one `--run`, the first of 6, 5, 3, 0 wins (lawsearch-dump.md 10). A Stop raised inside a
    stage (data stops, a must-be-0 count) still ends the run with exit 3 and no comparison, as before. (This order
    and the `STOP 13` report line of 5.6 were confirmed by the lead 2026-11-05, C4a.)
  - (C4a) The report line `stage 2 not opened: …` (5.7) changes no exit.
  - (C4b) A stop of spec 8.5 (6) also covers a `failed` or `label` line listed under the stop of a differing input
    (5.7, E10); a `DIFF` of class `derived` (5.7) is a difference (5) like any other.
- Before reading any data file, PY1 checks the sha256 of the five rules files against these values, and stops (exit 3)
  on any difference:

  | file | sha256 |
  |---|---|
  | `research/lawsearch-spec.md` | `9c9b5dc08c7fc224c4cf41cea49cef509e0409116a0263cea373451db3f00ff9` |
  | `research/lawsearch-hand.json` | `41d4788084630bb4dbc7f6c0a3a46cce40dd604a76b29358f84bf461f53a1d9a` |
  | `research/lawsearch-hand.md` | `f51112b57eb3d62df4afadcf3e838bbf51cb54b62942ca095c881d701840bae7` |
  | `research/ledger/lawsearch-candidates.json` | `92adb97481cf5a7cc7b17a4a31d06da638c2d30246951a6c51b564e7018fdeab` |
  | `research/ledger/spread-hours-h1.csv` | `2e5a8892d306bc9a9b183f32bddf1a3d7473f741b07e96b332b91e365ea6ce3a` |

## 3. The data handed from PY1 to PY2

### 3.1 A trial

A trial is a dict made by PY1 from one row of the candidates ledger:

```python
{"id": "m15.E04.F01", "order": 2, "tf": "m15", "kind": "EF", "e": "E04", "f": "F01", "s": None, "b": None}
```

- The ledger's tf `"15min"` becomes `"m15"`, and `"1hour"` becomes `"h1"`.
- kind is `"EF"`, `"S"` (with `"s": "S01"`), or `"B"` (with `"b": "B06"`).

### 3.2 A bars dict

A bars dict describes one pair and timeframe, built by PY1 (or, for the hand examples, by PY2's
`bars_from_mid`):

| key | type | meaning (spec 2) |
|---|---|---|
| `pair` | str | `"USD/JPY"` … |
| `pi` | int | table index 0–4 (USD/JPY, EUR/JPY, AUD/JPY, EUR/USD, AUD/USD) |
| `tf` | str | `"m15"`, `"h1"` (or `"h4"` for a higher series) |
| `step` | int | bar length in ms (900000, 3600000, 14400000) |
| `n` | int | number of bars |
| `s`, `T` | int64 array | start, close (T = s + step), UTC ms |
| `O`, `H`, `L`, `C` | float64 array | the rounded mid |
| `Po`, `Ph`, `Pl`, `Pc` | int64 array | the mid's points |
| `day` | int64 array | D(s_i) as YYYYMMDD |
| `htf` | bars dict or None | the higher series made from this one (m15 → 1 hour, h1 → 4 hours), with the same keys |
| `g` | int64 array or None | per bar i, the index of the usable higher bar (PY2's `htf_index`), −1 when none |

**Arrays**:

- 無し is `nan` in a float64 array.
- A tri-state truth is an int8 array: 1 true, 0 false, −1 無し.
- Directions are int8, 1 buy and −1 sell. Row 0 of a (2, n) array is buy, row 1 sell.

## 4. PY2: `research/lawsearch_sig.py` (exact public API)

```python
class NotBuilt(Exception): ...            # raised for any item, filter or trial not written yet

# ---- 4.1 indicators (spec 3.1, 3.2); every function returns a new float64 array of len(x), nan = 無し
def sma(x, p, plant=""): ...              # spec 3.2 SMA: oldest first; plant "smaNewestFirst" sums newest first
def ema(x, p): ...                        # EMA_p: seed = (oldest-first sum) / p at the first full window; α = 2/(p+1); prev = α*x + (1−α)*prev with 1−α = 1 − α; a 無し input resets
def rma(x, p): ...                        # the same with α = 1/p
def tr(H, L, C): ...                      # TR[0] = H[0] − L[0]; then max(H−L, |H−C[i−1]|, |L−C[i−1]|)
def atr(H, L, C, p): ...                  # ATR[p−1] = (TR[0]+…+TR[p−1]) / p; then (TR[i] + (p−1)*ATR[i−1]) / p
def rsi(C, p): ...                        # -> {"up","dn","U","D","rsi"} (spec 3.2 RSI: D == 0 → 100 first, then U == 0 → 0)
def donchian(H, L, C, n): ...             # -> {"HH","LL","s"}: §8.113 C1; s int8, 0 from bar 0, never 無し
def bigmove(C, s, step, sigma_window=288, sigma_min_usable=250, move_bars=6, threshold=2.0, gap_ms=None): ...
                                          # -> {"r","usable"(bool),"sigma","z"}: §8.113 C17; gap_ms default 12*step
def x_up(a, b): ...                       # spec 3.1 X↑ as an int8 tri; b an array or a float; −1 when any of the four values is nan, and at i = 0
def x_dn(a, b): ...

# ---- 4.2 the higher timeframe (spec 2 上位足)
def htf_index(T, htf_s, htf_step, plant=""): ...   # g(i) = the last k with htf_s[k] + htf_step <= T[i], else −1 (int64); plant "htfOpen"

# ---- 4.3 items and filters (spec 4.1–4.4, 17.3)
class Built:   # attributes: kind ("cross" | "condition" | "hold" | "state"), cond (int8 (2, n)), keep (bool (2, n) or None), warmup (int), columns (dict name -> array)
    ...
def item(eid, bars, params=None, answer_knowing=False): ...   # "E04", "E26", "B06"; NotBuilt otherwise
class FBuilt:  # attributes: f (int8 (2, n)), warmup (int), warm_ok (bool (n,) or None), columns
    ...
def filt(fid, bars, params=None): ...                       # "F00", "F01"; NotBuilt otherwise
def s_filter(sid): ...                                      # "S01" -> "F01"; NotBuilt otherwise
def trial_warmup(trial, params=None): ...                   # max(E's, F's); the S's F's; the B's

# ---- 4.4 events (spec 5)
def candidates(trial, bars, params=None, plant="", answer_knowing=False): ...
        # -> {"i": int64[], "d": int8[], "status": list of "emit" | "f_none" | "both", "warm": bool[]}
        #    every bar with a candidate, in bar order, buy before sell; plant "noRisingEdge"
def ind_columns(trials, bars): ...      # the ind/ columns of lawsearch-dump.md 5 (name -> array), for the built items of these trials

# ---- 4.5 hand examples of groups 3 and 4
def bars_from_mid(pair, tf, starts_ms, mid_rows): ...      # a bars dict from decimal strings: O..C = float(str); points = round(v * mult); day by spec 2
def run_hand(examples, plant=""): ...   # -> list of {"id", "status": "pass" | "fail" | "skip", "keys": [{"key", "status", "why"}]}
```

### 4.1 Indicators

- **Order of operations** (spec 3.1, 3.2, 21.5): every sum runs oldest first, one value at a time, in a Python loop.
  A square is `x*x`. `100 * a / b` is `(100 * a) / b`.
- Do not use `sum`, `math.fsum`, `np.sum`, `np.mean`, `np.std`, `np.convolve`, `np.cumsum` or pandas: their order is
  not the spec's. The values must agree with the TS to the last bit (lawsearch-dump.md 9.1). The only exception is
  bigmove's r, σ and z, which use `math.log` and are compared to relative 1e−9.
- **EMA, RMA**: spec 3.2 "EMA_p・RMA_p".
  - Seed at the first i ≥ p − 1 where x[i−p+1..i] are all finite: prev = sum / p, and out[i] = prev.
  - Then prev = α*x[i] + (1−α)*prev, with α = 2/(p+1) (EMA) or 1/p (RMA) as one division, and `one_minus = 1 − α`
    as a double.
  - A nan input makes prev and out nan. The next full window seeds again.
- **RSI**: up[0] and dn[0] are nan. U = rma(up), D = rma(dn); the first value is at i = p. RSI is nan when either is
  nan; 100 when D == 0; else 0 when U == 0; else `100 − 100 / (1 + U / D)`.
- **ATR, TR**: spec 3.2 "ATR_p" (the ATR form `(TR[i] + (p−1)*ATR[i−1]) / p`, not RMA's form).
- **SMA**: spec 3.2. The value is nan unless x[i−p+1..i] are all finite.
- **donchian** (§8.113 C1, spec 4.1 E26):
  - HH_n(i) = max H[i−n..i−1] and LL_n(i) = min L[i−n..i−1], nan for i < n.
  - s starts at 0. For i ≥ n: C[i] > HH and s ≠ 1 sets s = 1; C[i] < LL and s ≠ −1 sets s = −1; otherwise s is
    unchanged. Equal values do not break out.
- **bigmove** (§8.113 C17 with spec 17.3's substitutions):
  - r[t] = `math.log(C[t] / C[t−1])`. It is usable when t ≥ 1 and s[t] − s[t−1] ≤ gap_ms (gap_ms = 12 × step: 180
    minutes on m15, 720 on h1; a gap of exactly 12 × step is usable).
  - σ[i] for i ≥ sigma_window: over the usable r of r[i−W..i−1], when at least sigma_min_usable are usable. mean =
    oldest-first sum ÷ count; var = Σ (r − mean)*(r − mean) (oldest first) ÷ (count − 1); σ = `math.sqrt(var)`. σ is
    used only when > 0.
  - z[i] = `math.log(C[i] / C[i − move_bars]) / (σ[i] * math.sqrt(move_bars))`, only when r[i−move_bars+1..i] are all
    usable and σ[i] exists.

### 4.2 The higher timeframe

- PY1 builds the higher bars (3.2 `htf`). PY2's `htf_index` gives the usable one: the higher bar k may be used at
  bar i only when its grid end s_k + htf_step ≤ T_i. That is the clock, even when base bars are missing.
- Plant `htfOpen`: the last k with htf_s[k] ≤ s_i instead (a bar still forming).

### 4.3 The items of the trial

| id | kind | cond (row 0 buy, row 1 sell) | keep | warm-up | columns |
|---|---|---|---|---|---|
| E04 (rsi_back 14, 30) | cross | buy `x_up(RSI_p, 30)`, sell `x_dn(RSI_p, 70)`, p = params["rsi"] or 14 | none | p + 1 | RSI14, RSI14_U, RSI14_D, E04_buy, E04_sell |
| E26 (donchian-A20) | hold | buy `s == 1`, sell `s == −1` (n = params["donchian"] or 20) | none | n | DON20_HH, DON20_LL, DON20_s |
| B06 (bigmove) | condition | buy `z ≤ −threshold`, sell `z ≥ threshold` (−1 where z is nan) | 0 where T's UTC time-of-day is in [19:35, 24:00) | sigma_window (288) | BM_r, BM_ok, BM_sigma, BM_z, B06_buy, B06_sell, B06_keep |
| F00 | filter | 1 everywhere | — | 0 | — |
| F01 | filter | x = C − EMA_e(C), e = params["ema"] or 200: buy `x > 0`, sell `-x > 0`; −1 where x is nan | — | e (200) | EMA200, F01_buy, F01_sell |
| S01 | state | F01's f | — | F01's | — |

- **Set O** (`answer_knowing=True`, used only when the run's `manifest.json` says group "O"): E26's target is +1
  when C[i+1] > C[i], −1 when C[i+1] < C[i], and otherwise the previous target (0 at the start). This planted error
  reads the next bar, and spec 15's checks must catch it. The trial does not compare O runs between TS and Python,
  but write it anyway, so that an O run can be compared later.
- **params** are the hand examples' shrunk windows. The keys are `rsi`, `donchian`, `ema`, `sigma_window`,
  `sigma_min_usable`, `move_bars`, `threshold`, `gap_ms`, `warmup` and `f_warmup`. A run never passes them.

### 4.4 Events (spec 5, with §8.113 5 for B06)

In this order, per direction d:

1. **①** The condition comes from the item, or from F's f for an S row.
2. **②** The raw signal at bar i:
   - cross: `cond[d][i] == 1`;
   - condition and hold: `cond[d][i] == 1` and `i ≥ 1` and `cond[d][i−1] == 0`, and i is not the first bar where
     cond[d] is not −1;
   - state: `f[d][i] == 1`.
3. **③** keep == False drops the raw signal (uncounted). The condition array is unchanged, so the next bar still
   compares with ①'s value.
4. **④** f == −1 gives status `f_none`; f == 0 drops the signal (not written, not counted); f == 1 keeps it.
5. **⑤** Two directions left at one bar: both get status `both`.
6. **warm** is `i ≥ max(item warm-up, filter warm-up)` (an S row: its F's).

Plant `noRisingEdge`: condition and hold kinds emit every bar where cond is 1.

## 5. PY1: `research/lawsearch-check.py`

The layout below is recommended. Its names are free, except those the CLI and PY2 fix.

### 5.1 Reading the day files (spec 2, 21.5 ファイルの形と値の読み方)

- **Keys**: every date from jstDayKey(fromMs − 86400000) to jstDayKey(toMs), oldest first. jstDayKey(t) is the UTC
  date of t + 9 hours, as YYYYMMDD.
- **Paths**: `<RUN>/gmo/<SYM>/<15min|1hour>/<bid|ask>/<key>.json`.
- **Parse**: `json.loads(text, parse_constant=…)`, where parse_constant raises for NaN and Infinity. A file that does
  not parse, is missing, or whose object is not `status` 0 or 404 with a list `data` is a read failure.
- **Per data element**:
  - An element that is not a dict is unparseable.
  - For each of `openTime`, `open`, `high`, `low`, `close`:
    - The right form is a `str`, ASCII digits only for openTime, and `re.fullmatch(r"[0-9]*\.?[0-9]*")` with at least
      one digit for a price. Its value is `float(s)`. When that is not finite, the row is unparseable.
    - Any other value is unparseable unless parseKlines would read it as a finite number. Then it is a **stop** (the
      run stops, exit 3, after the counts are written).
    - parseKlines' reading of a value: a JSON number (a Python int or float, but not a bool) as is; a bool, None, a
      missing name, a list or a dict as nan; a string by JavaScript's `Number(string)`. An int too large for a float
      is infinite.
  - Check each value on its own: a row with a "-" price and a JSON-number openTime is a stop.
  - **JavaScript's `Number(string)`**:
    1. Strip the JS white space: U+0009–U+000D, U+0020, U+00A0, U+1680, U+2000–U+200A, U+2028, U+2029, U+202F,
       U+205F, U+3000, U+FEFF.
    2. Then: `""` → 0; `Infinity`, `+Infinity`, `-Infinity` → ±inf; `0x…`, `0o…`, `0b…` (no sign; digits of that
       base; case-insensitive prefix) → the integer.
    3. Otherwise `[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?` → `float()` of it.
    4. Anything else → nan.

    Use this regex, not `float()` alone: `float()` accepts "1_000", "inf", "nan" and non-ASCII digits, which JS does
    not.
- **Counts** (spec 2, per call; both sides for the unparseable rows):
  - An unparseable row is a row that does not exist: it is in none of the counts below and in no merge.
  - Then sort each side's rows stably by openTime (file order, then row order within a file, kept for equal times).
  - dropped (捨てた数): Bid rows whose same-start Ask (the last Ask row of that start) closes below them.
  - same start (同じ始まりの行の数): Bid rows with an earlier Bid row of the same start.
  - The Ask < Bid share by UTC year of the row's start: num = dropped, den = Bid rows with a same-start Ask.
- **Merge** (spec 2 mergeSides). For each Bid row in order:
  - when the start already has a bar, skip the row;
  - when there is no same-start Ask, or the Ask close is below the Bid close, skip the row;
  - otherwise make the bar from this Bid row and the last Ask row of that start.
- **Range and weekend**:
  - Keep bars with fromMs ≤ s and s + step ≤ toMs.
  - Drop a bar when both s and s + step − 1 are "market closed": Saturday; Friday from 22:00; Sunday before 21:00
    (UTC).
- **Mid** (spec 2): v = (bid + ask) / 2 as a float, then `float(Decimal(v).quantize(Decimal("0.001" or "0.00001"),
  rounding=ROUND_HALF_UP))`.
  - Use `Decimal(v)` (the exact value of the float). Never `Decimal(str(v))`, `round()` or decimal string addition.
  - Plant `midHalfEven`: ROUND_HALF_EVEN. Plant `midDecimalStr`: `Decimal(str(v))`.
- **Points**:
  - `round(x * 1000)` on the yen pairs, `round(x * 100000)` on the dollar pairs, for the mid and for the raw sides.
  - A raw value farther than 1e−6 from its whole number of points stops the run.
  - Plant `pointsTrunc`: `int()`.
- **Index**: 0, 1, 2, … in start order (gaps closed up).
- **Higher bars** (spec 2 上位足): group the base bars by floor(s / htf_step) (the UTC grid: 4 hours = 00, 04, …,
  20). Each side's open is the first bar's, close the last bar's, high the max and low the min. Then the mid and the
  points as above. The index runs from 0. g = `sig.htf_index(T, htf_s, htf_step)`.
- **Day, seasons, holidays** (spec 2):
  - D(t) = the UTC date of t + 3 hours, Saturday → Friday. Plant `daySatSplit`: no Saturday rule.
  - New York summer: [second Sunday of March 07:00 UTC, first Sunday of November 06:00 UTC) of t's UTC year.
  - London summer: [last Sunday of March 01:00 UTC, last Sunday of October 01:00 UTC).
  - The season group: 0 both winter, 1 both summer, 2 New York only summer, 3 London only summer.
  - GMO holiday: the UTC date of t + 3 hours is 12-25 or 01-01, without the Saturday rule.
- **Spec 15 data checks** (stop when any fails):
  - no read failures and no value stops;
  - the four values of each side: low ≤ min(open, close) ≤ max(open, close) ≤ high;
  - no two bars of one start after the merge (and none among the higher bars);
  - the Ask < Bid share ≤ 0.1% per pair, timeframe and year;
  - every raw value within 0.25–2.5 times the walk's start (USD/JPY 110, EUR/JPY 125, AUD/JPY 80, EUR/USD 1.1,
    AUD/USD 0.7: synthetic runs).

### 5.2 Exclusions (spec 1, 6)

- X = T + 8 × step.
- **Half**:

  | result | rule |
  |---|---|
  | first | START ≤ T, wk(T) ≤ 2888, X ≤ SPLIT |
  | second | T ≥ SPLIT, X ≤ END |
  | ①b | START ≤ T < SPLIT, otherwise |
  | ① | otherwise |

  - wk(t) = floor((t − 334800000) / 604800000).
  - S0 2023-10-27, START 2024-01-01, SPLIT 2025-05-19 and END 2026-10-31, each at 00:00 UTC.
  - Plant `splitShift`: SPLIT one week later.
- **Reasons**, first match:
  1. ① or ①b by the half.
  2. ① (code `r1w`) when the bar is before the warm-up. This is ignored for ①b.
  3. ② when T, T + 1 min and T + 3 min are all "possibly closed": Friday from 21:00, Saturday, Sunday before 22:00.
  4. ③.
  5. ④ [T, X) holds a Friday 21:00 UTC (X > the first Friday 21:00 at or after T), or [T, X) meets a GMO holiday's
     [day before 21:00, day 21:00).
  6. ⑤ T in (Sunday 21:00, Monday 00:00], or (a holiday's day 21:00, the next 00:00].
  7. ⑥ The entry slot (pair, NY season of T, UTC 15-minute slot of T) or the exit slot (the same at X − 1 minute) is
     `avoid = yes` in `spread-hours-h1.csv`. The season is `summer` when New York is on summer time; the slot is
     floor((t mod 1 day) / 15 minutes).
  8. counted.
- **③**:
  - The slots of the timeframe run on the grid over [S0, the load's end).
  - A slot a is open when: not all of a, a + 1 min and a + 3 min are possibly closed; a is not a GMO holiday; and at
    least 3 of the 5 pairs have a bar starting at a.
  - A hole of a pair is a run of adjacent open slots without its bar: at least 2 on m15, at least 1 on h1. A slot
    that is not open breaks a run.
  - A signal at bar i is excluded when a hole slot a of its pair has a < T_i and a + step > s_{i−9}.
  - Plant `reasonUsesFuture` is the TS's; the Python has no twin.
- **Blind bars**: for each pair and half, a bar passes when its T is in the half and ②–⑥ pass (no warm-up). The bar
  then has a buy row and a sell row.

### 5.3 Signals of a run, and adopting the TS's at allowed places

1. For each trial and pair, `sig.candidates(trial, bars, answer_knowing=(group == "O"))`, then the reasons (rows with
   status emit) and the half column.
2. Write `py/signals/<trial>.csv` (lawsearch-dump.md 6) and `py/ind/…` (with `sig.ind_columns`).
3. Before stage 0's counts, compare with `ts/signals/`. At a z-border bar of B06 (lawsearch-dump.md 9.2), replace
   your rows of that bar with the TS's rows. Do the same at the next bar, whose rising edge reads it. Print `ALLOWED
   z-border …`.
4. Any other difference is reported later by the comparator. Do not adopt it.

### 5.4 Trades, the blind table, Δ_late (spec 7, 8.1, 8.8)

- **Entry bar j**: the first bar with T ≤ s_j < X. There is no trade without one.
- **Exit bar x**: the bar whose close is exactly X. Otherwise the last bar with s_x ≥ s_j and T_x ≤ X (the
  substitute, `subst = 1`).
- **Values**: m = d × (Pc[x] − Po[j]) (points); h = sign(m); pl = buy Bc[x] − Ao[j], sell Bo[j] − Ac[x] (points).
- **Plants**: `entryAtSignalClose` (entry at the signal bar's close side, and m from Pc[i]); `entryEarly` (j − 1);
  `exitLate` (x + 1); `noSubstituteExit` (no trade without an exact exit).
- **Blind table** of a timeframe and half: every passing bar with a trade, a buy row then a sell row, sorted by T,
  then pair, then buy before sell (rows 0, 1, …).
  - hour = UTC hour of T; season = the season group of T.
  - stratum = ((pi × 2 + (0 buy | 1 sell)) × 24 + hour) × 4 + season; week = wk(T).
- **Late table** (8.8), from each blind row:
  - The trade is on the 15-minute bars of the pair. Entry: the first start ≥ T + 15 min and < X + 15 min. Exit: the
    close = X + 15 min, else the substitute.
  - Hour and season are of T + 15 min; the week stays wk(T).
  - A row is left out (and counted) when there is no late entry, when [T, X + 15 min) meets ④, or when X + 15 min
    passes the period's end (SPLIT or END). The last count must be 0.
- **A trial's rows**: its counted signals of the half.
  - A signal whose bar has no blind row and no trade adds to no_trade.
  - A signal with a trade but no blind row adds to no_blind. That must be 0: stop otherwise.

### 5.5 Measures (spec 8, 21.5)

The row order is the blind table's. A signal row comes just before the blind row of the same (T, pair, d). Every sum
below goes over that order.

- **Strata**: n_s, m_s; mean of h/2 over the signals, and B_s over the blind rows (each value halved first, then
  summed in row order, then divided by the count).
  - Δ = 100 × Σ over strata by ascending id of (n_s/N) × (signal mean − B_s), with the 100 multiplied last. Δ′ = Δ /
    100.
  - a = (100 × (Σh / N)) / 2.
  - PL = Σ(pl/10) / N; W = Σ(pl > 0) / N.
  - Blind PL by stratum weight Σ (n_s/N) × mean(pl/10); M = Σ (n_s/N) × mean(|m|/10).
  - PL by pair and by direction.
  - Plant `blindNoHour`: the stratum without its hour. Plant `noBlind`: B_s = 0.
- **PL without the best week** (8.4): weekly sums of pl in points (integers). Drop the largest (on a tie, the
  oldest) and average the rest of pl/10.
- **Influence functions** (8.5):
  - Δ, a signal: (h/2 − B_s − Δ′) / N, with h/2 − B_s computed first.
  - Δ, a blind row: −(n_s/N) × (h/2 − B_s) / m_s.
  - PL: (pl/10 − PL) / N.
  - a: (h/2 − a′) / N.
  - Plant `inflStratumMean`: the signal influence subtracts the stratum's mean of h/2 − B_s in place of Δ′.
- **Clusters**: weeks, and 4-week blocks floor((wk − w0)/4), with w0 2817 (first) and 2889 (second).
  - S_g = the sum, in row order, of every row's influence within cluster g.
  - C = the number of clusters with any table row.
  - SE = sqrt((C / (C − 1)) × Σ_g S_g × S_g), with g ascending, then × 100 for Δ and a.
- **Candidates**: week (df C_week − 1); 4w when C_4w ≥ 10 (df C_4w − 1); shift (df C_week − 1).
  - **Shift**: W_h is the table's weeks ascending. For k = 1 … W_h − 1, move each of the value's signals (Δ, a, PL:
    the signals with a trade; Δ_late: the late rows) from its week to the k-th next week of W_h, wrapping around. T′
    = T + (w′ − w) × 1 week.
  - Look up the row at (pair, T′, d). Drop the signal when there is none. The stratum is that row's.
  - The value of k is computed as above. A k with no signal is skipped. SD_shift is the two-pass standard deviation
    ÷ (K − 1) when K ≥ 2.
  - Plant `shiftNoWrap`: a signal that would wrap past the last week is dropped.
- **Choice** (8.5): for each candidate, t = value / se and p = one-sided p.
  - There is no t when C < 2, N = 0, |se| < 1e−12, or (shift) K < 2. When any used candidate has no t: p = 1 and
    there are no lb and ub.
  - The interval uses the largest t(0.975, df) × se, and p the largest p. Ties go to week, then 4w, then shift.
  - The reported t is p's candidate's t.
  - |x| < 1e−12 counts as 0 for these numbers only.
- **t distribution**: U(x, ν) = ½ I_{ν/(ν + x²)}(ν/2, ½), the upper tail for x ≥ 0, with a relative error under
  1e−12. Integer ν has closed forms; Decimal arithmetic is fine.
  - One-sided p: x ≥ 0 gives U(x, ν) directly; x < 0 gives 1 − U(−x, ν).
  - The quantile t(q, ν): lo = 0, hi = 1. Double hi while T(hi) < q. Then, while hi − lo > 1e−12 (at most 200
    times), m = (lo + hi)/2: T(m) < q sets lo = m, otherwise hi = m. The answer is (lo + hi)/2.
- **D_F** (8.6): (E, F01) against S01 of the same timeframe and half.
  - Per row, take the difference of the two influence functions (a row in one only counts 0 in the other).
  - Sum per cluster in row order. Use week and 4w (when C_4w ≥ 10); the wider t(0.975) × se wins (ties: week).
- **Δ_late**: the same machinery on the late table (its own weeks for C and W_h). PL_late is a point only.
- **Second-half extras** (11):
  - Δ by direction and by pair: Δ with only those signals; the blind table unchanged.
  - C6: Δ with both the signals and the blind rows kept to weeks 2889–2926, then 2927–2964.
- **The non-overlapping version** (21.5): per pair and direction, in T order, drop a signal whose T is before the X
  of the last kept one (T == X stays). Report Δ and PL as points only.

### 5.6 Stages (spec 9, 10, 11, 13)

- **Stage 0** loads [S0, END). Counts (lawsearch-dump.md 7):
  - floor: ≥ 300 counted and ≥ 30 weeks in both halves.
  - same trial: the first-half counted set (pair, T, d) equal to an earlier trial of the same timeframe, 0-count
    trials not compared. The name is the earliest one.
  - Groups: union of these links.
    - Fixed: the 15 trials of one E; E01–E06, E07–E09, E10–E11, E13–E15, E16–E18, E19–E21, E22–E23, E24/E25/E31,
      E26–E27, E38–E39; (B07, B10, B03), (B13, B14), (B01, B02).
    - Overlap: between floor-passing E×F and B trials of one timeframe, a share ≥ 0.5 either way. The share of A→B is
      the fraction of A's first-half counted signals with a B signal of the same pair and direction within one bar's
      length.
    - S rows are their own groups and never link.
  - MDE: empty without g.
  - (C3, 2026-11-05; the lead's D1) What stage0.csv may hold per trial: the `first.*` keys, `second.counted`,
    `second.weeks`, `all.adds_up` (1/0), and `floor`, `same_as`, `group`, `g` … `mark`, `stage3_estimate`. Nothing
    else of the second half, and no other number that spans both halves. (That `floor`, `same_as`, `group`, `g`,
    `df`, `pass_min`, `mde` and `mark` stay per trial was confirmed by the lead 2026-11-05, C4a.)
    - Keep computing, for every trial, its four whole-range counts: every emitted candidate, ① (T ≥ SPLIT
      included), ①'s warm-up part (r1w) and ①b. Use them for the trial's own adds-up rule (`all.adds_up`).
    - Do not write them per trial. Write their sums per timeframe into `stage0_totals.csv`, half empty, after
      `floor.h1`: `all.emitted.m15`, `all.emitted.h1`, `all.r1.m15`, `all.r1.h1`, `all.r1w.m15`, `all.r1w.h1`,
      `all.r1b.m15`, `all.r1b.h1` (int; the sum over that timeframe's trials, in table order).
    - Reason: with the first-half keys, a trial's whole-range `all.r1` gave its second-half ① count and `all.emitted`
      its second-half r2–r6 total; spec 9 後半 says 試しごとの内訳は、段2まで出さない (lawsearch-dump.md 7).
    - (C4a, 2026-11-05; the lead's E4) These sums stay. In a run with only one trial in a timeframe they are that
      trial's own numbers, so such a run is for development only (lawsearch-dump.md 7). Write them the same way in
      every run.
  - no_blind (spec 6: 0件でなければ、プログラムの誤りとして止まる): a trial's no_blind of either half above 0 stops the
    run in stage 0 (Stop, exit 3), for every trial. The second half's count is not written (23.3), so the check is
    made here. (Kept from round C2; the TS does the same from C3, the lead's D4.)
- **Stage 1** loads [S0, SPLIT).
  - The first-half tables. Every floor-passing trial that is not a same trial gets its measures, and so do the 20
    blind rows.
  - Suspicion (13), on rows with ≥ 100 counted signals: |Δ| ≥ 8, |a| ≥ 10, PL ≥ 0.15 × M, |Δ − Δ_late| ≥ 4, or W
    equal to 0 or 1.
  - Rules 1–6:
    1. floor and not a same trial;
    2. checks (from `ts/checks.csv`);
    3. Δ has a t and Δ > 0;
    4. PL > 0 and PL without the best week > 0;
    5. D_F > 0 for a directional F;
    6. not suspicious, or (q4 (a)) suspicious with `checks_passed` true in `ts/suspect.csv`.
  - **Choice**: order by lb descending, then counted descending, then table order. Take 3 per timeframe. Skip:
    - one in the group of a chosen trial (S rows: only themselves);
    - an (E, F) after its S_F (same F name: S01 ↔ F01);
    - an S_F after an (E, F01).
  - **Labels** (exact):

    | when | label |
    |---|---|
    | skipped, same group | `同じ重なりの組（<chosen>）` |
    | skipped, after the S | `選んだ <S> と同じ F の (E, F)` |
    | skipped, after the (E, F) | `選んだ <EF> と同じ F の S` |

    In a run, `<…>` is the trial id. In a hand example, it is the example's name.
  - BH (q = 0.10, on the first half's max(p_Δ, p_PL), over the trials measured): the largest k with p_(k) ≤ k × 0.10 /
    m.
  - (C3, 2026-11-05; the lead's D10) **A blind row hits** (spec 13: 物差しが当たったら、すべて止めて調べる). When one of
    the 20 blind rows (`blind.<tf>.<SYM>.<buy|sell>`) of your own stage-1 suspicion rows has `hit` 1:
    - finish stage 1 as usual (every stage-1 file, `suspect.csv` with the stage-1 rows, the choice and
      stage1.csv / stage1_summary.csv);
    - do not open stage 2 (write no stage-2 file or row; lawsearch-dump.md 11.14 (a) lists them);
    - run the comparison as usual; in `cmp/report.txt`, write one line `STOP 13 stage1 <id>: a blind row hit spec
      13's lines` per hit blind row, after the `ALLOWED` and 9.3 `STOP` lines and before `RESULT`. `RESULT` stays
      the comparison's (`agree` or `differ <n>`);
    - exit 3, unless the comparison gives 6 or 5 (2).
    - The TS stops at the same place (its checks.csv then has a failed `suspect.blind.stage1` row), so both folders
      hold the same files. Reason: lawsearch-dump.md 11.14 (c). (The report line and the exit order were confirmed
      by the lead 2026-11-05, C4a.) The TS's failed `suspect.blind.stage1` row is of stage `stage1`, so the report
      also gets the line `stage 2 not opened: …` of 5.7, after the `STOP 13` lines.
    - Unit test (C3, required): on small made-up inputs where one blind row's stage-1 suspicion hits (for example
      |a| ≥ 10 with ≥ 100 counted signals), check that stage 2 is not opened (no stage-2 file or row in py/), that
      report.txt has the `STOP 13 stage1 …` line before `RESULT agree`, and that the exit is 3; with one more
      difference added, the exit is 5; with a stage-2 blind hit, every stage-2 file is written and the exit is 3.
- **Stage 2** loads [S0, END). The second-half tables, for the chosen trials only.
  - (C3, 2026-11-05; the lead's D8) **When stage 2 is opened**: only when K_total > 0, your own stage 1 has no blind
    row hit (above), and `ts/checks.csv` has no row with `passed` ≠ 1 among the rows whose `stage` is `gate`,
    `stage0`, `stage1` or `stage1end`. Otherwise write nothing of stage 2, log which TS checks failed, and compare
    as usual; the exit is the comparison's (a TS check is the TS's; the Python does not turn it into 3). Reason: spec
    11 opens the second half once, and a run with a known failure must not use it; the TS then does not open stage 2
    either (lawsearch-dump.md 11.14 (a)). This widens round C2's rule, which closed stage 2 only on a failed
    `stage1end` row. Rule 2 (checks_ok) still reads only `gate`, `stage0` and `stage1`.
    - (Confirmed by the lead 2026-11-05, C4a.) This is stricter than spec 10 rule 2 (a rule of each trial) and spec
      15 (その段の数字を出さない) on purpose: spec 11 opens the second half once, so on real data one failed check keeps
      stage 2 closed for every trial until the error is fixed and the run is made again. Your exit stays the
      comparison's.
    - (C4a, 2026-11-05; the lead's E6) Besides your log, write the reason into `cmp/report.txt` as one line
      `stage 2 not opened: …` (5.7).
  - (C3, 2026-11-05; the lead's D9) **`cut.chosen.second` failed** (a `ts/checks.csv` row with that name, stage
    `stage2`, `passed` 0): compute and write every stage-2 file as usual, compare as usual, and say in your log that
    the TS withheld stage 2's numbers. Nothing changes in your files or your exit. Reason: the cut is the TS's, and
    spec 23.2's 段2の数字を出さない is about what the TS prints, not what is compared (lawsearch-dump.md 11.14 (b)).
  - (C3, 2026-11-05; the lead's D10) A blind row of stage 2 that hits: as at stage 1 (write every stage-2 file,
    `STOP 13 stage2 <id>: …` lines, exit 3 unless 6 or 5). Nothing comes after stage 2 in the trial.
  - κ from `config.json` multiplies the three se of Δ (κ_Δ) and of PL (κ_PL) by max(1, κ) before the choice.
  - p = max(p_Δ, p_PL).
  - Holm over both timeframes at a one-sided 2.5%: order by p ascending, then min(t_Δ, t_PL) descending, then counted
    descending, then table order (p = 1: counted, then table order). Pass while p_(k) ≤ 0.025 / (K − k + 1).
  - The Δ-only Holm uses p_Δ and t_Δ.
  - C1–C7 as spec 11. C2 and C3 look at directions and pairs with ≥ 30 counted signals.
  - Verdicts 1–5 in order.
  - Labels:

    | verdict | label |
    |---|---|
    | 1 | `後半で確かめられた（問2 は (b) なので「法則の候補」。段3を待つ）` |
    | 2 | `悪い` |
    | 3 | `一部（満たさなかった条件: C3・C4・C7）` (the failed ones, joined by `・`) |
    | 4 | `向きだけ` |
    | 5 | `言えない` |
    | D_F's lower end ≤ 0 | `合図 E を足した分の上積みは言えない（F だけの行と区別できない）` |

  - MDE = (t(1 − 0.025/K, df) + t(0.80, df)) × se of p_Δ's candidate.
- **Plants**: `noHolm` (each p ≤ 0.025), `iutOneLeg` (p = p_Δ), `c4PointOnly` (C4 = Δ_late > 0), `noEx1Week` (rule
  4 and C7 without the best-week exclusion), `noDF` (no rule 5).

### 5.7 The comparison

lawsearch-dump.md 9 and 10 fix the comparison. PY1 writes `RUN/cmp/report.txt` and exits as stated there.

- (C3, 2026-11-05; the lead's D2) **An `ALLOWED` line excuses only what rests on the near or tied values
  themselves.** lawsearch-dump.md 9.3, 11.12 and 11.13 give the full rule; in short, for a key of trial X in
  `stage2.csv`:
  - `holm_rank`: only when X is one of the two trials of the near pair of p (within 1e−9 in either
    implementation, not equal in both), or of an exact tie of p < 1 whose tie-breaking t follows an adopted 8.5 split
    (an adopted `delta.use_p` or `pl.use_p` split of one of the two, on the t that is min(t_Δ, t_PL) of that trial
    in either implementation). Never through a pair of two other trials.
  - `holm_pass`, `C1`: the same, or X's own p vs its own Holm threshold within 1e−9.
  - `holm_delta_rank`, `holm_delta_pass`: the same with p_Δ; a tie only through an adopted `delta.use_p` split.
  - `failed`, `label`, `verdict`: replaced in C4a by E1, and in C4b by E10 (the next bullet; C3's wording let them
    through X's near pair of p).
  - Holm stops at the first failure, so a `holm_pass` split also changes the trials after it; that split is a `STOP
    8.5` (exit 6), and the later trials' differences stay `DIFF` lines. (Confirmed by the lead 2026-11-05, C4a.)
    (C4b) Under E10, a later trial's `C1` is such a `DIFF`, so its derived keys are `DIFF` lines too (step 2). These
    lines are consequences of the stop, not program errors (the lead's E12, lawsearch-dump.md 12); a `DIFF` of class
    `derived` (step 1) stays a program error of that side, under a stop or not [the docs writer's reading, C4b].
  - Tests that must now report `DIFF` and exit 5 (they gave `ALLOWED` and exit 0 in round C2): the reviewer's R1,
    R2 and R3 in
    `/tmp/claude-0/-home-user-fx-canvas-mind/293f73fc-e90f-5bbc-b9e3-ce7f929d8068/scratchpad/lawsearch/trial/c2/review/t_review.py`,
    and the refuter's r1, r2, r2b, k1b and r3 in
    `/tmp/claude-0/-home-user-fx-canvas-mind/293f73fc-e90f-5bbc-b9e3-ce7f929d8068/scratchpad/lawsearch/trial/c2/refute-2/t_refute.py`
    (both are Python harnesses on small stage1/stage2/measures files; no TS). Their controls keep their results (k0
    exit 0; k1, k2, k3 `DIFF`). Add them to your test file. Re-check round C2's 22 decision tests and 16
    8.5-candidate tests against the narrowed rule: a case whose excuse is on the pair's own keys stays as it was
    (for example "holm_rank split, two p_iut within 1e-9 -> ALLOWED" on those two trials); the case "two p_iut exactly
    tied, order by t that follows an adopted split -> ALLOWED" stays only if the adopted split's t is min(t_Δ, t_PL)
    of its trial in either implementation (otherwise change its data so it is, and add the case where it is not,
    which must give `DIFF`).
- (C4b, 2026-11-05; the lead's E10, C4a review findings 1 and 2; it replaces C4a's E1 for these three keys)
  **`stage2.csv` `verdict`, `failed` and `label` of a trial X: derived keys, judged by consistency.** Spec 11's 判定
  makes them from X's other stage-2 values. So do not look for a near value behind them; check that each side's keys
  follow from that side's own inputs, then judge the inputs that differ. "Within 1e−9" stays absolute, and either
  implementation's own value suffices.
  - **Step 1, each side on its own.** For each trial X of `stage2.csv`, and for `ts/` and `py/` separately (whether
    or not the two differ), read that side's row of X and recompute X's verdict, failed list and label from it with
    your own code of 5.6 (the verdict order, the failed list of lawsearch-dump.md 11.8, the label table). In your
    code these are `verdict_of`, `failed_list` and the label table; call the same functions you use to make your
    own stage 2, on the values read from the file. The inputs:
    - `C1` … `C7` as written (`1` / `0`);
    - the verdict-2 test: `delta_ub` < 0 under spec 8.5's zero band (E11, below): true when `delta_ub` is not empty,
      is below 0 and |`delta_ub`| ≥ 1e−12 (your `lt0`); an empty `delta_ub` is not below 0;
    - `holm_delta_pass` as written.

    (`holm_pass`, `late_lb` and the p values are not read here: the verdicts read `C1` rather than `holm_pass` and
    `C4` rather than `late_lb`, and those keys keep their own rules.) The derivation (spec 11 判定, in its order): verdict 1 when `C1` … `C7` are all 1; else 2 when
    the verdict-2 test is true; else 3 when `C1` is 1; else 4 when `holm_delta_pass` is 1; else 5. `failed`: for
    verdict 3, the conditions among C2 … C7 that are 0, in that order, joined by `・`; empty for every other verdict.
    `label`: the label of the verdict (5.6's table; verdict 3: `一部（満たさなかった条件: <failed>）`).
    - When a side's written `verdict`, `failed` or `label` differs from what its own inputs give, that key is a
      `DIFF`: a program error in that side's derivation. Never `ALLOWED`, never a `STOP`, whatever the other side
      holds and whatever else differs. Judge each of the three keys on its own: a side whose `label` does not follow
      its inputs may still have a `verdict` that does.
    - [Docs writer's readings of E10, C4b; the lead to confirm] Make the check for every trial, also when `ts/` and
      `py/` write the same value (both sides then have the same error; still a `DIFF`). A side whose inputs of X
      cannot be read (a missing row, a bool that is not `0` or `1`, a `delta_ub` that is neither empty nor a number)
      cannot be checked: its derived keys of X are `DIFF`. Write
      `DIFF stage2.csv <X>|<key> value ts=<v> py=<v> class=derived (<side> inputs give <w>)`, naming both sides when
      both fail. It counts as a difference in the `FILE` line and in `RESULT` (exit 5 unless a 6).
  - **Step 2, both sides follow their own inputs.** Then a difference in a derived key can come only from inputs that
    differ between the two sides. Judge each differing input by its own rule:
    - `C1`: the rule of `holm_pass` and `C1` (the C3 bullet above: X in the near pair of `p_iut`, or in the exact tie
      broken by an adopted split, or X's own `p_iut` within 1e−9 of its own Holm threshold 0.025 / (K − k + 1), with
      K that implementation's `K_total` from its `stage1_summary.csv` and k its `holm_rank` of X): a `STOP 8.5`;
      otherwise a `DIFF`;
    - `holm_delta_pass`: the same with `p_delta` and `holm_delta_rank` (a tie only through an adopted `delta.use_p`
      split): a `STOP 8.5`; otherwise a `DIFF`;
    - `C4`: X's own `late_lb` within 1e−9 of 0 in either file: `ALLOWED 8.5`; otherwise a `DIFF`;
    - the verdict-2 test (it differs when, under the band, one side's `delta_ub` of X is below 0 and the other's is
      not): excused when X's own `delta_ub` is within 1e−9 of 0 in either file, otherwise not. It is not a key of the
      file and gets no line of its own; the derived key's line names it;
    - `C2`, `C3`, `C5`, `C6`, `C7`: nothing excuses them (exact values): each is a `DIFF`, from the plain comparison.

    Then write the derived key's difference as:
    - `ALLOWED 8.5` when every differing input is excused and none of them is a `STOP 8.5`;
    - listed under the stop when at least one differing input is a `STOP 8.5` and every other one is excused. [Form
      chosen by the docs writer, C4b; the lead to confirm] Write it as a line
      `STOP 8.5 stage2.csv <X>|<key> ts=<v> py=<v> (…)` after the input's own `STOP 8.5` line. Like every `STOP`
      line, it is not counted as a difference; the exit is 6 because of the input's stop;
    - a `DIFF` when any differing input is a `DIFF` (exit 5, or 6 when there is also a stop). This `DIFF` follows from
      the input's own `DIFF` line; it is not an error of the derivation.
    - `verdict` as before: excused (every differing input excused, a stop among them or not) it is a `STOP 8.5`
      (exit 6); not excused it is a `DIFF` (exit 5), never a stop.
    - In the `ALLOWED` or `STOP` line, name each differing input of X and the value that excuses it, for example
      `(C4 of m15.E26.F00 differs: its late_lb within 1e-9 of 0 (ts))` or
      `(C1 of m15.E04.F00 differs: its p_iut within 1e-9 of its Holm threshold 0.008333333333333333 (rank 1, ts))`.
  - **What changes against C4a's E1.**
    - Your C4a functions `_x_own_split`, `_x_label_verdict` and `_x_failed` excused a derived key when one of X's own
      decisions differed and was excused, without checking that the written keys followed from their inputs. Replace
      them by steps 1 and 2.
    - The pair and tie routes are no longer cut off for these keys: when X's `C1` (or `holm_delta_pass`) splits
      through X's own near or tied pair of p, that input is a `STOP 8.5` as before, and X's derived keys, when both
      sides follow their own inputs, are listed under the stop (in C4a: `DIFF` lines under it). Exit 6 either way.
      This is safe now: a difference that comes from C2, C3, C5, C6 or C7 either differs as an input (its own `DIFF`)
      or, when that condition is the same on both sides, a list or label that names it does not follow its own side's
      inputs (step 1). That was C3 review finding 1, which E1 had closed by cutting the routes.
    - C4a's special reading for "exactly one verdict is 3" is gone: the other side's empty list is checked in step 1.
  - Why (one line of history): with E1, C4a's review found a `label` excused when only an unrelated decision of X
    split (finding 1: C4 split, both verdicts 5, py's label `向きだけ`), a `failed` excused through `holm_delta_pass`
    (finding 2), and the verdict-2 test made with a plain < 0 (finding 3, E11 below).
- (C4b, 2026-11-05; the lead's E11, C4a review finding 3) **The zero band in every sign test of the comparator.**
  Every sign or zero test that the comparator makes on a value that the spec tests with spec 8.5's zero band
  (0 との比べは、|x| < 1e−12 を 0 とする: `delta_ub`, `late_lb`, `lb`, `dF_lo`, a point of Δ or PL, …) uses that same
  band: your `lt0`, `gt0` and `le0`, never a plain `< 0` or `> 0`. Today the one such test in the comparator is the
  verdict-2 test of step 1 and step 2 (C4a's `_below0` used a plain `< 0`). The nearness tests ("within 1e−9" of 0 or
  of a threshold) are not sign tests and stay as they are. Why: with a plain `< 0`, `delta_ub` −5e−13 (0 under the
  band, verdict 3 by your own `verdict_of`) against −3e−12 (verdict 2), a real split on X's own `delta_ub` near 0,
  gave a `DIFF` instead of a `STOP 8.5`, and −5e−13 against +5e−13 (not below 0 on either side) a split that excused
  a wrong label.
- (C4a, 2026-11-05; the lead's E2, the C3 docs writer's question Q6) **`stage1.csv` `rank` of a trial X**: excused
  only when X is one of the two trials of a near pair of `lb` of X's timeframe (|lb_X − lb_Y| ≤ 1e−9 in `ts/` or in
  `py/`, and not exactly equal in both). Never for another trial of that timeframe (before, a near pair excused the
  rank of every trial of the timeframe). Stage 1 has no tie route: two `lb` exactly equal in both are ordered by
  counted, then table order, and must agree. `chosen`, `skipped_reason` and `skipped_by` stay as before: excused by
  any near pair of `lb` in the trial's timeframe (`chosen` is a `STOP 8.5`).
- (C4b; the lead's E10, E11) **Tests.** The C4a review's harnesses and your C4a `t_c4a.py` become tests with the
  results E10 gives; give every expectation that changes a one-line reason. All are Python harnesses on small
  stage1/stage2 files, or `--compare` on small run folders; no TS. Paths are under
  `/tmp/claude-0/-home-user-fx-canvas-mind/293f73fc-e90f-5bbc-b9e3-ce7f929d8068/scratchpad/lawsearch/trial/`
  (`trial/` below). The results the docs writer reads from E10 (not run):
  - `trial/c4a/review/t_rev.py`:
    - R1, R1b: `DIFF`, exit 5 (py's `label` does not follow py's verdict 5);
    - R1c: `DIFF`, exit 5 (py's `label` names C6 while py's list is `C3`; also ts's verdict 3 does not follow ts's
      `delta_ub` −1e−12, which the band counts as below 0: |−1e−12| is not < 1e−12);
    - R2: `DIFF`, exit 5 (py's verdict 4 and its label do not follow py's `holm_delta_pass` 0);
    - R3: exit 6 (py's `failed` `C2・C4` and its label do not follow py's C2 1: `DIFF`; the verdicts 1 and 3 follow
      their own inputs and differ only through C4, excused: verdict `STOP 8.5`);
    - R4: `DIFF`, exit 5 (each side's list does not follow its own C4);
    - R5: exit 6 (py's verdict 4, failed and label do not follow py's C1 1: `DIFF`; `holm_delta_pass` `STOP 8.5`);
    - R6: exit 6, was 5 (both sides follow their own inputs under the band, verdicts 3 and 2; the verdict-2 test
      differs and X's own `delta_ub` is near 0: verdict `STOP 8.5`, label and failed `ALLOWED 8.5`);
    - R6c: `DIFF`, exit 5, was 0 (py's label does not follow; under the band the verdict-2 test is the same on both
      sides).
  - `trial/c4a/refute-1/t_mine.py`: M0 exit 0; M1, M1b, M1n, M2, M2n and M3 `DIFF`, exit 5 (py's written verdict or
    label does not follow py's own inputs). `--compare` on `trial/c4a/refute-1/run` (M3's shape) and on
    `trial/c4a/refute-1/run2` (M2's shape): `RESULT differ`, exit 5 (C4a: 0 and 6).
  - `trial/c4a/refute-2/mine/t_mine.py` and `t_mine2.py`:
    - P1: exit 6 (py's verdict 4, failed and label do not follow py's C1 1: `DIFF`; `holm_delta_pass` `STOP 8.5`);
    - P1c: `DIFF`, exit 5;
    - P2, P2d, P2s: exit 6 (the list that names C2 or C6, or the ts list of P2s, does not follow its side's inputs:
      `DIFF`; verdict `STOP 8.5` through C4);
    - P2c: exit 6 (verdict `STOP 8.5`; label and failed `ALLOWED 8.5`);
    - P3, P3b: exit 6 (C1 and `holm_pass` `STOP 8.5`; py's verdict 5 and label do not follow py's C1 0 with
      `holm_delta_pass` 1, which give verdict 4: `DIFF`). To test the C1 route, set py's `holm_delta_pass` to 0:
      then P3's label and failed are listed under the stop, and P3b's ts list `C3・C6` (C6 1) is a `DIFF`.
  - `trial/c4a/refute-3/r3.py`: A_realsplit exit 6, was 5 (verdict `STOP 8.5`, label and failed `ALLOWED 8.5`);
    B_nosplit_badlabel `DIFF`, exit 5, was 0; B2_nosplit_badverdict `DIFF`, exit 5, was 6 (py's verdict 2 does not
    follow py's `delta_ub` +4e−13); C_control exit 6 (unchanged).
  - Your `trial/c4a/py/t_c4a.py`: the cases whose fixture does not follow its own inputs now give `DIFF` lines of
    class `derived`: E1-r1, E1-r6, E1-n1, E1-n7 and E1-n9 (py's verdict 5 with py's C1 0 and the base fixture's
    `holm_delta_pass` 1, which give verdict 4) and E1-n3 (py's list names C6 while py's C6 is 1, so its label is a
    `DIFF` too, not `ALLOWED`). Fix each such fixture so that it tests its route, and keep the inconsistent version
    as a case that must give `DIFF`.
    E1-n1 (X's C1 splits only through a near pair of `p_iut`), with a fixture whose sides follow their own inputs:
    X's verdict is a `STOP 8.5` and its label and failed are listed under the stop (C4a: three `DIFF` lines); exit 6
    either way. The E2 and E6 cases keep their results.
  - New, required (E11): X's `delta_ub` −5e−13 against −3e−12 with verdicts 3 and 2 → verdict `STOP 8.5`, exit 6;
    −5e−13 against +5e−13 with verdict 3 on both sides and a wrong py label → `DIFF`, exit 5; −1e−12 exactly is
    below 0. New, required (E10): identical ts/ and py/ whose X has verdict 5 with `holm_delta_pass` 1 and `C1` 0 on
    both sides → `DIFF` of class `derived` naming both sides, exit 5 (the docs writer's reading of step 1, above); a
    side whose `C4` is `2` → its derived keys `DIFF` (the same reading).
  - The earlier tests keep their results, or are updated with a one-line reason each:
    `trial/c3/refute-1/t_refute1.py` (f1, l1, v1, v1b, v2, t1 and d1 `DIFF`, exit 5; c0 exit 0; g1 exit 6), the real
    `--compare` on `trial/c3/refute-1/run` (`RESULT differ`, exit 5), `trial/c3/review/d2/t_d2_review.py` R-a … R-f,
    the four `t_decisions.py` cases that C4a changed to `DIFF` (each stays a `DIFF`: nothing that X's derived keys
    rest on differs, so one side's key does not follow its own inputs), the E2 case, t_candidates, t_checks,
    t_refute_c3, t_c3_run, and the C2 review and refute scripts named above. A case in which X's C1 or
    `holm_delta_pass` splits through a near or tied pair of p and both sides follow their own inputs changes as E1-n1
    does. Any earlier case whose made-up row writes a `verdict`, `failed` or `label` that does not follow that row's
    own inputs now also gives a `DIFF` of class `derived`: fix the row (so the case still tests what it was written
    for) or update the expectation, with a one-line reason either way.
  - C4a's test list (the refuter's cases of `trial/c3/refute-1`, the reviewer's R-a … R-f, the E2 case, the four
    changed `t_decisions.py` cases) is folded into the bullet above.
- (C4a, 2026-11-05; the lead's E6) **The line `stage 2 not opened`.** When `ts/checks.csv` (columns
  `trial,name,passed,detail,stage`) has a row of stage `gate`, `stage0`, `stage1` or `stage1end` whose `passed` is
  not 1 (the condition of 5.6 that keeps stage 2 closed), write one line into `cmp/report.txt`, after the
  `ALLOWED`, `STOP 8.5` and `STOP 13` lines and just before `RESULT`:
  `stage 2 not opened: failed TS checks before stage 2: <name> <trial> <stage>; <name> <trial> <stage>; …`
  - Every such row, in the file's row order, joined by `; ` (the form is the docs writer's, C4a; confirmed by the
    lead 2026-11-05, C4b, E12).
  - `--run` and `--compare` both write it (both read `ts/checks.csv`). Keep your log line too.
  - It is not a difference and not a stop: `RESULT` and the exit stay the comparison's.
  - No line when stage 2 stays closed with no such row (`K_total` 0 with every check passed) (the docs writer's
    reading in C4a; confirmed by the lead 2026-11-05, C4b, E12). A stage-1 blind-row hit gets it, because the TS's
    failed `suspect.blind.stage1` row is of stage `stage1`.
  - Unit test: identical ts/ and py/ with one failed `stage0` row in `ts/checks.csv` → the line is the one just
    before `RESULT agree`, exit 0; every row passing → no line; only a failed `stage2` or `end` row → no line; with
    a `STOP 13` line too, the order is `STOP 13`, then this line, then `RESULT`.
  - Why: on O 6001–6004, report.txt ended `RESULT agree` with 72 files instead of 78–80, and only the log said that
    stage 2 was not opened (the C3 Python comparer's question).
- (C3) `STOP 13 <stage> <id>: …` lines (5.6, lawsearch-dump.md 11.14 (c)) are not 9.3 stops: they go before `RESULT`
  and do not change it.
- (C3) `ts/cut_fail.csv` is a new TS-only file (lawsearch-dump.md 8): it is not compared, and py/ has no copy of it,
  like `checks.csv`, `choice.json`, `print.txt` and `config.json`.
- (C3) "Within 1e−9" in 9.3 is absolute, also for two p and for p against a Holm or BH threshold (settled by the lead
  2026-11-05; 9).

## 6. Planted errors (`--plant NAME`, hand examples only)

Each must make at least one of the named examples fail (and may make others fail):

| plant | owner | must fail |
|---|---|---|
| midHalfEven, midDecimalStr | PY1 | A.1.7 |
| pointsTrunc | PY1 | A.1.8 |
| daySatSplit | PY1 | A.1.9 |
| splitShift | PY1 | A.1.2 |
| entryAtSignalClose, entryEarly | PY1 | A.1.26 |
| exitLate | PY1 | A.1.26 or A.1.31 |
| noSubstituteExit | PY1 | A.1.27 or A.1.29 |
| blindNoHour, noBlind | PY1 | A.2.1 |
| inflStratumMean, shiftNoWrap | PY1 | A.2.4 |
| noHolm, iutOneLeg | PY1 | A.2.22 |
| c4PointOnly | PY1 | A.2.23 |
| noEx1Week | PY1 | A.2.20 or A.2.23 |
| noDF | PY1 | A.2.20 |
| htfOpen | PY2 (used by PY1's A.1.12, A.1.13) | A.1.12 or A.1.13 |
| smaNewestFirst | PY2 | A.3.2 or A.3.31 |
| noRisingEdge | PY2 | A.4.1, A.4.32, A.4.33 or A.4.34 |

## 7. Hand examples the trial requires

- "all" means every expect key except alternative answers and notes, at any depth of the expect object: a key
  containing `MISREADING` or `misreading`, starting with `variant_`, ending in `_note`, or named `note` or
  `tolerance_rel`. Alternative answers are compared only under a plant, for information.
- Everything else is compared, nested values included. Some keys need these functions:
  - A.2.2's `stop_case`: the run must stop with no_blind 1.
  - A.2.12's `T_double`: T(x, ν) = 1 − U(x, ν) for x ≥ 0, U(−x, ν) for x < 0.
  - A.2.19: g = (mean used se ÷ (50 ÷ √n1))²; the PL estimate se = sd × √(g ÷ n2), and its Holm top t(1 − 0.025÷6,
    df) × se; the stage 3 count n2 × 52 ÷ 76.
  - A.2.21's `kappa_arith`: κ = the two-pass sd of the runs' values (runs with a value) ÷ the mean of the used se
    (runs with a t); κ used = max(1, κ).
  - A.2.31: r_used, r_cl, their medians (21.5), L = 1 + z(1 − 0.01 ÷ M) ÷ √(2 × 99) with the normal quantile
    (`statistics.NormalDist().inv_cdf`), and the gate.
- A key not listed reports "skip". A required key that cannot be computed is a failure.
- Doubles are compared exactly unless spec 17.2 or the example's own note gives another rule (t quantiles 1e−9,
  ln-based relative 1e−9). A JSON null equals nan.

| examples | owner | required |
|---|---|---|
| A.1.1 … A.1.36 | PY1 | all |
| A.2.1 … A.2.32 | PY1 | all |
| A.3.1, A.3.5, A.3.29 | PY2 | all |
| A.3.2, A.3.31 | PY2 | `first_index_shown`, `SMA20` |
| A.3.6, A.3.34 | PY2 | `TR`, `ATR14` |
| A.3.7 | PY2 | `up`, `dn`, `U`, `D`, `RSI7` |
| A.3.8 | PY2 | `RSI7`, `RSI14`, `RSI21`, `signals.E04` |
| A.3.9 | PY2 | `up`, `dn`, `U14`, `D14`, `RSI14`, `RSI7`, `U14_eq_D14` |
| A.3.14 | PY2 | `EMA12`, `EMA26`, `EMA5`, `EMA35` |
| A.3.15, A.3.16, A.3.17 | PY2 | `first_index_shown` (where present), `EMA12`, `EMA26` |
| A.3.18 | PY2 | `EMA5`, `EMA20`, `EMA50` |
| A.3.19 | PY2 | the `E` row that names E04 (RSI14), the `F` rows of F00 and F01 |
| A.3.20 | PY2 | `EMA5`, `C_minus_EMA`, `F01_buy`, `F01_sell`, `warmup_k`, `F_value_used_signal_excluded_by_warmup_1_at` |
| A.3.24 | PY2 | `TR`, `ATR14`, `SMA5_ATR14` |
| A.3.25 | PY2 | `RSI14` |
| A.3.30 | PY2 | `first_index_shown`, `EMA50`, `EMA200`, `C_minus_EMA200`, `ATR14`, `SMA100_ATR14`, and `first_value_index`'s EMA50, EMA200, SMA100_ATR14 |
| A.4.1, A.4.26, A.4.27, A.4.41 | PY2 | all |
| A.4.2 | PY2 | `HH`, `LL`, `target_s` |
| A.4.3 | PY2 | `TR`, `ATR10`, `EMA20` |
| A.4.9 | PY2 | `TR`, `ATR14` |
| A.4.10 | PY2 | `TR15`, `ATR14_14` |
| A.4.29, A.4.30 | PY2 | `U`, `D`, `RSI14` |
| A.4.32, A.4.33, A.4.34, A.4.36, A.4.40 | PY2 | all |

- 103 examples have required keys. The other 41 report "skip".
- The examples' bars are given as mid strings with a `start` (bars every step from it) or with explicit starts `s`.
  Index 0 is the first bar written. See `lawsearch-hand.md` "読み方の約束" of each group.
- Group 1's A.1.12 and A.1.13 use PY1's higher bars and PY2's `htf_index`.

## 8. Things that differ between Python and JavaScript, and must not differ here

- `bool` is an `int` in Python. Check `isinstance(v, bool)` before any number test (spec 2).
- `round()` rounds half to even, but spec 2 says Python's points use `round` (an exact half never occurs for a
  d-decimal value × 10^d). The mid is rounded with Decimal, never with `round`.
- `float()` accepts underscores, `inf`, `nan` and non-ASCII digits. Use the value-form regexes first (5.1).
- `json` accepts `NaN` and `Infinity` unless parse_constant rejects them.
- Integer JSON numbers are Python ints. A JSON number is still the wrong form for every field, so it is a stop when
  finite (5.1).
- `math.log` is not correctly rounded (neither is JS's), so B06's r, σ and z are compared to relative 1e−9 and their
  ±2 decisions may differ only at z-border bars.
- Sorting must be stable (Python's sort is).

## 9. Readings settled by the lead (C3, 2026-11-05)

These answer the Python builders' questions of round C2. None changes a number of the trial.

- **9.3's 1e−9 is absolute** for every decision it names, p included (two p, p against a Holm or BH threshold, the
  two candidates' p of 8.5), as lawsearch-dump.md 11.12 reads it. The relative p class of lawsearch-dump.md 9 is for
  comparing one p with the other implementation's, not for 9.3's near pairs.
- **κ's run counts** (spec 21.5, 23.5: "t の無い run" and "値の無い run"): settled when stage 3 is built. Keep A.2.21's
  present reading (runs without t = all runs minus the runs that made an SE); in A.2.21 both readings give the same
  count.
- **Spec 23.5's stop rows**: a row with a stop value counts as 数にできない行 (5.1), and the Python keeps it out of
  every other count (dropped, same start, Ask < Bid share), as 5.1 says. The TS may still count it there. Left as
  is: a stop withholds the load dumps, so the two cannot meet in a compared file.
- **What a stop leaves in the files** (stage 2 not opened after a failed TS check; `cut.chosen.second` failed; a
  blind row hit): 5.6 and lawsearch-dump.md 11.14.
- **`cut_max`**: 2 and lawsearch-dump.md 2.

### 9.1 Decided or confirmed by the lead (C4a, 2026-11-05)

From C3's review (findings 1, 4, 5) and the C3 builders' and docs writer's questions. The Python's part:

- **E1** (a code change): `failed`, `label` and `verdict` are excused only through X's own decisions that actually
  differ (5.7). The tests named in 5.7 must give `DIFF`.
- **E2** (a code change): `stage1.csv` `rank` only for the two trials of the near `lb` pair (5.7).
- **E6** (a code change): the report line `stage 2 not opened: …` (5.7).
- **Confirmed readings, kept as written**: the per-trial `floor` … `mark` of stage0.csv (5.6); `label` and
  `verdict` through X's own `holm_delta_pass` (5.7); a near split of one trial's `holm_pass` is a `STOP 8.5` and the
  later trials show as `DIFF` under it (5.7); the refusal of a missing `cut_max` key (2); the stricter stop before
  stage 2 (5.6); the `STOP 13` line and the exit order 6, 5, 3, 0 (2, 5.6). D9 unchanged (5.6).
- **E4**: the per-timeframe `all.*.<tf>` sums stay; a run with one trial in a timeframe is for development only
  (5.6).
- **E5**: the sealed files (0; lawsearch-dump.md 12). No code change.
- **E9**: `checks.csv` carries no cap marker; you refuse capped runs (2). No code change.

### 9.2 Decided or confirmed by the lead (C4b, 2026-11-05)

From C4a's review (findings 1–3) and the C4a docs writer's questions. The Python's part:

- **E10** (a code change; replaces E1 for `failed`, `label` and `verdict`): derived keys by consistency. Each side's
  keys of X are recomputed from that side's own inputs with your own 5.6 code (a key that does not follow is a
  `DIFF` of class `derived`); when both sides follow, the differing inputs are judged by their own rules (5.7). The
  tests named in 5.7 change as listed there.
- **E11** (a code change): every sign or zero test of the comparator uses spec 8.5's zero band (`lt0`, `gt0`, `le0`;
  5.7). C4a's `_below0` used a plain `< 0`.
- **E12** (no code change):
  - On synthetic runs a `DIFF` is a program error to fix. On real data, a TS–Python difference found before stage
    0's numbers are seen is handled as spec 17.2 says: the trial is dropped, its name and reason written, the owner
    told (lawsearch-dump.md 12).
  - Under a `STOP 8.5`, the `DIFF` lines that follow from the stopped split are consequences, not program errors
    (5.7).
  - report.txt's `FILE` lines (row counts, the sealed files' included) and its `ALLOWED` and `DIFF` lines may be seen
    before stage 2: they carry counts and keys, no trade results (the lead's reading of spec 9's purpose). Nothing
    in your report changes.
  - Confirmed: the form of the line `stage 2 not opened: …` and that a run with `K_total` 0 and every check passed
    gets no such line (5.7); the per-timeframe `all.*.<tf>` sums of E4 read against spec 9 (5.6).
- **E14** (a code change): `--compare` refuses a capped `ts/` as `--run` does, with the same message (2).
- E13 is the TS's (its CI and its flip tool); nothing changes in the Python for it.
