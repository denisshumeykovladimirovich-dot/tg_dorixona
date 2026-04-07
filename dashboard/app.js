const API_BASE = localStorage.getItem("dorixona_api_base") || "http://localhost:4010";
const REFRESH_MS = 15000;

const fallback = {
  summary: {
    hero: {
      totalUsers: 12480,
      aptekaClicks: 3210,
      avgAnalysesPerUser: 1.84
    },
    funnel: [
      { step: "Start", count: 12480 },
      { step: "Symptom", count: 9720 },
      { step: "Analysis", count: 8240 },
      { step: "Recommendation", count: 6920 },
      { step: "Apteka Click", count: 3210 }
    ],
    topDrugs: [
      { drug: "Парацетамол", aptekaClicks: 690, recommended: 1660 },
      { drug: "Ибупрофен", aptekaClicks: 610, recommended: 1520 },
      { drug: "Нурофен", aptekaClicks: 470, recommended: 1290 },
      { drug: "Амброксол", aptekaClicks: 420, recommended: 980 },
      { drug: "Терафлю", aptekaClicks: 390, recommended: 910 }
    ],
    topSymptoms: [
      { symptom: "Головная боль", count: 1380, share: 19.2 },
      { symptom: "Простуда", count: 1240, share: 17.3 },
      { symptom: "Кашель", count: 980, share: 13.6 },
      { symptom: "Боль в горле", count: 910, share: 12.7 },
      { symptom: "Температура", count: 840, share: 11.8 }
    ],
    latestEvents: [
      {
        type: "analysis_completed",
        userId: "u-2901",
        timestamp: Date.now() - 60 * 1000 * 2,
        payload: { symptom: "Головная боль", recommendationCount: 3 }
      },
      {
        type: "apteka_click",
        userId: "u-2917",
        timestamp: Date.now() - 60 * 1000 * 4,
        payload: { drug: "Парацетамол", source: "recommendation" }
      },
      {
        type: "analysis_completed",
        userId: "u-2922",
        timestamp: Date.now() - 60 * 1000 * 6,
        payload: { symptom: "Кашель", recommendationCount: 2 }
      }
    ]
  },
  events: [
    {
      type: "analysis_completed",
      userId: "u-2928",
      timestamp: Date.now() - 60 * 1000,
      payload: { symptom: "Простуда", recommendationCount: 3 }
    },
    {
      type: "apteka_click",
      userId: "u-2935",
      timestamp: Date.now() - 60 * 1000 * 3,
      payload: { drug: "Ибупрофен", source: "recommendation" }
    },
    {
      type: "analysis_completed",
      userId: "u-2942",
      timestamp: Date.now() - 60 * 1000 * 5,
      payload: { symptom: "Боль в горле", recommendationCount: 4 }
    }
  ],
  risks: [
    { pair: "Ибупрофен + Диклофенак", level: "Высокий риск" },
    { pair: "Парацетамол + Алкоголь", level: "Печеночный риск" },
    { pair: "Амоксициллин + Метотрексат", level: "Требует консультации" }
  ]
};

function fmtNum(value) {
  return Number(value || 0).toLocaleString("ru-RU");
}

function fmtPct(value) {
  return `${Number(value || 0).toFixed(1)}%`;
}

function ago(ts) {
  const diff = Math.max(1, Math.floor((Date.now() - ts) / 60000));
  return `${diff} мин назад`;
}

async function getJson(path) {
  const response = await fetch(`${API_BASE}${path}`);
  if (!response.ok) {
    throw new Error(`API ${response.status}`);
  }
  return response.json();
}

function mapEventText(event) {
  if (event.type === "apteka_click") {
    return `Выбор препарата: ${event.payload?.drug || "без названия"}`;
  }
  if (event.type === "analysis_completed") {
    return `Завершен анализ по симптому: ${event.payload?.symptom || "не указан"}`;
  }
  return event.type || "событие";
}

