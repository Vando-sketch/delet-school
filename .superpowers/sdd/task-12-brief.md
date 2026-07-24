### Task 12: Claude solve step rewrite

**Files:**
- Modify: `src/claude/processFile.ts` (full rewrite of prompt/schema/model, new signature)
- Modify: `test/processFile.test.ts` (full rewrite for the new interface)

**Interfaces:**
- Consumes: `ExtractionResult`, `VisionPage`, `ProcessedFileResult`, `TaskSolution`, `FileProcessor` (Task 2); `FACH_KEYS`, `FachKey` (Task 2, `src/fach.ts`).
- Produces: `createFileProcessor(options?: { queryFn?: QueryFn }): FileProcessor` where `FileProcessor.processFile(fileName: string, extraction: ExtractionResult): Promise<ProcessedFileResult>` — consumed by Task 14 (`worker/index.ts`).

- [ ] **Step 1: Write the failing tests (full rewrite of the test file)**

```ts
// test/processFile.test.ts
import { describe, expect, it } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { createFileProcessor } from '../src/claude/processFile.js';
import type { ExtractionResult } from '../src/types.js';

process.env.ANTHROPIC_API_KEY ??= 'test-api-key';

function makeExtraction(overrides: Partial<ExtractionResult> = {}): ExtractionResult {
  return {
    markdown: '# Arbeitsblatt\n\nAufgabe 1: Welche Rechte hat der Käufer bei einem Sachmangel?',
    visionPages: [],
    ranOcr: false,
    archivalPdfPath: '/inbox/arbeitsblatt1.pdf',
    ...overrides,
  };
}

function makeResultMessage(fields: Record<string, unknown>): SDKMessage {
  return {
    type: 'result',
    duration_ms: 100,
    duration_api_ms: 90,
    is_error: false,
    num_turns: 1,
    stop_reason: null,
    total_cost_usd: 0,
    usage: {},
    modelUsage: {},
    permission_denials: [],
    uuid: 'test-uuid',
    session_id: 'test-session',
    ...fields,
  } as unknown as SDKMessage;
}

const VALID_STRUCTURED_OUTPUT = {
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
};

describe('createFileProcessor', () => {
  it('returns a correctly parsed ProcessedFileResult given a well-formed SDK response', async () => {
    async function* fakeQuery(): AsyncGenerator<SDKMessage> {
      yield makeResultMessage({
        subtype: 'success',
        result: JSON.stringify(VALID_STRUCTURED_OUTPUT),
        structured_output: VALID_STRUCTURED_OUTPUT,
      });
    }

    const processor = createFileProcessor({ queryFn: fakeQuery });
    const result = await processor.processFile('arbeitsblatt1.pdf', makeExtraction());

    expect(result).toEqual({
      originalFileName: 'arbeitsblatt1.pdf',
      isMaterialblatt: false,
      fach: 'BGWP',
      thema: 'Kaufvertragsrecht',
      tasksFound: VALID_STRUCTURED_OUTPUT.tasksFound,
    });
  });

  it('passes model=claude-sonnet-5 to the SDK by default', async () => {
    let capturedModel: unknown;
    async function* fakeQuery(params: { prompt: string; options?: { model?: string } }): AsyncGenerator<SDKMessage> {
      capturedModel = params.options?.model;
      yield makeResultMessage({
        subtype: 'success',
        result: JSON.stringify(VALID_STRUCTURED_OUTPUT),
        structured_output: VALID_STRUCTURED_OUTPUT,
      });
    }

    const processor = createFileProcessor({ queryFn: fakeQuery });
    await processor.processFile('arbeitsblatt1.pdf', makeExtraction());

    expect(capturedModel).toBe('claude-sonnet-5');
  });

  it('includes the extracted markdown in a plain string prompt when there are no vision pages', async () => {
    let capturedPrompt: unknown;
    async function* fakeQuery(params: { prompt: unknown }): AsyncGenerator<SDKMessage> {
      capturedPrompt = params.prompt;
      yield makeResultMessage({
        subtype: 'success',
        result: JSON.stringify(VALID_STRUCTURED_OUTPUT),
        structured_output: VALID_STRUCTURED_OUTPUT,
      });
    }

    const processor = createFileProcessor({ queryFn: fakeQuery });
    await processor.processFile('arbeitsblatt1.pdf', makeExtraction());

    expect(typeof capturedPrompt).toBe('string');
    expect(capturedPrompt as string).toContain('Welche Rechte hat der Käufer');
  });

  it('sends an async-iterable multi-content prompt with image blocks when vision pages are present', async () => {
    let capturedPrompt: unknown;
    async function* fakeQuery(params: { prompt: unknown }): AsyncGenerator<SDKMessage> {
      capturedPrompt = params.prompt;
      yield makeResultMessage({
        subtype: 'success',
        result: JSON.stringify(VALID_STRUCTURED_OUTPUT),
        structured_output: VALID_STRUCTURED_OUTPUT,
      });
    }

    const processor = createFileProcessor({
      queryFn: fakeQuery,
      readImageFile: async () => Buffer.from('fake-png-bytes'),
    });
    const extraction = makeExtraction({ visionPages: [{ pageNumber: 1, imagePath: '/tmp/page-1.png' }] });

    await processor.processFile('handwritten.pdf', extraction);

    expect(typeof capturedPrompt).toBe('object');
    const messages: Array<{ message: { content: Array<{ type: string }> } }> = [];
    for await (const message of capturedPrompt as AsyncIterable<{ message: { content: Array<{ type: string }> } }>) {
      messages.push(message);
    }
    expect(messages).toHaveLength(1);
    const blockTypes = messages[0]?.message.content.map((block) => block.type);
    expect(blockTypes).toEqual(['text', 'image']);
  });

  it('throws a clear error when the parsed JSON is missing required fields', async () => {
    async function* fakeQuery(): AsyncGenerator<SDKMessage> {
      yield makeResultMessage({
        subtype: 'success',
        result: JSON.stringify({ unrelated: true }),
        structured_output: { unrelated: true },
      });
    }

    const processor = createFileProcessor({ queryFn: fakeQuery });

    await expect(processor.processFile('arbeitsblatt1.pdf', makeExtraction())).rejects.toThrow(/isMaterialblatt/);
  });

  it('throws a clear error when the SDK query itself fails (non-success subtype)', async () => {
    async function* fakeQuery(): AsyncGenerator<SDKMessage> {
      yield makeResultMessage({ subtype: 'error_during_execution', errors: ['model overloaded'] });
    }

    const processor = createFileProcessor({ queryFn: fakeQuery });

    await expect(processor.processFile('arbeitsblatt1.pdf', makeExtraction())).rejects.toThrow(/Claude query failed/);
  });

  it('throws a clear error when the SDK yields no result message at all', async () => {
    async function* fakeQuery(): AsyncGenerator<SDKMessage> {
      // yields nothing
    }

    const processor = createFileProcessor({ queryFn: fakeQuery });

    await expect(processor.processFile('arbeitsblatt1.pdf', makeExtraction())).rejects.toThrow(/received no result/);
  });

  it('returns isMaterialblatt=true with an empty tasksFound for reference material', async () => {
    const materialOutput = { isMaterialblatt: true, fach: 'Deutsch', thema: 'Grammatikregeln', tasksFound: [] };
    async function* fakeQuery(): AsyncGenerator<SDKMessage> {
      yield makeResultMessage({
        subtype: 'success',
        result: JSON.stringify(materialOutput),
        structured_output: materialOutput,
      });
    }

    const processor = createFileProcessor({ queryFn: fakeQuery });
    const result = await processor.processFile('handout.pdf', makeExtraction());

    expect(result.isMaterialblatt).toBe(true);
    expect(result.tasksFound).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- test/processFile.test.ts`
Expected: FAIL — old `processFile.ts` doesn't accept `(fileName, extraction)`, doesn't export the new fields, etc.

- [ ] **Step 3: Rewrite `src/claude/processFile.ts`**

```ts
// src/claude/processFile.ts
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- test/processFile.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors in `src/claude/processFile.ts` or `test/processFile.test.ts`. If the `ImageBlockParam`/`TextBlockParam` literal shapes in `buildVisionPrompt` don't structurally satisfy `MessageParam.content`, adjust the literal fields to match (add/remove optional fields) until it compiles — do not weaken this to `as any`.

- [ ] **Step 6: Commit**

```bash
git add src/claude/processFile.ts test/processFile.test.ts
git commit -m "feat: rewrite Claude solve step for Fach classification, Materialblatt routing, and vision fallback"
```

---

