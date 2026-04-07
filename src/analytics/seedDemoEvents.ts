import { shortId } from "../utils/ids";
import { readAllAnalyticsEvents, writeAnalyticsEvent } from "./storage";
import type { AnalyticsEvent } from "./types";

type CanonicalCounters = {
  users: number;
  analyses: number;
  recommendations: number;
  selections: number;
  buys: number;
};

const DEMO_TARGET: CanonicalCounters = {
  users: 850,
  analyses: 1240,
  recommendations: 780,
  selections: 214,
  buys: 154
};

const SYMPTOMS = [
  "headache",
  "fever",
  "sore_throat",
  "cough",
  "runny_nose",
  "allergy",
  "stomach_pain"
];

const DRUGS = [
  "paracetamol",
  "ibuprofen",
  "ambroxol",
  "cetirizine",
  "nurofen",
  "rinza",
  "linex"
];

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pick<T>(arr: T[]): T {
  return arr[randInt(0, arr.length - 1)];
}

function asSetCount(events: AnalyticsEvent[]): number {
  return new Set(events.map((event) => event.userId)).size;
}

function isAnalysis(event: AnalyticsEvent): boolean {
  return event.type === "analysis_completed" || event.type === "analysis_generated";
}

function isRecommendation(event: AnalyticsEvent): boolean {
  return event.type === "brand_recommended" || event.type === "recommendation_shown";
}

function isSelection(event: AnalyticsEvent): boolean {
  return event.type === "brand_selected_after_analysis" || event.type === "recommendation_clicked";
}

function isBuy(event: AnalyticsEvent): boolean {
  return event.type === "buy_click" || event.type === "buy_clicked";
}

function countCanonical(events: AnalyticsEvent[]): CanonicalCounters {
  return {
    users: asSetCount(events),
    analyses: events.filter(isAnalysis).length,
    recommendations: events.filter(isRecommendation).length,
    selections: events.filter(isSelection).length,
    buys: events.filter(isBuy).length
  };
}

function needsTopUp(current: CanonicalCounters): boolean {
  return (
    current.users < DEMO_TARGET.users ||
    current.analyses < DEMO_TARGET.analyses ||
    current.recommendations < DEMO_TARGET.recommendations ||
    current.selections < DEMO_TARGET.selections ||
    current.buys < DEMO_TARGET.buys
  );
}

function createEvent(
  type: AnalyticsEvent["type"],
  userId: string,
  sessionId: string,
  timestamp: number,
  payload: Record<string, unknown>
): AnalyticsEvent {
  return {
    id: `seed-${shortId()}`,
    type,
    userId,
    timestamp,
    sessionId,
    payload
  };
}

export function ensureDemoEvents(): { created: number; total: number } {
  const before = readAllAnalyticsEvents();
  const current = countCanonical(before);

  if (!needsTopUp(current)) {
    return { created: 0, total: before.length };
  }

  const now = Date.now();
  const toWrite: AnalyticsEvent[] = [];
  const syntheticUsers: string[] = [];

  let users = current.users;
  let analyses = current.analyses;
  let recommendations = current.recommendations;
  let selections = current.selections;
  let buys = current.buys;

  let sequence = 1;

  const addSession = (userId: string, allowSelectionAndBuy: boolean): void => {
    const sessionId = `${userId}-demo-${sequence++}`;
    const dayOffset = randInt(0, 29);
    const baseTs = now - dayOffset * 24 * 60 * 60 * 1000 + randInt(7, 22) * 60 * 60 * 1000;
    const symptom = pick(SYMPTOMS);
    const drug = pick(DRUGS);

    toWrite.push(createEvent("session_started", userId, sessionId, baseTs, {}));
    toWrite.push(createEvent("symptom_selected", userId, sessionId, baseTs + randInt(15, 90), {
      type: "detail",
      value: symptom,
      symptom
    }));
    toWrite.push(createEvent("drug_selected", userId, sessionId, baseTs + randInt(40, 130), {
      medication: drug
    }));

    if (analyses < DEMO_TARGET.analyses) {
      toWrite.push(createEvent("analysis_completed", userId, sessionId, baseTs + randInt(80, 180), {
        drugs: [drug],
        risk_level: pick(["safe", "caution", "attention"]),
        analysis_mode: "full_combo"
      }));
      analyses += 1;
    }

    if (recommendations < DEMO_TARGET.recommendations) {
      toWrite.push(createEvent("brand_recommended", userId, sessionId, baseTs + randInt(90, 200), {
        drug,
        reason: pick(["safer", "fits_symptom", "fewer_conflicts"])
      }));
      recommendations += 1;
    }

    if (allowSelectionAndBuy && selections < DEMO_TARGET.selections) {
      toWrite.push(createEvent("brand_selected_after_analysis", userId, sessionId, baseTs + randInt(130, 240), {
        drug,
        source_event: "demo_seed"
      }));
      selections += 1;
    }

    if (allowSelectionAndBuy && buys < DEMO_TARGET.buys) {
      toWrite.push(createEvent("buy_click", userId, sessionId, baseTs + randInt(150, 280), {
        medication: drug,
        symptom
      }));
      buys += 1;
    }
  };

  while (users < DEMO_TARGET.users) {
    const userId = `demo-u-${users + 1}`;
    syntheticUsers.push(userId);
    addSession(userId, false);
    users += 1;
  }

  const userPool = syntheticUsers.length
    ? syntheticUsers
    : Array.from(new Set(before.map((event) => event.userId))).slice(0, 100);

  let guard = 0;
  while ((analyses < DEMO_TARGET.analyses || recommendations < DEMO_TARGET.recommendations) && guard < 6000) {
    const userId = userPool.length ? pick(userPool) : `demo-extra-${guard}`;
    addSession(userId, false);
    guard += 1;
  }

  let selectionGuard = 0;
  while ((selections < DEMO_TARGET.selections || buys < DEMO_TARGET.buys) && selectionGuard < 3000) {
    const userId = userPool.length ? pick(userPool) : `demo-buy-${selectionGuard}`;
    addSession(userId, true);
    selectionGuard += 1;
  }

  for (const event of toWrite) {
    writeAnalyticsEvent(event);
  }

  return {
    created: toWrite.length,
    total: readAllAnalyticsEvents().length
  };
}
