import assert from "node:assert/strict";
import test from "node:test";
import { basePatientContext, evaluateSymptomPipeline } from "./helpers/safetyTestUtils";

test("Integration: emergency gate blocks pipeline before symptom routing", () => {
  const result = evaluateSymptomPipeline("одышка", 25, basePatientContext(25));
  assert.equal(result.emergencyBlocked, true);
  assert.equal(result.routed, null);
  assert.ok(result.emergency.matchedRules.length > 0);
});

test("Integration: non-emergency proceeds to golden routing + safety", () => {
  const result = evaluateSymptomPipeline("аллергия", 25, basePatientContext(25));
  assert.equal(result.emergencyBlocked, false);
  assert.ok(result.routed);
  assert.equal(result.routed!.status, "ok");
  assert.ok(result.routed!.drugs.length > 0);
});

test("Integration: profile context changes routed output but does not bypass emergency", () => {
  const noRisk = basePatientContext(35);
  const liverRisk = { ...noRisk, source: "active_profile" as const, hasLiverRisk: true, profileLabel: "Liver risk" };

  const baseline = evaluateSymptomPipeline("головная боль", 35, noRisk);
  const withRisk = evaluateSymptomPipeline("головная боль", 35, liverRisk);
  assert.equal(baseline.emergencyBlocked, false);
  assert.equal(withRisk.emergencyBlocked, false);
  assert.ok(withRisk.routed);
  assert.ok(baseline.routed);
  assert.ok(
    withRisk.routed!.debug.context_hard_stop_excluded_count >= baseline.routed!.debug.context_hard_stop_excluded_count
  );

  const emergencyWithContext = evaluateSymptomPipeline("кровь в стуле", 35, liverRisk);
  assert.equal(emergencyWithContext.emergencyBlocked, true);
  assert.equal(emergencyWithContext.routed, null);
});
