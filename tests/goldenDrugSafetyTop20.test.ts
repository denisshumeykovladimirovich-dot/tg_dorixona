import assert from "node:assert/strict";
import test from "node:test";
import { basePatientContext, routeSymptom } from "./helpers/safetyTestUtils";

test("Safety layer: сухой кашель, возраст 1 => age hard-stop excludes older-only drugs", () => {
  const routed = routeSymptom("сухой кашель", 1, basePatientContext(1));
  assert.equal(routed.drugs.some((drug) => drug.id === "dextromethorphan"), false);
  assert.ok(routed.debug.hard_stop_excluded_count > 0);
});

test("Safety layer: primary candidates without top-20 safety profile are excluded", () => {
  const routed = routeSymptom("температура", 8, basePatientContext(8));
  assert.equal(routed.status, "ok");
  assert.ok(routed.debug.missing_safety_profile_count > 0);
});

test("Safety layer: температура, возраст 8 => safe candidates remain", () => {
  const routed = routeSymptom("температура", 8, basePatientContext(8));
  assert.equal(routed.status, "ok");
  const ids = routed.drugs.map((drug) => drug.id);
  assert.ok(ids.includes("paracetamol"));
  assert.ok(ids.includes("ibuprofen"));
});

test("Safety layer: caution flags are attached when available", () => {
  const routed = routeSymptom("температура", 25, basePatientContext(25));
  assert.equal(routed.status, "ok");
  assert.ok(routed.drugs.some((drug) => (drug.safety?.cautionFlags?.length || 0) > 0));
  assert.ok(routed.debug.caution_attached_count > 0);
});
