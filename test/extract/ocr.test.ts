import { describe, expect, it } from 'vitest';
import { ocrPdf } from '../../src/extract/ocr.js';

describe('ocrPdf', () => {
  it('invokes ocrmypdf with the expected flags and paths', async () => {
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const execFile = async (file: string, args: readonly string[]) => {
      calls.push({ file, args });
      return { stdout: '', stderr: '' };
    };

    await ocrPdf('/tmp/in.pdf', '/tmp/out.pdf', execFile);

    expect(calls).toEqual([
      {
        file: 'ocrmypdf',
        args: ['-l', 'deu+eng', '--deskew', '--rotate-pages', '--skip-text', '/tmp/in.pdf', '/tmp/out.pdf'],
      },
    ]);
  });
});
