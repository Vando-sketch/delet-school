import { describe, expect, it } from 'vitest';
import { renderPageToPng } from '../../src/extract/renderPage.js';

describe('renderPageToPng', () => {
  it('invokes pdftoppm scoped to one page and returns the produced PNG path', async () => {
    const execCalls: Array<{ file: string; args: readonly string[] }> = [];
    const execFile = async (file: string, args: readonly string[]) => {
      execCalls.push({ file, args });
      return { stdout: '', stderr: '' };
    };
    const mkdir = async () => undefined;
    const readdir = async () => ['page-2-1.png', 'unrelated.txt'];

    const result = await renderPageToPng('/tmp/doc.pdf', 2, '/tmp/vision-pages', { execFile, mkdir, readdir });

    expect(result).toBe('/tmp/vision-pages/page-2-1.png');
    expect(execCalls).toEqual([
      {
        file: 'pdftoppm',
        args: ['-png', '-r', '150', '-f', '2', '-l', '2', '/tmp/doc.pdf', '/tmp/vision-pages/page-2'],
      },
    ]);
  });

  it('throws a clear error when pdftoppm produces no matching file', async () => {
    const execFile = async () => ({ stdout: '', stderr: '' });
    const mkdir = async () => undefined;
    const readdir = async () => ['unrelated.txt'];

    await expect(
      renderPageToPng('/tmp/doc.pdf', 5, '/tmp/vision-pages', { execFile, mkdir, readdir }),
    ).rejects.toThrow(/did not produce an image for page 5/);
  });

  it('correctly distinguishes page-1 from page-10+ when both exist', async () => {
    const execFile = async () => ({ stdout: '', stderr: '' });
    const mkdir = async () => undefined;
    const readdir = async () => ['page-10-1.png', 'page-1-1.png'];

    const result = await renderPageToPng('/tmp/doc.pdf', 1, '/tmp/vision-pages', { execFile, mkdir, readdir });

    expect(result).toBe('/tmp/vision-pages/page-1-1.png');
  });
});
