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
  - 3: a spec 2 or 15 check failed, or a STOP;
  - 4: a required hand example failed;
  - 5: a TS–Python difference not allowed;
  - 6: a stop of spec 8.5 (lawsearch-dump.md 9.3).
- Before reading any data file, PY1 checks the sha256 of the five rules files against these values, and stops (exit 3)
  on any difference:

  | file | sha256 |
  |---|---|
  | `research/lawsearch-spec.md` | `df93c55b64d50235a603aede78f96da89f75d15dfe9aef6d8cd33157c6f1e221` |
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
- **Stage 2** loads [S0, END). The second-half tables, for the chosen trials only.
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
