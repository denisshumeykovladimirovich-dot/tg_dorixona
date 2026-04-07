# Drug Instructions Database Architecture

## Overview

Production-grade architecture for a multilingual drug instructions database supporting Russian (RU) and Uzbek (UZ) languages, designed for scale up to 100,000 drug entries with full source traceability.

## Core Principles

1. **Source Traceability**: Every piece of data must be traceable to its official source
2. **Two-Layer Model**: Structured data + verbatim source fragments
3. **Multi-Language Support**: Native support for RU and UZ
4. **Scalability**: Designed for 100,000+ drug entries
5. **Type Safety**: Strict JSON Schema validation
6. **Evidence-Based**: Clear evidence levels for all medical claims

## Directory Structure

```
/mnt/okcomputer/output/
├── schemas/
│   ├── catalog.schema.json      # Schema for catalog.json
│   └── instruction.schema.json  # Schema for individual instruction files
├── data/
│   ├── catalog.json             # Master catalog index
│   └── instructions/            # Individual instruction files
│       ├── a/                   # Sharded by first letter of normalizedKey
│       │   ├── aspirin.json
│       │   └── amoxicillin.json
│       ├── b/
│       │   └── ibuprofen.json
│       └── ...
├── sources/                     # Original source documents (PDFs, etc.)
│   ├── ru/
│   │   └── rlssubrf/
│   └── uz/
│       └── uzpharm/
├── extractions/                 # AI extraction outputs (for audit)
│   └── 2024-01/
│       └── extraction-uuid.json
└── ARCHITECTURE.md             # This file
```

## Two-Layer Data Model

### Layer 1: Structured Data

Machine-readable, normalized data points extracted from sources:

```json
{
  "structured": [
    {
      "id": "indication-001",
      "content": "Головная боль",
      "contentType": "indication",
      "language": "ru",
      "sourceRef": "frag-001",
      "confidence": 0.95,
      "metadata": {
        "severity": "medium",
        "ageGroup": "adult"
      }
    }
  ]
}
```

### Layer 2: Source Fragments

Verbatim text from original sources for verification:

```json
{
  "sourceFragments": [
    {
      "id": "frag-001",
      "text": "Показания: головная боль, мигрень, зубная боль...",
      "language": "ru",
      "pageNumber": 2,
      "sectionName": "Показания к применению",
      "context": "..."
    }
  ]
}
```

## Catalog Structure

The `catalog.json` serves as the master index:

```json
{
  "version": "1.0.0",
  "lastUpdated": "2024-01-15T10:30:00Z",
  "totalCount": 15420,
  "drugs": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "canonicalName": {
        "ru": "Парацетамол",
        "uz": "Paratsetamol",
        "en": "Paracetamol"
      },
      "normalizedKey": "paracetamol",
      "aliases": {
        "ru": ["Ацетаминофен"],
        "uz": ["Asetaminofen"],
        "en": ["Acetaminophen"],
        "brands": ["Tylenol", "Panadol", "Efferalgan"],
        "transliterations": ["Paracetamol"],
        "commonMisspellings": ["parasetamol", "paracetamole"]
      },
      "searchTokens": ["жар", "боль", "лихорадка"],
      "therapeuticClass": ["N02BE01"],
      "pharmacologicalClass": ["Анальгетик", "Антипиретик"],
      "symptomTags": ["головная-боль", "жар", "боль"],
      "commonUseCases": ["Головная боль", "Высокая температура"],
      "dosageForms": ["tablet", "syrup", "suppository"],
      "ageBucketsSupported": ["infant", "child", "adult", "elderly"],
      "hasOfficialInstruction": true,
      "instructionFile": "p/paracetamol.json",
      "sourcePriority": 9,
      "reviewStatus": "medically_verified",
      "needsManualReview": false
    }
  ]
}
```

## Instruction File Structure

