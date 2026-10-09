// #250 (docs §8.106), at the owner's asking on 2026-10-09 (「今日出してた判断とこれを考慮した場合で」):
// the day's gold (XAU/USD) emails beside research/trend-day.ts's five pairs. Gold is not on GMO, so
// this reads what the chart reads for gold's Dow line (live-chart index.ts, action "dow"): the bars
// stored from Twelve Data (public.live_chart_fallback), their last TWELVE_CHART_BARS, the closed ones
// (closedOf), dowOf. What followed is read on the stored 5-minute bars: mids, no spread, so a rough
// look (the FX pairs' is on GMO's Bid and Ask).
//
// The bars are files in GOLD_DIR (15min.txt, 1h.txt, 4h.txt, 5min.txt: "MMDDHHmm,open,high,low,close"
// joined by ";", 2026, UTC), written from the table and checked against the table's own md5 (docs);
// they are not in the repository. The chart read each timeframe's stored bars as they were a minute
// after the email's bar closed: here the stored bars of 12:16 UTC, cut at that time. The 15-minute
// bars were stored about a minute after each close, so whether the chart had the newest one then is
// not known: both are printed (A with it, B without).

import { createHash } from "node:crypto";
import type { Candle } from "../supabase/functions/analyze/indicators.ts";
import { TWELVE_CHART_BARS, dowOf } from "../supabase/functions/live-chart/logic.ts";

const DIR = Deno.env.get("GOLD_DIR");
if (!DIR) throw new Error("GOLD_DIR: the folder of the gold bar files");
const MIN = 60_000;
const STEP: Record<string, number> = { "5min": 5 * MIN, "15min": 15 * MIN, "1h": 60 * MIN, "4h": 240 * MIN };
// the 5-minute bars as stored at 12:04:14 UTC (a bar still forming then is left out)
const STORED_5 = Date.parse("2026-10-09T12:04:14.732Z");

interface Bar extends Candle {
  t: number;
}
const read = async (tf: string): Promise<Bar[]> => {
  const text = (await Deno.readTextFile(`${DIR}/${tf}.txt`)).trim();
  console.log(`${tf}.txt md5 ${createHash("md5").update(text).digest("hex")}, bars ${text.split(";").length}`);
  return text.split(";").map((s) => {
    const [k, o, h, l, c] = s.split(",");
    const datetime = `2026-${k.slice(0, 2)}-${k.slice(2, 4)} ${k.slice(4, 6)}:${k.slice(6, 8)}:00`;
    return { datetime, t: Date.parse(`${datetime.replace(" ", "T")}Z`), open: Number(o), high: Number(h), low: Number(l), close: Number(c) };
  });
};

// the day's gold emails (signal_alerts: bar_time, closed_at, entry)
const EMAILS = [
  { T: "2026-10-09T00:30:00Z", side: "SELL", E: 4142.17 },
  { T: "2026-10-09T06:15:00Z", side: "SELL", E: 4190.63 },
  { T: "2026-10-09T07:15:00Z", side: "SELL", E: 4194.66 },
  { T: "2026-10-09T08:45:00Z", side: "SELL", E: 4190.71 },
] as const;

const JA: Record<string, string> = { up: "上昇", down: "下降", toUp: "上昇の兆し", toDown: "下降の兆し", none: "判定なし" };
const DIR_OF: Record<string, number> = { up: 1, toUp: 1, down: -1, toDown: -1, none: 0 };

// the chart's read at `at`: the stored bars up to `upTo` (their last TWELVE_CHART_BARS), the closed ones
const dowAt = (bars: Bar[], tf: string, at: number, upTo: number) => {
  const stored = bars.filter((b) => b.t < upTo).slice(-TWELVE_CHART_BARS);
  const closed = stored.filter((b) => b.t + STEP[tf] <= at && b.t + STEP[tf] <= upTo);
  const d = dowOf("XAU/USD", tf, closed);
  return { state: d.state as string, n: closed.length, last: closed[closed.length - 1]?.datetime ?? "-" };
};

