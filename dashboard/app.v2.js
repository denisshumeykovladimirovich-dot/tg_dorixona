const API_BASE = localStorage.getItem("dorixona_api_base") || "http://localhost:4010";
const REFRESH_MS = 15000;

const fallback = {
  pharmaSummary: {
    hero: { totalUsers: 12480, aptekaClicks: 3210, avgAnalysesPerUser: 1.84 },
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
      { type: "analysis_completed", userId: "u-2901", timestamp: Date.now() - 120000, payload: { symptom: "Головная боль" } },
      { type: "apteka_click", userId: "u-2917", timestamp: Date.now() - 240000, payload: { drug: "Парацетамол" } },
      { type: "analysis_completed", userId: "u-2922", timestamp: Date.now() - 360000, payload: { symptom: "Кашель" } }
    ],
    risks: [
      { pair: "Ибупрофен + Диклофенак", level: "Высокий риск" },
      { pair: "Парацетамол + Алкоголь", level: "Высокий риск" },
      { pair: "Амоксициллин + Метотрексат", level: "Средний риск" },
      { pair: "Кеторол + Варфарин", level: "Средний риск" },
      { pair: "Нимесулид + Дексаметазон", level: "Средний риск" }
    ]
  },
  pharmaEvents: [
    { type: "analysis_completed", status: "ok", userId: "u-2928", timestamp: Date.now() - 60000, payload: { symptom: "Простуда", drug: "Терафлю", action: "Рекомендация сформирована" } },
    { type: "apteka_click", status: "buy", userId: "u-2935", timestamp: Date.now() - 120000, payload: { symptom: "Головная боль", drug: "Ибупрофен", action: "Нажатие Купить" } },
    { type: "risk_warning", status: "risk", userId: "u-2941", timestamp: Date.now() - 180000, payload: { symptom: "Боль в суставах", drug: "Диклофенак", action: "Показано предупреждение о риске" } },
    { type: "analysis_completed", status: "ok", userId: "u-2948", timestamp: Date.now() - 240000, payload: { symptom: "Кашель", drug: "Амброксол", action: "Подобран препарат" } },
    { type: "apteka_click", status: "buy", userId: "u-2952", timestamp: Date.now() - 300000, payload: { symptom: "Температура", drug: "Парацетамол", action: "Переход в аптеку" } },
    { type: "analysis_completed", status: "ok", userId: "u-2960", timestamp: Date.now() - 360000, payload: { symptom: "Боль в горле", drug: "Стрепсилс", action: "Рекомендация принята" } },
    { type: "risk_warning", status: "risk", userId: "u-2968", timestamp: Date.now() - 420000, payload: { symptom: "Простуда", drug: "Нимесулид", action: "Обнаружено нежелательное сочетание" } },
    { type: "apteka_click", status: "buy", userId: "u-2974", timestamp: Date.now() - 480000, payload: { symptom: "Насморк", drug: "Ринофлуимуцил", action: "Клик по покупке" } },
    { type: "analysis_completed", status: "ok", userId: "u-2983", timestamp: Date.now() - 540000, payload: { symptom: "Головная боль", drug: "Нурофен", action: "Выбран препарат" } },
    { type: "apteka_click", status: "buy", userId: "u-2991", timestamp: Date.now() - 600000, payload: { symptom: "Кашель", drug: "Амброксол", action: "Нажатие Купить" } }
  ],
  pharmacySummary: {
    pharmacy_clicks: 186,
    buy_clicks: 142,
    conversion_rate: 76,
    avg_time_to_buy_sec: 100,
    top_pharmacies: [
      { name: "Arzon Apteka", count: 96 },
      { name: "Apteka 999", count: 54 },
      { name: "Oson Dorixona", count: 36 }
    ],
    top_purchase_paths: [
      { name: "Кашель → Амброксол", count: 45 },
      { name: "Температура → Парацетамол", count: 38 },
      { name: "Головная боль → Ибупрофен", count: 32 },
      { name: "Боль в горле → Стрепсилс", count: 21 },
      { name: "Насморк → Ринофлуимуцил", count: 18 }
    ]
  },
  pharmacyLive: {
    events: [
      { userId: "u-6102", timestamp: Date.now() - 90000, symptom: "Кашель", drug: "Амброксол", pharmacy: "Arzon Apteka" },
      { userId: "u-6110", timestamp: Date.now() - 180000, symptom: "Температура", drug: "Парацетамол", pharmacy: "Apteka 999" }
    ]
  }
};

