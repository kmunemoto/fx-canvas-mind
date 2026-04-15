export interface AnalysisResult {
  signal: "BUY" | "SELL" | "WAIT";
  confidence: number;
  technical_score: number;
  fundamental_score: number;
  risk_level: "LOW" | "MEDIUM" | "HIGH";
  sentiment: "BULLISH" | "NEUTRAL" | "BEARISH";
  entry_point: string;
  stop_loss: string;
  take_profit_1: string;
  take_profit_2: string;
  risk_reward_ratio: string;
  analysis: string;
  key_factors: string[];
  warnings: string[];
}

export interface AppSettings {
  apiKey: string;
  defaultStopLossPips: number;
  defaultTakeProfitPips: number;
  currencyPair: string;
}

export interface SupplementaryInfo {
  currentRate: string;
  positionPreference: "BUY" | "SELL" | "ANY";
  notes: string;
}
