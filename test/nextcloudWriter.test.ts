import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createNextcloudWriter } from '../src/nextcloud/writeResult.js';
import type { DownloadedFile, ProcessedFileResult } from '../src/types.js';

const TARGET_USER = 'alice';

const originalFile: DownloadedFile = {
  fileName: 'meeting-notes.docx',
  mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  content: Buffer.from('irrelevant binary content'),
};

function makeResult(overrides: Partial<ProcessedFileResult> = {}): ProcessedFileResult {
  return {
    originalFileName: 'meeting-notes.docx',
    tasksFound: [{ taskDescription: 'Send follow-up email', proposedSolution: 'Draft and send by Friday' }],
    summaryMarkdown: '# Summary\n\n- Send follow-up email: Draft and send by Friday\n',
    ...overrides,
  };
}

const okExecFile = async (): Promise<{ stdout: string; stderr: string }> => ({ stdout: '', stderr: '' });

describe('createNextcloudWriter().writeResult', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nc-writer-test-'));
    process.env.NEXTCLOUD_DATA_DIR = tmpDir;
    process.env.NEXTCLOUD_TARGET_USER = TARGET_USER;
  });

  afterEach(async () => {
    delete process.env.NEXTCLOUD_DATA_DIR;
    delete process.env.NEXTCLOUD_TARGET_USER;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('creates the expected file with the expected content under {dataDir}/{targetUser}/files/teams-task-agent/', async () => {
    const writer = createNextcloudWriter({ execFile: okExecFile });
    const result = makeResult();

    const { writtenPath } = await writer.writeResult(result, originalFile);

    const expectedDir = path.join(tmpDir, TARGET_USER, 'files', 'teams-task-agent');
    expect(writtenPath).toBe(path.join(expectedDir, 'meeting-notes.tasks.md'));

    const content = await fs.readFile(writtenPath, 'utf8');
    expect(content).toBe(result.summaryMarkdown);
  });

  it('handles filenames with no extension gracefully', async () => {
    const writer = createNextcloudWriter({ execFile: okExecFile });
    const result = makeResult({ originalFileName: 'report' });

    const { writtenPath } = await writer.writeResult(result, originalFile);

    expect(path.basename(writtenPath)).toBe('report.tasks.md');
    const content = await fs.readFile(writtenPath, 'utf8');
    expect(content).toBe(result.summaryMarkdown);
  });

  it('does not let a "../../etc/passwd" originalFileName escape the target directory', async () => {
    const writer = createNextcloudWriter({ execFile: okExecFile });
    const result = makeResult({ originalFileName: '../../etc/passwd' });

    const { writtenPath } = await writer.writeResult(result, originalFile);

    const expectedDir = path.resolve(tmpDir, TARGET_USER, 'files', 'teams-task-agent');
    const resolvedWritten = path.resolve(writtenPath);

    expect(resolvedWritten.startsWith(expectedDir + path.sep)).toBe(true);
    expect(resolvedWritten).not.toContain('..');

    const stat = await fs.stat(writtenPath);
    expect(stat.isFile()).toBe(true);

    // Make sure nothing was written outside the sandboxed temp dir.
    await expect(fs.stat('/etc/passwd.tasks.md')).rejects.toThrow();
  });

  it('does not let a filename containing "/" escape the target directory', async () => {
    const writer = createNextcloudWriter({ execFile: okExecFile });
    const result = makeResult({ originalFileName: 'sneaky/sub/dir/evil.txt' });

    const { writtenPath } = await writer.writeResult(result, originalFile);

    const expectedDir = path.resolve(tmpDir, TARGET_USER, 'files', 'teams-task-agent');
    const resolvedWritten = path.resolve(writtenPath);

    expect(resolvedWritten.startsWith(expectedDir + path.sep)).toBe(true);
    expect(path.dirname(resolvedWritten)).toBe(expectedDir);
  });

  it('still resolves successfully with the correct writtenPath if occ files:scan fails', async () => {
    const failingExecFile = async (): Promise<{ stdout: string; stderr: string }> => {
      throw new Error('spawn occ ENOENT');
    };
    const writer = createNextcloudWriter({ execFile: failingExecFile });
    const result = makeResult();

    const { writtenPath } = await writer.writeResult(result, originalFile);

    const expectedDir = path.join(tmpDir, TARGET_USER, 'files', 'teams-task-agent');
    expect(writtenPath).toBe(path.join(expectedDir, 'meeting-notes.tasks.md'));

    const content = await fs.readFile(writtenPath, 'utf8');
    expect(content).toBe(result.summaryMarkdown);
  });

  it('invokes occ files:scan scoped to the target user files subfolder', async () => {
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const recordingExecFile = async (
      file: string,
      args: readonly string[],
    ): Promise<{ stdout: string; stderr: string }> => {
      calls.push({ file, args });
      return { stdout: '', stderr: '' };
    };
    const writer = createNextcloudWriter({ execFile: recordingExecFile });

    await writer.writeResult(makeResult(), originalFile);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual(['files:scan', `--path=/${TARGET_USER}/files/teams-task-agent`]);
  });
});
