import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_MATCHER, HOOK_COMMAND, SettingsRefusal, backupFile, hasInstalledHook, installHook, timestamp, uninstallHook, unifiedDiff } from './hook-settings.js';

const ours = { type: 'command', command: HOOK_COMMAND };
const ourGroup = { matcher: DEFAULT_MATCHER, hooks: [ours] };

function json(value: unknown, indent: string | number = 2): string {
  return `${JSON.stringify(value, null, indent)}\n`;
}

describe('installHook', () => {
  it('knows the command and the matcher it installs', () => {
    expect(HOOK_COMMAND).toBe('mcpkit hook session-start 2>/dev/null || true');
    expect(DEFAULT_MATCHER).toBe('startup|resume|clear|compact');
  });

  it.each([
    ['a missing file', undefined],
    ['an empty file', ''],
    ['a file with only white space', ' \n\t\n'],
  ])('builds the whole settings file from %s', (_label, before) => {
    const edit = installHook(before, DEFAULT_MATCHER);
    expect(edit.changed).toBe(true);
    expect(edit.text).toBe(json({ hooks: { SessionStart: [ourGroup] } }));
    expect(edit.entry).toEqual(ourGroup);
  });

  it('appends the entry and keeps every other key, hook and key order', () => {
    const other = { matcher: 'startup', hooks: [{ type: 'command', command: 'echo other' }] };
    const before = json({
      model: 'opus',
      permissions: { allow: ['Bash(ls)'] },
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'guard' }] }],
        SessionStart: [other],
        Stop: [],
      },
      env: { A: '1' },
    });
    const edit = installHook(before, DEFAULT_MATCHER);
    const parsed = JSON.parse(edit.text) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(['model', 'permissions', 'hooks', 'env']);
    expect(Object.keys(parsed.hooks as object)).toEqual(['PreToolUse', 'SessionStart', 'Stop']);
    expect((parsed.hooks as { SessionStart: unknown[] }).SessionStart).toEqual([other, ourGroup]);
    expect(parsed.permissions).toEqual({ allow: ['Bash(ls)'] });
  });

  it('adds hooks and SessionStart where only part of the path exists, after the keys already there', () => {
    const noHooks = installHook(json({ a: 1 }), DEFAULT_MATCHER);
    expect(Object.keys(JSON.parse(noHooks.text) as object)).toEqual(['a', 'hooks']);

    const noSession = installHook(json({ hooks: { Stop: [] } }), DEFAULT_MATCHER);
    expect(Object.keys((JSON.parse(noSession.text) as { hooks: object }).hooks)).toEqual(['Stop', 'SessionStart']);
  });

  it('uses the matcher it is given', () => {
    const edit = installHook(undefined, 'startup');
    expect(JSON.parse(edit.text)).toEqual({ hooks: { SessionStart: [{ matcher: 'startup', hooks: [ours] }] } });
  });

  it('is idempotent: a second install changes nothing, and says which entry it found', () => {
    const first = installHook(undefined, DEFAULT_MATCHER);
    const second = installHook(first.text, DEFAULT_MATCHER);
    expect(second.changed).toBe(false);
    expect(second.text).toBe(first.text);
    expect(second.entry).toEqual(ourGroup);
  });

  it('recognises its entry under any matcher, and inside a group that holds other hooks too', () => {
    const shared = json({ hooks: { SessionStart: [{ matcher: 'resume', hooks: [{ type: 'command', command: 'echo x' }, ours] }] } });
    const edit = installHook(shared, DEFAULT_MATCHER);
    expect(edit.changed).toBe(false);
    expect(edit.text).toBe(shared);
  });

  it('does not take a command that merely contains or wraps its own for its own', () => {
    for (const command of ['/usr/bin/mcpkit hook session-start', ' mcpkit hook session-start', 'echo mcpkit hook session-start', 'mcpkit hook install', 'mcpkit search hook session-start']) {
      const before = json({ hooks: { SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command }] }] } });
      const edit = installHook(before, DEFAULT_MATCHER);
      expect(edit.changed, command).toBe(true);
      expect(edit.replaced, command).toEqual([]);
      expect((JSON.parse(edit.text) as { hooks: { SessionStart: unknown[] } }).hooks.SessionStart, command).toHaveLength(2);
    }
    const notCommand = json({ hooks: { SessionStart: [{ hooks: [{ type: 'prompt', command: HOOK_COMMAND }] }] } });
    expect(installHook(notCommand, DEFAULT_MATCHER).changed).toBe(true);
  });

  it.each([
    'mcpkit hook session-start',
    'mcpkit hook session-start 2>/dev/null',
    'mcpkit hook session-start --agent claude-code --format json',
  ])('updates an earlier entry of ours (%s) in place instead of adding a second one', (earlier) => {
    const keepA = { matcher: 'startup', hooks: [{ type: 'command', command: 'echo a' }] };
    const keepB = { hooks: [{ type: 'command', command: 'echo b' }] };
    const before = json({
      model: 'opus',
      hooks: { SessionStart: [keepA, { matcher: 'resume|clear', hooks: [{ type: 'command', command: earlier, timeout: 5 }], note: 'mine' }, keepB] },
    });

    const edit = installHook(before, DEFAULT_MATCHER);

    expect(edit.changed).toBe(true);
    expect(edit.replaced).toEqual([earlier]);
    const updated = { matcher: 'resume|clear', hooks: [{ type: 'command', command: HOOK_COMMAND, timeout: 5 }], note: 'mine' };
    expect(JSON.parse(edit.text)).toEqual({ model: 'opus', hooks: { SessionStart: [keepA, updated, keepB] } });
    expect(edit.entry).toEqual(updated);
    // The second install finds nothing left to do.
    const again = installHook(edit.text, DEFAULT_MATCHER);
    expect(again.changed).toBe(false);
    expect(again.text).toBe(edit.text);
  });

  it('removes duplicates of its own entry: the first is updated, the others go, and a group left empty goes too', () => {
    const other = { matcher: 'startup', hooks: [{ type: 'command', command: 'echo other' }] };
    const before = json({
      hooks: {
        SessionStart: [
          { matcher: 'startup', hooks: [{ type: 'command', command: 'mcpkit hook session-start' }] },
          other,
          { matcher: 'resume', hooks: [ours] },
          { matcher: 'clear', hooks: [{ type: 'command', command: 'echo kept' }, { type: 'command', command: 'mcpkit hook session-start --agent codex' }] },
        ],
      },
    });

    const edit = installHook(before, DEFAULT_MATCHER);

    expect(edit.replaced).toEqual(['mcpkit hook session-start', HOOK_COMMAND, 'mcpkit hook session-start --agent codex']);
    expect(JSON.parse(edit.text)).toEqual({
      hooks: {
        SessionStart: [
          { matcher: 'startup', hooks: [ours] },
          other,
          { matcher: 'clear', hooks: [{ type: 'command', command: 'echo kept' }] },
        ],
      },
    });
  });

  it('keeps the indentation and the missing final newline of the file it edits', () => {
    const tabbed = JSON.stringify({ a: 1 }, null, '\t');
    const edit = installHook(tabbed, DEFAULT_MATCHER);
    expect(edit.text).toBe(JSON.stringify({ a: 1, hooks: { SessionStart: [ourGroup] } }, null, '\t'));

    const four = installHook(json({ a: 1 }, 4), DEFAULT_MATCHER);
    expect(four.text).toBe(json({ a: 1, hooks: { SessionStart: [ourGroup] } }, 4));
  });

  it.each([
    ['not JSON', '{ nope', /not valid JSON/],
    ['JSON with a comment', '{ // c\n}', /not valid JSON/],
    ['a JSON array', '[]', /must be a JSON object/],
    ['a JSON string', '"x"', /must be a JSON object/],
    ['null', 'null', /must be a JSON object/],
    ['hooks as an array', '{"hooks": []}', /"hooks" must be an object/],
    ['hooks as a string', '{"hooks": "x"}', /"hooks" must be an object/],
    ['hooks as null', '{"hooks": null}', /"hooks" must be an object/],
    ['SessionStart as an object', '{"hooks": {"SessionStart": {}}}', /"hooks.SessionStart" must be an array/],
    ['SessionStart as null', '{"hooks": {"SessionStart": null}}', /"hooks.SessionStart" must be an array/],
  ])('refuses %s', (_label, before, message) => {
    expect(() => installHook(before, DEFAULT_MATCHER)).toThrow(SettingsRefusal);
    expect(() => installHook(before, DEFAULT_MATCHER)).toThrow(message);
    expect(() => uninstallHook(before)).toThrow(SettingsRefusal);
  });
});

