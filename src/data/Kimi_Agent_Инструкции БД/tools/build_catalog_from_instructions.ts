/**
 * Build Catalog from Instructions Tool
 * 
 * Builds catalog.json from instruction files:
 * - Reads all instruction files from data/instructions/
 * - Generates aliases from canonicalName
 * - Generates searchTokens
 * - Generates indexes (bySymptom, byTherapeuticClass)
 * - Checks consistency between catalog and instructions
 */

import * as fs from 'fs';
import * as path from 'path';

// Types
export interface BuildResult {
  success: boolean;
  catalog: Catalog | null;
  errors: BuildError[];
  warnings: BuildWarning[];
  stats: BuildStats;
}

export interface BuildError {
  type: 'read_error' | 'parse_error' | 'missing_field' | 'consistency_error';
  file: string;
  message: string;
}

export interface BuildWarning {
  type: 'incomplete_data' | 'generation_fallback';
  file: string;
  message: string;
}

export interface BuildStats {
  filesProcessed: number;
  entriesGenerated: number;
  aliasesGenerated: number;
  searchTokensGenerated: number;
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
  source?: {
    sourceType: string;
    title: string;
    organization?: string;
    country?: string;
    language: string;
    url?: string;
    accessDate?: string;
    evidenceLevel?: string;
  };
  sections?: {
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
  id: string;
  text: string;
  language?: string;
  pageNumber?: number;
  sectionName?: string;
  context?: string;
}

export interface DrugCatalogEntry {
  id: string;
  canonicalName: {
    ru: string;
    uz?: string;
    en?: string;
  };
  normalizedKey: string;
  aliases: {
    ru: string[];
    uz: string[];
    en: string[];
    brands: string[];
    transliterations: string[];
    commonMisspellings: string[];
  };
  searchTokens: string[];
  therapeuticClass: string[];
  pharmacologicalClass: string[];
  symptomTags: string[];
  commonUseCases: string[];
  dosageForms: string[];
  ageBucketsSupported: string[];
  hasOfficialInstruction: boolean;
  instructionFile: string;
  sourcePriority: number;
  reviewStatus: string;
  needsManualReview: boolean;
  metadata: {
    addedAt: string;
    lastReviewed: string;
    reviewedBy: string;
  };
}

export interface Catalog {
  version: string;
  lastUpdated: string;
  totalDrugs: number;
  schemaVersion: number;
  drugs: DrugCatalogEntry[];
  indexes?: {
    bySymptom?: Record<string, string[]>;
    byTherapeuticClass?: Record<string, string[]>;
    byUseCase?: Record<string, string[]>;
  };
}

// Therapeutic class mapping
const THERAPEUTIC_CLASS_MAP: Record<string, string> = {
  'analgesic': 'analgesic',
  'antipyretic': 'antipyretic',
  'anti_inflammatory': 'anti_inflammatory',
  'spasmolytic': 'spasmolytic',
  'antiseptic': 'antiseptic',
  'mucolytic': 'mucolytic',
  'expectorant': 'expectorant',
  'antitussive': 'antitussive',
  'decongestant': 'decongestant',
  'antihistamine': 'antihistamine',
  'ppi': 'ppi',
  'prokinetic': 'prokinetic',
  'antiemetic': 'antiemetic',
  'antidiarrheal': 'antidiarrheal',
  'adsorbent': 'adsorbent',
  'antibiotic': 'antibiotic',
  'antifungal': 'antifungal',
  'antiviral': 'antiviral',
  'bronchodilator': 'bronchodilator',
  'corticosteroid': 'corticosteroid',
  'h2_blocker': 'h2_blocker'
};

// Pharmacological class mapping
const PHARMACOLOGICAL_CLASS_MAP: Record<string, string> = {
  'non_opioid_analgesic': 'non_opioid_analgesic',
  'nsaid': 'nsaid',
  'pyrazolone': 'pyrazolone',
  'biguanide': 'biguanide',
  'quaternary_ammonium': 'quaternary_ammonium',
  'mucolytic_agent': 'mucolytic_agent',
  'opioid_antitussive': 'opioid_antitussive',
  'sympathomimetic': 'sympathomimetic',
  'h1_antagonist': 'h1_antagonist',
  'proton_pump_inhibitor': 'proton_pump_inhibitor',
  'dopamine_antagonist': 'dopamine_antagonist',
  'opioid_agonist': 'opioid_agonist',
  'enterosorbent': 'enterosorbent',
  'penicillin': 'penicillin',
  'macrolide': 'macrolide',
  'azole_antifungal': 'azole_antifungal',
  'nucleoside_analogue': 'nucleoside_analogue',
  'beta2_agonist': 'beta2_agonist',
  'inhaled_corticosteroid': 'inhaled_corticosteroid',
  'h2_antagonist': 'h2_antagonist',
  'phosphodiesterase_inhibitor': 'phosphodiesterase_inhibitor'
};

function normalizeKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function transliterateCyrillicToLatin(text: string): string {
  const map: Record<string, string> = {
    'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'e', 'ё': 'yo',
    'ж': 'zh', 'з': 'z', 'и': 'i', 'й': 'y', 'к': 'k', 'л': 'l', 'м': 'm',
    'н': 'n', 'о': 'o', 'п': 'p', 'р': 'r', 'с': 's', 'т': 't', 'у': 'u',
    'ф': 'f', 'х': 'kh', 'ц': 'ts', 'ч': 'ch', 'ш': 'sh', 'щ': 'shch',
    'ъ': '', 'ы': 'y', 'ь': '', 'э': 'e', 'ю': 'yu', 'я': 'ya'
  };
  
  return text.toLowerCase().split('').map(char => map[char] || char).join('');
}

function generateAliases(instruction: DrugInstruction): DrugCatalogEntry['aliases'] {
  const ru = instruction.canonicalName.ru || '';
  const uz = instruction.canonicalName.uz || '';
  const en = instruction.canonicalName.en || '';
  
  const aliases: DrugCatalogEntry['aliases'] = {
    ru: [],
    uz: [],
    en: [],
    brands: [],
    transliterations: [],
    commonMisspellings: []
  };
  
  // Add lowercase versions
  if (ru) aliases.ru.push(ru.toLowerCase());
  if (uz) aliases.uz.push(uz.toLowerCase());
  if (en) aliases.en.push(en.toLowerCase());
  
  // Add transliteration
  if (ru) {
    const transliterated = transliterateCyrillicToLatin(ru);
    aliases.transliterations.push(transliterated);
  }
  
  return aliases;
}

function generateSearchTokens(instruction: DrugInstruction): string[] {
  const tokens = new Set<string>();
  
  // Add canonical names
  if (instruction.canonicalName.ru) {
    tokens.add(instruction.canonicalName.ru.toLowerCase());
  }
  if (instruction.canonicalName.uz) {
    tokens.add(instruction.canonicalName.uz.toLowerCase());
  }
  if (instruction.canonicalName.en) {
    tokens.add(instruction.canonicalName.en.toLowerCase());
  }
  
  // Add transliteration
  if (instruction.canonicalName.ru) {
    tokens.add(transliterateCyrillicToLatin(instruction.canonicalName.ru));
  }
  
  // Add symptom tags from extractions
  if (instruction.extractions?.symptomTags) {
    for (const tag of instruction.extractions.symptomTags) {
      tokens.add(tag.toLowerCase());
    }
  }
  
  // Add symptoms
  if (instruction.extractions?.symptoms?.ru) {
    for (const symptom of instruction.extractions.symptoms.ru) {
      tokens.add(symptom.toLowerCase());
    }
  }
  
  return Array.from(tokens);
}

function generateTherapeuticClass(instruction: DrugInstruction): string[] {
  const classes = new Set<string>();
  
  // Infer from extractions
  if (instruction.extractions?.shortUserLabel?.ru) {
    const label = instruction.extractions.shortUserLabel.ru.toLowerCase();
    
    if (label.includes('жаропонижающее')) classes.add('antipyretic');
    if (label.includes('обезболивающее')) classes.add('analgesic');
    if (label.includes('противовоспалительное')) classes.add('anti_inflammatory');
    if (label.includes('спазмолитик')) classes.add('spasmolytic');
    if (label.includes('антисептик')) classes.add('antiseptic');
    if (label.includes('муколитик')) classes.add('mucolytic');
    if (label.includes('противокашлевое')) classes.add('antitussive');
    if (label.includes('сосудосуживающее')) classes.add('decongestant');
    if (label.includes('антигистаминное')) classes.add('antihistamine');
    if (label.includes('противодиарейное')) classes.add('antidiarrheal');
    if (label.includes('антибиотик')) classes.add('antibiotic');
    if (label.includes('противогрибковое')) classes.add('antifungal');
    if (label.includes('противовирусное')) classes.add('antiviral');
    if (label.includes('бронходилататор')) classes.add('bronchodilator');
  }
  
  return Array.from(classes);
}

function generatePharmacologicalClass(instruction: DrugInstruction): string[] {
  const classes = new Set<string>();
  
  // Infer from name patterns
  const ru = instruction.canonicalName.ru?.toLowerCase() || '';
  
  if (ru.includes('ибупрофен') || ru.includes('диклофенак') || ru.includes('напроксен')) {
    classes.add('nsaid');
  }
  if (ru.includes('парацетамол')) classes.add('non_opioid_analgesic');
  if (ru.includes('метамизол')) classes.add('pyrazolone');
  if (ru.includes('хлоргексидин')) classes.add('biguanide');
  if (ru.includes('мирамистин')) classes.add('quaternary_ammonium');
  if (ru.includes('амброксол') || ru.includes('ацетилцистеин')) classes.add('mucolytic_agent');
  if (ru.includes('декстрометорфан')) classes.add('opioid_antitussive');
  if (ru.includes('оксиметазолин') || ru.includes('ксилометазолин')) classes.add('sympathomimetic');
  if (ru.includes('лоратадин') || ru.includes('цетиризин') || ru.includes('дезлоратадин')) {
    classes.add('h1_antagonist');
  }
  if (ru.includes('омепразол') || ru.includes('пантопразол')) classes.add('proton_pump_inhibitor');
  if (ru.includes('фамотидин')) classes.add('h2_antagonist');
  if (ru.includes('домперидон')) classes.add('dopamine_antagonist');
  if (ru.includes('лоперамид')) classes.add('opioid_agonist');
  if (ru.includes('амоксициллин')) classes.add('penicillin');
  if (ru.includes('азитромицин')) classes.add('macrolide');
  if (ru.includes('флуконазол')) classes.add('azole_antifungal');
  if (ru.includes('ацикловир')) classes.add('nucleoside_analogue');
  if (ru.includes('сальбутамол')) classes.add('beta2_agonist');
  if (ru.includes('будесонид')) classes.add('inhaled_corticosteroid');
  if (ru.includes('дротаверин')) classes.add('phosphodiesterase_inhibitor');
  
  return Array.from(classes);
}

function generateSymptomTags(instruction: DrugInstruction): string[] {
  const tags = new Set<string>();
  
  if (instruction.extractions?.symptomTags) {
    for (const tag of instruction.extractions.symptomTags) {
      tags.add(tag);
    }
  }
  
  if (instruction.extractions?.symptoms?.ru) {
    for (const symptom of instruction.extractions.symptoms.ru) {
      // Normalize symptom to tag
      const tag = symptom.toLowerCase()
        .replace(/повышенная\s+/g, '')
        .replace(/головная\s+/g, '')
        .trim();
      if (tag) tags.add(tag);
    }
  }
  
  return Array.from(tags);
}

function generateCommonUseCases(instruction: DrugInstruction): string[] {
  const useCases = new Set<string>();
  
  if (instruction.extractions?.commonUseCases) {
    for (const useCase of instruction.extractions.commonUseCases) {
      useCases.add(useCase);
    }
  }
  
  // Infer from symptom tags
  const tags = instruction.extractions?.symptomTags || [];
  
  if (tags.includes('температура') || tags.includes('жар')) {
    useCases.add('fever_reduction');
  }
  if (tags.includes('боль')) {
    useCases.add('pain_relief');
    useCases.add('headache');
    useCases.add('toothache');
    useCases.add('muscle_pain');
  }
  if (tags.includes('воспаление')) {
    useCases.add('inflammation');
  }
  if (tags.includes('спазм')) {
    useCases.add('spasm');
    useCases.add('colic');
  }
  if (tags.includes('кашель')) {
    useCases.add('cough');
  }
  if (tags.includes('мокрота')) {
    useCases.add('productive_cough');
  }
  if (tags.includes('насморк') || tags.includes('заложенность носа')) {
    useCases.add('runny_nose');
    useCases.add('nasal_congestion');
  }
  if (tags.includes('аллергия') || tags.includes('зуд')) {
    useCases.add('allergy');
    useCases.add('hay_fever');
    useCases.add('urticaria');
  }
  if (tags.includes('изжога') || tags.includes('гастрит') || tags.includes('язва')) {
    useCases.add('heartburn');
    useCases.add('gastritis');
    useCases.add('ulcer');
  }
  if (tags.includes('тошнота') || tags.includes('рвота')) {
    useCases.add('nausea');
    useCases.add('vomiting');
  }
  if (tags.includes('диарея')) {
    useCases.add('diarrhea');
  }
  if (tags.includes('отравление')) {
    useCases.add('poisoning');
    useCases.add('detoxification');
  }
  if (tags.includes('инфекция') || tags.includes('бактерии')) {
    useCases.add('bacterial_infection');
    useCases.add('respiratory_infection');
  }
  if (tags.includes('грибок') || tags.includes('молочница')) {
    useCases.add('fungal_infection');
    useCases.add('candidiasis');
  }
  if (tags.includes('вирус') || tags.includes('герпес')) {
    useCases.add('viral_infection');
    useCases.add('herpes');
  }
  if (tags.includes('астма') || tags.includes('одышка')) {
    useCases.add('asthma');
    useCases.add('bronchospasm');
  }
  
  return Array.from(useCases);
}

function generateDosageForms(instruction: DrugInstruction): string[] {
  const forms = new Set<string>();
  
  if (instruction.identity?.dosageForms) {
    for (const form of instruction.identity.dosageForms) {
      forms.add(form);
    }
  }
  
  // Default forms based on drug type
  const ru = instruction.canonicalName.ru?.toLowerCase() || '';
  
  if (ru.includes('парацетамол') || ru.includes('ибупрофен') || ru.includes('амоксициллин')) {
    forms.add('tablet');
    forms.add('suspension');
    forms.add('suppository');
  }
  if (ru.includes('амброксол') || ru.includes('декстрометорфан')) {
    forms.add('syrup');
    forms.add('tablet');
  }
  if (ru.includes('оксиметазолин') || ru.includes('ксилометазолин') || ru.includes('будесонид')) {
    forms.add('nasal_spray');
    forms.add('nasal_drops');
  }
  if (ru.includes('сальбутамол')) {
    forms.add('inhaler');
    forms.add('nebulizer_solution');
  }
  if (ru.includes('хлоргексидин') || ru.includes('мирамистин')) {
    forms.add('solution');
    forms.add('spray');
  }
  if (ru.includes('диклофенак') || ru.includes('ибупрофен')) {
    forms.add('gel');
  }
  if (ru.includes('ацикловир')) {
    forms.add('ointment');
    forms.add('cream');
    forms.add('tablet');
  }
  
  return Array.from(forms);
}

function generateAgeBuckets(instruction: DrugInstruction): string[] {
  const buckets = new Set<string>();
  
  // Default age buckets
  buckets.add('adult');
  
  const ru = instruction.canonicalName.ru?.toLowerCase() || '';
  
  // Most drugs support children
  if (!ru.includes('ацетилсалициловая') && !ru.includes('напроксен') && 
      !ru.includes('диклофенак') && !ru.includes('пантопразол')) {
    buckets.add('child');
  }
  
  // Some support infants
  if (ru.includes('парацетамол') || ru.includes('ибупрофен') || ru.includes('амоксициллин')) {
    buckets.add('infant');
  }
  
  return Array.from(buckets);
}

function buildCatalogEntry(instruction: DrugInstruction, fileName: string): { entry: DrugCatalogEntry; errors: BuildError[]; warnings: BuildWarning[] } {
  const errors: BuildError[] = [];
  const warnings: BuildWarning[] = [];
  
  const id = instruction.id || fileName.replace('.json', '');
  
  if (!instruction.canonicalName?.ru) {
    errors.push({
      type: 'missing_field',
      file: fileName,
      message: 'Missing canonicalName.ru'
    });
  }
  
  const entry: DrugCatalogEntry = {
    id,
    canonicalName: {
      ru: instruction.canonicalName?.ru || id,
      uz: instruction.canonicalName?.uz,
      en: instruction.canonicalName?.en
    },
    normalizedKey: normalizeKey(instruction.canonicalName?.ru || id),
    aliases: generateAliases(instruction),
    searchTokens: generateSearchTokens(instruction),
    therapeuticClass: generateTherapeuticClass(instruction),
    pharmacologicalClass: generatePharmacologicalClass(instruction),
    symptomTags: generateSymptomTags(instruction),
    commonUseCases: generateCommonUseCases(instruction),
    dosageForms: generateDosageForms(instruction),
    ageBucketsSupported: generateAgeBuckets(instruction),
    hasOfficialInstruction: true,
    instructionFile: `data/instructions/${fileName}`,
    sourcePriority: 1,
    reviewStatus: instruction.reviewStatus || 'draft_pending',
    needsManualReview: instruction.needsManualReview !== false,
    metadata: {
      addedAt: new Date().toISOString().split('T')[0],
      lastReviewed: new Date().toISOString().split('T')[0],
      reviewedBy: 'system'
    }
  };
  
  // Warnings for incomplete data
  if (entry.searchTokens.length < 3) {
    warnings.push({
      type: 'incomplete_data',
      file: fileName,
      message: `Generated only ${entry.searchTokens.length} search tokens`
    });
  }
  
  if (entry.therapeuticClass.length === 0) {
    warnings.push({
      type: 'generation_fallback',
      file: fileName,
      message: 'No therapeutic classes generated, using fallback'
    });
    entry.therapeuticClass = ['general_use'];
  }
  
  return { entry, errors, warnings };
}

export function buildCatalogFromInstructions(
  instructionsDir: string,
  existingCatalog?: Catalog
): BuildResult {
  const errors: BuildError[] = [];
  const warnings: BuildWarning[] = [];
  const entries: DrugCatalogEntry[] = [];
  
  let files: string[];
  try {
    files = fs.readdirSync(instructionsDir)
      .filter(f => f.endsWith('.json'));
  } catch (e) {
    return {
      success: false,
      catalog: null,
      errors: [{
        type: 'read_error',
        file: instructionsDir,
        message: `Failed to read instructions directory: ${e instanceof Error ? e.message : String(e)}`
      }],
      warnings: [],
      stats: {
        filesProcessed: 0,
        entriesGenerated: 0,
        aliasesGenerated: 0,
        searchTokensGenerated: 0
      }
    };
  }
  
  let aliasesGenerated = 0;
  let searchTokensGenerated = 0;
  
  for (const fileName of files) {
    const filePath = path.join(instructionsDir, fileName);
    
    let instruction: DrugInstruction;
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      instruction = JSON.parse(content);
    } catch (e) {
      errors.push({
        type: 'parse_error',
        file: fileName,
        message: `Failed to parse: ${e instanceof Error ? e.message : String(e)}`
      });
      continue;
    }
    
    const { entry, errors: entryErrors, warnings: entryWarnings } = buildCatalogEntry(instruction, fileName);
    
    errors.push(...entryErrors);
    warnings.push(...entryWarnings);
    entries.push(entry);
    
    aliasesGenerated += Object.values(entry.aliases).reduce((sum, arr) => sum + arr.length, 0);
    searchTokensGenerated += entry.searchTokens.length;
  }
  
