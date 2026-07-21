import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import AdmZip from 'adm-zip';
import type { FSWatcher } from 'chokidar';
import { createIngestWatcher } from '../src/ingest/watcher.js';

process.env.INGEST_STABILITY_THRESHOLD_MS ??= '50';

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('createIngestWatcher', () => {
  let tmpDir: string;
  let watcher: FSWatcher | undefined;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ingest-watch-test-'));
  });

  afterEach(async () => {
    await watcher?.close();
    watcher = undefined;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('enqueues a job for a plain file dropped into the watched folder', async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    watcher = createIngestWatcher({ queue: { add }, watchDir: tmpDir });
    await new Promise<void>((resolve) => watcher?.once('ready', resolve));

    await fs.writeFile(path.join(tmpDir, 'notes.md'), '# hi');

    await waitFor(() => add.mock.calls.length >= 1);

    expect(add).toHaveBeenCalledWith(
      'process-file',
      expect.objectContaining({ filePath: path.join(tmpDir, 'notes.md'), originalFileName: 'notes.md' }),
    );
  });

  it('extracts a dropped zip, enqueues one job per contained file, and archives the zip', async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    watcher = createIngestWatcher({ queue: { add }, watchDir: tmpDir });
    await new Promise<void>((resolve) => watcher?.once('ready', resolve));

    const zip = new AdmZip();
    zip.addFile('a.txt', Buffer.from('file a'));
    zip.addFile('b.txt', Buffer.from('file b'));
    const zipPath = path.join(tmpDir, 'export.zip');
    zip.writeZip(zipPath);

    await waitFor(() => add.mock.calls.length >= 2);

    const enqueuedNames = (add.mock.calls as [string, { originalFileName: string }][])
      .map(([, data]) => data.originalFileName)
      .sort();
    expect(enqueuedNames).toEqual(['a.txt', 'b.txt']);

    await waitFor(async () => !(await fs.stat(zipPath).then(
      () => true,
      () => false,
    )));

    const processedDir = path.join(tmpDir, '.processed');
    const processedEntries = await fs.readdir(processedDir);
    expect(processedEntries).toHaveLength(1);
    expect(processedEntries[0]).toMatch(/export\.zip$/);
  });

  it('does not re-enqueue files already sitting in .processed/.failed/.staging', async () => {
    await fs.mkdir(path.join(tmpDir, '.processed'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, '.processed', 'old-result.md'), 'already handled');

    const add = vi.fn().mockResolvedValue(undefined);
    watcher = createIngestWatcher({ queue: { add }, watchDir: tmpDir });
    await new Promise<void>((resolve) => watcher?.once('ready', resolve));

    // Give the watcher a moment to (not) pick anything up from .processed.
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(add).not.toHaveBeenCalled();
  });
});
