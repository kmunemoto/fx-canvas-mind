import { useEffect } from "react";
import { supabase } from "@/lib/supabase";
import { drawingListFrom, isPairKey, type DrawingsByPair } from "@/lib/drawings";
import { getDrawings, replacePairDrawings, subscribeDrawings } from "@/lib/drawingsStore";

// #160: the drawings follow the account, as the chart's settings do (#141),
// so another device, or the home-screen app beside the browser, opens the
// same lines. One row per pair (a pair's drawings as the browser keeps
// them); the row is the user's own (row-level security: read and write only
// by its owner).
//
// On signing in, the account's pairs are taken as this browser's, and a pair
// drawn on here that the account does not have yet is given to it; after
// that every change is written back a moment later, the pairs that changed.
// Without the table — the network down — the drawings stay in this browser.
export const CHART_DRAWINGS_TABLE = "user_chart_drawings";
const WRITE_DELAY_MS = 800;

type Client = Pick<typeof supabase, "from">;

export const useChartDrawingsSync = (userId: string | null | undefined, client: Client = supabase): void => {
  useEffect(() => {
    if (!userId) return;
    let alive = true;
    let ready = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // each pair as the account holds it, as last read or written
    const kept = new Map<string, string>();
    const write = () => {
      const now = getDrawings();
      const rows = Object.entries(now)
        .map(([pair, list]) => ({ pair, json: JSON.stringify(list) }))
        .filter((r) => kept.get(r.pair) !== r.json);
      if (rows.length === 0) return;
      for (const r of rows) kept.set(r.pair, r.json);
      void client
        .from(CHART_DRAWINGS_TABLE)
        .upsert(rows.map((r) => ({ user_id: userId, pair: r.pair, drawings: JSON.parse(r.json), updated_at: new Date().toISOString() })))
        .then(({ error }) => {
          // written again with the next change
          if (error) for (const r of rows) kept.delete(r.pair);
        });
    };
    void client
      .from(CHART_DRAWINGS_TABLE)
      .select("pair, drawings")
      .eq("user_id", userId)
      .then(({ data, error }) => {
        if (!alive || error) return;
        const theirs: DrawingsByPair = {};
        for (const row of (data as Array<{ pair?: unknown; drawings?: unknown }> | null) ?? []) {
          if (isPairKey(row.pair)) theirs[row.pair] = drawingListFrom(row.drawings);
        }
        if (Object.keys(theirs).length > 0) replacePairDrawings(theirs);
        for (const [pair, list] of Object.entries(theirs)) kept.set(pair, JSON.stringify(list));
        // a pair only this browser has, with something drawn, goes to the account
        for (const [pair, list] of Object.entries(getDrawings())) {
          if (!kept.has(pair) && list.length === 0) kept.set(pair, JSON.stringify(list));
        }
        ready = true;
        write();
      });
    const off = subscribeDrawings(() => {
      if (!ready) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(write, WRITE_DELAY_MS);
    });
    return () => {
      alive = false;
      off();
      if (timer) clearTimeout(timer);
    };
  }, [userId, client]);
};