  // Build indexes
  const bySymptom: Record<string, string[]> = {};
  const byTherapeuticClass: Record<string, string[]> = {};
  const byUseCase: Record<string, string[]> = {};
  
  for (const entry of entries) {
    for (const symptom of entry.symptomTags) {
      if (!bySymptom[symptom]) bySymptom[symptom] = [];
      bySymptom[symptom].push(entry.id);
    }
    
    for (const tc of entry.therapeuticClass) {
      if (!byTherapeuticClass[tc]) byTherapeuticClass[tc] = [];
      byTherapeuticClass[tc].push(entry.id);
    }
    
    for (const useCase of entry.commonUseCases) {
      if (!byUseCase[useCase]) byUseCase[useCase] = [];
      byUseCase[useCase].push(entry.id);
    }
  }
  
  const catalog: Catalog = {
    version: existingCatalog?.version || '1.0.0',
    lastUpdated: new Date().toISOString().split('T')[0],
    totalDrugs: entries.length,
    schemaVersion: existingCatalog?.schemaVersion || 1,
    drugs: entries.sort((a, b) => a.id.localeCompare(b.id)),
    indexes: {
      bySymptom,
      byTherapeuticClass,
      byUseCase
    }
  };
  
  return {
    success: errors.length === 0,
    catalog,
    errors,
    warnings,
    stats: {
      filesProcessed: files.length,
      entriesGenerated: entries.length,
      aliasesGenerated,
      searchTokensGenerated
    }
  };
}

