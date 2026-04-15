import { useState, useEffect, useCallback } from "react";
import { Zap } from "lucide-react";
import Header from "@/components/Header";
import ControlBar from "@/components/ControlBar";
import AnalysisResultView from "@/components/AnalysisResultView";
import TechnicalDataCard from "@/components/TechnicalDataCard";
import AnalysisHistory from "@/components/AnalysisHistory";
import SettingsDrawer from "@/components/SettingsDrawer";
import { fetchTechnicalData } from "@/lib/twelve-data";
import { analyzeWithClaude } from "@/lib/claude-api";
import type { AnalysisResult, AppSettings, TechnicalData, TimeInterval, LoadingStage, HistoryEntry } from "@/lib/types";
import { useToast } from "@/hooks/use-toast";

const loadSettings = (): AppSettings => {
  try {
    const stored = localStorage.getItem("fx-settings-v2");
    if (stored) return JSON.parse(stored);
  } catch {}
  return {
    twelveDataApiKey: "",
    anthropicApiKey: "",
    defaultStopLossPips: 30,
    defaultTakeProfitPips: 60,
    currencyPair: "USD/JPY",
  };
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
  const { toast } = useToast();

  const apiConnected = !!(settings.twelveDataApiKey && settings.anthropicApiKey);

  useEffect(() => {
    localStorage.setItem("fx-settings-v2", JSON.stringify(settings));
  }, [settings]);

  const handleAnalyze = useCallback(async () => {
    if (!settings.twelveDataApiKey || !settings.anthropicApiKey) {
      setSettingsOpen(true);
      toast({ title: "APIキーを設定してください", variant: "destructive" });
      return;
    }

    setLoading(true);
    setLoadingStage("fetching_batch1");
    setResult(null);
    setLiveRate(null);

    try {
      const data = await fetchTechnicalData(
        settings.currencyPair,
        interval,
        settings.twelveDataApiKey,
        (stage) => setLoadingStage(stage as LoadingStage),
        (price) => setLiveRate(price)
      );
      setTechData(data);
      setLiveRate(data.price);

      setLoadingStage("analyzing_fundamental");
      await new Promise((r) => setTimeout(r, 500));

      setLoadingStage("generating_judgment");
      const res = await analyzeWithClaude(data, settings, interval);
      setResult(res);

      setHistory((prev) => [
        {
          timestamp: new Date().toLocaleTimeString("ja-JP", { timeZone: "Asia/Tokyo" }),
          signal: res.signal,
          confidence: res.confidence,
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
        apiConnected={apiConnected}
      />

      <main className="flex-1 container max-w-6xl mx-auto px-4 py-4 space-y-4">
        <ControlBar
          interval={interval}
          onIntervalChange={setInterval_}
          onAnalyze={handleAnalyze}
          loading={loading}
          loadingStage={loadingStage}
        />

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Left column */}
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
                {!apiConnected && (
                  <button
                    onClick={() => setSettingsOpen(true)}
                    className="mt-4 text-xs text-primary underline"
                  >
                    まずAPIキーを設定する →
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Right column */}
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
