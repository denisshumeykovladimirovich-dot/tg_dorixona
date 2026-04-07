export type ParsedDosage = {
  raw: string;
  value?: number;
  unit?: string;
  normalized?: string;
};

export type MedicationParseResult = {
  cleanedQuery: string;
  dosage?: ParsedDosage;
};

function normalizeUnit(unitRaw?: string): string | undefined {
  if (!unitRaw) {
    return undefined;
  }
  const lowered = unitRaw.toLowerCase();
  if (lowered === "mg" || lowered === "мг") {
    return "мг";
  }
  if (lowered === "ml" || lowered === "мл") {
    return "мл";
  }
  return undefined;
}

function parseNumber(valueRaw?: string): number | undefined {
  if (!valueRaw) {
    return undefined;
  }
  const normalized = valueRaw.replace(",", ".");
  const num = Number.parseFloat(normalized);
  return Number.isFinite(num) ? num : undefined;
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function extractDosage(input: string): MedicationParseResult {
  const source = input || "";
  let working = source;

  const ratioPattern = /(\d+(?:[.,]\d+)?)\s*(мг|mg|мл|ml)\s*\/\s*(\d+(?:[.,]\d+)?)\s*(мг|mg|мл|ml)/i;
  const singlePattern = /(\d+(?:[.,]\d+)?)\s*(мг|mg|мл|ml)\b/i;
  const trailingNumberPattern = /(?:^|\s)(\d{1,5})(?:\s*$)/;

  const ratioMatch = working.match(ratioPattern);
  if (ratioMatch) {
    const leftValue = parseNumber(ratioMatch[1]);
    const leftUnit = normalizeUnit(ratioMatch[2]);
    const rightValue = parseNumber(ratioMatch[3]);
    const rightUnit = normalizeUnit(ratioMatch[4]);
    const normalized =
      typeof leftValue === "number" && leftUnit && typeof rightValue === "number" && rightUnit
        ? `${leftValue} ${leftUnit}/${rightValue} ${rightUnit}`
        : compactWhitespace(ratioMatch[0]);

    working = compactWhitespace(working.replace(ratioMatch[0], " "));
    return {
      cleanedQuery: working,
      dosage: {
        raw: compactWhitespace(ratioMatch[0]),
        value: leftValue,
        unit: leftUnit,
        normalized
      }
    };
  }

  const singleMatch = working.match(singlePattern);
  if (singleMatch) {
    const value = parseNumber(singleMatch[1]);
    const unit = normalizeUnit(singleMatch[2]);
    const normalized = typeof value === "number" && unit ? `${value} ${unit}` : compactWhitespace(singleMatch[0]);

    working = compactWhitespace(working.replace(singleMatch[0], " "));
    return {
      cleanedQuery: working,
      dosage: {
        raw: compactWhitespace(singleMatch[0]),
        value,
        unit,
        normalized
      }
    };
  }

  const trailingNumberMatch = working.match(trailingNumberPattern);
  if (trailingNumberMatch) {
    const value = parseNumber(trailingNumberMatch[1]);
    const normalized = typeof value === "number" ? `${value} мг` : undefined;
    working = compactWhitespace(working.replace(trailingNumberMatch[0], " "));
    return {
      cleanedQuery: working,
      dosage: {
        raw: compactWhitespace(trailingNumberMatch[1]),
        value,
        unit: "мг",
        normalized
      }
    };
  }

  return {
    cleanedQuery: compactWhitespace(source)
  };
}
