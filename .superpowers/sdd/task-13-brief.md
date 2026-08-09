### Task 13: Nextcloud writer rewrite

**Files:**
- Modify: `src/nextcloud/writeResult.ts` (full rewrite of path/content logic; keeps the `execFile` injection from Task 1)
- Modify: `test/nextcloudWriter.test.ts` (full rewrite for the new interface)

**Interfaces:**
- Consumes: `ProcessedFileResult`, `NextcloudWriteContent`, `NextcloudWriter` (Task 2); `FACH_SUBPATH` (Task 2, `src/fach.ts`); `ExecFileFn`, `defaultExecFile` (Task 1).
- Produces: `createNextcloudWriter(deps?: { execFile?: ExecFileFn }): NextcloudWriter` where `writeResult(result, content, datum)` — consumed by Task 14 (`worker/index.ts`).

- [ ] **Step 1: Write the failing tests (full rewrite of the test file)**

```ts
// test/nextcloudWriter.test.ts
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

    const expectedPath = path.join(tmpDir, TARGET_USER, 'files', 'Fächer', 'BGWP', 'BGWP', 'arbeitsblatt1_Loesung_2026-07-23.pdf');
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

    const expectedDir = path.resolve(tmpDir, TARGET_USER, 'files', 'Fächer', 'BGWP', 'BGWP');
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
    expect(calls[0]?.args).toEqual(['files:scan', `--path=/${TARGET_USER}/files/Fächer/BGWP`]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- test/nextcloudWriter.test.ts`
Expected: FAIL — old `writeResult` signature and flat-folder behavior don't match.

- [ ] **Step 3: Rewrite `src/nextcloud/writeResult.ts`**

```ts
// src/nextcloud/writeResult.ts
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import pino from 'pino';
import { config } from '../config/index.js';
import { FACH_SUBPATH } from '../fach.js';
import { defaultExecFile, type ExecFileFn } from '../lib/execFile.js';
import type { NextcloudWriteContent, NextcloudWriter, ProcessedFileResult } from '../types.js';

const logger = pino({ name: 'nextcloud-writer' });

const RESULT_ROOT = 'Fächer';
const MATERIAL_SUBDIRNAME = 'Material';

export interface NextcloudWriterDeps {
  execFile?: ExecFileFn;
}

/**
 * Neutralizes path separators and parent-directory traversal sequences. `originalFileName`
 * and `lernfeld` are not trusted to be safe for direct filesystem-path construction (e.g.
 * `../../etc/passwd` or `foo/bar.txt`).
 */
function sanitizePathSegment(name: string): string {
  const withoutSeparators = name.replace(/[/\\]/g, '_');
  const withoutTraversal = withoutSeparators.replace(/\.\./g, '_');
  const trimmed = withoutTraversal.trim();
  return trimmed.length > 0 ? trimmed : 'untitled';
}

function deriveTargetDir(result: ProcessedFileResult): string[] {
  const fachSubpath = FACH_SUBPATH[result.fach].split('/').map(sanitizePathSegment);
  const parts = [RESULT_ROOT, ...fachSubpath];
  if (result.isMaterialblatt) {
    parts.push(MATERIAL_SUBDIRNAME);
  } else if (result.lernfeld) {
    parts.push(sanitizePathSegment(result.lernfeld));
  }
  return parts;
}

function deriveFileName(result: ProcessedFileResult, content: NextcloudWriteContent, datum: string): string {
  const safeBase = sanitizePathSegment(result.originalFileName);
  const ext = path.extname(safeBase);
  const stem = ext.length > 0 ? safeBase.slice(0, -ext.length) : safeBase;
  const finalStem = stem.length > 0 ? stem : 'untitled';

  if (content.kind === 'pdf') {
    return `${finalStem}_Loesung_${datum}.pdf`;
  }
  const materialExt = path.extname(content.sourcePath) || '.txt';
  return `${finalStem}_${datum}${materialExt}`;
}

export function createNextcloudWriter(deps: NextcloudWriterDeps = {}): NextcloudWriter {
  const execFile = deps.execFile ?? defaultExecFile;

  return {
    async writeResult(result, content, datum) {
      const targetUser = config.nextcloud.targetUser();
      const dirParts = deriveTargetDir(result);
      const targetDir = path.join(config.nextcloud.dataDir(), targetUser, 'files', ...dirParts);
      const fileName = deriveFileName(result, content, datum);
      const writtenPath = path.join(targetDir, fileName);

      const resolvedTargetDir = path.resolve(targetDir);
      const resolvedWrittenPath = path.resolve(writtenPath);
      if (resolvedWrittenPath !== resolvedTargetDir && !resolvedWrittenPath.startsWith(resolvedTargetDir + path.sep)) {
        throw new Error(`Refusing to write outside of target directory: ${writtenPath}`);
      }

      await fs.mkdir(targetDir, { recursive: true });
      if (content.kind === 'pdf') {
        await fs.writeFile(writtenPath, content.bytes);
      } else {
        await fs.copyFile(content.sourcePath, writtenPath);
      }

      const scanPath = `/${targetUser}/files/${dirParts.join('/')}`;
      try {
        await execFile(config.nextcloud.occBinary, ['files:scan', `--path=${scanPath}`]);
      } catch (err) {
        logger.error({ err, scanPath }, 'occ files:scan failed after writing Nextcloud result file');
      }

      return { writtenPath };
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- test/nextcloudWriter.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/nextcloud/writeResult.ts test/nextcloudWriter.test.ts
git commit -m "feat: route Nextcloud writes by Fach/Lernfeld with date-suffixed filenames"
```

---

