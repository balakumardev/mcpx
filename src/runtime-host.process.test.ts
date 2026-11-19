import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectToolSession } from './client.js';
import { RuntimeHost } from './runtime-host.js';
import { callPersistentRuntime, getRuntimeStatus } from './runtime-manager.js';
import {
  computeRuntimeFingerprint,
  ensureRuntimeDir,
  getRuntimeClaimPath,
  getRuntimeLogPath,
  getRuntimeSocketPath,
  isProcessRunning,
  type RuntimeRecord,
} from './runtime-store.js';
import type { ServerEntry, TransportConfig } from './types.js';

const { spawn: realSpawn } = await vi.importActual<typeof import('node:child_process')>('node:child_process');

// Only the runtime manager's `spawn` is replaced (the MCP SDK starts its child through
// cross-spawn, which this mock does not touch).
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: vi.fn(),
}));

/**
 * A minimal MCP server over stdio, written without dependencies: it answers
 * initialize and tools/call, and can fail, stall or exit on request.
 */
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
  const reply = () => send({ jsonrpc: '2.0', id: message.id, result: {
    content: [{ type: 'text', text: JSON.stringify({ tool: name, args }) }],
    structuredContent: { tool: name, args },
  } });
  if (name === 'slow') setTimeout(reply, args.ms);
  else reply();
});
`;

describe('runtime host with a real MCP server process', () => {
  const originalHome = process.env.HOME;
  let homeDir = '';
  let transport: TransportConfig;
  const hosts: RuntimeHost[] = [];
  const foreign: ChildProcess[] = [];

  /** A live process that is not a host, standing in for one. Killed after the test. */
  function spawnForeign(): ChildProcess {
    const child = realSpawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    foreign.push(child);
    return child;
  }

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'mcpkit-runtime-process-'));
    process.env.HOME = homeDir;
    (globalThis as typeof globalThis & { __PKG_VERSION__?: string }).__PKG_VERSION__ = 'test';
    const scriptPath = join(homeDir, 'fake-server.mjs');
    await writeFile(scriptPath, FAKE_SERVER, 'utf-8');
    transport = { type: 'stdio', command: process.execPath, args: [scriptPath] };
  });

  afterEach(async () => {
    await Promise.all(hosts.splice(0).map((host) => host.close()));
    for (const child of foreign.splice(0)) child.kill('SIGKILL');
    delete (globalThis as typeof globalThis & { __PKG_VERSION__?: string }).__PKG_VERSION__;
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    await rm(homeDir, { recursive: true, force: true });
    vi.mocked(spawn).mockReset();
  });

  function persistentEntry(name: string): ServerEntry {
    return {
      name,
      transport,
      runtime: { mode: 'persistent', idleTimeoutSec: 30, callTimeoutSec: 30 },
      toolCount: 1,
      agents: ['cursor'],
      createdAt: '2026-04-14T00:00:00.000Z',
      updatedAt: '2026-04-14T00:00:00.000Z',
    };
  }

  /** What `runtime _host <name>` does in its own process, done in this one. */
  async function startHost(entry: ServerEntry): Promise<{ host: RuntimeHost; record: RuntimeRecord; pid: number | null }> {
    const now = new Date().toISOString();
    const record: RuntimeRecord = {
      serverName: entry.name,
      pid: process.pid,
      socketPath: getRuntimeSocketPath(entry.name),
      logPath: getRuntimeLogPath(entry.name),
      fingerprint: computeRuntimeFingerprint(entry),
      startedAt: now,
      lastUsedAt: now,
      idleTimeoutSec: 30,
      callTimeoutSec: 30,
    };
    const session = await connectToolSession(transport);
    await ensureRuntimeDir();
    const host = new RuntimeHost({
      record,
      session,
      logStream: createWriteStream(record.logPath, { flags: 'a' }),
    });
    await host.start();
    hosts.push(host);
    return { host, record, pid: (session.transport as unknown as { pid: number | null }).pid };
  }

  /** Fail the test instead of hanging when the host never closes. */
  async function closedWithin(host: RuntimeHost, ms: number): Promise<boolean> {
    return Promise.race([
      host.waitUntilClosed().then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
    ]);
  }

  it('applies the timeout option to the MCP request', async () => {
    const session = await connectToolSession(transport, undefined, undefined, undefined, { timeoutMs: 200 });

    try {
      const started = Date.now();
      await expect(session.callTool('slow', { ms: 1_500 })).rejects.toThrow(/timed out/i);
      expect(Date.now() - started).toBeLessThan(1_200);
      expect((await session.callTool('slow', { ms: 0 })).isError).toBe(false);
    } finally {
      await session.close();
    }
  });

  it('carries a tool error and a structured value through the socket', async () => {
    const entry = persistentEntry('real-errors');
    await startHost(entry);

    expect(await callPersistentRuntime(entry.name, entry, [{ toolName: 'fail', params: {} }])).toEqual([
      { text: 'boom', value: 'boom', isError: true },
    ]);

    const [success] = await callPersistentRuntime(entry.name, entry, [{ toolName: 'echo', params: { n: 1 } }]);
    expect(success).toEqual({
      text: JSON.stringify({ tool: 'echo', args: { n: 1 } }),
      value: { tool: 'echo', args: { n: 1 } },
      isError: false,
    });

    const chain = await callPersistentRuntime(entry.name, entry, [
      { toolName: 'echo', params: {} },
      { toolName: 'fail', params: {} },
      { toolName: 'echo', params: {} },
    ]);
    expect(chain.map((item) => item.isError)).toEqual([false, true]);
  });

  it('stops when the MCP server exits during a call, and fails that call', async () => {
    const entry = persistentEntry('real-dies-mid-call');
    const { host, record } = await startHost(entry);

    await expect(callPersistentRuntime(entry.name, entry, [{ toolName: 'die', params: {} }]))
      .rejects.toThrow(/connection closed/i);

    expect(await closedWithin(host, 5_000)).toBe(true);
    expect(existsSync(record.socketPath)).toBe(false);
    expect(await getRuntimeStatus(entry.name)).toBeUndefined();
  });

  it('stops when the idle MCP server process is killed', async () => {
    const entry = persistentEntry('real-killed-idle');
    const { host, record, pid } = await startHost(entry);
    expect((await getRuntimeStatus(entry.name, entry))?.running).toBe(true);

    process.kill(pid as number, 'SIGKILL');

    expect(await closedWithin(host, 5_000)).toBe(true);
    expect(host.getStatus().running).toBe(false);
    expect(existsSync(record.socketPath)).toBe(false);
  });

  it('starts a new host on the next call after the MCP server died', async () => {
    const entry = persistentEntry('real-respawn');
    const first = await startHost(entry);
    vi.mocked(spawn).mockImplementation(((_command: string, args: string[]) => {
      expect(args.slice(-3)).toEqual(['runtime', '_host', entry.name]);
      void startHost(entry);
      const child = new EventEmitter() as ChildProcess;
      Object.assign(child, { pid: 4242, unref: vi.fn() });
      setImmediate(() => child.emit('spawn'));
      return child;
    }) as never);

    await expect(callPersistentRuntime(entry.name, entry, [{ toolName: 'die', params: {} }])).rejects.toThrow();
    expect(await closedWithin(first.host, 5_000)).toBe(true);
    expect(spawn).not.toHaveBeenCalled();

    const [output] = await callPersistentRuntime(entry.name, entry, [{ toolName: 'echo', params: { again: true } }]);

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(output).toMatchObject({ value: { tool: 'echo', args: { again: true } }, isError: false });
    expect((await getRuntimeStatus(entry.name, entry))?.running).toBe(true);
  });

  describe('starting the host once', () => {
    /** A spawn that brings the host up a little later, as a real one does, and counts how often it was asked to. */
    function spawnStartingHostAfter(entry: ServerEntry, delayMs: number): void {
      vi.mocked(spawn).mockImplementation((() => {
        setTimeout(() => { void startHost(entry); }, delayMs);
        const child = new EventEmitter() as ChildProcess;
        Object.assign(child, { pid: 4242, unref: vi.fn() });
        setImmediate(() => child.emit('spawn'));
        return child;
      }) as never);
    }

    it('spawns a single host for many callers that find none running', async () => {
      const entry = persistentEntry('real-many-callers');
      spawnStartingHostAfter(entry, 300);

      const outputs = await Promise.all(
        Array.from({ length: 10 }, (_, n) => callPersistentRuntime(entry.name, entry, [{ toolName: 'echo', params: { n } }])),
      );

      expect(spawn).toHaveBeenCalledTimes(1);
      expect(outputs.map(([output]) => output.value)).toEqual(
        Array.from({ length: 10 }, (_, n) => ({ tool: 'echo', args: { n } })),
      );
    });

    it('waits for a host that is still starting instead of spawning another, and does not stop it', async () => {
      const entry = persistentEntry('real-slow-start');
      const starting = spawnForeign();
      await ensureRuntimeDir();
      await writeFile(getRuntimeClaimPath(entry.name), JSON.stringify({ pid: starting.pid, startedAt: new Date().toISOString() }));
      setTimeout(() => { void startHost(entry); }, 400);

      const [output] = await callPersistentRuntime(entry.name, entry, [{ toolName: 'echo', params: { late: true } }]);

      expect(spawn).not.toHaveBeenCalled();
      expect(output).toMatchObject({ value: { tool: 'echo', args: { late: true } }, isError: false });
      // The foreign process is only standing in for the starting host: it was never signalled.
      expect(starting.killed).toBe(false);
      expect(isProcessRunning(starting.pid!)).toBe(true);
    });

    it('replaces the claim of a host that died while starting, by spawning a new one', async () => {
      const entry = persistentEntry('real-died-starting');
      await ensureRuntimeDir();
      const dead = spawnSync(process.execPath, ['-e', '']).pid;
      await writeFile(getRuntimeClaimPath(entry.name), JSON.stringify({ pid: dead, startedAt: new Date().toISOString() }));
      spawnStartingHostAfter(entry, 50);

      const [output] = await callPersistentRuntime(entry.name, entry, [{ toolName: 'echo', params: {} }]);

      expect(spawn).toHaveBeenCalledTimes(1);
      expect(output.isError).toBe(false);
    });
  });
});
