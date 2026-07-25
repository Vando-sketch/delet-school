# Task 8: Extraction orchestrator — Report

## What I implemented

Created `src/extract/index.ts`, exporting:

- `ExtractDeps` interface — optional injectable overrides for `getPdfPageCount`, `getPageText`, `isQualityText`, `ocrPdf`, `convertToMarkdown`, `renderPageToPng`, each typed via `typeof <realImport>` and defaulting to the real implementation.
- `extractFile(filePath: string, workDir: string, deps: ExtractDeps = {}): Promise<ExtractionResult>` implementing the per-page tiered extraction strategy from the plan:
  1. `.txt`/`.md` → read raw file content as markdown, pass through untouched (`visionPages: []`, `ranOcr: false`, `archivalPdfPath: filePath`).
  2. Any other non-`.pdf` extension → throws `Error` matching `/unsupported file type/`.
  3. `.pdf` → get page count, pull per-page text for every page from the *original* PDF, run each through `isQualityText`.
     - If every page passes: skip OCR, run `convertToMarkdown` on the original file, no vision fallback, `archivalPdfPath: filePath`.
     - If any page fails: run `ocrPdf(filePath, workDir/ocr.pdf)`, re-extract per-page text from the OCR'd PDF, re-check quality per page. Any page still failing after OCR gets rendered to PNG via `renderPageToPng(ocrPdfPath, pageNumber, workDir/vision-pages)` and added to `visionPages`. `convertToMarkdown` runs against the OCR'd PDF. `ranOcr: true`, `archivalPdfPath: ocrPdfPath`.

Implementation matches the brief's exact code verbatim (Step 3).

## What I tested and results

Wrote `test/extract/index.test.ts` verbatim from the brief's Step 1 — 5 cases:
1. `.txt`/`.md` passthrough, no OCR/vision.
2. Unsupported file type (`.jpg`) rejected with matching error message.
3. All-pages-good-text PDF → MarkItDown only, OCR/vision stubs throw if invoked (they weren't).
4. Needs-OCR-then-clean PDF → asserts `ocrPdf` called with `(filePath, workDir/ocr.pdf)`, re-checks OCR'd text passes quality gate, skips vision (stub throws if invoked), `ranOcr: true`, `archivalPdfPath` = OCR path.
5. OCR-then-still-garbled → `renderPageToPng` stub asserts it's called with the **OCR'd path** (not the original `filePath`) and correct page number; `visionPages` populated; `ranOcr: true`; `archivalPdfPath` = OCR path.

## TDD Evidence

### RED

```
$ npm test -- test/extract/index.test.ts
...
FAIL  test/extract/index.test.ts [ test/extract/index.test.ts ]
Error: Failed to load url ../../src/extract/index.js (resolved id: ../../src/extract/index.js) in
/Users/elias/Programms/delet-school/test/extract/index.test.ts. Does the file exist?
Test Files  1 failed (1)
     Tests  no tests
```

### GREEN

```
$ npm test -- test/extract/index.test.ts
...
✓ test/extract/index.test.ts (5 tests) 6ms
Test Files  1 passed (1)
     Tests  5 passed (5)
```

### Full suite (post-implementation)

```
$ npm test
...
Test Files  11 passed (11)
     Tests  44 passed (44)
```

No regressions vs. the pre-existing 39 tests from Tasks 1–7.

## Files changed

- `src/extract/index.ts` (new)
- `test/extract/index.test.ts` (new)

Commit: `cf72e97` — "feat: add per-page tiered PDF extraction orchestrator"

## Self-review findings

- `ExtractDeps` optional param with function-typed fields defaulting to real imports — confirmed matches brief exactly.
- All 5 tests genuinely exercise their target branch, in particular test 5 explicitly asserts `renderPageToPng` receives the **OCR'd path**, not the original file path, via an `expect()` inside the stub.
- `ranOcr` / `archivalPdfPath` verified correct in all three PDF branches (no-OCR-needed, OCR-ran-then-clean, OCR-ran-then-still-garbled) plus the text-passthrough branch.
- Ran `npm run typecheck` and `npm run lint`. Lint is clean. Typecheck reports pre-existing errors in `src/claude/processFile.ts`, `src/worker/index.ts`, `src/nextcloud/writeResult.ts`, `test/nextcloudWriter.test.ts`, `test/processFile.test.ts` (missing `DownloadedFile` export, `TaskSolution.title`, `ProcessedFileResult.summaryMarkdown`, argument-count mismatches). Verified via `git stash` that these errors exist identically on the branch **before** this task's changes — they belong to other in-flight/future tasks (worker wiring, Claude processFile, Nextcloud writer) and are untouched by this commit. `src/extract/index.ts` itself introduces no new typecheck errors.

## Issues or concerns

None. Implementation is a verbatim match of the brief's specified code and tests; all behavior verified.
