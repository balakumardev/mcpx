import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RUNTIME_PROTOCOL_VERSION } from './runtime-protocol.js';
import {
  computeRuntimeFingerprint,
  ensureRuntimeDir,
  getRuntimeLogPath,
  getRuntimeMetadataPath,
  getRuntimeSocketPath,
  isProcessRunning,
} from './runtime-store.js';
import { runModuleScript, sourceUrl } from './test-utils.js';
import type { ServerEntry } from './types.js';

/** Minimal MCP server over stdio: `echo` reports its own pid, `fail` reports isError. */
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
 * A runtime host as v0.1.29 ran it: same socket protocol, but a call reply carries only
 * `results` (no `values`, no `isError`), so a tool error looks like a success. Every request it
 * receives is appended to a file, so a test can tell whether a call ever reached it.
 */
const LEGACY_HOST = `
import { appendFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
const [serverName, socketPath, recordPath, logPath, fingerprint, requestsPath] = process.argv.slice(2);
const now = new Date().toISOString();
const record = {
  serverName, pid: process.pid, socketPath, logPath, fingerprint,
  startedAt: now, lastUsedAt: now, idleTimeoutSec: 60, callTimeoutSec: 30,
};
const server = createServer((socket) => {
  socket.on('data', (chunk) => {
    const request = JSON.parse(chunk.toString().trim());
    appendFileSync(requestsPath, request.type + '\\n');
    if (request.type === 'status') {
      socket.end(JSON.stringify({ requestId: request.requestId, ok: true, type: 'status', status: { ...record, running: true } }) + '\\n');
    } else if (request.type === 'call') {
      socket.end(JSON.stringify({ requestId: request.requestId, ok: true, type: 'call', results: ['OLD HOST ANSWER'] }) + '\\n');
    } else {
      socket.end(JSON.stringify({ requestId: request.requestId, ok: true, type: 'stop' }) + '\\n', () => {
        rmSync(recordPath, { force: true });
        rmSync(socketPath, { force: true });
        process.exit(0);
      });
    }
  });
});
server.listen(socketPath, () => {
  writeFileSync(recordPath, JSON.stringify(record, null, 2));
  console.log('ready');
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

/** v0.1.29 hashed this stable serialisation of {transport, paramProvider, runtime}. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const members = Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`);
    return `{${members.join(',')}}`;
  }
  return JSON.stringify(value);
}

function legacyFingerprint(entry: Pick<ServerEntry, 'transport'> & { runtime: Record<string, unknown> }): string {
  return createHash('sha256')
    .update(stableJson({ transport: entry.transport, paramProvider: null, runtime: entry.runtime }))
    .digest('hex');
}

/** What a host of protocol `version` would have computed: the payload of computeRuntimeFingerprint with that version. */
function fingerprintOfProtocol(
  version: number,
  entry: Pick<ServerEntry, 'transport'> & { runtime: Record<string, unknown> },
): string {
  return createHash('sha256')
    .update(stableJson({ protocol: version, transport: entry.transport, paramProvider: null, runtime: entry.runtime }))
    .digest('hex');
}

