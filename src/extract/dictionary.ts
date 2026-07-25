import { readFileSync } from 'node:fs';
import { config } from '../config/index.js';
import { FACH_KEYS } from '../fach.js';

export type WordValidator = (word: string) => boolean;

// Subject codes and legal-citation abbreviations are expected, legitimate vocabulary in this
// document domain but won't appear in a general dictionary.
const DOMAIN_WHITELIST = [...FACH_KEYS.map((key) => key.toLowerCase()), 'bgb', 'lf', 'gg', 'stgb', 'hgb'];

export interface LoadWordSetDeps {
  readFileSync?: (path: string) => string;
  dicPaths?: string[];
}

const cachedWordSets = new Map<string, Set<string>>();

export function clearWordSetCache(): void {
  cachedWordSets.clear();
}

/**
 * Parses hunspell .dic files (plain `word/AFFIXFLAGS` lines, first line is a word count) into
 * a flat Set - affix rules are irrelevant here, this is a coarse "known word" lookup, not a
 * spellchecker, so inflected forms not listed verbatim in the .dic file are undercounted. That
 * is an accepted tradeoff given the dictionary ratio's 0.45 threshold (see pdfText.ts).
 */
export function loadWordSet(deps: LoadWordSetDeps = {}): Set<string> {
  const read = deps.readFileSync ?? ((path: string) => readFileSync(path, 'utf-8'));
  const dicPaths = deps.dicPaths ?? [config.dictionary.deDicPath, config.dictionary.enDicPath];
  const cacheKey = dicPaths.slice().sort().join(':');

  const existing = cachedWordSets.get(cacheKey);
  if (existing) {
    return existing;
  }

  const words = new Set<string>(DOMAIN_WHITELIST);
  const WORD_PATTERN = /^([^\/\s\r\n]+)/gm;

  for (const dicPath of dicPaths) {
    const contents = read(dicPath);
    const firstNewlineIndex = contents.indexOf('\n');
    const body = firstNewlineIndex !== -1 ? contents.slice(firstNewlineIndex + 1) : contents;

    let match: RegExpExecArray | null;
    while ((match = WORD_PATTERN.exec(body)) !== null) {
      const rawWord = match[1]?.trim().toLowerCase();
      if (rawWord && !/^\d+$/.test(rawWord)) {
        words.add(rawWord);
      }
    }
  }

  cachedWordSets.set(cacheKey, words);
  return words;
}

export function buildWordValidator(words: Set<string>): WordValidator {
  return (word: string) => words.has(word.toLowerCase());
}
