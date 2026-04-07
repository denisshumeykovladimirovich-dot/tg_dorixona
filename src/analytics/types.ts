export type AnalyticsEventType =
  // Canonical schema (v1, source-of-truth for analytics)
  | "session_started"
  | "button_clicked"
  | "symptom_selected"
  | "drug_selected"
  | "analysis_completed"
  | "brand_recommended"
  | "brand_selected_after_analysis"
  | "buy_click"
  | "analysis_failed"
  // Legacy events (kept for backward compatibility, not primary for aggregation)
  | "analysis_generated"
  | "buy_clicked"
  | "product_error_logged"
  | "start_bot"
  | "select_symptom"
  | "enter_medication"
  | "analysis_view"
  | "click_apteka"
  | "recommendation_shown"
  | "recommendation_clicked"
  | "return_visit";

export type AnalyticsEvent = {
  id: string;
  type: AnalyticsEventType;
  userId: string;
  timestamp: number;
  sessionId: string;
  payload: Record<string, unknown>;
};

export type PeriodKey = "7d" | "30d" | "all";

export type HeroMetrics = {
  totalUsers: number;
  activeUsers7d: number;
  returningUsers: number;
  aptekaClicks: number;
  aptekaCtr: number;
  avgAnalysesPerUser: number;
};

export type ActivityPoint = {
  date: string;
  users: number;
  analyses: number;
  aptekaClicks: number;
};

export type FunnelStep = {
  step: string;
  count: number;
  conversionFromPrev: number;
};

export type TopSymptomItem = {
  symptom: string;
  count: number;
  share: number;
};

export type TopDrugItem = {
  drug: string;
  searched: number;
  recommended: number;
  aptekaClicks: number;
};

export type SymptomDrugMatrixItem = {
  symptom: string;
  drug: string;
  count: number;
};

export type DashboardSummary = {
  generatedAt: string;
  period: PeriodKey;
  hero: HeroMetrics;
  activity: ActivityPoint[];
  returning: {
    newUsers: number;
    returningUsers: number;
    returningShare: number;
  };
  funnel: FunnelStep[];
  topSymptoms: TopSymptomItem[];
  topDrugs: TopDrugItem[];
  symptomDrugMatrix: SymptomDrugMatrixItem[];
  pharmacyValue: {
    aptekaClicks: number;
    ctr: number;
    topDrugsByClicks: Array<{ drug: string; clicks: number }>;
    topSymptomsByClicks: Array<{ symptom: string; clicks: number }>;
    assumedConversionRate: number;
    estimatedOrders: number;
  };
  pharmaValue: {
    topSymptoms: TopSymptomItem[];
    topSearchedDrugs: Array<{ drug: string; count: number }>;
    topRecommendedDrugs: Array<{ drug: string; count: number }>;
    topSymptomDrugPairs: SymptomDrugMatrixItem[];
    potentialRecommendationExposure: number;
  };
  latestEvents: AnalyticsEvent[];
};
