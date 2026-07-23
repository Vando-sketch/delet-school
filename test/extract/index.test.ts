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

  it('converts .docx files via MarkItDown directly (no OCR/vision)', async () => {
    const filePath = path.join(tmpDir, 'Angebot.docx');
    await fs.writeFile(filePath, 'irrelevant - convertToMarkdown is stubbed');

    const deps = {
      getPdfPageCount: async () => {
        throw new Error('should not be called');
      },
      getPageText: async () => {
        throw new Error('should not be called');
      },
      isQualityText: () => {
        throw new Error('should not be called');
      },
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
