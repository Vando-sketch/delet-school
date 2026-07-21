import pino from 'pino';
import { config } from '../config/index.js';
import type { DownloadedFile, GraphClient } from '../types.js';
import { getGraphAccessToken } from './authClient.js';

const GRAPH_BASE_URL = 'https://graph.microsoft.com/v1.0';

const logger = pino({ name: 'graph-client' });

export type AccessTokenProvider = () => Promise<string>;

export interface GraphClientOptions {
  /** Injected for testability; defaults to the real MSAL-backed token acquisition. */
  getAccessToken?: AccessTokenProvider;
  /** Injected for testability; defaults to the real Microsoft Graph v1.0 endpoint. */
  baseUrl?: string;
}

interface DriveItemMetadata {
  name?: string;
  file?: {
    mimeType?: string;
  };
}

/**
 * Reads and consumes the response body as text, tolerating bodies that have already
 * been consumed or that fail to read (network errors mid-stream, etc).
 */
async function safeReadBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '<unreadable response body>';
  }
}

async function assertOk(response: Response, context: string): Promise<void> {
  if (response.ok) {
    return;
  }
  const body = await safeReadBody(response);
  logger.error({ context, status: response.status, body }, 'Microsoft Graph request failed');
  throw new Error(
    `Microsoft Graph request failed (${context}): HTTP ${response.status} ${response.statusText} - ${body}`,
  );
}

export class MicrosoftGraphClient implements GraphClient {
  private readonly getAccessToken: AccessTokenProvider;
  private readonly baseUrl: string;

  constructor(options: GraphClientOptions = {}) {
    this.getAccessToken = options.getAccessToken ?? getGraphAccessToken;
    this.baseUrl = options.baseUrl ?? GRAPH_BASE_URL;
  }

  private async authHeaders(): Promise<Record<string, string>> {
    const token = await this.getAccessToken();
    return { Authorization: `Bearer ${token}` };
  }

  async downloadDriveItem(driveId: string, itemId: string): Promise<DownloadedFile> {
    const authHeaders = await this.authHeaders();

    // We fetch metadata separately (rather than relying on the download response's
    // Content-Disposition/Content-Type headers) because the /content endpoint redirects
    // to a pre-authenticated download URL whose headers are not guaranteed by Graph to
    // carry a reliable filename/mime type — the metadata endpoint is the documented,
    // stable source for both.
    const metadataUrl = `${this.baseUrl}/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}`;
    logger.info({ driveId, itemId, url: metadataUrl }, 'Fetching drive item metadata');
    const metadataResponse = await fetch(metadataUrl, { headers: authHeaders });
    await assertOk(metadataResponse, 'downloadDriveItem:metadata');
    const metadata = (await metadataResponse.json()) as DriveItemMetadata;

    const contentUrl = `${this.baseUrl}/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}/content`;
    logger.info({ driveId, itemId, url: contentUrl }, 'Downloading drive item content');
    // fetch follows redirects by default, so the redirect to the pre-authenticated
    // download URL is transparent here.
    const contentResponse = await fetch(contentUrl, { headers: authHeaders });
    await assertOk(contentResponse, 'downloadDriveItem:content');
    const arrayBuffer = await contentResponse.arrayBuffer();

    return {
      fileName: metadata.name ?? itemId,
      mimeType: metadata.file?.mimeType ?? contentResponse.headers.get('content-type') ?? 'application/octet-stream',
      content: Buffer.from(arrayBuffer),
    };
  }

  async createSubscription(input: {
    resource: string;
    changeType: string;
    notificationUrl: string;
    expirationDateTime: string;
    clientState?: string;
  }): Promise<{ id: string; expirationDateTime: string }> {
    const authHeaders = await this.authHeaders();
    const url = `${this.baseUrl}/subscriptions`;

    const body = {
      changeType: input.changeType,
      notificationUrl: input.notificationUrl,
      resource: input.resource,
      expirationDateTime: input.expirationDateTime,
      clientState: input.clientState ?? config.graph.webhookClientState,
    };

    logger.info({ url, resource: input.resource, changeType: input.changeType }, 'Creating Graph subscription');
    const response = await fetch(url, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    await assertOk(response, 'createSubscription');
    const created = (await response.json()) as { id: string; expirationDateTime: string };

    return { id: created.id, expirationDateTime: created.expirationDateTime };
  }

  async renewSubscription(subscriptionId: string, expirationDateTime: string): Promise<void> {
    const authHeaders = await this.authHeaders();
    const url = `${this.baseUrl}/subscriptions/${encodeURIComponent(subscriptionId)}`;

    logger.info({ url, subscriptionId, expirationDateTime }, 'Renewing Graph subscription');
    const response = await fetch(url, {
      method: 'PATCH',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expirationDateTime }),
    });
    await assertOk(response, 'renewSubscription');
  }
}

export function createGraphClient(options?: GraphClientOptions): GraphClient {
  return new MicrosoftGraphClient(options);
}
