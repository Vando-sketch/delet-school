import { config } from '../config/index.js';
import { escapeForPandoc } from './escape.js';
import type { ProcessedFileResult, TaskSolution } from '../types.js';

function escapeYamlString(text: string): string {
  // Collapse C0 control chars (newlines, tabs, etc.) to spaces first: a raw newline in model-
  // authored `thema`/`lernfeld` would break the single-line double-quoted YAML scalar these
  // values are interpolated into and fail the pandoc render. Then escape backslash and quote.
  return text
    .replace(/[\x00-\x1F]/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
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
  let backgroundContextSection = '';
  if (result.hintergrundKontext && result.hintergrundKontext.trim().length > 0) {
    const escapedContext = escapeForPandoc(result.hintergrundKontext.trim());
    backgroundContextSection = `::: {.hintergrund-kontext}\n### Hintergrund & Kontext\n\n${escapedContext}\n:::\n\n`;
  }
  const blocks = result.tasksFound.map((task, index) => buildTaskBlock(task, index));
  return `${frontmatter}\n\n${backgroundContextSection}${blocks.join('\n\n')}\n`;
}

