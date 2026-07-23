import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createTaildropDrain, drainOnce } from '../src/ingest/taildropDrain.js';

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('drainOnce', () => {
  let stagingDir: string;
  let watchDir: string;

  beforeEach(async () => {
    stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'taildrop-staging-'));
    watchDir = await fs.mkdtemp(path.join(os.tmpdir(), 'taildrop-watch-'));
  });

  afterEach(async () => {
    await fs.rm(stagingDir, { recursive: true, force: true });
    await fs.rm(watchDir, { recursive: true, force: true });
  });

  it('moves a staged file into the watch dir unchanged when no name collision exists', async () => {
    await fs.writeFile(path.join(stagingDir, 'Scan.pdf'), 'contents');

    await drainOnce(stagingDir, watchDir);

    expect(await fs.readFile(path.join(watchDir, 'Scan.pdf'), 'utf8')).toBe('contents');
    expect(await fs.readdir(stagingDir)).toEqual([]);
  });

  it('suffixes the filename instead of overwriting when a same-named file already exists in the watch dir', async () => {
    await fs.writeFile(path.join(watchDir, 'Scan.pdf'), 'first');
    await fs.writeFile(path.join(stagingDir, 'Scan.pdf'), 'second');

    await drainOnce(stagingDir, watchDir);

    expect(await fs.readFile(path.join(watchDir, 'Scan.pdf'), 'utf8')).toBe('first');
    const entries = await fs.readdir(watchDir);
    const suffixed = entries.find((name) => name !== 'Scan.pdf');
    expect(suffixed).toBeDefined();
    expect(await fs.readFile(path.join(watchDir, suffixed as string), 'utf8')).toBe('second');
  });

  it('drains multiple files in one pass', async () => {
    await fs.writeFile(path.join(stagingDir, 'a.pdf'), 'a');
    await fs.writeFile(path.join(stagingDir, 'b.pdf'), 'b');

    await drainOnce(stagingDir, watchDir);

    expect((await fs.readdir(watchDir)).sort()).toEqual(['a.pdf', 'b.pdf']);
  });

  it('skips subdirectories and only drains regular files', async () => {
    await fs.mkdir(path.join(stagingDir, 'a-subdir'));
    await fs.writeFile(path.join(stagingDir, 'file.pdf'), 'contents');

    await drainOnce(stagingDir, watchDir);

    // The subdirectory should still exist in stagingDir (not moved)
    expect(await fs.readdir(stagingDir)).toContain('a-subdir');
    // The file should have been drained into watchDir
    expect(await fs.readFile(path.join(watchDir, 'file.pdf'), 'utf8')).toBe('contents');
  });

  it('does nothing (no throw) when the staging directory does not exist yet', async () => {
    await fs.rm(stagingDir, { recursive: true, force: true });

    await expect(drainOnce(stagingDir, watchDir)).resolves.toBeUndefined();
  });
});

describe('createTaildropDrain', () => {
  let stagingDir: string;
  let watchDir: string;
  let drain: { stop(): void } | undefined;

  beforeEach(async () => {
    stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'taildrop-staging-'));
    watchDir = await fs.mkdtemp(path.join(os.tmpdir(), 'taildrop-watch-'));
  });

  afterEach(async () => {
    drain?.stop();
    drain = undefined;
    await fs.rm(stagingDir, { recursive: true, force: true });
    await fs.rm(watchDir, { recursive: true, force: true });
  });

  it('drains on the configured interval without an explicit call', async () => {
    drain = createTaildropDrain({ stagingDir, watchDir, intervalMs: 20 });
    await fs.writeFile(path.join(stagingDir, 'Scan.pdf'), 'contents');

    await waitFor(async () => (await fs.readdir(watchDir)).includes('Scan.pdf'));
  });
});
