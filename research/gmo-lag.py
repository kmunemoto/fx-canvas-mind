#!/usr/bin/env python3
# #171: how soon after a bar closes GMO's public klines hold it, as it
# finally stands.
#
# The owner (2026-09-30), on an ULTRA email that came four minutes after its
# 4-hour bar closed — TP1 was reached in those four minutes: 「4分後じゃ遅い
# じゃないですか？一瞬で届く様にはならない？」, and on reading the chart right
# after the close instead: 「試してみて」. Before the sweep reads a chart the
# moment its bar closes, this measures what such a read would get:
#
#   * around one close T, from BEFORE seconds before it to AFTER seconds
#     after, each chart named is read again and again, a request at a time a
#     fifth of a second apart (as the sweep asks GMO, index.ts GMO_GAP_MS);
#   * each answer: when it was asked (seconds from T), GMO's own time on it
#     (`responsetime`: when their server made it), the CDN's `Age` and
#     `X-Cache`, and its newest two bars;
#   * per chart whose bar closes at T: the first answer made at or after T,
#     the first answer holding the bar that closed at T as it finally stood,
#     the first holding the next bar, and whether the closed bar changed in
#     an answer made after T (it would mean an answer made just after the
#     close can still be short of the last prices).
#
# T: the CLOSE given (UTC, e.g. 2026-09-30T12:00:00Z), else the next 4-hour
# close if one comes within 15 minutes, else the next hourly one within 15
# minutes, else the next 5-minute close at least 30 seconds away.
#
# Read-only: GMO's public klines, no key; nothing is written anywhere.
# `--selftest` checks the summary on made-up answers, without the network.

import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

HOST = "https://forex-api.coin.z.com/public/v1"
STEP = {"1min": 60, "5min": 300, "15min": 900, "1hour": 3600, "4hour": 14400}
GAP = 0.2


def iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def next_close(now: float) -> float:
    for step in (14400, 3600):
        t = (int(now) // step + 1) * step
        if t - now <= 15 * 60:
            return float(t)
    t = (int(now) // 300 + 1) * 300
    return float(t if t - now >= 30 else t + 300)


def date_key(interval: str, close: float) -> str:
    # the file the bar that closes at T is in: GMO's trading day starts at
    # 06:00 JST under US summer time (quotes.ts jstDayKey), so a bar is filed
    # under the JST date six hours before it; the year file by the JST year
    jst = datetime.fromtimestamp(close - 1, timezone.utc) + timedelta(hours=9)
    if interval in ("4hour", "1day"):
        return str(jst.year)
    return (jst - timedelta(hours=6)).strftime("%Y%m%d")


def read(symbol: str, interval: str, key: str):
    url = f"{HOST}/klines?symbol={symbol}&priceType=BID&interval={interval}&date={key}"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    asked = time.time()
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            body = json.loads(r.read().decode("utf-8"))
            return asked, time.time(), r.status, dict(r.headers), body
    except urllib.error.HTTPError as e:
        return asked, time.time(), e.code, dict(e.headers or {}), None
    except Exception as e:  # noqa: BLE001 - a failed read is reported, not fatal
        return asked, time.time(), 0, {"error": str(e)}, None


def made_at(body) -> float | None:
    rt = body.get("responsetime") if isinstance(body, dict) else None
    if not isinstance(rt, str):
        return None
    try:
        return datetime.strptime(rt.replace("Z", "+0000"), "%Y-%m-%dT%H:%M:%S.%f%z").timestamp()
    except ValueError:
        return None


def bars_of(body) -> dict[int, tuple[str, str, str, str]]:
    data = body.get("data") if isinstance(body, dict) else None
    out = {}
    for b in data if isinstance(data, list) else []:
        try:
            out[int(b["openTime"]) // 1000] = (b["open"], b["high"], b["low"], b["close"])
        except (KeyError, TypeError, ValueError):
            continue
    return out


def summarize(close: float, step: int, answers: list[dict]) -> dict:
    """answers: {asked, made, bars} in the order asked. What a read at each
    moment would have got of the bar that closed at `close`."""
    bar = close - step
    ok = [a for a in answers if a["bars"]]
    final = next((a["bars"].get(bar) for a in reversed(ok) if a["made"] is not None and a["made"] >= close and bar in a["bars"]), None)
    after = [a for a in ok if a["made"] is not None and a["made"] >= close]
    first_made = after[0] if after else None
    first_final = next((a for a in after if a["bars"].get(bar) == final), None) if final else None
    first_next = next((a for a in after if close in a["bars"]), None)
    changed = [a for a in after if bar in a["bars"] and a["bars"][bar] != final]
    rel = lambda a, k: None if a is None or a[k] is None else round(a[k] - close, 2)  # noqa: E731
    return {
        "answers": len(answers),
        "answers_made_after_close": len(after),
        "final": final,
        "first_made_after_close": {"asked": rel(first_made, "asked"), "made": rel(first_made, "made")},
        "first_with_final_bar": {"asked": rel(first_final, "asked"), "made": rel(first_final, "made")},
        "first_with_next_bar": {"asked": rel(first_next, "asked"), "made": rel(first_next, "made")},
        "made_after_close_but_not_final": [{"asked": rel(a, "asked"), "made": rel(a, "made"), "bar": a["bars"][bar]} for a in changed],
    }


def selftest() -> None:
    c, step = 1_000_000_200.0, 300
    bar = c - step
    fin = ("1", "2", "0.5", "1.5")
    mk = lambda asked, made, bars: {"asked": asked, "made": made, "bars": bars}  # noqa: E731
    answers = [
        mk(c - 5, c - 12, {bar: ("1", "2", "0.5", "1.4")}),  # before the close, cached
        mk(c + 1, c - 3, {bar: ("1", "2", "0.5", "1.4")}),  # after the close, still the cached one
        mk(c + 2, c + 0.5, {bar: ("1", "2", "0.5", "1.45")}),  # made after it, a last price missing
        mk(c + 3, c + 2.5, {bar: fin}),
        mk(c + 4, c + 3.5, {bar: fin, c: ("1.5", "1.5", "1.5", "1.5")}),
        mk(c + 5, None, {}),  # a failed read
    ]
    s = summarize(c, step, answers)
    assert s["final"] == fin, s
    assert s["first_made_after_close"] == {"asked": 2, "made": 0.5}, s
    assert s["first_with_final_bar"] == {"asked": 3, "made": 2.5}, s
    assert s["first_with_next_bar"] == {"asked": 4, "made": 3.5}, s
    assert [x["asked"] for x in s["made_after_close_but_not_final"]] == [2], s
    assert s["answers_made_after_close"] == 3, s
    # nothing made after the close: nothing claimed
    s2 = summarize(c, step, answers[:2])
    assert s2["final"] is None and s2["first_with_final_bar"] == {"asked": None, "made": None}, s2
    # the date keys: 12:00 UTC is 21:00 JST, trading day of that date; 21:00
    # UTC (06:00 JST) closes the day before's last bar
    t = datetime(2026, 9, 30, 12, tzinfo=timezone.utc).timestamp()
    assert date_key("1hour", t) == "20260930" and date_key("4hour", t) == "2026"
    assert date_key("5min", datetime(2026, 9, 30, 21, tzinfo=timezone.utc).timestamp()) == "20260930"
    assert date_key("5min", datetime(2026, 9, 30, 21, 5, tzinfo=timezone.utc).timestamp()) == "20261001"
    # the default close
    base = datetime(2026, 9, 30, 11, 50, tzinfo=timezone.utc).timestamp()
    assert iso(next_close(base)) == "2026-09-30T12:00:00Z"
    assert iso(next_close(base - 3600)) == "2026-09-30T11:00:00Z"
    assert iso(next_close(datetime(2026, 9, 30, 8, 26, tzinfo=timezone.utc).timestamp())) == "2026-09-30T08:30:00Z"
    assert iso(next_close(datetime(2026, 9, 30, 8, 29, 40, tzinfo=timezone.utc).timestamp())) == "2026-09-30T08:35:00Z"
    print("selftest ok")


def main() -> None:
    if "--selftest" in sys.argv:
        selftest()
        return
    symbols = (os.environ.get("SYMBOLS") or "USD_JPY").split()
    intervals = [i for i in (os.environ.get("INTERVALS") or "1min 5min 1hour 4hour").split() if i in STEP]
    before = float(os.environ.get("BEFORE") or 10)
    after = float(os.environ.get("AFTER") or 60)
    given = (os.environ.get("CLOSE") or "").strip()
    now = time.time()
    close = datetime.strptime(given, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc).timestamp() if given else next_close(now)
    if close - now > 20 * 60:
        sys.exit(f"the close {iso(close)} is more than 20 minutes away; start nearer to it")
    if close + after < now:
        sys.exit(f"the close {iso(close)} has passed")
    charts = [(s, i, date_key(i, close)) for s in symbols for i in intervals]
    print(f"close {iso(close)}; charts {charts}; from {before}s before to {after}s after; a request every {GAP}s")
    wait = close - before - time.time()
    if wait > 0:
        print(f"waiting {wait:.1f}s")
        time.sleep(wait)
    else:
        print(f"started {-wait:.1f}s late")
    got: dict[tuple[str, str], list[dict]] = {(s, i): [] for s, i, _ in charts}
    k = 0
    while time.time() < close + after:
        s, i, key = charts[k % len(charts)]
        k += 1
        asked, done, status, headers, body = read(s, i, key)
        made = made_at(body)
        bars = bars_of(body)
        got[(s, i)].append({"asked": asked, "made": made, "bars": bars})
        newest = sorted(bars)[-2:]
        shown = " | ".join(f"{datetime.fromtimestamp(t, timezone.utc):%H:%M} {' '.join(bars[t])}" for t in newest)
        h = {x.lower(): y for x, y in headers.items()}
        print(
            f"{asked - close:+7.2f}s {s} {i:<5} http {status} took {done - asked:.2f}s"
            f" made {'-' if made is None else f'{made - close:+.2f}s'} age {h.get('age', '-')} {h.get('x-cache', '-')}"
            f" | {shown}"
        )
        time.sleep(max(0.0, GAP - (time.time() - done)))
    print("\n== per chart (seconds from the close; 'made' is GMO's responsetime)")
    for s, i, _ in charts:
        step = STEP[i]
        if int(close) % step != 0:
            print(f"{s} {i}: no bar of it closes at {iso(close)} (answers {len(got[(s, i)])})")
            continue
        print(f"{s} {i}: {json.dumps(summarize(close, step, got[(s, i)]))}")


if __name__ == "__main__":
    main()
