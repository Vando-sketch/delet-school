import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const REQUIRED_ENV = {
  NEXTCLOUD_BASE_URL: 'https://nextcloud.example.ts.net',
  NEXTCLOUD_USERNAME: 'alice',
  NEXTCLOUD_APP_PASSWORD: 'app-password',
  STUDENT_NAME: 'Elias Helmer',
  STUDENT_KLASSE: 'IT10b',
};

describe('config defaults', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    for (const [key, value] of Object.entries(REQUIRED_ENV)) process.env[key] = value;
    delete process.env.INGEST_WATCH_DIR;
    delete process.env.ANTHROPIC_MODEL;
    delete process.env.TAILDROP_STAGING_DIR;
    delete process.env.TAILDROP_POLL_INTERVAL_MS;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('defaults INGEST_WATCH_DIR to __INBOX__', async () => {
    const { config } = await import('../src/config/index.js');
    expect(config.ingest.watchDir).toBe('__INBOX__');
  });

  it('defaults ANTHROPIC_MODEL to claude-sonnet-5', async () => {
    const { config } = await import('../src/config/index.js');
    expect(config.anthropic.model).toBe('claude-sonnet-5');
  });

  it('exposes required STUDENT_NAME / STUDENT_KLASSE', async () => {
    const { config } = await import('../src/config/index.js');
    expect(config.student.name()).toBe('Elias Helmer');
    expect(config.student.klasse()).toBe('IT10b');
  });

  it('exposes required Nextcloud WebDAV settings', async () => {
    const { config } = await import('../src/config/index.js');
    expect(config.nextcloud.baseUrl()).toBe('https://nextcloud.example.ts.net');
    expect(config.nextcloud.username()).toBe('alice');
    expect(config.nextcloud.appPassword()).toBe('app-password');
  });

  it('defaults TAILDROP_STAGING_DIR and TAILDROP_POLL_INTERVAL_MS', async () => {
    const { config } = await import('../src/config/index.js');
    expect(config.taildrop.stagingDir).toBe('/taildrop-staging');
    expect(config.taildrop.pollIntervalMs).toBe(5000);
  });

  it('reads TAILDROP_POLL_INTERVAL_MS as a number when set', async () => {
    process.env.TAILDROP_POLL_INTERVAL_MS = '2000';
    const { config } = await import('../src/config/index.js');
    expect(config.taildrop.pollIntervalMs).toBe(2000);
  });
});
