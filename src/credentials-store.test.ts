import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  McpkitOAuthProvider,
  clearCredentials,
  createOAuthProvider,
  createStoredOAuthProvider,
  hasValidTokens,
} from './auth.js';
import { resolveAuthProvider } from './discover.js';
import { runModuleScript, sourceUrl } from './test-utils.js';
import type { TransportConfig } from './types.js';

const SERVER_A = 'https://a.example.com/mcp';
const SERVER_B = 'https://b.example.com/mcp';
const BLOCKED = 'needs sign-in: run `mcpkit auth srv` first';

function tokens(accessToken: string) {
  return { access_token: accessToken, token_type: 'bearer', refresh_token: `${accessToken}-refresh` };
}

describe('credentials store', () => {
  const originalHome = process.env.HOME;
  let homeDir = '';
  const credentialsPath = () => join(homeDir, '.mcpkit', 'credentials.json');
  const openServers: Array<ReturnType<typeof createServer>> = [];

  async function writeStore(store: Record<string, unknown>): Promise<void> {
    await mkdir(join(homeDir, '.mcpkit'), { recursive: true });
    await writeFile(credentialsPath(), JSON.stringify(store, null, 2), { encoding: 'utf-8', mode: 0o600 });
  }

  async function readStore(): Promise<Record<string, any>> {
    return JSON.parse(await readFile(credentialsPath(), 'utf-8'));
  }

  /** Listen on a free local port so that anything probing it finds it taken. */
  async function occupyPort(): Promise<number> {
    const server = createServer();
    openServers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return (server.address() as { port: number }).port;
  }

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'mcpkit-credentials-'));
    process.env.HOME = homeDir;
  });

  afterEach(async () => {
    await Promise.all(openServers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    await rm(homeDir, { recursive: true, force: true });
  });

  describe('writes', () => {
    it('a stale in-memory snapshot cannot overwrite another server saved meanwhile', async () => {
      // Both providers were built from the same (empty) snapshot, as two parallel processes would be.
      const providerA = new McpkitOAuthProvider(SERVER_A, 9001, {});
      const providerB = new McpkitOAuthProvider(SERVER_B, 9002, {});

      await providerB.saveTokens(tokens('b-token'));
      await providerA.saveTokens(tokens('a-token'));

      const store = await readStore();
      expect(store[SERVER_A].tokens.access_token).toBe('a-token');
      expect(store[SERVER_B].tokens.access_token).toBe('b-token');
    });

    it('keeps every server when separate processes save different servers at once', async () => {
      const script = `
        import { McpkitOAuthProvider } from ${JSON.stringify(sourceUrl('src/auth.ts'))};
        const [name, count] = process.argv.slice(2);
        const url = 'https://' + name + '.example.com/mcp';
        const provider = new McpkitOAuthProvider(url, 9000, {});
        for (let i = 0; i < Number(count); i++) {
          await provider.saveTokens({ access_token: name + '-' + i, token_type: 'bearer' });
          await provider.saveCodeVerifier(name + '-verifier-' + i);
        }
      `;
      const names = ['p1', 'p2', 'p3', 'p4', 'p5'];

      await Promise.all(names.map((name) => (
        runModuleScript(homeDir, `saver-${name}.mjs`, script, homeDir, [name, '6'])
      )));

      const store = await readStore();
      for (const name of names) {
        expect(store[`https://${name}.example.com/mcp`].tokens.access_token).toBe(`${name}-5`);
        expect(store[`https://${name}.example.com/mcp`].codeVerifier).toBe(`${name}-verifier-5`);
      }
      expect(Object.keys(store)).toHaveLength(names.length);
      expect(existsSync(`${credentialsPath()}.lock`)).toBe(false);
      expect((await readdir(join(homeDir, '.mcpkit'))).filter((file) => file.endsWith('.tmp'))).toEqual([]);
    }, 30_000);

    it('writes with mode 0600, also over a file that had wider permissions', async () => {
      await mkdir(join(homeDir, '.mcpkit'), { recursive: true });
      await writeFile(credentialsPath(), '{}', { encoding: 'utf-8', mode: 0o644 });

      await new McpkitOAuthProvider(SERVER_A, 9001, {}).saveTokens(tokens('t'));

      expect((await stat(credentialsPath())).mode & 0o777).toBe(0o600);
    });

    it('clearCredentials drops only the one server', async () => {
      await writeStore({ [SERVER_A]: { tokens: tokens('a') }, [SERVER_B]: { tokens: tokens('b') } });

      await clearCredentials(SERVER_A);

      expect(await readStore()).toEqual({ [SERVER_B]: { tokens: tokens('b') } });
    });

    it('saving client information records the callback port next to it', async () => {
      await writeStore({ [SERVER_B]: { tokens: tokens('b') } });

      await new McpkitOAuthProvider(SERVER_A, 9001, {}).saveClientInformation({ client_id: 'registered' });

      const store = await readStore();
      expect(store[SERVER_A]).toEqual({ clientInfo: { client_id: 'registered' }, callbackPort: 9001 });
      expect(store[SERVER_B].tokens.access_token).toBe('b');
    });
  });

  describe('a credentials file that cannot be read', () => {
    const CREDENTIAL_PROBLEMS: Array<[string, string, RegExp]> = [
      ['invalid JSON', '{"https://a.example.com/mcp": {"tokens": ', /invalid JSON/],
      ['a JSON array', '[]', /not a JSON object/],
      ['JSON null', 'null', /not a JSON object/],
      ['a JSON string', '"tokens"', /not a JSON object/],
    ];

    async function writeRaw(content: string): Promise<void> {
      await mkdir(join(homeDir, '.mcpkit'), { recursive: true });
      await writeFile(credentialsPath(), content, { encoding: 'utf-8', mode: 0o600 });
    }

    it('reads a missing file and an empty file as no credentials', async () => {
      expect(await hasValidTokens(SERVER_A)).toBe(false);

      await writeRaw('');
      expect(await hasValidTokens(SERVER_A)).toBe(false);
      await new McpkitOAuthProvider(SERVER_A, 9001, {}).saveTokens(tokens('after-empty'));
      expect((await readStore())[SERVER_A].tokens.access_token).toBe('after-empty');
    });

    it.each(CREDENTIAL_PROBLEMS)('every reader throws for %s, naming the file and saying nothing was written', async (_label, content, reason) => {
      await writeRaw(content);

      const readers: Array<() => Promise<unknown>> = [
        () => hasValidTokens(SERVER_A),
        () => createOAuthProvider(SERVER_A),
        () => createStoredOAuthProvider(SERVER_A, undefined, BLOCKED),
        () => resolveAuthProvider({ name: 'srv', transport: { type: 'http', url: SERVER_A, auth: 'oauth' } }, { interactive: false }),
      ];
      for (const read of readers) {
        const error = await read().then(() => undefined, (err: Error) => err);
        expect(error?.message).toMatch(reason);
        expect(error?.message).toContain(credentialsPath());
        expect(error?.message).toMatch(/Nothing was written/);
        expect(error?.message).toMatch(/fix or remove/i);
      }
    });

    it.each(CREDENTIAL_PROBLEMS)('no write replaces %s: the other servers cannot be wiped', async (_label, content) => {
      await writeRaw(content);
      const provider = new McpkitOAuthProvider(SERVER_A, 9001, {});

      await expect(provider.saveTokens(tokens('t'))).rejects.toThrow(/Nothing was written/);
      await expect(provider.saveCodeVerifier('v')).rejects.toThrow(/Nothing was written/);
      await expect(provider.saveClientInformation({ client_id: 'c' })).rejects.toThrow(/Nothing was written/);
      await expect(provider.invalidateCredentials('tokens')).rejects.toThrow(/Nothing was written/);
      await expect(clearCredentials(SERVER_A)).rejects.toThrow(/Nothing was written/);

      expect(await readFile(credentialsPath(), 'utf-8')).toBe(content);
      expect(existsSync(`${credentialsPath()}.lock`)).toBe(false);
      expect((await readdir(join(homeDir, '.mcpkit'))).sort()).toEqual(['credentials.json']);
    });

    it('throws when the path cannot be read at all', async () => {
      await mkdir(credentialsPath(), { recursive: true });

      const error = await hasValidTokens(SERVER_A).then(() => undefined, (err: Error) => err);

      expect(error?.message).toContain(`Cannot read ${credentialsPath()}`);
      expect(error?.message).toMatch(/EISDIR/);
    });
  });

  describe('interactive provider', () => {
    it('forgets the client registration of a server whose callback port is now taken, and nothing else', async () => {
      const busyPort = await occupyPort();
      await writeStore({
        [SERVER_A]: { clientInfo: { client_id: 'old' }, callbackPort: busyPort, tokens: tokens('a') },
        [SERVER_B]: { clientInfo: { client_id: 'other' }, callbackPort: 9002, tokens: tokens('b') },
      });

      const provider = await createOAuthProvider(SERVER_A);

      expect(provider.redirectUrl.port).not.toBe(String(busyPort));
      const store = await readStore();
      expect(store[SERVER_A]).toEqual({ tokens: tokens('a') });
      expect(store[SERVER_B]).toEqual({ clientInfo: { client_id: 'other' }, callbackPort: 9002, tokens: tokens('b') });
    });
  });

  describe('stored-credentials provider (non-interactive)', () => {
    it('writes nothing when built, even though the stored callback port is busy', async () => {
      const busyPort = await occupyPort();
      await writeStore({
        [SERVER_A]: { clientInfo: { client_id: 'registered' }, callbackPort: busyPort, tokens: tokens('a') },
      });
      const before = { bytes: await readFile(credentialsPath(), 'utf-8'), mtime: (await stat(credentialsPath())).mtimeMs };

      const provider = await createStoredOAuthProvider(SERVER_A, undefined, BLOCKED);

      expect(provider.redirectUrl.port).toBe(String(busyPort));
      expect(provider.clientInformation()).toEqual({ client_id: 'registered' });
      expect(provider.tokens()?.access_token).toBe('a');
      expect(await readFile(credentialsPath(), 'utf-8')).toBe(before.bytes);
      expect((await stat(credentialsPath())).mtimeMs).toBe(before.mtime);
      expect(existsSync(`${credentialsPath()}.lock`)).toBe(false);
    });

    it('prefers a configured callback port and needs no stored one', async () => {
      await writeStore({ [SERVER_A]: { tokens: tokens('a') } });

      const configured = await createStoredOAuthProvider(SERVER_A, { callbackPort: 3118 }, BLOCKED);
      const unset = await createStoredOAuthProvider(SERVER_A, undefined, BLOCKED);

      expect(configured.redirectUrl.toString()).toBe('http://localhost:3118/callback');
      expect(unset.tokens()?.access_token).toBe('a');
    });

    it('can never register a client, start an authorization or open a browser', async () => {
      await writeStore({ [SERVER_A]: { tokens: tokens('a') } });
      const before = await readFile(credentialsPath(), 'utf-8');
      const provider = await createStoredOAuthProvider(SERVER_A, undefined, BLOCKED);

      await expect(provider.saveClientInformation({ client_id: 'new' })).rejects.toThrow(BLOCKED);
      await expect(provider.saveCodeVerifier('verifier')).rejects.toThrow(BLOCKED);
      await expect(provider.redirectToAuthorization(new URL('https://auth.example.com/authorize'))).rejects.toThrow(BLOCKED);

      expect(await readFile(credentialsPath(), 'utf-8')).toBe(before);
    });

    it('still persists a refreshed token, next to what was stored', async () => {
      await writeStore({
        [SERVER_A]: { clientInfo: { client_id: 'registered' }, callbackPort: 9001, tokens: tokens('old') },
        [SERVER_B]: { tokens: tokens('b') },
      });
      const provider = await createStoredOAuthProvider(SERVER_A, undefined, BLOCKED);

      await provider.saveTokens(tokens('refreshed'));

      const store = await readStore();
      expect(store[SERVER_A].tokens.access_token).toBe('refreshed');
      expect(store[SERVER_A].clientInfo).toEqual({ client_id: 'registered' });
      expect(store[SERVER_A].callbackPort).toBe(9001);
      expect(store[SERVER_B].tokens.access_token).toBe('b');
    });
  });

  describe('resolveAuthProvider without interaction', () => {
    const oauthHttp: TransportConfig = { type: 'http', url: SERVER_A, auth: 'oauth' };

    it('fails fast and creates no credentials file when nothing is stored', async () => {
      await expect(resolveAuthProvider({ name: 'srv', transport: oauthHttp }, { interactive: false }))
        .rejects.toThrow('run `mcpkit auth srv` first');

      expect(existsSync(credentialsPath())).toBe(false);
    });

    it('fails fast when only a client registration is stored', async () => {
      await writeStore({ [SERVER_A]: { clientInfo: { client_id: 'registered' }, callbackPort: 9001 } });

      await expect(resolveAuthProvider({ name: 'srv', transport: oauthHttp }, { interactive: false }))
        .rejects.toThrow('run `mcpkit auth srv` first');
    });

    it('leaves the credentials file untouched when the stored port is busy', async () => {
      const busyPort = await occupyPort();
      await writeStore({
        [SERVER_A]: { clientInfo: { client_id: 'registered' }, callbackPort: busyPort, tokens: tokens('a') },
      });
      const before = { bytes: await readFile(credentialsPath(), 'utf-8'), mtime: (await stat(credentialsPath())).mtimeMs };

      const provider = await resolveAuthProvider({ name: 'srv', transport: oauthHttp }, { interactive: false });

      expect((await provider?.tokens())?.access_token).toBe('a');
      await expect(provider!.redirectToAuthorization(new URL('https://auth.example.com/authorize')))
        .rejects.toThrow('run `mcpkit auth srv` first');
      expect(await readFile(credentialsPath(), 'utf-8')).toBe(before.bytes);
      expect((await stat(credentialsPath())).mtimeMs).toBe(before.mtime);
    });
  });
});
