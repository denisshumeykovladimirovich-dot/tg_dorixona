import GOLDEN_SYMPTOM_MAP from "../data/goldenSymptomMap.json";
import GOLDEN_DRUG_SAFETY_TOP20 from "../data/goldenDrugSafetyTop20.json";
import { normalizeMedicationQuery } from "./localMedicationLookup";
import type { PatientSafetyContext } from "./patientContextRouter";

export type GoldenQualityStatus = "ready_now" | "needs_cleanup" | "unsafe_to_use";
export type GoldenRelationType = "direct_official" | "strong_inferred" | "weak_inferred";

type GoldenDrugEntry = {
  drugId: string;
  displayName: string;
  relationType: GoldenRelationType;
  matchSource: string[];
  includeInPrimaryOutput: boolean;
  age: {
    minAgeYears: number | null;
    pediatricAllowed: boolean | null;
    adultAllowed: boolean | null;
    ageNotes: string;
    ageKnown: boolean;
  };
  redFlags: {
    absoluteContraindications: string[];
    caution: string[];
    hasReliableSafetyData: boolean;
  };
};

type GoldenSymptomNode = {
  symptomId: string;
  symptomName: string;
  aliases: string[];
  category: string;
  parentSymptom: string | null;
  childSymptoms: string[];
  qualityStatus: GoldenQualityStatus;
  drugs: GoldenDrugEntry[];
};

type GoldenSymptomMap = {
  version: string;
  source: string;
  symptoms: GoldenSymptomNode[];
};

type GoldenSafetyStatus = "validated_minimum" | "partial" | "insufficient_data";
type GoldenSafetyFlagType = "age" | "allergy" | "pregnancy" | "gi_risk" | "hepatic" | "renal" | "other";

type GoldenSafetyFlag = {
  id: string;
  label: string;
  type: GoldenSafetyFlagType;
  source: string;
  confidence: string;
};

type GoldenAbsoluteContraindication = GoldenSafetyFlag & {
  severity: "hard_stop";
};

type GoldenCautionFlag = GoldenSafetyFlag & {
  severity: "caution" | "high_caution";
};

type GoldenDrugSafetyProfile = {
  drugId: string;
  displayName: string;
  activeSubstance: string;
  safetyStatus: GoldenSafetyStatus;
  ageSafety: {
    minAgeYears: number | null;
    maxAgeYears: number | null;
    ageKnown: boolean;
    pediatricAllowed: boolean | null;
    adultAllowed: boolean | null;
    notes: string;
  };
  absoluteContraindications: GoldenAbsoluteContraindication[];
  cautionFlags: GoldenCautionFlag[];
  safetyDataCoverage: {
    hasAgeData: boolean;
    hasAbsoluteContraindications: boolean;
    hasCautionFlags: boolean;
    hasReliableSafetyData: boolean;
  };
};

type GoldenDrugSafetyTop20Map = {
  version: string;
  source: string;
  topDrugs: GoldenDrugSafetyProfile[];
};

export type RuntimeCatalogDrug = {
  id: string;
  name: string;
  safety?: {
    safetyStatus: GoldenSafetyStatus;
    cautionFlags: GoldenCautionFlag[];
    hasReliableSafetyData: boolean;
  };
};

export type GoldenFallbackReason =
  | "symptom_not_in_golden_map"
  | "unsafe_symptom_quality"
  | "age_not_provided"
  | "no_primary_candidates"
  | "no_age_eligible_primary"
  | "primary_drugs_missing_in_runtime_catalog"
  | "missing_safety_profile_all"
  | "safety_hard_stop_excluded_all";

