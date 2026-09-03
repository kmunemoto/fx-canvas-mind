import { Link } from "react-router-dom";
import { Zap } from "lucide-react";
import { useT } from "@/lib/i18n";

const LandingFooter = () => {
  const t = useT();
  return (
  <footer className="border-t border-white/5 py-10">
    <div className="container max-w-6xl mx-auto px-4">
      <div className="flex flex-col md:flex-row items-center justify-between gap-6">
        <div className="flex items-center gap-2">
          <Zap className="h-4 w-4 text-[#00d4ff]" />
          <span className="text-sm font-semibold">FX Tactical Analyzer</span>
          <span className="text-xs text-muted-foreground ml-2">© 2026</span>
        </div>
        <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
          <Link to="/blog" className="hover:text-foreground transition-colors">{t.landing.blog}</Link>
          <Link to="/terms" className="hover:text-foreground transition-colors">{t.landing.terms}</Link>
          <Link to="/privacy" className="hover:text-foreground transition-colors">{t.landing.privacy}</Link>
          <Link to="/tokushoho" className="hover:text-foreground transition-colors">{t.landing.tokushoho}</Link>
          <a href="mailto:k.munemoto@kyoto-salute.com" className="hover:text-foreground transition-colors">{t.landing.contact}</a>
        </div>
      </div>
      <p className="text-xs text-muted-foreground/60 text-center mt-6">
        {t.landing.footerNote}
      </p>
    </div>
  </footer>
  );
};

export default LandingFooter;
