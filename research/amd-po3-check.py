#!/usr/bin/env python3
"""Independent Python 3 (stdlib only) port of
"AMD Po3 with Live Edge Stats [WillyAlgoTrader]" v2.4.0 (Pine v6, amd-po3.pine).

#385 (docs §8.128): written from the Pine source and research/amd-po3-spec.md
only, without reading this app's port (supabase/functions/_shared/amd-po3.ts),
so the two can be compared value for value (research/amd-po3-compare.py).

Usage: python3 research/amd-po3-check.py IN.json OUT.json

Default inputs only (see SPEC.md "Scope", research/amd-po3-spec.md). Pine
runtime semantics follow SPEC.md.
Comments of the form "L123" point to the line of amd-po3.pine being ported.
"""
import json
import math
import sys
from decimal import Decimal, ROUND_HALF_UP

# ─────────────────────────────────────────────────────────────
# Pine runtime helpers (SPEC.md "Pine runtime semantics")
# ─────────────────────────────────────────────────────────────
EPS = 1e-10


def na(x):
    return x is None


def nz(x, y=0.0):
    return y if x is None else x


# Tolerant float comparisons (SPEC 1). A comparison with na is false (Pine).
def f_gt(a, b):
    if a is None or b is None:
        return False
    return a - b > EPS


def f_lt(a, b):
    if a is None or b is None:
        return False
    return b - a > EPS


def f_ge(a, b):
    if a is None or b is None:
        return False
    return a - b >= -EPS


def f_le(a, b):
    if a is None or b is None:
        return False
    return a - b <= EPS


def f_eq(a, b):
    if a is None or b is None:
        return False
    return abs(a - b) <= EPS


def f_ne(a, b):
    if a is None or b is None:
        return False
    return not f_eq(a, b)


def pine_round(x):
    # SPEC 7: sign(x) * floor(|x| + 0.5)
    if x > 0:
        return math.floor(abs(x) + 0.5)
    if x < 0:
        return -math.floor(abs(x) + 0.5)
    return 0


def fmt_mask(v, k):
    """str.tostring(v, "#.##" / "#.#" / "#") -- SPEC 8. k = number of decimals."""
    if v is None:
        return "NaN"
    s = repr(abs(v))
    if "e" in s or "E" in s or s in ("inf", "nan"):
        return "0"
    q = Decimal(s).quantize(Decimal(1).scaleb(-k), rounding=ROUND_HALF_UP)
    t = format(q, "f")
    if "." in t:
        t = t.rstrip("0").rstrip(".")
    if v < 0 and q != 0:
        t = "-" + t
    return t


# ─────────────────────────────────────────────────────────────
# Colors: ("#RRGGBB", transp); na color = None
# ─────────────────────────────────────────────────────────────
def hexc(h, t=0):
    return (h.upper(), t)


def color_new(c, t):
    return (c[0], t)


def color_rgb_tuple(c):
    h = c[0]
    return int(h[1:3], 16), int(h[3:5], 16), int(h[5:7], 16)


COLOR_GRAY = hexc("#787B86")
COLOR_WHITE = hexc("#FFFFFF")
COLOR_BLACK = hexc("#000000")


def cjson(c):
    return None if c is None else [c[0], c[1]]


# ─────────────────────────────────────────────────────────────
# Graphics objects
# ─────────────────────────────────────────────────────────────
class Box:
    __slots__ = ("cycle", "left", "top", "right", "bottom", "border", "borderStyle",
                 "borderWidth", "bg", "deleted")

    def __init__(self, left, top, right, bottom, border, borderStyle, borderWidth, bg):
        self.cycle = None
        self.left, self.top, self.right, self.bottom = left, top, right, bottom
        self.border, self.borderStyle, self.borderWidth, self.bg = border, borderStyle, borderWidth, bg
        self.deleted = False

    def js(self):
        return {"cycle": self.cycle, "left": self.left, "top": self.top, "right": self.right,
                "bottom": self.bottom, "border": cjson(self.border), "borderStyle": self.borderStyle,
                "borderWidth": self.borderWidth, "bg": cjson(self.bg)}


class Line:
    __slots__ = ("cycle", "x1", "y1", "x2", "y2", "color", "style", "width", "deleted")

    def __init__(self, x1, y1, x2, y2, color, style, width):
        self.cycle = None
        self.x1, self.y1, self.x2, self.y2 = x1, y1, x2, y2
        self.color, self.style, self.width = color, style, width
        self.deleted = False

    def js(self):
        return {"cycle": self.cycle, "x1": self.x1, "y1": self.y1, "x2": self.x2, "y2": self.y2,
                "color": cjson(self.color), "style": self.style, "width": self.width}


class Label:
    __slots__ = ("cycle", "x", "y", "text", "style", "color", "textColor", "tooltip", "deleted")

    def __init__(self, x, y, text, style, color, textColor, tooltip=None):
        self.cycle = None
        self.x, self.y, self.text, self.style = x, y, text, style
        self.color, self.textColor, self.tooltip = color, textColor, tooltip
        self.deleted = False

    def js(self):
        return {"cycle": self.cycle, "x": self.x, "y": self.y, "text": self.text, "style": self.style,
                "color": cjson(self.color), "textColor": cjson(self.textColor), "tooltip": self.tooltip}


# Setters: a call on a na or deleted object changes nothing.
def _alive(o):
    return o is not None and not o.deleted


def box_set_right(b, x):
    if _alive(b):
        b.right = x


def box_set_top(b, y):
    if _alive(b):
        b.top = y


def box_set_bottom(b, y):
    if _alive(b):
        b.bottom = y


def box_set_bgcolor(b, c):
    if _alive(b):
        b.bg = c


def box_set_border_color(b, c):
    if _alive(b):
        b.border = c


def box_set_border_style(b, s):
    if _alive(b):
        b.borderStyle = s


def line_set_color(l, c):
    if _alive(l):
        l.color = c


def line_set_style(l, s):
    if _alive(l):
        l.style = s


def line_set_x2(l, x):
    if _alive(l):
        l.x2 = x


def label_set_text(l, t):
    if _alive(l):
        l.text = t


def label_set_color(l, c):
    if _alive(l):
        l.color = c


def label_set_textcolor(l, c):
    if _alive(l):
        l.textColor = c


def label_set_x(l, x):
    if _alive(l):
        l.x = x


# ─────────────────────────────────────────────────────────────
# Inputs at their defaults (L46-L171)
# ─────────────────────────────────────────────────────────────
minRangeBarsInput = 12
maxRangeBarsInput = 96
compressionPctInput = 25
statWindowInput = 200
rangeToleranceInput = 0.10
minRangeWidthPInput = 0.15
boundaryModeInput = "pivot"
trimTailPctInput = 15
sweepReturnBarsInput = 6
requireLiquidityInput = False
sweepDepthPctInput = 100
allowRearmInput = True
distTimeoutBarsInput = 64
stopBufAtrInput = 0.4
fibExtInput = 1.5
showLevelsInput = True
showLevelLabelsInput = True
showPctOnLabelsInput = True
entryLineStyleInput = "Dotted"
stopLineStyleInput = "Solid"
tgtLineStyleInput = "Dashed"
useKillzonesInput = False
useHtfBiasInput = False
showBoxesInput = True
showLabelsInput = True
showLastCyclesInput = 3
minSampleNInput = 10
historyStyleInput = "outline"
showDashInput = True
showMarketSecInput = True
showCycleSecInput = True
showStatsSecInput = True
statsPeriodInput = "All-Time"
alertsOnInput = True

