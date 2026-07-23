import { readFile as fsReadFile } from 'node:fs/promises';
import { query as sdkQuery, type Options, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import pino from 'pino';
import { config } from '../config/index.js';
import { FACH_KEYS, type FachKey } from '../fach.js';
import type { ExtractionResult, FileProcessor, ProcessedFileResult, TaskSolution, VisionPage } from '../types.js';

const logger = pino({ name: 'claude-file-processor' });

/**
 * The Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) is Claude Code packaged as a
 * library — `query()` returns an async generator of `SDKMessage` events and drives the
 * full Claude Code harness. We disable all built-in tools (`tools: []`) and rely on the
 * SDK's native structured-output support (`outputFormat: { type: 'json_schema', ... }`).
 * When the extraction stage produced page images for the vision fallback, `prompt` is an
 * async-iterable of `SDKUserMessage` carrying image content blocks instead of a plain
 * string, per the SDK's streaming input mode.
 */

type QueryFn = (params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }) => AsyncIterable<SDKMessage>;
type ReadImageFileFn = (path: string) => Promise<Buffer>;

const SYSTEM_PROMPT = `Du bist ein Assistent, der Schulunterlagen liest, Aufgaben löst und Materialblätter erkennt.

Klassifiziere zuerst, ob das Dokument ein Aufgabenblatt (enthält zu lösende Aufgaben) oder ein
reines Info-/Materialblatt (Fakten, Gesetzestexte, Merkblatt - keine Aufgaben) ist.

Bestimme das Fach über den festen Fach-Schlüssel (siehe Enum im Schema). Bilde lose oder
synonyme Bezeichnungen aggressiv auf den passenden festen Schlüssel ab (z.B. "Mathe" oder
"Informationstechnik" auf den nächstliegenden Eintrag), statt eine Abweichung als
unklassifizierbar zu behandeln. Wenn wirklich kein Schlüssel passt, verwende "_Unsortiert".

Falls Seitenbilder mitgeliefert werden (Vision-Fallback für schlecht lesbare/handschriftliche
Seiten), sind diese Bilder für die jeweilige Seite maßgeblich - ignoriere dafür etwaigen
verstümmelten Text aus dem Markdown für dieselbe Seite.

Löse jede Aufgabe vollständig und präzise, ohne Füllsätze. Nenne Paragraphen, Kategorien oder
Quellen im "quelle"-Feld, wo zutreffend. Wenn das Dokument keine Aufgaben enthält (Materialblatt),
gib ein leeres "tasksFound"-Array zurück.

Antworte ausschließlich mit dem im Schema beschriebenen JSON.`;

const RESULT_JSON_SCHEMA = {
  type: 'object',
  properties: {
    isMaterialblatt: { type: 'boolean', description: 'true wenn das Dokument keine zu lösenden Aufgaben enthält.' },
    fach: { type: 'string', enum: [...FACH_KEYS], description: 'Fester Fach-Schlüssel.' },
    lernfeld: { type: 'string', description: 'Optionales Kapitel/Lernfeld, falls im Dokument erkennbar.' },
    thema: { type: 'string', description: 'Kurzes Thema des Dokuments.' },
    tasksFound: {
      type: 'array',
      description: 'Jede gefundene Aufgabe mit vollständiger Lösung. Leer bei einem Materialblatt.',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Kurztitel für die Überschrift.' },
          taskDescription: { type: 'string', description: 'Vollständiger Aufgabentext.' },
          proposedSolution: { type: 'string', description: 'Vollständige, konkrete Lösung.' },
          quelle: { type: 'string', description: 'Paragraphen/Quellen/Kategorie, falls zutreffend.' },
        },
        required: ['title', 'taskDescription', 'proposedSolution'],
        additionalProperties: false,
      },
    },
  },
  required: ['isMaterialblatt', 'fach', 'thema', 'tasksFound'],
  additionalProperties: false,
} as const;

function buildPromptText(fileName: string, extraction: ExtractionResult): string {
  const visionNote =
    extraction.visionPages.length > 0
      ? `\n\nHinweis: Für die Seite(n) ${extraction.visionPages.map((p) => p.pageNumber).join(', ')} sind Bilder beigefügt - nutze diese als Quelle, nicht den Markdown-Text für diese Seiten.`
      : '';
  return `Hier ist der extrahierte Inhalt der Datei "${fileName}":

<file_content>
${extraction.markdown}
</file_content>${visionNote}

Analysiere den Inhalt und antworte mit dem im Schema beschriebenen JSON.`;
}

async function* buildVisionPrompt(
  promptText: string,
  visionPages: VisionPage[],
  readImageFile: ReadImageFileFn,
): AsyncGenerator<SDKUserMessage> {
  const imageBlocks = await Promise.all(
    visionPages.map(async (page) => ({
      type: 'image' as const,
      source: { type: 'base64' as const, media_type: 'image/png' as const, data: (await readImageFile(page.imagePath)).toString('base64') },
    })),
  );
  yield {
    type: 'user',
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: [{ type: 'text' as const, text: promptText }, ...imageBlocks],
    },
  };
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