const fmtNum = (v) => Number(v || 0).toLocaleString("ru-RU");
const fmtPct = (v) => `${Number(v || 0).toFixed(1)}%`;
const ago = (ts) => `${Math.max(1, Math.floor((Date.now() - ts) / 60000))} мин назад`;
const secToHuman = (s) => `${Math.floor((s || 0) / 60)} мин ${(s || 0) % 60} сек`;

async function getJson(path) {
  const response = await fetch(`${API_BASE}${path}`);
  if (!response.ok) throw new Error(`API ${response.status}`);
  return response.json();
}

function renderBars(containerId, rows, labelKey, valueKey, suffix) {
  const root = document.getElementById(containerId);
  if (!rows || !rows.length) {
    root.innerHTML = '<div class="empty">Данные недоступны</div>';
    return;
  }
  const max = Math.max(...rows.map((r) => Number(r[valueKey] || 0)), 1);
  root.innerHTML = rows.slice(0, 5).map((row) => {
    const value = Number(row[valueKey] || 0);
    const width = Math.max(8, Math.round((value / max) * 100));
    return `<div><div class="bar-row"><div class="bar-label">${row[labelKey]}</div><div class="bar-val">${fmtNum(value)}${suffix}</div></div><div class="bar-line"><span style="width:${width}%"></span></div></div>`;
  }).join("");
}

function calcInfluence(summary) {
  const users = summary.hero?.totalUsers || 0;
  const funnel = summary.funnel || [];
  const rec = funnel.find((s) => String(s.step).toLowerCase().includes("recommend")) || funnel[3];
  const apt = funnel.find((s) => String(s.step).toLowerCase().includes("apteka")) || funnel[4];
  const recommended = rec?.count || 0;
  const clicks = apt?.count || summary.hero?.aptekaClicks || 0;
  const decisionShare = recommended > 0 ? (clicks / recommended) * 100 : 0;
  const lift = Math.max(0, decisionShare - 22);
  const daily = Math.round((clicks / 30) * 10) / 10;
  const influenced = Math.round(users * (decisionShare / 100));
  return { clicks, decisionShare, lift, daily, influenced };
}

function statusChip(status) {
  if (status === "buy") return '<span class="status buy">buy</span>';
  if (status === "risk") return '<span class="status risk">risk</span>';
  return '<span class="status ok">ok</span>';
}

