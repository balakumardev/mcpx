import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSkillContent } from './generators/index.js';
import { buildMetaSkillContent } from './meta-skill.js';
import {
  backupSkillDirs,
  isGeneratedSkillContent,
  planGuideMigration,
  removeGeneratedSkillDirs,
  skillsRootOf,
} from './skill-mode-migration.js';
import { generatedSkill, skillContext, treeOf, writeGeneratedSkill, writeUserSkill } from './skill-fixtures.js';
import type { ToolInfo } from './types.js';

function manyTools(count: number): ToolInfo[] {
  return Array.from({ length: count }, (_, index) => ({
    name: `tool_${index}`,
    description: `Does thing ${index}. More detail follows here.`,
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  }));
}

describe('what counts as a skill mcpkit generated', () => {
  it.each(['github', 'a.b', 'x_y-z', 'Slack-Me', '1password', 'composio-personal'])('recognises the full format for %s', (name) => {
    const content = buildSkillContent(skillContext(name), { format: 'full' });
    expect(isGeneratedSkillContent(content, `mcpkit-${name}`)).toBe(true);
  });

  it.each(['github', 'a.b', 'big_server'])('recognises the compact format for %s', (name) => {
    const content = buildSkillContent(skillContext(name, manyTools(30)), { format: 'compact' });
    expect(isGeneratedSkillContent(content, `mcpkit-${name}`)).toBe(true);
  });

  it('recognises the lines the stock v0.1.29 generator wrote', () => {
    const stock = [
      '---',
      'name: mcpkit-demo',
      'description: "Demo tools via mcpkit. Use this when you need to work with demo."',
      '---',
      '',
      '# demo (MCP Server)',
      '',
      '> **Important:** These are NOT native MCP tools. Do NOT call them as `mcp__demo__*` tools.',
      "> All tools must be invoked via Bash using `mcpkit call demo <tool_name> '<json_params>'`.",
      '',
      '## When to Use',
    ].join('\n');
    expect(isGeneratedSkillContent(stock, 'mcpkit-demo')).toBe(true);
  });

  it('recognises a skill whose name the frontmatter writes in quotes', () => {
    const content = buildSkillContent(skillContext('demo')).replace('name: mcpkit-demo', 'name: "mcpkit-demo"');
    expect(isGeneratedSkillContent(content, 'mcpkit-demo')).toBe(true);
  });

  it('does not recognise the mcpkit-cli guide', () => {
    expect(isGeneratedSkillContent(buildMetaSkillContent(), 'mcpkit-cli')).toBe(false);
  });

  it.each([
    ['a hand-written skill with the same name', '---\nname: mcpkit-demo\ndescription: "mine"\n---\n\n# Mine\n'],
    ['a skill that only mentions the words', '---\nname: mcpkit-demo\n---\n\nThese are NOT native MCP tools; run `mcpkit call demo x`.\n'],
    ['an empty file', ''],
    ['a file with no frontmatter', '# demo\n> **Important:** These are NOT native MCP tools. Do NOT call them as `mcp__demo__*` tools.\n'],
    ['a frontmatter that is never closed', '---\nname: mcpkit-demo\n> **Important:** These are NOT native MCP tools. Do NOT call them as `mcp__demo__*` tools.\n'],
  ])('does not recognise %s', (_label, content) => {
    expect(isGeneratedSkillContent(content, 'mcpkit-demo')).toBe(false);
  });

  it('does not recognise a generated skill under another directory name', () => {
    const content = buildSkillContent(skillContext('demo'));
    expect(isGeneratedSkillContent(content, 'mcpkit-other')).toBe(false);
  });

  it('does not recognise the markers when they sit inside the frontmatter instead of the body', () => {
    const generated = buildSkillContent(skillContext('demo'));
    const forged = `---\nname: mcpkit-demo\n${generated.split('\n').filter((line) => line.startsWith('>')).join('\n')}\n---\n\n# Mine\n`;
    expect(isGeneratedSkillContent(forged, 'mcpkit-demo')).toBe(false);
  });
});

