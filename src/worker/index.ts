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
