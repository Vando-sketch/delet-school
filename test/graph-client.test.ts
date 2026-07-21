import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MicrosoftGraphClient } from '../src/graph/client.js';

const BASE_URL = 'https://graph.example.test/v1.0';
const FAKE_TOKEN = 'fake-access-token';

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('MicrosoftGraphClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let getAccessToken: ReturnType<typeof vi.fn>;
  let client: MicrosoftGraphClient;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    getAccessToken = vi.fn().mockResolvedValue(FAKE_TOKEN);
    client = new MicrosoftGraphClient({ getAccessToken, baseUrl: BASE_URL });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('downloadDriveItem', () => {
    it('fetches metadata and content from the right URLs and returns a DownloadedFile', async () => {
      const driveId = 'drive-1';
      const itemId = 'item-1';

      fetchMock.mockImplementation(async (url: string) => {
        if (url === `${BASE_URL}/drives/${driveId}/items/${itemId}`) {
          return jsonResponse({ name: 'report.pdf', file: { mimeType: 'application/pdf' } });
        }
        if (url === `${BASE_URL}/drives/${driveId}/items/${itemId}/content`) {
          return new Response(new TextEncoder().encode('file-bytes'), {
            status: 200,
            headers: { 'content-type': 'application/pdf' },
          });
        }
        throw new Error(`Unexpected URL: ${url}`);
      });

      const result = await client.downloadDriveItem(driveId, itemId);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock).toHaveBeenCalledWith(
        `${BASE_URL}/drives/${driveId}/items/${itemId}`,
        expect.objectContaining({ headers: { Authorization: `Bearer ${FAKE_TOKEN}` } }),
      );
      expect(fetchMock).toHaveBeenCalledWith(
        `${BASE_URL}/drives/${driveId}/items/${itemId}/content`,
        expect.objectContaining({ headers: { Authorization: `Bearer ${FAKE_TOKEN}` } }),
      );

      expect(result.fileName).toBe('report.pdf');
      expect(result.mimeType).toBe('application/pdf');
      expect(result.content).toBeInstanceOf(Buffer);
      expect(result.content.toString('utf-8')).toBe('file-bytes');
    });

    it('throws an error containing the status code when the metadata request fails', async () => {
      fetchMock.mockResolvedValue(new Response('not found', { status: 404, statusText: 'Not Found' }));

      await expect(client.downloadDriveItem('drive-1', 'item-1')).rejects.toThrow(/404/);
    });
  });

  describe('createSubscription', () => {
    it('posts the right body to /subscriptions and returns id + expirationDateTime', async () => {
      const input = {
        resource: 'drives/drive-1/root',
        changeType: 'updated',
        notificationUrl: 'https://example.com/webhook',
        expirationDateTime: '2026-08-01T00:00:00.000Z',
        clientState: 'secret-state',
      };

      fetchMock.mockResolvedValue(
        jsonResponse({ id: 'sub-123', expirationDateTime: input.expirationDateTime }),
      );

      const result = await client.createSubscription(input);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(`${BASE_URL}/subscriptions`);
      expect(requestInit.method).toBe('POST');
      expect(JSON.parse(requestInit.body as string)).toEqual({
        changeType: input.changeType,
        notificationUrl: input.notificationUrl,
        resource: input.resource,
        expirationDateTime: input.expirationDateTime,
        clientState: input.clientState,
      });

      expect(result).toEqual({ id: 'sub-123', expirationDateTime: input.expirationDateTime });
    });

    it('throws an error containing the status code and body on a non-2xx response', async () => {
      fetchMock.mockResolvedValue(
        new Response('invalid resource', { status: 400, statusText: 'Bad Request' }),
      );

      await expect(
        client.createSubscription({
          resource: 'bad',
          changeType: 'updated',
          notificationUrl: 'https://example.com/webhook',
          expirationDateTime: '2026-08-01T00:00:00.000Z',
        }),
      ).rejects.toThrow(/400/);
    });
  });

  describe('renewSubscription', () => {
    it('patches the right URL with the new expirationDateTime', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ id: 'sub-123', expirationDateTime: '2026-08-03T00:00:00.000Z' }));

      await client.renewSubscription('sub-123', '2026-08-03T00:00:00.000Z');

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(`${BASE_URL}/subscriptions/sub-123`);
      expect(requestInit.method).toBe('PATCH');
      expect(JSON.parse(requestInit.body as string)).toEqual({
        expirationDateTime: '2026-08-03T00:00:00.000Z',
      });
    });

    it('throws an error containing the status code on a non-2xx response', async () => {
      fetchMock.mockResolvedValue(
        new Response('subscription not found', { status: 404, statusText: 'Not Found' }),
      );

      await expect(client.renewSubscription('missing-sub', '2026-08-03T00:00:00.000Z')).rejects.toThrow(/404/);
    });
  });
});
