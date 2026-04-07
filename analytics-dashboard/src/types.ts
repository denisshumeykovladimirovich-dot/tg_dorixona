export type PeriodKey = "7d" | "30d" | "all";

export type DashboardSummary = {
  generatedAt: string;
  period: PeriodKey;
  hero: {
    totalUsers: number;
    activeUsers7d: number;
    returningUsers: number;
    aptekaClicks: number;
    aptekaCtr: number;
    avgAnalysesPerUser: number;
  };
  activity: Array<{
    date: string;
    users: number;
    analyses: number;
    aptekaClicks: number;
  }>;
  returning: {
    newUsers: number;
    returningUsers: number;
    returningShare: number;
  };
  funnel: Array<{
    step: string;
    count: number;
    conversionFromPrev: number;
  }>;
  topSymptoms: Array<{
    symptom: string;
    count: number;
    share: number;
  }>;
  topDrugs: Array<{
    drug: string;
    searched: number;
    recommended: number;
    aptekaClicks: number;
  }>;
  symptomDrugMatrix: Array<{
    symptom: string;
    drug: string;
    count: number;
  }>;
  pharmacyValue: {
    aptekaClicks: number;
    ctr: number;
    topDrugsByClicks: Array<{ drug: string; clicks: number }>;
    topSymptomsByClicks: Array<{ symptom: string; clicks: number }>;
    assumedConversionRate: number;
    estimatedOrders: number;
  };
  pharmaValue: {
    topSymptoms: Array<{ symptom: string; count: number; share: number }>;
    topSearchedDrugs: Array<{ drug: string; count: number }>;
    topRecommendedDrugs: Array<{ drug: string; count: number }>;
    topSymptomDrugPairs: Array<{ symptom: string; drug: string; count: number }>;
    potentialRecommendationExposure: number;
  };
  latestEvents: Array<{
    id: string;
    type: string;
    userId: string;
    timestamp: number;
    sessionId: string;
    payload: Record<string, unknown>;
  }>;
};

