import { Worker, type Job } from 'bullmq';
import pino from 'pino';
import { QUEUE_NAME, getRedisConnection, type FileJobData } from '../queue/index.js';
import { createGraphClient } from '../graph/client.js';
import { createFileProcessor } from '../claude/processFile.js';
import { createNextcloudWriter } from '../nextcloud/writeResult.js';

const logger = pino({ name: 'worker' });

const graphClient = createGraphClient();
const fileProcessor = createFileProcessor();
const nextcloudWriter = createNextcloudWriter();

async function handleJob(job: Job<FileJobData>): Promise<void> {
  const { driveId, itemId } = job.data;
  logger.info({ jobId: job.id, driveId, itemId }, 'processing file job');

  const file = await graphClient.downloadDriveItem(driveId, itemId);
  const result = await fileProcessor.processFile(file);
  const { writtenPath } = await nextcloudWriter.writeResult(result, file);

  logger.info({ jobId: job.id, writtenPath, tasksFound: result.tasksFound.length }, 'file job complete');
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
