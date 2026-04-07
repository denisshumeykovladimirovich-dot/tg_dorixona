"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.writeAnalyticsEvent = writeAnalyticsEvent;
exports.readStoredAnalyticsEvents = readStoredAnalyticsEvents;
exports.readLiveMappedEvents = readLiveMappedEvents;
exports.readAllAnalyticsEvents = readAllAnalyticsEvents;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const ids_1 = require("../utils/ids");
const analyticsPath = path_1.default.resolve(process.cwd(), "data", "analytics-events.jsonl");
const liveLogPath = path_1.default.resolve(process.cwd(), "data", "live_interactions.log");
function ensureDataDir() {
    fs_1.default.mkdirSync(path_1.default.resolve(process.cwd(), "data"), { recursive: true });
}
function safeParseLine(line) {
    try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed === "object") {
            return parsed;
        }
    }
    catch {
        // ignore invalid line
    }
    return null;
}
function readJsonLines(filePath) {
    if (!fs_1.default.existsSync(filePath)) {
        return [];
    }
    return fs_1.default
        .readFileSync(filePath, "utf-8")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map(safeParseLine)
        .filter((line) => Boolean(line));
}
function normalizedText(value) {
    return typeof value === "string" ? value.trim() : "";
}
function tsFromInput(value) {
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
function buildSessionKey(userId, timestamp) {
    const day = new Date(timestamp).toISOString().slice(0, 10);
    return `${userId}-${day}`;
}
function mapLiveEvent(raw) {
    const type = normalizedText(raw.event);
    const userId = normalizedText(raw.userId) || "unknown";
    const timestamp = tsFromInput(raw.timestamp);
    const sessionId = normalizedText(raw.sessionId) || buildSessionKey(userId, timestamp);
    const resultSummary = raw.resultSummary && typeof raw.resultSummary === "object"
        ? raw.resultSummary
        : {};
    const base = (eventType, payload = {}) => ({
        id: `live-${(0, ids_1.shortId)()}`,
        type: eventType,
        userId,
        timestamp,
        sessionId,
        payload
    });
    if (type === "session_started") {
        return [base("start_bot")];
    }
    if (type === "symptom_detail_selected" || type === "symptom_manual_entered") {
        const symptom = normalizedText(raw.selectedSymptom) || normalizedText(raw.rawInput) || normalizedText(raw.symptoms);
        return [base("select_symptom", { symptom })];
    }
    if (type === "drug_selected" || type === "drug_manual_entered") {
        const medication = normalizedText(raw.selectedDrugName) || normalizedText(raw.rawInput) || normalizedText(raw.medication);
        return [
            base("enter_medication", { medication }),
            base("recommendation_clicked", { medication })
        ];
    }
    if (type === "drug_suggestion_shown") {
        const suggested = Array.isArray(resultSummary.suggestedNames) ? resultSummary.suggestedNames : [];
        return [base("recommendation_shown", { recommendations: suggested })];
    }
    if (type === "combination_check_completed") {
        return [
            base("analysis_view", {
                medications: Array.isArray(resultSummary.final_analysis_medications)
                    ? resultSummary.final_analysis_medications
                    : [],
                status: normalizedText(resultSummary.status)
            })
        ];
    }
    if (type === "buy_clicked") {
        const medication = normalizedText(raw.drugName);
        return [base("click_apteka", { medication })];
    }
    return [];
}
function writeAnalyticsEvent(event) {
    ensureDataDir();
    fs_1.default.appendFileSync(analyticsPath, `${JSON.stringify(event)}\n`, "utf-8");
}
function readStoredAnalyticsEvents() {
    return readJsonLines(analyticsPath)
        .map((row) => {
        const type = normalizedText(row.type);
        if (!type) {
            return null;
        }
        return {
            id: normalizedText(row.id) || (0, ids_1.shortId)(),
            type,
            userId: normalizedText(row.userId) || "unknown",
            timestamp: tsFromInput(row.timestamp),
            sessionId: normalizedText(row.sessionId) ||
                buildSessionKey(normalizedText(row.userId) || "unknown", tsFromInput(row.timestamp)),
            payload: row.payload && typeof row.payload === "object" ? row.payload : {}
        };
    })
        .filter((event) => Boolean(event));
}
function readLiveMappedEvents() {
    return readJsonLines(liveLogPath).flatMap((row) => mapLiveEvent(row));
}
function readAllAnalyticsEvents() {
    return [...readStoredAnalyticsEvents(), ...readLiveMappedEvents()].sort((a, b) => a.timestamp - b.timestamp);
}