Individual instruction files contain complete drug information:

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "schemaVersion": "1.0.0",
  "reviewStatus": "medically_verified",
  "needsManualReview": false,
  "canonicalName": {
    "ru": "Парацетамол",
    "uz": "Paratsetamol",
    "en": "Paracetamol"
  },
  "identity": {
    "activeSubstance": [
      {
        "name": "Парацетамол",
        "nameEn": "Paracetamol",
        "strength": "500",
        "unit": "мг"
      }
    ],
    "drugForm": "Таблетки",
    "dosageForms": ["tablet"],
    "strengths": ["200 мг", "500 мг"],
    "atcCodes": ["N02BE01"]
  },
  "source": {
    "sourceType": "official_instruction",
    "title": "Инструкция по медицинскому применению лекарственного препарата Парацетамол",
    "organization": "Минздрав России",
    "country": "RU",
    "language": "ru",
    "url": "https://grls.rosminzdrav.ru/...",
    "accessDate": "2024-01-10",
    "publicationDate": "2023-06-15",
    "evidenceLevel": "A"
  },
  "sections": {
    "composition": { /* Two-layer section */ },
    "indications": { /* Two-layer section */ },
    "contraindications": { /* Two-layer section */ },
    "dosageAndAdministration": { /* Two-layer section */ },
    "sideEffects": { /* Two-layer section */ },
    "interactions": { /* Two-layer section */ },
    "specialWarnings": { /* Two-layer section */ },
    "pregnancy": { /* Two-layer section */ },
    "lactation": { /* Two-layer section */ },
    "overdose": { /* Two-layer section */ },
    "storage": { /* Two-layer section */ }
  },
  "extractions": {
    "shortUserLabel": {
      "ru": "Жаропонижающее и обезболивающее",
      "uz": "Isitma tushiruvchi va og'riq qoldiruvchi"
    },
    "symptoms": ["головная боль", "жар", "боль"],
    "symptomTags": ["головная-боль", "жар", "боль"],
    "commonUseCases": ["Головная боль", "Высокая температура"],
    "ageSummary": { /* Age-specific info */ },
    "interactionSummary": { /* Interaction summary */ },
    "riskSignals": [ /* Critical warnings */ ],
    "botSafeSummary": { /* LLM-safe summary */ }
  },
  "llmContextBlocks": [
    {
      "contextType": "general",
      "content": "...",
      "language": "ru",
      "tokenCount": 450
    }
  ]
}
```

## Scaling Strategy

### Sharding

Instruction files are sharded by first letter of `normalizedKey`:

```
instructions/
├── a/  # ~3,800 files (3.8%)
├── b/  # ~2,400 files (2.4%)
├── v/  # ~4,200 files (4.2%)
├── g/  # ~3,100 files (3.1%)
├── d/  # ~2,800 files (2.8%)
├── e/  # ~1,500 files (1.5%)
├── zh/ # ~800 files (0.8%)
├── z/  # ~2,200 files (2.2%)
├── i/  # ~4,500 files (4.5%)
├── k/  # ~5,200 files (5.2%)
├── l/  # ~3,600 files (3.6%)
├── m/  # ~4,800 files (4.8%)
├── n/  # ~2,100 files (2.1%)
├── o/  # ~1,800 files (1.8%)
├── p/  # ~6,200 files (6.2%)
├── r/  # ~4,900 files (4.9%)
├── s/  # ~5,500 files (5.5%)
├── t/  # ~3,700 files (3.7%)
├── u/  # ~1,200 files (1.2%)
├── f/  # ~2,300 files (2.3%)
├── kh/ # ~1,100 files (1.1%)
├── ts/ # ~600 files (0.6%)
├── ch/ # ~900 files (0.9%)
├── sh/ # ~1,400 files (1.4%)
├── shch/# ~300 files (0.3%)
├── y/  # ~800 files (0.8%)
├── e/  # ~400 files (0.4%)
├── yu/ # ~500 files (0.5%)
├── ya/ # ~700 files (0.7%)
└── 0-9/# ~500 files (0.5%)
```

### Catalog Optimization

For 100,000 entries:

1. **Memory**: ~50-100MB for full catalog in memory
2. **Search**: Use searchTokens for inverted index
3. **Pagination**: Return 20-50 results per query
4. **Caching**: Cache popular queries
5. **Incremental Updates**: Update only changed entries

### File System Limits

- Maximum files per directory: 10,000 (safe limit)
- Average file size: 15-50KB
- Total storage: ~2-5GB for 100,000 entries

## Source Types and Evidence Levels

### Evidence Levels

| Level | Description | Examples |
|-------|-------------|----------|
| A | High quality evidence | RCTs, systematic reviews |
| B | Moderate evidence | Cohort studies, regulatory data |
| C | Limited evidence | Case reports, expert opinion |
| D | Very limited evidence | Anecdotal, theoretical |
| unknown | Unknown/Unclassified | Default for new entries |

### Source Types

| Type | Priority | Description |
|------|----------|-------------|
| official_instruction | 10 | Official regulatory instruction |
| regulatory_database | 9 | Government drug database |
| who_database | 9 | WHO Essential Medicines |
| clinical_guideline | 8 | Professional medical guidelines |
| pharmacopoeia | 8 | Official pharmacopoeia |
| medical_literature | 6 | Peer-reviewed publications |
| manufacturer_data | 5 | Manufacturer documentation |
| other | 3 | Other sources |

## Review Status Workflow

```
pending → auto_extracted → human_reviewed → medically_verified
              ↓                    ↓
         [needs review]      [deprecated]