describe('a persistent runtime host started by the previous release', () => {
  const originalHome = process.env.HOME;
  let homeDir = '';
  let legacyHost: ChildProcess | undefined;

  const cli = (...args: string[]) => runModuleScript(homeDir, 'mini-cli.mjs', MINI_CLI, homeDir, args);
  const requestsPath = () => join(homeDir, 'legacy-requests.log');
  const requestsSeen = async () => (await readFile(requestsPath(), 'utf-8').catch(() => '')).split('\n').filter(Boolean);

  async function startLegacyHost(serverName: string, fingerprint: string): Promise<number> {
    await ensureRuntimeDir();
    const scriptPath = join(homeDir, 'legacy-host.mjs');
    await writeFile(scriptPath, LEGACY_HOST, 'utf-8');
    const child = spawn(process.execPath, [
      scriptPath,
      serverName,
      getRuntimeSocketPath(serverName),
      getRuntimeMetadataPath(serverName),
      getRuntimeLogPath(serverName),
      fingerprint,
      requestsPath(),
    ], { stdio: ['ignore', 'pipe', 'inherit'] });
    legacyHost = child;
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => reject(new Error(`legacy host exited early with code ${code}`)));
      child.stdout!.once('data', () => {
        child.removeAllListeners('exit');
        resolve();
      });
    });
    return child.pid!;
  }

  async function waitUntilGone(pid: number, ms: number): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (!isProcessRunning(pid)) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return !isProcessRunning(pid);
  }

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'mcpkit-legacy-host-'));
    process.env.HOME = homeDir;
    const serverPath = join(homeDir, 'fake-server.mjs');
    await writeFile(serverPath, FAKE_SERVER, 'utf-8');
    const now = new Date().toISOString();
    await mkdir(join(homeDir, '.mcpkit'), { recursive: true });
    await writeFile(join(homeDir, '.mcpkit', 'servers.yaml'), [
      'version: 1',
      'servers:',
      '  legacyp:',
      '    name: legacyp',
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
    if (legacyHost?.pid && isProcessRunning(legacyHost.pid)) legacyHost.kill('SIGKILL');
    legacyHost = undefined;
    await cli('runtime', 'stop', 'legacyp').catch(() => undefined);
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    await rm(homeDir, { recursive: true, force: true });
  });

  it('has a fingerprint that the current release never mistakes for its own', () => {
    const entry = {
      transport: { type: 'stdio' as const, command: 'node', args: ['/x/server.mjs'] },
      runtime: { mode: 'persistent', idleTimeoutSec: 60, callTimeoutSec: 30 },
    };

    // The value the v0.1.29 sources produced for this entry, frozen: it proves legacyFingerprint above is faithful.
    expect(legacyFingerprint(entry)).toBe('bdd5629cfcb62c143c81469f10d394ef4a4f75bf0fd60e111ef377b453187672');
    expect(computeRuntimeFingerprint({ transport: entry.transport, runtime: { mode: 'persistent', idleTimeoutSec: 60, callTimeoutSec: 30 } }))
      .not.toBe(legacyFingerprint(entry));
  });

  it('is stopped and replaced before any call is sent, so its answer (which cannot say isError) is never used', async () => {
    const legacyPid = await startLegacyHost('legacyp', legacyFingerprint({
      transport: { type: 'stdio', command: process.execPath, args: [join(homeDir, 'fake-server.mjs')] },
      runtime: { mode: 'persistent', idleTimeoutSec: 60, callTimeoutSec: 30 },
    }));
    expect(isProcessRunning(legacyPid)).toBe(true);

    const answer = JSON.parse(await cli('call', 'legacyp', 'echo', '{"n":1}'));

    expect(answer).toMatchObject({ tool: 'echo', args: { n: 1 } });
    expect(answer.serverPid).toEqual(expect.any(Number));
    const seen = await requestsSeen();
    expect(seen).not.toContain('call');
    expect(seen).toContain('stop');
    expect(await waitUntilGone(legacyPid, 5_000)).toBe(true);

    // The replacement reports tool errors: exit code 1, message on stderr.
    await expect(cli('call', 'legacyp', 'fail', '{}')).rejects.toThrow(/exited with code 1: .*Tool "fail" returned an error: boom/);
    expect(await requestsSeen()).not.toContain('call');
  }, 60_000);

  it('replaces a host of a NEWER protocol exactly as it replaces an older one: stopped first, never sent a call, no message', async () => {
    const entry = {
      transport: { type: 'stdio' as const, command: process.execPath, args: [join(homeDir, 'fake-server.mjs')] },
      runtime: { mode: 'persistent' as const, idleTimeoutSec: 60, callTimeoutSec: 30 },
    };
    // The helper agrees with the real thing at the current version, so the newer one differs only by the version.
    expect(fingerprintOfProtocol(RUNTIME_PROTOCOL_VERSION, entry)).toBe(computeRuntimeFingerprint(entry));
    const newerPid = await startLegacyHost('legacyp', fingerprintOfProtocol(RUNTIME_PROTOCOL_VERSION + 1, entry));
    expect(isProcessRunning(newerPid)).toBe(true);

    const answer = JSON.parse(await cli('call', 'legacyp', 'echo', '{"n":1}'));

    expect(answer).toMatchObject({ tool: 'echo', args: { n: 1 } });
    const seen = await requestsSeen();
    expect(seen).toContain('stop');
    expect(seen).not.toContain('call');
    expect(await waitUntilGone(newerPid, 5_000)).toBe(true);
  }, 60_000);

  it('replaces a host of protocol 2, which answers a call without saying what the result left out', async () => {
    const entry = {
      transport: { type: 'stdio' as const, command: process.execPath, args: [join(homeDir, 'fake-server.mjs')] },
      runtime: { mode: 'persistent' as const, idleTimeoutSec: 60, callTimeoutSec: 30 },
    };
    expect(RUNTIME_PROTOCOL_VERSION).toBe(3);
    const oldPid = await startLegacyHost('legacyp', fingerprintOfProtocol(2, entry));

    const answer = JSON.parse(await cli('call', 'legacyp', 'echo', '{"n":1}'));

    expect(answer).toMatchObject({ tool: 'echo', args: { n: 1 } });
    const seen = await requestsSeen();
    expect(seen).toContain('stop');
    expect(seen).not.toContain('call');
    expect(await waitUntilGone(oldPid, 5_000)).toBe(true);
  }, 60_000);
});
