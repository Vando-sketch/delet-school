import { config } from '../config/index.js';
import { escapeForPandoc } from './escape.js';
import type { ProcessedFileResult, TaskSolution } from '../types.js';

const LANGUAGE_CODES: Record<string, string> = {
  english: 'en',
  german: 'de',
  spanish: 'es',
  french: 'fr',
};

function languageCode(language: string): string {
  return LANGUAGE_CODES[language.trim().toLowerCase()] ?? 'en';
}

function escapeYamlString(text: string): string {
  return text
    .replace(/[\x00-\x1F]/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
}

function buildFrontmatter(result: ProcessedFileResult, date: string): string {
  const lines = [
    '---',
    `lang: ${languageCode(config.output.language())}`,
    `subject: "${escapeYamlString(result.subject)}"`,
    result.module ? `module: "${escapeYamlString(result.module)}"` : undefined,
    `topic: "${escapeYamlString(result.topic)} – Solutions"`,
    `name: "${escapeYamlString(config.student.name())}"`,
    `class: "${escapeYamlString(config.student.className())}"`,
    `date: "${escapeYamlString(date)}"`,
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
    '::: {.question}',
    escapeForPandoc(task.taskDescription),
    ':::',
    '',
    '::: {.answer}',
    escapeForPandoc(task.proposedSolution),
    ':::',
  ];
  if (task.source) {
    lines.push('', '::: {.source}', escapeForPandoc(task.source), ':::');
  }
  lines.push('::::');
  return lines.join('\n');
}

export function buildSolutionMarkdown(result: ProcessedFileResult, date: string): string {
  const frontmatter = buildFrontmatter(result, date);
  let backgroundContextSection = '';
  if (result.backgroundContext && result.backgroundContext.trim().length > 0) {
    const escapedContext = escapeForPandoc(result.backgroundContext.trim());
    backgroundContextSection = `::: {.background-context}\n### Background & Context\n\n${escapedContext}\n:::\n\n`;
  }
  const blocks = result.tasksFound.map((task, index) => buildTaskBlock(task, index));
  return `${frontmatter}\n\n${backgroundContextSection}${blocks.join('\n\n')}\n`;
}