colAccInput = color_new(hexc("#5b7fa6"), 80)
colManInput = color_new(hexc("#e2963a"), 55)
colStopInput = hexc("#c94f4f")
colTgtInput = hexc("#3aa66b")
colDstInput = color_new(hexc("#3aa66b"), 82)

INDICATOR_VERSION = "v2.4.0"
LINE_UPDATE_BARS = 5
LABEL_OFFSET_BARS = 1
FORM_LEN = 10
COOLDOWN_BARS = 10
RANGE_WIN = 20
PIVOT_LR = 3
PIVOT_CAP = 60
EQ_LOOKBACK = 96


def lineStyleFromString(sv):  # L261
    return "dashed" if sv == "Dashed" else "dotted" if sv == "Dotted" else "solid"


entryLineStyle = lineStyleFromString(entryLineStyleInput)
stopLineStyle = lineStyleFromString(stopLineStyleInput)
tgtLineStyle = lineStyleFromString(tgtLineStyleInput)

# Phase enum (L322)
IDLE, ACCUM, SWEEP_PENDING, MANIP, DIST = "idle", "accum", "sweepPending", "manip", "dist"


def run(inp):
    mintick = inp["mintick"]
    theme = inp["theme"]
    tf = inp["tf"]
    nconf = inp["confirmed"]
    bars = inp["bars"]
    nb = len(bars)
    O = [float(b[1]) for b in bars]
    H = [float(b[2]) for b in bars]
    Lw = [float(b[3]) for b in bars]
    C = [float(b[4]) for b in bars]
    mt_dec = int(round(-math.log10(mintick)))

    # ── Theme & colors (L182-L204) ──
    isDark = theme == "dark"
    TEXT_COLOR = hexc("#E0E0E0") if isDark else hexc("#1A1A1A")
    TEXT_MUTED = hexc("#9E9E9E") if isDark else hexc("#757575")
    TABLE_BG = color_new(hexc("#131722"), 5) if isDark else color_new(hexc("#FFFFFF"), 5)
    TABLE_ROW_ALT = color_new(hexc("#1C2030"), 0) if isDark else color_new(hexc("#F0F4F8"), 0)
    HEADER_BG = hexc("#0D47A1") if isDark else hexc("#1565C0")
    HEADER_BG_BULL = color_new(hexc("#0F6E56"), 0)
    HEADER_BG_BEAR = color_new(hexc("#A32D2D"), 0)
    HEADER_TEXT = hexc("#FFFFFF")
    ENTRY_COLOR = color_new(hexc("#5C8AAE"), 0) if isDark else color_new(hexc("#34495E"), 0)
    TGT_HIT_COLOR = color_new(hexc("#4DB6AC"), 0) if isDark else color_new(hexc("#00695C"), 0)
    BULL_TEXT = hexc("#00E676") if isDark else hexc("#00A152")
    BEAR_TEXT = hexc("#FF5252") if isDark else hexc("#D32F2F")
    NEUTRAL_TEXT = hexc("#FFEB3B") if isDark else hexc("#F57F17")

    # ── Functions (L212-L232) ──
    def f_textOn(bg):
        r, g, b = color_rgb_tuple(bg)
        lum = 0.299 * r + 0.587 * g + 0.114 * b
        return hexc("#111827") if f_gt(lum, 145) else COLOR_WHITE

    def fmt_mintick(v):
        # str.tostring(v, format.mintick) -- SPEC 9
        n = abs(v) / mintick
        fl = math.floor(n)
        cnt = fl + (1 if n - fl >= 0.5 else 0)
        s = str(cnt)
        if mt_dec > 0:
            s = s.rjust(mt_dec + 1, "0")
            s = s[:-mt_dec] + "." + s[-mt_dec:]
        if v < 0 and cnt > 0:
            s = "-" + s
        return s

    def fmtPrice(v):
        return "—" if v is None else fmt_mintick(v)

    def f_tickRound(p):
        return pine_round(p / mintick) * mintick

    def f_tickOut(p, roundUp):
        return (math.ceil(p / mintick) if roundUp else math.floor(p / mintick)) * mintick

    def formatPctFromEntry(level, entry):
        res = ""
        if showPctOnLabelsInput and level is not None and entry is not None and f_ne(entry, 0):
            pct = (level - entry) / entry * 100.0
            sign = "+" if f_ge(pct, 0) else ""
            res = " (" + sign + fmt_mask(pct, 2) + "%)"
        return res

    def buildGauge(value, maxVal, width):
        result = ""
        filled = 0 if f_le(maxVal, 0) else pine_round(min(width, max(0.0, value / maxVal * width)))
        for i in range(0, width):
            result += "▰" if i < filled else "▱"
        return result

    # ── Series storage ──
    trA = [None] * nb
    atrA = [None] * nb       # ta.atr(14)
    atr14A = [None] * nb
    chWA = [None] * nb

    # ── Pivot registry (L302-L305) ──
    pivHiV, pivHiB, pivLoV, pivLoB = [], [], [], []

    # ── FSM var state (L329-L386) ──
    v = {}
    v["state"] = IDLE
    v["cycleId"] = 0
    v["lastEndBar"] = -100
    v["rangeHigh"] = None
    v["rangeLow"] = None
    v["rangeMid"] = None
    v["rangeWidth"] = None
    v["tolPx"] = None
    v["rangeStartBar"] = None
    v["expiryAnchor"] = None
    v["rangeAge"] = 0
    v["atrAnchor"] = None
    v["sweepSide"] = 0
    v["firstSweepSide"] = 0
    v["sweepExtreme"] = None
    v["sweepBar"] = None
    v["depthCapPx"] = None
    v["sweepExtremeBar"] = None
    v["rearmUsed"] = False
    v["distDir"] = 0
    v["entryPrice"] = None
    v["stopPrice"] = None
    v["tgtPrice"] = None
    v["riskR"] = None
    v["distStartBar"] = None
    v["distHi"] = None
    v["distLo"] = None
    st = {"tgtN": 0, "stopN": 0, "timeoutN": 0, "ambigN": 0, "failN": 0, "brkN": 0,
          "expN": 0, "newsN": 0, "earlyN": 0, "filtN": 0, "sumR": 0.0, "dsN": 0, "dsSumR": 0.0}
    v["formStr"] = ""
    # alert de-dup flags (no output; kept for completeness)
    v["aSweepH"] = v["aSweepL"] = v["aDist"] = v["aOut"] = False

    # ── Graphics registry (L391-L408) ──
    regBoxes, regBoxCyc = [], []
    regLines, regLinCyc = [], []
    regLabs, regLabCyc = [], []
    allBoxes, allLines, allLabels = [], [], []   # creation order, for output

    def f_regBox(b):
        regBoxes.append(b)
        regBoxCyc.append(v["cycleId"])
        b.cycle = v["cycleId"]

    def f_regLine(l):
        regLines.append(l)
        regLinCyc.append(v["cycleId"])
        l.cycle = v["cycleId"]

    def f_regLab(l):
        regLabs.append(l)
        regLabCyc.append(v["cycleId"])
        l.cycle = v["cycleId"]

    def box_new(*a):
        b = Box(*a)
        allBoxes.append(b)
        return b

    def line_new(*a):
        l = Line(*a)
        allLines.append(l)
        return l

    def label_new(*a, **k):
        l = Label(*a, **k)
        allLabels.append(l)
        return l

    def f_trim():  # L412
        cutoff = v["cycleId"] - showLastCyclesInput
        hardCut = v["cycleId"] - showLastCyclesInput * 3
        i = 0
        while i < len(regBoxes):
            c = regBoxCyc[i]
            if c <= hardCut or (c <= cutoff and historyStyleInput == "hide"):
                regBoxes[i].deleted = True
                del regBoxes[i]
                del regBoxCyc[i]
            else:
                if c <= cutoff:
                    box_set_bgcolor(regBoxes[i], None)
                i += 1
        i = 0
        while i < len(regLines):
            c = regLinCyc[i]
            if c <= hardCut or (c <= cutoff and historyStyleInput == "hide"):
                regLines[i].deleted = True
                del regLines[i]
                del regLinCyc[i]
            else:
                if c <= cutoff:
                    line_set_color(regLines[i], color_new(COLOR_GRAY, 70))
                i += 1
        i = 0
        while i < len(regLabs):
            c = regLabCyc[i]
            if c <= hardCut or (c <= cutoff and historyStyleInput == "hide"):
                regLabs[i].deleted = True
                del regLabs[i]
                del regLabCyc[i]
            else:
                if c <= cutoff:
                    label_set_color(regLabs[i], color_new(COLOR_GRAY, 85))
                    label_set_textcolor(regLabs[i], color_new(COLOR_GRAY, 55))
                i += 1

    def f_liquidityBeyond(side, bar_index):  # L455 (inert under defaults)
        cnt = 0
        tol = 0.10 * v["rangeWidth"]
        minV = None
        maxV = None
        if side == 1 and len(pivHiV) > 0:
            for j in range(0, len(pivHiV)):
                if pivHiB[j] >= bar_index - EQ_LOOKBACK and f_le(abs(pivHiV[j] - v["rangeHigh"]), tol):
                    val = pivHiV[j]
                    cnt += 1
                    minV = val if minV is None else min(minV, val)
                    maxV = val if maxV is None else max(maxV, val)
        if side == -1 and len(pivLoV) > 0:
            for j in range(0, len(pivLoV)):
                if pivLoB[j] >= bar_index - EQ_LOOKBACK and f_le(abs(pivLoV[j] - v["rangeLow"]), tol):
                    val = pivLoV[j]
                    cnt += 1
                    minV = val if minV is None else min(minV, val)
                    maxV = val if maxV is None else max(maxV, val)
        return cnt >= 2 and minV is not None and f_le(maxV - minV, tol)

    # ── Active graphics of the current cycle (L479-L488) ──
    g = {"accBox": None, "swBox": None, "manLab": None, "dstBox": None, "stopLn": None,
         "tgtLn": None, "entLn": None, "entLab": None, "stopLab": None, "tgtLab": None}

    events = []

    def ev(bar, typ, **fields):
        e = {"bar": bar, "cycle": v["cycleId"], "type": typ}
        e.update(fields)
        events.append(e)

    dash = []
    trSum = 0.0

    for bi in range(nb):
        bar_index = bi
        high, low, close, open_ = H[bi], Lw[bi], C[bi], O[bi]
        isconfirmed = bi < nconf
        islast = bi == nb - 1

        # ══════ 6. CALCULATIONS (L282-L290) ══════
        if bi == 0:
            tr = high - low
        else:
            pc = C[bi - 1]
            tr = max(max(high - low, abs(high - pc)), abs(low - pc))
        trA[bi] = tr
        # rma(tr, 14) -- SPEC 3: seed = running sum bar 0..13 from 0.0, / 14
        if bi < 13:
            trSum += tr
            atr = None
        elif bi == 13:
            trSum += tr
            atr = trSum / 14
        else:
            atr = (atrA[bi - 1] * 13 + tr) / 14
        atrA[bi] = atr
        atr14 = max(nz(atr, tr), mintick)
        atr14A[bi] = atr14
        if bi >= RANGE_WIN - 1:
            hi20 = max(H[bi - RANGE_WIN + 1: bi + 1])
            lo20 = min(Lw[bi - RANGE_WIN + 1: bi + 1])
            chW = hi20 - lo20
        else:
            hi20 = lo20 = chW = None
        chWA[bi] = chW
        # ta.percentrank(chW, 200) -- SPEC 5
        if bi < statWindowInput or chW is None:
            pctRank = None
        else:
            cnt = 0
            for j in range(1, statWindowInput + 1):
                cj = chWA[bi - j]
                if cj is not None and cj - chW <= 1e-10:
                    cnt += 1
            pctRank = (cnt * 100) / statWindowInput
        # ta.pivothigh / ta.pivotlow (3, 3) -- SPEC 6 (bit-exact)
        ph = pl = None
        if bi >= 2 * PIVOT_LR:
            hc = H[bi - 3]
            if (hc > H[bi - 2] and hc > H[bi - 1] and hc > H[bi]
                    and hc >= H[bi - 4] and hc >= H[bi - 5] and hc >= H[bi - 6]):
                ph = hc
            lc = Lw[bi - 3]
            if (lc < Lw[bi - 2] and lc < Lw[bi - 1] and lc < Lw[bi]
                    and lc <= Lw[bi - 4] and lc <= Lw[bi - 5] and lc <= Lw[bi - 6]):
                pl = lc
        warmedUp = bar_index >= statWindowInput + RANGE_WIN

        # Pivot registry (L306-L317)
        if ph is not None:
            pivHiV.append(ph)
            pivHiB.append(bar_index - PIVOT_LR)
            if len(pivHiV) > PIVOT_CAP:
                pivHiV.pop(0)
                pivHiB.pop(0)
        if pl is not None:
            pivLoV.append(pl)
            pivLoB.append(bar_index - PIVOT_LR)
            if len(pivLoV) > PIVOT_CAP:
                pivLoV.pop(0)
                pivLoB.pop(0)

        # ══════ 10. pre-FSM series (L493-L496) ══════
        tolBand = nz(v["tolPx"])
        insideRng = (v["rangeHigh"] is not None and f_le(close, v["rangeHigh"])
                     and f_ge(close, v["rangeLow"]))
        breachHigh = v["rangeHigh"] is not None and f_gt(high, v["rangeHigh"] + tolBand)
        breachLow = v["rangeLow"] is not None and f_lt(low, v["rangeLow"] - tolBand)

        if isconfirmed:
            state = v["state"]
            # ══════ T1: IDLE → ACCUMULATION (L501) ══════
            if state == IDLE:
                if (warmedUp and f_gt(close, 0) and f_le(pctRank, compressionPctInput)
                        and f_ge(chW, minRangeWidthPInput / 100 * close)
                        and bar_index - v["lastEndBar"] >= COOLDOWN_BARS):
                    winLast = RANGE_WIN - 1
                    tHi = hi20
                    tLo = lo20
                    if trimTailPctInput > 0:
                        keepTrim = True
                        while keepTrim and winLast > minRangeBarsInput:
                            hi2 = high
                            lo2 = low
                            for i in range(0, winLast):          # for i = 0 to winLast - 1
                                hi2 = max(hi2, H[bi - i])
                                lo2 = min(lo2, Lw[bi - i])
                            if f_gt((tHi - tLo) - (hi2 - lo2), trimTailPctInput / 100.0 * (tHi - tLo)):
                                winLast -= 1
                                tHi = hi2
                                tLo = lo2
                            else:
                                keepTrim = False
                    candStart = bar_index - winLast
                    candHigh = tHi
                    candLow = tLo
                    if boundaryModeInput == "pivot":
                        bestHi = None
                        bestLo = None
                        if len(pivHiV) > 0:
                            for j in range(0, len(pivHiV)):
                                if pivHiB[j] >= candStart:
                                    val = pivHiV[j]
                                    bestHi = val if bestHi is None else max(bestHi, val)
                        if len(pivLoV) > 0:
                            for j in range(0, len(pivLoV)):
                                if pivLoB[j] >= candStart:
                                    val = pivLoV[j]
                                    bestLo = val if bestLo is None else min(bestLo, val)
                        candHigh = candHigh if bestHi is None else bestHi
                        candLow = candLow if bestLo is None else bestLo
                    candW = candHigh - candLow
                    if (f_ge(candW, minRangeWidthPInput / 100 * close) and f_le(close, candHigh)
                            and f_ge(close, candLow)):
                        v["rangeStartBar"] = candStart
                        v["expiryAnchor"] = candStart
                        v["rangeHigh"] = candHigh
                        v["rangeLow"] = candLow
                        v["rangeWidth"] = candW
                        v["tolPx"] = candW * rangeToleranceInput
                        v["rangeMid"] = (candHigh + candLow) / 2
                        v["rangeAge"] = winLast
                        v["atrAnchor"] = atr14A[bi - (winLast + 1)]
                        v["rearmUsed"] = False
                        v["firstSweepSide"] = 0
                        v["cycleId"] += 1
                        f_trim()
                        v["aSweepH"] = v["aSweepL"] = v["aDist"] = v["aOut"] = False
                        g["accBox"] = None
                        if showBoxesInput:
                            g["accBox"] = box_new(v["rangeStartBar"], v["rangeHigh"], bar_index, v["rangeLow"],
                                                  color_new(colAccInput, 0), "dashed", 1, colAccInput)
                            f_regBox(g["accBox"])
                        v["state"] = ACCUM
                        ev(bar_index, "ACCUM", start=v["rangeStartBar"], high=v["rangeHigh"],
                           low=v["rangeLow"], tol=v["tolPx"], atrAnchor=v["atrAnchor"], winLast=winLast)

            # ══════ T2 / T3: ACCUMULATION (L572) ══════
            elif state == ACCUM:
                v["rangeAge"] = bar_index - v["rangeStartBar"]
                if bar_index - v["expiryAnchor"] > maxRangeBarsInput:
                    st["expN"] += 1
                    if g["accBox"] is not None:
                        box_set_right(g["accBox"], bar_index)
                        box_set_border_color(g["accBox"], color_new(COLOR_GRAY, 40))
                    if showLabelsInput:
                        lb = label_new(bar_index, v["rangeMid"], "EXPIRED", "label_left",
                                       color_new(COLOR_GRAY, 70), TEXT_MUTED)
                        f_regLab(lb)
                    v["state"] = IDLE
                    v["lastEndBar"] = bar_index
                    f_trim()
                    ev(bar_index, "EXPIRED")
                elif breachHigh and breachLow:
                    st["newsN"] += 1
                    if g["accBox"] is not None:
                        box_set_right(g["accBox"], bar_index)
                    if showLabelsInput:
                        lb = label_new(bar_index, close, "NEWS BAR", "label_left",
                                       color_new(COLOR_GRAY, 70), TEXT_MUTED)
                        f_regLab(lb)
                    v["state"] = IDLE
                    v["lastEndBar"] = bar_index
                    f_trim()
                    ev(bar_index, "NEWS")
                elif breachHigh or breachLow:
                    side = 1 if breachHigh else -1
                    if v["rangeAge"] < minRangeBarsInput:
                        st["earlyN"] += 1
                        if g["accBox"] is not None:
                            box_set_right(g["accBox"], bar_index)
                        v["state"] = IDLE
                        v["lastEndBar"] = bar_index
                        f_trim()
                        ev(bar_index, "EARLY")
                    else:
                        sameSideBlock = v["rearmUsed"] and side == v["firstSweepSide"]
                        kzOK = (not useKillzonesInput) or False   # inKZ never needed (killzones OFF)
                        capPx = None   # sweepDepthPctInput >= 100 -> na (trThr not needed)
                        excurs = high - v["rangeHigh"] if side == 1 else v["rangeLow"] - low
                        dpOK = capPx is None or f_le(excurs, capPx)
                        liqOK = (not requireLiquidityInput) or f_liquidityBeyond(side, bar_index)
                        if kzOK and dpOK and liqOK and not sameSideBlock:
                            # ══════ T3: → SWEEP_PENDING (L623) ══════
                            if g["accBox"] is not None:
                                box_set_right(g["accBox"], bar_index)
                            v["sweepSide"] = side
                            v["sweepBar"] = bar_index
                            v["sweepExtreme"] = high if side == 1 else low
                            v["sweepExtremeBar"] = bar_index
                            v["depthCapPx"] = capPx
                            if v["firstSweepSide"] == 0:
                                v["firstSweepSide"] = side
                            g["swBox"] = None
                            if showBoxesInput:
                                g["swBox"] = box_new(v["sweepBar"],
                                                     v["sweepExtreme"] if side == 1 else v["rangeLow"],
                                                     bar_index,
                                                     v["rangeHigh"] if side == 1 else v["sweepExtreme"],
                                                     color_new(colManInput, 20), "dashed", 1,
                                                     color_new(colManInput, 75))
                                f_regBox(g["swBox"])
                            if side == 1:
                                v["aSweepH"] = True
                            else:
                                v["aSweepL"] = True
                            v["state"] = SWEEP_PENDING
                            ev(bar_index, "SWEEP", side=side, extreme=v["sweepExtreme"])
                            if insideRng:
                                v["state"] = MANIP
                                if g["swBox"] is not None:
                                    box_set_border_style(g["swBox"], "solid")
                                    box_set_bgcolor(g["swBox"], color_new(colManInput, 55))
                                g["manLab"] = None
                                if showLabelsInput:
                                    g["manLab"] = label_new(v["sweepExtremeBar"], v["sweepExtreme"], "M",
                                                            "label_down" if v["sweepSide"] == 1 else "label_up",
                                                            color_new(colManInput, 20), f_textOn(colManInput))
                                    f_regLab(g["manLab"])
                                ev(bar_index, "MANIP", extremeBar=v["sweepExtremeBar"],
                                   extreme=v["sweepExtreme"])
                        elif not insideRng:
                            st["filtN"] += 1
                            if g["accBox"] is not None:
                                box_set_right(g["accBox"], bar_index)
                            v["state"] = IDLE
                            v["lastEndBar"] = bar_index
                            f_trim()
                            ev(bar_index, "FILTERED")
                else:
                    if boundaryModeInput == "absolute":
                        newHi = min(max(v["rangeHigh"], high), v["rangeHigh"] + tolBand)
                        newLo = max(min(v["rangeLow"], low), v["rangeLow"] - tolBand)
                        if f_ne(newHi, v["rangeHigh"]) or f_ne(newLo, v["rangeLow"]):
                            v["rangeHigh"] = newHi
                            v["rangeLow"] = newLo
                            v["rangeWidth"] = v["rangeHigh"] - v["rangeLow"]
                            v["rangeMid"] = (v["rangeHigh"] + v["rangeLow"]) / 2
                            if g["accBox"] is not None:
                                box_set_top(g["accBox"], v["rangeHigh"])
                                box_set_bottom(g["accBox"], v["rangeLow"])
                    else:
                        if (ph is not None and bar_index - PIVOT_LR >= v["rangeStartBar"]
                                and f_gt(ph, v["rangeHigh"]) and f_le(ph, v["rangeHigh"] + tolBand)):
                            v["rangeHigh"] = ph
                            v["rangeWidth"] = v["rangeHigh"] - v["rangeLow"]
                            v["rangeMid"] = (v["rangeHigh"] + v["rangeLow"]) / 2
                            if g["accBox"] is not None:
                                box_set_top(g["accBox"], v["rangeHigh"])
                            ev(bar_index, "RANGE_HIGH", value=v["rangeHigh"])
                        if (pl is not None and bar_index - PIVOT_LR >= v["rangeStartBar"]
                                and f_lt(pl, v["rangeLow"]) and f_ge(pl, v["rangeLow"] - tolBand)):
                            v["rangeLow"] = pl
                            v["rangeWidth"] = v["rangeHigh"] - v["rangeLow"]
                            v["rangeMid"] = (v["rangeHigh"] + v["rangeLow"]) / 2
                            if g["accBox"] is not None:
                                box_set_bottom(g["accBox"], v["rangeLow"])
                            ev(bar_index, "RANGE_LOW", value=v["rangeLow"])

            # ══════ T4: SWEEP_PENDING (L706) ══════
            elif state == SWEEP_PENDING:
                prevExtreme = v["sweepExtreme"]
                v["sweepExtreme"] = (max(v["sweepExtreme"], high) if v["sweepSide"] == 1
                                     else min(v["sweepExtreme"], low))
                if f_ne(v["sweepExtreme"], prevExtreme):
                    v["sweepExtremeBar"] = bar_index
                if g["swBox"] is not None:
                    if v["sweepSide"] == 1:
                        box_set_top(g["swBox"], v["sweepExtreme"])
                    else:
                        box_set_bottom(g["swBox"], v["sweepExtreme"])
                oppBreach = (f_lt(low, v["rangeLow"] - tolBand) if v["sweepSide"] == 1
                             else f_gt(high, v["rangeHigh"] + tolBand))
                curExc = (v["sweepExtreme"] - v["rangeHigh"] if v["sweepSide"] == 1
                          else v["rangeLow"] - v["sweepExtreme"])
                depthBust = v["depthCapPx"] is not None and f_gt(curExc, v["depthCapPx"])

                if oppBreach:
                    st["newsN"] += 1
                    if g["swBox"] is not None:
                        box_set_right(g["swBox"], bar_index)
                    if showLabelsInput:
                        lb = label_new(bar_index, close, "2-SIDE", "label_left",
                                       color_new(COLOR_GRAY, 70), TEXT_MUTED)
                        f_regLab(lb)
                    v["state"] = IDLE
                    v["lastEndBar"] = bar_index
                    f_trim()
                    ev(bar_index, "TWO_SIDE")
                elif depthBust:
                    st["brkN"] += 1
                    if g["swBox"] is not None:
                        box_set_right(g["swBox"], bar_index)
                    if showLabelsInput:
                        lb = label_new(bar_index, v["sweepExtreme"], "TOO DEEP",
                                       "label_down" if v["sweepSide"] == 1 else "label_up",
                                       color_new(COLOR_GRAY, 30), f_textOn(COLOR_GRAY))
                        f_regLab(lb)
                    v["state"] = IDLE
                    v["lastEndBar"] = bar_index
                    f_trim()
                    ev(bar_index, "TOO_DEEP")
                elif bar_index - v["sweepBar"] > sweepReturnBarsInput:
                    st["brkN"] += 1
                    if g["swBox"] is not None:
                        box_set_right(g["swBox"], bar_index)
                    if showLabelsInput:
                        lb = label_new(bar_index, v["sweepExtreme"], "BREAKOUT",
                                       "label_down" if v["sweepSide"] == 1 else "label_up",
                                       color_new(COLOR_GRAY, 30), f_textOn(COLOR_GRAY))
                        f_regLab(lb)
                    v["state"] = IDLE
                    v["lastEndBar"] = bar_index
                    f_trim()
                    ev(bar_index, "BREAKOUT")
                elif insideRng:
                    v["state"] = MANIP
                    if g["swBox"] is not None:
                        box_set_right(g["swBox"], bar_index)
                        box_set_border_style(g["swBox"], "solid")
                        box_set_bgcolor(g["swBox"], color_new(colManInput, 55))
                    g["manLab"] = None
                    if showLabelsInput:
                        g["manLab"] = label_new(v["sweepExtremeBar"], v["sweepExtreme"], "M",
                                                "label_down" if v["sweepSide"] == 1 else "label_up",
                                                color_new(colManInput, 20), f_textOn(colManInput))
                        f_regLab(g["manLab"])
                    ev(bar_index, "MANIP", extremeBar=v["sweepExtremeBar"], extreme=v["sweepExtreme"])

            # ══════ T7: DISTRIBUTION → outcomes (L788) ══════
            elif state == DIST:
                if bar_index - v["distStartBar"] >= 1:
                    tgtPrice, stopPrice, entryPrice, riskR = v["tgtPrice"], v["stopPrice"], v["entryPrice"], v["riskR"]
                    distDir = v["distDir"]
                    hitT = f_ge(high, tgtPrice) if distDir == 1 else f_le(low, tgtPrice)
                    hitS = f_le(low, stopPrice) if distDir == 1 else f_ge(high, stopPrice)
                    timedOut = bar_index - v["distStartBar"] >= distTimeoutBarsInput
                    if hitT or hitS or timedOut:
                        outcome = ""
                        rr = 0.0
                        if hitT and hitS:
                            st["ambigN"] += 1
                            st["stopN"] += 1
                            rr = -1.0
                            outcome = "AMB ✗"
                            kind = "ambiguous"
                        elif hitT:
                            st["tgtN"] += 1
                            exitT = max(tgtPrice, open_) if distDir == 1 else min(tgtPrice, open_)
                            rr = abs(exitT - entryPrice) / riskR
                            outcome = "✓ +" + fmt_mask(rr, 2) + "R"
                            kind = "target"
                        elif hitS:
                            st["stopN"] += 1
                            exitS = min(stopPrice, open_) if distDir == 1 else max(stopPrice, open_)
                            rr = (exitS - entryPrice) / riskR if distDir == 1 else (entryPrice - exitS) / riskR
                            outcome = "✗ " + fmt_mask(rr, 2) + "R"
                            kind = "stop"
                        else:
                            st["timeoutN"] += 1
                            rr = (close - entryPrice) / riskR if distDir == 1 else (entryPrice - close) / riskR
                            outcome = "◌ " + fmt_mask(rr, 2) + "R"
                            kind = "timeout"
                        if g["dstBox"] is not None:
                            v["distHi"] = max(v["distHi"], high)
                            v["distLo"] = min(v["distLo"], low)
                            box_set_top(g["dstBox"], v["distHi"])
                            box_set_bottom(g["dstBox"], v["distLo"])
                            box_set_right(g["dstBox"], bar_index)
                        st["sumR"] += rr
                        if v["rearmUsed"]:
                            st["dsN"] += 1
                            st["dsSumR"] += rr
                        outcCode = 0 if (hitT and hitS) else 1 if hitT else 0 if hitS else 2
                        # (cycTimes / cycOutc / cycR buffer: period stats not needed, All-Time only)
                        v["formStr"] = v["formStr"] + ("▰" if outcCode == 1 else "▱" if outcCode == 0 else "◌")
                        if len(v["formStr"]) > FORM_LEN:
                            v["formStr"] = v["formStr"][len(v["formStr"]) - FORM_LEN:]
                        if hitT and not hitS:
                            if g["tgtLn"] is not None:
                                line_set_color(g["tgtLn"], TGT_HIT_COLOR)
                                line_set_style(g["tgtLn"], "solid")
                            if g["tgtLab"] is not None:
                                label_set_text(g["tgtLab"], "Target ✓ " + fmtPrice(tgtPrice))
                                label_set_color(g["tgtLab"], TGT_HIT_COLOR)
                                label_set_textcolor(g["tgtLab"], f_textOn(TGT_HIT_COLOR))
                        elif hitS:
                            if g["stopLab"] is not None:
                                label_set_text(g["stopLab"], "Stop ✗ " + fmtPrice(stopPrice))
                        else:
                            if g["tgtLn"] is not None:
                                line_set_color(g["tgtLn"], color_new(COLOR_GRAY, 60))
                            if g["tgtLab"] is not None:
                                label_set_color(g["tgtLab"], color_new(COLOR_GRAY, 70))
                        if showLabelsInput:
                            oBase = (colTgtInput if (hitT and not hitS)
                                     else COLOR_GRAY if (timedOut and not hitS and not hitT) else colStopInput)
                            ol = label_new(bar_index, high if distDir == 1 else low, outcome,
                                           "label_down" if distDir == 1 else "label_up",
                                           color_new(oBase, 20), f_textOn(oBase))
                            f_regLab(ol)
                        v["aOut"] = True
                        v["state"] = IDLE
                        v["lastEndBar"] = bar_index
                        f_trim()
                        ev(bar_index, "OUTCOME", kind=kind, rr=rr)

        if isconfirmed:
            # ══════ T5: MANIPULATION CONFIRMED → DISTRIBUTION OPENS (L887) ══════
            if v["state"] == MANIP:
                dir_ = 1 if v["sweepSide"] == -1 else -1
                htfNa = False          # useHtfBiasInput is OFF
                htfOK = (not useHtfBiasInput) or False
                if htfOK:
                    v["distDir"] = dir_
                    v["entryPrice"] = close
                    rangeHigh, rangeLow, sweepExtreme = v["rangeHigh"], v["rangeLow"], v["sweepExtreme"]
                    fibLeg = rangeHigh - sweepExtreme if dir_ == 1 else sweepExtreme - rangeLow
                    v["tgtPrice"] = f_tickRound(rangeHigh + (fibExtInput - 1.0) * fibLeg if dir_ == 1
                                                else rangeLow - (fibExtInput - 1.0) * fibLeg)
                    stopRaw = (sweepExtreme - stopBufAtrInput * v["atrAnchor"] if dir_ == 1
                               else sweepExtreme + stopBufAtrInput * v["atrAnchor"])
                    v["stopPrice"] = f_tickOut(stopRaw, dir_ == -1)
                    v["riskR"] = max(abs(v["entryPrice"] - v["stopPrice"]), mintick)
                    entryPrice, stopPrice, tgtPrice, riskR = v["entryPrice"], v["stopPrice"], v["tgtPrice"], v["riskR"]
                    rewardOK = (f_ge(tgtPrice - entryPrice, mintick) if dir_ == 1
                                else f_ge(entryPrice - tgtPrice, mintick))
                    if not rewardOK:
                        st["failN"] += 1
                        if g["manLab"] is not None:
                            label_set_text(g["manLab"], "M ✗")
                            label_set_color(g["manLab"], color_new(COLOR_GRAY, 40))
                        v["state"] = IDLE
                        v["lastEndBar"] = bar_index
                        f_trim()
                        ev(bar_index, "FAILED")
                    else:
                        v["distStartBar"] = bar_index
                        v["distHi"] = high
                        v["distLo"] = low
                        g["dstBox"] = None
                        if showBoxesInput:
                            g["dstBox"] = box_new(bar_index, v["distHi"], bar_index, v["distLo"],
                                                  color_new(colTgtInput, 30), "solid", 1, colDstInput)
                            f_regBox(g["dstBox"])
                        entPxStr = fmt_mintick(entryPrice)
                        stpPxStr = fmt_mintick(stopPrice)
                        tgtPxStr = fmt_mintick(tgtPrice)
                        g["entLn"] = g["stopLn"] = g["tgtLn"] = None
                        g["entLab"] = g["stopLab"] = g["tgtLab"] = None
                        dRrStr = fmt_mask(abs(tgtPrice - entryPrice) / riskR, 2)
                        if showLabelsInput:
                            dTip = (("Distribution UP" if dir_ == 1 else "Distribution DOWN")
                                    + "\nSweep: " + ("HIGH" if v["sweepSide"] == 1 else "LOW")
                                    + (" (double sweep)" if v["rearmUsed"] else "")
                                    + "\nEntry: " + entPxStr + " | Stop: " + stpPxStr
                                    + "\nTarget: " + tgtPxStr + " | R:R: " + dRrStr)
                            dLab = label_new(bar_index, low if dir_ == 1 else high, "D ▲" if dir_ == 1 else "D ▼",
                                             "label_up" if dir_ == 1 else "label_down",
                                             color_new(colTgtInput, 20), f_textOn(colTgtInput), tooltip=dTip)
                            f_regLab(dLab)
                        if showLevelsInput:
                            g["entLn"] = line_new(bar_index, entryPrice, bar_index + LINE_UPDATE_BARS, entryPrice,
                                                  ENTRY_COLOR, entryLineStyle, 1)
                            g["stopLn"] = line_new(bar_index, stopPrice, bar_index + LINE_UPDATE_BARS, stopPrice,
                                                   colStopInput, stopLineStyle, 2)
                            g["tgtLn"] = line_new(bar_index, tgtPrice, bar_index + LINE_UPDATE_BARS, tgtPrice,
                                                  colTgtInput, tgtLineStyle, 2)
                            f_regLine(g["entLn"])
                            f_regLine(g["stopLn"])
                            f_regLine(g["tgtLn"])
                            if showLevelLabelsInput:
                                lx = bar_index + LINE_UPDATE_BARS + LABEL_OFFSET_BARS
                                g["entLab"] = label_new(lx, entryPrice, "Entry " + entPxStr, "label_left",
                                                        ENTRY_COLOR, f_textOn(ENTRY_COLOR))
                                g["stopLab"] = label_new(lx, stopPrice,
                                                         "Stop " + stpPxStr + formatPctFromEntry(stopPrice, entryPrice),
                                                         "label_left", colStopInput, f_textOn(colStopInput))
                                g["tgtLab"] = label_new(lx, tgtPrice,
                                                        "Target " + tgtPxStr + formatPctFromEntry(tgtPrice, entryPrice),
                                                        "label_left", colTgtInput, f_textOn(colTgtInput))
                                f_regLab(g["entLab"])
                                f_regLab(g["stopLab"])
                                f_regLab(g["tgtLab"])
                        v["aDist"] = True
                        v["state"] = DIST
                        ev(bar_index, "DIST", dir=dir_, entry=entryPrice, stop=stopPrice,
                           target=tgtPrice, riskR=riskR)
                else:
                    # HTF rejection (inert under defaults: htfOK is always true)
                    if htfNa:
                        if g["manLab"] is not None:
                            label_set_text(g["manLab"], "M · HTF n/a")
                            label_set_color(g["manLab"], color_new(COLOR_GRAY, 40))
                        v["state"] = IDLE
                        v["lastEndBar"] = bar_index
                        f_trim()
                    elif allowRearmInput and not v["rearmUsed"]:
                        v["rearmUsed"] = True
                        v["expiryAnchor"] = bar_index
                        if g["manLab"] is not None:
                            label_set_text(g["manLab"], "M ↻")
                        if g["swBox"] is not None:
                            box_set_bgcolor(g["swBox"], color_new(COLOR_GRAY, 80))
                        v["state"] = ACCUM
                    else:
                        st["failN"] += 1
                        if g["manLab"] is not None:
                            label_set_text(g["manLab"], "M ✗")
                            label_set_color(g["manLab"], color_new(COLOR_GRAY, 40))
                        v["state"] = IDLE
                        v["lastEndBar"] = bar_index
                        f_trim()
                        ev(bar_index, "FAILED")

        # ══════ 11. EXTENSION OF ACTIVE OBJECTS (every bar, L1004) ══════
        if v["state"] == ACCUM:
            if g["accBox"] is not None:
                box_set_right(g["accBox"], bar_index)
        if v["state"] == SWEEP_PENDING:
            if g["swBox"] is not None:
                box_set_right(g["swBox"], bar_index)
        if v["state"] == DIST:
            if g["entLn"] is not None:
                line_set_x2(g["entLn"], bar_index + LINE_UPDATE_BARS)
            if g["stopLn"] is not None:
                line_set_x2(g["stopLn"], bar_index + LINE_UPDATE_BARS)
            if g["tgtLn"] is not None:
                line_set_x2(g["tgtLn"], bar_index + LINE_UPDATE_BARS)
            if g["entLab"] is not None:
                label_set_x(g["entLab"], bar_index + LINE_UPDATE_BARS + LABEL_OFFSET_BARS)
            if g["stopLab"] is not None:
                label_set_x(g["stopLab"], bar_index + LINE_UPDATE_BARS + LABEL_OFFSET_BARS)
            if g["tgtLab"] is not None:
                label_set_x(g["tgtLab"], bar_index + LINE_UPDATE_BARS + LABEL_OFFSET_BARS)
            if g["dstBox"] is not None:
                v["distHi"] = max(v["distHi"], high)
                v["distLo"] = min(v["distLo"], low)
                box_set_top(g["dstBox"], v["distHi"])
                box_set_bottom(g["dstBox"], v["distLo"])
                box_set_right(g["dstBox"], bar_index)

        # ══════ 12. DASHBOARD (last bar, L1069) ══════
        if showDashInput and islast:
            dash = build_dash(v, st, bar_index, close, warmedUp, pctRank, tf,
                              TEXT_COLOR, TEXT_MUTED, TABLE_BG, TABLE_ROW_ALT, HEADER_BG,
                              HEADER_BG_BULL, HEADER_BG_BEAR, HEADER_TEXT, BULL_TEXT, BEAR_TEXT,
                              NEUTRAL_TEXT, fmtPrice, buildGauge)

    out = {
        "events": events,
        "boxes": [b.js() for b in allBoxes if not b.deleted],
        "lines": [l.js() for l in allLines if not l.deleted],
        "labels": [l.js() for l in allLabels if not l.deleted],
        "stats": {"tgtN": st["tgtN"], "stopN": st["stopN"], "timeoutN": st["timeoutN"],
                  "ambigN": st["ambigN"], "failN": st["failN"], "brkN": st["brkN"],
                  "expN": st["expN"], "newsN": st["newsN"], "earlyN": st["earlyN"],
                  "filtN": st["filtN"], "sumR": st["sumR"], "dsN": st["dsN"],
                  "dsSumR": st["dsSumR"], "formStr": v["formStr"]},
        "final": {"state": v["state"], "cycleId": v["cycleId"], "lastEndBar": v["lastEndBar"],
                  "rangeHigh": v["rangeHigh"], "rangeLow": v["rangeLow"]},
        "dash": dash,
    }
    return out


