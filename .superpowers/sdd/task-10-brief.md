### Task 10: Solution-markdown builder

**Files:**
- Create: `src/pdf/buildMarkdown.ts`
- Test: `test/pdf/buildMarkdown.test.ts`

**Interfaces:**
- Consumes: `ProcessedFileResult`, `TaskSolution` (Task 2, `src/types.ts`); `escapeForPandoc` (Task 3); `config.student.name()/klasse()` (Task 2).
- Produces: `buildSolutionMarkdown(result: ProcessedFileResult, datum: string): string` — consumed by Task 14 (`worker/index.ts`) as input to Task 11's `renderSolutionPdf`.

- [ ] **Step 1: Write the failing tests**

```ts
// test/pdf/buildMarkdown.test.ts
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
    process.env.STUDENT_NAME = 'Jordan Rivera';
    process.env.STUDENT_KLASSE = '10A';
  });

  afterEach(() => {
    delete process.env.STUDENT_NAME;
    delete process.env.STUDENT_KLASSE;
  });

  it('includes frontmatter with fach, thema, name, klasse, and the given datum', () => {
    const md = buildSolutionMarkdown(makeResult(), '2026-07-23');

    expect(md).toContain('fach: "BGWP"');
    expect(md).toContain('thema: "Kaufvertragsrecht – Lösungen"');
    expect(md).toContain('name: "Jordan Rivera"');
    expect(md).toContain('klasse: "10A"');
    expect(md).toContain('datum: "2026-07-23"');
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
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- test/pdf/buildMarkdown.test.ts`
Expected: FAIL with "Cannot find module '../../src/pdf/buildMarkdown.js'".

- [ ] **Step 3: Implement**

```ts
// src/pdf/buildMarkdown.ts
import { config } from '../config/index.js';
import { escapeForPandoc } from './escape.js';
import type { ProcessedFileResult, TaskSolution } from '../types.js';

function escapeYamlString(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function buildFrontmatter(result: ProcessedFileResult, datum: string): string {
  const lines = [
    '---',
    'lang: de',
    `fach: "${escapeYamlString(result.fach)}"`,
    result.lernfeld ? `lernfeld: "${escapeYamlString(result.lernfeld)}"` : undefined,
    `thema: "${escapeYamlString(result.thema)} – Lösungen"`,
    `name: "${escapeYamlString(config.student.name())}"`,
    `klasse: "${escapeYamlString(config.student.klasse())}"`,
    `datum: "${escapeYamlString(datum)}"`,
    '---',
  ];
  return lines.filter((line): line is string => line !== undefined).join('\n');
}

function buildTaskBlock(task: TaskSolution, index: number): string {
  const number = index + 1;
  const lines = [
    ':::: {.task}',
    `## ${number}. ${escapeForPandoc(task.title)}`,
    '',
    '::: {.frage}',
    escapeForPandoc(task.taskDescription),
    ':::',
    '',
    '::: {.antwort}',
    escapeForPandoc(task.proposedSolution),
    ':::',
  ];
  if (task.quelle) {
    lines.push('', '::: {.quelle}', escapeForPandoc(task.quelle), ':::');
  }
  lines.push('::::');
  return lines.join('\n');
}

export function buildSolutionMarkdown(result: ProcessedFileResult, datum: string): string {
  const frontmatter = buildFrontmatter(result, datum);
  const blocks = result.tasksFound.map((task, index) => buildTaskBlock(task, index));
  return `${frontmatter}\n\n${blocks.join('\n\n')}\n`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- test/pdf/buildMarkdown.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/pdf/buildMarkdown.ts test/pdf/buildMarkdown.test.ts
git commit -m "feat: build pandoc-ready solution markdown from ProcessedFileResult"
```

---