export type GoldenSymptomRouteResult = {
  status: "ok" | "fallback";
  drugs: RuntimeCatalogDrug[];
  matchedSymptomId: string | null;
  matchedAlias: string | null;
  qualityStatus: GoldenQualityStatus | null;
  fallbackReason: GoldenFallbackReason | null;
  debug: {
    input_symptom: string;
    matched_symptom_id: string | null;
    matched_alias: string | null;
    quality_status: GoldenQualityStatus | null;
    primary_candidates_before_age: number;
    age_filtered_count: number;
    primary_output_count: number;
    safety_layer_checked: boolean;
    safety_profile_found: number;
    hard_stop_excluded_count: number;
    caution_attached_count: number;
    missing_safety_profile_count: number;
    context_hard_stop_excluded_count: number;
    context_caution_attached_count: number;
    fallback_reason: GoldenFallbackReason | null;
  };
};

const MAP = GOLDEN_SYMPTOM_MAP as GoldenSymptomMap;
const SAFETY_TOP20 = GOLDEN_DRUG_SAFETY_TOP20 as GoldenDrugSafetyTop20Map;
const SAFETY_BY_DRUG_ID = new Map(SAFETY_TOP20.topDrugs.map((profile) => [normalizeMedicationQuery(profile.drugId), profile]));

function normalizeSymptomValue(value: string): string {
  return normalizeMedicationQuery(value || "").trim();
}

type SymptomTerm = {
  normalized: string;
  raw: string;
};

function buildSymptomTerms(symptom: GoldenSymptomNode): SymptomTerm[] {
  const terms = [symptom.symptomId, symptom.symptomName, ...(symptom.aliases || [])]
    .map((term) => String(term || "").trim())
    .filter(Boolean);
  return terms.map((raw) => ({ raw, normalized: normalizeSymptomValue(raw) })).filter((term) => Boolean(term.normalized));
}

function matchSymptom(symptomInput: string): { symptom: GoldenSymptomNode; matchedAlias: string } | null {
  const normalizedInput = normalizeSymptomValue(symptomInput);
  if (!normalizedInput) {
    return null;
  }

  let best: { symptom: GoldenSymptomNode; matchedAlias: string; score: number } | null = null;

  for (const symptom of MAP.symptoms) {
    const terms = buildSymptomTerms(symptom);
    for (const term of terms) {
      let score = 0;
      if (term.normalized === normalizedInput) {
        score = 1;
      } else if (term.normalized.includes(normalizedInput) || normalizedInput.includes(term.normalized)) {
        score = 0.82;
      }

      if (score <= 0) {
        continue;
      }

      if (!best || score > best.score) {
        best = { symptom, matchedAlias: term.raw, score };
      }
    }
  }

  return best ? { symptom: best.symptom, matchedAlias: best.matchedAlias } : null;
}

