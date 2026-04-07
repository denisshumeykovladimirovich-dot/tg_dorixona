import fs from "fs";
import path from "path";
import {
  cleanStringArray,
  deepNormalizeStrings,
  ensureUniqueStrings,
  looksBrokenText,
  normalizeMedicationNameForKey,
  normalizeText,
  readDrugDatabase,
  writeDrugDatabase,
  type DrugRecord
} from "./drugDatabaseUtils";

type DrugReportItem = {
  id: string;
  displayName: string;
  aliases: string[];
  category: string;
  symptoms: string[];
  symptomTags: string[];
  hasSymptoms: boolean;
  recoveredFromEncodingIssue: boolean;
  needsManualReview: boolean;
  changedFieldsCount: number;
  brokenBefore: number;
  brokenAfter: number;
};

function firstValidName(candidates: unknown[]): string {
  for (const candidate of candidates) {
    if (typeof candidate !== "string") {
      continue;
    }
    const normalized = normalizeText(candidate).value;
    if (!normalized || looksBrokenText(normalized)) {
      continue;
    }
    return normalized;
  }
  return "";
}

function normalizeRecord(input: DrugRecord): { record: DrugRecord; report: DrugReportItem } {
  const { value, changedCount, brokenCountBefore, brokenCountAfter } = deepNormalizeStrings(input);
  const record = value as DrugRecord;
  const id = String(record.id || "").trim();

  const canonicalName =
    firstValidName([
      record.name,
      record.identity?.displayName?.ru,
      record.identity?.activeSubstance?.ru,
      record.identity?.displayName?.en,
      record.identity?.activeSubstance?.en
    ]) || id;

  record.name = canonicalName;
  const resolvedEnName =
    firstValidName([record.identity?.displayName?.en, record.identity?.activeSubstance?.en, record.name]) || canonicalName;
  const resolvedRuName =
    firstValidName([record.identity?.displayName?.ru, record.identity?.activeSubstance?.ru, record.name, resolvedEnName]) ||
    canonicalName;
  const hasCyrillicRu = /[\u0430-\u044f\u0451]/i.test(resolvedRuName);
  const hasLatinRu = /[a-z]/i.test(resolvedRuName);
  const usedSafeFallbackForRu = !hasCyrillicRu && hasLatinRu;

  record.identity = record.identity || {};
  record.identity.displayName = record.identity.displayName || {};
  record.identity.activeSubstance = record.identity.activeSubstance || {};
  record.identity.displayName.ru = resolvedRuName;
  record.identity.displayName.en = resolvedEnName;
  record.identity.activeSubstance.ru = firstValidName([record.identity.activeSubstance.ru, resolvedRuName]) || resolvedRuName;
  record.identity.activeSubstance.en = firstValidName([record.identity.activeSubstance.en, resolvedEnName]) || resolvedEnName;

  const aliasesCleaned = cleanStringArray(record.aliases);
  const symptomsCleaned = cleanStringArray(record.symptoms);
  const tagsCleaned = cleanStringArray(record.symptomTags);
  record.aliases = ensureUniqueStrings([
    ...aliasesCleaned.list,
    resolvedRuName,
    resolvedEnName,
    canonicalName,
    id.replace(/[-_]/g, " ")
  ]);
  record.symptoms = symptomsCleaned.list;
  record.symptomTags = tagsCleaned.list;

  const categoryCandidate = firstValidName([record.category]);
  record.category = categoryCandidate || "Прочее";

  const search = (record.search = record.search || {});
  const primaryTerms = cleanStringArray(search.primaryTerms);
  const brandNames = cleanStringArray(search.brandNames);
  const searchAliases = cleanStringArray(search.aliases);
  const autocompleteBoost = cleanStringArray(search.autocompleteBoost);
  const searchTokens = cleanStringArray(search.searchTokens);

  search.primaryTerms = ensureUniqueStrings([canonicalName, resolvedRuName, resolvedEnName, ...(primaryTerms.list || [])]);
  search.brandNames = ensureUniqueStrings([...(brandNames.list || [])]);
  search.aliases = ensureUniqueStrings([...(searchAliases.list || []), ...(record.aliases || [])]);
  search.autocompleteBoost = ensureUniqueStrings([
    canonicalName,
    resolvedRuName,
    resolvedEnName,
    ...(autocompleteBoost.list || [])
  ]);
  search.searchTokens = ensureUniqueStrings([
    canonicalName,
    canonicalName.toLowerCase(),
    resolvedRuName,
    resolvedEnName,
    normalizeMedicationNameForKey(canonicalName),
    normalizeMedicationNameForKey(resolvedRuName),
    normalizeMedicationNameForKey(resolvedEnName),
    normalizeMedicationNameForKey(id),
    ...(searchTokens.list || []),
    ...(search.primaryTerms || []),
    ...(search.aliases || []),
    ...(search.brandNames || [])
  ]);

  const brokenAfterNormalization = deepNormalizeStrings(record).brokenCountAfter;
  const hasSymptoms = (record.symptoms || []).length > 0 || (record.symptomTags || []).length > 0;
  const recoveredFromEncodingIssue = (brokenCountBefore > 0 && brokenAfterNormalization === 0) || usedSafeFallbackForRu;
  const needsManualReview =
    !record.name ||
    record.name === id ||
    looksBrokenText(record.name) ||
    brokenAfterNormalization > 0 ||
    !record.identity?.displayName?.ru ||
    usedSafeFallbackForRu;

  return {
    record,
    report: {
      id,
      displayName: record.name,
      aliases: record.aliases || [],
      category: record.category || "Прочее",
      symptoms: record.symptoms || [],
      symptomTags: record.symptomTags || [],
      hasSymptoms,
      recoveredFromEncodingIssue,
      needsManualReview,
      changedFieldsCount: changedCount,
      brokenBefore: brokenCountBefore,
      brokenAfter: brokenAfterNormalization
    }
  };
}

