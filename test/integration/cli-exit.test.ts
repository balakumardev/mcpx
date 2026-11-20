import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * How the built CLI (dist/cli.js, built once by the vitest global setup) ends its process: the event
 * loop alone decides, as it did before the start-up reconcile was added in front of the commands.
 * A top-level `await` on the parse would end the process with status 13 ("unsettled top-level await")
 * whenever a command's promise never settles, which `call --keepalive` does by design once its
 * server has died. Every process gets a throwaway HOME; nothing here reaches the real ~/.mcpkit.
 */

const root = fileURLToPath(new URL('../../', import.meta.url));
const cliPath = join(root, 'dist', 'cli.js');
const fixturePath = join(root, 'test', 'fixtures', 'fixture-server.mjs');

vi.setConfig({ testTimeout: 60_000 });

let home: string;
let startLog: string;

interface Finished {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function registerFixture(): void {
  mkdirSync(join(home, '.mcpkit'), { recursive: true });
  const entry = {
    name: 'fx',
    transport: { type: 'stdio', command: process.execPath, args: [fixturePath], env: { FIXTURE_START_LOG: startLog } },
    toolCount: 7,
    agents: ['claude-code'],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(join(home, '.mcpkit', 'servers.yaml'), stringify({ version: 1, servers: { fx: entry } }));
}

/** Start the CLI and wait for it to end; `during` runs once the process has printed `ready` on stderr. */
function runCli(args: string[], options: { ready?: string; during?: (child: ReturnType<typeof spawn>) => void } = {}): Promise<Finished> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: home,
      env: { ...process.env, HOME: home, USERPROFILE: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let signalled = false;
    // A hung process is a failed test, not a stuck run.
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
      if (!signalled && options.ready !== undefined && stderr.includes(options.ready)) {
        signalled = true;
        options.during?.(child);
      }
    });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
  });
}

/** The process id of the fixture server the CLI started last (the last line of the start log). */
function serverPid(): number {
  const pids = readFileSync(startLog, 'utf-8').trim().split('\n').map(Number);
  return pids[pids.length - 1];
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

beforeAll(() => {
  expect(existsSync(cliPath), `${cliPath} is missing: the vitest global setup (test/setup/build-dist.ts) builds it`).toBe(true);
  home = mkdtempSync(join(realpathSync(tmpdir()), 'mcpkit-exit-'));
  startLog = join(home, 'fixture-starts.log');
  registerFixture();
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('call --keepalive', () => {
  it('exits 0, with the result printed and no word about a top-level await, when its server is killed', async () => {
    const run = await runCli(['call', 'fx', 'echo', '{"message":"hi"}', '--keepalive'], {
      ready: 'Persistent stdio session active',
      during: () => { process.kill(serverPid(), 'SIGKILL'); },
    });

    expect(run.signal).toBeNull();
    expect(run.stderr).not.toMatch(/unsettled|top-level await/i);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toBe('{"message":"hi"}');
  });

  it('still ends on Ctrl+C: it closes the server it started and exits 0', async () => {
    const run = await runCli(['call', 'fx', 'echo', '{"message":"hi"}', '--keepalive'], {
      ready: 'Persistent stdio session active',
      during: (child) => { child.kill('SIGINT'); },
    });

    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toBe('{"message":"hi"}');
    // The server of this run is the last one started: it must be gone, or the CLI left it running. It gets
    // its SIGTERM when the CLI closes the session, so it may take a moment to be gone: poll, up to two seconds.
    const pid = serverPid();
    const deadline = Date.now() + 2000;
    while (alive(pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    expect(alive(pid), `the fixture server ${pid} is still running`).toBe(false);
  });
});

describe('an action that throws', () => {
  it('still ends the process with exit 1 and the error and its stack on stderr, as it did when the parse was not awaited', async () => {
    // `runtime _host` does not catch the error of an unregistered server: the one place where a command's promise rejects.
    const run = await runCli(['runtime', '_host', 'no-such-server']);

    expect(run.code).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('Error: Server "no-such-server" not found.');
    expect(run.stderr).toMatch(/\n {4}at /);
    expect(run.stderr).toMatch(/Node\.js v\d+/);
    expect(run.stderr).not.toMatch(/unsettled|top-level await/i);
  });
});
