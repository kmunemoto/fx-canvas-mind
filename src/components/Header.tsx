import { useEffect, useState } from "react";
import { Settings, LogOut, Crown, ShieldCheck } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { Badge } from "@/components/ui/badge";
import { useNavigate } from "react-router-dom";
import { isAdminEmail, resolvePlanName } from "@/lib/admin";
import { loadCancellation } from "@/lib/cancellation";
import { useLocale } from "@/lib/i18n";
import LanguageSwitcher from "@/components/LanguageSwitcher";

interface HeaderProps {
  onOpenSettings: () => void;
  liveRate: string | null;
  currencyPair: string;
}

const Header = ({ onOpenSettings, liveRate, currencyPair }: HeaderProps) => {
  const [time, setTime] = useState("");
  const { user, profile, signOut } = useAuth();
  const { t, locale } = useLocale();
  const navigate = useNavigate();

  useEffect(() => {
    const update = () => {
      setTime(
        // JST regardless of locale: the market data and the analysis are both
        // timestamped in it, so a viewer's local clock would not line up.
        new Date().toLocaleString(t.intlLocale, {
          timeZone: "Asia/Tokyo",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        })
      );
    };
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [t.intlLocale, locale]);

  const isAdmin = isAdminEmail(user?.email);
  const planName = resolvePlanName(user?.email, profile?.plan);
  const planLower = planName.toLowerCase();
  const isFree = !isAdmin && (!profile?.plan || planLower === "free");
  const isPro = isAdmin || planLower === "pro";
  const isPaidNonPro = !isAdmin && (planLower === "light" || planLower === "standard");
  const cancelPending = !!loadCancellation(user?.id);
  const shortEmail = user?.email
    ? user.email.length > 16
      ? user.email.substring(0, 14) + "…"
      : user.email
    : "";

  return (
    // The bar has to survive a 320px phone: the title is the only elastic
    // part, everything on the right keeps its size and drops its label
    // instead. Without min-w-0 the title refuses to shrink and pushes the
    // whole page into a horizontal scroll.
    <header className="glass border-b border-border px-3 sm:px-4 py-2.5 sm:py-3 flex items-center justify-between gap-2">
      <div className="flex items-center gap-2 sm:gap-3 min-w-0">
        <div className="h-7 sm:h-8 w-1 rounded-full bg-primary shrink-0" />
        <h1 className="text-base sm:text-lg font-bold tracking-tight text-foreground truncate">
          FX Tactical Analyzer
        </h1>
      </div>

      <div className="flex items-center gap-2 sm:gap-3 shrink-0">
        {liveRate && (
          <div className="flex items-baseline gap-1.5">
            <span className="text-xs text-muted-foreground hidden sm:inline">{currencyPair}</span>
            <span className="font-mono text-sm sm:text-base font-bold text-primary text-glow">{liveRate}</span>
          </div>
        )}

        <span className="font-mono text-xs text-muted-foreground hidden lg:inline">{time} JST</span>

        {/* Plan link / Upgrade button */}
        {isFree && (
          <button
            onClick={() => navigate("/pricing")}
            aria-label={t.header.upgrade}
            className="flex items-center gap-1 px-2 sm:px-3 py-1.5 rounded-lg text-xs font-semibold text-white shadow-md shrink-0 hover:opacity-90 transition-opacity"
            style={{ background: "linear-gradient(135deg, #00d4ff, #0099cc)" }}
          >
            <Crown className="h-3.5 w-3.5 shrink-0" />
            <span className="hidden sm:inline">{t.header.upgrade}</span>
          </button>
        )}
        {isPaidNonPro && (
          <button
            onClick={() => navigate("/pricing")}
            className="hidden sm:inline-flex px-2.5 py-1 rounded-md border border-border text-[11px] text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          >
            {t.header.changePlan}
          </button>
        )}

        {/* Plan identity is a desktop nicety; on a phone it lives in the
            settings drawer, which shows the same plan and its billing date. */}
        {user && (
          <div className="hidden sm:flex items-center gap-2">
            {isAdmin && (
              <Badge variant="outline" className="text-[10px] px-1.5 py-0 border-primary text-primary gap-1">
                <ShieldCheck className="h-3 w-3" />
                Admin
              </Badge>
            )}
            <span className="text-xs text-muted-foreground hidden md:inline">{shortEmail}</span>
            <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
              {planName}
            </Badge>
            {cancelPending && (
              <span className="text-[10px] text-muted-foreground hidden lg:inline">
                {t.header.cancelPending}
              </span>
            )}
          </div>
        )}

        {/* The settings drawer carries the same switcher, so the phone header
            does not need to spend 78px on it. */}
        <span className="hidden sm:inline-flex">
          <LanguageSwitcher compact />
        </span>

        <button
          onClick={onOpenSettings}
          title={t.header.settings}
          aria-label={t.header.settings}
          className="p-1.5 sm:p-2 rounded-lg shrink-0 hover:bg-accent transition-colors text-muted-foreground hover:text-foreground"
        >
          <Settings className="h-5 w-5" />
        </button>

        {user && (
          <button
            onClick={signOut}
            title={t.header.signOut}
            aria-label={t.header.signOut}
            className="p-1.5 sm:p-2 rounded-lg shrink-0 hover:bg-accent transition-colors text-muted-foreground hover:text-foreground"
          >
            <LogOut className="h-4 w-4" />
          </button>
        )}
      </div>
    </header>
  );
};

export default Header;
