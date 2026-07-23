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

const PASS1_OUTPUT = {
  isMaterialblatt: false,
  fach: 'BGWP',
  thema: 'Kaufvertragsrecht',
};

const PASS2_OUTPUT = {
  tasksFound: [
    {
      title: 'Mangelhafte Lieferung',
      taskDescription: 'Welche Rechte hat der Käufer bei einem Sachmangel?',
      proposedSolution: 'Nacherfüllung nach § 439 BGB.',
      quelle: '§ 437, § 439 BGB',
    },
  ],
};

function createDoubleFakeQuery(pass1Overrides?: any, pass2Overrides?: any) {
  let callCount = 0;
  return async function* fakeQuery(params: any): AsyncGenerator<SDKMessage> {
    callCount++;
    if (callCount === 1) {
      if (pass1Overrides?.error) {
         yield makeResultMessage(pass1Overrides.error);
         return;
      }
      if (pass1Overrides?.empty) return;
      
      const out = pass1Overrides?.output || PASS1_OUTPUT;
      yield makeResultMessage({
        subtype: 'success',
        result: JSON.stringify(out),
        structured_output: out,
      });
    } else {
      if (pass2Overrides?.error) {
         yield makeResultMessage(pass2Overrides.error);
         return;
      }
      if (pass2Overrides?.empty) return;
      
      const out = pass2Overrides?.output || PASS2_OUTPUT;
      yield makeResultMessage({
        subtype: 'success',
        result: JSON.stringify(out),
        structured_output: out,
      });
    }
  };
}

