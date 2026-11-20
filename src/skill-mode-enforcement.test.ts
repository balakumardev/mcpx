import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInstallCommand } from './commands/install.js';
import { createSyncCommand } from './commands/sync.js';
import { createUpdateCommand } from './commands/update.js';
import { maybeAutoRefresh, refreshServer } from './auto-refresh.js';
import { addServer, getServer } from './config.js';
import { discoverForEntry } from './discover.js';
import { loadDirectoryServers } from './directory.js';
import { buildGuideDirectory } from './guide-directory.js';
import { buildMetaSkillContent } from './meta-skill.js';
import { loadSchemaCache } from './schema-store.js';
import { reconcileSkillFiles } from './skill-sync.js';
import { saveSkillMode } from './settings.js';
import { generatedSkill, skillContext, treeOf, writeGeneratedSkill, writeUserSkill } from './skill-fixtures.js';
import type { AgentType, ServerEntry, ToolInfo } from './types.js';

vi.mock('./discover.js', () => ({
  discoverForEntry: vi.fn(),
}));

const tools: ToolInfo[] = [{ name: 'echo', description: 'Echo a message', inputSchema: { type: 'object' } }];

function entry(name: string, agents: AgentType[], extra: Partial<ServerEntry> = {}): ServerEntry {
  const now = '2020-01-01T00:00:00.000Z';
  return {
    name,
    transport: { type: 'stdio', command: 'node', args: ['server.js'] },
    toolCount: 1,
    agents,
    agentSelectionMode: 'explicit',
    createdAt: now,
    updatedAt: now,
    ...extra,
  };
}

