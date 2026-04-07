import {
  hasInvisibleUnicode,
  looksBrokenText,
  normalizeMedicationNameForKey,
  readDrugDatabase,
  type DrugRecord
} from "./drugDatabaseUtils";

type ValidationIssue = {
  id: string;
  issue: string;
  details?: string;
};

function* walkStrings(node: unknown, pathPrefix = ""): Generator<{ path: string; value: string }> {
  if (typeof node === "string") {
    yield { path: pathPrefix, value: node };
    return;
  }
  if (Array.isArray(node)) {
    for (let index = 0; index < node.length; index += 1) {
      yield* walkStrings(node[index], `${pathPrefix}[${index}]`);
    }
    return;
  }
  if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      const nextPath = pathPrefix ? `${pathPrefix}.${key}` : key;
      yield* walkStrings(value, nextPath);
    }
  }
}

function validateRecords(records: DrugRecord[]): { issues: ValidationIssue[]; summary: Record<string, number> } {
  const issues: ValidationIssue[] = [];
  const idMap = new Map<string, string[]>();
  const nameMap = new Map<string, string[]>();
  let withSymptoms = 0;
  let withoutSymptoms = 0;
  let brokenStringFields = 0;
  let invisibleUnicodeFields = 0;

  for (const record of records) {
    const id = String(record.id || "").trim();
    const name = String(record.name || "").trim();
    const normalizedName = normalizeMedicationNameForKey(name);
    const hasSymptoms = (record.symptoms || []).length > 0 || (record.symptomTags || []).length > 0;
    if (hasSymptoms) {
      withSymptoms += 1;
    } else {
      withoutSymptoms += 1;
    }

    if (!id) {
      issues.push({ id: "(missing-id)", issue: "empty_id" });
    } else {
      const ids = idMap.get(id) || [];
      ids.push(name || "(empty-name)");
      idMap.set(id, ids);
    }

    if (!name) {
      issues.push({ id: id || "(missing-id)", issue: "empty_name" });
    } else {
      const names = nameMap.get(normalizedName) || [];
      names.push(id || "(missing-id)");
      nameMap.set(normalizedName, names);
    }

    for (const field of walkStrings(record)) {
      if (looksBrokenText(field.value)) {
        brokenStringFields += 1;
        issues.push({
          id: id || "(missing-id)",
          issue: "broken_encoding",
          details: field.path
        });
      }
      if (hasInvisibleUnicode(field.value)) {
        invisibleUnicodeFields += 1;
        issues.push({
          id: id || "(missing-id)",
          issue: "invisible_unicode",
          details: field.path
        });
      }
    }
  }

  for (const [id, names] of idMap.entries()) {
    if (names.length > 1) {
      issues.push({
        id,
        issue: "duplicate_id",
        details: names.join(", ")
      });
    }
  }

  for (const [normalizedName, ids] of nameMap.entries()) {
    if (normalizedName && ids.length > 1) {
      issues.push({
        id: ids[0],
        issue: "duplicate_canonical_name",
        details: `${normalizedName}: ${ids.join(", ")}`
      });
    }
  }

  return {
    issues,
    summary: {
      total: records.length,
      withSymptoms,
      withoutSymptoms,
      brokenStringFields,
      invisibleUnicodeFields
    }
  };
}

function main(): void {
  const records = readDrugDatabase();
  const { issues, summary } = validateRecords(records);
  const grouped = issues.reduce<Record<string, number>>((acc, item) => {
    acc[item.issue] = (acc[item.issue] || 0) + 1;
    return acc;
  }, {});

  console.info(JSON.stringify({ summary, groupedIssues: grouped }, null, 2));

  if (issues.length > 0) {
    console.info("validation_issues_sample:");
    for (const issue of issues.slice(0, 40)) {
      console.info(`- ${issue.issue} | ${issue.id}${issue.details ? ` | ${issue.details}` : ""}`);
    }
  }

  const critical = issues.some((issue) =>
    ["empty_id", "empty_name", "duplicate_id", "duplicate_canonical_name", "broken_encoding"].includes(issue.issue)
  );
  if (critical) {
    process.exitCode = 1;
  }
}

main();
