import fs from "fs";
import path from "path";
import { shortId } from "../utils/ids";

const dbPath = path.resolve(process.cwd(), "data", "db.json");
const tmpPath = path.resolve(process.cwd(), "data", "db.tmp.json");
const backupPaths = [`${dbPath}.backup`, `${dbPath}.backup.1`, `${dbPath}.backup.2`];

export type DBShape = {
  cards: any[];
  history: any[];
  reminders: any[];
  reminderUsers: any[];
  reminderCourses: any[];
  reminderOccurrences: any[];
  reminderHistory: any[];
  reminderDrafts: any[];
  tracking: any[];
  purchaseState: Record<string, string[]>;
  safetyProfiles: any[];
  activeSafetyProfileByUser: Record<string, string>;
};

const EMPTY_DB: DBShape = {
  cards: [],
  history: [],
  reminders: [],
  reminderUsers: [],
  reminderCourses: [],
  reminderOccurrences: [],
  reminderHistory: [],
  reminderDrafts: [],
  tracking: [],
  purchaseState: {},
  safetyProfiles: [],
  activeSafetyProfileByUser: {}
};

let lastDbErrorMessage: string | null = null;
let schemaMigrationDone = false;

function cloneEmptyDb(): DBShape {
  return {
    cards: [],
    history: [],
    reminders: [],
    reminderUsers: [],
    reminderCourses: [],
    reminderOccurrences: [],
    reminderHistory: [],
    reminderDrafts: [],
    tracking: [],
    purchaseState: {},
    safetyProfiles: [],
    activeSafetyProfileByUser: {}
  };
}

function ensureDb() {
  if (!fs.existsSync(dbPath)) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.writeFileSync(dbPath, JSON.stringify(EMPTY_DB, null, 2), "utf-8");
  }
}

