import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createNextcloudWriter } from '../src/nextcloud/writeResult.js';
import type { ProcessedFileResult } from '../src/types.js';

function makeResult(overrides: Partial<ProcessedFileResult> = {}): ProcessedFileResult {
  return {
    originalFileName: 'arbeitsblatt1.pdf',
    isReferenceSheet: false,
    subject: 'Math',
    topic: 'Kaufvertragsrecht',
    tasksFound: [],
    ...overrides,
  };
}

function makeFakeClient() {
  return {
    createDirectory: vi.fn().mockResolvedValue(undefined),
    putFileContents: vi.fn().mockResolvedValue(true),
  };
}

describe('createNextcloudWriter().writeResult', () => {
  beforeEach(() => {
    process.env.NEXTCLOUD_BASE_URL = 'https://nextcloud.example.ts.net';
    process.env.NEXTCLOUD_USERNAME = 'alice';
    process.env.NEXTCLOUD_APP_PASSWORD = 'secret';
  });

  afterEach(() => {
    delete process.env.NEXTCLOUD_BASE_URL;
    delete process.env.NEXTCLOUD_USERNAME;
    delete process.env.NEXTCLOUD_APP_PASSWORD;
  });

  it('creates the subject directory (recursive) and PUTs a solved PDF under Subjects/<Subject>/<subpath>/ with a date-suffixed filename', async () => {
    const client = makeFakeClient();
    const writer = createNextcloudWriter({ webdavClient: client });
    const pdfBytes = Buffer.from('%PDF-1.4 fake');

    const { writtenPath } = await writer.writeResult(makeResult(), { kind: 'pdf', bytes: pdfBytes }, '2026-07-23');

    expect(writtenPath).toBe('/Subjects/Math/arbeitsblatt1_Solution_2026-07-23.pdf');
    expect(client.createDirectory).toHaveBeenCalledWith('/Subjects/Math', { recursive: true });
    expect(client.putFileContents).toHaveBeenCalledWith(writtenPath, pdfBytes);
  });

  it('nests under module when present', async () => {
    const client = makeFakeClient();
    const writer = createNextcloudWriter({ webdavClient: client });
    const result = makeResult({ subject: 'Science', module: 'LF 3' });

    const { writtenPath } = await writer.writeResult(result, { kind: 'pdf', bytes: Buffer.from('x') }, '2026-07-23');

    expect(writtenPath).toBe('/Subjects/Science/LF 3/arbeitsblatt1_Solution_2026-07-23.pdf');
    expect(client.createDirectory).toHaveBeenCalledWith('/Subjects/Science/LF 3', { recursive: true });
  });

  it('routes an unclassifiable subject to Subjects/_Unsorted/', async () => {
    const client = makeFakeClient();
    const writer = createNextcloudWriter({ webdavClient: client });
    const result = makeResult({ subject: 'Unsorted' });

    const { writtenPath } = await writer.writeResult(result, { kind: 'pdf', bytes: Buffer.from('x') }, '2026-07-23');

    expect(writtenPath).toBe('/Subjects/_Unsorted/arbeitsblatt1_Solution_2026-07-23.pdf');
  });

  it('routes reference-sheet content into Subjects/<Subject>/Reference/ with no _Solution suffix, reading bytes from sourcePath', async () => {
    const client = makeFakeClient();
    const materialSourceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'material-src-'));
    const sourcePath = path.join(materialSourceDir, 'gesetzestext.pdf');
    await fs.writeFile(sourcePath, 'source bytes');

    const writer = createNextcloudWriter({ webdavClient: client });
    const result = makeResult({ isReferenceSheet: true, subject: 'History', originalFileName: 'gesetzestext.pdf' });
    const { writtenPath } = await writer.writeResult(result, { kind: 'material', sourcePath }, '2026-07-23');

    expect(writtenPath).toBe('/Subjects/History/Reference/gesetzestext_2026-07-23.pdf');
    expect(client.putFileContents).toHaveBeenCalledWith(writtenPath, Buffer.from('source bytes'));

    await fs.rm(materialSourceDir, { recursive: true, force: true });
  });

  it('sanitizes a path-traversal originalFileName before it reaches the WebDAV path', async () => {
    const client = makeFakeClient();
    const writer = createNextcloudWriter({ webdavClient: client });
    const result = makeResult({ originalFileName: '../../etc/passwd' });

    const { writtenPath } = await writer.writeResult(result, { kind: 'pdf', bytes: Buffer.from('x') }, '2026-07-23');

    expect(writtenPath.startsWith('/Subjects/Math/')).toBe(true);
    expect(writtenPath).not.toContain('..');
  });

  it('strips directory paths and redundant subject/zip prefixes from originalFileName', async () => {
    const client = makeFakeClient();
    const writer = createNextcloudWriter({ webdavClient: client });
    const result = makeResult({ subject: 'Math', originalFileName: 'Math/Math_01_Algebra.pdf' });

    const { writtenPath } = await writer.writeResult(result, { kind: 'pdf', bytes: Buffer.from('x') }, '2026-07-23');

    expect(writtenPath).toBe('/Subjects/Math/01_Algebra_Solution_2026-07-23.pdf');
  });

  it('only calls createDirectory once across multiple writes to the same subject directory', async () => {
    const client = makeFakeClient();
    const writer = createNextcloudWriter({ webdavClient: client });

    await writer.writeResult(makeResult(), { kind: 'pdf', bytes: Buffer.from('x') }, '2026-07-23');
    await writer.writeResult(
      makeResult({ originalFileName: 'arbeitsblatt2.pdf' }),
      { kind: 'pdf', bytes: Buffer.from('y') },
      '2026-07-23',
    );

    expect(client.createDirectory).toHaveBeenCalledTimes(1);
    expect(client.putFileContents).toHaveBeenCalledTimes(2);
  });

  it('throws when putFileContents resolves false', async () => {
    const client = makeFakeClient();
    client.putFileContents.mockResolvedValue(false);
    const writer = createNextcloudWriter({ webdavClient: client });

    await expect(
      writer.writeResult(makeResult(), { kind: 'pdf', bytes: Buffer.from('x') }, '2026-07-23'),
    ).rejects.toThrow(/failed to upload/);
  });

  it('propagates a createDirectory failure instead of swallowing it', async () => {
    const client = makeFakeClient();
    client.createDirectory.mockRejectedValue(new Error('network unreachable'));
    const writer = createNextcloudWriter({ webdavClient: client });

    await expect(
      writer.writeResult(makeResult(), { kind: 'pdf', bytes: Buffer.from('x') }, '2026-07-23'),
    ).rejects.toThrow('network unreachable');
  });
});
