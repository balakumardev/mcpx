import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';
import { afterAll, beforeAll, describe, expect, it, vi, type TestContext } from 'vitest';
import { MAX_TIMEOUT_MS, MIN_TIMEOUT_MS } from './limits.js';

/**
 * End to end through the real built CLI: `node dist/cli.js exec ...` with a
 * temporary HOME whose registry names the fixture MCP server. Nothing here
 * touches the real ~/.mcpkit. dist/ is built once per run by the vitest
 * global setup (test/setup/build-dist.ts); no test builds.
 */

const root = fileURLToPath(new URL('../../', import.meta.url));
const cliPath = join(root, 'dist', 'cli.js');
const fixturePath = join(root, 'test', 'fixtures', 'fixture-server.mjs');
const SECRET = 'hunter2';

// Each case starts real processes (the CLI, its sandbox child, the fixture server).
vi.setConfig({ testTimeout: 30_000 });

let home: string;
let scratch: string;
const homes: string[] = [];

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface Envelope {
  ok: boolean;
  result?: unknown;
  error?: { kind: string; message: string; tool?: string };
  logs: string[];
  calls: number;
  blocked: string[];
  truncated?: boolean;
}

interface CliOptions {
  stdin?: string;
  env?: Record<string, string>;
  /** A registry other than the shared one that names only the fixture server. */
  home?: string;
}

function startCli(args: string[], options: CliOptions = {}): { child: ChildProcess; done: Promise<CliResult> } {
  const child = spawn(process.execPath, [cliPath, 'exec', ...args], {
    cwd: scratch,
    env: { ...process.env, HOME: options.home ?? home, MCPKIT_TEST_SECRET: SECRET, ...options.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr?.on('data', (chunk) => {
    stderr += chunk;
  });
  child.stdin?.end(options.stdin ?? '');
  const done = new Promise<CliResult>((resolveRun) => {
    child.once('close', (code) => resolveRun({ code, stdout, stderr }));
  });
  return { child, done };
}

function runCli(args: string[], options: CliOptions = {}): Promise<CliResult> {
  return startCli(args, options).done;
}

async function exec(args: string[], options: CliOptions = {}): Promise<{ envelope: Envelope; code: number | null; stderr: string }> {
  const { code, stdout, stderr } = await runCli(args, options);
  const lines = stdout.split('\n').filter((line) => line !== '');
  expect(lines, `stdout must be exactly one line of JSON, got: ${stdout} (stderr: ${stderr})`).toHaveLength(1);
  return { envelope: JSON.parse(lines[0]) as Envelope, code, stderr };
}

function processes(): Array<{ pid: number; ppid: number; command: string }> {
  return execFileSync('ps', ['-A', '-o', 'pid=,ppid=,command='], { encoding: 'utf-8' })
    .split('\n')
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }));
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function eventually<T>(read: () => T | undefined, timeoutMs = 8000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
}

/** Find the sandbox child and the fixture server among the children of a running CLI. */
async function findChildren(cliPid: number): Promise<{ worker: number; server: number }> {
  return eventually(() => {
    const children = processes().filter((entry) => entry.ppid === cliPid);
    const worker = children.find((entry) => entry.command.includes('_sandbox-worker'));
    const server = children.find((entry) => entry.command.includes('fixture-server.mjs'));
    return worker && server ? { worker: worker.pid, server: server.pid } : undefined;
  });
}

/** A registry in `dir` holding the fixture server as `fx` and, under the given names, more entries. */
function writeRegistry(dir: string, extra: Record<string, Record<string, unknown>> = {}): void {
  const stamp = '2026-01-01T00:00:00.000Z';
  const entry = (name: string, more: Record<string, unknown> = {}) => ({
    name,
    transport: { type: 'stdio', command: process.execPath, args: [fixturePath] },
    toolCount: 7,
    agents: [],
    createdAt: stamp,
    updatedAt: stamp,
    ...more,
  });
  const servers: Record<string, unknown> = { fx: entry('fx') };
  for (const [name, more] of Object.entries(extra)) servers[name] = entry(name, more);
  mkdirSync(join(dir, '.mcpkit'), { recursive: true });
  writeFileSync(join(dir, '.mcpkit', 'servers.yaml'), stringify({ version: 1, servers }));
}

/** A fresh HOME with its own registry. */
function newHome(extra: Record<string, Record<string, unknown>> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'mcpkit-exec-home-'));
  homes.push(dir);
  writeRegistry(dir, extra);
  return dir;
}

function lines(file: string): string[] {
  return existsSync(file) ? readFileSync(file, 'utf-8').split('\n').filter((line) => line !== '') : [];
}

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'mcpkit-exec-home-'));
  scratch = mkdtempSync(join(tmpdir(), 'mcpkit-exec-scratch-'));
  writeRegistry(home);
});

afterAll(() => {
  for (const dir of homes) rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});

