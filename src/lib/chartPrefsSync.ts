import { useEffect } from "react";
import { supabase } from "@/lib/supabase";
import { getChartPrefs, replaceChartPrefs, storedChartPrefs, subscribeChartPrefs } from "@/lib/chartPrefs";

// #141: the chart's settings follow the account — the indicators, the
// background and the live chart's pair, timeframe and signals — so another
// device, or the home-screen app beside the browser, opens the same chart.
//
// On signing in the account's copy is taken (a first sign-in gives the
// account this browser's); after that every change is written back a
// moment later. The row is the user's own (row-level security: read and
// write only by its owner). Without it — the table missing, the network
// down — the settings stay in this browser as before.
export const CHART_PREFS_TABLE = "user_chart_prefs";
const WRITE_DELAY_MS = 800;

type Client = Pick<typeof supabase, "from">;

export const useChartPrefsSync = (userId: string | null | undefined, client: Client = supabase): void => {
  useEffect(() => {
    if (!userId) return;
    let alive = true;
    let ready = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // what the account holds, as last read or written
    let kept = "";
    const now = () => JSON.stringify(storedChartPrefs(getChartPrefs()));
    const write = () => {
      const prefs = now();
      if (prefs === kept) return;
      kept = prefs;
      void client
        .from(CHART_PREFS_TABLE)
        .upsert({ user_id: userId, prefs: JSON.parse(prefs), updated_at: new Date().toISOString() })
        .then(({ error }) => {
          // written again with the next change
          if (error) kept = "";
        });
    };
    void client
      .from(CHART_PREFS_TABLE)
      .select("prefs")
      .eq("user_id", userId)
      .maybeSingle()
      .then(({ data, error }) => {
        if (!alive || error) return;
        const stored = (data as { prefs?: unknown } | null)?.prefs;
        if (stored && typeof stored === "object") {
          replaceChartPrefs(stored);
          kept = now();
        } else {
          write();
        }
        ready = true;
      });
    const off = subscribeChartPrefs(() => {
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
