import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConnectedToolSession, ToolCallOutput } from './client.js';
import { RuntimeAlreadyRunningError } from './runtime-claim.js';
import { RuntimeHost } from './runtime-host.js';
import { withRuntimeStartLock } from './runtime-lock.js';
import { callPersistentRuntime, getRuntimeStatus, stopRuntime } from './runtime-manager.js';
import {
  computeRuntimeFingerprint,
  ensureRuntimeDir,
  getRuntimeClaimPath,
  getRuntimeLockPath,
  getRuntimeLogPath,
  getRuntimeMetadataPath,
  getRuntimeSocketPath,
  readRuntimeClaim,
  type RuntimeRecord,
} from './runtime-store.js';
import type { ServerEntry } from './types.js';

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function output(text: string, overrides: Partial<ToolCallOutput> = {}): ToolCallOutput {
  return { text, value: text, isError: false, ...overrides };
}

function createPersistentEntry(serverName: string, idleTimeoutSec: number): ServerEntry {
  return {
    name: serverName,
    transport: { type: 'stdio', command: 'npx', args: [] },
    runtime: { mode: 'persistent', idleTimeoutSec },
    toolCount: 1,
    agents: ['cursor'],
    createdAt: '2026-04-14T00:00:00.000Z',
    updatedAt: '2026-04-14T00:00:00.000Z',
  };
}

function createRecord(serverName: string, idleTimeoutSec: number, fingerprint = 'test-fingerprint'): RuntimeRecord {
  const now = new Date().toISOString();
  return {
    serverName,
    pid: process.pid,
    socketPath: getRuntimeSocketPath(serverName),
    logPath: getRuntimeLogPath(serverName),
    fingerprint,
    startedAt: now,
    lastUsedAt: now,
    idleTimeoutSec,
    callTimeoutSec: 60,
  };
}