describe('migrating an agent to the guide', () => {
  const originalHome = process.env.HOME;
  const originalHermes = process.env.HERMES_HOME;
  let home = '';

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'mcpkit-migration-'));
    process.env.HOME = home;
    delete process.env.HERMES_HOME;
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalHermes !== undefined) process.env.HERMES_HOME = originalHermes;
    await rm(home, { recursive: true, force: true });
  });

  it('finds the skills directory of every agent through its generator', async () => {
    expect(await skillsRootOf('claude-code')).toBe(join(home, '.claude', 'skills'));
    expect(await skillsRootOf('windsurf')).toBe(join(home, '.codeium', 'windsurf', 'skills'));
    process.env.HERMES_HOME = join(home, 'hermes-home');
    expect(await skillsRootOf('hermes')).toBe(join(home, 'hermes-home', 'skills'));
  });

  describe('planning', () => {
    it('plans an empty migration for an agent with no skills directory', async () => {
      const plan = await planGuideMigration('cursor');
      expect(plan).toMatchObject({ agent: 'cursor', root: join(home, '.cursor', 'skills'), remove: [], keep: [] });
      expect(plan.guidePath).toBe(join(home, '.cursor', 'skills', 'mcpkit-cli', 'SKILL.md'));
      expect(await readdir(home)).toEqual([]);
    });

    it('removes only the generated skills of that agent and keeps everything else', async () => {
      const github = await writeGeneratedSkill('claude-code', 'github');
      const slack = await writeGeneratedSkill('claude-code', 'slack-me', manyTools(30));
      const lookalike = await writeUserSkill('claude-code', 'mcpkit-notes');
      await writeUserSkill('claude-code', 'my-own-skill');
      await mkdir(join(home, '.claude', 'skills', 'mcpkit-cli'), { recursive: true });
      await writeFile(join(home, '.claude', 'skills', 'mcpkit-cli', 'SKILL.md'), buildMetaSkillContent(), 'utf-8');
      await writeGeneratedSkill('cursor', 'github');

      const plan = await planGuideMigration('claude-code');

      expect(plan.remove).toEqual([github.dir, slack.dir].sort());
      expect(plan.keep).toEqual([{ dir: lookalike.dir, reason: expect.stringContaining('not written by mcpkit') }]);
    });

    it('never plans the mcpkit-cli directory, even when something written by mcpkit sits in it', async () => {
      const cli = await generatedSkill('claude-code', 'cli');
      await mkdir(cli.dir, { recursive: true });
      await writeFile(cli.path, cli.content, 'utf-8');

      const plan = await planGuideMigration('claude-code');

      expect(plan.remove).toEqual([]);
      expect(plan.keep).toEqual([]);
    });

    it.each([
      ['holds a file besides SKILL.md', async (dir: string) => { await writeFile(join(dir, 'notes.md'), 'extra', 'utf-8'); }, 'besides SKILL.md'],
      ['has no SKILL.md', async (dir: string) => { await rm(join(dir, 'SKILL.md')); }, 'no SKILL.md'],
      ['has a SKILL.md that is a symlink', async (dir: string) => {
        await rm(join(dir, 'SKILL.md'));
        await writeFile(join(home, 'elsewhere.md'), (await generatedSkill('claude-code', 'demo')).content, 'utf-8');
        await symlink(join(home, 'elsewhere.md'), join(dir, 'SKILL.md'));
      }, 'not a regular file'],
    ])('keeps a generated skill whose directory %s', async (_label, tamper, reason) => {
      const demo = await writeGeneratedSkill('claude-code', 'demo');
      await tamper(demo.dir);

      const plan = await planGuideMigration('claude-code');

      expect(plan.remove).toEqual([]);
      expect(plan.keep).toEqual([{ dir: demo.dir, reason: expect.stringContaining(reason) }]);
    });

    it('keeps a skill directory that is a symlink, whatever it points to', async () => {
      const real = await writeGeneratedSkill('claude-code', 'real');
      const root = join(home, '.claude', 'skills');
      await symlink(real.dir, join(root, 'mcpkit-linked'));

      const plan = await planGuideMigration('claude-code');

      expect(plan.remove).toEqual([real.dir]);
      expect(plan.keep.map((entry) => entry.dir)).toEqual([join(root, 'mcpkit-linked')]);
    });

    it('ignores a file named like a skill directory, a name that is not a valid server name, and plain files', async () => {
      const root = join(home, '.claude', 'skills');
      await mkdir(root, { recursive: true });
      await writeFile(join(root, 'mcpkit-file'), 'not a directory', 'utf-8');
      await writeFile(join(root, 'README.md'), 'readme', 'utf-8');
      await mkdir(join(root, 'mcpkit-.hidden'), { recursive: true });
      await mkdir(join(root, 'mcpkit-'), { recursive: true });

      const plan = await planGuideMigration('claude-code');

      expect(plan.remove).toEqual([]);
      expect(plan.keep).toEqual([]);
    });

    it('writes nothing', async () => {
      await writeGeneratedSkill('claude-code', 'github');
      const before = await treeOf(home);
      await planGuideMigration('claude-code');
      expect(await treeOf(home)).toEqual(before);
    });
  });

  describe('backing up and removing', () => {
    it('copies each directory to <timestamp>/<agent>/<dir> byte for byte, owner-only', async () => {
      const github = await writeGeneratedSkill('claude-code', 'github');
      const slack = await writeGeneratedSkill('claude-code', 'slack-me', manyTools(30));
      const cursor = await writeGeneratedSkill('cursor', 'github');
      const plans = [await planGuideMigration('claude-code'), await planGuideMigration('cursor')];

      const backup = await backupSkillDirs(plans, new Date(2026, 10, 19, 9, 8, 7));

      expect(backup).toBe(join(home, '.mcpkit', 'skill-backups', '20261119090807'));
      for (const [agent, skill] of [['claude-code', github], ['claude-code', slack], ['cursor', cursor]] as const) {
        const copy = join(backup as string, agent, skill.dir.split('/').pop() as string, 'SKILL.md');
        expect(await readFile(copy, 'utf-8')).toBe(skill.content);
        expect((await stat(copy)).mode & 0o777).toBe(0o600);
        expect((await stat(join(copy, '..'))).mode & 0o777).toBe(0o700);
      }
      for (const dir of [backup as string, join(backup as string, 'claude-code'), join(home, '.mcpkit', 'skill-backups')]) {
        expect((await stat(dir)).mode & 0o777).toBe(0o700);
      }
      // The originals are still there: backing up removes nothing.
      expect(await readFile(github.path, 'utf-8')).toBe(github.content);
    });

    it('copies the bytes exactly, also for content that is not valid UTF-8 text', async () => {
      const demo = await writeGeneratedSkill('claude-code', 'demo');
      const bytes = Buffer.concat([Buffer.from(demo.content), Buffer.from([0xff, 0xfe, 0x00, 0x80])]);
      await writeFile(demo.path, bytes);
      const plans = [await planGuideMigration('claude-code')];
      // Extra bytes after the generated text do not change what it is.
      expect(plans[0].remove).toEqual([demo.dir]);

      const backup = await backupSkillDirs(plans) as string;

      expect(await readFile(join(backup, 'claude-code', 'mcpkit-demo', 'SKILL.md'))).toEqual(bytes);
    });

    it('gives a second backup in the same second its own directory', async () => {
      await writeGeneratedSkill('claude-code', 'github');
      const plans = [await planGuideMigration('claude-code')];
      const now = new Date(2026, 0, 2, 3, 4, 5);

      const first = await backupSkillDirs(plans, now);
      const second = await backupSkillDirs(plans, now);

      expect(first).toBe(join(home, '.mcpkit', 'skill-backups', '20260102030405'));
      expect(second).toBe(join(home, '.mcpkit', 'skill-backups', '20260102030405-1'));
      expect(await readdir(first as string)).toEqual(['claude-code']);
    });

    it('makes no backup when there is nothing to remove', async () => {
      await writeUserSkill('claude-code', 'mcpkit-notes');
      const backup = await backupSkillDirs([await planGuideMigration('claude-code')]);
      expect(backup).toBeUndefined();
      expect(await readdir(home)).toEqual(['.claude']);
    });

    it('throws before removing anything when a backup cannot be made', async () => {
      const demo = await writeGeneratedSkill('claude-code', 'demo');
      await mkdir(join(home, '.mcpkit'), { recursive: true });
      // A file where the backup directory has to go.
      await writeFile(join(home, '.mcpkit', 'skill-backups'), 'in the way', 'utf-8');

      await expect(backupSkillDirs([await planGuideMigration('claude-code')])).rejects.toThrow();

      expect(await readFile(demo.path, 'utf-8')).toBe(demo.content);
    });

    it('removes exactly the planned directories', async () => {
      const github = await writeGeneratedSkill('claude-code', 'github');
      const slack = await writeGeneratedSkill('claude-code', 'slack-me');
      const notes = await writeUserSkill('claude-code', 'mcpkit-notes');
      const cursor = await writeGeneratedSkill('cursor', 'github');
      await mkdir(join(home, '.claude', 'skills', 'mcpkit-cli'), { recursive: true });
      await writeFile(join(home, '.claude', 'skills', 'mcpkit-cli', 'SKILL.md'), 'guide', 'utf-8');

      const removed = await removeGeneratedSkillDirs([await planGuideMigration('claude-code')]);

      expect(removed.sort()).toEqual([github.dir, slack.dir].sort());
      expect((await readdir(join(home, '.claude', 'skills'))).sort()).toEqual(['mcpkit-cli', 'mcpkit-notes']);
      expect(await readFile(notes.path, 'utf-8')).toBe(notes.content);
      expect(await readFile(cursor.path, 'utf-8')).toBe(cursor.content);
      expect(github.dir).not.toBe(slack.dir);
    });

    it('removes nothing when a directory changed into something else after the plan was made', async () => {
      const demo = await writeGeneratedSkill('claude-code', 'demo');
      const plans = [await planGuideMigration('claude-code')];
      await writeFile(demo.path, '---\nname: mcpkit-demo\n---\n\n# I rewrote this by hand\n', 'utf-8');

      expect(await removeGeneratedSkillDirs(plans)).toEqual([]);

      expect(await readFile(demo.path, 'utf-8')).toContain('I rewrote this by hand');
    });

    it('refuses to remove a directory outside the skills directory of its agent', async () => {
      const outside = join(home, 'victim');
      await mkdir(outside, { recursive: true });
      await writeFile(join(outside, 'SKILL.md'), 'precious', 'utf-8');

      await expect(removeGeneratedSkillDirs([{
        agent: 'claude-code',
        root: join(home, '.claude', 'skills'),
        guidePath: join(home, '.claude', 'skills', 'mcpkit-cli', 'SKILL.md'),
        remove: [outside],
        keep: [],
      }])).rejects.toThrow(/Refusing/);

      expect(await readFile(join(outside, 'SKILL.md'), 'utf-8')).toBe('precious');
    });

    it.skipIf(process.getuid?.() === 0)('leaves the originals alone when the backup directory is not writable', async () => {
      const demo = await writeGeneratedSkill('claude-code', 'demo');
      await mkdir(join(home, '.mcpkit'), { recursive: true });
      await chmod(join(home, '.mcpkit'), 0o555);

      await expect(backupSkillDirs([await planGuideMigration('claude-code')])).rejects.toThrow();
      await chmod(join(home, '.mcpkit'), 0o755);

      expect(await readFile(demo.path, 'utf-8')).toBe(demo.content);
    });
  });
});
