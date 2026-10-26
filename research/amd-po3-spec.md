# AMD Po3 port — shared spec (I/O + Pine runtime semantics)

#385 (docs §8.128). Source of truth for the LOGIC: the published Pine code of
TradingView script hkKioUnL, "AMD Po3 with Live Edge Stats [WillyAlgoTrader]"
(Pine v6, v2.4.0, 1,326 lines; read with .github/workflows/pine-source.yml, not
kept in this repository), called `amd-po3.pine` below.
This file only fixes (a) the input/output format, so two independent ports can be diffed
exactly, and (b) the Pine RUNTIME semantics that cannot be read from the script itself.

## Scope

- Default inputs only (every `input.*` at its default). So: boundary mode "pivot", HTF bias OFF,
  killzones OFF, liquidity filter OFF, depth cap 100 (= off, `capPx`/`depthCapPx` are na,
  `trThr` is never needed), re-arm allowed (inert while HTF is off), history style "outline",
  show last 3 cycles, stats period "All-Time", min sample 10, all show* switches ON,
  alerts are not emitted as text (we emit structured events instead, see below).
- Theme: given by the input (`"dark"` or `"light"`) instead of chart luminance.
- Period stats (24H / 30D buffer `cycTimes`) are NOT needed (All-Time only).

## Input JSON

```json
{ "mintick": 0.001, "theme": "dark", "tf": "15", "confirmed": 5000,
  "bars": [[t, o, h, l, c], ...] }
```

- `t` = bar open time (ms, UTC). Not used by the logic under defaults.
- `bars[i]` is bar_index i. Bars `0 .. confirmed-1` are confirmed (`barstate.isconfirmed`).
  `confirmed` is either `len(bars)` or `len(bars) - 1` (the last bar is still forming).
- On an UNCONFIRMED bar only the top-level series, the pivot registry, section 11
  (extension of active objects) and the dashboard run; both `if barstate.isconfirmed`
  blocks are skipped.
- `barstate.islast` = the last bar (index len-1). The dashboard is built once, after the
  last bar is processed.
- `tf` = `timeframe.period` string ("1", "5", "15", "30", "60", "240", "D", "W", "M").
  Chart type is standard (`nonStdChart` = false).
- `syminfo.mintick` = `mintick` (given as `1 / 10**d`: 0.001, 0.00001 or 0.01).

## Pine runtime semantics (fixed here; taken from PyneCore, which measured TradingView)

1. **Tolerant float comparisons.** Every comparison operator WRITTEN IN THE SCRIPT on floats
   (`<`, `<=`, `>`, `>=`, `==`, `!=`) uses an absolute tolerance EPS = 1e-10:
   `a > b` ⇔ `a - b > EPS`; `a < b` ⇔ `b - a > EPS`; `a >= b` ⇔ `a - b >= -EPS`;
   `a <= b` ⇔ `a - b <= EPS`; `a == b` ⇔ `|a - b| <= EPS`; `!=` is its negation.
   Integer comparisons (bar indices, counters, cycle ids) are exact.
   Builtins `math.max`, `math.min`, `ta.highest`, `ta.lowest`, `ta.pivothigh`, `ta.pivotlow`
   are bit-exact (no tolerance).
2. `ta.tr(true)`: bar 0 → `high - low`; otherwise
   `max(max(high - low, abs(high - close[1])), abs(low - close[1]))`.
3. `ta.atr(14)` = `rma(tr(true), 14)`: na on bars 0..12; on bar 13 = (tr[0] + tr[1] + … + tr[13],
   summed left to right starting from 0.0) / 14; afterwards `(prev * 13 + tr) / 14`
   (exactly this expression and order). `atr14 = max(nz(atr, tr(true)), mintick)`.
4. `ta.highest(high, 20)` / `ta.lowest(low, 20)`: na on bars 0..18; plain max/min of the last
   20 values including the current bar.
5. `ta.percentrank(chW, 200)`: na if `bar_index < 200` or the current `chW` is na. Otherwise
   `count * 100 / 200` where count = number of j in 1..200 with `chW[j]` not na and
   `chW[j] - chW <= 1e-10` (tolerant ≤). Compute as `(count * 100) / 200`.
6. `ta.pivothigh(high, 3, 3)` at bar i (na if i < 6): candidate `h = high[i-3]`; it is a pivot
   iff `h > high[i-2]`, `h > high[i-1]`, `h > high[i]` (strict) AND `h >= high[i-4]`,
   `h >= high[i-5]`, `h >= high[i-6]` (bit-exact; the newest of equal maxima wins).
   Returns h, else na. `ta.pivotlow(low, 3, 3)` mirrors it: `low[i-3] < low[i-2..i]` strictly
   and `<= low[i-4..i-6]`.
7. `math.round(x)` = sign(x) · floor(|x| + 0.5) (half away from zero). `math.ceil` /
   `math.floor` are the usual ones. `f_tickRound(p) = math.round(p / mintick) * mintick`,
   `f_tickOut(p, up) = (up ? ceil(p / mintick) : floor(p / mintick)) * mintick`
   (evaluate exactly in this order: one division, then the rounding, then one multiplication).
