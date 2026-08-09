import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildSolutionMarkdown } from '../../src/pdf/buildMarkdown.js';
import type { ProcessedFileResult } from '../../src/types.js';

function makeResult(overrides: Partial<ProcessedFileResult> = {}): ProcessedFileResult {
  return {
    originalFileName: 'arbeitsblatt1.pdf',
    isReferenceSheet: false,
    subject: 'Math',
    topic: 'Kaufvertragsrecht',
    tasksFound: [
      {
        title: 'Mangelhafte Lieferung',
        taskDescription: 'Welche Rechte hat der Käufer bei einem Sachmangel?',
        proposedSolution: 'Nacherfüllung nach § 439 BGB.',
        source: '§ 437, § 439 BGB',
      },
    ],
    ...overrides,
  };
}

describe('buildSolutionMarkdown', () => {
  beforeEach(() => {
    process.env.STUDENT_NAME = 'Jordan Rivera';
    process.env.STUDENT_CLASS = '10A';
  });

  afterEach(() => {
    delete process.env.STUDENT_NAME;
    delete process.env.STUDENT_CLASS;
  });

  it('includes frontmatter with subject, topic, name, class, and the given date', () => {
    const md = buildSolutionMarkdown(makeResult(), '2026-07-23');

    expect(md).toContain('subject: "Math"');
    expect(md).toContain('topic: "Kaufvertragsrecht – Solutions"');
    expect(md).toContain('name: "Jordan Rivera"');
    expect(md).toContain('class: "10A"');
    expect(md).toContain('date: "2026-07-23"');
  });

  it('neutralizes control characters in frontmatter fields so the YAML scalar stays on one line', () => {
    const md = buildSolutionMarkdown(makeResult({ topic: 'Bruch\nrechnung\tteil' }), '2026-07-23');
    const frontmatter = md.slice(0, md.indexOf('\n---', 3) + 4);
    expect(frontmatter).not.toMatch(/topic: "[^"]*[\n\t]/);
    expect(frontmatter).toContain('topic: "Bruch rechnung teil – Solutions"');
  });

  it('omits the module frontmatter line when not present', () => {
    const md = buildSolutionMarkdown(makeResult(), '2026-07-23');
    expect(md).not.toContain('module:');
  });

  it('includes the module frontmatter line when present', () => {
    const md = buildSolutionMarkdown(makeResult({ module: 'LF 3' }), '2026-07-23');
    expect(md).toContain('module: "LF 3"');
  });

  it('renders one numbered task block with nested question/answer/source fenced divs', () => {
    const md = buildSolutionMarkdown(makeResult(), '2026-07-23');

    expect(md).toContain(':::: {.task}');
    expect(md).toContain('## 1. Mangelhafte Lieferung');
    expect(md).toContain('::: {.question}');
    expect(md).toContain('Welche Rechte hat der Käufer bei einem Sachmangel?');
    expect(md).toContain('::: {.answer}');
    expect(md).toContain('Nacherfüllung nach § 439 BGB.');
    expect(md).toContain('::: {.source}');
    expect(md).toContain('§ 437, § 439 BGB');
    expect(md).toContain('::::');
  });

  it('omits the source block for a task with no source', () => {
    const result = makeResult({
      tasksFound: [
        { title: 'Ohne Quelle', taskDescription: 'Frage ohne Quelle', proposedSolution: 'Antwort ohne Quelle' },
      ],
    });
    const md = buildSolutionMarkdown(result, '2026-07-23');
    expect(md).not.toContain('{.source}');
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

  describe('backgroundContext callout', () => {
    it('renders background context section when backgroundContext is present', () => {
      const result = makeResult({
        backgroundContext: 'Das Unternehmen Meyer GmbH & Co. KG plant ein neues Firmennetzwerk.',
      });
      const md = buildSolutionMarkdown(result, '2026-07-23');

      expect(md).toContain('::: {.background-context}\n### Background & Context\n\nDas Unternehmen Meyer GmbH & Co. KG plant ein neues Firmennetzwerk.\n:::\n\n');
    });

    it('escapes special characters in backgroundContext via escapeForPandoc', () => {
      const result = makeResult({
        backgroundContext: 'Szenario: <script>alert("test")</script> & ::: fence',
      });
      const md = buildSolutionMarkdown(result, '2026-07-23');

      expect(md).toContain('&lt;script&gt;alert("test")&lt;/script&gt;');
      expect(md).not.toContain('<script>');
      expect(md).not.toContain('::: fence');
    });


    it('omits background context section when backgroundContext is missing, empty, or whitespace', () => {
      const resultEmpty = makeResult({ backgroundContext: '' });
      const mdEmpty = buildSolutionMarkdown(resultEmpty, '2026-07-23');
      expect(mdEmpty).not.toContain('::: {.background-context}');
      expect(mdEmpty).not.toContain('Background & Context');

      const resultSpaces = makeResult({ backgroundContext: '   \n  ' });
      const mdSpaces = buildSolutionMarkdown(resultSpaces, '2026-07-23');
      expect(mdSpaces).not.toContain('::: {.background-context}');
      expect(mdSpaces).not.toContain('Background & Context');

      const resultUndefined = makeResult({ backgroundContext: undefined });
      const mdUndefined = buildSolutionMarkdown(resultUndefined, '2026-07-23');
      expect(mdUndefined).not.toContain('::: {.background-context}');
      expect(mdUndefined).not.toContain('Background & Context');
    });
  });
});
