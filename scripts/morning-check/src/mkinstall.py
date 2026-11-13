#!/usr/bin/env python3
"""Write the block that creates mc.pairs_v9 / mc.gold_v9 from the pieces in mc._src (README.md v9.7, docs/OPERATIONS.md 8.151).

usage: python3 -I mkinstall.py OUT.sql TEMPLATE.part MIGRATION_FILE_NAME PAIRS.fn.sql GOLD.fn.sql

The block checks each whole text against the md5 and the length of the .fn.sql files given here, so it is written from them (never by hand). MIGRATION_FILE_NAME is the
migration that creates the same functions without pieces (named in the block's comment and in its error when mc._src is missing).
"""
import hashlib
import re
import sys

out, tmpl, mig, pairs, gold = sys.argv[1:6]
assert re.fullmatch(r"[0-9]{14}_[a-z0-9_]+\.sql", mig), mig
t = open(tmpl, encoding="utf-8").read()
vals = {}
for key, path in (("PAIRS", pairs), ("GOLD", gold)):
    b = open(path, encoding="utf-8").read()
    vals[key + "_MD5"] = hashlib.md5(b.encode()).hexdigest()
    vals[key + "_CHARS"] = str(len(b))
vals["MIGRATION"] = mig
for k, v in vals.items():
    assert ("{{" + k + "}}") in t, k
    t = t.replace("{{" + k + "}}", v)
assert "{{" not in t
with open(out, "w", encoding="utf-8") as f:
    f.write(t)
print(f"wrote {out}: {len(t)} chars; pairs {vals['PAIRS_MD5']} {vals['PAIRS_CHARS']}, gold {vals['GOLD_MD5']} {vals['GOLD_CHARS']}, migration {mig}")
