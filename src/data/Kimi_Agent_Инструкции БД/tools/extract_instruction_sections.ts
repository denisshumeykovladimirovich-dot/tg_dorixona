/**
 * Instruction Section Extractor Tool
 * 
 * Разбивает официальные инструкции по препаратам на стандартизированные разделы.
 * Поддерживает русский (RU) и узбекский (UZ) языки.
 * 
 * @module extract_instruction_sections
 */

// ============================================================================
// TYPES AND INTERFACES
// ============================================================================

/**
 * Supported languages for instruction parsing
 */
export type Language = 'ru' | 'uz';

/**
 * Standard instruction sections
 */
export type SectionName = 
  | 'composition'
  | 'indications'
  | 'contraindications'
  | 'dosageAndAdministration'
  | 'sideEffects'
  | 'interactions'
  | 'specialWarnings'
  | 'pregnancy'
  | 'lactation'
  | 'overdose'
  | 'storage';

/**
 * Confidence level for extracted fragments
 */
export type ConfidenceLevel = 'high' | 'medium' | 'low';

/**
 * Source reference metadata
 */
export interface SourceRef {
  /** URL of the source document */
  url: string;
  /** Title of the source document */
  title: string;
  /** Page number (if applicable) */
  page: number | null;
  /** Anchor/section identifier in the document */
  anchor: string;
  /** ISO timestamp when the source was retrieved */
  retrievedAt: string;
}

/**
 * Extracted text fragment with metadata
 */
export interface SourceFragment {
  /** Unique identifier for the fragment */
  fragmentId: string;
  /** Section name */
  section: SectionName;
  /** Language code */
  language: Language;
  /** Verbatim text from source */
  text: string;
  /** Source reference metadata */
  sourceRef: SourceRef;
  /** Confidence level of extraction */
  confidence: ConfidenceLevel;
  /** Whether text is verbatim from source */
  isVerbatim: true;
}

/**
 * Result of section extraction
 */
export interface SectionResult {
  /** Section name */
  section: SectionName;
  /** Whether section was found in source */
  found: boolean;
  /** Extracted fragments (empty if not found) */
  fragments: SourceFragment[];
  /** Reason if section not found */
  missingReason?: 'missing_in_source' | 'parsing_error' | 'language_not_supported';
}

/**
 * Complete extraction result for a drug instruction
 */
export interface ExtractionResult {
  /** Drug identifier */
  drugId: string;
  /** Source language */
  language: Language;
  /** Extraction timestamp */
  extractedAt: string;
  /** Results for each section */
  sections: Record<SectionName, SectionResult>;
  /** Overall extraction statistics */
  stats: {
    totalSections: number;
    foundSections: number;
    missingSections: number;
    highConfidenceFragments: number;
    mediumConfidenceFragments: number;
  };
}

/**
 * Input parameters for extraction
 */
export interface ExtractionInput {
  /** Drug identifier */
  drugId: string;
  /** Full instruction text */
  text: string;
  /** Language of the instruction */
  language: Language;
  /** Source metadata */
  sourceRef: SourceRef;
  /** Optional: custom section patterns */
  customPatterns?: Partial<Record<SectionName, RegExp[]>>;
}

// ============================================================================
// SECTION PATTERNS (RU and UZ)
// ============================================================================

/**
 * Patterns for identifying section headers in Russian
 */
