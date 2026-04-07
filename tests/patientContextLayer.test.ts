import assert from "node:assert/strict";
import test from "node:test";
import { resolvePatientContext } from "../src/core/patientContextRouter";
import {
  createSafetyProfile,
  deleteSafetyProfile,
  getActiveSafetyProfile,
  listSafetyProfiles,
  setActiveSafetyProfile
} from "../src/core/safetyProfileEngine";
import { routeSymptom } from "./helpers/safetyTestUtils";

function makeUserId(seed: number): number {
  return 980000 + seed;
}

function cleanupUser(userId: number): void {
  for (const profile of listSafetyProfiles(userId)) {
    deleteSafetyProfile(userId, profile.profileId);
  }
  setActiveSafetyProfile(userId, null);
}

test("Patient context: hasGiRisk=true changes output for изжога", () => {
  const base = resolvePatientContext({ activeProfile: null, temporaryProfile: null, draftAgeRaw: "35" });
  const withRisk = { ...base, source: "active_profile" as const, hasGiRisk: true, profileLabel: "GI risk profile" };

  const baseline = routeSymptom("изжога", 35, base);
  const risked = routeSymptom("изжога", 35, withRisk);

  assert.ok(risked.debug.context_hard_stop_excluded_count >= baseline.debug.context_hard_stop_excluded_count);
});

test("Patient context: hasLiverRisk=true changes output for головная боль", () => {
  const base = resolvePatientContext({ activeProfile: null, temporaryProfile: null, draftAgeRaw: "35" });
  const withRisk = { ...base, source: "active_profile" as const, hasLiverRisk: true, profileLabel: "Liver risk profile" };

  const baseline = routeSymptom("головная боль", 35, base);
  const risked = routeSymptom("головная боль", 35, withRisk);

  assert.ok(risked.debug.context_hard_stop_excluded_count >= baseline.debug.context_hard_stop_excluded_count);
});

test("Patient context: pregnancy/lactation context applies conservative filtering", () => {
  const base = resolvePatientContext({ activeProfile: null, temporaryProfile: null, draftAgeRaw: "30" });
  const pregnancy = { ...base, source: "active_profile" as const, pregnancyOrLactation: true, profileLabel: "Pregnancy" };

  const baseline = routeSymptom("температура", 30, base);
  const withPregnancy = routeSymptom("температура", 30, pregnancy);

  assert.ok(withPregnancy.debug.context_hard_stop_excluded_count >= 0);
  assert.ok(withPregnancy.drugs.length <= baseline.drugs.length);
});

test("Patient context: temporary profile affects current routing", () => {
  const noProfile = resolvePatientContext({ activeProfile: null, temporaryProfile: null, draftAgeRaw: "8" });
  const tempProfile = {
    profileId: "tmp_test",
    userId: 1,
    label: "Temp child",
    ageYears: 1,
    ageKnown: true,
    pregnancyOrLactation: false,
    hasDrugAllergy: false,
    drugAllergyNotes: "",
    hasGiRisk: false,
    hasLiverRisk: false,
    hasKidneyRisk: false,
    hasChronicCondition: false,
    notes: "",
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  const temporary = resolvePatientContext({ activeProfile: null, temporaryProfile: tempProfile, draftAgeRaw: "8" });

  const baseline = routeSymptom("сухой кашель", noProfile.ageYears, noProfile);
  const tempRouted = routeSymptom("сухой кашель", temporary.ageYears, temporary);

  assert.ok(tempRouted.debug.hard_stop_excluded_count >= baseline.debug.hard_stop_excluded_count);
  assert.equal(temporary.source, "temporary_profile");
});

test("Patient context: temporary profile is not persisted", () => {
  const userId = makeUserId(1);
  cleanupUser(userId);
  const before = listSafetyProfiles(userId).length;

  const tempProfile = {
    profileId: "tmp_only",
    userId,
    label: "Temporary only",
    ageYears: 8,
    ageKnown: true,
    pregnancyOrLactation: false,
    hasDrugAllergy: false,
    drugAllergyNotes: "",
    hasGiRisk: false,
    hasLiverRisk: false,
    hasKidneyRisk: false,
    hasChronicCondition: false,
    notes: "",
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  resolvePatientContext({ activeProfile: null, temporaryProfile: tempProfile, draftAgeRaw: undefined });

  const after = listSafetyProfiles(userId).length;
  assert.equal(after, before);
});

test("Patient context: active profile is used when present", () => {
  const userId = makeUserId(2);
  cleanupUser(userId);

  try {
    const created = createSafetyProfile({
      userId,
      label: "Active test",
      ageYears: 2,
      pregnancyOrLactation: false,
      hasDrugAllergy: false,
      drugAllergyNotes: "",
      hasGiRisk: false,
      hasLiverRisk: false,
      hasKidneyRisk: false,
      hasChronicCondition: false,
      notes: ""
    });
    setActiveSafetyProfile(userId, created.profileId);
    const active = getActiveSafetyProfile(userId);
    const context = resolvePatientContext({ activeProfile: active, temporaryProfile: null, draftAgeRaw: "35" });
    assert.equal(context.source, "active_profile");
    assert.equal(context.ageYears, 2);
  } finally {
    cleanupUser(userId);
  }
});

test("Patient context: routing works without profile", () => {
  const context = resolvePatientContext({ activeProfile: null, temporaryProfile: null, draftAgeRaw: "30" });
  const routed = routeSymptom("аллергия", context.ageYears, context);
  assert.equal(routed.status, "ok");
});
