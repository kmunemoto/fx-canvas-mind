import { useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import type { SupplementaryInfo } from "@/lib/types";

interface Props {
  info: SupplementaryInfo;
  onChange: (info: SupplementaryInfo) => void;
}

const SupplementaryInput = ({ info, onChange }: Props) => {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="glass rounded-xl border border-border overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full px-4 py-3 flex items-center justify-between text-sm font-medium text-foreground hover:bg-accent/50 transition-colors"
      >
        補足情報（オプション）
        {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
      </button>

      {expanded && (
        <div className="px-4 pb-4 space-y-4">
          <div>
            <label className="text-xs text-muted-foreground">現在レート</label>
            <input
              type="text"
              value={info.currentRate}
              onChange={(e) => onChange({ ...info, currentRate: e.target.value })}
              placeholder="例: 155.50"
              className="w-full mt-1 px-3 py-2 bg-secondary rounded-lg border border-border text-sm font-mono text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>

          <div>
            <label className="text-xs text-muted-foreground">ポジション方向の希望</label>
            <div className="flex gap-3 mt-1">
              {(["ANY", "BUY", "SELL"] as const).map((v) => (
                <label key={v} className="flex items-center gap-1.5 text-sm text-foreground cursor-pointer">
                  <input
                    type="radio"
                    name="preference"
                    checked={info.positionPreference === v}
                    onChange={() => onChange({ ...info, positionPreference: v })}
                    className="accent-primary"
                  />
                  {v === "ANY" ? "どちらでも" : v === "BUY" ? "買い" : "売り"}
                </label>
              ))}
            </div>
          </div>

          <div>
            <label className="text-xs text-muted-foreground">特記事項</label>
            <textarea
              value={info.notes}
              onChange={(e) => onChange({ ...info, notes: e.target.value })}
              placeholder="例: 雇用統計前、日銀会合直後"
              rows={2}
              className="w-full mt-1 px-3 py-2 bg-secondary rounded-lg border border-border text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary resize-none"
            />
          </div>
        </div>
      )}
    </div>
  );
};

export default SupplementaryInput;
