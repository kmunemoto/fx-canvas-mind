// The one-off scan's summary (README.md): reads list.py's list and scan.ts's results and writes a Markdown summary:
// what was read, the last session's entries (SELL first) and the shares at 96% or more of the pane's end at the last
// closed bar. No price is in it (the results hold none).
//
//   deno run --allow-read --allow-write=<dir> research/allstocks-scan/report.ts <dir>/symbols.json <dir>/results.jsonl <dir>/report.md

const [listPath, resPath, outPath] = Deno.args;
if (!listPath || !resPath || !outPath) throw new Error("usage: report.ts <symbols.json> <results.jsonl> <report.md>");

interface Item { symbol: string; market: "us" | "jp"; name: string; kind: string }
interface Line {
  symbol: string;
  status: string;
  day?: string | null;
  closedBars?: number;
  sessionBars?: number;
  shortBars?: number;
  signals?: { open: string; side: "BUY" | "SELL" }[];
  zone?: { side: "BUY" | "SELL" | null; share: number | null } | null;
}

const list: Item[] = JSON.parse(await Deno.readTextFile(listPath));
const byId = new Map(list.map((x) => [x.symbol, x]));
const lines: Line[] = (await Deno.readTextFile(resPath)).split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));

const jst = (iso: string) => {
  const d = new Date(Date.parse(iso) + 9 * 3_600_000);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
};
const ny = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false });
const when = (sym: string, iso: string) => (byId.get(sym)?.market === "us" ? `${jst(iso)} 日本時間（NY ${ny.format(new Date(iso))}）` : `${jst(iso)} 日本時間`);
const label = (sym: string) => `${sym} ${byId.get(sym)?.name ?? ""}`.trim();

const out: string[] = [];
const count = (f: (l: Line) => boolean) => lines.filter(f).length;
for (const market of ["us", "jp"] as const) {
  const mine = lines.filter((l) => byId.get(l.symbol)?.market === market);
  const listed = list.filter((x) => x.market === market).length;
  const st = new Map<string, number>();
  for (const l of mine) st.set(l.status, (st.get(l.status) ?? 0) + 1);
  const days = new Map<string, number>();
  for (const l of mine) if (l.status === "ok") days.set(l.day ?? "-", (days.get(l.day ?? "-") ?? 0) + 1);
  out.push(`## ${market === "us" ? "米国" : "東証"}`);
  out.push(`- 一覧 ${listed}、読んだ ${mine.length}（読めていない ${listed - mine.length}）`);
  out.push(`- 結果: ${[...st].map(([k, n]) => `${k} ${n}`).join("、")}`);
  out.push(`- 最後の取引日: ${[...days].sort().reverse().map(([d, n]) => `${d} ${n}`).join("、")}`);
  out.push(`- 600本に足りず判定できなかった株: ${count((l) => byId.get(l.symbol)?.market === market && l.status === "ok" && (l.sessionBars ?? 0) > 0 && l.shortBars === l.sessionBars)}`);
  out.push("");
}

const withSide = (side: "BUY" | "SELL") =>
  lines
    .filter((l) => l.status === "ok" && (l.signals ?? []).some((s) => s.side === side))
    .map((l) => ({ l, at: (l.signals ?? []).filter((s) => s.side === side).map((s) => s.open) }))
    .sort((a, b) => (a.at.at(-1)! < b.at.at(-1)! ? 1 : -1));
for (const side of ["SELL", "BUY"] as const) {
  const rows = withSide(side);
  out.push(`## 最後の取引日に出た${side === "SELL" ? "売り" : "買い"}の合図（${rows.length}銘柄。新しい順）`);
  for (const { l, at } of rows) out.push(`- ${label(l.symbol)}: ${at.map((t) => when(l.symbol, t)).join("、")} の足（最後の取引日 ${l.day}）`);
  out.push("");
}
for (const side of ["SELL", "BUY"] as const) {
  const rows = lines.filter((l) => l.status === "ok" && l.zone?.side === side).sort((a, b) => (b.zone!.share ?? 0) - (a.zone!.share ?? 0));
  out.push(`## 最後に確定した足で、青い線が${side === "SELL" ? "上" : "下"}の端の96%以上にいる株（${rows.length}銘柄）`);
  for (const l of rows) out.push(`- ${label(l.symbol)}（${l.day}、端の${Math.round((l.zone!.share ?? 0) * 1000) / 10}%）`);
  out.push("");
}
await Deno.writeTextFile(outPath, out.join("\n"));
console.log(`wrote ${outPath}: ${lines.length} results; SELL entries ${withSide("SELL").length} shares, BUY entries ${withSide("BUY").length} shares`);
