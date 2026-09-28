import { describe, it, expect, vi, afterEach } from "vitest";
import { render as rtlRender, renderHook, screen, fireEvent, waitFor, act, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";
import { LocaleProvider } from "@/lib/i18n";

vi.mock("@/lib/supabase", () => ({ supabase: {} }));

import LiveChart from "../components/LiveChart";
import {
  CHART_PREFS_KEY,
  getChartPrefs,
  replaceChartPrefs,
  resetChartPrefsCache,
  setChartPrefs,
} from "../lib/chartPrefs";
import { CHART_PREFS_TABLE, useChartPrefsSync } from "../lib/chartPrefsSync";
import { normalizeLiveRead, type LiveRead } from "../lib/liveChart";
import { liveRead } from "../../supabase/functions/live-chart/logic";
import type { QuoteCandle } from "../../supabase/functions/track-outcomes/quotes";

// the mark saying the stochastic defaults of #133 were in force
const STOCH_DEFAULTS_MARK = 133;

const M15 = 15 * 60_000;
const T0 = Date.parse("2026-09-21T00:00:00Z");

const quotes = (n: number): QuoteCandle[] => {
  const out: QuoteCandle[] = [];
  for (let i = 0; i < n; i++) {
    const o = 150 + Math.sin(i / 7) * 0.4;
    const c = 150 + Math.sin((i + 1) / 7) * 0.4;
    const side = (d: number) => ({
      datetime: new Date(T0 + i * M15).toISOString(),
      open: o + d,
      high: Math.max(o, c) + 0.03 + d,
      low: Math.min(o, c) - 0.03 + d,
      close: c + d,
    });
    out.push({ datetime: new Date(T0 + i * M15).toISOString(), bid: side(-0.002), ask: side(0.002) });
  }
  return out;
};

const readFor = (pair: string, interval: string): LiveRead => {
  const r = normalizeLiveRead(liveRead(pair, interval, quotes(260), T0 + 259 * M15 + 60_000))!;
  return { ...r, pair, interval, nextClose: new Date(Date.now() + 60_000).toISOString() };
};

const render = (ui: ReactElement): RenderResult => rtlRender(<LocaleProvider initial="ja">{ui}</LocaleProvider>);

const stored = () => JSON.parse(localStorage.getItem(CHART_PREFS_KEY) ?? "null");

// A new page load: the preferences read again from storage
const reload = () => resetChartPrefsCache();

const selected = (id: string) => screen.getByTestId(id).getAttribute("aria-selected");

describe("#141 the chart's preferences keep the live chart's pair, timeframe and signals", () => {
  it("stores them with the others and reads them back after a reload", () => {
    setChartPrefs({ rsi: false, theme: "light" });
    setChartPrefs({ live: { pair: "EUR/USD", interval: "1h", view: "rsi_sar" } });
    expect(stored().live).toEqual({ pair: "EUR/USD", interval: "1h", view: "rsi_sar" });
    expect(stored().stochDefaults).toBe(STOCH_DEFAULTS_MARK);
    reload();
    const p = getChartPrefs();
    expect(p.live).toEqual({ pair: "EUR/USD", interval: "1h", view: "rsi_sar" });
    expect(p.rsi).toBe(false);
    expect(p.theme).toBe("light");
  });

  it("reads preferences saved before #141 (no live part) as the chart's defaults, and drops what is not a short name", () => {
    localStorage.setItem(CHART_PREFS_KEY, JSON.stringify({ rsi: false, stochDefaults: STOCH_DEFAULTS_MARK }));
    reload();
    expect(getChartPrefs().live).toEqual({ pair: null, interval: null, view: null });
    expect(getChartPrefs().rsi).toBe(false);
    localStorage.setItem(CHART_PREFS_KEY, JSON.stringify({ live: { pair: 3, interval: "x".repeat(40), view: "" } }));
    reload();
    expect(getChartPrefs().live).toEqual({ pair: null, interval: null, view: null });
  });

  it("takes the account's copy whole, as this browser's", () => {
    setChartPrefs({ rsi: false });
    replaceChartPrefs({ theme: "light", live: { pair: "GBP/JPY", interval: "1day", view: "both" } });
    expect(getChartPrefs().rsi).toBe(true);
    expect(getChartPrefs().theme).toBe("light");
    expect(stored().live).toEqual({ pair: "GBP/JPY", interval: "1day", view: "both" });
    replaceChartPrefs(null);
    expect(getChartPrefs().theme).toBe("dark");
  });
});

describe("#141 the live chart opens where it was left", () => {
  const loaders = () => ({
    loadBars: vi.fn(async (pair: string, interval: string) => readFor(pair, interval)),
    loadTicks: vi.fn(async () => ({})),
  });

  it("keeps the pair, timeframe and signals chosen, and opens with them next time", async () => {
    const a = loaders();
    const first = render(<LiveChart loadBars={a.loadBars} loadTicks={a.loadTicks} />);
    await waitFor(() => expect(a.loadBars).toHaveBeenCalledWith("USD/JPY", "4h"));
    // nothing chosen yet: nothing kept
    expect(stored()).toBeNull();
    fireEvent.click(screen.getByTestId("live-pair-EUR/USD"));
    fireEvent.click(screen.getByTestId("live-interval-1h"));
    fireEvent.click(screen.getByTestId("live-view-rsi_sar"));
    expect(stored().live).toEqual({ pair: "EUR/USD", interval: "1h", view: "rsi_sar" });
    first.unmount();

    reload();
    const b = loaders();
    render(<LiveChart loadBars={b.loadBars} loadTicks={b.loadTicks} />);
    await waitFor(() => expect(b.loadBars).toHaveBeenCalled());
    expect(b.loadBars.mock.calls[0]).toEqual(["EUR/USD", "1h"]);
    expect(selected("live-pair-EUR/USD")).toBe("true");
    expect(selected("live-interval-1h")).toBe("true");
    expect(selected("live-view-rsi_sar")).toBe("true");
  });

  it("uses a saved choice only if the chart still offers it", async () => {
    // #146: gold's 1-minute chart is offered now
    setChartPrefs({ live: { pair: "XAU/USD", interval: "1min", view: "gainz" } });
    reload();
    const g = loaders();
    const gold = render(<LiveChart loadBars={g.loadBars} loadTicks={g.loadTicks} />);
    await waitFor(() => expect(g.loadBars).toHaveBeenCalled());
    expect(g.loadBars.mock.calls[0]).toEqual(["XAU/USD", "1min"]);
    gold.unmount();

    // a timeframe the chart does not offer falls back
    setChartPrefs({ live: { pair: "XAU/USD", interval: "3min", view: "gainz" } });
    reload();
    const a = loaders();
    const first = render(<LiveChart loadBars={a.loadBars} loadTicks={a.loadTicks} />);
    await waitFor(() => expect(a.loadBars).toHaveBeenCalled());
    expect(a.loadBars.mock.calls[0]).toEqual(["XAU/USD", "4h"]);
    first.unmount();

    setChartPrefs({ live: { pair: "ZZZ/YYY", interval: "2h", view: "magic" } });
    reload();
    const b = loaders();
    render(<LiveChart loadBars={b.loadBars} loadTicks={b.loadTicks} />);
    await waitFor(() => expect(b.loadBars).toHaveBeenCalled());
    expect(b.loadBars.mock.calls[0]).toEqual(["USD/JPY", "4h"]);
    expect(selected("live-view-gainz")).toBe("true");
  });

  it("#146: switching to gold keeps the 1- or 5-minute timeframe (every pair has them now)", async () => {
    const a = loaders();
    render(<LiveChart loadBars={a.loadBars} loadTicks={a.loadTicks} />);
    fireEvent.click(screen.getByTestId("live-interval-5min"));
    fireEvent.click(screen.getByTestId("live-pair-XAU/USD"));
    await waitFor(() => expect(a.loadBars).toHaveBeenCalledWith("XAU/USD", "5min"));
    expect(stored().live).toMatchObject({ pair: "XAU/USD", interval: "5min" });
    fireEvent.click(screen.getByTestId("live-interval-1min"));
    await waitFor(() => expect(a.loadBars).toHaveBeenCalledWith("XAU/USD", "1min"));
    expect(stored().live).toMatchObject({ pair: "XAU/USD", interval: "1min" });
  });

  it("a timeframe the page asks for comes first, and is not kept until something is chosen", async () => {
    setChartPrefs({ live: { pair: "GBP/USD", interval: "1day", view: "both" } });
    reload();
    const a = loaders();
    render(<LiveChart defaultInterval="15min" loadBars={a.loadBars} loadTicks={a.loadTicks} />);
    await waitFor(() => expect(a.loadBars).toHaveBeenCalled());
    expect(a.loadBars.mock.calls[0]).toEqual(["GBP/USD", "15min"]);
    expect(stored().live.interval).toBe("1day");
    // another preference changing does not move the chart
    act(() => setChartPrefs({ rsi: false }));
    expect(selected("live-interval-15min")).toBe("true");
  });

  it("moves to the account's choice when it arrives after the chart opened", async () => {
    const a = loaders();
    render(<LiveChart loadBars={a.loadBars} loadTicks={a.loadTicks} />);
    await waitFor(() => expect(a.loadBars).toHaveBeenCalledWith("USD/JPY", "4h"));
    act(() => replaceChartPrefs({ live: { pair: "GBP/JPY", interval: "1h", view: "both" } }));
    await waitFor(() => expect(a.loadBars).toHaveBeenCalledWith("GBP/JPY", "1h"));
    expect(selected("live-view-both")).toBe("true");
  });
});

// A stand-in for the Supabase client: the one row, and every write to it
const fakeClient = (row: { prefs: unknown } | null, readError: unknown = null) => {
  const upserts: Array<Record<string, unknown>> = [];
  const selects: string[] = [];
  const client = {
    from: (table: string) => {
      expect(table).toBe(CHART_PREFS_TABLE);
      return {
        select: () => ({
          eq: (_col: string, id: string) => ({
            maybeSingle: async () => {
              selects.push(id);
              return { data: row, error: readError };
            },
          }),
        }),
        upsert: async (v: Record<string, unknown>) => {
          upserts.push(v);
          return { data: null, error: null };
        },
      };
    },
  };
  return { client: client as unknown as Parameters<typeof useChartPrefsSync>[1], upserts, selects };
};

const settle = async (ms = 0) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

describe("#141 the chart's preferences follow the account", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("takes the account's copy on signing in, and writes nothing back for it", async () => {
    vi.useFakeTimers();
    setChartPrefs({ theme: "dark" });
    const f = fakeClient({ prefs: { theme: "light", live: { pair: "EUR/JPY", interval: "1h", view: "gainz" } } });
    renderHook(() => useChartPrefsSync("user-1", f.client));
    await settle();
    expect(f.selects).toEqual(["user-1"]);
    expect(getChartPrefs().theme).toBe("light");
    expect(getChartPrefs().live.pair).toBe("EUR/JPY");
    await settle(2_000);
    expect(f.upserts).toHaveLength(0);
  });

  it("gives an account with none this browser's", async () => {
    vi.useFakeTimers();
    setChartPrefs({ rsi: false, live: { pair: "GBP/USD", interval: "4h", view: "both" } });
    const f = fakeClient(null);
    renderHook(() => useChartPrefsSync("user-1", f.client));
    await settle();
    expect(f.upserts).toHaveLength(1);
    expect(f.upserts[0].user_id).toBe("user-1");
    expect(f.upserts[0].prefs).toMatchObject({ rsi: false, stochDefaults: STOCH_DEFAULTS_MARK, live: { pair: "GBP/USD" } });
  });

  it("writes the changes back a moment later, once for a quick run of them", async () => {
    vi.useFakeTimers();
    const f = fakeClient({ prefs: { theme: "dark" } });
    renderHook(() => useChartPrefsSync("user-1", f.client));
    await settle();
    act(() => setChartPrefs({ rsi: false }));
    act(() => setChartPrefs({ live: { pair: "EUR/USD", interval: "1h", view: "gainz" } }));
    await settle(300);
    expect(f.upserts).toHaveLength(0);
    await settle(1_000);
    expect(f.upserts).toHaveLength(1);
    expect(f.upserts[0].prefs).toMatchObject({ rsi: false, live: { pair: "EUR/USD", interval: "1h", view: "gainz" } });
    // the same again is not written
    act(() => setChartPrefs({ rsi: false }));
    await settle(1_000);
    expect(f.upserts).toHaveLength(1);
  });

  it("keeps this browser's when the account cannot be read, without writing over it", async () => {
    vi.useFakeTimers();
    setChartPrefs({ theme: "light" });
    const f = fakeClient(null, { message: "relation does not exist" });
    renderHook(() => useChartPrefsSync("user-1", f.client));
    await settle();
    act(() => setChartPrefs({ rsi: false }));
    await settle(2_000);
    expect(getChartPrefs().theme).toBe("light");
    expect(f.upserts).toHaveLength(0);
  });

  it("does nothing signed out, and stops on signing out", async () => {
    vi.useFakeTimers();
    const none = fakeClient(null);
    renderHook(() => useChartPrefsSync(undefined, none.client));
    await settle();
    expect(none.selects).toHaveLength(0);

    const f = fakeClient({ prefs: {} });
    const { rerender } = renderHook(({ id }) => useChartPrefsSync(id, f.client), { initialProps: { id: "user-1" as string | undefined } });
    await settle();
    act(() => setChartPrefs({ rsi: false }));
    rerender({ id: undefined });
    await settle(2_000);
    expect(f.upserts).toHaveLength(0);
  });
});
