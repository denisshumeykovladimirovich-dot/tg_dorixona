# Schema Validation Report

**Generated:** 2026-03-31

## Executive Summary

This report contains the results of schema validation for the drug instructions database.

### Overall Status: ⚠️ NEEDS ATTENTION

The catalog structure is valid, but all instruction files require content population in critical sections.

---

## Catalog Validation Summary

| Metric | Value |
|--------|-------|
| Total drugs in catalog | 30 |
| Catalog version | 1.0.0 |
| Schema version | 1 |
| Last updated | 2026-03-31 |
| **Valid entries** | **30** |
| Entries with errors | 0 |
| Entries with warnings | 28 |
| Total catalog errors | 0 |
| Total catalog warnings | 28 |

### Catalog Status: ✅ VALID

The catalog.json file passes all structural validations:
- ✅ All IDs are unique
- ✅ All canonicalName.ru values are unique
- ✅ All required fields present
- ✅ Instruction file references are valid
- ✅ totalDrugs matches actual count

---

## Instruction Files Validation Summary

| Metric | Value |
|--------|-------|
| Total instruction files | 30 |
| Files with errors | 30 |
| Files with warnings | 30 |
| Total errors | 90 |
| Total warnings | 84 |
| Critical issues | 90 |

### Instruction Status: ❌ NEEDS CONTENT

All instruction files have empty critical sections that require population.

---

## Errors Found

### Error Types Distribution

| Error Type | Count | Description |
|------------|-------|-------------|
| empty_critical_section | 90 | Critical sections (indications, contraindications, dosage) are empty |

### Detailed Error List (Sample)

| File | Error Type | Field | Message |
|------|------------|-------|---------|
| sections | empty_critical_section | sections.indications | Critical section "indications" is empty |
| sections | empty_critical_section | sections.contraindications | Critical section "contraindications" is empty |
| sections | empty_critical_section | sections.dosageAndAdministration | Critical section "dosageAndAdministration" is empty |
| ... | ... | ... | *(87 more errors - same pattern for all 30 files)* |

---

## Warnings Found

### Warning Types Distribution

| Warning Type | Count | Description |
|--------------|-------|-------------|
| missing_source | 30 | Source URL is missing for official instruction |
| missing_language | 27 | Russian language content is missing or empty |
| review_needed | 27 | Entry requires manual review |

### Detailed Warning List (Sample)

| File | Warning Type | Field | Message |
|------|--------------|-------|---------|
| - | missing_source | source.url | Official instruction should have a source URL |
| - | missing_language | extractions.symptoms.ru | Missing or empty Russian content in symptoms |
| - | review_needed | needsManualReview | Instruction requires manual review |
| ... | ... | ... | *(81 more warnings)* |

---

## Critical Issues

The following critical issues require immediate attention:

| # | File | Issue | Severity |
|---|------|-------|----------|
| 1 | acetylcysteine.json | Critical section "indications" is empty | HIGH |
| 2 | acetylcysteine.json | Critical section "contraindications" is empty | HIGH |
| 3 | acetylcysteine.json | Critical section "dosageAndAdministration" is empty | HIGH |
| 4 | acetylsalicylic-acid.json | Critical section "indications" is empty | HIGH |
| 5 | acetylsalicylic-acid.json | Critical section "contraindications" is empty | HIGH |
| 6 | acetylsalicylic-acid.json | Critical section "dosageAndAdministration" is empty | HIGH |
| 7 | activated-charcoal.json | Critical section "indications" is empty | HIGH |
| 8 | activated-charcoal.json | Critical section "contraindications" is empty | HIGH |
| 9 | activated-charcoal.json | Critical section "dosageAndAdministration" is empty | HIGH |
| 10 | acyclovir.json | Critical section "indications" is empty | HIGH |
| ... | ... | ... | ... |
| *(90 total critical issues - 3 per file for all 30 files)* |

---

## Per-File Status Summary