describe('exec through the built CLI: the envelope and exit codes', () => {
  it('prints the ok envelope for a script that needs no server', async () => {
    const { envelope, code } = await exec(['-c', 'return 1 + 1']);
    expect(code).toBe(0);
    expect(envelope).toEqual({ ok: true, result: 2, logs: [], calls: 0, blocked: [], truncated: false });
  });

  it('captures logs and reports a script error with exit 1', async () => {
    const { envelope, code } = await exec(['-c', "console.log('before'); console.warn('hmm'); throw new Error('nope')"]);
    expect(code).toBe(1);
    expect(envelope.ok).toBe(false);
    expect(envelope.error).toEqual({ kind: 'script', message: 'Error: nope (script line 1, column 60)' });
    expect(envelope.logs).toEqual(['before', '[warn] hmm']);
    expect(Object.keys(envelope)).toEqual(['ok', 'error', 'logs', 'calls', 'blocked']);
  });

  it('reads the script from a file, from stdin and from --code', async () => {
    const file = join(scratch, 'script.ts');
    writeFileSync(file, 'const n: number = 20;\nreturn n + 1;\n');
    expect((await exec([file])).envelope.result).toBe(21);
    expect((await exec(['-'], { stdin: 'return 5 * 5' })).envelope.result).toBe(25);
    expect((await exec(['-c', 'return "inline"'])).envelope.result).toBe('inline');
  });

  it.each([
    ['no script at all', []],
    ['a file and --code together', ['some.js', '-c', 'return 1']],
    ['a script file that does not exist', [join('/nonexistent', 'script.js')]],
    ['an unknown option', ['--frobnicate', '-c', 'return 1']],
    ['a non-numeric --timeout', ['--timeout', 'soon', '-c', 'return 1']],
    ['a zero --timeout', ['--timeout', '0', '-c', 'return 1']],
    ['a --timeout that no timer can hold (2^31 ms)', ['--timeout', '2147483648', '-c', 'return 1']],
    ['a --timeout that leaves no room for the kill grace', ['--timeout', '2147483647', '-c', 'return 1']],
    ['a --memory-mb beyond what the VM can address', ['--memory-mb', '5000', '-c', 'return 1']],
    ['a partial wildcard in --allow', ['--allow', 'fx.e*', '-c', 'return 1']],
    ['a --max-calls that is no sane number of calls', ['--max-calls', '99999999999999999999', '-c', 'return 1']],
    ['a --max-output beyond the ceiling', ['--max-output', '9007199254740991', '-c', 'return 1']],
    ['a --timeout of 1 ms, which the sandbox start-up alone would exceed', ['--timeout', '1', '-c', 'return 1']],
    ['an empty --code', ['-c', '']],
    ['a --code of only whitespace', ['-c', '  \n\t ']],
  ])('exits 2 with nothing on stdout for %s', async (_label, args) => {
    const { code, stdout, stderr } = await runCli(args);
    expect(code).toBe(2);
    expect(stdout).toBe('');
    expect(stderr).toMatch(/error:/);
  });

  it('exits 2 for an empty script on stdin, and for an empty script file', async () => {
    const empty = await runCli(['-'], { stdin: '' });
    expect(empty.code).toBe(2);
    expect(empty.stdout).toBe('');
    expect(empty.stderr).toContain('the script is empty');

    const file = join(scratch, 'blank.js');
    writeFileSync(file, '\n  \n');
    expect((await runCli([file])).code).toBe(2);
  });

  it('says which bound an option broke', async () => {
    expect((await runCli(['--timeout', String(MIN_TIMEOUT_MS - 1), '-c', 'return 1'])).stderr)
      .toContain(`expected an integer from ${MIN_TIMEOUT_MS} to ${MAX_TIMEOUT_MS}`);
    expect((await runCli(['--max-calls', '100001', '-c', 'return 1'])).stderr).toContain('expected an integer from 0 to 100000');
    expect((await runCli(['--max-output', '67108865', '-c', 'return 1'])).stderr).toContain('expected an integer from 256 to 67108864');
  });

  it('still runs a script that is only a comment', async () => {
    const { envelope, code } = await exec(['-c', '// nothing to do']);
    expect(code).toBe(0);
    expect(envelope.result).toBeNull();
  });

  it('prints help and exits 0', async () => {
    const { code, stdout } = await runCli(['--help']);
    expect(code).toBe(0);
    expect(stdout).toContain('--allow-read-only');
    expect(stdout).toContain('trust the server-declared readOnlyHint');
    expect(stdout).toContain('not verified');
  });
});

