import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { DEFAULT_MATCHER, HOOK_COMMAND } from './hook-settings.js';
import { buildMetaSkillContent } from './meta-skill.js';
import { createProgram } from './program.js';
import { classifyCommand, formatNotices, printNotices, reconcile, reconcileAfterChange } from './reconcile.js';
import type { CommandClass, ReconcileReport } from './reconcile.js';
import { schemaCachePath } from './schema-store.js';
import { generatedSkill, writeGeneratedSkill, writeUserSkill } from './skill-fixtures.js';
import { loadState, stateFilePath } from './state.js';
import { ALL_AGENTS } from './types.js';
import type { AgentType } from './types.js';

// What the fast path must never read. The real function stays in place: the spy only counts.
const cacheReads = vi.hoisted(() => ({ count: 0 }));
vi.mock('./schema-store.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./schema-store.js')>();
  return {
    ...original,
    loadSchemaCache: vi.fn(async (server: string) => {
      cacheReads.count++;
      return original.loadSchemaCache(server);
    }),
  };
});

// Lets a test make the backup of chosen agents fail, which a real disk will not do on request.
const backupControl = vi.hoisted(() => ({ failFor: new Set<string>() }));
vi.mock('./skill-mode-migration.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./skill-mode-migration.js')>();
  return {
    ...original,
    backupSkillDirs: vi.fn(async (plans: Parameters<typeof original.backupSkillDirs>[0], now?: Date) => {
      if (plans.some((plan) => backupControl.failFor.has(plan.agent))) throw new Error('disk full (simulated)');
      return original.backupSkillDirs(plans, now);
    }),
  };
});

// Lets a test end a run right after the adoption of Claude Code was written (what a kill at that moment does), before its hook step.
const stateControl = vi.hoisted(() => ({ crashAfterClaudeAdoption: false }));
vi.mock('./state.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./state.js')>();
  return {
    ...original,
    updateState: vi.fn(async (change: Parameters<typeof original.updateState>[0], options?: Parameters<typeof original.updateState>[1]) => {
      const written = await original.updateState(change, options);
      if (stateControl.crashAfterClaudeAdoption && written && Object.hasOwn(original.loadState().state.adopted, 'claude-code')) throw new Error('killed (simulated)');
      return written;
    }),
  };
});

const NOW = new Date('2026-11-20T10:00:00.000Z');
const NO_ENV: NodeJS.ProcessEnv = {};
const ours = { matcher: DEFAULT_MATCHER, hooks: [{ type: 'command', command: HOOK_COMMAND }] };
const otherHook = { matcher: 'startup', hooks: [{ type: 'command', command: 'echo other-hook' }] };

describe('classifyCommand', () => {
  /** Every command of the real program, by its full path, and what start-up does for it. */
  const expected: Record<string, CommandClass> = {
    install: 'full',
    call: 'refresh',
    list: 'full',
    remove: 'full',
    update: 'full',
    sync: 'full',
    view: 'full',
    edit: 'full',
    auth: 'full',
    agents: 'full',
    'runtime status': 'full',
    'runtime stop': 'full',
    'runtime _host': 'skip',
    search: 'full',
    describe: 'full',
    types: 'full',
    exec: 'refresh',
    'hook session-start': 'skip',
    'hook install': 'skip',
    'hook uninstall': 'skip',
    'config skills': 'skip',
    'config lean': 'skip',
    '_sandbox-worker': 'skip',
  };

  /** The full path of every command that runs something: the leaves, and the groups that have an action of their own. */
  function actionPaths(program: ReturnType<typeof createProgram>): string[] {
    const paths: string[] = [];
    const walk = (command: ReturnType<typeof createProgram>, prefix: string[]): void => {
      for (const child of command.commands) {
        const path = [...prefix, child.name()];
        if (child.commands.length === 0) paths.push(path.join(' '));
        else walk(child, path);
      }
    };
    walk(program, []);
    return paths.sort();
  }

  it('classifies every command of the program, and the table above lists them all (a new command must be added to it)', () => {
    const paths = actionPaths(createProgram('0.0.0'));
    expect(paths).toEqual(Object.keys(expected).sort());
    for (const path of paths) expect(classifyCommand(path.split(' ')), path).toBe(expected[path]);
  });

  it('classifies a group that has an action of its own (config, hook) by its first word', () => {
    expect(classifyCommand(['config'])).toBe('skip');
    expect(classifyCommand(['hook'])).toBe('skip');
  });

  it.each([
    [['_anything'], 'skip'],
    [['runtime', '_host'], 'skip'],
    [['_x', 'call'], 'skip'],
    [['call'], 'refresh'],
    [['exec'], 'refresh'],
    [['runtime'], 'full'],
    [['some-future-command'], 'full'],
    [[], 'skip'],
  ] as Array<[string[], CommandClass]>)('classifies %j as %s', (path, kind) => {
    expect(classifyCommand(path)).toBe(kind);
  });
});

