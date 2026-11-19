#!/usr/bin/env python3
"""The structure checks of the morning check's statements (README.md v11.5, v12.4), with no database: for each of pairs-v12, gold-v12, stocks-v12 and pairs1h-v11 (and
pairs-v11, gold-v11, stocks-v11 beside them): both files ASCII only; `strip(X.sql) == X.min.sql` (what src/assemble.py --strip does); `{{START_MS}}` and `{{END_MS}}` once
each in both files; the go-live markers as expected (pairs-v12: GO_LIVE_MS_PAIRS and END_1H_MS_PAIRS twice each, the two pairs' rows, while not set; gold-v12: the gold
markers once each; none in the others); no `{{RUN_OTHER_PAIRS}}` slot left; and outside quoted strings the .min.sql holds no `;` and none of the words insert / update /
delete / drop / create / alter / truncate / grant / revoke / copy / call / set / do / execute / merge.

usage: python3 -I structure12.py [DIR] [--released]   (DIR: the folder of the statements, default ..; --released: the release has set pairs-v12's markers, so none is
                                                       left in pairs-v12 and both its rows hold 13-digit numbers instead)
Exit 1 on any problem.
"""
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
args = [a for a in sys.argv[1:] if not a.startswith("--")]
D = args[0] if args else os.path.join(HERE, "..")
RELEASED = "--released" in sys.argv
WORDS = "insert update delete drop create alter truncate grant revoke copy call set do execute merge".split()
MARKERS = ("GO_LIVE_MS_PAIRS", "END_1H_MS_PAIRS", "GO_LIVE_MS_GOLD", "END_1H_MS_GOLD", "RUN_OTHER_PAIRS")
WANT = {
    "pairs-v12": {} if RELEASED else {"GO_LIVE_MS_PAIRS": 2, "END_1H_MS_PAIRS": 2},
    "gold-v12": {"GO_LIVE_MS_GOLD": 1, "END_1H_MS_GOLD": 1},
    "stocks-v12": {},
    "pairs1h-v11": {},
    "pairs-v11": {},
    "gold-v11": {},
    "stocks-v11": {},
}


def strip(t):
    return "\n".join(s for s in (ln.strip() for ln in t.split("\n")) if s and not s.startswith("--")) + "\n"


bad = 0
for base, want in WANT.items():
    a = open(os.path.join(D, base + ".sql"), encoding="utf-8").read()
    m = open(os.path.join(D, base + ".min.sql"), encoding="utf-8").read()
    probs = []
    for name, t in ((".sql", a), (".min.sql", m)):
        if not t.isascii():
            probs.append(f"{name} not ASCII")
        for mk in ("START_MS", "END_MS"):
            if t.count("{{" + mk + "}}") != 1:
                probs.append(f"{name} {{{{{mk}}}}} x{t.count('{{' + mk + '}}')}")
        got = {k: t.count("{{" + k + "}}") for k in MARKERS if t.count("{{" + k + "}}")}
        if got != want:
            probs.append(f"{name} markers {got} (want {want})")
    if strip(a) != m:
        probs.append("strip(.sql) != .min.sql")
    u = re.sub(r"'(?:[^']|'')*'", "''", m)
    if ";" in u:
        probs.append("; outside quoted strings")
    words = [w for w in WORDS if re.search(r"\b" + w + r"\b", u, re.I)]
    if words:
        probs.append(f"words {words} outside quoted strings")
    if base == "pairs-v12" and "'macdx_15min_rows_other_pairs'" not in m:
        probs.append("no RUN macdx_15min_rows_other_pairs")
    if base == "gold-v12" and "macdx_15min_rows_other_pairs" in m:
        probs.append("gold-v12 holds macdx_15min_rows_other_pairs")
    if base == "pairs-v12" and RELEASED and len(re.findall(r"\('(?:USD_JPY|AUD_USD)', '[A-Z/]+', \d, \d{13}::bigint, \d, \d{13}::bigint\)", m)) != 2:
        probs.append("the two rows of syms do not both hold 13-digit live_ms and end_1h_ms")
    bad += len(probs)
    print(f"{base}: {len(m):,} chars (.min.sql), {len(a):,} (.sql): " + ("ok" if not probs else "; ".join(probs)))
print(f"problems {bad}")
sys.exit(1 if bad else 0)
