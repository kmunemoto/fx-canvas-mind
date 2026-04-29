const env: Record<string, string> = {};
const t = await Deno.readTextFile("./scripts/.env.x");
for (const l of t.split("\n")) { const i = l.indexOf("="); if (i > 0) env[l.slice(0,i).trim()] = l.slice(i+1).trim(); }
const r1 = await fetch(`${env.SUPABASE_URL}/auth/v1/token?grant_type=password`, {
  method: "POST", headers: { "Content-Type": "application/json", "apikey": env.SUPABASE_ANON_KEY },
  body: JSON.stringify({ email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD }),
});
const auth = await r1.json();
const r2 = await fetch(`${env.SUPABASE_URL}/functions/v1/analyze`, {
  method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${auth.access_token}`, "apikey": env.SUPABASE_ANON_KEY },
  body: JSON.stringify({ currencyPair: "USD/JPY", interval: "1h", includeFundamental: false }),
});
const data = await r2.json();
console.log(JSON.stringify(data, null, 2));
