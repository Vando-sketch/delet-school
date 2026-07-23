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
  return hasQualityAlphanumericRatio(text);
}

/**
 * Same alphanumeric-ratio check as isQualityText, without its MIN_CHARS page-length gate -
 * for callers judging a short, deliberate excerpt (e.g. a one-line document header) rather
 * than a full page, where "too short to tell" shouldn't be conflated with "garbled."
 */
export function hasQualityAlphanumericRatio(text: string): boolean {
  const nonWhitespace = text.replace(/\s/g, '');
  if (nonWhitespace.length === 0) return false;
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
