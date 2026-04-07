import fs from "node:fs";
import path from "node:path";
import { detectEmergencyRedFlags } from "../../src/core/emergencyRedFlagRouter";
import { routeByGoldenSymptom } from "../../src/core/goldenSymptomRouter";
import type { PatientSafetyContext } from "../../src/core/patientContextRouter";

type RuntimeCatalogDrug = { id: string; name: string };

function readJsonFile<T>(relativePath: string): T {
  const absolutePath = path.resolve(process.cwd(), relativePath);
  const raw = fs.readFileSync(absolutePath, "utf-8").replace(/^\uFEFF/, "");
  return JSON.parse(raw) as T;
}

export function getRuntimeCatalog(): RuntimeCatalogDrug[] {
  const db = readJsonFile<any[]>("src/data/drugDatabase.json");
  return db
    .map((item) => ({
      id: String(item?.id || "").trim(),
      name: String(item?.name || item?.displayName || item?.id || "").trim()
    }))
    .filter((item) => item.id.length > 0 && item.name.length > 0);
}

export function basePatientContext(ageYears: number | null): PatientSafetyContext {
  return {
    source: "none",
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

export function routeSymptom(
  symptomInput: string,
  ageYears: number | null,
  context?: PatientSafetyContext
) {
  return routeByGoldenSymptom({
    symptomInput,
    ageYears,
    patientContext: context,
    catalog: getRuntimeCatalog(),
    limit: 10
  });
}

export function evaluateSymptomPipeline(
  symptomInput: string,
  ageYears: number | null,
  context?: PatientSafetyContext
) {
  const emergency = detectEmergencyRedFlags({ symptomInput, ageYears });
  if (emergency.blockMedicationSuggestions) {
    return {
      emergencyBlocked: true,
      emergency,
      routed: null
    };
  }
  return {
    emergencyBlocked: false,
    emergency,
    routed: routeSymptom(symptomInput, ageYears, context)
  };
}

export function readArtifact<T>(relativePath: string): T {
  return readJsonFile<T>(relativePath);
}
