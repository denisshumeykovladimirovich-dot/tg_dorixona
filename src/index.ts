import "dotenv/config";
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import cron from "node-cron";
import { Telegraf, Markup } from "telegraf";
import { MEDICATIONS, parseMedications } from "./core/medicationCatalog";
import type { Medication } from "./core/medicationCatalog";
import PRIMARY_DRUG_DATABASE from "./data/drugDatabase.json";
import { analyzeMedications } from "./core/analysisEngine";
import type { AnalysisResult } from "./core/analysisEngine";
import { lookupLocalMedicationSmart, normalizeMedicationQuery } from "./core/localMedicationLookup";
import {
  routeByGoldenSymptom,
  validateGoldenDrugSafetyTop20Runtime,
  validateGoldenSymptomMapRuntime
} from "./core/goldenSymptomRouter";
import { detectEmergencyRedFlags, validateEmergencyRuleset } from "./core/emergencyRedFlagRouter";
import {
  createSafetyProfile,
  deleteSafetyProfile,
  getActiveSafetyProfile,
  listSafetyProfiles,
  setActiveSafetyProfile,
  type SafetyProfile,
  updateSafetyProfile
} from "./core/safetyProfileEngine";
import { redactPatientContextForLog, resolvePatientContext } from "./core/patientContextRouter";
import { extractDosage } from "./core/dosageParser";
import { getArzonAptekaSearchUrl, type PharmacyLocale } from "./core/pharmacyEngine";
import {
  acceptReminderLegalAck,
  addReminder,
  clearReminderDraft,
  createReminderCourse,
  deleteReminderCourse,
  getCourseProgress,
  getPendingReminderNotifications,
  getPendingReminders,
  getReminderCourse,
  getReminderDraft,
  getReminderUser,
  listReminderHistory,
  getReminderStats,
  hasReminderLegalAck,
  listCourseOccurrences,
  listReminderCourses,
  listTodayOccurrences,
  markNowTaken,
  markOccurrenceSent,
  markOccurrenceSkipped,
  markOccurrenceTaken,
  markReminderSent,
  saveReminderDraft,
  setReminderNotificationsEnabled,
  setReminderQuietHours,
  setReminderCourseStatus,
  shouldSendReminderNow,
  snoozeOccurrence,
  upsertReminderUser,
  type ReminderCourse,
  type ReminderDraft,
  type ReminderOccurrence
} from "./core/reminderEngine";
import { createFamilyCard, getFamilyCard, getShareLink, getUserHistory } from "./core/familyCardEngine";
import { migrateDbSchemaOnce } from "./storage/db";
import { trackEvent } from "./core/trackingEngine";
import { mirrorBotEventToAnalytics } from "./analytics/botEventAdapter";

const token = process.env.BOT_TOKEN;
const botUsername = process.env.BOT_USERNAME || "your_bot_username";
const LIVE_INTERACTIONS_LOG_PATH = path.resolve(process.cwd(), "data", "live_interactions.log");

function appendLiveInteractionLog(payload: Record<string, unknown>): void {
  try {
    fs.mkdirSync(path.dirname(LIVE_INTERACTIONS_LOG_PATH), { recursive: true });
    fs.appendFileSync(
      LIVE_INTERACTIONS_LOG_PATH,
      `${JSON.stringify({ timestamp: new Date().toISOString(), ...payload })}\n`,
      "utf-8"
    );
  } catch (error) {
    console.error("live_interaction_log_error:", error);
  }
}

function getDraftSnapshot(userId?: number): Record<string, unknown> | null {
  if (typeof userId !== "number") {
    return null;
  }
  const draft = draftMap.get(userId);
  if (!draft) {
    return null;
  }
  return {
    age: draft.age || null,
    symptoms: draft.symptoms || null,
    medicationsInput: draft.medicationsInput || null,
    appendMode: Boolean((draft as any).appendMode),
    medications: draft.medications || []
  };
}

function logEvent(event: string, payload: Record<string, unknown> = {}): void {
  const resolvedSessionId = resolveAnalyticsSessionId(payload);
  const normalized = {
    event,
    timestamp: new Date().toISOString(),
    ...payload,
    ...(resolvedSessionId ? { sessionId: resolvedSessionId } : {})
  };
  console.info("event_log:", normalized);
  appendLiveInteractionLog(normalized);
  mirrorBotEventToAnalytics(event, normalized);
}

