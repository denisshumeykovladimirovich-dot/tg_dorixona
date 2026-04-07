/**
 * Instructions Validation Tool
 * 
 * Validates all instruction files for:
 * - Required fields (id, schemaVersion, canonicalName, etc.)
 * - Empty critical sections (indications, contraindications, dosage)
 * - Missing source URLs
 * - Source fragments structure
 * - Language coverage
 */

import * as fs from 'fs';
import * as path from 'path';

// Types
export interface InstructionValidationResult {
  valid: boolean;
  fileResults: FileValidationResult[];
  summary: ValidationSummary;
}

export interface FileValidationResult {
  fileName: string;
  valid: boolean;
  errors: InstructionError[];
  warnings: InstructionWarning[];
  stats: FileStats;
}

export interface InstructionError {
  type: 'missing_required' | 'invalid_format' | 'empty_critical_section' | 'missing_source' | 'invalid_fragment';
  field: string;
  message: string;
}

export interface InstructionWarning {
  type: 'empty_section' | 'missing_language' | 'low_content' | 'review_needed' | 'missing_source';
  field: string;
  message: string;
}

export interface FileStats {
  sectionsCount: number;
  emptySections: number;
  sourceFragmentsCount: number;
  structuredItemsCount: number;
}

export interface ValidationSummary {
  totalFiles: number;
  validFiles: number;
  filesWithErrors: number;
  filesWithWarnings: number;
  totalErrors: number;
  totalWarnings: number;
  criticalIssues: CriticalIssue[];
}

export interface CriticalIssue {
  file: string;
  issue: string;
  severity: 'high' | 'medium' | 'low';
}

export interface DrugInstruction {
  id: string;
  schemaVersion: string | number;
  reviewStatus?: string;
  needsManualReview?: boolean;
  canonicalName: {
    ru: string;
    uz?: string;
    en?: string;
  };
  identity?: {
    activeSubstance?: any;
    drugForm?: string | string[];
    dosageForms?: string[];
    strengths?: string[];
  };
  source: {
    sourceType: string;
    title: string;
    organization?: string;
    country?: string;
    language: string;
    url?: string;
    accessDate?: string;
    evidenceLevel?: string;
  };
  sections: {
    composition?: InstructionSection;
    indications?: InstructionSection;
    contraindications?: InstructionSection;
    dosageAndAdministration?: DosageSection;
    sideEffects?: InstructionSection;
    interactions?: InstructionSection;
    specialWarnings?: InstructionSection;
    pregnancy?: InstructionSection;
    lactation?: InstructionSection;
    overdose?: InstructionSection;
    storage?: InstructionSection;
    pharmacologicalProperties?: InstructionSection;
    clinicalData?: InstructionSection;
  };
  extractions?: {
    shortUserLabel?: Record<string, string>;
    symptoms?: Record<string, string[]>;
    symptomTags?: string[];
    commonUseCases?: string[];
    ageSummary?: Record<string, string>;
    interactionSummary?: Record<string, string>;
    riskSignals?: any[];
    botSafeSummary?: Record<string, string>;
  };
}

export interface InstructionSection {
  structured?: any[] | { [key: string]: any[] };
  sourceFragments?: SourceFragment[];
}

export interface DosageSection extends InstructionSection {
  structured?: {
    general?: any[];
    adults?: any[];
    children?: any[];
    ageSpecific?: any[];
    routeSpecific?: any[];
  };
}

export interface SourceFragment {
  id?: string;
  fragmentId?: string;
  text: string;
  language?: string;
  pageNumber?: number;
  sectionName?: string;
  context?: string;
}

// Critical sections that should not be empty
const CRITICAL_SECTIONS = ['indications', 'contraindications', 'dosageAndAdministration'];

// All sections to check
const ALL_SECTIONS = [
  'composition',
  'indications',
  'contraindications',
  'dosageAndAdministration',
  'sideEffects',
  'interactions',
  'specialWarnings',
  'pregnancy',
  'lactation',
  'overdose',
  'storage'
];