```

| Status | Description |
|--------|-------------|
| pending | New entry, awaiting processing |
| auto_extracted | AI-extracted, needs review |
| human_reviewed | Reviewed by human, not medically verified |
| medically_verified | Verified by medical professional |
| deprecated | No longer recommended/valid |

## Normalization Rules

### normalizedKey Generation

1. Convert to lowercase
2. Remove special characters except hyphens
3. Replace spaces with hyphens
4. Remove duplicate hyphens
5. Trim hyphens from ends

Examples:
- "Парацетамол" → "paracetamol"
- "Амоксициллин 500 мг" → "amoksitsillin-500-mg"
- "Витамин B12" → "vitamin-b12"

### Search Token Generation

1. Extract keywords from all name variants
2. Include symptom tags
3. Include use cases
4. Normalize (lowercase, remove punctuation)
5. Remove stop words
6. Deduplicate

## Multi-Language Support

### Russian (RU)

- Primary language for regulatory sources
- Cyrillic script
- Full support in all fields

### Uzbek (UZ)

- Latin script (modern standard)
- Transliteration support for Cyrillic legacy
- Full support in all fields

### English (EN)

- International Nonproprietary Names (INN)
- Optional but recommended
- Used for cross-referencing

## Validation Rules

### Catalog Entry Validation

1. UUID v4 format for IDs
2. At least RU and UZ canonical names required
3. normalizedKey must be unique
4. ATC codes must match pattern
5. Dates must be ISO 8601 format

### Instruction Validation

1. ID must match catalog entry
2. Source must have required fields
3. At least composition, indications, contraindications, dosage sections required
4. All structured items must have sourceRef
5. Confidence scores must be 0-1

## Security Considerations

1. **No PII**: No patient data in any files
2. **Source Attribution**: All data traceable to source
3. **Version Control**: Track all changes
4. **Audit Trail**: Log all modifications
5. **Read-Only API**: Public access should be read-only

## API Design Recommendations

### Search Endpoint

```
GET /api/v1/drugs/search?q={query}&lang={lang}&limit={limit}
```

### Drug Detail Endpoint

```
GET /api/v1/drugs/{id}
```

### Batch Endpoint

```
POST /api/v1/drugs/batch
Body: { "ids": ["id1", "id2", ...] }
```

## Migration Strategy

### Version Compatibility

- Schema version in every file
- Backward compatibility for 2 major versions
- Migration scripts for schema updates

### Data Migration

1. Export current data
2. Validate against new schema
3. Transform if needed
4. Validate transformed data
5. Import to new structure
6. Verify integrity

## Monitoring and Metrics

### Key Metrics

1. Total drug count
2. Coverage by source type
3. Review status distribution
4. Language coverage
5. Search performance
6. Error rates

### Alerts

1. Schema validation failures
2. Missing source references
3. Low confidence extractions
4. Deprecated entries still in use

## Future Extensions

1. **Images**: Drug photos, packaging
2. **Videos**: Administration instructions
3. **Audio**: Text-to-speech for accessibility
4. **Interactions**: Full interaction database
5. **Pricing**: Cost information
6. **Availability**: Pharmacy stock status

## Schema Files

- `/mnt/okcomputer/output/schemas/catalog.schema.json`
- `/mnt/okcomputer/output/schemas/instruction.schema.json`

## License and Attribution

All data must include source attribution. Official sources:

- Russian: Государственный реестр лекарственных средств (grls.rosminzdrav.ru)
- Uzbek: Фармацевтическая промышленность Узбекистана
- WHO: WHO Model List of Essential Medicines
