import { describe, expect, it } from 'vitest';
import { convertToMarkdown } from '../../src/extract/markitdown.js';

describe('convertToMarkdown', () => {
  it('invokes the MarkItDown binary on the given file and returns its stdout', async () => {
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const execFile = async (file: string, args: readonly string[]) => {
      calls.push({ file, args });
      return { stdout: '# Extracted heading\n\nBody text.', stderr: '' };
    };

    const markdown = await convertToMarkdown('/tmp/doc.pdf', execFile);

    expect(markdown).toBe('# Extracted heading\n\nBody text.');
    expect(calls).toEqual([{ file: './.venv/bin/markitdown', args: ['/tmp/doc.pdf'] }]);
  });
});
