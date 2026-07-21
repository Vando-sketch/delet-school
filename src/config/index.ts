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
    // No fallback default: leaving ANTHROPIC_API_KEY unset is valid and expected when the
    // Claude Agent SDK subprocess is authenticated via a Claude Pro/Max subscription login
    // (`claude login`) instead of API billing. The SDK subprocess inherits process.env and
    // resolves its own auth source; we don't require a key here.
    apiKey: (): string | undefined => process.env.ANTHROPIC_API_KEY,
    model: optional('ANTHROPIC_MODEL', 'claude-haiku-4-5-20251001'),
  },
  nextcloud: {
    dataDir: () => required('NEXTCLOUD_DATA_DIR'),
    targetUser: () => required('NEXTCLOUD_TARGET_USER'),
    occBinary: optional('NEXTCLOUD_OCC_BIN', '/var/www/nextcloud/occ'),
  },
};
