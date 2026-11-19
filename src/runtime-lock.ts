import { randomBytes } from 'node:crypto';
import { link, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { ensureRuntimeDir, getRuntimeLockPath, isProcessRunning } from './runtime-store.js';

// A holder keeps the lock for one start attempt: up to RUNTIME_START_TIMEOUT_MS of waiting for the
// host (runtime-manager.ts) plus the time to stop what was there before (about 8 s). The age limit
// has to outlast that so a live holder is never broken; a holder that died is broken at once by
// its pid, whatever the age, so only a pid that was reused or a holder that hangs depends on it.
const START_LOCK_STALE_MS = 30_000;
// Longer than the age limit, so a caller that waits behind a lock that cannot be recovered by
// its pid still outlasts it and takes the lock over instead of giving up first.
const START_LOCK_TIMEOUT_MS = 60_000;
const START_LOCK_RETRY_MS = 50;
// A lock left by mcpkit v0.1.29 is an empty file with no owner in it: judge it by its age.
const OWNERLESS_LOCK_STALE_MS = 10_000;

const LINK_UNSUPPORTED = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV']);

function hasCode(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException).code === code;
}

function sleep(ms: number): Promise<void> {
  // Not unref'd: callers await this while the process has nothing else to keep it alive.
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Create `path` with `content` if nothing is there yet; false when it already exists. The file
 * appears with its content complete: it is written to a temporary name and hard-linked into place,
 * and `link` fails with EEXIST when the target exists, so of any number of racing callers exactly
 * one wins and none ever reads an empty file. A file system without hard links falls back to an
 * exclusive create, where the content shows up a moment after the file does.
 */
export async function createFileExclusive(path: string, content: string): Promise<boolean> {
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
  try {
    await link(temporary, path);
    return true;
  } catch (error) {
    if (hasCode(error, 'EEXIST')) return false;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === undefined || !LINK_UNSUPPORTED.has(code)) throw error;
    try {
      await writeFile(path, content, { flag: 'wx', mode: 0o600 });
      return true;
    } catch (exclusiveError) {
      if (hasCode(exclusiveError, 'EEXIST')) return false;
      throw exclusiveError;
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

/**
 * Remove `path` if it still holds `staleContent`, the content its caller judged to be a dead
 * owner's. The file is renamed away first (only one of several callers wins that) and checked
 * there, so a live owner's fresh file that replaced the stale one in the meantime is put back
 * instead of deleted.
 */
export async function removeStaleFile(path: string, staleContent: string): Promise<void> {
  const aside = `${path}.stale.${process.pid}.${randomBytes(4).toString('hex')}`;
  try {
    await rename(path, aside);
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return;
    throw error;
  }
  try {
    const moved = await readFile(aside, 'utf-8').catch(() => undefined);
    if (moved !== undefined && moved !== staleContent) {
      await link(aside, path).catch(() => undefined);
    }
  } finally {
    await rm(aside, { force: true });
  }
}

interface LockOwner {
  pid: number;
  at: number;
}

function parseLockOwner(raw: string): LockOwner | undefined {
  try {
    const parsed = JSON.parse(raw) as Partial<LockOwner>;
    return typeof parsed.pid === 'number' && typeof parsed.at === 'number'
      ? { pid: parsed.pid, at: parsed.at }
      : undefined;
  } catch {
    return undefined;
  }
}

async function lockIsStale(path: string, raw: string, staleMs: number): Promise<boolean> {
  const owner = parseLockOwner(raw);
  if (owner) return !isProcessRunning(owner.pid) || Date.now() - owner.at > staleMs;
  try {
    return Date.now() - (await stat(path)).mtimeMs > OWNERLESS_LOCK_STALE_MS;
  } catch {
    return false;
  }
}

export interface RuntimeStartLockOptions<T> {
  /** Called every time the lock is found held. A result other than undefined ends the wait and is returned instead of running the task. */
  whileWaiting?: () => Promise<T | undefined>;
  timeoutMs?: number;
  staleMs?: number;
  retryMs?: number;
}

/**
 * Run `task` as the only caller that is starting the runtime of `serverName`. Callers that find the
 * lock held wait for it (or for `whileWaiting` to produce the answer). Nothing but this function
 * creates or removes the lock, and it is released only while it still names this call, so cleaning
 * up a runtime's other files never frees it. A lock whose holder died is taken over at once.
 */
export async function withRuntimeStartLock<T>(
  serverName: string,
  task: () => Promise<T>,
  options: RuntimeStartLockOptions<T> = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? START_LOCK_TIMEOUT_MS;
  const staleMs = options.staleMs ?? START_LOCK_STALE_MS;
  const retryMs = options.retryMs ?? START_LOCK_RETRY_MS;
  await ensureRuntimeDir();
  const lockPath = getRuntimeLockPath(serverName);
  const content = JSON.stringify({ pid: process.pid, at: Date.now(), nonce: randomBytes(8).toString('hex') });
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    if (await createFileExclusive(lockPath, content)) break;

    let held: string | undefined;
    try {
      held = await readFile(lockPath, 'utf-8');
    } catch (error) {
      // The holder released between our failed create and this read: take it at once.
      if (hasCode(error, 'ENOENT')) continue;
    }
    if (held !== undefined) {
      if (await lockIsStale(lockPath, held, staleMs)) {
        await removeStaleFile(lockPath, held);
        continue;
      }
      const answer = await options.whileWaiting?.();
      if (answer !== undefined) return answer;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for another mcpkit process to start the runtime for "${serverName}".`);
    }
    await sleep(retryMs);
  }

  try {
    return await task();
  } finally {
    if ((await readFile(lockPath, 'utf-8').catch(() => undefined)) === content) {
      await rm(lockPath, { force: true });
    }
  }
}
