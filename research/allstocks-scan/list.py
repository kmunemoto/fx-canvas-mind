#!/usr/bin/env python3
"""The share list of the one-off scan (README.md): every listed US and Tokyo share whose symbol the app takes.

Reads the public listing files from a directory (downloaded beforehand, see README.md) and writes a JSON list of
{"symbol", "market", "name", "kind"}. Not used by the app (the owner's choice for the app is Yahoo's search, not these
lists). No price is read here.

  python3 -I research/allstocks-scan/list.py <dir> <out.json>

<dir> holds data_j.xlsx and data_e.xlsx (JPX's list of listed issues, Japanese and English) and nasdaqlisted.txt and
otherlisted.txt (Nasdaq Trader's symbol directory). The headers are checked against the ones these files had when read
on 2026-11-18 (.github/workflows/stocklist-probe.yml, run 44343329657); a different header stops the script.
"""
import collections
import json
import re
import sys

import openpyxl

US_SYMBOL = re.compile(r"^[A-Z]{1,5}(-[A-Z]{1,2})?$")  # live-chart/stocks.ts US_SYMBOL
JP_CODE = re.compile(r"^[0-9][0-9A-Z]{3}$")  # live-chart/stocks.ts JP_SYMBOL without ".T"

JPX_EN_HEADER = ["Effective Date", "Local Code", "Name (English)", "Section/Products"]
# the shares: Prime, Standard and Growth, domestic and foreign (not ETFs/ETNs, REITs and funds, PRO Market, or
# equity contribution securities); compared with the spaces taken out, as the file spaces them unevenly
JPX_SHARE_SECTIONS = {
    "PrimeMarket(Domestic)", "StandardMarket(Domestic)", "GrowthMarket(Domestic)",
    "PrimeMarket(Foreign)", "StandardMarket(Foreign)", "GrowthMarket(Foreign)",
}
NASDAQ_HEADER = ["Symbol", "Security Name", "Market Category", "Test Issue", "Financial Status", "Round Lot Size", "ETF", "NextShares"]
OTHER_HEADER = ["ACT Symbol", "Security Name", "Exchange", "CQS Symbol", "ETF", "Round Lot Size", "Test Issue", "NASDAQ Symbol"]
# the kinds of a US security kept: common and ordinary shares, ADRs, and the other share kinds (REITs, business
# development companies, registry and voting shares); left out: warrants, rights, units, preferred shares, notes and
# debentures, closed-end funds
US_KEPT = {"common", "adr", "other"}


def rows_of(path):
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    ws = wb[wb.sheetnames[0]]
    return [list(r) for r in ws.iter_rows(values_only=True)]


def us_kind(name):
    low = name.lower()
    if "warrant" in low:
        return "warrant"
    if re.search(r"\bright", low):
        return "right"
    if re.search(r"\bunits?\b", low):
        return "unit"
    if "preferred" in low:
        return "preferred"
    if re.search(r"\bnotes?\b|debenture", low):
        return "note"
    if "closed end fund" in low or "closed-end fund" in low:
        return "fund"
    if "american depositary" in low or "american depository" in low or re.search(r"\bads\b|\badss\b", low):
        return "adr"
    if "common" in low or "ordinary" in low or re.search(r"\bclass [a-z]\b", low):
        return "common"
    return "other"


def main(d, out_path):
    out, counts = [], collections.Counter()

    # Tokyo: the section from the English file, the name from the Japanese one (the two have the same codes)
    en = rows_of(f"{d}/data_e.xlsx")
    if en[0][:4] != JPX_EN_HEADER:
        sys.exit(f"data_e.xlsx header changed: {en[0][:4]}")
    ja = rows_of(f"{d}/data_j.xlsx")
    ja_name = {str(r[1]).strip(): str(r[2]).strip() for r in ja[1:] if r and r[1] is not None}
    for r in en[1:]:
        if not r or r[1] is None:
            continue
        code = str(r[1]).strip()
        section = re.sub(r"\s+", "", str(r[3] or ""))
        if section not in JPX_SHARE_SECTIONS:
            counts[f"jp left out: {r[3]}"] += 1
            continue
        if not JP_CODE.match(code):
            counts["jp left out: code not the app's shape"] += 1
            continue
        if code not in ja_name:
            counts["jp left out: not in the Japanese file"] += 1
            continue
        out.append({"symbol": f"{code}.T", "market": "jp", "name": ja_name[code], "kind": "share"})
        counts["jp kept"] += 1

    # US: Nasdaq-listed and the other exchanges'
    for fname, header, sym_col in (("nasdaqlisted.txt", NASDAQ_HEADER, "Symbol"), ("otherlisted.txt", OTHER_HEADER, "ACT Symbol")):
        lines = open(f"{d}/{fname}", encoding="utf-8", errors="replace").read().splitlines()
        if lines[0].split("|") != header:
            sys.exit(f"{fname} header changed: {lines[0]}")
        for line in lines[1:]:
            if line.startswith("File Creation Time") or not line.strip():
                continue
            r = dict(zip(header, line.split("|")))
            if r.get("Test Issue") == "Y" or r.get("ETF") == "Y" or r.get("NextShares") == "Y":
                counts["us left out: test issue, ETF or NextShares"] += 1
                continue
            sym = r[sym_col].strip().replace(".", "-")
            name = r["Security Name"].strip()
            kind = us_kind(name)
            if kind not in US_KEPT:
                counts[f"us left out: {kind}"] += 1
                continue
            if not US_SYMBOL.match(sym):
                counts[f"us left out: {kind}, symbol not the app's shape"] += 1
                continue
            out.append({"symbol": sym, "market": "us", "name": name, "kind": kind})
            counts[f"us kept: {kind}"] += 1

    seen, uniq = set(), []
    for x in out:
        if x["symbol"] in seen:
            counts["duplicate left out"] += 1
            continue
        seen.add(x["symbol"])
        uniq.append(x)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(uniq, f, ensure_ascii=False)
    for k, n in sorted(counts.items()):
        print(f"{n:6d}  {k}")
    print(f"{len(uniq):6d}  in the list ({sum(1 for x in uniq if x['market'] == 'us')} US, {sum(1 for x in uniq if x['market'] == 'jp')} Tokyo)")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
