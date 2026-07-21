import { extname } from 'node:path';
import { query as sdkQuery, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import pino from 'pino';
import { config } from '../config/index.js';
import type { DownloadedFile, FileProcessor, ProcessedFileResult, TaskSolution } from '../types.js';

const logger = pino({ name: 'claude-file-processor' });

/**
 * The Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) is Claude Code packaged as a
 * library — `query()` returns an async generator of `SDKMessage` events and drives the
 * full Claude Code harness (built-in tools, permissions, subprocess management, etc.).
 * It is NOT the plain Messages API. Since we only want a single-shot "read this text,
 * return structured JSON" call with no filesystem/bash access, we disable all built-in
 * tools (`tools: []`) and rely on the SDK's native structured-output support
 * (`outputFormat: { type: 'json_schema', ... }`), which the SDK validates and retries
 * internally and returns as `structured_output` on the final `result` message.
 */

// Only a function type (not the full `Query` interface, which also exposes ~20 control
// methods like interrupt()/setModel()/mcpServerStatus()) is needed here — this keeps the
// SDK call trivially mockable/injectable for tests without having to stub the entire
// Query control surface.
type QueryFn = (params: { prompt: string; options?: Options }) => AsyncIterable<SDKMessage>;

/**
 * Formats currently handled: plain text (.txt) and Markdown (.md) — decoded as UTF-8 and
 * embedded directly into the prompt.
 *
 * TODO: .docx / .pdf and other binary formats are NOT handled yet. The Claude Agent SDK
 * does not accept raw file bytes as first-class message content (unlike the Messages API's
 * `document` content block) — it expects the caller to give it filesystem access via
 * `cwd`/tools and let the model use the Read tool, or to pre-extract text itself. Either
 * approach is a reasonable follow-up; for this first pass we only decode-and-embed text.
 */
const SUPPORTED_TEXT_EXTENSIONS = new Set(['.txt', '.md']);
const SUPPORTED_TEXT_MIME_TYPES = new Set(['text/plain', 'text/markdown']);

function isPlainTextFile(file: DownloadedFile): boolean {
  const ext = extname(file.fileName).toLowerCase();
  return SUPPORTED_TEXT_EXTENSIONS.has(ext) || SUPPORTED_TEXT_MIME_TYPES.has(file.mimeType.toLowerCase());
}

/**
 * ============================================================================
 * OPEN PRODUCT DECISION (see architecture doc): exactly what counts as an "open
 * task" and what shape the proposed solution should take is NOT finalized. The
 * prompt and JSON schema below are a REASONABLE DEFAULT for this first working
 * integration, defining "open task" broadly as: TODOs, unchecked checklist items,
 * questions left open in the text, decisions explicitly marked pending, and similar
 * unresolved action items. This default can be swapped out (different prompt,
 * different output shape, even a different parsing strategy) without touching
 * anything else in the pipeline — that is the entire point of routing everything
 * through the `FileProcessor` interface in src/types.ts.
 * ============================================================================
 */
const TASK_EXTRACTION_SYSTEM_PROMPT = `You are an assistant that reviews a document and finds open, unresolved tasks or action items.

An "open task" includes things like:
- Explicit TODOs or FIXMEs
- Unchecked checklist items (e.g. "- [ ] ...")
- Questions left open or unanswered in the text
- Decisions explicitly marked as pending, TBD, or "needs discussion"
- Action items assigned to someone but not marked complete

For each open task you find, draft a concrete, actionable proposed solution or next step —
not a vague restatement of the task. Be specific enough that someone could act on it directly.

Respond only with the structured JSON described by the provided schema. Do not include any
commentary outside of that JSON. If the document contains no open tasks, return an empty
"tasksFound" array and use "summaryMarkdown" to briefly note that no open tasks were found.`;

const RESULT_JSON_SCHEMA = {
  type: 'object',
  properties: {
    tasksFound: {
      type: 'array',
      description: 'Every open/unresolved task found in the document, each with a proposed solution.',
      items: {
        type: 'object',
        properties: {
          taskDescription: {
            type: 'string',
            description: 'A concise description of the open task as found in the document.',
          },
          proposedSolution: {
            type: 'string',
            description: 'A concrete, actionable proposed solution or next step for this task.',
          },
        },
        required: ['taskDescription', 'proposedSolution'],
        additionalProperties: false,
      },
    },
    summaryMarkdown: {
      type: 'string',
      description: 'A short Markdown summary of the document and the open tasks found (or their absence).',
    },
  },
  required: ['tasksFound', 'summaryMarkdown'],
  additionalProperties: false,
} as const;

function buildPrompt(file: DownloadedFile, text: string): string {
  return `Here is the content of the file "${file.fileName}":

<file_content>
${text}
</file_content>

Analyze the file content above and respond with the structured JSON described in your instructions.`;
}

interface ParsedTaskExtractionResult {
  tasksFound: TaskSolution[];
  summaryMarkdown: string;
}

function parseModelJson(rawText: string, fileName: string): unknown {
  try {
    return JSON.parse(rawText);
  } catch (cause) {
    throw new Error(
      `claude/processFile: Claude's response for "${fileName}" was not valid JSON: ${
        cause instanceof Error ? cause.message : String(cause)
      }. Raw response (truncated): ${rawText.slice(0, 500)}`,
    );
  }
}

function validateTaskExtractionShape(raw: unknown, fileName: string): ParsedTaskExtractionResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`claude/processFile: Claude's response for "${fileName}" was not a JSON object.`);
  }

  const obj = raw as Record<string, unknown>;

  if (!Array.isArray(obj.tasksFound)) {
    throw new Error(`claude/processFile: Claude's response for "${fileName}" is missing a "tasksFound" array.`);
  }

  if (typeof obj.summaryMarkdown !== 'string') {
    throw new Error(`claude/processFile: Claude's response for "${fileName}" is missing a "summaryMarkdown" string.`);
  }

  const tasksFound: TaskSolution[] = obj.tasksFound.map((task, index) => {
    if (typeof task !== 'object' || task === null || Array.isArray(task)) {
      throw new Error(
        `claude/processFile: task at index ${index} in Claude's response for "${fileName}" is not an object.`,
      );
    }
    const taskObj = task as Record<string, unknown>;
    if (typeof taskObj.taskDescription !== 'string' || typeof taskObj.proposedSolution !== 'string') {
      throw new Error(
        `claude/processFile: task at index ${index} in Claude's response for "${fileName}" is missing ` +
          `"taskDescription" or "proposedSolution" (or they are not strings).`,
      );
    }
    return {
      taskDescription: taskObj.taskDescription,
      proposedSolution: taskObj.proposedSolution,
    };
  });

  return { tasksFound, summaryMarkdown: obj.summaryMarkdown };
}

