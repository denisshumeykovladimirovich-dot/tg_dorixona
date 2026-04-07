import { shortId } from "../utils/ids";
import { readDb, writeDb } from "../storage/db";

export type SafetyProfile = {
  profileId: string;
  userId: number;
  label: string;
  ageYears: number | null;
  ageKnown: boolean;
  pregnancyOrLactation: boolean;
  hasDrugAllergy: boolean;
  drugAllergyNotes: string;
  hasGiRisk: boolean;
  hasLiverRisk: boolean;
  hasKidneyRisk: boolean;
  hasChronicCondition: boolean;
  notes: string;
  createdAt: number;
  updatedAt: number;
};

function normalizeText(value: unknown, maxLen = 200): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim().slice(0, maxLen);
}

function normalizeAge(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 120) {
    return Math.trunc(value);
  }
  if (typeof value === "string") {
    const match = value.match(/\d{1,3}/);
    if (!match) {
      return null;
    }
    const parsed = Number.parseInt(match[0], 10);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 120) {
      return null;
    }
    return parsed;
  }
  return null;
}

function normalizeProfile(raw: any): SafetyProfile {
  const ageYears = normalizeAge(raw?.ageYears);
  const now = Date.now();
  return {
    profileId: normalizeText(raw?.profileId, 64) || shortId(),
    userId: Number(raw?.userId ?? 0),
    label: normalizeText(raw?.label, 64) || "Профиль",
    ageYears,
    ageKnown: typeof ageYears === "number",
    pregnancyOrLactation: Boolean(raw?.pregnancyOrLactation),
    hasDrugAllergy: Boolean(raw?.hasDrugAllergy),
    drugAllergyNotes: normalizeText(raw?.drugAllergyNotes, 160),
    hasGiRisk: Boolean(raw?.hasGiRisk),
    hasLiverRisk: Boolean(raw?.hasLiverRisk),
    hasKidneyRisk: Boolean(raw?.hasKidneyRisk),
    hasChronicCondition: Boolean(raw?.hasChronicCondition),
    notes: normalizeText(raw?.notes, 160),
    createdAt: Number.isFinite(Number(raw?.createdAt)) ? Number(raw.createdAt) : now,
    updatedAt: Number.isFinite(Number(raw?.updatedAt)) ? Number(raw.updatedAt) : now
  };
}

function readAllProfiles(): SafetyProfile[] {
  const db = readDb();
  const source = Array.isArray(db.safetyProfiles) ? db.safetyProfiles : [];
  return source.map((item) => normalizeProfile(item)).filter((item) => item.userId > 0);
}

function writeAllProfiles(profiles: SafetyProfile[]): void {
  const db = readDb();
  db.safetyProfiles = profiles.map((item) => normalizeProfile(item));
  writeDb(db);
}

export function listSafetyProfiles(userId: number): SafetyProfile[] {
  return readAllProfiles()
    .filter((item) => item.userId === userId)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function createSafetyProfile(
  input: Omit<SafetyProfile, "profileId" | "createdAt" | "updatedAt" | "ageKnown">
): SafetyProfile {
  const profiles = readAllProfiles();
  const now = Date.now();
  const ageYears = normalizeAge(input.ageYears);
  const profile: SafetyProfile = normalizeProfile({
    ...input,
    profileId: shortId(),
    ageYears,
    ageKnown: typeof ageYears === "number",
    createdAt: now,
    updatedAt: now
  });
  profiles.push(profile);
  writeAllProfiles(profiles);
  return profile;
}

export function updateSafetyProfile(
  userId: number,
  profileId: string,
  patch: Partial<Omit<SafetyProfile, "profileId" | "userId" | "createdAt" | "updatedAt">>
): SafetyProfile | null {
  const profiles = readAllProfiles();
  const index = profiles.findIndex((item) => item.userId === userId && item.profileId === profileId);
  if (index < 0) {
    return null;
  }

  const prev = profiles[index];
  const ageYears = patch.ageYears !== undefined ? normalizeAge(patch.ageYears) : prev.ageYears;
  const merged: SafetyProfile = normalizeProfile({
    ...prev,
    ...patch,
    ageYears,
    ageKnown: typeof ageYears === "number",
    updatedAt: Date.now(),
    profileId: prev.profileId,
    userId: prev.userId,
    createdAt: prev.createdAt
  });
  profiles[index] = merged;
  writeAllProfiles(profiles);
  return merged;
}

export function deleteSafetyProfile(userId: number, profileId: string): boolean {
  const profiles = readAllProfiles();
  const next = profiles.filter((item) => !(item.userId === userId && item.profileId === profileId));
  if (next.length === profiles.length) {
    return false;
  }

  const db = readDb();
  db.safetyProfiles = next.map((item) => normalizeProfile(item));
  if (db.activeSafetyProfileByUser && db.activeSafetyProfileByUser[String(userId)] === profileId) {
    delete db.activeSafetyProfileByUser[String(userId)];
  }
  writeDb(db);
  return true;
}

export function setActiveSafetyProfile(userId: number, profileId: string | null): void {
  const db = readDb();
  if (!db.activeSafetyProfileByUser || typeof db.activeSafetyProfileByUser !== "object") {
    db.activeSafetyProfileByUser = {};
  }
  if (!profileId) {
    delete db.activeSafetyProfileByUser[String(userId)];
  } else {
    db.activeSafetyProfileByUser[String(userId)] = profileId;
  }
  writeDb(db);
}

export function getActiveSafetyProfile(userId: number): SafetyProfile | null {
  const db = readDb();
  const activeId = db.activeSafetyProfileByUser?.[String(userId)];
  if (!activeId) {
    return null;
  }
  const profiles = readAllProfiles();
  const profile = profiles.find((item) => item.userId === userId && item.profileId === activeId);
  return profile || null;
}

