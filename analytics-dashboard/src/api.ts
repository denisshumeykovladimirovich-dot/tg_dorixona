import type { DashboardSummary, PeriodKey } from "./types";

const API_BASE = import.meta.env.VITE_ANALYTICS_API_BASE || "http://localhost:4010";
const USE_MOCK = (import.meta.env.VITE_ANALYTICS_MODE || "mock") !== "api";

const BASE_ACTIVITY = [
  { date: "2026-03-22", users: 72, analyses: 98, aptekaClicks: 21 },
  { date: "2026-03-23", users: 81, analyses: 110, aptekaClicks: 25 },
  { date: "2026-03-24", users: 86, analyses: 122, aptekaClicks: 27 },
  { date: "2026-03-25", users: 94, analyses: 134, aptekaClicks: 30 },
  { date: "2026-03-26", users: 101, analyses: 143, aptekaClicks: 34 },
  { date: "2026-03-27", users: 109, analyses: 156, aptekaClicks: 38 },
  { date: "2026-03-28", users: 121, analyses: 172, aptekaClicks: 44 },
  { date: "2026-03-29", users: 117, analyses: 168, aptekaClicks: 41 },
  { date: "2026-03-30", users: 128, analyses: 181, aptekaClicks: 46 },
  { date: "2026-03-31", users: 134, analyses: 191, aptekaClicks: 50 },
  { date: "2026-04-01", users: 146, analyses: 205, aptekaClicks: 56 },
  { date: "2026-04-02", users: 151, analyses: 214, aptekaClicks: 59 },
  { date: "2026-04-03", users: 158, analyses: 224, aptekaClicks: 64 }
];

function activityForPeriod(period: PeriodKey): DashboardSummary["activity"] {
  if (period === "7d") {
    return BASE_ACTIVITY.slice(-7);
  }
  if (period === "30d") {
    return BASE_ACTIVITY;
  }
  return [...BASE_ACTIVITY, ...BASE_ACTIVITY.map((row, idx) => ({
    date: `2026-02-${String((idx % 28) + 1).padStart(2, "0")}`,
    users: Math.max(40, row.users - 22),
    analyses: Math.max(60, row.analyses - 30),
    aptekaClicks: Math.max(10, row.aptekaClicks - 8)
  }))];
}

function sum<T>(rows: T[], pick: (row: T) => number): number {
  return rows.reduce((acc, row) => acc + pick(row), 0);
}

