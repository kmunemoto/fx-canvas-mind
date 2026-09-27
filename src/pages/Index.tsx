import { useState } from "react";
import { Crown, X } from "lucide-react";
import { useNavigate } from "react-router-dom";
import Header from "@/components/Header";
import LiveChart from "@/components/LiveChart";
import SettingsDrawer from "@/components/SettingsDrawer";
import { useAuth } from "@/contexts/AuthContext";
import { isAdminEmail } from "@/lib/admin";
import { useT } from "@/lib/i18n";

// The same key the analysis page used, so a banner dismissed there stays
// dismissed
const UPGRADE_BANNER_DISMISS_KEY = "fx-upgrade-banner-dismissed";

// #139: the app is the live chart (#113) and, in the settings, the signal
// emails (#105, Light and up). The analysis and the held positions came off
// the screen when the owner no longer needed them; that page is kept, not
// routed, in src/pages/Analysis.tsx (docs §8.51).
const Index = () => {
  const t = useT();
  const navigate = useNavigate();
  const { user, profile } = useAuth();
  const [settingsOpen, setSettingsOpen] = useState(false);

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
    try {
      localStorage.setItem(UPGRADE_BANNER_DISMISS_KEY, "1");
    } catch {
      // kept for this page only
    }
  };
  const showUpgradeBanner = isFreeUser && !bannerDismissed;

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <Header onOpenSettings={() => setSettingsOpen(true)} liveRate={null} currencyPair="" />

      <main className="flex-1 container max-w-6xl mx-auto px-4 py-4 space-y-4">
        {showUpgradeBanner && (
          <div
            className="relative rounded-xl border border-primary/40 p-3 sm:p-4 flex flex-col sm:flex-row sm:items-center gap-3 shadow-md"
            style={{ background: "linear-gradient(135deg, rgba(0,212,255,0.15), rgba(0,153,204,0.08))" }}
            data-testid="upgrade-banner"
          >
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

        {user && <LiveChart />}
      </main>

      <footer className="border-t border-border py-3 px-4">
        <p className="text-[10px] text-muted-foreground text-center leading-relaxed">
          {t.index.disclaimer}
        </p>
      </footer>

      <SettingsDrawer open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
};

export default Index;
