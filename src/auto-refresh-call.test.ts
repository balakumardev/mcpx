import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { maybeAutoRefresh, refreshServer } from './auto-refresh.js';
import { authenticateIfNeeded } from './auth.js';
import { discoverTools } from './client.js';
import { addServer, getServer, removeServer, updateServer } from './config.js';
import { loadSchemaCache } from './schema-store.js';
import type { ServerEntry, ToolInfo } from './types.js';

vi.mock('./client.js', () => ({
  discoverTools: vi.fn(),
}));

vi.mock('./skill-sync.js', () => ({
  reconcileSkillFiles: vi.fn(),
}));

// The real provider code runs; only the ways to reach a browser are observable here.
vi.mock('./auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./auth.js')>()),
  authenticateIfNeeded: vi.fn(),
}));

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFile: vi.fn(),
}));

const MCP_URL = 'https://mcp.example.com/mcp';

function staleEntry(overrides: Partial<ServerEntry> = {}): ServerEntry {
  const longAgo = '2020-01-01T00:00:00.000Z';
  return {
    name: 'srv',
    transport: { type: 'http', url: MCP_URL, auth: 'oauth' },
    toolCount: 5,
    agents: ['claude-code'],
    agentSelectionMode: 'explicit',
    autoRefresh: { enabled: true, ttlSec: 60 },
    createdAt: longAgo,
    updatedAt: longAgo,
    ...overrides,
  };
}

describe('auto-refresh inside call', () => {
  const originalHome = process.env.HOME;
  let homeDir = '';
  let stderr: MockInstance<typeof console.error>;

  function stderrText(): string {
    return stderr.mock.calls.map(([line]) => String(line)).join('\n');
  }

  async function storeTokens(): Promise<void> {
    await mkdir(join(homeDir, '.mcpkit'), { recursive: true });
    await writeFile(
      join(homeDir, '.mcpkit', 'credentials.json'),
      JSON.stringify({ [MCP_URL]: { tokens: { access_token: 'stored', token_type: 'bearer' }, callbackPort: 41234 } }),
      'utf-8',
    );
  }

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'mcpkit-refresh-'));
    process.env.HOME = homeDir;
    stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(discoverTools).mockResolvedValue({
      tools: [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object' } }],
      serverMeta: {},
    });
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

  it('skips the refresh without opening a browser when the server has no stored sign-in', async () => {
    await maybeAutoRefresh(staleEntry());

    expect(authenticateIfNeeded).not.toHaveBeenCalled();
    expect(execFile).not.toHaveBeenCalled();
    expect(discoverTools).not.toHaveBeenCalled();
    expect(stderrText()).toContain('srv needs sign-in. Run: mcpkit auth srv');
    expect(stderrText()).toContain('using cached skill');
  });

  it('refreshes with the stored tokens, never through the interactive flow', async () => {
    await storeTokens();
    const entry = staleEntry();
    await addServer(entry);

    await maybeAutoRefresh(entry);

    expect(authenticateIfNeeded).not.toHaveBeenCalled();
    expect(execFile).not.toHaveBeenCalled();
    expect(discoverTools).toHaveBeenCalledTimes(1);
    const provider = vi.mocked(discoverTools).mock.calls[0][1];
    expect((await provider?.tokens())?.access_token).toBe('stored');
    await expect(provider!.redirectToAuthorization(new URL('https://auth.example.com/authorize')))
      .rejects.toThrow('srv needs sign-in. Run: mcpkit auth srv');
    expect(execFile).not.toHaveBeenCalled();
    expect((await getServer('srv'))?.toolCount).toBe(1);
    expect(stderrText()).toContain('refreshed "srv"');
  });

  it('never fails the call when discovery fails', async () => {
    await storeTokens();
    vi.mocked(discoverTools).mockRejectedValue(new Error('server unreachable'));

    await expect(maybeAutoRefresh(staleEntry())).resolves.toBeUndefined();

    expect(stderrText()).toContain('server unreachable');
    expect(stderrText()).toContain('using cached skill');
  });

  it('does not print a credential of the server that the failure quotes', async () => {
    vi.mocked(discoverTools).mockRejectedValue(new Error('POST rejected x-api-key HEADERkey-0123456789'));
    const entry = staleEntry({
      transport: { type: 'http', url: MCP_URL, headers: { 'X-Api-Key': 'HEADERkey-0123456789' } },
    });

    await maybeAutoRefresh(entry);

    expect(stderrText()).toContain('POST rejected x-api-key <redacted>');
    expect(stderrText()).not.toContain('HEADERkey');
  });

  it('leaves servers that do not use OAuth on the plain path', async () => {
    await maybeAutoRefresh(staleEntry({ transport: { type: 'stdio', command: 'node', args: [] } }));

    expect(authenticateIfNeeded).not.toHaveBeenCalled();
    expect(discoverTools).toHaveBeenCalledTimes(1);
    expect(vi.mocked(discoverTools).mock.calls[0][1]).toBeUndefined();
  });
});