def build_dash(v, st, bar_index, close, warmedUp, pctRank, tf,
               TEXT_COLOR, TEXT_MUTED, TABLE_BG, TABLE_ROW_ALT, HEADER_BG,
               HEADER_BG_BULL, HEADER_BG_BEAR, HEADER_TEXT, BULL_TEXT, BEAR_TEXT,
               NEUTRAL_TEXT, fmtPrice, buildGauge):
    rows = []
    state = v["state"]
    distDir = v["distDir"]

    def merged(text, tc, bg):
        rows.append({"l": text, "r": None, "lc": cjson(tc), "rc": None, "bg": cjson(bg)})

    def pair(l, r, rc, bg):
        rows.append({"l": l, "r": r, "lc": cjson(TEXT_MUTED), "rc": cjson(rc), "bg": cjson(bg)})

    def f_phaseName():
        return {IDLE: "IDLE", ACCUM: "ACCUMULATION", SWEEP_PENDING: "SWEEP?", DIST: "DISTRIBUTION"}.get(state, "?")

    def f_phaseBars():
        if state == ACCUM:
            return bar_index - v["rangeStartBar"]
        if state == SWEEP_PENDING:
            return bar_index - v["sweepBar"]
        if state == DIST:
            return bar_index - v["distStartBar"]
        return 0

    def f_action():
        if state == IDLE:
            return "Scanning for compression" if warmedUp else "Warming up"
        if state == ACCUM:
            if v["rearmUsed"]:
                return "Re-arm: awaiting 2nd-side sweep"
            return "Range maturing" if bar_index - v["rangeStartBar"] < minRangeBarsInput else "Awaiting boundary sweep"
        if state == SWEEP_PENDING:
            return "Sweep! Awaiting return inside"
        if state == DIST:
            return "Distribution ↑ — target live" if distDir == 1 else "Distribution ↓ — target live"
        return "—"

    zeb = False
    # Header
    headerBg = (HEADER_BG_BULL if distDir == 1 else HEADER_BG_BEAR) if state == DIST else HEADER_BG
    headerDir = (" ▲" if distDir == 1 else " ▼") if state == DIST else ""
    merged("◆ Po3 · " + f_phaseName() + headerDir, HEADER_TEXT, headerBg)

    if showMarketSecInput:
        merged("— Market —", TEXT_MUTED, TABLE_ROW_ALT)
        phaseStr = ("Warming up" if not warmedUp else
                    f_phaseName() + (" (" + str(f_phaseBars()) + "b)" if state != IDLE else ""))
        phaseClr = (TEXT_MUTED if not warmedUp else
                    (BULL_TEXT if distDir == 1 else BEAR_TEXT) if state == DIST else
                    TEXT_MUTED if state == IDLE else NEUTRAL_TEXT)
        rb = TABLE_ROW_ALT if zeb else TABLE_BG
        pair("Phase", phaseStr, phaseClr, rb)
        zeb = not zeb

        cmpStr = "—" if not warmedUp else fmt_mask(pctRank, 0) + "p  " + buildGauge(100 - pctRank, 100, 6)
        cmpClr = TEXT_MUTED if not warmedUp else BULL_TEXT if f_le(pctRank, compressionPctInput) else TEXT_COLOR
        rb = TABLE_ROW_ALT if zeb else TABLE_BG
        pair("Compression", cmpStr, cmpClr, rb)
        zeb = not zeb

        rngStr = (fmtPrice(v["rangeLow"]) + " – " + fmtPrice(v["rangeHigh"])
                  if state != IDLE and v["rangeLow"] is not None and v["rangeHigh"] is not None else "—")
        rb = TABLE_ROW_ALT if zeb else TABLE_BG
        pair("Range", rngStr, TEXT_COLOR, rb)
        zeb = not zeb

        htfStr = "Off"           # useHtfBiasInput OFF
        htfClr = TEXT_MUTED
        rb = TABLE_ROW_ALT if zeb else TABLE_BG
        pair("HTF Bias", htfStr, htfClr, rb)
        zeb = not zeb

        nonStdChart = False
        tfWarn = (" ⚠ (opt: 15M)" if tf != "15" else "") + (" ⚠ non-std chart" if nonStdChart else "")
        rb = TABLE_ROW_ALT if zeb else TABLE_BG
        pair("TF", tf + tfWarn, NEUTRAL_TEXT if (tf != "15" or nonStdChart) else TEXT_COLOR, rb)
        zeb = not zeb

    if showCycleSecInput:
        merged("— Cycle —", TEXT_MUTED, TABLE_ROW_ALT)
        if state == DIST:
            entryPrice, stopPrice, tgtPrice, riskR = v["entryPrice"], v["stopPrice"], v["tgtPrice"], v["riskR"]
            dirWord = "Long" if distDir == 1 else "Short"
            dirClr = BULL_TEXT if distDir == 1 else BEAR_TEXT
            curRR = abs(tgtPrice - entryPrice) / riskR if f_gt(riskR, 0) else None
            rrClr = (TEXT_MUTED if curRR is None else BULL_TEXT if f_ge(curRR, 1.5)
                     else NEUTRAL_TEXT if f_ge(curRR, 1.0) else BEAR_TEXT)
            riskPct = (abs(entryPrice - stopPrice) / abs(entryPrice) * 100
                       if entryPrice is not None and f_ne(entryPrice, 0) else None)
            rkClr = (TEXT_MUTED if riskPct is None else BEAR_TEXT if f_gt(riskPct, 3.0)
                     else NEUTRAL_TEXT if f_gt(riskPct, 1.0) else BULL_TEXT)

            rb = TABLE_ROW_ALT if zeb else TABLE_BG
            pair("Entry", dirWord + " @ " + fmtPrice(entryPrice), dirClr, rb)
            zeb = not zeb
            rb = TABLE_ROW_ALT if zeb else TABLE_BG
            pair("Stop", fmtPrice(stopPrice), colStopInput, rb)
            zeb = not zeb
            rb = TABLE_ROW_ALT if zeb else TABLE_BG
            pair("Target", fmtPrice(tgtPrice), colTgtInput, rb)
            zeb = not zeb
            rb = TABLE_ROW_ALT if zeb else TABLE_BG
            pair("R:R", "—" if curRR is None else fmt_mask(curRR, 2) + "R", rrClr, rb)
            zeb = not zeb
            rb = TABLE_ROW_ALT if zeb else TABLE_BG
            pair("Risk", "—" if riskPct is None else fmt_mask(riskPct, 2) + "%", rkClr, rb)
            zeb = not zeb

            rrLeftNum = tgtPrice - close if distDir == 1 else close - tgtPrice
            rrLeftDen = close - stopPrice if distDir == 1 else stopPrice - close
            rrLeft = rrLeftNum / rrLeftDen if (f_gt(rrLeftNum, 0) and f_gt(rrLeftDen, 0)) else None
            rrLeftStr = (("past target" if f_le(rrLeftNum, 0) else "past stop") if rrLeft is None
                         else fmt_mask(rrLeft, 2) + "R")
            rrLeftClr = (TEXT_MUTED if rrLeft is None else BULL_TEXT if f_ge(rrLeft, 1.0)
                         else NEUTRAL_TEXT if f_ge(rrLeft, 0.5) else BEAR_TEXT)
            rb = TABLE_ROW_ALT if zeb else TABLE_BG
            pair("RR left", rrLeftStr, rrLeftClr, rb)
            zeb = not zeb

            rb = TABLE_ROW_ALT if zeb else TABLE_BG
            pair("Age", str(bar_index - v["distStartBar"]) + " bars", TEXT_COLOR, rb)
            zeb = not zeb
        else:
            merged(f_action(), TEXT_MUTED, TABLE_BG)   # no bgcolor set -> table default

    if showStatsSecInput:
        allTime = statsPeriodInput == "All-Time"
        pT, pS, pTo, pSum = st["tgtN"], st["stopN"], st["timeoutN"], st["sumR"]
        pTotal = pT + pS + pTo
        pctOK = pTotal >= minSampleNInput
        pTgtRate = pT / float(pTotal) * 100.0 if pTotal > 0 else 0.0
        periodTag = "All-Time"
        dsN, dsSumR, ambigN = st["dsN"], st["dsSumR"], st["ambigN"]

        merged("— Stats · " + periodTag + " —", TEXT_MUTED, TABLE_ROW_ALT)

        rb = TABLE_ROW_ALT if zeb else TABLE_BG
        pair("Cycles", (str(pTotal) + (" (ds " + str(dsN) + ")" if (allTime and dsN > 0) else ""))
             if pTotal > 0 else "—", TEXT_COLOR, rb)
        zeb = not zeb

        rb = TABLE_ROW_ALT if zeb else TABLE_BG
        pair("Target", (str(pT) + (" (" + fmt_mask(100.0 * pT / pTotal, 1) + "%)" if pctOK else ""))
             if pTotal > 0 else "—", BULL_TEXT if pTotal > 0 else TEXT_MUTED, rb)
        zeb = not zeb

        rb = TABLE_ROW_ALT if zeb else TABLE_BG
        pair("Stop" + (" (amb " + str(ambigN) + ")" if (allTime and ambigN > 0) else ""),
             (str(pS) + (" (" + fmt_mask(100.0 * pS / pTotal, 1) + "%)" if pctOK else ""))
             if pTotal > 0 else "—", BEAR_TEXT if pTotal > 0 else TEXT_MUTED, rb)
        zeb = not zeb

        rb = TABLE_ROW_ALT if zeb else TABLE_BG
        pair("Timeout", (str(pTo) + (" (" + fmt_mask(100.0 * pTo / pTotal, 1) + "%)" if pctOK else ""))
             if pTotal > 0 else "—", TEXT_MUTED, rb)
        zeb = not zeb

        trStr = ("—" if pTotal == 0 else
                 fmt_mask(pTgtRate, 1) + "%  " + buildGauge(pTgtRate, 100, 8) if pctOK else
                 "collecting (" + str(pTotal) + "/" + str(minSampleNInput) + ")")
        trClr = (TEXT_MUTED if (pTotal == 0 or not pctOK) else BULL_TEXT if f_ge(pTgtRate, 55.0)
                 else NEUTRAL_TEXT if f_ge(pTgtRate, 45.0) else BEAR_TEXT)
        rb = TABLE_ROW_ALT if zeb else TABLE_BG
        pair("Target rate", trStr, trClr, rb)
        zeb = not zeb

        pAvg = pSum / pTotal if pTotal > 0 else None
        avgStr = ("—" if pTotal == 0 else
                  fmt_mask(pAvg, 2) + "R" + (" (ds " + fmt_mask(dsSumR / dsN, 2) + ")"
                                             if (allTime and dsN >= minSampleNInput) else "") if pctOK else
                  "collecting (" + str(pTotal) + "/" + str(minSampleNInput) + ")")
        avgClr = (TEXT_MUTED if (pTotal == 0 or not pctOK) else BULL_TEXT if f_ge(pAvg, 0.2)
                  else NEUTRAL_TEXT if f_ge(pAvg, -0.2) else BEAR_TEXT)
        rb = TABLE_ROW_ALT if zeb else TABLE_BG
        pair("Avg R", avgStr, avgClr, rb)
        zeb = not zeb

        rb = TABLE_ROW_ALT if zeb else TABLE_BG
        pair("Form", "—" if v["formStr"] == "" else v["formStr"], TEXT_COLOR, rb)
        zeb = not zeb

        rb = TABLE_ROW_ALT if zeb else TABLE_BG
        pair("Failed / Breakout · All-Time", str(st["failN"]) + " / " + str(st["brkN"]), TEXT_MUTED, rb)
        zeb = not zeb

        rb = TABLE_ROW_ALT if zeb else TABLE_BG
        pair("Resets (e/n/y/f) · All-Time",
             str(st["expN"]) + " / " + str(st["newsN"]) + " / " + str(st["earlyN"]) + " / " + str(st["filtN"]),
             TEXT_MUTED, rb)
        zeb = not zeb

    merged("Po3 · " + INDICATOR_VERSION, TEXT_MUTED, TABLE_BG)   # footer: no bgcolor set
    return rows


def main():
    if len(sys.argv) != 3:
        sys.stderr.write("usage: python3 amd_po3.py IN.json OUT.json\n")
        sys.exit(2)
    with open(sys.argv[1], encoding="utf-8") as fh:
        inp = json.load(fh)
    out = run(inp)
    with open(sys.argv[2], "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False)


if __name__ == "__main__":
    main()
