import { spawn } from 'node:child_process';
import { open, rm, stat } from 'node:fs/promises';
import { connect } from 'node:net';
import { getServer } from './config.js';
import { isPersistentRuntimeEntry } from './runtime-config.js';
import type { RuntimeRequest, RuntimeResponse, RuntimeStatus } from './runtime-protocol.js';
import {
  computeRuntimeFingerprint,
  deleteRuntimeArtifacts,
  ensureRuntimeDir,
  getRuntimeLogPath,
  getRuntimeLockPath,
  isProcessRunning,
  listRuntimeRecords,
  readRuntimeRecord,
  type RuntimeRecord,
} from './runtime-store.js';
import type { ToolCall } from './client.js';
import type { ServerEntry } from './types.js';

const RUNTIME_REQUEST_TIMEOUT_MS = 5_000;
const RUNTIME_START_TIMEOUT_MS = 10_000;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function requestId(): string {
  return `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessRunning(pid)) return true;
    await wait(100);
  }
  return !isProcessRunning(pid);
}

async function waitForRuntimeShutdown(serverName: string, pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const record = await readRuntimeRecord(serverName);
    if (!record) return true;
    if (!isProcessRunning(pid)) return true;
    await wait(100);
  }

  const record = await readRuntimeRecord(serverName);
  return !record || !isProcessRunning(pid);
}

async function withRuntimeStartLock<T>(
  serverName: string,
  task: () => Promise<T>,
): Promise<T> {
  await ensureRuntimeDir();
  const lockPath = getRuntimeLockPath(serverName);
  const deadline = Date.now() + RUNTIME_START_TIMEOUT_MS;

  while (true) {
    try {
      const handle = await open(lockPath, 'wx');
      try {
        return await task();
      } finally {
        await handle.close();
        await rm(lockPath, { force: true });
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw error;
      try {
        const lockStat = await stat(lockPath);
        if (Date.now() - lockStat.mtimeMs > RUNTIME_START_TIMEOUT_MS) {
          await rm(lockPath, { force: true });
          continue;
        }
      } catch {
        // Ignore races where the lock disappeared while we were checking it.
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for runtime startup lock for "${serverName}".`);
      }
      await wait(100);
    }
  }
}

function configStatus(
  fingerprint: string,
  entry?: Pick<ServerEntry, 'transport' | 'paramProvider' | 'runtime'>,
): 'current' | 'stale' {
  if (!entry) return 'current';
  return computeRuntimeFingerprint(entry) === fingerprint ? 'current' : 'stale';
}

export async function sendRuntimeRequest(
  socketPath: string,
  request: RuntimeRequest,
  timeoutMs = RUNTIME_REQUEST_TIMEOUT_MS,
): Promise<RuntimeResponse> {
  return await new Promise<RuntimeResponse>((resolve, reject) => {
    const socket = connect(socketPath);
    let buffer = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('Timed out waiting for runtime response.'));
    }, timeoutMs);
    timer.unref?.();

    const cleanup = () => {
      clearTimeout(timer);
      socket.removeAllListeners();
    };

    socket.once('connect', () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });

    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex === -1) return;

      const line = buffer.slice(0, newlineIndex).trim();
      cleanup();
      socket.end();

      try {
        resolve(JSON.parse(line) as RuntimeResponse);
      } catch {
        reject(new Error('Runtime returned invalid JSON.'));
      }
    });

    socket.once('error', (error) => {
      cleanup();
      reject(error);
    });
  });
}

async function fetchRuntimeStatus(
  record: RuntimeRecord,
  entry?: Pick<ServerEntry, 'transport' | 'paramProvider' | 'runtime'>,
): Promise<RuntimeStatus | undefined> {
  try {
    const response = await sendRuntimeRequest(record.socketPath, {
      requestId: requestId(),
      type: 'status',
    });
    if (!response.ok || response.type !== 'status') {
      throw new Error(response.ok ? 'Unexpected runtime status response.' : response.error);
    }
    return {
      ...response.status,
      configStatus: configStatus(response.status.fingerprint, entry),
    };
  } catch {
    if (!isProcessRunning(record.pid)) {
      await deleteRuntimeArtifacts(record.serverName);
      return undefined;
    }
    return {
      ...record,
      running: false,
      configStatus: configStatus(record.fingerprint, entry),
    };
  }
}

