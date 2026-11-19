import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { getServer } from './config.js';
import { isValidServerName } from './server-name.js';
import { isRuntimeStarting } from './runtime-claim.js';
import { isPersistentRuntimeEntry } from './runtime-config.js';
import { withRuntimeStartLock } from './runtime-lock.js';
import { isRuntimeHostProcess, signalRuntimeHost } from './runtime-process.js';
import type { RuntimeRequest, RuntimeResponse, RuntimeStatus } from './runtime-protocol.js';
import {
  computeRuntimeFingerprint,
  deleteRuntimeArtifacts,
  getRuntimeLogPath,
  getRuntimeSocketPath,
  isProcessRunning,
  listRuntimeRecords,
  openRuntimeLog,
  readRuntimeClaim,
  readRuntimeRecord,
  type RuntimeRecord,
} from './runtime-store.js';
import type { ToolCall, ToolCallOutput } from './client.js';
import type { ServerEntry } from './types.js';
import { resolveRuntimeConfig } from './runtime-config.js';

const RUNTIME_STATUS_TIMEOUT_MS = 5_000;
const RUNTIME_START_TIMEOUT_MS = 10_000;
const RUNTIME_POLL_MS = 50;
// The host enforces the configured call timeout itself and answers with that error. The
// socket wait must outlast it, or the two timers race and the real error is lost.
const RUNTIME_CALL_GRACE_MS = 5_000;