function sanitizeJsonInput(raw: string): string {
  if (!raw) {
    return "";
  }

  let text = raw.replace(/^\uFEFF/, "").trim();

  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)```$/i);
  if (fenced) {
    text = fenced[1].trim();
  }

  const firstJsonChar = text.search(/[\[{]/);
  if (firstJsonChar >= 0) {
    text = text.slice(firstJsonChar);
  }

  const lastObjectBrace = text.lastIndexOf("}");
  const lastArrayBrace = text.lastIndexOf("]");
  const lastJsonIndex = Math.max(lastObjectBrace, lastArrayBrace);
  if (lastJsonIndex >= 0) {
    text = text.slice(0, lastJsonIndex + 1);
  }

  if (!text.startsWith("{") && !text.startsWith("[")) {
    return "";
  }

  return text.trim();
}

function safeParse(raw: string): any {
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.error("JSON RAW:", raw);
    console.error("JSON parse error:", e);
    return null;
  }
}

function normalizeDbShape(input: any): DBShape {
  if (!input || typeof input !== "object") {
    return cloneEmptyDb();
  }

  return {
    cards: Array.isArray((input as any).cards) ? (input as any).cards : [],
    history: Array.isArray((input as any).history) ? (input as any).history : [],
    reminders: Array.isArray((input as any).reminders) ? (input as any).reminders : [],
    reminderUsers: Array.isArray((input as any).reminderUsers) ? (input as any).reminderUsers : [],
    reminderCourses: Array.isArray((input as any).reminderCourses) ? (input as any).reminderCourses : [],
    reminderOccurrences: Array.isArray((input as any).reminderOccurrences) ? (input as any).reminderOccurrences : [],
    reminderHistory: Array.isArray((input as any).reminderHistory) ? (input as any).reminderHistory : [],
    reminderDrafts: Array.isArray((input as any).reminderDrafts) ? (input as any).reminderDrafts : [],
    tracking: Array.isArray((input as any).tracking) ? (input as any).tracking : [],
    purchaseState:
      (input as any).purchaseState && typeof (input as any).purchaseState === "object"
        ? (input as any).purchaseState
        : {},
    safetyProfiles: Array.isArray((input as any).safetyProfiles) ? (input as any).safetyProfiles : [],
    activeSafetyProfileByUser:
      (input as any).activeSafetyProfileByUser && typeof (input as any).activeSafetyProfileByUser === "object"
        ? (input as any).activeSafetyProfileByUser
        : {}
  };
}

function rotateBackups(): void {
  for (let i = backupPaths.length - 1; i > 0; i -= 1) {
    const source = backupPaths[i - 1];
    const target = backupPaths[i];

    if (fs.existsSync(target)) {
      fs.rmSync(target, { force: true });
    }

    if (fs.existsSync(source)) {
      fs.renameSync(source, target);
    }
  }
}

function createDbBackup(): void {
  if (!fs.existsSync(dbPath)) {
    return;
  }

  rotateBackups();
  fs.copyFileSync(dbPath, backupPaths[0]);
  console.info(`DB backup created: ${backupPaths[0]}`);
}

function safeWritePayload(payload: string): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.writeFileSync(tmpPath, payload, "utf-8");

  try {
    fs.renameSync(tmpPath, dbPath);
  } catch (error) {
    // On Windows, rename over an existing target can fail (EPERM/EEXIST).
    // Fallback keeps the write recoverable-safe via backups, but is not strictly atomic.
    console.warn("DB rename over existing file failed; switching to recoverable-safe fallback", error);
    if (fs.existsSync(dbPath)) {
      fs.rmSync(dbPath, { force: true });
    }
    fs.renameSync(tmpPath, dbPath);
    console.warn("DB fallback replace completed (recoverable-safe, not strictly atomic on Windows)");
  } finally {
    if (fs.existsSync(tmpPath)) {
      try {
        fs.rmSync(tmpPath, { force: true });
      } catch (cleanupError) {
        console.error("Failed to cleanup temporary DB file", cleanupError);
      }
    }
  }
}

function restoreDbFromBackups(reason: string): DBShape | null {
  for (const backupPath of backupPaths) {
    if (!fs.existsSync(backupPath)) {
      continue;
    }

    try {
      const raw = fs.readFileSync(backupPath, "utf-8");
      const sanitized = sanitizeJsonInput(raw);
      if (!sanitized) {
        continue;
      }

      const parsed = safeParse(sanitized);
      if (!parsed) {
        continue;
      }

      const normalized = normalizeDbShape(parsed);
      fs.writeFileSync(dbPath, JSON.stringify(normalized, null, 2), "utf-8");
      console.warn(`DB restored from backup (${backupPath}) due to: ${reason}`);
      return normalized;
    } catch (restoreError) {
      console.error(`Failed restoring from backup ${backupPath}`, restoreError);
    }
  }

  return null;
}

function normalizeMedications(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === "string" ? item : item == null ? "" : String(item)))
      .map((item) => item.trim())
      .filter(Boolean);
  }

  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return [];
}

function normalizeCardRecord(raw: any, usedIds: Set<string>, index: number, fallbackTs: number): any {
  const input = raw && typeof raw === "object" ? raw : {};
  const { child: _legacyChild, ...rest } = input;

  const legacyChild = typeof input.child === "string" ? input.child.trim() : "";
  const currentChild = typeof input.childName === "string" ? input.childName.trim() : "";
  const childName = currentChild || legacyChild || "Не указано";

  let id = typeof input.id === "string" ? input.id.trim() : "";
  if (!id || usedIds.has(id)) {
    do {
      id = shortId();
    } while (usedIds.has(id));
  }
  usedIds.add(id);

  const createdAtNumber =
    typeof input.createdAt === "number"
      ? input.createdAt
      : typeof input.createdAt === "string"
      ? Number.parseInt(input.createdAt, 10)
      : Number.NaN;
  const createdAt =
    Number.isFinite(createdAtNumber) && createdAtNumber > 0
      ? Math.trunc(createdAtNumber)
      : fallbackTs + index;

  return {
    ...rest,
    id,
    childName,
    createdAt,
    medications: normalizeMedications(input.medications)
  };
}

function migrateCardsSchema(cards: any[]): { migrated: any[]; changed: boolean } {
  const source = Array.isArray(cards) ? cards : [];
  const usedIds = new Set<string>();
  const fallbackTs = Date.now();
  let changed = !Array.isArray(cards);

  const migrated = source.map((card, index) => {
    const normalized = normalizeCardRecord(card, usedIds, index, fallbackTs);
    const original = card && typeof card === "object" ? card : {};

    const originalMeds = normalizeMedications(original.medications);
    const medsChanged = JSON.stringify(normalized.medications) !== JSON.stringify(originalMeds);
    const childChanged =
      (typeof original.childName === "string" ? original.childName.trim() : "") !== normalized.childName ||
      Object.prototype.hasOwnProperty.call(original, "child");
    const idChanged = (typeof original.id === "string" ? original.id.trim() : "") !== normalized.id;
    const originalCreatedAt =
      typeof original.createdAt === "number"
        ? Math.trunc(original.createdAt)
        : typeof original.createdAt === "string"
        ? Number.parseInt(original.createdAt, 10)
        : Number.NaN;
    const createdAtChanged = originalCreatedAt !== normalized.createdAt;

    if (medsChanged || childChanged || idChanged || createdAtChanged) {
      changed = true;
    }

    return normalized;
  });

  return { migrated, changed };
}

export function migrateDbSchemaOnce(): void {
  if (schemaMigrationDone) {
    return;
  }
  schemaMigrationDone = true;

  ensureDb();
  const db = readDb();
  const { migrated, changed } = migrateCardsSchema(db.cards);
  if (!changed) {
    return;
  }

  writeDb({
    ...db,
    cards: migrated
  });
}

export function consumeLastDbError(): string | null {
  const message = lastDbErrorMessage;
  lastDbErrorMessage = null;
  return message;
}

export function readDb(): DBShape {
  try {
    ensureDb();
    const raw = fs.readFileSync(dbPath, "utf-8");
    const sanitized = sanitizeJsonInput(raw);

    if (!sanitized) {
      const restored = restoreDbFromBackups("empty or invalid JSON content");
      if (restored) {
        lastDbErrorMessage = null;
        return restored;
      }

      lastDbErrorMessage = null;
      const fallback = cloneEmptyDb();
      fs.writeFileSync(dbPath, JSON.stringify(fallback, null, 2), "utf-8");
      return fallback;
    }

    const parsed = safeParse(sanitized);
    if (!parsed) {
      const restored = restoreDbFromBackups("JSON parse failure");
      if (restored) {
        lastDbErrorMessage = "База была повреждена и восстановлена из backup";
        return restored;
      }

      lastDbErrorMessage = "Не удалось разобрать данные базы";
      const fallback = cloneEmptyDb();
      try {
        fs.writeFileSync(dbPath, JSON.stringify(fallback, null, 2), "utf-8");
      } catch (writeError) {
        console.error("Failed to rewrite DB after parse error", writeError);
      }
      return fallback;
    }

    const normalized = normalizeDbShape(parsed);

    if (sanitized !== raw) {
      fs.writeFileSync(dbPath, JSON.stringify(normalized, null, 2), "utf-8");
    }

    lastDbErrorMessage = null;
    return normalized;
  } catch (error) {
    console.error("Failed to read DB file", error);

    const restored = restoreDbFromBackups("read failure");
    if (restored) {
      lastDbErrorMessage = "База была восстановлена из backup после ошибки чтения";
      return restored;
    }

    lastDbErrorMessage = `Не удалось прочитать базу: ${
      error instanceof Error ? error.message : String(error)
    }`;
    return cloneEmptyDb();
  }
}

export function writeDb(data: DBShape): void {
  ensureDb();
  const normalized = normalizeDbShape(data);

  try {
    createDbBackup();
    const payload = JSON.stringify(normalized, null, 2);
    safeWritePayload(payload);
    console.info(`DB write success: ${dbPath}`);
  } catch (error) {
    console.error("DB write failed", error);

    const restored = restoreDbFromBackups("write failure");
    if (!restored) {
      try {
        fs.writeFileSync(dbPath, JSON.stringify(cloneEmptyDb(), null, 2), "utf-8");
      } catch (fallbackError) {
        console.error("Failed to persist fallback DB after write failure", fallbackError);
      }
    }

    throw error;
  }
}
