import { useNavigate } from "react-router-dom";
import { Zap } from "lucide-react";

const LandingHeader = () => {
  const navigate = useNavigate();

  return (
    <header className="sticky top-0 z-50 border-b border-white/5 bg-[#0a0e17]/80 backdrop-blur-xl">
      <div className="container max-w-6xl mx-auto flex items-center justify-between px-4 h-16">
        <button onClick={() => navigate("/")} className="flex items-center gap-2">
          <Zap className="h-5 w-5 text-primary" />
          <span className="font-bold text-lg tracking-tight">FX Tactical Analyzer</span>
        </button>
        <div className="flex items-center gap-3">
          <button onClick={() => navigate("/login")} className="text-sm text-muted-foreground hover:text-foreground transition-colors">
            ログイン
          </button>
          <button
            onClick={() => navigate("/login?tab=signup")}
            className="text-sm font-semibold px-4 py-2 rounded-lg bg-primary text-primary-foreground hover:opacity-90 transition-opacity"
          >
            無料で始める
          </button>
        </div>
      </div>
    </header>
  );
};

export default LandingHeader;