// The timer must keep the process alive: callers await it while polling for a runtime that is
// starting, and with nothing else pending an unref'd timer lets the CLI exit 0 in the middle of a call.
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requestId(): string {
  return `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function configStatus(
  fingerprint: string,
  entry?: Pick<ServerEntry, 'transport' | 'paramProvider' | 'runtime'>,
): 'current' | 'stale' {
  if (!entry) return 'current';
  return computeRuntimeFingerprint(entry) === fingerprint ? 'current' : 'stale';
}

/** The runtime accepted the connection and did not answer in time: it is busy, not absent. */
export class RuntimeRequestTimeoutError extends Error {
  constructor() {
    super('Timed out waiting for runtime response.');
    this.name = 'RuntimeRequestTimeoutError';
  }
}

export async function sendRuntimeRequest(
  socketPath: string,
  request: RuntimeRequest,
  timeoutMs = RUNTIME_STATUS_TIMEOUT_MS,
): Promise<RuntimeResponse> {
  return await new Promise<RuntimeResponse>((resolve, reject) => {
    const socket = connect(socketPath);
    let buffer = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new RuntimeRequestTimeoutError());
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
      await deleteRuntimeArtifacts(record.serverName, { pids: [record.pid] });
      return undefined;
    }
    return {
      ...record,
      running: false,
      configStatus: configStatus(record.fingerprint, entry),
    };
  }
}

/**
 * The status, plus the pids of any further live daemon recorded for the same server (there should be
 * none). `registered` says whether a server of this name is in the registry: a runtime with none
 * (the server was removed, renamed, or its record carries a name that cannot be one) is an orphan.
 */
async function describeRuntime(
  record: RuntimeRecord,
  entry: Pick<ServerEntry, 'transport' | 'paramProvider' | 'runtime'> | undefined,
  registered: boolean,
): Promise<RuntimeStatus | undefined> {
  const fetched = await fetchRuntimeStatus(record, entry);
  if (!fetched) return undefined;
  const status: RuntimeStatus = registered ? fetched : { ...fetched, orphaned: true };
  const claim = await readRuntimeClaim(record.serverName);
  if (claim && claim.pid !== status.pid && claim.pid !== process.pid && isProcessRunning(claim.pid)) {
    return { ...status, otherPids: [claim.pid] };
  }
  return status;
}

export async function getRuntimeStatus(
  serverName: string,
  entry?: Pick<ServerEntry, 'transport' | 'paramProvider' | 'runtime'>,
): Promise<RuntimeStatus | undefined> {
  const record = await readRuntimeRecord(serverName);
  if (!record) return undefined;
  // The caller says which entry the status is judged against; whether one is registered is its business.
  return await describeRuntime(record, entry, true);
}

export async function listPersistentRuntimeStatuses(): Promise<RuntimeStatus[]> {
  const records = await listRuntimeRecords();
  const statuses = await Promise.all(records.map(async (record) => {
    // The name in a record is only what some host wrote: one that is not a valid server name (an
    // older release accepted any) is looked up nowhere, and its runtime is listed as an orphan.
    const entry = isValidServerName(record.serverName) ? await getServer(record.serverName) : undefined;
    return await describeRuntime(record, entry, entry !== undefined);
  }));
  return statuses.filter((status): status is RuntimeStatus => status !== undefined);
}

export interface RuntimeStopResult {
  /** Something was recorded for the server (a record, a claim, or both). */
  found: boolean;
  /** Pids of the live daemons that were stopped. More than one means the server had run twice. */
  daemons: number[];
  /** The subset that ignored the stop request and the SIGTERM and had to be killed, with their process group. */
  killed: number[];
}

/** The pids in `pids` that are still running. A host in this very process (tests) is running until its files are gone. */
async function stillRunning(serverName: string, pids: readonly number[]): Promise<number[]> {
  const [record, claim] = await Promise.all([readRuntimeRecord(serverName), readRuntimeClaim(serverName)]);
  return pids.filter((pid) => (
    pid === process.pid ? record?.pid === pid || claim?.pid === pid : isProcessRunning(pid)
  ));
}

async function waitForExit(serverName: string, pids: readonly number[], timeoutMs: number): Promise<number[]> {
  const deadline = Date.now() + timeoutMs;
  let running = await stillRunning(serverName, pids);
  while (running.length > 0 && Date.now() < deadline) {
    await wait(100);
    running = await stillRunning(serverName, pids);
  }
  return running;
}

/**
 * Stop every daemon recorded for the server: the one in the record and the one in the claim file,
 * which are the same unless the server was started twice. Each is asked to stop over its socket,
 * then sent SIGTERM, then killed together with its process group, and the files they leave behind
 * are removed. A pid that is no longer a runtime host (a dead host's pid, reused) is never signalled.
 */
export async function stopRuntimeDaemons(
  serverName: string,
  options: { removeLog?: boolean } = {},
): Promise<RuntimeStopResult> {
  const [record, claim] = await Promise.all([readRuntimeRecord(serverName), readRuntimeClaim(serverName)]);
  if (!record && !claim) return { found: false, daemons: [], killed: [] };

  const recorded = [...new Set([record?.pid, claim?.pid].filter((pid): pid is number => pid !== undefined))];
  const daemons = recorded.filter((pid) => isProcessRunning(pid));
  let remaining = daemons;
  const killed: number[] = [];

  let answered = false;
  if (remaining.length > 0) {
    try {
      await sendRuntimeRequest(record?.socketPath ?? getRuntimeSocketPath(serverName), {
        requestId: requestId(),
        type: 'stop',
      }, 2_000);
      answered = true;
    } catch (error) {
      // A daemon in the middle of a call has not answered yet: the stop waits behind that call in its
      // queue. Only one that is not listening at all (it is still starting, or hung) is signalled at once.
      answered = error instanceof RuntimeRequestTimeoutError;
    }
  }
  // A daemon that has taken the request needs a moment to finish what it is doing; one that could
  // not be asked has nothing to wait for.
  if (answered) remaining = await waitForExit(serverName, remaining, 3_000);

  // Only a process that is a runtime host of this server is ever signalled: a pid in a record can
  // have been given to something else since. Whatever is not one is not waited for either.
  const hostsAmong = async (pids: readonly number[]): Promise<number[]> => {
    const hosts: number[] = [];
    for (const pid of pids) {
      if (await isRuntimeHostProcess(pid, serverName)) hosts.push(pid);
    }
    return hosts;
  };

  if (remaining.length > 0) {
    remaining = await hostsAmong(remaining);
    for (const pid of remaining) signalRuntimeHost(pid, 'SIGTERM');
    remaining = await waitForExit(serverName, remaining, 2_000);
  }
  if (remaining.length > 0) {
    for (const pid of remaining) {
      signalRuntimeHost(pid, 'SIGKILL', true);
      killed.push(pid);
    }
    await waitForExit(serverName, remaining, 1_000);
  }

  await deleteRuntimeArtifacts(serverName, { pids: recorded, ...options });
  return { found: true, daemons, killed };
}

export async function stopRuntime(
  serverName: string,
  options: { removeLog?: boolean } = {},
): Promise<boolean> {
  return (await stopRuntimeDaemons(serverName, options)).found;
}

export async function spawnRuntimeHostProcess(serverName: string): Promise<number | undefined> {
  if (!process.argv[1]) {
    throw new Error('Unable to determine CLI entrypoint for runtime host startup.');
  }

  const logHandle = await openRuntimeLog(serverName);

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
  // The runtime that can take the call now, if there is one.
  const usable = async (): Promise<RuntimeStatus | undefined> => {
    const record = await readRuntimeRecord(serverName);
    if (!record) return undefined;
    const status = await fetchRuntimeStatus(record, entry);
    return status && status.fingerprint === fingerprint && status.running ? status : undefined;
  };

  const warm = await usable();
  if (warm) return warm;

  // Exactly one caller starts the runtime; the others wait here and take the one that comes up.
  // (A second host would exit on its own anyway, see claimRuntime: the lock only saves the spawning.)
  return await withRuntimeStartLock(serverName, async () => {
    const started = await usable();
    if (started) return started;

    // Whatever is recorded and cannot take the call (a stale configuration, a hung or dying host, a
    // dead one's files) is replaced, unless it is a host that is still starting up: wait for that one.
    if (!(await isRuntimeStarting(serverName))) {
      await stopRuntime(serverName);
      await spawnRuntimeHostProcess(serverName);
    }

    const deadline = Date.now() + RUNTIME_START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const status = await usable();
      if (status) return status;
      await wait(RUNTIME_POLL_MS);
    }

    throw new Error(`Persistent runtime for "${serverName}" failed to start. Check ${getRuntimeLogPath(serverName)} for details.`);
  }, { whileWaiting: usable });
}

export async function callPersistentRuntime(
  serverName: string,
  entry: ServerEntry,
  calls: ToolCall[],
): Promise<ToolCallOutput[]> {
  const status = await ensurePersistentRuntime(serverName, entry);
  const runtime = resolveRuntimeConfig(entry.runtime);
  const response = await sendRuntimeRequest(status.socketPath, {
    requestId: requestId(),
    type: 'call',
    calls,
  }, runtime.callTimeoutSec * 1000 + RUNTIME_CALL_GRACE_MS);

  if (!response.ok) {
    throw new Error(response.error);
  }
  if (response.type !== 'call') {
    throw new Error('Unexpected runtime response type.');
  }

  const { results, values, isError, omitted } = response;
  // A host of an older protocol never gets here: its fingerprint differs, so ensurePersistentRuntime
  // replaced it before the call was sent. A reply that still cannot say whether the tool failed
  // must not be read as a success.
  if (!Array.isArray(values) || typeof isError !== 'boolean') {
    throw new Error(
      `The runtime for "${serverName}" replied in a format this mcpkit does not understand, so the outcome of the call is unknown. `
      + `Run \`mcpkit runtime stop ${serverName}\`, then check whether the call took effect before repeating it.`,
    );
  }
  return results.map((text, index) => ({
    text,
    value: values[index],
    isError: isError && index === results.length - 1,
    ...(omitted?.[index]?.length ? { omitted: omitted[index] } : {}),
  }));
}
