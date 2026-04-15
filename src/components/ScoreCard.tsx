interface Props {
  title: string;
  value: string | number;
  subtitle?: string;
  color?: "primary" | "success" | "warning" | "destructive";
}

const colorMap = {
  primary: "text-primary",
  success: "text-success",
  warning: "text-warning",
  destructive: "text-destructive",
};

const ScoreCard = ({ title, value, subtitle, color = "primary" }: Props) => (
  <div className="glass rounded-xl border border-border p-4 border-glow">
    <p className="text-xs text-muted-foreground uppercase tracking-wider">{title}</p>
    <p className={`text-2xl font-bold font-mono mt-1 ${colorMap[color]}`}>{value}</p>
    {subtitle && <p className="text-xs text-muted-foreground mt-1">{subtitle}</p>}
  </div>
);

export default ScoreCard;