export interface CreateFileProcessorOptions {
  /**
   * Injectable SDK query function — defaults to the real `query()` export from
   * `@anthropic-ai/claude-agent-sdk`. Tests pass a stub/mock here instead of hitting
   * the network.
   */
  queryFn?: QueryFn;
}

/**
 * Creates a {@link FileProcessor} backed by the Claude Agent SDK.
 *
 * See the module-level comment for the SDK usage rationale, and the comment above
 * `TASK_EXTRACTION_SYSTEM_PROMPT` for what "open task" means here (an open, swappable
 * product decision).
 */
export function createFileProcessor(options: CreateFileProcessorOptions = {}): FileProcessor {
  const queryFn: QueryFn = options.queryFn ?? sdkQuery;

  return {
    async processFile(file: DownloadedFile): Promise<ProcessedFileResult> {
      // Fail fast on a missing API key. The Claude Agent SDK spawns a subprocess that
      // reads ANTHROPIC_API_KEY from the inherited environment itself (we don't pass it
      // explicitly via `options.env`), so this check doesn't feed the key into the SDK —
      // it just surfaces a clear error immediately instead of a confusing failure deep
      // inside the subprocess.
      config.anthropic.apiKey();

      if (!isPlainTextFile(file)) {
        throw new Error(
          `claude/processFile: unsupported file type for "${file.fileName}" (mimeType: "${file.mimeType}"). ` +
            'Only plain-text formats (.txt, .md) are currently supported; binary formats like ' +
            '.docx/.pdf are not yet implemented (see TODO in src/claude/processFile.ts).',
        );
      }

      const text = file.content.toString('utf-8');
      const prompt = buildPrompt(file, text);

      logger.info({ fileName: file.fileName, mimeType: file.mimeType }, 'Sending file to Claude for task extraction');

      let resultMessage: Extract<SDKMessage, { type: 'result' }> | undefined;

      for await (const message of queryFn({
        prompt,
        options: {
          systemPrompt: TASK_EXTRACTION_SYSTEM_PROMPT,
          // No filesystem/bash/etc. access needed — we embed the file text directly in
          // the prompt and only want a structured JSON response back.
          tools: [],
          maxTurns: 3,
          outputFormat: { type: 'json_schema', schema: RESULT_JSON_SCHEMA },
        },
      })) {
        if (message.type === 'result') {
          resultMessage = message;
        }
      }

      if (!resultMessage) {
        logger.error({ fileName: file.fileName }, 'Claude Agent SDK query produced no result message');
        throw new Error(`claude/processFile: received no result from Claude for "${file.fileName}".`);
      }

      if (resultMessage.subtype !== 'success') {
        logger.error(
          { fileName: file.fileName, subtype: resultMessage.subtype, errors: resultMessage.errors },
          'Claude Agent SDK query did not succeed',
        );
        throw new Error(
          `claude/processFile: Claude query failed for "${file.fileName}" (${resultMessage.subtype}): ` +
            `${resultMessage.errors?.join('; ') ?? 'unknown error'}`,
        );
      }

      // Prefer the SDK's validated structured_output (populated because we set
      // `outputFormat`); fall back to parsing the plain-text `result` field in case a
      // caller/mocked SDK build doesn't populate structured_output.
      const raw = resultMessage.structured_output ?? parseModelJson(resultMessage.result, file.fileName);
      const parsed = validateTaskExtractionShape(raw, file.fileName);

      logger.info(
        { fileName: file.fileName, tasksFound: parsed.tasksFound.length },
        'Claude task extraction complete',
      );

      return {
        originalFileName: file.fileName,
        tasksFound: parsed.tasksFound,
        summaryMarkdown: parsed.summaryMarkdown,
      };
    },
  };
}
