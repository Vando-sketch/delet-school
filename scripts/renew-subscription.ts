/**
 * Standalone script to renew a Microsoft Graph webhook subscription. Intended to run as a
 * cron/systemd-timer job well before the subscription's expirationDateTime — Graph
 * subscriptions are never renewed automatically, and if one is allowed to expire the
 * webhook silently stops delivering notifications (Graph gives no error, notifications
 * just cease).
 *
 * Subscription-ID persistence: this scaffold does not yet have a persistence layer
 * (Redis/file/db) for subscription IDs, so this script pragmatically reads the ID from
 * the GRAPH_SUBSCRIPTION_ID env var. Future work: once createSubscription is called from
 * a setup/bootstrap flow, persist the returned `id` (e.g. in Redis alongside the queue
 * connection already set up in src/queue/index.ts) and have this script look it up there
 * instead of relying on an env var that has to be updated by hand whenever the
 * subscription is recreated.
 *
 * Expiration window: Microsoft Graph enforces a *maximum* expiration per resource type —
 * for drive/site (SharePoint/OneDrive) resources that max is 43200 minutes (30 days); for
 * Teams chat/channel message resources it is much shorter (~60 minutes for chatMessage,
 * ~4230 minutes / ~2.94 days for channel messages). This script defaults to a
 * conservative 2-day (2880 minute) renewal window via GRAPH_SUBSCRIPTION_EXPIRATION_MINUTES,
 * which is safely under all of those caps; override the env var if you know the exact
 * resource type's limit and want to renew closer to it.
 */
import pino from 'pino';
import { createGraphClient } from '../src/graph/client.js';

const logger = pino({ name: 'renew-subscription' });

const DEFAULT_EXPIRATION_MINUTES = 60 * 24 * 2; // 2 days

function readSubscriptionId(): string {
  const id = process.env.GRAPH_SUBSCRIPTION_ID;
  if (!id) {
    throw new Error(
      'Missing required environment variable: GRAPH_SUBSCRIPTION_ID (the id of the ' +
        'subscription to renew; see comment at the top of this script)',
    );
  }
  return id;
}

function readExpirationMinutes(): number {
  const raw = process.env.GRAPH_SUBSCRIPTION_EXPIRATION_MINUTES;
  if (!raw) {
    return DEFAULT_EXPIRATION_MINUTES;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(
      `Invalid GRAPH_SUBSCRIPTION_EXPIRATION_MINUTES value: "${raw}" (must be a positive number)`,
    );
  }
  return parsed;
}

async function main(): Promise<void> {
  const subscriptionId = readSubscriptionId();
  const expirationMinutes = readExpirationMinutes();
  const expirationDateTime = new Date(Date.now() + expirationMinutes * 60_000).toISOString();

  logger.info({ subscriptionId, expirationDateTime, expirationMinutes }, 'Renewing Graph subscription');

  const client = createGraphClient();
  await client.renewSubscription(subscriptionId, expirationDateTime);

  logger.info({ subscriptionId, expirationDateTime }, 'Subscription renewed successfully');
}

main().catch((error: unknown) => {
  logger.error({ err: error }, 'Failed to renew Graph subscription');
  process.exitCode = 1;
});
