import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { loadDirectoryServers } from './directory.js';
import { directoryFromSnapshot, loadDirectorySnapshot, snapshotSource } from './directory-snapshot.js';
import { loadRegistry } from './config.js';
import { schemaCachePath } from './schema-store.js';
import { ALL_AGENTS } from './types.js';
import type { AgentType, ServerEntry } from './types.js';

// Counts the reads of the schema caches; the real function stays in place.
const cacheReads = vi.hoisted(() => ({ names: [] as string[] }));
vi.mock('./schema-store.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./schema-store.js')>();
  return {
    ...original,
    loadSchemaCache: vi.fn(async (server: string) => {
      cacheReads.names.push(server);
      return original.loadSchemaCache(server);
    }),
  };
});

describe('the directory snapshot', () => {
  const originalHome = process.env.HOME;
  let home = '';

  const entry = (name: string, extra: Record<string, unknown>): Record<string, unknown> => ({
    name,
    transport: { type: 'stdio', command: 'node', args: ['server.js'] },
    toolCount: 1,
    agentSelectionMode: 'explicit',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...extra,
  });

  async function writeCache(name: string, body: unknown): Promise<void> {
    await mkdir(join(home, '.mcpkit', 'schemas'), { recursive: true });
    await writeFile(schemaCachePath(name), typeof body === 'string' ? body : JSON.stringify(body), 'utf-8');
  }

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'mcpkit-snapshot-'));
    process.env.HOME = home;
    cacheReads.names = [];
    await mkdir(join(home, '.mcpkit'), { recursive: true });
    const servers = Object.fromEntries([
      // Every shape of agent list: missing and empty (Claude Code, as `resolveServerAgents` has it), for one, for several.
      entry('everyone', { description: 'No agents list at all', agents: undefined }),
      entry('empty-list', { description: 'An empty list', agents: [] }),
      entry('cursor-only', { description: 'Only Cursor', agents: ['cursor'] }),
      entry('two', { description: 'Claude Code and Codex', agents: ['claude-code', 'codex'] }),
      // A hand-edited registry: a description that is not text.
      entry('odd-description', { description: 42, agents: ['claude-code'] }),
      entry('no-description', { agents: ['claude-code', 'cursor'] }),
      entry('bad-cache', { description: 'Its cache is corrupt', agents: ['hermes'] }),
      // Installed when only Claude Code was enabled: it follows the saved defaults from then on.
      entry('follows-defaults', { description: 'Follows the saved defaults', agents: ['claude-code'], agentSelectionMode: 'defaults' }),
    ].map((server) => [server.name as string, server]));
    await writeFile(join(home, '.mcpkit', 'servers.yaml'), stringify({ version: 1, servers }), 'utf-8');
    const tools = [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object' } }];
    await writeCache('everyone', { version: 1, server: 'everyone', fetchedAt: '2026-01-01T00:00:00.000Z', tools });
    await writeCache('cursor-only', { version: 1, server: 'cursor-only', fetchedAt: '2026-01-01T00:00:00.000Z', tools });
    await writeCache('odd-description', { version: 1, server: 'odd-description', fetchedAt: '2026-01-01T00:00:00.000Z', tools });
    await writeCache('bad-cache', '{ not json');
    cacheReads.names = [];
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await rm(home, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const saveDefaults = (enabledAgents: string[]) => writeFile(
    join(home, '.mcpkit', 'settings.yaml'),
    stringify({ version: 1, enabledAgents, updatedAt: '2026-01-01T00:00:00.000Z' }),
    'utf-8',
  );

  async function expectParity(): Promise<void> {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const registry = await loadRegistry();
    const snapshot = await loadDirectorySnapshot(Object.values(registry.servers));

    for (const agent of ALL_AGENTS) {
      const fromSnapshot = directoryFromSnapshot(snapshot, agent);
      expect(fromSnapshot.ok).toBe(true);
      expect(fromSnapshot.servers, agent).toEqual(await loadDirectoryServers(agent));
      expect((await snapshotSource(snapshot)(agent)).servers, agent).toEqual(await loadDirectoryServers(agent));
    }
  }

  const namesFor = async (agent: AgentType): Promise<string[]> => {
    const registry = await loadRegistry();
    return directoryFromSnapshot(await loadDirectorySnapshot(Object.values(registry.servers)), agent).servers.map((server) => server.name);
  };

  it('gives every agent exactly the directory `loadDirectoryServers` gives it (a guide written from either is the same guide)', async () => {
    await expectParity();

    // The cases above are not all the same list.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await namesFor('cursor')).toEqual(['cursor-only', 'no-description']);
    expect(await namesFor('claude-code')).toEqual(['everyone', 'empty-list', 'two', 'odd-description', 'no-description', 'follows-defaults']);
    expect(await namesFor('openclaw')).toEqual([]);
  });

  it('keeps that parity when agents were enabled after the servers were installed: a defaults-mode server follows the saved defaults in both', async () => {
    await saveDefaults(['claude-code', 'cursor', 'hermes']);

    await expectParity();

    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await namesFor('cursor')).toEqual(['cursor-only', 'no-description', 'follows-defaults']);
    expect(await namesFor('hermes')).toEqual(['bad-cache', 'follows-defaults']);
    expect(await namesFor('codex')).toEqual(['two']);
    // An explicit list is respected whatever the defaults are.
    expect(await namesFor('claude-code')).toEqual(['everyone', 'empty-list', 'two', 'odd-description', 'no-description', 'follows-defaults']);
  });

  it('uses the saved defaults it is given instead of reading the file (null: there are none)', async () => {
    await saveDefaults(['claude-code', 'cursor']);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const registry = await loadRegistry();
    const entries = Object.values(registry.servers);

    const none = await loadDirectorySnapshot(entries, null);
    expect(none.agentSettings).toBeNull();
    expect(directoryFromSnapshot(none, 'cursor').servers.map((server) => server.name)).toEqual(['cursor-only', 'no-description']);

    const given = await loadDirectorySnapshot(entries, { version: 1, enabledAgents: ['codex'], updatedAt: '2026-01-01T00:00:00.000Z' });
    expect(directoryFromSnapshot(given, 'codex').servers.map((server) => server.name)).toEqual(['two', 'follows-defaults']);
    expect(directoryFromSnapshot(given, 'cursor').servers.map((server) => server.name)).toEqual(['cursor-only', 'no-description']);
  });

  it('reads each schema cache once, however many agents ask for their directory', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const registry = await loadRegistry();
    const snapshot = await loadDirectorySnapshot(Object.values(registry.servers));
    expect([...cacheReads.names].sort()).toEqual(Object.keys(registry.servers).sort());

    for (const agent of ALL_AGENTS) directoryFromSnapshot(snapshot, agent);

    expect(cacheReads.names).toHaveLength(Object.keys(registry.servers).length);
  });
});
