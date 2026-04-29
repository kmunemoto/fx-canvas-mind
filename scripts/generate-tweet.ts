const env: Record<string, string> = {};
const envText = await Deno.readTextFile("./scripts/.env.x");
for (const line of envText.split("\n")) {
  const idx = line.indexOf("=");
  if (idx > 0) env[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
}

const res1 = await fetch(`${env.SUPABASE_URL}/auth/v1/token?grant_type=password`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "apikey": env.SUPABASE_ANON_KEY },
  body: JSON.stringify({ email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD }),
});
const auth = await res1.json();

console.log("📊 分析実行中...");
const res2 = await fetch(`${env.SUPABASE_URL}/functions/v1/analyze`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "Authorization": `Bearer ${auth.access_token}`, "apikey": env.SUPABASE_ANON_KEY },
  body: JSON.stringify({ currencyPair: "USD/JPY", interval: "1h", includeFundamental: true }),
});
const a = await res2.json();

const now = new Date();
const d = `${now.getFullYear()}/${(now.getMonth()+1).toString().padStart(2,"0")}/${now.getDate().toString().padStart(2,"0")}`;
const t = `${now.getHours().toString().padStart(2,"0")}:${now.getMinutes().toString().padStart(2,"0")}`;
const sig = a.signal || a.result?.signal || "WAIT";
const conf = a.confidence || a.result?.confidence || 0;
const sent = (a.sentiment || a.result?.sentiment) === "BULLISH" ? "強気" : (a.sentiment || a.result?.sentiment) === "BEARISH" ? "弱気" : "中立";
const emoji = sig === "BUY" ? "🟢" : sig === "SELL" ? "🔴" : "🟡";
const ep = a.entry_point || a.result?.entry_point || "";
const sl = a.stop_loss || a.result?.stop_loss || "";
const tp = a.take_profit_1 || a.result?.take_profit_1 || "";

let txt = `${emoji} ${d} ${t} USD/JPY AI分析\n\n📊 ${sig} | 確信度 ${conf}% | ${sent}\n`;
if (ep && ep !== "-") txt += `🎯 Entry: ${ep}\n`;
if (sl && sl !== "-") txt += `🛡️ SL: ${sl}\n`;
if (tp && tp !== "-") txt += `💰 TP: ${tp}\n`;
txt += `\n🤖 AIがテクニカル+ファンダメンタルを統合分析\n\n#FX #ドル円 #USDJPY #AI分析\n🔗 fx-tactical.jp`;

console.log("\n========= 以下をXにコピペ =========\n");
console.log(txt);
console.log("\n====================================");
