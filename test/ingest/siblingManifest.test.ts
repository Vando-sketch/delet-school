import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildSiblingManifest, EXCERPT_CHAR_CAP } from '../../src/ingest/siblingManifest.js';

describe('buildSiblingManifest', () => {
  it('reads a .txt file directly as its excerpt', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sibling-manifest-test-'));
    try {
      const filePath = path.join(tmpDir, 'notes.txt');
      await fs.writeFile(filePath, 'Fachbereich IT/Elektrotechnik');

      const manifest = await buildSiblingManifest([{ filePath, relativeName: 'notes.txt' }]);

      expect(manifest.get(filePath)).toEqual({ fileName: 'notes.txt', excerpt: 'Fachbereich IT/Elektrotechnik' });
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('reads a .md file directly as its excerpt', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sibling-manifest-test-'));
    try {
      const filePath = path.join(tmpDir, 'readme.md');
      await fs.writeFile(filePath, '# Hello');

      const manifest = await buildSiblingManifest([{ filePath, relativeName: 'readme.md' }]);

      expect(manifest.get(filePath)).toEqual({ fileName: 'readme.md', excerpt: '# Hello' });
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('uses getPageText(path, 1) for a .pdf file', async () => {
    const getPageText = async (pdfPath: string, pageNumber: number) => `page ${pageNumber} of ${pdfPath}`;

    const manifest = await buildSiblingManifest([{ filePath: '/staging/quote.pdf', relativeName: 'quote.pdf' }], {
      getPageText,
    });

    expect(manifest.get('/staging/quote.pdf')).toEqual({
      fileName: 'quote.pdf',
      excerpt: 'page 1 of /staging/quote.pdf',
    });
  });

  it('uses convertToMarkdown for a .docx file', async () => {
    const convertToMarkdown = async (filePath: string) => `markdown of ${filePath}`;

    const manifest = await buildSiblingManifest([{ filePath: '/staging/vorlage.docx', relativeName: 'vorlage.docx' }], {
      convertToMarkdown,
    });

    expect(manifest.get('/staging/vorlage.docx')).toEqual({
      fileName: 'vorlage.docx',
      excerpt: 'markdown of /staging/vorlage.docx',
    });
  });

  it('returns an empty excerpt for unsupported extensions without calling any extractor', async () => {
    const manifest = await buildSiblingManifest([{ filePath: '/staging/photo.png', relativeName: 'photo.png' }]);

    expect(manifest.get('/staging/photo.png')).toEqual({ fileName: 'photo.png', excerpt: '' });
  });

  it('truncates excerpts to EXCERPT_CHAR_CAP characters and appends a truncation marker', async () => {
    const longText = 'x'.repeat(EXCERPT_CHAR_CAP + 500);
    const getPageText = async () => longText;

    const manifest = await buildSiblingManifest([{ filePath: '/staging/long.pdf', relativeName: 'long.pdf' }], {
      getPageText,
    });

    const excerpt = manifest.get('/staging/long.pdf')?.excerpt ?? '';
    expect(excerpt.startsWith(longText.slice(0, EXCERPT_CHAR_CAP))).toBe(true);
    expect(excerpt).toContain('gekürzt');
    expect(excerpt.length).toBeGreaterThan(EXCERPT_CHAR_CAP);
  });

  it('discards a .pdf excerpt whose text is mostly non-alphanumeric OCR/scan garbage', async () => {
    const getPageText = async () => 'l|i1l!! O0--_x~~ ][{}##@@$$%%^^&&**';

    const manifest = await buildSiblingManifest([{ filePath: '/staging/scan.pdf', relativeName: 'scan.pdf' }], {
      getPageText,
    });

    expect(manifest.get('/staging/scan.pdf')).toEqual({ fileName: 'scan.pdf', excerpt: '' });
  });

  it('keeps a short .pdf excerpt with a good alphanumeric ratio even though it is well under 100 chars', async () => {
    const getPageText = async () => 'Fachbereich IT/Elektrotechnik';

    const manifest = await buildSiblingManifest([{ filePath: '/staging/header.pdf', relativeName: 'header.pdf' }], {
      getPageText,
    });

    expect(manifest.get('/staging/header.pdf')).toEqual({
      fileName: 'header.pdf',
      excerpt: 'Fachbereich IT/Elektrotechnik',
    });
  });

  it('gives one failing file an empty excerpt without affecting the others', async () => {
    const getPageText = async (pdfPath: string) => {
      if (pdfPath === '/staging/corrupt.pdf') {
        throw new Error('pdftotext: corrupt PDF');
      }
      return 'fine content';
    };

    const manifest = await buildSiblingManifest(
      [
        { filePath: '/staging/corrupt.pdf', relativeName: 'corrupt.pdf' },
        { filePath: '/staging/ok.pdf', relativeName: 'ok.pdf' },
      ],
      { getPageText },
    );

    expect(manifest.get('/staging/corrupt.pdf')).toEqual({ fileName: 'corrupt.pdf', excerpt: '' });
    expect(manifest.get('/staging/ok.pdf')).toEqual({ fileName: 'ok.pdf', excerpt: 'fine content' });
  });
});
