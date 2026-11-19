import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, readlink, rename, rm, rmdir, stat, utimes, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export interface FileLockOptions {
  /** Pause between attempts to take a held lock. */
  retryMs?: number;
  /** Give up (and throw) after waiting this long. */
  timeoutMs?: number;
  /**
   * A lock whose directory has not been touched for this long belongs to a process that died
   * and is broken. A live holder touches its lock every `staleMs / HEARTBEATS_PER_STALE_PERIOD`
   * while it works, so a lock is never stale while its holder is alive, however long the task takes.
   */
  staleMs?: number;
}

/**
 * Defaults for every lock. The critical sections guarded here (read a small file, rewrite it) take
 * milliseconds, and a live holder refreshes its lock every second (`staleMs` / 5), so a lock that is
 * five seconds old can only be one a crashed process left behind. `staleMs` stays at half of
 * `timeoutMs`: a writer that arrives just after a crash gets the lock once the leftover turns stale,
 * at most `staleMs` later and well inside its own timeout. (With a 30 s threshold and a 10 s timeout,
 * one crashed writer made every write fail for half a minute.)
 */
const DEFAULT_LOCK_OPTIONS: Required<FileLockOptions> = {
  retryMs: 50,
  timeoutMs: 10_000,
  staleMs: 5_000,
};

/** How many times a live holder refreshes its lock within one stale period: tolerates event-loop stalls of most of it. */
const HEARTBEATS_PER_STALE_PERIOD = 5;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Whether `path` has not been touched for `ms`. A path that does not exist (any more) makes the caller retry. */
async function untouchedFor(path: string, ms: number): Promise<boolean> {
  return Date.now() - (await stat(path)).mtimeMs >= ms;
}

/**
 * Remove a lock whose holder is gone. Returns true when the caller should retry taking the lock at
 * once (it was broken, or vanished by itself) and false when it should wait.
 *
 * Breaking is serialised by a second lock, `<lock>.break`, and the staleness is checked again once
 * that is held. Without it, many waiters that see the same stale lock at once race: one removes it
 * and takes a new lock, then another, which decided "stale" a moment earlier, removes that new lock
 * too and two writers are inside at the same time. With it, only one breaker at a time decides, and
 * a lock that was just taken is fresh, so no later breaker touches it. A break lock left by a
 * crash in the middle of breaking goes stale like any other; breaking *that* one is best effort.
 */
