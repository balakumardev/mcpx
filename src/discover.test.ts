import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverForEntry, getToolsForServer, resolveAuthProvider } from './discover.js';
import { discoverTools } from './client.js';
import { authenticateIfNeeded, createStoredOAuthProvider } from './auth.js';
import { loadSchemaCache, saveSchemaCache, schemaCacheDir, schemaCachePath } from './schema-store.js';
import type { ToolInfo, TransportConfig } from './types.js';

vi.mock('./client.js', () => ({
  discoverTools: vi.fn(),
}));

vi.mock('./auth.js', () => ({
  authenticateIfNeeded: vi.fn(),
  createStoredOAuthProvider: vi.fn(),
}));

const stdio: TransportConfig = { type: 'stdio', command: 'node', args: ['server.js'] };
const oauthHttp: TransportConfig = {
  type: 'http',
  url: 'https://mcp.example.com/mcp',
  auth: 'oauth',
  oauth: { clientId: 'client-1' },
};

const liveTools: ToolInfo[] = [
  { name: 'live_tool', description: 'From the server', inputSchema: { type: 'object' } },
];
const cachedTools: ToolInfo[] = [
  { name: 'cached_tool', description: 'From the cache', inputSchema: { type: 'object' } },
];

function fakeProvider(tokens?: { access_token: string }) {
  return {
    tokens: vi.fn(() => tokens),
    redirectToAuthorization: vi.fn(async () => {}),
  };
}

