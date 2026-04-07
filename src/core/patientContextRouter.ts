import type { SafetyProfile } from "./safetyProfileEngine";
import { normalizeMedicationQuery } from "./localMedicationLookup";

export type PatientSafetyContext = {
  source: "active_profile" | "temporary_profile" | "draft_age" | "none";
  profileLabel: string | null;
  ageYears: number | null;
  pregnancyOrLactation: boolean;
  hasDrugAllergy: boolean;
  drugAllergyTokens: string[];
  hasGiRisk: boolean;
  hasLiverRisk: boolean;
  hasKidneyRisk: boolean;
  hasChronicCondition: boolean;
};

function tokenizeAllergyNotes(notes: string): string[] {
  return normalizeMedicationQuery(notes)
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);
}

function profileToContext(profile: SafetyProfile, source: PatientSafetyContext["source"]): PatientSafetyContext {
  return {
    source,
    profileLabel: profile.label || null,
    ageYears: profile.ageKnown ? profile.ageYears : null,
    pregnancyOrLactation: profile.pregnancyOrLactation,
    hasDrugAllergy: profile.hasDrugAllergy,
    drugAllergyTokens: profile.hasDrugAllergy ? tokenizeAllergyNotes(profile.drugAllergyNotes || "") : [],
    hasGiRisk: profile.hasGiRisk,
    hasLiverRisk: profile.hasLiverRisk,
    hasKidneyRisk: profile.hasKidneyRisk,
    hasChronicCondition: profile.hasChronicCondition
  };
}

function parseAgeYears(rawAge?: string): number | null {
  if (!rawAge) {
    return null;
  }
  const match = rawAge.match(/\d+/);
  if (!match) {
    return null;
  }
  const value = Number.parseInt(match[0], 10);
  if (!Number.isFinite(value) || value < 0 || value > 120) {
    return null;
  }
  return value;
}

export function resolvePatientContext(params: {
  activeProfile: SafetyProfile | null;
  temporaryProfile: SafetyProfile | null;
  draftAgeRaw?: string;
}): PatientSafetyContext {
  if (params.temporaryProfile) {
    return profileToContext(params.temporaryProfile, "temporary_profile");
  }
  if (params.activeProfile) {
    return profileToContext(params.activeProfile, "active_profile");
  }
  const ageYears = parseAgeYears(params.draftAgeRaw);
  if (ageYears !== null) {
    return {
      source: "draft_age",
      profileLabel: null,
      ageYears,
      pregnancyOrLactation: false,
      hasDrugAllergy: false,
      drugAllergyTokens: [],
      hasGiRisk: false,
      hasLiverRisk: false,
      hasKidneyRisk: false,
      hasChronicCondition: false
    };
  }
  return {
    source: "none",
    profileLabel: null,
    ageYears: null,
    pregnancyOrLactation: false,
    hasDrugAllergy: false,
    drugAllergyTokens: [],
    hasGiRisk: false,
    hasLiverRisk: false,
    hasKidneyRisk: false,
    hasChronicCondition: false
  };
}

export function redactPatientContextForLog(context: PatientSafetyContext): Record<string, unknown> {
  return {
    source: context.source,
    hasProfileLabel: Boolean(context.profileLabel),
    ageKnown: typeof context.ageYears === "number",
    pregnancyOrLactation: context.pregnancyOrLactation,
    hasDrugAllergy: context.hasDrugAllergy,
    hasDrugAllergyTokens: context.drugAllergyTokens.length > 0,
    hasGiRisk: context.hasGiRisk,
    hasLiverRisk: context.hasLiverRisk,
    hasKidneyRisk: context.hasKidneyRisk,
    hasChronicCondition: context.hasChronicCondition
  };
}

