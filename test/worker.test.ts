import { describe, expect, it, vi, beforeEach } from 'vitest';

const downloadDriveItem = vi.fn();
const processFile = vi.fn();
const writeResult = vi.fn();

vi.mock('../src/graph/client.js', () => ({
  createGraphClient: () => ({ downloadDriveItem, createSubscription: vi.fn(), renewSubscription: vi.fn() }),
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

describe('worker pipeline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('downloads, processes, and writes a file job end to end', async () => {
    const file = { fileName: 'notes.md', mimeType: 'text/markdown', content: Buffer.from('# hi') };
    const result = { originalFileName: 'notes.md', tasksFound: [], summaryMarkdown: '# Summary' };
    downloadDriveItem.mockResolvedValue(file);
    processFile.mockResolvedValue(result);
    writeResult.mockResolvedValue({ writtenPath: '/data/user/files/teams-task-agent/notes.tasks.md' });

    const { createFileJobWorker } = await import('../src/worker/index.js');
    const { Worker } = await import('bullmq');

    createFileJobWorker();

    const handler = vi.mocked(Worker).mock.calls[0][1] as (job: unknown) => Promise<void>;
    const job = { id: '1', data: { driveId: 'd1', itemId: 'i1', resourceUrl: 'r', changeType: 'updated', receivedAt: 'now' } };
    await handler(job);

    expect(downloadDriveItem).toHaveBeenCalledWith('d1', 'i1');
    expect(processFile).toHaveBeenCalledWith(file);
    expect(writeResult).toHaveBeenCalledWith(result, file);
  });
});
