import { describe, expect, it } from 'vitest';
import { getPageText, getPdfPageCount, isQualityText } from '../../src/extract/pdfText.js';

describe('isQualityText', () => {
  it('rejects text under the minimum character threshold', () => {
    expect(isQualityText('too short')).toBe(false);
  });

  it('accepts long, mostly-alphanumeric prose', () => {
    const prose =
      'Der Käufer kann gemäß Paragraph 437 BGB zunächst Nacherfüllung verlangen, ' +
      'wenn die gelieferte Ware einen Sachmangel aufweist und die Gewährleistung greift.';
    expect(isQualityText(prose)).toBe(true);
  });

  it('rejects long OCR gibberish even though it clears the character-count threshold', () => {
    const gibberish = 'l|i1l!! O0--_x~~ '.repeat(10);
    expect(isQualityText(gibberish)).toBe(false);
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
