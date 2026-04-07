"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildDashboardSummary = buildDashboardSummary;
function periodDays(period) {
    if (period === "7d")
        return 7;
    if (period === "30d")
        return 30;
    return null;
}
function tsInPeriod(timestamp, period) {
    const days = periodDays(period);
    if (!days)
        return true;
    return timestamp >= Date.now() - days * 24 * 60 * 60 * 1000;
}
function round2(n) {
    return Math.round(n * 100) / 100;
}
function safeText(value) {
    return typeof value === "string" ? value.trim() : "";
}
function eventSymptom(event) {
    return safeText(event.payload.symptom) || safeText(event.payload.selectedSymptom);
}
function eventDrug(event) {
    return safeText(event.payload.medication) || safeText(event.payload.drugName);
}
function addCount(map, key, by = 1) {
    if (!key)
        return;
    map.set(key, (map.get(key) || 0) + by);
}
function topSymptoms(items) {
    const counts = new Map();
    const total = items.length || 1;
    for (const event of items) {
        addCount(counts, eventSymptom(event));
    }
    return Array.from(counts.entries())
        .map(([symptom, count]) => ({ symptom, count, share: round2((count / total) * 100) }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10);
}
function topDrugs(events) {
    const map = new Map();
    const ensure = (name) => {
        const key = name.toLowerCase();
        const existing = map.get(key);
        if (existing)
            return existing;
        const created = { drug: name, searched: 0, recommended: 0, aptekaClicks: 0 };
        map.set(key, created);
        return created;
    };
    for (const event of events) {
        if (event.type === "enter_medication") {
            const drug = eventDrug(event);
            if (drug)
                ensure(drug).searched += 1;
        }
        if (event.type === "recommendation_shown") {
            const recs = Array.isArray(event.payload.recommendations) ? event.payload.recommendations : [];
            for (const rec of recs) {
                const drug = safeText(rec);
                if (drug)
                    ensure(drug).recommended += 1;
            }
        }
        if (event.type === "click_apteka") {
            const drug = eventDrug(event);
            if (drug)
                ensure(drug).aptekaClicks += 1;
        }
    }
    return Array.from(map.values())
        .sort((a, b) => b.searched + b.recommended + b.aptekaClicks - (a.searched + a.recommended + a.aptekaClicks))
        .slice(0, 10);
}
function buildActivity(events) {
    const byDate = new Map();
    for (const event of events) {
        const date = new Date(event.timestamp).toISOString().slice(0, 10);
        const existing = byDate.get(date) || { date, users: 0, analyses: 0, aptekaClicks: 0, usersSet: new Set() };
        existing.usersSet.add(event.userId);
        if (event.type === "analysis_view") {
            existing.analyses += 1;
        }
        if (event.type === "click_apteka") {
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
function buildFunnel(events) {
    const sessionsByStep = {
        symptom: new Set(),
        medication: new Set(),
        analysis: new Set(),
        apteka: new Set()
    };
    for (const event of events) {
        if (event.type === "select_symptom")
            sessionsByStep.symptom.add(event.sessionId);
        if (event.type === "enter_medication")
            sessionsByStep.medication.add(event.sessionId);
        if (event.type === "analysis_view")
            sessionsByStep.analysis.add(event.sessionId);
        if (event.type === "click_apteka")
            sessionsByStep.apteka.add(event.sessionId);
    }
    const list = [
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
function buildMatrix(events) {
    const sessionSymptom = new Map();
    const sessionDrug = new Map();
    const counts = new Map();
    for (const event of events) {
        if (event.type === "select_symptom") {
            const symptom = eventSymptom(event);
            if (symptom) {
                sessionSymptom.set(event.sessionId, symptom);
            }
        }
        if (event.type === "enter_medication" || event.type === "click_apteka") {
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
function returningBreakdown(events) {
    const sessionsPerUser = new Map();
    for (const event of events) {
        if (event.type !== "start_bot")
            continue;
        const set = sessionsPerUser.get(event.userId) || new Set();
        set.add(event.sessionId);
        sessionsPerUser.set(event.userId, set);
    }
    let newUsers = 0;
    let returningUsers = 0;
    for (const sessions of sessionsPerUser.values()) {
        if (sessions.size > 1)
            returningUsers += 1;
        else
            newUsers += 1;
    }
    const total = newUsers + returningUsers || 1;
    return {
        newUsers,
        returningUsers,
        returningShare: round2((returningUsers / total) * 100)
    };
}
function pharmacyValue(events, symptoms, drugs) {
    const aptekaClicks = events.filter((event) => event.type === "click_apteka").length;
    const analyses = events.filter((event) => event.type === "analysis_view").length;
    const ctr = round2((aptekaClicks / (analyses || 1)) * 100);
    const symptomClicksMap = new Map();
    const sessionSymptom = new Map();
    for (const event of events) {
        if (event.type === "select_symptom") {
            const symptom = eventSymptom(event);
            if (symptom)
                sessionSymptom.set(event.sessionId, symptom);
        }
        if (event.type === "click_apteka") {
            const symptom = sessionSymptom.get(event.sessionId);
            if (symptom)
                addCount(symptomClicksMap, symptom);
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
function pharmaValue(events, symptoms, drugs, matrix) {
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
        potentialRecommendationExposure: events.filter((event) => event.type === "recommendation_shown").length
    };
}
function buildDashboardSummary(allEvents, period) {
    const events = allEvents.filter((event) => tsInPeriod(event.timestamp, period));
    const totalUsers = new Set(events.map((event) => event.userId)).size;
    const activeUsers7d = new Set(allEvents
        .filter((event) => event.timestamp >= Date.now() - 7 * 24 * 60 * 60 * 1000)
        .map((event) => event.userId)).size;
    const returning = returningBreakdown(events);
    const analyses = events.filter((event) => event.type === "analysis_view").length;
    const aptekaClicks = events.filter((event) => event.type === "click_apteka").length;
    const symptomEvents = events.filter((event) => event.type === "select_symptom");
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
