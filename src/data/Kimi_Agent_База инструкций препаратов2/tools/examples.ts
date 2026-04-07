/**
 * Examples of using Instruction Section Extractor and Source Normalization tools
 * 
 * Примеры использования инструментов разбора инструкций и нормализации источников
 */

import {
  extractInstructionSections,
  extractInstructionSectionsBatch,
  validateExtractionResult,
  ExtractionInput,
  ExtractionResult,
  BatchExtractionResult,
} from './extract_instruction_sections';

import {
  normalizeSource,
  normalizeSources,
  validateSource,
  mergeSources,
  NormalizedSourceRef,
} from './normalize_sources';

// ============================================================================
// EXAMPLE 1: Basic Russian Instruction Extraction
// ============================================================================

const russianInstructionText = `
1. Состав

Действующее вещество: парацетамол - 500 мг.
Вспомогательные вещества: крахмал картофельный, целлюлоза микрокристаллическая,
повидон, кальция стеарат, кремния диоксид коллоидный.

2. Показания к применению

- Симптоматическое лечение боли легкой и средней интенсивности:
  • головная боль, мигрень
  • зубная боль
  • мышечная боль
  • менструальная боль
- Снижение повышенной температуры при:
  • простудных заболеваниях
  • гриппе

3. Противопоказания

- Повышенная чувствительность к парацетамолу или вспомогательным веществам
- Тяжелые нарушения функции печени или почек
- Алкоголизм
- Детский возраст до 6 лет

4. Способ применения и дозы

Внутрь, после еды, запивая достаточным количеством жидкости.

Взрослые и дети старше 12 лет: по 1-2 таблетки 3-4 раза в сутки.
Максимальная суточная доза - 8 таблеток (4 г парацетамола).

Дети 6-12 лет: по 1/2 таблетки 3-4 раза в сутки.

5. Побочное действие

- Аллергические реакции: кожная сыпь, зуд, крапивница
- Со стороны пищеварительной системы: тошнота, диспепсия
- Со стороны кровеносной системы: тромбоцитопения, лейкопения

6. Передозировка

При передозировке возможны: тошнота, рвота, боли в животе, потливость,
гепатотоксичность. Необходимо немедленно обратиться к врачу.

7. Условия хранения

При температуре не выше 25°C. Хранить в недоступном для детей месте.
`;

export function example1_BasicRussianExtraction(): ExtractionResult {
  const input: ExtractionInput = {
    drugId: 'paracetamol-500mg-tablets',
    text: russianInstructionText,
    language: 'ru',
    sourceRef: {
      url: 'https://grls.rosminzdrav.ru/GRLS.aspx',
      title: 'Парацетамол, таблетки 500 мг - Инструкция',
      page: null,
      anchor: 'instruction-section',
      retrievedAt: '2024-01-15T10:00:00Z',
    },
  };

  const result = extractInstructionSections(input);

  console.log('=== Example 1: Basic Russian Extraction ===');
  console.log('Drug ID:', result.drugId);
  console.log('Language:', result.language);
  console.log('Stats:', result.stats);
  console.log('\nFound sections:');

  for (const [sectionName, sectionResult] of Object.entries(result.sections)) {
    if (sectionResult.found) {
      console.log(`  ✓ ${sectionName}: ${sectionResult.fragments[0].text.substring(0, 80)}...`);
    } else {
      console.log(`  ✗ ${sectionName}: ${sectionResult.missingReason}`);
    }
  }

  return result;
}

// ============================================================================
// EXAMPLE 2: Uzbek Language Extraction
// ============================================================================

