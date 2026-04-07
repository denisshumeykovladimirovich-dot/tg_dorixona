/**
 * Source Metadata Normalization Tool
 * 
 * Нормализует метаданные источников инструкций по препаратам.
 * Обеспечивает единообразие форматов URL, дат и других полей.
 * 
 * @module normalize_sources
 */

// ============================================================================
// TYPES AND INTERFACES
// ============================================================================

/**
 * Raw source input (before normalization)
 */
export interface RawSourceInput {
  /** URL or identifier of the source */
  url?: string;
  /** Title of the source document */
  title?: string;
  /** Page number (various formats) */
  page?: string | number | null;
  /** Section anchor or identifier */
  anchor?: string;
  /** Retrieval timestamp (various formats) */
  retrievedAt?: string | Date | number;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Normalized source reference
 */
export interface NormalizedSourceRef {
  /** Normalized URL */
  url: string;
  /** Normalized title */
  title: string;
  /** Normalized page number (null if not applicable) */
  page: number | null;
  /** Normalized anchor */
  anchor: string;
  /** ISO 8601 timestamp */
  retrievedAt: string;
  /** Source type classification */
  sourceType: SourceType;
  /** Reliability score (0-1) */
  reliabilityScore: number;
  /** Additional normalized metadata */
  metadata: Record<string, unknown>;
}

/**
 * Source type classification
 */
export type SourceType =
  | 'official_register'    // Официальный реестр (e.g., grls.rosminzdrav.ru)
  | 'manufacturer'         // Сайт производителя
  | 'medical_database'     // Медицинская база данных (e.g., Vidal, RLSD)
  | 'government_portal'    // Правительственный портал
  | 'pharmacy_chain'       // Сайт аптечной сети
  | 'educational'          // Образовательный ресурс
  | 'unknown';             // Неизвестный тип

/**
 * Normalization options
 */
export interface NormalizationOptions {
  /** Default URL if not provided */
  defaultUrl?: string;
  /** Default title if not provided */
  defaultTitle?: string;
  /** Validate URLs */
  validateUrls?: boolean;
  /** Extract domain metadata */
  extractDomainMetadata?: boolean;
  /** Calculate reliability score */
  calculateReliability?: boolean;
}

/**
 * Validation result
 */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

// ============================================================================
// CONSTANTS
// ============================================================================

/**
 * Known official source domains
 */
const OFFICIAL_DOMAINS = [
  'grls.rosminzdrav.ru',
  'grls.minzdrav.gov.ru',
  'registers.health.gov.uz',
  'pharmreg.uz',
  'fda.gov',
  'ema.europa.eu',
];

/**
 * Known manufacturer domains (examples)
 */
const MANUFACTURER_DOMAINS = [
  'pfizer.com',
  'novartis.com',
  'roche.com',
  'sanofi.com',
  'bayer.com',
];

/**
 * Known medical database domains
 */
const MEDICAL_DATABASE_DOMAINS = [
  'vidal.ru',
  'rlsnet.ru',
  'drugs.com',
  'medscape.com',
  'rxlist.com',
];

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Normalize URL
 * 
 * @param url - Raw URL string
 * @returns Normalized URL
 */
function normalizeUrl(url: string | undefined): string {
  if (!url || url.trim() === '') {
    return '';
  }

  let normalized = url.trim();

  // Add protocol if missing
  if (!/^https?:\/\//i.test(normalized)) {
    normalized = 'https://' + normalized;
  }

  // Remove trailing slashes
  normalized = normalized.replace(/\/$/, '');

  // Normalize encoding
  try {
    const urlObj = new URL(normalized);
    normalized = urlObj.toString();
  } catch {
    // If URL is invalid, return as-is
  }

  return normalized;
}

/**
 * Normalize title
 * 
 * @param title - Raw title
 * @param url - Source URL (for fallback)
 * @returns Normalized title
 */
function normalizeTitle(title: string | undefined, url: string): string {
  if (title && title.trim() !== '') {
    return title.trim();
  }

  // Try to extract title from URL
  if (url) {
    try {
      const urlObj = new URL(url);
      const pathParts = urlObj.pathname.split('/').filter(p => p);
      if (pathParts.length > 0) {
        // Use last path part as fallback title
        const lastPart = pathParts[pathParts.length - 1];
        return decodeURIComponent(lastPart.replace(/[-_]/g, ' '));
      }
      return urlObj.hostname;
    } catch {
      // Fall through to default
    }
  }

  return 'Untitled Source';
}

/**
 * Normalize page number
 * 
 * @param page - Raw page (string, number, or null)
 * @returns Normalized page number or null
 */
function normalizePage(page: string | number | null | undefined): number | null {
  if (page === null || page === undefined) {
    return null;
  }

  if (typeof page === 'number') {
    return page > 0 ? page : null;
  }

  const parsed = parseInt(page, 10);
  return isNaN(parsed) || parsed <= 0 ? null : parsed;
}

/**
 * Normalize anchor
 * 
 * @param anchor - Raw anchor
 * @returns Normalized anchor
 */
function normalizeAnchor(anchor: string | undefined): string {
  if (!anchor) {
    return '';
  }

  // Remove leading # if present
  return anchor.replace(/^#/, '').trim();
}

/**
 * Normalize timestamp to ISO 8601
 * 
 * @param timestamp - Raw timestamp (string, Date, or timestamp number)
 * @returns ISO 8601 formatted timestamp
 */
function normalizeTimestamp(
  timestamp: string | Date | number | undefined
): string {
  if (!timestamp) {
    return new Date().toISOString();
  }

  let date: Date;

  if (timestamp instanceof Date) {
    date = timestamp;
  } else if (typeof timestamp === 'number') {
    // Assume milliseconds timestamp
    date = new Date(timestamp);
  } else {
    // Try to parse string
    date = new Date(timestamp);
  }

  // Check if valid date
  if (isNaN(date.getTime())) {
    return new Date().toISOString();
  }

  return date.toISOString();
}

/**
 * Classify source type based on URL
 * 
 * @param url - Normalized URL
 * @returns Source type classification
 */
function classifySourceType(url: string): SourceType {
  if (!url) {
    return 'unknown';
  }

  try {
    const urlObj = new URL(url);
    const domain = urlObj.hostname.toLowerCase();

    if (OFFICIAL_DOMAINS.some(d => domain.includes(d))) {
      return 'official_register';
    }

    if (MANUFACTURER_DOMAINS.some(d => domain.includes(d))) {
      return 'manufacturer';
    }

    if (MEDICAL_DATABASE_DOMAINS.some(d => domain.includes(d))) {
      return 'medical_database';
    }

    if (domain.includes('.gov') || domain.includes('.gov.')) {
      return 'government_portal';
    }

    if (domain.includes('apteka') || domain.includes('pharmacy') || domain.includes('apteki')) {
      return 'pharmacy_chain';
    }

    if (domain.includes('.edu') || domain.includes('university') || domain.includes('academy')) {
      return 'educational';
    }

    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Calculate reliability score based on source type
 * 
 * @param sourceType - Classified source type
 * @param url - Source URL
 * @returns Reliability score (0-1)
 */
function calculateReliabilityScore(sourceType: SourceType, url: string): number {
  const baseScores: Record<SourceType, number> = {
    official_register: 0.95,
    manufacturer: 0.90,
    medical_database: 0.85,
    government_portal: 0.80,
    pharmacy_chain: 0.60,
    educational: 0.70,
    unknown: 0.40,
  };

  let score = baseScores[sourceType];

  // Adjust based on URL characteristics
  if (url.includes('https')) {
    score += 0.05;
  }

  // Cap at 1.0
  return Math.min(score, 1.0);
}

/**
 * Extract domain metadata
 * 
 * @param url - Source URL
 * @returns Domain metadata
 */
function extractDomainMetadata(url: string): Record<string, unknown> {
  if (!url) {
    return {};
  }

  try {
    const urlObj = new URL(url);
    return {
      protocol: urlObj.protocol,
      hostname: urlObj.hostname,
      pathname: urlObj.pathname,
      search: urlObj.search,
      hash: urlObj.hash,
    };
  } catch {
    return {};
  }
}

// ============================================================================
// MAIN NORMALIZATION FUNCTION
// ============================================================================

/**
 * Normalize source metadata
 * 
 * @param input - Raw source input
 * @param options - Normalization options
 * @returns Normalized source reference
 * 
 * @example
 * ```typescript
 * const normalized = normalizeSource({
 *   url: 'grls.rosminzdrav.ru/GRLS.aspx',
 *   title: 'Государственный реестр лекарственных средств',
 *   retrievedAt: '2024-01-15'
 * });
 * 
 * // Result:
 * // {
 * //   url: 'https://grls.rosminzdrav.ru/GRLS.aspx',
 * //   title: 'Государственный реестр лекарственных средств',
 * //   page: null,
 * //   anchor: '',
 * //   retrievedAt: '2024-01-15T00:00:00.000Z',
 * //   sourceType: 'official_register',
 * //   reliabilityScore: 0.95,
 * //   metadata: { ... }
 * // }
 * ```
 */
export function normalizeSource(
  input: RawSourceInput,
  options: NormalizationOptions = {}
): NormalizedSourceRef {
  const {
    defaultUrl = '',
    defaultTitle = 'Untitled Source',
    extractDomainMetadata = true,
    calculateReliability = true,
  } = options;

  // Normalize URL
  const url = normalizeUrl(input.url || defaultUrl);

  // Normalize other fields
  const title = normalizeTitle(input.title || defaultTitle, url);
  const page = normalizePage(input.page);
  const anchor = normalizeAnchor(input.anchor);
  const retrievedAt = normalizeTimestamp(input.retrievedAt);

  // Classify source type
  const sourceType = classifySourceType(url);

  // Calculate reliability score
  const reliabilityScore = calculateReliability
    ? calculateReliabilityScore(sourceType, url)
    : 0.5;

  // Extract domain metadata
  const domainMetadata = extractDomainMetadata
    ? extractDomainMetadata(url)
    : {};

  return {
    url,
    title,
    page,
    anchor,
    retrievedAt,
    sourceType,
    reliabilityScore,
    metadata: {
      ...domainMetadata,
      ...input.metadata,
    },
  };
}

// ============================================================================
// BATCH NORMALIZATION
// ============================================================================

/**
 * Normalize multiple sources
 * 
 * @param inputs - Array of raw source inputs
 * @param options - Normalization options
 * @returns Array of normalized source references
 */
export function normalizeSources(
  inputs: RawSourceInput[],
  options: NormalizationOptions = {}
): NormalizedSourceRef[] {
  return inputs.map(input => normalizeSource(input, options));
}

// ============================================================================
// VALIDATION
// ============================================================================

/**
 * Validate normalized source reference
 * 
 * @param source - Normalized source to validate
 * @returns Validation result
 */
export function validateSource(source: NormalizedSourceRef): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Validate URL
  if (!source.url) {
    errors.push('URL is required');
  } else {
    try {
      new URL(source.url);
    } catch {
      errors.push('Invalid URL format');
    }
  }

  // Validate title
  if (!source.title || source.title.trim() === '') {
    errors.push('Title is required');
  }

  // Validate timestamp
  const timestamp = new Date(source.retrievedAt);
  if (isNaN(timestamp.getTime())) {
    errors.push('Invalid retrievedAt timestamp');
  }

  // Validate reliability score
  if (source.reliabilityScore < 0 || source.reliabilityScore > 1) {
    errors.push('Reliability score must be between 0 and 1');
  }

  // Warnings
  if (source.sourceType === 'unknown') {
    warnings.push('Source type could not be determined');
  }

  if (source.reliabilityScore < 0.5) {
    warnings.push('Low reliability score');
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

// ============================================================================
// COMPARISON AND MERGING
// ============================================================================

/**
 * Compare two sources for equality
 * 
 * @param a - First source
 * @param b - Second source
 * @returns True if sources are equivalent
 */
export function areSourcesEqual(a: NormalizedSourceRef, b: NormalizedSourceRef): boolean {
  return (
    a.url === b.url &&
    a.page === b.page &&
    a.anchor === b.anchor
  );
}

/**
 * Merge multiple sources, keeping the most reliable
 * 
 * @param sources - Array of sources to merge
 * @returns Merged source or null if empty
 */
export function mergeSources(sources: NormalizedSourceRef[]): NormalizedSourceRef | null {
  if (sources.length === 0) {
    return null;
  }

  if (sources.length === 1) {
    return sources[0];
  }

  // Sort by reliability score (descending)
  const sorted = [...sources].sort((a, b) => b.reliabilityScore - a.reliabilityScore);

  // Return the most reliable
  return sorted[0];
}

// ============================================================================
// EXPORT FOR TESTING
// ============================================================================

export const __testing = {
  normalizeUrl,
  normalizeTitle,
  normalizePage,
  normalizeAnchor,
  normalizeTimestamp,
  classifySourceType,
  calculateReliabilityScore,
  extractDomainMetadata,
  OFFICIAL_DOMAINS,
  MEDICAL_DATABASE_DOMAINS,
};

// Default export
export default normalizeSource;