export async function getRuntimeStatus(
  serverName: string,
  entry?: Pick<ServerEntry, 'transport' | 'paramProvider' | 'runtime'>,
): Promise<RuntimeStatus | undefined> {
  const record = await readRuntimeRecord(serverName);
  if (!record) return undefined;
  return await fetchRuntimeStatus(record, entry);
}

export async function listPersistentRuntimeStatuses(): Promise<RuntimeStatus[]> {
  const records = await listRuntimeRecords();
  const statuses = await Promise.all(records.map(async (record) => {
    const entry = await getServer(record.serverName);
    return await fetchRuntimeStatus(record, entry);
  }));
  return statuses.filter((status): status is RuntimeStatus => status !== undefined);
}

export async function stopRuntime(
  serverName: string,
  options: { removeLog?: boolean } = {},
): Promise<boolean> {
  const record = await readRuntimeRecord(serverName);
  if (!record) return false;

  try {
    await sendRuntimeRequest(record.socketPath, {
      requestId: requestId(),
      type: 'stop',
    }, 2_000);
  } catch {
    // Fall back to process signals below.
  }

  let stopped = await waitForRuntimeShutdown(serverName, record.pid, 3_000);
  if (!stopped) {
    try {
      process.kill(record.pid, 'SIGTERM');
    } catch {
      // Process may already be gone.
    }
    stopped = await waitForRuntimeShutdown(serverName, record.pid, 2_000);
  }
  if (!stopped) {
    try {
      process.kill(record.pid, 'SIGKILL');
    } catch {
      // Process may already be gone.
    }
    await waitForRuntimeShutdown(serverName, record.pid, 1_000);
  }

  await deleteRuntimeArtifacts(serverName, options);
  return true;
}

export async function spawnRuntimeHostProcess(serverName: string): Promise<number | undefined> {
  if (!process.argv[1]) {
    throw new Error('Unable to determine CLI entrypoint for runtime host startup.');
  }

  await ensureRuntimeDir();
  const logHandle = await open(getRuntimeLogPath(serverName), 'a');

  try {
    const child = await new Promise<ReturnType<typeof spawn>>((resolve, reject) => {
      const spawned = spawn(
        process.execPath,
        [...process.execArgv, process.argv[1], 'runtime', '_host', serverName],
        {
          detached: true,
          stdio: ['ignore', logHandle.fd, logHandle.fd],
          env: process.env,
        },
      );
      spawned.once('error', reject);
      spawned.once('spawn', () => resolve(spawned));
    });

    child.unref();
    return child.pid ?? undefined;
  } finally {
    await logHandle.close();
  }
}

export async function ensurePersistentRuntime(
  serverName: string,
  entry: ServerEntry,
): Promise<RuntimeStatus> {
  if (!isPersistentRuntimeEntry(entry)) {
    throw new Error(`Server "${serverName}" is not configured for a persistent stdio runtime.`);
  }

  const fingerprint = computeRuntimeFingerprint(entry);
  const existing = await readRuntimeRecord(serverName);
  if (existing) {
    const status = await fetchRuntimeStatus(existing, entry);
    if (status && status.fingerprint === fingerprint && status.running) {
      return status;
    }
  }

  return await withRuntimeStartLock(serverName, async () => {
    const current = await readRuntimeRecord(serverName);
    if (current) {
      const status = await fetchRuntimeStatus(current, entry);
      if (status && status.fingerprint === fingerprint && status.running) {
        return status;
      }
      await stopRuntime(serverName);
    }

    await spawnRuntimeHostProcess(serverName);

    const deadline = Date.now() + RUNTIME_START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const status = await getRuntimeStatus(serverName, entry);
      if (status && status.fingerprint === fingerprint && status.running) {
        return status;
      }
      await wait(100);
    }

    throw new Error(`Persistent runtime for "${serverName}" failed to start. Check ${getRuntimeLogPath(serverName)} for details.`);
  });
}

export async function callPersistentRuntime(
  serverName: string,
  entry: ServerEntry,
  calls: ToolCall[],
): Promise<string[]> {
  const status = await ensurePersistentRuntime(serverName, entry);
  const response = await sendRuntimeRequest(status.socketPath, {
    requestId: requestId(),
    type: 'call',
    calls,
  });

  if (!response.ok) {
    throw new Error(response.error);
  }
  if (response.type !== 'call') {
    throw new Error('Unexpected runtime response type.');
  }

  return response.results;
}
