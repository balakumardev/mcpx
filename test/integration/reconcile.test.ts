import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { parse, stringify } from 'yaml';
import { buildSkillContent } from '../../src/generators/index.js';
import { buildMetaSkillContent } from '../../src/meta-skill.js';
import { skillContext } from '../../src/skill-fixtures.js';

/**
 * The start-up reconcile through the real built CLI (dist/cli.js, built once by the vitest global
 * setup): what an upgrader sees on the first command after the upgrade, what a new user gets with
 * the first install, and what must not happen (a command that must stay quiet, an explicit setting,
 * a file that cannot be trusted, five processes at once). Every process gets a throwaway HOME and
 * USERPROFILE; nothing here can reach the real ~/.mcpkit or ~/.claude.
 */

const root = fileURLToPath(new URL('../../', import.meta.url));
const cliPath = join(root, 'dist', 'cli.js');
const fixturePath = join(root, 'test', 'fixtures', 'fixture-server.mjs');

vi.setConfig({ testTimeout: 120_000 });

const homes: string[] = [];

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function makeHome(): string {
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'mcpkit-reconcile-e2e-'));
  homes.push(home);
  return home;
}

function envFor(home: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.MCPKIT_SKILLS;
  delete env.MCPKIT_NO_MIGRATE;
  delete env.HERMES_HOME;
  return Object.assign(env, extra);
}

/** The working directory is outside the home: a command that writes to its cwd must not look like a write to the home. */
const work = mkdtempSync(join(realpathSync(tmpdir()), 'mcpkit-reconcile-work-'));

function cli(home: string, args: string[], extra: NodeJS.ProcessEnv = {}): CliResult {
  const run = spawnSync(process.execPath, [cliPath, ...args], { cwd: work, env: envFor(home, extra), input: '', encoding: 'utf-8', timeout: 120_000 });
  return { code: run.status, stdout: run.stdout, stderr: run.stderr };
}

