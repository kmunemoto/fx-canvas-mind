import { useState, useEffect } from "react";
import { Loader2, Zap } from "lucide-react";
import Header from "@/components/Header";
import ImageUploader from "@/components/ImageUploader";
import SupplementaryInput from "@/components/SupplementaryInput";
import AnalysisResultView from "@/components/AnalysisResultView";
import SettingsDrawer from "@/components/SettingsDrawer";
import { analyzeChart } from "@/lib/claude-api";
import type { AnalysisResult, AppSettings, SupplementaryInfo } from "@/lib/types";
import { useToast } from "@/hooks/use-toast";

const loadSettings = (): AppSettings => {
  try {
    const stored = localStorage.getItem("fx-settings");
    if (stored) return JSON.parse(stored);
  } catch {}
  return { apiKey: "", defaultStopLossPips: 30, defaultTakeProfitPips: 60, currencyPair: "USD/JPY" };
};

const Index = () => {
  const [settings, setSettings] = useState<AppSettings>(loadSettings);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [images, setImages] = useState<File[]>([]);
  const [supplementary, setSupplementary] = useState<SupplementaryInfo>({
    currentRate: "",
    positionPreference: "ANY",
    notes: "",
  });
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    localStorage.setItem("fx-settings", JSON.stringify(settings));
  }, [settings]);

  const handleAnalyze = async () => {
    if (!settings.apiKey) {
      setSettingsOpen(true);
      toast({ title: "APIキーを設定してください", variant: "destructive" });
      return;
    }
    if (images.length === 0) {
      toast({ title: "チャート画像を追加してください", variant: "destructive" });
      return;
    }

    setLoading(true);
    setResult(null);
    try {
      const res = await analyzeChart(images, settings, supplementary);
      setResult(res);
    } catch (err: any) {
      toast({ title: "エラー", description: err.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <Header onOpenSettings={() => setSettingsOpen(true)} />

      <main className="flex-1 container max-w-6xl mx-auto px-4 py-6">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Left: Input */}
          <div className="space-y-4">
            <ImageUploader images={images} onImagesChange={setImages} />
            <SupplementaryInput info={supplementary} onChange={setSupplementary} />

            <button
              onClick={handleAnalyze}
              disabled={loading}
              className="w-full py-4 rounded-xl bg-primary text-primary-foreground font-bold text-lg flex items-center justify-center gap-2 hover:opacity-90 transition-opacity disabled:opacity-50"
            >
              {loading ? (
                <>
                  <Loader2 className="h-5 w-5 animate-spin" />
                  分析中...
                </>
              ) : (
                <>
                  <Zap className="h-5 w-5" />
                  分析開始
                </>
              )}
            </button>

            <p className="text-xs text-muted-foreground text-center">
              分析には10〜30秒かかります（ウェブ検索含む）
            </p>
          </div>

          {/* Right: Results */}
          <div>
            {result ? (
              <AnalysisResultView result={result} />
            ) : (
              <div className="glass rounded-xl border border-border p-12 flex flex-col items-center justify-center text-center h-full min-h-[400px]">
                <div className="w-16 h-16 rounded-full border-2 border-dashed border-border flex items-center justify-center mb-4">
                  <Zap className="h-6 w-6 text-muted-foreground" />
                </div>
                <p className="text-muted-foreground text-sm">
                  チャート画像をアップロードして
                  <br />
                  「分析開始」をクリックしてください
                </p>
              </div>
            )}
          </div>
        </div>
      </main>

      {/* Footer disclaimer */}
      <footer className="border-t border-border py-3 px-4">
        <p className="text-xs text-muted-foreground text-center">
          本アプリの分析結果は参考情報であり、投資助言ではありません。FX取引にはリスクが伴い、元本を失う可能性があります。
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
