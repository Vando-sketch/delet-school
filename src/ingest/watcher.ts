import { mkdirSync, promises as fs } from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { watch as chokidarWatch, type FSWatcher } from 'chokidar';
import AdmZip from 'adm-zip';
import pino from 'pino';
import type { Queue } from 'bullmq';
import { config } from '../config/index.js';
import { getFileJobQueue, type FileJobData, type SiblingManifestEntry } from '../queue/index.js';
import { createTaildropDrain } from './taildropDrain.js';
import { buildSiblingManifest } from './siblingManifest.js';

const logger = pino({ name: 'ingest-watcher' });

/** Minimal surface of a BullMQ Queue this module needs, so tests can inject a stub. */
type FileJobQueueLike = Pick<Queue<FileJobData>, 'add'>;

export interface CreateIngestWatcherOptions {
  queue?: FileJobQueueLike;
  /** Overrides config.ingest.watchDir - mainly for tests, which point this at a temp dir. */
  watchDir?: string;
}

function isZipFile(filePath: string): boolean {
  return path.extname(filePath).toLowerCase() === '.zip';
}

async function enqueueFile(
  queue: FileJobQueueLike,
  filePath: string,
  originalFileName: string,
  batch?: { batchId: string; siblingManifest: SiblingManifestEntry[] },
): Promise<void> {
  const jobData: FileJobData = {
    filePath,
    originalFileName,
    receivedAt: new Date().toISOString(),
    ...(batch ? { batchId: batch.batchId, siblingManifest: batch.siblingManifest } : {}),
  };
  await queue.add('process-file', jobData);
  logger.info({ filePath, originalFileName, batchId: batch?.batchId }, 'Enqueued file job');
}

/**
 * Hard ceiling on combined sibling-excerpt characters embedded in a single job, so a job's
 * Redis payload and the LLM prompt built from it don't grow O(N^2) with the batch size (every
 * file would otherwise embed every other file's full excerpt). Siblings are included in order
 * until the budget is spent; the rest are simply omitted from that job's context.
 */
const MAX_TOTAL_SIBLING_CHARS = 20_000;

function boundSiblingManifest(entries: SiblingManifestEntry[]): SiblingManifestEntry[] {
  const bounded: SiblingManifestEntry[] = [];
  let total = 0;
  for (const entry of entries) {
    if (total + entry.excerpt.length > MAX_TOTAL_SIBLING_CHARS) break;
    bounded.push(entry);
    total += entry.excerpt.length;
  }
  return bounded;
}

/** Recursively lists regular files under a directory (used to enqueue extracted zip contents). */
async function listFilesRecursive(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFilesRecursive(fullPath)));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

/** Moves a fully-handled top-level file into `watchDir/dirName`, timestamp-prefixed to avoid collisions. */
async function archiveFile(watchDir: string, filePath: string, dirName: string): Promise<void> {
  const destDir = path.join(watchDir, dirName);
  await fs.mkdir(destDir, { recursive: true });
  const dest = path.join(destDir, `${Date.now()}-${path.basename(filePath)}`);
  await fs.rename(filePath, dest);
}

/**
 * A dropped zip is extracted into a staging directory (inside watchDir but excluded from
 * watching - see `ignored` below), and every file found inside is enqueued as its own job,
 * mirroring what a Teams "download as zip" export produces (one job per document, same as
 * dropping the documents in individually). The zip itself is archived once extraction and
 * enqueueing succeed.
 */
async function handleZip(queue: FileJobQueueLike, watchDir: string, zipPath: string): Promise<void> {
  const stagingDir = path.join(watchDir, config.ingest.stagingDirName, randomUUID());
  await fs.mkdir(stagingDir, { recursive: true });

  new AdmZip(zipPath).extractAllTo(stagingDir, true);

  const extractedFiles = await listFilesRecursive(stagingDir);
  if (extractedFiles.length === 0) {
    logger.warn({ zipPath }, 'Zip archive contained no files; nothing to enqueue');
  }

  // Captured once upfront, before any file in the batch can be archived away by the worker -
  // every job embeds its siblings' excerpts directly rather than reading them live off disk later.
  const batchId = randomUUID();
  const manifestByPath = await buildSiblingManifest(
    extractedFiles.map((filePath) => ({ filePath, relativeName: path.relative(stagingDir, filePath) })),
  );

  for (const filePath of extractedFiles) {
    const siblingManifest = boundSiblingManifest(
      extractedFiles
        .filter((other) => other !== filePath)
        .map((other) => manifestByPath.get(other))
        .filter((entry): entry is SiblingManifestEntry => entry !== undefined),
    );
    await enqueueFile(queue, filePath, path.relative(stagingDir, filePath), { batchId, siblingManifest });
  }

  await archiveFile(watchDir, zipPath, config.ingest.processedDirName);
}

async function handlePlainFile(queue: FileJobQueueLike, filePath: string): Promise<void> {
  await enqueueFile(queue, filePath, path.basename(filePath));
}

/**
 * Watches `watchDir` (default: a local "inbox" folder, e.g. one synced with Nextcloud) for
 * manually-downloaded files and enqueues a processing job per file. Replaces the old
 * Microsoft Graph webhook trigger for setups where an Azure AD app registration (and admin
 * consent) isn't available - files are exported/downloaded by hand instead and dropped here.
 */
export function createIngestWatcher(options: CreateIngestWatcherOptions = {}): FSWatcher {
  const queue = options.queue ?? getFileJobQueue();
  const watchDir = path.resolve(options.watchDir ?? config.ingest.watchDir);
  mkdirSync(watchDir, { recursive: true });

  const ignoredDirs = [config.ingest.processedDirName, config.ingest.failedDirName, config.ingest.stagingDirName].map(
    (name) => path.join(watchDir, name),
  );

  const watcher = chokidarWatch(watchDir, {
    ignoreInitial: false,
    // Top-level dot-directories (.processed/.failed/.staging) hold this watcher's own
    // output and must never be re-ingested.
    ignored: (candidate) => ignoredDirs.some((dir) => candidate === dir || candidate.startsWith(dir + path.sep)),
    // Files land here via copy/upload/sync, which can take a moment; wait for the file
    // size to stop changing before treating it as "added" so partial files aren't ingested.
    awaitWriteFinish: {
      stabilityThreshold: config.ingest.stabilityThresholdMs,
      pollInterval: 100,
    },
    depth: 0,
  });

  watcher.on('add', (filePath) => {
    void (isZipFile(filePath) ? handleZip(queue, watchDir, filePath) : handlePlainFile(queue, filePath)).catch(
      (err: unknown) => {
        logger.error({ err, filePath }, 'Failed to ingest file');
      },
    );
  });

  watcher.on('error', (err: unknown) => {
    logger.error({ err }, 'Ingest watcher error');
  });

  return watcher;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const watcher = createIngestWatcher();
  watcher.on('ready', () => {
    logger.info({ watchDir: path.resolve(config.ingest.watchDir) }, 'Ingest watcher ready');
  });
  createTaildropDrain();
  logger.info({ stagingDir: path.resolve(config.taildrop.stagingDir) }, 'Taildrop drain loop started');
}