describe('a refresh that overlaps other commands', () => {
  const originalHome = process.env.HOME;
  let homeDir = '';
  const tools: ToolInfo[] = [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object' } }];

  /** Hold discovery open so the test can change the registry while a refresh is mid-flight. */
  function pendingDiscovery(): { release: () => void; started: Promise<void> } {
    let release = () => {};
    let markStarted = () => {};
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    vi.mocked(discoverTools).mockImplementationOnce(() => new Promise((resolve) => {
      markStarted();
      release = () => resolve({ tools, serverMeta: {} });
    }));
    return { release: () => release(), started };
  }

  function storedEntry(): ServerEntry {
    return staleEntry({ transport: { type: 'stdio', command: 'node', args: ['server.js'] } });
  }

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'mcpkit-refresh-overlap-'));
    process.env.HOME = homeDir;
    vi.spyOn(console, 'error').mockImplementation(() => {});
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

  it('does not bring back a server that was removed while it discovered tools', async () => {
    const entry = storedEntry();
    await addServer(entry);
    const discovery = pendingDiscovery();

    const refreshing = refreshServer(entry, { quiet: true });
    await discovery.started;
    await removeServer('srv');
    discovery.release();
    await refreshing;

    expect(await getServer('srv')).toBeUndefined();
    expect(await loadSchemaCache('srv')).toBeNull();
  });

  it('keeps an edit made while it discovered tools, and still records its own result', async () => {
    const entry = storedEntry();
    await addServer(entry);
    const discovery = pendingDiscovery();

    const refreshing = refreshServer(entry, { quiet: true });
    await discovery.started;
    await updateServer('srv', (current) => {
      if (current.transport.type === 'stdio') current.transport.env = { TOKEN: '${TOKEN}' };
      current.description = 'edited meanwhile';
      current.autoRefresh = { enabled: true, ttlSec: 5 };
    });
    discovery.release();
    await refreshing;

    const stored = await getServer('srv');
    expect(stored?.transport).toMatchObject({ env: { TOKEN: '${TOKEN}' } });
    expect(stored?.description).toBe('edited meanwhile');
    expect(stored?.toolCount).toBe(1);
    expect(stored?.autoRefresh).toMatchObject({ enabled: true, ttlSec: 5 });
    expect(stored?.autoRefresh?.lastRefreshedAt).toBeDefined();
    expect((await loadSchemaCache('srv'))?.tools).toEqual(tools);
  });

  it('does not turn auto-refresh back on when it was switched off meanwhile', async () => {
    const entry = storedEntry();
    await addServer(entry);
    const discovery = pendingDiscovery();

    const refreshing = refreshServer(entry, { quiet: true });
    await discovery.started;
    await updateServer('srv', (current) => { delete current.autoRefresh; });
    discovery.release();
    await refreshing;

    expect((await getServer('srv'))?.autoRefresh).toBeUndefined();
  });
});
