// track-outcomes — evaluates the caller's open trade plans against price
// history and marks them win / loss / expired.
//
// A BUY wins when a later candle's high reaches TP1 before any candle's low
// reaches SL (mirrored for SELL). A candle that spans both levels is
// ambiguous, so the row is left open rather than guessed. Plans older than
// the lookback window without a decision expire.

import { parseCandles, type Candle } from "../analyze/indicators.ts";
import { evaluatePlan, EVAL_INTERVAL, EXPIRY_DAYS, type OpenRow } from "./evaluate.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return json({ ok: false, error: "認証が必要です" }, 401);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const twelveDataKey = Deno.env.get("TWELVE_DATA_API_KEY");

    if (!supabaseUrl || !supabaseAnonKey || !serviceRoleKey || !twelveDataKey) {
      return json({ ok: false, error: "サーバー設定エラー" }, 500);
    }

    const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { Authorization: authHeader, apikey: supabaseAnonKey },
    });
    if (!userRes.ok) {
      return json({ ok: false, error: "認証に失敗しました" }, 401);
    }
    const userData = await userRes.json();
    const userId = isRecord(userData) && typeof userData.id === "string" ? userData.id : null;
    if (!userId) {
      return json({ ok: false, error: "認証に失敗しました" }, 401);
    }

    const serviceHeaders = {
      Authorization: `Bearer ${serviceRoleKey}`,
      apikey: serviceRoleKey,
      "Content-Type": "application/json",
    };

    // Per-user cooldown. Each call can trigger several market-data fetches
    // against a shared API key, so a loop from one account would starve
    // everyone else's analyses.
    const COOLDOWN_MS = 5 * 60 * 1000;
    const trackedRes = await fetch(
      `${supabaseUrl}/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=last_tracked_at`,
      { headers: { ...serviceHeaders, Accept: "application/vnd.pgrst.object+json" } },
    );
    if (trackedRes.ok) {
      const trackedRaw = await trackedRes.json().catch(() => null);
      const lastTracked = isRecord(trackedRaw) && typeof trackedRaw.last_tracked_at === "string"
        ? Date.parse(trackedRaw.last_tracked_at)
        : NaN;
      if (Number.isFinite(lastTracked) && Date.now() - lastTracked < COOLDOWN_MS) {
        return json({ ok: true, updated: 0, skipped: "cooldown" });
      }
    }

    await fetch(`${supabaseUrl}/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}`, {
      method: "PATCH",
      headers: { ...serviceHeaders, Prefer: "return=minimal" },
      body: JSON.stringify({ last_tracked_at: new Date().toISOString() }),
    }).then((r) => r.text()).catch(() => {});

    // Open plans, oldest first, ignoring anything analyzed in the last 5
    // minutes (its first candle may not even have closed yet)
    const cutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const listRes = await fetch(
      `${supabaseUrl}/rest/v1/analyses?user_id=eq.${encodeURIComponent(userId)}&outcome=eq.pending&created_at=lt.${encodeURIComponent(cutoff)}&select=id,pair,interval,signal,entry_point,stop_loss,take_profit_1,created_at&order=created_at.asc&limit=20`,
      { headers: serviceHeaders },
    );
    if (!listRes.ok) {
      return json({ ok: false, error: "履歴の取得に失敗しました" }, 500);
    }

    const rowsRaw = await listRes.json();
    const rows: OpenRow[] = [];
    if (Array.isArray(rowsRaw)) {
      for (const r of rowsRaw) {
        if (!isRecord(r)) continue;
        if (r.signal !== "BUY" && r.signal !== "SELL") continue;
        const entry = Number(r.entry_point);
        const sl = Number(r.stop_loss);
        const tp1 = Number(r.take_profit_1);
        if (![entry, sl, tp1].every(Number.isFinite)) continue;
        rows.push({
          id: String(r.id),
          pair: String(r.pair),
          interval: String(r.interval),
          signal: r.signal,
          entry_point: entry,
          stop_loss: sl,
          take_profit_1: tp1,
          created_at: String(r.created_at),
        });
      }
    }

    if (rows.length === 0) {
      return json({ ok: true, updated: 0 });
    }

    // One price fetch per pair+interval, capped to stay inside the market
    // data API's per-minute credit budget
    const groups = new Map<string, OpenRow[]>();
    for (const row of rows) {
      const key = `${row.pair}|${EVAL_INTERVAL[row.interval] || "1h"}`;
      const list = groups.get(key) ?? [];
      list.push(row);
      groups.set(key, list);
    }

    let updated = 0;
    let groupCount = 0;

    for (const [key, groupRows] of groups) {
      if (groupCount >= 4) break;
      groupCount++;

      const [pair, evalInterval] = key.split("|");
      let candles: Candle[] = [];
      try {
        const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(pair)}&interval=${encodeURIComponent(evalInterval)}&outputsize=500&apikey=${twelveDataKey}`;
        const res = await fetch(url);
        const parsed = await res.json();
        if (!res.ok || !isRecord(parsed) || parsed.status === "error") continue;
        candles = parseCandles(parsed.values);
      } catch {
        continue;
      }
      if (candles.length === 0) continue;

      for (const row of groupRows) {
        const verdict = evaluatePlan(row, candles);
        const ageDays = (Date.now() - Date.parse(row.created_at)) / 86_400_000;
        const expiryDays = EXPIRY_DAYS[row.interval] ?? 30;

        let patch: JsonRecord | null = null;
        if (verdict) {
          patch = {
            outcome: verdict.outcome,
            outcome_price: verdict.price,
            closed_at: new Date().toISOString(),
          };
        } else if (ageDays > expiryDays) {
          patch = { outcome: "expired", closed_at: new Date().toISOString() };
        }

        if (!patch) continue;

        const updateRes = await fetch(
          `${supabaseUrl}/rest/v1/analyses?id=eq.${encodeURIComponent(row.id)}&outcome=eq.pending`,
          {
            method: "PATCH",
            headers: { ...serviceHeaders, Prefer: "return=minimal" },
            body: JSON.stringify(patch),
          },
        );
        if (updateRes.ok) updated++;
        await updateRes.text();
      }
    }

    return json({ ok: true, updated });
  } catch (err) {
    console.error("track-outcomes error:", err);
    return json({ ok: false, error: "サーバーエラーが発生しました" }, 500);
  }
});
