import { describe, expect, it } from 'vitest';
import { buildWordValidator, loadWordSet } from '../../src/extract/dictionary.js';

describe('loadWordSet', () => {
  it('parses word/affix-flag lines into a lowercase Set, skipping the hunspell word-count header line', () => {
    const fakeFiles: Record<string, string> = {
      '/fake/de.dic': '3\nKaufvertrag/S\nMangel\nHaus/PLe',
      '/fake/en.dic': '1\nContract',
    };
    const readFileSync = (path: string) => {
      const contents = fakeFiles[path];
      if (contents === undefined) throw new Error(`unexpected path: ${path}`);
      return contents;
    };

    const words = loadWordSet({ readFileSync, dicPaths: ['/fake/de.dic', '/fake/en.dic'] });

    expect(words.has('kaufvertrag')).toBe(true);
    expect(words.has('mangel')).toBe(true);
    expect(words.has('haus')).toBe(true);
    expect(words.has('contract')).toBe(true);
  });

  it('includes the domain whitelist (Fach codes and legal abbreviations)', () => {
    const readFileSync = () => '0\n';
    const words = loadWordSet({ readFileSync, dicPaths: ['/fake/empty.dic'] });

    expect(words.has('bgwp')).toBe(true);
    expect(words.has('bgb')).toBe(true);
  });
});

describe('buildWordValidator', () => {
  it('looks up words case-insensitively', () => {
    const isRealWord = buildWordValidator(new Set(['kaufvertrag']));
    expect(isRealWord('Kaufvertrag')).toBe(true);
    expect(isRealWord('KAUFVERTRAG')).toBe(true);
    expect(isRealWord('unknownword')).toBe(false);
  });
});
