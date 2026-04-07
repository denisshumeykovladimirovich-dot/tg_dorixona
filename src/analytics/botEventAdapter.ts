import { logAnalyticsEvent } from "./logger";

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function getNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string") {
    const n = Number.parseInt(value, 10);
    if (Number.isFinite(n)) {
      return Math.trunc(n);
    }
  }
  return null;
}

export function mirrorBotEventToAnalytics(
  event: string,
  payload: Record<string, unknown>
): void {
  const userId = getNumber(payload.userId);
  if (!userId) {
    return;
  }
  const sessionId = asString(payload.sessionId) || undefined;

  if (event === "session_started") {
    logAnalyticsEvent({ type: "session_started", userId, sessionId });
    return;
  }

  if (event === "button_clicked") {
    logAnalyticsEvent({
      type: "button_clicked",
      userId,
      sessionId,
      payload: {
        button_key: asString(payload.buttonKey),
        scope: asString(payload.scope),
        value: asString(payload.value)
      }
    });
    return;
  }

  if (event === "symptom_category_selected") {
    logAnalyticsEvent({
      type: "symptom_selected",
      userId,
      sessionId,
      payload: {
        type: "category",
        value: asString(payload.selectedSymptomCategory)
      }
    });
    return;
  }

  if (event === "symptom_detail_selected") {
    logAnalyticsEvent({
      type: "symptom_selected",
      userId,
      sessionId,
      payload: {
        type: "detail",
        value: asString(payload.selectedSymptom)
      }
    });
    return;
  }

  if (event === "drug_selected") {
    logAnalyticsEvent({
      type: "drug_selected",
      userId,
      sessionId,
      payload: {
        medication: asString(payload.selectedDrugName)
      }
    });
    return;
  }

  if (event === "combination_check_completed") {
    const resultSummary =
      payload.resultSummary && typeof payload.resultSummary === "object"
        ? (payload.resultSummary as Record<string, unknown>)
        : {};
    const analysisMode = asString(resultSummary.analysis_mode) || "full_combo";
    const recommended = Array.isArray(resultSummary.final_analysis_medications)
      ? resultSummary.final_analysis_medications.filter((item) => typeof item === "string" && item.trim())
      : [];
    const riskLevel = asString(resultSummary.status);
    const reason =
      riskLevel === "safe"
        ? "safer"
        : riskLevel === "caution" || riskLevel === "attention"
          ? "fewer_conflicts"
          : "fits_symptom";

    logAnalyticsEvent({
      type: "analysis_completed",
      userId,
      sessionId,
      payload: {
        drugs: recommended,
        risk_level: riskLevel,
        analysis_mode: analysisMode
      }
    });
    for (const drug of recommended) {
      logAnalyticsEvent({
        type: "brand_recommended",
        userId,
        sessionId,
        payload: {
          drug,
          reason
        }
      });
    }
    return;
  }

  if (event === "buy_clicked") {
    logAnalyticsEvent({
      type: "buy_click",
      userId,
      sessionId,
      payload: {
        medication: asString(payload.drugName)
      }
    });
    logAnalyticsEvent({
      type: "brand_selected_after_analysis",
      userId,
      sessionId,
      payload: {
        drug: asString(payload.drugName),
        source_event: "buy_clicked"
      }
    });
    return;
  }

  if (event === "flow_error" || event === "callback_error") {
    logAnalyticsEvent({
      type: "analysis_failed",
      userId,
      sessionId,
      payload: {
        error_type: event,
        message: asString(payload.errorMessage),
        current_step: asString(payload.currentStep),
        callback_data: asString(payload.callbackData)
      }
    });
  }
}