function isSectionEmpty(section: InstructionSection | undefined): boolean {
  if (!section) return true;
  
  // Check structured
  if (section.structured) {
    if (Array.isArray(section.structured)) {
      if (section.structured.length > 0) return false;
    } else if (typeof section.structured === 'object') {
      // For dosage section with nested arrays
      for (const key in section.structured) {
        const arr = (section.structured as any)[key];
        if (Array.isArray(arr) && arr.length > 0) return false;
      }
    }
  }
  
  // Check sourceFragments
  if (section.sourceFragments && section.sourceFragments.length > 0) {
    return false;
  }
  
  return true;
}

function countStructuredItems(section: InstructionSection | undefined): number {
  if (!section || !section.structured) return 0;
  
  if (Array.isArray(section.structured)) {
    return section.structured.length;
  }
  
  if (typeof section.structured === 'object') {
    let count = 0;
    for (const key in section.structured) {
      const arr = (section.structured as any)[key];
      if (Array.isArray(arr)) {
        count += arr.length;
      }
    }
    return count;
  }
  
  return 0;
}

function countSourceFragments(section: InstructionSection | undefined): number {
  if (!section || !section.sourceFragments) return 0;
  return section.sourceFragments.length;
}

function validateSourceFragments(section: InstructionSection | undefined, sectionName: string): InstructionError[] {
  const errors: InstructionError[] = [];
  
  if (!section || !section.sourceFragments) return errors;
  
  for (let i = 0; i < section.sourceFragments.length; i++) {
    const fragment = section.sourceFragments[i];
    
    if (!fragment.id && !fragment.fragmentId) {
      errors.push({
        type: 'invalid_fragment',
        field: `${sectionName}.sourceFragments[${i}]`,
        message: `Source fragment missing required field: id or fragmentId`
      });
    }
    
    if (!fragment.text || fragment.text.trim() === '') {
      errors.push({
        type: 'invalid_fragment',
        field: `${sectionName}.sourceFragments[${i}]`,
        message: `Source fragment missing required field: text`
      });
    }
  }
  
  return errors;
}

function collectStructuredItems(section: InstructionSection | undefined): any[] {
  if (!section || !section.structured) return [];
  if (Array.isArray(section.structured)) return section.structured;

  if (typeof section.structured === 'object') {
    const items: any[] = [];
    for (const key in section.structured) {
      const arr = (section.structured as any)[key];
      if (Array.isArray(arr)) {
        items.push(...arr);
      }
    }
    return items;
  }

  return [];
}

function collectFragmentIds(section: InstructionSection | undefined): Set<string> {
  const ids = new Set<string>();
  if (!section || !section.sourceFragments) return ids;

  for (const fragment of section.sourceFragments) {
    const id = fragment.id || fragment.fragmentId;
    if (id) ids.add(id);
  }

  return ids;
}

