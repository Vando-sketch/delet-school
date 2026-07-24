import { describe, expect, it } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { createFileProcessor, type QueryFn } from '../src/claude/processFile.js';
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

function createDoubleFakeQuery(
  pass1Overrides?: { error?: Record<string, unknown>; empty?: boolean; output?: unknown },
  pass2Overrides?: { error?: Record<string, unknown>; empty?: boolean; output?: unknown },
): QueryFn {
  let callCount = 0;
  const fakeQuery: QueryFn = async function* (_params) {
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
  return fakeQuery;
}

const failingAgyRunner = async () => ({ stdout: '', stderr: '', exitCode: 1 });

describe('createFileProcessor', () => {
  it('returns a correctly parsed ProcessedFileResult given a well-formed SDK response', async () => {
    const processor = createFileProcessor({ queryFn: createDoubleFakeQuery(), agyRunner: failingAgyRunner });
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
    const fakeQuery: QueryFn = async function* (params) {
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
    };

    const processor = createFileProcessor({ queryFn: fakeQuery, agyRunner: failingAgyRunner });
    await processor.processFile('arbeitsblatt1.pdf', makeExtraction());

    expect(capturedModelPass2).toBe('claude-sonnet-5');
  });

  it('includes the extracted markdown in a plain string prompt when there are no vision pages', async () => {
    let capturedPrompt: unknown;
    let callCount = 0;
    const fakeQuery: QueryFn = async function* (params) {
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
    };

    const processor = createFileProcessor({ queryFn: fakeQuery, agyRunner: failingAgyRunner });
    await processor.processFile('arbeitsblatt1.pdf', makeExtraction());

    expect(typeof capturedPrompt).toBe('string');
    expect(capturedPrompt as string).toContain('Welche Rechte hat der Käufer');
  });

  it('sends an async-iterable multi-content prompt with image blocks when vision pages are present', async () => {
    let capturedPrompt: unknown;
    let callCount = 0;
    const fakeQuery: QueryFn = async function* (params) {
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
    };

    const processor = createFileProcessor({
      queryFn: fakeQuery,
      readImageFile: async () => Buffer.from('fake-png-bytes'),
      agyRunner: failingAgyRunner,
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
    const processor = createFileProcessor({ queryFn: createDoubleFakeQuery({ output: { unrelated: true } }), agyRunner: failingAgyRunner });
    await expect(processor.processFile('arbeitsblatt1.pdf', makeExtraction())).rejects.toThrow(/isMaterialblatt/);
  });

  it('throws a clear error when the SDK query itself fails (non-success subtype)', async () => {
    const processor = createFileProcessor({ queryFn: createDoubleFakeQuery({ error: { subtype: 'error_during_execution', errors: ['model overloaded'] } }), agyRunner: failingAgyRunner });
    await expect(processor.processFile('arbeitsblatt1.pdf', makeExtraction())).rejects.toThrow(/Claude query failed/);
  });

  it('throws a clear error when the SDK yields no result message at all', async () => {
    const processor = createFileProcessor({ queryFn: createDoubleFakeQuery({ empty: true }), agyRunner: failingAgyRunner });
    await expect(processor.processFile('arbeitsblatt1.pdf', makeExtraction())).rejects.toThrow(/received no result/);
  });

  it('includes sibling filenames and excerpts in the prompt when siblings are provided', async () => {
    let capturedPrompt: unknown;
    let callCount = 0;
    const fakeQuery: QueryFn = async function* (params) {
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
    };

    const processor = createFileProcessor({ queryFn: fakeQuery, agyRunner: failingAgyRunner });
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
    const fakeQuery: QueryFn = async function* (params) {
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
    };

    const processor = createFileProcessor({ queryFn: fakeQuery, agyRunner: failingAgyRunner });
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
    const fakeQuery1: QueryFn = async function* (params) {
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
    };
    const processor1 = createFileProcessor({
      queryFn: fakeQuery1,
      agyRunner: failingAgyRunner,
    });
    await processor1.processFile('arbeitsblatt1.pdf', makeExtraction());

    let callCount2 = 0;
    const fakeQuery2: QueryFn = async function* (params) {
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
    };
    const processor2 = createFileProcessor({
      queryFn: fakeQuery2,
      agyRunner: failingAgyRunner,
    });
    await processor2.processFile('arbeitsblatt1.pdf', makeExtraction(), []);

    expect(promptWithEmptyArray).toBe(promptWithoutArg);
  });

  it('returns isMaterialblatt=true with an empty tasksFound for reference material', async () => {
    const materialOutput = { isMaterialblatt: true, fach: 'Deutsch', thema: 'Grammatikregeln' };
    const processor = createFileProcessor({ queryFn: createDoubleFakeQuery({ output: materialOutput }), agyRunner: failingAgyRunner });
    const result = await processor.processFile('handout.pdf', makeExtraction());

    expect(result.isMaterialblatt).toBe(true);
    expect(result.tasksFound).toEqual([]);
  });

  describe('Gemini (agy) primary path and fallback', () => {
    it('uses Gemini primary for Pass 1 and Pass 2 when agy succeeds', async () => {
      let queryFnCalled = false;
      const fakeQuery: QueryFn = async function* () {
        queryFnCalled = true;
      };

      const capturedArgs: string[][] = [];
      const fakeAgyRunner = async (_cmd: string, args: string[]) => {
        capturedArgs.push(args);
        if (capturedArgs.length === 1) {
          return { stdout: JSON.stringify(PASS1_OUTPUT), stderr: '', exitCode: 0 };
        } else {
          return { stdout: JSON.stringify(PASS2_OUTPUT), stderr: '', exitCode: 0 };
        }
      };

      const processor = createFileProcessor({ queryFn: fakeQuery, agyRunner: fakeAgyRunner });
      const result = await processor.processFile('arbeitsblatt1.pdf', makeExtraction());

      expect(queryFnCalled).toBe(false);
      expect(result).toEqual({
        originalFileName: 'arbeitsblatt1.pdf',
        isMaterialblatt: false,
        fach: 'BGWP',
        thema: 'Kaufvertragsrecht',
        tasksFound: PASS2_OUTPUT.tasksFound,
      });

      expect(capturedArgs).toHaveLength(2);
      expect(capturedArgs[0]).toContain('--model');
      expect(capturedArgs[0]).toContain('gemini-3.6-flash');
      expect(capturedArgs[0]).toContain('--effort');
      expect(capturedArgs[0]).toContain('medium');

      expect(capturedArgs[1]).toContain('--model');
      expect(capturedArgs[1]).toContain('gemini-3.1-pro');
      expect(capturedArgs[1]).toContain('--effort');
      expect(capturedArgs[1]).toContain('high');
    });

    it('falls back to Claude when agy returns a non-zero exit code', async () => {
      const fakeAgyRunner = async () => ({ stdout: '', stderr: '', exitCode: 1 });
      const processor = createFileProcessor({ queryFn: createDoubleFakeQuery(), agyRunner: fakeAgyRunner });
      const result = await processor.processFile('arbeitsblatt1.pdf', makeExtraction());

      expect(result.fach).toBe('BGWP');
      expect(result.tasksFound).toHaveLength(1);
    });

    it('falls back to Claude when agy output is malformed JSON', async () => {
      const fakeAgyRunner = async () => ({ stdout: 'NOT VALID JSON', stderr: '', exitCode: 0 });
      const processor = createFileProcessor({ queryFn: createDoubleFakeQuery(), agyRunner: fakeAgyRunner });
      const result = await processor.processFile('arbeitsblatt1.pdf', makeExtraction());

      expect(result.fach).toBe('BGWP');
      expect(result.tasksFound).toHaveLength(1);
    });

    it('falls back to Claude when agy returns syntactically valid JSON that fails shape validation', async () => {
      const fakeAgyRunner = async () => ({ stdout: JSON.stringify({ unrelated: true }), stderr: '', exitCode: 0 });
      const processor = createFileProcessor({ queryFn: createDoubleFakeQuery(), agyRunner: fakeAgyRunner });
      const result = await processor.processFile('arbeitsblatt1.pdf', makeExtraction());

      expect(result.fach).toBe('BGWP');
      expect(result.tasksFound).toHaveLength(1);
    });

    it('throws error when both agy and Claude fail', async () => {
      const fakeAgyRunner = async () => ({ stdout: '', stderr: '', exitCode: 1 });
      const processor = createFileProcessor({
        queryFn: createDoubleFakeQuery({ error: { subtype: 'error_during_execution', errors: ['claude error'] } }),
        agyRunner: fakeAgyRunner,
      });

      await expect(processor.processFile('arbeitsblatt1.pdf', makeExtraction())).rejects.toThrow(/Claude query failed/);
    });

    it('passes --add-dir and --mode plan to agy when vision pages are present', async () => {
      const capturedArgs: string[][] = [];
      const fakeAgyRunner = async (_cmd: string, args: string[]) => {
        capturedArgs.push(args);
        if (capturedArgs.length === 1) {
          return { stdout: JSON.stringify(PASS1_OUTPUT), stderr: '', exitCode: 0 };
        } else {
          return { stdout: JSON.stringify(PASS2_OUTPUT), stderr: '', exitCode: 0 };
        }
      };

      const processor = createFileProcessor({ agyRunner: fakeAgyRunner });
      const extraction = makeExtraction({ visionPages: [{ pageNumber: 1, imagePath: '/tmp/job-1/page-1.png' }] });
      await processor.processFile('vision.pdf', extraction);

      expect(capturedArgs[0]).toContain('--add-dir');
      expect(capturedArgs[0]).toContain('/tmp/job-1');
      expect(capturedArgs[0]).toContain('--mode');
      expect(capturedArgs[0]).toContain('plan');
    });
  });
});