const RU_SECTION_PATTERNS: Record<SectionName, RegExp[]> = {
  composition: [
    /^(?:\d+\.\s*)?(?:Состав|СОСТАВ)[\s:]*$/im,
    /^(?:\d+\.\s*)?(?:Лекарственная форма|ЛЕКАРСТВЕННАЯ ФОРМА)[\s:]*$/im,
    /^(?:\d+\.\s*)?(?:Характеристика|ХАРАКТЕРИСТИКА)[\s:]*$/im,
  ],
  indications: [
    /^(?:\d+\.\s*)?(?:Показания|ПОКАЗАНИЯ)[\s:]*$/im,
    /^(?:\d+\.\s*)?(?:Показания к применению|ПОКАЗАНИЯ К ПРИМЕНЕНИЮ)[\s:]*$/im,
  ],
  contraindications: [
    /^(?:\d+\.\s*)?(?:Противопоказания|ПРОТИВОПОКАЗАНИЯ)[\s:]*$/im,
  ],
  dosageAndAdministration: [
    /^(?:\d+\.\s*)?(?:Способ применения и дозы|СПОСОБ ПРИМЕНЕНИЯ И ДОЗЫ)[\s:]*$/im,
    /^(?:\d+\.\s*)?(?:Способ применения|СПОСОБ ПРИМЕНЕНИЯ)[\s:]*$/im,
    /^(?:\d+\.\s*)?(?:Дозировка|ДОЗИРОВКА)[\s:]*$/im,
  ],
  sideEffects: [
    /^(?:\d+\.\s*)?(?:Побочное действие|ПОБОЧНОЕ ДЕЙСТВИЕ)[\s:]*$/im,
    /^(?:\d+\.\s*)?(?:Побочные эффекты|ПОБОЧНЫЕ ЭФФЕКТЫ)[\s:]*$/im,
    /^(?:\d+\.\s*)?(?:Нежелательные эффекты|НЕЖЕЛАТЕЛЬНЫЕ ЭФФЕКТЫ)[\s:]*$/im,
  ],
  interactions: [
    /^(?:\d+\.\s*)?(?:Взаимодействие|ВЗАИМОДЕЙСТВИЕ)[\s:]*$/im,
    /^(?:\d+\.\s*)?(?:Лекарственное взаимодействие|ЛЕКАРСТВЕННОЕ ВЗАИМОДЕЙСТВИЕ)[\s:]*$/im,
  ],
  specialWarnings: [
    /^(?:\d+\.\s*)?(?:Особые указания|ОСОБЫЕ УКАЗАНИЯ)[\s:]*$/im,
    /^(?:\d+\.\s*)?(?:Меры предосторожности|МЕРЫ ПРЕДОСТОРОЖНОСТИ)[\s:]*$/im,
    /^(?:\d+\.\s*)?(?:Предупреждения|ПРЕДУПРЕЖДЕНИЯ)[\s:]*$/im,
  ],
  pregnancy: [
    /^(?:\d+\.\s*)?(?:Применение при беременности|ПРИМЕНЕНИЕ ПРИ БЕРЕМЕННОСТИ)[\s:]*$/im,
    /^(?:\d+\.\s*)?(?:Беременность|БЕРЕМЕННОСТЬ)[\s:]*$/im,
  ],
  lactation: [
    /^(?:\d+\.\s*)?(?:Применение при кормлении грудью|ПРИМЕНЕНИЕ ПРИ КОРМЛЕНИИ ГРУДЬЮ)[\s:]*$/im,
    /^(?:\d+\.\s*)?(?:Лактация|ЛАКТАЦИЯ)[\s:]*$/im,
    /^(?:\d+\.\s*)?(?:Кормление грудью|КОРМЛЕНИЕ ГРУДЬЮ)[\s:]*$/im,
  ],
  overdose: [
    /^(?:\d+\.\s*)?(?:Передозировка|ПЕРЕДОЗИРОВКА)[\s:]*$/im,
  ],
  storage: [
    /^(?:\d+\.\s*)?(?:Условия хранения|УСЛОВИЯ ХРАНЕНИЯ)[\s:]*$/im,
    /^(?:\d+\.\s*)?(?:Хранение|ХРАНЕНИЕ)[\s:]*$/im,
  ],
};

/**
 * Patterns for identifying section headers in Uzbek
 */
