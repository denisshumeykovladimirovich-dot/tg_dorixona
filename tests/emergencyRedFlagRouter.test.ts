import assert from "node:assert/strict";
import test from "node:test";
import { detectEmergencyRedFlags } from "../src/core/emergencyRedFlagRouter";

test("Emergency: температура + возраст 0 => blocked", () => {
  const result = detectEmergencyRedFlags({ symptomInput: "температура 39", ageYears: 0 });
  assert.equal(result.blockMedicationSuggestions, true);
  assert.equal(result.isEmergencyBlocked, true);
  assert.ok(result.matchedRules.some((rule) => rule.id === "infant_fever_under_3_months"));
});

test("Emergency: одышка => blocked", () => {
  const result = detectEmergencyRedFlags({ symptomInput: "одышка и трудно дышать", ageYears: 30 });
  assert.equal(result.blockMedicationSuggestions, true);
  assert.ok(result.matchedRules.some((rule) => rule.id === "dyspnea_or_breathing_difficulty"));
});

test("Emergency: кровь в стуле => blocked", () => {
  const result = detectEmergencyRedFlags({ symptomInput: "кровь в стуле", ageYears: 42 });
  assert.equal(result.blockMedicationSuggestions, true);
  assert.ok(result.matchedRules.some((rule) => rule.id === "blood_in_stool"));
});

test("Emergency: внезапная очень сильная головная боль => blocked", () => {
  const result = detectEmergencyRedFlags({
    symptomInput: "внезапная самая сильная головная боль",
    ageYears: 34
  });
  assert.equal(result.blockMedicationSuggestions, true);
  assert.ok(result.matchedRules.some((rule) => rule.id === "severe_unusual_headache"));
});

test("Emergency: температура + возраст 8 => not blocked", () => {
  const result = detectEmergencyRedFlags({ symptomInput: "температура", ageYears: 8 });
  assert.equal(result.blockMedicationSuggestions, false);
  assert.equal(result.isEmergencyBlocked, false);
});
