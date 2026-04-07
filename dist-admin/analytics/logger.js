"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.logAnalyticsEvent = logAnalyticsEvent;
const ids_1 = require("../utils/ids");
const storage_1 = require("./storage");
function logAnalyticsEvent(input) {
    const timestamp = input.timestamp ?? Date.now();
    const userId = String(input.userId);
    const sessionId = input.sessionId || `${userId}-${new Date(timestamp).toISOString().slice(0, 10)}`;
    const event = {
        id: (0, ids_1.shortId)(),
        type: input.type,
        userId,
        timestamp,
        sessionId,
        payload: input.payload || {}
    };
    (0, storage_1.writeAnalyticsEvent)(event);
    return event;
}
