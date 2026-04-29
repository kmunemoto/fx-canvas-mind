const env: Record<string, string> = {};
const envText = await Deno.readTextFile("./scripts/.env.x");
for (const line of envText.split("\n")) {
  const idx = line.indexOf("=");
  if (idx > 0) env[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
}

const SUPABASE_URL = env.SUPABASE_URL;
const SUPABASE_ANON_KEY = env.SUPABASE_ANON_KEY;
const ADMIN_EMAIL = env.ADMIN_EMAIL;
const ADMIN_PASSWORD = env.ADMIN_PASSWORD;
const CONSUMER_KEY = env.X_CONSUMER_KEY;
const CONSUMER_SECRET = env.X_CONSUMER_SECRET;
const ACCESS_TOKEN = env.X_ACCESS_TOKEN;
const ACCESS_TOKEN_SECRET = env.X_ACCESS_TOKEN_SECRET;

function percentEncode(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, c => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

async function hmacSha1(key: string, data: string): Promise<string> {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(data)));
  return btoa(String.fromCharCode(...sig));
}

async function oauthHeader(method: string, url: string): Promise<string> {
  const op: Record<string, string> = {
    oauth_consumer_key: CONSUMER_KEY,
    oauth_nonce: crypto.randomUUID().replace(/-/g, ""),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: ACCESS_TOKEN,
    oauth_version: "1.0",
  };
  const sorted = Object.keys(op).sort().map(k => `${percentEncode(k)}=${percentEncode(op[k])}`).join("&");
  const base = `${method}&${percentEncode(url)}&${percentEncode(sorted)}`;
  const sigKey = `${percentEncode(CONSUMER_SECRET)}&${percentEncode(ACCESS_TOKEN_SECRET)}`;
  op.oauth_signature = await hmacSha1(sigKey, base);
  return "OAuth " + Object.keys(op).sort().map(k => `${percentEncode(k)}="${percentEncode(op[k])}"`).join(", ");
}

async function getAuthToken(): Promise<string> {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "apikey": SUPABASE_ANON_KEY },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  const d = await res.json();
  if (!d.access_token) throw new Error("Login failed: " + JSON.stringify(d));
  return d.access_token;
}

async function runAnalysis(token: string) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}`, "apikey": SUPABASE_ANON_KEY },
    body: JSON.stringify({ currencyPair: "USD/JPY", interval: "1h", includeFundamental: true }),
  });
  return await res.json();
}

function makeTweet(a: any): string {
  const now = new Date();
  const d = `${now.getFullYear()}/${(now.getMonth()+1).toString().padStart(2,"0")}/${now.getDate().toString().padStart(2,"0")}`;
  const t = `${now.getHours().toString().padStart(2,"0")}:${now.getMinutes().toString().padStart(2,"0")}`;
  const sig = a.signal || "WAIT";
  const conf = a.confidence || 0;
  const sent = a.sentiment === "BULLISH" ? "強気" : a.sentiment === "BEARISH" ? "弱気" : "中立";
  const emoji = sig === "BUY" ? "🟢" : sig === "SELL" ? "🔴" : "🟡";
  let txt = `${emoji} ${d} ${t} USD/JPY AI分析\n\n📊 ${sig} | 確信度 ${conf}% | ${sent}\n`;
  if (a.entry_point && a.entry_point !== "-") txt += `🎯 Entry: ${a.entry_point}\n`;
  if (a.stop_loss && a.stop_loss !== "-") txt += `🛡️ SL: ${a.stop_loss}\n`;
  if (a.take_profit_1 && a.take_profit_1 !== "-") txt += `💰 TP: ${a.take_profit_1}\n`;
  txt += `\n#FX #ドル円 #USDJPY #AI分析\n🔗 fx-tactical.jp`;
  return txt;
}

async function postTweet(text: string) {
  const url = "https://api.x.com/2/tweets";
  const auth = await oauthHeader("POST", url);
  const res = await fetch(url, {
    method: "POST",
    headers: { "Authorization": auth, "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  return await res.json();
}

console.log("🚀 自動投稿開始...");
const token = await getAuthToken();
console.log("✅ ログイン成功");
const analysis = await runAnalysis(token);
console.log("✅ 分析完了:", analysis.signal, analysis.confidence + "%");
const tweet = makeTweet(analysis);
console.log("📝 投稿内容:\n" + tweet);
const result = await postTweet(tweet);
console.log("✅ 投稿結果:", JSON.stringify(result));