8. `str.tostring(v, "#.##")`, `"#.#"`, `"#"`: take the shortest round-trip decimal digits of
   |v| (Python `repr` / JS `String`); if that spelling is exponential (|v| < 1e-4 in Python)
   the result is "0"; otherwise round HALF-UP on those digits at the mask's number of decimals
   (2, 1 or 0); drop trailing zeros and then a trailing "."; prefix "-" for v < 0 unless the
   rounded result has no non-zero digit (then it is unsigned, e.g. "0").
   Examples: 0.5→"0.5", 1.0→"1", 2.675→"2.68", -0.004→"0", -1.236→"-1.24", 12.5 with "#"→"13".
9. `str.tostring(v, format.mintick)`: n = |v| / mintick; count = floor(n), plus 1 if
   `n - floor(n) >= 0.5`; print count as fixed point with d fraction digits, d = decimals of
   mintick (count 150123, d 3 → "150.123"; trailing zeros kept: count 150120 → "150.120");
   prefix "-" if v < 0 and count > 0. `fmtPrice(na)` = "—".
10. `str.tostring(int)` = plain integer digits.

## Colors

Output a color as `["#RRGGBB", transp]` (hex UPPERCASE, transp 0..100). `color.new(c, t)`
keeps the RGB and replaces the transparency. A plain hex literal has transp 0.
`color.gray` = #787B86, `color.white` = #FFFFFF, `color.black` = #000000,
`color.rgb(17, 24, 39)` = #111827. `f_textOn` uses only R, G, B (ignores transparency).
`na` color → `null`.

## Output JSON

```json
{
  "events": [ {"bar": i, "cycle": cycleId, "type": "...", ...} ],
  "boxes":  [ {"cycle": c, "left": i, "top": y, "right": i, "bottom": y,
               "border": color, "borderStyle": "solid|dashed|dotted", "borderWidth": 1,
               "bg": color|null} ],
  "lines":  [ {"cycle": c, "x1": i, "y1": y, "x2": i, "y2": y, "color": color,
               "style": "solid|dashed|dotted", "width": w} ],
  "labels": [ {"cycle": c, "x": i, "y": y, "text": "...", "style": "label_up|label_down|label_left",
               "color": color, "textColor": color, "tooltip": "..."|null} ],
  "stats":  {"tgtN":0,"stopN":0,"timeoutN":0,"ambigN":0,"failN":0,"brkN":0,"expN":0,"newsN":0,
             "earlyN":0,"filtN":0,"sumR":0.0,"dsN":0,"dsSumR":0.0,"formStr":""},
  "final":  {"state": "idle|accum|sweepPending|dist", "cycleId": n, "lastEndBar": n,
             "rangeHigh": y|null, "rangeLow": y|null},
  "dash":   [ {"l": "...", "r": "..."|null, "lc": color, "rc": color|null, "bg": color} ]
}
```

- `boxes` / `lines` / `labels`: the objects that still exist after the last bar (not deleted
  by `f_trim`), in creation order, with their FINAL properties. `cycle` = the cycleId they were
  registered with. x values are bar indices (may exceed the last index: lines/labels project
  forward). Font sizes are not output.
- `events` (in execution order; every event has `bar` and `cycle` = cycleId at that moment):
  - `"ACCUM"` (T1 accepted): `start` (rangeStartBar), `high`, `low`, `tol` (tolPx),
    `atrAnchor`, `winLast`.
  - `"EXPIRED"`, `"NEWS"` (news bar in ACCUM), `"EARLY"` (breach before min maturity),
    `"FILTERED"` (filtered breach with close outside): no extra fields.
  - `"RANGE_HIGH"` / `"RANGE_LOW"` (pivot-mode boundary expansion in ACCUM): `value`.
  - `"SWEEP"` (→ SWEEP_PENDING): `side` (1 / -1), `extreme`.
  - `"TWO_SIDE"`, `"TOO_DEEP"`, `"BREAKOUT"`: no extra fields.
  - `"MANIP"` (manipulation confirmed, incl. the same-bar path): `extremeBar`, `extreme`.
  - `"FAILED"` (reward check failed, "M ✗"): no extra fields.
  - `"DIST"` (reference trade opened): `dir`, `entry`, `stop`, `target`, `riskR`.
  - `"OUTCOME"`: `kind` ("target" | "stop" | "ambiguous" | "timeout"), `rr`.
- `dash`: the dashboard rows top to bottom as built on the last bar. `l`/`lc` = column 0 text /
  text color; `r`/`rc` = column 1 (null for a merged row); `bg` = the row's cell-0 bgcolor, or
  TABLE_BG when the cell sets none (table default).
- Numbers are written with full precision (Python `json.dumps` / JS `JSON.stringify`), so the
  two outputs can be compared for exact equality.
