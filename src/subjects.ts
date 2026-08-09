export interface SubjectDefinition {
  key: string;
  folder: string;
  /** Overrides OUTPUT_LANGUAGE for this subject — e.g. a language class should be solved
   * in the language being taught, not the globally configured output language. */
  language?: string;
}

// Generic, non-identifying example set. Real deployments configure their own via the
// SUBJECTS env var (JSON array) - this is deliberately not tied to any one curriculum.
const DEFAULT_SUBJECTS: SubjectDefinition[] = [
  { key: 'Math', folder: 'Math' },
  { key: 'Science', folder: 'Science' },
  { key: 'History', folder: 'History' },
  { key: 'English', folder: 'English', language: 'English' },
  { key: 'Spanish', folder: 'Spanish', language: 'Spanish' },
  { key: 'Unsorted', folder: '_Unsorted' },
];

function validateSubjectDefinition(entry: unknown, index: number): SubjectDefinition {
  if (typeof entry !== 'object' || entry === null) {
    throw new Error(`subjects: SUBJECTS[${index}] must be an object.`);
  }
  const obj = entry as Record<string, unknown>;
  if (typeof obj.key !== 'string' || obj.key.trim() === '') {
    throw new Error(`subjects: SUBJECTS[${index}].key must be a non-empty string.`);
  }
  if (typeof obj.folder !== 'string' || obj.folder.trim() === '') {
    throw new Error(`subjects: SUBJECTS[${index}].folder must be a non-empty string.`);
  }
  if (obj.language !== undefined && typeof obj.language !== 'string') {
    throw new Error(`subjects: SUBJECTS[${index}].language must be a string if present.`);
  }
  return {
    key: obj.key,
    folder: obj.folder,
    ...(typeof obj.language === 'string' ? { language: obj.language } : {}),
  };
}

export function parseSubjects(raw: string | undefined): SubjectDefinition[] {
  if (!raw || raw.trim() === '') return DEFAULT_SUBJECTS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`subjects: SUBJECTS env var is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('subjects: SUBJECTS env var must be a non-empty JSON array.');
  }
  return parsed.map((entry, index) => validateSubjectDefinition(entry, index));
}

export const SUBJECTS: SubjectDefinition[] = parseSubjects(process.env.SUBJECTS);
export const SUBJECT_KEYS: readonly string[] = SUBJECTS.map((s) => s.key);
export const SUBJECT_SUBPATH: Record<string, string> = Object.fromEntries(SUBJECTS.map((s) => [s.key, s.folder]));

export function subjectLanguage(key: string): string | undefined {
  return SUBJECTS.find((s) => s.key === key)?.language;
}