describe('RuntimeHost', () => {
  const originalHome = process.env.HOME;
  let homeDir = '';

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'mcpkit-runtime-'));
    process.env.HOME = homeDir;
  });

  afterEach(async () => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    await rm(homeDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('reuses one running host across separate persistent calls and serializes them', async () => {
    const serverName = 'browsermcp';
    const entry = createPersistentEntry(serverName, 5);
    const record = createRecord(serverName, 5, computeRuntimeFingerprint(entry));
    const callOrder: string[] = [];
    let activeCalls = 0;
    let maxActiveCalls = 0;

    const session: ConnectedToolSession = {
      client: {} as ConnectedToolSession['client'],
      transport: {} as ConnectedToolSession['transport'],
      close: vi.fn(async () => {}),
      callTool: vi.fn(async (_toolName: string, params: Record<string, unknown>) => {
        const id = String(params.id);
        callOrder.push(`start-${id}`);
        activeCalls += 1;
        maxActiveCalls = Math.max(maxActiveCalls, activeCalls);
        await wait(50);
        activeCalls -= 1;
        callOrder.push(`end-${id}`);
        return output(JSON.stringify({ id }), { value: { id } });
      }),
      callToolsChained: vi.fn(async () => []),
    };

    const host = new RuntimeHost({
      record,
      session,
      logStream: (await ensureRuntimeDir(), createWriteStream(record.logPath, { flags: 'a' })),
    });
    await host.start();

    try {
      const [first, second] = await Promise.all([
        callPersistentRuntime(serverName, entry, [{ toolName: 'step', params: { id: 'one' } }]),
        callPersistentRuntime(serverName, entry, [{ toolName: 'step', params: { id: 'two' } }]),
      ]);

      expect(first).toHaveLength(1);
      expect(second).toHaveLength(1);
      expect(maxActiveCalls).toBe(1);
      expect(callOrder).toHaveLength(4);
      expect(callOrder[0].startsWith('start-')).toBe(true);
      expect(callOrder[1]).toBe(`end-${callOrder[0].slice('start-'.length)}`);
      expect(callOrder[2].startsWith('start-')).toBe(true);
      expect(callOrder[3]).toBe(`end-${callOrder[2].slice('start-'.length)}`);

      const status = await getRuntimeStatus(serverName, entry);
      expect(status?.running).toBe(true);
      expect(status?.configStatus).toBe('current');
    } finally {
      await host.close();
    }
  });

  it('allows persistent tool calls to run longer than the status timeout', async () => {
    const serverName = 'slow-browsermcp';
    const entry = createPersistentEntry(serverName, 10);
    const record = createRecord(serverName, 10, computeRuntimeFingerprint(entry));

    const session: ConnectedToolSession = {
      client: {} as ConnectedToolSession['client'],
      transport: {} as ConnectedToolSession['transport'],
      close: vi.fn(async () => {}),
      callTool: vi.fn(async (_toolName: string, params: Record<string, unknown>) => {
        await wait(5_200);
        return output(JSON.stringify({ id: params.id }), { value: { id: params.id } });
      }),
      callToolsChained: vi.fn(async () => []),
    };

    const host = new RuntimeHost({
      record,
      session,
      logStream: (await ensureRuntimeDir(), createWriteStream(record.logPath, { flags: 'a' })),
    });
    await host.start();

    try {
      const results = await callPersistentRuntime(serverName, entry, [
        { toolName: 'step', params: { id: 'slow-call' } },
      ]);

      expect(results).toEqual([
        { text: JSON.stringify({ id: 'slow-call' }), value: { id: 'slow-call' }, isError: false },
      ]);
      expect(session.callTool).toHaveBeenCalledTimes(1);
    } finally {
      await host.close();
    }
  }, 10_000);

  it('stops an active runtime and cleans up metadata', async () => {
    const serverName = 'browsermcp';
    const record = createRecord(serverName, 5);
    const session: ConnectedToolSession = {
      client: {} as ConnectedToolSession['client'],
      transport: {} as ConnectedToolSession['transport'],
      close: vi.fn(async () => {}),
      callTool: vi.fn(async () => output('ok')),
      callToolsChained: vi.fn(async () => [output('ok')]),
    };

    const host = new RuntimeHost({
      record,
      session,
      logStream: (await ensureRuntimeDir(), createWriteStream(record.logPath, { flags: 'a' })),
    });
    await host.start();

    const stopped = await stopRuntime(serverName, { removeLog: true });
    await host.waitUntilClosed();

    expect(stopped).toBe(true);
    expect(session.close).toHaveBeenCalledTimes(1);
    expect(await getRuntimeStatus(serverName)).toBeUndefined();
  });

  it('shuts down after the idle timeout elapses', async () => {
    const serverName = 'idle-browsermcp';
    const record = createRecord(serverName, 1);
    const session: ConnectedToolSession = {
      client: {} as ConnectedToolSession['client'],
      transport: {} as ConnectedToolSession['transport'],
      close: vi.fn(async () => {}),
      callTool: vi.fn(async () => output('ok')),
      callToolsChained: vi.fn(async () => [output('ok')]),
    };

    const host = new RuntimeHost({
      record,
      session,
      logStream: (await ensureRuntimeDir(), createWriteStream(record.logPath, { flags: 'a' })),
    });
    await host.start();

    await wait(1_200);
    await host.waitUntilClosed();

    expect(session.close).toHaveBeenCalledTimes(1);
    expect(await getRuntimeStatus(serverName)).toBeUndefined();
  });

  describe('tool errors over the socket', () => {
    it('reports isError for a failed call and not for a successful one', async () => {
      const serverName = 'erroring';
      const entry = createPersistentEntry(serverName, 5);
      const record = createRecord(serverName, 5, computeRuntimeFingerprint(entry));
      const session = createSession({
        callTool: vi.fn(async (toolName: string) => (
          toolName === 'fail'
            ? output('boom', { isError: true })
            : output('{"ok":true}', { value: { ok: true } })
        )),
      });
      const host = await startHost(record, session);

      try {
        expect(await callPersistentRuntime(serverName, entry, [{ toolName: 'fail', params: {} }])).toEqual([
          { text: 'boom', value: 'boom', isError: true },
        ]);
        expect(await callPersistentRuntime(serverName, entry, [{ toolName: 'ok', params: {} }])).toEqual([
          { text: '{"ok":true}', value: { ok: true }, isError: false },
        ]);
      } finally {
        await host.close();
      }
    });

    it('marks only the last output of a chain that stopped on an error', async () => {
      const serverName = 'chain-erroring';
      const entry = createPersistentEntry(serverName, 5);
      const record = createRecord(serverName, 5, computeRuntimeFingerprint(entry));
      const session = createSession({
        callToolsChained: vi.fn(async () => [output('first'), output('second failed', { isError: true })]),
      });
      const host = await startHost(record, session);

      try {
        const outputs = await callPersistentRuntime(serverName, entry, [
          { toolName: 'a', params: {} },
          { toolName: 'b', params: {} },
          { toolName: 'c', params: {} },
        ]);
        expect(outputs.map((item) => item.isError)).toEqual([false, true]);
        expect(outputs.map((item) => item.text)).toEqual(['first', 'second failed']);
      } finally {
        await host.close();
      }
    });

    it('refuses a call reply that does not say whether the tool failed, instead of reporting success', async () => {
      const serverName = 'old-host';
      const entry = createPersistentEntry(serverName, 5);
      // A host of an older protocol has a different fingerprint and is replaced before any call is sent
      // (runtime-legacy-host.process.test.ts); this one claims the current fingerprint but replies in the old shape.
      const record = createRecord(serverName, 5, computeRuntimeFingerprint(entry));
      await ensureRuntimeDir();
      const { writeRuntimeRecord } = await import('./runtime-store.js');
      await writeRuntimeRecord(record);

      const oldHost = createServer((socket) => {
        socket.on('data', (chunk) => {
          const request = JSON.parse(chunk.toString().trim()) as { requestId: string; type: string };
          const response = request.type === 'status'
            ? {
              requestId: request.requestId,
              ok: true,
              type: 'status',
              status: { ...record, running: true, configStatus: 'current' },
            }
            : { requestId: request.requestId, ok: true, type: 'call', results: ['{"n":1}', 'plain'] };
          socket.end(`${JSON.stringify(response)}\n`);
        });
      });
      await new Promise<void>((resolve) => oldHost.listen(record.socketPath, resolve));

      try {
        await expect(callPersistentRuntime(serverName, entry, [
          { toolName: 'a', params: {} },
          { toolName: 'b', params: {} },
        ])).rejects.toThrow(/does not understand, so the outcome of the call is unknown.*mcpkit runtime stop old-host/);
      } finally {
        await new Promise<void>((resolve) => oldHost.close(() => resolve()));
      }
    });
  });

  describe('what a result leaves out', () => {
    it('carries what each call left out over the socket, and nothing for a call that left nothing out', async () => {
      const serverName = 'omitting';
      const entry = createPersistentEntry(serverName, 5);
      const record = createRecord(serverName, 5, computeRuntimeFingerprint(entry));
      const session = createSession({
        callTool: vi.fn(async () => output('{"w":3}', { value: { w: 3 }, omitted: ['image/png 48 bytes'] })),
        callToolsChained: vi.fn(async () => [
          output('plain'),
          output('two', { omitted: ['2 x image/png, 30 bytes', 'audio/wav 4 bytes'] }),
        ]),
      });
      const host = await startHost(record, session);

      try {
        expect(await callPersistentRuntime(serverName, entry, [{ toolName: 'shot', params: {} }])).toEqual([
          { text: '{"w":3}', value: { w: 3 }, isError: false, omitted: ['image/png 48 bytes'] },
        ]);
        const chain = await callPersistentRuntime(serverName, entry, [
          { toolName: 'a', params: {} },
          { toolName: 'b', params: {} },
        ]);
        expect(chain.map((item) => item.omitted)).toEqual([undefined, ['2 x image/png, 30 bytes', 'audio/wav 4 bytes']]);
        expect(chain[0]).not.toHaveProperty('omitted');
      } finally {
        await host.close();
      }
    });

    it('reads a reply without the field as nothing left out', async () => {
      const serverName = 'no-omitted-field';
      const entry = createPersistentEntry(serverName, 5);
      const record = createRecord(serverName, 5, computeRuntimeFingerprint(entry));
      await ensureRuntimeDir();
      const { writeRuntimeRecord } = await import('./runtime-store.js');
      await writeRuntimeRecord(record);
      const host = createServer((socket) => {
        socket.on('data', (chunk) => {
          const request = JSON.parse(chunk.toString().trim()) as { requestId: string; type: string };
          const response = request.type === 'status'
            ? { requestId: request.requestId, ok: true, type: 'status', status: { ...record, running: true, configStatus: 'current' } }
            : { requestId: request.requestId, ok: true, type: 'call', results: ['x'], values: ['x'], isError: false };
          socket.end(`${JSON.stringify(response)}\n`);
        });
      });
      await new Promise<void>((resolve) => host.listen(record.socketPath, resolve));

      try {
        expect(await callPersistentRuntime(serverName, entry, [{ toolName: 'a', params: {} }])).toEqual([
          { text: 'x', value: 'x', isError: false },
        ]);
      } finally {
        await new Promise<void>((resolve) => host.close(() => resolve()));
      }
    });
  });

  describe('MCP server process exit', () => {
    it('closes the host, removes its socket and reports not running', async () => {
      const serverName = 'dying';
      const record = createRecord(serverName, 5);
      const session = createSession();
      const host = await startHost(record, session);
      expect(existsSync(record.socketPath)).toBe(true);

      (session.client as { onclose?: () => void }).onclose?.();
      await host.waitUntilClosed();

      expect(host.getStatus().running).toBe(false);
      expect(existsSync(record.socketPath)).toBe(false);
      expect(await getRuntimeStatus(serverName)).toBeUndefined();
      expect(session.close).toHaveBeenCalledTimes(1);
      expect(await readFile(record.logPath, 'utf-8')).toContain('MCP server process exited');
    });

    it('does not mistake its own shutdown for a server exit', async () => {
      const serverName = 'closing-itself';
      const record = createRecord(serverName, 5);
      const session = createSession();
      // A real transport reports onclose as part of being closed.
      vi.mocked(session.close).mockImplementation(async () => {
        (session.client as { onclose?: () => void }).onclose?.();
      });
      const host = await startHost(record, session);

      await host.close();
      await host.waitUntilClosed();

      expect(session.close).toHaveBeenCalledTimes(1);
      expect(await readFile(record.logPath, 'utf-8')).not.toContain('MCP server process exited');
    });

    it('fails calls that were still queued when the server exited, without calling the dead session', async () => {
      const serverName = 'dying-with-queue';
      const entry = createPersistentEntry(serverName, 5);
      const record = createRecord(serverName, 5, computeRuntimeFingerprint(entry));
      let rejectInFlight: (error: Error) => void = () => {};
      const session = createSession({
        callTool: vi.fn(() => new Promise<ToolCallOutput>((_resolve, reject) => {
          rejectInFlight = reject;
        })),
      });
      const host = await startHost(record, session);

      const calls = ['first', 'second'].map((toolName) => (
        callPersistentRuntime(serverName, entry, [{ toolName, params: {} }]).then(() => 'resolved', (error: Error) => error.message)
      ));
      // Both requests have to be in the host (one running, one queued) before its server exits. Which of
      // the two callers gets there first is up to the scheduler, so the test does not depend on it.
      const connections = () => new Promise<number>((resolve) => {
        (host as unknown as { server: Server }).server.getConnections((_error, count) => resolve(count));
      });
      while (vi.mocked(session.callTool).mock.calls.length === 0 || await connections() < 2) await wait(10);
      await wait(20);

      (session.client as { onclose?: () => void }).onclose?.();
      rejectInFlight(new Error('Connection closed'));
      await host.waitUntilClosed();

      const outcomes = await Promise.all(calls);
      expect(outcomes.filter((outcome) => outcome === 'Connection closed')).toHaveLength(1);
      expect(outcomes.filter((outcome) => /has stopped/.test(outcome))).toHaveLength(1);
      expect(session.callTool).toHaveBeenCalledTimes(1);
    });
  });

  describe('taking the socket', () => {
    const hosts: RuntimeHost[] = [];
    afterEach(async () => {
      await Promise.all(hosts.splice(0).map((host) => host.close()));
    });

    async function newHost(record: RuntimeRecord, session = createSession()): Promise<RuntimeHost> {
      await ensureRuntimeDir();
      const host = new RuntimeHost({ record, session, logStream: createWriteStream(record.logPath, { flags: 'a' }) });
      hosts.push(host);
      return host;
    }

    it('refuses to take over a socket that a live host answers on, and leaves that host and its files alone', async () => {
      const entry = createPersistentEntry('contested', 5);
      const record = createRecord('contested', 5, computeRuntimeFingerprint(entry));
      const first = await newHost(record);
      await first.start();
      const recordBefore = await readFile(getRuntimeMetadataPath('contested'), 'utf-8');
      const secondSession = createSession();
      const second = await newHost({ ...record, startedAt: 'later' }, secondSession);

      await expect(second.start()).rejects.toBeInstanceOf(RuntimeAlreadyRunningError);

      expect(await readFile(getRuntimeMetadataPath('contested'), 'utf-8')).toBe(recordBefore);
      expect(existsSync(record.socketPath)).toBe(true);
      expect((await getRuntimeStatus('contested', entry))?.running).toBe(true);
      expect(first.getStatus().running).toBe(true);
    });

    it('replaces a socket file that nothing listens on (a dead host left it)', async () => {
      await ensureRuntimeDir();
      const record = createRecord('leftover', 5);
      await writeFile(record.socketPath, '');
      const host = await newHost(record);

      await host.start();

      expect((await getRuntimeStatus('leftover'))?.running).toBe(true);
    });

    it('leaves the start lock to its holder when it starts and when it closes', async () => {
      const record = createRecord('locking', 5);
      const host = await newHost(record);

      await withRuntimeStartLock('locking', async () => {
        await host.start();
        expect(existsSync(getRuntimeLockPath('locking'))).toBe(true);
        await host.close();
        expect(existsSync(getRuntimeLockPath('locking'))).toBe(true);
      });
    });

    it('lets the socket be used by its owner only', async () => {
      const record = createRecord('private-socket', 5);
      const host = await newHost(record);

      await host.start();

      expect((await stat(record.socketPath)).mode & 0o777).toBe(0o600);
    });

    it('tightens a log that an older release created readable by others', async () => {
      const record = createRecord('old-log', 5);
      await ensureRuntimeDir();
      await writeFile(record.logPath, 'older run\n');
      await chmod(record.logPath, 0o644);
      const host = await newHost(record);

      await host.start();

      expect((await stat(record.logPath)).mode & 0o777).toBe(0o600);
    });

    it('removes only its own files when it closes', async () => {
      const record = createRecord('mine', 5);
      const host = await newHost(record);
      await host.start();
      // Another daemon took over the record meanwhile.
      await writeFile(getRuntimeMetadataPath('mine'), JSON.stringify({ ...record, pid: process.pid + 1 }));

      await host.close();

      expect(JSON.parse(await readFile(getRuntimeMetadataPath('mine'), 'utf-8')).pid).toBe(process.pid + 1);
    });
  });

  describe('starting a host', () => {
    const children: ChildProcess[] = [];

    afterEach(() => {
      for (const child of children.splice(0)) child.kill('SIGKILL');
      vi.doUnmock('./client.js');
      vi.doUnmock('./config.js');
      vi.resetModules();
    });

    async function hostFor(entry: ServerEntry, session: ConnectedToolSession) {
      const connectToolSession = vi.fn(async () => session);
      vi.resetModules();
      vi.doMock('./client.js', () => ({ connectToolSession }));
      vi.doMock('./config.js', () => ({ getServer: vi.fn(async () => entry) }));
      const { createRuntimeHostForServer } = await import('./runtime-host.js');
      const claim = await import('./runtime-claim.js');
      return { createRuntimeHostForServer, connectToolSession, claim };
    }

    it('starts no MCP server when another live host owns the runtime, and touches none of its files', async () => {
      const entry = createPersistentEntry('owned', 5);
      const owner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      children.push(owner);
      await ensureRuntimeDir();
      const claimText = JSON.stringify({ pid: owner.pid, startedAt: new Date().toISOString() });
      await writeFile(getRuntimeClaimPath('owned'), claimText);
      const session = createSession();
      const { createRuntimeHostForServer, connectToolSession, claim } = await hostFor(entry, session);

      const failure = await createRuntimeHostForServer('owned').catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(claim.RuntimeAlreadyRunningError);
      expect(connectToolSession).not.toHaveBeenCalled();
      expect(await readFile(getRuntimeClaimPath('owned'), 'utf-8')).toBe(claimText);
    });

    it('takes the claim before it connects to the MCP server, so a stop can find it while the server starts', async () => {
      const entry = createPersistentEntry('claims-first', 5);
      const session = createSession();
      const { createRuntimeHostForServer, connectToolSession } = await hostFor(entry, session);
      let claimedWhenConnecting: unknown;
      connectToolSession.mockImplementation(async () => {
        claimedWhenConnecting = await readRuntimeClaim('claims-first');
        return session;
      });

      const host = await createRuntimeHostForServer('claims-first');

      expect(claimedWhenConnecting).toEqual({ pid: process.pid, startedAt: expect.any(String) });
      await host.close();
      expect(existsSync(getRuntimeClaimPath('claims-first'))).toBe(false);
    });

    it('gives back the claim and closes the MCP server it started when it cannot take the socket', async () => {
      const entry = createPersistentEntry('lost-socket', 5);
      const session = createSession();
      const { createRuntimeHostForServer, claim } = await hostFor(entry, session);
      // A host from before claims existed: it holds the socket and has no claim file.
      await ensureRuntimeDir();
      const legacy = createServer();
      await new Promise<void>((resolve) => legacy.listen(getRuntimeSocketPath('lost-socket'), resolve));

      try {
        await expect(createRuntimeHostForServer('lost-socket')).rejects.toBeInstanceOf(claim.RuntimeAlreadyRunningError);

        expect(session.close).toHaveBeenCalledTimes(1);
        expect(existsSync(getRuntimeClaimPath('lost-socket'))).toBe(false);
        // The legacy host's socket is still there for it to use.
        expect(existsSync(getRuntimeSocketPath('lost-socket'))).toBe(true);
      } finally {
        await new Promise((resolve) => legacy.close(resolve));
      }
    });

    it('takes over the claim of a host that died', async () => {
      const entry = createPersistentEntry('replaces-dead', 5);
      await ensureRuntimeDir();
      await writeFile(getRuntimeClaimPath('replaces-dead'), JSON.stringify({
        pid: spawnSync(process.execPath, ['-e', '']).pid,
        startedAt: new Date().toISOString(),
      }));
      const { createRuntimeHostForServer } = await hostFor(entry, createSession());

      const host = await createRuntimeHostForServer('replaces-dead');

      expect((await readRuntimeClaim('replaces-dead'))?.pid).toBe(process.pid);
      await host.close();
    });
  });

  describe('call timeout', () => {
    afterEach(() => {
      vi.doUnmock('./client.js');
      vi.doUnmock('./config.js');
      vi.resetModules();
    });

    it.each([
      [{ mode: 'persistent', callTimeoutSec: 90 }, 90_000],
      [{ mode: 'persistent' }, 30 * 60 * 1000],
    ])('connects the MCP session with the runtime call timeout (%j)', async (runtime, expectedMs) => {
      const entry = { ...createPersistentEntry('timeouts', 5), runtime } as ServerEntry;
      const session = createSession();
      const connectToolSession = vi.fn(async () => session);
      vi.resetModules();
      vi.doMock('./client.js', () => ({ connectToolSession }));
      vi.doMock('./config.js', () => ({ getServer: vi.fn(async () => entry) }));

      const { createRuntimeHostForServer } = await import('./runtime-host.js');
      const host = await createRuntimeHostForServer('timeouts');

      try {
        expect(connectToolSession).toHaveBeenCalledWith(
          entry.transport,
          undefined,
          undefined,
          undefined,
          { timeoutMs: expectedMs },
        );
      } finally {
        await host.close();
      }
    });
  });
});

function createSession(overrides: Partial<ConnectedToolSession> = {}): ConnectedToolSession {
  return {
    client: {} as ConnectedToolSession['client'],
    transport: {} as ConnectedToolSession['transport'],
    close: vi.fn(async () => {}),
    callTool: vi.fn(async () => output('ok')),
    callToolsChained: vi.fn(async () => [output('ok')]),
    ...overrides,
  };
}

async function startHost(record: RuntimeRecord, session: ConnectedToolSession): Promise<RuntimeHost> {
  await ensureRuntimeDir();
  const host = new RuntimeHost({
    record,
    session,
    logStream: createWriteStream(record.logPath, { flags: 'a' }),
  });
  await host.start();
  return host;
}
