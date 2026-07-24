# Task 1 Report: Single-Pass Poppler Extraction & Fallback

**Status**: COMPLETE
**Commits**: `95e7aae..HEAD`

## Deliverables
- `src/extract/pdfText.ts`: Exported `getAllPagesText(pdfPath, pageCount, execFile, getPageTextFn)` with single-pass `pdftotext`, trailing `\f` stripping, length checks, and fallback to `getPageTextFn`.
- `src/extract/index.ts`: Updated `ExtractDeps` interface and `extractFile` to use `getAllPagesText`.
- `test/extract/pdfText.test.ts`: Added unit tests verifying form-feed splitting, trailing `\f` popping, and page count mismatch fallback.

## Verification Output
All 20 tests in `test/extract/pdfText.test.ts` and `test/extract/index.test.ts` passed cleanly.
