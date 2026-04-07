import fs from "fs";
import path from "path";

export type DrugRecord = Record<string, unknown> & {
  id?: string;
  name?: string;
  aliases?: string[];
  symptoms?: string[];
  symptomTags?: string[];
  category?: string;
  identity?: {
    displayName?: { ru?: string; en?: string };
    activeSubstance?: { ru?: string; en?: string };
    normalizedKey?: string;
  };
  search?: {
    primaryTerms?: string[];
    brandNames?: string[];
    aliases?: string[];
    autocompleteBoost?: string[];
    searchTokens?: string[];
  };
};

export type DrugDb = DrugRecord[];

const CP1251_TABLE = [
  0x0402, 0x0403, 0x201a, 0x0453, 0x201e, 0x2026, 0x2020, 0x2021, 0x20ac, 0x2030, 0x0409, 0x2039, 0x040a, 0x040c,
  0x040b, 0x040f, 0x0452, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x0098, 0x2122, 0x0459, 0x203a,
  0x045a, 0x045c, 0x045b, 0x045f, 0x00a0, 0x040e, 0x045e, 0x0408, 0x00a4, 0x0490, 0x00a6, 0x00a7, 0x0401, 0x00a9,
  0x0404, 0x00ab, 0x00ac, 0x00ad, 0x00ae, 0x0407, 0x00b0, 0x00b1, 0x0406, 0x0456, 0x0491, 0x00b5, 0x00b6, 0x00b7,
  0x0451, 0x2116, 0x0454, 0x00bb, 0x0458, 0x0405, 0x0455, 0x0457
];

const UNICODE_TO_CP1251 = new Map<number, number>();
for (let value = 0; value < 128; value += 1) {
  UNICODE_TO_CP1251.set(value, value);
}
for (let value = 0xc0; value <= 0xff; value += 1) {
  UNICODE_TO_CP1251.set(0x0410 + (value - 0xc0), value);
}
UNICODE_TO_CP1251.set(0x0401, 0xa8);
UNICODE_TO_CP1251.set(0x0451, 0xb8);
for (let i = 0; i < CP1251_TABLE.length; i += 1) {
  UNICODE_TO_CP1251.set(CP1251_TABLE[i], 0x80 + i);
}

const INVISIBLE_RE = /[\u200B-\u200D\u2060\uFEFF\u00AD]/g;
const INVISIBLE_TEST_RE = /[\u200B-\u200D\u2060\uFEFF\u00AD]/;
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
const CYRILLIC_LOWER_RE = /[\u0430-\u044f\u0451]/gi;
const BROKEN_MARKERS_RE =
  /[\u00D0\u00D1\u00C2\u00C3\uFFFD\u0402\u0403\u0408\u0409\u040A\u040B\u040C\u040E\u040F\u0452\u0453\u0454\u0455\u0456\u0457\u0458\u0459\u045A\u045B\u045C\u045E\u045F]|вЂ|Р\s|С\s|РВ|СВ|В°|Вµ|В»/g;
const MOJIBAKE_PAIR_RE =
  /[\u0420\u0421][\u0400-\u042F\u00A0\u00B0\u2013\u2014\u2018\u2019\u201A\u201C\u201D\u2020\u2021\u2026\u2030\u2039\u203A\u2116]/g;

function encodeCp1251(input: string): Buffer | null {
  const bytes: number[] = [];
  for (const char of input) {
    const codePoint = char.codePointAt(0);
    if (typeof codePoint !== "number") {
      return null;
    }
    const mapped = UNICODE_TO_CP1251.get(codePoint);
    if (typeof mapped !== "number") {
      return null;
    }
    bytes.push(mapped);
  }
  return Buffer.from(bytes);
}

function decodeCp1251Mojibake(input: string): string | null {
  const encoded = encodeCp1251(input);
  if (!encoded) {
    return null;
  }
  try {
    return encoded.toString("utf8");
  } catch {
    return null;
  }
}

function normalizeWhitespaces(input: string): string {
  return input.replace(/\r\n/g, "\n").replace(/\u00A0/g, " ").replace(/\s+/g, " ").trim();
}

function sanitizeRawString(input: string): string {
  return normalizeWhitespaces(input.replace(INVISIBLE_RE, "").replace(CONTROL_RE, " "));
}

function qualityScore(input: string): number {
  if (!input) {
    return -50;
  }
  const cyrillicLower = (input.match(CYRILLIC_LOWER_RE) || []).length;
  const latin = (input.match(/[a-z]/gi) || []).length;
  const digits = (input.match(/\d/g) || []).length;
  const brokenMarkers = (input.match(BROKEN_MARKERS_RE) || []).length;
  const replacement = (input.match(/�/g) || []).length;
  const controls = (input.match(CONTROL_RE) || []).length;
  const punctuation = (input.match(/[.,:;!?()[\]/+\-–—]/g) || []).length;
  return cyrillicLower * 4 + latin * 2 + digits + punctuation - brokenMarkers * 6 - replacement * 12 - controls * 10;
}

