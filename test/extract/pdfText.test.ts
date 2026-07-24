// test/extract/pdfText.test.ts
import { describe, expect, it } from 'vitest';
import { config } from '../../src/config/index.js';
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
      expect(file).toBe(config.poppler.pdfinfoBin);
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
    expect(calls).toEqual([{ file: config.poppler.pdftotextBin, args: ['-f', '3', '-l', '3', '/tmp/doc.pdf', '-'] }]);
  });
});
