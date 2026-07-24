# Extraction & Vision PDF Pipeline Performance Design

**Date**: 2026-07-24  
**Status**: Approved  
**Topic**: Optimizing PDF text extraction, Vision page rendering, and dictionary loading performance in `delet-school`.

---

## 1. Context & Motivation

The extraction pipeline (`src/extract/`) processes incoming PDF documents, Word `.docx` files, and plain text notes. For PDFs, the pipeline performs:
1. Page count determination (`pdfinfo`).
2. Per-page text extraction (`pdftotext`).
3. Quality check & dictionary validation (`isQualityText`).
4. OCR fallback via Tesseract (`ocrPdf`) if text quality is poor or content images are present.
5. Markdown conversion (`toMarkdown`).
6. Vision page rendering (`renderPageToPng`) for pages with content images or low text quality.

### Key Bottlenecks Identified:
- **$O(N)$ Child Process Overhead**: `getPageText` executes `pdftotext -f <page> -l <page>` once per page. A 30-page PDF results in 30 separate `pdftotext` child process spawns.
- **Sequential Page Rendering**: `visionPages` rendering runs sequentially in a `for` loop, causing multi-page OCR/vision rendering to take up to 10x longer than necessary.
- **Hunspell Memory Allocation**: `loadWordSet()` calls `contents.split('\n')` and `line.split('/')` on large `.dic` files, generating 100,000+ temporary string and array objects per load.

---

## 2. Architecture & Detailed Design

### Component 1: Single-Pass Poppler Extraction (`src/extract/pdfText.ts`)

- **New Function**:
  ```ts
  export async function getAllPagesText(
    pdfPath: string,
    pageCount: number,
    execFile: ExecFileFn = defaultExecFile,
  ): Promise<string[]>
  ```
- **Execution Flow**:
  1. Spawns `pdftotext <pdfPath> -` **once** for the entire PDF document.
  2. Poppler separates page text in standard stdout using form-feed characters (`\f` / `\x0c`).
  3. Splits stdout by `/\f/g` to obtain a string array corresponding to each page.
  4. If the resulting array length matches `pageCount`, returns the array directly.
  5. **Fallback Safety**: If form-feed count does not match `pageCount` or `pdftotext` single-pass fails, gracefully falls back to `Promise.all(pageNumbers.map(p => getPageText(pdfPath, p)))`.
- **`ExtractDeps` Injection**:
  Export `getAllPagesText` and add `getAllPagesText?: typeof getAllPagesText` to `ExtractDeps` in `src/extract/index.ts`.

### Component 2: Bounded Parallel Vision Page Rendering (`src/extract/index.ts`)

- **Concurrency Bound**: `MAX_CONCURRENT_PAGE_RENDERS = 4`.
- **Implementation**:
  Replace sequential `for (const pageNumber of visionPageNumbers)` loop with a bounded parallel helper (chunking `visionPageNumbers` into batches of up to 4 pages executed via `Promise.all`).
- **Result Ordering**: Maintains exact page index order in the returned `visionPages` array.

### Component 3: Optimized Hunspell Parsing & Caching (`src/extract/dictionary.ts`)

- **Module-Level Caching**:
  Maintain a module-scoped `const cachedWordSets = new Map<string, Set<string>>()`.
  When `loadWordSet(deps)` is called with default parameters, return the cached `Set<string>` directly.
- **Regex Line Parsing**:
  Replace `.split('\n')` and `.split('/')` with a regex matching loop:
  ```ts
  const WORD_PATTERN = /^([^\/\s\r\n]+)/gm;
  ```
  Iterate matches via `WORD_PATTERN.exec(contents)` to populate the word set without intermediate line arrays.

---

## 3. Testing & Verification Plan

### Automated Tests
1. **Unit Tests for `getAllPagesText`**:
   - Test single-pass form-feed splitting with mock stdout.
   - Test fallback to `getPageText` when page count mismatches.
2. **Unit Tests for Bounded Vision Rendering**:
   - Verify `extractFile` handles multiple vision pages concurrently and preserves page order.
3. **Unit Tests for Dictionary Caching & Parsing**:
   - Verify `loadWordSet` returns identical cached set on subsequent calls.
   - Verify regex parsing matches expected Hunspell word entries.
4. **Full Test Suite & Typecheck**:
   - Run `npm run typecheck`, `npm run lint`, and `npm test` (Vitest).

---

## 4. Git Branch & Commit Strategy

Following `AGENTS.md` and `CLAUDE.md`:
- Task classification: `refactor` / `feat`.
- Branch name: `refactor/extraction-pipeline-performance`.
