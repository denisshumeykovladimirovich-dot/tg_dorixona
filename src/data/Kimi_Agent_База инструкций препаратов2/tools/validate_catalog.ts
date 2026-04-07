/**
 * Catalog Validation Tool
 * 
 * Validates catalog.json for:
 * - Schema compliance
 * - Duplicate IDs
 * - Duplicate canonical names
 * - Missing required fields
 * - Consistency with instruction files
 */

import * as fs from 'fs';
import * as path from 'path';

// Types
export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
  stats: ValidationStats;
}

export interface ValidationError {
  type: 'duplicate_id' | 'duplicate_name' | 'missing_required' | 'invalid_format' | 'consistency_error';
  drugId: string;
  field: string;
  message: string;
}

export interface ValidationWarning {
  type: 'empty_array' | 'missing_optional' | 'low_search_tokens' | 'review_needed';
  drugId: string;
  field: string;
  message: string;
}

export interface ValidationStats {
  totalDrugs: number;
  validDrugs: number;
  drugsWithErrors: number;
  drugsWithWarnings: number;
  errorsCount: number;
  warningsCount: number;
}

export interface DrugCatalogEntry {
  id: string;
  canonicalName: {
    ru: string;
    uz?: string;
    en?: string;
  };
  normalizedKey: string;
  aliases?: {
    ru?: string[];
    uz?: string[];
    en?: string[];
    brands?: string[];
    transliterations?: string[];
    commonMisspellings?: string[];
  };
  searchTokens?: string[];
  therapeuticClass?: string[];
  pharmacologicalClass?: string[];
  symptomTags?: string[];
  commonUseCases?: string[];
  dosageForms?: string[];
  ageBucketsSupported?: string[];
  hasOfficialInstruction: boolean;
  instructionFile?: string;
  sourcePriority?: number;
  reviewStatus?: string;
  needsManualReview?: boolean;
  metadata?: {
    addedAt?: string;
    lastReviewed?: string;
    reviewedBy?: string;
  };
}

export interface Catalog {
  version: string;
  lastUpdated: string;
  totalDrugs: number;
  schemaVersion: number;
  drugs: DrugCatalogEntry[];
}

