import { useEffect, useState } from "react";
import { Settings } from "lucide-react";

interface HeaderProps {
  onOpenSettings: () => void;
}

const Header = ({ onOpenSettings }: HeaderProps) => {
  const [time, setTime] = useState("");

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

  return (
    <header className="glass border-b border-border px-6 py-4 flex items-center justify-between">
      <div className="flex items-center gap-3">
        <div className="h-8 w-1 rounded-full bg-primary" />
        <h1 className="text-xl font-bold tracking-tight text-foreground">
          FX Tactical Analyzer
        </h1>
      </div>
      <div className="flex items-center gap-4">
        <span className="font-mono text-sm text-muted-foreground">{time} JST</span>
        <button
          onClick={onOpenSettings}
          className="p-2 rounded-lg hover:bg-accent transition-colors text-muted-foreground hover:text-foreground"
        >
          <Settings className="h-5 w-5" />
        </button>
      </div>
    </header>
  );
};

export default Header;
