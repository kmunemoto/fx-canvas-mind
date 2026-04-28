import { useState, useEffect, useCallback } from "react";
import { Zap, Crown, X } from "lucide-react";
import Header from "@/components/Header";
import ControlBar from "@/components/ControlBar";
import AnalysisResultView from "@/components/AnalysisResultView";
import TechnicalDataCard from "@/components/TechnicalDataCard";
import AnalysisHistory from "@/components/AnalysisHistory";
import SettingsDrawer from "@/components/SettingsDrawer";
import { supabase } from "@/lib/supabase";
import { isAdminEmail } from "@/lib/admin";
import { useAuth } from "@/contexts/AuthContext";
import type { AnalysisResult, AppSettings, TechnicalData, TimeInterval, LoadingStage, HistoryEntry } from "@/lib/types";
import { useToast } from "@/hooks/use-toast";
import { useNavigate } from "react-router-dom";

const EXPECTED_ANALYZE_VERSION = "analyze-v7-2026-04-24T16:20:00Z";
const UPGRADE_BANNER_DISMISS_KEY = "fx-upgrade-banner-dismissed";

const toStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  const items: string[] = [];
  for (const item of value) {
    if (typeof item === "string") items.push(item);
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

  return {
    signal: source.signal === "BUY" || source.signal === "SELL" || source.signal === "WAIT" ? source.signal : "WAIT",
    confidence: typeof source.confidence === "number" ? source.confidence : 0,
    technical_score: typeof source.technical_score === "number" ? source.technical_score : 0,
    fundamental_score: typeof source.fundamental_score === "number" ? source.fundamental_score : 0,
    risk_level: source.risk_level === "LOW" || source.risk_level === "MEDIUM" || source.risk_level === "HIGH" ? source.risk_level : "MEDIUM",
    sentiment: source.sentiment === "BULLISH" || source.sentiment === "NEUTRAL" || source.sentiment === "BEARISH" ? source.sentiment : "NEUTRAL",
    entry_point: typeof source.entry_point === "string" ? source.entry_point : "—",
    stop_loss: typeof source.stop_loss === "string" ? source.stop_loss : "—",
    take_profit_1: typeof source.take_profit_1 === "string" ? source.take_profit_1 : "—",
    take_profit_2: typeof source.take_profit_2 === "string" ? source.take_profit_2 : "—",
    risk_reward_ratio: typeof source.risk_reward_ratio === "string" ? source.risk_reward_ratio : "—",
    analysis: typeof source.analysis === "string" ? source.analysis : "",
    key_factors: toStringArray(source.key_factors),
    warnings: toStringArray(source.warnings),
    support_levels: toStringArray(source.support_levels),
    resistance_levels: toStringArray(source.resistance_levels),
    market_context: typeof source.market_context === "string" ? source.market_context : "",
  };
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
  };
};

