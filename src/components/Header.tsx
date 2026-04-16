import { useEffect, useState } from "react";
import { Settings, LogOut, Crown } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { Badge } from "@/components/ui/badge";
import { useNavigate } from "react-router-dom";

interface HeaderProps {
  onOpenSettings: () => void;
  liveRate: string | null;
  currencyPair: string;
}

const Header = ({ onOpenSettings, liveRate, currencyPair }: HeaderProps) => {
  const [time, setTime] = useState("");
  const { user, profile, signOut } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    const update = () => {
      setTime(
        new Date().toLocaleString("ja-JP", {
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
  }, []);

  const planName = profile?.plan || "Free";
  const isFree = !profile?.plan || profile.plan === "Free";
  const shortEmail = user?.email
    ? user.email.length > 16
      ? user.email.substring(0, 14) + "…"
      : user.email
    : "";

  return (
    <header className="glass border-b border-border px-4 py-3 flex items-center justify-between">
      <div className="flex items-center gap-3">
        <div className="h-8 w-1 rounded-full bg-primary" />
        <h1 className="text-lg font-bold tracking-tight text-foreground">
          FX Tactical Analyzer
        </h1>
      </div>

      <div className="flex items-center gap-3">
        {liveRate && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">{currencyPair}</span>
            <span className="font-mono text-base font-bold text-primary text-glow">{liveRate}</span>
          </div>
        )}

        <span className="font-mono text-xs text-muted-foreground hidden sm:inline">{time} JST</span>

        {/* Plan link / Upgrade button */}
        {isFree ? (
          <button
            onClick={() => navigate("/pricing")}
            className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-semibold hover:opacity-90 transition-opacity"
          >
            <Crown className="h-3.5 w-3.5" />
            アップグレード
          </button>
        ) : (
          <button
            onClick={() => navigate("/pricing")}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            プラン
          </button>
        )}

        {user && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground hidden sm:inline">{shortEmail}</span>
            <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
              {planName}
            </Badge>
          </div>
        )}

        <button
          onClick={onOpenSettings}
          className="p-2 rounded-lg hover:bg-accent transition-colors text-muted-foreground hover:text-foreground"
        >
          <Settings className="h-5 w-5" />
        </button>

        {user && (
          <button
            onClick={signOut}
            title="ログアウト"
            className="p-2 rounded-lg hover:bg-accent transition-colors text-muted-foreground hover:text-foreground"
          >
            <LogOut className="h-4 w-4" />
          </button>
        )}
      </div>
    </header>
  );
};

export default Header;
