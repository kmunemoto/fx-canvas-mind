import { useState, useEffect, useCallback } from "react";
import { Zap, Crown, X } from "lucide-react";
import Header from "@/components/Header";
import ControlBar from "@/components/ControlBar";
import AnalysisResultView from "@/components/AnalysisResultView";
import AnalysisStages from "@/components/AnalysisStages";
import TechnicalDataCard from "@/components/TechnicalDataCard";
import AnalysisHistory from "@/components/AnalysisHistory";
import LearnedRules from "@/components/LearnedRules";
import LoopHealth from "@/components/LoopHealth";
import SettingsDrawer from "@/components/SettingsDrawer";
import { supabase } from "@/lib/supabase";
import { isAdminEmail } from "@/lib/admin";
import { useAuth } from "@/contexts/AuthContext";
import type {
  AnalysisRecord,
  Rulebook,
  AnalysisResult,
  AppSettings,
  LoadingStage,
  NumericCandle,
  TechnicalData,
  TimeInterval,
  LoopHealth as LoopHealthData,
} from "@/lib/types";
import { useToast } from "@/hooks/use-toast";
import { useLocale } from "@/lib/i18n";
import { useNavigate } from "react-router-dom";

const SUPABASE_URL = "https://endcqzewujdvimdlazhj.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_O6jJsLFQ9zArYsenDxIHGQ_bJdkOm2I";
const EXPECTED_ANALYZE_VERSION = "analyze-v22-2026-09-03T21:00:00Z";
const UPGRADE_BANNER_DISMISS_KEY = "fx-upgrade-banner-dismissed";

const toStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  const items: string[] = [];
  for (const item of value) {
    if (typeof item === "string") items.push(item);
    else if (typeof item === "number" && Number.isFinite(item)) items.push(String(item));
  }
  return items;
};

const toRecordArray = <T extends object>(value: unknown): T[] => {
  if (!Array.isArray(value)) return [];
  const items: T[] = [];
  for (const item of value) {
    if (item && typeof item === "object") items.push(item as T);
  }
  return items;
};

const normalizeAnalysisResult = (value: unknown): AnalysisResult | null => {
  if (!value || typeof value !== "object") return null;

  const source = value as Partial<AnalysisResult> & Record<string, unknown>;

  const detail = source.market_context_detail && typeof source.market_context_detail === "object"
    ? source.market_context_detail as AnalysisResult["market_context_detail"]
    : null;

  return {
    signal: source.signal === "BUY" || source.signal === "SELL" || source.signal === "WAIT" ? source.signal : "WAIT",
    thesis: typeof source.thesis === "string" ? source.thesis : undefined,
    confidence: typeof source.confidence === "number" ? source.confidence : 0,
    technical_score: typeof source.technical_score === "number" ? source.technical_score : 0,
    fundamental_score: typeof source.fundamental_score === "number" ? source.fundamental_score : 0,
    risk_level: source.risk_level === "LOW" || source.risk_level === "MEDIUM" || source.risk_level === "HIGH" ? source.risk_level : "MEDIUM",
    sentiment: source.sentiment === "BULLISH" || source.sentiment === "NEUTRAL" || source.sentiment === "BEARISH" ? source.sentiment : "NEUTRAL",
    entry_point: typeof source.entry_point === "string" ? source.entry_point : "—",
    stop_loss: typeof source.stop_loss === "string" ? source.stop_loss : "—",
    take_profit_1: typeof source.take_profit_1 === "string" ? source.take_profit_1 : "—",
    take_profit_2: typeof source.take_profit_2 === "string" ? source.take_profit_2 : "—",
    take_profit_3: typeof source.take_profit_3 === "string" ? source.take_profit_3 : undefined,
    risk_reward_ratio: typeof source.risk_reward_ratio === "string" ? source.risk_reward_ratio : "—",
    analysis: typeof source.analysis === "string" ? source.analysis : "",
    key_factors: toStringArray(source.key_factors),
    warnings: toStringArray(source.warnings),
    support_levels: toStringArray(source.support_levels),
    resistance_levels: toStringArray(source.resistance_levels),
    market_context: typeof source.market_context === "string" ? source.market_context : "",
    market_context_detail: detail,
    stop_hunt_zone: typeof source.stop_hunt_zone === "string" ? source.stop_hunt_zone : undefined,
    timeframe_alignment: toRecordArray(source.timeframe_alignment),
  };
};