const uzbekInstructionText = `
1. Tarkib

Faol modda: paratsetamol - 500 mg.
Yordamchi moddalar: kartoshka kraxmali, mikrokristall tsellyuloza,
povidon, kalsiy stearat, kolloid kremniy dioksid.

2. Ko'rsatmalar

- Yengil va o'rta kuchli og'riqni simptomatik davolash:
  • bosh og'rig'i, migren
  • tish og'rig'i
  • mushak og'rig'i
  • hayz og'rig'i
- Yuqori haroratni pasaytirish:
  • shamollash kasalliklarida
  • grippda

3. Qarshi ko'rsatmalar

- Paratsetamol yoki yordamchi moddalarga oshirilgan sezuvchanlik
- Jigar yoki buyrak funksiyasining og'ir buzilishi
- Alkogolizm
- 6 yoshgacha bo'lgan bolalar

4. Qollash usuli va dozalari

Og'iz orqali, ovqatdan keyin, yetarli miqdorda suvbilan ichiladi.

Kattalar va 12 yoshdan katta bolalar: kuniga 3-4 marta 1-2 tabletka.
Maksimal kunlik doza - 8 tabletka (4 g paratsetamol).

6-12 yoshli bolalar: kuniga 3-4 marta 1/2 tabletka.

5. Yon ta'sir

- allergik reaksiyalar: teri toshmalari, qichishish, krapivnitsa
- ovqat hazm tizimidan: ko'ngil aynish, dispepsiya
- qon tizimidan: trombositopeniya, leykopeniya

6. Dozani oshirish

Oshiqcha dozada: ko'ngil aynish, qusish, qorin og'rig'i, terlash,
gepatotoksiklik mumkin. Darhol shifokorga murojaat qilish kerak.

7. Saqlash shartlari

25°C dan yuqori haroratda emas. Bolalardan uzoqda saqlang.
`;

export function example2_UzbekExtraction(): ExtractionResult {
  const input: ExtractionInput = {
    drugId: 'paracetamol-500mg-uz',
    text: uzbekInstructionText,
    language: 'uz',
    sourceRef: {
      url: 'https://registers.health.gov.uz/drugs/paracetamol',
      title: 'Paratsetamol, 500 mg tabletka - Qo'llanma',
      page: null,
      anchor: '',
      retrievedAt: '2024-01-15T12:00:00Z',
    },
  };

  const result = extractInstructionSections(input);

  console.log('\n=== Example 2: Uzbek Language Extraction ===');
  console.log('Drug ID:', result.drugId);
  console.log('Language:', result.language);
  console.log('Stats:', result.stats);

  return result;
}

// ============================================================================
// EXAMPLE 3: Source Normalization
// ============================================================================

export function example3_SourceNormalization(): void {
  console.log('\n=== Example 3: Source Normalization ===');

  // Example 3a: Normalize single source
  const rawSource = {
    url: 'grls.rosminzdrav.ru/GRLS.aspx?RegNumber=12345',
    title: '  Государственный реестр лекарственных средств  ',
    retrievedAt: '2024-01-15',
  };

  const normalized = normalizeSource(rawSource);

  console.log('Raw source:', rawSource);
  console.log('Normalized source:', {
    url: normalized.url,
    title: normalized.title,
    sourceType: normalized.sourceType,
    reliabilityScore: normalized.reliabilityScore,
    retrievedAt: normalized.retrievedAt,
  });

  // Example 3b: Normalize multiple sources
  const rawSources = [
    {
      url: 'vidal.ru/drugs/paracetamol',
      title: 'Парацетамол',
      retrievedAt: new Date('2024-01-10'),
    },
    {
      url: 'pfizer.com/products/paracetamol',
      title: 'Paracetamol Official',
      page: '5',
    },
    {
      url: 'some-unknown-site.com/drug-info',
      title: 'Drug Information',
    },
  ];

  const normalizedSources = normalizeSources(rawSources);

  console.log('\nMultiple sources normalization:');
  normalizedSources.forEach((src, i) => {
    console.log(`  Source ${i + 1}:`, {
      url: src.url,
      type: src.sourceType,
      reliability: src.reliabilityScore.toFixed(2),
    });
  });

  // Example 3c: Validate source
  const validation = validateSource(normalized);
  console.log('\nValidation result:', validation);
}

// ============================================================================
// EXAMPLE 4: Batch Processing
// ============================================================================

export function example4_BatchProcessing(): BatchExtractionResult {
  console.log('\n=== Example 4: Batch Processing ===');

  const batchInput = {
    items: [
      {
        drugId: 'drug-001',
        text: russianInstructionText,
        language: 'ru' as const,
        sourceRef: {
          url: 'https://example.com/drug-001',
          title: 'Drug 001',
          page: null,
          anchor: '',
          retrievedAt: '2024-01-15T10:00:00Z',
        },
      },
      {
        drugId: 'drug-002',
        text: uzbekInstructionText,
        language: 'uz' as const,
        sourceRef: {
          url: 'https://example.com/drug-002',
          title: 'Drug 002',
          page: null,
          anchor: '',
          retrievedAt: '2024-01-15T11:00:00Z',
        },
      },
    ],
  };

  const result = extractInstructionSectionsBatch(batchInput);

  console.log('Batch processing summary:', result.summary);

  result.results.forEach((res, i) => {
    console.log(`\nResult ${i + 1} (${res.drugId}):`);
    console.log(`  Found sections: ${res.stats.foundSections}/${res.stats.totalSections}`);
    console.log(`  High confidence: ${res.stats.highConfidenceFragments}`);
  });

  return result;
}

