# Coverage Report

## Summary

| Metric | Count | Percentage |
|--------|-------|------------|
| Total drugs in database | 101 | 100% |
| Drugs with complete sections | 0 | 0% |
| Drugs with RU coverage | 101 | 100% |
| Drugs with UZ coverage | 0 | 0% |
| Drugs with official source URL | 0 | 0% |
| Drugs with structured dosage | 0 | 0% |
| Drugs with interactions | 0 | 0% |
| Drugs with symptomTags | 3 | 3.0% |
| Drugs with symptoms data | 3 | 3.0% |
| Drugs needing manual review | 100 | 99.0% |
| Records recovered from encoding issues | 100 | 99.0% |

## Coverage by Category

| Category | Total | With Symptoms | With symptomTags | With RU | With UZ | With Source | Complete |
|----------|-------|---------------|------------------|---------|---------|-------------|----------|
| Жаропонижающее | 2 | 2 | 2 | 2 | 0 | 0 | 0 |
| Для горла | 1 | 1 | 1 | 1 | 0 | 0 | 0 |
| Прочее | 98 | 0 | 0 | 98 | 0 | 0 | 0 |

## Detailed Category Breakdown

### By Pharmacological Groups (Estimated)

| Group | Count | With Symptoms | Coverage % |
|-------|-------|---------------|------------|
| NSAIDs (противовоспалительные) | 12 | 0 | 0% |
| Антибиотики | 19 | 0 | 0% |
| Антигистаминные | 10 | 0 | 0% |
| Бронхолитики/От кашля | 11 | 0 | 0% |
| Средства от насморка | 6 | 0 | 0% |
| ЖКТ препараты | 20 | 0 | 0% |
| Антисептики/Дезинфицирующие | 6 | 0 | 0% |
| Гормональные | 5 | 0 | 0% |
| Прочие (сердечно-сосудистые, метаболические) | 11 | 0 | 0% |
| Жаропонижающие | 2 | 2 | 100% |
| Для горла | 1 | 1 | 100% |

## Section Coverage

| Section | Drugs with Data | Coverage % | Status |
|---------|-----------------|------------|--------|
| id | 101 | 100% | Complete |
| displayName | 101 | 100% | Complete |
| aliases | 101 | 100% | Complete |
| category | 101 | 100% | Complete |
| symptoms | 3 | 3.0% | Critical Gap |
| symptomTags | 3 | 3.0% | Critical Gap |
| composition | 0 | 0% | Missing |
| indications | 0 | 0% | Missing |
| contraindications | 0 | 0% | Missing |
| dosageAndAdministration | 0 | 0% | Missing |
| sideEffects | 0 | 0% | Missing |
| interactions | 0 | 0% | Missing |
| specialWarnings | 0 | 0% | Missing |
| pregnancy | 0 | 0% | Missing |
| lactation | 0 | 0% | Missing |
| overdose | 0 | 0% | Missing |
| storage | 0 | 0% | Missing |
| manufacturer | 0 | 0% | Missing |
| country | 0 | 0% | Missing |
| sourceUrl | 0 | 0% | Missing |

## Data Quality Metrics

### Completeness Score
- Overall: 3.0% (only basic identifiers present)
- Symptoms mapping: 3.0%
- Structured sections: 0%
- Source attribution: 0%

### Data Integrity
- Records with encoding issues fixed: 100 (99.0%)
- Records with broken fields (before): 0
- Records with broken fields (after): 0
- Records needing manual review: 100 (99.0%)

### Language Coverage
| Language | Count | Percentage |
|----------|-------|------------|
| Russian (RU) | 101 | 100% |
| Uzbek (UZ) | 0 | 0% |
| English (EN) | 0 | 0% |

## Critical Gaps

### High Priority
1. **Structured sections missing** - 101 drugs need full instruction sections
2. **No source URLs** - All drugs lack official source attribution
3. **No Uzbek translation** - 0% UZ coverage
4. **Symptoms data** - Only 3 drugs have symptoms mapped

### Medium Priority
1. **Dosage information** - No structured dosage data
2. **Interactions** - No drug interaction data
3. **Contraindications** - No structured contraindications

### Low Priority
1. **Storage conditions** - Not critical for basic usage
2. **Manufacturer details** - Can be added later

## Recommendations

1. **Immediate**: Add structured sections for top 20 most common drugs
2. **Short-term**: Integrate with RLSnet or similar official source for RU instructions
3. **Medium-term**: Add Uzbek translations for all drugs
4. **Long-term**: Complete symptoms mapping for all drugs

## Drugs with Complete Data (Reference)

| Drug ID | Display Name | Category | Has Symptoms | Has symptomTags | Status |
|---------|--------------|----------|--------------|-----------------|--------|
| paracetamol | Paracetamol | Жаропонижающее | Yes | Yes | Complete (needs review) |
| metamizole-sodium | Metamizole Sodium | Жаропонижающее | Yes | Yes | Complete (needs review) |
| anzibel | Анзибел | Для горла | Yes | Yes | Complete |

---
*Report generated from REPORT_DRUGS_AND_SYMPTOMS.md*
*Total drugs analyzed: 101*
