"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ensureDemoEvents = ensureDemoEvents;
const ids_1 = require("../utils/ids");
const storage_1 = require("./storage");
const SYMPTOMS = [
    "температура",
    "кашель",
    "боль в горле",
    "насморк",
    "головная боль",
    "аллергия",
    "боль в животе"
];
const DRUGS = [
    "парацетамол",
    "ибупрофен",
    "амброксол",
    "анзибел",
    "цетиризин",
    "нурофен",
    "линекс",
    "ринза"
];
function randInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}
function pick(arr) {
    return arr[randInt(0, arr.length - 1)];
}
function withChance(probability) {
    return Math.random() < probability;
}
function createEvent(type, userId, sessionId, timestamp, payload) {
    return {
        id: `seed-${(0, ids_1.shortId)()}`,
        type,
        userId,
        timestamp,
        sessionId,
        payload
    };
}
function ensureDemoEvents() {
    const existing = (0, storage_1.readAllAnalyticsEvents)();
    if (existing.length > 300) {
        return { created: 0, total: existing.length };
    }
    const users = randInt(80, 180);
    const now = Date.now();
    const events = [];
    for (let i = 1; i <= users; i += 1) {
        const userId = `u${i}`;
        const sessions = randInt(1, 6);
        const seenDays = new Set();
        for (let s = 1; s <= sessions; s += 1) {
            const dayOffset = randInt(0, 29);
            seenDays.add(dayOffset);
            const dayTs = now - dayOffset * 24 * 60 * 60 * 1000 + randInt(8, 22) * 60 * 60 * 1000;
            const sessionId = `${userId}-s${s}`;
            events.push(createEvent("start_bot", userId, sessionId, dayTs, {}));
            const symptom = pick(SYMPTOMS);
            const drug = pick(DRUGS);
            events.push(createEvent("select_symptom", userId, sessionId, dayTs + randInt(30, 240), { symptom }));
            events.push(createEvent("recommendation_shown", userId, sessionId, dayTs + randInt(60, 300), {
                recommendations: [drug, pick(DRUGS), pick(DRUGS)]
            }));
            events.push(createEvent("enter_medication", userId, sessionId, dayTs + randInt(90, 360), {
                medication: drug
            }));
            if (withChance(0.78)) {
                events.push(createEvent("analysis_view", userId, sessionId, dayTs + randInt(120, 420), {
                    medications: [drug]
                }));
            }
            if (withChance(0.55)) {
                events.push(createEvent("recommendation_clicked", userId, sessionId, dayTs + randInt(130, 460), {
                    medication: drug
                }));
            }
            if (withChance(0.34)) {
                events.push(createEvent("click_apteka", userId, sessionId, dayTs + randInt(180, 560), {
                    medication: drug,
                    symptom
                }));
            }
        }
        if (seenDays.size > 1) {
            events.push(createEvent("return_visit", userId, `${userId}-rv`, now - randInt(0, 20) * 24 * 60 * 60 * 1000, {}));
        }
    }
    for (const event of events) {
        (0, storage_1.writeAnalyticsEvent)(event);
    }
    return {
        created: events.length,
        total: (0, storage_1.readAllAnalyticsEvents)().length
    };
}
