import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { platform } from 'node:os';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { auth } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientMetadata, OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { readStateFile, stateFileError, withFileLock, writeFileAtomic } from './atomic-file.js';
import type { OAuthConfig } from './types.js';
import { redirectSafeFetch } from './client.js';
import { OAuthRequiredError } from './oauth-required-error.js';

// --- Credential storage ---

interface ServerCredentials {
  clientInfo?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
  callbackPort?: number;
  tokenIssuedAt?: number;
}

type CredentialStore = Record<string, ServerCredentials>;

function getCredentialsPath(): string {
  return join(homedir(), '.mcpkit', 'credentials.json');
}

/**
 * The stored credentials. A missing or blank file is an empty store; a file that cannot be read
 * or parsed throws an error naming it, because every credentials write reads the store first and
 * would otherwise save an empty one over all the tokens in the damaged file.
 */
async function loadCredentials(): Promise<CredentialStore> {
  const credentialsPath = getCredentialsPath();
  const content = await readStateFile(credentialsPath);
  if (content === undefined) return {};

  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch (err) {
    throw stateFileError(credentialsPath, `invalid JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw stateFileError(credentialsPath, 'not a JSON object');
  }
  return data as CredentialStore;
}

/**
 * Persist the credentials of ONE server: lock, re-read the file, replace only
 * that server's key (or drop it when `credentials` is undefined), write
 * atomically with mode 0600. A process holding a stale snapshot of the whole
 * store can therefore never overwrite another server's tokens written by a
 * parallel process.
 */
async function updateServerCredentials(
  serverUrl: string,
  credentials: ServerCredentials | undefined,
): Promise<void> {
  const filePath = getCredentialsPath();
  await withFileLock(`${filePath}.lock`, async () => {
    const store = await loadCredentials();
    if (credentials) {
      store[serverUrl] = credentials;
    } else {
      delete store[serverUrl];
    }
    await writeFileAtomic(filePath, JSON.stringify(store, null, 2), { mode: 0o600 });
  });
}

export async function clearCredentials(serverUrl: string): Promise<void> {
  await updateServerCredentials(serverUrl, undefined);
}

export async function hasValidTokens(serverUrl: string): Promise<boolean> {
  const store = await loadCredentials();
  const creds = store[serverUrl];
  if (!creds?.tokens?.access_token) return false;
  return !isTokenExpired(creds);
}

const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000; // 5 minutes

function isTokenExpired(creds: ServerCredentials): boolean {
  // If we don't have expiry info (legacy tokens saved before tokenIssuedAt was tracked),
  // assume valid and let the server reject if expired — avoids forcing re-auth
  if (!creds.tokenIssuedAt || !creds.tokens?.expires_in) return false;
  const expiresAt = creds.tokenIssuedAt + creds.tokens.expires_in * 1000;
  return Date.now() >= expiresAt - TOKEN_EXPIRY_BUFFER_MS;
}

// --- Browser launch ---

/** Opens an authorization URL for the user. Injected by tests so that none of them can launch a browser. */
export type BrowserOpener = (url: string) => void;

/**
 * Opens the URL in the system browser. The URL comes from the server's OAuth metadata, so it is passed
 * as one argument and never through a shell, where `$(...)` in it would run. A missing opener is not an
 * error here: the sign-in then ends with the callback timeout and its message.
 */
const openBrowser: BrowserOpener = (url) => {
  const [command, args] = platform() === 'darwin'
    ? ['open', [url]]
    : platform() === 'win32'
      ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : ['xdg-open', [url]];
  execFile(command, args, () => {});
};

// --- Callback server ---

interface CallbackResult {
  code: string;
}

/** A listener for the browser's redirect back to mcpkit, and the code it will deliver. */
interface CallbackFlow {
  /**
   * The authorization code, or the reason there will be none (timeout, `cancel`, an `error` redirect).
   * Awaiting callers see the rejection; nobody else is made to handle it.
   */
  codePromise: Promise<CallbackResult>;
  /** Ends the flow now: the port is released and `codePromise` rejects with `reason`. Does nothing once the flow has ended. */
  cancel(reason: Error): void;
}

const DEFAULT_CALLBACK_TIMEOUT_MS = 120_000;

/**
 * How long to wait for the browser. `MCPKIT_OAUTH_TIMEOUT_MS` shortens it so that tests of the
 * timeout path do not take two minutes; it is not a user setting.
 */
function resolveCallbackTimeoutMs(override?: number): number {
  if (override !== undefined) return override;
  const fromEnv = Number(process.env.MCPKIT_OAUTH_TIMEOUT_MS);
  return Number.isInteger(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_CALLBACK_TIMEOUT_MS;
}

function describeWait(timeoutMs: number): string {
  if (timeoutMs % 1000 !== 0) return `${timeoutMs} ms`;
  const seconds = timeoutMs / 1000;
  return `${seconds} ${seconds === 1 ? 'second' : 'seconds'}`;
}

/**
 * Listen on 127.0.0.1:`port` for the OAuth redirect. Resolves once the port is bound, so a busy port
 * is an error before any browser opens. From then on the flow ends exactly once, through `finish`:
 * a code, an `error` redirect, the timeout or `cancel`. Every end clears the timer and closes the
 * server, and the rejecting ends cannot become an unhandled rejection.
 */
function startCallbackServer(port: number, timeoutMs: number): Promise<CallbackFlow> {
  return new Promise<CallbackFlow>((resolveStart, rejectStart) => {
    let resolveCode!: (result: CallbackResult) => void;
    let rejectCode!: (err: Error) => void;
    const codePromise = new Promise<CallbackResult>((resolve, reject) => {
      resolveCode = resolve;
      rejectCode = reject;
    });
    // The flow can end with nobody awaiting it (the SDK gave up, or a newer attempt replaced it).
    // This handler is what keeps that rejection from killing the process; callers awaiting
    // `codePromise` still receive it.
    codePromise.catch(() => {});

    let ended = false;
    let timer: NodeJS.Timeout | undefined;
    let listening = false;

    // `dropConnections`: nobody is coming back, so a connection the browser still holds open must not keep
    // the port. A flow that ends with a page being served closes gracefully and lets that page finish.
    const finish = (outcome: CallbackResult | Error, dropConnections = false): void => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      server.close();
      if (dropConnections) server.closeAllConnections();
      if (outcome instanceof Error) {
        rejectCode(outcome);
      } else {
        resolveCode(outcome);
      }
    };

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
        finish(new Error(`OAuth error: ${desc}`));
        return;
      }

      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end('<html><body><h2>Missing Code</h2><p>No authorization code received.</p></body></html>');
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body><h2>Authorization Successful</h2><p>You can close this tab and return to your terminal.</p></body></html>');
      finish({ code });
    });

    server.on('error', (err: NodeJS.ErrnoException) => {
      const reason = new Error(
        `Could not listen for the OAuth callback on 127.0.0.1:${port} (${err.code ?? err.message}). Try again with \`mcpkit auth <server>\`.`,
      );
      if (listening) {
        finish(reason, true);
      } else {
        rejectStart(reason);
      }
    });

    server.listen(port, '127.0.0.1', () => {
      listening = true;
      timer = setTimeout(() => {
        finish(new Error(`OAuth callback timed out after ${describeWait(timeoutMs)}. Try again with \`mcpkit auth <server>\`.`), true);
      }, timeoutMs);
      resolveStart({ codePromise, cancel: (reason) => finish(reason, true) });
    });
  });
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

