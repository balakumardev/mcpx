import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isProcessRunning } from './runtime-store.js';
import { runModuleScript, sourceUrl } from './test-utils.js';

/** Minimal MCP server over stdio. `echo` reports its own pid, `die` exits mid-call, `fail` reports isError. */
const FAKE_SERVER = `
import readline from 'node:readline';
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
  const { name, arguments: args } = message.params;
  if (name === 'die') process.exit(3);
  if (name === 'fail') {
    send({ jsonrpc: '2.0', id: message.id, result: { isError: true, content: [{ type: 'text', text: 'boom' }] } });
    return;
  }
  send({ jsonrpc: '2.0', id: message.id, result: {
    content: [{ type: 'text', text: JSON.stringify({ tool: name, args, serverPid: process.pid }) }],
  } });
});
`;

/**
 * The CLI entry the runtime manager spawns for the background host is whatever
 * script is running (`process.argv[1] runtime _host <name>`), so this stand-in
 * registers just the commands under test.
 */
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

describe('persistent runtime through separate CLI processes', () => {
  const originalHome = process.env.HOME;
  let homeDir = '';

  const cli = (...args: string[]) => runModuleScript(homeDir, 'mini-cli.mjs', MINI_CLI, homeDir, args);

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'mcpkit-runtime-cli-'));
    process.env.HOME = homeDir;
    const serverPath = join(homeDir, 'fake-server.mjs');
    await writeFile(serverPath, FAKE_SERVER, 'utf-8');
    const now = new Date().toISOString();
    await mkdir(join(homeDir, '.mcpkit'), { recursive: true });
    await writeFile(join(homeDir, '.mcpkit', 'servers.yaml'), [
      'version: 1',
      'servers:',
      '  fakep:',
      '    name: fakep',
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
    await cli('runtime', 'stop', 'fakep').catch(() => undefined);
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    await rm(homeDir, { recursive: true, force: true });
  });

  async function hostPid(): Promise<number> {
    const status = await cli('runtime', 'status', 'fakep');
    return Number(/PID:\s+(\d+)/.exec(status)?.[1]);
  }

  async function waitUntilGone(pid: number, ms: number): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (!isProcessRunning(pid)) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return !isProcessRunning(pid);
  }

  it('answers the first call that has to start the host, exits 1 on a tool error, and recovers after the server dies', async () => {
    // Cold start: the CLI has to wait for the background host without exiting early.
    const first = JSON.parse(await cli('call', 'fakep', 'echo', '{"n":1}'));
    expect(first).toMatchObject({ tool: 'echo', args: { n: 1 } });

    // A tool error through the runtime: exit code 1, message on stderr, nothing on stdout.
    await expect(cli('call', 'fakep', 'fail', '{}')).rejects.toThrow(/exited with code 1: .*Tool "fail" returned an error: boom/);

    // The MCP server dies during a call: that call fails, the host process goes away.
    const firstHost = await hostPid();
    expect(isProcessRunning(firstHost)).toBe(true);
    await expect(cli('call', 'fakep', 'die', '{}')).rejects.toThrow(/exited with code 1: .*Connection closed/);
    expect(await waitUntilGone(firstHost, 5_000)).toBe(true);

    // The next call starts a new host and a new MCP server.
    const second = JSON.parse(await cli('call', 'fakep', 'echo', '{"n":2}'));
    expect(second).toMatchObject({ tool: 'echo', args: { n: 2 } });
    expect(second.serverPid).not.toBe(first.serverPid);
    expect(await hostPid()).not.toBe(firstHost);
  }, 60_000);
});
