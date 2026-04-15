interface Props {
  title: string;
  value: string | number;
  subtitle?: string;
  score?: number;
  color?: "primary" | "success" | "warning" | "destructive";
}

const colorMap = {
  primary: "text-primary",
  success: "text-success",
  warning: "text-warning",
  destructive: "text-destructive",
};

const barColorMap = {
  primary: "bg-primary",
  success: "bg-success",
  warning: "bg-warning",
  destructive: "bg-destructive",
};

const ScoreCard = ({ title, value, subtitle, score, color = "primary" }: Props) => (
  <div className="glass rounded-xl border border-border p-4 border-glow">
    <p className="text-[10px] text-muted-foreground uppercase tracking-wider">{title}</p>
    <p className={`text-xl font-bold font-mono mt-1 ${colorMap[color]}`}>{value}</p>
    {score !== undefined && (
      <div className="mt-2 h-1.5 bg-secondary rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-1000 ease-out ${barColorMap[color]}`}
          style={{ width: `${score}%` }}
        />
      </div>
    )}
    {subtitle && <p className="text-xs text-muted-foreground mt-1">{subtitle}</p>}
  </div>
);

export default ScoreCard;
