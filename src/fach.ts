export const FACH_KEYS = [
  'BGWP',
  'Englisch',
  'Deutsch',
  'IT',
  'AEuP',
  'PuG',
  'IT-Tec',
  'Religion',
  '_Unsortiert',
] as const;

export type FachKey = (typeof FACH_KEYS)[number];

/**
 * Fixed, closed set - deliberately not dynamic. Guards against folder-naming drift
 * (typos/near-duplicate folders from LLM output). Extend by hand when a new class starts;
 * see docs/superpowers/specs/2026-07-23-pdf-solve-pipeline-design.md.
 */
export const FACH_SUBPATH: Record<FachKey, string> = {
  BGWP: 'BGWP/Grünig',
  Englisch: 'Englisch',
  Deutsch: 'Deutsch',
  IT: 'FU-IT',
  AEuP: 'AEuP',
  PuG: 'PuG',
  'IT-Tec': 'IT-Tec',
  Religion: 'Religion',
  _Unsortiert: '_Unsortiert',
};
