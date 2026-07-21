import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import pino from 'pino';
import type { Queue } from 'bullmq';
import { config } from '../config/index.js';
import { getFileJobQueue, type FileJobData } from '../queue/index.js';

const logger = pino({ name: 'receiver' });

/**
 * A single item from Graph's `value` array in a change-notification batch.
 * Field shapes below follow the documented Microsoft Graph webhook payload:
 * https://learn.microsoft.com/en-us/graph/webhooks#notification-payload
 */
interface GraphNotification {
  subscriptionId?: string;
  clientState?: string;
  changeType?: string;
  resource?: string;
  resourceData?: {
    id?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface GraphNotificationBatch {
  value?: GraphNotification[];
}

/** Minimal surface of a BullMQ Queue this module needs, so tests can inject a stub. */
type FileJobQueueLike = Pick<Queue<FileJobData>, 'add'>;

export interface CreateReceiverAppOptions {
  queue?: FileJobQueueLike;
}

/**
 * Extracts driveId/itemId from a Graph notification.
 *
 * ASSUMPTION (pending real Graph testing): for OneDrive/SharePoint drive-item
 * subscriptions, `resource` is documented as `drives/{drive-id}/items/{item-id}`.
 * We parse both ids from that string. As a defensive fallback (in case Graph ever
 * sends a `resource` without the item segment, or a differently-shaped resource
 * for e.g. site-scoped subscriptions), we fall back to combining `resourceData.id`
 * with just the driveId portion of `resource`. If neither parse succeeds, the
 * notification is dropped with a warning rather than enqueuing a malformed job.
 */
function parseDriveItem(notification: GraphNotification): { driveId: string; itemId: string } | undefined {
  const resource = notification.resource ?? '';

  const full = /drives\/([^/]+)\/items\/([^/]+)/.exec(resource);
  if (full) {
    return { driveId: full[1], itemId: full[2] };
  }

  const driveOnly = /drives\/([^/]+)/.exec(resource);
  const resourceDataId = notification.resourceData?.id;
  if (driveOnly && typeof resourceDataId === 'string' && resourceDataId.length > 0) {
    return { driveId: driveOnly[1], itemId: resourceDataId };
  }

  return undefined;
}

async function handleNotification(notification: GraphNotification, queue: FileJobQueueLike): Promise<void> {
  const expectedClientState = config.graph.webhookClientState;
  if (expectedClientState && notification.clientState !== expectedClientState) {
    logger.warn(
      { subscriptionId: notification.subscriptionId },
      'Notification clientState did not match configured value; dropping',
    );
    return;
  }

  const parsed = parseDriveItem(notification);
  if (!parsed) {
    logger.warn({ notification }, 'Could not determine driveId/itemId from notification; dropping');
    return;
  }

  const jobData: FileJobData = {
    driveId: parsed.driveId,
    itemId: parsed.itemId,
    resourceUrl: notification.resource ?? '',
    changeType: notification.changeType ?? 'unknown',
    receivedAt: new Date().toISOString(),
  };

  await queue.add('process-file', jobData);
  logger.info({ driveId: jobData.driveId, itemId: jobData.itemId }, 'Enqueued file job');
}

export function createReceiverApp(options: CreateReceiverAppOptions = {}): Express {
  const queue = options.queue ?? getFileJobQueue();
  const app = express();

  // Subscription validation handshake. Must be checked *before* any body parsing
  // and respond with the raw, undecoded-by-JSON token as text/plain — not JSON.
  // Registered ahead of express.json() so the body is never touched for this case.
  app.post('/webhook', (req: Request, res: Response, next: NextFunction) => {
    const validationToken = req.query.validationToken;
    if (typeof validationToken === 'string') {
      res.status(200).type('text/plain').send(validationToken);
      return;
    }
    next();
  });

  app.use(express.json());

  app.get('/health', (_req: Request, res: Response) => {
    res.status(200).json({ status: 'ok' });
  });

  // Change-notification batch handler. Per Microsoft's guidance, we must respond
  // within ~3 seconds and must not do any real processing inline (no Graph calls,
  // no downloads) — only validate clientState and enqueue a job per notification.
  app.post('/webhook', (req: Request, res: Response) => {
    const body = req.body as GraphNotificationBatch | undefined;
    const notifications = body?.value ?? [];

    // Always ack quickly regardless of per-notification validity, per Graph's
    // own guidance — invalid notifications are logged and dropped, not 500'd.
    res.status(202).end();

    for (const notification of notifications) {
      void handleNotification(notification, queue).catch((err: unknown) => {
        logger.error({ err, notification }, 'Failed to process/enqueue notification');
      });
    }
  });

  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = createReceiverApp();
  app.listen(config.receiver.port, () => {
    logger.info({ port: config.receiver.port }, 'Webhook receiver listening');
  });
}
