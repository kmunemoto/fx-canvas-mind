# #385 (docs §8.128): compares two directories of AMD Po3 outputs value for value
# (python3 research/amd-po3-compare.py TS_DIR PY_DIR).
import json, sys, glob, os
a_dir, b_dir = sys.argv[1], sys.argv[2]
def diff(a, b, path, out):
    if isinstance(a, dict) and isinstance(b, dict):
        if set(a) != set(b): out.append(f"{path}: keys {sorted(set(a)^set(b))}"); return
        for k in a: diff(a[k], b[k], f"{path}.{k}", out)
    elif isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b): out.append(f"{path}: len {len(a)} vs {len(b)}")
        for i, (x, y) in enumerate(zip(a, b)): diff(x, y, f"{path}[{i}]", out)
    elif isinstance(a, bool) or isinstance(b, bool):
        if a is not b: out.append(f"{path}: {a!r} vs {b!r}")
    elif isinstance(a, (int, float)) and isinstance(b, (int, float)):
        if float(a) != float(b): out.append(f"{path}: {a!r} vs {b!r}")
    elif a != b: out.append(f"{path}: {a!r} vs {b!r}")
total = 0; bad = 0; counts = {}
for f in sorted(glob.glob(os.path.join(a_dir, "*.json"))):
    g = os.path.join(b_dir, os.path.basename(f))
    A = json.load(open(f)); B = json.load(open(g))
    out = []; diff(A, B, "", out); total += 1
    for k in ("events", "boxes", "lines", "labels", "dash"): counts[k] = counts.get(k, 0) + len(A[k])
    if out:
        bad += 1; print(os.path.basename(f), len(out), "diffs; first:", out[:5])
print(f"cases {total}, differing {bad}, compared items {counts}")