describe('uninstallHook', () => {
  it('removes its entry and the containers that its removal leaves empty', () => {
    const installed = installHook(undefined, DEFAULT_MATCHER).text;
    const edit = uninstallHook(installed);
    expect(edit.changed).toBe(true);
    expect(edit.text).toBe(json({}));
    expect(edit.entry).toEqual([ours]);
  });

  it('removes only its own hook: other hooks, other groups and other events stay', () => {
    const other = { matcher: 'startup', hooks: [{ type: 'command', command: 'echo other' }] };
    const before = json({
      keep: true,
      hooks: { Stop: [other], SessionStart: [other, ourGroup, { matcher: 'resume', hooks: [{ type: 'command', command: 'echo x' }, ours] }] },
    });
    const edit = uninstallHook(before);
    expect(JSON.parse(edit.text)).toEqual({
      keep: true,
      hooks: { Stop: [other], SessionStart: [other, { matcher: 'resume', hooks: [{ type: 'command', command: 'echo x' }] }] },
    });
  });

  it('keeps a hooks object that still has other events, and drops only an emptied SessionStart', () => {
    const edit = uninstallHook(json({ hooks: { Stop: [{ hooks: [] }], SessionStart: [ourGroup] } }));
    expect(JSON.parse(edit.text)).toEqual({ hooks: { Stop: [{ hooks: [] }] } });
  });

  it('removes every entry of ours, whichever version wrote it', () => {
    const other = { matcher: 'startup', hooks: [{ type: 'command', command: 'echo other' }] };
    const before = json({
      hooks: {
        SessionStart: [
          { matcher: 'startup', hooks: [{ type: 'command', command: 'mcpkit hook session-start' }] },
          other,
          { matcher: 'resume', hooks: [{ type: 'command', command: 'mcpkit hook session-start --agent codex' }, ours] },
        ],
      },
    });
    const edit = uninstallHook(before);
    expect(JSON.parse(edit.text)).toEqual({ hooks: { SessionStart: [other] } });
    expect(edit.entry).toEqual([
      { type: 'command', command: 'mcpkit hook session-start' },
      { type: 'command', command: 'mcpkit hook session-start --agent codex' },
      ours,
    ]);
  });

  it('does not remove a command that only contains or wraps its own', () => {
    const wrapped = ['/usr/bin/mcpkit hook session-start', 'echo mcpkit hook session-start', 'mcpkit search session-start'];
    const before = json({ hooks: { SessionStart: [{ matcher: 'startup', hooks: wrapped.map((command) => ({ type: 'command', command })) }] } });
    const edit = uninstallHook(before);
    expect(edit.changed).toBe(false);
    expect(edit.text).toBe(before);
  });

  it('changes nothing when it is not installed, and leaves an empty SessionStart alone', () => {
    for (const before of [undefined, '', json({}), json({ hooks: {} }), json({ hooks: { SessionStart: [] } })]) {
      const edit = uninstallHook(before);
      expect(edit.changed).toBe(false);
      expect(edit.text).toBe(before ?? '');
    }
  });

  it('is the inverse of install for a file with other content', () => {
    const before = json({ model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'x' }] }] } });
    expect(uninstallHook(installHook(before, DEFAULT_MATCHER).text).text).toBe(before);
  });
});