/** What an interactive sign-in needs besides the server: how to open the browser and how long to wait for it. */
export interface InteractiveAuthOptions {
  /** Defaults to the system browser. Tests pass a recorder. */
  openBrowser?: BrowserOpener;
  /** Defaults to 120 s. */
  callbackTimeoutMs?: number;
}

export interface McpkitOAuthProviderOptions extends InteractiveAuthOptions {
  /**
   * The registry name of the server. When set, the provider is non-interactive: it only uses and
   * refreshes tokens that are already stored, and never registers a client, starts an authorization,
   * opens a browser or listens on a port. Those steps throw an OAuthRequiredError for this server.
   */
  nonInteractiveFor?: string;
}

export class McpkitOAuthProvider implements OAuthClientProvider {
  private serverUrl: string;
  private port: number;
  private store: CredentialStore;
  private credentials: ServerCredentials;
  private oauthConfig?: OAuthConfig;
  private nonInteractiveFor?: string;
  private openBrowser: BrowserOpener;
  private callbackTimeoutMs?: number;
  private pendingFlow?: CallbackFlow;

  constructor(
    serverUrl: string,
    port: number,
    store: CredentialStore,
    oauthConfig?: OAuthConfig,
    options: McpkitOAuthProviderOptions = {},
  ) {
    this.serverUrl = serverUrl;
    this.port = port;
    this.store = store;
    this.oauthConfig = oauthConfig;
    this.nonInteractiveFor = options.nonInteractiveFor;
    this.openBrowser = options.openBrowser ?? openBrowser;
    this.callbackTimeoutMs = options.callbackTimeoutMs;
    this.credentials = store[serverUrl] || {};
  }

  private assertInteractive(): void {
    if (this.nonInteractiveFor !== undefined) throw new OAuthRequiredError(this.nonInteractiveFor);
  }

  get redirectUrl(): URL {
    return new URL(`http://localhost:${this.port}/callback`);
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [this.redirectUrl.toString()],
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
    // Nothing stored: the SDK would register a client now, with a request to the server, before
    // `saveClientInformation` could refuse it. A non-interactive provider refuses here instead.
    this.assertInteractive();
    return undefined;
  }