async function breakStaleLock(lockPath: string, staleMs: number): Promise<boolean> {
  const breakPath = `${lockPath}.break`;
  try {
    if (!(await untouchedFor(lockPath, staleMs))) return false;

    try {
      await mkdir(breakPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      if (await untouchedFor(breakPath, staleMs)) await rmdir(breakPath);
      return false;
    }

    try {
      if (await untouchedFor(lockPath, staleMs)) await rmdir(lockPath);
      return true;
    } finally {
      await rmdir(breakPath).catch(() => {});
    }
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

/**
 * Run `task` while holding a cross-process lock. The lock is a directory
 * created with `mkdir`, which is atomic on every platform and file system we
 * care about; it is removed when the task settles.
 */
export async function withFileLock<T>(
  lockPath: string,
  task: () => Promise<T>,
  options: FileLockOptions = {},
): Promise<T> {
  const { retryMs, timeoutMs, staleMs } = { ...DEFAULT_LOCK_OPTIONS, ...options };
  await mkdir(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    try {
      await mkdir(lockPath);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      if (await breakStaleLock(lockPath, staleMs)) continue;
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for the lock ${lockPath}, held by another mcpkit process. `
          + `If none is running, remove the lock with: rmdir "${lockPath}"`,
        );
      }
      await sleep(retryMs);
    }
  }

  // Touch the lock while the task runs: only a holder that is gone stops, and so only its lock goes stale.
  const heartbeat = setInterval(() => {
    const now = new Date();
    utimes(lockPath, now, now).catch(() => {});
  }, Math.max(1, Math.floor(staleMs / HEARTBEATS_PER_STALE_PERIOD)));
  heartbeat.unref();

  try {
    return await task();
  } finally {
    clearInterval(heartbeat);
    await rmdir(lockPath).catch(() => {});
  }
}

export interface WriteFileAtomicOptions {
  /** Permissions for the file, replacing those of the file it overwrites. */
  mode?: number;
  /**
   * Permissions for a file that does not exist yet. A file that exists keeps its own,
   * as a plain overwrite would; `mode` takes precedence over both.
   */
  newFileMode?: number;
}

const MAX_SYMLINK_HOPS = 40;

function hasErrorCode(err: unknown, code: string): boolean {
  return (err as NodeJS.ErrnoException).code === code;
}

/**
 * The file a write to `filePath` has to replace: the path itself, or where a chain of
 * symlinks, a dangling one included, ends. Renaming a temp file over a link would swap the
 * link for a regular file and cut the real file off from every later update.
 */
async function resolveWriteTarget(filePath: string): Promise<string> {
  let current = filePath;
  for (let hops = 0; hops <= MAX_SYMLINK_HOPS; hops++) {
    try {
      if (!(await lstat(current)).isSymbolicLink()) return current;
    } catch (err) {
      if (hasErrorCode(err, 'ENOENT')) return current;
      throw err;
    }
    current = resolve(dirname(current), await readlink(current));
  }
  throw Object.assign(new Error(`ELOOP: too many levels of symbolic links, ${filePath}`), { code: 'ELOOP' });
}

/** Permission bits of `path`, or undefined when it does not exist. */
async function existingMode(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).mode & 0o777;
  } catch (err) {
    if (hasErrorCode(err, 'ENOENT')) return undefined;
    throw err;
  }
}

/** New content written to a temp file beside its target, ready to replace it. */
export interface StagedFile {
  /** Replace the target with the staged content (the fallbacks of `writeFileAtomic` apply). The temp file is gone afterwards, also when this throws. */
  commit(): Promise<void>;
  /** Remove the temp file without touching the target. Harmless after `commit`. */
  discard(): Promise<void>;
}

/**
 * The first half of `writeFileAtomic`: write `data` to a sibling temp file and stop. Nothing at
 * `filePath` changes until `commit()`, so several files can be staged first (which fails early
 * when a directory is unwritable or the disk is full) and committed together. A failure while
 * staging removes the temp file and throws.
 */
export async function stageFileAtomic(
  filePath: string,
  data: string,
  options: WriteFileAtomicOptions = {},
): Promise<StagedFile> {
  const target = await resolveWriteTarget(filePath);
  const mode = options.mode ?? await existingMode(target) ?? options.newFileMode;
  const tmpPath = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    const handle = await open(tmpPath, 'wx', mode);
    try {
      await handle.writeFile(data, 'utf-8');
      // The creation mode is cut by the umask, which may only narrow it; this makes it exact.
      if (mode !== undefined) await handle.chmod(mode);
    } finally {
      await handle.close();
    }
  } catch (err) {
    await rm(tmpPath, { force: true });
    throw err;
  }

  return {
    async commit() {
      try {
        try {
          await rename(tmpPath, target);
        } catch (err) {
          if (!hasErrorCode(err, 'EXDEV') && !hasErrorCode(err, 'EBUSY')) throw err;
          await writeFile(target, data, 'utf-8');
          if (options.mode !== undefined) await chmod(target, options.mode);
          await rm(tmpPath, { force: true });
        }
      } catch (err) {
        await rm(tmpPath, { force: true });
        throw err;
      }
    },
    discard: () => rm(tmpPath, { force: true }),
  };
}

/**
 * Write a file so readers never see a partial one: write a sibling temp file, then rename it
 * over the target. A symlinked target is written through, so the link stays and the file it
 * points to receives the update. The temp file is created with the permissions the target will
 * end up with (see `WriteFileAtomicOptions`), so a secret never exists with wider ones.
 *
 * Where the target cannot be replaced by a rename (a bind-mounted file, a different file system)
 * the content, already complete in the temp file, is written to the target in place instead:
 * not atomic, but the same as a plain overwrite. Any other failure leaves the target as it was
 * and removes the temp file.
 */
export async function writeFileAtomic(
  filePath: string,
  data: string,
  options: WriteFileAtomicOptions = {},
): Promise<void> {
  await (await stageFileAtomic(filePath, data, options)).commit();
}

/** The error for a state file that cannot be trusted, naming it and saying that nothing was changed. */
export function stateFileError(filePath: string, reason: string): Error {
  return new Error(`Cannot read ${filePath}: ${reason}. Nothing was written. Fix or remove ${filePath} and try again.`);
}

/**
 * The text of a state file (the registry, the credentials), or undefined when there is none yet
 * or it holds only whitespace. A file that exists but cannot be read throws `stateFileError`:
 * callers read these files to update them, and treating an unreadable one as empty would let
 * their next write erase whatever it holds.
 */
export async function readStateFile(filePath: string): Promise<string | undefined> {
  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch (err) {
    if (hasErrorCode(err, 'ENOENT')) return undefined;
    throw stateFileError(filePath, err instanceof Error ? err.message : String(err));
  }
  return content.trim() === '' ? undefined : content;
}
