import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createWebServer } from '../src/web/server.js';
import { config } from '../src/config/index.js';

describe('Web Server API', () => {
  let tmpInbox: string;
  let originalWatchDir: string;

  beforeEach(async () => {
    tmpInbox = await fs.mkdtemp(path.join(os.tmpdir(), 'web-inbox-test-'));
    originalWatchDir = config.ingest.watchDir;
    config.ingest.watchDir = tmpInbox;
  });

  afterEach(async () => {
    config.ingest.watchDir = originalWatchDir;
    await fs.rm(tmpInbox, { recursive: true, force: true }).catch(() => {});
  });

  it('serves dashboard HTML at /', async () => {
    const app = createWebServer();
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/html/);
    expect(res.text).toContain('Home Hub');
  });

  it('returns status info at /api/status', async () => {
    const app = createWebServer();
    const res = await request(app).get('/api/status');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.banking).toBeDefined();
  });

  it('returns banking accounts at /api/banking/accounts', async () => {
    const app = createWebServer();
    const res = await request(app).get('/api/banking/accounts');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('accounts');
    expect(res.body).toHaveProperty('transactions');
    expect(res.body).toHaveProperty('statements');
  });

  it('uploads a file into the inbox at /api/upload', async () => {
    const app = createWebServer();
    const testBuffer = Buffer.from('test file contents for processing');

    const res = await request(app)
      .post('/api/upload')
      .attach('files', testBuffer, 'homework.pdf');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.count).toBe(1);

    // Verify file actually exists in tmpInbox
    const uploadedPath = path.join(tmpInbox, 'homework.pdf');
    const content = await fs.readFile(uploadedPath, 'utf-8');
    expect(content).toBe('test file contents for processing');
  });

  it('triggers bank sync at /api/banking/sync', async () => {
    const app = createWebServer();
    const res = await request(app).post('/api/banking/sync');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('success');
  });

  it('rejects /api/banking/tan when no TAN provided', async () => {
    const app = createWebServer();
    const res = await request(app).post('/api/banking/tan').send({});
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });
});
