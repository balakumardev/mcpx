import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock, MockInstance } from 'vitest';
import net, { connect, createServer, type Server } from 'node:net';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { authenticateIfNeeded, McpkitOAuthProvider } from './auth.js';
import { discoverForEntry, resolveAuthProvider } from './discover.js';
import { OAuthRequiredError } from './oauth-required-error.js';
import { startFakeOAuthServer, type FakeOAuthServer } from './oauth-test-server.js';
import type { ServerEntry } from './types.js';
import { execFile } from 'node:child_process';

/**
 * Who may open a browser. Nothing here can: the system opener (`execFile`) is replaced by a recorder
 * for the whole file, every interactive case injects its own opener, and every listener is on port 0
 * or on a port the OS just handed out. The "server" is a fake OAuth-protected MCP server on 127.0.0.1.
 */
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFile: vi.fn(),
}));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A port nobody listens on right now (OS-chosen, released again). */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** Whether something accepts connections on the port. */
function accepts(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: '127.0.0.1' });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
}

function callbackPortOf(authorizationUrl: string): number {
  const redirect = new URL(new URL(authorizationUrl).searchParams.get('redirect_uri') as string);
  return Number(redirect.port);
}

describe('interactive sign-in ends cleanly', () => {
  let fake: FakeOAuthServer;
  let unhandled: Mock;
  let uncaught: Mock;
  const blockers: Server[] = [];

  beforeEach(async () => {
    fake = await startFakeOAuthServer();
    unhandled = vi.fn();
    uncaught = vi.fn();
    process.on('unhandledRejection', unhandled);
    process.on('uncaughtException', uncaught);
  });

  afterEach(async () => {
    process.off('unhandledRejection', unhandled);
    process.off('uncaughtException', uncaught);
    await fake.close();
    for (const server of blockers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
    vi.mocked(execFile).mockClear();
  });

  /** An authorization the caller has been sent to the fake server's /authorize for, with its provider. */
  async function startedProvider(timeoutMs: number): Promise<{ provider: McpkitOAuthProvider; port: number; opened: string[] }> {
    const port = await freePort();
    const opened: string[] = [];
    const provider = new McpkitOAuthProvider(fake.url, port, {}, undefined, {
      openBrowser: (url) => opened.push(url),
      callbackTimeoutMs: timeoutMs,
    });
    await provider.redirectToAuthorization(new URL(`${fake.origin}/authorize?redirect_uri=${encodeURIComponent(`http://localhost:${port}/callback`)}`));
    return { provider, port, opened };
  }

  it('times out without crashing: the caller gets the message, nothing is left unhandled, the port is released', async () => {
    const opened: string[] = [];

    const failure = await authenticateIfNeeded(fake.url, undefined, { openBrowser: (url) => opened.push(url), callbackTimeoutMs: 60 })
      .then(() => undefined, (err: unknown) => err);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe('OAuth callback timed out after 60 ms. Try again with `mcpkit auth <server>`.');
    // A rejection nobody observed is reported on a later turn of the event loop.
    await sleep(150);
    expect(unhandled).not.toHaveBeenCalled();
    expect(uncaught).not.toHaveBeenCalled();
    expect(opened).toHaveLength(1);
    expect(new URL(opened[0]).origin).toBe(fake.origin);
    expect(new URL(opened[0]).pathname).toBe('/authorize');
    expect(await accepts(callbackPortOf(opened[0]))).toBe(false);
  });

  it('words a whole number of seconds as seconds', async () => {
    vi.stubEnv('MCPKIT_OAUTH_TIMEOUT_MS', '1000');
    try {
      const failure = await authenticateIfNeeded(fake.url, undefined, { openBrowser: () => undefined })
        .then(() => undefined, (err: unknown) => err);
      expect((failure as Error).message).toBe('OAuth callback timed out after 1 second. Try again with `mcpkit auth <server>`.');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('takes the wait from MCPKIT_OAUTH_TIMEOUT_MS', async () => {
    vi.stubEnv('MCPKIT_OAUTH_TIMEOUT_MS', '80');
    try {
      const failure = await authenticateIfNeeded(fake.url, undefined, { openBrowser: () => undefined })
        .then(() => undefined, (err: unknown) => err);
      expect((failure as Error).message).toContain('timed out after 80 ms');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('delivers the code the browser brings back, and releases the port', async () => {
    const { provider, port } = await startedProvider(5000);
    const waiting = provider.waitForAuthorizationCode();

    const response = await fetch(`http://127.0.0.1:${port}/callback?code=the-code`);

    expect(response.status).toBe(200);
    expect(await waiting).toBe('the-code');
    await sleep(50);
    expect(await accepts(port)).toBe(false);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it('fails with the provider message when the browser comes back with an error, and releases the port', async () => {
    const { provider, port } = await startedProvider(5000);
    const waiting = provider.waitForAuthorizationCode();
    const settled = waiting.then(() => undefined, (err: Error) => err);

    const response = await fetch(`http://127.0.0.1:${port}/callback?error=access_denied&error_description=${encodeURIComponent('user said no')}`);
    expect(await response.text()).toContain('Authorization Failed');

    expect((await settled)?.message).toBe('OAuth error: user said no');
    await sleep(50);
    expect(await accepts(port)).toBe(false);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it('never leaves a rejection unhandled when nobody waits for the code', async () => {
    const { port } = await startedProvider(40);

    await sleep(150);

    expect(unhandled).not.toHaveBeenCalled();
    expect(await accepts(port)).toBe(false);
  });

  it('a newer attempt replaces the earlier one: its waiter fails at once and its port is released', async () => {
    const first = await startedProvider(100);
    const waiting = first.provider.waitForAuthorizationCode().then(() => undefined, (err: Error) => err);

    // Same provider, second redirect: the first flow must be cancelled, not leaked.
    await first.provider.redirectToAuthorization(new URL(`${fake.origin}/authorize`));

    expect((await waiting)?.message).toBe('OAuth sign-in was replaced by a newer attempt.');
    // The replacement listens on the same port the first one just released.
    expect(await accepts(first.port)).toBe(true);
    await expect(first.provider.waitForAuthorizationCode()).rejects.toThrow('timed out');
    await sleep(100);
    expect(await accepts(first.port)).toBe(false);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it('reports a busy callback port as an error before any browser opens, without an uncaught exception', async () => {
    const blocker = createServer();
    blockers.push(blocker);
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const busy = (blocker.address() as net.AddressInfo).port;
    const opened: string[] = [];

    const failure = await authenticateIfNeeded(fake.url, { callbackPort: busy }, { openBrowser: (url) => opened.push(url) })
      .then(() => undefined, (err: unknown) => err);

    expect((failure as Error).message).toBe(
      `Could not listen for the OAuth callback on 127.0.0.1:${busy} (EADDRINUSE). Try again with \`mcpkit auth <server>\`.`,
    );
    await sleep(50);
    expect(opened).toEqual([]);
    expect(uncaught).not.toHaveBeenCalled();
    expect(unhandled).not.toHaveBeenCalled();
    expect(await accepts(busy)).toBe(true);
  });

  it('opens the system browser with the URL as one argument, never through a shell', async () => {
    const hostile = 'https://auth.example.com/authorize?x=$(touch /tmp/pwned)&y=`id`';
    const provider = new McpkitOAuthProvider(fake.url, await freePort(), {}, undefined, { callbackTimeoutMs: 40 });

    await provider.redirectToAuthorization(new URL(hostile));

    expect(vi.mocked(execFile)).toHaveBeenCalledTimes(1);
    const [command, args] = vi.mocked(execFile).mock.calls[0] as unknown as [string, string[]];
    expect(['open', 'xdg-open', 'rundll32']).toContain(command);
    expect(args.at(-1)).toBe(new URL(hostile).toString());
    await expect(provider.waitForAuthorizationCode()).rejects.toThrow('timed out');
  });
});

describe('non-interactive connections never sign in', () => {
  // The real client is used here, and the build normally injects its version.
  beforeAll(() => { vi.stubGlobal('__PKG_VERSION__', 'test'); });
  afterAll(() => { vi.unstubAllGlobals(); });

  let fake: FakeOAuthServer;
  let listen: MockInstance;
  const credentialsPath = () => join(homedir(), '.mcpkit', 'credentials.json');
  const entry = (): ServerEntry => ({
    name: 'oa',
    transport: { type: 'http', url: fake.url, auth: 'oauth' },
    toolCount: 0,
    agents: ['claude-code'],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });

  async function storeCredentials(credentials: Record<string, unknown>): Promise<void> {
    await mkdir(join(homedir(), '.mcpkit'), { recursive: true });
    await writeFile(credentialsPath(), JSON.stringify({ [fake.url]: credentials }), { mode: 0o600 });
  }

  beforeEach(async () => {
    fake = await startFakeOAuthServer();
    // Every listener, of any kind, is a net.Server listening: the fake server above is already up.
    listen = vi.spyOn(net.Server.prototype, 'listen');
  });

  afterEach(async () => {
    listen.mockRestore();
    await fake.close();
    vi.mocked(execFile).mockClear();
  });

  function expectNoBrowserAndNoListener(): void {
    expect(vi.mocked(execFile)).not.toHaveBeenCalled();
    expect(listen).not.toHaveBeenCalled();
    expect(fake.requests.filter((request) => request.endsWith('/authorize') || request.endsWith('/register') || request.endsWith('/token'))).toEqual([]);
  }

  it('with no stored sign-in, fails at once with OAuthRequiredError before any request, browser or listener', async () => {
    const failure = await discoverForEntry(entry(), { interactiveAuth: false }).then(() => undefined, (err: unknown) => err);

    expect(failure).toBeInstanceOf(OAuthRequiredError);
    expect((failure as OAuthRequiredError).message).toBe('oa needs sign-in. Run: mcpkit auth oa');
    expect(fake.requests).toEqual([]);
    expectNoBrowserAndNoListener();
  });

  it('with a stored token the server rejects, no refresh token and no client registration, fails without registering one', async () => {
    await storeCredentials({ tokens: { access_token: 'stale', token_type: 'Bearer' } });

    const failure = await discoverForEntry(entry(), { interactiveAuth: false }).then(() => undefined, (err: unknown) => err);

    expect(failure).toBeInstanceOf(OAuthRequiredError);
    expect((failure as OAuthRequiredError).message).toBe('oa needs sign-in. Run: mcpkit auth oa');
    // It did reach the server (to learn the token was refused) but went no further.
    expect(fake.requests[0]).toBe('POST /mcp');
    expectNoBrowserAndNoListener();
  });

  it('with a stored token the server rejects and no refresh token, surfaces OAuthRequiredError instead of starting an authorization', async () => {
    await storeCredentials({ clientInfo: { client_id: 'fake-client' }, tokens: { access_token: 'stale', token_type: 'Bearer' } });
    const before = await readFile(credentialsPath(), 'utf-8');

    const failure = await discoverForEntry(entry(), { interactiveAuth: false }).then(() => undefined, (err: unknown) => err);

    expect(failure).toBeInstanceOf(OAuthRequiredError);
    expectNoBrowserAndNoListener();
    expect(await readFile(credentialsPath(), 'utf-8')).toBe(before);
  });

  it('with a refresh token the server accepts, refreshes and lists the tools without any browser', async () => {
    await storeCredentials({
      clientInfo: { client_id: 'fake-client' },
      tokens: { access_token: 'stale', token_type: 'Bearer', refresh_token: 'good-refresh', issuer: fake.origin },
    });

    const { tools } = await discoverForEntry(entry(), { interactiveAuth: false });

    expect(tools.map((tool) => tool.name)).toEqual(['ping']);
    expect(fake.requests).toContain('POST /token');
    const stored = JSON.parse(await readFile(credentialsPath(), 'utf-8'))[fake.url];
    expect(stored.tokens.access_token).toBe('good-access');
    expect(vi.mocked(execFile)).not.toHaveBeenCalled();
    expect(listen).not.toHaveBeenCalled();
  });

  it('a provider built for a batch command cannot start a flow even when asked directly', async () => {
    const provider = await resolveAuthProvider(entry(), { interactive: false }).then(() => undefined, (err: unknown) => err);

    expect(provider).toBeInstanceOf(OAuthRequiredError);
    expectNoBrowserAndNoListener();
  });
});
