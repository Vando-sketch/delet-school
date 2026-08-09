# PDF-Solve Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the current "find open tasks, write a flat markdown summary" worker into a pipeline that solves dropped school PDFs (text-layer, scanned, or handwritten), classifies the subject, and files a styled solution PDF into the correct Nextcloud subject folder — automating the user's old `schule-loesen` skill.

**Architecture:** A new per-page extraction stage (MarkItDown for text, `ocrmypdf`/Tesseract for scans, Claude vision as a last resort) feeds a rewritten Claude solve step (Sonnet, structured output constrained to a fixed subject enum). Its output is rendered to Markdown and then to a styled PDF via `pandoc`+`weasyprint`, written into a per-subject Nextcloud folder tree, with the source archived (OCR'd version when OCR ran).

**Tech Stack:** Node 20/TypeScript (existing), `@anthropic-ai/claude-agent-sdk`, BullMQ/Redis (unchanged), Python 3 venv (`markitdown`, `weasyprint`), `poppler-utils`, `ocrmypdf`, `tesseract-ocr`, `pandoc`. Docker base image switches from `node:20-alpine` to `node:20-slim` (Debian) — see Task 15 for why.

## Global Constraints

- Spec source of truth: `docs/superpowers/specs/2026-07-23-pdf-solve-pipeline-design.md`.
- `npm run typecheck` / `npm run lint` / `npm test` must all pass before opening a PR (repo `CLAUDE.md`).
- Every task follows TDD: write the failing test, watch it fail, implement, watch it pass, commit.
- New subprocess-calling modules use dependency-injected `execFile` (same pattern as the existing `NextcloudWriterDeps.execFile` in `src/nextcloud/writeResult.ts`) so tests never spawn real binaries.
- Fixed Fach enum (`src/fach.ts`) is closed — no task may add app-level "dynamic folder creation" logic; unclassifiable subjects route to `_Unsortiert` (user decision, see spec).
- No comments explaining *what* code does — only non-obvious *why* (matches existing codebase style).

---

## File Structure

```
src/
  fach.ts                    NEW  fixed Fach enum + folder subpath map (shared by claude/, nextcloud/)
  lib/
    execFile.ts               NEW  shared ExecFileFn type + default impl (DRY: replaces the local
                                    copy in nextcloud/writeResult.ts, reused by extract/*, pdf/*)
  types.ts                   MODIFIED  new shared types (TaskSolution, ProcessedFileResult,
                                    VisionPage, ExtractionResult, FileProcessor, NextcloudWriter)
  config/index.ts            MODIFIED  new env vars (STUDENT_*, PANDOC_*, MARKITDOWN_BIN, OCR_*,
                                    PDF*_BIN, ANTHROPIC_MODEL default, INGEST_WATCH_DIR default)
  extract/
    pdfText.ts                NEW  pdfinfo/pdftotext wrappers + isQualityText() gate
    ocr.ts                     NEW  ocrmypdf wrapper
    markitdown.ts               NEW  MarkItDown CLI wrapper
    renderPage.ts                NEW  pdftoppm wrapper (page -> PNG for vision fallback)
    index.ts                      NEW  orchestrator: extractFile() ties the above together
  pdf/
    escape.ts                  NEW  escapeForPandoc() - neutralizes LLM text before markdown embed
    buildMarkdown.ts             NEW  ProcessedFileResult -> pandoc-ready Markdown
    renderPdf.ts                   NEW  pandoc+weasyprint invocation
  claude/processFile.ts      MODIFIED  new prompt/schema, Sonnet default, vision image support,
                                    consumes ExtractionResult instead of DownloadedFile
  nextcloud/writeResult.ts   MODIFIED  subject-folder + Materialblatt routing, date-suffixed names
  worker/index.ts            MODIFIED  wires extraction -> solve -> (pdf gen | material copy) ->
                                    write -> archive (OCR'd vs raw)
docker/
  vorlage/
    template.html              NEW  pandoc HTML template (Style E)
    style.css                    NEW  stylesheet (Style E)
  Dockerfile                 MODIFIED  Debian slim base, new system/Python deps, COPY vorlage/
test/  (existing files updated in the task that changes their subject; no renames)
```

---

### Task 1: Shared `execFile` injection helper

**Files:**
- Create: `src/lib/execFile.ts`
- Modify: `src/nextcloud/writeResult.ts:1-25` (use the shared helper instead of its local copy)
- Test: `test/nextcloudWriter.test.ts` (existing tests must keep passing unchanged — this is a pure refactor)

**Interfaces:**
- Produces: `ExecFileFn` type (`(file: string, args: readonly string[]) => Promise<{ stdout: string; stderr: string }>`) and `defaultExecFile: ExecFileFn`, both exported from `src/lib/execFile.ts`. Every later task that shells out (extract/*, pdf/renderPdf.ts) imports this instead of redefining the type locally.

- [ ] **Step 1: Create the shared helper**

```ts
// src/lib/execFile.ts
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

export type ExecFileFn = (
  file: string,
  args: readonly string[],
) => Promise<{ stdout: string; stderr: string }>;

export const defaultExecFile: ExecFileFn = promisify(execFileCallback);
```

- [ ] **Step 2: Point `writeResult.ts` at the shared helper**

In `src/nextcloud/writeResult.ts`, replace:

```ts
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
```
and the local `type ExecFileFn = ...` / `const defaultExecFile: ExecFileFn = promisify(execFileCallback);` block, with:

```ts
import { defaultExecFile, type ExecFileFn } from '../lib/execFile.js';
```

Keep every other line in the file identical for this task — the rest of `writeResult.ts` changes in Task 13.

- [ ] **Step 3: Run the existing test suite to confirm the refactor is behavior-preserving**

Run: `npm test -- test/nextcloudWriter.test.ts`
Expected: all existing tests PASS unchanged (this step has no new test — it's a refactor with an existing safety net).

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/execFile.ts src/nextcloud/writeResult.ts
git commit -m "refactor: extract shared ExecFileFn helper for subprocess injection"
```

---

### Task 2: Config, Fach enum, and shared types foundation

**Files:**
- Create: `src/fach.ts`
- Modify: `src/config/index.ts` (add new env-backed config; change two defaults)
- Modify: `src/types.ts` (replace `DownloadedFile`/old `TaskSolution`/`ProcessedFileResult`/`FileProcessor`/`NextcloudWriter` with the new shapes)
- Modify: `.env.example` (document new/changed vars)
- Test: `test/config.test.ts` (new)

**Interfaces:**
- Produces (consumed by every later task):
  - `src/fach.ts`: `FACH_KEYS: readonly string[]`, `type FachKey = typeof FACH_KEYS[number]`, `FACH_SUBPATH: Record<FachKey, string>`.
  - `src/types.ts`:
    ```ts
    export interface TaskSolution { title: string; taskDescription: string; proposedSolution: string; quelle?: string; }
    export interface ProcessedFileResult { originalFileName: string; isMaterialblatt: boolean; fach: FachKey; lernfeld?: string; thema: string; tasksFound: TaskSolution[]; }
    export interface VisionPage { pageNumber: number; imagePath: string; }
    export interface ExtractionResult { markdown: string; visionPages: VisionPage[]; ranOcr: boolean; archivalPdfPath: string; }
    export interface FileProcessor { processFile(fileName: string, extraction: ExtractionResult): Promise<ProcessedFileResult>; }
    export type NextcloudWriteContent = { kind: 'pdf'; bytes: Buffer } | { kind: 'material'; sourcePath: string };
    export interface NextcloudWriter { writeResult(result: ProcessedFileResult, content: NextcloudWriteContent, datum: string): Promise<{ writtenPath: string }>; }
    ```
  - `config.student.name()` / `config.student.klasse()` (required, like `config.nextcloud.targetUser()`), `config.pandoc.{binary,templatePath,cssPath,weasyprintBinary}`, `config.markitdown.binary`, `config.ocr.{binary,languages}`, `config.poppler.{pdftotextBin,pdftoppmBin,pdfinfoBin}`, `config.anthropic.model` default changed to `'claude-sonnet-5'`, `config.ingest.watchDir` default changed to `'__INBOX__'`.

- [ ] **Step 1: Write the failing config test**

```ts
// test/config.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const REQUIRED_ENV = {
  NEXTCLOUD_DATA_DIR: '/data',
  NEXTCLOUD_TARGET_USER: 'alice',
  STUDENT_NAME: 'Jordan Rivera',
  STUDENT_KLASSE: '10A',
};

describe('config defaults', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    for (const [key, value] of Object.entries(REQUIRED_ENV)) process.env[key] = value;
    delete process.env.INGEST_WATCH_DIR;
    delete process.env.ANTHROPIC_MODEL;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('defaults INGEST_WATCH_DIR to __INBOX__', async () => {
    const { config } = await import('../src/config/index.js');
    expect(config.ingest.watchDir).toBe('__INBOX__');
  });

  it('defaults ANTHROPIC_MODEL to claude-sonnet-5', async () => {
    const { config } = await import('../src/config/index.js');
    expect(config.anthropic.model).toBe('claude-sonnet-5');
  });

  it('exposes required STUDENT_NAME / STUDENT_KLASSE', async () => {
    const { config } = await import('../src/config/index.js');
    expect(config.student.name()).toBe('Jordan Rivera');
    expect(config.student.klasse()).toBe('10A');
  });
});
```

Note: `config/index.ts`'s existing values (`redis`, `ingest.processedDirName`, etc.) are computed at *module load* time, not lazily, same as today (`optional('INGEST_WATCH_DIR', ...)` runs at the top level of the current file). Because Vitest caches ES module instances per test file, `vi.resetModules()` in `beforeEach` forces each dynamic `import('../src/config/index.js')` above to re-evaluate the module against the just-set env vars.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- test/config.test.ts`
Expected: FAIL — `config.ingest.watchDir` is `'./inbox'`, `config.anthropic.model` is `'claude-haiku-4-5-20251001'`, `config.student` is `undefined`.

- [ ] **Step 3: Create `src/fach.ts`**

```ts
// src/fach.ts
export const FACH_KEYS = [
  'BGWP',
  'Englisch',
  'Deutsch',
  'IT',
  'AEuP',
  'PuG',
  'IT-Tec',
  'Religion',
  '_Unsortiert',
] as const;

export type FachKey = (typeof FACH_KEYS)[number];

/**
 * Fixed, closed set - deliberately not dynamic. Guards against folder-naming drift
 * (typos/near-duplicate folders from LLM output). Extend by hand when a new class starts;
 * see docs/superpowers/specs/2026-07-23-pdf-solve-pipeline-design.md.
 */
export const FACH_SUBPATH: Record<FachKey, string> = {
  BGWP: 'BGWP',
  Englisch: 'Englisch',
  Deutsch: 'Deutsch',
  IT: 'FU-IT',
  AEuP: 'AEuP',
  PuG: 'PuG',
  'IT-Tec': 'IT-Tec',
  Religion: 'Religion',
  _Unsortiert: '_Unsortiert',
};
```

- [ ] **Step 4: Rewrite `src/types.ts`**

```ts
// src/types.ts
import type { FachKey } from './fach.js';

export interface TaskSolution {
  title: string;
  taskDescription: string;
  proposedSolution: string;
  quelle?: string;
}

export interface ProcessedFileResult {
  originalFileName: string;
  isMaterialblatt: boolean;
  fach: FachKey;
  lernfeld?: string;
  thema: string;
  tasksFound: TaskSolution[];
}

export interface VisionPage {
  pageNumber: number;
  imagePath: string;
}

export interface ExtractionResult {
  markdown: string;
  visionPages: VisionPage[];
  ranOcr: boolean;
  archivalPdfPath: string;
}

export interface FileProcessor {
  processFile(fileName: string, extraction: ExtractionResult): Promise<ProcessedFileResult>;
}

export type NextcloudWriteContent = { kind: 'pdf'; bytes: Buffer } | { kind: 'material'; sourcePath: string };

export interface NextcloudWriter {
  writeResult(
    result: ProcessedFileResult,
    content: NextcloudWriteContent,
    datum: string,
  ): Promise<{ writtenPath: string }>;
}
```

- [ ] **Step 5: Update `src/config/index.ts`**

Change the `ingest.watchDir` line:

```ts
    watchDir: optional('INGEST_WATCH_DIR', '__INBOX__'),
```

Change the `anthropic.model` line:

```ts
    model: optional('ANTHROPIC_MODEL', 'claude-sonnet-5'),
```

Add new top-level sections (after the existing `nextcloud` block, before the closing `};`):

```ts
  student: {
    name: (): string => required('STUDENT_NAME'),
    klasse: (): string => required('STUDENT_KLASSE'),
  },
  poppler: {
    pdftotextBin: optional('PDFTOTEXT_BIN', 'pdftotext'),
    pdftoppmBin: optional('PDFTOPPM_BIN', 'pdftoppm'),
    pdfinfoBin: optional('PDFINFO_BIN', 'pdfinfo'),
  },
  ocr: {
    binary: optional('OCRMYPDF_BIN', 'ocrmypdf'),
    languages: optional('OCR_LANGUAGES', 'deu+eng'),
  },
  markitdown: {
    binary: optional('MARKITDOWN_BIN', '/app/.venv/bin/markitdown'),
  },
  pandoc: {
    binary: optional('PANDOC_BIN', 'pandoc'),
    templatePath: optional('PANDOC_TEMPLATE_PATH', '/app/vorlage/template.html'),
    cssPath: optional('PANDOC_CSS_PATH', '/app/vorlage/style.css'),
    weasyprintBinary: optional('WEASYPRINT_BIN', '/app/.venv/bin/weasyprint'),
  },
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npm test -- test/config.test.ts`
Expected: PASS.

- [ ] **Step 7: Update `.env.example`**

Add after the `ANTHROPIC_MODEL=` line:

```
# Student metadata (used in the solved-PDF frontmatter)
STUDENT_NAME=
STUDENT_KLASSE=

# PDF extraction toolchain (installed system-wide/venv in the Docker image - see docker/Dockerfile)
PDFTOTEXT_BIN=pdftotext
PDFTOPPM_BIN=pdftoppm
PDFINFO_BIN=pdfinfo
OCRMYPDF_BIN=ocrmypdf
OCR_LANGUAGES=deu+eng
MARKITDOWN_BIN=/app/.venv/bin/markitdown

# Solution-PDF generation (pandoc + weasyprint)
PANDOC_BIN=pandoc
PANDOC_TEMPLATE_PATH=/app/vorlage/template.html
PANDOC_CSS_PATH=/app/vorlage/style.css
WEASYPRINT_BIN=/app/.venv/bin/weasyprint
```

Also update the `INGEST_WATCH_DIR=` line's value from `/app/inbox` to `/app/__INBOX__` and its comment to mention the rename.

- [ ] **Step 8: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: Errors will appear here from every file that still references the old `types.ts` shapes (`DownloadedFile`, old `ProcessedFileResult.summaryMarkdown`, etc.) — that's expected; those files are fixed in their own tasks below. Confirm the *new* files (`src/fach.ts`, `src/types.ts`, `src/config/index.ts`, `test/config.test.ts`) have no errors of their own by reading the compiler output carefully; pre-existing-file errors referencing the old shapes are fine to leave for now.

- [ ] **Step 9: Commit**

```bash
git add src/fach.ts src/types.ts src/config/index.ts .env.example test/config.test.ts
git commit -m "feat: add Fach enum, student config, and extraction-pipeline types"
```

---

### Task 3: Markdown/pandoc escaping utility

**Files:**
- Create: `src/pdf/escape.ts`
- Test: `test/pdf/escape.test.ts`

**Interfaces:**
- Produces: `escapeForPandoc(text: string): string` — consumed by Task 10 (`buildMarkdown.ts`) for every LLM-authored string field.

- [ ] **Step 1: Write the failing test**

```ts
// test/pdf/escape.test.ts
import { describe, expect, it } from 'vitest';
import { escapeForPandoc } from '../../src/pdf/escape.js';

describe('escapeForPandoc', () => {
  it('leaves normal prose, bold, lists, and inline code untouched', () => {
    const text = '**Wichtig:** siehe `§ 439 BGB`.\n- Punkt eins\n- Punkt zwei';
    expect(escapeForPandoc(text)).toBe(text);
  });

  it('breaks a run of 3+ colons so it cannot be parsed as a pandoc fenced-div fence', () => {
    const result = escapeForPandoc('Text mit ::: mittendrin und :::: auch');
    expect(result).not.toMatch(/:::/);
    // The zero-width breaks are invisible when rendered, so stripping them recovers the colons.
    expect(result.replace(/​/g, '')).toBe('Text mit ::: mittendrin und :::: auch');
  });

  it('escapes raw HTML angle brackets so they cannot be parsed as a raw HTML block', () => {
    expect(escapeForPandoc('Vergleiche a < b und <script>alert(1)</script>')).toBe(
      'Vergleiche a &lt; b und &lt;script&gt;alert(1)&lt;/script&gt;',
    );
  });

  it('appends a closing backtick when the input has an odd number of backticks', () => {
    expect(escapeForPandoc('unbalanced `code')).toBe('unbalanced `code`');
  });

  it('does not touch already-balanced backticks', () => {
    expect(escapeForPandoc('balanced `code` here')).toBe('balanced `code` here');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- test/pdf/escape.test.ts`
Expected: FAIL with "Cannot find module '../../src/pdf/escape.js'".

- [ ] **Step 3: Implement**

```ts
// src/pdf/escape.ts

/**
 * Neutralizes markdown/pandoc structural syntax in LLM-authored text before it's embedded
 * into a hand-built pandoc document (fenced divs for Frage/Antwort/Quelle blocks). LLM
 * output is not trusted to be syntactically safe for whatever it's interpolated into - same
 * posture as sanitizeBaseName() in nextcloud/writeResult.ts for filenames. Ordinary markdown
 * (bold, lists, balanced inline code) is left alone; only breaks the specific sequences that
 * would corrupt the surrounding pandoc template (stray fence runs, raw HTML, unbalanced code).
 */
export function escapeForPandoc(text: string): string {
  const noRawHtml = text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const noFenceRuns = noRawHtml.replace(/:::+/g, (run) => run.split('').join('​'));
  const backtickCount = (noFenceRuns.match(/`/g) ?? []).length;
  return backtickCount % 2 === 0 ? noFenceRuns : `${noFenceRuns}\``;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- test/pdf/escape.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/pdf/escape.ts test/pdf/escape.test.ts
git commit -m "feat: add pandoc-safe escaping for LLM-authored markdown content"
```

---

### Task 4: PDF page-quality utilities

**Files:**
- Create: `src/extract/pdfText.ts`
- Test: `test/extract/pdfText.test.ts`

**Interfaces:**
- Consumes: `ExecFileFn` from `src/lib/execFile.ts` (Task 1).
- Produces: `getPdfPageCount(pdfPath: string, execFile?: ExecFileFn): Promise<number>`, `getPageText(pdfPath: string, pageNumber: number, execFile?: ExecFileFn): Promise<string>`, `isQualityText(text: string): boolean` — all consumed by Task 8 (`extract/index.ts`).

- [ ] **Step 1: Write the failing tests**

```ts
// test/extract/pdfText.test.ts
import { describe, expect, it } from 'vitest';
import { getPageText, getPdfPageCount, isQualityText } from '../../src/extract/pdfText.js';

describe('isQualityText', () => {
  it('rejects text under the minimum character threshold', () => {
    expect(isQualityText('too short')).toBe(false);
  });

  it('accepts long, mostly-alphanumeric prose', () => {
    const prose =
      'Der Käufer kann gemäß Paragraph 437 BGB zunächst Nacherfüllung verlangen, ' +
      'wenn die gelieferte Ware einen Sachmangel aufweist und die Gewährleistung greift.';
    expect(isQualityText(prose)).toBe(true);
  });

  it('rejects long OCR gibberish even though it clears the character-count threshold', () => {
    const gibberish = 'l|i1l!! O0--_x~~ '.repeat(10);
    expect(isQualityText(gibberish)).toBe(false);
  });
});

describe('getPdfPageCount', () => {
  it('parses the page count from pdfinfo output', async () => {
    const execFile = async (file: string, args: readonly string[]) => {
      expect(file).toBe('pdfinfo');
      expect(args).toEqual(['/tmp/doc.pdf']);
      return { stdout: 'Title: none\nPages:          4\nEncrypted: no\n', stderr: '' };
    };
    await expect(getPdfPageCount('/tmp/doc.pdf', execFile)).resolves.toBe(4);
  });

  it('throws a clear error when pdfinfo output has no Pages line', async () => {
    const execFile = async () => ({ stdout: 'garbage', stderr: '' });
    await expect(getPdfPageCount('/tmp/doc.pdf', execFile)).rejects.toThrow(/could not determine page count/);
  });
});

describe('getPageText', () => {
  it('scopes pdftotext to a single page via -f/-l', async () => {
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const execFile = async (file: string, args: readonly string[]) => {
      calls.push({ file, args });
      return { stdout: 'page three text', stderr: '' };
    };
    const text = await getPageText('/tmp/doc.pdf', 3, execFile);
    expect(text).toBe('page three text');
    expect(calls).toEqual([{ file: 'pdftotext', args: ['-f', '3', '-l', '3', '/tmp/doc.pdf', '-'] }]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- test/extract/pdfText.test.ts`
Expected: FAIL with "Cannot find module '../../src/extract/pdfText.js'".

- [ ] **Step 3: Implement**

```ts
// src/extract/pdfText.ts
import { config } from '../config/index.js';
import { defaultExecFile, type ExecFileFn } from '../lib/execFile.js';

const MIN_CHARS = 100;
const MIN_ALPHANUMERIC_RATIO = 0.6;
const ALPHANUMERIC_PATTERN = /[a-zA-Z0-9äöüÄÖÜß]/g;

/**
 * Cheap proxy for "is this actual language, or OCR/handwriting garbage" - raw character
 * count alone isn't enough (Tesseract garbage like "l|i1l!! O0--_x~~" easily clears 100
 * chars). Exact threshold is tunable; see docs/superpowers/specs/2026-07-23-pdf-solve-pipeline-design.md.
 */
export function isQualityText(text: string): boolean {
  const nonWhitespace = text.replace(/\s/g, '');
  if (nonWhitespace.length < MIN_CHARS) return false;
  const alphanumericCount = (nonWhitespace.match(ALPHANUMERIC_PATTERN) ?? []).length;
  return alphanumericCount / nonWhitespace.length >= MIN_ALPHANUMERIC_RATIO;
}

export async function getPdfPageCount(pdfPath: string, execFile: ExecFileFn = defaultExecFile): Promise<number> {
  const { stdout } = await execFile(config.poppler.pdfinfoBin, [pdfPath]);
  const match = stdout.match(/^Pages:\s+(\d+)/m);
  if (!match) {
    throw new Error(`extract/pdfText: could not determine page count for "${pdfPath}"`);
  }
  return Number(match[1]);
}

export async function getPageText(
  pdfPath: string,
  pageNumber: number,
  execFile: ExecFileFn = defaultExecFile,
): Promise<string> {
  const { stdout } = await execFile(config.poppler.pdftotextBin, [
    '-f',
    String(pageNumber),
    '-l',
    String(pageNumber),
    pdfPath,
    '-',
  ]);
  return stdout;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- test/extract/pdfText.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/extract/pdfText.ts test/extract/pdfText.test.ts
git commit -m "feat: add per-page PDF text extraction and OCR-quality gate"
```

---

### Task 5: OCR module

**Files:**
- Create: `src/extract/ocr.ts`
- Test: `test/extract/ocr.test.ts`

**Interfaces:**
- Consumes: `ExecFileFn` (Task 1).
- Produces: `ocrPdf(inputPath: string, outputPath: string, execFile?: ExecFileFn): Promise<void>` — consumed by Task 8.

- [ ] **Step 1: Write the failing test**

```ts
// test/extract/ocr.test.ts
import { describe, expect, it } from 'vitest';
import { ocrPdf } from '../../src/extract/ocr.js';

describe('ocrPdf', () => {
  it('invokes ocrmypdf with the expected flags and paths', async () => {
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const execFile = async (file: string, args: readonly string[]) => {
      calls.push({ file, args });
      return { stdout: '', stderr: '' };
    };

    await ocrPdf('/tmp/in.pdf', '/tmp/out.pdf', execFile);

    expect(calls).toEqual([
      {
        file: 'ocrmypdf',
        args: ['-l', 'deu+eng', '--deskew', '--rotate-pages', '--skip-text', '/tmp/in.pdf', '/tmp/out.pdf'],
      },
    ]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- test/extract/ocr.test.ts`
Expected: FAIL with "Cannot find module '../../src/extract/ocr.js'".

- [ ] **Step 3: Implement**

```ts
// src/extract/ocr.ts
import { config } from '../config/index.js';
import { defaultExecFile, type ExecFileFn } from '../lib/execFile.js';

export async function ocrPdf(
  inputPath: string,
  outputPath: string,
  execFile: ExecFileFn = defaultExecFile,
): Promise<void> {
  await execFile(config.ocr.binary, [
    '-l',
    config.ocr.languages,
    '--deskew',
    '--rotate-pages',
    '--skip-text',
    inputPath,
    outputPath,
  ]);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- test/extract/ocr.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/extract/ocr.ts test/extract/ocr.test.ts
git commit -m "feat: add ocrmypdf wrapper for scanned-PDF extraction"
```

---

### Task 6: MarkItDown module

**Files:**
- Create: `src/extract/markitdown.ts`
- Test: `test/extract/markitdown.test.ts`

**Interfaces:**
- Consumes: `ExecFileFn` (Task 1).
- Produces: `convertToMarkdown(filePath: string, execFile?: ExecFileFn): Promise<string>` — consumed by Task 8.

- [ ] **Step 1: Write the failing test**

```ts
// test/extract/markitdown.test.ts
import { describe, expect, it } from 'vitest';
import { convertToMarkdown } from '../../src/extract/markitdown.js';

describe('convertToMarkdown', () => {
  it('invokes the MarkItDown binary on the given file and returns its stdout', async () => {
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const execFile = async (file: string, args: readonly string[]) => {
      calls.push({ file, args });
      return { stdout: '# Extracted heading\n\nBody text.', stderr: '' };
    };

    const markdown = await convertToMarkdown('/tmp/doc.pdf', execFile);

    expect(markdown).toBe('# Extracted heading\n\nBody text.');
    expect(calls).toEqual([{ file: '/app/.venv/bin/markitdown', args: ['/tmp/doc.pdf'] }]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- test/extract/markitdown.test.ts`
Expected: FAIL with "Cannot find module '../../src/extract/markitdown.js'".

- [ ] **Step 3: Implement**

```ts
// src/extract/markitdown.ts
import { config } from '../config/index.js';
import { defaultExecFile, type ExecFileFn } from '../lib/execFile.js';

export async function convertToMarkdown(filePath: string, execFile: ExecFileFn = defaultExecFile): Promise<string> {
  const { stdout } = await execFile(config.markitdown.binary, [filePath]);
  return stdout;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- test/extract/markitdown.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/extract/markitdown.ts test/extract/markitdown.test.ts
git commit -m "feat: add MarkItDown CLI wrapper for structured text extraction"
```

---

### Task 7: Vision page rendering module

**Files:**
- Create: `src/extract/renderPage.ts`
- Test: `test/extract/renderPage.test.ts`

**Interfaces:**
- Consumes: `ExecFileFn` (Task 1).
- Produces: `renderPageToPng(pdfPath: string, pageNumber: number, outputDir: string, deps?: { execFile?: ExecFileFn; readdir?: (dir: string) => Promise<string[]>; mkdir?: (dir: string) => Promise<unknown> }): Promise<string>` — consumed by Task 8.

- [ ] **Step 1: Write the failing test**

```ts
// test/extract/renderPage.test.ts
import { describe, expect, it } from 'vitest';
import { renderPageToPng } from '../../src/extract/renderPage.js';

describe('renderPageToPng', () => {
  it('invokes pdftoppm scoped to one page and returns the produced PNG path', async () => {
    const execCalls: Array<{ file: string; args: readonly string[] }> = [];
    const execFile = async (file: string, args: readonly string[]) => {
      execCalls.push({ file, args });
      return { stdout: '', stderr: '' };
    };
    const mkdir = async () => undefined;
    const readdir = async () => ['page-2-1.png', 'unrelated.txt'];

    const result = await renderPageToPng('/tmp/doc.pdf', 2, '/tmp/vision-pages', { execFile, mkdir, readdir });

    expect(result).toBe('/tmp/vision-pages/page-2-1.png');
    expect(execCalls).toEqual([
      {
        file: 'pdftoppm',
        args: ['-png', '-r', '150', '-f', '2', '-l', '2', '/tmp/doc.pdf', '/tmp/vision-pages/page-2'],
      },
    ]);
  });

  it('throws a clear error when pdftoppm produces no matching file', async () => {
    const execFile = async () => ({ stdout: '', stderr: '' });
    const mkdir = async () => undefined;
    const readdir = async () => ['unrelated.txt'];

    await expect(
      renderPageToPng('/tmp/doc.pdf', 5, '/tmp/vision-pages', { execFile, mkdir, readdir }),
    ).rejects.toThrow(/did not produce an image for page 5/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- test/extract/renderPage.test.ts`
Expected: FAIL with "Cannot find module '../../src/extract/renderPage.js'".

- [ ] **Step 3: Implement**

```ts
// src/extract/renderPage.ts
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { config } from '../config/index.js';
import { defaultExecFile, type ExecFileFn } from '../lib/execFile.js';

export interface RenderPageDeps {
  execFile?: ExecFileFn;
  mkdir?: (dir: string) => Promise<unknown>;
  readdir?: (dir: string) => Promise<string[]>;
}

export async function renderPageToPng(
  pdfPath: string,
  pageNumber: number,
  outputDir: string,
  deps: RenderPageDeps = {},
): Promise<string> {
  const execFile = deps.execFile ?? defaultExecFile;
  const mkdir = deps.mkdir ?? ((dir: string) => fs.mkdir(dir, { recursive: true }));
  const readdir = deps.readdir ?? ((dir: string) => fs.readdir(dir));

  await mkdir(outputDir);
  const prefix = path.join(outputDir, `page-${pageNumber}`);
  await execFile(config.poppler.pdftoppmBin, [
    '-png',
    '-r',
    '150',
    '-f',
    String(pageNumber),
    '-l',
    String(pageNumber),
    pdfPath,
    prefix,
  ]);

  // pdftoppm appends its own page-number suffix even for a single-page range (e.g.
  // page-2-1.png), and the exact suffix format varies by poppler version - list the dir
  // instead of guessing the filename.
  const entries = await readdir(outputDir);
  const match = entries.find((name) => name.startsWith(`page-${pageNumber}`) && name.endsWith('.png'));
  if (!match) {
    throw new Error(`extract/renderPage: pdftoppm did not produce an image for page ${pageNumber}`);
  }
  return path.join(outputDir, match);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- test/extract/renderPage.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/extract/renderPage.ts test/extract/renderPage.test.ts
git commit -m "feat: add pdftoppm wrapper for rendering vision-fallback page images"
```

---

### Task 8: Extraction orchestrator

**Files:**
- Create: `src/extract/index.ts`
- Test: `test/extract/index.test.ts`

**Interfaces:**
- Consumes: `getPdfPageCount`, `getPageText`, `isQualityText` (Task 4); `ocrPdf` (Task 5); `convertToMarkdown` (Task 6); `renderPageToPng` (Task 7); `ExtractionResult`, `VisionPage` (Task 2, `src/types.ts`).
- Produces: `extractFile(filePath: string, workDir: string, deps?: ExtractDeps): Promise<ExtractionResult>` — consumed by Task 14 (`worker/index.ts`).

- [ ] **Step 1: Write the failing tests**

```ts
// test/extract/index.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { extractFile } from '../../src/extract/index.js';

describe('extractFile', () => {
  let tmpDir: string;
  let workDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'extract-test-'));
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'extract-work-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
    await fs.rm(workDir, { recursive: true, force: true });
  });

  it('passes .txt/.md files through as-is, with no OCR/vision involved', async () => {
    const filePath = path.join(tmpDir, 'notes.md');
    await fs.writeFile(filePath, '# Notes\n\n- [ ] follow up');

    const result = await extractFile(filePath, workDir);

    expect(result).toEqual({
      markdown: '# Notes\n\n- [ ] follow up',
      visionPages: [],
      ranOcr: false,
      archivalPdfPath: filePath,
    });
  });

  it('rejects unsupported file types', async () => {
    const filePath = path.join(tmpDir, 'photo.jpg');
    await fs.writeFile(filePath, 'irrelevant');

    await expect(extractFile(filePath, workDir)).rejects.toThrow(/unsupported file type/);
  });

  it('uses MarkItDown directly (no OCR) when every page already has a good text layer', async () => {
    const filePath = path.join(tmpDir, 'typed.pdf');
    await fs.writeFile(filePath, 'irrelevant - pdfinfo/pdftotext are stubbed');

    const goodText = 'x'.repeat(150); // clears MIN_CHARS + alphanumeric ratio via the stub below
    const deps = {
      getPdfPageCount: async () => 2,
      getPageText: async () => goodText,
      isQualityText: () => true,
      ocrPdf: async () => {
        throw new Error('should not be called');
      },
      convertToMarkdown: async (path_: string) => `markdown for ${path_}`,
      renderPageToPng: async () => {
        throw new Error('should not be called');
      },
    };

    const result = await extractFile(filePath, workDir, deps);

    expect(result).toEqual({
      markdown: `markdown for ${filePath}`,
      visionPages: [],
      ranOcr: false,
      archivalPdfPath: filePath,
    });
  });

  it('OCRs the PDF when a page fails the quality gate, then re-checks the OCR output', async () => {
    const filePath = path.join(tmpDir, 'scan.pdf');
    await fs.writeFile(filePath, 'irrelevant');
    const ocrOutputPath = path.join(workDir, 'ocr.pdf');

    let ocrCalled = false;
    const deps = {
      getPdfPageCount: async () => 1,
      getPageText: async (pdfPath: string) => (pdfPath === filePath ? 'garbled scan text' : 'clean ocr text'.repeat(20)),
      isQualityText: (text: string) => text.startsWith('clean'),
      ocrPdf: async (input: string, output: string) => {
        expect(input).toBe(filePath);
        expect(output).toBe(ocrOutputPath);
        ocrCalled = true;
      },
      convertToMarkdown: async (path_: string) => `markdown for ${path_}`,
      renderPageToPng: async () => {
        throw new Error('should not be called - OCR output passed the quality gate');
      },
    };

    const result = await extractFile(filePath, workDir, deps);

    expect(ocrCalled).toBe(true);
    expect(result).toEqual({
      markdown: `markdown for ${ocrOutputPath}`,
      visionPages: [],
      ranOcr: true,
      archivalPdfPath: ocrOutputPath,
    });
  });

  it('falls back to vision for pages that still fail the quality gate after OCR', async () => {
    const filePath = path.join(tmpDir, 'handwritten.pdf');
    await fs.writeFile(filePath, 'irrelevant');
    const ocrOutputPath = path.join(workDir, 'ocr.pdf');
    const visionImagePath = path.join(workDir, 'vision-pages', 'page-1-1.png');

    const deps = {
      getPdfPageCount: async () => 1,
      getPageText: async () => 'still garbled after ocr',
      isQualityText: () => false,
      ocrPdf: async () => undefined,
      convertToMarkdown: async (path_: string) => `markdown for ${path_}`,
      renderPageToPng: async (pdfPath: string, pageNumber: number) => {
        expect(pdfPath).toBe(ocrOutputPath);
        expect(pageNumber).toBe(1);
        return visionImagePath;
      },
    };

    const result = await extractFile(filePath, workDir, deps);

    expect(result.visionPages).toEqual([{ pageNumber: 1, imagePath: visionImagePath }]);
    expect(result.ranOcr).toBe(true);
    expect(result.archivalPdfPath).toBe(ocrOutputPath);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- test/extract/index.test.ts`
Expected: FAIL with "Cannot find module '../../src/extract/index.js'".

- [ ] **Step 3: Implement**

```ts
// src/extract/index.ts
import { extname } from 'node:path';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { getPageText, getPdfPageCount, isQualityText } from './pdfText.js';
import { ocrPdf } from './ocr.js';
import { convertToMarkdown } from './markitdown.js';
import { renderPageToPng } from './renderPage.js';
import type { ExtractionResult, VisionPage } from '../types.js';

export interface ExtractDeps {
  getPdfPageCount?: typeof getPdfPageCount;
  getPageText?: typeof getPageText;
  isQualityText?: typeof isQualityText;
  ocrPdf?: typeof ocrPdf;
  convertToMarkdown?: typeof convertToMarkdown;
  renderPageToPng?: typeof renderPageToPng;
}

const TEXT_EXTENSIONS = new Set(['.txt', '.md']);

export async function extractFile(
  filePath: string,
  workDir: string,
  deps: ExtractDeps = {},
): Promise<ExtractionResult> {
  const getPageCount = deps.getPdfPageCount ?? getPdfPageCount;
  const getText = deps.getPageText ?? getPageText;
  const checkQuality = deps.isQualityText ?? isQualityText;
  const runOcr = deps.ocrPdf ?? ocrPdf;
  const toMarkdown = deps.convertToMarkdown ?? convertToMarkdown;
  const renderPage = deps.renderPageToPng ?? renderPageToPng;

  const ext = extname(filePath).toLowerCase();

  if (TEXT_EXTENSIONS.has(ext)) {
    const markdown = await fs.readFile(filePath, 'utf-8');
    return { markdown, visionPages: [], ranOcr: false, archivalPdfPath: filePath };
  }

  if (ext !== '.pdf') {
    throw new Error(`extract: unsupported file type "${ext}" for "${filePath}"`);
  }

  const pageCount = await getPageCount(filePath);
  const pageNumbers = Array.from({ length: pageCount }, (_, i) => i + 1);

  const originalTexts = await Promise.all(pageNumbers.map((page) => getText(filePath, page)));
  const needsOcr = originalTexts.some((text) => !checkQuality(text));

  let workingPdfPath = filePath;
  let ranOcr = false;
  let pageTexts = originalTexts;

  if (needsOcr) {
    const ocrOutputPath = path.join(workDir, 'ocr.pdf');
    await runOcr(filePath, ocrOutputPath);
    workingPdfPath = ocrOutputPath;
    ranOcr = true;
    pageTexts = await Promise.all(pageNumbers.map((page) => getText(ocrOutputPath, page)));
  }

  const visionPageNumbers = pageNumbers.filter((_, i) => !checkQuality(pageTexts[i] ?? ''));
  const markdown = await toMarkdown(workingPdfPath);

  const visionPages: VisionPage[] = [];
  for (const pageNumber of visionPageNumbers) {
    const imagePath = await renderPage(workingPdfPath, pageNumber, path.join(workDir, 'vision-pages'));
    visionPages.push({ pageNumber, imagePath });
  }

  return {
    markdown,
    visionPages,
    ranOcr,
    archivalPdfPath: ranOcr ? workingPdfPath : filePath,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- test/extract/index.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/extract/index.ts test/extract/index.test.ts
git commit -m "feat: add per-page tiered PDF extraction orchestrator"
```

---

### Task 9: PDF template and stylesheet (Style E)

**Files:**
- Create: `docker/vorlage/template.html`
- Create: `docker/vorlage/style.css`

**Interfaces:**
- Consumes: nothing (static assets).
- Produces: the two file paths referenced by `config.pandoc.templatePath` / `config.pandoc.cssPath` (Task 2), consumed by Task 11 (`pdf/renderPdf.ts`) and Task 15 (Dockerfile `COPY`).

This task has no automated test — it's a static visual asset, already approved via the visual-companion brainstorming session (Style E). Verification is a manual pandoc/weasyprint render, noted in the last step.

- [ ] **Step 1: Create the pandoc template**

```html
<!-- docker/vorlage/template.html -->
<!DOCTYPE html>
<html lang="$lang$">
<head>
<meta charset="utf-8">
<title>$title$</title>
</head>
<body>
<header class="doc-header">
  <div class="doc-header__fach">$fach$$if(lernfeld)$ · $lernfeld$$endif$</div>
  <div class="doc-header__title">$thema$</div>
  <div class="doc-header__meta">$name$ · $klasse$ · $datum$</div>
</header>
<main>
$body$
</main>
</body>
</html>
```

- [ ] **Step 2: Create the stylesheet (Style E: formal serif, thin colored left-rule labels)**

```css
/* docker/vorlage/style.css */
body {
  font-family: Georgia, 'Tinos', 'Liberation Serif', serif;
  color: #1a1a1a;
  margin: 2.5cm 2cm;
}

.doc-header {
  text-align: center;
  border-bottom: 2px solid #1a1a1a;
  padding-bottom: 12px;
  margin-bottom: 20px;
}

.doc-header__fach {
  font-family: 'Liberation Sans', sans-serif;
  font-size: 11px;
  letter-spacing: 1px;
  text-transform: uppercase;
  color: #555;
}

.doc-header__title {
  font-size: 21px;
  font-weight: bold;
  margin-top: 4px;
}

.doc-header__meta {
  font-family: 'Liberation Sans', sans-serif;
  font-size: 11px;
  color: #777;
  margin-top: 6px;
}

.task {
  border: 1px solid #e3e3e3;
  border-radius: 6px;
  padding: 16px 16px 16px 14px;
  margin-bottom: 14px;
  page-break-inside: avoid;
}

.task h2 {
  font-size: 15px;
  margin: 0 0 10px 0;
}

.frage,
.antwort {
  border-left: 2px solid;
  padding-left: 10px;
  margin-bottom: 12px;
}

.frage {
  border-left-color: #8892b0;
  font-style: italic;
  color: #333;
  font-size: 13px;
}

.antwort {
  border-left-color: #2f6b45;
  font-size: 13.5px;
  line-height: 1.6;
}

.frage::before,
.antwort::before {
  display: block;
  font-family: 'Liberation Sans', sans-serif;
  font-size: 9.5px;
  font-weight: 700;
  letter-spacing: 1.2px;
  text-transform: uppercase;
  margin-bottom: 3px;
}

.frage::before {
  content: 'Frage';
  color: #8892b0;
}

.antwort::before {
  content: 'Antwort';
  color: #2f6b45;
}

.quelle {
  font-family: 'Liberation Sans', sans-serif;
  font-size: 11px;
  color: #888;
  padding-left: 10px;
}
```

- [ ] **Step 3: Commit**

```bash
git add docker/vorlage/template.html docker/vorlage/style.css
git commit -m "feat: add pandoc template and Style E stylesheet for solution PDFs"
```

- [ ] **Step 4 (manual verification, run once Task 15's Docker image is built):**

```bash
docker compose run --rm worker bash -c '
cat > /tmp/sample.md <<EOF
---
lang: de
fach: "BGWP"
thema: "Kaufvertragsrecht – Lösungen"
name: "Jordan Rivera"
klasse: "10A"
datum: "2026-07-23"
---

:::: {.task}
## 1. Mangelhafte Lieferung

::: {.frage}
Ein Kunde erhält eine Ware mit Sachmangel. Welche Rechte stehen ihm nach BGB zu?
:::

::: {.antwort}
Der Käufer kann gemäß **§ 437 BGB** zunächst Nacherfüllung verlangen (§ 439 BGB).
:::

::: {.quelle}
§ 437, § 439 BGB
:::
::::
EOF
pandoc /tmp/sample.md --template /app/vorlage/template.html --css /app/vorlage/style.css \
  --pdf-engine=/app/.venv/bin/weasyprint -o /tmp/sample.pdf && ls -la /tmp/sample.pdf
'
```

Expected: `/tmp/sample.pdf` exists and is non-empty. Pull it out with `docker cp` and open it to confirm it visually matches the approved Style E mockup (serif header, colored left-rule Frage/Antwort labels, no filled badges).

---

### Task 10: Solution-markdown builder

**Files:**
- Create: `src/pdf/buildMarkdown.ts`
- Test: `test/pdf/buildMarkdown.test.ts`

**Interfaces:**
- Consumes: `ProcessedFileResult`, `TaskSolution` (Task 2, `src/types.ts`); `escapeForPandoc` (Task 3); `config.student.name()/klasse()` (Task 2).
- Produces: `buildSolutionMarkdown(result: ProcessedFileResult, datum: string): string` — consumed by Task 14 (`worker/index.ts`) as input to Task 11's `renderSolutionPdf`.

- [ ] **Step 1: Write the failing tests**

```ts
// test/pdf/buildMarkdown.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildSolutionMarkdown } from '../../src/pdf/buildMarkdown.js';
import type { ProcessedFileResult } from '../../src/types.js';

function makeResult(overrides: Partial<ProcessedFileResult> = {}): ProcessedFileResult {
  return {
    originalFileName: 'arbeitsblatt1.pdf',
    isMaterialblatt: false,
    fach: 'BGWP',
    thema: 'Kaufvertragsrecht',
    tasksFound: [
      {
        title: 'Mangelhafte Lieferung',
        taskDescription: 'Welche Rechte hat der Käufer bei einem Sachmangel?',
        proposedSolution: 'Nacherfüllung nach § 439 BGB.',
        quelle: '§ 437, § 439 BGB',
      },
    ],
    ...overrides,
  };
}

describe('buildSolutionMarkdown', () => {
  beforeEach(() => {
    process.env.STUDENT_NAME = 'Jordan Rivera';
    process.env.STUDENT_KLASSE = '10A';
  });

  afterEach(() => {
    delete process.env.STUDENT_NAME;
    delete process.env.STUDENT_KLASSE;
  });

  it('includes frontmatter with fach, thema, name, klasse, and the given datum', () => {
    const md = buildSolutionMarkdown(makeResult(), '2026-07-23');

    expect(md).toContain('fach: "BGWP"');
    expect(md).toContain('thema: "Kaufvertragsrecht – Lösungen"');
    expect(md).toContain('name: "Jordan Rivera"');
    expect(md).toContain('klasse: "10A"');
    expect(md).toContain('datum: "2026-07-23"');
  });

  it('omits the lernfeld frontmatter line when not present', () => {
    const md = buildSolutionMarkdown(makeResult(), '2026-07-23');
    expect(md).not.toContain('lernfeld:');
  });

  it('includes the lernfeld frontmatter line when present', () => {
    const md = buildSolutionMarkdown(makeResult({ lernfeld: 'LF 3' }), '2026-07-23');
    expect(md).toContain('lernfeld: "LF 3"');
  });

  it('renders one numbered task block with nested frage/antwort/quelle fenced divs', () => {
    const md = buildSolutionMarkdown(makeResult(), '2026-07-23');

    expect(md).toContain(':::: {.task}');
    expect(md).toContain('## 1. Mangelhafte Lieferung');
    expect(md).toContain('::: {.frage}');
    expect(md).toContain('Welche Rechte hat der Käufer bei einem Sachmangel?');
    expect(md).toContain('::: {.antwort}');
    expect(md).toContain('Nacherfüllung nach § 439 BGB.');
    expect(md).toContain('::: {.quelle}');
    expect(md).toContain('§ 437, § 439 BGB');
    expect(md).toContain('::::');
  });

  it('omits the quelle block for a task with no quelle', () => {
    const result = makeResult({
      tasksFound: [
        { title: 'Ohne Quelle', taskDescription: 'Frage ohne Quelle', proposedSolution: 'Antwort ohne Quelle' },
      ],
    });
    const md = buildSolutionMarkdown(result, '2026-07-23');
    expect(md).not.toContain('{.quelle}');
  });

  it('numbers multiple tasks sequentially', () => {
    const result = makeResult({
      tasksFound: [
        { title: 'Erste', taskDescription: 'F1', proposedSolution: 'A1' },
        { title: 'Zweite', taskDescription: 'F2', proposedSolution: 'A2' },
      ],
    });
    const md = buildSolutionMarkdown(result, '2026-07-23');
    expect(md).toContain('## 1. Erste');
    expect(md).toContain('## 2. Zweite');
  });

  it('escapes LLM-authored text through escapeForPandoc before embedding it', () => {
    const result = makeResult({
      tasksFound: [
        {
          title: 'Titel mit ::: Fence',
          taskDescription: 'Frage mit ::: drin',
          proposedSolution: 'Antwort mit <script>alert(1)</script>',
        },
      ],
    });
    const md = buildSolutionMarkdown(result, '2026-07-23');

    expect(md).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(md).not.toContain('<script>');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- test/pdf/buildMarkdown.test.ts`
Expected: FAIL with "Cannot find module '../../src/pdf/buildMarkdown.js'".

- [ ] **Step 3: Implement**

```ts
// src/pdf/buildMarkdown.ts
import { config } from '../config/index.js';
import { escapeForPandoc } from './escape.js';
import type { ProcessedFileResult, TaskSolution } from '../types.js';

function escapeYamlString(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function buildFrontmatter(result: ProcessedFileResult, datum: string): string {
  const lines = [
    '---',
    'lang: de',
    `fach: "${escapeYamlString(result.fach)}"`,
    result.lernfeld ? `lernfeld: "${escapeYamlString(result.lernfeld)}"` : undefined,
    `thema: "${escapeYamlString(result.thema)} – Lösungen"`,
    `name: "${escapeYamlString(config.student.name())}"`,
    `klasse: "${escapeYamlString(config.student.klasse())}"`,
    `datum: "${escapeYamlString(datum)}"`,
    '---',
  ];
  return lines.filter((line): line is string => line !== undefined).join('\n');
}

function buildTaskBlock(task: TaskSolution, index: number): string {
  const number = index + 1;
  const lines = [
    ':::: {.task}',
    `## ${number}. ${escapeForPandoc(task.title)}`,
    '',
    '::: {.frage}',
    escapeForPandoc(task.taskDescription),
    ':::',
    '',
    '::: {.antwort}',
    escapeForPandoc(task.proposedSolution),
    ':::',
  ];
  if (task.quelle) {
    lines.push('', '::: {.quelle}', escapeForPandoc(task.quelle), ':::');
  }
  lines.push('::::');
  return lines.join('\n');
}

export function buildSolutionMarkdown(result: ProcessedFileResult, datum: string): string {
  const frontmatter = buildFrontmatter(result, datum);
  const blocks = result.tasksFound.map((task, index) => buildTaskBlock(task, index));
  return `${frontmatter}\n\n${blocks.join('\n\n')}\n`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- test/pdf/buildMarkdown.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/pdf/buildMarkdown.ts test/pdf/buildMarkdown.test.ts
git commit -m "feat: build pandoc-ready solution markdown from ProcessedFileResult"
```

---

### Task 11: PDF renderer (pandoc + weasyprint)

**Files:**
- Create: `src/pdf/renderPdf.ts`
- Test: `test/pdf/renderPdf.test.ts`

**Interfaces:**
- Consumes: `ExecFileFn` (Task 1); `config.pandoc.*` (Task 2).
- Produces: `renderSolutionPdf(markdown: string, deps?: { execFile?: ExecFileFn; writeFile?: (path: string, data: string) => Promise<void>; rm?: (path: string) => Promise<void>; readFile?: (path: string) => Promise<Buffer> }): Promise<Buffer>` — consumed by Task 14 (`worker/index.ts`).

- [ ] **Step 1: Write the failing tests**

```ts
// test/pdf/renderPdf.test.ts
import { describe, expect, it } from 'vitest';
import { renderSolutionPdf } from '../../src/pdf/renderPdf.js';

describe('renderSolutionPdf', () => {
  it('writes the markdown to a temp file, invokes pandoc with the configured template/css/engine, reads back the PDF bytes, and cleans up the temp file', async () => {
    const writeCalls: Array<{ path: string; data: string }> = [];
    const execCalls: Array<{ file: string; args: readonly string[] }> = [];
    const rmCalls: string[] = [];
    const pdfBytes = Buffer.from('%PDF-1.4 fake bytes');

    const deps = {
      writeFile: async (path: string, data: string) => {
        writeCalls.push({ path, data });
      },
      execFile: async (file: string, args: readonly string[]) => {
        execCalls.push({ file, args });
        return { stdout: '', stderr: '' };
      },
      readFile: async () => pdfBytes,
      rm: async (path: string) => {
        rmCalls.push(path);
      },
    };

    const result = await renderSolutionPdf('# hello', deps);

    expect(result).toBe(pdfBytes);
    expect(writeCalls).toHaveLength(1);
    expect(writeCalls[0]?.data).toBe('# hello');

    expect(execCalls).toHaveLength(1);
    const [call] = execCalls;
    expect(call?.file).toBe('pandoc');
    expect(call?.args).toEqual([
      writeCalls[0]?.path,
      '--template',
      '/app/vorlage/template.html',
      '--css',
      '/app/vorlage/style.css',
      '--pdf-engine',
      '/app/.venv/bin/weasyprint',
      '-o',
      expect.stringMatching(/\.pdf$/),
    ]);

    // Cleans up both the temp markdown source and the intermediate PDF it read back from.
    expect(rmCalls).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- test/pdf/renderPdf.test.ts`
Expected: FAIL with "Cannot find module '../../src/pdf/renderPdf.js'".

- [ ] **Step 3: Implement**

```ts
// src/pdf/renderPdf.ts
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config/index.js';
import { defaultExecFile, type ExecFileFn } from '../lib/execFile.js';

export interface RenderPdfDeps {
  execFile?: ExecFileFn;
  writeFile?: (path: string, data: string) => Promise<void>;
  readFile?: (path: string) => Promise<Buffer>;
  rm?: (path: string) => Promise<void>;
}

export async function renderSolutionPdf(markdown: string, deps: RenderPdfDeps = {}): Promise<Buffer> {
  const execFile = deps.execFile ?? defaultExecFile;
  const writeFile = deps.writeFile ?? ((p: string, data: string) => fs.writeFile(p, data, 'utf8'));
  const readFile = deps.readFile ?? ((p: string) => fs.readFile(p));
  const rm = deps.rm ?? ((p: string) => fs.rm(p, { force: true }));

  const jobId = randomUUID();
  const mdPath = path.join(os.tmpdir(), `${jobId}.md`);
  const pdfPath = path.join(os.tmpdir(), `${jobId}.pdf`);

  await writeFile(mdPath, markdown);
  try {
    await execFile(config.pandoc.binary, [
      mdPath,
      '--template',
      config.pandoc.templatePath,
      '--css',
      config.pandoc.cssPath,
      '--pdf-engine',
      config.pandoc.weasyprintBinary,
      '-o',
      pdfPath,
    ]);
    return await readFile(pdfPath);
  } finally {
    await rm(mdPath);
    await rm(pdfPath);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- test/pdf/renderPdf.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/pdf/renderPdf.ts test/pdf/renderPdf.test.ts
git commit -m "feat: render solution markdown to PDF bytes via pandoc+weasyprint"
```

---

### Task 12: Claude solve step rewrite

**Files:**
- Modify: `src/claude/processFile.ts` (full rewrite of prompt/schema/model, new signature)
- Modify: `test/processFile.test.ts` (full rewrite for the new interface)

**Interfaces:**
- Consumes: `ExtractionResult`, `VisionPage`, `ProcessedFileResult`, `TaskSolution`, `FileProcessor` (Task 2); `FACH_KEYS`, `FachKey` (Task 2, `src/fach.ts`).
- Produces: `createFileProcessor(options?: { queryFn?: QueryFn }): FileProcessor` where `FileProcessor.processFile(fileName: string, extraction: ExtractionResult): Promise<ProcessedFileResult>` — consumed by Task 14 (`worker/index.ts`).

- [ ] **Step 1: Write the failing tests (full rewrite of the test file)**

```ts
// test/processFile.test.ts
import { describe, expect, it } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { createFileProcessor } from '../src/claude/processFile.js';
import type { ExtractionResult } from '../src/types.js';

process.env.ANTHROPIC_API_KEY ??= 'test-api-key';

function makeExtraction(overrides: Partial<ExtractionResult> = {}): ExtractionResult {
  return {
    markdown: '# Arbeitsblatt\n\nAufgabe 1: Welche Rechte hat der Käufer bei einem Sachmangel?',
    visionPages: [],
    ranOcr: false,
    archivalPdfPath: '/inbox/arbeitsblatt1.pdf',
    ...overrides,
  };
}

function makeResultMessage(fields: Record<string, unknown>): SDKMessage {
  return {
    type: 'result',
    duration_ms: 100,
    duration_api_ms: 90,
    is_error: false,
    num_turns: 1,
    stop_reason: null,
    total_cost_usd: 0,
    usage: {},
    modelUsage: {},
    permission_denials: [],
    uuid: 'test-uuid',
    session_id: 'test-session',
    ...fields,
  } as unknown as SDKMessage;
}

const VALID_STRUCTURED_OUTPUT = {
  isMaterialblatt: false,
  fach: 'BGWP',
  thema: 'Kaufvertragsrecht',
  tasksFound: [
    {
      title: 'Mangelhafte Lieferung',
      taskDescription: 'Welche Rechte hat der Käufer bei einem Sachmangel?',
      proposedSolution: 'Nacherfüllung nach § 439 BGB.',
      quelle: '§ 437, § 439 BGB',
    },
  ],
};

describe('createFileProcessor', () => {
  it('returns a correctly parsed ProcessedFileResult given a well-formed SDK response', async () => {
    async function* fakeQuery(): AsyncGenerator<SDKMessage> {
      yield makeResultMessage({
        subtype: 'success',
        result: JSON.stringify(VALID_STRUCTURED_OUTPUT),
        structured_output: VALID_STRUCTURED_OUTPUT,
      });
    }

    const processor = createFileProcessor({ queryFn: fakeQuery });
    const result = await processor.processFile('arbeitsblatt1.pdf', makeExtraction());

    expect(result).toEqual({
      originalFileName: 'arbeitsblatt1.pdf',
      isMaterialblatt: false,
      fach: 'BGWP',
      thema: 'Kaufvertragsrecht',
      tasksFound: VALID_STRUCTURED_OUTPUT.tasksFound,
    });
  });

  it('passes model=claude-sonnet-5 to the SDK by default', async () => {
    let capturedModel: unknown;
    async function* fakeQuery(params: { prompt: string; options?: { model?: string } }): AsyncGenerator<SDKMessage> {
      capturedModel = params.options?.model;
      yield makeResultMessage({
        subtype: 'success',
        result: JSON.stringify(VALID_STRUCTURED_OUTPUT),
        structured_output: VALID_STRUCTURED_OUTPUT,
      });
    }

    const processor = createFileProcessor({ queryFn: fakeQuery });
    await processor.processFile('arbeitsblatt1.pdf', makeExtraction());

    expect(capturedModel).toBe('claude-sonnet-5');
  });

  it('includes the extracted markdown in a plain string prompt when there are no vision pages', async () => {
    let capturedPrompt: unknown;
    async function* fakeQuery(params: { prompt: unknown }): AsyncGenerator<SDKMessage> {
      capturedPrompt = params.prompt;
      yield makeResultMessage({
        subtype: 'success',
        result: JSON.stringify(VALID_STRUCTURED_OUTPUT),
        structured_output: VALID_STRUCTURED_OUTPUT,
      });
    }

    const processor = createFileProcessor({ queryFn: fakeQuery });
    await processor.processFile('arbeitsblatt1.pdf', makeExtraction());

    expect(typeof capturedPrompt).toBe('string');
    expect(capturedPrompt as string).toContain('Welche Rechte hat der Käufer');
  });

  it('sends an async-iterable multi-content prompt with image blocks when vision pages are present', async () => {
    let capturedPrompt: unknown;
    async function* fakeQuery(params: { prompt: unknown }): AsyncGenerator<SDKMessage> {
      capturedPrompt = params.prompt;
      yield makeResultMessage({
        subtype: 'success',
        result: JSON.stringify(VALID_STRUCTURED_OUTPUT),
        structured_output: VALID_STRUCTURED_OUTPUT,
      });
    }

    const processor = createFileProcessor({
      queryFn: fakeQuery,
      readImageFile: async () => Buffer.from('fake-png-bytes'),
    });
    const extraction = makeExtraction({ visionPages: [{ pageNumber: 1, imagePath: '/tmp/page-1.png' }] });

    await processor.processFile('handwritten.pdf', extraction);

    expect(typeof capturedPrompt).toBe('object');
    const messages: Array<{ message: { content: Array<{ type: string }> } }> = [];
    for await (const message of capturedPrompt as AsyncIterable<{ message: { content: Array<{ type: string }> } }>) {
      messages.push(message);
    }
    expect(messages).toHaveLength(1);
    const blockTypes = messages[0]?.message.content.map((block) => block.type);
    expect(blockTypes).toEqual(['text', 'image']);
  });

  it('throws a clear error when the parsed JSON is missing required fields', async () => {
    async function* fakeQuery(): AsyncGenerator<SDKMessage> {
      yield makeResultMessage({
        subtype: 'success',
        result: JSON.stringify({ unrelated: true }),
        structured_output: { unrelated: true },
      });
    }

    const processor = createFileProcessor({ queryFn: fakeQuery });

    await expect(processor.processFile('arbeitsblatt1.pdf', makeExtraction())).rejects.toThrow(/isMaterialblatt/);
  });

  it('throws a clear error when the SDK query itself fails (non-success subtype)', async () => {
    async function* fakeQuery(): AsyncGenerator<SDKMessage> {
      yield makeResultMessage({ subtype: 'error_during_execution', errors: ['model overloaded'] });
    }

    const processor = createFileProcessor({ queryFn: fakeQuery });

    await expect(processor.processFile('arbeitsblatt1.pdf', makeExtraction())).rejects.toThrow(/Claude query failed/);
  });

  it('throws a clear error when the SDK yields no result message at all', async () => {
    async function* fakeQuery(): AsyncGenerator<SDKMessage> {
      // yields nothing
    }

    const processor = createFileProcessor({ queryFn: fakeQuery });

    await expect(processor.processFile('arbeitsblatt1.pdf', makeExtraction())).rejects.toThrow(/received no result/);
  });

  it('returns isMaterialblatt=true with an empty tasksFound for reference material', async () => {
    const materialOutput = { isMaterialblatt: true, fach: 'Deutsch', thema: 'Grammatikregeln', tasksFound: [] };
    async function* fakeQuery(): AsyncGenerator<SDKMessage> {
      yield makeResultMessage({
        subtype: 'success',
        result: JSON.stringify(materialOutput),
        structured_output: materialOutput,
      });
    }

    const processor = createFileProcessor({ queryFn: fakeQuery });
    const result = await processor.processFile('handout.pdf', makeExtraction());

    expect(result.isMaterialblatt).toBe(true);
    expect(result.tasksFound).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- test/processFile.test.ts`
Expected: FAIL — old `processFile.ts` doesn't accept `(fileName, extraction)`, doesn't export the new fields, etc.

- [ ] **Step 3: Rewrite `src/claude/processFile.ts`**

```ts
// src/claude/processFile.ts
import { readFile as fsReadFile } from 'node:fs/promises';
import { query as sdkQuery, type Options, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import pino from 'pino';
import { config } from '../config/index.js';
import { FACH_KEYS, type FachKey } from '../fach.js';
import type { ExtractionResult, FileProcessor, ProcessedFileResult, TaskSolution, VisionPage } from '../types.js';

const logger = pino({ name: 'claude-file-processor' });

/**
 * The Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) is Claude Code packaged as a
 * library — `query()` returns an async generator of `SDKMessage` events and drives the
 * full Claude Code harness. We disable all built-in tools (`tools: []`) and rely on the
 * SDK's native structured-output support (`outputFormat: { type: 'json_schema', ... }`).
 * When the extraction stage produced page images for the vision fallback, `prompt` is an
 * async-iterable of `SDKUserMessage` carrying image content blocks instead of a plain
 * string, per the SDK's streaming input mode.
 */

type QueryFn = (params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }) => AsyncIterable<SDKMessage>;
type ReadImageFileFn = (path: string) => Promise<Buffer>;

const SYSTEM_PROMPT = `Du bist ein Assistent, der Schulunterlagen liest, Aufgaben löst und Materialblätter erkennt.

Klassifiziere zuerst, ob das Dokument ein Aufgabenblatt (enthält zu lösende Aufgaben) oder ein
reines Info-/Materialblatt (Fakten, Gesetzestexte, Merkblatt - keine Aufgaben) ist.

Bestimme das Fach über den festen Fach-Schlüssel (siehe Enum im Schema). Bilde lose oder
synonyme Bezeichnungen aggressiv auf den passenden festen Schlüssel ab (z.B. "Mathe" oder
"Informationstechnik" auf den nächstliegenden Eintrag), statt eine Abweichung als
unklassifizierbar zu behandeln. Wenn wirklich kein Schlüssel passt, verwende "_Unsortiert".

Falls Seitenbilder mitgeliefert werden (Vision-Fallback für schlecht lesbare/handschriftliche
Seiten), sind diese Bilder für die jeweilige Seite maßgeblich - ignoriere dafür etwaigen
verstümmelten Text aus dem Markdown für dieselbe Seite.

Löse jede Aufgabe vollständig und präzise, ohne Füllsätze. Nenne Paragraphen, Kategorien oder
Quellen im "quelle"-Feld, wo zutreffend. Wenn das Dokument keine Aufgaben enthält (Materialblatt),
gib ein leeres "tasksFound"-Array zurück.

Antworte ausschließlich mit dem im Schema beschriebenen JSON.`;

const RESULT_JSON_SCHEMA = {
  type: 'object',
  properties: {
    isMaterialblatt: { type: 'boolean', description: 'true wenn das Dokument keine zu lösenden Aufgaben enthält.' },
    fach: { type: 'string', enum: [...FACH_KEYS], description: 'Fester Fach-Schlüssel.' },
    lernfeld: { type: 'string', description: 'Optionales Kapitel/Lernfeld, falls im Dokument erkennbar.' },
    thema: { type: 'string', description: 'Kurzes Thema des Dokuments.' },
    tasksFound: {
      type: 'array',
      description: 'Jede gefundene Aufgabe mit vollständiger Lösung. Leer bei einem Materialblatt.',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Kurztitel für die Überschrift.' },
          taskDescription: { type: 'string', description: 'Vollständiger Aufgabentext.' },
          proposedSolution: { type: 'string', description: 'Vollständige, konkrete Lösung.' },
          quelle: { type: 'string', description: 'Paragraphen/Quellen/Kategorie, falls zutreffend.' },
        },
        required: ['title', 'taskDescription', 'proposedSolution'],
        additionalProperties: false,
      },
    },
  },
  required: ['isMaterialblatt', 'fach', 'thema', 'tasksFound'],
  additionalProperties: false,
} as const;

function buildPromptText(fileName: string, extraction: ExtractionResult): string {
  const visionNote =
    extraction.visionPages.length > 0
      ? `\n\nHinweis: Für die Seite(n) ${extraction.visionPages.map((p) => p.pageNumber).join(', ')} sind Bilder beigefügt - nutze diese als Quelle, nicht den Markdown-Text für diese Seiten.`
      : '';
  return `Hier ist der extrahierte Inhalt der Datei "${fileName}":

<file_content>
${extraction.markdown}
</file_content>${visionNote}

Analysiere den Inhalt und antworte mit dem im Schema beschriebenen JSON.`;
}

async function* buildVisionPrompt(
  promptText: string,
  visionPages: VisionPage[],
  readImageFile: ReadImageFileFn,
): AsyncGenerator<SDKUserMessage> {
  const imageBlocks = await Promise.all(
    visionPages.map(async (page) => ({
      type: 'image' as const,
      source: { type: 'base64' as const, media_type: 'image/png' as const, data: (await readImageFile(page.imagePath)).toString('base64') },
    })),
  );
  yield {
    type: 'user',
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: [{ type: 'text' as const, text: promptText }, ...imageBlocks],
    },
  };
}

function parseModelJson(rawText: string, fileName: string): unknown {
  try {
    return JSON.parse(rawText);
  } catch (cause) {
    throw new Error(
      `claude/processFile: Claude's response for "${fileName}" was not valid JSON: ${
        cause instanceof Error ? cause.message : String(cause)
      }. Raw response (truncated): ${rawText.slice(0, 500)}`,
    );
  }
}

function validateShape(raw: unknown, fileName: string): ProcessedFileResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`claude/processFile: Claude's response for "${fileName}" was not a JSON object.`);
  }
  const obj = raw as Record<string, unknown>;

  if (typeof obj.isMaterialblatt !== 'boolean') {
    throw new Error(`claude/processFile: Claude's response for "${fileName}" is missing "isMaterialblatt".`);
  }
  if (typeof obj.fach !== 'string' || !(FACH_KEYS as readonly string[]).includes(obj.fach)) {
    throw new Error(`claude/processFile: Claude's response for "${fileName}" has an invalid "fach".`);
  }
  if (typeof obj.thema !== 'string') {
    throw new Error(`claude/processFile: Claude's response for "${fileName}" is missing "thema".`);
  }
  if (!Array.isArray(obj.tasksFound)) {
    throw new Error(`claude/processFile: Claude's response for "${fileName}" is missing a "tasksFound" array.`);
  }

  const tasksFound: TaskSolution[] = obj.tasksFound.map((task, index) => {
    if (typeof task !== 'object' || task === null || Array.isArray(task)) {
      throw new Error(`claude/processFile: task at index ${index} for "${fileName}" is not an object.`);
    }
    const t = task as Record<string, unknown>;
    if (typeof t.title !== 'string' || typeof t.taskDescription !== 'string' || typeof t.proposedSolution !== 'string') {
      throw new Error(`claude/processFile: task at index ${index} for "${fileName}" is missing required fields.`);
    }
    return {
      title: t.title,
      taskDescription: t.taskDescription,
      proposedSolution: t.proposedSolution,
      ...(typeof t.quelle === 'string' ? { quelle: t.quelle } : {}),
    };
  });

  return {
    originalFileName: fileName,
    isMaterialblatt: obj.isMaterialblatt,
    fach: obj.fach as FachKey,
    ...(typeof obj.lernfeld === 'string' ? { lernfeld: obj.lernfeld } : {}),
    thema: obj.thema,
    tasksFound,
  };
}

export interface CreateFileProcessorOptions {
  queryFn?: QueryFn;
  readImageFile?: ReadImageFileFn;
}

export function createFileProcessor(options: CreateFileProcessorOptions = {}): FileProcessor {
  const queryFn: QueryFn = options.queryFn ?? sdkQuery;
  const readImageFile: ReadImageFileFn = options.readImageFile ?? ((path: string) => fsReadFile(path));

  return {
    async processFile(fileName: string, extraction: ExtractionResult): Promise<ProcessedFileResult> {
      if (!config.anthropic.apiKey()) {
        logger.info('ANTHROPIC_API_KEY not set; relying on Claude Code subscription login (`claude login`)');
      }

      const promptText = buildPromptText(fileName, extraction);
      const prompt: string | AsyncIterable<SDKUserMessage> =
        extraction.visionPages.length > 0 ? buildVisionPrompt(promptText, extraction.visionPages, readImageFile) : promptText;

      logger.info({ fileName, visionPages: extraction.visionPages.length }, 'Sending file to Claude for solving');

      let resultMessage: Extract<SDKMessage, { type: 'result' }> | undefined;

      for await (const message of queryFn({
        prompt,
        options: {
          systemPrompt: SYSTEM_PROMPT,
          model: config.anthropic.model,
          tools: [],
          maxTurns: 3,
          outputFormat: { type: 'json_schema', schema: RESULT_JSON_SCHEMA },
        },
      })) {
        if (message.type === 'system' && message.subtype === 'init') {
          logger.info({ fileName, apiKeySource: message.apiKeySource }, 'Claude Agent SDK session started');
        }
        if (message.type === 'result') {
          resultMessage = message;
        }
      }

      if (!resultMessage) {
        logger.error({ fileName }, 'Claude Agent SDK query produced no result message');
        throw new Error(`claude/processFile: received no result from Claude for "${fileName}".`);
      }

      if (resultMessage.subtype !== 'success') {
        logger.error({ fileName, subtype: resultMessage.subtype, errors: resultMessage.errors }, 'Claude Agent SDK query did not succeed');
        throw new Error(
          `claude/processFile: Claude query failed for "${fileName}" (${resultMessage.subtype}): ${resultMessage.errors?.join('; ') ?? 'unknown error'}`,
        );
      }

      const raw = resultMessage.structured_output ?? parseModelJson(resultMessage.result, fileName);
      const result = validateShape(raw, fileName);

      logger.info({ fileName, isMaterialblatt: result.isMaterialblatt, tasksFound: result.tasksFound.length }, 'Claude solve complete');

      return result;
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- test/processFile.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors in `src/claude/processFile.ts` or `test/processFile.test.ts`. If the `ImageBlockParam`/`TextBlockParam` literal shapes in `buildVisionPrompt` don't structurally satisfy `MessageParam.content`, adjust the literal fields to match (add/remove optional fields) until it compiles — do not weaken this to `as any`.

- [ ] **Step 6: Commit**

```bash
git add src/claude/processFile.ts test/processFile.test.ts
git commit -m "feat: rewrite Claude solve step for Fach classification, Materialblatt routing, and vision fallback"
```

---

### Task 13: Nextcloud writer rewrite

**Files:**
- Modify: `src/nextcloud/writeResult.ts` (full rewrite of path/content logic; keeps the `execFile` injection from Task 1)
- Modify: `test/nextcloudWriter.test.ts` (full rewrite for the new interface)

**Interfaces:**
- Consumes: `ProcessedFileResult`, `NextcloudWriteContent`, `NextcloudWriter` (Task 2); `FACH_SUBPATH` (Task 2, `src/fach.ts`); `ExecFileFn`, `defaultExecFile` (Task 1).
- Produces: `createNextcloudWriter(deps?: { execFile?: ExecFileFn }): NextcloudWriter` where `writeResult(result, content, datum)` — consumed by Task 14 (`worker/index.ts`).

- [ ] **Step 1: Write the failing tests (full rewrite of the test file)**

```ts
// test/nextcloudWriter.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createNextcloudWriter } from '../src/nextcloud/writeResult.js';
import type { ProcessedFileResult } from '../src/types.js';

const TARGET_USER = 'alice';

function makeResult(overrides: Partial<ProcessedFileResult> = {}): ProcessedFileResult {
  return {
    originalFileName: 'arbeitsblatt1.pdf',
    isMaterialblatt: false,
    fach: 'BGWP',
    thema: 'Kaufvertragsrecht',
    tasksFound: [],
    ...overrides,
  };
}

const okExecFile = async (): Promise<{ stdout: string; stderr: string }> => ({ stdout: '', stderr: '' });

describe('createNextcloudWriter().writeResult', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nc-writer-test-'));
    process.env.NEXTCLOUD_DATA_DIR = tmpDir;
    process.env.NEXTCLOUD_TARGET_USER = TARGET_USER;
  });

  afterEach(async () => {
    delete process.env.NEXTCLOUD_DATA_DIR;
    delete process.env.NEXTCLOUD_TARGET_USER;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('writes a solved PDF under Fächer/<Fach>/<subpath>/ with a date-suffixed filename', async () => {
    const writer = createNextcloudWriter({ execFile: okExecFile });
    const pdfBytes = Buffer.from('%PDF-1.4 fake');

    const { writtenPath } = await writer.writeResult(makeResult(), { kind: 'pdf', bytes: pdfBytes }, '2026-07-23');

    const expectedPath = path.join(tmpDir, TARGET_USER, 'files', 'Fächer', 'BGWP', 'BGWP', 'arbeitsblatt1_Loesung_2026-07-23.pdf');
    expect(writtenPath).toBe(expectedPath);
    expect(await fs.readFile(writtenPath)).toEqual(pdfBytes);
  });

  it('nests under lernfeld when present', async () => {
    const writer = createNextcloudWriter({ execFile: okExecFile });
    const result = makeResult({ fach: 'IT-Tec', lernfeld: 'LF 3' });

    const { writtenPath } = await writer.writeResult(result, { kind: 'pdf', bytes: Buffer.from('x') }, '2026-07-23');

    expect(writtenPath).toBe(
      path.join(tmpDir, TARGET_USER, 'files', 'Fächer', 'IT-Tec', 'LF 3', 'arbeitsblatt1_Loesung_2026-07-23.pdf'),
    );
  });

  it('routes an unclassifiable Fach to Fächer/_Unsortiert/', async () => {
    const writer = createNextcloudWriter({ execFile: okExecFile });
    const result = makeResult({ fach: '_Unsortiert' });

    const { writtenPath } = await writer.writeResult(result, { kind: 'pdf', bytes: Buffer.from('x') }, '2026-07-23');

    expect(writtenPath).toBe(
      path.join(tmpDir, TARGET_USER, 'files', 'Fächer', '_Unsortiert', 'arbeitsblatt1_Loesung_2026-07-23.pdf'),
    );
  });

  it('routes Materialblatt content into Fächer/<Fach>/Material/ with no _Loesung suffix, preserving the source extension', async () => {
    const writer = createNextcloudWriter({ execFile: okExecFile });
    const materialSourceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'material-src-'));
    const sourcePath = path.join(materialSourceDir, 'gesetzestext.pdf');
    await fs.writeFile(sourcePath, 'source bytes');

    const result = makeResult({ isMaterialblatt: true, fach: 'Deutsch', originalFileName: 'gesetzestext.pdf' });
    const { writtenPath } = await writer.writeResult(result, { kind: 'material', sourcePath }, '2026-07-23');

    expect(writtenPath).toBe(
      path.join(tmpDir, TARGET_USER, 'files', 'Fächer', 'Deutsch', 'Material', 'gesetzestext_2026-07-23.pdf'),
    );
    expect(await fs.readFile(writtenPath, 'utf8')).toBe('source bytes');

    await fs.rm(materialSourceDir, { recursive: true, force: true });
  });

  it('sanitizes a path-traversal originalFileName before it ever reaches the filesystem', async () => {
    const writer = createNextcloudWriter({ execFile: okExecFile });
    const result = makeResult({ originalFileName: '../../etc/passwd' });

    const { writtenPath } = await writer.writeResult(result, { kind: 'pdf', bytes: Buffer.from('x') }, '2026-07-23');

    const expectedDir = path.resolve(tmpDir, TARGET_USER, 'files', 'Fächer', 'BGWP', 'BGWP');
    const resolvedWritten = path.resolve(writtenPath);
    expect(resolvedWritten.startsWith(expectedDir + path.sep)).toBe(true);
    expect(resolvedWritten).not.toContain('..');
  });

  it('still resolves successfully with the correct writtenPath if occ files:scan fails', async () => {
    const failingExecFile = async (): Promise<{ stdout: string; stderr: string }> => {
      throw new Error('spawn occ ENOENT');
    };
    const writer = createNextcloudWriter({ execFile: failingExecFile });

    const { writtenPath } = await writer.writeResult(makeResult(), { kind: 'pdf', bytes: Buffer.from('x') }, '2026-07-23');

    expect(await fs.stat(writtenPath).then(() => true)).toBe(true);
  });

  it('invokes occ files:scan scoped to the computed Fach/Lernfeld target directory', async () => {
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const recordingExecFile = async (file: string, args: readonly string[]) => {
      calls.push({ file, args });
      return { stdout: '', stderr: '' };
    };
    const writer = createNextcloudWriter({ execFile: recordingExecFile });

    await writer.writeResult(makeResult(), { kind: 'pdf', bytes: Buffer.from('x') }, '2026-07-23');

    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual(['files:scan', `--path=/${TARGET_USER}/files/Fächer/BGWP`]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- test/nextcloudWriter.test.ts`
Expected: FAIL — old `writeResult` signature and flat-folder behavior don't match.

- [ ] **Step 3: Rewrite `src/nextcloud/writeResult.ts`**

```ts
// src/nextcloud/writeResult.ts
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import pino from 'pino';
import { config } from '../config/index.js';
import { FACH_SUBPATH } from '../fach.js';
import { defaultExecFile, type ExecFileFn } from '../lib/execFile.js';
import type { NextcloudWriteContent, NextcloudWriter, ProcessedFileResult } from '../types.js';

const logger = pino({ name: 'nextcloud-writer' });

const RESULT_ROOT = 'Fächer';
const MATERIAL_SUBDIRNAME = 'Material';

export interface NextcloudWriterDeps {
  execFile?: ExecFileFn;
}

/**
 * Neutralizes path separators and parent-directory traversal sequences. `originalFileName`
 * and `lernfeld` are not trusted to be safe for direct filesystem-path construction (e.g.
 * `../../etc/passwd` or `foo/bar.txt`).
 */
function sanitizePathSegment(name: string): string {
  const withoutSeparators = name.replace(/[/\\]/g, '_');
  const withoutTraversal = withoutSeparators.replace(/\.\./g, '_');
  const trimmed = withoutTraversal.trim();
  return trimmed.length > 0 ? trimmed : 'untitled';
}

function deriveTargetDir(result: ProcessedFileResult): string[] {
  const fachSubpath = FACH_SUBPATH[result.fach].split('/').map(sanitizePathSegment);
  const parts = [RESULT_ROOT, ...fachSubpath];
  if (result.isMaterialblatt) {
    parts.push(MATERIAL_SUBDIRNAME);
  } else if (result.lernfeld) {
    parts.push(sanitizePathSegment(result.lernfeld));
  }
  return parts;
}

function deriveFileName(result: ProcessedFileResult, content: NextcloudWriteContent, datum: string): string {
  const safeBase = sanitizePathSegment(result.originalFileName);
  const ext = path.extname(safeBase);
  const stem = ext.length > 0 ? safeBase.slice(0, -ext.length) : safeBase;
  const finalStem = stem.length > 0 ? stem : 'untitled';

  if (content.kind === 'pdf') {
    return `${finalStem}_Loesung_${datum}.pdf`;
  }
  const materialExt = path.extname(content.sourcePath) || '.txt';
  return `${finalStem}_${datum}${materialExt}`;
}

export function createNextcloudWriter(deps: NextcloudWriterDeps = {}): NextcloudWriter {
  const execFile = deps.execFile ?? defaultExecFile;

  return {
    async writeResult(result, content, datum) {
      const targetUser = config.nextcloud.targetUser();
      const dirParts = deriveTargetDir(result);
      const targetDir = path.join(config.nextcloud.dataDir(), targetUser, 'files', ...dirParts);
      const fileName = deriveFileName(result, content, datum);
      const writtenPath = path.join(targetDir, fileName);

      const resolvedTargetDir = path.resolve(targetDir);
      const resolvedWrittenPath = path.resolve(writtenPath);
      if (resolvedWrittenPath !== resolvedTargetDir && !resolvedWrittenPath.startsWith(resolvedTargetDir + path.sep)) {
        throw new Error(`Refusing to write outside of target directory: ${writtenPath}`);
      }

      await fs.mkdir(targetDir, { recursive: true });
      if (content.kind === 'pdf') {
        await fs.writeFile(writtenPath, content.bytes);
      } else {
        await fs.copyFile(content.sourcePath, writtenPath);
      }

      const scanPath = `/${targetUser}/files/${dirParts.join('/')}`;
      try {
        await execFile(config.nextcloud.occBinary, ['files:scan', `--path=${scanPath}`]);
      } catch (err) {
        logger.error({ err, scanPath }, 'occ files:scan failed after writing Nextcloud result file');
      }

      return { writtenPath };
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- test/nextcloudWriter.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/nextcloud/writeResult.ts test/nextcloudWriter.test.ts
git commit -m "feat: route Nextcloud writes by Fach/Lernfeld with date-suffixed filenames"
```

---

### Task 14: Worker wiring

**Files:**
- Modify: `src/worker/index.ts` (full rewrite of `handleJob`)
- Modify: `test/worker.test.ts` (full rewrite for the new pipeline)

**Interfaces:**
- Consumes: `extractFile` (Task 8); `buildSolutionMarkdown` (Task 10); `renderSolutionPdf` (Task 11); `createFileProcessor` (Task 12); `createNextcloudWriter` (Task 13); `FileJobData` (`src/queue/index.ts`, unchanged).
- Produces: `createFileJobWorker(): Worker<FileJobData>` (same export name/shape as today — no downstream consumers outside this file and its test).

- [ ] **Step 1: Write the failing tests (full rewrite of the test file)**

```ts
// test/worker.test.ts
import { describe, expect, it, vi, beforeEach } from 'vitest';

const extractFile = vi.fn();
const buildSolutionMarkdown = vi.fn();
const renderSolutionPdf = vi.fn();
const processFile = vi.fn();
const writeResult = vi.fn();
const mkdtemp = vi.fn();
const mkdir = vi.fn();
const rename = vi.fn();
const rmdir = vi.fn();
const rm = vi.fn();

vi.mock('node:fs', () => ({
  promises: { mkdtemp, mkdir, rename, rmdir, rm },
}));
vi.mock('node:os', () => ({ tmpdir: () => '/tmp' }));
vi.mock('../src/extract/index.js', () => ({ extractFile }));
vi.mock('../src/pdf/buildMarkdown.js', () => ({ buildSolutionMarkdown }));
vi.mock('../src/pdf/renderPdf.js', () => ({ renderSolutionPdf }));
vi.mock('../src/claude/processFile.js', () => ({ createFileProcessor: () => ({ processFile }) }));
vi.mock('../src/nextcloud/writeResult.js', () => ({ createNextcloudWriter: () => ({ writeResult }) }));
vi.mock('../src/queue/index.js', () => ({
  QUEUE_NAME: 'teams-file-jobs',
  getRedisConnection: () => ({}),
}));
vi.mock('bullmq', () => ({
  Worker: vi.fn().mockImplementation(() => ({ on: vi.fn() })),
}));

process.env.INGEST_WATCH_DIR = '/inbox';

const AUFGABENBLATT_RESULT = {
  originalFileName: 'arbeitsblatt1.pdf',
  isMaterialblatt: false,
  fach: 'BGWP',
  thema: 'Kaufvertragsrecht',
  tasksFound: [{ title: 't', taskDescription: 'q', proposedSolution: 'a' }],
};

const MATERIAL_RESULT = {
  originalFileName: 'handout.pdf',
  isMaterialblatt: true,
  fach: 'Deutsch',
  thema: 'Grammatikregeln',
  tasksFound: [],
};

describe('worker pipeline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mkdtemp.mockResolvedValue('/tmp/job-abc123');
    mkdir.mockResolvedValue(undefined);
    rename.mockResolvedValue(undefined);
    rmdir.mockResolvedValue(undefined);
    rm.mockResolvedValue(undefined);
  });

  it('extracts, solves, renders a PDF, writes it, and archives the raw source when OCR did not run', async () => {
    extractFile.mockResolvedValue({ markdown: '# text', visionPages: [], ranOcr: false, archivalPdfPath: '/inbox/arbeitsblatt1.pdf' });
    processFile.mockResolvedValue(AUFGABENBLATT_RESULT);
    buildSolutionMarkdown.mockReturnValue('# solution markdown');
    renderSolutionPdf.mockResolvedValue(Buffer.from('%PDF fake'));
    writeResult.mockResolvedValue({ writtenPath: '/data/alice/files/Fächer/BGWP/arbeitsblatt1_Loesung_2026-07-23.pdf' });

    const { createFileJobWorker } = await import('../src/worker/index.js');
    const { Worker } = await import('bullmq');
    createFileJobWorker();

    const handler = vi.mocked(Worker).mock.calls[0][1] as (job: unknown) => Promise<void>;
    const job = { id: '1', data: { filePath: '/inbox/arbeitsblatt1.pdf', originalFileName: 'arbeitsblatt1.pdf', receivedAt: 'now' } };
    await handler(job);

    expect(extractFile).toHaveBeenCalledWith('/inbox/arbeitsblatt1.pdf', '/tmp/job-abc123');
    expect(processFile).toHaveBeenCalledWith('arbeitsblatt1.pdf', expect.objectContaining({ markdown: '# text' }));
    expect(buildSolutionMarkdown).toHaveBeenCalledWith(AUFGABENBLATT_RESULT, expect.any(String));
    expect(renderSolutionPdf).toHaveBeenCalledWith('# solution markdown');
    expect(writeResult).toHaveBeenCalledWith(
      AUFGABENBLATT_RESULT,
      { kind: 'pdf', bytes: Buffer.from('%PDF fake') },
      expect.any(String),
    );

    // ranOcr was false, so the ORIGINAL file (not archivalPdfPath) is archived.
    expect(rename).toHaveBeenCalledTimes(1);
    const [movedFrom, movedTo] = rename.mock.calls[0] as [string, string];
    expect(movedFrom).toBe('/inbox/arbeitsblatt1.pdf');
    expect(movedTo).toMatch(/[/\\]\.processed[/\\]\d+-arbeitsblatt1\.pdf$/);
  });

  it('archives the OCR\'d searchable PDF (not the raw scan) when extraction ran OCR', async () => {
    extractFile.mockResolvedValue({ markdown: '# text', visionPages: [], ranOcr: true, archivalPdfPath: '/tmp/job-abc123/ocr.pdf' });
    processFile.mockResolvedValue(AUFGABENBLATT_RESULT);
    buildSolutionMarkdown.mockReturnValue('# solution markdown');
    renderSolutionPdf.mockResolvedValue(Buffer.from('%PDF fake'));
    writeResult.mockResolvedValue({ writtenPath: '/data/x.pdf' });

    const { createFileJobWorker } = await import('../src/worker/index.js');
    const { Worker } = await import('bullmq');
    createFileJobWorker();

    const handler = vi.mocked(Worker).mock.calls[0][1] as (job: unknown) => Promise<void>;
    const job = { id: '1', data: { filePath: '/inbox/scan.pdf', originalFileName: 'scan.pdf', receivedAt: 'now' } };
    await handler(job);

    const [movedFrom] = rename.mock.calls[0] as [string, string];
    expect(movedFrom).toBe('/tmp/job-abc123/ocr.pdf');
  });

  it('skips PDF generation and writes the archival source directly for a Materialblatt', async () => {
    extractFile.mockResolvedValue({ markdown: '# text', visionPages: [], ranOcr: false, archivalPdfPath: '/inbox/handout.pdf' });
    processFile.mockResolvedValue(MATERIAL_RESULT);
    writeResult.mockResolvedValue({ writtenPath: '/data/alice/files/Fächer/Deutsch/Material/handout_2026-07-23.pdf' });

    const { createFileJobWorker } = await import('../src/worker/index.js');
    const { Worker } = await import('bullmq');
    createFileJobWorker();

    const handler = vi.mocked(Worker).mock.calls[0][1] as (job: unknown) => Promise<void>;
    const job = { id: '1', data: { filePath: '/inbox/handout.pdf', originalFileName: 'handout.pdf', receivedAt: 'now' } };
    await handler(job);

    expect(buildSolutionMarkdown).not.toHaveBeenCalled();
    expect(renderSolutionPdf).not.toHaveBeenCalled();
    expect(writeResult).toHaveBeenCalledWith(
      MATERIAL_RESULT,
      { kind: 'material', sourcePath: '/inbox/handout.pdf' },
      expect.any(String),
    );
  });

  it('archives the source into the failed dir and rethrows when extraction fails', async () => {
    extractFile.mockRejectedValue(new Error('ocrmypdf blew up'));

    const { createFileJobWorker } = await import('../src/worker/index.js');
    const { Worker } = await import('bullmq');
    createFileJobWorker();

    const handler = vi.mocked(Worker).mock.calls[0][1] as (job: unknown) => Promise<void>;
    const job = { id: '1', data: { filePath: '/inbox/arbeitsblatt1.pdf', originalFileName: 'arbeitsblatt1.pdf', receivedAt: 'now' } };

    await expect(handler(job)).rejects.toThrow('ocrmypdf blew up');

    expect(writeResult).not.toHaveBeenCalled();
    const [, movedTo] = rename.mock.calls[0] as [string, string];
    expect(movedTo).toMatch(/[/\\]\.failed[/\\]\d+-arbeitsblatt1\.pdf$/);
  });

  it('cleans up a zip-extraction staging directory after archiving the file it contained', async () => {
    extractFile.mockResolvedValue({ markdown: '# text', visionPages: [], ranOcr: false, archivalPdfPath: '/inbox/.staging/uuid-1/a.md' });
    processFile.mockResolvedValue({ ...MATERIAL_RESULT, originalFileName: 'a.md' });
    writeResult.mockResolvedValue({ writtenPath: '/data/x.md' });

    const { createFileJobWorker } = await import('../src/worker/index.js');
    const { Worker } = await import('bullmq');
    createFileJobWorker();

    const handler = vi.mocked(Worker).mock.calls[0][1] as (job: unknown) => Promise<void>;
    const job = { id: '1', data: { filePath: '/inbox/.staging/uuid-1/a.md', originalFileName: 'a.md', receivedAt: 'now' } };
    await handler(job);

    expect(rmdir).toHaveBeenCalledWith('/inbox/.staging/uuid-1');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- test/worker.test.ts`
Expected: FAIL — old `handleJob` reads the file directly and calls the old `processFile`/`writeResult` shapes.

- [ ] **Step 3: Rewrite `src/worker/index.ts`**

```ts
// src/worker/index.ts
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Worker, type Job } from 'bullmq';
import pino from 'pino';
import { QUEUE_NAME, getRedisConnection, type FileJobData } from '../queue/index.js';
import { extractFile } from '../extract/index.js';
import { createFileProcessor } from '../claude/processFile.js';
import { buildSolutionMarkdown } from '../pdf/buildMarkdown.js';
import { renderSolutionPdf } from '../pdf/renderPdf.js';
import { createNextcloudWriter } from '../nextcloud/writeResult.js';
import { config } from '../config/index.js';
import type { NextcloudWriteContent } from '../types.js';

const logger = pino({ name: 'worker' });

const fileProcessor = createFileProcessor();
const nextcloudWriter = createNextcloudWriter();

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

async function archiveFile(filePath: string, dirName: string): Promise<void> {
  const watchDir = path.resolve(config.ingest.watchDir);
  const destDir = path.join(watchDir, dirName);
  await fs.mkdir(destDir, { recursive: true });
  const dest = path.join(destDir, `${Date.now()}-${path.basename(filePath)}`);
  await fs.rename(filePath, dest);

  const sourceDir = path.dirname(filePath);
  if (sourceDir !== watchDir) {
    await fs.rmdir(sourceDir).catch(() => undefined);
  }
}

async function handleJob(job: Job<FileJobData>): Promise<void> {
  const { filePath, originalFileName } = job.data;
  logger.info({ jobId: job.id, filePath, originalFileName }, 'processing file job');

  let archivalPath = filePath;
  try {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'extract-'));
    const extraction = await extractFile(filePath, workDir);
    archivalPath = extraction.archivalPdfPath;

    const result = await fileProcessor.processFile(originalFileName, extraction);
    const datum = today();

    let content: NextcloudWriteContent;
    if (result.isMaterialblatt) {
      content = { kind: 'material', sourcePath: extraction.archivalPdfPath };
    } else {
      const markdown = buildSolutionMarkdown(result, datum);
      const pdfBytes = await renderSolutionPdf(markdown);
      content = { kind: 'pdf', bytes: pdfBytes };
    }

    const { writtenPath } = await nextcloudWriter.writeResult(result, content, datum);
    await archiveFile(archivalPath, config.ingest.processedDirName);
    logger.info({ jobId: job.id, writtenPath, tasksFound: result.tasksFound.length }, 'file job complete');
  } catch (err) {
    await archiveFile(archivalPath, config.ingest.failedDirName).catch((archiveErr: unknown) => {
      logger.error({ archiveErr, filePath: archivalPath }, 'Failed to archive file after processing failure');
    });
    throw err;
  }
}

export function createFileJobWorker(): Worker<FileJobData> {
  const worker = new Worker<FileJobData>(QUEUE_NAME, handleJob, {
    connection: getRedisConnection(),
  });

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err }, 'file job failed');
  });

  return worker;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  createFileJobWorker();
  logger.info('worker started');
}
```

Note on the `archivalPath` variable: if `extractFile` throws before returning, `archivalPath` is still the original `filePath`, so the failure branch archives the source that was actually dropped (there's no OCR'd version to prefer yet). Once `extractFile` succeeds, `archivalPath` is updated to `extraction.archivalPdfPath` — matching the third worker test ("cleans up a zip-extraction staging directory") which stubs `archivalPdfPath` to the staged file's path and expects that same path's *directory* (`.staging/uuid-1`) to be `rmdir`'d.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- test/worker.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/worker/index.ts test/worker.test.ts
git commit -m "feat: wire extraction -> solve -> PDF generation/material routing -> archive in the worker"
```

---

### Task 15: Docker infra — Debian slim base, extraction/PDF toolchain

**Files:**
- Modify: `docker/Dockerfile` (full rewrite)

**Interfaces:**
- Consumes: `docker/vorlage/template.html`, `docker/vorlage/style.css` (Task 9).
- Produces: an image where `pandoc`, `ocrmypdf`, `pdftotext`/`pdftoppm`/`pdfinfo`, and a Python venv with `markitdown`+`weasyprint` are all on `PATH`/at the config-default paths from Task 2, matching `/app/.venv/bin/...` and `/app/vorlage/...`.

Alpine's `node:20-alpine` (the current base) has genuinely poor coverage for this toolchain: `ocrmypdf` and `markitdown`/`weasyprint` are Python packages whose native dependencies (Ghostscript, qpdf, Cairo/Pango for WeasyPrint) are far more reliably available as prebuilt Debian `apt` packages than via Alpine's `apk`/musl-libc combination, which has known compatibility issues with several of these C-extension-heavy wheels. Debian's `python3-venv`, `poppler-utils`, `ocrmypdf`, `tesseract-ocr-deu`/`tesseract-ocr-eng`, `pandoc`, and `fonts-liberation` are all standard `apt` packages. This task switches the runtime stage (and, for a consistent build environment, the builder stage) to `node:20-slim`.

- [ ] **Step 1: Rewrite the Dockerfile**

```dockerfile
# Multi-stage Dockerfile for teams-task-agent ingest and worker services
# Both services use the same image with different entrypoint commands (supplied via docker-compose)
#
# Debian slim (not Alpine) - ocrmypdf/markitdown/weasyprint's native dependencies (Ghostscript,
# qpdf, Cairo/Pango) are far more reliably available via apt than via Alpine's musl-libc/apk.

# === Build stage ===
FROM node:20-slim AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

# === Runtime stage ===
FROM node:20-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    poppler-utils \
    ocrmypdf \
    tesseract-ocr \
    tesseract-ocr-deu \
    tesseract-ocr-eng \
    pandoc \
    fonts-liberation \
    python3 \
    python3-venv \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

# Dedicated venv for markitdown + weasyprint - same workaround as the old schule-loesen skill
# used for weasyprint (Debian's "externally-managed-environment" blocks a bare `pip install`).
RUN python3 -m venv /app/.venv \
    && /app/.venv/bin/pip install --quiet --no-cache-dir --upgrade pip \
    && /app/.venv/bin/pip install --quiet --no-cache-dir markitdown weasyprint

RUN groupadd -g 1001 nodejs && useradd -u 1001 -g nodejs -s /bin/false nodejs

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY --from=builder /app/dist ./dist
COPY docker/vorlage ./vorlage

RUN chown -R nodejs:nodejs /app

USER nodejs

# No CMD or ENTRYPOINT here — the command is supplied via docker-compose's `command:` field
```

- [ ] **Step 2: Build the image to confirm it succeeds**

Run: `docker compose build worker`
Expected: build completes with exit code 0. This step has no unit test — it's a container build; the manual pandoc/weasyprint render from Task 9 Step 4 is the functional verification once this is done.

- [ ] **Step 3: Commit**

```bash
git add docker/Dockerfile
git commit -m "build: switch Docker base to Debian slim, add PDF/OCR/pandoc toolchain"
```

---

### Task 16: README updates

**Files:**
- Modify: `README.md`

**Interfaces:** none (documentation only).

- [ ] **Step 1: Update the README's description, layout, setup, and "known open items" sections**

Replace the opening paragraph (currently describing a generic "find open tasks/action items and draft solutions" agent) with:

```markdown
# teams-task-agent

Watches a local `__INBOX__` folder for manually-downloaded files (e.g. a zip export of a
Teams channel's files, or individual PDFs/docs — including scans and handwritten
worksheets), uses the Claude Agent SDK to solve open tasks, and files a styled solution PDF
into a per-subject Nextcloud folder tree. Automates a previously-manual workflow: read a
dropped school PDF, solve it, file it under the right subject.
```

Update the pipeline diagram to:

```
You, manually: download/export files from Teams (zip, PDF, ...)
        │
        ▼
Drop into __INBOX__ (e.g. a Nextcloud-synced directory)
        │
        ▼
Ingest watcher ── extracts zips (one job per contained file), enqueues each file
        │
        ▼
Redis queue (BullMQ)
        │
        ▼
Worker
        ├─ 1. Extract text per-page: MarkItDown (text-layer) / ocrmypdf+Tesseract (scans) /
        │      Claude vision (handwriting or still-garbled OCR)
        ├─ 2. Claude Agent SDK: classify subject, solve every task with citations
        ├─ 3. Render a styled solution PDF (pandoc + weasyprint) — or, for a pure
        │      Materialblatt (no tasks), skip straight to filing the source
        ├─ 4. Write into Nextcloud: Fächer/<Fach>/[<Lernfeld>/]<name>_Loesung_<date>.pdf
        │      + `occ files:scan`
        └─ 5. Archive the source (OCR'd searchable version if OCR ran) into `.processed/`
             (or `.failed/` on error)
```

Update the `Layout` section's `src/claude/` and `src/nextcloud/` bullets, and add bullets for `src/extract/` and `src/pdf/`:

```markdown
- `src/extract/` — per-page tiered text extraction: MarkItDown for text-layer PDFs,
  `ocrmypdf`/Tesseract for scans, rendered page images for Claude's vision fallback on
  handwriting or still-garbled OCR output.
- `src/claude/` — Claude Agent SDK integration that classifies the subject (Fach) and
  Info-/Materialblatt vs. Aufgabenblatt, and solves every task found with citations.
- `src/pdf/` — builds the solution Markdown and renders it to a styled PDF via
  `pandoc`+`weasyprint`.
- `src/nextcloud/` — writes the result into Nextcloud's data directory under
  `Fächer/<Fach>/[<Lernfeld>/]`, and triggers `occ files:scan`.
```

Update `Setup`'s `.env` instructions to mention `STUDENT_NAME`/`STUDENT_KLASSE` are required, and that `__INBOX__` is the new default watch-dir name.

Replace the `Known open items` section (the PDF-support gap is now closed) with:

```markdown
## Known open items

- `.docx` extraction is not wired up yet (MarkItDown supports it; the extraction module
  already routes by file extension, so this is a small follow-up).
- The OCR-quality gate (`isQualityText` in `src/extract/pdfText.ts`) uses a simple
  alphanumeric-ratio heuristic; a stronger check (e.g. dictionary-based) is a reasonable
  follow-up if it proves too permissive/strict in practice.
- The ingest watcher watches only the top level of `INGEST_WATCH_DIR` (no subfolders) and
  assumes a local/POSIX filesystem.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: update README for the PDF-solve pipeline"
```

---

### Task 17: Full verification

**Files:** none — this task runs the existing verification commands across the whole tree.

- [ ] **Step 1: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 2: Lint**

Run: `npm run lint`
Expected: no errors (warnings for `no-unused-vars` are acceptable only if prefixed `_`, per `eslint.config.js`).

- [ ] **Step 3: Full test suite**

Run: `npm test`
Expected: every test file passes, including the untouched `test/ingest-watcher.test.ts`.

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: compiles cleanly to `dist/`.

- [ ] **Step 5: Commit (only if any of the above required fixes)**

```bash
git add -A
git commit -m "fix: address issues found in full verification pass"
```

If nothing needed fixing, skip this commit — there's nothing to commit.

---

## Self-Review Notes

- **Spec coverage:** every section of `docs/superpowers/specs/2026-07-23-pdf-solve-pipeline-design.md` maps to a task — per-page OCR gate (Task 4/8), Materialblatt routing (Task 12/13/14), fixed Fach enum with synonym mapping (Task 2/12), Sonnet default (Task 2/12), `__INBOX__` rename (Task 2), Style E template (Task 9), pandoc escaping (Task 3/10), date-suffixed filenames (Task 13), Debian-slim + fonts (Task 15), archive-OCR'd-version (Task 14).
- **Type consistency:** `ProcessedFileResult`/`TaskSolution`/`ExtractionResult`/`VisionPage`/`NextcloudWriteContent` are defined once in Task 2 and referenced by identical name/shape in every later task — cross-checked field names (`isMaterialblatt`, `fach`, `lernfeld`, `thema`, `tasksFound`, `title`/`taskDescription`/`proposedSolution`/`quelle`) across Tasks 10, 12, 13, 14.
- **Known residual risk (flagged, not hidden):** the exact structural shape Task 12's `buildVisionPrompt` needs for `ImageBlockParam`/`TextBlockParam` was verified against the installed `@anthropic-ai/sdk` type defs (`source: Base64ImageSource | URLImageSource`, `Base64ImageSource: { data, media_type, type: 'base64' }`) but not compiled end-to-end during planning — Task 12 Step 5 explicitly calls out `npm run typecheck` as the checkpoint and instructs adjusting literal fields (not `as any`) if needed.
