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

/**
 * Parses hunspell .dic files (plain `word/AFFIXFLAGS` lines, first line is a word count) into
 * a flat Set - affix rules are irrelevant here, this is a coarse "known word" lookup, not a
 * spellchecker, so inflected forms not listed verbatim in the .dic file are undercounted. That
 * is an accepted tradeoff given the dictionary ratio's 0.45 threshold (see pdfText.ts).
 */
export function loadWordSet(deps: LoadWordSetDeps = {}): Set<string> {
  const read = deps.readFileSync ?? ((path: string) => readFileSync(path, 'utf-8'));
  const dicPaths = deps.dicPaths ?? [config.dictionary.deDicPath, config.dictionary.enDicPath];

  const words = new Set<string>(DOMAIN_WHITELIST);
  for (const dicPath of dicPaths) {
    const contents = read(dicPath);
    const lines = contents.split('\n').slice(1); // first line is hunspell's word count
    for (const line of lines) {
      const word = line.split('/')[0]?.trim().toLowerCase();
      if (word) words.add(word);
    }
  }
  return words;
}

export function buildWordValidator(words: Set<string>): WordValidator {
  return (word: string) => words.has(word.toLowerCase());
}
