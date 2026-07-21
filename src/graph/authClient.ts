import { ConfidentialClientApplication } from '@azure/msal-node';
import { config } from '../config/index.js';

const GRAPH_DEFAULT_SCOPE = ['https://graph.microsoft.com/.default'];

let msalApp: ConfidentialClientApplication | undefined;

function getMsalApp(): ConfidentialClientApplication {
  msalApp ??= new ConfidentialClientApplication({
    auth: {
      clientId: config.graph.clientId(),
      authority: `https://login.microsoftonline.com/${config.graph.tenantId()}`,
      clientSecret: config.graph.clientSecret(),
    },
  });
  return msalApp;
}

/**
 * Acquires an OAuth2 access token for Microsoft Graph via the client-credentials flow.
 *
 * msal-node's ConfidentialClientApplication maintains its own in-memory token cache and
 * transparently reuses/refreshes tokens for `acquireTokenByClientCredential`, so no custom
 * caching is implemented here — every call is safe to make on the hot path.
 */
export async function getGraphAccessToken(): Promise<string> {
  const app = getMsalApp();
  const result = await app.acquireTokenByClientCredential({
    scopes: GRAPH_DEFAULT_SCOPE,
  });

  if (!result?.accessToken) {
    throw new Error('Failed to acquire Microsoft Graph access token: MSAL returned no token');
  }

  return result.accessToken;
}
