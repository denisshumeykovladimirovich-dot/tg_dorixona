import type {
  ActivityPoint,
  AnalyticsEvent,
  DashboardSummary,
  FunnelStep,
  PeriodKey,
  SymptomDrugMatrixItem,
  TopDrugItem,
  TopSymptomItem
} from "./types";

function periodDays(period: PeriodKey): number | null {
  if (period === "7d") return 7;
  if (period === "30d") return 30;
  return null;
}

function tsInPeriod(timestamp: number, period: PeriodKey): boolean {
  const days = periodDays(period);
  if (!days) return true;
  return timestamp >= Date.now() - days * 24 * 60 * 60 * 1000;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function safeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function eventSymptom(event: AnalyticsEvent): string {
  return safeText(event.payload.value) || safeText(event.payload.symptom) || safeText(event.payload.selectedSymptom);
}

function eventDrug(event: AnalyticsEvent): string {
  return safeText(event.payload.medication) || safeText(event.payload.drugName) || safeText(event.payload.drug);
}

function addCount(map: Map<string, number>, key: string, by = 1): void {
  if (!key) return;
  map.set(key, (map.get(key) || 0) + by);
}

function topSymptoms(items: AnalyticsEvent[]): TopSymptomItem[] {
  const counts = new Map<string, number>();
  const total = items.length || 1;
  for (const event of items) {
    addCount(counts, eventSymptom(event));
  }
  return Array.from(counts.entries())
    .map(([symptom, count]) => ({ symptom, count, share: round2((count / total) * 100) }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
}

function topDrugs(events: AnalyticsEvent[]): TopDrugItem[] {
  const map = new Map<string, TopDrugItem>();
  const ensure = (name: string): TopDrugItem => {
    const key = name.toLowerCase();
    const existing = map.get(key);
    if (existing) return existing;
    const created: TopDrugItem = { drug: name, searched: 0, recommended: 0, aptekaClicks: 0 };
    map.set(key, created);
    return created;
  };

  for (const event of events) {
    if (event.type === "drug_selected") {
      const drug = eventDrug(event);
      if (drug) ensure(drug).searched += 1;
    }
    if (event.type === "analysis_completed" || event.type === "analysis_generated") {
      const recs = Array.isArray(event.payload.drugs) ? event.payload.drugs : [];
      for (const rec of recs) {
        const drug = safeText(rec);
        if (drug) ensure(drug).recommended += 1;
      }
    }
    if (event.type === "buy_click" || event.type === "buy_clicked") {
      const drug = eventDrug(event);
      if (drug) ensure(drug).aptekaClicks += 1;
    }
  }

  return Array.from(map.values())
    .sort((a, b) => b.searched + b.recommended + b.aptekaClicks - (a.searched + a.recommended + a.aptekaClicks))
    .slice(0, 10);
}

function buildActivity(events: AnalyticsEvent[]): ActivityPoint[] {
  const byDate = new Map<string, ActivityPoint & { usersSet: Set<string> }>();
  for (const event of events) {
    const date = new Date(event.timestamp).toISOString().slice(0, 10);
    const existing = byDate.get(date) || { date, users: 0, analyses: 0, aptekaClicks: 0, usersSet: new Set<string>() };
    existing.usersSet.add(event.userId);
    if (event.type === "analysis_completed" || event.type === "analysis_generated") {
      existing.analyses += 1;
    }
    if (event.type === "buy_click" || event.type === "buy_clicked") {
      existing.aptekaClicks += 1;
    }
    byDate.set(date, existing);
  }
  return Array.from(byDate.values())
    .map((item) => ({
      date: item.date,
      users: item.usersSet.size,
      analyses: item.analyses,
      aptekaClicks: item.aptekaClicks
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function buildFunnel(events: AnalyticsEvent[]): FunnelStep[] {
  const sessionsByStep = {
    symptom: new Set<string>(),
    medication: new Set<string>(),
    analysis: new Set<string>(),
    apteka: new Set<string>()
  };

  for (const event of events) {
    if (event.type === "symptom_selected") sessionsByStep.symptom.add(event.sessionId);
    if (event.type === "drug_selected") sessionsByStep.medication.add(event.sessionId);
    if (event.type === "analysis_completed" || event.type === "analysis_generated") sessionsByStep.analysis.add(event.sessionId);
    if (event.type === "buy_click" || event.type === "buy_clicked") sessionsByStep.apteka.add(event.sessionId);
  }

  const list: Array<{ step: string; count: number }> = [
    { step: "Симптом", count: sessionsByStep.symptom.size },
    { step: "Ввод препарата", count: sessionsByStep.medication.size },
    { step: "Просмотр анализа", count: sessionsByStep.analysis.size },
    { step: "Переход в аптеку", count: sessionsByStep.apteka.size }
  ];

  return list.map((item, idx) => {
    if (idx === 0) {
      return { ...item, conversionFromPrev: 100 };
    }
    const prev = list[idx - 1].count || 1;
    return {
      ...item,
      conversionFromPrev: round2((item.count / prev) * 100)
    };
  });
}

function buildMatrix(events: AnalyticsEvent[]): SymptomDrugMatrixItem[] {
  const sessionSymptom = new Map<string, string>();
  const sessionDrug = new Map<string, string>();
  const counts = new Map<string, number>();

  for (const event of events) {
    if (event.type === "symptom_selected") {
      const symptom = eventSymptom(event);
      if (symptom) {
        sessionSymptom.set(event.sessionId, symptom);
      }
    }
    if (event.type === "drug_selected" || event.type === "buy_click" || event.type === "buy_clicked") {
      const drug = eventDrug(event);
      if (drug) {
        sessionDrug.set(event.sessionId, drug);
      }
    }
    const symptom = sessionSymptom.get(event.sessionId);
    const drug = sessionDrug.get(event.sessionId);
    if (symptom && drug) {
      addCount(counts, `${symptom}|||${drug}`);
    }
  }

  return Array.from(counts.entries())
    .map(([key, count]) => {
      const [symptom, drug] = key.split("|||");
      return { symptom, drug, count };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, 15);
}

function returningBreakdown(events: AnalyticsEvent[]): { newUsers: number; returningUsers: number; returningShare: number } {
  const sessionsPerUser = new Map<string, Set<string>>();
  for (const event of events) {
    if (event.type !== "session_started") continue;
    const set = sessionsPerUser.get(event.userId) || new Set<string>();
    set.add(event.sessionId);
    sessionsPerUser.set(event.userId, set);
  }

  let newUsers = 0;
  let returningUsers = 0;
  for (const sessions of sessionsPerUser.values()) {
    if (sessions.size > 1) returningUsers += 1;
    else newUsers += 1;
  }
  const total = newUsers + returningUsers || 1;
  return {
    newUsers,
    returningUsers,
    returningShare: round2((returningUsers / total) * 100)
  };
}

function pharmacyValue(events: AnalyticsEvent[], symptoms: TopSymptomItem[], drugs: TopDrugItem[]) {
  const aptekaClicks = events.filter((event) => event.type === "buy_click" || event.type === "buy_clicked").length;
  const analyses = events.filter((event) => event.type === "analysis_completed" || event.type === "analysis_generated").length;
  const ctr = round2((aptekaClicks / (analyses || 1)) * 100);

  const symptomClicksMap = new Map<string, number>();
  const sessionSymptom = new Map<string, string>();
  for (const event of events) {
    if (event.type === "symptom_selected") {
      const symptom = eventSymptom(event);
      if (symptom) sessionSymptom.set(event.sessionId, symptom);
    }
    if (event.type === "buy_click" || event.type === "buy_clicked") {
      const symptom = sessionSymptom.get(event.sessionId);
      if (symptom) addCount(symptomClicksMap, symptom);
    }
  }

  const topSymptomsByClicks = Array.from(symptomClicksMap.entries())
    .map(([symptom, clicks]) => ({ symptom, clicks }))
    .sort((a, b) => b.clicks - a.clicks)
    .slice(0, 5);

  const topDrugsByClicks = drugs
    .map((item) => ({ drug: item.drug, clicks: item.aptekaClicks }))
    .sort((a, b) => b.clicks - a.clicks)
    .slice(0, 5);

  const assumedConversionRate = 0.22;
  const estimatedOrders = round2(aptekaClicks * assumedConversionRate);

  return {
    aptekaClicks,
    ctr,
    topDrugsByClicks,
    topSymptomsByClicks,
    assumedConversionRate,
    estimatedOrders
  };
}

function pharmaValue(events: AnalyticsEvent[], symptoms: TopSymptomItem[], drugs: TopDrugItem[], matrix: SymptomDrugMatrixItem[]) {
  const searched = drugs
    .map((item) => ({ drug: item.drug, count: item.searched }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);
  const recommended = drugs
    .map((item) => ({ drug: item.drug, count: item.recommended }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  return {
    topSymptoms: symptoms.slice(0, 8),
    topSearchedDrugs: searched,
    topRecommendedDrugs: recommended,
    topSymptomDrugPairs: matrix.slice(0, 8),
    potentialRecommendationExposure: events.filter((event) => event.type === "analysis_completed" || event.type === "analysis_generated").length
  };
}

export function buildDashboardSummary(allEvents: AnalyticsEvent[], period: PeriodKey): DashboardSummary {
  const canonicalEvents = allEvents.filter((event) =>
    [
      "session_started",
      "button_clicked",
      "symptom_selected",
      "drug_selected",
      "analysis_completed",
      "buy_click",
      "brand_recommended",
      "brand_selected_after_analysis",
      "analysis_failed",
      "analysis_generated",
      "buy_clicked",
      "product_error_logged"
    ].includes(event.type)
  );
  const events = canonicalEvents.filter((event) => tsInPeriod(event.timestamp, period));
  const totalUsers = new Set(events.map((event) => event.userId)).size;
  const activeUsers7d = new Set(
    canonicalEvents
      .filter((event) => event.timestamp >= Date.now() - 7 * 24 * 60 * 60 * 1000)
      .map((event) => event.userId)
  ).size;
  const returning = returningBreakdown(events);
  const analyses = events.filter((event) => event.type === "analysis_completed" || event.type === "analysis_generated").length;
  const aptekaClicks = events.filter((event) => event.type === "buy_click" || event.type === "buy_clicked").length;

  const symptomEvents = events.filter((event) => event.type === "symptom_selected");
  const symptomTop = topSymptoms(symptomEvents);
  const drugTop = topDrugs(events);
  const matrix = buildMatrix(events);

  return {
    generatedAt: new Date().toISOString(),
    period,
    hero: {
      totalUsers,
      activeUsers7d,
      returningUsers: returning.returningUsers,
      aptekaClicks,
      aptekaCtr: round2((aptekaClicks / (analyses || 1)) * 100),
      avgAnalysesPerUser: round2(analyses / (totalUsers || 1))
    },
    activity: buildActivity(events),
    returning,
    funnel: buildFunnel(events),
    topSymptoms: symptomTop,
    topDrugs: drugTop,
    symptomDrugMatrix: matrix,
    pharmacyValue: pharmacyValue(events, symptomTop, drugTop),
    pharmaValue: pharmaValue(events, symptomTop, drugTop, matrix),
    latestEvents: [...events].sort((a, b) => b.timestamp - a.timestamp).slice(0, 25)
  };
}
