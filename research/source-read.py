# #185: reads the sources the research on professional traders cited, which
# the development container cannot open, so each number can be checked
# against the source's own text (docs §8.95).
#
# Read-only: public URLs only, no account, no key and no secret; prints each
# page's text (a PDF's through pdftotext) to the job log and writes nothing
# anywhere. One URL a run (the workflow runs one job per URL).
#
#   URL=https://... KEYWORDS="win rate|Sharpe|勝率" python3 research/source-read.py

import os
import re
import subprocess
import sys
import tempfile
import urllib.request

from bs4 import BeautifulSoup

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0 Safari/537.36"
)
HEAD = 60_000  # the first characters printed whole
CONTEXT = 2  # lines either side of a keyword line


def fetch(url):
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": UA,
            "Accept": "text/html,application/pdf,*/*;q=0.8",
            "Accept-Language": "en,ja;q=0.8",
        },
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read(), r.headers.get_content_type(), r.headers.get_content_charset(), r.geturl()


def pdf_text(body):
    with tempfile.NamedTemporaryFile(suffix=".pdf") as f:
        f.write(body)
        f.flush()
        out = subprocess.run(["pdftotext", "-layout", f.name, "-"], capture_output=True, timeout=120)
        return out.stdout.decode("utf-8", errors="replace")


def html_text(body, charset):
    soup = BeautifulSoup(body.decode(charset or "utf-8", errors="replace"), "html.parser")
    for t in soup(["script", "style", "noscript", "svg"]):
        t.decompose()
    return soup.get_text("\n")


def main():
    url = os.environ["URL"]
    keywords = [k for k in os.environ.get("KEYWORDS", "").split("|") if k]
    print("=" * 100)
    print("SOURCE", url)
    try:
        body, ctype, charset, final = fetch(url)
    except Exception as e:  # the job log says why; nothing else to do
        print("FAILED", type(e).__name__, e)
        return 0
    is_pdf = ctype == "application/pdf" or body[:5] == b"%PDF-"
    print("FINAL", final, "| TYPE", "pdf" if is_pdf else ctype, "| BYTES", len(body))
    text = pdf_text(body) if is_pdf else html_text(body, charset)
    lines = [re.sub(r"[ \t　]+", " ", l).strip() for l in text.split("\n")]
    lines = [l for l in lines if l]
    whole = "\n".join(lines)
    print("CHARS", len(whole), "| LINES", len(lines))
    print("--- TEXT (first", HEAD, "chars) ---")
    print(whole[:HEAD])
    if keywords:
        pat = re.compile("|".join(re.escape(k) for k in keywords), re.I)
        hits = [i for i, l in enumerate(lines) if pat.search(l)]
        print(f"--- KEYWORD LINES ({len(hits)}) ---")
        shown = set()
        for i in hits:
            lo, hi = max(0, i - CONTEXT), min(len(lines), i + CONTEXT + 1)
            if i in shown:
                continue
            print(f"[{i}]", " / ".join(lines[lo:hi]))
            shown.update(range(lo, hi))
    print("--- END ---")
    return 0


if __name__ == "__main__":
    sys.exit(main())