describe('reconcile', () => {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const originalNoMigrate = process.env.MCPKIT_NO_MIGRATE;
  let home = '';

  const mcpkit = (...parts: string[]): string => join(home, '.mcpkit', ...parts);
  const skillsOf = (agent: AgentType): string => join(home, agent === 'claude-code' ? '.claude' : `.${agent}`, 'skills');
  const guidePath = (agent: AgentType): string => join(skillsOf(agent), 'mcpkit-cli', 'SKILL.md');
  const claudeSettings = (): string => join(home, '.claude', 'settings.json');

  function entry(name: string, agents: AgentType[]): Record<string, unknown> {
    return {
      name,
      description: `The ${name} server`,
      transport: { type: 'stdio', command: 'node', args: ['server.js'] },
      toolCount: 2,
      agents,
      agentSelectionMode: 'explicit',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
  }

  async function writeRegistry(names: string[], agents: AgentType[] = ['claude-code', 'cursor']): Promise<void> {
    await mkdir(mcpkit(), { recursive: true });
    const servers = Object.fromEntries(names.map((name) => [name, entry(name, agents)]));
    await writeFile(mcpkit('servers.yaml'), stringify({ version: 1, servers }), 'utf-8');
  }

  async function writeCache(name: string): Promise<void> {
    await mkdir(mcpkit('schemas'), { recursive: true });
    await writeFile(schemaCachePath(name), JSON.stringify({
      version: 1,
      server: name,
      fetchedAt: '2026-01-01T00:00:00.000Z',
      tools: [{ name: 'echo', description: `Echo from ${name}`, inputSchema: { type: 'object' } }],
    }), 'utf-8');
  }

  async function writeSettingsFile(text: string): Promise<void> {
    await mkdir(join(home, '.mcpkit'), { recursive: true });
    await writeFile(mcpkit('config.yaml'), text, 'utf-8');
  }

  /** What an upgrader has: four registered servers (a and b cached, c and d not), a generated skill for each in cursor and claude-code, a hand-written skill, and the old static guide. */
  async function upgrader(): Promise<void> {
    await writeRegistry(['a', 'b', 'c', 'd']);
    await writeCache('a');
    await writeCache('b');
    for (const agent of ['claude-code', 'cursor'] as const) {
      for (const name of ['a', 'b', 'c', 'd']) await writeGeneratedSkill(agent, name);
      await writeUserSkill(agent, 'mcpkit-notes');
      await mkdir(join(skillsOf(agent), 'mcpkit-cli'), { recursive: true });
      await writeFile(guidePath(agent), buildMetaSkillContent(), 'utf-8');
    }
  }

  /** Every path under `dir` with its size and modification times; a path that does not exist is an empty list. */
  async function stats(dir: string): Promise<string[]> {
    try {
      const names = await readdir(dir, { recursive: true });
      const rows = await Promise.all(['', ...names].map(async (name) => {
        const info = await stat(join(dir, name));
        return `${name} ${info.isDirectory() ? 'dir' : info.size} ${info.mtimeMs}`;
      }));
      return rows.sort();
    } catch {
      return [];
    }
  }

  const names = async (dir: string): Promise<string[]> => (await readdir(dir).catch(() => [] as string[])).sort();

  async function backups(): Promise<string[]> {
    return names(mcpkit('skill-backups'));
  }

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'mcpkit-reconcile-'));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    // The test setup turns the reconcile off for every other test; these are the tests of it.
    delete process.env.MCPKIT_NO_MIGRATE;
    cacheReads.count = 0;
    backupControl.failFor.clear();
    stateControl.crashAfterClaudeAdoption = false;
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    if (originalNoMigrate === undefined) delete process.env.MCPKIT_NO_MIGRATE;
    else process.env.MCPKIT_NO_MIGRATE = originalNoMigrate;
    await rm(home, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe('a machine with nothing to do', () => {
    it('creates nothing on a machine that has never used mcpkit', async () => {
      const report = await reconcile('full', { now: NOW, env: NO_ENV });
      expect(report.skipped).toBeDefined();
      expect(await readdir(home)).toEqual([]);
    });

    it('creates nothing in ~/.mcpkit when it holds no registry and no agent has a skill or a guide: no lock, no state', async () => {
      await mkdir(mcpkit(), { recursive: true });
      const before = await stats(home);
      const report = await reconcile('full', { now: NOW, env: NO_ENV });
      expect(report.skipped).toBe('there is no agent to reconcile');
      expect(await stats(home)).toEqual(before);
    });
  });

  describe('moving an upgrader to the lean default', () => {
    it('writes the guide first, backs up and removes the skills whose tools are indexed, keeps the rest, records it, and adds the hook once', async () => {
      await upgrader();
      await writeFile(claudeSettings(), `${JSON.stringify({ model: 'opus', hooks: { SessionStart: [otherHook], Stop: [otherHook] } }, null, 2)}\n`);

      const report = await reconcile('full', { now: NOW, env: NO_ENV });

      expect(report.skipped).toBeUndefined();
      expect(report.failed).toBeUndefined();
      expect(report.notices).toEqual([]);
      for (const agent of ['claude-code', 'cursor'] as const) {
        expect(await names(skillsOf(agent))).toEqual(['mcpkit-c', 'mcpkit-cli', 'mcpkit-d', 'mcpkit-notes']);
        const guide = await readFile(guidePath(agent), 'utf-8');
        expect(guide).toContain('## MCP servers reachable through mcpkit (live list)');
        for (const name of ['a', 'b', 'c', 'd']) expect(guide).toContain(`- ${name}`);
      }

      const [backup] = await backups();
      expect(await backups()).toHaveLength(1);
      for (const agent of ['claude-code', 'cursor'] as const) {
        expect(await names(mcpkit('skill-backups', backup, agent))).toEqual(['mcpkit-a', 'mcpkit-b']);
        const original = await generatedSkill(agent, 'a');
        expect(await readFile(join(mcpkit('skill-backups', backup, agent, 'mcpkit-a'), 'SKILL.md'), 'utf-8')).toBe(original.content);
      }

      const { state, usable } = loadState();
      expect(usable).toBe(true);
      for (const agent of ['claude-code', 'cursor']) {
        expect(state.adopted[agent]).toEqual({ at: NOW.toISOString(), by: '0.0.0-dev', removed: 2, backup: mcpkit('skill-backups', backup), deferred: ['c', 'd'] });
      }
      expect(typeof state.fingerprint).toBe('string');
      expect(Object.keys(state.guideFiles ?? {}).sort()).toEqual(['claude-code', 'cursor']);

      const settings = JSON.parse(await readFile(claudeSettings(), 'utf-8')) as { model: string; hooks: { SessionStart: unknown[]; Stop: unknown[] } };
      expect(settings.model).toBe('opus');
      expect(settings.hooks.Stop).toEqual([otherHook]);
      expect(settings.hooks.SessionStart).toEqual([otherHook, ours]);
      expect((await names(join(home, '.claude'))).filter((name) => name.includes('.mcpkit-bak-'))).toHaveLength(1);

      expect(formatNotices(report)).toEqual([
        'mcpkit: skills are now lean by default: one mcpkit-cli guide with a live server list instead of one skill per server.',
        `  claude-code: moved 2 per-server skills to ${mcpkit('skill-backups', backup)} (copy a folder back to restore one).`,
        `  cursor: moved 2 per-server skills to ${mcpkit('skill-backups', backup)} (copy a folder back to restore one).`,
        '  claude-code: added the SessionStart hook (undo: mcpkit hook uninstall --write).',
        '  4 skills kept for servers whose tools are not indexed yet; they are removed automatically after you run: mcpkit update',
        '  Prefer one skill per server? mcpkit config lean off   (or set MCPKIT_SKILLS=per-server)',
      ]);
    });

    it('never touches a skill the user wrote, whether its name looks like ours or not, and a skill for a server the guide does not list stays', async () => {
      await upgrader();
      await writeGeneratedSkill('cursor', 'gone');
      await writeUserSkill('cursor', 'mcpkit-journal');
      const notes = await readFile(join(skillsOf('cursor'), 'mcpkit-notes', 'SKILL.md'), 'utf-8');

      await reconcile('full', { now: NOW, env: NO_ENV });

      expect(await readFile(join(skillsOf('cursor'), 'mcpkit-notes', 'SKILL.md'), 'utf-8')).toBe(notes);
      expect(await names(skillsOf('cursor'))).toEqual(['mcpkit-c', 'mcpkit-cli', 'mcpkit-d', 'mcpkit-gone', 'mcpkit-journal', 'mcpkit-notes']);
      // The leftover is not counted as "kept until indexed": no update would ever index it.
      expect(loadState().state.adopted.cursor.deferred).toEqual(['c', 'd']);
    });

    it('is a no-op the second time: no file under the agent directories or ~/.mcpkit changes, and nothing is read but stat data', async () => {
      await upgrader();
      await reconcile('full', { now: NOW, env: NO_ENV });
      const before = [...await stats(home)];
      const readsBefore = cacheReads.count;
      expect(readsBefore).toBeGreaterThan(0);

      const second = await reconcile('full', { now: new Date(NOW.getTime() + 60_000), env: NO_ENV });

      expect(second.fast).toBe(true);
      expect(second.actions).toEqual([]);
      expect(await stats(home)).toEqual(before);
      expect(cacheReads.count).toBe(readsBefore);
    });

    it('runs the whole pass again when the registry, a cache, a settings file or the guide changed (the fingerprint)', async () => {
      await upgrader();
      await reconcile('full', { now: NOW, env: NO_ENV });

      await writeCache('c');
      const afterCache = await reconcile('full', { now: NOW, env: NO_ENV });
      expect(afterCache.fast).toBeUndefined();
      expect(afterCache.actions.map((action) => action.type)).toContain('deferred-removed');

      await rm(guidePath('cursor'));
      const afterGuide = await reconcile('full', { now: NOW, env: NO_ENV });
      expect(afterGuide.fast).toBeUndefined();
      expect(afterGuide.actions).toContainEqual({ type: 'guide-written', agent: 'cursor' });
      expect((await reconcile('full', { now: NOW, env: NO_ENV })).fast).toBe(true);

      await writeRegistry(['a', 'b', 'c', 'd', 'e']);
      const afterRegistry = await reconcile('full', { now: NOW, env: NO_ENV });
      expect(afterRegistry.fast).toBeUndefined();
      expect(await readFile(guidePath('cursor'), 'utf-8')).toContain('- e');
      expect((await reconcile('full', { now: NOW, env: NO_ENV })).fast).toBe(true);

      await writeSettingsFile('version: 1\nskills:\n  agents:\n    cursor: guide\n');
      expect((await reconcile('full', { now: NOW, env: NO_ENV })).fast).toBeUndefined();
    });

    it('removes a kept skill once its server is indexed, backs it up, and forgets the name', async () => {
      await upgrader();
      await reconcile('full', { now: NOW, env: NO_ENV });
      await writeCache('c');

      const report = await reconcile('full', { now: new Date(NOW.getTime() + 3_600_000), env: NO_ENV });

      expect(await names(skillsOf('cursor'))).toEqual(['mcpkit-cli', 'mcpkit-d', 'mcpkit-notes']);
      expect(await names(skillsOf('claude-code'))).toEqual(['mcpkit-cli', 'mcpkit-d', 'mcpkit-notes']);
      const all = await backups();
      expect(all).toHaveLength(2);
      const second = all[1];
      expect(await names(mcpkit('skill-backups', second, 'cursor'))).toEqual(['mcpkit-c']);
      expect(loadState().state.adopted.cursor.deferred).toEqual(['d']);
      expect(loadState().state.adopted['claude-code'].deferred).toEqual(['d']);
      // One line for the run (one backup directory), with the total.
      expect(formatNotices(report)).toEqual([
        `mcpkit: removed 2 per-server skills for servers that are now indexed (backup: ${mcpkit('skill-backups', second)}).`,
      ]);
    });

    it('leaves a skill the user put back for a server that was already moved, and one for a server nobody listed', async () => {
      await upgrader();
      await reconcile('full', { now: NOW, env: NO_ENV });
      const [backup] = await backups();
      // Copy mcpkit-a back, the way the notice says, and index the kept servers so the deferred pass runs too.
      await cp(mcpkit('skill-backups', backup, 'cursor', 'mcpkit-a'), join(skillsOf('cursor'), 'mcpkit-a'), { recursive: true });
      await writeCache('c');
      await writeCache('d');

      await reconcile('full', { now: NOW, env: NO_ENV });
      await reconcile('full', { now: NOW, env: NO_ENV });

      expect(await names(skillsOf('cursor'))).toEqual(['mcpkit-a', 'mcpkit-cli', 'mcpkit-notes']);
      expect(await names(skillsOf('claude-code'))).toEqual(['mcpkit-cli', 'mcpkit-notes']);
      expect(loadState().state.adopted.cursor.removed).toBe(2);
    });

    it('forgets a deferred name whose skill is gone or was rewritten by the user, and then never touches a skill of that name', async () => {
      await upgrader();
      await reconcile('full', { now: NOW, env: NO_ENV });
      await rm(join(skillsOf('cursor'), 'mcpkit-c'), { recursive: true });
      await writeFile(join(skillsOf('cursor'), 'mcpkit-d', 'SKILL.md'), '---\nname: mcpkit-d\ndescription: "mine now"\n---\n\n# Mine\n');
      await writeCache('c');
      await writeCache('d');

      const report = await reconcile('full', { now: NOW, env: NO_ENV });

      expect(report.actions.filter((action) => action.type === 'deferred-removed' && action.agent === 'cursor')).toEqual([]);
      expect(loadState().state.adopted.cursor.deferred).toEqual([]);
      expect(await readFile(join(skillsOf('cursor'), 'mcpkit-d', 'SKILL.md'), 'utf-8')).toContain('mine now');
    });
  });

  describe('freshness without adoption (kind refresh: call and exec)', () => {
    it('rewrites a stale guide, and removes nothing, adds no hook, records no adoption, and says nothing', async () => {
      await upgrader();

      const report = await reconcile('refresh', { now: NOW, env: NO_ENV });

      expect(report.actions).toEqual([{ type: 'guide-written', agent: 'claude-code' }, { type: 'guide-written', agent: 'cursor' }]);
      expect(formatNotices(report)).toEqual([]);
      expect(await readFile(guidePath('cursor'), 'utf-8')).toContain('## MCP servers reachable through mcpkit (live list)');
      for (const agent of ['claude-code', 'cursor'] as const) {
        expect(await names(skillsOf(agent))).toEqual(['mcpkit-a', 'mcpkit-b', 'mcpkit-c', 'mcpkit-cli', 'mcpkit-d', 'mcpkit-notes']);
      }
      expect(await readdir(mcpkit())).not.toContain('skill-backups');
      await expect(stat(claudeSettings())).rejects.toThrow();
      // The one thing it writes down: the guides are current for these inputs (its own record, not the full pass's).
      const { state } = loadState();
      expect(state.adopted).toEqual({});
      expect(state.fingerprint).toBeUndefined();
      expect(typeof state.refreshFingerprint).toBe('string');
    });

    it('does not remember the pass as a full one, so the next full run still adopts', async () => {
      await upgrader();
      await reconcile('refresh', { now: NOW, env: NO_ENV });
      const full = await reconcile('full', { now: NOW, env: NO_ENV });
      expect(full.actions.filter((action) => action.type === 'adopted')).toHaveLength(2);
    });
  });

  describe('when nobody should be moved', () => {
    it.each([
      ['MCPKIT_SKILLS is set', { MCPKIT_SKILLS: 'guide' }],
      ['MCPKIT_SKILLS is set in capitals (the value is read the way `mcpkit config` reads it)', { MCPKIT_SKILLS: ' PER-SERVER ' }],
      ['MCPKIT_NO_MIGRATE=1', { MCPKIT_NO_MIGRATE: '1' }],
      ['MCPKIT_NO_MIGRATE=true', { MCPKIT_NO_MIGRATE: 'TRUE' }],
    ])('does nothing when %s: nothing is written, not even the state', async (_label, env) => {
      await upgrader();
      const before = await stats(home);

      const report = await reconcile('full', { now: NOW, env });

      expect(report.skipped).toBeDefined();
      expect(await stats(home)).toEqual(before);
    });

    it('MCPKIT_NO_MIGRATE=0 does not opt out', async () => {
      await upgrader();
      const report = await reconcile('full', { now: NOW, env: { MCPKIT_NO_MIGRATE: '0' } });
      expect(report.skipped).toBeUndefined();
    });

    it.each([
      ['invalid YAML', 'skills: [unclosed\n  - x: : :\n'],
      ['a newer version', 'version: 2\nskills:\n  default: per-server\n'],
      ['something that is not a mapping', '- just\n- a list\n'],
    ])('does nothing when config.yaml is unusable (%s): defaults mean the guide, which is no ground to delete skills', async (_label, text) => {
      await upgrader();
      await writeSettingsFile(text);
      const before = await stats(home);

      const report = await reconcile('full', { now: NOW, env: NO_ENV });

      expect(report.skipped).toContain('config.yaml');
      expect(await stats(home)).toEqual(before);
    });

    it('does nothing when the registry is corrupt', async () => {
      await upgrader();
      await writeFile(mcpkit('servers.yaml'), 'version: 1\nservers: [unclosed\n  - x: : :\n');
      const before = await stats(home);

      const report = await reconcile('full', { now: NOW, env: NO_ENV });

      expect(report.skipped).toContain('registry');
      expect(await stats(home)).toEqual(before);
    });

    it('does nothing when the registry cannot be read (permissions)', async () => {
      await upgrader();
      await chmod(mcpkit('servers.yaml'), 0o000);
      try {
        const before = await stats(home);
        const report = await reconcile('full', { now: NOW, env: NO_ENV });
        expect(report.skipped).toContain('registry');
        expect(await stats(home)).toEqual(before);
      } finally {
        await chmod(mcpkit('servers.yaml'), 0o600);
      }
    });

    it('leaves an agent with an explicit per-server entry alone: no guide, no removal', async () => {
      await upgrader();
      await writeSettingsFile('version: 1\nskills:\n  agents:\n    cursor: per-server\n');
      const cursorBefore = await stats(join(home, '.cursor'));

      const report = await reconcile('full', { now: NOW, env: NO_ENV });

      expect(await stats(join(home, '.cursor'))).toEqual(cursorBefore);
      expect(report.actions.some((action) => action.type === 'adopted' && action.agent === 'cursor')).toBe(false);
      // The other agent, on the built-in default, is moved.
      expect(await names(skillsOf('claude-code'))).toEqual(['mcpkit-c', 'mcpkit-cli', 'mcpkit-d', 'mcpkit-notes']);
      expect(loadState().state.adopted.cursor).toBeUndefined();
    });

    it('with an explicit guide (default or agent) only freshens the guide: no removal, no hook, no adoption on record', async () => {
      await upgrader();
      await writeSettingsFile('version: 1\nskills:\n  default: guide\n');

      const report = await reconcile('full', { now: NOW, env: NO_ENV });

      expect(report.actions.every((action) => action.type === 'guide-written')).toBe(true);
      expect(await readFile(guidePath('cursor'), 'utf-8')).toContain('## MCP servers reachable through mcpkit (live list)');
      for (const agent of ['claude-code', 'cursor'] as const) {
        expect(await names(skillsOf(agent))).toEqual(['mcpkit-a', 'mcpkit-b', 'mcpkit-c', 'mcpkit-cli', 'mcpkit-d', 'mcpkit-notes']);
      }
      expect(loadState().state.adopted).toEqual({});
      await expect(stat(claudeSettings())).rejects.toThrow();
      expect(await backups()).toEqual([]);
    });
  });

  describe('the state file', () => {
    it('with a corrupt state.json: the guide is freshened, nothing is removed, no hook is added, and the file is not replaced', async () => {
      await upgrader();
      await writeFile(stateFilePath(), '{ nope');

      const report = await reconcile('full', { now: NOW, env: NO_ENV });

      expect(report.actions.every((action) => action.type === 'guide-written')).toBe(true);
      expect(await readFile(guidePath('cursor'), 'utf-8')).toContain('## MCP servers reachable through mcpkit (live list)');
      expect(await names(skillsOf('cursor'))).toContain('mcpkit-a');
      expect(await readFile(stateFilePath(), 'utf-8')).toBe('{ nope');
      await expect(stat(claudeSettings())).rejects.toThrow();
      expect(await backups()).toEqual([]);
    });

    it('respects hookDeclined: the skills are moved and the settings file is not created', async () => {
      await upgrader();
      await writeFile(stateFilePath(), JSON.stringify({ version: 1, adopted: {}, hookDeclined: true }));

      const report = await reconcile('full', { now: NOW, env: NO_ENV });

      expect(report.actions.filter((action) => action.type === 'adopted')).toHaveLength(2);
      expect(report.actions.some((action) => action.type === 'hook-added')).toBe(false);
      await expect(stat(claudeSettings())).rejects.toThrow();
      expect(loadState().state.hookDeclined).toBe(true);
    });

    it('adds nothing when the hook is already installed (an older command of ours is left as it is)', async () => {
      await upgrader();
      const text = `${JSON.stringify({ hooks: { SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'mcpkit hook session-start' }] }] } }, null, 2)}\n`;
      await writeFile(claudeSettings(), text);

      const report = await reconcile('full', { now: NOW, env: NO_ENV });

      expect(report.actions.some((action) => action.type === 'hook-added')).toBe(false);
      expect(await readFile(claudeSettings(), 'utf-8')).toBe(text);
      expect((await names(join(home, '.claude'))).filter((name) => name.includes('.mcpkit-bak-'))).toEqual([]);
    });

    it('creates the settings file when there is none (as `hook install --write` does)', async () => {
      await upgrader();
      await rm(claudeSettings(), { force: true });

      await reconcile('full', { now: NOW, env: NO_ENV });

      expect(JSON.parse(await readFile(claudeSettings(), 'utf-8'))).toEqual({ hooks: { SessionStart: [ours] } });
      expect(((await stat(claudeSettings())).mode & 0o777)).toBe(0o600);
    });

    it.each([
      ['not valid JSON', '{ nope', 'not valid JSON'],
      ['a JSON array', '[1, 2]', 'must be a JSON object'],
      ['a file with hooks of the wrong type', '{"hooks": []}', '"hooks" must be an object'],
    ])('leaves a settings file that is %s untouched, says why, and still moves the skills', async (_label, text, reason) => {
      await upgrader();
      await writeFile(claudeSettings(), text);

      const report = await reconcile('full', { now: NOW, env: NO_ENV });

      expect(await readFile(claudeSettings(), 'utf-8')).toBe(text);
      expect((await names(join(home, '.claude'))).filter((name) => name.includes('.mcpkit-bak-'))).toEqual([]);
      expect(report.notices).toHaveLength(1);
      expect(report.notices[0]).toContain('could not add the hook:');
      expect(report.notices[0]).toContain(reason);
      expect(formatNotices(report)).toContain(`  ${report.notices[0]}`);
      expect(await names(skillsOf('claude-code'))).toEqual(['mcpkit-c', 'mcpkit-cli', 'mcpkit-d', 'mcpkit-notes']);
      expect(loadState().state.adopted['claude-code']).toBeDefined();
    });
  });

  describe('a failure', () => {
    it('removes nothing and records no adoption when the backup cannot be made, and tries again on the next run', async () => {
      await upgrader();
      await writeFile(mcpkit('skill-backups'), 'a file where the backup directory should be');
      const skillsBefore = await stats(skillsOf('cursor'));

      const report = await reconcile('full', { now: NOW, env: NO_ENV });

      expect(report.notices.some((notice) => notice.includes('could not back up'))).toBe(true);
      expect(report.actions.some((action) => action.type === 'adopted')).toBe(false);
      expect(report.actions.some((action) => action.type === 'hook-added')).toBe(false);
      // Nothing was removed (the guide was written first, as it always is).
      expect(await names(skillsOf('cursor'))).toEqual(['mcpkit-a', 'mcpkit-b', 'mcpkit-c', 'mcpkit-cli', 'mcpkit-d', 'mcpkit-notes']);
      expect((await stats(join(skillsOf('cursor'), 'mcpkit-a'))).length).toBeGreaterThan(0);
      expect(skillsBefore.length).toBeGreaterThan(0);
      expect(loadState().state.adopted).toEqual({});
      expect(loadState().state.fingerprint).toBeUndefined();

      await rm(mcpkit('skill-backups'));
      const retry = await reconcile('full', { now: NOW, env: NO_ENV });
      expect(retry.actions.filter((action) => action.type === 'adopted')).toHaveLength(2);
      expect(await names(skillsOf('cursor'))).toEqual(['mcpkit-c', 'mcpkit-cli', 'mcpkit-d', 'mcpkit-notes']);
    });

    it('one agent that cannot be backed up does not hold the others (the batch falls back to one backup per agent)', async () => {
      await upgrader();
      backupControl.failFor.add('cursor');

      const report = await reconcile('full', { now: NOW, env: NO_ENV });

      expect(report.notices).toEqual(['could not back up the cursor per-server skills (disk full (simulated)); they were left as they are']);
      expect(await names(skillsOf('claude-code'))).toEqual(['mcpkit-c', 'mcpkit-cli', 'mcpkit-d', 'mcpkit-notes']);
      expect(await names(skillsOf('cursor'))).toEqual(['mcpkit-a', 'mcpkit-b', 'mcpkit-c', 'mcpkit-cli', 'mcpkit-d', 'mcpkit-notes']);
      expect(loadState().state.adopted['claude-code']).toBeDefined();
      expect(loadState().state.adopted.cursor).toBeUndefined();
      expect(loadState().state.fingerprint).toBeUndefined();
      expect(await backups()).toHaveLength(1);
    });

    it.skipIf(process.getuid?.() === 0)('keeps a skill that was backed up but could not be removed: it goes on the deferred list, adoption is recorded once, and the next run removes it', async () => {
      await upgrader();
      const stuck = join(skillsOf('cursor'), 'mcpkit-a');
      // A folder that cannot be written to cannot lose its SKILL.md: removing the skill fails, and nothing of it is half gone.
      await chmod(stuck, 0o555);
      try {
        const first = await reconcile('full', { now: NOW, env: NO_ENV });

        expect(first.failed).toBeUndefined();
        expect(first.notices).toHaveLength(1);
        expect(first.notices[0]).toContain(`could not remove ${stuck}`);
        expect(await names(skillsOf('cursor'))).toEqual(['mcpkit-a', 'mcpkit-c', 'mcpkit-cli', 'mcpkit-d', 'mcpkit-notes']);
        expect(await names(skillsOf('claude-code'))).toEqual(['mcpkit-c', 'mcpkit-cli', 'mcpkit-d', 'mcpkit-notes']);
        expect(await readFile(join(stuck, 'SKILL.md'), 'utf-8')).toBe((await generatedSkill('cursor', 'a')).content);

        // The backup holds it, and it is on the list of skills kept for later: a skill with a cache is retried.
        const [backup] = await backups();
        expect(await names(mcpkit('skill-backups', backup, 'cursor'))).toEqual(['mcpkit-a', 'mcpkit-b']);
        const record = loadState().state.adopted.cursor;
        expect(record).toEqual({ at: NOW.toISOString(), by: '0.0.0-dev', removed: 1, backup: mcpkit('skill-backups', backup), deferred: ['c', 'd', 'a'] });
        expect(loadState().state.adopted['claude-code'].deferred).toEqual(['c', 'd']);
        expect(loadState().state.fingerprint).toBeUndefined();
        expect(first.actions.filter((action) => action.type === 'adopted')).toHaveLength(2);
        // The notice counts the skills kept for servers that are not indexed (c and d, in two agents), not the one that is stuck.
        expect(formatNotices(first)).toContain('  4 skills kept for servers whose tools are not indexed yet; they are removed automatically after you run: mcpkit update');
      } finally {
        await chmod(stuck, 0o755);
      }

      const second = await reconcile('full', { now: new Date(NOW.getTime() + 3_600_000), env: NO_ENV });

      expect(second.actions.filter((action) => action.type === 'adopted')).toEqual([]);
      expect(second.actions).toContainEqual({ type: 'deferred-removed', agent: 'cursor', removed: 1, backup: expect.any(String) });
      expect(second.notices).toEqual([]);
      expect(formatNotices(second)).toHaveLength(1);
      expect(formatNotices(second)[0]).toContain('removed 1 per-server skill for servers that are now indexed');
      expect(await names(skillsOf('cursor'))).toEqual(['mcpkit-c', 'mcpkit-cli', 'mcpkit-d', 'mcpkit-notes']);
      // Adopted once: the record is the first one, with the stuck name gone from its list.
      expect(loadState().state.adopted.cursor).toMatchObject({ at: NOW.toISOString(), removed: 1, deferred: ['c', 'd'] });
      expect((await reconcile('full', { now: NOW, env: NO_ENV })).fast).toBe(true);
    });

    it.skipIf(process.getuid?.() === 0)('does not forget a deferred skill whose removal fails once its server is indexed: the name stays on the list for the next run', async () => {
      await upgrader();
      await reconcile('full', { now: NOW, env: NO_ENV });
      await writeCache('c');
      const stuck = join(skillsOf('cursor'), 'mcpkit-c');
      await chmod(stuck, 0o555);
      try {
        const report = await reconcile('full', { now: new Date(NOW.getTime() + 3_600_000), env: NO_ENV });

        expect(report.notices).toHaveLength(1);
        expect(report.notices[0]).toContain(`could not remove ${stuck}`);
        expect(await names(skillsOf('cursor'))).toContain('mcpkit-c');
        expect(await names(skillsOf('claude-code'))).not.toContain('mcpkit-c');
        expect(loadState().state.adopted.cursor.deferred).toEqual(['c', 'd']);
        expect(loadState().state.adopted['claude-code'].deferred).toEqual(['d']);
      } finally {
        await chmod(stuck, 0o755);
      }

      const retry = await reconcile('full', { now: new Date(NOW.getTime() + 7_200_000), env: NO_ENV });

      expect(retry.actions).toContainEqual({ type: 'deferred-removed', agent: 'cursor', removed: 1, backup: expect.any(String) });
      expect(await names(skillsOf('cursor'))).not.toContain('mcpkit-c');
      expect(loadState().state.adopted.cursor.deferred).toEqual(['d']);
    });

    it('leaves an agent whose skills directory cannot be read as it is, and moves the others', async () => {
      await upgrader();
      await chmod(join(skillsOf('cursor'), 'mcpkit-a', 'SKILL.md'), 0o000);
      try {
        const report = await reconcile('full', { now: NOW, env: NO_ENV });

        expect(await names(skillsOf('claude-code'))).toEqual(['mcpkit-c', 'mcpkit-cli', 'mcpkit-d', 'mcpkit-notes']);
        expect(await names(skillsOf('cursor'))).toContain('mcpkit-a');
        expect(loadState().state.adopted['claude-code']).toBeDefined();
        expect(loadState().state.adopted.cursor).toBeUndefined();
        expect(loadState().state.fingerprint).toBeUndefined();
        expect(report.actions.some((action) => action.type === 'adopted' && action.agent === 'cursor')).toBe(false);
      } finally {
        await chmod(join(skillsOf('cursor'), 'mcpkit-a', 'SKILL.md'), 0o644);
      }
    });

    it('never throws and never prints, even when the home directory is not a directory', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      await writeFile(join(home, 'file'), 'x');
      process.env.HOME = join(home, 'file');

      const report = await reconcile('full', { now: NOW, env: NO_ENV });

      expect(report.skipped ?? report.failed).toBeDefined();
      for (const spy of [log, warn, error, out, err]) expect(spy).not.toHaveBeenCalled();
    });

    it('prints nothing while it loads a registry with an invalid entry (the loaders warn about those)', async () => {
      await upgrader();
      const registry = await readFile(mcpkit('servers.yaml'), 'utf-8');
      await writeFile(mcpkit('servers.yaml'), `${registry}  broken:\n    name: broken\n    transport: 3\n`);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

      const report = await reconcile('full', { now: NOW, env: NO_ENV });

      expect(report.actions.some((action) => action.type === 'adopted')).toBe(true);
      for (const spy of [warn, log, out, err]) expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('a failure notice that repeats', () => {
    const HOUR = 3_600_000;
    const at = (hours: number): Date => new Date(NOW.getTime() + hours * HOUR);

    it('is printed the first time, left out for the same failure within 24 hours, and printed again after that', async () => {
      await upgrader();
      // A file where the backup directory has to go: the backup fails again on every run.
      await writeFile(mcpkit('skill-backups'), 'a file where the backup directory should be');

      const first = await reconcile('full', { now: NOW, env: NO_ENV });
      expect(first.notices.some((notice) => notice.includes('could not back up'))).toBe(true);
      expect(first.noticesSuppressed).toBeUndefined();
      expect(formatNotices(first).join('\n')).toContain('could not back up');
      const recorded = loadState().state.lastNotice;
      expect(recorded).toEqual({ key: expect.stringMatching(/^[0-9a-f]{16}$/), at: NOW.toISOString() });

      const again = await reconcile('full', { now: at(1), env: NO_ENV });
      expect(again.notices).toEqual(first.notices);
      expect(again.noticesSuppressed).toBe(true);
      expect(formatNotices(again)).toEqual([]);
      // Left out, not renewed: the day is counted from the notice that was printed.
      expect(loadState().state.lastNotice).toEqual(recorded);

      const dayLater = await reconcile('full', { now: at(25), env: NO_ENV });
      expect(dayLater.noticesSuppressed).toBeUndefined();
      expect(formatNotices(dayLater).join('\n')).toContain('could not back up');
      expect(loadState().state.lastNotice).toEqual({ key: recorded?.key, at: at(25).toISOString() });
    });

    it.skipIf(process.getuid?.() === 0)('counts a failure that names the backup folder (a timestamp that changes on every run) as the same failure', async () => {
      await upgrader();
      // The backup directory exists but cannot be written to: the failure is in the timestamped folder inside it, whose name is in the message.
      await mkdir(mcpkit('skill-backups'));
      await chmod(mcpkit('skill-backups'), 0o555);
      try {
        const first = await reconcile('full', { now: NOW, env: NO_ENV });
        expect(first.notices.length).toBeGreaterThan(0);
        const folderOf = (report: ReconcileReport): string | undefined => /\/skill-backups\/(\d{14})'/.exec(report.notices.join('\n'))?.[1];
        expect(folderOf(first)).toMatch(/^\d{14}$/);
        expect(first.noticesSuppressed).toBeUndefined();

        const second = await reconcile('full', { now: at(1), env: NO_ENV });
        // The text of the notice is not the same (the folder it names is named after the time), and it is the same failure.
        expect(folderOf(second)).toMatch(/^\d{14}$/);
        expect(folderOf(second)).not.toBe(folderOf(first));
        expect(second.noticesSuppressed).toBe(true);
        expect(formatNotices(second)).toEqual([]);

        const nextDay = await reconcile('full', { now: at(25), env: NO_ENV });
        expect(nextDay.noticesSuppressed).toBeUndefined();
        expect(formatNotices(nextDay).join('\n')).toContain('could not back up');
      } finally {
        await chmod(mcpkit('skill-backups'), 0o755);
      }
    });

    it('prints a different failure at once, even within 24 hours of another one', async () => {
      await upgrader();
      await writeFile(mcpkit('skill-backups'), 'a file where the backup directory should be');
      const first = await reconcile('full', { now: NOW, env: NO_ENV });
      const key = loadState().state.lastNotice?.key;
      expect(first.noticesSuppressed).toBeUndefined();

      await rm(mcpkit('skill-backups'));
      backupControl.failFor.add('cursor');
      const other = await reconcile('full', { now: at(1), env: NO_ENV });

      expect(other.noticesSuppressed).toBeUndefined();
      expect(other.notices).toEqual(['could not back up the cursor per-server skills (disk full (simulated)); they were left as they are']);
      expect(formatNotices(other).join('\n')).toContain('disk full (simulated)');
      expect(loadState().state.lastNotice?.key).not.toBe(key);
      expect(loadState().state.lastNotice?.at).toBe(at(1).toISOString());
    });

    it('prints a notice that was last printed in the future (a clock that went back) and records it again', async () => {
      await upgrader();
      await writeFile(mcpkit('skill-backups'), 'a file where the backup directory should be');
      await reconcile('full', { now: at(5), env: NO_ENV });

      const report = await reconcile('full', { now: NOW, env: NO_ENV });

      expect(report.noticesSuppressed).toBeUndefined();
      expect(loadState().state.lastNotice?.at).toBe(NOW.toISOString());
    });

    it('keeps a successful adoption to one print: the notices of a run that did something are printed once and are not what is recorded', async () => {
      await upgrader();
      const first = await reconcile('full', { now: NOW, env: NO_ENV });
      expect(first.notices).toEqual([]);
      expect(formatNotices(first).length).toBeGreaterThan(0);
      expect(loadState().state.lastNotice).toBeUndefined();
    });

    it('does not mind a malformed record: it is treated as none and replaced', async () => {
      await upgrader();
      await writeFile(mcpkit('skill-backups'), 'a file where the backup directory should be');
      await writeFile(stateFilePath(), JSON.stringify({ version: 1, adopted: {}, hookDeclined: false, lastNotice: { key: 5 } }));

      const report = await reconcile('full', { now: NOW, env: NO_ENV });

      expect(report.noticesSuppressed).toBeUndefined();
      expect(loadState().usable).toBe(true);
      expect(loadState().state.lastNotice?.at).toBe(NOW.toISOString());
    });

    it('prints once through the commands: the second command in a day says nothing on stderr', async () => {
      await upgrader();
      await writeFile(mcpkit('skill-backups'), 'a file where the backup directory should be');
      const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

      await reconcileAfterChange();
      expect(err).toHaveBeenCalledTimes(1);
      expect(String(err.mock.calls[0][0])).toContain('could not back up');

      await reconcileAfterChange();
      await reconcileAfterChange();
      expect(err).toHaveBeenCalledTimes(1);
    });
  });

  describe('the lock', () => {
    it('never waits for a lock that is held: it returns busy at once and writes nothing', async () => {
      await upgrader();
      await mkdir(mcpkit('reconcile.lock'));
      const before = await stats(home);

      const started = performance.now();
      const report = await reconcile('full', { now: NOW, env: NO_ENV });

      expect(report.skipped).toBe('busy');
      expect(performance.now() - started).toBeLessThan(1000);
      expect(await stats(home)).toEqual(before);
    });

    it('breaks a lock that is stale (the holder died), runs, and leaves no lock behind', async () => {
      await upgrader();
      await mkdir(mcpkit('reconcile.lock'));
      const old = new Date(Date.now() - 120_000);
      await utimes(mcpkit('reconcile.lock'), old, old);

      const report = await reconcile('full', { now: NOW, env: NO_ENV });

      expect(report.skipped).toBeUndefined();
      expect(report.actions.filter((action) => action.type === 'adopted')).toHaveLength(2);
      expect(await readdir(mcpkit())).not.toContain('reconcile.lock');
    });

    it('leaves no lock behind after an ordinary run', async () => {
      await upgrader();
      await reconcile('full', { now: NOW, env: NO_ENV });
      expect(await readdir(mcpkit())).not.toContain('reconcile.lock');
    });
  });

  describe('a home it cannot work in', () => {
    it('does nothing when ~/.mcpkit is a file, not a directory', async () => {
      await writeFile(mcpkit(), 'not a directory');
      await mkdir(join(home, '.cursor', 'skills'), { recursive: true });
      const before = await stats(home);

      const report = await reconcile('full', { now: NOW, env: NO_ENV });

      expect(report.skipped).toContain('not a directory');
      expect(await stats(home)).toEqual(before);
    });

    it.skipIf(process.getuid?.() === 0)('does nothing, and does not fail, when the lock cannot be created (a read-only ~/.mcpkit)', async () => {
      await upgrader();
      await chmod(mcpkit(), 0o555);
      try {
        const before = await stats(home);
        const report = await reconcile('full', { now: NOW, env: NO_ENV });
        expect(report.skipped).toContain('the lock cannot be taken');
        expect(await stats(home)).toEqual(before);
      } finally {
        await chmod(mcpkit(), 0o755);
      }
    });
  });

  describe('speed', () => {
    it('the fast path with 13 servers reads no cache and finishes in a few milliseconds (bound: 250 ms)', async () => {
      const servers = Array.from({ length: 13 }, (_, index) => `server${index}`);
      await writeRegistry(servers, ['claude-code', 'cursor']);
      for (const name of servers) {
        await writeCache(name);
        await writeGeneratedSkill('cursor', name);
      }
      await reconcile('full', { now: NOW, env: NO_ENV });
      const reads = cacheReads.count;
      expect(reads).toBeGreaterThan(0);

      const second = await reconcile('full', { now: NOW, env: NO_ENV });

      expect(second.fast).toBe(true);
      expect(second.ms).toBeLessThan(250);
      expect(cacheReads.count).toBe(reads);
    });
  });

  describe('which agents it looks at', () => {
    it('never creates a directory for an agent that has no registered server, no guide and no generated skill', async () => {
      await writeRegistry(['a'], ['cursor']);
      await writeCache('a');
      await mkdir(join(home, '.cursor'));

      await reconcile('full', { now: NOW, env: NO_ENV });

      expect(await names(home)).toEqual(['.cursor', '.mcpkit']);
    });

    it('writes the guide of an agent that was enabled after the server was installed, with that server in it (the guide follows the rule that places the skills)', async () => {
      // The server was installed when only Claude Code was enabled: its stored list says so, its mode says "follow the defaults".
      await mkdir(mcpkit(), { recursive: true });
      const followsDefaults = { ...entry('later', ['claude-code']), agentSelectionMode: 'defaults' };
      const pinned = entry('pinned', ['claude-code']);
      await writeFile(mcpkit('servers.yaml'), stringify({ version: 1, servers: { later: followsDefaults, pinned } }), 'utf-8');
      await writeFile(mcpkit('settings.yaml'), stringify({ version: 1, enabledAgents: ['claude-code', 'cursor'], updatedAt: '2026-01-01T00:00:00.000Z' }), 'utf-8');
      await writeCache('later');
      await writeCache('pinned');
      await mkdir(join(home, '.claude'));
      await mkdir(join(home, '.cursor'));

      const report = await reconcile('full', { now: NOW, env: NO_ENV });

      expect(report.failed).toBeUndefined();
      const cursor = await readFile(guidePath('cursor'), 'utf-8');
      expect(cursor).toContain('- later (1 tool, 0 read-only)');
      expect(cursor).not.toContain('pinned');
      const claude = await readFile(guidePath('claude-code'), 'utf-8');
      expect(claude).toContain('- later (1 tool, 0 read-only)');
      expect(claude).toContain('- pinned (1 tool, 0 read-only)');
    });

    it('looks at an agent that only has a guide or only has generated skills, not just those a server is installed for', async () => {
      await writeRegistry(['a'], ['cursor']);
      await writeCache('a');
      // Cursor is installed (and a server is for it); Codex has only a guide, Windsurf only a generated skill.
      await mkdir(join(home, '.cursor'));
      await mkdir(join(skillsOf('codex'), 'mcpkit-cli'), { recursive: true });
      await writeFile(guidePath('codex'), buildMetaSkillContent(), 'utf-8');
      await writeGeneratedSkill('windsurf', 'a');

      const report = await reconcile('full', { now: NOW, env: NO_ENV });

      expect(report.actions.filter((action) => action.type === 'adopted').map((action) => (action as { agent: string }).agent).sort()).toEqual(['codex', 'cursor', 'windsurf']);
      // The guide of an agent no server is installed for lists no server.
      expect(await readFile(guidePath('codex'), 'utf-8')).not.toContain('(live list)');
    });
  });

  describe('the guide comes first: an agent whose guide cannot be written is left exactly as it is', () => {
    const asRoot = process.getuid?.() === 0;
    const HOUR = 3_600_000;
    const GUIDE_FAILURE = /^(\S+): could not write the mcpkit-cli guide \((.+)\); left the per-server skills in place\.$/;

    /** An upgrader whose `agent` has no guide yet, and a skills directory nobody can write to. */
    async function withUnwritableSkills(agent: 'claude-code' | 'cursor'): Promise<string[]> {
      await upgrader();
      await rm(join(skillsOf(agent), 'mcpkit-cli'), { recursive: true });
      const before = await stats(skillsOf(agent));
      await chmod(skillsOf(agent), 0o500);
      return before;
    }

    it.skipIf(asRoot)('keeps the skills of an agent whose skills directory is read-only: no backup, no removal, no record, one notice; the other agents are moved', async () => {
      const before = await withUnwritableSkills('cursor');
      try {
        const report = await reconcile('full', { now: NOW, env: NO_ENV });

        expect(report.failed).toBeUndefined();
        expect(report.notices).toHaveLength(1);
        expect(GUIDE_FAILURE.exec(report.notices[0])?.[1]).toBe('cursor');
        expect(report.notices[0]).toContain('EACCES');
        expect(formatNotices(report)).toContain(`  ${report.notices[0]}`);
        expect(await stats(skillsOf('cursor'))).toEqual(before);
        expect(report.actions.some((action) => action.type === 'adopted' && action.agent === 'cursor')).toBe(false);

        const { state } = loadState();
        expect(Object.keys(state.adopted)).toEqual(['claude-code']);
        expect(state.fingerprint).toBeUndefined();
        expect(state.guideFiles).toBeUndefined();
        // The one backup of the run holds Claude Code's skills only.
        expect(await backups()).toHaveLength(1);
        expect(await names(mcpkit('skill-backups', (await backups())[0]))).toEqual(['claude-code']);
        expect(await names(skillsOf('claude-code'))).toEqual(['mcpkit-c', 'mcpkit-cli', 'mcpkit-d', 'mcpkit-notes']);
      } finally {
        await chmod(skillsOf('cursor'), 0o755);
      }

      // Once the directory can be written to, the next run does what it did not do.
      const retry = await reconcile('full', { now: new Date(NOW.getTime() + HOUR), env: NO_ENV });
      expect(retry.actions).toContainEqual(expect.objectContaining({ type: 'adopted', agent: 'cursor', removed: 2 }));
      expect(await names(skillsOf('cursor'))).toEqual(['mcpkit-c', 'mcpkit-cli', 'mcpkit-d', 'mcpkit-notes']);
    });

    it.skipIf(asRoot)('adds no hook, and makes no settings file, when the guide of Claude Code cannot be written', async () => {
      const before = await withUnwritableSkills('claude-code');
      try {
        const report = await reconcile('full', { now: NOW, env: NO_ENV });

        expect(GUIDE_FAILURE.exec(report.notices[0])?.[1]).toBe('claude-code');
        expect(report.actions.some((action) => action.type === 'hook-added')).toBe(false);
        await expect(stat(claudeSettings())).rejects.toThrow();
        expect((await names(join(home, '.claude'))).filter((name) => name.includes('.mcpkit-bak-'))).toEqual([]);
        expect(await stats(skillsOf('claude-code'))).toEqual(before);
        const { state } = loadState();
        expect(Object.keys(state.adopted)).toEqual(['cursor']);
        expect(await names(mcpkit('skill-backups', (await backups())[0]))).toEqual(['cursor']);
      } finally {
        await chmod(skillsOf('claude-code'), 0o755);
      }
    });

    it('keeps the skills of an agent whose guide path is a regular file', async () => {
      await upgrader();
      await rm(join(skillsOf('cursor'), 'mcpkit-cli'), { recursive: true });
      await writeFile(join(skillsOf('cursor'), 'mcpkit-cli'), 'a file where the guide directory should be');
      const before = await stats(skillsOf('cursor'));

      const report = await reconcile('full', { now: NOW, env: NO_ENV });

      expect(GUIDE_FAILURE.exec(report.notices[0])?.[1]).toBe('cursor');
      expect(await stats(skillsOf('cursor'))).toEqual(before);
      expect(await readFile(join(skillsOf('cursor'), 'mcpkit-cli'), 'utf-8')).toBe('a file where the guide directory should be');
      expect(loadState().state.adopted.cursor).toBeUndefined();
      expect(loadState().state.fingerprint).toBeUndefined();
      expect(loadState().state.adopted['claude-code']).toBeDefined();
    });

    it.skipIf(asRoot)('also says so on a refresh run (call, exec): the guide failure is no longer silent, and no pass is remembered', async () => {
      await upgrader();
      await chmod(join(skillsOf('cursor'), 'mcpkit-cli'), 0o500);
      try {
        const report = await reconcile('refresh', { now: NOW, env: NO_ENV });

        expect(GUIDE_FAILURE.exec(report.notices[0])?.[1]).toBe('cursor');
        expect(report.actions).toEqual([{ type: 'guide-written', agent: 'claude-code' }]);
        expect(loadState().state.refreshFingerprint).toBeUndefined();
        expect(loadState().state.adopted).toEqual({});
      } finally {
        await chmod(join(skillsOf('cursor'), 'mcpkit-cli'), 0o755);
      }
    });

    it.skipIf(asRoot)('prints the same failure once a day, although the temp file of the failed write is named after the process and a random number', async () => {
      await upgrader();
      // The old guide is there and is stale; replacing it needs a temp file in a directory nobody can write to.
      await chmod(join(skillsOf('cursor'), 'mcpkit-cli'), 0o500);
      try {
        const first = await reconcile('full', { now: NOW, env: NO_ENV });
        expect(GUIDE_FAILURE.exec(first.notices[0])?.[1]).toBe('cursor');
        expect(first.notices[0]).not.toMatch(/\.tmp/);
        expect(first.noticesSuppressed).toBeUndefined();
        expect(formatNotices(first).join('\n')).toContain('could not write the mcpkit-cli guide');

        const second = await reconcile('full', { now: new Date(NOW.getTime() + HOUR), env: NO_ENV });
        expect(second.notices).toEqual(first.notices);
        expect(second.noticesSuppressed).toBe(true);
        expect(formatNotices(second)).toEqual([]);

        const nextDay = await reconcile('full', { now: new Date(NOW.getTime() + 25 * HOUR), env: NO_ENV });
        expect(nextDay.noticesSuppressed).toBeUndefined();
        expect(formatNotices(nextDay).join('\n')).toContain('could not write the mcpkit-cli guide');
      } finally {
        await chmod(join(skillsOf('cursor'), 'mcpkit-cli'), 0o755);
      }
    });
  });

  describe('which agents it creates anything for (phantom agent folders)', () => {
    it('creates nothing for one registered server that names all seven agents on a home with none of them', async () => {
      await writeRegistry(['a'], [...ALL_AGENTS]);
      await writeCache('a');
      const before = await stats(home);

      const report = await reconcile('full', { now: NOW, env: NO_ENV });

      expect(report.skipped).toBe('there is no agent to reconcile');
      expect(await stats(home)).toEqual(before);
      expect(await names(home)).toEqual(['.mcpkit']);
      expect(await names(mcpkit())).toEqual(['schemas', 'servers.yaml']);
      await expect(stat(claudeSettings())).rejects.toThrow();
    });

    it.each(['full', 'refresh'] as const)('handles only the installed agent (~/.cursor) of a server that names all seven, on a %s run: its guide, its record, no other folder, no settings.json', async (kind) => {
      await writeRegistry(['a'], [...ALL_AGENTS]);
      await writeCache('a');
      await mkdir(join(home, '.cursor'));

      const report = await reconcile(kind, { now: NOW, env: NO_ENV });

      expect(await names(home)).toEqual(['.cursor', '.mcpkit']);
      expect(await names(join(home, '.cursor'))).toEqual(['skills']);
      expect(await names(skillsOf('cursor'))).toEqual(['mcpkit-cli']);
      expect(report.actions.filter((action) => action.type !== 'guide-written' || action.agent !== 'cursor').map((action) => action.type)).toEqual(kind === 'full' ? ['adopted'] : []);
      expect(Object.keys(loadState().state.adopted)).toEqual(kind === 'full' ? ['cursor'] : []);
      await expect(stat(claudeSettings())).rejects.toThrow();
    });

    it('does not take a project folder of the working directory for an installed agent', async () => {
      const project = await mkdtemp(join(tmpdir(), 'mcpkit-reconcile-project-'));
      try {
        await mkdir(join(project, '.cursor'));
        vi.spyOn(process, 'cwd').mockReturnValue(project);
        await writeRegistry(['a'], ['cursor']);
        await writeCache('a');

        const report = await reconcile('full', { now: NOW, env: NO_ENV });

        expect(report.skipped).toBe('there is no agent to reconcile');
        expect(await names(home)).toEqual(['.mcpkit']);
      } finally {
        await rm(project, { recursive: true, force: true });
      }
    });

    it('picks up an agent that is installed after a pass (the installed agents are part of what the fast path checks)', async () => {
      await writeRegistry(['a'], ['claude-code', 'cursor']);
      await writeCache('a');
      await mkdir(join(home, '.claude'));
      await reconcile('full', { now: NOW, env: NO_ENV });
      expect((await reconcile('full', { now: NOW, env: NO_ENV })).fast).toBe(true);
      await expect(stat(guidePath('cursor'))).rejects.toThrow();

      await mkdir(join(home, '.cursor'));
      const report = await reconcile('full', { now: NOW, env: NO_ENV });

      expect(report.fast).toBeUndefined();
      expect(await readFile(guidePath('cursor'), 'utf-8')).toContain('- a');
    });
  });

  describe('the refresh run (call, exec) remembers its pass', () => {
    const AGENTS = ['claude-code', 'cursor', 'codex'] as const;
    const SERVERS = Array.from({ length: 13 }, (_, index) => `server${index}`);

    /** A cache of about 60 KB: 60 tools with a description and four documented parameters each. */
    async function writeBigCache(name: string): Promise<void> {
      await mkdir(mcpkit('schemas'), { recursive: true });
      const tools = Array.from({ length: 60 }, (_, index) => ({
        name: `tool_${index}`,
        description: `Tool ${index} of ${name}. ${'It does a documented thing with many words. '.repeat(8)}`,
        inputSchema: {
          type: 'object',
          properties: Object.fromEntries(Array.from({ length: 4 }, (_, p) => [`p${p}`, { type: 'string', description: 'a parameter description '.repeat(4) }])),
        },
      }));
      await writeFile(schemaCachePath(name), JSON.stringify({ version: 1, server: name, fetchedAt: '2026-01-01T00:00:00.000Z', tools }), 'utf-8');
    }

    /** 13 servers with 60 KB caches, installed for three agents, each with a generated skill per server. */
    async function manyServers(): Promise<void> {
      await writeRegistry(SERVERS, [...AGENTS]);
      for (const name of SERVERS) await writeBigCache(name);
      for (const agent of AGENTS) for (const name of SERVERS) await writeGeneratedSkill(agent, name);
    }

    it('reads each schema cache once in a pass, whatever the number of agents (a refresh pass and a full one)', async () => {
      await manyServers();

      const refresh = await reconcile('refresh', { now: NOW, env: NO_ENV });
      expect(refresh.actions.filter((action) => action.type === 'guide-written')).toHaveLength(3);
      expect(cacheReads.count).toBe(SERVERS.length);

      cacheReads.count = 0;
      const full = await reconcile('full', { now: NOW, env: NO_ENV });
      expect(full.actions.filter((action) => action.type === 'adopted')).toHaveLength(3);
      expect(cacheReads.count).toBe(SERVERS.length);
    });

    it('takes the fast path on the second call: no cache is read, and it is much faster than the first (13 servers x 60 KB x 3 agents)', async () => {
      await manyServers();
      const first = await reconcile('refresh', { now: NOW, env: NO_ENV });
      expect(first.fast).toBeUndefined();
      expect(typeof loadState().state.refreshFingerprint).toBe('string');
      expect(loadState().state.fingerprint).toBeUndefined();
      cacheReads.count = 0;

      const second = await reconcile('refresh', { now: NOW, env: NO_ENV });

      expect(second.fast).toBe(true);
      expect(second.actions).toEqual([]);
      expect(cacheReads.count).toBe(0);
      // Generous: the first pass reads 760 KB of caches and writes three guides, the second only stats files.
      expect(second.ms).toBeLessThan(first.ms / 2);
      expect(second.ms).toBeLessThan(100);
    });

    it('does not take a refresh pass for a full one: the next full run still adopts every agent', async () => {
      await manyServers();
      await reconcile('refresh', { now: NOW, env: NO_ENV });

      const full = await reconcile('full', { now: NOW, env: NO_ENV });

      expect(full.fast).toBeUndefined();
      expect(full.actions.filter((action) => action.type === 'adopted')).toHaveLength(3);
    });

    it('takes a full pass for a refresh pass: a call after the full run is fast, with no cache read', async () => {
      await manyServers();
      await reconcile('full', { now: NOW, env: NO_ENV });
      cacheReads.count = 0;

      const call = await reconcile('refresh', { now: NOW, env: NO_ENV });

      expect(call.fast).toBe(true);
      expect(cacheReads.count).toBe(0);
    });

    it('goes through the whole pass again when a guide was removed, a cache changed or the registry changed', async () => {
      await manyServers();
      await reconcile('refresh', { now: NOW, env: NO_ENV });

      await rm(guidePath('codex'));
      const afterGuide = await reconcile('refresh', { now: NOW, env: NO_ENV });
      expect(afterGuide.fast).toBeUndefined();
      expect(afterGuide.actions).toContainEqual({ type: 'guide-written', agent: 'codex' });
      expect((await reconcile('refresh', { now: NOW, env: NO_ENV })).fast).toBe(true);

      await writeBigCache('server3');
      expect((await reconcile('refresh', { now: NOW, env: NO_ENV })).fast).toBeUndefined();
      expect((await reconcile('refresh', { now: NOW, env: NO_ENV })).fast).toBe(true);

      await writeRegistry([...SERVERS, 'extra'], [...AGENTS]);
      const afterRegistry = await reconcile('refresh', { now: NOW, env: NO_ENV });
      expect(afterRegistry.fast).toBeUndefined();
      expect(await readFile(guidePath('cursor'), 'utf-8')).toContain('- extra');
    });
  });

  describe('the SessionStart hook of Claude Code is not lost, and is tried again when its settings file changes', () => {
    const WITH_COMMENTS = '{\n  // my model\n  "model": "opus"\n}\n';
    const HOOK_NOTICE = /^could not add the hook: .+\. Fix the file, then run: mcpkit hook install --write$/;

    it('adopts, says once that the hook did not go in, leaves the file alone, and installs the hook after the file is fixed', async () => {
      await upgrader();
      await writeFile(claudeSettings(), WITH_COMMENTS);

      const first = await reconcile('full', { now: NOW, env: NO_ENV });

      expect(first.notices).toHaveLength(1);
      expect(first.notices[0]).toMatch(HOOK_NOTICE);
      expect(first.notices[0]).toContain(`${claudeSettings()} was left as it is`);
      expect(await readFile(claudeSettings(), 'utf-8')).toBe(WITH_COMMENTS);
      expect(await names(skillsOf('claude-code'))).toEqual(['mcpkit-c', 'mcpkit-cli', 'mcpkit-d', 'mcpkit-notes']);
      const info = await stat(claudeSettings());
      expect(loadState().state.adopted['claude-code']).toMatchObject({ removed: 2, hookPending: true, hookTried: `${info.mtimeMs}:${info.size}` });
      expect(loadState().state.adopted.cursor).not.toHaveProperty('hookPending');

      // The same file: the next run is the fast path, which neither reads nor parses it, and says nothing.
      const same = await reconcile('full', { now: new Date(NOW.getTime() + 60_000), env: NO_ENV });
      expect(same.fast).toBe(true);
      expect(same.notices).toEqual([]);
      expect(await readFile(claudeSettings(), 'utf-8')).toBe(WITH_COMMENTS);

      // Fixed by the user: the next full run adds the hook and says so in one line.
      await writeFile(claudeSettings(), `${JSON.stringify({ model: 'opus', theme: 'dark' }, null, 2)}\n`);
      const fixed = await reconcile('full', { now: new Date(NOW.getTime() + 120_000), env: NO_ENV });

      expect(fixed.actions).toEqual([{ type: 'hook-added', agent: 'claude-code', path: claudeSettings(), retried: true }]);
      expect(fixed.notices).toEqual([]);
      expect(formatNotices(fixed)).toEqual(['mcpkit: added the SessionStart hook for claude-code (undo: mcpkit hook uninstall --write).']);
      expect(JSON.parse(await readFile(claudeSettings(), 'utf-8'))).toEqual({ model: 'opus', theme: 'dark', hooks: { SessionStart: [ours] } });
      expect(loadState().state.adopted['claude-code']).not.toHaveProperty('hookPending');
      expect(loadState().state.adopted['claude-code']).not.toHaveProperty('hookTried');
      expect((await reconcile('full', { now: NOW, env: NO_ENV })).fast).toBe(true);
    });

    it('leaves a settings file with an integer beyond 2^53 byte for byte as it is, says to add the entry by hand, and settles the hook once the user has', async () => {
      await upgrader();
      const BIG = '{\n  "id": 12345678901234567890,\n  "model": "opus"\n}\n';
      await writeFile(claudeSettings(), BIG);

      const first = await reconcile('full', { now: NOW, env: NO_ENV });

      expect(await readFile(claudeSettings(), 'utf-8')).toBe(BIG);
      expect((await names(join(home, '.claude'))).filter((name) => name.includes('.mcpkit-bak-'))).toEqual([]);
      expect(first.actions.some((action) => action.type === 'hook-added')).toBe(false);
      expect(first.notices).toHaveLength(1);
      expect(first.notices[0]).toMatch(/^could not add the hook: the settings file has the integer 12345678901234567890, /);
      expect(first.notices[0]).toContain('by hand: `mcpkit hook install` (without --write) prints it');
      expect(first.notices[0]).toContain(`${claudeSettings()} was left as it is`);
      // Editing the file and running the command again would not help here, so the notice does not say so.
      expect(first.notices[0]).not.toContain('Fix the file');
      expect(await names(skillsOf('claude-code'))).toEqual(['mcpkit-c', 'mcpkit-cli', 'mcpkit-d', 'mcpkit-notes']);
      const info = await stat(claudeSettings());
      expect(loadState().state.adopted['claude-code']).toMatchObject({ removed: 2, hookPending: true, hookTried: `${info.mtimeMs}:${info.size}` });

      // The same file: nothing is read again, nothing is said again.
      const same = await reconcile('full', { now: new Date(NOW.getTime() + 60_000), env: NO_ENV });
      expect(same.fast).toBe(true);
      expect(same.notices).toEqual([]);

      // The user adds the entry by hand, keeping the number: the file changed, the hook is found, nothing is written, the retry is settled.
      const byHand = `{\n  "id": 12345678901234567890,\n  "hooks": {\n    "SessionStart": [${JSON.stringify(ours)}]\n  }\n}\n`;
      await writeFile(claudeSettings(), byHand);
      const settled = await reconcile('full', { now: new Date(NOW.getTime() + 120_000), env: NO_ENV });

      expect(settled.actions.some((action) => action.type === 'hook-added')).toBe(false);
      expect(settled.notices).toEqual([]);
      expect(await readFile(claudeSettings(), 'utf-8')).toBe(byHand);
      expect(loadState().state.adopted['claude-code']).not.toHaveProperty('hookPending');
    });

    it('adds the hook to a settings file that has CRLF line endings without turning them into LF', async () => {
      await upgrader();
      const original = `${JSON.stringify({ model: 'opus' }, null, 2)}\n`.replace(/\n/g, '\r\n');
      await writeFile(claudeSettings(), original);

      const report = await reconcile('full', { now: NOW, env: NO_ENV });

      expect(report.notices).toEqual([]);
      const written = await readFile(claudeSettings(), 'utf-8');
      expect(written).not.toMatch(/[^\r]\n/);
      expect(JSON.parse(written)).toEqual({ model: 'opus', hooks: { SessionStart: [ours] } });
      const [backup] = (await names(join(home, '.claude'))).filter((name) => name.includes('.mcpkit-bak-'));
      expect(await readFile(join(home, '.claude', backup), 'utf-8')).toBe(original);
    });

    it('does not try the hook again in a full run that has other work to do, while the settings file is as the failed attempt saw it', async () => {
      await upgrader();
      await writeFile(claudeSettings(), WITH_COMMENTS);
      await reconcile('full', { now: NOW, env: NO_ENV });
      // Other work: a cache appears, so the whole pass runs; the unchanged invalid file is not looked at again.
      await writeCache('c');

      const report = await reconcile('full', { now: new Date(NOW.getTime() + 3_600_000), env: NO_ENV });

      expect(report.fast).toBeUndefined();
      expect(report.actions.some((action) => action.type === 'deferred-removed')).toBe(true);
      expect(report.notices).toEqual([]);
      expect(loadState().state.adopted['claude-code']).toMatchObject({ hookPending: true });
    });

    it('installs the hook on the next run after a run that stopped once the adoption was written and before the hook step', async () => {
      await upgrader();
      stateControl.crashAfterClaudeAdoption = true;

      const crashed = await reconcile('full', { now: NOW, env: NO_ENV });

      stateControl.crashAfterClaudeAdoption = false;
      expect(crashed.skipped ?? crashed.failed).toContain('killed (simulated)');
      await expect(stat(claudeSettings())).rejects.toThrow();
      expect(loadState().state.adopted['claude-code']).toMatchObject({ removed: 2, hookPending: true });
      expect(loadState().state.fingerprint).toBeUndefined();

      const next = await reconcile('full', { now: new Date(NOW.getTime() + 60_000), env: NO_ENV });

      expect(next.actions).toContainEqual({ type: 'hook-added', agent: 'claude-code', path: claudeSettings(), retried: true });
      expect(JSON.parse(await readFile(claudeSettings(), 'utf-8'))).toEqual({ hooks: { SessionStart: [ours] } });
      expect(loadState().state.adopted['claude-code']).not.toHaveProperty('hookPending');
      // The adoption was not done twice.
      expect(loadState().state.adopted['claude-code']).toMatchObject({ at: NOW.toISOString(), removed: 2 });
    });

    it.skipIf(process.getuid?.() === 0)('counts a hook failure that names the temp file of the atomic write (a name that differs on every run) as the same failure: printed once a day', async () => {
      await upgrader();
      // No settings file, and a folder nobody can add one to: the temp file of the write is what fails.
      await chmod(join(home, '.claude'), 0o500);
      try {
        const first = await reconcile('full', { now: NOW, env: NO_ENV });
        expect(first.notices).toHaveLength(1);
        expect(first.notices[0]).toMatch(HOOK_NOTICE);
        expect(first.notices[0]).toMatch(/settings\.json\.\d+\.[0-9a-f]{8}\.tmp/);
        expect(first.noticesSuppressed).toBeUndefined();

        // Forget the attempt (as a settings file that changed would), so that the hook is tried again, with another temp file.
        const record = JSON.parse(await readFile(stateFilePath(), 'utf-8')) as { adopted: Record<string, Record<string, unknown>> };
        delete record.adopted['claude-code'].hookTried;
        await writeFile(stateFilePath(), JSON.stringify(record));
        const second = await reconcile('full', { now: new Date(NOW.getTime() + 3_600_000), env: NO_ENV });

        expect(second.notices).toHaveLength(1);
        expect(second.notices[0]).toMatch(/settings\.json\.\d+\.[0-9a-f]{8}\.tmp/);
        expect(second.notices[0]).not.toBe(first.notices[0]);
        expect(second.noticesSuppressed).toBe(true);
        expect(formatNotices(second)).toEqual([]);
      } finally {
        await chmod(join(home, '.claude'), 0o755);
      }
    });

    it('clears the pending hook when the hook is there already, without touching the file', async () => {
      await upgrader();
      const text = `${JSON.stringify({ hooks: { SessionStart: [ours] } }, null, 2)}\n`;
      await writeFile(claudeSettings(), text);
      await writeFile(stateFilePath(), JSON.stringify({ version: 1, adopted: {}, hookDeclined: false }));

      await reconcile('full', { now: NOW, env: NO_ENV });

      expect(await readFile(claudeSettings(), 'utf-8')).toBe(text);
      expect(loadState().state.adopted['claude-code']).not.toHaveProperty('hookPending');
    });

    it('does not mark a hook as pending for a user who declined it', async () => {
      await upgrader();
      await writeFile(stateFilePath(), JSON.stringify({ version: 1, adopted: {}, hookDeclined: true }));

      await reconcile('full', { now: NOW, env: NO_ENV });

      expect(loadState().state.adopted['claude-code']).not.toHaveProperty('hookPending');
      await expect(stat(claudeSettings())).rejects.toThrow();
    });
  });

  describe('MCPKIT_SKILLS: only a valid value is a choice', () => {
    it.each(['lean', 'banana', 'on', 'true', '1'])('an invalid value (%s) is ignored, as `mcpkit config` ignores it: the step runs', async (value) => {
      await upgrader();

      const report = await reconcile('full', { now: NOW, env: { MCPKIT_SKILLS: value } });

      expect(report.skipped).toBeUndefined();
      expect(report.actions.filter((action) => action.type === 'adopted')).toHaveLength(2);
      expect(await names(skillsOf('cursor'))).toEqual(['mcpkit-c', 'mcpkit-cli', 'mcpkit-d', 'mcpkit-notes']);
    });

    it.each(['guide', 'per-server', 'GUIDE', ' Per-Server '])('a valid value (%j) is an explicit choice for the run: nothing is done', async (value) => {
      await upgrader();
      const before = await stats(home);

      const report = await reconcile('full', { now: NOW, env: { MCPKIT_SKILLS: value } });

      expect(report.skipped).toBe('MCPKIT_SKILLS is set');
      expect(await stats(home)).toEqual(before);
    });

    it('MCPKIT_NO_MIGRATE stays an unconditional opt-out, next to an invalid MCPKIT_SKILLS', async () => {
      await upgrader();
      const before = await stats(home);

      const report = await reconcile('full', { now: NOW, env: { MCPKIT_SKILLS: 'lean', MCPKIT_NO_MIGRATE: '1' } });

      expect(report.skipped).toBe('MCPKIT_NO_MIGRATE is set');
      expect(await stats(home)).toEqual(before);
    });
  });

  describe('after a change (install, sync, update, remove)', () => {
    it('gives a first-time user the guide and the hook, with no per-server skill, and tells them on stderr', async () => {
      await writeRegistry(['a'], ['claude-code']);
      await writeCache('a');
      // Claude Code is installed: its folder is there.
      await mkdir(join(home, '.claude'));
      const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

      await reconcileAfterChange();

      expect(out).not.toHaveBeenCalled();
      expect(err).toHaveBeenCalledTimes(1);
      expect(String(err.mock.calls[0][0])).toBe([
        'mcpkit: skills are now lean by default: one mcpkit-cli guide with a live server list instead of one skill per server.',
        '  claude-code: added the SessionStart hook (undo: mcpkit hook uninstall --write).',
        '  Prefer one skill per server? mcpkit config lean off   (or set MCPKIT_SKILLS=per-server)',
        '',
      ].join('\n'));

      expect(await readFile(guidePath('claude-code'), 'utf-8')).toContain('- a');
      expect(JSON.parse(await readFile(claudeSettings(), 'utf-8'))).toEqual({ hooks: { SessionStart: [ours] } });
      expect(await names(skillsOf('claude-code'))).toEqual(['mcpkit-cli']);
    });

    it('never throws', async () => {
      process.env.HOME = join(home, 'does', 'not', 'exist');
      await expect(reconcileAfterChange()).resolves.toBeUndefined();
    });
  });
});

describe('formatNotices', () => {
  const report = (overrides: Partial<ReconcileReport>): ReconcileReport => ({ notices: [], actions: [], ms: 0, ...overrides });

  it('sums the skills removed for indexed servers into one line, and names a backup directory once (or each, when the run made several)', () => {
    expect(formatNotices(report({
      actions: [
        { type: 'deferred-removed', agent: 'cursor', removed: 2, backup: '/b' },
        { type: 'deferred-removed', agent: 'codex', removed: 1, backup: '/b' },
      ],
    }))).toEqual(['mcpkit: removed 3 per-server skills for servers that are now indexed (backup: /b).']);
    expect(formatNotices(report({
      actions: [
        { type: 'deferred-removed', agent: 'cursor', removed: 1, backup: '/b1' },
        { type: 'deferred-removed', agent: 'codex', removed: 1, backup: '/b2' },
      ],
    }))).toEqual(['mcpkit: removed 2 per-server skills for servers that are now indexed (backup: /b1, /b2).']);
  });

  it('says nothing for a pass that only freshened a guide, or did nothing', () => {
    expect(formatNotices(report({}))).toEqual([]);
    expect(formatNotices(report({ actions: [{ type: 'guide-written', agent: 'cursor' }] }))).toEqual([]);
    expect(formatNotices(report({ actions: [{ type: 'adopted', agent: 'cursor', removed: 0, backup: null, deferred: [] }] }))).toEqual([]);
  });

  it('omits the "moved" line when nothing was moved, and uses the singular for one skill', () => {
    const lines = formatNotices(report({
      actions: [
        { type: 'adopted', agent: 'cursor', removed: 0, backup: null, deferred: ['x'] },
        { type: 'adopted', agent: 'codex', removed: 1, backup: '/b', deferred: [] },
      ],
    }));
    expect(lines).toEqual([
      'mcpkit: skills are now lean by default: one mcpkit-cli guide with a live server list instead of one skill per server.',
      '  codex: moved 1 per-server skill to /b (copy a folder back to restore one).',
      '  1 skill kept for servers whose tools are not indexed yet; they are removed automatically after you run: mcpkit update',
      '  Prefer one skill per server? mcpkit config lean off   (or set MCPKIT_SKILLS=per-server)',
    ]);
  });
});

describe('printNotices', () => {
  const adoption: ReconcileReport = {
    notices: [],
    actions: [{ type: 'adopted', agent: 'cursor', removed: 1, backup: '/b', deferred: [] }],
    ms: 0,
  };
  const listeners = (): number => process.stderr.listenerCount('error');
  const afterTicks = async (): Promise<void> => {
    for (let round = 0; round < 3; round++) await new Promise<void>((done) => setImmediate(done));
  };

  // The test runner may keep a listener of its own on stderr; with it there, a missing handler would go unnoticed.
  let others: Array<(...args: unknown[]) => void> = [];
  beforeEach(() => {
    others = process.stderr.listeners('error') as Array<(...args: unknown[]) => void>;
    process.stderr.removeAllListeners('error');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.stderr.removeAllListeners('error');
    for (const listener of others) process.stderr.on('error', listener);
  });

  it('writes the lines to stderr, and leaves no error listener on it', async () => {
    const before = listeners();
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    printNotices(adoption);
    await afterTicks();

    expect(write).toHaveBeenCalledTimes(1);
    expect(String(write.mock.calls[0][0])).toBe([
      'mcpkit: skills are now lean by default: one mcpkit-cli guide with a live server list instead of one skill per server.',
      '  cursor: moved 1 per-server skill to /b (copy a folder back to restore one).',
      '  Prefer one skill per server? mcpkit config lean off   (or set MCPKIT_SKILLS=per-server)',
      '',
    ].join('\n'));
    expect(listeners()).toBe(before);
  });

  it('writes nothing, and adds nothing, when there is nothing to say', async () => {
    const before = listeners();
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    printNotices({ notices: [], actions: [], ms: 0 });

    expect(write).not.toHaveBeenCalled();
    expect(listeners()).toBe(before);
  });

  it('leaves out the notices of a report that says they were printed already', () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    printNotices({ notices: ['could not back up'], noticesSuppressed: true, actions: [], ms: 0 });

    expect(write).not.toHaveBeenCalled();
  });

  it('survives a write that throws, and leaves no listener', () => {
    const before = listeners();
    vi.spyOn(process.stderr, 'write').mockImplementation(() => {
      throw new Error('write after end');
    });

    expect(() => printNotices(adoption)).not.toThrow();
    expect(listeners()).toBe(before);
  });

  it('lets an error that stderr reports after the write (a closed pipe) go by, and removes its handler with it', async () => {
    const before = listeners();
    expect(before).toBe(0);
    let thrown: unknown;
    vi.spyOn(process.stderr, 'write').mockImplementation(((_text: string, callback?: (err?: Error | null) => void) => {
      // What a stream does on a broken pipe: the callback first, the error event in the next tick.
      callback?.(new Error('write EPIPE'));
      process.nextTick(() => {
        try {
          process.stderr.emit('error', new Error('write EPIPE'));
        } catch (err) {
          thrown = err;
        }
      });
      return true;
    }) as typeof process.stderr.write);

    printNotices(adoption);
    await afterTicks();

    // An error with no listener is thrown by `emit`: that is what would end the command.
    expect(thrown).toBeUndefined();
    expect(listeners()).toBe(before);
  });

  it('would end the command on that error without the handler (the check above can fail)', () => {
    expect(() => process.stderr.emit('error', new Error('write EPIPE'))).toThrow('write EPIPE');
  });

  it('removes its handler even when the write reported an error and no event followed', async () => {
    const before = listeners();
    vi.spyOn(process.stderr, 'write').mockImplementation(((_text: string, callback?: (err?: Error | null) => void) => {
      callback?.(new Error('write after end'));
      return true;
    }) as typeof process.stderr.write);

    printNotices(adoption);
    await afterTicks();

    expect(listeners()).toBe(before);
  });
});
