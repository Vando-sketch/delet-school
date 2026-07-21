import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { Worker, type Job } from 'bullmq';
import mime from 'mime-types';
import pino from 'pino';
import { QUEUE_NAME, getRedisConnection, type FileJobData } from '../queue/index.js';
import { createFileProcessor } from '../claude/processFile.js';
import { createNextcloudWriter } from '../nextcloud/writeResult.js';
import { config } from '../config/index.js';
import type { DownloadedFile } from '../types.js';

const logger = pino({ name: 'worker' });

const fileProcessor = createFileProcessor();
const nextcloudWriter = createNextcloudWriter();

/**
 * Moves a job's source file out of the ingest watcher's active tree (into `.processed` or
 * `.failed`) so it's never picked up again, then removes the staging directory it came from
 * if that was left empty (zip-extracted files each live in their own staging subdirectory).
 */
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

  const content = await fs.readFile(filePath);
  const file: DownloadedFile = {
    fileName: originalFileName,
    mimeType: mime.lookup(originalFileName) || 'application/octet-stream',
    content,
  };

  try {
    const result = await fileProcessor.processFile(file);
    const { writtenPath } = await nextcloudWriter.writeResult(result, file);
    await archiveFile(filePath, config.ingest.processedDirName);
    logger.info({ jobId: job.id, writtenPath, tasksFound: result.tasksFound.length }, 'file job complete');
  } catch (err) {
    await archiveFile(filePath, config.ingest.failedDirName).catch((archiveErr: unknown) => {
      logger.error({ archiveErr, filePath }, 'Failed to archive file after processing failure');
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
