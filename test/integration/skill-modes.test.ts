import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { parse, stringify } from 'yaml';
import { buildSkillContent } from '../../src/generators/index.js';
import { buildGuideDirectory } from '../../src/guide-directory.js';
import { buildMetaSkillContent } from '../../src/meta-skill.js';
import { skillContext } from '../../src/skill-fixtures.js';

/**
 * Skill modes through the real built CLI (dist/cli.js, built once by the vitest global setup) with a
 * throwaway HOME that holds a fake registry of three servers (the fixture stdio server), generated
 * and hand-written skills under ~/.claude/skills, and no hook. Nothing here can reach the real
 * ~/.mcpkit or ~/.claude: every process gets HOME and USERPROFILE of the temporary directory.
 */

const root = fileURLToPath(new URL('../../', import.meta.url));
const cliPath = join(root, 'dist', 'cli.js');
const fixturePath = join(root, 'test', 'fixtures', 'fixture-server.mjs');

vi.setConfig({ testTimeout: 120_000 });

let home: string;
let work: string;

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function cli(args: string[], extra: NodeJS.ProcessEnv = {}): CliResult {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.MCPKIT_SKILLS;
  Object.assign(env, extra);
  const run = spawnSync(process.execPath, [cliPath, ...args], { cwd: work, env, input: '', encoding: 'utf-8', timeout: 120_000 });
  return { code: run.status, stdout: run.stdout, stderr: run.stderr };
}

const skillsDir = () => join(home, '.claude', 'skills');
const skillFile = (dir: string) => join(skillsDir(), dir, 'SKILL.md');
const settingsFile = () => join(home, '.mcpkit', 'config.yaml');

/** Every path under `dir` with the content of each file, sorted. */
function tree(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .map((entry) => {
      const path = join(entry.parentPath, entry.name);
      return entry.isFile() ? `${path} ${readFileSync(path, 'utf-8')}` : `${path}/`;
    })
    .sort();
}

function registryEntry(name: string): Record<string, unknown> {
  const now = '2026-01-01T00:00:00.000Z';
  return {
    name,
    transport: { type: 'stdio', command: process.execPath, args: [fixturePath] },
    toolCount: 5,
    agents: ['claude-code'],
    agentSelectionMode: 'explicit',
    createdAt: now,
    updatedAt: now,
  };
}

function writeSkill(dir: string, content: string): void {
  mkdirSync(join(skillsDir(), dir), { recursive: true });
  writeFileSync(skillFile(dir), content, 'utf-8');
}

/** The version the built CLI writes into the marker of a guide. */
const pkgVersion = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')) as { version: string }).version;

