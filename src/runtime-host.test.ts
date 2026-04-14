import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConnectedToolSession } from './client.js';
import { RuntimeHost } from './runtime-host.js';
import { callPersistentRuntime, getRuntimeStatus, stopRuntime } from './runtime-manager.js';
import {
  computeRuntimeFingerprint,
  ensureRuntimeDir,
  getRuntimeLogPath,
  getRuntimeSocketPath,
  type RuntimeRecord,
} from './runtime-store.js';
import type { ServerEntry } from './types.js';

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
        return JSON.stringify({ id });
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

  it('stops an active runtime and cleans up metadata', async () => {
    const serverName = 'browsermcp';
    const record = createRecord(serverName, 5);
    const session: ConnectedToolSession = {
      client: {} as ConnectedToolSession['client'],
      transport: {} as ConnectedToolSession['transport'],
      close: vi.fn(async () => {}),
      callTool: vi.fn(async () => 'ok'),
      callToolsChained: vi.fn(async () => ['ok']),
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
      callTool: vi.fn(async () => 'ok'),
      callToolsChained: vi.fn(async () => ['ok']),
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
});
