import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { createConfigCommand } from './config.js';
import { addServer } from '../config.js';
import { discoverForEntry } from '../discover.js';
import { buildMetaSkillContent } from '../meta-skill.js';
import { OAuthRequiredError } from '../oauth-required-error.js';
import { generatedSkill, treeOf, writeGeneratedSkill, writeUserSkill } from '../skill-fixtures.js';
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
        expect(stdout()).toMatch(new RegExp(`${agent}\\s+per-server\\s+default`));
      }
      expect(exitSpy).not.toHaveBeenCalled();
      expect(existsSync(join(home, '.mcpkit'))).toBe(false);
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
      expect(stdout()).toMatch(/claude-code\s+per-server\s+default/);
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
      expect(stdout()).toMatch(/claude-code\s+per-server\s+default/);
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
      expect(await readFile(join(skillsDir(), 'mcpkit-cli', 'SKILL.md'), 'utf-8')).toBe(buildMetaSkillContent());
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
});
