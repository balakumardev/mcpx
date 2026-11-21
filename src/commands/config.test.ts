import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { createConfigCommand } from './config.js';
import { addServer } from '../config.js';
import { discoverForEntry } from '../discover.js';
import { loadDirectoryServers } from '../directory.js';
import { buildGuideDirectory } from '../guide-directory.js';
import { buildMetaSkillContent } from '../meta-skill.js';
import { OAuthRequiredError } from '../oauth-required-error.js';
import { generatedSkill, linkSkill, linkSkillsDirectory, treeOf, writeGeneratedSkill, writeUserSkill } from '../skill-fixtures.js';
import type { AgentType, ServerEntry, ToolInfo } from '../types.js';

vi.mock('../discover.js', () => ({
  discoverForEntry: vi.fn(),
}));

const tools: ToolInfo[] = [{ name: 'echo', description: 'Echo a message', inputSchema: { type: 'object' } }];

function entry(name: string, agents: AgentType[] = ['claude-code']): ServerEntry {
  const now = '2026-01-01T00:00:00.000Z';
  return {
    name,
    transport: { type: 'stdio', command: 'node', args: ['server.js'] },
    toolCount: 1,
    agents,
    agentSelectionMode: 'explicit',
    createdAt: now,
    updatedAt: now,
  };
}