  async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
    this.assertInteractive();
    this.credentials.clientInfo = info;
    this.credentials.callbackPort = this.port;
    this.store[this.serverUrl] = this.credentials;
    await updateServerCredentials(this.serverUrl, this.credentials);
  }

  tokens(): OAuthTokens | undefined {
    return this.credentials.tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    this.credentials.tokens = tokens;
    this.credentials.tokenIssuedAt = Date.now();
    this.store[this.serverUrl] = this.credentials;
    await updateServerCredentials(this.serverUrl, this.credentials);
  }

  hasValidTokens(): boolean {
    if (!this.credentials.tokens?.access_token) return false;
    return !isTokenExpired(this.credentials);
  }

  codeVerifier(): string {
    return this.credentials.codeVerifier || '';
  }

  async saveCodeVerifier(verifier: string): Promise<void> {
    this.assertInteractive();
    this.credentials.codeVerifier = verifier;
    this.store[this.serverUrl] = this.credentials;
    await updateServerCredentials(this.serverUrl, this.credentials);
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    this.assertInteractive();
    // An earlier attempt that nobody waited for would otherwise keep its port and timer.
    this.pendingFlow?.cancel(new Error('OAuth sign-in was replaced by a newer attempt.'));
    // Listen first, open the browser second: a busy callback port is reported here, with its reason,
    // instead of leaving the user on a consent page whose redirect goes nowhere.
    this.pendingFlow = await startCallbackServer(this.port, resolveCallbackTimeoutMs(this.callbackTimeoutMs));
    this.openBrowser(authorizationUrl.toString());
  }

  async waitForAuthorizationCode(): Promise<string> {
    const flow = this.pendingFlow;
    if (!flow) {
      throw new Error('No authorization flow in progress. Call redirectToAuthorization first.');
    }
    try {
      return (await flow.codePromise).code;
    } finally {
      if (this.pendingFlow === flow) this.pendingFlow = undefined;
    }
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
        delete this.credentials.tokenIssuedAt;
        break;
      case 'verifier':
        delete this.credentials.codeVerifier;
        break;
    }
    this.store[this.serverUrl] = this.credentials;
    await updateServerCredentials(this.serverUrl, this.credentials);
  }
}

// --- High-level helpers ---

export async function createOAuthProvider(
  serverUrl: string,
  oauthConfig?: OAuthConfig,
  interactive: InteractiveAuthOptions = {},
): Promise<McpkitOAuthProvider> {
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
        await updateServerCredentials(serverUrl, store[serverUrl]);
      }
      port = await findAvailablePort();
    }
  }
  return new McpkitOAuthProvider(serverUrl, port, store, oauthConfig, interactive);
}

/**
 * A provider for callers that must never start an authorization (batch commands, auto-refresh,
 * `exec`, the runtime): it reuses the stored callback port without probing it and writes nothing
 * when it is built, so a busy port cannot cost the user a stored client registration. Only
 * already-stored tokens work; anything that would need a browser throws an OAuthRequiredError
 * for `serverName`.
 */
export async function createStoredOAuthProvider(
  serverUrl: string,
  oauthConfig: OAuthConfig | undefined,
  serverName: string,
): Promise<McpkitOAuthProvider> {
  const store = await loadCredentials();
  // The redirect URL is only used to register a client or start an authorization, both
  // blocked here, so a missing stored port needs no real one.
  const port = oauthConfig?.callbackPort ?? store[serverUrl]?.callbackPort ?? 0;
  return new McpkitOAuthProvider(serverUrl, port, store, oauthConfig, { nonInteractiveFor: serverName });
}

/**
 * The interactive sign-in: reuses valid stored tokens, otherwise runs the full flow, which opens the
 * browser and waits for the callback. Only commands the user pointed at one server (`auth`, `install`,
 * `call`, and `update`/`list`/`sync` with a name) call this; everything else uses a stored-credentials
 * provider (see `createStoredOAuthProvider`).
 */
export async function authenticateIfNeeded(
  serverUrl: string,
  oauthConfig?: OAuthConfig,
  interactive: InteractiveAuthOptions = {},
): Promise<McpkitOAuthProvider> {
  const provider = await createOAuthProvider(serverUrl, oauthConfig, interactive);

  // Skip the full OAuth dance if the access token is still valid
  if (provider.hasValidTokens()) {
    return provider;
  }

  // Pass redirectSafeFetch to the SDK's auth() so that metadata discovery and
  // token endpoint requests preserve POST method on 301/302 redirects.
  const result = await auth(provider, { serverUrl, fetchFn: redirectSafeFetch });

  if (result === 'AUTHORIZED') {
    return provider;
  }

  // result === 'REDIRECT' — browser was opened, wait for callback
  const code = await provider.waitForAuthorizationCode();
  const finalResult = await auth(provider, { serverUrl, authorizationCode: code, fetchFn: redirectSafeFetch });

  if (finalResult !== 'AUTHORIZED') {
    throw new Error('OAuth authorization failed after receiving callback code. Try `mcpkit auth <server> --reset` to clear tokens and retry.');
  }

  return provider;
}
