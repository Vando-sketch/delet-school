import { describe, expect, it, vi } from 'vitest';
import { renameOrCopy } from '../../src/lib/renameOrCopy.js';

function exdevError(): NodeJS.ErrnoException {
  const err = new Error('cross-device link not permitted') as NodeJS.ErrnoException;
  err.code = 'EXDEV';
  return err;
}

describe('renameOrCopy', () => {
  it('delegates to rename when the destination is on the same filesystem', async () => {
    const rename = vi.fn().mockResolvedValue(undefined);
    const copyFile = vi.fn();
    const unlink = vi.fn();

    await renameOrCopy('/src/a.pdf', '/dest/a.pdf', { rename, copyFile, unlink });

    expect(rename).toHaveBeenCalledWith('/src/a.pdf', '/dest/a.pdf');
    expect(copyFile).not.toHaveBeenCalled();
    expect(unlink).not.toHaveBeenCalled();
  });

  it('falls back to copy+unlink when rename fails with EXDEV', async () => {
    const rename = vi.fn().mockRejectedValue(exdevError());
    const copyFile = vi.fn().mockResolvedValue(undefined);
    const unlink = vi.fn().mockResolvedValue(undefined);

    await renameOrCopy('/src/a.pdf', '/dest/a.pdf', { rename, copyFile, unlink });

    expect(copyFile).toHaveBeenCalledWith('/src/a.pdf', '/dest/a.pdf');
    expect(unlink).toHaveBeenCalledWith('/src/a.pdf');
  });

  it('propagates a non-EXDEV rename failure instead of falling back', async () => {
    const rename = vi.fn().mockRejectedValue(new Error('permission denied'));
    const copyFile = vi.fn();

    await expect(renameOrCopy('/src/a.pdf', '/dest/a.pdf', { rename, copyFile })).rejects.toThrow(
      'permission denied',
    );
    expect(copyFile).not.toHaveBeenCalled();
  });

  it('actually moves a file across real directories on the local filesystem (no injected deps)', async () => {
    const os = await import('node:os');
    const path = await import('node:path');
    const fs = await import('node:fs/promises');
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rename-or-copy-test-'));
    const src = path.join(tmpDir, 'a.txt');
    const dest = path.join(tmpDir, 'b.txt');
    await fs.writeFile(src, 'hello');

    await renameOrCopy(src, dest);

    expect(await fs.readFile(dest, 'utf-8')).toBe('hello');
    await expect(fs.stat(src)).rejects.toThrow();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });
});