export function routeByGoldenSymptom(params: {
  symptomInput: string;
  ageYears: number | null;
  catalog: RuntimeCatalogDrug[];
  patientContext?: PatientSafetyContext;
  limit?: number;
}): GoldenSymptomRouteResult {
  const limit = typeof params.limit === "number" ? Math.max(1, params.limit) : 5;
  const matched = matchSymptom(params.symptomInput);

  if (!matched) {
    return {
      status: "fallback",
      drugs: [],
      matchedSymptomId: null,
      matchedAlias: null,
      qualityStatus: null,
      fallbackReason: "symptom_not_in_golden_map",
      debug: {
        input_symptom: params.symptomInput,
        matched_symptom_id: null,
        matched_alias: null,
        quality_status: null,
        primary_candidates_before_age: 0,
        age_filtered_count: 0,
        primary_output_count: 0,
        safety_layer_checked: false,
        safety_profile_found: 0,
        hard_stop_excluded_count: 0,
        caution_attached_count: 0,
        missing_safety_profile_count: 0,
        context_hard_stop_excluded_count: 0,
        context_caution_attached_count: 0,
        fallback_reason: "symptom_not_in_golden_map"
      }
    };
  }

  const { symptom } = matched;

  if (symptom.qualityStatus === "unsafe_to_use") {
    return {
      status: "fallback",
      drugs: [],
      matchedSymptomId: symptom.symptomId,
      matchedAlias: matched.matchedAlias,
      qualityStatus: symptom.qualityStatus,
      fallbackReason: "unsafe_symptom_quality",
      debug: {
        input_symptom: params.symptomInput,
        matched_symptom_id: symptom.symptomId,
        matched_alias: matched.matchedAlias,
        quality_status: symptom.qualityStatus,
        primary_candidates_before_age: 0,
        age_filtered_count: 0,
        primary_output_count: 0,
        safety_layer_checked: false,
        safety_profile_found: 0,
        hard_stop_excluded_count: 0,
        caution_attached_count: 0,
        missing_safety_profile_count: 0,
        context_hard_stop_excluded_count: 0,
        context_caution_attached_count: 0,
        fallback_reason: "unsafe_symptom_quality"
      }
    };
  }

  const primaryCandidates = symptom.drugs.filter(
    (drug) => drug.includeInPrimaryOutput && drug.relationType !== "weak_inferred" && drug.age.ageKnown
  );

  if (primaryCandidates.length === 0) {
    return {
      status: "fallback",
      drugs: [],
      matchedSymptomId: symptom.symptomId,
      matchedAlias: matched.matchedAlias,
      qualityStatus: symptom.qualityStatus,
      fallbackReason: "no_primary_candidates",
      debug: {
        input_symptom: params.symptomInput,
        matched_symptom_id: symptom.symptomId,
        matched_alias: matched.matchedAlias,
        quality_status: symptom.qualityStatus,
        primary_candidates_before_age: 0,
        age_filtered_count: 0,
        primary_output_count: 0,
        safety_layer_checked: false,
        safety_profile_found: 0,
        hard_stop_excluded_count: 0,
        caution_attached_count: 0,
        missing_safety_profile_count: 0,
        context_hard_stop_excluded_count: 0,
        context_caution_attached_count: 0,
        fallback_reason: "no_primary_candidates"
      }
    };
  }

  if (params.ageYears === null) {
    return {
      status: "fallback",
      drugs: [],
      matchedSymptomId: symptom.symptomId,
      matchedAlias: matched.matchedAlias,
      qualityStatus: symptom.qualityStatus,
      fallbackReason: "age_not_provided",
      debug: {
        input_symptom: params.symptomInput,
        matched_symptom_id: symptom.symptomId,
        matched_alias: matched.matchedAlias,
        quality_status: symptom.qualityStatus,
        primary_candidates_before_age: primaryCandidates.length,
        age_filtered_count: 0,
        primary_output_count: 0,
        safety_layer_checked: false,
        safety_profile_found: 0,
        hard_stop_excluded_count: 0,
        caution_attached_count: 0,
        missing_safety_profile_count: 0,
        context_hard_stop_excluded_count: 0,
        context_caution_attached_count: 0,
        fallback_reason: "age_not_provided"
      }
    };
  }

  const ageYears = params.ageYears;
  const context = params.patientContext;
  const safetyCandidates = primaryCandidates;
  const catalogById = new Map(params.catalog.map((item) => [normalizeMedicationQuery(item.id), item]));
  let safetyProfileFound = 0;
  let hardStopExcludedCount = 0;
  let cautionAttachedCount = 0;
  let missingSafetyProfileCount = 0;
  let contextHardStopExcludedCount = 0;
  let contextCautionAttachedCount = 0;
  const routedDrugs: RuntimeCatalogDrug[] = [];
  for (const candidate of safetyCandidates) {
    const safetyProfile = SAFETY_BY_DRUG_ID.get(normalizeMedicationQuery(candidate.drugId));
    if (!safetyProfile) {
      missingSafetyProfileCount += 1;
      continue;
    }

    safetyProfileFound += 1;
    if (!safetyProfile.safetyDataCoverage.hasReliableSafetyData || safetyProfile.safetyStatus === "insufficient_data") {
      missingSafetyProfileCount += 1;
      continue;
    }

    const violatesAgeHardStop =
      safetyProfile.ageSafety.ageKnown &&
      typeof safetyProfile.ageSafety.minAgeYears === "number" &&
      ageYears < safetyProfile.ageSafety.minAgeYears;

    if (violatesAgeHardStop) {
      hardStopExcludedCount += 1;
      continue;
    }

    let contextHardStop = false;
    const cautionByContext: GoldenCautionFlag[] = [];
    const cautionIds = new Set(safetyProfile.cautionFlags.map((flag) => flag.id));
    const absLabels = new Set(
      safetyProfile.absoluteContraindications.map((item) => normalizeMedicationQuery(`${item.label} ${item.id}`))
    );

    if (context) {
      if (context.pregnancyOrLactation) {
        // Conservative policy: without explicit pregnancy compatibility in safety profile, exclude.
        const hasPregnancyCoverage =
          safetyProfile.absoluteContraindications.some((item) => item.type === "pregnancy") ||
          safetyProfile.cautionFlags.some((item) => item.type === "pregnancy");
        if (!hasPregnancyCoverage) {
          contextHardStop = true;
        }
      }

      if (context.hasGiRisk && cautionIds.has("gi_risk")) {
        contextHardStop = true;
      }
      if (context.hasLiverRisk && cautionIds.has("hepatic_risk")) {
        contextHardStop = true;
      }
      if (context.hasKidneyRisk && cautionIds.has("renal_risk")) {
        contextHardStop = true;
      }

      if (context.hasDrugAllergy && context.drugAllergyTokens.length > 0) {
        const haystack = normalizeMedicationQuery(
          `${safetyProfile.drugId} ${safetyProfile.displayName} ${safetyProfile.activeSubstance}`
        );
        const allergyTokenMatched = context.drugAllergyTokens.some((token) => haystack.includes(token));
        if (allergyTokenMatched || absLabels.has("гиперчувствительность к действующему веществу allergy_hypersensitivity")) {
          contextHardStop = true;
        }
      }

      if (context.hasChronicCondition) {
        cautionByContext.push({
          id: "context_chronic_condition",
          label: "Хроническое состояние: нужна очная проверка дозы и схемы",
          type: "other",
          severity: "caution",
          source: "patient_context.hasChronicCondition",
          confidence: "medium"
        });
      }
    }

    if (contextHardStop) {
      contextHardStopExcludedCount += 1;
      continue;
    }

    const runtimeDrug = catalogById.get(normalizeMedicationQuery(candidate.drugId));
    if (runtimeDrug) {
      const mergedCautions = [...safetyProfile.cautionFlags, ...cautionByContext];
      if (mergedCautions.length > 0) {
        cautionAttachedCount += 1;
      }
      if (cautionByContext.length > 0) {
        contextCautionAttachedCount += 1;
      }
      routedDrugs.push({
        ...runtimeDrug,
        safety: {
          safetyStatus: safetyProfile.safetyStatus,
          cautionFlags: mergedCautions,
          hasReliableSafetyData: safetyProfile.safetyDataCoverage.hasReliableSafetyData
        }
      });
    }
  }

  if (routedDrugs.length === 0 && missingSafetyProfileCount > 0 && hardStopExcludedCount === 0) {
    return {
      status: "fallback",
      drugs: [],
      matchedSymptomId: symptom.symptomId,
      matchedAlias: matched.matchedAlias,
      qualityStatus: symptom.qualityStatus,
      fallbackReason: "missing_safety_profile_all",
      debug: {
        input_symptom: params.symptomInput,
        matched_symptom_id: symptom.symptomId,
        matched_alias: matched.matchedAlias,
        quality_status: symptom.qualityStatus,
        primary_candidates_before_age: primaryCandidates.length,
        age_filtered_count: safetyCandidates.length - hardStopExcludedCount,
        primary_output_count: 0,
        safety_layer_checked: true,
        safety_profile_found: safetyProfileFound,
        hard_stop_excluded_count: hardStopExcludedCount,
        caution_attached_count: cautionAttachedCount,
        missing_safety_profile_count: missingSafetyProfileCount,
        context_hard_stop_excluded_count: contextHardStopExcludedCount,
        context_caution_attached_count: contextCautionAttachedCount,
        fallback_reason: "missing_safety_profile_all"
      }
    };
  }

  if (routedDrugs.length === 0 && hardStopExcludedCount > 0) {
    return {
      status: "fallback",
      drugs: [],
      matchedSymptomId: symptom.symptomId,
      matchedAlias: matched.matchedAlias,
      qualityStatus: symptom.qualityStatus,
      fallbackReason: "safety_hard_stop_excluded_all",
      debug: {
        input_symptom: params.symptomInput,
        matched_symptom_id: symptom.symptomId,
        matched_alias: matched.matchedAlias,
        quality_status: symptom.qualityStatus,
        primary_candidates_before_age: primaryCandidates.length,
        age_filtered_count: safetyCandidates.length - hardStopExcludedCount,
        primary_output_count: 0,
        safety_layer_checked: true,
        safety_profile_found: safetyProfileFound,
        hard_stop_excluded_count: hardStopExcludedCount,
        caution_attached_count: cautionAttachedCount,
        missing_safety_profile_count: missingSafetyProfileCount,
        context_hard_stop_excluded_count: contextHardStopExcludedCount,
        context_caution_attached_count: contextCautionAttachedCount,
        fallback_reason: "safety_hard_stop_excluded_all"
      }
    };
  }

  if (routedDrugs.length === 0) {
    return {
      status: "fallback",
      drugs: [],
      matchedSymptomId: symptom.symptomId,
      matchedAlias: matched.matchedAlias,
      qualityStatus: symptom.qualityStatus,
      fallbackReason: "primary_drugs_missing_in_runtime_catalog",
      debug: {
        input_symptom: params.symptomInput,
        matched_symptom_id: symptom.symptomId,
        matched_alias: matched.matchedAlias,
        quality_status: symptom.qualityStatus,
        primary_candidates_before_age: primaryCandidates.length,
        age_filtered_count: safetyCandidates.length - hardStopExcludedCount,
        primary_output_count: 0,
        safety_layer_checked: true,
        safety_profile_found: safetyProfileFound,
        hard_stop_excluded_count: hardStopExcludedCount,
        caution_attached_count: cautionAttachedCount,
        missing_safety_profile_count: missingSafetyProfileCount,
        context_hard_stop_excluded_count: contextHardStopExcludedCount,
        context_caution_attached_count: contextCautionAttachedCount,
        fallback_reason: "primary_drugs_missing_in_runtime_catalog"
      }
    };
  }

  return {
    status: "ok",
    drugs: routedDrugs.slice(0, limit),
    matchedSymptomId: symptom.symptomId,
    matchedAlias: matched.matchedAlias,
    qualityStatus: symptom.qualityStatus,
    fallbackReason: null,
    debug: {
      input_symptom: params.symptomInput,
      matched_symptom_id: symptom.symptomId,
      matched_alias: matched.matchedAlias,
      quality_status: symptom.qualityStatus,
      primary_candidates_before_age: primaryCandidates.length,
      age_filtered_count: safetyCandidates.length - hardStopExcludedCount,
      primary_output_count: Math.min(routedDrugs.length, limit),
      safety_layer_checked: true,
      safety_profile_found: safetyProfileFound,
      hard_stop_excluded_count: hardStopExcludedCount,
      caution_attached_count: cautionAttachedCount,
      missing_safety_profile_count: missingSafetyProfileCount,
      context_hard_stop_excluded_count: contextHardStopExcludedCount,
      context_caution_attached_count: contextCautionAttachedCount,
      fallback_reason: null
    }
  };
}

