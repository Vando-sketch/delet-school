# Extraction & Vision PDF Pipeline Performance Design

**Date**: 2026-07-24  
**Status**: Approved (Incorporated Review Feedback)  
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

## 2. Architecture & Detailed Design (Refined based on Code Review)

### Component 1: Single-Pass Poppler Extraction (`src/extract/pdfText.ts`)

- **New Function**:
  ```ts
  export async function getAllPagesText(
    pdfPath: string,
    pageCount: number,
    execFile: ExecFileFn = defaultExecFile,
  ): Promise<string[]>
  ```
- **Execution & Trailing Form-Feed (`\f`) Protocol**:
  1. Spawns `pdftotext <pdfPath> -` **once** for the entire PDF document.
  2. Ensures **100% Flag Parity** with `getPageText` (passing `[pdfPath, '-']` to `pdftotextBin`).
  3. **Trailing `\f` Handling**: Poppler appends `\f` after every page, including the last page. `stdout.split(/\f/)` on $N$ pages produces $N+1$ items where item $N+1$ is empty/whitespace.
     - Before length validation, inspect `rawPages`: if `rawPages.length === pageCount + 1` and `rawPages[pageCount].trim() === ''`, pop the trailing empty string.
  4. **Length Verification**:
     - If `pages.length === pageCount`, return `pages`.
  5. **Fallback Safety**: If `pages.length !== pageCount` or `pdftotext` single-pass fails, fall back to `Promise.all(pageNumbers.map(p => getPageText(pdfPath, p)))`.
- **`ExtractDeps` Injection**:
  Export `getAllPagesText` and add `getAllPagesText?: typeof getAllPagesText` to `ExtractDeps` in `src/extract/index.ts`.

### Component 2: Bounded Parallel Vision Page Rendering (`src/extract/index.ts`)

- **Configurable Concurrency**:
  - `MAX_CONCURRENT_PAGE_RENDERS` defaults to `Math.min(4, Math.max(1, os.cpus().length))`, configurable via `process.env.MAX_CONCURRENT_PAGE_RENDERS`.
- **Sliding Window Concurrency Queue**:
  - Implement a lightweight async pool (semaphore queue) rather than fixed batches. As soon as one page rendering promise resolves, the next pending page immediately starts without waiting for slower peer pages in a batch.
- **Result Ordering**: Preserves exact 1-to-1 page index order in the returned `visionPages` array.

### Component 3: Optimized Hunspell Parsing & Caching (`src/extract/dictionary.ts`)

- **Cache-Key for `loadWordSet`**:
  - Maintain a module-scoped map `cachedWordSets = new Map<string, Set<string>>()`.
  - Cache key is generated from sorted dictionary file paths (`dicPaths.join(':')`). When `loadWordSet` is called with identical paths, the cached `Set<string>` is returned immediately.
- **Header Line & Regex Parsing**:
  - Hunspell `.dic` files start with an entry count line (e.g. `318520`).
  - Strip the first line before scanning words:
    ```ts
    const firstNewlineIndex = contents.indexOf('\n');
    const body = firstNewlineIndex !== -1 ? contents.slice(firstNewlineIndex + 1) : contents;
    ```
  - Parse words using regex line scanning without allocating line arrays:
    ```ts
    const WORD_PATTERN = /^([^\/\s\r\n]+)/gm;
    ```
  - Extract words directly into `words.add(word.toLowerCase())`.

---

## 3. Testing & Verification Plan

### Automated & Benchmark Tests
1. **Trailing `\f` Unit Test with Real `pdftotext` Output**:
   - Test single-pass form-feed splitting with real `pdftotext` stdout output (including trailing `\f`).
   - Verify fast path is taken without falling back to per-page extraction.
2. **Flag Parity Verification**:
   - Verify stdout from `getAllPagesText` matches page-by-page `getPageText` output character-for-character.
3. **Dictionary Header & Multi-Path Cache Tests**:
   - Verify dictionary header count (e.g. `318520`) is excluded from the word Set.
   - Test multiple distinct dictionary path keys in `loadWordSet`.
4. **Performance Benchmark Test**:
   - Benchmark multi-page PDF processing before and after refactoring, verifying child process calls drop from $N$ to $1$.
5. **Full Test Suite & Linting**:
   - Run `npm run typecheck`, `npm run lint`, and `npm test` (Vitest).

---

## 4. Git Branch & Commit Strategy

Following `AGENTS.md` and `CLAUDE.md`:
- Task classification: `refactor` / `feat`.
- Branch name: `refactor/extraction-pipeline-performance`.