// Validation functions
export function validateCatalog(catalogPath: string): ValidationResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];
  
  // Read catalog
  let catalog: Catalog;
  try {
    const content = fs.readFileSync(catalogPath, 'utf-8');
    catalog = JSON.parse(content);
  } catch (e) {
    return {
      valid: false,
      errors: [{
        type: 'invalid_format',
        drugId: 'N/A',
        field: 'catalog',
        message: `Failed to parse catalog: ${e instanceof Error ? e.message : String(e)}`
      }],
      warnings: [],
      stats: {
        totalDrugs: 0,
        validDrugs: 0,
        drugsWithErrors: 1,
        drugsWithWarnings: 0,
        errorsCount: 1,
        warningsCount: 0
      }
    };
  }

  // Check catalog-level fields
  if (!catalog.version) {
    errors.push({
      type: 'missing_required',
      drugId: 'CATALOG',
      field: 'version',
      message: 'Catalog missing required field: version'
    });
  }

  if (!catalog.lastUpdated) {
    errors.push({
      type: 'missing_required',
      drugId: 'CATALOG',
      field: 'lastUpdated',
      message: 'Catalog missing required field: lastUpdated'
    });
  }

  if (catalog.totalDrugs === undefined) {
    errors.push({
      type: 'missing_required',
      drugId: 'CATALOG',
      field: 'totalDrugs',
      message: 'Catalog missing required field: totalDrugs'
    });
  } else if (catalog.totalDrugs !== catalog.drugs.length) {
    errors.push({
      type: 'consistency_error',
      drugId: 'CATALOG',
      field: 'totalDrugs',
      message: `totalDrugs (${catalog.totalDrugs}) does not match actual drug count (${catalog.drugs.length})`
    });
  }

  // Track duplicates
  const seenIds = new Set<string>();
  const seenNames = new Map<string, string>(); // name -> drugId
  const drugsWithErrors = new Set<string>();
  const drugsWithWarnings = new Set<string>();

  // Validate each drug
  for (const drug of catalog.drugs) {
    const drugErrors: ValidationError[] = [];
    const drugWarnings: ValidationWarning[] = [];

    // Check required fields
    if (!drug.id) {
      drugErrors.push({
        type: 'missing_required',
        drugId: 'UNKNOWN',
        field: 'id',
        message: 'Drug missing required field: id'
      });
    } else {
      // Check for duplicate ID
      if (seenIds.has(drug.id)) {
        drugErrors.push({
          type: 'duplicate_id',
          drugId: drug.id,
          field: 'id',
          message: `Duplicate drug ID: ${drug.id}`
        });
      }
      seenIds.add(drug.id);
    }

    // Check canonicalName
    if (!drug.canonicalName) {
      drugErrors.push({
        type: 'missing_required',
        drugId: drug.id || 'UNKNOWN',
        field: 'canonicalName',
        message: 'Drug missing required field: canonicalName'
      });
    } else {
      if (!drug.canonicalName.ru) {
        drugErrors.push({
          type: 'missing_required',
          drugId: drug.id || 'UNKNOWN',
          field: 'canonicalName.ru',
          message: 'Drug missing required field: canonicalName.ru'
        });
      } else {
        // Check for duplicate canonicalName.ru
        const existingId = seenNames.get(drug.canonicalName.ru.toLowerCase());
        if (existingId) {
          drugErrors.push({
            type: 'duplicate_name',
            drugId: drug.id || 'UNKNOWN',
            field: 'canonicalName.ru',
            message: `Duplicate canonical name "${drug.canonicalName.ru}" (also used by ${existingId})`
          });
        }
        seenNames.set(drug.canonicalName.ru.toLowerCase(), drug.id || 'UNKNOWN');
      }
    }

    // Check normalizedKey
    if (!drug.normalizedKey) {
      drugErrors.push({
        type: 'missing_required',
        drugId: drug.id || 'UNKNOWN',
        field: 'normalizedKey',
        message: 'Drug missing required field: normalizedKey'
      });
    }

    // Check hasOfficialInstruction consistency
    if (drug.hasOfficialInstruction === undefined) {
      drugErrors.push({
        type: 'missing_required',
        drugId: drug.id || 'UNKNOWN',
        field: 'hasOfficialInstruction',
        message: 'Drug missing required field: hasOfficialInstruction'
      });
    } else if (drug.hasOfficialInstruction) {
      if (!drug.instructionFile) {
        drugErrors.push({
          type: 'missing_required',
          drugId: drug.id || 'UNKNOWN',
          field: 'instructionFile',
          message: 'Drug has hasOfficialInstruction=true but instructionFile is missing'
        });
      } else {
        // Check if instruction file exists
        const instructionPath = path.join(path.dirname(catalogPath), '..', drug.instructionFile);
        if (!fs.existsSync(instructionPath)) {
          drugErrors.push({
            type: 'consistency_error',
            drugId: drug.id || 'UNKNOWN',
            field: 'instructionFile',
            message: `Instruction file does not exist: ${drug.instructionFile}`
          });
        }
      }
    }

    // Check searchTokens
    if (!drug.searchTokens || drug.searchTokens.length === 0) {
      drugWarnings.push({
        type: 'empty_array',
        drugId: drug.id || 'UNKNOWN',
        field: 'searchTokens',
        message: 'searchTokens array is empty - will affect search functionality'
      });
    } else if (drug.searchTokens.length < 3) {
      drugWarnings.push({
        type: 'low_search_tokens',
        drugId: drug.id || 'UNKNOWN',
        field: 'searchTokens',
        message: `Only ${drug.searchTokens.length} search tokens - consider adding more for better search`
      });
    }

    // Check therapeuticClass
    if (!drug.therapeuticClass || drug.therapeuticClass.length === 0) {
      drugWarnings.push({
        type: 'empty_array',
        drugId: drug.id || 'UNKNOWN',
        field: 'therapeuticClass',
        message: 'therapeuticClass array is empty'
      });
    }

    // Check aliases
    if (!drug.aliases) {
      drugWarnings.push({
        type: 'missing_optional',
        drugId: drug.id || 'UNKNOWN',
        field: 'aliases',
        message: 'aliases object is missing - search may be limited'
      });
    }

    // Check review status
    if (drug.needsManualReview) {
      drugWarnings.push({
        type: 'review_needed',
        drugId: drug.id || 'UNKNOWN',
        field: 'needsManualReview',
        message: 'Drug requires manual review'
      });
    }

    // Add to collections
    if (drugErrors.length > 0) {
      errors.push(...drugErrors);
      drugsWithErrors.add(drug.id || 'UNKNOWN');
    }
    if (drugWarnings.length > 0) {
      warnings.push(...drugWarnings);
      drugsWithWarnings.add(drug.id || 'UNKNOWN');
    }
  }

  const stats: ValidationStats = {
    totalDrugs: catalog.drugs.length,
    validDrugs: catalog.drugs.length - drugsWithErrors.size,
    drugsWithErrors: drugsWithErrors.size,
    drugsWithWarnings: drugsWithWarnings.size,
    errorsCount: errors.length,
    warningsCount: warnings.length
  };

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    stats
  };
}

// CLI execution
if (require.main === module) {
  const catalogPath = process.argv[2] || path.join(__dirname, '..', 'data', 'catalog', 'catalog.json');
  
  console.log(`Validating catalog: ${catalogPath}`);
  console.log('=' .repeat(60));
  
  const result = validateCatalog(catalogPath);
  
  console.log('\n## Validation Stats');
  console.log(`- Total drugs: ${result.stats.totalDrugs}`);
  console.log(`- Valid drugs: ${result.stats.validDrugs}`);
  console.log(`- Drugs with errors: ${result.stats.drugsWithErrors}`);
  console.log(`- Drugs with warnings: ${result.stats.drugsWithWarnings}`);
  console.log(`- Total errors: ${result.stats.errorsCount}`);
  console.log(`- Total warnings: ${result.stats.warningsCount}`);
  
  if (result.errors.length > 0) {
    console.log('\n## Errors');
    result.errors.forEach(err => {
      console.log(`[${err.type}] ${err.drugId}.${err.field}: ${err.message}`);
    });
  }
  
  if (result.warnings.length > 0) {
    console.log('\n## Warnings');
    result.warnings.forEach(warn => {
      console.log(`[${warn.type}] ${warn.drugId}.${warn.field}: ${warn.message}`);
    });
  }
  
  console.log(`\n## Result: ${result.valid ? 'VALID' : 'INVALID'}`);
  process.exit(result.valid ? 0 : 1);
}
