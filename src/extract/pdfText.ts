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

export async function getAllPagesText(
  pdfPath: string,
  pageCount: number,
  execFile: ExecFileFn = defaultExecFile,
  getPageTextFn: typeof getPageText = getPageText,
): Promise<string[]> {
  try {
    const { stdout } = await execFile(config.poppler.pdftotextBin, [pdfPath, '-']);
    const rawPages = stdout.split('\f');
    // Poppler appends a trailing \f after the last page. Pop empty trailing page if present.
    if (rawPages.length > 0 && (rawPages[rawPages.length - 1] ?? '').trim() === '') {
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
  return Promise.all(pageNumbers.map((page) => getPageTextFn(pdfPath, page, execFile)));
}

export async function getPagesWithContentImages(
  pdfPath: string,
  execFile: ExecFileFn = defaultExecFile,
): Promise<Set<number>> {
  try {
    const { stdout } = await execFile(config.poppler.pdfimagesBin, ['-list', pdfPath]);
    const pages = new Set<number>();
    const lines = stdout.split('\n');
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 5) {
        const pageNum = Number(parts[0]);
        const width = Number(parts[3]);
        const height = Number(parts[4]);
        if (!isNaN(pageNum) && !isNaN(width) && !isNaN(height)) {
          // Exclude small logo/header/footer images (e.g. <= 200x200)
          if (width >= 200 && height >= 200) {
            pages.add(pageNum);
          }
        }
      }
    }
    return pages;
  } catch (err) {
    logger.warn({ err, pdfPath }, 'pdfimages -list failed; falling back to text-only quality check');
    return new Set<number>();
  }
}


