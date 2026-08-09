### Task 14: Worker wiring

**Files:**
- Modify: `src/worker/index.ts` (full rewrite of `handleJob`)
- Modify: `test/worker.test.ts` (full rewrite for the new pipeline)

**Interfaces:**
- Consumes: `extractFile` (Task 8); `buildSolutionMarkdown` (Task 10); `renderSolutionPdf` (Task 11); `createFileProcessor` (Task 12); `createNextcloudWriter` (Task 13); `FileJobData` (`src/queue/index.ts`, unchanged).
- Produces: `createFileJobWorker(): Worker<FileJobData>` (same export name/shape as today — no downstream consumers outside this file and its test).

- [ ] **Step 1: Write the failing tests (full rewrite of the test file)**

```ts
// test/worker.test.ts
import { describe, expect, it, vi, beforeEach } from 'vitest';

const extractFile = vi.fn();
const buildSolutionMarkdown = vi.fn();
const renderSolutionPdf = vi.fn();
const processFile = vi.fn();
const writeResult = vi.fn();
const mkdtemp = vi.fn();
const mkdir = vi.fn();
const rename = vi.fn();
const rmdir = vi.fn();
const rm = vi.fn();

vi.mock('node:fs', () => ({
  promises: { mkdtemp, mkdir, rename, rmdir, rm },
}));
vi.mock('node:os', () => ({ tmpdir: () => '/tmp' }));
vi.mock('../src/extract/index.js', () => ({ extractFile }));
vi.mock('../src/pdf/buildMarkdown.js', () => ({ buildSolutionMarkdown }));
vi.mock('../src/pdf/renderPdf.js', () => ({ renderSolutionPdf }));
vi.mock('../src/claude/processFile.js', () => ({ createFileProcessor: () => ({ processFile }) }));
vi.mock('../src/nextcloud/writeResult.js', () => ({ createNextcloudWriter: () => ({ writeResult }) }));
vi.mock('../src/queue/index.js', () => ({
  QUEUE_NAME: 'teams-file-jobs',
  getRedisConnection: () => ({}),
}));
vi.mock('bullmq', () => ({
  Worker: vi.fn().mockImplementation(() => ({ on: vi.fn() })),
}));

process.env.INGEST_WATCH_DIR = '/inbox';

const AUFGABENBLATT_RESULT = {
  originalFileName: 'arbeitsblatt1.pdf',
  isMaterialblatt: false,
  fach: 'BGWP',
  thema: 'Kaufvertragsrecht',
  tasksFound: [{ title: 't', taskDescription: 'q', proposedSolution: 'a' }],
};

const MATERIAL_RESULT = {
  originalFileName: 'handout.pdf',
  isMaterialblatt: true,
  fach: 'Deutsch',
  thema: 'Grammatikregeln',
  tasksFound: [],
};

describe('worker pipeline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mkdtemp.mockResolvedValue('/tmp/job-abc123');
    mkdir.mockResolvedValue(undefined);
    rename.mockResolvedValue(undefined);
    rmdir.mockResolvedValue(undefined);
    rm.mockResolvedValue(undefined);
  });

  it('extracts, solves, renders a PDF, writes it, and archives the raw source when OCR did not run', async () => {
    extractFile.mockResolvedValue({ markdown: '# text', visionPages: [], ranOcr: false, archivalPdfPath: '/inbox/arbeitsblatt1.pdf' });
    processFile.mockResolvedValue(AUFGABENBLATT_RESULT);
    buildSolutionMarkdown.mockReturnValue('# solution markdown');
    renderSolutionPdf.mockResolvedValue(Buffer.from('%PDF fake'));
    writeResult.mockResolvedValue({ writtenPath: '/data/alice/files/Fächer/BGWP/arbeitsblatt1_Loesung_2026-07-23.pdf' });

    const { createFileJobWorker } = await import('../src/worker/index.js');
    const { Worker } = await import('bullmq');
    createFileJobWorker();

    const handler = vi.mocked(Worker).mock.calls[0][1] as (job: unknown) => Promise<void>;
    const job = { id: '1', data: { filePath: '/inbox/arbeitsblatt1.pdf', originalFileName: 'arbeitsblatt1.pdf', receivedAt: 'now' } };
    await handler(job);

    expect(extractFile).toHaveBeenCalledWith('/inbox/arbeitsblatt1.pdf', '/tmp/job-abc123');
    expect(processFile).toHaveBeenCalledWith('arbeitsblatt1.pdf', expect.objectContaining({ markdown: '# text' }));
    expect(buildSolutionMarkdown).toHaveBeenCalledWith(AUFGABENBLATT_RESULT, expect.any(String));
    expect(renderSolutionPdf).toHaveBeenCalledWith('# solution markdown');
    expect(writeResult).toHaveBeenCalledWith(
      AUFGABENBLATT_RESULT,
      { kind: 'pdf', bytes: Buffer.from('%PDF fake') },
      expect.any(String),
    );

    // ranOcr was false, so the ORIGINAL file (not archivalPdfPath) is archived.
    expect(rename).toHaveBeenCalledTimes(1);
    const [movedFrom, movedTo] = rename.mock.calls[0] as [string, string];
    expect(movedFrom).toBe('/inbox/arbeitsblatt1.pdf');
    expect(movedTo).toMatch(/[/\\]\.processed[/\\]\d+-arbeitsblatt1\.pdf$/);
  });

  it('archives the OCR\'d searchable PDF (not the raw scan) when extraction ran OCR', async () => {
    extractFile.mockResolvedValue({ markdown: '# text', visionPages: [], ranOcr: true, archivalPdfPath: '/tmp/job-abc123/ocr.pdf' });
    processFile.mockResolvedValue(AUFGABENBLATT_RESULT);
    buildSolutionMarkdown.mockReturnValue('# solution markdown');
    renderSolutionPdf.mockResolvedValue(Buffer.from('%PDF fake'));
    writeResult.mockResolvedValue({ writtenPath: '/data/x.pdf' });

    const { createFileJobWorker } = await import('../src/worker/index.js');
    const { Worker } = await import('bullmq');
    createFileJobWorker();

    const handler = vi.mocked(Worker).mock.calls[0][1] as (job: unknown) => Promise<void>;
    const job = { id: '1', data: { filePath: '/inbox/scan.pdf', originalFileName: 'scan.pdf', receivedAt: 'now' } };
    await handler(job);

    const [movedFrom] = rename.mock.calls[0] as [string, string];
    expect(movedFrom).toBe('/tmp/job-abc123/ocr.pdf');
  });

  it('skips PDF generation and writes the archival source directly for a Materialblatt', async () => {
    extractFile.mockResolvedValue({ markdown: '# text', visionPages: [], ranOcr: false, archivalPdfPath: '/inbox/handout.pdf' });
    processFile.mockResolvedValue(MATERIAL_RESULT);
    writeResult.mockResolvedValue({ writtenPath: '/data/alice/files/Fächer/Deutsch/Material/handout_2026-07-23.pdf' });

    const { createFileJobWorker } = await import('../src/worker/index.js');
    const { Worker } = await import('bullmq');
    createFileJobWorker();

    const handler = vi.mocked(Worker).mock.calls[0][1] as (job: unknown) => Promise<void>;
    const job = { id: '1', data: { filePath: '/inbox/handout.pdf', originalFileName: 'handout.pdf', receivedAt: 'now' } };
    await handler(job);

    expect(buildSolutionMarkdown).not.toHaveBeenCalled();
    expect(renderSolutionPdf).not.toHaveBeenCalled();
    expect(writeResult).toHaveBeenCalledWith(
      MATERIAL_RESULT,
      { kind: 'material', sourcePath: '/inbox/handout.pdf' },
      expect.any(String),
    );
  });

  it('archives the source into the failed dir and rethrows when extraction fails', async () => {
    extractFile.mockRejectedValue(new Error('ocrmypdf blew up'));

    const { createFileJobWorker } = await import('../src/worker/index.js');
    const { Worker } = await import('bullmq');
    createFileJobWorker();

    const handler = vi.mocked(Worker).mock.calls[0][1] as (job: unknown) => Promise<void>;
    const job = { id: '1', data: { filePath: '/inbox/arbeitsblatt1.pdf', originalFileName: 'arbeitsblatt1.pdf', receivedAt: 'now' } };

    await expect(handler(job)).rejects.toThrow('ocrmypdf blew up');

    expect(writeResult).not.toHaveBeenCalled();
    const [, movedTo] = rename.mock.calls[0] as [string, string];
    expect(movedTo).toMatch(/[/\\]\.failed[/\\]\d+-arbeitsblatt1\.pdf$/);
  });

  it('cleans up a zip-extraction staging directory after archiving the file it contained', async () => {
    extractFile.mockResolvedValue({ markdown: '# text', visionPages: [], ranOcr: false, archivalPdfPath: '/inbox/.staging/uuid-1/a.md' });
    processFile.mockResolvedValue({ ...MATERIAL_RESULT, originalFileName: 'a.md' });
    writeResult.mockResolvedValue({ writtenPath: '/data/x.md' });

    const { createFileJobWorker } = await import('../src/worker/index.js');
    const { Worker } = await import('bullmq');
    createFileJobWorker();

    const handler = vi.mocked(Worker).mock.calls[0][1] as (job: unknown) => Promise<void>;
    const job = { id: '1', data: { filePath: '/inbox/.staging/uuid-1/a.md', originalFileName: 'a.md', receivedAt: 'now' } };
    await handler(job);

    expect(rmdir).toHaveBeenCalledWith('/inbox/.staging/uuid-1');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- test/worker.test.ts`
