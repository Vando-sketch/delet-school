# OCR-Quality Dictionary Gate + Subfolder Ingest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve the two remaining "Known open items" in `README.md`: replace the OCR-quality gate's alphanumeric-ratio heuristic with a real-word dictionary check, and let the ingest watcher recurse into subfolders of `INGEST_WATCH_DIR` while fixing the `fs.rename` cross-filesystem assumption that top-level-only watching let go unnoticed.

**Architecture:** A new `src/extract/dictionary.ts` module parses hunspell DE/EN word lists (installed via apt in the Docker image) into an in-memory `Set`, consumed by `src/extract/pdfText.ts`'s quality gate as a dependency-injectable `WordValidator`, alongside the existing alphanumeric-ratio check kept as a safety net. Separately, `src/ingest/watcher.ts` drops chokidar's `depth: 0`, switches its ignored-directory matching to per-path-segment (correct at any depth), and a new shared `src/lib/renameOrCopy.ts` helper (used by both `watcher.ts` and `worker/index.ts`) makes the existing archive-move `EXDEV`-safe.

**Tech Stack:** Node 20/TypeScript (existing), `hunspell-de-de`/`hunspell-en-us` (new apt packages), vitest (existing DI-mock test patterns).

## Global Constraints

- Spec source of truth: `docs/superpowers/specs/2026-07-24-ocr-quality-and-subfolder-ingest-design.md` (note: file is dated `2026-07-23` — matches the day it was written).
- `npm run typecheck` / `npm run lint` / `npm test` must all pass before opening a PR (repo `CLAUDE.md`).
- Every task follows TDD: write the failing test, watch it fail, implement, watch it pass, commit.
- New filesystem-touching modules use dependency injection for testability (matches the existing `ExecFileFn`-injection pattern in `src/lib/execFile.ts` and `src/nextcloud/writeResult.ts`'s `NextcloudWriterDeps`) — no test ever touches a real hunspell dictionary file or triggers a real cross-filesystem rename.
- No comments explaining *what* code does — only non-obvious *why* (matches existing codebase style).
- The two parts of this plan (dictionary gate: Tasks 1-3; subfolder ingest: Tasks 4-6) touch entirely different files and have no dependency on each other — they may be implemented in either order, or in parallel by different workers.

---

## File Structure

```
src/
  extract/
    dictionary.ts       NEW   loadWordSet() + buildWordValidator() - hunspell .dic parsing
    pdfText.ts           MODIFIED  isQualityText/hasQualityAlphanumericRatio gain the
                                    dictionary-ratio-or-alphanumeric-ratio check
  config/index.ts        MODIFIED  new config.dictionary.{deDicPath,enDicPath}
  lib/
    renameOrCopy.ts     NEW   EXDEV-safe fs.rename wrapper, shared by watcher.ts/worker/index.ts
  ingest/
    watcher.ts            MODIFIED  depth:0 removed, segment-based ignored matching,
                                    relative-path originalFileName, uses renameOrCopy
  worker/index.ts         MODIFIED  archiveFile uses renameOrCopy
docker/Dockerfile         MODIFIED  adds hunspell-de-de, hunspell-en-us
.env.example               MODIFIED  documents HUNSPELL_DE_DIC_PATH/HUNSPELL_EN_DIC_PATH
README.md                  MODIFIED  removes the two now-resolved "Known open items" bullets
test/
  extract/
    dictionary.test.ts   NEW
    pdfText.test.ts       MODIFIED  existing 3 cases updated + 3 new cases
  lib/
    renameOrCopy.test.ts NEW
  ingest-watcher.test.ts   MODIFIED  3 new cases (subfolder file, nested ignored dir, zip-in-subfolder)
```

---

### Task 1: Dictionary loader module + config

**Files:**
- Create: `src/extract/dictionary.ts`
- Modify: `src/config/index.ts` (add a `dictionary` section)
- Modify: `.env.example` (document the two new optional env vars)
- Test: `test/extract/dictionary.test.ts`

**Interfaces:**
- Consumes: `FACH_KEYS` from `src/fach.ts` (existing).
- Produces: `type WordValidator = (word: string) => boolean`, `loadWordSet(deps?: { readFileSync?: (path: string) => string; dicPaths?: string[] }): Set<string>`, `buildWordValidator(words: Set<string>): WordValidator` — all consumed by Task 2 (`src/extract/pdfText.ts`).

- [ ] **Step 1: Write the failing test**

```ts
// test/extract/dictionary.test.ts
import { describe, expect, it } from 'vitest';
import { buildWordValidator, loadWordSet } from '../../src/extract/dictionary.js';

describe('loadWordSet', () => {
  it('parses word/affix-flag lines into a lowercase Set, skipping the hunspell word-count header line', () => {
    const fakeFiles: Record<string, string> = {
      '/fake/de.dic': '3\nKaufvertrag/S\nMangel\nHaus/PLe',
      '/fake/en.dic': '1\nContract',
    };
    const readFileSync = (path: string) => {
      const contents = fakeFiles[path];
      if (contents === undefined) throw new Error(`unexpected path: ${path}`);
      return contents;
    };

    const words = loadWordSet({ readFileSync, dicPaths: ['/fake/de.dic', '/fake/en.dic'] });

    expect(words.has('kaufvertrag')).toBe(true);
    expect(words.has('mangel')).toBe(true);
    expect(words.has('haus')).toBe(true);
    expect(words.has('contract')).toBe(true);
  });

  it('includes the domain whitelist (Fach codes and legal abbreviations)', () => {
    const readFileSync = () => '0\n';
    const words = loadWordSet({ readFileSync, dicPaths: ['/fake/empty.dic'] });

    expect(words.has('bgwp')).toBe(true);
    expect(words.has('bgb')).toBe(true);
  });
});

describe('buildWordValidator', () => {
  it('looks up words case-insensitively', () => {
    const isRealWord = buildWordValidator(new Set(['kaufvertrag']));
    expect(isRealWord('Kaufvertrag')).toBe(true);
    expect(isRealWord('KAUFVERTRAG')).toBe(true);
    expect(isRealWord('unknownword')).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- test/extract/dictionary.test.ts`
Expected: FAIL with "Cannot find module '../../src/extract/dictionary.js'".

- [ ] **Step 3: Add the config section**

In `src/config/index.ts`, add after the existing `pandoc:` block, before the closing `};`:

```ts
  dictionary: {
    deDicPath: optional('HUNSPELL_DE_DIC_PATH', '/usr/share/hunspell/de_DE.dic'),
    enDicPath: optional('HUNSPELL_EN_DIC_PATH', '/usr/share/hunspell/en_US.dic'),
  },
```

- [ ] **Step 4: Create `src/extract/dictionary.ts`**

```ts
// src/extract/dictionary.ts
import { readFileSync } from 'node:fs';
import { config } from '../config/index.js';
import { FACH_KEYS } from '../fach.js';

export type WordValidator = (word: string) => boolean;

// Subject codes and legal-citation abbreviations are expected, legitimate vocabulary in this
// document domain but won't appear in a general dictionary.
const DOMAIN_WHITELIST = [...FACH_KEYS.map((key) => key.toLowerCase()), 'bgb', 'lf', 'gg', 'stgb', 'hgb'];

export interface LoadWordSetDeps {
  readFileSync?: (path: string) => string;
  dicPaths?: string[];
}

/**
 * Parses hunspell .dic files (plain `word/AFFIXFLAGS` lines, first line is a word count) into
 * a flat Set - affix rules are irrelevant here, this is a coarse "known word" lookup, not a
 * spellchecker, so inflected forms not listed verbatim in the .dic file are undercounted. That
 * is an accepted tradeoff given the dictionary ratio's 0.45 threshold (see pdfText.ts).
 */
export function loadWordSet(deps: LoadWordSetDeps = {}): Set<string> {
  const read = deps.readFileSync ?? ((path: string) => readFileSync(path, 'utf-8'));
  const dicPaths = deps.dicPaths ?? [config.dictionary.deDicPath, config.dictionary.enDicPath];

  const words = new Set<string>(DOMAIN_WHITELIST);
  for (const dicPath of dicPaths) {
    const contents = read(dicPath);
    const lines = contents.split('\n').slice(1); // first line is hunspell's word count
    for (const line of lines) {
      const word = line.split('/')[0]?.trim().toLowerCase();
      if (word) words.add(word);
    }
  }
  return words;
}

export function buildWordValidator(words: Set<string>): WordValidator {
  return (word: string) => words.has(word.toLowerCase());
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- test/extract/dictionary.test.ts`
Expected: PASS, all 3 tests green.

- [ ] **Step 6: Document the new env vars**

In `.env.example`, add after the `WEASYPRINT_BIN=` line:

```
# Dictionaries for the OCR-quality gate's real-word check (src/extract/dictionary.ts) -
# installed via apt (hunspell-de-de, hunspell-en-us) at these standard Debian paths in the
# Docker image; only need overriding for local (non-Docker) runs.
HUNSPELL_DE_DIC_PATH=/usr/share/hunspell/de_DE.dic
HUNSPELL_EN_DIC_PATH=/usr/share/hunspell/en_US.dic
```

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/extract/dictionary.ts src/config/index.ts .env.example test/extract/dictionary.test.ts
git commit -m "feat: add hunspell dictionary loader for the OCR-quality gate"
```

---

### Task 2: Wire the dictionary check into the OCR-quality gate

**Files:**
- Modify: `src/extract/pdfText.ts`
- Modify: `test/extract/pdfText.test.ts`

**Interfaces:**
- Consumes: `WordValidator`, `loadWordSet`, `buildWordValidator` from Task 1 (`src/extract/dictionary.ts`).
- Produces: `isQualityText(text: string, isRealWord?: WordValidator): boolean`, `hasQualityAlphanumericRatio(text: string, isRealWord?: WordValidator): boolean` — same names/return type as today, with an added optional second parameter. Existing 1-argument callers (`src/extract/index.ts`'s `ExtractDeps.isQualityText`, `src/ingest/siblingManifest.ts`'s two `hasQualityAlphanumericRatio(raw)` calls) need no changes — TypeScript allows calling a function with fewer arguments than its optional-parameter signature allows.

- [ ] **Step 1: Rewrite the test file**

Replace the full contents of `test/extract/pdfText.test.ts`:

```ts
// test/extract/pdfText.test.ts
import { describe, expect, it } from 'vitest';
import { getPageText, getPdfPageCount, hasQualityAlphanumericRatio, isQualityText } from '../../src/extract/pdfText.js';

describe('isQualityText', () => {
  it('rejects text under the minimum character threshold', () => {
    expect(isQualityText('too short', () => true)).toBe(false);
  });

  it('accepts long, mostly-alphanumeric prose via the dictionary ratio', () => {
    const prose =
      'Der Käufer kann gemäß Paragraph 437 BGB zunächst Nacherfüllung verlangen, ' +
      'wenn die gelieferte Ware einen Sachmangel aufweist und die Gewährleistung greift.';
    const isRealWord = (word: string) => word.length >= 2; // every real word here is >=2 chars
    expect(isQualityText(prose, isRealWord)).toBe(true);
  });

  it('rejects long OCR gibberish even though it clears the character-count threshold', () => {
    const gibberish = 'l|i1l!! O0--_x~~ '.repeat(10);
    // Every "word" here is a single stray letter (length 1, filtered out by tokenization), so
    // the dictionary check has zero qualifying tokens regardless of the validator; the
    // alphanumeric-ratio safety net also fails (~47% alphanumeric, under the 0.6 threshold).
    expect(isQualityText(gibberish, () => false)).toBe(false);
  });

  it('passes a formula/citation-style line via the alphanumeric-ratio safety net, even when no token is a recognized word', () => {
    // 60 word-shaped tokens ("xy", "cd"), no symbols at all - alphanumeric ratio is 100%, well
    // over the 0.6 safety-net threshold, even though the dictionary check fails outright.
    const formulaLike = 'xy cd '.repeat(30);
    expect(isQualityText(formulaLike, () => false)).toBe(true);
  });

  it('rejects a line with word-shaped tokens but heavy symbol noise when none are recognized words', () => {
    // Each unit is "xy" (2 real alphanumeric chars) plus 4 symbol chars - alphanumeric ratio is
    // ~33%, under 0.6, and the dictionary check fails too (validator recognizes nothing).
    const symbolHeavy = 'xy!!!! '.repeat(20);
    expect(isQualityText(symbolHeavy, () => false)).toBe(false);
  });
});

describe('hasQualityAlphanumericRatio', () => {
  it('applies the same dictionary-or-alphanumeric-ratio check without the MIN_CHARS gate', () => {
    const isRealWord = (word: string) => word.length >= 2;
    expect(hasQualityAlphanumericRatio('Kaufvertrag', isRealWord)).toBe(true);
    expect(hasQualityAlphanumericRatio('', isRealWord)).toBe(false);
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

Run: `npm run typecheck`
Expected: FAIL — `isQualityText`/`hasQualityAlphanumericRatio` don't yet accept a second argument (TS error "Expected 1 arguments, but got 2").

- [ ] **Step 3: Rewrite `src/extract/pdfText.ts`**

Replace the full file contents:

```ts
// src/extract/pdfText.ts
import pino from 'pino';
import { config } from '../config/index.js';
import { defaultExecFile, type ExecFileFn } from '../lib/execFile.js';
import { buildWordValidator, loadWordSet, type WordValidator } from './dictionary.js';

const logger = pino({ name: 'extract-pdfText' });

const MIN_CHARS = 100;
const MIN_REAL_WORD_RATIO = 0.45;
const MIN_ALPHANUMERIC_RATIO = 0.6;
const TOKEN_PATTERN = /\p{L}+/gu;
const ALPHANUMERIC_PATTERN = /[\p{L}\p{N}]/gu;

let cachedDefaultIsRealWord: WordValidator | undefined;

/**
 * Lazily built so importing this module never touches the filesystem - unit tests always pass
 * their own WordValidator and never reach this path. Falls back to an always-true validator
 * when the hunspell dictionaries aren't installed (true everywhere except the production
 * Docker image - see docker/Dockerfile) so quality gating degrades to the alphanumeric-ratio
 * check alone, matching this heuristic's pre-dictionary behavior rather than crashing.
 */
function getDefaultIsRealWord(): WordValidator {
  if (!cachedDefaultIsRealWord) {
    try {
      cachedDefaultIsRealWord = buildWordValidator(loadWordSet());
    } catch (err) {
      logger.warn(
        { err },
        'Could not load hunspell dictionaries; OCR-quality gate falls back to the alphanumeric-ratio check only',
      );
      cachedDefaultIsRealWord = () => true;
    }
  }
  return cachedDefaultIsRealWord;
}

function tokenize(text: string): string[] {
  return (text.match(TOKEN_PATTERN) ?? []).filter((token) => token.length >= 2);
}

function dictionaryRatioPasses(text: string, isRealWord: WordValidator): boolean {
  const tokens = tokenize(text);
  if (tokens.length === 0) return false;
  const realWordCount = tokens.filter((token) => isRealWord(token)).length;
  return realWordCount / tokens.length >= MIN_REAL_WORD_RATIO;
}

function alphanumericRatioPasses(text: string): boolean {
  const nonWhitespace = text.replace(/\s/g, '');
  if (nonWhitespace.length === 0) return false;
  const alphanumericCount = (nonWhitespace.match(ALPHANUMERIC_PATTERN) ?? []).length;
  return alphanumericCount / nonWhitespace.length >= MIN_ALPHANUMERIC_RATIO;
}

/**
 * Cheap proxy for "is this actual language, or OCR/handwriting garbage" - raw character count
 * alone isn't enough (Tesseract garbage like "l|i1l!! O0--_x~~" easily clears 100 chars).
 * Passes if either a real-word dictionary ratio or the (unchanged) alphanumeric-ratio check
 * passes - the latter acts as a safety net for formula/table/citation-heavy pages that have
 * few recognizable dictionary words but aren't OCR noise. See
 * docs/superpowers/specs/2026-07-24-ocr-quality-and-subfolder-ingest-design.md.
 */
export function isQualityText(text: string, isRealWord: WordValidator = getDefaultIsRealWord()): boolean {
  const nonWhitespace = text.replace(/\s/g, '');
  if (nonWhitespace.length < MIN_CHARS) return false;
  return dictionaryRatioPasses(text, isRealWord) || alphanumericRatioPasses(text);
}

/**
 * Same dictionary-ratio-or-alphanumeric-ratio check as isQualityText, without its MIN_CHARS
 * page-length gate - for callers judging a short, deliberate excerpt (e.g. a one-line document
 * header) rather than a full page, where "too short to tell" shouldn't be conflated with
 * "garbled."
 */
export function hasQualityAlphanumericRatio(
  text: string,
  isRealWord: WordValidator = getDefaultIsRealWord(),
): boolean {
  const nonWhitespace = text.replace(/\s/g, '');
  if (nonWhitespace.length === 0) return false;
  return dictionaryRatioPasses(text, isRealWord) || alphanumericRatioPasses(text);
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
Expected: PASS, all 9 tests green.

- [ ] **Step 5: Run the full suite to confirm no regressions in callers**

Run: `npm test`
Expected: all tests pass, including `test/ingest/siblingManifest.test.ts` and `test/extract/index.test.ts`, whose `isQualityText`/`hasQualityAlphanumericRatio` stubs still satisfy the new (optional second-parameter) signature unchanged.

- [ ] **Step 6: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: both exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/extract/pdfText.ts test/extract/pdfText.test.ts
git commit -m "feat: replace the alphanumeric-only OCR-quality gate with a dictionary check"
```

---

### Task 3: Install hunspell dictionaries in the Docker image

**Files:**
- Modify: `docker/Dockerfile`

**Interfaces:**
- Consumes: nothing new.
- Produces: `/usr/share/hunspell/de_DE.dic` and `/usr/share/hunspell/en_US.dic` inside the runtime image, matching `config.dictionary.deDicPath`/`.enDicPath`'s defaults from Task 1.

- [ ] **Step 1: Add the apt packages**

In `docker/Dockerfile`, in the runtime stage's `apt-get install` list, add `hunspell-de-de` and `hunspell-en-us` after `tesseract-ocr-eng`:

```dockerfile
RUN apt-get update && apt-get install -y --no-install-recommends \
    poppler-utils \
    ocrmypdf \
    tesseract-ocr \
    tesseract-ocr-deu \
    tesseract-ocr-eng \
    hunspell-de-de \
    hunspell-en-us \
    pandoc \
    fonts-liberation \
    python3 \
    python3-venv \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*
```

- [ ] **Step 2: Build the image**

Run: `docker build -f docker/Dockerfile -t delet-school-hunspell-test .`
Expected: build succeeds (exit code 0). This installs the full toolchain (poppler, ocrmypdf, tesseract, pandoc, the Python venv for markitdown/weasyprint) so it can take a few minutes on a cold Docker build cache.

- [ ] **Step 3: Verify the dictionary files exist in the built image**

Run: `docker run --rm delet-school-hunspell-test ls /usr/share/hunspell/de_DE.dic /usr/share/hunspell/en_US.dic`
Expected: both paths printed, exit code 0 (no ENTRYPOINT/CMD is set in this Dockerfile, so the image accepts `ls ...` directly as its run command).

- [ ] **Step 4: Commit**

```bash
git add docker/Dockerfile
git commit -m "feat: install hunspell DE/EN dictionaries in the runtime image"
```

---

### Task 4: Shared `renameOrCopy` helper

**Files:**
- Create: `src/lib/renameOrCopy.ts`
- Test: `test/lib/renameOrCopy.test.ts`

**Interfaces:**
- Produces: `renameOrCopy(src: string, dest: string, deps?: { rename?: (src: string, dest: string) => Promise<void>; copyFile?: (src: string, dest: string) => Promise<void>; unlink?: (path: string) => Promise<void> }): Promise<void>` — consumed by Task 5 (`src/ingest/watcher.ts`, `src/worker/index.ts`).

- [ ] **Step 1: Write the failing tests**

```ts
// test/lib/renameOrCopy.test.ts
import { describe, expect, it, vi } from 'vitest';
import { renameOrCopy } from '../../src/lib/renameOrCopy.js';

function exdevError(): NodeJS.ErrnoException {
  const err = new Error('cross-device link not permitted') as NodeJS.ErrnoException;
  err.code = 'EXDEV';
  return err;
}

describe('renameOrCopy', () => {
  it('delegates to rename when the destination is on the same filesystem', async () => {
    const rename = vi.fn().mockResolvedValue(undefined);
    const copyFile = vi.fn();
    const unlink = vi.fn();

    await renameOrCopy('/src/a.pdf', '/dest/a.pdf', { rename, copyFile, unlink });

    expect(rename).toHaveBeenCalledWith('/src/a.pdf', '/dest/a.pdf');
    expect(copyFile).not.toHaveBeenCalled();
    expect(unlink).not.toHaveBeenCalled();
  });

  it('falls back to copy+unlink when rename fails with EXDEV', async () => {
    const rename = vi.fn().mockRejectedValue(exdevError());
    const copyFile = vi.fn().mockResolvedValue(undefined);
    const unlink = vi.fn().mockResolvedValue(undefined);

    await renameOrCopy('/src/a.pdf', '/dest/a.pdf', { rename, copyFile, unlink });

    expect(copyFile).toHaveBeenCalledWith('/src/a.pdf', '/dest/a.pdf');
    expect(unlink).toHaveBeenCalledWith('/src/a.pdf');
  });

  it('propagates a non-EXDEV rename failure instead of falling back', async () => {
    const rename = vi.fn().mockRejectedValue(new Error('permission denied'));
    const copyFile = vi.fn();

    await expect(renameOrCopy('/src/a.pdf', '/dest/a.pdf', { rename, copyFile })).rejects.toThrow(
      'permission denied',
    );
    expect(copyFile).not.toHaveBeenCalled();
  });

  it('actually moves a file across real directories on the local filesystem (no injected deps)', async () => {
    const os = await import('node:os');
    const path = await import('node:path');
    const fs = await import('node:fs/promises');
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rename-or-copy-test-'));
    const src = path.join(tmpDir, 'a.txt');
    const dest = path.join(tmpDir, 'b.txt');
    await fs.writeFile(src, 'hello');

    await renameOrCopy(src, dest);

    expect(await fs.readFile(dest, 'utf-8')).toBe('hello');
    await expect(fs.stat(src)).rejects.toThrow();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- test/lib/renameOrCopy.test.ts`
Expected: FAIL with "Cannot find module '../../src/lib/renameOrCopy.js'".

- [ ] **Step 3: Implement**

```ts
// src/lib/renameOrCopy.ts
import { promises as fs } from 'node:fs';

export interface RenameOrCopyDeps {
  rename?: (src: string, dest: string) => Promise<void>;
  copyFile?: (src: string, dest: string) => Promise<void>;
  unlink?: (path: string) => Promise<void>;
}

/**
 * fs.rename() requires source and destination to be on the same filesystem/mount and throws
 * EXDEV otherwise (POSIX rename(2) semantics) - harmless while every archive destination lives
 * under one bind mount, but not once files can be dropped into arbitrary subfolders that might
 * span mounts. Falls back to copy+unlink only for that specific error; any other rename
 * failure still surfaces as-is.
 */
export async function renameOrCopy(src: string, dest: string, deps: RenameOrCopyDeps = {}): Promise<void> {
  const rename = deps.rename ?? fs.rename;
  const copyFile = deps.copyFile ?? fs.copyFile;
  const unlink = deps.unlink ?? fs.unlink;

  try {
    await rename(src, dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    await copyFile(src, dest);
    await unlink(src);
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- test/lib/renameOrCopy.test.ts`
Expected: PASS, all 4 tests green.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/renameOrCopy.ts test/lib/renameOrCopy.test.ts
git commit -m "feat: add EXDEV-safe rename-or-copy helper for cross-filesystem archiving"
```

---

### Task 5: Use `renameOrCopy` in both archive functions

**Files:**
- Modify: `src/ingest/watcher.ts:78-84` (`archiveFile`)
- Modify: `src/worker/index.ts:24-35` (`archiveFile`)

**Interfaces:**
- Consumes: `renameOrCopy` from Task 4 (`src/lib/renameOrCopy.ts`).
- Produces: no interface change — both `archiveFile` functions keep their existing signatures; this task only swaps their internal `fs.rename` call for `renameOrCopy`.

- [ ] **Step 1: Update `src/ingest/watcher.ts`**

Add the import near the top, with the other relative imports:

```ts
import { renameOrCopy } from '../lib/renameOrCopy.js';
```

Replace the `archiveFile` function:

```ts
/** Moves a fully-handled file into `watchDir/dirName`, timestamp-prefixed to avoid collisions. */
async function archiveFile(watchDir: string, filePath: string, dirName: string): Promise<void> {
  const destDir = path.join(watchDir, dirName);
  await fs.mkdir(destDir, { recursive: true });
  const dest = path.join(destDir, `${Date.now()}-${path.basename(filePath)}`);
  await renameOrCopy(filePath, dest);
}
```

- [ ] **Step 2: Update `src/worker/index.ts`**

Add the import near the top, with the other relative imports:

```ts
import { renameOrCopy } from '../lib/renameOrCopy.js';
```

Replace the `archiveFile` function:

```ts
async function archiveFile(filePath: string, dirName: string): Promise<void> {
  const watchDir = path.resolve(config.ingest.watchDir);
  const destDir = path.join(watchDir, dirName);
  await fs.mkdir(destDir, { recursive: true });
  const dest = path.join(destDir, `${Date.now()}-${path.basename(filePath)}`);
  await renameOrCopy(filePath, dest);

  const sourceDir = path.dirname(filePath);
  if (sourceDir !== watchDir) {
    await fs.rmdir(sourceDir).catch(() => undefined);
  }
}
```

- [ ] **Step 3: Run the full test suite to confirm this refactor is behavior-preserving**

Run: `npm test`
Expected: all tests pass unchanged, in particular `test/worker.test.ts` (its `vi.mock('node:fs', ...)` intercepts `renameOrCopy`'s internal default `fs.rename` too, since both modules resolve the same mocked `node:fs` — so the existing `expect(rename).toHaveBeenCalledWith(...)` assertions there keep working with no test changes) and `test/ingest-watcher.test.ts` (uses real files, unaffected by the internal refactor).

- [ ] **Step 4: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: both exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/ingest/watcher.ts src/worker/index.ts
git commit -m "refactor: archive files via the EXDEV-safe renameOrCopy helper"
```

---

### Task 6: Recursive subfolder watching, segment-based ignore matching, relative-path naming

**Files:**
- Modify: `src/ingest/watcher.ts` (the `chokidarWatch` options, `handlePlainFile`, `handleZip`, the `add` listener)
- Modify: `test/ingest-watcher.test.ts` (3 new cases)

**Interfaces:**
- Consumes: nothing new (uses existing `path`, `config.ingest.*` already imported in `watcher.ts`).
- Produces: no exported-signature change — `createIngestWatcher()`'s public shape is untouched. Internally, `handlePlainFile` gains a `watchDir` parameter and both it and `handleZip` now produce `originalFileName` values that are paths relative to `watchDir` instead of bare basenames.

- [ ] **Step 1: Write the new failing tests**

Add to `test/ingest-watcher.test.ts`, after the existing `'does not re-enqueue files already sitting in .processed/.failed/.staging'` test (still inside the outer `describe('createIngestWatcher', ...)` block, before its closing `});`):

```ts
  it('enqueues a job for a file dropped into a subfolder, using its relative path as originalFileName', async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    watcher = createIngestWatcher({ queue: { add }, watchDir: tmpDir });
    await new Promise<void>((resolve) => watcher?.once('ready', resolve));

    await fs.mkdir(path.join(tmpDir, 'Mathe'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'Mathe', 'AB1.pdf'), 'content');

    await waitFor(() => add.mock.calls.length >= 1);

    expect(add).toHaveBeenCalledWith(
      'process-file',
      expect.objectContaining({
        filePath: path.join(tmpDir, 'Mathe', 'AB1.pdf'),
        originalFileName: path.join('Mathe', 'AB1.pdf'),
      }),
    );
  });

  it('ignores a .processed directory nested under a subfolder, not just at the top level', async () => {
    await fs.mkdir(path.join(tmpDir, 'Mathe', '.processed'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'Mathe', '.processed', 'old-result.pdf'), 'already handled');

    const add = vi.fn().mockResolvedValue(undefined);
    watcher = createIngestWatcher({ queue: { add }, watchDir: tmpDir });
    await new Promise<void>((resolve) => watcher?.once('ready', resolve));

    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(add).not.toHaveBeenCalled();
  });

  it('prefixes extracted zip-content originalFileName with the subfolder the zip itself was dropped into', async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    watcher = createIngestWatcher({ queue: { add }, watchDir: tmpDir });
    await new Promise<void>((resolve) => watcher?.once('ready', resolve));

    await fs.mkdir(path.join(tmpDir, 'Mathe'), { recursive: true });
    const zip = new AdmZip();
    zip.addFile('a.txt', Buffer.from('file a'));
    zip.addFile('b.txt', Buffer.from('file b'));
    zip.writeZip(path.join(tmpDir, 'Mathe', 'export.zip'));

    await waitFor(() => add.mock.calls.length >= 2);

    const enqueuedNames = (add.mock.calls as [string, { originalFileName: string }][])
      .map(([, data]) => data.originalFileName)
      .sort();
    expect(enqueuedNames).toEqual([path.join('Mathe', 'a.txt'), path.join('Mathe', 'b.txt')]);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- test/ingest-watcher.test.ts`
Expected: FAIL — the subfolder file is never picked up (`depth: 0` still in place) and, once it is, `originalFileName` is still a bare basename, not a relative path.

- [ ] **Step 3: Update the `chokidarWatch` options in `src/ingest/watcher.ts`**

Replace:

```ts
  const ignoredDirs = [config.ingest.processedDirName, config.ingest.failedDirName, config.ingest.stagingDirName].map(
    (name) => path.join(watchDir, name),
  );

  const watcher = chokidarWatch(watchDir, {
    ignoreInitial: false,
    // Top-level dot-directories (.processed/.failed/.staging) hold this watcher's own
    // output and must never be re-ingested.
    ignored: (candidate) => ignoredDirs.some((dir) => candidate === dir || candidate.startsWith(dir + path.sep)),
    // Files land here via copy/upload/sync, which can take a moment; wait for the file
    // size to stop changing before treating it as "added" so partial files aren't ingested.
    awaitWriteFinish: {
      stabilityThreshold: config.ingest.stabilityThresholdMs,
      pollInterval: 100,
    },
    depth: 0,
  });
```

with:

```ts
  const ignoredNames = new Set([
    config.ingest.processedDirName,
    config.ingest.failedDirName,
    config.ingest.stagingDirName,
  ]);

  const watcher = chokidarWatch(watchDir, {
    ignoreInitial: false,
    // .processed/.failed/.staging hold this watcher's own output and must never be
    // re-ingested, wherever they occur - not just at the top level, now that subfolders are
    // watched too.
    ignored: (candidate) => {
      const rel = path.relative(watchDir, candidate);
      return rel.split(path.sep).some((segment) => ignoredNames.has(segment));
    },
    // Files land here via copy/upload/sync, which can take a moment; wait for the file
    // size to stop changing before treating it as "added" so partial files aren't ingested.
    awaitWriteFinish: {
      stabilityThreshold: config.ingest.stabilityThresholdMs,
      pollInterval: 100,
    },
  });
```

- [ ] **Step 4: Update `handlePlainFile` and its call site**

Replace:

```ts
async function handlePlainFile(queue: FileJobQueueLike, filePath: string): Promise<void> {
  await enqueueFile(queue, filePath, path.basename(filePath));
}
```

with:

```ts
async function handlePlainFile(queue: FileJobQueueLike, watchDir: string, filePath: string): Promise<void> {
  await enqueueFile(queue, filePath, path.relative(watchDir, filePath));
}
```

Replace the `add` listener:

```ts
  watcher.on('add', (filePath) => {
    void (isZipFile(filePath) ? handleZip(queue, watchDir, filePath) : handlePlainFile(queue, filePath)).catch(
      (err: unknown) => {
        logger.error({ err, filePath }, 'Failed to ingest file');
      },
    );
  });
```

with:

```ts
  watcher.on('add', (filePath) => {
    void (isZipFile(filePath) ? handleZip(queue, watchDir, filePath) : handlePlainFile(queue, watchDir, filePath)).catch(
      (err: unknown) => {
        logger.error({ err, filePath }, 'Failed to ingest file');
      },
    );
  });
```

- [ ] **Step 5: Update `handleZip` to prefix extracted-file names with the zip's own subfolder**

Replace:

```ts
async function handleZip(queue: FileJobQueueLike, watchDir: string, zipPath: string): Promise<void> {
  const stagingDir = path.join(watchDir, config.ingest.stagingDirName, randomUUID());
  await fs.mkdir(stagingDir, { recursive: true });

  new AdmZip(zipPath).extractAllTo(stagingDir, true);

  const extractedFiles = await listFilesRecursive(stagingDir);
  if (extractedFiles.length === 0) {
    logger.warn({ zipPath }, 'Zip archive contained no files; nothing to enqueue');
  }

  // Captured once upfront, before any file in the batch can be archived away by the worker -
  // every job embeds its siblings' excerpts directly rather than reading them live off disk later.
  const batchId = randomUUID();
  const manifestByPath = await buildSiblingManifest(
    extractedFiles.map((filePath) => ({ filePath, relativeName: path.relative(stagingDir, filePath) })),
  );

  for (const filePath of extractedFiles) {
    const siblingManifest = boundSiblingManifest(
      extractedFiles
        .filter((other) => other !== filePath)
        .map((other) => manifestByPath.get(other))
        .filter((entry): entry is SiblingManifestEntry => entry !== undefined),
    );
    await enqueueFile(queue, filePath, path.relative(stagingDir, filePath), { batchId, siblingManifest });
  }

  await archiveFile(watchDir, zipPath, config.ingest.processedDirName);
}
```

with:

```ts
async function handleZip(queue: FileJobQueueLike, watchDir: string, zipPath: string): Promise<void> {
  const stagingDir = path.join(watchDir, config.ingest.stagingDirName, randomUUID());
  await fs.mkdir(stagingDir, { recursive: true });

  new AdmZip(zipPath).extractAllTo(stagingDir, true);

  const extractedFiles = await listFilesRecursive(stagingDir);
  if (extractedFiles.length === 0) {
    logger.warn({ zipPath }, 'Zip archive contained no files; nothing to enqueue');
  }

  // A zip dropped into a subfolder (e.g. watchDir/Mathe/export.zip) prefixes its own subfolder
  // path onto every extracted file's originalFileName, same rule as a plain file dropped there
  // directly - "." (zip was at the top level) contributes no prefix.
  const zipRelativeDir = path.dirname(path.relative(watchDir, zipPath));
  const namePrefix = zipRelativeDir === '.' ? '' : `${zipRelativeDir}${path.sep}`;

  // Captured once upfront, before any file in the batch can be archived away by the worker -
  // every job embeds its siblings' excerpts directly rather than reading them live off disk later.
  const batchId = randomUUID();
  const manifestByPath = await buildSiblingManifest(
    extractedFiles.map((filePath) => ({ filePath, relativeName: path.relative(stagingDir, filePath) })),
  );

  for (const filePath of extractedFiles) {
    const siblingManifest = boundSiblingManifest(
      extractedFiles
        .filter((other) => other !== filePath)
        .map((other) => manifestByPath.get(other))
        .filter((entry): entry is SiblingManifestEntry => entry !== undefined),
    );
    const originalFileName = `${namePrefix}${path.relative(stagingDir, filePath)}`;
    await enqueueFile(queue, filePath, originalFileName, { batchId, siblingManifest });
  }

  await archiveFile(watchDir, zipPath, config.ingest.processedDirName);
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test -- test/ingest-watcher.test.ts`
Expected: PASS, all 8 tests green (5 existing + 3 new).

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: all tests pass, including `test/worker.test.ts` (unaffected — it only exercises `handleJob`, not the watcher).

- [ ] **Step 8: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: both exit 0.

- [ ] **Step 9: Commit**

```bash
git add src/ingest/watcher.ts test/ingest-watcher.test.ts
git commit -m "feat: watch subfolders of INGEST_WATCH_DIR, not just the top level"
```

---

### Task 7: Full verification and README update

**Files:**
- Modify: `README.md`

**Interfaces:** none.

- [ ] **Step 1: Run the full automated suite**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all three exit 0.

- [ ] **Step 2: Update the README's "Known open items" section**

Replace:

```
## Known open items

- **Breaking change (Nextcloud config)**: The old `NEXTCLOUD_DATA_DIR`, `NEXTCLOUD_TARGET_USER`,
  and `NEXTCLOUD_OCC_BIN` environment variables are no longer supported. They have been replaced
  with `NEXTCLOUD_BASE_URL`, `NEXTCLOUD_USERNAME`, and `NEXTCLOUD_APP_PASSWORD` (WebDAV-based).
  Existing `.env` files must be updated to use the new variables.
- The OCR-quality gate (`isQualityText` in `src/extract/pdfText.ts`) uses a simple
  alphanumeric-ratio heuristic; a stronger check (e.g. dictionary-based) is a reasonable
  follow-up if it proves too permissive/strict in practice.
- The ingest watcher watches only the top level of `INGEST_WATCH_DIR` (no subfolders) and
  assumes a local/POSIX filesystem.
```

with:

```
## Known open items

- **Breaking change (Nextcloud config)**: The old `NEXTCLOUD_DATA_DIR`, `NEXTCLOUD_TARGET_USER`,
  and `NEXTCLOUD_OCC_BIN` environment variables are no longer supported. They have been replaced
  with `NEXTCLOUD_BASE_URL`, `NEXTCLOUD_USERNAME`, and `NEXTCLOUD_APP_PASSWORD` (WebDAV-based).
  Existing `.env` files must be updated to use the new variables.
- The OCR-quality gate's dictionary-ratio threshold (0.45, `src/extract/pdfText.ts`) is a
  starting point, not empirically tuned; adjusting it against real scanned/handwritten homework
  is expected follow-up once this is in regular use.
```

Also update the `Layout` section's `src/ingest/` bullet to mention subfolder support. Replace:

```
- `src/ingest/` — watches a local folder (chokidar) for dropped files; extracts zip archives
  and enqueues one job per contained file, or enqueues a single job for any other file directly.
```

with:

```
- `src/ingest/` — watches a local folder and its subfolders (chokidar) for dropped files;
  extracts zip archives and enqueues one job per contained file, or enqueues a single job for
  any other file directly.
```

- [ ] **Step 3: Confirm no stale references remain**

Run: `grep -n "alphanumeric-ratio heuristic\|only the top level" README.md`
Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: update README for the dictionary OCR gate and subfolder ingest support"
```
