### Task 2: Wire the dictionary check into the OCR-quality gate

**Files:**
- Modify: `src/extract/pdfText.ts`
- Modify: `test/extract/pdfText.test.ts`

**Interfaces:**
- Consumes: `WordValidator`, `loadWordSet`, `buildWordValidator` from Task 1 (`src/extract/dictionary.ts`).
- Produces: `isQualityText(text: string, isRealWord?: WordValidator): boolean`, `hasQualityAlphanumericRatio(text: string, isRealWord?: WordValidator): boolean` — same names/return type as today, with an added optional second parameter. Existing 1-argument callers (`src/extract/index.ts`'s `ExtractDeps.isQualityText`, `src/ingest/siblingManifest.ts`'s two `hasQualityAlphanumericRatio(raw)` calls) need no changes — TypeScript allows calling a function with fewer arguments than its optional-parameter signature allows. Also produces `buildDefaultIsRealWord(load?: () => Set<string>): WordValidator`, exported solely so its dictionary-load-failure fallback branch is directly testable (see Step 1's new test case) without depending on whether hunspell happens to be installed on the machine running the suite.

- [ ] **Step 1: Rewrite the test file**

Replace the full contents of `test/extract/pdfText.test.ts`:

```ts
// test/extract/pdfText.test.ts
import { describe, expect, it } from 'vitest';
import {
  buildDefaultIsRealWord,
  getPageText,
  getPdfPageCount,
  hasQualityAlphanumericRatio,
  isQualityText,
} from '../../src/extract/pdfText.js';

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

describe('buildDefaultIsRealWord', () => {
  it('falls back to an always-true validator when the loader throws (e.g. hunspell not installed)', () => {
    const throwingLoad = () => {
      throw new Error('ENOENT: no such file or directory');
    };
    const isRealWord = buildDefaultIsRealWord(throwingLoad);
    expect(isRealWord('anything')).toBe(true);
    expect(isRealWord('')).toBe(true);
  });

  it('uses the loaded word set to build a real validator when the loader succeeds', () => {
    const load = () => new Set(['kaufvertrag']);
    const isRealWord = buildDefaultIsRealWord(load);
    expect(isRealWord('Kaufvertrag')).toBe(true);
    expect(isRealWord('unknownword')).toBe(false);
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

/**
 * Builds the default validator from a `loadWordSet`-shaped loader, falling back to an
 * always-true validator if it throws (missing hunspell dictionaries - true everywhere except
 * the production Docker image, see docker/Dockerfile). Takes `load` as a parameter (defaulting
 * to the real `loadWordSet`) purely so tests can force the failure branch deterministically,
 * instead of relying on hunspell happening to be absent on whatever machine runs the suite.
 */
export function buildDefaultIsRealWord(load: () => Set<string> = loadWordSet): WordValidator {
  try {
    return buildWordValidator(load());
  } catch (err) {
    logger.warn(
      { err },
      'Could not load hunspell dictionaries; OCR-quality gate falls back to the alphanumeric-ratio check only',
    );
    return () => true;
  }
}

let cachedDefaultIsRealWord: WordValidator | undefined;

/** Lazily built so importing this module never touches the filesystem - unit tests always pass their own WordValidator and never reach this path. */
function getDefaultIsRealWord(): WordValidator {
  if (!cachedDefaultIsRealWord) {
    cachedDefaultIsRealWord = buildDefaultIsRealWord();
  }
  return cachedDefaultIsRealWord;
}

function tokenize(text: string): string[] {
  return (text.match(TOKEN_PATTERN) ?? []).filter((token) => token.length >= 2);
}

function dictionaryRatioPasses(text: string, isRealWord: WordValidator): boolean {
  const tokens = tokenize(text);
  if (tokens.length === 0) return false;
  // Lowercased here (not left to each WordValidator) so the ratio check has one, consistent
  // casing contract regardless of which validator is injected - buildWordValidator's own
  // lowercasing is a second, harmless layer for direct callers, not the source of truth.
  const realWordCount = tokens.filter((token) => isRealWord(token.toLowerCase())).length;
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
Expected: PASS, all 11 tests green.

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