Expected: FAIL — old `handleJob` reads the file directly and calls the old `processFile`/`writeResult` shapes.

- [ ] **Step 3: Rewrite `src/worker/index.ts`**

```ts
// src/worker/index.ts
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Worker, type Job } from 'bullmq';
import pino from 'pino';
import { QUEUE_NAME, getRedisConnection, type FileJobData } from '../queue/index.js';
import { extractFile } from '../extract/index.js';
import { createFileProcessor } from '../claude/processFile.js';
import { buildSolutionMarkdown } from '../pdf/buildMarkdown.js';
import { renderSolutionPdf } from '../pdf/renderPdf.js';
import { createNextcloudWriter } from '../nextcloud/writeResult.js';
import { config } from '../config/index.js';
import type { NextcloudWriteContent } from '../types.js';

const logger = pino({ name: 'worker' });

const fileProcessor = createFileProcessor();
const nextcloudWriter = createNextcloudWriter();

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

async function archiveFile(filePath: string, dirName: string): Promise<void> {
  const watchDir = path.resolve(config.ingest.watchDir);
  const destDir = path.join(watchDir, dirName);
  await fs.mkdir(destDir, { recursive: true });
  const dest = path.join(destDir, `${Date.now()}-${path.basename(filePath)}`);
  await fs.rename(filePath, dest);

  const sourceDir = path.dirname(filePath);
  if (sourceDir !== watchDir) {
    await fs.rmdir(sourceDir).catch(() => undefined);
  }
}

async function handleJob(job: Job<FileJobData>): Promise<void> {
  const { filePath, originalFileName } = job.data;
  logger.info({ jobId: job.id, filePath, originalFileName }, 'processing file job');

  let archivalPath = filePath;
  try {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'extract-'));
    const extraction = await extractFile(filePath, workDir);
    archivalPath = extraction.archivalPdfPath;

    const result = await fileProcessor.processFile(originalFileName, extraction);
    const datum = today();

    let content: NextcloudWriteContent;
    if (result.isMaterialblatt) {
      content = { kind: 'material', sourcePath: extraction.archivalPdfPath };
    } else {
      const markdown = buildSolutionMarkdown(result, datum);
      const pdfBytes = await renderSolutionPdf(markdown);
      content = { kind: 'pdf', bytes: pdfBytes };
    }

    const { writtenPath } = await nextcloudWriter.writeResult(result, content, datum);
    await archiveFile(archivalPath, config.ingest.processedDirName);
    logger.info({ jobId: job.id, writtenPath, tasksFound: result.tasksFound.length }, 'file job complete');
  } catch (err) {
    await archiveFile(archivalPath, config.ingest.failedDirName).catch((archiveErr: unknown) => {
      logger.error({ archiveErr, filePath: archivalPath }, 'Failed to archive file after processing failure');
    });
    throw err;
  }
}

export function createFileJobWorker(): Worker<FileJobData> {
  const worker = new Worker<FileJobData>(QUEUE_NAME, handleJob, {
    connection: getRedisConnection(),
  });

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err }, 'file job failed');
  });

  return worker;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  createFileJobWorker();
  logger.info('worker started');
}
```

Note on the `archivalPath` variable: if `extractFile` throws before returning, `archivalPath` is still the original `filePath`, so the failure branch archives the source that was actually dropped (there's no OCR'd version to prefer yet). Once `extractFile` succeeds, `archivalPath` is updated to `extraction.archivalPdfPath` — matching the third worker test ("cleans up a zip-extraction staging directory") which stubs `archivalPdfPath` to the staged file's path and expects that same path's *directory* (`.staging/uuid-1`) to be `rmdir`'d.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- test/worker.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/worker/index.ts test/worker.test.ts
git commit -m "feat: wire extraction -> solve -> PDF generation/material routing -> archive in the worker"
```

---

