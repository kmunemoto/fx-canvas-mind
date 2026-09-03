import { useNavigate, Link } from "react-router-dom";
import { Zap } from "lucide-react";
import { useT } from "@/lib/i18n";
import LanguageSwitcher from "@/components/LanguageSwitcher";

const LandingHeader = () => {
  const navigate = useNavigate();
  const t = useT();

  return (
    <header className="sticky top-0 z-50 border-b border-white/5 bg-[#0a0e17]/80 backdrop-blur-xl">
      <div className="container max-w-6xl mx-auto flex items-center justify-between px-4 h-16">
        <button onClick={() => navigate("/")} className="flex items-center gap-2">
          <Zap className="h-5 w-5 text-[#00d4ff]" />
          <span className="font-bold text-lg tracking-tight">FX Tactical Analyzer</span>
        </button>
        <nav className="flex items-center gap-3">
          <LanguageSwitcher compact />
          <Link to="/blog" className="hidden md:inline text-sm text-muted-foreground hover:text-foreground transition-colors">
            {t.landing.blog}
          </Link>
          <button onClick={() => navigate("/login")} className="text-sm text-muted-foreground hover:text-foreground transition-colors">
            {t.landing.login}
          </button>
          <button
            onClick={() => navigate("/login?tab=signup")}
            className="text-sm font-semibold px-4 py-2 rounded-lg bg-[#00d4ff] text-[#0a0e17] hover:opacity-90 transition-opacity"
          >
            {t.landing.startFree}
          </button>
        </nav>
      </div>
    </header>
  );
};

export default LandingHeader;
