import { extname } from 'node:path';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { getAllPagesText, getPageText, getPdfPageCount, getPagesWithContentImages, isQualityText } from './pdfText.js';
import { ocrPdf } from './ocr.js';
import { convertToMarkdown } from './markitdown.js';
import { renderPageToPng } from './renderPage.js';
import type { ExtractionResult, VisionPage } from '../types.js';

export interface ExtractDeps {
  getPdfPageCount?: typeof getPdfPageCount;
  getPageText?: typeof getPageText;
  getAllPagesText?: typeof getAllPagesText;
  isQualityText?: typeof isQualityText;
  ocrPdf?: typeof ocrPdf;
  convertToMarkdown?: typeof convertToMarkdown;
  renderPageToPng?: typeof renderPageToPng;
  getPagesWithContentImages?: typeof getPagesWithContentImages;
}

export const TEXT_EXTENSIONS = new Set(['.txt', '.md']);
// Has a real text layer already (no scans/handwriting), so it skips the OCR/vision pipeline
// entirely and goes straight through MarkItDown, same as a text-layer PDF's markdown step.
export const MARKITDOWN_DIRECT_EXTENSIONS = new Set(['.docx']);

export async function extractFile(
  filePath: string,
  workDir: string,
  deps: ExtractDeps = {},
): Promise<ExtractionResult> {
  const getPageCount = deps.getPdfPageCount ?? getPdfPageCount;
  const getText = deps.getPageText ?? getPageText;
  const getAllTexts =
    deps.getAllPagesText ??
    ((path: string, count: number) => getAllPagesText(path, count, undefined, getText));
  const checkQuality = deps.isQualityText ?? isQualityText;
  const runOcr = deps.ocrPdf ?? ocrPdf;
  const toMarkdown = deps.convertToMarkdown ?? convertToMarkdown;
  const renderPage = deps.renderPageToPng ?? renderPageToPng;
  const getPagesWithImages = deps.getPagesWithContentImages ?? getPagesWithContentImages;

  const ext = extname(filePath).toLowerCase();

  if (TEXT_EXTENSIONS.has(ext)) {
    const markdown = await fs.readFile(filePath, 'utf-8');
    return { markdown, visionPages: [], ranOcr: false, archivalPdfPath: filePath };
  }

  if (MARKITDOWN_DIRECT_EXTENSIONS.has(ext)) {
    const markdown = await toMarkdown(filePath);
    // Unlike PDFs, a .docx has no page-render path to fall back to OCR/vision for - so a
    // docx with no real text layer (e.g. a scanned worksheet pasted in as an image) can't be
    // recovered here. Fail loudly instead of silently handing near-empty text to the classifier.
    if (!checkQuality(markdown)) {
      throw new Error(
        `extract: "${filePath}" produced low-quality/empty text from MarkItDown - likely an image-only .docx with no OCR fallback available`,
      );
    }
    return { markdown, visionPages: [], ranOcr: false, archivalPdfPath: filePath };
  }

  if (ext !== '.pdf') {
    throw new Error(`extract: unsupported file type "${ext}" for "${filePath}"`);
  }

  const pageCount = await getPageCount(filePath);
  const pageNumbers = Array.from({ length: pageCount }, (_, i) => i + 1);

  const originalTexts = await getAllTexts(filePath, pageCount);
  const pagesWithImages = await getPagesWithImages(filePath).catch(() => new Set<number>());

  const pageNeedsOcr = (i: number) => {
    const text = originalTexts[i] ?? '';
    const hasContentImage = pagesWithImages.has(i + 1);
    return hasContentImage || !checkQuality(text);
  };

  const needsOcr = pageNumbers.some((_, i) => pageNeedsOcr(i));

  let workingPdfPath = filePath;
  let ranOcr = false;
  let pageTexts = originalTexts;

  if (needsOcr) {
    const ocrOutputPath = path.join(workDir, 'ocr.pdf');
    await runOcr(filePath, ocrOutputPath);
    workingPdfPath = ocrOutputPath;
    ranOcr = true;
    pageTexts = await getAllTexts(ocrOutputPath, pageCount);
  }

  const visionPageNumbers = pageNumbers.filter(
    (page, i) => pagesWithImages.has(page) || !checkQuality(pageTexts[i] ?? ''),
  );
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
