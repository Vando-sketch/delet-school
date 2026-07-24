import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import AdmZip from 'adm-zip';
import type { FSWatcher } from 'chokidar';
import { createIngestWatcher } from '../src/ingest/watcher.js';
import { resetLocalHashCache } from '../src/ingest/dedup.js';

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
    await resetLocalHashCache();
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

    // A lone file dropped directly (not from a zip) has no batch to share context with.
    const [, jobData] = add.mock.calls[0] as [string, Record<string, unknown>];
    expect(jobData.batchId).toBeUndefined();
    expect(jobData.siblingManifest).toBeUndefined();
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

  it('gives every file from the same zip a shared batchId and a sibling manifest excluding itself', async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    watcher = createIngestWatcher({ queue: { add }, watchDir: tmpDir });
    await new Promise<void>((resolve) => watcher?.once('ready', resolve));

    const zip = new AdmZip();
    zip.addFile('a.txt', Buffer.from('content of a'));
    zip.addFile('b.txt', Buffer.from('content of b'));
    zip.addFile('c.txt', Buffer.from('content of c'));
    const zipPath = path.join(tmpDir, 'export.zip');
    zip.writeZip(zipPath);

    await waitFor(() => add.mock.calls.length >= 3);

    const calls = add.mock.calls as [string, { originalFileName: string; batchId?: string; siblingManifest?: { fileName: string; excerpt: string }[] }][];
    const jobsByName = new Map(calls.map(([, data]) => [data.originalFileName, data]));

    const batchIds = new Set(calls.map(([, data]) => data.batchId));
    expect(batchIds.size).toBe(1);
    const [batchId] = [...batchIds];
    expect(batchId).toBeTruthy();

    for (const name of ['a.txt', 'b.txt', 'c.txt']) {
      const job = jobsByName.get(name);
      expect(job?.siblingManifest).toBeDefined();
      const siblingNames = (job?.siblingManifest ?? []).map((s) => s.fileName).sort();
      expect(siblingNames).toEqual(['a.txt', 'b.txt', 'c.txt'].filter((n) => n !== name));
    }

    const aManifest = jobsByName.get('a.txt')?.siblingManifest ?? [];
    const bEntry = aManifest.find((s) => s.fileName === 'b.txt');
    expect(bEntry?.excerpt).toBe('content of b');
  });

  it('bounds a job\'s total sibling-excerpt characters instead of embedding every other file in full', async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    watcher = createIngestWatcher({ queue: { add }, watchDir: tmpDir });
    await new Promise<void>((resolve) => watcher?.once('ready', resolve));

    // 7 files, each with a full-cap (4000 char) excerpt: 6 siblings per job would be 24,000
    // combined chars - over the 20,000 per-job budget - so at least one sibling must be dropped.
    const zip = new AdmZip();
    const fileNames = Array.from({ length: 7 }, (_, i) => `file-${i}.txt`);
    fileNames.forEach((name, i) => {
      zip.addFile(name, Buffer.from(`file-${i}-` + 'a'.repeat(4000)));
    });
    const zipPath = path.join(tmpDir, 'export.zip');
    zip.writeZip(zipPath);

    await waitFor(() => add.mock.calls.length >= 7);

    const calls = add.mock.calls as [string, { originalFileName: string; siblingManifest?: { fileName: string; excerpt: string }[] }][];
    const job = calls.find(([, data]) => data.originalFileName === 'file-0.txt')?.[1];

    expect(job?.siblingManifest?.length).toBeLessThan(6);
    const totalChars = (job?.siblingManifest ?? []).reduce((sum, s) => sum + s.excerpt.length, 0);
    expect(totalChars).toBeLessThanOrEqual(20_000);
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

  it('enqueues a job for a file dropped into a subfolder, using its relative path as originalFileName', async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    watcher = createIngestWatcher({ queue: { add }, watchDir: tmpDir });
    await new Promise<void>((resolve) => watcher?.once('ready', resolve));

    await fs.mkdir(path.join(tmpDir, 'Mathe'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'Mathe', 'AB1.pdf'), 'content');

    await waitFor(() => add.mock.calls.length >= 1);

    expect(add).toHaveBeenCalledWith(
      'process-file',
      expect.objectContaining({
        filePath: path.join(tmpDir, 'Mathe', 'AB1.pdf'),
        originalFileName: path.join('Mathe', 'AB1.pdf'),
      }),
    );
  });

  it('ignores a .processed directory nested under a subfolder, not just at the top level', async () => {
    await fs.mkdir(path.join(tmpDir, 'Mathe', '.processed'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'Mathe', '.processed', 'old-result.pdf'), 'already handled');

    const add = vi.fn().mockResolvedValue(undefined);
    watcher = createIngestWatcher({ queue: { add }, watchDir: tmpDir });
    await new Promise<void>((resolve) => watcher?.once('ready', resolve));

    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(add).not.toHaveBeenCalled();
  });

  it('prefixes extracted zip-content originalFileName with the subfolder the zip itself was dropped into', async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    watcher = createIngestWatcher({ queue: { add }, watchDir: tmpDir });
    await new Promise<void>((resolve) => watcher?.once('ready', resolve));

    await fs.mkdir(path.join(tmpDir, 'Mathe'), { recursive: true });
    const zip = new AdmZip();
    zip.addFile('a.txt', Buffer.from('file a'));
    zip.addFile('b.txt', Buffer.from('file b'));
    zip.writeZip(path.join(tmpDir, 'Mathe', 'export.zip'));

    await waitFor(() => add.mock.calls.length >= 2);

    const enqueuedNames = (add.mock.calls as [string, { originalFileName: string }][])
      .map(([, data]) => data.originalFileName)
      .sort();
    expect(enqueuedNames).toEqual([path.join('Mathe', 'a.txt'), path.join('Mathe', 'b.txt')]);
  });

  it('enqueues the first file normally and skips BullMQ job creation for a second duplicate file with matching SHA-256', async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    watcher = createIngestWatcher({ queue: { add }, watchDir: tmpDir });
    await new Promise<void>((resolve) => watcher?.once('ready', resolve));

    const content = 'UNIQUE_CONTENT_FOR_DEDUP_TEST_123456';
    const file1 = path.join(tmpDir, 'doc1.pdf');
    const file2 = path.join(tmpDir, 'doc2.pdf');

    await fs.writeFile(file1, content);

    await waitFor(() => add.mock.calls.length >= 1);

    expect(add).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledWith(
      'process-file',
      expect.objectContaining({ filePath: file1, originalFileName: 'doc1.pdf' }),
    );

    // Drop second identical file
    await fs.writeFile(file2, content);

    // Wait for file2 to be handled by watcher
    await new Promise((resolve) => setTimeout(resolve, 350));

    // Queue add should NOT have been called a second time
    expect(add).toHaveBeenCalledTimes(1);

    // File2 should be archived in .processed directory
    const processedDir = path.join(tmpDir, '.processed');
    await waitFor(async () => {
      try {
        const files = await fs.readdir(processedDir);
        return files.some((f) => f.includes('doc2.pdf'));
      } catch {
        return false;
      }
    });
  });
});