describe('skill mode guide, wherever per-server skills are produced', () => {
  const originalHome = process.env.HOME;
  const originalSkills = process.env.MCPKIT_SKILLS;
  let home = '';
  let out: string[] = [];

  const skillsDir = (agent = '.claude') => join(home, agent, 'skills');
  const perServerSkill = (agent: AgentType, name: string) => generatedSkill(agent, name).then((skill) => skill.path);
  const guideOf = (agent = '.claude') => join(skillsDir(agent), 'mcpkit-cli', 'SKILL.md');
  /** The guide of an agent in guide mode: the generic text and the directory of the servers that serve it. */
  const guideListing = async (agent: AgentType = 'claude-code') => buildMetaSkillContent({ directory: buildGuideDirectory(await loadDirectoryServers(agent)) });

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'mcpkit-enforce-'));
    process.env.HOME = home;
    delete process.env.MCPKIT_SKILLS;
    delete process.env.HERMES_HOME;
    out = [];
    vi.mocked(discoverForEntry).mockReset();
    vi.mocked(discoverForEntry).mockResolvedValue({ tools, serverMeta: { name: 'srv' } });
    vi.spyOn(console, 'log').mockImplementation((...parts) => { out.push(parts.join(' ')); });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalSkills === undefined) delete process.env.MCPKIT_SKILLS;
    else process.env.MCPKIT_SKILLS = originalSkills;
    await rm(home, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe('reconcileSkillFiles', () => {
    const ctx = skillContext('demo');

    it('writes only the agents that are not in guide mode', async () => {
      await saveSkillMode('guide', 'claude-code');
      await saveSkillMode('per-server', 'cursor');

      await reconcileSkillFiles({ ctx, nextAgents: ['claude-code', 'cursor'] });

      expect(existsSync(await perServerSkill('claude-code', 'demo'))).toBe(false);
      expect(await readFile(await perServerSkill('cursor', 'demo'), 'utf-8')).toContain('name: mcpkit-demo');
    });

    it('writes nothing at all when every agent is in guide mode', async () => {
      await saveSkillMode('guide');

      await reconcileSkillFiles({ ctx, nextAgents: ['claude-code', 'cursor'] });

      expect(await readdir(home)).toEqual(['.mcpkit']);
    });

    it('does not remove or rewrite the skill of a guide agent that is in both the old and the new list', async () => {
      const mine = await writeUserSkill('claude-code', 'mcpkit-demo', 'my own skill that shares the name');
      await saveSkillMode('guide', 'claude-code');

      await reconcileSkillFiles({ ctx, nextAgents: ['claude-code'], previousAgents: ['claude-code'] });

      expect(await readFile(mine.path, 'utf-8')).toBe('my own skill that shares the name');
    });

    it('still removes the skill of an agent that left the list, as before', async () => {
      const existing = await writeGeneratedSkill('cursor', 'demo');
      await saveSkillMode('guide', 'claude-code');

      await reconcileSkillFiles({ ctx, nextAgents: ['claude-code'], previousAgents: ['claude-code', 'cursor'] });

      expect(existsSync(existing.dir)).toBe(false);
    });

    it('says which agents it skipped, and a dry run writes nothing', async () => {
      await saveSkillMode('guide', 'claude-code');
      const before = await treeOf(home);

      await reconcileSkillFiles({ ctx, nextAgents: ['claude-code', 'cursor'], dryRun: true });

      expect(await treeOf(home)).toEqual(before);
      expect(out.join('\n')).toMatch(/claude-code.*skills mode: guide/);
    });

    it('stays quiet about it when asked to', async () => {
      await saveSkillMode('guide', 'claude-code');

      await reconcileSkillFiles({ ctx, nextAgents: ['claude-code'], quiet: true });

      expect(out).toEqual([]);
    });

    it('keeps writing the skill of a project-scope server whatever the mode', async () => {
      const project = join(home, 'project');
      await mkdir(project, { recursive: true });
      vi.spyOn(process, 'cwd').mockReturnValue(project);
      await saveSkillMode('guide');

      await reconcileSkillFiles({ ctx: { ...ctx, scope: 'project' }, nextAgents: ['claude-code'] });

      expect(await readFile(join(project, '.claude', 'skills', 'mcpkit-demo', 'SKILL.md'), 'utf-8')).toContain('name: mcpkit-demo');
    });

    it('writes nothing with no setting: the built-in default is the guide', async () => {
      await reconcileSkillFiles({ ctx, nextAgents: ['claude-code', 'cursor'] });
      expect(await readdir(home)).toEqual([]);
    });

    it('is unchanged for agents on per-server: the skill of every agent is written', async () => {
      await saveSkillMode('per-server');
      await reconcileSkillFiles({ ctx, nextAgents: ['claude-code', 'cursor'] });
      for (const agent of ['claude-code', 'cursor'] as const) {
        expect(await readFile(await perServerSkill(agent, 'demo'), 'utf-8')).toContain('name: mcpkit-demo');
      }
    });

    it('still refuses a bad server name when every agent is in guide mode', async () => {
      await saveSkillMode('guide');

      await expect(reconcileSkillFiles({ ctx: { ...ctx, serverName: 'x/../../victim' }, nextAgents: ['claude-code'] })).rejects.toThrow(/Invalid server name/);
    });

    it('is also bound by MCPKIT_SKILLS', async () => {
      process.env.MCPKIT_SKILLS = 'guide';
      await reconcileSkillFiles({ ctx, nextAgents: ['claude-code', 'cursor'] });
      expect(await readdir(home)).toEqual([]);
    });
  });

  describe('install', () => {
    const install = (...args: string[]) => createInstallCommand().parseAsync(args, { from: 'user' });

    it('writes the guide but no per-server skill for a guide agent, and still records the server and its schema cache', async () => {
      await saveSkillMode('guide', 'claude-code');

      await install('node ./server.js', '-n', 'demo', '-a', 'claude-code');

      expect(existsSync(await perServerSkill('claude-code', 'demo'))).toBe(false);
      // The guide lists the server that was just installed: it is written after the registry and the cache.
      const guide = await readFile(guideOf(), 'utf-8');
      expect(guide).toBe(await guideListing());
      expect(guide).toContain('- demo');
      expect((await getServer('demo'))?.agents).toEqual(['claude-code']);
      expect((await loadSchemaCache('demo'))?.tools).toEqual(tools);
      expect(out.join('\n')).toMatch(/claude-code.*skills mode: guide/);
    });

    it('still writes the per-server skill for the other agents of the same install', async () => {
      await saveSkillMode('guide', 'claude-code');
      await saveSkillMode('per-server', 'cursor');

      await install('node ./server.js', '-n', 'demo', '-a', 'claude-code', '-a', 'cursor');

      expect(existsSync(await perServerSkill('claude-code', 'demo'))).toBe(false);
      expect(await readFile(await perServerSkill('cursor', 'demo'), 'utf-8')).toContain('name: mcpkit-demo');
      expect(existsSync(guideOf('.cursor'))).toBe(true);
      expect(existsSync(guideOf())).toBe(true);
    });

    it('keeps writing the per-server skill for --scope project', async () => {
      const project = join(home, 'project');
      await mkdir(project, { recursive: true });
      vi.spyOn(process, 'cwd').mockReturnValue(project);
      await saveSkillMode('guide');

      await install('node ./server.js', '-n', 'demo', '-a', 'claude-code', '--scope', 'project');

      expect(existsSync(join(project, '.claude', 'skills', 'mcpkit-demo', 'SKILL.md'))).toBe(true);
      expect(existsSync(await perServerSkill('claude-code', 'demo'))).toBe(false);
    });

    it('writes no per-server skill when no setting exists: the built-in default is the guide', async () => {
      await install('node ./server.js', '-n', 'demo', '-a', 'claude-code');
      expect(existsSync(await perServerSkill('claude-code', 'demo'))).toBe(false);
      expect(await readFile(guideOf(), 'utf-8')).toBe(await guideListing());
    });

    it('writes the per-server skill for an agent set to per-server', async () => {
      await saveSkillMode('per-server', 'claude-code');
      await install('node ./server.js', '-n', 'demo', '-a', 'claude-code');
      expect(existsSync(await perServerSkill('claude-code', 'demo'))).toBe(true);
      expect(await readFile(guideOf(), 'utf-8')).toBe(buildMetaSkillContent());
    });

    it('with --dry-run writes nothing in guide mode either', async () => {
      await saveSkillMode('guide', 'claude-code');
      const before = await treeOf(home);

      await install('node ./server.js', '-n', 'demo', '-a', 'claude-code', '--dry-run');

      expect(await treeOf(home)).toEqual(before);
    });
  });

  describe('sync', () => {
    const sync = (...args: string[]) => createSyncCommand().parseAsync(args, { from: 'user' });

    it('does not rediscover a server whose agents are all in guide mode, and still refreshes the guide', async () => {
      await addServer(entry('demo', ['claude-code']));
      await saveSkillMode('guide', 'claude-code');

      await sync();

      expect(vi.mocked(discoverForEntry)).not.toHaveBeenCalled();
      expect(await readFile(guideOf(), 'utf-8')).toBe(await guideListing());
      expect(await readFile(guideOf(), 'utf-8')).toContain('- demo');
      expect(out.join('\n')).toMatch(/skills mode: guide/);
    });

    it('with --force discovers and writes no per-server skill for a guide agent', async () => {
      await addServer(entry('demo', ['claude-code']));
      await saveSkillMode('guide', 'claude-code');

      await sync('--force');

      expect(vi.mocked(discoverForEntry)).toHaveBeenCalledTimes(1);
      expect(existsSync(await perServerSkill('claude-code', 'demo'))).toBe(false);
      expect(existsSync(guideOf())).toBe(true);
      expect((await loadSchemaCache('demo'))?.tools).toEqual(tools);
    });

    it('regenerates only the agents that are not in guide mode, and checks only those for existing skills', async () => {
      await addServer(entry('demo', ['claude-code', 'cursor']));
      await saveSkillMode('guide', 'claude-code');
      await saveSkillMode('per-server', 'cursor');

      await sync();

      expect(vi.mocked(discoverForEntry)).toHaveBeenCalledTimes(1);
      expect(existsSync(await perServerSkill('claude-code', 'demo'))).toBe(false);
      expect(existsSync(await perServerSkill('cursor', 'demo'))).toBe(true);
      expect(((await getServer('demo')) as ServerEntry).agents).toEqual(['claude-code', 'cursor']);

      vi.mocked(discoverForEntry).mockClear();
      await sync();
      expect(vi.mocked(discoverForEntry)).not.toHaveBeenCalled();
    });

    it('is a plain sync again after switching back to per-server', async () => {
      await addServer(entry('demo', ['claude-code']));
      await saveSkillMode('guide', 'claude-code');
      await sync('--force');
      await saveSkillMode('per-server', 'claude-code');

      await sync();

      expect(await readFile(await perServerSkill('claude-code', 'demo'), 'utf-8')).toContain('name: mcpkit-demo');
    });
  });

  describe('update and auto-refresh', () => {
    it('update writes no per-server skill for a guide agent, and still refreshes the registry, the cache and the guide', async () => {
      await addServer(entry('demo', ['claude-code', 'cursor']));
      await saveSkillMode('guide', 'claude-code');
      await saveSkillMode('per-server', 'cursor');

      await createUpdateCommand().parseAsync(['demo'], { from: 'user' });

      expect(existsSync(await perServerSkill('claude-code', 'demo'))).toBe(false);
      expect(existsSync(await perServerSkill('cursor', 'demo'))).toBe(true);
      expect((await getServer('demo'))?.toolCount).toBe(1);
      expect((await loadSchemaCache('demo'))?.tools).toEqual(tools);
      // The guide of the guide agent lists the server, with the cache this very update wrote; the other agent's is generic.
      expect(await readFile(guideOf(), 'utf-8')).toBe(await guideListing());
      expect(await readFile(guideOf(), 'utf-8')).toContain('1 tool, 0 read-only');
      expect(await readFile(guideOf('.cursor'), 'utf-8')).toBe(buildMetaSkillContent());
    });

    it('refreshServer leaves the existing skill of a guide agent as it is', async () => {
      const existing = await writeGeneratedSkill('claude-code', 'demo');
      await saveSkillMode('guide', 'claude-code');
      const server = entry('demo', ['claude-code']);
      await addServer(server);

      await refreshServer(server, { quiet: true });

      expect(await readFile(existing.path, 'utf-8')).toBe(existing.content);
    });

    it('auto-refresh, when the skill is stale, writes no per-server skill for a guide agent', async () => {
      const server = entry('demo', ['claude-code'], { autoRefresh: { enabled: true, ttlSec: 60 } });
      await addServer(server);
      await saveSkillMode('guide', 'claude-code');

      await maybeAutoRefresh(server);

      expect(vi.mocked(discoverForEntry)).toHaveBeenCalledTimes(1);
      expect(existsSync(await perServerSkill('claude-code', 'demo'))).toBe(false);
      expect((await loadSchemaCache('demo'))?.tools).toEqual(tools);
    });

    it('auto-refresh with no setting writes no per-server skill: the built-in default is the guide', async () => {
      const server = entry('demo', ['claude-code'], { autoRefresh: { enabled: true, ttlSec: 60 } });
      await addServer(server);

      await maybeAutoRefresh(server);

      expect(existsSync(await perServerSkill('claude-code', 'demo'))).toBe(false);
    });

    it('auto-refresh still writes the skill of an agent set to per-server', async () => {
      const server = entry('demo', ['claude-code'], { autoRefresh: { enabled: true, ttlSec: 60 } });
      await addServer(server);
      await saveSkillMode('per-server', 'claude-code');

      await maybeAutoRefresh(server);

      expect(existsSync(await perServerSkill('claude-code', 'demo'))).toBe(true);
    });
  });

  it('never touches a skill directory it did not write', async () => {
    const notes = await writeUserSkill('claude-code', 'mcpkit-notes');
    await addServer(entry('demo', ['claude-code']));
    await saveSkillMode('guide', 'claude-code');

    await createSyncCommand().parseAsync(['--force'], { from: 'user' });
    await createUpdateCommand().parseAsync([], { from: 'user' });

    expect(await readFile(notes.path, 'utf-8')).toBe(notes.content);
  });
});
