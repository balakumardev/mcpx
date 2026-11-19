import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getRuntimeDir, getRuntimeLogPath, getRuntimeMetadataPath, isProcessRunning } from './runtime-store.js';
import { runModuleScript, sourceUrl } from './test-utils.js';

/** Minimal MCP server over stdio. Every start appends its pid to FAKE_START_LOG, so a test can count servers. */
const FAKE_SERVER = `
import { appendFileSync } from 'node:fs';
import readline from 'node:readline';
if (process.env.FAKE_START_LOG) appendFileSync(process.env.FAKE_START_LOG, process.pid + '\\n');
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: {
      protocolVersion: message.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'fake', version: '1.0.0' },
    } });
    return;
  }
  if (message.method !== 'tools/call') return;
  send({ jsonrpc: '2.0', id: message.id, result: {
    content: [{ type: 'text', text: JSON.stringify({ tool: message.params.name, args: message.params.arguments, serverPid: process.pid }) }],
  } });
});
`;

const MINI_CLI = `
globalThis.__PKG_VERSION__ = 'test';
const { Command } = await import(${JSON.stringify(sourceUrl('node_modules/commander/esm.mjs'))});
const { createCallCommand } = await import(${JSON.stringify(sourceUrl('src/commands/call.ts'))});
const { createRuntimeCommand } = await import(${JSON.stringify(sourceUrl('src/commands/runtime.ts'))});
const program = new Command().name('mcpkit');
program.addCommand(createCallCommand());
program.addCommand(createRuntimeCommand());
program.parse();
`;

const SERVER = 'exclp';

describe('exactly one runtime host per server, through separate CLI processes', () => {
  const originalHome = process.env.HOME;
  const originalStartLog = process.env.FAKE_START_LOG;
  let homeDir = '';
  let startLog = '';

  const cli = (...args: string[]) => runModuleScript(homeDir, 'mini-cli.mjs', MINI_CLI, homeDir, args);
  const modeOf = async (path: string) => (await stat(path)).mode & 0o777;

  async function serverStarts(): Promise<number[]> {
    return (await readFile(startLog, 'utf-8').catch(() => '')).split('\n').filter(Boolean).map(Number);
  }

  async function hostPid(): Promise<number> {
    return Number(/PID:\s+(\d+)/.exec(await cli('runtime', 'status', SERVER))?.[1]);
  }

  async function allGone(pids: number[], ms: number): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline && pids.some(isProcessRunning)) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return !pids.some(isProcessRunning);
  }

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'mcpkit-exclusive-'));
    process.env.HOME = homeDir;
    startLog = join(homeDir, 'server-starts.log');
    process.env.FAKE_START_LOG = startLog;
    const serverPath = join(homeDir, 'fake-server.mjs');
    await writeFile(serverPath, FAKE_SERVER, 'utf-8');
    const now = new Date().toISOString();
    await mkdir(join(homeDir, '.mcpkit'), { recursive: true });
    await writeFile(join(homeDir, '.mcpkit', 'servers.yaml'), [
      'version: 1',
      'servers:',
      `  ${SERVER}:`,
      `    name: ${SERVER}`,
      '    transport:',
      '      type: stdio',
      `      command: ${JSON.stringify(process.execPath)}`,
      `      args: [${JSON.stringify(serverPath)}]`,
      '    runtime:',
      '      mode: persistent',
      '      idleTimeoutSec: 60',
      '      callTimeoutSec: 30',
      '    toolCount: 1',
      '    agents: [cursor]',
      `    createdAt: ${now}`,
      `    updatedAt: ${now}`,
      '',
    ].join('\n'), 'utf-8');
  });

  afterEach(async () => {
    await cli('runtime', 'stop', SERVER).catch(() => undefined);
    // A build without the fix leaves extra servers (and their hosts) running: remove what this test started.
    for (const pid of await serverStarts()) {
      if (isProcessRunning(pid)) process.kill(pid, 'SIGKILL');
    }
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalStartLog === undefined) delete process.env.FAKE_START_LOG;
    else process.env.FAKE_START_LOG = originalStartLog;
    await rm(homeDir, { recursive: true, force: true });
  });

  it('a second host for a running server exits at once, starts no server and leaves the first host as it was', async () => {
    const first = JSON.parse(await cli('call', SERVER, 'echo', '{"n":1}'));
    const firstHost = await hostPid();
    const recordBefore = await readFile(getRuntimeMetadataPath(SERVER), 'utf-8');
    expect(await serverStarts()).toEqual([first.serverPid]);

    const second = spawn(process.execPath, ['--import', 'tsx', join(homeDir, 'mini-cli.mjs'), 'runtime', '_host', SERVER], {
      cwd: process.cwd(),
      env: { ...process.env, HOME: homeDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    second.stdout.on('data', (chunk) => { output += chunk; });
    const outcome = await new Promise<{ code: number | null } | 'still running'>((resolve) => {
      const timer = setTimeout(() => resolve('still running'), 15_000);
      second.once('exit', (code) => { clearTimeout(timer); resolve({ code }); });
    });
    if (outcome === 'still running') second.kill('SIGKILL');

    expect(outcome).toEqual({ code: 0 });
    expect(output).toMatch(/already running/);
    expect(await serverStarts()).toEqual([first.serverPid]);
    expect(await hostPid()).toBe(firstHost);
    expect(await readFile(getRuntimeMetadataPath(SERVER), 'utf-8')).toBe(recordBefore);
    const again = JSON.parse(await cli('call', SERVER, 'echo', '{"n":2}'));
    expect(again.serverPid).toBe(first.serverPid);
  }, 60_000);

  it('starts one host and one server for ten parallel cold calls, and stop leaves nothing running', async () => {
    for (const round of [1, 2]) {
      const answers = await Promise.all(
        Array.from({ length: 10 }, (_, i) => cli('call', SERVER, 'echo', JSON.stringify({ round, i }))),
      );

      const servers = await serverStarts();
      expect(servers).toHaveLength(round);
      expect(new Set(answers.map((answer) => JSON.parse(answer).serverPid))).toEqual(new Set([servers.at(-1)]));

      const host = await hostPid();
      const stopped = await cli('runtime', 'stop', SERVER);
      expect(stopped).toContain('Stopped runtime');
      expect(stopped).not.toContain('Warning');
      expect(await allGone([host, ...servers], 5_000)).toBe(true);
    }
  }, 120_000);

  describe('what a runtime leaves on disk', () => {
    it('keeps the directory, the log and the record private to the owner', async () => {
      await cli('call', SERVER, 'echo', '{}');

      expect(await modeOf(getRuntimeDir())).toBe(0o700);
      expect(await modeOf(getRuntimeLogPath(SERVER))).toBe(0o600);
      expect(await modeOf(getRuntimeMetadataPath(SERVER))).toBe(0o600);
    });

    it('tightens a directory and a log that an older release left open, when the daemon starts', async () => {
      await mkdir(getRuntimeDir(), { recursive: true });
      await chmod(getRuntimeDir(), 0o755);
      await writeFile(getRuntimeLogPath(SERVER), 'an older run\n');
      await chmod(getRuntimeLogPath(SERVER), 0o644);

      await cli('call', SERVER, 'echo', '{}');

      expect(await modeOf(getRuntimeDir())).toBe(0o700);
      expect(await modeOf(getRuntimeLogPath(SERVER))).toBe(0o600);
      expect(await readFile(getRuntimeLogPath(SERVER), 'utf-8')).toMatch(/^an older run\n/);
    });
  });
});
