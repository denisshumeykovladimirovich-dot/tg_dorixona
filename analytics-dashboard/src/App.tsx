import { useEffect, useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";
import { fetchSummary, seedDemo } from "./api";
import type { DashboardSummary, PeriodKey } from "./types";

const PERIODS: Array<{ key: PeriodKey; label: string }> = [
  { key: "7d", label: "7 дней" },
  { key: "30d", label: "30 дней" },
  { key: "all", label: "Всё время" }
];

const PIE_COLORS = ["#2f5e9e", "#7da0cf"];

function kpiLabel(value: number, suffix = ""): string {
  return `${value.toLocaleString("ru-RU")}${suffix}`;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl bg-white p-5 shadow-soft">
      <h2 className="mb-4 text-lg font-semibold text-brand-900">{title}</h2>
      {children}
    </section>
  );
}

export default function App() {
  const [period, setPeriod] = useState<PeriodKey>("30d");
  const [data, setData] = useState<DashboardSummary | null>(null);
  const [error, setError] = useState<string>("");
  const [loading, setLoading] = useState(true);

  async function load(current: PeriodKey): Promise<void> {
    setLoading(true);
    setError("");
    try {
      await seedDemo();
      const summary = await fetchSummary(current);
      setData(summary);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Ошибка загрузки");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load(period);
  }, [period]);

  const returnPie = useMemo(
    () =>
      data
        ? [
            { name: "Новые", value: data.returning.newUsers },
            { name: "Повторные", value: data.returning.returningUsers }
          ]
        : [],
    [data]
  );

  if (loading) {
    return <div className="p-10 text-center text-slate-600">Загрузка dashboard...</div>;
  }

  if (error || !data) {
    return <div className="p-10 text-center text-red-700">Ошибка: {error || "Нет данных"}</div>;
  }

  return (
    <div className="mx-auto max-w-7xl p-4 pb-10 md:p-8">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold text-brand-900">Dorixona Analytics Demo</h1>
          <p className="mt-1 text-sm text-slate-600">
            Sales/demo asset: трафик, воронка и коммерческий потенциал Telegram-бота для аптек и фарм-брендов
          </p>
        </div>
        <div className="rounded-xl bg-white p-1 shadow-soft">
          {PERIODS.map((item) => (
            <button
              key={item.key}
              onClick={() => setPeriod(item.key)}
              className={`rounded-lg px-3 py-2 text-sm ${
                period === item.key ? "bg-brand-500 text-white" : "text-slate-600 hover:bg-slate-100"
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      </header>

      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {[
          ["Пользователи", kpiLabel(data.hero.totalUsers)],
          ["Активные 7 дней", kpiLabel(data.hero.activeUsers7d)],
          ["Повторные визиты", kpiLabel(data.hero.returningUsers)],
          ["Переходы в аптеку", kpiLabel(data.hero.aptekaClicks)],
          ["CTR в аптеку", kpiLabel(data.hero.aptekaCtr, "%")],
          ["Анализов на пользователя", kpiLabel(data.hero.avgAnalysesPerUser)]
        ].map(([title, value]) => (
          <div key={title} className="rounded-2xl bg-white p-4 shadow-soft">
            <p className="text-xs uppercase tracking-wide text-slate-500">{title}</p>
            <p className="mt-2 text-2xl font-bold text-brand-900">{value}</p>
          </div>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="Активность по дням">
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={data.activity}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="date" />
                <YAxis />
                <Tooltip />
                <Legend />
                <Line dataKey="users" stroke="#2f5e9e" name="Пользователи" strokeWidth={2} />
                <Line dataKey="analyses" stroke="#13a36f" name="Анализы" strokeWidth={2} />
                <Line dataKey="aptekaClicks" stroke="#d97706" name="Переходы в аптеку" strokeWidth={2} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Section>

        <Section title="Повторные визиты">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={returnPie} dataKey="value" nameKey="name" outerRadius={90} innerRadius={45}>
                    {returnPie.map((entry, index) => (
                      <Cell key={entry.name} fill={PIE_COLORS[index % PIE_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip />
                  <Legend />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <div className="space-y-3 text-sm text-slate-700">
              <p>Новые пользователи: <b>{data.returning.newUsers}</b></p>
              <p>Повторные пользователи: <b>{data.returning.returningUsers}</b></p>
              <p>Доля повторных визитов: <b>{data.returning.returningShare}%</b></p>
            </div>
          </div>
        </Section>

        <Section title="Воронка">
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data.funnel}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="step" />
                <YAxis />
                <Tooltip />
                <Bar dataKey="count" fill="#2f5e9e" name="Количество" />
                <Bar dataKey="conversionFromPrev" fill="#7da0cf" name="Конверсия %" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Section>

        <Section title="ТОП симптомов">
          <div className="overflow-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-slate-500">
                <tr><th>Симптом</th><th>Count</th><th>Доля</th></tr>
              </thead>
              <tbody>
                {data.topSymptoms.map((row) => (
                  <tr key={row.symptom} className="border-t border-slate-100">
                    <td className="py-2">{row.symptom}</td>
                    <td>{row.count}</td>
                    <td>{row.share}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>

        <Section title="ТОП препаратов">
          <div className="overflow-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-slate-500">
                <tr><th>Препарат</th><th>Искали</th><th>В рекомендациях</th><th>Переходы в аптеку</th></tr>
              </thead>
              <tbody>
                {data.topDrugs.map((row) => (
                  <tr key={row.drug} className="border-t border-slate-100">
                    <td className="py-2">{row.drug}</td>
                    <td>{row.searched}</td>
                    <td>{row.recommended}</td>
                    <td>{row.aptekaClicks}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>

        <Section title="Матрица симптом → препарат">
          <div className="overflow-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-slate-500">
                <tr><th>Симптом</th><th>Препарат</th><th>Count</th></tr>
              </thead>
              <tbody>
                {data.symptomDrugMatrix.map((row, idx) => (
                  <tr key={`${row.symptom}-${row.drug}-${idx}`} className="border-t border-slate-100">
                    <td className="py-2">{row.symptom}</td>
                    <td>{row.drug}</td>
                    <td>{row.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>

        <Section title="Ценность для аптеки">
          <p className="mb-2 text-sm text-slate-600">Потенциал для аптек</p>
          <p className="mb-3 text-sm text-slate-600">Прогнозная метрика / estimation</p>
          <div className="grid gap-3 md:grid-cols-3">
            <div className="space-y-2 text-sm md:col-span-1">
              <p>Переходы в аптеку: <b>{data.pharmacyValue.aptekaClicks}</b></p>
              <p>CTR: <b>{data.pharmacyValue.ctr}%</b></p>
              <p>Прогноз заказов: <b>{data.pharmacyValue.estimatedOrders}</b></p>
            </div>
            <div className="space-y-2 text-sm md:col-span-1">
              <p className="font-semibold">Топ препаратов по переходам:</p>
              {data.pharmacyValue.topDrugsByClicks.map((item) => (
                <p key={item.drug}>{item.drug}: {item.clicks}</p>
              ))}
            </div>
            <div className="space-y-2 text-sm md:col-span-1">
              <p className="font-semibold">Топ симптомов, ведущих к переходу:</p>
              {data.pharmacyValue.topSymptomsByClicks.map((item) => (
                <p key={item.symptom}>{item.symptom}: {item.clicks}</p>
              ))}
            </div>
          </div>
        </Section>

        <Section title="Ценность для фарм-бренда">
          <p className="mb-2 text-sm text-slate-600">Потенциал для фарм-компаний</p>
          <div className="grid gap-3 text-sm md:grid-cols-2">
            <div className="space-y-2">
              <p>Potential recommendation exposure: <b>{data.pharmaValue.potentialRecommendationExposure}</b></p>
              <p className="font-semibold">Частые симптомы:</p>
              {data.pharmaValue.topSymptoms.slice(0, 5).map((item) => (
                <p key={item.symptom}>{item.symptom}: {item.count}</p>
              ))}
            </div>
            <div className="space-y-2">
              <p className="font-semibold">Частые symptom→drug связки:</p>
              {data.pharmaValue.topSymptomDrugPairs.slice(0, 5).map((item, idx) => (
                <p key={`${item.symptom}-${idx}`}>{item.symptom} → {item.drug}: {item.count}</p>
              ))}
            </div>
          </div>
        </Section>
      </div>

      <section className="mt-4 rounded-2xl bg-white p-5 shadow-soft">
        <h2 className="mb-4 text-lg font-semibold text-brand-900">Последние события</h2>
        <div className="overflow-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-slate-500">
              <tr><th>Время</th><th>Событие</th><th>User</th><th>Payload</th></tr>
            </thead>
            <tbody>
              {data.latestEvents.map((row) => (
                <tr key={row.id} className="border-t border-slate-100">
                  <td className="py-2">{new Date(row.timestamp).toLocaleString("ru-RU")}</td>
                  <td>{row.type}</td>
                  <td>{row.userId}</td>
                  <td className="max-w-[360px] truncate">{JSON.stringify(row.payload)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
