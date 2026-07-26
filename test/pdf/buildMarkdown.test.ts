import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildSolutionMarkdown } from '../../src/pdf/buildMarkdown.js';
import type { ProcessedFileResult } from '../../src/types.js';

function makeResult(overrides: Partial<ProcessedFileResult> = {}): ProcessedFileResult {
  return {
    originalFileName: 'arbeitsblatt1.pdf',
    isMaterialblatt: false,
    fach: 'BGWP',
    thema: 'Kaufvertragsrecht',
    tasksFound: [
      {
        title: 'Mangelhafte Lieferung',
        taskDescription: 'Welche Rechte hat der Käufer bei einem Sachmangel?',
        proposedSolution: 'Nacherfüllung nach § 439 BGB.',
        quelle: '§ 437, § 439 BGB',
      },
    ],
    ...overrides,
  };
}

describe('buildSolutionMarkdown', () => {
  beforeEach(() => {
    process.env.STUDENT_NAME = 'Elias Helmer';
    process.env.STUDENT_KLASSE = 'IT10b';
  });

  afterEach(() => {
    delete process.env.STUDENT_NAME;
    delete process.env.STUDENT_KLASSE;
  });

  it('includes frontmatter with fach, thema, name, klasse, and the given datum', () => {
    const md = buildSolutionMarkdown(makeResult(), '2026-07-23');

    expect(md).toContain('fach: "BGWP"');
    expect(md).toContain('thema: "Kaufvertragsrecht – Lösungen"');
    expect(md).toContain('name: "Elias Helmer"');
    expect(md).toContain('klasse: "IT10b"');
    expect(md).toContain('datum: "2026-07-23"');
  });

  it('neutralizes control characters in frontmatter fields so the YAML scalar stays on one line', () => {
    const md = buildSolutionMarkdown(makeResult({ thema: 'Bruch\nrechnung\tteil' }), '2026-07-23');
    const frontmatter = md.slice(0, md.indexOf('\n---', 3) + 4);
    expect(frontmatter).not.toMatch(/thema: "[^"]*[\n\t]/);
    expect(frontmatter).toContain('thema: "Bruch rechnung teil – Lösungen"');
  });

  it('omits the lernfeld frontmatter line when not present', () => {
    const md = buildSolutionMarkdown(makeResult(), '2026-07-23');
    expect(md).not.toContain('lernfeld:');
  });

  it('includes the lernfeld frontmatter line when present', () => {
    const md = buildSolutionMarkdown(makeResult({ lernfeld: 'LF 3' }), '2026-07-23');
    expect(md).toContain('lernfeld: "LF 3"');
  });

  it('renders one numbered task block with nested frage/antwort/quelle fenced divs', () => {
    const md = buildSolutionMarkdown(makeResult(), '2026-07-23');

    expect(md).toContain(':::: {.task}');
    expect(md).toContain('## 1. Mangelhafte Lieferung');
    expect(md).toContain('::: {.frage}');
    expect(md).toContain('Welche Rechte hat der Käufer bei einem Sachmangel?');
    expect(md).toContain('::: {.antwort}');
    expect(md).toContain('Nacherfüllung nach § 439 BGB.');
    expect(md).toContain('::: {.quelle}');
    expect(md).toContain('§ 437, § 439 BGB');
    expect(md).toContain('::::');
  });

  it('omits the quelle block for a task with no quelle', () => {
    const result = makeResult({
      tasksFound: [
        { title: 'Ohne Quelle', taskDescription: 'Frage ohne Quelle', proposedSolution: 'Antwort ohne Quelle' },
      ],
    });
    const md = buildSolutionMarkdown(result, '2026-07-23');
    expect(md).not.toContain('{.quelle}');
  });

  it('numbers multiple tasks sequentially', () => {
    const result = makeResult({
      tasksFound: [
        { title: 'Erste', taskDescription: 'F1', proposedSolution: 'A1' },
        { title: 'Zweite', taskDescription: 'F2', proposedSolution: 'A2' },
      ],
    });
    const md = buildSolutionMarkdown(result, '2026-07-23');
    expect(md).toContain('## 1. Erste');
    expect(md).toContain('## 2. Zweite');
  });

  it('escapes LLM-authored text through escapeForPandoc before embedding it', () => {
    const result = makeResult({
      tasksFound: [
        {
          title: 'Titel mit ::: Fence',
          taskDescription: 'Frage mit ::: drin',
          proposedSolution: 'Antwort mit <script>alert(1)</script>',
        },
      ],
    });
    const md = buildSolutionMarkdown(result, '2026-07-23');

    expect(md).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(md).not.toContain('<script>');
  });

  describe('hintergrundKontext callout', () => {
    it('renders background context section when hintergrundKontext is present', () => {
      const result = makeResult({
        hintergrundKontext: 'Das Unternehmen Meyer GmbH & Co. KG plant ein neues Firmennetzwerk.',
      });
      const md = buildSolutionMarkdown(result, '2026-07-23');

      expect(md).toContain('::: {.hintergrund-kontext}\n### Hintergrund & Kontext\n\nDas Unternehmen Meyer GmbH & Co. KG plant ein neues Firmennetzwerk.\n:::\n\n');
    });

    it('escapes special characters in hintergrundKontext via escapeForPandoc', () => {
      const result = makeResult({
        hintergrundKontext: 'Szenario: <script>alert("test")</script> & ::: fence',
      });
      const md = buildSolutionMarkdown(result, '2026-07-23');

      expect(md).toContain('&lt;script&gt;alert("test")&lt;/script&gt;');
      expect(md).not.toContain('<script>');
      expect(md).not.toContain('::: fence');
    });


    it('omits background context section when hintergrundKontext is missing, empty, or whitespace', () => {
      const resultEmpty = makeResult({ hintergrundKontext: '' });
      const mdEmpty = buildSolutionMarkdown(resultEmpty, '2026-07-23');
      expect(mdEmpty).not.toContain('::: {.hintergrund-kontext}');
      expect(mdEmpty).not.toContain('Hintergrund & Kontext');

      const resultSpaces = makeResult({ hintergrundKontext: '   \n  ' });
      const mdSpaces = buildSolutionMarkdown(resultSpaces, '2026-07-23');
      expect(mdSpaces).not.toContain('::: {.hintergrund-kontext}');
      expect(mdSpaces).not.toContain('Hintergrund & Kontext');

      const resultUndefined = makeResult({ hintergrundKontext: undefined });
      const mdUndefined = buildSolutionMarkdown(resultUndefined, '2026-07-23');
      expect(mdUndefined).not.toContain('::: {.hintergrund-kontext}');
      expect(mdUndefined).not.toContain('Hintergrund & Kontext');
    });
  });
});

