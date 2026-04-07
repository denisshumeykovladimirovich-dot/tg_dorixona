import http from "http";
import { URL } from "url";
import { buildDashboardSummary } from "../analytics/aggregator";
import { readAllAnalyticsEvents } from "../analytics/storage";
import { ensureDemoEvents } from "../analytics/seedDemoEvents";
import type { PeriodKey } from "../analytics/types";

const PORT = Number.parseInt(process.env.ANALYTICS_PORT || "4010", 10);

function sendJson(res: http.ServerResponse, code: number, payload: unknown): void {
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  res.end(JSON.stringify(payload));
}

function parsePeriod(value: string | null): PeriodKey {
  if (value === "7d" || value === "30d" || value === "all") {
    return value;
  }
  return "30d";
}

function route(req: http.IncomingMessage, res: http.ServerResponse): void {
  if (!req.url || !req.method) {
    sendJson(res, 400, { error: "Bad request" });
    return;
  }

  if (req.method === "OPTIONS") {
    sendJson(res, 204, {});
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === "POST" && url.pathname === "/api/analytics/seed") {
    const result = ensureDemoEvents();
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/analytics/summary") {
    const period = parsePeriod(url.searchParams.get("period"));
    const events = readAllAnalyticsEvents();
    if (events.length < 120) {
      ensureDemoEvents();
    }
    const freshEvents = readAllAnalyticsEvents();
    const summary = buildDashboardSummary(freshEvents, period);
    sendJson(res, 200, summary);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/analytics/events") {
    const limit = Number.parseInt(url.searchParams.get("limit") || "50", 10);
    const events = readAllAnalyticsEvents()
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

const server = http.createServer(route);
server.listen(PORT, () => {
  console.info(`Analytics API started on http://localhost:${PORT}`);
});

