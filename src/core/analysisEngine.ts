import { Medication } from "./medicationCatalog";

export type AnalysisResult = {
  status: "safe" | "caution" | "attention";
  riskScore: number;
  summary: string;
  explanation: string;
  monitoring: string[];
  doctorQuestions: string[];
  comparison: string[];
};

type AnalysisContext = {
  ageYears?: number | null;
};

type PairRule = {
  pairKey: string;
  status: AnalysisResult["status"];
  riskScore: number;
  summary: string;
  explanation: string;
  comparison: string;
  monitoring?: string[];
  doctorQuestions?: string[];
};

const PAIR_RULES: PairRule[] = [
  {
    pairKey: "amoxicillin|amoxiclav",
    status: "attention",
    riskScore: 9,
    summary: "Вероятное дублирование амоксициллина в комбинации.",
    explanation:
      "Амоксиклав уже содержит амоксициллин. Такая комбинация допустима только по прямому назначению врача.",
    comparison: "Амоксиклав + амоксициллин: риск дублирования действующего вещества.",
    doctorQuestions: ["Нужно ли оставлять оба препарата одновременно?"]
  },
  {
    pairKey: "cetirizine|loratadine",
    status: "caution",
    riskScore: 6,
    summary: "Обнаружено перекрытие антигистаминных препаратов.",
    explanation: "Два антигистаминных препарата обычно не требуют одновременного применения без явного обоснования.",
    comparison: "Цетиризин + лоратадин: препараты одного класса, проверьте схему у врача.",
    monitoring: ["сонливость", "сухость во рту"],
    doctorQuestions: ["Нужно ли принимать оба антигистаминных препарата в один период?"]
  },
  {
    pairKey: "ibuprofen|paracetamol",
    status: "caution",
    riskScore: 5,
    summary: "Комбинация возможна только по понятной схеме для конкретного возраста.",
    explanation: "Препараты не дублируют действующее вещество, но требуют чёткой схемы и контроля дозировок.",
    comparison: "Парацетамол и ибупрофен действуют по-разному; важны интервалы и возрастные ограничения.",
    monitoring: ["боль в животе", "тошнота"],
    doctorQuestions: ["Какой безопасный интервал между приёмами для вашего возраста?"]
  },
  {
    pairKey: "budesonide|salbutamol",
    status: "safe",
    riskScore: 3,
    summary: "Найдена типичная комбинация с разными ролями препаратов.",
    explanation:
      "Сальбутамол и будесонид обычно используются для разных задач: быстрое снятие спазма и контроль воспаления.",
    comparison: "Сальбутамол + будесонид: разные механизмы, не прямое дублирование."
  }
];

function pairKey(a: string, b: string): string {
  return [a, b].sort().join("|");
}

export function analyzeMedications(meds: Medication[], context: AnalysisContext = {}): AnalysisResult {
  const uniqueBySlug = new Map<string, Medication>();
  for (const med of meds) {
    if (!uniqueBySlug.has(med.slug)) {
      uniqueBySlug.set(med.slug, med);
    }
  }
  const uniqueMeds = Array.from(uniqueBySlug.values());
  const slugs = uniqueMeds.map((m) => m.slug);
  const categories = meds.map((m) => m.category);

  let status: AnalysisResult["status"] = "safe";
  let riskScore = 2;
  let summary = "Недостаточно данных для точного вывода по выбранной комбинации.";
  let explanation =
    "Базовые правила не обнаружили явный конфликт, но для точного вывода по этой паре может не хватать структурированных данных.";
  const monitoring: string[] = ["общее самочувствие", "температура", "сыпь", "затруднение дыхания"];
  const doctorQuestions: string[] = [];
  const comparison: string[] = [];

  const antibioticsCount = categories.filter((c) => c === "Антибиотик").length;
  const antihistamineCount = categories.filter((c) => c === "Антигистамин").length;

  if (antibioticsCount >= 2) {
    status = "attention";
    riskScore = 9;
    summary = "Есть сочетание антибиотиков, которое требует обязательного уточнения.";
    explanation = "В списке обнаружено два антибактериальных препарата. Такие схемы иногда используются врачом осознанно, но родителю важно дополнительно уточнить логику назначения.";
    doctorQuestions.push("Почему назначены два антибиотика одновременно?");
  }

  if (antihistamineCount >= 2 && status !== "attention") {
    status = "caution";
    riskScore = 6;
    summary = "Есть перекрытие антигистаминных препаратов.";
    explanation = "В списке есть два препарата одного класса. Это не всегда ошибка, но может потребовать уточнения у врача.";
    doctorQuestions.push("Нужно ли принимать оба антигистаминных препарата?");
  }

  let matchedRuleCount = 0;
  for (let i = 0; i < slugs.length; i += 1) {
    for (let j = i + 1; j < slugs.length; j += 1) {
      const rule = PAIR_RULES.find((item) => item.pairKey === pairKey(slugs[i], slugs[j]));
      if (!rule) {
        continue;
      }
      matchedRuleCount += 1;
      if (rule.status === "attention" || (rule.status === "caution" && status === "safe")) {
        status = rule.status;
      }
      riskScore = Math.max(riskScore, rule.riskScore);
      summary = rule.summary;
      explanation = rule.explanation;
      comparison.push(rule.comparison);
      if (rule.monitoring) {
        monitoring.push(...rule.monitoring);
      }
      if (rule.doctorQuestions) {
        doctorQuestions.push(...rule.doctorQuestions);
      }
    }
  }

  const hasMontelukast = slugs.includes("montelukast");
  if (hasMontelukast) {
    monitoring.push("сон и поведение");
    doctorQuestions.push("На какие изменения сна или поведения стоит обратить внимание?");
  }

  if (matchedRuleCount === 0 && slugs.length >= 2) {
    const pairLabel = uniqueMeds.map((med) => med.name).join(" + ");
    summary = `Недостаточно данных для точного вывода по сочетанию: ${pairLabel}.`;
    explanation =
      "Для этой пары в текущем наборе правил нет подтверждённого специфичного сценария. Нужна сверка официальных инструкций и консультация врача.";
    status = status === "attention" ? status : "caution";
    riskScore = Math.max(riskScore, 4);
    comparison.push(`Комбинация ${pairLabel}: нет подтверждённого точного правила в текущей локальной базе.`);
    doctorQuestions.push("Есть ли подтверждённые данные по этой комбинации для вашего возраста?");
  }

  if (typeof context.ageYears === "number" && context.ageYears >= 0 && context.ageYears <= 2) {
    status = status === "attention" ? "attention" : "caution";
    riskScore = Math.max(riskScore, 6);
    doctorQuestions.push("Подтвердите схему у врача для возраста 0–2 года.");
  }

  if (comparison.length === 0) {
    comparison.push("Недостаточно данных для точного вывода.");
  }

  return {
    status,
    riskScore,
    summary,
    explanation,
    monitoring: Array.from(new Set(monitoring)),
    doctorQuestions: Array.from(new Set(doctorQuestions)),
    comparison
  };
}
