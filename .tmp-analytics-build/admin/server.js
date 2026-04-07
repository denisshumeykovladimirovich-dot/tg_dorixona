"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const http_1 = __importDefault(require("http"));
const url_1 = require("url");
const aggregator_1 = require("../analytics/aggregator");
const storage_1 = require("../analytics/storage");
const seedDemoEvents_1 = require("../analytics/seedDemoEvents");
const PORT = Number.parseInt(process.env.ANALYTICS_PORT || "4010", 10);
function sendJson(res, code, payload) {
    res.writeHead(code, {
        "Content-Type": "application/json; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type"
    });
    res.end(JSON.stringify(payload));
}
function parsePeriod(value) {
    if (value === "7d" || value === "30d" || value === "all") {
        return value;
    }
    return "30d";
}
function route(req, res) {
    if (!req.url || !req.method) {
        sendJson(res, 400, { error: "Bad request" });
        return;
    }
    if (req.method === "OPTIONS") {
        sendJson(res, 204, {});
        return;
    }
    const url = new url_1.URL(req.url, `http://localhost:${PORT}`);
    if (req.method === "POST" && url.pathname === "/api/analytics/seed") {
        const result = (0, seedDemoEvents_1.ensureDemoEvents)();
        sendJson(res, 200, result);
        return;
    }
    if (req.method === "GET" && url.pathname === "/api/analytics/summary") {
        const period = parsePeriod(url.searchParams.get("period"));
        const events = (0, storage_1.readAllAnalyticsEvents)();
        if (events.length < 120) {
            (0, seedDemoEvents_1.ensureDemoEvents)();
        }
        const freshEvents = (0, storage_1.readAllAnalyticsEvents)();
        const summary = (0, aggregator_1.buildDashboardSummary)(freshEvents, period);
        sendJson(res, 200, summary);
        return;
    }
    if (req.method === "GET" && url.pathname === "/api/analytics/events") {
        const limit = Number.parseInt(url.searchParams.get("limit") || "50", 10);
        const events = (0, storage_1.readAllAnalyticsEvents)()
            .sort((a, b) => b.timestamp - a.timestamp)
            .slice(0, Math.max(1, Math.min(limit, 200)));
        sendJson(res, 200, { events });
        return;
    }
    if (req.method === "GET" && url.pathname === "/api/health") {
        sendJson(res, 200, { ok: true, service: "analytics-api" });
        return;
    }
    sendJson(res, 404, { error: "Not found" });
}
const server = http_1.default.createServer(route);
server.listen(PORT, () => {
    console.info(`Analytics API started on http://localhost:${PORT}`);
});