const UZ_SECTION_PATTERNS: Record<SectionName, RegExp[]> = {
  composition: [
    /^(?:\d+\.\s*)?(?:Tarkib|TARKIB)[\s:]*$/im,
    /^(?:\d+\.\s*)?(?:Dori shakli|DORI SHAKLI)[\s:]*$/im,
    /^(?:\d+\.\s*)?(?:Tavsifi|TAVSIFI)[\s:]*$/im,
  ],
  indications: [
    /^(?:\d+\.\s*)?(?:Ko'rsatmalar|KO'RSATMALAR)[\s:]*$/im,
    /^(?:\d+\.\s*)?(?:Qollash ko'rsatmalari|QOLLASH KO'RSATMALARI)[\s:]*$/im,
  ],
  contraindications: [
    /^(?:\d+\.\s*)?(?:Qarshi ko'rsatmalar|QARSHI KO'RSATMALAR)[\s:]*$/im,
  ],
  dosageAndAdministration: [
    /^(?:\d+\.\s*)?(?:Qollash usuli va dozalari|QOLLASH USULI VA DOZALARI)[\s:]*$/im,
    /^(?:\d+\.\s*)?(?:Qollash usuli|QOLLASH USULI)[\s:]*$/im,
    /^(?:\d+\.\s*)?(?:Dozalash|DOZALASH)[\s:]*$/im,
  ],
  sideEffects: [
    /^(?:\d+\.\s*)?(?:Yon ta'sir|YON TA'SIR)[\s:]*$/im,
    /^(?:\d+\.\s*)?(?:Yon effektlar|YON EFFEKTLAR)[\s:]*$/im,
  ],
  interactions: [
    /^(?:\d+\.\s*)?(?:O'zaro ta'sir|O'ZARO TA'SIR)[\s:]*$/im,
    /^(?:\d+\.\s*)?(?:Doriy o'zaro ta'sir|DORIY O'ZARO TA'SIR)[\s:]*$/im,
  ],
  specialWarnings: [
    /^(?:\d+\.\s*)?(?:Maxsus ko'rsatmalar|MAXSUS KO'RSATMALAR)[\s:]*$/im,
    /^(?:\d+\.\s*)?(?:Ehtiyot choralar|EHTIYOT CHORALAR)[\s:]*$/im,
  ],
  pregnancy: [
    /^(?:\d+\.\s*)?(?:Homiladorlikda qollash|HOMILADORLIKDA QOLLASH)[\s:]*$/im,
    /^(?:\d+\.\s*)?(?:Homiladorlik|HOMILADORLIK)[\s:]*$/im,
  ],
  lactation: [
    /^(?:\d+\.\s*)?(?:Emizish davrida qollash|EMIZISH DAVRIDA QOLLASH)[\s:]*$/im,
    /^(?:\d+\.\s*)?(?:Laktatsiya|LAKTATSIYA)[\s:]*$/im,
    /^(?:\d+\.\s*)?(?:Emizish|EMIZISH)[\s:]*$/im,
  ],
  overdose: [
    /^(?:\d+\.\s*)?(?:Dozani oshirish|DOZANI OSHIRISH)[\s:]*$/im,
    /^(?:\d+\.\s*)?(?:Oshiqcha doza|OSHIQCHA DOZA)[\s:]*$/im,
  ],
  storage: [
    /^(?:\d+\.\s*)?(?:Saqlash shartlari|SAQLASH SHARTLARI)[\s:]*$/im,
    /^(?:\d+\.\s*)?(?:Saqlash|SAQLASH)[\s:]*$/im,
  ],
};

/**
 * Get section patterns for specified language
 */
