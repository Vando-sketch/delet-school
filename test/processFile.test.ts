import { describe, expect, it } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { createFileProcessor } from '../src/claude/processFile.js';
import type { DownloadedFile } from '../src/types.js';

// The real SDK spawns a subprocess; nothing in this file ever reaches it — every test
// injects a fake `queryFn`. `config.anthropic.apiKey()` is still called for its fail-fast
// check, so give it a value (never used to authenticate anything, since we never hit the
// network in these tests).
process.env.ANTHROPIC_API_KEY ??= 'test-api-key';

function makeFile(overrides: Partial<DownloadedFile> = {}): DownloadedFile {
  return {
    fileName: 'notes.md',
    mimeType: 'text/markdown',
    content: Buffer.from('# Notes\n\n- [ ] Follow up with vendor about pricing\n'),
    ...overrides,
  };
}

// Builds a fake `result`-type SDKMessage. Cast through `unknown` rather than filling in
// every field of the real (large) SDKResultMessage union — processFile.ts only reads
// `type`, `subtype`, `result`, `structured_output`, and `errors`.
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

describe('createFileProcessor', () => {
  it('returns a correctly parsed ProcessedFileResult given a well-formed SDK response', async () => {
    const structuredOutput = {
      tasksFound: [
        {
          taskDescription: 'Follow up with vendor about pricing',
          proposedSolution: 'Email the vendor requesting an updated quote by Friday.',
        },
      ],
      summaryMarkdown: 'One open task found regarding vendor pricing follow-up.',
    };

    async function* fakeQuery(): AsyncGenerator<SDKMessage> {
      yield makeResultMessage({
        subtype: 'success',
        result: JSON.stringify(structuredOutput),
        structured_output: structuredOutput,
      });
    }

    const processor = createFileProcessor({ queryFn: fakeQuery });
    const file = makeFile();

    const result = await processor.processFile(file);

    expect(result).toEqual({
      originalFileName: 'notes.md',
      tasksFound: structuredOutput.tasksFound,
      summaryMarkdown: structuredOutput.summaryMarkdown,
    });
  });

  it('falls back to parsing the plain-text result field when structured_output is absent', async () => {
    const shape = {
      tasksFound: [
        { taskDescription: 'Decide on venue', proposedSolution: 'Book The Grand Hall by end of week.' },
      ],
      summaryMarkdown: 'One pending decision found.',
    };

    async function* fakeQuery(): AsyncGenerator<SDKMessage> {
      yield makeResultMessage({ subtype: 'success', result: JSON.stringify(shape) });
    }

    const processor = createFileProcessor({ queryFn: fakeQuery });
    const result = await processor.processFile(makeFile());

    expect(result.tasksFound).toEqual(shape.tasksFound);
    expect(result.summaryMarkdown).toBe(shape.summaryMarkdown);
  });

  it('throws a clear error given an unparseable (non-JSON) SDK response, rather than returning empty/garbage data', async () => {
    async function* fakeQuery(): AsyncGenerator<SDKMessage> {
      yield makeResultMessage({ subtype: 'success', result: 'this is not valid json {{{' });
    }

    const processor = createFileProcessor({ queryFn: fakeQuery });

    await expect(processor.processFile(makeFile())).rejects.toThrow(/not valid JSON/);
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

    await expect(processor.processFile(makeFile())).rejects.toThrow(/tasksFound/);
  });

  it('throws a clear error when a task entry is malformed', async () => {
    async function* fakeQuery(): AsyncGenerator<SDKMessage> {
      const bad = { tasksFound: [{ taskDescription: 'missing solution field' }], summaryMarkdown: 'x' };
      yield makeResultMessage({ subtype: 'success', result: JSON.stringify(bad), structured_output: bad });
    }

    const processor = createFileProcessor({ queryFn: fakeQuery });

    await expect(processor.processFile(makeFile())).rejects.toThrow(/proposedSolution/);
  });

  it('throws a clear error when the SDK query itself fails (non-success subtype)', async () => {
    async function* fakeQuery(): AsyncGenerator<SDKMessage> {
      yield makeResultMessage({ subtype: 'error_during_execution', errors: ['model overloaded'] });
    }

    const processor = createFileProcessor({ queryFn: fakeQuery });

    await expect(processor.processFile(makeFile())).rejects.toThrow(/Claude query failed/);
  });

  it('throws a clear error when the SDK yields no result message at all', async () => {
    async function* fakeQuery(): AsyncGenerator<SDKMessage> {
      // yields nothing
    }

    const processor = createFileProcessor({ queryFn: fakeQuery });

    await expect(processor.processFile(makeFile())).rejects.toThrow(/received no result/);
  });

  it('rejects unsupported (binary) file types before ever calling the SDK', async () => {
    let called = false;
    async function* fakeQuery(): AsyncGenerator<SDKMessage> {
      called = true;
      yield makeResultMessage({ subtype: 'success', result: '{}' });
    }

    const processor = createFileProcessor({ queryFn: fakeQuery });
    const file = makeFile({ fileName: 'report.pdf', mimeType: 'application/pdf' });

    await expect(processor.processFile(file)).rejects.toThrow(/unsupported file type/i);
    expect(called).toBe(false);
  });
});
