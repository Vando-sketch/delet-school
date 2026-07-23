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
// Has a real text layer already (no scans/handwriting), so it skips the OCR/vision pipeline
// entirely and goes straight through MarkItDown, same as a text-layer PDF's markdown step.
const MARKITDOWN_DIRECT_EXTENSIONS = new Set(['.docx']);

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

  if (MARKITDOWN_DIRECT_EXTENSIONS.has(ext)) {
    const markdown = await toMarkdown(filePath);
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