function buildReportMarkdown(items: DrugReportItem[]): string {
  const total = items.length;
  const withSymptoms = items.filter((item) => item.hasSymptoms);
  const withoutSymptoms = items.filter((item) => !item.hasSymptoms);
  const recovered = items.filter((item) => item.recoveredFromEncodingIssue);
  const needsReview = items.filter((item) => item.needsManualReview);

  const renderDrugBlock = (item: DrugReportItem): string => {
    const statuses = [
      item.hasSymptoms ? "has_symptoms" : "no_symptoms",
      item.recoveredFromEncodingIssue ? "recovered_from_encoding_issue" : "",
      item.needsManualReview ? "needs_manual_review" : ""
    ].filter(Boolean);

    return [
      "## Препарат",
      `- id: ${item.id}`,
      `- display name: ${item.displayName}`,
      `- aliases: ${item.aliases.length > 0 ? item.aliases.join(", ") : "-"}`,
      `- category: ${item.category || "-"}`,
      `- symptoms: ${item.symptoms.length > 0 ? item.symptoms.join(", ") : "-"}`,
      `- symptomTags: ${item.symptomTags.length > 0 ? item.symptomTags.join(", ") : "-"}`,
      "- status:",
      ...statuses.map((status) => `  - ${status}`),
      `- changed_fields_count: ${item.changedFieldsCount}`,
      `- broken_before: ${item.brokenBefore}`,
      `- broken_after: ${item.brokenAfter}`,
      ""
    ].join("\n");
  };

  return [
    "# REPORT_DRUGS_AND_SYMPTOMS",
    "",
    `- всего препаратов: ${total}`,
    `- препаратов с symptoms: ${withSymptoms.length}`,
    `- препаратов без symptoms: ${withoutSymptoms.length}`,
    `- записей исправлено по кодировке: ${recovered.length}`,
    `- записей требуют ручной проверки: ${needsReview.length}`,
    "",
    "## Список препаратов с symptoms",
    ...withSymptoms.map((item) => `- ${item.id}: ${item.displayName}`),
    "",
    "## Список препаратов без symptoms",
    ...withoutSymptoms.map((item) => `- ${item.id}: ${item.displayName}`),
    "",
    "## Список записей для ручной проверки",
    ...(needsReview.length > 0 ? needsReview.map((item) => `- ${item.id}: ${item.displayName}`) : ["- нет"]),
    "",
    "## Подробно по каждому препарату",
    "",
    ...items.map((item) => renderDrugBlock(item))
  ].join("\n");
}

function main(): void {
  const db = readDrugDatabase();
  const normalized: DrugRecord[] = [];
  const reportItems: DrugReportItem[] = [];

  for (const record of db) {
    const { record: cleanRecord, report } = normalizeRecord(record);
    normalized.push(cleanRecord);
    reportItems.push(report);
  }

  writeDrugDatabase(normalized);
  const reportMarkdown = buildReportMarkdown(reportItems);
  const reportPath = path.resolve(process.cwd(), "REPORT_DRUGS_AND_SYMPTOMS.md");
  fs.writeFileSync(reportPath, reportMarkdown, { encoding: "utf8" });

  console.info(
    JSON.stringify(
      {
        total: reportItems.length,
        withSymptoms: reportItems.filter((item) => item.hasSymptoms).length,
        withoutSymptoms: reportItems.filter((item) => !item.hasSymptoms).length,
        recoveredFromEncodingIssue: reportItems.filter((item) => item.recoveredFromEncodingIssue).length,
        needsManualReview: reportItems.filter((item) => item.needsManualReview).length,
        reportPath
      },
      null,
      2
    )
  );
}

main();
