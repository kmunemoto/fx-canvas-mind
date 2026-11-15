#!/usr/bin/env python3
"""Write a block that creates mc.pairs_v9 / mc.gold_v9 (README.md v9.7, docs/OPERATIONS.md 8.151).

usage: python3 -I mkinstall.py OUT.sql TEMPLATE.part MIGRATION_FILE_NAME PAIRS.fn.sql GOLD.fn.sql

Two templates: install-v9.part (the block that puts together the pieces sent to mc._src) and install-v9-full.part (one block that holds the two sources in full,
for the SQL Editor when the pieces cannot be sent). Each checks the whole texts against the md5 and the length of the .fn.sql files given here, so it is written
from them (never by hand). MIGRATION_FILE_NAME is the migration that creates the same functions (named in the comments and in an error).
"""
import hashlib
import re
import sys

out, tmpl, mig, pairs, gold = sys.argv[1:6]
assert re.fullmatch(r"[0-9]{14}_[a-z0-9_]+\.sql", mig), mig
t = open(tmpl, encoding="utf-8").read()
vals, srcs = {}, {}
for key, path in (("PAIRS", pairs), ("GOLD", gold)):
    b = open(path, encoding="utf-8").read()
    assert b.isascii() and b.endswith("\n") and "$src$" not in b and "$mc$" not in b and "$do$" not in b and "{{" not in b, path
    vals[key + "_MD5"] = hashlib.md5(b.encode()).hexdigest()
    vals[key + "_CHARS"] = str(len(b))
    srcs[key + "_SRC"] = b
vals["MIGRATION"] = mig
for k, v in vals.items():
    assert ("{{" + k + "}}") in t, k
    t = t.replace("{{" + k + "}}", v)
full = all(("{{" + k + "}}") in t for k in srcs)
assert full or not any(("{{" + k + "}}") in t for k in srcs), "a template holds one source but not the other"
if full:
    for k, v in srcs.items():
        assert t.count("{{" + k + "}}") == 1, k
        head, tail = t.split("{{" + k + "}}")
        t = head + v + tail  # the sources hold no "{{" (asserted above), so nothing in them is replaced
assert "{{" not in t
with open(out, "w", encoding="utf-8") as f:
    f.write(t)
print(f"wrote {out}: {len(t)} chars; pairs {vals['PAIRS_MD5']} {vals['PAIRS_CHARS']}, gold {vals['GOLD_MD5']} {vals['GOLD_CHARS']}, migration {mig}"
      + ("; the two sources in full" if full else ""))
