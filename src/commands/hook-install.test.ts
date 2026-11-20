import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_MATCHER, HOOK_COMMAND } from '../hook-settings.js';
import { createHookCommand } from './hook.js';

class ExitSignal extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

const ourGroup = { matcher: DEFAULT_MATCHER, hooks: [{ type: 'command', command: HOOK_COMMAND }] };
const otherGroup = { matcher: 'startup', hooks: [{ type: 'command', command: 'echo other-hook' }] };

describe('mcpkit hook install and uninstall', () => {
  const originalHome = process.env.HOME;
  let homeDir = '';
  let settingsPath = '';
  let stdout: string[] = [];
  let stderr: string[] = [];

  const out = (): string => stdout.join('\n');

  async function hook(...args: string[]): Promise<void> {
    await createHookCommand({ stdin: undefined, env: {}, write: async () => {} }).parseAsync(args, { from: 'user' });
  }

  async function backups(): Promise<string[]> {
    return (await readdir(join(homeDir, '.claude'))).filter((name) => name.includes('.mcpkit-bak-')).sort();
  }

  async function writeSettings(value: unknown, mode = 0o644): Promise<string> {
    const text = typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`;
    await mkdir(join(homeDir, '.claude'), { recursive: true });
    await writeFile(settingsPath, text, { mode });
    return text;
  }

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'mcpkit-hook-install-'));
    process.env.HOME = homeDir;
    settingsPath = join(homeDir, '.claude', 'settings.json');
    stdout = [];
    stderr = [];
    vi.spyOn(console, 'log').mockImplementation((...parts) => { stdout.push(parts.join(' ')); });
    vi.spyOn(console, 'error').mockImplementation((...parts) => { stderr.push(parts.join(' ')); });
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new ExitSignal(code);
    }) as never);
  });

  afterEach(async () => {
    process.exitCode = undefined;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await rm(homeDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe('install without --write', () => {
    it('only prints: the entry, a diff and how to apply it, and writes nothing, not even the directory', async () => {
      await hook('install');

      expect(out()).toContain('Preview only: nothing was written');
      expect(out()).toContain(settingsPath);
      expect(out()).toContain('does not exist yet');
      expect(out()).toContain(JSON.stringify(ourGroup, null, 2));
      expect(out()).toContain('--- /dev/null');
      expect(out()).toContain(`+++ ${settingsPath}`);
      expect(out()).toContain('@@ -0,0 +1,');
      expect(out()).toContain(`+${' '.repeat(12)}"command": ${JSON.stringify(HOOK_COMMAND)}`);
      expect(out()).toContain('"command": "mcpkit hook session-start 2>/dev/null || true"');
      expect(out()).toContain('--write');
      expect(await readdir(homeDir)).toEqual([]);
      expect(process.exitCode).toBeUndefined();
    });

    it('leaves an existing file, its time and its folder as they were', async () => {
      const original = await writeSettings({ model: 'opus', hooks: { Stop: [otherGroup] } });
      const past = new Date(2020, 0, 1);
      await utimes(settingsPath, past, past);

      await hook('install', '--settings', settingsPath);

      expect(await readFile(settingsPath, 'utf-8')).toBe(original);
      expect((await stat(settingsPath)).mtimeMs).toBe(past.getTime());
      expect(await readdir(join(homeDir, '.claude'))).toEqual(['settings.json']);
      expect(out()).toContain('Preview only: nothing was written');
      expect(out()).toContain('(exists)');
      expect(out()).toContain('+    "SessionStart": [');
      expect(out()).toContain(`--- ${settingsPath}`);
    });

    it('previews an empty settings file without refusing it', async () => {
      await writeSettings('');
      await hook('install');
      expect(out()).toContain('Preview only');
      expect(out()).toContain(JSON.stringify(ourGroup, null, 2));
      expect(process.exitCode).toBeUndefined();
    });

    it('says so when the hook is already installed, and changes nothing', async () => {
      const original = await writeSettings({ hooks: { SessionStart: [ourGroup] } });
      await hook('install');
      expect(out()).toContain('already installed');
      expect(out()).toContain(`matcher "${DEFAULT_MATCHER}"`);
      expect(out()).not.toContain('@@');
      expect(await readFile(settingsPath, 'utf-8')).toBe(original);
      expect(process.exitCode).toBeUndefined();
    });
  });

  describe('install --write', () => {
    it('backs up the original bytes (mode 0600), merges the entry and keeps every other key, hook and key order', async () => {
      const original = await writeSettings({
        model: 'opus',
        hooks: { PreToolUse: [otherGroup], SessionStart: [otherGroup], Stop: [otherGroup] },
        env: { A: '1' },
      }, 0o640);

      await hook('install', '--write');

      const [backup] = await backups();
      expect(backup).toMatch(/^settings\.json\.mcpkit-bak-\d{14}$/);
      expect(await readFile(join(homeDir, '.claude', backup), 'utf-8')).toBe(original);
      expect((await stat(join(homeDir, '.claude', backup))).mode & 0o777).toBe(0o600);

      const settings = JSON.parse(await readFile(settingsPath, 'utf-8')) as Record<string, unknown>;
      expect(Object.keys(settings)).toEqual(['model', 'hooks', 'env']);
      expect(Object.keys(settings.hooks as object)).toEqual(['PreToolUse', 'SessionStart', 'Stop']);
      expect((settings.hooks as { SessionStart: unknown[] }).SessionStart).toEqual([otherGroup, ourGroup]);
      expect((settings.hooks as { Stop: unknown[] }).Stop).toEqual([otherGroup]);
      expect(settings.env).toEqual({ A: '1' });
      // The existing file keeps its permissions.
      expect((await stat(settingsPath)).mode & 0o777).toBe(0o640);
      expect(out()).toContain(join(homeDir, '.claude', backup));
      expect(out()).toContain('Installed');
      expect(process.exitCode).toBeUndefined();
    });

    it('creates the file and its directories when they do not exist, with no backup and owner-only permissions', async () => {
      await hook('install', '--write');

      expect(JSON.parse(await readFile(settingsPath, 'utf-8'))).toEqual({ hooks: { SessionStart: [ourGroup] } });
      expect(await backups()).toEqual([]);
      expect((await stat(settingsPath)).mode & 0o777).toBe(0o600);
    });

    it('creates the directories of a --settings path', async () => {
      const custom = join(homeDir, 'deep', 'er', 'settings.json');
      await hook('install', '--settings', custom, '--write');
      expect(JSON.parse(await readFile(custom, 'utf-8'))).toEqual({ hooks: { SessionStart: [ourGroup] } });
    });

    it('is idempotent: a second --write changes nothing, makes no backup and says so', async () => {
      await writeSettings({ keep: 1 });
      await hook('install', '--write');
      const afterFirst = await readFile(settingsPath, 'utf-8');
      const backupsAfterFirst = await backups();
      const mtime = (await stat(settingsPath)).mtimeMs;
      stdout = [];

      await hook('install', '--write');

      expect(await readFile(settingsPath, 'utf-8')).toBe(afterFirst);
      expect((await stat(settingsPath)).mtimeMs).toBe(mtime);
      expect(await backups()).toEqual(backupsAfterFirst);
      expect(out()).toContain('already installed');
    });

    it('updates an earlier bare entry in place, previewing the change first, and does not duplicate it', async () => {
      const bare = { matcher: 'startup|resume', hooks: [{ type: 'command', command: 'mcpkit hook session-start' }] };
      const original = await writeSettings({ hooks: { SessionStart: [otherGroup, bare] } });

      await hook('install');
      expect(out()).toContain('Entry updated in place');
      expect(out()).toContain('was: "mcpkit hook session-start"');
      expect(out()).toContain('-            "command": "mcpkit hook session-start"');
      expect(out()).toContain(`+            "command": ${JSON.stringify(HOOK_COMMAND)}`);
      expect(await readFile(settingsPath, 'utf-8')).toBe(original);
      stdout = [];

      await hook('install', '--write');
      expect(out()).toContain('Updated the SessionStart hook');
      expect(JSON.parse(await readFile(settingsPath, 'utf-8'))).toEqual({
        hooks: { SessionStart: [otherGroup, { matcher: 'startup|resume', hooks: [{ type: 'command', command: HOOK_COMMAND }] }] },
      });
      const [backup] = await backups();
      expect(await readFile(join(homeDir, '.claude', backup), 'utf-8')).toBe(original);

      stdout = [];
      await hook('install', '--write');
      expect(out()).toContain('already installed');
      expect(await backups()).toHaveLength(1);
    });

    it('uses the matcher it is given', async () => {
      await hook('install', '--write', '--matcher', 'startup|resume|clear|compact|fork');
      const settings = JSON.parse(await readFile(settingsPath, 'utf-8')) as { hooks: { SessionStart: Array<{ matcher: string }> } };
      expect(settings.hooks.SessionStart[0].matcher).toBe('startup|resume|clear|compact|fork');
    });

    it('writes through a symlinked settings file and leaves the link in place', async () => {
      const real = join(homeDir, 'dotfiles', 'claude-settings.json');
      await mkdir(join(homeDir, 'dotfiles'), { recursive: true });
      await writeFile(real, '{}\n');
      await mkdir(join(homeDir, '.claude'), { recursive: true });
      await symlink(real, settingsPath);

      await hook('install', '--write');

      expect((await lstat(settingsPath)).isSymbolicLink()).toBe(true);
      expect(JSON.parse(await readFile(real, 'utf-8'))).toEqual({ hooks: { SessionStart: [ourGroup] } });
    });

    it.each([
      ['not JSON', '{ nope'],
      ['a JSON array', '[1]'],
      ['hooks of the wrong type', '{"hooks": []}'],
      ['SessionStart of the wrong type', '{"hooks": {"SessionStart": {}}}'],
    ])('refuses a file that is %s: exit 1, nothing written, no backup', async (_label, content) => {
      await writeSettings(content);
      await hook('install', '--write');

      expect(process.exitCode).toBe(1);
      expect(stderr.join('\n')).toMatch(/Nothing was written/);
      expect(await readFile(settingsPath, 'utf-8')).toBe(content);
      expect(await readdir(join(homeDir, '.claude'))).toEqual(['settings.json']);
    });

    it('fails with exit 1 and writes nothing when the settings path is a directory', async () => {
      await mkdir(settingsPath, { recursive: true });
      await hook('install', '--write');
      expect(process.exitCode).toBe(1);
      expect(stderr.join('\n')).toContain('Error:');
    });

    it('fails with exit 1 when the folder cannot be written, leaving the file and no backup', async () => {
      const original = await writeSettings({ a: 1 });
      const dir = join(homeDir, '.claude');
      await chmod(dir, 0o500);
      try {
        await hook('install', '--write');
      } finally {
        await chmod(dir, 0o700);
      }
      expect(process.exitCode).toBe(1);
      expect(await readFile(settingsPath, 'utf-8')).toBe(original);
      expect(await backups()).toEqual([]);
    });
  });

  describe('uninstall', () => {
    it('only prints without --write: what would go, a diff, and nothing is written', async () => {
      const original = await writeSettings({ hooks: { SessionStart: [otherGroup, ourGroup] } });
      await hook('uninstall');

      expect(out()).toContain('Preview only: nothing was written');
      expect(out()).toContain(JSON.stringify({ type: 'command', command: HOOK_COMMAND }, null, 2));
      expect(out()).toContain('@@');
      expect(await readFile(settingsPath, 'utf-8')).toBe(original);
      expect(await readdir(join(homeDir, '.claude'))).toEqual(['settings.json']);
    });

    it('--write backs up, removes only its own entry, and keeps everything else', async () => {
      const original = await writeSettings({ model: 'opus', hooks: { Stop: [otherGroup], SessionStart: [otherGroup, ourGroup] } });
      await hook('uninstall', '--write');

      const [backup] = await backups();
      expect(await readFile(join(homeDir, '.claude', backup), 'utf-8')).toBe(original);
      expect((await stat(join(homeDir, '.claude', backup))).mode & 0o777).toBe(0o600);
      expect(JSON.parse(await readFile(settingsPath, 'utf-8'))).toEqual({ model: 'opus', hooks: { Stop: [otherGroup], SessionStart: [otherGroup] } });
      expect(out()).toContain('Removed');
    });

    it('removes the containers it empties, and leaves a command that merely wraps its own', async () => {
      await writeSettings({ hooks: { SessionStart: [ourGroup] } });
      await hook('uninstall', '--write');
      expect(JSON.parse(await readFile(settingsPath, 'utf-8'))).toEqual({});

      const wrapped = { matcher: 'startup', hooks: [{ type: 'command', command: 'echo mcpkit hook session-start' }] };
      const original = await writeSettings({ hooks: { SessionStart: [wrapped] } });
      stdout = [];
      await hook('uninstall', '--write');
      expect(await readFile(settingsPath, 'utf-8')).toBe(original);
      expect(out()).toContain('not installed');
    });

    it('is a no-op when the file or the hook is missing: exit 0, nothing created', async () => {
      await hook('uninstall', '--write');
      expect(out()).toContain('not installed');
      expect(await readdir(homeDir)).toEqual([]);
      expect(process.exitCode).toBeUndefined();
    });

    it('refuses a file that is not valid JSON, and writes nothing', async () => {
      await writeSettings('{ nope');
      await hook('uninstall', '--write');
      expect(process.exitCode).toBe(1);
      expect(await readdir(join(homeDir, '.claude'))).toEqual(['settings.json']);
    });
  });

  describe('agents and usage', () => {
    it.each(['install', 'uninstall'])('%s supports only claude-code: exit 1 with the --format text way for the others, nothing written', async (action) => {
      await hook(action, '--agent', 'codex', '--write');

      expect(process.exitCode).toBe(1);
      expect(stderr.join('\n')).toContain('only supports claude-code');
      expect(stderr.join('\n')).toContain('mcpkit hook session-start --agent codex --format text');
      expect(await readdir(homeDir)).toEqual([]);
    });

    it.each([
      [['install', '--agent', 'vim']],
      [['install', '--bogus']],
      [['install', '--matcher', '(']],
      [['install', '--matcher', '']],
      [['uninstall', '--matcher', 'x']],
    ])('exits 2 for %j', async (args) => {
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      await expect(hook(...args)).rejects.toMatchObject({ code: 2 });
      expect(await readdir(homeDir)).toEqual([]);
    });
  });
});
