import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { config } from '../config/index.js';
import type { SiblingManifestEntry } from '../types.js';

export const QUEUE_NAME = 'teams-file-jobs';

export type { SiblingManifestEntry };

export interface FileJobData {
  /** Absolute path to the ingested file on disk, readable by the worker process. */
  filePath: string;
  /** Original file name (pre-sanitization), used for display and as the basis of output naming. */
  originalFileName: string;
  receivedAt: string;
  /** Present only for files extracted from the same zip; undefined for standalone drops. */
  batchId?: string;
  /** Lightweight excerpts of every OTHER file from the same batch, for classification context. */
  siblingManifest?: SiblingManifestEntry[];
}

let connection: Redis | undefined;
let queue: Queue<FileJobData> | undefined;

export function getRedisConnection(): Redis {
  connection ??= new Redis(config.redis.url, { maxRetriesPerRequest: null });
  return connection;
}

export function getFileJobQueue(): Queue<FileJobData> {
  queue ??= new Queue<FileJobData>(QUEUE_NAME, { connection: getRedisConnection() });
  return queue;
}
