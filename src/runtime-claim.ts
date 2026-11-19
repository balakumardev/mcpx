import { readFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { createFileExclusive, removeStaleFile } from './runtime-lock.js';
import {
  ensureRuntimeDir,
  getRuntimeClaimPath,
  getRuntimeSocketPath,
  isProcessRunning,
  readRuntimeClaim,
  readRuntimeRecord,
  type RuntimeClaim,
} from './runtime-store.js';

// How long a host may take from being spawned to listening on its socket (it starts the MCP server
// first). A host that holds the claim for longer without answering on the socket is hung, or the
// claim outlived it and its pid belongs to some other process by now.
export const RUNTIME_STARTUP_GRACE_MS = 60_000;

/** Thrown by a host that finds the runtime of its server already owned by another live host. */
export class RuntimeAlreadyRunningError extends Error {
  constructor(serverName: string, readonly ownerPid?: number) {
    super(
      `The runtime for "${serverName}" is already running${ownerPid === undefined ? '' : ` (pid ${ownerPid})`}.`,
    );
    this.name = 'RuntimeAlreadyRunningError';
  }
}

/** Whether something accepts connections on the runtime socket. Connecting is enough: no request is sent. */
export async function socketAnswers(socketPath: string, timeoutMs = 1_000): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = connect(socketPath);
    const finish = (answered: boolean) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(answered);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

function claimAgeMs(claim: RuntimeClaim): number {
  const startedAt = Date.parse(claim.startedAt);
  return Number.isNaN(startedAt) ? Infinity : Date.now() - startedAt;
}

async function claimIsLive(claim: RuntimeClaim, serverName: string): Promise<boolean> {
  // A process hosts one runtime, so a claim that carries this very pid is left over from a host that
  // had it before (or from a test that runs a host in-process).
  if (claim.pid === process.pid || !isProcessRunning(claim.pid)) return false;
  if (claimAgeMs(claim) < RUNTIME_STARTUP_GRACE_MS) return true;
  return await socketAnswers(getRuntimeSocketPath(serverName));
}

/**
 * Whether a host was spawned and has not come up yet: it holds the claim, is alive, is still inside
 * its start-up allowance and has not written its record. Callers wait for such a host instead of
 * spawning a second one or stopping this one.
 */
export async function isRuntimeStarting(serverName: string): Promise<boolean> {
  if (await readRuntimeRecord(serverName)) return false;
  const claim = await readRuntimeClaim(serverName);
  return claim !== undefined
    && claim.pid !== process.pid
    && isProcessRunning(claim.pid)
    && claimAgeMs(claim) < RUNTIME_STARTUP_GRACE_MS;
}

/**
 * Take ownership of the runtime of `serverName` for this process, before it starts the MCP server.
 * The claim file is created atomically and complete, so exactly one of any number of hosts started
 * at the same time gets it; every other one throws RuntimeAlreadyRunningError and must exit without
 * starting a server or touching a file. A claim whose owner is gone is replaced.
 */
export async function claimRuntime(serverName: string): Promise<void> {
  await ensureRuntimeDir();
  const claimPath = getRuntimeClaimPath(serverName);
  const content = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() } satisfies RuntimeClaim);

  for (let attempt = 0; attempt < 5; attempt++) {
    if (await createFileExclusive(claimPath, content)) return;

    const held = await readFile(claimPath, 'utf-8').catch(() => undefined);
    if (held === undefined) continue;
    const owner = await readRuntimeClaim(serverName);
    if (owner && await claimIsLive(owner, serverName)) {
      throw new RuntimeAlreadyRunningError(serverName, owner.pid);
    }
    await removeStaleFile(claimPath, held);
  }
  throw new Error(`Could not claim the runtime for "${serverName}": its claim file keeps changing.`);
}
