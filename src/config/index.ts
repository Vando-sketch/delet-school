import 'dotenv/config';

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

export const config = {
  receiver: {
    port: Number(optional('RECEIVER_PORT', '3000')),
  },
  redis: {
    url: optional('REDIS_URL', 'redis://localhost:6379'),
  },
  graph: {
    tenantId: () => required('GRAPH_TENANT_ID'),
    clientId: () => required('GRAPH_CLIENT_ID'),
    clientSecret: () => required('GRAPH_CLIENT_SECRET'),
    webhookClientState: optional('GRAPH_WEBHOOK_CLIENT_STATE', ''),
    notificationUrl: () => required('GRAPH_NOTIFICATION_URL'),
  },
  anthropic: {
    apiKey: () => required('ANTHROPIC_API_KEY'),
  },
  nextcloud: {
    dataDir: () => required('NEXTCLOUD_DATA_DIR'),
    targetUser: () => required('NEXTCLOUD_TARGET_USER'),
    occBinary: optional('NEXTCLOUD_OCC_BIN', '/var/www/nextcloud/occ'),
  },
};