describe('discover', () => {
  const originalHome = process.env.HOME;
  let homeDir = '';

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'mcpkit-discover-'));
    process.env.HOME = homeDir;
    vi.mocked(discoverTools).mockResolvedValue({ tools: liveTools, serverMeta: { name: 'srv' } });
  });

  afterEach(async () => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    await rm(homeDir, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  describe('resolveAuthProvider', () => {
    it('returns undefined for servers that do not use OAuth', async () => {
      for (const transport of [stdio, { type: 'http', url: 'https://x/mcp' } as TransportConfig]) {
        for (const interactive of [true, false]) {
          expect(await resolveAuthProvider({ name: 'srv', transport }, { interactive })).toBeUndefined();
        }
      }
      expect(authenticateIfNeeded).not.toHaveBeenCalled();
      expect(createStoredOAuthProvider).not.toHaveBeenCalled();
    });

    it('runs the full OAuth flow when interactive', async () => {
      const provider = fakeProvider({ access_token: 't' });
      vi.mocked(authenticateIfNeeded).mockResolvedValue(provider as never);

      const resolved = await resolveAuthProvider({ name: 'srv', transport: oauthHttp }, { interactive: true });

      expect(resolved).toBe(provider);
      expect(authenticateIfNeeded).toHaveBeenCalledWith('https://mcp.example.com/mcp', { clientId: 'client-1' });
      expect(createStoredOAuthProvider).not.toHaveBeenCalled();
    });

    it('uses stored credentials only when non-interactive', async () => {
      const provider = fakeProvider({ access_token: 'stored' });
      vi.mocked(createStoredOAuthProvider).mockResolvedValue(provider as never);

      const resolved = await resolveAuthProvider({ name: 'srv', transport: oauthHttp }, { interactive: false });

      expect(resolved).toBe(provider);
      expect(authenticateIfNeeded).not.toHaveBeenCalled();
      expect(createStoredOAuthProvider).toHaveBeenCalledWith(
        'https://mcp.example.com/mcp',
        { clientId: 'client-1' },
        expect.stringContaining('run `mcpkit auth srv` first'),
      );
    });

    it('fails fast, without a browser, when non-interactive and no credentials are stored', async () => {
      const provider = fakeProvider(undefined);
      vi.mocked(createStoredOAuthProvider).mockResolvedValue(provider as never);

      await expect(
        resolveAuthProvider({ name: 'srv', transport: oauthHttp }, { interactive: false }),
      ).rejects.toThrow('run `mcpkit auth srv` first');
      expect(authenticateIfNeeded).not.toHaveBeenCalled();
      expect(provider.redirectToAuthorization).not.toHaveBeenCalled();
    });
  });

  describe('discoverForEntry', () => {
    it('discovers with the entry transport and env hints, and returns the discovery result', async () => {
      const result = await discoverForEntry(
        { name: 'srv', transport: stdio, envHints: { TOKEN: 'mint one' } },
        { interactiveAuth: true },
      );

      expect(result).toEqual({ tools: liveTools, serverMeta: { name: 'srv' } });
      expect(discoverTools).toHaveBeenCalledWith(stdio, undefined, { TOKEN: 'mint one' });
    });

    it('passes the interactive OAuth provider to discovery', async () => {
      const provider = fakeProvider({ access_token: 't' });
      vi.mocked(authenticateIfNeeded).mockResolvedValue(provider as never);

      await discoverForEntry({ name: 'srv', transport: oauthHttp }, { interactiveAuth: true });

      expect(discoverTools).toHaveBeenCalledWith(oauthHttp, provider, undefined);
    });

    it('never calls the interactive auth function when interactiveAuth is false', async () => {
      const provider = fakeProvider({ access_token: 'stored' });
      vi.mocked(createStoredOAuthProvider).mockResolvedValue(provider as never);

      await discoverForEntry({ name: 'srv', transport: oauthHttp }, { interactiveAuth: false });

      expect(authenticateIfNeeded).not.toHaveBeenCalled();
      expect(discoverTools).toHaveBeenCalledWith(oauthHttp, provider, undefined);
    });

    it('does not touch the schema cache', async () => {
      await discoverForEntry({ name: 'srv', transport: stdio }, { interactiveAuth: true });
      expect(await loadSchemaCache('srv')).toBeNull();
    });
  });

  describe('getToolsForServer', () => {
    const entry = { name: 'srv', transport: stdio };

    it('returns the cached tools without connecting when a cache exists', async () => {
      await saveSchemaCache('srv', cachedTools);

      const result = await getToolsForServer(entry);

      expect(result).toEqual({ tools: cachedTools, fromCache: true });
      expect(discoverTools).not.toHaveBeenCalled();
    });

    it('discovers live on a cache miss and fills the cache', async () => {
      const result = await getToolsForServer(entry);

      expect(result).toEqual({ tools: liveTools, fromCache: false });
      expect(discoverTools).toHaveBeenCalledTimes(1);
      expect((await loadSchemaCache('srv'))!.tools).toEqual(liveTools);

      // The next lookup is served from the cache that was just written.
      expect((await getToolsForServer(entry)).fromCache).toBe(true);
      expect(discoverTools).toHaveBeenCalledTimes(1);
    });

    it('ignores the cache and rewrites it when refresh is set', async () => {
      await saveSchemaCache('srv', cachedTools);

      const result = await getToolsForServer(entry, { refresh: true });

      expect(result).toEqual({ tools: liveTools, fromCache: false });
      expect((await loadSchemaCache('srv'))!.tools).toEqual(liveTools);
    });

    it('treats a corrupt cache as a miss', async () => {
      await mkdir(schemaCacheDir(), { recursive: true });
      await writeFile(schemaCachePath('srv'), '{"version":1,', 'utf-8');

      const result = await getToolsForServer(entry);

      expect(result.fromCache).toBe(false);
      expect((await loadSchemaCache('srv'))!.tools).toEqual(liveTools);
    });

    it('does not open a browser by default on a miss', async () => {
      const oauthEntry = { name: 'srv', transport: oauthHttp };
      vi.mocked(createStoredOAuthProvider).mockResolvedValue(fakeProvider({ access_token: 'stored' }) as never);

      await getToolsForServer(oauthEntry);

      expect(authenticateIfNeeded).not.toHaveBeenCalled();
    });

    it('runs the interactive flow on a miss only when asked to', async () => {
      const oauthEntry = { name: 'srv', transport: oauthHttp };
      vi.mocked(authenticateIfNeeded).mockResolvedValue(fakeProvider({ access_token: 't' }) as never);

      await getToolsForServer(oauthEntry, { interactiveAuth: true });

      expect(authenticateIfNeeded).toHaveBeenCalledTimes(1);
    });

    it('does not need auth at all on a cache hit', async () => {
      await saveSchemaCache('srv', cachedTools);

      await getToolsForServer({ name: 'srv', transport: oauthHttp }, { interactiveAuth: true });

      expect(authenticateIfNeeded).not.toHaveBeenCalled();
      expect(createStoredOAuthProvider).not.toHaveBeenCalled();
    });

    it('still returns the live tools when the cache cannot be written', async () => {
      await mkdir(join(homeDir, '.mcpkit'), { recursive: true });
      await writeFile(schemaCacheDir(), 'in the way', 'utf-8');
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const result = await getToolsForServer(entry);

      expect(result).toEqual({ tools: liveTools, fromCache: false });
      expect(errorSpy).toHaveBeenCalledTimes(1);
    });

    it('propagates a discovery failure on a miss', async () => {
      vi.mocked(discoverTools).mockRejectedValue(new Error('connection refused'));

      await expect(getToolsForServer(entry)).rejects.toThrow('connection refused');
    });
  });
});
