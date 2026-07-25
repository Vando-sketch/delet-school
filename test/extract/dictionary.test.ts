import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildWordValidator, clearWordSetCache, loadWordSet } from '../../src/extract/dictionary.js';

describe('loadWordSet', () => {
  beforeEach(() => {
    clearWordSetCache();
  });

  it('parses word/affix-flag lines into a lowercase Set, skipping the hunspell word-count header line', () => {
    const fakeFiles: Record<string, string> = {
      '/fake/de.dic': '318520\nKaufvertrag/S\nMangel\nHaus/PLe',
      '/fake/en.dic': '1\nContract',
    };
    const readFileSync = (path: string) => {
      const contents = fakeFiles[path];
      if (contents === undefined) throw new Error(`unexpected path: ${path}`);
      return contents;
    };

    const words = loadWordSet({ readFileSync, dicPaths: ['/fake/de.dic', '/fake/en.dic'] });

    expect(words.has('318520')).toBe(false);
    expect(words.has('1')).toBe(false);
    expect(words.has('kaufvertrag')).toBe(true);
    expect(words.has('mangel')).toBe(true);
    expect(words.has('haus')).toBe(true);
    expect(words.has('contract')).toBe(true);
  });

  it('caches word set by dictionary path key and returns cached set on subsequent calls', () => {
    const readFileSync = vi.fn().mockReturnValue('1\nApfel/N\n');
    const set1 = loadWordSet({ readFileSync, dicPaths: ['/fake/a.dic'] });
    const set2 = loadWordSet({ readFileSync, dicPaths: ['/fake/a.dic'] });

    expect(set1).toBe(set2);
    expect(readFileSync).toHaveBeenCalledTimes(1);
  });

  it('maintains cache isolation for different dictionary path combinations', () => {
    const fakeFiles: Record<string, string> = {
      '/fake/a.dic': '1\nApfel',
      '/fake/b.dic': '1\nBirne',
    };
    const readFileSync = (path: string) => fakeFiles[path] ?? '';
    const setA = loadWordSet({ readFileSync, dicPaths: ['/fake/a.dic'] });
    const setB = loadWordSet({ readFileSync, dicPaths: ['/fake/b.dic'] });

    expect(setA).not.toBe(setB);
    expect(setA.has('apfel')).toBe(true);
    expect(setA.has('birne')).toBe(false);
    expect(setB.has('birne')).toBe(true);
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
