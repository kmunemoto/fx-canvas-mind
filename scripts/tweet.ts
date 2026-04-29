const env: Record<string, string> = {};
const t = await Deno.readTextFile("./scripts/.env.x");
for (const l of t.split("\n")) { const i = l.indexOf("="); if (i > 0) env[l.slice(0,i).trim()] = l.slice(i+1).trim(); }
const r1 = await fetch(`${env.SUPABASE_URL}/auth/v1/token?grant_type=password`, {
  method: "POST", headers: { "Content-Type": "application/json", "apikey": env.SUPABASE_ANON_KEY },
  body: JSON.stringify({ email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD }),
});
const auth = await r1.json();
console.log("📊 分析実行中...(20秒ほどかかります)");
const r2 = await fetch(`${env.SUPABASE_URL}/functions/v1/analyze`, {
  method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${auth.access_token}`, "apikey": env.SUPABASE_ANON_KEY },
  body: JSON.stringify({ currencyPair: "USD/JPY", interval: "1h", includeFundamental: true }),
});
const raw = await r2.json();
const a = raw.data?.analysis || {};
const now = new Date();
const d = `${now.getFullYear()}/${(now.getMonth()+1).toString().padStart(2,"0")}/${now.getDate().toString().padStart(2,"0")}`;
const t2 = `${now.getHours().toString().padStart(2,"0")}:${now.getMinutes().toString().padStart(2,"0")}`;
const sig = a.signal || "WAIT";
const conf = a.confidence || 0;
const sent = a.sentiment === "BULLISH" ? "強気" : a.sentiment === "BEARISH" ? "弱気" : "中立";
const emoji = sig === "BUY" ? "🟢" : sig === "SELL" ? "🔴" : "🟡";
let txt = `${emoji} ${d} ${t2} USD/JPY AI分析\n\n📊 ${sig} | 確信度 ${conf}% | ${sent}\n`;
if (a.entry_point && a.entry_point !== "-") txt += `🎯 Entry: ${a.entry_point}\n`;
if (a.stop_loss && a.stop_loss !== "-") txt += `🛡️ SL: ${a.stop_loss}\n`;
if (a.take_profit_1 && a.take_profit_1 !== "-") txt += `💰 TP1: ${a.take_profit_1}\n`;
if (a.take_profit_2 && a.take_profit_2 !== "-") txt += `💰 TP2: ${a.take_profit_2}\n`;
if (a.risk_reward_ratio) txt += `⚖️ RR: ${a.risk_reward_ratio}\n`;
txt += `\n🤖 AIがテクニカル+ファンダメンタルを統合分析\n\n#FX #ドル円 #USDJPY #AI分析\n🔗 fx-tactical.jp`;
console.log("\n========= 以下をXにコピペ =========\n");
console.log(txt);
console.log("\n====================================");
