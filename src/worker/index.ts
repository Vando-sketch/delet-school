import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Worker, type Job } from 'bullmq';
import pino from 'pino';
import { QUEUE_NAME, getRedisConnection, type FileJobData } from '../queue/index.js';
import { extractFile } from '../extract/index.js';
import { checkNearDuplicate } from '../ingest/nearDup.js';
import { createFileProcessor } from '../claude/processFile.js';
import { buildSolutionMarkdown } from '../pdf/buildMarkdown.js';
import { renderSolutionPdf } from '../pdf/renderPdf.js';
import { createNextcloudWriter } from '../nextcloud/writeResult.js';
import { config } from '../config/index.js';
import type { NextcloudWriteContent } from '../types.js';
import { renameOrCopy } from '../lib/renameOrCopy.js';

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
  await renameOrCopy(filePath, dest);

  // Only prune the source directory when it's a job-scratch or zip-extraction staging
  // directory under .staging/ - never a real subfolder of watchDir a file was dropped into
  // directly. Before subfolder support, `sourceDir !== watchDir` was an adequate proxy for
  // "this is a staging dir" (the only non-watchDir source a file could ever have). That stops
  // being true once subfolders are watched: a plain file at watchDir/Mathe/AB1.pdf has
  // sourceDir = watchDir/Mathe, which is not a staging dir and must be left in place even once
  // empty (see docs/superpowers/specs/2026-07-24-ocr-quality-and-subfolder-ingest-design.md,
  // "Explicitly out of scope: empty subfolder cleanup").
  const stagingRoot = path.join(watchDir, config.ingest.stagingDirName);
  const sourceDir = path.dirname(filePath);
  if (sourceDir === stagingRoot || sourceDir.startsWith(stagingRoot + path.sep)) {
    await fs.rmdir(sourceDir).catch(() => undefined);
  }
}

async function removeOriginalIfArchivedElsewhere(filePath: string, archivalPath: string): Promise<void> {
  if (archivalPath !== filePath) {
    await fs.rm(filePath, { force: true }).catch(() => undefined);
  }
}

async function handleJob(job: Job<FileJobData>): Promise<void> {
  const { filePath, originalFileName, batchId } = job.data;
  logger.info({ jobId: job.id, filePath, originalFileName, batchId }, 'processing file job');

  // Kept inside watchDir (in the same ignored staging subfolder the ingest watcher uses for
  // zip extraction) rather than os.tmpdir(), so it's on the same filesystem/device as the
  // archive destinations - fs.rename() in archiveFile() can't cross a device boundary (EXDEV).
  const workDir = path.join(path.resolve(config.ingest.watchDir), config.ingest.stagingDirName, randomUUID());
  let archivalPath = filePath;
  try {
    await fs.mkdir(workDir, { recursive: true });
    const extraction = await extractFile(filePath, workDir);
    archivalPath = extraction.archivalPdfPath;

    const verdict = await checkNearDuplicate(extraction.markdown);

    if (verdict.tier === 'duplicate') {
      logger.info({ jobId: job.id, matchedFile: verdict.matchedFile, distance: verdict.distance }, 'file skipped as duplicate');
      await archiveFile(archivalPath, config.ingest.processedDirName);
      await removeOriginalIfArchivedElsewhere(filePath, archivalPath);
      return;
    }

    if (verdict.tier === 'flagged') {
      logger.warn({ jobId: job.id, matchedFile: verdict.matchedFile, distance: verdict.distance }, 'file flagged as near-duplicate');
    }

    const result = await fileProcessor.processFile(originalFileName, extraction, job.data.siblingManifest);
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
    await removeOriginalIfArchivedElsewhere(filePath, archivalPath);
    logger.info({ jobId: job.id, writtenPath, tasksFound: result.tasksFound.length }, 'file job complete');
  } catch (err) {
    await archiveFile(archivalPath, config.ingest.failedDirName).catch((archiveErr: unknown) => {
      logger.error({ archiveErr, filePath: archivalPath }, 'Failed to archive file after processing failure');
    });
    await removeOriginalIfArchivedElsewhere(filePath, archivalPath);
    throw err;
  } finally {
    // Always clean up the scratch dir (OCR output, vision-fallback page images), whether the
    // job succeeded, failed, or archiving failed - it's created fresh per job and never reused.
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function createFileJobWorker(): Worker<FileJobData> {
  const worker = new Worker<FileJobData>(QUEUE_NAME, handleJob, {
    connection: getRedisConnection(),
    concurrency: config.worker.concurrency,
  });

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, batchId: job?.data.batchId, err }, 'file job failed');
  });

  return worker;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  createFileJobWorker();
  logger.info('worker started');
}
