#!/usr/bin/env python3
"""Assemble the SQL files of the morning check from their parts.

usage: python3 -I assemble.py OUT.sql PART [PART ...] [--sub NAME=VALUE ...] [--strip]

  --sub NAME=VALUE   replace every {{NAME}} with VALUE
  --strip            drop full-line comments, blank lines and leading blanks (for pasting into one tool call;
                     the SQL text is otherwise identical)
The parts are plain text; every comment in them is a FULL line starting with "--" (no trailing comments, no string literal spans lines).
"""
import re
import sys


def main(argv):
    out = argv[1]
    parts, subs, strip = [], {}, False
    i = 2
    while i < len(argv):
        a = argv[i]
        if a == "--strip":
            strip = True
        elif a == "--sub":
            i += 1
            k, v = argv[i].split("=", 1)
            subs[k] = v
        else:
            parts.append(a)
        i += 1
    text = ""
    for p in parts:
        with open(p, encoding="utf-8") as f:
            t = f.read()
        if not t.endswith("\n"):
            t += "\n"
        text += t
    for k, v in subs.items():
        text = text.replace("{{" + k + "}}", v)
    if strip:
        lines = []
        for ln in text.split("\n"):
            s = ln.strip()
            if not s or s.startswith("--"):
                continue
            lines.append(s)
        text = "\n".join(lines) + "\n"
    left = re.findall(r"\{\{[A-Z_]+\}\}", text)
    with open(out, "w", encoding="utf-8") as f:
        f.write(text)
    print(f"wrote {out}: {len(text)} chars, {text.count(chr(10))} lines, unreplaced markers: {sorted(set(left))}")


main(sys.argv)
