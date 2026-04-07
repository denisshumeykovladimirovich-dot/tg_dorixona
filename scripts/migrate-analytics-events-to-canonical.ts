import fs from "fs";
import path from "path";
import readline from "readline";
import { once } from "events";
import { toCanonicalEvent } from "../src/analytics/storage";
import type { AnalyticsEvent } from "../src/analytics/types";

const analyticsFilePath = path.resolve(process.cwd(), "data", "analytics-events.jsonl");
const tempFilePath = path.resolve(process.cwd(), "data", "analytics-events.canonical.tmp.jsonl");

function asNonEmptyString(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function asTimestamp(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string") {
    const asInt = Number.parseInt(value, 10);
    if (Number.isFinite(asInt)) {
      return Math.trunc(asInt);
    }
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return Math.trunc(parsed);
    }
  }
  return Number.NaN;
}

function toStrictAnalyticsEvent(raw: Record<string, unknown>, lineNumber: number): AnalyticsEvent {
  const id = asNonEmptyString(raw.id);
  const type = asNonEmptyString(raw.type);
  const userId = asNonEmptyString(raw.userId);
  const sessionId = asNonEmptyString(raw.sessionId);
  const timestamp = asTimestamp(raw.timestamp);
  const payload = raw.payload;

  if (!id || !type || !userId || !sessionId || !Number.isFinite(timestamp) || !payload || typeof payload !== "object") {
    throw new Error(`Line ${lineNumber}: missing required event fields`);
  }

  return {
    id,
    type: type as AnalyticsEvent["type"],
    userId,
    sessionId,
    timestamp,
    payload: payload as Record<string, unknown>
  };
}

function validateEventShape(event: AnalyticsEvent, lineNumber: number): void {
  if (
    !asNonEmptyString(event.id) ||
    !asNonEmptyString(event.type) ||
    !asNonEmptyString(event.userId) ||
    !asNonEmptyString(event.sessionId) ||
    !Number.isFinite(event.timestamp) ||
    !event.payload ||
    typeof event.payload !== "object" ||
    Array.isArray(event.payload)
  ) {
    throw new Error(`Line ${lineNumber}: canonical event failed shape validation`);
  }
}

async function migrate(): Promise<void> {
  if (!fs.existsSync(analyticsFilePath)) {
    console.log("analytics-events.jsonl not found, nothing to migrate.");
    return;
  }

  fs.mkdirSync(path.dirname(tempFilePath), { recursive: true });

  const readStream = fs.createReadStream(analyticsFilePath, { encoding: "utf-8" });
  const writeStream = fs.createWriteStream(tempFilePath, { encoding: "utf-8", flags: "w" });
  const rl = readline.createInterface({ input: readStream, crlfDelay: Infinity });

  let totalLines = 0;
  let migratedLines = 0;

  try {
    for await (const line of rl) {
      totalLines += 1;
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        throw new Error(`Line ${totalLines}: invalid JSON`);
      }

      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`Line ${totalLines}: expected JSON object`);
      }

      const strictEvent = toStrictAnalyticsEvent(parsed as Record<string, unknown>, totalLines);
      const canonicalEvent = toCanonicalEvent(strictEvent);
      validateEventShape(canonicalEvent, totalLines);

      writeStream.write(`${JSON.stringify(canonicalEvent)}\n`);
      migratedLines += 1;
    }

    writeStream.end();
    await once(writeStream, "finish");

    const backupPath = `${analyticsFilePath}.bak.${Date.now()}`;
    fs.renameSync(analyticsFilePath, backupPath);
    try {
      fs.renameSync(tempFilePath, analyticsFilePath);
    } catch (error) {
      fs.renameSync(backupPath, analyticsFilePath);
      throw error;
    }

    console.log(`Migration completed. Migrated ${migratedLines} event lines. Backup: ${backupPath}`);
  } catch (error) {
    rl.close();
    writeStream.destroy();
    if (fs.existsSync(tempFilePath)) {
      fs.unlinkSync(tempFilePath);
    }
    throw error;
  }
}

migrate().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Migration failed: ${message}`);
  process.exitCode = 1;
});
