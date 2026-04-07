import { logAnalyticsEvent } from "../analytics/logger";

export function trackEvent(userId: number, action: string, payload: Record<string, any> = {}) {
  logAnalyticsEvent({
    type: "button_clicked",
    userId,
    payload: {
      button_key: action,
      scope: "tracking_proxy",
      value:
        typeof payload?.cardId === "string" || typeof payload?.cardId === "number"
          ? String(payload.cardId)
          : "",
      tracking_payload: payload
    }
  });
}