function renderDecisionsChart(series) {
  const canvas = document.getElementById("decisionsChart");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const data = Array.isArray(series) && series.length === 7 ? series : [12, 18, 25, 32, 28, 40, 55];
  const labels = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
  const w = canvas.width;
  const h = canvas.height;
  const padLeft = 50;
  const padRight = 20;
  const padTop = 20;
  const padBottom = 35;
  const maxVal = Math.max(...data, 1);
  const plotW = w - padLeft - padRight;
  const plotH = h - padTop - padBottom;

  const points = data.map((v, i) => {
    const x = padLeft + (plotW / (data.length - 1)) * i;
    const y = padTop + plotH - (v / maxVal) * plotH;
    return { x, y, v };
  });

  const draw = (progress) => {
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = "rgba(255,255,255,0.15)";
    ctx.lineWidth = 1;
    for (let i = 0; i <= 5; i += 1) {
      const y = padTop + (plotH / 5) * i;
      ctx.beginPath();
      ctx.moveTo(padLeft, y);
      ctx.lineTo(w - padRight, y);
      ctx.stroke();
      const value = Math.round(maxVal - (maxVal / 5) * i);
      ctx.fillStyle = "rgba(255,255,255,0.7)";
      ctx.font = "12px Segoe UI";
      ctx.fillText(String(value), 10, y + 4);
    }

    ctx.strokeStyle = "#4dd0ff";
    ctx.lineWidth = 3;
    ctx.beginPath();
    points.forEach((p, i) => {
      const py = padTop + plotH - ((padTop + plotH - p.y) * progress);
      if (i === 0) ctx.moveTo(p.x, py);
      else ctx.lineTo(p.x, py);
    });
    ctx.stroke();

    points.forEach((p) => {
      const py = padTop + plotH - ((padTop + plotH - p.y) * progress);
      ctx.beginPath();
      ctx.fillStyle = "#4dd0ff";
      ctx.arc(p.x, py, 4, 0, Math.PI * 2);
      ctx.fill();
      if (progress > 0.85) {
        ctx.fillStyle = "#ffffff";
        ctx.font = "12px Segoe UI";
        ctx.fillText(String(p.v), p.x - 8, py - 10);
      }
    });

    labels.forEach((label, i) => {
      const x = padLeft + (plotW / (labels.length - 1)) * i;
      ctx.fillStyle = "rgba(255,255,255,0.82)";
      ctx.font = "12px Segoe UI";
      ctx.fillText(label, x - 8, h - 10);
    });
  };

  const start = performance.now();
  const duration = 650;
  const tick = (now) => {
    const t = Math.min(1, (now - start) / duration);
    draw(t);
    if (t < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function paintPharma(summary, events, status) {
  const influence = calcInfluence(summary);
  const users = summary.hero?.totalUsers || 0;
  const decisionUsers = Math.round(users * (influence.decisionShare / 100));
  document.getElementById("statusBadge").textContent = status;
  document.getElementById("kpiDecision").textContent = fmtPct(influence.decisionShare);
  document.getElementById("kpiDecisionTrend").textContent = `+${fmtPct(influence.lift)} к базовой вероятности выбора`;
  document.getElementById("kpiInfluenced").textContent = fmtNum(influence.influenced);
  document.getElementById("kpiClicks").textContent = fmtNum(influence.clicks);
  document.getElementById("kpiDaily").textContent = fmtNum(influence.daily);
  document.getElementById("impactPercent").textContent = `${fmtPct(influence.decisionShare)} (${fmtNum(decisionUsers)} чел.)`;
  document.getElementById("impactLift").textContent = `+${fmtPct(influence.lift)}`;
  renderBars("topDrugsList", summary.topDrugs, "drug", "aptekaClicks", " выборов");
  renderBars("topSymptomsList", summary.topSymptoms, "symptom", "count", " запросов");
  const risks = (summary.risks || fallback.pharmaSummary.risks).slice(0, 5);
  const high = risks.filter((r) => String(r.level).toLowerCase().includes("высок")).length;
  const medium = risks.filter((r) => String(r.level).toLowerCase().includes("средн")).length;
  document.getElementById("riskTotal").textContent = String(risks.length);
  document.getElementById("riskHigh").textContent = String(high);
  document.getElementById("riskMedium").textContent = String(medium);
  document.getElementById("riskList").innerHTML = risks.map((risk) => `<div class="risk-item"><div class="risk-dot"></div><div>${risk.pair}</div><div class="risk-tag">${risk.level}</div></div>`).join("");
  const safeEvents = (events && events.length ? events : fallback.pharmaEvents).slice(0, 10);
  document.getElementById("liveFeed").innerHTML = safeEvents.map((event) => {
    const time = new Date(event.timestamp || Date.now()).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
    const symptom = event.payload?.symptom || "симптом";
    const action = event.payload?.action || (event.type === "apteka_click" ? `Купить ${event.payload?.drug || "препарат"}` : `Рекомендация: ${event.payload?.drug || "препарат"}`);
    return `<div class="feed-item"><div>${statusChip(event.status)} ${time} — ${symptom} — ${action}</div><div class="feed-meta">Пользователь: ${event.userId || "unknown"} • ${ago(event.timestamp || Date.now())}</div></div>`;
  }).join("");

  const chartData = Array.isArray(summary.activity) && summary.activity.length >= 7
    ? summary.activity.slice(-7).map((row) => Number(row.analyses || row.users || 0))
    : [12, 18, 25, 32, 28, 40, 55];
  renderDecisionsChart(chartData);
}

function paintPharmacy(summary, live, status) {
  const clicks = Number(summary.pharmacy_clicks || 0);
  const buy = Number(summary.buy_clicks || 0);
  const conversion = Number(summary.conversion_rate || (clicks > 0 ? (buy / clicks) * 100 : 0));
  const avgSec = Number(summary.avg_time_to_buy_sec || 0);
  document.getElementById("statusBadge").textContent = status;
  document.getElementById("pharmacyClicks").textContent = fmtNum(clicks);
  document.getElementById("buyClicks").textContent = fmtNum(buy);
  document.getElementById("buyConversion").textContent = fmtPct(conversion);
  document.getElementById("timeToBuy").textContent = secToHuman(avgSec);
  document.getElementById("pharmacyMainClicks").textContent = fmtNum(clicks);
  document.getElementById("pharmacyMainConversion").textContent = fmtPct(conversion);
  renderBars("topPathsList", summary.top_purchase_paths || [], "name", "count", " покупок");
  renderBars("topPharmaciesList", summary.top_pharmacies || [], "name", "count", " переходов");
  const events = Array.isArray(live?.events) ? live.events.slice(0, 10) : [];
  document.getElementById("pharmacyLiveFeed").innerHTML = events.map((event) => `<div class="feed-item"><div>${event.symptom || "Симптом"} → Купить ${event.drug || "препарат"}</div><div class="feed-meta">${event.pharmacy || "Аптека"} • ${event.userId || "unknown"} • ${ago(event.timestamp || Date.now())}</div></div>`).join("");
}

let activeTab = "pharma";
function setTab(tab) {
  activeTab = tab;
  const isPharma = tab === "pharma";
  document.getElementById("tabPharma").classList.toggle("active", isPharma);
  document.getElementById("tabPharmacy").classList.toggle("active", !isPharma);
  document.getElementById("panelPharma").classList.toggle("hidden", !isPharma);
  document.getElementById("panelPharmacy").classList.toggle("hidden", isPharma);
  document.getElementById("subtitle").textContent = isPharma
    ? "AI влияет на выбор препаратов в момент решения пациента"
    : "Мы приводим клиента в аптеку в момент готовности к покупке";
}

async function loadAndRender() {
  let pharmaStatus = "LIVE API";
  let pharmacyStatus = "LIVE API";
  let summary = fallback.pharmaSummary;
  let events = fallback.pharmaEvents;
  try {
    const [s, ev] = await Promise.all([
      getJson("/api/analytics/summary?period=30d"),
      getJson("/api/analytics/events?limit=10")
    ]);
    summary = s;
    events = Array.isArray(ev?.events) ? ev.events : s.latestEvents || [];
  } catch {
    pharmaStatus = "MOCK DATA (API недоступен)";
  }
  let pharmacySummary = fallback.pharmacySummary;
  let pharmacyLive = fallback.pharmacyLive;
  try {
    const [ps, pl] = await Promise.all([
      getJson("/api/analytics/pharmacy-summary"),
      getJson("/api/analytics/pharmacy-events?limit=10")
    ]);
    pharmacySummary = ps;
    pharmacyLive = pl;
  } catch {
    pharmacyStatus = "MOCK DATA (API недоступен)";
  }
  paintPharma(summary, events, activeTab === "pharma" ? pharmaStatus : `Фарм: ${pharmaStatus}`);
  paintPharmacy(pharmacySummary, pharmacyLive, activeTab === "pharmacy" ? pharmacyStatus : `Аптеки: ${pharmacyStatus}`);
  document.getElementById("statusBadge").textContent = activeTab === "pharma" ? pharmaStatus : pharmacyStatus;
}

document.getElementById("tabPharma").addEventListener("click", () => { setTab("pharma"); loadAndRender(); });
document.getElementById("tabPharmacy").addEventListener("click", () => { setTab("pharmacy"); loadAndRender(); });

setTab("pharma");
paintPharma(fallback.pharmaSummary, fallback.pharmaEvents, "MOCK DATA (готово к демо)");
paintPharmacy(fallback.pharmacySummary, fallback.pharmacyLive, "MOCK DATA (готово к демо)");
loadAndRender();
setInterval(loadAndRender, REFRESH_MS);

function renderPharmacyChart(series) {
  const canvas = document.getElementById("pharmacyChart");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const data = Array.isArray(series) && series.length === 7 ? series : [18, 22, 27, 24, 31, 36, 42];
  const labels = ["��", "��", "��", "��", "��", "��", "��"];
  const w = canvas.width;
  const h = canvas.height;
  const padLeft = 50;
  const padRight = 20;
  const padTop = 20;
  const padBottom = 35;
  const maxVal = Math.max(...data, 1);
  const plotW = w - padLeft - padRight;
  const plotH = h - padTop - padBottom;

  const points = data.map((v, i) => {
    const x = padLeft + (plotW / (data.length - 1)) * i;
    const y = padTop + plotH - (v / maxVal) * plotH;
    return { x, y, v };
  });

  const draw = (progress) => {
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = "rgba(255,255,255,0.15)";
    ctx.lineWidth = 1;
    for (let i = 0; i <= 5; i += 1) {
      const y = padTop + (plotH / 5) * i;
      ctx.beginPath();
      ctx.moveTo(padLeft, y);
      ctx.lineTo(w - padRight, y);
      ctx.stroke();
      const value = Math.round(maxVal - (maxVal / 5) * i);
      ctx.fillStyle = "rgba(255,255,255,0.7)";
      ctx.font = "12px Segoe UI";
      ctx.fillText(String(value), 10, y + 4);
    }

    ctx.strokeStyle = "#58e2b4";
    ctx.lineWidth = 3;
    ctx.beginPath();
    points.forEach((p, i) => {
      const py = padTop + plotH - ((padTop + plotH - p.y) * progress);
      if (i === 0) ctx.moveTo(p.x, py);
      else ctx.lineTo(p.x, py);
    });
    ctx.stroke();

    points.forEach((p) => {
      const py = padTop + plotH - ((padTop + plotH - p.y) * progress);
      ctx.beginPath();
      ctx.fillStyle = "#58e2b4";
      ctx.arc(p.x, py, 4, 0, Math.PI * 2);
      ctx.fill();
      if (progress > 0.85) {
        ctx.fillStyle = "#ffffff";
        ctx.font = "12px Segoe UI";
        ctx.fillText(String(p.v), p.x - 8, py - 10);
      }
    });

    labels.forEach((label, i) => {
      const x = padLeft + (plotW / (labels.length - 1)) * i;
      ctx.fillStyle = "rgba(255,255,255,0.82)";
      ctx.font = "12px Segoe UI";
      ctx.fillText(label, x - 8, h - 10);
    });
  };

  const start = performance.now();
  const duration = 650;
  const tick = (now) => {
    const t = Math.min(1, (now - start) / duration);
    draw(t);
    if (t < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

if (typeof paintPharmacy === "function") {
  const __prevPaintPharmacy = paintPharmacy;
  paintPharmacy = function(summary, live, status) {
    __prevPaintPharmacy(summary, live, status);
    const chartData = Array.isArray(summary?.daily_buy_clicks) && summary.daily_buy_clicks.length >= 7
      ? summary.daily_buy_clicks.slice(-7).map((v) => Number(v || 0))
      : [18, 22, 27, 24, 31, 36, 42];
    renderPharmacyChart(chartData);
  };
  try { loadAndRender(); } catch {}
}
