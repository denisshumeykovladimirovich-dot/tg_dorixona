export interface DrugFallbackResult {
  found: boolean;
  name?: string;
  possible_generic_name?: string;
  category?: string;
  short_description?: string;
  source_label?: "medical_catalog" | "wikipedia";
  source_url?: string;
}

const FALLBACK_TIMEOUT_MS = 4500;
const MAX_TEXT_LENGTH = 320;
const MEDICAL_SOURCES = [
  {
    label: "medical_catalog" as const,
    url: (encoded: string) => `https://arzondorixona.uz/search?q=${encoded}`
  },
  {
    label: "medical_catalog" as const,
    url: (encoded: string) => `https://apteka.uz/uz/search?query=${encoded}`
  }
];
const MEDICINE_KEYWORDS = [
  "таблет",
  "капсул",
  "сироп",
  "суспенз",
  "ампул",
  "инъек",
  "мазь",
  "крем",
  "действующее вещество",
  "лекарств",
  "dorixona",
  "dori",
  "tablet",
  "capsule",
  "syrup",
  "medicine",
  "drug"
];

function sanitizeText(value: unknown, maxLength = MAX_TEXT_LENGTH): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const cleaned = value.replace(/\s+/g, " ").trim();
  if (!cleaned) {
    return undefined;
  }
  if (cleaned.length <= maxLength) {
    return cleaned;
  }
  return `${cleaned.slice(0, maxLength - 3).trimEnd()}...`;
}

function parsePossibleGenericName(name?: string): string | undefined {
  if (!name) {
    return undefined;
  }
  const match = name.match(/\(([^)]+)\)/);
  return sanitizeText(match?.[1]);
}

