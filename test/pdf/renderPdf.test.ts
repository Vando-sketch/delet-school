import { describe, expect, it } from 'vitest';
import { renderSolutionPdf } from '../../src/pdf/renderPdf.js';

describe('renderSolutionPdf', () => {
  it('writes the markdown to a temp file, invokes pandoc with the configured template/css/engine, reads back the PDF bytes, and cleans up the temp file', async () => {
    const writeCalls: Array<{ path: string; data: string }> = [];
    const execCalls: Array<{ file: string; args: readonly string[] }> = [];
    const rmCalls: string[] = [];
    const pdfBytes = Buffer.from('%PDF-1.4 fake bytes');

    const deps = {
      writeFile: async (path: string, data: string) => {
        writeCalls.push({ path, data });
      },
      execFile: async (file: string, args: readonly string[]) => {
        execCalls.push({ file, args });
        return { stdout: '', stderr: '' };
      },
      readFile: async () => pdfBytes,
      rm: async (path: string) => {
        rmCalls.push(path);
      },
    };

    const result = await renderSolutionPdf('# hello', deps);

    expect(result).toBe(pdfBytes);
    expect(writeCalls).toHaveLength(1);
    expect(writeCalls[0]?.data).toBe('# hello');

    expect(execCalls).toHaveLength(1);
    const [call] = execCalls;
    expect(call?.file).toBe('pandoc');
    expect(call?.args).toEqual([
      writeCalls[0]?.path,
      '--template',
      '/app/vorlage/template.html',
      '--css',
      '/app/vorlage/style.css',
      '--pdf-engine',
      '/app/.venv/bin/weasyprint',
      '-o',
      expect.stringMatching(/\.pdf$/),
    ]);

    // Cleans up both the temp markdown source and the intermediate PDF it read back from.
    expect(rmCalls).toHaveLength(2);
  });
});
