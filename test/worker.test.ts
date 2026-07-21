import { describe, expect, it, vi, beforeEach } from 'vitest';

const processFile = vi.fn();
const writeResult = vi.fn();
const readFile = vi.fn();
const mkdir = vi.fn();
const rename = vi.fn();
const rmdir = vi.fn();

vi.mock('node:fs', () => ({
  promises: { readFile, mkdir, rename, rmdir },
}));
vi.mock('../src/claude/processFile.js', () => ({
  createFileProcessor: () => ({ processFile }),
}));
vi.mock('../src/nextcloud/writeResult.js', () => ({
  createNextcloudWriter: () => ({ writeResult }),
}));
vi.mock('../src/queue/index.js', () => ({
  QUEUE_NAME: 'teams-file-jobs',
  getRedisConnection: () => ({}),
}));
vi.mock('bullmq', () => ({
  Worker: vi.fn().mockImplementation(() => ({ on: vi.fn() })),
}));

// Fixed so job filePaths below can be asserted against a known watchDir - config.ingest is
// evaluated eagerly at import time, so this must be set before src/worker/index.js is loaded.
process.env.INGEST_WATCH_DIR = '/inbox';

describe('worker pipeline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mkdir.mockResolvedValue(undefined);
    rename.mockResolvedValue(undefined);
    rmdir.mockResolvedValue(undefined);
  });

  it('reads, processes, and writes a file job end to end, then archives the source file', async () => {
    const content = Buffer.from('# hi');
    const result = { originalFileName: 'notes.md', tasksFound: [], summaryMarkdown: '# Summary' };
    readFile.mockResolvedValue(content);
    processFile.mockResolvedValue(result);
    writeResult.mockResolvedValue({ writtenPath: '/data/user/files/teams-task-agent/notes.tasks.md' });

    const { createFileJobWorker } = await import('../src/worker/index.js');
    const { Worker } = await import('bullmq');

    createFileJobWorker();

    const handler = vi.mocked(Worker).mock.calls[0][1] as (job: unknown) => Promise<void>;
    const job = { id: '1', data: { filePath: '/inbox/notes.md', originalFileName: 'notes.md', receivedAt: 'now' } };
    await handler(job);

    expect(readFile).toHaveBeenCalledWith('/inbox/notes.md');
    expect(processFile).toHaveBeenCalledWith({ fileName: 'notes.md', mimeType: 'text/markdown', content });
    expect(writeResult).toHaveBeenCalledWith(result, { fileName: 'notes.md', mimeType: 'text/markdown', content });

    // Source file archived into the processed dir, not left in place.
    expect(rename).toHaveBeenCalledTimes(1);
    const [movedFrom, movedTo] = rename.mock.calls[0] as [string, string];
    expect(movedFrom).toBe('/inbox/notes.md');
    expect(movedTo).toMatch(/[/\\]\.processed[/\\]\d+-notes\.md$/);
    // Source file sat directly in the watch root, not a staging subdir - nothing to clean up.
    expect(rmdir).not.toHaveBeenCalled();
  });

  it('archives the source file into the failed dir and rethrows when processing fails', async () => {
    const content = Buffer.from('# hi');
    readFile.mockResolvedValue(content);
    processFile.mockRejectedValue(new Error('claude blew up'));

    const { createFileJobWorker } = await import('../src/worker/index.js');
    const { Worker } = await import('bullmq');

    createFileJobWorker();

    const handler = vi.mocked(Worker).mock.calls[0][1] as (job: unknown) => Promise<void>;
    const job = { id: '1', data: { filePath: '/inbox/notes.md', originalFileName: 'notes.md', receivedAt: 'now' } };

    await expect(handler(job)).rejects.toThrow('claude blew up');

    expect(writeResult).not.toHaveBeenCalled();
    expect(rename).toHaveBeenCalledTimes(1);
    const [, movedTo] = rename.mock.calls[0] as [string, string];
    expect(movedTo).toMatch(/[/\\]\.failed[/\\]\d+-notes\.md$/);
    expect(rmdir).not.toHaveBeenCalled();
  });

  it('cleans up a zip-extraction staging directory after archiving the file it contained', async () => {
    const content = Buffer.from('# hi');
    const result = { originalFileName: 'a.md', tasksFound: [], summaryMarkdown: '# Summary' };
    readFile.mockResolvedValue(content);
    processFile.mockResolvedValue(result);
    writeResult.mockResolvedValue({ writtenPath: '/data/user/files/teams-task-agent/a.tasks.md' });

    const { createFileJobWorker } = await import('../src/worker/index.js');
    const { Worker } = await import('bullmq');

    createFileJobWorker();

    const handler = vi.mocked(Worker).mock.calls[0][1] as (job: unknown) => Promise<void>;
    const job = {
      id: '1',
      data: { filePath: '/inbox/.staging/uuid-1/a.md', originalFileName: 'a.md', receivedAt: 'now' },
    };
    await handler(job);

    expect(rmdir).toHaveBeenCalledWith('/inbox/.staging/uuid-1');
  });
});