function cliAsync(home: string, args: string[]): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], { cwd: work, env: envFor(home), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

beforeAll(() => {
  expect(existsSync(cliPath), `${cliPath} must be built by the vitest global setup`).toBe(true);
});

afterEach(() => {
  while (homes.length > 0) rmSync(homes.pop() as string, { recursive: true, force: true });
});

const agentRoot = (home: string, agent: 'claude-code' | 'cursor'): string => join(home, agent === 'claude-code' ? '.claude' : '.cursor', 'skills');
const guideOf = (home: string, agent: 'claude-code' | 'cursor'): string => join(agentRoot(home, agent), 'mcpkit-cli', 'SKILL.md');
const skillDirs = (home: string, agent: 'claude-code' | 'cursor'): string[] => (existsSync(agentRoot(home, agent)) ? readdirSync(agentRoot(home, agent)).sort() : []);
const stateOf = (home: string): { adopted: Record<string, { at: string; by: string; removed: number; backup: string | null; deferred: string[] }>; hookDeclined: boolean; fingerprint?: string; refreshFingerprint?: string } =>
  JSON.parse(readFileSync(join(home, '.mcpkit', 'state.json'), 'utf-8'));
const backupsOf = (home: string): string[] => (existsSync(join(home, '.mcpkit', 'skill-backups')) ? readdirSync(join(home, '.mcpkit', 'skill-backups')).sort() : []);

/** Every path under `dir` with its size and modification time (and the content of a file, so a rewrite with the same size shows). */
function snapshot(dir: string): string[] {
  if (!existsSync(dir)) return [];
  if (statSync(dir).isFile()) return [`${dir} ${statSync(dir).size} ${readFileSync(dir, 'utf-8')} ${statSync(dir).mtimeMs}`];
  const rows = readdirSync(dir, { recursive: true, encoding: 'utf-8' }).map((name) => {
    const info = statSync(join(dir, name));
    return `${name} ${info.isDirectory() ? 'dir' : `${info.size} ${readFileSync(join(dir, name), 'utf-8')}`} ${info.mtimeMs}`;
  });
  return rows.sort();
}

function entry(name: string): Record<string, unknown> {
  const now = '2026-01-01T00:00:00.000Z';
  return {
    name,
    description: `The ${name} server`,
    transport: { type: 'stdio', command: process.execPath, args: [fixturePath] },
    toolCount: 7,
    agents: ['claude-code', 'cursor'],
    agentSelectionMode: 'explicit',
    createdAt: now,
    updatedAt: now,
  };
}

const echoTool = { name: 'echo', description: 'Return the message it is given.', inputSchema: { type: 'object', properties: { message: { type: 'string' } } } };

function writeCache(home: string, name: string): void {
  mkdirSync(join(home, '.mcpkit', 'schemas'), { recursive: true });
  writeFileSync(join(home, '.mcpkit', 'schemas', `${name}.json`), JSON.stringify({ version: 1, server: name, fetchedAt: '2026-01-01T00:00:00.000Z', tools: [echoTool] }));
}

function writeSkill(home: string, agent: 'claude-code' | 'cursor', dir: string, content: string): void {
  mkdirSync(join(agentRoot(home, agent), dir), { recursive: true });
  writeFileSync(join(agentRoot(home, agent), dir, 'SKILL.md'), content);
}

const USER_NOTES = '---\nname: mcpkit-notes\ndescription: "My own notes skill"\n---\n\n# Notes\n';
const OTHER_HOOK = { matcher: 'startup', hooks: [{ type: 'command', command: 'echo other-hook' }] };

/**
 * What a user of the previous mcpkit has: four registered servers (a and b have a schema cache, c and
 * d have none: the previous mcpkit never wrote one), a generated skill for each in Claude Code and
 * Cursor, a skill the user wrote, the old static guide, and a settings.json with hooks of their own.
 */
function upgraderHome(): string {
  const home = makeHome();
  mkdirSync(join(home, '.mcpkit'), { recursive: true });
  writeFileSync(join(home, '.mcpkit', 'servers.yaml'), stringify({ version: 1, servers: Object.fromEntries(['a', 'b', 'c', 'd'].map((name) => [name, entry(name)])) }));
  writeCache(home, 'a');
  writeCache(home, 'b');
  for (const agent of ['claude-code', 'cursor'] as const) {
    for (const name of ['a', 'b', 'c', 'd']) writeSkill(home, agent, `mcpkit-${name}`, buildSkillContent(skillContext(name)));
    writeSkill(home, agent, 'mcpkit-notes', USER_NOTES);
    writeSkill(home, agent, 'mcpkit-cli', buildMetaSkillContent());
  }
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(join(home, '.claude', 'settings.json'), `${JSON.stringify({ model: 'opus', hooks: { SessionStart: [OTHER_HOOK], Stop: [OTHER_HOOK] } }, null, 2)}\n`);
  return home;
}

const NOTICE_HEADER = 'mcpkit: skills are now lean by default: one mcpkit-cli guide with a live server list instead of one skill per server.';

describe('a new user', () => {
  it('sees no file written by a command that has nothing to reconcile, and gets the guide and the hook with the first install', () => {
    const home = makeHome();

    for (const args of [['list'], ['--version'], ['--help'], ['search', 'x'], ['hook', 'session-start'], ['config']]) {
      const run = cli(home, args);
      expect(run.code, `${args.join(' ')}: ${run.stderr}`).toBeLessThan(2);
      expect(readdirSync(home), args.join(' ')).toEqual([]);
    }

    const spec = JSON.stringify({ mcpServers: { fx: { command: process.execPath, args: [fixturePath] } } });
    const install = cli(home, ['install', spec, '--agent', 'claude-code']);

    expect(install.code, install.stderr).toBe(0);
    expect(install.stderr).toBe([
      NOTICE_HEADER,
      '  claude-code: added the SessionStart hook (undo: mcpkit hook uninstall --write).',
      '  Prefer one skill per server? mcpkit config lean off   (or set MCPKIT_SKILLS=per-server)',
      '',
    ].join('\n'));
    expect(skillDirs(home, 'claude-code')).toEqual(['mcpkit-cli']);
    const guide = readFileSync(guideOf(home, 'claude-code'), 'utf-8');
    expect(guide).toContain('## MCP servers reachable through mcpkit (live list)');
    expect(guide).toContain('- fx (7 tools');
    const settings = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf-8')) as { hooks: { SessionStart: unknown[] } };
    expect(settings.hooks.SessionStart).toHaveLength(1);
    expect(stateOf(home).adopted['claude-code']).toMatchObject({ removed: 0, backup: null, deferred: [] });
    expect(existsSync(join(home, '.cursor'))).toBe(false);

    // The second server is a change like the first: the guide lists it, and there is nothing more to say.
    const second = cli(home, ['install', JSON.stringify({ mcpServers: { fy: { command: process.execPath, args: [fixturePath] } } }), '--agent', 'claude-code']);
    expect(second.code, second.stderr).toBe(0);
    expect(second.stderr).toBe('');
    expect(readFileSync(guideOf(home, 'claude-code'), 'utf-8')).toContain('- fy (7 tools');
    expect((JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf-8')) as { hooks: { SessionStart: unknown[] } }).hooks.SessionStart).toHaveLength(1);
  });

  it('a server removed later disappears from the guide at once', () => {
    const home = makeHome();
    cli(home, ['install', JSON.stringify({ mcpServers: { fx: { command: process.execPath, args: [fixturePath] }, fy: { command: process.execPath, args: [fixturePath] } } }), '--agent', 'claude-code']);
    expect(readFileSync(guideOf(home, 'claude-code'), 'utf-8')).toContain('- fy (');

    const removed = cli(home, ['remove', 'fy']);

    expect(removed.code, removed.stderr).toBe(0);
    const guide = readFileSync(guideOf(home, 'claude-code'), 'utf-8');
    expect(guide).toContain('- fx (');
    expect(guide).not.toContain('- fy (');
  });
});

describe('an upgrader', () => {
  it('first `list`: the notice is on stderr, stdout is the normal output, two skills per agent are backed up and removed, two are kept, the hook is added once', () => {
    const home = upgraderHome();
    const normal = cli(home, ['list'], { MCPKIT_NO_MIGRATE: '1' });
    expect(normal.code, normal.stderr).toBe(0);
    expect(normal.stderr).toBe('');
    expect(snapshot(join(home, '.mcpkit')).some((row) => row.startsWith('state.json'))).toBe(false);

    const first = cli(home, ['list']);

    expect(first.code, first.stderr).toBe(0);
    expect(first.stdout).toBe(normal.stdout);
    const [backup] = backupsOf(home);
    expect(backupsOf(home)).toHaveLength(1);
    const lines = first.stderr.trimEnd().split('\n');
    expect(lines[0]).toBe(NOTICE_HEADER);
    expect(lines).toContain(`  claude-code: moved 2 per-server skills to ${join(home, '.mcpkit', 'skill-backups', backup)} (copy a folder back to restore one).`);
    expect(lines).toContain(`  cursor: moved 2 per-server skills to ${join(home, '.mcpkit', 'skill-backups', backup)} (copy a folder back to restore one).`);
    expect(lines).toContain('  claude-code: added the SessionStart hook (undo: mcpkit hook uninstall --write).');
    expect(lines).toContain('  4 skills kept for servers whose tools are not indexed yet; they are removed automatically after you run: mcpkit update');
    expect(lines.at(-1)).toBe('  Prefer one skill per server? mcpkit config lean off   (or set MCPKIT_SKILLS=per-server)');

    for (const agent of ['claude-code', 'cursor'] as const) {
      expect(skillDirs(home, agent)).toEqual(['mcpkit-c', 'mcpkit-cli', 'mcpkit-d', 'mcpkit-notes']);
      expect(readFileSync(join(agentRoot(home, agent), 'mcpkit-notes', 'SKILL.md'), 'utf-8')).toBe(USER_NOTES);
      expect(readFileSync(guideOf(home, agent), 'utf-8')).toContain('## MCP servers reachable through mcpkit (live list)');
      expect(readdirSync(join(home, '.mcpkit', 'skill-backups', backup, agent)).sort()).toEqual(['mcpkit-a', 'mcpkit-b']);
      expect(stateOf(home).adopted[agent]).toMatchObject({ removed: 2, backup: join(home, '.mcpkit', 'skill-backups', backup), deferred: ['c', 'd'] });
    }

    const settings = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf-8')) as { model: string; hooks: { SessionStart: unknown[]; Stop: unknown[] } };
    expect(settings.model).toBe('opus');
    expect(settings.hooks.Stop).toEqual([OTHER_HOOK]);
    expect(settings.hooks.SessionStart).toHaveLength(2);
    expect(settings.hooks.SessionStart[0]).toEqual(OTHER_HOOK);
    expect(readdirSync(join(home, '.claude')).filter((name) => name.includes('.mcpkit-bak-'))).toHaveLength(1);
  });

  it('the second run changes no file under the agent directories or ~/.mcpkit, and prints nothing', () => {
    const home = upgraderHome();
    expect(cli(home, ['list']).code).toBe(0);
    const before = [snapshot(join(home, '.claude')), snapshot(join(home, '.cursor')), snapshot(join(home, '.mcpkit'))];

    const second = cli(home, ['list']);

    expect(second.code, second.stderr).toBe(0);
    expect(second.stderr).toBe('');
    expect([snapshot(join(home, '.claude')), snapshot(join(home, '.cursor')), snapshot(join(home, '.mcpkit'))]).toEqual(before);
  });

  it('the fast path reads no schema cache: the run is the same with every cache file unreadable', () => {
    const home = upgraderHome();
    expect(cli(home, ['list']).code).toBe(0);
    const before = [snapshot(join(home, '.claude')), snapshot(join(home, '.cursor')), snapshot(join(home, '.mcpkit', 'state.json'))];
    const caches = readdirSync(join(home, '.mcpkit', 'schemas')).map((name) => join(home, '.mcpkit', 'schemas', name));
    for (const file of caches) chmodSync(file, 0o000);
    try {
      const started = performance.now();
      const second = cli(home, ['list']);
      const elapsed = performance.now() - started;

      expect(second.code, second.stderr).toBe(0);
      expect(second.stderr).toBe('');
      // A pass that read the caches would have rewritten the guides without their tools.
      expect([snapshot(join(home, '.claude')), snapshot(join(home, '.cursor')), snapshot(join(home, '.mcpkit', 'state.json'))]).toEqual(before);
      expect(elapsed).toBeLessThan(10_000);
    } finally {
      for (const file of caches) chmodSync(file, 0o600);
    }
  });

  it('removes a kept skill on the first full run after its cache appears, and never touches one the user restored', () => {
    const home = upgraderHome();
    expect(cli(home, ['list']).code).toBe(0);
    const [backup] = backupsOf(home);
    writeCache(home, 'c');

    const afterCache = cli(home, ['search', 'echo']);

    expect(afterCache.code, afterCache.stderr).toBe(0);
    expect(afterCache.stderr).toContain('mcpkit: removed 2 per-server skills for servers that are now indexed (backup: ');
    expect(afterCache.stderr.trimEnd().split('\n').filter((line) => line.startsWith('mcpkit: removed'))).toHaveLength(1);
    for (const agent of ['claude-code', 'cursor'] as const) {
      expect(skillDirs(home, agent)).toEqual(['mcpkit-cli', 'mcpkit-d', 'mcpkit-notes']);
      expect(stateOf(home).adopted[agent].deferred).toEqual(['d']);
    }
    expect(backupsOf(home)).toHaveLength(2);

    // The user copies a moved skill back, as the first notice said they could.
    cpSync(join(home, '.mcpkit', 'skill-backups', backup, 'cursor', 'mcpkit-a'), join(agentRoot(home, 'cursor'), 'mcpkit-a'), { recursive: true });
    writeCache(home, 'd');
    expect(cli(home, ['list']).code).toBe(0);
    expect(cli(home, ['list']).code).toBe(0);

    expect(skillDirs(home, 'cursor')).toEqual(['mcpkit-a', 'mcpkit-cli', 'mcpkit-notes']);
    expect(skillDirs(home, 'claude-code')).toEqual(['mcpkit-cli', 'mcpkit-notes']);
  });

  it.each([
    [['update', 'c']],
    [['sync', 'c', '--force']],
  ])('`%j` caches the tools of a kept skill\'s server, and the step at its end removes the skill', (args) => {
    const home = upgraderHome();
    expect(cli(home, ['list']).code).toBe(0);
    expect(skillDirs(home, 'cursor')).toContain('mcpkit-c');
    expect(existsSync(join(home, '.mcpkit', 'schemas', 'c.json'))).toBe(false);

    const run = cli(home, args);

    expect(run.code, run.stderr).toBe(0);
    expect(existsSync(join(home, '.mcpkit', 'schemas', 'c.json'))).toBe(true);
    expect(run.stderr).toContain('mcpkit: removed 2 per-server skills for servers that are now indexed (backup: ');
    for (const agent of ['claude-code', 'cursor'] as const) {
      expect(skillDirs(home, agent)).toEqual(['mcpkit-cli', 'mcpkit-d', 'mcpkit-notes']);
      expect(stateOf(home).adopted[agent].deferred).toEqual(['d']);
    }
  });

  it('`exec` and `call --json` as the first command: the guide is freshened, nothing is removed, no hook, no notice, and stdout is the JSON', () => {
    const home = upgraderHome();
    const settingsBefore = readFileSync(join(home, '.claude', 'settings.json'), 'utf-8');

    const exec = cli(home, ['exec', '--allow', 'a.echo', '-c', 'return await mcp.a.echo({ message: "hi" })']);
    expect(exec.code, exec.stderr).toBe(0);
    expect(exec.stderr).not.toContain('skills are now lean');
    const envelope = JSON.parse(exec.stdout) as { ok: boolean; result?: unknown };
    expect(envelope.ok).toBe(true);

    const call = cli(home, ['call', 'a', 'echo', '{"message":"hi"}', '--json']);
    expect(call.code, call.stderr).toBe(0);
    expect(call.stderr).not.toContain('skills are now lean');
    expect(() => JSON.parse(call.stdout)).not.toThrow();

    for (const agent of ['claude-code', 'cursor'] as const) {
      expect(skillDirs(home, agent)).toEqual(['mcpkit-a', 'mcpkit-b', 'mcpkit-c', 'mcpkit-cli', 'mcpkit-d', 'mcpkit-notes']);
      expect(readFileSync(guideOf(home, agent), 'utf-8')).toContain('## MCP servers reachable through mcpkit (live list)');
    }
    expect(readFileSync(join(home, '.claude', 'settings.json'), 'utf-8')).toBe(settingsBefore);
    // The one thing the refresh writes down: the guides are current (its own record). No adoption, no full pass.
    expect(stateOf(home).adopted).toEqual({});
    expect(stateOf(home).fingerprint).toBeUndefined();
    expect(typeof stateOf(home).refreshFingerprint).toBe('string');
    expect(backupsOf(home)).toEqual([]);

    // The first command that is not one of those does the move.
    expect(cli(home, ['list']).stderr).toContain(NOTICE_HEADER);
  });

  it.each([
    [['hook', 'session-start']],
    [['hook', 'install']],
    [['hook', 'uninstall']],
    [['config']],
    [['config', 'skills']],
    [['--help']],
    [['--version']],
    [['list', '--help']],
    [['help', 'list']],
  ])('`%j` writes no file anywhere under the home', (args) => {
    const home = upgraderHome();
    const before = snapshot(home);

    const run = cli(home, args);

    expect(run.code, run.stderr).toBe(0);
    expect(snapshot(home)).toEqual(before);
    expect(run.stderr).not.toContain('skills are now lean');
  });

  it('a command group with no action (runtime) prints its help, exits 1 as it did, and writes nothing', () => {
    const home = upgraderHome();
    const before = snapshot(home);

    const run = cli(home, ['runtime']);

    expect(run.code).toBe(1);
    expect(run.stderr).toContain('Usage: mcpkit runtime');
    expect(snapshot(home)).toEqual(before);
  });

  it.each([
    [['install', '--dry-run', 'x']],
    [['sync', '--dry-run']],
  ])('`%j` (a dry run) changes nothing under the home', (args) => {
    const home = upgraderHome();
    const before = snapshot(home);

    cli(home, args);

    expect(snapshot(home)).toEqual(before);
  });
});

describe('what leaves an upgrader as it is', () => {
  const untouched = (home: string, args: string[] = ['list'], extra: NodeJS.ProcessEnv = {}): CliResult => {
    const before = snapshot(home);
    const run = cli(home, args, extra);
    expect(snapshot(home), run.stderr).toEqual(before);
    return run;
  };

  it('MCPKIT_SKILLS set (the run is explicit): nothing, and no state', () => {
    const home = upgraderHome();
    for (const value of ['guide', 'per-server']) {
      const run = untouched(home, ['list'], { MCPKIT_SKILLS: value });
      expect(run.stderr).toBe('');
    }
    expect(existsSync(join(home, '.mcpkit', 'state.json'))).toBe(false);
  });

  it('MCPKIT_NO_MIGRATE=1: nothing, and no state', () => {
    const home = upgraderHome();
    expect(untouched(home, ['list'], { MCPKIT_NO_MIGRATE: '1' }).stderr).toBe('');
    expect(untouched(home, ['search', 'x'], { MCPKIT_NO_MIGRATE: 'true' }).stderr).not.toContain('skills are now lean');
  });

  it.each([
    ['invalid YAML in config.yaml', 'config.yaml', 'skills: [unclosed\n  - x: : :\n'],
    ['a newer config.yaml (version: 2)', 'config.yaml', 'version: 2\nskills:\n  default: per-server\n'],
    ['a corrupt servers.yaml', 'servers.yaml', 'version: 1\nservers: [unclosed\n  - x: : :\n'],
  ])('%s: nothing is changed (defaults mean the guide, which is no ground to delete skills)', (_label, file, text) => {
    const home = upgraderHome();
    writeFileSync(join(home, '.mcpkit', file), text);
    untouched(home, ['search', 'x']);
    expect(existsSync(join(home, '.mcpkit', 'state.json'))).toBe(false);
  });

  it('an explicit per-server entry for an agent: that agent is untouched, the other is moved', () => {
    const home = upgraderHome();
    writeFileSync(join(home, '.mcpkit', 'config.yaml'), 'version: 1\nskills:\n  agents:\n    cursor: per-server\n');
    const cursorBefore = snapshot(join(home, '.cursor'));

    const run = cli(home, ['list']);

    expect(run.code, run.stderr).toBe(0);
    expect(snapshot(join(home, '.cursor'))).toEqual(cursorBefore);
    expect(skillDirs(home, 'claude-code')).toEqual(['mcpkit-c', 'mcpkit-cli', 'mcpkit-d', 'mcpkit-notes']);
    expect(stateOf(home).adopted.cursor).toBeUndefined();
  });

  it('an explicit guide: the guide is freshened and nothing else happens', () => {
    const home = upgraderHome();
    writeFileSync(join(home, '.mcpkit', 'config.yaml'), 'version: 1\nskills:\n  default: guide\n');
    const settingsBefore = readFileSync(join(home, '.claude', 'settings.json'), 'utf-8');

    const run = cli(home, ['list']);

    expect(run.code, run.stderr).toBe(0);
    expect(run.stderr).toBe('');
    for (const agent of ['claude-code', 'cursor'] as const) {
      expect(skillDirs(home, agent)).toEqual(['mcpkit-a', 'mcpkit-b', 'mcpkit-c', 'mcpkit-cli', 'mcpkit-d', 'mcpkit-notes']);
      expect(readFileSync(guideOf(home, agent), 'utf-8')).toContain('## MCP servers reachable through mcpkit (live list)');
    }
    expect(readFileSync(join(home, '.claude', 'settings.json'), 'utf-8')).toBe(settingsBefore);
    expect(backupsOf(home)).toEqual([]);
  });

  it('a corrupt state.json: the guide is freshened, nothing is removed, the hook is not added, the file is not replaced', () => {
    const home = upgraderHome();
    writeFileSync(join(home, '.mcpkit', 'state.json'), '{ nope');
    const settingsBefore = readFileSync(join(home, '.claude', 'settings.json'), 'utf-8');

    const run = cli(home, ['list']);

    expect(run.code, run.stderr).toBe(0);
    expect(run.stderr).toBe('');
    expect(readFileSync(join(home, '.mcpkit', 'state.json'), 'utf-8')).toBe('{ nope');
    expect(readFileSync(join(home, '.claude', 'settings.json'), 'utf-8')).toBe(settingsBefore);
    expect(skillDirs(home, 'cursor')).toEqual(['mcpkit-a', 'mcpkit-b', 'mcpkit-c', 'mcpkit-cli', 'mcpkit-d', 'mcpkit-notes']);
    expect(readFileSync(guideOf(home, 'cursor'), 'utf-8')).toContain('## MCP servers reachable through mcpkit (live list)');
  });

  it('hookDeclined: the skills are moved and the hook is not added', () => {
    const home = upgraderHome();
    writeFileSync(join(home, '.mcpkit', 'state.json'), JSON.stringify({ version: 1, adopted: {}, hookDeclined: true }));
    const settingsBefore = readFileSync(join(home, '.claude', 'settings.json'), 'utf-8');

    const run = cli(home, ['list']);

    expect(run.stderr).toContain('moved 2 per-server skills');
    expect(run.stderr).not.toContain('SessionStart hook');
    expect(readFileSync(join(home, '.claude', 'settings.json'), 'utf-8')).toBe(settingsBefore);
  });

  it('`hook uninstall --write` is a refusal the next full run respects', () => {
    const home = upgraderHome();
    expect(cli(home, ['hook', 'install', '--write']).code).toBe(0);
    expect(cli(home, ['hook', 'uninstall', '--write']).code).toBe(0);
    expect(stateOf(home).hookDeclined).toBe(true);
    const settingsBefore = readFileSync(join(home, '.claude', 'settings.json'), 'utf-8');

    const run = cli(home, ['list']);

    expect(run.stderr).toContain('moved 2 per-server skills');
    expect(readFileSync(join(home, '.claude', 'settings.json'), 'utf-8')).toBe(settingsBefore);

    expect(cli(home, ['hook', 'install', '--write']).code).toBe(0);
    expect(stateOf(home).hookDeclined).toBe(false);
  });

  it('a settings.json that is not valid JSON: it is left as it is, the notice says why, and the skills are still moved', () => {
    const home = upgraderHome();
    writeFileSync(join(home, '.claude', 'settings.json'), '{ nope');

    const run = cli(home, ['list']);

    expect(run.code, run.stderr).toBe(0);
    expect(readFileSync(join(home, '.claude', 'settings.json'), 'utf-8')).toBe('{ nope');
    expect(run.stderr).toContain('  could not add the hook: the settings file is not valid JSON');
    expect(run.stderr).toContain('moved 2 per-server skills');
    expect(skillDirs(home, 'claude-code')).toEqual(['mcpkit-c', 'mcpkit-cli', 'mcpkit-d', 'mcpkit-notes']);
    expect(stateOf(home).adopted['claude-code']).toBeDefined();
  });
});

describe('five processes at once', () => {
  it('make one backup, adopt once, exit 0 with clean stdout, leave no lock, and at most one prints the notice', async () => {
    const home = upgraderHome();
    const normal = cli(home, ['list'], { MCPKIT_NO_MIGRATE: '1' });

    const runs = await Promise.all(Array.from({ length: 5 }, () => cliAsync(home, ['list'])));

    for (const run of runs) {
      expect(run.code, run.stderr).toBe(0);
      expect(run.stdout).toBe(normal.stdout);
    }
    expect(runs.filter((run) => run.stderr.includes(NOTICE_HEADER)).length).toBeLessThanOrEqual(1);
    for (const run of runs) expect(run.stderr.split('\n').filter((line) => line !== '' && !line.startsWith('mcpkit: skills are now lean') && !line.startsWith('  '))).toEqual([]);
    expect(backupsOf(home)).toHaveLength(1);
    expect(Object.keys(stateOf(home).adopted).sort()).toEqual(['claude-code', 'cursor']);
    expect(stateOf(home).adopted.cursor.removed).toBe(2);
    expect(existsSync(join(home, '.mcpkit', 'reconcile.lock'))).toBe(false);
    expect(existsSync(join(home, '.mcpkit', 'state.json.lock'))).toBe(false);
    const settings = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf-8')) as { hooks: { SessionStart: unknown[] } };
    expect(settings.hooks.SessionStart).toHaveLength(2);
    expect(readdirSync(join(home, '.claude')).filter((name) => name.includes('.mcpkit-bak-'))).toHaveLength(1);
    for (const agent of ['claude-code', 'cursor'] as const) expect(skillDirs(home, agent)).toEqual(['mcpkit-c', 'mcpkit-cli', 'mcpkit-d', 'mcpkit-notes']);
  });
});

describe('the command tree', () => {
  it('an unknown command and a failing call exit non-zero with the same stderr as before the hook was added', () => {
    const home = upgraderHome();

    const unknown = cli(home, ['bogus']);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toBe("error: unknown command 'bogus'\n");
    expect(unknown.stdout).toBe('');

    const missing = cli(home, ['call', 'nope', 'tool', '{}']);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toBe('Server "nope" not found. Run \'mcpkit list\' to see registered servers.\n');

    const failing = cli(home, ['call', 'a', 'fail', '{}']);
    expect(failing.code).toBe(1);
    // (The command's own advice about the age of the registry entry comes first; the failure is what it always was.)
    expect(failing.stderr).toMatch(/Error: Tool "fail" returned an error: deliberate failure\n$/);
    expect(failing.stderr).not.toContain('skills are now lean');

    const usage = cli(home, ['exec', 'no-such-script.js']);
    expect(usage.code).toBe(2);
    expect(usage.stderr).toMatch(/^error: cannot read the script/);
  });

  it('a nested command (runtime status) triggers the reconcile too, and a failing exit code survives it', () => {
    const home = upgraderHome();

    const run = cli(home, ['runtime', 'status']);

    expect(run.code, run.stderr).toBe(0);
    expect(run.stderr).toContain(NOTICE_HEADER);
    expect(parse(readFileSync(join(home, '.mcpkit', 'servers.yaml'), 'utf-8'))).toHaveProperty('servers.a');
  });
});
