import assert from "node:assert/strict";
import test from "node:test";
import {
  validateGoldenDrugSafetyTop20Runtime,
  validateGoldenSymptomMapRuntime
} from "../src/core/goldenSymptomRouter";
import { validateEmergencyRuleset } from "../src/core/emergencyRedFlagRouter";
import {
  createSafetyProfile,
  deleteSafetyProfile,
  getActiveSafetyProfile,
  listSafetyProfiles,
  setActiveSafetyProfile
} from "../src/core/safetyProfileEngine";
import { readArtifact, routeSymptom } from "./helpers/safetyTestUtils";

type DrugDbRecord = { id: string };
type GoldenSymptomMap = {
  symptoms: Array<{
    symptomId: string;
    symptomName: string;
    parentSymptom: string | null;
    aliases: string[];
    qualityStatus: "ready_now" | "needs_cleanup" | "unsafe_to_use";
    drugs: Array<{
      drugId: string;
      relationType: "direct_official" | "strong_inferred" | "weak_inferred";
      includeInPrimaryOutput: boolean;
      age: { ageKnown: boolean };
    }>;
  }>;
};
type GoldenSafetyTop20 = { topDrugs: Array<{ drugId: string }> };
type EmergencyRuleset = {
  rules: Array<{
    id: string;
    label: string;
    severity: "urgent" | "emergency";
    type: "single_symptom" | "symptom_combination" | "age_condition" | "context_condition";
    trigger: Record<string, unknown>;
    userFacingMessage: string;
    recommendedAction: "seek_doctor" | "seek_urgent_care" | "call_emergency";
    blockMedicationSuggestions: boolean;
  }>;
};

const runtimeDb = readArtifact<DrugDbRecord[]>("src/data/drugDatabase.json");
const runtimeIds = new Set(runtimeDb.map((item) => item.id));
const goldenMap = readArtifact<GoldenSymptomMap>("src/data/goldenSymptomMap.json");
const safetyTop20 = readArtifact<GoldenSafetyTop20>("src/data/goldenDrugSafetyTop20.json");
const emergencyRules = readArtifact<EmergencyRuleset>("src/data/emergencyRedFlags.json");

test("Consistency: all golden map drugId references exist in runtime DB", () => {
  const missing: string[] = [];
  for (const symptom of goldenMap.symptoms) {
    for (const drug of symptom.drugs) {
      if (!runtimeIds.has(drug.drugId)) {
        missing.push(`${symptom.symptomId}:${drug.drugId}`);
      }
    }
  }
  assert.deepEqual(missing, []);
});

test("Consistency: all top-20 safety drug refs exist in runtime DB", () => {
  const missing = safetyTop20.topDrugs.filter((item) => !runtimeIds.has(item.drugId)).map((item) => item.drugId);
  assert.deepEqual(missing, []);
});

test("Consistency: built-in validator checks for golden map/safety/emergency are clean", () => {
  assert.deepEqual(validateGoldenSymptomMapRuntime(Array.from(runtimeIds)), []);
  assert.deepEqual(validateGoldenDrugSafetyTop20Runtime(Array.from(runtimeIds)), []);
  assert.deepEqual(validateEmergencyRuleset(), []);
});

test("Consistency: unsafe_to_use symptoms do not return primary output", () => {
  const unsafeSymptoms = goldenMap.symptoms.filter((item) => item.qualityStatus === "unsafe_to_use");
  assert.ok(unsafeSymptoms.length > 0, "Expected at least one unsafe_to_use symptom");
  for (const symptom of unsafeSymptoms) {
    const routed = routeSymptom(symptom.symptomName, 25);
    assert.equal(
      routed.status,
      "fallback",
      `unsafe_to_use symptom must fallback: ${symptom.symptomId} (${symptom.symptomName})`
    );
  }
});

test("Consistency: primary non-weak candidates missing from top-20 are excluded at runtime", () => {
  const safetyIds = new Set(safetyTop20.topDrugs.map((item) => item.drugId));
  const symptomWithMissingPrimary = goldenMap.symptoms.find((symptom) =>
    symptom.drugs.some(
      (drug) =>
        drug.includeInPrimaryOutput &&
        drug.relationType !== "weak_inferred" &&
        drug.age.ageKnown &&
        !safetyIds.has(drug.drugId)
    )
  );

  assert.ok(symptomWithMissingPrimary, "Expected at least one symptom with primary candidate outside top-20 safety");
  const missingPrimaryIds = new Set(
    symptomWithMissingPrimary!.drugs
      .filter(
        (drug) =>
          drug.includeInPrimaryOutput &&
          drug.relationType !== "weak_inferred" &&
          drug.age.ageKnown &&
          !safetyIds.has(drug.drugId)
      )
      .map((drug) => drug.drugId)
  );

  const routed = routeSymptom(symptomWithMissingPrimary!.symptomName, 30);
  for (const item of routed.drugs) {
    assert.equal(
      missingPrimaryIds.has(item.id),
      false,
      `Drug without top-20 safety profile leaked into output: ${item.id}`
    );
  }
});

test("Consistency: emergencyRedFlags.json has required structure and non-empty trigger", () => {
  for (const rule of emergencyRules.rules) {
    assert.ok(rule.id.length > 0);
    assert.ok(rule.label.length > 0);
    assert.ok(rule.userFacingMessage.length > 0);
    assert.ok(typeof rule.blockMedicationSuggestions === "boolean");
    const triggerKeys = Object.keys(rule.trigger || {});
    assert.ok(triggerKeys.length > 0, `Rule ${rule.id} has empty trigger`);
  }
});

test("Consistency: alias collisions across unrelated symptoms are not present", () => {
  const symptomById = new Map(goldenMap.symptoms.map((item) => [item.symptomId, item]));
  const aliasOwner = new Map<string, string>();
  const collisions: string[] = [];

  const isParentChildPair = (a: string, b: string): boolean => {
    const first = symptomById.get(a);
    const second = symptomById.get(b);
    if (!first || !second) {
      return false;
    }
    return first.parentSymptom === second.symptomId || second.parentSymptom === first.symptomId;
  };

  for (const symptom of goldenMap.symptoms) {
    for (const alias of symptom.aliases || []) {
      const normalized = alias.trim().toLowerCase();
      if (!normalized || normalized.length <= 2) {
        continue;
      }
      const owner = aliasOwner.get(normalized);
      if (!owner) {
        aliasOwner.set(normalized, symptom.symptomId);
        continue;
      }
      if (owner !== symptom.symptomId && !isParentChildPair(owner, symptom.symptomId)) {
        collisions.push(`${normalized}:${owner}<->${symptom.symptomId}`);
      }
    }
  }

  assert.deepEqual(collisions, []);
});

test("Consistency: active profile storage and deletion behavior works", () => {
  const userId = 989900;
  for (const profile of listSafetyProfiles(userId)) {
    deleteSafetyProfile(userId, profile.profileId);
  }
  setActiveSafetyProfile(userId, null);

  const profile = createSafetyProfile({
    userId,
    label: "Consistency profile",
    ageYears: 20,
    pregnancyOrLactation: false,
    hasDrugAllergy: false,
    drugAllergyNotes: "",
    hasGiRisk: false,
    hasLiverRisk: false,
    hasKidneyRisk: false,
    hasChronicCondition: false,
    notes: ""
  });
  setActiveSafetyProfile(userId, profile.profileId);
  const active = getActiveSafetyProfile(userId);
  assert.equal(active?.profileId, profile.profileId);

  const removed = deleteSafetyProfile(userId, profile.profileId);
  assert.equal(removed, true);
  assert.equal(getActiveSafetyProfile(userId), null);
});
