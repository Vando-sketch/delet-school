import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import pino from 'pino';
import { getPageText } from '../extract/pdfText.js';
import { convertToMarkdown } from '../extract/markitdown.js';
import type { SiblingManifestEntry } from '../types.js';

const logger = pino({ name: 'sibling-manifest' });

/** Excerpts embedded in a Claude prompt as sibling context - kept short and cheap to build. */
export const EXCERPT_CHAR_CAP = 4000;

export interface BuildSiblingManifestDeps {
  getPageText?: typeof getPageText;
  convertToMarkdown?: typeof convertToMarkdown;
}

interface SiblingFileRef {
  filePath: string;
  relativeName: string;
}

/**
 * Best-effort, cheap excerpt per file - not authoritative. Used only as classification/context
 * hints for sibling files in the same batch (see docs on batch-aware classification). No OCR is
 * run here: a scanned/handwritten PDF's page-1 text may come back empty or garbled, which is an
 * accepted limitation.
 */
async function extractExcerpt(filePath: string, deps: Required<BuildSiblingManifestDeps>): Promise<string> {
  const ext = path.extname(filePath).toLowerCase();
  let raw = '';
  if (ext === '.txt' || ext === '.md') {
    raw = await readFile(filePath, 'utf-8');
  } else if (ext === '.pdf') {
    raw = await deps.getPageText(filePath, 1);
  } else if (ext === '.docx') {
    raw = await deps.convertToMarkdown(filePath);
  } else {
    return '';
  }
  return raw.slice(0, EXCERPT_CHAR_CAP);
}

/**
 * Builds a manifest of lightweight excerpts for every file in an ingest batch, keyed by
 * `filePath`, captured once upfront at zip-extraction time (before any file in the batch can be
 * archived/moved away). Each file's excerpt is best-effort: a failure reading/converting one
 * file is logged and yields an empty excerpt for that file only, and never fails the whole batch.
 */
export async function buildSiblingManifest(
  files: SiblingFileRef[],
  deps: BuildSiblingManifestDeps = {},
): Promise<Map<string, SiblingManifestEntry>> {
  const resolvedDeps: Required<BuildSiblingManifestDeps> = {
    getPageText: deps.getPageText ?? getPageText,
    convertToMarkdown: deps.convertToMarkdown ?? convertToMarkdown,
  };

  const manifest = new Map<string, SiblingManifestEntry>();
  for (const { filePath, relativeName } of files) {
    let excerpt = '';
    try {
      excerpt = await extractExcerpt(filePath, resolvedDeps);
    } catch (err) {
      logger.warn({ err, filePath }, 'Failed to build sibling excerpt for file; continuing with an empty excerpt');
    }
    manifest.set(filePath, { fileName: relativeName, excerpt });
  }
  return manifest;
}