// ============================================================================
// EXAMPLE 5: Validation and Error Handling
// ============================================================================

export function example5_Validation(): void {
  console.log('\n=== Example 5: Validation ===');

  // Create a sample extraction result
  const input: ExtractionInput = {
    drugId: 'test-drug',
    text: russianInstructionText,
    language: 'ru',
    sourceRef: {
      url: 'https://example.com/test',
      title: 'Test Drug',
      page: null,
      anchor: '',
      retrievedAt: '2024-01-15T10:00:00Z',
    },
  };

  const result = extractInstructionSections(input);
  const validation = validateExtractionResult(result);

  console.log('Validation result:', validation);

  if (validation.valid) {
    console.log('✓ Extraction result is valid');
  } else {
    console.log('✗ Extraction result has errors:', validation.errors);
  }

  if (validation.warnings.length > 0) {
    console.log('⚠ Warnings:', validation.warnings);
  }
}

// ============================================================================
// EXAMPLE 6: Custom Patterns
// ============================================================================

export function example6_CustomPatterns(): ExtractionResult {
  console.log('\n=== Example 6: Custom Patterns ===');

  const customText = `
=== СОСТАВ ПРЕПАРАТА ===

Действующее вещество: ибупрофен 400 мг

=== ПРИМЕНЕНИЕ ===

Применять при головной боли и повышенной температуре.

=== ХРАНЕНИЕ ===

Хранить при температуре не выше 25°C.
`;

  const input: ExtractionInput = {
    drugId: 'ibuprofen-custom',
    text: customText,
    language: 'ru',
    sourceRef: {
      url: 'https://example.com/ibuprofen',
      title: 'Ibuprofen Custom Format',
      page: null,
      anchor: '',
      retrievedAt: '2024-01-15T10:00:00Z',
    },
    // Custom patterns for non-standard format
    customPatterns: {
      composition: [/^===\s*СОСТАВ[^=]*===\s*$/im],
      indications: [/^===\s*ПРИМЕНЕНИЕ[^=]*===\s*$/im],
      storage: [/^===\s*ХРАНЕНИЕ[^=]*===\s*$/im],
    },
  };

  const result = extractInstructionSections(input);

  console.log('Custom patterns result:');
  console.log('Found sections:', result.stats.foundSections);

  for (const [name, section] of Object.entries(result.sections)) {
    if (section.found) {
      console.log(`  ✓ ${name}`);
    }
  }

  return result;
}

// ============================================================================
// EXAMPLE 7: Source Merging
// ============================================================================

export function example7_SourceMerging(): void {
  console.log('\n=== Example 7: Source Merging ===');

  const sources: NormalizedSourceRef[] = [
    {
      url: 'https://grls.rosminzdrav.ru/drug/123',
      title: 'Official Register',
      page: null,
      anchor: '',
      retrievedAt: '2024-01-15T10:00:00Z',
      sourceType: 'official_register',
      reliabilityScore: 0.95,
      metadata: {},
    },
    {
      url: 'https://vidal.ru/drug/456',
      title: 'Vidal Database',
      page: null,
      anchor: '',
      retrievedAt: '2024-01-15T11:00:00Z',
      sourceType: 'medical_database',
      reliabilityScore: 0.85,
      metadata: {},
    },
    {
      url: 'https://random-site.com/drug',
      title: 'Unknown Source',
      page: null,
      anchor: '',
      retrievedAt: '2024-01-15T12:00:00Z',
      sourceType: 'unknown',
      reliabilityScore: 0.40,
      metadata: {},
    },
  ];

  const merged = mergeSources(sources);

  console.log('Merged source (most reliable):', {
    url: merged?.url,
    title: merged?.title,
    reliabilityScore: merged?.reliabilityScore,
    sourceType: merged?.sourceType,
  });
}

// ============================================================================
// RUN ALL EXAMPLES
// ============================================================================

export function runAllExamples(): void {
  example1_BasicRussianExtraction();
  example2_UzbekExtraction();
  example3_SourceNormalization();
  example4_BatchProcessing();
  example5_Validation();
  example6_CustomPatterns();
  example7_SourceMerging();

  console.log('\n=== All examples completed ===');
}

// Run examples if this file is executed directly
if (require.main === module) {
  runAllExamples();
}