export function validateInstructionFile(filePath: string): FileValidationResult {
  const errors: InstructionError[] = [];
  const warnings: InstructionWarning[] = [];
  const fileName = path.basename(filePath);
  
  // Read file
  let instruction: DrugInstruction;
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    instruction = JSON.parse(content);
  } catch (e) {
    return {
      fileName,
      valid: false,
      errors: [{
        type: 'invalid_format',
        field: 'file',
        message: `Failed to parse instruction file: ${e instanceof Error ? e.message : String(e)}`
      }],
      warnings: [],
      stats: {
        sectionsCount: 0,
        emptySections: 0,
        sourceFragmentsCount: 0,
        structuredItemsCount: 0
      }
    };
  }

  // Check required top-level fields
  if (!instruction.id) {
    errors.push({
      type: 'missing_required',
      field: 'id',
      message: 'Missing required field: id'
    });
  }

  if (!instruction.schemaVersion) {
    errors.push({
      type: 'missing_required',
      field: 'schemaVersion',
      message: 'Missing required field: schemaVersion'
    });
  }

  if (!instruction.canonicalName) {
    errors.push({
      type: 'missing_required',
      field: 'canonicalName',
      message: 'Missing required field: canonicalName'
    });
  } else {
    if (!instruction.canonicalName.ru) {
      errors.push({
        type: 'missing_required',
        field: 'canonicalName.ru',
        message: 'Missing required field: canonicalName.ru'
      });
    }
  }

  // Check source
  if (!instruction.source) {
    errors.push({
      type: 'missing_required',
      field: 'source',
      message: 'Missing required field: source'
    });
  } else {
    if (!instruction.source.sourceType) {
      errors.push({
        type: 'missing_required',
        field: 'source.sourceType',
        message: 'Missing required field: source.sourceType'
      });
    }
    
    if (!instruction.source.title) {
      errors.push({
        type: 'missing_required',
        field: 'source.title',
        message: 'Missing required field: source.title'
      });
    }
    
    if (!instruction.source.language) {
      errors.push({
        type: 'missing_required',
        field: 'source.language',
        message: 'Missing required field: source.language'
      });
    }
    
    // Check URL for official instructions
    if (instruction.source.sourceType === 'official_instruction' && 
        (!instruction.source.url || instruction.source.url.trim() === '')) {
      warnings.push({
        type: 'missing_source',
        field: 'source.url',
        message: 'Official instruction should have a source URL'
      });
    }
  }

  // Check sections
  if (!instruction.sections) {
    errors.push({
      type: 'missing_required',
      field: 'sections',
      message: 'Missing required field: sections'
    });
  } else {
    // Check critical sections
    for (const sectionName of CRITICAL_SECTIONS) {
      const section = instruction.sections[sectionName as keyof typeof instruction.sections];
      if (isSectionEmpty(section)) {
        errors.push({
          type: 'empty_critical_section',
          field: `sections.${sectionName}`,
          message: `Critical section "${sectionName}" is empty`
        });
      }
    }

    // Check all sections for source fragments
    for (const sectionName of ALL_SECTIONS) {
      const section = instruction.sections[sectionName as keyof typeof instruction.sections];
      const fragmentErrors = validateSourceFragments(section, `sections.${sectionName}`);
      errors.push(...fragmentErrors);

      // Enforce traceability: every structured item should point to an existing fragment in the same section
      const structuredItems = collectStructuredItems(section);
      const fragmentIds = collectFragmentIds(section);
      for (let i = 0; i < structuredItems.length; i++) {
        const sourceRef = structuredItems[i]?.sourceRef;
        if (!sourceRef || !fragmentIds.has(sourceRef)) {
          errors.push({
            type: 'invalid_fragment',
            field: `sections.${sectionName}.structured[${i}].sourceRef`,
            message: `Structured item sourceRef is missing or does not match any source fragment id`
          });
        }
      }
    }
  }

  // Check language coverage in extractions
  if (instruction.extractions) {
    const ruFields = ['shortUserLabel', 'symptoms', 'ageSummary', 'interactionSummary', 'botSafeSummary'];
    for (const field of ruFields) {
      const value = instruction.extractions[field as keyof typeof instruction.extractions];
      if (value && typeof value === 'object') {
        if (!value.ru || (Array.isArray(value.ru) && value.ru.length === 0)) {
          warnings.push({
            type: 'missing_language',
            field: `extractions.${field}.ru`,
            message: `Missing or empty Russian content in ${field}`
          });
        }
      }
    }
  }

  // Check review status
  if (instruction.needsManualReview) {
    warnings.push({
      type: 'review_needed',
      field: 'needsManualReview',
      message: 'Instruction requires manual review'
    });
  }

  // Calculate stats
  let sectionsCount = 0;
  let emptySections = 0;
  let sourceFragmentsCount = 0;
  let structuredItemsCount = 0;

  if (instruction.sections) {
    for (const sectionName of ALL_SECTIONS) {
      const section = instruction.sections[sectionName as keyof typeof instruction.sections];
      if (section) {
        sectionsCount++;
        if (isSectionEmpty(section)) {
          emptySections++;
        }
        sourceFragmentsCount += countSourceFragments(section);
        structuredItemsCount += countStructuredItems(section);
      }
    }
  }

  return {
    fileName,
    valid: errors.length === 0,
    errors,
    warnings,
    stats: {
      sectionsCount,
      emptySections,
      sourceFragmentsCount,
      structuredItemsCount
    }
  };
}