interface Outcome {
  end: "TP" | "SL" | "open";
  at: string;
  usd: number;
}
// a SELL followed on the 5-minute mids from T: in at E; a bar opening past a level fills at its open;
// a bar reaching both is the stop; not decided: open, valued at the last close
const follow = (f: Bar[], T: number, E: number, tp: number, sl: number): Outcome => {
  const tpAt = E - tp;
  const slAt = E + sl;
  const bars = f.filter((b) => b.t >= T && b.t + STEP["5min"] <= STORED_5);
  for (const b of bars) {
    if (b.open >= slAt) return { end: "SL", at: b.datetime, usd: E - b.open };
    if (b.open <= tpAt) return { end: "TP", at: b.datetime, usd: E - b.open };
    if (b.high >= slAt) return { end: "SL", at: b.datetime, usd: -sl };
    if (b.low <= tpAt) return { end: "TP", at: b.datetime, usd: tp };
  }
  const last = bars[bars.length - 1];
  return { end: "open", at: last.datetime, usd: E - last.close };
};

const main = async () => {
  const b = { "15min": await read("15min"), "1h": await read("1h"), "4h": await read("4h"), "5min": await read("5min") };
  const jst = (s: string) => {
    const d = new Date(Date.parse(`${s.replace(" ", "T")}Z`) + 9 * 3600_000).toISOString();
    return `${d.slice(5, 10)} ${d.slice(11, 16)}`;
  };
  const rows: Array<{ against: Record<string, boolean>; w2: Outcome; w1: Outcome }> = [];
  for (const e of EMAILS) {
    const T = Date.parse(e.T);
    const at = T + MIN;
    const labs: Record<string, string> = {};
    const against: Record<string, boolean> = {};
    for (const tf of ["15min", "1h", "4h"] as const) {
      const a = dowAt(b[tf], tf, at, at);
      labs[tf] = `${JA[a.state]}（${a.n}本、最後 ${a.last}）`;
      against[tf] = DIR_OF[a.state] === 1;
      if (tf === "15min") {
        // B: the stored 15-minute bars from before the email's bar closed
        const bb = dowAt(b[tf], tf, at, T - 14 * MIN);
        labs[tf] += ` / B ${JA[bb.state]}（${bb.n}本、最後 ${bb.last}）`;
      }
    }
    const w2 = follow(b["5min"], T, e.E, 10, 13);
    const w1 = follow(b["5min"], T, e.E, 4, 13);
    rows.push({ against, w2, w1 });
    const out = (o: Outcome) => `${o.end}${o.end === "open" ? " 今" : ` ${jst(o.at)}`} ${o.usd >= 0 ? "+" : ""}${o.usd.toFixed(2)}ドル`;
    console.log(`${jst(e.T.replace("T", " ").slice(0, 19))} 金 ${e.side} E ${e.E} | 15分足 ${labs["15min"]} | 1時間足 ${labs["1h"]} | 4時間足 ${labs["4h"]} | 利確10/損切り13 ${out(w2)} | 利確4/損切り13 ${out(w1)}`);
  }
  const verdicts: Array<[string, (a: Record<string, boolean>) => boolean]> = [
    ["①1H", (a) => a["1h"]],
    ["②4H", (a) => a["4h"]],
    ["③1H+4H", (a) => a["1h"] && a["4h"]],
    ["④15M", (a) => a["15min"]],
  ];
  const sum = (rs: typeof rows, k: "w2" | "w1") => {
    const tp = rs.filter((r) => r[k].end === "TP").length;
    const sl = rs.filter((r) => r[k].end === "SL").length;
    const done = rs.filter((r) => r[k].end !== "open");
    const usd = done.reduce((s, r) => s + r[k].usd, 0);
    return `${rs.length}通: 利確 ${tp}・損切り ${sl}・未決着 ${rs.length - done.length}; 勝率 ${tp + sl ? Math.round((100 * tp) / (tp + sl)) : "-"}%; 決着分 ${usd >= 0 ? "+" : ""}${usd.toFixed(2)}ドル（1回あたり ${done.length ? (usd / done.length).toFixed(2) : "-"}）`;
  };
  console.log(`全部  利確10: ${sum(rows, "w2")}`);
  console.log(`全部  利確4:  ${sum(rows, "w1")}`);
  for (const [name, isOut] of verdicts) {
    const kept = rows.filter((r) => !isOut(r.against));
    console.log(`${name} 残す ${kept.length}・外す ${rows.length - kept.length} | 残す 利確10: ${sum(kept, "w2")} | 残す 利確4: ${sum(kept, "w1")}`);
  }
};

await main();