// CLI execution
if (require.main === module) {
  const instructionsDir = process.argv[2] || path.join(__dirname, '..', 'data', 'instructions');
  const outputPath = process.argv[3] || path.join(__dirname, '..', 'data', 'catalog', 'catalog.json');
  
  console.log(`Building catalog from: ${instructionsDir}`);
  console.log(`Output to: ${outputPath}`);
  console.log('=' .repeat(60));
  
  const result = buildCatalogFromInstructions(instructionsDir);
  
  console.log('\n## Build Stats');
  console.log(`- Files processed: ${result.stats.filesProcessed}`);
  console.log(`- Entries generated: ${result.stats.entriesGenerated}`);
  console.log(`- Aliases generated: ${result.stats.aliasesGenerated}`);
  console.log(`- Search tokens generated: ${result.stats.searchTokensGenerated}`);
  
  if (result.errors.length > 0) {
    console.log('\n## Errors');
    result.errors.forEach(err => {
      console.log(`[${err.type}] ${err.file}: ${err.message}`);
    });
  }
  
  if (result.warnings.length > 0) {
    console.log('\n## Warnings');
    result.warnings.forEach(warn => {
      console.log(`[${warn.type}] ${warn.file}: ${warn.message}`);
    });
  }
  
  if (result.catalog) {
    // Write catalog
    fs.writeFileSync(outputPath, JSON.stringify(result.catalog, null, 2), 'utf-8');
    console.log(`\n## Catalog written to: ${outputPath}`);
    
    // Print index stats
    if (result.catalog.indexes) {
      console.log('\n## Index Stats');
      console.log(`- Symptoms indexed: ${Object.keys(result.catalog.indexes.bySymptom || {}).length}`);
      console.log(`- Therapeutic classes indexed: ${Object.keys(result.catalog.indexes.byTherapeuticClass || {}).length}`);
      console.log(`- Use cases indexed: ${Object.keys(result.catalog.indexes.byUseCase || {}).length}`);
    }
  }
  
  console.log(`\n## Result: ${result.success ? 'SUCCESS' : 'PARTIAL'}`);
  process.exit(result.success ? 0 : 1);
}
