# Project Working Rules

## Source of truth

- The only editable primary medication database file is:
  - `src/data/drugDatabase.json`
- Treat `src/*` as the only source-of-truth code and data layer.
- Treat `dist/*` as generated build output only.

## dist policy

- Never manually edit any file inside `dist/*`.
- Never use `dist/*` as an input source for code or data changes.
- Never create fixes by patching compiled files in `dist/*`.
- If runtime output must change, modify `src/*` or source data, then rebuild.

## Database policy

- Keep exactly one primary editable database file:
  - `src/data/drugDatabase.json`
- Do not create competing source files like:
  - `drugDatabase_v2.json`
  - `drugDatabase_new.json`
  - `drugDatabase_final.json`
- If schema changes are needed, migrate the existing source file instead of creating parallel primaries.
- `dist/data/drugDatabase.json` is build output only.

## Runtime compatibility policy

- Preserve the current wizard flow unless a task explicitly requires changing it.
- Preserve `parseMedications(...)` compatibility unless a task explicitly requires changing it.
- Preserve `analyzeMedications(...)` behavior unless a task explicitly requires changing it.
- Prefer adapter layers over engine rewrites.

## Change policy

Before changing anything, verify:
1. what file is the real source of truth
2. whether the target change belongs in `src/*`
3. whether the change can be done with a minimal patch
4. whether fallback behavior must remain intact

## Import policy

- Source imports must resolve through `src/*` paths only.
- Never add imports that reference `dist/*`.
- Correct pattern:
  - `import PRIMARY_DRUG_DATABASE from "./data/drugDatabase.json";`

## Build policy

After changing source code or source data:
1. run build
2. verify build succeeds
3. only then reason about runtime behavior

Expected workflow:
1. edit `src/*`
2. run build
3. run runtime from `dist/*`

## Validation policy

If a data change does not appear in runtime:
1. check whether `src/data/drugDatabase.json` was edited
2. check whether build was run
3. check whether `dist/*` was regenerated
4. check import paths in `src/*`
5. do not patch `dist/*`

## Migration policy

When migrating schema:
- migrate `src/data/drugDatabase.json`
- keep backward compatibility through adapter logic if needed
- do not introduce multiple competing primaries
- do not rewrite unrelated systems

## Safety / scope policy

- Do not redesign the whole project unless explicitly asked.
- Do not make unrelated refactors.
- Do not change file structure without necessity.
- Prefer minimal, high-confidence changes.
- If a task conflicts with these rules, explain the conflict and choose the safest compliant path.

## Required response style for repository tasks

When auditing or patching this repo:
- identify exact files inspected
- identify the true source of truth
- state whether any patch is needed
- keep changes minimal
- validate honestly
- do not claim runtime/e2e success unless actually verified