const normalizeCandles = (value: unknown): NumericCandle[] => {
  if (!Array.isArray(value)) return [];
  const out: NumericCandle[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const c = item as Record<string, unknown>;
    const open = Number(c.open);
    const high = Number(c.high);
    const low = Number(c.low);
    const close = Number(c.close);
    if (![open, high, low, close].every(Number.isFinite)) continue;
    out.push({
      datetime: typeof c.datetime === "string" ? c.datetime : "",
      open, high, low, close,
    });
  }
  return out;
};

const normalizeTechnicalData = (value: unknown): TechnicalData | null => {
  if (!value || typeof value !== "object") return null;

  const source = value as Partial<TechnicalData> & Record<string, unknown>;
  const readString = (field: keyof TechnicalData) => typeof source[field] === "string" ? String(source[field]) : "—";

  return {
    price: readString("price"),
    datetime: readString("datetime"),
    timeSeries: toRecordArray<TechnicalData["timeSeries"][number]>(source.timeSeries),
    rsi: readString("rsi"),
    macd: readString("macd"),
    macdSignal: readString("macdSignal"),
    macdHist: readString("macdHist"),
    bbUpper: readString("bbUpper"),
    bbMiddle: readString("bbMiddle"),
    bbLower: readString("bbLower"),
    sma20: readString("sma20"),
    sma50: readString("sma50"),
    sma200: readString("sma200"),
    tenkan: readString("tenkan"),
    kijun: readString("kijun"),
    spanA: readString("spanA"),
    spanB: readString("spanB"),
    atr: readString("atr"),
    slowK: readString("slowK"),
    slowD: readString("slowD"),
    adx: readString("adx"),
    candles: normalizeCandles(source.candles),
  };
};

const DEFAULT_SETTINGS: AppSettings = {
  accountBalance: 1_000_000,
  riskPercent: 1,
  currencyPair: "USD/JPY",
};

// Settings saved before the pips fields were removed are still in the
// browser; keep the pair and fill in the rest rather than resetting it
const withDefaults = (stored: unknown): AppSettings => {
  const s = stored && typeof stored === "object" ? stored as Partial<AppSettings> : {};
  const num = (v: unknown, fallback: number) =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fallback;
  return {
    accountBalance: num(s.accountBalance, DEFAULT_SETTINGS.accountBalance),
    riskPercent: num(s.riskPercent, DEFAULT_SETTINGS.riskPercent),
    currencyPair: typeof s.currencyPair === "string" && s.currencyPair ? s.currencyPair : DEFAULT_SETTINGS.currencyPair,
  };
};

const loadSettings = (): AppSettings => {
  try {
    const stored = localStorage.getItem("fx-settings-v2");
    if (stored) return withDefaults(JSON.parse(stored));
  } catch {}
  try {
    const stored = sessionStorage.getItem("fx-settings-v2");
    if (stored) return withDefaults(JSON.parse(stored));
  } catch {}
  return DEFAULT_SETTINGS;
};

const saveSettings = (s: AppSettings) => {
  const json = JSON.stringify(s);
  try { localStorage.setItem("fx-settings-v2", json); } catch {}
  try { sessionStorage.setItem("fx-settings-v2", json); } catch {}
};

