import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { loadDirectoryServers, loadDirectoryServersChecked } from './directory.js';
import { loadDirectoryServers as reExported } from './commands/hook.js';
import { saveSchemaCache } from './schema-store.js';
import type { AgentType, ToolInfo } from './types.js';

const tools: ToolInfo[] = [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object' } }];

function registryEntry(name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const now = '2026-01-01T00:00:00.000Z';
  return { name, transport: { type: 'stdio', command: 'node', args: ['x.js'] }, toolCount: 1, agents: ['claude-code'], agentSelectionMode: 'explicit', createdAt: now, updatedAt: now, ...extra };
}

describe('directory', () => {
  const originalHome = process.env.HOME;
  let home = '';
  const registryFile = () => join(home, '.mcpkit', 'servers.yaml');
  const writeRegistry = async (servers: Record<string, unknown>) => {
    await mkdir(join(home, '.mcpkit'), { recursive: true });
    await writeFile(registryFile(), stringify({ version: 1, servers }), 'utf-8');
  };

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'mcpkit-directory-'));
    process.env.HOME = home;
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await chmod(home, 0o755).catch(() => {});
    await chmod(join(home, '.mcpkit'), 0o755).catch(() => {});
    await rm(home, { recursive: true, force: true });
  });

  it('is still exported from the hook command, so nothing that imported it breaks', () => {
    expect(reExported).toBe(loadDirectoryServers);
  });

  describe('loadDirectoryServers', () => {
    it('lists a server for an agent by the rule that places per-server skills: its list in explicit mode, Claude Code for an empty or missing list', async () => {
      const raw = registryEntry('legacy');
      delete raw.agents;
      await writeRegistry({
        everywhere: registryEntry('everywhere', { agents: [] }),
        mine: registryEntry('mine', { agents: ['cursor', 'claude-code'] }),
        other: registryEntry('other', { agents: ['codex'] }),
        legacy: raw,
      });

      expect((await loadDirectoryServers('claude-code')).map((server) => server.name).sort()).toEqual(['everywhere', 'legacy', 'mine']);
      expect((await loadDirectoryServers('codex')).map((server) => server.name).sort()).toEqual(['other']);
      expect((await loadDirectoryServers('cursor')).map((server) => server.name).sort()).toEqual(['mine']);
      expect((await loadDirectoryServers('hermes' as AgentType)).map((server) => server.name).sort()).toEqual([]);
    });

    describe('an agent enabled after the server was installed', () => {
      const saveDefaults = (enabledAgents: AgentType[]) => writeFile(
        join(home, '.mcpkit', 'settings.yaml'),
        stringify({ version: 1, enabledAgents, updatedAt: '2026-01-01T00:00:00.000Z' }),
        'utf-8',
      );

      it('lists a defaults-mode server with a stale stored agents list for it, and respects an explicit list', async () => {
        await writeRegistry({
          stale: registryEntry('stale', { agents: ['claude-code'], agentSelectionMode: 'defaults' }),
          unmarked: registryEntry('unmarked', { agents: ['claude-code'], agentSelectionMode: undefined }),
          pinned: registryEntry('pinned', { agents: ['claude-code'], agentSelectionMode: 'explicit' }),
        });
        await saveDefaults(['claude-code', 'cursor']);

        expect((await loadDirectoryServers('cursor')).map((server) => server.name).sort()).toEqual(['stale', 'unmarked']);
        expect((await loadDirectoryServers('claude-code')).map((server) => server.name).sort()).toEqual(['pinned', 'stale', 'unmarked']);
        expect((await loadDirectoryServers('codex')).map((server) => server.name)).toEqual([]);
        expect((await loadDirectoryServersChecked('cursor')).servers.map((server) => server.name).sort()).toEqual(['stale', 'unmarked']);
      });

      it('follows the stored list again when there are no saved defaults (the legacy case) and ignores an unusable settings file', async () => {
        await writeRegistry({ stale: registryEntry('stale', { agents: ['claude-code'], agentSelectionMode: 'defaults' }) });
        expect((await loadDirectoryServers('cursor')).map((server) => server.name)).toEqual([]);
        expect((await loadDirectoryServers('claude-code')).map((server) => server.name)).toEqual(['stale']);

        await writeFile(join(home, '.mcpkit', 'settings.yaml'), 'enabledAgents: [not-an-agent', 'utf-8');
        const warnings: string[] = [];
        const original = console.warn;
        console.warn = (...parts: unknown[]) => { warnings.push(parts.join(' ')); };
        try {
          expect((await loadDirectoryServers('claude-code')).map((server) => server.name)).toEqual(['stale']);
        } finally {
          console.warn = original;
        }
        expect(warnings).toEqual([]);
      });
    });

    it('carries the description (only when it is text) and the cached tools, and lists a server whose cache is missing', async () => {
      await writeRegistry({
        cached: registryEntry('cached', { description: 'Has a cache' }),
        bare: registryEntry('bare', { description: 42 }),
      });
      await saveSchemaCache('cached', tools);

      const servers = await loadDirectoryServers('claude-code');
      expect(servers.find((server) => server.name === 'cached')).toEqual({ name: 'cached', description: 'Has a cache', tools });
      expect(servers.find((server) => server.name === 'bare')).toEqual({ name: 'bare', description: undefined });
    });

    it('is an empty list for a missing registry', async () => {
      expect(await loadDirectoryServers('claude-code')).toEqual([]);
    });

    it('rejects for a corrupt registry, as the hook always did (the hook catches it and stays silent)', async () => {
      await mkdir(join(home, '.mcpkit'), { recursive: true });
      await writeFile(registryFile(), 'servers: [unclosed', 'utf-8');
      await expect(loadDirectoryServers('claude-code')).rejects.toThrow(/Cannot read/);
    });
  });

  describe('loadDirectoryServersChecked', () => {
    it('is ok with no servers for a missing registry file', async () => {
      expect(await loadDirectoryServersChecked('claude-code')).toEqual({ servers: [], ok: true });
    });

    it('is ok with no servers for an empty registry file', async () => {
      await mkdir(join(home, '.mcpkit'), { recursive: true });
      await writeFile(registryFile(), '', 'utf-8');
      expect(await loadDirectoryServersChecked('claude-code')).toEqual({ servers: [], ok: true });
    });

    it('is ok, with the servers, for a good registry', async () => {
      await writeRegistry({ demo: registryEntry('demo') });
      await saveSchemaCache('demo', tools);
      expect(await loadDirectoryServersChecked('claude-code')).toEqual({ servers: [{ name: 'demo', description: undefined, tools }], ok: true });
    });

    it('is not ok for a registry that cannot be parsed, and for one of another version', async () => {
      await mkdir(join(home, '.mcpkit'), { recursive: true });
      await writeFile(registryFile(), 'servers: [unclosed', 'utf-8');
      expect(await loadDirectoryServersChecked('claude-code')).toEqual({ servers: [], ok: false });

      await writeFile(registryFile(), stringify({ version: 9, servers: {} }), 'utf-8');
      expect(await loadDirectoryServersChecked('claude-code')).toEqual({ servers: [], ok: false });
    });

    it.skipIf(process.getuid?.() === 0)('is not ok for a registry that cannot be read (permissions)', async () => {
      await writeRegistry({ demo: registryEntry('demo') });
      await chmod(registryFile(), 0o000);
      expect(await loadDirectoryServersChecked('claude-code')).toEqual({ servers: [], ok: false });
    });

    it('does not tell a missing file apart from nothing registered, and a directory in its place is not ok', async () => {
      await mkdir(registryFile(), { recursive: true });
      expect((await loadDirectoryServersChecked('claude-code')).ok).toBe(false);
    });

    it('never rejects and prints no warning for an entry it skips', async () => {
      await writeRegistry({ good: registryEntry('good'), broken: { name: 'broken' } });
      const warnings: string[] = [];
      const original = console.warn;
      console.warn = (...parts: unknown[]) => { warnings.push(parts.join(' ')); };
      try {
        const result = await loadDirectoryServersChecked('claude-code');
        expect(result.ok).toBe(true);
        expect(result.servers.map((server) => server.name)).toEqual(['good']);
      } finally {
        console.warn = original;
      }
      expect(warnings).toEqual([]);
    });
  });
});
