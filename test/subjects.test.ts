import { describe, it, expect } from 'vitest';
import { parseSubjects, SUBJECT_KEYS, SUBJECT_SUBPATH, subjectLanguage } from '../src/subjects.js';

describe('parseSubjects', () => {
  it('returns the generic default subject list when unset', () => {
    const subjects = parseSubjects(undefined);
    expect(subjects.map((s) => s.key)).toContain('Math');
    expect(subjects.map((s) => s.key)).toContain('Unsorted');
  });

  it('parses a custom SUBJECTS JSON array', () => {
    const subjects = parseSubjects('[{"key":"Chemistry","folder":"Chem"}]');
    expect(subjects).toEqual([{ key: 'Chemistry', folder: 'Chem' }]);
  });

  it('carries an optional per-subject language override', () => {
    const subjects = parseSubjects('[{"key":"French","folder":"French","language":"French"}]');
    expect(subjects[0].language).toBe('French');
  });

  it('throws on invalid JSON', () => {
    expect(() => parseSubjects('not json')).toThrow(/not valid JSON/);
  });

  it('throws on an empty array', () => {
    expect(() => parseSubjects('[]')).toThrow(/non-empty/);
  });

  it('throws when a subject entry is missing "folder"', () => {
    expect(() => parseSubjects('[{"key":"Math"}]')).toThrow(/folder/);
  });
});

describe('module-level exports', () => {
  it('SUBJECT_KEYS reflects the default subject list', () => {
    expect(SUBJECT_KEYS).toContain('Math');
  });

  it('SUBJECT_SUBPATH maps every key to its folder', () => {
    expect(SUBJECT_SUBPATH.Math).toBe('Math');
  });

  it('subjectLanguage returns the override for a language subject', () => {
    expect(subjectLanguage('English')).toBe('English');
  });

  it('subjectLanguage returns undefined for a subject with no override', () => {
    expect(subjectLanguage('Math')).toBeUndefined();
  });
});
