# The local check of signal-alerts v42's migration (research/allstocks-prod-spec.md section 9, "Local PostgreSQL"):
# what the repository's own migration files say of public.signal_alert_subscriptions, read from them in file order, so
# that the check's table is the one those files leave (its columns, its keys, its pair, interval and rule checks).
#   python3 -I from-migrations.py table   -> the statements on the table (create, columns, keys, checks, rights, policy)
#   python3 -I from-migrations.py pairs   -> the pair check's values as the newest file before v42 writes them, one a line
# Only the files before 20261122010000 (v42's own) are read. Nothing is sent anywhere; it prints.
import pathlib
import re
import sys

MIG = pathlib.Path(__file__).resolve().parents[2] / "supabase" / "migrations"
V42 = "20261122010000"
files = sorted(p for p in MIG.glob("*.sql") if p.name < V42)
T = r"public\.signal_alert_subscriptions\b"
# a statement on the table: its create, an alter (a column, a key, a check; inside a do block too), its rights and policy
STATEMENT = re.compile(
    r"(?:create table if not exists\s+" + T
    + r"|alter table\s+" + T
    + r"|revoke all on\s+" + T
    + r"|grant [a-z ,]+ on\s+" + T
    + r"|drop policy if exists \"[^\"]*\" on\s+" + T
    + r"|create policy \"[^\"]*\"\s+on\s+" + T
    + r")[^;]*;",
    re.S,
)

if sys.argv[1:] == ["table"]:
    for f in files:
        text = f.read_text(encoding="utf-8")
        # the comment lines are not statements
        text = "\n".join(l for l in text.split("\n") if not l.lstrip().startswith("--"))
        got = STATEMENT.findall(text)
        if got:
            print(f"-- {f.name}")
            for s in got:
                print(s.strip())
elif sys.argv[1:] == ["pairs"]:
    last = None
    for f in files:
        for m in re.finditer(r"add constraint signal_alert_subscriptions_pair_check\s+check \(pair = any \(array\[(.*?)\]\)\)", f.read_text(encoding="utf-8"), re.S):
            last = re.findall(r"'([^']*)'", m.group(1))
    if not last:
        sys.exit("no pair check found")
    print("\n".join(last))
else:
    sys.exit("usage: from-migrations.py table|pairs")
