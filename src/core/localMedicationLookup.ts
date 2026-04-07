type LocalCatalogDrug = {
  name: string;
  synonyms: string[];
};

export type LocalLookupCandidate = {
  name: string;
  generic_name?: string;
  score?: number;
  matchType?: "exact" | "partial" | "fuzzy";
};

type LocalLookupDebug = {
  normalizedQuery: string;
  exactMatchCount: number;
  partialMatchesCount: number;
  fuzzyMatchesCount: number;
};

export type LocalLookupResult =
  | { status: "exact"; candidate: LocalLookupCandidate; debug: LocalLookupDebug }
  | { status: "confident"; candidate: LocalLookupCandidate; debug: LocalLookupDebug }
  | { status: "suggestions"; candidates: LocalLookupCandidate[]; debug: LocalLookupDebug }
  | { status: "not_found"; debug: LocalLookupDebug };

const CYRILLIC_CHARS = /[а-яё]/i;
const LATIN_CHARS = /[a-z]/i;

const LATIN_TO_CYRILLIC_MAP: Record<string, string> = {
  a: "а",
  c: "с",
  e: "е",
  h: "н",
  k: "к",
  m: "м",
  o: "о",
  p: "р",
  t: "т",
  x: "х",
  y: "у",
  b: "в"
};

function normalizeLookalikeChars(value: string): string {
  const hasCyrillic = CYRILLIC_CHARS.test(value);
  const hasLatin = LATIN_CHARS.test(value);
  if (!(hasCyrillic && hasLatin)) {
    return value;
  }

  return value
    .split("")
    .map((char) => {
      const lower = char.toLowerCase();
      const mapped = LATIN_TO_CYRILLIC_MAP[lower];
      if (!mapped) {
        return char;
      }
      return char === lower ? mapped : mapped.toUpperCase();
    })
    .join("");
}

export function normalizeMedicationQuery(input: string): string {
  const compact = input
    .toLowerCase()
    .trim()
    .replace(/[–—−]/g, "-")
    .replace(/[|;]+/g, " ")
    .replace(/[^\p{L}\p{N}\s+\-]/gu, " ")
    .replace(/\s+/g, " ");

  return normalizeLookalikeChars(compact);
}

function levenshteinDistance(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  if (a.length === 0) {
    return b.length;
  }
  if (b.length === 0) {
    return a.length;
  }

  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);

  for (let j = 0; j <= b.length; j += 1) {
    prev[j] = j;
  }

  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j += 1) {
      prev[j] = curr[j];
    }
  }

  return prev[b.length];
}

type ScoredCandidate = LocalLookupCandidate & { score: number };

function pushBestCandidate(
  map: Map<string, ScoredCandidate>,
  name: string,
  score: number,
  matchType: "exact" | "partial" | "fuzzy",
  genericName?: string
): void {
  const prev = map.get(name);
  if (!prev || score > prev.score) {
    map.set(name, {
      name,
      generic_name: genericName,
      score,
      matchType
    });
  }
}

function finalizeCandidates(map: Map<string, ScoredCandidate>): ScoredCandidate[] {
  return Array.from(map.values()).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, "ru"));
}

function buildTerms(drug: LocalCatalogDrug): string[] {
  return Array.from(new Set([drug.name, ...(drug.synonyms || [])].map((x) => normalizeMedicationQuery(x)).filter(Boolean)));
}

export function lookupLocalMedicationSmart(query: string, catalog: LocalCatalogDrug[]): LocalLookupResult {
  const normalizedQuery = normalizeMedicationQuery(query);
  const debug: LocalLookupDebug = {
    normalizedQuery,
    exactMatchCount: 0,
    partialMatchesCount: 0,
    fuzzyMatchesCount: 0
  };

  if (!normalizedQuery) {
    return { status: "not_found", debug };
  }

  const exactMap = new Map<string, ScoredCandidate>();
  for (const drug of catalog) {
    const terms = buildTerms(drug);
    if (terms.some((term) => term === normalizedQuery)) {
      pushBestCandidate(exactMap, drug.name, 1, "exact");
    }
  }
  const exactCandidates = finalizeCandidates(exactMap);
  debug.exactMatchCount = exactCandidates.length;

  // Exact priority: if we have exact local match(es), never continue to fuzzy/partial fallback logic.
  if (exactCandidates.length === 1) {
    return { status: "exact", candidate: exactCandidates[0], debug };
  }
  if (exactCandidates.length > 1) {
    return { status: "suggestions", candidates: exactCandidates.slice(0, 5), debug };
  }

  const partialMap = new Map<string, ScoredCandidate>();
  if (normalizedQuery.length >= 3) {
    for (const drug of catalog) {
      const terms = buildTerms(drug);
      for (const term of terms) {
        const isPrefix = term.startsWith(normalizedQuery);
        const isIncludes = term.includes(normalizedQuery);
        const queryContainsTerm = normalizedQuery.includes(term) && term.length >= 4;
        if (!(isPrefix || isIncludes || queryContainsTerm)) {
          continue;
        }
        const score = isPrefix ? 0.92 : isIncludes ? 0.84 : 0.8;
        pushBestCandidate(partialMap, drug.name, score, "partial");
      }
    }
  }
  const partialCandidates = finalizeCandidates(partialMap);
  debug.partialMatchesCount = partialCandidates.length;

  const fuzzyMap = new Map<string, ScoredCandidate>();
  if (normalizedQuery.length >= 4) {
    for (const drug of catalog) {
      const terms = buildTerms(drug);
      let bestScore = 0;
      for (const term of terms) {
        if (Math.abs(term.length - normalizedQuery.length) > 3) {
          continue;
        }

        const maxDist = normalizedQuery.length <= 6 ? 1 : 2;
        const dist = levenshteinDistance(normalizedQuery, term);
        if (dist > maxDist) {
          continue;
        }
        const score = 1 - dist / Math.max(normalizedQuery.length, term.length);
        if (score > bestScore) {
          bestScore = score;
        }
      }

      if (bestScore >= 0.74) {
        pushBestCandidate(fuzzyMap, drug.name, bestScore, "fuzzy");
      }
    }
  }
  const fuzzyCandidates = finalizeCandidates(fuzzyMap);
  debug.fuzzyMatchesCount = fuzzyCandidates.length;

  const mergedMap = new Map<string, ScoredCandidate>();
  for (const candidate of partialCandidates) {
    pushBestCandidate(mergedMap, candidate.name, candidate.score, candidate.matchType || "partial", candidate.generic_name);
  }
  for (const candidate of fuzzyCandidates) {
    pushBestCandidate(mergedMap, candidate.name, candidate.score, candidate.matchType || "fuzzy", candidate.generic_name);
  }
  const merged = finalizeCandidates(mergedMap);

  if (merged.length === 0) {
    return { status: "not_found", debug };
  }

  const top = merged[0];
  const second = merged[1];
  const confidentGap = second ? top.score - second.score : top.score;
  const isConfident = top.score >= 0.9 ? confidentGap >= 0.08 : merged.length === 1 && top.score >= 0.86;

  if (isConfident) {
    return { status: "confident", candidate: top, debug };
  }

  const suggestions = merged.filter((c) => c.score >= 0.74).slice(0, 5);
  if (suggestions.length >= 2 && suggestions.length <= 5) {
    return { status: "suggestions", candidates: suggestions, debug };
  }

  return { status: "not_found", debug };
}