function validateShape(raw: unknown, fileName: string): ProcessedFileResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`claude/processFile: Claude's response for "${fileName}" was not a JSON object.`);
  }
  const obj = raw as Record<string, unknown>;

  if (typeof obj.isMaterialblatt !== 'boolean') {
    throw new Error(`claude/processFile: Claude's response for "${fileName}" is missing "isMaterialblatt".`);
  }
  if (typeof obj.fach !== 'string' || !(FACH_KEYS as readonly string[]).includes(obj.fach)) {
    throw new Error(`claude/processFile: Claude's response for "${fileName}" has an invalid "fach".`);
  }
  if (typeof obj.thema !== 'string') {
    throw new Error(`claude/processFile: Claude's response for "${fileName}" is missing "thema".`);
  }
  if (!Array.isArray(obj.tasksFound)) {
    throw new Error(`claude/processFile: Claude's response for "${fileName}" is missing a "tasksFound" array.`);
  }

  const tasksFound: TaskSolution[] = obj.tasksFound.map((task, index) => {
    if (typeof task !== 'object' || task === null || Array.isArray(task)) {
      throw new Error(`claude/processFile: task at index ${index} for "${fileName}" is not an object.`);
    }
    const t = task as Record<string, unknown>;
    if (typeof t.title !== 'string' || typeof t.taskDescription !== 'string' || typeof t.proposedSolution !== 'string') {
      throw new Error(`claude/processFile: task at index ${index} for "${fileName}" is missing required fields.`);
    }
    return {
      title: t.title,
      taskDescription: t.taskDescription,
      proposedSolution: t.proposedSolution,
      ...(typeof t.quelle === 'string' ? { quelle: t.quelle } : {}),
    };
  });

  return {
    originalFileName: fileName,
    isMaterialblatt: obj.isMaterialblatt,
    fach: obj.fach as FachKey,
    ...(typeof obj.lernfeld === 'string' ? { lernfeld: obj.lernfeld } : {}),
    thema: obj.thema,
    tasksFound,
  };
}

export interface CreateFileProcessorOptions {
  queryFn?: QueryFn;
  readImageFile?: ReadImageFileFn;
}

export function createFileProcessor(options: CreateFileProcessorOptions = {}): FileProcessor {
  const queryFn: QueryFn = options.queryFn ?? sdkQuery;
  const readImageFile: ReadImageFileFn = options.readImageFile ?? ((path: string) => fsReadFile(path));

  return {
    async processFile(fileName: string, extraction: ExtractionResult): Promise<ProcessedFileResult> {
      if (!config.anthropic.apiKey()) {
        logger.info('ANTHROPIC_API_KEY not set; relying on Claude Code subscription login (`claude login`)');
      }

      const promptText = buildPromptText(fileName, extraction);
      const prompt: string | AsyncIterable<SDKUserMessage> =
        extraction.visionPages.length > 0 ? buildVisionPrompt(promptText, extraction.visionPages, readImageFile) : promptText;

      logger.info({ fileName, visionPages: extraction.visionPages.length }, 'Sending file to Claude for solving');

      let resultMessage: Extract<SDKMessage, { type: 'result' }> | undefined;

      for await (const message of queryFn({
        prompt,
        options: {
          systemPrompt: SYSTEM_PROMPT,
          model: config.anthropic.model,
          tools: [],
          maxTurns: 3,
          outputFormat: { type: 'json_schema', schema: RESULT_JSON_SCHEMA },
        },
      })) {
        if (message.type === 'system' && message.subtype === 'init') {
          logger.info({ fileName, apiKeySource: message.apiKeySource }, 'Claude Agent SDK session started');
        }
        if (message.type === 'result') {
          resultMessage = message;
        }
      }

      if (!resultMessage) {
        logger.error({ fileName }, 'Claude Agent SDK query produced no result message');
        throw new Error(`claude/processFile: received no result from Claude for "${fileName}".`);
      }

      if (resultMessage.subtype !== 'success') {
        logger.error({ fileName, subtype: resultMessage.subtype, errors: resultMessage.errors }, 'Claude Agent SDK query did not succeed');
        throw new Error(
          `claude/processFile: Claude query failed for "${fileName}" (${resultMessage.subtype}): ${resultMessage.errors?.join('; ') ?? 'unknown error'}`,
        );
      }

      const raw = resultMessage.structured_output ?? parseModelJson(resultMessage.result, fileName);
      const result = validateShape(raw, fileName);

      logger.info({ fileName, isMaterialblatt: result.isMaterialblatt, tasksFound: result.tasksFound.length }, 'Claude solve complete');

      return result;
    },
  };
}