export function looksBrokenText(input: string): boolean {
  const value = input.replace(INVISIBLE_RE, "").replace(CONTROL_RE, " ").trim();
  if (!value) {
    return false;
  }
  if (value.includes("�")) {
    return true;
  }
  const cyr = (value.match(CYRILLIC_LOWER_RE) || []).length;
  const brokenMarkers = (value.match(BROKEN_MARKERS_RE) || []).length;
  const pairMarkers = (value.match(MOJIBAKE_PAIR_RE) || []).length;
  return (brokenMarkers >= 2 && cyr === 0) || pairMarkers >= 2 || brokenMarkers >= 5;
}

export function normalizeText(input: string): { value: string; changed: boolean } {
  const sourceRaw = String(input || "");
  const source = sanitizeRawString(sourceRaw);
  const candidates = new Set<string>();
  const pushCandidate = (value: string | null | undefined): void => {
    if (!value) {
      return;
    }
    const normalized = sanitizeRawString(value);
    if (normalized) {
      candidates.add(normalized);
    }
  };

  const mutationCandidates = [
    sourceRaw,
    sourceRaw.replace(/\u00A0/g, ""),
    sourceRaw.replace(/[\u00A0 ]+/g, ""),
    sourceRaw.replace(/([\u0420\u0421])\s*\u0412(?=[\u00A0-\u04FF])/g, "$1"),
    sourceRaw.replace(/([\u0420\u0421])\s*\u0412(?=[\u00A0-\u04FF])/g, "$1").replace(/[\u00A0 ]+/g, "")
  ];
  for (const mutation of mutationCandidates) {
    pushCandidate(mutation);
    let current: string | null = mutation;
    for (let pass = 0; pass < 3; pass += 1) {
      current = current ? decodeCp1251Mojibake(current) : null;
      pushCandidate(current);
    }
  }

  let best = source;
  let bestScore = qualityScore(source);
  for (const candidate of candidates) {
    const score = qualityScore(candidate);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }

  return { value: sanitizeRawString(best), changed: sanitizeRawString(best) !== source };
}

export function normalizeMedicationNameForKey(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[–—−]/g, "-")
    .replace(/[|;]+/g, " ")
    .replace(/[^\p{L}\p{N}\s+\-]/gu, " ")
    .replace(/\s+/g, " ");
}

export function ensureUniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

export function cleanStringArray(values: unknown): { list: string[]; changed: boolean; droppedBroken: number } {
  if (!Array.isArray(values)) {
    return { list: [], changed: false, droppedBroken: 0 };
  }
  const result: string[] = [];
  let changed = false;
  let droppedBroken = 0;
  for (const value of values) {
    if (typeof value !== "string") {
      changed = true;
      continue;
    }
    const normalized = normalizeText(value);
    const text = normalized.value;
    if (!text || looksBrokenText(text)) {
      changed = true;
      droppedBroken += 1;
      continue;
    }
    if (normalized.changed || text !== value) {
      changed = true;
    }
    result.push(text);
  }
  return { list: ensureUniqueStrings(result), changed, droppedBroken };
}

export function deepNormalizeStrings(
  value: unknown
): { value: unknown; changedCount: number; brokenCountBefore: number; brokenCountAfter: number } {
  let changedCount = 0;
  let brokenCountBefore = 0;
  let brokenCountAfter = 0;

  const walk = (node: unknown): unknown => {
    if (typeof node === "string") {
      const beforeBroken = looksBrokenText(node);
      if (beforeBroken) {
        brokenCountBefore += 1;
      }
      const normalized = normalizeText(node);
      const cleanedValue = looksBrokenText(normalized.value) ? "" : normalized.value;
      if (normalized.changed || cleanedValue !== node) {
        changedCount += 1;
      }
      if (looksBrokenText(cleanedValue)) {
        brokenCountAfter += 1;
      }
      return cleanedValue;
    }
    if (Array.isArray(node)) {
      return node.map(walk);
    }
    if (node && typeof node === "object") {
      const objectNode = node as Record<string, unknown>;
      const next: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(objectNode)) {
        next[key] = walk(value);
      }
      return next;
    }
    return node;
  };

  return { value: walk(value), changedCount, brokenCountBefore, brokenCountAfter };
}

export function readDrugDatabase(cwd = process.cwd()): DrugDb {
  const dbPath = path.resolve(cwd, "src/data/drugDatabase.json");
  const raw = fs.readFileSync(dbPath, "utf8").replace(/^\uFEFF/, "");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("Expected src/data/drugDatabase.json to contain an array.");
  }
  return parsed as DrugDb;
}

export function writeDrugDatabase(db: DrugDb, cwd = process.cwd()): void {
  const dbPath = path.resolve(cwd, "src/data/drugDatabase.json");
  fs.writeFileSync(dbPath, `${JSON.stringify(db, null, 2)}\n`, { encoding: "utf8" });
}

export function hasInvisibleUnicode(input: string): boolean {
  return INVISIBLE_TEST_RE.test(input);
}
