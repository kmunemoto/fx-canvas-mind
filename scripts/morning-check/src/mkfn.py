#!/usr/bin/env python3
"""Write the migration that installs the morning check's statements as read-only SQL functions (v9).

usage: python3 -I mkfn.py OUT.sql HEADER.part FUNCTION BODY.sql [FUNCTION BODY.sql ...]

Each BODY.sql is a statement built by assemble.py with the two markers replaced by the parameters p_start and p_end. It becomes the function's source byte for byte
(pg_proc.prosrc = the file's text: the dollar quote opens right before its first character and closes right after its last), so that md5(prosrc) in the database can be
compared with the md5 of the file.
"""
import hashlib
import re
import sys

out, header = sys.argv[1], sys.argv[2]
pairs = sys.argv[3:]
assert pairs and len(pairs) % 2 == 0
text = open(header, encoding="utf-8").read()
for i in range(0, len(pairs), 2):
    fn, path = pairs[i], pairs[i + 1]
    body = open(path, encoding="utf-8").read()
    # one statement: no semicolon outside a string literal, no marker left, nothing that could end the dollar quote
    bare = re.sub(r"'(?:[^']|'')*'", "''", body)
    assert "$mc$" not in body and body.isascii() and ";" not in bare and "{{" not in body and body.startswith("with recursive") and body.endswith("\n"), path
    assert "p_start::bigint as start_ms, p_end::bigint as end_ms" in body, path
    text += (
        f"\ncreate or replace function {fn}(p_start bigint, p_end bigint)\n"
        "returns table (row_type text, instrument text, bar_open_utc text, side text, verdict text, data json)\n"
        "language sql stable\n"
        "set search_path = ''\n"
        f"as $mc${body}$mc$;\n"
        f"revoke all on function {fn}(bigint, bigint) from public, anon, authenticated;\n"
    )
    print(f"{fn}: {path} {len(body)} chars md5 {hashlib.md5(body.encode()).hexdigest()}")
with open(out, "w", encoding="utf-8") as f:
    f.write(text)
print(f"wrote {out}: {len(text)} chars")
