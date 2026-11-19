import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentType, GeneratorContext, ToolInfo } from './types.js';

// Wrap rename so a test can make one commit fail the way a file system can after staging went fine.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

const fs = await import('node:fs/promises');
const realRename = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).rename;
const { reconcileSkillFiles } = await import('./skill-sync.js');
const { getGenerator } = await import('./generators/index.js');

const tools: ToolInfo[] = [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object' } }];
const ctx: GeneratorContext = { serverName: 'demo', tools, transport: { type: 'stdio', command: 'node', args: [] }, scope: 'global' };

/** Every path under `dir`, files and directories, with the content of each file. */
async function snapshot(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const lines = await Promise.all(entries.map(async (entry) => {
    const path = join(entry.parentPath, entry.name);
    return entry.isFile() ? `${path} ${await readFile(path, 'utf-8')}` : `${path}/`;
  }));
  return lines.sort();
}

describe('reconcileSkillFiles with several agents', () => {
  const originalHome = process.env.HOME;
  const originalHermes = process.env.HERMES_HOME;
  const agents: AgentType[] = ['claude-code', 'cursor'];
  let home = '';
  let log: string[] = [];

  const skillPath = (agent: AgentType) => getGenerator(agent).then((generate) => generate(ctx).filePath);

  async function installOldSkill(agent: AgentType, content = 'old skill'): Promise<string> {
    const path = await skillPath(agent);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, content, 'utf-8');
    return path;
  }

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'mcpkit-skill-sync-'));
    process.env.HOME = home;
    delete process.env.HERMES_HOME;
    log = [];
    vi.spyOn(console, 'log').mockImplementation((...parts) => { log.push(parts.join(' ')); });
    vi.mocked(fs.rename).mockReset();
    vi.mocked(fs.rename).mockImplementation(realRename);
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalHermes !== undefined) process.env.HERMES_HOME = originalHermes;
    await rm(home, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('writes every agent and leaves no temp file behind', async () => {
    await reconcileSkillFiles({ ctx, nextAgents: agents });

    for (const agent of agents) {
      expect(await readFile(await skillPath(agent), 'utf-8')).toContain('# demo (MCP Server)');
    }
    expect((await snapshot(home)).filter((line) => line.includes('.tmp'))).toEqual([]);
    expect(log.filter((line) => line.includes('✓'))).toHaveLength(2);
  });

  it('writes nothing in a dry run', async () => {
    await reconcileSkillFiles({ ctx, nextAgents: agents, dryRun: true });

    expect(await readdir(home)).toEqual([]);
    expect(vi.mocked(fs.rename)).not.toHaveBeenCalled();
  });

  describe('when the second agent cannot be written', () => {
    // A regular file where the agent's directory should be: not writable, and root cannot change that.
    beforeEach(async () => {
      await writeFile(join(home, '.cursor'), 'not a directory', 'utf-8');
    });

    it('leaves the first agent\'s existing skill as it was, and names the agent that failed', async () => {
      const claude = await installOldSkill('claude-code');
      const before = await snapshot(home);

      await expect(reconcileSkillFiles({ ctx, nextAgents: agents })).rejects.toThrow(/cursor/);

      expect(await readFile(claude, 'utf-8')).toBe('old skill');
      expect(await snapshot(home)).toEqual(before);
      expect(log.filter((line) => line.includes('✓'))).toEqual([]);
    });

    it('creates nothing for the first agent when it had no skill yet, not even its directory', async () => {
      const before = await snapshot(home);

      await expect(reconcileSkillFiles({ ctx, nextAgents: agents })).rejects.toThrow(/cursor.*skills\/mcpkit-demo\/SKILL\.md/s);

      expect(await snapshot(home)).toEqual(before);
    });

    it('does not remove the skill of an agent that is being dropped', async () => {
      const codex = await installOldSkill('codex');
      const before = await snapshot(home);

      await expect(reconcileSkillFiles({ ctx, nextAgents: agents, previousAgents: ['codex'] })).rejects.toThrow(/cursor/);

      expect(await readFile(codex, 'utf-8')).toBe('old skill');
      expect(await snapshot(home)).toEqual(before);
    });
  });

  describe('when the rename of the second agent fails after everything was staged', () => {
    function failRenameFor(agent: string): void {
      vi.mocked(fs.rename).mockImplementation(async (from, to) => {
        if (String(to).includes(`/.${agent}/`)) throw Object.assign(new Error('EIO: simulated'), { code: 'EIO' });
        return realRename(from, to);
      });
    }

    it('puts the first agent\'s old skill back and removes every staged file', async () => {
      const claude = await installOldSkill('claude-code');
      const before = await snapshot(home);
      failRenameFor('cursor');

      await expect(reconcileSkillFiles({ ctx, nextAgents: agents })).rejects.toThrow(/cursor.*EIO/s);

      expect(await readFile(claude, 'utf-8')).toBe('old skill');
      expect(await snapshot(home)).toEqual(before);
      expect(log.filter((line) => line.includes('✓'))).toEqual([]);
    });

    it('removes the first agent\'s new skill, and the directories made for it, when it had none before', async () => {
      const before = await snapshot(home);
      failRenameFor('cursor');

      await expect(reconcileSkillFiles({ ctx, nextAgents: agents })).rejects.toThrow(/cursor/);

      expect(await snapshot(home)).toEqual(before);
    });
  });
});
