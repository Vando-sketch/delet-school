# Extraction & Vision PDF Pipeline Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate $O(N)$ child process spawns in PDF extraction, accelerate Vision page rendering with bounded concurrency, and eliminate redundant Hunspell dictionary memory allocations.

**Architecture:** Single-pass Poppler `pdftotext` stdout parsing with trailing `\f` handling, sliding window concurrency queue for Vision rendering, and regex line parsing with multi-path dictionary caching.

**Tech Stack:** Node.js, TypeScript, Vitest, Poppler utilities (`pdftotext`).

## Global Constraints

- Preserve `ExtractDeps` dependency injection in `src/extract/index.ts`.
- Ensure 100% flag parity between single-pass and fallback `pdftotext` invocations.
- Ensure strict page order preservation in `visionPages`.
- All tests must pass: `npm run typecheck`, `npm run lint`, `npm test`.

---

### Task 1: Single-Pass Poppler Extraction & Fallback (`src/extract/pdfText.ts`)

**Files:**
- Modify: [src/extract/pdfText.ts](file:///Users/elias/Programms/delet-school/src/extract/pdfText.ts)
- Modify: [src/extract/index.ts](file:///Users/elias/Programms/delet-school/src/extract/index.ts)
- Modify: [test/extract/pdfText.test.ts](file:///Users/elias/Programms/delet-school/test/extract/pdfText.test.ts)

**Interfaces:**
- Consumes: `ExecFileFn` from `src/lib/execFile.ts`
- Produces: `getAllPagesText(pdfPath: string, pageCount: number, execFile?: ExecFileFn): Promise<string[]>`

- [ ] **Step 1: Write failing tests for `getAllPagesText`**

Edit `test/extract/pdfText.test.ts` to add tests for single-pass form-feed extraction, trailing `\f` stripping, and fallback handling:

```ts
import { describe, it, expect, vi } from 'vitest';
import { getAllPagesText } from '../../src/extract/pdfText.js';

describe('getAllPagesText', () => {
  it('splits stdout by form feed \\f and strips trailing \\f correctly', async () => {
    const mockExecFile = vi.fn().mockResolvedValue({
      stdout: 'Page 1 Content\fPage 2 Content\fPage 3 Content\f',
      stderr: '',
    });
    const pages = await getAllPagesText('test.pdf', 3, mockExecFile as any);
    expect(pages).toEqual(['Page 1 Content', 'Page 2 Content', 'Page 3 Content']);
    expect(mockExecFile).toHaveBeenCalledWith('pdftotext', ['test.pdf', '-']);
  });

  it('falls back to per-page getPageText when page count mismatches', async () => {
    const mockExecFile = vi
      .fn()
      .mockResolvedValueOnce({
        stdout: 'Single Page Content\f',
        stderr: '',
      })
      .mockResolvedValueOnce({ stdout: 'Page 1', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'Page 2', stderr: '' });

    const pages = await getAllPagesText('test.pdf', 2, mockExecFile as any);
    expect(pages).toEqual(['Page 1', 'Page 2']);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/extract/pdfText.test.ts`
Expected: FAIL ("getAllPagesText is not defined")

- [ ] **Step 3: Implement `getAllPagesText` and update `src/extract/pdfText.ts` & `src/extract/index.ts`**

In `src/extract/pdfText.ts`, export `getAllPagesText`:

```ts
export async function getAllPagesText(
  pdfPath: string,
  pageCount: number,
  execFile: ExecFileFn = defaultExecFile,
): Promise<string[]> {
  try {
    const { stdout } = await execFile(config.poppler.pdftotextBin, [pdfPath, '-']);
    const rawPages = stdout.split('\f');
    // Poppler appends a trailing \f after the last page. Pop empty trailing page if rawPages.length === pageCount + 1
    if (rawPages.length === pageCount + 1 && (rawPages[pageCount] ?? '').trim() === '') {
      rawPages.pop();
    }
    if (rawPages.length === pageCount) {
      return rawPages;
    }
  } catch (err) {
    logger.warn({ err, pdfPath }, 'Single-pass pdftotext failed; falling back to per-page extraction');
  }

  // Fallback to page-by-page getPageText
  const pageNumbers = Array.from({ length: pageCount }, (_, i) => i + 1);
  return Promise.all(pageNumbers.map((page) => getPageText(pdfPath, page, execFile)));
}
```

In `src/extract/index.ts`, update `ExtractDeps` and `extractFile` to use `deps.getAllPagesText ?? getAllPagesText`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/extract/pdfText.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/extract/pdfText.ts src/extract/index.ts test/extract/pdfText.test.ts
git commit -m "refactor(extract): implement single-pass getAllPagesText with trailing form-feed handling"
```

---

### Task 2: Hunspell Header Skipping, Regex Parsing & Multi-Path Cache (`src/extract/dictionary.ts`)

**Files:**
- Modify: [src/extract/dictionary.ts](file:///Users/elias/Programms/delet-school/src/extract/dictionary.ts)
- Modify: [test/extract/dictionary.test.ts](file:///Users/elias/Programms/delet-school/test/extract/dictionary.test.ts)

**Interfaces:**
- Consumes: `LoadWordSetDeps` from `src/extract/dictionary.ts`
- Produces: `loadWordSet(deps?: LoadWordSetDeps): Set<string>`

- [ ] **Step 1: Write failing tests for header skipping and multi-path caching**

Edit `test/extract/dictionary.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { loadWordSet, clearWordSetCache } from '../../src/extract/dictionary.js';

describe('loadWordSet', () => {
  beforeEach(() => {
    clearWordSetCache();
  });

  it('skips Hunspell header count line and parses words via regex', () => {
    const mockDic = '318520\nApfel/N\nHaus/M\n12345\n';
    const readFileSync = vi.fn().mockReturnValue(mockDic);
    const set = loadWordSet({ readFileSync, dicPaths: ['/tmp/test.dic'] });

    expect(set.has('318520')).toBe(false);
    expect(set.has('apfel')).toBe(true);
    expect(set.has('haus')).toBe(true);
  });

  it('caches word set by dictionary path key', () => {
    const readFileSync = vi.fn().mockReturnValue('1\nApfel\n');
    const set1 = loadWordSet({ readFileSync, dicPaths: ['/tmp/a.dic'] });
    const set2 = loadWordSet({ readFileSync, dicPaths: ['/tmp/a.dic'] });

    expect(set1).toBe(set2);
    expect(readFileSync).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/extract/dictionary.test.ts`
Expected: FAIL ("clearWordSetCache is not defined" or header line failing assertion)

- [ ] **Step 3: Implement header skipping, regex scanning, and multi-path cache**

Update `src/extract/dictionary.ts`:

```ts
const cachedWordSets = new Map<string, Set<string>>();

export function clearWordSetCache(): void {
  cachedWordSets.clear();
}

export function loadWordSet(deps: LoadWordSetDeps = {}): Set<string> {
  const read = deps.readFileSync ?? ((path: string) => readFileSync(path, 'utf-8'));
  const dicPaths = deps.dicPaths ?? [config.dictionary.deDicPath, config.dictionary.enDicPath];
  const cacheKey = dicPaths.slice().sort().join(':');

  const existing = cachedWordSets.get(cacheKey);
  if (existing) {
    return existing;
  }

  const words = new Set<string>(DOMAIN_WHITELIST);
  const WORD_PATTERN = /^([^\/\s\r\n]+)/gm;

  for (const dicPath of dicPaths) {
    const contents = read(dicPath);
    const firstNewlineIndex = contents.indexOf('\n');
    const body = firstNewlineIndex !== -1 ? contents.slice(firstNewlineIndex + 1) : contents;

    let match: RegExpExecArray | null;
    while ((match = WORD_PATTERN.exec(body)) !== null) {
      const rawWord = match[1]?.trim().toLowerCase();
      if (rawWord && !/^\d+$/.test(rawWord)) {
        words.add(rawWord);
      }
    }
  }

  cachedWordSets.set(cacheKey, words);
  return words;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/extract/dictionary.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/extract/dictionary.ts test/extract/dictionary.test.ts
git commit -m "refactor(extract): optimize dictionary parsing with header skipping, regex scanning, and path caching"
```

---

### Task 3: Bounded Parallel Vision Page Rendering Queue (`src/extract/index.ts`)

**Files:**
- Modify: [src/extract/index.ts](file:///Users/elias/Programms/delet-school/src/extract/index.ts)
- Modify: [test/extract/index.test.ts](file:///Users/elias/Programms/delet-school/test/extract/index.test.ts)

**Interfaces:**
- Consumes: `renderPageToPng` from `src/extract/renderPage.ts`
- Produces: `extractFile(filePath, workDir, deps): Promise<ExtractionResult>` with bounded parallel vision page rendering

- [ ] **Step 1: Write failing tests for bounded parallel vision rendering**

Edit `test/extract/index.test.ts` to test vision pages concurrent rendering and order preservation:

```ts
it('renders vision pages concurrently while preserving page order', async () => {
  const renderedPages: number[] = [];
  const mockRenderPage = vi.fn().mockImplementation(async (_pdf, pageNum) => {
    renderedPages.push(pageNum);
    return `/tmp/vision-${pageNum}.png`;
  });

  const result = await extractFile('/tmp/test.pdf', '/tmp/work', {
    getPdfPageCount: async () => 3,
    getPageText: async () => '',
    getPagesWithContentImages: async () => new Set([1, 2, 3]),
    convertToMarkdown: async () => 'md',
    renderPageToPng: mockRenderPage as any,
  });

  expect(result.visionPages).toEqual([
    { pageNumber: 1, imagePath: '/tmp/vision-1.png' },
    { pageNumber: 2, imagePath: '/tmp/vision-2.png' },
    { pageNumber: 3, imagePath: '/tmp/vision-3.png' },
  ]);
});
```

- [ ] **Step 2: Run test to verify behavior**

Run: `npx vitest run test/extract/index.test.ts`

- [ ] **Step 3: Implement sliding window concurrency queue for Vision rendering**

In `src/extract/index.ts`:

```ts
import os from 'node:os';

async function mapConcurrent<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex++;
      const item = items[currentIndex];
      if (item !== undefined) {
        results[currentIndex] = await fn(item, currentIndex);
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}
```

In `extractFile`:
```ts
const envConcurrency = Number(process.env.MAX_CONCURRENT_PAGE_RENDERS);
const concurrency = !isNaN(envConcurrency) && envConcurrency > 0
  ? envConcurrency
  : Math.min(4, Math.max(1, os.cpus().length));

const visionPages = await mapConcurrent(visionPageNumbers, concurrency, async (pageNumber) => {
  const imagePath = await renderPage(workingPdfPath, pageNumber, path.join(workDir, 'vision-pages'));
  return { pageNumber, imagePath };
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/extract/index.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/extract/index.ts test/extract/index.test.ts
git commit -m "refactor(extract): implement sliding window concurrency queue for vision page rendering"
```

---

### Task 4: Full Suite & Performance Verification

**Files:**
- Run: Full test suite, typecheck, and linting across the workspace.

- [ ] **Step 1: Run typecheck**
Run: `npm run typecheck`

- [ ] **Step 2: Run lint**
Run: `npm run lint`

- [ ] **Step 3: Run full Vitest suite**
Run: `npm test`

- [ ] **Step 4: Commit and open PR**
```bash
git push -u origin refactor/extraction-pipeline-performance
gh pr create --title "refactor(extract): single-pass extraction, vision concurrency & dictionary caching" --body "Optimizes PDF extraction pipeline by eliminating O(N) child processes, parallelizing vision page rendering, and caching Hunspell dictionary loading."
```