function calcInfluence(summary) {
  const users = summary.hero?.totalUsers || 0;
  const funnel = summary.funnel || [];
  const recStep = funnel.find((s) => String(s.step).toLowerCase().includes("recommend")) || funnel[3];
  const aptekaStep = funnel.find((s) => String(s.step).toLowerCase().includes("apteka")) || funnel[4];
  const recommended = recStep?.count || 0;
  const clicks = aptekaStep?.count || summary.hero?.aptekaClicks || 0;
  const decisionShare = recommended > 0 ? (clicks / recommended) * 100 : 0;
  const lift = decisionShare > 0 ? Math.max(0, decisionShare - 22) : 0;
  const daily = Math.round((clicks / 30) * 10) / 10;
  const influenced = Math.round(users * (decisionShare / 100));
  return { clicks, decisionShare, lift, daily, influenced };
}

function renderBars(containerId, rows, labelKey, valueKey, suffix = "") {
  const root = document.getElementById(containerId);
  if (!rows || rows.length === 0) {
    root.innerHTML = '<div class="empty">Данные недоступны</div>';
    return;
  }
  const max = Math.max(...rows.map((row) => Number(row[valueKey] || 0)), 1);
  root.innerHTML = rows
    .slice(0, 5)
    .map((row) => {
      const value = Number(row[valueKey] || 0);
      const width = Math.max(8, Math.round((value / max) * 100));
      return `
        <div>
          <div class="bar-row">
            <div class="bar-label">${row[labelKey]}</div>
            <div class="bar-val">${fmtNum(value)}${suffix}</div>
          </div>
          <div class="bar-line"><span style="width:${width}%"></span></div>
        </div>
      `;
    })
    .join("");
}

function renderRisks(risks) {
  const root = document.getElementById("riskList");
  const safe = (risks || fallback.risks).slice(0, 5);
  root.innerHTML = safe
    .map(
      (risk) => `
      <div class="risk-item">
        <div class="risk-dot"></div>
        <div>${risk.pair}</div>
        <div class="risk-tag">${risk.level}</div>
      </div>
    `
    )
    .join("");
}

function renderFeed(events) {
  const root = document.getElementById("liveFeed");
  const safe = (events || []).slice(0, 10);
  if (safe.length === 0) {
    root.innerHTML = '<div class="empty">Данные ленты недоступны</div>';
    return;
  }
  root.innerHTML = safe
    .map(
      (event) => `
      <div class="feed-item">
        <div>${mapEventText(event)}</div>
        <div class="feed-meta">Пользователь: ${event.userId || "unknown"} • ${ago(event.timestamp || Date.now())}</div>
      </div>
    `
    )
    .join("");
}

function paint(summary, events, sourceLabel) {
  const influence = calcInfluence(summary);
  const users = summary.hero?.totalUsers || 0;
  const decisionUsers = Math.round(users * (influence.decisionShare / 100));

  document.getElementById("statusBadge").textContent = sourceLabel;
  document.getElementById("kpiDecision").textContent = fmtPct(influence.decisionShare);
  document.getElementById("kpiDecisionTrend").textContent = `+${fmtPct(influence.lift)} к базовой вероятности выбора`;
  document.getElementById("kpiInfluenced").textContent = fmtNum(influence.influenced);
  document.getElementById("kpiClicks").textContent = fmtNum(influence.clicks);
  document.getElementById("kpiDaily").textContent = fmtNum(influence.daily);
  document.getElementById("impactPercent").textContent = `${fmtPct(influence.decisionShare)} (${fmtNum(decisionUsers)} чел.)`;
  document.getElementById("impactLift").textContent = `+${fmtPct(influence.lift)}`;

  renderBars("topDrugsList", summary.topDrugs, "drug", "aptekaClicks", " выборов");
  renderBars("topSymptomsList", summary.topSymptoms, "symptom", "count", " запросов");
  renderRisks(summary.risks || fallback.risks);
  renderFeed(events);
}

async function loadAndRender() {
  try {
    const [summary, eventsResponse] = await Promise.all([
      getJson("/api/analytics/summary?period=30d"),
      getJson("/api/analytics/events?limit=10")
    ]);
    const events = Array.isArray(eventsResponse?.events) ? eventsResponse.events : summary.latestEvents || [];
    paint(summary, events, "LIVE API");
  } catch (error) {
    const summary = fallback.summary;
    const events = fallback.events.length ? fallback.events : summary.latestEvents;
    paint(summary, events, "MOCK DATA (API недоступен)");
  }
}

loadAndRender();
setInterval(loadAndRender, REFRESH_MS);