describe('createFileProcessor', () => {
  it('returns a correctly parsed ProcessedFileResult given a well-formed SDK response', async () => {
    const processor = createFileProcessor({ queryFn: createDoubleFakeQuery() as any });
    const result = await processor.processFile('arbeitsblatt1.pdf', makeExtraction());

    expect(result).toEqual({
      originalFileName: 'arbeitsblatt1.pdf',
      isMaterialblatt: false,
      fach: 'BGWP',
      thema: 'Kaufvertragsrecht',
      tasksFound: PASS2_OUTPUT.tasksFound,
    });
  });

  it('passes model=claude-sonnet-5 to the SDK for pass 2 by default', async () => {
    let capturedModelPass2: unknown;
    let callCount = 0;
    async function* fakeQuery(params: { prompt: unknown; options?: { model?: string } }): AsyncGenerator<SDKMessage> {
      callCount++;
      if (callCount === 1) {
        yield makeResultMessage({
          subtype: 'success',
          result: JSON.stringify(PASS1_OUTPUT),
          structured_output: PASS1_OUTPUT,
        });
      } else {
        capturedModelPass2 = params.options?.model;
        yield makeResultMessage({
          subtype: 'success',
          result: JSON.stringify(PASS2_OUTPUT),
          structured_output: PASS2_OUTPUT,
        });
      }
    }

    const processor = createFileProcessor({ queryFn: fakeQuery as any });
    await processor.processFile('arbeitsblatt1.pdf', makeExtraction());

    expect(capturedModelPass2).toBe('claude-sonnet-5');
  });

  it('includes the extracted markdown in a plain string prompt when there are no vision pages', async () => {
    let capturedPrompt: unknown;
    let callCount = 0;
    async function* fakeQuery(params: { prompt: unknown }): AsyncGenerator<SDKMessage> {
      callCount++;
      if (callCount === 1) {
        capturedPrompt = params.prompt;
        yield makeResultMessage({
          subtype: 'success',
          result: JSON.stringify(PASS1_OUTPUT),
          structured_output: PASS1_OUTPUT,
        });
      } else {
        yield makeResultMessage({
          subtype: 'success',
          result: JSON.stringify(PASS2_OUTPUT),
          structured_output: PASS2_OUTPUT,
        });
      }
    }

    const processor = createFileProcessor({ queryFn: fakeQuery as any });
    await processor.processFile('arbeitsblatt1.pdf', makeExtraction());

    expect(typeof capturedPrompt).toBe('string');
    expect(capturedPrompt as string).toContain('Welche Rechte hat der Käufer');
  });

  it('sends an async-iterable multi-content prompt with image blocks when vision pages are present', async () => {
    let capturedPrompt: unknown;
    let callCount = 0;
    async function* fakeQuery(params: { prompt: unknown }): AsyncGenerator<SDKMessage> {
      callCount++;
      if (callCount === 1) {
        capturedPrompt = params.prompt;
        yield makeResultMessage({
          subtype: 'success',
          result: JSON.stringify(PASS1_OUTPUT),
          structured_output: PASS1_OUTPUT,
        });
      } else {
        yield makeResultMessage({
          subtype: 'success',
          result: JSON.stringify(PASS2_OUTPUT),
          structured_output: PASS2_OUTPUT,
        });
      }
    }

    const processor = createFileProcessor({
      queryFn: fakeQuery as any,
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
    const processor = createFileProcessor({ queryFn: createDoubleFakeQuery({ output: { unrelated: true } }) as any });
    await expect(processor.processFile('arbeitsblatt1.pdf', makeExtraction())).rejects.toThrow(/isMaterialblatt/);
  });

  it('throws a clear error when the SDK query itself fails (non-success subtype)', async () => {
    const processor = createFileProcessor({ queryFn: createDoubleFakeQuery({ error: { subtype: 'error_during_execution', errors: ['model overloaded'] } }) as any });
    await expect(processor.processFile('arbeitsblatt1.pdf', makeExtraction())).rejects.toThrow(/Claude query failed/);
  });

  it('throws a clear error when the SDK yields no result message at all', async () => {
    const processor = createFileProcessor({ queryFn: createDoubleFakeQuery({ empty: true }) as any });
    await expect(processor.processFile('arbeitsblatt1.pdf', makeExtraction())).rejects.toThrow(/received no result/);
  });

  it('includes sibling filenames and excerpts in the prompt when siblings are provided', async () => {
    let capturedPrompt: unknown;
    let callCount = 0;
    async function* fakeQuery(params: { prompt: unknown }): AsyncGenerator<SDKMessage> {
      callCount++;
      if (callCount === 1) {
        capturedPrompt = params.prompt;
        yield makeResultMessage({
          subtype: 'success',
          result: JSON.stringify(PASS1_OUTPUT),
          structured_output: PASS1_OUTPUT,
        });
      } else {
        yield makeResultMessage({
          subtype: 'success',
          result: JSON.stringify(PASS2_OUTPUT),
          structured_output: PASS2_OUTPUT,
        });
      }
    }

    const processor = createFileProcessor({ queryFn: fakeQuery as any });
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

  it('wraps each sibling excerpt in a <sibling_file> tag, mirroring the <file_content> wrapper on the primary file', async () => {
    let capturedPrompt: unknown;
    let callCount = 0;
    async function* fakeQuery(params: { prompt: unknown }): AsyncGenerator<SDKMessage> {
      callCount++;
      if (callCount === 1) {
        capturedPrompt = params.prompt;
        yield makeResultMessage({
          subtype: 'success',
          result: JSON.stringify(PASS1_OUTPUT),
          structured_output: PASS1_OUTPUT,
        });
      } else {
        yield makeResultMessage({
          subtype: 'success',
          result: JSON.stringify(PASS2_OUTPUT),
          structured_output: PASS2_OUTPUT,
        });
      }
    }

    const processor = createFileProcessor({ queryFn: fakeQuery as any });
    await processor.processFile('arbeitsblatt1.pdf', makeExtraction(), [
      { fileName: 'lieferant-a.pdf', excerpt: 'some excerpt text' },
    ]);

    const prompt = capturedPrompt as string;
    expect(prompt).toContain('<sibling_file name="lieferant-a.pdf">\nsome excerpt text\n</sibling_file>');
  });

  it('produces a prompt byte-identical to the no-siblings case when siblings is an empty array', async () => {
    let promptWithoutArg: unknown;
    let promptWithEmptyArray: unknown;

    let callCount1 = 0;
    const processor1 = createFileProcessor({
      queryFn: async function* (params) {
        callCount1++;
        if (callCount1 === 1) {
          promptWithoutArg = params.prompt;
          yield makeResultMessage({
            subtype: 'success',
            result: JSON.stringify(PASS1_OUTPUT),
            structured_output: PASS1_OUTPUT,
          });
        } else {
          yield makeResultMessage({
            subtype: 'success',
            result: JSON.stringify(PASS2_OUTPUT),
            structured_output: PASS2_OUTPUT,
          });
        }
      } as any,
    });
    await processor1.processFile('arbeitsblatt1.pdf', makeExtraction());

    let callCount2 = 0;
    const processor2 = createFileProcessor({
      queryFn: async function* (params) {
        callCount2++;
        if (callCount2 === 1) {
          promptWithEmptyArray = params.prompt;
          yield makeResultMessage({
            subtype: 'success',
            result: JSON.stringify(PASS1_OUTPUT),
            structured_output: PASS1_OUTPUT,
          });
        } else {
          yield makeResultMessage({
            subtype: 'success',
            result: JSON.stringify(PASS2_OUTPUT),
            structured_output: PASS2_OUTPUT,
          });
        }
      } as any,
    });
    await processor2.processFile('arbeitsblatt1.pdf', makeExtraction(), []);

    expect(promptWithEmptyArray).toBe(promptWithoutArg);
  });

  it('returns isMaterialblatt=true with an empty tasksFound for reference material', async () => {
    const materialOutput = { isMaterialblatt: true, fach: 'Deutsch', thema: 'Grammatikregeln' };
    const processor = createFileProcessor({ queryFn: createDoubleFakeQuery({ output: materialOutput }) as any });
    const result = await processor.processFile('handout.pdf', makeExtraction());

    expect(result.isMaterialblatt).toBe(true);
    expect(result.tasksFound).toEqual([]);
  });
});
