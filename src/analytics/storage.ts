import fs from "fs";
import path from "path";
import { shortId } from "../utils/ids";
import type { AnalyticsEvent, AnalyticsEventType } from "./types";

const analyticsPath = path.resolve(process.cwd(), "data", "analytics-events.jsonl");

function ensureDataDir(): void {
  fs.mkdirSync(path.resolve(process.cwd(), "data"), { recursive: true });
}

function safeParseLine(line: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(line);
    if (parsed && typeof parsed === "object") {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore invalid line
  }
  return null;
}

function readJsonLines(filePath: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  return fs
    .readFileSync(filePath, "utf-8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(safeParseLine)
    .filter((line): line is Record<string, unknown> => Boolean(line));
}

function normalizedText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function tsFromInput(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string") {
    const asNum = Number.parseInt(value, 10);
    if (Number.isFinite(asNum)) {
      return Math.trunc(asNum);
    }
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return Math.trunc(parsed);
    }
  }
  return Date.now();
}

const LEGACY_TO_CANONICAL_TYPE: Record<string, AnalyticsEventType> = {
  start_bot: "session_started",
  select_symptom: "symptom_selected",
  enter_medication: "drug_selected",
  analysis_view: "analysis_completed",
  analysis_generated: "analysis_completed",
  recommendation_shown: "brand_recommended",
  recommendation_clicked: "brand_selected_after_analysis",
  click_apteka: "buy_click",
  buy_clicked: "buy_click",
  flow_error: "analysis_failed",
  callback_error: "analysis_failed",
  product_error_logged: "analysis_failed"
};

function payloadObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? { ...(value as Record<string, unknown>) } : {};
}

function textFromPayload(payload: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function stringArrayFromPayload(payload: Record<string, unknown>, ...keys: string[]): string[] {
  for (const key of keys) {
    const value = payload[key];
    if (!Array.isArray(value)) {
      continue;
    }
    const items = value
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter(Boolean);
    if (items.length > 0) {
      return items;
    }
  }
  return [];
}

export function toCanonicalEvent(event: AnalyticsEvent): AnalyticsEvent {
  const canonicalType = LEGACY_TO_CANONICAL_TYPE[event.type] || event.type;
  const normalizedPayload = payloadObject(event.payload);

  if (canonicalType !== event.type) {
    normalizedPayload.legacy_type = event.type;
  }

  const symptom = textFromPayload(normalizedPayload, "symptom", "value", "selectedSymptom", "selectedSymptomCategory");
  if (symptom) {
    normalizedPayload.symptom = symptom;
  }

  const medication = textFromPayload(normalizedPayload, "medication", "drugName", "selectedDrugName");
  if (medication) {
    normalizedPayload.medication = medication;
  }

  const drugs = stringArrayFromPayload(normalizedPayload, "drugs", "final_analysis_medications");
  if (drugs.length > 0) {
    normalizedPayload.drugs = drugs;
  }

  const riskLevel = textFromPayload(normalizedPayload, "risk_level", "status");
  if (riskLevel) {
    normalizedPayload.risk_level = riskLevel;
  }

  return {
    ...event,
    type: canonicalType,
    payload: normalizedPayload
  };
}

export function writeAnalyticsEvent(event: AnalyticsEvent): void {
  ensureDataDir();
  fs.appendFileSync(analyticsPath, `${JSON.stringify(toCanonicalEvent(event))}\n`, "utf-8");
}

export function readStoredAnalyticsEvents(): AnalyticsEvent[] {
  return readJsonLines(analyticsPath)
    .map((row) => {
      const type = normalizedText(row.type) as AnalyticsEvent["type"];
      if (!type) {
        return null;
      }
      const eventId = normalizedText(row.id) || shortId();
      return {
        id: eventId,
        type,
        userId: normalizedText(row.userId) || "unknown",
        timestamp: tsFromInput(row.timestamp),
        sessionId: normalizedText(row.sessionId) || `legacy-${eventId}`,
        payload: row.payload && typeof row.payload === "object" ? (row.payload as Record<string, unknown>) : {}
      } satisfies AnalyticsEvent;
    })
    .filter((event): event is AnalyticsEvent => Boolean(event));
}

export function readLiveMappedEvents(): AnalyticsEvent[] {
  return [];
}

export function readAllAnalyticsEvents(): AnalyticsEvent[] {
  return [...readStoredAnalyticsEvents()].sort((a, b) => a.timestamp - b.timestamp);
}