describe('unifiedDiff', () => {
  it('shows an inserted block with its context', () => {
    const before = ['{', '  "a": 1,', '  "b": 2', '}', ''].join('\n');
    const after = ['{', '  "a": 1,', '  "b": 2,', '  "c": 3', '}', ''].join('\n');
    expect(unifiedDiff('s.json', before, after)).toBe([
      '--- s.json',
      '+++ s.json',
      '@@ -1,4 +1,5 @@',
      ' {',
      '   "a": 1,',
      '-  "b": 2',
      '+  "b": 2,',
      '+  "c": 3',
      ' }',
    ].join('\n'));
  });

  it('diffs a new file against /dev/null', () => {
    expect(unifiedDiff('s.json', undefined, '{}\n')).toBe(['--- /dev/null', '+++ s.json', '@@ -0,0 +1,1 @@', '+{}'].join('\n'));
  });

  it('is empty when nothing changed', () => {
    expect(unifiedDiff('s.json', 'a\n', 'a\n')).toBe('');
  });
});

describe('backupFile', () => {
  let dir = '';

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mcpkit-hook-backup-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('copies the exact bytes to <path>.mcpkit-bak-<yyyymmddhhmmss> with mode 0600', async () => {
    const path = join(dir, 'settings.json');
    const bytes = Buffer.from([0x7b, 0x7d, 0x0a, 0xff, 0x00]);
    await writeFile(path, bytes, { mode: 0o644 });

    const backup = await backupFile(path, new Date(2026, 10, 19, 7, 5, 9));
    expect(backup).toBe(`${path}.mcpkit-bak-20261119070509`);
    expect(await readFile(backup)).toEqual(bytes);
    expect((await stat(backup)).mode & 0o777).toBe(0o600);
  });

  it('never overwrites an earlier backup made in the same second', async () => {
    const path = join(dir, 'settings.json');
    await writeFile(path, 'one');
    const when = new Date(2026, 0, 2, 3, 4, 5);
    const first = await backupFile(path, when);
    await writeFile(path, 'two');
    const second = await backupFile(path, when);

    expect(second).not.toBe(first);
    expect(second.startsWith(`${path}.mcpkit-bak-20260102030405`)).toBe(true);
    expect(await readFile(first, 'utf-8')).toBe('one');
    expect(await readFile(second, 'utf-8')).toBe('two');
    expect((await readdir(dir)).sort()).toHaveLength(3);
  });

  it('fails without leaving a backup when there is nothing to copy', async () => {
    await mkdir(join(dir, 'sub'));
    await expect(backupFile(join(dir, 'missing.json'))).rejects.toThrow();
    expect(await readdir(dir)).toEqual(['sub']);
  });
});

