import { shortId } from "../utils/ids";
import { randomUUID } from "crypto";
import { writeAnalyticsEvent } from "./storage";
import type { AnalyticsEvent, AnalyticsEventType } from "./types";

type LoggerInput = {
  type: AnalyticsEventType;
  userId: string | number;
  sessionId?: string;
  timestamp?: number;
  payload?: Record<string, unknown>;
};

export function logAnalyticsEvent(input: LoggerInput): AnalyticsEvent {
  const timestamp = input.timestamp ?? Date.now();
  const userId = String(input.userId);
  const sessionId = input.sessionId || randomUUID();
  const event: AnalyticsEvent = {
    id: shortId(),
    type: input.type,
    userId,
    timestamp,
    sessionId,
    payload: input.payload || {}
  };
  writeAnalyticsEvent(event);
  return event;
}