export function validateGoldenSymptomMapRuntime(runtimeDrugIds: string[]): string[] {
  const issues: string[] = [];
  const runtimeSet = new Set(runtimeDrugIds.map((id) => normalizeMedicationQuery(id)));
  const seenSymptomIds = new Set<string>();
  const aliasToSymptom = new Map<string, string>();
  const symptomById = new Map(MAP.symptoms.map((symptom) => [symptom.symptomId, symptom]));

  function isParentChildPair(a: string, b: string): boolean {
    const first = symptomById.get(a);
    const second = symptomById.get(b);
    if (!first || !second) {
      return false;
    }
    return first.parentSymptom === second.symptomId || second.parentSymptom === first.symptomId;
  }

  for (const symptom of MAP.symptoms) {
    if (!symptom.symptomId || !symptom.symptomName) {
      issues.push(`Symptom entry missing id/name: ${JSON.stringify({ symptomId: symptom.symptomId, symptomName: symptom.symptomName })}`);
      continue;
    }

    if (seenSymptomIds.has(symptom.symptomId)) {
      issues.push(`Duplicate symptomId: ${symptom.symptomId}`);
    }
    seenSymptomIds.add(symptom.symptomId);

    const localAliases = symptom.aliases || [];
    const localAliasSet = new Set<string>();
    for (const alias of localAliases) {
      const normalized = normalizeSymptomValue(alias);
      if (!normalized) {
        continue;
      }
      if (normalized.length <= 2) {
        continue;
      }
      if (localAliasSet.has(normalized)) {
        issues.push(`Duplicate alias inside symptom '${symptom.symptomId}': ${alias}`);
      }
      localAliasSet.add(normalized);

      const existingSymptomId = aliasToSymptom.get(normalized);
      if (
        existingSymptomId &&
        existingSymptomId !== symptom.symptomId &&
        !isParentChildPair(existingSymptomId, symptom.symptomId)
      ) {
        issues.push(`Alias collision between symptoms '${existingSymptomId}' and '${symptom.symptomId}': ${alias}`);
      } else if (!existingSymptomId) {
        aliasToSymptom.set(normalized, symptom.symptomId);
      }
    }

    if (symptom.qualityStatus === "unsafe_to_use") {
      const unsafePrimary = symptom.drugs.filter((drug) => drug.includeInPrimaryOutput);
      if (unsafePrimary.length > 0) {
        issues.push(`unsafe_to_use symptom '${symptom.symptomId}' has primary drugs enabled`);
      }
    }

    for (const drug of symptom.drugs) {
      if (drug.includeInPrimaryOutput && drug.relationType === "weak_inferred") {
        issues.push(`Primary drug '${drug.drugId}' in '${symptom.symptomId}' has weak_inferred relation`);
      }
      if (drug.includeInPrimaryOutput && !drug.age.ageKnown) {
        issues.push(`Primary drug '${drug.drugId}' in '${symptom.symptomId}' has unknown age`);
      }
      if (drug.includeInPrimaryOutput && !runtimeSet.has(normalizeMedicationQuery(drug.drugId))) {
        issues.push(`Primary drug '${drug.drugId}' in '${symptom.symptomId}' is missing in runtime catalog`);
      }
    }
  }

  return issues;
}

export function validateGoldenDrugSafetyTop20Runtime(runtimeDrugIds: string[]): string[] {
  const issues: string[] = [];
  const runtimeSet = new Set(runtimeDrugIds.map((id) => normalizeMedicationQuery(id)));
  const seen = new Set<string>();

  for (const profile of SAFETY_TOP20.topDrugs) {
    const normalizedId = normalizeMedicationQuery(profile.drugId);
    if (!normalizedId) {
      issues.push("Safety profile missing drugId");
      continue;
    }
    if (seen.has(normalizedId)) {
      issues.push(`Duplicate safety profile for drugId '${profile.drugId}'`);
    }
    seen.add(normalizedId);

    if (!runtimeSet.has(normalizedId)) {
      issues.push(`Safety profile drug '${profile.drugId}' is missing in runtime catalog`);
    }

    if (!profile.ageSafety.ageKnown && profile.safetyStatus !== "insufficient_data") {
      issues.push(`Safety profile '${profile.drugId}' has unknown age but non-insufficient status '${profile.safetyStatus}'`);
    }
  }

  return issues;
}
