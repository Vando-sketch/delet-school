import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { config } from '../config/index.js';

export const QUEUE_NAME = 'teams-file-jobs';

export interface FileJobData {
  driveId: string;
  itemId: string;
  resourceUrl: string;
  changeType: string;
  receivedAt: string;
}

let connection: IORedis | undefined;
let queue: Queue<FileJobData> | undefined;

export function getRedisConnection(): IORedis {
  connection ??= new IORedis(config.redis.url, { maxRetriesPerRequest: null });
  return connection;
}

export function getFileJobQueue(): Queue<FileJobData> {
  queue ??= new Queue<FileJobData>(QUEUE_NAME, { connection: getRedisConnection() });
  return queue;
}