const Index = () => {
  const [settings, setSettings] = useState<AppSettings>(loadSettings);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [interval, setInterval_] = useState<TimeInterval>("1h");
  const [includeFundamental, setIncludeFundamental] = useState(true);
  const [analysisMode, setAnalysisMode] = useState<"full" | "technical_only" | "technical_fallback" | null>(null);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [resultMeta, setResultMeta] = useState<{ pair: string; interval: string }>({ pair: "USD/JPY", interval: "1h" });
  const [techData, setTechData] = useState<TechnicalData | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingStage, setLoadingStage] = useState<LoadingStage>("idle");
  const [liveRate, setLiveRate] = useState<string | null>(null);
  const [history, setHistory] = useState<AnalysisRecord[]>([]);
  const [rulebook, setRulebook] = useState<Rulebook | null>(null);
  const [loopHealth, setLoopHealth] = useState<LoopHealthData | null>(null);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [limitReached, setLimitReached] = useState(false);
  const { t, locale } = useLocale();
  const { toast } = useToast();
  const navigate = useNavigate();
  const { user, profile } = useAuth();

  const isAdmin = isAdminEmail(user?.email);
  const planLower = (profile?.plan || "Free").toLowerCase();
  const isFreeUser = !isAdmin && (!profile?.plan || planLower === "free");

  const [bannerDismissed, setBannerDismissed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(UPGRADE_BANNER_DISMISS_KEY) === "1";
    } catch {
      return false;
    }
  });

  const dismissBanner = () => {
    setBannerDismissed(true);
    try { localStorage.setItem(UPGRADE_BANNER_DISMISS_KEY, "1"); } catch {}
  };

  const showUpgradeBanner = isFreeUser && !bannerDismissed;

  useEffect(() => {
    saveSettings(settings);
  }, [settings]);

  const loadHistory = useCallback(async () => {
    try {
      // Shadow rows (refused plans, tracked anyway) come along and are
      // folded under their WAIT row by the history view
      const { data, error } = await supabase
        .from("analyses")
        .select("id,pair,interval,mode,signal,confidence,thesis,entry_point,stop_loss,take_profit_1,take_profit_2,take_profit_3,price_at_signal,outcome,outcome_price,created_at,closed_at,evaluation,entry_check,postmortem,shadow,shadow_of,rulebook_version")
        .order("created_at", { ascending: false })
        .limit(40);
      if (!error && Array.isArray(data)) {
        setHistory(data as AnalysisRecord[]);
      }
    } catch {
      // History is best-effort; the analysis flow must not depend on it
    }
    try {
      const { data, error } = await supabase
        .from("rulebook")
        .select("version,rules,summary,updated_at")
        .eq("id", 1)
        .maybeSingle();
      if (!error && data) {
        setRulebook(data as Rulebook);
      }
    } catch {
      // The learned rules are a display of what the analyzer knows, nothing
      // else depends on them
    }
    try {
      // Whether the review loop is actually running, shown rather than assumed
      const { data, error } = await supabase.rpc("loop_health");
      if (!error && data && typeof data === "object") {
        setLoopHealth(data as LoopHealthData);
      }
    } catch {
      // Best effort, like the rest of the panel
    }
  }, []);

  // On login: settle any open signals against price data, then show history
  const userId = user?.id;
  useEffect(() => {
    if (!userId) return;
    let cancelled = false;

    const run = async () => {
      await loadHistory();
      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session || cancelled) return;
        const res = await fetch(`${SUPABASE_URL}/functions/v1/track-outcomes`, {
          method: "POST",
          headers: {
            "Authorization": "Bearer " + session.access_token,
            "apikey": SUPABASE_ANON_KEY,
          },
        });
        const data = await res.json().catch(() => null);
        if (!cancelled && data && typeof data.updated === "number" && data.updated > 0) {
          await loadHistory();
        }
      } catch {
        // Outcome tracking is best-effort
      }
    };

    void run();
    return () => { cancelled = true; };
  }, [userId, loadHistory]);

  const handleAnalyze = useCallback(async () => {
    // The server refuses this anyway (analyze checks the plan before doing any
    // paid work); this just avoids a pointless round trip and a raw error
    if (isFreeUser) {
      navigate("/pricing");
      return;
    }
    setLoading(true);
    setLoadingStage("fetching");
    setResult(null);
    setAnalysisMode(null);
    setLiveRate(null);
    // Clear the indicators too: on a failed run they would otherwise keep
    // showing the previous pair's numbers next to an error toast
    setTechData(null);
    setLimitReached(false);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        toast({ title: t.errors.loginRequired, variant: "destructive" });
        return;
      }

      setLoadingStage("analyzing");

      const response = await fetch(`${SUPABASE_URL}/functions/v1/analyze`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + session.access_token,
          "apikey": SUPABASE_ANON_KEY,
        },
        body: JSON.stringify({
          currencyPair: settings.currencyPair,
          interval,
          includeFundamental,
          locale,
        }),
      });

      const adminUser = isAdminEmail(session.user?.email);
      const rawText = await response.text();
      let resData: any = {};

      try {
        resData = rawText ? JSON.parse(rawText) : {};
      } catch {
        resData = { error: rawText };
      }

      const payload = typeof resData?.data === "object" && resData.data !== null
        ? resData.data
        : resData;
      const deployedVersion = response.headers.get("X-Function-Version") || (typeof resData?.version === "string" ? resData.version : null);
      const analysisResult = normalizeAnalysisResult(payload?.analysis ?? resData?.analysis);
      const remainingCount = payload?.remaining ?? resData?.remaining ?? null;
      const technicalData = normalizeTechnicalData(payload?.technicalData ?? resData?.technicalData);
      const mode = payload?.mode ?? resData?.mode ?? (includeFundamental ? "full" : "technical_only");
      const errorMessage = resData?.error || payload?.error ||
        // 546 is Supabase killing the worker at its wall-clock limit. There is
        // no response body in that case, so name the cause ourselves.
        (response.status === 546
          ? t.errors.wallClock
          : t.errors.server(response.status));
      // Match on the server's own stage, not on the words in the message: an
      // upstream "rate limit" error used to be reported as the daily cap and
      // pushed the user at the pricing page for no reason.
      const errorStage = resData?.diagnostics?.error_stage ?? payload?.diagnostics?.error_stage;
      const isLimitError = errorStage === "daily_limit_reached";

      if (!response.ok || resData?.ok === false || payload?.ok === false) {
        // A failure after the quota was spent refunds it and reports the
        // corrected count; without this the UI keeps an inflated "remaining"
        if (typeof remainingCount === "number") {
          setRemaining(remainingCount);
        }

        if (deployedVersion && deployedVersion !== EXPECTED_ANALYZE_VERSION) {
          console.warn("analyze Edge Function version mismatch:", {
            expected: EXPECTED_ANALYZE_VERSION,
            deployed: deployedVersion,
          });
        }

        if (!adminUser && isLimitError) {
          setLimitReached(true);
          toast({ title: t.errors.limitReached, description: t.errors.limitReachedBody, variant: "destructive" });
          return;
        }

        if (adminUser && isLimitError) {
          toast({ title: t.errors.adminNotDeployed, description: t.errors.adminNotDeployedBody, variant: "destructive" });
          return;
        }

        console.error("Edge function error:", response.status, resData?.diagnostics ?? payload?.diagnostics ?? rawText);
        throw new Error(errorMessage);
      }

      if (!analysisResult) {
        throw new Error(t.errors.noResult);
      }

      setLoadingStage("generating_judgment");
      setResult(analysisResult);
      setResultMeta({ pair: settings.currencyPair, interval });
      setRemaining(remainingCount);
      setAnalysisMode(mode);
      setLiveRate(technicalData?.price ?? analysisResult.entry_point ?? null);
      setTechData(technicalData);

      void loadHistory();
    } catch (err: any) {
      const isNetworkError = err instanceof TypeError && ["Failed to fetch", "Load failed"].includes(err.message);
      const description = isNetworkError
        ? t.errors.network
        : err.message || t.errors.generic;

      console.error("Analysis request failed:", err);
      toast({ title: t.common.error, description, variant: "destructive" });
    } finally {
      setLoading(false);
      setLoadingStage("idle");
    }
  }, [settings, interval, includeFundamental, locale, t, toast, loadHistory, isFreeUser, navigate]);

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <Header
        onOpenSettings={() => setSettingsOpen(true)}
        liveRate={liveRate}
        currencyPair={settings.currencyPair}
      />

      <main className="flex-1 container max-w-6xl mx-auto px-4 py-4 space-y-4">
        {showUpgradeBanner && (
          <div
            className="relative rounded-xl border border-primary/40 p-3 sm:p-4 flex flex-col sm:flex-row sm:items-center gap-3 shadow-md"
            style={{ background: "linear-gradient(135deg, rgba(0,212,255,0.15), rgba(0,153,204,0.08))" }}
          >
            {/* On a phone the icon, two lines of copy, the call to action and
                the dismiss button do not fit on one row without shredding the
                text into two-word lines, so the row becomes a stack. */}
            <div className="flex items-center gap-3 min-w-0 pr-7 sm:pr-0">
              <div className="h-9 w-9 rounded-lg flex items-center justify-center shrink-0" style={{ background: "linear-gradient(135deg, #00d4ff, #0099cc)" }}>
                <Crown className="h-4 w-4 text-white" />
              </div>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-foreground">{t.index.upgradeTitle}</p>
                <p className="text-xs text-muted-foreground">{t.index.upgradeBody}</p>
              </div>
            </div>
            <button
              onClick={() => navigate("/pricing")}
              className="w-full sm:w-auto sm:ml-auto px-3 py-2 sm:py-1.5 rounded-lg text-xs font-semibold text-white shrink-0 hover:opacity-90 transition-opacity"
              style={{ background: "linear-gradient(135deg, #00d4ff, #0099cc)" }}
            >
              {t.index.upgradeCta}
            </button>
            <button
              onClick={dismissBanner}
              aria-label={t.common.close}
              className="absolute top-2 right-2 sm:static p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors shrink-0"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        )}

        <ControlBar
          interval={interval}
          onIntervalChange={setInterval_}
          onAnalyze={handleAnalyze}
          loading={loading}
          loadingStage={loadingStage}
          remaining={remaining}
          includeFundamental={includeFundamental}
          onIncludeFundamentalChange={setIncludeFundamental}
          locked={isFreeUser}
          onSubscribe={() => navigate("/pricing")}
        />

        {limitReached && (
          <div className="glass rounded-xl border border-destructive p-6 flex flex-col items-center text-center space-y-3">
            <p className="text-destructive font-semibold">{t.index.limitTitle}</p>
            <p className="text-sm text-muted-foreground">{t.index.limitBody}</p>
            <button
              onClick={() => navigate("/pricing")}
              className="px-6 py-2 rounded-lg bg-primary text-primary-foreground font-semibold text-sm hover:opacity-90 transition-opacity"
            >
              {t.header.upgrade}
            </button>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="space-y-4">
            {loading ? (
              <AnalysisStages active={loading} />
            ) : result ? (
              <>
                {analysisMode && (
                  <div className="text-[11px] text-muted-foreground px-1">
                    {t.analysisMode.label}{" "}
                    <span className={analysisMode === "technical_fallback" ? "text-warning font-medium" : "text-foreground font-medium"}>
                      {t.analysisMode[analysisMode]}
                    </span>
                  </div>
                )}
                <AnalysisResultView
                  result={result}
                  techData={techData}
                  pair={resultMeta.pair}
                  interval={resultMeta.interval}
                  settings={settings}
                />
              </>
            ) : (
              <div className="glass rounded-xl border border-border p-12 flex flex-col items-center justify-center text-center min-h-[400px]">
                <div className="w-16 h-16 rounded-full border-2 border-dashed border-border flex items-center justify-center mb-4">
                  <Zap className="h-6 w-6 text-muted-foreground" />
                </div>
                <p className="text-muted-foreground text-sm">
                  {t.index.emptyLine1}
                  <br />
                  {t.index.emptyLine2}
                </p>
              </div>
            )}
          </div>

          <div className="space-y-4">
            {techData && !loading && <TechnicalDataCard data={techData} />}
            <LoopHealth health={loopHealth} />
            <LearnedRules rulebook={rulebook} />
            <AnalysisHistory records={history} />
          </div>
        </div>
      </main>

      <footer className="border-t border-border py-3 px-4">
        <p className="text-[10px] text-muted-foreground text-center leading-relaxed">
          {t.index.disclaimer}
        </p>
      </footer>

      <SettingsDrawer
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        settings={settings}
        onSettingsChange={setSettings}
      />
    </div>
  );
};

export default Index;
