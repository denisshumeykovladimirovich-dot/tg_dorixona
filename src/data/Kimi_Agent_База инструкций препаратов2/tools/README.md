# Instruction Section Extractor Tools

Инструменты для разбора официальных инструкций по препаратам на стандартизированные разделы.

## Содержание

- [Обзор](#обзор)
- [Установка](#установка)
- [Использование](#использование)
- [API Reference](#api-reference)
- [Примеры](#примеры)
- [Шаблоны разбора](#шаблоны-разбора)

## Обзор

Данный набор инструментов предназначен для:

1. **extract_instruction_sections.ts** - разбора текстов инструкций на стандартизированные разделы
2. **normalize_sources.ts** - нормализации метаданных источников

### Поддерживаемые разделы

| Раздел | Название (RU) | Название (UZ) |
|--------|---------------|---------------|
| composition | Состав | Tarkib |
| indications | Показания | Ko'rsatmalar |
| contraindications | Противопоказания | Qarshi ko'rsatmalar |
| dosageAndAdministration | Способ применения и дозы | Qollash usuli va dozalari |
| sideEffects | Побочное действие | Yon ta'sir |
| interactions | Взаимодействие | O'zaro ta'sir |
| specialWarnings | Особые указания | Maxsus ko'rsatmalar |
| pregnancy | Беременность | Homiladorlik |
| lactation | Лактация | Laktatsiya |
| overdose | Передозировка | Dozani oshirish |
| storage | Условия хранения | Saqlash shartlari |

## Установка

```typescript
// Импорт основных функций
import {
  extractInstructionSections,
  extractInstructionSectionsBatch,
  validateExtractionResult,
} from './extract_instruction_sections';

import {
  normalizeSource,
  normalizeSources,
  validateSource,
} from './normalize_sources';
```

## Использование

### Базовый пример

```typescript
import { extractInstructionSections } from './extract_instruction_sections';
import { normalizeSource } from './normalize_sources';

// Нормализация источника
const sourceRef = normalizeSource({
  url: 'grls.rosminzdrav.ru/GRLS.aspx?RegNumber=12345',
  title: 'Парацетамол - Инструкция',
  retrievedAt: '2024-01-15',
});

// Разбор инструкции
const result = extractInstructionSections({
  drugId: 'paracetamol-500mg',
  text: instructionText,
  language: 'ru',
  sourceRef,
});

// Результат
console.log(result.sections.composition);
// {
//   section: 'composition',
//   found: true,
//   fragments: [{
//     fragmentId: 'paracetamol-500mg-composition-ru-0',
//     section: 'composition',
//     language: 'ru',
//     text: 'Действующее вещество: парацетамол - 500 мг...',
//     sourceRef: { ... },
//     confidence: 'high',
//     isVerbatim: true
//   }]
// }
```

### Пакетная обработка

```typescript
import { extractInstructionSectionsBatch } from './extract_instruction_sections';

const batchResult = extractInstructionSectionsBatch({
  items: [
    { drugId: 'drug-1', text: text1, language: 'ru', sourceRef: source1 },
    { drugId: 'drug-2', text: text2, language: 'uz', sourceRef: source2 },
    // ...
  ],
});

console.log(batchResult.summary);
// {
//   totalProcessed: 10,
//   successful: 10,
//   failed: 0,
//   averageSectionsFound: 8.5
// }
```

## API Reference

### extractInstructionSections(input)

Разбивает текст инструкции на стандартизированные разделы.

**Параметры:**

| Параметр | Тип | Описание |
|----------|-----|----------|
| drugId | string | Идентификатор препарата |
| text | string | Полный текст инструкции |
| language | 'ru' \| 'uz' | Язык инструкции |
| sourceRef | SourceRef | Метаданные источника |
| customPatterns | object | (опционально) Пользовательские паттерны |

**Возвращает:** `ExtractionResult`

### normalizeSource(input, options)

Нормализует метаданные источника.

**Параметры:**

| Параметр | Тип | Описание |
|----------|-----|----------|
| url | string | URL источника |
| title | string | Название документа |
| page | number \| string | Номер страницы |
| anchor | string | Якорь/раздел |
| retrievedAt | string \| Date | Время получения |

**Возвращает:** `NormalizedSourceRef`

## Примеры

См. файл `examples.ts` для полных примеров использования:

- `example1_BasicRussianExtraction()` - базовый разбор на русском
- `example2_UzbekExtraction()` - разбор на узбекском
- `example3_SourceNormalization()` - нормализация источников
- `example4_BatchProcessing()` - пакетная обработка
- `example5_Validation()` - валидация результатов
- `example6_CustomPatterns()` - пользовательские паттерны
- `example7_SourceMerging()` - объединение источников

## Шаблоны разбора

### Русский язык (RU)

```typescript
const RU_SECTION_PATTERNS = {
  composition: [
    /^(?:\d+\.\s*)?(?:Состав|СОСТАВ)[\s:]*$/im,
    /^(?:\d+\.\s*)?(?:Лекарственная форма|ЛЕКАРСТВЕННАЯ ФОРМА)[\s:]*$/im,
  ],
  indications: [
    /^(?:\d+\.\s*)?(?:Показания|ПОКАЗАНИЯ)[\s:]*$/im,
    /^(?:\d+\.\s*)?(?:Показания к применению|ПОКАЗАНИЯ К ПРИМЕНЕНИЮ)[\s:]*$/im,
  ],
  contraindications: [
    /^(?:\d+\.\s*)?(?:Противопоказания|ПРОТИВОПОКАЗАНИЯ)[\s:]*$/im,
  ],
  // ... и т.д.
};
```

### Узбекский язык (UZ)

```typescript
const UZ_SECTION_PATTERNS = {
  composition: [
    /^(?:\d+\.\s*)?(?:Tarkib|TARKIB)[\s:]*$/im,
    /^(?:\d+\.\s*)?(?:Dori shakli|DORI SHAKLI)[\s:]*$/im,
  ],
  indications: [
    /^(?:\d+\.\s*)?(?:Ko'rsatmalar|KO'RSATMALAR)[\s:]*$/im,
  ],
  // ... и т.д.
};
```

## Структура SourceFragment

```typescript
interface SourceFragment {
  fragmentId: string;        // Уникальный ID: "{drug-id}-{section}-{lang}-{index}"
  section: SectionName;      // Название раздела
  language: Language;        // 'ru' или 'uz'
  text: string;              // Точный текст из источника
  sourceRef: SourceRef;      // Метаданные источника
  confidence: 'high' | 'medium'; // Уверенность в разборе
  isVerbatim: true;          // Всегда true
}
```

## Структура SourceRef

```typescript
interface SourceRef {
  url: string;               // URL источника
  title: string;             // Название документа
  page: number | null;       // Номер страницы
  anchor: string;            // Якорь/раздел
  retrievedAt: string;       // ISO timestamp
}
```

## Типы источников

Источники классифицируются автоматически:

| Тип | Описание | Надёжность |
|-----|----------|------------|
| official_register | Официальный реестр (ГРЛС) | 0.95 |
| manufacturer | Сайт производителя | 0.90 |
| medical_database | Мед. база (Vidal, RLSD) | 0.85 |
| government_portal | Правительственный портал | 0.80 |
| educational | Образовательный ресурс | 0.70 |
| pharmacy_chain | Аптечная сеть | 0.60 |
| unknown | Неизвестный тип | 0.40 |

## Обработка отсутствующих разделов

Если раздел не найден в источнике:

```typescript
{
  section: 'pregnancy',
  found: false,
  fragments: [],
  missingReason: 'missing_in_source'
}
```

Возможные значения `missingReason`:
- `missing_in_source` - раздел отсутствует в источнике
- `parsing_error` - ошибка при разборе
- `language_not_supported` - язык не поддерживается

## Лицензия

MIT