async function fetchWithTimeout(
  url: string,
  timeoutMs = FALLBACK_TIMEOUT_MS,
  accept = "application/json"
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      method: "GET",
      headers: {
        accept,
        "user-agent": "tg-dorixona-bot/1.0"
      },
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function pickMatch(text: string, re: RegExp, maxLength = 120): string | undefined {
  const match = text.match(re);
  return sanitizeText(match?.[1], maxLength);
}

function hasMedicineSignals(input: string): boolean {
  const lowered = input.toLowerCase();
  return MEDICINE_KEYWORDS.some((keyword) => lowered.includes(keyword));
}

function isValidMedicalResult(result: DrugFallbackResult): boolean {
  if (!result.name) {
    return false;
  }
  const combined = [result.name, result.possible_generic_name, result.category, result.short_description]
    .filter(Boolean)
    .join(" ");
  return hasMedicineSignals(combined);
}

function normalizeMedicalHtmlResult(html: string, query: string, sourceUrl: string): DrugFallbackResult {
  const textOnly = stripHtml(html);
  const metaDescription =
    pickMatch(html, /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i, 260) ||
    pickMatch(html, /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i, 260);
  const ogTitle = pickMatch(html, /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i, 120);
  const title = pickMatch(html, /<title[^>]*>([^<]+)<\/title>/i, 120);
  const name = sanitizeText(ogTitle || title, 120);

  const generic = pickMatch(
    textOnly,
    /(?:действующее вещество|active ingredient|xalqaro nomi|international name)\s*[:\-]\s*([^\.;]{2,120})/i,
    120
  );
  const category = pickMatch(
    textOnly,
    /(?:категория|фармакологическая группа|группа|category)\s*[:\-]\s*([^\.;]{2,120})/i,
    120
  );

  const fallbackSnippet = sanitizeText(
    textOnly
      .split(/(?<=[\.\!\?])\s+/)
      .find((line) => {
        const lowered = line.toLowerCase();
        return lowered.includes(query.toLowerCase()) || hasMedicineSignals(lowered);
      }),
    MAX_TEXT_LENGTH
  );

  const result: DrugFallbackResult = {
    found: Boolean(name),
    name,
    possible_generic_name: generic || parsePossibleGenericName(name),
    category,
    short_description: metaDescription || fallbackSnippet,
    source_label: "medical_catalog",
    source_url: sanitizeText(sourceUrl, 240)
  };

  if (!isValidMedicalResult(result)) {
    return { found: false };
  }
  return result;
}

function normalizeWikipediaResult(raw: any): DrugFallbackResult {
  const pageTitle = sanitizeText(raw?.title, 120);
  const description = sanitizeText(raw?.description, 80);
  const extract = sanitizeText(raw?.extract, MAX_TEXT_LENGTH);
  const contentUrls = raw?.content_urls;
  const sourceUrl = sanitizeText(contentUrls?.desktop?.page || contentUrls?.mobile?.page, 240);

  if (!pageTitle && !extract) {
    return { found: false };
  }

  return {
    found: true,
    name: pageTitle,
    possible_generic_name: parsePossibleGenericName(pageTitle),
    category: description,
    short_description: extract,
    source_label: "wikipedia",
    source_url: sourceUrl
  };
}

async function lookupMedicalSource(query: string): Promise<DrugFallbackResult> {
  console.info("medical_lookup_query:", query);
  const encoded = encodeURIComponent(query);

  for (const source of MEDICAL_SOURCES) {
    const endpoint = source.url(encoded);
    try {
      const response = await fetchWithTimeout(endpoint, FALLBACK_TIMEOUT_MS, "text/html,application/xhtml+xml");
      if (!response.ok) {
        continue;
      }

      const html = await response.text();
      const normalized = normalizeMedicalHtmlResult(html, query, endpoint);
      if (normalized.found) {
        console.info("medical_lookup_found:", true);
        console.info("medical_lookup_name:", normalized.name ?? null);
        return normalized;
      }
    } catch (error) {
      console.error("medical_lookup_error:", error);
      continue;
    }
  }

  console.info("medical_lookup_found:", false);
  console.info("medical_lookup_name:", null);
  return { found: false };
}

async function lookupWikipediaFallback(query: string): Promise<DrugFallbackResult> {
  const encoded = encodeURIComponent(query);
  const endpoints = [
    `https://ru.wikipedia.org/api/rest_v1/page/summary/${encoded}`,
    `https://en.wikipedia.org/api/rest_v1/page/summary/${encoded}`
  ];

  for (const endpoint of endpoints) {
    try {
      const response = await fetchWithTimeout(endpoint);
      if (!response.ok) {
        continue;
      }
      const payload = await response.json();
      const normalized = normalizeWikipediaResult(payload);
      if (normalized.found) {
        return normalized;
      }
    } catch (error) {
      console.error("fallback_lookup_error:", error);
      continue;
    }
  }

  return { found: false };
}

export async function lookupDrugFallback(query: string): Promise<DrugFallbackResult> {
  const cleanedQuery = sanitizeText(query, 120);
  if (!cleanedQuery) {
    return { found: false };
  }

  const medicalResult = await lookupMedicalSource(cleanedQuery);
  if (medicalResult.found) {
    return medicalResult;
  }

  return lookupWikipediaFallback(cleanedQuery);
}

export function formatDrugFallbackMessage(result: DrugFallbackResult): string {
  if (!result.found) {
    return [
      "Не удалось найти препарат ни в локальной базе, ни в справочном поиске.",
      "Проверьте написание названия, попробуйте международное название или отправьте фото упаковки/полное название."
    ].join("\n");
  }

  const sourceLabel =
    result.source_label === "medical_catalog"
      ? "аптечный справочник"
      : result.source_label === "wikipedia"
      ? "справочная статья"
      : "справочный источник";

  const lines = [
    "Препарат не найден в локальной базе.",
    "Ниже предварительная справочная информация, её нужно перепроверить по инструкции или у врача.",
    "",
    "Возможно найдено:",
    `• Название: ${result.name || "не указано"}`,
    `• Действующее вещество: ${result.possible_generic_name || "не указано"}`,
    `• Категория: ${result.category || "не указано"}`,
    `• Краткое описание: ${result.short_description || "не указано"}`,
    `• Источник: ${sourceLabel}${result.source_url ? ` (${result.source_url})` : ""}`,
    "",
    "Важно:",
    "Я не могу на основе этих данных подтверждать совместимость, дозировку или допустимость приёма."
  ];

  return lines.join("\n");
}