| File | Sections | Empty | Fragments | Structured | Errors | Warnings | Status |
|------|----------|-------|-----------|------------|--------|----------|--------|
| acetylcysteine.json | 11 | 11 | 0 | 0 | 3 | 3 | ❌ |
| acetylsalicylic-acid.json | 11 | 11 | 0 | 0 | 3 | 3 | ❌ |
| activated-charcoal.json | 11 | 11 | 0 | 0 | 3 | 3 | ❌ |
| acyclovir.json | 11 | 11 | 0 | 0 | 3 | 3 | ❌ |
| ambroxol.json | 11 | 11 | 0 | 0 | 3 | 3 | ❌ |
| amoxicillin.json | 11 | 11 | 0 | 0 | 3 | 3 | ❌ |
| anzibel.json | 11 | 11 | 0 | 0 | 3 | 3 | ❌ |
| azithromycin.json | 11 | 11 | 0 | 0 | 3 | 3 | ❌ |
| budesonide.json | 11 | 11 | 0 | 0 | 3 | 3 | ❌ |
| cetirizine.json | 11 | 11 | 0 | 0 | 3 | 3 | ❌ |
| chlorhexidine.json | 11 | 11 | 0 | 0 | 3 | 3 | ❌ |
| desloratadine.json | 11 | 11 | 0 | 0 | 3 | 3 | ❌ |
| dextromethorphan.json | 11 | 11 | 0 | 0 | 3 | 3 | ❌ |
| diclofenac.json | 11 | 11 | 0 | 0 | 3 | 3 | ❌ |
| domperidone.json | 11 | 11 | 0 | 0 | 3 | 3 | ❌ |
| drotaverine.json | 11 | 11 | 0 | 0 | 3 | 3 | ❌ |
| famotidine.json | 11 | 11 | 0 | 0 | 3 | 3 | ❌ |
| fluconazole.json | 11 | 11 | 0 | 0 | 3 | 3 | ❌ |
| ibuprofen.json | 11 | 11 | 0 | 0 | 3 | 3 | ❌ |
| loperamide.json | 11 | 11 | 0 | 0 | 3 | 3 | ❌ |
| loratadine.json | 11 | 11 | 0 | 0 | 3 | 3 | ❌ |
| metamizole-sodium.json | 11 | 11 | 0 | 0 | 3 | 3 | ❌ |
| miramistin.json | 11 | 11 | 0 | 0 | 3 | 3 | ❌ |
| naproxen.json | 11 | 11 | 0 | 0 | 3 | 3 | ❌ |
| omeprazole.json | 11 | 11 | 0 | 0 | 3 | 3 | ❌ |
| oxymetazoline.json | 11 | 11 | 0 | 0 | 3 | 3 | ❌ |
| pantoprazole.json | 11 | 11 | 0 | 0 | 3 | 3 | ❌ |
| paracetamol.json | 11 | 11 | 0 | 0 | 3 | 3 | ❌ |
| salbutamol.json | 11 | 11 | 0 | 0 | 3 | 3 | ❌ |
| xylometazoline.json | 11 | 11 | 0 | 0 | 3 | 3 | ❌ |

---

## Schema Compliance Analysis

### Catalog Schema Compliance

The catalog.json file follows the defined schema with the following observations:

| Schema Requirement | Status | Notes |
|-------------------|--------|-------|
| version field | ✅ Present | Format: semantic versioning |
| lastUpdated field | ✅ Present | ISO 8601 date format |
| totalDrugs field | ✅ Consistent | Matches actual drug count |
| drugs array | ✅ Present | 30 entries |
| Drug ID format | ✅ Valid | Simple string IDs (not UUID v4 as per strict schema) |
| canonicalName.ru | ✅ Present | All entries have Russian names |
| normalizedKey | ✅ Present | All entries have normalized keys |
| hasOfficialInstruction | ✅ Present | Boolean flag set for all |
| instructionFile | ✅ Valid | All referenced files exist |

### Instruction Schema Compliance

