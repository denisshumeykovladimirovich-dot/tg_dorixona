"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.mirrorBotEventToAnalytics = mirrorBotEventToAnalytics;
const logger_1 = require("./logger");
function asString(value) {
    return typeof value === "string" ? value.trim() : "";
}
function getNumber(value) {
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
function mirrorBotEventToAnalytics(event, payload) {
    const userId = getNumber(payload.userId);
    if (!userId) {
        return;
    }
    if (event === "session_started") {
        (0, logger_1.logAnalyticsEvent)({ type: "start_bot", userId });
        return;
    }
    if (event === "symptom_detail_selected" || event === "symptom_manual_entered") {
        (0, logger_1.logAnalyticsEvent)({
            type: "select_symptom",
            userId,
            payload: {
                symptom: asString(payload.selectedSymptom) || asString(payload.rawInput)
            }
        });
        return;
    }
    if (event === "drug_selected" || event === "drug_manual_entered") {
        const medication = asString(payload.selectedDrugName) || asString(payload.rawInput);
        (0, logger_1.logAnalyticsEvent)({
            type: "enter_medication",
            userId,
            payload: { medication }
        });
        (0, logger_1.logAnalyticsEvent)({
            type: "recommendation_clicked",
            userId,
            payload: { medication }
        });
        return;
    }
    if (event === "drug_suggestion_shown") {
        const resultSummary = payload.resultSummary && typeof payload.resultSummary === "object"
            ? payload.resultSummary
            : {};
        (0, logger_1.logAnalyticsEvent)({
            type: "recommendation_shown",
            userId,
            payload: {
                recommendations: Array.isArray(resultSummary.suggestedNames)
                    ? resultSummary.suggestedNames
                    : []
            }
        });
        return;
    }
    if (event === "combination_check_completed") {
        const resultSummary = payload.resultSummary && typeof payload.resultSummary === "object"
            ? payload.resultSummary
            : {};
        (0, logger_1.logAnalyticsEvent)({
            type: "analysis_view",
            userId,
            payload: {
                medications: Array.isArray(resultSummary.final_analysis_medications)
                    ? resultSummary.final_analysis_medications
                    : [],
                status: asString(resultSummary.status)
            }
        });
        return;
    }
    if (event === "buy_clicked") {
        (0, logger_1.logAnalyticsEvent)({
            type: "click_apteka",
            userId,
            payload: { medication: asString(payload.drugName) }
        });
    }
}