export function validateAllInstructions(instructionsDir: string): InstructionValidationResult {
  const fileResults: FileValidationResult[] = [];
  const criticalIssues: CriticalIssue[] = [];
  
  // Get all JSON files in the directory
  const files = fs.readdirSync(instructionsDir)
    .filter(f => f.endsWith('.json'))
    .map(f => path.join(instructionsDir, f));
  
  for (const filePath of files) {
    const result = validateInstructionFile(filePath);
    fileResults.push(result);
    
    // Collect critical issues
    for (const error of result.errors) {
      if (error.type === 'empty_critical_section') {
        criticalIssues.push({
          file: result.fileName,
          issue: error.message,
          severity: 'high'
        });
      } else if (error.type === 'missing_required') {
        criticalIssues.push({
          file: result.fileName,
          issue: error.message,
          severity: 'high'
        });
      }
    }
  }

  const totalErrors = fileResults.reduce((sum, r) => sum + r.errors.length, 0);
  const totalWarnings = fileResults.reduce((sum, r) => sum + r.warnings.length, 0);
  const validFiles = fileResults.filter(r => r.valid).length;
  const filesWithErrors = fileResults.filter(r => r.errors.length > 0).length;
  const filesWithWarnings = fileResults.filter(r => r.warnings.length > 0).length;

  return {
    valid: totalErrors === 0,
    fileResults,
    summary: {
      totalFiles: files.length,
      validFiles,
      filesWithErrors,
      filesWithWarnings,
      totalErrors,
      totalWarnings,
      criticalIssues
    }
  };
}

// CLI execution
if (require.main === module) {
  const instructionsDir = process.argv[2] || path.join(__dirname, '..', 'data', 'instructions');
  
  console.log(`Validating instructions in: ${instructionsDir}`);
  console.log('=' .repeat(60));
  
  const result = validateAllInstructions(instructionsDir);
  
  console.log('\n## Summary');
  console.log(`- Total files: ${result.summary.totalFiles}`);
  console.log(`- Valid files: ${result.summary.validFiles}`);
  console.log(`- Files with errors: ${result.summary.filesWithErrors}`);
  console.log(`- Files with warnings: ${result.summary.filesWithWarnings}`);
  console.log(`- Total errors: ${result.summary.totalErrors}`);
  console.log(`- Total warnings: ${result.summary.totalWarnings}`);
  
  if (result.summary.criticalIssues.length > 0) {
    console.log('\n## Critical Issues');
    result.summary.criticalIssues.forEach(issue => {
      console.log(`[${issue.severity.toUpperCase()}] ${issue.file}: ${issue.issue}`);
    });
  }
  
  console.log('\n## Per-File Results');
  for (const fileResult of result.fileResults) {
    const status = fileResult.valid ? '✓' : '✗';
    console.log(`\n${status} ${fileResult.fileName}`);
    console.log(`   Sections: ${fileResult.stats.sectionsCount}, Empty: ${fileResult.stats.emptySections}`);
    console.log(`   Fragments: ${fileResult.stats.sourceFragmentsCount}, Structured: ${fileResult.stats.structuredItemsCount}`);
    
    if (fileResult.errors.length > 0) {
      fileResult.errors.forEach(err => {
        console.log(`   [ERROR] ${err.field}: ${err.message}`);
      });
    }
    
    if (fileResult.warnings.length > 0) {
      fileResult.warnings.forEach(warn => {
        console.log(`   [WARN] ${warn.field}: ${warn.message}`);
      });
    }
  }
  
  console.log(`\n## Result: ${result.valid ? 'VALID' : 'INVALID'}`);
  process.exit(result.valid ? 0 : 1);
}
