import { Link } from "react-router-dom";
import { Zap } from "lucide-react";

const LandingFooter = () => (
  <footer className="border-t border-white/5 py-10">
    <div className="container max-w-6xl mx-auto px-4">
      <div className="flex flex-col md:flex-row items-center justify-between gap-6">
        <div className="flex items-center gap-2">
          <Zap className="h-4 w-4 text-[#00d4ff]" />
          <span className="text-sm font-semibold">FX Tactical Analyzer</span>
          <span className="text-xs text-muted-foreground ml-2">© 2026</span>
        </div>
        <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
          <Link to="/blog" className="hover:text-foreground transition-colors">ブログ</Link>
          <Link to="/terms" className="hover:text-foreground transition-colors">利用規約</Link>
          <Link to="/privacy" className="hover:text-foreground transition-colors">プライバシーポリシー</Link>
          <Link to="/tokushoho" className="hover:text-foreground transition-colors">特定商取引法に基づく表記</Link>
          <a href="mailto:k.munemoto@kyoto-salute.com" className="hover:text-foreground transition-colors">お問い合わせ</a>
        </div>
      </div>
      <p className="text-xs text-muted-foreground/60 text-center mt-6">
        本サービスは投資助言ではありません。FX取引にはリスクが伴います。
      </p>
    </div>
  </footer>
);

export default LandingFooter;
