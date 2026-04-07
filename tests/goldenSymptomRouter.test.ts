import assert from "node:assert/strict";
import test from "node:test";
import type { PatientSafetyContext } from "../src/core/patientContextRouter";
import { readArtifact, routeSymptom } from "./helpers/safetyTestUtils";

type GoldenSymptomMap = {
  symptoms: Array<{
    symptomId: string;
    aliases: string[];
    qualityStatus: string;
    drugs: Array<{
      drugId: string;
      relationType: string;
      includeInPrimaryOutput: boolean;
      age: { ageKnown: boolean };
    }>;
  }>;
};

const map = readArtifact<GoldenSymptomMap>("src/data/goldenSymptomMap.json");

const childContext: PatientSafetyContext = {
  source: "none",
  profileLabel: null,
  ageYears: 8,
  pregnancyOrLactation: false,
  hasDrugAllergy: false,
  drugAllergyTokens: [],
  hasGiRisk: false,
  hasLiverRisk: false,
  hasKidneyRisk: false,
  hasChronicCondition: false
};

test("Golden routing: аллергия => safe routed output exists", () => {
  const routed = routeSymptom("аллергия", 25, childContext);
  assert.equal(routed.status, "ok");
  assert.ok(routed.drugs.length > 0);
});

test("Golden routing: throat-irritation/раздражение горла => unsafe blocked", () => {
  const routedA = routeSymptom("throat-irritation", 25, childContext);
  const routedB = routeSymptom("раздражение горла", 25, childContext);
  assert.equal(routedA.status, "fallback");
  assert.equal(routedA.fallbackReason, "unsafe_symptom_quality");
  assert.equal(routedB.status, "fallback");
  assert.equal(routedB.fallbackReason, "unsafe_symptom_quality");
});

test("Golden routing: сухой кашель excludes weak_inferred from output", () => {
  const routed = routeSymptom("сухой кашель", 8, childContext);
  assert.equal(routed.status, "ok");
  const dryCough = map.symptoms.find((item) => item.symptomId === "dry-cough");
  assert.ok(dryCough, "dry-cough symptom not found in golden map");
  const allowedIds = new Set(
    dryCough!.drugs
      .filter((drug) => drug.includeInPrimaryOutput && drug.relationType !== "weak_inferred" && drug.age.ageKnown)
      .map((drug) => drug.drugId)
  );
  for (const drug of routed.drugs) {
    assert.ok(allowedIds.has(drug.id), `Unexpected routed drug for dry-cough: ${drug.id}`);
  }
});

test("Golden routing: alias normalization works (harorat => temperature)", () => {
  const routed = routeSymptom("harorat", 20, childContext);
  assert.equal(routed.status, "ok");
  assert.equal(routed.matchedSymptomId, "temperature");
});
