import { createServer, type Server } from 'node:http';
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { exec } from 'node:child_process';
import { platform } from 'node:os';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { auth } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientMetadata, OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { OAuthConfig } from './types.js';

// --- Credential storage ---

interface ServerCredentials {
  clientInfo?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
  callbackPort?: number;
}

type CredentialStore = Record<string, ServerCredentials>;

function getCredentialsPath(): string {
  return join(homedir(), '.mcpkit', 'credentials.json');
}

async function loadCredentials(): Promise<CredentialStore> {
  try {
    const content = await readFile(getCredentialsPath(), 'utf-8');
    return JSON.parse(content) as CredentialStore;
  } catch {
    return {};
  }
}

async function saveCredentials(store: CredentialStore): Promise<void> {
  const filePath = getCredentialsPath();
  await mkdir(join(homedir(), '.mcpkit'), { recursive: true });
  await writeFile(filePath, JSON.stringify(store, null, 2), 'utf-8');
  await chmod(filePath, 0o600);
}

export async function clearCredentials(serverUrl: string): Promise<void> {
  const store = await loadCredentials();
  delete store[serverUrl];
  await saveCredentials(store);
}

export async function hasValidTokens(serverUrl: string): Promise<boolean> {
  const store = await loadCredentials();
  return !!store[serverUrl]?.tokens?.access_token;
}

// --- Browser launch ---

function openBrowser(url: string): void {
  const cmd = platform() === 'darwin'
    ? `open "${url}"`
    : platform() === 'win32'
      ? `start "" "${url}"`
      : `xdg-open "${url}"`;
  exec(cmd);
}

// --- Callback server ---

interface CallbackResult {
  code: string;
}

function startCallbackServer(port: number): { server: Server; codePromise: Promise<CallbackResult> } {
  let resolveCode: (result: CallbackResult) => void;
  let rejectCode: (err: Error) => void;

  const codePromise = new Promise<CallbackResult>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const server = createServer((req, res) => {
    const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);

    if (url.pathname !== '/callback') {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');

    if (error) {
      const desc = url.searchParams.get('error_description') || error;
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<html><body><h2>Authorization Failed</h2><p>${desc}</p><p>You can close this tab.</p></body></html>`);
      resolveCode = undefined as any;
      rejectCode(new Error(`OAuth error: ${desc}`));
      return;
    }

    if (!code) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end('<html><body><h2>Missing Code</h2><p>No authorization code received.</p></body></html>');
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><body><h2>Authorization Successful</h2><p>You can close this tab and return to your terminal.</p></body></html>');
    resolveCode({ code });
  });

  server.listen(port, '127.0.0.1');

  // Timeout after 120 seconds
  const timeout = setTimeout(() => {
    rejectCode(new Error('OAuth callback timed out after 120 seconds'));
    server.close();
  }, 120_000);

  // Clean up timeout when code is received
  codePromise.finally(() => {
    clearTimeout(timeout);
    server.close();
  });

  return { server, codePromise };
}

// --- Find available port ---

async function findAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        const port = addr.port;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error('Failed to find available port')));
      }
    });
    server.on('error', reject);
  });
}

async function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve(true));
    });
    server.on('error', () => resolve(false));
  });
}

// --- OAuth Provider ---

export class McpkitOAuthProvider implements OAuthClientProvider {
  private serverUrl: string;
  private port: number;
  private store: CredentialStore;
  private credentials: ServerCredentials;
  private oauthConfig?: OAuthConfig;
  private _codePromise?: Promise<CallbackResult>;

  constructor(serverUrl: string, port: number, store: CredentialStore, oauthConfig?: OAuthConfig) {
    this.serverUrl = serverUrl;
    this.port = port;
    this.store = store;
    this.oauthConfig = oauthConfig;
    this.credentials = store[serverUrl] || {};
  }

  get redirectUrl(): URL {
    return new URL(`http://localhost:${this.port}/callback`);
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [this.redirectUrl],
      token_endpoint_auth_method: this.oauthConfig?.clientSecret ? 'client_secret_post' : 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      client_name: 'mcpkit',
    };
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    if (this.credentials.clientInfo) {
      return this.credentials.clientInfo;
    }
    // Return pre-configured client ID to skip dynamic client registration
    if (this.oauthConfig?.clientId) {
      return {
        client_id: this.oauthConfig.clientId,
        ...(this.oauthConfig.clientSecret ? { client_secret: this.oauthConfig.clientSecret } : {}),
      } as OAuthClientInformationMixed;
    }
    return undefined;
  }

  async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
    this.credentials.clientInfo = info;
    this.credentials.callbackPort = this.port;
    this.store[this.serverUrl] = this.credentials;
    await saveCredentials(this.store);
  }

  tokens(): OAuthTokens | undefined {
    return this.credentials.tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    this.credentials.tokens = tokens;
    this.store[this.serverUrl] = this.credentials;
    await saveCredentials(this.store);
  }

  codeVerifier(): string {
    return this.credentials.codeVerifier || '';
  }

  async saveCodeVerifier(verifier: string): Promise<void> {
    this.credentials.codeVerifier = verifier;
    this.store[this.serverUrl] = this.credentials;
    await saveCredentials(this.store);
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    const { server: _server, codePromise } = startCallbackServer(this.port);
    this._codePromise = codePromise;
    openBrowser(authorizationUrl.toString());
  }

  async waitForAuthorizationCode(): Promise<string> {
    if (!this._codePromise) {
      throw new Error('No authorization flow in progress. Call redirectToAuthorization first.');
    }
    const result = await this._codePromise;
    this._codePromise = undefined;
    return result.code;
  }

  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier'): Promise<void> {
    switch (scope) {
      case 'all':
        this.credentials = {};
        break;
      case 'client':
        delete this.credentials.clientInfo;
        break;
      case 'tokens':
        delete this.credentials.tokens;
        break;
      case 'verifier':
        delete this.credentials.codeVerifier;
        break;
    }
    this.store[this.serverUrl] = this.credentials;
    await saveCredentials(this.store);
  }
}

// --- High-level helpers ---

export async function createOAuthProvider(serverUrl: string, oauthConfig?: OAuthConfig): Promise<McpkitOAuthProvider> {
  const store = await loadCredentials();
  // Reuse the port from a previous registration if available, so the redirect_uri
  // matches what was registered with the OAuth server during dynamic client registration.
  let port = oauthConfig?.callbackPort;
  if (!port) {
    const existingPort = store[serverUrl]?.callbackPort;
    if (existingPort && await isPortAvailable(existingPort)) {
      port = existingPort;
    } else {
      // Port unavailable or no previous port — pick a new one and clear stale client registration
      if (existingPort) {
        delete store[serverUrl]?.clientInfo;
        delete store[serverUrl]?.callbackPort;
        await saveCredentials(store);
      }
      port = await findAvailablePort();
    }
  }
  return new McpkitOAuthProvider(serverUrl, port, store, oauthConfig);
}

export async function authenticateIfNeeded(serverUrl: string, oauthConfig?: OAuthConfig): Promise<McpkitOAuthProvider> {
  const provider = await createOAuthProvider(serverUrl, oauthConfig);

  const result = await auth(provider, { serverUrl });

  if (result === 'AUTHORIZED') {
    return provider;
  }

  // result === 'REDIRECT' — browser was opened, wait for callback
  const code = await provider.waitForAuthorizationCode();
  const finalResult = await auth(provider, { serverUrl, authorizationCode: code });

  if (finalResult !== 'AUTHORIZED') {
    throw new Error('OAuth authorization failed after receiving callback code');
  }

  return provider;
}