function validateConfig(): void {
  const problems: string[] = [];

  if (!token || token === "PASTE_YOUR_BOT_TOKEN_HERE") {
    problems.push("BOT_TOKEN не задан или содержит шаблонное значение.");
  }

  if (!process.env.BOT_USERNAME || botUsername === "your_bot_username") {
    problems.push("BOT_USERNAME не задан или содержит шаблонное значение.");
  }

  const dataDir = path.resolve(process.cwd(), "data");
  const dbPath = path.resolve(dataDir, "db.json");
  const probePath = path.resolve(dataDir, ".startup-write-probe");

  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.accessSync(dataDir, fs.constants.R_OK | fs.constants.W_OK);
  } catch (error) {
    problems.push(
      `Папка data недоступна для чтения/записи: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  try {
    fs.writeFileSync(probePath, "ok", "utf-8");
    fs.rmSync(probePath, { force: true });
  } catch (error) {
    problems.push(`Нет прав записи в папку data: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    if (fs.existsSync(dbPath)) {
      fs.accessSync(dbPath, fs.constants.R_OK | fs.constants.W_OK);
    }
  } catch (error) {
    problems.push(
      `Файл db.json недоступен для чтения/записи: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (problems.length > 0) {
    throw new Error(`Startup config validation failed:\n- ${problems.join("\n- ")}`);
  }

  console.info("Startup: config validated");
}

const bot = new Telegraf(token as string);
bot.use(async (ctx, next) => {
  const userId = ctx.from?.id ?? null;
  const chatId = (ctx.chat as any)?.id ?? null;
  const currentStep = typeof userId === "number" ? stepMap.get(userId) || "idle" : "idle";
  const updateType = "callback_query" in ctx.update ? "callback" : "text";
  const textInput = "message" in ctx.update ? (ctx.update.message as any)?.text ?? null : null;
  const callbackData =
    "callback_query" in ctx.update ? (ctx.update.callback_query as any)?.data ?? null : null;
  const callbackDataLength = callbackData ? String(callbackData).length : 0;

  logEvent(updateType === "callback" ? "callback_received" : "message_input_received", {
    userId,
    chatId,
    currentStep,
    callbackData,
    callbackDataLength,
    rawInput: textInput,
    draftSnapshot: getDraftSnapshot(typeof userId === "number" ? userId : undefined)
  });
  return next();
});

type PendingDraft = {
  age?: string;
  symptoms?: string;
  medicationsInput?: string;
  appendMode?: boolean;
  analysisPathHint?: string;
  medications?: string[];
  medicationEntries?: MedicationEntry[];
  analysis?: any;
  pendingLocalCandidate?: string;
  pendingLocalCandidateInput?: string;
};

type ProfileWizardDraft = {
  mode: "create" | "edit" | "temporary";
  profileId?: string;
  label: string;
  ageYears: number | null;
  pregnancyOrLactation: boolean;
  hasDrugAllergy: boolean;
  drugAllergyNotes: string;
  hasGiRisk: boolean;
  hasLiverRisk: boolean;
  hasKidneyRisk: boolean;
  hasChronicCondition: boolean;
  notes: string;
};

type MedicationEntry = {
  name: string;
  dose?: number;
  unit?: "мг" | "мл" | "unknown";
  dosageRaw?: string;
  dosageNormalized?: string;
};

type CatalogDrug = {
  id: string;
  name: string;
  synonyms: string[];
  category: string;
  symptoms: string[];
  symptomTags: string[];
  shortInfo?: string;
  isSponsored?: boolean;
  sourceNameRaw?: string;
  sourceNameField?: string;
};

type PrimaryDrugDbRecord = {
  schemaVersion?: number;
  id: string;
  name?: string;
  aliases?: string[];
  symptoms?: string[];
  symptomTags?: string[];
  indications?: string[];
  isSponsored?: boolean;
  activeSubstance?: string;
  displayName?: string;
  synonyms?: string[];
  category?: string;
  isActive?: boolean;
  identity?: {
    activeSubstance?: {
      ru?: string;
      en?: string;
      latinSlug?: string;
    };
    displayName?: {
      ru?: string;
      en?: string;
    };
    normalizedKey?: string;
  };
  search?: {
    primaryTerms?: string[];
    brandNames?: string[];
    aliases?: string[];
    misspellings?: string[];
    transliterations?: string[];
    autocompleteBoost?: string[];
    searchTokens?: string[];
  };
  classification?: {
    pharmacologicalClass?: string[];
    therapeuticClass?: string[];
    interactionGroups?: string[];
    routeGroups?: string[];
  };
  ageRestrictions?: {
    minAgeYears?: number | null;
    maxAgeYears?: number | null;
    pediatricUse?: boolean;
    notes?: string;
  };
  safety?: {
    mainRisks?: string[];
    contraindicationSignals?: string[];
    duplicateTherapyGroups?: string[];
    sedationLevel?: string;
    riskPriority?: string;
  };
};

type ResolvedDrug = {
  catalog: CatalogDrug | null;
  primary: PrimaryDrugDbRecord | null;
  normalizedKey: string | null;
};

const draftMap = new Map<number, PendingDraft>();
const stepMap = new Map<number, string>();
const reminderPromptMap = new Map<number, { cardId: string; createdAt: number }>();
const profileWizardMap = new Map<number, ProfileWizardDraft>();
const temporaryProfileMap = new Map<number, SafetyProfile>();
const STATE_TIMEOUT_MS = 10 * 60 * 1000;

type UserSessionState = {
  version: number;
  awaitingSuggestion: boolean;
  updatedAt: number;
};

const sessionStateMap = new Map<number, UserSessionState>();
const ANALYTICS_SESSION_TIMEOUT_MS = 30 * 60 * 1000;

type AnalyticsSessionState = {
  sessionId: string;
  startedAt: number;
  lastSeenAt: number;
};

const analyticsSessionMap = new Map<number, AnalyticsSessionState>();

function startAnalyticsSession(userId: number): string {
  const now = Date.now();
  const sessionId = randomUUID();
  analyticsSessionMap.set(userId, {
    sessionId,
    startedAt: now,
    lastSeenAt: now
  });
  return sessionId;
}

function ensureAnalyticsSession(userId: number): string {
  const now = Date.now();
  const current = analyticsSessionMap.get(userId);
  if (!current) {
    return startAnalyticsSession(userId);
  }
  if (now - current.lastSeenAt >= ANALYTICS_SESSION_TIMEOUT_MS) {
    return startAnalyticsSession(userId);
  }
  current.lastSeenAt = now;
  analyticsSessionMap.set(userId, current);
  return current.sessionId;
}

function resolveAnalyticsSessionId(payload: Record<string, unknown>): string | null {
  const existing = typeof payload.sessionId === "string" ? payload.sessionId.trim() : "";
  if (existing) {
    return existing;
  }
  const userId = typeof payload.userId === "number" ? payload.userId : null;
  if (typeof userId !== "number") {
    return null;
  }
  return ensureAnalyticsSession(userId);
}

function getOrCreateSessionState(userId: number): UserSessionState {
  const current = sessionStateMap.get(userId);
  if (current) {
    return current;
  }
  const next: UserSessionState = {
    version: 1,
    awaitingSuggestion: false,
    updatedAt: Date.now()
  };
  sessionStateMap.set(userId, next);
  return next;
}

function touchSessionState(userId: number): void {
  const current = getOrCreateSessionState(userId);
  current.updatedAt = Date.now();
  sessionStateMap.set(userId, current);
}

function setAwaitingSuggestion(userId: number): number {
  const current = getOrCreateSessionState(userId);
  current.awaitingSuggestion = true;
  current.updatedAt = Date.now();
  sessionStateMap.set(userId, current);
  return current.version;
}

function clearAwaitingSuggestion(userId: number, bumpVersion = false): void {
  const current = getOrCreateSessionState(userId);
  current.awaitingSuggestion = false;
  if (bumpVersion) {
    current.version += 1;
  }
  current.updatedAt = Date.now();
  sessionStateMap.set(userId, current);
}

function resetConversationState(userId: number, reason: string): void {
  const previousSession = sessionStateMap.get(userId);
  draftMap.delete(userId);
  stepMap.delete(userId);
  reminderPromptMap.delete(userId);
  profileWizardMap.delete(userId);
  if (reason !== "profile_temporary_keep") {
    temporaryProfileMap.delete(userId);
  }
  sessionStateMap.set(userId, {
    version: (previousSession?.version ?? 0) + 1,
    awaitingSuggestion: false,
    updatedAt: Date.now()
  });
  logEvent("state_reset", { userId, reason, currentStep: "idle" });
}

async function guardCallbackFlowStep(
  ctx: any,
  userId: number,
  actionName: string,
  allowedSteps: string[]
): Promise<boolean> {
  const locale = getUserLocale(ctx);
  if (resetIfStateTimedOut(userId)) {
    await ctx.answerCbQuery(t(locale, "wizard.error.sessionExpired"));
    return false;
  }

  const currentStep = stepMap.get(userId) || "idle";
  if (!allowedSteps.includes(currentStep)) {
    logEvent("stale_callback_ignored", {
      userId,
      chatId: ctx.chat?.id ?? null,
      actionName,
      currentStep,
      allowedSteps
    });
    await ctx.answerCbQuery(t(locale, "wizard.error.buttonExpired"));
    return false;
  }

  touchSessionState(userId);
  return true;
}

function resetIfStateTimedOut(userId: number): boolean {
  const current = sessionStateMap.get(userId);
  if (!current) {
    return false;
  }

  const idleForMs = Date.now() - current.updatedAt;
  if (idleForMs < STATE_TIMEOUT_MS) {
    return false;
  }

  if (!current.awaitingSuggestion && !stepMap.has(userId) && !draftMap.has(userId)) {
    touchSessionState(userId);
    return false;
  }

  resetConversationState(userId, "state_timeout");
  logEvent("flow_restarted", { userId, reason: "state_timeout", idleForMs });
  return true;
}

function statusEmoji(status: string) {
  if (status === "attention") return "🔴";
  if (status === "caution") return "🟡";
  return "🟢";
}

const MEDICATION_NORMALIZATION: Record<string, string> = {
  нурофен: "ибупрофен",
  панадол: "парацетамол",
  ибуклин: "ибупрофен+парацетамол"
};

const MANUAL_SYNONYM_PATCH: Record<string, string[]> = {
  Ибупрофен: ["ибуклин"],
  Парацетамол: ["панадол беби"]
};

const SYMPTOM_CANONICAL_MAP: Array<{ canonical: string; variants: string[] }> = [
  {
    canonical: "горло",
    variants: ["болит горло", "боль в горле", "горло", "першение", "першение в горле", "раздражение горла"]
  },
  {
    canonical: "температура",
    variants: ["жар", "температура", "лихорадка", "высокая температура", "озноб"]
  },
  {
    canonical: "кашель",
    variants: ["сухой кашель", "влажный кашель", "от кашля", "кашель", "мокрота"]
  },
  {
    canonical: "насморк",
    variants: ["насморк", "заложенность носа", "сопли", "ринит"]
  },
  {
    canonical: "аллергия",
    variants: ["аллергия", "аллергический", "зуд", "сыпь", "крапивница"]
  },
  {
    canonical: "боль",
    variants: ["головная боль", "боль", "болит", "спазм", "ломота"]
  },
  {
    canonical: "живот",
    variants: ["боль в животе", "живот", "диарея", "понос", "тошнота", "рвота", "изжога"]
  }
];

const THERAPEUTIC_CLASS_SYMPTOMS: Record<string, { symptoms: string[]; tags: string[] }> = {
  ANTIPYRETIC: {
    symptoms: ["повышенная температура", "лихорадка", "головная боль"],
    tags: ["температура", "жар", "боль"]
  },
  NSAID: {
    symptoms: ["боль", "воспаление", "лихорадка"],
    tags: ["боль", "температура"]
  },
  ANTITUSSIVE: {
    symptoms: ["кашель", "сухой кашель"],
    tags: ["кашель"]
  },
  MUCOLYTIC: {
    symptoms: ["кашель с мокротой", "затрудненное отхождение мокроты"],
    tags: ["кашель", "мокрота"]
  },
  EXPECTORANT: {
    symptoms: ["кашель", "вязкая мокрота"],
    tags: ["кашель", "мокрота"]
  },
  ANTIHISTAMINE: {
    symptoms: ["аллергический насморк", "кожный зуд", "чихание"],
    tags: ["аллергия", "насморк"]
  },
  DECONGESTANT: {
    symptoms: ["заложенность носа", "насморк"],
    tags: ["насморк"]
  },
  ANTISEPTIC_THROAT: {
    symptoms: ["боль в горле", "першение в горле", "раздражение горла"],
    tags: ["горло", "першение"]
  },
  ORAL_REHYDRATION: {
    symptoms: ["обезвоживание при диарее", "рвота"],
    tags: ["живот", "диарея"]
  }
};

function splitDisplayName(value: string): string[] {
  return value
    .split("/")
    .map((x) => x.trim())
    .filter(Boolean);
}

function safeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isBrokenText(value: string): boolean {
  if (!value) {
    return false;
  }
  if (/[�]/.test(value)) {
    return true;
  }
  const cyr = (value.match(/[а-яё]/gi) || []).length;
  const moj = (value.match(/[РСЃЂЌЎў]/g) || []).length + (value.match(/[ÐÑ]/g) || []).length;
  return moj >= 3 && cyr === 0;
}

function cleanAndDecode(value: unknown): string {
  const source = safeString(value);
  return isBrokenText(source) ? "" : source;
}

function normalizeSymptomText(input: string): string {
  const normalized = normalizeMedicationQuery(input || "");
  if (!normalized) {
    return "";
  }

  for (const rule of SYMPTOM_CANONICAL_MAP) {
    for (const variant of rule.variants) {
      const normalizedVariant = normalizeMedicationQuery(variant);
      if (normalized.includes(normalizedVariant) || normalizedVariant.includes(normalized)) {
        return rule.canonical;
      }
    }
  }

  return normalized;
}

function inferSymptomsFromClass(record: PrimaryDrugDbRecord): { symptoms: string[]; symptomTags: string[] } {
  const classCode = record.classification?.therapeuticClass?.[0] || "";
  const mapped = THERAPEUTIC_CLASS_SYMPTOMS[classCode];
  if (!mapped) {
    return { symptoms: [], symptomTags: [] };
  }

  return {
    symptoms: mapped.symptoms.slice(),
    symptomTags: mapped.tags.slice()
  };
}

function buildFallbackCatalog(): CatalogDrug[] {
  return MEDICATIONS.map((m) => {
    const variants = splitDisplayName(m.name);
    const canonicalName = variants[0] || m.name;
    const patchedSynonyms = MANUAL_SYNONYM_PATCH[canonicalName] ?? [];
    const synonyms = Array.from(
      new Set(
        [...m.synonyms, ...variants, canonicalName, ...patchedSynonyms]
          .map((s) => s.toLowerCase().trim())
          .filter(Boolean)
      )
    );

    return {
      id: m.id,
      name: canonicalName,
      synonyms,
      category: m.category,
      symptoms: [],
      symptomTags: [],
      shortInfo: m.role,
      isSponsored: false
    };
  });
}

function buildPrimaryCatalog(): CatalogDrug[] {
  const records = Array.isArray(PRIMARY_DRUG_DATABASE) ? (PRIMARY_DRUG_DATABASE as PrimaryDrugDbRecord[]) : [];
  return records
    .filter((r) => r && r.isActive !== false)
    .map((r) => {
      const isV2 = r.schemaVersion === 2;
      const rawNameCandidates: Array<{ field: string; value: string }> = isV2
        ? [
            { field: "name", value: safeString(r.name) },
            { field: "identity.displayName.ru", value: safeString(r.identity?.displayName?.ru) },
            { field: "identity.activeSubstance.ru", value: safeString(r.identity?.activeSubstance?.ru) },
            { field: "identity.displayName.en", value: safeString(r.identity?.displayName?.en) },
            { field: "identity.activeSubstance.en", value: safeString(r.identity?.activeSubstance?.en) }
          ]
        : [
            { field: "name", value: safeString(r.name) },
            { field: "activeSubstance", value: safeString(r.activeSubstance) },
            { field: "displayName", value: safeString(r.displayName) }
          ];
      const selectedNameSource = rawNameCandidates.find((x) => x.value && !isBrokenText(x.value)) || rawNameCandidates[0];
      const canonicalName = cleanAndDecode(selectedNameSource?.value || "");
      const v2SearchTokens = isV2
        ? [
            ...(r.search?.searchTokens || []),
            ...(r.search?.primaryTerms || []),
            ...(r.search?.brandNames || []),
            ...(r.search?.aliases || []),
            ...(r.search?.autocompleteBoost || [])
          ]
        : [];
      const inferred = inferSymptomsFromClass(r);
      const aliases = [r.displayName || "", ...(r.synonyms || []), ...(r.aliases || []), ...v2SearchTokens]
        .map((s) => cleanAndDecode(String(s)))
        .filter(Boolean);
      const synonyms = Array.from(
        new Set(
          [canonicalName, ...aliases]
            .map((s) => normalizeMedicationQuery(String(s)))
            .filter(Boolean)
        )
      );
      const symptomPhrases = Array.from(
        new Set(
          [...(r.symptoms || []), ...(r.indications || []), ...inferred.symptoms]
            .map((s) => cleanAndDecode(String(s)))
            .filter(Boolean)
        )
      );
      const symptomTags = Array.from(
        new Set(
          [...(r.symptomTags || []), ...inferred.symptomTags]
            .map((s) => cleanAndDecode(String(s)))
            .map((s) => normalizeSymptomText(s))
            .filter(Boolean)
        )
      );

      const cleanIndications = [...(r.indications || [])]
        .map((s) => cleanAndDecode(String(s)))
        .filter(Boolean);
      return {
        id: r.id || (isV2 ? r.identity?.normalizedKey : canonicalName.toLowerCase()) || canonicalName.toLowerCase(),
        name: canonicalName,
        synonyms,
        category: cleanAndDecode(isV2 ? r.category || r.classification?.therapeuticClass?.[0] || "Прочее" : r.category || "Прочее"),
        symptoms: symptomPhrases,
        symptomTags,
        shortInfo: cleanIndications[0] || inferred.symptoms[0] || "",
        isSponsored: Boolean(r.isSponsored),
        sourceNameRaw: selectedNameSource?.value || "",
        sourceNameField: selectedNameSource?.field || "unknown"
      };
    })
    .filter((r) => Boolean(r.name));
}

function collectPrimaryLookupTerms(record: PrimaryDrugDbRecord): string[] {
  const valueToStringArray = (value: unknown): string[] =>
    Array.isArray(value) ? value.map((item) => cleanAndDecode(String(item || ""))).filter(Boolean) : [];

  const terms = [
    safeString(record.id),
    safeString(record.name),
    safeString(record.displayName),
    safeString(record.activeSubstance),
    safeString(record.identity?.normalizedKey),
    safeString(record.identity?.activeSubstance?.ru),
    safeString(record.identity?.activeSubstance?.en),
    safeString(record.identity?.activeSubstance?.latinSlug),
    safeString(record.identity?.displayName?.ru),
    safeString(record.identity?.displayName?.en),
    ...valueToStringArray(record.aliases),
    ...valueToStringArray(record.synonyms),
    ...valueToStringArray(record.search?.primaryTerms),
    ...valueToStringArray(record.search?.brandNames),
    ...valueToStringArray(record.search?.aliases),
    ...valueToStringArray(record.search?.misspellings),
    ...valueToStringArray(record.search?.transliterations),
    ...valueToStringArray(record.search?.autocompleteBoost),
    ...valueToStringArray(record.search?.searchTokens)
  ]
    .map((term) => normalizeMedicationQuery(term))
    .filter(Boolean);

  return Array.from(new Set(terms));
}

function buildPrimaryDrugIndex() {
  const records = Array.isArray(PRIMARY_DRUG_DATABASE) ? (PRIMARY_DRUG_DATABASE as PrimaryDrugDbRecord[]) : [];
  const byTerm = new Map<string, PrimaryDrugDbRecord>();
  const byId = new Map<string, PrimaryDrugDbRecord>();

  for (const record of records) {
    if (!record || record.isActive === false) {
      continue;
    }
    const idKey = normalizeMedicationQuery(record.id || "");
    if (idKey) {
      byId.set(idKey, record);
    }
    for (const term of collectPrimaryLookupTerms(record)) {
      if (!byTerm.has(term)) {
        byTerm.set(term, record);
      }
    }
  }

  return { byTerm, byId };
}

function mergeCatalogs(primary: CatalogDrug[], fallback: CatalogDrug[]): CatalogDrug[] {
  const map = new Map<string, CatalogDrug>();

  for (const item of fallback) {
    map.set(item.name.toLowerCase(), item);
  }

  for (const item of primary) {
    const key = item.name.toLowerCase();
    const existing = map.get(key);
    if (!existing) {
      map.set(key, item);
      continue;
    }

    map.set(key, {
      ...existing,
      ...item,
      synonyms: Array.from(new Set([...existing.synonyms, ...item.synonyms])),
      symptoms: Array.from(new Set([...(existing.symptoms || []), ...(item.symptoms || [])])),
      symptomTags: Array.from(new Set([...(existing.symptomTags || []), ...(item.symptomTags || [])]))
    });
  }

  return Array.from(map.values());
}

const DRUGS: CatalogDrug[] = mergeCatalogs(buildPrimaryCatalog(), buildFallbackCatalog());
const PRIMARY_DRUG_INDEX = buildPrimaryDrugIndex();
console.info("catalog_loaded_count:", DRUGS.length);
const goldenMapIssues = validateGoldenSymptomMapRuntime(DRUGS.map((drug) => drug.id));
if (goldenMapIssues.length > 0) {
  console.warn("golden_symptom_map_issues:", goldenMapIssues);
  logEvent("golden_symptom_map_validation_failed", {
    issuesCount: goldenMapIssues.length,
    issuesPreview: goldenMapIssues.slice(0, 10)
  });
} else {
  logEvent("golden_symptom_map_validation_ok", { issuesCount: 0 });
}
const goldenSafetyIssues = validateGoldenDrugSafetyTop20Runtime(DRUGS.map((drug) => drug.id));
if (goldenSafetyIssues.length > 0) {
  console.warn("golden_drug_safety_top20_issues:", goldenSafetyIssues);
  logEvent("golden_drug_safety_top20_validation_failed", {
    issuesCount: goldenSafetyIssues.length,
    issuesPreview: goldenSafetyIssues.slice(0, 10)
  });
} else {
  logEvent("golden_drug_safety_top20_validation_ok", { issuesCount: 0 });
}
const emergencyRulesIssues = validateEmergencyRuleset();
if (emergencyRulesIssues.length > 0) {
  console.warn("emergency_red_flags_validation_issues:", emergencyRulesIssues);
  logEvent("emergency_red_flags_validation_failed", {
    issuesCount: emergencyRulesIssues.length,
    issuesPreview: emergencyRulesIssues.slice(0, 10)
  });
} else {
  logEvent("emergency_red_flags_validation_ok", { issuesCount: 0 });
}

const MEDS = DRUGS.map((drug) => drug.name);

const AGE_PRESETS: Array<{ label: string; callback: string; value: string }> = [
  { label: "0–5", callback: "age_0_5", value: "0-5" },
  { label: "5–10", callback: "age_5_10", value: "5-10" },
  { label: "10–15", callback: "age_10_15", value: "10-15" },
  { label: "15–60", callback: "age_15_60", value: "15-60" },
  { label: "60+", callback: "age_60_plus", value: "60+" }
];

const SYMPTOM_CATEGORIES: Array<{ id: string; label: string }> = [
  { id: "fever", label: "🤒 Температура" },
  { id: "cough", label: "😷 Кашель" },
  { id: "throat", label: "🗣 Горло" },
  { id: "runny", label: "🤧 Насморк" },
  { id: "pain", label: "🤕 Боль" },
  { id: "allergy", label: "🌼 Аллергия" },
  { id: "other", label: "➕ Другое" }
];

const SYMPTOM_DETAILS: Record<string, string[]> = {
  fever: ["Высокая температура", "Жар", "Лихорадка", "Температура у ребёнка"],
  cough: ["Сухой кашель", "Влажный кашель", "Ночной кашель", "Длительный кашель"],
  throat: ["Боль в горле", "Першение", "Раздражение горла", "Больно глотать"],
  runny: ["Заложенность носа", "Насморк", "Сильные выделения", "Частое чихание"],
  pain: ["Головная боль", "Мышечная боль", "Боль в животе", "Спазм"],
  allergy: ["Аллергический насморк", "Кожный зуд", "Сыпь", "Слезотечение"],
  other: []
};

const SYMPTOM_DETAIL_KEYS: Record<string, LocaleMessageKey[]> = {
  fever: [
    "wizard.detail.fever.high",
    "wizard.detail.fever.heat",
    "wizard.detail.fever.fever",
    "wizard.detail.fever.child"
  ],
  cough: [
    "wizard.detail.cough.dry",
    "wizard.detail.cough.wet",
    "wizard.detail.cough.night",
    "wizard.detail.cough.long"
  ],
  throat: [
    "wizard.detail.throat.pain",
    "wizard.detail.throat.irritation",
    "wizard.detail.throat.discomfort",
    "wizard.detail.throat.swallow"
  ],
  runny: [
    "wizard.detail.runny.blocked",
    "wizard.detail.runny.runny",
    "wizard.detail.runny.discharge",
    "wizard.detail.runny.sneeze"
  ],
  pain: [
    "wizard.detail.pain.head",
    "wizard.detail.pain.muscle",
    "wizard.detail.pain.abdomen",
    "wizard.detail.pain.spasm"
  ],
  allergy: [
    "wizard.detail.allergy.runny",
    "wizard.detail.allergy.itch",
    "wizard.detail.allergy.rash",
    "wizard.detail.allergy.tears"
  ],
  other: []
};

function getSymptomDetailLabel(locale: SupportedLocale, categoryId: string, index: number, fallback: string): string {
  const key = SYMPTOM_DETAIL_KEYS[categoryId]?.[index];
  return key ? t(locale, key) : fallback;
}

function buildAgeKeyboard(locale: SupportedLocale) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("0–5", "age_0_5"),
      Markup.button.callback("5–10", "age_5_10"),
      Markup.button.callback("10–15", "age_10_15")
    ],
    [Markup.button.callback("15–60", "age_15_60"), Markup.button.callback("60+", "age_60_plus")],
    [Markup.button.callback(t(locale, "wizard.age.exact"), "age_exact")]
  ]);
}

function buildSymptomCategoryKeyboard(locale: SupportedLocale) {
  return Markup.inlineKeyboard([
    [Markup.button.callback(t(locale, "wizard.symptom.fever"), "symcat_fever"), Markup.button.callback(t(locale, "wizard.symptom.cough"), "symcat_cough")],
    [Markup.button.callback(t(locale, "wizard.symptom.throat"), "symcat_throat"), Markup.button.callback(t(locale, "wizard.symptom.runny"), "symcat_runny")],
    [Markup.button.callback(t(locale, "wizard.symptom.pain"), "symcat_pain"), Markup.button.callback(t(locale, "wizard.symptom.allergy"), "symcat_allergy")],
    [Markup.button.callback(t(locale, "wizard.symptom.other"), "symcat_other")]
  ]);
}

function getAvailableSymptomDetails(
  categoryId: string,
  context: ReturnType<typeof resolvePatientContext>
): Array<{ index: number; label: string }> {
  const details = SYMPTOM_DETAILS[categoryId] || [];
  const available: Array<{ index: number; label: string }> = [];
  for (let i = 0; i < details.length; i += 1) {
    const detail = details[i];
    const routed = getGoldenSymptomMatches(detail, context, 1);
    if (routed.status === "ok" && routed.drugs.length > 0) {
      available.push({ index: i, label: detail });
    }
  }
  return available;
}

function buildSymptomDetailKeyboard(
  locale: SupportedLocale,
  categoryId: string,
  context?: ReturnType<typeof resolvePatientContext>,
  availableDetails?: Array<{ index: number; label: string }>
) {
  const defaultContext = context || resolvePatientContext({ activeProfile: null, temporaryProfile: null });
  const details = availableDetails || getAvailableSymptomDetails(categoryId, defaultContext);
  const rows = details.map((detail) => [
    Markup.button.callback(getSymptomDetailLabel(locale, categoryId, detail.index, detail.label), `symdet_${categoryId}_${detail.index}`)
  ]);
  return Markup.inlineKeyboard([
    ...rows,
    [Markup.button.callback(t(locale, "wizard.symptom.manual"), `symdet_manual_${categoryId}`)],
    [Markup.button.callback(t(locale, "wizard.nav.back"), "symcat_back")]
  ]);
}

function getSymptomCategoryLabel(categoryId: string, locale: SupportedLocale): string {
  const byId: Record<string, LocaleMessageKey> = {
    fever: "wizard.symptom.fever",
    cough: "wizard.symptom.cough",
    throat: "wizard.symptom.throat",
    runny: "wizard.symptom.runny",
    pain: "wizard.symptom.pain",
    allergy: "wizard.symptom.allergy",
    other: "wizard.symptom.other"
  };
  return t(locale, byId[categoryId] || "wizard.symptom.other");
}

function formatDrugLabel(drug: CatalogDrug, locale: SupportedLocale = "ru"): string {
  return `${drug.isSponsored ? t(locale, "wizard.drug.partnerPrefix") : ""}${drug.name}`;
}

type SupportedLocale = "ru" | "uz";

type LocaleMessageKey = string;

const messages: Record<SupportedLocale, Record<string, string>> = {
  ru: {
    "menu.check": "Проверить лекарства",
    "menu.reminders": "⏰ Мои напоминания",
    "menu.history": "Мои проверки",
    "menu.safetyProfiles": "Профили безопасности",
    "menu.howTo": "Как пользоваться",
    "menu.language": "🌐 Язык",
    "reminder.menu.title": "⏰ Мои напоминания",
    "reminder.menu.description":
      "Здесь вы можете добавить напоминание о приёме препарата, посмотреть активные курсы и отметить факт приёма.",
    "reminder.menu.disclaimer": "ℹ️ Сервис носит информационный характер и не заменяет консультацию врача.",
    "reminder.menu.add": "➕ Добавить напоминание",
    "reminder.menu.active": "📋 Активные курсы",
    "reminder.menu.today": "📅 На сегодня",
    "reminder.menu.history": "📊 Моя история приёма",
    "reminder.menu.profile": "👪 Профиль для напоминаний",
    "reminder.menu.settings": "⚙️ Настройки уведомлений",
    "reminder.menu.back": "◀️ Назад",
    "reminder.settings.notifOn": "🔔 Вкл уведомления",
    "reminder.settings.notifOff": "🔕 Выкл уведомления",
    "reminder.settings.qhOn": "🌙 Тихие часы вкл",
    "reminder.settings.qhOff": "🌞 Тихие часы выкл",
    "reminder.settings.qhTime": "🕒 Время тихих часов",
    "rem.freq.d1": "1 раз в день",
    "rem.freq.d2": "2 раза в день",
    "rem.freq.d3": "3 раза в день",
    "rem.freq.h8": "Каждые 8 часов",
    "rem.freq.h12": "Каждые 12 часов",
    "rem.freq.custom": "Свой вариант",
    "rem.dur.d1": "1 день",
    "rem.dur.d3": "3 дня",
    "rem.dur.d5": "5 дней",
    "rem.dur.d7": "7 дней",
    "rem.dur.d10": "10 дней",
    "rem.dur.open": "Без даты окончания",
    "rem.dur.custom": "Свой вариант",
    "rem.nav.back": "◀️ Назад",
    "rem.save.save": "✅ Сохранить",
    "rem.save.edit": "✏️ Изменить",
    "rem.value.notSpecified": "не указана",
    "rem.value.notSelected": "не выбран",
    "rem.value.none": "нет",
    "rem.value.openEnded": "Без даты окончания",
    "rem.value.days": "{days} дней",
    "rem.value.dosageMissing": "дозировка не указана",
    "rem.value.status.active": "активен",
    "rem.value.day.withTotal": "День {current} из {total}",
    "rem.value.day.single": "День {current}",
    "rem.value.status.scheduled": "запланировано",
    "rem.value.status.sent": "отправлено",
    "rem.value.status.taken": "принято",
    "rem.value.status.skipped": "пропущено",
    "rem.value.status.snoozed": "отложено",
    "rem.value.status.missed": "пропущено",
    "rem.value.status.mark_now": "отмечено вручную",
    "rem.confirm.title": "✅ Проверьте данные напоминания",
    "rem.confirm.drug": "Препарат: {value}",
    "rem.confirm.dosage": "Дозировка: {value}",
    "rem.confirm.time": "Время: {value}",
    "rem.confirm.frequency": "Частота: {value}",
    "rem.confirm.duration": "Длительность: {value}",
    "rem.confirm.profile": "Профиль: {value}",
    "rem.confirm.note": "Заметка: {value}",
    "rem.confirm.info": "ℹ️ Бот будет напоминать по указанным вами данным.",
    "rem.menu.chooseAction": "Выберите действие в разделе напоминаний.",
    "rem.legal.text":
      "ℹ️ Напоминания помогают не забыть о приёме, который вы указали сами.\n\nБот:\n• не назначает лечение\n• не проверяет корректность дозировки\n• не заменяет консультацию врача\n\nПродолжая, вы подтверждаете, что вводите данные самостоятельно или по назначению специалиста.",
    "rem.legal.ok": "✅ Понятно",
    "rem.start.enterDrug": "💊 Введите название препарата.\n\nМожно написать, например:\nПарацетамол\nИбупрофен\nАмброксол",
    "rem.courses.empty": "📋 Активных курсов пока нет.",
    "rem.courses.title": "📋 Активные напоминания",
    "rem.courses.subtitle": "Выберите курс, чтобы посмотреть расписание или изменить его.",
    "rem.course.open": "Открыть",
    "rem.course.pause": "Пауза",
    "rem.course.finish": "Завершить",
    "rem.course.notFound": "Курс не найден.",
    "rem.course.schedule.everyHours": "каждые {hours} часов",
    "rem.course.duration.label.open": "Без даты окончания",
    "rem.course.duration.label.days": "{days} дней",
    "rem.course.progress.withTotal": "{current} из {total} дней",
    "rem.course.progress.dayOnly": "{current} день",
    "rem.course.latest.none": "Нет отметок по приёмам.",
    "rem.course.latest.title": "Последние отметки:",
    "rem.course.label.dosage": "Дозировка: {value}",
    "rem.course.label.schedule": "График: {value}",
    "rem.course.label.duration": "Длительность: {value}",
    "rem.course.label.progress": "Пройдено: {value}",
    "rem.course.label.profile": "Профиль: {value}",
    "rem.course.label.status": "Статус: {value}",
    "rem.course.info": "ℹ️ Это напоминание создано по введённым вами данным.",
    "rem.course.btn.marknow": "✅ Отметить приём сейчас",
    "rem.course.btn.edit": "✏️ Изменить",
    "rem.course.btn.pause": "⏸ Пауза",
    "rem.course.btn.delete": "🗑 Удалить",
    "rem.course.btn.check": "🔍 Проверить сочетание",
    "rem.course.btn.back": "◀️ Назад",
    "rem.cb.add": "Добавить",
    "rem.cb.profile": "Профиль",
    "rem.cb.back": "Назад",
    "rem.cb.quick": "Быстрый режим",
    "rem.cb.advanced": "Расширенный режим",
    "rem.cb.needDrug": "Сначала укажите препарат",
    "rem.cb.draftNotFound": "Черновик не найден",
    "rem.cb.skipped": "Пропущено",
    "rem.cb.custom": "Свой вариант",
    "rem.cb.frequencySelected": "Частота выбрана",
    "rem.cb.durationSelected": "Длительность выбрана",
    "rem.cb.edit": "Изменить",
    "rem.cb.editing": "Редактирование",
    "rem.cb.missingData": "Не хватает данных",
    "rem.cb.profileCheck": "Проверка профиля",
    "rem.cb.interactionCheck": "Проверка сочетаний",
    "rem.cb.duplicate": "Есть дубликат",
    "rem.cb.limit": "Лимит достигнут",
    "rem.cb.error": "Ошибка",
    "rem.cb.saved": "Сохранено",
    "rem.cb.continue": "Продолжаем",
    "rem.cb.draftStale": "Черновик устарел",
    "rem.cb.failed": "Не удалось",
    "rem.cb.created": "Создано",
    "rem.cb.cancelled": "Отменено",
    "rem.cb.list": "Список",
    "rem.cb.today": "Сегодня",
    "rem.cb.stats": "Статистика",
    "rem.cb.settings": "Настройки",
    "rem.cb.notifOn": "Уведомления включены",
    "rem.cb.notifOff": "Уведомления выключены",
    "rem.cb.qhOn": "Тихие часы включены",
    "rem.cb.qhOff": "Тихие часы выключены",
    "rem.cb.enterRange": "Введите диапазон",
    "rem.cb.openCourse": "Открываю курс",
    "rem.cb.pause": "Пауза",
    "rem.cb.completed": "Завершено",
    "rem.cb.deleted": "Удалено",
    "rem.cb.marked": "Отмечено",
    "rem.cb.takeMarked": "Отмечено как принято",
    "rem.cb.skipMarked": "Пропуск отмечен",
    "rem.cb.snooze": "Отложить",
    "rem.cb.snoozed": "Отложено",
    "rem.cb.notFound": "Не найдено",
    "rem.reply.profileNone": "Сохранённых профилей пока нет. Используется стандартный профиль пользователя.",
    "rem.reply.profileChoose": "Выберите профиль для напоминаний:",
    "rem.reply.profileReset": "Сбросить профиль",
    "rem.reply.profileNotFound": "Профиль не найден",
    "rem.reply.profileSelected": "👪 Профиль напоминания: {label}",
    "rem.reply.profileCleared": "Профиль для напоминаний сброшен.",
    "rem.reply.enterDrug": "💊 Введите название препарата.",
    "rem.reply.enterDrugAgain": "💊 Введите название препарата заново.",
    "rem.reply.drugNameTooShort": "Введите название препарата (минимум 2 символа).",
    "rem.reply.modePrompt": "Вы выбрали препарат:\n💊 {drug}\n\nТеперь укажите форму напоминания.",
    "rem.mode.quickBtn": "⚡ Быстрое напоминание",
    "rem.mode.advancedBtn": "⚙️ Расширенный режим",
    "rem.mode.profileBtn": "👪 Профиль для напоминания",
    "rem.reply.enterTime": "⏰ Укажите время первого напоминания.\n\nПример:\n08:00\n21:30",
    "rem.reply.enterTimeFormatError": "Не удалось распознать время.\n\nВведите в формате:\n08:00\n21:30",
    "rem.reply.frequencyPick": "🔁 Выберите частоту напоминаний.",
    "rem.reply.durationPick": "📅 Укажите длительность напоминаний.",
    "rem.reply.customFreqPrompt": "Введите число напоминаний в сутки (от 1 до 6).",
    "rem.reply.customFreqInvalid": "Введите целое число от 1 до 6.",
    "rem.reply.customDurPrompt": "Введите длительность в днях, например: 5",
    "rem.reply.customDurInvalid": "Не удалось распознать длительность.\n\nУкажите число дней, например:\n5\n7\n10",
    "rem.reply.notePrompt": "📝 Добавьте заметку (например: после еды).\nИли нажмите «Пропустить».",
    "rem.reply.noteSkip": "Пропустить",
    "rem.reply.qhFormat": "Введите тихие часы в формате `23:00-07:00`.",
    "rem.reply.qhFormatError": "Не удалось распознать диапазон.\nВведите в формате: 23:00-07:00",
    "rem.reply.qhUpdated": "🌙 Тихие часы обновлены: {start}–{end}",
    "rem.reply.openedReminderSection": "Открыт раздел напоминаний.",
    "rem.reply.saved": "✅ Напоминание сохранено.",
    "rem.reply.created": "✅ Напоминание создано.",
    "rem.reply.savedRisk": "✅ Напоминание сохранено с предупреждением о потенциальном риске.",
    "rem.reply.notCreated": "Ок, напоминание не создано.",
    "rem.reply.confirmSave": "Подтвердите сохранение напоминания.",
    "rem.reply.draftMissing": "Черновик напоминания не найден. Начните заново.",
    "rem.reply.draftMissingShort": "Черновик напоминания не найден.",
    "rem.reply.saveFailed": "Не удалось сохранить напоминание. Проверьте параметры и попробуйте снова.",
    "rem.reply.saveFailedShort": "Не удалось сохранить напоминание. Проверьте параметры.",
    "rem.reply.addedToCheck": "Добавил в проверку: {name}\nПродолжим через мастер проверки сочетаний.",
    "rem.reply.childWarn":
      "👶 Для детей дозировка и режим приёма могут зависеть от возраста, массы тела и назначения врача.\n\nПроверьте корректность введённых данных.",
    "rem.reply.childContinue": "✅ Продолжить",
    "rem.reply.interactionWarn":
      "⚠️ Обнаружена информация о возможном риске сочетания с другими указанными препаратами.\n\n{summary}\n\nЭто справочное предупреждение. Для решения по приёму рекомендуется консультация специалиста.",
    "rem.reply.interactionCheckBtn": "🔍 Проверить сочетание",
    "rem.reply.interactionSaveAnyway": "Всё равно сохранить",
    "rem.reply.cancel": "Отмена",
    "rem.reply.duplicateWarn":
      "ℹ️ У вас уже есть активное напоминание для этого препарата.\n\nПроверьте, не создаёт ли новое напоминание путаницу в графике.",
    "rem.reply.duplicateCreateAnyway": "Всё равно создать",
    "rem.reply.duplicateOpenCurrent": "Открыть текущий курс",
    "rem.reply.limitReached":
      "У вас уже достигнут лимит активных напоминаний.\n\nЗавершите или удалите один из текущих курсов, чтобы добавить новый.",
    "rem.reply.todayEmpty": "📅 На сегодня напоминаний нет.",
    "rem.reply.todayTitle": "📅 На сегодня:\n{lines}",
    "rem.reply.statsTitle": "📊 Моя история приёма",
    "rem.reply.statsNoEvents": "Нет событий.",
    "rem.reply.statsTotalCourses": "Курсов всего: {value}",
    "rem.reply.statsActiveCourses": "Активных курсов: {value}",
    "rem.reply.statsTaken": "Отмечено «принято»: {value}",
    "rem.reply.statsSkipped": "Отмечено «пропустить»: {value}",
    "rem.reply.statsSnoozed": "Отложено: {value}",
    "rem.reply.statsRecent": "Последние события:",
    "rem.reply.settingsTitle": "⚙️ Настройки уведомлений",
    "rem.reply.settingsNotifications": "Уведомления: {value}",
    "rem.reply.settingsQuietHours": "Тихие часы: {value}",
    "rem.reply.notifOn": "🔔 Уведомления включены.",
    "rem.reply.notifOff": "🔕 Уведомления выключены.",
    "rem.reply.qhOn": "🌙 Тихие часы включены: {start}–{end}",
    "rem.reply.qhOff": "🌞 Тихие часы выключены.",
    "rem.reply.pauseDone": "⏸ Курс поставлен на паузу.",
    "rem.reply.finishDone": "✅ Курс завершён.",
    "rem.reply.deleteDone": "🗑 Напоминание удалено.",
    "rem.reply.markDone": "✅ Приём отмечен.",
    "rem.reply.takeDone": "✅ Приём отмечен.",
    "rem.reply.takeOpenCourse": "📋 Открыть курс",
    "rem.reply.toMenu": "◀️ В меню",
    "rem.reply.skipDone":
      "❌ Пропуск отмечен.\n\nЕсли у вас есть сомнения по дальнейшему приёму, проверьте инструкцию к препарату или уточните у врача.",
    "rem.reply.snoozeAsk": "⏳ На сколько отложить напоминание?",
    "rem.reply.snooze15": "15 минут",
    "rem.reply.snooze30": "30 минут",
    "rem.reply.snooze60": "1 час",
    "rem.reply.snooze120": "2 часа",
    "rem.reply.snoozeDone": "⏳ Напоминание отложено.",
    "rem.notifications.modern.title": "💊 Напоминание о приёме",
    "rem.notifications.modern.drug": "Препарат: {value}",
    "rem.notifications.modern.dosage": "Дозировка: {value}",
    "rem.notifications.modern.time": "⏰ Время: {value}",
    "rem.notifications.modern.day": "📅 День {value}",
    "rem.notifications.modern.info": "ℹ️ Напоминание основано на данных, которые вы указали сами.",
    "rem.notifications.modern.btn.take": "✅ Отметить как принято",
    "rem.notifications.modern.btn.snooze": "⏳ Отложить",
    "rem.notifications.modern.btn.skip": "❌ Пропустить",
    "rem.notifications.modern.btn.open": "📋 Открыть курс",
    "rem.notifications.legacy.text": "⏰ Время принять лекарство.\n\nНажмите, чтобы начать новую проверку.",
    "rem.notifications.legacy.btn.check": "Проверить ещё",
    "rem.card.notFound": "Карточка не найдена",
    "rem.card.noAccess": "Нет доступа",
    "rem.card.saved": "Карточка сохранена",
    "rem.card.savedReply": "✅ Карточка уже сохранена в истории.\nID: {id}",
    "rem.card.saveError": "Ошибка сохранения",
    "rem.card.pickTime": "Выберите время",
    "rem.card.pickDelay": "⏰ Выберите, через сколько напомнить:",
    "rem.card.in6h": "Через 6 часов",
    "rem.card.in12h": "Через 12 часов",
    "rem.card.in24h": "Через 24 часа",
    "rem.card.paramsExpired": "Параметры напоминания устарели. Откройте снова.",
    "rem.card.noAccessOrNotFound": "Нет доступа или карточка не найдена.",
    "rem.card.addedCb": "Напоминание добавлено",
    "rem.card.addedReply": "⏰ Напоминание добавлено через {hours} ч.",
    "rem.card.remindError": "Ошибка напоминания",
    "rem.card.startNewCheck": "Начинаем новую проверку",
    "start.greeting":
      "Привет. Я помогу понять сочетание лекарств простым языком.\nНажмите «Проверить лекарства», чтобы начать.",
    "main.menu.opened": "Открыто главное меню.",
    "howto.text":
      "Как пользоваться:\n1) Нажмите «Проверить лекарства»\n2) Выберите возраст или используйте профиль\n3) Выберите симптом\n4) Получите подборку с safety-фильтрами",
    "lang.prompt": "Выберите язык интерфейса:",
    "lang.changedRu": "Язык переключён: Русский",
    "lang.changedUz": "Til o‘zgartirildi: O‘zbekcha",
    "lang.option.ru": "Русский",
    "lang.option.uz": "O‘zbekcha",
    "lang.back": "◀️ Назад",
    "buy.opening": "Открываем аптеку",
    "buy.transition": "Переход к покупке: {name}",
    "buy.button": "💊 Купить в аптеке",
    "buy.missingDrug": "Нет препарата для покупки",
    "buy.cardNotFound": "Карточка не найдена",
    "buy.cardDrugMissing": "Не удалось найти препарат из карточки в локальной базе. Введите вручную.",
    "wizard.age.exact": "Ввести точно",
    "wizard.symptom.fever": "🤒 Температура",
    "wizard.symptom.cough": "😷 Кашель",
    "wizard.symptom.throat": "🗣 Горло",
    "wizard.symptom.runny": "🤧 Насморк",
    "wizard.symptom.pain": "🤕 Боль",
    "wizard.symptom.allergy": "🌼 Аллергия",
    "wizard.symptom.other": "➕ Другое",
    "wizard.symptom.manual": "➕ Ввести вручную",
    "wizard.nav.back": "⬅ Назад",
    "wizard.drug.partnerPrefix": "⭐ Партнёр: ",
    "wizard.detail.fever.high": "Высокая температура",
    "wizard.detail.fever.heat": "Жар",
    "wizard.detail.fever.fever": "Лихорадка",
    "wizard.detail.fever.child": "Температура у ребёнка",
    "wizard.detail.cough.dry": "Сухой кашель",
    "wizard.detail.cough.wet": "Влажный кашель",
    "wizard.detail.cough.night": "Ночной кашель",
    "wizard.detail.cough.long": "Длительный кашель",
    "wizard.detail.throat.pain": "Боль в горле",
    "wizard.detail.throat.irritation": "Першение",
    "wizard.detail.throat.discomfort": "Раздражение горла",
    "wizard.detail.throat.swallow": "Больно глотать",
    "wizard.detail.runny.blocked": "Заложенность носа",
    "wizard.detail.runny.runny": "Насморк",
    "wizard.detail.runny.discharge": "Сильные выделения",
    "wizard.detail.runny.sneeze": "Частое чихание",
    "wizard.detail.pain.head": "Головная боль",
    "wizard.detail.pain.muscle": "Мышечная боль",
    "wizard.detail.pain.abdomen": "Боль в животе",
    "wizard.detail.pain.spasm": "Спазм",
    "wizard.detail.allergy.runny": "Аллергический насморк",
    "wizard.detail.allergy.itch": "Кожный зуд",
    "wizard.detail.allergy.rash": "Сыпь",
    "wizard.detail.allergy.tears": "Слезотечение",
    "wizard.prompt.age": "Выберите возраст пациента:",
    "wizard.prompt.category": "Выберите категорию симптома:",
    "wizard.prompt.categoryButtons": "Выберите категорию симптома кнопками ниже.",
    "wizard.prompt.detailButtons": "Выберите уточнение симптома кнопками или нажмите «Ввести вручную».",
    "wizard.prompt.noMatches": "По этой категории пока нет точных совпадений в локальном каталоге. Введите препарат вручную.",
    "wizard.prompt.detailForCategory": "Уточните симптом: {category}",
    "wizard.prompt.describeManual": "Опишите симптом вручную.",
    "wizard.prompt.describeMore": "Опиши симптомы чуть подробнее (минимум 3 символа).",
    "wizard.prompt.enterDrug": "Введите название препарата вручную.",
    "wizard.prompt.enterDrugAgain": "Введите второй препарат вручную.",
    "wizard.prompt.enterDrugExact": "Введите точное название препарата вручную.",
    "wizard.prompt.enterSecondDrug": "Добавлено: {drug}\nТекущий список: {list}\n\nВыберите, как добавить следующий препарат:",
    "wizard.prompt.enterAgeExact": "Введите точный возраст (0–100):",
    "wizard.prompt.ageGuidance": "Выберите возраст кнопкой ниже или введите его текстом (например: 5-10 или 8).",
    "wizard.prompt.listEmpty": "Список пока пуст. Введите хотя бы одно лекарство.",
    "wizard.prompt.listEmptySubmit": "Введи хотя бы одно лекарство через запятую.",
    "wizard.prompt.shortDrugName": "Название лекарства слишком короткое. Введите минимум 3 буквы названия.",
    "wizard.prompt.selectDrug": "Выберите лекарство:",
    "wizard.prompt.nowManualComma": "Теперь можно ввести препарат вручную через запятую.\nНапример: нурофен, парацетамол",
    "wizard.prompt.selectDrugFallback": "Теперь можно ввести препарат вручную через запятую.\nНапример: нурофен, парацетамол",
    "wizard.prompt.localNotFound":
      "Не удалось найти препарат в локальной базе.\nПроверьте написание и введите вручную другое название.",
    "wizard.prompt.addNextDrugMode": "Выберите, как добавить следующий препарат:",
    "wizard.prompt.confirmParsedAs": "Распознано как: {drug}. Верно?",
    "wizard.prompt.unrecognizedDrugSuggestions":
      "Не удалось уверенно распознать препарат.\nВозможно, вы имели в виду:\n{list}\n\nВведите точное название препарата.",
    "wizard.cb.ageUnknown": "Возраст не распознан",
    "wizard.cb.ageValue": "Возраст: {value}",
    "wizard.cb.enterAgeNumber": "Введите возраст числом",
    "wizard.cb.back": "Назад",
    "wizard.cb.manualInput": "Ввод вручную",
    "wizard.cb.symptomUnknown": "Симптом не распознан",
    "wizard.cb.drugNotFound": "Препарат не найден",
    "wizard.cb.addSecondDrug": "Добавьте второй препарат",
    "wizard.cb.checking": "Проверяем",
    "wizard.cb.symptomMode": "Выбор по симптому",
    "wizard.cb.selectBySymptom": "Выбрать по симптому",
    "wizard.prompt.ageInvalid": "Возраст должен быть числом от 0 до 100. Попробуй снова.",
    "wizard.button.yes": "Да",
    "wizard.button.noManual": "Нет, ввести вручную",
    "wizard.button.notThis": "❌ Не то",
    "wizard.button.manualEntry": "✍ Ввести вручную",
    "wizard.button.cancel": "↩ Отмена",
    "wizard.cb.selected": "Выбрано: {value}",
    "wizard.prompt.selectedAdded":
      "✅ Добавлено: {value}\nТекущий список: {list}\n\nМожно дописать ещё через запятую или отправить список для проверки.",
    "wizard.error.sessionExpired": "Сессия истекла. Начните заново.",
    "wizard.error.buttonExpired": "Эта кнопка устарела. Введите название заново.",
    "wizard.error.buttonInactive": "Эта кнопка больше не активна.",
    "wizard.error.confirmExpired": "Подтверждение устарело.",
    "wizard.error.selectFailed": "Ошибка выбора. Начните заново.",
    "wizard.error.genericRestart": "Ошибка. Начните заново.",
    "wizard.emergency.seekDoctor": "Рекомендуется как можно скорее обратиться к врачу.",
    "wizard.emergency.seekUrgent": "Нужна срочная очная медицинская помощь.",
    "wizard.emergency.callEmergency": "Если состояние тяжёлое — вызовите экстренную помощь немедленно.",
    "wizard.emergency.defaultAction": "Рекомендуется очная медицинская помощь.",
    "wizard.emergency.blockedTemplate":
      "⚠️ По указанным симптомам есть признаки потенциально опасного состояния.\n{message}\n\n{action}\nСамолечение по этому сценарию может быть небезопасным.",
    "wizard.prompt.fallback.unsafeSymptomQuality":
      "По этому симптому в golden-карте пока нет безопасной автоматической рекомендации.\nВведите препарат вручную.",
    "wizard.prompt.fallback.ageNotProvided": "Сначала укажите возраст, чтобы безопасно отфильтровать рекомендации по симптому.",
    "wizard.prompt.fallback.noAgeEligible":
      "Для указанного возраста по этому симптому в текущей карте нет безопасных вариантов.\nВведите препарат вручную.",
    "wizard.prompt.fallback.noPrimaryCandidates":
      "По этому симптому в текущей карте нет препаратов, прошедших quality-фильтр.\nВведите препарат вручную.",
    "wizard.prompt.fallback.missingSafetyProfile":
      "По этому симптому нет препаратов с подтверждённым safety-профилем в текущем top-20 слое.\nВведите препарат вручную.",
    "wizard.prompt.fallback.safetyHardStop":
      "Для указанного возраста препараты по этому симптому исключены safety hard-stop фильтром.\nВведите препарат вручную.",
    "wizard.prompt.fallback.missingRuntimeCatalog":
      "Связанные препараты для этого симптома не найдены в локальном runtime-каталоге.\nВведите препарат вручную.",
    "wizard.prompt.fallback.symptomNotInMap":
      "По этому симптому пока нет точного совпадения в golden-карте.\nВведите препарат вручную.",
    "wizard.prompt.fallback.default": "По этому симптому пока нет точного совпадения в golden-карте.\nВведите препарат вручную.",
    "wizard.prompt.referenceList": "Справочная подборка из локального каталога (не мед. назначение).{profileHint}",
    "wizard.prompt.profileHint": "\nПрофиль учтён: {label}",
    "wizard.prompt.restartTimeout": "Сессия истекла. Начинаем заново.\nВыберите возраст пациента:",
    "wizard.prompt.restartError": "⚠️ Произошла ошибка. Состояние сброшено, начнем заново.\nВыберите возраст пациента:",
    "wizard.prompt.cancelledToMenu": "Действие отменено. Можно начать заново через меню.",
    "analysis.status.safe": "🟢 Можно",
    "analysis.status.caution": "🟡 Есть риск",
    "analysis.status.dangerous": "🔴 Нежелательно сочетать",
    "analysis.summary.fallback": "Недостаточно данных для точного вывода.",
    "analysis.explanation.fallback": "Проверьте официальные инструкции и уточните схему у врача.",
    "analysis.comparison.fallback": "• Недостаточно данных для точного вывода по этой комбинации.",
    "analysis.monitoring.fallback": "• Контролируйте общее самочувствие.",
    "analysis.doctor.fallback": "• Уточните у врача, есть ли подтверждённые данные по этой комбинации для вашего возраста.",
    "analysis.section.reason": "Причина:",
    "analysis.section.comparison": "Сравнение по данным:",
    "analysis.section.monitoring": "Что контролировать:",
    "analysis.section.doctor": "Что уточнить у врача:",
    "analysis.card.saveError": "⚠️ Не удалось сохранить карточку. Попробуйте повторить позже.",
    "analysis.block.drugs": "Лекарства:",
    "analysis.block.ageConsidered": "👶 Возраст учтён:",
    "analysis.block.ageLine": "{age} лет — возможны ограничения",
    "analysis.block.ageUnknown": "не указан",
    "analysis.block.actions": "Что можно сделать:",
    "analysis.block.risksChecked": "ℹ️ Проверены основные риски:",
    "analysis.block.risk.compatibility": "• совместимость (по инструкциям)",
    "analysis.block.risk.age": "• ограничения по возрасту",
    "analysis.block.source": "ℹ️ Источник: инструкции препаратов и открытые справочные данные",
    "analysis.block.dosageNote": "ℹ️ Указана дозировка из вашего ввода. Я не оцениваю корректность дозировки. Проверь инструкцию.",
    "analysis.block.important": "⚠️ ВАЖНО:",
    "analysis.disclaimer.line1": "Этот бот не является врачом и не назначает лечение.",
    "analysis.disclaimer.line2": "Информация носит справочный характер и основана на инструкциях препаратов.",
    "analysis.disclaimer.line3": "Перед применением обязательно проконсультируйтесь с врачом.",
    "analysis.button.saveCard": "💾 Сохранить карточку",
    "analysis.button.reminder": "⏰ Напоминание о приёме",
    "analysis.button.newCheck": "🔁 Проверить ещё",
    "analysis.button.shareCard": "🔗 Поделиться карточкой",
    "analysis.action.attention.1": "• Не начинайте совместный приём без подтверждения врача.",
    "analysis.action.attention.2": "• Уточните, нет ли дублирования действующих веществ.",
    "analysis.action.attention.3": "• При ухудшении состояния обратитесь за очной медицинской помощью.",
    "analysis.action.caution.1": "• Сначала уточните схему приёма у врача или фармацевта.",
    "analysis.action.caution.2": "• Сверьте возрастные ограничения в инструкции каждого препарата.",
    "analysis.action.caution.3": "• При необычных симптомах прекратите самолечение и обратитесь к врачу.",
    "analysis.action.safe.1": "• Проверьте инструкцию и возрастные ограничения для каждого препарата.",
    "analysis.action.safe.2": "• При сомнениях выберите очную консультацию.",
    "analysis.action.safe.3": "• Не превышайте дозировку, назначенную врачом.",
    "analysis.input.empty": "Список препаратов пуст. Сначала добавьте хотя бы один препарат.",
    "analysis.input.unrecognized": "Не удалось распознать препараты из текущего списка. Введите название вручную.",
    "analysis.age.unknownValue": "не указан",
    "analysis.engine.fallback.summary": "Недостаточно данных для точного вывода по этой комбинации.",
    "analysis.engine.fallback.explanation": "Для этой комбинации пока недостаточно локализованных данных. Проверьте инструкции и уточните схему у врача.",
    "analysis.engine.fallback.comparison": "Недостаточно данных для точного вывода по этой комбинации.",
    "analysis.engine.fallback.monitoring": "Контролируйте общее самочувствие.",
    "analysis.engine.fallback.doctor": "Уточните у врача схему для вашего возраста.",
    "analysis.engine.notEnoughForCombination": "Недостаточно данных для точного вывода по сочетанию: {pair}.",
    "analysis.engine.noConfirmedRule": "Комбинация {pair}: нет подтверждённого точного правила в текущей локальной базе.",
    "single.symptomHint.prefix": "Обычно используется при: {symptoms}",
    "single.symptomHint.generic": "Обычно используется при соответствующих симптомах.",
    "single.risk.liver": "риск нагрузки на печень",
    "single.risk.allergy": "риск аллергической реакции",
    "single.risk.gi": "риск для ЖКТ",
    "single.risk.kidney": "риск нагрузки на почки",
    "single.risk.cns": "возможные эффекты со стороны нервной системы",
    "single.ageRestriction.range": "Возрастные ограничения: от {min} до {max} лет.",
    "single.ageRestriction.minOnly": "Возрастные ограничения: от {min} лет.",
    "single.ageRestriction.maxOnly": "Возрастные ограничения: до {max} лет.",
    "single.ageRestriction.generic": "Возрастные ограничения: уточняйте по инструкции.",
    "single.keyWarnings": "Ключевые предупреждения: {value}.",
    "single.contraindications": "Ограничения/противопоказания: {value}.",
    "single.contraindications.generic": "Ограничения/противопоказания: есть данные, проверьте инструкцию.",
    "single.cautionInteractions": "Осторожность по сочетаниям: {value}.",
    "single.cautionInteractions.generic": "По сочетаниям требуется осторожность, сверяйтесь с инструкцией.",
    "single.infoFallback": "Справочная информация ограничена: для этого препарата в текущей базе недостаточно структурированных safety-данных.",
    "single.footer": "👶 Возраст учтён: {age}\n⚠️ Информация справочная, это не медицинский совет.",
    "single.button.addMore": "➕ Добавить ещё препарат",
    "single.button.checkCombo": "🔎 Проверить сочетание",
    "single.button.back": "↩ Назад",
    "profile.menu.create": "➕ Создать профиль",
    "profile.menu.temp": "🕒 Использовать без сохранения",
    "profile.menu.select": "👤 Выбрать активный",
    "profile.menu.edit": "✏️ Изменить",
    "profile.menu.delete": "🗑 Удалить",
    "profile.menu.deactivate": "🚫 Отключить активный",
    "profile.menu.back": "⬅ Назад",
    "profile.role.self": "Для себя",
    "profile.role.child": "Для ребёнка",
    "profile.role.family": "Для члена семьи",
    "profile.role.manual": "Ввести название вручную",
    "profile.bool.yes": "Да",
    "profile.bool.no": "Нет",
    "profile.save.save": "💾 Сохранить",
    "profile.save.useOnce": "🕒 Использовать один раз",
    "profile.share.button": "Поделиться",
    "profile.cb.menu": "Профили",
    "profile.cb.mainMenu": "Главное меню",
    "profile.cb.create": "Создание профиля",
    "profile.cb.temporary": "Временный профиль",
    "profile.cb.select": "Выбор профиля",
    "profile.cb.edit": "Редактирование",
    "profile.cb.delete": "Удаление профиля",
    "profile.cb.deactivated": "Активный профиль отключён",
    "profile.cb.notFound": "Профиль не найден",
    "profile.cb.activated": "Профиль активирован",
    "profile.cb.deleted": "Профиль удалён",
    "profile.cb.draftNotFound": "Черновик не найден",
    "profile.cb.accepted": "Принято",
    "profile.cb.saving": "Сохранение",
    "profile.cb.tempMode": "Временный режим",
    "profile.reply.cardNotFound": "Карточка не найдена.",
    "profile.reply.cardNoAccess": "Нет доступа к этой карточке",
    "profile.reply.askWhoCreate": "Для кого профиль?",
    "profile.reply.askWhoTemporary": "Для кого временный профиль?",
    "profile.reply.noneSaved": "Сохранённых профилей пока нет.",
    "profile.reply.chooseActive": "Выберите активный профиль:",
    "profile.reply.chooseEdit": "Выберите профиль для изменения:",
    "profile.reply.chooseDelete": "Выберите профиль для удаления:",
    "profile.reply.deactivated": "Активный профиль отключён. Можно работать в упрощённом режиме или создать новый.",
    "profile.reply.activeProfile": "Активный профиль:\n{summary}",
    "profile.reply.askName": "Введите название профиля (например: Мама).",
    "profile.reply.savedActivated": "Профиль сохранён и активирован:\n{summary}",
    "profile.reply.saveFailed": "Не удалось сохранить профиль.",
    "profile.reply.tempApplied": "Временный профиль применён на текущий сценарий:\n{summary}\n\nОн не будет сохранён в базе.",
    "profile.reply.fromSafety": "Учтён профиль безопасности{suffix}.\nМожно сразу выбрать симптом.",
    "profile.reply.startCheck": "Нажмите «Проверить лекарства», чтобы начать проверку.",
    "profile.error.draftRestart": "Черновик профиля не найден. Начните заново.",
    "profile.error.draftReopen": "Черновик профиля не найден. Откройте раздел профилей заново.",
    "profile.error.nameTooShort": "Название профиля слишком короткое. Введите 2+ символа.",
    "profile.error.ageRange": "Возраст должен быть числом от 0 до 100.",
    "profile.wizard.agePrompt": "Укажите возраст (0–120).",
    "profile.wizard.allergyNotes": "Кратко укажите аллергию (без лишних данных). Например: ибупрофен.",
    "profile.wizard.question.allergy": "Есть ли лекарственная аллергия?",
    "profile.wizard.question.gi": "Есть риск по ЖКТ (язва/кровотечения)?",
    "profile.wizard.question.liver": "Есть значимый риск по печени?",
    "profile.wizard.question.kidney": "Есть значимый риск по почкам?",
    "profile.wizard.question.chronic": "Есть хроническое состояние, важное для осторожности?",
    "profile.wizard.saveQuestion": "Сохранить профиль?",
    "profile.history.empty": "У вас пока нет проверок.",
    "profile.history.meds": "Лекарства: {value}",
    "profile.history.header": "📚 Ваши последние проверки:\n\n{value}",
    "profile.menu.intro.1": "Профиль нужен, чтобы учитывать возраст и важные ограничения и не показывать неподходящие препараты.",
    "profile.menu.intro.2": "Можно использовать профиль временно или сохранить. Профиль можно удалить в любой момент.",
    "profile.menu.activeTitle": "Активный профиль:",
    "profile.menu.activeMissing": "Активный профиль не выбран.",
    "profile.menu.savedCount": "Сохранённых профилей: {count}",
    "profile.reset.message": "Состояние сброшено. Начнем заново.\nВыберите возраст пациента:",
    "profile.defaultLabel": "Профиль",
    "profile.defaultLabel.temporary": "Временный профиль",
    "profile.summary.ageKnown": "{age} лет",
    "profile.summary.ageUnknown": "возраст не указан",
    "profile.summary.flag.pregnancy": "беременность/лактация",
    "profile.summary.flag.drugAllergy": "лекарственная аллергия",
    "profile.summary.flag.gi": "ЖКТ-риск",
    "profile.summary.flag.liver": "риск по печени",
    "profile.summary.flag.kidney": "риск по почкам",
    "profile.summary.flag.chronic": "хроническое состояние",
    "profile.summary.flag.none": "ключевых ограничений не отмечено",
    "profile.summary.ageLine": "Возраст: {value}",
    "profile.summary.limitsLine": "Ограничения: {value}"
  },
  uz: {
    "menu.check": "Dorini tekshirish",
    "menu.reminders": "⏰ Eslatmalarim",
    "menu.history": "Mening tekshiruvlarim",
    "menu.safetyProfiles": "Xavfsizlik profillari",
    "menu.howTo": "Qanday ishlatish",
    "menu.language": "🌐 Til",
    "reminder.menu.title": "⏰ Eslatmalarim",
    "reminder.menu.description":
      "Bu yerda dori qabul qilish eslatmasini qo‘shishingiz, faol kurslarni ko‘rishingiz va qabul qilinganini belgilashingiz mumkin.",
    "reminder.menu.disclaimer": "ℹ️ Xizmat ma’lumot uchun, shifokor maslahatini almashtirmaydi.",
    "reminder.menu.add": "➕ Eslatma qo‘shish",
    "reminder.menu.active": "📋 Faol kurslar",
    "reminder.menu.today": "📅 Bugun",
    "reminder.menu.history": "📊 Qabul tarixi",
    "reminder.menu.profile": "👪 Eslatma profili",
    "reminder.menu.settings": "⚙️ Bildirishnoma sozlamalari",
    "reminder.menu.back": "◀️ Orqaga",
    "reminder.settings.notifOn": "🔔 Bildirishnomalar yoqilsin",
    "reminder.settings.notifOff": "🔕 Bildirishnomalar o‘chirilsin",
    "reminder.settings.qhOn": "🌙 Tinch soatlar yoqilsin",
    "reminder.settings.qhOff": "🌞 Tinch soatlar o‘chirilsin",
    "reminder.settings.qhTime": "🕒 Tinch soatlar vaqti",
    "rem.freq.d1": "Kuniga 1 marta",
    "rem.freq.d2": "Kuniga 2 marta",
    "rem.freq.d3": "Kuniga 3 marta",
    "rem.freq.h8": "Har 8 soatda",
    "rem.freq.h12": "Har 12 soatda",
    "rem.freq.custom": "O‘z varianti",
    "rem.dur.d1": "1 kun",
    "rem.dur.d3": "3 kun",
    "rem.dur.d5": "5 kun",
    "rem.dur.d7": "7 kun",
    "rem.dur.d10": "10 kun",
    "rem.dur.open": "Tugash sanasisiz",
    "rem.dur.custom": "O‘z varianti",
    "rem.nav.back": "◀️ Orqaga",
    "rem.save.save": "✅ Saqlash",
    "rem.save.edit": "✏️ O‘zgartirish",
    "rem.value.notSpecified": "ko‘rsatilmagan",
    "rem.value.notSelected": "tanlanmagan",
    "rem.value.none": "yo‘q",
    "rem.value.openEnded": "Tugash sanasisiz",
    "rem.value.days": "{days} kun",
    "rem.value.dosageMissing": "doza ko‘rsatilmagan",
    "rem.value.status.active": "faol",
    "rem.value.day.withTotal": "{current}-kun / {total}",
    "rem.value.day.single": "{current}-kun",
    "rem.value.status.scheduled": "rejalashtirilgan",
    "rem.value.status.sent": "yuborilgan",
    "rem.value.status.taken": "qabul qilingan",
    "rem.value.status.skipped": "o‘tkazib yuborilgan",
    "rem.value.status.snoozed": "kechiktirilgan",
    "rem.value.status.missed": "o‘tkazib yuborilgan",
    "rem.value.status.mark_now": "qo‘lda belgilangan",
    "rem.confirm.title": "✅ Eslatma ma’lumotlarini tekshiring",
    "rem.confirm.drug": "Dori: {value}",
    "rem.confirm.dosage": "Doza: {value}",
    "rem.confirm.time": "Vaqt: {value}",
    "rem.confirm.frequency": "Chastota: {value}",
    "rem.confirm.duration": "Davomiylik: {value}",
    "rem.confirm.profile": "Profil: {value}",
    "rem.confirm.note": "Izoh: {value}",
    "rem.confirm.info": "ℹ️ Bot siz kiritgan ma’lumotlar bo‘yicha eslatadi.",
    "rem.menu.chooseAction": "Eslatmalar bo‘limida amalni tanlang.",
    "rem.legal.text":
      "ℹ️ Eslatmalar o‘zingiz kiritgan qabulni unutmaslikka yordam beradi.\n\nBot:\n• davolash tayinlamaydi\n• doza to‘g‘riligini tekshirmaydi\n• shifokor maslahatini almashtirmaydi\n\nDavom etib, ma’lumotni mustaqil yoki mutaxassis tavsiyasi bo‘yicha kiritayotganingizni tasdiqlaysiz.",
    "rem.legal.ok": "✅ Tushunarli",
    "rem.start.enterDrug": "💊 Dori nomini kiriting.\n\nMasalan:\nParacetamol\nIbuprofen\nAmbroksol",
    "rem.courses.empty": "📋 Hozircha faol kurslar yo‘q.",
    "rem.courses.title": "📋 Faol eslatmalar",
    "rem.courses.subtitle": "Jadvalni ko‘rish yoki o‘zgartirish uchun kursni tanlang.",
    "rem.course.open": "Ochish",
    "rem.course.pause": "Pauza",
    "rem.course.finish": "Yakunlash",
    "rem.course.notFound": "Kurs topilmadi.",
    "rem.course.schedule.everyHours": "har {hours} soatda",
    "rem.course.duration.label.open": "Tugash sanasisiz",
    "rem.course.duration.label.days": "{days} kun",
    "rem.course.progress.withTotal": "{current} / {total} kun",
    "rem.course.progress.dayOnly": "{current}-kun",
    "rem.course.latest.none": "Qabul belgilari yo‘q.",
    "rem.course.latest.title": "So‘nggi belgilar:",
    "rem.course.label.dosage": "Doza: {value}",
    "rem.course.label.schedule": "Jadval: {value}",
    "rem.course.label.duration": "Davomiylik: {value}",
    "rem.course.label.progress": "O‘tilgani: {value}",
    "rem.course.label.profile": "Profil: {value}",
    "rem.course.label.status": "Holat: {value}",
    "rem.course.info": "ℹ️ Bu eslatma siz kiritgan ma’lumotlar asosida yaratilgan.",
    "rem.course.btn.marknow": "✅ Hozir qabulni belgilash",
    "rem.course.btn.edit": "✏️ O‘zgartirish",
    "rem.course.btn.pause": "⏸ Pauza",
    "rem.course.btn.delete": "🗑 O‘chirish",
    "rem.course.btn.check": "🔍 Moslikni tekshirish",
    "rem.course.btn.back": "◀️ Orqaga",
    "rem.cb.add": "Qo‘shish",
    "rem.cb.profile": "Profil",
    "rem.cb.back": "Orqaga",
    "rem.cb.quick": "Tez rejim",
    "rem.cb.advanced": "Kengaytirilgan rejim",
    "rem.cb.needDrug": "Avval dorini kiriting",
    "rem.cb.draftNotFound": "Qoralama topilmadi",
    "rem.cb.skipped": "O‘tkazib yuborildi",
    "rem.cb.custom": "O‘z varianti",
    "rem.cb.frequencySelected": "Chastota tanlandi",
    "rem.cb.durationSelected": "Davomiylik tanlandi",
    "rem.cb.edit": "O‘zgartirish",
    "rem.cb.editing": "Tahrirlash",
    "rem.cb.missingData": "Ma’lumot yetarli emas",
    "rem.cb.profileCheck": "Profil tekshiruvi",
    "rem.cb.interactionCheck": "Moslik tekshiruvi",
    "rem.cb.duplicate": "Dublikat bor",
    "rem.cb.limit": "Limitga yetildi",
    "rem.cb.error": "Xatolik",
    "rem.cb.saved": "Saqlandi",
    "rem.cb.continue": "Davom etamiz",
    "rem.cb.draftStale": "Qoralama eskirgan",
    "rem.cb.failed": "Bajarilmadi",
    "rem.cb.created": "Yaratildi",
    "rem.cb.cancelled": "Bekor qilindi",
    "rem.cb.list": "Ro‘yxat",
    "rem.cb.today": "Bugun",
    "rem.cb.stats": "Statistika",
    "rem.cb.settings": "Sozlamalar",
    "rem.cb.notifOn": "Bildirishnomalar yoqildi",
    "rem.cb.notifOff": "Bildirishnomalar o‘chirildi",
    "rem.cb.qhOn": "Tinch soatlar yoqildi",
    "rem.cb.qhOff": "Tinch soatlar o‘chirildi",
    "rem.cb.enterRange": "Oraliqni kiriting",
    "rem.cb.openCourse": "Kurs ochilmoqda",
    "rem.cb.pause": "Pauza",
    "rem.cb.completed": "Yakunlandi",
    "rem.cb.deleted": "O‘chirildi",
    "rem.cb.marked": "Belgilandi",
    "rem.cb.takeMarked": "Qabul belgilandi",
    "rem.cb.skipMarked": "O‘tkazib yuborish belgilandi",
    "rem.cb.snooze": "Kechiktirish",
    "rem.cb.snoozed": "Kechiktirildi",
    "rem.cb.notFound": "Topilmadi",
    "rem.reply.profileNone": "Saqlangan profillar yo‘q. Standart profil ishlatiladi.",
    "rem.reply.profileChoose": "Eslatma uchun profilni tanlang:",
    "rem.reply.profileReset": "Profilni tiklash",
    "rem.reply.profileNotFound": "Profil topilmadi",
    "rem.reply.profileSelected": "👪 Eslatma profili: {label}",
    "rem.reply.profileCleared": "Eslatma profili tiklandi.",
    "rem.reply.enterDrug": "💊 Dori nomini kiriting.",
    "rem.reply.enterDrugAgain": "💊 Dori nomini qayta kiriting.",
    "rem.reply.drugNameTooShort": "Dori nomini kiriting (kamida 2 belgi).",
    "rem.reply.modePrompt": "Siz dori tanladingiz:\n💊 {drug}\n\nEndi eslatma turini tanlang.",
    "rem.mode.quickBtn": "⚡ Tez eslatma",
    "rem.mode.advancedBtn": "⚙️ Kengaytirilgan rejim",
    "rem.mode.profileBtn": "👪 Eslatma profili",
    "rem.reply.enterTime": "⏰ Birinchi eslatma vaqtini kiriting.\n\nMisol:\n08:00\n21:30",
    "rem.reply.enterTimeFormatError": "Vaqtni aniqlab bo‘lmadi.\n\nQuyidagi formatda kiriting:\n08:00\n21:30",
    "rem.reply.frequencyPick": "🔁 Eslatma chastotasini tanlang.",
    "rem.reply.durationPick": "📅 Eslatma davomiyligini tanlang.",
    "rem.reply.customFreqPrompt": "Bir sutkada nechta eslatma bo‘lishini kiriting (1 dan 6 gacha).",
    "rem.reply.customFreqInvalid": "1 dan 6 gacha butun son kiriting.",
    "rem.reply.customDurPrompt": "Davomiylikni kunlarda kiriting, masalan: 5",
    "rem.reply.customDurInvalid": "Davomiylikni aniqlab bo‘lmadi.\n\nKun sonini kiriting, masalan:\n5\n7\n10",
    "rem.reply.notePrompt": "📝 Izoh qo‘shing (masalan: ovqatdan keyin).\nYoki «O‘tkazib yuborish»ni bosing.",
    "rem.reply.noteSkip": "O‘tkazib yuborish",
    "rem.reply.qhFormat": "Tinch soatlarni `23:00-07:00` formatida kiriting.",
    "rem.reply.qhFormatError": "Oraliqni aniqlab bo‘lmadi.\nQuyidagi formatda kiriting: 23:00-07:00",
    "rem.reply.qhUpdated": "🌙 Tinch soatlar yangilandi: {start}–{end}",
    "rem.reply.openedReminderSection": "Eslatmalar bo‘limi ochildi.",
    "rem.reply.saved": "✅ Eslatma saqlandi.",
    "rem.reply.created": "✅ Eslatma yaratildi.",
    "rem.reply.savedRisk": "✅ Eslatma potensial xavf ogohlantirishi bilan saqlandi.",
    "rem.reply.notCreated": "Mayli, eslatma yaratilmadi.",
    "rem.reply.confirmSave": "Eslatmani saqlashni tasdiqlang.",
    "rem.reply.draftMissing": "Eslatma qoralamasi topilmadi. Qaytadan boshlang.",
    "rem.reply.draftMissingShort": "Eslatma qoralamasi topilmadi.",
    "rem.reply.saveFailed": "Eslatmani saqlab bo‘lmadi. Parametrlarni tekshirib, qayta urinib ko‘ring.",
    "rem.reply.saveFailedShort": "Eslatmani saqlab bo‘lmadi. Parametrlarni tekshiring.",
    "rem.reply.addedToCheck": "Tekshiruvga qo‘shildi: {name}\nDavomini moslik ustasi orqali qilamiz.",
    "rem.reply.childWarn":
      "👶 Bolalar uchun doza va qabul tartibi yosh, tana vazni va shifokor tayinloviga bog‘liq bo‘lishi mumkin.\n\nKiritilgan ma’lumotlar to‘g‘riligini tekshiring.",
    "rem.reply.childContinue": "✅ Davom etish",
    "rem.reply.interactionWarn":
      "⚠️ Ko‘rsatilgan boshqa dorilar bilan potensial moslik xavfi haqida ma’lumot topildi.\n\n{summary}\n\nBu ma’lumotnoma ogohlantirishidir. Qabul bo‘yicha qaror uchun mutaxassis maslahatini oling.",
    "rem.reply.interactionCheckBtn": "🔍 Moslikni tekshirish",
    "rem.reply.interactionSaveAnyway": "Baribir saqlash",
    "rem.reply.cancel": "Bekor qilish",
    "rem.reply.duplicateWarn":
      "ℹ️ Sizda bu dori uchun allaqachon faol eslatma bor.\n\nYangi eslatma jadvalda chalkashlik tug‘dirmasligini tekshiring.",
    "rem.reply.duplicateCreateAnyway": "Baribir yaratish",
    "rem.reply.duplicateOpenCurrent": "Joriy kursni ochish",
    "rem.reply.limitReached":
      "Faol eslatmalar limiti tugagan.\n\nYangi eslatma qo‘shish uchun joriy kurslardan birini yakunlang yoki o‘chiring.",
    "rem.reply.todayEmpty": "📅 Bugun eslatmalar yo‘q.",
    "rem.reply.todayTitle": "📅 Bugun:\n{lines}",
    "rem.reply.statsTitle": "📊 Qabul tarixi",
    "rem.reply.statsNoEvents": "Hodisalar yo‘q.",
    "rem.reply.statsTotalCourses": "Jami kurslar: {value}",
    "rem.reply.statsActiveCourses": "Faol kurslar: {value}",
    "rem.reply.statsTaken": "«Qabul qilindi» belgilari: {value}",
    "rem.reply.statsSkipped": "«O‘tkazib yuborildi» belgilari: {value}",
    "rem.reply.statsSnoozed": "Kechiktirilgan: {value}",
    "rem.reply.statsRecent": "So‘nggi hodisalar:",
    "rem.reply.settingsTitle": "⚙️ Bildirishnoma sozlamalari",
    "rem.reply.settingsNotifications": "Bildirishnomalar: {value}",
    "rem.reply.settingsQuietHours": "Tinch soatlar: {value}",
    "rem.reply.notifOn": "🔔 Bildirishnomalar yoqildi.",
    "rem.reply.notifOff": "🔕 Bildirishnomalar o‘chirildi.",
    "rem.reply.qhOn": "🌙 Tinch soatlar yoqildi: {start}–{end}",
    "rem.reply.qhOff": "🌞 Tinch soatlar o‘chirildi.",
    "rem.reply.pauseDone": "⏸ Kurs pauzaga qo‘yildi.",
    "rem.reply.finishDone": "✅ Kurs yakunlandi.",
    "rem.reply.deleteDone": "🗑 Eslatma o‘chirildi.",
    "rem.reply.markDone": "✅ Qabul belgilandi.",
    "rem.reply.takeDone": "✅ Qabul belgilandi.",
    "rem.reply.takeOpenCourse": "📋 Kursni ochish",
    "rem.reply.toMenu": "◀️ Menyuga",
    "rem.reply.skipDone":
      "❌ O‘tkazib yuborish belgilandi.\n\nKeyingi qabul bo‘yicha shubha bo‘lsa, dori yo‘riqnomasini tekshiring yoki shifokordan aniqlang.",
    "rem.reply.snoozeAsk": "⏳ Eslatmani qancha vaqtga kechiktirasiz?",
    "rem.reply.snooze15": "15 daqiqa",
    "rem.reply.snooze30": "30 daqiqa",
    "rem.reply.snooze60": "1 soat",
    "rem.reply.snooze120": "2 soat",
    "rem.reply.snoozeDone": "⏳ Eslatma kechiktirildi.",
    "rem.notifications.modern.title": "💊 Qabul eslatmasi",
    "rem.notifications.modern.drug": "Dori: {value}",
    "rem.notifications.modern.dosage": "Doza: {value}",
    "rem.notifications.modern.time": "⏰ Vaqt: {value}",
    "rem.notifications.modern.day": "📅 Kun {value}",
    "rem.notifications.modern.info": "ℹ️ Eslatma siz kiritgan ma’lumotlar asosida yuborildi.",
    "rem.notifications.modern.btn.take": "✅ Qabul qilindi deb belgilash",
    "rem.notifications.modern.btn.snooze": "⏳ Kechiktirish",
    "rem.notifications.modern.btn.skip": "❌ O‘tkazib yuborish",
    "rem.notifications.modern.btn.open": "📋 Kursni ochish",
    "rem.notifications.legacy.text": "⏰ Dori qabul qilish vaqti.\n\nYangi tekshiruvni boshlash uchun bosing.",
    "rem.notifications.legacy.btn.check": "Yana tekshirish",
    "rem.card.notFound": "Karta topilmadi",
    "rem.card.noAccess": "Ruxsat yo‘q",
    "rem.card.saved": "Karta saqlandi",
    "rem.card.savedReply": "✅ Karta tarixda allaqachon saqlangan.\nID: {id}",
    "rem.card.saveError": "Saqlash xatosi",
    "rem.card.pickTime": "Vaqtni tanlang",
    "rem.card.pickDelay": "⏰ Qancha vaqtdan keyin eslatilsin:",
    "rem.card.in6h": "6 soatdan keyin",
    "rem.card.in12h": "12 soatdan keyin",
    "rem.card.in24h": "24 soatdan keyin",
    "rem.card.paramsExpired": "Eslatma parametrlari eskirgan. Qayta oching.",
    "rem.card.noAccessOrNotFound": "Ruxsat yo‘q yoki karta topilmadi.",
    "rem.card.addedCb": "Eslatma qo‘shildi",
    "rem.card.addedReply": "⏰ Eslatma {hours} soatdan keyin qo‘shildi.",
    "rem.card.remindError": "Eslatma xatosi",
    "rem.card.startNewCheck": "Yangi tekshiruvni boshlaymiz",
    "start.greeting":
      "Salom. Dori kombinatsiyasini sodda tilda tushunishga yordam beraman.\nBoshlash uchun «Dorini tekshirish» tugmasini bosing.",
    "main.menu.opened": "Asosiy menyu ochildi.",
    "howto.text":
      "Qanday ishlatish:\n1) «Dorini tekshirish»ni bosing\n2) Yoshni tanlang yoki profilni ishlating\n3) Alomatni tanlang\n4) Safety-filtrlar bilan tavsiyalarni oling",
    "lang.prompt": "Interfeys tilini tanlang:",
    "lang.changedRu": "Til o‘zgartirildi: Русский",
    "lang.changedUz": "Til o‘zgartirildi: O‘zbekcha",
    "lang.option.ru": "Русский",
    "lang.option.uz": "O‘zbekcha",
    "lang.back": "◀️ Orqaga",
    "buy.opening": "Dorixonani ochyapmiz",
    "buy.transition": "Sotib olishga o‘tish: {name}",
    "buy.button": "💊 Dorixonadan sotib olish",
    "buy.missingDrug": "Sotib olish uchun dori topilmadi",
    "buy.cardNotFound": "Karta topilmadi",
    "buy.cardDrugMissing": "Kartadagi dori lokal bazadan topilmadi. Qo‘lda kiriting.",
    "wizard.age.exact": "Aniq kiritish",
    "wizard.symptom.fever": "🤒 Harorat",
    "wizard.symptom.cough": "😷 Yo‘tal",
    "wizard.symptom.throat": "🗣 Tomoq",
    "wizard.symptom.runny": "🤧 Burun oqishi",
    "wizard.symptom.pain": "🤕 Og‘riq",
    "wizard.symptom.allergy": "🌼 Allergiya",
    "wizard.symptom.other": "➕ Boshqa",
    "wizard.symptom.manual": "➕ Qo‘lda kiritish",
    "wizard.nav.back": "⬅ Orqaga",
    "wizard.drug.partnerPrefix": "⭐ Hamkor: ",
    "wizard.detail.fever.high": "Yuqori harorat",
    "wizard.detail.fever.heat": "Isitma",
    "wizard.detail.fever.fever": "Qaltirash",
    "wizard.detail.fever.child": "Bolada harorat",
    "wizard.detail.cough.dry": "Quruq yo‘tal",
    "wizard.detail.cough.wet": "Nam yo‘tal",
    "wizard.detail.cough.night": "Tungi yo‘tal",
    "wizard.detail.cough.long": "Uzoq davom etuvchi yo‘tal",
    "wizard.detail.throat.pain": "Tomoq og‘rig‘i",
    "wizard.detail.throat.irritation": "Tomoq qichishi",
    "wizard.detail.throat.discomfort": "Tomoq bezovtaligi",
    "wizard.detail.throat.swallow": "Yutishda og‘riq",
    "wizard.detail.runny.blocked": "Burun bitishi",
    "wizard.detail.runny.runny": "Burun oqishi",
    "wizard.detail.runny.discharge": "Ko‘p ajralma",
    "wizard.detail.runny.sneeze": "Tez-tez aksirish",
    "wizard.detail.pain.head": "Bosh og‘rig‘i",
    "wizard.detail.pain.muscle": "Mushak og‘rig‘i",
    "wizard.detail.pain.abdomen": "Qorin og‘rig‘i",
    "wizard.detail.pain.spasm": "Spazm",
    "wizard.detail.allergy.runny": "Allergik burun oqishi",
    "wizard.detail.allergy.itch": "Teri qichishi",
    "wizard.detail.allergy.rash": "Toshma",
    "wizard.detail.allergy.tears": "Ko‘z yoshlanishi",
    "wizard.prompt.age": "Bemor yoshini tanlang:",
    "wizard.prompt.category": "Alomat turini tanlang:",
    "wizard.prompt.categoryButtons": "Quyidagi tugmalar orqali alomat turini tanlang.",
    "wizard.prompt.detailButtons": "Alomatni aniqlashtiruvchi variantni tanlang yoki «Qo‘lda kiritish»ni bosing.",
    "wizard.prompt.noMatches": "Bu tur bo‘yicha lokal katalogda aniq moslik topilmadi. Dorini qo‘lda kiriting.",
    "wizard.prompt.detailForCategory": "Alomatni aniqlashtiring: {category}",
    "wizard.prompt.describeManual": "Alomatni qo‘lda yozing.",
    "wizard.prompt.describeMore": "Alomatni biroz batafsilroq yozing (kamida 3 belgi).",
    "wizard.prompt.enterDrug": "Dori nomini qo‘lda kiriting.",
    "wizard.prompt.enterDrugAgain": "Ikkinchi dorini qo‘lda kiriting.",
    "wizard.prompt.enterDrugExact": "Dori nomini aniq qo‘lda kiriting.",
    "wizard.prompt.enterSecondDrug": "Qo‘shildi: {drug}\nJoriy ro‘yxat: {list}\n\nKeyingi dorini qanday qo‘shishni tanlang:",
    "wizard.prompt.enterAgeExact": "Aniq yoshni kiriting (0–100):",
    "wizard.prompt.ageGuidance": "Yoshni tugma orqali tanlang yoki matn bilan kiriting (masalan: 5-10 yoki 8).",
    "wizard.prompt.listEmpty": "Ro‘yxat hali bo‘sh. Kamida bitta dorini kiriting.",
    "wizard.prompt.listEmptySubmit": "Kamida bitta dorini vergul bilan kiriting.",
    "wizard.prompt.shortDrugName": "Dori nomi juda qisqa. Kamida 3 ta harf kiriting.",
    "wizard.prompt.selectDrug": "Dorini tanlang:",
    "wizard.prompt.nowManualComma":
      "Endi dorini qo‘lda vergul bilan kiritishingiz mumkin.\nMasalan: nurofen, paracetamol",
    "wizard.prompt.selectDrugFallback":
      "Endi dorini qo‘lda vergul bilan kiritishingiz mumkin.\nMasalan: nurofen, paracetamol",
    "wizard.prompt.localNotFound":
      "Lokal bazada dori topilmadi.\nYozilishini tekshirib, boshqa nomni qo‘lda kiriting.",
    "wizard.prompt.addNextDrugMode": "Keyingi dorini qanday qo‘shishni tanlang:",
    "wizard.prompt.confirmParsedAs": "Quyidagicha tanildi: {drug}. To‘g‘rimi?",
    "wizard.prompt.unrecognizedDrugSuggestions":
      "Dori nomi ishonchli aniqlanmadi.\nBalki siz quyidagilarni nazarda tutgandirsiz:\n{list}\n\nDori nomini aniq kiriting.",
    "wizard.cb.ageUnknown": "Yosh aniqlanmadi",
    "wizard.cb.ageValue": "Yosh: {value}",
    "wizard.cb.enterAgeNumber": "Yoshni raqam bilan kiriting",
    "wizard.cb.back": "Orqaga",
    "wizard.cb.manualInput": "Qo‘lda kiritish",
    "wizard.cb.symptomUnknown": "Alomat aniqlanmadi",
    "wizard.cb.drugNotFound": "Dori topilmadi",
    "wizard.cb.addSecondDrug": "Ikkinchi dorini qo‘shing",
    "wizard.cb.checking": "Tekshirilmoqda",
    "wizard.cb.symptomMode": "Alomat bo‘yicha tanlash",
    "wizard.cb.selectBySymptom": "Alomat bo‘yicha tanlash",
    "wizard.prompt.ageInvalid": "Yosh 0 dan 100 gacha bo‘lgan son bo‘lishi kerak. Qayta kiriting.",
    "wizard.button.yes": "Ha",
    "wizard.button.noManual": "Yo‘q, qo‘lda kiritish",
    "wizard.button.notThis": "❌ Bu emas",
    "wizard.button.manualEntry": "✍ Qo‘lda kiritish",
    "wizard.button.cancel": "↩ Bekor qilish",
    "wizard.cb.selected": "Tanlandi: {value}",
    "wizard.prompt.selectedAdded":
      "✅ Qo‘shildi: {value}\nJoriy ro‘yxat: {list}\n\nYana dorini vergul bilan qo‘shishingiz yoki ro‘yxatni tekshiruvga yuborishingiz mumkin.",
    "wizard.error.sessionExpired": "Sessiya tugadi. Qaytadan boshlang.",
    "wizard.error.buttonExpired": "Bu tugma eskirgan. Nomni qayta kiriting.",
    "wizard.error.buttonInactive": "Bu tugma endi faol emas.",
    "wizard.error.confirmExpired": "Tasdiqlash muddati tugagan.",
    "wizard.error.selectFailed": "Tanlashda xatolik. Qaytadan boshlang.",
    "wizard.error.genericRestart": "Xatolik. Qaytadan boshlang.",
    "wizard.emergency.seekDoctor": "Iloji boricha tezroq shifokorga murojaat qiling.",
    "wizard.emergency.seekUrgent": "Shoshilinch tarzda shifokor ko‘rigi kerak.",
    "wizard.emergency.callEmergency": "Holat og‘ir bo‘lsa, darhol tez yordam chaqiring.",
    "wizard.emergency.defaultAction": "Shifokor ko‘rigiga murojaat qilish tavsiya etiladi.",
    "wizard.emergency.blockedTemplate":
      "⚠️ Kiritilgan alomatlar bo‘yicha xavfli holat belgilari bor.\n{message}\n\n{action}\nBu holatda o‘z-o‘zini davolash xavfli bo‘lishi mumkin.",
    "wizard.prompt.fallback.unsafeSymptomQuality":
      "Bu alomat bo‘yicha golden-kartada hozircha xavfsiz avtomatik tavsiya yo‘q.\nDorini qo‘lda kiriting.",
    "wizard.prompt.fallback.ageNotProvided": "Alomat bo‘yicha tavsiyalarni xavfsiz filtrlash uchun avval yoshni kiriting.",
    "wizard.prompt.fallback.noAgeEligible":
      "Kiritilgan yosh uchun bu alomat bo‘yicha xavfsiz variant topilmadi.\nDorini qo‘lda kiriting.",
    "wizard.prompt.fallback.noPrimaryCandidates":
      "Bu alomat bo‘yicha quality-filtrdan o‘tgan dori topilmadi.\nDorini qo‘lda kiriting.",
    "wizard.prompt.fallback.missingSafetyProfile":
      "Bu alomat bo‘yicha joriy top-20 qatlamida tasdiqlangan safety-profilga ega dorilar yo‘q.\nDorini qo‘lda kiriting.",
    "wizard.prompt.fallback.safetyHardStop":
      "Kiritilgan yosh uchun bu alomat dorilari safety hard-stop filtri bilan chiqarib tashlangan.\nDorini qo‘lda kiriting.",
    "wizard.prompt.fallback.missingRuntimeCatalog":
      "Bu alomatga bog‘liq dorilar lokal runtime katalogda topilmadi.\nDorini qo‘lda kiriting.",
    "wizard.prompt.fallback.symptomNotInMap":
      "Bu alomat bo‘yicha golden-kartada aniq moslik topilmadi.\nDorini qo‘lda kiriting.",
    "wizard.prompt.fallback.default": "Bu alomat bo‘yicha golden-kartada aniq moslik topilmadi.\nDorini qo‘lda kiriting.",
    "wizard.prompt.referenceList": "Lokal katalogdan ma’lumotnoma ro‘yxati (tibbiy tayinlov emas).{profileHint}",
    "wizard.prompt.profileHint": "\nProfil hisobga olindi: {label}",
    "wizard.prompt.restartTimeout": "Sessiya tugadi. Qaytadan boshlaymiz.\nBemor yoshini tanlang:",
    "wizard.prompt.restartError": "⚠️ Xatolik yuz berdi. Holat tiklandi, qaytadan boshlaymiz.\nBemor yoshini tanlang:",
    "wizard.prompt.cancelledToMenu": "Amal bekor qilindi. Menyu orqali qaytadan boshlashingiz mumkin.",
    "analysis.status.safe": "🟢 Mumkin",
    "analysis.status.caution": "🟡 Xavf bor",
    "analysis.status.dangerous": "🔴 Birga qo‘llash tavsiya etilmaydi",
    "analysis.summary.fallback": "Aniq xulosa uchun ma’lumot yetarli emas.",
    "analysis.explanation.fallback": "Rasmiy yo‘riqnomalarni tekshirib, qabul sxemasini shifokor bilan aniqlang.",
    "analysis.comparison.fallback": "• Bu kombinatsiya bo‘yicha aniq xulosa uchun ma’lumot yetarli emas.",
    "analysis.monitoring.fallback": "• Umumiy holatni kuzating.",
    "analysis.doctor.fallback": "• Bu kombinatsiya bo‘yicha yoshingizga mos tasdiqlangan ma’lumotlarni shifokordan aniqlang.",
    "analysis.section.reason": "Sabab:",
    "analysis.section.comparison": "Ma’lumotlar bo‘yicha solishtirish:",
    "analysis.section.monitoring": "Nimani kuzatish kerak:",
    "analysis.section.doctor": "Shifokordan nimani so‘rash kerak:",
    "analysis.card.saveError": "⚠️ Kartani saqlab bo‘lmadi. Keyinroq qayta urinib ko‘ring.",
    "analysis.block.drugs": "Dorilar:",
    "analysis.block.ageConsidered": "👶 Yosh hisobga olindi:",
    "analysis.block.ageLine": "{age} yosh — cheklovlar bo‘lishi mumkin",
    "analysis.block.ageUnknown": "ko‘rsatilmagan",
    "analysis.block.actions": "Nima qilish mumkin:",
    "analysis.block.risksChecked": "ℹ️ Asosiy xavflar tekshirildi:",
    "analysis.block.risk.compatibility": "• moslik (yo‘riqnomalar asosida)",
    "analysis.block.risk.age": "• yosh bo‘yicha cheklovlar",
    "analysis.block.source": "ℹ️ Manba: dori yo‘riqnomalari va ochiq ma’lumotnomalar",
    "analysis.block.dosageNote": "ℹ️ Siz kiritgan dozaj ko‘rsatildi. Men dozajning to‘g‘riligini baholamayman. Yo‘riqnomani tekshiring.",
    "analysis.block.important": "⚠️ MUHIM:",
    "analysis.disclaimer.line1": "Bu bot shifokor emas va davolash tayinlamaydi.",
    "analysis.disclaimer.line2": "Ma’lumotlar ma’lumotnoma xususiyatiga ega va dori yo‘riqnomalariga asoslangan.",
    "analysis.disclaimer.line3": "Qo‘llashdan oldin albatta shifokor bilan maslahat qiling.",
    "analysis.button.saveCard": "💾 Kartani saqlash",
    "analysis.button.reminder": "⏰ Qabul eslatmasi",
    "analysis.button.newCheck": "🔁 Yana tekshirish",
    "analysis.button.shareCard": "🔗 Kartani ulashish",
    "analysis.action.attention.1": "• Shifokor tasdig‘isiz dorilarni birga qabul qilishni boshlamang.",
    "analysis.action.attention.2": "• Faol moddalarning takrorlanishi yo‘qligini aniqlang.",
    "analysis.action.attention.3": "• Holat yomonlashsa, yuzma-yuz tibbiy yordamga murojaat qiling.",
    "analysis.action.caution.1": "• Avval qabul sxemasini shifokor yoki farmatsevt bilan aniqlang.",
    "analysis.action.caution.2": "• Har bir dori yo‘riqnomasidagi yosh cheklovlarini solishtiring.",
    "analysis.action.caution.3": "• G‘ayrioddiy alomatlarda o‘z-o‘zini davolashni to‘xtatib, shifokorga murojaat qiling.",
    "analysis.action.safe.1": "• Har bir dori uchun yo‘riqnoma va yosh cheklovlarini tekshiring.",
    "analysis.action.safe.2": "• Shubha bo‘lsa, yuzma-yuz konsultatsiyani tanlang.",
    "analysis.action.safe.3": "• Shifokor belgilagan dozadan oshirmang.",
    "analysis.input.empty": "Dorilar ro‘yxati bo‘sh. Avval kamida bitta dori qo‘shing.",
    "analysis.input.unrecognized": "Joriy ro‘yxatdan dorilarni aniqlab bo‘lmadi. Nomini qo‘lda kiriting.",
    "analysis.age.unknownValue": "ko‘rsatilmagan",
    "analysis.engine.fallback.summary": "Bu kombinatsiya bo‘yicha aniq xulosa uchun ma’lumot yetarli emas.",
    "analysis.engine.fallback.explanation": "Bu kombinatsiya bo‘yicha hozircha lokalizatsiya qilingan ma’lumot yetarli emas. Yo‘riqnomani tekshirib, shifokor bilan aniqlang.",
    "analysis.engine.fallback.comparison": "Bu kombinatsiya bo‘yicha aniq xulosa uchun ma’lumot yetarli emas.",
    "analysis.engine.fallback.monitoring": "Umumiy holatni kuzating.",
    "analysis.engine.fallback.doctor": "Yoshingiz uchun qabul sxemasini shifokor bilan aniqlang.",
    "analysis.engine.notEnoughForCombination": "Quyidagi kombinatsiya bo‘yicha aniq xulosa uchun ma’lumot yetarli emas: {pair}.",
    "analysis.engine.noConfirmedRule": "{pair} kombinatsiyasi: joriy lokal bazada tasdiqlangan aniq qoida topilmadi.",
    "single.symptomHint.prefix": "Odatda quyidagi alomatlarda qo‘llanadi: {symptoms}",
    "single.symptomHint.generic": "Odatda mos alomatlarda qo‘llanadi.",
    "single.risk.liver": "jigar yuklanishi xavfi",
    "single.risk.allergy": "allergik reaksiya xavfi",
    "single.risk.gi": "oshqozon-ichak tizimi uchun xavf",
    "single.risk.kidney": "buyrak yuklanishi xavfi",
    "single.risk.cns": "asab tizimi tomondan nojo‘ya ta’sirlar bo‘lishi mumkin",
    "single.ageRestriction.range": "Yosh bo‘yicha cheklov: {min} dan {max} yoshgacha.",
    "single.ageRestriction.minOnly": "Yosh bo‘yicha cheklov: {min} yoshdan boshlab.",
    "single.ageRestriction.maxOnly": "Yosh bo‘yicha cheklov: {max} yoshgacha.",
    "single.ageRestriction.generic": "Yosh cheklovlarini yo‘riqnoma bo‘yicha aniqlang.",
    "single.keyWarnings": "Asosiy ogohlantirishlar: {value}.",
    "single.contraindications": "Cheklovlar/qarshi ko‘rsatmalar: {value}.",
    "single.contraindications.generic": "Cheklovlar/qarshi ko‘rsatmalar mavjud, yo‘riqnomani tekshiring.",
    "single.cautionInteractions": "Birga qo‘llashda ehtiyot chorasi: {value}.",
    "single.cautionInteractions.generic": "Birga qo‘llashda ehtiyot zarur, yo‘riqnomaga amal qiling.",
    "single.infoFallback": "Ma’lumotnoma cheklangan: ushbu dori bo‘yicha joriy bazada yetarli strukturalangan safety-ma’lumot yo‘q.",
    "single.footer": "👶 Yosh hisobga olindi: {age}\n⚠️ Ma’lumot ma’lumotnoma uchun, bu tibbiy maslahat emas.",
    "single.button.addMore": "➕ Yana dori qo‘shish",
    "single.button.checkCombo": "🔎 Moslikni tekshirish",
    "single.button.back": "↩ Orqaga",
    "profile.menu.create": "➕ Profil yaratish",
    "profile.menu.temp": "🕒 Saqlamasdan ishlatish",
    "profile.menu.select": "👤 Faol profilni tanlash",
    "profile.menu.edit": "✏️ O‘zgartirish",
    "profile.menu.delete": "🗑 O‘chirish",
    "profile.menu.deactivate": "🚫 Faol profilni o‘chirish",
    "profile.menu.back": "⬅ Orqaga",
    "profile.role.self": "O‘zim uchun",
    "profile.role.child": "Bola uchun",
    "profile.role.family": "Oila a’zosi uchun",
    "profile.role.manual": "Nomni qo‘lda kiritish",
    "profile.bool.yes": "Ha",
    "profile.bool.no": "Yo‘q",
    "profile.save.save": "💾 Saqlash",
    "profile.save.useOnce": "🕒 Bir marta ishlatish",
    "profile.share.button": "Ulashish",
    "profile.cb.menu": "Profillar",
    "profile.cb.mainMenu": "Asosiy menyu",
    "profile.cb.create": "Profil yaratish",
    "profile.cb.temporary": "Vaqtinchalik profil",
    "profile.cb.select": "Profil tanlash",
    "profile.cb.edit": "Tahrirlash",
    "profile.cb.delete": "Profilni o‘chirish",
    "profile.cb.deactivated": "Faol profil o‘chirildi",
    "profile.cb.notFound": "Profil topilmadi",
    "profile.cb.activated": "Profil faollashtirildi",
    "profile.cb.deleted": "Profil o‘chirildi",
    "profile.cb.draftNotFound": "Qoralama topilmadi",
    "profile.cb.accepted": "Qabul qilindi",
    "profile.cb.saving": "Saqlanmoqda",
    "profile.cb.tempMode": "Vaqtinchalik rejim",
    "profile.reply.cardNotFound": "Karta topilmadi.",
    "profile.reply.cardNoAccess": "Bu kartaga ruxsat yo‘q",
    "profile.reply.askWhoCreate": "Profil kim uchun?",
    "profile.reply.askWhoTemporary": "Vaqtinchalik profil kim uchun?",
    "profile.reply.noneSaved": "Saqlangan profillar hozircha yo‘q.",
    "profile.reply.chooseActive": "Faol profilni tanlang:",
    "profile.reply.chooseEdit": "O‘zgartirish uchun profilni tanlang:",
    "profile.reply.chooseDelete": "O‘chirish uchun profilni tanlang:",
    "profile.reply.deactivated": "Faol profil o‘chirildi. Soddalashtirilgan rejimda ishlashingiz yoki yangisini yaratishingiz mumkin.",
    "profile.reply.activeProfile": "Faol profil:\n{summary}",
    "profile.reply.askName": "Profil nomini kiriting (masalan: Ona).",
    "profile.reply.savedActivated": "Profil saqlandi va faollashtirildi:\n{summary}",
    "profile.reply.saveFailed": "Profilni saqlab bo‘lmadi.",
    "profile.reply.tempApplied": "Vaqtinchalik profil joriy ssenariyga qo‘llandi:\n{summary}\n\nU bazada saqlanmaydi.",
    "profile.reply.fromSafety": "Xavfsizlik profili hisobga olindi{suffix}.\nDarhol alomatni tanlashingiz mumkin.",
    "profile.reply.startCheck": "Tekshiruvni boshlash uchun «Dorini tekshirish»ni bosing.",
    "profile.error.draftRestart": "Profil qoralamasi topilmadi. Qaytadan boshlang.",
    "profile.error.draftReopen": "Profil qoralamasi topilmadi. Profil bo‘limini qayta oching.",
    "profile.error.nameTooShort": "Profil nomi juda qisqa. 2+ belgi kiriting.",
    "profile.error.ageRange": "Yosh 0 dan 100 gacha bo‘lgan son bo‘lishi kerak.",
    "profile.wizard.agePrompt": "Yoshni kiriting (0–120).",
    "profile.wizard.allergyNotes": "Allergiyani qisqacha kiriting (ortiqcha ma’lumotsiz). Masalan: ibuprofen.",
    "profile.wizard.question.allergy": "Dori allergiyasi bormi?",
    "profile.wizard.question.gi": "Oshqozon-ichak xavfi bormi (yara/qon ketishi)?",
    "profile.wizard.question.liver": "Jigar bo‘yicha sezilarli xavf bormi?",
    "profile.wizard.question.kidney": "Buyrak bo‘yicha sezilarli xavf bormi?",
    "profile.wizard.question.chronic": "Ehtiyot chorasi uchun muhim surunkali holat bormi?",
    "profile.wizard.saveQuestion": "Profilni saqlaysizmi?",
    "profile.history.empty": "Sizda hozircha tekshiruvlar yo‘q.",
    "profile.history.meds": "Dorilar: {value}",
    "profile.history.header": "📚 So‘nggi tekshiruvlaringiz:\n\n{value}",
    "profile.menu.intro.1": "Profil yosh va muhim cheklovlarni hisobga olib, mos bo‘lmagan dorilarni ko‘rsatmaslik uchun kerak.",
    "profile.menu.intro.2": "Profilni vaqtincha ishlatish yoki saqlash mumkin. Profilni istalgan vaqtda o‘chirish mumkin.",
    "profile.menu.activeTitle": "Faol profil:",
    "profile.menu.activeMissing": "Faol profil tanlanmagan.",
    "profile.menu.savedCount": "Saqlangan profillar: {count}",
    "profile.reset.message": "Holat tiklandi. Qaytadan boshlaymiz.\nBemor yoshini tanlang:",
    "profile.defaultLabel": "Profil",
    "profile.defaultLabel.temporary": "Vaqtinchalik profil",
    "profile.summary.ageKnown": "{age} yosh",
    "profile.summary.ageUnknown": "yosh ko‘rsatilmagan",
    "profile.summary.flag.pregnancy": "homiladorlik/laktatsiya",
    "profile.summary.flag.drugAllergy": "dori allergiyasi",
    "profile.summary.flag.gi": "oshqozon-ichak xavfi",
    "profile.summary.flag.liver": "jigar bo‘yicha xavf",
    "profile.summary.flag.kidney": "buyrak bo‘yicha xavf",
    "profile.summary.flag.chronic": "surunkali holat",
    "profile.summary.flag.none": "asosiy cheklovlar qayd etilmagan",
    "profile.summary.ageLine": "Yosh: {value}",
    "profile.summary.limitsLine": "Cheklovlar: {value}"
  }
};

function normalizeLocale(value?: string | null): SupportedLocale {
  return value === "uz" ? "uz" : "ru";
}

function t(locale: SupportedLocale, key: LocaleMessageKey, vars?: Record<string, string>): string {
  const template = messages[locale]?.[key] || messages.ru[key] || key;
  if (!vars) {
    return template;
  }
  return Object.entries(vars).reduce((acc, [name, value]) => acc.replace(`{${name}}`, value), template);
}

function getUserLocale(ctx: any): SupportedLocale {
  const userId = ctx?.from?.id;
  if (typeof userId !== "number") {
    return "ru";
  }
  const reminderUser = getReminderUser(userId);
  return normalizeLocale(reminderUser?.language);
}

function getNormalizedDrugQuery(drug: CatalogDrug): string {
  return normalizeDrug(drug.name) || drug.name;
}

function getArzonAptekaDrugLink(drug: CatalogDrug, locale: SupportedLocale): string {
  return getArzonAptekaSearchUrl(getNormalizedDrugQuery(drug), locale as PharmacyLocale);
}

function appendLanguageReplyButton(rows: string[][], locale: SupportedLocale): string[][] {
  return [...rows, [t(locale, "menu.language")]];
}

function appendLanguageInlineButton(rows: any[][], locale: SupportedLocale): any[][] {
  return [...rows, [Markup.button.callback(t(locale, "menu.language"), "lang_menu")]];
}

function buildMainMenu(locale: SupportedLocale = "ru") {
  return Markup.keyboard(
    [
      [t(locale, "menu.check"), t(locale, "menu.reminders")],
      [t(locale, "menu.history"), t(locale, "menu.safetyProfiles")],
      [t(locale, "menu.howTo"), t(locale, "menu.language")]
    ]
  ).resize();
}

function buildReminderMenuKeyboard(locale: SupportedLocale = "ru") {
  return Markup.inlineKeyboard(
    appendLanguageInlineButton(
      [
        [Markup.button.callback(t(locale, "reminder.menu.add"), "rem_add")],
        [
          Markup.button.callback(t(locale, "reminder.menu.active"), "rem_list"),
          Markup.button.callback(t(locale, "reminder.menu.today"), "rem_today")
        ],
        [Markup.button.callback(t(locale, "reminder.menu.history"), "rem_stats")],
        [Markup.button.callback(t(locale, "reminder.menu.profile"), "rem_profile_pick")],
        [Markup.button.callback(t(locale, "reminder.menu.settings"), "rem_settings")],
        [Markup.button.callback(t(locale, "reminder.menu.back"), "menu_main")]
      ],
      locale
    )
  );
}

function buildReminderSettingsKeyboard(locale: SupportedLocale = "ru") {
  return Markup.inlineKeyboard(
    appendLanguageInlineButton(
      [
        [
          Markup.button.callback(t(locale, "reminder.settings.notifOn"), "rem_set_notif_on"),
          Markup.button.callback(t(locale, "reminder.settings.notifOff"), "rem_set_notif_off")
        ],
        [
          Markup.button.callback(t(locale, "reminder.settings.qhOn"), "rem_set_qh_on"),
          Markup.button.callback(t(locale, "reminder.settings.qhOff"), "rem_set_qh_off")
        ],
        [Markup.button.callback(t(locale, "reminder.settings.qhTime"), "rem_set_qh_time")],
        [Markup.button.callback(t(locale, "reminder.menu.back"), "rem_menu")]
      ],
      locale
    )
  );
}

function reminderMenuText(locale: SupportedLocale): string {
  return [
    t(locale, "reminder.menu.title"),
    "",
    t(locale, "reminder.menu.description"),
    "",
    t(locale, "reminder.menu.disclaimer")
  ].join("\n");
}

function isReminderStep(step: string): boolean {
  return step.startsWith("reminder_");
}

function parseReminderTime(input: string): string | null {
  const match = input.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) {
    return null;
  }
  const h = Number.parseInt(match[1], 10);
  const m = Number.parseInt(match[2], 10);
  if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || h > 23 || m < 0 || m > 59) {
    return null;
  }
  return `${`${h}`.padStart(2, "0")}:${`${m}`.padStart(2, "0")}`;
}

function buildReminderFrequencyKeyboard(locale: SupportedLocale) {
  return Markup.inlineKeyboard([
    [Markup.button.callback(t(locale, "rem.freq.d1"), "rem_freq_d1"), Markup.button.callback(t(locale, "rem.freq.d2"), "rem_freq_d2")],
    [Markup.button.callback(t(locale, "rem.freq.d3"), "rem_freq_d3")],
    [Markup.button.callback(t(locale, "rem.freq.h8"), "rem_freq_h8"), Markup.button.callback(t(locale, "rem.freq.h12"), "rem_freq_h12")],
    [Markup.button.callback(t(locale, "rem.freq.custom"), "rem_freq_custom")],
    [Markup.button.callback(t(locale, "rem.nav.back"), "rem_back")]
  ]);
}

function buildReminderDurationKeyboard(locale: SupportedLocale) {
  return Markup.inlineKeyboard([
    [Markup.button.callback(t(locale, "rem.dur.d1"), "rem_dur_1"), Markup.button.callback(t(locale, "rem.dur.d3"), "rem_dur_3"), Markup.button.callback(t(locale, "rem.dur.d5"), "rem_dur_5")],
    [Markup.button.callback(t(locale, "rem.dur.d7"), "rem_dur_7"), Markup.button.callback(t(locale, "rem.dur.d10"), "rem_dur_10")],
    [Markup.button.callback(t(locale, "rem.dur.open"), "rem_dur_open")],
    [Markup.button.callback(t(locale, "rem.dur.custom"), "rem_dur_custom")],
    [Markup.button.callback(t(locale, "rem.nav.back"), "rem_back")]
  ]);
}

function formatReminderFrequencyLabel(locale: SupportedLocale, freq?: string): string {
  const labels: Record<string, string> = {
    daily_1: t(locale, "rem.freq.d1"),
    daily_2: t(locale, "rem.freq.d2"),
    daily_3: t(locale, "rem.freq.d3"),
    hours_8: t(locale, "rem.freq.h8"),
    hours_12: t(locale, "rem.freq.h12")
  };
  if (!freq) {
    return t(locale, "rem.value.notSpecified");
  }
  if (labels[freq]) {
    return labels[freq];
  }
  if (freq.startsWith("daily_custom_")) {
    return `${freq.replace("daily_custom_", "")}`;
  }
  return freq;
}

function buildReminderConfirmationText(locale: SupportedLocale, draft: ReminderDraft): string {
  const durationText =
    draft.data.isOpenEnded || !draft.data.durationDays
      ? t(locale, "rem.value.openEnded")
      : t(locale, "rem.value.days", { days: String(draft.data.durationDays) });
  return [
    t(locale, "rem.confirm.title"),
    "",
    t(locale, "rem.confirm.drug", { value: draft.data.drugName || "—" }),
    t(locale, "rem.confirm.dosage", { value: draft.data.dosageText || t(locale, "rem.value.notSpecified") }),
    t(locale, "rem.confirm.time", { value: draft.data.time || "—" }),
    t(locale, "rem.confirm.frequency", { value: formatReminderFrequencyLabel(locale, draft.data.frequency) }),
    t(locale, "rem.confirm.duration", { value: durationText }),
    t(locale, "rem.confirm.profile", { value: draft.data.profileLabel || t(locale, "rem.value.notSelected") }),
    t(locale, "rem.confirm.note", { value: draft.data.notes || t(locale, "rem.value.none") }),
    "",
    t(locale, "rem.confirm.info")
  ].join("\n");
}

function buildReminderSaveKeyboard(locale: SupportedLocale) {
  return Markup.inlineKeyboard([
    [Markup.button.callback(t(locale, "rem.save.save"), "rem_save"), Markup.button.callback(t(locale, "rem.save.edit"), "rem_edit")],
    [Markup.button.callback(t(locale, "rem.nav.back"), "rem_back")]
  ]);
}

function buildReminderCourseCard(locale: SupportedLocale, course: ReminderCourse): string {
  const dosage = course.dosageText || t(locale, "rem.value.dosageMissing");
  const scheduleLabel =
    course.schedule.type === "times_per_day"
      ? course.schedule.times.join(" / ")
      : t(locale, "rem.course.schedule.everyHours", { hours: String(course.schedule.intervalHours) });
  const progress = getCourseProgress(course);
  const progressText = progress.dayTotal
    ? t(locale, "rem.value.day.withTotal", { current: String(progress.dayCurrent), total: String(progress.dayTotal) })
    : t(locale, "rem.value.day.single", { current: String(progress.dayCurrent) });
  return [
    `💊 ${course.drug.rawName}`,
    dosage,
    scheduleLabel,
    progressText,
    course.notes ? t(locale, "rem.confirm.note", { value: course.notes }) : "",
    t(locale, "rem.course.label.status", { value: course.status === "active" ? t(locale, "rem.value.status.active") : course.status })
  ]
    .filter(Boolean)
    .join("\n");
}

function parseQuietHoursRange(input: string): { start: string; end: string } | null {
  const normalized = input.replace(/\s+/g, "");
  const parts = normalized.split("-");
  if (parts.length !== 2) {
    return null;
  }
  const left = parseReminderTime(parts[0]);
  const right = parseReminderTime(parts[1]);
  if (!left || !right) {
    return null;
  }
  return { start: left, end: right };
}

function detectReminderInteractionRisk(userId: number, drugName: string): { risky: boolean; summary: string } {
  const activeCourses = listReminderCourses(userId, ["active"]);
  if (activeCourses.length === 0) {
    return { risky: false, summary: "" };
  }
  const names = [drugName, ...activeCourses.map((course) => course.drug.rawName)];
  const meds = dedupeMedicationsForAnalysis(parseCatalogMedications(names.join(", ")), {
    userId,
    chatId: null,
    analysisPath: "reminder_interaction_check",
    currentStep: "reminder_confirm"
  });
  if (meds.length < 2) {
    return { risky: false, summary: "" };
  }
  const analysis = analyzeMedications(meds);
  if (analysis.status === "safe") {
    return { risky: false, summary: "" };
  }
  return {
    risky: true,
    summary: analysis.summary || t("ru", "analysis.engine.fallback.summary")
  };
}

function formatProfileSummary(profile: SafetyProfile, active = false, locale: SupportedLocale = "ru"): string {
  const ageText =
    profile.ageKnown && profile.ageYears !== null
      ? t(locale, "profile.summary.ageKnown", { age: String(profile.ageYears) })
      : t(locale, "profile.summary.ageUnknown");
  const flags: string[] = [];
  if (profile.pregnancyOrLactation) flags.push(t(locale, "profile.summary.flag.pregnancy"));
  if (profile.hasDrugAllergy) flags.push(t(locale, "profile.summary.flag.drugAllergy"));
  if (profile.hasGiRisk) flags.push(t(locale, "profile.summary.flag.gi"));
  if (profile.hasLiverRisk) flags.push(t(locale, "profile.summary.flag.liver"));
  if (profile.hasKidneyRisk) flags.push(t(locale, "profile.summary.flag.kidney"));
  if (profile.hasChronicCondition) flags.push(t(locale, "profile.summary.flag.chronic"));
  const flagsText = flags.length > 0 ? flags.join(", ") : t(locale, "profile.summary.flag.none");
  return `${active ? "✅ " : ""}${profile.label}\n${t(locale, "profile.summary.ageLine", { value: ageText })}\n${t(locale, "profile.summary.limitsLine", { value: flagsText })}`;
}

function buildSafetyProfilesMenuKeyboard(locale: SupportedLocale = "ru") {
  return Markup.inlineKeyboard([
    [Markup.button.callback(t(locale, "profile.menu.create"), "profile_create_start")],
    [Markup.button.callback(t(locale, "profile.menu.temp"), "profile_temp_start")],
    [Markup.button.callback(t(locale, "profile.menu.select"), "profile_select_list"), Markup.button.callback(t(locale, "profile.menu.edit"), "profile_edit_list")],
    [Markup.button.callback(t(locale, "profile.menu.delete"), "profile_delete_list"), Markup.button.callback(t(locale, "profile.menu.deactivate"), "profile_deactivate")],
    [Markup.button.callback(t(locale, "profile.menu.back"), "profile_back_main")]
  ]);
}

function buildProfilesListKeyboard(
  prefix: "profile_select" | "profile_edit" | "profile_delete",
  profiles: SafetyProfile[],
  locale: SupportedLocale = "ru"
) {
  const rows = profiles.map((profile) => [Markup.button.callback(profile.label, `${prefix}_${profile.profileId}`)]);
  return Markup.inlineKeyboard([...rows, [Markup.button.callback(t(locale, "profile.menu.back"), "profile_menu")]]);
}

function buildProfileRoleKeyboard(mode: "create" | "temporary" | "edit", locale: SupportedLocale = "ru") {
  const base = mode === "edit" ? "profile_wizard_edit_role" : mode === "temporary" ? "profile_wizard_temp_role" : "profile_wizard_role";
  return Markup.inlineKeyboard([
    [Markup.button.callback(t(locale, "profile.role.self"), `${base}_self`)],
    [Markup.button.callback(t(locale, "profile.role.child"), `${base}_child`)],
    [Markup.button.callback(t(locale, "profile.role.family"), `${base}_family`)],
    [Markup.button.callback(t(locale, "profile.role.manual"), `${base}_manual`)],
    [Markup.button.callback(t(locale, "profile.menu.back"), "profile_menu")]
  ]);
}

function buildBooleanQuestionKeyboard(
  field: "pregnancy" | "allergy" | "gi" | "liver" | "kidney" | "chronic",
  locale: SupportedLocale = "ru"
) {
  return Markup.inlineKeyboard([
    [Markup.button.callback(t(locale, "profile.bool.yes"), `profile_wizard_${field}_yes`), Markup.button.callback(t(locale, "profile.bool.no"), `profile_wizard_${field}_no`)]
  ]);
}

function getProfileWizard(userId: number): ProfileWizardDraft | null {
  return profileWizardMap.get(userId) || null;
}

function saveTemporaryProfile(userId: number, draft: ProfileWizardDraft, locale: SupportedLocale = "ru"): SafetyProfile {
  const now = Date.now();
  const profile: SafetyProfile = {
    profileId: `tmp_${userId}_${now}`,
    userId,
    label: draft.label || t(locale, "profile.defaultLabel.temporary"),
    ageYears: draft.ageYears,
    ageKnown: typeof draft.ageYears === "number",
    pregnancyOrLactation: draft.pregnancyOrLactation,
    hasDrugAllergy: draft.hasDrugAllergy,
    drugAllergyNotes: draft.drugAllergyNotes,
    hasGiRisk: draft.hasGiRisk,
    hasLiverRisk: draft.hasLiverRisk,
    hasKidneyRisk: draft.hasKidneyRisk,
    hasChronicCondition: draft.hasChronicCondition,
    notes: draft.notes,
    createdAt: now,
    updatedAt: now
  };
  temporaryProfileMap.set(userId, profile);
  return profile;
}

async function showAgeStep(
  ctx: any,
  userId: number,
  text?: string
): Promise<void> {
  const locale = getUserLocale(ctx);
  stepMap.set(userId, "age_choice");
  touchSessionState(userId);
  logEvent("flow_restarted", { userId, chatId: ctx.chat?.id ?? null, currentStep: "age_choice" });
  await ctx.reply(text || t(locale, "wizard.prompt.age"), buildAgeKeyboard(locale));
}

async function showSymptomCategoryStep(ctx: any, userId: number): Promise<void> {
  const locale = getUserLocale(ctx);
  stepMap.set(userId, "symptoms_category");
  touchSessionState(userId);
  logEvent("symptom_step_opened", { userId, chatId: ctx.chat?.id ?? null, currentStep: "symptoms_category" });
  await ctx.reply(t(locale, "wizard.prompt.category"), buildSymptomCategoryKeyboard(locale));
}

async function showReminderMenu(ctx: any, userId: number): Promise<void> {
  const locale = getUserLocale(ctx);
  upsertReminderUser({
    userId,
    firstName: ctx.from?.first_name,
    username: ctx.from?.username,
    language: locale
  });
  stepMap.set(userId, "reminder_menu");
  touchSessionState(userId);
  await ctx.reply(`${reminderMenuText(locale)}\n\n${t(locale, "rem.menu.chooseAction")}`, buildReminderMenuKeyboard(locale));
}

async function startReminderWizard(ctx: any, userId: number): Promise<void> {
  const locale = getUserLocale(ctx);
  const hasAck = hasReminderLegalAck(userId);
  if (!hasAck) {
    stepMap.set(userId, "reminder_legal_ack");
    touchSessionState(userId);
    await ctx.reply(t(locale, "rem.legal.text"), Markup.inlineKeyboard([[Markup.button.callback(t(locale, "rem.legal.ok"), "rem_legal_ok")], [Markup.button.callback(t(locale, "rem.nav.back"), "rem_back")]]));
    return;
  }

  const activeProfile = getActiveSafetyProfile(userId);
  saveReminderDraft({
    userId,
    step: "reminder_drug_name",
    mode: "quick",
    data: {
      profileLabel: activeProfile?.label || null
    },
    updatedAt: new Date().toISOString()
  });
  stepMap.set(userId, "reminder_drug_name");
  touchSessionState(userId);
  await ctx.reply(t(locale, "rem.start.enterDrug"));
}

async function showReminderCourses(ctx: any, userId: number): Promise<void> {
  const locale = getUserLocale(ctx);
  const courses = listReminderCourses(userId, ["active", "paused"]);
  if (courses.length === 0) {
    await ctx.reply(t(locale, "rem.courses.empty"), buildReminderMenuKeyboard(locale));
    return;
  }
  await ctx.reply(`${t(locale, "rem.courses.title")}\n\n${t(locale, "rem.courses.subtitle")}`);
  for (const course of courses.slice(0, 10)) {
    await ctx.reply(
      buildReminderCourseCard(locale, course),
      Markup.inlineKeyboard([
        [
          Markup.button.callback(t(locale, "rem.course.open"), `rem_open_${course.id}`),
          Markup.button.callback(t(locale, "rem.course.pause"), `rem_pause_${course.id}`)
        ],
        [Markup.button.callback(t(locale, "rem.course.finish"), `rem_finish_${course.id}`)]
      ])
    );
  }
}

async function showReminderCourseDetail(ctx: any, userId: number, courseId: string): Promise<void> {
  const locale = getUserLocale(ctx);
  const course = getReminderCourse(userId, courseId);
  if (!course) {
    await ctx.reply(t(locale, "rem.course.notFound"));
    return;
  }
  const progress = getCourseProgress(course);
  const scheduleLabel =
    course.schedule.type === "times_per_day"
      ? course.schedule.times.join(" / ")
      : t(locale, "rem.course.schedule.everyHours", { hours: String(course.schedule.intervalHours) });
  const durationLabel =
    course.course.isOpenEnded || !course.course.durationDays
      ? t(locale, "rem.course.duration.label.open")
      : t(locale, "rem.course.duration.label.days", { days: String(course.course.durationDays) });
  const progressLabel = progress.dayTotal
    ? t(locale, "rem.course.progress.withTotal", { current: String(progress.dayCurrent), total: String(progress.dayTotal) })
    : t(locale, "rem.course.progress.dayOnly", { current: String(progress.dayCurrent) });
  const latest = listCourseOccurrences(userId, courseId, 5);
  const latestText =
    latest.length === 0
      ? t(locale, "rem.course.latest.none")
      : latest
          .map((item) => {
            const statusMap: Record<string, string> = {
              scheduled: t(locale, "rem.value.status.scheduled"),
              sent: t(locale, "rem.value.status.sent"),
              taken: t(locale, "rem.value.status.taken"),
              skipped: t(locale, "rem.value.status.skipped"),
              snoozed: t(locale, "rem.value.status.snoozed"),
              missed: t(locale, "rem.value.status.missed")
            };
            return `• ${item.localTime} — ${statusMap[item.status] || item.status}`;
          })
          .join("\n");

  await ctx.reply(
    [
      `💊 ${course.drug.rawName}`,
      "",
      t(locale, "rem.course.label.dosage", { value: course.dosageText || t(locale, "rem.value.notSpecified") }),
      t(locale, "rem.course.label.schedule", { value: scheduleLabel }),
      t(locale, "rem.course.label.duration", { value: durationLabel }),
      t(locale, "rem.course.label.progress", { value: progressLabel }),
      t(locale, "rem.course.label.profile", { value: course.notes || t(locale, "rem.value.notSpecified") }),
      "",
      t(locale, "rem.course.latest.title"),
      latestText,
      "",
      t(locale, "rem.course.info")
    ].join("\n"),
    Markup.inlineKeyboard([
      [Markup.button.callback(t(locale, "rem.course.btn.marknow"), `rem_marknow_${course.id}`)],
      [Markup.button.callback(t(locale, "rem.course.btn.edit"), `rem_edit_${course.id}`), Markup.button.callback(t(locale, "rem.course.btn.pause"), `rem_pause_${course.id}`)],
      [Markup.button.callback(t(locale, "rem.course.btn.delete"), `rem_delete_${course.id}`)],
      [Markup.button.callback(t(locale, "rem.course.btn.check"), `rem_check_${course.id}`)],
      [Markup.button.callback(t(locale, "rem.course.btn.back"), "rem_list")]
    ])
  );
}

function findMatches(query: string): string[] {
  const cleaned = query.toLowerCase().trim();
  if (!cleaned) {
    return MEDS.slice(0, 5);
  }

  const direct = MEDS.filter((item) => item.toLowerCase().includes(cleaned));
  const canonical = normalizeDrug(cleaned);
  if (canonical && !direct.some((x) => x.toLowerCase() === canonical.toLowerCase())) {
    direct.push(canonical);
  }

  return Array.from(new Set(direct)).slice(0, 5);
}

function findSymptomMatchesLegacy(symptomInput: string, limit = 5): CatalogDrug[] {
  const normalized = normalizeSymptomText(symptomInput);
  const matches: Array<{ drug: CatalogDrug; score: number }> = [];

  for (const drug of DRUGS) {
    const symptomTerms = [
      ...drug.symptoms,
      ...drug.symptomTags,
      ...(drug.category ? [drug.category] : []),
      ...drug.synonyms
    ]
      .map((term) => cleanAndDecode(term))
      .filter(Boolean);

    if (symptomTerms.length === 0) {
      continue;
    }

    let bestScore = 0;
    for (const term of symptomTerms) {
      const normalizedTerm = normalizeSymptomText(term);
      if (!normalizedTerm) {
        continue;
      }

      if (normalizedTerm === normalized) {
        bestScore = Math.max(bestScore, 1);
      } else if (normalizedTerm.includes(normalized) || normalized.includes(normalizedTerm)) {
        bestScore = Math.max(bestScore, 0.84);
      } else if (normalizeMedicationQuery(term).includes(normalizeMedicationQuery(symptomInput))) {
        bestScore = Math.max(bestScore, 0.72);
      }
    }

    if (bestScore > 0) {
      matches.push({ drug, score: bestScore });
    }
  }

  return matches
    .sort((a, b) => b.score - a.score || a.drug.name.localeCompare(b.drug.name, "ru"))
    .map((item) => item.drug)
    .slice(0, limit);
}

function getGoldenSymptomMatches(
  symptomInput: string,
  context: ReturnType<typeof resolvePatientContext>,
  limit = 5
) {
  return routeByGoldenSymptom({
    symptomInput,
    ageYears: context.ageYears,
    patientContext: context,
    catalog: DRUGS.map((drug) => ({ id: drug.id, name: drug.name })),
    limit
  });
}

async function showDrugSuggestionsBySymptom(
  ctx: any,
  userId: number,
  symptomInput: string
): Promise<"emergency_blocked" | "fallback" | "suggestions"> {
  const locale = getUserLocale(ctx);
  const draft = draftMap.get(userId) || {};
  draft.symptoms = symptomInput.trim();
  draftMap.set(userId, draft);

  const activeProfile = getActiveSafetyProfile(userId);
  const temporaryProfile = temporaryProfileMap.get(userId) || null;
  const patientContext = resolvePatientContext({
    activeProfile,
    temporaryProfile,
    draftAgeRaw: draft.age
  });
  logEvent("patient_context_applied", {
    userId,
    chatId: ctx.chat?.id ?? null,
    ...redactPatientContextForLog(patientContext)
  });

  const ageYears = patientContext.ageYears;
  logEvent("emergency_check_started", {
    userId,
    chatId: ctx.chat?.id ?? null,
    currentStep: "symptom_emergency_gate",
    input_symptom: symptomInput.trim(),
    age_years: ageYears
  });
  const emergency = detectEmergencyRedFlags({
    symptomInput,
    ageYears
  });
  logEvent("emergency_rules_count", {
    userId,
    chatId: ctx.chat?.id ?? null,
    input_symptom: symptomInput.trim(),
    emergency_rules_count: emergency.matchedRules.length,
    emergency_highest_severity: emergency.highestSeverity,
    emergency_blocked_medication_suggestions: emergency.blockMedicationSuggestions
  });
  if (emergency.matchedRules.length > 0) {
    for (const rule of emergency.matchedRules.slice(0, 5)) {
      logEvent("emergency_rule_matched", {
        userId,
        chatId: ctx.chat?.id ?? null,
        input_symptom: symptomInput.trim(),
        rule_id: rule.id,
        rule_label: rule.label,
        rule_severity: rule.severity,
        recommended_action: rule.recommendedAction
      });
    }
  }
  if (emergency.blockMedicationSuggestions) {
    stepMap.set(userId, "symptoms_manual");
    const actionTextMap: Record<string, string> = {
      seek_doctor: t(locale, "wizard.emergency.seekDoctor"),
      seek_urgent_care: t(locale, "wizard.emergency.seekUrgent"),
      call_emergency: t(locale, "wizard.emergency.callEmergency")
    };
    const actionText = emergency.recommendedAction
      ? actionTextMap[emergency.recommendedAction] || t(locale, "wizard.emergency.defaultAction")
      : t(locale, "wizard.emergency.defaultAction");
    await ctx.reply(
      t(locale, "wizard.emergency.blockedTemplate", {
        message: emergency.userFacingMessage || "",
        action: actionText
      }),
      Markup.inlineKeyboard([[Markup.button.callback(t(locale, "wizard.nav.back"), "symcat_back")]])
    );
    return "emergency_blocked";
  }

  const symptomNormalized = normalizeSymptomText(symptomInput);
  const routed = getGoldenSymptomMatches(symptomInput, patientContext, 5);
  const symptomMatches = routed.status === "ok" ? routed.drugs.map((candidate) => DRUGS.find((drug) => drug.id === candidate.id)).filter(Boolean) as CatalogDrug[] : [];
  const suggestedNames = symptomMatches.map((item) => item.name);
  if (draft.appendMode) {
    logEvent("symptom_matches_from_append", {
      userId,
      chatId: ctx.chat?.id ?? null,
      append_mode: true,
      matches_count: symptomMatches.length,
      suggested_names: suggestedNames
    });
  }
  logEvent(routed.status === "ok" ? "symptom_matches_found" : "symptom_matches_empty", {
    userId,
    chatId: ctx.chat?.id ?? null,
    currentStep: "medications",
    rawInput: symptomInput.trim(),
    normalizedInput: symptomNormalized,
    input_symptom: routed.debug.input_symptom,
    matched_symptom_id: routed.debug.matched_symptom_id,
    matched_alias: routed.debug.matched_alias,
    quality_status: routed.debug.quality_status,
    safety_layer_checked: routed.debug.safety_layer_checked,
    safety_profile_found: routed.debug.safety_profile_found,
    hard_stop_excluded_count: routed.debug.hard_stop_excluded_count,
    caution_attached_count: routed.debug.caution_attached_count,
    missing_safety_profile_count: routed.debug.missing_safety_profile_count,
    context_hard_stop_excluded_count: routed.debug.context_hard_stop_excluded_count,
    context_caution_attached_count: routed.debug.context_caution_attached_count,
    age_filtered_count: routed.debug.age_filtered_count,
    primary_output_count: routed.debug.primary_output_count,
    fallback_reason: routed.debug.fallback_reason,
    resultSummary: {
      matchesCount: symptomMatches.length,
      suggestedNames
    },
    draftSnapshot: getDraftSnapshot(userId)
  });

  if (routed.status !== "ok" || symptomMatches.length === 0) {
    const fallbackMessageByReason: Record<string, string> = {
      unsafe_symptom_quality: t(locale, "wizard.prompt.fallback.unsafeSymptomQuality"),
      age_not_provided: t(locale, "wizard.prompt.fallback.ageNotProvided"),
      no_age_eligible_primary: t(locale, "wizard.prompt.fallback.noAgeEligible"),
      no_primary_candidates: t(locale, "wizard.prompt.fallback.noPrimaryCandidates"),
      missing_safety_profile_all: t(locale, "wizard.prompt.fallback.missingSafetyProfile"),
      safety_hard_stop_excluded_all: t(locale, "wizard.prompt.fallback.safetyHardStop"),
      primary_drugs_missing_in_runtime_catalog: t(locale, "wizard.prompt.fallback.missingRuntimeCatalog"),
      symptom_not_in_golden_map: t(locale, "wizard.prompt.fallback.symptomNotInMap")
    };
    const fallbackMessage =
      fallbackMessageByReason[routed.fallbackReason || ""] ||
      t(locale, "wizard.prompt.fallback.default");
    stepMap.set(userId, "symptoms_manual");
    await ctx.reply(
      fallbackMessage,
      Markup.inlineKeyboard([[Markup.button.callback(t(locale, "wizard.nav.back"), "symcat_back")]])
    );
    return "fallback";
  }

  stepMap.set(userId, "medications");
  const profileHint =
    patientContext.source === "active_profile" || patientContext.source === "temporary_profile"
      ? t(locale, "wizard.prompt.profileHint", { label: patientContext.profileLabel || "—" })
      : "";
  await ctx.reply(
    t(locale, "wizard.prompt.referenceList", { profileHint }),
    Markup.inlineKeyboard([
      ...symptomMatches.map((drug) => [Markup.button.callback(formatDrugLabel(drug, locale), `drug_select_${drug.id}`)]),
      [Markup.button.callback(t(locale, "wizard.symptom.manual"), "manual_drug_input")],
      [Markup.button.callback(t(locale, "wizard.nav.back"), "symcat_back")]
    ])
  );
  logEvent("drug_suggestion_shown", {
    userId,
    chatId: ctx.chat?.id ?? null,
    currentStep: "medications",
    resultSummary: { suggestedNames }
  });
  for (const drug of symptomMatches) {
    logEvent("preview_debug_field", {
      userId,
      chatId: ctx.chat?.id ?? null,
      selectedDrugId: drug.id,
      sourceFieldName: drug.sourceNameField || "unknown",
      rawFieldValue: drug.sourceNameRaw || "",
      cleanedValue: drug.name
    });
  }
  return "suggestions";
}

function normalizeAge(input: string): string | null {
  const trimmed = input.trim().toLowerCase();
  const match = trimmed.match(/\d{1,3}/);
  if (!match) {
    return null;
  }
  const numeric = Number.parseInt(match[0], 10);
  if (!Number.isInteger(numeric) || numeric < 0 || numeric > 100) {
    return null;
  }
  return numeric.toString();
}

function parseAgeChoiceInput(input: string): string | null {
  const normalized = input.trim().toLowerCase().replace(/\s+/g, "");
  const bucketAliases: Record<string, string> = {
    "0-5": "0-5",
    "0–5": "0-5",
    "5-10": "5-10",
    "5–10": "5-10",
    "10-15": "10-15",
    "10–15": "10-15",
    "15-60": "15-60",
    "15–60": "15-60",
    "60+": "60+",
    "60plus": "60+",
    "60плюс": "60+"
  };
  if (bucketAliases[normalized]) {
    return bucketAliases[normalized];
  }
  return normalizeAge(input);
}

function parseAgeYears(ageRaw?: string): number | null {
  if (!ageRaw) {
    return null;
  }
  const match = ageRaw.match(/\d+/);
  if (!match) {
    return null;
  }
  const value = Number.parseInt(match[0], 10);
  return Number.isInteger(value) ? value : null;
}

function isPediatricHighRisk(ageRaw?: string): boolean {
  const age = parseAgeYears(ageRaw);
  return typeof age === "number" && age >= 0 && age <= 2;
}

function hasIbuprofenParacetamolCombo(meds: Medication[]): boolean {
  const slugs = meds.map((m) => (m.slug || "").toLowerCase());
  const names = meds
    .flatMap((m) => [m.name, m.generic, ...(m.synonyms || [])])
    .map((x) => String(x || "").toLowerCase());

  const hasIbu =
    slugs.some((s) => s.includes("ibuprofen")) ||
    names.some((n) => n.includes("ибупрофен") || n.includes("нурофен") || n.includes("ibuprofen"));
  const hasPara =
    slugs.some((s) => s.includes("paracetamol")) ||
    names.some((n) => n.includes("парацетамол") || n.includes("панадол") || n.includes("paracetamol"));

  return hasIbu && hasPara;
}

function applyMedicalSafetyOverrides(
  analysis: AnalysisResult,
  opts: { pediatricHighRisk: boolean; pediatricComboRisk: boolean; uncertainMatch: boolean }
): AnalysisResult {
  const overrideReasons: string[] = [];
  let nextStatus = analysis.status;

  if (opts.pediatricHighRisk) {
    overrideReasons.push("возраст 0–2 года");
    if (nextStatus === "safe") {
      nextStatus = "caution";
    }
  }

  if (opts.pediatricComboRisk) {
    overrideReasons.push("сочетание ибупрофен + парацетамол у ребёнка");
    if (nextStatus === "safe") {
      nextStatus = "caution";
    }
  }

  if (opts.uncertainMatch) {
    overrideReasons.push("препарат распознан не по точному локальному совпадению");
    if (nextStatus === "safe") {
      nextStatus = "caution";
    }
  }

  if (nextStatus === analysis.status) {
    return analysis;
  }

  const overrideText =
    overrideReasons.length > 0
      ? `Статус осторожности повышен автоматически: ${overrideReasons.join("; ")}.`
      : "Статус осторожности повышен автоматически.";

  return {
    ...analysis,
    status: nextStatus,
    riskScore: Math.max(analysis.riskScore, 5),
    summary: overrideText,
    explanation: `${analysis.explanation} ${overrideText}`.trim()
  };
}

function isValidSymptoms(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 3) {
    return false;
  }

  const letters = trimmed.toLowerCase().match(/\p{L}/gu) || [];
  if (letters.length < 3) {
    return false;
  }

  const uniqueLetters = new Set(letters);
  if (uniqueLetters.size <= 1) {
    return false;
  }

  const meaningfulRatio = letters.length / Math.max(trimmed.length, 1);
  return meaningfulRatio >= 0.35;
}

function sanitizeMedicationInput(input: string): string {
  const parts = input
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => x.toLowerCase())
    .map((x) => MEDICATION_NORMALIZATION[x] ?? x);

  const unique = Array.from(new Set(parts));
  return unique.join(", ");
}

function hasMeaningfulMedicationChunks(input: string): boolean {
  const parts = input
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

  if (parts.length === 0) {
    return false;
  }

  return parts.some((part) => {
    const letters = part.match(/\p{L}/gu) || [];
    return letters.length >= 3;
  });
}

function isMedicationListSubmitCommand(input: string): boolean {
  const normalized = input
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");

  if (!normalized) {
    return false;
  }

  if (
    normalized === "готово" ||
    normalized === "проверить" ||
    normalized === "отправить" ||
    normalized === "check" ||
    normalized === "done"
  ) {
    return true;
  }

  return /^\d+\s*(препарат|препарата|препаратов|лекарство|лекарства|лекарств)$/i.test(normalized);
}

function normalizeDoseUnit(unitRaw?: string): "мг" | "мл" | "unknown" {
  if (!unitRaw) {
    return "unknown";
  }
  const lowered = unitRaw.toLowerCase();
  if (lowered === "мг" || lowered === "mg") {
    return "мг";
  }
  if (lowered === "мл" || lowered === "ml") {
    return "мл";
  }
  return "unknown";
}

function formatMedicationEntry(entry: MedicationEntry): string {
  const dosageText = entry.dosageNormalized || (typeof entry.dose === "number" ? `${entry.dose} ${entry.unit || "мг"}` : "");
  return dosageText ? `${entry.name} (${dosageText})` : entry.name;
}

function normalizeDrug(input: string): string | null {
  return resolveDrug(input).catalog?.name || null;
}

function resolveDrug(input: string): ResolvedDrug {
  const cleaned = normalizeMedicationQuery(input);
  if (!cleaned) {
    return { catalog: null, primary: null, normalizedKey: null };
  }

  const byName = DRUGS.find((drug) => normalizeMedicationQuery(drug.name) === cleaned) || null;
  const bySynonym =
    byName ||
    DRUGS.find((drug) => drug.synonyms.some((synonym) => normalizeMedicationQuery(synonym) === cleaned)) ||
    null;
  const byId = bySynonym || DRUGS.find((drug) => normalizeMedicationQuery(drug.id) === cleaned) || null;
  const catalog = byId;

  const primary =
    PRIMARY_DRUG_INDEX.byId.get(cleaned) ||
    PRIMARY_DRUG_INDEX.byTerm.get(cleaned) ||
    (catalog
      ? PRIMARY_DRUG_INDEX.byId.get(normalizeMedicationQuery(catalog.id)) ||
        PRIMARY_DRUG_INDEX.byTerm.get(normalizeMedicationQuery(catalog.name))
      : null) ||
    null;

  return {
    catalog,
    primary,
    normalizedKey: cleaned
  };
}

function isCanonicalDrug(input: string): boolean {
  const cleaned = normalizeMedicationQuery(input);
  return DRUGS.some((d) => normalizeMedicationQuery(d.name) === cleaned);
}

function isSynonymDrug(input: string): boolean {
  const cleaned = normalizeMedicationQuery(input);
  const canonical = normalizeDrug(cleaned);
  return Boolean(canonical && normalizeMedicationQuery(canonical) !== cleaned);
}

function parseMultiMedications(input: string): MedicationEntry[] {
  const parts = input
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

  const result: MedicationEntry[] = [];

  for (const part of parts) {
    console.info("dosage_parse_input:", part);
    const parsed = extractDosage(part);
    const cleanedName = parsed.cleanedQuery.trim();
    console.info("dosage_parse_found:", Boolean(parsed.dosage));
    console.info("dosage_parse_raw:", parsed.dosage?.raw ?? null);
    console.info("dosage_parse_normalized:", parsed.dosage?.normalized ?? null);
    console.info("dosage_cleaned_query:", cleanedName || null);

    const normalizedName = normalizeDrug(cleanedName) || (cleanedName ? normalizeDrug(cleanedName.toLowerCase()) : null);
    const finalName = normalizedName || cleanedName;
    if (!finalName) {
      continue;
    }

    result.push({
      name: finalName,
      ...(parsed.dosage?.raw ? { dosageRaw: parsed.dosage.raw } : {}),
      ...(parsed.dosage?.normalized ? { dosageNormalized: parsed.dosage.normalized } : {})
    });
  }

  return result;
}

function parseCatalogMedications(input: string): Medication[] {
  const parts = input
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

  const found: Medication[] = [];
  const addedKeys = new Set<string>();
  for (const part of parts) {
    const resolved = resolveDrug(part);
    if (!resolved.catalog) {
      continue;
    }
    const key = normalizeMedicationQuery(resolved.catalog.id || resolved.catalog.name);
    if (!key || addedKeys.has(key)) {
      continue;
    }
    addedKeys.add(key);

    found.push({
      id: `p_${resolved.catalog.id}`,
      slug: resolved.catalog.id,
      name: resolved.catalog.name,
      generic: resolved.catalog.name,
      category: resolved.catalog.category || "Прочее",
      role: "справочное сопоставление",
      synonyms: resolved.catalog.synonyms
    });
  }

  return found;
}

function mergeMedicationCandidates(...groups: Medication[][]): Medication[] {
  const byKey = new Map<string, Medication>();
  for (const group of groups) {
    for (const med of group) {
      const key = normalizeMedicationQuery(med.slug || med.name || med.id || "");
      if (!key) {
        continue;
      }
      if (!byKey.has(key)) {
        byKey.set(key, med);
      }
    }
  }
  return Array.from(byKey.values());
}

function resolveCatalogDrugForMedication(med: Medication): CatalogDrug | null {
  const candidates = [
    med.slug,
    med.id.startsWith("p_") ? med.id.slice(2) : med.id,
    med.name,
    med.generic,
    ...(med.synonyms || [])
  ]
    .map((value) => normalizeMedicationQuery(String(value || "")))
    .filter(Boolean);

  for (const candidate of candidates) {
    const resolved = resolveDrug(candidate);
    if (resolved.catalog) {
      return resolved.catalog;
    }
  }

  return null;
}

function buildMedicationDedupeKey(med: Medication): string {
  const catalogMatch = resolveCatalogDrugForMedication(med);
  if (catalogMatch) {
    return `id:${catalogMatch.id}`;
  }
  const normalizedName = normalizeMedicationQuery(normalizeDrug(med.name || "") || med.name || "");
  if (normalizedName) {
    return `name:${normalizedName}`;
  }
  const fallback = normalizeMedicationQuery(med.slug || med.id || med.generic || "");
  return fallback ? `name:${fallback}` : "";
}

function dedupeMedicationsForAnalysis(
  meds: Medication[],
  options: { userId: number; chatId: number | null; analysisPath: string; currentStep: string }
): Medication[] {
  logEvent("medications_before_dedupe", {
    userId: options.userId,
    chatId: options.chatId,
    currentStep: options.currentStep,
    analysis_path: options.analysisPath,
    medications_before_dedupe: meds.map((med) => med.name)
  });

  const byKey = new Map<string, Medication>();
  const dedupeKeys: string[] = [];
  for (const med of meds) {
    const key = buildMedicationDedupeKey(med);
    if (!key) {
      continue;
    }
    dedupeKeys.push(key);
    if (!byKey.has(key)) {
      byKey.set(key, med);
    }
  }

  const deduped = Array.from(byKey.values());
  logEvent("dedupe_keys", {
    userId: options.userId,
    chatId: options.chatId,
    currentStep: options.currentStep,
    analysis_path: options.analysisPath,
    dedupe_keys: dedupeKeys
  });
  logEvent("medications_after_dedupe", {
    userId: options.userId,
    chatId: options.chatId,
    currentStep: options.currentStep,
    analysis_path: options.analysisPath,
    medications_after_dedupe: deduped.map((med) => med.name)
  });
  return deduped;
}

function dedupeMedicationEntries(entries: MedicationEntry[]): MedicationEntry[] {
  const byKey = new Map<string, MedicationEntry>();
  for (const entry of entries) {
    const normalized = normalizeMedicationQuery(normalizeDrug(entry.name) || entry.name);
    if (!normalized) {
      continue;
    }
    if (!byKey.has(normalized)) {
      byKey.set(normalized, entry);
    }
  }
  return Array.from(byKey.values());
}

const ANALYSIS_TEXT_TRANSLATIONS_UZ: Record<string, string> = {
  "Вероятное дублирование амоксициллина в комбинации.": "Kombinatsiyada amoksitsillin takrorlanishi ehtimoli bor.",
  "Амоксиклав уже содержит амоксициллин. Такая комбинация допустима только по прямому назначению врача.":
    "Amoksiklav tarkibida allaqachon amoksitsillin bor. Bunday kombinatsiya faqat shifokor tavsiyasi bilan mumkin.",
  "Амоксиклав + амоксициллин: риск дублирования действующего вещества.":
    "Amoksiklav + amoksitsillin: faol modda takrorlanishi xavfi.",
  "Нужно ли оставлять оба препарата одновременно?": "Ikkala dorini bir vaqtda qoldirish kerakmi?",
  "Обнаружено перекрытие антигистаминных препаратов.": "Antigistamin dorilar orasida ustma-ustlik aniqlandi.",
  "Два антигистаминных препарата обычно не требуют одновременного применения без явного обоснования.":
    "Ikki antigistamin dorini birga qo‘llash odatda aniq asos bo‘lmaganda talab etilmaydi.",
  "Цетиризин + лоратадин: препараты одного класса, проверьте схему у врача.":
    "Tsetirizin + loratadin: bir sinf dorilari, sxemani shifokor bilan tekshiring.",
  "сонливость": "uyquchanlik",
  "сухость во рту": "og‘iz qurishi",
  "Нужно ли принимать оба антигистаминных препарата в один период?":
    "Ikkala antigistamin dorini bir davrda qabul qilish kerakmi?",
  "Комбинация возможна только по понятной схеме для конкретного возраста.":
    "Kombinatsiya faqat aniq yosh uchun tushunarli sxema bilan qo‘llanadi.",
  "Препараты не дублируют действующее вещество, но требуют чёткой схемы и контроля дозировок.":
    "Dorilar faol moddani takrorlamaydi, ammo aniq sxema va doza nazoratini talab qiladi.",
  "Парацетамол и ибупрофен действуют по-разному; важны интервалы и возрастные ограничения.":
    "Paratsetamol va ibuprofen turlicha ta’sir qiladi; interval va yosh cheklovlari muhim.",
  "боль в животе": "qorin og‘rig‘i",
  "тошнота": "ko‘ngil aynishi",
  "Какой безопасный интервал между приёмами для вашего возраста?":
    "Yoshingiz uchun qabul oralig‘idagi xavfsiz interval qanday?",
  "Найдена типичная комбинация с разными ролями препаратов.":
    "Dorilar rollari turlicha bo‘lgan odatiy kombinatsiya topildi.",
  "Сальбутамол и будесонид обычно используются для разных задач: быстрое снятие спазма и контроль воспаления.":
    "Salbutamol va budesonid odatda turli vazifalar uchun qo‘llanadi: spazmni tez kamaytirish va yallig‘lanishni nazorat qilish.",
  "Сальбутамол + будесонид: разные механизмы, не прямое дублирование.":
    "Salbutamol + budesonid: mexanizmlar turli, to‘g‘ridan-to‘g‘ri takrorlanish emas.",
  "Есть сочетание антибиотиков, которое требует обязательного уточнения.":
    "Antibiotiklar kombinatsiyasi aniqlandi, uni albatta aniqlashtirish kerak.",
  "В списке обнаружено два антибактериальных препарата. Такие схемы иногда используются врачом осознанно, но родителю важно дополнительно уточнить логику назначения.":
    "Ro‘yxatda ikkita antibakterial dori bor. Bunday sxema ba’zan shifokor tomonidan qo‘llanadi, lekin tayinlash mantiqini albatta aniqlashtirish kerak.",
  "Почему назначены два антибиотика одновременно?": "Nega bir vaqtning o‘zida ikkita antibiotik tayinlangan?",
  "Есть перекрытие антигистаминных препаратов.": "Antigistamin dorilar orasida ustma-ustlik bor.",
  "В списке есть два препарата одного класса. Это не всегда ошибка, но может потребовать уточнения у врача.":
    "Ro‘yxatda bir sinfga mansub ikkita dori bor. Bu har doim ham xato emas, ammo shifokordan aniqlashtirish talab qilinishi mumkin.",
  "Нужно ли принимать оба антигистаминных препарата?": "Ikkala antigistamin dorini ham qabul qilish kerakmi?",
  "На какие изменения сна или поведения стоит обратить внимание?":
    "Uyqu yoki xulqdagi qaysi o‘zgarishlarga e’tibor berish kerak?",
  "Подтвердите схему у врача для возраста 0–2 года.": "0–2 yosh uchun sxemani shifokor bilan tasdiqlang.",
  "Недостаточно данных для точного вывода.": "Aniq xulosa uchun ma’lumot yetarli emas.",
  "общее самочувствие": "umumiy holat",
  "температура": "harorat",
  "сыпь": "toshma",
  "затруднение дыхания": "nafas olish qiyinlashuvi",
  "сон и поведение": "uyqu va xulq"
};

function localizeAnalysisEngineText(
  locale: SupportedLocale,
  value: string,
  section: "summary" | "explanation" | "comparison" | "monitoring" | "doctor"
): string {
  if (locale === "ru") {
    return value;
  }
  const trimmed = value.trim();
  const mapped = ANALYSIS_TEXT_TRANSLATIONS_UZ[trimmed];
  if (mapped) {
    return mapped;
  }
  const notEnoughPrefix = "Недостаточно данных для точного вывода по сочетанию: ";
  if (trimmed.startsWith(notEnoughPrefix) && trimmed.endsWith(".")) {
    const pair = trimmed.slice(notEnoughPrefix.length, -1);
    return t(locale, "analysis.engine.notEnoughForCombination", { pair });
  }
  const noRulePrefix = "Комбинация ";
  const noRuleSuffix = ": нет подтверждённого точного правила в текущей локальной базе.";
  if (trimmed.startsWith(noRulePrefix) && trimmed.endsWith(noRuleSuffix)) {
    const pair = trimmed.slice(noRulePrefix.length, trimmed.length - noRuleSuffix.length);
    return t(locale, "analysis.engine.noConfirmedRule", { pair });
  }
  if (section === "summary") {
    return t(locale, "analysis.engine.fallback.summary");
  }
  if (section === "explanation") {
    return t(locale, "analysis.engine.fallback.explanation");
  }
  if (section === "comparison") {
    return t(locale, "analysis.engine.fallback.comparison");
  }
  if (section === "monitoring") {
    return t(locale, "analysis.engine.fallback.monitoring");
  }
  return t(locale, "analysis.engine.fallback.doctor");
}

function getAnalysisStatusText(locale: SupportedLocale, status: string): string {
  const statusMap: Record<string, LocaleMessageKey> = {
    safe: "analysis.status.safe",
    caution: "analysis.status.caution",
    dangerous: "analysis.status.dangerous",
    attention: "analysis.status.dangerous"
  };
  return t(locale, statusMap[status] || "analysis.status.caution");
}

function formatCombinationResult(locale: SupportedLocale, analysis: AnalysisResult): string {
  const summary = localizeAnalysisEngineText(locale, analysis.summary || t(locale, "analysis.summary.fallback"), "summary");
  const explanation = localizeAnalysisEngineText(
    locale,
    analysis.explanation || t(locale, "analysis.explanation.fallback"),
    "explanation"
  );
  const comparison =
    analysis.comparison.length > 0
      ? analysis.comparison.map((item) => `• ${localizeAnalysisEngineText(locale, item, "comparison")}`).join("\n")
      : t(locale, "analysis.comparison.fallback");
  const monitoring =
    analysis.monitoring.length > 0
      ? analysis.monitoring.map((item) => `• ${localizeAnalysisEngineText(locale, item, "monitoring")}`).join("\n")
      : t(locale, "analysis.monitoring.fallback");
  const doctorQuestions =
    analysis.doctorQuestions.length > 0
      ? analysis.doctorQuestions.map((item) => `• ${localizeAnalysisEngineText(locale, item, "doctor")}`).join("\n")
      : t(locale, "analysis.doctor.fallback");

  return [
    t(locale, "analysis.section.reason"),
    summary,
    explanation,
    "",
    t(locale, "analysis.section.comparison"),
    comparison,
    "",
    t(locale, "analysis.section.monitoring"),
    monitoring,
    "",
    t(locale, "analysis.section.doctor"),
    doctorQuestions
  ].join("\n");
}

function buildActionLines(locale: SupportedLocale, status: string): string[] {
  if (status === "attention") {
    return [
      t(locale, "analysis.action.attention.1"),
      t(locale, "analysis.action.attention.2"),
      t(locale, "analysis.action.attention.3")
    ];
  }
  if (status === "caution") {
    return [
      t(locale, "analysis.action.caution.1"),
      t(locale, "analysis.action.caution.2"),
      t(locale, "analysis.action.caution.3")
    ];
  }
  return [
    t(locale, "analysis.action.safe.1"),
    t(locale, "analysis.action.safe.2"),
    t(locale, "analysis.action.safe.3")
  ];
}

async function renderFullAnalysisCard(
  ctx: any,
  options: {
    userId: number;
    draft: PendingDraft;
    meds: Medication[];
    analysis: AnalysisResult;
    medicationEntries: MedicationEntry[];
    hasDosageInInput: boolean;
    analysisPath: string;
  }
): Promise<void> {
  const { userId, draft, meds, analysis, medicationEntries, hasDosageInInput, analysisPath } = options;
  const locale = getUserLocale(ctx);
  const medicationDisplay = medicationEntries.map((entry) => formatMedicationEntry(entry));
  draft.medications = medicationDisplay.length > 0 ? medicationDisplay : meds.map((med) => med.name);
  draft.medicationEntries = medicationEntries;
  draft.analysis = analysis;
  draftMap.set(userId, draft);

  let card;
  try {
    card = createFamilyCard(
      {
        userId,
        age: draft.age || t(locale, "analysis.age.unknownValue"),
        symptoms: draft.symptoms || "",
        medications: draft.medications,
        analysis
      },
      { ctx }
    );
  } catch (cardError) {
    console.error("createFamilyCard failed", cardError);
    await ctx.reply(t(locale, "analysis.card.saveError"));
    return;
  }

  try {
    addReminder(userId, card.id, Date.now() + 6 * 60 * 60 * 1000);
  } catch (reminderError) {
    console.error("addReminder failed", reminderError);
  }

  try {
    trackEvent(userId, "create_card", { cardId: card.id, meds: draft.medications });
  } catch (trackingError) {
    console.error("trackEvent failed", trackingError);
  }

  const responseText = `
${getAnalysisStatusText(locale, analysis.status)}

${t(locale, "analysis.block.drugs")}
${medicationDisplay.map((value) => `• ${value}`).join("\n")}

${formatCombinationResult(locale, analysis)}

${t(locale, "analysis.block.ageConsidered")}
${t(locale, "analysis.block.ageLine", { age: card.age || t(locale, "analysis.block.ageUnknown") })}

${t(locale, "analysis.block.actions")}
${buildActionLines(locale, analysis.status).join("\n")}

${t(locale, "analysis.block.risksChecked")}
${t(locale, "analysis.block.risk.compatibility")}
${t(locale, "analysis.block.risk.age")}

${t(locale, "analysis.block.source")}

${hasDosageInInput ? `${t(locale, "analysis.block.dosageNote")}\n` : ""} 

${t(locale, "analysis.block.important")}
${t(locale, "analysis.disclaimer.line1")}
${t(locale, "analysis.disclaimer.line2")}
${t(locale, "analysis.disclaimer.line3")}
`;

  logEvent("final_renderer_selected", {
    userId,
    chatId: ctx.chat?.id ?? null,
    currentStep: "completed",
    analysis_path: analysisPath,
    render_mode: "full_main"
  });
  logEvent("analysis_path", {
    userId,
    chatId: ctx.chat?.id ?? null,
    analysis_path: analysisPath
  });
  logEvent("render_mode", {
    userId,
    chatId: ctx.chat?.id ?? null,
    render_mode: "full_main"
  });
  logEvent("final_analysis_medications", {
    userId,
    chatId: ctx.chat?.id ?? null,
    final_analysis_medications: meds.map((med) => med.name)
  });

  await ctx.reply(
    responseText.trim(),
    Markup.inlineKeyboard([
      [Markup.button.callback(t(getUserLocale(ctx), "buy.button"), `buy_card_${card.id}`)],
      [Markup.button.callback(t(locale, "analysis.button.saveCard"), `save_${card.id}`)],
      [Markup.button.callback(t(locale, "analysis.button.reminder"), `remind_${card.id}`)],
      [Markup.button.callback(t(locale, "analysis.button.newCheck"), "new_check")],
      [Markup.button.url(t(locale, "analysis.button.shareCard"), getShareLink(botUsername, card.id))]
    ])
  );

  logEvent("combination_check_completed", {
    userId,
    chatId: ctx.chat?.id ?? null,
    currentStep: "completed",
    resultSummary: {
      medsCount: meds.length,
      final_analysis_medications: meds.map((med) => med.name),
      analysis_mode: "full_combo",
      status: analysis.status,
      summary: analysis.summary
    }
  });
}

function appendDrugToDraftInput(userId: number, drugName: string): string {
  const draft = draftMap.get(userId) || {};
  const current = (draft.medicationsInput || "").trim();
  const parts = current
    ? current.split(",").map((x) => x.trim()).filter(Boolean)
    : [];
  if (!parts.some((x) => normalizeMedicationQuery(x) === normalizeMedicationQuery(drugName))) {
    parts.push(drugName);
  }
  const next = parts.join(", ");
  draft.medicationsInput = next;
  draftMap.set(userId, draft);
  return next;
}

async function renderSingleDrugCard(ctx: any, userId: number, drug: CatalogDrug): Promise<void> {
  const locale = getUserLocale(ctx);
  const draft = draftMap.get(userId) || {};
  const ageText = draft.age || t(locale, "analysis.age.unknownValue");
  const resolved = resolveDrug(drug.name);
  const primary = resolved.primary;
  const minAge = primary?.ageRestrictions?.minAgeYears;
  const maxAge = primary?.ageRestrictions?.maxAgeYears;
  const mainRisks = (primary?.safety?.mainRisks || []).slice(0, 3);
  const contraindications = (primary?.safety?.contraindicationSignals || []).slice(0, 3);
  const cautionGroups = (primary?.classification?.interactionGroups || []).slice(0, 3);
  const symptomHint =
    drug.symptoms.length > 0
      ? locale === "ru"
        ? t(locale, "single.symptomHint.prefix", { symptoms: drug.symptoms.slice(0, 2).join(", ") })
        : t(locale, "single.symptomHint.generic")
      : "";
  const riskMap: Record<string, string> = {
    LIVER: t(locale, "single.risk.liver"),
    ALLERGY: t(locale, "single.risk.allergy"),
    GI: t(locale, "single.risk.gi"),
    KIDNEY: t(locale, "single.risk.kidney"),
    CNS: t(locale, "single.risk.cns")
  };
  const prettyMainRisks = mainRisks.map((risk: string) => riskMap[risk] || risk.toLowerCase());
  const ageRestrictionText =
    typeof minAge === "number" && typeof maxAge === "number"
      ? t(locale, "single.ageRestriction.range", { min: String(minAge), max: String(maxAge) })
      : typeof minAge === "number"
        ? t(locale, "single.ageRestriction.minOnly", { min: String(minAge) })
        : typeof maxAge === "number"
          ? t(locale, "single.ageRestriction.maxOnly", { max: String(maxAge) })
          : t(locale, "single.ageRestriction.generic");

  const profileParts: string[] = [];
  if (drug.shortInfo) {
    profileParts.push(drug.shortInfo);
  } else if (symptomHint) {
    profileParts.push(symptomHint);
  }
  profileParts.push(ageRestrictionText);
  if (prettyMainRisks.length > 0) {
    profileParts.push(t(locale, "single.keyWarnings", { value: prettyMainRisks.join(", ") }));
  }
  if (contraindications.length > 0) {
    if (locale === "ru") {
      profileParts.push(t(locale, "single.contraindications", { value: contraindications.join(", ") }));
    } else {
      profileParts.push(t(locale, "single.contraindications.generic"));
    }
  }
  if (cautionGroups.length > 0) {
    if (locale === "ru") {
      profileParts.push(t(locale, "single.cautionInteractions", { value: cautionGroups.join(", ") }));
    } else {
      profileParts.push(t(locale, "single.cautionInteractions.generic"));
    }
  }
  const infoText =
    profileParts.length > 1
      ? profileParts.join("\n")
      : t(locale, "single.infoFallback");
  logEvent("preview_debug_field", {
    userId,
    chatId: ctx.chat?.id ?? null,
    selectedDrugId: drug.id,
    sourceFieldName: "shortInfo/symptoms",
    rawFieldValue: drug.shortInfo || "",
    cleanedValue: infoText
  });
  logEvent("combination_check_completed", {
    userId,
    chatId: ctx.chat?.id ?? null,
    currentStep: "completed",
    resultSummary: {
      medsCount: 1,
      final_analysis_medications: [drug.name],
      analysis_mode: "single_drug_card"
    }
  });

  await ctx.reply(
    `${formatDrugLabel(drug, locale)}\n\n${infoText}\n\n${t(locale, "single.footer", { age: ageText })}`,
    Markup.inlineKeyboard([
      [Markup.button.callback(t(locale, "single.button.addMore"), `add_more_drug_${drug.id}`)],
      [Markup.button.callback(t(locale, "single.button.checkCombo"), `check_combo_${drug.id}`)],
      [Markup.button.callback(t(getUserLocale(ctx), "buy.button"), `buy_drug_${drug.id}`)],
      [Markup.button.callback(t(locale, "single.button.back"), "symcat_back")]
    ])
  );
}

function resolveMedicationsFromInput(input: string): Medication[] {
  const medsStructured = parseMultiMedications(input);
  const structuredNames = Array.from(new Set(medsStructured.map((m) => m.name)));
  const structuredInput = structuredNames.join(", ");
  const sanitizedInput = sanitizeMedicationInput(input);
  const parsedFromLegacy = structuredInput ? parseMedications(structuredInput) : [];
  const parsedFromSanitized = parseMedications(sanitizedInput);
  const parsedFromCatalog = parseCatalogMedications(structuredInput || sanitizedInput);
  return mergeMedicationCandidates(parsedFromLegacy, parsedFromSanitized, parsedFromCatalog);
}

async function runAnalysisForCurrentDraft(
  ctx: any,
  userId: number,
  analysisPath = "check_combo_callback"
): Promise<void> {
  const draft = draftMap.get(userId) || {};
  const input = (draft.medicationsInput || "").trim();
  if (!input) {
    await ctx.reply(t(getUserLocale(ctx), "analysis.input.empty"));
    return;
  }

  const medsRaw = resolveMedicationsFromInput(input);
  const meds = dedupeMedicationsForAnalysis(medsRaw, {
    userId,
    chatId: ctx.chat?.id ?? null,
    analysisPath,
    currentStep: "medications"
  });
  if (meds.length === 0) {
    await ctx.reply(t(getUserLocale(ctx), "analysis.input.unrecognized"));
    return;
  }

  if (meds.length === 1) {
    const only = resolveDrug(meds[0].name).catalog;
    if (only) {
      await renderSingleDrugCard(ctx, userId, only);
      return;
    }
  }

  const pediatricHighRisk = isPediatricHighRisk(draft.age);
  const pediatricComboRisk = pediatricHighRisk && hasIbuprofenParacetamolCombo(meds);
  const analysis = applyMedicalSafetyOverrides(analyzeMedications(meds, { ageYears: parseAgeYears(draft.age) }), {
    pediatricHighRisk,
    pediatricComboRisk,
    uncertainMatch: false
  });
  const medicationEntries = dedupeMedicationEntries(parseMultiMedications(input));
  const hasDosageInInput = medicationEntries.some((entry) => Boolean(entry.dosageNormalized || entry.dosageRaw));
  await renderFullAnalysisCard(ctx, {
    userId,
    draft,
    meds,
    analysis,
    medicationEntries:
      medicationEntries.length > 0
        ? medicationEntries
        : meds.map((med): MedicationEntry => ({ name: med.name })),
    hasDosageInInput,
    analysisPath
  });
  stepMap.delete(userId);
  draftMap.delete(userId);
  clearAwaitingSuggestion(userId, true);
}

bot.start(async (ctx) => {
  const userId = ctx.from.id;
  const locale = getUserLocale(ctx);
  const sessionId = startAnalyticsSession(userId);
  upsertReminderUser({
    userId,
    firstName: ctx.from?.first_name,
    username: ctx.from?.username,
    language: locale
  });
  resetConversationState(userId, "start_command");
  logEvent("session_started", { userId, chatId: ctx.chat?.id ?? null, currentStep: "start", sessionId });

  const text = ctx.message.text ?? "";
  const parts = text.split(" ");
  const startArg = parts.length > 1 ? parts[1] : "";

  if (startArg && startArg.startsWith("card_")) {
    const cardId = startArg.replace("card_", "");
    const card = getFamilyCard(cardId);

    if (!card) {
      await ctx.reply(t(locale, "profile.reply.cardNotFound"));
      return;
    }

    if (card.userId !== userId) {
      console.warn("unauthorized access attempt", {
        requestedBy: userId,
        ownerId: card.userId,
        cardId
      });
      await ctx.reply(t(locale, "profile.reply.cardNoAccess"));
      return;
    }

    trackEvent(userId, "open_card", { cardId });
    logEvent("card_opened", { userId, chatId: ctx.chat?.id ?? null, cardId });
    const items = card.medications.map((m) => `• ${m}`).join("\n");

    await ctx.reply(
      `Карточка проверки\n\n${items}\n\nСтатус: ${statusEmoji(card.analysis.status)} ${card.analysis.summary}`,
      Markup.inlineKeyboard([
        [Markup.button.callback(t(locale, "buy.button"), `buy_card_${cardId}`)],
        [Markup.button.url(t(locale, "profile.share.button"), getShareLink(botUsername, card.id))]
      ])
    );
    return;
  }

  draftMap.delete(userId);
  stepMap.delete(userId);
  touchSessionState(userId);

  await ctx.reply(
    t(locale, "start.greeting"),
    buildMainMenu(locale)
  );
});

bot.command("reset", async (ctx) => {
  const userId = ctx.from.id;
  resetConversationState(userId, "reset_command");
  logEvent("flow_restarted", { userId, chatId: ctx.chat?.id ?? null, reason: "reset_command" });
  await showAgeStep(ctx, userId, t(getUserLocale(ctx), "profile.reset.message"));
});

function buildHistoryText(userId: number, locale: SupportedLocale = "ru"): string {
  const history = getUserHistory(userId);

  if (history.length === 0) {
    return t(locale, "profile.history.empty");
  }

  return history
    .map((h, idx) => {
      return `${idx + 1}. ${h.age}\n${t(locale, "profile.history.meds", { value: h.medications.join(", ") })}\nID: ${h.id}`;
    })
    .join("\n\n");
}

async function showSafetyProfilesMenu(ctx: any, userId: number): Promise<void> {
  const locale = getUserLocale(ctx);
  const profiles = listSafetyProfiles(userId);
  const active = getActiveSafetyProfile(userId);
  const lines: string[] = [
    t(locale, "profile.menu.intro.1"),
    t(locale, "profile.menu.intro.2")
  ];
  if (active) {
    lines.push("");
    lines.push(t(locale, "profile.menu.activeTitle"));
    lines.push(formatProfileSummary(active, true, locale));
  } else {
    lines.push("");
    lines.push(t(locale, "profile.menu.activeMissing"));
  }
  lines.push("");
  lines.push(t(locale, "profile.menu.savedCount", { count: String(profiles.length) }));
  await ctx.reply(lines.join("\n"), buildSafetyProfilesMenuKeyboard(locale));
}

function startProfileWizard(userId: number, mode: "create" | "temporary" | "edit", seed?: SafetyProfile): void {
  profileWizardMap.set(userId, {
    mode,
    profileId: seed?.profileId,
    label: seed?.label || "",
    ageYears: seed?.ageYears ?? null,
    pregnancyOrLactation: seed?.pregnancyOrLactation || false,
    hasDrugAllergy: seed?.hasDrugAllergy || false,
    drugAllergyNotes: seed?.drugAllergyNotes || "",
    hasGiRisk: seed?.hasGiRisk || false,
    hasLiverRisk: seed?.hasLiverRisk || false,
    hasKidneyRisk: seed?.hasKidneyRisk || false,
    hasChronicCondition: seed?.hasChronicCondition || false,
    notes: seed?.notes || ""
  });
  stepMap.set(userId, "profile_label");
}

async function askProfileAgeStep(ctx: any, userId: number): Promise<void> {
  stepMap.set(userId, "profile_age");
  await ctx.reply(t(getUserLocale(ctx), "profile.wizard.agePrompt"));
}

async function askProfileBooleanStep(
  ctx: any,
  userId: number,
  field: "pregnancy" | "allergy" | "gi" | "liver" | "kidney" | "chronic",
  question: string
): Promise<void> {
  const locale = getUserLocale(ctx);
  stepMap.set(userId, `profile_${field}`);
  await ctx.reply(question, buildBooleanQuestionKeyboard(field, locale));
}

async function proceedProfileWizardAfterBoolean(ctx: any, userId: number, field: string): Promise<void> {
  if (field === "pregnancy") {
    await askProfileBooleanStep(ctx, userId, "allergy", t(getUserLocale(ctx), "profile.wizard.question.allergy"));
    return;
  }
  if (field === "allergy") {
    const draft = getProfileWizard(userId);
    if (draft?.hasDrugAllergy) {
      stepMap.set(userId, "profile_allergy_notes");
      await ctx.reply(t(getUserLocale(ctx), "profile.wizard.allergyNotes"));
      return;
    }
    await askProfileBooleanStep(ctx, userId, "gi", t(getUserLocale(ctx), "profile.wizard.question.gi"));
    return;
  }
  if (field === "gi") {
    await askProfileBooleanStep(ctx, userId, "liver", t(getUserLocale(ctx), "profile.wizard.question.liver"));
    return;
  }
  if (field === "liver") {
    await askProfileBooleanStep(ctx, userId, "kidney", t(getUserLocale(ctx), "profile.wizard.question.kidney"));
    return;
  }
  if (field === "kidney") {
    await askProfileBooleanStep(ctx, userId, "chronic", t(getUserLocale(ctx), "profile.wizard.question.chronic"));
    return;
  }
  if (field === "chronic") {
    const locale = getUserLocale(ctx);
    stepMap.set(userId, "profile_save_choice");
    await ctx.reply(
      t(locale, "profile.wizard.saveQuestion"),
      Markup.inlineKeyboard([
        [Markup.button.callback(t(locale, "profile.save.save"), "profile_wizard_save_yes"), Markup.button.callback(t(locale, "profile.save.useOnce"), "profile_wizard_save_no")]
      ])
    );
  }
}

async function finalizeProfileWizard(ctx: any, userId: number, savePersistent: boolean): Promise<void> {
  const locale = getUserLocale(ctx);
  const draft = getProfileWizard(userId);
  if (!draft) {
    await ctx.reply(t(locale, "profile.error.draftRestart"), buildMainMenu(locale));
    return;
  }

  if (savePersistent) {
    let saved: SafetyProfile | null = null;
    if (draft.mode === "edit" && draft.profileId) {
      saved = updateSafetyProfile(userId, draft.profileId, {
        label: draft.label || t(locale, "profile.defaultLabel"),
        ageYears: draft.ageYears,
        pregnancyOrLactation: draft.pregnancyOrLactation,
        hasDrugAllergy: draft.hasDrugAllergy,
        drugAllergyNotes: draft.drugAllergyNotes,
        hasGiRisk: draft.hasGiRisk,
        hasLiverRisk: draft.hasLiverRisk,
        hasKidneyRisk: draft.hasKidneyRisk,
        hasChronicCondition: draft.hasChronicCondition,
        notes: draft.notes
      });
    } else {
      saved = createSafetyProfile({
        userId,
        label: draft.label || t(locale, "profile.defaultLabel"),
        ageYears: draft.ageYears,
        pregnancyOrLactation: draft.pregnancyOrLactation,
        hasDrugAllergy: draft.hasDrugAllergy,
        drugAllergyNotes: draft.drugAllergyNotes,
        hasGiRisk: draft.hasGiRisk,
        hasLiverRisk: draft.hasLiverRisk,
        hasKidneyRisk: draft.hasKidneyRisk,
        hasChronicCondition: draft.hasChronicCondition,
        notes: draft.notes
      });
      logEvent("profile_created", { userId, chatId: ctx.chat?.id ?? null, profileId: saved.profileId });
    }
    if (saved) {
      setActiveSafetyProfile(userId, saved.profileId);
      logEvent("profile_selected", { userId, chatId: ctx.chat?.id ?? null, profileId: saved.profileId });
      await ctx.reply(
        t(locale, "profile.reply.savedActivated", { summary: formatProfileSummary(saved, true, locale) }),
        buildMainMenu(locale)
      );
    } else {
      await ctx.reply(t(locale, "profile.reply.saveFailed"), buildMainMenu(locale));
    }
  } else {
    const temporary = saveTemporaryProfile(userId, draft, locale);
    logEvent("temporary_profile_used", {
      userId,
      chatId: ctx.chat?.id ?? null,
      profileLabel: temporary.label,
      ageKnown: temporary.ageKnown
    });
    await ctx.reply(
      t(locale, "profile.reply.tempApplied", { summary: formatProfileSummary(temporary, true, locale) }),
      buildMainMenu(locale)
    );
  }

  profileWizardMap.delete(userId);
  stepMap.delete(userId);
}

bot.command("history", async (ctx) => {
  const locale = getUserLocale(ctx);
  const text = buildHistoryText(ctx.from.id, locale);
  await ctx.reply(text === t(locale, "profile.history.empty") ? text : t(locale, "profile.history.header", { value: text }));
});

bot.hears([messages.ru["menu.history"], messages.uz["menu.history"]], async (ctx) => {
  logEvent("button_clicked", { userId: ctx.from.id, chatId: ctx.chat?.id ?? null, buttonKey: "main_menu", scope: "main_menu", value: "history" });
  const locale = getUserLocale(ctx);
  const text = buildHistoryText(ctx.from.id, locale);
  await ctx.reply(text === t(locale, "profile.history.empty") ? text : t(locale, "profile.history.header", { value: text }));
});

bot.hears([messages.ru["menu.reminders"], messages.uz["menu.reminders"]], async (ctx) => {
  logEvent("button_clicked", { userId: ctx.from.id, chatId: ctx.chat?.id ?? null, buttonKey: "main_menu", scope: "main_menu", value: "reminders" });
  await showReminderMenu(ctx, ctx.from.id);
});

bot.hears([messages.ru["menu.howTo"], messages.uz["menu.howTo"]], async (ctx) => {
  logEvent("button_clicked", { userId: ctx.from.id, chatId: ctx.chat?.id ?? null, buttonKey: "main_menu", scope: "main_menu", value: "how_to" });
  const locale = getUserLocale(ctx);
  await ctx.reply(
    t(locale, "howto.text"),
    buildMainMenu(locale)
  );
});

bot.hears([messages.ru["menu.safetyProfiles"], messages.uz["menu.safetyProfiles"]], async (ctx) => {
  logEvent("button_clicked", { userId: ctx.from.id, chatId: ctx.chat?.id ?? null, buttonKey: "main_menu", scope: "main_menu", value: "safety_profiles" });
  await showSafetyProfilesMenu(ctx, ctx.from.id);
});

bot.hears([messages.ru["menu.check"], messages.uz["menu.check"]], async (ctx) => {
  const userId = ctx.from.id;
  logEvent("button_clicked", { userId, chatId: ctx.chat?.id ?? null, buttonKey: "main_menu", scope: "main_menu", value: "check" });
  const locale = getUserLocale(ctx);
  const hasTemporaryProfile = temporaryProfileMap.has(userId);
  resetConversationState(userId, hasTemporaryProfile ? "profile_temporary_keep" : "start_wizard_from_menu");
  const activeProfile = hasTemporaryProfile ? temporaryProfileMap.get(userId) || null : getActiveSafetyProfile(userId);
  if (activeProfile?.ageKnown && typeof activeProfile.ageYears === "number") {
    const draft = draftMap.get(userId) || {};
    draft.age = String(activeProfile.ageYears);
    draftMap.set(userId, draft);
    await ctx.reply(
      t(locale, "profile.reply.fromSafety", { suffix: activeProfile.label ? `: ${activeProfile.label}` : "" }),
      buildMainMenu(locale)
    );
    await showSymptomCategoryStep(ctx, userId);
    return;
  }
  await showAgeStep(ctx, userId);
});

bot.hears([messages.ru["menu.language"], messages.uz["menu.language"]], async (ctx) => {
  logEvent("button_clicked", { userId: ctx.from.id, chatId: ctx.chat?.id ?? null, buttonKey: "main_menu", scope: "main_menu", value: "language" });
  const locale = getUserLocale(ctx);
  await ctx.reply(
    t(locale, "lang.prompt"),
    Markup.inlineKeyboard([
      [Markup.button.callback(t(locale, "lang.option.ru"), "lang_set_ru")],
      [Markup.button.callback(t(locale, "lang.option.uz"), "lang_set_uz")],
      [Markup.button.callback(t(locale, "lang.back"), "menu_main")]
    ])
  );
});

bot.action("profile_menu", async (ctx) => {
  await ctx.answerCbQuery(t(getUserLocale(ctx), "profile.cb.menu"));
  await showSafetyProfilesMenu(ctx, ctx.from.id);
});

bot.action("profile_back_main", async (ctx) => {
  const locale = getUserLocale(ctx);
  await ctx.answerCbQuery(t(locale, "profile.cb.mainMenu"));
  await ctx.reply(t(locale, "main.menu.opened"), buildMainMenu(locale));
});

bot.action("profile_create_start", async (ctx) => {
  const userId = ctx.from.id;
  const locale = getUserLocale(ctx);
  startProfileWizard(userId, "create");
  await ctx.answerCbQuery(t(locale, "profile.cb.create"));
  await ctx.reply(t(locale, "profile.reply.askWhoCreate"), buildProfileRoleKeyboard("create", locale));
});

bot.action("profile_temp_start", async (ctx) => {
  const userId = ctx.from.id;
  const locale = getUserLocale(ctx);
  startProfileWizard(userId, "temporary");
  await ctx.answerCbQuery(t(locale, "profile.cb.temporary"));
  await ctx.reply(t(locale, "profile.reply.askWhoTemporary"), buildProfileRoleKeyboard("temporary", locale));
});

bot.action("profile_select_list", async (ctx) => {
  const locale = getUserLocale(ctx);
  const profiles = listSafetyProfiles(ctx.from.id);
  await ctx.answerCbQuery(t(locale, "profile.cb.select"));
  if (profiles.length === 0) {
    await ctx.reply(t(locale, "profile.reply.noneSaved"), buildSafetyProfilesMenuKeyboard(locale));
    return;
  }
  await ctx.reply(t(locale, "profile.reply.chooseActive"), buildProfilesListKeyboard("profile_select", profiles, locale));
});

bot.action("profile_edit_list", async (ctx) => {
  const locale = getUserLocale(ctx);
  const profiles = listSafetyProfiles(ctx.from.id);
  await ctx.answerCbQuery(t(locale, "profile.cb.edit"));
  if (profiles.length === 0) {
    await ctx.reply(t(locale, "profile.reply.noneSaved"), buildSafetyProfilesMenuKeyboard(locale));
    return;
  }
  await ctx.reply(t(locale, "profile.reply.chooseEdit"), buildProfilesListKeyboard("profile_edit", profiles, locale));
});

bot.action("profile_delete_list", async (ctx) => {
  const locale = getUserLocale(ctx);
  const profiles = listSafetyProfiles(ctx.from.id);
  await ctx.answerCbQuery(t(locale, "profile.cb.delete"));
  if (profiles.length === 0) {
    await ctx.reply(t(locale, "profile.reply.noneSaved"), buildSafetyProfilesMenuKeyboard(locale));
    return;
  }
  await ctx.reply(t(locale, "profile.reply.chooseDelete"), buildProfilesListKeyboard("profile_delete", profiles, locale));
});

bot.action("profile_deactivate", async (ctx) => {
  const userId = ctx.from.id;
  const locale = getUserLocale(ctx);
  setActiveSafetyProfile(userId, null);
  temporaryProfileMap.delete(userId);
  await ctx.answerCbQuery(t(locale, "profile.cb.deactivated"));
  await ctx.reply(t(locale, "profile.reply.deactivated"), buildMainMenu(locale));
});

bot.action(/profile_select_(.+)/, async (ctx) => {
  const userId = ctx.from.id;
  const profileId = ctx.match[1];
  const profile = listSafetyProfiles(userId).find((item) => item.profileId === profileId);
  if (!profile) {
    await ctx.answerCbQuery(t(getUserLocale(ctx), "profile.cb.notFound"));
    return;
  }
  setActiveSafetyProfile(userId, profileId);
  temporaryProfileMap.delete(userId);
  logEvent("profile_selected", { userId, chatId: ctx.chat?.id ?? null, profileId });
  const locale = getUserLocale(ctx);
  await ctx.answerCbQuery(t(locale, "profile.cb.activated"));
  await ctx.reply(
    t(locale, "profile.reply.activeProfile", { summary: formatProfileSummary(profile, true, locale) }),
    buildMainMenu(locale)
  );
});

bot.action(/profile_edit_(.+)/, async (ctx) => {
  const userId = ctx.from.id;
  const profileId = ctx.match[1];
  const profile = listSafetyProfiles(userId).find((item) => item.profileId === profileId);
  if (!profile) {
    await ctx.answerCbQuery(t(getUserLocale(ctx), "profile.cb.notFound"));
    return;
  }
  startProfileWizard(userId, "edit", profile);
  await ctx.answerCbQuery(t(getUserLocale(ctx), "profile.cb.edit"));
  await askProfileAgeStep(ctx, userId);
});

bot.action(/profile_delete_(.+)/, async (ctx) => {
  const userId = ctx.from.id;
  const profileId = ctx.match[1];
  const deleted = deleteSafetyProfile(userId, profileId);
  if (!deleted) {
    await ctx.answerCbQuery(t(getUserLocale(ctx), "profile.cb.notFound"));
    return;
  }
  logEvent("profile_deleted", { userId, chatId: ctx.chat?.id ?? null, profileId });
  await ctx.answerCbQuery(t(getUserLocale(ctx), "profile.cb.deleted"));
  await showSafetyProfilesMenu(ctx, userId);
});

bot.action(/profile_wizard_(?:edit_)?role_(self|child|family|manual)/, async (ctx) => {
  const userId = ctx.from.id;
  const variant = ctx.match[1];
  const draft = getProfileWizard(userId);
  if (!draft) {
    await ctx.answerCbQuery(t(getUserLocale(ctx), "profile.cb.draftNotFound"));
    return;
  }
  const locale = getUserLocale(ctx);
  if (variant === "self") draft.label = t(locale, "profile.role.self");
  if (variant === "child") draft.label = t(locale, "profile.role.child");
  if (variant === "family") draft.label = t(locale, "profile.role.family");
  profileWizardMap.set(userId, draft);
  await ctx.answerCbQuery(t(locale, "profile.cb.accepted"));
  if (variant === "manual") {
    stepMap.set(userId, "profile_label");
    await ctx.reply(t(locale, "profile.reply.askName"));
    return;
  }
  await askProfileAgeStep(ctx, userId);
});

bot.action(/profile_wizard_(pregnancy|allergy|gi|liver|kidney|chronic)_(yes|no)/, async (ctx) => {
  const userId = ctx.from.id;
  const field = ctx.match[1];
  const value = ctx.match[2] === "yes";
  const draft = getProfileWizard(userId);
  if (!draft) {
    await ctx.answerCbQuery(t(getUserLocale(ctx), "profile.cb.draftNotFound"));
    return;
  }
  if (field === "pregnancy") draft.pregnancyOrLactation = value;
  if (field === "allergy") draft.hasDrugAllergy = value;
  if (field === "gi") draft.hasGiRisk = value;
  if (field === "liver") draft.hasLiverRisk = value;
  if (field === "kidney") draft.hasKidneyRisk = value;
  if (field === "chronic") draft.hasChronicCondition = value;
  profileWizardMap.set(userId, draft);
  const locale = getUserLocale(ctx);
  await ctx.answerCbQuery(value ? t(locale, "profile.bool.yes") : t(locale, "profile.bool.no"));
  await proceedProfileWizardAfterBoolean(ctx, userId, field);
});

bot.action("profile_wizard_save_yes", async (ctx) => {
  await ctx.answerCbQuery(t(getUserLocale(ctx), "profile.cb.saving"));
  await finalizeProfileWizard(ctx, ctx.from.id, true);
});

bot.action("profile_wizard_save_no", async (ctx) => {
  await ctx.answerCbQuery(t(getUserLocale(ctx), "profile.cb.tempMode"));
  await finalizeProfileWizard(ctx, ctx.from.id, false);
});

bot.action("menu_main", async (ctx) => {
  const locale = getUserLocale(ctx);
  stepMap.delete(ctx.from.id);
  await ctx.answerCbQuery(t(locale, "profile.cb.mainMenu"));
  await ctx.reply(t(locale, "main.menu.opened"), buildMainMenu(locale));
});

bot.action("rem_menu", async (ctx) => {
  await ctx.answerCbQuery(t(getUserLocale(ctx), "reminder.menu.title"));
  await showReminderMenu(ctx, ctx.from.id);
});

bot.action("lang_menu", async (ctx) => {
  const locale = getUserLocale(ctx);
  await ctx.answerCbQuery(t(locale, "menu.language"));
  await ctx.reply(
    t(locale, "lang.prompt"),
    Markup.inlineKeyboard([
      [Markup.button.callback(t(locale, "lang.option.ru"), "lang_set_ru")],
      [Markup.button.callback(t(locale, "lang.option.uz"), "lang_set_uz")],
      [Markup.button.callback(t(locale, "lang.back"), "menu_main")]
    ])
  );
});

bot.action("lang_set_ru", async (ctx) => {
  const userId = ctx.from.id;
  upsertReminderUser({
    userId,
    firstName: ctx.from?.first_name,
    username: ctx.from?.username,
    language: "ru"
  });
  await ctx.answerCbQuery(t("ru", "lang.changedRu"));
  await ctx.reply(t("ru", "main.menu.opened"), buildMainMenu("ru"));
});

bot.action("lang_set_uz", async (ctx) => {
  const userId = ctx.from.id;
  upsertReminderUser({
    userId,
    firstName: ctx.from?.first_name,
    username: ctx.from?.username,
    language: "uz"
  });
  await ctx.answerCbQuery(t("uz", "lang.changedUz"));
  await ctx.reply(t("uz", "main.menu.opened"), buildMainMenu("uz"));
});

bot.action("rem_add", async (ctx) => {
  const locale = getUserLocale(ctx);
  await ctx.answerCbQuery(t(locale, "rem.cb.add"));
  await startReminderWizard(ctx, ctx.from.id);
});

bot.action("rem_profile_pick", async (ctx) => {
  const locale = getUserLocale(ctx);
  const userId = ctx.from.id;
  const profiles = listSafetyProfiles(userId);
  await ctx.answerCbQuery(t(locale, "rem.cb.profile"));
  if (profiles.length === 0) {
    await ctx.reply(t(locale, "rem.reply.profileNone"));
    return;
  }
  await ctx.reply(
    t(locale, "rem.reply.profileChoose"),
    Markup.inlineKeyboard([
      ...profiles.slice(0, 12).map((profile) => [Markup.button.callback(profile.label, `rem_profile_set_${profile.profileId}`)]),
      [Markup.button.callback(t(locale, "rem.reply.profileReset"), "rem_profile_clear")],
      [Markup.button.callback(t(locale, "rem.nav.back"), "rem_back")]
    ])
  );
});

bot.action(/rem_profile_set_(.+)/, async (ctx) => {
  const locale = getUserLocale(ctx);
  const userId = ctx.from.id;
  const profile = listSafetyProfiles(userId).find((item) => item.profileId === ctx.match[1]);
  if (!profile) {
    await ctx.answerCbQuery(t(locale, "rem.reply.profileNotFound"));
    return;
  }
  const draft = getReminderDraft(userId) || {
    userId,
    step: "reminder_menu",
    mode: "quick",
    data: {},
    updatedAt: new Date().toISOString()
  };
  draft.data.profileLabel = profile.label;
  saveReminderDraft(draft);
  await ctx.answerCbQuery(t(locale, "rem.cb.profile"));
  await ctx.reply(t(locale, "rem.reply.profileSelected", { label: profile.label }));
});

bot.action("rem_profile_clear", async (ctx) => {
  const locale = getUserLocale(ctx);
  const userId = ctx.from.id;
  const draft = getReminderDraft(userId);
  if (draft) {
    draft.data.profileLabel = null;
    saveReminderDraft(draft);
  }
  await ctx.answerCbQuery(t(locale, "rem.reply.profileReset"));
  await ctx.reply(t(locale, "rem.reply.profileCleared"));
});

bot.action("rem_legal_ok", async (ctx) => {
  const locale = getUserLocale(ctx);
  const userId = ctx.from.id;
  acceptReminderLegalAck(userId);
  await ctx.answerCbQuery(t(locale, "rem.legal.ok"));
  await startReminderWizard(ctx, userId);
});

bot.action("rem_back", async (ctx) => {
  const locale = getUserLocale(ctx);
  const userId = ctx.from.id;
  const currentStep = stepMap.get(userId) || "idle";
  if (!isReminderStep(currentStep) && currentStep !== "reminder_menu") {
    await ctx.answerCbQuery(t(locale, "rem.cb.back"));
    return;
  }

  if (currentStep === "reminder_drug_name" || currentStep === "reminder_legal_ack" || currentStep === "reminder_menu") {
    stepMap.set(userId, "reminder_menu");
    touchSessionState(userId);
    await ctx.answerCbQuery(t(locale, "rem.cb.back"));
    await showReminderMenu(ctx, userId);
    return;
  }

  const draft = getReminderDraft(userId);
  if (!draft) {
    await ctx.answerCbQuery(t(locale, "rem.cb.back"));
    await showReminderMenu(ctx, userId);
    return;
  }

  if (currentStep === "reminder_quick_time" || currentStep === "reminder_dosage_text" || currentStep === "reminder_note_text") {
    stepMap.set(userId, "reminder_drug_name");
    draft.step = "reminder_drug_name";
    saveReminderDraft(draft);
    await ctx.answerCbQuery(t(locale, "rem.cb.back"));
    await ctx.reply(t(locale, "rem.reply.enterDrug"));
    return;
  }

  if (currentStep === "reminder_frequency" || currentStep === "reminder_custom_frequency") {
    stepMap.set(userId, draft.mode === "advanced" ? "reminder_dosage_text" : "reminder_quick_time");
    draft.step = stepMap.get(userId) || "reminder_quick_time";
    saveReminderDraft(draft);
    await ctx.answerCbQuery(t(locale, "rem.cb.back"));
    if (draft.mode === "advanced") {
      await ctx.reply(t(locale, "rem.reply.enterDrugAgain"));
    } else {
      await ctx.reply(t(locale, "rem.reply.enterTime"));
    }
    return;
  }

  if (currentStep === "reminder_duration" || currentStep === "reminder_custom_duration") {
    stepMap.set(userId, "reminder_frequency");
    draft.step = "reminder_frequency";
    saveReminderDraft(draft);
    await ctx.answerCbQuery(t(locale, "rem.cb.back"));
    await ctx.reply(t(locale, "rem.reply.frequencyPick"), buildReminderFrequencyKeyboard(locale));
    return;
  }

  if (currentStep === "reminder_qh_time_input") {
    stepMap.set(userId, "reminder_menu");
    draft.step = "reminder_menu";
    saveReminderDraft(draft);
    await ctx.answerCbQuery(t(locale, "rem.cb.back"));
    await ctx.reply(t(locale, "rem.reply.openedReminderSection"), buildReminderMenuKeyboard(locale));
    return;
  }

  stepMap.set(userId, "reminder_menu");
  draft.step = "reminder_menu";
  saveReminderDraft(draft);
  await ctx.answerCbQuery(t(locale, "rem.cb.back"));
  await showReminderMenu(ctx, userId);
});

bot.action("rem_mode_q", async (ctx) => {
  const locale = getUserLocale(ctx);
  const userId = ctx.from.id;
  const draft = getReminderDraft(userId);
  if (!draft?.data?.drugName) {
    await ctx.answerCbQuery(t(locale, "rem.cb.needDrug"));
    return;
  }
  draft.mode = "quick";
  draft.step = "reminder_quick_time";
  saveReminderDraft(draft);
  stepMap.set(userId, "reminder_quick_time");
  touchSessionState(userId);
  await ctx.answerCbQuery(t(locale, "rem.cb.quick"));
  await ctx.reply(t(locale, "rem.reply.enterTime"));
});

bot.action("rem_mode_a", async (ctx) => {
  const locale = getUserLocale(ctx);
  const userId = ctx.from.id;
  const draft = getReminderDraft(userId);
  if (!draft?.data?.drugName) {
    await ctx.answerCbQuery(t(locale, "rem.cb.needDrug"));
    return;
  }
  draft.mode = "advanced";
  draft.step = "reminder_dosage_text";
  saveReminderDraft(draft);
  stepMap.set(userId, "reminder_dosage_text");
  touchSessionState(userId);
  await ctx.answerCbQuery(t(locale, "rem.cb.advanced"));
  await ctx.reply(t(locale, "rem.reply.enterDrugAgain"));
});

bot.action("rem_note_skip", async (ctx) => {
  const locale = getUserLocale(ctx);
  const userId = ctx.from.id;
  const draft = getReminderDraft(userId);
  if (!draft) {
    await ctx.answerCbQuery(t(locale, "rem.cb.draftNotFound"));
    return;
  }
  draft.data.notes = null;
  draft.step = "reminder_quick_time";
  saveReminderDraft(draft);
  stepMap.set(userId, "reminder_quick_time");
  touchSessionState(userId);
  await ctx.answerCbQuery(t(locale, "rem.cb.skipped"));
  await ctx.reply(t(locale, "rem.reply.enterTime"));
});

bot.action(/rem_freq_(d1|d2|d3|h8|h12|custom)/, async (ctx) => {
  const locale = getUserLocale(ctx);
  const userId = ctx.from.id;
  const draft = getReminderDraft(userId);
  if (!draft) {
    await ctx.answerCbQuery(t(locale, "rem.cb.draftNotFound"));
    return;
  }
  const code = ctx.match[1];
  if (code === "custom") {
    draft.step = "reminder_custom_frequency";
    saveReminderDraft(draft);
    stepMap.set(userId, "reminder_custom_frequency");
    touchSessionState(userId);
    await ctx.answerCbQuery(t(locale, "rem.cb.custom"));
    await ctx.reply(t(locale, "rem.reply.customFreqPrompt"));
    return;
  }
  const map: Record<string, ReminderDraft["data"]["frequency"]> = {
    d1: "daily_1",
    d2: "daily_2",
    d3: "daily_3",
    h8: "hours_8",
    h12: "hours_12"
  };
  draft.data.frequency = map[code] || "daily_1";
  draft.step = "reminder_duration";
  saveReminderDraft(draft);
  stepMap.set(userId, "reminder_duration");
  touchSessionState(userId);
  await ctx.answerCbQuery(t(locale, "rem.cb.frequencySelected"));
  await ctx.reply(t(locale, "rem.reply.durationPick"), buildReminderDurationKeyboard(locale));
});

bot.action(/rem_dur_(1|3|5|7|10|open|custom)/, async (ctx) => {
  const locale = getUserLocale(ctx);
  const userId = ctx.from.id;
  const draft = getReminderDraft(userId);
  if (!draft) {
    await ctx.answerCbQuery(t(locale, "rem.cb.draftNotFound"));
    return;
  }
  const code = ctx.match[1];
  if (code === "custom") {
    draft.step = "reminder_custom_duration";
    saveReminderDraft(draft);
    stepMap.set(userId, "reminder_custom_duration");
    touchSessionState(userId);
    await ctx.answerCbQuery(t(locale, "rem.cb.custom"));
    await ctx.reply(t(locale, "rem.reply.customDurPrompt"));
    return;
  }
  if (code === "open") {
    draft.data.isOpenEnded = true;
    draft.data.durationDays = null;
  } else {
    draft.data.isOpenEnded = false;
    draft.data.durationDays = Number.parseInt(code, 10);
  }
  draft.step = "reminder_confirm";
  saveReminderDraft(draft);
  stepMap.set(userId, "reminder_confirm");
  touchSessionState(userId);
  await ctx.answerCbQuery(t(locale, "rem.cb.durationSelected"));
  await ctx.reply(buildReminderConfirmationText(locale, draft), buildReminderSaveKeyboard(locale));
});

bot.action("rem_edit", async (ctx) => {
  const locale = getUserLocale(ctx);
  const userId = ctx.from.id;
  const draft = getReminderDraft(userId);
  if (!draft) {
    await ctx.answerCbQuery(t(locale, "rem.cb.draftNotFound"));
    return;
  }
  draft.step = "reminder_drug_name";
  saveReminderDraft(draft);
  stepMap.set(userId, "reminder_drug_name");
  touchSessionState(userId);
  await ctx.answerCbQuery(t(locale, "rem.cb.edit"));
  await ctx.reply(t(locale, "rem.reply.enterDrugAgain"));
});

bot.action(/rem_edit_(.+)/, async (ctx) => {
  const locale = getUserLocale(ctx);
  const userId = ctx.from.id;
  const course = getReminderCourse(userId, ctx.match[1]);
  if (!course) {
    await ctx.answerCbQuery(t(locale, "rem.course.notFound"));
    return;
  }
  const frequency =
    course.schedule.type === "every_x_hours"
      ? (course.schedule.intervalHours === 12 ? "hours_12" : "hours_8")
      : (`daily_custom_${course.schedule.timesPerDay || 1}` as const);
  const draft: ReminderDraft = {
    userId,
    step: "reminder_confirm",
    mode: course.dosageText ? "advanced" : "quick",
    data: {
      drugName: course.drug.rawName,
      normalizedName: course.drug.normalizedName,
      dosageText: course.dosageText,
      time: course.schedule.times[0] || "08:00",
      frequency: frequency === "daily_custom_1" ? "daily_1" : frequency,
      durationDays: course.course.durationDays,
      isOpenEnded: course.course.isOpenEnded
    },
    updatedAt: new Date().toISOString()
  };
  saveReminderDraft(draft);
  stepMap.set(userId, "reminder_confirm");
  touchSessionState(userId);
  await ctx.answerCbQuery(t(locale, "rem.cb.editing"));
  await ctx.reply(t(locale, "rem.reply.confirmSave"), buildReminderSaveKeyboard(locale));
});

bot.action("rem_save", async (ctx) => {
  const locale = getUserLocale(ctx);
  const userId = ctx.from.id;
  const draft = getReminderDraft(userId);
  if (!draft || !draft.data.drugName || !draft.data.time || !draft.data.frequency) {
    await ctx.answerCbQuery(t(locale, "rem.cb.missingData"));
    return;
  }

  const activeProfile = getActiveSafetyProfile(userId);
  const isChildProfile = Boolean(activeProfile?.ageKnown && typeof activeProfile.ageYears === "number" && activeProfile.ageYears < 18);
  if (isChildProfile && stepMap.get(userId) !== "reminder_child_ack") {
    stepMap.set(userId, "reminder_child_ack");
    touchSessionState(userId);
    await ctx.answerCbQuery(t(locale, "rem.cb.profileCheck"));
    await ctx.reply(
      t(locale, "rem.reply.childWarn"),
      Markup.inlineKeyboard([
        [Markup.button.callback(t(locale, "rem.reply.childContinue"), "rem_child_ack")],
        [Markup.button.callback(t(locale, "rem.nav.back"), "rem_back")]
      ])
    );
    return;
  }

  const interactionRisk = detectReminderInteractionRisk(userId, draft.data.drugName);
  if (interactionRisk.risky && stepMap.get(userId) !== "reminder_interaction_ack") {
    stepMap.set(userId, "reminder_interaction_ack");
    touchSessionState(userId);
    await ctx.answerCbQuery(t(locale, "rem.cb.interactionCheck"));
    await ctx.reply(
      t(locale, "rem.reply.interactionWarn", { summary: interactionRisk.summary }),
      Markup.inlineKeyboard([
        [Markup.button.callback(t(locale, "rem.reply.interactionCheckBtn"), "rem_check_before_save")],
        [Markup.button.callback(t(locale, "rem.reply.interactionSaveAnyway"), "rem_save_anyway")],
        [Markup.button.callback(t(locale, "rem.reply.cancel"), "rem_cancel")]
      ])
    );
    return;
  }

  const result = createReminderCourse({
    userId,
    drugName: draft.data.drugName,
    dosageText: draft.data.dosageText || null,
    mode: draft.mode,
    time: draft.data.time,
    frequency: draft.data.frequency as any,
    durationDays: draft.data.durationDays ?? null,
    isOpenEnded: Boolean(draft.data.isOpenEnded),
    notes: draft.data.notes || undefined,
    profileLabel: draft.data.profileLabel || undefined,
    hasInteractionWarning: interactionRisk.risky,
    childProfile: isChildProfile,
    forceDuplicate: false
  });

  if (!result.ok && result.code === "duplicate" && result.duplicateCourseId) {
    draft.step = "reminder_duplicate_confirm";
    saveReminderDraft(draft);
    stepMap.set(userId, "reminder_duplicate_confirm");
    touchSessionState(userId);
    await ctx.answerCbQuery(t(locale, "rem.cb.duplicate"));
    await ctx.reply(
      t(locale, "rem.reply.duplicateWarn"),
      Markup.inlineKeyboard([
        [Markup.button.callback(t(locale, "rem.reply.duplicateCreateAnyway"), "rem_dup_continue")],
        [Markup.button.callback(t(locale, "rem.reply.duplicateOpenCurrent"), `rem_open_${result.duplicateCourseId}`)],
        [Markup.button.callback(t(locale, "rem.reply.cancel"), "rem_cancel")]
      ])
    );
    return;
  }

  if (!result.ok && result.code === "limit_reached") {
    await ctx.answerCbQuery(t(locale, "rem.cb.limit"));
    await ctx.reply(t(locale, "rem.reply.limitReached"));
    return;
  }

  if (!result.ok) {
    await ctx.answerCbQuery(t(locale, "rem.cb.error"));
    await ctx.reply(t(locale, "rem.reply.saveFailed"));
    return;
  }

  clearReminderDraft(userId);
  stepMap.set(userId, "reminder_menu");
  touchSessionState(userId);
  await ctx.answerCbQuery(t(locale, "rem.cb.saved"));
  await ctx.reply(t(locale, "rem.reply.saved"), buildReminderMenuKeyboard(locale));
});

bot.action("rem_child_ack", async (ctx) => {
  const locale = getUserLocale(ctx);
  const userId = ctx.from.id;
  stepMap.set(userId, "reminder_confirm");
  touchSessionState(userId);
  await ctx.answerCbQuery(t(locale, "rem.cb.continue"));
  await ctx.reply(t(locale, "rem.reply.confirmSave"), buildReminderSaveKeyboard(locale));
});

bot.action("rem_dup_continue", async (ctx) => {
  const locale = getUserLocale(ctx);
  const userId = ctx.from.id;
  const draft = getReminderDraft(userId);
  if (!draft || !draft.data.drugName || !draft.data.time || !draft.data.frequency) {
    await ctx.answerCbQuery(t(locale, "rem.cb.draftStale"));
    return;
  }
  const result = createReminderCourse({
    userId,
    drugName: draft.data.drugName,
    dosageText: draft.data.dosageText || null,
    mode: draft.mode,
    time: draft.data.time,
    frequency: draft.data.frequency as any,
    durationDays: draft.data.durationDays ?? null,
    isOpenEnded: Boolean(draft.data.isOpenEnded),
    notes: draft.data.notes || undefined,
    profileLabel: draft.data.profileLabel || undefined,
    forceDuplicate: true
  });
  if (!result.ok) {
    await ctx.answerCbQuery(t(locale, "rem.cb.failed"));
    return;
  }
  clearReminderDraft(userId);
  stepMap.set(userId, "reminder_menu");
  touchSessionState(userId);
  await ctx.answerCbQuery(t(locale, "rem.cb.created"));
  await ctx.reply(t(locale, "rem.reply.created"), buildReminderMenuKeyboard(locale));
});

bot.action("rem_check_before_save", async (ctx) => {
  const locale = getUserLocale(ctx);
  await ctx.answerCbQuery(t(locale, "rem.cb.interactionCheck"));
  const userId = ctx.from.id;
  const draft = getReminderDraft(userId);
  if (!draft?.data?.drugName) {
    await ctx.reply(t(locale, "rem.reply.draftMissingShort"));
    return;
  }
  const hasTemporaryProfile = temporaryProfileMap.has(userId);
  resetConversationState(userId, hasTemporaryProfile ? "profile_temporary_keep" : "check_combo_from_reminder_draft");
  const checkDraft = draftMap.get(userId) || {};
  checkDraft.medicationsInput = draft.data.drugName;
  draftMap.set(userId, checkDraft);
  await ctx.reply(t(locale, "rem.reply.addedToCheck", { name: draft.data.drugName }));
  await showAgeStep(ctx, userId);
});

bot.action("rem_save_anyway", async (ctx) => {
  const locale = getUserLocale(ctx);
  const userId = ctx.from.id;
  const draft = getReminderDraft(userId);
  if (!draft || !draft.data.drugName || !draft.data.time || !draft.data.frequency) {
    await ctx.answerCbQuery(t(locale, "rem.cb.draftStale"));
    return;
  }
  const result = createReminderCourse({
    userId,
    drugName: draft.data.drugName,
    dosageText: draft.data.dosageText || null,
    mode: draft.mode,
    time: draft.data.time,
    frequency: draft.data.frequency as any,
    durationDays: draft.data.durationDays ?? null,
    isOpenEnded: Boolean(draft.data.isOpenEnded),
    notes: draft.data.notes || undefined,
    profileLabel: draft.data.profileLabel || undefined,
    hasInteractionWarning: true,
    forceDuplicate: false
  });
  if (!result.ok) {
    await ctx.answerCbQuery(t(locale, "rem.cb.failed"));
    await ctx.reply(t(locale, "rem.reply.saveFailedShort"));
    return;
  }
  clearReminderDraft(userId);
  stepMap.set(userId, "reminder_menu");
  touchSessionState(userId);
  await ctx.answerCbQuery(t(locale, "rem.cb.saved"));
  await ctx.reply(t(locale, "rem.reply.savedRisk"), buildReminderMenuKeyboard(locale));
});

bot.action("rem_cancel", async (ctx) => {
  const locale = getUserLocale(ctx);
  clearReminderDraft(ctx.from.id);
  stepMap.set(ctx.from.id, "reminder_menu");
  touchSessionState(ctx.from.id);
  await ctx.answerCbQuery(t(locale, "rem.cb.cancelled"));
  await ctx.reply(t(locale, "rem.reply.notCreated"), buildReminderMenuKeyboard(locale));
});

bot.action("rem_list", async (ctx) => {
  const locale = getUserLocale(ctx);
  stepMap.set(ctx.from.id, "reminder_menu");
  touchSessionState(ctx.from.id);
  await ctx.answerCbQuery(t(locale, "rem.cb.list"));
  await showReminderCourses(ctx, ctx.from.id);
});

bot.action("rem_today", async (ctx) => {
  const locale = getUserLocale(ctx);
  const items = listTodayOccurrences(ctx.from.id);
  await ctx.answerCbQuery(t(locale, "rem.cb.today"));
  if (items.length === 0) {
    await ctx.reply(t(locale, "rem.reply.todayEmpty"));
    return;
  }
  const lines = items.slice(0, 20).map((item) => {
    const statusMap: Record<string, string> = {
      scheduled: t(locale, "rem.value.status.scheduled"),
      sent: t(locale, "rem.value.status.sent"),
      taken: t(locale, "rem.value.status.taken"),
      skipped: t(locale, "rem.value.status.skipped"),
      snoozed: t(locale, "rem.value.status.snoozed"),
      missed: t(locale, "rem.value.status.missed")
    };
    return `• ${item.localTime} — ${statusMap[item.status] || item.status}`;
  });
  await ctx.reply(t(locale, "rem.reply.todayTitle", { lines: lines.join("\n") }));
});

bot.action("rem_stats", async (ctx) => {
  const locale = getUserLocale(ctx);
  const stats = getReminderStats(ctx.from.id);
  const history = listReminderHistory(ctx.from.id, 12);
  const historyText =
    history.length === 0
      ? t(locale, "rem.reply.statsNoEvents")
      : history
          .map((event) => {
            const labelMap: Record<string, string> = {
              taken: t(locale, "rem.value.status.taken"),
              skipped: t(locale, "rem.value.status.skipped"),
              snoozed: t(locale, "rem.value.status.snoozed"),
              sent: t(locale, "rem.value.status.sent"),
              mark_now: t(locale, "rem.value.status.mark_now")
            };
            return `• ${new Date(event.createdAt).toLocaleString(locale === "uz" ? "uz-UZ" : "ru-RU")} — ${labelMap[event.eventType] || event.eventType}`;
          })
          .join("\n");
  await ctx.answerCbQuery(t(locale, "rem.cb.stats"));
  await ctx.reply(
    [
      t(locale, "rem.reply.statsTitle"),
      "",
      t(locale, "rem.reply.statsTotalCourses", { value: String(stats.totalCourses) }),
      t(locale, "rem.reply.statsActiveCourses", { value: String(stats.activeCourses) }),
      t(locale, "rem.reply.statsTaken", { value: String(stats.takenCount) }),
      t(locale, "rem.reply.statsSkipped", { value: String(stats.skippedCount) }),
      t(locale, "rem.reply.statsSnoozed", { value: String(stats.snoozedCount) }),
      "",
      t(locale, "rem.reply.statsRecent"),
      historyText
    ].join("\n")
  );
});

bot.action("rem_settings", async (ctx) => {
  const locale = getUserLocale(ctx);
  const settings = getReminderUser(ctx.from.id)?.settings;
  await ctx.answerCbQuery(t(locale, "rem.cb.settings"));
  await ctx.reply(
    [
      t(locale, "rem.reply.settingsTitle"),
      "",
      t(locale, "rem.reply.settingsNotifications", { value: settings?.notificationsEnabled === false ? t(locale, "rem.cb.notifOff") : t(locale, "rem.cb.notifOn") }),
      t(locale, "rem.reply.settingsQuietHours", { value: settings?.quietHours?.enabled ? `${settings.quietHours.start}–${settings.quietHours.end}` : t(locale, "rem.cb.qhOff") })
    ].join("\n"),
    buildReminderSettingsKeyboard(locale)
  );
});

bot.action("rem_set_notif_on", async (ctx) => {
  const locale = getUserLocale(ctx);
  setReminderNotificationsEnabled(ctx.from.id, true);
  await ctx.answerCbQuery(t(locale, "rem.cb.notifOn"));
  await ctx.reply(t(locale, "rem.reply.notifOn"), buildReminderSettingsKeyboard(locale));
});

bot.action("rem_set_notif_off", async (ctx) => {
  const locale = getUserLocale(ctx);
  setReminderNotificationsEnabled(ctx.from.id, false);
  await ctx.answerCbQuery(t(locale, "rem.cb.notifOff"));
  await ctx.reply(t(locale, "rem.reply.notifOff"), buildReminderSettingsKeyboard(locale));
});

bot.action("rem_set_qh_on", async (ctx) => {
  const locale = getUserLocale(ctx);
  const user = setReminderQuietHours(ctx.from.id, { enabled: true });
  await ctx.answerCbQuery(t(locale, "rem.cb.qhOn"));
  await ctx.reply(t(locale, "rem.reply.qhOn", { start: user.settings.quietHours.start, end: user.settings.quietHours.end }), buildReminderSettingsKeyboard(locale));
});

bot.action("rem_set_qh_off", async (ctx) => {
  const locale = getUserLocale(ctx);
  setReminderQuietHours(ctx.from.id, { enabled: false });
  await ctx.answerCbQuery(t(locale, "rem.cb.qhOff"));
  await ctx.reply(t(locale, "rem.reply.qhOff"), buildReminderSettingsKeyboard(locale));
});

bot.action("rem_set_qh_time", async (ctx) => {
  const locale = getUserLocale(ctx);
  stepMap.set(ctx.from.id, "reminder_qh_time_input");
  touchSessionState(ctx.from.id);
  await ctx.answerCbQuery(t(locale, "rem.cb.enterRange"));
  await ctx.reply(t(locale, "rem.reply.qhFormat"), { parse_mode: "Markdown" });
});

bot.action(/rem_open_(.+)/, async (ctx) => {
  await ctx.answerCbQuery(t(getUserLocale(ctx), "rem.cb.openCourse"));
  await showReminderCourseDetail(ctx, ctx.from.id, ctx.match[1]);
});

bot.action(/rem_pause_(.+)/, async (ctx) => {
  const locale = getUserLocale(ctx);
  const courseId = ctx.match[1];
  const ok = setReminderCourseStatus(ctx.from.id, courseId, "paused");
  await ctx.answerCbQuery(ok ? t(locale, "rem.cb.pause") : t(locale, "rem.cb.notFound"));
  if (ok) {
    await ctx.reply(t(locale, "rem.reply.pauseDone"));
  }
});

bot.action(/rem_finish_(.+)/, async (ctx) => {
  const locale = getUserLocale(ctx);
  const courseId = ctx.match[1];
  const ok = setReminderCourseStatus(ctx.from.id, courseId, "completed");
  await ctx.answerCbQuery(ok ? t(locale, "rem.cb.completed") : t(locale, "rem.cb.notFound"));
  if (ok) {
    await ctx.reply(t(locale, "rem.reply.finishDone"));
  }
});

bot.action(/rem_delete_(.+)/, async (ctx) => {
  const locale = getUserLocale(ctx);
  const courseId = ctx.match[1];
  const ok = deleteReminderCourse(ctx.from.id, courseId);
  await ctx.answerCbQuery(ok ? t(locale, "rem.cb.deleted") : t(locale, "rem.cb.notFound"));
  if (ok) {
    await ctx.reply(t(locale, "rem.reply.deleteDone"));
  }
});

bot.action(/rem_marknow_(.+)/, async (ctx) => {
  const locale = getUserLocale(ctx);
  const occurrence = markNowTaken(ctx.from.id, ctx.match[1]);
  await ctx.answerCbQuery(occurrence ? t(locale, "rem.cb.marked") : t(locale, "rem.cb.notFound"));
  if (occurrence) {
    await ctx.reply(t(locale, "rem.reply.markDone"));
  }
});

bot.action(/rem_check_(.+)/, async (ctx) => {
  const locale = getUserLocale(ctx);
  const course = getReminderCourse(ctx.from.id, ctx.match[1]);
  await ctx.answerCbQuery(t(locale, "rem.cb.interactionCheck"));
  if (!course) {
    await ctx.reply(t(locale, "rem.course.notFound"));
    return;
  }
  const userId = ctx.from.id;
  const hasTemporaryProfile = temporaryProfileMap.has(userId);
  resetConversationState(userId, hasTemporaryProfile ? "profile_temporary_keep" : "check_combo_from_reminder");
  const draft = draftMap.get(userId) || {};
  draft.medicationsInput = course.drug.rawName;
  draftMap.set(userId, draft);
  await ctx.reply(t(locale, "rem.reply.addedToCheck", { name: course.drug.rawName }));
  await showAgeStep(ctx, userId);
});

bot.action(/rem_take_(course_[a-z0-9]+)_(occ_[a-z0-9]+)/i, async (ctx) => {
  const locale = getUserLocale(ctx);
  const courseId = ctx.match[1];
  const occId = ctx.match[2];
  const ok = markOccurrenceTaken(ctx.from.id, courseId, occId);
  await ctx.answerCbQuery(ok ? t(locale, "rem.cb.takeMarked") : t(locale, "rem.cb.notFound"));
  if (ok) {
    await ctx.reply(
      t(locale, "rem.reply.takeDone"),
      Markup.inlineKeyboard([
        [Markup.button.callback(t(locale, "rem.reply.takeOpenCourse"), `rem_open_${courseId}`)],
        [Markup.button.callback(t(locale, "rem.reply.toMenu"), "menu_main")]
      ])
    );
  }
});

bot.action(/rem_skip_(course_[a-z0-9]+)_(occ_[a-z0-9]+)/i, async (ctx) => {
  const locale = getUserLocale(ctx);
  const courseId = ctx.match[1];
  const occId = ctx.match[2];
  const ok = markOccurrenceSkipped(ctx.from.id, courseId, occId);
  await ctx.answerCbQuery(ok ? t(locale, "rem.cb.skipMarked") : t(locale, "rem.cb.notFound"));
  if (ok) {
    await ctx.reply(
      t(locale, "rem.reply.skipDone"),
      Markup.inlineKeyboard([
        [Markup.button.callback(t(locale, "rem.reply.takeOpenCourse"), `rem_open_${courseId}`)],
        [Markup.button.callback(t(locale, "rem.reply.toMenu"), "menu_main")]
      ])
    );
  }
});

bot.action(/rem_snz_(course_[a-z0-9]+)_(occ_[a-z0-9]+)/i, async (ctx) => {
  const locale = getUserLocale(ctx);
  const courseId = ctx.match[1];
  const occId = ctx.match[2];
  await ctx.answerCbQuery(t(locale, "rem.cb.snooze"));
  await ctx.reply(
    t(locale, "rem.reply.snoozeAsk"),
    Markup.inlineKeyboard([
      [Markup.button.callback(t(locale, "rem.reply.snooze15"), `rem_snz15_${courseId}_${occId}`), Markup.button.callback(t(locale, "rem.reply.snooze30"), `rem_snz30_${courseId}_${occId}`)],
      [Markup.button.callback(t(locale, "rem.reply.snooze60"), `rem_snz60_${courseId}_${occId}`), Markup.button.callback(t(locale, "rem.reply.snooze120"), `rem_snz120_${courseId}_${occId}`)],
      [Markup.button.callback(t(locale, "rem.nav.back"), `rem_open_${courseId}`)]
    ])
  );
});

bot.action(/rem_snz(15|30|60|120)_(course_[a-z0-9]+)_(occ_[a-z0-9]+)/i, async (ctx) => {
  const locale = getUserLocale(ctx);
  const minutes = Number.parseInt(ctx.match[1], 10);
  const courseId = ctx.match[2];
  const occId = ctx.match[3];
  const ok = snoozeOccurrence(ctx.from.id, courseId, occId, minutes);
  await ctx.answerCbQuery(ok ? t(locale, "rem.cb.snoozed") : t(locale, "rem.cb.notFound"));
  if (ok) {
    await ctx.reply(t(locale, "rem.reply.snoozeDone"));
  }
});

bot.on("text", async (ctx) => {
  let userId: number | null = null;
  try {
    userId = ctx.from.id;
    const locale = getUserLocale(ctx);
    if (resetIfStateTimedOut(userId)) {
      await showAgeStep(ctx, userId, t(locale, "wizard.prompt.restartTimeout"));
      return;
    }
    touchSessionState(userId);

    const currentStep = stepMap.get(userId) || "idle";
    const input = ctx.message.text.trim();

    let draft = draftMap.get(userId) || {};

    if (currentStep === "profile_label") {
      const wizard = getProfileWizard(userId);
      if (!wizard) {
    await ctx.reply(t(getUserLocale(ctx), "profile.error.draftReopen"), buildMainMenu(getUserLocale(ctx)));
        return;
      }
      if (input.length < 2) {
    await ctx.reply(t(getUserLocale(ctx), "profile.error.nameTooShort"));
        return;
      }
      wizard.label = input.slice(0, 64);
      profileWizardMap.set(userId, wizard);
      await askProfileAgeStep(ctx, userId);
      return;
    }

    if (currentStep === "profile_age") {
      const wizard = getProfileWizard(userId);
      if (!wizard) {
    await ctx.reply(t(getUserLocale(ctx), "profile.error.draftReopen"), buildMainMenu(getUserLocale(ctx)));
        return;
      }
      const age = normalizeAge(input);
      if (!age) {
    await ctx.reply(t(getUserLocale(ctx), "profile.error.ageRange"));
        return;
      }
      wizard.ageYears = Number.parseInt(age, 10);
      profileWizardMap.set(userId, wizard);
      await askProfileBooleanStep(ctx, userId, "pregnancy", "Есть беременность или лактация?");
      return;
    }

    if (currentStep === "profile_allergy_notes") {
      const wizard = getProfileWizard(userId);
      if (!wizard) {
    await ctx.reply(t(getUserLocale(ctx), "profile.error.draftReopen"), buildMainMenu(getUserLocale(ctx)));
        return;
      }
      wizard.drugAllergyNotes = input.slice(0, 160);
      profileWizardMap.set(userId, wizard);
      await askProfileBooleanStep(ctx, userId, "gi", "Есть риск по ЖКТ (язва/кровотечения)?");
      return;
    }

    if (currentStep === "reminder_drug_name") {
      if (input.length < 2) {
        await ctx.reply(t(locale, "rem.reply.drugNameTooShort"));
        return;
      }
      const draft: ReminderDraft = getReminderDraft(userId) || {
        userId,
        step: "reminder_drug_name",
        mode: "quick",
        data: {},
        updatedAt: new Date().toISOString()
      };
      draft.step = "reminder_mode";
      draft.data.drugName = input.slice(0, 120);
      draft.data.normalizedName = input.toLowerCase().trim();
      saveReminderDraft(draft);
      stepMap.set(userId, "reminder_mode");
      touchSessionState(userId);
      await ctx.reply(
        t(locale, "rem.reply.modePrompt", { drug: draft.data.drugName || "" }),
        Markup.inlineKeyboard([
          [Markup.button.callback(t(locale, "rem.mode.quickBtn"), "rem_mode_q")],
          [Markup.button.callback(t(locale, "rem.mode.advancedBtn"), "rem_mode_a")],
          [Markup.button.callback(t(locale, "rem.mode.profileBtn"), "rem_profile_pick")],
          [Markup.button.callback(t(locale, "rem.nav.back"), "rem_back")]
        ])
      );
      return;
    }

    if (currentStep === "reminder_dosage_text") {
      const draft = getReminderDraft(userId);
      if (!draft) {
        await ctx.reply(t(locale, "rem.reply.draftMissing"));
        await showReminderMenu(ctx, userId);
        return;
      }
      draft.data.dosageText = input.slice(0, 64);
      draft.step = "reminder_note_text";
      saveReminderDraft(draft);
      stepMap.set(userId, "reminder_note_text");
      touchSessionState(userId);
      await ctx.reply(
        t(locale, "rem.reply.notePrompt"),
        Markup.inlineKeyboard([[Markup.button.callback(t(locale, "rem.reply.noteSkip"), "rem_note_skip")]])
      );
      return;
    }

    if (currentStep === "reminder_note_text") {
      const draft = getReminderDraft(userId);
      if (!draft) {
        await ctx.reply(t(locale, "rem.reply.draftMissing"));
        await showReminderMenu(ctx, userId);
        return;
      }
      draft.data.notes = input.slice(0, 120);
      draft.step = "reminder_quick_time";
      saveReminderDraft(draft);
      stepMap.set(userId, "reminder_quick_time");
      touchSessionState(userId);
      await ctx.reply(t(locale, "rem.reply.enterTime"));
      return;
    }

    if (currentStep === "reminder_quick_time") {
      const time = parseReminderTime(input);
      if (!time) {
        await ctx.reply(t(locale, "rem.reply.enterTimeFormatError"));
        return;
      }
      const draft = getReminderDraft(userId);
      if (!draft) {
        await ctx.reply(t(locale, "rem.reply.draftMissing"));
        await showReminderMenu(ctx, userId);
        return;
      }
      draft.data.time = time;
      draft.step = "reminder_frequency";
      saveReminderDraft(draft);
      stepMap.set(userId, "reminder_frequency");
      touchSessionState(userId);
      await ctx.reply(t(locale, "rem.reply.frequencyPick"), buildReminderFrequencyKeyboard(locale));
      return;
    }

    if (currentStep === "reminder_custom_frequency") {
      const count = Number.parseInt(input.trim(), 10);
      if (!Number.isInteger(count) || count < 1 || count > 6) {
        await ctx.reply(t(locale, "rem.reply.customFreqInvalid"));
        return;
      }
      const draft = getReminderDraft(userId);
      if (!draft) {
        await ctx.reply(t(locale, "rem.reply.draftMissing"));
        await showReminderMenu(ctx, userId);
        return;
      }
      draft.data.frequency = `daily_custom_${count}`;
      draft.step = "reminder_duration";
      saveReminderDraft(draft);
      stepMap.set(userId, "reminder_duration");
      touchSessionState(userId);
      await ctx.reply(t(locale, "rem.reply.durationPick"), buildReminderDurationKeyboard(locale));
      return;
    }

    if (currentStep === "reminder_custom_duration") {
      const days = Number.parseInt(input.trim(), 10);
      if (!Number.isInteger(days) || days < 1 || days > 365) {
        await ctx.reply(t(locale, "rem.reply.customDurInvalid"));
        return;
      }
      const draft = getReminderDraft(userId);
      if (!draft) {
        await ctx.reply(t(locale, "rem.reply.draftMissing"));
        await showReminderMenu(ctx, userId);
        return;
      }
      draft.data.durationDays = days;
      draft.data.isOpenEnded = false;
      draft.step = "reminder_confirm";
      saveReminderDraft(draft);
      stepMap.set(userId, "reminder_confirm");
      touchSessionState(userId);
      await ctx.reply(buildReminderConfirmationText(locale, draft), buildReminderSaveKeyboard(locale));
      return;
    }

    if (currentStep === "reminder_qh_time_input") {
      const parsed = parseQuietHoursRange(input);
      if (!parsed) {
        await ctx.reply(t(locale, "rem.reply.qhFormatError"));
        return;
      }
      const user = setReminderQuietHours(userId, { enabled: true, start: parsed.start, end: parsed.end });
      stepMap.set(userId, "reminder_menu");
      touchSessionState(userId);
      await ctx.reply(
        t(locale, "rem.reply.qhUpdated", { start: user.settings.quietHours.start, end: user.settings.quietHours.end }),
        buildReminderSettingsKeyboard(locale)
      );
      return;
    }

    if (currentStep === "reminder_menu") {
      await ctx.reply(t(locale, "rem.menu.chooseAction"), buildReminderMenuKeyboard(locale));
      return;
    }

    if (currentStep === "idle") {
    await ctx.reply(t(getUserLocale(ctx), "profile.reply.startCheck"), buildMainMenu(getUserLocale(ctx)));
      return;
    }

    if (currentStep === "age_choice") {
      const ageFromText = parseAgeChoiceInput(input);
      if (!ageFromText) {
        await ctx.reply(t(locale, "wizard.prompt.ageGuidance"), buildAgeKeyboard(locale));
        return;
      }
      draft.age = ageFromText;
      draftMap.set(userId, draft);
      logEvent("age_selected_text_fallback", {
        userId,
        chatId: ctx.chat?.id ?? null,
        currentStep: "age_choice",
        selectedAge: ageFromText,
        rawInput: input,
        draftSnapshot: getDraftSnapshot(userId)
      });
      await showSymptomCategoryStep(ctx, userId);
      return;
    }

    if (currentStep === "age_exact") {
      const normalizedAge = normalizeAge(input);
      if (!normalizedAge) {
        await ctx.reply(t(locale, "wizard.prompt.ageInvalid"));
        return;
      }

      draft.age = normalizedAge;
      draftMap.set(userId, draft);
      logEvent("age_entered_exact", {
        userId,
        chatId: ctx.chat?.id ?? null,
        currentStep: "age_exact",
        selectedAge: normalizedAge,
        draftSnapshot: getDraftSnapshot(userId)
      });
      await showSymptomCategoryStep(ctx, userId);
      return;
    }

    if (currentStep === "symptoms_category") {
      await ctx.reply(t(locale, "wizard.prompt.categoryButtons"), buildSymptomCategoryKeyboard(locale));
      return;
    }

    if (currentStep === "symptoms_detail") {
      await ctx.reply(t(locale, "wizard.prompt.detailButtons"));
      return;
    }

    if (currentStep === "symptoms_manual") {
      if (!isValidSymptoms(input)) {
        await ctx.reply(t(locale, "wizard.prompt.describeMore"));
        return;
      }

      logEvent("symptom_manual_entered", {
        userId,
        chatId: ctx.chat?.id ?? null,
        currentStep,
        rawInput: input.trim()
      });
      const suggestionStatus = await showDrugSuggestionsBySymptom(ctx, userId, input.trim());
      if (suggestionStatus === "suggestions") {
        await ctx.reply(t(locale, "wizard.prompt.selectDrugFallback"));
      }
      return;
    }

    if (currentStep === "medications") {
      const session = getOrCreateSessionState(userId);
      if (session.awaitingSuggestion) {
        clearAwaitingSuggestion(userId, true);
        console.info("stale_callback_ignored:", { userId, reason: "text_overrode_suggestion" });
      }

      const storedMedicationInput = (draft.medicationsInput || "").trim();
      const appendModeBeforeMerge = Boolean(draft.appendMode);
      const isSubmitCommand = isMedicationListSubmitCommand(input);
      if (isSubmitCommand && !storedMedicationInput) {
        await ctx.reply(t(locale, "wizard.prompt.listEmpty"));
        return;
      }
      let effectiveInput = isSubmitCommand && storedMedicationInput ? storedMedicationInput : input;
      if (draft.appendMode && !isSubmitCommand) {
        logEvent("medications_before_merge", {
          userId,
          chatId: ctx.chat?.id ?? null,
          currentStep: "medications",
          rawInput: input,
          draftSnapshot: getDraftSnapshot(userId)
        });
        effectiveInput = storedMedicationInput ? `${storedMedicationInput}, ${input}` : input;
        draft.appendMode = false;
        draftMap.set(userId, draft);
      }

      console.info("medications_input:", input);
      console.info("medications_effective_input:", effectiveInput);
      const rawParts = effectiveInput.split(",");
      const lastChunk = rawParts[rawParts.length - 1]?.trim() ?? "";
      const parsedLastChunk = extractDosage(lastChunk);
      console.info("dosage_parse_input:", lastChunk);
      console.info("dosage_parse_found:", Boolean(parsedLastChunk.dosage));
      console.info("dosage_parse_raw:", parsedLastChunk.dosage?.raw ?? null);
      console.info("dosage_parse_normalized:", parsedLastChunk.dosage?.normalized ?? null);
      console.info("dosage_cleaned_query:", parsedLastChunk.cleanedQuery || null);
      const lastChunkNameOnly = (parsedLastChunk.cleanedQuery || lastChunk)
        .replace(/(\d+)\s?(мг|mg|мл|ml)?/gi, " ")
        .replace(/[^\p{L}\s-]/gu, " ")
        .replace(/\s+/g, " ")
        .trim();
      const lastChunkLower = lastChunkNameOnly.toLowerCase();
      const canonical = normalizeDrug(lastChunkLower);
      const canonicalExact = isCanonicalDrug(lastChunkLower);
      const synonymExact = isSynonymDrug(lastChunkLower);
      const shouldSuggest =
        lastChunkLower.length >= 2 &&
        !canonicalExact &&
        (synonymExact || !canonical || lastChunkLower.length < 4);

      // Suggestions must appear before analysis when suggestion phase is needed.
      if (shouldSuggest) {
        const matches = findMatches(lastChunkLower);
        const hasStrongPrefixMatch = matches.some((name) => name.toLowerCase().startsWith(lastChunkLower));
        if (matches.length > 0 && hasStrongPrefixMatch) {
          console.info("suggestions_shown:", true);
          draft.medicationsInput = input;
          draftMap.set(userId, draft);
          const suggestionVersion = setAwaitingSuggestion(userId);

          await ctx.reply(
            t(locale, "wizard.prompt.selectDrug"),
            Markup.inlineKeyboard(
              [
                ...matches.map((name) => {
                  const index = MEDS.findIndex((m) => m === name);
                  return [Markup.button.callback(name, `select_med_${index}_${suggestionVersion}`)];
                }),
                [
                  Markup.button.callback(t(locale, "wizard.button.notThis"), `suggest_control_not_${suggestionVersion}`),
                  Markup.button.callback(t(locale, "wizard.button.manualEntry"), `suggest_control_manual_${suggestionVersion}`)
                ],
                [Markup.button.callback(t(locale, "wizard.button.cancel"), `suggest_control_cancel_${suggestionVersion}`)]
              ]
            )
          );
          return;
        }
      }
      console.info("suggestions_shown:", false);

      const sanitizedInput = sanitizeMedicationInput(effectiveInput);

      if (!sanitizedInput) {
        await ctx.reply(t(locale, "wizard.prompt.listEmptySubmit"));
        return;
      }
      if (!hasMeaningfulMedicationChunks(effectiveInput)) {
        await ctx.reply(t(locale, "wizard.prompt.shortDrugName"));
        return;
      }

      const medsStructured = parseMultiMedications(effectiveInput);
      console.info("meds_structured_count:", medsStructured.length);
      const structuredNames = Array.from(new Set(medsStructured.map((m) => m.name)));
      const structuredInput = structuredNames.join(", ");
      let uncertainMatch = false;

      const parsedFromLegacy = structuredInput ? parseMedications(structuredInput) : [];
      const parsedFromSanitized = parseMedications(sanitizedInput);
      const parsedFromCatalog = parseCatalogMedications(structuredInput || sanitizedInput);
      let meds = mergeMedicationCandidates(parsedFromLegacy, parsedFromSanitized, parsedFromCatalog);
      meds = dedupeMedicationsForAnalysis(meds, {
        userId,
        chatId: ctx.chat?.id ?? null,
        analysisPath: appendModeBeforeMerge ? draft.analysisPathHint || "append_text_submit" : "text_medications_submit",
        currentStep: "medications"
      });
      console.info("meds_final_count:", meds.length);
      logEvent("medications_after_merge", {
        userId,
        chatId: ctx.chat?.id ?? null,
        currentStep: "medications",
        rawInput: effectiveInput,
        resultSummary: {
          medsCount: meds.length,
          medsNames: meds.map((m) => m.name)
        },
        draftSnapshot: getDraftSnapshot(userId)
      });

      if (meds.length === 0) {
        const fallbackQuery =
          lastChunkNameOnly ||
          effectiveInput
            .split(",")
            .map((part) => part.trim())
            .find(Boolean) ||
          effectiveInput.trim();

        const localLookup = lookupLocalMedicationSmart(fallbackQuery, DRUGS);
        logEvent("drug_lookup_debug", {
          userId,
          chatId: ctx.chat?.id ?? null,
          currentStep: "medications",
          rawInput: fallbackQuery,
          normalizedInput: localLookup.debug.normalizedQuery,
          resultSummary: {
            exact: localLookup.debug.exactMatchCount,
            partial: localLookup.debug.partialMatchesCount,
            fuzzy: localLookup.debug.fuzzyMatchesCount
          }
        });

        if (localLookup.status === "exact") {
          logEvent("drug_lookup_success", {
            userId,
            chatId: ctx.chat?.id ?? null,
            selectedDrugName: localLookup.candidate.name,
            resultSummary: { status: "exact" }
          });
          uncertainMatch = false;
          meds = parseCatalogMedications(localLookup.candidate.name);
        } else if (localLookup.status === "confident") {
          logEvent("drug_lookup_success", {
            userId,
            chatId: ctx.chat?.id ?? null,
            selectedDrugName: localLookup.candidate.name,
            resultSummary: { status: "confident" }
          });
          draft.pendingLocalCandidate = localLookup.candidate.name;
          draft.pendingLocalCandidateInput = effectiveInput;
          draftMap.set(userId, draft);
          const confirmationVersion = setAwaitingSuggestion(userId);
          await ctx.reply(
            t(locale, "wizard.prompt.confirmParsedAs", { drug: localLookup.candidate.name }),
            Markup.inlineKeyboard([
              [
                Markup.button.callback(t(locale, "wizard.button.yes"), `confirm_med_yes_${confirmationVersion}`),
                Markup.button.callback(t(locale, "wizard.button.noManual"), `confirm_med_no_${confirmationVersion}`)
              ]
            ])
          );
          return;
        } else if (localLookup.status === "suggestions") {
          logEvent("drug_lookup_fail", {
            userId,
            chatId: ctx.chat?.id ?? null,
            rawInput: fallbackQuery,
            resultSummary: { status: "suggestions" }
          });
          const suggestionVersion = setAwaitingSuggestion(userId);
          await ctx.reply(
            t(locale, "wizard.prompt.unrecognizedDrugSuggestions", {
              list: localLookup.candidates.map((candidate, index) => `${index + 1}. ${candidate.name}`).join("\n")
            }),
            Markup.inlineKeyboard([
              [
                Markup.button.callback(t(locale, "wizard.button.notThis"), `suggest_control_not_${suggestionVersion}`),
                Markup.button.callback(t(locale, "wizard.button.manualEntry"), `suggest_control_manual_${suggestionVersion}`)
              ],
              [Markup.button.callback(t(locale, "wizard.button.cancel"), `suggest_control_cancel_${suggestionVersion}`)]
            ])
          );
          return;
        } else {
          logEvent("drug_lookup_fail", {
            userId,
            chatId: ctx.chat?.id ?? null,
            rawInput: fallbackQuery,
            resultSummary: { status: "not_found" }
          });
        }
      }

      if (meds.length > 0) {
        meds = dedupeMedicationsForAnalysis(meds, {
          userId,
          chatId: ctx.chat?.id ?? null,
          analysisPath: appendModeBeforeMerge ? draft.analysisPathHint || "append_text_submit" : "text_medications_submit",
          currentStep: "medications"
        });
      }

      if (meds.length === 0) {
        await ctx.reply(
          t(locale, "wizard.prompt.localNotFound"),
          Markup.inlineKeyboard([[Markup.button.callback(t(locale, "wizard.symptom.manual"), "manual_drug_input")]])
        );
        return;
      }

      if (meds.length === 1) {
        const only = resolveDrug(meds[0].name).catalog;
        if (only) {
          draft.medicationsInput = sanitizedInput;
          draftMap.set(userId, draft);
          await renderSingleDrugCard(ctx, userId, only);
          stepMap.delete(userId);
          draftMap.delete(userId);
          clearAwaitingSuggestion(userId, true);
          return;
        }
      }

      const pediatricHighRisk = isPediatricHighRisk(draft.age);
      console.info("pediatric_high_risk_mode:", pediatricHighRisk);
      const pediatricComboRisk = pediatricHighRisk && hasIbuprofenParacetamolCombo(meds);
      const analysis = applyMedicalSafetyOverrides(analyzeMedications(meds, { ageYears: parseAgeYears(draft.age) }), {
        pediatricHighRisk,
        pediatricComboRisk,
        uncertainMatch
      });
      logEvent("combination_check_started", {
        userId,
        chatId: ctx.chat?.id ?? null,
        currentStep: "medications",
        resultSummary: { medsCount: meds.length }
      });
      const medicationEntriesRaw: MedicationEntry[] =
        medsStructured.length > 0
          ? medsStructured
          : sanitizeMedicationInput(effectiveInput)
              .split(",")
              .map((x) => x.trim())
              .filter(Boolean)
              .map((name): MedicationEntry => ({ name: normalizeDrug(name) || name }));
      const medicationEntries = dedupeMedicationEntries(medicationEntriesRaw);
      const hasDosageInInput = medicationEntries.some((entry) => Boolean(entry.dosageNormalized || entry.dosageRaw));
      draft.medicationsInput = sanitizedInput;
      await renderFullAnalysisCard(ctx, {
        userId,
        draft,
        meds,
        analysis,
        medicationEntries,
        hasDosageInInput,
        analysisPath: appendModeBeforeMerge ? draft.analysisPathHint || "append_text_submit" : "text_medications_submit"
      });

      stepMap.delete(userId);
      draftMap.delete(userId);
      clearAwaitingSuggestion(userId, true);
      return;
    }
  } catch (err) {
    console.error("Unhandled error while processing text update", err);
    logEvent("flow_error", {
      userId,
      chatId: ctx.chat?.id ?? null,
      currentStep: typeof userId === "number" ? stepMap.get(userId) || "idle" : "idle",
      errorMessage: err instanceof Error ? err.message : String(err)
    });
    if (userId !== null) {
      resetConversationState(userId, "text_unhandled_exception");
    }
    try {
      if (userId !== null) {
        await showAgeStep(ctx, userId, t(getUserLocale(ctx), "wizard.prompt.restartError"));
      }
    } catch (replyError) {
      console.error("Failed to notify user about error", replyError);
    }
  }
});

bot.action(/age_(0_5|5_10|10_15|15_60|60_plus)/, async (ctx) => {
  const locale = getUserLocale(ctx);
  const userId = ctx.from.id;
  if (!(await guardCallbackFlowStep(ctx, userId, "age_preset", ["age_choice"]))) {
    return;
  }
  const code = ctx.match[1];
  const selected = AGE_PRESETS.find((item) => item.callback === `age_${code}`);
  if (!selected) {
    await ctx.answerCbQuery(t(locale, "wizard.cb.ageUnknown"));
    return;
  }

  const draft = draftMap.get(userId) || {};
  draft.age = selected.value;
  draftMap.set(userId, draft);
  logEvent("age_selected", {
    userId,
    chatId: ctx.chat?.id ?? null,
    currentStep: "age_choice",
    callbackData: `age_${code}`,
    selectedAge: selected.value,
    ageBucket: selected.label,
    draftSnapshot: getDraftSnapshot(userId)
  });
  await ctx.answerCbQuery(t(locale, "wizard.cb.ageValue", { value: selected.label }));
  await showSymptomCategoryStep(ctx, userId);
});

bot.action("age_exact", async (ctx) => {
  const locale = getUserLocale(ctx);
  const userId = ctx.from.id;
  if (!(await guardCallbackFlowStep(ctx, userId, "age_exact", ["age_choice"]))) {
    return;
  }
  stepMap.set(userId, "age_exact");
  touchSessionState(userId);
  logEvent("age_entered_exact", { userId, chatId: ctx.chat?.id ?? null, currentStep: "age_exact" });
  await ctx.answerCbQuery(t(locale, "wizard.cb.enterAgeNumber"));
  await ctx.reply(t(locale, "wizard.prompt.enterAgeExact"));
});

bot.action("symcat_back", async (ctx) => {
  const locale = getUserLocale(ctx);
  const userId = ctx.from.id;
  if (
    !(await guardCallbackFlowStep(ctx, userId, "symcat_back", [
      "symptoms_category",
      "symptoms_detail",
      "symptoms_manual",
      "medications"
    ]))
  ) {
    return;
  }
  logEvent("back_clicked", { userId, chatId: ctx.chat?.id ?? null, currentStep: stepMap.get(userId) || "idle" });
  await ctx.answerCbQuery(t(locale, "wizard.cb.back"));
  await showSymptomCategoryStep(ctx, userId);
});

bot.action(/symcat_(fever|cough|throat|runny|pain|allergy|other)/, async (ctx) => {
  const locale = getUserLocale(ctx);
  const userId = ctx.from.id;
  if (!(await guardCallbackFlowStep(ctx, userId, "symcat_select", ["symptoms_category"]))) {
    return;
  }
  const categoryId = ctx.match[1];
  logEvent("button_clicked", {
    userId,
    chatId: ctx.chat?.id ?? null,
    buttonKey: "symptom_select",
    scope: "symptom_select",
    value: categoryId
  });
  const draft = draftMap.get(userId) || {};
  const context = resolvePatientContext({
    activeProfile: getActiveSafetyProfile(userId),
    temporaryProfile: temporaryProfileMap.get(userId) || null,
    draftAgeRaw: draft.age
  });
  const totalDetails = (SYMPTOM_DETAILS[categoryId] || []).length;
  const availableDetails = getAvailableSymptomDetails(categoryId, context);
  const withMatches = availableDetails.length;
  const hiddenCount = Math.max(totalDetails - withMatches, 0);
  stepMap.set(userId, "symptoms_detail");
  touchSessionState(userId);
  logEvent("symptom_category_selected", {
    userId,
    chatId: ctx.chat?.id ?? null,
    currentStep: "symptoms_detail",
    selectedSymptomCategory: categoryId,
    callbackData: `symcat_${categoryId}`,
    resultSummary: {
      symptom_detail_candidates_total: totalDetails,
      symptom_detail_candidates_with_matches: withMatches,
      symptom_detail_hidden_count: hiddenCount
    }
  });
  logEvent("symptom_detail_candidates_calculated", {
    userId,
    chatId: ctx.chat?.id ?? null,
    selectedSymptomCategory: categoryId,
    symptom_detail_candidates_total: totalDetails,
    symptom_detail_candidates_with_matches: withMatches,
    symptom_detail_hidden_count: hiddenCount
  });
  await ctx.answerCbQuery(getSymptomCategoryLabel(categoryId, locale));
  if (withMatches === 0) {
    stepMap.set(userId, "symptoms_manual");
    await ctx.reply(
      t(locale, "wizard.prompt.noMatches"),
      Markup.inlineKeyboard([
        [Markup.button.callback(t(locale, "wizard.symptom.manual"), "manual_drug_input")],
        [Markup.button.callback(t(locale, "wizard.nav.back"), "symcat_back")]
      ])
    );
    return;
  }
  await ctx.reply(
    t(locale, "wizard.prompt.detailForCategory", { category: getSymptomCategoryLabel(categoryId, locale) }),
    buildSymptomDetailKeyboard(locale, categoryId, context, availableDetails)
  );
});

bot.action(/symdet_manual_(fever|cough|throat|runny|pain|allergy|other)/, async (ctx) => {
  const locale = getUserLocale(ctx);
  const userId = ctx.from.id;
  if (!(await guardCallbackFlowStep(ctx, userId, "symdet_manual", ["symptoms_detail"]))) {
    return;
  }
  const categoryId = ctx.match[1];
  stepMap.set(userId, "symptoms_manual");
  touchSessionState(userId);
  logEvent("symptom_manual_entered", {
    userId,
    chatId: ctx.chat?.id ?? null,
    currentStep: "symptoms_manual",
    selectedSymptomCategory: categoryId
  });
  await ctx.answerCbQuery(t(locale, "wizard.cb.manualInput"));
  await ctx.reply(t(locale, "wizard.prompt.describeManual"));
});

bot.action(/symdet_(fever|cough|throat|runny|pain|allergy|other)_(\d+)/, async (ctx) => {
  const locale = getUserLocale(ctx);
  const userId = ctx.from.id;
  if (!(await guardCallbackFlowStep(ctx, userId, "symdet_select", ["symptoms_detail"]))) {
    return;
  }
  const categoryId = ctx.match[1];
  const detailIndex = Number.parseInt(ctx.match[2], 10);
  const symptomText = (SYMPTOM_DETAILS[categoryId] || [])[detailIndex] || "";
  if (!symptomText) {
    await ctx.answerCbQuery(t(locale, "wizard.cb.symptomUnknown"));
    return;
  }

  logEvent("button_clicked", {
    userId,
    chatId: ctx.chat?.id ?? null,
    buttonKey: "symptom_select",
    scope: "symptom_select",
    value: symptomText
  });

  logEvent("symptom_detail_selected", {
    userId,
    chatId: ctx.chat?.id ?? null,
    currentStep: "symptoms_detail",
    selectedSymptomCategory: categoryId,
    selectedSymptom: symptomText
  });
  await ctx.answerCbQuery(getSymptomDetailLabel(locale, categoryId, detailIndex, symptomText));
  await showDrugSuggestionsBySymptom(ctx, userId, symptomText);
});

bot.action("manual_drug_input", async (ctx) => {
  const locale = getUserLocale(ctx);
  const userId = ctx.from.id;
  if (
    !(await guardCallbackFlowStep(ctx, userId, "manual_drug_input", [
      "symptoms_category",
      "symptoms_detail",
      "symptoms_manual",
      "medications"
    ]))
  ) {
    return;
  }
  stepMap.set(userId, "medications");
  touchSessionState(userId);
  clearAwaitingSuggestion(userId, true);
  logEvent("drug_manual_entered", {
    userId,
    chatId: ctx.chat?.id ?? null,
    currentStep: "medications",
    draftSnapshot: getDraftSnapshot(userId)
  });
  await ctx.answerCbQuery(t(locale, "wizard.cb.manualInput"));
  await ctx.reply(t(locale, "wizard.prompt.enterDrug"));
});

bot.action(/drug_select_(.+)/, async (ctx) => {
  const locale = getUserLocale(ctx);
  const userId = ctx.from.id;
  if (!(await guardCallbackFlowStep(ctx, userId, "drug_select", ["medications"]))) {
    return;
  }
  const drugId = ctx.match[1];
  const drug = DRUGS.find((item) => item.id === drugId);
  if (!drug) {
    logEvent("drug_lookup_fail", { userId, chatId: ctx.chat?.id ?? null, selectedDrugId: drugId });
    await ctx.answerCbQuery(t(locale, "wizard.cb.drugNotFound"));
    await ctx.reply(t(locale, "wizard.prompt.localNotFound"));
    return;
  }

  logEvent("button_clicked", {
    userId,
    chatId: ctx.chat?.id ?? null,
    buttonKey: "drug_select",
    scope: "drug_select",
    value: drug.name
  });
  logEvent("drug_selected", {
    userId,
    chatId: ctx.chat?.id ?? null,
    currentStep: "medications",
    selectedDrugId: drug.id,
    selectedDrugName: drug.name
  });
  await ctx.answerCbQuery(drug.name);
  await renderSingleDrugCard(ctx, userId, drug);
});

bot.action(/add_more_drug_(.+)/, async (ctx) => {
  const locale = getUserLocale(ctx);
  const userId = ctx.from.id;
  if (!(await guardCallbackFlowStep(ctx, userId, "add_more_drug", ["medications"]))) {
    return;
  }
  const drugId = ctx.match[1];
  const drug = DRUGS.find((item) => item.id === drugId);
  if (!drug) {
    await ctx.answerCbQuery(t(locale, "wizard.cb.drugNotFound"));
    return;
  }
  const nextInput = appendDrugToDraftInput(userId, drug.name);
  const draft = draftMap.get(userId) || {};
  draft.appendMode = true;
  draft.analysisPathHint = "add_more_entrypoint";
  draftMap.set(userId, draft);
  stepMap.set(userId, "medications");
  touchSessionState(userId);
  logEvent("add_another_drug_clicked", {
    userId,
    chatId: ctx.chat?.id ?? null,
    currentStep: "medications",
    selectedDrugId: drug.id,
    selectedDrugName: drug.name,
    draftSnapshot: getDraftSnapshot(userId)
  });
  logEvent("add_more_started", {
    userId,
    chatId: ctx.chat?.id ?? null,
    medications_before_merge: (nextInput || "").split(",").map((x) => x.trim()).filter(Boolean)
  });
  logEvent("preview_debug_field", {
    userId,
    chatId: ctx.chat?.id ?? null,
    selectedDrugId: drug.id,
    sourceFieldName: "medicationsInput",
    rawFieldValue: nextInput,
    cleanedValue: nextInput
  });
  await ctx.answerCbQuery(t(locale, "wizard.cb.addSecondDrug"));
  await ctx.reply(
    t(locale, "wizard.prompt.enterSecondDrug", { drug: drug.name, list: nextInput }),
    Markup.inlineKeyboard([
      [Markup.button.callback(t(locale, "wizard.button.manualEntry"), "add_more_manual")],
      [Markup.button.callback(t(locale, "wizard.cb.selectBySymptom"), "add_more_symptom")],
      [Markup.button.callback(t(locale, "wizard.nav.back"), "symcat_back")]
    ])
  );
});

bot.action(/check_combo_(.+)/, async (ctx) => {
  const locale = getUserLocale(ctx);
  const userId = ctx.from.id;
  if (!(await guardCallbackFlowStep(ctx, userId, "check_combo", ["medications"]))) {
    return;
  }
  const drugId = ctx.match[1];
  const drug = DRUGS.find((item) => item.id === drugId);
  if (!drug) {
    await ctx.answerCbQuery(t(locale, "wizard.cb.drugNotFound"));
    return;
  }
  appendDrugToDraftInput(userId, drug.name);
  const draft = draftMap.get(userId) || {};
  const analysisPath =
    draft.analysisPathHint === "add_more_symptom"
      ? "add_more_symptom_drug_select_check_combo"
      : draft.analysisPathHint === "add_more_manual"
      ? "manual_second_drug_input_check_combo"
      : "check_combo_callback";
  stepMap.set(userId, "medications");
  touchSessionState(userId);
  logEvent("button_clicked", {
    userId,
    chatId: ctx.chat?.id ?? null,
    buttonKey: "analysis_start",
    scope: "analysis_start",
    value: drug.name
  });
  logEvent("combination_check_started", {
    userId,
    chatId: ctx.chat?.id ?? null,
    currentStep: "medications",
    selectedDrugId: drug.id,
    selectedDrugName: drug.name,
    draftSnapshot: getDraftSnapshot(userId)
  });
  await ctx.answerCbQuery(t(locale, "wizard.cb.checking"));
  await runAnalysisForCurrentDraft(ctx, userId, analysisPath);
});

bot.action("add_more_manual", async (ctx) => {
  const locale = getUserLocale(ctx);
  const userId = ctx.from.id;
  if (!(await guardCallbackFlowStep(ctx, userId, "add_more_manual", ["medications"]))) {
    return;
  }
  const draft = draftMap.get(userId) || {};
  draft.appendMode = true;
  draft.analysisPathHint = "add_more_manual";
  draftMap.set(userId, draft);
  stepMap.set(userId, "medications");
  touchSessionState(userId);
  await ctx.answerCbQuery(t(locale, "wizard.cb.manualInput"));
  await ctx.reply(t(locale, "wizard.prompt.enterDrugAgain"));
});

bot.action("add_more_symptom", async (ctx) => {
  const locale = getUserLocale(ctx);
  const userId = ctx.from.id;
  if (!(await guardCallbackFlowStep(ctx, userId, "add_more_symptom", ["medications"]))) {
    return;
  }
  const draft = draftMap.get(userId) || {};
  draft.appendMode = true;
  draft.analysisPathHint = "add_more_symptom";
  draftMap.set(userId, draft);
  clearAwaitingSuggestion(userId, true);
  logEvent("add_more_symptom_clicked", {
    userId,
    chatId: ctx.chat?.id ?? null,
    currentStep: stepMap.get(userId) || "idle",
    draftSnapshot: getDraftSnapshot(userId)
  });
  logEvent("append_mode_state", {
    userId,
    chatId: ctx.chat?.id ?? null,
    append_mode: Boolean(draft.appendMode),
    existing_medications: (draft.medicationsInput || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
  });
  logEvent("symptom_flow_entered_from_append", {
    userId,
    chatId: ctx.chat?.id ?? null,
    currentStep: "symptoms_category",
    append_mode: true
  });
  await ctx.answerCbQuery(t(locale, "wizard.cb.symptomMode"));
  await showSymptomCategoryStep(ctx, userId);
});

bot.action(/buy_drug_(.+)/, async (ctx) => {
  const locale = getUserLocale(ctx);
  const userId = ctx.from.id;
  const drugId = ctx.match[1];
  const drug = DRUGS.find((item) => item.id === drugId);
  if (!drug) {
  await ctx.answerCbQuery(t(locale, "wizard.cb.drugNotFound"));
    return;
  }

  const buyLink = getArzonAptekaDrugLink(drug, locale);
  logEvent("button_clicked", {
    userId,
    chatId: ctx.chat?.id ?? null,
    buttonKey: "buy_click",
    scope: "buy_click",
    value: drug.name
  });
  logEvent("buy_clicked", {
    userId,
    chatId: ctx.chat?.id ?? null,
    drugId: drug.id,
    drugName: drug.name,
    currentStep: stepMap.get(userId) || "idle"
  });
  await ctx.answerCbQuery(t(locale, "buy.opening"));
  await ctx.reply(
    t(locale, "buy.transition", { name: getNormalizedDrugQuery(drug) }),
    Markup.inlineKeyboard([[Markup.button.url(t(locale, "buy.button"), buyLink)]])
  );
});

bot.action("buy_from_current", async (ctx) => {
  const locale = getUserLocale(ctx);
  const userId = ctx.from.id;
  const draft = draftMap.get(userId) || {};
  const meds = resolveMedicationsFromInput((draft.medicationsInput || "").trim());
  const first = meds[0];
  if (!first) {
    await ctx.answerCbQuery(t(locale, "buy.missingDrug"));
    return;
  }
  const drug =
    DRUGS.find((item) => normalizeMedicationQuery(item.name) === normalizeMedicationQuery(first.name)) || null;
  if (!drug) {
  await ctx.answerCbQuery(t(locale, "wizard.cb.drugNotFound"));
    return;
  }
  const buyLink = getArzonAptekaDrugLink(drug, locale);
  logEvent("button_clicked", {
    userId,
    chatId: ctx.chat?.id ?? null,
    buttonKey: "buy_click",
    scope: "buy_click",
    value: drug.name
  });
  logEvent("buy_clicked", {
    userId,
    chatId: ctx.chat?.id ?? null,
    drugId: drug.id,
    drugName: drug.name,
    currentStep: stepMap.get(userId) || "idle"
  });
  await ctx.answerCbQuery(t(locale, "buy.opening"));
  await ctx.reply(
    t(locale, "buy.transition", { name: getNormalizedDrugQuery(drug) }),
    Markup.inlineKeyboard([[Markup.button.url(t(locale, "buy.button"), buyLink)]])
  );
});

bot.action(/buy_card_(.+)/, async (ctx) => {
  const locale = getUserLocale(ctx);
  const userId = ctx.from.id;
  const cardId = ctx.match[1];
  const card = getFamilyCard(cardId);
  if (!card || card.medications.length === 0) {
    await ctx.answerCbQuery(t(locale, "buy.cardNotFound"));
    return;
  }

  const firstName = card.medications[0] || "";
  const normalized = normalizeDrug(firstName) || firstName;
  const drug = DRUGS.find((item) => normalizeMedicationQuery(item.name) === normalizeMedicationQuery(normalized));
  if (!drug) {
  await ctx.answerCbQuery(t(locale, "wizard.cb.drugNotFound"));
    await ctx.reply(t(locale, "buy.cardDrugMissing"));
    return;
  }

  const buyLink = getArzonAptekaDrugLink(drug, locale);
  logEvent("button_clicked", {
    userId,
    chatId: ctx.chat?.id ?? null,
    buttonKey: "buy_click",
    scope: "buy_click",
    value: drug.name
  });
  logEvent("buy_clicked", {
    userId,
    chatId: ctx.chat?.id ?? null,
    drugId: drug.id,
    drugName: drug.name,
    currentStep: stepMap.get(userId) || "idle"
  });
  await ctx.answerCbQuery(t(locale, "buy.opening"));
  await ctx.reply(
    t(locale, "buy.transition", { name: getNormalizedDrugQuery(drug) }),
    Markup.inlineKeyboard([[Markup.button.url(t(locale, "buy.button"), buyLink)]])
  );
});

bot.action(/select_med_(\d+)_(\d+)/, async (ctx) => {
  try {
    const locale = getUserLocale(ctx);
    const userId = ctx.from.id;
    if (resetIfStateTimedOut(userId)) {
      await ctx.answerCbQuery(t(locale, "wizard.error.sessionExpired"));
      return;
    }

    const medIndex = Number(ctx.match[1]);
    const callbackVersion = Number(ctx.match[2]);
    const session = getOrCreateSessionState(userId);

    if (!session.awaitingSuggestion || callbackVersion !== session.version) {
      console.info("stale_callback_ignored:", {
        userId,
        callbackVersion,
        currentVersion: session.version,
        awaitingSuggestion: session.awaitingSuggestion
      });
      await ctx.answerCbQuery(t(locale, "wizard.error.buttonExpired"));
      return;
    }

    const selected = MEDS[medIndex];

    if (!selected) {
      await ctx.answerCbQuery(t(locale, "wizard.cb.drugNotFound"));
      return;
    }
    logEvent("button_clicked", {
      userId,
      chatId: ctx.chat?.id ?? null,
      buttonKey: "drug_select",
      scope: "drug_select",
      value: selected
    });

    const draft = draftMap.get(userId) || {};
    const currentInput = (draft.medicationsInput || "").trim();
    const parts = currentInput ? currentInput.split(",") : [""];
    const lastRaw = parts[parts.length - 1] || "";
    const parsedLast = extractDosage(lastRaw);
    const selectedWithDosage = parsedLast.dosage?.normalized ? `${selected} ${parsedLast.dosage.normalized}` : selected;
    parts[parts.length - 1] = selectedWithDosage;
    const nextInput = parts.map((p) => p.trim()).filter((p) => p.length > 0).join(", ");

    draft.medicationsInput = nextInput;
    draftMap.set(userId, draft);
    clearAwaitingSuggestion(userId, true);

    await ctx.answerCbQuery(t(locale, "wizard.cb.selected", { value: selected }));
    await ctx.reply(
      t(locale, "wizard.prompt.selectedAdded", {
        value: parsedLast.dosage?.normalized ? `${selected} (${parsedLast.dosage.normalized})` : selected,
        list: nextInput
      })
    );
  } catch (error) {
    console.error("select_med action failed", error);
    logEvent("callback_error", {
      userId: ctx.from.id,
      chatId: ctx.chat?.id ?? null,
      callbackData: "select_med",
      errorMessage: error instanceof Error ? error.message : String(error)
    });
    resetConversationState(ctx.from.id, "select_med_unhandled_exception");
    try {
      await ctx.answerCbQuery(t(getUserLocale(ctx), "wizard.error.selectFailed"));
      await showAgeStep(ctx, ctx.from.id);
    } catch {
      // ignore
    }
  }
});

bot.action(/select_med_(\d+)$/, async (ctx) => {
  const locale = getUserLocale(ctx);
  console.info("stale_callback_ignored:", { userId: ctx.from.id, reason: "legacy_select_callback" });
  try {
    await ctx.answerCbQuery(t(locale, "wizard.error.buttonExpired"));
  } catch (error) {
    console.error("legacy select callback handling failed", error);
  }
});

bot.action(/confirm_med_yes_(\d+)/, async (ctx) => {
  try {
    const locale = getUserLocale(ctx);
    const userId = ctx.from.id;
    if (resetIfStateTimedOut(userId)) {
      await ctx.answerCbQuery(t(locale, "wizard.error.sessionExpired"));
      return;
    }

    const callbackVersion = Number(ctx.match[1]);
    const session = getOrCreateSessionState(userId);
    if (!session.awaitingSuggestion || callbackVersion !== session.version) {
      console.info("stale_callback_ignored:", {
        userId,
        callbackVersion,
        currentVersion: session.version,
        awaitingSuggestion: session.awaitingSuggestion,
        reason: "confirm_yes_stale"
      });
      await ctx.answerCbQuery(t(locale, "wizard.error.buttonInactive"));
      return;
    }

    const draft = draftMap.get(userId) || {};
    const selected = draft.pendingLocalCandidate;
    if (!selected) {
      clearAwaitingSuggestion(userId, true);
      await ctx.answerCbQuery(t(locale, "wizard.error.confirmExpired"));
      return;
    }

    const sourceInput = (draft.pendingLocalCandidateInput || draft.medicationsInput || "").trim();
    const parts = sourceInput ? sourceInput.split(",") : [""];
    const lastRaw = parts[parts.length - 1] || "";
    const parsedLast = extractDosage(lastRaw);
    const selectedWithDosage = parsedLast.dosage?.normalized ? `${selected} ${parsedLast.dosage.normalized}` : selected;
    parts[parts.length - 1] = selectedWithDosage;
    const nextInput = parts.map((p) => p.trim()).filter(Boolean).join(", ");

    draft.medicationsInput = nextInput;
    delete draft.pendingLocalCandidate;
    delete draft.pendingLocalCandidateInput;
    draftMap.set(userId, draft);
    clearAwaitingSuggestion(userId, true);

    await ctx.answerCbQuery(t(locale, "wizard.cb.selected", { value: selected }));
    await ctx.reply(
      t(locale, "wizard.prompt.selectedAdded", {
        value: parsedLast.dosage?.normalized ? `${selected} (${parsedLast.dosage.normalized})` : selected,
        list: nextInput
      })
    );
  } catch (error) {
    console.error("confirm_med_yes action failed", error);
    logEvent("callback_error", {
      userId: ctx.from.id,
      chatId: ctx.chat?.id ?? null,
      callbackData: "confirm_med_yes",
      errorMessage: error instanceof Error ? error.message : String(error)
    });
    resetConversationState(ctx.from.id, "confirm_med_yes_unhandled_exception");
    try {
      await ctx.answerCbQuery(t(getUserLocale(ctx), "wizard.error.genericRestart"));
      await showAgeStep(ctx, ctx.from.id);
    } catch {
      // ignore
    }
  }
});

bot.action(/confirm_med_no_(\d+)/, async (ctx) => {
  try {
    const locale = getUserLocale(ctx);
    const userId = ctx.from.id;
    if (resetIfStateTimedOut(userId)) {
      await ctx.answerCbQuery(t(locale, "wizard.error.sessionExpired"));
      return;
    }

    const callbackVersion = Number(ctx.match[1]);
    const session = getOrCreateSessionState(userId);
    if (!session.awaitingSuggestion || callbackVersion !== session.version) {
      console.info("stale_callback_ignored:", {
        userId,
        callbackVersion,
        currentVersion: session.version,
        awaitingSuggestion: session.awaitingSuggestion,
        reason: "confirm_no_stale"
      });
      await ctx.answerCbQuery(t(locale, "wizard.error.buttonInactive"));
      return;
    }

    const draft = draftMap.get(userId) || {};
    delete draft.pendingLocalCandidate;
    delete draft.pendingLocalCandidateInput;
    draftMap.set(userId, draft);
    clearAwaitingSuggestion(userId, true);

    await ctx.answerCbQuery(t(locale, "wizard.button.yes"));
    await ctx.reply(t(locale, "wizard.prompt.enterDrugExact"));
  } catch (error) {
    console.error("confirm_med_no action failed", error);
    logEvent("callback_error", {
      userId: ctx.from.id,
      chatId: ctx.chat?.id ?? null,
      callbackData: "confirm_med_no",
      errorMessage: error instanceof Error ? error.message : String(error)
    });
    resetConversationState(ctx.from.id, "confirm_med_no_unhandled_exception");
    try {
      await ctx.answerCbQuery(t(getUserLocale(ctx), "wizard.error.genericRestart"));
      await showAgeStep(ctx, ctx.from.id);
    } catch {
      // ignore
    }
  }
});

bot.action(/suggest_control_(not|manual|cancel)_(\d+)/, async (ctx) => {
  try {
    const locale = getUserLocale(ctx);
    const userId = ctx.from.id;
    if (resetIfStateTimedOut(userId)) {
      await ctx.answerCbQuery(t(locale, "wizard.error.sessionExpired"));
      return;
    }

    const action = ctx.match[1];
    const callbackVersion = Number(ctx.match[2]);
    const session = getOrCreateSessionState(userId);
    if (!session.awaitingSuggestion || callbackVersion !== session.version) {
      console.info("stale_callback_ignored:", {
        userId,
        callbackVersion,
        currentVersion: session.version,
        awaitingSuggestion: session.awaitingSuggestion,
        reason: "suggest_control_stale"
      });
      await ctx.answerCbQuery(t(locale, "wizard.error.buttonInactive"));
      return;
    }

    clearAwaitingSuggestion(userId, true);

    if (action === "cancel") {
      resetConversationState(userId, "suggestions_cancelled");
      await ctx.answerCbQuery(t(locale, "wizard.button.cancel"));
      await ctx.reply(t(locale, "wizard.prompt.cancelledToMenu"), buildMainMenu(getUserLocale(ctx)));
      return;
    }

    await ctx.answerCbQuery(action === "manual" ? t(locale, "wizard.cb.manualInput") : t(locale, "wizard.button.yes"));
    await ctx.reply(t(locale, "wizard.prompt.enterDrugExact"));
  } catch (error) {
    console.error("suggest_control action failed", error);
    logEvent("callback_error", {
      userId: ctx.from.id,
      chatId: ctx.chat?.id ?? null,
      callbackData: "suggest_control",
      errorMessage: error instanceof Error ? error.message : String(error)
    });
    resetConversationState(ctx.from.id, "suggest_control_unhandled_exception");
    try {
      await ctx.answerCbQuery(t(getUserLocale(ctx), "wizard.error.genericRestart"));
      await showAgeStep(ctx, ctx.from.id);
    } catch {
      // ignore
    }
  }
});

bot.action(/save_(.+)/, async (ctx) => {
  try {
    const locale = getUserLocale(ctx);
    const cardId = ctx.match[1];
    const card = getFamilyCard(cardId);

    if (!card) {
      await ctx.answerCbQuery(t(locale, "rem.card.notFound"));
      return;
    }

    if (card.userId !== ctx.from.id) {
      await ctx.answerCbQuery(t(locale, "rem.card.noAccess"));
      return;
    }

    await ctx.answerCbQuery(t(locale, "rem.card.saved"));
    await ctx.reply(t(locale, "rem.card.savedReply", { id: card.id }));
  } catch (error) {
    console.error("save action failed", error);
    try {
      await ctx.answerCbQuery(t(getUserLocale(ctx), "rem.card.saveError"));
    } catch {
      // ignore
    }
  }
});

bot.action(/remind_(.+)/, async (ctx) => {
  try {
    const locale = getUserLocale(ctx);
    const cardId = ctx.match[1];
    const card = getFamilyCard(cardId);

    if (!card) {
      await ctx.answerCbQuery(t(locale, "rem.card.notFound"));
      return;
    }

    if (card.userId !== ctx.from.id) {
      await ctx.answerCbQuery(t(locale, "rem.card.noAccess"));
      return;
    }

    reminderPromptMap.set(ctx.from.id, { cardId, createdAt: Date.now() });
    await ctx.answerCbQuery(t(locale, "rem.card.pickTime"));
    await ctx.reply(
      t(locale, "rem.card.pickDelay"),
      Markup.inlineKeyboard([
        [
          Markup.button.callback(t(locale, "rem.card.in6h"), `remind_set_${cardId}_6`),
          Markup.button.callback(t(locale, "rem.card.in12h"), `remind_set_${cardId}_12`)
        ],
        [Markup.button.callback(t(locale, "rem.card.in24h"), `remind_set_${cardId}_24`)],
        [Markup.button.callback(t(locale, "rem.reply.cancel"), `remind_cancel_${cardId}`)]
      ])
    );
  } catch (error) {
    console.error("remind action failed", error);
    try {
      await ctx.answerCbQuery(t(getUserLocale(ctx), "rem.card.remindError"));
    } catch {
      // ignore
    }
  }
});

bot.action(/remind_set_(.+)_(\d+)/, async (ctx) => {
  try {
    const locale = getUserLocale(ctx);
    const cardId = ctx.match[1];
    const hours = Number.parseInt(ctx.match[2], 10);
    const userId = ctx.from.id;
    const prompt = reminderPromptMap.get(userId);

    if (!prompt || prompt.cardId !== cardId || !Number.isInteger(hours) || hours <= 0) {
      await ctx.answerCbQuery(t(locale, "rem.card.paramsExpired"));
      return;
    }

    const card = getFamilyCard(cardId);
    if (!card || card.userId !== userId) {
      await ctx.answerCbQuery(t(locale, "rem.card.noAccessOrNotFound"));
      return;
    }

    addReminder(userId, cardId, Date.now() + hours * 60 * 60 * 1000);
    reminderPromptMap.delete(userId);
    await ctx.answerCbQuery(t(locale, "rem.card.addedCb"));
    await ctx.reply(t(locale, "rem.card.addedReply", { hours: String(hours) }));
  } catch (error) {
    console.error("remind_set action failed", error);
    try {
      await ctx.answerCbQuery(t(getUserLocale(ctx), "rem.card.remindError"));
    } catch {
      // ignore
    }
  }
});

bot.action(/remind_cancel_(.+)/, async (ctx) => {
  try {
    const locale = getUserLocale(ctx);
    const cardId = ctx.match[1];
    const userId = ctx.from.id;
    const prompt = reminderPromptMap.get(userId);
    if (prompt && prompt.cardId === cardId) {
      reminderPromptMap.delete(userId);
    }
    await ctx.answerCbQuery(t(locale, "rem.cb.cancelled"));
    await ctx.reply(t(locale, "rem.reply.notCreated"));
  } catch (error) {
    console.error("remind_cancel action failed", error);
    try {
      await ctx.answerCbQuery(t(getUserLocale(ctx), "rem.cb.error"));
    } catch {
      // ignore
    }
  }
});

bot.action("new_check", async (ctx) => {
  try {
    const locale = getUserLocale(ctx);
    resetConversationState(ctx.from.id, "new_check");
    await ctx.answerCbQuery(t(locale, "rem.card.startNewCheck"));
    await showAgeStep(ctx, ctx.from.id);
  } catch (error) {
    console.error("new_check action failed", error);
    try {
      await ctx.answerCbQuery(t(getUserLocale(ctx), "rem.cb.error"));
    } catch {
      // ignore
    }
  }
});

cron.schedule("*/5 * * * *", async () => {
  const modernReminders = getPendingReminderNotifications(Date.now());
  for (const item of modernReminders) {
    const { course, occurrence } = item;
    const locale = normalizeLocale(getReminderUser(course.userId)?.language);
    if (!shouldSendReminderNow(course.userId, Date.now())) {
      continue;
    }
    const progress = getCourseProgress(course);
    const dayLabel = progress.dayTotal
      ? `${progress.dayCurrent}/${progress.dayTotal}`
      : `${progress.dayCurrent}`;
    try {
      await bot.telegram.sendMessage(
        course.userId,
        [
          t(locale, "rem.notifications.modern.title"),
          "",
          t(locale, "rem.notifications.modern.drug", { value: course.drug.rawName }),
          t(locale, "rem.notifications.modern.dosage", { value: course.dosageText || t(locale, "rem.value.notSpecified") }),
          t(locale, "rem.notifications.modern.time", { value: occurrence.localTime }),
          t(locale, "rem.notifications.modern.day", { value: dayLabel }),
          "",
          t(locale, "rem.notifications.modern.info")
        ].join("\n"),
        Markup.inlineKeyboard([
          [Markup.button.callback(t(locale, "rem.notifications.modern.btn.take"), `rem_take_${course.id}_${occurrence.id}`)],
          [Markup.button.callback(t(locale, "rem.notifications.modern.btn.snooze"), `rem_snz_${course.id}_${occurrence.id}`)],
          [Markup.button.callback(t(locale, "rem.notifications.modern.btn.skip"), `rem_skip_${course.id}_${occurrence.id}`)],
          [Markup.button.callback(t(locale, "rem.notifications.modern.btn.open"), `rem_open_${course.id}`)]
        ])
      );
      markOccurrenceSent(course.userId, course.id, occurrence.id);
    } catch (err) {
      console.error("Не удалось отправить modern reminder:", err);
    }
  }

  const reminders = getPendingReminders(Date.now());

  for (const reminder of reminders) {
    try {
      const locale = normalizeLocale(getReminderUser(reminder.userId)?.language);
      await bot.telegram.sendMessage(
        reminder.userId,
        t(locale, "rem.notifications.legacy.text"),
        Markup.inlineKeyboard([[Markup.button.callback(t(locale, "rem.notifications.legacy.btn.check"), "new_check")]])
      );
      markReminderSent(reminder.userId, reminder.cardId);
    } catch (err) {
      console.error("Не удалось отправить напоминание:", err);
    }
  }
});

async function startBot(): Promise<void> {
  try {
    bot.catch(async (error, ctx) => {
      console.error("Global bot error", error);
      const userId = ctx.from?.id;
      logEvent("flow_error", {
        userId: userId ?? null,
        chatId: ctx.chat?.id ?? null,
        currentStep: typeof userId === "number" ? stepMap.get(userId) || "idle" : "idle",
        errorMessage: error instanceof Error ? error.message : String(error)
      });
      if (typeof userId === "number") {
        resetConversationState(userId, "global_unhandled_exception");
        try {
          await showAgeStep(ctx, userId, t(getUserLocale(ctx), "wizard.prompt.restartError"));
        } catch (replyError) {
          console.error("Failed to notify user from global error handler", replyError);
        }
      }
    });

    validateConfig();

    migrateDbSchemaOnce();
    console.info("Startup: db ready");

    await bot.launch();
    console.info("Startup: bot started successfully");
  } catch (error) {
    console.error("Startup: bot failed to start", error);
    process.exit(1);
  }
}

void startBot();

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));








