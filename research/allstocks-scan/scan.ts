// The one-off scan (README.md): reads each share of list.py's list from Yahoo (its 15-minute bars, as the app's run
// reads them: live-chart/stocks.ts yahooChartUrl and YAHOO_HEADERS, signal-alerts/stocks.ts stockBarsOf) and judges its
// last session with judge.ts. One read at a time, at most one every gapMs; a refusal (429) waits and is tried again,
// and the scan stops when Yahoo keeps refusing. Yahoo's answers are not kept: each line of the output holds the
// symbol, the outcome and judge.ts's result (times, sides and the line's share of the pane's end; no price). A line
// already in the output is not read again, so a stopped scan goes on from where it stopped.
//
//   deno run --allow-env --allow-net=query1.finance.yahoo.com --allow-read --allow-write=<dir> \
//     research/allstocks-scan/scan.ts <dir>/symbols.json <dir>/results.jsonl

import { stockBarsOf } from "../../supabase/functions/signal-alerts/stocks.ts";
import { isStockSymbol, YAHOO_HEADERS, yahooChartUrl } from "../../supabase/functions/live-chart/stocks.ts";
import { judgeLastSession } from "./judge.ts";

export interface ScanOptions {
  list: { symbol: string }[];
  outPath: string;
  fetchFn?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  gapMs?: number;
  timeoutMs?: number;
  refusedWaitMs?: number;
  refusedTries?: number;
  // the scan stops after this many shares in a row ended refused after all their tries
  refusedStop?: number;
  log?: (s: string) => void;
}

export interface ScanResult {
  stopped: boolean;
  counts: Record<string, number>;
  read: number;
}

export const runScan = async (o: ScanOptions): Promise<ScanResult> => {
  const fetchFn = o.fetchFn ?? fetch;
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const gapMs = o.gapMs ?? 600;
  const timeoutMs = o.timeoutMs ?? 15_000;
  const refusedWaitMs = o.refusedWaitMs ?? 60_000;
  const refusedTries = o.refusedTries ?? 3;
  const refusedStop = o.refusedStop ?? 3;
  const log = o.log ?? console.log;

  const done = new Set<string>();
  try {
    for (const line of (await Deno.readTextFile(o.outPath)).split("\n")) if (line.trim()) done.add(JSON.parse(line).symbol);
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
  const todo = o.list.filter((x) => isStockSymbol(x.symbol) && !done.has(x.symbol));
  log(`list ${o.list.length}, already done ${done.size}, to read ${todo.length}`);

  const file = await Deno.open(o.outPath, { append: true, create: true });
  const enc = new TextEncoder();
  const counts: Record<string, number> = {};
  const started = now();
  let lastRead = Number.NEGATIVE_INFINITY;
  let refusedRow = 0;
  let read = 0;
  try {
    for (let i = 0; i < todo.length; i++) {
      const sym = todo[i].symbol;
      let status = "";
      let body: unknown = null;
      for (let t = 0; t < refusedTries; t++) {
        const wait = lastRead + gapMs - now();
        if (wait > 0) await sleep(wait);
        lastRead = now();
        read++;
        try {
          const r = await fetchFn(yahooChartUrl(sym, "15min"), { headers: YAHOO_HEADERS, signal: AbortSignal.timeout(timeoutMs) });
          if (r.status === 429) {
            await r.body?.cancel();
            status = "refused_429";
            await sleep(refusedWaitMs);
            continue;
          }
          if (!r.ok) {
            await r.body?.cancel();
            status = r.status === 404 ? "not_found" : `http_${r.status}`;
            break;
          }
          body = await r.json().catch(() => null);
          status = body === null ? "unreadable" : "read";
          break;
        } catch (e) {
          status = e instanceof DOMException && e.name === "TimeoutError" ? "timeout" : "fetch_failed";
          break;
        }
      }
      if (status === "refused_429") {
        counts[status] = (counts[status] ?? 0) + 1;
        refusedRow++;
        if (refusedRow >= refusedStop) {
          log(`stopped: ${refusedStop} shares in a row refused (429) after ${refusedTries} tries each; ${i + 1} of ${todo.length} tried this run`);
          return { stopped: true, counts, read };
        }
        // not written, so a later run reads it
        continue;
      }
      refusedRow = 0;
      let line: Record<string, unknown> = { symbol: sym, status };
      if (status === "read") {
        const got = stockBarsOf(sym, body, now());
        if (!got) line = { symbol: sym, status: "no_bars" };
        else {
          const j = judgeLastSession(sym, got.bars);
          line = {
            symbol: sym,
            status: j.closedBars === 0 ? "no_bars" : "ok",
            ...j,
            zone: j.zone && { side: j.zone.side, share: j.zone.share === null ? null : Math.round(j.zone.share * 10_000) / 10_000 },
          };
        }
      }
      file.writeSync(enc.encode(JSON.stringify(line) + "\n"));
      counts[String(line.status)] = (counts[String(line.status)] ?? 0) + 1;
      if ((i + 1) % 200 === 0 || i === todo.length - 1) {
        const min = ((now() - started) / 60_000).toFixed(1);
        log(`${i + 1}/${todo.length} in ${min} min: ${Object.entries(counts).map(([k, n]) => `${k} ${n}`).join(", ")}`);
      }
    }
  } finally {
    file.close();
  }
  return { stopped: false, counts, read };
};

if (import.meta.main) {
  const [listPath, outPath] = Deno.args;
  if (!listPath || !outPath) throw new Error("usage: scan.ts <symbols.json> <results.jsonl>");
  const list = JSON.parse(await Deno.readTextFile(listPath));
  const res = await runScan({ list, outPath });
  if (res.stopped) Deno.exit(3);
}
