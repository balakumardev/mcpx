import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInstallCommand } from './commands/install.js';
import { createListCommand } from './commands/list.js';
import { createSyncCommand } from './commands/sync.js';
import { refreshServer } from './auto-refresh.js';
import { addServer, getServer } from './config.js';
import { discoverForEntry } from './discover.js';
import { getGenerator } from './generators/index.js';
import { loadSchemaCache, saveSchemaCache, schemaCacheDir, schemaCachePath } from './schema-store.js';
import type { ServerEntry, ToolInfo } from './types.js';

vi.mock('./discover.js', () => ({
  discoverForEntry: vi.fn(),
}));

vi.mock('./skill-sync.js', () => ({
  reconcileSkillFiles: vi.fn(),
}));

vi.mock('./meta-skill.js', () => ({
  writeMetaSkill: vi.fn(),
}));

const discovered: ToolInfo[] = [
  {
    name: 'echo',
    title: 'Echo',
    description: 'Echo a message',
    inputSchema: { type: 'object', properties: { message: { type: 'string' } } },
    outputSchema: { type: 'object' },
    annotations: { readOnlyHint: true },
  },
];

const stale: ToolInfo[] = [{ name: 'old', description: 'Stale tool', inputSchema: { type: 'object' } }];

function makeEntry(name: string, overrides: Partial<ServerEntry> = {}): ServerEntry {
  const now = new Date().toISOString();
  return {
    name,
    transport: { type: 'stdio', command: 'node', args: ['server.js'] },
    toolCount: 0,
    agents: ['claude-code'],
    agentSelectionMode: 'explicit',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/** Make cache writes fail: a regular file sits where the cache directory should be. */
async function blockCacheDir(homeDir: string): Promise<void> {
  await mkdir(join(homeDir, '.mcpkit'), { recursive: true });
  await writeFile(schemaCacheDir(), 'in the way', 'utf-8');
}

describe('schema cache is written where tools are discovered', () => {
  const originalHome = process.env.HOME;
  let homeDir = '';
  let errorSpy: MockInstance<typeof console.error>;
  let exitSpy: MockInstance<typeof process.exit>;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'mcpkit-cache-writes-'));
    process.env.HOME = homeDir;
    vi.mocked(discoverForEntry).mockResolvedValue({ tools: discovered, serverMeta: { name: 'srv' } });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
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

  describe('install', () => {
    const run = (...extra: string[]) => createInstallCommand()
      .parseAsync(['node ./server.js', '-n', 'demo', '-a', 'claude-code', ...extra], { from: 'user' });

    it('caches the discovered tools next to the registry entry', async () => {
      await run();

      expect(discoverForEntry).toHaveBeenCalledWith(
        { name: 'demo', transport: { type: 'stdio', command: 'node', args: ['./server.js'] } },
        { interactiveAuth: true },
      );
      expect((await getServer('demo'))?.toolCount).toBe(1);
      const cache = await loadSchemaCache('demo');
      expect(cache?.tools).toEqual(discovered);
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it('writes neither registry nor cache on --dry-run', async () => {
      await run('--dry-run');

      expect(await getServer('demo')).toBeUndefined();
      expect(existsSync(schemaCachePath('demo'))).toBe(false);
    });

    it('still installs when the cache cannot be written, with one warning', async () => {
      await blockCacheDir(homeDir);

      await run();

      expect(await getServer('demo')).toBeDefined();
      expect(exitSpy).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(String(errorSpy.mock.calls[0][0])).toContain('could not cache tool schemas for "demo"');
    });
  });

  describe('sync', () => {
    async function writeSkillFile(entry: ServerEntry): Promise<void> {
      const generate = await getGenerator('claude-code');
      const { filePath } = generate({
        serverName: entry.name, tools: [], transport: entry.transport, scope: 'global',
      });
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, 'existing skill', 'utf-8');
    }

    it('caches the tools of a server it had to discover', async () => {
      await addServer(makeEntry('alpha'));

      await createSyncCommand().parseAsync([], { from: 'user' });

      expect(discoverForEntry).toHaveBeenCalledTimes(1);
      expect((await loadSchemaCache('alpha'))?.tools).toEqual(discovered);
      expect((await getServer('alpha'))?.toolCount).toBe(1);
    });

    it('leaves the cache alone when skill files exist and nothing is discovered', async () => {
      const entry = makeEntry('beta');
      await addServer(entry);
      await writeSkillFile(entry);
      await saveSchemaCache('beta', stale);

      await createSyncCommand().parseAsync([], { from: 'user' });

      expect(discoverForEntry).not.toHaveBeenCalled();
      expect((await loadSchemaCache('beta'))?.tools).toEqual(stale);
    });

    it('refreshes the cache with --force even when skill files exist', async () => {
      const entry = makeEntry('gamma');
      await addServer(entry);
      await writeSkillFile(entry);
      await saveSchemaCache('gamma', stale);

      await createSyncCommand().parseAsync(['--force'], { from: 'user' });

      expect((await loadSchemaCache('gamma'))?.tools).toEqual(discovered);
    });

    it('does not write the cache on --dry-run', async () => {
      await addServer(makeEntry('delta'));

      await createSyncCommand().parseAsync(['--dry-run'], { from: 'user' });

      expect(discoverForEntry).toHaveBeenCalledTimes(1);
      expect(existsSync(schemaCachePath('delta'))).toBe(false);
    });

    it('keeps syncing when the cache cannot be written', async () => {
      await addServer(makeEntry('epsilon'));
      await blockCacheDir(homeDir);

      await createSyncCommand().parseAsync([], { from: 'user' });

      expect((await getServer('epsilon'))?.toolCount).toBe(1);
      expect(exitSpy).not.toHaveBeenCalled();
    });
  });

  describe('update / auto-refresh (refreshServer)', () => {
    it('writes the registry snapshot and the cache after a refresh', async () => {
      const entry = makeEntry('zeta');
      await addServer(entry);
      await saveSchemaCache('zeta', stale);

      const result = await refreshServer(entry, { quiet: true });

      expect(result.toolCount).toBe(1);
      expect((await loadSchemaCache('zeta'))?.tools).toEqual(discovered);
      expect((await getServer('zeta'))?.toolCount).toBe(1);
    });

    it('is interactive by default and passes interactiveAuth: false through', async () => {
      const entry = makeEntry('eta');
      await addServer(entry);

      await refreshServer(entry, { quiet: true });
      await refreshServer(entry, { quiet: true, interactiveAuth: false });

      expect(vi.mocked(discoverForEntry).mock.calls.map(([, opts]) => opts)).toEqual([
        { interactiveAuth: true },
        { interactiveAuth: false },
      ]);
    });

    it('keeps the previous cache and throws when discovery fails', async () => {
      const entry = makeEntry('theta');
      await addServer(entry);
      await saveSchemaCache('theta', stale);
      vi.mocked(discoverForEntry).mockRejectedValueOnce(new Error('server down'));

      await expect(refreshServer(entry, { quiet: true })).rejects.toThrow('server down');

      expect((await loadSchemaCache('theta'))?.tools).toEqual(stale);
    });

    it('still succeeds when the cache cannot be written', async () => {
      const entry = makeEntry('iota');
      await addServer(entry);
      await blockCacheDir(homeDir);

      await expect(refreshServer(entry, { quiet: true })).resolves.toMatchObject({ toolCount: 1 });
      expect(errorSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('list <server>', () => {
    it('refreshes the cache after its live discovery and prints the tools as before', async () => {
      await addServer(makeEntry('kappa'));
      await saveSchemaCache('kappa', stale);
      const logSpy = vi.mocked(console.log);

      await createListCommand().parseAsync(['kappa'], { from: 'user' });

      expect(discoverForEntry).toHaveBeenCalledWith(expect.objectContaining({ name: 'kappa' }), { interactiveAuth: true });
      expect((await loadSchemaCache('kappa'))?.tools).toEqual(discovered);
      const printed = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
      expect(printed).toContain('echo');
      expect(printed).toContain('Echo a message');
    });

    it('does not fail when the cache cannot be written', async () => {
      await addServer(makeEntry('lambda'));
      await blockCacheDir(homeDir);

      await createListCommand().parseAsync(['lambda'], { from: 'user' });

      expect(exitSpy).not.toHaveBeenCalled();
    });
  });
});