describe('mcpkit config', () => {
  const originalHome = process.env.HOME;
  const originalSkills = process.env.MCPKIT_SKILLS;
  let home = '';
  let out: string[] = [];
  let warnings: string[] = [];
  let errors: string[] = [];
  let exitSpy: MockInstance<typeof process.exit>;

  const run = (...args: string[]) => createConfigCommand().parseAsync(args, { from: 'user' });
  const stdout = () => out.join('\n');
  const stderr = () => [...warnings, ...errors].join('\n');
  const settingsFile = () => join(home, '.mcpkit', 'config.yaml');
  const skillsDir = (agent = '.claude') => join(home, agent, 'skills');

  async function writeHook(command = 'mcpkit hook session-start 2>/dev/null || true'): Promise<void> {
    await mkdir(join(home, '.claude'), { recursive: true });
    await writeFile(join(home, '.claude', 'settings.json'), JSON.stringify({ hooks: { SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command }] }] } }), 'utf-8');
  }

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'mcpkit-config-'));
    process.env.HOME = home;
    delete process.env.MCPKIT_SKILLS;
    delete process.env.HERMES_HOME;
    out = [];
    warnings = [];
    errors = [];
    vi.mocked(discoverForEntry).mockReset();
    vi.mocked(discoverForEntry).mockResolvedValue({ tools, serverMeta: { name: 'srv' } });
    vi.spyOn(console, 'log').mockImplementation((...parts) => { out.push(parts.join(' ')); });
    vi.spyOn(console, 'warn').mockImplementation((...parts) => { warnings.push(parts.join(' ')); });
    vi.spyOn(console, 'error').mockImplementation((...parts) => { errors.push(parts.join(' ')); });
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalSkills === undefined) delete process.env.MCPKIT_SKILLS;
    else process.env.MCPKIT_SKILLS = originalSkills;
    await chmod(home, 0o755).catch(() => {});
    await rm(home, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe('showing the settings', () => {
    it('prints the effective mode of every agent with its source and the settings path', async () => {
      await run();

      expect(stdout()).toContain(settingsFile());
      for (const agent of ['claude-code', 'cursor', 'codex', 'windsurf', 'augment', 'openclaw', 'hermes']) {
        expect(stdout()).toMatch(new RegExp(`${agent}\\s+guide\\s+built-in default`));
      }
      expect(exitSpy).not.toHaveBeenCalled();
      expect(existsSync(join(home, '.mcpkit'))).toBe(false);
    });

    describe('what the start-up move did (state.json)', () => {
      const stateFile = () => join(home, '.mcpkit', 'state.json');
      const writeState = async (adopted: Record<string, unknown>) => {
        await mkdir(join(home, '.mcpkit'), { recursive: true });
        await writeFile(stateFile(), JSON.stringify({ version: 1, adopted, hookDeclined: false }), 'utf-8');
      };
      const lines = () => out.join('\n').split('\n');
      const agentLine = (agent: string) => lines().findIndex((line) => new RegExp(`^  ${agent}\\s+guide`).test(line));

      it('shows nothing extra for an agent that was not moved, and for a home without a state file', async () => {
        await run();
        expect(stdout()).not.toContain('adopted');
        expect(stdout()).not.toContain('kept until indexed');
        expect(existsSync(join(home, '.mcpkit'))).toBe(false);

        await writeState({ cursor: { at: '2026-11-20T10:00:00.000Z', by: '0.1.33', removed: 2, backup: '/b/20261120100000', deferred: [] } });
        out = [];
        await run();
        // Only cursor has the line: the lines of the other agents are what they were.
        expect(lines().filter((line) => line.includes('adopted'))).toHaveLength(1);
        expect(lines()[agentLine('claude-code') + 1]).toMatch(/^ {2}codex|^ {2}cursor/);
      });

      it('shows the date, the skills moved, where they went and the skills kept (those still on disk), under the line of each agent that was moved', async () => {
        const backup = join(home, '.mcpkit', 'skill-backups', '20261120100000');
        await writeState({
          'claude-code': { at: '2026-11-20T10:00:00.000Z', by: '0.1.33', removed: 2, backup, deferred: ['c', 'd', 'e'] },
          cursor: { at: '2026-11-21T08:30:00.000Z', by: '0.1.33', removed: 1, backup, deferred: [] },
        });
        for (const name of ['c', 'd', 'e']) await writeGeneratedSkill('claude-code', name);

        await run();

        const all = lines();
        const claude = agentLine('claude-code');
        expect(all[claude + 1].trim()).toBe(`adopted 2026-11-20: 2 skills moved to ${backup}; 3 kept until indexed`);
        expect(all[agentLine('cursor') + 1].trim()).toBe(`adopted 2026-11-21: 1 skill moved to ${backup}`);
        expect(all.filter((line) => line.includes('adopted'))).toHaveLength(2);
        expect(exitSpy).not.toHaveBeenCalled();
      });

      it('shows it for `config skills` too, and writes nothing', async () => {
        await writeState({ codex: { at: '2026-11-20T10:00:00.000Z', by: '0.1.33', removed: 3, backup: '/b', deferred: ['x'] } });
        await writeGeneratedSkill('codex', 'x');
        const before = await treeOf(home);

        await run('skills');

        expect(stdout()).toContain('adopted 2026-11-20: 3 skills moved to /b; 1 kept until indexed');
        expect(await treeOf(home)).toEqual(before);
      });

      it('does not count a kept skill that an agent on per-server skills reads (the same file) as kept until indexed, and writes nothing', async () => {
        await writeState({ 'claude-code': { at: '2026-11-20T10:00:00.000Z', by: '0.1.33', removed: 0, backup: null, deferred: ['github'] } });
        await writeFile(settingsFile(), 'version: 1\nskills:\n  agents:\n    codex: per-server\n', 'utf-8');
        // codex's skill folder is a link to the generated skill claude-code kept: it goes once nobody shares it, not once indexed.
        await linkSkill('codex', 'claude-code', 'github', 'folder');
        const before = await treeOf(home);

        await run('skills');

        expect(lines()[agentLine('claude-code') + 1].trim()).toBe('adopted 2026-11-20: 0 skills moved');
        expect(stdout()).not.toContain('kept until indexed');
        expect(await treeOf(home)).toEqual(before);
        expect(exitSpy).not.toHaveBeenCalled();
      });

      it('does not say "to null" when nothing was backed up, and reads a record from before the list of kept skills as none kept', async () => {
        await writeState({ cursor: { at: '2026-11-20T10:00:00.000Z', by: '0.1.30', removed: 0, backup: null } });

        await run();

        expect(lines()[agentLine('cursor') + 1].trim()).toBe('adopted 2026-11-20: 0 skills moved');
        expect(stdout()).not.toContain('null');
      });

      it('ignores a record that is not for an agent, and survives a state file it cannot read', async () => {
        await mkdir(join(home, '.mcpkit'), { recursive: true });
        await writeFile(stateFile(), '{"version":1,"adopted":{"constructor":{"at":"2026-11-20T10:00:00.000Z","by":"x","removed":9,"backup":null}},"hookDeclined":false}', 'utf-8');

        await run();

        expect(stdout()).not.toContain('adopted');
        expect(stdout()).not.toContain('9 skills');

        out = [];
        await writeFile(stateFile(), '{ not json', 'utf-8');
        await run();

        expect(stdout()).not.toContain('adopted');
        expect(stdout()).toMatch(/claude-code\s+guide\s+built-in default/);
        expect(exitSpy).not.toHaveBeenCalled();
        expect(await readFile(stateFile(), 'utf-8')).toBe('{ not json');
      });

      it('keeps the text of a hand-edited record to one safe line', async () => {
        await writeState({ cursor: { at: 'yesterday\u001b[31m\nforged line', by: '0.1.33', removed: 1, backup: '/b\nforged', deferred: [] } });

        await run();

        // The line break of the record did not start a line of its own: both texts are in the one line.
        expect(lines().filter((line) => line.includes('forged'))).toHaveLength(1);
        expect(lines().find((line) => line.includes('forged'))?.trim()).toBe('adopted yesterday forged line: 1 skill moved to /b forged');
        expect(stdout()).not.toContain('\u001b[31m');
      });

      it('counts only the kept skills that are still on disk as skills mcpkit generated, and leaves the clause out when there are none', async () => {
        const backup = join(home, '.mcpkit', 'skill-backups', '20261120100000');
        await writeState({ 'claude-code': { at: '2026-11-20T10:00:00.000Z', by: '0.1.33', removed: 2, backup, deferred: ['c', 'd', 'e', 'f'] } });
        // c is there; d was rewritten by the user (no longer ours); e is gone; f is a directory of a hand-written skill that only looks like ours.
        await writeGeneratedSkill('claude-code', 'c');
        await writeUserSkill('claude-code', 'mcpkit-d');
        await writeUserSkill('claude-code', 'mcpkit-f');

        await run();

        expect(lines()[agentLine('claude-code') + 1].trim()).toBe(`adopted 2026-11-20: 2 skills moved to ${backup}; 1 kept until indexed`);

        await rm((await generatedSkill('claude-code', 'c')).dir, { recursive: true });
        out = [];
        await run();

        expect(lines()[agentLine('claude-code') + 1].trim()).toBe(`adopted 2026-11-20: 2 skills moved to ${backup}`);
        expect(stdout()).not.toContain('kept until indexed');
      });

      it('stops saying "kept until indexed" once `config lean on` has removed those skills', async () => {
        await writeState({ 'claude-code': { at: '2026-11-20T10:00:00.000Z', by: '0.1.33', removed: 0, backup: null, deferred: ['c', 'd'] } });
        await writeGeneratedSkill('claude-code', 'c');
        await writeGeneratedSkill('claude-code', 'd');
        await run();
        expect(lines()[agentLine('claude-code') + 1].trim()).toBe('adopted 2026-11-20: 0 skills moved; 2 kept until indexed');

        out = [];
        await run('lean', 'on', '--agent', 'claude-code');
        expect(exitSpy).not.toHaveBeenCalled();
        out = [];
        await run();

        expect(lines()[agentLine('claude-code') + 1].trim()).toBe('adopted 2026-11-20: 0 skills moved');
        expect(stdout()).not.toContain('kept until indexed');
      });

      it.skipIf(process.getuid?.() === 0)('says nothing of the kept skills when the skills directory cannot be read (it cannot say they are there)', async () => {
        await writeState({ 'claude-code': { at: '2026-11-20T10:00:00.000Z', by: '0.1.33', removed: 0, backup: null, deferred: ['c'] } });
        const skills = (await writeGeneratedSkill('claude-code', 'c')).dir.replace(/\/mcpkit-c$/, '');
        await chmod(skills, 0o000);
        try {
          await run();

          expect(lines()[agentLine('claude-code') + 1].trim()).toBe('adopted 2026-11-20: 0 skills moved');
          expect(exitSpy).not.toHaveBeenCalled();
        } finally {
          await chmod(skills, 0o755);
        }
      });
    });

    it('says which value came from the file and which from the environment', async () => {
      await mkdir(join(home, '.mcpkit'), { recursive: true });
      await writeFile(settingsFile(), 'version: 1\nskills:\n  default: guide\n  agents:\n    cursor: per-server\n', 'utf-8');

      await run('skills');
      expect(stdout()).toMatch(/claude-code\s+guide\s+file/);
      expect(stdout()).toMatch(/cursor\s+per-server\s+file/);

      out = [];
      process.env.MCPKIT_SKILLS = 'per-server';
      await run('skills');
      expect(stdout()).toMatch(/claude-code\s+per-server\s+env/);
      expect(stdout()).toContain('MCPKIT_SKILLS');
    });

    it('reports a file it cannot use, still shows the defaults, and exits normally', async () => {
      await mkdir(join(home, '.mcpkit'), { recursive: true });
      await writeFile(settingsFile(), 'skills: [broken\n', 'utf-8');

      await run('skills');

      expect(stderr()).toContain('not valid YAML');
      expect(stdout()).toMatch(/claude-code\s+guide\s+built-in default/);
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it('reports an unknown value and an unknown MCPKIT_SKILLS', async () => {
      await mkdir(join(home, '.mcpkit'), { recursive: true });
      await writeFile(settingsFile(), 'version: 1\nskills:\n  agents:\n    cursor: sometimes\n', 'utf-8');
      process.env.MCPKIT_SKILLS = 'both';

      await run('skills');

      expect(stderr()).toContain('"sometimes"');
      expect(stderr()).toContain('MCPKIT_SKILLS');
    });
  });

  describe('a home directory that is missing or read-only', () => {
    it('shows the defaults for a home that does not exist, and writes nothing', async () => {
      process.env.HOME = join(home, 'no', 'such', 'dir');

      await run();

      expect(exitSpy).not.toHaveBeenCalled();
      expect(stdout()).toMatch(/claude-code\s+guide\s+built-in default/);
      expect(existsSync(join(home, 'no'))).toBe(false);
    });

    it('previews a switch for a home that does not exist, and writes nothing', async () => {
      process.env.HOME = join(home, 'no', 'such', 'dir');

      await run('skills', 'guide', '--agent', 'claude-code', '--dry-run');

      expect(exitSpy).not.toHaveBeenCalled();
      expect(existsSync(join(home, 'no'))).toBe(false);
    });

    it.skipIf(process.getuid?.() === 0)('fails a switch with exit 1 and an error, not a crash, when the home is read-only', async () => {
      await chmod(home, 0o555);

      await run('skills', 'guide', '--agent', 'claude-code');
      await chmod(home, 0o755);

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(errors.join('\n')).toMatch(/EACCES|permission/i);
      expect(await readdir(home)).toEqual([]);
    });
  });

  describe('usage errors', () => {
    it('refuses an unknown mode and writes nothing', async () => {
      await run('skills', 'everything');
      expect(exitSpy).toHaveBeenCalledWith(2);
      expect(stderr()).toMatch(/per-server.*guide|guide.*per-server/);
      expect(existsSync(join(home, '.mcpkit'))).toBe(false);
    });

    it('refuses an unknown agent and names the ones it knows', async () => {
      await run('skills', 'guide', '--agent', 'vim');
      expect(exitSpy).toHaveBeenCalledWith(2);
      expect(stderr()).toContain('claude-code');
      expect(existsSync(join(home, '.mcpkit'))).toBe(false);
    });

    it('refuses --agent when no mode is given', async () => {
      await run('skills', '--agent', 'cursor');
      expect(exitSpy).toHaveBeenCalledWith(2);
    });
  });

  describe('switching an agent to the guide', () => {
    async function layout() {
      await addServer(entry('github', ['claude-code', 'cursor']));
      await addServer(entry('slack-me', ['claude-code']));
      const github = await writeGeneratedSkill('claude-code', 'github');
      const slack = await writeGeneratedSkill('claude-code', 'slack-me');
      const notes = await writeUserSkill('claude-code', 'mcpkit-notes');
      const cursorGithub = await writeGeneratedSkill('cursor', 'github');
      return { github, slack, notes, cursorGithub };
    }

    it('writes the guide, backs up and removes the generated skills of that agent, and keeps everything else', async () => {
      const { github, slack, notes, cursorGithub } = await layout();

      await run('skills', 'guide', '--agent', 'claude-code');

      expect(exitSpy).not.toHaveBeenCalled();
      // The guide lists the servers that serve claude-code: github and slack-me, not what only cursor has.
      const guide = await readFile(join(skillsDir(), 'mcpkit-cli', 'SKILL.md'), 'utf-8');
      expect(guide).toBe(buildMetaSkillContent({ directory: buildGuideDirectory(await loadDirectoryServers('claude-code')) }));
      expect(guide).toContain('- github');
      expect(guide).toContain('- slack-me');
      expect(existsSync(github.dir)).toBe(false);
      expect(existsSync(slack.dir)).toBe(false);
      expect(await readFile(notes.path, 'utf-8')).toBe(notes.content);
      expect(await readFile(cursorGithub.path, 'utf-8')).toBe(cursorGithub.content);
      expect(parse(await readFile(settingsFile(), 'utf-8'))).toEqual({ version: 1, skills: { agents: { 'claude-code': 'guide' } } });
      expect((await stat(settingsFile())).mode & 0o777).toBe(0o600);
    });

    it('backs every removed skill up byte for byte and prints where', async () => {
      const { github, slack } = await layout();

      await run('skills', 'guide', '--agent', 'claude-code');

      const backups = await readdir(join(home, '.mcpkit', 'skill-backups'));
      expect(backups).toHaveLength(1);
      const backup = join(home, '.mcpkit', 'skill-backups', backups[0]);
      expect(backups[0]).toMatch(/^\d{14}$/);
      expect(await readFile(join(backup, 'claude-code', 'mcpkit-github', 'SKILL.md'), 'utf-8')).toBe(github.content);
      expect(await readFile(join(backup, 'claude-code', 'mcpkit-slack-me', 'SKILL.md'), 'utf-8')).toBe(slack.content);
      expect((await readdir(join(backup, 'claude-code'))).sort()).toEqual(['mcpkit-github', 'mcpkit-slack-me']);
      expect(stdout()).toContain(backup);
      expect(stdout()).toContain('mcpkit-github');
      expect(stdout()).toContain('mcpkit-notes');
    });

    it('is safe to run again: the guide is refreshed and there is nothing left to remove', async () => {
      await layout();
      await run('skills', 'guide', '--agent', 'claude-code');
      out = [];

      await run('skills', 'guide', '--agent', 'claude-code');

      expect(exitSpy).not.toHaveBeenCalled();
      expect(await readdir(join(home, '.mcpkit', 'skill-backups'))).toHaveLength(1);
      expect(stdout()).toContain('nothing to remove');
    });

    it('cleans up again after an older mcpkit regenerated the skills', async () => {
      await layout();
      await run('skills', 'guide', '--agent', 'claude-code');
      const again = await writeGeneratedSkill('claude-code', 'github');

      await run('skills', 'guide', '--agent', 'claude-code');

      expect(existsSync(again.dir)).toBe(false);
    });

    it('writes the guide before it removes anything: a guide that cannot be written leaves the skills', async () => {
      const { github } = await layout();
      // A file where the guide's directory has to go.
      await writeFile(join(skillsDir(), 'mcpkit-cli'), 'in the way', 'utf-8');

      await run('skills', 'guide', '--agent', 'claude-code');

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(await readFile(github.path, 'utf-8')).toBe(github.content);
      expect(existsSync(settingsFile())).toBe(false);
    });

    it('removes nothing and saves nothing when a backup cannot be made', async () => {
      const { github, slack } = await layout();
      await mkdir(join(home, '.mcpkit'), { recursive: true });
      // A file where the backup directory has to go.
      await writeFile(join(home, '.mcpkit', 'skill-backups'), 'in the way', 'utf-8');

      await run('skills', 'guide', '--agent', 'claude-code');

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(await readFile(github.path, 'utf-8')).toBe(github.content);
      expect(await readFile(slack.path, 'utf-8')).toBe(slack.content);
      expect(existsSync(settingsFile())).toBe(false);
    });

    it.skipIf(process.getuid?.() === 0)('removes nothing and exits 1 when the settings cannot be saved', async () => {
      const { github, slack } = await layout();
      await mkdir(join(home, '.mcpkit'), { recursive: true });
      await chmod(join(home, '.mcpkit'), 0o555);

      await run('skills', 'guide', '--agent', 'claude-code');
      await chmod(join(home, '.mcpkit'), 0o755);

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(errors.join('\n')).toMatch(/EACCES|permission/i);
      expect(await readFile(github.path, 'utf-8')).toBe(github.content);
      expect(await readFile(slack.path, 'utf-8')).toBe(slack.content);
      expect(existsSync(join(home, '.mcpkit', 'skill-backups'))).toBe(false);
    });

    it('works on an agent that has no directory yet and creates only that agent\'s guide', async () => {
      await run('skills', 'guide', '--agent', 'codex');

      expect(exitSpy).not.toHaveBeenCalled();
      expect(existsSync(join(home, '.codex', 'skills', 'mcpkit-cli', 'SKILL.md'))).toBe(true);
      expect(existsSync(join(home, '.claude'))).toBe(false);
      expect(existsSync(join(home, '.mcpkit', 'skill-backups'))).toBe(false);
    });

    it('leaves the skills of an agent that stays on per-server skills when its skills directory is the one of the agent switched (~/.codex/skills -> ~/.claude/skills)', async () => {
      await linkSkillsDirectory('codex', 'claude-code');
      await mkdir(join(home, '.mcpkit'), { recursive: true });
      await writeFile(settingsFile(), 'version: 1\nskills:\n  agents:\n    claude-code: per-server\n', 'utf-8');
      await addServer(entry('github', ['claude-code', 'codex']));
      await addServer(entry('codex-only', ['codex']));
      const github = await writeGeneratedSkill('claude-code', 'github');
      const codexOnly = await writeGeneratedSkill('codex', 'codex-only');

      await run('skills', 'guide', '--agent', 'codex');

      expect(exitSpy).not.toHaveBeenCalled();
      expect(await readFile(github.path, 'utf-8')).toBe(github.content);
      expect(stdout()).toContain(`codex: keep ${join(home, '.codex', 'skills', 'mcpkit-github')} (it is the same file as the per-server skill of claude-code)`);
      // A skill only codex had is still backed up and removed.
      expect(existsSync(codexOnly.dir)).toBe(false);
      const [backup] = await readdir(join(home, '.mcpkit', 'skill-backups'));
      expect(await readdir(join(home, '.mcpkit', 'skill-backups', backup, 'codex'))).toEqual(['mcpkit-codex-only']);
    });

    it('keeps every skill an agent on per-server skills reads through a shared skills directory when the registry cannot be read (nothing says which are live)', async () => {
      await linkSkillsDirectory('codex', 'claude-code');
      await mkdir(join(home, '.mcpkit'), { recursive: true });
      await writeFile(settingsFile(), 'version: 1\nskills:\n  agents:\n    claude-code: per-server\n', 'utf-8');
      const github = await writeGeneratedSkill('claude-code', 'github');
      await writeFile(join(home, '.mcpkit', 'servers.yaml'), 'servers: [unclosed', 'utf-8');

      await run('skills', 'guide', '--agent', 'codex');

      expect(exitSpy).not.toHaveBeenCalled();
      expect(stderr()).toContain('Could not read the registry');
      expect(await readFile(github.path, 'utf-8')).toBe(github.content);
      expect(stdout()).toContain(`codex: keep ${join(home, '.codex', 'skills', 'mcpkit-github')} (it is the same file as the per-server skill of claude-code)`);
      expect(existsSync(join(home, '.mcpkit', 'skill-backups'))).toBe(false);
    });

    // One skill folder, or one SKILL.md, linked instead of the whole skills directory; claude-code stays on per-server skills, codex moves.
    describe.each(['folder', 'file'] as const)('a skill %s that two agents read through a symlink', (level) => {
      beforeEach(async () => {
        await mkdir(join(home, '.mcpkit'), { recursive: true });
        await writeFile(settingsFile(), 'version: 1\nskills:\n  agents:\n    claude-code: per-server\n', 'utf-8');
        await addServer(entry('github', ['claude-code', 'codex']));
      });

      it('keeps the real skill of the agent that moves when the agent that stays links to it', async () => {
        const { link, real } = await linkSkill('claude-code', 'codex', 'github', level);

        await run('skills', 'guide', '--agent', 'codex');

        expect(exitSpy).not.toHaveBeenCalled();
        expect(await readFile(real.path, 'utf-8')).toBe(real.content);
        expect(await readFile((await generatedSkill('claude-code', 'github')).path, 'utf-8')).toBe(real.content);
        expect((await lstat(link)).isSymbolicLink()).toBe(true);
        expect(stdout()).toContain(`codex: keep ${real.dir} (it is the same file as the per-server skill of claude-code)`);
        expect(existsSync(join(home, '.mcpkit', 'skill-backups'))).toBe(false);
      });

      it('keeps the link of the agent that moves, and the real skill of the agent that stays', async () => {
        const { link, real } = await linkSkill('codex', 'claude-code', 'github', level);

        await run('skills', 'guide', '--agent', 'codex');

        expect(exitSpy).not.toHaveBeenCalled();
        expect(await readFile(real.path, 'utf-8')).toBe(real.content);
        expect((await lstat(link)).isSymbolicLink()).toBe(true);
        expect(stdout()).toContain(`codex: keep ${(await generatedSkill('codex', 'github')).dir} (${level === 'folder' ? 'it is a symlink' : 'its SKILL.md is not a regular file'})`);
        expect(existsSync(join(home, '.mcpkit', 'skill-backups'))).toBe(false);
      });
    });

    it('only governs global skills: project skills are not looked at', async () => {
      const project = join(home, 'project');
      await mkdir(join(project, '.claude', 'skills', 'mcpkit-demo'), { recursive: true });
      const projectSkill = join(project, '.claude', 'skills', 'mcpkit-demo', 'SKILL.md');
      await writeFile(projectSkill, (await generatedSkill('claude-code', 'demo')).content, 'utf-8');
      vi.spyOn(process, 'cwd').mockReturnValue(project);

      await run('skills', 'guide', '--agent', 'claude-code');

      expect(existsSync(projectSkill)).toBe(true);
    });
  });

  describe('--dry-run', () => {
    it('prints what it would create, back up and remove, and writes nothing at all', async () => {
      await addServer(entry('github'));
      await addServer(entry('slack-me'));
      const github = await writeGeneratedSkill('claude-code', 'github');
      const slack = await writeGeneratedSkill('claude-code', 'slack-me');
      const notes = await writeUserSkill('claude-code', 'mcpkit-notes');
      const before = await treeOf(home);

      await run('skills', 'guide', '--agent', 'claude-code', '--dry-run');

      expect(exitSpy).not.toHaveBeenCalled();
      expect(await treeOf(home)).toEqual(before);
      expect(existsSync(settingsFile())).toBe(false);
      expect(existsSync(join(home, '.mcpkit', 'skill-backups'))).toBe(false);
      const text = stdout();
      expect(text).toContain('dry-run');
      expect(text).toContain(join(skillsDir(), 'mcpkit-cli', 'SKILL.md'));
      expect(text).toContain(`remove ${github.dir}`);
      expect(text).toContain(`remove ${slack.dir}`);
      expect(text).toContain(join(home, '.mcpkit', 'skill-backups'));
      expect(text).toMatch(new RegExp(`keep ${notes.dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*not written by mcpkit`));
      expect(text).toContain(settingsFile());
    });

    it('writes nothing on a home that has no .mcpkit yet', async () => {
      await run('skills', 'guide', '--dry-run');
      await run('skills', 'per-server', '--agent', 'cursor', '--dry-run');
      expect(await readdir(home)).toEqual([]);
    });

    it('lists the servers it would regenerate for a switch back to per-server', async () => {
      await addServer(entry('github'));
      await addServer(entry('other', ['cursor']));
      await mkdir(join(home, '.mcpkit'), { recursive: true });
      await writeFile(settingsFile(), 'version: 1\nskills:\n  agents:\n    claude-code: guide\n', 'utf-8');
      const before = await treeOf(home);

      await run('skills', 'per-server', '--agent', 'claude-code', '--dry-run');

      expect(await treeOf(home)).toEqual(before);
      expect(stdout()).toContain('github');
      expect(stdout()).not.toContain('other');
      expect(vi.mocked(discoverForEntry)).not.toHaveBeenCalled();
    });
  });

  describe('switching back to per-server', () => {
    it('saves the setting, then regenerates the skills of that agent only, through sync', async () => {
      await addServer(entry('github', ['claude-code', 'cursor']));
      await addServer(entry('slack-me', ['claude-code']));
      await run('skills', 'guide', '--agent', 'claude-code');
      expect(existsSync(join(skillsDir(), 'mcpkit-github'))).toBe(false);
      const cursorBefore = existsSync(join(skillsDir('.cursor'), 'mcpkit-github'));

      await run('skills', 'per-server', '--agent', 'claude-code');

      expect(exitSpy).not.toHaveBeenCalled();
      expect(parse(await readFile(settingsFile(), 'utf-8'))).toEqual({ version: 1, skills: { agents: { 'claude-code': 'per-server' } } });
      for (const name of ['github', 'slack-me']) {
        const skill = await generatedSkill('claude-code', name);
        expect(await readFile(skill.path, 'utf-8')).toContain(`name: mcpkit-${name}`);
      }
      expect(await readFile(join(skillsDir(), 'mcpkit-cli', 'SKILL.md'), 'utf-8')).toBe(buildMetaSkillContent());
      // Other agents are not part of this switch.
      expect(existsSync(join(skillsDir('.cursor'), 'mcpkit-github'))).toBe(cursorBefore);
      expect(vi.mocked(discoverForEntry)).toHaveBeenCalledTimes(2);
    });

    it('exits 1 and says how to retry when a server cannot be regenerated, after saving the setting', async () => {
      await addServer(entry('github'));
      await run('skills', 'guide', '--agent', 'claude-code');
      vi.mocked(discoverForEntry).mockRejectedValue(new Error('connection refused'));

      await run('skills', 'per-server', '--agent', 'claude-code');

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(stderr()).toContain('mcpkit sync --force');
      expect(parse(await readFile(settingsFile(), 'utf-8'))).toMatchObject({ skills: { agents: { 'claude-code': 'per-server' } } });
    });
  });

  describe('switching back to per-server, with a server that needs OAuth sign-in', () => {
    it('regenerates the others, names the skipped server and how to sign in, and does not exit 1 for it', async () => {
      await addServer(entry('github'));
      await addServer(entry('needs-login'));
      await run('skills', 'guide', '--agent', 'claude-code');
      vi.mocked(discoverForEntry).mockImplementation(async (server) => {
        if (server.name === 'needs-login') throw new OAuthRequiredError(server.name);
        return { tools, serverMeta: { name: 'srv' } };
      });

      await run('skills', 'per-server', '--agent', 'claude-code');

      expect(exitSpy).not.toHaveBeenCalled();
      expect(vi.mocked(discoverForEntry).mock.calls.map(([, opts]) => opts.interactiveAuth)).toEqual([false, false]);
      expect(existsSync((await generatedSkill('claude-code', 'github')).path)).toBe(true);
      expect(existsSync((await generatedSkill('claude-code', 'needs-login')).path)).toBe(false);
      expect(warnings.join('\n')).toContain('needs-login: needs sign-in (mcpkit auth needs-login); skipped');
      expect(warnings.join('\n')).toContain('1 server(s) need sign-in and were not regenerated: needs-login');
    });
  });

  describe('the default for all agents', () => {
    it('migrates only the agents that registered servers use, and not the ones that never had skills', async () => {
      await addServer(entry('github', ['claude-code']));
      const github = await writeGeneratedSkill('claude-code', 'github');

      await run('skills', 'guide');

      expect(existsSync(github.dir)).toBe(false);
      expect(existsSync(join(skillsDir(), 'mcpkit-cli', 'SKILL.md'))).toBe(true);
      expect(existsSync(join(home, '.cursor'))).toBe(false);
      expect(existsSync(join(home, '.codex'))).toBe(false);
      expect(parse(await readFile(settingsFile(), 'utf-8'))).toEqual({ version: 1, skills: { default: 'guide' } });
    });

    it('leaves an agent that has its own per-server entry alone', async () => {
      await addServer(entry('github', ['claude-code', 'cursor']));
      const cursorGithub = await writeGeneratedSkill('cursor', 'github');
      await writeGeneratedSkill('claude-code', 'github');
      await mkdir(join(home, '.mcpkit'), { recursive: true });
      await writeFile(settingsFile(), 'version: 1\nskills:\n  agents:\n    cursor: per-server\n', 'utf-8');

      await run('skills', 'guide');

      expect(await readFile(cursorGithub.path, 'utf-8')).toBe(cursorGithub.content);
      expect(existsSync((await generatedSkill('claude-code', 'github')).dir)).toBe(false);
      expect(parse(await readFile(settingsFile(), 'utf-8'))).toEqual({
        version: 1,
        skills: { default: 'guide', agents: { cursor: 'per-server' } },
      });
    });

    it('says so when no agent changes mode', async () => {
      await run('skills', 'per-server');
      expect(stdout()).toMatch(/no agent|nothing to/i);
      expect(exitSpy).not.toHaveBeenCalled();
    });
  });

  describe('MCPKIT_SKILLS', () => {
    it('keeps the saved setting but migrates nothing when it points the other way, and says so', async () => {
      await addServer(entry('github'));
      const github = await writeGeneratedSkill('claude-code', 'github');
      process.env.MCPKIT_SKILLS = 'per-server';

      await run('skills', 'guide', '--agent', 'claude-code');

      expect(exitSpy).not.toHaveBeenCalled();
      expect(stderr()).toContain('MCPKIT_SKILLS');
      expect(await readFile(github.path, 'utf-8')).toBe(github.content);
      expect(parse(await readFile(settingsFile(), 'utf-8'))).toMatchObject({ skills: { agents: { 'claude-code': 'guide' } } });
    });

    it('does the migration when it already says the same', async () => {
      await addServer(entry('github'));
      const github = await writeGeneratedSkill('claude-code', 'github');
      process.env.MCPKIT_SKILLS = 'guide';

      await run('skills', 'guide', '--agent', 'claude-code');

      expect(existsSync(github.dir)).toBe(false);
    });
  });

  describe('warnings', () => {
    it('warns, exit code 0, when claude-code has no SessionStart hook, and names the two ways out', async () => {
      await run('skills', 'guide', '--agent', 'claude-code');

      expect(exitSpy).not.toHaveBeenCalled();
      expect(stderr()).toContain('mcpkit hook install --write');
      expect(stderr()).toContain('CLAUDE.md');
      expect(stderr()).toContain('guide');
    });

    it('does not warn when the hook is installed', async () => {
      await writeHook();
      await run('skills', 'guide', '--agent', 'claude-code');
      expect(stderr()).not.toContain('mcpkit hook install');
    });

    it('recognises a hook written by an earlier version (the bare command)', async () => {
      await writeHook('mcpkit hook session-start');
      await run('skills', 'guide', '--agent', 'claude-code');
      expect(stderr()).not.toContain('mcpkit hook install');
    });

    it('warns when the Claude settings file is missing, invalid, or has an unrelated hook', async () => {
      await run('skills', 'guide', '--agent', 'claude-code');
      expect(stderr()).toContain('mcpkit hook install --write');

      warnings = [];
      await mkdir(join(home, '.claude'), { recursive: true });
      await writeFile(join(home, '.claude', 'settings.json'), '{ not json', 'utf-8');
      await run('skills', 'guide', '--agent', 'claude-code');
      expect(stderr()).toContain('mcpkit hook install --write');
      expect(await readFile(join(home, '.claude', 'settings.json'), 'utf-8')).toBe('{ not json');

      warnings = [];
      await writeHook('echo something else');
      await run('skills', 'guide', '--agent', 'claude-code');
      expect(stderr()).toContain('mcpkit hook install --write');
    });

    it.each(['codex', 'cursor', 'windsurf', 'augment', 'openclaw', 'hermes'] as const)('warns that %s has no session hook, so it gets only the guide', async (agent) => {
      await writeHook();
      await run('skills', 'guide', '--agent', agent);

      expect(exitSpy).not.toHaveBeenCalled();
      expect(stderr()).toContain(`no session hook for ${agent}`);
      expect(stderr()).not.toContain('mcpkit hook install --write');
    });

    it('does not warn when switching to per-server', async () => {
      await run('skills', 'per-server', '--agent', 'cursor');
      expect(stderr()).toBe('');
    });

    it('names the missing hook on a dry run too', async () => {
      await run('skills', 'guide', '--agent', 'claude-code', '--dry-run');
      expect(stderr()).toContain('mcpkit hook install --write');
    });
  });

  describe('lean', () => {
    async function layout() {
      await addServer(entry('github', ['claude-code', 'cursor']));
      await addServer(entry('slack-me', ['claude-code']));
      const github = await writeGeneratedSkill('claude-code', 'github');
      const slack = await writeGeneratedSkill('claude-code', 'slack-me');
      const cursorGithub = await writeGeneratedSkill('cursor', 'github');
      return { github, slack, cursorGithub };
    }

    it('is described as the lean mode: only the guide, no per-server skills', () => {
      const lean = createConfigCommand().commands.find((command) => command.name() === 'lean');

      expect(lean).toBeDefined();
      expect(lean?.description()).toContain('lean = only the mcpkit-cli guide, no per-server skills');
      expect(lean?.helpInformation()).toContain('--agent <agent>');
      expect(lean?.helpInformation()).toContain('--dry-run');
      expect(createConfigCommand().helpInformation()).toContain('lean');
    });

    it('on is `skills guide`: the same effects for one agent, and the guide lists the servers', async () => {
      const { github, slack, cursorGithub } = await layout();

      await run('lean', 'on', '--agent', 'claude-code');

      expect(exitSpy).not.toHaveBeenCalled();
      expect(existsSync(github.dir)).toBe(false);
      expect(existsSync(slack.dir)).toBe(false);
      expect(await readFile(cursorGithub.path, 'utf-8')).toBe(cursorGithub.content);
      expect(parse(await readFile(settingsFile(), 'utf-8'))).toEqual({ version: 1, skills: { agents: { 'claude-code': 'guide' } } });
      const guide = await readFile(join(skillsDir(), 'mcpkit-cli', 'SKILL.md'), 'utf-8');
      expect(guide).toContain('- github');
      expect(guide).toContain('- slack-me');
      expect(stdout()).toContain('Skills mode: claude-code -> guide');
    });

    it('on without --agent sets the default and migrates the agents in use, like `skills guide`', async () => {
      const { github, slack, cursorGithub } = await layout();

      await run('lean', 'on');

      expect(exitSpy).not.toHaveBeenCalled();
      expect(parse(await readFile(settingsFile(), 'utf-8'))).toEqual({ version: 1, skills: { default: 'guide' } });
      for (const skill of [github, slack, cursorGithub]) expect(existsSync(skill.dir)).toBe(false);
      expect(existsSync(join(skillsDir('.cursor'), 'mcpkit-cli', 'SKILL.md'))).toBe(true);
    });

    it('on, for an agent that was on per-server, still writes a guide that lists the servers: the guide is written before the mode is saved', async () => {
      await addServer(entry('github', ['claude-code']));
      await mkdir(join(home, '.mcpkit'), { recursive: true });
      await writeFile(settingsFile(), 'version: 1\nskills:\n  agents:\n    claude-code: per-server\n', 'utf-8');

      await run('lean', 'on', '--agent', 'claude-code');

      expect(parse(await readFile(settingsFile(), 'utf-8'))).toEqual({ version: 1, skills: { agents: { 'claude-code': 'guide' } } });
      const guide = await readFile(join(skillsDir(), 'mcpkit-cli', 'SKILL.md'), 'utf-8');
      expect(guide).toContain('- github');
      expect(guide).toBe(buildMetaSkillContent({ directory: buildGuideDirectory(await loadDirectoryServers('claude-code')) }));
    });

    it('on --dry-run prints exactly what `skills guide --dry-run` prints, and writes nothing', async () => {
      await layout();
      const before = await treeOf(home);

      await run('skills', 'guide', '--agent', 'claude-code', '--dry-run');
      const viaSkills = [...out];
      const warningsViaSkills = [...warnings];
      out = [];
      warnings = [];
      await run('lean', 'on', '--agent', 'claude-code', '--dry-run');

      expect(out).toEqual(viaSkills);
      expect(warnings).toEqual(warningsViaSkills);
      expect(stdout()).toContain('[dry-run] Nothing is written.');
      expect(await treeOf(home)).toEqual(before);
      expect(existsSync(settingsFile())).toBe(false);
    });

    it('off is `skills per-server`: it saves the setting and regenerates the skills of that agent', async () => {
      await addServer(entry('github', ['claude-code', 'cursor']));
      await run('lean', 'on', '--agent', 'claude-code');
      expect(existsSync(join(skillsDir(), 'mcpkit-github'))).toBe(false);

      await run('lean', 'off', '--agent', 'claude-code');

      expect(exitSpy).not.toHaveBeenCalled();
      expect(parse(await readFile(settingsFile(), 'utf-8'))).toEqual({ version: 1, skills: { agents: { 'claude-code': 'per-server' } } });
      expect(await readFile((await generatedSkill('claude-code', 'github')).path, 'utf-8')).toContain('name: mcpkit-github');
      // The guide is the generic one again.
      expect(await readFile(join(skillsDir(), 'mcpkit-cli', 'SKILL.md'), 'utf-8')).toBe(buildMetaSkillContent());
    });

    it('off --dry-run prints exactly what `skills per-server --dry-run` prints, and writes nothing', async () => {
      await addServer(entry('github'));
      await mkdir(join(home, '.mcpkit'), { recursive: true });
      await writeFile(settingsFile(), 'version: 1\nskills:\n  agents:\n    claude-code: guide\n', 'utf-8');
      const before = await treeOf(home);

      await run('skills', 'per-server', '--agent', 'claude-code', '--dry-run');
      const viaSkills = [...out];
      out = [];
      await run('lean', 'off', '--agent', 'claude-code', '--dry-run');

      expect(out).toEqual(viaSkills);
      expect(out.join('\n')).toContain('github');
      expect(await treeOf(home)).toEqual(before);
      expect(vi.mocked(discoverForEntry)).not.toHaveBeenCalled();
    });

    it('warns about a missing hook and about MCPKIT_SKILLS exactly as `skills guide` does', async () => {
      await layout();
      await run('lean', 'on', '--agent', 'claude-code');
      expect(stderr()).toContain('mcpkit hook install --write');

      warnings = [];
      process.env.MCPKIT_SKILLS = 'per-server';
      await run('lean', 'on', '--agent', 'claude-code');
      expect(stderr()).toContain('MCPKIT_SKILLS=per-server overrides the file');
    });

    it('refuses a state that is not on or off, with exit code 2 and nothing written', async () => {
      await run('lean', 'maybe');

      expect(exitSpy).toHaveBeenCalledWith(2);
      expect(stderr()).toContain('use on or off');
      expect(existsSync(join(home, '.mcpkit'))).toBe(false);
    });

    it('refuses an unknown agent like `skills` does, and a missing state is a usage error', async () => {
      await run('lean', 'on', '--agent', 'nonesuch');
      expect(exitSpy).toHaveBeenCalledWith(2);
      expect(stderr()).toContain('Unknown agent "nonesuch"');
      expect(existsSync(settingsFile())).toBe(false);
    });

    it('is shown by `mcpkit config` as an explicit setting once it was used, and the built-in default before', async () => {
      await run();
      expect(stdout()).toMatch(/claude-code\s+guide\s+built-in default/);

      out = [];
      await run('lean', 'on', '--agent', 'claude-code');
      out = [];
      await run('skills');
      expect(stdout()).toMatch(/claude-code\s+guide\s+file \(agents\.claude-code\)/);
      expect(stdout()).toMatch(/cursor\s+guide\s+built-in default/);
    });
  });
});
