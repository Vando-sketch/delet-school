import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createNextcloudWriter } from '../src/nextcloud/writeResult.js';
import type { ProcessedFileResult } from '../src/types.js';

function makeResult(overrides: Partial<ProcessedFileResult> = {}): ProcessedFileResult {
  return {
    originalFileName: 'arbeitsblatt1.pdf',
    isMaterialblatt: false,
    fach: 'BGWP',
    thema: 'Kaufvertragsrecht',
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

  it('creates the Fach directory (recursive) and PUTs a solved PDF under Fächer/<Fach>/<subpath>/ with a date-suffixed filename', async () => {
    const client = makeFakeClient();
    const writer = createNextcloudWriter({ webdavClient: client });
    const pdfBytes = Buffer.from('%PDF-1.4 fake');

    const { writtenPath } = await writer.writeResult(makeResult(), { kind: 'pdf', bytes: pdfBytes }, '2026-07-23');

    expect(writtenPath).toBe('/Fächer/BGWP/Grünig/arbeitsblatt1_Loesung_2026-07-23.pdf');
    expect(client.createDirectory).toHaveBeenCalledWith('/Fächer/BGWP/Grünig', { recursive: true });
    expect(client.putFileContents).toHaveBeenCalledWith(writtenPath, pdfBytes);
  });

  it('nests under lernfeld when present', async () => {
    const client = makeFakeClient();
    const writer = createNextcloudWriter({ webdavClient: client });
    const result = makeResult({ fach: 'IT-Tec', lernfeld: 'LF 3' });

    const { writtenPath } = await writer.writeResult(result, { kind: 'pdf', bytes: Buffer.from('x') }, '2026-07-23');

    expect(writtenPath).toBe('/Fächer/IT-Tec/LF 3/arbeitsblatt1_Loesung_2026-07-23.pdf');
    expect(client.createDirectory).toHaveBeenCalledWith('/Fächer/IT-Tec/LF 3', { recursive: true });
  });

  it('routes an unclassifiable Fach to Fächer/_Unsortiert/', async () => {
    const client = makeFakeClient();
    const writer = createNextcloudWriter({ webdavClient: client });
    const result = makeResult({ fach: '_Unsortiert' });

    const { writtenPath } = await writer.writeResult(result, { kind: 'pdf', bytes: Buffer.from('x') }, '2026-07-23');

    expect(writtenPath).toBe('/Fächer/_Unsortiert/arbeitsblatt1_Loesung_2026-07-23.pdf');
  });

  it('routes Materialblatt content into Fächer/<Fach>/Material/ with no _Loesung suffix, reading bytes from sourcePath', async () => {
    const client = makeFakeClient();
    const materialSourceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'material-src-'));
    const sourcePath = path.join(materialSourceDir, 'gesetzestext.pdf');
    await fs.writeFile(sourcePath, 'source bytes');

    const writer = createNextcloudWriter({ webdavClient: client });
    const result = makeResult({ isMaterialblatt: true, fach: 'Deutsch', originalFileName: 'gesetzestext.pdf' });
    const { writtenPath } = await writer.writeResult(result, { kind: 'material', sourcePath }, '2026-07-23');

    expect(writtenPath).toBe('/Fächer/Deutsch/Material/gesetzestext_2026-07-23.pdf');
    expect(client.putFileContents).toHaveBeenCalledWith(writtenPath, Buffer.from('source bytes'));

    await fs.rm(materialSourceDir, { recursive: true, force: true });
  });

  it('sanitizes a path-traversal originalFileName before it reaches the WebDAV path', async () => {
    const client = makeFakeClient();
    const writer = createNextcloudWriter({ webdavClient: client });
    const result = makeResult({ originalFileName: '../../etc/passwd' });

    const { writtenPath } = await writer.writeResult(result, { kind: 'pdf', bytes: Buffer.from('x') }, '2026-07-23');

    expect(writtenPath.startsWith('/Fächer/BGWP/Grünig/')).toBe(true);
    expect(writtenPath).not.toContain('..');
  });

  it('only calls createDirectory once across multiple writes to the same Fach directory', async () => {
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
