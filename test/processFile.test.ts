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
    async function* fakeQuery(params: { prompt: unknown; options?: { model?: string } }): AsyncGenerator<SDKMessage> {
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

  it('includes sibling filenames and excerpts in the prompt when siblings are provided', async () => {
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
    await processor.processFile('arbeitsblatt1.pdf', makeExtraction(), [
      { fileName: 'lieferant-a.pdf', excerpt: 'Fachbereich IT/Elektrotechnik - Angebot Lieferant A' },
      { fileName: 'vorlage.docx', excerpt: 'Lieferant: | Lieferant: | Lieferant:' },
    ]);

    expect(typeof capturedPrompt).toBe('string');
    const prompt = capturedPrompt as string;
    expect(prompt).toContain('lieferant-a.pdf');
    expect(prompt).toContain('Fachbereich IT/Elektrotechnik - Angebot Lieferant A');
    expect(prompt).toContain('vorlage.docx');
    expect(prompt).toContain('Lieferant: | Lieferant: | Lieferant:');
  });

  it('produces a prompt byte-identical to the no-siblings case when siblings is an empty array', async () => {
    let promptWithoutArg: unknown;
    let promptWithEmptyArray: unknown;

    async function* succeed(): AsyncGenerator<SDKMessage> {
      yield makeResultMessage({
        subtype: 'success',
        result: JSON.stringify(VALID_STRUCTURED_OUTPUT),
        structured_output: VALID_STRUCTURED_OUTPUT,
      });
    }

    const processor1 = createFileProcessor({
      queryFn: async function* (params) {
        promptWithoutArg = params.prompt;
        yield* succeed();
      },
    });
    await processor1.processFile('arbeitsblatt1.pdf', makeExtraction());

    const processor2 = createFileProcessor({
      queryFn: async function* (params) {
        promptWithEmptyArray = params.prompt;
        yield* succeed();
      },
    });
    await processor2.processFile('arbeitsblatt1.pdf', makeExtraction(), []);

    expect(promptWithEmptyArray).toBe(promptWithoutArg);
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
