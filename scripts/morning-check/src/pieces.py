#!/usr/bin/env python3
"""Cut the two function sources of the morning check v9 into the pieces that are sent to the database one at a time (README.md v9.7, docs/OPERATIONS.md 8.151).

usage: python3 -I pieces.py OUTDIR [PAIRS.fn.sql GOLD.fn.sql]      (default: ../pairs-v9.fn.sql ../gold-v9.fn.sql, from this folder)

The sources are some 43,000 and 40,000 characters: too long to be typed into one tool call without a slip. A piece is at most some 7,400 characters. For each piece
this writes OUTDIR/NAME.txt (the text) and OUTDIR/NAME.sql (the one statement that puts it into mc._src and answers its md5 and length), and prints name, chars, md5:
the database's answer to each statement must be that line. Then install-v9.sql puts the pieces together and creates the functions only if each whole text is the file's.

The cuts are at fixed lines (the first line of each piece, CUTS below; each must be found exactly once). What the pairs and gold share is one piece for both and must be
the same text in the two files; the last piece (the RUN row) differs only by the two names, which install-v9.sql replaces.
"""
import hashlib
import os
import sys

# name of the piece that STARTS at the line; "=" an exact line, "^" the line's beginning
CUTS = [
    ("c1a", "^", "kk as (select symbol, ot, seq, m8, d,"),
    ("c1b", "=", "(2.0::float8 / 27.0::float8) * x.xv + (1 - (2.0::float8 / 27.0::float8)) * f.e26_p as ne26) a"),
    ("mid", "=", None),  # the guards: "dates as (" in the pairs, "hj as (" in gold
    ("c2a", "=", "ck as ("),
    ("c2b", "=", "from ov"),
    ("c2c", "=", "nullif(gd.warn, '')) as t) att"),
    ("r", "^", "select 0, 0, 0, 'RUN',"),  # the piece starts one line earlier, at its "union all"
]
SHARED = ["c1a", "c1b", "c2a", "c2b", "c2c"]
ORDER = ["p1", "c1a", "c1b", "p2", "c2a", "c2b", "c2c", "r", "g1", "g2"]


def cut(path, first, mid, mid_line):
    lines = open(path, encoding="utf-8").read().split("\n")
    assert lines[-1] == "", path  # the file ends with a newline
    lines = [x + "\n" for x in lines[:-1]]
    at = []
    for name, how, text in CUTS:
        text = mid_line if name == "mid" else text
        hits = [i for i, x in enumerate(lines) if (x == text + "\n" if how == "=" else x.startswith(text))]
        assert len(hits) == 1, (path, name, hits)
        i = hits[0]
        if name == "r":
            i -= 1
            assert lines[i] == "union all\n", (path, lines[i])
        at.append((mid if name == "mid" else name, i))
    assert [i for _, i in at] == sorted(i for _, i in at) and at[0][1] > 0, (path, at)
    out = {first: "".join(lines[: at[0][1]])}
    for k, (name, i) in enumerate(at):
        j = at[k + 1][1] if k + 1 < len(at) else len(lines)
        out[name] = "".join(lines[i:j])
    assert "".join(out[n] for n in [first] + [n for n, _ in at]) == open(path, encoding="utf-8").read(), path
    return out


def md5(t):
    return hashlib.md5(t.encode()).hexdigest()


def main():
    outdir = sys.argv[1]
    here = os.path.dirname(os.path.abspath(__file__))
    pairs_path = sys.argv[2] if len(sys.argv) > 2 else os.path.join(here, "..", "pairs-v9.fn.sql")
    gold_path = sys.argv[3] if len(sys.argv) > 3 else os.path.join(here, "..", "gold-v9.fn.sql")
    p = cut(pairs_path, "p1", "p2", "dates as (")
    g = cut(gold_path, "g1", "g2", "hj as (")
    for n in SHARED:
        assert p[n] == g[n], "the piece %s is not the same text in the two files" % n
    tail = p["r"].replace("pairs.sql v9", "gold.sql v9").replace("mc.pairs_v9", "mc.gold_v9")
    assert tail == g["r"], "the last piece differs by more than the two names"
    pieces = dict(p)
    pieces["g1"], pieces["g2"] = g["g1"], g["g2"]
    os.makedirs(outdir, exist_ok=True)
    for n in ORDER:
        t = pieces[n]
        assert t.isascii() and "$mc$" not in t, n
        with open(os.path.join(outdir, n + ".txt"), "w", encoding="utf-8") as f:
            f.write(t)
        with open(os.path.join(outdir, n + ".sql"), "w", encoding="utf-8") as f:
            f.write(
                "insert into mc._src (name, txt) values ('%s', $mc$%s$mc$) on conflict (name) do update set txt = excluded.txt "
                "returning name, md5(txt) as md5, length(txt) as chars;\n" % (n, t)
            )
        print("%-4s %6d %s" % (n, len(t), md5(t)))
    whole_p = "".join(pieces[n] for n in ["p1", "c1a", "c1b", "p2", "c2a", "c2b", "c2c", "r"])
    whole_g = "".join(pieces[n] for n in ["g1", "c1a", "c1b", "g2", "c2a", "c2b", "c2c"]) + tail
    assert whole_p == open(pairs_path, encoding="utf-8").read() and whole_g == open(gold_path, encoding="utf-8").read()
    print("pairs %6d %s" % (len(whole_p), md5(whole_p)))
    print("gold  %6d %s" % (len(whole_g), md5(whole_g)))


main()
