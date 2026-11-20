import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startFakeOAuthServer, type FakeOAuthServer } from '../../src/oauth-test-server.js';

/**
 * Who may open a browser, through the real built CLI (dist/cli.js, built once by the vitest global
 * setup) with a throwaway HOME. A fake OAuth-protected MCP server answers on 127.0.0.1; a working stdio
 * fixture server and an unreachable one stand next to it, so a batch command has something to carry on
 * with. The system browser opener cannot run: `open` and `xdg-open` on PATH are scripts that only write
 * the URL they were given to a log, and the log is how a test sees that a browser would have opened.
 */

const root = fileURLToPath(new URL('../../', import.meta.url));
const cliPath = join(root, 'dist', 'cli.js');
const fixturePath = join(root, 'test', 'fixtures', 'fixture-server.mjs');

vi.setConfig({ testTimeout: 60_000 });

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
}

let base: string;
let stubBin: string;
let fake: FakeOAuthServer;
let deadUrl: string;
let home: string;
let openerLog: string;

/** A URL on a port that nothing listens on. */
async function closedUrl(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}/mcp`;
}

function cli(args: string[], extraEnv: NodeJS.ProcessEnv = {}): Promise<CliResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: home,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        PATH: `${stubBin}:${process.env.PATH ?? ''}`,
        BROWSER: '/usr/bin/false',
        OPENER_LOG: openerLog,
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const killer = setTimeout(() => child.kill('SIGKILL'), 45_000);
    child.once('close', (code) => {
      clearTimeout(killer);
      resolve({ code, stdout, stderr, ms: Date.now() - started });
    });
  });
}

function entry(name: string, transport: Record<string, unknown>): Record<string, unknown> {
  return {
    name,
    transport,
    toolCount: 0,
    agents: ['claude-code'],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

const oauth = () => entry('oauthsrv', { type: 'http', url: fake.url, auth: 'oauth' });
const stdio = () => entry('stdiosrv', { type: 'stdio', command: process.execPath, args: [fixturePath] });
const dead = () => entry('deadsrv', { type: 'http', url: deadUrl });

function register(...entries: Array<Record<string, unknown>>): void {
  mkdirSync(join(home, '.mcpkit'), { recursive: true });
  const servers = Object.fromEntries(entries.map((candidate) => [candidate.name as string, candidate]));
  writeFileSync(join(home, '.mcpkit', 'servers.yaml'), stringify({ version: 1, servers }));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const readOpenerLog = (): string[] => (existsSync(openerLog) ? readFileSync(openerLog, 'utf-8').split('\n').filter(Boolean) : []);

/**
 * The URLs the stub opener was given. The stub is a child of the CLI that is still starting when the CLI
 * exits, so a URL that is expected is waited for (up to 5 s) instead of read at once.
 */
async function waitForOpened(count: number): Promise<string[]> {
  for (let waited = 0; waited < 5000 && readOpenerLog().length < count; waited += 50) await sleep(50);
  return readOpenerLog();
}

/** Nothing was opened: the stub gets a moment to show up if it was spawned after all, then the log must still be empty. */
async function expectNoBrowserOpened(): Promise<void> {
  await sleep(300);
  expect(readOpenerLog()).toEqual([]);
}

/** Not a crash: no stack frames and no Node banner (what a process killed by an uncaught exception prints). */
function expectNoCrash(result: CliResult): void {
  expect(result.stderr).not.toMatch(/\n\s+at /);
  expect(result.stderr).not.toContain('Node.js v');
  expect(result.stderr).not.toContain('Unhandled');
}

beforeAll(async () => {
  expect(existsSync(cliPath), `${cliPath} is missing: the vitest global setup (test/setup/build-dist.ts) builds it`).toBe(true);
  base = mkdtempSync(join(realpathSync(tmpdir()), 'mch-oauth-'));
  stubBin = join(base, 'bin');
  mkdirSync(stubBin);
  for (const name of ['open', 'xdg-open']) {
    writeFileSync(join(stubBin, name), '#!/bin/sh\nprintf "%s\\n" "$1" >> "$OPENER_LOG"\nexit 0\n');
    chmodSync(join(stubBin, name), 0o755);
  }
  fake = await startFakeOAuthServer();
  deadUrl = await closedUrl();
});

afterAll(async () => {
  await fake.close();
  rmSync(base, { recursive: true, force: true });
});

beforeEach(() => {
  home = mkdtempSync(join(base, 'home-'));
  openerLog = join(home, 'opener.log');
  fake.requests.length = 0;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('batch commands never open a browser', () => {
  it('sync skips the OAuth server with one line, carries on with the rest, and exits 0', async () => {
    register(oauth(), stdio(), dead());

    const result = await cli(['sync']);

    expect(result.code, result.stderr).toBe(0);
    expect(result.ms).toBeLessThan(30_000);
    expect(result.stderr).toContain('⚠ oauthsrv: needs sign-in (mcpkit auth oauthsrv); skipped');
    expect(result.stderr.split('\n').filter((line) => line.includes('oauthsrv'))).toHaveLength(1);
    expect(result.stdout).toMatch(/Found \d+ tool\(s\)/);
    expect(result.stdout).toContain('Synced 1 server(s)');
    expect(result.stderr).toContain('⚠ deadsrv:');
    expect(existsSync(join(home, '.claude', 'skills', 'mcpkit-stdiosrv', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(home, '.claude', 'skills', 'mcpkit-oauthsrv'))).toBe(false);
    expectNoCrash(result);
    await expectNoBrowserOpened();
    expect(fake.requests).toEqual([]);
  });

  it('update skips the OAuth server, updates the rest and exits 1 only because another server failed', async () => {
    register(oauth(), stdio(), dead());

    const result = await cli(['update']);

    expect(result.code).toBe(1);
    expect(result.ms).toBeLessThan(30_000);
    expect(result.stderr).toContain('⚠ oauthsrv: needs sign-in (mcpkit auth oauthsrv); skipped');
    expect(result.stdout).toMatch(/✓ stdiosrv: \d+ tool\(s\)/);
    expect(result.stderr).toContain('✗ deadsrv:');
    expect(result.stderr).toContain('Updated 1 of 3 server(s); 1 failed: deadsrv; 1 skipped, needs sign-in: oauthsrv');
    expectNoCrash(result);
    await expectNoBrowserOpened();
    expect(fake.requests).toEqual([]);
  });

  it('update exits 0 when the only thing left over is a server that needs sign-in', async () => {
    register(oauth(), stdio());

    const result = await cli(['update']);

    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toContain('⚠ oauthsrv: needs sign-in (mcpkit auth oauthsrv); skipped');
    expect(result.stdout).toContain('✓ Updated 1 of 2 server(s); 1 skipped, needs sign-in: oauthsrv');
    expectNoCrash(result);
    await expectNoBrowserOpened();
    expect(fake.requests).toEqual([]);
  });

  it('exec fails the call with the sign-in message and never opens a browser or contacts the server', async () => {
    register(oauth());
    mkdirSync(join(home, '.mcpkit', 'schemas'), { recursive: true });
    writeFileSync(join(home, '.mcpkit', 'schemas', 'oauthsrv.json'), JSON.stringify({
      version: 1,
      server: 'oauthsrv',
      fetchedAt: '2026-01-01T00:00:00.000Z',
      tools: [{ name: 'ping', description: 'Answer pong.', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }],
    }));

    const result = await cli(['exec', '--allow-read-only', '-c', 'return await mcp.oauthsrv.ping({})']);

    const envelope = JSON.parse(result.stdout.trim()) as { ok: boolean; error?: { message: string } };
    expect(envelope.ok).toBe(false);
    expect(envelope.error?.message).toContain('oauthsrv needs sign-in. Run: mcpkit auth oauthsrv');
    expectNoCrash(result);
    await expectNoBrowserOpened();
    expect(fake.requests).toEqual([]);
  });
});

describe('a command aimed at one server may sign in, and a failed sign-in is an ordinary error', () => {
  const short = { MCPKIT_OAUTH_TIMEOUT_MS: '300' };

  it.each([
    ['auth', ['auth', 'oauthsrv']],
    ['update <name>', ['update', 'oauthsrv']],
    ['sync <name>', ['sync', 'oauthsrv']],
    ['list <name>', ['list', 'oauthsrv']],
    ['call', ['call', 'oauthsrv', 'ping', '{}']],
  ])('%s opens the browser once, then reports the timeout: exit 1, one message, no stack', async (_label, args) => {
    register(oauth(), stdio());

    const result = await cli(args, short);

    expect(result.ms).toBeLessThan(30_000);
    expectNoCrash(result);
    const opened = await waitForOpened(1);
    expect(opened).toHaveLength(1);
    expect(opened[0].startsWith(`${fake.origin}/authorize?`)).toBe(true);
    expect(result.stderr + result.stdout).toContain('OAuth callback timed out after 300 ms. Try again with `mcpkit auth <server>`.');
    // `sync <name>` reports the failure as a warning and, like sync always has, exits 0; the others fail.
    expect(result.code).toBe(args[0] === 'sync' ? 0 : 1);
  });

  it('install of that server opens the browser once, and a failed sign-in registers nothing', async () => {
    register(stdio());

    const result = await cli(['install', fake.url, '--auth', 'oauth', '-n', 'newsrv', '--agent', 'claude-code'], short);

    expect(result.code).toBe(1);
    expectNoCrash(result);
    expect(await waitForOpened(1)).toHaveLength(1);
    expect(result.stderr).toContain('Error: OAuth callback timed out after 300 ms. Try again with `mcpkit auth <server>`.');
    expect(readFileSync(join(home, '.mcpkit', 'servers.yaml'), 'utf-8')).not.toContain('newsrv');
    expect(existsSync(join(home, '.claude', 'skills', 'mcpkit-newsrv'))).toBe(false);
  });
});