describe('the stored command', () => {
  let dir = '';

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mcpkit-hook-command-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Runs HOOK_COMMAND the way a hook runner does, through `sh -c`, with a PATH that holds only `bin`. */
  function runThroughShell(bin: string): { status: number | null; stdout: string; stderr: string } {
    const run = spawnSync('/bin/sh', ['-c', HOOK_COMMAND], { env: { PATH: bin, MARK: join(dir, 'called') }, encoding: 'utf-8', input: '{}' });
    return { status: run.status, stdout: run.stdout, stderr: run.stderr };
  }

  async function fakeMcpkit(script: string): Promise<string> {
    const bin = join(dir, 'bin');
    await mkdir(bin);
    await writeFile(join(bin, 'mcpkit'), `#!/bin/sh\n${script}\n`);
    await chmod(join(bin, 'mcpkit'), 0o755);
    return bin;
  }

  it('exits 0 with nothing on stdout or stderr when there is no mcpkit on the PATH', async () => {
    const empty = join(dir, 'empty');
    await mkdir(empty);
    expect(runThroughShell(empty)).toEqual({ status: 0, stdout: '', stderr: '' });
  });

  it('exits 0 with nothing on stdout or stderr when mcpkit exits 1, as one without a hook command does', async () => {
    const bin = await fakeMcpkit(': > "$MARK"\necho "error: unknown command \'hook\'" >&2\nexit 1');
    expect(runThroughShell(bin)).toEqual({ status: 0, stdout: '', stderr: '' });
    // It really ran: the fake mcpkit was reached and failed.
    expect((await stat(join(dir, 'called'))).isFile()).toBe(true);
  });

  it('passes through what a working mcpkit prints, and the arguments it is given', async () => {
    const bin = await fakeMcpkit('echo "args: $*"');
    expect(runThroughShell(bin)).toEqual({ status: 0, stdout: 'args: hook session-start\n', stderr: '' });
  });
});

describe('hasInstalledHook', () => {
  it('is true for the entry install writes and for an earlier entry with the bare command', () => {
    expect(hasInstalledHook(installHook(undefined, DEFAULT_MATCHER).text)).toBe(true);
    expect(hasInstalledHook(json({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'mcpkit hook session-start' }] }] } }))).toBe(true);
  });

  it.each([
    ['a missing file', undefined],
    ['an empty file', ''],
    ['invalid JSON', '{ nope'],
    ['a JSON array', '[]'],
    ['no hooks', json({ model: 'opus' })],
    ['hooks of the wrong type', json({ hooks: [] })],
    ['SessionStart of the wrong type', json({ hooks: { SessionStart: {} } })],
    ['only other SessionStart hooks', json({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] } })],
    ['our command under another event', json({ hooks: { Stop: [{ hooks: [{ type: 'command', command: HOOK_COMMAND }] }] } })],
  ])('is false for %s, and never throws', (_label, text) => {
    expect(hasInstalledHook(text)).toBe(false);
  });
});

describe('timestamp', () => {
  it('is the local time as yyyymmddhhmmss', () => {
    expect(timestamp(new Date(2026, 0, 2, 3, 4, 5))).toBe('20260102030405');
  });
});