const loadSettings = (): AppSettings => {
  try {
    const stored = localStorage.getItem("fx-settings-v2");
    if (stored) return JSON.parse(stored);
  } catch {}
  try {
    const stored = sessionStorage.getItem("fx-settings-v2");
    if (stored) return JSON.parse(stored);
  } catch {}
  return {
    defaultStopLossPips: 30,
    defaultTakeProfitPips: 60,
    currencyPair: "USD/JPY",
  };
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
  const [analysisMode, setAnalysisMode] = useState<"full" | "technical_only" | null>(null);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [techData, setTechData] = useState<TechnicalData | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingStage, setLoadingStage] = useState<LoadingStage>("idle");
  const [liveRate, setLiveRate] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [limitReached, setLimitReached] = useState(false);
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

  const handleAnalyze = useCallback(async () => {
    setLoading(true);
    setLoadingStage("fetching");
    setResult(null);
    setAnalysisMode(null);
    setLiveRate(null);
    setLimitReached(false);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        toast({ title: "ログインが必要です", variant: "destructive" });
        return;
      }

      setLoadingStage("analyzing");

      const response = await fetch("https://endcqzewujdvimdlazhj.supabase.co/functions/v1/analyze", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + session.access_token,
          "apikey": "sb_publishable_O6jJsLFQ9zArYsenDxIHGQ_bJdkOm2I",
        },
        body: JSON.stringify({
          currencyPair: settings.currencyPair,
          interval,
          includeFundamental,
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

      console.log("Analyze API Response:", {
        status: response.status,
        ok: response.ok,
        body: resData,
      });

      const payload = typeof resData?.data === "object" && resData.data !== null
        ? resData.data
        : resData;
      const deployedVersion = response.headers.get("X-Function-Version") || (typeof resData?.version === "string" ? resData.version : null);
      const analysisResult = normalizeAnalysisResult(payload?.analysis ?? resData?.analysis);
      const remaining = payload?.remaining ?? resData?.remaining ?? null;
      const technicalData = normalizeTechnicalData(payload?.technicalData ?? resData?.technicalData);
      const mode = payload?.mode ?? resData?.mode ?? (includeFundamental ? "full" : "technical_only");
      const errorMessage = resData?.error || payload?.error || `サーバーエラー (${response.status})`;
      const isLimitError = typeof errorMessage === "string" && (errorMessage.includes("上限") || errorMessage.toLowerCase().includes("limit"));
      const isFilterRuntimeError = typeof errorMessage === "string" && errorMessage.includes("Cannot read properties of undefined (reading 'filter')");

      if (!response.ok || resData?.ok === false || payload?.ok === false) {
        if (isFilterRuntimeError && deployedVersion !== EXPECTED_ANALYZE_VERSION) {
          console.error("Stale analyze Edge Function deployment detected:", {
            expectedVersion: EXPECTED_ANALYZE_VERSION,
            deployedVersion: deployedVersion ?? "missing",
            responseBody: resData,
          });
          throw new Error("古い analyze Edge Function が動作しています。最新の analyze を再デプロイしてください。");
        }

        if (!adminUser && isLimitError) {
          setLimitReached(true);
          toast({ title: "本日の分析上限に達しました", description: "プランをアップグレードしてください", variant: "destructive" });
          return;
        }

        if (adminUser && isLimitError) {
          toast({ title: "Admin Mode未反映", description: "analyze Edge Function を再デプロイすると管理者バイパスが有効になります", variant: "destructive" });
          return;
        }

        console.error("Edge function error:", response.status, resData?.diagnostics ?? payload?.diagnostics ?? rawText);
        throw new Error(errorMessage);
      }

      if (!analysisResult) {
        throw new Error("分析結果が取得できませんでした。もう一度お試しください。");
      }

      setLoadingStage("generating_judgment");
      setResult(analysisResult);
      setRemaining(remaining);
      setAnalysisMode(mode);
      setLiveRate(analysisResult.entry_point ?? null);
      setTechData(technicalData);

      setHistory((prev) => [
        {
          timestamp: new Date().toLocaleTimeString("ja-JP", { timeZone: "Asia/Tokyo" }),
          signal: analysisResult.signal,
          confidence: analysisResult.confidence,
          pair: settings.currencyPair,
          interval,
        },
        ...prev,
      ].slice(0, 5));
    } catch (err: any) {
      const isNetworkError = err instanceof TypeError && ["Failed to fetch", "Load failed"].includes(err.message);
      const description = isNetworkError
        ? "analyze に接続できませんでした。関数のデプロイ状態またはCORS設定を確認してください。"
        : err.message || "分析処理でエラーが発生しました";

      console.error("Analysis request failed:", err);
      toast({ title: "エラー", description, variant: "destructive" });
    } finally {
      setLoading(false);
      setLoadingStage("idle");
    }
  }, [settings, interval, includeFundamental, toast]);

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <Header
        onOpenSettings={() => setSettingsOpen(true)}
        liveRate={liveRate}
        currencyPair={settings.currencyPair}
      />

      <main className="flex-1 container max-w-6xl mx-auto px-4 py-4 space-y-4">
        <ControlBar
          interval={interval}
          onIntervalChange={setInterval_}
          onAnalyze={handleAnalyze}
          loading={loading}
          loadingStage={loadingStage}
          remaining={remaining}
          includeFundamental={includeFundamental}
          onIncludeFundamentalChange={setIncludeFundamental}
        />

        {limitReached && (
          <div className="glass rounded-xl border border-destructive p-6 flex flex-col items-center text-center space-y-3">
            <p className="text-destructive font-semibold">本日の分析上限に達しました</p>
            <p className="text-sm text-muted-foreground">より多くの分析を行うにはプランをアップグレードしてください</p>
            <button
              onClick={() => navigate("/pricing")}
              className="px-6 py-2 rounded-lg bg-primary text-primary-foreground font-semibold text-sm hover:opacity-90 transition-opacity"
            >
              プランをアップグレード
            </button>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="space-y-4">
            {result ? (
              <>
                {analysisMode && (
                  <div className="text-[11px] text-muted-foreground px-1">
                    分析モード:{" "}
                    <span className="text-foreground font-medium">
                      {analysisMode === "full"
                        ? "フル分析（テクニカル+ファンダメンタル）"
                        : "テクニカル分析のみ"}
                    </span>
                  </div>
                )}
                <AnalysisResultView result={result} />
              </>
            ) : (
              <div className="glass rounded-xl border border-border p-12 flex flex-col items-center justify-center text-center min-h-[400px]">
                <div className="w-16 h-16 rounded-full border-2 border-dashed border-border flex items-center justify-center mb-4">
                  <Zap className="h-6 w-6 text-muted-foreground" />
                </div>
                <p className="text-muted-foreground text-sm">
                  「分析開始」をクリックすると
                  <br />
                  自動でデータ取得＋AI分析を行います
                </p>
              </div>
            )}
          </div>

          <div className="space-y-4">
            {techData && <TechnicalDataCard data={techData} />}
            <AnalysisHistory history={history} />
          </div>
        </div>
      </main>

      <footer className="border-t border-border py-3 px-4">
        <p className="text-[10px] text-muted-foreground text-center leading-relaxed">
          本アプリの分析結果はAIによる参考情報であり、投資助言ではありません。FX取引にはリスクが伴い、投資元本を超える損失が発生する可能性があります。取引の最終判断は必ずご自身の責任で行ってください。
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
