import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { createRemoveCommand } from './commands/remove.js';
import { createSyncCommand } from './commands/sync.js';
import { createUpdateCommand } from './commands/update.js';
import { getGenerator } from './generators/index.js';
import { reconcileSkillFiles } from './skill-sync.js';
import { removeSkillDirectory, writeSkillFile } from './skill-file.js';
import { getRegistryPath, getServer } from './config.js';
import { discoverForEntry } from './discover.js';
import { ALL_AGENTS } from './types.js';
import type { AgentType, GeneratorContext, ToolInfo } from './types.js';

vi.mock('./discover.js', () => ({
  discoverForEntry: vi.fn(),
}));

const tools: ToolInfo[] = [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object' } }];

const HOSTILE_NAMES = ['..', 'x/../../../victim', 'a/b', 'a\\b', '.hidden', 'a\0b', 'a'.repeat(100), '', 'my server'];

function context(serverName: string, scope: 'global' | 'project' = 'global'): GeneratorContext {
  return { serverName, tools, transport: { type: 'stdio', command: 'node', args: [] }, scope };
}

/** Every path under `dir`, files and directories, with the content of each file. */
async function snapshot(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const lines = await Promise.all(entries.map(async (entry) => {
    const path = join(entry.parentPath, entry.name);
    return entry.isFile() ? `${path} ${await readFile(path, 'utf-8')}` : `${path}/`;
  }));
  return lines.sort();
}

describe('skill paths are always inside the agent skills directory', () => {
  const originalHome = process.env.HOME;
  const originalHermes = process.env.HERMES_HOME;
  let outer = '';
  let homeDir = '';

  beforeEach(async () => {
    outer = await mkdtemp(join(tmpdir(), 'mcpkit-skill-paths-'));
    homeDir = join(outer, 'home');
    await mkdir(homeDir);
    process.env.HOME = homeDir;
    delete process.env.HERMES_HOME;
    vi.mocked(discoverForEntry).mockResolvedValue({ tools, serverMeta: {} });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalHermes === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = originalHermes;
    await rm(outer, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  describe('generators', () => {
    const cases = ALL_AGENTS.flatMap((agent) => (['global', 'project'] as const).map((scope) => [agent, scope] as const));

    it.each(cases)('%s (%s scope) refuses every hostile server name', async (agent, scope) => {
      const generate = await getGenerator(agent);

      for (const name of HOSTILE_NAMES) {
        expect(() => generate(context(name, scope)), JSON.stringify(name)).toThrow(/Invalid server name/);
      }
    });

    it.each(cases)('%s (%s scope) puts the skill in a single mcpkit-<name> directory', async (agent, scope) => {
      const generate = await getGenerator(agent);

      for (const name of ['github', 'cli', 'mysql-prod', 'constructor', 'a.b_c']) {
        const { filePath } = generate(context(name, scope));
        expect(filePath.endsWith(join(`mcpkit-${name}`, 'SKILL.md'))).toBe(true);
        expect(filePath.split('/')).not.toContain('..');
      }
    });
  });

  describe('writing and deleting skills', () => {
    it('writeSkillFile refuses a path that is not <skills dir>/mcpkit-<name>/SKILL.md', async () => {
      const victim = join(homeDir, 'victim');
      await mkdir(victim);
      await writeFile(join(victim, 'keep.txt'), 'keep', 'utf-8');
      const skills = join(homeDir, '.claude', 'skills');
      const refused = [
        join(victim, 'SKILL.md'),
        join(skills, 'other', 'SKILL.md'),
        join(skills, 'mcpkit-ok', 'NOTES.md'),
        `${skills}/mcpkit-ok/../../../victim/SKILL.md`,
        `${skills}/mcpkit-../SKILL.md`,
        'mcpkit-ok/SKILL.md',
        join(skills, 'mcpkit-a b', 'SKILL.md'),
      ];

      for (const path of refused) {
        await expect(writeSkillFile(path, 'x'), path).rejects.toThrow(/Refusing/);
      }

      expect(await readdir(victim)).toEqual(['keep.txt']);
      expect(existsSync(skills)).toBe(false);
    });

    it('removeSkillDirectory refuses to delete anything that is not an mcpkit skill directory', async () => {
      const victim = join(homeDir, 'victim');
      await mkdir(victim);
      await writeFile(join(victim, 'keep.txt'), 'keep', 'utf-8');
      const refused = [
        join(victim, 'SKILL.md'),
        `${homeDir}/.claude/skills/mcpkit-ok/../../../victim/SKILL.md`,
        homeDir,
        '/',
      ];

      for (const path of refused) {
        await expect(removeSkillDirectory(path), path).rejects.toThrow(/Refusing/);
      }

      expect(await readFile(join(victim, 'keep.txt'), 'utf-8')).toBe('keep');
    });

    it('writes and deletes the skill of a real name, the mcpkit-cli guide included', async () => {
      for (const name of ['github', 'cli']) {
        const file = join(homeDir, '.claude', 'skills', `mcpkit-${name}`, 'SKILL.md');
        await writeSkillFile(file, `skill ${name}`);
        expect(await readFile(file, 'utf-8')).toBe(`skill ${name}`);

        await removeSkillDirectory(file);
        expect(existsSync(join(homeDir, '.claude', 'skills', `mcpkit-${name}`))).toBe(false);
      }
    });

    it('replaces a skill file atomically: no temp file is left, also when the write fails', async () => {
      const dir = join(homeDir, '.claude', 'skills', 'mcpkit-demo');
      const file = join(dir, 'SKILL.md');

      await writeSkillFile(file, 'first');
      await writeSkillFile(file, 'second');
      expect(await readFile(file, 'utf-8')).toBe('second');
      expect(await readdir(dir)).toEqual(['SKILL.md']);

      await rm(file);
      await mkdir(file);
      await expect(writeSkillFile(file, 'third')).rejects.toThrow();
      expect(await readdir(dir)).toEqual(['SKILL.md']);
    });

    it('reconcileSkillFiles writes nothing for a hostile server name', async () => {
      const before = await snapshot(outer);

      await expect(reconcileSkillFiles({
        ctx: context('x/../../../victim'),
        nextAgents: ['claude-code', 'cursor'] as AgentType[],
        previousAgents: ['codex'],
      })).rejects.toThrow(/Invalid server name/);

      expect(await snapshot(outer)).toEqual(before);
    });
  });

  describe('a hand-written registry with hostile entries', () => {
    const stdio = '    transport:\n      type: stdio\n      command: node\n      args: []\n';
    const tail = '    toolCount: 1\n    agents:\n      - claude-code\n      - cursor\n    createdAt: 2026-04-04T00:00:00.000Z\n    updatedAt: 2026-04-04T00:00:00.000Z\n';
    const entry = (key: string, name: string) => `  ${JSON.stringify(key)}:\n    name: ${JSON.stringify(name)}\n${stdio}${tail}`;
    const REGISTRY = `version: 1\nservers:\n${[
      entry('good', 'good'),
      entry('x/../../../victim', 'x/../../../victim'),
      entry('alias', '../../victim'),
      entry('a/b', 'a/b'),
      entry('..', '..'),
      entry('mismatch', 'good'),
    ].join('')}`;

    async function arrange(): Promise<{ victim: string; skills: string }> {
      const victim = join(homeDir, 'victim');
      await mkdir(victim);
      await writeFile(join(victim, 'keep.txt'), 'keep', 'utf-8');
      await mkdir(join(homeDir, '.mcpkit'), { recursive: true });
      await writeFile(getRegistryPath(), REGISTRY, 'utf-8');
      // The skill of the one valid server exists, so the commands have something real to delete.
      for (const dir of ['.claude', '.cursor']) {
        await mkdir(join(homeDir, dir, 'skills', 'mcpkit-good'), { recursive: true });
        await writeFile(join(homeDir, dir, 'skills', 'mcpkit-good', 'SKILL.md'), 'good skill', 'utf-8');
      }
      return { victim, skills: join(homeDir, '.claude', 'skills') };
    }

    const HOSTILE_KEYS = ['x/../../../victim', 'alias', 'a/b', '..', 'mismatch'];

    it('loads only the valid server, and warns about the others by their escaped names', async () => {
      await arrange();
      const warn = vi.mocked(console.warn);

      expect((await getServer('good'))?.name).toBe('good');

      const warnings = warn.mock.calls.map((call) => String(call[0])).join('\n');
      expect(warnings).toContain('"x/../../../victim"');
      expect(warnings).toContain('"alias"');
    });

    it.each(HOSTILE_KEYS)('remove %j touches nothing outside the skills directory', async (name) => {
      const { victim } = await arrange();
      const before = await snapshot(outer);

      await createRemoveCommand().parseAsync([name], { from: 'user' });

      expect(process.exit).toHaveBeenCalledWith(1);
      expect(await readFile(join(victim, 'keep.txt'), 'utf-8')).toBe('keep');
      expect(await snapshot(outer)).toEqual(before);
    });

    it('removing the valid server deletes only its own skill directories and keeps the hostile entries in the file', async () => {
      const { victim } = await arrange();

      await createRemoveCommand().parseAsync(['good'], { from: 'user' });

      expect(existsSync(join(homeDir, '.claude', 'skills', 'mcpkit-good'))).toBe(false);
      expect(existsSync(join(homeDir, '.cursor', 'skills', 'mcpkit-good'))).toBe(false);
      expect(await readFile(join(victim, 'keep.txt'), 'utf-8')).toBe('keep');
      const stored = (parse(await readFile(getRegistryPath(), 'utf-8')) as { servers: Record<string, unknown> }).servers;
      expect(Object.keys(stored)).toEqual(['x/../../../victim', 'alias', 'a/b', '..', 'mismatch']);
    });

    it('sync and update leave everything outside the mcpkit directories as it was, and keep the hostile entries in the file', async () => {
      const { victim } = await arrange();
      const outsideBefore = (await snapshot(victim));

      await createSyncCommand().parseAsync(['--force'], { from: 'user' });
      await createUpdateCommand().parseAsync([], { from: 'user' });
      for (const name of HOSTILE_KEYS) {
        await createSyncCommand().parseAsync([name], { from: 'user' });
        await createUpdateCommand().parseAsync([name], { from: 'user' });
      }

      expect(await snapshot(victim)).toEqual(outsideBefore);
      expect((await readdir(homeDir)).sort()).toEqual(['.claude', '.cursor', '.mcpkit', 'victim']);
      expect((await readdir(outer)).sort()).toEqual(['home']);
      const stored = (parse(await readFile(getRegistryPath(), 'utf-8')) as { servers: Record<string, { name: string }> }).servers;
      expect(Object.keys(stored)).toEqual(['good', 'x/../../../victim', 'alias', 'a/b', '..', 'mismatch']);
      expect(stored.alias.name).toBe('../../victim');
    });
  });
});