/** The guide the CLI writes for an agent in guide mode that serves the fake registry's servers: the same inputs, built here. */
function guideListing(names: string[]): string {
  const tools = [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object' } }];
  return buildMetaSkillContent({ directory: buildGuideDirectory(names.map((name) => ({ name, tools }))), pkgVersion });
}

const USER_NOTES = '---\nname: mcpkit-journal\ndescription: "My own journal skill"\n---\n\n# Journal\n';

beforeAll(() => {
  expect(existsSync(cliPath), `${cliPath} must be built by the vitest global setup`).toBe(true);
  home = mkdtempSync(join(realpathSync(tmpdir()), 'mcpkit-modes-e2e-'));
  work = join(home, 'work');
  mkdirSync(work, { recursive: true });
  mkdirSync(join(home, '.mcpkit', 'schemas'), { recursive: true });
  const servers = Object.fromEntries(['github', 'slack-me', 'notes'].map((name) => [name, registryEntry(name)]));
  writeFileSync(join(home, '.mcpkit', 'servers.yaml'), stringify({ version: 1, servers }), 'utf-8');
  for (const name of Object.keys(servers)) {
    writeFileSync(join(home, '.mcpkit', 'schemas', `${name}.json`), JSON.stringify({
      version: 1,
      server: name,
      fetchedAt: '2026-01-01T00:00:00.000Z',
      tools: [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object' } }],
    }), 'utf-8');
  }
  // What an earlier `mcpkit install` left, plus a skill somebody wrote by hand under a name of the same shape.
  writeSkill('mcpkit-github', buildSkillContent(skillContext('github')));
  writeSkill('mcpkit-slack-me', buildSkillContent(skillContext('slack-me')));
  writeSkill('mcpkit-journal', USER_NOTES);
  writeSkill('mcpkit-cli', buildMetaSkillContent());
  // Another agent in use, so that a migration of claude-code can be seen leaving it alone.
  mkdirSync(join(home, '.cursor', 'skills', 'mcpkit-github'), { recursive: true });
  writeFileSync(join(home, '.cursor', 'skills', 'mcpkit-github', 'SKILL.md'), buildSkillContent(skillContext('github')), 'utf-8');
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

it('walks an agent from per-server skills to the guide and back through the real CLI', () => {
  // 1. Nothing is set: every agent is on the built-in default, the guide, and showing the setting creates nothing.
  const before = tree(home);
  const show = cli(['config']);
  expect(show.code).toBe(0);
  expect(show.stdout).toMatch(/claude-code\s+guide\s+built-in default/);
  expect(show.stdout).toContain(settingsFile());
  expect(tree(home)).toEqual(before);

  // 2. A dry run says what it would do and writes nothing: not the settings, not a backup.
  const dry = cli(['config', 'skills', 'guide', '--agent', 'claude-code', '--dry-run']);
  expect(dry.code).toBe(0);
  expect(dry.stdout).toContain(`remove ${join(skillsDir(), 'mcpkit-github')}`);
  expect(dry.stdout).toContain(`remove ${join(skillsDir(), 'mcpkit-slack-me')}`);
  expect(dry.stdout).toMatch(/keep .*mcpkit-journal/);
  expect(dry.stdout).not.toMatch(/remove .*mcpkit-cli/);
  expect(tree(home)).toEqual(before);
  expect(existsSync(settingsFile())).toBe(false);

  // 3. For real: the generated skills go (after a backup), everything else stays, the guide is there.
  const cursorBefore = tree(join(home, '.cursor'));
  const guide = cli(['config', 'skills', 'guide', '--agent', 'claude-code']);
  expect(guide.code).toBe(0);
  expect(guide.stderr).toContain('mcpkit hook install --write');
  expect(existsSync(join(skillsDir(), 'mcpkit-github'))).toBe(false);
  expect(existsSync(join(skillsDir(), 'mcpkit-slack-me'))).toBe(false);
  expect(readFileSync(skillFile('mcpkit-journal'), 'utf-8')).toBe(USER_NOTES);
  // The guide of an agent in guide mode lists the servers of the registry that serve it.
  expect(readFileSync(skillFile('mcpkit-cli'), 'utf-8')).toBe(guideListing(['github', 'slack-me', 'notes']));
  expect(tree(join(home, '.cursor'))).toEqual(cursorBefore);
  expect(statSync(settingsFile()).mode & 0o777).toBe(0o600);
  expect(parse(readFileSync(settingsFile(), 'utf-8'))).toEqual({ version: 1, skills: { agents: { 'claude-code': 'guide' } } });

  const [stamp, ...otherBackups] = readdirSync(join(home, '.mcpkit', 'skill-backups'));
  expect(otherBackups).toEqual([]);
  expect(guide.stdout).toContain(join(home, '.mcpkit', 'skill-backups', stamp));
  for (const name of ['github', 'slack-me']) {
    const copy = join(home, '.mcpkit', 'skill-backups', stamp, 'claude-code', `mcpkit-${name}`, 'SKILL.md');
    expect(readFileSync(copy, 'utf-8')).toBe(buildSkillContent(skillContext(name)));
    expect(statSync(copy).mode & 0o777).toBe(0o600);
  }

  // 4. The setting is shown, and the environment beats it.
  expect(cli(['config', 'skills']).stdout).toMatch(/claude-code\s+guide\s+file/);
  expect(cli(['config', 'skills'], { MCPKIT_SKILLS: 'per-server' }).stdout).toMatch(/claude-code\s+per-server\s+env/);

  // 5. A plain sync neither reconnects to the servers nor brings the skills back.
  const sync = cli(['sync']);
  expect(sync.code).toBe(0);
  expect(existsSync(join(skillsDir(), 'mcpkit-github'))).toBe(false);
  expect(readFileSync(skillFile('mcpkit-cli'), 'utf-8')).toBe(guideListing(['github', 'slack-me', 'notes']));

  // 6. An install writes no per-server skill for the agent either, but registers the server.
  const install = cli(['install', `${process.execPath} ${fixturePath}`, '-n', 'fixture', '-a', 'claude-code']);
  expect(install.code, install.stderr).toBe(0);
  expect(existsSync(join(skillsDir(), 'mcpkit-fixture'))).toBe(false);
  expect(readFileSync(join(home, '.mcpkit', 'servers.yaml'), 'utf-8')).toContain('fixture:');
  expect(existsSync(join(home, '.mcpkit', 'schemas', 'fixture.json'))).toBe(true);

  // 7. A project-scope install keeps writing its skill into the project.
  const project = cli(['install', `${process.execPath} ${fixturePath}`, '-n', 'projected', '-a', 'claude-code', '--scope', 'project']);
  expect(project.code, project.stderr).toBe(0);
  expect(existsSync(join(work, '.claude', 'skills', 'mcpkit-projected', 'SKILL.md'))).toBe(true);
  expect(existsSync(join(skillsDir(), 'mcpkit-projected'))).toBe(false);

  // 8. The way back: the setting changes first, then the per-server skills are regenerated through sync.
  const back = cli(['config', 'skills', 'per-server', '--agent', 'claude-code']);
  expect(back.code, back.stderr).toBe(0);
  expect(parse(readFileSync(settingsFile(), 'utf-8'))).toEqual({ version: 1, skills: { agents: { 'claude-code': 'per-server' } } });
  for (const name of ['github', 'slack-me', 'notes', 'fixture']) {
    expect(readFileSync(skillFile(`mcpkit-${name}`), 'utf-8'), name).toContain(`name: mcpkit-${name}`);
  }
  expect(readFileSync(skillFile('mcpkit-journal'), 'utf-8')).toBe(USER_NOTES);
  // An agent back on per-server skills gets the generic guide again, with no server list.
  expect(readFileSync(skillFile('mcpkit-cli'), 'utf-8')).toBe(buildMetaSkillContent({ pkgVersion }));
});
