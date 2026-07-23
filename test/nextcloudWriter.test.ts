import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createNextcloudWriter } from '../src/nextcloud/writeResult.js';
import type { ProcessedFileResult } from '../src/types.js';

const TARGET_USER = 'alice';

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

  it('writes a solved PDF under Fächer/<Fach>/<subpath>/ with a date-suffixed filename', async () => {
    const writer = createNextcloudWriter({ execFile: okExecFile });
    const pdfBytes = Buffer.from('%PDF-1.4 fake');

    const { writtenPath } = await writer.writeResult(makeResult(), { kind: 'pdf', bytes: pdfBytes }, '2026-07-23');

    const expectedPath = path.join(tmpDir, TARGET_USER, 'files', 'Fächer', 'BGWP', 'Grünig', 'arbeitsblatt1_Loesung_2026-07-23.pdf');
    expect(writtenPath).toBe(expectedPath);
    expect(await fs.readFile(writtenPath)).toEqual(pdfBytes);
  });

  it('nests under lernfeld when present', async () => {
    const writer = createNextcloudWriter({ execFile: okExecFile });
    const result = makeResult({ fach: 'IT-Tec', lernfeld: 'LF 3' });

    const { writtenPath } = await writer.writeResult(result, { kind: 'pdf', bytes: Buffer.from('x') }, '2026-07-23');

    expect(writtenPath).toBe(
      path.join(tmpDir, TARGET_USER, 'files', 'Fächer', 'IT-Tec', 'LF 3', 'arbeitsblatt1_Loesung_2026-07-23.pdf'),
    );
  });

  it('routes an unclassifiable Fach to Fächer/_Unsortiert/', async () => {
    const writer = createNextcloudWriter({ execFile: okExecFile });
    const result = makeResult({ fach: '_Unsortiert' });

    const { writtenPath } = await writer.writeResult(result, { kind: 'pdf', bytes: Buffer.from('x') }, '2026-07-23');

    expect(writtenPath).toBe(
      path.join(tmpDir, TARGET_USER, 'files', 'Fächer', '_Unsortiert', 'arbeitsblatt1_Loesung_2026-07-23.pdf'),
    );
  });

  it('routes Materialblatt content into Fächer/<Fach>/Material/ with no _Loesung suffix, preserving the source extension', async () => {
    const writer = createNextcloudWriter({ execFile: okExecFile });
    const materialSourceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'material-src-'));
    const sourcePath = path.join(materialSourceDir, 'gesetzestext.pdf');
    await fs.writeFile(sourcePath, 'source bytes');

    const result = makeResult({ isMaterialblatt: true, fach: 'Deutsch', originalFileName: 'gesetzestext.pdf' });
    const { writtenPath } = await writer.writeResult(result, { kind: 'material', sourcePath }, '2026-07-23');

    expect(writtenPath).toBe(
      path.join(tmpDir, TARGET_USER, 'files', 'Fächer', 'Deutsch', 'Material', 'gesetzestext_2026-07-23.pdf'),
    );
    expect(await fs.readFile(writtenPath, 'utf8')).toBe('source bytes');

    await fs.rm(materialSourceDir, { recursive: true, force: true });
  });

  it('sanitizes a path-traversal originalFileName before it ever reaches the filesystem', async () => {
    const writer = createNextcloudWriter({ execFile: okExecFile });
    const result = makeResult({ originalFileName: '../../etc/passwd' });

    const { writtenPath } = await writer.writeResult(result, { kind: 'pdf', bytes: Buffer.from('x') }, '2026-07-23');

    const expectedDir = path.resolve(tmpDir, TARGET_USER, 'files', 'Fächer', 'BGWP', 'Grünig');
    const resolvedWritten = path.resolve(writtenPath);
    expect(resolvedWritten.startsWith(expectedDir + path.sep)).toBe(true);
    expect(resolvedWritten).not.toContain('..');
  });

  it('still resolves successfully with the correct writtenPath if occ files:scan fails', async () => {
    const failingExecFile = async (): Promise<{ stdout: string; stderr: string }> => {
      throw new Error('spawn occ ENOENT');
    };
    const writer = createNextcloudWriter({ execFile: failingExecFile });

    const { writtenPath } = await writer.writeResult(makeResult(), { kind: 'pdf', bytes: Buffer.from('x') }, '2026-07-23');

    expect(await fs.stat(writtenPath).then(() => true)).toBe(true);
  });

  it('invokes occ files:scan scoped to the computed Fach/Lernfeld target directory', async () => {
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const recordingExecFile = async (file: string, args: readonly string[]) => {
      calls.push({ file, args });
      return { stdout: '', stderr: '' };
    };
    const writer = createNextcloudWriter({ execFile: recordingExecFile });

    await writer.writeResult(makeResult(), { kind: 'pdf', bytes: Buffer.from('x') }, '2026-07-23');

    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual(['files:scan', `--path=/${TARGET_USER}/files/Fächer/BGWP/Grünig`]);
  });
});