function getSectionPatterns(language: Language): Record<SectionName, RegExp[]> {
  return language === 'ru' ? RU_SECTION_PATTERNS : UZ_SECTION_PATTERNS;
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Generate unique fragment ID
 */
function generateFragmentId(
  drugId: string,
  section: SectionName,
  language: Language,
  index: number
): string {
  const sanitizedDrugId = drugId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `${sanitizedDrugId}-${section}-${language}-${index}`;
}

/**
 * Get current ISO timestamp
 */
function getTimestamp(): string {
  return new Date().toISOString();
}

/**
 * Normalize whitespace while preserving structure
 */
function normalizeText(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/**
 * Find all section boundaries in the text
 */
function findSectionBoundaries(
  text: string,
  patterns: Record<SectionName, RegExp[]>
): Array<{ section: SectionName; start: number; end: number; match: string }> {
  const boundaries: Array<{ section: SectionName; start: number; end: number; match: string }> = [];

  for (const [section, regexps] of Object.entries(patterns) as [SectionName, RegExp[]][]) {
    for (const regexp of regexps) {
      const matches = text.matchAll(new RegExp(regexp, 'gim'));
      for (const match of matches) {
        if (match.index !== undefined) {
          boundaries.push({
            section,
            start: match.index,
            end: match.index + match[0].length,
            match: match[0],
          });
        }
      }
    }
  }

  // Sort by position
  return boundaries.sort((a, b) => a.start - b.start);
}

/**
 * Determine confidence level based on match quality
 */
function determineConfidence(
  section: SectionName,
  text: string,
  headerMatch: string
): ConfidenceLevel {
  // High confidence: exact header match and substantial content
  const contentLength = text.length;
  const hasSubstantialContent = contentLength > 50;
  const isExactHeader = /^\d+\.\s*[А-ЯA-Z][а-яa-z\s]+$/.test(headerMatch.trim());

  if (hasSubstantialContent && isExactHeader) {
    return 'high';
  }

  // Medium confidence: has content but header might be partial match
  if (hasSubstantialContent) {
    return 'medium';
  }

  return 'low';
}

// ============================================================================
// MAIN EXTRACTION FUNCTION
// ============================================================================

/**
 * Extract sections from drug instruction text
 * 
 * @param input - Extraction parameters
 * @returns Extraction result with all sections
 * 
 * @example
 * ```typescript
 * const result = extractInstructionSections({
 *   drugId: 'paracetamol-500mg',
 *   text: instructionText,
 *   language: 'ru',
 *   sourceRef: {
 *     url: 'https://example.com/instruction.pdf',
 *     title: 'Инструкция Парацетамол',
 *     page: 1,
 *     anchor: 'section-1',
 *     retrievedAt: '2024-01-15T10:00:00Z'
 *   }
 * });
 * ```
 */
export function extractInstructionSections(input: ExtractionInput): ExtractionResult {
  const { drugId, text, language, sourceRef, customPatterns } = input;

  // Normalize input text
  const normalizedText = normalizeText(text);

  // Get patterns for the language
  const patterns = customPatterns
    ? { ...getSectionPatterns(language), ...customPatterns }
    : getSectionPatterns(language);

  // Find all section boundaries
  const boundaries = findSectionBoundaries(normalizedText, patterns);

  // Initialize result sections
  const sections: Record<SectionName, SectionResult> = {
    composition: { section: 'composition', found: false, fragments: [] },
    indications: { section: 'indications', found: false, fragments: [] },
    contraindications: { section: 'contraindications', found: false, fragments: [] },
    dosageAndAdministration: { section: 'dosageAndAdministration', found: false, fragments: [] },
    sideEffects: { section: 'sideEffects', found: false, fragments: [] },
    interactions: { section: 'interactions', found: false, fragments: [] },
    specialWarnings: { section: 'specialWarnings', found: false, fragments: [] },
    pregnancy: { section: 'pregnancy', found: false, fragments: [] },
    lactation: { section: 'lactation', found: false, fragments: [] },
    overdose: { section: 'overdose', found: false, fragments: [] },
    storage: { section: 'storage', found: false, fragments: [] },
  };

  // Group boundaries by section (take first occurrence)
  const sectionPositions = new Map<SectionName, { start: number; end: number; match: string }>();

  for (const boundary of boundaries) {
    if (!sectionPositions.has(boundary.section)) {
      sectionPositions.set(boundary.section, {
        start: boundary.start,
        end: boundary.end,
        match: boundary.match,
      });
    }
  }

  // Sort positions to extract content between sections
  const sortedPositions = Array.from(sectionPositions.entries())
    .map(([section, pos]) => ({ section, ...pos }))
    .sort((a, b) => a.start - b.start);

  // Extract content for each section
  for (let i = 0; i < sortedPositions.length; i++) {
    const current = sortedPositions[i];
    const next = sortedPositions[i + 1];

    // Content starts after the header and goes until next section or end of text
    const contentStart = current.end;
    const contentEnd = next ? next.start : normalizedText.length;
    const content = normalizedText.slice(contentStart, contentEnd).trim();

    // Skip if content is too short (likely not a real section)
    if (content.length < 10) {
      continue;
    }

    const confidence = determineConfidence(current.section, content, current.match);
    const fragmentId = generateFragmentId(drugId, current.section, language, 0);

    const fragment: SourceFragment = {
      fragmentId,
      section: current.section,
      language,
      text: content,
      sourceRef,
      confidence,
      isVerbatim: true,
    };

    sections[current.section] = {
      section: current.section,
      found: true,
      fragments: [fragment],
    };
  }

  // Mark missing sections
  for (const [sectionName, sectionResult] of Object.entries(sections) as [SectionName, SectionResult][]) {
    if (!sectionResult.found) {
      sections[sectionName] = {
        section: sectionName,
        found: false,
        fragments: [],
        missingReason: 'missing_in_source',
      };
    }
  }

  // Calculate statistics
  const allFragments = Object.values(sections).flatMap(s => s.fragments);
  const stats = {
    totalSections: Object.keys(sections).length,
    foundSections: Object.values(sections).filter(s => s.found).length,
    missingSections: Object.values(sections).filter(s => !s.found).length,
    highConfidenceFragments: allFragments.filter(f => f.confidence === 'high').length,
    mediumConfidenceFragments: allFragments.filter(f => f.confidence === 'medium').length,
  };

  return {
    drugId,
    language,
    extractedAt: getTimestamp(),
    sections,
    stats,
  };
}

// ============================================================================
// BATCH PROCESSING
// ============================================================================

/**
 * Input for batch extraction
 */
export interface BatchExtractionInput {
  items: ExtractionInput[];
}

/**
 * Result of batch extraction
 */
export interface BatchExtractionResult {
  results: ExtractionResult[];
  summary: {
    totalProcessed: number;
    successful: number;
    failed: number;
    averageSectionsFound: number;
  };
}

/**
 * Process multiple instructions in batch
 * 
 * @param input - Batch extraction parameters
 * @returns Batch extraction results
 */
export function extractInstructionSectionsBatch(
  input: BatchExtractionInput
): BatchExtractionResult {
  const results: ExtractionResult[] = [];
  let failed = 0;

  for (const item of input.items) {
    try {
      const result = extractInstructionSections(item);
      results.push(result);
    } catch (error) {
      failed++;
      console.error(`Failed to extract sections for ${item.drugId}:`, error);
    }
  }

  const totalSectionsFound = results.reduce(
    (sum, r) => sum + r.stats.foundSections,
    0
  );

  return {
    results,
    summary: {
      totalProcessed: input.items.length,
      successful: results.length,
      failed,
      averageSectionsFound: results.length > 0 ? totalSectionsFound / results.length : 0,
    },
  };
}

// ============================================================================
// VALIDATION FUNCTIONS
// ============================================================================

/**
 * Validate extraction result
 * 
 * @param result - Extraction result to validate
 * @returns Validation result
 */
export function validateExtractionResult(result: ExtractionResult): {
  valid: boolean;
  errors: string[];
  warnings: string[];
} {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Check required fields
  if (!result.drugId) {
    errors.push('Missing drugId');
  }

  if (!result.language || !['ru', 'uz'].includes(result.language)) {
    errors.push('Invalid or missing language');
  }

  if (!result.extractedAt) {
    errors.push('Missing extractedAt timestamp');
  }

  // Check sections
  const requiredSections: SectionName[] = [
    'composition',
    'indications',
    'contraindications',
    'dosageAndAdministration',
  ];

  for (const section of requiredSections) {
    const sectionResult = result.sections[section];
    if (!sectionResult.found) {
      warnings.push(`Required section '${section}' not found`);
    }
  }

  // Validate fragments
  for (const [sectionName, sectionResult] of Object.entries(result.sections) as [SectionName, SectionResult][]) {
    for (const fragment of sectionResult.fragments) {
      if (!fragment.fragmentId) {
        errors.push(`Fragment in section '${sectionName}' missing fragmentId`);
      }
      if (!fragment.text) {
        errors.push(`Fragment in section '${sectionName}' missing text`);
      }
      if (!fragment.sourceRef.url) {
        warnings.push(`Fragment in section '${sectionName}' missing source URL`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

// ============================================================================
// EXPORT FOR TESTING
// ============================================================================

export const __testing = {
  RU_SECTION_PATTERNS,
  UZ_SECTION_PATTERNS,
  generateFragmentId,
  normalizeText,
  findSectionBoundaries,
  determineConfidence,
};

// Default export
export default extractInstructionSections;