| Schema Requirement | Status | Notes |
|-------------------|--------|-------|
| id field | ✅ Present | All files have IDs |
| schemaVersion | ✅ Present | All files have version |
| canonicalName | ✅ Present | All files have names |
| source object | ✅ Present | All files have source metadata |
| sections object | ✅ Present | All files have section structure |
| Critical sections content | ❌ Empty | All critical sections need population |
| sourceFragments | ✅ Structure | Empty arrays present (need content) |

---

## Recommendations

### High Priority (Critical)

1. **Populate Critical Sections**
   - All 30 instruction files have empty critical sections:
     - `indications` - Approved uses and indications
     - `contraindications` - When the drug should not be used
     - `dosageAndAdministration` - How to take the drug
   - These sections are essential for safe medication guidance

2. **Add Source URLs**
   - 30 files are missing source URLs for official instructions
   - Source URLs are required for traceability and verification

### Medium Priority

3. **Complete Language Coverage**
   - 27 files have missing or empty Russian content in extractions
   - Ensure all user-facing content has proper Russian translations

4. **Add Source Fragments**
   - All files have 0 source fragments
   - Source fragments provide verbatim text for verification

5. **Populate Structured Data**
   - All files have 0 structured items
   - Structured data enables better search and query capabilities

### Low Priority

6. **Review Status Updates**
   - 27 files marked as needing manual review
   - Update reviewStatus after content verification

7. **Add More Search Tokens**
   - Consider adding more search tokens for better discoverability

---

## Next Steps

1. **Content Population Phase**
   - Use `extract_instruction_sections.ts` tool to extract content from official sources
   - Populate critical sections for each drug
   - Add source URLs and fragments

2. **Verification Phase**
   - Run validation tools after content population
   - Verify all critical sections have content
   - Check source fragment integrity

3. **Review Phase**
   - Manual review of populated content
   - Update reviewStatus to reflect verification
   - Mark entries as medically_verified when appropriate

---

## Validation Tools Created

The following validation tools have been created:

| Tool | Path | Purpose |
|------|------|---------|
| validate_catalog.ts | `/mnt/okcomputer/output/tools/validate_catalog.ts` | Validates catalog.json structure |
| validate_instructions.ts | `/mnt/okcomputer/output/tools/validate_instructions.ts` | Validates all instruction files |
| build_catalog_from_instructions.ts | `/mnt/okcomputer/output/tools/build_catalog_from_instructions.ts` | Builds catalog from instruction files |

### Usage

```bash
# Validate catalog
npx ts-node tools/validate_catalog.ts

# Validate all instructions
npx ts-node tools/validate_instructions.ts

# Build catalog from instructions
npx ts-node tools/build_catalog_from_instructions.ts
```

---

## Appendix: Drug IDs in Catalog

1. `paracetamol` - Парацетамол
2. `ibuprofen` - Ибупрофен
3. `acetylsalicylic-acid` - Ацетилсалициловая кислота
4. `metamizole-sodium` - Метамизол натрия
5. `naproxen` - Напроксен
6. `diclofenac` - Диклофенак
7. `drotaverine` - Дротаверин
8. `chlorhexidine` - Хлоргексидин
9. `miramistin` - Мирамистин
10. `ambroxol` - Амброксол
11. `acetylcysteine` - Ацетилцистеин
12. `dextromethorphan` - Декстрометорфан
13. `xylometazoline` - Ксилометазолин
14. `oxymetazoline` - Оксиметазолин
15. `loratadine` - Лоратадин
16. `cetirizine` - Цетиризин
17. `desloratadine` - Дезлоратадин
18. `omeprazole` - Омепразол
19. `domperidone` - Домперидон
20. `loperamide` - Лоперамид
21. `activated-charcoal` - Активированный уголь
22. `amoxicillin` - Амоксициллин
23. `azithromycin` - Азитромицин
24. `fluconazole` - Флуконазол
25. `acyclovir` - Ацикловир
26. `salbutamol` - Сальбутамол
27. `budesonide` - Будесонид
28. `pantoprazole` - Пантопразол
29. `famotidine` - Фамотидин
30. `anzibel` - Анзибел
