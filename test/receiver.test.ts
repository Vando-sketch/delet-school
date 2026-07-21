import { describe, expect, it, vi, beforeEach } from 'vitest';
import request from 'supertest';
import type { Queue } from 'bullmq';
import { createReceiverApp } from '../src/receiver/index.js';
import type { FileJobData } from '../src/queue/index.js';

function createFakeQueue() {
  return {
    add: vi.fn().mockResolvedValue(undefined),
  } as unknown as Pick<Queue<FileJobData>, 'add'>;
}

describe('receiver app', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  describe('GET /health', () => {
    it('returns 200 with status ok', async () => {
      const app = createReceiverApp({ queue: createFakeQueue() });

      const res = await request(app).get('/health');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'ok' });
    });
  });

  describe('POST /webhook validation handshake', () => {
    it('echoes the raw validation token as text/plain with 200', async () => {
      const app = createReceiverApp({ queue: createFakeQueue() });
      const token = 'this-is-a-validation-token-123';

      const res = await request(app).post('/webhook').query({ validationToken: token }).send();

      expect(res.status).toBe(200);
      expect(res.type).toBe('text/plain');
      expect(res.text).toBe(token);
    });

    it('does not attempt to parse the body during the handshake', async () => {
      const app = createReceiverApp({ queue: createFakeQueue() });
      const token = 'another-token';

      // Send malformed JSON as the body; if the handshake path tried to parse it
      // as JSON, this would blow up with a 400 instead of returning the token.
      const res = await request(app)
        .post('/webhook')
        .query({ validationToken: token })
        .set('Content-Type', 'application/json')
        .send('{not valid json');

      expect(res.status).toBe(200);
      expect(res.text).toBe(token);
    });
  });

  describe('POST /webhook change notifications', () => {
    it('returns 202 and enqueues a job for a valid notification batch', async () => {
      const queue = createFakeQueue();
      const app = createReceiverApp({ queue });

      const res = await request(app)
        .post('/webhook')
        .send({
          value: [
            {
              subscriptionId: 'sub-1',
              clientState: '',
              changeType: 'updated',
              resource: 'drives/drive-abc/items/item-xyz',
              resourceData: { id: 'item-xyz' },
            },
          ],
        });

      expect(res.status).toBe(202);

      await vi.waitFor(() => {
        expect(queue.add).toHaveBeenCalledTimes(1);
      });

      const [jobName, jobData] = (queue.add as ReturnType<typeof vi.fn>).mock.calls[0] as [string, FileJobData];
      expect(jobName).toBe('process-file');
      expect(jobData).toMatchObject({
        driveId: 'drive-abc',
        itemId: 'item-xyz',
        resourceUrl: 'drives/drive-abc/items/item-xyz',
        changeType: 'updated',
      });
      expect(typeof jobData.receivedAt).toBe('string');
    });

    it('enqueues one job per notification in a batch', async () => {
      const queue = createFakeQueue();
      const app = createReceiverApp({ queue });

      const res = await request(app)
        .post('/webhook')
        .send({
          value: [
            { resource: 'drives/d1/items/i1', resourceData: { id: 'i1' }, changeType: 'created' },
            { resource: 'drives/d2/items/i2', resourceData: { id: 'i2' }, changeType: 'updated' },
          ],
        });

      expect(res.status).toBe(202);

      await vi.waitFor(() => {
        expect(queue.add).toHaveBeenCalledTimes(2);
      });
    });

    it('returns 202 but does not enqueue when resource shape cannot be parsed', async () => {
      const queue = createFakeQueue();
      const app = createReceiverApp({ queue });

      const res = await request(app)
        .post('/webhook')
        .send({ value: [{ resource: 'something/unexpected', resourceData: {} }] });

      expect(res.status).toBe(202);
      // Give any async handling a chance to run before asserting nothing happened.
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('returns 202 for an empty batch', async () => {
      const queue = createFakeQueue();
      const app = createReceiverApp({ queue });

      const res = await request(app).post('/webhook').send({ value: [] });

      expect(res.status).toBe(202);
      expect(queue.add).not.toHaveBeenCalled();
    });
  });
});
