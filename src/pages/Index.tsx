import { useState, useEffect, useCallback } from "react";
import { Zap } from "lucide-react";
import Header from "@/components/Header";
import ControlBar from "@/components/ControlBar";
import AnalysisResultView from "@/components/AnalysisResultView";
import TechnicalDataCard from "@/components/TechnicalDataCard";
import AnalysisHistory from "@/components/AnalysisHistory";
import SettingsDrawer from "@/components/SettingsDrawer";
import { supabase } from "@/lib/supabase";
import { isAdminEmail } from "@/lib/admin";
import type { AnalysisResult, AppSettings, TechnicalData, TimeInterval, LoadingStage, HistoryEntry } from "@/lib/types";
import { useToast } from "@/hooks/use-toast";
import { useNavigate } from "react-router-dom";

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

  useEffect(() => {
    saveSettings(settings);
  }, [settings]);

  const handleAnalyze = useCallback(async () => {
    setLoading(true);
    setLoadingStage("fetching");
    setResult(null);
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
          interval: interval,
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        console.error("Edge function error:", response.status, errText);
        throw new Error(`サーバーエラー (${response.status}): ${errText}`);
      }

      const resData = await response.json();

      if (resData.error) {
        const adminUser = isAdminEmail(session.user?.email);
        if (!adminUser && (resData.error.includes("上限") || resData.error.includes("limit"))) {
          setLimitReached(true);
          toast({ title: "本日の分析上限に達しました", description: "プランをアップグレードしてください", variant: "destructive" });
          return;
        }
        if (!adminUser) throw new Error(resData.error);
      }

      setLoadingStage("generating_judgment");

      const analysisResult: AnalysisResult = resData.analysis;
      setResult(analysisResult);
      setRemaining(resData.remaining ?? null);

      if (resData.analysis?.entry_point) {
        setLiveRate(resData.analysis.entry_point);
      }

      if (resData.technicalData) {
        setTechData(resData.technicalData);
      }

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
      toast({ title: "エラー", description: err.message, variant: "destructive" });
    } finally {
      setLoading(false);
      setLoadingStage("idle");
    }
  }, [settings, interval, toast]);

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
              <AnalysisResultView result={result} />
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
