import EMERGENCY_RED_FLAGS from "../data/emergencyRedFlags.json";
import { normalizeMedicationQuery } from "./localMedicationLookup";

type EmergencySeverity = "urgent" | "emergency";
type EmergencyRuleType = "single_symptom" | "symptom_combination" | "age_condition" | "context_condition";
type EmergencyAction = "seek_doctor" | "seek_urgent_care" | "call_emergency";

type EmergencyRule = {
  id: string;
  label: string;
  severity: EmergencySeverity;
  type: EmergencyRuleType;
  trigger: {
    anyKeywords?: string[];
    allKeywords?: string[];
    keywordGroupsAll?: string[][];
    symptomIdsAny?: string[];
    age?: {
      minYearsInclusive?: number;
      maxYearsExclusive?: number;
    };
  };
  userFacingMessage: string;
  recommendedAction: EmergencyAction;
  blockMedicationSuggestions: boolean;
};

type EmergencyRuleset = {
  version: string;
  lastUpdated: string;
  rules: EmergencyRule[];
};

export type MatchedEmergencyRule = {
  id: string;
  label: string;
  severity: EmergencySeverity;
  recommendedAction: EmergencyAction;
  userFacingMessage: string;
  blockMedicationSuggestions: boolean;
};

export type EmergencyDetectionResult = {
  isEmergencyBlocked: boolean;
  matchedRules: MatchedEmergencyRule[];
  highestSeverity: EmergencySeverity | null;
  recommendedAction: EmergencyAction | null;
  userFacingMessage: string | null;
  blockMedicationSuggestions: boolean;
};

const RULESET = EMERGENCY_RED_FLAGS as EmergencyRuleset;

const SIMPLE_SYMPTOM_KEYWORDS: Record<string, string[]> = {
  temperature: ["температура", "жар", "лихорадка"],
  fever: ["лихорадка", "жар", "температура"],
  headache: ["головная боль"],
  vomiting: ["рвота", "тошнота и рвота"],
  allergy: ["аллергия", "аллергическая реакция"],
  dyspnea: ["одышка", "тяжело дышать", "не хватает воздуха"],
  chest_pain: ["боль в груди", "давит в груди"]
};

function normalizeText(value: string): string {
  return normalizeMedicationQuery(value || "").trim();
}

function includesKeyword(normalizedInput: string, keyword: string): boolean {
  const normalizedKeyword = normalizeText(keyword);
  if (!normalizedKeyword) {
    return false;
  }
  return normalizedInput.includes(normalizedKeyword);
}

function detectSymptomIds(normalizedInput: string): Set<string> {
  const detected = new Set<string>();
  for (const [symptomId, keywords] of Object.entries(SIMPLE_SYMPTOM_KEYWORDS)) {
    if (keywords.some((keyword) => includesKeyword(normalizedInput, keyword))) {
      detected.add(symptomId);
    }
  }
  return detected;
}

function matchesRule(rule: EmergencyRule, normalizedInput: string, ageYears: number | null, detectedSymptomIds: Set<string>): boolean {
  const trigger = rule.trigger || {};

  if (trigger.anyKeywords && trigger.anyKeywords.length > 0) {
    const anyKeywordMatched = trigger.anyKeywords.some((keyword) => includesKeyword(normalizedInput, keyword));
    if (!anyKeywordMatched) {
      return false;
    }
  }

  if (trigger.allKeywords && trigger.allKeywords.length > 0) {
    const allKeywordsMatched = trigger.allKeywords.every((keyword) => includesKeyword(normalizedInput, keyword));
    if (!allKeywordsMatched) {
      return false;
    }
  }

  if (trigger.keywordGroupsAll && trigger.keywordGroupsAll.length > 0) {
    const groupsMatched = trigger.keywordGroupsAll.every((group) => group.some((keyword) => includesKeyword(normalizedInput, keyword)));
    if (!groupsMatched) {
      return false;
    }
  }

  if (trigger.symptomIdsAny && trigger.symptomIdsAny.length > 0) {
    const symptomIdMatched = trigger.symptomIdsAny.some((symptomId) => detectedSymptomIds.has(symptomId));
    if (!symptomIdMatched) {
      return false;
    }
  }

  if (trigger.age) {
    if (ageYears === null) {
      return false;
    }
    if (typeof trigger.age.minYearsInclusive === "number" && ageYears < trigger.age.minYearsInclusive) {
      return false;
    }
    if (typeof trigger.age.maxYearsExclusive === "number" && ageYears >= trigger.age.maxYearsExclusive) {
      return false;
    }
  }

  return true;
}

function severityRank(severity: EmergencySeverity): number {
  return severity === "emergency" ? 2 : 1;
}

export function detectEmergencyRedFlags(params: { symptomInput: string; ageYears: number | null }): EmergencyDetectionResult {
  const normalizedInput = normalizeText(params.symptomInput);
  const detectedSymptomIds = detectSymptomIds(normalizedInput);

  const matchedRules = RULESET.rules
    .filter((rule) => matchesRule(rule, normalizedInput, params.ageYears, detectedSymptomIds))
    .map(
      (rule): MatchedEmergencyRule => ({
        id: rule.id,
        label: rule.label,
        severity: rule.severity,
        recommendedAction: rule.recommendedAction,
        userFacingMessage: rule.userFacingMessage,
        blockMedicationSuggestions: rule.blockMedicationSuggestions
      })
    );

  if (matchedRules.length === 0) {
    return {
      isEmergencyBlocked: false,
      matchedRules: [],
      highestSeverity: null,
      recommendedAction: null,
      userFacingMessage: null,
      blockMedicationSuggestions: false
    };
  }

  const sortedBySeverity = matchedRules.slice().sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
  const primaryRule = sortedBySeverity[0];
  const messages = Array.from(new Set(sortedBySeverity.slice(0, 2).map((rule) => rule.userFacingMessage)));
  const combinedMessage = messages.join(" ");
  const shouldBlock = sortedBySeverity.some((rule) => rule.blockMedicationSuggestions);

  return {
    isEmergencyBlocked: shouldBlock,
    matchedRules: sortedBySeverity,
    highestSeverity: primaryRule.severity,
    recommendedAction: primaryRule.recommendedAction,
    userFacingMessage: combinedMessage || primaryRule.userFacingMessage,
    blockMedicationSuggestions: shouldBlock
  };
}

export function validateEmergencyRuleset(): string[] {
  const issues: string[] = [];
  const ids = new Set<string>();

  for (const rule of RULESET.rules) {
    if (!rule.id || !rule.label) {
      issues.push(`Emergency rule missing id/label: ${JSON.stringify(rule)}`);
      continue;
    }
    if (ids.has(rule.id)) {
      issues.push(`Duplicate emergency rule id: ${rule.id}`);
    }
    ids.add(rule.id);
  }

  return issues;
}