describe('exec through the built CLI: tool calls and the write gate', () => {
  it('runs a read-only tool with --allow-read-only, judged by the live tool list, and returns structured content', async () => {
    const dir = newHome();
    const { envelope, code } = await exec(['--allow-read-only', '-c', 'return await mcp.fx.echo({ message: "hi" })'], { home: dir });
    expect(code).toBe(0);
    expect(envelope).toMatchObject({ ok: true, result: { message: 'hi' }, calls: 1, blocked: [] });
    // The live list is not saved: exec reads the schema cache for suggestions and writes nothing.
    expect(existsSync(join(dir, '.mcpkit', 'schemas', 'fx.json'))).toBe(false);
  });

  it('supports both mcp["server"].tool and mcp.server.tool, text, JSON text and Promise.all', async () => {
    const script = `
      const a = await mcp["fx"].add({ a: 2, b: 3 });
      const items = await mcp.fx.list_items();
      const many = await Promise.all(Array.from({ length: 20 }, (_, i) => mcp.fx.echo({ message: 'm' + i })));
      return { a, names: items.map((i) => i.name), count: many.length, last: many[19].message };
    `;
    const { envelope, code } = await exec(['--allow', 'fx.add,fx.list_items', '--allow', 'fx.echo', '-c', script]);
    expect(code).toBe(0);
    expect(envelope.result).toEqual({ a: 5, names: ['one', 'two', 'three'], count: 20, last: 'm19' });
    expect(envelope.calls).toBe(22);
  });

  it('blocks a write by default; the script can catch it, and the envelope still lists it', async () => {
    const script = `
      try { await mcp.fx.write_note({ text: 'x' }); return 'ran'; }
      catch (e) { return { message: e.message, kind: e.kind, tool: e.tool }; }
    `;
    const { envelope, code } = await exec(['--allow-read-only', '-c', script]);
    expect(code).toBe(0);
    expect(envelope.ok).toBe(true);
    expect(envelope.blocked).toEqual(['fx.write_note']);
    expect(envelope.result).toEqual({
      message:
        'mcpkit: blocked fx.write_note (not allowed). Re-run with --allow fx.write_note, '
        + '--allow-read-only (if the server marks it read-only) or --allow-writes.',
      kind: 'blocked',
      tool: 'fx.write_note',
    });
  });

  it('fails with kind blocked and exit 1 when the blocked call is not caught', async () => {
    const { envelope, code } = await exec(['-c', 'await mcp.fx.write_note({ text: "x" })']);
    expect(code).toBe(1);
    expect(envelope).toMatchObject({ ok: false, error: { kind: 'blocked', tool: 'fx.write_note' }, blocked: ['fx.write_note'] });
  });

  it.each([
    ['an exact --allow', ['--allow', 'fx.write_note']],
    ['a server wildcard', ['--allow', 'fx.*']],
    ['a tool wildcard', ['--allow', '*.write_note']],
    ['--allow-writes', ['--allow-writes']],
  ])('allows the write with %s', async (_label, flags) => {
    const { envelope, code } = await exec([...flags, '-c', 'return await mcp.fx.write_note({ text: "hello" })']);
    expect(code).toBe(0);
    expect(envelope).toMatchObject({ ok: true, result: { written: 'hello' }, blocked: [] });
  });

  it('turns a tool error into a catchable throw carrying server.tool and the message', async () => {
    const caught = await exec(['--allow', 'fx.fail', '-c', "try { await mcp.fx.fail({}); } catch (e) { return [e.message, e.kind, e.tool]; }"]);
    expect(caught.code).toBe(0);
    expect(caught.envelope.result).toEqual(['fx.fail failed: deliberate failure', 'tool', 'fx.fail']);

    const uncaught = await exec(['--allow', 'fx.fail', '-c', 'await mcp.fx.fail({})']);
    expect(uncaught.code).toBe(1);
    expect(uncaught.envelope.error).toEqual({ kind: 'tool', message: 'fx.fail failed: deliberate failure', tool: 'fx.fail' });
  });

  it('names the registered servers for an unknown server', async () => {
    const { envelope, code } = await exec(['--allow-writes', '-c', 'await mcp.nope.x({})']);
    expect(code).toBe(1);
    expect(envelope.error).toMatchObject({ kind: 'tool' });
    expect(envelope.error?.message).toBe('mcpkit: unknown server "nope". Registered servers: fx.');
  });

  it('names the nearest tools for an unknown tool, using the schema cache', async () => {
    const dir = newHome();
    mkdirSync(join(dir, '.mcpkit', 'schemas'), { recursive: true });
    const tools = ['echo', 'add', 'list_items', 'fail', 'write_note', 'slow', 'big'].map((name) => ({ name, description: '', inputSchema: { type: 'object' } }));
    writeFileSync(join(dir, '.mcpkit', 'schemas', 'fx.json'), JSON.stringify({ version: 1, server: 'fx', fetchedAt: '2026-01-01T00:00:00.000Z', tools }));
    const { envelope, code } = await exec(['-c', 'await mcp.fx.ech0({})'], { home: dir });
    expect(code).toBe(1);
    expect(envelope.error?.message).toContain('unknown tool fx.ech0.');
    expect(envelope.error?.message).toContain('Did you mean: echo');
    expect(envelope.blocked).toEqual([]);
  });

  it('truncates a large result and a large log at --max-output', async () => {
    const script = `
      const text = await mcp.fx.big({ kb: 300 });
      console.log(text);
      return text;
    `;
    const { envelope, code } = await exec(['--allow', 'fx.big', '--max-output', '2000', '-c', script]);
    expect(code).toBe(0);
    expect(envelope.truncated).toBe(true);
    expect(envelope.result).toMatch(/^"x{100}.*\[truncated: the result is 307202 bytes, the limit is 2000\]$/s);
    // The line is cut to the budget, and a final marker says that something is missing.
    expect(envelope.logs).toHaveLength(2);
    expect(envelope.logs[0].length).toBe(2000);
    expect(envelope.logs[1]).toMatch(/^\[logs truncated: the limit is 2000 bytes; 0 line\(s\) dropped, 1 line\(s\) shortened, about \d+ byte\(s\) removed in all\]$/);
  });

  it('stops a script that exceeds --max-calls', async () => {
    const { envelope, code } = await exec(['--allow', 'fx.echo', '--max-calls', '3', '-c', 'for (let i = 0; i < 10; i++) await mcp.fx.echo({ message: "x" });']);
    expect(code).toBe(1);
    expect(envelope.error?.kind).toBe('limit');
    expect(envelope.calls).toBe(3);
  });
});

describe('exec through the built CLI: limits and the sandbox boundary', () => {
  it('hides the globals of the parent process', async () => {
    const script = `
      return {
        types: [typeof process, typeof require, typeof fetch, typeof setTimeout, typeof globalThis.constructor],
        escape: (function () {}).constructor('return typeof process')(),
        secret: typeof process === 'undefined' ? null : process.env.MCPKIT_TEST_SECRET,
      };
    `;
    const { envelope } = await exec(['-c', script]);
    expect(envelope.result).toEqual({
      types: ['undefined', 'undefined', 'undefined', 'undefined', 'function'],
      escape: 'undefined',
      secret: null,
    });
    expect(JSON.stringify(envelope)).not.toContain(SECRET);
  });

  it('stops a runaway allocation at the memory limit', async () => {
    const { envelope, code } = await exec(['-c', "const big = 'x'.repeat(300 * 1024 * 1024); return big.length"]);
    expect(code).toBe(1);
    expect(envelope.error?.kind).toBe('limit');
    expect(envelope.error?.message).toContain('out of memory');
  });

  it('holds --memory-mb for strings, which a block-by-block allocation used to get past', async () => {
    const script = 'const a = []; for (let i = 0; i < 512; i++) a.push("x".repeat(1 << 20) + i); return a.length';
    const { envelope, code } = await exec(['--memory-mb', '8', '-c', script]);
    expect(code).toBe(1);
    expect(envelope.error).toEqual({ kind: 'limit', message: 'the script ran out of memory (limit 8 MiB, set with --memory-mb)' });
  });

  it('interrupts while(true){} at --timeout and leaves neither the sandbox nor the server running', async () => {
    const started = Date.now();
    // The call first, so both processes are known to exist while the loop spins.
    const script = 'await mcp.fx.echo({ message: "up" }); while (true) {}';
    const { child, done } = startCli(['--allow', 'fx.echo', '--timeout', '1500', '-c', script]);
    const { worker, server } = await findChildren(child.pid!);
    const { code, stdout } = await done;

    expect(code).toBe(1);
    expect(JSON.parse(stdout)).toMatchObject({ ok: false, error: { kind: 'timeout' }, calls: 1 });
    expect(Date.now() - started).toBeLessThan(10_000);
    await eventually(() => (isAlive(worker) || isAlive(server) ? undefined : true), 5000);
  });

  it('times out a call that never returns, and leaves neither the sandbox nor the server running', async () => {
    const { child, done } = startCli(['--allow', 'fx.slow', '--timeout', '2500', '-c', 'await mcp.fx.slow({ ms: 600000 })']);
    const { worker, server } = await findChildren(child.pid!);
    const { code, stdout } = await done;

    expect(code).toBe(1);
    expect(JSON.parse(stdout)).toMatchObject({ ok: false, error: { kind: 'timeout' }, calls: 1 });
    await eventually(() => (isAlive(worker) || isAlive(server) ? undefined : true), 5000);
  });

  it('does not give the sandbox child the parent environment (checked with ps while it runs)', async (context: TestContext) => {
    const { child, done } = startCli(['--allow', 'fx.slow', '--timeout', '2500', '-c', 'await mcp.fx.slow({ ms: 600000 })']);
    const { worker } = await findChildren(child.pid!);
    const environment = (pid: number): string => execFileSync('ps', ['eww', '-p', String(pid)], { encoding: 'utf-8' });
    const parentView = environment(child.pid!);
    const childView = environment(worker);
    await done;

    if (!parentView.includes(`MCPKIT_TEST_SECRET=${SECRET}`)) {
      context.skip('this platform does not show process environments through ps');
    }
    expect(childView).not.toContain(SECRET);
    expect(childView).not.toContain('MCPKIT_TEST_SECRET');
    expect(childView).not.toContain('HOME=');
  });

  it('ends cleanly on SIGINT: failure envelope, exit 1, no child left', async () => {
    const { child, done } = startCli(['--allow', 'fx.slow', '-c', 'await mcp.fx.slow({ ms: 600000 })']);
    const { worker, server } = await findChildren(child.pid!);
    child.kill('SIGINT');
    const { code, stdout } = await done;

    expect(code).toBe(1);
    expect(JSON.parse(stdout)).toMatchObject({ ok: false, error: { kind: 'interrupted', message: 'interrupted by SIGINT' } });
    await eventually(() => (isAlive(worker) || isAlive(server) ? undefined : true), 5000);
  });
});

describe('exec through the built CLI: the deadline and the interrupts are prompt, and nothing is left running', () => {
  /** Pids the fixture server logged: one per server process start, and the sleeping grandchildren it started. */
  const pidsIn = (file: string): number[] => lines(file).map(Number);
  const alivePids = (pids: number[]): number[] => pids.filter(isAlive);
  const killAll = (pids: number[]): void => {
    for (const pid of pids) if (isAlive(pid)) process.kill(pid, 'SIGKILL');
  };
  const gone = (pids: number[], timeoutMs = 3000): Promise<true> =>
    eventually(() => (alivePids(pids).length === 0 ? true : undefined), timeoutMs);

  function logs(name: string): { start: string; sleeper: string; env: Record<string, string> } {
    const start = join(scratch, `${name}-start.log`);
    const sleeper = join(scratch, `${name}-sleeper.log`);
    rmSync(start, { force: true });
    rmSync(sleeper, { force: true });
    return { start, sleeper, env: { FIXTURE_START_LOG: start, FIXTURE_SLEEPER: sleeper } };
  }

  it('returns in about a second for --timeout 500 against a tool that sleeps 10 s, and leaves nothing running', async () => {
    const files = logs('quick-timeout');
    const started = Date.now();
    const { envelope, code } = await exec(['--allow', 'fx.slow', '--timeout', '500', '-c', 'return await mcp.fx.slow({ ms: 10000 })'], { env: files.env });
    const wall = Date.now() - started;

    expect(code).toBe(1);
    // (The 500 ms may run out while the sandbox process is still starting, so `calls` is not asserted.)
    expect(envelope).toMatchObject({ ok: false, error: { kind: 'timeout' } });
    // 5.2 s before the fix, about 0.7 s after; the margin is for a busy machine.
    expect(wall).toBeLessThan(4000);
    await gone([...pidsIn(files.start), ...pidsIn(files.sleeper)]);
  });

  it('ends as a timeout when the script catches the timeout error of a slow call and carries on', async () => {
    const files = logs('catch-timeout');
    const started = Date.now();
    const script = 'try { await mcp.fx.slow({ ms: 4000 }); } catch (e) { console.log("caught", e.kind); } return "carried on";';
    const { envelope, code } = await exec(['--allow', 'fx.slow', '--timeout', '1000', '-c', script], { env: files.env });

    expect(code).toBe(1);
    expect(envelope).toMatchObject({ ok: false, error: { kind: 'timeout' } });
    expect(envelope).not.toHaveProperty('result');
    expect(Date.now() - started).toBeLessThan(4000);
    await gone([...pidsIn(files.start), ...pidsIn(files.sleeper)]);
  });

  it('is not held up by a server that is stopped (SIGSTOP) in the middle of a call', async () => {
    const files = logs('stopped-server');
    const { child, done } = startCli(['--allow', 'fx.slow', '--timeout', '1500', '-c', 'await mcp.fx.slow({ ms: 600000 })'], { env: files.env });
    const server = await eventually(() => pidsIn(files.start)[0]);
    process.kill(server, 'SIGSTOP');
    try {
      const started = Date.now();
      const { code, stdout } = await done;
      expect(code).toBe(1);
      expect(JSON.parse(stdout)).toMatchObject({ ok: false, error: { kind: 'timeout' } });
      // 9.1 s before the fix: the SDK waited for the stopped server to exit on its own.
      expect(Date.now() - started).toBeLessThan(5000);
      await gone([server, ...pidsIn(files.sleeper)]);
    } finally {
      killAll([server, ...pidsIn(files.sleeper)]);
      expect(child.exitCode).not.toBeNull();
    }
  });

  it('is not held up by a server that froze before it answered the handshake', async () => {
    const files = logs('frozen-at-start');
    const started = Date.now();
    const { code, stdout } = await runCli(['--allow', 'fx.echo', '--timeout', '1500', '-c', 'return await mcp.fx.echo({ message: "never" })'], {
      env: { ...files.env, FIXTURE_FREEZE: '1' },
    });
    try {
      expect(code).toBe(1);
      expect(JSON.parse(stdout)).toMatchObject({ ok: false, error: { kind: 'timeout' } });
      // 9.1 s before the fix, with --timeout 5000.
      expect(Date.now() - started).toBeLessThan(5000);
      await gone(pidsIn(files.start));
    } finally {
      killAll(pidsIn(files.start));
    }
  });

  it('acts on SIGINT within about a second, with the kind "interrupted", even with a stopped server', async () => {
    const files = logs('sigint-latency');
    const { child, done } = startCli(['--allow', 'fx.slow', '-c', 'await mcp.fx.slow({ ms: 600000 })'], { env: files.env });
    const { worker, server } = await findChildren(child.pid!);
    process.kill(server, 'SIGSTOP');
    try {
      const signalled = Date.now();
      child.kill('SIGINT');
      const { code, stdout } = await done;
      // 5.5 s before the fix.
      expect(Date.now() - signalled).toBeLessThan(3000);
      expect(code).toBe(1);
      expect(JSON.parse(stdout)).toMatchObject({ ok: false, error: { kind: 'interrupted', message: 'interrupted by SIGINT' } });
      await gone([worker, server, ...pidsIn(files.sleeper)]);
    } finally {
      killAll([server, ...pidsIn(files.sleeper)]);
    }
  });

  it('acts on SIGTERM as on SIGINT', async () => {
    const { child, done } = startCli(['--allow', 'fx.slow', '-c', 'await mcp.fx.slow({ ms: 600000 })']);
    const { worker, server } = await findChildren(child.pid!);
    const signalled = Date.now();
    child.kill('SIGTERM');
    const { code, stdout } = await done;
    expect(Date.now() - signalled).toBeLessThan(3000);
    expect(code).toBe(1);
    expect(JSON.parse(stdout)).toMatchObject({ ok: false, error: { kind: 'interrupted', message: 'interrupted by SIGTERM' } });
    await gone([worker, server]);
  });

  it('kills every child on the second signal before it exits', async () => {
    const files = logs('two-sigints');
    const { child, done } = startCli(['--allow', 'fx.slow', '-c', 'await mcp.fx.slow({ ms: 600000 })'], { env: files.env });
    const { worker, server } = await findChildren(child.pid!);
    const sleepers = await eventually(() => (pidsIn(files.sleeper).length > 0 ? pidsIn(files.sleeper) : undefined));
    // A stopped server cannot act on the first signal's SIGTERM before the grace period ends.
    process.kill(server, 'SIGSTOP');
    try {
      child.kill('SIGINT');
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
      child.kill('SIGINT');
      const { code } = await done;
      expect(code).toBe(1);
      // The processes are dead when the parent is, not a second or two later.
      expect(alivePids([worker, server, ...sleepers])).toEqual([]);
    } finally {
      killAll([server, ...sleepers]);
    }
  });

  it('kills a grandchild that ignores SIGTERM and was orphaned by the first signal, when the second one arrives', async () => {
    const files = logs('two-sigints-orphan');
    const env = { ...files.env, FIXTURE_SLEEPER_IGNORE_TERM: '1' };
    const { child, done } = startCli(['--allow', 'fx.slow', '-c', 'await mcp.fx.slow({ ms: 600000 })'], { env });
    const { worker, server } = await findChildren(child.pid!);
    const sleepers = await eventually(() => (pidsIn(files.sleeper).length > 0 ? pidsIn(files.sleeper) : undefined));
    process.kill(server, 'SIGSTOP');
    try {
      child.kill('SIGINT');
      // The first signal's SIGTERM ends the server; the sleeper ignores it and is now a child of init, which
      // a new walk below the parent cannot find. Only the processes the run remembered still lead to it.
      await eventually(() => (isAlive(server) ? undefined : true), 2000).catch(() => undefined);
      child.kill('SIGINT');
      const { code } = await done;
      expect(code).toBe(1);
      expect(alivePids([worker, server, ...sleepers])).toEqual([]);
    } finally {
      killAll([server, ...sleepers]);
    }
  });

  it('leaves no grandchild behind after a clean success either', async () => {
    const files = logs('clean-success');
    const { envelope, code } = await exec(['--allow', 'fx.echo', '-c', 'return await mcp.fx.echo({ message: "hi" })'], { env: files.env });
    expect(code).toBe(0);
    expect(envelope).toMatchObject({ ok: true, result: { message: 'hi' } });
    expect(pidsIn(files.sleeper)).toHaveLength(1);
    await gone([...pidsIn(files.start), ...pidsIn(files.sleeper)]);
  });
});

describe('exec through the built CLI: one session and one tool list per server', () => {
  it('starts the server once for 40 parallel calls under --allow-read-only', async () => {
    const dir = newHome();
    const log = join(scratch, 'starts-parallel.log');
    rmSync(log, { force: true });
    const script = 'return (await Promise.all(Array.from({ length: 40 }, (_, i) => mcp.fx.echo({ message: "m" + i })))).length';
    const { envelope, code } = await exec(['--allow-read-only', '-c', script], { home: dir, env: { FIXTURE_START_LOG: log } });
    expect(code).toBe(0);
    expect(envelope).toMatchObject({ ok: true, result: 40, calls: 40, blocked: [] });
    expect(lines(log)).toHaveLength(1);
  });

  it('never takes readOnlyHint from the schema cache: a stale cache cannot let a write through', async () => {
    const dir = newHome();
    mkdirSync(join(dir, '.mcpkit', 'schemas'), { recursive: true });
    writeFileSync(
      join(dir, '.mcpkit', 'schemas', 'fx.json'),
      JSON.stringify({
        version: 1,
        server: 'fx',
        fetchedAt: '2026-01-01T00:00:00.000Z',
        tools: [{ name: 'write_note', description: '', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }],
      }),
    );
    const { envelope, code } = await exec(['--allow-read-only', '-c', 'return await mcp.fx.write_note({ text: "stale" })'], { home: dir });
    expect(code).toBe(1);
    expect(envelope).toMatchObject({ ok: false, error: { kind: 'blocked', tool: 'fx.write_note' }, blocked: ['fx.write_note'] });
  });

  it('opens a fresh session after the connection closed, and says the failing call was not retried', async () => {
    const dir = newHome();
    const log = join(scratch, 'starts-crash.log');
    rmSync(log, { force: true });
    const script = `
      const out = {};
      try { await mcp.fx.crash({}); out.crash = 'returned'; } catch (e) { out.crash = e.message; }
      try { out.after = await mcp.fx.echo({ message: 'again' }); } catch (e) { out.after = 'FAILED: ' + e.message; }
      return out;`;
    const { envelope, code } = await exec(['--allow-writes', '-c', script], {
      home: dir,
      env: { FIXTURE_CRASH_TOOL: '1', FIXTURE_START_LOG: log },
    });
    expect(code).toBe(0);
    expect(envelope.result).toEqual({
      crash: 'fx.crash failed: the connection to fx closed during the call (the call was not retried: it may have taken effect)',
      after: { message: 'again' },
    });
    expect(lines(log)).toHaveLength(2);
  });
});

describe('exec through the built CLI: calls the script did not await', () => {
  it('lists an unawaited blocked call in blocked', async () => {
    const { envelope, code } = await exec(['-c', 'mcp.fx.write_note({ text: "x" }).catch(() => {}); return 1']);
    expect(code).toBe(0);
    expect(envelope).toEqual({ ok: true, result: 1, logs: [], calls: 1, blocked: ['fx.write_note'], truncated: false });
  });

  it('lets an unawaited allowed call run to the end before the process exits', async () => {
    const log = join(scratch, 'calls-unawaited.log');
    rmSync(log, { force: true });
    // Longer than the 2 s the MCP transport grants a server on close, so only waiting for the call can finish it.
    const { envelope, code } = await exec(['--allow', 'fx.slow', '-c', 'mcp.fx.slow({ ms: 2600 }); return 1'], { env: { FIXTURE_CALL_LOG: log } });
    expect(code).toBe(0);
    expect(envelope).toMatchObject({ ok: true, result: 1, calls: 1, blocked: [] });
    expect(lines(log)).toEqual(['slow 2600 start', 'slow 2600 done']);
  });
});

describe('exec through the built CLI: calls the script did not await, and calls made after it returned', () => {
  it('fails the run for an unawaited call the gate blocked, and says so on stderr as well', async () => {
    const { envelope, code, stderr } = await exec(['-c', 'mcp.fx.write_note({ text: "x" }); return "done"']);
    expect(code).toBe(1);
    expect(envelope).toMatchObject({ ok: false, error: { kind: 'blocked', tool: 'fx.write_note' }, calls: 1, blocked: ['fx.write_note'] });
    expect(envelope.error?.message).toContain('the call was not awaited');
    expect(stderr).toContain('warning: blocked fx.write_note');
  });

  it('fails the run for an unawaited call whose tool failed', async () => {
    const { envelope, code } = await exec(['--allow', 'fx.fail', '-c', 'mcp.fx.fail({}); return "done"']);
    expect(code).toBe(1);
    expect(envelope).toMatchObject({ ok: false, error: { kind: 'tool', tool: 'fx.fail' } });
    expect(envelope.error?.message).toContain('deliberate failure');
  });

  it('does not run a call that code started after the script returned, and says so in warnings', async () => {
    const { envelope, code } = await exec([
      '--allow-writes',
      '-c',
      'mcp.fx.slow({ ms: 100 }).then(() => mcp.fx.write_note({ text: "late" })); return "done"',
    ]);
    expect(code).toBe(0);
    expect(envelope).toEqual({
      ok: true,
      result: 'done',
      logs: [],
      calls: 1,
      blocked: [],
      truncated: false,
      warnings: ['mcp.fx.write_note() was called after the script returned, so it was not run'],
    });
  });

  it('writes a warning for every blocked call even when the script caught the error, and exits 0', async () => {
    const script = `
      for (const tool of ['write_note', 'write_note', 'other']) {
        try { await mcp.fx[tool]({ text: 'x' }); } catch (e) {}
      }
      return 'caught';`;
    const { envelope, code, stderr } = await exec(['-c', script]);
    expect(code).toBe(0);
    expect(envelope).toMatchObject({ ok: true, result: 'caught', blocked: ['fx.write_note', 'fx.other'] });
    const warning = (name: string): string =>
      `warning: blocked ${name}: the script's call was not allowed. Allow it with --allow ${name}, --allow-read-only (if the server marks it read-only) or --allow-writes.`;
    expect(stderr.split('\n').filter((line) => line.startsWith('warning: blocked '))).toEqual([
      warning('fx.write_note'),
      warning('fx.write_note'),
      warning('fx.other'),
    ]);
  });

  it('writes no blocked warning for an allowed call', async () => {
    const { stderr } = await exec(['--allow', 'fx.echo', '-c', 'return await mcp.fx.echo({ message: "x" })']);
    expect(stderr).toBe('');
  });
});

describe('exec through the built CLI: what the logs lose', () => {
  it('marks truncated and ends the logs with a marker when console output is cut at --max-output', async () => {
    const { envelope, code } = await exec(['-c', 'for (let i = 0; i < 300000; i++) console.log("line " + i); return 1']);
    expect(code).toBe(0);
    expect(envelope.truncated).toBe(true);
    const marker = envelope.logs.at(-1) as string;
    expect(marker).toMatch(/^\[logs truncated: the limit is 102400 bytes; \d+ line\(s\) dropped, 0 line\(s\) shortened, about \d+ byte\(s\) removed in all\]$/);
    const dropped = Number(/; (\d+) line\(s\) dropped/.exec(marker)?.[1]);
    expect(envelope.logs.length - 1 + dropped).toBe(300000);
  });

  it('marks truncated for one line that was cut to the per-line cap', async () => {
    const { envelope } = await exec(['-c', 'console.log("y".repeat(5 * 1024 * 1024)); return 1']);
    expect(envelope.truncated).toBe(true);
    expect(envelope.logs[0]).toHaveLength(65_536);
    expect(envelope.logs.at(-1)).toContain('1 line(s) shortened');
  });

  it('keeps the truncated flag and the marker when the run ends as a timeout while the logs overflow', async () => {
    const { envelope, code } = await exec(['--timeout', '1500', '-c', 'for (;;) console.log("spin")']);
    expect(code).toBe(1);
    expect(envelope).toMatchObject({ ok: false, error: { kind: 'timeout' }, truncated: true });
    expect(envelope.logs.at(-1)).toContain('[logs truncated:');
  });

  it('does not mark truncated when nothing was cut', async () => {
    const { envelope } = await exec(['-c', 'console.log("a"); return 1']);
    expect(envelope).toMatchObject({ truncated: false, logs: ['a'] });
  });
});

describe('exec through the built CLI: error kinds and messages', () => {
  it('reports arguments over 1 MiB as kind limit, which a script can catch', async () => {
    const { envelope, code } = await exec(['--allow', 'fx.echo', '-c', 'return await mcp.fx.echo({ message: "x".repeat(2 * 1024 * 1024) })']);
    expect(code).toBe(1);
    expect(envelope).toMatchObject({ ok: false, error: { kind: 'limit', tool: 'fx.echo' }, calls: 0 });

    const caught = await exec(['--allow', 'fx.echo', '-c', 'try { await mcp.fx.echo({ message: "x".repeat(2 * 1024 * 1024) }); } catch (e) { return e.kind; }']);
    expect(caught.envelope.result).toBe('limit');
  });

  it('reports a thrown string with the string as the message', async () => {
    const { envelope, code } = await exec(['-c', 'throw "x"']);
    expect(code).toBe(1);
    expect(envelope.error).toEqual({ kind: 'script', message: 'x' });
  });

  it('writes nothing to stderr and still exits with the envelope\'s code when the reader of stdout has gone away', async () => {
    const { child, done } = startCli(['--allow', 'fx.slow', '-c', 'await mcp.fx.slow({ ms: 600 }); return 1']);
    child.stdout?.destroy();
    const { code, stderr } = await done;
    expect(code).toBe(0);
    expect(stderr).not.toContain('EPIPE');
    expect(stderr).not.toContain('Unhandled');
    expect(stderr).not.toMatch(/\n\s+at /);
  });
});

describe('exec through the built CLI: warnings about --allow patterns', () => {
  const cache = (dir: string): void => {
    mkdirSync(join(dir, '.mcpkit', 'schemas'), { recursive: true });
    writeFileSync(
      join(dir, '.mcpkit', 'schemas', 'fx.json'),
      JSON.stringify({
        version: 1,
        server: 'fx',
        fetchedAt: '2026-01-01T00:00:00.000Z',
        tools: ['echo', 'add', 'write_note'].map((name) => ({ name, description: '', inputSchema: { type: 'object' } })),
      }),
    );
  };

  it('warns about an empty --allow, and goes on', async () => {
    const { envelope, code, stderr } = await exec(['--allow', '', '-c', 'return 1']);
    expect(code).toBe(0);
    expect(envelope.ok).toBe(true);
    expect(stderr).toBe('warning: --allow "" holds no pattern, so it allows nothing\n');
  });

  it('warns about a tool the server\'s cached tool list does not have, with the nearest names', async () => {
    const dir = newHome();
    cache(dir);
    const { envelope, stderr } = await exec(['--allow', 'fx.ech', '-c', 'return 1'], { home: dir });
    expect(envelope.ok).toBe(true);
    expect(stderr).toBe('warning: --allow fx.ech names no tool of fx in its cached tool list (cached 2026-01-01T00:00:00.000Z); did you mean: echo, add, write_note?\n');
  });

  it('does not warn for a tool that is cached, for a wildcard, or when there is no cache', async () => {
    const dir = newHome();
    cache(dir);
    expect((await exec(['--allow', 'fx.echo,fx.*,*.nothing', '-c', 'return 1'], { home: dir })).stderr).toBe('');
    expect((await exec(['--allow', 'fx.ech', '-c', 'return 1'])).stderr).toBe('');
  });

  it('never starts the server to check a pattern', async () => {
    const dir = newHome();
    cache(dir);
    const log = join(scratch, 'allow-check.log');
    rmSync(log, { force: true });
    await exec(['--allow', 'fx.typo', '-c', 'return 1'], { home: dir, env: { FIXTURE_START_LOG: log } });
    expect(lines(log)).toEqual([]);
  });
});

describe('exec through the built CLI: --allow patterns and the registered servers', () => {
  it('refuses a pattern that could mean two registered (server, tool) pairs, with exit 2', async () => {
    const dir = newHome({ a: {}, 'a.b': {} });
    const { code, stdout, stderr } = await runCli(['--allow', 'a.b.echo', '-c', 'return 1'], { home: dir });
    expect(code).toBe(2);
    expect(stdout).toBe('');
    expect(stderr).toContain('--allow pattern "a.b.echo" is ambiguous');
    expect(stderr).toContain('server "a", tool "b.echo"');
    expect(stderr).toContain('server "a.b", tool "echo"');
  });

  it('allows the one reading whose server is registered', async () => {
    const dir = newHome({ 'a.b': {} });
    const { envelope, code, stderr } = await exec(['--allow', 'a.b.echo', '-c', 'return await mcp["a.b"].echo({ message: "dots" })'], { home: dir });
    expect(code).toBe(0);
    expect(envelope).toMatchObject({ ok: true, result: { message: 'dots' }, blocked: [] });
    expect(stderr).toBe('');
  });

  it('warns once on stderr for a pattern that matches no registered server, and goes on', async () => {
    const { envelope, code, stderr } = await exec(['--allow', 'ghost.echo,fx.echo', '-c', 'return await mcp.fx.echo({ message: "x" })']);
    expect(code).toBe(0);
    expect(envelope).toMatchObject({ ok: true, result: { message: 'x' } });
    expect(stderr).toBe('warning: --allow pattern "ghost.echo" matches no registered server\n');
  });
});

describe('exec through the built CLI: what a failing param provider reveals', () => {
  const FAKE_STDERR = 'warning: refreshed; api_key=FAKE-SECRET-0123456789';
  const FAKE_STDOUT = 'token=FAKE-STDOUT-SECRET-9876';
  const FAKE_ARG = '--token=FAKE-ARG-SECRET-555';
  const FAKE_INJECTED = 'FAKE-INJECTED-SECRET';
  let dir: string;

  beforeAll(() => {
    const provider = (name: string, body: string): string => {
      const file = join(scratch, name);
      writeFileSync(file, body);
      return file;
    };
    const failing = provider('provider-stderr.mjs', `process.stderr.write(${JSON.stringify(`${FAKE_STDERR}\n`)}); process.exit(1);`);
    const garbage = provider('provider-stdout.mjs', `console.log(${JSON.stringify(FAKE_STDOUT)});`);
    const quiet = provider('provider-exit.mjs', 'process.exit(3);');
    const injecting = provider('provider-inject.mjs', `console.log(JSON.stringify({ message: ${JSON.stringify(FAKE_INJECTED)} }));`);
    const using = (command: string, args: string[]) => ({ paramProvider: { command, args } });
    dir = newHome({
      pe: using(process.execPath, [failing]),
      po: using(process.execPath, [garbage]),
      pa: using(process.execPath, [quiet, FAKE_ARG]),
      pc: { paramProvider: { command: `${process.execPath} ${quiet} ${FAKE_ARG}` } },
      pi: using(process.execPath, [injecting]),
    });
  });

  const probe = (server: string): string =>
    `try { return await mcp.${server}.echo({}); } catch (e) { return 'CAUGHT ' + e.kind + ' ' + e.message; }`;
  const everySecret = [FAKE_STDERR, 'FAKE-SECRET-0123456789', FAKE_STDOUT, 'FAKE-STDOUT-SECRET-9876', FAKE_ARG, 'FAKE-ARG-SECRET-555'];

  it.each([
    ['pe', /^CAUGHT tool pe\.echo failed: the param provider failed \(exit code 1, \d+ bytes of output\)$/],
    ['po', /^CAUGHT tool po\.echo failed: the param provider returned non-JSON output \(\d+ bytes\)$/],
    ['pa', /^CAUGHT tool pa\.echo failed: the param provider failed \(exit code 3, 0 bytes of output\)$/],
    ['pc', /^CAUGHT tool pc\.echo failed: the param provider failed \(exit code 3, 0 bytes of output\)$/],
  ])('keeps the provider output and command line out of the script and the envelope (%s)', async (server, message) => {
    const { envelope, code, stderr } = await exec(['--allow', `${server}.echo`, '-c', probe(server)], { home: dir });
    expect(code).toBe(0);
    expect(envelope.result).toMatch(message);
    for (const secret of everySecret) {
      expect(JSON.stringify(envelope)).not.toContain(secret);
      expect(stderr).not.toContain(secret);
    }
  });

  it('shows the provider output on the parent stderr, not in the envelope, with MCPKIT_DEBUG=1', async () => {
    const { envelope, stderr } = await exec(['--allow', 'pe.echo', '-c', probe('pe')], { home: dir, env: { MCPKIT_DEBUG: '1' } });
    expect(stderr).toContain('FAKE-SECRET-0123456789');
    expect(JSON.stringify(envelope)).not.toContain('FAKE-SECRET-0123456789');
  });

  it('merges provider parameters into every call (documented in --help), so an echoing tool returns them', async () => {
    const { envelope } = await exec(['--allow', 'pi.echo', '-c', 'return await mcp.pi.echo({})'], { home: dir });
    expect(envelope.result).toEqual({ message: FAKE_INJECTED });
    const help = await runCli(['--help']);
    expect(help.stdout).toContain('Parameters from a configured param provider are merged into every call, so a tool');
    expect(help.stdout).toContain('that echoes its arguments returns them to the script.');
  });
});

describe('exec through the built CLI: the failure kind is the host\'s to decide', () => {
  it.each([
    ['a plain object', 'throw { kind: "blocked", message: "fake", tool: "x.y" }'],
    ['an Error subclass with a kind field', 'class Forged extends Error { constructor() { super("fake"); this.kind = "blocked"; this.tool = "x.y"; } } throw new Forged()'],
    ['a Proxy', 'throw new Proxy({}, { get: () => "blocked" })'],
    ['a rewritten real error', 'try { await mcp.nope.x({}) } catch (e) { e.kind = "blocked"; e.tool = "x.y"; e.message = "fake"; throw new Error(e.message) }'],
    ['an engine-sounding object', 'throw { name: "InternalError", message: "out of memory" }'],
  ])('reports %s as a script error, with nothing in blocked', async (_label, code) => {
    const { envelope, code: exitCode } = await exec(['-c', code]);
    expect(exitCode).toBe(1);
    expect(envelope).toMatchObject({ ok: false, error: { kind: 'script' }, blocked: [] });
    expect(envelope.error?.tool).toBeUndefined();
  });
});

describe('exec through the built CLI: limits that need a live process', () => {
  it('ends a script that spins when the parent is killed with SIGKILL', async () => {
    // The call first: once the server process exists the script is running, and the loop follows at once.
    const { child, done } = startCli(['--allow', 'fx.echo', '--timeout', '120000', '-c', 'await mcp.fx.echo({ message: "up" }); while (true) {}']);
    const { worker } = await findChildren(child.pid!);
    // Only a loop that never yields can be reached by the interrupt handler alone, so let it settle into the loop.
    await new Promise((resolveWait) => setTimeout(resolveWait, 1500));
    const cpu = (): number => Number(execFileSync('ps', ['-o', '%cpu=', '-p', String(worker)], { encoding: 'utf-8' }).trim());
    await eventually(() => (cpu() > 50 ? true : undefined), 10_000);
    child.kill('SIGKILL');
    await done;
    try {
      await eventually(() => (isAlive(worker) ? undefined : true), 3500);
    } finally {
      if (isAlive(worker)) process.kill(worker, 'SIGKILL');
    }
  });

  it('accepts the largest --timeout without a timer overflow warning', async () => {
    const { envelope, code, stderr } = await exec(['--timeout', String(MAX_TIMEOUT_MS), '-c', 'return 1']);
    expect(code).toBe(0);
    expect(envelope.result).toBe(1);
    expect(stderr).not.toContain('TimeoutOverflowWarning');
  });

  it('explains the --timeout limit', async () => {
    const { code, stdout, stderr } = await runCli(['--timeout', '2147483648', '-c', 'return 1']);
    expect(code).toBe(2);
    expect(stdout).toBe('');
    expect(stderr).toContain(`option '--timeout <ms>' argument '2147483648' is invalid. expected an integer from ${MIN_TIMEOUT_MS} to ${MAX_TIMEOUT_MS}`);
  });
});

describe('exec through the built CLI: the line of JSON', () => {
  it('escapes U+0085, U+2028 and U+2029, so every reader sees one line', async () => {
    const [nel, ls, ps] = [0x85, 0x2028, 0x2029].map((code) => String.fromCharCode(code));
    const script = 'return "a" + String.fromCharCode(0x2028) + "b" + String.fromCharCode(0x2029) + "c" + String.fromCharCode(0x85) + "d"';
    const { code, stdout } = await runCli(['-c', script]);
    expect(code).toBe(0);
    for (const separator of [nel, ls, ps]) expect(stdout).not.toContain(separator);
    expect(stdout).toContain('a\\u2028b\\u2029c\\u0085d');
    const lineBreaks = new RegExp(`\r\n|[\n\r\v\f\x1c\x1d\x1e${nel}${ls}${ps}]`);
    expect(stdout.split(lineBreaks)).toEqual([expect.any(String), '']);
    expect((JSON.parse(stdout) as Envelope).result).toBe(`a${ls}b${ps}c${nel}d`);
  });
});

describe('exec through the built CLI: the bundle', () => {
  it('keeps the sandbox libraries and their WASM out of dist/cli.js', () => {
    const bundle = readFileSync(cliPath, 'utf-8');
    expect(bundle.length).toBeLessThan(1_000_000);
    expect(bundle).not.toContain('AGFzbQ');
    expect(bundle).toContain('import("quickjs-emscripten-core")');
    expect(bundle).toContain('import("sucrase")');
  });
});
