// v43: the five pairs' 5-minute chart (the MACD fade's, read 36 minutes an
// hour) takes the ended GMO day files it needs from GMO, checked file by file
// against the copies public.gmo_kline_files keeps, instead of reading six days
// of those copies again on every new instance (index.ts preload). The table
// sends only an index of what it keeps (public.gmo_kline_index, migration
// 20261128130000): a row a sound file, its bars' count `n` and a digest `h` of
// the five fields the walk reads of each bar (track-outcomes/quotes.ts
// parseKlines: openTime, open, high, low, close). GMO's answer stands in for
// the kept copy only when it has the same count and the same digest; else the
// kept copy is read, that file alone. So the bars judged are the kept copies'
// (v43's), whichever way they came. Every other chart reads as before.
//
// Everything here is Deno-free: src/test/kline-direct.test.ts imports it.

import { isMacdhChart, keepableKlines } from "./indicators.ts";

// How long after the index was read a run still asks GMO for kept files (past
// it, the kept copies are read from the table), and how many times it asks
// for one whose answer was not sound
export const KLINE_DIRECT_BUDGET_MS = 30_000;
export const KLINE_DIRECT_TRIES = 2;

// A kept file as the index gives it: its bars' count and its digest
export interface KeptSum {
  n: number;
  h: string;
}

// The charts read this way: the five pairs' MACD fade chart on 5 minutes
// (indicators.ts MACDH_INTERVAL_OF; gold's is '1h'), whatever rule follows it
export const isKlineDirectChart = (pair: unknown, interval: unknown): boolean =>
  interval === "5min" && isMacdhChart(pair, interval);

// The text the digest is made of: a line a bar, in the answer's own order, its
// openTime, open, high, low and close as GMO gave them, joined by ","; the
// lines joined by "\n" ("" for a day with no bars). The migration's SQL makes
// the same text from a kept copy (a missing field empty). null for anything
// else: an answer that is not sound (keepableKlines), a bar that is not an
// object, a field that is not a string, is empty, or holds "," or a newline.
// So a line always splits back into the same five fields, and a kept copy
// with an odd bar (a number, a field missing) can match only a GMO answer
// whose fields read as the same numbers (parseKlines); otherwise the kept
// copy is read
export const klineDataText = (body: unknown): string | null => {
  if (!keepableKlines(body)) return null;
  const lines: string[] = [];
  for (const bar of (body as { data: unknown[] }).data) {
    if (typeof bar !== "object" || bar === null) return null;
    const r = bar as Record<string, unknown>;
    const fields = [r.openTime, r.open, r.high, r.low, r.close];
    for (const v of fields) {
      if (typeof v !== "string" || v.length === 0 || /[,\n]/.test(v)) return null;
    }
    lines.push(fields.join(","));
  }
  return lines.join("\n");
};

// The first 8 bytes of the SHA-256 of that text (UTF-8), in lowercase hex: the
// index's `h`; null when there is no text
export const klineDigest = async (body: unknown): Promise<string | null> => {
  const text = klineDataText(body);
  if (text === null) return null;
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return [...d.slice(0, 8)].map((x) => x.toString(16).padStart(2, "0")).join("");
};

// The index's rows ({ s, p, d, n, h }: symbol, price_type, date_key, bars,
// digest) by indicators.ts klineFileKey, under GMO's interval name; null when
// the answer is not a list of such rows (then the run reads as v43 did)
export const keptIndexOf = (rows: unknown, gmoInterval: string): Map<string, KeptSum> | null => {
  if (!Array.isArray(rows)) return null;
  const out = new Map<string, KeptSum>();
  for (const row of rows) {
    if (typeof row !== "object" || row === null) return null;
    const x = row as Record<string, unknown>;
    if (typeof x.s !== "string" || typeof x.p !== "string") return null;
    if (typeof x.d !== "string" || !/^[0-9]{8}$/.test(x.d)) return null;
    if (typeof x.n !== "number" || !Number.isSafeInteger(x.n) || x.n < 0) return null;
    if (typeof x.h !== "string" || !/^[0-9a-f]{16}$/.test(x.h)) return null;
    out.set(`${x.s}|${x.p}|${gmoInterval}|${x.d}`, { n: x.n, h: x.h });
  }
  return out;
};

// The symbols the index holds a row of
export const symbolsOf = (index: Map<string, KeptSum>): Set<string> =>
  new Set([...index.keys()].map((k) => k.split("|")[0]));
