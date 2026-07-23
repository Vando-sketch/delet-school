import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import pino from 'pino';
import { getPageText, hasQualityAlphanumericRatio } from '../extract/pdfText.js';
import { convertToMarkdown } from '../extract/markitdown.js';
import { TEXT_EXTENSIONS, MARKITDOWN_DIRECT_EXTENSIONS } from '../extract/index.js';
import type { SiblingManifestEntry } from '../types.js';

const logger = pino({ name: 'sibling-manifest' });

/** Excerpts embedded in a Claude prompt as sibling context - kept short and cheap to build. */
export const EXCERPT_CHAR_CAP = 4000;

/** Appended when an excerpt is cut off, so the classifier knows not to treat the cutoff as "no more data." */
const TRUNCATION_MARKER = '\n[... gekürzt]';

export interface BuildSiblingManifestDeps {
  getPageText?: typeof getPageText;
  convertToMarkdown?: typeof convertToMarkdown;
}

interface SiblingFileRef {
  filePath: string;
  relativeName: string;
}

function capExcerpt(raw: string): string {
  if (raw.length <= EXCERPT_CHAR_CAP) return raw;
  return raw.slice(0, EXCERPT_CHAR_CAP) + TRUNCATION_MARKER;
}

/**
 * Best-effort, cheap excerpt per file - not authoritative. Used only as classification/context
 * hints for sibling files in the same batch (see docs on batch-aware classification). No OCR is
 * run here, so a scanned/handwritten PDF's page-1 text may come back empty - an accepted
 * limitation - but text that does come back is checked for a plausible alphanumeric ratio so
 * genuinely garbled scan/OCR output isn't handed to the classifier as if it were real content.
 */
async function extractExcerpt(filePath: string, deps: Required<BuildSiblingManifestDeps>): Promise<string> {
  const ext = path.extname(filePath).toLowerCase();
  let raw = '';
  if (TEXT_EXTENSIONS.has(ext)) {
    raw = await readFile(filePath, 'utf-8');
  } else if (ext === '.pdf') {
    raw = await deps.getPageText(filePath, 1);
    if (!hasQualityAlphanumericRatio(raw)) return '';
  } else if (MARKITDOWN_DIRECT_EXTENSIONS.has(ext)) {
    raw = await deps.convertToMarkdown(filePath);
    if (!hasQualityAlphanumericRatio(raw)) return '';
  } else {
    return '';
  }
  return capExcerpt(raw);
}

/**
 * Builds a manifest of lightweight excerpts for every file in an ingest batch, keyed by
 * `filePath`, captured once upfront at zip-extraction time (before any file in the batch can be
 * archived/moved away). Each file's excerpt is best-effort and built concurrently: a failure
 * reading/converting one file is logged and yields an empty excerpt for that file only, and
 * never fails the whole batch or blocks the others.
 */
export async function buildSiblingManifest(
  files: SiblingFileRef[],
  deps: BuildSiblingManifestDeps = {},
): Promise<Map<string, SiblingManifestEntry>> {
  const resolvedDeps: Required<BuildSiblingManifestDeps> = {
    getPageText: deps.getPageText ?? getPageText,
    convertToMarkdown: deps.convertToMarkdown ?? convertToMarkdown,
  };

  const entries = await Promise.all(
    files.map(async ({ filePath, relativeName }): Promise<[string, SiblingManifestEntry]> => {
      let excerpt = '';
      try {
        excerpt = await extractExcerpt(filePath, resolvedDeps);
      } catch (err) {
        logger.warn({ err, filePath }, 'Failed to build sibling excerpt for file; continuing with an empty excerpt');
      }
      return [filePath, { fileName: relativeName, excerpt }];
    }),
  );
  return new Map(entries);
}
