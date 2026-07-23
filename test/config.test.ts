import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const REQUIRED_ENV = {
  NEXTCLOUD_DATA_DIR: '/data',
  NEXTCLOUD_TARGET_USER: 'alice',
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
});