function mockSummary(period: PeriodKey): DashboardSummary {
  const activity = activityForPeriod(period);
  const totalUsers = period === "all" ? 8420 : period === "30d" ? 2480 : 730;
  const activeUsers7d = sum(activity.slice(-7), (row) => row.users);
  const aptekaClicks = sum(activity, (row) => row.aptekaClicks);
  const analyses = sum(activity, (row) => row.analyses);
  const returningUsers = Math.round(totalUsers * 0.38);

  return {
    generatedAt: new Date().toISOString(),
    period,
    hero: {
      totalUsers,
      activeUsers7d,
      returningUsers,
      aptekaClicks,
      aptekaCtr: Number(((aptekaClicks / analyses) * 100).toFixed(1)),
      avgAnalysesPerUser: Number((analyses / totalUsers).toFixed(2))
    },
    activity,
    returning: {
      newUsers: totalUsers - returningUsers,
      returningUsers,
      returningShare: Number(((returningUsers / totalUsers) * 100).toFixed(1))
    },
    funnel: [
      { step: "Start", count: totalUsers, conversionFromPrev: 100 },
      { step: "Symptom", count: Math.round(totalUsers * 0.78), conversionFromPrev: 78 },
      { step: "Analysis", count: Math.round(totalUsers * 0.62), conversionFromPrev: 79 },
      { step: "Recommendation", count: Math.round(totalUsers * 0.51), conversionFromPrev: 82 },
      { step: "Apteka Click", count: Math.round(totalUsers * 0.26), conversionFromPrev: 51 }
    ],
    topSymptoms: [
      { symptom: "Головная боль", count: 412, share: 15.8 },
      { symptom: "Простуда", count: 386, share: 14.8 },
      { symptom: "Боль в горле", count: 301, share: 11.6 },
      { symptom: "Кашель", count: 278, share: 10.7 },
      { symptom: "Температура", count: 261, share: 10.0 }
    ],
    topDrugs: [
      { drug: "Парацетамол", searched: 420, recommended: 371, aptekaClicks: 148 },
      { drug: "Ибупрофен", searched: 398, recommended: 346, aptekaClicks: 139 },
      { drug: "Нурофен", searched: 344, recommended: 291, aptekaClicks: 120 },
      { drug: "Терафлю", searched: 289, recommended: 247, aptekaClicks: 104 },
      { drug: "Амброксол", searched: 253, recommended: 219, aptekaClicks: 92 }
    ],
    symptomDrugMatrix: [
      { symptom: "Головная боль", drug: "Ибупрофен", count: 132 },
      { symptom: "Головная боль", drug: "Парацетамол", count: 121 },
      { symptom: "Простуда", drug: "Терафлю", count: 118 },
      { symptom: "Кашель", drug: "Амброксол", count: 109 },
      { symptom: "Боль в горле", drug: "Стрепсилс", count: 97 }
    ],
    pharmacyValue: {
      aptekaClicks,
      ctr: Number(((aptekaClicks / analyses) * 100).toFixed(1)),
      topDrugsByClicks: [
        { drug: "Парацетамол", clicks: 148 },
        { drug: "Ибупрофен", clicks: 139 },
        { drug: "Нурофен", clicks: 120 }
      ],
      topSymptomsByClicks: [
        { symptom: "Головная боль", clicks: 176 },
        { symptom: "Простуда", clicks: 149 },
        { symptom: "Кашель", clicks: 123 }
      ],
      assumedConversionRate: 0.32,
      estimatedOrders: Math.round(aptekaClicks * 0.32)
    },
    pharmaValue: {
      topSymptoms: [
        { symptom: "Головная боль", count: 412, share: 15.8 },
        { symptom: "Простуда", count: 386, share: 14.8 },
        { symptom: "Боль в горле", count: 301, share: 11.6 }
      ],
      topSearchedDrugs: [
        { drug: "Парацетамол", count: 420 },
        { drug: "Ибупрофен", count: 398 },
        { drug: "Нурофен", count: 344 }
      ],
      topRecommendedDrugs: [
        { drug: "Парацетамол", count: 371 },
        { drug: "Ибупрофен", count: 346 },
        { drug: "Нурофен", count: 291 }
      ],
      topSymptomDrugPairs: [
        { symptom: "Головная боль", drug: "Ибупрофен", count: 132 },
        { symptom: "Простуда", drug: "Терафлю", count: 118 },
        { symptom: "Кашель", drug: "Амброксол", count: 109 }
      ],
      potentialRecommendationExposure: analyses
    },
    latestEvents: [
      {
        id: "evt-1",
        type: "analysis_completed",
        userId: "u-1042",
        timestamp: Date.now() - 1000 * 60 * 12,
        sessionId: "s-991",
        payload: { symptom: "Головная боль", recommendationCount: 3 }
      },
      {
        id: "evt-2",
        type: "apteka_click",
        userId: "u-1056",
        timestamp: Date.now() - 1000 * 60 * 9,
        sessionId: "s-1004",
        payload: { drug: "Ибупрофен", source: "recommendation" }
      },
      {
        id: "evt-3",
        type: "analysis_completed",
        userId: "u-1074",
        timestamp: Date.now() - 1000 * 60 * 5,
        sessionId: "s-1018",
        payload: { symptom: "Кашель", recommendationCount: 4 }
      }
    ]
  };
}

export async function fetchSummary(period: PeriodKey): Promise<DashboardSummary> {
  if (USE_MOCK) {
    await new Promise((resolve) => setTimeout(resolve, 120));
    return mockSummary(period);
  }
  const response = await fetch(`${API_BASE}/api/analytics/summary?period=${period}`);
  if (!response.ok) {
    throw new Error(`API error: ${response.status}`);
  }
  return (await response.json()) as DashboardSummary;
}

export async function seedDemo(): Promise<void> {
  if (USE_MOCK) {
    return;
  }
  await fetch(`${API_BASE}/api/analytics/seed`, { method: "POST" });
}
